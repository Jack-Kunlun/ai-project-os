#!/usr/bin/python3
"""Root-only, single-transition v1.0.0 -> v1.0.1 release and recovery gate."""
from __future__ import annotations

import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import signal
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request

ROOT = Path('/srv/ai-project-os/repository')
ENV = Path('/etc/ai-project-os/production.env')
OVERRIDE = Path('/etc/ai-project-os/compose.operations.yaml')
EMAIL_ENV = Path('/etc/ai-project-os/email-auth.env')
RESULT = Path('/var/lib/ai-project-os/last-deployment')
STATE = Path('/etc/ai-project-os/release-tooling-v101.json')
NGINX = Path('/etc/nginx/sites-available/ai-project-os.conf')
NGINX_ENABLED = Path('/etc/nginx/sites-enabled/ai-project-os.conf')
NGINX_SNIPPET = Path('/etc/nginx/snippets/ai-project-os-proxy.conf')
BACKUP = Path('/usr/local/sbin/ai-project-os-backup')
ARTIFACT_HELPER = Path('/usr/local/libexec/ai-project-os/backup-artifact.py')
DEPLOYER = Path('/usr/local/sbin/ai-project-os-v101-deploy')
GATEWAY = Path('/usr/local/sbin/ai-project-os-actions-gateway')
SUDOERS = Path('/etc/sudoers.d/ai-project-os-deploy')
BACKUP_SOURCE = 'deploy/production/ai-project-os-backup'
ARTIFACT_SOURCE = 'deploy/production/ai_project_os_backup_artifact.py'
DEPLOYER_SOURCE = 'deploy/production/ai-project-os-v101-deploy.py'
GATEWAY_SOURCE = 'deploy/production/ai-project-os-actions-gateway'
SUDOERS_SOURCE = 'deploy/production/ai-project-os-deploy.sudoers'
HELPER_SOURCE = 'deploy/production/ai-project-os-v074-deploy.py'
SOURCE_TAG = 'v1.0.0'
SOURCE_REVISION = 'f57d050fffa445a6ef9eb3d7e692e6df06fac98d'
TARGET_TAG = 'v1.0.1'
TARGET_VERSION = '1.0.1'
TARGET_MIGRATIONS = (
    '20261015010000_add_local_registration_entitlement_source',
    '20261015020000_bind_personal_semantic_token_reservations',
)
EXPECTED_MIGRATIONS = 145
SOURCE_MIGRATIONS = 143
HELPER_SHA256 = '01c1f299098da8e4e9316e92d57e42bcf95e89eeee8424e4fe51395d6cc2d95e'
IMAGE = 'pgvector/pgvector:0.8.6-pg18-trixie@sha256:78bf48b801e792f99e3ac62b5036fd3876e9be48afda16c1e331af1c75ceb2ff'
PROJECT = 'ai-project-os'
REMOTE = 'https://github.com/Jack-Kunlun/ai-project-os.git'
BACKUP_BINARY = '/usr/local/sbin/ai-project-os-backup'
ARTIFACT_BINARY = '/usr/local/libexec/ai-project-os/backup-artifact.py'
BINARIES = {
    'docker': '/usr/bin/docker', 'git': '/usr/bin/git', 'nginx': '/usr/sbin/nginx',
    'systemctl': '/usr/bin/systemctl', 'python3': '/usr/bin/python3',
}
PROCESS_ENV = {'PATH': '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
               'HOME': '/root', 'LANG': 'C.UTF-8'}
CONFIG_PATHS = {
    'production_env': ENV,
    'compose_operations': OVERRIDE,
    'email_auth': EMAIL_ENV,
    'nginx': NGINX,
    'nginx_proxy_snippet': NGINX_SNIPPET,
}
BACKUP_REQUIRED_FILES = {
    'postgres.dump', 'secrets.tar.gz', 'uploads.tar.gz', 'host-config.tar.gz',
    'backup-metadata.env', 'SHA256SUMS', '.cos-upload-verified',
}
BACKUP_NAME = re.compile(r'^[0-9]{8}T[0-9]{6}Z-pre-deploy-to-v1\.0\.1\.[A-Za-z0-9]{6}$')
HEX64 = re.compile(r'^[a-f0-9]{64}$')
HEX40 = re.compile(r'^[a-f0-9]{40}$')
HELPER = None


def require(condition: bool, code: str) -> None:
    if not condition:
        raise RuntimeError('V101_' + code)


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def hash_file(path, chunk_size=1024 * 1024) -> str:
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(chunk_size), b''):
            digest.update(chunk)
    return digest.hexdigest()


def validate_default_signup_policy(snapshot) -> None:
    offers = snapshot.get('activeOffers') if isinstance(snapshot, dict) else None
    require(isinstance(offers, list) and len(offers) == 1, 'ACTIVE_SIGNUP_POLICY_INVALID')
    offer = offers[0]
    require(isinstance(offer, dict) and offer.get('amount') == 500000
            and offer.get('validForDays') == 30
            and offer.get('eligibilityKey') == 'verified_identity_v1',
            'ACTIVE_SIGNUP_POLICY_INVALID')


def policy_snapshot(snapshot):
    require(isinstance(snapshot, dict)
            and isinstance(snapshot.get('activeOffers'), list)
            and isinstance(snapshot.get('activeEmbeddingRoutes'), list),
            'DATABASE_POLICY_SNAPSHOT_INVALID')
    return {'activeOffers': snapshot['activeOffers'],
            'activeEmbeddingRoutes': snapshot['activeEmbeddingRoutes']}


def validate_transition(source_tag: str, source_revision: str, target_tag: str, target_revision: str) -> None:
    require(source_tag == SOURCE_TAG and source_revision == SOURCE_REVISION, 'SOURCE_TRANSITION_INVALID')
    require(target_tag == TARGET_TAG and HEX40.fullmatch(target_revision) is not None,
            'TARGET_TRANSITION_INVALID')
    require(target_revision != source_revision, 'TARGET_TRANSITION_INVALID')


def validate_manifest_delta(source: list[tuple[str, str]], target: list[tuple[str, str]]) -> None:
    require(len(source) == SOURCE_MIGRATIONS and len(target) == EXPECTED_MIGRATIONS,
            'MIGRATION_COUNT_INVALID')
    require(target[:SOURCE_MIGRATIONS] == source, 'MIGRATION_BASELINE_CHANGED')
    require(tuple(name for name, _ in target[-2:]) == TARGET_MIGRATIONS, 'MIGRATION_DELTA_INVALID')
    require(len({name for name, _ in target}) == EXPECTED_MIGRATIONS
            and all(HEX64.fullmatch(digest) for _, digest in target), 'MIGRATION_MANIFEST_INVALID')


def deployment_flow(ops) -> None:
    """Explicitly encode the one allowed rollback boundary for deterministic tests."""
    source = ops.preflight()
    migration_started = False
    try:
        ops.checkout_target()
        images = ops.build_target_images()
        ops.revalidate_source(source)
        ops.stop_nginx()
        ops.stop_source_writers(source)
        backup = ops.create_and_validate_backup(source)
        ops.restore_drill(source, backup, images)
        ops.install_and_test_target_nginx()
        migration_started = True  # Set before the first migration process can run.
        ops.migrate(images)
        ops.reconcile(images)
        ops.start_target_writers(images)
        ops.verify_target(source, backup, images)
        ops.cleanup_restore_drill()
        ops.cleanup_pin_file()
        ops.write_receipt(source, backup, images)
    except BaseException:
        if migration_started:
            ops.quiesce_for_manual_recovery(source)
        else:
            ops.restore_exact_source(source)
        raise
    finally:
        try:
            ops.cleanup_restore_drill()
        finally:
            ops.cleanup_pin_file()


def trusted(path, mode=None):
    path = Path(path)
    for part in [*reversed(path.parents), path]:
        info = part.lstat()
        require(info.st_uid == 0 and info.st_gid == 0 and not info.st_mode & 0o022,
                'HOST_PATH_UNTRUSTED')
        require(not stat.S_ISLNK(info.st_mode), 'HOST_SYMLINK_REJECTED')
    if mode is not None:
        info = path.stat()
        require(stat.S_ISREG(info.st_mode) and stat.S_IMODE(info.st_mode) == mode,
                'HOST_FILE_MODE_INVALID')


def load_helper():
    global HELPER
    path = ROOT / HELPER_SOURCE
    trusted(path, 0o644)
    content = path.read_bytes()
    require(sha256(content) == HELPER_SHA256, 'PINNED_HELPER_HASH_INVALID')
    spec = importlib.util.spec_from_file_location('ai_project_os_v074_pinned_helper', path)
    require(spec is not None and spec.loader is not None, 'PINNED_HELPER_LOAD_FAILED')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    HELPER = module
    return module


