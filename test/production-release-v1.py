"""Offline cutover fault injection. No production paths, Docker, mail or network."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('release_v1', 'deploy/production/ai-project-os-release-v1.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseTests(unittest.TestCase):
    def test_only_two_transitions(self):
        self.assertTrue(release.transition('v0.8.0-dev.3', 'v0.8.0-dev.4'))
        self.assertFalse(release.transition('v0.8.0-dev.4', 'v1.0.0'))
        for source, target in [('v0.8.0-dev.3', 'v1.0.0'), ('v1.0.0', 'v1.0.1'),
                               ('v0.8.0-dev.4', 'v0.8.0-dev.4'), ('x;id', 'v1.0.0')]:
            with self.assertRaisesRegex(RuntimeError, 'TRANSITION_DENIED'):
                release.transition(source, target)

    def test_manifest_preserves_exact_sql_bytes(self):
        name = '20261013010000_add_email_auth'
        data = b'BEGIN;\nSELECT 1;\nCOMMIT;\n\n'
        with patch.object(release, 'git', return_value=name), patch.object(release, 'file_bytes', return_value=data):
            self.assertEqual(release.exact_manifest(None, 'a' * 40, 1), [(name, hashlib.sha256(data).hexdigest())])
        with patch.object(release, 'git', return_value=name + '\n' + name):
            with self.assertRaisesRegex(RuntimeError, 'MANIFEST_INVALID'):
                release.exact_manifest(None, 'a' * 40, 2)

    def test_stable_delta_rejects_functional_or_dependency_changes(self):
        changed = 'package.json\nDockerfile\nsrc/lib/version.ts\ndocs/releases/v1.0.0.md'
        def content(_lib, revision, name):
            version = '0.8.0-dev.4' if revision == 'old' else '1.0.0'
            return (json.dumps({'version': version, 'dependencies': {'next': '16.3.8'}}).encode()
                    if name == 'package.json' else ('version=' + version).encode())
        with patch.object(release, 'git', return_value=changed), patch.object(release, 'file_bytes', side_effect=content):
            release.validate_stable_delta(None, 'old', 'new')
        with patch.object(release, 'git', return_value=changed + '\nsrc/lib/auth.ts'):
            with self.assertRaisesRegex(RuntimeError, 'STABLE_DELTA_INVALID'):
                release.validate_stable_delta(None, 'old', 'new')

        def changed_dependency(lib, revision, name):
            data = content(lib, revision, name)
            return data.replace(b'16.3.8', b'99.0.0') if revision == 'new' else data
        with patch.object(release, 'git', return_value=changed), patch.object(release, 'file_bytes', side_effect=changed_dependency):
            with self.assertRaisesRegex(RuntimeError, 'STABLE_PACKAGE_DELTA_INVALID'):
                release.validate_stable_delta(None, 'old', 'new')

    def test_failed_atomic_promotion_preserves_existing_file_and_mode(self):
        with tempfile.TemporaryDirectory(prefix='release-v1-atomic-') as directory:
            destination = Path(directory) / 'managed'
            destination.write_bytes(b'previous')
            destination.chmod(0o600)
            with patch.object(release, 'trusted', return_value=None), patch.object(release.os, 'replace', side_effect=OSError('injected-rename')):
                with self.assertRaisesRegex(OSError, 'injected-rename'):
                    release.write(destination, b'candidate', 0o700)
            self.assertEqual(destination.read_bytes(), b'previous')
            self.assertEqual(destination.stat().st_mode & 0o777, 0o600)
            self.assertEqual(list(Path(directory).iterdir()), [destination])

    def exercise(self, migration=True, failure=None):
        with tempfile.TemporaryDirectory(prefix='release-v1-fixture-') as directory:
            root = Path(directory)
            (root / 'src/lib').mkdir(parents=True)
            (root / 'deploy/production/nginx').mkdir(parents=True)
            (root / 'deploy/production/nginx/ai-project-os.conf').write_bytes(b'new nginx')
            source = 'a' * 40
            target = 'b' * 40
            source_tag = 'v0.8.0-dev.3' if migration else 'v0.8.0-dev.4'
            target_tag = 'v0.8.0-dev.4' if migration else 'v1.0.0'
            state = {'head': source, 'stopped': False, 'target': False}
            calls = []
            tool = root / 'tool'
            tool.write_bytes(b'reviewed fixture tool')
            email = root / 'email.env'
            email.write_text('AI_PROJECT_OS_EMAIL_AUTH_ENABLED=true\n')
            nginx = root / 'nginx'
            nginx.write_bytes(b'old nginx')
            receipt = root / 'receipt'
            receipt.write_bytes(b'old receipt')
            writers = [{'Id': str(index) * 64, 'Image': 'sha256:' + str(index) * 64}
                       for index in range(1, 4)]
            captured = {service: item['Image'] for service, item in zip(release.WRITERS, writers)}
            images = {service: 'sha256:' + str(index) * 64 for index, service in enumerate(release.WRITERS, 4)}
            def git(_lib, *args):
                calls.append(('git', *args))
                if args[:2] == ('remote', 'get-url'):
                    return 'fixture-remote'
                if args[:1] == ('status',):
                    return ''
                if args[:1] == ('rev-parse',):
                    return state['head']
                if args[:1] == ('checkout',):
                    state['head'] = args[-1]
                    version = target_tag[1:] if args[-1] == target else source_tag[1:]
                    (root / 'package.json').write_text(json.dumps({'version': version}))
                    (root / 'src/lib/version.ts').write_text('export const APP_VERSION = "' + version + '";')
                    (root / 'Dockerfile').write_text('LABEL org.opencontainers.image.version="' + version + '"')
                return ''
            def compose(_lib, extra, *args, **_kwargs):
                calls.append(('compose', *args))
                if args[0] == 'build' and failure == 'build':
                    raise RuntimeError('injected-build')
                if args == ('build', 'worker') and failure == 'build-worker':
                    raise RuntimeError('injected-build-worker')
                if args[0] == 'up':
                    service = args[-1]
                    if service in ('migrate', 'reconcile') and failure == service:
                        raise RuntimeError('injected-' + service)
                    if service == 'git-worker':
                        override = json.loads(extra.read_text())
                        state['target'] = override['services']['app']['image'] == images['app']
                        if state['target'] and failure == 'recreate':
                            raise RuntimeError('injected-recreate')
                        state['stopped'] = False
                return ''
            def docker(*args):
                calls.append(('docker', *args))
                if args[:2] == ('compose', 'version'):
                    return '5.5.0'
                if args[0] == 'stop':
                    state['stopped'] = True
                    if failure == 'partial-stop':
                        raise RuntimeError('injected-partial-stop')
                return ''
            def wait_ready(_lib, tag, image_ids):
                calls.append(('ready', tag, image_ids))
                if tag == target_tag and failure == 'health':
                    raise RuntimeError('injected-health')
                self.assertEqual(image_ids, images if tag == target_tag else captured)
                return {'status': 'ok', 'version': tag[1:]}
            def quiesce(_postgres):
                calls.append(('quiesce',))
                state['stopped'] = True
            def restart(_writers):
                calls.append(('restart-source',))
                state['stopped'] = False
            def write(path, data, mode):
                calls.append(('write', str(path), mode))
                Path(path).write_bytes(data)
            before = [('migration-' + str(index), '0' * 64) for index in range(142)]
            after = [*before, (release.EMAIL_MIGRATION, '1' * 64)]
            def manifest(_lib, revision, _count):
                return before if migration and revision == source else after
            lib = SimpleNamespace(
                REMOTE='fixture-remote', RESULT=receipt, NGINX=nginx,
                docker=docker, ledger=lambda _, rows: calls.append(('ledger', len(rows))),
                stopped=lambda _: calls.append(('stopped-check',)),
                db_query=lambda *_: 0,
                run=lambda args: calls.append(('run', *args)),
                wait_service=lambda service: calls.append(('wait-service', service)),
                quiesce_after_failure=quiesce, restart_source=restart,
                container=lambda service: {'Id': 'postgres'} if service == 'postgres' else
                    {'Config': {'Env': ['AI_PROJECT_OS_EMAIL_AUTH_ENABLED=true']}},
                request_json=lambda _: {'resource': 'https://ai-project-os.com/api/mcp',
                                        'authorization_servers': ['https://ai-project-os.com'], 'scopes_supported': ['project:read']},
            )
            original_temporary = tempfile.TemporaryDirectory
            def isolated_temporary(*args, **kwargs):
                kwargs['dir'] = root
                return original_temporary(*args, **kwargs)
            patches = {
                'ROOT': root, 'TOOL': tool, 'EMAIL_ENV': email, 'INITIAL_REVISION': source,
                'FILES': (('fixture-tool', str(tool), 0o700),), 'git': git,
                'file_bytes': lambda *_: tool.read_bytes(), 'fetch_target': lambda *_: calls.append(('ci-verified',)),
                'source_state': lambda *_: ('postgres', writers), 'exact_manifest': manifest,
                'trusted': lambda *_: None, 'configuration': lambda *_: {'hash': b'fixed'},
                'unchanged': lambda *_: calls.append(('config-unchanged',)), 'write': write,
                'compose': compose, 'target_images': lambda *_: images, 'wait_ready': wait_ready,
                'journal': lambda _, phase: calls.append(('phase', phase)), 'validate_stable_delta': lambda *_: None,
                'validate_nginx_path': lambda *_: None,
            }
            with patch.multiple(release, **patches), patch.object(tempfile, 'TemporaryDirectory', side_effect=isolated_temporary):
                if failure:
                    with self.assertRaisesRegex(RuntimeError, 'injected-'):
                        release.deploy(lib, [source_tag, target_tag, source, target, release.CONFIRM])
                else:
                    release.deploy(lib, [source_tag, target_tag, source, target, release.CONFIRM])
            result = {'calls': calls, 'state': state, 'receipt': receipt.read_bytes(), 'nginx': nginx.read_bytes()}
            return result

    def test_initial_success_builds_before_stop_and_reconciles_before_writers(self):
        result = self.exercise()
        calls = result['calls']
        build = next(index for index, call in enumerate(calls) if call[:2] == ('compose', 'build'))
        stop = next(index for index, call in enumerate(calls) if call[:2] == ('docker', 'stop'))
        self.assertLess(build, stop)
        builds = [call for call in calls if call[:2] == ('compose', 'build')]
        self.assertEqual([call[2:] for call in builds], [(service,) for service in ('migrate', 'reconcile', *release.WRITERS)])
        self.assertIn(('wait-service', 'migrate'), calls)
        self.assertIn(('wait-service', 'reconcile'), calls)
        self.assertIn(b'tag=v0.8.0-dev.4', result['receipt'])
        self.assertEqual(calls[-1], ('phase', 'completed'))

    def test_build_failure_preserves_source(self):
        for failure in ('build', 'build-worker'):
            with self.subTest(failure=failure):
                result = self.exercise(failure=failure)
                self.assertFalse(result['state']['stopped'])
                self.assertEqual(result['state']['head'], 'a' * 40)
                self.assertEqual(result['receipt'], b'old receipt')
                self.assertFalse(any(call[:2] == ('docker', 'stop') for call in result['calls']))

    def test_partial_stop_failure_restarts_captured_source(self):
        result = self.exercise(failure='partial-stop')
        self.assertFalse(result['state']['stopped'])
        self.assertIn(('restart-source',), result['calls'])
        self.assertEqual(result['nginx'], b'old nginx')

    def test_initial_post_migration_failures_stop_and_never_restart_old_code(self):
        for failure in ('migrate', 'reconcile', 'recreate', 'health'):
            with self.subTest(failure=failure):
                result = self.exercise(failure=failure)
                self.assertTrue(result['state']['stopped'])
                self.assertIn(('quiesce',), result['calls'])
                self.assertNotIn(('restart-source',), result['calls'])
                self.assertEqual(result['state']['head'], 'b' * 40)
                self.assertEqual(result['receipt'], b'old receipt')

    def test_stable_success_never_runs_migrate_or_reconcile(self):
        result = self.exercise(migration=False)
        self.assertFalse(any(call[0] == 'wait-service' for call in result['calls']))
        self.assertIn(b'tag=v1.0.0', result['receipt'])

    def test_stable_failure_restores_exact_captured_image_ids(self):
        for failure in ('recreate', 'health'):
            with self.subTest(failure=failure):
                result = self.exercise(migration=False, failure=failure)
                self.assertFalse(result['state']['stopped'])
                self.assertEqual(result['state']['head'], 'a' * 40)
                self.assertEqual(result['receipt'], b'old receipt')
                self.assertEqual(result['nginx'], b'old nginx')
                self.assertIn(('phase', 'failed_source_images_restored'), result['calls'])


if __name__ == '__main__':
    unittest.main()
