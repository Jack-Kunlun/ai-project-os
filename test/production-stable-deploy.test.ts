import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("only CI and the manual stable release remain executable workflows", () => {
  const workflows = readdirSync(".github/workflows")
    .filter((name) => /\.ya?ml$/u.test(name))
    .sort();
  assert.deepEqual(workflows, ["ci.yml", "release-stable.yml"]);
  const release = readFileSync(".github/workflows/release-stable.yml", "utf8");
  assert.match(release, /^on:\n  workflow_dispatch:\s*\n\npermissions:/mu);
});

test("stable deploy gate preserves its recovery boundary", () => {
  const result = spawnSync("python3", ["-B", "test/production-stable-deploy.py"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(output, /Ran \d+ tests/u);
  assert.match(output, /OK/u);
});

test("forced gateway exposes fixed stable status, refresh and deploy protocols", () => {
  const gatewayPath = "deploy/production/ai-project-os-actions-gateway";
  const gateway = readFileSync(gatewayPath, "utf8");
  const sudoers = readFileSync("deploy/production/ai-project-os-deploy.sudoers", "utf8");
  const syntax = spawnSync("bash", ["-n", gatewayPath], { encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
  assert.match(gateway, /original_command.*== stable-tooling-status/u);
  assert.match(gateway, /sudo -n \/usr\/local\/sbin\/ai-project-os-release-stable --status/u);
  assert.ok(gateway.includes("^deploy-stable\\ (v[1-9][0-9]*\\."));
  assert.ok(gateway.includes("([0-9a-f]{40})\\ (CONFIRM_STABLE_CI_IMAGES)$"));
  assert.match(gateway, /sudo -n \/usr\/local\/sbin\/ai-project-os-release-stable/u);
  assert.match(sudoers, /^ai-project-os-actions ALL=\(root\) NOPASSWD: \/usr\/local\/sbin\/ai-project-os-release-stable$/mu);

  const sha = "a".repeat(40);
  for (const command of [
    `deploy-stable v1.0.3 ${"a".repeat(39)} CONFIRM_STABLE_CI_IMAGES`,
    `deploy-stable v1.0.3 ${sha} CONFIRM_STABLE_CI_IMAGES; id`,
    `deploy-stable v1.0.3 ${sha} CONFIRM_STABLE_CI_IMAGES extra`,
    `deploy-stable v1.0.3 ${sha} CONFIRM_STABLE_WITHOUT_BACKUP`,
    `deploy-stable v1.0.3.0 ${sha} CONFIRM_STABLE_CI_IMAGES`,
  ]) {
    const result = spawnSync("bash", [gatewayPath], {
      encoding: "utf8",
      env: { ...process.env, SSH_ORIGINAL_COMMAND: command },
    });
    assert.equal(result.status, 64, `${command}\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /AI_PROJECT_OS_DEPLOY_COMMAND_DENIED/u);
  }
});
