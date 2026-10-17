#!/usr/bin/env python3
"""Offline fail-closed tests for stable production cache maintenance."""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location(
    'stable_cache_maintenance_under_test',
    ROOT / 'deploy/production/ai-project-os-release-stable.py',
)
DEPLOYER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DEPLOYER)

TAG = 'v1.0.9'
REVISION = 'a' * 40
TOOLING_REVISION = 'b' * 40


def cache_record(identifier, *, size=100, shared=False, reclaimable=True,
                 mutable=False, cache_type='regular'):
    return {
        'ID': identifier, 'Type': cache_type, 'Size': size,
        'Shared': shared, 'Reclaimable': reclaimable, 'Mutable': mutable,
        'Description': 'private test material must not escape into report',
    }


def cache_output(*records):
    return '\n'.join(json.dumps(item, separators=(',', ':')) for item in records)


def selected(identifier, *, size=100, shared=False):
    return {
        'id': identifier, 'type': 'regular', 'sizeBytes': size,
        'estimated': False, 'shared': shared, 'reclaimable': True,
        'mutable': False, 'eligible': True,
        'bucket': 'sharedReclaimable' if shared else 'privateReclaimable',
    }


def protection_snapshot():
    return {
        'containers': [], 'volumes': [], 'ownedImages': [], 'unverifiedImages': [],
        'ownedImageIds': ['sha256:' + '1' * 64],
        'currentImageIds': ['sha256:' + '2' * 64],
        'currentReceiptImageIds': ['sha256:' + '2' * 64],
        'previousImageIds': ['sha256:' + '3' * 64],
        'previousTag': 'v1.0.8', 'previousRevision': 'c' * 40,
        'postgresId': 'd' * 64, 'migrationCount': 146,
        'migrationManifestSha256': 'e' * 64, 'configHashes': {},
        'checkoutRevision': REVISION, 'deploymentReceiptSha256': 'f' * 64,
        'dockerRoot': '/docker-root',
    }


class CacheRecordTests(unittest.TestCase):
    def test_four_buckets_si_estimates_and_summary_are_explicit(self):
        output = cache_output(
            cache_record('private_ok', size=120),
            cache_record('private_protected', size='2MB', reclaimable=False),
            cache_record('shared_ok', size='1.5kB', shared=True),
            cache_record('shared_mutable', size=70, shared=True, mutable=True),
            cache_record('shared_protected', size=75, shared=True,
                         reclaimable=False, mutable=True),
        )
        records = DEPLOYER.parse_cache_records(output)
        self.assertEqual({item['id']: item['bucket'] for item in records}, {
            'private_ok': 'privateReclaimable',
            'private_protected': 'privateProtected',
            'shared_ok': 'sharedReclaimable',
            'shared_mutable': 'sharedReclaimable',
            'shared_protected': 'sharedProtected',
        })
        summary = DEPLOYER.cache_summary(records)
        self.assertEqual(summary['sumRecordBytes'], 2_001_765)
        self.assertTrue(summary['estimated'])
        self.assertEqual(summary['privateReclaimableBytes'], 120)
        self.assertEqual(summary['privateProtectedBytes'], 2_000_000)
        self.assertEqual(summary['sharedReclaimableBytes'], 1_570)
        self.assertEqual(summary['sharedProtectedBytes'], 75)
        self.assertEqual(summary['sharedReclaimableCount'], 2)
        self.assertNotIn('Description', records[0])

    def test_raw_and_si_sizes_and_invalid_inputs(self):
        self.assertEqual(DEPLOYER._cache_size_bytes(123), (123, False))
        self.assertEqual(DEPLOYER._cache_size_bytes('1.25GB'), (1_250_000_000, True))
        for invalid in (-1, True, '1.2', '1 GiB', 'NaNB', '9223372036854775808B'):
            with self.subTest(invalid=invalid), self.assertRaises(RuntimeError):
                DEPLOYER._cache_size_bytes(invalid)

    def test_duplicate_ids_keys_invalid_types_flags_and_hostile_ids_fail_closed(self):
        duplicate_id = cache_output(cache_record('same'), cache_record('same'))
        with self.assertRaisesRegex(RuntimeError, 'CACHE_USAGE_ID_INVALID'):
            DEPLOYER.parse_cache_records(duplicate_id)
        duplicate_key = '{"ID":"one","ID":"two","Type":"regular","Size":1,"Shared":false,"Reclaimable":true,"Mutable":false}'
        with self.assertRaisesRegex(RuntimeError, 'CACHE_USAGE_DUPLICATE_KEY'):
            DEPLOYER.parse_cache_records(duplicate_key)
        for record in (
            cache_record('bad_type', cache_type='unknown'),
            {**cache_record('bad_flag'), 'Mutable': 'false'},
            cache_record('injection)|.*'),
            cache_record('bad.size'),
        ):
            with self.subTest(record=record['ID']), self.assertRaises(RuntimeError):
                DEPLOYER.parse_cache_records(json.dumps(record))

    def test_reclaimable_mutable_and_internal_records_remain_candidates(self):
        records = DEPLOYER.parse_cache_records(cache_output(
            cache_record('mutable_a', mutable=True),
            cache_record('internal_a', cache_type='internal'),
        ))
        by_id = {record['id']: record for record in records}
        self.assertTrue(by_id['mutable_a']['eligible'])
        self.assertTrue(by_id['internal_a']['eligible'])
        self.assertEqual(by_id['internal_a']['bucket'], 'privateReclaimable')


