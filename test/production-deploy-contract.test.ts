import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const repositoryRoot = process.cwd();
const workflowPath = path.join(repositoryRoot, ".github/workflows/deploy-production.yml");
const deploymentPath = path.join(repositoryRoot, "deploy/production/ai-project-os-deploy");
const backupPath = path.join(repositoryRoot, "deploy/production/ai-project-os-backup");
const backupInstallerPath = path.join(repositoryRoot, "deploy/production/install-production-backup.sh");
const backupServicePath = path.join(repositoryRoot, "deploy/production/ai-project-os-backup.service");
const backupTimerPath = path.join(repositoryRoot, "deploy/production/ai-project-os-backup.timer");
const productionComposeOverridePath = path.join(repositoryRoot, "deploy/production/compose.operations.yaml");
const gatewayPath = path.join(repositoryRoot, "deploy/production/ai-project-os-actions-gateway");
const githubOAuthConfiguratorPath = path.join(repositoryRoot, "deploy/production/ai-project-os-configure-github-oauth");
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
  assert.match(workflow, /vars\.AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_ID/u);
  assert.match(workflow, /secrets\.AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_SECRET/u);
  assert.match(workflow, /AI_PROJECT_OS_GITHUB_OAUTH_CONFIG_V1/u);
  assert.match(workflow, /"configure-github-oauth"/u);
  assert.match(workflow, /PRODUCTION_GITHUB_OAUTH_CONFIG_OK/u);
  assert.match(workflow, /StrictHostKeyChecking=yes/u);
  assert.match(workflow, /vars\.PRODUCTION_SSH_HOST/u);
  assert.match(workflow, /PRODUCTION_SSH_HOST_INVALID/u);
  assert.match(workflow, /ai-project-os-actions@\$PRODUCTION_SSH_HOST/u);
  assert.doesNotMatch(workflow, /38\.76\.205\.30/u);
  assert.match(workflow, /"deploy \$DEPLOY_TAG \$DEPLOY_SHA"/u);
  assert.match(workflow, /Create verified offsite backup and deploy/u);
  assert.match(workflow, /PRODUCTION_BACKUP_RESULT_INVALID/u);
  assert.match(workflow, /DEPLOY_BACKUP_OBJECT/u);
  assert.match(workflow, /\.worker\.consecutiveFailures == 0/u);
  assert.ok(
    workflow.indexOf("Sync GitHub OAuth configuration through restricted stdin") <
      workflow.indexOf("Create verified offsite backup and deploy through forced-command gateway"),
    "production OAuth configuration must be synchronized before deployment starts",
  );
  assert.doesNotMatch(workflow, /configure-github-oauth[^\n]*(GITHUB_OAUTH_CLIENT_ID|GITHUB_OAUTH_CLIENT_SECRET)/u);
  assert.doesNotMatch(workflow, /passwordauthentication|sshpass/iu);
});

test("production workflow is statically fail-closed before the first formal v1.0.0 release", async () => {
  const workflow = await readFile(workflowPath, "utf8");

  assert.match(workflow, /PRODUCTION_DEPLOYMENT_DISABLED_BEFORE_V1_0_0/u);
  assert.match(workflow, /if: \$\{\{ github\.ref == 'refs\/heads\/main' && false \}\}/u);
  assert.match(workflow, /\^v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$/u);
  assert.doesNotMatch(workflow, /0\.1\.0-dev\.1/u);
});

test("forced-command gateway accepts only an exact deploy or GitHub OAuth configuration command", async () => {
  const gateway = await readFile(gatewayPath, "utf8");

  assert.match(gateway, /SSH_ORIGINAL_COMMAND/u);
  assert.match(gateway, /\^deploy\\ \(v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\)\\ \(\[0-9a-f\]\{40\}\)\$/u);
  assert.match(gateway, /sudo -n \/usr\/local\/sbin\/ai-project-os-deploy/u);
  assert.match(gateway, /original_command.*== configure-github-oauth/u);
  assert.match(gateway, /sudo -n \/usr\/local\/sbin\/ai-project-os-configure-github-oauth/u);
  assert.match(gateway, /AI_PROJECT_OS_DEPLOY_COMMAND_DENIED/u);
});

