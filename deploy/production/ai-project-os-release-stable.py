#!/usr/bin/python3
"""Root-only stable release and recovery gate with a one-time tooling bootstrap."""
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
RECOVERY_RECORD = Path('/var/lib/ai-project-os/recovery-v1.0.4.json')
RECOVERY_RECEIPT_ARCHIVE = Path('/var/lib/ai-project-os/last-deployment.pre-v1.0.4-recovery')
STATE = Path('/etc/ai-project-os/release-tooling-stable.json')
NGINX = Path('/etc/nginx/sites-available/ai-project-os.conf')
NGINX_ENABLED = Path('/etc/nginx/sites-enabled/ai-project-os.conf')
NGINX_SNIPPET = Path('/etc/nginx/snippets/ai-project-os-proxy.conf')
BACKUP = Path('/usr/local/sbin/ai-project-os-backup')
ARTIFACT_HELPER = Path('/usr/local/libexec/ai-project-os/backup-artifact.py')
DEPLOYER = Path('/usr/local/sbin/ai-project-os-release-stable')
GATEWAY = Path('/usr/local/sbin/ai-project-os-actions-gateway')
SUDOERS = Path('/etc/sudoers.d/ai-project-os-deploy')
BACKUP_SOURCE = 'deploy/production/ai-project-os-backup'
ARTIFACT_SOURCE = 'deploy/production/ai_project_os_backup_artifact.py'
DEPLOYER_SOURCE = 'deploy/production/ai-project-os-release-stable.py'
GATEWAY_SOURCE = 'deploy/production/ai-project-os-actions-gateway'
SUDOERS_SOURCE = 'deploy/production/ai-project-os-deploy.sudoers'
TOOLING_SOURCE_PATHS = {
    'deployer': DEPLOYER_SOURCE,
    'backup': BACKUP_SOURCE,
    'artifact_helper': ARTIFACT_SOURCE,
    'sudoers': SUDOERS_SOURCE,
    'gateway': GATEWAY_SOURCE,
}
HELPER_SOURCE = 'deploy/production/ai-project-os-v074-deploy.py'
INITIAL_SOURCE_TAG = 'v1.0.0'
INITIAL_SOURCE_REVISION = 'f57d050fffa445a6ef9eb3d7e692e6df06fac98d'
RECOVERY_SOURCE_TAG = 'v1.0.4'
RECOVERY_SOURCE_REVISION = 'b56db120a534fadf1fcf36beabcbe8c366903e45'
RECOVERY_POSTGRES_ID = '13e7c8f84a14f077b8d61ed7f6b5686c41fba0b78fff6dd6bdeed442fbfb912f'
RECOVERY_WRITERS = {
    'app': ('cce1b7aba7b9fe7b0064ec28785458bc988f5c44681f087eb2d95f1fc6841d9b',
            'sha256:0e96e0a0c4141ec287dd0b8561c5a21ab1e4de483992a5c63b2966da78ba7f0d'),
    'worker': ('81d864291e82effac25500103ba45a34b1a64636a2f4c64d4089af60064287f8',
               'sha256:005d4a78619039791012077c47907d537d0f1cfa6323382ee679d9aff27bd8e2'),
    'git-worker': ('bfe7d6307bb03044cff34681bfa0ace3709c4edbb850850a88652b84983bb518',
                   'sha256:d6843397e91f45d7f65b4053ebf4fb5ec676ff6b9bc6b03d3911df7b1d0c79d4'),
}
MINIMUM_MIGRATIONS = 143
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
BACKUP_NAME = re.compile(
    r'^[0-9]{8}T[0-9]{6}Z-pre-deploy-to-v(?:[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.[A-Za-z0-9]{6}$'
)
STABLE_TAG = re.compile(r'^v([1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$')
MIGRATION_NAME = re.compile(r'^\d{14}_[a-z0-9_]+$')
HEX64 = re.compile(r'^[a-f0-9]{64}$')
HEX40 = re.compile(r'^[a-f0-9]{40}$')
HELPER = None


def require(condition: bool, code: str) -> None:
    if not condition:
        raise RuntimeError('STABLE_' + code)


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


def stable_version(tag: str) -> tuple[int, int, int]:
    match = STABLE_TAG.fullmatch(tag)
    require(match is not None, 'STABLE_TAG_INVALID')
    return tuple(int(part) for part in match.groups())


def version_text(tag: str) -> str:
    stable_version(tag)
    return tag[1:]


def backup_name_pattern(target_tag: str):
    stable_version(target_tag)
    return re.compile(r'^[0-9]{8}T[0-9]{6}Z-pre-deploy-to-' + re.escape(target_tag)
                      + r'\.[A-Za-z0-9]{6}$')


def validate_transition(source_tag: str, source_revision: str, target_tag: str, target_revision: str) -> None:
    source_version = stable_version(source_tag)
    target_version = stable_version(target_tag)
    require(HEX40.fullmatch(source_revision) is not None
            and HEX40.fullmatch(target_revision) is not None, 'TRANSITION_REVISION_INVALID')
    if source_tag == INITIAL_SOURCE_TAG:
        require(source_revision == INITIAL_SOURCE_REVISION, 'INITIAL_SOURCE_REVISION_INVALID')
    same_release = target_tag == source_tag and target_revision == source_revision
    require(target_version > source_version or (same_release and source_tag != INITIAL_SOURCE_TAG),
            'TARGET_NOT_FORWARD_STABLE_RELEASE')
    require(target_tag != source_tag or same_release, 'TARGET_TAG_REVISION_MISMATCH')


def validate_manifest_delta(source: list[tuple[str, str]], target: list[tuple[str, str]]) -> None:
    source_names = [name for name, _ in source]
    target_names = [name for name, _ in target]
    require(len(source) >= MINIMUM_MIGRATIONS and len(target) >= len(source), 'MIGRATION_COUNT_INVALID')
    require(target[:len(source)] == source, 'MIGRATION_BASELINE_CHANGED')
    require(len(set(source_names)) == len(source) and len(set(target_names)) == len(target)
            and all(MIGRATION_NAME.fullmatch(name) for name in target_names)
            and all(HEX64.fullmatch(digest) for _, digest in target), 'MIGRATION_MANIFEST_INVALID')
    require(target_names == sorted(target_names), 'MIGRATION_ORDER_INVALID')


def migration_manifest_sha256(manifest: list[tuple[str, str]]) -> str:
    encoded = json.dumps(manifest, separators=(',', ':'), ensure_ascii=True).encode('ascii')
    return sha256(encoded)


def _classifier_git(repository, args):
    environment = {
        'PATH': '/usr/local/bin:/usr/bin:/bin',
        'HOME': '/nonexistent',
        'GIT_CONFIG_NOSYSTEM': '1',
        'GIT_CONFIG_GLOBAL': os.devnull,
        'GIT_OPTIONAL_LOCKS': '0',
        'GIT_NO_REPLACE_OBJECTS': '1',
        'LC_ALL': 'C.UTF-8',
    }
    result = subprocess.run(
        ['git', '--no-pager', '--literal-pathspecs', '-C', os.fspath(repository), *args],
        env=environment, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=False,
    )
    if result.returncode != 0:
        raise ValueError('git command failed')
    return result.stdout


def _classifier_entry_mode(repository, revision, path):
    raw = _classifier_git(repository, ['ls-tree', '-z', '--full-tree', revision, '--', path])
    records = [record for record in raw.split(b'\0') if record]
    if not records:
        return None
    if len(records) != 1:
        raise ValueError('ambiguous git tree entry')
    metadata, separator, raw_path = records[0].partition(b'\t')
    if not separator or raw_path.decode('utf-8', errors='strict') != path:
        raise ValueError('invalid git tree entry')
    parts = metadata.decode('ascii', errors='strict').split(' ')
    if len(parts) != 3:
        raise ValueError('invalid git tree metadata')
    return parts[0], parts[1]


def _classifier_blob(repository, revision, path):
    return _classifier_git(repository, ['show', revision + ':' + path])


def _replace_one_version(data, pattern):
    matches = list(pattern.finditer(data))
    if len(matches) != 1:
        return None, None
    match = matches[0]
    old = match.group(2)
    normalized = data[:match.start(2)] + b'<VERSION>' + data[match.end(2):]
    return old, normalized


def _stable_version_bytes(value):
    if value is None:
        return False
    try:
        text = value.decode('ascii')
    except UnicodeDecodeError:
        return False
    return re.fullmatch(r'[1-9][0-9]*\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)', text) is not None


def _is_version_only_change(repository, path, source_revision, target_revision):
    before = _classifier_blob(repository, source_revision, path)
    after = _classifier_blob(repository, target_revision, path)
    if path == 'package.json':
        pattern = re.compile(rb'(?m)^([ \t]*"version"[ \t]*:[ \t]*)"([^"\r\n]+)"([ \t]*,?[ \t]*\r?)$')
        source_version, source_normalized = _replace_one_version(before, pattern)
        target_version, target_normalized = _replace_one_version(after, pattern)
        try:
            source_json = json.loads(before)
            target_json = json.loads(after)
        except (UnicodeDecodeError, json.JSONDecodeError):
            return False
        if not isinstance(source_json, dict) or not isinstance(target_json, dict):
            return False
        source_copy = dict(source_json)
        target_copy = dict(target_json)
        source_copy.pop('version', None)
        target_copy.pop('version', None)
        return (source_version != target_version
                and _stable_version_bytes(source_version) and _stable_version_bytes(target_version)
                and source_normalized == target_normalized and source_copy == target_copy)
    if path == 'src/lib/version.ts':
        pattern = re.compile(rb'(APP_VERSION\s*=\s*")([^"\r\n]+)("\s+as\s+const;)')
        source_version, source_normalized = _replace_one_version(before, pattern)
        target_version, target_normalized = _replace_one_version(after, pattern)
        return (source_version != target_version
                and _stable_version_bytes(source_version) and _stable_version_bytes(target_version)
                and source_normalized == target_normalized)
    if path == 'Dockerfile':
        pattern = re.compile(rb'(org\.opencontainers\.image\.version=")([^"\r\n]+)(")')
        source_version, source_normalized = _replace_one_version(before, pattern)
        target_version, target_normalized = _replace_one_version(after, pattern)
        return (source_version != target_version
                and _stable_version_bytes(source_version) and _stable_version_bytes(target_version)
                and source_normalized == target_normalized)
    return False


def _risk_result(risk, reasons):
    return {
        'risk': risk,
        'databaseRequired': risk == 'high',
        'browserRequired': risk in ('medium', 'high'),
        'coverageRequired': risk in ('medium', 'high'),
        'reasons': reasons,
    }


def _sensitive_release_path(path):
    segments = re.split(r'[^a-z0-9]+', path.lower())
    sensitive = {
        'account', 'accounts', 'admin', 'admins', 'auth', 'authorization', 'billing',
        'agent', 'agents', 'captcha', 'credit', 'credits', 'email', 'entitlement', 'entitlements', 'login',
        'permission', 'permissions', 'phone', 'profile', 'provider', 'providers', 'recover',
        'register', 'registration', 'role', 'roles', 'security', 'semantic', 'session',
        'setup', 'signup', 'team', 'teams',
    }
    return any(segment in sensitive for segment in segments)


