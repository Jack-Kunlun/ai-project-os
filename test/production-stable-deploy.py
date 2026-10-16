#!/usr/bin/env python3
"""Offline behavior tests for the reusable stable release gate."""
from __future__ import annotations

import importlib.util
import io
import hashlib
import json
import os
from pathlib import Path
from contextlib import redirect_stdout
import signal
import stat
import subprocess
import sys
import tarfile
import tempfile
import textwrap
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
TARGET_TAG = 'v1.0.2'
SCRIPT = ROOT / 'deploy/production/ai-project-os-release-stable.py'
sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location('stable_deployer_under_test', SCRIPT)
DEPLOYER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DEPLOYER)
ARTIFACT_PATH = ROOT / 'deploy/production/ai_project_os_backup_artifact.py'
ARTIFACT_SPEC = importlib.util.spec_from_file_location('stable_artifact_under_test', ARTIFACT_PATH)
ARTIFACT = importlib.util.module_from_spec(ARTIFACT_SPEC)
ARTIFACT_SPEC.loader.exec_module(ARTIFACT)


class FakeDeployment:
    def __init__(self, failure=None, database_required=True):
        self.failure = failure
        self.database_required = database_required
        self.events = []

    def _step(self, name, result=None):
        self.events.append(name)
        if self.failure == name:
            raise RuntimeError('injected_' + name)
        return result

    def preflight(self): return self._step('preflight', {'source': 'exact-v1.0.0'})
    def checkout_target(self): self._step('checkout')
    def build_target_images(self): return self._step('build', {'images': 'pinned'})
    def revalidate_source(self, _source): self._step('revalidate')
    def stop_nginx(self): self._step('stop_nginx')
    def stop_source_writers(self, _source): self._step('stop_writers')
    def create_and_validate_backup(self, _source): return self._step('backup', {'backup': 'verified'})
    def restore_drill(self, _source, _backup, _images): self._step('restore')
    def install_and_test_target_nginx(self): self._step('nginx_candidate')
    def migrate(self, _images): self._step('migrate')
    def reconcile(self, _images): self._step('reconcile')
    def start_target_writers(self, _images): self._step('start_target')
    def verify_target(self, _source, _backup, _images): self._step('health')
    def write_receipt(self, _source, _backup, _images): self._step('receipt')
    def quiesce_for_manual_recovery(self, _source): self._step('quiesce')
    def restore_exact_source(self, _source): self._step('restore_source')
    def cleanup_restore_drill(self): self._step('cleanup_restore')
    def cleanup_pin_file(self): self._step('cleanup_pin')