test("root GitHub OAuth configurator validates fixed stdin and atomically preserves the production environment", async () => {
  const configurator = await readFile(githubOAuthConfiguratorPath, "utf8");

  assert.match(configurator, /EUID -ne 0/u);
  assert.match(configurator, /ENV_FILE=\/etc\/ai-project-os\/production\.env/u);
  assert.match(configurator, /PAYLOAD_HEADER=AI_PROJECT_OS_GITHUB_OAUTH_CONFIG_V1/u);
  assert.match(configurator, /IFS= read -r -n 128 payload_header/u);
  assert.match(configurator, /IFS= read -r -n 513 client_id/u);
  assert.match(configurator, /IFS= read -r -n 513 client_secret/u);
  assert.match(configurator, /PRODUCTION_GITHUB_OAUTH_PAYLOAD_INVALID/u);
  assert.match(configurator, /\$\{#client_id\} >= 8/u);
  assert.match(configurator, /\$\{#client_secret\} >= 8/u);
  assert.match(configurator, /\[A-Za-z0-9\._-\]\+\$/u);
  assert.match(configurator, /! -L "\$ENV_FILE"/u);
  assert.match(configurator, /root:root/u);
  assert.match(configurator, /== 600/u);
  assert.match(configurator, /PRODUCTION_GITHUB_OAUTH_ENV_DUPLICATE_KEY/u);
  assert.match(configurator, /ai-project-os-deploy\.lock/u);
  assert.match(configurator, /flock -n 9/u);
  assert.match(configurator, /PRODUCTION_GITHUB_OAUTH_DEPLOYMENT_IN_PROGRESS/u);
  assert.match(configurator, /mktemp "\$ENV_DIRECTORY\/\.production\.env\.github-oauth\.XXXXXX"/u);
  assert.match(configurator, /mv -f -- "\$temporary_env" "\$ENV_FILE"/u);
  assert.match(configurator, /client_secret=/u);
  assert.match(configurator, /PRODUCTION_GITHUB_OAUTH_CONFIG_OK/u);
  assert.doesNotMatch(configurator, /set -x|echo[^\n]*client_secret/iu);
});

test("root deployer verifies source, requires a verified offsite backup, migrates, and waits for health", async () => {
  const deployment = await readFile(deploymentPath, "utf8");

  assert.match(deployment, /REPOSITORY_URL=https:\/\/github\.com\/Jack-Kunlun\/ai-project-os\.git/u);
  assert.match(deployment, /DEPLOY_TAG_NOT_ANNOTATED/u);
  assert.match(deployment, /DEPLOY_TAG_REVISION_MISMATCH/u);
  assert.match(deployment, /DEPLOY_TAG_SUCCESSFUL_CI_NOT_FOUND/u);
  assert.match(deployment, /python3 -c/u);
  assert.match(deployment, /production\.env/u);
  assert.match(deployment, /AI_PROJECT_OS_SECURE_COOKIES=true/u);
  assert.match(deployment, /validate_github_oauth_env_value AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_ID/u);
  assert.match(deployment, /validate_github_oauth_env_value AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_SECRET/u);
  assert.match(deployment, /DEPLOY_GITHUB_OAUTH_CLIENT_ID_INVALID/u);
  assert.match(deployment, /DEPLOY_GITHUB_OAUTH_CLIENT_SECRET_INVALID/u);
  assert.match(deployment, /ai-project-os-backup/u);
  assert.match(deployment, /AI_PROJECT_OS_DEPLOY_LOCK_HELD=1/u);
  assert.match(deployment, /pre-deploy "\$RELEASE_TAG"/u);
  assert.match(deployment, /DEPLOY_PRE_BACKUP_RESULT_INVALID/u);
  assert.match(deployment, /backup_object/u);
  assert.match(deployment, /--force-recreate migrate app worker/u);
  assert.match(deployment, /consecutiveFailures/u);
  assert.match(deployment, /https:\/\/ai-project-os\.com\/api\/health/u);
  assert.doesNotMatch(deployment, /\bcompose down\b|down[^\n]*-v/u);
  assert.ok(
    deployment.indexOf('"$BACKUP_SCRIPT" pre-deploy "$RELEASE_TAG"') < deployment.indexOf("compose up -d postgres"),
    "offsite backup must complete before any production container replacement",
  );
});

test("backup quiesces writers, verifies encrypted COS objects, and deletes only marked local backups", async () => {
  const backup = await readFile(backupPath, "utf8");
  const remoteVerificationFunction = backup.slice(
    backup.indexOf("verify_remote_object()"),
    backup.indexOf("upload_object()"),
  );

  assert.match(backup, /docker pause "\$app_id"/u);
  assert.match(backup, /docker pause "\$worker_id"/u);
  assert.match(backup, /trap cleanup_on_exit EXIT/u);
  assert.match(backup, /BACKUP_STACK_SERVICE_NOT_HEALTHY/u);
  assert.match(backup, /wait_for_writer_health "\$app_id" "\$worker_id"/u);
  assert.match(backup, /BACKUP_WRITER_HEALTH_TIMEOUT/u);
  assert.ok(
    backup.indexOf('wait_for_writer_health "$app_id" "$worker_id"') <
      backup.indexOf('upload_object "$STAGING_ARCHIVE"'),
    "writer health must recover before offsite upload and success",
  );
  assert.match(backup, /pg_dump/u);
  assert.match(backup, /pg_restore --list/u);
  assert.match(backup, /docker cp "\$app_id:.*ai-project-os-secrets/u);
  assert.match(backup, /docker cp "\$app_id:.*ai-project-os\/uploads/u);
  assert.match(backup, /age --encrypt --recipients-file/u);
  assert.match(backup, /--disable-checksum=false/u);
  assert.match(backup, /--disable-crc64=false/u);
  assert.match(backup, /Content-Length/u);
  assert.match(backup, /x-cos-hash-crc64ecma/u);
  assert.match(backup, /COS_STAT_VERIFY_ATTEMPTS=8/u);
  assert.match(backup, /COS_STAT_VERIFY_INITIAL_DELAY_SECONDS=1/u);
  assert.match(backup, /COS_STAT_VERIFY_MAX_DELAY_SECONDS=8/u);
  assert.match(remoteVerificationFunction, /"\$COSCLI" stat "\$object_uri"/u);
  assert.match(remoteVerificationFunction, /timeout 30/u);
  assert.match(remoteVerificationFunction, /BACKUP_COS_OBJECT_VERIFY_RETRY/u);
  assert.doesNotMatch(remoteVerificationFunction, /--disable-log/u);
  assert.match(backup, /status=COS_UPLOAD_VERIFIED/u);
  assert.match(backup, /PUBLIC_STATUS_ROOT=\/var\/lib\/ai-project-os-operations\/backups/u);
  assert.match(backup, /publish_public_status running/u);
  assert.match(backup, /finish_public_status failed/u);
  assert.match(backup, /finish_public_status succeeded/u);
  assert.match(backup, /"verificationAttempts"/u);
  assert.match(backup, /"errorCode"/u);
  assert.match(backup, /chmod 644 "\$temporary_current"/u);
  assert.ok(
    backup.indexOf('cleanup_verified_local_backups "$backup_path"') <
      backup.indexOf("finish_public_status succeeded"),
    "success status must include the final local-retention result",
  );
  assert.match(backup, /LOCAL_RETENTION_DAYS_DEFAULT=14/u);
  assert.match(backup, /LOCAL_MIN_VERIFIED_DEFAULT=3/u);
  assert.match(backup, /\.cos-upload-verified/u);
  assert.match(backup, /ai-project-os-deploy\.lock/u);
  assert.match(backup, /BACKUP_DEPLOYMENT_IN_PROGRESS/u);
  assert.match(backup, /BACKUP_PRE_DEPLOY_CALLER_INVALID/u);
  assert.match(backup, /rm -rf --one-file-system -- "\$path"/u);
  assert.doesNotMatch(backup, /docker (system|volume|image) prune|find[^\n]*-delete/u);
  assert.doesNotMatch(backup, /read_config_value COS_SECRET_(ID|KEY)/u);
  assert.ok(
    backup.indexOf("upload_object \"$STAGING_CHECKSUM\"") <
      backup.indexOf('mv -f -- "$marker_tmp" "$backup_path/.cos-upload-verified"'),
    "remote verification must finish before the local success marker is installed",
  );
  assert.ok(
    backup.indexOf('mv -f -- "$marker_tmp" "$backup_path/.cos-upload-verified"') <
      backup.lastIndexOf('cleanup_verified_local_backups "$backup_path"'),
    "retention must run only after the current backup has a verified marker",
  );
});

test("backup retries transient COS metadata visibility without weakening remote verification", async (context) => {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "ai-project-os-backup-stat-"));
  context.after(async () => {
    await rm(temporaryDirectory, { force: true, recursive: true });
  });

  const backup = await readFile(backupPath, "utf8");
  const functionStart = backup.indexOf("verify_remote_object()");
  const functionEnd = backup.indexOf("\nupload_object()", functionStart);
  assert.notEqual(functionStart, -1);
  assert.notEqual(functionEnd, -1);
  const remoteVerificationFunction = backup.slice(functionStart, functionEnd);

  const mockCoscliPath = path.join(temporaryDirectory, "coscli");
  const harnessPath = path.join(temporaryDirectory, "verify-remote-object.sh");
  const localArchivePath = path.join(temporaryDirectory, "archive.tar.age");
  const counterPath = path.join(temporaryDirectory, "attempts");

  await writeFile(localArchivePath, "test", { mode: 0o600 });
  await writeFile(
    mockCoscliPath,
    `#!/usr/bin/env bash
set -Eeuo pipefail
attempt=0
if [[ -f "$MOCK_COS_COUNTER" ]]; then
  attempt=$(<"$MOCK_COS_COUNTER")
fi
attempt=$(( attempt + 1 ))
printf '%s\n' "$attempt" > "$MOCK_COS_COUNTER"
printf 'INFO Object: cos://example/archive.tar.age\n'
if [[ "\${MOCK_COS_MODE-}" == transient && "$attempt" -ge 3 ]]; then
  printf 'INFO Content-Length: 4\n'
  printf 'INFO x-cos-hash-crc64ecma: 123456789\n'
fi
`,
    { mode: 0o700 },
  );
  await chmod(mockCoscliPath, 0o700);
  await writeFile(
    harnessPath,
    `#!/usr/bin/env bash
set -Eeuo pipefail
readonly COSCLI=${JSON.stringify(mockCoscliPath)}
readonly COSCLI_CONFIG=/unused/coscli.yaml
readonly COS_STAT_VERIFY_ATTEMPTS=8
readonly COS_STAT_VERIFY_INITIAL_DELAY_SECONDS=1
readonly COS_STAT_VERIFY_MAX_DELAY_SECONDS=8
PUBLIC_VERIFICATION_ATTEMPTS=0
sleep() { :; }
timeout() {
  shift
  "$@"
}
stat() {
  if [[ "$1" == -c && "$2" == %s ]]; then
    wc -c < "$3" | tr -d '[:space:]'
    return
  fi
  command stat "$@"
}
fail() {
  printf '%s\n' "$1" >&2
  exit "\${2-1}"
}
${remoteVerificationFunction}
verify_remote_object cos://example/archive.tar.age "$MOCK_LOCAL_ARCHIVE" archive
`,
    { mode: 0o700 },
  );

  const transientResult = spawnSync("bash", [harnessPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      MOCK_COS_COUNTER: counterPath,
      MOCK_COS_MODE: "transient",
      MOCK_LOCAL_ARCHIVE: localArchivePath,
    },
  });
  assert.equal(transientResult.status, 0, transientResult.stderr);
  assert.match(transientResult.stdout, /BACKUP_COS_OBJECT_VERIFY_RETRY type=archive attempt=1/u);
  assert.match(transientResult.stdout, /BACKUP_COS_OBJECT_VERIFY_RETRY type=archive attempt=2/u);
  assert.match(transientResult.stdout, /BACKUP_COS_OBJECT_VERIFIED[^\n]*attempt=3/u);
  assert.equal((await readFile(counterPath, "utf8")).trim(), "3");

  await rm(counterPath, { force: true });
  const missingMetadataResult = spawnSync("bash", [harnessPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      MOCK_COS_COUNTER: counterPath,
      MOCK_COS_MODE: "missing",
      MOCK_LOCAL_ARCHIVE: localArchivePath,
    },
  });
  assert.equal(missingMetadataResult.status, 74);
  assert.match(missingMetadataResult.stderr, /BACKUP_COS_SIZE_MISMATCH[^\n]*remote=missing[^\n]*attempts=8/u);
  assert.equal((await readFile(counterPath, "utf8")).trim(), "8");
});

test("backup publishes an atomic sanitized current record and immutable history entry", async (context) => {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "ai-project-os-backup-status-"));
  context.after(async () => {
    await rm(temporaryDirectory, { force: true, recursive: true });
  });
  const statusRoot = path.join(temporaryDirectory, "backups");
  const historyRoot = path.join(statusRoot, "history");
  await mkdir(historyRoot, { recursive: true });

  const backup = await readFile(backupPath, "utf8");
  const functionStart = backup.indexOf("timer_next_at()");
  const functionEnd = backup.indexOf("\nresume_writers()", functionStart);
  assert.notEqual(functionStart, -1);
  assert.notEqual(functionEnd, -1);
  const statusFunctions = backup.slice(functionStart, functionEnd);
  const harnessPath = path.join(temporaryDirectory, "publish-status.sh");
  const archiveObject = "cos://ai-project-os-backup-1306016679/production/backups/2026/09/02/20260902T032000Z-daily.Abc123/20260902T032000Z-daily.Abc123.tar.age";
  await writeFile(harnessPath, `#!/usr/bin/env bash
set -Eeuo pipefail
readonly PUBLIC_STATUS_ROOT=${JSON.stringify(statusRoot)}
readonly PUBLIC_HISTORY_ROOT=${JSON.stringify(historyRoot)}
readonly PUBLIC_CURRENT_FILE=${JSON.stringify(path.join(statusRoot, "current.json"))}
readonly PUBLIC_HISTORY_MAX=120
readonly MODE=daily
readonly TARGET_TAG=
PUBLIC_STATUS_ACTIVE=1
PUBLIC_STATUS_FINALIZED=0
PUBLIC_RUN_ID=20260902T032000Z-4321
PUBLIC_STARTED_AT=2026-09-02T03:20:00+08:00
PUBLIC_STARTED_EPOCH=$(date +%s)
PUBLIC_FAILURE_CODE_FILE=${JSON.stringify(path.join(statusRoot, ".failure"))}
PUBLIC_BACKUP_NAME=20260902T032000Z-daily.Abc123
PUBLIC_ARCHIVE_OBJECT=${JSON.stringify(archiveObject)}
PUBLIC_ARCHIVE_SHA256=${"b".repeat(64)}
PUBLIC_ARCHIVE_BYTES=2058936
PUBLIC_VERIFICATION_ATTEMPTS=4
RETENTION_REMOVED=1
printf 'BACKUP_UNEXPECTED_FAILURE\n' > "$PUBLIC_FAILURE_CODE_FILE"
${statusFunctions}
publish_public_status running
finish_public_status succeeded
`, { mode: 0o700 });

  const result = spawnSync("bash", [harnessPath], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const currentPath = path.join(statusRoot, "current.json");
  const historyPath = path.join(historyRoot, "20260902T032000Z-4321.json");
  const currentRaw = await readFile(currentPath, "utf8");
  const historyRaw = await readFile(historyPath, "utf8");
  const current = JSON.parse(currentRaw) as Record<string, unknown>;
  assert.equal(current.state, "succeeded");
  assert.equal(current.trigger, "daily");
  assert.equal(current.archiveObject, archiveObject);
  assert.equal(current.archiveBytes, 2_058_936);
  assert.equal(current.verificationAttempts, 4);
  assert.equal(current.retentionRemoved, 1);
  assert.equal(current.errorCode, null);
  assert.equal(historyRaw, currentRaw);
  assert.equal((await stat(currentPath)).mode & 0o777, 0o644);
  assert.equal((await stat(historyPath)).mode & 0o777, 0o644);
  assert.doesNotMatch(currentRaw, /SECRET|coscli|private|password/iu);
});

test("backup installer and timer are root-only, persistent, and daily", async () => {
  const installer = await readFile(backupInstallerPath, "utf8");
  const service = await readFile(backupServicePath, "utf8");
  const timer = await readFile(backupTimerPath, "utf8");

  assert.match(installer, /cos-backup\.env/u);
  assert.match(installer, /COS_BACKUP_BUCKET/u);
  assert.match(installer, /COS_BACKUP_REGION/u);
  assert.match(installer, /COS_BACKUP_PREFIX/u);
  assert.match(installer, /coscli\.yaml/u);
  assert.match(installer, /production-backup-age\.pub/u);
  assert.match(installer, /ai-project-os-operations\/backups\/history/u);
  assert.match(installer, /-m 0755/u);
  assert.match(installer, /root:root/u);
  assert.match(installer, /systemd-analyze verify/u);
  assert.match(installer, /--enable-timer/u);
  assert.match(installer, /systemctl enable --now ai-project-os-backup\.timer/u);
  assert.match(service, /ExecStart=\/usr\/local\/sbin\/ai-project-os-backup daily/u);
  assert.match(service, /NoNewPrivileges=true/u);
  assert.match(service, /ProtectSystem=full/u);
  assert.match(service, /TimeoutStartSec=2h/u);
  assert.match(timer, /OnCalendar=\*-\*-\* 03:20:00/u);
  assert.match(timer, /RandomizedDelaySec=20m/u);
  assert.match(timer, /Persistent=true/u);
});

test("production app receives only the sanitized operations directory through a read-only bind mount", async () => {
  const [override, deployment] = await Promise.all([
    readFile(productionComposeOverridePath, "utf8"),
    readFile(deploymentPath, "utf8"),
  ]);

  assert.match(override, /AI_PROJECT_OS_OPERATIONS_STATUS_ROOT: \/var\/lib\/ai-project-os-operations\/backups/u);
  assert.match(override, /source: \/var\/lib\/ai-project-os-operations\/backups/u);
  assert.match(override, /target: \/var\/lib\/ai-project-os-operations\/backups/u);
  assert.match(override, /read_only: true/u);
  assert.match(override, /create_host_path: false/u);
  assert.doesNotMatch(override, /docker\.sock|ai-project-os-backup\/staging|coscli\.yaml|cos-backup\.env|production-backup-age/u);
  assert.match(deployment, /compose\.operations\.yaml/u);
  assert.match(deployment, /--file "\$PRODUCTION_COMPOSE_OVERRIDE"/u);
});

test("installer keeps secrets root-only and installs a restricted Actions key", async () => {
  const installer = await readFile(installerPath, "utf8");
  const sudoers = await readFile(sudoersPath, "utf8");

  assert.match(installer, /install -o root -g root -m 0600 "\$LEGACY_ENV" "\$PRODUCTION_ENV"/u);
  assert.match(installer, /restrict,command=/u);
  assert.match(installer, /TARGET_USER=ai-project-os-actions/u);
  assert.match(installer, /useradd/u);
  assert.match(installer, /ai-project-os-actions-gateway/u);
  assert.match(installer, /ai-project-os-configure-github-oauth/u);
  assert.match(installer, /INSTALL_ACTIONS_AUTHORIZED_KEYS_NOT_EXCLUSIVE/u);
  assert.match(installer, /temporary_authorized_keys/u);
  assert.match(installer, /--reuse-existing-actions-key/u);
  assert.match(installer, /INSTALL_EXISTING_ACTIONS_KEY_INVALID/u);
  assert.match(installer, /visudo -cf/u);
  assert.deepEqual(sudoers.trim().split("\n"), [
    "ai-project-os-actions ALL=(root) NOPASSWD: /usr/local/sbin/ai-project-os-deploy",
    "ai-project-os-actions ALL=(root) NOPASSWD: /usr/local/sbin/ai-project-os-configure-github-oauth",
  ]);
});

test("production shell entrypoints pass bash syntax validation", () => {
  const additionalScripts = [
    "ai-project-os-activate-host",
    "ai-project-os-deactivate-host",
    "ai-project-os-restore",
    "ai-project-os-source-state",
    "bootstrap-production-host",
    "migrate-production-host",
  ].map((name) => path.join(repositoryRoot, "deploy/production", name));
  for (const scriptPath of [deploymentPath, backupPath, gatewayPath, githubOAuthConfiguratorPath, installerPath, backupInstallerPath, ...additionalScripts]) {
    const result = spawnSync("bash", ["-n", scriptPath], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
});
