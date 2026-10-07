#!/usr/bin/python3
"""Human-operated v0.7.10 -> v0.7.11 cutover and explicit MCP enablement; no database changes."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import stat
import sys
import time
import fcntl

ROOT = Path('/srv/ai-project-os/repository')
SOURCE_REVISION = '8d7279e9a0f4d8e8808e2246670f80ec34359aa2'
HELPER_HASH = '01c1f299098da8e4e9316e92d57e42bcf95e89eeee8424e4fe51395d6cc2d95e'
TAG = 'v0.7.11'
CONFIRMATION = 'CONFIRM_V0711_AND_ENABLE_MCP_FAST_WITHOUT_BACKUP_OR_LEGACY_ACCEPTANCE'
WRITERS = ('app', 'worker', 'git-worker')


def require(condition, code):
    if not condition:
        raise RuntimeError('V0711_' + code)


def trusted(path, mode=None):
    path = Path(path)
    for part in [*reversed(path.parents), path]:
        info = part.lstat()
        require(info.st_uid == info.st_gid == 0 and not info.st_mode & 0o022
                and not part.is_symlink(), 'HOST_PATH_UNTRUSTED')
    if mode is not None:
        require(path.is_file() and path.stat().st_mode & 0o777 == mode, 'HOST_FILE_MODE_INVALID')


def helper():
    # Load only the root-owned, previously reviewed helper with its fixed hash.
    path = ROOT / 'deploy/production/ai-project-os-v074-deploy.py'
    trusted(path)
    require(hashlib.sha256(path.read_bytes()).hexdigest() == HELPER_HASH, 'HELPER_HASH_INVALID')
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location('v074_helper', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def source_state(lib):
    lib.trusted(lib.RESULT, 0o600)
    fields = dict(line.split('=', 1) for line in lib.RESULT.read_text().splitlines() if '=' in line)
    require(fields.get('tag') == 'v0.7.10' and fields.get('revision') == SOURCE_REVISION, 'SOURCE_RECORD_INVALID')
    lib.healthy('0.7.10'); lib.healthy('0.7.10', public=True)
    postgres = lib.container('postgres')
    require(postgres['State'].get('Health', {}).get('Status') == 'healthy'
            and postgres['Config']['Image'] == lib.IMAGE, 'POSTGRES_INVALID')
    # Bind the healthy source containers to the exact v0.7.10 receipt.
    writers = [lib.container(service) for service in WRITERS]
    require(all(w['State'].get('Health', {}).get('Status') == 'healthy'
                and w['State']['Running'] and not w['State']['Paused']
                and w['Config']['Labels'].get('org.opencontainers.image.version') == '0.7.10'
                for w in writers), 'SOURCE_WRITER_INVALID')
    return postgres['Id'], writers


MCP_SETTINGS = {
    'AI_PROJECT_OS_MCP_ACTIONS_ENABLED': 'true',
    'AI_PROJECT_OS_MCP_EXPORT_ENABLED': 'true',
    'AI_PROJECT_OS_MCP_EXPORT_OAUTH_ENABLED': 'true',
    'AI_PROJECT_OS_MCP_EXPORT_PUBLIC_ORIGIN': 'https://ai-project-os.com',
}


def enabled_mcp_environment(original):
    text = original.decode('utf-8')
    values = {}
    lines = text.splitlines(keepends=True)
    for line in lines:
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        key, separator, value = line.rstrip('\r\n').partition('=')
        require(separator == '=' and re.fullmatch(r'[A-Z][A-Z0-9_]*', key)
                and key not in values, 'ENV_SYNTAX_INVALID')
        values[key] = value
    require(values.get('AI_PROJECT_OS_PUBLIC_ORIGIN') == 'https://ai-project-os.com'
            and values.get('AI_PROJECT_OS_SECURE_COOKIES') == 'true', 'PUBLIC_ORIGIN_INVALID')
    for key in MCP_SETTINGS:
        require(values.get(key, '') in ('', 'false') if key.endswith('_ENABLED')
                else values.get(key, '') == '', 'MCP_SOURCE_CONFIG_CHANGED')
    result = []
    replaced = set()
    for line in lines:
        key = line.partition('=')[0]
        if key in MCP_SETTINGS:
            result.append(key + '=' + MCP_SETTINGS[key] + '\n')
            replaced.add(key)
        else:
            result.append(line)
    if result and not result[-1].endswith('\n'):
        result[-1] += '\n'
    result.extend(key + '=' + value + '\n' for key, value in MCP_SETTINGS.items() if key not in replaced)
    return ''.join(result).encode('utf-8')


def target_mcp_ready(lib):
    env = dict(item.split('=', 1) for item in lib.container('app')['Config']['Env'] if '=' in item)
    require(all(env.get(key) == value for key, value in MCP_SETTINGS.items()), 'MCP_RUNTIME_CONFIG_INVALID')
    metadata = lib.request_json('https://ai-project-os.com/.well-known/oauth-protected-resource/api/mcp')
    require(metadata.get('resource') == 'https://ai-project-os.com/api/mcp'
            and metadata.get('authorization_servers') == ['https://ai-project-os.com']
            and 'project:read' in metadata.get('scopes_supported', []), 'MCP_METADATA_INVALID')

def interrupted(_signum, _frame):
    raise RuntimeError('V0711_INTERRUPTED')


def main(args):
    require(os.geteuid() == 0, 'ROOT_REQUIRED')
    require(len(args) == 2 and re.fullmatch(r'[a-f0-9]{40}', args[0])
            and args[1] == CONFIRMATION, 'ARGUMENTS_INVALID')
    revision = args[0]
    os.umask(0o077)
    signal.signal(signal.SIGTERM, interrupted)
    trusted(Path(__file__).absolute(), 0o700)
    lib = helper()
    directory = os.lstat('/run/lock')
    require(stat.S_ISDIR(directory.st_mode) and directory.st_uid == directory.st_gid == 0
            and directory.st_mode & 0o7777 == 0o1777, 'LOCK_DIRECTORY_INVALID')
    fd = os.open('/run/lock/ai-project-os-deploy.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == info.st_gid == 0
                and info.st_mode & 0o777 == 0o600, 'LOCK_INVALID')
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        for path in (ROOT, ROOT / '.git', lib.OVERRIDE):
            trusted(path)
        trusted(lib.ENV, 0o600)
        require(lib.run(['git', '-C', str(ROOT), 'remote', 'get-url', 'origin']) == lib.REMOTE, 'REMOTE_INVALID')
        require(not lib.run(['git', '-C', str(ROOT), 'status', '--porcelain']), 'CHECKOUT_DIRTY')
        postgres_id, old_writers = source_state(lib)
        original_env = lib.ENV.read_bytes()
        target_env = enabled_mcp_environment(original_env)
        env_hash = hashlib.sha256(original_env).digest()
        override_hash = hashlib.sha256(lib.OVERRIDE.read_bytes()).digest()
        lib.run(['git', '-C', str(ROOT), 'fetch', '--no-tags', 'origin', 'refs/tags/' + TAG + ':refs/tags/' + TAG])
        require(lib.run(['git', '-C', str(ROOT), 'cat-file', '-t', 'refs/tags/' + TAG]) == 'tag', 'ANNOTATED_TAG_REQUIRED')
        require(lib.run(['git', '-C', str(ROOT), 'rev-parse', 'refs/tags/' + TAG + '^{}']) == revision, 'TAG_SHA_MISMATCH')
        # This patch must not require migration, principal reconciliation, or a
        # change of infrastructure. Only the four explicit MCP app settings change here.
        lib.run(['git', '-C', str(ROOT), 'diff', '--exit-code', SOURCE_REVISION, revision, '--',
                 'prisma', 'compose.yaml', 'deploy/production/nginx', 'scripts/reconcile-database-principals.ts'])
        lib.run(['git', '-C', str(ROOT), 'checkout', '--detach', revision])
        require(json.loads((ROOT / 'package.json').read_text())['version'] == '0.7.11', 'VERSION_INVALID')
        require(Path(__file__).read_bytes() == (ROOT / 'deploy/production/ai-project-os-v0711-deploy.py').read_bytes(), 'TOOL_MISMATCH')
        require('org.opencontainers.image.version="0.7.11"' in (ROOT / 'Dockerfile').read_text(), 'IMAGE_VERSION_INVALID')
        expected = lib.manifest(ROOT)
        lib.ledger(postgres_id, expected)
        print('V0711_SOURCE_READY migration_count=140 backup=waived_by_user ci_acceptance=waived_by_user_pre_1_0', flush=True)
        lib.compose('config', '--quiet')
        lib.compose('build', *WRITERS, capture=False, timeout=7200)
        new_pg, new_writers = source_state(lib)
        require(new_pg == postgres_id and [(w['Id'], w['Image']) for w in new_writers]
                == [(w['Id'], w['Image']) for w in old_writers], 'SOURCE_CHANGED')
        trusted(lib.ENV, 0o600); trusted(lib.OVERRIDE)
        require(hashlib.sha256(lib.ENV.read_bytes()).digest() == env_hash
                and hashlib.sha256(lib.OVERRIDE.read_bytes()).digest() == override_hash, 'CONFIG_CHANGED')
        lib.ledger(postgres_id, expected)
        cutting_over = False
        try:
            lib.docker('stop', *[w['Id'] for w in old_writers])
            lib.stopped(postgres_id)
            cutting_over = True
            lib.atomic_write(lib.ENV, target_env, 0o600)
            lib.compose('config', '--quiet')
            lib.compose('up', '-d', '--no-deps', '--no-build', '--force-recreate', *WRITERS)
            for _ in range(120):
                if all(lib.container(s)['State'].get('Health', {}).get('Status') == 'healthy' for s in WRITERS):
                    break
                time.sleep(2)
            else:
                raise RuntimeError('V0711_HEALTH_TIMEOUT')
            require(all(lib.container(s)['Config']['Labels'].get('org.opencontainers.image.version') == '0.7.11' for s in WRITERS), 'TARGET_IMAGE_VERSION_INVALID')
            health = lib.healthy('0.7.11')
            lib.healthy('0.7.11', public=True)
            target_mcp_ready(lib)
            require(hashlib.sha256(lib.ENV.read_bytes()).digest() == hashlib.sha256(target_env).digest()
                    and hashlib.sha256(lib.OVERRIDE.read_bytes()).digest() == override_hash, 'TARGET_CONFIG_CHANGED')
            require(lib.container('postgres')['Id'] == postgres_id, 'POSTGRES_CHANGED')
            lib.ledger(postgres_id, expected)
            record = ('DEPLOY_OK\ntag=' + TAG + '\nsource_tag=v0.7.10\nsource_revision=' + SOURCE_REVISION
                      + '\nrevision=' + revision + '\nmigration_count=140\nmcp_actions=true\nmcp_export=true\nmcp_oauth=true\nbackup=waived_by_user\nci_acceptance=waived_by_user_pre_1_0\nhealth='
                      + json.dumps(health, separators=(',', ':')) + '\ncompleted_at='
                      + time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()) + '\n')
            lib.atomic_write(lib.RESULT, record.encode(), 0o600)
            print('V0711_DEPLOY_OK tag=' + TAG + ' revision=' + revision + ' migration_count=140', flush=True)
        except BaseException:
            if cutting_over:
                lib.quiesce_after_failure(postgres_id)
                print('V0711_CUTOVER_FAILED writers_stopped=true', file=sys.stderr)
            else:
                lib.restart_source(old_writers)
            raise
    finally:
        os.close(fd)


if __name__ == '__main__':
    try:
        main(sys.argv[1:])
    except BaseException as error:
        code = str(error) if isinstance(error, RuntimeError) and re.fullmatch(r'(?:V074|V0711)_[A-Z0-9_]+', str(error)) else 'V0711_UNEXPECTED_FAILURE'
        print(code, file=sys.stderr)
        sys.exit(1)
