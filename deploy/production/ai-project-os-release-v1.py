#!/usr/bin/python3 -I
"""Restricted dev.3 -> email candidate -> 1.0 cutover. No general deploy interface."""
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import stat
import sys
import tempfile
import time

ROOT = Path('/srv/ai-project-os/repository')
TOOL = Path('/usr/local/sbin/ai-project-os-release-v1')
STATE = Path('/etc/ai-project-os/release-tooling-v1.json')
JOURNAL = Path('/var/lib/ai-project-os/release-v1.json')
EMAIL_ENV = Path('/etc/ai-project-os/email-auth.env')
HELPER_HASH = '01c1f299098da8e4e9316e92d57e42bcf95e89eeee8424e4fe51395d6cc2d95e'
INITIAL_REVISION = 'bc90bc9daf928a841889f54280e240fc55209afa'
EMAIL_MIGRATION = '20261013010000_add_email_auth'
WRITERS = ('app', 'worker', 'git-worker')
CONFIRM = 'CONFIRM_V1_WITHOUT_BACKUP_OR_LEGACY_ACCEPTANCE'
BOOTSTRAP_CONFIRM = 'CONFIRM_INSTALL_V1_REVIEWED_TOOLING'
FILES = (
    ('deploy/production/ai-project-os-release-v1.py', str(TOOL), 0o700),
    ('deploy/production/ai-project-os-configure-email-auth.py', '/usr/local/sbin/ai-project-os-configure-email-auth', 0o755),
    ('deploy/production/ai-project-os-deploy.sudoers', '/etc/sudoers.d/ai-project-os-deploy', 0o440),
    # The gateway is promoted last, after its dependencies are in place.
    ('deploy/production/ai-project-os-actions-gateway', '/usr/local/sbin/ai-project-os-actions-gateway', 0o755),
)


def require(value, code):
    if not value:
        raise RuntimeError('RELEASE_V1_' + code)


def transition(source, target):
    require((source, target) in (('v0.8.0-dev.3', 'v0.8.0-dev.4'),
                                 ('v0.8.0-dev.4', 'v1.0.0')), 'TRANSITION_DENIED')
    return target == 'v0.8.0-dev.4'


