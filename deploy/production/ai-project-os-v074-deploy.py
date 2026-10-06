#!/usr/bin/python3
"""Exact, human-operated 0.7.3 -> 0.7.4 cutover; no historical tag dependency."""
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import signal
import stat
import subprocess
import sys
import time
import urllib.request
import fcntl

ROOT = Path('/srv/ai-project-os/repository')
ENV = Path('/etc/ai-project-os/production.env')
OVERRIDE = Path('/etc/ai-project-os/compose.operations.yaml')
RESULT = Path('/var/lib/ai-project-os/last-deployment')
NGINX = Path('/etc/nginx/sites-available/ai-project-os.conf')
SOURCE_REVISION = '9f4b34b746d9433e51fbf0c2e00d375fa841aac0'
TAG = 'v0.7.4'
PROJECT = 'ai-project-os'
REMOTE = 'https://github.com/Jack-Kunlun/ai-project-os.git'
IMAGE = 'pgvector/pgvector:0.8.6-pg18-trixie@sha256:78bf48b801e792f99e3ac62b5036fd3876e9be48afda16c1e331af1c75ceb2ff'
BINARIES = {'docker': '/usr/bin/docker', 'git': '/usr/bin/git', 'nginx': '/usr/sbin/nginx', 'systemctl': '/usr/bin/systemctl'}
PROCESS_ENV = {'PATH': '/usr/sbin:/usr/bin', 'HOME': '/root', 'LANG': 'C.UTF-8'}


def require(condition, code):
    if not condition:
        raise RuntimeError('V074_' + code)


def trusted(path, mode=None):
    path = Path(path)
    for part in [*reversed(path.parents), path]:
        info = part.lstat()
        require(info.st_uid == 0 and info.st_gid == 0 and not info.st_mode & 0o022,
                'HOST_PATH_UNTRUSTED')
        require(not stat.S_ISLNK(info.st_mode), 'HOST_SYMLINK_REJECTED')
    if mode is not None:
        require(stat.S_ISREG(path.stat().st_mode) and stat.S_IMODE(path.stat().st_mode) == mode,
                'HOST_FILE_MODE_INVALID')


def run(args, capture=True, timeout=600):
    # Never print a subprocess exception: argv/output could contain host secrets.
    executable = BINARIES[args[0]]
    trusted(executable)
    require(stat.S_ISREG(Path(executable).stat().st_mode) and os.access(executable, os.X_OK), 'EXECUTABLE_INVALID')
    result = subprocess.run([executable, *args[1:]], env=PROCESS_ENV, text=True, stdout=subprocess.PIPE if capture else None,
                            stderr=subprocess.PIPE, timeout=timeout, check=False)
    require(result.returncode == 0, 'COMMAND_FAILED_' + Path(args[0]).name.upper().replace('-', '_'))
    return result.stdout.strip() if capture else ''


def docker(*args):
    return run(['docker', *args])


def compose(*args, capture=True, timeout=600):
    return run(['docker', 'compose', '--project-name', PROJECT, '--env-file', str(ENV),
                '--project-directory', str(ROOT), '--file', str(ROOT / 'compose.yaml'),
                '--file', str(OVERRIDE), *args], capture=capture, timeout=timeout)


def request_json(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers={'Accept': 'application/json'}), timeout=30) as response:
        require(response.status == 200, 'HTTP_STATUS_INVALID')
        data = response.read(4 * 1024 * 1024 + 1)
        require(len(data) <= 4 * 1024 * 1024, 'HTTP_RESPONSE_TOO_LARGE')
        return json.loads(data)


def healthy(version, public=False):
    body = request_json(('https://ai-project-os.com' if public else 'http://127.0.0.1:3000') + '/api/health')
    require(body.get('status') == 'ok' and body.get('version') == version and body.get('database') == 'up'
            and body.get('worker', {}).get('status') == 'up'
            and body['worker'].get('consecutiveFailures') == 0, 'HEALTH_INVALID')
    return body