class DeploymentMethodTests(unittest.TestCase):
    def signup_snapshot(self, counts=None):
        return {
            'counts': counts or {'AppUser': 1},
            'activeOffers': [{
                'offerVersion': 'signup-500k-v1', 'amount': 500000,
                'validForDays': 30, 'eligibilityKey': 'verified_identity_v1',
            }],
            'activeEmbeddingRoutes': [{'id': 'embedding-route-v1', 'version': 1}],
        }

    def test_source_requires_current_default_signup_policy(self):
        valid = self.signup_snapshot()
        DEPLOYER.validate_default_signup_policy(valid)
        invalid_offers = (
            [],
            valid['activeOffers'] + valid['activeOffers'],
            {'offerVersion': 'signup-500k-v1', 'amount': 500001,
             'validForDays': 30, 'eligibilityKey': 'verified_identity_v1'},
            {'offerVersion': 'signup-500k-v1', 'amount': 500000,
             'validForDays': 31, 'eligibilityKey': 'verified_identity_v1'},
            {'offerVersion': 'signup-500k-v1', 'amount': 500000,
             'validForDays': 30, 'eligibilityKey': 'unverified_identity_v1'},
        )
        for offers in invalid_offers:
            snapshot = dict(valid)
            snapshot['activeOffers'] = offers if isinstance(offers, list) else [offers]
            with self.subTest(offers=offers), self.assertRaisesRegex(
                RuntimeError, 'STABLE_ACTIVE_SIGNUP_POLICY_INVALID',
            ):
                DEPLOYER.validate_default_signup_policy(snapshot)

    def test_build_target_images_builds_each_service_in_fixed_sequence(self):
        services = ('principal-bootstrap', 'migrate', 'reconcile', 'app', 'worker', 'git-worker')
        service_images = {
            service: 'ai-project-os-' + service for service in services
        }
        ids = {service: 'sha256:' + format(index + 1, '064x')
               for index, service in enumerate(services)}
        reverse_images = {image: service for service, image in service_images.items()}
        compose_calls = []

        def fake_compose(*args, **kwargs):
            compose_calls.append((args, kwargs))
            return ''

        def fake_docker(*args, **_kwargs):
            if args[:2] == ('image', 'inspect') and args[2] == '--format':
                return ids[reverse_images[args[4]]]
            if args[:2] == ('image', 'inspect'):
                return json.dumps([{'Config': {'Labels': {
                    'org.opencontainers.image.version': DEPLOYER.version_text(TARGET_TAG),
                }}}])
            self.fail('unexpected docker call: ' + repr(args))

        class FixtureHelper:
            @staticmethod
            def atomic_write(_path, _content, _mode):
                return None

            @staticmethod
            def trusted(_path, _mode=None):
                return None

        host = DEPLOYER.HostDeployment(TARGET_TAG, 'a' * 40)
        with patch.object(DEPLOYER, 'compose', side_effect=fake_compose), \
                patch.object(DEPLOYER, 'docker', side_effect=fake_docker), \
                patch.object(DEPLOYER, 'HELPER', FixtureHelper()):
            result = host.build_target_images()

        builds = [args[1:] for args, _kwargs in compose_calls if args[0] == 'build']
        self.assertEqual(builds, [(service,) for service in services])
        self.assertEqual(tuple(result), services)
        self.assertEqual(host.images, result)

    def test_non_database_release_builds_only_target_writers(self):
        services = ('app', 'worker', 'git-worker')
        service_images = {service: 'ai-project-os-' + service for service in services}
        ids = {service: 'sha256:' + format(index + 1, '064x')
               for index, service in enumerate(services)}
        reverse_images = {image: service for service, image in service_images.items()}
        compose_calls = []

        def fake_compose(*args, **kwargs):
            compose_calls.append((args, kwargs))
            return ''

        def fake_docker(*args, **_kwargs):
            if args[:2] == ('image', 'inspect') and args[2] == '--format':
                return ids[reverse_images[args[4]]]
            if args[:2] == ('image', 'inspect'):
                return json.dumps([{'Config': {'Labels': {
                    'org.opencontainers.image.version': DEPLOYER.version_text(TARGET_TAG),
                }}}])
            self.fail('unexpected docker call: ' + repr(args))

        class FixtureHelper:
            @staticmethod
            def atomic_write(_path, _content, _mode): return None
            @staticmethod
            def trusted(_path, _mode=None): return None

        host = DEPLOYER.HostDeployment(TARGET_TAG, 'a' * 40)
        host.database_required = False
        with patch.object(DEPLOYER, 'compose', side_effect=fake_compose), \
                patch.object(DEPLOYER, 'docker', side_effect=fake_docker), \
                patch.object(DEPLOYER, 'HELPER', FixtureHelper()):
            result = host.build_target_images()

        builds = [args[1:] for args, _kwargs in compose_calls if args[0] == 'build']
        self.assertEqual(builds, [('app',), ('worker',), ('git-worker',)])
        self.assertEqual(tuple(result), services)

    def test_revalidate_source_allows_live_data_counts_to_change(self):
        services = ('app', 'worker', 'git-worker')
        source_snapshot = {
            'counts': {'AppUser': 10, 'PlatformTokenGrant': 20},
            'activeOffers': [], 'activeEmbeddingRoutes': [],
        }
        current_snapshot = {
            'counts': {'AppUser': 11, 'PlatformTokenGrant': 22},
            'activeOffers': [], 'activeEmbeddingRoutes': [],
        }
        source = {
            'tag': TARGET_TAG, 'version': DEPLOYER.version_text(TARGET_TAG), 'postgres_id': 'pg-id',
            'writer_ids': {service: service + '-id' for service in services},
            'writer_images': {service: service + '-image' for service in services},
            'source_manifest': [('20261014000000_source', 'a' * 64)],
            'config_hashes': {'production_env': 'config-hash'},
            'database_snapshot': source_snapshot,
        }
        healthy_state = {'Running': True, 'Paused': False, 'Health': {'Status': 'healthy'}}
        containers = {'postgres': {'Id': 'pg-id'}}
        containers.update({service: {
            'Id': service + '-id', 'Image': service + '-image', 'State': healthy_state,
        } for service in services})

        class FixtureHelper:
            @staticmethod
            def healthy(_version, public=False):
                return {'public': public}

        host = DEPLOYER.HostDeployment(TARGET_TAG, 'b' * 40)
        with patch.object(DEPLOYER, 'fetch_target'), \
                patch.object(DEPLOYER, 'git', return_value=host.target_revision), \
                patch.object(DEPLOYER, 'container', side_effect=lambda name: containers[name]), \
                patch.object(DEPLOYER, 'config_hashes', return_value=source['config_hashes']), \
                patch.object(DEPLOYER, 'migration_ledger'), \
                patch.object(DEPLOYER, 'readonly_database_snapshot', return_value=current_snapshot), \
                patch.object(DEPLOYER, 'validate_default_signup_policy') as strict_policy_mock, \
                patch.object(DEPLOYER, 'HELPER', FixtureHelper()):
            host.revalidate_source(source)

        self.assertEqual(source['database_snapshot'], source_snapshot)
        strict_policy_mock.assert_not_called()

    def test_stop_source_writers_refreshes_data_counts_after_drain(self):
        services = ('app', 'worker', 'git-worker')
        source_snapshot = self.signup_snapshot({'AppUser': 10})
        stopped_snapshot = self.signup_snapshot({'AppUser': 12})
        source = {
            'tag': 'v1.0.0', 'postgres_id': 'pg-id',
            'writer_ids': {service: service + '-id' for service in services},
            'source_manifest': [('20261014000000_source', 'a' * 64)],
            'database_snapshot': source_snapshot,
        }

        class FixtureHelper:
            @staticmethod
            def stopped(_postgres_id):
                return None

        host = DEPLOYER.HostDeployment(TARGET_TAG, 'c' * 40)
        with patch.object(DEPLOYER, 'docker') as docker_mock, \
                patch.object(DEPLOYER, 'migration_ledger'), \
                patch.object(DEPLOYER, 'readonly_database_snapshot', return_value=stopped_snapshot), \
                patch.object(DEPLOYER, 'HELPER', FixtureHelper()):
            host.stop_source_writers(source)

        docker_mock.assert_called_once_with('stop', 'app-id', 'worker-id', 'git-worker-id')
        self.assertEqual(source['database_snapshot'], stopped_snapshot)

    def test_verify_target_checks_live_health_without_stopping_writers_or_requiring_fixed_counts(self):
        services = ('app', 'worker', 'git-worker')
        source_snapshot = self.signup_snapshot({'AppUser': 10})
        current_snapshot = self.signup_snapshot({'AppUser': 15})
        target_nginx = b'target-nginx-config'
        original_nginx_hash = 'b' * 64
        source_hashes = {'production_env': 'env-hash', 'nginx': original_nginx_hash}
        expected_hashes = {'production_env': 'env-hash', 'nginx': DEPLOYER.sha256(target_nginx)}
        images = {service: service + '-target-image' for service in services}
        containers = {
            'postgres': {'Id': 'pg-id'},
        }
        containers.update({service: {
            'Id': service + '-target-id', 'Image': images[service],
            'State': {'Running': True, 'Health': {'Status': 'healthy'}},
        } for service in services})

        class FixtureHelper:
            def __init__(self):
                self.run_calls = []

            def run(self, args):
                self.run_calls.append(args)

            @staticmethod
            def stopped(_postgres_id):
                raise AssertionError('verify_target must not require stopped writers')

        helper = FixtureHelper()
        host = DEPLOYER.HostDeployment(TARGET_TAG, 'd' * 40)
        host.source = {
            'tag': 'v1.0.0', 'postgres_id': 'pg-id',
            'source_manifest': [('source', 'a' * 64)],
            'config_hashes': source_hashes, 'database_snapshot': source_snapshot,
        }
        host.target_manifest = [('target', 'c' * 64)]
        host.target_files = {'nginx': target_nginx}
        host.images = images
        host.nginx_stopped = True
        with tempfile.TemporaryDirectory() as directory:
            nginx_path = Path(directory) / 'nginx.conf'
            nginx_path.write_bytes(target_nginx)
            with patch.object(DEPLOYER, 'NGINX', nginx_path), \
                    patch.object(DEPLOYER, 'container', side_effect=lambda name: containers[name]), \
                    patch.object(DEPLOYER, 'healthy', side_effect=lambda version, public=False: {
                        'version': version, 'public': public,
                    }), \
                    patch.object(DEPLOYER, 'migration_ledger') as ledger_mock, \
                    patch.object(DEPLOYER, 'readonly_database_snapshot', return_value=current_snapshot), \
                    patch.object(DEPLOYER, 'config_hashes', return_value=expected_hashes), \
                    patch.object(DEPLOYER, 'HELPER', helper):
                host.verify_target(host.source, {'backup': 'verified'}, images)

        self.assertEqual(ledger_mock.call_args.args[1], host.target_manifest)
        self.assertEqual(host.target_writer_ids, {
            'app': 'app-target-id', 'worker': 'worker-target-id', 'git-worker': 'git-worker-target-id',
        })
        self.assertEqual(host.target_health['local']['version'], DEPLOYER.version_text(TARGET_TAG))
        self.assertFalse(host.nginx_stopped)
        self.assertIn(['systemctl', 'reload', 'nginx'], helper.run_calls)

    def test_receipt_round_trips_through_source_record_parser(self):
        class FixtureHelper:
            @staticmethod
            def atomic_write(path, content, mode):
                Path(path).write_bytes(content)
                Path(path).chmod(mode)

        target_nginx = b'nginx'
        source = {
            'tag': 'v1.0.0', 'revision': DEPLOYER.INITIAL_SOURCE_REVISION,
            'postgres_id': 'pg-id', 'source_manifest': [('source', 'a' * 64)],
            'config_hashes': {'production_env': 'env-hash'},
            'database_snapshot': self.signup_snapshot(),
        }
        backup = {
            'name': '20261015T010203Z-pre-deploy-to-v1.0.2.ABC123',
            'object': 'cos://backup/archive', 'verified_manifest': 'cos://backup/manifest',
            'sha256': 'e' * 64,
        }
        host = DEPLOYER.HostDeployment(TARGET_TAG, 'f' * 40)
        host.target_manifest = [('target', 'c' * 64)]
        host.target_writer_ids = {'app': 'app-id', 'worker': 'worker-id', 'git-worker': 'git-id'}
        host.target_health = {'local': {'status': 'ok'}, 'public': {'status': 'ok'}}
        host.target_files = {'nginx': target_nginx}
        host.restore_evidence = {
            'source_sha256': 'f' * 64, 'source_migration_count': 143,
            'target_migration_count': 145,
        }
        images = {'app': 'sha256:' + '1' * 64}

        with tempfile.TemporaryDirectory() as directory:
            result_path = Path(directory) / 'receipt'
            with patch.object(DEPLOYER, 'RESULT', result_path), \
                    patch.object(DEPLOYER, 'HELPER', FixtureHelper()), \
                    redirect_stdout(io.StringIO()):
                host.write_receipt(source, backup, images)
            record = DEPLOYER.parse_record(result_path)
            receipt_text = result_path.read_text(encoding='utf-8')

        self.assertEqual(record['status'], 'DEPLOY_OK')
        self.assertEqual(record['tag'], TARGET_TAG)
        self.assertEqual(record['revision'], 'f' * 40)
        self.assertEqual(record['source_tag'], 'v1.0.0')
        self.assertEqual(record['source_revision'], DEPLOYER.INITIAL_SOURCE_REVISION)
        self.assertEqual(json.loads(record['migration_count']), len(host.target_manifest))
        self.assertEqual(json.loads(record['target_writer_ids']), host.target_writer_ids)
        self.assertNotIn('status=', receipt_text)

    def test_no_database_receipt_is_explicit_and_supports_same_release_retry(self):
        class FixtureHelper:
            @staticmethod
            def atomic_write(path, content, mode):
                Path(path).write_bytes(content)
                Path(path).chmod(mode)

        manifest = [('20260901000000_original', 'a' * 64)]
        source = {
            'tag': 'v1.0.0', 'revision': DEPLOYER.INITIAL_SOURCE_REVISION,
            'postgres_id': 'pg-id', 'source_manifest': manifest,
            'config_hashes': {'production_env': 'env-hash'},
            'database_snapshot': self.signup_snapshot(),
        }
        backup = {
            'name': '20261015T010203Z-pre-deploy-to-v1.0.2.ABC123',
            'object': 'cos://backup/archive', 'verified_manifest': 'cos://backup/manifest',
            'sha256': 'e' * 64,
        }
        host = DEPLOYER.HostDeployment(TARGET_TAG, 'f' * 40)
        host.database_required = False
        host.target_manifest = manifest
        host.target_writer_ids = {'app': 'app-id', 'worker': 'worker-id', 'git-worker': 'git-id'}
        host.target_health = {'local': {'status': 'ok'}, 'public': {'status': 'ok'}}
        host.target_files = {'nginx': b'nginx'}
        host.restore_evidence = None

        with tempfile.TemporaryDirectory() as directory:
            result_path = Path(directory) / 'receipt'
            stdout = io.StringIO()
            with patch.object(DEPLOYER, 'RESULT', result_path), \
                    patch.object(DEPLOYER, 'HELPER', FixtureHelper()), \
                    redirect_stdout(stdout):
                host.write_receipt(source, backup, {'app': 'sha256:' + '1' * 64})
            record = DEPLOYER.parse_record(result_path)

        restore = json.loads(record['restore_drill'])
        self.assertEqual(restore, {
            'required': False, 'reason': 'no-database-change',
            'source_migration_count': 1, 'target_migration_count': 1,
        })
        self.assertEqual(record['migration_manifest_sha256'], DEPLOYER.migration_manifest_sha256(manifest))
        self.assertIn('restore=not-required', stdout.getvalue())
        same_release = {
            'tag': TARGET_TAG, 'revision': 'f' * 40,
            'receipt': record, 'source_manifest': manifest,
        }
        line = DEPLOYER.already_current_line(same_release, TARGET_TAG, 'f' * 40)
        self.assertIn('restore=not-required', line)

        malformed = dict(record)
        malformed['restore_drill'] = json.dumps({
            'required': False, 'reason': 'no-database-change',
            'source_migration_count': 1, 'target_migration_count': 2,
        })
        with self.assertRaisesRegex(RuntimeError, 'STABLE_SOURCE_RECEIPT_RESTORE_INVALID'):
            DEPLOYER.validate_source_restore_receipt(malformed, manifest)

