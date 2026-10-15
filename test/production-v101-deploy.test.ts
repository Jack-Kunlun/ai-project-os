import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("fixed v1.0.0 to v1.0.1 deploy gate preserves its recovery boundary", () => {
  const result = spawnSync("python3", ["-B", "test/production-v101-deploy.py"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(output, /Ran \d+ tests/u);
  assert.match(output, /OK/u);
});

test("forced gateway exposes only fixed v1.0.1 status and deploy syntax", () => {
  const gatewayPath = "deploy/production/ai-project-os-actions-gateway";
  const gateway = readFileSync(gatewayPath, "utf8");
  const sudoers = readFileSync("deploy/production/ai-project-os-deploy.sudoers", "utf8");
  const syntax = spawnSync("bash", ["-n", gatewayPath], { encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
  assert.match(gateway, /original_command.*== v101-tooling-status/u);
  assert.match(gateway, /sudo -n \/usr\/local\/sbin\/ai-project-os-v101-deploy --status/u);
  assert.match(gateway, /\^deploy-v101\\ \(\[0-9a-f\]\{40\}\)\\ \(CONFIRM_V101_WITH_BACKUP_AND_FULL_CI\)\$/u);
  assert.match(gateway, /sudo -n \/usr\/local\/sbin\/ai-project-os-v101-deploy/u);
  assert.match(sudoers, /^ai-project-os-actions ALL=\(root\) NOPASSWD: \/usr\/local\/sbin\/ai-project-os-v101-deploy$/mu);

  const sha = "a".repeat(40);
  for (const command of [
    `deploy-v101 v1.0.1 ${sha} CONFIRM_V101_WITH_BACKUP_AND_FULL_CI`,
    `deploy-v101 ${sha} CONFIRM_V101_WITH_BACKUP_AND_FULL_CI; id`,
    `deploy-v101 ${sha} CONFIRM_V101_WITH_BACKUP_AND_FULL_CI extra`,
    `deploy-v101 ${"a".repeat(39)} CONFIRM_V101_WITH_BACKUP_AND_FULL_CI`,
  ]) {
    const result = spawnSync("bash", [gatewayPath], {
      encoding: "utf8",
      env: { ...process.env, SSH_ORIGINAL_COMMAND: command },
    });
    assert.equal(result.status, 64, `${command}\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /AI_PROJECT_OS_DEPLOY_COMMAND_DENIED/u);
  }
});

test("v1.0.1 workflow verifies full CI and tooling hashes before fixed deploy and health receipt", () => {
  const path = ".github/workflows/deploy-v101.yml";
  const workflow = readFileSync(path, "utf8");
  assert.match(workflow, /group: ai-project-os-production/u);
  assert.match(workflow, /name: production/u);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/u);
  assert.match(workflow, /f57d050fffa445a6ef9eb3d7e692e6df06fac98d/u);
  assert.match(workflow, /refs\/tags\/\$target_tag\^\{\}/u);
  assert.match(workflow, /refs\/remotes\/origin\/main/u);
  assert.match(workflow, /Verify database and release candidate/u);
  assert.match(workflow, /v101-tooling-status/u);
  assert.match(workflow, /V101_TOOLING_READY/u);
  assert.match(workflow, /deploy-v101 \$DEPLOY_SHA CONFIRM_V101_WITH_BACKUP_AND_FULL_CI/u);
  assert.match(workflow, /migration_count=145/u);
  assert.match(workflow, /restore=143-to-145/u);
  assert.match(workflow, /https:\/\/ai-project-os\.com\/api\/health/u);
  assert.doesNotMatch(workflow, /set -x|StrictHostKeyChecking=no|scp |rsync |bash -c/u);

  for (const block of workflow.split("        run: |\n").slice(1)) {
    const lines = block.split("\n");
    const end = lines.findIndex((line) => line.length > 0 && !line.startsWith("          "));
    const shell = lines.slice(0, end < 0 ? undefined : end)
      .map((line) => line.replace(/^          /u, ""))
      .join("\n");
    const syntax = spawnSync("bash", ["-n"], { input: shell, encoding: "utf8" });
    assert.equal(syntax.status, 0, syntax.stderr);
  }
});