def _frontend_test_matches(path, frontend_sources):
    if not re.fullmatch(r'(?:test|tests|e2e)/.+\.(?:test|spec)\.tsx?', path):
        return False
    test_name = PurePosixPath(path).name
    test_stem = re.sub(r'\.(?:test|spec)\.tsx?$', '', test_name)
    source_names = set()
    for source in frontend_sources:
        parsed = PurePosixPath(source)
        source_names.add(parsed.stem)
        if parsed.parent.name not in ('app', 'components'):
            source_names.add(parsed.parent.name)
    return test_stem in source_names


def classify_release_risk(repository, source_revision, target_revision):
    """Classify a cumulative production source-to-target diff; any ambiguity fails high."""
    try:
        if (HEX40.fullmatch(source_revision) is None
                or HEX40.fullmatch(target_revision) is None):
            return _risk_result('high', ['invalid-revision'])
        for revision in (source_revision, target_revision):
            _classifier_git(repository, ['cat-file', '-e', revision + '^{commit}'])
        ancestry = subprocess.run(
            ['git', '--no-pager', '-C', os.fspath(repository), 'merge-base', '--is-ancestor',
             source_revision, target_revision],
            env={
                'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': '/nonexistent',
                'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': os.devnull,
                'GIT_OPTIONAL_LOCKS': '0', 'GIT_NO_REPLACE_OBJECTS': '1', 'LC_ALL': 'C.UTF-8',
            }, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False,
        )
        if ancestry.returncode != 0:
            return _risk_result('high', ['source-target-ancestry-invalid'])
        raw = _classifier_git(repository, [
            'diff', '--name-status', '-z', '--no-renames', '--no-ext-diff', '--no-textconv',
            source_revision, target_revision, '--',
        ])
        records = [record for record in raw.split(b'\0') if record]
        if not records:
            return _risk_result('low', ['no-changes'])
        changes = []
        index = 0
        while index < len(records):
            status = records[index].decode('ascii', errors='strict')
            index += 1
            if status not in ('A', 'M', 'D') or index >= len(records):
                return _risk_result('high', ['git-diff-entry-unknown'])
            path = records[index].decode('utf-8', errors='strict')
            index += 1
            if not path or path.startswith('/') or '\\' in path or PurePosixPath(path).is_absolute():
                return _risk_result('high', ['git-path-invalid'])
            changes.append((status, path))
        if index != len(records):
            return _risk_result('high', ['git-diff-entry-malformed'])

        frontend_sources = [
            path for _status, path in changes
            if (path.startswith('src/components/') and path.endswith('.tsx'))
            or (path.startswith('src/app/') and re.fullmatch(r'src/app/.+[^/]+-client\.tsx', path))
            or (path.endswith('.svg') and (path.startswith('public/') or path.startswith('src/components/')))
        ]
        has_medium = False
        reasons = []
        for status, path in changes:
            if (path.startswith(('src/lib/', 'src/app/api/', 'app/api/', 'prisma/', 'scripts/',
                                 '.github/', 'deploy/', 'config/'))
                    or path in ('next.config.ts', 'next.config.js', 'tsconfig.json', 'pnpm-lock.yaml',
                                'package-lock.json', 'yarn.lock', 'Dockerfile')):
                if path not in ('package.json', 'src/lib/version.ts', 'Dockerfile'):
                    return _risk_result('high', ['server-build-or-config-path'])
            source_mode = _classifier_entry_mode(repository, source_revision, path)
            target_mode = _classifier_entry_mode(repository, target_revision, path)
            if status == 'A':
                if source_mode is not None or target_mode not in (('100644', 'blob'), ('100755', 'blob')):
                    return _risk_result('high', ['git-file-type-unknown'])
            elif status == 'D':
                if target_mode is not None or source_mode not in (('100644', 'blob'), ('100755', 'blob')):
                    return _risk_result('high', ['git-file-type-unknown'])
            elif (source_mode not in (('100644', 'blob'), ('100755', 'blob'))
                  or target_mode not in (('100644', 'blob'), ('100755', 'blob'))
                  or source_mode != target_mode):
                return _risk_result('high', ['git-file-type-unknown'])

            if path in ('package.json', 'src/lib/version.ts', 'Dockerfile'):
                if not _is_version_only_change(repository, path, source_revision, target_revision):
                    return _risk_result('high', ['version-file-has-non-version-change'])
                reasons.append('version-only')
                continue

            if (path.endswith('.md') and (path.startswith('docs/') or path == 'README.md')
                    and PurePosixPath(path).name.lower() == 'agents.md'):
                return _risk_result('high', ['sensitive-path'])
            if path.endswith('.md') and (path.startswith('docs/') or path == 'README.md'):
                reasons.append('documentation')
                continue
            if path.startswith('src/') and path.endswith('.css'):
                reasons.append('stylesheet')
                continue
            if path.startswith('public/') and PurePosixPath(path).suffix.lower() in (
                '.png', '.jpg', '.jpeg', '.webp', '.ico', '.gif',
            ):
                reasons.append('public-bitmap')
                continue
            if _sensitive_release_path(path):
                return _risk_result('high', ['sensitive-path'])
            if ((path.startswith('src/components/') and path.endswith('.tsx'))
                    or (path.startswith('src/app/')
                        and re.fullmatch(r'src/app/.+[^/]+-client\.tsx', path))):
                has_medium = True
                reasons.append('frontend-tsx')
                continue
            if path.endswith('.svg') and (path.startswith('public/') or path.startswith('src/components/')):
                has_medium = True
                reasons.append('frontend-svg')
                continue
            if _frontend_test_matches(path, frontend_sources):
                has_medium = True
                reasons.append('matching-frontend-test')
                continue
            return _risk_result('high', ['unclassified-path'])
        return _risk_result('medium' if has_medium else 'low', sorted(set(reasons)))
    except (OSError, ValueError, UnicodeDecodeError, subprocess.SubprocessError, TypeError):
        return _risk_result('high', ['git-classification-error'])


def deployment_flow(ops, preflight_source=None) -> None:
    """Explicitly encode the one allowed rollback boundary for deterministic tests."""
    source = preflight_source if preflight_source is not None else ops.preflight()
    migration_started = False
    database_required = getattr(ops, 'database_required', True)
    try:
        ops.checkout_target()
        images = ops.build_target_images()
        ops.revalidate_source(source)
        ops.stop_nginx()
        ops.stop_source_writers(source)
        backup = ops.create_and_validate_backup(source)
        # Production releases keep the verified backup but skip the isolated drill.
        # Migration and failure boundaries below still apply to database releases.
        ops.install_and_test_target_nginx()
        if database_required:
            migration_started = True  # Set before the first migration process can run.
            ops.migrate(images)
            ops.reconcile(images)
        else:
            # Target writers may begin changing the shared database after this point.
            migration_started = True
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
    trusted(path)
    info = path.stat()
    require(stat.S_ISREG(info.st_mode) and stat.S_IMODE(info.st_mode) in (0o600, 0o644),
            'PINNED_HELPER_MODE_INVALID')
    content = path.read_bytes()
    require(sha256(content) == HELPER_SHA256, 'PINNED_HELPER_HASH_INVALID')
    spec = importlib.util.spec_from_file_location('ai_project_os_v074_pinned_helper', path)
    require(spec is not None and spec.loader is not None, 'PINNED_HELPER_LOAD_FAILED')
    module = importlib.util.module_from_spec(spec)
    sys.dont_write_bytecode = True
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


def _ci_runs(revision, event):
    api = 'https://api.github.com/repos/Jack-Kunlun/ai-project-os/actions'
    payload = request_json(api + '/workflows/ci.yml/runs?event=' + event + '&status=success&head_sha='
                           + revision + '&per_page=100')
    return [item for item in payload.get('workflow_runs', [])
            if item.get('head_sha') == revision and item.get('event') == event
            and item.get('status') == 'completed' and item.get('conclusion') == 'success']


def _run_has_jobs(run, required_names):
    run_id = run.get('id')
    require(isinstance(run_id, int) and run_id > 0, 'CI_RUN_ID_INVALID')
    api = 'https://api.github.com/repos/Jack-Kunlun/ai-project-os/actions'
    jobs = request_json(api + '/runs/' + str(run_id) + '/jobs?per_page=100').get('jobs', [])
    successful = {job.get('name') for job in jobs if job.get('conclusion') == 'success'}
    return set(required_names).issubset(successful)


def require_ci(target_tag, revision, bootstrap=False, source_revision=None, classification=None):
    main_runs = [run for run in _ci_runs(revision, 'push')
                 if run.get('head_branch') == 'main' and run.get('head_sha') == revision
                 and run.get('event') == 'push' and run.get('status') == 'completed'
                 and run.get('conclusion') == 'success']
    if bootstrap:
        require(any(_run_has_jobs(run, ('Verify database and release candidate',)) for run in main_runs),
                'EXACT_MAIN_FULL_CI_REQUIRED')
        return

    require(source_revision is not None and HEX40.fullmatch(source_revision) is not None,
            'RELEASE_CI_BASE_INVALID')
    if classification is None:
        classification = classify_release_risk(ROOT, source_revision, revision)
    risk = classification.get('risk')
    require(risk in ('low', 'medium', 'high')
            and type(classification.get('databaseRequired')) is bool
            and type(classification.get('browserRequired')) is bool
            and type(classification.get('coverageRequired')) is bool,
            'RELEASE_CI_CLASSIFICATION_INVALID')
    require(classification['databaseRequired'] == (risk == 'high')
            and classification['browserRequired'] == (risk in ('medium', 'high'))
            and classification['coverageRequired'] == (risk in ('medium', 'high')),
            'RELEASE_CI_CLASSIFICATION_INVALID')
    tiers = {'low': 0, 'medium': 1, 'high': 2}
    for attested_risk in ('low', 'medium', 'high'):
        if tiers[attested_risk] < tiers[risk]:
            continue
        attestation = (f'Verify internal delivery gates [risk={attested_risk} '
                       f'base={source_revision}]')
        required_jobs = ['Verify source and client', attestation]
        if attested_risk == 'high':
            required_jobs.append('Verify database and release candidate')
        elif attested_risk == 'medium':
            required_jobs.append('Verify browser and release client')
        if any(_run_has_jobs(run, required_jobs) for run in main_runs):
            return
    require(False, 'EXACT_MAIN_APPLICABLE_CI_REQUIRED')


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


def fetch_main(target_revision):
    trusted(ROOT); trusted(ROOT / '.git')
    require(git(['remote', 'get-url', 'origin']) == REMOTE, 'REMOTE_INVALID')
    require(git(['status', '--porcelain', '--untracked-files=all']) == '', 'MANAGED_CHECKOUT_DIRTY')
    git(['fetch', '--no-tags', 'origin',
         '+refs/heads/main:refs/remotes/origin/main'])
    require(git(['rev-parse', 'refs/remotes/origin/main']) == target_revision,
            'ORIGIN_MAIN_REVISION_MISMATCH')


def fetch_target(target_tag, target_revision):
    fetch_main(target_revision)
    git(['fetch', '--no-tags', 'origin', '+refs/tags/' + target_tag + ':refs/tags/' + target_tag])
    require(git(['cat-file', '-t', 'refs/tags/' + target_tag]) == 'tag', 'TAG_NOT_ANNOTATED')
    require(git(['rev-parse', 'refs/tags/' + target_tag + '^{}']) == target_revision,
            'TAG_REVISION_MISMATCH')


