import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, stat, truncate } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createProjectAssetDownloadResponse } from "../src/lib/project-assets/download-response";
import { projectAssetUploadRequest } from "../src/lib/project-assets/upload-request";
import { JpegHeaderReader } from "../src/lib/project-assets/jpeg-header";
import { assetBlobStorageKey, MAX_ASSET_PROCESSING_BYTES, ProjectAssetStorageError, readAssetBlob, streamAssetBlob, writeAssetStream } from "../src/lib/project-assets/storage";

function source(bytes: number, prefix = Buffer.from("%PDF-1.7\n")): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream({ pull(controller) {
    if (offset >= bytes) { controller.close(); return; }
    const chunk = Buffer.alloc(Math.min(64 * 1024, bytes - offset), 32);
    if (offset === 0) prefix.copy(chunk);
    offset += chunk.length;
    controller.enqueue(chunk);
  } });
}

async function fixture(run: (input: { projectId: string; assetId: string; versionId: string; root: string; key: string }) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "project-upload-stream-"));
  const previous = process.env.AI_PROJECT_OS_ASSET_DIR;
  process.env.AI_PROJECT_OS_ASSET_DIR = root;
  const ids = { projectId: randomUUID(), assetId: randomUUID(), versionId: randomUUID() };
  try { await run({ ...ids, root, key: assetBlobStorageKey(ids.projectId, ids.assetId, ids.versionId) }); }
  finally {
    if (previous === undefined) delete process.env.AI_PROJECT_OS_ASSET_DIR;
    else process.env.AI_PROJECT_OS_ASSET_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
}

test("raw browser upload preserves the File without copying or MIME dependence", () => {
  const file = new File(["%PDF-1.7"], "WPS report.PDF", { type: "application/wps-office.pdf" });
  const request = projectAssetUploadRequest(file);
  assert.equal(request.body, file);
  assert.equal(new Headers(request.headers).get("content-type"), "application/octet-stream");
  assert.equal(decodeURIComponent(new Headers(request.headers).get("x-asset-file-name")!), file.name);
  assert.equal(new Headers(request.headers).get("x-asset-file-size"), String(file.size));
});

test("a 40 MiB file streams to disk and downloads byte-for-byte beyond the old request cap", async () => fixture(async (input) => {
  const bytes = 40 * 1024 * 1024;
  const result = await writeAssetStream({ ...input, fileName: "large.PDF", sizeBytes: bytes, stream: source(bytes) });
  assert.equal(result.detected.mimeType, "application/pdf");
  assert.equal((await stat(path.join(input.root, input.key))).size, bytes);
  const response = createProjectAssetDownloadResponse({ fileName: "large.PDF", mimeType: result.detected.mimeType, sizeBytes: bytes, stream: await streamAssetBlob(input.key, BigInt(bytes)) });
  assert.equal(response.headers.get("content-length"), String(bytes));
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const hash = createHash("sha256");
  let read = 0;
  const reader = response.body!.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value); read += value.length;
    }
  } finally { reader.releaseLock(); }
  assert.equal(read, bytes);
  assert.equal(hash.digest("hex"), result.contentHash);
}));

test("image originals beyond 10 MiB are accepted while pixel checks remain", async () => fixture(async (input) => {
  const header = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a", "hex").copy(header);
  header.writeUInt32BE(200, 16);
  header.writeUInt32BE(100, 20);
  const bytes = 11 * 1024 * 1024;
  assert.equal((await writeAssetStream({ ...input, fileName: "large.png", sizeBytes: bytes, stream: source(bytes, header) })).detected.kind, "image");
}));

test("JPEG dimensions after large metadata work across arbitrary chunk boundaries", async () => fixture(async (input) => {
  const comment = Buffer.alloc(65537, 32);
  comment.set([0xff, 0xfe, 0xff, 0xff]); // A legal maximum-length COM segment.
  const jpeg = Buffer.concat([
    Buffer.from([0xff, 0xd8]), comment, comment,
    Buffer.from([0xff, 0xc0, 0, 11, 8, 0, 100, 0, 200, 1, 1, 0x11, 0, 0xff, 0xd9]),
  ]);
  const header = new JpegHeaderReader();
  for (let offset = 0; offset < jpeg.length; offset += 7) header.push(jpeg.subarray(offset, offset + 7));
  assert.deepEqual(header.dimensions, [200, 100]);
  const result = await writeAssetStream({ ...input, fileName: "camera.jpg", sizeBytes: jpeg.length, stream: new Blob([jpeg]).stream() });
  assert.equal(result.detected.mimeType, "image/jpeg");
  const truncated = new JpegHeaderReader();
  truncated.push(Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 100, 0, 200]));
  assert.equal(truncated.dimensions, undefined);
}));

