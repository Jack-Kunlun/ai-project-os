import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const path = "deploy/production/ai-project-os-v074-deploy.py";
const source = readFileSync(path, "utf8");

test("v0.7.4 deployment validates both main and tag full database CI and exact ledger", () => {
  const result = execFileSync("python3", ["-B", "-c", `
import importlib.util,shutil,tempfile
spec=importlib.util.spec_from_file_location('deploy', '${path}')
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
sha='a'*40
runs=[dict(head_sha=sha,head_branch=branch,event='push',status='completed',conclusion='success',id=i) for i,branch in enumerate(['main','v0.7.4'], 1)]
good_jobs={'jobs':[{'name':'Verify database and release candidate','conclusion':'success'}]}
responses={1:good_jobs,2:good_jobs}
def fetch(url):
 if '/workflows/' in url: return {'workflow_runs':runs}
 return responses[int(url.split('/runs/')[1].split('/')[0])]
m.request_json=fetch
m.require_ci(sha)
responses[2]={'jobs':[{'name':'Verify database and release candidate','conclusion':'skipped'}]}
try: m.require_ci(sha); raise AssertionError('tag DB CI bypassed')
except RuntimeError as e: assert str(e)=='V074_FULL_DATABASE_CI_REQUIRED'
responses[2]=good_jobs
runs[0]['head_sha']='b'*40
try: m.require_ci(sha); raise AssertionError('wrong main accepted')
except RuntimeError as e: assert str(e)=='V074_EXACT_MAIN_AND_TAG_CI_REQUIRED'
row=dict(migration_name='test',checksum='c'*64,finished=True,rolled_back=False,applied_steps_count=1)
m.db_query=lambda *args:[row]
m.ledger('id',[('test','c'*64)])
for key,value in [('checksum','d'*64),('finished',False),('rolled_back',True),('applied_steps_count',0)]:
 old=row[key];row[key]=value
 try: m.ledger('id',[('test','c'*64)]);raise AssertionError('bad ledger accepted')
 except RuntimeError as e: assert str(e)=='V074_MIGRATION_LEDGER_INVALID'
 row[key]=old
try: m.ledger('id',[]);raise AssertionError('wrong count accepted')
except RuntimeError as e: assert str(e)=='V074_MIGRATION_COUNT_INVALID'
with tempfile.TemporaryDirectory() as directory:
 historical=m.Path(directory)
 for migration in sorted((m.Path.cwd()/'prisma/migrations').iterdir()):
  if migration.is_dir() and migration.name <= '20261006014000_add_sms_provider_adapters':
   shutil.copytree(migration,historical/'prisma/migrations'/migration.name)
 assert len(m.manifest(historical))==140
calls=[]
pg='1'*64; migrate='2'*64; reconcile='3'*64; app='4'*64
def recovery_docker(*args):
 calls.append(args)
 if args[0]=='ps': return chr(10).join([pg+' postgres',migrate+' migrate',reconcile+' reconcile',app+' app'])
 return ''
m.docker=recovery_docker
m.stopped=lambda value: calls.append(('isolated',value))
m.quiesce_after_failure(pg)
assert calls[-2]==('stop',migrate,reconcile,app)
assert calls[-1]==('isolated',pg)
calls=[]
def source_docker(*args):
 calls.append(args)
 if args[0]=='inspect': return m.json.dumps([{'State':{'Running':args[1]==app}}])
 return ''
m.docker=source_docker
m.restart_source([{'Id':app},{'Id':migrate}])
assert calls[-1]==('start',migrate)
calls=[]
m.require_ci=lambda revision: calls.append(revision)
assert m.release_acceptance(sha,'CONFIRM_V074_WITHOUT_BACKUP')=='full_main_and_tag_ci'
assert calls==[sha]
calls.clear()
assert m.release_acceptance(sha,'CONFIRM_V074_FAST_WITHOUT_BACKUP_OR_LEGACY_ACCEPTANCE')=='waived_by_user_pre_1_0'
assert calls==[]
try: m.release_acceptance(sha,'FAST'); raise AssertionError('implicit waiver accepted')
except RuntimeError as e: assert str(e)=='V074_ARGUMENTS_INVALID'
print('V074_OFFLINE_BEHAVIOR_OK')
`], { encoding: "utf8" });
  assert.equal(result.trim(), "V074_RELEASE_ACCEPTANCE_WAIVED_BY_USER_PRE_1_0\nV074_OFFLINE_BEHAVIOR_OK");
});

test("v0.7.4 cutover keeps old source identity, stop and mutation boundaries", () => {
  assert.match(source, /SOURCE_REVISION = '9f4b34b746d9433e51fbf0c2e00d375fa841aac0'/u);
  assert.match(source, /CONFIRM_V074_WITHOUT_BACKUP/u);
  assert.doesNotMatch(source, /refs\/tags\/.*SOURCE|merge-base|ai-project-os-backup/u);
  assert.match(source, /PHONE_AUTH_MUST_REMAIN_DISABLED/u);
  assert.match(source, /os\.O_NOFOLLOW/u);
  assert.match(source, /fcntl\.flock\(fd, fcntl\.LOCK_EX \| fcntl\.LOCK_NB\)/u);
  const stop = source.indexOf("docker('stop', *[w['Id'] for w in old_writers])");
  const mutation = source.indexOf("mutation = True");
  const migrate = source.indexOf("compose('up', '-d', '--no-deps', '--no-build', '--force-recreate', 'migrate')");
  const reconcile = source.indexOf("compose('up', '-d', '--no-deps', '--no-build', '--force-recreate', 'reconcile')");
  const start = source.indexOf("compose('up', '-d', '--no-deps', '--no-build', '--force-recreate', 'app'");
  assert.ok(stop > 0 && mutation > stop && migrate > mutation && reconcile > migrate && start > reconcile);
  assert.match(source, /if not mutation:[\s\S]*?restart_source\(old_writers\)[\s\S]*?elif not writers_healthy:/u);
  assert.match(source, /V074_MIGRATION_RECOVERY_REQUIRED writers_stopped=true/u);
});
