#!/usr/bin/python3
"""Root-only stable release and recovery gate with a one-time tooling bootstrap."""
from __future__ import annotations

import fcntl
from decimal import Decimal
import hashlib
import importlib.util
import io
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
import urllib.error
import urllib.parse
import zipfile

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
CACHE_MAINTENANCE_PLAN = Path('/var/lib/ai-project-os/cache-maintenance-plan.json')
CACHE_MAINTENANCE_AUDIT = Path('/var/lib/ai-project-os/cache-maintenance-last.json')
IMAGE_MAINTENANCE_PLAN = Path('/var/lib/ai-project-os/image-maintenance-plan.json')
IMAGE_MAINTENANCE_AUDIT = Path('/var/lib/ai-project-os/image-maintenance-last.json')
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
CACHE_RECORD_ID = re.compile(r'^[a-z0-9][a-z0-9_:-]{0,127}$')
CACHE_TYPES = frozenset(('regular', 'internal', 'frontend', 'source.local',
                         'source.git.checkout', 'source.http', 'source.image',
                         'exec.cachemount'))
IMAGE_SOURCE = 'https://github.com/Jack-Kunlun/ai-project-os'
LEGACY_IMAGE_VERSION = re.compile(r'(?:0|[1-9][0-9]*)\.[0-9]+\.[0-9]+(?:-dev\.[0-9]+)?')
LEGACY_IMAGE_TAG = re.compile(r'ai-project-os-[a-z-]+(?::[^/]+)?')
LEGACY_IMAGE_SERVICES = frozenset(('app', 'worker', 'git-worker', 'migrate',
                                   'reconcile', 'principal-bootstrap'))
HISTORICAL_IMAGE_SERVICES = LEGACY_IMAGE_SERVICES | frozenset(
    ('production-upgrade-preflight',)
)
# Exact references matched to legacy deployment sources and the inspected reference hashes.
HISTORICAL_IMAGE_REFERENCE_EXCEPTIONS = {
    'sha256:3e3660173cabc686ed1e9ae1ffeadfba6b388707b141c49e7eb2b002c66a9266': (
        '0.8.0-dev.4', 'reconcile',
        'ai-project-os-v1-reconcile:df0f227669d0ea62c6119bd9b057c38f3b14d4d7',
        'ai-project-os-v1-reconcile@sha256:3e3660173cabc686ed1e9ae1ffeadfba6b388707b141c49e7eb2b002c66a9266',
    ),
    'sha256:4aaa76f6d6a9ec3d81929a91b493e74f197bd66a45bb340be2c48124a16f3e41': (
        '0.8.0-dev.4', 'app',
        'ai-project-os-v1-app:df0f227669d0ea62c6119bd9b057c38f3b14d4d7',
        'ai-project-os-v1-app@sha256:4aaa76f6d6a9ec3d81929a91b493e74f197bd66a45bb340be2c48124a16f3e41',
    ),
    'sha256:4ab705882c2fde74880c9e971e3a675a6176f29762307c4c7fb78be6a819d9e9': (
        '0.8.0-dev.4', 'migrate',
        'ai-project-os-v1-migrate:df0f227669d0ea62c6119bd9b057c38f3b14d4d7',
        'ai-project-os-v1-migrate@sha256:4ab705882c2fde74880c9e971e3a675a6176f29762307c4c7fb78be6a819d9e9',
    ),
    'sha256:507fb49a9b0fb572df87bb79e73f2f8df62de4c0d85ff01524219cd969f8edd2': (
        '0.5.0-dev.1', 'worker',
        'ai-project-os-preserve-v0-5-0-dev-1-worker:latest',
        'ai-project-os-preserve-v0-5-0-dev-1-worker@sha256:507fb49a9b0fb572df87bb79e73f2f8df62de4c0d85ff01524219cd969f8edd2',
    ),
    'sha256:6060a7c9dd640c1702fdd3383bf5b5609ea18c8cceb71e1831cb94f47fc37ac6': (
        '1.0.0', 'app',
        'ai-project-os-v1-app:f57d050fffa445a6ef9eb3d7e692e6df06fac98d',
        'ai-project-os-v1-app@sha256:6060a7c9dd640c1702fdd3383bf5b5609ea18c8cceb71e1831cb94f47fc37ac6',
    ),
    'sha256:717905ac3b6cd0ae2be747d976e3adb7b74647f68664f4ed285fdaf4051533b9': (
        '1.0.0', 'worker',
        'ai-project-os-v1-worker:f57d050fffa445a6ef9eb3d7e692e6df06fac98d',
        'ai-project-os-v1-worker@sha256:717905ac3b6cd0ae2be747d976e3adb7b74647f68664f4ed285fdaf4051533b9',
    ),
    'sha256:71b9491d66dfc809163e3e0111161f5dc167a9868f9d8e552612f959791e05a7': (
        '0.5.0-dev.1', 'app',
        'ai-project-os-preserve-v0-5-0-dev-1-app:latest',
        'ai-project-os-preserve-v0-5-0-dev-1-app@sha256:71b9491d66dfc809163e3e0111161f5dc167a9868f9d8e552612f959791e05a7',
    ),
    'sha256:8620b13bfc6046074e8e13d4c5b09f528e09730d3c2f6d689c2351c464864a9c': (
        '0.8.0-dev.4', 'worker',
        'ai-project-os-v1-worker:df0f227669d0ea62c6119bd9b057c38f3b14d4d7',
        'ai-project-os-v1-worker@sha256:8620b13bfc6046074e8e13d4c5b09f528e09730d3c2f6d689c2351c464864a9c',
    ),
    'sha256:c4ff0bc5c0bdf7d74949cb3ede45293d38f81cae7c87ce873cb79c5404ee0681': (
        '1.0.0', 'git-worker',
        'ai-project-os-v1-git-worker:f57d050fffa445a6ef9eb3d7e692e6df06fac98d',
        'ai-project-os-v1-git-worker@sha256:c4ff0bc5c0bdf7d74949cb3ede45293d38f81cae7c87ce873cb79c5404ee0681',
    ),
    'sha256:e0952e811202fb5952561ae5bca82f4668b32144dbea4559e73602716894ba1c': (
        '0.8.0-dev.4', 'git-worker',
        'ai-project-os-v1-git-worker:df0f227669d0ea62c6119bd9b057c38f3b14d4d7',
        'ai-project-os-v1-git-worker@sha256:e0952e811202fb5952561ae5bca82f4668b32144dbea4559e73602716894ba1c',
    ),
}
CACHE_PLAN_TTL_SECONDS = 15 * 60
CACHE_MAX_IMAGE_REFS = 256
IMAGE_REF_DISPLAY_LIMIT = 8
IMAGE_VERSION = re.compile(
    r'^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)'
    r'(?:-dev\.(0|[1-9][0-9]*))?$'
)
HISTORICAL_IMAGE_SCOPE = (
    'sha256:08e388bbb6f8ca08dfcdd431dd3655f1c669dd5e390284bd41e89965278f9678',
    'sha256:31f6f10638e8c2f24c3be075a5ead6219839b833aaf311b726ba86efcf3f2cae',
    'sha256:3e3660173cabc686ed1e9ae1ffeadfba6b388707b141c49e7eb2b002c66a9266',
    'sha256:4aaa76f6d6a9ec3d81929a91b493e74f197bd66a45bb340be2c48124a16f3e41',
    'sha256:4ab705882c2fde74880c9e971e3a675a6176f29762307c4c7fb78be6a819d9e9',
    'sha256:5016fe4fbd59e436f5c881515f460c0dd2d27fd69d2cb67ea7099338f2210192',
    'sha256:507fb49a9b0fb572df87bb79e73f2f8df62de4c0d85ff01524219cd969f8edd2',
    'sha256:5f811cabe49b87ef3e49c986cd26d72609852eb093dcdd23fa910f6d1262140e',
    'sha256:6060a7c9dd640c1702fdd3383bf5b5609ea18c8cceb71e1831cb94f47fc37ac6',
    'sha256:717905ac3b6cd0ae2be747d976e3adb7b74647f68664f4ed285fdaf4051533b9',
    'sha256:71b9491d66dfc809163e3e0111161f5dc167a9868f9d8e552612f959791e05a7',
    'sha256:8620b13bfc6046074e8e13d4c5b09f528e09730d3c2f6d689c2351c464864a9c',
    'sha256:acfa880db67ae93c56ef5cf5e97e9530972a371b881677dc248214a09bba3452',
    'sha256:b97d07cbed2494b0369c8200003430515ff2e9caabc757d0b3f5ff03a34eb6d1',
    'sha256:c4ff0bc5c0bdf7d74949cb3ede45293d38f81cae7c87ce873cb79c5404ee0681',
    'sha256:d06e997947ee545296f29933ce95c9a97f8b4c95807557c8f497e49eb270a270',
    'sha256:e0952e811202fb5952561ae5bca82f4668b32144dbea4559e73602716894ba1c',
)
CACHE_CONTAINER_STATUSES = frozenset(('created', 'restarting', 'running', 'removing',
                                      'paused', 'exited', 'dead'))
CACHE_MAX_RECORDS = 2048
CACHE_MAX_CONTAINERS = 1024
CACHE_MAX_VOLUMES = 1024
CACHE_MAX_IMAGES = 1024
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
        argument = re.compile(rb'(?m)^(ARG APP_VERSION=")([^"\r\n]+)(")$')
        source_version, source_normalized = _replace_one_version(
            before, argument if b'org.opencontainers.image.version="${APP_VERSION}"' in before else pattern)
        target_version, target_normalized = _replace_one_version(
            after, argument if b'org.opencontainers.image.version="${APP_VERSION}"' in after else pattern)
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
        backup = None  # Routine releases do not create backups or run restore drills.
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
        # Cleanup is maintenance after successful acceptance, never a reason to
        # stop a healthy release or delete its receipt.
        try:
            ops.cleanup_old_images(source)
        except Exception:
            print('STABLE_IMAGE_CLEANUP_DEFERRED', flush=True)
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


def read_release_credentials(stream):
    """Receive opaque Workflow credentials over encrypted stdin, never argv."""
    raw = stream.read(4097)
    require(len(raw) <= 4096, 'WORKFLOW_INPUT_TOO_LARGE')
    value = json.loads(raw, object_pairs_hook=_unique_json_object)
    require(isinstance(value, dict) and set(value) == {'token', 'runId'}
            and type(value['runId']) is int and value['runId'] > 0,
            'WORKFLOW_INPUT_INVALID')
    # Installation tokens are opaque, variable-length values (including JWTs).
    # Bound transport size and HTTP Bearer characters, not a provider token format.
    token = value['token']
    require(isinstance(token, str) and 0 < len(token) <= 3800
            and re.fullmatch(r'[A-Za-z0-9._~+/-]+=*', token) is not None,
            'WORKFLOW_TOKEN_INVALID')
    return value


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def github_artifact_request(url, token, redirect=False):
    parsed = urllib.parse.urlsplit(url)
    require(parsed.scheme == 'https' and parsed.hostname == 'api.github.com'
            and not parsed.username and not parsed.password,
            'ARTIFACT_API_URL_INVALID')
    request = urllib.request.Request(url, headers={
        'Accept': 'application/vnd.github+json', 'Authorization': 'Bearer ' + token,
        'X-GitHub-Api-Version': '2022-11-28',
    })
    opener = urllib.request.build_opener(_NoRedirect)
    try:
        response = opener.open(request, timeout=30)
    except urllib.error.HTTPError as error:
        require(redirect and error.code == 302, 'ARTIFACT_API_STATUS_INVALID')
        location = error.headers.get('Location', '')
        target = urllib.parse.urlsplit(location)
        require(target.scheme == 'https' and not target.username and not target.password
                and target.hostname is not None
                and (target.hostname.endswith('.blob.core.windows.net')
                     or target.hostname.endswith('.githubusercontent.com')),
                'ARTIFACT_REDIRECT_INVALID')
        # The signed storage URL is fetched separately, without GitHub credentials.
        response = opener.open(urllib.request.Request(location), timeout=30)
    with response:
        require(response.status == 200, 'ARTIFACT_HTTP_STATUS_INVALID')
        body = response.read(1024 * 1024 + 1)
    require(len(body) <= 1024 * 1024, 'ARTIFACT_TOO_LARGE')
    return body


def validate_image_manifest(value, revision, version, run_id):
    require(isinstance(value, dict)
            and set(value) == {'schema', 'revision', 'version', 'runId', 'images'}
            and type(value['schema']) is int and value['schema'] == 1
            and value['revision'] == revision and value['version'] == version
            and type(value['runId']) is int and value['runId'] == run_id,
            'IMAGE_MANIFEST_IDENTITY_INVALID')
    images = value['images']
    require(isinstance(images, dict) and set(images) == {'app', 'worker', 'migrate'},
            'IMAGE_MANIFEST_SERVICES_INVALID')
    for service, record in images.items():
        prefix = 'ghcr.io/jack-kunlun/ai-project-os-' + service + '@sha256:'
        require(isinstance(record, dict) and set(record) == {'ref', 'id'}
                and isinstance(record['ref'], str) and record['ref'].startswith(prefix)
                and HEX64.fullmatch(record['ref'][len(prefix):]) is not None
                and isinstance(record['id'], str)
                and re.fullmatch(r'sha256:[a-f0-9]{64}', record['id']) is not None,
                'IMAGE_MANIFEST_REFERENCE_INVALID')
    return value


