import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

test("v0.8.0-dev.1 deploy requires exact CI and a verified backup before migration", () => {
  const output = execFileSync("python3", ["-B", "-c", `
import contextlib,importlib.util,io,json,shutil,stat,tempfile,types
from pathlib import Path
spec=importlib.util.spec_from_file_location('deploy','deploy/production/ai-project-os-v080-dev1-deploy.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
source='c8e341f39fbb77b44bc8a8f2a8483c3bd5ac2bd5';target='a'*40
assert m.SOURCE_REVISION==source and m.TAG=='v0.8.0-dev.1'
assert m.CONFIRMATION=='CONFIRM_V080_DEV1_WITH_BACKUP_AND_FULL_CI'
m.ROOT=Path.cwd()
actual=m.target_manifest()
assert len(actual)==142 and actual[-1][0]=='20261008010000_add_account_security'
assert actual[140][0]=='20261007010000_persist_verified_git_addresses'
assert all(len(checksum)==64 for _,checksum in actual)
backup_text=Path('deploy/production/ai-project-os-backup').read_text()
escaped='v0'+chr(92)+'.8'+chr(92)+'.0-dev'+chr(92)+'.1'
assert backup_text.count(escaped)==3
assert backup_text.count('v0.8.0-dev.1')==2

# The invoked host tool must be byte-identical to the candidate tool and gets
# only the fixed process environment and captured writer IDs.
with tempfile.TemporaryDirectory() as tool_directory:
 tool_root=Path(tool_directory).resolve();(tool_root/'deploy/production').mkdir(parents=True)
 candidate=tool_root/'deploy/production/ai-project-os-backup'
 shutil.copyfile(Path('deploy/production/ai-project-os-backup'),candidate)
 installed=tool_root/'installed-backup';shutil.copyfile(candidate,installed)
 installed.chmod(0o755)
 m.ROOT=tool_root;m.BACKUP_TOOL=installed
 real_os_for_tool=m.os
 def root_uid_lstat_tool(path):
  info=real_os_for_tool.lstat(path)
  return types.SimpleNamespace(st_uid=0,st_gid=0,st_mode=info.st_mode)
 m.os=types.SimpleNamespace(lstat=root_uid_lstat_tool)
 calls=[]
 m.subprocess=types.SimpleNamespace(PIPE=-1,run=lambda *args,**kwargs:(calls.append((args,kwargs)) or types.SimpleNamespace(returncode=0,stdout='backup fixture')))
 writer_ids=[{'Id':str(i)*64} for i in (1,2,3)]
 assert m.run_predeploy_backup(writer_ids)=='backup fixture'
 args,kwargs=calls[0]
 assert args[0]==[str(installed),'pre-deploy',m.TAG]
 assert kwargs['env']=={'PATH':'/usr/sbin:/usr/bin','HOME':'/root','LANG':'C.UTF-8',
  'AI_PROJECT_OS_DEPLOY_LOCK_HELD':'1','AI_PROJECT_OS_CUTOVER':'1','AI_PROJECT_OS_CUTOVER_LOCK_HELD':'1',
  'AI_PROJECT_OS_EXPECTED_APP_ID':writer_ids[0]['Id'],'AI_PROJECT_OS_EXPECTED_WORKER_ID':writer_ids[1]['Id'],
  'AI_PROJECT_OS_EXPECTED_GIT_WORKER_ID':writer_ids[2]['Id']}
 assert kwargs['timeout']==7200 and kwargs['check'] is False
 installed.write_text('different candidate')
 try:m.run_predeploy_backup(writer_ids);raise AssertionError('changed installed backup tool accepted')
 except RuntimeError as error:assert str(error)=='V080_DEV1_BACKUP_TOOL_MISMATCH'
 m.os=real_os_for_tool

directory=tempfile.TemporaryDirectory()
if True:
 root=Path(directory.name).resolve();m.ROOT=root
 (root/'deploy/production').mkdir(parents=True)
 (root/'deploy/production/ai-project-os-v080-dev1-deploy.py').write_bytes(Path(m.__file__).read_bytes())
 (root/'deploy/production/ai-project-os-backup').write_bytes(Path('deploy/production/ai-project-os-backup').read_bytes())
 (root/'.git').mkdir();(root/'package.json').write_text(json.dumps({'version':'0.8.0-dev.1'}))
 (root/'Dockerfile').write_text('LABEL org.opencontainers.image.version="0.8.0-dev.1"')
 migrations=root/'prisma/migrations';migrations.mkdir(parents=True)
 earlier=[f'20260901000000_migration_{i:03d}' for i in range(139)]
 names=earlier+['20261006014000_add_sms_provider_adapters','20261007010000_persist_verified_git_addresses',m.MIGRATION]
 for index,name in enumerate(names):
  path=migrations/name;path.mkdir();(path/'migration.sql').write_text('migration '+str(index))
 assert len(m.target_manifest())==142
 env=root/'env';override=root/'override';result=root/'result'
 settings=''.join(k+'='+v+'\\n' for k,v in m.MCP_SETTINGS.items())
 original_env=('AI_PROJECT_OS_PUBLIC_ORIGIN=https://ai-project-os.com\\nAI_PROJECT_OS_SECURE_COOKIES=true\\n'+settings+
  'AI_PROJECT_OS_WEB_BROWSER_ENABLED=false\\nSYNTHETIC_SECRET=preserved-test-secret\\n# keep comment\\n').encode()
 original_override=b'synthetic compose override\\n'
 env.write_bytes(original_env);override.write_bytes(original_override)
 result.write_text('tag=v0.7.18\\nrevision='+source+'\\n')
 m.BACKUP_ROOT=root/'backups';m.BACKUP_STATUS=root/'backup-status.json'
 m.BACKUP_TOOL=root/'installed-backup';m.BACKUP_TOOL.write_bytes((root/'deploy/production/ai-project-os-backup').read_bytes())
 m.BACKUP_ROOT.mkdir()
 backup_name='20261008T120000Z-pre-deploy-to-v0.8.0-dev.1.Abc123'
 backup_path=m.BACKUP_ROOT/backup_name;backup_path.mkdir(mode=0o700)
 archive='cos://ai-project-os-backup-1234567890/production/backups/2026/10/08/'+backup_name+'/'+backup_name+'.tar.age'
 latest='cos://ai-project-os-backup-1234567890/production/manifests/latest.json'
 verified='cos://ai-project-os-backup-1234567890/production/backups/2026/10/08/'+backup_name+'/'+backup_name+'.manifest.json'
 digest='a'*64
 (backup_path/'backup-metadata.env').write_text('format_version=2\\nreason=pre-deploy-to-'+m.TAG+
  '\\nbackup_name='+backup_name+'\\nwriters_quiesced=true\\nsource_quiesced=true\\n')
 (backup_path/'.cos-upload-verified').write_text('status=COS_UPLOAD_VERIFIED\\narchive_object='+archive+
  '\\nchecksum_object='+archive+'.sha256\\narchive_sha256='+digest+'\\nmanifest_object='+verified+
  '\\nlatest_manifest_object='+latest+'\\n')
 m.BACKUP_STATUS.write_text(json.dumps({'state':'succeeded','trigger':'pre-deploy','targetTag':m.TAG,
  'backupName':backup_name,'archiveObject':archive,'archiveSha256':digest,'retentionRemoved':0,'errorCode':None}))
 backup_output=('BACKUP_OK reason=pre-deploy-to-'+m.TAG+' source='+str(backup_path)+' object='+archive+
  ' manifest='+latest+' verified_manifest='+verified+' sha256='+digest+' retention_removed=0 source_quiesced=true\\n')
 for path,mode in ((backup_path/'backup-metadata.env',0o600),(backup_path/'.cos-upload-verified',0o600),
                   (m.BACKUP_STATUS,0o644)):
  path.chmod(mode)
 real_os_for_trust=m.os
 def root_uid_lstat(path):
  info=real_os_for_trust.lstat(path)
  return types.SimpleNamespace(st_uid=0,st_gid=0,st_mode=info.st_mode)
 m.os=types.SimpleNamespace(lstat=root_uid_lstat)
 def expect_rejected(operation,code):
  try:operation();raise AssertionError('invalid trusted path accepted')
  except RuntimeError as error:assert str(error)=='V080_DEV1_'+code
 try:
  validated=m.validate_backup_receipt(backup_output)
  assert validated['backup_name']==backup_name and validated['source_quiesced']=='true'
  expect_rejected(lambda:m.trusted(backup_path,0o700),'HOST_PATH_TYPE_OR_MODE_INVALID')
  expect_rejected(lambda:m.trusted(backup_path/'backup-metadata.env',0o700,directory=True),
                  'HOST_PATH_TYPE_OR_MODE_INVALID')
  loose_file=root/'loose-file';loose_file.write_text('fixture');loose_file.chmod(0o644)
  loose_directory=root/'loose-directory';loose_directory.mkdir();loose_directory.chmod(0o755)
  expect_rejected(lambda:m.trusted(loose_file,0o600),'HOST_PATH_TYPE_OR_MODE_INVALID')
  expect_rejected(lambda:m.trusted(loose_directory,0o700,directory=True),'HOST_PATH_TYPE_OR_MODE_INVALID')
  linked=root/'linked-file';linked.symlink_to(loose_file)
  expect_rejected(lambda:m.trusted(linked,0o600),'HOST_SYMLINK_REJECTED')
 finally:m.os=real_os_for_trust
 source_ids=['1'*64,'2'*64,'3'*64];pg='9'*64
 m.trusted=lambda *args,**kwargs:None
 real_os=m.os;real_fcntl=m.fcntl;real_signal=m.signal
 m.os=types.SimpleNamespace(geteuid=lambda:0,umask=lambda mode:None,
  lstat=lambda path:types.SimpleNamespace(st_uid=0,st_gid=0,st_mode=stat.S_IFDIR|0o1777),open=lambda *args:99,
  fstat=lambda fd:types.SimpleNamespace(st_uid=0,st_gid=0,st_mode=stat.S_IFREG|0o600),close=lambda fd:None,
  O_RDWR=real_os.O_RDWR,O_CREAT=real_os.O_CREAT,O_NOFOLLOW=real_os.O_NOFOLLOW)
 m.fcntl=types.SimpleNamespace(flock=lambda *args:None,LOCK_EX=real_fcntl.LOCK_EX,LOCK_NB=real_fcntl.LOCK_NB)
 m.signal=types.SimpleNamespace(signal=lambda *args:None,SIGTERM=real_signal.SIGTERM)

 def scenario(failure=None,source_record=None,bad_backup=False):
  calls=[];errors=[];state={'stopped':False,'target':False,'migrated':False,'reconciled':False};records=[]
  result.write_text(source_record or ('tag=v0.7.18\\nrevision='+source+'\\n'))
  env.write_bytes(original_env);override.write_bytes(original_override)
  def container(service):
   if service=='postgres':
    host_ip='0.0.0.0' if failure=='database_exposed' else '127.0.0.1'
    return {'Id':pg,'Image':'postgres-image','State':{'Health':{'Status':'healthy'}},
     'Config':{'Image':'postgres-image','Labels':{}},'NetworkSettings':{'Ports':{'5432/tcp':[{'HostIp':host_ip}]}}}
   index=m.WRITERS.index(service)
   target_writer=state['target']
   identifier=(str(index+4)*64 if target_writer else source_ids[index])
   version='0.8.0-dev.1' if target_writer else '0.7.18'
   runtime=[k+'='+v for k,v in m.MCP_SETTINGS.items()]+['AI_PROJECT_OS_WEB_BROWSER_ENABLED=false']
   if failure=='runtime_config' and target_writer and service=='app':runtime[0]='AI_PROJECT_OS_MCP_ACTIONS_ENABLED=false'
   if failure=='browser' and target_writer and service=='app':runtime[-1]='AI_PROJECT_OS_WEB_BROWSER_ENABLED=1'
   return {'Id':identifier,'Image':service+'-image','State':{'Health':{'Status':'healthy'},
    'Running':True if target_writer else not state['stopped'],'Paused':False},
    'Config':{'Image':service+'-image','Env':runtime,'Labels':{'org.opencontainers.image.version':version}}}
  def run(args):
   if 'get-url' in args:return 'fixed-remote'
   if 'status' in args:return ''
   if 'cat-file' in args:
    calls.append('tag-type-check');return 'commit' if failure=='bad_tag' else 'tag'
   if 'rev-parse' in args:
    calls.append('tag-sha-check');return 'b'*40 if failure=='bad_tag_sha' else target
   if 'merge-base' in args:
    calls.append(('ancestry-check',tuple(args)))
    if failure=='not_descendant':raise RuntimeError('GIT_FAILED')
    return ''
   if 'rev-list' in args:
    calls.append('no-merge-check');return 'merge' if failure=='merge_commit' else ''
   if 'diff' in args:
    if '--name-only' in args:
     calls.append('migration-scope-check')
     return 'prisma/migrations/unexpected/migration.sql' if failure=='migration_scope' else 'prisma/migrations/'+m.MIGRATION+'/migration.sql'
    calls.append('infrastructure-scope-check')
    if failure=='infrastructure_scope':raise RuntimeError('SCOPE_CHANGED')
    return ''
   if 'checkout' in args:calls.append('checkout')
   return ''
  def compose(*args,**kwargs):
   calls.append(('compose',args))
   if args[0]=='build' and failure=='build':raise RuntimeError('BUILD_FAILED')
   if args[0]=='up' and args[-1]=='migrate':
    if failure=='migrate':raise RuntimeError('MIGRATION_FAILED')
    state['migrated']=True
   if args[0]=='up' and args[-1]=='reconcile':
    if failure=='reconcile':raise RuntimeError('RECONCILE_FAILED')
    state['reconciled']=True
   if args[0]=='up' and args[-1] in m.WRITERS:state['target']=True
  def healthy(version,public=False):
   calls.append(('healthy',version,public))
   if version=='0.8.0-dev.1' and failure in ('health','quiesce'):raise RuntimeError('HEALTH_FAILED')
   return {'version':version,'public':public}
  def require_ci(revision):
   calls.append(('ci',revision,m.TAG))
   if failure=='ci':raise RuntimeError('CI_FAILED')
   assert revision==target and m.TAG=='v0.8.0-dev.1'
  def wait_service(service):
   calls.append(('wait',service))
   if failure==service:raise RuntimeError('SERVICE_FAILED')
  def docker(*args):
   calls.append(('docker',args))
   if args[0]=='stop':state['stopped']=True
   if args[0]=='inspect':
    identifier=args[1];index=source_ids.index(identifier)
    return json.dumps([{'Id':identifier,'State':{'Running':not state['stopped']}}])
   return ''
  def ledger(postgres_id,expected):
   count=len(expected);calls.append(('ledger',count))
   assert postgres_id==pg and count in (141,142)
   assert count==142 if state['reconciled'] else count==141
  def backup(writers):
   calls.append(('backup',tuple(w['Id'] for w in writers)))
   assert [w['Id'] for w in writers]==source_ids
   if failure=='backup':raise RuntimeError('V080_DEV1_BACKUP_FAILED')
   if bad_backup=='wrong_date':return backup_output.replace('/2026/10/08/','/2026/10/07/')
   return backup_output.replace('source_quiesced=true','source_quiesced=false') if bad_backup else backup_output
  def quiesce_after_failure(pgid):
   calls.append('quiesce-attempted')
   if failure=='quiesce':raise RuntimeError('QUIESCE_FAILED')
   calls.append('quiesced');state.update(stopped=True)
  lib=types.SimpleNamespace(ENV=env,OVERRIDE=override,RESULT=result,REMOTE='fixed-remote',IMAGE='postgres-image',
   trusted=lambda *args:None,container=container,run=run,healthy=healthy,request_json=lambda url:{
    'resource':'https://ai-project-os.com/api/mcp','authorization_servers':['https://ai-project-os.com'],
    'scopes_supported':['project:read']},require_ci=require_ci,ledger=ledger,
   compose=compose,wait_service=wait_service,docker=docker,stopped=lambda pgid:calls.append('isolated'),
   atomic_write=lambda path,data,mode:records.append(data.decode()),
   quiesce_after_failure=quiesce_after_failure,
   restart_source=lambda writers:(calls.append('source-restarted'),state.update(stopped=False)))
  m.helper=lambda:lib;m.run_predeploy_backup=backup
  previous_sys=m.sys;error_stream=io.StringIO();m.sys=types.SimpleNamespace(stderr=error_stream)
  try:
   with contextlib.redirect_stderr(error_stream):
    try:m.main([target,m.CONFIRMATION])
    except BaseException as error:errors.append(str(error))
  finally:m.sys=previous_sys
  assert env.read_bytes()==original_env and override.read_bytes()==original_override
  return calls,errors,records,error_stream.getvalue()

for failure,record in (
 ('bad_tag','tag=v0.7.18\\nrevision='+source+'\\n'),
 ('bad_tag_sha','tag=v0.7.18\\nrevision='+source+'\\n'),
 ('not_descendant','tag=v0.7.18\\nrevision='+source+'\\n'),
 ('merge_commit','tag=v0.7.18\\nrevision='+source+'\\n'),
 ('migration_scope','tag=v0.7.18\\nrevision='+source+'\\n'),
 ('infrastructure_scope','tag=v0.7.18\\nrevision='+source+'\\n'),
 ('database_exposed','tag=v0.7.18\\nrevision='+source+'\\n'),
 ('ci','tag=v0.7.18\\nrevision='+source+'\\n'),
 ('build','tag=v0.7.18\\nrevision='+source+'\\n'),
):
 calls,errors,records,error_output=scenario(failure,record)
 assert errors and not records,(failure,calls,errors)
 assert not any(isinstance(c,tuple) and c[0]=='docker' and c[1][0]=='stop' for c in calls)
 assert not any(isinstance(c,tuple) and c[0]=='backup' for c in calls)
for failure in ('backup','migrate','reconcile','health','runtime_config','browser','quiesce'):
 calls,errors,records,error_output=scenario(failure)
 assert errors and not records,(failure,calls,errors,error_output)
 if failure=='backup':
  assert 'source-restarted' in calls and 'quiesced' not in calls
  assert not any(isinstance(c,tuple) and c[0]=='compose' and c[1][0]=='up' and 'migrate' in c[1] for c in calls)
 else:
  assert 'quiesce-attempted' in calls and 'source-restarted' not in calls,(failure,calls,errors)
  assert ('quiesced' in calls) == (failure!='quiesce'),(failure,calls,errors)
  assert 'backup_name='+backup_name in error_output and 'backup_object='+archive in error_output
  assert ('writers_quiesced=true' in error_output) == (failure!='quiesce')
  assert ('writers_quiesced=unknown' in error_output) == (failure=='quiesce')
  recovery=[line for line in calls if isinstance(line,tuple) and line[0]=='compose']
  assert not any(call[1][0]=='up' and call[1][-1] in m.WRITERS for call in recovery) if failure in ('migrate','reconcile') else True
for invalid_backup in (True,'wrong_date'):
 calls,errors,records,error_output=scenario(bad_backup=invalid_backup)
 assert errors and not records and 'source-restarted' in calls and 'quiesced' not in calls

# A wrong source receipt fails before Git/tag/CI/build/backup activity.
calls,errors,records,error_output=scenario(None,'tag=v0.7.17\\nrevision='+source+'\\n')
assert errors and not records and not any(c=='tag-type-check' or isinstance(c,tuple) and c[0]=='backup' for c in calls)

calls,errors,records,error_output=scenario()
assert errors==[] and len(records)==1
events=[c for c in calls if isinstance(c,tuple)]
build=next(i for i,c in enumerate(events) if c[0]=='compose' and c[1][0]=='build')
stop=next(i for i,c in enumerate(events) if c[0]=='docker' and c[1][0]=='stop')
backup=next(i for i,c in enumerate(events) if c[0]=='backup')
migrate=next((i for i,c in enumerate(events) if c[0]=='compose' and c[1][-1]=='migrate' and c[1][0]=='up'),None)
assert migrate is not None,events
reconcile=next(i for i,c in enumerate(events) if c[0]=='compose' and c[1][-1]=='reconcile' and c[1][0]=='up')
start=next(i for i,c in enumerate(events) if c[0]=='compose' and c[1][-1] in m.WRITERS and c[1][0]=='up')
assert build<stop<backup<migrate<reconcile<start
assert next(i for i,c in enumerate(events) if c[0]=='ci')<build
assert [c[1] for c in events if c[0]=='ledger']==[141,141,141,142,142]
assert calls.count('isolated')==5 and 'source-restarted' not in calls and 'quiesced' not in calls
backup_call=calls.index(('backup',tuple(source_ids)))
migration_call=next(i for i,c in enumerate(calls) if isinstance(c,tuple) and c[0]=='compose'
 and c[1][0]=='up' and c[1][-1]=='migrate')
assert calls.index('isolated')<backup_call<calls.index('isolated',backup_call+1)<migration_call
record=records[0]
for item in ('tag=v0.8.0-dev.1','source_tag=v0.7.18','source_revision='+source,
 'migration_count=142','ci_acceptance=full_main_and_tag_ci','backup_name=20261008T120000Z-pre-deploy-to-v0.8.0-dev.1.Abc123',
 'backup_object=cos://ai-project-os-backup-1234567890/production/backups/2026/10/08/',
 'backup_manifest=cos://ai-project-os-backup-1234567890/production/manifests/latest.json',
 'backup_retention_removed=0'):
 assert item in record,item
try:m.main([target,'CONFIRM_V080_DEV1_WITHOUT_BACKUP']);raise AssertionError('invalid confirmation accepted')
except RuntimeError as error:assert str(error)=='V080_DEV1_ARGUMENTS_INVALID'
print('V080_DEV1_OFFLINE_CUTOVER_OK')
`], { encoding: "utf8" });
  assert.match(output, /V080_DEV1_OFFLINE_CUTOVER_OK/u);
});
