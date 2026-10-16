#!/usr/bin/env python3
"""Freeze the one-time administrator install for the CI image release protocol.

Normal releases use the restricted Workflow after this installation. This
launcher only updates fixed tooling and prunes idle build cache; it never deploys.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import tempfile


def generate(repository, revision, ci_run):
    repository = Path(repository).resolve()
    def git(*args):
        return subprocess.check_output(['git', '-C', str(repository), *args], text=True).strip()
    if not re.fullmatch('[a-f0-9]{40}', revision) or not re.fullmatch('[1-9][0-9]*', ci_run):
        raise SystemExit('BOOTSTRAP_ARGUMENTS_INVALID')
    if git('rev-parse', 'HEAD') != revision or git('status', '--porcelain', '--untracked-files=all'):
        raise SystemExit('BOOTSTRAP_REQUIRES_CLEAN_COMMIT')
    path = 'deploy/production/ai-project-os-release-stable.py'
    content = subprocess.check_output(['git', '-C', str(repository), 'show', revision + ':' + path])
    digest = hashlib.sha256(content).hexdigest()
    version = json.loads((repository / 'package.json').read_text())['version']
    if not re.fullmatch(r'[1-9][0-9]*\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)', version):
        raise SystemExit('BOOTSTRAP_VERSION_INVALID')
    compile(content, path, 'exec')
    os.umask(0o077)
    directory = Path(tempfile.mkdtemp(prefix='ai-project-os-ci-images-' + revision[:12] + '-', dir='/private/tmp'))
    candidate = directory / 'deployer.py'
    candidate.write_bytes(content); candidate.chmod(0o600)
    remote = '/home/deploy/' + directory.name + '.py'
    stager = '''import hashlib,os,pwd,stat,sys
from pathlib import Path
stage=Path(sys.argv[1]); upload=Path(sys.argv[2]); digest=sys.argv[3]
info=stage.lstat()
if not(stat.S_ISDIR(info.st_mode) and stat.S_IMODE(info.st_mode)==0o700 and info.st_uid==info.st_gid==0):raise SystemExit('BOOTSTRAP_STAGE_INVALID')
user=pwd.getpwnam('deploy'); fd=os.open(upload,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
try:
 info=os.fstat(fd)
 if not(stat.S_ISREG(info.st_mode) and stat.S_IMODE(info.st_mode)==0o600 and info.st_uid==user.pw_uid and info.st_gid==user.pw_gid and info.st_nlink==1 and 0<info.st_size<=262144):raise SystemExit('BOOTSTRAP_UPLOAD_INVALID')
 data=b''
 while len(data)<=262144:
  block=os.read(fd,min(65536,262145-len(data)))
  if not block:break
  data+=block
 if len(data)!=info.st_size or hashlib.sha256(data).hexdigest()!=digest:raise SystemExit('BOOTSTRAP_UPLOAD_DIGEST_INVALID')
finally:os.close(fd)
compile(data,'reviewed-deployer','exec')
out=os.open(stage/'deployer.py',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o755)
try:
 with os.fdopen(out,'wb',closefd=False) as stream:stream.write(data);stream.flush()
 os.fchown(out,0,0);os.fchmod(out,0o755);os.fsync(out)
finally:os.close(out)
'''
    audit = '''import hashlib,importlib.util,os,sys
from pathlib import Path
p=Path('/usr/local/sbin/ai-project-os-release-stable')
if hashlib.sha256(p.read_bytes()).hexdigest()!=sys.argv[1]:raise SystemExit('BOOTSTRAP_INSTALLED_DIGEST_INVALID')
spec=importlib.util.spec_from_file_location('stable_installed',p);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
m.HELPER=m.load_helper();lock=m.secure_lock()
try:
 state=m.validate_state_file();source=m.source_runtime_state(require_checkout=True)
 print('STABLE_BOOTSTRAP_RUNTIME_OK tag='+source['tag']+' revision='+source['revision'],flush=True)
 print('STABLE_CACHE_BEFORE='+m.docker('system','df'),flush=True)
 m.prune_build_cache()
 print('STABLE_CACHE_AFTER='+m.docker('system','df'),flush=True)
 fs=os.statvfs('/');print('STABLE_DISK_AVAILABLE_BYTES='+str(fs.f_bavail*fs.f_frsize),flush=True)
finally:os.close(lock)
'''
    # Extensionless deployed Python paths need an explicit source loader.
    audit = audit.replace("spec=importlib.util.spec_from_file_location('stable_installed',p);", "from importlib.machinery import SourceFileLoader\nspec=importlib.util.spec_from_loader('stable_installed',SourceFileLoader('stable_installed',str(p)));")
    root_command = '\n'.join([
        'set -euo pipefail',
        'bootstrap_stage=$(/usr/bin/mktemp -d /root/ai-project-os-ci-images.XXXXXXXX)',
        '/usr/bin/python3 -I -B -c ' + shlex.quote(stager) + ' "$bootstrap_stage" ' + shlex.quote(remote) + ' ' + digest,
        '/usr/bin/python3 -I -B "$bootstrap_stage/deployer.py" bootstrap v' + version + ' ' + revision + ' CONFIRM_INSTALL_STABLE_TOOLING',
        '/usr/local/sbin/ai-project-os-release-stable --status',
        '/usr/bin/python3 -I -B -c ' + shlex.quote(audit) + ' ' + digest,
        '/usr/bin/rm -- "$bootstrap_stage/deployer.py"',
        '/usr/bin/rmdir -- "$bootstrap_stage"',
    ])
    poll = '''import json,subprocess,sys,time
revision,run_id=sys.argv[1:]
for _ in range(135):
 data=json.loads(subprocess.check_output(['gh','api','repos/Jack-Kunlun/ai-project-os/actions/runs/'+run_id]))
 if data.get('head_sha')!=revision or data.get('event')!='push' or data.get('head_branch')!='main':raise SystemExit('BOOTSTRAP_CI_IDENTITY_INVALID')
 if data.get('status')=='completed':
  if data.get('conclusion')!='success':raise SystemExit('BOOTSTRAP_CI_NOT_SUCCESSFUL')
  jobs=json.loads(subprocess.check_output(['gh','api','repos/Jack-Kunlun/ai-project-os/actions/runs/'+run_id+'/jobs?per_page=100']))['jobs']
  successful={j['name'] for j in jobs if j.get('conclusion')=='success'}
  if not {'Verify source and client','Build and verify release images','Verify database and release candidate'}.issubset(successful):raise SystemExit('BOOTSTRAP_CI_GATES_MISSING')
  print('STABLE_BOOTSTRAP_EXACT_CI_OK sha='+revision,flush=True);break
 time.sleep(20)
else:raise SystemExit('BOOTSTRAP_CI_TIMEOUT')
main=json.loads(subprocess.check_output(['gh','api','repos/Jack-Kunlun/ai-project-os/git/ref/heads/main']))
if main['object']['sha']!=revision:raise SystemExit('BOOTSTRAP_MAIN_MOVED')
'''
    options = ['-i', '/Users/fenglan/.ssh/ai-project-os-prod', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15']
    def shell(args): return ' '.join(shlex.quote(str(arg)) for arg in args)
    command = 'set -eu; test ! -L ' + shlex.quote(remote) + '; /usr/bin/chmod 600 -- ' + shlex.quote(remote) + '; /usr/bin/sudo /usr/bin/bash -c ' + shlex.quote(root_command)
    launcher = '\n'.join([
        '#!/usr/bin/env bash', 'set -euo pipefail',
        shell(['/usr/bin/python3', '-c', poll, revision, ci_run]),
        shell(['/usr/bin/scp', *options, candidate, 'deploy@38.76.205.30:' + remote]),
        shell(['/usr/bin/ssh', *options, '-tt', 'deploy@38.76.205.30', command]) + ' | tee ' + shlex.quote(str(directory / 'result.log')),
        shell(['/usr/bin/ssh', *options, 'deploy@38.76.205.30', 'rm -- ' + shlex.quote(remote)]),
        "printf '%s\\n' STABLE_BOOTSTRAP_COMPLETE_NO_APPLICATION_DEPLOY", '',
    ])
    (directory / 'run.sh').write_text(launcher); (directory / 'run.sh').chmod(0o700)
    subprocess.run(['bash', '-n', str(directory / 'run.sh')], check=True)
    return directory / 'run.sh'


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--revision', required=True)
    parser.add_argument('--ci-run', required=True)
    args = parser.parse_args()
    print(generate(Path.cwd(), args.revision, args.ci_run))