def load_ci_images(run, credentials, revision, version):
    require(run['id'] == credentials['runId'], 'IMAGE_CI_RUN_MISMATCH')
    api = 'https://api.github.com/repos/Jack-Kunlun/ai-project-os/actions'
    listing = json.loads(github_artifact_request(
        api + '/runs/' + str(run['id']) + '/artifacts?per_page=100', credentials['token']))
    artifacts = [item for item in listing.get('artifacts', []) if item.get('name') == 'release-images']
    require(len(artifacts) == 1, 'IMAGE_ARTIFACT_MISSING_OR_AMBIGUOUS')
    artifact = artifacts[0]
    identity = artifact.get('workflow_run', {})
    require(not artifact.get('expired', True) and type(artifact.get('id')) is int
            and identity.get('id') == run['id'] and identity.get('head_sha') == revision
            and identity.get('head_branch') == 'main'
            and artifact.get('size_in_bytes', 1024 * 1024 + 1) <= 1024 * 1024
            and re.fullmatch(r'sha256:[a-f0-9]{64}', artifact.get('digest', '')) is not None,
            'IMAGE_ARTIFACT_IDENTITY_INVALID')
    archive = github_artifact_request(api + '/artifacts/' + str(artifact['id']) + '/zip',
                                      credentials['token'], redirect=True)
    require('sha256:' + sha256(archive) == artifact['digest'], 'IMAGE_ARTIFACT_DIGEST_INVALID')
    with zipfile.ZipFile(io.BytesIO(archive)) as bundle:
        require(bundle.namelist() == ['release-images.json'], 'IMAGE_ARTIFACT_CONTENT_INVALID')
        info = bundle.getinfo('release-images.json')
        require(info.file_size <= 64 * 1024, 'IMAGE_MANIFEST_TOO_LARGE')
        value = json.loads(bundle.read(info), object_pairs_hook=_unique_json_object)
    return validate_image_manifest(value, revision, version, run['id'])


def parse_cache_usage(output):
    """Buildx JSON Size can be raw bytes or a rounded SI display value."""
    total, estimated = 0, False
    units = {'B': 1, 'kB': 1000, 'MB': 1000 ** 2, 'GB': 1000 ** 3,
             'TB': 1000 ** 4, 'PB': 1000 ** 5, 'EB': 1000 ** 6}
    for line in output.splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        require(isinstance(row, dict) and type(row.get('Reclaimable')) is bool
                and type(row.get('Shared')) is bool, 'CACHE_USAGE_INVALID')
        size = row.get('Size')
        require(type(size) in (str, int), 'CACHE_USAGE_INVALID')
        match = re.fullmatch(r'([0-9]+(?:\.[0-9]+)?)(B|kB|MB|GB|TB|PB|EB)?', str(size))
        require(match is not None and (match[2] is not None or '.' not in match[1]),
                'CACHE_USAGE_INVALID')
        value = Decimal(match[1]) * units.get(match[2], 1)
        require(value <= 2 ** 63 - 1, 'CACHE_USAGE_INVALID')
        total += int(value)
        estimated = estimated or match[2] not in (None, 'B')
    return total, estimated


def validate_pulled_image(info, record, version, revision):
    """Bind a local engine ID to the exact CI registry artifact on either store."""
    require(isinstance(info, dict), 'TARGET_IMAGE_IDENTITY_INVALID')
    config = info.get('Config') or {}
    require(isinstance(config, dict), 'TARGET_IMAGE_IDENTITY_INVALID')
    labels = config.get('Labels') or {}
    digests = info.get('RepoDigests') or []
    descriptor = info.get('Descriptor')
    registry_digest = record['ref'].split('@', 1)[1]
    descriptor_valid = (isinstance(descriptor, dict)
                        and descriptor.get('digest') == registry_digest
                        and descriptor.get('mediaType') in (
                            'application/vnd.docker.distribution.manifest.v2+json',
                            'application/vnd.oci.image.manifest.v1+json'))
    # Classic stores identify images by config digest; containerd uses the
    # manifest digest. The immutable registry reference binds both to CI.
    local_id = info.get('Id')
    require(isinstance(labels, dict) and isinstance(digests, list)
            and record['ref'] in digests
            and ((local_id == record['id'] and (descriptor is None or descriptor_valid))
                 or (local_id == registry_digest and descriptor_valid))
            and info.get('Os') == 'linux' and info.get('Architecture') == 'amd64'
            and labels.get('org.opencontainers.image.version') == version
            and labels.get('org.opencontainers.image.revision') == revision
            and labels.get('org.opencontainers.image.source')
            == 'https://github.com/Jack-Kunlun/ai-project-os',
            'TARGET_IMAGE_IDENTITY_INVALID')
    return local_id


def prune_build_cache():
    """Measure the actual default builder used by historical Compose builds."""
    def usage():
        return parse_cache_usage(docker(
            'buildx', 'du', '--builder', 'default', '--format=json'))
    before, before_estimated = usage()
    disk_before = os.statvfs('/')
    docker('buildx', 'prune', '--builder', 'default', '--force',
           '--max-used-space', '2GB', capture=False, timeout=600)
    after, after_estimated = usage()
    disk_after = os.statvfs('/')
    budget_met = after <= 2_000_000_000
    print('STABLE_CACHE_CLEANUP ' + json.dumps({
        'builder': 'default', 'beforeBytes': before, 'afterBytes': after,
        'beforeEstimated': before_estimated, 'afterEstimated': after_estimated,
        'targetBytes': 2_000_000_000, 'budgetMet': budget_met,
        'availableBeforeBytes': disk_before.f_bavail * disk_before.f_frsize,
        'availableAfterBytes': disk_after.f_bavail * disk_after.f_frsize,
    }, sort_keys=True, separators=(',', ':')), flush=True)
    if not budget_met:
        print('STABLE_CACHE_BUDGET_DEFERRED protected_or_remaining_bytes=' + str(after), flush=True)
    return budget_met


def _cache_json_bytes(value):
    return json.dumps(value, ensure_ascii=True, sort_keys=True,
                      separators=(',', ':'), allow_nan=False).encode('ascii')


def _cache_unique_json_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'CACHE_USAGE_DUPLICATE_KEY')
        result[key] = value
    return result


def _cache_size_bytes(size):
    units = {'B': 1, 'kB': 1000, 'MB': 1000 ** 2, 'GB': 1000 ** 3,
             'TB': 1000 ** 4, 'PB': 1000 ** 5, 'EB': 1000 ** 6}
    require(type(size) in (str, int), 'CACHE_USAGE_INVALID')
    match = re.fullmatch(r'([0-9]+(?:\.[0-9]+)?)(B|kB|MB|GB|TB|PB|EB)?', str(size))
    require(match is not None and (match[2] is not None or '.' not in match[1]),
            'CACHE_USAGE_INVALID')
    value = Decimal(match[1]) * units.get(match[2], 1)
    require(value <= 2 ** 63 - 1, 'CACHE_USAGE_INVALID')
    return int(value), match[2] not in (None, 'B')


def parse_cache_records(output):
    """Parse bounded buildx du NDJSON without retaining provider descriptions."""
    require(isinstance(output, str) and len(output.encode('utf-8')) <= 2 * 1024 * 1024,
            'CACHE_USAGE_TOO_LARGE')
    records = []
    seen = set()
    for line in output.splitlines():
        if not line.strip():
            continue
        require(len(records) < CACHE_MAX_RECORDS and len(line) <= 65536,
                'CACHE_USAGE_TOO_LARGE')
        try:
            row = json.loads(line, object_pairs_hook=_cache_unique_json_object)
        except (json.JSONDecodeError, UnicodeDecodeError, TypeError, ValueError) as error:
            raise RuntimeError('STABLE_CACHE_USAGE_INVALID') from error
        require(isinstance(row, dict), 'CACHE_USAGE_INVALID')
        identifier = row.get('ID')
        cache_type = row.get('Type')
        require(isinstance(identifier, str) and CACHE_RECORD_ID.fullmatch(identifier) is not None
                and identifier not in seen, 'CACHE_USAGE_ID_INVALID')
        require(isinstance(cache_type, str) and cache_type in CACHE_TYPES,
                'CACHE_USAGE_TYPE_INVALID')
        require(type(row.get('Shared')) is bool and type(row.get('Reclaimable')) is bool
                and type(row.get('Mutable')) is bool, 'CACHE_USAGE_FLAGS_INVALID')
        size_bytes, estimated = _cache_size_bytes(row.get('Size'))
        eligible = row['Reclaimable']
        bucket = ('shared' if row['Shared'] else 'private') + ('Reclaimable' if eligible else 'Protected')
        records.append({
            'id': identifier, 'type': cache_type, 'sizeBytes': size_bytes,
            'estimated': estimated, 'shared': row['Shared'],
            'reclaimable': row['Reclaimable'], 'mutable': row['Mutable'],
            'eligible': eligible, 'bucket': bucket,
        })
        seen.add(identifier)
    records.sort(key=lambda item: item['id'])
    require(sum(record['sizeBytes'] for record in records) <= 2 ** 63 - 1,
            'CACHE_USAGE_INVALID')
    return records


def cache_summary(records):
    buckets = ('privateReclaimable', 'privateProtected',
               'sharedReclaimable', 'sharedProtected')
    result = {
        'builder': 'default', 'recordCount': len(records),
        'sumRecordBytes': sum(record['sizeBytes'] for record in records),
        'estimated': any(record['estimated'] for record in records),
    }
    for bucket in buckets:
        items = [record for record in records if record['bucket'] == bucket]
        result[bucket + 'Bytes'] = sum(record['sizeBytes'] for record in items)
        result[bucket + 'Count'] = len(items)
    return result


def _cache_read_records():
    output = docker('buildx', 'du', '--builder', 'default', '--format=json', timeout=120)
    return parse_cache_records(output)


def _cache_validate_image_id(value):
    require(isinstance(value, str) and re.fullmatch(r'sha256:[a-f0-9]{64}', value) is not None,
            'CACHE_IMAGE_ID_INVALID')
    return value


def _cache_safe_json_list(value, code):
    require(value is None or isinstance(value, list), code)
    if value is None:
        return []
    require(len(value) <= 256 and all(isinstance(item, str) and 0 < len(item) <= 512
                                      and not any(ord(char) < 32 for char in item)
                                      for item in value), code)
    return sorted(set(value))


def _cache_protected_image_inventory():
    listed = docker('image', 'ls', '--quiet', '--no-trunc', '--filter',
                    'label=org.opencontainers.image.title=AI Project OS')
    identifiers = sorted(set(listed.splitlines()))
    require(len(identifiers) <= CACHE_MAX_IMAGES
            and all(re.fullmatch(r'sha256:[a-f0-9]{64}', item) is not None for item in identifiers),
            'CACHE_IMAGE_INVENTORY_INVALID')
    template = ('{{.Id}}|{{index .Config.Labels "org.opencontainers.image.title"}}|'
                '{{index .Config.Labels "org.opencontainers.image.source"}}|'
                '{{index .Config.Labels "org.opencontainers.image.version"}}|'
                '{{index .Config.Labels "org.opencontainers.image.revision"}}|'
                '{{index .Config.Labels "com.docker.compose.project"}}|'
                '{{index .Config.Labels "com.docker.compose.service"}}|'
                '{{json .RepoTags}}|{{json .RepoDigests}}')
    images = []
    unverified = []
    for identifier in identifiers:
        output = docker('image', 'inspect', '--format', template, identifier)
        lines = output.splitlines()
        require(len(lines) == 1, 'CACHE_IMAGE_INSPECT_INVALID')
        parts = lines[0].split('|', 8)
        require(len(parts) == 9, 'CACHE_IMAGE_INSPECT_INVALID')
        (image_id, title, source, version, revision, project, service,
         raw_tags, raw_digests) = parts
        title = '' if title == '<no value>' else title
        source = '' if source == '<no value>' else source
        version = '' if version == '<no value>' else version
        revision = '' if revision == '<no value>' else revision
        project = '' if project == '<no value>' else project
        service = '' if service == '<no value>' else service
        try:
            tags = _cache_safe_json_list(json.loads(raw_tags), 'CACHE_IMAGE_REFS_INVALID')
            digests = _cache_safe_json_list(json.loads(raw_digests), 'CACHE_IMAGE_REFS_INVALID')
        except (json.JSONDecodeError, TypeError, ValueError) as error:
            raise RuntimeError('STABLE_CACHE_IMAGE_REFS_INVALID') from error
        require(image_id == identifier and title == 'AI Project OS'
                and all(len(value) <= 512 and not any(ord(char) < 32 for char in value)
                        for value in (source, version, revision, project, service)),
                'CACHE_IMAGE_IDENTITY_INVALID')
        legacy = source == ''
        checks = [('source-unrecognized', source in ('', IMAGE_SOURCE))]
        if legacy:
            checks.extend([
                ('legacy-project', project == PROJECT),
                ('legacy-service', service in LEGACY_IMAGE_SERVICES),
                ('legacy-version', LEGACY_IMAGE_VERSION.fullmatch(version) is not None),
                ('legacy-tags', all(LEGACY_IMAGE_TAG.fullmatch(tag) is not None for tag in tags)),
                ('legacy-digests', all(ref.startswith('ghcr.io/jack-kunlun/ai-project-os-')
                                       for ref in digests)),
            ])
        elif source == IMAGE_SOURCE:
            checks.extend([
                ('canonical-version', not version or STABLE_TAG.fullmatch('v' + version) is not None),
                ('canonical-revision', not revision or HEX40.fullmatch(revision) is not None),
            ])
        image = {'id': image_id, 'title': title, 'source': source,
                 'version': version, 'revision': revision,
                 'project': project, 'service': service, 'legacy': legacy,
                 'repoTags': tags, 'repoDigests': digests}
        reasons = [reason for reason, valid in checks if not valid]
        if reasons:
            # Unknown ownership never authorizes deletion or satisfies release identity.
            # Preserve its ID and metadata hash in the same before/after drift guard.
            unverified.append({'id': image_id, 'reasons': reasons,
                               'identitySha256': sha256(_cache_json_bytes(image))})
        else:
            images.append(image)
    return {'ownedImages': images, 'unverifiedImages': unverified}


