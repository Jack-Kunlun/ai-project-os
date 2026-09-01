import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  assetBlobStorageKey,
  ProjectAssetStorageError,
  removeAssetBlob,
  writeAssetBlob,
} from "../src/lib/project-assets/storage";

async function withAssetRoot<T>(work: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-project-os-asset-storage-"));
  const previous = process.env.AI_PROJECT_OS_ASSET_DIR;
  process.env.AI_PROJECT_OS_ASSET_DIR = root;
  try {
    return await work(root);
  } finally {
    if (previous === undefined) delete process.env.AI_PROJECT_OS_ASSET_DIR;
    else process.env.AI_PROJECT_OS_ASSET_DIR = previous;
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  }
}

test("removeAssetBlob ignores ENOENT and safely removes empty UUID parents", async () => {
  await withAssetRoot(async (root) => {
    const projectId = randomUUID();
    const assetId = randomUUID();
    const versionId = randomUUID();
    const key = await writeAssetBlob({ projectId, assetId, versionId, buffer: Buffer.from("blob") });
    await removeAssetBlob(key);
    await assert.rejects(() => stat(path.join(root, key)), { code: "ENOENT" });
    await assert.rejects(() => stat(path.join(root, projectId)), { code: "ENOENT" });
    await removeAssetBlob(key);
  });
});

test("removeAssetBlob removes a deterministic temporary upload artifact", async () => {
  await withAssetRoot(async (root) => {
    const key = assetBlobStorageKey(randomUUID(), randomUUID(), randomUUID());
    const temporary = path.join(root, `${key}.tmp`);
    await mkdir(path.dirname(temporary), { recursive: true });
    await import("node:fs/promises").then(({ writeFile }) => writeFile(temporary, "partial"));
    await removeAssetBlob(key);
    await assert.rejects(() => stat(temporary), { code: "ENOENT" });
  });
});

test("removeAssetBlob reports non-ENOENT filesystem failures", async () => {
  await withAssetRoot(async (root) => {
    const key = assetBlobStorageKey(randomUUID(), randomUUID(), randomUUID());
    await mkdir(path.join(root, key), { recursive: true });
    await assert.rejects(() => removeAssetBlob(key), (error: unknown) =>
      error instanceof ProjectAssetStorageError && error.code === "ASSET_STORAGE_UNAVAILABLE",
    );
  });
});

test("removeAssetBlob leaves non-empty parents in place", async () => {
  await withAssetRoot(async (root) => {
    const projectId = randomUUID();
    const assetId = randomUUID();
    const versionId = randomUUID();
    const key = await writeAssetBlob({ projectId, assetId, versionId, buffer: Buffer.from("blob") });
    const versionDirectory = path.dirname(path.join(root, key));
    await import("node:fs/promises").then(({ writeFile }) => writeFile(path.join(versionDirectory, "keep.txt"), "keep"));
    await removeAssetBlob(key);
    assert.deepEqual(await readdir(versionDirectory), ["keep.txt"]);
  });
});

test("writeAssetBlob does not hide cleanup failure after a failed rename", async () => {
  await withAssetRoot(async (root) => {
    const projectId = randomUUID();
    const assetId = randomUUID();
    const versionId = randomUUID();
    const key = assetBlobStorageKey(projectId, assetId, versionId);
    await mkdir(path.join(root, key), { recursive: true });
    await assert.rejects(
      () => writeAssetBlob({ projectId, assetId, versionId, buffer: Buffer.from("blob") }),
      (error: unknown) => error instanceof ProjectAssetStorageError && error.code === "ASSET_STORAGE_UNAVAILABLE",
    );
    const files = await readdir(path.dirname(path.join(root, key)));
    assert.deepEqual(files, ["original"]);
  });
});
