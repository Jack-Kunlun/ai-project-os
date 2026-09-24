import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const appDeployerPath = "deploy/production/ai-project-os-app-deploy";
const gatewayPath = "deploy/production/ai-project-os-actions-gateway";

test("application release requires exact no-migration evidence at both boundaries", async () => {
  const [deployer, preflight, workflow, updater, backup] = await Promise.all([
    readFile(appDeployerPath, "utf8"),
    readFile("scripts/production-app-upgrade-preflight.ts", "utf8"),
    readFile(".github/workflows/deploy-application.yml", "utf8"),
    readFile("deploy/production/ai-project-os-install-release-tooling", "utf8"),
    readFile("deploy/production/ai-project-os-backup", "utf8"),
  ]);
  assert.equal(spawnSync("bash", ["-n", appDeployerPath]).status, 0);
  assert.match(deployer, /source_sequence >= 8 && target_sequence > source_sequence/u);
  assert.match(deployer, /\$\{#target_sequence\} <= 6/u);
  assert.match(deployer, /PATCH_DEPLOY_DATABASE_FILES_CHANGED/u);
  assert.match(deployer, /production-app-upgrade-preflight\.ts/u);
  assert.match(deployer, /PATCH_MIGRATION_COUNT=116/u);
  assert.match(deployer, /source_sequence >= 11[\s\S]*?PATCH_MIGRATION_COUNT=117/u);
  assert.match(deployer, /source_migration_count[\s\S]*?target_migration_count[\s\S]*?PATCH_MIGRATION_COUNT/u);
  assert.match(deployer, /migrationCount[\s\S]*?PATCH_MIGRATION_COUNT/u);
  assert.match(deployer, /production-app-upgrade-preflight\.ts "\$phase" "\$RELEASE_TAG" "\$SOURCE_TAG"/u);
  assert.match(deployer, /BACKUP_OK .* source_quiesced=true/u);
  assert.match(deployer, /PATCH_DEPLOY_FULL_DATABASE_CI_REQUIRED/u);
  assert.match(deployer, /run\.get\("head_branch"\) == "main"/u);
  assert.match(deployer, /compose up -d --no-deps --no-build --force-recreate app worker/u);
  assert.doesNotMatch(deployer, /compose up[^\n]*\b(?:migrate|reconcile|principal-bootstrap)\b/u);
  assert.match(preflight, /sourceSequence >= 11 \? 117 : 116/u);
  assert.match(preflight, /runV06DefaultMemoryUpgradePreflight\("post-migration", databaseUrl\)/u);
  assert.match(preflight, /runV06NextUpgradePreflight\("post-migration", databaseUrl\)/u);
  assert.match(preflight, /migrations\.length !== migrationCount/u);
  assert.match(preflight, /APP_PREFLIGHT_WRITER_SESSIONS_PRESENT/u);
  assert.match(workflow, /DEPLOY_DATABASE_FILES_CHANGED/u);
  assert.match(workflow, /DEPLOY_FULL_DATABASE_CI_REQUIRED/u);
  assert.match(workflow, /\.head_branch == "main" and \.conclusion == "success"/u);
  assert.match(workflow, /DEPLOY_TAG_SEQUENCE_INVALID/u);
  assert.match(workflow, /expected_migration_count=116[\s\S]*?source_sequence >= 11[\s\S]*?expected_migration_count=117/u);
  assert.match(workflow, /migration_count.*expected_migration_count/u);
  assert.match(workflow, /DEPLOY_TAG_INPUT="v\$\(node -p 'require\("\.\/package\.json"\)\.version'\)"/u);
  assert.match(workflow, /DEPLOY_SOURCE_TAG_INPUT="v\$\(jq --exit-status --raw-output '\.version \| strings'/u);
  assert.doesNotMatch(workflow, /\$\{\{ inputs\.(?:tag|source_tag) \}\}/u);
  assert.match(workflow, /deploy-app \$DEPLOY_SOURCE_TAG \$DEPLOY_TAG \$DEPLOY_SOURCE_SHA \$DEPLOY_SHA CONFIRM_APP_NO_MIGRATION_V1/u);
  assert.match(workflow, /PATCH_DEPLOY_OK/u);
  assert.match(updater, /ai-project-os-app-deploy/u);
  assert.match(backup, /pre-deploy-to-v0\\\.6\\\.0-dev\\\.\(\[9\]\|\[1-9\]\[0-9\]\+\)/u);
});

test("gateway rejects malformed application release commands", async () => {
  const sha = "a".repeat(40);
  const commands = [
    "deploy-app v0.6.0-dev.8 v0.7.0-dev.1 " + sha + " " + sha + " CONFIRM_APP_NO_MIGRATION_V1",
    "deploy-app v0.6.0-dev.8 v0.6.0-dev.9 " + sha + " " + sha + " CONFIRM_APP_NO_MIGRATION_V1; id",
    "deploy-app v0.6.0-dev.8 v0.6.0-dev.9 " + sha + " CONFIRM_APP_NO_MIGRATION_V1",
  ];
  for (const command of commands) {
    const result = spawnSync("bash", [gatewayPath], {
      encoding: "utf8",
      env: { ...process.env, SSH_ORIGINAL_COMMAND: command },
    });
    assert.equal(result.status, 64, command);
    assert.match(result.stderr, /AI_PROJECT_OS_DEPLOY_COMMAND_DENIED/u);
  }
});

test("tag CI attests main while presentation-only changes avoid PostgreSQL", async () => {
  const workflow = await readFile(".github/workflows/ci.yml", "utf8");
  assert.match(workflow, /tag-attestation:/u);
  assert.match(workflow, /\.head_branch == "main"/u);
  assert.match(workflow, /refs\/tags\/\$RELEASE_TAG\^\{\}/u);
  assert.match(workflow, /database:\n    needs: scope\n    if: \$\{\{ needs\.scope\.outputs\.database == 'true' \}\}/u);
  assert.doesNotMatch(workflow.split("  source:\n")[1]?.split("  database:\n")[0], /services:/u);
  assert.match(workflow, /verify:\n    needs: \[scope, source, database\]/u);
  assert.match(workflow, /test "\$DATABASE_RESULT" = success/u);
});

test("source and database gates retain the Git history used by release contracts", async () => {
  const workflow = await readFile(".github/workflows/ci.yml", "utf8");
  const source = workflow.split("\n  source:\n")[1]?.split("\n  database:\n")[0];
  const database = workflow.split("\n  database:\n")[1]?.split("\n  verify:\n")[0];
  assert.match(source ?? "", /fetch-depth: 0/u);
  assert.match(database ?? "", /fetch-depth: 0/u);
});

test("server release scope accepts only byte-exact package version changes", async () => {
  const deployer = await readFile(appDeployerPath, "utf8");
  const classifier = deployer.match(/delta_database_required=\$\(python3 - "\$REPOSITORY_DIR" "\$source_revision" "\$resolved_revision" <<'PY'\n([\s\S]*?)\nPY\n\)/u)?.[1];
  assert.ok(classifier);
  const root = await mkdtemp(path.join(tmpdir(), "ai-project-os-app-scope-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const classify = (base: string, head: string) => {
    const result = spawnSync("python3", ["-c", classifier, root, base, head], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    git("init", "-q");
    git("config", "user.name", "Release Test");
    git("config", "user.email", "release-test@example.invalid");
    await writeFile(path.join(root, "package.json"), '{"version":"0.6.0-dev.8","feature":-0}\n');
    git("add", "package.json");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    await writeFile(path.join(root, "package.json"), '{"version":"0.6.0-dev.9","feature":-0}\n');
    git("add", "package.json");
    git("commit", "-qm", "version");
    const version = git("rev-parse", "HEAD");
    assert.equal(classify(base, version), "false");
    await writeFile(path.join(root, "package.json"), '{"version":"0.6.0-dev.10","feature":0}\n');
    git("add", "package.json");
    git("commit", "-qm", "other-byte-change");
    assert.equal(classify(version, git("rev-parse", "HEAD")), "true");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
