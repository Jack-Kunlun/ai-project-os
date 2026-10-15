import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm as removeDirectory, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("stable backup validation preserves historical archives and requires email configuration", () => {
  const result = execFileSync("python3", ["-I", "-B", "-c", String.raw`
import contextlib, importlib.util, io, json, pathlib, tarfile, tempfile, sys
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("artifact", "deploy/production/ai_project_os_backup_artifact.py")
artifact = importlib.util.module_from_spec(spec)
spec.loader.exec_module(artifact)
name = "20261015T040000Z-pre-deploy-to-v1.0.2.abc123"
for version in ("v1.0.1", "v1.0.2", "v1.0.3", "v1.1.0", "v2.0.0"):
    assert artifact.BACKUP_NAME.fullmatch(name.replace("v1.0.2", version))
for version in ("v0.9.9", "v1.0.03", "v1.0.3-rc.1"):
    assert not artifact.BACKUP_NAME.fullmatch(name.replace("v1.0.2", version))
with tempfile.TemporaryDirectory() as temporary:
    root = pathlib.Path(temporary)
    def archive(label, files):
        path = root / label
        with tarfile.open(path, "w:gz") as output:
            for filename in sorted(files):
                item = tarfile.TarInfo(filename)
                item.size = 4
                item.mode = 0o600
                output.addfile(item, io.BytesIO(b"test"))
        return path
    legacy = archive("legacy.tar.gz", artifact.HOST_CONFIG_FILES)
    current = archive("current.tar.gz", artifact.HOST_CONFIG_FILES | {"etc/ai-project-os/email-auth.env"})
    unexpected = archive("unexpected.tar.gz", artifact.HOST_CONFIG_FILES | {"etc/unexpected-secret"})
    artifact.validate_host_config(legacy)
    artifact.validate_host_config(current)
    artifact.validate_host_config(current, require_email=True)
    for path, required in ((legacy, True), (unexpected, False)):
        try:
            artifact.validate_host_config(path, require_email=required)
        except SystemExit as error:
            assert str(error) == "BACKUP_HOST_CONFIG_LAYOUT_INVALID"
        else:
            raise AssertionError("invalid host-config archive admitted")

    def add_tar(path, files):
        with tarfile.open(path, "w:gz") as output:
            for filename, content in sorted(files.items()):
                item = tarfile.TarInfo(filename)
                item.size = len(content)
                item.mode = 0o600
                output.addfile(item, io.BytesIO(content))

    def extracted_backup(version, include_email):
        backup_name = "20261015T040000Z-pre-deploy-to-" + version + ".abc123"
        extracted = root / ("extracted-" + version + "-" + str(include_email))
        backup_root = extracted / backup_name
        backup_root.mkdir(parents=True)
        (backup_root / "postgres.dump").write_bytes(b"fixture-dump")
        add_tar(backup_root / "secrets.tar.gz", {"master.key": b"fixture-master-key"})
        add_tar(backup_root / "uploads.tar.gz", {"asset.bin": b"fixture-upload"})
        host_files = artifact.HOST_CONFIG_FILES | (
            {"etc/ai-project-os/email-auth.env"} if include_email else set())
        add_tar(backup_root / "host-config.tar.gz", {
            filename: b"fixture-host-config" for filename in host_files
        })
        (backup_root / "backup-metadata.env").write_text("\n".join([
            "format_version=2",
            "created_at=2026-10-15T04:00:00Z",
            "reason=pre-deploy",
            "compose_project=ai-project-os",
            "writers_quiesced=true",
            "cos_region=ap-hongkong",
            "app_version=" + version[1:],
            "backup_name=" + backup_name,
            "source_quiesced=true",
            "",
        ]))
        files = artifact.PORTABLE_FILES - {"SHA256SUMS"}
        (backup_root / "SHA256SUMS").write_text("".join(
            artifact.sha256_file(backup_root / filename) + "  " + filename + "\n"
            for filename in sorted(files)
        ))
        return extracted

    with contextlib.redirect_stdout(io.StringIO()):
        for version in ("v1.0.2", "v1.0.3", "v2.0.0"):
            artifact.validate_extracted(extracted_backup(version, include_email=True))
            missing = extracted_backup(version, include_email=False)
            try:
                artifact.validate_extracted(missing)
            except SystemExit as error:
                assert str(error) == "BACKUP_HOST_CONFIG_LAYOUT_INVALID"
            else:
                raise AssertionError("stable backup without email authentication admitted")
        artifact.validate_extracted(extracted_backup("v0.7.3", include_email=False))

    manifest = {"formatVersion": 2, "backupName": name, "createdAt": "2026-10-15T04:00:00Z",
      "appVersion": "1.0.0", "archiveObject": "cos://ai-project-os-backup-123/production/backups/2026/10/15/" + name + "/" + name + ".tar.age",
      "archiveSha256": "a" * 64, "archiveBytes": 10, "sourceQuiesced": True}
    manifest["checksumObject"] = manifest["archiveObject"] + ".sha256"
    path = root / "manifest.json"
    path.write_text(json.dumps(manifest))
    assert artifact.load_manifest(path) == manifest
print("STABLE_BACKUP_ARTIFACT_OK")
`], { encoding: "utf8" });
  assert.equal(result.trim(), "STABLE_BACKUP_ARTIFACT_OK");
});

