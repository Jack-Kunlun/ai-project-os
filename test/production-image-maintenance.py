#!/usr/bin/env python3
"""Offline fail-closed tests for scoped historical production image maintenance."""
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
    'stable_production_image_maintenance_under_test',
    ROOT / 'deploy/production/ai-project-os-release-stable.py',
)
DEPLOYER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DEPLOYER)

TAG = 'v1.0.9'
REVISION = 'a' * 40
TOOLING_REVISION = 'b' * 40
IMAGE_ID = DEPLOYER.HISTORICAL_IMAGE_SCOPE[0]
CURRENT_IMAGE_ID = 'sha256:' + '1' * 64
PREVIOUS_IMAGE_ID = 'sha256:' + '2' * 64
OTHER_IMAGE_ID = 'sha256:' + '3' * 64
CONTAINER_ID = '4' * 64


def raw_image(identifier=IMAGE_ID, *, version='0.7.18-dev.4', service='app',
              source=None, project='ai-project-os', revision='c' * 40,
              title='AI Project OS', tags=None, digests=None, size=1234,
              duplicate_tags=False):
    if tags is None:
        tags = ['docker.io/library/ai-project-os-app:0.7.18-dev.4']
    if digests is None:
        digests = ['docker.io/library/ai-project-os-app@sha256:' + 'd' * 64]
    return {
        'id': identifier,
        'rawLabels': [title, source, version, revision, project, service],
        'title': title, 'source': source, 'version': version,
        'revision': revision, 'project': project, 'service': service,
        'labelErrors': [], 'repoTags': tags, 'repoDigests': digests,
        'duplicateTags': duplicate_tags, 'duplicateDigests': False,
        'sizeBytes': size, 'platform': {'os': 'linux', 'architecture': 'amd64'},
        'previousTag': 'v1.0.8', 'currentImageIds': [CURRENT_IMAGE_ID],
        'previousImageIds': [PREVIOUS_IMAGE_ID],
    }


def missing_record(identifier):
    return DEPLOYER._image_record(identifier, None, [])


def base_protection(*, candidate_unverified=True):
    owned = [
        {'id': CURRENT_IMAGE_ID, 'title': 'AI Project OS'},
        {'id': PREVIOUS_IMAGE_ID, 'title': 'AI Project OS'},
    ]
    unverified = ([{'id': IMAGE_ID, 'reasons': ['legacy-digests'],
                    'identitySha256': '5' * 64}] if candidate_unverified else [])
    return {
        'containers': [], 'volumes': [], 'ownedImages': owned,
        'unverifiedImages': unverified,
        'ownedImageIds': [CURRENT_IMAGE_ID, PREVIOUS_IMAGE_ID],
        'currentImageIds': [CURRENT_IMAGE_ID],
        'currentReceiptImageIds': [CURRENT_IMAGE_ID],
        'previousImageIds': [PREVIOUS_IMAGE_ID],
        'previousTag': 'v1.0.8', 'previousRevision': 'f' * 40,
        'postgresId': '6' * 64, 'migrationCount': 146,
        'migrationManifestSha256': '7' * 64, 'configHashes': {},
        'checkoutRevision': REVISION, 'deploymentReceiptSha256': '8' * 64,
        'dockerRoot': '/docker-root',
    }


def image_scope(records=None, *, all_ids=None, containers=None):
    records_by_id = {item['id']: item for item in (records or [])}
    images = [records_by_id.get(identifier, missing_record(identifier))
              for identifier in DEPLOYER.HISTORICAL_IMAGE_SCOPE]
    default_ids = [CURRENT_IMAGE_ID, PREVIOUS_IMAGE_ID, OTHER_IMAGE_ID]
    if IMAGE_ID in records_by_id:
        default_ids.append(IMAGE_ID)
    return {
        'allImageIds': sorted(default_ids if all_ids is None else all_ids),
        'containers': list(containers or []), 'images': images,
    }


def release_state(base=None, snapshot=None):
    return ({'tag': TAG, 'version': '1.0.9', 'revision': REVISION},
            {'toolingRevision': TOOLING_REVISION}, base or base_protection(),
            snapshot or image_scope([DEPLOYER._image_record(
                IMAGE_ID, raw_image(), [],
            )]))


def runtime_state(base, snapshot):
    return ({'tag': TAG, 'version': '1.0.9', 'revision': REVISION},
            {'toolingRevision': TOOLING_REVISION}, base, snapshot)


