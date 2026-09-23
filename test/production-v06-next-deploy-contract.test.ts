import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = process.cwd();

test("0.6 next migration route is exact, backup-first, and fail-closed after mutation", async () => {
  const [gateway, deployer, workflow, preflight, sudoers] = await Promise.all([
    readFile(path.join(root, "deploy/production/ai-project-os-actions-gateway"), "utf8"),
    readFile(path.join(root, "deploy/production/ai-project-os-v06-next-deploy"), "utf8"),
    readFile(path.join(root, ".github/workflows/deploy-production.yml"), "utf8"),
    readFile(path.join(root, "scripts/production-v06-next-upgrade-preflight.ts"), "utf8"),
    readFile(path.join(root, "deploy/production/ai-project-os-deploy.sudoers"), "utf8"),
  ]);

  assert.match(gateway, /\^deploy-v06-next\\ \(v0\\\.6\\\.0-dev\\\.7\)\\ \(v0\\\.6\\\.0-dev\\\.8\)/u);
  assert.match(gateway, /CONFIRM_V06_NEXT_MIGRATION_V1/u);
  assert.match(gateway, /sudo -n \/usr\/local\/sbin\/ai-project-os-v06-next-deploy/u);
  assert.match(sudoers, /^ai-project-os-actions ALL=\(root\) NOPASSWD: \/usr\/local\/sbin\/ai-project-os-v06-next-deploy$/mu);

  assert.match(deployer, /SOURCE_TAG.*\$\{1-\}/u);
  assert.match(deployer, /\^v0\\\.6\\\.0-dev\\\.7\$/u);
  assert.match(deployer, /RELEASE_TAG.*v0\.6\.0-dev\.8/u);
  assert.match(deployer, /scripts\/production-v06-next-upgrade-preflight\.ts/u);
  assert.ok(deployer.indexOf("stop_source_writers") < deployer.indexOf('"$BACKUP_SCRIPT" pre-deploy "$RELEASE_TAG"'));
  assert.ok(deployer.indexOf('"$BACKUP_SCRIPT" pre-deploy "$RELEASE_TAG"') < deployer.indexOf("MUTATION_ATTEMPTED=1"));
  assert.match(deployer, /source_quiesced=true/u);
  assert.match(deployer, /V06_NEXT_DEPLOY_RECOVERY_REQUIRED/u);
  assert.match(deployer, /V06_NEXT_DEPLOY_EMERGENCY/u);
  assert.doesNotMatch(deployer, /compose down|docker (system|volume|image) prune/u);

  assert.match(preflight, /SOURCE_MIGRATION_COUNT = 107/u);
  assert.match(preflight, /TARGET_MIGRATION_COUNT = 116/u);
  assert.match(preflight, /20260922050000_harden_personal_knowledge_qa_audit/u);
  assert.match(preflight, /PersonalConnectionProbeAttempt/u);
  assert.match(preflight, /PersonalKnowledgeSemanticAudit/u);
  assert.match(preflight, /V06_NEXT_PREFLIGHT_WRITER_SESSIONS_PRESENT/u);

  assert.match(workflow, /default: v0\.6\.0-dev\.8/u);
  assert.match(workflow, /default: v0\.6\.0-dev\.7/u);
  assert.match(workflow, /migration_count.*116/u);
  assert.match(workflow, /deploy-v06-next \$DEPLOY_SOURCE_TAG \$DEPLOY_TAG \$DEPLOY_SOURCE_SHA \$DEPLOY_SHA CONFIRM_V06_NEXT_MIGRATION_V1/u);
});