def require_ancestor(source_revision, target_revision):
    try:
        git(['merge-base', '--is-ancestor', source_revision, target_revision])
    except RuntimeError:
        require(False, 'RELEASE_ANCESTRY_INVALID')


def verify_prior_stable_tag(result, current_revision):
    prior_tag = result['source_tag']
    prior_revision = result['source_revision']
    require(git(['cat-file', '-t', 'refs/tags/' + prior_tag]) == 'tag',
            'PRIOR_SOURCE_TAG_NOT_ANNOTATED')
    require(git(['rev-parse', 'refs/tags/' + prior_tag + '^{}']) == prior_revision,
            'PRIOR_SOURCE_TAG_REVISION_MISMATCH')
    require_ancestor(prior_revision, current_revision)


def source_manifest(root=ROOT):
    base = root / 'prisma/migrations'
    require(base.is_dir() and not base.is_symlink(), 'MIGRATION_DIRECTORY_INVALID')
    directories = sorted(path for path in base.iterdir() if path.is_dir() and not path.is_symlink())
    require(all(MIGRATION_NAME.fullmatch(path.name) for path in directories),
            'MIGRATION_NAME_INVALID')
    result = []
    for directory in directories:
        migration = directory / 'migration.sql'
        require(migration.is_file() and not migration.is_symlink(), 'MIGRATION_SQL_MISSING')
        result.append((directory.name, sha256(migration.read_bytes())))
    return result


def git_tree_entries(revision_path):
    raw = git_raw(['ls-tree', '-z', revision_path])
    entries = []
    for record in raw.split(b'\0'):
        if not record:
            continue
        metadata, separator, raw_name = record.partition(b'\t')
        require(bool(separator), 'MIGRATION_TREE_ENTRY_INVALID')
        try:
            mode, object_type, object_id = metadata.decode('ascii').split(' ')
            name = raw_name.decode('utf-8')
        except (UnicodeDecodeError, ValueError):
            require(False, 'MIGRATION_TREE_ENTRY_INVALID')
        require(re.fullmatch(r'(?:[0-9a-f]{40}|[0-9a-f]{64})', object_id) is not None,
                'MIGRATION_TREE_ENTRY_INVALID')
        entries.append((mode, object_type, object_id, name))
    return entries


def git_manifest(revision):
    root_path = revision + ':prisma/migrations'
    entries = git_tree_entries(root_path)
    lock_entries = [entry for entry in entries if entry[3] == 'migration_lock.toml']
    require(len(lock_entries) == 1 and lock_entries[0][:2] == ('100644', 'blob'),
            'MIGRATION_LOCK_INVALID')
    lock_content = git_raw(['cat-file', 'blob', lock_entries[0][2]])
    source_lock = git_raw(['show', INITIAL_SOURCE_REVISION + ':prisma/migrations/migration_lock.toml'])
    require(lock_content == source_lock and sha256(lock_content) == sha256(source_lock),
            'MIGRATION_LOCK_INVALID')

    migrations = []
    for mode, object_type, _object_id, name in entries:
        if name == 'migration_lock.toml':
            continue
        require(MIGRATION_NAME.fullmatch(name) is not None, 'MIGRATION_NAME_INVALID')
        require(mode == '040000' and object_type == 'tree', 'MIGRATION_ENTRY_TYPE_INVALID')
        children = git_tree_entries(root_path + '/' + name)
        require(len(children) == 1 and children[0][0] == '100644'
                and children[0][1] == 'blob' and children[0][3] == 'migration.sql',
                'MIGRATION_SQL_LAYOUT_INVALID')
        content = git_raw(['cat-file', 'blob', children[0][2]])
        migrations.append((name, sha256(content)))
    require(bool(lock_entries), 'MIGRATION_LOCK_INVALID')
    return migrations


def git_blob(revision, path):
    return git_raw(['show', revision + ':' + path])


def validate_target_tree(revision, source, target_tag):
    target_version = version_text(target_tag)
    package = json.loads(git_blob(revision, 'package.json'))
    version_source = git_blob(revision, 'src/lib/version.ts').decode('utf-8')
    dockerfile = git_blob(revision, 'Dockerfile').decode('utf-8')
    release_notes = git_blob(revision, 'docs/releases/' + target_tag + '.md').decode('utf-8')
    require(package.get('version') == target_version, 'PACKAGE_VERSION_INVALID')
    require(re.search(r'APP_VERSION\s*=\s*"' + re.escape(target_version) + r'"', version_source) is not None,
            'APP_VERSION_INVALID')
    require(len(re.findall(r'org\.opencontainers\.image\.version="' + re.escape(target_version) + r'"', dockerfile)) == 1,
            'OCI_VERSION_INVALID')
    require(release_notes.startswith('# ' + target_tag + ' — '), 'RELEASE_NOTES_INVALID')
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
    require(b'TARGET_TAG' in backup and b'pre-deploy' in backup and b'email-auth.env' in backup,
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
    with tempfile.TemporaryDirectory(prefix='.stable-sudoers-validate-', dir=directory) as temporary:
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


def parse_record_text(text):
    lines = text.splitlines()
    values = {}
    if lines and lines[0] in ('DEPLOY_OK', 'RECOVERY_OK'):
        values['status'] = lines.pop(0)
    for line in lines:
        if not line:
            continue
        require('=' in line, 'RECORD_INVALID')
        key, value = line.split('=', 1)
        require(re.fullmatch(r'[a-z][a-z0-9_]*', key) is not None and key not in values,
                'RECORD_INVALID')
        values[key] = value
    return values


def parse_record(path):
    return parse_record_text(Path(path).read_text(encoding='utf-8'))


def _unique_json_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'RECOVERY_JSON_DUPLICATE_KEY')
        result[key] = value
    return result


def _read_trusted_host_file(path, mode, max_bytes, code):
    path = Path(path)
    HELPER.trusted(path.parent)
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | getattr(os, 'O_CLOEXEC', 0))
    except FileNotFoundError:
        raise
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == info.st_gid == 0
                and info.st_nlink == 1 and stat.S_IMODE(info.st_mode) == mode
                and 0 < info.st_size <= max_bytes, code)
        chunks = []
        total = 0
        while True:
            chunk = os.read(fd, min(65536, max_bytes + 1 - total))
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
            require(total <= max_bytes, code)
        require(total == info.st_size, code)
        return b''.join(chunks)
    finally:
        os.close(fd)


def _recovery_health_shape(value):
    return (isinstance(value, dict) and value.get('status') == 'ok'
            and value.get('version') == '1.0.4' and value.get('database') == 'up'
            and isinstance(value.get('worker'), dict)
            and value['worker'].get('status') == 'up'
            and value['worker'].get('consecutiveFailures') == 0)


def validate_v104_recovery_record(record):
    expected_keys = {'kind', 'tag', 'revision', 'migrationCount', 'postgresId', 'writers',
                     'nginxMode', 'configHashes', 'health', 'previousDeploymentReceiptUnmodified',
                     'workflowPublicationCompleted', 'completedAt'}
    require(isinstance(record, dict) and set(record) == expected_keys
            and record.get('kind') == 'V104_RUNTIME_RECOVERY_OK'
            and record.get('tag') == RECOVERY_SOURCE_TAG
            and record.get('revision') == RECOVERY_SOURCE_REVISION
            and type(record.get('migrationCount')) is int and record['migrationCount'] == 146
            and record.get('postgresId') == RECOVERY_POSTGRES_ID
            and record.get('nginxMode') == '0644'
            and record.get('previousDeploymentReceiptUnmodified') is True
            and record.get('workflowPublicationCompleted') is False
            and isinstance(record.get('completedAt'), str)
            and re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z', record['completedAt']) is not None,
            'RECOVERY_RECORD_INVALID')
    expected_writers = {
        service: {'id': identity, 'imageId': image}
        for service, (identity, image) in RECOVERY_WRITERS.items()
    }
    require(record.get('writers') == expected_writers, 'RECOVERY_RECORD_WRITERS_INVALID')
    hashes = record.get('configHashes')
    require(isinstance(hashes, dict) and set(hashes) == set(CONFIG_PATHS)
            and all(isinstance(value, str) and HEX64.fullmatch(value) is not None
                    for value in hashes.values()), 'RECOVERY_RECORD_CONFIG_HASHES_INVALID')
    health = record.get('health')
    require(isinstance(health, dict) and set(health) == {'local', 'public'}
            and _recovery_health_shape(health['local'])
            and _recovery_health_shape(health['public']), 'RECOVERY_RECORD_HEALTH_INVALID')
    return record


def read_v104_recovery_record():
    raw = _read_trusted_host_file(RECOVERY_RECORD, 0o600, 256 * 1024,
                                  'RECOVERY_RECORD_FILE_INVALID')
    try:
        record = json.loads(raw.decode('utf-8'), object_pairs_hook=_unique_json_object)
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
        require(False, 'RECOVERY_RECORD_JSON_INVALID')
    validate_v104_recovery_record(record)
    return record, sha256(raw)


def validate_runtime_snapshot_shape(snapshot):
    count_keys = {'AppUser', 'PersonalKnowledgeDocument', 'PersonalKnowledgeSemanticChallenge',
                  'PersonalKnowledgeSemanticAudit', 'PlatformTokenGrant', 'PlatformTokenReservation',
                  'PlatformTokenLedgerEntry', 'AccountEntitlementActivation'}
    require(isinstance(snapshot, dict) and set(snapshot) == {'counts', 'activeOffers', 'activeEmbeddingRoutes'}
            and isinstance(snapshot.get('counts'), dict)
            and set(snapshot['counts']) == count_keys
            and all(type(value) is int and value >= 0 for value in snapshot['counts'].values())
            and isinstance(snapshot.get('activeOffers'), list)
            and all(isinstance(item, dict) for item in snapshot['activeOffers'])
            and isinstance(snapshot.get('activeEmbeddingRoutes'), list)
            and all(isinstance(item, dict) for item in snapshot['activeEmbeddingRoutes']),
            'RECOVERY_RUNTIME_SNAPSHOT_INVALID')
    return snapshot


def _strict_json_value(value, code):
    try:
        return json.loads(value, object_pairs_hook=_unique_json_object)
    except (TypeError, json.JSONDecodeError, ValueError):
        require(False, code)


def _previous_receipt_is_v100(data):
    try:
        result = parse_record_text(data.decode('utf-8'))
    except UnicodeDecodeError:
        require(False, 'RECOVERY_PREVIOUS_RECEIPT_INVALID')
    require(result.get('status') == 'DEPLOY_OK'
            and result.get('tag') == INITIAL_SOURCE_TAG
            and result.get('revision') == INITIAL_SOURCE_REVISION
            and 'release_protocol' not in result,
            'RECOVERY_PREVIOUS_RECEIPT_INVALID')
    return result