def plan_fixture(*, records=None, base=None, snapshot=None, eligible=None,
                 created_at=None, expires_at=None):
    base = base or base_protection()
    snapshot = snapshot or image_scope(
        records or [DEPLOYER._image_record(IMAGE_ID, raw_image(), [])],
    )
    eligible_ids = sorted(eligible if eligible is not None else
                          [item['id'] for item in snapshot['images'] if item['eligible']])
    now = int(DEPLOYER.time.time())
    plan = {
        'schema': 1, 'operation': 'image-maintenance-plan',
        'tag': TAG, 'revision': REVISION, 'toolingRevision': TOOLING_REVISION,
        'createdAt': now if created_at is None else created_at,
        'expiresAt': now + DEPLOYER.CACHE_PLAN_TTL_SECONDS if expires_at is None else expires_at,
        'scopeIds': list(DEPLOYER.HISTORICAL_IMAGE_SCOPE),
        'protection': DEPLOYER._image_plan_protection(base, snapshot),
        'images': snapshot['images'], 'eligibleIds': eligible_ids,
        'summary': DEPLOYER._image_summary(snapshot['images']),
    }
    encoded = DEPLOYER._image_plan_bytes(plan)
    return plan, encoded, DEPLOYER.sha256(encoded)


def snapshot_after_remove(plan, identifier):
    base = DEPLOYER._image_cache_protection_after_removals(
        plan['protection']['base'], [identifier],
    )
    all_ids = sorted(set(plan['protection']['allImageIds']) - {identifier})
    images = [missing_record(item['id']) if item['id'] == identifier else item
              for item in plan['images']]
    return {'base': base, 'snapshot': {
        'allImageIds': all_ids, 'containers': plan['protection']['containers'],
        'images': images,
    }}


