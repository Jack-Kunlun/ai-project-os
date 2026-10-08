#!/usr/bin/python3
"""Human-operated v0.7.18 -> v0.8.0-dev.1 migration with a verified stopped-writer backup."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
import time
import fcntl

ROOT = Path('/srv/ai-project-os/repository')
SOURCE_REVISION = 'c8e341f39fbb77b44bc8a8f2a8483c3bd5ac2bd5'
HELPER_HASH = '01c1f299098da8e4e9316e92d57e42bcf95e89eeee8424e4fe51395d6cc2d95e'
TAG = 'v0.8.0-dev.1'
CONFIRMATION = 'CONFIRM_V080_DEV1_WITH_BACKUP_AND_FULL_CI'
WRITERS = ('app', 'worker', 'git-worker')
MIGRATION = '20261008010000_add_account_security'
BUILD_SERVICES = ('migrate', 'reconcile', *WRITERS)
BACKUP_TOOL = Path('/usr/local/sbin/ai-project-os-backup')
BACKUP_ROOT = Path('/var/backups/ai-project-os')
BACKUP_STATUS = Path('/var/lib/ai-project-os-operations/backups/current.json')
BACKUP_ENV = {'PATH': '/usr/sbin:/usr/bin', 'HOME': '/root', 'LANG': 'C.UTF-8'}


def require(condition, code):
    if not condition:
        raise RuntimeError('V080_DEV1_' + code)


def trusted(path, mode=None, *, directory=False):
    path = Path(path)
    for part in [*reversed(path.parents), path]:
        info = os.lstat(part)
        require(info.st_uid == info.st_gid == 0 and not info.st_mode & 0o022,
                'HOST_PATH_UNTRUSTED')
        require(not stat.S_ISLNK(info.st_mode), 'HOST_SYMLINK_REJECTED')
    if mode is not None:
        matches_type = stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)
        require(matches_type and stat.S_IMODE(info.st_mode) == mode, 'HOST_PATH_TYPE_OR_MODE_INVALID')


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
    require(fields.get('tag') == 'v0.7.18' and fields.get('revision') == SOURCE_REVISION,
            'SOURCE_RECORD_INVALID')
    lib.healthy('0.7.18'); lib.healthy('0.7.18', public=True)
    postgres = lib.container('postgres')
    require(postgres['State'].get('Health', {}).get('Status') == 'healthy'
            and postgres['Config']['Image'] == lib.IMAGE, 'POSTGRES_INVALID')
    bindings = postgres['NetworkSettings']['Ports'].get('5432/tcp')
    require(isinstance(bindings, list) and len(bindings) == 1 and bindings[0]['HostIp'] == '127.0.0.1',
            'DATABASE_NOT_ISOLATED')
    writers = [lib.container(service) for service in WRITERS]
    require(all(w['State'].get('Health', {}).get('Status') == 'healthy'
                and w['State']['Running'] and not w['State']['Paused']
                and w['Config']['Labels'].get('org.opencontainers.image.version') == '0.7.18'
                for w in writers), 'SOURCE_WRITER_INVALID')
    app = next(w for w, service in zip(writers, WRITERS) if service == 'app')
    app_env = dict(item.split('=', 1) for item in app['Config']['Env'] if '=' in item)
    require(app_env.get('AI_PROJECT_OS_WEB_BROWSER_ENABLED') != '1', 'BROWSER_SOURCE_ENABLED')
    return postgres['Id'], writers


MCP_SETTINGS = {
    'AI_PROJECT_OS_MCP_ACTIONS_ENABLED': 'true',
    'AI_PROJECT_OS_MCP_EXPORT_ENABLED': 'true',
    'AI_PROJECT_OS_MCP_EXPORT_OAUTH_ENABLED': 'true',
    'AI_PROJECT_OS_MCP_EXPORT_PUBLIC_ORIGIN': 'https://ai-project-os.com',
}


def validate_mcp_environment(original):
    text = original.decode('utf-8')
    values = {}
    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        key, separator, value = line.partition('=')
        require(separator == '=' and re.fullmatch(r'[A-Z][A-Z0-9_]*', key)
                and key not in values, 'ENV_SYNTAX_INVALID')
        values[key] = value
    require(values.get('AI_PROJECT_OS_PUBLIC_ORIGIN') == 'https://ai-project-os.com'
            and values.get('AI_PROJECT_OS_SECURE_COOKIES') == 'true', 'PUBLIC_ORIGIN_INVALID')
    require(all(values.get(key) == value for key, value in MCP_SETTINGS.items()), 'MCP_SOURCE_CONFIG_INVALID')
    require(values.get('AI_PROJECT_OS_WEB_BROWSER_ENABLED') != '1', 'BROWSER_SOURCE_ENABLED')


def assert_config_unchanged(lib, env_hash, override_hash):
    lib.trusted(lib.ENV, 0o600)
    lib.trusted(lib.OVERRIDE)
    require(hashlib.sha256(lib.ENV.read_bytes()).digest() == env_hash
            and hashlib.sha256(lib.OVERRIDE.read_bytes()).digest() == override_hash, 'CONFIG_CHANGED')


def target_mcp_ready(lib):
    env = dict(item.split('=', 1) for item in lib.container('app')['Config']['Env'] if '=' in item)
    require(all(env.get(key) == value for key, value in MCP_SETTINGS.items()), 'MCP_RUNTIME_CONFIG_INVALID')
    require(env.get('AI_PROJECT_OS_WEB_BROWSER_ENABLED') != '1', 'BROWSER_RUNTIME_ENABLED')
    metadata = lib.request_json('https://ai-project-os.com/.well-known/oauth-protected-resource/api/mcp')
    require(metadata.get('resource') == 'https://ai-project-os.com/api/mcp'
            and metadata.get('authorization_servers') == ['https://ai-project-os.com']
            and 'project:read' in metadata.get('scopes_supported', []), 'MCP_METADATA_INVALID')


def target_manifest():
    directories = sorted(p for p in (ROOT / 'prisma/migrations').iterdir() if p.is_dir())
    require(len(directories) == 142
            and directories[139].name == '20261006014000_add_sms_provider_adapters'
            and directories[140].name == '20261007010000_persist_verified_git_addresses'
            and directories[-1].name == MIGRATION, 'TARGET_MANIFEST_INVALID')
    require(all(re.fullmatch(r'\d{14}_[a-z0-9_]+', p.name) for p in directories), 'MIGRATION_NAME_INVALID')
    return [(p.name, hashlib.sha256((p / 'migration.sql').read_bytes()).hexdigest()) for p in directories]


def parse_backup_output(output):
    matches = re.findall(r'^BACKUP_OK ([^\n]+)$', output, re.MULTILINE)
    require(len(matches) == 1, 'BACKUP_RESULT_INVALID')
    fields = {}
    for item in matches[0].split():
        key, separator, value = item.partition('=')
        require(separator == '=' and re.fullmatch(r'[a-z0-9_]+', key) and key not in fields,
                'BACKUP_RESULT_INVALID')
        fields[key] = value
    required = {'reason', 'source', 'object', 'manifest', 'verified_manifest', 'sha256',
                'retention_removed', 'source_quiesced'}
    require(fields.keys() == required, 'BACKUP_RESULT_INVALID')
    require(fields['reason'] == 'pre-deploy-to-' + TAG and fields['source_quiesced'] == 'true'
            and fields['retention_removed'] == '0' and re.fullmatch(r'[0-9a-f]{64}', fields['sha256']),
            'BACKUP_RESULT_INVALID')
    name_match = re.fullmatch(r'([0-9]{8}T[0-9]{6}Z)-pre-deploy-to-v0\.8\.0-dev\.1\.([A-Za-z0-9]{6})',
                              Path(fields['source']).name)
    require(name_match is not None and fields['source'] == str(BACKUP_ROOT / Path(fields['source']).name),
            'BACKUP_SOURCE_INVALID')
    name = Path(fields['source']).name
    uri_match = re.fullmatch(
        r'(?P<bucket>cos://ai-project-os-backup-[0-9]+)/(?P<prefix>[A-Za-z0-9][A-Za-z0-9._-]*(?:/[A-Za-z0-9][A-Za-z0-9._-]*)*)'
        r'/backups/(?P<date>[0-9]{4}/[0-9]{2}/[0-9]{2})/(?P<name>[0-9]{8}T[0-9]{6}Z-pre-deploy-to-v0\.8\.0-dev\.1\.[A-Za-z0-9]{6})'
        r'/(?P<archive>[^/]+)$', fields['object'])
    require(uri_match is not None and uri_match.group('name') == name
            and uri_match.group('archive') == name + '.tar.age'
            and uri_match.group('date') == name[:4] + '/' + name[4:6] + '/' + name[6:8],
            'BACKUP_OBJECT_INVALID')
    base = uri_match.group('bucket') + '/' + uri_match.group('prefix')
    suffix = '/backups/' + uri_match.group('date') + '/' + name
    require(fields['manifest'] == base + '/manifests/latest.json'
            and fields['verified_manifest'] == base + suffix + '/' + name + '.manifest.json',
            'BACKUP_MANIFEST_INVALID')
    return {**fields, 'backup_name': name, 'object_base': base, 'object_suffix': suffix}


def parse_key_value(path):
    values = {}
    for line in Path(path).read_text().splitlines():
        key, separator, value = line.partition('=')
        require(separator == '=' and re.fullmatch(r'[a-z0-9_]+', key) and key not in values,
                'BACKUP_METADATA_INVALID')
        values[key] = value
    return values


def verify_backup_artifacts(receipt):
    backup_path = BACKUP_ROOT / receipt['backup_name']
    trusted(backup_path, 0o700, directory=True)
    metadata_path = backup_path / 'backup-metadata.env'
    marker_path = backup_path / '.cos-upload-verified'
    trusted(metadata_path, 0o600)
    trusted(marker_path, 0o600)
    metadata = parse_key_value(metadata_path)
    marker = parse_key_value(marker_path)
    require(metadata.get('backup_name') == receipt['backup_name']
            and metadata.get('reason') == 'pre-deploy-to-' + TAG
            and metadata.get('writers_quiesced') == 'true'
            and metadata.get('source_quiesced') == 'true', 'BACKUP_METADATA_INVALID')
    require(marker.get('status') == 'COS_UPLOAD_VERIFIED'
            and marker.get('archive_object') == receipt['object']
            and marker.get('archive_sha256') == receipt['sha256']
            and marker.get('manifest_object') == receipt['verified_manifest']
            and marker.get('latest_manifest_object') == receipt['manifest']
            and marker.get('checksum_object') == receipt['object'] + '.sha256', 'BACKUP_MARKER_INVALID')
    trusted(BACKUP_STATUS, 0o644)
    status = json.loads(BACKUP_STATUS.read_text())
    require(status.get('state') == 'succeeded' and status.get('trigger') == 'pre-deploy'
            and status.get('targetTag') == TAG and status.get('backupName') == receipt['backup_name']
            and status.get('archiveObject') == receipt['object']
            and status.get('archiveSha256') == receipt['sha256']
            and status.get('retentionRemoved') == 0 and status.get('errorCode') is None,
            'BACKUP_STATUS_INVALID')
    return receipt


def validate_backup_receipt(output):
    receipt = parse_backup_output(output)
    return verify_backup_artifacts(receipt)


def run_predeploy_backup(writers):
    candidate = ROOT / 'deploy/production/ai-project-os-backup'
    trusted(BACKUP_TOOL, 0o755)
    require(hashlib.sha256(BACKUP_TOOL.read_bytes()).digest()
            == hashlib.sha256(candidate.read_bytes()).digest(), 'BACKUP_TOOL_MISMATCH')
    environment = dict(BACKUP_ENV)
    environment.update({
        'AI_PROJECT_OS_DEPLOY_LOCK_HELD': '1',
        'AI_PROJECT_OS_CUTOVER': '1',
        'AI_PROJECT_OS_CUTOVER_LOCK_HELD': '1',
        'AI_PROJECT_OS_EXPECTED_APP_ID': writers[0]['Id'],
        'AI_PROJECT_OS_EXPECTED_WORKER_ID': writers[1]['Id'],
        'AI_PROJECT_OS_EXPECTED_GIT_WORKER_ID': writers[2]['Id'],
    })
    result = subprocess.run([str(BACKUP_TOOL), 'pre-deploy', TAG], env=environment, text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=7200, check=False)
    require(result.returncode == 0, 'BACKUP_FAILED')
    return result.stdout


def assert_captured_writers_stopped(lib, writers):
    for writer in writers:
        current = json.loads(lib.docker('inspect', writer['Id']))[0]
        require(current['Id'] == writer['Id'] and not current['State']['Running'], 'WRITER_NOT_STOPPED')


def interrupted(_signum, _frame):
    raise RuntimeError('V080_DEV1_INTERRUPTED')


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
            and stat.S_IMODE(directory.st_mode) == 0o1777, 'LOCK_DIRECTORY_INVALID')
    fd = os.open('/run/lock/ai-project-os-deploy.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == info.st_gid == 0
                and stat.S_IMODE(info.st_mode) == 0o600, 'LOCK_INVALID')
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        for path in (ROOT, ROOT / '.git', lib.OVERRIDE):
            lib.trusted(path)
        lib.trusted(lib.ENV, 0o600)
        require(lib.run(['git', '-C', str(ROOT), 'remote', 'get-url', 'origin']) == lib.REMOTE,
                'REMOTE_INVALID')
        require(not lib.run(['git', '-C', str(ROOT), 'status', '--porcelain']), 'CHECKOUT_DIRTY')
        postgres_id, old_writers = source_state(lib)
        original_env = lib.ENV.read_bytes()
        validate_mcp_environment(original_env)
        env_hash = hashlib.sha256(original_env).digest()
        override_hash = hashlib.sha256(lib.OVERRIDE.read_bytes()).digest()
        lib.run(['git', '-C', str(ROOT), 'fetch', '--no-tags', 'origin', 'refs/tags/' + TAG + ':refs/tags/' + TAG])
        require(lib.run(['git', '-C', str(ROOT), 'cat-file', '-t', 'refs/tags/' + TAG]) == 'tag',
                'ANNOTATED_TAG_REQUIRED')
        require(lib.run(['git', '-C', str(ROOT), 'rev-parse', 'refs/tags/' + TAG + '^{}']) == revision,
                'TAG_SHA_MISMATCH')
        try:
            lib.run(['git', '-C', str(ROOT), 'merge-base', '--is-ancestor', SOURCE_REVISION, revision])
        except RuntimeError:
            require(False, 'TARGET_NOT_DESCENDANT')
        require(not lib.run(['git', '-C', str(ROOT), 'rev-list', '--merges', SOURCE_REVISION + '..' + revision]),
                'TARGET_MERGE_COMMIT')
        migration_changes = lib.run(['git', '-C', str(ROOT), 'diff', '--name-only', SOURCE_REVISION, revision,
                                     '--', 'prisma/migrations']).splitlines()
        require(migration_changes == ['prisma/migrations/' + MIGRATION + '/migration.sql'],
                'MIGRATION_SCOPE_INVALID')
        lib.run(['git', '-C', str(ROOT), 'diff', '--exit-code', SOURCE_REVISION, revision, '--',
                 'compose.yaml', 'deploy/production/nginx', 'scripts/reconcile-database-principals.ts'])
        lib.TAG = TAG
        lib.require_ci(revision)
        lib.run(['git', '-C', str(ROOT), 'checkout', '--detach', revision])
        require(json.loads((ROOT / 'package.json').read_text())['version'] == '0.8.0-dev.1',
                'VERSION_INVALID')
        require(Path(__file__).read_bytes() == (ROOT / 'deploy/production/ai-project-os-v080-dev1-deploy.py').read_bytes(),
                'TOOL_MISMATCH')
        require('org.opencontainers.image.version="0.8.0-dev.1"' in (ROOT / 'Dockerfile').read_text(),
                'IMAGE_VERSION_INVALID')
        expected = target_manifest()
        lib.ledger(postgres_id, expected[:141])
        print('V080_DEV1_SOURCE_READY migration_count=141 target_migration_count=142 ci=full_main_and_tag_ci', flush=True)
        lib.compose('config', '--quiet')
        lib.compose('build', *BUILD_SERVICES, capture=False, timeout=7200)
        new_pg, new_writers = source_state(lib)
        require(new_pg == postgres_id and [(w['Id'], w['Image']) for w in new_writers]
                == [(w['Id'], w['Image']) for w in old_writers], 'SOURCE_CHANGED_DURING_BUILD')
        assert_config_unchanged(lib, env_hash, override_hash)
        lib.ledger(postgres_id, expected[:141])
        backup_tool_candidate = ROOT / 'deploy/production/ai-project-os-backup'
        trusted(BACKUP_TOOL, 0o755)
        require(hashlib.sha256(BACKUP_TOOL.read_bytes()).digest()
                == hashlib.sha256(backup_tool_candidate.read_bytes()).digest(), 'BACKUP_TOOL_MISMATCH')
        backup_receipt = None
        cutting_over = False
        try:
            lib.docker('stop', *[w['Id'] for w in old_writers])
            lib.stopped(postgres_id)
            assert_captured_writers_stopped(lib, old_writers)
            assert_config_unchanged(lib, env_hash, override_hash)
            backup_receipt = validate_backup_receipt(run_predeploy_backup(old_writers))
            lib.stopped(postgres_id)
            assert_captured_writers_stopped(lib, old_writers)
            assert_config_unchanged(lib, env_hash, override_hash)
            lib.ledger(postgres_id, expected[:141])
            print('V080_DEV1_BACKUP_OK name=' + backup_receipt['backup_name']
                  + ' object=' + backup_receipt['object']
                  + ' verified_manifest=' + backup_receipt['verified_manifest']
                  + ' retention_removed=0', flush=True)
            lib.compose('config', '--quiet')
            assert_config_unchanged(lib, env_hash, override_hash)
            lib.stopped(postgres_id)
            assert_captured_writers_stopped(lib, old_writers)
            # Once migration is attempted, never restart source writers.
            cutting_over = True
            lib.compose('up', '-d', '--no-deps', '--no-build', '--force-recreate', 'migrate')
            lib.wait_service('migrate')
            lib.stopped(postgres_id)
            lib.compose('up', '-d', '--no-deps', '--no-build', '--force-recreate', 'reconcile')
            lib.wait_service('reconcile')
            lib.stopped(postgres_id)
            lib.ledger(postgres_id, expected)
            print('V080_DEV1_MIGRATION_OK migration_count=142', flush=True)
            lib.compose('config', '--quiet')
            assert_config_unchanged(lib, env_hash, override_hash)
            lib.compose('up', '-d', '--no-deps', '--no-build', '--force-recreate', *WRITERS)
            for _ in range(120):
                if all(lib.container(s)['State'].get('Health', {}).get('Status') == 'healthy' for s in WRITERS):
                    break
                time.sleep(2)
            else:
                raise RuntimeError('V080_DEV1_HEALTH_TIMEOUT')
            require(all(lib.container(s)['Config']['Labels'].get('org.opencontainers.image.version') == '0.8.0-dev.1'
                        for s in WRITERS), 'TARGET_IMAGE_VERSION_INVALID')
            health = lib.healthy('0.8.0-dev.1')
            lib.healthy('0.8.0-dev.1', public=True)
            target_mcp_ready(lib)
            assert_config_unchanged(lib, env_hash, override_hash)
            require(lib.container('postgres')['Id'] == postgres_id, 'POSTGRES_CHANGED')
            lib.ledger(postgres_id, expected)
            record = ('DEPLOY_OK\ntag=' + TAG + '\nsource_tag=v0.7.18\nsource_revision=' + SOURCE_REVISION
                      + '\nrevision=' + revision + '\nmigration_count=142\nci_acceptance=full_main_and_tag_ci'
                      + '\nbackup_name=' + backup_receipt['backup_name']
                      + '\nbackup_source=' + backup_receipt['source']
                      + '\nbackup_object=' + backup_receipt['object']
                      + '\nbackup_manifest=' + backup_receipt['manifest']
                      + '\nbackup_verified_manifest=' + backup_receipt['verified_manifest']
                      + '\nbackup_sha256=' + backup_receipt['sha256']
                      + '\nbackup_retention_removed=0\nhealth='
                      + json.dumps(health, separators=(',', ':')) + '\ncompleted_at='
                      + time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()) + '\n')
            lib.atomic_write(lib.RESULT, record.encode(), 0o600)
            print('V080_DEV1_DEPLOY_OK tag=' + TAG + ' revision=' + revision
                  + ' migration_count=142 backup_name=' + backup_receipt['backup_name'], flush=True)
        except BaseException:
            if cutting_over:
                writers_quiesced = 'unknown'
                try:
                    lib.quiesce_after_failure(postgres_id)
                    writers_quiesced = 'true'
                    assert_config_unchanged(lib, env_hash, override_hash)
                finally:
                    print('V080_DEV1_CUTOVER_FAILED writers_quiesce_attempted=true writers_quiesced='
                          + writers_quiesced + ' backup_name='
                          + (backup_receipt['backup_name'] if backup_receipt else 'unavailable')
                          + ' backup_object=' + (backup_receipt['object'] if backup_receipt else 'unavailable')
                          + ' backup_manifest=' + (backup_receipt['verified_manifest'] if backup_receipt else 'unavailable'),
                          file=sys.stderr)
            else:
                lib.restart_source(old_writers)
                assert_config_unchanged(lib, env_hash, override_hash)
                print('V080_DEV1_PRE_MIGRATION_FAILED_SOURCE_RESTARTED', file=sys.stderr)
            raise
    finally:
        os.close(fd)


if __name__ == '__main__':
    try:
        main(sys.argv[1:])
    except BaseException as error:
        code = str(error) if isinstance(error, RuntimeError) and re.fullmatch(r'V080_DEV1_[A-Z0-9_]+', str(error)) else 'V080_DEV1_UNEXPECTED_FAILURE'
        print(code, file=sys.stderr)
        sys.exit(1)
