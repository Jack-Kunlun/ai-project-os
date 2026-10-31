"""Offline unit and command-contract tests for the production egress installer."""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import socket
import ssl
import subprocess
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

SCRIPT = Path(__file__).parents[1] / 'deploy/production/ai-project-os-openai-egress.py'
spec = importlib.util.spec_from_file_location('production_openai_egress', SCRIPT)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def node():
    return {
        'node_id': 'fixture-node-1',
        'node': {
            'cipher': 'chacha20-ietf-poly1305',
            'name': 'fixture node',
            'password': 'not-a-real-node-password',
            'port': 443,
            'server': '1.1.1.1',
            'type': 'ss',
            'udp': True,
        },
        'trace': {'source': 'fixture', 'verified': True},
    }


class PayloadValidation(unittest.TestCase):
    def test_private_payload_requires_exact_schema_owner_mode_hash_and_node_contract(self):
        raw = json.dumps(node(), separators=(',', ':')).encode('utf-8')
        digest = hashlib.sha256(raw).hexdigest()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'node.json'
            path.write_bytes(raw)
            path.chmod(0o600)
            actual = m.read_private_payload(path, digest, {os.stat(path).st_uid})
            self.assertEqual(actual['node']['server'], '1.1.1.1')
            self.assertEqual(actual['node']['type'], 'ss')

            with self.assertRaisesRegex(m.InstallerError, 'SHA256_MISMATCH'):
                m.read_private_payload(path, '0' * 64, {os.stat(path).st_uid})

            with self.assertRaisesRegex(m.InstallerError, 'OWNERSHIP_INVALID'):
                m.read_private_payload(path, digest, {os.stat(path).st_uid + 10000})

            path.chmod(0o644)
            with self.assertRaisesRegex(m.InstallerError, 'OWNERSHIP_INVALID'):
                m.read_private_payload(path, digest, {os.stat(path).st_uid})

            path.unlink()
            target = Path(directory) / 'target.json'
            target.write_bytes(raw)
            target.chmod(0o600)
            path.symlink_to(target)
            with self.assertRaisesRegex(m.InstallerError, 'UNAVAILABLE'):
                m.read_private_payload(path, digest, {os.stat(target).st_uid})

    def test_payload_rejects_duplicate_json_keys_and_unsupported_node_shapes(self):
        duplicate = b'{"node_id":"one","node_id":"two","node":{},"trace":{}}'
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'payload.json'
            path.write_bytes(duplicate)
            path.chmod(0o600)
            with self.assertRaisesRegex(m.InstallerError, 'JSON_DUPLICATE_KEY'):
                m.read_private_payload(path, hashlib.sha256(duplicate).hexdigest(), {os.stat(path).st_uid})

        bad_nodes = []
        value = node(); value['node']['plugin'] = 'v2ray-plugin'; bad_nodes.append(value)
        value = node(); value['node']['type'] = 'vmess'; bad_nodes.append(value)
        value = node(); value['node']['server'] = '203.0.113.9'; bad_nodes.append(value)
        value = node(); value['node']['port'] = True; bad_nodes.append(value)
        value = node(); value['node']['cipher'] = 'not-a-cipher'; bad_nodes.append(value)
        value = node(); value['node']['password'] = 'bad\npassword'; bad_nodes.append(value)
        value = node(); value['node']['udp'] = 1; bad_nodes.append(value)
        for payload in bad_nodes:
            with self.subTest(node=payload['node']), self.assertRaises(m.InstallerError):
                m.validate_node_payload(payload)

    def test_trace_receipt_parser_returns_only_safe_location_fields(self):
        result = m.parse_trace(b'fl=fixture\nh=api.openai.com\nip=203.0.113.8\ncolo=TPE\nloc=TW\n')
        self.assertEqual(result, {'loc': 'TW', 'colo': 'TPE'})
        with self.assertRaisesRegex(m.InstallerError, 'EXIT_INVALID'):
            m.parse_trace(b'ip=203.0.113.8\ncolo=LAX\nloc=US\n')


