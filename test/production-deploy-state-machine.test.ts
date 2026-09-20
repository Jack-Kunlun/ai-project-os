import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const cleanDeployPath = resolve(process.cwd(), "deploy/production/ai-project-os-clean-deploy");
const appId = "a".repeat(64);
const workerId = "b".repeat(64);
const postgresId = "c".repeat(64);

function extractFunction(source: string, name: string, endMarker: string): string {
  const start = source.indexOf(`${name}() {`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(start, -1, `${name} start`);
  assert.notEqual(end, -1, `${name} end`);
  return source.slice(start, end).trim();
}

async function runScenario(scenario: "source-failure" | "stop-failure" | "backup-failure" | "mutation-failure") {
  const source = await readFile(cleanDeployPath, "utf8");
  const recover = extractFunction(source, "recover_old_writers_on_failure", "\ntrap recover_old_writers_on_failure EXIT");
  const assertStack = extractFunction(source, "assert_stack_container", "\n\nwait_for_old_writers");
  const isolation = extractFunction(source, "assert_maintenance_isolation", "\n\nstop_source_writers");
  const capture = extractFunction(source, "capture_source_writers", "\ncapture_source_writers");
  const stop = extractFunction(source, "stop_source_writers", "\nstop_source_writers");
  const drain = extractFunction(source, "drain_postgres_clients", "\nstop_source_writers\n");
  const directory = await mkdtemp(join(tmpdir(), "ai-project-os-clean-deploy-state-"));
  const harnessPath = join(directory, "harness.sh");
  const tracePath = join(directory, "trace.log");

  await writeFile(
    harnessPath,
    `#!/usr/bin/env bash
set -Eeuo pipefail
MUTATION_ATTEMPTED=0
DESTRUCTIVE_RESET_COMMITTED=0
WRITER_RECOVERY_REQUIRED=0
COMPOSE_PROJECT=ai-project-os
OLD_APP_ID=
OLD_WORKER_ID=
TRACE_FILE=$1
SCENARIO=$2
APP_ID=${appId}
WORKER_ID=${workerId}
POSTGRES_ID=${postgresId}
POSTGRES_CLIENT_DRAIN_ATTEMPTS=30
POSTGRES_CLIENT_DRAIN_INTERVAL_SECONDS=2
POSTGRES_CLIENT_DRAIN_TIMEOUT_SECONDS=10
compose() {
  printf 'compose:%s\\n' "$*" >> "$TRACE_FILE"
  if [[ "$1 $2 $3" == "ps -q app" ]]; then printf '%s\\n' "$APP_ID"; return; fi
  if [[ "$1 $2 $3" == "ps -q worker" ]]; then printf '%s\\n' "$WORKER_ID"; return; fi
  if [[ "$1 $2 $3" == "ps -q postgres" ]]; then printf '%s\\n' "$POSTGRES_ID"; return; fi
  if [[ "$1 $2 $3 $4" == "ps --services --status running" ]]; then printf 'postgres\\n'; return; fi
}
docker() {
  printf 'docker:%s\\n' "$*" >> "$TRACE_FILE"
  case "$1" in
    inspect)
      local format=
      for arg in "$@"; do
        [[ "$arg" == --format ]] && continue
        if [[ -z "$format" && "$arg" == *'{{'* ]]; then format=$arg; fi
      done
      case "$format" in
        *Config.Labels*)
          if [[ "$4" == "$APP_ID" ]]; then
            printf 'ai-project-os:app\\n'
          elif [[ "$4" == "$WORKER_ID" ]]; then
            printf 'ai-project-os:worker\\n'
          else
            printf 'ai-project-os:postgres\\n'
          fi
          ;;
        *NetworkSettings.Ports*) printf '[{"HostIp":"127.0.0.1","HostPort":"5433"}]\\n' ;;
        *State.Running*State.Paused*) printf 'false:false\\n' ;;
        *State.Running*) printf 'false\\n' ;;
        *State.Paused*) printf 'false\\n' ;;
        *) printf 'healthy\\n' ;;
      esac
      ;;
    stop)
      [[ "$SCENARIO" != stop-failure ]] || return 72
      ;;
    exec) printf '0\\n' ;;
    start|unpause) ;;
  esac
}
timeout() { shift; "$@"; }
container_health() { printf 'healthy\\n'; }
curl() {
  if [[ "$SCENARIO" == source-failure ]]; then
    printf '{"status":"ok","version":"0.4.0-dev.0","database":"up","worker":{"status":"up"}}\\n'
  else
    printf '{"status":"ok","version":"0.4.0-dev.1","database":"up","worker":{"status":"up"}}\\n'
  fi
}
wait_for_old_writers() { printf 'wait:old-writers\\n' >> "$TRACE_FILE"; }
fail() { printf '%s\\n' "$1" >&2; exit \"\${2-1}\"; }
trap recover_old_writers_on_failure EXIT
${recover}
${assertStack}
mapfile() {
  local target=$2 line
  while IFS= read -r line; do
    eval "$target+=(\"\$line\")"
  done
}
${isolation}
${capture}
${stop}
${drain}
capture_source_writers
stop_source_writers
drain_postgres_clients
printf 'backup\\n' >> "$TRACE_FILE"
if [[ "$SCENARIO" == backup-failure || "$SCENARIO" == mutation-failure ]]; then
  if [[ "$SCENARIO" == mutation-failure ]]; then
    MUTATION_ATTEMPTED=1
    printf 'mutation\\n' >> "$TRACE_FILE"
  fi
  fail CLEAN_DEPLOY_SCENARIO_FAILURE
fi
`,
    { mode: 0o700 },
  );
  await chmod(harnessPath, 0o700);

  const result = spawnSync("bash", [harnessPath, tracePath, scenario], { encoding: "utf8" });
  const trace = await readFile(tracePath, "utf8").catch(() => "");
  await rm(directory, { recursive: true, force: true });
  return { result, trace };
}

test("clean deployment restores exact old writers before mutation", async () => {
  const scenarios = ["source-failure", "stop-failure", "backup-failure"] as const;
  for (const scenario of scenarios) {
    const { result, trace } = await runScenario(scenario);
    assert.notEqual(result.status, 0, scenario);
    if (scenario === "source-failure") {
      assert.doesNotMatch(trace, /docker:stop /u);
      assert.doesNotMatch(trace, /docker:start /u);
      continue;
    }
    const evidence = `${trace}\n${result.stderr}`;
    assert.match(evidence, new RegExp(`docker:stop ${appId} ${workerId}`));
    assert.match(evidence, new RegExp(`docker:start ${appId}`));
    assert.match(evidence, new RegExp(`docker:start ${workerId}`));
    assert.match(evidence, /wait:old-writers/u);
  }
});

test("clean deployment never restarts old writers after mutation begins", async () => {
  const { result, trace } = await runScenario("mutation-failure");
  assert.notEqual(result.status, 0, result.stderr);
  const evidence = `${trace}\n${result.stderr}`;
  assert.match(evidence, new RegExp(`docker:stop ${appId} ${workerId}`));
  assert.doesNotMatch(evidence, /docker:start /u);
  assert.doesNotMatch(evidence, /wait:old-writers/u);
  assert.match(result.stderr, /CLEAN_DEPLOY_RECOVERY_REQUIRED mutation_attempted=true/u);
});

test("clean deployment drains PostgreSQL clients between writer stop and backup mutation", async () => {
  const { result, trace } = await runScenario("mutation-failure");
  assert.notEqual(result.status, 0, result.stderr);
  const stopIndex = trace.indexOf(`docker:stop ${appId} ${workerId}`);
  const drainIndex = trace.indexOf("docker:exec");
  const backupIndex = trace.indexOf("backup\n");
  const mutationIndex = trace.indexOf("mutation\n");
  assert.ok(stopIndex >= 0);
  assert.ok(drainIndex > stopIndex);
  assert.ok(backupIndex > drainIndex);
  assert.ok(mutationIndex > backupIndex);
});