class ImageReferenceTests(unittest.TestCase):
    def test_exact_legacy_reference_exceptions_are_bound_to_id_version_and_service(self):
        fixtures = json.loads((ROOT / 'test/fixtures/production-historical-image-references.json').read_text())
        self.assertEqual(len(fixtures), 10)
        self.assertEqual(set(DEPLOYER.HISTORICAL_IMAGE_REFERENCE_EXCEPTIONS),
                         {item['id'] for item in fixtures})
        for item in fixtures:
            with self.subTest(identifier=item['id']):
                self.assertIn(item['id'], DEPLOYER.HISTORICAL_IMAGE_SCOPE)
                raw = raw_image(item['id'], version=item['version'], service=item['service'],
                                tags=[item['tag']], digests=[item['digest']])
                record = DEPLOYER._image_record(item['id'], raw, [])
                self.assertEqual(record['ownership'], 'confirmed')
                self.assertTrue(record['eligible'])
                for field, value in (
                    ('version', '0.0.1'), ('service', 'principal-bootstrap'),
                    ('repoTags', [item['tag'] + '-unverified']),
                    ('repoDigests', [item['digest'][:-1] + ('0' if item['digest'][-1] != '0' else '1')]),
                    ('source', 'https://foreign.invalid/project'),
                    ('project', 'foreign-project'),
                    ('repoTags', []), ('repoDigests', []),
                    ('repoTags', [item['tag'], 'ai-project-os-' + item['service'] + ':latest']),
                    ('repoDigests', [item['digest'], item['digest']]),
                ):
                    changed = dict(raw)
                    changed[field] = value
                    retained = DEPLOYER._image_record(item['id'], changed, [])
                    self.assertFalse(retained['eligible'], (field, item['id']))
                    self.assertEqual(retained['ownership'], 'unconfirmed')
                changed_raw = dict(raw, repoTags=[], repoDigests=[])
                retained = DEPLOYER._image_record(item['id'], changed_raw, [])
                self.assertFalse(retained['eligible'])
                self.assertEqual(retained['ownership'], 'unconfirmed')
                changed = DEPLOYER._image_record(OTHER_IMAGE_ID, raw, [])
                self.assertFalse(changed['eligible'])
                self.assertIn('repository-reference-unrecognized', changed['ownershipReasons'])

    def test_exact_legacy_references_never_override_container_protection(self):
        fixtures = json.loads((ROOT / 'test/fixtures/production-historical-image-references.json').read_text())
        for item in fixtures:
            for status in ('running', 'exited'):
                with self.subTest(identifier=item['id'], status=status):
                    raw = raw_image(item['id'], version=item['version'], service=item['service'],
                                    tags=[item['tag']], digests=[item['digest']])
                    record = DEPLOYER._image_record(item['id'], raw, [{'id': CONTAINER_ID, 'status': status}])
                    self.assertEqual(record['ownership'], 'confirmed')
                    self.assertFalse(record['eligible'])
                    self.assertEqual(record['retainReasons'], ['container-referenced'])

    def test_scope_is_exactly_the_seventeen_authorized_image_ids(self):
        self.assertEqual(len(DEPLOYER.HISTORICAL_IMAGE_SCOPE), 17)
        self.assertEqual(DEPLOYER.HISTORICAL_IMAGE_SCOPE,
                         tuple(sorted(set(DEPLOYER.HISTORICAL_IMAGE_SCOPE))))
        self.assertTrue(all(item.startswith('sha256:') and len(item) == 71
                            for item in DEPLOYER.HISTORICAL_IMAGE_SCOPE))

    def test_only_exact_known_repositories_and_explicit_dockerhub_alias_are_accepted(self):
        for kind, ref in (
            ('tag', 'ai-project-os-app:0.7.18-dev.4'),
            ('tag', 'docker.io/library/ai-project-os-app:0.7.18-dev.4'),
            ('digest', 'docker.io/library/ai-project-os-app@sha256:' + 'a' * 64),
            ('digest', 'ghcr.io/jack-kunlun/ai-project-os-app@sha256:' + 'b' * 64),
        ):
            with self.subTest(ref=ref):
                self.assertEqual(DEPLOYER._image_ref_repo(ref, kind), (True, 'app'))
        self.assertEqual(DEPLOYER._image_ref_repo(
            'ghcr.io/jack-kunlun/ai-project-os@sha256:' + 'c' * 64, 'digest'),
            (True, None))
        for kind, ref in (
            ('tag', 'evil/ai-project-os-app:old'),
            ('tag', 'other/library/ai-project-os-app:old'),
            ('tag', 'docker.io/other/ai-project-os-app:old'),
            ('digest', 'ghcr.io/other/ai-project-os-app@sha256:' + 'd' * 64),
            ('digest', 'ghcr.io/jack-kunlun/ai-project-os-app@sha256:bad'),
        ):
            with self.subTest(ref=ref):
                self.assertEqual(DEPLOYER._image_ref_repo(ref, kind), (False, None))

    def test_legacy_and_canonical_metadata_confirm_ownership_for_old_images(self):
        legacy = DEPLOYER._image_record(IMAGE_ID, raw_image(), [])
        canonical = DEPLOYER._image_record(IMAGE_ID, raw_image(
            source='https://github.com/Jack-Kunlun/ai-project-os',
            project=None, service='app', revision='c' * 40,
            tags=['ghcr.io/jack-kunlun/ai-project-os-app:0.7.18-dev.4'],
            digests=['ghcr.io/jack-kunlun/ai-project-os-app@sha256:' + 'd' * 64],
        ), [])
        self.assertEqual(legacy['ownership'], 'confirmed')
        self.assertTrue(legacy['eligible'])
        self.assertEqual(legacy['sourceKind'], 'legacy')
        self.assertEqual(canonical['ownership'], 'confirmed')
        self.assertTrue(canonical['eligible'])
        self.assertEqual(canonical['sourceKind'], 'canonical')

    def test_foreign_source_and_references_are_redacted_and_retained(self):
        record = DEPLOYER._image_record(IMAGE_ID, raw_image(
            source='https://unknown.example/private',
            tags=['foreign/private-token:do-not-report'],
            digests=['ghcr.io/other/private@sha256:' + 'd' * 64],
        ), [])
        self.assertEqual(record['ownership'], 'unconfirmed')
        self.assertFalse(record['eligible'])
        self.assertIn('source-unrecognized', record['ownershipReasons'])
        self.assertIn('repository-reference-unrecognized', record['ownershipReasons'])
        self.assertEqual(record['unknownRefCount'], 2)
        serialized = json.dumps(record)
        self.assertNotIn('private-token', serialized)
        self.assertNotIn('unknown.example', serialized)
        self.assertEqual(len(record['unknownRefsSha256']), 64)

    def test_missing_title_project_or_service_and_invalid_revision_fail_closed(self):
        cases = (
            raw_image(title='Unrelated image'),
            raw_image(project='other-project'),
            raw_image(service='unknown-service'),
            raw_image(revision='not-a-commit'),
        )
        for image in cases:
            with self.subTest(image=image['rawLabels']):
                record = DEPLOYER._image_record(IMAGE_ID, image, [])
                self.assertEqual(record['ownership'], 'unconfirmed')
                self.assertFalse(record['eligible'])

    def test_only_versions_strictly_older_than_previous_release_are_candidates(self):
        cases = (
            ('1.0.8-dev.99', True),
            ('1.0.8', False),
            ('1.0.9', False),
            ('0.7.18', True),
            ('1.0.08', False),
        )
        for version, expected in cases:
            with self.subTest(version=version):
                record = DEPLOYER._image_record(IMAGE_ID, raw_image(version=version), [])
                self.assertEqual(record['eligible'], expected)

    def test_current_previous_ids_and_running_or_stopped_container_refs_are_preserved(self):
        current = DEPLOYER._image_record(CURRENT_IMAGE_ID, raw_image(CURRENT_IMAGE_ID), [])
        previous = DEPLOYER._image_record(PREVIOUS_IMAGE_ID, raw_image(PREVIOUS_IMAGE_ID), [])
        running = DEPLOYER._image_record(
            IMAGE_ID, raw_image(), [{'id': CONTAINER_ID, 'status': 'running'}],
        )
        stopped = DEPLOYER._image_record(
            IMAGE_ID, raw_image(), [{'id': '9' * 64, 'status': 'exited'}],
        )
        self.assertFalse(current['eligible'])
        self.assertIn('current-release-image', current['retainReasons'])
        self.assertFalse(previous['eligible'])
        self.assertIn('previous-release-image', previous['retainReasons'])
        self.assertFalse(running['eligible'])
        self.assertFalse(stopped['eligible'])
        self.assertEqual(running['containerReferences'][0]['status'], 'running')
        self.assertEqual(stopped['containerReferences'][0]['status'], 'exited')

    def test_unrecognized_repo_service_mismatch_and_duplicate_refs_retain(self):
        mismatch = DEPLOYER._image_record(IMAGE_ID, raw_image(
            tags=['ai-project-os-worker:0.7.18-dev.4'],
        ), [])
        duplicate = DEPLOYER._image_record(
            IMAGE_ID, raw_image(tags=['ai-project-os-app:old'] * 2,
                                duplicate_tags=True), [],
        )
        self.assertFalse(mismatch['eligible'])
        self.assertIn('repository-service-mismatch', mismatch['ownershipReasons'])
        self.assertFalse(duplicate['eligible'])
        self.assertIn('duplicate-repository-reference', duplicate['ownershipReasons'])


