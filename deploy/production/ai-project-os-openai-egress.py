#!/usr/bin/python3
"""Root-only, rollback-capable OpenAI egress installer for the production host."""
from __future__ import annotations

import argparse
import base64
import fcntl
import gzip
import hashlib
import http.client
import io
import ipaddress
import json
import os
import platform
from pathlib import Path
import pwd
import re
import secrets
import socket
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

ROOT = Path('/srv/ai-project-os/repository')
ENV = Path('/etc/ai-project-os/production.env')
OVERRIDE = Path('/etc/ai-project-os/compose.operations.yaml')
LOCK = Path('/run/lock/ai-project-os-deploy.lock')
PROJECT = 'ai-project-os'
NETWORK_NAME = 'ai-project-os_default'
EGRESS_ACCOUNT = 'ai-project-os-egress'
EGRESS_GROUP = 'ai-project-os-egress'
ETC_DIR = Path('/etc/ai-project-os-egress')
CONFIG = ETC_DIR / 'mihomo.json'
DATA_DIR = Path('/var/lib/ai-project-os-egress')
PRIVATE_DIR = Path('/var/lib/ai-project-os-openai-egress-private')
PRIVATE_STATE = PRIVATE_DIR / 'state.json'
STATUS_DIR = Path('/var/lib/ai-project-os-openai-egress-status')
STATUS_FILE = STATUS_DIR / 'status.json'
BIN_DIR = Path('/usr/local/libexec/ai-project-os-egress')
MIHOMO = BIN_DIR / 'mihomo'
UNIT = Path('/etc/systemd/system/ai-project-os-openai-egress.service')
UNIT_LINK = Path('/etc/systemd/system/multi-user.target.wants/ai-project-os-openai-egress.service')
UNIT_INSTALLED_PHASES = frozenset((
    'unit_installed', 'proxy_started', 'proxy_verified', 'env_written',
    'compose_attempted', 'app_worker_recreated', 'verified',
))
PROXY_ENV_KEY = 'AI_PROJECT_OS_OPENAI_PROXY_URL'
PROXY_ENV_BYTES = PROXY_ENV_KEY.encode('ascii')
PORT = 17890
TRACE_URL = 'https://api.openai.com/cdn-cgi/trace'
OPENAI_ENDPOINT = 'https://api.openai.com/v1/chat/completions'
DIRECT_TRACE_URL = 'https://www.cloudflare.com/cdn-cgi/trace'
MIHOMO_VERSION = 'v1.19.33'
MIHOMO_URL = ('https://github.com/MetaCubeX/mihomo/releases/download/'
              'v1.19.33/mihomo-linux-amd64-compatible-v1.19.33.gz')
MIHOMO_COMPRESSED_SIZE = 22893972
MIHOMO_COMPRESSED_SHA256 = '386508bfb1c72c43b6a0eda73708ecdce82546581b0ebcb16366c53757c622b6'
MIHOMO_REDIRECT_HOSTS = frozenset((
    'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com',
))
MAX_MIHOMO_REDIRECTS = 5
MAX_MIHOMO_BINARY = 192 * 1024 * 1024
MAX_NODE_PAYLOAD = 64 * 1024
MAX_TRACE_BYTES = 8 * 1024
EXPECTED_NODE_KEYS = frozenset(('cipher', 'name', 'password', 'port', 'server', 'type', 'udp'))
SHADOWSOCKS_CIPHERS = frozenset((
    'aes-128-gcm', 'aes-192-gcm', 'aes-256-gcm',
    'aes-128-cfb', 'aes-192-cfb', 'aes-256-cfb',
    'aes-128-ctr', 'aes-192-ctr', 'aes-256-ctr',
    'rc4-md5', 'chacha20-ietf', 'xchacha20',
    'chacha20-ietf-poly1305', 'xchacha20-ietf-poly1305',
    '2022-blake3-aes-128-gcm', '2022-blake3-aes-256-gcm',
    '2022-blake3-chacha20-poly1305',
))
HEX40 = re.compile(r'^[a-f0-9]{40}$')
HEX64 = re.compile(r'^[a-f0-9]{64}$')
VERSION = re.compile(r'^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$')
ASSIGNMENT = re.compile(rb'^([A-Z][A-Z0-9_]*)=([^\r\n]*)(\r?\n)?$')
PROXY_URL_PATTERN = re.compile(r'^http://[A-Za-z0-9_-]{16,64}:[A-Za-z0-9_-]{32,64}@([0-9.]+):17890$')
PROCESS_ENV = {
    'PATH': '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    'HOME': '/root',
    'LANG': 'C.UTF-8',
}
DOCKER = '/usr/bin/docker'
GIT = '/usr/bin/git'
SYSTEMCTL = '/usr/bin/systemctl'
USERADD = '/usr/sbin/useradd'
RUNUSER = '/usr/sbin/runuser'
EXIT_TRACE_LOC = 'TW'
EXIT_TRACE_COLO = 'TPE'


class InstallerError(RuntimeError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def require(condition: bool, code: str) -> None:
    if not condition:
        raise InstallerError(code)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def is_rfc1918_ipv4(value: str) -> bool:
    try:
        address = ipaddress.IPv4Address(value)
    except (ipaddress.AddressValueError, TypeError):
        return False
    return any(address in network for network in (
        ipaddress.IPv4Network('10.0.0.0/8'),
        ipaddress.IPv4Network('172.16.0.0/12'),
        ipaddress.IPv4Network('192.168.0.0/16'),
    ))


def is_valid_proxy_url(value: str) -> bool:
    match = PROXY_URL_PATTERN.fullmatch(value) if isinstance(value, str) else None
    return match is not None and is_rfc1918_ipv4(match.group(1))


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'JSON_DUPLICATE_KEY')
        result[key] = value
    return result


def validate_expected(version: str, revision: str) -> tuple[str, str]:
    require(isinstance(version, str) and VERSION.fullmatch(version) is not None,
            'VERSION_INVALID')
    require(isinstance(revision, str) and HEX40.fullmatch(revision) is not None,
            'REVISION_INVALID')
    return version, revision


def parse_trace(raw: bytes) -> dict[str, str]:
    require(len(raw) <= MAX_TRACE_BYTES, 'TRACE_TOO_LARGE')
    try:
        text = raw.decode('ascii')
    except UnicodeDecodeError as error:
        raise InstallerError('TRACE_INVALID') from error
    values = {}
    for line in text.splitlines():
        if not line:
            continue
        key, separator, value = line.partition('=')
        require(separator == '=' and key not in values, 'TRACE_INVALID')
        require(key in ('fl', 'h', 'ip', 'ts', 'visit_scheme', 'uag', 'colo', 'sliver', 'http',
                        'loc', 'tls', 'sni', 'warp', 'gateway', 'rbi', 'kex'),
                'TRACE_INVALID')
        values[key] = value
    require(values.get('h') == 'api.openai.com'
            and values.get('loc') == EXIT_TRACE_LOC and values.get('colo') == EXIT_TRACE_COLO,
            'TRACE_EXIT_INVALID')
    return {'loc': values['loc'], 'colo': values['colo']}


def validate_node_payload(value) -> dict:
    require(isinstance(value, dict) and set(value) == {'node_id', 'node', 'trace'},
            'NODE_PAYLOAD_INVALID')
    node_id = value['node_id']
    require(isinstance(node_id, str) and re.fullmatch(r'[A-Za-z0-9._:-]{1,128}', node_id),
            'NODE_ID_INVALID')
    node = value['node']
    require(isinstance(node, dict) and set(node) == EXPECTED_NODE_KEYS,
            'NODE_FIELDS_INVALID')
    require(node['type'] == 'ss', 'NODE_TYPE_INVALID')
    require(isinstance(node['name'], str) and 1 <= len(node['name']) <= 128
            and not re.search(r'[\x00-\x1f\x7f]', node['name']), 'NODE_NAME_INVALID')
    require(isinstance(node['cipher'], str) and node['cipher'] in SHADOWSOCKS_CIPHERS,
            'NODE_CIPHER_INVALID')
    require(type(node['port']) is int and 1 <= node['port'] <= 65535,
            'NODE_PORT_INVALID')
    require(type(node['udp']) is bool, 'NODE_UDP_INVALID')
    require(isinstance(node['password'], str) and 1 <= len(node['password'].encode('utf-8')) <= 1024
            and not re.search(r'[\x00-\x1f\x7f]', node['password']), 'NODE_PASSWORD_INVALID')
    server = node['server']
    require(isinstance(server, str), 'NODE_SERVER_INVALID')
    try:
        address = ipaddress.IPv4Address(server)
    except ipaddress.AddressValueError as error:
        raise InstallerError('NODE_SERVER_INVALID') from error
    require(str(address) == server and address.is_global, 'NODE_SERVER_NOT_GLOBAL_IPV4')
    trace = value['trace']
    require(isinstance(trace, dict), 'NODE_TRACE_INVALID')
    try:
        trace_json = json.dumps(trace, ensure_ascii=True, separators=(',', ':')).encode('ascii')
    except (TypeError, ValueError, RecursionError) as error:
        raise InstallerError('NODE_TRACE_INVALID') from error
    require(len(trace_json) <= MAX_TRACE_BYTES, 'NODE_TRACE_TOO_LARGE')
    return {'node_id': node_id, 'node': dict(node), 'trace': trace}


def _allowed_payload_uids() -> set[int]:
    allowed = {0}
    try:
        allowed.add(pwd.getpwnam('deploy').pw_uid)
    except KeyError:
        pass
    return allowed


