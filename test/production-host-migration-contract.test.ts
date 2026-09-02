import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const repositoryRoot = process.cwd();
const productionRoot = path.join(repositoryRoot, "deploy/production");
const helperPath = path.join(productionRoot, "ai_project_os_backup_artifact.py");
const restorePath = path.join(productionRoot, "ai-project-os-restore");
const bootstrapPath = path.join(productionRoot, "bootstrap-production-host");
const migrationPath = path.join(productionRoot, "migrate-production-host");
const sourceStatePath = path.join(productionRoot, "ai-project-os-source-state");
const activationPath = path.join(productionRoot, "ai-project-os-activate-host");
const deactivationPath = path.join(productionRoot, "ai-project-os-deactivate-host");
const backupPath = path.join(productionRoot, "ai-project-os-backup");

function run(command: string, args: string[], cwd?: string) {
  return spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
}

async function sha256(filePath: string) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

test("host migration keeps the restored target passive until an explicit guarded activation", async () => {
  const [restore, bootstrap, migration, sourceState, activation, deactivation, backup] = await Promise.all([
    readFile(restorePath, "utf8"),
    readFile(bootstrapPath, "utf8"),
    readFile(migrationPath, "utf8"),
    readFile(sourceStatePath, "utf8"),
    readFile(activationPath, "utf8"),
    readFile(deactivationPath, "utf8"),
    readFile(backupPath, "utf8"),
  ]);

  assert.match(backup, /AI_PROJECT_OS_CUTOVER_LOCK_HELD/u);
  assert.match(backup, /KEEP_WRITERS_QUIESCED=1/u);
  assert.match(backup, /"sourceQuiesced"/u);
  assert.ok(sourceState.indexOf("systemctl disable --now nginx") < sourceState.indexOf('"$BACKUP_SCRIPT" manual'));
  assert.match(sourceState, /AI_PROJECT_OS_CUTOVER=1/u);
  assert.match(sourceState, /source-quiesced\.json/u);
  assert.match(sourceState, /SOURCE_RESUMED_OK/u);

  assert.match(restore, /RESTORE_MIGRATION_BACKUP_NOT_QUIESCED/u);
  assert.match(restore, /compose build migrate app worker/u);
  assert.match(restore, /compose up -d --no-build --force-recreate migrate app/u);
  assert.doesNotMatch(restore, /force-recreate migrate app worker/u);
  assert.match(restore, /standby=true/u);
  assert.match(bootstrap, /systemctl disable --now nginx/u);
  assert.match(bootstrap, /systemctl disable --now ai-project-os-backup\.timer/u);
  assert.match(bootstrap, /HOST_STANDBY_WORKER_RUNNING/u);

  assert.match(activation, /CONFIRM_SOURCE_REMAINS_QUIESCED/u);
  assert.match(activation, /compose up -d --no-build worker/u);
  assert.match(activation, /rollback_failed_activation/u);
  assert.ok(activation.indexOf("HOST_ACTIVATION_STACK_HEALTH_TIMEOUT") < activation.indexOf("systemctl enable --now nginx"));
  assert.ok(activation.indexOf("systemctl enable --now nginx") < activation.indexOf("systemctl enable --now ai-project-os-backup.timer"));
  assert.match(deactivation, /CONFIRM_ROLLBACK_TO_QUIESCED_SOURCE/u);
  assert.match(deactivation, /systemctl disable --now ai-project-os-backup\.timer/u);
  assert.match(deactivation, /systemctl disable --now nginx/u);
  assert.match(deactivation, /compose stop worker/u);
  assert.match(deactivation, /HOST_DEACTIVATION_OK standby=true/u);

  const sourceChecks = migration.match(/check_source_marker/g) ?? [];
  assert.ok(sourceChecks.length >= 3, "controller must define and run the source marker gate twice");
  assert.match(migration, /target-standby-health\.json/u);
  assert.match(migration, /target-tls-health\.json/u);
  assert.match(migration, /MIGRATION_ROOT_LOGIN_STILL_ALLOWED/u);
  assert.match(migration, /dnsCutoverPending/u);
  assert.doesNotMatch(migration, /secret(Key|Id).*printf|AGE-SECRET-KEY.*printf/iu);
});

