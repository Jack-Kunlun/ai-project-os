#!/usr/bin/env python3
"""Offline guards for the two explicitly authorized retired containers."""
import copy
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import types
import unittest
from unittest.mock import Mock, patch

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('image_test_helpers', ROOT / 'test/production-image-maintenance.py')
H = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(H)
D = H.DEPLOYER
IDS = list(D.RETIRED_CONTAINER_SCOPE)
NOW = 1750000000
HASH = '9' * 64
OTHER = 'f' * 64


def detail(identifier):
    service, image = D.RETIRED_CONTAINER_SCOPE[identifier]
    return [identifier, image, '/ai-project-os-' + service + '-1', 'exited',
            False, False, False, False, 0, False, '2020-01-01T00:00:00Z',
            '2020-01-01T00:01:00Z', 'ai-project-os', service, '0.8.0-dev.4',
            D._RETIRED_COMMANDS[service], ['docker-entrypoint.sh'], 'no', [],
            None, None, 'ai-project-os_default', '', 'private', None, False,
            'node', False, '/app']


def image_records():
    return {image: {'id': image, 'present': True, 'ownership': 'confirmed',
                    'version': '0.8.0-dev.4', 'service': service,
                    'containerReferences': [{'id': identifier, 'status': 'exited'}]}
            for identifier, (service, image) in D.RETIRED_CONTAINER_SCOPE.items()}


def changes():
    return {'count': 2, 'unexpectedCount': 0, 'sha256': HASH, 'unexpectedSha256': D.sha256(b'[]')}


def state(removed=()):
    details = {identifier: detail(identifier) for identifier in IDS if identifier not in removed}
    inventory = [{'id': identifier, 'image': value[1], 'status': value[3],
                  'fingerprint': D.sha256(D._cache_json_bytes(value))}
                 for identifier, value in sorted(details.items())]
    inventory.append({'id': OTHER, 'image': H.CURRENT_IMAGE_ID, 'status': 'running', 'fingerprint': HASH})
    base = H.base_protection()
    base['containers'] = [{key: item[key] for key in ('id', 'image')} for item in inventory]
    base['dockerRoot'] = '/var/lib/docker'
    snapshot = {'allImageIds': sorted([H.CURRENT_IMAGE_ID, H.PREVIOUS_IMAGE_ID]
                                      + [value[1] for value in D.RETIRED_CONTAINER_SCOPE.values()]),
                'containers': [{key: item[key] for key in ('id', 'image', 'status')} for item in inventory]}
    with patch.object(D, '_retired_diff', return_value=changes()):
        records = [D._retired_record(identifier, details, image_records(), {H.CURRENT_IMAGE_ID, H.PREVIOUS_IMAGE_ID}, NOW)
                   for identifier in IDS]
    return ({'tag': H.TAG, 'revision': H.REVISION}, {'toolingRevision': H.TOOLING_REVISION}, base, snapshot, inventory, records)


def plan():
    _source, installed, base, snapshot, inventory, records = state()
    value = {'schema': 1, 'operation': 'retired-container-clean', 'tag': H.TAG,
             'revision': H.REVISION, 'toolingRevision': installed['toolingRevision'],
             'createdAt': NOW - 1, 'expiresAt': NOW + 899, 'scopeIds': IDS,
             'records': records, 'protection': D._retired_protection(base, snapshot, inventory)}
    data = D._cache_json_bytes(value)
    return value, data, D.sha256(data)