def read_private_payload(path: str | Path, expected_sha256: str,
                         allowed_owner_uids: set[int] | None = None) -> dict:
    require(isinstance(expected_sha256, str) and HEX64.fullmatch(expected_sha256),
            'NODE_PAYLOAD_SHA256_INVALID')
    payload_path = Path(path)
    require(payload_path.is_absolute(), 'NODE_PAYLOAD_PATH_INVALID')
    flags = (os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_CLOEXEC', 0)
             | getattr(os, 'O_NONBLOCK', 0))
    try:
        fd = os.open(payload_path, flags)
    except OSError as error:
        raise InstallerError('NODE_PAYLOAD_UNAVAILABLE') from error
    try:
        info = os.fstat(fd)
        owners = _allowed_payload_uids() if allowed_owner_uids is None else allowed_owner_uids
        require(stat.S_ISREG(info.st_mode) and info.st_uid in owners
                and stat.S_IMODE(info.st_mode) == 0o600 and info.st_nlink == 1,
                'NODE_PAYLOAD_OWNERSHIP_INVALID')
        require(0 < info.st_size <= MAX_NODE_PAYLOAD, 'NODE_PAYLOAD_SIZE_INVALID')
        chunks = []
        remaining = MAX_NODE_PAYLOAD + 1
        while remaining:
            chunk = os.read(fd, min(8192, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        raw = b''.join(chunks)
        require(len(raw) <= MAX_NODE_PAYLOAD and len(raw) == info.st_size,
                'NODE_PAYLOAD_SIZE_INVALID')
        require(sha256_bytes(raw) == expected_sha256, 'NODE_PAYLOAD_SHA256_MISMATCH')
        try:
            value = json.loads(raw.decode('utf-8'), object_pairs_hook=unique_object)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError, RecursionError) as error:
            raise InstallerError('NODE_PAYLOAD_JSON_INVALID') from error
        return validate_node_payload(value)
    finally:
        os.close(fd)


def _trusted_directory(path: Path, expected_mode: int, owner: int = 0,
                       group: int | None = None) -> os.stat_result:
    try:
        info = path.lstat()
    except OSError as error:
        raise InstallerError('DIRECTORY_UNAVAILABLE') from error
    require(stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode)
            and info.st_uid == owner and stat.S_IMODE(info.st_mode) == expected_mode
            and (group is None or info.st_gid == group), 'DIRECTORY_OWNERSHIP_INVALID')
    return info