def _cache_volume_snapshot():
    output = docker('volume', 'ls', '--quiet')
    names = sorted(set(output.splitlines()))
    require(len(names) <= CACHE_MAX_VOLUMES
            and all(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,254}', name) is not None
                    for name in names), 'CACHE_VOLUME_INVENTORY_INVALID')
    template = ('{{.Name}}|{{.Driver}}|{{.Scope}}|{{.CreatedAt}}|'
                '{{json .Labels}}|{{json .Options}}')
    result = []
    for name in names:
        line = docker('volume', 'inspect', '--format', template, name)
        parts = line.split('|', 5)
        require(len(parts) == 6 and parts[0] == name, 'CACHE_VOLUME_INSPECT_INVALID')
        driver, scope, created_at = parts[1:4]
        require(re.fullmatch(r'[A-Za-z0-9_.-]{1,128}', driver) is not None
                and scope in ('local', 'global') and len(created_at) <= 100
                and not any(ord(char) < 32 for char in created_at),
                'CACHE_VOLUME_INSPECT_INVALID')
        try:
            labels = json.loads(parts[4])
            options = json.loads(parts[5])
        except (json.JSONDecodeError, TypeError, ValueError) as error:
            raise RuntimeError('STABLE_CACHE_VOLUME_INSPECT_INVALID') from error
        require(labels is None or isinstance(labels, dict), 'CACHE_VOLUME_INSPECT_INVALID')
        require(options is None or isinstance(options, dict), 'CACHE_VOLUME_INSPECT_INVALID')
        identity = {'labels': labels, 'options': options}
        result.append({'name': name, 'driver': driver, 'scope': scope,
                       'createdAt': created_at,
                       'identitySha256': sha256(_cache_json_bytes(identity))})
    return result


def _cache_protected_resource_snapshot(source):
    container_output = docker('ps', '-aq', '--no-trunc')
    container_ids = sorted(set(container_output.splitlines()))
    require(len(container_ids) <= CACHE_MAX_CONTAINERS
            and all(HEX64.fullmatch(item) is not None for item in container_ids),
            'CACHE_CONTAINER_INVENTORY_INVALID')
    containers = []
    if container_ids:
        output = docker('inspect', '--format', '{{.Id}}|{{.Image}}', *container_ids)
        rows = output.splitlines()
        require(len(rows) == len(container_ids), 'CACHE_CONTAINER_INSPECT_INVALID')
        for row in rows:
            fields = row.split('|')
            require(len(fields) == 2 and HEX64.fullmatch(fields[0]) is not None
                    and fields[0] in container_ids
                    and re.fullmatch(r'sha256:[a-f0-9]{64}', fields[1]) is not None,
                    'CACHE_CONTAINER_INSPECT_INVALID')
            containers.append({'id': fields[0], 'image': fields[1]})
        require(len({item['id'] for item in containers}) == len(containers),
                'CACHE_CONTAINER_INSPECT_INVALID')
    containers.sort(key=lambda item: item['id'])
    volumes = _cache_volume_snapshot()
    image_inventory = _cache_protected_image_inventory()
    images = image_inventory['ownedImages']
    owned_ids = sorted(image['id'] for image in images)
    receipt = source['receipt']
    require(receipt.get('release_protocol') == 'stable-v2-images',
            'CACHE_STABLE_IMAGE_RECEIPT_REQUIRED')
    try:
        receipt_images = json.loads(receipt.get('target_image_ids', 'null'),
                                    object_pairs_hook=_cache_unique_json_object)
    except (json.JSONDecodeError, TypeError, ValueError) as error:
        raise RuntimeError('STABLE_CACHE_IMAGE_RECEIPT_INVALID') from error
    require(isinstance(receipt_images, dict) and set(receipt_images) == LEGACY_IMAGE_SERVICES
            and all(receipt_images[service] == receipt_images['worker']
                    for service in ('git-worker', 'reconcile', 'principal-bootstrap')),
            'CACHE_IMAGE_RECEIPT_INVALID')
    current_receipt_ids = sorted({_cache_validate_image_id(value)
                                  for value in receipt_images.values()})
    current_runtime_ids = sorted({_cache_validate_image_id(value)
                                  for value in source['writer_images'].values()})
    current_version = source['version']
    current_owned_ids = sorted({image['id'] for image in images
                                if image['source'] == IMAGE_SOURCE
                                and image['version'] == current_version
                                and image['revision'] == source['revision']})
    previous_tag = receipt.get('source_tag', '')
    previous_revision = receipt.get('source_revision', '')
    require(STABLE_TAG.fullmatch(previous_tag) is not None
            and stable_version(previous_tag) < stable_version(source['tag'])
            and HEX40.fullmatch(previous_revision) is not None,
            'CACHE_PREVIOUS_RELEASE_IDENTITY_INVALID')
    previous_version = version_text(previous_tag)
    previous_ids = sorted({image['id'] for image in images
                           if image['source'] == IMAGE_SOURCE
                           and image['version'] == previous_version
                           and image['revision'] == previous_revision})
    require(bool(owned_ids) and bool(current_owned_ids) and bool(previous_ids)
            and set(current_receipt_ids).issubset(current_owned_ids)
            and set(current_runtime_ids).issubset(current_owned_ids)
            and set(previous_ids).issubset(owned_ids),
            'CACHE_PROTECTED_IMAGES_MISSING')
    config_hashes_value = source['config_hashes']
    require(isinstance(config_hashes_value, dict)
            and all(isinstance(key, str) and HEX64.fullmatch(value) is not None
                    for key, value in config_hashes_value.items()), 'CACHE_CONFIG_HASHES_INVALID')
    docker_root = docker('info', '--format', '{{.DockerRootDir}}')
    docker_root_path = Path(docker_root)
    require(docker_root_path.is_absolute() and len(docker_root) <= 4096
            and not any(ord(char) < 32 for char in docker_root), 'CACHE_DOCKER_ROOT_INVALID')
    HELPER.trusted(docker_root_path)
    os.statvfs(docker_root_path)
    return {
        'containers': containers,
        'volumes': volumes,
        'ownedImages': images,
        'unverifiedImages': image_inventory['unverifiedImages'],
        'ownedImageIds': owned_ids,
        'currentImageIds': current_owned_ids,
        'currentReceiptImageIds': current_receipt_ids,
        'previousImageIds': previous_ids,
        'previousTag': previous_tag,
        'previousRevision': previous_revision,
        'postgresId': source['postgres_id'],
        'migrationCount': len(source['source_manifest']),
        'migrationManifestSha256': migration_manifest_sha256(source['source_manifest']),
        'configHashes': dict(sorted(config_hashes_value.items())),
        'checkoutRevision': source['revision'],
        'deploymentReceiptSha256': hash_file(RESULT),
        'dockerRoot': str(docker_root_path),
    }


def _cache_protection_report(snapshot, plan_digest):
    return {
        'planDigest': plan_digest,
        'containerCount': len(snapshot['containers']),
        'containerSnapshotSha256': sha256(_cache_json_bytes(snapshot['containers'])),
        'volumeCount': len(snapshot['volumes']),
        'volumeSnapshotSha256': sha256(_cache_json_bytes(snapshot['volumes'])),
        'ownedImageIds': snapshot['ownedImageIds'],
        'ownedImageCount': len(snapshot['ownedImageIds']),
        'unverifiedImageCount': len(snapshot['unverifiedImages']),
        'unverifiedImages': [{'id': item['id'], 'reasons': item['reasons']}
                             for item in snapshot['unverifiedImages']],
        'currentImageIds': snapshot['currentImageIds'],
        'previousImageIds': snapshot['previousImageIds'],
        'previousTag': snapshot['previousTag'],
        'previousRevision': snapshot['previousRevision'],
        'postgresId': snapshot['postgresId'],
        'migrationCount': snapshot['migrationCount'],
        'migrationManifestSha256': snapshot['migrationManifestSha256'],
        'configHashes': snapshot['configHashes'],
        'checkoutRevision': snapshot['checkoutRevision'],
        'deploymentReceiptSha256': snapshot['deploymentReceiptSha256'],
    }


def _cache_installed_tooling():
    state = validate_state_file()
    require(sha256(Path(__file__).read_bytes()) == state['files']['deployer'],
            'INSTALLED_TOOL_HASH_INVALID')
    return state


def _cache_current_source(target_tag, target_revision):
    source = source_runtime_state(require_checkout=True)
    require(source['tag'] == target_tag and source['revision'] == target_revision,
            'CACHE_SOURCE_RELEASE_MISMATCH')
    return source


def _cache_plan_bytes(plan):
    data = _cache_json_bytes(plan)
    require(0 < len(data) <= 1024 * 1024, 'CACHE_PLAN_TOO_LARGE')
    return data


def _cache_validate_plan(plan_bytes, plan_digest, target_tag, target_revision,
                         tooling_revision, now=None):
    require(HEX64.fullmatch(plan_digest) is not None and sha256(plan_bytes) == plan_digest,
            'CACHE_PLAN_DIGEST_INVALID')
    try:
        plan = json.loads(plan_bytes, object_pairs_hook=_cache_unique_json_object)
    except (json.JSONDecodeError, TypeError, ValueError) as error:
        raise RuntimeError('STABLE_CACHE_PLAN_INVALID') from error
    expected = {'schema', 'operation', 'tag', 'revision', 'toolingRevision',
                'createdAt', 'expiresAt', 'protection', 'inventoryIds',
                'selectedRecords', 'summary'}
    require(isinstance(plan, dict) and set(plan) == expected
            and type(plan.get('schema')) is int and plan['schema'] == 1
            and plan.get('operation') == 'cache-maintenance-plan'
            and plan.get('tag') == target_tag and plan.get('revision') == target_revision
            and plan.get('toolingRevision') == tooling_revision,
            'CACHE_PLAN_IDENTITY_INVALID')
    created = plan.get('createdAt')
    expires = plan.get('expiresAt')
    current_time = time.time() if now is None else now
    require(type(created) is int and type(expires) is int
            and created <= current_time < expires
            and 0 < expires - created <= CACHE_PLAN_TTL_SECONDS,
            'CACHE_PLAN_EXPIRED_OR_INVALID')
    inventory_ids = plan.get('inventoryIds')
    require(isinstance(plan.get('protection'), dict)
            and isinstance(plan.get('summary'), dict)
            and isinstance(inventory_ids, list)
            and len(inventory_ids) <= CACHE_MAX_RECORDS
            and all(isinstance(item, str) and CACHE_RECORD_ID.fullmatch(item) is not None
                    for item in inventory_ids), 'CACHE_PLAN_CONTENT_INVALID')
    require(inventory_ids == sorted(set(inventory_ids)), 'CACHE_PLAN_CONTENT_INVALID')
    selected = plan.get('selectedRecords')
    require(isinstance(selected, list) and len(selected) <= CACHE_MAX_RECORDS,
            'CACHE_PLAN_CONTENT_INVALID')
    selected_ids = []
    for item in selected:
        require(isinstance(item, dict) and set(item) == {
            'id', 'type', 'sizeBytes', 'estimated', 'shared', 'reclaimable',
            'mutable', 'eligible', 'bucket'}, 'CACHE_PLAN_CONTENT_INVALID')
        identifier = item.get('id')
        cache_type = item.get('type')
        shared = item.get('shared')
        bucket = item.get('bucket')
        require(isinstance(identifier, str)
                and CACHE_RECORD_ID.fullmatch(identifier) is not None
                and identifier in inventory_ids
                and isinstance(cache_type, str) and cache_type in CACHE_TYPES
                and type(item.get('sizeBytes')) is int and item['sizeBytes'] >= 0
                and type(item.get('estimated')) is bool
                and type(shared) is bool
                and item.get('reclaimable') is True and type(item.get('mutable')) is bool
                and item.get('eligible') is True
                and bucket == ('shared' if shared else 'private') + 'Reclaimable',
                'CACHE_PLAN_CONTENT_INVALID')
        selected_ids.append(identifier)
    require(selected_ids == sorted(set(selected_ids)), 'CACHE_PLAN_CONTENT_INVALID')
    return plan


