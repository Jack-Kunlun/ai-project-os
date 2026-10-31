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
    def test_container_query_requests_full_id_before_identity_validation(self):
        identity = 'a' * 64

        def docker_output(command, **kwargs):
            self.assertIn(f'label=com.docker.compose.project={m.PROJECT}', command)
            self.assertIn('label=com.docker.compose.service=app', command)
            return identity if '--no-trunc' in command else identity[:12]

        with patch.object(m, 'command_text', side_effect=docker_output):
            self.assertEqual(m._container_ids('app'), [identity])

    def test_container_query_still_rejects_missing_ambiguous_or_short_ids(self):
        for output in ('', 'a' * 12, 'a' * 64 + '\n' + 'b' * 64, 'z' * 64):
            with self.subTest(output=output), \
                    patch.object(m, 'command_text', return_value=output), \
                    self.assertRaisesRegex(m.InstallerError, 'CONTAINER_IDENTITY_INVALID'):
                m._container_ids('app')

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
                         ('up', '-d', '--no-deps', '--no-build', '--force-recreate',
                          '--wait', '--wait-timeout', '300', 'app', 'worker'))
        self.assertEqual(compose.call_args.kwargs['pin_file'], Path('/private/pin.yaml'))
        self.assertGreater(compose.call_args.kwargs['timeout'], 300)
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
                                   database_unchanged=True, git_worker_unchanged=True,
                                   firewall_rule_added=True, bridge_reachable=True)
        rendered = json.dumps(receipt)
        for safe in ('1.2.22', 'a' * 40, 'TW', 'TPE', 'openai_401'):
            self.assertIn(safe, rendered)
        for forbidden in ('password', 'proxy_url', '1.1.1.1', 'fixture-node', '172.20.0.1'):
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