def run(args, capture=True, timeout=600):
    executable = BINARIES.get(args[0])
    require(executable is not None, 'COMMAND_NOT_ALLOWLISTED')
    HELPER.trusted(executable)
    require(stat.S_ISREG(Path(executable).stat().st_mode) and os.access(executable, os.X_OK),
            'EXECUTABLE_INVALID')
    result = subprocess.run([executable, *args[1:],], env=PROCESS_ENV, text=True,
                            stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
                            stderr=subprocess.PIPE, timeout=timeout, check=False)
    require(result.returncode == 0, 'COMMAND_FAILED_' + Path(args[0]).name.upper().replace('-', '_'))
    return result.stdout.strip() if capture else ''


def docker(*args, capture=True, timeout=600):
    return run(['docker', *args], capture=capture, timeout=timeout)


def compose(*args, pin_file=None, capture=True, timeout=600):
    command = ['docker', 'compose', '--project-name', PROJECT, '--env-file', str(ENV),
               '--project-directory', str(ROOT), '--file', str(ROOT / 'compose.yaml'),
               '--file', str(OVERRIDE)]
    if pin_file is not None:
        command.extend(['--file', str(pin_file)])
    command.extend(args)
    return run(command, capture=capture, timeout=timeout)


def request_json(url):
    request = urllib.request.Request(url, headers={'Accept': 'application/vnd.github+json',
                                                   'X-GitHub-Api-Version': '2022-11-28'})
    with urllib.request.urlopen(request, timeout=30) as response:
        require(response.status == 200, 'HTTP_STATUS_INVALID')
        body = response.read(4 * 1024 * 1024 + 1)
        require(len(body) <= 4 * 1024 * 1024, 'HTTP_RESPONSE_TOO_LARGE')
        return json.loads(body)


def healthy(version, public=False):
    url = ('https://ai-project-os.com' if public else 'http://127.0.0.1:3000') + '/api/health'
    request = urllib.request.Request(url, headers={'Accept': 'application/json'})
    with urllib.request.urlopen(request, timeout=30) as response:
        require(response.status == 200, 'HTTP_STATUS_INVALID')
        payload = json.loads(response.read(4 * 1024 * 1024 + 1))
    require(payload.get('status') == 'ok' and payload.get('version') == version
            and payload.get('database') == 'up'
            and payload.get('worker', {}).get('status') == 'up'
            and payload['worker'].get('consecutiveFailures') == 0, 'HEALTH_INVALID')
    return payload


def require_ci(revision):
    api = 'https://api.github.com/repos/Jack-Kunlun/ai-project-os/actions'
    runs = request_json(api + '/workflows/ci.yml/runs?event=push&status=success&head_sha='
                        + revision + '&per_page=100')
    for branch in ('main', TARGET_TAG):
        candidates = [item for item in runs.get('workflow_runs', [])
                     if item.get('head_sha') == revision and item.get('head_branch') == branch
                     and item.get('event') == 'push' and item.get('status') == 'completed'
                     and item.get('conclusion') == 'success']
        require(bool(candidates), 'EXACT_MAIN_AND_TAG_CI_REQUIRED')
        accepted = False
        for candidate in candidates:
            jobs = request_json(api + '/runs/' + str(int(candidate['id'])) + '/jobs?per_page=100')
            if any(job.get('name') == 'Verify database and release candidate'
                   and job.get('conclusion') == 'success' for job in jobs.get('jobs', [])):
                accepted = True
                break
        require(accepted, 'FULL_DATABASE_CI_REQUIRED')


def git(args, capture=True, timeout=600):
    return run(['git', '-C', str(ROOT), *args], capture=capture, timeout=timeout)


def git_raw(args, timeout=600):
    executable = BINARIES['git']
    HELPER.trusted(executable)
    result = subprocess.run([executable, '-C', str(ROOT), *args], env=PROCESS_ENV,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout,
                            check=False)
    require(result.returncode == 0, 'COMMAND_FAILED_GIT')
    return result.stdout


def fetch_target(target_revision):
    trusted(ROOT); trusted(ROOT / '.git')
    require(git(['remote', 'get-url', 'origin']) == REMOTE, 'REMOTE_INVALID')
    require(git(['status', '--porcelain', '--untracked-files=all']) == '', 'MANAGED_CHECKOUT_DIRTY')
    git(['fetch', '--no-tags', 'origin',
         '+refs/heads/main:refs/remotes/origin/main',
         '+refs/tags/' + TARGET_TAG + ':refs/tags/' + TARGET_TAG])
    require(git(['cat-file', '-t', 'refs/tags/' + TARGET_TAG]) == 'tag', 'TAG_NOT_ANNOTATED')
    require(git(['rev-parse', 'refs/tags/' + TARGET_TAG + '^{}']) == target_revision,
            'TAG_REVISION_MISMATCH')
    require(git(['rev-parse', 'refs/remotes/origin/main']) == target_revision,
            'ORIGIN_MAIN_REVISION_MISMATCH')


def source_manifest(root=ROOT):
    base = root / 'prisma/migrations'
    require(base.is_dir() and not base.is_symlink(), 'MIGRATION_DIRECTORY_INVALID')
    directories = sorted(path for path in base.iterdir() if path.is_dir() and not path.is_symlink())
    require(all(re.fullmatch(r'\d{14}_[a-z0-9_]+', path.name) for path in directories),
            'MIGRATION_NAME_INVALID')
    result = []
    for directory in directories:
        migration = directory / 'migration.sql'
        require(migration.is_file() and not migration.is_symlink(), 'MIGRATION_SQL_MISSING')
        result.append((directory.name, sha256(migration.read_bytes())))
    return result


def git_manifest(revision):
    raw = git(['ls-tree', '--name-only', revision + ':prisma/migrations'])
    names = raw.splitlines()
    require(all(re.fullmatch(r'\d{14}_[a-z0-9_]+', name) for name in names),
            'MIGRATION_NAME_INVALID')
    entries = []
    for name in names:
        path = 'prisma/migrations/' + name + '/migration.sql'
        content = git_raw(['show', revision + ':' + path])
        entries.append((name, sha256(content)))
    return entries


def git_blob(revision, path):
    return git_raw(['show', revision + ':' + path])


def validate_target_tree(revision, source):
    package = json.loads(git_blob(revision, 'package.json'))
    version_source = git_blob(revision, 'src/lib/version.ts').decode('utf-8')
    dockerfile = git_blob(revision, 'Dockerfile').decode('utf-8')
    release_notes = git_blob(revision, 'docs/releases/v1.0.1.md').decode('utf-8')
    require(package.get('version') == TARGET_VERSION, 'PACKAGE_VERSION_INVALID')
    require(re.search(r'APP_VERSION\s*=\s*"1\.0\.1"', version_source) is not None,
            'APP_VERSION_INVALID')
    require(len(re.findall(r'org\.opencontainers\.image\.version="1\.0\.1"', dockerfile)) == 1,
            'OCI_VERSION_INVALID')
    require(release_notes.startswith('# v1.0.1 — 账号与个人知识修复'), 'RELEASE_NOTES_INVALID')
    target = git_manifest(revision)
    validate_manifest_delta(source, target)
    helper = git_blob(revision, HELPER_SOURCE)
    require(sha256(helper) == HELPER_SHA256, 'PINNED_HELPER_HASH_INVALID')
    deployer = git_blob(revision, DEPLOYER_SOURCE)
    compile(deployer, DEPLOYER_SOURCE, 'exec')
    backup = git_blob(revision, BACKUP_SOURCE)
    artifact = git_blob(revision, ARTIFACT_SOURCE)
    gateway = git_blob(revision, GATEWAY_SOURCE)
    sudoers = git_blob(revision, SUDOERS_SOURCE)
    validate_tooling_bytes(gateway, sudoers)
    require(b'v1.0.1' in backup and b'email-auth.env' in backup,
            'TARGET_BACKUP_CONTRACT_INVALID')
    compile(artifact, ARTIFACT_SOURCE, 'exec')
    nginx = git_blob(revision, 'deploy/production/nginx/ai-project-os.conf')
    require(nginx.startswith(b'#'), 'TARGET_NGINX_CONFIG_INVALID')
    return target, {'deployer': deployer, 'backup': backup, 'artifact_helper': artifact,
                    'gateway': gateway, 'sudoers': sudoers, 'nginx': nginx, 'helper': helper}


def validate_tooling_bytes(gateway, sudoers):
    bash = '/usr/bin/bash'
    visudo = '/usr/sbin/visudo'
    HELPER.trusted(bash)
    HELPER.trusted(visudo)
    result = subprocess.run([bash, '-n'], input=gateway, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=30, check=False)
    require(result.returncode == 0, 'BOOTSTRAP_GATEWAY_INVALID')
    directory = STATE.parent
    HELPER.trusted(directory)
    with tempfile.TemporaryDirectory(prefix='.v101-sudoers-validate-', dir=directory) as temporary:
        path = Path(temporary) / 'sudoers'
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(sudoers)
            stream.flush()
            os.fsync(stream.fileno())
        HELPER.trusted(path, 0o600)
        result = subprocess.run([visudo, '-cf', str(path)], env=PROCESS_ENV,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                timeout=30, check=False)
        require(result.returncode == 0, 'BOOTSTRAP_SUDOERS_INVALID')


