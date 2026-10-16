"""Offline contract tests for CI image delivery and bounded host maintenance."""
import copy
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import subprocess
import unittest
from unittest.mock import patch, MagicMock
import zipfile

spec = importlib.util.spec_from_file_location('stable_images', Path(__file__).parents[1] /
    'deploy/production/ai-project-os-release-stable.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
REVISION = 'a' * 40


def manifest():
    return {'schema': 1, 'revision': REVISION, 'version': '1.0.6', 'runId': 42,
            'images': {service: {'ref': 'ghcr.io/jack-kunlun/ai-project-os-' + service + '@sha256:' + str(i) * 64,
                                 'id': 'sha256:' + str(i + 3) * 64}
                       for i, service in enumerate(('app', 'worker', 'migrate'), 1)}}


class Images(unittest.TestCase):
    def test_manifest_requires_exact_sha_run_version_services_and_immutable_registry(self):
        valid = manifest()
        self.assertEqual(m.validate_image_manifest(valid, REVISION, '1.0.6', 42), valid)
        for key, value in [('revision', 'b' * 40), ('version', '1.0.5'), ('runId', 41), ('schema', True)]:
            invalid = copy.deepcopy(valid); invalid[key] = value
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                m.validate_image_manifest(invalid, REVISION, '1.0.6', 42)
        for reference in ('ghcr.io/other/app@sha256:' + '1' * 64,
                          'ghcr.io/jack-kunlun/ai-project-os-app:latest',
                          'ghcr.io/jack-kunlun/ai-project-os-app@sha256:' + '1' * 63):
            invalid = copy.deepcopy(valid); invalid['images']['app']['ref'] = reference
            with self.subTest(reference=reference), self.assertRaises(RuntimeError):
                m.validate_image_manifest(invalid, REVISION, '1.0.6', 42)
        invalid = copy.deepcopy(valid); invalid['images']['extra'] = invalid['images']['app']
        with self.assertRaises(RuntimeError): m.validate_image_manifest(invalid, REVISION, '1.0.6', 42)

    def test_credentials_are_bounded_and_duplicate_keys_rejected(self):
        credentials = {'token': 'ghs_' + 'x' * 40, 'runId': 42}
        self.assertEqual(m.read_release_credentials(io.StringIO(json.dumps(credentials))), credentials)
        for raw in ('x' * 4097, '{"token":"' + credentials['token'] + '","runId":42,"runId":43}',
                    json.dumps({**credentials, 'runId': True}), json.dumps({**credentials, 'token': 'x\nsecret'})):
            with self.subTest(raw=raw[:20]), self.assertRaises((RuntimeError, ValueError)):
                m.read_release_credentials(io.StringIO(raw))

    def test_artifact_binds_exact_ci_run_zip_digest_and_filename(self):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, 'w') as bundle: bundle.writestr('release-images.json', json.dumps(manifest()))
        archive = buffer.getvalue()
        artifact = {'id': 4, 'name': 'release-images', 'expired': False,
                    'size_in_bytes': len(archive), 'digest': 'sha256:' + m.sha256(archive),
                    'workflow_run': {'id': 42, 'head_sha': REVISION, 'head_branch': 'main'}}
        credentials = {'runId': 42, 'token': 'ghs_' + 'x' * 40}
        with patch.object(m, 'github_artifact_request', side_effect=[json.dumps({'artifacts': [artifact]}).encode(), archive]):
            self.assertEqual(m.load_ci_images({'id': 42}, credentials, REVISION, '1.0.6'), manifest())
        for change in ({'digest': 'sha256:' + '0' * 64}, {'expired': True},
                       {'workflow_run': {'id': 41, 'head_sha': REVISION, 'head_branch': 'main'}}):
            altered = {**artifact, **change}
            with patch.object(m, 'github_artifact_request', side_effect=[json.dumps({'artifacts': [altered]}).encode(), archive]):
                with self.subTest(change=change), self.assertRaises(RuntimeError):
                    m.load_ci_images({'id': 42}, credentials, REVISION, '1.0.6')

    def test_standard_signed_artifact_redirect_does_not_forward_github_credentials(self):
        api = 'https://api.github.com/repos/Jack-Kunlun/ai-project-os/actions/artifacts/4/zip'
        signed = 'https://pipelines.actions.githubusercontent.com/signedartifactscontent?signature=fixture'
        response = MagicMock(); response.status = 200; response.read.return_value = b'ZIP'
        response.__enter__.return_value = response
        opener = MagicMock()
        opener.open.side_effect = [m.urllib.error.HTTPError(api, 302, '', {'Location': signed}, None), response]
        with patch.object(m.urllib.request, 'build_opener', return_value=opener):
            self.assertEqual(m.github_artifact_request(api, 'ghs_' + 'x' * 40, redirect=True), b'ZIP')
        first = opener.open.call_args_list[0].args[0]
        second = opener.open.call_args_list[1].args[0]
        self.assertIsNotNone(first.get_header('Authorization'))
        self.assertIsNone(second.get_header('Authorization'))
        self.assertEqual(second.full_url, signed)
        for location in ('https://pipelines.actions.githubusercontent.com.attacker.example/zip', 'http://pipelines.actions.githubusercontent.com/zip'):
            opener.open.reset_mock(); opener.open.side_effect = [m.urllib.error.HTTPError(api, 302, '', {'Location': location}, None)]
            with patch.object(m.urllib.request, 'build_opener', return_value=opener), self.assertRaisesRegex(RuntimeError, 'ARTIFACT_REDIRECT_INVALID'):
                m.github_artifact_request(api, 'ghs_' + 'x' * 40, redirect=True)
            self.assertEqual(opener.open.call_count, 1)

    def test_pull_checks_ids_labels_and_never_builds(self):
        value = manifest()
        credentials = {'runId': 42, 'token': 'ghs_' + 'x' * 40}
        refs = {item['ref']: item for item in value['images'].values()}
        calls = []
        def docker(*args, **kwargs):
            calls.append(args)
            if args[:2] == ('image', 'inspect'):
                item = refs[args[2]]
                return json.dumps([{'Id': item['id'], 'RepoDigests': [item['ref']], 'Config': {'Labels': {
                    'org.opencontainers.image.version': '1.0.6',
                    'org.opencontainers.image.revision': REVISION,
                    'org.opencontainers.image.source': 'https://github.com/Jack-Kunlun/ai-project-os'}}}])
            self.assertIn('pull', args)
            return ''
        host = m.HostDeployment('v1.0.6', REVISION, credentials); host.image_manifest = value
        helper = MagicMock()
        services = {name: {'image': value['images']['worker' if name in ('git-worker', 'reconcile', 'principal-bootstrap') else name]['id']}
                    for name in ('app', 'worker', 'migrate', 'git-worker', 'reconcile', 'principal-bootstrap')}
        with tempfile.TemporaryDirectory() as temporary, patch.object(m, 'compose', return_value=json.dumps({'services': services})) as compose, \
                patch.object(m, 'docker', side_effect=docker), patch.object(m, 'HELPER', helper), \
                patch.object(m.tempfile, 'TemporaryDirectory', return_value=MagicMock(__enter__=lambda _: temporary, __exit__=lambda *_: None)), \
                patch.object(m.subprocess, 'run', return_value=MagicMock(returncode=0)) as login:
            images = host.build_target_images()
        self.assertFalse(any('build' in args for args in calls))
        self.assertEqual(sum('pull' in args for args in calls), 3)
        self.assertEqual(images['git-worker'], images['worker'])
        self.assertEqual(images['reconcile'], images['worker'])
        self.assertNotIn(credentials['token'], ' '.join(login.call_args.args[0]))
        self.assertEqual(login.call_args.kwargs['input'], credentials['token'] + '\n')
        self.assertTrue(all('build' not in call.args for call in compose.call_args_list))
        # Exercise Compose's actual merge semantics against the generated pin.
        if subprocess.run(['docker', 'compose', 'version'], capture_output=True).returncode == 0:
            with tempfile.TemporaryDirectory() as directory:
                base = Path(directory) / 'base.json'; overlay = Path(directory) / 'pin.yaml'
                base.write_text(json.dumps({'services': {name: {'image': 'previous:latest',
                    'build': {'context': directory, 'target': 'runner'}} for name in services}}))
                overlay.write_bytes(helper.atomic_write.call_args.args[1])
                config = subprocess.check_output(['docker', 'compose', '--project-directory', directory,
                    '--file', str(base), '--file', str(overlay), 'config', '--format', 'json'])
                merged = json.loads(config)['services']
                self.assertTrue(all('build' not in merged[name] and merged[name]['image'] == images[name]
                                    for name in images))

    def test_cleanup_keeps_current_previous_and_all_container_references(self):
        current, previous, referenced, old, foreign, legacy, same_title_foreign = ['sha256:' + str(i) * 64 for i in range(1, 8)]
        calls = []
        def docker(*args, **kwargs):
            calls.append(args)
            if args[:2] == ('ps', '-aq'): return 'container'
            if args[:3] == ('volume', 'ls', '-q'): return 'database\nuploads'
            if args[0] == 'inspect': return json.dumps([{'Image': referenced}])
            if args[:2] == ('image', 'ls'): return '\n'.join([current, previous, referenced, old, foreign, legacy, same_title_foreign])
            if args[:2] == ('image', 'inspect'):
                identity = args[2]
                if identity in (legacy, same_title_foreign):
                    labels = {
                        'org.opencontainers.image.title': 'AI Project OS',
                        'org.opencontainers.image.version': '1.0.1'}
                    if identity == legacy: labels.update({'com.docker.compose.project': 'ai-project-os', 'com.docker.compose.service': 'app'})
                    return json.dumps([{'Id': identity, 'Config': {'Labels': labels}, 'RepoTags': None, 'RepoDigests': None}])
                return json.dumps([{'Id': identity, 'Config': {'Labels': {
                    'org.opencontainers.image.source': ('https://github.com/Jack-Kunlun/ai-project-os' if identity == old else 'foreign')}},
                    'RepoTags': [('ghcr.io/jack-kunlun/ai-project-os-app:old' if identity == old else 'foreign:latest')]}])
            if args[:2] == ('image', 'rm') or args[:2] == ('buildx', 'prune'): return ''
            if args[:2] == ('buildx', 'du'): return ''
            self.fail(repr(args))
        host = m.HostDeployment('v1.0.6', REVISION); host.images = {'app': current}
        source = {'writer_images': {'app': previous}, 'receipt': {'target_image_ids': '{}'}}
        with patch.object(m, 'docker', side_effect=docker): host.cleanup_old_images(source)
        removals = [args for args in calls if args[:2] == ('image', 'rm')]
        self.assertEqual(removals, [('image', 'rm', 'ghcr.io/jack-kunlun/ai-project-os-app:old'), ('image', 'rm', legacy)])
        self.assertFalse(any('--force' in args for args in removals))
        self.assertFalse(any(args[:2] in [('volume', 'rm'), ('system', 'prune'), ('container', 'prune')] for args in calls))

    def test_noop_cache_prune_reports_budget_deferred_instead_of_success(self):
        large = json.dumps({'Size': '49000000000', 'Reclaimable': True, 'Shared': True})
        with patch.object(m, 'docker', side_effect=[large, '', large]), \
                patch('sys.stdout', new_callable=io.StringIO) as output:
            self.assertFalse(m.prune_build_cache())
        self.assertIn('STABLE_CACHE_BUDGET_DEFERRED', output.getvalue())
        self.assertIn('"budgetMet":false', output.getvalue())

    def test_workflow_tool_refresh_requires_ci_before_installing_candidate_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            deployed = Path(directory) / 'deployer'; deployed.write_bytes(b'old trusted code')
            installed = {'files': {'deployer': m.sha256(deployed.read_bytes())}}
            source = {'tag': 'v1.0.5', 'revision': 'b' * 40, 'source_manifest': [],
                      'receipt': {'release_protocol': 'stable-v1'}}
            with patch.object(m.os, 'geteuid', return_value=0), \
                    patch.object(m, '__file__', str(deployed)), patch.object(m, 'DEPLOYER', deployed), \
                    patch.object(m, 'HELPER', MagicMock()), patch.object(m, 'validate_state_file', return_value=installed), \
                    patch.object(m, 'git', return_value=''), patch.object(m, 'source_runtime_state', return_value=source), \
                    patch.object(m, '_read_trusted_host_file', return_value=b'DEPLOY_OK\ntag=v1.0.5\nrevision=' + b'b' * 40), \
                    patch.object(m, 'validate_transition'), patch.object(m, 'fetch_main'), patch.object(m, 'require_ancestor'), \
                    patch.object(m, 'classify_release_risk', return_value=m._risk_result('high', ['tooling'])), \
                    patch.object(m, 'require_ci', side_effect=RuntimeError('CI_DENIED')) as ci, \
                    patch.object(m, 'atomic_install') as install, patch.object(m, 'validate_target_tree') as target:
                with self.assertRaisesRegex(RuntimeError, 'CI_DENIED'):
                    m.install_bootstrap('v1.0.6', REVISION, from_workflow=True)
            ci.assert_called_once()
            install.assert_not_called(); target.assert_not_called()
            self.assertEqual(deployed.read_bytes(), b'old trusted code')


if __name__ == '__main__': unittest.main()
