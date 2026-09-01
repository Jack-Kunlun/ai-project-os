import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const repositoryRoot = process.cwd();
const workflowPath = path.join(repositoryRoot, ".github/workflows/deploy-production.yml");
const deploymentPath = path.join(repositoryRoot, "deploy/production/ai-project-os-deploy");
const gatewayPath = path.join(repositoryRoot, "deploy/production/ai-project-os-actions-gateway");
const installerPath = path.join(repositoryRoot, "deploy/production/install-production-deploy.sh");
const sudoersPath = path.join(repositoryRoot, "deploy/production/ai-project-os-deploy.sudoers");

test("production workflow is manual, serialized, least-privilege, and tag-CI-gated", async () => {
  const workflow = await readFile(workflowPath, "utf8");

  assert.match(workflow, /^\s{2}workflow_dispatch:/mu);
  assert.doesNotMatch(workflow, /^\s{2}(push|pull_request|schedule):/mu);
  assert.match(workflow, /contents: read/u);
  assert.match(workflow, /actions: read/u);
  assert.match(workflow, /cancel-in-progress: false/u);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/u);
  assert.match(workflow, /environment:[\s\S]*name: production/u);
  assert.match(workflow, /persist-credentials: false/u);
  assert.match(workflow, /DEPLOY_TAG_NOT_ANNOTATED/u);
  assert.match(workflow, /DEPLOY_TAG_SUCCESSFUL_CI_NOT_FOUND/u);
  assert.match(workflow, /\.head_branch == \$tag/u);
  assert.match(workflow, /PRODUCTION_SSH_PRIVATE_KEY/u);
  assert.match(workflow, /PRODUCTION_SSH_KNOWN_HOSTS/u);
  assert.match(workflow, /StrictHostKeyChecking=yes/u);
  assert.match(workflow, /ai-project-os-actions@38\.76\.205\.30/u);
  assert.match(workflow, /"deploy \$DEPLOY_TAG \$DEPLOY_SHA"/u);
  assert.match(workflow, /\.worker\.consecutiveFailures == 0/u);
  assert.doesNotMatch(workflow, /passwordauthentication|sshpass/iu);
});

test("production workflow is statically fail-closed before the first formal v1.0.0 release", async () => {
  const workflow = await readFile(workflowPath, "utf8");

  assert.match(workflow, /PRODUCTION_DEPLOYMENT_DISABLED_BEFORE_V1_0_0/u);
  assert.match(workflow, /if: \$\{\{ github\.ref == 'refs\/heads\/main' && false \}\}/u);
  assert.match(workflow, /\^v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$/u);
  assert.doesNotMatch(workflow, /0\.1\.0-dev\.1/u);
});

test("forced-command gateway accepts only a release tag and exact commit", async () => {
  const gateway = await readFile(gatewayPath, "utf8");

  assert.match(gateway, /SSH_ORIGINAL_COMMAND/u);
  assert.match(gateway, /\^deploy\\ \(v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\)\\ \(\[0-9a-f\]\{40\}\)\$/u);
  assert.match(gateway, /sudo -n \/usr\/local\/sbin\/ai-project-os-deploy/u);
  assert.match(gateway, /AI_PROJECT_OS_DEPLOY_COMMAND_DENIED/u);
});

test("root deployer verifies source, backs up state, migrates, and waits for health", async () => {
  const deployment = await readFile(deploymentPath, "utf8");

  assert.match(deployment, /REPOSITORY_URL=https:\/\/github\.com\/Jack-Kunlun\/ai-project-os\.git/u);
  assert.match(deployment, /DEPLOY_TAG_NOT_ANNOTATED/u);
  assert.match(deployment, /DEPLOY_TAG_REVISION_MISMATCH/u);
  assert.match(deployment, /DEPLOY_TAG_SUCCESSFUL_CI_NOT_FOUND/u);
  assert.match(deployment, /python3 -c/u);
  assert.match(deployment, /production\.env/u);
  assert.match(deployment, /AI_PROJECT_OS_SECURE_COOKIES=true/u);
  assert.match(deployment, /pg_dump/u);
  assert.match(deployment, /pg_restore --list/u);
  assert.match(deployment, /secrets\.tar\.gz/u);
  assert.match(deployment, /uploads\.tar\.gz/u);
  assert.match(deployment, /sha256sum/u);
  assert.match(deployment, /--force-recreate migrate app worker/u);
  assert.match(deployment, /consecutiveFailures/u);
  assert.match(deployment, /https:\/\/ai-project-os\.com\/api\/health/u);
  assert.doesNotMatch(deployment, /\bcompose down\b|down[^\n]*-v/u);
});

test("installer keeps secrets root-only and installs a restricted Actions key", async () => {
  const installer = await readFile(installerPath, "utf8");
  const sudoers = await readFile(sudoersPath, "utf8");

  assert.match(installer, /install -o root -g root -m 0600 "\$LEGACY_ENV" "\$PRODUCTION_ENV"/u);
  assert.match(installer, /restrict,command=/u);
  assert.match(installer, /TARGET_USER=ai-project-os-actions/u);
  assert.match(installer, /useradd/u);
  assert.match(installer, /ai-project-os-actions-gateway/u);
  assert.match(installer, /INSTALL_ACTIONS_AUTHORIZED_KEYS_NOT_EXCLUSIVE/u);
  assert.match(installer, /temporary_authorized_keys/u);
  assert.match(installer, /visudo -cf/u);
  assert.equal(sudoers.trim(), "ai-project-os-actions ALL=(root) NOPASSWD: /usr/local/sbin/ai-project-os-deploy");
});

test("production shell entrypoints pass bash syntax validation", () => {
  for (const scriptPath of [deploymentPath, gatewayPath, installerPath]) {
    const result = spawnSync("bash", ["-n", scriptPath], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
});
