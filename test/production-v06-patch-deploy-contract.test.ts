import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const patchDeployPath = path.join(root, "deploy/production/ai-project-os-v06-patch-deploy");
const gatewayPath = path.join(root, "deploy/production/ai-project-os-actions-gateway");
const preflightPath = path.join(root, "scripts/production-v06-patch-upgrade-preflight.ts");
const backupPath = path.join(root, "deploy/production/ai-project-os-backup");
const restorePath = path.join(root, "deploy/production/ai-project-os-restore");

/** Read the patch release contract from one repository snapshot. */
async function readContracts() {
  const [patchDeploy, gateway, preflight, backup, restore] = await Promise.all([
    readFile(patchDeployPath, "utf8"),
    readFile(gatewayPath, "utf8"),
    readFile(preflightPath, "utf8"),
    readFile(backupPath, "utf8"),
    readFile(restorePath, "utf8"),
  ]);
  return { patchDeploy, gateway, preflight, backup, restore };
}

test(".6 to .7 gateway accepts only the exact patch command", async () => {
  const { gateway } = await readContracts();
  assert.match(
    gateway,
    /\^deploy-v06-patch\\ \(v0\\\.6\\\.0-dev\\\.6\)\\ \(v0\\\.6\\\.0-dev\\\.7\)\\ \(\[0-9a-f\]\{40\}\)\\ \(\[0-9a-f\]\{40\}\)\\ \(CONFIRM_V06_PATCH_V1\)\$/u,
  );
  assert.match(gateway, /\/usr\/local\/sbin\/ai-project-os-v06-patch-deploy/u);

  for (const command of [
    `deploy-v06-patch v0.6.0-dev.5 v0.6.0-dev.7 ${"a".repeat(40)} ${"b".repeat(40)} CONFIRM_V06_PATCH_V1`,
    `deploy-v06-patch v0.6.0-dev.6 v0.6.0-dev.6 ${"a".repeat(40)} ${"b".repeat(40)} CONFIRM_V06_PATCH_V1`,
    `deploy-v06-patch v0.6.0-dev.6 v0.6.0-dev.7 ${"a".repeat(40)} CONFIRM_V06_PATCH_V1`,
    `deploy-v06-patch v0.6.0-dev.6 v0.6.0-dev.7 ${"a".repeat(40)} ${"b".repeat(40)} CONFIRM_V06_PATCH_V1; id`,
  ]) {
    const result = spawnSync("bash", [gatewayPath], {
      encoding: "utf8",
      env: { ...process.env, SSH_ORIGINAL_COMMAND: command },
    });
    assert.equal(result.status, 64, command);
    assert.match(result.stderr, /AI_PROJECT_OS_DEPLOY_COMMAND_DENIED/u);
  }
});

