import assert from "node:assert/strict";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const preservePath = path.join(root, "deploy/production/ai-project-os-preserve-deploy");
const gatewayPath = path.join(root, "deploy/production/ai-project-os-actions-gateway");
const sudoersPath = path.join(root, "deploy/production/ai-project-os-deploy.sudoers");
const installerPath = path.join(root, "deploy/production/install-production-deploy.sh");
const backupPath = path.join(root, "deploy/production/ai-project-os-backup");
const restorePath = path.join(root, "deploy/production/ai-project-os-restore");
const workflowPath = path.join(root, ".github/workflows/deploy-production.yml");
const ciWorkflowPath = path.join(root, ".github/workflows/ci.yml");

async function read(pathname: string): Promise<string> {
  return readFile(pathname, "utf8");
}

test("preserve deploy is an isolated one-release, fail-closed channel", async () => {
  const preserve = await read(preservePath);

  await access(preservePath, constants.X_OK);
  assert.equal(spawnSync("bash", ["-n", preservePath], { encoding: "utf8" }).status, 0);
  assert.match(preserve, /SOURCE_TAG=\$\{1-\}/u);
  assert.match(preserve, /TARGET_TAG=\$\{2-\}/u);
  assert.match(preserve, /SOURCE_TAG" == v0\.5\.0-dev\.1 && "\$TARGET_TAG" == v0\.5\.0-dev\.4/u);
  assert.match(preserve, /EXPECTED_SOURCE_REVISION=63a0a3700bd42a6d0ce5569276ce74a4b6aa9815/u);
  assert.match(preserve, /CONFIRM_PRESERVE_DATA_V1/u);
  assert.match(preserve, /source_revision.*EXPECTED_SOURCE_REVISION/u);
  assert.match(preserve, /target_revision.*EXPECTED_REVISION/u);
  assert.match(preserve, /source_revision.*target_revision/u);
  assert.match(preserve, /merge-base --is-ancestor "\$source_revision" "\$target_revision"/u);
  assert.match(preserve, /rev-list --merges "\$source_revision\.\.\$target_revision"/u);
  assert.match(preserve, /verify_ci_for_revision "\$SOURCE_REVISION" "\$SOURCE_TAG"/u);
  assert.match(preserve, /verify_ci_for_revision "\$TARGET_REVISION" "\$TARGET_TAG"/u);
  assert.match(preserve, /git -C "\$REPOSITORY_DIR" diff --quiet "\$source_revision" "\$target_revision" -- prisma\/schema\.prisma prisma\/migrations/u);
  assert.match(preserve, /changed_paths=.*git -C "\$REPOSITORY_DIR" diff --name-only/u);
  assert.match(preserve, /allowed = \{/u);
  assert.match(preserve, /\.github\/workflows\/ci\.yml/u);
  assert.match(preserve, /deploy\/production\/ai-project-os-preserve-deploy/u);
  assert.match(preserve, /docs\/deployment-security\.md/u);
  assert.match(preserve, /docs\/admin-operation-guide\.md/u);
  assert.match(preserve, /test\/production-deploy-contract\.test\.ts/u);
  assert.match(preserve, /PRESERVE_DEPLOY_REPOSITORY_DIRTY_BEFORE_STOP/u);
  assert.match(preserve, /SOURCE_ROLLBACK_APP_IMAGE_REF/u);
  assert.match(preserve, /SOURCE_ROLLBACK_WORKER_IMAGE_REF/u);
  assert.match(preserve, /pin_source_rollback_artifacts/u);
  assert.match(preserve, /verify_source_rollback_artifacts/u);
});

test("preserve env gate rejects duplicate keys and validates the clean-deploy key surface", async () => {
  const preserve = await read(preservePath);
  const validatorsStart = preserve.indexOf("validate_required_exact_env_value() {");
  const validatorsEnd = preserve.indexOf("\nvalidate_environment ||", validatorsStart);
  assert.notEqual(validatorsStart, -1);
  assert.notEqual(validatorsEnd, -1);
  const validators = preserve.slice(validatorsStart, validatorsEnd);
  const directory = await mkdtemp(path.join(tmpdir(), "ai-project-os-preserve-env-"));
  const harnessPath = path.join(directory, "validate-env.sh");
  const password = "a".repeat(64);
  const baseEnv = [
    "POSTGRES_USER=ai_project_os_cluster_admin",
    `POSTGRES_CLUSTER_ADMIN_PASSWORD=${password}`,
    `POSTGRES_MIGRATOR_PASSWORD=${password}`,
    "POSTGRES_RUNTIME_USER=ai_project_os_runtime",
    `POSTGRES_RUNTIME_PASSWORD=${password}`,
    "POSTGRES_ENTITLEMENT_WRITER_USER=ai_project_os_entitlement_writer",
    `POSTGRES_ENTITLEMENT_WRITER_PASSWORD=${password}`,
    `POSTGRES_ENTITLEMENT_INVENTORY_READER_PASSWORD=${password}`,
    "POSTGRES_DB=ai_project_os",
    "AI_PROJECT_OS_SECURE_COOKIES=true",
    "AI_PROJECT_OS_PUBLIC_ORIGIN=https://ai-project-os.com",
    "AI_PROJECT_OS_PGDATA_VOLUME=ai-project-os-pgdata",
    "AI_PROJECT_OS_SECRETS_VOLUME=ai-project-os-secrets",
    "AI_PROJECT_OS_UPLOADS_VOLUME=ai-project-os-uploads",
    "AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_ID=client-id-123",
    "AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_SECRET=client-secret-123",
  ].join("\n");
  await writeFile(
    harnessPath,
    `#!/usr/bin/env bash
set -Eeuo pipefail
ENV_FILE=$1
stat() {
  if [[ "$*" == *%U:%G* ]]; then printf 'root:root'; else printf '600'; fi
}
${validators}
validate_environment
`,
    { mode: 0o700 },
  );
  await chmod(harnessPath, 0o700);

  try {
    const duplicateCases = [
      "POSTGRES_ENTITLEMENT_WRITER_USER=another-writer",
      "POSTGRES_DB=another-db",
      "AI_PROJECT_OS_SECRETS_VOLUME=ai-project-os-alt-secrets",
      "AI_PROJECT_OS_UPLOADS_VOLUME=ai-project-os-alt-uploads",
      "AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_ID=client-id-456",
    ];
    for (const duplicateLine of duplicateCases) {
      const envPath = path.join(directory, "duplicate.env");
      await writeFile(envPath, `${baseEnv}\n${duplicateLine}\n`, { mode: 0o600 });
      const result = spawnSync("bash", [harnessPath, envPath], { encoding: "utf8" });
      assert.notEqual(result.status, 0, duplicateLine);
    }

    const invalidCases = [
      `${baseEnv}`.replace("POSTGRES_ENTITLEMENT_WRITER_USER=ai_project_os_entitlement_writer", "POSTGRES_ENTITLEMENT_WRITER_USER=wrong"),
      baseEnv.replace("POSTGRES_DB=ai_project_os", "POSTGRES_DB=wrong"),
      baseEnv.replace("AI_PROJECT_OS_SECRETS_VOLUME=ai-project-os-secrets", "AI_PROJECT_OS_SECRETS_VOLUME=unsafe"),
      baseEnv.replace("AI_PROJECT_OS_UPLOADS_VOLUME=ai-project-os-uploads", "AI_PROJECT_OS_UPLOADS_VOLUME=unsafe"),
      baseEnv.replace("AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_ID=client-id-123", "AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_ID=short"),
    ];
    for (const contents of invalidCases) {
      const envPath = path.join(directory, "invalid.env");
      await writeFile(envPath, `${contents}\n`, { mode: 0o600 });
      const result = spawnSync("bash", [harnessPath, envPath], { encoding: "utf8" });
      assert.notEqual(result.status, 0, contents);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("preserve deploy allowlist covers the committed source-to-target diff", async () => {
  const preserve = await read(preservePath);
  const allowlistBlock = preserve.match(/allowed = \{([\s\S]*?)\n\}/u)?.[1];
  assert.ok(allowlistBlock, "preserve deploy allowlist is missing");
  const allowed = new Set<string>();
  for (const match of allowlistBlock.matchAll(/"([^"]+)",/gu)) {
    allowed.add(match[1]);
  }

  const sourceRevision = "63a0a3700bd42a6d0ce5569276ce74a4b6aa9815";
  const targetRevision = "45bdc3e31";
  const diff = spawnSync("git", ["diff", "--name-only", sourceRevision, targetRevision], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(diff.status, 0, diff.stderr);
  const changedPaths = diff.stdout
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
  assert.ok(changedPaths.length > 0, "source-to-target diff is unexpectedly empty");
  assert.deepEqual(
    changedPaths.filter((pathname) => !allowed.has(pathname)),
    [],
    "source-to-target diff contains a path outside the preserve allowlist",
  );
});

test("preserve deploy never crosses the destructive or migration command boundary", async () => {
  const preserve = await read(preservePath);

  assert.match(preserve, /compose build app worker/u);
  assert.match(preserve, /compose up -d --no-deps --no-build --force-recreate app worker/u);
  assert.doesNotMatch(preserve, /compose\s+down/u);
  assert.doesNotMatch(preserve, /docker\s+volume\s+rm/u);
  assert.doesNotMatch(preserve, /docker\s+(system|volume|image)\s+prune/u);
  assert.doesNotMatch(preserve, /compose\s+(?:run|up|build)[^\n]*(?:principal-bootstrap|migrate|reconcile)/u);
  assert.match(preserve, /BACKUP_SCRIPT.*ai-project-os-backup/u);
  assert.match(preserve, /AI_PROJECT_OS_EXPECTED_APP_ID="\$OLD_APP_ID"/u);
  assert.match(preserve, /AI_PROJECT_OS_EXPECTED_WORKER_ID="\$OLD_WORKER_ID"/u);
  assert.match(preserve, /BACKUP_COS_OBJECT_VERIFIED type=archive/u);
  assert.match(preserve, /BACKUP_COS_OBJECT_VERIFIED type=manifest/u);
  assert.match(preserve, /source_quiesced=true/u);
});

test("preserve deploy protects PostgreSQL identity, ledger, data counts, and rollback", async () => {
  const preserve = await read(preservePath);

  assert.match(preserve, /PGDATA_CREATED_AT/u);
  assert.match(preserve, /com\.docker\.compose\.project/u);
  assert.match(preserve, /com\.docker\.compose\.volume/u);
  assert.match(preserve, /PGDATA_CONSUMERS/u);
  assert.match(preserve, /HostIp.*127\.0\.0\.1/u);
  assert.match(preserve, /EXPECTED_MIGRATION_COUNT=106/u);
  assert.match(preserve, /_prisma_migrations/u);
  assert.match(preserve, /count\(\*\) FROM "_prisma_migrations"\)/u);
  assert.match(preserve, /"finished_at" IS NULL AND "rolled_back_at" IS NULL/u);
  assert.match(preserve, /EXPECTED_MIGRATION_COUNT\|\$EXPECTED_MIGRATION_COUNT\|0\|0/u);
  assert.match(preserve, /POSTGRES_ENTITLEMENT_WRITER_USER/u);
  assert.match(preserve, /POSTGRES_DB/u);
  assert.match(preserve, /AI_PROJECT_OS_SECRETS_VOLUME/u);
  assert.match(preserve, /AI_PROJECT_OS_UPLOADS_VOLUME/u);
  assert.match(preserve, /validate_github_oauth_env_value/u);
  assert.match(preserve, /AppUser/u);
  assert.match(preserve, /Workspace/u);
  assert.match(preserve, /AiProviderConnection/u);
  assert.match(preserve, /PlatformTokenGrant/u);
  assert.match(preserve, /assert_data_snapshot_not_decreased/u);
  assert.match(preserve, /OLD_APP_IMAGE_ID/u);
  assert.match(preserve, /OLD_WORKER_IMAGE_ID/u);
  assert.match(preserve, /verify_source_container_metadata/u);
  assert.match(preserve, /SOURCE_ROLLBACK_APP_IMAGE_ID/u);
  assert.match(preserve, /SOURCE_ROLLBACK_WORKER_IMAGE_ID/u);
  assert.match(preserve, /rollback_to_source/u);
  assert.match(preserve, /quiesce_current_writers_after_rollback_failure/u);
  assert.match(preserve, /label=com\.docker\.compose\.service=app/u);
  assert.match(preserve, /label=com\.docker\.compose\.service=worker/u);
  assert.match(preserve, /writers_stopped=true/u);
  assert.match(preserve, /writers_may_be_running=true/u);
  assert.doesNotMatch(preserve, /phase=post-switch old_writers_not_restarted=true/u);
  assert.match(preserve, /PRESERVE_DEPLOY_ROLLBACK_OK/u);
  assert.match(preserve, /PRESERVE_DEPLOY_RECOVERY_REQUIRED/u);
  assert.match(preserve, /docker tag "\$SOURCE_ROLLBACK_APP_IMAGE_REF" "\$OLD_APP_IMAGE_REF"/u);
  assert.match(preserve, /docker tag "\$SOURCE_ROLLBACK_WORKER_IMAGE_REF" "\$OLD_WORKER_IMAGE_REF"/u);
  assert.doesNotMatch(preserve, /docker image inspect[^\n]*OLD_APP_IMAGE_ID/u);
  assert.doesNotMatch(preserve, /docker image inspect[^\n]*OLD_WORKER_IMAGE_ID/u);
  assert.ok(
    preserve.indexOf("compose build app worker || { printf 'PRESERVE_DEPLOY_SOURCE_IMAGE_BUILD_FAILED") <
      preserve.indexOf("stop_source_writers ||"),
    "source image build must happen before writers stop",
  );
  assert.ok(
    preserve.indexOf("pin_source_rollback_artifacts || { printf 'PRESERVE_DEPLOY_SOURCE_ROLLBACK_PIN_FAILED") <
      preserve.indexOf("stop_source_writers ||"),
    "source rollback artifacts must be pinned before writers stop",
  );
  assert.ok(
    preserve.indexOf("verify_source_rollback_artifacts || { printf 'PRESERVE_DEPLOY_SOURCE_ROLLBACK_LOST") <
      preserve.indexOf("stop_source_writers ||"),
    "source rollback artifacts must survive target build before writers stop",
  );
  assert.match(preserve, /trap recover_on_failure EXIT/u);
  assert.match(preserve, /STACK_HEALTH=\$body/u);
  assert.match(preserve, /PRESERVE_DEPLOY_TARGET_LOCAL_HEALTH_UNRECORDED/u);
  assert.match(preserve, /PRESERVE_DEPLOY_TARGET_APP_METADATA_INVALID/u);
  assert.match(preserve, /PRESERVE_DEPLOY_TARGET_WORKER_METADATA_INVALID/u);
});

test("gateway, sudoers, and installer preserve the v0.5 route while adding the restricted tooling updater", async () => {
  const [gateway, sudoers, installer] = await Promise.all([
    read(gatewayPath),
    read(sudoersPath),
    read(installerPath),
  ]);

  assert.ok(gateway.includes("preserve-deploy\\ (v0\\.5\\.0-dev\\.1)\\ (v0\\.5\\.0-dev\\.4)"));
  assert.match(gateway, /CONFIRM_PRESERVE_DATA_V1/u);
  assert.doesNotMatch(gateway, /clean-deploy/u);
  assert.match(gateway, /ai-project-os-preserve-deploy/u);
  assert.match(gateway, /configure-github-oauth/u);
  assert.match(gateway, /install-release-tooling/u);
  assert.doesNotMatch(sudoers, /clean-deploy/u);
  assert.match(sudoers, /ai-project-os-preserve-deploy/u);
  assert.match(sudoers, /ai-project-os-configure-github-oauth/u);
  assert.match(sudoers, /ai-project-os-install-release-tooling/u);
  assert.match(installer, /ai-project-os-preserve-deploy/u);
  assert.match(installer, /bash -n \/usr\/local\/sbin\/ai-project-os-preserve-deploy/u);
  assert.match(installer, /bash -n \/usr\/local\/sbin\/ai-project-os-install-release-tooling/u);
});

test("backup and recovery allow the explicit .1, .2, .3, and .4 preserve names", async () => {
  const [backup, restore] = await Promise.all([read(backupPath), read(restorePath)]);

  assert.ok(backup.includes("pre-deploy-to-v0\\.5\\.0-dev\\.(1|2|3|4)"));
  assert.ok(backup.includes('TARGET_TAG" =~ ^v0\\.5\\.0-dev\\.(1|2|3|4)$'));
  assert.ok(restore.includes('RELEASE_TAG" =~ ^v0\\.5\\.0-dev\\.(1|2|3|4)$'));
  assert.ok(restore.includes("pre-deploy-to-v0\\.5\\.0-dev\\.(1|2|3|4)"));
  assert.doesNotMatch(restore, /v0\\\.4\\\.0-dev\\\.2/u);
  assert.match(restore, /MIGRATION_TARGET_TAG=v0\.5\.0-dev\.1/u);
});

test("production workflow is main-only and requires exact 0.6 migration markers", async () => {
  const [workflow, ciWorkflow] = await Promise.all([read(workflowPath), read(ciWorkflowPath)]);

  assert.match(workflow, /default: v0\.6\.0-dev\.4/u);
  assert.match(workflow, /DEPLOY_TAG_INPUT" != v0\.6\.0-dev\.4/u);
  assert.match(workflow, /git rev-parse HEAD.*deploy_sha/u);
  assert.match(workflow, /git merge-base --is-ancestor "\$source_sha" "\$deploy_sha"/u);
  assert.match(workflow, /git rev-list --merges "\$source_sha\.\.\$deploy_sha"/u);
  assert.match(workflow, /refs\/tags\/\$DEPLOY_SOURCE_TAG_INPUT/u);
  assert.match(workflow, /deploy-v06 \$DEPLOY_SOURCE_TAG \$DEPLOY_TAG \$DEPLOY_SHA CONFIRM_V06_MIGRATION_V1/u);
  assert.match(workflow, /\^DEPLOY_OK /u);
  assert.match(workflow, /BACKUP_OK .* source_quiesced=true/u);
  assert.doesNotMatch(workflow, /clean-deploy/u);
  assert.match(ciWorkflow, /uses: actions\/checkout@[\da-f]+[\s\S]*fetch-depth: 0/u);
  assert.doesNotMatch(ciWorkflow, /fetch-depth:\s*1/u);
});