class EnvironmentRollback(unittest.TestCase):
    proxy = 'http://user_fixture_1234567890:password_fixture_12345678901234567890@172.20.0.1:17890'

    def test_replace_and_restore_only_proxy_entry_preserving_other_bytes(self):
        original = (
            b'POSTGRES_USER=admin\r\nOTHER=value\r\n'
            b'AI_PROJECT_OS_OPENAI_PROXY_URL=http://old:secret@10.0.0.1:17890\r\n'
        )
        updated, delta = m.edit_env_bytes(original, self.proxy)
        expected = (b'POSTGRES_USER=admin\r\nOTHER=value\r\nAI_PROJECT_OS_OPENAI_PROXY_URL='
                    + self.proxy.encode() + b'\r\n')
        self.assertEqual(updated, expected)
        self.assertEqual(m.rollback_env_bytes(updated, delta), original)

    def test_appending_and_rollback_preserve_original_missing_final_newline(self):
        original = b'POSTGRES_USER=admin'
        updated, delta = m.edit_env_bytes(original, self.proxy)
        self.assertEqual(m.rollback_env_bytes(updated, delta), original)

    def test_rollback_preserves_concurrent_unrelated_edits_and_refuses_proxy_conflicts(self):
        original = b'POSTGRES_USER=admin\n'
        updated, delta = m.edit_env_bytes(original, self.proxy)
        concurrent = updated + b'NEW_SETTING=preserved\n'
        restored = m.rollback_env_bytes(concurrent, delta)
        self.assertEqual(restored, original + b'NEW_SETTING=preserved\n')

        conflicting = updated.replace(self.proxy.encode(), b'http://new:other@172.20.0.1:17890')
        with self.assertRaisesRegex(m.InstallerError, 'ROLLBACK_ENV_CONFLICT'):
            m.rollback_env_bytes(conflicting, delta)

    def test_duplicate_environment_key_is_rejected(self):
        with self.assertRaisesRegex(m.InstallerError, 'DUPLICATE_KEY'):
            m.edit_env_bytes(b'X=1\nX=2\n', self.proxy)


