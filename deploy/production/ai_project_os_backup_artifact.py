#!/usr/bin/env python3
"""Validate portable AI Project OS backup manifests and decrypted artifacts."""

from __future__ import annotations

import hashlib
import json
import re
import sys
import tarfile
from pathlib import Path, PurePosixPath


BACKUP_NAME = re.compile(
    r"^[0-9]{8}T[0-9]{6}Z-(?:daily|manual|pre-deploy-to-v[0-9]+\.[0-9]+\.[0-9]+)\.[A-Za-z0-9]{6}$"
)
APP_VERSION = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$")
COS_OBJECT = re.compile(r"^cos://ai-project-os-backup-[0-9]+/[A-Za-z0-9][A-Za-z0-9._/-]{1,2000}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
ISO_DATETIME = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:Z|[+-][0-9]{2}:[0-9]{2})$")
MAX_MEMBERS = 100_000
MAX_PATH_LENGTH = 1_024

PORTABLE_FILES = {
    "postgres.dump",
    "secrets.tar.gz",
    "uploads.tar.gz",
    "host-config.tar.gz",
    "backup-metadata.env",
    "SHA256SUMS",
}
HOST_CONFIG_FILES = {
    "etc/ai-project-os/production.env",
    "etc/ai-project-os/cos-backup.env",
    "etc/ai-project-os/coscli.yaml",
    "etc/ai-project-os/production-backup-age.pub",
    "etc/nginx/ssl/ai-project-os.com/fullchain.crt",
    "etc/nginx/ssl/ai-project-os.com/privkey.key",
    "bootstrap/deploy-authorized_keys",
    "bootstrap/deploy-password.hash",
    "bootstrap/github-actions.pub",
}


def fail(code: str) -> "NoReturn":
    raise SystemExit(code)


def normalized_member_name(raw_name: str) -> str:
    if len(raw_name) == 0 or len(raw_name) > MAX_PATH_LENGTH or "\x00" in raw_name:
        fail("BACKUP_ARCHIVE_PATH_INVALID")
    while raw_name.startswith("./"):
        raw_name = raw_name[2:]
    path = PurePosixPath(raw_name)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        fail("BACKUP_ARCHIVE_PATH_INVALID")
    return str(path)


def safe_tar_members(archive_path: Path, mode: str) -> list[tuple[str, bool]]:
    members: list[tuple[str, bool]] = []
    seen: set[str] = set()
    try:
        with tarfile.open(archive_path, mode) as archive:
            for index, member in enumerate(archive):
                if index >= MAX_MEMBERS:
                    fail("BACKUP_ARCHIVE_MEMBER_LIMIT_EXCEEDED")
                name = normalized_member_name(member.name)
                if name in seen:
                    fail("BACKUP_ARCHIVE_DUPLICATE_PATH")
                if not (member.isfile() or member.isdir()):
                    fail("BACKUP_ARCHIVE_MEMBER_TYPE_INVALID")
                seen.add(name)
                members.append((name, member.isdir()))
    except (tarfile.TarError, OSError):
        fail("BACKUP_ARCHIVE_INVALID")
    return members