class RetiredContainerTests(unittest.TestCase):
    def test_scope_is_exactly_the_two_previous_report_references(self):
        fixture = json.loads((ROOT / 'test/fixtures/production-historical-image-references.json').read_text())
        expected = {item['id'] for item in fixture if item['service'] in ('reconcile', 'migrate')}
        self.assertEqual(len(IDS), 2)
        self.assertEqual({image for _service, image in D.RETIRED_CONTAINER_SCOPE.values()}, expected)

    def test_both_exact_historical_one_shot_commands_are_eligible(self):
        for item in state()[-1]:
            self.assertTrue(item['eligible'], item)
            self.assertEqual(item['retainReasons'], [])

    def test_identity_commands_state_mounts_and_restart_changes_retain(self):
        mutations = [(1, H.CURRENT_IMAGE_ID), (2, '/foreign'), (4, True), (5, True),
                     (6, True), (7, True), (8, 1), (9, True), (12, 'foreign'),
                     (13, 'app'), (14, '1.0.9'), (15, ['node', 'server.js']),
                     (16, ['foreign-entrypoint']), (17, 'always'),
                     (18, [{'Type': 'volume', 'Name': 'business-data'}]),
                     (19, ['foreign:alias']), (20, ['other:ro']),
                     (21, 'container:' + OTHER), (24, ['e' * 64]), (25, True),
                     (26, 'root'), (27, True), (28, '/var/lib/data')]
        for identifier in IDS:
            for index, value in mutations:
                with self.subTest(identifier=identifier, index=index):
                    details = {identifier: detail(identifier)}
                    details[identifier][index] = value
                    with patch.object(D, '_retired_diff', return_value=changes()):
                        record = D._retired_record(identifier, details, image_records(), set(), NOW)
                    self.assertFalse(record['eligible'])

    def test_current_and_previous_image_ids_never_authorize_container_removal(self):
        for identifier in IDS:
            with patch.object(D, '_retired_diff', return_value=changes()):
                record = D._retired_record(identifier, {identifier: detail(identifier)}, image_records(),
                                            {D.RETIRED_CONTAINER_SCOPE[identifier][1]}, NOW)
            self.assertIn('identity-unconfirmed', record['retainReasons'])

    def test_direct_dependencies_from_other_containers_are_retained(self):
        for index, ref in ((19, ['/ai-project-os-reconcile-1:/app/old']),
                           (20, [IDS[0] + ':ro']), (21, 'container:' + IDS[0]),
                           (22, 'container:' + IDS[0][:6]), (23, 'container:ai-project-os-reconcile-1')):
            details = {IDS[0]: detail(IDS[0]), OTHER: detail(IDS[1])}
            details[OTHER][0] = OTHER
            details[OTHER][index] = ref
            with patch.object(D, '_retired_diff', return_value=changes()):
                record = D._retired_record(IDS[0], details, image_records(), set(), NOW)
            self.assertEqual(record['referencedByContainerIds'], [OTHER])
            self.assertIn('referenced-by-container', record['retainReasons'])

    def test_recent_or_invalid_finish_time_is_not_reclaimable(self):
        for timestamp in ('2099-01-01T00:00:00Z', 'invalid', '2025-06-15T15:06:40Z'):
            value = detail(IDS[0]); value[11] = timestamp
            with patch.object(D, '_retired_diff', return_value=changes()):
                record = D._retired_record(IDS[0], {IDS[0]: value}, image_records(), set(), NOW)
            self.assertFalse(record['eligible'])

    def test_diff_accepts_only_runtime_cache_paths_without_returning_names(self):
        for output, count in (('C /tmp\nA /tmp/tsx-1000/cache', 0),
                              ('C /app\nA /app/uploads/private-fixture', 1),
                              ('D /var/lib/postgresql/data/file', 1)):
            with patch.object(D, 'docker', return_value=output):
                value = D._retired_diff(IDS[0])
            self.assertEqual(value['unexpectedCount'], count)
            self.assertNotIn('private-fixture', json.dumps(value))
        for output in ('A /tmp/../business', 'invalid', 'A relative'):
            with patch.object(D, 'docker', return_value=output), self.assertRaises(RuntimeError):
                D._retired_diff(IDS[0])

    def test_unknown_writable_paths_and_unknown_commands_are_redacted_and_retained(self):
        raw = detail(IDS[0]); raw[15] = ['secret-fixture-command']
        diff = changes(); diff['unexpectedCount'] = 1
        with patch.object(D, '_retired_diff', return_value=diff):
            record = D._retired_record(IDS[0], {IDS[0]: raw}, image_records(), set(), NOW)
        self.assertFalse(record['eligible'])
        self.assertNotIn('secret-fixture-command', json.dumps(record))
        self.assertIn('writable-business-path-unconfirmed', record['retainReasons'])

    def test_prisma_tool_policy_matches_the_observed_unexpected_diff_hash(self):
        self.assertEqual(len(D._RETIRED_MIGRATE_TOOL_DIFF), 9)
        self.assertEqual(D.sha256(D._cache_json_bytes(list(D._RETIRED_MIGRATE_TOOL_DIFF))),
                         'bdc281930ce215fb7c80d334448899a2d1a42c809b94a0e10112b55e18d2f6a7')
        self.assertEqual(D._RETIRED_MIGRATE_DIFF_SHA256,
                         'b790780259e0b451726fc79834aabcf299222b170e6cfd300f93cb0283bde33d')

    def test_prisma_tool_exception_requires_exact_job_paths_operations_count_and_full_hash(self):
        lines = sorted(list(D._RETIRED_MIGRATE_TOOL_DIFF)
                       + ['A /tmp/prisma-fixture-' + str(index) for index in range(18)])
        digest = D.sha256(D._cache_json_bytes(lines))
        with patch.object(D, '_RETIRED_MIGRATE_DIFF_SHA256', digest):
            for identifier, candidate, expected in (
                    (IDS[1], lines, 0),
                    (IDS[0], lines, 9),
                    (IDS[1], lines + ['A /app/uploads/private-fixture'], 10),
                    (IDS[1], lines[:-1], 8),
                    (IDS[1], [line.replace('schema-engine-debian-openssl-3.0.x', 'business-data')
                              for line in lines], 9),
                    (IDS[1], [line.replace('A /home/node/.config/prisma-nodejs/commands.json',
                                          'D /home/node/.config/prisma-nodejs/commands.json')
                              for line in lines], 9),
                    (IDS[1], [line.replace('/tmp/prisma-fixture-0', '/tmp/changed')
                              for line in lines], 9)):
                with patch.object(D, 'docker', return_value='\n'.join(candidate)):
                    self.assertEqual(D._retired_diff(identifier)['unexpectedCount'], expected)
        # The real observed digest, not merely the known nine paths, is required.
        with patch.object(D, 'docker', return_value='\n'.join(lines)):
            self.assertEqual(D._retired_diff(IDS[1])['unexpectedCount'], 9)

    def test_inspection_template_omits_env_logs_and_full_config(self):
        for forbidden in ('.Config.Env', '.LogPath', '.State.Error', '{{json .}}', '.Config}}'):
            self.assertNotIn(forbidden, D._RETIRED_TEMPLATE)
        rows = '\n'.join(json.dumps(detail(identifier)) for identifier in IDS)
        containers = [{'id': identifier} for identifier in IDS]
        with patch.object(D, 'docker', return_value=rows):
            self.assertEqual(set(D._retired_details(containers)), set(IDS))
        with patch.object(D, 'docker', return_value=json.dumps(detail(IDS[0]))), self.assertRaises(RuntimeError):
            D._retired_details(containers)

    def test_nil_mount_slice_is_empty_and_other_shapes_are_rejected(self):
        raw = detail(IDS[0]); raw[18] = None
        with patch.object(D, 'docker', return_value=json.dumps(raw)):
            self.assertEqual(D._retired_details([{'id': IDS[0]}])[IDS[0]][18], [])
        for invalid in ({}, 'unknown', 0):
            raw[18] = invalid
            with patch.object(D, 'docker', return_value=json.dumps(raw)), self.assertRaises(RuntimeError):
                D._retired_details([{'id': IDS[0]}])

    def test_mount_order_and_live_exec_sessions_do_not_mask_mount_content_changes(self):
        raw = detail(IDS[0]); raw[0] = OTHER
        raw[18] = [{'Type': 'bind', 'Source': '/fixture/a', 'Destination': '/data/a'},
                   {'Type': 'volume', 'Name': 'fixture-b', 'Destination': '/data/b'}]
        raw[24] = ['e' * 64]
        active = json.dumps(raw); raw[24] = []
        with patch.object(D, 'docker', side_effect=[active, json.dumps(raw)]), \
             patch.object(D.time, 'sleep') as sleep:
            before = D._retired_details([{'id': OTHER}])
        sleep.assert_called_once_with(2)
        self.assertIsNone(before[OTHER][24])
        raw[18].reverse(); raw[24] = None
        with patch.object(D, 'docker', return_value=json.dumps(raw)):
            self.assertEqual(D._retired_details([{'id': OTHER}]), before)
        raw[18][0]['Name'] = 'changed-business-volume'
        with patch.object(D, 'docker', return_value=json.dumps(raw)):
            self.assertNotEqual(D._retired_details([{'id': OTHER}]), before)
        raw[18] = before[OTHER][18] + [before[OTHER][18][0]]
        with patch.object(D, 'docker', return_value=json.dumps(raw)):
            self.assertNotEqual(D._retired_details([{'id': OTHER}]), before)

    def test_target_exec_sessions_still_retain_and_invalid_session_shapes_fail(self):
        for identifier in IDS:
            raw = detail(identifier); raw[24] = ['e' * 64]
            with patch.object(D, 'docker', return_value=json.dumps(raw)):
                details = D._retired_details([{'id': identifier}])
            self.assertEqual(details[identifier][24], ['e' * 64])
            with patch.object(D, '_retired_diff', return_value=changes()):
                record = D._retired_record(identifier, details, image_records(), set(), NOW)
            self.assertFalse(record['eligible'])
            self.assertIn('not-completed-successfully', record['retainReasons'])
        for invalid in ('unknown', ['not-an-id'], ['e' * 64] * 129):
            raw = detail(IDS[0]); raw[0] = OTHER; raw[24] = invalid
            with patch.object(D, 'docker', return_value=json.dumps(raw)), self.assertRaises(RuntimeError):
                D._retired_details([{'id': OTHER}])
        raw = detail(IDS[0]); raw[0] = OTHER; raw[24] = ['e' * 64]
        with patch.object(D, 'docker', return_value=json.dumps(raw)) as inspect, \
             patch.object(D.time, 'sleep') as sleep, \
             patch.object(D, 'atomic_install') as install, \
             patch.object(D, '_retired_remove_id') as remove, \
             self.assertRaisesRegex(RuntimeError, 'RETIRED_LIVE_EXEC_ACTIVE'):
            D._retired_details([{'id': OTHER}])
        self.assertEqual(inspect.call_count, 4)
        self.assertEqual(sleep.call_count, 3)
        install.assert_not_called()
        remove.assert_not_called()

    def test_plan_binds_digest_source_tooling_scope_and_lifetime(self):
        value, data, digest = plan()
        with patch.object(D.time, 'time', return_value=NOW):
            self.assertEqual(D._retired_validate_plan(data, digest, H.TAG, H.REVISION, H.TOOLING_REVISION), value)
            for field, replacement in (('tag', 'v1.0.8'), ('revision', 'e' * 40),
                                       ('toolingRevision', 'f' * 40), ('scopeIds', [OTHER]),
                                       ('expiresAt', NOW), ('createdAt', NOW + 1)):
                changed = copy.deepcopy(value); changed[field] = replacement
                raw = D._cache_json_bytes(changed)
                with self.assertRaises(RuntimeError):
                    D._retired_validate_plan(raw, D.sha256(raw), H.TAG, H.REVISION, H.TOOLING_REVISION)
            with self.assertRaises(RuntimeError):
                D._retired_validate_plan(data, '0' * 64, H.TAG, H.REVISION, H.TOOLING_REVISION)

    def test_only_exact_removed_containers_can_disappear_from_protection(self):
        value = plan()[0]
        after = state({IDS[0]})
        self.assertTrue(D._retired_matches(value, *after[2:], {IDS[0]}))
        for key in ('volumes', 'currentImageIds', 'previousImageIds', 'configHashes', 'postgresId', 'migrationCount'):
            changed = copy.deepcopy(after[2]); changed[key] = None
            self.assertFalse(D._retired_matches(value, changed, *after[3:], {IDS[0]}))
        changed_inventory = copy.deepcopy(after[4]); changed_inventory[-1]['status'] = 'exited'
        self.assertFalse(D._retired_matches(value, after[2], after[3], changed_inventory, after[5], {IDS[0]}))

    def test_remove_uses_full_id_without_force_volume_prune_or_name_fallback(self):
        with patch.object(D, 'HELPER', types.SimpleNamespace(trusted=Mock())), \
             patch.dict(D.BINARIES, {'docker': sys.executable}), \
             patch.object(D.subprocess, 'run', return_value=types.SimpleNamespace(returncode=0)) as run:
            self.assertEqual(D._retired_remove_id(IDS[0], 60), 'command-succeeded')
        self.assertEqual(run.call_args.args[0], [sys.executable, 'container', 'rm', IDS[0]])
        with self.assertRaises(RuntimeError):
            D._retired_remove_id(OTHER, 60)

    def test_drift_receipt_identifies_only_components_fields_and_hashes(self):
        value = plan()[0]
        before = value['protection']['containers'][-1]
        before['fieldFingerprints'] = [HASH] * len(D._RETIRED_FIELDS)
        after = state()
        after[2]['ownedImages'] = [{'private': 'secret-fixture'}]
        after[4][-1]['fieldFingerprints'] = [HASH] * len(D._RETIRED_FIELDS)
        after[4][-1]['fieldFingerprints'][24] = '8' * 64
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.assertFalse(D._retired_matches(value, *after[2:], set()))
        text = output.getvalue()
        receipt = json.loads(text.removeprefix('RETIRED_CONTAINER_DRIFT '))
        self.assertEqual(receipt['baseDifferences'][0]['field'], 'ownedImages')
        self.assertEqual(receipt['containerDifferences'][0]['fields'][0]['field'], '.ExecIDs')
        self.assertNotIn('secret-fixture', text)
        self.assertEqual(receipt['expectedAllImageIdsSha256'], receipt['actualAllImageIdsSha256'])
        self.assertTrue(all(len(item['expectedSha256']) == len(item['actualSha256']) == 64
                            for item in receipt['baseDifferences']))
        with patch.object(D, '_image_public_protection', return_value={}):
            public = D._retired_public_protection(after[2], after[3], after[4], HASH)
        self.assertNotIn('fieldFingerprints', json.dumps(public))

    def test_read_only_inspection_refuses_unstable_snapshot_before_installing_plan(self):
        first, second = state(), state()
        second[2]['ownedImages'] = [{'private': 'secret-fixture'}]
        output = io.StringIO()
        with patch.object(D, '_retired_runtime', side_effect=[first, second]), \
             patch.object(D, 'atomic_install') as install, \
             patch.object(D, '_retired_remove_id') as remove, \
             contextlib.redirect_stdout(output), \
             self.assertRaisesRegex(RuntimeError, 'RETIRED_INSPECTION_UNSTABLE'):
            D.retired_container_inspect(H.TAG, H.REVISION)
        install.assert_not_called()
        remove.assert_not_called()
        self.assertIn('RETIRED_CONTAINER_DRIFT ', output.getvalue())
        self.assertNotIn('secret-fixture', output.getvalue())

    def run_clean(self, refuse=False, drift=False, expire=False):
        _value, data, digest = plan()
        removed = set()
        reports = []
        calls = []
        deadline_checks = 0
        original_remaining = D._cache_plan_remaining
        def remaining(value, deadline=None):
            nonlocal deadline_checks
            if deadline is not None:
                deadline_checks += 1
                if expire and deadline_checks >= 3:
                    raise RuntimeError('STABLE_CACHE_PLAN_EXPIRED_OR_INVALID')
            return original_remaining(value, deadline)
        def runtime(*_args):
            result = state(removed)
            if drift and calls:
                result[4][-1]['status'] = 'exited'
            return result
        def remove(identifier, _timeout):
            calls.append(identifier)
            if refuse:
                return 'engine-refused'
            removed.add(identifier)
            return 'command-succeeded'
        with patch.object(D, '_cache_installed_tooling', return_value={'toolingRevision': H.TOOLING_REVISION}), \
             patch.object(D, '_read_trusted_host_file', autospec=True, return_value=data) as read_plan, \
             patch.object(D.time, 'time', return_value=NOW), \
             patch.object(D, '_cache_plan_remaining', side_effect=remaining), \
             patch.object(D, '_retired_runtime', side_effect=runtime), \
             patch.object(D, '_retired_remove_id', side_effect=remove), \
             patch.object(D, '_image_available_bytes', side_effect=[1000, 1200]), \
             patch.object(D, '_retired_emit', side_effect=reports.append):
            if drift or expire:
                with self.assertRaisesRegex(RuntimeError, 'RETIRED_PROTECTION|CACHE_PLAN_EXPIRED'):
                    D.retired_container_clean(H.TAG, H.REVISION, digest)
            else:
                D.retired_container_clean(H.TAG, H.REVISION, digest)
        read_plan.assert_called_once_with(D.RETIRED_CONTAINER_PLAN, 0o600, 1024 * 1024,
                                          'RETIRED_PLAN_FILE_INVALID')
        return reports[-1], calls

    def test_clean_actual_ids_and_preserved_image_and_volume_snapshot(self):
        report, calls = self.run_clean()
        self.assertEqual(calls, IDS)
        self.assertEqual(report['removedIds'], IDS)
        self.assertEqual(report['netAvailableBytesDelta'], 200)
        self.assertTrue(report['protectionVerified'])
        self.assertTrue(all(report['checks'].values()))
        self.assertEqual(report['protection']['containerCount'], 1)
        self.assertEqual(report['protection']['allImageIds'], state()[3]['allImageIds'])

    def test_refusal_retains_and_never_force_retries(self):
        report, calls = self.run_clean(refuse=True)
        self.assertEqual(calls, IDS)
        self.assertEqual(report['removedIds'], [])
        self.assertEqual(report['retainedIds'], IDS)
        self.assertEqual(len(report['engineRefused']), 2)

    def test_drift_after_first_delete_stops_second_delete(self):
        report, calls = self.run_clean(drift=True)
        self.assertEqual(calls, [IDS[0]])
        self.assertFalse(report['protectionVerified'])

    def test_expired_plan_between_containers_never_attempts_second_delete(self):
        report, calls = self.run_clean(expire=True)
        self.assertEqual(calls, [IDS[0]])
        self.assertFalse(report['protectionVerified'])

    def test_engine_timeout_has_no_force_fallback(self):
        with patch.object(D, 'HELPER', types.SimpleNamespace(trusted=Mock())), \
             patch.dict(D.BINARIES, {'docker': sys.executable}), \
             patch.object(D.subprocess, 'run', side_effect=subprocess.TimeoutExpired('docker', 60)) as run:
            self.assertEqual(D._retired_remove_id(IDS[0], 60), 'timeout')
        self.assertEqual(run.call_count, 1)

    def test_gateway_and_root_dispatch_are_fixed_and_maintenance_only(self):
        gateway = (ROOT / 'deploy/production/ai-project-os-actions-gateway').read_text()
        self.assertIn('^inspect-retired-containers\\ ', gateway)
        self.assertIn('^clean-retired-containers\\ ', gateway)
        source = (ROOT / 'deploy/production/ai-project-os-release-stable.py').read_text()
        self.assertIn("if command in ('retired-container-inspect', 'retired-container-clean'):", source)
        self.assertIn('CONFIRM_RETIRED_CONTAINER_INSPECT', gateway)


if __name__ == '__main__':
    unittest.main()
