#!/usr/bin/env python3
"""Enable only PHONE_AUTH_ENABLED on the verified v0.7.5 app; no build, pull or migration."""
import fcntl
import json
import os
import re
from pathlib import Path
import stat
import subprocess
import tempfile
import time
import urllib.request

os.environ['PATH'] = '/usr/sbin:/usr/bin:/sbin:/bin'
PROCESS_ENV = {'PATH': os.environ['PATH'], 'HOME': '/root', 'LANG': 'C.UTF-8'}

class GateFailure(Exception):
    pass

def require(condition, marker):
    if not condition:
        raise GateFailure(marker)

def run(args):
    if args[0] == 'docker':
        args = ['/usr/bin/docker', '--host', 'unix:///run/docker.sock', *args[1:]]
    else:
        args = ['/usr/sbin/nginx', *args[1:]]
    result = subprocess.run(args, capture_output=True, text=True, timeout=120, env=PROCESS_ENV)
    require(result.returncode == 0, 'PHONE_AUTH_COMMAND_FAILED_' + Path(args[0]).name.upper())
    return result.stdout

def protected(path, file_mode=None):
    path = Path(path)
    for item in (path, *path.parents):
        meta = item.lstat()
        require(not stat.S_ISLNK(meta.st_mode) and meta.st_uid == 0 and meta.st_gid == 0 and not meta.st_mode & 0o022, 'PHONE_AUTH_PATH_UNPROTECTED')
    if file_mode is not None:
        require(stat.S_IMODE(path.stat().st_mode) == file_mode, 'PHONE_AUTH_ENV_MODE_INVALID')

def container(service):
    ids = run(['docker', 'ps', '-q', '--filter', 'label=com.docker.compose.project=ai-project-os', '--filter', 'label=com.docker.compose.service=' + service]).split()
    require(len(ids) == 1, 'PHONE_AUTH_SERVICE_NOT_UNIQUE_' + service.upper())
    return json.loads(run(['docker', 'inspect', ids[0]]))[0]

def environment(c):
    return dict(v.split('=', 1) for v in c['Config']['Env'] if '=' in v)

def health():
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open('https://ai-project-os.com/api/health', timeout=8) as response:
            data = json.loads(response.read(65537))
        return data.get('status') == 'ok' and data.get('version') == '0.7.5' and data.get('database') == 'up' and data.get('worker', {}).get('status') == 'up'
    except Exception:
        return False