class ImageDockerSnapshotTests(unittest.TestCase):
    def test_image_template_selects_safe_fields_without_env_config_or_history(self):
        template = DEPLOYER._IMAGE_INSPECT_TEMPLATE
        self.assertIn('.RepoTags', template)
        self.assertIn('.RepoDigests', template)
        self.assertIn('.Size', template)
        self.assertIn('.Architecture', template)
        self.assertNotIn('.Config.Env', template)
        self.assertNotIn('.Config.Cmd', template)
        self.assertNotIn('.RootFS', template)
        self.assertNotIn('.History', template)
        payload = [IMAGE_ID, 'AI Project OS', None, '0.7.18-dev.4', 'c' * 40,
                   'ai-project-os', 'app',
                   ['ai-project-os-app:0.7.18-dev.4'],
                   ['ai-project-os-app@sha256:' + 'd' * 64], 1234, 'linux', 'amd64']
        with patch.object(DEPLOYER, 'docker', return_value=json.dumps(payload)) as docker_mock:
            observed = DEPLOYER._image_raw_inspect(IMAGE_ID)
        self.assertEqual(observed['id'], IMAGE_ID)
        self.assertEqual(observed['sizeBytes'], 1234)
        args = docker_mock.call_args.args
        self.assertEqual(args[:3], ('image', 'inspect', '--format'))
        self.assertEqual(args[4], IMAGE_ID)
        # Go's index on a missing map[string]string label can render an empty
        # JSON string, rather than null. Old Compose builds lack revision/source.
        for missing in (None, ''):
            payload[2] = missing
            payload[4] = missing
            with patch.object(DEPLOYER, 'docker', return_value=json.dumps(payload)):
                legacy = DEPLOYER._image_raw_inspect(IMAGE_ID)
            legacy.update(previousTag='v1.0.8', currentImageIds=[CURRENT_IMAGE_ID],
                          previousImageIds=[PREVIOUS_IMAGE_ID])
            self.assertTrue(DEPLOYER._image_record(IMAGE_ID, legacy, [])['eligible'])

    def test_all_containers_including_stopped_are_mapped_to_image_ids(self):
        rows = '\n'.join((
            json.dumps([CONTAINER_ID, IMAGE_ID, 'running']),
            json.dumps(['9' * 64, IMAGE_ID, 'exited']),
        ))

        def fake_docker(*args, **kwargs):
            if args[:3] == ('ps', '--all', '--quiet'):
                return CONTAINER_ID + '\n' + '9' * 64
            if args[:2] == ('inspect', '--format'):
                self.assertIn('.State.Status', args[2])
                return rows
            raise AssertionError(args)

        with patch.object(DEPLOYER, 'docker', side_effect=fake_docker):
            observed = DEPLOYER._image_container_inventory()
        self.assertEqual([item['status'] for item in observed], ['running', 'exited'])

    def test_duplicate_json_keys_malformed_image_ids_and_statuses_are_rejected(self):
        with self.assertRaisesRegex(RuntimeError, 'CACHE_USAGE_DUPLICATE_KEY'):
            DEPLOYER._image_parse_json('{"id":"a","id":"b"}', 'IMAGE_INSPECT_INVALID')
        with self.assertRaisesRegex(RuntimeError, 'IMAGE_INVENTORY_INVALID'):
            with patch.object(DEPLOYER, 'docker', return_value='not-an-image-id'):
                DEPLOYER._image_inventory_ids()
        with self.assertRaisesRegex(RuntimeError, 'IMAGE_CONTAINER_INSPECT_INVALID'):
            with patch.object(DEPLOYER, 'docker', side_effect=[CONTAINER_ID, json.dumps(
                    [CONTAINER_ID, IMAGE_ID, 'unknown'])]):
                DEPLOYER._image_container_inventory()