def _read_root_file(path: Path, mode: int, max_bytes: int = 1024 * 1024) -> tuple[bytes, os.stat_result]:
    flags = (os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_CLOEXEC', 0)
             | getattr(os, 'O_NONBLOCK', 0))
    try:
        fd = os.open(path, flags)
    except OSError as error:
        raise InstallerError('FILE_UNAVAILABLE') from error
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0
                and stat.S_IMODE(info.st_mode) == mode and info.st_nlink == 1,
                'FILE_OWNERSHIP_INVALID')
        require(0 <= info.st_size <= max_bytes, 'FILE_SIZE_INVALID')
        chunks = []
        remaining = max_bytes + 1
        while remaining:
            chunk = os.read(fd, min(64 * 1024, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        raw = b''.join(chunks)
        require(len(raw) == info.st_size and len(raw) <= max_bytes, 'FILE_SIZE_INVALID')
        return raw, info
    finally:
        os.close(fd)


def _matches_expected_identity(info: os.stat_result,
                               expected: tuple[int, ...]) -> bool:
    basic = (info.st_dev, info.st_ino) == expected[:2]
    if len(expected) == 2:
        return basic
    return basic and (info.st_size, info.st_mtime_ns, info.st_ctime_ns) == expected[2:5]


def _atomic_write(path: Path, data: bytes, mode: int, *, uid: int = 0, gid: int = 0,
                  expected_identity: tuple[int, ...] | None = None) -> None:
    parent_info = path.parent.lstat()
    require(stat.S_ISDIR(parent_info.st_mode) and parent_info.st_uid == 0
            and not (stat.S_IMODE(parent_info.st_mode) & 0o022), 'FILE_PARENT_UNTRUSTED')
    if expected_identity is not None:
        current = path.lstat()
        require(stat.S_ISREG(current.st_mode) and _matches_expected_identity(current, expected_identity),
                'FILE_CHANGED_CONCURRENTLY')
    fd, temporary_name = tempfile.mkstemp(prefix='.' + path.name + '.tmp.', dir=path.parent)
    temporary = Path(temporary_name)
    try:
        os.fchmod(fd, mode)
        os.fchown(fd, uid, gid)
        with os.fdopen(fd, 'wb', closefd=True) as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        if expected_identity is not None:
            current = path.lstat()
            require(stat.S_ISREG(current.st_mode) and _matches_expected_identity(current, expected_identity),
                    'FILE_CHANGED_CONCURRENTLY')
        os.replace(temporary, path)
        directory_fd = os.open(path.parent, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    except Exception:
        try:
            temporary.unlink()
        except OSError:
            pass
        raise


def _env_lines(raw: bytes) -> tuple[list[bytes], list[tuple[int, bytes, bytes]]]:
    lines = raw.splitlines(keepends=True)
    seen = set()
    proxy_lines = []
    for index, line in enumerate(lines):
        match = ASSIGNMENT.fullmatch(line)
        if match is None:
            continue
        key, value, _ending = match.groups()
        require(key not in seen, 'PRODUCTION_ENV_DUPLICATE_KEY')
        seen.add(key)
        if key == PROXY_ENV_BYTES:
            proxy_lines.append((index, line, value))
    require(len(proxy_lines) <= 1, 'PRODUCTION_ENV_PROXY_DUPLICATE')
    return lines, proxy_lines


def edit_env_bytes(original: bytes, proxy_url: str) -> tuple[bytes, dict]:
    require(is_valid_proxy_url(proxy_url), 'PROXY_URL_INVALID')
    lines, existing = _env_lines(original)
    prior_line = existing[0][1] if existing else None
    append_separator_added = False
    append_previous_last_line_b64 = None
    ending = b'\n'
    if existing:
        old_line = existing[0][1]
        ending_match = re.search(rb'(\r?\n)$', old_line)
        ending = ending_match.group(1) if ending_match else b''
        replacement = PROXY_ENV_BYTES + b'=' + proxy_url.encode('ascii') + ending
        lines[existing[0][0]] = replacement
    else:
        if lines and not lines[-1].endswith((b'\n', b'\r')):
            append_separator_added = True
            append_previous_last_line_b64 = base64.b64encode(lines[-1]).decode('ascii')
            lines[-1] += b'\n'
        lines.append(PROXY_ENV_BYTES + b'=' + proxy_url.encode('ascii') + b'\n')
    installed = proxy_url.encode('ascii')
    return b''.join(lines), {
        'previous_line_b64': None if prior_line is None else base64.b64encode(prior_line).decode('ascii'),
        'append_separator_added': append_separator_added,
        'append_previous_last_line_b64': append_previous_last_line_b64,
        'installed_value': proxy_url,
        'installed_value_sha256': sha256_bytes(installed),
    }


def rollback_env_bytes(current: bytes, state: dict) -> bytes:
    lines, proxy_lines = _env_lines(current)
    installed = state.get('installed_value')
    installed_digest = state.get('installed_value_sha256')
    require(isinstance(installed, str) and isinstance(installed_digest, str)
            and sha256_bytes(installed.encode('ascii')) == installed_digest,
            'ROLLBACK_STATE_INVALID')
    previous_encoded = state.get('previous_line_b64')
    previous_line = None
    if previous_encoded is not None:
        try:
            previous_line = base64.b64decode(previous_encoded, validate=True)
        except (ValueError, TypeError) as error:
            raise InstallerError('ROLLBACK_STATE_INVALID') from error
        old_lines, previous_matches = _env_lines(previous_line)
        require(len(old_lines) == 1 and len(previous_matches) == 1
                and previous_matches[0][1] == previous_line, 'ROLLBACK_STATE_INVALID')
    if proxy_lines:
        index, line, value = proxy_lines[0]
        if value == installed.encode('ascii'):
            if previous_line is None:
                del lines[index]
                if state.get('append_separator_added') is True and index == len(lines):
                    encoded_last = state.get('append_previous_last_line_b64')
                    try:
                        original_last = base64.b64decode(encoded_last, validate=True)
                    except (ValueError, TypeError) as error:
                        raise InstallerError('ROLLBACK_STATE_INVALID') from error
                    if lines and lines[-1] == original_last + b'\n':
                        lines[-1] = original_last
            else:
                lines[index] = previous_line
            return b''.join(lines)
        if previous_line is not None and line == previous_line:
            return current
        raise InstallerError('ROLLBACK_ENV_CONFLICT')
    require(previous_line is None, 'ROLLBACK_ENV_CONFLICT')
    return current


def build_mihomo_config(node: dict, bind_address: str, port: int,
                         username: str, password: str) -> bytes:
    require(port == PORT, 'CONFIG_PORT_INVALID')
    require(is_rfc1918_ipv4(bind_address), 'CONFIG_BIND_INVALID')
    require(re.fullmatch(r'[A-Za-z0-9_-]{16,64}', username)
            and re.fullmatch(r'[A-Za-z0-9_-]{32,64}', password), 'CONFIG_AUTH_INVALID')
    value = {
        'mixed-port': port,
        'allow-lan': True,
        'bind-address': bind_address,
        'mode': 'rule',
        'log-level': 'error',
        'ipv6': False,
        'authentication': [username + ':' + password],
        'proxies': [{
            'name': 'OPENAI_EGRESS',
            'type': 'ss',
            'server': node['server'],
            'port': node['port'],
            'cipher': node['cipher'],
            'password': node['password'],
            'udp': node['udp'],
        }],
        'rules': ['DOMAIN,api.openai.com,OPENAI_EGRESS', 'MATCH,REJECT'],
    }
    return (json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n').encode('utf-8')


def build_proxy_url(gateway: str, username: str, password: str) -> str:
    require(is_rfc1918_ipv4(gateway), 'PROXY_GATEWAY_INVALID')
    require(re.fullmatch(r'[A-Za-z0-9_-]{16,64}', username)
            and re.fullmatch(r'[A-Za-z0-9_-]{32,64}', password), 'PROXY_AUTH_INVALID')
    return f'http://{username}:{password}@{gateway}:{PORT}'


def build_compose_pin(app_image_id: str, worker_image_id: str) -> bytes:
    for identity in (app_image_id, worker_image_id):
        require(re.fullmatch(r'sha256:[a-f0-9]{64}', identity), 'IMAGE_ID_INVALID')
    return ('services:\n'
            '  app:\n'
            f'    image: {app_image_id}\n'
            '    build: !reset null\n'
            '  worker:\n'
            f'    image: {worker_image_id}\n'
            '    build: !reset null\n').encode('ascii')


def build_worker_smoke_script() -> bytes:
    source = r'''const fail = () => { process.stdout.write("OPENAI_EGRESS_RUNTIME_INVALID\n"); process.exitCode = 1; };
const readLimited = async (response, limit) => {
  const reader = response.body?.getReader();
  if (!reader) throw new Error();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) throw new Error();
      chunks.push(part.value);
    }
  } catch {
    await reader.cancel().catch(() => {});
    throw new Error();
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
};
try {
  const proxyFlags = ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY",
    "all_proxy", "NODE_USE_ENV_PROXY"];
  if (proxyFlags.some((name) => Object.hasOwn(process.env, name))) throw new Error();
  const directResponse = await globalThis.fetch("https://www.cloudflare.com/cdn-cgi/trace", {
    redirect: "error", signal: AbortSignal.timeout(12000),
  });
  const directTrace = await readLimited(directResponse, 8192);
  const directFields = Object.fromEntries(directTrace.split(/\r?\n/u)
    .map((line) => line.split("=", 2)).filter((parts) => parts.length === 2));
  if (directResponse.status !== 200 || directFields.h !== "www.cloudflare.com" ||
      !directFields.loc || !directFields.colo ||
      (directFields.loc === "TW" && directFields.colo === "TPE")) throw new Error();
  const loaded = await import("./src/lib/model-provider-http.ts");
  const prepare = loaded.prepareModelProviderFetch ?? loaded.default?.prepareModelProviderFetch;
  if (typeof prepare !== "function") throw new Error();
  const endpoint = "https://api.openai.com/v1/chat/completions";
  const executor = prepare(endpoint);
  if (typeof executor !== "function") throw new Error();
  const response = await executor(endpoint, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(12000),
    headers: {
      authorization: "Bearer diagnostic-not-a-real-api-key",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      messages: [{ role: "user", content: "Connectivity diagnostic" }],
      max_tokens: 1,
    }),
  });
  let body;
  try { body = JSON.parse(await readLimited(response, 16384)); } catch { throw new Error(); }
  if (response.status !== 401 || body?.error?.code !== "invalid_api_key") throw new Error();
  process.stdout.write("OPENAI_EGRESS_RUNTIME_OK\n");
} catch {
  fail();
}
'''
    return source.encode('utf-8')


def run_command(arguments: list[str], *, input_data: bytes | None = None,
                timeout: int = 120, code: str = 'COMMAND_FAILED',
                allowed_statuses: frozenset[int] = frozenset((0,))) -> subprocess.CompletedProcess:
    require(isinstance(arguments, list) and arguments and all(isinstance(item, str) for item in arguments),
            'COMMAND_INVALID')
    try:
        result = subprocess.run(arguments, input=input_data, env=PROCESS_ENV,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise InstallerError(code) from error
    require(result.returncode in allowed_statuses, code)
    return result


def command_text(arguments: list[str], *, timeout: int = 120, code: str = 'COMMAND_FAILED') -> str:
    result = run_command(arguments, timeout=timeout, code=code)
    try:
        return result.stdout.decode('utf-8', errors='strict').strip()
    except UnicodeDecodeError as error:
        raise InstallerError(code) from error


def docker_json(*arguments: str, code: str = 'DOCKER_QUERY_FAILED'):
    raw = command_text([DOCKER, *arguments], timeout=60, code=code)
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, ValueError, RecursionError) as error:
        raise InstallerError(code) from error


def compose_base(pin_file: Path | None = None) -> list[str]:
    command = [DOCKER, 'compose', '--project-name', PROJECT, '--env-file', str(ENV),
               '--project-directory', str(ROOT), '--file', str(ROOT / 'compose.yaml'),
               '--file', str(OVERRIDE)]
    if pin_file is not None:
        command.extend(['--file', str(pin_file)])
    return command


def compose_command(*arguments: str, pin_file: Path | None = None,
                    input_data: bytes | None = None, timeout: int = 1200,
                    code: str = 'COMPOSE_FAILED') -> subprocess.CompletedProcess:
    return run_command([*compose_base(pin_file), *arguments], input_data=input_data,
                       timeout=timeout, code=code)


def app_worker_pin_file(app_image_id: str, worker_image_id: str) -> Path:
    pin_bytes = build_compose_pin(app_image_id, worker_image_id)
    fd, name = tempfile.mkstemp(prefix='.compose-openai-egress.', suffix='.yaml', dir=PRIVATE_DIR)
    path = Path(name)
    try:
        os.fchmod(fd, 0o600)
        os.fchown(fd, 0, 0)
        with os.fdopen(fd, 'wb', closefd=True) as stream:
            stream.write(pin_bytes)
            stream.flush()
            os.fsync(stream.fileno())
        return path
    except Exception:
        try:
            path.unlink()
        except OSError:
            pass
        raise


def recreate_app_worker(app_image_id: str, worker_image_id: str) -> None:
    pin_path = app_worker_pin_file(app_image_id, worker_image_id)
    try:
        compose_command('up', '-d', '--no-deps', '--no-build', '--force-recreate',
                        '--wait', '--wait-timeout', '300', 'app', 'worker',
                        pin_file=pin_path, timeout=900, code='APP_WORKER_RECREATE_FAILED')
    finally:
        try:
            pin_path.unlink()
        except FileNotFoundError:
            pass


def validate_compose_files() -> None:
    require(ROOT.is_dir() and not ROOT.is_symlink(), 'PRODUCTION_REPOSITORY_UNAVAILABLE')
    require((ROOT / 'compose.yaml').is_file() and not (ROOT / 'compose.yaml').is_symlink(),
            'PRODUCTION_COMPOSE_UNAVAILABLE')
    _override, info = _read_root_file(OVERRIDE, 0o644, 1024 * 1024)
    require(info.st_gid == 0, 'COMPOSE_OVERRIDE_OWNERSHIP_INVALID')


def _container_ids(service: str) -> list[str]:
    raw = command_text([DOCKER, 'ps', '-aq', '--no-trunc', '--filter', f'label=com.docker.compose.project={PROJECT}',
                        '--filter', f'label=com.docker.compose.service={service}'],
                       timeout=60, code='DOCKER_CONTAINER_LIST_FAILED')
    ids = [line for line in raw.splitlines() if line]
    require(len(ids) == 1 and all(HEX64.fullmatch(identity) for identity in ids),
            'CONTAINER_IDENTITY_INVALID')
    return ids


def _container(service: str, *, require_running: bool = True) -> dict:
    identity = _container_ids(service)[0]
    rows = docker_json('inspect', identity, code='DOCKER_CONTAINER_INSPECT_FAILED')
    require(isinstance(rows, list) and len(rows) == 1 and isinstance(rows[0], dict),
            'DOCKER_CONTAINER_INSPECT_INVALID')
    container = rows[0]
    labels = container.get('Config', {}).get('Labels', {})
    require(labels.get('com.docker.compose.project') == PROJECT
            and labels.get('com.docker.compose.service') == service,
            'CONTAINER_PROJECT_LABEL_INVALID')
    state = container.get('State', {})
    require(state.get('Status') == 'running' if require_running
            else state.get('Status') in ('running', 'restarting', 'paused', 'exited', 'created'),
            'CONTAINER_NOT_RUNNING')
    image_id = container.get('Image')
    require(isinstance(image_id, str) and re.fullmatch(r'sha256:[a-f0-9]{64}', image_id),
            'CONTAINER_IMAGE_ID_INVALID')
    return {'id': identity, 'image_id': image_id, 'state': state, 'labels': labels,
            'networks': container.get('NetworkSettings', {}).get('Networks', {})}


def _image_labels(image_id: str) -> dict:
    rows = docker_json('image', 'inspect', image_id, code='DOCKER_IMAGE_INSPECT_FAILED')
    require(isinstance(rows, list) and len(rows) == 1 and isinstance(rows[0], dict)
            and rows[0].get('Id') == image_id, 'DOCKER_IMAGE_INSPECT_INVALID')
    labels = rows[0].get('Config', {}).get('Labels', {})
    require(isinstance(labels, dict), 'IMAGE_LABELS_INVALID')
    return labels


def _require_healthy(container: dict) -> None:
    require(container['state'].get('Health', {}).get('Status') == 'healthy',
            'CONTAINER_UNHEALTHY')


def capture_runtime(version: str, revision: str, *, require_writers_healthy: bool = True,
                    require_services_running: bool = True) -> dict:
    services = {
        name: _container(name, require_running=(require_services_running and name != 'git-worker'))
        for name in ('app', 'worker', 'postgres', 'git-worker')
    }
    for service in ('app', 'worker'):
        container = services[service]
        labels = _image_labels(container['image_id'])
        require(labels.get('org.opencontainers.image.version') == version,
                'CURRENT_IMAGE_VERSION_MISMATCH')
        require(labels.get('org.opencontainers.image.revision') == revision,
                'CURRENT_IMAGE_REVISION_MISMATCH')
        container['version'] = labels.get('org.opencontainers.image.version')
        container['revision'] = labels.get('org.opencontainers.image.revision')
        if require_writers_healthy:
            _require_healthy(container)
        if require_services_running:
            require(NETWORK_NAME in container['networks'], 'APPLICATION_NETWORK_MISSING')
    if require_writers_healthy:
        _require_healthy(services['postgres'])
    return {
        'version': version,
        'revision': revision,
        'app_container_id': services['app']['id'],
        'app_image_id': services['app']['image_id'],
        'worker_container_id': services['worker']['id'],
        'worker_image_id': services['worker']['image_id'],
        'postgres_container_id': services['postgres']['id'],
        'postgres_image_id': services['postgres']['image_id'],
        'git_worker_container_id': services['git-worker']['id'],
        'git_worker_image_id': services['git-worker']['image_id'],
        'app_healthy': services['app']['state'].get('Health', {}).get('Status') == 'healthy',
        'worker_healthy': services['worker']['state'].get('Health', {}).get('Status') == 'healthy',
        'database_healthy': services['postgres']['state'].get('Health', {}).get('Status') == 'healthy',
    }


def validate_repository_revision(expected_revision: str) -> None:
    actual = command_text([GIT, '-C', str(ROOT), 'rev-parse', '--verify', 'HEAD'],
                          timeout=30, code='PRODUCTION_REVISION_QUERY_FAILED')
    require(actual == expected_revision, 'PRODUCTION_REVISION_MISMATCH')


def docker_network_gateway(runtime: dict) -> str:
    rows = docker_json('network', 'inspect', NETWORK_NAME, code='DOCKER_NETWORK_INSPECT_FAILED')
    require(isinstance(rows, list) and len(rows) == 1 and isinstance(rows[0], dict),
            'DOCKER_NETWORK_INSPECT_INVALID')
    network = rows[0]
    labels = network.get('Labels', {})
    require(network.get('Name') == NETWORK_NAME
            and labels.get('com.docker.compose.project') == PROJECT
            and labels.get('com.docker.compose.network') == 'default'
            and network.get('Internal') is not True,
            'DOCKER_NETWORK_PROJECT_INVALID')
    config = network.get('IPAM', {}).get('Config', [])
    gateways = []
    for entry in config if isinstance(config, list) else []:
        if not isinstance(entry, dict) or not isinstance(entry.get('Gateway'), str):
            continue
        try:
            gateway = ipaddress.IPv4Address(entry['Gateway'])
            subnet = ipaddress.IPv4Network(entry.get('Subnet', ''), strict=False)
        except (ipaddress.AddressValueError, ipaddress.NetmaskValueError):
            continue
        if gateway in subnet:
            gateways.append(gateway)
    require(len(gateways) == 1, 'DOCKER_GATEWAY_INVALID')
    gateway = gateways[0]
    private_networks = (ipaddress.IPv4Network('10.0.0.0/8'),
                        ipaddress.IPv4Network('172.16.0.0/12'),
                        ipaddress.IPv4Network('192.168.0.0/16'))
    require(any(gateway in network_range for network_range in private_networks)
            and str(gateway) != '0.0.0.0', 'DOCKER_GATEWAY_NOT_RFC1918')
    container_map = network.get('Containers', {})
    require(isinstance(container_map, dict)
            and runtime['app_container_id'] in container_map
            and runtime['worker_container_id'] in container_map,
            'APPLICATION_NETWORK_BINDING_INVALID')
    return str(gateway)


def read_production_env() -> tuple[bytes, os.stat_result]:
    raw, info = _read_root_file(ENV, 0o600, 2 * 1024 * 1024)
    require(info.st_gid == 0, 'PRODUCTION_ENV_OWNERSHIP_INVALID')
    _env_lines(raw)
    return raw, info


def current_state_file() -> dict | None:
    if PRIVATE_DIR.exists() or PRIVATE_DIR.is_symlink():
        _trusted_directory(PRIVATE_DIR, 0o700, group=0)
    elif PRIVATE_STATE.exists() or PRIVATE_STATE.is_symlink():
        raise InstallerError('PRIVATE_STATE_PARENT_MISSING')
    try:
        raw, info = _read_root_file(PRIVATE_STATE, 0o600, 64 * 1024)
        require(info.st_gid == 0, 'PRIVATE_STATE_OWNERSHIP_INVALID')
    except InstallerError as error:
        if error.code == 'FILE_UNAVAILABLE' and not PRIVATE_STATE.exists() and not PRIVATE_STATE.is_symlink():
            return None
        raise
    try:
        value = json.loads(raw.decode('utf-8'), object_pairs_hook=unique_object)
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError, RecursionError) as error:
        raise InstallerError('PRIVATE_STATE_INVALID') from error
    return validate_private_state(value)


def validate_private_state(value) -> dict:
    require(isinstance(value, dict) and value.get('schema') == 1
            and value.get('status') in ('prepared', 'installed', 'rollback_incomplete', 'rolled_back'),
            'PRIVATE_STATE_INVALID')
    validate_expected(value.get('version'), value.get('revision'))
    if value['status'] == 'rolled_back':
        return value
    required_strings = ('phase', 'installed_value', 'installed_value_sha256',
                        'app_image_id', 'worker_image_id', 'gateway_ip',
                        'mihomo_sha256', 'config_sha256', 'unit_sha256')
    require(all(isinstance(value.get(key), str) for key in required_strings),
            'PRIVATE_STATE_INVALID')
    require(value['phase'] in ('preparing', 'account_ready', 'binary_installed',
                               'config_validated', 'unit_installed', 'proxy_started',
                               'proxy_verified', 'env_written', 'compose_attempted',
                               'app_worker_recreated', 'verified'), 'PRIVATE_STATE_INVALID')
    require(is_valid_proxy_url(value['installed_value'])
            and HEX64.fullmatch(value['installed_value_sha256']) is not None
            and sha256_bytes(value['installed_value'].encode('ascii')) == value['installed_value_sha256'],
            'PRIVATE_STATE_INVALID')
    for key in ('mihomo_sha256', 'config_sha256', 'unit_sha256'):
        require(HEX64.fullmatch(value[key]) is not None, 'PRIVATE_STATE_INVALID')
    for key in ('app_image_id', 'worker_image_id'):
        require(re.fullmatch(r'sha256:[a-f0-9]{64}', value[key]) is not None,
                'PRIVATE_STATE_INVALID')
    baseline = value.get('baseline_runtime')
    require(isinstance(baseline, dict)
            and baseline.get('version') == value['version']
            and baseline.get('revision') == value['revision']
            and baseline.get('app_image_id') == value['app_image_id']
            and baseline.get('worker_image_id') == value['worker_image_id'],
            'PRIVATE_STATE_INVALID')
    for key in ('app_container_id', 'worker_container_id', 'postgres_container_id',
                'git_worker_container_id'):
        require(isinstance(baseline.get(key), str) and HEX64.fullmatch(baseline[key]) is not None,
                'PRIVATE_STATE_INVALID')
    for key in ('app_image_id', 'worker_image_id', 'postgres_image_id', 'git_worker_image_id'):
        require(isinstance(baseline.get(key), str)
                and re.fullmatch(r'sha256:[a-f0-9]{64}', baseline[key]) is not None,
                'PRIVATE_STATE_INVALID')
    require(is_rfc1918_ipv4(value['gateway_ip'])
            and isinstance(value.get('previous_line_b64'), (str, type(None)))
            and type(value.get('append_separator_added')) is bool
            and isinstance(value.get('append_previous_last_line_b64'), (str, type(None)))
            and isinstance(value.get('created_directories'), list)
            and all(path in (str(ETC_DIR), str(DATA_DIR), str(BIN_DIR))
                    for path in value['created_directories']), 'PRIVATE_STATE_INVALID')
    if value['previous_line_b64'] is not None:
        try:
            previous_line = base64.b64decode(value['previous_line_b64'], validate=True)
        except (ValueError, TypeError) as error:
            raise InstallerError('PRIVATE_STATE_INVALID') from error
        previous_lines, previous_proxy = _env_lines(previous_line)
        require(len(previous_lines) == 1 and len(previous_proxy) == 1
                and previous_proxy[0][1] == previous_line, 'PRIVATE_STATE_INVALID')
    if value['append_separator_added']:
        require(value['previous_line_b64'] is None
                and isinstance(value['append_previous_last_line_b64'], str),
                'PRIVATE_STATE_INVALID')
        try:
            last_line = base64.b64decode(value['append_previous_last_line_b64'], validate=True)
        except (ValueError, TypeError) as error:
            raise InstallerError('PRIVATE_STATE_INVALID') from error
        require(b'\n' not in last_line and b'\r' not in last_line,
                'PRIVATE_STATE_INVALID')
    if value.get('egress_uid') is not None:
        require(type(value['egress_uid']) is int and 0 < value['egress_uid'] < 1000,
                'PRIVATE_STATE_INVALID')
    if value.get('egress_gid') is not None:
        require(type(value['egress_gid']) is int and 0 < value['egress_gid'] < 1000,
                'PRIVATE_STATE_INVALID')
    smoke = value.get('smoke')
    require(isinstance(smoke, dict)
            and set(smoke) <= {'proxy_loc', 'proxy_colo', 'openai_401', 'non_openai_rejected'}
            and smoke.get('proxy_loc') in (None, EXIT_TRACE_LOC)
            and smoke.get('proxy_colo') in (None, EXIT_TRACE_COLO)
            and all(smoke.get(key) is None or type(smoke.get(key)) is bool
                    for key in ('openai_401', 'non_openai_rejected')),
            'PRIVATE_STATE_INVALID')
    return value


def _ensure_private_dir(*, create: bool) -> None:
    try:
        _trusted_directory(PRIVATE_DIR, 0o700, group=0)
        return
    except InstallerError:
        if not create or PRIVATE_DIR.exists() or PRIVATE_DIR.is_symlink():
            raise
    _trusted_directory(PRIVATE_DIR.parent, 0o755, group=0)
    PRIVATE_DIR.mkdir(mode=0o700)
    os.chown(PRIVATE_DIR, 0, 0)
    os.chmod(PRIVATE_DIR, 0o700)


def write_private_state(state: dict) -> None:
    _ensure_private_dir(create=True)
    validate_private_state(state)
    payload = (json.dumps(state, sort_keys=True, separators=(',', ':')) + '\n').encode('utf-8')
    expected = None
    if PRIVATE_STATE.exists() or PRIVATE_STATE.is_symlink():
        _old, info = _read_root_file(PRIVATE_STATE, 0o600, 64 * 1024)
        require(info.st_gid == 0, 'PRIVATE_STATE_OWNERSHIP_INVALID')
        expected = (info.st_dev, info.st_ino)
    _atomic_write(PRIVATE_STATE, payload, 0o600, expected_identity=expected)


def read_status() -> dict | None:
    if STATUS_DIR.exists() or STATUS_DIR.is_symlink():
        _trusted_directory(STATUS_DIR, 0o755, group=0)
    elif STATUS_FILE.exists() or STATUS_FILE.is_symlink():
        raise InstallerError('STATUS_RECEIPT_PARENT_MISSING')
    try:
        raw, info = _read_root_file(STATUS_FILE, 0o644, 16 * 1024)
        require(info.st_gid == 0, 'STATUS_RECEIPT_OWNERSHIP_INVALID')
    except InstallerError as error:
        if error.code == 'FILE_UNAVAILABLE' and not STATUS_FILE.exists() and not STATUS_FILE.is_symlink():
            return None
        raise
    try:
        value = json.loads(raw.decode('utf-8'), object_pairs_hook=unique_object)
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError, RecursionError) as error:
        raise InstallerError('STATUS_RECEIPT_INVALID') from error
    allowed = {'schema', 'version', 'revision', 'status', 'rollback_status', 'updated_at',
               'proxy_loc', 'proxy_colo', 'openai_401', 'non_openai_rejected',
               'direct_fetch_direct', 'app_healthy', 'worker_healthy', 'public_health',
               'database_unchanged', 'git_worker_unchanged'}
    require(isinstance(value, dict) and value.get('schema') == 1
            and set(value) <= allowed
            and isinstance(value.get('version'), str)
            and isinstance(value.get('revision'), str)
            and value.get('status') in ('applying', 'failed', 'installed', 'rolled_back', 'rollback_incomplete')
            and value.get('rollback_status') in ('pending', 'not_started', 'available', 'succeeded', 'failed'),
            'STATUS_RECEIPT_INVALID')
    validate_expected(value['version'], value['revision'])
    require(value.get('proxy_loc') in (None, EXIT_TRACE_LOC)
            and value.get('proxy_colo') in (None, EXIT_TRACE_COLO), 'STATUS_RECEIPT_INVALID')
    for key in ('openai_401', 'non_openai_rejected', 'direct_fetch_direct', 'app_healthy',
                'worker_healthy', 'public_health', 'database_unchanged', 'git_worker_unchanged'):
        require(value.get(key) is None or type(value.get(key)) is bool, 'STATUS_RECEIPT_INVALID')
    return value


def _ensure_status_dir() -> None:
    if STATUS_DIR.exists() or STATUS_DIR.is_symlink():
        _trusted_directory(STATUS_DIR, 0o755, group=0)
        return
    _trusted_directory(STATUS_DIR.parent, 0o755, group=0)
    STATUS_DIR.mkdir(mode=0o755)
    os.chown(STATUS_DIR, 0, 0)
    os.chmod(STATUS_DIR, 0o755)


def write_status(status: dict) -> None:
    _ensure_status_dir()
    previous = read_status()
    expected = None
    if STATUS_FILE.exists() or STATUS_FILE.is_symlink():
        require(previous is not None and isinstance(previous.get('version'), str)
                and isinstance(previous.get('revision'), str), 'STATUS_RECEIPT_CONFLICT')
        _old, info = _read_root_file(STATUS_FILE, 0o644, 16 * 1024)
        require(info.st_gid == 0, 'STATUS_RECEIPT_OWNERSHIP_INVALID')
        expected = (info.st_dev, info.st_ino)
    payload = (json.dumps(status, sort_keys=True, separators=(',', ':')) + '\n').encode('utf-8')
    _atomic_write(STATUS_FILE, payload, 0o644, expected_identity=expected)


def status_receipt(version: str, revision: str, status: str,
                   rollback_status: str, **checks) -> dict:
    allowed = {
        'proxy_loc', 'proxy_colo', 'openai_401', 'non_openai_rejected',
        'direct_fetch_direct', 'app_healthy', 'worker_healthy', 'public_health',
        'database_unchanged', 'git_worker_unchanged',
    }
    value = {'schema': 1, 'version': version, 'revision': revision,
             'status': status, 'rollback_status': rollback_status,
             'updated_at': datetime.now(timezone.utc).replace(microsecond=0).isoformat()}
    for name, result in checks.items():
        require(name in allowed, 'STATUS_FIELD_INVALID')
        if name in ('proxy_loc', 'proxy_colo'):
            require(result in (None, EXIT_TRACE_LOC, EXIT_TRACE_COLO), 'STATUS_FIELD_INVALID')
        else:
            require(result is None or type(result) is bool, 'STATUS_FIELD_INVALID')
        value[name] = result
    return value


def acquire_lock():
    flags = os.O_RDWR | os.O_CREAT | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_CLOEXEC', 0)
    try:
        fd = os.open(LOCK, flags, 0o600)
    except OSError as error:
        raise InstallerError('DEPLOY_LOCK_UNAVAILABLE') from error
    info = os.fstat(fd)
    require(stat.S_ISREG(info.st_mode) and info.st_uid == 0
            and info.st_gid == 0 and stat.S_IMODE(info.st_mode) == 0o600 and info.st_nlink == 1,
            'DEPLOY_LOCK_OWNERSHIP_INVALID')
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError as error:
        os.close(fd)
        raise InstallerError('DEPLOY_LOCK_BUSY') from error
    return fd


def safe_env_write(data: bytes, previous_info: os.stat_result) -> None:
    _atomic_write(ENV, data, 0o600,
                  expected_identity=(previous_info.st_dev, previous_info.st_ino,
                                     previous_info.st_size, previous_info.st_mtime_ns,
                                     previous_info.st_ctime_ns))


def _validate_public_https_host(hostname: str) -> None:
    try:
        addresses = socket.getaddrinfo(hostname, 443, type=socket.SOCK_STREAM)
    except OSError as error:
        raise InstallerError('MIHOMO_REDIRECT_DNS_INVALID') from error
    require(bool(addresses), 'MIHOMO_REDIRECT_DNS_INVALID')
    for address in addresses:
        try:
            resolved = ipaddress.ip_address(address[4][0])
        except (IndexError, TypeError, ValueError) as error:
            raise InstallerError('MIHOMO_REDIRECT_DNS_INVALID') from error
        require(resolved.is_global, 'MIHOMO_REDIRECT_DNS_INVALID')


def _validate_mihomo_asset_url(url: str) -> None:
    try:
        parsed = urllib.parse.urlsplit(url)
        hostname = parsed.hostname
        port = parsed.port
    except (TypeError, ValueError) as error:
        raise InstallerError('MIHOMO_REDIRECT_URL_INVALID') from error
    require(isinstance(url, str) and not any(ord(char) < 0x20 or ord(char) == 0x7f for char in url)
            and '#' not in url and parsed.scheme == 'https' and hostname in MIHOMO_REDIRECT_HOSTS
            and parsed.username is None and parsed.password is None and port in (None, 443),
            'MIHOMO_REDIRECT_URL_INVALID')
    _validate_public_https_host(hostname)


class MihomoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def __init__(self):
        super().__init__()
        self.redirect_count = 0

    def redirect_request(self, request, fp, code, message, headers, newurl):
        require(self.redirect_count < MAX_MIHOMO_REDIRECTS, 'MIHOMO_REDIRECT_LIMIT')
        _validate_mihomo_asset_url(newurl)
        redirected = super().redirect_request(request, fp, code, message, headers, newurl)
        require(redirected is not None, 'MIHOMO_REDIRECT_INVALID')
        self.redirect_count += 1
        return redirected


class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        return None


def download_mihomo() -> tuple[bytes, str]:
    require(platform.system() == 'Linux' and platform.machine().lower() in ('x86_64', 'amd64'),
            'MIHOMO_PLATFORM_UNSUPPORTED')
    import ssl
    _validate_mihomo_asset_url(MIHOMO_URL)
    request = urllib.request.Request(MIHOMO_URL, headers={'User-Agent': 'ai-project-os-openai-egress/1'})
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}),
                                             urllib.request.HTTPSHandler(context=ssl.create_default_context()),
                                             MihomoRedirectHandler())
        with opener.open(request, timeout=60) as response:
            require(response.status == 200, 'MIHOMO_DOWNLOAD_STATUS_INVALID')
            compressed = response.read(MIHOMO_COMPRESSED_SIZE + 1)
    except InstallerError:
        raise
    except (OSError, urllib.error.URLError, TimeoutError) as error:
        raise InstallerError('MIHOMO_DOWNLOAD_FAILED') from error
    require(len(compressed) == MIHOMO_COMPRESSED_SIZE
            and sha256_bytes(compressed) == MIHOMO_COMPRESSED_SHA256,
            'MIHOMO_ARCHIVE_IDENTITY_INVALID')
    try:
        with gzip.GzipFile(fileobj=io.BytesIO(compressed)) as stream:
            binary = stream.read(MAX_MIHOMO_BINARY + 1)
            require(len(binary) <= MAX_MIHOMO_BINARY and stream.read(1) == b'',
                    'MIHOMO_BINARY_SIZE_INVALID')
    except (OSError, EOFError) as error:
        raise InstallerError('MIHOMO_ARCHIVE_INVALID') from error
    require(binary.startswith(b'\x7fELF') and len(binary) > 1024 * 1024,
            'MIHOMO_BINARY_INVALID')
    return binary, sha256_bytes(binary)