class BackupValidationTests(unittest.TestCase):
    def test_backup_receipt_accepts_only_quiesced_stable_backup_in_expected_root(self):
        backup_name = '20261015T043210Z-pre-deploy-to-v1.0.2.a1B2c3'
        object_path = (
            'cos://ai-project-os-backup-17/backups/2026/10/15/'
            + backup_name + '/' + backup_name + '.tar.age'
        )
        fields = {
            'reason': 'pre-deploy-to-v1.0.2',
            'retention_removed': '0',
            'source_quiesced': 'true',
            'source': '/var/backups/ai-project-os/' + backup_name,
            'object': object_path,
            'verified_manifest': object_path.removesuffix('.tar.age') + '.manifest.json',
            'manifest': 'cos://ai-project-os-backup-17/manifests/latest.json',
            'sha256': 'a' * 64,
        }

        def receipt(**overrides):
            complete = {**fields, **overrides}
            return 'BACKUP_OK ' + ' '.join(
                key + '=' + value for key, value in complete.items()
            )

        accepted = DEPLOYER.verify_backup_output(receipt(), TARGET_TAG)
        self.assertEqual(accepted['name'], backup_name)
        self.assertEqual(accepted['object'], object_path)

        old_name = backup_name.replace('v1.0.2', 'v1.0.1')
        with self.assertRaisesRegex(RuntimeError, 'STABLE_BACKUP_SOURCE_INVALID'):
            DEPLOYER.verify_backup_output(receipt(
                source='/var/backups/ai-project-os/' + old_name,
            ), TARGET_TAG)
        with self.assertRaisesRegex(RuntimeError, 'STABLE_BACKUP_OBJECT_INVALID'):
            DEPLOYER.verify_backup_output(
                receipt(object='https://example.invalid/archive.tar.age'), TARGET_TAG,
            )
        with self.assertRaisesRegex(RuntimeError, 'STABLE_BACKUP_SOURCE_INVALID'):
            DEPLOYER.verify_backup_output(receipt(
                source='/tmp/' + backup_name,
            ), TARGET_TAG)
        with self.assertRaisesRegex(RuntimeError, 'STABLE_BACKUP_RECEIPT_INVALID'):
            DEPLOYER.verify_backup_output(receipt(source_quiesced='false'), TARGET_TAG)

    def test_local_backup_accepts_dot_slash_email_member_and_streams_large_hashes(self):
        backup_name = '20261015T010203Z-pre-deploy-to-v1.0.2.ABC123'
        object_path = (
            'cos://ai-project-os-backup-1/backups/2026/10/15/'
            + backup_name + '/' + backup_name + '.tar.age'
        )
        verified_manifest = object_path.removesuffix('.tar.age') + '.manifest.json'
        latest_manifest = 'cos://ai-project-os-backup-1/manifests/latest.json'
        current_email = b'EMAIL_AUTH_ENABLED=true\n'

        class FixtureHelper:
            @staticmethod
            def trusted(checked_path, mode=None):
                # Preserve the pinned helper's regular-file mode contract;
                # only root ownership/ancestor checks are bypassed in fixtures.
                info = Path(checked_path).lstat()
                if stat.S_ISLNK(info.st_mode):
                    raise RuntimeError('V074_HOST_SYMLINK_REJECTED')
                if mode is not None and not (
                    stat.S_ISREG(info.st_mode) and stat.S_IMODE(info.st_mode) == mode
                ):
                    raise RuntimeError('V074_HOST_FILE_MODE_INVALID')

        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / backup_name
            path.mkdir(mode=0o700)
            for name in DEPLOYER.BACKUP_REQUIRED_FILES:
                if name in {'SHA256SUMS', '.cos-upload-verified', 'host-config.tar.gz'}:
                    continue
                file_path = path / name
                with file_path.open('wb') as stream:
                    stream.truncate(8 * 1024 * 1024 if name in {'postgres.dump', 'uploads.tar.gz'} else 32)
                file_path.chmod(0o600)

            host_config = path / 'host-config.tar.gz'
            with tarfile.open(host_config, 'w:gz') as archive:
                files = dict.fromkeys(ARTIFACT.HOST_CONFIG_FILES, b'fixture\n')
                files['etc/ai-project-os/email-auth.env'] = current_email
                for member_name, content in files.items():
                    member = tarfile.TarInfo('./' + member_name)
                    member.size = len(content)
                    archive.addfile(member, io.BytesIO(content))
            host_config.chmod(0o600)

            metadata = {
                'format_version': '2', 'reason': 'pre-deploy-to-v1.0.2',
                'compose_project': 'ai-project-os', 'app_version': '1.0.0',
                'writers_quiesced': 'true', 'source_quiesced': 'true',
                'backup_name': backup_name,
            }
            (path / 'backup-metadata.env').write_text(
                ''.join(key + '=' + value + '\n' for key, value in metadata.items()),
                encoding='utf-8',
            )
            (path / '.cos-upload-verified').write_text(
                'status=COS_UPLOAD_VERIFIED\n'
                + 'archive_object=' + object_path + '\n'
                + 'manifest_object=' + verified_manifest + '\n'
                + 'latest_manifest_object=' + latest_manifest + '\n'
                + 'archive_sha256=' + 'a' * 64 + '\n',
                encoding='utf-8',
            )
            names = DEPLOYER.BACKUP_REQUIRED_FILES - {'SHA256SUMS', '.cos-upload-verified'}
            (path / 'SHA256SUMS').write_text(
                ''.join(DEPLOYER.hash_file(path / name) + '  ' + name + '\n'
                        for name in sorted(names)),
                encoding='ascii',
            )
            for name in DEPLOYER.BACKUP_REQUIRED_FILES:
                (path / name).chmod(0o600)

            backup = {
                'name': backup_name, 'path': path, 'object': object_path,
                'verified_manifest': verified_manifest, 'manifest': latest_manifest,
                'sha256': 'a' * 64,
            }
            original_read_bytes = Path.read_bytes

            def reject_large_reads(file_path):
                if file_path.name in {'postgres.dump', 'uploads.tar.gz'}:
                    raise AssertionError('large backup artifact read into memory')
                return original_read_bytes(file_path)

            with patch.object(DEPLOYER, 'HELPER', FixtureHelper()), \
                    patch.object(DEPLOYER, 'read_backup_artifact_helper', return_value=ARTIFACT), \
                    patch.object(Path, 'read_bytes', reject_large_reads):
                DEPLOYER.validate_local_backup(backup, current_email, TARGET_TAG, '1.0.0')

                for mode in (0o750, 0o755, 0o777):
                    path.chmod(mode)
                    with self.subTest(mode=oct(mode)), self.assertRaisesRegex(
                        RuntimeError, 'STABLE_BACKUP_DIRECTORY_MODE_INVALID',
                    ):
                        DEPLOYER.validate_local_backup(backup, current_email, TARGET_TAG, '1.0.0')
                path.chmod(0o700)

                regular = Path(temporary) / 'not-a-directory'
                regular.write_text('fixture')
                regular.chmod(0o700)
                with self.assertRaisesRegex(RuntimeError, 'STABLE_BACKUP_DIRECTORY_MODE_INVALID'):
                    DEPLOYER.validate_local_backup(
                        dict(backup, path=regular), current_email, TARGET_TAG, '1.0.0',
                    )

                linked = Path(temporary) / 'linked-backup'
                linked.symlink_to(path, target_is_directory=True)
                with self.assertRaisesRegex(RuntimeError, 'V074_HOST_SYMLINK_REJECTED'):
                    DEPLOYER.validate_local_backup(
                        dict(backup, path=linked), current_email, TARGET_TAG, '1.0.0',
                    )

                dump = path / 'postgres.dump'
                dump.chmod(0o644)
                with self.assertRaisesRegex(RuntimeError, 'V074_HOST_FILE_MODE_INVALID'):
                    DEPLOYER.validate_local_backup(backup, current_email, TARGET_TAG, '1.0.0')
                dump.chmod(0o600)

            expected = hashlib.sha256()
            zero_chunk = bytes(1024 * 1024)
            for _ in range(8):
                expected.update(zero_chunk)
            self.assertEqual(DEPLOYER.hash_file(path / 'postgres.dump'), expected.hexdigest())


