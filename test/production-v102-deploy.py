#!/usr/bin/env python3
"""Offline contract tests for the fixed v1.0.0 -> v1.0.2 cutover."""
from __future__ import annotations

import importlib.util
import io
import hashlib
import json
import os
from pathlib import Path
from contextlib import redirect_stdout
import subprocess
import sys
import tarfile
import tempfile
import textwrap
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'deploy/production/ai-project-os-v102-deploy.py'
SPEC = importlib.util.spec_from_file_location('v102_deployer_under_test', SCRIPT)
DEPLOYER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DEPLOYER)
ARTIFACT_PATH = ROOT / 'deploy/production/ai_project_os_backup_artifact.py'
ARTIFACT_SPEC = importlib.util.spec_from_file_location('v102_artifact_under_test', ARTIFACT_PATH)
ARTIFACT = importlib.util.module_from_spec(ARTIFACT_SPEC)
ARTIFACT_SPEC.loader.exec_module(ARTIFACT)


class FakeDeployment:
    def __init__(self, failure=None):
        self.failure = failure
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
                RuntimeError, 'V102_ACTIVE_SIGNUP_POLICY_INVALID',
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
                return json.dumps([{'Config': {'Labels': {'org.opencontainers.image.version': '1.0.2'}}}])
            self.fail('unexpected docker call: ' + repr(args))

        class FixtureHelper:
            @staticmethod
            def atomic_write(_path, _content, _mode):
                return None

            @staticmethod
            def trusted(_path, _mode=None):
                return None

        host = DEPLOYER.HostDeployment('a' * 40)
        with patch.object(DEPLOYER, 'compose', side_effect=fake_compose), \
                patch.object(DEPLOYER, 'docker', side_effect=fake_docker), \
                patch.object(DEPLOYER, 'HELPER', FixtureHelper()):
            result = host.build_target_images()

        builds = [args[1:] for args, _kwargs in compose_calls if args[0] == 'build']
        self.assertEqual(builds, [(service,) for service in services])
        self.assertEqual(tuple(result), services)
        self.assertEqual(host.images, result)

    def test_revalidate_source_allows_live_data_counts_to_change(self):
        services = ('app', 'worker', 'git-worker')
        source_snapshot = self.signup_snapshot({'AppUser': 10, 'PlatformTokenGrant': 20})
        current_snapshot = self.signup_snapshot({'AppUser': 11, 'PlatformTokenGrant': 22})
        source = {
            'postgres_id': 'pg-id',
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

        host = DEPLOYER.HostDeployment('b' * 40)
        with patch.object(DEPLOYER, 'git', return_value=host.target_revision), \
                patch.object(DEPLOYER, 'container', side_effect=lambda name: containers[name]), \
                patch.object(DEPLOYER, 'config_hashes', return_value=source['config_hashes']), \
                patch.object(DEPLOYER, 'migration_ledger'), \
                patch.object(DEPLOYER, 'readonly_database_snapshot', return_value=current_snapshot), \
                patch.object(DEPLOYER, 'HELPER', FixtureHelper()):
            host.revalidate_source(source)

        self.assertEqual(source['database_snapshot'], source_snapshot)

    def test_stop_source_writers_refreshes_data_counts_after_drain(self):
        services = ('app', 'worker', 'git-worker')
        source_snapshot = self.signup_snapshot({'AppUser': 10})
        stopped_snapshot = self.signup_snapshot({'AppUser': 12})
        source = {
            'postgres_id': 'pg-id',
            'writer_ids': {service: service + '-id' for service in services},
            'source_manifest': [('20261014000000_source', 'a' * 64)],
            'database_snapshot': source_snapshot,
        }

        class FixtureHelper:
            @staticmethod
            def stopped(_postgres_id):
                return None

        host = DEPLOYER.HostDeployment('c' * 40)
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
        host = DEPLOYER.HostDeployment('d' * 40)
        host.source = {
            'postgres_id': 'pg-id', 'source_manifest': [('source', 'a' * 64)],
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
        self.assertEqual(host.target_health['local']['version'], '1.0.2')
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
            'postgres_id': 'pg-id', 'source_manifest': [('source', 'a' * 64)],
            'config_hashes': {'production_env': 'env-hash'},
            'database_snapshot': self.signup_snapshot(),
        }
        backup = {
            'name': '20261015T010203Z-pre-deploy-to-v1.0.2.ABC123',
            'object': 'cos://backup/archive', 'verified_manifest': 'cos://backup/manifest',
            'sha256': 'e' * 64,
        }
        host = DEPLOYER.HostDeployment('f' * 40)
        host.target_writer_ids = {'app': 'app-id', 'worker': 'worker-id', 'git-worker': 'git-id'}
        host.target_health = {'local': {'status': 'ok'}, 'public': {'status': 'ok'}}
        host.target_files = {'nginx': target_nginx}
        host.restore_evidence = {'source_sha256': 'f' * 64}
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
        self.assertEqual(record['tag'], DEPLOYER.TARGET_TAG)
        self.assertEqual(record['revision'], 'f' * 40)
        self.assertEqual(record['source_tag'], DEPLOYER.SOURCE_TAG)
        self.assertEqual(record['source_revision'], DEPLOYER.SOURCE_REVISION)
        self.assertEqual(json.loads(record['migration_count']), DEPLOYER.EXPECTED_MIGRATIONS)
        self.assertEqual(json.loads(record['target_writer_ids']), host.target_writer_ids)
        self.assertNotIn('status=', receipt_text)


class BackupValidationTests(unittest.TestCase):
    def test_backup_receipt_accepts_only_quiesced_v102_backup_in_expected_root(self):
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

        accepted = DEPLOYER.verify_backup_output(receipt())
        self.assertEqual(accepted['name'], backup_name)
        self.assertEqual(accepted['object'], object_path)

        old_name = backup_name.replace('v1.0.2', 'v1.0.1')
        with self.assertRaisesRegex(RuntimeError, 'V102_BACKUP_SOURCE_INVALID'):
            DEPLOYER.verify_backup_output(receipt(
                source='/var/backups/ai-project-os/' + old_name,
            ))
        with self.assertRaisesRegex(RuntimeError, 'V102_BACKUP_OBJECT_INVALID'):
            DEPLOYER.verify_backup_output(receipt(object='https://example.invalid/archive.tar.age'))
        with self.assertRaisesRegex(RuntimeError, 'V102_BACKUP_SOURCE_INVALID'):
            DEPLOYER.verify_backup_output(receipt(
                source='/tmp/' + backup_name,
            ))
        with self.assertRaisesRegex(RuntimeError, 'V102_BACKUP_RECEIPT_INVALID'):
            DEPLOYER.verify_backup_output(receipt(source_quiesced='false'))

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
            def trusted(_path, _mode=None):
                return None

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
                DEPLOYER.validate_local_backup(backup, current_email)

            expected = hashlib.sha256()
            zero_chunk = bytes(1024 * 1024)
            for _ in range(8):
                expected.update(zero_chunk)
            self.assertEqual(DEPLOYER.hash_file(path / 'postgres.dump'), expected.hexdigest())


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
            repository, 'show', DEPLOYER.SOURCE_REVISION + ':prisma/migrations/migration_lock.toml',
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
            source = DEPLOYER.git_manifest(DEPLOYER.SOURCE_REVISION)
            target = DEPLOYER.git_manifest('HEAD')
            working_tree = DEPLOYER.source_manifest(ROOT)
            DEPLOYER.validate_manifest_delta(source, target)

        self.assertEqual(len(source), 143)
        self.assertEqual(len(target), 145)
        self.assertEqual(working_tree, target)
        self.assertEqual(tuple(name for name, _ in target[-2:]), DEPLOYER.TARGET_MIGRATIONS)

    def test_actual_worktree_release_identity_passes_target_preflight(self):
        worktree_paths = {
            'package.json', 'src/lib/version.ts', 'Dockerfile', 'docs/releases/v1.0.2.md',
            'deploy/production/ai-project-os-v102-deploy.py',
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
            source = DEPLOYER.git_manifest(DEPLOYER.SOURCE_REVISION)
            target, files = DEPLOYER.validate_target_tree('HEAD', source)

        self.assertEqual(len(target), 145)
        self.assertIn('v1.0.2', files['backup'].decode('utf-8'))
        self.assertIn('ai-project-os-v102-deploy.py', files['deployer'].decode('utf-8'))

    def test_git_manifest_rejects_unexpected_blob_symlink_and_missing_migration_sql(self):
        with tempfile.TemporaryDirectory() as temporary:
            repository = Path(temporary) / 'repo'
            repository.mkdir()
            self.git(repository, 'init', '-q')
            self.git(repository, 'fetch', '--quiet', str(ROOT), DEPLOYER.SOURCE_REVISION)
            with patch.object(DEPLOYER, 'ROOT', repository), \
                    patch.object(DEPLOYER, 'HELPER', self.FixtureHelper()):
                unexpected = self.git(repository, 'hash-object', '-w', '--stdin', input_bytes=b'other')
                bad_blob_revision = self.fixture_revision(repository, [
                    ('100644', 'blob', unexpected, 'unexpected.txt'),
                ])
                with self.assertRaisesRegex(RuntimeError, 'V102_MIGRATION_NAME_INVALID'):
                    DEPLOYER.git_manifest(bad_blob_revision)

                symlink_revision = self.fixture_revision(repository, [
                    ('120000', 'blob', unexpected, '20261015030000_symlink'),
                ])
                with self.assertRaisesRegex(RuntimeError, 'V102_MIGRATION_ENTRY_TYPE_INVALID'):
                    DEPLOYER.git_manifest(symlink_revision)

                wrong_lock_type_revision = self.fixture_revision(
                    repository, [], lock_mode='120000',
                )
                with self.assertRaisesRegex(RuntimeError, 'V102_MIGRATION_LOCK_INVALID'):
                    DEPLOYER.git_manifest(wrong_lock_type_revision)

                other_sql = self.git(repository, 'hash-object', '-w', '--stdin', input_bytes=b'-- no migration')
                directory_tree = self.git(repository, 'mktree', input_bytes=(
                    f'100644 blob {other_sql}\tother.sql\n'.encode()
                ))
                missing_sql_revision = self.fixture_revision(repository, [
                    ('040000', 'tree', directory_tree, '20261015030000_missing_sql'),
                ])
                with self.assertRaisesRegex(RuntimeError, 'V102_MIGRATION_SQL_LAYOUT_INVALID'):
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
                with self.assertRaisesRegex(RuntimeError, 'V102_MIGRATION_LOCK_INVALID'):
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
                            assert str(error) == "V102_PINNED_HELPER_MODE_INVALID"
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


class FixedTransitionTests(unittest.TestCase):
    def test_only_exact_source_and_v102_tag_transition_is_accepted(self):
        DEPLOYER.validate_transition(
            'v1.0.0', DEPLOYER.SOURCE_REVISION, 'v1.0.2', 'a' * 40,
        )
        for values in (
            ('v0.8.0', DEPLOYER.SOURCE_REVISION, 'v1.0.2', 'a' * 40),
            ('v1.0.0', 'b' * 40, 'v1.0.2', 'a' * 40),
            ('v1.0.0', DEPLOYER.SOURCE_REVISION, 'v1.0.1', 'a' * 40),
            ('v1.0.0', DEPLOYER.SOURCE_REVISION, 'v1.0.2', 'a' * 39),
        ):
            with self.subTest(values=values), self.assertRaises(RuntimeError):
                DEPLOYER.validate_transition(*values)

    def test_manifest_requires_exact_143_entry_prefix_and_two_named_additions(self):
        source = [(f'20260901000000_migration_{index:03}', f'{index:064x}')
                  for index in range(DEPLOYER.SOURCE_MIGRATIONS)]
        target = source + [
            (DEPLOYER.TARGET_MIGRATIONS[0], 'a' * 64),
            (DEPLOYER.TARGET_MIGRATIONS[1], 'b' * 64),
        ]
        DEPLOYER.validate_manifest_delta(source, target)
        changed = list(target)
        changed[20] = (changed[20][0], 'c' * 64)
        with self.assertRaisesRegex(RuntimeError, 'V102_MIGRATION_BASELINE_CHANGED'):
            DEPLOYER.validate_manifest_delta(source, changed)
        with self.assertRaisesRegex(RuntimeError, 'V102_MIGRATION_COUNT_INVALID'):
            DEPLOYER.validate_manifest_delta(source, target[:-1])
        wrong_additions = source + [
            ('20261015030000_unapproved', 'a' * 64),
            (DEPLOYER.TARGET_MIGRATIONS[1], 'b' * 64),
        ]
        with self.assertRaisesRegex(RuntimeError, 'V102_MIGRATION_DELTA_INVALID'):
            DEPLOYER.validate_manifest_delta(source, wrong_additions)

    def test_source_receipt_accepts_only_the_existing_deploy_marker_and_key_values(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'receipt'
            path.write_text('DEPLOY_OK\ntag=v1.0.0\nrevision=' + DEPLOYER.SOURCE_REVISION + '\n')
            self.assertEqual(DEPLOYER.parse_record(path), {
                'status': 'DEPLOY_OK', 'tag': 'v1.0.0', 'revision': DEPLOYER.SOURCE_REVISION,
            })
            path.write_text('FAILED\ntag=v1.0.0\nrevision=' + DEPLOYER.SOURCE_REVISION + '\n')
            with self.assertRaisesRegex(RuntimeError, 'V102_RECORD_INVALID'):
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
        self.assertIn("'ai-project-os.v102-restore-owner'", source)

    def test_cleanup_is_limited_to_captured_owned_ids_and_names(self):
        source = SCRIPT.read_text(encoding='utf-8')
        cleanup = source[source.index('    def cleanup_restore_drill(self):'):source.index('\n\ndef secure_lock')]
        self.assertIn('for identifier in list(reversed(self.restore_container_ids))', cleanup)
        self.assertIn("info['Config']['Labels'].get(owner_key) == owner_value", cleanup)
        self.assertIn("info.get('Id') == identifier", cleanup)
        self.assertIn('identifier == self.restore_network_id', cleanup)
        for forbidden in ('system prune', 'container prune', 'volume prune', 'network prune', 'rm -rf'):
            self.assertNotIn(forbidden, source)

    def test_bootstrap_and_deploy_require_target_tag_ci_and_backup_confirmation(self):
        source = SCRIPT.read_text(encoding='utf-8')
        self.assertIn("require_ci(target_revision)", source)
        self.assertIn("'CONFIRM_INSTALL_V102_TOOLING'", source)
        self.assertIn("'CONFIRM_V102_WITH_BACKUP_AND_FULL_CI'", source)
        self.assertIn("'+refs/tags/' + TARGET_TAG + ':refs/tags/' + TARGET_TAG", source)
        self.assertIn("'refs/remotes/origin/main'", source)
        self.assertIn('ai-project-os-deploy.lock', source)
        self.assertIn('gateway_promoted_last=true', source)
        self.assertIn("'V102_TOOLING_READY'", source)
        self.assertIn('validate_tooling_bytes(gateway, sudoers)', source)
        self.assertIn("[visudo, '-cf', str(path)]", source)
        self.assertLess(source.index('(SUDOERS, files[\'sudoers\'], 0o440)'),
                        source.index('(GATEWAY, files[\'gateway\'], 0o755)'))


if __name__ == '__main__':
    unittest.main(verbosity=2)