test("a JPEG with a short or inconsistent SOF cannot bypass signature validation", async () => {
  for (const payload of [
    [0xff, 0xd8, 0xff, 0xc0, 0, 7, 8, 0, 1, 0, 1],
    [0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 1, 0, 1, 2, 1, 0x11, 0],
  ]) await fixture(async (input) => {
    const jpeg = Buffer.from(payload);
    await assert.rejects(writeAssetStream({ ...input, fileName: "broken.jpg", sizeBytes: jpeg.length, stream: new Blob([jpeg]).stream() }), (error: unknown) => error instanceof ProjectAssetStorageError && error.code === "ASSET_FILE_SIGNATURE_INVALID");
    await assert.rejects(stat(path.join(input.root, input.key)), { code: "ENOENT" });
  });
});

test("understated, truncated and aborted streams leave no committed or temporary blob", async () => {
  for (const [actual, declared] of [[100, 20], [20, 100]]) await fixture(async (input) => {
    await assert.rejects(writeAssetStream({ ...input, fileName: "report.pdf", sizeBytes: declared!, stream: source(actual!) }), (error: unknown) => error instanceof ProjectAssetStorageError && error.code === "ASSET_FILE_SIZE_MISMATCH");
    await assert.rejects(stat(path.join(input.root, input.key)), { code: "ENOENT" });
    await assert.rejects(stat(path.join(input.root, `${input.key}.tmp`)), { code: "ENOENT" });
  });
  await fixture(async (input) => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(writeAssetStream({ ...input, fileName: "report.pdf", sizeBytes: 100, stream: source(100), signal: controller.signal }), (error: unknown) => error instanceof ProjectAssetStorageError && error.code === "ASSET_UPLOAD_TIMEOUT");
    await assert.rejects(stat(path.join(input.root, input.key)), { code: "ENOENT" });
    await assert.rejects(stat(path.join(input.root, `${input.key}.tmp`)), { code: "ENOENT" });
  });
});

test("invalid signatures are removed and large stored files have an explicit processing error", async () => {
  await fixture(async (input) => {
    await assert.rejects(writeAssetStream({ ...input, fileName: "report.pdf", sizeBytes: 100, stream: source(100, Buffer.from("not-pdf")) }), (error: unknown) => error instanceof ProjectAssetStorageError && error.code === "ASSET_FILE_SIGNATURE_INVALID");
    await assert.rejects(stat(path.join(input.root, input.key)), { code: "ENOENT" });
  });
  await fixture(async (input) => {
    await writeAssetStream({ ...input, fileName: "report.pdf", sizeBytes: 100, stream: source(100) });
    await truncate(path.join(input.root, input.key), MAX_ASSET_PROCESSING_BYTES + 1);
    await assert.rejects(readAssetBlob(input.key), (error: unknown) => error instanceof ProjectAssetStorageError && error.code === "ASSET_FILE_PROCESSING_TOO_LARGE");
    assert.equal((await stat(path.join(input.root, input.key))).size, MAX_ASSET_PROCESSING_BYTES + 1);
  });
});

test("interruption after a partial write and body timeout clean up both files", async () => {
  await fixture(async (input) => {
    const controller = new AbortController();
    let cancelTimer: ReturnType<typeof setTimeout>;
    const stream = new ReadableStream<Uint8Array>({
      start(target) {
        target.enqueue(Buffer.from("%PDF-1.7\npartial"));
        cancelTimer = setTimeout(() => controller.abort(), 20);
      },
      cancel() { clearTimeout(cancelTimer); },
    });
    await assert.rejects(writeAssetStream({ ...input, fileName: "report.pdf", sizeBytes: 100, stream, signal: controller.signal }), (error: unknown) => error instanceof ProjectAssetStorageError && error.code === "ASSET_UPLOAD_TIMEOUT");
    await assert.rejects(stat(path.join(input.root, input.key)), { code: "ENOENT" });
    await assert.rejects(stat(path.join(input.root, `${input.key}.tmp`)), { code: "ENOENT" });
  });
  const previous = process.env.AI_PROJECT_OS_UPLOAD_BODY_TIMEOUT_MS;
  process.env.AI_PROJECT_OS_UPLOAD_BODY_TIMEOUT_MS = "20";
  try {
    await fixture(async (input) => {
      const stream = new ReadableStream<Uint8Array>({ start(target) { target.enqueue(Buffer.from("%PDF-1.7\npartial")); } });
      await assert.rejects(writeAssetStream({ ...input, fileName: "report.pdf", sizeBytes: 100, stream }), (error: unknown) => error instanceof ProjectAssetStorageError && error.code === "ASSET_UPLOAD_TIMEOUT");
      await assert.rejects(stat(path.join(input.root, input.key)), { code: "ENOENT" });
      await assert.rejects(stat(path.join(input.root, `${input.key}.tmp`)), { code: "ENOENT" });
    });
  } finally {
    if (previous === undefined) delete process.env.AI_PROJECT_OS_UPLOAD_BODY_TIMEOUT_MS;
    else process.env.AI_PROJECT_OS_UPLOAD_BODY_TIMEOUT_MS = previous;
  }
});