test("host bootstrap pins sensitive tooling and installs root-owned runtime copies", async () => {
  const bootstrap = await readFile(bootstrapPath, "utf8");

  assert.match(bootstrap, /download\.docker\.com\/linux\/ubuntu/u);
  assert.match(bootstrap, /DOCKER_GPG_FINGERPRINT=9DC858229FC7DD38854AE2D88D81803C0EBFCD88/u);
  assert.match(bootstrap, /docker-ce docker-ce-cli containerd\.io docker-buildx-plugin docker-compose-plugin/u);
  assert.doesNotMatch(bootstrap, /get\.docker\.com|curl[^\n]*\|[^\n]*(sh|bash)/u);
  assert.match(bootstrap, /COSCLI_VERSION=v1\.0\.9/u);
  assert.match(bootstrap, /COSCLI_SHA256=a07de5ba2800147a700ed29036b0c76a4229088cee68e1682d0eae19b638a915/u);
  assert.match(bootstrap, /HOST_NOT_EMPTY_CONTAINERS_PRESENT/u);
  assert.match(bootstrap, /dockerd --validate/u);
  assert.match(bootstrap, /local:true/u);
  assert.match(bootstrap, /ufw default deny incoming/u);
  assert.match(bootstrap, /00-ai-project-os-hardening\.conf/u);
  assert.match(bootstrap, /permitrootlogin no/u);
  assert.match(bootstrap, /passwordauthentication no/u);
  assert.match(bootstrap, /install -o root -g root -m 0755/u);
});

test("portable backup validator accepts the exact v2 layout and rejects tampering", async (context) => {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "ai-project-os-portable-backup-"));
  context.after(async () => rm(temporaryDirectory, { force: true, recursive: true }));

  const backupName = "20260902T120000Z-manual.Abc123";
  const artifactRoot = path.join(temporaryDirectory, "artifact");
  const backupRoot = path.join(artifactRoot, backupName);
  const hostRoot = path.join(temporaryDirectory, "host");
  const secretsRoot = path.join(temporaryDirectory, "secrets");
  const uploadsRoot = path.join(temporaryDirectory, "uploads");
  await mkdir(backupRoot, { recursive: true });

  const hostFiles = [
    "etc/ai-project-os/production.env",
    "etc/ai-project-os/cos-backup.env",
    "etc/ai-project-os/coscli.yaml",
    "etc/ai-project-os/production-backup-age.pub",
    "etc/nginx/ssl/ai-project-os.com/fullchain.crt",
    "etc/nginx/ssl/ai-project-os.com/privkey.key",
    "bootstrap/deploy-authorized_keys",
    "bootstrap/deploy-password.hash",
    "bootstrap/github-actions.pub",
  ];
  for (const relativePath of hostFiles) {
    const filePath = path.join(hostRoot, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `fixture:${relativePath}\n`, { mode: 0o600 });
  }
  await mkdir(secretsRoot, { recursive: true });
  await mkdir(uploadsRoot, { recursive: true });
  await writeFile(path.join(secretsRoot, "master.key"), "fixture-master-key\n", { mode: 0o600 });
  await writeFile(path.join(uploadsRoot, "asset.bin"), "fixture-upload\n");

  for (const [source, archive] of [
    [hostRoot, "host-config.tar.gz"],
    [secretsRoot, "secrets.tar.gz"],
    [uploadsRoot, "uploads.tar.gz"],
  ] as const) {
    const result = run("tar", ["-C", source, "-czf", path.join(backupRoot, archive), "."]);
    assert.equal(result.status, 0, result.stderr);
  }
  await writeFile(path.join(backupRoot, "postgres.dump"), "fixture-postgres-dump\n");
  await writeFile(
    path.join(backupRoot, "backup-metadata.env"),
    [
      "format_version=2",
      "created_at=2026-09-02T20:00:00+08:00",
      "reason=manual",
      "compose_project=ai-project-os",
      "writers_quiesced=true",
      "cos_region=ap-hongkong",
      "app_version=5.1.2",
      `backup_name=${backupName}`,
      "source_quiesced=true",
      "",
    ].join("\n"),
  );
  const checksummedFiles = [
    "postgres.dump",
    "secrets.tar.gz",
    "uploads.tar.gz",
    "host-config.tar.gz",
    "backup-metadata.env",
  ];
  const checksumLines = [];
  for (const filename of checksummedFiles) {
    checksumLines.push(`${await sha256(path.join(backupRoot, filename))}  ${filename}`);
  }
  await writeFile(path.join(backupRoot, "SHA256SUMS"), `${checksumLines.join("\n")}\n`);

  const decryptedTar = path.join(temporaryDirectory, "backup.tar");
  const tarResult = run("tar", ["-C", artifactRoot, "-cf", decryptedTar, backupName]);
  assert.equal(tarResult.status, 0, tarResult.stderr);
  const manifestPath = path.join(temporaryDirectory, "latest.json");
  const archiveObject = `cos://ai-project-os-backup-1306016679/production/backups/2026/09/02/${backupName}/${backupName}.tar.age`;
  await writeFile(manifestPath, JSON.stringify({
    formatVersion: 2,
    backupName,
    createdAt: "2026-09-02T20:00:00+08:00",
    appVersion: "5.1.2",
    archiveObject,
    checksumObject: `${archiveObject}.sha256`,
    archiveSha256: "a".repeat(64),
    archiveBytes: 1234,
    sourceQuiesced: true,
  }));

  const manifestResult = run("python3", [helperPath, "manifest-values", manifestPath]);
  assert.equal(manifestResult.status, 0, manifestResult.stderr);
  assert.match(manifestResult.stdout, /\ntrue\n$/u);
  const outerResult = run("python3", [helperPath, "validate-outer", decryptedTar]);
  assert.equal(outerResult.status, 0, outerResult.stderr);
  assert.equal(outerResult.stdout.trim(), backupName);
  const extractedResult = run("python3", [helperPath, "validate-extracted", artifactRoot]);
  assert.equal(extractedResult.status, 0, extractedResult.stderr);

  await writeFile(path.join(backupRoot, "postgres.dump"), "tampered\n");
  const tamperedResult = run("python3", [helperPath, "validate-extracted", artifactRoot]);
  assert.notEqual(tamperedResult.status, 0);
  assert.match(tamperedResult.stderr, /BACKUP_INNER_SHA256_MISMATCH/u);
});