def _cache_candidate_selection(selected_records, inventory_ids, fresh_records):
    frozen = {item['id']: item for item in selected_records}
    current = {item['id']: item for item in fresh_records}
    selected, vanished, protected, changed = [], [], [], []
    for identifier, expected in sorted(frozen.items()):
        actual = current.get(identifier)
        if actual is None:
            vanished.append(identifier)
        elif not actual['eligible']:
            protected.append(identifier)
        elif actual != expected:
            changed.append(identifier)
        else:
            selected.append(identifier)
    appeared = sorted(set(current) - set(inventory_ids))
    return {'selected': selected, 'vanished': vanished, 'newlyProtected': protected,
            'changed': changed, 'newlyAppeared': appeared}


def _cache_plan_remaining(plan, monotonic_deadline=None):
    now = time.time()
    require(plan['createdAt'] <= now < plan['expiresAt'],
            'CACHE_PLAN_EXPIRED_OR_INVALID')
    remaining = plan['expiresAt'] - now
    if monotonic_deadline is not None:
        remaining = min(remaining, monotonic_deadline - time.monotonic())
    require(remaining > 0, 'CACHE_PLAN_EXPIRED_OR_INVALID')
    return remaining


def _cache_prune_ids(identifiers, *, timeout_seconds=600):
    require(isinstance(identifiers, list) and 0 < len(identifiers) <= 32
            and len(set(identifiers)) == len(identifiers)
            and all(isinstance(item, str) and CACHE_RECORD_ID.fullmatch(item) is not None
                    for item in identifiers), 'CACHE_PRUNE_ID_INVALID')
    filter_value = 'id~=^(' + '|'.join(identifiers) + ')$'
    require(len(filter_value) <= 4096, 'CACHE_PRUNE_FILTER_TOO_LARGE')
    require(type(timeout_seconds) in (int, float) and 0 < timeout_seconds <= 600,
            'CACHE_PRUNE_TIMEOUT_INVALID')
    docker('buildx', 'prune', '--builder', 'default', '--all', '--force',
           '--filter', filter_value, timeout=timeout_seconds)


def _cache_runtime_state(target_tag, target_revision):
    installed = _cache_installed_tooling()
    source = _cache_current_source(target_tag, target_revision)
    snapshot = _cache_protected_resource_snapshot(source)
    require(snapshot['checkoutRevision'] == target_revision,
            'CACHE_SOURCE_CHECKOUT_INVALID')
    return source, installed, snapshot


def _cache_write_audit(value):
    data = _cache_json_bytes(value)
    require(0 < len(data) <= 256 * 1024, 'CACHE_AUDIT_TOO_LARGE')
    atomic_install(CACHE_MAINTENANCE_AUDIT, data, 0o600)


def _cache_emit_report(value):
    data = _cache_json_bytes(value)
    require(len(data) <= 512 * 1024, 'CACHE_REPORT_TOO_LARGE')
    print('CACHE_MAINTENANCE_REPORT ' + data.decode('ascii'), flush=True)


def cache_inspect(target_tag, target_revision):
    source, installed, protection = _cache_runtime_state(target_tag, target_revision)
    records = _cache_read_records()
    summary = cache_summary(records)
    inventory_ids = [item['id'] for item in records]
    selected_records = [item for item in records if item['eligible']]
    now = int(time.time())
    plan = {
        'schema': 1, 'operation': 'cache-maintenance-plan',
        'tag': target_tag, 'revision': target_revision,
        'toolingRevision': installed['toolingRevision'],
        'createdAt': now, 'expiresAt': now + CACHE_PLAN_TTL_SECONDS,
        'protection': protection, 'inventoryIds': inventory_ids,
        'selectedRecords': selected_records, 'summary': summary,
    }
    plan_bytes = _cache_plan_bytes(plan)
    plan_digest = sha256(plan_bytes)
    report = {
        'schema': 1, 'operation': 'inspect', 'tag': target_tag,
        'revision': target_revision, 'summary': summary, 'records': records,
        'planDigest': plan_digest,
        'protection': _cache_protection_report(protection, plan_digest),
    }
    require(len(_cache_json_bytes(report)) <= 512 * 1024, 'CACHE_REPORT_TOO_LARGE')
    atomic_install(CACHE_MAINTENANCE_PLAN, plan_bytes, 0o600)
    _cache_write_audit({
        'schema': 1, 'operation': 'inspect', 'status': 'OK',
        'tag': target_tag, 'revision': target_revision,
        'toolingRevision': installed['toolingRevision'], 'planDigest': plan_digest,
        'createdAt': now, 'summary': summary,
        'selectedRecordIds': [item['id'] for item in selected_records],
        'protectionVerified': True,
    })
    _cache_emit_report(report)


def _cache_available_bytes(docker_root):
    info = os.statvfs(docker_root)
    return info.f_bavail * info.f_frsize


def cache_clean(target_tag, target_revision, plan_digest):
    require(HEX64.fullmatch(plan_digest) is not None, 'CACHE_PLAN_DIGEST_INVALID')
    plan_bytes = _read_trusted_host_file(CACHE_MAINTENANCE_PLAN, 0o600,
                                         1024 * 1024, 'CACHE_PLAN_INVALID')
    installed = _cache_installed_tooling()
    plan = _cache_validate_plan(plan_bytes, plan_digest, target_tag,
                                target_revision, installed['toolingRevision'])
    started_at = time.monotonic()
    monotonic_deadline = started_at + _cache_plan_remaining(plan)
    source, installed, protection_before = _cache_runtime_state(target_tag, target_revision)
    require(protection_before == plan['protection'], 'CACHE_PROTECTED_RESOURCE_DRIFT')
    records_before = _cache_read_records()
    summary_before = cache_summary(records_before)
    selection = _cache_candidate_selection(plan['selectedRecords'],
                                           plan['inventoryIds'], records_before)
    docker_root = protection_before['dockerRoot']
    available_before = _cache_available_bytes(docker_root)
    attempted = []
    vanished = set(selection['vanished'])
    newly_protected = set(selection['newlyProtected'])
    changed = set(selection['changed'])
    newly_appeared = set(selection['newlyAppeared'])
    pending = list(selection['selected'])
    protection_verified = True
    final_protection = protection_before
    try:
        while pending:
            _cache_plan_remaining(plan, monotonic_deadline)
            _source_now, _installed_now, current_protection = _cache_runtime_state(
                target_tag, target_revision)
            if current_protection != plan['protection']:
                protection_verified = False
                break
            fresh_records = _cache_read_records()
            fresh_selection = _cache_candidate_selection(
                plan['selectedRecords'], plan['inventoryIds'], fresh_records)
            fresh_candidates = [item for item in fresh_selection['selected'] if item in pending]
            vanished.update(item for item in fresh_selection['vanished'] if item in pending)
            newly_protected.update(item for item in fresh_selection['newlyProtected'] if item in pending)
            changed.update(item for item in fresh_selection['changed'] if item in pending)
            newly_appeared.update(fresh_selection['newlyAppeared'])
            if not fresh_candidates:
                break
            batch = fresh_candidates[:32]
            timeout_seconds = min(600, _cache_plan_remaining(plan, monotonic_deadline))
            attempted.extend(batch)
            _cache_prune_ids(batch, timeout_seconds=timeout_seconds)
            pending = [item for item in pending if item not in batch]
            _source_after, _installed_after, final_protection = _cache_runtime_state(
                target_tag, target_revision)
            if final_protection != plan['protection']:
                protection_verified = False
                break
            after_batch_records = _cache_read_records()
            newly_appeared.update(set(item['id'] for item in after_batch_records)
                                  - set(plan['inventoryIds']))
        final_records = _cache_read_records()
        summary_after = cache_summary(final_records)
        _source_final, _installed_final, final_protection = _cache_runtime_state(
            target_tag, target_revision)
        if final_protection != plan['protection']:
            protection_verified = False
        after_ids = {item['id'] for item in final_records}
        frozen_by_id = {item['id']: item for item in plan['selectedRecords']}
        final_by_id = {item['id']: item for item in final_records}
        for identifier in attempted:
            actual = final_by_id.get(identifier)
            if actual is not None and not actual['eligible']:
                newly_protected.add(identifier)
            elif actual is not None and actual != frozen_by_id[identifier]:
                changed.add(identifier)
        pruned_ids = sorted(set(attempted) - after_ids)
        remaining_ids = sorted(set(attempted) & after_ids)
        vanished.update(item for item in pending if item not in after_ids)
        newly_appeared.update(after_ids - set(plan['inventoryIds']))
        available_after = _cache_available_bytes(docker_root)
        checks = {
            'localHealth': True, 'publicHealth': True, 'database': True,
            'worker': True, 'migrationLedger': True,
        }
        report = {
            'schema': 1, 'operation': 'clean', 'tag': target_tag,
            'revision': target_revision, 'planDigest': plan_digest,
            'summaryBefore': summary_before, 'summaryAfter': summary_after,
            'prunedIds': pruned_ids, 'remainingIds': remaining_ids,
            'vanishedIds': sorted(vanished),
            'newlyProtectedIds': sorted(newly_protected),
            'changedIds': sorted(changed),
            'newlyAppearedIds': sorted(newly_appeared),
            'availableBytesBefore': available_before,
            'availableBytesAfter': available_after,
            'netAvailableBytesDelta': available_after - available_before,
            'protectionVerified': protection_verified,
            'checks': checks,
            'protection': _cache_protection_report(final_protection, plan_digest),
        }
        completed_at = int(time.time())
        _cache_write_audit({
            'schema': 1, 'operation': 'clean',
            'status': 'OK' if protection_verified else 'FAILED',
            'tag': target_tag, 'revision': target_revision,
            'toolingRevision': installed['toolingRevision'],
            'planDigest': plan_digest, 'completedAt': completed_at,
            'summaryBefore': summary_before, 'summaryAfter': summary_after,
            'attemptedIds': sorted(set(attempted)), 'prunedIds': pruned_ids,
            'remainingIds': remaining_ids, 'vanishedIds': sorted(vanished),
            'newlyProtectedIds': sorted(newly_protected),
            'changedIds': sorted(changed), 'newlyAppearedIds': sorted(newly_appeared),
            'availableBytesBefore': available_before,
            'availableBytesAfter': available_after,
            'netAvailableBytesDelta': available_after - available_before,
            'protectionVerified': protection_verified,
            'checks': checks,
        })
        _cache_emit_report(report)
        require(protection_verified, 'CACHE_PROTECTED_RESOURCE_DRIFT')
    except BaseException as error:
        _cache_write_audit({
            'schema': 1, 'operation': 'clean', 'status': 'FAILED',
            'tag': target_tag, 'revision': target_revision,
            'toolingRevision': installed['toolingRevision'],
            'planDigest': plan_digest, 'completedAt': int(time.time()),
            'attemptedIds': sorted(set(attempted)),
            'failureCode': safe_failure_code(error),
            'protectionVerified': protection_verified,
        })
        raise


_IMAGE_INSPECT_TEMPLATE = (
    '{{printf "[%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s]" '
    '(json .Id) '
    '(json (index .Config.Labels "org.opencontainers.image.title")) '
    '(json (index .Config.Labels "org.opencontainers.image.source")) '
    '(json (index .Config.Labels "org.opencontainers.image.version")) '
    '(json (index .Config.Labels "org.opencontainers.image.revision")) '
    '(json (index .Config.Labels "com.docker.compose.project")) '
    '(json (index .Config.Labels "com.docker.compose.service")) '
    '(json .RepoTags) (json .RepoDigests) (json .Size) (json .Os) (json .Architecture)}}'
)
_IMAGE_CONTAINER_TEMPLATE = (
    '{{printf "[%s,%s,%s]" (json .Id) (json .Image) (json .State.Status)}}'
)


def _image_parse_json(value, code):
    require(isinstance(value, str) and len(value) <= 256 * 1024
            and not any(ord(char) < 32 and char not in '\n\r\t' for char in value), code)
    try:
        return json.loads(value, object_pairs_hook=_cache_unique_json_object,
                          parse_constant=lambda _item: (_ for _ in ()).throw(ValueError()))
    except (json.JSONDecodeError, TypeError, ValueError) as error:
        raise RuntimeError('STABLE_' + code) from error


def _image_label_text(value, code):
    if value is None or value == '':
        return None, None
    if (not isinstance(value, str) or len(value) > 512
            or any(ord(char) < 32 for char in value)):
        return None, code
    return value, None