def env_values():
    HELPER.trusted(ENV, 0o600)
    values = {}
    for line in ENV.read_text(encoding='utf-8').splitlines():
        if not line or line.lstrip().startswith('#'):
            continue
        require('=' in line, 'ENV_SYNTAX_INVALID')
        key, value = line.split('=', 1)
        require(re.fullmatch(r'[A-Z][A-Z0-9_]*', key) is not None and key not in values,
                'ENV_KEY_INVALID')
        values[key] = value
    required_users = {
        'POSTGRES_USER': 'ai_project_os_cluster_admin',
        'POSTGRES_RUNTIME_USER': 'ai_project_os_runtime',
        'POSTGRES_ENTITLEMENT_WRITER_USER': 'ai_project_os_entitlement_writer',
        'POSTGRES_GIT_AUTOMATION_WORKER_USER': 'ai_project_os_git_automation_worker',
    }
    for key, expected in required_users.items():
        require(values.get(key, expected) == expected, 'PRINCIPAL_ENV_INVALID')
    for key in ('POSTGRES_CLUSTER_ADMIN_PASSWORD', 'POSTGRES_MIGRATOR_PASSWORD',
                'POSTGRES_RUNTIME_PASSWORD', 'POSTGRES_ENTITLEMENT_WRITER_PASSWORD',
                'POSTGRES_GIT_AUTOMATION_WORKER_PASSWORD',
                'POSTGRES_ENTITLEMENT_INVENTORY_READER_PASSWORD'):
        require(HEX64.fullmatch(values.get(key, '')) is not None, 'PRINCIPAL_SECRET_INVALID')
    require(values.get('POSTGRES_DB', 'ai_project_os') == 'ai_project_os'
            and values.get('APP_PORT', '3000') == '3000', 'PORT_DATABASE_INVALID')
    require(values.get('AI_PROJECT_OS_PUBLIC_ORIGIN') == 'https://ai-project-os.com'
            and values.get('AI_PROJECT_OS_SECURE_COOKIES') == 'true', 'AUTH_ENV_INVALID')
    HELPER.trusted(EMAIL_ENV, 0o600)
    return values


def config_hashes():
    result = {}
    for name, path in CONFIG_PATHS.items():
        mode = 0o600 if path in (ENV, EMAIL_ENV) else (0o644 if path == NGINX or path == NGINX_SNIPPET else None)
        HELPER.trusted(path, mode)
        result[name] = sha256(path.read_bytes())
    return result


def container(service):
    return HELPER.container(service)


def db_query(postgres_id, sql):
    return HELPER.db_query(postgres_id, sql)


def migration_ledger(postgres_id, expected):
    query = '''SELECT coalesce(json_agg(row_to_json(m)), '[]'::json) FROM
      (SELECT migration_name, checksum, finished_at IS NOT NULL AS finished,
       rolled_back_at IS NOT NULL AS rolled_back, applied_steps_count FROM public._prisma_migrations
       ORDER BY migration_name) m'''
    rows = db_query(postgres_id, query)
    require(len(rows) == len(expected), 'MIGRATION_LEDGER_COUNT_INVALID')
    require(all((row['migration_name'], row['checksum']) == item and row['finished']
                and not row['rolled_back'] and row['applied_steps_count'] >= 1
                for row, item in zip(rows, expected)), 'MIGRATION_LEDGER_INVALID')


def readonly_database_snapshot(postgres_id):
    sql = '''SELECT to_json(json_build_object(
      'counts', json_build_object(
        'AppUser', (SELECT count(*) FROM public."AppUser"),
        'PersonalKnowledgeDocument', (SELECT count(*) FROM public."PersonalKnowledgeDocument"),
        'PersonalKnowledgeSemanticChallenge', (SELECT count(*) FROM public."PersonalKnowledgeSemanticChallenge"),
        'PersonalKnowledgeSemanticAudit', (SELECT count(*) FROM public."PersonalKnowledgeSemanticAudit"),
        'PlatformTokenGrant', (SELECT count(*) FROM public."PlatformTokenGrant"),
        'PlatformTokenReservation', (SELECT count(*) FROM public."PlatformTokenReservation"),
        'PlatformTokenLedgerEntry', (SELECT count(*) FROM public."PlatformTokenLedgerEntry"),
        'AccountEntitlementActivation', (SELECT count(*) FROM public."AccountEntitlementActivation")),
      'activeOffers', coalesce((SELECT json_agg(x ORDER BY x->>'offerVersion') FROM
        (SELECT json_build_object('offerVersion', "offerVersion", 'amount', "amount",
          'validForDays', "validForDays", 'eligibilityKey', "eligibilityKey") AS x
         FROM public."PlatformGrantOfferPolicy" WHERE "status" = 'active') q), '[]'::json),
      'activeEmbeddingRoutes', coalesce((SELECT json_agg(x ORDER BY x->>'id') FROM
        (SELECT json_build_object('id', r."id", 'version', r."version", 'modelId', r."modelId",
          'providerConnectionId', r."providerConnectionId", 'updatedAt', r."updatedAt",
          'validatedProviderConfigurationVersion', r."validatedProviderConfigurationVersion") AS x
         FROM public."PlatformDefaultAiRoute" r WHERE r."status" = 'active' AND r."operation" = 'embedding') q), '[]'::json)
    ))'''
    return db_query(postgres_id, sql)


def parse_record(path):
    values = {}
    status_seen = False
    for line in Path(path).read_text(encoding='utf-8').splitlines():
        if not line:
            continue
        if line == 'DEPLOY_OK' and not status_seen and not values:
            values['status'] = 'DEPLOY_OK'
            status_seen = True
            continue
        require('=' in line, 'RECORD_INVALID')
        key, value = line.split('=', 1)
        require(re.fullmatch(r'[a-z][a-z0-9_]*', key) is not None and key not in values,
                'RECORD_INVALID')
        values[key] = value
    return values


def source_runtime_state(require_checkout=True):
    HELPER.trusted(RESULT, 0o600)
    result = parse_record(RESULT)
    require(result.get('status') == 'DEPLOY_OK' and result.get('tag') == SOURCE_TAG
            and result.get('revision') == SOURCE_REVISION,
            'SOURCE_RECEIPT_INVALID')
    require(not require_checkout or git(['rev-parse', 'HEAD']) == SOURCE_REVISION,
            'SOURCE_CHECKOUT_INVALID')
    if require_checkout:
        require(git(['status', '--porcelain', '--untracked-files=all']) == '', 'MANAGED_CHECKOUT_DIRTY')
    values = env_values()
    hashes = config_hashes()
    HELPER.trusted(ROOT); HELPER.trusted(ROOT / '.git')
    HELPER.trusted(OVERRIDE)
    HELPER.trusted('/etc/nginx/snippets/ai-project-os-proxy.conf')
    enabled_info = NGINX_ENABLED.lstat()
    require(stat.S_ISLNK(enabled_info.st_mode) and enabled_info.st_uid == enabled_info.st_gid == 0
            and NGINX_ENABLED.resolve() == NGINX, 'NGINX_ENABLED_PATH_INVALID')
    HELPER.run(['systemctl', 'is-active', '--quiet', 'nginx'])
    local_health = HELPER.healthy('1.0.0')
    public_health = HELPER.healthy('1.0.0', public=True)
    writers = [container(service) for service in ('app', 'worker', 'git-worker')]
    postgres = container('postgres')
    postgres_id = postgres['Id']
    require(HEX64.fullmatch(postgres_id) is not None, 'POSTGRES_CONTAINER_ID_INVALID')
    require(postgres['State'].get('Health', {}).get('Status') == 'healthy'
            and postgres['State'].get('Running') and not postgres['State'].get('Paused'),
            'POSTGRES_UNHEALTHY')
    require(postgres['Config'].get('Image') == IMAGE, 'POSTGRES_IMAGE_INVALID')
    bindings = postgres['NetworkSettings']['Ports'].get('5432/tcp')
    require(isinstance(bindings, list) and len(bindings) == 1
            and bindings[0]['HostIp'] == '127.0.0.1', 'DATABASE_NOT_ISOLATED')
    for writer in writers:
        require(writer['State'].get('Health', {}).get('Status') == 'healthy'
                and writer['State'].get('Running') and not writer['State'].get('Paused'),
                'SOURCE_WRITER_UNHEALTHY')
        require(writer['Config'].get('Labels', {}).get('org.opencontainers.image.version') == '1.0.0',
                'SOURCE_IMAGE_VERSION_INVALID')
    manifest = source_manifest()
    require(len(manifest) == SOURCE_MIGRATIONS, 'SOURCE_MIGRATION_COUNT_INVALID')
    migration_ledger(postgres_id, manifest)
    database = readonly_database_snapshot(postgres_id)
    validate_default_signup_policy(database)
    return {
        'postgres_id': postgres_id,
        'writers': writers,
        'writer_ids': {service: writer['Id'] for service, writer in zip(('app', 'worker', 'git-worker'), writers)},
        'writer_images': {service: writer['Image'] for service, writer in zip(('app', 'worker', 'git-worker'), writers)},
        'source_manifest': manifest,
        'config_hashes': hashes,
        'database_snapshot': database,
        'local_health': local_health,
        'public_health': public_health,
        'env': values,
        'nginx_before': NGINX.read_bytes(),
        'source_tag': SOURCE_TAG,
        'source_revision': SOURCE_REVISION,
    }