def require_ci(revision):
    api = 'https://api.github.com/repos/Jack-Kunlun/ai-project-os/actions'
    runs = request_json(api + '/workflows/ci.yml/runs?event=push&status=success&head_sha=' + revision + '&per_page=100')
    for branch in ('main', TAG):
        candidates = [r for r in runs.get('workflow_runs', []) if r.get('head_sha') == revision
                      and r.get('head_branch') == branch and r.get('event') == 'push'
                      and r.get('status') == 'completed' and r.get('conclusion') == 'success']
        require(bool(candidates), 'EXACT_MAIN_AND_TAG_CI_REQUIRED')
        accepted = False
        for candidate in candidates:
            jobs = request_json(api + '/runs/' + str(int(candidate['id'])) + '/jobs?per_page=100')
            if any(j.get('name') == 'Verify database and release candidate' and j.get('conclusion') == 'success'
                   for j in jobs.get('jobs', [])):
                accepted = True
                break
        require(accepted, 'FULL_DATABASE_CI_REQUIRED')


def release_acceptance(revision, confirmation):
    require(confirmation in ('CONFIRM_V074_WITHOUT_BACKUP',
                             'CONFIRM_V074_FAST_WITHOUT_BACKUP_OR_LEGACY_ACCEPTANCE'), 'ARGUMENTS_INVALID')
    if confirmation == 'CONFIRM_V074_WITHOUT_BACKUP':
        require_ci(revision)
        return 'full_main_and_tag_ci'
    # Explicit pre-1.0 operator decision: reuse completed feature/security checks.
    # Exact annotated tag, source identity, migration ledger, stop boundaries and
    # target health remain mandatory in main, regardless of this CI waiver.
    print('V074_RELEASE_ACCEPTANCE_WAIVED_BY_USER_PRE_1_0', flush=True)
    return 'waived_by_user_pre_1_0'


def env_values():
    trusted(ENV, 0o600)
    values = {}
    for line in ENV.read_text().splitlines():
        if not line or line.lstrip().startswith('#'):
            continue
        require('=' in line, 'ENV_SYNTAX_INVALID')
        key, value = line.split('=', 1)
        require(re.fullmatch(r'[A-Z][A-Z0-9_]*', key) and key not in values, 'ENV_KEY_INVALID')
        values[key] = value
    require(values.get('POSTGRES_USER') == 'ai_project_os_cluster_admin'
            and values.get('POSTGRES_RUNTIME_USER') == 'ai_project_os_runtime'
            and values.get('POSTGRES_ENTITLEMENT_WRITER_USER') == 'ai_project_os_entitlement_writer'
            and values.get('POSTGRES_GIT_AUTOMATION_WORKER_USER', 'ai_project_os_git_automation_worker') == 'ai_project_os_git_automation_worker', 'PRINCIPAL_ENV_INVALID')
    for key in ('POSTGRES_CLUSTER_ADMIN_PASSWORD', 'POSTGRES_MIGRATOR_PASSWORD', 'POSTGRES_RUNTIME_PASSWORD',
                'POSTGRES_ENTITLEMENT_WRITER_PASSWORD', 'POSTGRES_GIT_AUTOMATION_WORKER_PASSWORD',
                'POSTGRES_ENTITLEMENT_INVENTORY_READER_PASSWORD'):
        require(re.fullmatch(r'[a-f0-9]{64}', values.get(key, '')), 'PRINCIPAL_SECRET_INVALID')
    require(values.get('AI_PROJECT_OS_PUBLIC_ORIGIN') == 'https://ai-project-os.com'
            and values.get('AI_PROJECT_OS_SECURE_COOKIES') == 'true', 'AUTH_ENV_INVALID')
    require(values.get('POSTGRES_DB', 'ai_project_os') == 'ai_project_os'
            and values.get('APP_PORT', '3000') == '3000', 'PORT_DATABASE_INVALID')
    require(values.get('PHONE_AUTH_ENABLED', 'false') == 'false', 'PHONE_AUTH_MUST_REMAIN_DISABLED')
    if 'PHONE_AUTH_SECRET' in values:
        require(re.fullmatch(r'[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]', values['PHONE_AUTH_SECRET']), 'PHONE_SECRET_INVALID')
    return values


def container(service):
    ids = docker('ps', '-aq', '--no-trunc', '--filter', 'label=com.docker.compose.project=' + PROJECT,
                 '--filter', 'label=com.docker.compose.service=' + service).splitlines()
    require(len(ids) == 1 and re.fullmatch(r'[a-f0-9]{64}', ids[0]), 'CONTAINER_ID_INVALID')
    return json.loads(docker('inspect', ids[0]))[0]


