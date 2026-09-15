import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

const deployPath = resolve(process.cwd(), "deploy/production/ai-project-os-deploy");
const appId = "a".repeat(64);
const workerId = "b".repeat(64);

function extractFunction(source: string, name: string, nextMarker: string): string {
  const start = source.indexOf(`${name}() {`);
  const end = source.indexOf(nextMarker, start);
  assert.notEqual(start, -1, `${name} start`);
  assert.notEqual(end, -1, `${name} end`);
  return source.slice(start, end).trim();
}

async function runScenario(scenario: "success" | "source-version-failure" | "post-stop-failure" | "stop-failure" | "mutation-failure") {
  const source = await readFile(deployPath, "utf8");
  const recover = extractFunction(source, "recover_old_writers_on_failure", "\n\ntrap recover_old_writers_on_failure EXIT");
  const cutover = extractFunction(source, "perform_writer_cutover", "\n\nperform_writer_cutover");
  const directory = await mkdtemp(resolve(tmpdir(), "ai-project-os-deploy-state-"));
  const harness = resolve(directory, "harness.sh");
  const trace = resolve(directory, "trace.log");
  await writeFile(harness, `#!/usr/bin/env bash
set -Eeuo pipefail
MUTATION_ATTEMPTED=0
WRITER_RECOVERY_REQUIRED=0
OLD_APP_ID=
OLD_WORKER_ID=
TRACE_FILE=$1
SCENARIO=$2
APP_ID=${appId}
WORKER_ID=${workerId}
compose() {
  printf 'compose:%s\\n' "$*" >> "$TRACE_FILE"
  if [[ "$1 $2 $3" == "ps -q app" ]]; then printf '%s\\n' "$APP_ID"; return 0; fi
  if [[ "$1 $2 $3" == "ps -q worker" ]]; then printf '%s\\n' "$WORKER_ID"; return 0; fi
  if [[ "$1 $2 $3" == "ps -q postgres" ]]; then printf '%s\\n' "${"c".repeat(64)}"; return 0; fi
  if [[ "$1 $2 $3 $4" == "ps --services --status running" ]]; then printf 'postgres\\n'; return 0; fi
  if [[ "$1" == up && "$SCENARIO" == mutation-failure ]]; then return 71; fi
}
docker() {
  printf 'docker:%s\\n' "$*" >> "$TRACE_FILE"
  if [[ "$1" == stop && "$SCENARIO" == stop-failure ]]; then return 72; fi
  if [[ "$1" == inspect ]]; then printf 'false\\n'; fi
}
container_health() { printf 'healthy\\n'; }
curl() {
  if [[ "$SCENARIO" == source-version-failure ]]; then
    printf '{"status":"ok","version":"5.1.1","database":"up","worker":{"status":"up"}}\\n'
  else
    printf '{"status":"ok","version":"5.1.2","database":"up","worker":{"status":"up"}}\\n'
  fi
}
assert_maintenance_isolation() { printf 'isolation:verified\\n' >> "$TRACE_FILE"; }
run_upgrade_preflight() {
  printf 'preflight:%s\\n' "$1" >> "$TRACE_FILE"
  [[ "$SCENARIO" != post-stop-failure ]]
}
wait_for_stack() { printf 'wait:new-stack\\n' >> "$TRACE_FILE"; }
wait_for_old_writers() { printf 'wait:old-writers\\n' >> "$TRACE_FILE"; }
${recover}
${cutover}
trap recover_old_writers_on_failure EXIT
perform_writer_cutover
`, { mode: 0o700 });
  const result = spawnSync("bash", [harness, trace, scenario], { encoding: "utf8" });
  const commands = (await readFile(trace, "utf8")).trim().split("\n");
  await rm(directory, { recursive: true, force: true });
  return { result, commands };
}

test("unexpected source version fails before stopping either writer", async () => {
  const { result, commands } = await runScenario("source-version-failure");
  assert.notEqual(result.status, 0);
  assert.ok(!commands.some((command) => command.startsWith("docker:stop ")));
  assert.ok(!commands.some((command) => command.startsWith("docker:start ")));
  assert.ok(!commands.some((command) => command.startsWith("compose:up ")));
});

test("pre-mutation post-stop failure restarts only the captured old writers", async () => {
  const { result, commands } = await runScenario("post-stop-failure");
  assert.notEqual(result.status, 0);
  assert.ok(commands.includes(`docker:stop ${appId} ${workerId}`));
  assert.ok(commands.includes("preflight:post-stop"));
  assert.equal(commands.filter((command) => command === "isolation:verified").length, 1);
  assert.ok(commands.includes(`docker:start ${appId} ${workerId}`));
  assert.ok(commands.includes("wait:old-writers"));
  assert.ok(!commands.some((command) => command.startsWith("compose:up ")));
});

test("partial writer stop failure still restarts the exact captured IDs", async () => {
  const { result, commands } = await runScenario("stop-failure");
  assert.notEqual(result.status, 0);
  assert.ok(commands.includes(`docker:stop ${appId} ${workerId}`));
  assert.ok(commands.includes(`docker:start ${appId} ${workerId}`));
  assert.ok(!commands.includes("preflight:post-stop"));
});

test("mutation failure preserves the upgraded scene and never starts old writers", async () => {
  const { result, commands } = await runScenario("mutation-failure");
  assert.notEqual(result.status, 0);
  assert.ok(commands.includes("preflight:post-stop"));
  assert.equal(commands.filter((command) => command === "isolation:verified").length, 2);
  assert.ok(commands.includes("compose:up -d --no-build --force-recreate principal-bootstrap migrate reconcile app worker"));
  assert.ok(!commands.some((command) => command.startsWith("docker:start ")));
  assert.ok(!commands.includes("wait:old-writers"));
});

test("successful cutover waits for the new stack without recovery", async () => {
  const { result, commands } = await runScenario("success");
  assert.equal(result.status, 0, result.stderr);
  assert.ok(commands.includes("preflight:post-stop"));
  assert.equal(commands.filter((command) => command === "isolation:verified").length, 2);
  assert.ok(commands.includes("compose:up -d --no-build --force-recreate principal-bootstrap migrate reconcile app worker"));
  assert.ok(commands.includes("wait:new-stack"));
  assert.ok(!commands.some((command) => command.startsWith("docker:start ")));
});