class UfwBridgeIntegration(unittest.TestCase):
    binding = {'network_id': 'a' * 64, 'interface': 'br-aaaaaaaaaaaa',
               'subnet': '172.20.0.0/16', 'gateway': '172.20.0.1'}
    comment = m.UFW_OWNER_PREFIX + 'b' * 24

    @classmethod
    def raw(cls, owner=False, *, policy='DROP', extra=()):
        lines = [
            'IPV4 (filter)',
            f'Chain INPUT (policy {policy} 0 packets, 0 bytes)',
            'Chain FORWARD (policy DROP 0 packets, 0 bytes)',
            'Chain OUTPUT (policy ACCEPT 0 packets, 0 bytes)',
            'Chain ufw-user-input (1 references)',
            'pkts bytes target prot opt in out source destination',
            '0 0 ACCEPT tcp -- * * 0.0.0.0/0 0.0.0.0/0 tcp dpt:443',
        ]
        if owner:
            lines.append('0 0 ACCEPT tcp -- br-aaaaaaaaaaaa * 172.20.0.0/16 '
                         '172.20.0.1 tcp dpt:17890')
        lines.extend(extra)
        lines.extend([
            'IPV6 (filter)',
            'Chain INPUT (policy DROP 0 packets, 0 bytes)',
            'Chain FORWARD (policy DROP 0 packets, 0 bytes)',
            'Chain OUTPUT (policy ACCEPT 0 packets, 0 bytes)',
            'Chain ufw6-user-input (1 references)',
            'pkts bytes target prot opt in out source destination',
        ])
        return '\n'.join(lines)

    @classmethod
    def status(cls, *, active=True, incoming='deny'):
        return ('Status: active\n' if active else 'Status: inactive\n') + (
            f'Default: {incoming} (incoming), allow (outgoing), deny (routed)\n')

    @classmethod
    def snapshot(cls, *, owner=False, extra_added=(), extra_raw=()):
        added = ['ufw allow 22/tcp comment SSH', 'ufw allow 80/tcp comment HTTP',
                 'ufw allow 443/tcp comment HTTPS', *extra_added]
        raw = m._normalize_ufw_raw(cls.raw(owner, extra=extra_raw))
        return {'added': added, 'raw': raw}

    def test_bridge_identity_requires_compose_bridge_and_matching_host_gateway(self):
        network = {
            'Name': m.NETWORK_NAME, 'Driver': 'bridge', 'Id': 'a' * 64,
            'Internal': False, 'Labels': {'com.docker.compose.project': m.PROJECT,
                                         'com.docker.compose.network': 'default'},
            'Options': {}, 'IPAM': {'Config': [{'Subnet': '172.20.0.0/16',
                                               'Gateway': '172.20.0.1'}]},
            'Containers': {'c' * 64: {}, 'd' * 64: {}},
        }
        runtime = {'app_container_id': 'c' * 64, 'worker_container_id': 'd' * 64}
        with patch.object(m, 'docker_json', return_value=[network]), \
                patch.object(m, 'validate_host_bridge') as validate:
            result = m.docker_network_binding(runtime)
        self.assertEqual(result, {'network_id': 'a' * 64, 'interface': 'br-aaaaaaaaaaaa',
                                  'subnet': '172.20.0.0/16', 'gateway': '172.20.0.1'})
        validate.assert_called_once_with(result)

        invalid_networks = [
            ({'Driver': 'overlay'}, 'DOCKER_NETWORK_PROJECT_INVALID'),
            ({'IPAM': {'Config': [{'Subnet': '203.0.113.0/24',
                                   'Gateway': '203.0.113.1'}]}}, 'DOCKER_GATEWAY_NOT_RFC1918'),
            ({'Options': {'com.docker.network.bridge.name': 'bad/name'}},
             'DOCKER_BRIDGE_NAME_INVALID'),
            ({'Containers': {'c' * 64: {}}}, 'APPLICATION_NETWORK_BINDING_INVALID'),
        ]
        for changes, expected in invalid_networks:
            invalid = {**network, **changes}
            with patch.object(m, 'docker_json', return_value=[invalid]), \
                    self.assertRaisesRegex(m.InstallerError, expected):
                m.docker_network_binding(runtime)

    def test_host_bridge_requires_kernel_bridge_kind_and_exact_ipv4_gateway(self):
        link = [{'ifname': self.binding['interface'],
                 'linkinfo': {'info_kind': 'bridge'}}]
        address = [{'ifname': self.binding['interface'], 'addr_info': [
            {'family': 'inet', 'local': self.binding['gateway'], 'prefixlen': 16}]}]
        with patch.object(m, 'command_text', side_effect=[json.dumps(link), json.dumps(address)]) as query:
            m.validate_host_bridge(self.binding)
        self.assertEqual(query.call_count, 2)
        for bad_link, bad_address, expected in (
                ([{'ifname': self.binding['interface'], 'linkinfo': {'info_kind': 'dummy'}}],
                 address, 'DOCKER_BRIDGE_LINK_INVALID'),
                (link, [{'ifname': self.binding['interface'], 'addr_info': [
                    {'family': 'inet', 'local': '172.20.0.2', 'prefixlen': 16}]}],
                 'DOCKER_BRIDGE_ADDRESS_MISMATCH')):
            with patch.object(m, 'command_text', side_effect=[json.dumps(bad_link),
                                                                json.dumps(bad_address)]), \
                    self.assertRaisesRegex(m.InstallerError, expected):
                m.validate_host_bridge(self.binding)

    def test_ufw_executable_and_config_must_be_trusted_root_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            root.chmod(0o755)
            executable = root / 'ufw'
            config = root / 'ufw.conf'
            executable.write_text('fixture')
            config.write_text('fixture')
            executable.chmod(0o755)
            config.chmod(0o644)
            original_lstat = Path.lstat

            def root_owned(path, *args, **kwargs):
                info = original_lstat(path, *args, **kwargs)
                return SimpleNamespace(st_mode=info.st_mode, st_uid=0, st_gid=0, st_nlink=1)

            with patch.object(m, 'UFW', executable), patch.object(m, 'UFW_CONFIG_FILES', (config,)), \
                    patch.object(m, 'UFW_DIRECTORIES', (root,)), \
                    patch.object(Path, 'lstat', root_owned):
                m._check_ufw_files()
                config.chmod(0o664)
                with self.assertRaisesRegex(m.InstallerError, 'UFW_FILES_UNTRUSTED'):
                    m._check_ufw_files()
                config.chmod(0o644)
                config.unlink()
                config.symlink_to(executable)
                with self.assertRaisesRegex(m.InstallerError, 'UFW_FILES_UNTRUSTED'):
                    m._check_ufw_files()

    def test_effective_ufw_must_be_active_deny_and_have_supported_raw_policy(self):
        baseline = self.snapshot()
        added = '\n'.join(baseline['added'])
        raw = self.raw()
        for status, raw_value, expected in (
                (self.status(active=False), raw, 'UFW_POLICY_UNSUPPORTED'),
                (self.status(incoming='allow'), raw, 'UFW_POLICY_UNSUPPORTED'),
                (self.status(), self.raw(policy='ACCEPT'), 'UFW_EFFECTIVE_INPUT_POLICY_UNSUPPORTED')):
            with patch.object(m, '_check_ufw_files'), \
                    patch.object(m, 'command_text', side_effect=[status, added, raw_value]), \
                    self.assertRaisesRegex(m.InstallerError, expected):
                m._ufw_snapshot(self.binding)

    def test_existing_exact_and_ambiguous_port_rules_refuse_without_adoption(self):
        exact = 'ufw allow in on br-aaaaaaaaaaaa proto tcp from 172.20.0.0/16 '
        exact += 'to 172.20.0.1 port 17890 comment old-owner'
        ranged = 'ufw allow 17880:17900/tcp comment broad-range'
        for rule in (exact, ranged, 'ufw allow from any comment all-ports'):
            snapshot = self.snapshot(extra_added=(rule,))
            with self.subTest(rule=rule), self.assertRaisesRegex(
                    m.InstallerError, 'UFW_EXISTING_PORT_RULE_CONFLICT'):
                m._validate_no_ufw_conflict(snapshot, self.binding)

    def test_exact_add_delta_changes_only_one_ipv4_rule_and_does_not_open_ipv6(self):
        before = self.snapshot()
        firewall = m._firewall_binding_state(self.binding, self.comment, before)
        after = self.snapshot(owner=True, extra_added=(m._firewall_rule_line(firewall),))
        self.assertTrue(m._exact_firewall_add_delta(before, after, firewall))
        changed_ipv6 = copy.deepcopy(after)
        changed_ipv6['raw']['ipv6'].append('ACCEPT tcp -- * * ::/0 ::/0 tcp dpt:17890')
        self.assertFalse(m._exact_firewall_add_delta(before, changed_ipv6, firewall))

    def test_worker_access_adds_exact_rule_and_requires_post_add_tcp_success(self):
        before = self.snapshot()
        firewall = m._firewall_binding_state(self.binding, self.comment, before)
        after = self.snapshot(owner=True, extra_added=(m._firewall_rule_line(firewall),))
        state = {'phase': 'proxy_verified',
                 'firewall': {'status': 'pending', 'rule_added': None, 'bridge_reachable': None}}
        runtime = {'worker_container_id': 'd' * 64}
        persisted = []
        with patch.object(m, '_ufw_snapshot', side_effect=[before, after]), \
                patch.object(m, '_bridge_tcp_probe', side_effect=[False, True]), \
                patch.object(m.secrets, 'token_hex', return_value='b' * 24), \
                patch.object(m, 'run_command') as run, \
                patch.object(m, 'write_private_state',
                             side_effect=lambda value: persisted.append(copy.deepcopy(value))) as write:
            m._ensure_worker_bridge_access(state, runtime, self.binding, before)
        args = run.call_args.args[0]
        self.assertEqual(args, [str(m.UFW), 'allow', 'in', 'on', self.binding['interface'],
                                'from', self.binding['subnet'], 'to', self.binding['gateway'],
                                'port', '17890', 'proto', 'tcp', 'comment', self.comment])
        self.assertEqual(state['phase'], 'bridge_verified')
        self.assertEqual(state['firewall']['status'], 'added')
        self.assertTrue(state['firewall']['bridge_reachable'])
        self.assertEqual(write.call_count, 3)
        self.assertEqual([item['phase'] for item in persisted],
                         ['firewall_intent', 'firewall_added', 'bridge_verified'])
        self.assertEqual(persisted[0]['firewall']['status'], 'intent')

    def test_post_add_tcp_failure_leaves_recoverable_owned_intent_for_rollback(self):
        before = self.snapshot()
        firewall = m._firewall_binding_state(self.binding, self.comment, before)
        after = self.snapshot(owner=True, extra_added=(m._firewall_rule_line(firewall),))
        state = {'phase': 'proxy_verified',
                 'firewall': {'status': 'pending', 'rule_added': None, 'bridge_reachable': None}}
        with patch.object(m, '_ufw_snapshot', side_effect=[before, after]), \
                patch.object(m, '_bridge_tcp_probe', side_effect=[False, False]), \
                patch.object(m.secrets, 'token_hex', return_value='b' * 24), \
                patch.object(m, 'run_command'), patch.object(m, 'write_private_state'), \
                self.assertRaisesRegex(m.InstallerError, 'WORKER_BRIDGE_UNREACHABLE'):
            m._ensure_worker_bridge_access(state, {'worker_container_id': 'd' * 64},
                                           self.binding, before)
        self.assertEqual(state['firewall']['status'], 'added')
        self.assertTrue(state['firewall']['rule_added'])

    def test_rollback_deletes_only_owned_rule_and_preserves_unrelated_rule_edits(self):
        before = self.snapshot()
        firewall = m._firewall_binding_state(self.binding, self.comment, before)
        installed = self.snapshot(owner=True, extra_added=(m._firewall_rule_line(firewall),))
        concurrent = copy.deepcopy(installed)
        concurrent['added'].append('ufw allow 8080/tcp comment operator-change')
        concurrent['raw']['ipv4'].append(
            'ACCEPT tcp -- * * 0.0.0.0/0 0.0.0.0/0 tcp dpt:8080')
        after_delete = copy.deepcopy(concurrent)
        after_delete['added'].remove(m._firewall_rule_line(firewall))
        after_delete['raw']['ipv4'].remove(next(
            line for line in after_delete['raw']['ipv4'] if m._raw_line_is_owned_rule(line, firewall)))
        state = {'phase': 'firewall_added', 'status': 'rollback_incomplete', 'firewall': {
            **firewall, 'status': 'added', 'rule_added': True, 'bridge_reachable': True}}
        with patch.object(m, '_ufw_snapshot', side_effect=[concurrent, after_delete]), \
                patch.object(m, 'run_command') as run, patch.object(m, 'write_private_state'):
            self.assertTrue(m.cleanup_owned_firewall_rule(state))
        self.assertEqual(run.call_args.args[0], [str(m.UFW), '--force', 'delete', 'allow', 'in',
                                                'on', self.binding['interface'],
                                                'from', self.binding['subnet'], 'to', self.binding['gateway'],
                                                'port', '17890', 'proto', 'tcp', 'comment', self.comment])
        self.assertIn('ufw allow 8080/tcp comment operator-change', after_delete['added'])
        self.assertEqual(state['firewall']['status'], 'removed')

    def test_tampered_owned_raw_rule_fails_incomplete_without_delete(self):
        before = self.snapshot()
        firewall = m._firewall_binding_state(self.binding, self.comment, before)
        drift = self.snapshot(extra_added=(m._firewall_rule_line(firewall),))
        state = {'phase': 'firewall_added', 'firewall': {
            **firewall, 'status': 'added', 'rule_added': True, 'bridge_reachable': True}}
        with patch.object(m, '_ufw_snapshot', return_value=drift), \
                patch.object(m, 'run_command') as run:
            self.assertFalse(m.cleanup_owned_firewall_rule(state))
        run.assert_not_called()

    def test_ufw_0362_raw_and_added_normalization_matches_cli_contract(self):
        self.assertEqual(m._normalize_ufw_added(
            "Added user rules (see 'ufw status' for running firewall):\n(None)\n"), [])
        actual_added = ("Added user rules (see 'ufw status' for running firewall):\n"
                        "ufw allow in on br-aios-probe from 172.30.0.0/24 to 172.30.0.1 "
                        "port 17890 proto tcp comment 'ai-project-os-fixture-A'\n")
        self.assertEqual(m._normalize_ufw_added(actual_added), [
            'ufw allow in on br-aios-probe from 172.30.0.0/24 to 172.30.0.1 '
            'port 17890 proto tcp comment ai-project-os-fixture-A'])
        raw_before = ('IPV4 (raw):\nChain INPUT (policy DROP 0 packets, 0 bytes)\n'
                      'Chain FORWARD (policy DROP 0 packets, 0 bytes)\n'
                      'Chain INPUT (policy ACCEPT 0 packets, 0 bytes)\n'
                      'Chain ufw-user-input (1 references)\n'
                      '       pkts bytes target prot opt in out source destination\n'
                      '       0 0 DROP 6 -- * * 0.0.0.0/0 0.0.0.0/0 tcp dpt:22\n'
                      'IPV6:\nChain INPUT (policy DROP 0 packets, 0 bytes)\n'
                      'Chain FORWARD (policy DROP 0 packets, 0 bytes)\n')
        raw_owned = raw_before.replace(
            '       0 0 DROP 6 -- * * 0.0.0.0/0 0.0.0.0/0 tcp dpt:22',
            '       0 0 DROP 6 -- * * 0.0.0.0/0 0.0.0.0/0 tcp dpt:22\n'
            '       0 0 ACCEPT 6 -- br-aios-probe * 172.30.0.0/24 172.30.0.1 tcp dpt:17890')
        before = m._normalize_ufw_raw(raw_before)
        after = m._normalize_ufw_raw(raw_owned)
        self.assertEqual(before['input_policy'], 'DROP')
        self.assertEqual(before['forward_policy'], 'DROP')
        firewall = {'interface': 'br-aios-probe', 'subnet': '172.30.0.0/24',
                    'gateway': '172.30.0.1', 'comment': 'ai-project-os-fixture-A'}
        self.assertTrue(any(m._raw_line_is_owned_rule(line, firewall) for line in after['ipv4']))

    def test_recorded_ufw_0362_fixture_roundtrips_add_delete_and_comment_conflicts(self):
        fixture_path = Path(__file__).parent / 'fixtures/openai-egress-ufw36.json'
        fixture = json.loads(fixture_path.read_text())['cases']
        binding = {'interface': 'br-aios-probe', 'subnet': '172.30.0.0/24',
                   'gateway': '172.30.0.1'}
        owner = {'interface': binding['interface'], 'subnet': binding['subnet'],
                 'gateway': binding['gateway'], 'comment': 'ai-project-os-fixture-A'}
        before = {'added': m._normalize_ufw_added(fixture['added_before']['stdout']),
                  'raw': m._normalize_ufw_raw(fixture['raw_before']['stdout'])}
        installed = {'added': m._normalize_ufw_added(fixture['added_owned']['stdout']),
                     'raw': m._normalize_ufw_raw(fixture['raw_owned']['stdout'])}
        deleted = {'added': m._normalize_ufw_added(fixture['added_after_delete']['stdout']),
                   'raw': m._normalize_ufw_raw(fixture['raw_after_delete']['stdout'])}
        self.assertEqual(before['raw']['input_policy'], 'DROP')
        self.assertEqual(before['raw']['forward_policy'], 'DROP')
        self.assertTrue(m._exact_firewall_add_delta(before, installed, owner))
        self.assertEqual(m._snapshot_owned_rule(installed, owner), (1, 1))
        delete_before = copy.deepcopy(deleted)
        delete_before['added'].append(m._firewall_rule_line(owner))
        delete_before['raw']['ipv4'].append(next(
            line for line in installed['raw']['ipv4'] if m._raw_line_is_owned_rule(line, owner)))
        self.assertTrue(m._validate_exact_firewall_deletion(delete_before, deleted, owner))
        self.assertNotIn(m._firewall_rule_line(owner), deleted['added'])

        changed_comment = m._normalize_ufw_added(fixture['added_changed_comment']['stdout'])
        with self.assertRaisesRegex(m.InstallerError, 'UFW_EXISTING_PORT_RULE_CONFLICT'):
            m._validate_no_ufw_conflict({'added': changed_comment, 'raw': before['raw']}, binding)
        ranged = m._normalize_ufw_added(fixture['added_with_range']['stdout'])
        with self.assertRaisesRegex(m.InstallerError, 'UFW_EXISTING_PORT_RULE_CONFLICT'):
            m._validate_no_ufw_conflict({'added': ranged, 'raw': installed['raw']}, binding)
        after_old_comment_delete = m._normalize_ufw_added(
            fixture['added_after_old_comment_delete']['stdout'])
        self.assertTrue(any('ai-project-os-fixture-B' in line for line in after_old_comment_delete))

    def test_rollback_requires_postdelete_absence_not_success_exit_code_alone(self):
        before = self.snapshot()
        firewall = m._firewall_binding_state(self.binding, self.comment, before)
        installed = self.snapshot(owner=True, extra_added=(m._firewall_rule_line(firewall),))
        state = {'phase': 'firewall_added', 'firewall': {
            **firewall, 'status': 'added', 'rule_added': True, 'bridge_reachable': True}}
        with patch.object(m, '_ufw_snapshot', side_effect=[installed, installed]), \
                patch.object(m, 'run_command', return_value=subprocess.CompletedProcess([], 0)), \
                patch.object(m, 'write_private_state'):
            self.assertFalse(m.cleanup_owned_firewall_rule(state))

    def test_legacy_private_state_without_firewall_journal_remains_valid(self):
        proxy = 'http://fixture_user_123456:fixture_password_12345678901234567890@172.20.0.1:17890'
        image_a = 'sha256:' + '1' * 64
        image_b = 'sha256:' + '2' * 64
        baseline = {'version': '1.2.22', 'revision': 'a' * 40,
                    'app_image_id': image_a, 'worker_image_id': image_b,
                    'postgres_image_id': 'sha256:' + '3' * 64,
                    'git_worker_image_id': 'sha256:' + '4' * 64,
                    'app_container_id': '5' * 64, 'worker_container_id': '6' * 64,
                    'postgres_container_id': '7' * 64, 'git_worker_container_id': '8' * 64}
        state = {'schema': 1, 'status': 'prepared', 'phase': 'preparing',
                 'version': '1.2.22', 'revision': 'a' * 40,
                 'installed_value': proxy,
                 'installed_value_sha256': m.sha256_bytes(proxy.encode()),
                 'app_image_id': image_a, 'worker_image_id': image_b,
                 'gateway_ip': '172.20.0.1', 'mihomo_sha256': '9' * 64,
                 'config_sha256': 'a' * 64, 'unit_sha256': 'b' * 64,
                 'baseline_runtime': baseline, 'previous_line_b64': None,
                 'append_separator_added': False, 'append_previous_last_line_b64': None,
                 'created_directories': [], 'egress_uid': None, 'egress_gid': None,
                 'smoke': {}}
        self.assertNotIn('firewall', m.validate_private_state(state))
        state_with_pending = {**state, 'firewall': {
            'status': 'pending', 'rule_added': None, 'bridge_reachable': None}}
        self.assertEqual(m.validate_private_state(state_with_pending)['firewall']['status'], 'pending')

    def test_worker_bridge_probe_uses_only_validated_worker_id_and_bounded_timeout(self):
        worker_id = 'd' * 64
        success = subprocess.CompletedProcess([], 0, b'OPENAI_EGRESS_BRIDGE_TCP_OK\n', b'')
        with patch.object(m, 'run_command', return_value=success) as run:
            self.assertTrue(m._bridge_tcp_probe(worker_id, self.binding['gateway']))
        args = run.call_args.args[0]
        self.assertEqual(args[:5], [m.DOCKER, 'exec', worker_id, m.TIMEOUT, '8'])
        self.assertEqual(args[-2:], [self.binding['gateway'], '17890'])
        self.assertEqual(run.call_args.kwargs['timeout'], 12)
        self.assertNotIn('password', repr(args))
        blocked = subprocess.CompletedProcess([], 10, b'OPENAI_EGRESS_BRIDGE_TCP_BLOCKED\n', b'')
        with patch.object(m, 'run_command', return_value=blocked):
            self.assertFalse(m._bridge_tcp_probe(worker_id, self.binding['gateway']))

    def test_worker_bridge_failure_prevents_environment_mutation(self):
        runtime = {'app_container_id': 'c' * 64, 'worker_container_id': 'd' * 64,
                   'app_image_id': 'sha256:' + '1' * 64,
                   'worker_image_id': 'sha256:' + '2' * 64,
                   'postgres_container_id': 'e' * 64, 'postgres_image_id': 'sha256:' + '3' * 64,
                   'git_worker_container_id': 'f' * 64, 'git_worker_image_id': 'sha256:' + '4' * 64}
        payload = {'node': {'cipher': 'chacha20-ietf-poly1305', 'name': 'fixture',
                            'password': 'not-a-real-node-password', 'port': 443,
                            'server': '1.1.1.1', 'type': 'ss', 'udp': True}}
        group = SimpleNamespace(gr_gid=901)
        user = SimpleNamespace(pw_uid=901)
        env_info = SimpleNamespace(st_dev=1, st_ino=2, st_size=3, st_mtime_ns=4, st_ctime_ns=5)
        with patch.object(m, 'preflight', return_value=(payload, runtime, self.binding,
                                                        self.snapshot(), b'OTHER=value\n', env_info, None)), \
                patch.object(m, 'write_status'), patch.object(m, 'download_mihomo', return_value=(b'binary', '9' * 64)), \
                patch.object(m, '_existing_account', return_value=(None, None)), \
                patch.object(m, 'create_account_if_missing', return_value=(user, group, True)), \
                patch.object(m, 'install_directories'), patch.object(m, 'install_binary'), \
                patch.object(m, '_write_managed_file'), patch.object(m, 'config_test'), \
                patch.object(m, 'start_proxy_service'), patch.object(m, '_wait_listener'), \
                patch.object(m, 'verify_proxy_smoke', return_value={'proxy_loc': 'TW',
                                                                    'proxy_colo': 'TPE',
                                                                    'openai_401': True,
                                                                    'non_openai_rejected': True}), \
                patch.object(m, '_ensure_worker_bridge_access',
                             side_effect=m.InstallerError('WORKER_BRIDGE_UNREACHABLE')), \
                patch.object(m, 'write_private_state'), patch.object(m, 'rollback_state', return_value=True), \
                patch.object(m, 'safe_env_write') as env_write, \
                self.assertRaisesRegex(m.InstallerError, 'WORKER_BRIDGE_UNREACHABLE'):
            m.apply_installation('1.2.22', 'a' * 40, '/private/payload', 'b' * 64)
        env_write.assert_not_called()


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
