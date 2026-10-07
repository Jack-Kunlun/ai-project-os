import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

test("v0.7.12 cutover preserves production configuration and fails closed", () => {
  const output = execFileSync("python3", ["-B", "-c", `
import hashlib,importlib.util,json,stat,tempfile,types
from pathlib import Path
spec=importlib.util.spec_from_file_location('deploy','deploy/production/ai-project-os-v0712-deploy.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
source='e0b24a84d7c9701c6af6d1135aa1a960c5094989'
target='a'*40
assert m.SOURCE_REVISION==source and m.TAG=='v0.7.12'
assert len(m.MCP_SETTINGS)==4
assert sum(1 for key,value in m.MCP_SETTINGS.items() if key.endswith('_ENABLED') and value=='true')==3
helper_source=Path(m.__file__).read_text()
assert '0.7.10' not in helper_source and 'enabled_mcp_environment' not in helper_source
assert 'target_env' not in helper_source and 'atomic_write(lib.ENV' not in helper_source
assert "values.get(key) == value for key, value in MCP_SETTINGS.items()" in helper_source
directory=tempfile.TemporaryDirectory()
root=Path(directory.name);m.ROOT=root
(root/'deploy/production').mkdir(parents=True)
(root/'deploy/production/ai-project-os-v0712-deploy.py').write_bytes(Path(m.__file__).read_bytes())
(root/'Dockerfile').write_text('LABEL org.opencontainers.image.version="0.7.12"')
(root/'package.json').write_text(json.dumps({'version':'0.7.12'}))
settings=''.join(k+'='+v+'\\n' for k,v in m.MCP_SETTINGS.items())
original_env=('AI_PROJECT_OS_PUBLIC_ORIGIN=https://ai-project-os.com\\nAI_PROJECT_OS_SECURE_COOKIES=true\\n'+settings+'PHONE_AUTH_ENABLED=true\\nSYNTHETIC_SECRET=preserved-test-secret\\n# retained comment\\n').encode()
original_override=b'synthetic-test-compose\\n'
env=root/'env';override=root/'override';result=root/'result'
env.write_bytes(original_env);override.write_bytes(original_override)
result.write_text('tag=v0.7.11\\nrevision='+m.SOURCE_REVISION+'\\n')
m.trusted=lambda *args:None
real_os=m.os;real_fcntl=m.fcntl;real_signal=m.signal
m.os=types.SimpleNamespace(geteuid=lambda:0,umask=lambda mode:None,
 lstat=lambda path:types.SimpleNamespace(st_uid=0,st_gid=0,st_mode=stat.S_IFDIR|0o1777),open=lambda *args:99,
 fstat=lambda fd:types.SimpleNamespace(st_uid=0,st_gid=0,st_mode=stat.S_IFREG|0o600),close=lambda fd:None,
 O_RDWR=real_os.O_RDWR,O_CREAT=real_os.O_CREAT,O_NOFOLLOW=real_os.O_NOFOLLOW)
m.fcntl=types.SimpleNamespace(flock=lambda *args:None,LOCK_EX=real_fcntl.LOCK_EX,LOCK_NB=real_fcntl.LOCK_NB)
m.signal=types.SimpleNamespace(signal=lambda *args:None,SIGTERM=real_signal.SIGTERM)
def scenario(failure=None,env_bytes=None):
 calls=[];errors=[];state={'target':False};pg='1'*64
 env.write_bytes(original_env if env_bytes is None else env_bytes);override.write_bytes(original_override)
 def container(service):
  if service=='postgres':
   return {'Id':('2'*64 if failure=='postgres' and state['target'] else pg),'Image':'fixed-db','State':{'Health':{'Status':'healthy'}},'Config':{'Image':'fixed-db','Labels':{}}}
  version='0.7.11' if not state['target'] or failure=='image_version' else '0.7.12'
  runtime=[k+'='+v for k,v in m.MCP_SETTINGS.items()]
  if service=='app' and failure=='runtime_config':runtime[0]='AI_PROJECT_OS_MCP_ACTIONS_ENABLED=false'
  return {'Id':service,'Image':service+'-image','State':{'Health':{'Status':'healthy'},'Running':True,'Paused':False},
   'Config':{'Image':service+'-image','Env':runtime,'Labels':{'org.opencontainers.image.version':version}}}
 def run(args):
  if 'get-url' in args:return 'fixed-remote'
  if 'cat-file' in args:
   calls.append('tag-type-check')
   return 'tag'
  if 'rev-parse' in args:
   calls.append('tag-sha-check')
   return target
  if 'merge-base' in args:
   calls.append(('ancestry-check',tuple(args)))
   if failure=='not_descendant':raise RuntimeError('V074_COMMAND_FAILED_GIT')
   return ''
  if 'checkout' in args:
   calls.append(('checkout',tuple(args)))
   return ''
  if 'diff' in args:
   calls.append('scope-check')
   if failure=='schema':raise RuntimeError('V0712_SCHEMA_CHANGED')
  return ''
 def compose(*args,**kwargs):
  calls.append(args)
  if args[0]=='build' and failure=='build':raise RuntimeError('V0712_BUILD_FAILED')
  if args[0]=='up':state['target']=True
 def healthy(version,public=False):
  if state['target'] and version=='0.7.12' and failure=='health':raise RuntimeError('V0712_HEALTH_INVALID')
  return {'version':version,'public':public}
 def request_json(url):
  if failure=='metadata':return {'resource':'wrong','authorization_servers':[],'scopes_supported':[]}
  return {'resource':'https://ai-project-os.com/api/mcp','authorization_servers':['https://ai-project-os.com'],'scopes_supported':['project:read']}
 def ledger(pg_id,expected):
  calls.append(('ledger',len(expected)))
  assert len(expected)==140
 def write(path,data,mode):
  if path==env:
   calls.append('environment-write')
   raise RuntimeError('V0712_TEST_ENV_WRITE')
  calls.append(('record',data.decode()))
  path.write_bytes(data)
 lib=types.SimpleNamespace(ENV=env,OVERRIDE=override,RESULT=result,REMOTE='fixed-remote',IMAGE='fixed-db',trusted=lambda *args:None,
  container=container,run=run,healthy=healthy,manifest=lambda root:list(range(140)),request_json=request_json,
  ledger=ledger,compose=compose,docker=lambda *args:calls.append(args),stopped=lambda pg_id:calls.append('isolated'),
  atomic_write=write,quiesce_after_failure=lambda pg_id:calls.append('quiesced'),restart_source=lambda writers:calls.append('source-restarted'))
 m.helper=lambda:lib
 try:m.main([target,m.CONFIRMATION])
 except BaseException as error:errors.append(str(error))
 assert hashlib.sha256(env.read_bytes()).digest()==hashlib.sha256(original_env if env_bytes is None else env_bytes).digest()
 assert hashlib.sha256(override.read_bytes()).digest()==hashlib.sha256(original_override).digest()
 return calls,errors
for bad_env in (
 original_env.replace(b'AI_PROJECT_OS_MCP_ACTIONS_ENABLED=true',b'AI_PROJECT_OS_MCP_ACTIONS_ENABLED=false'),
 original_env.replace(b'AI_PROJECT_OS_MCP_EXPORT_ENABLED=true\\n',b''),
 original_env.replace(b'AI_PROJECT_OS_MCP_EXPORT_PUBLIC_ORIGIN=https://ai-project-os.com',b'AI_PROJECT_OS_MCP_EXPORT_PUBLIC_ORIGIN='),
):
 calls,errors=scenario(env_bytes=bad_env)
 assert errors and errors[0].startswith('V0712_')
 assert not any(isinstance(call,tuple) and call[0] in ('build','stop','up') for call in calls)
 assert 'environment-write' not in calls
for failure in ('schema','build'):
 calls,errors=scenario(failure)
 assert errors and not any(isinstance(call,tuple) and call[0] in ('stop','up') for call in calls)
 assert 'environment-write' not in calls
calls,errors=scenario('not_descendant')
assert errors==['V0712_TARGET_NOT_DESCENDANT']
assert not any(isinstance(call,tuple) and call[0] in ('checkout','build','stop','up') for call in calls)
assert 'scope-check' not in calls
ancestry=next(call for call in calls if isinstance(call,tuple) and call[0]=='ancestry-check')
assert ancestry[1][-4:]==('merge-base','--is-ancestor',source,target)
for failure in ('health','metadata','runtime_config','image_version','postgres'):
 calls,errors=scenario(failure)
 assert errors and 'quiesced' in calls and not any(isinstance(call,tuple) and call[0]=='record' for call in calls)
 assert 'environment-write' not in calls
calls,errors=scenario()
assert errors==[]
build=next(i for i,call in enumerate(calls) if isinstance(call,tuple) and call[0]=='build')
stop=next(i for i,call in enumerate(calls) if isinstance(call,tuple) and call[0]=='stop')
start=next(i for i,call in enumerate(calls) if isinstance(call,tuple) and call[0]=='up')
tag_sha=calls.index('tag-sha-check')
ancestry_index=next(i for i,call in enumerate(calls) if isinstance(call,tuple) and call[0]=='ancestry-check')
checkout=next(i for i,call in enumerate(calls) if isinstance(call,tuple) and call[0]=='checkout')
assert calls[build]==('build','app','worker','git-worker') and tag_sha<ancestry_index<checkout<build<stop<start
assert calls[stop+1]=='isolated'
assert calls[start]==('up','-d','--no-deps','--no-build','--force-recreate','app','worker','git-worker')
assert 'environment-write' not in calls and all(call[1]==140 for call in calls if isinstance(call,tuple) and call[0]=='ledger')
record=next(call[1] for call in calls if isinstance(call,tuple) and call[0]=='record')
assert 'tag=v0.7.12' in record and 'source_tag=v0.7.11' in record and 'source_revision='+source in record
assert 'migration_count=140' in record and 'mcp_actions=true' in record and 'mcp_export=true' in record and 'mcp_oauth=true' in record
assert 'ci_acceptance=waived_by_user_pre_1_0' in record
assert not any(isinstance(call,tuple) and ('migrate' in call or 'reconcile' in call) for call in calls)
try:m.main([target,'FAST']);raise AssertionError('implicit waiver allowed')
except RuntimeError as error:assert str(error)=='V0712_ARGUMENTS_INVALID'
print('V0712_OFFLINE_CUTOVER_OK')
directory.cleanup()
`], { encoding: "utf8" });
  assert.match(output, /V0712_OFFLINE_CUTOVER_OK/u);
});