test("the stopped-writer backup target accepts stable releases and includes protected email configuration", async () => {
  const source = await readFile("deploy/production/ai-project-os-backup", "utf8");
  assert.equal(execFileSync("bash", ["-n", "deploy/production/ai-project-os-backup"], { encoding: "utf8" }), "");
  assert.match(source, /TARGET_TAG" =~ \^v\[1-9\]\[0-9\]\*\\\.\(0\|\[1-9\]\[0-9\]\*\)\\\.\(0\|\[1-9\]\[0-9\]\*\)\$/u);
  assert.match(source, /AI_PROJECT_OS_DEPLOY_LOCK_HELD/u);
  assert.match(source, /AI_PROJECT_OS_CUTOVER_LOCK_HELD/u);
  assert.match(source, /require_root_owned_file "\$EMAIL_AUTH_ENV_FILE" 600/u);
  assert.match(source, /BACKUP_EMAIL_AUTH_CONFIGURATION_MISSING/u);
  assert.match(source, /install -o root -g root -m 0600 "\$EMAIL_AUTH_ENV_FILE"/u);
});

test("local retention recognizes future stable archives and only removes expired verified backups above the minimum", async () => {
  const source = await readFile("deploy/production/ai-project-os-backup", "utf8");
  const functionStart = source.indexOf("cleanup_verified_local_backups() {");
  const functionEnd = source.indexOf("\n}\n\nif [[ $EUID", functionStart);
  assert.notEqual(functionStart, -1, "cleanup function should exist in the production backup script");
  assert.notEqual(functionEnd, -1, "cleanup function should end before the root check");
  let cleanupFunction = source.slice(functionStart, functionEnd + 2);

  const bashVersion = execFileSync("bash", ["--version"], { encoding: "utf8" });
  const bashMajor = Number(bashVersion.match(/version (\d+)/u)?.[1]);
  assert.ok(Number.isFinite(bashMajor), "bash version should be detectable");
  if (bashMajor < 4) {
    // macOS Bash 3.2 has no mapfile; this fixture has one expired candidate, so use its equivalent read loop.
    const mapfileLine = '  mapfile -t expired_backups < <(printf \'%s\\n\' "${expired_backups[@]}" | sort)';
    const bash3ReadLoop = [
      "  local -a sorted_expired_backups=()",
      '  while IFS= read -r sorted_path; do sorted_expired_backups+=("$sorted_path"); done < <(printf \'%s\\n\' "${expired_backups[@]}" | sort)',
      '  expired_backups=("${sorted_expired_backups[@]}")',
    ].join("\n");
    assert.ok(cleanupFunction.includes(mapfileLine), "expected production mapfile line for Bash 3 fixture adaptation");
    cleanupFunction = cleanupFunction.replace(mapfileLine, bash3ReadLoop);
  }

  const root = await mkdtemp(join(tmpdir(), "ai-project-os-stable-retention-"));
  try {
    const currentStable = "20261015T043210Z-pre-deploy-to-v1.0.2.a1B2c3";
    const expiredFutureStable = "20261014T043210Z-pre-deploy-to-v1.0.3.b2C3d4";
    const malformedStable = "20261010T043210Z-pre-deploy-to-v1.0.03.c3D4e5";
    const unverifiedFutureStable = "20261009T043210Z-pre-deploy-to-v1.0.4.d4E5f6";
    const backupRoot = join(root, "backups");
    const removedLog = join(root, "removed-paths.txt");
    await mkdir(backupRoot);

    for (const [name, markerContent] of [
      [currentStable, "status=COS_UPLOAD_VERIFIED\n"],
      [expiredFutureStable, "status=COS_UPLOAD_VERIFIED\n"],
      [malformedStable, "status=COS_UPLOAD_VERIFIED\n"],
      [unverifiedFutureStable, "status=UPLOAD_PENDING\n"],
    ] as const) {
      const directory = join(backupRoot, name);
      await mkdir(directory);
      await writeFile(join(directory, ".cos-upload-verified"), markerContent, { mode: 0o600 });
    }

    const shell = [
      "set -euo pipefail",
      'BACKUP_ROOT="$TEST_BACKUP_ROOT"',
      'CURRENT_BACKUP="$TEST_CURRENT_BACKUP"',
      'REMOVED_LOG="$TEST_REMOVED_LOG"',
      "RETENTION_REMOVED=0",
      "date() { printf '2000000000\\n'; }",
      [
        "stat() {",
        '  case "$2" in',
        "    %U:%G) printf 'root:root' ;;",
        "    %a) printf '600' ;;",
        "    %Y)",
        '      case "$3" in',
        "        *v1.0.2*) printf '2000000000' ;;",
        "        *v1.0.3*) printf '1900000000' ;;",
        "        *) printf '1900000000' ;;",
        "      esac ;;",
        "    *) return 1 ;;",
        "  esac",
        "}",
      ].join("\n"),
      [
        "rm() {",
        "  local argument last_argument=",
        '  for argument in "$@"; do last_argument=$argument; done',
        '  printf \'%s\\n\' "$last_argument" >> "$REMOVED_LOG"',
        "}",
      ].join("\n"),
      "fail() { printf '%s\\n' \"$1\" >&2; exit 75; }",
      cleanupFunction,
      'cleanup_verified_local_backups "$CURRENT_BACKUP" 10 1',
      'printf "RETENTION_REMOVED=%s\\n" "$RETENTION_REMOVED"',
    ].join("\n");

    const output = execFileSync("bash", ["-c", shell], {
      encoding: "utf8",
      env: {
        ...process.env,
        TEST_BACKUP_ROOT: backupRoot,
        TEST_CURRENT_BACKUP: join(backupRoot, currentStable),
        TEST_REMOVED_LOG: removedLog,
      },
    });
    const removedPaths = (await readFile(removedLog, "utf8")).trim().split("\n");

    assert.match(output, /RETENTION_REMOVED=1\n/u);
    assert.deepEqual(removedPaths, [join(backupRoot, expiredFutureStable)]);
  } finally {
    await removeDirectory(root, { recursive: true, force: true });
  }
});