def db_query(postgres_id, sql):
    return json.loads(docker('exec', postgres_id, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U',
                            'ai_project_os_cluster_admin', '-d', 'ai_project_os', '-At', '-c', sql))


def manifest(root):
    directories = sorted(p for p in (root / 'prisma/migrations').iterdir() if p.is_dir())
    require(len(directories) == 140 and directories[134].name == '20261001010000_add_browser_web_source_modes'
            and directories[-1].name == '20261006014000_add_sms_provider_adapters', 'TARGET_MANIFEST_INVALID')
    require(all(re.fullmatch(r'\d{14}_[a-z0-9_]+', p.name) for p in directories), 'MIGRATION_NAME_INVALID')
    return [(p.name, hashlib.sha256((p / 'migration.sql').read_bytes()).hexdigest()) for p in directories]


def ledger(postgres_id, expected):
    rows = db_query(postgres_id, '''SELECT coalesce(json_agg(row_to_json(m)), '[]'::json) FROM
      (SELECT migration_name, checksum, finished_at IS NOT NULL AS finished,
       rolled_back_at IS NOT NULL AS rolled_back, applied_steps_count FROM public._prisma_migrations
       ORDER BY migration_name) m''')
    require(len(rows) == len(expected), 'MIGRATION_COUNT_INVALID')
    require(all((r['migration_name'], r['checksum']) == e and r['finished'] and not r['rolled_back']
                and r['applied_steps_count'] >= 1 for r, e in zip(rows, expected)), 'MIGRATION_LEDGER_INVALID')


def source_state():
    trusted(RESULT, 0o600)
    fields = dict(line.split('=', 1) for line in RESULT.read_text().splitlines() if '=' in line)
    require(fields.get('tag') == 'v0.7.3' and fields.get('revision') == SOURCE_REVISION, 'SOURCE_RECORD_INVALID')
    healthy('0.7.3'); healthy('0.7.3', public=True)
    writers = [container(service) for service in ('app', 'worker', 'git-worker')]
    postgres = container('postgres')
    require(postgres['State'].get('Health', {}).get('Status') == 'healthy', 'POSTGRES_UNHEALTHY')
    require(postgres['Config']['Image'] == IMAGE, 'POSTGRES_IMAGE_INVALID')
    bindings = postgres['NetworkSettings']['Ports'].get('5432/tcp')
    require(isinstance(bindings, list) and len(bindings) == 1 and bindings[0]['HostIp'] == '127.0.0.1', 'DATABASE_NOT_ISOLATED')
    for writer in writers:
        require(writer['State'].get('Health', {}).get('Status') == 'healthy'
                and writer['State']['Running'] and not writer['State']['Paused'], 'SOURCE_WRITER_UNHEALTHY')
        require(writer['Config'].get('Labels', {}).get('org.opencontainers.image.version') == '0.7.3', 'SOURCE_IMAGE_VERSION_INVALID')
    return postgres['Id'], writers


def stopped(postgres_id):
    running = docker('ps', '--format', '{{.Label "com.docker.compose.service"}}',
                     '--filter', 'label=com.docker.compose.project=' + PROJECT).splitlines()
    require(running == ['postgres'], 'WRITERS_NOT_ISOLATED')
    count = db_query(postgres_id, '''SELECT to_json(count(*)) FROM pg_stat_activity
      WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend' ''')
    require(count == 0, 'DATABASE_CLIENTS_PRESENT')


def restart_source(writers):
    ids = [w['Id'] for w in writers
           if not json.loads(docker('inspect', w['Id']))[0]['State']['Running']]
    if ids:
        docker('start', *ids)


def quiesce_after_failure(postgres_id):
    # Include still-running migration/reconcile containers after timeout or signal.
    items = docker('ps', '--no-trunc', '--format', '{{.ID}} {{.Label "com.docker.compose.service"}}',
                   '--filter', 'label=com.docker.compose.project=' + PROJECT).splitlines()
    ids = []
    for item in items:
        identifier, service = item.split(' ', 1)
        require(re.fullmatch(r'[a-f0-9]{64}', identifier), 'RECOVERY_CONTAINER_INVALID')
        if identifier != postgres_id:
            require(service != 'postgres', 'RECOVERY_POSTGRES_CHANGED')
            ids.append(identifier)
    if ids:
        docker('stop', *ids)
    stopped(postgres_id)