def find_v104_recovery_backup(current_email_bytes):
    backup_root = Path('/var/backups/ai-project-os')
    HELPER.trusted(backup_root)
    pattern = backup_name_pattern(RECOVERY_SOURCE_TAG)
    candidates = [entry for entry in backup_root.iterdir() if pattern.fullmatch(entry.name)]
    require(len(candidates) == 1, 'RECOVERY_BACKUP_AMBIGUOUS')
    path = candidates[0]
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode),
            'RECOVERY_BACKUP_DIRECTORY_INVALID')
    marker = parse_record(path / '.cos-upload-verified')
    require(set(marker) == {'status', 'verified_at', 'archive_object', 'checksum_object',
                            'manifest_object', 'latest_manifest_object', 'archive_sha256'}
            and marker.get('status') == 'COS_UPLOAD_VERIFIED'
            and marker.get('checksum_object') == marker.get('archive_object', '') + '.sha256'
            and re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})',
                             marker.get('verified_at', '')) is not None,
            'RECOVERY_BACKUP_MARKER_INVALID')
    line = ('BACKUP_OK reason=pre-deploy-to-v1.0.4 retention_removed=0 source_quiesced=true'
            + ' source=' + str(path)
            + ' object=' + marker['archive_object']
            + ' verified_manifest=' + marker['manifest_object']
            + ' manifest=' + marker['latest_manifest_object']
            + ' sha256=' + marker['archive_sha256'])
    backup = verify_backup_output(line, RECOVERY_SOURCE_TAG)
    validate_local_backup(backup, current_email_bytes, RECOVERY_SOURCE_TAG, '1.0.0')
    return backup


def validate_v104_recovery_source_receipt(result, recovery_record, recovery_digest,
                                         backup, previous_receipt_bytes, manifest):
    expected_keys = {'status', 'tag', 'revision', 'source_tag', 'source_revision', 'release_protocol',
                     'migration_count', 'migration_manifest_sha256', 'recovery_record_sha256',
                     'recovery_completed_at', 'recovery_backup_name', 'recovery_backup_object',
                     'recovery_backup_verified_manifest', 'recovery_backup_sha256',
                     'previous_receipt_sha256', 'current_runtime_config_hashes',
                     'current_runtime_snapshot', 'workflow_publication_completed', 'completed_at'}
    require(isinstance(result, dict) and set(result) == expected_keys
            and result.get('status') == 'RECOVERY_OK'
            and result.get('tag') == RECOVERY_SOURCE_TAG
            and result.get('revision') == RECOVERY_SOURCE_REVISION
            and result.get('source_tag') == INITIAL_SOURCE_TAG
            and result.get('source_revision') == INITIAL_SOURCE_REVISION
            and result.get('release_protocol') == 'stable-v1-recovery'
            and result.get('migration_count') == '146'
            and result.get('migration_manifest_sha256') == migration_manifest_sha256(manifest)
            and result.get('recovery_record_sha256') == recovery_digest
            and result.get('recovery_completed_at') == recovery_record['completedAt']
            and result.get('recovery_backup_name') == backup['name']
            and result.get('recovery_backup_object') == backup['object']
            and result.get('recovery_backup_verified_manifest') == backup['verified_manifest']
            and result.get('recovery_backup_sha256') == backup['sha256']
            and result.get('previous_receipt_sha256') == sha256(previous_receipt_bytes)
            and result.get('workflow_publication_completed') == 'false'
            and isinstance(result.get('completed_at'), str)
            and re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z', result['completed_at']) is not None,
            'RECOVERY_SOURCE_RECEIPT_INVALID')
    _previous_receipt_is_v100(previous_receipt_bytes)
    config_hashes_value = _strict_json_value(result['current_runtime_config_hashes'],
                                             'RECOVERY_SOURCE_CONFIG_HASHES_INVALID')
    require(config_hashes_value == recovery_record['configHashes'],
            'RECOVERY_SOURCE_CONFIG_HASHES_INVALID')
    snapshot = validate_runtime_snapshot_shape(
        _strict_json_value(result['current_runtime_snapshot'], 'RECOVERY_RUNTIME_SNAPSHOT_INVALID'))
    validate_default_signup_policy(snapshot)
    return snapshot


def _recovery_source_receipt_text(recovery_record, recovery_digest, backup,
                                  previous_receipt_bytes, manifest, config_hashes_value,
                                  current_snapshot):
    record = {
        'tag': RECOVERY_SOURCE_TAG,
        'revision': RECOVERY_SOURCE_REVISION,
        'source_tag': INITIAL_SOURCE_TAG,
        'source_revision': INITIAL_SOURCE_REVISION,
        'release_protocol': 'stable-v1-recovery',
        'migration_count': '146',
        'migration_manifest_sha256': migration_manifest_sha256(manifest),
        'recovery_record_sha256': recovery_digest,
        'recovery_completed_at': recovery_record['completedAt'],
        'recovery_backup_name': backup['name'],
        'recovery_backup_object': backup['object'],
        'recovery_backup_verified_manifest': backup['verified_manifest'],
        'recovery_backup_sha256': backup['sha256'],
        'previous_receipt_sha256': sha256(previous_receipt_bytes),
        'current_runtime_config_hashes': config_hashes_value,
        'current_runtime_snapshot': current_snapshot,
        'workflow_publication_completed': False,
        'completed_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
    }
    plain_keys = {'tag', 'revision', 'source_tag', 'source_revision', 'release_protocol',
                  'migration_count', 'migration_manifest_sha256', 'recovery_record_sha256',
                  'recovery_completed_at', 'recovery_backup_name', 'recovery_backup_object',
                  'recovery_backup_verified_manifest', 'recovery_backup_sha256',
                  'previous_receipt_sha256', 'completed_at'}
    return ('RECOVERY_OK\n' + ''.join(
        key + '=' + (value if key in plain_keys else
                     json.dumps(value, separators=(',', ':'), sort_keys=True)) + '\n'
        for key, value in record.items())).encode('utf-8')


def _archive_previous_v100_receipt(previous_receipt_bytes):
    _previous_receipt_is_v100(previous_receipt_bytes)
    try:
        archived = _read_trusted_host_file(RECOVERY_RECEIPT_ARCHIVE, 0o600, 256 * 1024,
                                           'RECOVERY_RECEIPT_ARCHIVE_INVALID')
    except FileNotFoundError:
        atomic_install(RECOVERY_RECEIPT_ARCHIVE, previous_receipt_bytes, 0o600)
        archived = _read_trusted_host_file(RECOVERY_RECEIPT_ARCHIVE, 0o600, 256 * 1024,
                                           'RECOVERY_RECEIPT_ARCHIVE_INVALID')
    require(archived == previous_receipt_bytes, 'RECOVERY_RECEIPT_ARCHIVE_CONFLICT')
    return archived


def validate_v104_recovery_runtime_evidence(record, manifest, postgres, writers,
                                            config_hashes_value, nginx_bytes, expected_nginx_bytes,
                                            local_health, public_health, backup):
    validate_v104_recovery_record(record)
    require(len(manifest) == 146, 'RECOVERY_MIGRATION_MANIFEST_INVALID')
    validate_manifest_delta(manifest, manifest)
    require(postgres.get('Id') == RECOVERY_POSTGRES_ID
            and postgres.get('Config', {}).get('Image') == IMAGE
            and postgres.get('State', {}).get('Running') is True
            and postgres.get('State', {}).get('Paused') is not True
            and postgres.get('State', {}).get('Health', {}).get('Status') == 'healthy',
            'RECOVERY_POSTGRES_INVALID')
    bindings = postgres.get('NetworkSettings', {}).get('Ports', {}).get('5432/tcp')
    require(isinstance(bindings, list) and len(bindings) == 1
            and bindings[0].get('HostIp') == '127.0.0.1', 'DATABASE_NOT_ISOLATED')
    require(len(writers) == 3, 'RECOVERY_WRITER_INVALID')
    expected_writer_record = {}
    for service, writer in zip(('app', 'worker', 'git-worker'), writers):
        identifier, image = RECOVERY_WRITERS[service]
        labels = writer.get('Config', {}).get('Labels') or {}
        require(writer.get('Id') == identifier and writer.get('Image') == image
                and labels.get('com.docker.compose.project') == PROJECT
                and labels.get('com.docker.compose.service') == service
                and labels.get('org.opencontainers.image.version') == '1.0.4'
                and writer.get('State', {}).get('Running') is True
                and writer.get('State', {}).get('Paused') is not True
                and writer.get('State', {}).get('Health', {}).get('Status') == 'healthy',
                'RECOVERY_WRITER_INVALID')
        expected_writer_record[service] = {'id': identifier, 'imageId': image}
    require(record['writers'] == expected_writer_record
            and record['postgresId'] == postgres['Id'], 'RECOVERY_RECORD_RUNTIME_MISMATCH')
    require(config_hashes_value == record['configHashes'], 'RECOVERY_CONFIG_HASHES_CHANGED')
    require(nginx_bytes == expected_nginx_bytes and record['nginxMode'] == '0644',
            'RECOVERY_NGINX_BYTES_INVALID')
    require(_recovery_health_shape(local_health) and _recovery_health_shape(public_health),
            'RECOVERY_HEALTH_INVALID')
    require(isinstance(backup, dict)
            and backup_name_pattern(RECOVERY_SOURCE_TAG).fullmatch(backup.get('name', '')) is not None
            and isinstance(backup.get('path'), Path)
            and backup['path'].parent == Path('/var/backups/ai-project-os')
            and HEX64.fullmatch(backup.get('sha256', '')) is not None,
            'RECOVERY_BACKUP_INVALID')
    return True