class ImagePlanAndCleanTests(unittest.TestCase):
    def inspectable_state(self):
        record = DEPLOYER._image_record(IMAGE_ID, raw_image(), [])
        snapshot = image_scope([record])
        return release_state(base_protection(), snapshot)

    def test_inspect_freezes_only_the_exact_scope_and_emits_sanitized_report(self):
        state = self.inspectable_state()
        captured = {}
        with patch.object(DEPLOYER, '_image_runtime_snapshot', return_value=state), \
                patch.object(DEPLOYER, 'atomic_install', side_effect=lambda path, data, mode:
                             captured.update(path=path, data=data, mode=mode)), \
                patch.object(DEPLOYER, '_image_write_audit') as audit, \
                patch.object(DEPLOYER, '_image_emit_report') as emit:
            DEPLOYER.image_inspect(TAG, REVISION)
        plan = json.loads(captured['data'])
        report = emit.call_args.args[0]
        self.assertEqual(captured['path'], DEPLOYER.IMAGE_MAINTENANCE_PLAN)
        self.assertEqual(captured['mode'], 0o600)
        self.assertEqual(plan['scopeIds'], list(DEPLOYER.HISTORICAL_IMAGE_SCOPE))
        self.assertEqual(len(plan['images']), 17)
        self.assertEqual(report['operation'], 'image-inspect')
        self.assertEqual(report['summary']['eligibleCount'], 1)
        self.assertEqual(report['protection']['allImageIds'], state[3]['allImageIds'])
        self.assertEqual(audit.call_args.args[0]['status'], 'OK')
        digest = DEPLOYER.sha256(captured['data'])
        DEPLOYER._image_validate_plan(captured['data'], digest, TAG, REVISION,
                                      TOOLING_REVISION)

    def test_plan_digest_source_tooling_scope_and_expiry_are_bound(self):
        plan, encoded, digest = plan_fixture()
        DEPLOYER._image_validate_plan(encoded, digest, TAG, REVISION, TOOLING_REVISION)
        invalid = (
            (digest, 'v1.0.8', REVISION, TOOLING_REVISION),
            (digest, TAG, 'f' * 40, TOOLING_REVISION),
            (digest, TAG, REVISION, 'c' * 40),
            ('0' * 64, TAG, REVISION, TOOLING_REVISION),
        )
        for candidate, tag, revision, tooling in invalid:
            with self.subTest(candidate=candidate, tag=tag, revision=revision):
                with self.assertRaises(RuntimeError):
                    DEPLOYER._image_validate_plan(encoded, candidate, tag, revision, tooling)
        plan['scopeIds'] = list(plan['scopeIds'])[:-1]
        changed = DEPLOYER._image_plan_bytes(plan)
        with self.assertRaisesRegex(RuntimeError, 'IMAGE_PLAN_IDENTITY_INVALID'):
            DEPLOYER._image_validate_plan(changed, DEPLOYER.sha256(changed),
                                          TAG, REVISION, TOOLING_REVISION)

    def test_expired_monotonic_deadline_cannot_be_extended_by_wall_clock_rollback(self):
        plan = {'createdAt': 100, 'expiresAt': 1000}
        with patch.object(DEPLOYER.time, 'time', return_value=200), \
                patch.object(DEPLOYER.time, 'monotonic', return_value=901):
            with self.assertRaisesRegex(RuntimeError, 'CACHE_PLAN_EXPIRED_OR_INVALID'):
                DEPLOYER._cache_plan_remaining(plan, monotonic_deadline=900)

    def test_clean_removes_one_immutable_id_without_force_and_reports_disk_delta(self):
        plan, encoded, digest = plan_fixture()
        after = snapshot_after_remove(plan, IMAGE_ID)
        snapshots = [
            (plan['tag'] and {'tag': TAG, 'version': '1.0.9', 'revision': REVISION},
             {'toolingRevision': TOOLING_REVISION}, plan['protection']['base'],
             {'allImageIds': plan['protection']['allImageIds'],
              'containers': plan['protection']['containers'], 'images': plan['images']}),
            (None, None, plan['protection']['base'],
             {'allImageIds': plan['protection']['allImageIds'],
              'containers': plan['protection']['containers'], 'images': plan['images']}),
            (None, None, after['base'], after['snapshot']),
            (None, None, after['base'], after['snapshot']),
        ]
        calls = []

        def state(*_args):
            item = snapshots.pop(0)
            return item

        with patch.object(DEPLOYER, '_read_trusted_host_file', return_value=encoded), \
                patch.object(DEPLOYER, '_cache_installed_tooling',
                             return_value={'toolingRevision': TOOLING_REVISION}), \
                patch.object(DEPLOYER, '_image_runtime_snapshot', side_effect=state), \
                patch.object(DEPLOYER, '_image_available_bytes', side_effect=[1000, 1350]), \
                patch.object(DEPLOYER, '_image_remove_id', side_effect=lambda image_id, **kw:
                             calls.append((image_id, kw['timeout_seconds'])) or
                             'removed-command-succeeded'), \
                patch.object(DEPLOYER, '_image_write_audit') as audit, \
                patch.object(DEPLOYER, '_image_emit_report') as emit:
            DEPLOYER.image_clean(TAG, REVISION, digest)
        self.assertEqual(calls[0][0], IMAGE_ID)
        self.assertGreater(calls[0][1], 0)
        report = emit.call_args.args[0]
        self.assertEqual(report['removedIds'], [IMAGE_ID])
        self.assertEqual(report['netAvailableBytesDelta'], 350)
        self.assertTrue(report['protectionVerified'])
        self.assertEqual(report['checks'], {
            'localHealth': True, 'publicHealth': True, 'database': True,
            'worker': True, 'migrationLedger': True,
        })
        self.assertEqual(audit.call_args.args[0]['status'], 'OK')
        with patch.object(DEPLOYER, 'HELPER') as helper, \
                patch.object(DEPLOYER.os, 'access', return_value=True), \
                patch.object(DEPLOYER.subprocess, 'run', return_value=type(
                    'Result', (), {'returncode': 0})()) as run_mock:
            with patch.object(DEPLOYER.Path, 'stat', return_value=type(
                    'Info', (), {'st_mode': 0o100755})()):
                DEPLOYER._image_remove_id(IMAGE_ID, timeout_seconds=12)
        command = run_mock.call_args.args[0]
        self.assertEqual(command[-4:], ['image', 'rm', '--no-prune', IMAGE_ID])
        self.assertNotIn('--force', command)

    def test_engine_refusal_retains_image_without_tag_or_force_fallback(self):
        plan, encoded, digest = plan_fixture()
        same = {'base': plan['protection']['base'], 'snapshot': {
            'allImageIds': plan['protection']['allImageIds'],
            'containers': plan['protection']['containers'], 'images': plan['images'],
        }}
        states = [
            ({'tag': TAG, 'version': '1.0.9', 'revision': REVISION},
             {'toolingRevision': TOOLING_REVISION}, same['base'], same['snapshot']),
            (None, None, same['base'], same['snapshot']),
            (None, None, same['base'], same['snapshot']),
            (None, None, same['base'], same['snapshot']),
        ]
        calls = []
        with patch.object(DEPLOYER, '_read_trusted_host_file', return_value=encoded), \
                patch.object(DEPLOYER, '_cache_installed_tooling',
                             return_value={'toolingRevision': TOOLING_REVISION}), \
                patch.object(DEPLOYER, '_image_runtime_snapshot', side_effect=states), \
                patch.object(DEPLOYER, '_image_available_bytes', side_effect=[1000, 1000]), \
                patch.object(DEPLOYER, '_image_remove_id', side_effect=lambda image_id, **kw:
                             calls.append(image_id) or 'engine-refused'), \
                patch.object(DEPLOYER, '_image_write_audit'), \
                patch.object(DEPLOYER, '_image_emit_report') as emit:
            DEPLOYER.image_clean(TAG, REVISION, digest)
        report = emit.call_args.args[0]
        self.assertEqual(calls, [IMAGE_ID])
        self.assertEqual(report['engineRefusedIds'], [IMAGE_ID])
        self.assertEqual(report['retainedIds'], [IMAGE_ID])
        self.assertEqual(report['failureReasons'][IMAGE_ID], 'engine-refused')
        self.assertTrue(report['protectionVerified'])

    def test_new_container_reference_or_metadata_drift_stops_before_delete(self):
        plan, encoded, digest = plan_fixture()
        changed_record = DEPLOYER._image_record(
            IMAGE_ID, raw_image(), [{'id': CONTAINER_ID, 'status': 'exited'}],
        )
        changed_snapshot = image_scope([changed_record], all_ids=plan['protection']['allImageIds'],
                                       containers=[{'id': CONTAINER_ID, 'image': IMAGE_ID,
                                                    'status': 'exited'}])
        base = dict(plan['protection']['base'])
        base['containers'] = [{'id': CONTAINER_ID, 'image': IMAGE_ID}]
        changed = runtime_state(base, changed_snapshot)
        initial = runtime_state(plan['protection']['base'], {
            'allImageIds': plan['protection']['allImageIds'],
            'containers': plan['protection']['containers'], 'images': plan['images'],
        })
        with patch.object(DEPLOYER, '_read_trusted_host_file', return_value=encoded), \
                patch.object(DEPLOYER, '_cache_installed_tooling',
                             return_value={'toolingRevision': TOOLING_REVISION}), \
                patch.object(DEPLOYER, '_image_runtime_snapshot', side_effect=[initial, changed, changed]), \
                patch.object(DEPLOYER, '_image_available_bytes', side_effect=[1000, 1000]), \
                patch.object(DEPLOYER, '_image_remove_id') as remove, \
                patch.object(DEPLOYER, '_image_write_audit'), \
                patch.object(DEPLOYER, '_image_emit_report') as emit:
            with self.assertRaisesRegex(RuntimeError, 'IMAGE_PROTECTED_RESOURCE_DRIFT'):
                DEPLOYER.image_clean(TAG, REVISION, digest)
        remove.assert_not_called()
        report = emit.call_args.args[0]
        self.assertIn(IMAGE_ID, report['newlyReferencedIds'])
        self.assertFalse(report['protectionVerified'])

    def test_unrelated_image_inventory_drift_prevents_scoped_deletion(self):
        plan, encoded, digest = plan_fixture()
        initial = runtime_state(plan['protection']['base'], {
            'allImageIds': plan['protection']['allImageIds'],
            'containers': plan['protection']['containers'], 'images': plan['images'],
        })
        changed_snapshot = {
            'allImageIds': sorted(plan['protection']['allImageIds'] + ['sha256:' + '9' * 64]),
            'containers': plan['protection']['containers'], 'images': plan['images'],
        }
        changed = runtime_state(plan['protection']['base'], changed_snapshot)
        with patch.object(DEPLOYER, '_read_trusted_host_file', return_value=encoded), \
                patch.object(DEPLOYER, '_cache_installed_tooling',
                             return_value={'toolingRevision': TOOLING_REVISION}), \
                patch.object(DEPLOYER, '_image_runtime_snapshot', side_effect=[initial, changed, changed]), \
                patch.object(DEPLOYER, '_image_available_bytes', side_effect=[1000, 1000]), \
                patch.object(DEPLOYER, '_image_remove_id') as remove, \
                patch.object(DEPLOYER, '_image_write_audit'), \
                patch.object(DEPLOYER, '_image_emit_report') as emit:
            with self.assertRaisesRegex(RuntimeError, 'IMAGE_PROTECTED_RESOURCE_DRIFT'):
                DEPLOYER.image_clean(TAG, REVISION, digest)
        remove.assert_not_called()
        self.assertTrue(emit.call_args.args[0]['allImageInventoryDrift'])

    def test_vanished_candidate_is_not_retried_or_removed(self):
        plan, encoded, digest = plan_fixture()
        initial = runtime_state(plan['protection']['base'], {
            'allImageIds': plan['protection']['allImageIds'],
            'containers': plan['protection']['containers'], 'images': plan['images'],
        })
        vanished_base = DEPLOYER._image_cache_protection_after_removals(
            plan['protection']['base'], [IMAGE_ID],
        )
        vanished_snapshot = snapshot_after_remove(plan, IMAGE_ID)['snapshot']
        vanished = runtime_state(vanished_base, vanished_snapshot)
        with patch.object(DEPLOYER, '_read_trusted_host_file', return_value=encoded), \
                patch.object(DEPLOYER, '_cache_installed_tooling',
                             return_value={'toolingRevision': TOOLING_REVISION}), \
                patch.object(DEPLOYER, '_image_runtime_snapshot', side_effect=[initial, vanished, vanished]), \
                patch.object(DEPLOYER, '_image_available_bytes', side_effect=[1000, 1000]), \
                patch.object(DEPLOYER, '_image_remove_id') as remove, \
                patch.object(DEPLOYER, '_image_write_audit'), \
                patch.object(DEPLOYER, '_image_emit_report') as emit:
            with self.assertRaisesRegex(RuntimeError, 'IMAGE_PROTECTED_RESOURCE_DRIFT'):
                DEPLOYER.image_clean(TAG, REVISION, digest)
        remove.assert_not_called()
        self.assertIn(IMAGE_ID, emit.call_args.args[0]['vanishedIds'])

    def test_plan_expiry_between_images_stops_additional_delete(self):
        first = IMAGE_ID
        second = DEPLOYER.HISTORICAL_IMAGE_SCOPE[1]
        images = [DEPLOYER._image_record(first, raw_image(first), []),
                  DEPLOYER._image_record(second, raw_image(second, service='worker',
                      tags=['ai-project-os-worker:0.7.18-dev.4'],
                      digests=['ai-project-os-worker@sha256:' + 'e' * 64]), [])]
        snapshot = image_scope(images, all_ids=[CURRENT_IMAGE_ID, PREVIOUS_IMAGE_ID,
                                               OTHER_IMAGE_ID, first, second])
        base = base_protection()
        base['unverifiedImages'].append({'id': second, 'reasons': ['legacy-digests'],
                                         'identitySha256': 'a' * 64})
        plan, encoded, digest = plan_fixture(records=snapshot['images'], base=base,
                                             snapshot=snapshot, eligible=[first, second])
        same = runtime_state(base, {'allImageIds': plan['protection']['allImageIds'],
                                    'containers': plan['protection']['containers'],
                                    'images': plan['images']})
        after_first = snapshot_after_remove(plan, first)
        after = runtime_state(after_first['base'], after_first['snapshot'])
        states = [same, same, after, after]
        guard = [600, 600, 600, RuntimeError('STABLE_CACHE_PLAN_EXPIRED_OR_INVALID')]
        calls = []
        with patch.object(DEPLOYER, '_read_trusted_host_file', return_value=encoded), \
                patch.object(DEPLOYER, '_cache_installed_tooling',
                             return_value={'toolingRevision': TOOLING_REVISION}), \
                patch.object(DEPLOYER, '_cache_plan_remaining', side_effect=guard), \
                patch.object(DEPLOYER.time, 'monotonic', return_value=100), \
                patch.object(DEPLOYER, '_image_runtime_snapshot', side_effect=states), \
                patch.object(DEPLOYER, '_image_available_bytes', side_effect=[1000, 1200]), \
                patch.object(DEPLOYER, '_image_remove_id', side_effect=lambda image_id, **kw:
                             calls.append(image_id) or 'removed-command-succeeded'), \
                patch.object(DEPLOYER, '_image_write_audit'), \
                patch.object(DEPLOYER, '_image_emit_report') as emit:
            DEPLOYER.image_clean(TAG, REVISION, digest)
        report = emit.call_args.args[0]
        self.assertEqual(calls, [first])
        self.assertTrue(report['expiredBeforeNextDelete'])
        self.assertEqual(report['removedIds'], [first])
        self.assertIn(second, report['retainedIds'])