class SafeFailureCodeTests(unittest.TestCase):
    def test_known_codes_are_preserved_without_exposing_exception_details(self):
        for error, expected in (
            (RuntimeError('STABLE_BACKUP_LAYOUT_INVALID'), 'STABLE_BACKUP_LAYOUT_INVALID'),
            (RuntimeError('V074_HOST_FILE_MODE_INVALID'), 'STABLE_PINNED_HELPER_HOST_FILE_MODE_INVALID'),
            (SystemExit('BACKUP_HOST_CONFIG_LAYOUT_INVALID'), 'STABLE_BACKUP_ARTIFACT_HOST_CONFIG_LAYOUT_INVALID'),
            (subprocess.TimeoutExpired(['command', 'fixture-secret'], 10, output='fixture-secret'),
             'STABLE_COMMAND_TIMEOUT'),
            (RuntimeError('STABLE_FAILURE\nfixture-secret'), 'STABLE_UNEXPECTED_FAILURE'),
            (ValueError('fixture-secret'), 'STABLE_UNEXPECTED_FAILURE'),
            (SystemExit(1), 'STABLE_UNEXPECTED_FAILURE'),
        ):
            with self.subTest(expected=expected):
                code = DEPLOYER.safe_failure_code(error)
                self.assertEqual(code, expected)
                self.assertNotIn('fixture-secret', code)


class GitManifestTests(unittest.TestCase):
    class FixtureHelper:
        @staticmethod
        def trusted(_path, _mode=None):
            return None

    def git(self, repository, *args, input_bytes=None, env=None):
        result = subprocess.run(
            [DEPLOYER.BINARIES['git'], '-C', str(repository), *args],
            input=input_bytes, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            check=False, env=env,
        )
        self.assertEqual(result.returncode, 0, result.stderr.decode('utf-8', errors='replace'))
        return result.stdout.decode('utf-8').rstrip('\n')

    def fixture_revision(self, repository, root_entries, lock_mode='100644', lock_type='blob'):
        source_lock = self.git(
            repository, 'show', DEPLOYER.INITIAL_SOURCE_REVISION + ':prisma/migrations/migration_lock.toml',
        ).encode('utf-8') + b'\n'
        lock_id = self.git(repository, 'hash-object', '-w', '--stdin', input_bytes=source_lock)
        root_entries = [(lock_mode, lock_type, lock_id, 'migration_lock.toml'), *root_entries]
        migration_tree = self.git(repository, 'mktree', input_bytes=b''.join(
            f'{mode} {kind} {object_id}\t{name}\n'.encode()
            for mode, kind, object_id, name in root_entries
        ))
        prisma_tree = self.git(repository, 'mktree', input_bytes=(
            f'040000 tree {migration_tree}\tmigrations\n'.encode()
        ))
        root_tree = self.git(repository, 'mktree', input_bytes=(
            f'040000 tree {prisma_tree}\tprisma\n'.encode()
        ))
        return root_tree

    def test_actual_source_and_candidate_git_manifests_include_lock_blob_and_exact_delta(self):
        with patch.object(DEPLOYER, 'ROOT', ROOT), patch.object(DEPLOYER, 'HELPER', self.FixtureHelper()):
            source = DEPLOYER.git_manifest(DEPLOYER.INITIAL_SOURCE_REVISION)
            target = DEPLOYER.git_manifest('HEAD')
            working_tree = DEPLOYER.source_manifest(ROOT)
            DEPLOYER.validate_manifest_delta(source, target)

        self.assertEqual(len(source), 143)
        self.assertEqual(len(target), 146)
        self.assertEqual(working_tree, target)
        self.assertEqual(target[:len(source)], source)
        self.assertEqual([name for name, _ in target], sorted(name for name, _ in target))

    def test_actual_worktree_release_identity_passes_target_preflight(self):
        candidate_tag = 'v' + json.loads((ROOT / 'package.json').read_text())['version']
        worktree_paths = {
            'package.json', 'src/lib/version.ts', 'Dockerfile', f'docs/releases/{candidate_tag}.md',
            'deploy/production/ai-project-os-release-stable.py',
            'deploy/production/ai-project-os-backup',
            'deploy/production/ai_project_os_backup_artifact.py',
            'deploy/production/ai-project-os-actions-gateway',
            'deploy/production/ai-project-os-deploy.sudoers',
        }
        original_git_blob = DEPLOYER.git_blob

        def candidate_blob(revision, path):
            if revision == 'HEAD' and path in worktree_paths:
                return (ROOT / path).read_bytes()
            return original_git_blob(revision, path)

        with patch.object(DEPLOYER, 'ROOT', ROOT), \
                patch.object(DEPLOYER, 'HELPER', self.FixtureHelper()), \
                patch.object(DEPLOYER, 'git_blob', side_effect=candidate_blob), \
                patch.object(DEPLOYER, 'validate_tooling_bytes'):
            source = DEPLOYER.git_manifest(DEPLOYER.INITIAL_SOURCE_REVISION)
            target, files = DEPLOYER.validate_target_tree('HEAD', source, candidate_tag)

        self.assertEqual(len(target), 146)
        self.assertIn('v[1-9][0-9]*', files['backup'].decode('utf-8'))
        self.assertIn('ai-project-os-release-stable.py', files['deployer'].decode('utf-8'))

    def test_git_manifest_rejects_unexpected_blob_symlink_and_missing_migration_sql(self):
        with tempfile.TemporaryDirectory() as temporary:
            repository = Path(temporary) / 'repo'
            repository.mkdir()
            self.git(repository, 'init', '-q')
            self.git(repository, 'fetch', '--quiet', str(ROOT), DEPLOYER.INITIAL_SOURCE_REVISION)
            with patch.object(DEPLOYER, 'ROOT', repository), \
                    patch.object(DEPLOYER, 'HELPER', self.FixtureHelper()):
                unexpected = self.git(repository, 'hash-object', '-w', '--stdin', input_bytes=b'other')
                bad_blob_revision = self.fixture_revision(repository, [
                    ('100644', 'blob', unexpected, 'unexpected.txt'),
                ])
                with self.assertRaisesRegex(RuntimeError, 'STABLE_MIGRATION_NAME_INVALID'):
                    DEPLOYER.git_manifest(bad_blob_revision)

                symlink_revision = self.fixture_revision(repository, [
                    ('120000', 'blob', unexpected, '20261015030000_symlink'),
                ])
                with self.assertRaisesRegex(RuntimeError, 'STABLE_MIGRATION_ENTRY_TYPE_INVALID'):
                    DEPLOYER.git_manifest(symlink_revision)

                wrong_lock_type_revision = self.fixture_revision(
                    repository, [], lock_mode='120000',
                )
                with self.assertRaisesRegex(RuntimeError, 'STABLE_MIGRATION_LOCK_INVALID'):
                    DEPLOYER.git_manifest(wrong_lock_type_revision)

                other_sql = self.git(repository, 'hash-object', '-w', '--stdin', input_bytes=b'-- no migration')
                directory_tree = self.git(repository, 'mktree', input_bytes=(
                    f'100644 blob {other_sql}\tother.sql\n'.encode()
                ))
                missing_sql_revision = self.fixture_revision(repository, [
                    ('040000', 'tree', directory_tree, '20261015030000_missing_sql'),
                ])
                with self.assertRaisesRegex(RuntimeError, 'STABLE_MIGRATION_SQL_LAYOUT_INVALID'):
                    DEPLOYER.git_manifest(missing_sql_revision)

                wrong_lock = self.git(repository, 'hash-object', '-w', '--stdin',
                                      input_bytes=b'provider = "sqlite"\n')
                wrong_lock_tree = self.git(repository, 'mktree', input_bytes=(
                    f'100644 blob {wrong_lock}\tmigration_lock.toml\n'.encode()
                ))
                prisma_tree = self.git(repository, 'mktree', input_bytes=(
                    f'040000 tree {wrong_lock_tree}\tmigrations\n'.encode()
                ))
                root_tree = self.git(repository, 'mktree', input_bytes=(
                    f'040000 tree {prisma_tree}\tprisma\n'.encode()
                ))
                with self.assertRaisesRegex(RuntimeError, 'STABLE_MIGRATION_LOCK_INVALID'):
                    DEPLOYER.git_manifest(root_tree)

    def test_helper_accepts_only_trusted_public_modes_without_creating_bytecode_cache(self):
        child = textwrap.dedent(r'''
            import importlib.util, os, pathlib, shutil, stat, sys, tempfile
            tool = pathlib.Path(sys.argv[1])
            helper_source = pathlib.Path(sys.argv[2])
            artifact_source = pathlib.Path(sys.argv[3])
            sys.dont_write_bytecode = True
            spec = importlib.util.spec_from_file_location("deployer_fixture", tool)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            with tempfile.TemporaryDirectory() as temporary:
                for mode in (0o600, 0o644, 0o700):
                    root = pathlib.Path(temporary) / format(mode, "o")
                    helper = root / module.HELPER_SOURCE
                    helper.parent.mkdir(parents=True)
                    shutil.copyfile(helper_source, helper)
                    helper.chmod(mode)
                    module.ROOT = root
                    module.trusted = lambda *_args, **_kwargs: None
                    sys.dont_write_bytecode = False
                    if mode in (0o600, 0o644):
                        module.load_helper()
                        assert sys.dont_write_bytecode is True
                    else:
                        try:
                            module.load_helper()
                        except RuntimeError as error:
                            assert str(error) == "STABLE_PINNED_HELPER_MODE_INVALID"
                        else:
                            raise AssertionError("unsupported helper mode admitted")
                    assert not helper.parent.joinpath("__pycache__").exists()
                    if mode in (0o600, 0o644):
                        artifact = helper.parent / "ai_project_os_backup_artifact.py"
                        shutil.copyfile(artifact_source, artifact)
                        artifact.chmod(0o755)
                        module.ARTIFACT_HELPER = artifact
                        module.HELPER = type("Helper", (), {
                            "trusted": staticmethod(lambda *_args, **_kwargs: None),
                        })()
                        sys.dont_write_bytecode = False
                        module.read_backup_artifact_helper()
                        assert sys.dont_write_bytecode is True
                        assert not helper.parent.joinpath("__pycache__").exists()
            print("HELPER_MODE_AND_BYTECODE_OK")
        ''')
        environment = os.environ.copy()
        environment.pop('PYTHONDONTWRITEBYTECODE', None)
        environment.pop('PYTHONPYCACHEPREFIX', None)
        result = subprocess.run(
            [sys.executable, '-c', child, str(SCRIPT), str(ROOT / DEPLOYER.HELPER_SOURCE),
             str(ARTIFACT_PATH)],
            cwd=ROOT, env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), 'HELPER_MODE_AND_BYTECODE_OK')


