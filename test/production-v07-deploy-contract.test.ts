import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const deployerPath = path.join(root, "deploy/production/ai-project-os-v07-deploy");
const secretHelperPath = path.join(root, "deploy/production/ai-project-os-prepare-git-automation-secret");
const gatewayPath = path.join(root, "deploy/production/ai-project-os-actions-gateway");
const installerPath = path.join(root, "deploy/production/ai-project-os-install-release-tooling");
const sudoersPath = path.join(root, "deploy/production/ai-project-os-deploy.sudoers");
const workflowPath = path.join(root, ".github/workflows/deploy-v07.yml");

test("v07 deployer retains the release identity and irreversible migration boundaries", async () => {
  const deployer = await readFile(deployerPath, "utf8");
  const syntax = spawnSync("bash", ["-n", deployerPath], { encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
  assert.match(deployer, /\[\[ \$EUID -ne 0 \]\]/u);
  assert.match(deployer, /SOURCE_TAG" =~ \^v0\\\.6\\\.0-dev/u);
  assert.match(deployer, /"\$RELEASE_TAG" != v0\.7\.0/u);
  assert.match(deployer, /CONFIRM_V07_MIGRATION_V1/u);
  assert.match(deployer, /cat-file -t "refs\/tags\/\$SOURCE_TAG"/u);
  assert.match(deployer, /merge-base --is-ancestor/u);
  assert.match(deployer, /require_release_ci_evidence "\$resolved_source_revision" "\$SOURCE_TAG"/u);
  assert.match(deployer, /require_release_ci_evidence "\$EXPECTED_REVISION" "\$RELEASE_TAG"/u);
  assert.match(deployer, /local expected_count=117/u);
  assert.match(deployer, /expected_count=133/u);
  assert.match(deployer, /for feature_flag in LOCAL_REGISTRATION_ENABLED AI_PROJECT_OS_MCP_ACTIONS_ENABLED AI_PROJECT_OS_MCP_EXPORT_ENABLED AI_PROJECT_OS_MCP_EXPORT_OAUTH_ENABLED/u);
  assert.match(deployer, /DEPLOY_MCP_EXPORT_OAUTH_REQUIRES_EXPORT/u);
  assert.match(deployer, /validate_exact_env_value AI_PROJECT_OS_MCP_EXPORT_PUBLIC_ORIGIN https:\/\/ai-project-os\.com/u);
  assert.match(deployer, /\(\( \$\{#matches\[@\]\} == 1 \)\)/u);
  assert.match(deployer, /scripts\/production-v07-upgrade-preflight\.ts "\$phase" "\$RELEASE_TAG"/u);
  assert.match(deployer, /run_upgrade_preflight post-stop/u);
  assert.match(deployer, /run_upgrade_preflight post-migration/u);
  assert.match(deployer, /MUTATION_ATTEMPTED=1/u);
  assert.ok(deployer.indexOf("run_upgrade_preflight post-stop") < deployer.indexOf('"$BACKUP_SCRIPT" pre-deploy'));
  assert.ok(deployer.indexOf('"$BACKUP_SCRIPT" pre-deploy') < deployer.indexOf("MUTATION_ATTEMPTED=1"));
  assert.ok(deployer.indexOf("MUTATION_ATTEMPTED=1") < deployer.indexOf("compose up -d --no-build --force-recreate principal-bootstrap migrate reconcile"));
  assert.doesNotMatch(deployer, /\beval\s|bash -c|sh -c/u);
});

test("v07 deployer seals the Git password before backup and gates all three writers", async () => {
  const [deployer, helper] = await Promise.all([readFile(deployerPath, "utf8"), readFile(secretHelperPath, "utf8")]);
  assert.match(deployer, /GIT_AUTOMATION_SECRET_HELPER=\/usr\/local\/sbin\/ai-project-os-prepare-git-automation-secret/u);
  assert.match(deployer, /source "\$GIT_AUTOMATION_SECRET_HELPER"/u);
  assert.match(deployer, /prepare_worker_password "\$ENV_FILE" 0 0/u);
  assert.match(deployer, /V07_HOST_CONTROL_FILE_UNTRUSTED/u);
  assert.match(deployer, /"\$RELEASE_TOOLING_SCRIPT" --status >\/dev\/null/u);
  assert.match(deployer, /V07_TOOLING_STATUS_INVALID/u);
  assert.match(deployer, /grep -Fqx "tag=\$RELEASE_TAG revision=\$EXPECTED_REVISION" "\$RELEASE_TOOLING_STATE"/u);
  assert.ok(deployer.indexOf('"$RELEASE_TOOLING_SCRIPT" --status') < deployer.indexOf('"$BACKUP_SCRIPT" pre-deploy'));
  assert.match(deployer, /os\.lstat\(current\)/u);
  assert.match(deployer, /mode & 0o022/u);
  assert.ok(deployer.indexOf('V07_HOST_CONTROL_FILE_UNTRUSTED') < deployer.indexOf('source "$GIT_AUTOMATION_SECRET_HELPER"'));
  assert.ok(deployer.indexOf('prepare_worker_password "$ENV_FILE" 0 0') < deployer.indexOf("compose config --quiet"));
  assert.ok(deployer.indexOf('prepare_worker_password "$ENV_FILE" 0 0') < deployer.indexOf('"$BACKUP_SCRIPT" pre-deploy'));
  assert.match(helper, /GIT_AUTOMATION_SECRET_READY/u);
  assert.match(deployer, /V07_SOURCE_GIT_WORKER_UNEXPECTED/u);
  assert.match(deployer, /AI_PROJECT_OS_CUTOVER=1/u);
  assert.match(deployer, /AI_PROJECT_OS_EXPECTED_APP_ID="\$OLD_APP_ID"/u);
  assert.match(deployer, /AI_PROJECT_OS_EXPECTED_WORKER_ID="\$OLD_WORKER_ID"/u);
  assert.match(deployer, /compose build principal-bootstrap migrate reconcile app worker git-worker production-upgrade-preflight/u);
  assert.match(deployer, /compose up -d --no-deps --no-build --force-recreate app worker git-worker/u);
  assert.match(deployer, /git_worker_state" == healthy/u);
  assert.match(deployer, /com\.docker\.compose\.service=git-worker/u);
  assert.match(deployer, /remaining_git_worker_ids/u);
  assert.match(deployer, /NEW_WRITERS_CONFIRMED_HEALTHY=1/u);
});

test("v07 production entry uses a dedicated exact command and migration workflow", async () => {
  const [gateway, installer, sudoers, workflow] = await Promise.all([
    readFile(gatewayPath, "utf8"),
    readFile(installerPath, "utf8"),
    readFile(sudoersPath, "utf8"),
    readFile(workflowPath, "utf8"),
  ]);
  const syntax = spawnSync("bash", ["-n", gatewayPath], { encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
  const installerSyntax = spawnSync("bash", ["-n", installerPath], { encoding: "utf8" });
  assert.equal(installerSyntax.status, 0, installerSyntax.stderr);
  assert.match(gateway, /deploy-v07\\ \(v0\\\.6\\\.0-dev/u);
  assert.match(gateway, /tooling-v07-status/u);
  assert.match(gateway, /exec sudo -n \/usr\/local\/sbin\/ai-project-os-install-release-tooling --status/u);
  assert.doesNotMatch(gateway, /tooling-bridge-status/u);
  assert.match(gateway, /CONFIRM_V07_MIGRATION_V1/u);
  assert.match(gateway, /exec sudo -n \/usr\/local\/sbin\/ai-project-os-v07-deploy/u);
  assert.match(sudoers, /^ai-project-os-actions ALL=\(root\) NOPASSWD: \/usr\/local\/sbin\/ai-project-os-v07-deploy$/mu);
  assert.match(installer, /ARCHIVE_PATHS\+=\(/u);
  assert.match(installer, /deploy\/production\/ai-project-os-v07-deploy/u);
  assert.match(installer, /deploy\/production\/ai-project-os-prepare-git-automation-secret/u);
  assert.match(installer, /scripts\/production-v07-upgrade-preflight\.ts/u);
  assert.match(installer, /stage_install "\$V07_DEPLOYER"/u);
  assert.match(installer, /stage_install "\$GIT_AUTOMATION_SECRET_PREPARER"/u);
  assert.match(installer, /"O_NOFOLLOW"/u);
  assert.match(installer, /exec 9>>"\$LOCK_FILE"/u);
  assert.match(installer, /V07_STATE_FILE=\/etc\/ai-project-os\/release-tooling-v07-state/u);
  assert.match(installer, /cmp -s <\(tail -n \+2 "\$V07_STATE_FILE"\) <\(sha256sum "\$\{V07_STATUS_FILES\[@\]\}"\)/u);
  assert.match(workflow, /tooling-v07-status/u);
  assert.match(workflow, /V07_TOOLING_NOT_BOOTSTRAPPED/u);
  assert.doesNotMatch(workflow, /bridge_tag|V07_BRIDGE|tooling-bridge-status/u);
  assert.match(workflow, /install-release-tooling \$V07_TARGET_TAG \$V07_TARGET_SHA/u);
  assert.match(workflow, /deploy-v07 \$V07_SOURCE_TAG \$V07_TARGET_TAG \$V07_SOURCE_SHA \$V07_TARGET_SHA CONFIRM_V07_MIGRATION_V1/u);
  assert.match(workflow, /V07_FULL_DATABASE_CI_REQUIRED/u);
  assert.match(workflow, /\[\[ "\$target_tag" == v0\.7\.0 \]\]/u);
  assert.doesNotMatch(workflow, /target_tag" =~ \^v0/u);
  assert.doesNotMatch(workflow, /deploy-app \$V07_SOURCE_TAG/u);
});

test("v07 forced-command gateway rejects nearby tags and shell suffixes", () => {
  const ready = spawnSync("bash", [gatewayPath], {
    encoding: "utf8",
    env: { ...process.env, SSH_ORIGINAL_COMMAND: "tooling-v07-status" },
  });
  assert.notEqual(ready.status, 0);
  assert.notEqual(ready.stdout.trim(), "TOOLING_V07_READY");
  const source = "v0.6.0-dev.14";
  const target = "v0.7.0";
  const sourceSha = "a".repeat(40);
  const targetSha = "b".repeat(40);
  const command = `deploy-v07 ${source} ${target} ${sourceSha} ${targetSha} CONFIRM_V07_MIGRATION_V1`;
  for (const rejected of [
    "tooling-bridge-status",
    `install-release-tooling v0.6.0-dev.15 ${targetSha} CONFIRM_INSTALL_RELEASE_TOOLING_V1`,
    `install-release-tooling v0.7.0-dev.1 ${targetSha} CONFIRM_INSTALL_RELEASE_TOOLING_V1`,
    command.replace(target, "v0.7.0-dev.1"),
    command.replace(target, "v0.7.1-dev.1"),
    command.replace(source, "v0.6.0-dev.9"),
    command.replace(targetSha, `${targetSha};id`),
    `${command} extra`,
  ]) {
    const result = spawnSync("bash", [gatewayPath], {
      encoding: "utf8",
      env: { ...process.env, SSH_ORIGINAL_COMMAND: rejected },
    });
    assert.equal(result.status, 64, rejected);
    assert.match(result.stderr, /AI_PROJECT_OS_DEPLOY_COMMAND_DENIED/u);
  }
});

test("v07 deployer rejects duplicate or divergent MCP OAuth public origins", async () => {
  const deployer = await readFile(deployerPath, "utf8");
  const helper = deployer.match(/validate_exact_env_value\(\) \{[\s\S]*?\n\}/u)?.[0];
  assert.ok(helper, "exact environment validator must be present");
  const directory = await mkdtemp(path.join(tmpdir(), "v07-origin-guard-"));
  const envPath = path.join(directory, "production.env");
  const check = async (values: readonly string[]) => {
    await writeFile(envPath, `${values.map((value) => `AI_PROJECT_OS_MCP_EXPORT_PUBLIC_ORIGIN=${value}`).join("\n")}\n`);
    return spawnSync("bash", ["-c", `ENV_FILE=$1\n${helper}\nvalidate_exact_env_value AI_PROJECT_OS_MCP_EXPORT_PUBLIC_ORIGIN https://ai-project-os.com`, "bash", envPath], { encoding: "utf8" });
  };
  try {
    const valid = await check(["https://ai-project-os.com"]);
    assert.equal(valid.status, 0, valid.stderr);
    assert.notEqual((await check(["https://ai-project-os.com", "https://other.example"])).status, 0);
    assert.notEqual((await check(["https://other.example", "https://ai-project-os.com"])).status, 0);
    assert.notEqual((await check(["https://other.example"])).status, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