def interrupted(_signum, _frame):
    raise RuntimeError('V074_INTERRUPTED')


def wait_service(service):
    for _ in range(120):
        value = container(service)['State']
        if value['Status'] == 'exited':
            require(value['ExitCode'] == 0, 'MIGRATION_SERVICE_FAILED')
            return
        time.sleep(2)
    raise RuntimeError('V074_MIGRATION_SERVICE_TIMEOUT')


def wait_health():
    for _ in range(120):
        try:
            require(all(container(s)['State'].get('Health', {}).get('Status') == 'healthy'
                        for s in ('app', 'worker', 'git-worker')), 'TARGET_WRITER_UNHEALTHY')
            return healthy('0.7.4')
        except RuntimeError:
            pass
        except (OSError, ValueError):
            pass
        time.sleep(2)
    raise RuntimeError('V074_TARGET_HEALTH_TIMEOUT')


def atomic_write(path, data, mode):
    trusted(path.parent)
    temporary = path.parent / ('.v074-' + secrets.token_hex(12))
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data); stream.flush(); os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def main(args):
    require(os.geteuid() == 0, 'ROOT_REQUIRED')
    require(len(args) == 2 and re.fullmatch(r'[a-f0-9]{40}', args[0])
            and args[1] in ('CONFIRM_V074_WITHOUT_BACKUP',
                           'CONFIRM_V074_FAST_WITHOUT_BACKUP_OR_LEGACY_ACCEPTANCE'), 'ARGUMENTS_INVALID')
    revision = args[0]
    signal.signal(signal.SIGTERM, interrupted)
    os.umask(0o077)
    trusted('/root'); trusted('/usr/bin'); trusted('/usr/sbin')
    # The common lock must not follow a non-root planted symlink in /run/lock.
    lock_path = '/run/lock/ai-project-os-deploy.lock'
    directory = os.lstat('/run/lock')
    require(stat.S_ISDIR(directory.st_mode) and directory.st_uid == directory.st_gid == 0
            and stat.S_IMODE(directory.st_mode) == 0o1777, 'LOCK_DIRECTORY_INVALID')
    fd = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    info = os.fstat(fd)
    require(stat.S_ISREG(info.st_mode) and info.st_uid == info.st_gid == 0
            and stat.S_IMODE(info.st_mode) == 0o600, 'LOCK_INVALID')
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    trusted(Path(__file__).absolute(), 0o700)
    trusted(OVERRIDE); trusted(ROOT); trusted(ROOT / '.git'); trusted(NGINX, 0o644)
    trusted('/etc/nginx/snippets/ai-project-os-proxy.conf')
    enabled = Path('/etc/nginx/sites-enabled/ai-project-os.conf')
    trusted(enabled.parent)
    enabled_info = enabled.lstat()
    require(stat.S_ISLNK(enabled_info.st_mode) and enabled_info.st_uid == enabled_info.st_gid == 0
            and enabled.resolve() == NGINX, 'NGINX_ENABLED_PATH_INVALID')
    require(run(['git', '-C', str(ROOT), 'remote', 'get-url', 'origin']) == REMOTE, 'REMOTE_INVALID')
    require(not run(['git', '-C', str(ROOT), 'status', '--porcelain']), 'MANAGED_CHECKOUT_DIRTY')
    values = env_values()
    postgres_id, old_writers = source_state()
    ci_acceptance = release_acceptance(revision, args[1])
    run(['git', '-C', str(ROOT), 'fetch', '--no-tags', 'origin', 'refs/tags/' + TAG + ':refs/tags/' + TAG])
    require(run(['git', '-C', str(ROOT), 'cat-file', '-t', 'refs/tags/' + TAG]) == 'tag', 'TAG_NOT_ANNOTATED')
    require(run(['git', '-C', str(ROOT), 'rev-parse', 'refs/tags/' + TAG + '^{}']) == revision, 'TAG_REVISION_MISMATCH')
    run(['git', '-C', str(ROOT), 'checkout', '--detach', revision])
    require(json.loads((ROOT / 'package.json').read_text())['version'] == '0.7.4', 'PACKAGE_VERSION_INVALID')
    require(Path(__file__).read_bytes() == (ROOT / 'deploy/production/ai-project-os-v074-deploy.py').read_bytes(),
            'INSTALLED_TOOL_TARGET_MISMATCH')
    expected = manifest(ROOT)
    ledger(postgres_id, expected[:135])
    print('V074_SOURCE_PREFLIGHT_OK revision=' + SOURCE_REVISION + ' migration_count=135', flush=True)
    if 'PHONE_AUTH_SECRET' not in values:
        text = ENV.read_text().rstrip('\n') + '\nPHONE_AUTH_SECRET=' + secrets.token_urlsafe(32) + '\n'
        if 'PHONE_AUTH_ENABLED' not in values:
            text += 'PHONE_AUTH_ENABLED=false\n'
        atomic_write(ENV, text.encode(), 0o600)
    compose('config', '--quiet')
    compose('build', 'migrate', 'reconcile', 'app', 'worker', 'git-worker', capture=False, timeout=7200)
    # Revalidate source containers and ledger after the lengthy build.
    new_pg_id, new_writers = source_state()
    require(new_pg_id == postgres_id and [(w['Id'], w['Image']) for w in old_writers]
            == [(w['Id'], w['Image']) for w in new_writers], 'SOURCE_CHANGED_DURING_BUILD')
    ledger(postgres_id, expected[:135])
    nginx_before = NGINX.read_bytes()
    mutation = False
    writers_healthy = False
    try:
        atomic_write(NGINX, (ROOT / 'deploy/production/nginx/ai-project-os.conf').read_bytes(), 0o644)
        run(['nginx', '-t']); run(['systemctl', 'daemon-reload']); run(['systemctl', 'reload', 'nginx'])
        docker('stop', *[w['Id'] for w in old_writers])
        stopped(postgres_id); ledger(postgres_id, expected[:135])
        print('V074_WRITERS_STOPPED backup=waived_by_user', flush=True)
        mutation = True  # Never start old writers after any migration attempt.
        compose('up', '-d', '--no-deps', '--no-build', '--force-recreate', 'migrate')
        wait_service('migrate'); stopped(postgres_id)
        compose('up', '-d', '--no-deps', '--no-build', '--force-recreate', 'reconcile')
        wait_service('reconcile'); stopped(postgres_id); ledger(postgres_id, expected)
        compose('up', '-d', '--no-deps', '--no-build', '--force-recreate', 'app', 'worker', 'git-worker')
        health = wait_health(); writers_healthy = True
        healthy('0.7.4', public=True)
        record = ('DEPLOY_OK\ntag=' + TAG + '\nsource_tag=v0.7.3\nsource_revision=' + SOURCE_REVISION
                  + '\nrevision=' + revision + '\nmigration_count=140\nbackup=waived_by_user\nci_acceptance=' + ci_acceptance + '\nhealth='
                  + json.dumps(health, separators=(',', ':')) + '\ncompleted_at='
                  + time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()) + '\n')
        atomic_write(RESULT, record.encode(), 0o600)
        print('V074_DEPLOY_OK tag=' + TAG + ' revision=' + revision + ' migration_count=140', flush=True)
    except BaseException:
        if not mutation:
            restart_source(old_writers)
            atomic_write(NGINX, nginx_before, 0o644)
            run(['nginx', '-t']); run(['systemctl', 'reload', 'nginx'])
            print('V074_PRE_MIGRATION_FAILED_SOURCE_RESTARTED', file=sys.stderr)
        elif not writers_healthy:
            quiesce_after_failure(postgres_id)
            print('V074_MIGRATION_RECOVERY_REQUIRED writers_stopped=true', file=sys.stderr)
        else:
            print('V074_POST_CUTOVER_INCOMPLETE new_writers_healthy=true', file=sys.stderr)
        raise
    finally:
        os.close(fd)


if __name__ == '__main__':
    try:
        main(sys.argv[1:])
    except BaseException as error:
        code = str(error) if isinstance(error, RuntimeError) and re.fullmatch(r'V074_[A-Z0-9_]+', str(error)) else 'V074_UNEXPECTED_FAILURE'
        print(code, file=sys.stderr)
        sys.exit(1)