def helper():
    path = ROOT / 'deploy/production/ai-project-os-v074-deploy.py'
    trusted(path)
    require(hashlib.sha256(path.read_bytes()).hexdigest() == HELPER_HASH, 'HELPER_HASH_INVALID')
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location('release_v1_host_helper', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def trusted(path, mode=None):
    path = Path(path)
    for part in [*reversed(path.parents), path]:
        info = part.lstat()
        require(info.st_uid == info.st_gid == 0 and not info.st_mode & 0o022
                and not stat.S_ISLNK(info.st_mode), 'HOST_PATH_UNTRUSTED')
    require(info.st_nlink == 1 or stat.S_ISDIR(info.st_mode), 'HOST_LINK_INVALID')
    if mode is not None:
        require(stat.S_ISREG(info.st_mode) and stat.S_IMODE(info.st_mode) == mode, 'HOST_MODE_INVALID')


def lock():
    directory = os.lstat('/run/lock')
    require(stat.S_ISDIR(directory.st_mode) and directory.st_uid == directory.st_gid == 0
            and stat.S_IMODE(directory.st_mode) == 0o1777, 'LOCK_DIRECTORY_INVALID')
    fd = os.open('/run/lock/ai-project-os-deploy.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == info.st_gid == 0
                and stat.S_IMODE(info.st_mode) == 0o600 and info.st_nlink == 1, 'LOCK_INVALID')
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return fd
    except BaseException:
        os.close(fd)
        raise


def write(path, content, mode):
    path = Path(path)
    trusted(path.parent)
    if path.exists() or path.is_symlink():
        trusted(path)
        require(stat.S_ISREG(path.lstat().st_mode), 'HOST_FILE_TYPE_INVALID')
    fd, name = tempfile.mkstemp(prefix='.release-v1-', dir=path.parent)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def git(lib, *args):
    return lib.run(['git', '-C', str(ROOT), *args])


def fetch_target(lib, tag, revision):
    require(tag in ('v0.8.0-dev.4', 'v1.0.0') and re.fullmatch(r'[0-9a-f]{40}', revision), 'TARGET_INVALID')
    git(lib, 'fetch', '--no-tags', 'origin', 'refs/tags/' + tag + ':refs/tags/' + tag,
        'refs/heads/main:refs/remotes/origin/main')
    require(git(lib, 'cat-file', '-t', 'refs/tags/' + tag) == 'tag', 'ANNOTATED_TAG_REQUIRED')
    require(git(lib, 'rev-parse', 'refs/tags/' + tag + '^{}') == revision
            and git(lib, 'rev-parse', 'refs/remotes/origin/main') == revision, 'TARGET_REVISION_INVALID')
    lib.TAG = tag
    lib.require_ci(revision)


def file_bytes(lib, revision, name):
    # git helper strips trailing whitespace, so binary-safe Git output is required here.
    import subprocess
    result = subprocess.run(['/usr/bin/git', '-C', str(ROOT), 'show', revision + ':' + name],
                            env=lib.PROCESS_ENV, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            timeout=30, check=False)
    require(result.returncode == 0, 'SOURCE_FILE_READ_FAILED')
    return result.stdout


def exact_manifest(lib, revision, count):
    # Migration checksums are over exact bytes, including all trailing newlines.
    names = git(lib, 'ls-tree', '-d', '--name-only', revision + ':prisma/migrations').splitlines()
    require(len(names) == count and len(set(names)) == count and names == sorted(names)
            and all(re.fullmatch(r'\d{14}_[a-z0-9_]+', name) for name in names), 'MANIFEST_INVALID')
    return [(name, hashlib.sha256(file_bytes(lib, revision, 'prisma/migrations/' + name + '/migration.sql')).hexdigest())
            for name in names]


def source_state(lib, tag, revision):
    trusted(lib.RESULT, 0o600)
    fields = dict(line.split('=', 1) for line in lib.RESULT.read_text().splitlines() if '=' in line)
    require(fields.get('tag') == tag and fields.get('revision') == revision, 'SOURCE_RECEIPT_INVALID')
    lib.healthy(tag[1:])
    lib.healthy(tag[1:], public=True)
    postgres = lib.container('postgres')
    require(postgres['Config']['Image'] == lib.IMAGE and postgres['State']['Running']
            and not postgres['State']['Paused']
            and postgres['State'].get('Health', {}).get('Status') == 'healthy', 'POSTGRES_INVALID')
    ports = postgres['NetworkSettings']['Ports'].get('5432/tcp')
    require(isinstance(ports, list) and len(ports) == 1 and ports[0]['HostIp'] == '127.0.0.1', 'DATABASE_NOT_ISOLATED')
    writers = [lib.container(service) for service in WRITERS]
    for writer in writers:
        require(writer['State']['Running'] and not writer['State']['Paused']
                and writer['State'].get('Health', {}).get('Status') == 'healthy'
                and writer['Config']['Labels'].get('org.opencontainers.image.version') == tag[1:], 'SOURCE_WRITER_INVALID')
        inspected = json.loads(lib.docker('image', 'inspect', writer['Image']))[0]
        require(inspected['Id'] == writer['Image'], 'SOURCE_IMAGE_ID_INVALID')
    app_env = dict(item.split('=', 1) for item in writers[0]['Config']['Env'] if '=' in item)
    require(app_env.get('AI_PROJECT_OS_WEB_BROWSER_ENABLED') != '1', 'BROWSER_SOURCE_ENABLED')
    return postgres['Id'], writers


def configuration(lib):
    for path, mode in ((lib.ENV, 0o600), (lib.OVERRIDE, None), (EMAIL_ENV, 0o600)):
        trusted(path, mode)
    values = {}
    for line in EMAIL_ENV.read_text().splitlines():
        key, separator, value = line.partition('=')
        require(separator and key not in values, 'EMAIL_CONFIGURATION_INVALID')
        values[key] = value
    require(set(values) == {'AI_PROJECT_OS_EMAIL_AUTH_ENABLED', 'AI_PROJECT_OS_ALIYUN_DM_ACCESS_KEY_ID',
                            'AI_PROJECT_OS_ALIYUN_DM_ACCESS_KEY_SECRET', 'AI_PROJECT_OS_ALIYUN_DM_REGION_ID',
                            'AI_PROJECT_OS_ALIYUN_DM_ACCOUNT_NAME'}
            and values['AI_PROJECT_OS_EMAIL_AUTH_ENABLED'] == 'true'
            and all(values.values()), 'EMAIL_CONFIGURATION_INVALID')
    return {path: hashlib.sha256(path.read_bytes()).digest() for path in (lib.ENV, lib.OVERRIDE, EMAIL_ENV)}


def unchanged(lib, hashes):
    require(configuration(lib) == hashes, 'CONFIGURATION_CHANGED')


def compose(lib, extra, *args, capture=True, timeout=600):
    return lib.run(['docker', 'compose', '--project-name', lib.PROJECT, '--env-file', str(lib.ENV),
                    '--project-directory', str(ROOT), '--file', str(ROOT / 'compose.yaml'),
                    '--file', str(lib.OVERRIDE), '--file', str(extra), *args], capture=capture, timeout=timeout)


def image_override(path, images):
    write(path, json.dumps({'services': {service: {'image': image, 'pull_policy': 'never'}
                                       for service, image in images.items()}}, sort_keys=True).encode(), 0o600)


def target_images(lib, references, version):
    result = {}
    for service, reference in references.items():
        image = json.loads(lib.docker('image', 'inspect', reference))[0]
        require(re.fullmatch(r'sha256:[0-9a-f]{64}', image['Id'])
                and image['Config']['Labels'].get('org.opencontainers.image.version') == version, 'TARGET_IMAGE_INVALID')
        result[service] = image['Id']
    return result


def wait_ready(lib, tag, image_ids):
    for _ in range(120):
        try:
            for service in WRITERS:
                item = lib.container(service)
                require(item['State']['Running'] and not item['State']['Paused']
                        and item['State'].get('Health', {}).get('Status') == 'healthy'
                        and item['Image'] == image_ids[service]
                        and item['Config']['Labels'].get('org.opencontainers.image.version') == tag[1:], 'TARGET_WRITER_INVALID')
            body = lib.healthy(tag[1:])
            lib.healthy(tag[1:], public=True)
            return body
        except (RuntimeError, OSError, ValueError):
            time.sleep(2)
    raise RuntimeError('RELEASE_V1_HEALTH_TIMEOUT')


def journal(data, phase):
    write(JOURNAL, json.dumps({**data, 'phase': phase, 'recordedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())},
                             sort_keys=True).encode(), 0o600)


def validate_stable_delta(lib, source, target):
    allowed = {'package.json', 'Dockerfile', 'src/lib/version.ts', 'test/release-version-identity.test.ts',
               'README.md', 'docs/releases/v1.0.0.md'}
    changed = set(git(lib, 'diff', '--no-renames', '--name-only', source, target).splitlines())
    require(changed <= allowed and {'package.json', 'Dockerfile', 'src/lib/version.ts'} <= changed, 'STABLE_DELTA_INVALID')
    before, after = [json.loads(file_bytes(lib, ref, 'package.json')) for ref in (source, target)]
    require(before.pop('version') == '0.8.0-dev.4' and after.pop('version') == '1.0.0'
            and before == after, 'STABLE_PACKAGE_DELTA_INVALID')
    for path in ('Dockerfile', 'src/lib/version.ts'):
        require(file_bytes(lib, source, path).replace(b'0.8.0-dev.4', b'1.0.0') == file_bytes(lib, target, path),
                'STABLE_CODE_DELTA_INVALID')


def validate_nginx_path(lib):
    trusted(lib.NGINX, 0o644)
    enabled = Path('/etc/nginx/sites-enabled/ai-project-os.conf')
    trusted(enabled.parent)
    enabled_info = enabled.lstat()
    require(stat.S_ISLNK(enabled_info.st_mode) and enabled_info.st_uid == enabled_info.st_gid == 0
            and enabled.resolve() == lib.NGINX, 'NGINX_ENABLED_PATH_INVALID')
    trusted('/etc/nginx/snippets/ai-project-os-proxy.conf')


def deploy(lib, args):
    require(len(args) == 5 and args[4] == CONFIRM, 'ARGUMENTS_INVALID')
    source_tag, target_tag, source_revision, target_revision = args[:4]
    migrate = transition(source_tag, target_tag)
    require(all(re.fullmatch(r'[0-9a-f]{40}', value) for value in (source_revision, target_revision))
            and source_revision != target_revision, 'REVISION_INVALID')
    require(not migrate or source_revision == INITIAL_REVISION, 'INITIAL_SOURCE_INVALID')
    require(git(lib, 'remote', 'get-url', 'origin') == lib.REMOTE
            and not git(lib, 'status', '--porcelain')
            and git(lib, 'rev-parse', 'HEAD') == source_revision, 'SOURCE_CHECKOUT_INVALID')
    fetch_target(lib, target_tag, target_revision)
    git(lib, 'merge-base', '--is-ancestor', source_revision, target_revision)
    require(file_bytes(lib, target_revision, FILES[0][0]) == TOOL.read_bytes(), 'INSTALLED_TOOL_TARGET_MISMATCH')
    for name, destination, _ in FILES:
        require(file_bytes(lib, target_revision, name) == Path(destination).read_bytes(), 'INSTALLED_TOOLING_TARGET_MISMATCH')
    if not migrate:
        validate_stable_delta(lib, source_revision, target_revision)
    before = exact_manifest(lib, source_revision, 142 if migrate else 143)
    after = exact_manifest(lib, target_revision, 143)
    require((after[:-1] == before and after[-1][0] == EMAIL_MIGRATION) if migrate else after == before, 'MIGRATION_DELTA_INVALID')
    postgres_id, old_writers = source_state(lib, source_tag, source_revision)
    lib.ledger(postgres_id, before)
    hashes = configuration(lib)
    version = lib.docker('compose', 'version', '--short').lstrip('v').split('.')
    require(len(version) >= 2 and tuple(map(int, version[:2])) >= (2, 30), 'COMPOSE_RAW_ENV_UNSUPPORTED')
    validate_nginx_path(lib)
    nginx_before = lib.NGINX.read_bytes()
    captured = {service: item['Image'] for service, item in zip(WRITERS, old_writers)}
    data = {'sourceTag': source_tag, 'targetTag': target_tag, 'sourceRevision': source_revision,
            'targetRevision': target_revision, 'postgresId': postgres_id, 'sourceImages': captured,
            'migrationCountBefore': len(before), 'migrationCountAfter': len(after),
            'backup': 'waived_by_user', 'restoreAndLegacyData': 'waived_by_user', 'ci': 'full_exact_main_and_tag'}
    # Fixed root-only temporary files cannot be selected through SSH arguments.
    with tempfile.TemporaryDirectory(prefix='.release-v1-', dir='/etc/ai-project-os') as temporary:
        extra = Path(temporary) / 'images.json'
        services = ('migrate', 'reconcile', *WRITERS) if migrate else WRITERS
        references = {service: 'ai-project-os-v1-' + service + ':' + target_revision for service in services}
        image_override(extra, references)
        migration_started = recreation_started = stopped = completed = False
        try:
            git(lib, 'checkout', '--detach', target_revision)
            require(json.loads((ROOT / 'package.json').read_text())['version'] == target_tag[1:]
                    and 'APP_VERSION = "' + target_tag[1:] + '"' in (ROOT / 'src/lib/version.ts').read_text()
                    and 'org.opencontainers.image.version="' + target_tag[1:] + '"' in (ROOT / 'Dockerfile').read_text(),
                    'TARGET_VERSION_INVALID')
            compose(lib, extra, 'config', '--quiet')
            compose(lib, extra, 'build', *services, capture=False, timeout=7200)
            images = target_images(lib, references, target_tag[1:])
            data['targetImages'] = images
            pg_after, writers_after = source_state(lib, source_tag, source_revision)
            require(pg_after == postgres_id and [(x['Id'], x['Image']) for x in writers_after]
                    == [(x['Id'], x['Image']) for x in old_writers], 'SOURCE_CHANGED_DURING_BUILD')
            unchanged(lib, hashes)
            lib.ledger(postgres_id, before)
            if migrate:
                require(lib.db_query(postgres_id, '''SELECT to_json(count(*)) FROM
                    (SELECT lower(btrim("email")) FROM public."AppUser" WHERE "email" IS NOT NULL
                     GROUP BY lower(btrim("email")) HAVING count(*)>1) d''') == 0, 'NORMALIZED_EMAIL_DUPLICATES')
            journal(data, 'built_source_healthy')
            stopped = True
            lib.docker('stop', *[item['Id'] for item in old_writers])
            lib.stopped(postgres_id)
            unchanged(lib, hashes)
            lib.ledger(postgres_id, before)
            journal(data, 'writers_stopped')
            write(lib.NGINX, (ROOT / 'deploy/production/nginx/ai-project-os.conf').read_bytes(), 0o644)
            lib.run(['nginx', '-t'])
            lib.run(['systemctl', 'reload', 'nginx'])
            if migrate:
                migration_started = True
                journal(data, 'migration_started')
                compose(lib, extra, 'up', '-d', '--no-deps', '--no-build', '--force-recreate', 'migrate')
                lib.wait_service('migrate')
                lib.stopped(postgres_id)
                compose(lib, extra, 'up', '-d', '--no-deps', '--no-build', '--force-recreate', 'reconcile')
                lib.wait_service('reconcile')
                lib.stopped(postgres_id)
                lib.ledger(postgres_id, after)
            unchanged(lib, hashes)
            recreation_started = True
            journal(data, 'writers_recreation_started')
            # Use immutable local image IDs, even if a tag changes after the build.
            image_override(extra, {service: images[service] for service in WRITERS})
            compose(lib, extra, 'up', '-d', '--no-deps', '--no-build', '--force-recreate', *WRITERS)
            health = wait_ready(lib, target_tag, images)
            require(lib.container('postgres')['Id'] == postgres_id, 'POSTGRES_CHANGED')
            unchanged(lib, hashes)
            lib.ledger(postgres_id, after)
            metadata = lib.request_json('https://ai-project-os.com/.well-known/oauth-protected-resource/api/mcp')
            require(metadata.get('resource') == 'https://ai-project-os.com/api/mcp'
                    and metadata.get('authorization_servers') == ['https://ai-project-os.com']
                    and 'project:read' in metadata.get('scopes_supported', []), 'MCP_METADATA_INVALID')
            app_env = dict(item.split('=', 1) for item in lib.container('app')['Config']['Env'] if '=' in item)
            require(app_env.get('AI_PROJECT_OS_EMAIL_AUTH_ENABLED') == 'true'
                    and app_env.get('AI_PROJECT_OS_WEB_BROWSER_ENABLED') != '1'
                    and all(app_env.get(key) == value for key, value in
                            (line.split('=', 1) for line in EMAIL_ENV.read_text().splitlines())), 'EMAIL_RUNTIME_CONFIG_INVALID')
            record = ('DEPLOY_OK\ntag=' + target_tag + '\nsource_tag=' + source_tag + '\nsource_revision=' + source_revision
                      + '\nrevision=' + target_revision + '\nmigration_count=143\nbackup_acceptance=waived_by_user'
                      + '\nrestore_legacy_acceptance=waived_by_user\nci_acceptance=full_exact_main_and_tag\nhealth='
                      + json.dumps(health, separators=(',', ':')) + '\ncompleted_at='
                      + time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()) + '\n')
            completed = True
            write(lib.RESULT, record.encode(), 0o600)
            journal(data, 'completed')
            print('RELEASE_V1_DEPLOY_OK tag=' + target_tag + ' revision=' + target_revision + ' migration_count=143', flush=True)
        except BaseException:
            if completed:
                print('RELEASE_V1_CUTOVER_HEALTHY_RECEIPT_OR_JOURNAL_INCOMPLETE', file=sys.stderr)
            elif migration_started:
                lib.quiesce_after_failure(postgres_id)
                journal(data, 'migration_attempted_manual_recovery_required')
                print('RELEASE_V1_FAILED writers_stopped=true manual_recovery_required=true', file=sys.stderr)
            elif recreation_started:
                lib.quiesce_after_failure(postgres_id)
                unchanged(lib, hashes)
                lib.ledger(postgres_id, before)
                git(lib, 'checkout', '--detach', source_revision)
                image_override(extra, captured)
                write(lib.NGINX, nginx_before, 0o644)
                lib.run(['nginx', '-t'])
                lib.run(['systemctl', 'reload', 'nginx'])
                compose(lib, extra, 'up', '-d', '--no-deps', '--no-build', '--force-recreate', *WRITERS)
                wait_ready(lib, source_tag, captured)
                journal(data, 'failed_source_images_restored')
                print('RELEASE_V1_FAILED source_images_restored=true', file=sys.stderr)
            else:
                git(lib, 'checkout', '--detach', source_revision)
                if stopped:
                    write(lib.NGINX, nginx_before, 0o644)
                    lib.run(['nginx', '-t'])
                    lib.run(['systemctl', 'reload', 'nginx'])
                    lib.restart_source(old_writers)
                    wait_ready(lib, source_tag, captured)
                journal(data, 'failed_before_recreation_source_preserved')
                print('RELEASE_V1_FAILED source_preserved=true', file=sys.stderr)
            raise


def bootstrap(lib, args):
    require(len(args) == 3 and args[0] == 'v0.8.0-dev.4' and args[2] == BOOTSTRAP_CONFIRM, 'BOOTSTRAP_ARGUMENTS_INVALID')
    tag, revision = args[:2]
    require(git(lib, 'rev-parse', 'HEAD') == INITIAL_REVISION
            and not git(lib, 'status', '--porcelain')
            and git(lib, 'remote', 'get-url', 'origin') == lib.REMOTE, 'BOOTSTRAP_SOURCE_INVALID')
    source_state(lib, 'v0.8.0-dev.3', INITIAL_REVISION)
    fetch_target(lib, tag, revision)
    require(file_bytes(lib, revision, FILES[0][0]) == Path(__file__).read_bytes(), 'BOOTSTRAP_TOOL_TARGET_MISMATCH')
    content = {destination: file_bytes(lib, revision, name) for name, destination, _ in FILES}
    old = {}
    for _, destination, mode in FILES:
        path = Path(destination)
        trusted(path.parent)
        if path.exists() or path.is_symlink():
            trusted(path)
            require(stat.S_ISREG(path.lstat().st_mode), 'BOOTSTRAP_DESTINATION_INVALID')
            old[destination] = (path.read_bytes(), stat.S_IMODE(path.lstat().st_mode))
        else:
            old[destination] = None
    import subprocess
    with tempfile.TemporaryDirectory(prefix='.release-v1-validate-', dir='/etc/ai-project-os') as temporary:
        sudoers = Path(temporary) / 'sudoers'
        sudoers.write_bytes(content['/etc/sudoers.d/ai-project-os-deploy'])
        result = subprocess.run(['/usr/sbin/visudo', '-cf', str(sudoers)], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        require(result.returncode == 0, 'BOOTSTRAP_SUDOERS_INVALID')
        result = subprocess.run(['/usr/bin/bash', '-n'], input=content['/usr/local/sbin/ai-project-os-actions-gateway'],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        require(result.returncode == 0, 'BOOTSTRAP_GATEWAY_INVALID')
    promoted = []
    try:
        for _, destination, mode in FILES:
            path = Path(destination)
            write(path, content[destination], mode)
            promoted.append(destination)
        state = {'tag': tag, 'revision': revision,
                 'files': {destination: hashlib.sha256(content[destination]).hexdigest() for destination in content}}
        write(STATE, json.dumps(state, sort_keys=True).encode(), 0o600)
    except BaseException:
        for destination in reversed(promoted):
            previous = old[destination]
            if previous is None:
                Path(destination).unlink()
            else:
                data, mode = previous
                write(destination, data, mode)
        raise
    print('RELEASE_V1_TOOLING_READY tag=' + tag + ' revision=' + revision, flush=True)


def status():
    trusted(STATE, 0o600)
    data = json.loads(STATE.read_text())
    require(data.get('tag') == 'v0.8.0-dev.4' and re.fullmatch(r'[0-9a-f]{40}', data.get('revision', '')),
            'TOOLING_STATE_INVALID')
    require(set(data.get('files', {})) == {destination for _, destination, _ in FILES}, 'TOOLING_STATE_INVALID')
    for _, destination, mode in FILES:
        trusted(destination, mode)
        require(hashlib.sha256(Path(destination).read_bytes()).hexdigest() == data['files'][destination], 'TOOLING_CHECKSUM_INVALID')
    print(json.dumps({'kind': 'RELEASE_V1_TOOLING_READY', **data}, sort_keys=True))


def main(args):
    require(os.geteuid() == 0, 'ROOT_REQUIRED')
    os.umask(0o077)
    trusted(Path(__file__).absolute(), 0o700)
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(RuntimeError('RELEASE_V1_INTERRUPTED')))
    fd = lock()
    try:
        if args == ['--status']:
            status()
        elif args and args[0] == 'bootstrap':
            bootstrap(helper(), args[1:])
        else:
            status()
            deploy(helper(), args)
    finally:
        os.close(fd)


if __name__ == '__main__':
    try:
        main(sys.argv[1:])
    except BaseException as error:
        value = str(error)
        print(value if isinstance(error, RuntimeError) and re.fullmatch(r'(?:RELEASE_V1|V074)_[A-Z0-9_]+', value)
              else 'RELEASE_V1_UNEXPECTED_FAILURE', file=sys.stderr)
        sys.exit(1)