class ConfigurationAndRuntimeContract(unittest.TestCase):
    def test_mihomo_config_is_a_private_openai_only_listener(self):
        config = json.loads(m.build_mihomo_config(node()['node'], '172.20.0.1', 17890,
                                                  'u' * 24, 'p' * 48))
        self.assertEqual(config['mixed-port'], 17890)
        self.assertTrue(config['allow-lan'])
        self.assertEqual(config['bind-address'], '172.20.0.1')
        self.assertEqual(config['rules'], ['DOMAIN,api.openai.com,OPENAI_EGRESS', 'MATCH,REJECT'])
        self.assertEqual(config['proxies'][0]['name'], 'OPENAI_EGRESS')
        self.assertNotIn('tun', config)
        self.assertNotIn('dns', config)
        self.assertNotIn('external-controller', config)
        self.assertNotIn('skip-cert-verify', config['proxies'][0])
        self.assertNotIn('plugin', config['proxies'][0])

    def test_proxy_url_requires_private_rfc1918_gateway(self):
        self.assertTrue(m.build_proxy_url('172.20.0.1', 'u' * 24, 'p' * 48).startswith('http://'))
        for gateway in ('0.0.0.0', '198.51.100.10', 'localhost'):
            with self.subTest(gateway=gateway), self.assertRaises(m.InstallerError):
                m.build_proxy_url(gateway, 'u' * 24, 'p' * 48)

    def test_compose_pin_and_recreation_touch_only_app_and_worker(self):
        app = 'sha256:' + 'a' * 64
        worker = 'sha256:' + 'b' * 64
        overlay = m.build_compose_pin(app, worker).decode()
        self.assertIn(f'image: {app}', overlay)
        self.assertIn(f'image: {worker}', overlay)
        self.assertEqual(overlay.count('build: !reset null'), 2)
        self.assertNotIn('postgres:', overlay)
        self.assertNotIn('git-worker:', overlay)

        with patch.object(m, 'app_worker_pin_file', return_value=Path('/private/pin.yaml')) as pin_file, \
             patch.object(m, 'compose_command') as compose:
            m.recreate_app_worker(app, worker)
        pin_file.assert_called_once_with(app, worker)
        self.assertEqual(compose.call_args.args,
                         ('up', '-d', '--no-deps', '--no-build', '--force-recreate', 'app', 'worker'))
        self.assertEqual(compose.call_args.kwargs['pin_file'], Path('/private/pin.yaml'))
        self.assertNotIn('build', compose.call_args.args)

    def test_health_and_unrelated_container_identity_checks_are_exact(self):
        healthy = {'status': 'ok', 'version': '1.2.22', 'database': 'up',
                   'worker': {'status': 'up', 'consecutiveFailures': 0}}
        m.validate_health_payload(healthy, '1.2.22')
        with self.assertRaisesRegex(m.InstallerError, 'HEALTH_PAYLOAD_INVALID'):
            m.validate_health_payload({**healthy, 'version': '1.2.21'}, '1.2.22')
        before = {'postgres_container_id': 'pg1', 'postgres_image_id': 'pgimg',
                  'git_worker_container_id': 'git1', 'git_worker_image_id': 'gitimg'}
        self.assertEqual(m._same_database_and_git_worker(before, dict(before)), (True, True))
        self.assertEqual(m._same_database_and_git_worker(before, {**before, 'git_worker_container_id': 'git2'}),
                         (True, False))

    def test_current_runtime_requires_exact_app_worker_image_labels_and_running_health(self):
        names = ('app', 'worker', 'postgres', 'git-worker')
        image_ids = {name: 'sha256:' + str(index + 1) * 64 for index, name in enumerate(names)}
        containers = {
            name: {
                'id': str(index + 1) * 64,
                'image_id': image_ids[name],
                'state': {'Status': 'running', 'Health': {'Status': 'healthy'}},
                'labels': {'com.docker.compose.project': m.PROJECT,
                           'com.docker.compose.service': name},
                'networks': {m.NETWORK_NAME: {}},
            }
            for index, name in enumerate(names)
        }
        labels = {'org.opencontainers.image.version': '1.2.22',
                  'org.opencontainers.image.revision': 'a' * 40}
        with patch.object(m, '_container', side_effect=[containers[name] for name in names]), \
             patch.object(m, '_image_labels', side_effect=[labels, labels]):
            snapshot = m.capture_runtime('1.2.22', 'a' * 40)
        self.assertEqual(snapshot['app_image_id'], image_ids['app'])
        self.assertEqual(snapshot['worker_image_id'], image_ids['worker'])
        self.assertEqual(snapshot['postgres_container_id'], containers['postgres']['id'])
        self.assertEqual(snapshot['git_worker_container_id'], containers['git-worker']['id'])

        wrong_labels = {**labels, 'org.opencontainers.image.version': '1.2.21'}
        with patch.object(m, '_container', side_effect=[containers[name] for name in names]), \
             patch.object(m, '_image_labels', side_effect=[wrong_labels, labels]), \
             self.assertRaisesRegex(m.InstallerError, 'CURRENT_IMAGE_VERSION_MISMATCH'):
            m.capture_runtime('1.2.22', 'a' * 40)

    def test_unit_hardening_and_worker_smoke_keep_proxy_secret_out_of_argv(self):
        unit = m.build_systemd_unit().decode()
        for setting in ('User=ai-project-os-egress', 'NoNewPrivileges=true',
                        'ProtectSystem=strict', 'PrivateTmp=true', 'CapabilityBoundingSet=',
                        'ExecStartPre=/usr/local/libexec/ai-project-os-egress/mihomo -t'):
            self.assertIn(setting, unit)
        self.assertIn('ReadWritePaths=/var/lib/ai-project-os-egress', unit)
        self.assertNotIn('0.0.0.0', unit)

        script = m.build_worker_smoke_script()
        self.assertIn(b'prepareModelProviderFetch', script)
        self.assertIn(b'OPENAI_EGRESS_RUNTIME_OK', script)
        self.assertIn(b'NODE_USE_ENV_PROXY', script)
        self.assertNotIn(b'process.env.HTTP_PROXY =', script)
        result = subprocess.CompletedProcess([], 0, b'OPENAI_EGRESS_RUNTIME_OK\n', b'')
        with patch.object(m, 'compose_command', return_value=result) as compose:
            m.verify_worker_runtime()
        args = compose.call_args.args
        self.assertEqual(args, ('exec', '-T', 'worker', 'node', '--import', 'tsx', '--input-type=module', '-'))
        self.assertNotIn(b'diagnostic-not-a-real-api-key', repr(args).encode())
        self.assertIn(b'diagnostic-not-a-real-api-key', compose.call_args.kwargs['input_data'])

    def test_fake_bearer_is_sent_inside_https_request_not_plaintext_connect(self):
        class FakeResponse:
            status = 401

            @staticmethod
            def read(_limit):
                return b'{"error":{"code":"invalid_api_key"}}'

        class FakeHTTPSConnection:
            def __init__(self, *_args, **_kwargs):
                self.tunnel_headers = None
                self.request_headers = None

            def set_tunnel(self, _host, _port, headers):
                self.tunnel_headers = headers

            def request(self, _method, _path, *, body, headers):
                self.request_headers = headers

            @staticmethod
            def getresponse():
                return FakeResponse()

            @staticmethod
            def close():
                pass

        connection = FakeHTTPSConnection()
        with patch.object(m.http.client, 'HTTPSConnection', return_value=connection):
            status, _body = m._proxy_https_request(
                '172.20.0.1', 'fixture-user', 'fixture-password', 'api.openai.com',
                'POST', '/v1/chat/completions', b'{}',
                authorization='Bearer diagnostic-not-a-real-api-key')
        self.assertEqual(status, 401)
        self.assertEqual(connection.request_headers['Authorization'],
                         'Bearer diagnostic-not-a-real-api-key')
        self.assertNotIn('Bearer diagnostic-not-a-real-api-key', str(connection.tunnel_headers))

    def test_receipt_schema_has_no_proxy_credentials_or_node_details(self):
        receipt = m.status_receipt('1.2.22', 'a' * 40, 'installed', 'available',
                                   proxy_loc='TW', proxy_colo='TPE', openai_401=True,
                                   non_openai_rejected=True, app_healthy=True,
                                   worker_healthy=True, public_health=True,
                                   database_unchanged=True, git_worker_unchanged=True)
        rendered = json.dumps(receipt)
        for safe in ('1.2.22', 'a' * 40, 'TW', 'TPE', 'openai_401'):
            self.assertIn(safe, rendered)
        for forbidden in ('password', 'proxy_url', '1.1.1.1', 'fixture-node'):
            self.assertNotIn(forbidden, rendered)


