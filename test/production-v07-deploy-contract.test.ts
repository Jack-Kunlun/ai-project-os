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
const backupPath = path.join(root, "deploy/production/ai-project-os-backup");
const restorePath = path.join(root, "deploy/production/ai-project-os-restore");
const backupArtifactPath = path.join(root, "deploy/production/ai_project_os_backup_artifact.py");

test("v0.7.3 backup target and artifact are accepted across cutover and recovery gates", async () => {
  const [backup, restore, installer] = await Promise.all([
    readFile(backupPath, "utf8"),
    readFile(restorePath, "utf8"),
    readFile(installerPath, "utf8"),
  ]);
  const backupName = "20261003T040000Z-pre-deploy-to-v0.7.3.Abc123";
  const oldBackupName = backupName.replace("v0.7.3", "v0.7.1");
  const checks = [
    [backup.split("\n").find((line) => line.includes("BACKUP_TARGET_TAG_INVALID")), "TARGET_TAG", "v0.7.3", "v0.7.1"],
    [backup.split("\n").find((line) => line.includes('[[ -z "$PUBLIC_BACKUP_NAME"')), "PUBLIC_BACKUP_NAME", backupName, oldBackupName],
    ...backup.split("\n").filter((line) => line.includes('[[ "$name" =~') && line.includes("pre-deploy-to-v0\\.7\\.3"))
      .map((line) => [line, "name", backupName, oldBackupName]),
    [restore.split("\n").find((line) => line.includes("RESTORE_TAG_INVALID")), "RELEASE_TAG", "v0.7.3", "v0.7.1"],
  ] as const;
  assert.equal(checks.length, 5);
  for (const [line, variable, accepted, rejected] of checks) {
    const condition = line?.match(/(\[\[.*\]\]) \|\|/u)?.[1];
    assert.ok(condition, `${variable} gate missing`);
    for (const [value, expectedStatus] of [[accepted, 0], [rejected, 1]] as const) {
      const gateRun: { status: number | null; stderr: string } = spawnSync("bash", ["-c", condition], {
        encoding: "utf8",
        env: { ...process.env, [variable]: value },
      });
      assert.equal(gateRun.status, expectedStatus, `${variable}=${value}: ${gateRun.stderr}`);
    }
  }
  const releaseGate = restore.split("\n").find((line) => line.includes("RESTORE_TAG_INVALID"))?.match(/(\[\[.*\]\]) \|\|/u)?.[1];
  assert.ok(releaseGate);
  const sourceRelease = spawnSync("bash", ["-c", releaseGate], {
    encoding: "utf8",
    env: { ...process.env, RELEASE_TAG: "v0.6.0-dev.14" },
  });
  assert.equal(sourceRelease.status, 0, sourceRelease.stderr);

  const manifestConditionStart = restore.indexOf('if [[ ! "$MANIFEST_OBJECT" =~');
  const manifestConditionEnd = restore.indexOf("\n  fail 'RESTORE_MANIFEST_OBJECT_INVALID'", manifestConditionStart);
  assert.ok(manifestConditionStart > 0 && manifestConditionEnd > manifestConditionStart);
  const manifestCondition = restore.slice(manifestConditionStart, manifestConditionEnd);
  for (const [name, expectedStatus] of [[backupName, 0], [oldBackupName, 1]] as const) {
    const manifest = `cos://ai-project-os-backup-1306016679/production/backups/2026/10/03/${name}/${name}.manifest.json`;
    const result = spawnSync("bash", ["-c", `MANIFEST_OBJECT=$1\n${manifestCondition}\n  exit 1\nfi\nexit 0`, "test", manifest], { encoding: "utf8" });
    assert.equal(result.status, expectedStatus, `manifest ${name}: ${result.stderr}`);
  }
  const releaseValidationStart = restore.indexOf("validate_backup_release() {");
  const releaseValidationEnd = restore.indexOf("\n}\n", releaseValidationStart);
  assert.ok(releaseValidationStart > 0 && releaseValidationEnd > releaseValidationStart);
  const releaseValidation = restore.slice(releaseValidationStart, releaseValidationEnd + 2);
  for (const [manifestVersion, expectedStatus] of [["0.6.0-dev.14", 0], ["0.7.3", 68]] as const) {
    const recovery = spawnSync("bash", ["-c", [
      "fail() { printf '%s\\n' \"$1\" >&2; exit \"$2\"; }",
      "RESTORE_MODE=recovery",
      "RELEASE_TAG=v0.6.0-dev.14",
      releaseValidation,
      'validate_backup_release "$1"',
    ].join("\n"), "test", manifestVersion], { encoding: "utf8" });
    assert.equal(recovery.status, expectedStatus, `source recovery ${manifestVersion}: ${recovery.stderr}`);
  }

  const helper = spawnSync("python3", ["-c", [
    "import runpy, sys",
    "pattern = runpy.run_path(sys.argv[1])['BACKUP_NAME']",
    "print(' '.join('yes' if pattern.fullmatch(name) else 'no' for name in sys.argv[2:]))",
  ].join("\n"), backupArtifactPath, backupName, oldBackupName], { encoding: "utf8" });
  assert.equal(helper.status, 0, helper.stderr);
  assert.equal(helper.stdout, "yes no\n");
  assert.match(installer, /RELEASE_TOOLING_BACKUP_CONTRACT_INVALID/u);
  assert.match(installer, /RELEASE_TOOLING_RESTORE_CONTRACT_INVALID/u);
  assert.match(installer, /RELEASE_TOOLING_BACKUP_ARTIFACT_CONTRACT_INVALID/u);
});