def _ensure_absent(path: Path, code: str) -> None:
    try:
        path.lstat()
    except FileNotFoundError:
        return
    raise InstallerError(code)


def _create_directory(path: Path, mode: int, uid: int, gid: int,
                      *, existing_ok: bool = False) -> bool:
    if path.exists() or path.is_symlink():
        require(existing_ok, 'INSTALLATION_PATH_CONFLICT')
        info = path.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == uid and info.st_gid == gid
                and stat.S_IMODE(info.st_mode) == mode, 'INSTALLATION_DIRECTORY_CONFLICT')
        return False
    parent = path.parent.lstat()
    require(stat.S_ISDIR(parent.st_mode) and parent.st_uid == 0 and parent.st_gid == 0
            and not (stat.S_IMODE(parent.st_mode) & 0o022), 'INSTALLATION_PARENT_UNTRUSTED')
    path.mkdir(mode=mode)
    os.chown(path, uid, gid)
    os.chmod(path, mode)
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == uid and info.st_gid == gid
            and stat.S_IMODE(info.st_mode) == mode, 'INSTALLATION_DIRECTORY_INVALID')
    return True


def _account_identity() -> tuple[pwd.struct_passwd, object]:
    try:
        user = pwd.getpwnam(EGRESS_ACCOUNT)
    except KeyError as error:
        raise InstallerError('EGRESS_ACCOUNT_MISSING') from error
    import grp
    try:
        group = grp.getgrnam(EGRESS_GROUP)
    except KeyError as error:
        raise InstallerError('EGRESS_GROUP_MISSING') from error
    nologin = '/usr/sbin/nologin' if Path('/usr/sbin/nologin').exists() else '/sbin/nologin'
    require(0 < user.pw_uid < 1000 and 0 < group.gr_gid < 1000
            and set(os.getgrouplist(user.pw_name, user.pw_gid)) == {group.gr_gid}
            and set(group.gr_mem) <= {EGRESS_ACCOUNT}
            and user.pw_gid == group.gr_gid
            and user.pw_dir == str(DATA_DIR) and user.pw_shell == nologin,
            'EGRESS_ACCOUNT_CONFLICT')
    return user, group