def verify_v104_recovery_runtime():
    recovery_record, recovery_digest = read_v104_recovery_record()
    HELPER.trusted(ROOT); HELPER.trusted(ROOT / '.git')
    require(git(['remote', 'get-url', 'origin']) == REMOTE
            and git(['status', '--porcelain', '--untracked-files=all']) == '',
            'RECOVERY_CHECKOUT_INVALID')
    require(git(['rev-parse', 'HEAD']) == RECOVERY_SOURCE_REVISION,
            'RECOVERY_CHECKOUT_REVISION_INVALID')
    require(git(['cat-file', '-t', 'refs/tags/' + RECOVERY_SOURCE_TAG]) == 'tag'
            and git(['rev-parse', 'refs/tags/' + RECOVERY_SOURCE_TAG + '^{}']) == RECOVERY_SOURCE_REVISION,
            'RECOVERY_SOURCE_TAG_INVALID')
    package = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))
    require(package.get('version') == '1.0.4', 'RECOVERY_PACKAGE_VERSION_INVALID')
    env = env_values()
    hashes = config_hashes()
    require(hashes == recovery_record['configHashes'], 'RECOVERY_CONFIG_HASHES_CHANGED')
    nginx_bytes = NGINX.read_bytes()
    require(nginx_bytes == git_blob(RECOVERY_SOURCE_REVISION,
                                    'deploy/production/nginx/ai-project-os.conf'),
            'RECOVERY_NGINX_BYTES_INVALID')
    enabled_info = NGINX_ENABLED.lstat()
    require(stat.S_ISLNK(enabled_info.st_mode) and enabled_info.st_uid == enabled_info.st_gid == 0
            and NGINX_ENABLED.resolve() == NGINX, 'NGINX_ENABLED_PATH_INVALID')
    HELPER.run(['systemctl', 'is-active', '--quiet', 'nginx'])
    postgres = container('postgres')
    require(postgres['Id'] == RECOVERY_POSTGRES_ID
            and postgres['Config'].get('Image') == IMAGE
            and postgres['State'].get('Running') and not postgres['State'].get('Paused')
            and postgres['State'].get('Health', {}).get('Status') == 'healthy',
            'RECOVERY_POSTGRES_INVALID')
    bindings = postgres['NetworkSettings']['Ports'].get('5432/tcp')
    require(isinstance(bindings, list) and len(bindings) == 1
            and bindings[0]['HostIp'] == '127.0.0.1', 'DATABASE_NOT_ISOLATED')
    writers = [container(service) for service in ('app', 'worker', 'git-worker')]
    for service, writer in zip(('app', 'worker', 'git-worker'), writers):
        identifier, image = RECOVERY_WRITERS[service]
        labels = writer['Config'].get('Labels') or {}
        require(writer['Id'] == identifier and writer['Image'] == image
                and labels.get('com.docker.compose.project') == PROJECT
                and labels.get('com.docker.compose.service') == service
                and labels.get('org.opencontainers.image.version') == '1.0.4'
                and writer['State'].get('Running') and not writer['State'].get('Paused')
                and writer['State'].get('Health', {}).get('Status') == 'healthy',
                'RECOVERY_WRITER_INVALID')
    manifest = source_manifest()
    require(len(manifest) == 146 and git_manifest(RECOVERY_SOURCE_REVISION) == manifest,
            'RECOVERY_MIGRATION_MANIFEST_INVALID')
    migration_ledger(RECOVERY_POSTGRES_ID, manifest)
    snapshot = readonly_database_snapshot(RECOVERY_POSTGRES_ID)
    validate_runtime_snapshot_shape(snapshot)
    validate_default_signup_policy(snapshot)
    local_health = HELPER.healthy('1.0.4')
    public_health = HELPER.healthy('1.0.4', public=True)
    require(_recovery_health_shape(local_health) and _recovery_health_shape(public_health),
            'RECOVERY_HEALTH_INVALID')
    backup = find_v104_recovery_backup(EMAIL_ENV.read_bytes())
    validate_v104_recovery_runtime_evidence(
        recovery_record, manifest, postgres, writers, hashes, nginx_bytes,
        git_blob(RECOVERY_SOURCE_REVISION, 'deploy/production/nginx/ai-project-os.conf'),
        local_health, public_health, backup)
    return {
        'recovery_record': recovery_record,
        'recovery_digest': recovery_digest,
        'backup': backup,
        'manifest': manifest,
        'config_hashes': hashes,
        'database_snapshot': snapshot,
        'postgres_id': postgres['Id'],
        'writers': writers,
        'writer_ids': {service: writer['Id'] for service, writer in zip(('app', 'worker', 'git-worker'), writers)},
        'writer_images': {service: writer['Image'] for service, writer in zip(('app', 'worker', 'git-worker'), writers)},
        'local_health': local_health,
        'public_health': public_health,
        'env': env,
        'nginx_before': nginx_bytes,
    }


def v104_recovery_source_runtime_state(result):
    runtime = verify_v104_recovery_runtime()
    try:
        previous_receipt_bytes = _read_trusted_host_file(
            RECOVERY_RECEIPT_ARCHIVE, 0o600, 256 * 1024, 'RECOVERY_RECEIPT_ARCHIVE_INVALID')
    except FileNotFoundError:
        require(False, 'RECOVERY_RECEIPT_ARCHIVE_MISSING')
    _previous_receipt_is_v100(previous_receipt_bytes)
    validate_v104_recovery_source_receipt(
        result, runtime['recovery_record'], runtime['recovery_digest'], runtime['backup'],
        previous_receipt_bytes, runtime['manifest'])
    return {
        'tag': RECOVERY_SOURCE_TAG,
        'revision': RECOVERY_SOURCE_REVISION,
        'version': '1.0.4',
        'receipt': result,
        'postgres_id': runtime['postgres_id'],
        'writers': runtime['writers'],
        'writer_ids': runtime['writer_ids'],
        'writer_images': runtime['writer_images'],
        'source_manifest': runtime['manifest'],
        'config_hashes': runtime['config_hashes'],
        'database_snapshot': runtime['database_snapshot'],
        'local_health': runtime['local_health'],
        'public_health': runtime['public_health'],
        'env': runtime['env'],
        'nginx_before': runtime['nginx_before'],
        'source_tag': RECOVERY_SOURCE_TAG,
        'source_revision': RECOVERY_SOURCE_REVISION,
    }


def reconcile_v104_recovery_receipt(previous_receipt_bytes):
    _previous_receipt_is_v100(previous_receipt_bytes)
    current_receipt_bytes = _read_trusted_host_file(RESULT, 0o600, 256 * 1024,
                                                   'RECOVERY_CURRENT_RECEIPT_INVALID')
    require(current_receipt_bytes == previous_receipt_bytes,
            'RECOVERY_CURRENT_RECEIPT_CHANGED')
    runtime = verify_v104_recovery_runtime()
    receipt_bytes = _recovery_source_receipt_text(
        runtime['recovery_record'], runtime['recovery_digest'], runtime['backup'],
        previous_receipt_bytes, runtime['manifest'], runtime['config_hashes'],
        runtime['database_snapshot'])
    try:
        receipt_text = receipt_bytes.decode('utf-8')
        typed_receipt = parse_record_text(receipt_text)
    except UnicodeDecodeError:
        require(False, 'RECOVERY_SOURCE_RECEIPT_INVALID')
    _archive_previous_v100_receipt(previous_receipt_bytes)
    atomic_install(RESULT, receipt_bytes, 0o600)
    try:
        return v104_recovery_source_runtime_state(typed_receipt)
    except BaseException:
        atomic_install(RESULT, previous_receipt_bytes, 0o600)
        raise


def validate_source_restore_receipt(result, manifest):
    restore = json.loads(result.get('restore_drill', 'null'))
    require(isinstance(restore, dict), 'SOURCE_RECEIPT_RESTORE_INVALID')
    if restore.get('required') is False:
        require(set(restore) == {'required', 'reason', 'source_migration_count',
                                 'target_migration_count'}
                and restore.get('reason') in ('no-database-change', 'disabled-by-release-policy')
                and type(restore.get('source_migration_count')) is int
                and type(restore.get('target_migration_count')) is int
                and restore['target_migration_count'] == len(manifest)
                and result.get('migration_manifest_sha256') == migration_manifest_sha256(manifest),
                'SOURCE_RECEIPT_RESTORE_INVALID')
        if restore['reason'] == 'no-database-change':
            require(restore['source_migration_count'] == len(manifest),
                    'SOURCE_RECEIPT_RESTORE_INVALID')
        else:
            require(MINIMUM_MIGRATIONS <= restore['source_migration_count'] <= len(manifest),
                    'SOURCE_RECEIPT_RESTORE_INVALID')
    else:
        require(type(restore.get('source_migration_count')) is int
                and type(restore.get('target_migration_count')) is int
                and restore['source_migration_count'] >= MINIMUM_MIGRATIONS
                and restore['target_migration_count'] == len(manifest),
                'SOURCE_RECEIPT_RESTORE_INVALID')
    return restore


def source_runtime_state(require_checkout=True):
    HELPER.trusted(RESULT, 0o600)
    result = parse_record(RESULT)
    if result.get('status') == 'RECOVERY_OK':
        require(require_checkout, 'RECOVERY_SOURCE_CHECKOUT_REQUIRED')
        return v104_recovery_source_runtime_state(result)
    source_tag = result.get('tag', '')
    source_revision = result.get('revision', '')
    source_version = version_text(source_tag)
    require(result.get('status') == 'DEPLOY_OK' and HEX40.fullmatch(source_revision) is not None,
            'SOURCE_RECEIPT_INVALID')
    if source_tag == INITIAL_SOURCE_TAG:
        require(source_revision == INITIAL_SOURCE_REVISION and 'release_protocol' not in result,
                'INITIAL_SOURCE_RECEIPT_INVALID')
    else:
        require(result.get('release_protocol') == 'stable-v1', 'STABLE_SOURCE_RECEIPT_INVALID')
        stable_version(result.get('source_tag', ''))
        require(HEX40.fullmatch(result.get('source_revision', '')) is not None
                and stable_version(result['source_tag']) < stable_version(source_tag),
                'STABLE_SOURCE_RECEIPT_INVALID')
    require(not require_checkout or git(['rev-parse', 'HEAD']) == source_revision,
            'SOURCE_CHECKOUT_INVALID')
    if require_checkout:
        require(git(['status', '--porcelain', '--untracked-files=all']) == '', 'MANAGED_CHECKOUT_DIRTY')
        require(git(['cat-file', '-t', 'refs/tags/' + source_tag]) == 'tag', 'SOURCE_TAG_NOT_ANNOTATED')
        require(git(['rev-parse', 'refs/tags/' + source_tag + '^{}']) == source_revision,
                'SOURCE_TAG_REVISION_MISMATCH')
        if result.get('release_protocol') == 'stable-v1':
            verify_prior_stable_tag(result, source_revision)
    package = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))
    require(package.get('version') == source_version, 'SOURCE_PACKAGE_VERSION_INVALID')
    values = env_values()
    hashes = config_hashes()
    HELPER.trusted(ROOT); HELPER.trusted(ROOT / '.git')
    HELPER.trusted(OVERRIDE)
    HELPER.trusted('/etc/nginx/snippets/ai-project-os-proxy.conf')
    enabled_info = NGINX_ENABLED.lstat()
    require(stat.S_ISLNK(enabled_info.st_mode) and enabled_info.st_uid == enabled_info.st_gid == 0
            and NGINX_ENABLED.resolve() == NGINX, 'NGINX_ENABLED_PATH_INVALID')
    HELPER.run(['systemctl', 'is-active', '--quiet', 'nginx'])
    local_health = HELPER.healthy(source_version)
    public_health = HELPER.healthy(source_version, public=True)
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
        require(writer['Config'].get('Labels', {}).get('org.opencontainers.image.version') == source_version,
                'SOURCE_IMAGE_VERSION_INVALID')
    manifest = source_manifest()
    require(len(manifest) >= MINIMUM_MIGRATIONS, 'SOURCE_MIGRATION_COUNT_INVALID')
    migration_ledger(postgres_id, manifest)
    require(git_manifest(source_revision) == manifest, 'SOURCE_GIT_MANIFEST_MISMATCH')
    database = readonly_database_snapshot(postgres_id)
    if result.get('release_protocol') == 'stable-v1':
        require(re.fullmatch(r'0|[1-9][0-9]*', result.get('migration_count', '')) is not None
                and int(result['migration_count']) == len(manifest), 'SOURCE_RECEIPT_MIGRATION_COUNT_INVALID')
        backup_name = result.get('backup_name', '')
        require(backup_name_pattern(source_tag).fullmatch(backup_name) is not None,
                'SOURCE_RECEIPT_BACKUP_INVALID')
        validate_source_restore_receipt(result, manifest)
    else:
        validate_default_signup_policy(database)
    return {
        'tag': source_tag,
        'revision': source_revision,
        'version': source_version,
        'receipt': result,
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
        'source_tag': source_tag,
        'source_revision': source_revision,
    }