class GatewayContractTests(unittest.TestCase):
    def test_gateway_has_only_fixed_inspect_and_clean_image_grammars(self):
        gateway = (ROOT / 'deploy/production/ai-project-os-actions-gateway').read_text()
        self.assertIn('^inspect-images\\ ', gateway)
        self.assertIn('^clean-images\\ ', gateway)
        self.assertIn('image-inspect', gateway)
        self.assertIn('image-clean', gateway)
        self.assertNotIn('image-prune', gateway)
        self.assertNotIn('bash -c', gateway)

    def test_root_dispatch_accepts_only_confirmed_inspect_and_digest_bound_clean(self):
        for args, target, expected in (
            (['image-inspect', TAG, REVISION, 'CONFIRM_IMAGE_INSPECT'],
             'image_inspect', (TAG, REVISION)),
            (['image-clean', TAG, REVISION, '9' * 64],
             'image_clean', (TAG, REVISION, '9' * 64)),
        ):
            fd = DEPLOYER.os.open('/dev/null', DEPLOYER.os.O_RDONLY)
            with self.subTest(command=args[0]), \
                    patch.object(DEPLOYER.os, 'geteuid', return_value=0), \
                    patch.object(DEPLOYER.os, 'umask'), \
                    patch.object(DEPLOYER, 'HELPER') as helper, \
                    patch.object(DEPLOYER, 'secure_lock', return_value=fd), \
                    patch.object(DEPLOYER.signal, 'signal'), \
                    patch.object(DEPLOYER, '_cache_installed_tooling', return_value={}), \
                    patch.object(DEPLOYER, target) as dispatch:
                DEPLOYER.main(args)
            helper.trusted.assert_any_call('/root')
            dispatch.assert_called_once_with(*expected)

        fd = DEPLOYER.os.open('/dev/null', DEPLOYER.os.O_RDONLY)
        with patch.object(DEPLOYER.os, 'geteuid', return_value=0), \
                patch.object(DEPLOYER.os, 'umask'), \
                patch.object(DEPLOYER, 'HELPER'), \
                patch.object(DEPLOYER, 'secure_lock', return_value=fd), \
                patch.object(DEPLOYER.signal, 'signal'), \
                patch.object(DEPLOYER, '_cache_installed_tooling', return_value={}), \
                patch.object(DEPLOYER, 'image_inspect') as inspect:
            with self.assertRaisesRegex(RuntimeError, 'IMAGE_INSPECT_CONFIRMATION_INVALID'):
                DEPLOYER.main(['image-inspect', TAG, REVISION, 'CONFIRM_CACHE_INSPECT'])
        inspect.assert_not_called()


if __name__ == '__main__':
    unittest.main(verbosity=2)