def create_account_if_missing() -> tuple[pwd.struct_passwd, object, bool]:
    import grp
    try:
        user = pwd.getpwnam(EGRESS_ACCOUNT)
    except KeyError:
        user = None
    try:
        group = grp.getgrnam(EGRESS_GROUP)
    except KeyError:
        group = None
    require((user is None) == (group is None), 'EGRESS_ACCOUNT_PARTIAL_CONFLICT')
    created = False
    if user is None:
        nologin = '/usr/sbin/nologin' if Path('/usr/sbin/nologin').exists() else '/sbin/nologin'
        run_command([USERADD, '--system', '--user-group', '--home-dir', str(DATA_DIR),
                     '--shell', nologin, '--no-create-home', EGRESS_ACCOUNT],
                    code='EGRESS_ACCOUNT_CREATE_FAILED')
        created = True
    identity = _account_identity()
    return identity[0], identity[1], created


def install_directories(uid: int, gid: int, *, account_preexisting: bool = False,
                        on_created=None) -> list[str]:
    created = []
    if _create_directory(ETC_DIR, 0o750, 0, gid, existing_ok=account_preexisting):
        created.append(str(ETC_DIR))
        if on_created is not None:
            on_created(str(ETC_DIR))
    if ETC_DIR.exists():
        require(not any(ETC_DIR.iterdir()), 'EGRESS_CONFIG_DIRECTORY_NOT_EMPTY')
    if _create_directory(DATA_DIR, 0o700, uid, gid, existing_ok=account_preexisting):
        created.append(str(DATA_DIR))
        if on_created is not None:
            on_created(str(DATA_DIR))
    if _create_directory(BIN_DIR, 0o755, 0, 0, existing_ok=account_preexisting):
        created.append(str(BIN_DIR))
        if on_created is not None:
            on_created(str(BIN_DIR))
    if BIN_DIR.exists():
        require(not any(BIN_DIR.iterdir()), 'EGRESS_BINARY_DIRECTORY_NOT_EMPTY')
    return created


