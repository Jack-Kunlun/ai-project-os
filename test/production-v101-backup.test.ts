import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("1.0.1 backup validation preserves historical archives and requires the email configuration", () => {
  const result = execFileSync("python3", ["-I", "-c", String.raw`
import importlib.util, io, json, pathlib, tarfile, tempfile
spec = importlib.util.spec_from_file_location("artifact", "deploy/production/ai_project_os_backup_artifact.py")
artifact = importlib.util.module_from_spec(spec)
spec.loader.exec_module(artifact)
name = "20261015T040000Z-pre-deploy-to-v1.0.1.abc123"
assert artifact.BACKUP_NAME.fullmatch(name)
assert not artifact.BACKUP_NAME.fullmatch(name.replace("v1.0.1", "v1.0.2"))
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
    manifest = {"formatVersion": 2, "backupName": name, "createdAt": "2026-10-15T04:00:00Z",
      "appVersion": "1.0.0", "archiveObject": "cos://ai-project-os-backup-123/production/backups/2026/10/15/" + name + "/" + name + ".tar.age",
      "archiveSha256": "a" * 64, "archiveBytes": 10, "sourceQuiesced": True}
    manifest["checksumObject"] = manifest["archiveObject"] + ".sha256"
    path = root / "manifest.json"
    path.write_text(json.dumps(manifest))
    assert artifact.load_manifest(path) == manifest
print("V101_BACKUP_ARTIFACT_OK")
`], { encoding: "utf8" });
  assert.equal(result.trim(), "V101_BACKUP_ARTIFACT_OK");
});

test("the stopped-writer backup target preserves caller locks and includes protected email configuration", async () => {
  const source = await readFile("deploy/production/ai-project-os-backup", "utf8");
  assert.equal(execFileSync("bash", ["-n", "deploy/production/ai-project-os-backup"], { encoding: "utf8" }), "");
  assert.match(source, /TARGET_TAG" == v1\.0\.1/u);
  assert.match(source, /AI_PROJECT_OS_DEPLOY_LOCK_HELD/u);
  assert.match(source, /AI_PROJECT_OS_CUTOVER_LOCK_HELD/u);
  assert.match(source, /require_root_owned_file "\$EMAIL_AUTH_ENV_FILE" 600/u);
  assert.match(source, /BACKUP_EMAIL_AUTH_CONFIGURATION_MISSING/u);
  assert.match(source, /install -o root -g root -m 0600 "\$EMAIL_AUTH_ENV_FILE"/u);
});