test("v07 deployer retains the release identity and irreversible migration boundaries", async () => {
  const deployer = await readFile(deployerPath, "utf8");
  const syntax = spawnSync("bash", ["-n", deployerPath], { encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
  assert.match(deployer, /\[\[ \$EUID -ne 0 \]\]/u);
  assert.match(deployer, /SOURCE_TAG" =~ \^v0\\\.6\\\.0-dev/u);
  assert.match(deployer, /"\$RELEASE_TAG" != v0\.7\.3/u);
  assert.match(deployer, /CONFIRM_V07_MIGRATION_V1/u);
  assert.match(deployer, /cat-file -t "refs\/tags\/\$SOURCE_TAG"/u);
  assert.match(deployer, /merge-base --is-ancestor/u);
  assert.match(deployer, /require_release_ci_evidence "\$resolved_source_revision" "\$SOURCE_TAG"/u);
  assert.match(deployer, /require_release_ci_evidence "\$EXPECTED_REVISION" "\$RELEASE_TAG"/u);
  assert.match(deployer, /local expected_count=117/u);
  assert.match(deployer, /expected_count=135/u);
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
  assert.match(workflow, /expected_status=\$\(printf 'TOOLING_V07_READY\\ntag=%s revision=%s' "\$V07_TARGET_TAG" "\$V07_TARGET_SHA"\)/u);
  assert.match(workflow, /\[\[ "\$output" == "\$expected_status" \]\]/u);
  assert.doesNotMatch(workflow, /bridge_tag|V07_BRIDGE|tooling-bridge-status/u);
  assert.match(workflow, /install-release-tooling \$V07_TARGET_TAG \$V07_TARGET_SHA/u);
  assert.match(workflow, /deploy-v07 \$V07_SOURCE_TAG \$V07_TARGET_TAG \$V07_SOURCE_SHA \$V07_TARGET_SHA CONFIRM_V07_MIGRATION_V1/u);
  assert.match(workflow, /V07_FULL_DATABASE_CI_REQUIRED/u);
  assert.match(workflow, /V07_FULL_TAG_DATABASE_CI_REQUIRED/u);
  assert.match(workflow, /\[\[ "\$target_tag" == v0\.7\.3 \]\]/u);
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
  const target = "v0.7.3";
  const sourceSha = "a".repeat(40);
  const targetSha = "b".repeat(40);
  const command = `deploy-v07 ${source} ${target} ${sourceSha} ${targetSha} CONFIRM_V07_MIGRATION_V1`;
  for (const rejected of [
    "tooling-bridge-status",
    `install-release-tooling v0.6.0-dev.15 ${targetSha} CONFIRM_INSTALL_RELEASE_TOOLING_V1`,
    `install-release-tooling v0.7.0-dev.1 ${targetSha} CONFIRM_INSTALL_RELEASE_TOOLING_V1`,
    `install-release-tooling v0.7.0 ${targetSha} CONFIRM_INSTALL_RELEASE_TOOLING_V1`,
    command.replace(target, "v0.7.0-dev.1"),
    command.replace(target, "v0.7.0"),
    command.replace(target, "v0.7.3-dev.1"),
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