def load_manifest(path: Path) -> dict[str, object]:
    try:
        raw = path.read_bytes()
        if len(raw) < 2 or len(raw) > 32 * 1024:
            fail("BACKUP_MANIFEST_SIZE_INVALID")
        value = json.loads(raw)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        fail("BACKUP_MANIFEST_INVALID")
    expected = {
        "formatVersion",
        "backupName",
        "createdAt",
        "appVersion",
        "archiveObject",
        "checksumObject",
        "archiveSha256",
        "archiveBytes",
        "sourceQuiesced",
    }
    if not isinstance(value, dict) or set(value) != expected:
        fail("BACKUP_MANIFEST_SCHEMA_INVALID")
    if value["formatVersion"] != 2:
        fail("BACKUP_MANIFEST_VERSION_UNSUPPORTED")
    backup_name = value["backupName"]
    created_at = value["createdAt"]
    app_version = value["appVersion"]
    archive_object = value["archiveObject"]
    checksum_object = value["checksumObject"]
    archive_sha256 = value["archiveSha256"]
    archive_bytes = value["archiveBytes"]
    source_quiesced = value["sourceQuiesced"]
    if not isinstance(backup_name, str) or BACKUP_NAME.fullmatch(backup_name) is None:
        fail("BACKUP_MANIFEST_NAME_INVALID")
    if not isinstance(created_at, str) or ISO_DATETIME.fullmatch(created_at) is None:
        fail("BACKUP_MANIFEST_CREATED_AT_INVALID")
    if not isinstance(app_version, str) or APP_VERSION.fullmatch(app_version) is None:
        fail("BACKUP_MANIFEST_APP_VERSION_INVALID")
    if not isinstance(archive_object, str) or COS_OBJECT.fullmatch(archive_object) is None:
        fail("BACKUP_MANIFEST_ARCHIVE_OBJECT_INVALID")
    if not archive_object.endswith(f"/{backup_name}/{backup_name}.tar.age"):
        fail("BACKUP_MANIFEST_ARCHIVE_OBJECT_INVALID")
    if not isinstance(checksum_object, str) or checksum_object != f"{archive_object}.sha256":
        fail("BACKUP_MANIFEST_CHECKSUM_OBJECT_INVALID")
    if not isinstance(archive_sha256, str) or SHA256.fullmatch(archive_sha256) is None:
        fail("BACKUP_MANIFEST_SHA256_INVALID")
    if not isinstance(archive_bytes, int) or isinstance(archive_bytes, bool) or archive_bytes < 1:
        fail("BACKUP_MANIFEST_BYTES_INVALID")
    if not isinstance(source_quiesced, bool):
        fail("BACKUP_MANIFEST_QUIESCE_STATE_INVALID")
    return value


def manifest_values(path: Path) -> None:
    value = load_manifest(path)
    for key in (
        "backupName",
        "createdAt",
        "appVersion",
        "archiveObject",
        "checksumObject",
        "archiveSha256",
        "archiveBytes",
        "sourceQuiesced",
    ):
        item = value[key]
        print(str(item).lower() if isinstance(item, bool) else item)


def validate_outer_archive(path: Path) -> None:
    members = safe_tar_members(path, "r|")
    roots = {name.split("/", 1)[0] for name, _ in members}
    if len(roots) != 1:
        fail("BACKUP_ARCHIVE_ROOT_INVALID")
    backup_name = next(iter(roots))
    if BACKUP_NAME.fullmatch(backup_name) is None:
        fail("BACKUP_ARCHIVE_ROOT_INVALID")
    files = {
        name[len(backup_name) + 1 :]
        for name, is_directory in members
        if not is_directory and name.startswith(f"{backup_name}/")
    }
    if files != PORTABLE_FILES:
        fail("BACKUP_ARCHIVE_LAYOUT_INVALID")
    unexpected_directories = {
        name for name, is_directory in members if is_directory and name != backup_name
    }
    if unexpected_directories:
        fail("BACKUP_ARCHIVE_LAYOUT_INVALID")
    print(backup_name)


def read_sha256s(path: Path) -> dict[str, str]:
    try:
        lines = path.read_text(encoding="ascii").splitlines()
    except (OSError, UnicodeDecodeError):
        fail("BACKUP_INNER_SHA256_INVALID")
    values: dict[str, str] = {}
    for line in lines:
        match = re.fullmatch(r"([0-9a-f]{64})  ([A-Za-z0-9.-]+)", line)
        if match is None or match.group(2) in values:
            fail("BACKUP_INNER_SHA256_INVALID")
        values[match.group(2)] = match.group(1)
    expected = PORTABLE_FILES - {"SHA256SUMS"}
    if set(values) != expected:
        fail("BACKUP_INNER_SHA256_INVALID")
    return values


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError:
        fail("BACKUP_INNER_FILE_MISSING")
    return digest.hexdigest()