def _image_version_key(value):
    if not isinstance(value, str):
        return None
    match = IMAGE_VERSION.fullmatch(value)
    if match is None:
        return None
    major, minor, patch, development = match.groups()
    return (int(major), int(minor), int(patch), 0 if development is not None else 1,
            int(development) if development is not None else 0)


def _image_ref_repo(reference, kind):
    if not isinstance(reference, str) or not reference or len(reference) > 512:
        return False, None
    if kind == 'digest':
        if reference.count('@') != 1:
            return False, None
        repository, digest = reference.split('@', 1)
        if re.fullmatch(r'sha256:[a-f0-9]{64}', digest) is None:
            return False, None
    else:
        if '@' in reference or ':' not in reference:
            return False, None
        repository, tag = reference.rsplit(':', 1)
        if re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}', tag) is None:
            return False, None
    service_repositories = {}
    for service in HISTORICAL_IMAGE_SERVICES:
        service_repositories['ai-project-os-' + service] = service
        service_repositories['docker.io/library/ai-project-os-' + service] = service
    ghcr_repositories = {
        'ghcr.io/jack-kunlun/ai-project-os': None,
        'ghcr.io/jack-kunlun/ai-project-os-app': 'app',
        'ghcr.io/jack-kunlun/ai-project-os-worker': 'worker',
        'ghcr.io/jack-kunlun/ai-project-os-migrate': 'migrate',
    }
    if repository in service_repositories:
        return True, service_repositories[repository]
    if repository in ghcr_repositories:
        return True, ghcr_repositories[repository]
    return False, None


def _image_safe_reference_values(value, code):
    if value is None:
        return [], False
    require(isinstance(value, list) and len(value) <= CACHE_MAX_IMAGE_REFS, code)
    require(all(isinstance(item, str) and 0 < len(item) <= 65536
                and not any(ord(char) < 32 for char in item) for item in value), code)
    return value, len(value) != len(set(value))


def _image_inventory_ids():
    output = docker('image', 'ls', '--all', '--quiet', '--no-trunc', timeout=120)
    identifiers = output.splitlines() if output else []
    require(len(identifiers) <= CACHE_MAX_IMAGES * 8
            and all(re.fullmatch(r'sha256:[a-f0-9]{64}', item) is not None
                    for item in identifiers), 'IMAGE_INVENTORY_INVALID')
    unique = sorted(set(identifiers))
    require(len(unique) <= CACHE_MAX_IMAGES, 'IMAGE_INVENTORY_INVALID')
    return unique


def _image_container_inventory():
    output = docker('ps', '--all', '--quiet', '--no-trunc', timeout=120)
    identifiers = output.splitlines() if output else []
    require(len(identifiers) <= CACHE_MAX_CONTAINERS
            and all(HEX64.fullmatch(item) is not None for item in identifiers),
            'IMAGE_CONTAINER_INVENTORY_INVALID')
    require(len(identifiers) == len(set(identifiers)), 'IMAGE_CONTAINER_INVENTORY_INVALID')
    identifiers = sorted(set(identifiers))
    containers = []
    if identifiers:
        output = docker('inspect', '--format', _IMAGE_CONTAINER_TEMPLATE,
                        *identifiers, timeout=120)
        require(len(output) <= 512 * 1024, 'IMAGE_CONTAINER_INSPECT_INVALID')
        rows = output.splitlines()
        require(len(rows) == len(identifiers), 'IMAGE_CONTAINER_INSPECT_INVALID')
        for row in rows:
            value = _image_parse_json(row, 'IMAGE_CONTAINER_INSPECT_INVALID')
            require(isinstance(value, list) and len(value) == 3,
                    'IMAGE_CONTAINER_INSPECT_INVALID')
            identifier, image_id, status = value
            require(isinstance(identifier, str) and HEX64.fullmatch(identifier) is not None
                    and identifier in identifiers
                    and isinstance(image_id, str)
                    and re.fullmatch(r'sha256:[a-f0-9]{64}', image_id) is not None
                    and isinstance(status, str) and status in CACHE_CONTAINER_STATUSES,
                    'IMAGE_CONTAINER_INSPECT_INVALID')
            containers.append({'id': identifier, 'image': image_id, 'status': status})
        require(len({item['id'] for item in containers}) == len(containers),
                'IMAGE_CONTAINER_INSPECT_INVALID')
    containers.sort(key=lambda item: item['id'])
    return containers


def _image_raw_inspect(identifier):
    output = docker('image', 'inspect', '--format', _IMAGE_INSPECT_TEMPLATE,
                    identifier, timeout=120)
    require(len(output) <= 256 * 1024 and len(output.splitlines()) == 1,
            'IMAGE_INSPECT_INVALID')
    value = _image_parse_json(output, 'IMAGE_INSPECT_INVALID')
    require(isinstance(value, list) and len(value) == 12 and value[0] == identifier,
            'IMAGE_INSPECT_INVALID')
    (image_id, raw_title, raw_source, raw_version, raw_revision, raw_project,
     raw_service, raw_tags, raw_digests, size_bytes, operating_system,
     architecture) = value
    title, title_error = _image_label_text(raw_title, 'title-invalid')
    source, source_error = _image_label_text(raw_source, 'source-invalid')
    version, version_error = _image_label_text(raw_version, 'version-invalid')
    revision, revision_error = _image_label_text(raw_revision, 'revision-invalid')
    project, project_error = _image_label_text(raw_project, 'project-invalid')
    service, service_error = _image_label_text(raw_service, 'service-invalid')
    tags, duplicate_tags = _image_safe_reference_values(raw_tags, 'IMAGE_REFS_INVALID')
    digests, duplicate_digests = _image_safe_reference_values(raw_digests, 'IMAGE_REFS_INVALID')
    require(type(size_bytes) is int and 0 <= size_bytes <= 2 ** 63 - 1,
            'IMAGE_SIZE_INVALID')
    for platform_value in (operating_system, architecture):
        require(platform_value is None or (isinstance(platform_value, str)
                and re.fullmatch(r'[A-Za-z0-9_.-]{1,64}', platform_value) is not None),
                'IMAGE_PLATFORM_INVALID')
    return {
        'id': image_id,
        'rawLabels': [raw_title, raw_source, raw_version, raw_revision,
                      raw_project, raw_service],
        'title': title, 'source': source, 'version': version,
        'revision': revision, 'project': project, 'service': service,
        'labelErrors': [error for error in (title_error, source_error, version_error,
                                            revision_error, project_error, service_error)
                        if error is not None],
        'repoTags': tags, 'repoDigests': digests,
        'duplicateTags': duplicate_tags, 'duplicateDigests': duplicate_digests,
        'sizeBytes': size_bytes,
        'platform': {'os': operating_system, 'architecture': architecture},
    }


def _image_scope_snapshot():
    all_ids = _image_inventory_ids()
    container_inventory = _image_container_inventory()
    references_by_image = {}
    for container in container_inventory:
        references_by_image.setdefault(container['image'], []).append(
            {'id': container['id'], 'status': container['status']}
        )
    present_ids = set(all_ids)
    images = []
    for identifier in HISTORICAL_IMAGE_SCOPE:
        raw = _image_raw_inspect(identifier) if identifier in present_ids else None
        if raw is None:
            images.append(_image_record(identifier, None, []))
        else:
            images.append({'id': identifier, 'present': True,
                           'containerReferences': references_by_image.get(identifier, []),
                           '_raw': raw})
    return {'allImageIds': all_ids, 'containers': container_inventory, 'images': images}


def _image_record(identifier, raw, container_references):
    container_references = sorted(container_references, key=lambda item: (item['id'], item['status']))
    if raw is None:
        fingerprint = sha256(_cache_json_bytes({'id': identifier, 'present': False}))
        return {
            'id': identifier, 'present': False, 'version': None, 'service': None,
            'sourceKind': 'unknown', 'ownership': 'missing',
            'ownershipReasons': ['image-missing'], 'recognizedRepoTags': [],
            'recognizedRepoDigests': [], 'unknownRefCount': 0,
            'unknownRefsSha256': sha256(_cache_json_bytes([])),
            'containerReferences': [], 'sizeBytes': 0, 'platform': None,
            'eligible': False, 'retainReasons': ['image-missing'],
            'fingerprint': fingerprint,
        }

    ownership_reasons = list(raw['labelErrors'])
    source = raw['source']
    version = raw['version']
    service = raw['service']
    project = raw['project']
    if raw['title'] != 'AI Project OS':
        ownership_reasons.append('title-unrecognized')
    if source not in (None, '', IMAGE_SOURCE):
        ownership_reasons.append('source-unrecognized')
    legacy = source in (None, '')
    if legacy and project != PROJECT:
        ownership_reasons.append('legacy-project-unrecognized')
    if not legacy and project not in (None, '', PROJECT):
        ownership_reasons.append('compose-project-unrecognized')
    if service not in HISTORICAL_IMAGE_SERVICES:
        service = None
    if raw['service'] not in (None, '') and service is None:
        ownership_reasons.append('service-unrecognized')
    if raw['revision'] is not None and HEX40.fullmatch(raw['revision']) is None:
        ownership_reasons.append('revision-invalid')
    version_key = _image_version_key(version)
    if version_key is None:
        ownership_reasons.append('version-unrecognized')

    recognized_tags = []
    recognized_digests = []
    unknown_references = []
    reference_services = []
    for kind, refs, recognized in (
        ('tag', raw['repoTags'], recognized_tags),
        ('digest', raw['repoDigests'], recognized_digests),
    ):
        for reference in refs:
            valid, referenced_service = _image_ref_repo(reference, kind)
            historical = HISTORICAL_IMAGE_REFERENCE_EXCEPTIONS.get(identifier)
            if (not valid and historical is not None
                    and (version, service) == historical[:2]
                    and reference == historical[2 if kind == 'tag' else 3]):
                valid, referenced_service = True, historical[1]
            if not valid:
                unknown_references.append(reference)
                continue
            recognized.append(reference)
            if referenced_service is not None:
                reference_services.append(referenced_service)
                if service is not None and referenced_service != service:
                    ownership_reasons.append('repository-service-mismatch')
    if raw['duplicateTags'] or raw['duplicateDigests']:
        ownership_reasons.append('duplicate-repository-reference')
        unknown_references.extend(raw['repoTags'] if raw['duplicateTags'] else [])
        unknown_references.extend(raw['repoDigests'] if raw['duplicateDigests'] else [])
    recognized_tags[:] = sorted(set(recognized_tags))
    recognized_digests[:] = sorted(set(recognized_digests))
    inferred_services = sorted(set(reference_services))
    if service is None and len(inferred_services) == 1 and not legacy:
        service = inferred_services[0]
    if service not in HISTORICAL_IMAGE_SERVICES:
        ownership_reasons.append('service-unrecognized')
        service = None
    if len(inferred_services) > 1:
        ownership_reasons.append('repository-service-mismatch')
    if any(item not in HISTORICAL_IMAGE_SERVICES for item in reference_services):
        ownership_reasons.append('repository-service-unrecognized')
    if len(recognized_tags) > IMAGE_REF_DISPLAY_LIMIT:
        unknown_references.extend(recognized_tags[IMAGE_REF_DISPLAY_LIMIT:])
        recognized_tags = recognized_tags[:IMAGE_REF_DISPLAY_LIMIT]
        ownership_reasons.append('repository-reference-count-limit')
    if len(recognized_digests) > IMAGE_REF_DISPLAY_LIMIT:
        unknown_references.extend(recognized_digests[IMAGE_REF_DISPLAY_LIMIT:])
        recognized_digests = recognized_digests[:IMAGE_REF_DISPLAY_LIMIT]
        ownership_reasons.append('repository-reference-count-limit')
    if unknown_references:
        ownership_reasons.append('repository-reference-unrecognized')

    ownership_reasons = sorted(set(ownership_reasons))
    ownership = 'unconfirmed' if ownership_reasons else 'confirmed'
    version_threshold = None
    if version_key is not None:
        previous_tag = raw.get('previousTag')
        version_threshold = _image_version_key(previous_tag[1:]) if isinstance(previous_tag, str) \
            and STABLE_TAG.fullmatch(previous_tag) is not None else None
    retain_reasons = []
    if ownership != 'confirmed':
        retain_reasons.append('ownership-unconfirmed')
    if version_threshold is None:
        retain_reasons.append('previous-release-boundary-unavailable')
    elif version_key is not None and version_key >= version_threshold:
        retain_reasons.append('not-older-than-previous-release')
    if identifier in raw.get('currentImageIds', []):
        retain_reasons.append('current-release-image')
    if identifier in raw.get('previousImageIds', []):
        retain_reasons.append('previous-release-image')
    if container_references:
        retain_reasons.append('container-referenced')
    eligible = (ownership == 'confirmed' and version_key is not None
                and version_threshold is not None and version_key < version_threshold
                and identifier not in raw.get('currentImageIds', [])
                and identifier not in raw.get('previousImageIds', [])
                and not container_references)
    if eligible:
        retain_reasons = []
    raw_identity = {
        'id': identifier, 'present': True,
        'labels': raw['rawLabels'], 'repoTags': raw['repoTags'],
        'repoDigests': raw['repoDigests'], 'sizeBytes': raw['sizeBytes'],
        'platform': raw['platform'], 'containerReferences': container_references,
    }
    unknown_references = sorted(unknown_references)
    return {
        'id': identifier, 'present': True,
        'version': version if version_key is not None else None,
        'service': service,
        'sourceKind': ('legacy' if legacy else
                       'canonical' if source == IMAGE_SOURCE else 'unknown'),
        'ownership': ownership, 'ownershipReasons': ownership_reasons,
        'recognizedRepoTags': sorted(recognized_tags),
        'recognizedRepoDigests': sorted(recognized_digests),
        'unknownRefCount': len(unknown_references),
        'unknownRefsSha256': sha256(_cache_json_bytes(unknown_references)),
        'containerReferences': container_references,
        'sizeBytes': raw['sizeBytes'], 'platform': raw['platform'],
        'eligible': eligible, 'retainReasons': sorted(set(retain_reasons)),
        'fingerprint': sha256(_cache_json_bytes(raw_identity)),
    }


