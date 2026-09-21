import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const deployPath = path.join(root, "deploy/production/ai-project-os-v06-deploy");
const gatewayPath = path.join(root, "deploy/production/ai-project-os-actions-gateway");
const preflightPath = path.join(root, "scripts/production-v06-upgrade-preflight.ts");
const backupPath = path.join(root, "deploy/production/ai-project-os-backup");
const restorePath = path.join(root, "deploy/production/ai-project-os-restore");

/** Read the release files from a single workspace snapshot. */
async function readContracts() {
  const [deploy, gateway, preflight, backup, restore] = await Promise.all([
    readFile(deployPath, "utf8"),
    readFile(gatewayPath, "utf8"),
    readFile(preflightPath, "utf8"),
    readFile(backupPath, "utf8"),
    readFile(restorePath, "utf8"),
  ]);
  return { deploy, gateway, preflight, backup, restore };
}

test("0.6 gateway accepts one exact migration grammar and rejects injection", async () => {
  const { gateway } = await readContracts();
  assert.ok(gateway.includes("^deploy-v06\\ (v0\\.5\\.0-dev\\.(1|4))\\ (v0\\.6\\.0-dev\\.2)\\ ([0-9a-f]{40})\\ (CONFIRM_V06_MIGRATION_V1)$"));
  assert.match(gateway, /exec sudo -n \/usr\/local\/sbin\/ai-project-os-v06-deploy/u);

  for (const command of [
    `deploy-v06 v0.5.0-dev.2 v0.6.0-dev.2 ${"a".repeat(40)} CONFIRM_V06_MIGRATION_V1`,
    `deploy-v06 v0.5.0-dev.4 v0.6.0-dev.1 ${"a".repeat(40)} CONFIRM_V06_MIGRATION_V1`,
    `deploy-v06 v0.5.0-dev.4 v0.6.0-dev.2 ${"a".repeat(40)} CONFIRM_V06_MIGRATION_V1; id`,
  ]) {
    const result = spawnSync("bash", [gatewayPath], {
      encoding: "utf8",
      env: { ...process.env, SSH_ORIGINAL_COMMAND: command },
    });
    assert.equal(result.status, 64, command);
    assert.match(result.stderr, /AI_PROJECT_OS_DEPLOY_COMMAND_DENIED/u);
  }
});

test("0.6 deploy verifies source, stopped writers, backup, migration, and health", async () => {
  const { deploy } = await readContracts();
  assert.equal(spawnSync("bash", ["-n", deployPath], { encoding: "utf8" }).status, 0);
  assert.match(deploy, /SOURCE_TAG.*v0\.5\.0-dev\\?\.\(1\|4\)|v0\\\.5/u);
  assert.match(deploy, /RELEASE_TAG" != v0\.6\.0-dev\.2/u);
  assert.match(deploy, /CONFIRM_V06_MIGRATION_V1/u);
  assert.match(deploy, /scripts\/production-v06-upgrade-preflight\.ts/u);
  assert.match(deploy, /run_upgrade_preflight pre-stop/u);
  assert.match(deploy, /run_upgrade_preflight post-stop/u);
  assert.match(deploy, /AI_PROJECT_OS_CUTOVER=1/u);
  assert.match(deploy, /BACKUP_OK .* source_quiesced=true/u);
  assert.match(deploy, /MUTATION_ATTEMPTED=1/u);
  assert.match(deploy, /principal-bootstrap migrate reconcile app worker/u);
  assert.match(deploy, /run_upgrade_preflight post-migration/u);
  assert.match(deploy, /V06_DEPLOY_RECOVERY_REQUIRED/u);
  assert.match(deploy, /V06_DEPLOY_EMERGENCY/u);
  assert.match(deploy, /writers_may_be_running=true/u);
  assert.match(deploy, /quiesce_current_writers_after_failure/u);
  assert.match(deploy, /docker ps --no-trunc -q --filter/u);
  assert.match(deploy, /https:\/\/ai-project-os\.com\/api\/health/u);
  assert.ok(
    deploy.indexOf("run_upgrade_preflight post-migration") <
      deploy.indexOf("compose up -d --no-deps --no-build --force-recreate app worker"),
    "the target ledger must be verified before 0.6 writers start",
  );
  assert.doesNotMatch(deploy, /compose\s+down|docker\s+(?:volume|system|image)\s+prune/u);
});

test("0.6 preflight pins the 106 to 107 ledger transition", async () => {
  const { preflight } = await readContracts();
  assert.match(preflight, /SOURCE_MIGRATION_COUNT = 106/u);
  assert.match(preflight, /TARGET_MIGRATION_COUNT = 107/u);
  assert.match(preflight, /20260921010000_add_personal_knowledge_domain/u);
  assert.match(preflight, /createHash\("sha256"\)/u);
  assert.match(preflight, /_prisma_migrations/u);
  assert.match(preflight, /finished_at === null/u);
  assert.match(preflight, /rolled_back_at !== null/u);
  assert.match(preflight, /ai_project_os_runtime/u);
  assert.match(preflight, /ai_project_os_entitlement_writer/u);
  assert.match(preflight, /PersonalKnowledgeDocument/u);
  assert.match(preflight, /V06_PREFLIGHT_TARGET_CATALOG_INVALID/u);
  assert.match(preflight, /indisvalid/u);
  assert.match(preflight, /convalidated/u);
  assert.match(preflight, /post-migration/u);
});

test("backup and recovery recognize the 0.6 stopped-writer artifact", async () => {
  const { backup, restore } = await readContracts();
  assert.match(backup, /TARGET_TAG" == v0\.6\.0-dev\.2/u);
  assert.ok(backup.includes("pre-deploy-to-v0\\.6\\.0-dev\\.2"));
  assert.ok(restore.includes("pre-deploy-to-v0\\.6\\.0-dev\\.2"));
});