class ProxyNonOpenAiDenySmoke(unittest.TestCase):
    class FakeSocket:
        def __init__(self, status):
            reason = 'Connection established' if status == 200 else 'Rejected'
            self.responses = [f'HTTP/1.1 {status} {reason}\r\n\r\n'.encode()]
            self.request = b''
            self.timeout = None

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def settimeout(self, timeout):
            self.timeout = timeout

        def sendall(self, data):
            self.request = data

        def recv(self, _limit):
            return self.responses.pop(0) if self.responses else b''

    class FakeTLSConnection:
        def __init__(self, error=None):
            self.error = error
            self.timeout = None
            self.closed = False

        def settimeout(self, timeout):
            self.timeout = timeout

        def do_handshake(self):
            if self.error is not None:
                raise self.error

        def close(self):
            self.closed = True

    class FakeTLSContext:
        def __init__(self, tls_connection):
            self.tls_connection = tls_connection
            self.arguments = None

        def wrap_socket(self, connection, **kwargs):
            self.arguments = (connection, kwargs)
            return self.tls_connection

    def test_four_xx_connect_response_is_rejected_without_tls(self):
        connection = self.FakeSocket(403)
        with patch.object(m.socket, 'create_connection', return_value=connection), \
                patch.object(ssl, 'create_default_context') as create_context:
            self.assertTrue(m._proxy_non_openai_denied('172.20.0.1', 'fixture-user', 'fixture-password'))
        create_context.assert_not_called()
        self.assertIn(b'CONNECT example.com:443 HTTP/1.1', connection.request)

    def test_connect_200_followed_by_explicit_eof_or_reset_is_rejected(self):
        failures = (
            ssl.SSLEOFError(8, 'unexpected EOF'),
            ssl.SSLZeroReturnError(6, 'closed'),
            ConnectionResetError('reset'),
            BrokenPipeError('closed'),
        )
        for failure in failures:
            with self.subTest(failure=type(failure).__name__):
                connection = self.FakeSocket(200)
                tls = self.FakeTLSConnection(failure)
                context = self.FakeTLSContext(tls)
                with patch.object(m.socket, 'create_connection', return_value=connection), \
                        patch.object(ssl, 'create_default_context', return_value=context):
                    self.assertTrue(m._proxy_non_openai_denied(
                        '172.20.0.1', 'fixture-user', 'fixture-password'))
                self.assertEqual(context.arguments[1], {
                    'server_hostname': 'example.com', 'do_handshake_on_connect': False})
                self.assertEqual(tls.timeout, 10)
                self.assertTrue(tls.closed)

    def test_connect_200_with_successful_tls_handshake_is_not_denied(self):
        connection = self.FakeSocket(200)
        tls = self.FakeTLSConnection()
        context = self.FakeTLSContext(tls)
        with patch.object(m.socket, 'create_connection', return_value=connection), \
                patch.object(ssl, 'create_default_context', return_value=context):
            self.assertFalse(m._proxy_non_openai_denied(
                '172.20.0.1', 'fixture-user', 'fixture-password'))
        self.assertTrue(tls.closed)

    def test_connect_200_timeout_or_certificate_error_is_indeterminate(self):
        failures = (TimeoutError('timed out'), ssl.SSLCertVerificationError(1, 'certificate rejected'))
        for failure in failures:
            with self.subTest(failure=type(failure).__name__):
                connection = self.FakeSocket(200)
                context = self.FakeTLSContext(self.FakeTLSConnection(failure))
                with patch.object(m.socket, 'create_connection', return_value=connection), \
                        patch.object(ssl, 'create_default_context', return_value=context), \
                        self.assertRaisesRegex(m.InstallerError, 'PROXY_REJECT_SMOKE_INDETERMINATE'):
                    m._proxy_non_openai_denied('172.20.0.1', 'fixture-user', 'fixture-password')

    def test_smoke_requires_openai_invalid_key_before_non_openai_deny(self):
        trace = b'h=api.openai.com\nip=203.0.113.8\ncolo=TPE\nloc=TW\n'
        openai_error = b'{"error":{"code":"invalid_api_key"}}'
        calls = []

        def request(_gateway, _username, _password, _host, method, path,
                    body=None, authorization=None):
            calls.append((method, path, body, authorization))
            if method == 'GET':
                return 200, trace
            return 401, openai_error

        with patch.object(m, '_proxy_https_request', side_effect=request), \
                patch.object(m, '_proxy_non_openai_denied', return_value=False) as denied, \
                self.assertRaisesRegex(m.InstallerError, 'NON_OPENAI_NOT_REJECTED'):
            m.verify_proxy_smoke('172.20.0.1', 'fixture-user', 'fixture-password')
        self.assertEqual(calls[1][3], 'Bearer diagnostic-not-a-real-api-key')
        denied.assert_called_once_with('172.20.0.1', 'fixture-user', 'fixture-password')