def already_current_line(source, target_tag, target_revision):
    receipt = source['receipt']
    require(receipt.get('release_protocol') == 'stable-v1'
            and receipt.get('tag') == target_tag and receipt.get('revision') == target_revision,
            'ALREADY_CURRENT_RECEIPT_INVALID')
    restore = validate_source_restore_receipt(receipt, source['source_manifest'])
    if restore.get('required') is False:
        restore_text = ('not-required' if restore['reason'] == 'no-database-change' else
                        'skipped-by-policy-' + str(restore['source_migration_count']) + '-to-'
                        + str(restore['target_migration_count']))
    else:
        restore_text = str(restore['source_migration_count']) + '-to-' + str(restore['target_migration_count'])
    return ('STABLE_DEPLOY_ALREADY_CURRENT tag=' + target_tag + ' revision=' + target_revision
            + ' migration_count=' + str(len(source['source_manifest']))
            + ' backup=' + receipt['backup_name'] + ' restore=' + restore_text)


def read_backup_artifact_helper():
    HELPER.trusted(ARTIFACT_HELPER, 0o755)
    spec = importlib.util.spec_from_file_location('ai_project_os_backup_artifact_stable', ARTIFACT_HELPER)
    require(spec is not None and spec.loader is not None, 'BACKUP_ARTIFACT_HELPER_LOAD_FAILED')
    module = importlib.util.module_from_spec(spec)
    sys.dont_write_bytecode = True
    spec.loader.exec_module(module)
    return module


def verify_backup_output(stdout, target_tag):
    expected_reason = 'pre-deploy-to-' + target_tag
    backup_pattern = re.compile(
        r'^[0-9]{8}T[0-9]{6}Z-' + re.escape(expected_reason) + r'\.[A-Za-z0-9]{6}$'
    )
    matches = [line for line in stdout.splitlines() if line.startswith('BACKUP_OK ')]
    require(len(matches) == 1, 'BACKUP_RECEIPT_INVALID')
    fields = {}
    for token in matches[0].split()[1:]:
        require('=' in token, 'BACKUP_RECEIPT_INVALID')
        key, value = token.split('=', 1)
        require(key not in fields, 'BACKUP_RECEIPT_INVALID')
        fields[key] = value
    require(fields.get('reason') == expected_reason
            and fields.get('retention_removed') == '0'
            and fields.get('source_quiesced') == 'true', 'BACKUP_RECEIPT_INVALID')
    source = Path(fields.get('source', ''))
    require(source.parent == Path('/var/backups/ai-project-os')
            and backup_pattern.fullmatch(source.name) is not None, 'BACKUP_SOURCE_INVALID')
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