def atomic_env(data):
    fd, name = tempfile.mkstemp(prefix='.production.env.registration.', dir='/etc/ai-project-os')
    try:
        with os.fdopen(fd, 'wb') as out:
            out.write(data)
            out.flush()
            os.fsync(out.fileno())
        os.chown(name, 0, 0)
        os.chmod(name, 0o600)
        os.replace(name, '/etc/ai-project-os/production.env')
        directory = os.open('/etc/ai-project-os', os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(name):
            os.unlink(name)

def enabled_environment(old):
    require(len(old) <= 1024 * 1024, 'PHONE_AUTH_ENV_SIZE_INVALID')
    lines = old.decode('utf-8').splitlines(keepends=True)
    values = {}
    for line in lines:
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        require('=' in line, 'PHONE_AUTH_ENV_SYNTAX_INVALID')
        key, value = line.rstrip('\r\n').split('=', 1)
        require(re.fullmatch(r'[A-Z][A-Z0-9_]*', key) and key not in values, 'PHONE_AUTH_ENV_KEY_INVALID')
        values[key] = value
    require(re.fullmatch(r'[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]', values.get('PHONE_AUTH_SECRET', '')), 'PHONE_AUTH_SECRET_INVALID')
    require(values.get('PHONE_AUTH_ENABLED', 'false') == 'false', 'PHONE_AUTH_FLAG_UNEXPECTED')
    matches = [i for i, line in enumerate(lines) if line.startswith('PHONE_AUTH_ENABLED=')]
    if matches:
        lines[matches[0]] = 'PHONE_AUTH_ENABLED=true\n'
    else:
        if lines and not lines[-1].endswith('\n'):
            lines[-1] += '\n'
        lines.append('PHONE_AUTH_ENABLED=true\n')
    return ''.join(lines).encode('utf-8')


def main():
    require(os.geteuid() == 0, 'PHONE_AUTH_ROOT_REQUIRED')
    require(os.sys.argv[1:] == ['CONFIRM_ENABLE_PHONE_AUTH_WITHOUT_PROVIDER'], 'PHONE_AUTH_CONFIRMATION_REQUIRED')
    protected(Path(__file__), 0o700)
    for executable in ('/usr/bin/docker',):
        protected(executable)
    directory = Path('/run/lock').lstat()
    require(stat.S_ISDIR(directory.st_mode) and directory.st_uid == directory.st_gid == 0 and stat.S_IMODE(directory.st_mode) == 0o1777, 'PHONE_AUTH_LOCK_DIRECTORY_INVALID')
    protected('/run')
    socket = Path('/run/docker.sock').lstat()
    require(stat.S_ISSOCK(socket.st_mode) and socket.st_uid == 0 and not socket.st_mode & 0o002, 'PHONE_AUTH_LOCAL_DOCKER_SOCKET_INVALID')
    env_path = Path('/etc/ai-project-os/production.env')
    protected(env_path, 0o600)
    files = ['/srv/ai-project-os/repository/compose.yaml', '/etc/ai-project-os/compose.operations.yaml']
    for path in files:
        protected(path)
    lock = os.open('/run/lock/ai-project-os-deploy.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    metadata = os.fstat(lock)
    require(stat.S_ISREG(metadata.st_mode) and metadata.st_uid == 0 and metadata.st_gid == 0 and stat.S_IMODE(metadata.st_mode) == 0o600, 'PHONE_AUTH_LOCK_INVALID')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    old = env_path.read_bytes()
    new = enabled_environment(old)
    app = container('app')
    other = {service: container(service) for service in ('worker', 'git-worker', 'postgres')}
    runtime = environment(app)
    require(runtime.get('PHONE_AUTH_ENABLED') == 'false' and runtime.get('AI_PROJECT_OS_PUBLIC_ORIGIN') == 'https://ai-project-os.com' and runtime.get('AI_PROJECT_OS_SECURE_COOKIES') == 'true', 'PHONE_AUTH_RUNTIME_BASELINE_INVALID')
    require(app['Config']['Labels'].get('org.opencontainers.image.version') == '0.7.5', 'PHONE_AUTH_VERSION_INVALID')
    labels = app['Config']['Labels']
    require(labels.get('com.docker.compose.project.config_files') == ','.join(files), 'PHONE_AUTH_COMPOSE_PATH_DRIFT')
    compose = ['docker', 'compose', '--project-directory', '/srv/ai-project-os/repository', '--env-file', str(env_path), '-p', 'ai-project-os', '-f', files[0], '-f', files[1]]
    config = json.loads(run(compose + ['config', '--format', 'json']))
    service = config['services']['app']
    config_hash = run(compose + ['config', '--hash', 'app']).split()
    require(len(config_hash) == 2 and config_hash[0] == 'app' and config_hash[1] == labels.get('com.docker.compose.config-hash'), 'PHONE_AUTH_RUNNING_CONFIG_DRIFT')
    expected = service['environment']
    require(all(str(value) == runtime.get(key) for key, value in expected.items()), 'PHONE_AUTH_PENDING_ENV_DRIFT')
    image = service.get('image', 'ai-project-os-app')
    image_id = json.loads(run(['docker', 'image', 'inspect', image]))[0]['Id']
    require(image_id == app['Image'], 'PHONE_AUTH_IMAGE_DRIFT')
    require(health(), 'PHONE_AUTH_HEALTH_INVALID')
    print('PHONE_AUTH_ENABLE_PREFLIGHT_OK', flush=True)
    try:
        atomic_env(new)
        after = json.loads(run(compose + ['config', '--format', 'json']))
        expected_after = dict(expected, PHONE_AUTH_ENABLED='true')
        require(after['services']['app']['environment'] == expected_after, 'PHONE_AUTH_ENV_CHANGE_EXCEEDS_FLAG')
        expected_config = dict(config, services=dict(config['services'], app=dict(service, environment=expected_after)))
        require(after == expected_config, 'PHONE_AUTH_COMPOSE_CHANGE_EXCEEDS_FLAG')
        require({k: v for k, v in after['services']['app'].items() if k != 'environment'} == {k: v for k, v in service.items() if k != 'environment'}, 'PHONE_AUTH_APP_CONFIG_DRIFT')
        run(compose + ['up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--force-recreate', 'app'])
        updated = container('app')
        require(updated['Image'] == app['Image'] and environment(updated).get('PHONE_AUTH_ENABLED') == 'true', 'PHONE_AUTH_APP_RUNTIME_INVALID')
        for name, original in other.items():
            require(container(name)['Id'] == original['Id'], 'PHONE_AUTH_OTHER_SERVICE_CHANGED')
        for _ in range(30):
            if container('app')['State'].get('Health', {}).get('Status') == 'healthy' and health():
                print('PHONE_AUTH_ENABLED_OK version=0.7.5 same_app_image=true workers_and_database_unchanged=true supplier_ready=not_asserted', flush=True)
                return
            time.sleep(2)
        raise GateFailure('PHONE_AUTH_HEALTH_TIMEOUT')
    except BaseException:
        try:
            atomic_env(old)
            run(compose + ['up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--force-recreate', 'app'])
            restored = container('app')
            require(restored['Image'] == app['Image'] and environment(restored).get('PHONE_AUTH_ENABLED') == 'false', 'PHONE_AUTH_ROLLBACK_RUNTIME_INVALID')
            for name, original in other.items():
                require(container(name)['Id'] == original['Id'], 'PHONE_AUTH_ROLLBACK_OTHER_SERVICE_CHANGED')
            for _ in range(30):
                if container('app')['State'].get('Health', {}).get('Status') == 'healthy' and health():
                    print('PHONE_AUTH_ROLLBACK_VERIFIED', flush=True)
                    break
                time.sleep(2)
            else:
                raise GateFailure('PHONE_AUTH_ROLLBACK_HEALTH_TIMEOUT')
        except Exception:
            print('PHONE_AUTH_ROLLBACK_REQUIRES_OPERATOR', flush=True)
        raise

if __name__ == '__main__':
    try:
        main()
    except GateFailure as error:
        print(str(error), flush=True)
        raise SystemExit(1)
    except BaseException:
        print('PHONE_AUTH_ENABLE_FAILED', flush=True)
        raise SystemExit(1)
