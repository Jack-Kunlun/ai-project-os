import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

test("phone auth activation changes only its flag and preserves all other environment bytes", () => {
  const output = execFileSync("python3", ["-B", "-c", `
import importlib.util
spec=importlib.util.spec_from_file_location('activation','deploy/production/ai-project-os-enable-phone-auth.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
secret='A'*43
old=('# retained comment\\nPHONE_AUTH_SECRET='+secret+'\\nLOCAL_REGISTRATION_ENABLED=true\\nPHONE_AUTH_ENABLED=false\\n').encode()
assert m.enabled_environment(old)==old.replace(b'PHONE_AUTH_ENABLED=false',b'PHONE_AUTH_ENABLED=true')
absent=('PHONE_AUTH_SECRET='+secret).encode()
assert m.enabled_environment(absent)==absent+b'\\nPHONE_AUTH_ENABLED=true\\n'
for invalid in [old+b'PHONE_AUTH_ENABLED=false\\n',old.replace(secret.encode(),b'missing'),old.replace(b'=false',b'=true')]:
 try:m.enabled_environment(invalid)
 except m.GateFailure:pass
 else:raise AssertionError('invalid environment accepted')
print('PHONE_AUTH_ENV_TEST_OK')
`], { encoding: "utf8" });
  assert.match(output, /PHONE_AUTH_ENV_TEST_OK/u);
});

test("phone auth activation reuses app image, isolates other services and restores the flag on failure", () => {
  const output = execFileSync("python3", ["-B", "-c", `
import contextlib,importlib.util,io,json,stat,tempfile,types
from pathlib import Path
spec=importlib.util.spec_from_file_location('activation','deploy/production/ai-project-os-enable-phone-auth.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
files=['/srv/ai-project-os/repository/compose.yaml','/etc/ai-project-os/compose.operations.yaml']
with tempfile.TemporaryDirectory() as directory:
 env=Path(directory)/'env'
 original=b'PHONE_AUTH_SECRET='+b'A'*43+b'\\nPHONE_AUTH_ENABLED=false\\nLOCAL_REGISTRATION_ENABLED=true\\n'
 m.protected=lambda *args:None
 def path(value):
  if str(value)=='/etc/ai-project-os/production.env':return env
  if str(value)=='/run/lock':return types.SimpleNamespace(lstat=lambda:types.SimpleNamespace(st_uid=0,st_gid=0,st_mode=stat.S_IFDIR|0o1777))
  if str(value)=='/run/docker.sock':return types.SimpleNamespace(lstat=lambda:types.SimpleNamespace(st_uid=0,st_mode=stat.S_IFSOCK|0o660))
  return Path(value)
 m.Path=path
 m.os=types.SimpleNamespace(geteuid=lambda:0,sys=types.SimpleNamespace(argv=['tool','CONFIRM_ENABLE_PHONE_AUTH_WITHOUT_PROVIDER']),
  open=lambda *args:99,fstat=lambda fd:types.SimpleNamespace(st_uid=0,st_gid=0,st_mode=stat.S_IFREG|0o600),
  O_RDWR=2,O_CREAT=64,O_NOFOLLOW=131072)
 m.fcntl=types.SimpleNamespace(flock=lambda *args:None,LOCK_EX=2,LOCK_NB=4)
 m.time=types.SimpleNamespace(sleep=lambda seconds:None)
 def scenario(failure=None):
  env.write_bytes(original);calls=[];runtime={'flag':'false','id':'old'};failed={'once':False}
  def flag():return 'true' if b'PHONE_AUTH_ENABLED=true' in env.read_bytes() else 'false'
  def config():return {'services':{'app':{'environment':{'PHONE_AUTH_ENABLED':flag(),'LOCAL_REGISTRATION_ENABLED':'true','AI_PROJECT_OS_PUBLIC_ORIGIN':'https://ai-project-os.com','AI_PROJECT_OS_SECURE_COOKIES':'true'},'image':'fixed-app'},'worker':{'image':'fixed-worker'}}}
  def container(service):
   return {'Id':runtime['id'] if service=='app' else service,'Image':'fixed-image',
    'State':{'Health':{'Status':'unhealthy' if failure=='rollback-health' and service=='app' and runtime['id']=='new' else 'healthy'}},'Config':{'Env':['PHONE_AUTH_ENABLED='+runtime['flag'],'LOCAL_REGISTRATION_ENABLED=true','AI_PROJECT_OS_PUBLIC_ORIGIN=https://ai-project-os.com','AI_PROJECT_OS_SECURE_COOKIES=true'],
    'Labels':{'org.opencontainers.image.version':'0.7.5','com.docker.compose.project.config_files':','.join(files),'com.docker.compose.config-hash':'fixed-hash'}}}
  def run(args):
   calls.append(args)
   if '--hash' in args:return 'app fixed-hash'
   if 'config' in args:
    result=config()
    if failure=='drift' and flag()=='true':result['services']['worker']['image']='unexpected'
    return json.dumps(result)
   if 'inspect' in args:return json.dumps([{'Id':'wrong-image' if failure=='image' else 'fixed-image'}])
   if 'up' in args:
    if failure in ('up','rollback-health') and not failed['once']:
     failed['once']=True;raise m.GateFailure('PHONE_AUTH_TEST_UP_FAILED')
    runtime.update(flag=flag(),id='new');return ''
   raise AssertionError(args)
  m.container=container;m.run=run;m.health=lambda:True
  m.atomic_env=lambda value:(calls.append(('write',value)),env.write_bytes(value))
  captured=io.StringIO()
  try:
   with contextlib.redirect_stdout(captured):m.main()
  except m.GateFailure:
   if failure is None:raise
  else:
   if failure is not None:raise AssertionError('failure accepted')
  if failure=='rollback-health':
   assert 'PHONE_AUTH_ROLLBACK_VERIFIED' not in captured.getvalue()
   assert 'PHONE_AUTH_ROLLBACK_REQUIRES_OPERATOR' in captured.getvalue()
  return calls,env.read_bytes(),runtime
 calls,value,runtime=scenario()
 assert value==original.replace(b'=false',b'=true') and runtime['flag']=='true'
 ups=[c for c in calls if isinstance(c,list) and 'up' in c]
 assert len(ups)==1 and ups[0][-1]=='app' and '--no-build' in ups[0] and '--no-deps' in ups[0] and 'never' in ups[0]
 calls,value,runtime=scenario('image');assert value==original and not any(isinstance(c,tuple) and c[0]=='write' for c in calls)
 for failure in ('drift','up','rollback-health'):
  calls,value,runtime=scenario(failure);assert value==original and runtime['flag']=='false'
  assert not any(isinstance(c,list) and ('build' in c or 'migrate' in c or 'reconcile' in c) for c in calls)
print('PHONE_AUTH_ACTIVATION_TEST_OK')
`], { encoding: "utf8" });
  assert.match(output, /PHONE_AUTH_ACTIVATION_TEST_OK/u);
});