class ReleaseRiskClassificationTests(unittest.TestCase):
    def create_repository(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        repository = Path(temporary.name)
        subprocess.run(['git', '-C', str(repository), 'init', '-q'], check=True)
        files = {
            'README.md': '# Product\n',
            'package.json': '{\n  "name": "fixture",\n  "version": "1.0.0",\n  "private": true\n}\n',
            'src/lib/version.ts': 'export const APP_VERSION = "1.0.0" as const;\n',
            'Dockerfile': 'LABEL org.opencontainers.image.version="1.0.0"\n',
            'src/components/status-card.tsx': 'export function StatusCard() { return null; }\n',
            'src/app/dashboard/dashboard-client.tsx': '"use client"; export function DashboardClient() { return null; }\n',
            'src/app/dashboard/page.tsx': 'export default function Page() { return null; }\n',
            'test/status-card.test.ts': 'export {};\n',
            'test/dashboard-client.test.ts': 'export {};\n',
            'docs/releases/v1.0.0.md': '# v1.0.0 — Stable release\n',
            'docs/account-security.md': '# Account security guidance\n',
            'src/app/auth/login.css': '.login { color: black; }\n',
            'public/register.png': 'registration artwork',
            'src/styles.css': 'body { color: black; }\n',
            'public/brand.png': 'base bitmap',
        }
        for path, content in files.items():
            target = repository / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding='utf-8')
        subprocess.run(['git', '-C', str(repository), 'add', '-A'], check=True)
        environment = {
            **os.environ,
            'GIT_AUTHOR_NAME': 'Stable test', 'GIT_AUTHOR_EMAIL': 'stable@example.invalid',
            'GIT_COMMITTER_NAME': 'Stable test', 'GIT_COMMITTER_EMAIL': 'stable@example.invalid',
        }
        subprocess.run(['git', '-C', str(repository), 'commit', '-qm', 'source'],
                       env=environment, check=True)
        source = subprocess.check_output(
            ['git', '-C', str(repository), 'rev-parse', 'HEAD'], text=True,
        ).strip()
        return repository, source, environment

    def commit_target(self, repository, environment, message='target'):
        subprocess.run(['git', '-C', str(repository), 'add', '-A'], check=True)
        subprocess.run(['git', '-C', str(repository), 'commit', '-qm', message],
                       env=environment, check=True)
        return subprocess.check_output(
            ['git', '-C', str(repository), 'rev-parse', 'HEAD'], text=True,
        ).strip()

    def test_low_accepts_only_document_styles_bitmap_and_exact_version_deltas(self):
        repository, source, environment = self.create_repository()
        (repository / 'docs/releases/v1.0.1.md').write_text('# v1.0.1 — Stable release\n', encoding='utf-8')
        (repository / 'src/styles.css').write_text('body { color: navy; }\n', encoding='utf-8')
        (repository / 'public/brand.png').write_bytes(b'updated bitmap')
        (repository / 'docs/account-security.md').write_text(
            '# Updated account security guidance\n', encoding='utf-8',
        )
        (repository / 'src/app/auth/login.css').write_text(
            '.login { color: navy; }\n', encoding='utf-8',
        )
        (repository / 'public/register.png').write_bytes(b'updated registration artwork')
        (repository / 'package.json').write_text(
            '{\n  "name": "fixture",\n  "version": "1.0.1",\n  "private": true\n}\n',
            encoding='utf-8',
        )
        (repository / 'src/lib/version.ts').write_text(
            'export const APP_VERSION = "1.0.1" as const;\n', encoding='utf-8',
        )
        (repository / 'Dockerfile').write_text(
            'LABEL org.opencontainers.image.version="1.0.1"\n', encoding='utf-8',
        )
        target = self.commit_target(repository, environment)

        classification = DEPLOYER.classify_release_risk(repository, source, target)

        self.assertEqual(classification['risk'], 'low')
        self.assertFalse(classification['databaseRequired'])
        self.assertFalse(classification['browserRequired'])
        self.assertFalse(classification['coverageRequired'])

    def test_medium_accepts_components_and_matching_client_tests_only(self):
        repository, source, environment = self.create_repository()
        (repository / 'src/components/status-card.tsx').write_text(
            'export function StatusCard() { return <span>Ready</span>; }\n', encoding='utf-8',
        )
        (repository / 'test/status-card.test.ts').write_text('export const checks = 1;\n', encoding='utf-8')
        (repository / 'src/app/dashboard/dashboard-client.tsx').write_text(
            '"use client"; export function DashboardClient() { return <span>Ready</span>; }\n',
            encoding='utf-8',
        )
        (repository / 'test/dashboard-client.test.ts').write_text('export const checks = 2;\n', encoding='utf-8')
        (repository / 'public/status-icon.svg').write_text('<svg/>\n', encoding='utf-8')
        target = self.commit_target(repository, environment)

        classification = DEPLOYER.classify_release_risk(repository, source, target)

        self.assertEqual(classification['risk'], 'medium')
        self.assertFalse(classification['databaseRequired'])
        self.assertTrue(classification['browserRequired'])
        self.assertTrue(classification['coverageRequired'])

    def test_app_server_pages_sensitive_paths_and_unmatched_tests_are_high(self):
        cases = (
            ('src/app/dashboard/page.tsx', 'export default function Page() { return <main />; }\n'),
            ('src/app/register/register-client.tsx', '"use client"; export function RegisterClient() { return null; }\n'),
            ('src/components/profile-panel.tsx', 'export function ProfilePanel() { return null; }\n'),
            ('src/lib/personal-knowledge-semantic-service.ts', 'export const change = true;\n'),
            ('test/unmatched.test.ts', 'export const change = true;\n'),
            ('scripts/maintenance.py', 'print("change")\n'),
            ('docs/AGENTS.md', '# Modified instructions\n'),
            ('package-lock.json', '{"lockfileVersion":3}\n'),
            ('package.json', '{\n  "name": "fixture",\n  "version": "1.0.0",\n  "private": true,\n  "scripts": {"build": "custom"}\n}\n'),
        )
        for path, content in cases:
            with self.subTest(path=path):
                repository, source, environment = self.create_repository()
                target_path = repository / path
                target_path.parent.mkdir(parents=True, exist_ok=True)
                target_path.write_text(content, encoding='utf-8')
                target = self.commit_target(repository, environment)
                classification = DEPLOYER.classify_release_risk(repository, source, target)
                self.assertEqual(classification['risk'], 'high')
                self.assertTrue(classification['databaseRequired'])
                self.assertTrue(classification['browserRequired'])
                self.assertTrue(classification['coverageRequired'])

    def test_classifier_fails_high_for_missing_git_metadata_or_nonancestor(self):
        repository, source, environment = self.create_repository()
        (repository / 'README.md').write_text('# Product changed\n', encoding='utf-8')
        target = self.commit_target(repository, environment)

        missing = DEPLOYER.classify_release_risk(repository, 'f' * 40, target)
        nonancestor = DEPLOYER.classify_release_risk(repository, target, source)

        self.assertEqual(missing['risk'], 'high')
        self.assertEqual(nonancestor['risk'], 'high')
        self.assertTrue(missing['databaseRequired'])


