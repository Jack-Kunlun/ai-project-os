/** Fixture-only runtime check. Never reads production env files or credentials. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const image = "pgvector/pgvector:0.8.6-pg18-trixie@sha256:78bf48b801e792f99e3ac62b5036fd3876e9be48afda16c1e331af1c75ceb2ff";
const directory = mkdtempSync(path.join(tmpdir(), "email-compose-fixture-"));
const project = `email-config-${randomUUID().slice(0, 8)}`;
const configuration = path.join(directory, "compose.json");
const secret = "synthetic-'\"$VALUE\\\\#=tail\\";
const compose = (...args) => spawnSync("docker", ["compose", "-p", project, "-f", configuration, ...args], {
  encoding: "utf8", timeout: 60_000, maxBuffer: 1024 * 1024,
});
try {
  writeFileSync(path.join(directory, "email-auth.env"), `AI_PROJECT_OS_EMAIL_AUTH_ENABLED=true\nAI_PROJECT_OS_ALIYUN_DM_ACCESS_KEY_SECRET=${secret}\n`, { mode: 0o600 });
  writeFileSync(configuration, JSON.stringify({ services: { fixture: {
    image, pull_policy: "never", network_mode: "none", read_only: true,
    entrypoint: ["/bin/sh", "-c"],
    command: ["printf '%s' \"$$AI_PROJECT_OS_ALIYUN_DM_ACCESS_KEY_SECRET\""],
    env_file: [{ path: "./email-auth.env", required: false, format: "raw" }],
  } } }), { mode: 0o600 });
  const configured = compose("config", "--quiet");
  assert.equal(configured.status, 0, configured.stderr);
  const result = compose("run", "--rm", "--no-deps", "fixture");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, secret, "Compose raw env did not preserve synthetic credential bytes");
  const reset = path.join(directory, "reset.yaml");
  writeFileSync(reset, 'services:\n  fixture:\n    env_file: !reset []\n    environment:\n      AI_PROJECT_OS_EMAIL_AUTH_ENABLED: "false"\n', { mode: 0o600 });
  const isolated = compose("--file", reset, "config", "--format", "json");
  assert.equal(isolated.status, 0, isolated.stderr);
  const environment = JSON.parse(isolated.stdout).services.fixture.environment;
  assert.equal(environment.AI_PROJECT_OS_EMAIL_AUTH_ENABLED, "false");
  assert.equal(environment.AI_PROJECT_OS_ALIYUN_DM_ACCESS_KEY_SECRET, undefined);
  const isolatedRun = compose("--file", reset, "run", "--rm", "--no-deps", "fixture");
  assert.equal(isolatedRun.status, 0, isolatedRun.stderr);
  assert.equal(isolatedRun.stdout, "", "Isolated candidate inherited an env-file credential");
  console.log("EMAIL_AUTH_COMPOSE_RAW_ROUNDTRIP_OK");
  console.log("EMAIL_AUTH_COMPOSE_CANDIDATE_ISOLATION_OK");
} finally {
  const cleanup = compose("down", "--remove-orphans");
  rmSync(directory, { recursive: true, force: true });
  if (cleanup.status !== 0) {
    console.error(`EMAIL_AUTH_COMPOSE_FIXTURE_CLEANUP_FAILED project=${project}`);
    process.exitCode = 1;
  }
}