def _write_managed_file(path: Path, data: bytes, mode: int, gid: int = 0) -> None:
    _ensure_absent(path, 'INSTALLATION_FILE_CONFLICT')
    _atomic_write(path, data, mode, uid=0, gid=gid)
    raw, info = _read_root_file(path, mode, max(len(data), 1))
    require(raw == data and info.st_gid == gid, 'INSTALLATION_FILE_WRITE_INVALID')


def install_binary(binary: bytes, expected_digest: str) -> None:
    require(sha256_bytes(binary) == expected_digest, 'MIHOMO_BINARY_IDENTITY_INVALID')
    _write_managed_file(MIHOMO, binary, 0o755)
    result = run_command([RUNUSER, '-u', EGRESS_ACCOUNT, '--', str(MIHOMO), '-v'],
                         timeout=30, code='MIHOMO_EXECUTION_FAILED')
    require(MIHOMO_VERSION.encode('ascii') in result.stdout[:512], 'MIHOMO_VERSION_INVALID')


def build_systemd_unit() -> bytes:
    text = f'''[Unit]
Description=AI Project OS OpenAI-only egress proxy
After=docker.service
Requires=docker.service

[Service]
Type=simple
User={EGRESS_ACCOUNT}
Group={EGRESS_GROUP}
WorkingDirectory={DATA_DIR}
ExecStartPre={MIHOMO} -t -d {DATA_DIR} -f {CONFIG}
ExecStart={MIHOMO} -d {DATA_DIR} -f {CONFIG}
Restart=on-failure
RestartSec=5s
NoNewPrivileges=true
ProtectHome=true
ProtectSystem=strict
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
ProtectClock=true
ProtectHostname=true
UnsetEnvironment=HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY http_proxy https_proxy all_proxy no_proxy NODE_USE_ENV_PROXY
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictRealtime=true
LockPersonality=true
CapabilityBoundingSet=
AmbientCapabilities=
ReadWritePaths={DATA_DIR}
UMask=0077
StandardOutput=null
StandardError=null

[Install]
WantedBy=multi-user.target
'''
    return text.encode('ascii')


def config_test(config_path: Path = CONFIG) -> None:
    run_command([RUNUSER, '-u', EGRESS_ACCOUNT, '--', str(MIHOMO), '-t',
                 '-d', str(DATA_DIR), '-f', str(config_path)],
                timeout=45, code='MIHOMO_CONFIG_INVALID')


def systemctl(*arguments: str, code: str = 'SYSTEMD_OPERATION_FAILED',
              allowed_statuses: frozenset[int] = frozenset((0,))) -> subprocess.CompletedProcess:
    return run_command([SYSTEMCTL, *arguments], timeout=60, code=code,
                       allowed_statuses=allowed_statuses)


def _wait_listener(gateway: str, port: int, timeout: float = 15) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with socket.create_connection((gateway, port), timeout=0.5):
                return
        except OSError:
            time.sleep(0.2)
    raise InstallerError('MIHOMO_LISTENER_UNAVAILABLE')


def _proxy_auth_header(username: str, password: str) -> str:
    token = base64.b64encode((username + ':' + password).encode('utf-8')).decode('ascii')
    return 'Basic ' + token


def _proxy_https_request(gateway: str, username: str, password: str,
                         hostname: str, method: str, path: str,
                         body: bytes | None = None,
                         authorization: str | None = None) -> tuple[int, bytes]:
    import ssl
    connection = http.client.HTTPSConnection(gateway, PORT, timeout=20,
                                               context=ssl.create_default_context())
    connection.set_tunnel(hostname, 443, headers={'Proxy-Authorization': _proxy_auth_header(username, password)})
    headers = {'Host': hostname, 'Connection': 'close', 'User-Agent': 'ai-project-os-egress-check/1'}
    if body is not None:
        headers['Content-Type'] = 'application/json'
        headers['Content-Length'] = str(len(body))
    if authorization is not None:
        headers['Authorization'] = authorization
    try:
        connection.request(method, path, body=body, headers=headers)
        response = connection.getresponse()
        response_body = response.read(64 * 1024 + 1)
        require(len(response_body) <= 64 * 1024, 'PROXY_RESPONSE_TOO_LARGE')
        return response.status, response_body
    except InstallerError:
        raise
    except (OSError, http.client.HTTPException, TimeoutError) as error:
        raise InstallerError('PROXY_HTTPS_SMOKE_FAILED') from error
    finally:
        connection.close()


def _proxy_non_openai_denied(gateway: str, username: str, password: str) -> bool:
    hostname = 'example.com'
    request = (f'CONNECT {hostname}:443 HTTP/1.1\r\n'
               f'Host: {hostname}:443\r\n'
               f'Proxy-Authorization: {_proxy_auth_header(username, password)}\r\n'
               'Proxy-Connection: Keep-Alive\r\n\r\n').encode('ascii')
    try:
        connection = socket.create_connection((gateway, PORT), timeout=10)
        with connection:
            connection.settimeout(10)
            connection.sendall(request)
            response = bytearray()
            while b'\r\n\r\n' not in response and len(response) < 8192:
                chunk = connection.recv(min(1024, 8192 - len(response)))
                if not chunk:
                    break
                response.extend(chunk)
            require(b'\r\n\r\n' in response, 'PROXY_REJECT_RESPONSE_INVALID')
            header = bytes(response).split(b'\r\n', 1)[0]
            match = re.fullmatch(rb'HTTP/1\.[01] ([1-5][0-9][0-9])(?: .*)?', header)
            require(match is not None, 'PROXY_REJECT_RESPONSE_INVALID')
            status = int(match.group(1))
            if 400 <= status < 500:
                return True
            require(status == 200, 'PROXY_REJECT_RESPONSE_INVALID')

            import ssl
            tls_connection = None
            try:
                context = ssl.create_default_context()
                tls_connection = context.wrap_socket(
                    connection, server_hostname=hostname, do_handshake_on_connect=False)
                tls_connection.settimeout(10)
                tls_connection.do_handshake()
                return False
            except (ssl.SSLEOFError, ssl.SSLZeroReturnError,
                    ConnectionResetError, BrokenPipeError):
                return True
            except (OSError, ssl.SSLError, TimeoutError) as error:
                raise InstallerError('PROXY_REJECT_SMOKE_INDETERMINATE') from error
            finally:
                if tls_connection is not None:
                    tls_connection.close()
    except InstallerError:
        raise
    except (OSError, TimeoutError) as error:
        raise InstallerError('PROXY_REJECT_SMOKE_FAILED') from error


def verify_proxy_smoke(gateway: str, username: str, password: str) -> dict:
    trace_status, trace_body = _proxy_https_request(
        gateway, username, password, 'api.openai.com', 'GET', '/cdn-cgi/trace')
    require(trace_status == 200, 'PROXY_TRACE_STATUS_INVALID')
    trace = parse_trace(trace_body)
    fake_key_body = json.dumps({
        'model': 'gpt-4.1-mini',
        'messages': [{'role': 'user', 'content': 'Connectivity diagnostic'}],
        'max_tokens': 1,
    }, separators=(',', ':')).encode('utf-8')
    status, raw = _proxy_https_request(
        gateway, username, password, 'api.openai.com', 'POST', '/v1/chat/completions', fake_key_body,
        authorization='Bearer diagnostic-not-a-real-api-key')
    require(status == 401, 'OPENAI_FAKE_KEY_STATUS_INVALID')
    try:
        body = json.loads(raw.decode('utf-8'), object_pairs_hook=unique_object)
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError, RecursionError) as error:
        raise InstallerError('OPENAI_FAKE_KEY_RESPONSE_INVALID') from error
    require(isinstance(body, dict) and isinstance(body.get('error'), dict)
            and body['error'].get('code') == 'invalid_api_key', 'OPENAI_FAKE_KEY_CODE_INVALID')
    denied = _proxy_non_openai_denied(gateway, username, password)
    require(denied, 'NON_OPENAI_NOT_REJECTED')
    return {'proxy_loc': trace['loc'], 'proxy_colo': trace['colo'],
            'openai_401': True, 'non_openai_rejected': True}


def start_proxy_service() -> None:
    systemctl('daemon-reload', code='SYSTEMD_RELOAD_FAILED')
    systemctl('enable', '--now', UNIT.name, code='SYSTEMD_START_FAILED')
    systemctl('is-active', '--quiet', UNIT.name, code='SYSTEMD_INACTIVE')


def stop_proxy_service(*, strict: bool = True) -> None:
    statuses = frozenset((0, 5)) if not strict else frozenset((0,))
    systemctl('disable', '--now', UNIT.name, code='SYSTEMD_STOP_FAILED',
              allowed_statuses=statuses)


def _http_json(url: str, *, timeout: int = 20) -> dict:
    import ssl
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}),
                                         urllib.request.HTTPSHandler(context=ssl.create_default_context()),
                                         NoRedirectHandler())
    request = urllib.request.Request(url, headers={'Accept': 'application/json'})
    try:
        with opener.open(request, timeout=timeout) as response:
            require(response.status == 200, 'HEALTH_HTTP_STATUS_INVALID')
            raw = response.read(64 * 1024 + 1)
    except InstallerError:
        raise
    except (OSError, urllib.error.URLError, TimeoutError) as error:
        raise InstallerError('HEALTH_REQUEST_FAILED') from error
    require(len(raw) <= 64 * 1024, 'HEALTH_RESPONSE_TOO_LARGE')
    try:
        value = json.loads(raw.decode('utf-8'), object_pairs_hook=unique_object)
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError, RecursionError) as error:
        raise InstallerError('HEALTH_RESPONSE_INVALID') from error
    require(isinstance(value, dict), 'HEALTH_RESPONSE_INVALID')
    return value