class StableSemVerAndManifestTests(unittest.TestCase):
    def test_canonical_stable_semver_is_forward_only_and_exact_source_is_required(self):
        DEPLOYER.validate_transition(
            'v1.0.0', DEPLOYER.INITIAL_SOURCE_REVISION, TARGET_TAG, 'a' * 40,
        )
        for tag in ('v1.0.3', 'v1.1.0', 'v2.0.0'):
            DEPLOYER.stable_version(tag)
        with self.assertRaisesRegex(RuntimeError, 'STABLE_TARGET_NOT_FORWARD_STABLE_RELEASE'):
            DEPLOYER.validate_transition(TARGET_TAG, 'b' * 40, 'v1.0.1', 'c' * 40)
        for values in (
            ('v0.8.0', DEPLOYER.INITIAL_SOURCE_REVISION, TARGET_TAG, 'a' * 40),
            ('v1.0.0', 'b' * 40, TARGET_TAG, 'a' * 40),
            ('v1.0.0', DEPLOYER.INITIAL_SOURCE_REVISION, 'v1.0.0', 'a' * 40),
            ('v1.0.0', DEPLOYER.INITIAL_SOURCE_REVISION, TARGET_TAG, 'a' * 39),
            ('v1.0.0', DEPLOYER.INITIAL_SOURCE_REVISION, 'v1.0.3-rc.1', 'a' * 40),
            ('v1.0.0', DEPLOYER.INITIAL_SOURCE_REVISION, 'v01.0.3', 'a' * 40),
            ('v1.0.0', DEPLOYER.INITIAL_SOURCE_REVISION, 'v1.00.3', 'a' * 40),
        ):
            with self.subTest(values=values), self.assertRaises(RuntimeError):
                DEPLOYER.validate_transition(*values)

    def test_stable_source_receipt_requires_prior_annotated_tag_revision_and_ancestry(self):
        record = {'source_tag': 'v1.0.0', 'source_revision': DEPLOYER.INITIAL_SOURCE_REVISION}
        current_revision = 'a' * 40

        def valid_git(args):
            if args[:2] == ['cat-file', '-t']:
                return 'tag'
            if args[:1] == ['rev-parse']:
                return DEPLOYER.INITIAL_SOURCE_REVISION
            if args[:1] == ['merge-base']:
                return ''
            self.fail('unexpected git call: ' + repr(args))

        with patch.object(DEPLOYER, 'git', side_effect=valid_git):
            DEPLOYER.verify_prior_stable_tag(record, current_revision)

        with patch.object(DEPLOYER, 'git', side_effect=lambda args: (
                'tag' if args[:2] == ['cat-file', '-t'] else 'b' * 40)):
            with self.assertRaisesRegex(RuntimeError, 'STABLE_PRIOR_SOURCE_TAG_REVISION_MISMATCH'):
                DEPLOYER.verify_prior_stable_tag(record, current_revision)

        with patch.object(DEPLOYER, 'git', side_effect=lambda args: (
                'commit' if args[:2] == ['cat-file', '-t'] else '')):
            with self.assertRaisesRegex(RuntimeError, 'STABLE_PRIOR_SOURCE_TAG_NOT_ANNOTATED'):
                DEPLOYER.verify_prior_stable_tag(record, current_revision)

        with patch.object(DEPLOYER, 'git', side_effect=lambda args: (
                'tag' if args[:2] == ['cat-file', '-t'] else
                DEPLOYER.INITIAL_SOURCE_REVISION if args[:1] == ['rev-parse'] else
                (_ for _ in ()).throw(RuntimeError('not ancestor')))):
            with self.assertRaisesRegex(RuntimeError, 'STABLE_RELEASE_ANCESTRY_INVALID'):
                DEPLOYER.verify_prior_stable_tag(record, current_revision)

    def test_manifest_accepts_zero_or_valid_future_additions_but_preserves_exact_prefix(self):
        source = [(f'20260901000000_migration_{index:03}', f'{index:064x}')
                  for index in range(DEPLOYER.MINIMUM_MIGRATIONS)]
        target = source + [('20261015030000_new_future_migration', 'a' * 64)]
        DEPLOYER.validate_manifest_delta(source, source)
        DEPLOYER.validate_manifest_delta(source, target)
        changed = list(target)
        changed[20] = (changed[20][0], 'c' * 64)
        with self.assertRaisesRegex(RuntimeError, 'STABLE_MIGRATION_BASELINE_CHANGED'):
            DEPLOYER.validate_manifest_delta(source, changed)
        with self.assertRaisesRegex(RuntimeError, 'STABLE_MIGRATION_COUNT_INVALID'):
            DEPLOYER.validate_manifest_delta(source[:-1], target)
        malformed_name = source + [('20261015030000_BadName', 'b' * 64)]
        with self.assertRaisesRegex(RuntimeError, 'STABLE_MIGRATION_MANIFEST_INVALID'):
            DEPLOYER.validate_manifest_delta(source, malformed_name)
        unordered = source + [
            ('20261015040000_zed', 'a' * 64),
            ('20261015030000_earlier', 'b' * 64),
        ]
        with self.assertRaisesRegex(RuntimeError, 'STABLE_MIGRATION_ORDER_INVALID'):
            DEPLOYER.validate_manifest_delta(source, unordered)

    def test_source_receipt_accepts_only_the_existing_deploy_marker_and_key_values(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'receipt'
            path.write_text('DEPLOY_OK\ntag=v1.0.0\nrevision=' + DEPLOYER.INITIAL_SOURCE_REVISION + '\n')
            self.assertEqual(DEPLOYER.parse_record(path), {
                'status': 'DEPLOY_OK', 'tag': 'v1.0.0', 'revision': DEPLOYER.INITIAL_SOURCE_REVISION,
            })
            path.write_text('FAILED\ntag=v1.0.0\nrevision=' + DEPLOYER.INITIAL_SOURCE_REVISION + '\n')
            with self.assertRaisesRegex(RuntimeError, 'STABLE_RECORD_INVALID'):
                DEPLOYER.parse_record(path)

    def test_pre_migration_failures_restore_exact_source(self):
        for failure in ('build', 'backup', 'restore'):
            with self.subTest(failure=failure):
                ops = FakeDeployment(failure)
                with self.assertRaisesRegex(RuntimeError, 'injected_' + failure):
                    DEPLOYER.deployment_flow(ops)
                self.assertIn('restore_source', ops.events)
                self.assertIn('cleanup_restore', ops.events)
                self.assertNotIn('migrate', ops.events)
                self.assertNotIn('quiesce', ops.events)

    def test_migration_reconcile_and_health_failures_never_restart_source(self):
        for failure in ('migrate', 'reconcile', 'health'):
            with self.subTest(failure=failure):
                ops = FakeDeployment(failure)
                with self.assertRaisesRegex(RuntimeError, 'injected_' + failure):
                    DEPLOYER.deployment_flow(ops)
                self.assertIn('quiesce', ops.events)
                self.assertNotIn('restore_source', ops.events)
                self.assertIn('cleanup_restore', ops.events)

    def test_success_cleans_restore_drill_before_receipt(self):
        ops = FakeDeployment()
        DEPLOYER.deployment_flow(ops)
        self.assertLess(ops.events.index('migrate'), ops.events.index('health'))
        self.assertLess(ops.events.index('health'), ops.events.index('cleanup_restore'))
        self.assertLess(ops.events.index('cleanup_restore'), ops.events.index('cleanup_pin'))
        self.assertLess(ops.events.index('cleanup_pin'), ops.events.index('receipt'))
        self.assertNotIn('restore_source', ops.events)
        self.assertNotIn('quiesce', ops.events)

    def test_low_and_medium_deployments_keep_backup_but_skip_database_restore_and_migration(self):
        ops = FakeDeployment(database_required=False)

        DEPLOYER.deployment_flow(ops)

        self.assertIn('backup', ops.events)
        self.assertIn('health', ops.events)
        self.assertIn('receipt', ops.events)
        self.assertNotIn('restore', ops.events)
        self.assertNotIn('migrate', ops.events)
        self.assertNotIn('reconcile', ops.events)
        self.assertNotIn('quiesce', ops.events)

    def test_low_and_medium_failure_before_writer_cutover_restores_exact_source(self):
        ops = FakeDeployment('backup', database_required=False)

        with self.assertRaisesRegex(RuntimeError, 'injected_backup'):
            DEPLOYER.deployment_flow(ops)

        self.assertIn('restore_source', ops.events)
        self.assertNotIn('quiesce', ops.events)

    def test_low_and_medium_failure_after_writer_cutover_stays_quiesced(self):
        ops = FakeDeployment('start_target', database_required=False)

        with self.assertRaisesRegex(RuntimeError, 'injected_start_target'):
            DEPLOYER.deployment_flow(ops)

        self.assertIn('quiesce', ops.events)
        self.assertNotIn('restore_source', ops.events)


class ProductionResourceContractTests(unittest.TestCase):
    def test_restore_is_internal_pinned_and_bootstraps_roles_before_restore(self):
        source = SCRIPT.read_text(encoding='utf-8')
        bootstrap = source.index("images['principal-bootstrap']")
        restore = source.index("'pg_restore'")
        migrate = source.index("images['migrate']", restore)
        reconcile = source.index("images['reconcile']", migrate)
        self.assertLess(bootstrap, restore)
        self.assertLess(restore, migrate)
        self.assertLess(migrate, reconcile)
        self.assertIn("'--internal'", source)
        self.assertIn("'--no-privileges'", source)
        self.assertNotIn("'--no-owner'", source)
        self.assertIn("RESTORE_DATABASE_PRINCIPALS_INVALID", source)
        self.assertIn("RESTORE_PRIVATE_TRIGGER_ACL_INVALID", source)
        self.assertIn('@sha256:', source)
        self.assertIn("'ai-project-os.stable-restore-owner'", source)

    def test_cleanup_is_limited_to_captured_owned_ids_and_names(self):
        source = SCRIPT.read_text(encoding='utf-8')
        cleanup = source[source.index('    def cleanup_restore_drill(self):'):source.index('\n\ndef secure_lock')]
        self.assertIn('for identifier in list(reversed(self.restore_container_ids))', cleanup)
        self.assertIn("info['Config']['Labels'].get(owner_key) == owner_value", cleanup)
        self.assertIn("info.get('Id') == identifier", cleanup)
        self.assertIn('identifier == self.restore_network_id', cleanup)
        for forbidden in ('system prune', 'container prune', 'volume prune', 'network prune', 'rm -rf'):
            self.assertNotIn(forbidden, source)

    def test_bootstrap_uses_full_main_ci_and_deploy_reuses_exact_tiered_main_ci(self):
        revision = 'a' * 40
        source_revision = 'b' * 40
        tag = 'v1.0.3'
        database_job = 'Verify database and release candidate'
        source_job = 'Verify source and client'
        attestation = f'Verify internal delivery gates [risk=low base={source_revision}]'
        main = {'id': 1, 'head_sha': revision, 'event': 'push', 'head_branch': 'main',
                'status': 'completed', 'conclusion': 'success',
                'jobs': [source_job, attestation]}

        def has_jobs(run, required):
            return set(required).issubset(run['jobs'])

        full_main = dict(main, jobs=[source_job, database_job])
        with patch.object(DEPLOYER, '_ci_runs', side_effect=lambda _sha, event: [full_main]), \
                patch.object(DEPLOYER, '_run_has_jobs', side_effect=has_jobs):
            DEPLOYER.require_ci(tag, revision, bootstrap=True)
        with patch.object(DEPLOYER, '_ci_runs', return_value=[main]), \
                patch.object(DEPLOYER, '_run_has_jobs', side_effect=has_jobs), \
                self.assertRaisesRegex(RuntimeError, 'STABLE_EXACT_MAIN_FULL_CI_REQUIRED'):
            DEPLOYER.require_ci(tag, revision, bootstrap=True)

        required_low = DEPLOYER._risk_result('low', ['test'])
        with patch.object(DEPLOYER, '_ci_runs', side_effect=lambda _sha, event: [main]) as runs_mock, \
                patch.object(DEPLOYER, '_run_has_jobs', side_effect=has_jobs):
            DEPLOYER.require_ci(tag, revision, source_revision=source_revision, classification=required_low)
            self.assertEqual([call.args for call in runs_mock.call_args_list], [(revision, 'push')])

        for wrong_run in (
            dict(main, head_sha='c' * 40),
            dict(main, conclusion='failure'),
            dict(main, event='workflow_dispatch'),
            dict(main, head_branch=tag),
            dict(main, jobs=[source_job, f'Verify internal delivery gates [risk=low base={"d" * 40}]']),
            dict(main, jobs=[attestation]),
        ):
            with self.subTest(wrong_run=wrong_run), \
                    patch.object(DEPLOYER, '_ci_runs', return_value=[wrong_run]), \
                    patch.object(DEPLOYER, '_run_has_jobs', side_effect=has_jobs), \
                    self.assertRaisesRegex(RuntimeError, 'STABLE_EXACT_MAIN_APPLICABLE_CI_REQUIRED'):
                DEPLOYER.require_ci(tag, revision, source_revision=source_revision,
                                    classification=required_low)

        medium = DEPLOYER._risk_result('medium', ['frontend'])
        medium_run = dict(main, jobs=[source_job,
                                     'Verify internal delivery gates [risk=medium base=' + source_revision + ']',
                                     'Verify browser and release client'])
        with patch.object(DEPLOYER, '_ci_runs', return_value=[medium_run]), \
                patch.object(DEPLOYER, '_run_has_jobs', side_effect=has_jobs):
            # Higher-tier proof on the same source base is reusable for a lower-risk diff.
            DEPLOYER.require_ci(tag, revision, source_revision=source_revision, classification=required_low)
            DEPLOYER.require_ci(tag, revision, source_revision=source_revision, classification=medium)
        with patch.object(DEPLOYER, '_ci_runs', return_value=[dict(medium_run, jobs=medium_run['jobs'][:-1])]), \
                patch.object(DEPLOYER, '_run_has_jobs', side_effect=has_jobs), \
                self.assertRaisesRegex(RuntimeError, 'STABLE_EXACT_MAIN_APPLICABLE_CI_REQUIRED'):
            DEPLOYER.require_ci(tag, revision, source_revision=source_revision, classification=medium)

        high = DEPLOYER._risk_result('high', ['migration'])
        high_attestation = 'Verify internal delivery gates [risk=high base=' + source_revision + ']'
        high_run = dict(main, jobs=[source_job, high_attestation])
        with patch.object(DEPLOYER, '_ci_runs', return_value=[medium_run]), \
                patch.object(DEPLOYER, '_run_has_jobs', side_effect=has_jobs), \
                self.assertRaisesRegex(RuntimeError, 'STABLE_EXACT_MAIN_APPLICABLE_CI_REQUIRED'):
            DEPLOYER.require_ci(tag, revision, source_revision=source_revision, classification=high)
        lower_tier_run = dict(main, jobs=[source_job, attestation, database_job])
        with patch.object(DEPLOYER, '_ci_runs', return_value=[lower_tier_run]), \
                patch.object(DEPLOYER, '_run_has_jobs', side_effect=has_jobs), \
                self.assertRaisesRegex(RuntimeError, 'STABLE_EXACT_MAIN_APPLICABLE_CI_REQUIRED'):
            DEPLOYER.require_ci(tag, revision, source_revision=source_revision, classification=high)
        with patch.object(DEPLOYER, '_ci_runs', return_value=[high_run]), \
                patch.object(DEPLOYER, '_run_has_jobs', side_effect=has_jobs), \
                self.assertRaisesRegex(RuntimeError, 'STABLE_EXACT_MAIN_APPLICABLE_CI_REQUIRED'):
            DEPLOYER.require_ci(tag, revision, source_revision=source_revision, classification=high)
        high_run['jobs'].append(database_job)
        with patch.object(DEPLOYER, '_ci_runs', return_value=[high_run]), \
                patch.object(DEPLOYER, '_run_has_jobs', side_effect=has_jobs):
            DEPLOYER.require_ci(tag, revision, source_revision=source_revision, classification=medium)
            DEPLOYER.require_ci(tag, revision, source_revision=source_revision, classification=high)

    def test_same_target_retry_validates_source_and_skips_new_ci_attestation(self):
        revision = 'e' * 40
        manifest = [('20260901000000_original', 'a' * 64)]
        source = {
            'tag': TARGET_TAG, 'revision': revision, 'source_manifest': manifest,
        }

        class FixtureHelper:
            @staticmethod
            def trusted(_path, _mode=None):
                return None

        host = DEPLOYER.HostDeployment(TARGET_TAG, revision)
        with patch.object(DEPLOYER.os, 'geteuid', return_value=0), \
                patch.object(DEPLOYER, 'HELPER', FixtureHelper()), \
                patch.object(DEPLOYER, 'git', side_effect=lambda args: {
                    ('remote', 'get-url', 'origin'): DEPLOYER.REMOTE,
                    ('status', '--porcelain', '--untracked-files=all'): '',
                }[tuple(args)]), \
                patch.object(DEPLOYER, 'source_runtime_state', return_value=source), \
                patch.object(DEPLOYER, 'fetch_target'), \
                patch.object(DEPLOYER, 'require_ancestor'), \
                patch.object(DEPLOYER, 'validate_target_tree', return_value=(manifest, {})), \
                patch.object(DEPLOYER, 'classify_release_risk', return_value=DEPLOYER._risk_result('low', ['no-changes'])), \
                patch.object(host, '_validate_installed_state'), \
                patch.object(DEPLOYER, 'require_ci') as require_ci_mock:
            result = host.preflight()

        self.assertIs(result, source)
        self.assertTrue(host.already_current)
        self.assertFalse(host.database_required)
        require_ci_mock.assert_not_called()

    def test_status_accepts_bootstrap_revision_distinct_from_app_revision_and_detects_hash_drift(self):
        class FixtureHelper:
            @staticmethod
            def trusted(_path, _mode=None):
                return None

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            paths = {
                'deployer': root / 'deployer', 'backup': root / 'backup',
                'artifact_helper': root / 'artifact-helper', 'sudoers': root / 'sudoers',
                'gateway': root / 'gateway',
            }
            expected_modes = {
                'deployer': 0o700, 'backup': 0o755, 'artifact_helper': 0o755,
                'sudoers': 0o440, 'gateway': 0o755,
            }
            contents = {
                'deployer': SCRIPT.read_bytes(), 'backup': b'backup bytes',
                'artifact_helper': b'artifact bytes', 'sudoers': b'sudoers bytes',
                'gateway': b'gateway bytes',
            }
            for name, path in paths.items():
                path.write_bytes(contents[name])
                path.chmod(expected_modes[name])
            helper_path = root / DEPLOYER.HELPER_SOURCE
            helper_path.parent.mkdir(parents=True)
            helper_path.write_bytes((ROOT / DEPLOYER.HELPER_SOURCE).read_bytes())
            state_path = root / 'release-tooling-stable.json'
            state = {
                'formatVersion': 1, 'toolingRevision': 'c' * 40,
                'files': {name: DEPLOYER.sha256(content) for name, content in contents.items()},
            }
            state_path.write_text(json.dumps(state), encoding='utf-8')
            state_path.chmod(0o600)

            with patch.object(DEPLOYER, 'ROOT', root), \
                    patch.object(DEPLOYER, 'STATE', state_path), \
                    patch.object(DEPLOYER, 'DEPLOYER', paths['deployer']), \
                    patch.object(DEPLOYER, 'BACKUP', paths['backup']), \
                    patch.object(DEPLOYER, 'ARTIFACT_HELPER', paths['artifact_helper']), \
                    patch.object(DEPLOYER, 'SUDOERS', paths['sudoers']), \
                    patch.object(DEPLOYER, 'GATEWAY', paths['gateway']), \
                    patch.object(DEPLOYER, 'HELPER', FixtureHelper()), \
                    patch.object(DEPLOYER, '__file__', str(paths['deployer'])):
                validated = DEPLOYER.validate_state_file()
                self.assertNotEqual(validated['toolingRevision'], 'd' * 40)
                with patch.object(DEPLOYER.os, 'geteuid', return_value=0), \
                        patch.object(DEPLOYER.os, 'umask', return_value=0), \
                        redirect_stdout(io.StringIO()) as stdout:
                    DEPLOYER.main(['--status'])
                status = json.loads(stdout.getvalue())
                self.assertEqual(set(status), {'kind', 'formatVersion', 'toolingRevision', 'files'})
                self.assertEqual(status['kind'], 'STABLE_TOOLING_READY')
                self.assertEqual(status['toolingRevision'], 'c' * 40)
                host = DEPLOYER.HostDeployment(TARGET_TAG, 'd' * 40)
                with patch.object(DEPLOYER, 'git', return_value=''):
                    host._validate_installed_state({name: content for name, content in contents.items()})

                paths['gateway'].write_bytes(b'drifted gateway')
                with self.assertRaisesRegex(RuntimeError, 'STABLE_TOOLING_FILE_HASH_INVALID'):
                    DEPLOYER.validate_state_file()

    def test_same_release_returns_already_current_without_running_deployment_flow(self):
        revision = 'e' * 40
        source = {
            'receipt': {
                'release_protocol': 'stable-v1', 'tag': TARGET_TAG, 'revision': revision,
                'backup_name': '20261015T010203Z-pre-deploy-to-v1.0.2.ABC123',
                'restore_drill': json.dumps({'source_migration_count': 143,
                                             'target_migration_count': 145}),
            },
            'source_manifest': [('source-migration', 'a' * 64)] * 145,
        }

        class FixtureHelper:
            @staticmethod
            def trusted(_path, _mode=None):
                return None

        hosts = []

        class AlreadyCurrentHost:
            def __init__(self, _tag, _revision):
                self.already_current = False
                self.preflight_calls = 0
                hosts.append(self)

            def preflight(self):
                self.preflight_calls += 1
                self.already_current = True
                return source

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            file_names = ('deployer', 'backup', 'artifact_helper', 'sudoers', 'gateway')
            paths = {name: root / name for name in file_names}
            for name, path in paths.items():
                path.write_bytes((SCRIPT.read_bytes() if name == 'deployer' else name.encode()))
            state = {'files': {name: DEPLOYER.hash_file(path) for name, path in paths.items()}}
            with patch.object(DEPLOYER, 'os') as os_module, \
                    patch.object(DEPLOYER, 'HELPER', FixtureHelper()), \
                    patch.object(DEPLOYER, 'DEPLOYER', paths['deployer']), \
                    patch.object(DEPLOYER, 'BACKUP', paths['backup']), \
                    patch.object(DEPLOYER, 'ARTIFACT_HELPER', paths['artifact_helper']), \
                    patch.object(DEPLOYER, 'SUDOERS', paths['sudoers']), \
                    patch.object(DEPLOYER, 'GATEWAY', paths['gateway']), \
                    patch.object(DEPLOYER, '__file__', str(paths['deployer'])), \
                    patch.object(DEPLOYER, 'validate_state_file', return_value=state), \
                    patch.object(DEPLOYER, 'secure_lock', return_value=9), \
                    patch.object(DEPLOYER.signal, 'signal') as signal_mock, \
                    patch.object(DEPLOYER, 'HostDeployment', AlreadyCurrentHost), \
                    patch.object(DEPLOYER, 'deployment_flow') as deployment_flow, \
                    redirect_stdout(io.StringIO()) as stdout:
                os_module.geteuid.return_value = 0
                DEPLOYER.main(['deploy', TARGET_TAG, revision, 'CONFIRM_STABLE_WITH_BACKUP_AND_FULL_CI'])
            self.assertEqual(len(hosts), 1)
            self.assertEqual(hosts[0].preflight_calls, 1)
            deployment_flow.assert_not_called()
            registered_signals = {call.args[0] for call in signal_mock.call_args_list}
            self.assertTrue({signal.SIGINT, signal.SIGHUP, signal.SIGTERM}.issubset(registered_signals))
            self.assertTrue(stdout.getvalue().startswith('STABLE_DEPLOY_ALREADY_CURRENT '))


if __name__ == '__main__':
    unittest.main(verbosity=2)