class CachePlanTests(unittest.TestCase):
    def valid_plan(self):
        return {
            'schema': 1, 'operation': 'cache-maintenance-plan',
            'tag': TAG, 'revision': REVISION, 'toolingRevision': TOOLING_REVISION,
            'createdAt': 100, 'expiresAt': 100 + DEPLOYER.CACHE_PLAN_TTL_SECONDS,
            'protection': {'containers': [], 'volumes': [], 'ownedImages': []},
            'inventoryIds': ['cache_a'],
            'selectedRecords': [selected('cache_a')],
            'summary': {'builder': 'default'},
        }

    def test_digest_tag_revision_tooling_and_ttl_are_bound(self):
        plan = self.valid_plan()
        encoded = DEPLOYER._cache_plan_bytes(plan)
        digest = DEPLOYER.sha256(encoded)
        parsed = DEPLOYER._cache_validate_plan(
            encoded, digest, TAG, REVISION, TOOLING_REVISION, now=101,
        )
        self.assertEqual(parsed, plan)
        cases = (
            (encoded, '0' * 64, TAG, REVISION, TOOLING_REVISION, 101),
            (encoded, digest, 'v1.0.8', REVISION, TOOLING_REVISION, 101),
            (encoded, digest, TAG, 'c' * 40, TOOLING_REVISION, 101),
            (encoded, digest, TAG, REVISION, 'c' * 40, 101),
            (encoded, digest, TAG, REVISION, TOOLING_REVISION,
             101 + DEPLOYER.CACHE_PLAN_TTL_SECONDS),
            (encoded, digest, TAG, REVISION, TOOLING_REVISION, plan['expiresAt']),
        )
        for args in cases:
            with self.subTest(args=args[1:]), self.assertRaises(RuntimeError):
                DEPLOYER._cache_validate_plan(*args[:5], now=args[5])

    def test_plan_accepts_mutable_internal_record_when_reclaimable(self):
        plan = self.valid_plan()
        plan['selectedRecords'] = [{
            **selected('cache_a'), 'type': 'internal', 'mutable': True,
        }]
        encoded = DEPLOYER._cache_plan_bytes(plan)
        parsed = DEPLOYER._cache_validate_plan(
            encoded, DEPLOYER.sha256(encoded), TAG, REVISION, TOOLING_REVISION, now=101,
        )
        self.assertTrue(parsed['selectedRecords'][0]['eligible'])

    def test_selection_skips_vanished_protected_changed_and_new_ids(self):
        frozen = [selected('cache_a'), selected('cache_b'), selected('cache_c')]
        fresh = [
            selected('cache_a'),
            {**selected('cache_b'), 'reclaimable': False, 'mutable': True, 'eligible': False,
             'bucket': 'privateProtected'},
            selected('cache_c', size=101),
            selected('new_cache'),
        ]
        result = DEPLOYER._cache_candidate_selection(
            frozen, ['cache_a', 'cache_b', 'cache_c'], fresh,
        )
        self.assertEqual(result, {
            'selected': ['cache_a'], 'vanished': [],
            'newlyProtected': ['cache_b'], 'changed': ['cache_c'],
            'newlyAppeared': ['new_cache'],
        })
        vanished = DEPLOYER._cache_candidate_selection(
            frozen, ['cache_a', 'cache_b', 'cache_c'], [],
        )
        self.assertEqual(vanished['vanished'], ['cache_a', 'cache_b', 'cache_c'])
        self.assertEqual(vanished['selected'], [])

    def test_hostile_plan_id_is_rejected_before_prune(self):
        plan = self.valid_plan()
        plan['inventoryIds'] = ['cache_a|.*']
        plan['selectedRecords'][0]['id'] = 'cache_a|.*'
        encoded = DEPLOYER._cache_plan_bytes(plan)
        with self.assertRaises(RuntimeError):
            DEPLOYER._cache_validate_plan(
                encoded, DEPLOYER.sha256(encoded), TAG, REVISION,
                TOOLING_REVISION, now=101,
            )

    def test_malformed_plan_inventory_types_fail_closed_without_type_errors(self):
        for inventory_ids in ([['not-a-string']], [None], ['cache_a', 'cache_a']):
            plan = self.valid_plan()
            plan['inventoryIds'] = inventory_ids
            encoded = DEPLOYER._cache_plan_bytes(plan)
            with self.subTest(inventory_ids=inventory_ids), self.assertRaisesRegex(
                    RuntimeError, 'CACHE_PLAN_CONTENT_INVALID'):
                DEPLOYER._cache_validate_plan(
                    encoded, DEPLOYER.sha256(encoded), TAG, REVISION,
                    TOOLING_REVISION, now=101,
                )