def validate_health_payload(payload: dict, version: str) -> None:
    require(payload.get('status') == 'ok' and payload.get('version') == version
            and payload.get('database') == 'up', 'HEALTH_PAYLOAD_INVALID')
    worker = payload.get('worker')
    require(isinstance(worker, dict) and worker.get('status') == 'up'
            and worker.get('consecutiveFailures') == 0, 'HEALTH_WORKER_INVALID')


def verify_application_health(version: str) -> None:
    local = _http_json('http://127.0.0.1:3000/api/health')
    public = _http_json('https://ai-project-os.com/api/health')
    validate_health_payload(local, version)
    validate_health_payload(public, version)


def _existing_account() -> tuple[pwd.struct_passwd | None, object | None]:
    import grp
    try:
        user = pwd.getpwnam(EGRESS_ACCOUNT)
    except KeyError:
        user = None
    try:
        group = grp.getgrnam(EGRESS_GROUP)
    except KeyError:
        group = None
    require((user is None) == (group is None), 'EGRESS_ACCOUNT_PARTIAL_CONFLICT')
    if user is not None:
        safe_user, safe_group = _account_identity()
        require(safe_user.pw_uid == user.pw_uid and safe_group.gr_gid == group.gr_gid,
                'EGRESS_ACCOUNT_CONFLICT')
    return user, group


def validate_installation_paths(account_exists: bool) -> None:
    _trusted_directory(UNIT_LINK.parent, 0o755, group=0)
    _ensure_absent(CONFIG, 'EGRESS_CONFIG_CONFLICT')
    _ensure_absent(MIHOMO, 'EGRESS_BINARY_CONFLICT')
    _ensure_absent(UNIT, 'EGRESS_SYSTEMD_UNIT_CONFLICT')
    _ensure_absent(UNIT_LINK, 'EGRESS_SYSTEMD_ENABLEMENT_CONFLICT')
    if any(path.exists() or path.is_symlink() for path in (ETC_DIR, DATA_DIR, BIN_DIR)):
        require(account_exists, 'EGRESS_DIRECTORY_CONFLICT')
        _user, group = _existing_account()
        _create_directory(ETC_DIR, 0o750, 0, group.gr_gid, existing_ok=True)
        require(not any(ETC_DIR.iterdir()), 'EGRESS_CONFIG_DIRECTORY_NOT_EMPTY')
        _create_directory(DATA_DIR, 0o700, _user.pw_uid, group.gr_gid, existing_ok=True)
        _create_directory(BIN_DIR, 0o755, 0, 0, existing_ok=True)
        require(not any(BIN_DIR.iterdir()), 'EGRESS_BINARY_DIRECTORY_NOT_EMPTY')


def _verify_managed_file(path: Path, digest: str, mode: int, gid: int | None = None) -> bool:
    if not path.exists() and not path.is_symlink():
        return False
    raw, info = _read_root_file(path, mode, MAX_MIHOMO_BINARY)
    require(gid is None or info.st_gid == gid, 'MANAGED_FILE_OWNERSHIP_CONFLICT')
    require(sha256_bytes(raw) == digest, 'MANAGED_FILE_CONTENT_CONFLICT')
    return True


def _remove_managed_file(path: Path, digest: str, mode: int, gid: int | None = None) -> bool:
    if not _verify_managed_file(path, digest, mode, gid):
        return False
    path.unlink()
    return True


def _assert_owned_unit_link(*, allow_missing: bool = True) -> bool:
    try:
        info = UNIT_LINK.lstat()
    except FileNotFoundError:
        require(allow_missing, 'SYSTEMD_ENABLEMENT_LINK_MISSING')
        return False
    require(stat.S_ISLNK(info.st_mode) and info.st_uid == 0,
            'SYSTEMD_ENABLEMENT_LINK_CONFLICT')
    target = Path(os.path.normpath(os.path.join(str(UNIT_LINK.parent), os.readlink(UNIT_LINK))))
    require(target == UNIT, 'SYSTEMD_ENABLEMENT_LINK_CONFLICT')
    return True


def cleanup_managed_installation(state: dict) -> bool:
    """Stop and remove only the files whose root-owned hashes are in private state."""
    try:
        owned = (
            (UNIT, state.get('unit_sha256'), 0o644, 0),
            (CONFIG, state.get('config_sha256'), 0o640, state.get('egress_gid')),
            (MIHOMO, state.get('mihomo_sha256'), 0o755, 0),
        )
        for path, digest, mode, gid in owned:
            if digest is not None:
                _verify_managed_file(path, digest, mode, gid)
        unit_present = UNIT.exists() or UNIT.is_symlink()
        link_present = UNIT_LINK.exists() or UNIT_LINK.is_symlink()
        if (state.get('phase') in UNIT_INSTALLED_PHASES
                and not unit_present and not link_present):
            activity = systemctl('is-active', '--quiet', UNIT.name,
                                 code='SYSTEMD_ACTIVITY_CHECK_FAILED',
                                 allowed_statuses=frozenset((0, 3, 4)))
            require(activity.returncode == 3, 'SYSTEMD_UNIT_MISSING_OR_ACTIVE')
        if link_present:
            _assert_owned_unit_link(allow_missing=False)
        if unit_present:
            systemctl('disable', '--now', UNIT.name, code='SYSTEMD_STOP_FAILED',
                      allowed_statuses=frozenset((0, 5)))
            if _assert_owned_unit_link():
                UNIT_LINK.unlink()
            _remove_managed_file(UNIT, state.get('unit_sha256'), 0o644, 0)
            systemctl('daemon-reload', code='SYSTEMD_RELOAD_FAILED')
        elif link_present:
            # The unit file disappeared outside this installer. Remove only its
            # verified enablement link, but retain the daemon/config and report
            # incomplete rollback because systemd may still have it loaded.
            _assert_owned_unit_link(allow_missing=False)
            UNIT_LINK.unlink()
            systemctl('daemon-reload', code='SYSTEMD_RELOAD_FAILED')
            return False
        if state.get('config_sha256') is not None:
            _remove_managed_file(CONFIG, state['config_sha256'], 0o640, state.get('egress_gid'))
        if state.get('mihomo_sha256') is not None:
            _remove_managed_file(MIHOMO, state['mihomo_sha256'], 0o755, 0)
        for raw_path in reversed(state.get('created_directories', [])):
            path = Path(raw_path)
            require(path in (ETC_DIR, DATA_DIR, BIN_DIR), 'ROLLBACK_STATE_INVALID')
            try:
                info = path.lstat()
            except FileNotFoundError:
                continue
            expected = {
                ETC_DIR: (0, state.get('egress_gid'), 0o750),
                DATA_DIR: (state.get('egress_uid'), state.get('egress_gid'), 0o700),
                BIN_DIR: (0, 0, 0o755),
            }[path]
            require(stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode)
                    and (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)) == expected,
                    'ROLLBACK_DIRECTORY_CONFLICT')
            if any(path.iterdir()):
                continue
            path.rmdir()
        return True
    except (InstallerError, OSError):
        return False


def _same_database_and_git_worker(before: dict, after: dict) -> tuple[bool, bool]:
    database = (before['postgres_container_id'] == after['postgres_container_id']
                and before['postgres_image_id'] == after['postgres_image_id'])
    git_worker = (before['git_worker_container_id'] == after['git_worker_container_id']
                  and before['git_worker_image_id'] == after['git_worker_image_id'])
    return database, git_worker


def verify_worker_runtime() -> None:
    result = compose_command('exec', '-T', 'worker', 'node', '--import', 'tsx',
                             '--input-type=module', '-', input_data=build_worker_smoke_script(),
                             timeout=60, code='WORKER_OPENAI_SMOKE_FAILED')
    require(result.stdout.strip() == b'OPENAI_EGRESS_RUNTIME_OK',
            'WORKER_OPENAI_SMOKE_INVALID')


def _sanitize_state(state: dict, status: str, rollback_status: str) -> dict:
    return {
        'schema': 1,
        'status': status,
        'version': state['version'],
        'revision': state['revision'],
        'rollback_status': rollback_status,
        'updated_at': datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
    }


def _write_receipt_from_state(state: dict, status: str, rollback_status: str,
                              **checks) -> None:
    write_status(status_receipt(state['version'], state['revision'], status,
                                rollback_status, **checks))


def _runtime_matches_pinned(state: dict) -> dict:
    current = capture_runtime(state['version'], state['revision'], require_writers_healthy=False,
                              require_services_running=False)
    require(current['app_image_id'] == state['app_image_id']
            and current['worker_image_id'] == state['worker_image_id'],
            'ROLLBACK_APPLICATION_IMAGE_CONFLICT')
    database_same, git_worker_same = _same_database_and_git_worker(state['baseline_runtime'], current)
    require(database_same and git_worker_same, 'ROLLBACK_UNRELATED_RUNTIME_CONFLICT')
    return current


def _try_restore_env(state: dict) -> bool:
    try:
        current, info = read_production_env()
        restored = rollback_env_bytes(current, state)
        if restored != current:
            safe_env_write(restored, info)
        return True
    except InstallerError:
        return False