def validate_safe_inner_tar(path: Path, require_master_key: bool = False) -> None:
    members = safe_tar_members(path, "r|gz")
    regular_files = {name for name, is_directory in members if not is_directory}
    if require_master_key and "master.key" not in regular_files:
        fail("BACKUP_MASTER_KEY_MISSING")


def validate_host_config(path: Path) -> None:
    members = safe_tar_members(path, "r|gz")
    regular_files = {name for name, is_directory in members if not is_directory}
    if regular_files != HOST_CONFIG_FILES:
        fail("BACKUP_HOST_CONFIG_LAYOUT_INVALID")


def parse_metadata(path: Path, expected_name: str) -> None:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeDecodeError):
        fail("BACKUP_METADATA_INVALID")
    values: dict[str, str] = {}
    for line in lines:
        if "=" not in line:
            fail("BACKUP_METADATA_INVALID")
        key, value = line.split("=", 1)
        if key in values or re.fullmatch(r"[a-z_]+", key) is None:
            fail("BACKUP_METADATA_INVALID")
        values[key] = value
    if set(values) != {
        "format_version",
        "created_at",
        "reason",
        "compose_project",
        "writers_quiesced",
        "cos_region",
        "app_version",
        "backup_name",
        "source_quiesced",
    }:
        fail("BACKUP_METADATA_INVALID")
    if values["format_version"] != "2" or values["compose_project"] != "ai-project-os":
        fail("BACKUP_METADATA_INVALID")
    if values["writers_quiesced"] != "true" or values["cos_region"] != "ap-hongkong":
        fail("BACKUP_METADATA_INVALID")
    if values["backup_name"] != expected_name or APP_VERSION.fullmatch(values["app_version"]) is None:
        fail("BACKUP_METADATA_INVALID")
    if values["source_quiesced"] not in {"true", "false"}:
        fail("BACKUP_METADATA_INVALID")


def validate_extracted(root: Path) -> None:
    try:
        entries = list(root.iterdir())
    except OSError:
        fail("BACKUP_EXTRACTED_ROOT_INVALID")
    if len(entries) != 1 or not entries[0].is_dir() or entries[0].is_symlink():
        fail("BACKUP_EXTRACTED_ROOT_INVALID")
    backup_root = entries[0]
    if BACKUP_NAME.fullmatch(backup_root.name) is None:
        fail("BACKUP_EXTRACTED_ROOT_INVALID")
    present = {entry.name for entry in backup_root.iterdir() if entry.is_file() and not entry.is_symlink()}
    if present != PORTABLE_FILES:
        fail("BACKUP_EXTRACTED_LAYOUT_INVALID")
    checksums = read_sha256s(backup_root / "SHA256SUMS")
    for filename, expected in checksums.items():
        if sha256_file(backup_root / filename) != expected:
            fail("BACKUP_INNER_SHA256_MISMATCH")
    validate_safe_inner_tar(backup_root / "secrets.tar.gz", require_master_key=True)
    validate_safe_inner_tar(backup_root / "uploads.tar.gz")
    validate_host_config(backup_root / "host-config.tar.gz")
    parse_metadata(backup_root / "backup-metadata.env", backup_root.name)
    print(backup_root)


def main() -> None:
    if len(sys.argv) != 3:
        fail("BACKUP_ARTIFACT_USAGE")
    command = sys.argv[1]
    path = Path(sys.argv[2])
    if command == "manifest-values":
        manifest_values(path)
    elif command == "validate-outer":
        validate_outer_archive(path)
    elif command == "validate-extracted":
        validate_extracted(path)
    elif command == "validate-host-config":
        validate_host_config(path)
    else:
        fail("BACKUP_ARTIFACT_USAGE")


if __name__ == "__main__":
    main()
