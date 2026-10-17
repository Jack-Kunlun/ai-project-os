"""Offline tests of the real release cleanup/classification call chain; no Docker daemon."""
import copy
from contextlib import ExitStack
import importlib.util
import io
import json
from pathlib import Path
import stat
import unittest
from unittest.mock import MagicMock, patch

spec = importlib.util.spec_from_file_location('image_fixtures', Path(__file__).with_name('production-image-maintenance.py'))
fixtures = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixtures)
m = fixtures.DEPLOYER
TAG, REVISION = fixtures.TAG, fixtures.REVISION


def image_id(char):
    return 'sha256:' + char * 64


class Inventory:
    def __init__(self):
        self.raw = {}
        for char, version in [('1', '1.0.9'), ('2', '1.0.8'), ('4', '1.0.7'),
                              ('5', '1.0.7'), ('6', '1.0.10'), ('9', '1.0.7')]:
            self.raw[image_id(char)] = fixtures.raw_image(
                image_id(char), version=version, source=m.IMAGE_SOURCE,
                tags=['ghcr.io/jack-kunlun/ai-project-os-app:v' + version],
                digests=['ghcr.io/jack-kunlun/ai-project-os-app@sha256:' + char * 64],
            )
        self.raw[image_id('5')]['source'] = 'unrecognized'
        self.base = fixtures.base_protection(candidate_unverified=False)
        self.base['ownedImageIds'] = sorted(key for key in self.raw if key != image_id('5'))
        self.base['ownedImages'] = [{'id': key} for key in self.base['ownedImageIds']]
        self.base['unverifiedImages'] = [{'id': image_id('5'), 'reasons': ['source-unrecognized'], 'identitySha256': '7' * 64}]
        self.references = [{'id': 'a' * 64, 'image': image_id('4'), 'status': 'exited'}]
        self.base['containers'] = copy.deepcopy(self.references)
        self.base['volumes'] = [{'name': 'business-data', 'identitySha256': 'b' * 64}]
        self.removed = set()
        self.reads = 0
        self.drift_at = None
        self.refuse = False

    def runtime(self, *_args):
        self.reads += 1
        base = m._image_cache_protection_after_removals(self.base, self.removed)
        if self.drift_at is not None and self.reads >= self.drift_at:
            base['configHashes'] = {'compose': 'changed'}
        return ({'tag': TAG, 'version': '1.0.9', 'revision': REVISION},
                {'toolingRevision': fixtures.TOOLING_REVISION}, base)

    def remove(self, identifier, *, timeout_seconds):
        assert 0 < timeout_seconds <= 600
        if self.refuse:
            return 'engine-refused'
        self.removed.add(identifier)
        self.raw.pop(identifier)
        return 'removed-command-succeeded'

    def patches(self, stack):
        stack.enter_context(patch.object(m, '_cache_runtime_state', autospec=True, side_effect=self.runtime))
        stack.enter_context(patch.object(m, '_image_inventory_ids', autospec=True, side_effect=lambda: sorted(self.raw)))
        stack.enter_context(patch.object(m, '_image_container_inventory', autospec=True, side_effect=lambda: copy.deepcopy(self.references)))
        stack.enter_context(patch.object(m, '_image_raw_inspect', autospec=True, side_effect=lambda identifier: copy.deepcopy(self.raw[identifier])))
        remove = stack.enter_context(patch.object(m, '_image_remove_command', autospec=True, side_effect=self.remove))
        stack.enter_context(patch.object(m, '_image_available_bytes', autospec=True, side_effect=[100, 150]))
        self.audit = stack.enter_context(patch.object(m, '_image_write_audit', autospec=True))
        stack.enter_context(patch.object(m, 'docker', side_effect=AssertionError('unexpected Docker command')))
        stack.enter_context(patch('sys.stdout', new_callable=io.StringIO))
        return remove


