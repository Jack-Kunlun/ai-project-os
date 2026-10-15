import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

test("bounded release path preserves source before cutover and enforces migration/rollback boundaries", () => {
  const result = spawnSync("python3", ["-B", "test/production-release-v1.py"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Ran 10 tests/u);
});

test("release workflow shell blocks are valid and secrets remain in the protected stdin handoff", () => {
  const text = readFileSync("test/fixtures/legacy-workflows/deploy-v1.yml", "utf8");
  assert.match(text, /environment:\n      name: production/u);
  assert.match(text, /group: ai-project-os-production/u);
  assert.match(text, /full main and tag CI/u);
  assert.match(text, /Verify database and release candidate/u);
  assert.match(text, /CONFIRM_V1_WITHOUT_BACKUP_OR_LEGACY_ACCEPTANCE/u);
  for (const block of text.split("        run: |\n").slice(1)) {
    const lines = block.split("\n");
    const shell = lines.slice(0, lines.findIndex((line) => line.length > 0 && !line.startsWith("          "))).map((line) => line.replace(/^          /u, "")).join("\n");
    const result = spawnSync("bash", ["-n"], { input: shell, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  assert.doesNotMatch(text, /set -x|StrictHostKeyChecking=no|configure-email-auth.*\$DM_/u);
});

test("forced command rejects skipped transition, command injection and arbitrary tags", () => {
  const hash = "a".repeat(40);
  for (const command of [
    `deploy-v1 v0.8.0-dev.3 v1.0.0 ${hash} ${hash} CONFIRM_V1_WITHOUT_BACKUP_OR_LEGACY_ACCEPTANCE`,
    `deploy-v1 v1.0.0 v1.0.1 ${hash} ${hash} CONFIRM_V1_WITHOUT_BACKUP_OR_LEGACY_ACCEPTANCE`,
    "v1-tooling-status extra", "v1-tooling-status; id", "v1-tooling-status\n", "bootstrap v0.8.0-dev.4",
  ]) {
    const result = spawnSync("bash", ["deploy/production/ai-project-os-actions-gateway"], {
      encoding: "utf8", env: { PATH: process.env.PATH, NODE_ENV: "test", SSH_ORIGINAL_COMMAND: command },
    });
    assert.equal(result.status, 64, command);
    assert.match(result.stderr, /AI_PROJECT_OS_DEPLOY_COMMAND_DENIED/u);
  }
});