def read_backup_artifact_helper():
    HELPER.trusted(ARTIFACT_HELPER, 0o755)
    spec = importlib.util.spec_from_file_location('ai_project_os_backup_artifact_v101', ARTIFACT_HELPER)
    require(spec is not None and spec.loader is not None, 'BACKUP_ARTIFACT_HELPER_LOAD_FAILED')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def verify_backup_output(stdout):
    matches = [line for line in stdout.splitlines() if line.startswith('BACKUP_OK ')]
    require(len(matches) == 1, 'BACKUP_RECEIPT_INVALID')
    fields = {}
    for token in matches[0].split()[1:]:
        require('=' in token, 'BACKUP_RECEIPT_INVALID')
        key, value = token.split('=', 1)
        require(key not in fields, 'BACKUP_RECEIPT_INVALID')
        fields[key] = value
    require(fields.get('reason') == 'pre-deploy-to-v1.0.1'
            and fields.get('retention_removed') == '0'
            and fields.get('source_quiesced') == 'true', 'BACKUP_RECEIPT_INVALID')
    source = Path(fields.get('source', ''))
    require(source.parent == Path('/var/backups/ai-project-os')
            and BACKUP_NAME.fullmatch(source.name) is not None, 'BACKUP_SOURCE_INVALID')
    object_path = fields.get('object', '')
    verified_manifest = fields.get('verified_manifest', '')
    latest_manifest = fields.get('manifest', '')
    backup_name = source.name
    require(re.fullmatch(r'cos://ai-project-os-backup-[0-9]+/[A-Za-z0-9][A-Za-z0-9._/-]{1,2000}', object_path) is not None
            and re.search(r'/backups/[0-9]{4}/[0-9]{2}/[0-9]{2}/' + re.escape(backup_name)
                          + '/' + re.escape(backup_name) + r'\.tar\.age$', object_path) is not None,
            'BACKUP_OBJECT_INVALID')
    require(verified_manifest == object_path.removesuffix('.tar.age') + '.manifest.json',
            'BACKUP_VERIFIED_MANIFEST_INVALID')
    require(latest_manifest.startswith(object_path.split('/backups/', 1)[0] + '/')
            and latest_manifest.endswith('/manifests/latest.json'), 'BACKUP_LATEST_MANIFEST_INVALID')
    require(HEX64.fullmatch(fields.get('sha256', '')) is not None, 'BACKUP_SHA_INVALID')
    return {'name': backup_name, 'path': source, 'object': object_path,
            'verified_manifest': verified_manifest, 'manifest': latest_manifest,
            'sha256': fields['sha256']}


def validate_local_backup(backup, current_email_bytes):
    path = backup['path']
    HELPER.trusted(path, 0o700)
    entries = {entry.name for entry in path.iterdir()}
    require(entries == BACKUP_REQUIRED_FILES, 'BACKUP_LAYOUT_INVALID')
    for name in BACKUP_REQUIRED_FILES:
        file_path = path / name
        HELPER.trusted(file_path, 0o600)
    sums = {}
    for line in (path / 'SHA256SUMS').read_text(encoding='ascii').splitlines():
        match = re.fullmatch(r'([0-9a-f]{64})  ([A-Za-z0-9.-]+)', line)
        require(match is not None and match.group(2) not in sums, 'BACKUP_SHA_MANIFEST_INVALID')
        sums[match.group(2)] = match.group(1)
    expected = BACKUP_REQUIRED_FILES - {'SHA256SUMS', '.cos-upload-verified'}
    require(set(sums) == expected, 'BACKUP_SHA_MANIFEST_INVALID')
    for name, digest in sums.items():
        require(hash_file(path / name) == digest, 'BACKUP_FILE_SHA_MISMATCH')
    metadata = parse_record(path / 'backup-metadata.env')
    require(metadata.get('format_version') == '2' and metadata.get('reason') == 'pre-deploy-to-v1.0.1'
            and metadata.get('compose_project') == PROJECT and metadata.get('app_version') == '1.0.0'
            and metadata.get('writers_quiesced') == 'true' and metadata.get('source_quiesced') == 'true'
            and metadata.get('backup_name') == backup['name'], 'BACKUP_METADATA_INVALID')
    marker = parse_record(path / '.cos-upload-verified')
    require(marker.get('status') == 'COS_UPLOAD_VERIFIED'
            and marker.get('archive_object') == backup['object']
            and marker.get('manifest_object') == backup['verified_manifest']
            and marker.get('latest_manifest_object') == backup['manifest']
            and marker.get('archive_sha256') == backup['sha256'], 'BACKUP_MARKER_INVALID')
    artifact = read_backup_artifact_helper()
    artifact.validate_host_config(path / 'host-config.tar.gz', require_email=True)
    with tarfile.open(path / 'host-config.tar.gz', 'r:gz') as archive:
        email_path = 'etc/ai-project-os/email-auth.env'
        members = [member for member in archive.getmembers()
                   if artifact.normalized_member_name(member.name) == email_path]
        require(len(members) == 1, 'BACKUP_EMAIL_AUTH_INVALID')
        member = members[0]
        require(member.isfile() and member.size <= 1024 * 1024, 'BACKUP_EMAIL_AUTH_INVALID')
        stream = archive.extractfile(member)
        require(stream is not None, 'BACKUP_EMAIL_AUTH_INVALID')
        archived_email = stream.read(1024 * 1024 + 1)
    require(archived_email == current_email_bytes, 'BACKUP_EMAIL_AUTH_MISMATCH')
    require((path / 'postgres.dump').stat().st_size > 0, 'BACKUP_DATABASE_DUMP_EMPTY')


def create_backup(source):
    env = dict(PROCESS_ENV)
    env.update({
        'AI_PROJECT_OS_DEPLOY_LOCK_HELD': '1',
        'AI_PROJECT_OS_CUTOVER': '1',
        'AI_PROJECT_OS_CUTOVER_LOCK_HELD': '1',
        'AI_PROJECT_OS_EXPECTED_APP_ID': source['writer_ids']['app'],
        'AI_PROJECT_OS_EXPECTED_WORKER_ID': source['writer_ids']['worker'],
        'AI_PROJECT_OS_EXPECTED_GIT_WORKER_ID': source['writer_ids']['git-worker'],
    })
    HELPER.trusted(BACKUP, 0o755)
    result = subprocess.run([str(BACKUP), 'pre-deploy', TARGET_TAG], env=env,
                            text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            timeout=7200, check=False)
    require(result.returncode == 0, 'BACKUP_COMMAND_FAILED')
    backup = verify_backup_output(result.stdout)
    validate_local_backup(backup, EMAIL_ENV.read_bytes())
    return backup