class ReleaseMaintenanceTests(unittest.TestCase):
    def test_real_inventory_classification_keeps_current_previous_future_unknown_and_all_references(self):
        inventory = Inventory()
        with ExitStack() as stack:
            remove = inventory.patches(stack)
            report = m.release_cleanup_old_images(TAG, REVISION)
        self.assertEqual(report['removedIds'], [image_id('9')])
        self.assertEqual(remove.call_args.args, (image_id('9'),))
        reasons = {item['id']: item['retainReasons'] for item in report['retainedImages']}
        for char, reason in [('1', 'current-release-image'), ('2', 'previous-release-image'),
                             ('4', 'container-referenced'), ('5', 'ownership-unconfirmed'),
                             ('6', 'not-older-than-previous-release')]:
            self.assertIn(reason, reasons[image_id(char)])
        self.assertEqual(report['protection']['volumeCount'], 1)
        self.assertTrue(report['protectionVerified'])
        self.assertEqual(report['netAvailableBytesDelta'], 50)
        self.assertEqual(inventory.audit.call_args_list[0].args[0]['pendingId'], image_id('9'))
        self.assertEqual(inventory.audit.call_args_list[0].args[0]['status'], 'IN_PROGRESS')
        self.assertEqual(inventory.audit.call_args_list[-1].args[0]['status'], 'OK')

    def test_engine_refusal_retains_image_without_mutable_reference_fallback(self):
        inventory = Inventory(); inventory.refuse = True
        with ExitStack() as stack:
            remove = inventory.patches(stack)
            report = m.release_cleanup_old_images(TAG, REVISION)
        self.assertEqual(report['removedIds'], [])
        self.assertEqual(report['engineRetained'], [{'id': image_id('9'), 'reason': 'engine-refused'}])
        self.assertEqual(remove.call_count, 1)

    def test_resource_drift_before_deletion_fails_closed(self):
        inventory = Inventory(); inventory.drift_at = 2
        with ExitStack() as stack:
            remove = inventory.patches(stack)
            with self.assertRaisesRegex(RuntimeError, 'IMAGE_RELEASE_PROTECTED_RESOURCE_DRIFT'):
                m.release_cleanup_old_images(TAG, REVISION)
        remove.assert_not_called()

    def test_drift_after_first_delete_stops_all_subsequent_deletes(self):
        inventory = Inventory(); inventory.drift_at = 3
        inventory.raw[image_id('8')] = fixtures.raw_image(image_id('8'))
        inventory.base['ownedImages'].append({'id': image_id('8')})
        inventory.base['ownedImageIds'] = sorted(inventory.base['ownedImageIds'] + [image_id('8')])
        with ExitStack() as stack:
            remove = inventory.patches(stack)
            with self.assertRaisesRegex(RuntimeError, 'IMAGE_RELEASE_PROTECTED_RESOURCE_DRIFT'):
                m.release_cleanup_old_images(TAG, REVISION)
        self.assertEqual(remove.call_count, 1)
        self.assertIn(image_id('9'), inventory.raw)
        audit = inventory.audit.call_args.args[0]
        self.assertEqual(audit['status'], 'FAILED')
        self.assertEqual(audit['attemptedIds'], [image_id('8')])
        self.assertEqual(audit['removedIds'], [image_id('8')])
        self.assertFalse(audit['protectionVerified'])
        self.assertTrue(audit['failureInventoryVerified'])
        self.assertEqual(audit['unconfirmedAttemptIds'], [])
        self.assertEqual(audit['failureCode'], 'STABLE_IMAGE_RELEASE_PROTECTED_RESOURCE_DRIFT')

    def test_post_delete_health_failure_still_persists_actual_removed_ids(self):
        inventory = Inventory()
        original_runtime = inventory.runtime
        def runtime(*args):
            if inventory.removed:
                raise RuntimeError('STABLE_CACHE_PUBLIC_HEALTH_INVALID')
            return original_runtime(*args)
        inventory.runtime = runtime
        with ExitStack() as stack:
            remove = inventory.patches(stack)
            with self.assertRaisesRegex(RuntimeError, 'CACHE_PUBLIC_HEALTH_INVALID'):
                m.release_cleanup_old_images(TAG, REVISION)
        self.assertEqual(remove.call_count, 1)
        audit = inventory.audit.call_args.args[0]
        self.assertEqual(audit['removedIds'], [image_id('9')])
        self.assertEqual(audit['status'], 'FAILED')
        self.assertFalse(audit['protectionVerified'])
        self.assertTrue(audit['failureInventoryVerified'])

    def test_pre_delete_audit_failure_prevents_mutation_and_logs_failure(self):
        inventory = Inventory()
        with ExitStack() as stack:
            remove = inventory.patches(stack)
            inventory.audit.side_effect = RuntimeError('STABLE_IMAGE_AUDIT_WRITE_FAILED')
            output = stack.enter_context(patch('sys.stdout', new_callable=io.StringIO))
            with self.assertRaisesRegex(RuntimeError, 'IMAGE_AUDIT_WRITE_FAILED'):
                m.release_cleanup_old_images(TAG, REVISION)
        remove.assert_not_called()
        report = json.loads(output.getvalue().split('STABLE_RELEASE_IMAGE_CLEANUP ')[1])
        self.assertEqual(report['status'], 'FAILED')
        self.assertEqual(report['attemptedIds'], [])

    def test_unavailable_failure_inventory_records_unconfirmed_request_without_claiming_deletion(self):
        inventory = Inventory()
        def remove_then_lose_inventory(identifier, *, timeout_seconds):
            inventory.remove(identifier, timeout_seconds=timeout_seconds)
            raise RuntimeError('STABLE_IMAGE_REMOVE_RESULT_UNKNOWN')
        with ExitStack() as stack:
            remove = inventory.patches(stack)
            remove.side_effect = remove_then_lose_inventory
            stack.enter_context(patch.object(m, '_image_inventory_ids', side_effect=[sorted(inventory.raw), sorted(inventory.raw), RuntimeError('unavailable')]))
            with self.assertRaisesRegex(RuntimeError, 'IMAGE_REMOVE_RESULT_UNKNOWN'):
                m.release_cleanup_old_images(TAG, REVISION)
        audit = inventory.audit.call_args.args[0]
        self.assertEqual(audit['removedIds'], [])
        self.assertEqual(audit['unconfirmedAttemptIds'], [image_id('9')])
        self.assertFalse(audit['failureInventoryVerified'])
        self.assertFalse(audit['protectionVerified'])

    def test_deadline_rechecked_after_health_reads_before_any_delete(self):
        inventory = Inventory()
        with ExitStack() as stack:
            remove = inventory.patches(stack)
            stack.enter_context(patch.object(m.time, 'monotonic', side_effect=[0, 1, 901]))
            with self.assertRaisesRegex(RuntimeError, 'IMAGE_RELEASE_CLEANUP_EXPIRED'):
                m.release_cleanup_old_images(TAG, REVISION)
        remove.assert_not_called()

    def test_missing_previous_boundary_stops_deletion(self):
        inventory = Inventory(); inventory.base['previousTag'] = None
        with ExitStack() as stack:
            remove = inventory.patches(stack)
            with self.assertRaisesRegex(RuntimeError, 'IMAGE_PREVIOUS_RELEASE_IDENTITY_INVALID'):
                m.release_cleanup_old_images(TAG, REVISION)
        remove.assert_not_called()

    def test_immutable_removal_has_no_force_or_parent_pruning_and_public_scope_stays_fixed(self):
        with patch.object(m, 'HELPER'), patch.object(m.Path, 'stat', return_value=MagicMock(st_mode=stat.S_IFREG)), \
                patch.object(m.os, 'access', return_value=True), \
                patch.object(m.subprocess, 'run', return_value=MagicMock(returncode=0)) as command:
            m._image_remove_command(image_id('9'), timeout_seconds=12)
        self.assertEqual(command.call_args.args[0][1:], ['image', 'rm', '--no-prune', image_id('9')])
        with self.assertRaisesRegex(RuntimeError, 'IMAGE_REMOVE_ARGUMENT_INVALID'):
            m._image_remove_id(image_id('9'), timeout_seconds=12)

    def test_maintenance_failure_after_receipt_does_not_stop_healthy_release(self):
        ops = MagicMock(); ops.database_required = False
        ops.cleanup_old_images.side_effect = RuntimeError('maintenance deferred')
        with patch('sys.stdout', new_callable=io.StringIO):
            m.deployment_flow(ops, preflight_source={})
        ops.write_receipt.assert_called_once()
        ops.quiesce_for_manual_recovery.assert_not_called()
        ops.restore_exact_source.assert_not_called()


if __name__ == '__main__':
    unittest.main(verbosity=2)