class RedirectAndCleanupSecurity(unittest.TestCase):
    public_dns = [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('1.1.1.1', 443))]

    def test_health_http_redirects_never_follow_sensitive_or_external_targets(self):
        endpoints = (
            'http://127.0.0.1:3000/api/health',
            'https://ai-project-os.com/api/health',
        )
        destinations = (
            'http://169.254.169.254/latest/meta-data',
            'http://127.0.0.1/private',
            'https://attacker.example/health',
            'http://attacker.example/health',
        )
        for endpoint in endpoints:
            for destination in destinations:
                with self.subTest(endpoint=endpoint, destination=destination):
                    class RedirectingOpener:
                        calls = 0

                        def open(self, request, timeout):
                            self.calls += 1
                            raise m.urllib.error.HTTPError(
                                request.full_url, 302, 'Found', {'Location': destination}, None)

                    opener = RedirectingOpener()
                    with patch.object(m.urllib.request, 'build_opener', return_value=opener) as build, \
                            self.assertRaisesRegex(m.InstallerError, 'HEALTH_REQUEST_FAILED'):
                        m._http_json(endpoint)
                    self.assertEqual(opener.calls, 1)
                    handler = next(argument for argument in build.call_args.args
                                   if isinstance(argument, m.NoRedirectHandler))
                    self.assertIsNone(handler.redirect_request(
                        m.urllib.request.Request(endpoint), None, 302, 'Found',
                        {'Location': destination}, destination))

    def test_official_asset_redirect_is_accepted_with_public_dns(self):
        destination = 'https://release-assets.githubusercontent.com/assets/mihomo.gz?token=fixture'
        handler = m.MihomoRedirectHandler()
        request = m.urllib.request.Request(m.MIHOMO_URL)
        with patch.object(m.socket, 'getaddrinfo', return_value=self.public_dns) as resolver:
            redirected = handler.redirect_request(
                request, None, 302, 'Found', {'Location': destination}, destination)
        self.assertEqual(redirected.full_url, destination)
        resolver.assert_called_once_with('release-assets.githubusercontent.com', 443,
                                         type=socket.SOCK_STREAM)

    def test_asset_redirect_rejects_http_userinfo_nonstandard_port_and_unapproved_host(self):
        invalid_urls = (
            'http://release-assets.githubusercontent.com/assets/mihomo.gz',
            'https://user@release-assets.githubusercontent.com/assets/mihomo.gz',
            'https://release-assets.githubusercontent.com:444/assets/mihomo.gz',
            'https://attacker.example/assets/mihomo.gz',
            'https://192.168.1.10/assets/mihomo.gz',
        )
        for url in invalid_urls:
            with self.subTest(url=url), patch.object(m.socket, 'getaddrinfo', return_value=self.public_dns), \
                    self.assertRaisesRegex(m.InstallerError, 'MIHOMO_REDIRECT_URL_INVALID'):
                m._validate_mihomo_asset_url(url)

    def test_asset_url_and_redirect_reject_non_global_dns(self):
        destination = 'https://objects.githubusercontent.com/assets/mihomo.gz'
        for address in ('127.0.0.1', '10.0.0.1', '169.254.169.254'):
            private_dns = [(socket.AF_INET, socket.SOCK_STREAM, 6, '', (address, 443))]
            with self.subTest(address=address), patch.object(m.socket, 'getaddrinfo', return_value=private_dns), \
                    self.assertRaisesRegex(m.InstallerError, 'MIHOMO_REDIRECT_DNS_INVALID'):
                m._validate_mihomo_asset_url(m.MIHOMO_URL)

            with self.subTest(redirect_address=address), \
                    patch.object(m.socket, 'getaddrinfo', return_value=private_dns), \
                    self.assertRaisesRegex(m.InstallerError, 'MIHOMO_REDIRECT_DNS_INVALID'):
                m.MihomoRedirectHandler().redirect_request(
                    m.urllib.request.Request(m.MIHOMO_URL), None, 302, 'Found',
                    {'Location': destination}, destination)

    def test_asset_redirect_count_is_bounded(self):
        destination = 'https://objects.githubusercontent.com/assets/mihomo.gz'
        request = m.urllib.request.Request(m.MIHOMO_URL)
        handler = m.MihomoRedirectHandler()
        with patch.object(m.socket, 'getaddrinfo', return_value=self.public_dns) as resolver:
            for _ in range(m.MAX_MIHOMO_REDIRECTS):
                request = handler.redirect_request(
                    request, None, 302, 'Found', {'Location': destination}, destination)
            with self.assertRaisesRegex(m.InstallerError, 'MIHOMO_REDIRECT_LIMIT'):
                handler.redirect_request(
                    request, None, 302, 'Found', {'Location': destination}, destination)
        self.assertEqual(resolver.call_count, m.MAX_MIHOMO_REDIRECTS)

    def test_download_opener_uses_fixed_asset_url_and_validating_redirect_handler(self):
        class StopBeforeNetwork:
            @staticmethod
            def open(_request, timeout):
                raise m.InstallerError('TEST_STOP_BEFORE_NETWORK')

        with patch.object(m.platform, 'system', return_value='Linux'), \
                patch.object(m.platform, 'machine', return_value='x86_64'), \
                patch.object(m.socket, 'getaddrinfo', return_value=self.public_dns), \
                patch.object(m.urllib.request, 'build_opener', return_value=StopBeforeNetwork()) as build, \
                self.assertRaisesRegex(m.InstallerError, 'TEST_STOP_BEFORE_NETWORK'):
            m.download_mihomo()
        self.assertTrue(any(isinstance(argument, m.MihomoRedirectHandler)
                           for argument in build.call_args.args))

    def test_cleanup_removes_only_exact_owned_dangling_unit_link_and_reports_incomplete(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            unit = root / 'ai-project-os-openai-egress.service'
            link_dir = root / 'multi-user.target.wants'
            link_dir.mkdir()
            link = link_dir / unit.name
            link.symlink_to(Path('../' + unit.name))
            original_lstat = Path.lstat

            def root_owned_link(path, *args, **kwargs):
                result = original_lstat(path, *args, **kwargs)
                if path == link:
                    return SimpleNamespace(st_mode=result.st_mode, st_uid=0)
                return result

            with patch.object(m, 'UNIT', unit), patch.object(m, 'UNIT_LINK', link), \
                    patch.object(Path, 'lstat', root_owned_link), patch.object(m, 'systemctl') as systemctl:
                self.assertFalse(m.cleanup_managed_installation({}))
            self.assertFalse(link.is_symlink())
            self.assertFalse(unit.exists())
            systemctl.assert_called_once_with('daemon-reload', code='SYSTEMD_RELOAD_FAILED')

    def test_cleanup_preserves_dangling_link_with_unexpected_target(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            unit = root / 'ai-project-os-openai-egress.service'
            other = root / 'unrelated.service'
            link_dir = root / 'multi-user.target.wants'
            link_dir.mkdir()
            link = link_dir / unit.name
            link.symlink_to(other)
            original_lstat = Path.lstat

            def root_owned_link(path, *args, **kwargs):
                result = original_lstat(path, *args, **kwargs)
                if path == link:
                    return SimpleNamespace(st_mode=result.st_mode, st_uid=0)
                return result

            with patch.object(m, 'UNIT', unit), patch.object(m, 'UNIT_LINK', link), \
                    patch.object(Path, 'lstat', root_owned_link), patch.object(m, 'systemctl') as systemctl:
                self.assertFalse(m.cleanup_managed_installation({}))
            self.assertTrue(link.is_symlink())
            self.assertEqual(os.readlink(link), str(other))
            systemctl.assert_not_called()

    def test_cleanup_with_missing_unit_and_link_refuses_active_installed_service(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            unit = root / 'ai-project-os-openai-egress.service'
            link = root / 'multi-user.target.wants' / unit.name
            active = subprocess.CompletedProcess([], 0)
            with patch.object(m, 'UNIT', unit), patch.object(m, 'UNIT_LINK', link), \
                    patch.object(m, 'systemctl', return_value=active) as systemctl, \
                    patch.object(m, '_remove_managed_file') as remove_file:
                self.assertFalse(m.cleanup_managed_installation({'phase': 'proxy_started'}))
            systemctl.assert_called_once_with(
                'is-active', '--quiet', unit.name, code='SYSTEMD_ACTIVITY_CHECK_FAILED',
                allowed_statuses=frozenset((0, 3, 4)))
            remove_file.assert_not_called()

    def test_cleanup_before_unit_creation_does_not_probe_missing_service(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            unit = root / 'ai-project-os-openai-egress.service'
            link = root / 'multi-user.target.wants' / unit.name
            with patch.object(m, 'UNIT', unit), patch.object(m, 'UNIT_LINK', link), \
                    patch.object(m, 'systemctl') as systemctl:
                self.assertTrue(m.cleanup_managed_installation({'phase': 'binary_installed'}))
            systemctl.assert_not_called()


if __name__ == '__main__':
    unittest.main(verbosity=2)