class HostDeployment:
    def __init__(self, target_revision):
        self.target_revision = target_revision
        self.source = None
        self.target_files = None
        self.images = None
        self.backup = None
        self.pin_file = None
        self.nginx_stopped = False
        self.writers_stopped = False
        self.nginx_replaced = False
        self.restore_token = None
        self.restore_network = None
        self.restore_network_id = None
        self.restore_volume = None
        self.restore_container_ids = []

    def preflight(self):
        validate_transition(SOURCE_TAG, SOURCE_REVISION, TARGET_TAG, self.target_revision)
        require(os.geteuid() == 0, 'ROOT_REQUIRED')
        HELPER.trusted('/root'); HELPER.trusted('/usr/bin'); HELPER.trusted('/usr/sbin')
        HELPER.trusted(ROOT); HELPER.trusted(ROOT / '.git')
        require(git(['remote', 'get-url', 'origin']) == REMOTE, 'REMOTE_INVALID')
        require(git(['rev-parse', 'HEAD']) == SOURCE_REVISION, 'SOURCE_CHECKOUT_INVALID')
        require(git(['status', '--porcelain', '--untracked-files=all']) == '', 'MANAGED_CHECKOUT_DIRTY')
        self.source = source_runtime_state(require_checkout=True)
        fetch_target(self.target_revision)
        require_ci(self.target_revision)
        _, self.target_files = validate_target_tree(self.target_revision, self.source['source_manifest'])
        self._validate_installed_state()
        return self.source

    def _validate_installed_state(self):
        HELPER.trusted(STATE, 0o600)
        data = json.loads(STATE.read_text(encoding='utf-8'))
        require(set(data) == {'format_version', 'tag', 'revision', 'files'}
                and data.get('format_version') == 1 and data.get('tag') == TARGET_TAG
                and data.get('revision') == self.target_revision, 'TOOLING_STATE_INVALID')
        paths = {'deployer': DEPLOYER, 'backup': BACKUP, 'artifact_helper': ARTIFACT_HELPER,
                 'sudoers': SUDOERS, 'gateway': GATEWAY}
        expected_sources = {'deployer': DEPLOYER_SOURCE, 'backup': BACKUP_SOURCE,
                            'artifact_helper': ARTIFACT_SOURCE, 'sudoers': SUDOERS_SOURCE,
                            'gateway': GATEWAY_SOURCE}
        require(set(data.get('files', {})) == set(paths), 'TOOLING_STATE_INVALID')
        for key, path in paths.items():
            expected_mode = {'deployer': 0o700, 'backup': 0o755, 'artifact_helper': 0o755,
                             'sudoers': 0o440, 'gateway': 0o755}[key]
            HELPER.trusted(path, expected_mode)
            digest = sha256(path.read_bytes())
            require(data['files'].get(key) == digest
                    and path.read_bytes() == git_blob(self.target_revision, expected_sources[key]),
                    'TOOLING_FILE_MISMATCH')
        require(sha256((ROOT / HELPER_SOURCE).read_bytes()) == HELPER_SHA256,
                'PINNED_HELPER_HASH_INVALID')

    def checkout_target(self):
        git(['checkout', '--detach', self.target_revision])
        require(git(['rev-parse', 'HEAD']) == self.target_revision, 'TARGET_CHECKOUT_INVALID')
        require(git(['status', '--porcelain', '--untracked-files=all']) == '', 'TARGET_CHECKOUT_DIRTY')
        target, files = validate_target_tree(self.target_revision, self.source['source_manifest'])
        self.target_files = files
        self.target_manifest = target
        require((ROOT / DEPLOYER_SOURCE).read_bytes() == files['deployer'], 'INSTALLED_TOOL_TARGET_MISMATCH')
        require((ROOT / BACKUP_SOURCE).read_bytes() == files['backup'], 'TARGET_BACKUP_SOURCE_MISMATCH')
        require((ROOT / ARTIFACT_SOURCE).read_bytes() == files['artifact_helper'], 'TARGET_ARTIFACT_SOURCE_MISMATCH')

    def build_target_images(self):
        compose('config', '--quiet')
        service_names = {
            'principal-bootstrap': 'ai-project-os-principal-bootstrap',
            'migrate': 'ai-project-os-migrate',
            'reconcile': 'ai-project-os-reconcile',
            'app': 'ai-project-os-app',
            'worker': 'ai-project-os-worker',
            'git-worker': 'ai-project-os-git-worker',
        }
        for service in service_names:
            compose('build', service, capture=False, timeout=7200)
        images = {}
        for service, image_name in service_names.items():
            image_id = docker('image', 'inspect', '--format', '{{.Id}}', image_name)
            require(re.fullmatch(r'sha256:[a-f0-9]{64}', image_id) is not None, 'TARGET_IMAGE_ID_INVALID')
            inspected = json.loads(docker('image', 'inspect', image_id))[0]
            require(inspected.get('Config', {}).get('Labels', {}).get('org.opencontainers.image.version')
                    == TARGET_VERSION, 'TARGET_IMAGE_VERSION_INVALID')
            images[service] = image_id
        pin_path = Path('/var/lib/ai-project-os/.v101-images-' + secrets.token_hex(12) + '.yaml')
        self.pin_file = pin_path
        text = 'services:\n'
        for service, image_id in images.items():
            text += '  ' + service + ":\n    image: '" + image_id + "'\n    build: null\n"
        HELPER.atomic_write(pin_path, text.encode('ascii'), 0o600)
        HELPER.trusted(pin_path, 0o600)
        compose('config', '--quiet', pin_file=pin_path)
        self.images = images
        return images

    def revalidate_source(self, source):
        require(git(['rev-parse', 'HEAD']) == self.target_revision, 'TARGET_CHECKOUT_CHANGED')
        require(source['postgres_id'] == container('postgres')['Id'], 'SOURCE_POSTGRES_CHANGED_DURING_BUILD')
        writers = [container(service) for service in ('app', 'worker', 'git-worker')]
        require([(writer['Id'], writer['Image']) for writer in writers]
                == [(source['writer_ids'][service], source['writer_images'][service])
                    for service in ('app', 'worker', 'git-worker')], 'SOURCE_WRITERS_CHANGED_DURING_BUILD')
        require(all(writer['State'].get('Running') and not writer['State'].get('Paused')
                    and writer['State'].get('Health', {}).get('Status') == 'healthy'
                    for writer in writers), 'SOURCE_WRITER_UNHEALTHY_AFTER_BUILD')
        require(config_hashes() == source['config_hashes'], 'SOURCE_CONFIG_CHANGED_DURING_BUILD')
        migration_ledger(source['postgres_id'], source['source_manifest'])
        snapshot = readonly_database_snapshot(source['postgres_id'])
        validate_default_signup_policy(snapshot)
        require(policy_snapshot(snapshot) == policy_snapshot(source['database_snapshot']),
                'SOURCE_DATABASE_POLICY_CHANGED_DURING_BUILD')
        HELPER.healthy('1.0.0'); HELPER.healthy('1.0.0', public=True)

    def stop_nginx(self):
        self.nginx_stopped = True
        HELPER.run(['systemctl', 'stop', 'nginx'])

    def stop_source_writers(self, source):
        self.writers_stopped = True
        docker('stop', *[source['writer_ids'][service] for service in ('app', 'worker', 'git-worker')])
        HELPER.stopped(source['postgres_id'])
        migration_ledger(source['postgres_id'], source['source_manifest'])
        snapshot = readonly_database_snapshot(source['postgres_id'])
        validate_default_signup_policy(snapshot)
        require(policy_snapshot(snapshot) == policy_snapshot(source['database_snapshot']),
                'SOURCE_DATABASE_POLICY_CHANGED_AT_CUTOVER')
        source['database_snapshot'] = snapshot

    def create_and_validate_backup(self, source):
        self.backup = create_backup(source)
        migration_ledger(source['postgres_id'], source['source_manifest'])
        require(readonly_database_snapshot(source['postgres_id']) == source['database_snapshot'],
                'SOURCE_DATABASE_STATE_CHANGED_DURING_BACKUP')
        return self.backup

    def restore_drill(self, source, backup, images):
        self.restore_token = secrets.token_hex(16)
        suffix = self.restore_token
        owner_key = 'ai-project-os.v101-restore-owner'
        owner_value = suffix
        network_name = 'ai-project-os-v101-net-' + suffix
        volume_name = 'ai-project-os-v101-vol-' + suffix
        pg_name = 'ai-project-os-v101-pg-' + suffix
        self.restore_network = network_name
        self.restore_network_id = docker('network', 'create', '--internal',
                                         '--label', owner_key + '=' + owner_value,
                                         network_name)
        require(HEX64.fullmatch(self.restore_network_id) is not None, 'RESTORE_NETWORK_ID_INVALID')
        self.restore_volume = volume_name
        docker('volume', 'create', '--label', owner_key + '=' + owner_value, volume_name)
        volume = json.loads(docker('volume', 'inspect', self.restore_volume))[0]
        require(volume.get('Name') == self.restore_volume
                and volume.get('Labels', {}).get(owner_key) == owner_value, 'RESTORE_VOLUME_OWNERSHIP_INVALID')
        passwords = {name: secrets.token_hex(32) for name in (
            'admin', 'migrator', 'runtime', 'entitlement', 'git', 'reader')}
        pg_id = docker('create', '--name', pg_name, '--network', self.restore_network,
               '--network-alias', 'postgres',
               '--label', owner_key + '=' + owner_value,
               '--mount', 'type=volume,src=' + self.restore_volume + ',dst=/var/lib/postgresql',
               '--env', 'POSTGRES_USER=ai_project_os_cluster_admin',
               '--env', 'POSTGRES_PASSWORD=' + passwords['admin'],
               '--env', 'POSTGRES_DB=ai_project_os',
               '--health-cmd', 'pg_isready -d ai_project_os', '--health-interval', '2s',
               '--health-timeout', '3s', '--health-retries', '60', IMAGE, 'postgres',
               '-c', 'listen_addresses=*')
        self.restore_container_ids.append(pg_id)
        require(HEX64.fullmatch(pg_id) is not None, 'RESTORE_CONTAINER_ID_INVALID')
        pg_info = json.loads(docker('inspect', pg_id))[0]
        require(pg_info.get('Config', {}).get('Labels', {}).get(owner_key) == owner_value
                and pg_info.get('Config', {}).get('Image') == IMAGE
                and pg_info.get('Name') == '/' + pg_name, 'RESTORE_CONTAINER_OWNERSHIP_INVALID')
        docker('start', pg_id)
        self._wait_restore_postgres(pg_id)
        env = self._restore_database_env(passwords)
        self._run_restore_image(images['principal-bootstrap'], self.restore_network, owner_key,
                                owner_value, env, ['node', 'node_modules/tsx/dist/cli.mjs',
                                'scripts/reconcile-database-principals.ts', '--bootstrap-if-needed'])
        self._verify_restore_roles(pg_id)
        dump_path = backup['path'] / 'postgres.dump'
        docker('cp', str(dump_path), pg_id + ':/tmp/ai-project-os-v101-postgres.dump')
        docker('exec', pg_id, 'pg_restore', '--clean', '--if-exists', '--no-privileges',
               '--exit-on-error', '-U', 'ai_project_os_cluster_admin', '-d', 'ai_project_os',
               '/tmp/ai-project-os-v101-postgres.dump', timeout=3600)
        migration_ledger(pg_id, source['source_manifest'])
        counts_before = readonly_database_snapshot(pg_id)
        migrate_env = dict(env)
        migrate_env['DATABASE_URL'] = env['MIGRATOR_DATABASE_URL']
        self._run_restore_image(images['migrate'], self.restore_network, owner_key, owner_value,
                                migrate_env, ['node', 'node_modules/prisma/build/index.js', 'migrate',
                                      'deploy', '--config', 'prisma.config.ts'], timeout=3600)
        self._run_restore_image(images['reconcile'], self.restore_network, owner_key, owner_value,
                                env, ['node', 'node_modules/tsx/dist/cli.mjs',
                                      'scripts/reconcile-database-principals.ts'], timeout=3600)
        migration_ledger(pg_id, self.target_manifest)
        require(readonly_database_snapshot(pg_id) == counts_before,
                'RESTORE_DATABASE_COUNTS_CHANGED')
        require(self._private_trigger_acl_closed(pg_id), 'RESTORE_PRIVATE_TRIGGER_ACL_INVALID')
        self._verify_restore_roles(pg_id)
        require(counts_before == source['database_snapshot'], 'RESTORE_SOURCE_COUNTS_MISMATCH')
        self.restore_evidence = {'container_id': pg_id, 'network_id': self.restore_network_id,
                                 'volume': self.restore_volume,
                                 'source_migration_count': SOURCE_MIGRATIONS,
                                 'target_migration_count': EXPECTED_MIGRATIONS,
                                 'database_snapshot': counts_before,
                                 'source_sha256': hash_file(backup['path'] / 'postgres.dump')}

    def _restore_database_env(self, passwords):
        root_url = 'postgresql://ai_project_os_cluster_admin:' + passwords['admin'] + '@postgres:5432/ai_project_os'
        return {
            'DATABASE_PRINCIPAL_ADMIN_URL': root_url,
            'DATABASE_URL': 'postgresql://ai_project_os_runtime:' + passwords['runtime'] + '@postgres:5432/ai_project_os',
            'ENTITLEMENT_DATABASE_URL': 'postgresql://ai_project_os_entitlement_writer:' + passwords['entitlement'] + '@postgres:5432/ai_project_os',
            'GIT_AUTOMATION_DATABASE_URL': 'postgresql://ai_project_os_git_automation_worker:' + passwords['git'] + '@postgres:5432/ai_project_os',
            'MIGRATOR_DATABASE_URL': 'postgresql://ai_project_os_migrator:' + passwords['migrator'] + '@postgres:5432/ai_project_os',
            'POSTGRES_ENTITLEMENT_INVENTORY_READER_PASSWORD': passwords['reader'],
        }

    def _run_restore_image(self, image_id, network, owner_key, owner_value, env, command, timeout=1800):
        name = 'ai-project-os-v101-job-' + secrets.token_hex(12)
        args = ['create', '--name', name, '--network', network, '--label', owner_key + '=' + owner_value]
        for key, value in env.items():
            args.extend(['--env', key + '=' + value])
        args.extend([image_id, *command])
        identifier = docker(*args, timeout=timeout)
        require(HEX64.fullmatch(identifier) is not None, 'RESTORE_JOB_ID_INVALID')
        info = json.loads(docker('inspect', identifier))[0]
        require(info.get('Config', {}).get('Labels', {}).get(owner_key) == owner_value
                and info.get('Config', {}).get('Image') == image_id
                and info.get('Name') == '/' + name, 'RESTORE_JOB_OWNERSHIP_INVALID')
        self.restore_container_ids.append(identifier)
        docker('start', identifier, timeout=timeout)
        exit_code = docker('wait', identifier, timeout=timeout)
        require(exit_code == '0', 'RESTORE_JOB_FAILED')

    def _wait_restore_postgres(self, identifier):
        for _ in range(120):
            state = json.loads(docker('inspect', identifier))[0].get('State', {})
            if state.get('Health', {}).get('Status') == 'healthy':
                return
            if state.get('Status') == 'exited':
                raise RuntimeError('V101_RESTORE_POSTGRES_FAILED')
            time.sleep(1)
        raise RuntimeError('V101_RESTORE_POSTGRES_TIMEOUT')

    def _private_trigger_acl_closed(self, postgres_id):
        sql = '''SELECT to_json(count(*) = 1 AND bool_and(
          p.proowner = (SELECT oid FROM pg_roles WHERE rolname = 'ai_project_os_migrator')
          AND NOT p.prosecdef
          AND NOT EXISTS (
            SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
            WHERE acl.privilege_type = 'EXECUTE'
              AND (acl.grantee = 0 OR acl.grantee IN (
                SELECT oid FROM pg_roles WHERE rolname IN
                  ('ai_project_os_runtime', 'ai_project_os_entitlement_writer')))
          )
        )) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = 'personal_semantic_token_reservation_guard' '''
        return db_query(postgres_id, sql) is True

    def _verify_restore_roles(self, postgres_id):
        expected = sorted((
            'ai_project_os_cluster_admin', 'ai_project_os_migrator', 'ai_project_os_runtime',
            'ai_project_os_entitlement_writer', 'ai_project_os_git_automation_worker',
            'ai_project_os_entitlement_inventory_reader',
        ))
        actual = db_query(postgres_id, '''SELECT to_json(coalesce(array_agg(rolname ORDER BY rolname), ARRAY[]::text[]))
          FROM pg_roles WHERE rolname = ANY(ARRAY[
            'ai_project_os_cluster_admin', 'ai_project_os_migrator', 'ai_project_os_runtime',
            'ai_project_os_entitlement_writer', 'ai_project_os_git_automation_worker',
            'ai_project_os_entitlement_inventory_reader']::text[])''')
        require(actual == expected, 'RESTORE_DATABASE_PRINCIPALS_INVALID')

    def install_and_test_target_nginx(self):
        candidate = self.target_files['nginx']
        self.nginx_replaced = True
        HELPER.atomic_write(NGINX, candidate, 0o644)
        HELPER.run(['nginx', '-t'])

    def migrate(self, images):
        require(images == self.images and self.pin_file is not None, 'TARGET_IMAGES_CHANGED')
        HELPER.stopped(self.source['postgres_id'])
        migration_ledger(self.source['postgres_id'], self.source['source_manifest'])
        require(readonly_database_snapshot(self.source['postgres_id']) == self.source['database_snapshot'],
                'SOURCE_DATABASE_STATE_CHANGED_BEFORE_MIGRATION')
        compose('run', '--rm', '--no-deps', 'migrate', pin_file=self.pin_file,
                capture=False, timeout=3600)
        HELPER.stopped(self.source['postgres_id'])

    def reconcile(self, images):
        require(images == self.images and self.pin_file is not None, 'TARGET_IMAGES_CHANGED')
        compose('run', '--rm', '--no-deps', 'reconcile', pin_file=self.pin_file,
                capture=False, timeout=3600)
        HELPER.stopped(self.source['postgres_id'])
        migration_ledger(self.source['postgres_id'], self.target_manifest)

    def start_target_writers(self, images):
        require(images == self.images and self.pin_file is not None, 'TARGET_IMAGES_CHANGED')
        compose('up', '-d', '--no-deps', '--no-build', '--force-recreate',
                'app', 'worker', 'git-worker', pin_file=self.pin_file,
                capture=False, timeout=1800)

    def verify_target(self, source, backup, images):
        for _ in range(120):
            try:
                writers = [container(service) for service in ('app', 'worker', 'git-worker')]
                require(all(writer['State'].get('Running')
                            and writer['State'].get('Health', {}).get('Status') == 'healthy'
                            and writer['Image'] == images[service]
                            for service, writer in zip(('app', 'worker', 'git-worker'), writers)),
                        'TARGET_WRITER_UNHEALTHY')
                local_health = healthy(TARGET_VERSION)
                HELPER.run(['systemctl', 'start', 'nginx'])
                self.nginx_stopped = False
                HELPER.run(['nginx', '-t'])
                HELPER.run(['systemctl', 'reload', 'nginx'])
                public_health = healthy(TARGET_VERSION, public=True)
                break
            except (RuntimeError, OSError, ValueError):
                time.sleep(2)
        else:
            raise RuntimeError('V101_TARGET_HEALTH_TIMEOUT')
        self.target_health = {'local': local_health, 'public': public_health}
        require(container('postgres')['Id'] == source['postgres_id'], 'PRODUCTION_POSTGRES_REPLACED')
        migration_ledger(source['postgres_id'], self.target_manifest)
        snapshot = readonly_database_snapshot(source['postgres_id'])
        validate_default_signup_policy(snapshot)
        require(policy_snapshot(snapshot) == policy_snapshot(source['database_snapshot']),
                'PRODUCTION_ROUTE_OR_OFFER_CHANGED')
        expected_config_hashes = dict(source['config_hashes'])
        expected_config_hashes['nginx'] = sha256(self.target_files['nginx'])
        require(config_hashes() == expected_config_hashes, 'PRODUCTION_CONFIG_CHANGED')
        require(sha256(NGINX.read_bytes()) == sha256(self.target_files['nginx']), 'TARGET_NGINX_HASH_INVALID')
        self.target_writer_ids = {service: container(service)['Id'] for service in ('app', 'worker', 'git-worker')}

    def write_receipt(self, source, backup, images):
        record = {
            'tag': TARGET_TAG, 'revision': self.target_revision,
            'source_tag': SOURCE_TAG, 'source_revision': SOURCE_REVISION,
            'source_postgres_container_id': source['postgres_id'],
            'target_writer_ids': self.target_writer_ids,
            'migration_count': EXPECTED_MIGRATIONS,
            'backup_name': backup['name'], 'backup_object': backup['object'],
            'backup_verified_manifest': backup['verified_manifest'],
            'backup_sha256': backup['sha256'], 'source_config_hashes': source['config_hashes'],
            'target_nginx_sha256': sha256(self.target_files['nginx']),
            'target_image_ids': images, 'restore_drill': self.restore_evidence,
            'readonly_source_snapshot': source['database_snapshot'],
            'health': self.target_health,
            'completed_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        }
        plain_string_keys = {'tag', 'revision', 'source_tag', 'source_revision'}
        text = 'DEPLOY_OK\n' + ''.join(
            key + '=' + (value if key in plain_string_keys else
                         json.dumps(value, separators=(',', ':'), sort_keys=True)) + '\n'
            for key, value in record.items()
        )
        HELPER.atomic_write(RESULT, text.encode('utf-8'), 0o600)
        print('V101_DEPLOY_OK tag=' + TARGET_TAG + ' revision=' + self.target_revision
              + ' migration_count=145 backup=' + backup['name'] + ' restore=143-to-145', flush=True)

    def restore_exact_source(self, source):
        failures = []
        try:
            if git(['rev-parse', 'HEAD']) != SOURCE_REVISION:
                git(['checkout', '--detach', SOURCE_REVISION])
            require(git(['rev-parse', 'HEAD']) == SOURCE_REVISION, 'SOURCE_CHECKOUT_RESTORE_FAILED')
        except BaseException:
            failures.append('checkout')
        try:
            if self.nginx_replaced:
                HELPER.atomic_write(NGINX, source['nginx_before'], 0o644)
                HELPER.run(['nginx', '-t'])
        except BaseException:
            failures.append('nginx-config')
        try:
            if self.writers_stopped:
                stopped_ids = []
                for service in ('app', 'worker', 'git-worker'):
                    writer_id = source['writer_ids'][service]
                    info = json.loads(docker('inspect', writer_id))[0]
                    require(info['Id'] == writer_id
                            and info['Config']['Labels'].get('com.docker.compose.service') == service,
                            'SOURCE_WRITER_IDENTITY_CHANGED')
                    if not info['State'].get('Running'):
                        stopped_ids.append(writer_id)
                if stopped_ids:
                    docker('start', *stopped_ids)
                for _ in range(120):
                    try:
                        HELPER.healthy('1.0.0')
                        require(all(container(service)['State'].get('Health', {}).get('Status') == 'healthy'
                                    for service in ('app', 'worker', 'git-worker')),
                                'SOURCE_WRITER_RESTART_FAILED')
                        break
                    except (RuntimeError, OSError, ValueError):
                        time.sleep(2)
                else:
                    raise RuntimeError('V101_SOURCE_HEALTH_RESTORE_FAILED')
        except BaseException:
            failures.append('writers')
        try:
            if self.nginx_stopped:
                HELPER.run(['systemctl', 'start', 'nginx'])
                self.nginx_stopped = False
            elif self.nginx_replaced:
                HELPER.run(['systemctl', 'reload', 'nginx'])
            if self.nginx_stopped is False:
                HELPER.run(['systemctl', 'is-active', '--quiet', 'nginx'])
                HELPER.healthy('1.0.0', public=True)
        except BaseException:
            failures.append('nginx-service')
        try:
            require(container('postgres')['Id'] == source['postgres_id'], 'SOURCE_POSTGRES_CHANGED')
            migration_ledger(source['postgres_id'], source['source_manifest'])
        except BaseException:
            failures.append('database')
        print('V101_PRE_MIGRATION_SOURCE_RESTORED=' + ('false' if failures else 'true'),
              file=sys.stderr, flush=True)
        if failures:
            raise RuntimeError('V101_PRE_MIGRATION_RECOVERY_INCOMPLETE')

    def quiesce_for_manual_recovery(self, source):
        try:
            if not self.nginx_stopped:
                HELPER.run(['systemctl', 'stop', 'nginx'])
                self.nginx_stopped = True
            running = docker('ps', '--no-trunc', '--format', '{{.ID}} {{.Label "com.docker.compose.service"}}',
                             '--filter', 'label=com.docker.compose.project=' + PROJECT).splitlines()
            to_stop = []
            for line in running:
                identifier, service = line.split(' ', 1)
                require(HEX64.fullmatch(identifier) is not None, 'RECOVERY_CONTAINER_ID_INVALID')
                if identifier != source['postgres_id']:
                    require(service != 'postgres', 'RECOVERY_POSTGRES_CHANGED')
                    to_stop.append(identifier)
            if to_stop:
                docker('stop', *to_stop)
            HELPER.stopped(source['postgres_id'])
            print('V101_MIGRATION_RECOVERY_REQUIRED writers_stopped=true nginx_stopped=true',
                  file=sys.stderr, flush=True)
        except BaseException as error:
            raise RuntimeError('V101_MANUAL_RECOVERY_QUIESCE_FAILED') from error

    def cleanup_restore_drill(self):
        if self.restore_token is None:
            return
        owner_key = 'ai-project-os.v101-restore-owner'
        owner_value = self.restore_token
        failures = []
        for identifier in list(reversed(self.restore_container_ids)):
            try:
                require(HEX64.fullmatch(identifier) is not None, 'RESTORE_CLEANUP_CONTAINER_ID_INVALID')
                matches = docker('ps', '-aq', '--no-trunc', '--filter', 'id=' + identifier).splitlines()
                if not matches:
                    continue
                require(matches == [identifier], 'RESTORE_CLEANUP_CONTAINER_ID_AMBIGUOUS')
                info = json.loads(docker('inspect', identifier))[0]
                require(info['Id'] == identifier
                        and info['Config']['Labels'].get(owner_key) == owner_value,
                        'RESTORE_CLEANUP_CONTAINER_OWNERSHIP_INVALID')
                if info['State'].get('Running'):
                    docker('stop', identifier)
                docker('rm', identifier)
                require(docker('ps', '-aq', '--no-trunc', '--filter', 'id=' + identifier) == '',
                        'RESTORE_CONTAINER_REMAINS')
            except BaseException:
                failures.append('container')
        if self.restore_volume:
            try:
                matches = docker('volume', 'ls', '-q', '--filter', 'name=' + self.restore_volume).splitlines()
                if matches:
                    require(matches == [self.restore_volume], 'RESTORE_CLEANUP_VOLUME_NAME_AMBIGUOUS')
                    volume = json.loads(docker('volume', 'inspect', self.restore_volume))[0]
                    require(volume.get('Name') == self.restore_volume
                            and volume.get('Labels', {}).get(owner_key) == owner_value,
                            'RESTORE_CLEANUP_VOLUME_OWNERSHIP_INVALID')
                    docker('volume', 'rm', self.restore_volume)
                    remaining = docker('volume', 'ls', '-q', '--filter', 'name=' + self.restore_volume)
                    require(self.restore_volume not in remaining.splitlines(), 'RESTORE_VOLUME_REMAINS')
            except BaseException:
                failures.append('volume')
        if self.restore_network:
            try:
                rows = docker('network', 'ls', '--no-trunc', '--format', '{{.ID}} {{.Name}}',
                              '--filter', 'name=' + self.restore_network).splitlines()
                matches = [row.split(' ', 1) for row in rows if row.endswith(' ' + self.restore_network)]
                require(len(matches) <= 1 and all(len(row) == 2 for row in matches),
                        'RESTORE_CLEANUP_NETWORK_NAME_AMBIGUOUS')
                if matches:
                    identifier = matches[0][0]
                    require(HEX64.fullmatch(identifier) is not None
                            and (self.restore_network_id is None or identifier == self.restore_network_id),
                            'RESTORE_CLEANUP_NETWORK_ID_INVALID')
                    info = json.loads(docker('network', 'inspect', identifier))[0]
                    self.restore_network_id = identifier
                    require(info.get('Id') == identifier and info.get('Name') == self.restore_network
                            and info.get('Labels', {}).get(owner_key) == owner_value,
                            'RESTORE_CLEANUP_NETWORK_OWNERSHIP_INVALID')
                    docker('network', 'rm', self.restore_network)
                    remaining = docker('network', 'ls', '--no-trunc', '-q', '--filter',
                                       'id=' + identifier)
                    require(identifier not in remaining.splitlines(), 'RESTORE_NETWORK_REMAINS')
            except BaseException:
                failures.append('network')
        if failures:
            raise RuntimeError('V101_RESTORE_RESOURCE_CLEANUP_FAILED')
        self.restore_token = None
        self.restore_container_ids = []
        self.restore_volume = None
        self.restore_network = None
        self.restore_network_id = None

    def cleanup_pin_file(self):
        if self.pin_file is None:
            return
        try:
            if self.pin_file.exists():
                HELPER.trusted(self.pin_file, 0o600)
                self.pin_file.unlink()
                require(not self.pin_file.exists(), 'TARGET_IMAGE_PIN_FILE_REMAINS')
            self.pin_file = None
        except BaseException as error:
            raise RuntimeError('V101_TARGET_IMAGE_PIN_FILE_CLEANUP_FAILED') from error


def secure_lock():
    directory = os.lstat('/run/lock')
    require(stat.S_ISDIR(directory.st_mode) and directory.st_uid == directory.st_gid == 0
            and stat.S_IMODE(directory.st_mode) == 0o1777, 'LOCK_DIRECTORY_INVALID')
    lock_path = '/run/lock/ai-project-os-deploy.lock'
    fd = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    info = os.fstat(fd)
    require(stat.S_ISREG(info.st_mode) and info.st_uid == info.st_gid == 0
            and stat.S_IMODE(info.st_mode) == 0o600, 'LOCK_INVALID')
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    return fd


def atomic_install(path, data, mode):
    path = Path(path)
    HELPER.trusted(path.parent)
    try:
        current = path.lstat()
        require(stat.S_ISREG(current.st_mode) and current.st_uid == current.st_gid == 0
                and current.st_nlink == 1, 'TOOLING_DESTINATION_INVALID')
    except FileNotFoundError:
        pass
    temporary = path.parent / ('.v101-' + secrets.token_hex(12))
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try:
        os.fchown(fd, 0, 0)
        os.fchmod(fd, mode)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        dir_fd = os.open(path.parent, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)
    finally:
        if temporary.exists():
            temporary.unlink()


def validate_state_file(target_revision=None):
    HELPER.trusted(STATE, 0o600)
    value = json.loads(STATE.read_text(encoding='utf-8'))
    require(set(value) == {'format_version', 'tag', 'revision', 'files'}
            and value.get('format_version') == 1 and value.get('tag') == TARGET_TAG
            and HEX40.fullmatch(value.get('revision', '')) is not None,
            'TOOLING_STATE_INVALID')
    if target_revision is not None:
        require(value['revision'] == target_revision, 'TOOLING_STATE_REVISION_INVALID')
    path_map = {'deployer': (DEPLOYER, 0o700), 'backup': (BACKUP, 0o755),
                'artifact_helper': (ARTIFACT_HELPER, 0o755), 'sudoers': (SUDOERS, 0o440),
                'gateway': (GATEWAY, 0o755)}
    require(set(value.get('files', {})) == set(path_map), 'TOOLING_STATE_INVALID')
    for name, (path, mode) in path_map.items():
        HELPER.trusted(path, mode)
        require(sha256(path.read_bytes()) == value['files'][name], 'TOOLING_FILE_HASH_INVALID')
    return value


def install_bootstrap(target_revision):
    require(os.geteuid() == 0, 'ROOT_REQUIRED')
    validate_transition(SOURCE_TAG, SOURCE_REVISION, TARGET_TAG, target_revision)
    self_path = Path(__file__).absolute()
    HELPER.trusted(self_path, 0o755)
    require(git(['rev-parse', 'HEAD']) == SOURCE_REVISION, 'SOURCE_CHECKOUT_INVALID')
    require(git(['status', '--porcelain', '--untracked-files=all']) == '', 'MANAGED_CHECKOUT_DIRTY')
    source = source_runtime_state(require_checkout=True)
    fetch_target(target_revision)
    require_ci(target_revision)
    _, files = validate_target_tree(target_revision, source['source_manifest'])
    require(self_path.read_bytes() == files['deployer'], 'BOOTSTRAP_SOURCE_BYTES_UNTRUSTED')
    try:
        existing = validate_state_file(target_revision)
        require(existing['files']['deployer'] == sha256(files['deployer'])
                and existing['files']['backup'] == sha256(files['backup'])
                and existing['files']['artifact_helper'] == sha256(files['artifact_helper'])
                and existing['files']['sudoers'] == sha256(files['sudoers'])
                and existing['files']['gateway'] == sha256(files['gateway']),
                'TOOLING_STATE_CONFLICT')
        print('V101_TOOLING_ALREADY_READY tag=' + TARGET_TAG + ' revision=' + target_revision)
        return
    except FileNotFoundError:
        pass
    helper_path = ROOT / HELPER_SOURCE
    require(sha256(helper_path.read_bytes()) == HELPER_SHA256, 'PINNED_HELPER_HASH_INVALID')
    destinations = [
        (DEPLOYER, files['deployer'], 0o700),
        (BACKUP, files['backup'], 0o755),
        (ARTIFACT_HELPER, files['artifact_helper'], 0o755),
        (SUDOERS, files['sudoers'], 0o440),
        (GATEWAY, files['gateway'], 0o755),
    ]
    original = {}
    for path, _, _ in destinations:
        try:
            info = path.lstat()
            require(stat.S_ISREG(info.st_mode) and info.st_uid == info.st_gid == 0
                    and info.st_nlink == 1 and not stat.S_ISLNK(info.st_mode),
                    'TOOLING_DESTINATION_INVALID')
            original[path] = (path.read_bytes(), stat.S_IMODE(info.st_mode))
        except FileNotFoundError:
            original[path] = None
    previous_state = None
    try:
        try:
            previous_state = (STATE.read_bytes(), stat.S_IMODE(STATE.stat().st_mode))
        except FileNotFoundError:
            previous_state = None
        for path, content, mode in destinations:
            atomic_install(path, content, mode)
        state = {
            'format_version': 1, 'tag': TARGET_TAG, 'revision': target_revision,
            'files': {'deployer': sha256(files['deployer']), 'backup': sha256(files['backup']),
                      'artifact_helper': sha256(files['artifact_helper']),
                      'sudoers': sha256(files['sudoers']), 'gateway': sha256(files['gateway'])},
        }
        atomic_install(STATE, (json.dumps(state, sort_keys=True, separators=(',', ':')) + '\n').encode(), 0o600)
        validate_state_file(target_revision)
    except BaseException:
        for path, _, _ in reversed(destinations):
            old = original[path]
            try:
                if old is None:
                    path.unlink(missing_ok=True)
                else:
                    atomic_install(path, old[0], old[1])
            except BaseException:
                pass
        try:
            if previous_state is None:
                STATE.unlink(missing_ok=True)
            else:
                atomic_install(STATE, previous_state[0], previous_state[1])
        except BaseException:
            pass
        raise
    print('V101_TOOLING_INSTALLED tag=' + TARGET_TAG + ' revision=' + target_revision
          + ' files=5 gateway_promoted_last=true', flush=True)


def interrupted(_signum, _frame):
    raise RuntimeError('V101_INTERRUPTED')


def main(args):
    require(os.geteuid() == 0, 'ROOT_REQUIRED')
    os.umask(0o077)
    HELPER.trusted('/root'); HELPER.trusted('/usr/bin'); HELPER.trusted('/usr/sbin')
    if args == ['--status']:
        state = validate_state_file()
        output = {'kind': 'V101_TOOLING_READY', 'tag': state['tag'],
                  'revision': state['revision'], 'files': state['files']}
        print(json.dumps(output, sort_keys=True, separators=(',', ':')))
        return
    require(len(args) == 3 and HEX40.fullmatch(args[1]) is not None, 'ARGUMENTS_INVALID')
    command, revision, confirmation = args
    fd = secure_lock()
    signal.signal(signal.SIGTERM, interrupted)
    try:
        if command == 'bootstrap':
            require(confirmation == 'CONFIRM_INSTALL_V101_TOOLING', 'BOOTSTRAP_CONFIRMATION_INVALID')
            install_bootstrap(revision)
            return
        require(command == 'deploy' and confirmation == 'CONFIRM_V101_WITH_BACKUP_AND_FULL_CI',
                'DEPLOY_CONFIRMATION_INVALID')
        state = validate_state_file(revision)
        require(sha256(Path(__file__).read_bytes()) == state['files']['deployer'], 'INSTALLED_TOOL_HASH_INVALID')
        host = HostDeployment(revision)
        host.preflight()
        deployment_flow(host)
    finally:
        os.close(fd)


if __name__ == '__main__':
    try:
        # Helper is pinned before loading any source-provided or host-controlled tooling.
        HELPER = load_helper()
        main(sys.argv[1:])
    except BaseException as error:
        message = str(error) if isinstance(error, RuntimeError) and re.fullmatch(r'V101_[A-Z0-9_]+', str(error)) else 'V101_UNEXPECTED_FAILURE'
        print(message, file=sys.stderr)
        sys.exit(1)
