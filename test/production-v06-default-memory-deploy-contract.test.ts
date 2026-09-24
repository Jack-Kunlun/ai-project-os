import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const deployerPath = path.join(root, "deploy/production/ai-project-os-v06-default-memory-deploy");
const gatewayPath = path.join(root, "deploy/production/ai-project-os-actions-gateway");

test(".10 to .11 migration route is exact, backup-first, and isolated", async () => {
  const [gateway, deployer, workflow, preflight, sudoers] = await Promise.all([
    readFile(gatewayPath, "utf8"),
    readFile(deployerPath, "utf8"),
    readFile(path.join(root, ".github/workflows/deploy-v06-default-memory-migration.yml"), "utf8"),
    readFile(path.join(root, "scripts/production-v06-default-memory-upgrade-preflight.ts"), "utf8"),
    readFile(path.join(root, "deploy/production/ai-project-os-deploy.sudoers"), "utf8"),
  ]);

  assert.equal(spawnSync("bash", ["-n", deployerPath]).status, 0);
  assert.match(gateway, /\^deploy-v06-default-memory\\ \(v0\\\.6\\\.0-dev\\\.10\)\\ \(v0\\\.6\\\.0-dev\\\.11\)/u);
  assert.match(gateway, /CONFIRM_V06_DEFAULT_MEMORY_MIGRATION_V1/u);
  assert.match(gateway, /sudo -n \/usr\/local\/sbin\/ai-project-os-v06-default-memory-deploy/u);
  assert.match(sudoers, /^ai-project-os-actions ALL=\(root\) NOPASSWD: \/usr\/local\/sbin\/ai-project-os-v06-default-memory-deploy$/mu);

  assert.match(deployer, /SOURCE_TAG.*\$\{1-\}/u);
  assert.match(deployer, /\^v0\\\.6\\\.0-dev\\\.10\$/u);
  assert.match(deployer, /RELEASE_TAG.*v0\.6\.0-dev\.11/u);
  assert.match(deployer, /DEPLOY_TARGET_MAIN_AND_TAG_FULL_CI_REQUIRED/u);
  assert.match(deployer, /production-v06-default-memory-upgrade-preflight\.ts/u);
  assert.match(deployer, /migrationCount[\s\S]*?expected_count/u);
  assert.ok(deployer.indexOf("stop_source_writers") < deployer.indexOf('"$BACKUP_SCRIPT" pre-deploy "$RELEASE_TAG"'));
  assert.ok(deployer.indexOf('"$BACKUP_SCRIPT" pre-deploy "$RELEASE_TAG"') < deployer.indexOf("MUTATION_ATTEMPTED=1", deployer.indexOf("perform_writer_cutover()")));
  assert.match(deployer, /source_quiesced=true/u);
  assert.match(deployer, /V06_DEFAULT_MEMORY_DEPLOY_RECOVERY_REQUIRED/u);
  assert.match(deployer, /V06_DEFAULT_MEMORY_DEPLOY_EMERGENCY/u);
  assert.match(deployer, /MUTATION_ATTEMPTED == 1 && NEW_WRITERS_CONFIRMED_HEALTHY == 0/u);
  assert.match(deployer, /NEW_WRITERS_CONFIRMED_HEALTHY=1[\s\S]*?public_health=\$\(curl/u);
  assert.match(deployer, /V06_DEFAULT_MEMORY_DEPLOY_POST_CUTOVER_INCOMPLETE/u);
  assert.match(deployer, /compose up -d --no-deps --no-build --force-recreate app worker/u);
  assert.doesNotMatch(deployer, /compose down|docker (system|volume|image) prune/u);

  assert.match(preflight, /SOURCE_MIGRATION_COUNT = 116/u);
  assert.match(preflight, /TARGET_MIGRATION_COUNT = 117/u);
  assert.match(preflight, /20260922050000_harden_personal_knowledge_qa_audit/u);
  assert.match(preflight, /20260924010000_add_personal_knowledge_graph_suggestions/u);
  assert.match(preflight, /PersonalKnowledgeGraphSuggestion_source_triple_key/u);
  assert.match(preflight, /PersonalKnowledgeExtractionAttempt_provider_fkey/u);
  assert.match(preflight, /reference_key_count in \(2, 3\)/u);
  assert.match(preflight, /V06_DEFAULT_MEMORY_PREFLIGHT_WRITER_SESSIONS_PRESENT/u);

  assert.match(workflow, /readonly DEPLOY_TAG_INPUT=v0\.6\.0-dev\.11/u);
  assert.match(workflow, /readonly DEPLOY_SOURCE_TAG_INPUT=v0\.6\.0-dev\.10/u);
  assert.match(workflow, /source_migration_count[\s\S]*?116[\s\S]*?target_migration_count[\s\S]*?117/u);
  assert.match(workflow, /Verify database and release candidate/u);
  assert.match(workflow, /deploy-v06-default-memory \$DEPLOY_SOURCE_TAG \$DEPLOY_TAG \$DEPLOY_SOURCE_SHA \$DEPLOY_SHA CONFIRM_V06_DEFAULT_MEMORY_MIGRATION_V1/u);
  assert.match(workflow, /BACKUP_OK .* source_quiesced=true/u);
  assert.equal((workflow.match(/"install-release-tooling \$DEPLOY_TAG \$DEPLOY_SHA CONFIRM_INSTALL_RELEASE_TOOLING_V1"/gu) ?? []).length, 2);
});

test("the previous .10 tooling updater accepts retained gateway and sudoers contracts before the second bootstrap", async () => {
  const oldUpdater = execFileSync("git", ["show", "v0.6.0-dev.10:deploy/production/ai-project-os-install-release-tooling"], { encoding: "utf8" });
  const [newUpdater, gateway, sudoers, workflow] = await Promise.all([
    readFile(path.join(root, "deploy/production/ai-project-os-install-release-tooling"), "utf8"),
    readFile(gatewayPath, "utf8"),
    readFile(path.join(root, "deploy/production/ai-project-os-deploy.sudoers"), "utf8"),
    readFile(path.join(root, ".github/workflows/deploy-v06-default-memory-migration.yml"), "utf8"),
  ]);

  assert.doesNotMatch(oldUpdater, /ai-project-os-v06-default-memory-deploy/u);
  for (const required of [
    "CONFIRM_INSTALL_RELEASE_TOOLING_V1",
    "CONFIRM_V06_MIGRATION_V1",
    "CONFIRM_V06_PATCH_V1",
    "CONFIRM_V06_NEXT_MIGRATION_V1",
    "CONFIRM_APP_NO_MIGRATION_V1",
    "CONFIRM_PRESERVE_DATA_V1",
    "configure-github-oauth",
  ]) assert.ok(gateway.includes(required), required);
  for (const required of [
    "/usr/local/sbin/ai-project-os-v06-deploy",
    "/usr/local/sbin/ai-project-os-v06-patch-deploy",
    "/usr/local/sbin/ai-project-os-v06-next-deploy",
    "/usr/local/sbin/ai-project-os-app-deploy",
    "/usr/local/sbin/ai-project-os-preserve-deploy",
    "/usr/local/sbin/ai-project-os-configure-github-oauth",
  ]) assert.ok(sudoers.includes(required), required);

  assert.match(oldUpdater, /grep -Fq 'CONFIRM_V06_NEXT_MIGRATION_V1' "\$GATEWAY"/u);
  assert.match(oldUpdater, /visudo -cf "\$SUDOERS"/u);
  assert.match(oldUpdater, /RELEASE_TOOLING_SUDOERS_TOO_BROAD/u);
  assert.match(newUpdater, /stage_install "\$V06_DEFAULT_MEMORY_DEPLOYER"/u);
  assert.ok(newUpdater.indexOf('mv -f -- "$staged_v06_default_memory_deployer"') < newUpdater.indexOf('mv -f -- "$staged_gateway"'));
  assert.equal((workflow.match(/"install-release-tooling \$DEPLOY_TAG \$DEPLOY_SHA CONFIRM_INSTALL_RELEASE_TOOLING_V1"/gu) ?? []).length, 2);
});

test("the gateway denies nearby versions and shell injection for the migration command", () => {
  const sha = "a".repeat(40);
  const denied = [
    `deploy-v06-default-memory v0.6.0-dev.9 v0.6.0-dev.11 ${sha} ${sha} CONFIRM_V06_DEFAULT_MEMORY_MIGRATION_V1`,
    `deploy-v06-default-memory v0.6.0-dev.10 v0.6.0-dev.12 ${sha} ${sha} CONFIRM_V06_DEFAULT_MEMORY_MIGRATION_V1`,
    `deploy-v06-default-memory v0.6.0-dev.10 v0.6.0-dev.11 ${sha} ${sha} CONFIRM_V06_DEFAULT_MEMORY_MIGRATION_V1; id`,
  ];
  for (const command of denied) {
    const result = spawnSync("bash", [gatewayPath], {
      encoding: "utf8",
      env: { ...process.env, SSH_ORIGINAL_COMMAND: command },
    });
    assert.equal(result.status, 64, command);
    assert.match(result.stderr, /AI_PROJECT_OS_DEPLOY_COMMAND_DENIED/u);
  }
});
