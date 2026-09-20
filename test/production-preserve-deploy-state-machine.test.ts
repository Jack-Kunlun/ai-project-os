import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const preservePath = path.resolve(process.cwd(), "deploy/production/ai-project-os-preserve-deploy");

function extractFunction(source: string, name: string, endMarker: string): string {
  const start = source.indexOf(`${name}() {`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(start, -1, `${name} start`);
  assert.notEqual(end, -1, `${name} end`);
  return source.slice(start, end).trim();
}

type RecoveryScenario =
  | "pre-backup-failure"
  | "switch-failure"
  | "rollback-failure"
  | "rollback-quarantine-failure"
  | "rollback-isolation-failure";

async function runRecoveryScenario(scenario: RecoveryScenario) {
  const source = await readFile(preservePath, "utf8");
  const quarantine = extractFunction(
    source,
    "quiesce_current_writers_after_rollback_failure",
    "\nrecover_on_failure",
  );
  const recovery = extractFunction(source, "recover_on_failure", "\n[[ $EUID");
  const directory = await mkdtemp(path.join(tmpdir(), "ai-project-os-preserve-state-"));
  const harness = path.join(directory, "harness.sh");
  await writeFile(
    harness,
    `#!/usr/bin/env bash
set -Eeuo pipefail
SCENARIO=$1
CUTOVER_ATTEMPTED=$([[ "$SCENARIO" == switch-failure || "$SCENARIO" == rollback-failure ]] && printf 1 || printf 0)
[[ "$SCENARIO" == rollback-quarantine-failure || "$SCENARIO" == rollback-isolation-failure ]] && CUTOVER_ATTEMPTED=1
WRITER_RECOVERY_REQUIRED=1
TRACE_FILE=$2
COMPOSE_PROJECT=ai-project-os
POSTGRES_ID=cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
APP_ID=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
WORKER_ID=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
STATE_FILE=$TRACE_FILE.state
printf 'app=1\\nworker=1\\n' > "$STATE_FILE"
assert_maintenance_isolation() {
  printf 'isolation\\n' >> "$TRACE_FILE"
  [[ "$SCENARIO" != rollback-isolation-failure ]]
}
docker() {
  local command=$1 app_running worker_running
  shift
  app_running=$(sed -n 's/^app=//p' "$STATE_FILE")
  worker_running=$(sed -n 's/^worker=//p' "$STATE_FILE")
  case "$command" in
    ps)
      if [[ "$*" == *service=app* ]]; then
        [[ "$app_running" == 1 ]] && printf '%s\\n' "$APP_ID"
        return 0
      elif [[ "$*" == *service=worker* ]]; then
        [[ "$worker_running" == 1 ]] && printf '%s\\n' "$WORKER_ID"
        return 0
      elif [[ "$*" == *compose.project* ]]; then
        printf '%s\\n' "$POSTGRES_ID"
      else
        return 1
      fi
      ;;
    stop)
      printf 'stop:%s\\n' "$1" >> "$TRACE_FILE"
      if [[ "$SCENARIO" == rollback-quarantine-failure ]]; then
        return 1
      elif [[ "$1" == "$APP_ID" ]]; then
        printf 'app=0\\nworker=%s\\n' "$worker_running" > "$STATE_FILE"
      elif [[ "$1" == "$WORKER_ID" ]]; then
        printf 'app=%s\\nworker=0\\n' "$app_running" > "$STATE_FILE"
      else
        return 1
      fi
      ;;
    *)
      return 1
      ;;
  esac
}
rollback_to_source() {
  printf 'rollback\\n' >> "$TRACE_FILE"
  [[ "$SCENARIO" != rollback-failure && "$SCENARIO" != rollback-quarantine-failure && "$SCENARIO" != rollback-isolation-failure ]]
}
restart_source_writers() {
  printf 'restart\\n' >> "$TRACE_FILE"
  return 0
}
${quarantine}
${recovery}
trap recover_on_failure EXIT
exit 74
`,
    { mode: 0o700 },
  );
  await chmod(harness, 0o700);
  const trace = path.join(directory, "trace.log");
  const result = spawnSync("bash", [harness, scenario, trace], { encoding: "utf8" });
  const evidence = `${result.stdout}\n${result.stderr}\n${await readFile(trace, "utf8").catch(() => "")}`;
  await rm(directory, { recursive: true, force: true });
  return { result, evidence };
}

async function runIsolationScenario(dockerIds: string[]) {
  const source = await readFile(preservePath, "utf8");
  const isolation = extractFunction(source, "assert_maintenance_isolation", "\nstop_source_writers");
  const directory = await mkdtemp(path.join(tmpdir(), "ai-project-os-preserve-isolation-"));
  const harness = path.join(directory, "harness.sh");
  const postgresId = `13e7${"a".repeat(60)}`;
  const dockerOutput = dockerIds.map((id) => `  printf '%s\\n' "${id}"`).join("\n");
  await writeFile(
    harness,
    `#!/usr/bin/env bash
set -Eeuo pipefail
COMPOSE_PROJECT=ai-project-os
POSTGRES_ID=${postgresId}
mapfile() {
  local _flag=$1 variable=$2 line
  eval "$variable=()"
  while IFS= read -r line; do
    eval "$variable+=(\\"$line\\")"
  done
}
docker() {
  [[ "\${1-}" == ps ]] || return 1
  [[ " $* " == *"label=com.docker.compose.project=$COMPOSE_PROJECT"* ]] || return 1
${dockerOutput}
}
${isolation}
assert_maintenance_isolation
`,
    { mode: 0o700 },
  );
  await chmod(harness, 0o700);
  const result = spawnSync("bash", [harness], { encoding: "utf8" });
  await rm(directory, { recursive: true, force: true });
  return result;
}

test("pre-switch backup failure restarts only the captured source writers", async () => {
  const { result, evidence } = await runRecoveryScenario("pre-backup-failure");
  assert.equal(result.status, 74);
  assert.match(evidence, /restart/u);
  assert.doesNotMatch(evidence, /rollback/u);
});

test("post-switch failure attempts source rollback and does not restart blindly", async () => {
  const { result, evidence } = await runRecoveryScenario("switch-failure");
  assert.equal(result.status, 74);
  assert.match(evidence, /rollback/u);
  assert.doesNotMatch(evidence, /^restart$/mu);
});

test("rollback failure emits an explicit recovery-required marker", async () => {
  const { result, evidence } = await runRecoveryScenario("rollback-failure");
  assert.equal(result.status, 74);
  assert.match(evidence, /rollback/u);
  assert.match(evidence, /PRESERVE_DEPLOY_RECOVERY_REQUIRED phase=post-switch writers_stopped=true/u);
  assert.doesNotMatch(evidence, /writers_may_be_running/u);
  assert.doesNotMatch(evidence, /^restart$/mu);
});

test("rollback quarantine failure reports writers may be running", async () => {
  const { result, evidence } = await runRecoveryScenario("rollback-quarantine-failure");
  assert.equal(result.status, 74);
  assert.match(evidence, /PRESERVE_DEPLOY_EMERGENCY phase=post-switch writers_may_be_running=true/u);
  assert.doesNotMatch(evidence, /writers_stopped=true/u);
  assert.match(evidence, /stop:/u);
});

test("rollback isolation failure reports writers may be running", async () => {
  const { result, evidence } = await runRecoveryScenario("rollback-isolation-failure");
  assert.equal(result.status, 74);
  assert.match(evidence, /PRESERVE_DEPLOY_EMERGENCY phase=post-switch writers_may_be_running=true/u);
  assert.doesNotMatch(evidence, /writers_stopped=true/u);
  assert.match(evidence, /isolation/u);
});

test("maintenance isolation compares full Docker IDs as strings and rejects extra containers", async () => {
  const postgresId = `13e7${"a".repeat(60)}`;
  const extraId = `deadbeef${"b".repeat(56)}`;
  const otherId = `01234567${"c".repeat(56)}`;

  const isolated = await runIsolationScenario([postgresId]);
  assert.equal(isolated.status, 0, isolated.stderr);
  assert.doesNotMatch(isolated.stderr, /value too great for base/u);

  const empty = await runIsolationScenario([]);
  assert.notEqual(empty.status, 0);

  const contaminated = await runIsolationScenario([postgresId, extraId]);
  assert.notEqual(contaminated.status, 0);

  const wrongId = await runIsolationScenario([otherId]);
  assert.notEqual(wrongId.status, 0);
});