test("migration controller dry-run validates its complete local input bundle without network mutation", async (context) => {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "ai-project-os-migration-dry-run-"));
  context.after(async () => rm(temporaryDirectory, { force: true, recursive: true }));
  const rootIdentity = path.join(temporaryDirectory, "root-key");
  const deployIdentity = path.join(temporaryDirectory, "deploy-key");
  for (const identity of [rootIdentity, deployIdentity]) {
    const keyResult = run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", identity]);
    assert.equal(keyResult.status, 0, keyResult.stderr);
  }
  const publicKey = (await readFile(`${rootIdentity}.pub`, "utf8")).trim().split(/\s+/u).slice(0, 2).join(" ");
  const knownHosts = path.join(temporaryDirectory, "known_hosts");
  const cosConfig = path.join(temporaryDirectory, "coscli.yaml");
  const ageIdentity = path.join(temporaryDirectory, "age.key");
  await writeFile(knownHosts, `8.8.8.8 ${publicKey}\n1.1.1.1 ${publicKey}\n`, { mode: 0o600 });
  await writeFile(cosConfig, "secret_id: fixture-id\nsecret_key: fixture-key\n", { mode: 0o600 });
  await writeFile(ageIdentity, "AGE-SECRET-KEY-1ABCDEFGHIJKLMNOPQRSTUVWXYZ234567\n", { mode: 0o600 });
  await chmod(rootIdentity, 0o600);
  await chmod(deployIdentity, 0o600);

  const result = run("bash", [
    migrationPath,
    "--source-host", "8.8.8.8",
    "--target-host", "1.1.1.1",
    "--release-tag", "v5.1.2",
    "--revision", "a".repeat(40),
    "--manifest-object", "cos://ai-project-os-backup-1306016679/production/manifests/latest.json",
    "--root-identity", rootIdentity,
    "--deploy-identity", deployIdentity,
    "--known-hosts", knownHosts,
    "--cos-read-config", cosConfig,
    "--age-identity", ageIdentity,
    "--target-hostname", "ai-project-os-prod-hk-02",
    "--evidence-dir", path.join(temporaryDirectory, "evidence"),
    "--dry-run",
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /MIGRATION_BUNDLE_READY/u);
  assert.match(result.stdout, /MIGRATION_DRY_RUN_OK mutations=none/u);
  assert.doesNotMatch(result.stdout, /fixture-(?:id|key)|AGE-SECRET-KEY/u);
});
