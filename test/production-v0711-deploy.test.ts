import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

test("v0.7.11 patch cutover rejects schema drift and builds before stopping writers", () => {
  const output = execFileSync("python3", ["-B", "-c", `
import importlib.util,json,stat,tempfile,types
from pathlib import Path
spec=importlib.util.spec_from_file_location('deploy','deploy/production/ai-project-os-v0711-deploy.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
sha='a'*40
with tempfile.TemporaryDirectory() as directory:
 root=Path(directory);m.ROOT=root
 (root/'deploy/production').mkdir(parents=True)
 (root/'deploy/production/ai-project-os-v0711-deploy.py').write_bytes(Path(m.__file__).read_bytes())
 (root/'Dockerfile').write_text('LABEL org.opencontainers.image.version="0.7.11"')
 (root/'package.json').write_text(json.dumps({'version':'0.7.11'}))
 env=root/'env';original_env='AI_PROJECT_OS_PUBLIC_ORIGIN=https://ai-project-os.com\\nAI_PROJECT_OS_SECURE_COOKIES=true\\nPHONE_AUTH_ENABLED=true\\nSYNTHETIC_SECRET=preserved-test-secret\\n'
 env.write_text(original_env)
 override=root/'override';override.write_text('synthetic-test-compose')
 result=root/'result';result.write_text('tag=v0.7.10\\nrevision='+m.SOURCE_REVISION)
 m.trusted=lambda *args:None
 m.os=types.SimpleNamespace(geteuid=lambda:0,umask=lambda mode:None,
  lstat=lambda path:types.SimpleNamespace(st_uid=0,st_gid=0,st_mode=stat.S_IFDIR|0o1777),open=lambda *args:99,
  fstat=lambda fd:types.SimpleNamespace(st_uid=0,st_gid=0,st_mode=stat.S_IFREG|0o600),close=lambda fd:None,
  O_RDWR=m.os.O_RDWR,O_CREAT=m.os.O_CREAT,O_NOFOLLOW=m.os.O_NOFOLLOW)
 m.fcntl=types.SimpleNamespace(flock=lambda *args:None,LOCK_EX=m.fcntl.LOCK_EX,LOCK_NB=m.fcntl.LOCK_NB)
 m.signal=types.SimpleNamespace(signal=lambda *args:None,SIGTERM=m.signal.SIGTERM)
 def scenario(failure=None):
  calls=[];state={'target':False};pg='1'*64
  env.write_text(original_env)
  def container(service):
   return {'Id':pg if service=='postgres' else service,'Image':service+'-image','State':{'Health':{'Status':'healthy'},'Running':True,'Paused':False},'Config':{'Image':'fixed-db','Env':[k+'='+v for k,v in m.MCP_SETTINGS.items()],'Labels':{'org.opencontainers.image.version':('0.7.10' if failure=='metadata' else '0.7.11') if state['target'] else '0.7.10'}}}
  def run(args):
   if 'get-url' in args:return 'fixed-remote'
   if 'cat-file' in args:return 'tag'
   if 'rev-parse' in args:return sha
   if 'diff' in args:
    calls.append('schema-check')
    if failure=='schema':raise RuntimeError('V0711_SCHEMA_CHANGED')
   return ''
  def compose(*args,**kwargs):
   calls.append(args)
   if args[0]=='build' and failure=='build':raise RuntimeError('V0711_BUILD_FAILED')
   if args[0]=='up':state['target']=True
  def healthy(version,public=False):
   if state['target'] and failure=='health':raise RuntimeError('V0711_HEALTH_INVALID')
   return {'version':version}
  def write(path,data,mode):
   if path==env:
    calls.append(('environment',));path.write_bytes(data)
   else:calls.append(('record',data.decode()))
  lib=types.SimpleNamespace(ENV=env,OVERRIDE=override,RESULT=result,REMOTE='fixed-remote',IMAGE='fixed-db',trusted=lambda *args:None,
   container=container,run=run,healthy=healthy,manifest=lambda root:list(range(140)),
   request_json=lambda url:{'resource':'https://ai-project-os.com/api/mcp','authorization_servers':['https://ai-project-os.com'],'scopes_supported':['project:read']},
   ledger=lambda pg,expected:calls.append(('ledger',len(expected))),compose=compose,docker=lambda *args:calls.append(args),
   stopped=lambda pg:calls.append('isolated'),atomic_write=write,quiesce_after_failure=lambda pg:calls.append('quiesced'),restart_source=lambda writers:calls.append('source-restarted'))
  m.helper=lambda:lib
  try:m.main([sha,m.CONFIRMATION])
  except RuntimeError:
   if failure is None:raise
  return calls
 for failure in ('schema','build'):
  calls=scenario(failure)
  assert not any(isinstance(c,tuple) and c[0] in ('stop','up','record','environment') for c in calls)
 for failure in ('health','metadata'):
  failed=scenario(failure)
  assert 'quiesced' in failed and not any(isinstance(c,tuple) and c[0]=='record' for c in failed)
 calls=scenario()
 build=next(i for i,c in enumerate(calls) if isinstance(c,tuple) and c[0]=='build')
 stop=next(i for i,c in enumerate(calls) if isinstance(c,tuple) and c[0]=='stop')
 start=next(i for i,c in enumerate(calls) if isinstance(c,tuple) and c[0]=='up')
 config_write=next(i for i,c in enumerate(calls) if isinstance(c,tuple) and c[0]=='environment')
 assert build<stop<config_write<start and calls[stop+1]=='isolated'
 assert 'PHONE_AUTH_ENABLED=true' in env.read_text() and 'SYNTHETIC_SECRET=preserved-test-secret' in env.read_text()
 assert all(k+'='+v in env.read_text() for k,v in m.MCP_SETTINGS.items())
 for bad in (original_env+'AI_PROJECT_OS_MCP_ACTIONS_ENABLED=true\\n',original_env+'AI_PROJECT_OS_SECURE_COOKIES=false\\n'):
  try:m.enabled_mcp_environment(bad.encode());raise AssertionError('drift permitted')
  except RuntimeError:pass
 assert calls[start]==('up','-d','--no-deps','--no-build','--force-recreate','app','worker','git-worker')
 assert all(c[1]==140 for c in calls if isinstance(c,tuple) and c[0]=='ledger')
 record=next(c[1] for c in calls if isinstance(c,tuple) and c[0]=='record')
 assert 'tag=v0.7.11' in record and 'migration_count=140' in record and 'ci_acceptance=waived_by_user_pre_1_0' in record
 assert not any(isinstance(c,tuple) and ('migrate' in c or 'reconcile' in c) for c in calls)
 try:m.main([sha,'FAST']);raise AssertionError('implicit waiver allowed')
 except RuntimeError as e:assert str(e)=='V0711_ARGUMENTS_INVALID'
print('V0711_OFFLINE_CUTOVER_OK')
`], { encoding: "utf8" });
  assert.match(output, /V0711_OFFLINE_CUTOVER_OK/u);
});