def _image_summary(records):
    return {
        'scopeCount': len(HISTORICAL_IMAGE_SCOPE),
        'presentCount': sum(1 for item in records if item['present']),
        'missingCount': sum(1 for item in records if not item['present']),
        'ownershipConfirmedCount': sum(1 for item in records
                                       if item['ownership'] == 'confirmed'),
        'eligibleCount': sum(1 for item in records if item['eligible']),
        'referencedCount': sum(1 for item in records if item['containerReferences']),
        'retainedCount': sum(1 for item in records if not item['eligible']),
        'sumImageSizeBytes': sum(item['sizeBytes'] for item in records if item['present']),
    }


def _image_plan_bytes(plan):
    data = _cache_json_bytes(plan)
    require(0 < len(data) <= 1024 * 1024, 'IMAGE_PLAN_TOO_LARGE')
    return data


def _image_validate_plan(plan_bytes, plan_digest, target_tag, target_revision,
                         tooling_revision, now=None):
    require(HEX64.fullmatch(plan_digest) is not None and sha256(plan_bytes) == plan_digest,
            'IMAGE_PLAN_DIGEST_INVALID')
    try:
        plan = json.loads(plan_bytes, object_pairs_hook=_cache_unique_json_object)
    except (json.JSONDecodeError, TypeError, ValueError) as error:
        raise RuntimeError('STABLE_IMAGE_PLAN_INVALID') from error
    expected = {'schema', 'operation', 'tag', 'revision', 'toolingRevision',
                'createdAt', 'expiresAt', 'scopeIds', 'protection', 'images',
                'eligibleIds', 'summary'}
    require(isinstance(plan, dict) and set(plan) == expected
            and type(plan.get('schema')) is int and plan['schema'] == 1
            and plan.get('operation') == 'image-maintenance-plan'
            and plan.get('tag') == target_tag and plan.get('revision') == target_revision
            and plan.get('toolingRevision') == tooling_revision
            and plan.get('scopeIds') == list(HISTORICAL_IMAGE_SCOPE),
            'IMAGE_PLAN_IDENTITY_INVALID')
    created = plan.get('createdAt')
    expires = plan.get('expiresAt')
    current_time = time.time() if now is None else now
    require(type(created) is int and type(expires) is int
            and created <= current_time < expires
            and 0 < expires - created <= CACHE_PLAN_TTL_SECONDS,
            'IMAGE_PLAN_EXPIRED_OR_INVALID')
    protection = plan.get('protection')
    require(isinstance(protection, dict)
            and set(protection) == {'base', 'allImageIds', 'containers'}
            and isinstance(protection.get('base'), dict)
            and isinstance(protection.get('allImageIds'), list)
            and protection['allImageIds'] == sorted(set(protection['allImageIds']))
            and all(re.fullmatch(r'sha256:[a-f0-9]{64}', item) is not None
                    for item in protection['allImageIds'])
            and isinstance(protection.get('containers'), list),
            'IMAGE_PLAN_CONTENT_INVALID')
    images = plan.get('images')
    require(isinstance(images, list) and len(images) == len(HISTORICAL_IMAGE_SCOPE),
            'IMAGE_PLAN_CONTENT_INVALID')
    expected_image_keys = {'id', 'present', 'version', 'service', 'sourceKind',
                           'ownership', 'ownershipReasons', 'recognizedRepoTags',
                           'recognizedRepoDigests', 'unknownRefCount', 'unknownRefsSha256',
                           'containerReferences', 'sizeBytes', 'platform', 'eligible',
                           'retainReasons', 'fingerprint'}
    for identifier, item in zip(HISTORICAL_IMAGE_SCOPE, images):
        require(isinstance(item, dict) and set(item) == expected_image_keys
                and item.get('id') == identifier and type(item.get('present')) is bool
                and type(item.get('eligible')) is bool
                and item.get('ownership') in ('confirmed', 'unconfirmed', 'missing')
                and type(item.get('unknownRefCount')) is int and item['unknownRefCount'] >= 0
                and all(HEX64.fullmatch(item.get(field, '')) is not None for field in
                        ('unknownRefsSha256', 'fingerprint'))
                and (type(item.get('sizeBytes')) is int and item['sizeBytes'] >= 0),
                'IMAGE_PLAN_CONTENT_INVALID')
    eligible_ids = plan.get('eligibleIds')
    require(isinstance(eligible_ids, list)
            and eligible_ids == sorted(set(eligible_ids))
            and eligible_ids == sorted(item['id'] for item in images if item['eligible']),
            'IMAGE_PLAN_CONTENT_INVALID')
    previous_tag = protection['base'].get('previousTag')
    require(STABLE_TAG.fullmatch(previous_tag or '') is not None,
            'IMAGE_PLAN_CONTENT_INVALID')
    previous_key = _image_version_key(version_text(previous_tag))
    protected_ids = set(protection['base'].get('currentImageIds', [])) | set(
        protection['base'].get('previousImageIds', [])
    )
    for item in images:
        if item['eligible']:
            image_key = _image_version_key(item['version'])
            require(item['ownership'] == 'confirmed' and item['present']
                    and not item['containerReferences'] and item['id'] not in protected_ids
                    and image_key is not None and image_key < previous_key,
                    'IMAGE_PLAN_CONTENT_INVALID')
    require(isinstance(plan.get('summary'), dict), 'IMAGE_PLAN_CONTENT_INVALID')
    return plan


def _image_cache_protection_after_removals(protection, removed_ids):
    expected = json.loads(_cache_json_bytes(protection))
    removed = set(removed_ids)
    for key in ('ownedImages', 'unverifiedImages'):
        expected[key] = [item for item in expected.get(key, []) if item.get('id') not in removed]
    for key in ('ownedImageIds', 'currentImageIds', 'currentReceiptImageIds',
                'previousImageIds'):
        expected[key] = [item for item in expected.get(key, []) if item not in removed]
    return expected


def _image_plan_protection(base_protection, snapshot):
    return {
        'base': base_protection,
        'allImageIds': snapshot['allImageIds'],
        'containers': snapshot['containers'],
    }


def _image_protection_matches(plan_protection, planned_images, base_protection,
                              snapshot, removed_ids):
    expected_base = _image_cache_protection_after_removals(
        plan_protection['base'], removed_ids,
    )
    expected_ids = sorted(set(plan_protection['allImageIds']) - set(removed_ids))
    expected_by_id = {item['id']: item for item in planned_images}
    actual_by_id = {item['id']: item for item in snapshot['images']}
    scope_matches = True
    for identifier in HISTORICAL_IMAGE_SCOPE:
        expected = expected_by_id[identifier]
        actual = actual_by_id[identifier]
        if identifier in removed_ids:
            scope_matches = scope_matches and not actual['present']
        else:
            scope_matches = scope_matches and actual == expected
    return (base_protection == expected_base
            and snapshot['allImageIds'] == expected_ids
            and snapshot['containers'] == plan_protection['containers']
            and scope_matches)


def _image_public_protection(base_protection, snapshot, plan_digest):
    report = _cache_protection_report(base_protection, plan_digest)
    report['allImageIds'] = snapshot['allImageIds']
    report['containerReferencesSha256'] = sha256(_cache_json_bytes(snapshot['containers']))
    report['scopeIds'] = list(HISTORICAL_IMAGE_SCOPE)
    return report


def _image_runtime_snapshot(target_tag, target_revision):
    source, installed, base_protection = _cache_runtime_state(target_tag, target_revision)
    scope_snapshot = _image_scope_snapshot()
    classified = []
    previous_tag = base_protection.get('previousTag')
    require(STABLE_TAG.fullmatch(previous_tag or '') is not None,
            'IMAGE_PREVIOUS_RELEASE_IDENTITY_INVALID')
    previous_key = _image_version_key(version_text(previous_tag))
    current_key = _image_version_key(source.get('version'))
    require(previous_key is not None and current_key is not None and previous_key < current_key,
            'IMAGE_RELEASE_BOUNDARY_INVALID')
    for record in scope_snapshot['images']:
        raw = record.pop('_raw', None)
        if raw is None:
            classified.append(record)
            continue
        raw['previousTag'] = previous_tag
        raw['currentImageIds'] = base_protection['currentImageIds']
        raw['previousImageIds'] = base_protection['previousImageIds']
        classified.append(_image_record(record['id'], raw, record['containerReferences']))
    scope_snapshot['images'] = classified
    return source, installed, base_protection, scope_snapshot


def image_inspect(target_tag, target_revision):
    source, installed, base_protection, snapshot = _image_runtime_snapshot(
        target_tag, target_revision,
    )
    summary = _image_summary(snapshot['images'])
    now = int(time.time())
    protection = _image_plan_protection(base_protection, snapshot)
    eligible_ids = sorted(item['id'] for item in snapshot['images'] if item['eligible'])
    plan = {
        'schema': 1, 'operation': 'image-maintenance-plan',
        'tag': target_tag, 'revision': target_revision,
        'toolingRevision': installed['toolingRevision'],
        'createdAt': now, 'expiresAt': now + CACHE_PLAN_TTL_SECONDS,
        'scopeIds': list(HISTORICAL_IMAGE_SCOPE), 'protection': protection,
        'images': snapshot['images'], 'eligibleIds': eligible_ids,
        'summary': summary,
    }
    plan_bytes = _image_plan_bytes(plan)
    plan_digest = sha256(plan_bytes)
    report = {
        'schema': 1, 'operation': 'image-inspect', 'tag': target_tag,
        'revision': target_revision, 'scopeIds': list(HISTORICAL_IMAGE_SCOPE),
        'summary': summary, 'images': snapshot['images'],
        'planDigest': plan_digest,
        'protection': _image_public_protection(base_protection, snapshot, plan_digest),
    }
    require(len(_cache_json_bytes(report)) <= 512 * 1024, 'IMAGE_REPORT_TOO_LARGE')
    atomic_install(IMAGE_MAINTENANCE_PLAN, plan_bytes, 0o600)
    _image_write_audit({
        'schema': 1, 'operation': 'image-inspect', 'status': 'OK',
        'tag': target_tag, 'revision': target_revision,
        'toolingRevision': installed['toolingRevision'], 'planDigest': plan_digest,
        'createdAt': now, 'summary': summary, 'eligibleIds': eligible_ids,
        'protectionVerified': True,
    })
    _image_emit_report(report)


def _image_available_bytes(docker_root):
    info = os.statvfs(docker_root)
    return info.f_bavail * info.f_frsize


def _image_remove_id(identifier, *, timeout_seconds):
    require(isinstance(identifier, str) and identifier in HISTORICAL_IMAGE_SCOPE
            and type(timeout_seconds) in (int, float) and 0 < timeout_seconds <= 600,
            'IMAGE_REMOVE_ARGUMENT_INVALID')
    executable = BINARIES['docker']
    HELPER.trusted(executable)
    require(stat.S_ISREG(Path(executable).stat().st_mode)
            and os.access(executable, os.X_OK), 'EXECUTABLE_INVALID')
    try:
        result = subprocess.run(
            [executable, 'image', 'rm', '--no-prune', identifier],
            env=PROCESS_ENV, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            timeout=timeout_seconds, check=False,
        )
    except subprocess.TimeoutExpired:
        return 'timeout'
    return 'removed-command-succeeded' if result.returncode == 0 else 'engine-refused'


def _image_write_audit(value):
    data = _cache_json_bytes(value)
    require(0 < len(data) <= 256 * 1024, 'IMAGE_AUDIT_TOO_LARGE')
    atomic_install(IMAGE_MAINTENANCE_AUDIT, data, 0o600)


def _image_emit_report(value):
    data = _cache_json_bytes(value)
    require(len(data) <= 512 * 1024, 'IMAGE_REPORT_TOO_LARGE')
    print('IMAGE_MAINTENANCE_REPORT ' + data.decode('ascii'), flush=True)