class CacheCommandTests(unittest.TestCase):
    def test_protection_snapshot_binds_containers_volumes_and_current_previous_images(self):
        current_ids = ['sha256:' + str(index) * 64 for index in (1, 2, 3)]
        previous_ids = ['sha256:' + str(index) * 64 for index in (4, 5, 6)]
        legacy_ids = ['sha256:' + str(index) * 64 for index in (7, 8)]
        unverified_id = 'sha256:' + '9' * 64
        all_ids = current_ids + previous_ids + legacy_ids + [unverified_id]
        unverified_current = [False]
        container_id = 'a' * 64
        container_image = current_ids[0]
        image_template = ('{{.Id}}|{{index .Config.Labels "org.opencontainers.image.title"}}|'
                          '{{index .Config.Labels "org.opencontainers.image.source"}}|'
                          '{{index .Config.Labels "org.opencontainers.image.version"}}|'
                          '{{index .Config.Labels "org.opencontainers.image.revision"}}|'
                          '{{index .Config.Labels "com.docker.compose.project"}}|'
                          '{{index .Config.Labels "com.docker.compose.service"}}|'
                          '{{json .RepoTags}}|{{json .RepoDigests}}')

        def fake_docker(*args, **_kwargs):
            if args == ('ps', '-aq', '--no-trunc'):
                return container_id
            if args[:2] == ('inspect', '--format'):
                self.assertEqual(args[2], '{{.Id}}|{{.Image}}')
                return container_id + '|' + container_image
            if args == ('volume', 'ls', '--quiet'):
                return 'business-data'
            if args[:3] == ('volume', 'inspect', '--format'):
                return 'business-data|local|local|2026-10-17T00:00:00Z|{"owner":"ai-project-os"}|null'
            if args[:4] == ('image', 'ls', '--quiet', '--no-trunc'):
                return '\n'.join(all_ids)
            if args[:3] == ('image', 'inspect', '--format'):
                identifier = args[4]
                index = all_ids.index(identifier)
                if index < 3:
                    version, revision, image_source = '1.0.9', REVISION, DEPLOYER.IMAGE_SOURCE
                elif index < 6:
                    version, revision, image_source = '1.0.8', 'c' * 40, DEPLOYER.IMAGE_SOURCE
                else:
                    version = '1.0.9' if identifier == legacy_ids[0] else '0.7.18'
                    revision, image_source = '<no value>', '<no value>'
                project, service = (('ai-project-os', 'app') if index >= 6
                                    else ('<no value>', '<no value>'))
                if identifier == unverified_id:
                    project, service = '<no value>', '<no value>'
                if unverified_current[0] and identifier == current_ids[0]:
                    image_source = 'https://foreign.invalid/repo'
                tags = (['ai-project-os-app:' + version] if index >= 6 else
                        ['ghcr.io/jack-kunlun/ai-project-os-app:' + version])
                digests = ([] if index >= 6 else
                           ['ghcr.io/jack-kunlun/ai-project-os-app@sha256:' + 'd' * 64])
                return '|'.join((identifier, 'AI Project OS',
                                 image_source, version, revision, project, service,
                                 json.dumps(tags), json.dumps(digests)))
            if args == ('info', '--format', '{{.DockerRootDir}}'):
                return '/docker-root'
            self.fail('unexpected Docker invocation: ' + repr(args))

        source = {
            'tag': TAG, 'version': '1.0.9', 'revision': REVISION,
            'postgres_id': 'f' * 64,
            'source_manifest': [('20261017000000_test', 'a' * 64)],
            'config_hashes': {'production_env': 'b' * 64},
            'writer_images': {'app': current_ids[0], 'worker': current_ids[1],
                              'git-worker': current_ids[1]},
            'receipt': {
                'release_protocol': 'stable-v2-images',
                'target_image_ids': json.dumps({'app': current_ids[0],
                                                'worker': current_ids[1],
                                                'migrate': current_ids[2]}),
                'source_tag': 'v1.0.8', 'source_revision': 'c' * 40,
            },
        }
        with patch.object(DEPLOYER, 'docker', side_effect=fake_docker), \
                patch.object(DEPLOYER, 'HELPER') as helper, \
                patch.object(DEPLOYER, 'hash_file', return_value='f' * 64), \
                patch.object(DEPLOYER.os, 'statvfs'):
            helper.trusted.return_value = None
            snapshot = DEPLOYER._cache_protected_resource_snapshot(source)
            unverified_current[0] = True
            with self.assertRaisesRegex(RuntimeError, 'CACHE_PROTECTED_IMAGES_MISSING'):
                DEPLOYER._cache_protected_resource_snapshot(source)
        self.assertEqual(snapshot['ownedImageIds'], sorted(current_ids + previous_ids + legacy_ids))
        self.assertEqual(snapshot['unverifiedImages'][0]['id'], unverified_id)
        self.assertEqual(snapshot['unverifiedImages'][0]['reasons'], ['legacy-project', 'legacy-service'])
        self.assertRegex(snapshot['unverifiedImages'][0]['identitySha256'], r'^[a-f0-9]{64}$')
        self.assertNotIn(unverified_id, snapshot['currentImageIds'] + snapshot['previousImageIds'])
        self.assertEqual(snapshot['currentImageIds'], sorted(current_ids))
        self.assertEqual(snapshot['previousImageIds'], sorted(previous_ids))
        self.assertTrue(set(legacy_ids).issubset(snapshot['ownedImageIds']))
        self.assertTrue(set(legacy_ids).isdisjoint(snapshot['currentImageIds']))
        self.assertTrue(set(legacy_ids).isdisjoint(snapshot['previousImageIds']))
        self.assertEqual(snapshot['currentReceiptImageIds'], sorted(current_ids))
        self.assertEqual(snapshot['containers'], [{'id': container_id, 'image': container_image}])
        self.assertEqual([item['name'] for item in snapshot['volumes']], ['business-data'])
        self.assertEqual(snapshot['checkoutRevision'], REVISION)

    def test_unverified_images_are_preserved_without_claiming_release_ownership(self):
        identifier = 'sha256:' + '1' * 64
        for source, version, revision, reasons in (
            ('https://foreign.invalid/repo', '1.0.9', REVISION, ['source-unrecognized']),
            ('<no value>', '0.7.18', '', ['legacy-project', 'legacy-service']),
            (DEPLOYER.IMAGE_SOURCE, '1.0.9', 'bad', ['canonical-revision']),
        ):
            output = '|'.join((identifier, 'AI Project OS', source,
                               version, revision, '<no value>', '<no value>', '[]', '[]'))
            with self.subTest(reasons=reasons), patch.object(
                    DEPLOYER, 'docker', side_effect=[identifier, output]):
                inventory = DEPLOYER._cache_protected_image_inventory()
            self.assertEqual(inventory['ownedImages'], [])
            self.assertEqual(inventory['unverifiedImages'][0]['id'], identifier)
            self.assertEqual(inventory['unverifiedImages'][0]['reasons'], reasons)
            self.assertNotIn('foreign.invalid', json.dumps(inventory['unverifiedImages']))

    def test_prune_uses_only_default_builder_and_frozen_anchored_id_filter(self):
        with patch.object(DEPLOYER, 'docker') as docker_mock:
            DEPLOYER._cache_prune_ids(['cache_a', 'cache-b'])
        docker_mock.assert_called_once_with(
            'buildx', 'prune', '--builder', 'default', '--all', '--force',
            '--filter', 'id~=^(cache_a|cache-b)$', timeout=600,
        )
        for hostile in (['.*'], ['cache_a|.*'], ['cache_a)'], ['cache_a', 'cache_a']):
            with self.subTest(hostile=hostile), patch.object(DEPLOYER, 'docker') as docker_mock:
                with self.assertRaises(RuntimeError):
                    DEPLOYER._cache_prune_ids(hostile)
                docker_mock.assert_not_called()

    def test_prune_timeout_is_positive_and_bounded_by_plan_remaining_life(self):
        with patch.object(DEPLOYER, 'docker') as docker_mock:
            DEPLOYER._cache_prune_ids(['cache_a'], timeout_seconds=0.25)
        self.assertEqual(docker_mock.call_args.kwargs['timeout'], 0.25)
        for timeout in (0, -1, True, 601, float('inf'), float('nan')):
            with self.subTest(timeout=timeout), patch.object(DEPLOYER, 'docker') as docker_mock:
                with self.assertRaisesRegex(RuntimeError, 'CACHE_PRUNE_TIMEOUT_INVALID'):
                    DEPLOYER._cache_prune_ids(['cache_a'], timeout_seconds=timeout)
                docker_mock.assert_not_called()

    def test_running_clean_stops_before_prune_or_next_batch_when_plan_expires(self):
        # Expiry during snapshot collection, between batches, and after clock rollback.
        for expire_at in ('snapshot', 'next-batch', 'clock-rollback'):
            with self.subTest(expire_at=expire_at):
                records = [selected('cache_' + str(index).zfill(2)) for index in range(33)]
                plan = {
                    'schema': 1, 'operation': 'cache-maintenance-plan',
                    'tag': TAG, 'revision': REVISION, 'toolingRevision': TOOLING_REVISION,
                    'createdAt': 100, 'expiresAt': 100 + DEPLOYER.CACHE_PLAN_TTL_SECONDS,
                    'protection': protection_snapshot(),
                    'inventoryIds': [item['id'] for item in records],
                    'selectedRecords': records, 'summary': {},
                }
                encoded = DEPLOYER._cache_plan_bytes(plan)
                installed = {'toolingRevision': TOOLING_REVISION}
                clock = {'wall': plan['expiresAt'] - 0.5, 'monotonic': 0}
                runtime_calls = []
                prune_calls = []
                audits = []

                def runtime(*_args):
                    runtime_calls.append(True)
                    if expire_at == 'snapshot' and len(runtime_calls) == 2:
                        clock['wall'] = plan['expiresAt']
                    return ({'tag': TAG, 'revision': REVISION}, installed, plan['protection'])

                def prune(identifiers, *, timeout_seconds):
                    prune_calls.append((identifiers, timeout_seconds))
                    if expire_at == 'clock-rollback':
                        clock['wall'] = 101
                        clock['monotonic'] = 0.5
                    else:
                        clock['wall'] = plan['expiresAt']

                with patch.object(DEPLOYER, '_read_trusted_host_file', return_value=encoded), \
                        patch.object(DEPLOYER, '_cache_installed_tooling', return_value=installed), \
                        patch.object(DEPLOYER, '_cache_runtime_state', side_effect=runtime), \
                        patch.object(DEPLOYER, '_cache_read_records', return_value=records), \
                        patch.object(DEPLOYER, '_cache_available_bytes', return_value=1000), \
                        patch.object(DEPLOYER.time, 'time', side_effect=lambda: clock['wall']), \
                        patch.object(DEPLOYER.time, 'monotonic', side_effect=lambda: clock['monotonic']), \
                        patch.object(DEPLOYER, '_cache_prune_ids', side_effect=prune), \
                        patch.object(DEPLOYER, '_cache_write_audit', side_effect=audits.append), \
                        patch.object(DEPLOYER, '_cache_emit_report') as emit:
                    with self.assertRaisesRegex(RuntimeError, 'CACHE_PLAN_EXPIRED_OR_INVALID'):
                        DEPLOYER.cache_clean(TAG, REVISION, DEPLOYER.sha256(encoded))
                self.assertEqual(len(prune_calls), 0 if expire_at == 'snapshot' else 1)
                if prune_calls:
                    self.assertEqual(len(prune_calls[0][0]), 32)
                    self.assertEqual(prune_calls[0][1], 0.5)
                self.assertEqual(audits[-1]['status'], 'FAILED')
                self.assertEqual(audits[-1]['failureCode'], 'STABLE_CACHE_PLAN_EXPIRED_OR_INVALID')
                emit.assert_not_called()

    def test_clean_reports_net_filesystem_change_separately_from_cache_bytes(self):
        planned = selected('cache_a', size=8192)
        plan = {
            'schema': 1, 'operation': 'cache-maintenance-plan',
            'tag': TAG, 'revision': REVISION, 'toolingRevision': TOOLING_REVISION,
            'createdAt': 100, 'expiresAt': 100 + DEPLOYER.CACHE_PLAN_TTL_SECONDS,
            'protection': protection_snapshot(), 'inventoryIds': ['cache_a'],
            'selectedRecords': [planned], 'summary': {},
        }
        encoded = DEPLOYER._cache_plan_bytes(plan)
        installed = {'toolingRevision': TOOLING_REVISION}
        runtime = ({'tag': TAG, 'revision': REVISION}, installed, plan['protection'])
        reports = []
        prune_calls = []
        records_sequence = [[planned], [planned], [], []]
        with patch.object(DEPLOYER, '_read_trusted_host_file', return_value=encoded), \
                patch.object(DEPLOYER, '_cache_installed_tooling', return_value=installed), \
                patch.object(DEPLOYER, '_cache_validate_plan', return_value=plan), \
                patch.object(DEPLOYER, '_cache_runtime_state', return_value=runtime), \
                patch.object(DEPLOYER, '_cache_read_records', side_effect=records_sequence), \
                patch.object(DEPLOYER, '_cache_available_bytes', side_effect=[1000, 1080]), \
                patch.object(DEPLOYER, '_cache_prune_ids', side_effect=lambda batch, **_kw: prune_calls.append(batch)), \
                patch.object(DEPLOYER.time, 'time', return_value=101), \
                patch.object(DEPLOYER, '_cache_write_audit'), \
                patch.object(DEPLOYER, '_cache_emit_report', side_effect=reports.append):
            DEPLOYER.cache_clean(TAG, REVISION, 'd' * 64)
        self.assertEqual(prune_calls, [['cache_a']])
        report = reports[0]
        self.assertEqual(report['summaryBefore']['sumRecordBytes'], 8192)
        self.assertEqual(report['availableBytesBefore'], 1000)
        self.assertEqual(report['availableBytesAfter'], 1080)
        self.assertEqual(report['netAvailableBytesDelta'], 80)
        self.assertEqual(report['prunedIds'], ['cache_a'])
        self.assertEqual(report['planDigest'], 'd' * 64)
        self.assertEqual(report['protection']['planDigest'], 'd' * 64)
        self.assertTrue(all(type(value) is bool for value in report['checks'].values()))

    def test_protected_or_changed_fresh_record_is_not_pruned(self):
        planned = selected('cache_a')
        now_protected = {**planned, 'reclaimable': False, 'mutable': True, 'eligible': False,
                         'bucket': 'privateProtected'}
        plan = {
            'schema': 1, 'operation': 'cache-maintenance-plan',
            'tag': TAG, 'revision': REVISION, 'toolingRevision': TOOLING_REVISION,
            'createdAt': 100, 'expiresAt': 100 + DEPLOYER.CACHE_PLAN_TTL_SECONDS,
            'protection': protection_snapshot(), 'inventoryIds': ['cache_a'],
            'selectedRecords': [planned], 'summary': {},
        }
        encoded = DEPLOYER._cache_plan_bytes(plan)
        installed = {'toolingRevision': TOOLING_REVISION}
        runtime = ({'tag': TAG, 'revision': REVISION}, installed, plan['protection'])
        reports = []
        with patch.object(DEPLOYER, '_read_trusted_host_file', return_value=encoded), \
                patch.object(DEPLOYER, '_cache_installed_tooling', return_value=installed), \
                patch.object(DEPLOYER, '_cache_validate_plan', return_value=plan), \
                patch.object(DEPLOYER, '_cache_runtime_state', return_value=runtime), \
                patch.object(DEPLOYER, '_cache_read_records', side_effect=[[planned], [now_protected], [now_protected]]), \
                patch.object(DEPLOYER, '_cache_available_bytes', side_effect=[1000, 1000]), \
                patch.object(DEPLOYER, '_cache_prune_ids') as prune_mock, \
                patch.object(DEPLOYER.time, 'time', return_value=101), \
                patch.object(DEPLOYER, '_cache_write_audit'), \
                patch.object(DEPLOYER, '_cache_emit_report', side_effect=reports.append):
            DEPLOYER.cache_clean(TAG, REVISION, 'e' * 64)
        prune_mock.assert_not_called()
        self.assertEqual(reports[0]['newlyProtectedIds'], ['cache_a'])
        self.assertEqual(reports[0]['prunedIds'], [])

    def test_resource_snapshot_drift_stops_batches_and_fails_closed(self):
        planned = selected('cache_a')
        plan = {
            'schema': 1, 'operation': 'cache-maintenance-plan',
            'tag': TAG, 'revision': REVISION, 'toolingRevision': TOOLING_REVISION,
            'createdAt': 100, 'expiresAt': 100 + DEPLOYER.CACHE_PLAN_TTL_SECONDS,
            'protection': protection_snapshot(), 'inventoryIds': ['cache_a'],
            'selectedRecords': [planned], 'summary': {},
        }
        encoded = DEPLOYER._cache_plan_bytes(plan)
        installed = {'toolingRevision': TOOLING_REVISION}
        good = ({'tag': TAG, 'revision': REVISION}, installed, plan['protection'])
        drifted = ({'tag': TAG, 'revision': REVISION}, installed,
                   {**plan['protection'], 'unverifiedImages': [{
                       'id': 'sha256:' + '9' * 64, 'reasons': ['legacy-service'],
                       'identitySha256': 'f' * 64,
                   }]})
        reports = []
        with patch.object(DEPLOYER, '_read_trusted_host_file', return_value=encoded), \
                patch.object(DEPLOYER, '_cache_installed_tooling', return_value=installed), \
                patch.object(DEPLOYER, '_cache_validate_plan', return_value=plan), \
                patch.object(DEPLOYER, '_cache_runtime_state', side_effect=[good, drifted, drifted]), \
                patch.object(DEPLOYER, '_cache_read_records', side_effect=[[planned], []]), \
                patch.object(DEPLOYER, '_cache_available_bytes', side_effect=[1000, 1000]), \
                patch.object(DEPLOYER, '_cache_prune_ids') as prune_mock, \
                patch.object(DEPLOYER.time, 'time', return_value=101), \
                patch.object(DEPLOYER, '_cache_write_audit'), \
                patch.object(DEPLOYER, '_cache_emit_report', side_effect=reports.append):
            with self.assertRaisesRegex(RuntimeError, 'CACHE_PROTECTED_RESOURCE_DRIFT'):
                DEPLOYER.cache_clean(TAG, REVISION, 'f' * 64)
        prune_mock.assert_not_called()
        self.assertFalse(reports[0]['protectionVerified'])

    def test_gateway_exposes_only_fixed_inspect_and_digest_bound_clean_grammar(self):
        gateway = (ROOT / 'deploy/production/ai-project-os-actions-gateway').read_text()
        self.assertIn('^inspect-cache\\ (v[1-9][0-9]*', gateway)
        self.assertIn('CONFIRM_CACHE_INSPECT', gateway)
        self.assertIn('cache-inspect "${BASH_REMATCH[1]}" "${BASH_REMATCH[4]}" "${BASH_REMATCH[5]}"', gateway)
        self.assertIn('^clean-cache\\ (v[1-9][0-9]*', gateway)
        self.assertIn('([0-9a-f]{64})$', gateway)
        self.assertIn('cache-clean "${BASH_REMATCH[1]}" "${BASH_REMATCH[4]}" "${BASH_REMATCH[5]}"', gateway)
        self.assertIn('AI_PROJECT_OS_DEPLOY_COMMAND_DENIED', gateway)


if __name__ == '__main__':
    unittest.main(verbosity=2)
