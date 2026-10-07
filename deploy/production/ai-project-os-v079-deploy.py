#!/usr/bin/python3
"""Human-operated v0.7.8 -> v0.7.9 patch cutover; no database/config changes."""
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
SOURCE_REVISION = 'd80aaea590b18dcaa3602c9f7974ffc313dd1615'
HELPER_HASH = '01c1f299098da8e4e9316e92d57e42bcf95e89eeee8424e4fe51395d6cc2d95e'
TAG = 'v0.7.9'
CONFIRMATION = 'CONFIRM_V079_FAST_WITHOUT_BACKUP_OR_LEGACY_ACCEPTANCE'
WRITERS = ('app', 'worker', 'git-worker')


def require(condition, code):
    if not condition:
        raise RuntimeError('V079_' + code)


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
    require(fields.get('tag') == 'v0.7.8' and fields.get('revision') == SOURCE_REVISION, 'SOURCE_RECORD_INVALID')
    lib.healthy('0.7.8'); lib.healthy('0.7.8', public=True)
    postgres = lib.container('postgres')
    require(postgres['State'].get('Health', {}).get('Status') == 'healthy'
            and postgres['Config']['Image'] == lib.IMAGE, 'POSTGRES_INVALID')
    writers = [lib.container(service) for service in WRITERS]
    require(all(w['State'].get('Health', {}).get('Status') == 'healthy'
                and w['State']['Running'] and not w['State']['Paused']
                and w['Config']['Labels'].get('org.opencontainers.image.version') == '0.7.8'
                for w in writers), 'SOURCE_WRITER_INVALID')
    return postgres['Id'], writers


def interrupted(_signum, _frame):
    raise RuntimeError('V079_INTERRUPTED')


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
        env_hash = hashlib.sha256(lib.ENV.read_bytes()).digest()
        override_hash = hashlib.sha256(lib.OVERRIDE.read_bytes()).digest()
        lib.run(['git', '-C', str(ROOT), 'fetch', '--no-tags', 'origin', 'refs/tags/' + TAG + ':refs/tags/' + TAG])
        require(lib.run(['git', '-C', str(ROOT), 'cat-file', '-t', 'refs/tags/' + TAG]) == 'tag', 'ANNOTATED_TAG_REQUIRED')
        require(lib.run(['git', '-C', str(ROOT), 'rev-parse', 'refs/tags/' + TAG + '^{}']) == revision, 'TAG_SHA_MISMATCH')
        # This patch must not require migration, principal reconciliation, or a
        # change of infrastructure. A future schema/config release needs its own entry.
        lib.run(['git', '-C', str(ROOT), 'diff', '--exit-code', SOURCE_REVISION, revision, '--',
                 'prisma', 'compose.yaml', 'deploy/production/nginx', 'scripts/reconcile-database-principals.ts'])
        lib.run(['git', '-C', str(ROOT), 'checkout', '--detach', revision])
        require(json.loads((ROOT / 'package.json').read_text())['version'] == '0.7.9', 'VERSION_INVALID')
        require(Path(__file__).read_bytes() == (ROOT / 'deploy/production/ai-project-os-v079-deploy.py').read_bytes(), 'TOOL_MISMATCH')
        expected = lib.manifest(ROOT)
        lib.ledger(postgres_id, expected)
        print('V079_SOURCE_READY migration_count=140 backup=waived_by_user ci_acceptance=waived_by_user_pre_1_0', flush=True)
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
            lib.compose('up', '-d', '--no-deps', '--no-build', '--force-recreate', *WRITERS)
            for _ in range(120):
                if all(lib.container(s)['State'].get('Health', {}).get('Status') == 'healthy' for s in WRITERS):
                    break
                time.sleep(2)
            else:
                raise RuntimeError('V079_HEALTH_TIMEOUT')
            health = lib.healthy('0.7.9')
            lib.healthy('0.7.9', public=True)
            require(lib.container('postgres')['Id'] == postgres_id, 'POSTGRES_CHANGED')
            lib.ledger(postgres_id, expected)
            record = ('DEPLOY_OK\ntag=' + TAG + '\nsource_tag=v0.7.8\nsource_revision=' + SOURCE_REVISION
                      + '\nrevision=' + revision + '\nmigration_count=140\nbackup=waived_by_user\nci_acceptance=waived_by_user_pre_1_0\nhealth='
                      + json.dumps(health, separators=(',', ':')) + '\ncompleted_at='
                      + time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()) + '\n')
            lib.atomic_write(lib.RESULT, record.encode(), 0o600)
            print('V079_DEPLOY_OK tag=' + TAG + ' revision=' + revision + ' migration_count=140', flush=True)
        except BaseException:
            if cutting_over:
                lib.quiesce_after_failure(postgres_id)
                print('V079_CUTOVER_FAILED writers_stopped=true', file=sys.stderr)
            else:
                lib.restart_source(old_writers)
            raise
    finally:
        os.close(fd)


if __name__ == '__main__':
    try:
        main(sys.argv[1:])
    except BaseException as error:
        code = str(error) if isinstance(error, RuntimeError) and re.fullmatch(r'V07[49]_[A-Z0-9_]+', str(error)) else 'V079_UNEXPECTED_FAILURE'
        print(code, file=sys.stderr)
        sys.exit(1)
