#!/usr/bin/python3 -I
"""Install one fixed DirectMail environment file; no mail or service actions."""
import fcntl
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile

ENV_DIRECTORY = Path('/etc/ai-project-os')
ENV_FILE = ENV_DIRECTORY / 'email-auth.env'
LOCK_FILE = Path('/run/lock/ai-project-os-deploy.lock')
SCHEMA = 'AI_PROJECT_OS_EMAIL_AUTH_CONFIG_V1'
PREFIX = 'AI_PROJECT_OS_ALIYUN_DM_'
KEYS = ('AI_PROJECT_OS_EMAIL_AUTH_ENABLED', PREFIX+'ACCESS_KEY_ID',
        PREFIX+'ACCESS_KEY_SECRET', PREFIX+'REGION_ID', PREFIX+'ACCOUNT_NAME')
REGIONS = {'cn-hangzhou', 'ap-southeast-1', 'ap-southeast-2', 'us-east-1', 'eu-central-1'}
MAX_BYTES = 8192


class GateFailure(Exception):
    pass


def fail(code):
    raise GateFailure('PRODUCTION_EMAIL_AUTH_'+code)


def valid_address(value):
    if not isinstance(value, str) or len(value) > 320 or not re.fullmatch(r'[!-~]+', value):
        return False
    parts = value.split('@')
    if len(parts) != 2:
        return False
    local, domain = parts
    labels = domain.split('.')
    return (0 < len(local) <= 64 and not local.startswith('.') and not local.endswith('.')
            and '..' not in local and re.fullmatch(r"[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+", local)
            and len(labels) >= 2 and all(re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?', p) for p in labels))


def configuration_bytes(payload):
    if not isinstance(payload, dict) or set(payload) != {'schema', 'accessKeyId', 'accessKeySecret', 'regionId', 'accountName'}:
        fail('PAYLOAD_INVALID')
    if payload['schema'] != SCHEMA:
        fail('PAYLOAD_INVALID')
    key, secret, region, sender = (payload[k] for k in ('accessKeyId', 'accessKeySecret', 'regionId', 'accountName'))
    if not isinstance(key, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', key):
        fail('ACCESS_KEY_ID_INVALID')
    if not isinstance(secret, str) or not re.fullmatch(r'[!-~]{1,512}', secret):
        fail('ACCESS_KEY_SECRET_INVALID')
    if not isinstance(region, str) or region not in REGIONS:
        fail('REGION_INVALID')
    if not valid_address(sender):
        fail('SENDER_INVALID')
    # Compose env_file format:raw retains dollars, quotes and backslashes.
    # Values are never interpreted by a shell or written into a Compose file.
    values = ('true', key, secret, region, sender)
    return ''.join(f'{name}={value}\n' for name, value in zip(KEYS, values)).encode('ascii')


def parse_payload(data):
    if not data or len(data) > MAX_BYTES:
        fail('PAYLOAD_INVALID')
    try:
        def unique_object(pairs):
            result = {}
            for key, value in pairs:
                if key in result:
                    fail('PAYLOAD_INVALID')
                result[key] = value
            return result
        return configuration_bytes(json.loads(data.decode('utf-8'), object_pairs_hook=unique_object))
    except (UnicodeError, ValueError, TypeError):
        fail('PAYLOAD_INVALID')


def require_compose_version(value):
    match = re.fullmatch(r'v?([0-9]+)\.([0-9]+)\.([0-9]+)(?:[-+][A-Za-z0-9._-]+)?', value.strip())
    if not match or tuple(map(int, match.groups())) < (2, 30, 0):
        fail('COMPOSE_VERSION_UNSUPPORTED')


def metadata(path, kind, uid=0, gid=0, mode=None):
    info = path.lstat()
    expected = stat.S_ISDIR if kind == 'directory' else stat.S_ISREG
    if not expected(info.st_mode) or (info.st_uid, info.st_gid) != (uid, gid):
        fail('PATH_INVALID')
    permissions = stat.S_IMODE(info.st_mode)
    if mode is not None and permissions != mode:
        fail('PATH_MODE_INVALID')
    if kind == 'directory' and permissions & 0o022:
        fail('DIRECTORY_WRITABLE')
    if kind == 'file' and info.st_nlink != 1:
        fail('PATH_INVALID')
    return info


def existing_configuration_valid(data):
    if not data or len(data) > MAX_BYTES or not data.endswith(b'\n'):
        fail('EXISTING_CONFIG_INVALID')
    try:
        lines = data.decode('ascii').splitlines()
        pairs = [line.split('=', 1) for line in lines]
        if len(pairs) != len(KEYS) or any(len(pair) != 2 for pair in pairs):
            fail('EXISTING_CONFIG_INVALID')
        values = dict(pairs)
        if len(values) != len(KEYS) or set(values) != set(KEYS) or values[KEYS[0]] != 'true':
            fail('EXISTING_CONFIG_INVALID')
        configuration_bytes({'schema': SCHEMA, 'accessKeyId': values[KEYS[1]],
                             'accessKeySecret': values[KEYS[2]], 'regionId': values[KEYS[3]],
                             'accountName': values[KEYS[4]]})
    except (UnicodeError, ValueError):
        fail('EXISTING_CONFIG_INVALID')


def atomic_configuration(directory, destination, data, uid=0, gid=0):
    metadata(directory, 'directory', uid, gid)
    if destination.exists() or destination.is_symlink():
        metadata(destination, 'file', uid, gid, 0o600)
        flags = os.O_RDONLY | os.O_NOFOLLOW
        with os.fdopen(os.open(destination, flags), 'rb') as source:
            old = source.read(MAX_BYTES+1)
        existing_configuration_valid(old)
        if old == data:
            return
    descriptor, temporary = tempfile.mkstemp(prefix='.email-auth.env.', dir=directory)
    try:
        os.fchmod(descriptor, 0o600)
        os.fchown(descriptor, uid, gid)
        with os.fdopen(descriptor, 'wb') as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        metadata(Path(temporary), 'file', uid, gid, 0o600)
        os.replace(temporary, destination)
        directory_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        if os.path.lexists(temporary):
            os.unlink(temporary)


def main():
    if os.geteuid() != 0 or len(sys.argv) != 1:
        fail('ROOT_OR_ARGUMENT_INVALID')
    data = parse_payload(sys.stdin.buffer.read(MAX_BYTES+1))
    metadata(Path('/etc'), 'directory')
    metadata(ENV_DIRECTORY, 'directory')
    metadata(ENV_DIRECTORY/'production.env', 'file', mode=0o600)
    version = subprocess.run(['/usr/bin/docker', 'compose', 'version', '--short'],
                             check=True, timeout=10, capture_output=True, text=True,
                             env={'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C'})
    require_compose_version(version.stdout)
    lock_directory = LOCK_FILE.parent.lstat()
    if not stat.S_ISDIR(lock_directory.st_mode) or (lock_directory.st_uid, lock_directory.st_gid) != (0, 0):
        fail('LOCK_DIRECTORY_INVALID')
    lock_mode = stat.S_IMODE(lock_directory.st_mode)
    if lock_mode & 0o022 and not lock_mode & stat.S_ISVTX:
        fail('LOCK_DIRECTORY_INVALID')
    lock_fd = os.open(LOCK_FILE, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(lock_fd)
        if not stat.S_ISREG(info.st_mode) or (info.st_uid, info.st_gid) != (0, 0) or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1:
            fail('LOCK_INVALID')
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            fail('DEPLOYMENT_IN_PROGRESS')
        atomic_configuration(ENV_DIRECTORY, ENV_FILE, data)
    finally:
        os.close(lock_fd)
    print('PRODUCTION_EMAIL_AUTH_CONFIG_OK')


if __name__ == '__main__':
    try:
        main()
    except GateFailure as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(70)
    except (OSError, subprocess.SubprocessError):
        print('PRODUCTION_EMAIL_AUTH_CONFIG_FAILED', file=sys.stderr)
        raise SystemExit(70)