def rollback_state(state: dict, *, automatic: bool) -> bool:
    checks = {
        'proxy_loc': state.get('smoke', {}).get('proxy_loc'),
        'proxy_colo': state.get('smoke', {}).get('proxy_colo'),
        'openai_401': state.get('smoke', {}).get('openai_401'),
        'non_openai_rejected': state.get('smoke', {}).get('non_openai_rejected'),
        'app_healthy': None,
        'worker_healthy': None,
        'public_health': None,
        'database_unchanged': None,
        'git_worker_unchanged': None,
    }
    success = True
    compose_was_attempted = state.get('phase') in ('compose_attempted', 'app_worker_recreated', 'verified', 'installed')
    runtime_ok = False
    runtime_snapshot = None
    try:
        runtime_snapshot = _runtime_matches_pinned(state)
        runtime_ok = True
    except InstallerError:
        success = False
    env_restored = _try_restore_env(state) if runtime_ok else False
    success = env_restored and success
    if compose_was_attempted and env_restored:
        try:
            before_restore = runtime_snapshot
            recreate_app_worker(state['app_image_id'], state['worker_image_id'])
            after = capture_runtime(state['version'], state['revision'], require_writers_healthy=True)
            require(after['app_container_id'] != before_restore['app_container_id']
                    and after['worker_container_id'] != before_restore['worker_container_id'],
                    'ROLLBACK_APP_WORKER_NOT_RECREATED')
            database_same, git_worker_same = _same_database_and_git_worker(state['baseline_runtime'], after)
            require(database_same and git_worker_same, 'ROLLBACK_UNRELATED_RUNTIME_CHANGED')
            verify_application_health(state['version'])
            checks.update({'app_healthy': after['app_healthy'], 'worker_healthy': after['worker_healthy'],
                           'public_health': True, 'database_unchanged': database_same,
                           'git_worker_unchanged': git_worker_same})
        except InstallerError:
            success = False
    elif compose_was_attempted:
        success = False
    cleanup_ok = cleanup_managed_installation(state) if env_restored and runtime_ok else False
    success = cleanup_ok and success
    if success:
        sanitized = _sanitize_state(state, 'rolled_back', 'succeeded')
        write_private_state(sanitized)
        _write_receipt_from_state(state, 'rolled_back', 'succeeded', **checks)
    else:
        state['status'] = 'rollback_incomplete'
        state['rollback_status'] = 'failed'
        write_private_state(state)
        _write_receipt_from_state(state, 'rollback_incomplete', 'failed', **checks)
    return success


def preflight(version: str, revision: str, payload_path: str,
              payload_sha256: str) -> tuple[dict, dict, str, bytes, os.stat_result, dict | None]:
    validate_expected(version, revision)
    validate_compose_files()
    validate_repository_revision(revision)
    runtime = capture_runtime(version, revision)
    gateway = docker_network_gateway(runtime)
    env_bytes, env_info = read_production_env()
    payload = read_private_payload(payload_path, payload_sha256)
    previous_state = current_state_file()
    if previous_state is not None:
        require(previous_state.get('status') == 'rolled_back', 'EGRESS_INSTALLATION_ALREADY_EXISTS')
    user, group = _existing_account()
    validate_installation_paths(user is not None)
    if STATUS_DIR.exists() or STATUS_DIR.is_symlink():
        _ensure_status_dir()
    else:
        _trusted_directory(STATUS_DIR.parent, 0o755, group=0)
    read_status()
    return payload, runtime, gateway, env_bytes, env_info, previous_state


def print_plan(version: str, revision: str) -> None:
    print(f'OPENAI_EGRESS_PLAN_OK version={version} revision={revision}')


def apply_installation(version: str, revision: str, payload_path: str,
                       payload_sha256: str) -> dict:
    payload, runtime, gateway, env_bytes, env_info, _old_state = preflight(
        version, revision, payload_path, payload_sha256)
    write_status(status_receipt(version, revision, 'applying', 'pending',
                                openai_401=None, proxy_loc=None, proxy_colo=None,
                                non_openai_rejected=None, app_healthy=None,
                                worker_healthy=None, public_health=None,
                                database_unchanged=None, git_worker_unchanged=None))
    try:
        binary, binary_digest = download_mihomo()
        username = secrets.token_urlsafe(18)
        password = secrets.token_urlsafe(36)
        proxy_url = build_proxy_url(gateway, username, password)
        node = payload['node']
        config_bytes = build_mihomo_config(node, gateway, PORT, username, password)
        unit_bytes = build_systemd_unit()
        new_env, env_delta = edit_env_bytes(env_bytes, proxy_url)
    except Exception:
        write_status(status_receipt(version, revision, 'failed', 'not_started',
                                    openai_401=None, proxy_loc=None, proxy_colo=None,
                                    non_openai_rejected=None, app_healthy=None,
                                    worker_healthy=None, public_health=None,
                                    database_unchanged=None, git_worker_unchanged=None))
        raise
    user_before, _group_before = _existing_account()
    state = {
        'schema': 1,
        'status': 'prepared',
        'phase': 'preparing',
        'version': version,
        'revision': revision,
        'previous_line_b64': env_delta['previous_line_b64'],
        'append_separator_added': env_delta['append_separator_added'],
        'append_previous_last_line_b64': env_delta['append_previous_last_line_b64'],
        'installed_value': env_delta['installed_value'],
        'installed_value_sha256': env_delta['installed_value_sha256'],
        'original_env_sha256': sha256_bytes(env_bytes),
        'app_image_id': runtime['app_image_id'],
        'worker_image_id': runtime['worker_image_id'],
        'baseline_runtime': runtime,
        'gateway_ip': gateway,
        'egress_uid': None,
        'egress_gid': None,
        'created_directories': [],
        'mihomo_sha256': binary_digest,
        'config_sha256': sha256_bytes(config_bytes),
        'unit_sha256': sha256_bytes(unit_bytes),
        'smoke': {},
        'rollback_status': 'pending',
    }
    write_private_state(state)
    try:
        user, group, account_created = create_account_if_missing()
        state['egress_uid'] = user.pw_uid
        state['egress_gid'] = group.gr_gid
        state['egress_account_preexisting'] = not account_created and user_before is not None
        state['phase'] = 'account_ready'
        write_private_state(state)

        def record_created_directory(path: str) -> None:
            state['created_directories'].append(path)
            write_private_state(state)

        install_directories(user.pw_uid, group.gr_gid,
                            account_preexisting=state['egress_account_preexisting'],
                            on_created=record_created_directory)

        install_binary(binary, binary_digest)
        state['phase'] = 'binary_installed'
        write_private_state(state)
        _write_managed_file(CONFIG, config_bytes, 0o640, gid=group.gr_gid)
        config_test()
        state['phase'] = 'config_validated'
        write_private_state(state)
        _write_managed_file(UNIT, unit_bytes, 0o644)
        state['phase'] = 'unit_installed'
        write_private_state(state)

        start_proxy_service()
        _wait_listener(gateway, PORT)
        state['phase'] = 'proxy_started'
        write_private_state(state)
        state['smoke'] = verify_proxy_smoke(gateway, username, password)
        state['phase'] = 'proxy_verified'
        write_private_state(state)

        safe_env_write(new_env, env_info)
        state['phase'] = 'env_written'
        write_private_state(state)
        state['phase'] = 'compose_attempted'
        write_private_state(state)
        recreate_app_worker(runtime['app_image_id'], runtime['worker_image_id'])
        state['phase'] = 'app_worker_recreated'
        write_private_state(state)

        after = capture_runtime(version, revision, require_writers_healthy=True)
        require(after['app_image_id'] == runtime['app_image_id']
                and after['worker_image_id'] == runtime['worker_image_id'],
                'APP_WORKER_IMAGE_CHANGED')
        require(after['app_container_id'] != runtime['app_container_id']
                and after['worker_container_id'] != runtime['worker_container_id'],
                'APP_WORKER_NOT_RECREATED')
        database_same, git_worker_same = _same_database_and_git_worker(runtime, after)
        require(database_same and git_worker_same, 'UNRELATED_RUNTIME_CHANGED')
        verify_worker_runtime()
        verify_application_health(version)
        state['phase'] = 'verified'
        state['status'] = 'installed'
        state['rollback_status'] = 'available'
        state['checks'] = {
            'app_healthy': after['app_healthy'],
            'worker_healthy': after['worker_healthy'],
            'database_unchanged': database_same,
            'git_worker_unchanged': git_worker_same,
            'public_health': True,
            'direct_fetch_direct': True,
        }
        write_private_state(state)
        receipt_checks = {**state['smoke'], **state['checks']}
        _write_receipt_from_state(state, 'installed', 'available', **receipt_checks)
        return state
    except Exception:
        rollback_ok = rollback_state(state, automatic=True)
        if not rollback_ok:
            raise InstallerError('INSTALL_FAILED_ROLLBACK_INCOMPLETE')
        raise


def run_plan(version: str, revision: str, payload_path: str,
             payload_sha256: str) -> None:
    preflight(version, revision, payload_path, payload_sha256)


def rollback_installation() -> bool:
    state = current_state_file()
    require(state is not None, 'ROLLBACK_STATE_MISSING')
    if state.get('status') == 'rolled_back':
        return True
    require(state.get('status') in ('prepared', 'installed', 'rollback_incomplete'),
            'ROLLBACK_STATE_INVALID')
    return rollback_state(state, automatic=False)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description='Install or roll back OpenAI-only production egress.')
    commands = parser.add_subparsers(dest='command', required=True)
    for name in ('plan', 'apply'):
        command = commands.add_parser(name)
        command.add_argument('--version', required=True)
        command.add_argument('--revision', required=True)
        command.add_argument('--node-payload', required=True)
        command.add_argument('--sha256', required=True)
    commands.add_parser('rollback')
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        require(os.geteuid() == 0, 'ROOT_REQUIRED')
        lock_fd = acquire_lock()
        try:
            if args.command == 'plan':
                run_plan(args.version, args.revision, args.node_payload, args.sha256)
                print_plan(args.version, args.revision)
                return 0
            if args.command == 'apply':
                state = apply_installation(args.version, args.revision,
                                           args.node_payload, args.sha256)
                print('OPENAI_EGRESS_INSTALL_OK '
                      f"version={state['version']} revision={state['revision']} "
                      f"proxy_loc={state['smoke']['proxy_loc']} "
                      f"app_healthy={str(state['checks']['app_healthy']).lower()} "
                      f"worker_healthy={str(state['checks']['worker_healthy']).lower()} "
                      f"database_unchanged={str(state['checks']['database_unchanged']).lower()} "
                      f"git_worker_unchanged={str(state['checks']['git_worker_unchanged']).lower()}")
                return 0
            state = current_state_file()
            if state is not None and state.get('status') == 'rolled_back':
                print('OPENAI_EGRESS_ROLLBACK_ALREADY_COMPLETE')
                return 0
            rolled_back = rollback_installation()
            require(rolled_back, 'ROLLBACK_INCOMPLETE')
            print('OPENAI_EGRESS_ROLLBACK_OK')
            return 0
        finally:
            os.close(lock_fd)
    except InstallerError as error:
        print(f'OPENAI_EGRESS_FAILED code={error.code}', file=sys.stderr)
        return 1
    except Exception:
        print('OPENAI_EGRESS_FAILED code=INTERNAL_ERROR', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