test("patch deploy is no-migration, stopped-writer, backup-first and health-gated", async () => {
  const { patchDeploy } = await readContracts();
  const recoveryStart = patchDeploy.indexOf("recover_source_writers_on_failure()");
  const recoveryEnd = patchDeploy.indexOf("# Capture the source container", recoveryStart);
  assert.ok(recoveryStart >= 0 && recoveryEnd > recoveryStart);
  const recoveryContract = patchDeploy.slice(recoveryStart, recoveryEnd);
  assert.equal(spawnSync("bash", ["-n", patchDeployPath], { encoding: "utf8" }).status, 0);
  assert.match(patchDeploy, /SOURCE_TAG.*v0\.6\.0-dev\.6/u);
  assert.match(patchDeploy, /RELEASE_TAG.*v0\.6\.0-dev\.7/u);
  assert.match(patchDeploy, /EXPECTED_SOURCE_REVISION=\$\{3-\}/u);
  assert.match(
    patchDeploy,
    /\[\[ "\$source_revision" == "\$EXPECTED_SOURCE_REVISION" \]\] \|\| fail PATCH_DEPLOY_SOURCE_TAG_REVISION_MISMATCH/u,
  );
  assert.match(patchDeploy, /CONFIRM_V06_PATCH_V1/u);
  assert.match(patchDeploy, /prisma\/migrations/u);
  assert.match(patchDeploy, /prisma\/schema\.prisma/u);
  assert.match(patchDeploy, /prisma\.config\.ts/u);
  assert.match(patchDeploy, /PATCH_DEPLOY_DATABASE_FILES_CHANGED/u);
  assert.match(patchDeploy, /production-v06-patch-upgrade-preflight\.ts/u);
  assert.match(patchDeploy, /PATCH_DEPLOY_PREFLIGHT_MIGRATION_COUNT_INVALID/u);
  assert.match(patchDeploy, /AI_PROJECT_OS_CUTOVER=1/u);
  assert.match(patchDeploy, /BACKUP_OK .* source_quiesced=true/u);
  assert.match(patchDeploy, /PATCH_DEPLOY_BACKUP_OBJECT_INVALID/u);
  assert.match(patchDeploy, /PATCH_DEPLOY_SOURCE_IMAGE_REF_INVALID/u);
  assert.match(patchDeploy, /backup_object_dir=\$\{backup_object%\/\*\}/u);
  assert.match(patchDeploy, /backup_manifest.*==.*backup_object_dir.*backup_name\.manifest\.json/u);
  assert.match(patchDeploy, /migration=not-performed/u);
  assert.match(patchDeploy, /compose up -d --no-deps --no-build --force-recreate app worker/u);
  assert.ok((patchDeploy.match(/run_patch_preflight post-cutover/g) ?? []).length >= 2);
  assert.match(patchDeploy, /PATCH_DEPLOY_RECOVERY_REQUIRED/u);
  assert.match(patchDeploy, /PATCH_DEPLOY_EMERGENCY/u);
  assert.match(recoveryContract, /OLD_APP_IMAGE_ID.*\^sha256:\[0-9a-f\]\{64\}\$/u);
  assert.match(recoveryContract, /OLD_APP_ID=\$\(compose ps -q app\)/u);
  assert.doesNotMatch(patchDeploy, /compose\s+up[^\n]*\bmigrate\b/u);
  assert.doesNotMatch(patchDeploy, /compose\s+down|docker\s+(?:volume|system|image)\s+prune/u);
});

test("patch preflight pins the unchanged 107 ledger and target catalog", async () => {
  const { preflight } = await readContracts();
  assert.match(preflight, /TARGET_TAG = "v0\.6\.0-dev\.7"/u);
  assert.match(preflight, /EXPECTED_MIGRATION_COUNT = 107/u);
  assert.match(preflight, /20260921010000_add_personal_knowledge_domain/u);
  assert.match(preflight, /migrationChange: "none"/u);
  assert.match(preflight, /_prisma_migrations/u);
  assert.match(preflight, /PersonalKnowledgeDocument/u);
  assert.match(preflight, /V06_PATCH_PREFLIGHT_TARGET_CATALOG_INVALID/u);
  assert.match(preflight, /V06_PATCH_PREFLIGHT_WRITER_SESSIONS_PRESENT/u);
  assert.match(preflight, /post-cutover/u);
});

test("backup and restore allowlists retain .7 and add .8 stopped-writer artifacts", async () => {
  const { backup, restore } = await readContracts();
  assert.ok(backup.includes("pre-deploy-to-v0\\.6\\.0-dev\\.6"));
  assert.ok(backup.includes("pre-deploy-to-v0\\.6\\.0-dev\\.(7|8)"));
  assert.ok(restore.includes("v0\\.6\\.0-dev\\.(6|7|8)"));
  assert.ok(restore.includes("pre-deploy-to-v0\\.6\\.0-dev\\.7"));
  assert.ok(restore.includes("pre-deploy-to-v0\\.6\\.0-dev\\.8"));
});