def image_clean(target_tag, target_revision, plan_digest):
    require(HEX64.fullmatch(plan_digest) is not None, 'IMAGE_PLAN_DIGEST_INVALID')
    plan_bytes = _read_trusted_host_file(IMAGE_MAINTENANCE_PLAN, 0o600,
                                         1024 * 1024, 'IMAGE_PLAN_INVALID')
    installed = _cache_installed_tooling()
    plan = _image_validate_plan(plan_bytes, plan_digest, target_tag,
                                target_revision, installed['toolingRevision'])
    monotonic_deadline = time.monotonic() + _cache_plan_remaining(plan)
    source, installed, base_protection, snapshot = _image_runtime_snapshot(
        target_tag, target_revision,
    )
    docker_root = base_protection['dockerRoot']
    available_before = _image_available_bytes(docker_root)
    summary_before = _image_summary(snapshot['images'])
    removed = set()
    retained = set()
    changed = set()
    newly_referenced = set()
    vanished = set()
    newly_appeared = set()
    engine_refused = set()
    attempted = []
    failure_reasons = {}
    protection_verified = _image_protection_matches(
        plan['protection'], plan['images'], base_protection, snapshot, removed,
    )
    all_image_inventory_drift = (
        snapshot['allImageIds'] != plan['protection']['allImageIds']
    )
    planned_by_id = {item['id']: item for item in plan['images']}
    fresh_by_id = {item['id']: item for item in snapshot['images']}
    for identifier in HISTORICAL_IMAGE_SCOPE:
        if planned_by_id[identifier]['present'] and not fresh_by_id[identifier]['present']:
            vanished.add(identifier)
    newly_appeared.update(
        item['id'] for item in snapshot['images']
        if item['present'] and not planned_by_id[item['id']]['present']
    )
    if not protection_verified:
        changed.update(
            item['id'] for item in snapshot['images']
            if item != planned_by_id[item['id']]
            and item['present'] and planned_by_id[item['id']]['present']
        )
        for identifier in HISTORICAL_IMAGE_SCOPE:
            if snapshot['images'][HISTORICAL_IMAGE_SCOPE.index(identifier)]['containerReferences'] \
                    and not planned_by_id[identifier]['containerReferences']:
                newly_referenced.add(identifier)
    checks = {
        'localHealth': True, 'publicHealth': True, 'database': True,
        'worker': True, 'migrationLedger': True,
    }
    expired_before_next_delete = False
    try:
        if protection_verified:
            for identifier in plan['eligibleIds']:
                try:
                    _cache_plan_remaining(plan, monotonic_deadline)
                except RuntimeError as error:
                    if safe_failure_code(error) != 'STABLE_CACHE_PLAN_EXPIRED_OR_INVALID':
                        raise
                    expired_before_next_delete = True
                    break
                _source_now, _installed_now, current_base, current_snapshot = \
                    _image_runtime_snapshot(target_tag, target_revision)
                if not _image_protection_matches(
                        plan['protection'], plan['images'], current_base,
                        current_snapshot, removed):
                    protection_verified = False
                    expected_image_ids = sorted(
                        set(plan['protection']['allImageIds']) - removed,
                    )
                    if current_snapshot['allImageIds'] != expected_image_ids:
                        all_image_inventory_drift = True
                    current_by_id = {item['id']: item for item in current_snapshot['images']}
                    frozen = planned_by_id[identifier]
                    actual = current_by_id[identifier]
                    if actual['containerReferences'] and not frozen['containerReferences']:
                        newly_referenced.add(identifier)
                    if actual['present'] and frozen['present'] \
                            and actual['fingerprint'] != frozen['fingerprint']:
                        changed.add(identifier)
                    for scope_id in HISTORICAL_IMAGE_SCOPE:
                        if scope_id in plan['protection']['allImageIds'] \
                                and scope_id not in current_snapshot['allImageIds'] \
                                and scope_id not in removed:
                            vanished.add(scope_id)
                        if scope_id in current_snapshot['allImageIds'] \
                                and scope_id not in plan['protection']['allImageIds']:
                            newly_appeared.add(scope_id)
                    break
                current_by_id = {item['id']: item for item in current_snapshot['images']}
                frozen = planned_by_id[identifier]
                actual = current_by_id[identifier]
                if not actual['present']:
                    vanished.add(identifier)
                    protection_verified = False
                    break
                if actual['fingerprint'] != frozen['fingerprint'] or not actual['eligible']:
                    retained.add(identifier)
                    changed.add(identifier)
                    if actual['containerReferences'] and not frozen['containerReferences']:
                        newly_referenced.add(identifier)
                    protection_verified = False
                    break
                remaining = _cache_plan_remaining(plan, monotonic_deadline)
                attempted.append(identifier)
                outcome = _image_remove_id(identifier, timeout_seconds=min(600, remaining))
                # Always take a fresh protected snapshot after a removal attempt, including
                # timeout/refusal, so a successful side effect is never inferred from exit code.
                _source_after, _installed_after, after_base, after_snapshot = \
                    _image_runtime_snapshot(target_tag, target_revision)
                after_by_id = {item['id']: item for item in after_snapshot['images']}
                is_gone = not after_by_id[identifier]['present']
                expected_removed = set(removed)
                if is_gone:
                    expected_removed.add(identifier)
                if not _image_protection_matches(
                        plan['protection'], plan['images'], after_base,
                        after_snapshot, expected_removed):
                    protection_verified = False
                    changed.update(
                        item['id'] for item in after_snapshot['images']
                        if item['present'] and planned_by_id[item['id']]['present']
                        and item['fingerprint'] != planned_by_id[item['id']]['fingerprint']
                    )
                    for scope_id in HISTORICAL_IMAGE_SCOPE:
                        if scope_id not in removed and scope_id != identifier \
                                and scope_id in plan['protection']['allImageIds'] \
                                and scope_id not in after_snapshot['allImageIds']:
                            vanished.add(scope_id)
                        if scope_id not in plan['protection']['allImageIds'] \
                                and scope_id in after_snapshot['allImageIds']:
                            newly_appeared.add(scope_id)
                    if after_by_id[identifier]['containerReferences'] \
                            and not frozen['containerReferences']:
                        newly_referenced.add(identifier)
                    if is_gone:
                        removed.add(identifier)
                    break
                if is_gone:
                    removed.add(identifier)
                else:
                    retained.add(identifier)
                    engine_refused.add(identifier)
                    failure_reasons[identifier] = (
                        'command-timeout' if outcome == 'timeout' else
                        'engine-refused' if outcome == 'engine-refused' else
                        'image-remains-after-remove'
                    )
    except BaseException as error:
        checks = {key: False for key in checks}
        _image_write_audit({
            'schema': 1, 'operation': 'image-clean', 'status': 'FAILED',
            'tag': target_tag, 'revision': target_revision,
            'toolingRevision': installed['toolingRevision'],
            'planDigest': plan_digest, 'completedAt': int(time.time()),
            'removedIds': sorted(removed), 'retainedIds': sorted(retained),
            'changedIds': sorted(changed), 'newlyReferencedIds': sorted(newly_referenced),
            'vanishedIds': sorted(vanished), 'engineRefusedIds': sorted(engine_refused),
            'attemptedIds': sorted(set(attempted)),
            'failureReasons': failure_reasons, 'failureCode': safe_failure_code(error),
            'protectionVerified': False,
        })
        raise

    _source_final, _installed_final, final_base, final_snapshot = _image_runtime_snapshot(
        target_tag, target_revision,
    )
    if not _image_protection_matches(plan['protection'], plan['images'], final_base,
                                     final_snapshot, removed):
        protection_verified = False
    if final_snapshot['allImageIds'] != sorted(
            set(plan['protection']['allImageIds']) - removed):
        all_image_inventory_drift = True
    final_by_id = {item['id']: item for item in final_snapshot['images']}
    for identifier in plan['eligibleIds']:
        if identifier not in removed and not final_by_id[identifier]['present']:
            vanished.add(identifier)
            protection_verified = False
    newly_appeared.update(
        item['id'] for item in final_snapshot['images']
        if item['present'] and not planned_by_id[item['id']]['present']
    )
    for identifier in plan['eligibleIds']:
        if identifier not in removed and final_by_id[identifier]['present'] \
                and final_by_id[identifier]['fingerprint'] != planned_by_id[identifier]['fingerprint']:
            changed.add(identifier)
            retained.add(identifier)
    summary_after = _image_summary(final_snapshot['images'])
    available_after = _image_available_bytes(final_base['dockerRoot'])
    checks = {key: bool(value) for key, value in checks.items()}
    report = {
        'schema': 1, 'operation': 'image-clean', 'tag': target_tag,
        'revision': target_revision, 'scopeIds': list(HISTORICAL_IMAGE_SCOPE),
        'planDigest': plan_digest, 'summaryBefore': summary_before,
        'summaryAfter': summary_after, 'removedIds': sorted(removed),
        'retainedIds': sorted((set(retained) | (set(plan['eligibleIds']) - removed)) - vanished),
        'changedIds': sorted(changed), 'newlyReferencedIds': sorted(newly_referenced),
        'vanishedIds': sorted(vanished), 'newlyAppearedIds': sorted(newly_appeared),
        'engineRefusedIds': sorted(engine_refused),
        'attemptedIds': sorted(set(attempted)),
        'failureReasons': failure_reasons,
        'expiredBeforeNextDelete': expired_before_next_delete,
        'allImageInventoryDrift': all_image_inventory_drift,
        'imagesAfter': final_snapshot['images'],
        'availableBytesBefore': available_before,
        'availableBytesAfter': available_after,
        'netAvailableBytesDelta': available_after - available_before,
        'protectionVerified': protection_verified,
        'checks': checks,
        'protection': _image_public_protection(final_base, final_snapshot, plan_digest),
    }
    completed_at = int(time.time())
    _image_write_audit({
        'schema': 1, 'operation': 'image-clean',
        'status': 'OK' if protection_verified else 'FAILED',
        'tag': target_tag, 'revision': target_revision,
        'toolingRevision': installed['toolingRevision'],
        'planDigest': plan_digest, 'completedAt': completed_at,
        'summaryBefore': summary_before, 'summaryAfter': summary_after,
        'removedIds': sorted(removed), 'retainedIds': report['retainedIds'],
        'changedIds': sorted(changed), 'newlyReferencedIds': sorted(newly_referenced),
        'vanishedIds': sorted(vanished), 'newlyAppearedIds': sorted(newly_appeared),
        'engineRefusedIds': sorted(engine_refused), 'attemptedIds': sorted(set(attempted)),
        'failureReasons': failure_reasons,
        'availableBytesBefore': available_before,
        'availableBytesAfter': available_after,
        'netAvailableBytesDelta': available_after - available_before,
        'protectionVerified': protection_verified, 'checks': checks,
    })
    _image_emit_report(report)
    require(protection_verified, 'IMAGE_PROTECTED_RESOURCE_DRIFT')


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