def validate_local_backup(backup, current_email_bytes, target_tag, source_version):
    path = backup['path']
    # The pinned helper's mode argument requires a regular file. Backups are
    # directories, so retain its ancestor/ownership checks and check the kind here.
    HELPER.trusted(path)
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) and stat.S_IMODE(info.st_mode) == 0o700,
            'BACKUP_DIRECTORY_MODE_INVALID')
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
    require(metadata.get('format_version') == '2' and metadata.get('reason') == 'pre-deploy-to-' + target_tag
            and metadata.get('compose_project') == PROJECT and metadata.get('app_version') == source_version
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


def create_backup(source, target_tag):
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
    result = subprocess.run([str(BACKUP), 'pre-deploy', target_tag], env=env,
                            text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            timeout=7200, check=False)
    require(result.returncode == 0, 'BACKUP_COMMAND_FAILED')
    backup = verify_backup_output(result.stdout, target_tag)
    validate_local_backup(backup, EMAIL_ENV.read_bytes(), target_tag, source['version'])
    return backup


class HostDeployment:
    def __init__(self, target_tag, target_revision):
        self.target_tag = target_tag
        self.target_version = version_text(target_tag)
        self.target_revision = target_revision
        self.already_current = False
        self.release_classification = None
        self.database_required = True
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
        self.restore_evidence = None

    def preflight(self):
        require(os.geteuid() == 0, 'ROOT_REQUIRED')
        HELPER.trusted('/root'); HELPER.trusted('/usr/bin'); HELPER.trusted('/usr/sbin')
        HELPER.trusted(ROOT); HELPER.trusted(ROOT / '.git')
        require(git(['remote', 'get-url', 'origin']) == REMOTE, 'REMOTE_INVALID')
        require(git(['status', '--porcelain', '--untracked-files=all']) == '', 'MANAGED_CHECKOUT_DIRTY')
        self.source = source_runtime_state(require_checkout=True)
        validate_transition(self.source['tag'], self.source['revision'], self.target_tag, self.target_revision)
        fetch_target(self.target_tag, self.target_revision)
        require_ancestor(self.source['revision'], self.target_revision)
        self.target_manifest, self.target_files = validate_target_tree(
            self.target_revision, self.source['source_manifest'], self.target_tag,
        )
        self.release_classification = classify_release_risk(
            ROOT, self.source['revision'], self.target_revision,
        )
        require(self.release_classification.get('risk') in ('low', 'medium', 'high')
                and type(self.release_classification.get('databaseRequired')) is bool
                and self.release_classification.get('databaseRequired')
                == (self.release_classification['risk'] == 'high'),
                'RELEASE_CI_CLASSIFICATION_INVALID')
        self.database_required = self.release_classification['databaseRequired']
        manifest_changed = self.target_manifest != self.source['source_manifest']
        require(not manifest_changed or self.database_required,
                'NO_DATABASE_RELEASE_MIGRATION_CHANGED')
        self._validate_installed_state(self.target_files)
        self.already_current = self.target_tag == self.source['tag'] \
            and self.target_revision == self.source['revision']
        if not self.already_current:
            require_ci(self.target_tag, self.target_revision, source_revision=self.source['revision'],
                       classification=self.release_classification)
        return self.source

    def _validate_installed_state(self, target_files):
        state = validate_state_file()
        try:
            git(['merge-base', '--is-ancestor', state['toolingRevision'], self.target_revision])
        except RuntimeError:
            require(False, 'TOOLING_REVISION_NOT_ANCESTOR')
        require(sha256(Path(__file__).read_bytes()) == state['files']['deployer'],
                'INSTALLED_TOOL_HASH_INVALID')
        for name, installed_path in (
            ('deployer', DEPLOYER), ('backup', BACKUP), ('artifact_helper', ARTIFACT_HELPER),
            ('sudoers', SUDOERS), ('gateway', GATEWAY),
        ):
            require(installed_path.read_bytes() == target_files[name]
                    and sha256(target_files[name]) == state['files'][name], 'TOOLING_FILE_MISMATCH')
        require(sha256((ROOT / HELPER_SOURCE).read_bytes()) == HELPER_SHA256,
                'PINNED_HELPER_HASH_INVALID')

    def checkout_target(self):
        git(['checkout', '--detach', self.target_revision])
        require(git(['rev-parse', 'HEAD']) == self.target_revision, 'TARGET_CHECKOUT_INVALID')
        require(git(['status', '--porcelain', '--untracked-files=all']) == '', 'TARGET_CHECKOUT_DIRTY')
        target, files = validate_target_tree(
            self.target_revision, self.source['source_manifest'], self.target_tag,
        )
        self.target_files = files
        self.target_manifest = target
        require((ROOT / DEPLOYER_SOURCE).read_bytes() == files['deployer'], 'INSTALLED_TOOL_TARGET_MISMATCH')
        require((ROOT / BACKUP_SOURCE).read_bytes() == files['backup'], 'TARGET_BACKUP_SOURCE_MISMATCH')
        require((ROOT / ARTIFACT_SOURCE).read_bytes() == files['artifact_helper'], 'TARGET_ARTIFACT_SOURCE_MISMATCH')

    def build_target_images(self):
        compose('config', '--quiet')
        all_service_names = {
            'migrate': 'ai-project-os-migrate',
            'reconcile': 'ai-project-os-reconcile',
            'app': 'ai-project-os-app',
            'worker': 'ai-project-os-worker',
            'git-worker': 'ai-project-os-git-worker',
        }
        service_names = all_service_names if self.database_required else {
            service: all_service_names[service] for service in ('app', 'worker', 'git-worker')
        }
        for service in service_names:
            compose('build', service, capture=False, timeout=7200)
        images = {}
        for service, image_name in service_names.items():
            image_id = docker('image', 'inspect', '--format', '{{.Id}}', image_name)
            require(re.fullmatch(r'sha256:[a-f0-9]{64}', image_id) is not None, 'TARGET_IMAGE_ID_INVALID')
            inspected = json.loads(docker('image', 'inspect', image_id))[0]
            require(inspected.get('Config', {}).get('Labels', {}).get('org.opencontainers.image.version')
                    == self.target_version, 'TARGET_IMAGE_VERSION_INVALID')
            images[service] = image_id
        pin_path = Path('/var/lib/ai-project-os/.stable-images-' + secrets.token_hex(12) + '.yaml')
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
        fetch_target(self.target_tag, self.target_revision)
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
        if source['tag'] == INITIAL_SOURCE_TAG:
            validate_default_signup_policy(snapshot)
        require(policy_snapshot(snapshot) == policy_snapshot(source['database_snapshot']),
                'SOURCE_DATABASE_POLICY_CHANGED_DURING_BUILD')
        HELPER.healthy(source['version']); HELPER.healthy(source['version'], public=True)

    def stop_nginx(self):
        self.nginx_stopped = True
        HELPER.run(['systemctl', 'stop', 'nginx'])

    def stop_source_writers(self, source):
        self.writers_stopped = True
        docker('stop', *[source['writer_ids'][service] for service in ('app', 'worker', 'git-worker')])
        HELPER.stopped(source['postgres_id'])
        migration_ledger(source['postgres_id'], source['source_manifest'])
        snapshot = readonly_database_snapshot(source['postgres_id'])
        if source['tag'] == INITIAL_SOURCE_TAG:
            validate_default_signup_policy(snapshot)
        require(policy_snapshot(snapshot) == policy_snapshot(source['database_snapshot']),
                'SOURCE_DATABASE_POLICY_CHANGED_AT_CUTOVER')
        source['database_snapshot'] = snapshot

    def create_and_validate_backup(self, source):
        self.backup = create_backup(source, self.target_tag)
        migration_ledger(source['postgres_id'], source['source_manifest'])
        require(readonly_database_snapshot(source['postgres_id']) == source['database_snapshot'],
                'SOURCE_DATABASE_STATE_CHANGED_DURING_BACKUP')
        return self.backup

    def restore_drill(self, source, backup, images):
        self.restore_token = secrets.token_hex(16)
        suffix = self.restore_token
        owner_key = 'ai-project-os.stable-restore-owner'
        owner_value = suffix
        network_name = 'ai-project-os-stable-net-' + suffix
        volume_name = 'ai-project-os-stable-vol-' + suffix
        pg_name = 'ai-project-os-stable-pg-' + suffix
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
        docker('cp', str(dump_path), pg_id + ':/tmp/ai-project-os-stable-postgres.dump')
        docker('exec', pg_id, 'pg_restore', '--clean', '--if-exists', '--no-privileges',
               '--exit-on-error', '-U', 'ai_project_os_cluster_admin', '-d', 'ai_project_os',
               '/tmp/ai-project-os-stable-postgres.dump', timeout=3600)
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
                                 'source_migration_count': len(source['source_manifest']),
                                 'target_migration_count': len(self.target_manifest),
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
        name = 'ai-project-os-stable-job-' + secrets.token_hex(12)
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
                raise RuntimeError('STABLE_RESTORE_POSTGRES_FAILED')
            time.sleep(1)
        raise RuntimeError('STABLE_RESTORE_POSTGRES_TIMEOUT')

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
        atomic_install(NGINX, candidate, 0o644)
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
                local_health = healthy(self.target_version)
                HELPER.run(['systemctl', 'start', 'nginx'])
                self.nginx_stopped = False
                HELPER.run(['nginx', '-t'])
                HELPER.run(['systemctl', 'reload', 'nginx'])
                public_health = healthy(self.target_version, public=True)
                break
            except (RuntimeError, OSError, ValueError):
                time.sleep(2)
        else:
            raise RuntimeError('STABLE_TARGET_HEALTH_TIMEOUT')
        self.target_health = {'local': local_health, 'public': public_health}
        require(container('postgres')['Id'] == source['postgres_id'], 'PRODUCTION_POSTGRES_REPLACED')
        migration_ledger(source['postgres_id'], self.target_manifest)
        snapshot = readonly_database_snapshot(source['postgres_id'])
        if source['tag'] == INITIAL_SOURCE_TAG:
            validate_default_signup_policy(snapshot)
        require(policy_snapshot(snapshot) == policy_snapshot(source['database_snapshot']),
                'PRODUCTION_ROUTE_OR_OFFER_CHANGED')
        expected_config_hashes = dict(source['config_hashes'])
        expected_config_hashes['nginx'] = sha256(self.target_files['nginx'])
        require(config_hashes() == expected_config_hashes, 'PRODUCTION_CONFIG_CHANGED')
        require(sha256(NGINX.read_bytes()) == sha256(self.target_files['nginx']), 'TARGET_NGINX_HASH_INVALID')
        self.target_writer_ids = {service: container(service)['Id'] for service in ('app', 'worker', 'git-worker')}

    def write_receipt(self, source, backup, images):
        if not self.database_required:
            require(self.target_manifest == source['source_manifest'],
                    'NO_DATABASE_RELEASE_MIGRATION_CHANGED')
        restore_drill = {
            'required': False,
            'reason': ('disabled-by-release-policy' if self.database_required else 'no-database-change'),
            'source_migration_count': len(source['source_manifest']),
            'target_migration_count': len(self.target_manifest),
        }
        record = {
            'tag': self.target_tag, 'revision': self.target_revision,
            'source_tag': source['tag'], 'source_revision': source['revision'],
            'release_protocol': 'stable-v1',
            'source_postgres_container_id': source['postgres_id'],
            'target_writer_ids': self.target_writer_ids,
            'migration_count': len(self.target_manifest),
            'migration_manifest_sha256': migration_manifest_sha256(self.target_manifest),
            'backup_name': backup['name'], 'backup_object': backup['object'],
            'backup_verified_manifest': backup['verified_manifest'],
            'backup_sha256': backup['sha256'], 'source_config_hashes': source['config_hashes'],
            'target_nginx_sha256': sha256(self.target_files['nginx']),
            'target_image_ids': images, 'restore_drill': restore_drill,
            'readonly_source_snapshot': source['database_snapshot'],
            'health': self.target_health,
            'completed_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        }
        plain_string_keys = {'tag', 'revision', 'source_tag', 'source_revision', 'release_protocol',
                             'migration_manifest_sha256'}
        text = 'DEPLOY_OK\n' + ''.join(
            key + '=' + (value if key in plain_string_keys else
                         json.dumps(value, separators=(',', ':'), sort_keys=True)) + '\n'
            for key, value in record.items()
        )
        HELPER.atomic_write(RESULT, text.encode('utf-8'), 0o600)
        print('STABLE_DEPLOY_OK tag=' + self.target_tag + ' revision=' + self.target_revision
              + ' migration_count=' + str(len(self.target_manifest))
              + ' backup=' + backup['name'] + ' restore='
              + ('skipped-by-policy-' + str(restore_drill['source_migration_count']) + '-to-'
                 + str(restore_drill['target_migration_count'])
                 if self.database_required else 'not-required'), flush=True)

    def restore_exact_source(self, source):
        failures = []
        try:
            if git(['rev-parse', 'HEAD']) != source['revision']:
                git(['checkout', '--detach', source['revision']])
            require(git(['rev-parse', 'HEAD']) == source['revision'], 'SOURCE_CHECKOUT_RESTORE_FAILED')
        except BaseException:
            failures.append('checkout')
        try:
            if self.nginx_replaced:
                atomic_install(NGINX, source['nginx_before'], 0o644)
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
                        HELPER.healthy(source['version'])
                        require(all(container(service)['State'].get('Health', {}).get('Status') == 'healthy'
                                    for service in ('app', 'worker', 'git-worker')),
                                'SOURCE_WRITER_RESTART_FAILED')
                        break
                    except (RuntimeError, OSError, ValueError):
                        time.sleep(2)
                else:
                    raise RuntimeError('STABLE_SOURCE_HEALTH_RESTORE_FAILED')
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
                HELPER.healthy(source['version'], public=True)
        except BaseException:
            failures.append('nginx-service')
        try:
            require(container('postgres')['Id'] == source['postgres_id'], 'SOURCE_POSTGRES_CHANGED')
            migration_ledger(source['postgres_id'], source['source_manifest'])
        except BaseException:
            failures.append('database')
        print('STABLE_PRE_MIGRATION_SOURCE_RESTORED=' + ('false' if failures else 'true'),
              file=sys.stderr, flush=True)
        if failures:
            raise RuntimeError('STABLE_PRE_MIGRATION_RECOVERY_INCOMPLETE')

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
            print('STABLE_MIGRATION_RECOVERY_REQUIRED writers_stopped=true nginx_stopped=true',
                  file=sys.stderr, flush=True)
        except BaseException as error:
            raise RuntimeError('STABLE_MANUAL_RECOVERY_QUIESCE_FAILED') from error

    def cleanup_restore_drill(self):
        if self.restore_token is None:
            return
        owner_key = 'ai-project-os.stable-restore-owner'
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
            raise RuntimeError('STABLE_RESTORE_RESOURCE_CLEANUP_FAILED')
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
            raise RuntimeError('STABLE_TARGET_IMAGE_PIN_FILE_CLEANUP_FAILED') from error


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
    temporary = path.parent / ('.stable-' + secrets.token_hex(12))
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


def validate_state_file():
    HELPER.trusted(STATE, 0o600)
    value = json.loads(STATE.read_text(encoding='utf-8'))
    require(set(value) == {'formatVersion', 'toolingRevision', 'files'}
            and value.get('formatVersion') == 1
            and HEX40.fullmatch(value.get('toolingRevision', '')) is not None,
            'TOOLING_STATE_INVALID')
    path_map = {'deployer': (DEPLOYER, 0o700), 'backup': (BACKUP, 0o755),
                'artifact_helper': (ARTIFACT_HELPER, 0o755), 'sudoers': (SUDOERS, 0o440),
                'gateway': (GATEWAY, 0o755)}
    require(set(value.get('files', {})) == set(path_map)
            and all(HEX64.fullmatch(value['files'].get(name, '')) for name in path_map),
            'TOOLING_STATE_INVALID')
    for name, (path, mode) in path_map.items():
        HELPER.trusted(path, mode)
        require(sha256(path.read_bytes()) == value['files'][name], 'TOOLING_FILE_HASH_INVALID')
    return value


def validate_recovery_tooling_state_source(state, revision):
    require(state.get('toolingRevision') == revision
            and set(state.get('files', {})) == set(TOOLING_SOURCE_PATHS),
            'RECOVERY_INSTALLED_TOOLING_SOURCE_INVALID')
    for name, source_path in TOOLING_SOURCE_PATHS.items():
        require(state['files'][name] == sha256(git_blob(revision, source_path)),
                'RECOVERY_INSTALLED_TOOLING_SOURCE_INVALID')


def validate_recovery_bootstrap_state(target_revision, target_files):
    value = json.loads(_read_trusted_host_file(
        STATE, 0o600, 256 * 1024, 'RECOVERY_TOOLING_STATE_INVALID'),
        object_pairs_hook=_unique_json_object)
    require(isinstance(value, dict)
            and set(value) == {'formatVersion', 'toolingRevision', 'files'}
            and value.get('formatVersion') == 1
            and isinstance(value.get('files'), dict)
            and value.get('toolingRevision') in (RECOVERY_SOURCE_REVISION, target_revision),
            'RECOVERY_TOOLING_STATE_INVALID')
    validate_recovery_tooling_state_source(value, value['toolingRevision'])
    paths = {'deployer': (DEPLOYER, 0o700), 'backup': (BACKUP, 0o755),
             'artifact_helper': (ARTIFACT_HELPER, 0o755), 'sudoers': (SUDOERS, 0o440),
             'gateway': (GATEWAY, 0o755)}
    consistent = True
    for name, (path, mode) in paths.items():
        current = _read_trusted_host_file(path, mode, 256 * 1024,
                                          'RECOVERY_INSTALLED_TOOLING_INVALID')
        previous = git_blob(RECOVERY_SOURCE_REVISION, TOOLING_SOURCE_PATHS[name])
        require(current in (previous, target_files[name]),
                'RECOVERY_INSTALLED_TOOLING_BYTES_UNKNOWN')
        consistent = consistent and sha256(current) == value['files'][name]
    return value, consistent


def restore_stale_recovery_receipt_after_bootstrap_failure(previous_receipt_bytes):
    _previous_receipt_is_v100(previous_receipt_bytes)
    current = _read_trusted_host_file(RESULT, 0o600, 256 * 1024,
                                      'BOOTSTRAP_RECEIPT_ROLLBACK_READ_FAILED')
    if current == previous_receipt_bytes:
        return
    try:
        result = parse_record_text(current.decode('utf-8'))
    except UnicodeDecodeError:
        require(False, 'BOOTSTRAP_RECEIPT_ROLLBACK_CONFLICT')
    require(result.get('status') == 'RECOVERY_OK'
            and result.get('tag') == RECOVERY_SOURCE_TAG
            and result.get('revision') == RECOVERY_SOURCE_REVISION
            and result.get('release_protocol') == 'stable-v1-recovery'
            and result.get('previous_receipt_sha256') == sha256(previous_receipt_bytes),
            'BOOTSTRAP_RECEIPT_ROLLBACK_CONFLICT')
    atomic_install(RESULT, previous_receipt_bytes, 0o600)
    require(_read_trusted_host_file(RESULT, 0o600, 256 * 1024,
                                    'BOOTSTRAP_RECEIPT_ROLLBACK_VERIFY_FAILED')
            == previous_receipt_bytes, 'BOOTSTRAP_RECEIPT_ROLLBACK_VERIFY_FAILED')


def install_bootstrap(target_tag, target_revision):
    require(os.geteuid() == 0, 'ROOT_REQUIRED')
    stable_version(target_tag)
    self_path = Path(__file__).absolute()
    HELPER.trusted(self_path, 0o755)
    require(git(['status', '--porcelain', '--untracked-files=all']) == '', 'MANAGED_CHECKOUT_DIRTY')
    current_receipt_bytes = _read_trusted_host_file(RESULT, 0o600, 256 * 1024,
                                                    'SOURCE_RECEIPT_INVALID')
    try:
        current_receipt = parse_record_text(current_receipt_bytes.decode('utf-8'))
    except UnicodeDecodeError:
        require(False, 'SOURCE_RECEIPT_INVALID')
    initial_receipt = (current_receipt.get('status') == 'DEPLOY_OK'
                       and current_receipt.get('tag') == INITIAL_SOURCE_TAG
                       and current_receipt.get('revision') == INITIAL_SOURCE_REVISION)
    checkout_revision = git(['rev-parse', 'HEAD']) if initial_receipt else None
    if initial_receipt:
        require(checkout_revision in (INITIAL_SOURCE_REVISION, RECOVERY_SOURCE_REVISION),
                'BOOTSTRAP_SOURCE_CHECKOUT_INVALID')
    stale_v104_receipt = initial_receipt and checkout_revision == RECOVERY_SOURCE_REVISION
    recovered_source = current_receipt.get('status') == 'RECOVERY_OK'
    if stale_v104_receipt:
        require(stable_version(target_tag) > stable_version(RECOVERY_SOURCE_TAG),
                'RECOVERY_BOOTSTRAP_TARGET_NOT_FORWARD')
        source_tag = RECOVERY_SOURCE_TAG
        source_revision = RECOVERY_SOURCE_REVISION
        source_manifest = git_manifest(RECOVERY_SOURCE_REVISION)
        require(len(source_manifest) == 146, 'RECOVERY_MIGRATION_MANIFEST_INVALID')
        require(git(['remote', 'get-url', 'origin']) == REMOTE
                and git(['rev-parse', 'HEAD']) == RECOVERY_SOURCE_REVISION
                and git(['cat-file', '-t', 'refs/tags/' + RECOVERY_SOURCE_TAG]) == 'tag'
                and git(['rev-parse', 'refs/tags/' + RECOVERY_SOURCE_TAG + '^{}']) == RECOVERY_SOURCE_REVISION,
                'RECOVERY_SOURCE_CHECKOUT_INVALID')
    else:
        source = source_runtime_state(require_checkout=True)
        source_tag = source['tag']
        source_revision = source['revision']
        source_manifest = source['source_manifest']
        recovered_source = source['receipt'].get('release_protocol') == 'stable-v1-recovery'
        require(not recovered_source or stable_version(target_tag) > stable_version(RECOVERY_SOURCE_TAG),
                'RECOVERY_BOOTSTRAP_TARGET_NOT_FORWARD')
    validate_transition(source_tag, source_revision, target_tag, target_revision)
    fetch_main(target_revision)
    require_ancestor(source_revision, target_revision)
    if stale_v104_receipt or recovered_source:
        require_ci(target_tag, target_revision, source_revision=RECOVERY_SOURCE_REVISION,
                   classification=_risk_result('high', ['recovery-receipt-reconciliation']))
    else:
        require_ci(target_tag, target_revision, bootstrap=True)
    _, files = validate_target_tree(target_revision, source_manifest, target_tag)
    require(self_path.read_bytes() == files['deployer'], 'BOOTSTRAP_SOURCE_BYTES_UNTRUSTED')
    existing_is_consistent = True
    if stale_v104_receipt or recovered_source:
        existing, existing_is_consistent = validate_recovery_bootstrap_state(target_revision, files)
    else:
        try:
            existing = validate_state_file()
        except FileNotFoundError:
            existing = None
    if stale_v104_receipt:
        require(existing is not None and existing['toolingRevision'] == RECOVERY_SOURCE_REVISION,
                'RECOVERY_INSTALLED_TOOLING_INVALID')
        validate_recovery_tooling_state_source(existing, RECOVERY_SOURCE_REVISION)
    elif recovered_source:
        require(existing is not None
                and existing['toolingRevision'] in (RECOVERY_SOURCE_REVISION, target_revision),
                'RECOVERY_INSTALLED_TOOLING_INVALID')
        validate_recovery_tooling_state_source(existing, existing['toolingRevision'])
    if recovered_source:
        source = source_runtime_state(require_checkout=True)
    if existing is not None:
        require_ancestor(existing['toolingRevision'], target_revision)
        if existing_is_consistent and all(
                existing['files'][name] == sha256(files[name]) for name in existing['files']):
            if not stale_v104_receipt:
                print('STABLE_TOOLING_ALREADY_READY tooling_revision=' + existing['toolingRevision'])
                return
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
        previous_state = (STATE.read_bytes(), stat.S_IMODE(STATE.stat().st_mode))
    except FileNotFoundError:
        pass
    try:
        if stale_v104_receipt:
            source = reconcile_v104_recovery_receipt(current_receipt_bytes)
            if existing is not None and existing_is_consistent and all(
                    existing['files'][name] == sha256(files[name]) for name in existing['files']):
                print('STABLE_TOOLING_ALREADY_READY tooling_revision=' + existing['toolingRevision'])
                return
        for path, content, mode in destinations:
            atomic_install(path, content, mode)
        state = {
            'formatVersion': 1, 'toolingRevision': target_revision,
            'files': {'deployer': sha256(files['deployer']), 'backup': sha256(files['backup']),
                      'artifact_helper': sha256(files['artifact_helper']),
                      'sudoers': sha256(files['sudoers']), 'gateway': sha256(files['gateway'])},
        }
        atomic_install(STATE, (json.dumps(state, sort_keys=True, separators=(',', ':')) + '\n').encode(), 0o600)
        validate_state_file()
    except BaseException as error:
        rollback_failures = []
        for path, _, _ in reversed(destinations):
            old = original[path]
            try:
                if old is None:
                    path.unlink(missing_ok=True)
                else:
                    atomic_install(path, old[0], old[1])
            except BaseException:
                rollback_failures.append('tooling:' + path.name)
        try:
            if previous_state is None:
                STATE.unlink(missing_ok=True)
            else:
                atomic_install(STATE, previous_state[0], previous_state[1])
        except BaseException:
            rollback_failures.append('state')
        if stale_v104_receipt:
            for path, _, _ in destinations:
                old = original[path]
                try:
                    if old is None:
                        require(not path.exists(), 'BOOTSTRAP_TOOLING_ROLLBACK_VERIFY_FAILED')
                    else:
                        require(path.read_bytes() == old[0]
                                and stat.S_IMODE(path.stat().st_mode) == old[1],
                                'BOOTSTRAP_TOOLING_ROLLBACK_VERIFY_FAILED')
                except BaseException:
                    rollback_failures.append('tooling-verify:' + path.name)
            try:
                if previous_state is None:
                    require(not STATE.exists(), 'BOOTSTRAP_STATE_ROLLBACK_VERIFY_FAILED')
                else:
                    require(STATE.read_bytes() == previous_state[0]
                            and stat.S_IMODE(STATE.stat().st_mode) == previous_state[1],
                            'BOOTSTRAP_STATE_ROLLBACK_VERIFY_FAILED')
            except BaseException:
                rollback_failures.append('state-verify')
            try:
                restore_stale_recovery_receipt_after_bootstrap_failure(current_receipt_bytes)
            except BaseException:
                rollback_failures.append('receipt')
        if stale_v104_receipt and rollback_failures:
            original_code = (error.args[0] if error.args
                             and isinstance(error.args[0], str)
                             and re.fullmatch(r'STABLE_[A-Z0-9_]+', error.args[0])
                             else 'UNKNOWN')
            if 'receipt' in rollback_failures:
                raise RuntimeError('STABLE_BOOTSTRAP_RECEIPT_ROLLBACK_FAILED original='
                                   + original_code + ' components=' + ','.join(rollback_failures)) from error
            raise RuntimeError('STABLE_BOOTSTRAP_INSTALL_ROLLBACK_FAILED original='
                               + original_code + ' components=' + ','.join(rollback_failures)) from error
        raise
    print('STABLE_TOOLING_INSTALLED tooling_revision=' + target_revision
          + ' files=5 gateway_promoted_last=true', flush=True)


def interrupted(_signum, _frame):
    raise RuntimeError('STABLE_INTERRUPTED')


def main(args):
    require(os.geteuid() == 0, 'ROOT_REQUIRED')
    os.umask(0o077)
    HELPER.trusted('/root'); HELPER.trusted('/usr/bin'); HELPER.trusted('/usr/sbin')
    if args == ['--status']:
        state = validate_state_file()
        output = {'kind': 'STABLE_TOOLING_READY', 'formatVersion': 1,
                  'toolingRevision': state['toolingRevision'], 'files': state['files']}
        print(json.dumps(output, sort_keys=True, separators=(',', ':')))
        return
    require(len(args) == 4 and HEX40.fullmatch(args[2]) is not None, 'ARGUMENTS_INVALID')
    command, target_tag, revision, confirmation = args
    stable_version(target_tag)
    fd = secure_lock()
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    signal.signal(signal.SIGHUP, interrupted)
    try:
        if command == 'bootstrap':
            require(confirmation == 'CONFIRM_INSTALL_STABLE_TOOLING', 'BOOTSTRAP_CONFIRMATION_INVALID')
            install_bootstrap(target_tag, revision)
            return
        require(command == 'deploy' and confirmation == 'CONFIRM_STABLE_WITH_BACKUP_AND_FULL_CI',
                'DEPLOY_CONFIRMATION_INVALID')
        state = validate_state_file()
        for name, path in (
            ('deployer', DEPLOYER), ('backup', BACKUP), ('artifact_helper', ARTIFACT_HELPER),
            ('sudoers', SUDOERS), ('gateway', GATEWAY),
        ):
            require(sha256(path.read_bytes()) == state['files'][name], 'TOOLING_FILE_HASH_INVALID')
        require(sha256(Path(__file__).read_bytes()) == state['files']['deployer'], 'INSTALLED_TOOL_HASH_INVALID')
        host = HostDeployment(target_tag, revision)
        source = host.preflight()
        if host.already_current:
            print(already_current_line(source, target_tag, revision), flush=True)
            return
        deployment_flow(host, source)
    finally:
        os.close(fd)


def safe_failure_code(error):
    """Preserve known validator codes without exposing subprocess args or data."""
    if isinstance(error, (RuntimeError, SystemExit)):
        code = str(error)
        if re.fullmatch(r'STABLE_[A-Z0-9_]{1,100}', code):
            return code
        rollback_code = code.split(' ', 1)[0]
        if rollback_code in ('STABLE_BOOTSTRAP_RECEIPT_ROLLBACK_FAILED',
                             'STABLE_BOOTSTRAP_INSTALL_ROLLBACK_FAILED'):
            return rollback_code
        if re.fullmatch(r'V074_[A-Z0-9_]{1,100}', code):
            return 'STABLE_PINNED_HELPER_' + code.removeprefix('V074_')
        if re.fullmatch(r'BACKUP_[A-Z0-9_]{1,100}', code):
            return 'STABLE_BACKUP_ARTIFACT_' + code.removeprefix('BACKUP_')
    if isinstance(error, subprocess.TimeoutExpired):
        return 'STABLE_COMMAND_TIMEOUT'
    return 'STABLE_UNEXPECTED_FAILURE'


if __name__ == '__main__':
    try:
        # Helper is pinned before loading any source-provided or host-controlled tooling.
        HELPER = load_helper()
        main(sys.argv[1:])
    except BaseException as error:
        message = safe_failure_code(error)
        print(message, file=sys.stderr)
        sys.exit(1)