def require_ci(target_tag, revision, bootstrap=False, source_revision=None, classification=None, run_id=None):
    main_runs = [run for run in _ci_runs(revision, 'push')
                 if run.get('head_branch') == 'main' and run.get('head_sha') == revision
                 and run.get('event') == 'push' and run.get('status') == 'completed'
                 and run.get('conclusion') == 'success'
                 and (run_id is None or run.get('id') == run_id)]
    if bootstrap:
        require(any(_run_has_jobs(run, ('Verify source and client', 'Build and verify release images',
                                       'Verify database and release candidate')) for run in main_runs),
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
        required_jobs = ['Verify source and client', 'Build and verify release images', attestation]
        if attested_risk == 'high':
            required_jobs.append('Verify database and release candidate')
        for candidate in main_runs:
            if _run_has_jobs(candidate, required_jobs):
                return candidate
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
    literal_version = re.findall(r'org\.opencontainers\.image\.version="([^"]+)"', dockerfile)
    require(literal_version == [target_version]
            or (literal_version == ['${APP_VERSION}']
                and re.findall(r'^ARG APP_VERSION="([^"]+)"$', dockerfile, re.M) == [target_version]),
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
        require(result.get('release_protocol') in ('stable-v1', 'stable-v2-images'), 'STABLE_SOURCE_RECEIPT_INVALID')
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
        if result.get('release_protocol') in ('stable-v1', 'stable-v2-images'):
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
    if result.get('release_protocol') in ('stable-v1', 'stable-v2-images'):
        require(re.fullmatch(r'0|[1-9][0-9]*', result.get('migration_count', '')) is not None
                and int(result['migration_count']) == len(manifest), 'SOURCE_RECEIPT_MIGRATION_COUNT_INVALID')
        if result['release_protocol'] == 'stable-v1':
            backup_name = result.get('backup_name', '')
            if backup_name.startswith('"'):
                backup_name = json.loads(backup_name)
            require(backup_name_pattern(source_tag).fullmatch(backup_name) is not None,
                    'SOURCE_RECEIPT_BACKUP_INVALID')
            validate_source_restore_receipt(result, manifest)
        else:
            require(result.get('backup_name') == 'not-required'
                    and result.get('restore_policy') == 'disabled'
                    and result.get('migration_manifest_sha256') == migration_manifest_sha256(manifest),
                    'SOURCE_RECEIPT_POLICY_INVALID')
            recorded_images = json.loads(result.get('target_image_ids', 'null'))
            recorded_manifest = json.loads(result.get('ci_image_manifest', 'null'))
            require(isinstance(recorded_manifest, dict), 'SOURCE_IMAGE_MANIFEST_INVALID')
            validate_image_manifest(recorded_manifest, source_revision, source_version,
                                    recorded_manifest.get('runId'))
            require(isinstance(recorded_images, dict)
                    and all(writer['Image'] == recorded_images.get(service)
                            and writer['Config'].get('Labels', {}).get('org.opencontainers.image.revision')
                            == source_revision
                            for service, writer in zip(('app', 'worker', 'git-worker'), writers)),
                    'SOURCE_IMAGE_RECEIPT_MISMATCH')
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
    require(receipt.get('release_protocol') in ('stable-v1', 'stable-v2-images')
            and receipt.get('tag') == target_tag and receipt.get('revision') == target_revision,
            'ALREADY_CURRENT_RECEIPT_INVALID')
    if receipt['release_protocol'] == 'stable-v2-images':
        return ('STABLE_DEPLOY_ALREADY_CURRENT tag=' + target_tag + ' revision=' + target_revision
                + ' migration_count=' + str(len(source['source_manifest']))
                + ' backup=not-required restore=not-required')
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
    def __init__(self, target_tag, target_revision, credentials=None):
        self.target_tag = target_tag
        self.target_version = version_text(target_tag)
        self.target_revision = target_revision
        self.credentials = credentials
        self.image_manifest = None
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
        manifest_changed = self.target_manifest != self.source['source_manifest']
        require(not manifest_changed or self.release_classification['databaseRequired'],
                'NO_DATABASE_RELEASE_MIGRATION_CHANGED')
        # CI risk and production migration are separate decisions. Tooling or
        # ordinary server changes do not rerun 146 unchanged migrations/grants.
        self.database_required = manifest_changed
        self._validate_installed_state(self.target_files)
        self.already_current = self.target_tag == self.source['tag'] \
            and self.target_revision == self.source['revision']
        if not self.already_current:
            require(self.credentials is not None, 'WORKFLOW_CREDENTIALS_REQUIRED')
            ci_run = require_ci(self.target_tag, self.target_revision, source_revision=self.source['revision'],
                                classification=self.release_classification,
                                run_id=self.credentials['runId'])
            self.image_manifest = load_ci_images(ci_run, self.credentials,
                                                 self.target_revision, self.target_version)
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
        """Pull CI artifacts by digest. The production host never builds source."""
        compose('config', '--quiet')
        require(self.image_manifest is not None and self.credentials is not None,
                'CI_IMAGES_REQUIRED')
        manifest = validate_image_manifest(self.image_manifest, self.target_revision,
                                           self.target_version, self.credentials['runId'])
        images = {}
        with tempfile.TemporaryDirectory(prefix='.stable-registry-', dir='/var/lib/ai-project-os') as temporary:
            os.chmod(temporary, 0o700)
            # GITHUB_TOKEN expires with this Workflow; no permanent registry secret.
            executable = BINARIES['docker']
            HELPER.trusted(executable)
            login = subprocess.run(
                [executable, '--config', temporary, 'login', 'ghcr.io',
                 '--username', 'Jack-Kunlun', '--password-stdin'],
                input=self.credentials['token'] + '\n', env=PROCESS_ENV, text=True,
                stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=60, check=False)
            require(login.returncode == 0, 'REGISTRY_LOGIN_FAILED')
            for service, record in manifest['images'].items():
                docker('--config', temporary, 'pull', record['ref'], capture=False, timeout=1800)
                info = json.loads(docker('image', 'inspect', record['ref']))[0]
                images[service] = validate_pulled_image(
                    info, record, self.target_version, self.target_revision)
        # All worker roles use the identical worker image tested in CI.
        images.update({service: images['worker'] for service in
                       ('git-worker', 'reconcile', 'principal-bootstrap')})
        pin_path = Path('/var/lib/ai-project-os/.stable-images-' + secrets.token_hex(12) + '.yaml')
        self.pin_file = pin_path
        text = 'services:\n'
        for service, image_id in images.items():
            text += '  ' + service + ":\n    image: '" + image_id + "'\n    build: !reset null\n"
        HELPER.atomic_write(pin_path, text.encode('ascii'), 0o600)
        HELPER.trusted(pin_path, 0o600)
        compose('config', '--quiet', pin_file=pin_path)
        pinned = json.loads(compose('config', '--format', 'json', pin_file=pin_path))['services']
        require(all(pinned.get(service, {}).get('image') == image_id
                    and 'build' not in pinned[service] for service, image_id in images.items()),
                'PINNED_COMPOSE_BUILD_PRESENT')
        self.images = images
        return images

    def cleanup_old_images(self, source):
        # Called only after target health, ledger and receipt all succeeded.
        keep = set(self.images.values()) | set(source['writer_images'].values())
        previous = json.loads(source['receipt'].get('target_image_ids', '{}'))
        require(isinstance(previous, dict), 'IMAGE_HISTORY_INVALID')
        keep.update(previous.values())
        require(all(isinstance(value, str) and re.fullmatch(r'sha256:[a-f0-9]{64}', value)
                    for value in keep), 'IMAGE_HISTORY_INVALID')
        before_containers = docker('ps', '-aq', '--no-trunc').splitlines()
        before_volumes = docker('volume', 'ls', '-q').splitlines()
        if before_containers:
            infos = json.loads(docker('inspect', *before_containers))
            keep.update(info['Image'] for info in infos)
        candidates = set(docker('image', 'ls', '--quiet', '--no-trunc',
                                '--filter', 'label=org.opencontainers.image.title=AI Project OS').splitlines())
        removed = 0
        for identifier in sorted(candidates - keep):
            require(re.fullmatch(r'sha256:[a-f0-9]{64}', identifier) is not None,
                    'CLEANUP_IMAGE_ID_INVALID')
            info = json.loads(docker('image', 'inspect', identifier))[0]
            labels = info.get('Config', {}).get('Labels', {})
            tags = info.get('RepoTags') or []
            digests = info.get('RepoDigests') or []
            legacy = (labels.get('org.opencontainers.image.source') is None
                      and labels.get('org.opencontainers.image.title') == 'AI Project OS'
                      and labels.get('com.docker.compose.project') == PROJECT
                      and labels.get('com.docker.compose.service') in
                      ('app', 'worker', 'git-worker', 'migrate', 'reconcile', 'principal-bootstrap')
                      and re.fullmatch(r'(?:0|[1-9][0-9]*)\.[0-9]+\.[0-9]+(?:-dev\.[0-9]+)?',
                                       labels.get('org.opencontainers.image.version', '')) is not None
                      and all(re.fullmatch(r'ai-project-os-[a-z-]+(?::[^/]+)?', tag) for tag in tags))
            owned = (labels.get('org.opencontainers.image.source')
                     == 'https://github.com/Jack-Kunlun/ai-project-os' or legacy)
            require(info.get('Id') == identifier, 'CLEANUP_IMAGE_CHANGED')
            if not owned or any(not ref.startswith('ghcr.io/jack-kunlun/ai-project-os-') for ref in digests):
                continue
            # Removing explicit references without force leaves any newly referenced
            # image protected by Docker, including concurrent unrelated containers.
            try:
                docker('image', 'rm', *(tags + digests or [identifier]), capture=False)
                removed += 1
            except RuntimeError:
                print('STABLE_IMAGE_CLEANUP_IN_USE_SKIPPED', flush=True)
        cache_budget_met = prune_build_cache()
        require(docker('ps', '-aq', '--no-trunc').splitlines() == before_containers
                and docker('volume', 'ls', '-q').splitlines() == before_volumes,
                'CLEANUP_RESOURCE_IDENTITIES_CHANGED')
        filesystem = os.statvfs('/')
        print('STABLE_IMAGE_CLEANUP_OK removed=' + str(removed)
              + ' available_bytes=' + str(filesystem.f_bavail * filesystem.f_frsize)
              + ' retained=current-and-previous cache_target=2GB cache_budget_met='
              + str(cache_budget_met).lower(), flush=True)

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
        record = {
            'tag': self.target_tag, 'revision': self.target_revision,
            'source_tag': source['tag'], 'source_revision': source['revision'],
            'release_protocol': 'stable-v2-images',
            'source_postgres_container_id': source['postgres_id'],
            'target_writer_ids': self.target_writer_ids,
            'migration_count': len(self.target_manifest),
            'migration_manifest_sha256': migration_manifest_sha256(self.target_manifest),
            'backup_name': 'not-required', 'restore_policy': 'disabled',
            'source_config_hashes': source['config_hashes'],
            'target_nginx_sha256': sha256(self.target_files['nginx']),
            'target_image_ids': images, 'ci_image_manifest': self.image_manifest,
            'readonly_source_snapshot': source['database_snapshot'],
            'health': self.target_health,
            'completed_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        }
        plain_string_keys = {'tag', 'revision', 'source_tag', 'source_revision', 'release_protocol',
                             'migration_manifest_sha256', 'backup_name', 'restore_policy'}
        text = 'DEPLOY_OK\n' + ''.join(
            key + '=' + (value if key in plain_string_keys else
                         json.dumps(value, separators=(',', ':'), sort_keys=True)) + '\n'
            for key, value in record.items()
        )
        HELPER.atomic_write(RESULT, text.encode('utf-8'), 0o600)
        print('STABLE_DEPLOY_OK tag=' + self.target_tag + ' revision=' + self.target_revision
              + ' migration_count=' + str(len(self.target_manifest))
              + ' backup=not-required restore=not-required', flush=True)

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


def install_bootstrap(target_tag, target_revision, from_workflow=False):
    require(os.geteuid() == 0, 'ROOT_REQUIRED')
    stable_version(target_tag)
    self_path = Path(__file__).absolute()
    HELPER.trusted(self_path, 0o700 if from_workflow else 0o755)
    if from_workflow:
        installed = validate_state_file()
        require(self_path == DEPLOYER and sha256(self_path.read_bytes()) == installed['files']['deployer'],
                'INSTALLED_TOOL_HASH_INVALID')
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
    if from_workflow and source_revision == target_revision:
        _, files = validate_target_tree(target_revision, source_manifest, target_tag)
        require(all(installed['files'][name] == sha256(files[name]) for name in installed['files']),
                'ALREADY_CURRENT_TOOLING_MISMATCH')
        print('STABLE_TOOLING_ALREADY_READY tooling_revision=' + installed['toolingRevision'])
        return
    if stale_v104_receipt or recovered_source:
        require_ci(target_tag, target_revision, source_revision=RECOVERY_SOURCE_REVISION,
                   classification=_risk_result('high', ['recovery-receipt-reconciliation']))
    elif from_workflow:
        require_ci(target_tag, target_revision, source_revision=source_revision,
                   classification=classify_release_risk(ROOT, source_revision, target_revision))
    else:
        require_ci(target_tag, target_revision, bootstrap=True)
    _, files = validate_target_tree(target_revision, source_manifest, target_tag)
    if not from_workflow:
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
        if command == 'refresh':
            require(confirmation == 'CONFIRM_STABLE_TOOLING_FROM_CI', 'TOOLING_CONFIRMATION_INVALID')
            install_bootstrap(target_tag, revision, from_workflow=True)
            return
        if command in ('cache-inspect', 'cache-clean'):
            _cache_installed_tooling()
            if command == 'cache-inspect':
                require(confirmation == 'CONFIRM_CACHE_INSPECT',
                        'CACHE_INSPECT_CONFIRMATION_INVALID')
                cache_inspect(target_tag, revision)
                return
            require(HEX64.fullmatch(confirmation) is not None,
                    'CACHE_PLAN_DIGEST_INVALID')
            cache_clean(target_tag, revision, confirmation)
            return
        if command in ('image-inspect', 'image-clean'):
            _cache_installed_tooling()
            if command == 'image-inspect':
                require(confirmation == 'CONFIRM_IMAGE_INSPECT',
                        'IMAGE_INSPECT_CONFIRMATION_INVALID')
                image_inspect(target_tag, revision)
                return
            require(HEX64.fullmatch(confirmation) is not None,
                    'IMAGE_PLAN_DIGEST_INVALID')
            image_clean(target_tag, revision, confirmation)
            return
        require(command == 'deploy' and confirmation == 'CONFIRM_STABLE_CI_IMAGES',
                'DEPLOY_CONFIRMATION_INVALID')
        state = validate_state_file()
        for name, path in (
            ('deployer', DEPLOYER), ('backup', BACKUP), ('artifact_helper', ARTIFACT_HELPER),
            ('sudoers', SUDOERS), ('gateway', GATEWAY),
        ):
            require(sha256(path.read_bytes()) == state['files'][name], 'TOOLING_FILE_HASH_INVALID')
        require(sha256(Path(__file__).read_bytes()) == state['files']['deployer'], 'INSTALLED_TOOL_HASH_INVALID')
        credentials = read_release_credentials(sys.stdin)
        host = HostDeployment(target_tag, revision, credentials)
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
