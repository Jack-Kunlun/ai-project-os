import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProjectAssetKind } from "@prisma/client";
import { DEFAULT_UPLOAD_POLICY, getUploadPolicy } from "@/lib/project-assets/policy";

export const MAX_ASSET_FILE_BYTES = DEFAULT_UPLOAD_POLICY.maxFileBytes;
export const MAX_IMAGE_FILE_BYTES = DEFAULT_UPLOAD_POLICY.maxImageBytes;
export const MAX_UPLOAD_FILES = DEFAULT_UPLOAD_POLICY.maxFiles;
export const MAX_UPLOAD_REQUEST_BYTES = DEFAULT_UPLOAD_POLICY.maxRequestBytes;
export const MAX_IMAGE_PIXELS = 20_000_000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STORAGE_KEY_PATTERN = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/original$/i;
const TEXT_EXTENSIONS = new Set([".txt", ".md", ".markdown", ".csv", ".json"]);

export type DetectedAssetFile = Readonly<{
  kind: ProjectAssetKind;
  mimeType: string;
  extension: string;
}>;

export class ProjectAssetStorageError extends Error {
  constructor(readonly code:
    | "ASSET_FILE_EMPTY"
    | "ASSET_FILE_TOO_LARGE"
    | "ASSET_FILE_TYPE_UNSUPPORTED"
    | "ASSET_FILE_SIGNATURE_INVALID"
    | "ASSET_IMAGE_TOO_LARGE"
    | "ASSET_STORAGE_INVALID_KEY"
    | "ASSET_STORAGE_UNAVAILABLE") {
    super(code);
    this.name = "ProjectAssetStorageError";
  }
}

function fail(code: ProjectAssetStorageError["code"]): never {
  throw new ProjectAssetStorageError(code);
}

function hasPrefix(buffer: Buffer, signature: readonly number[]): boolean {
  return signature.every((value, index) => buffer[index] === value);
}

function isZip(buffer: Buffer): boolean {
  return hasPrefix(buffer, [0x50, 0x4b, 0x03, 0x04]) ||
    hasPrefix(buffer, [0x50, 0x4b, 0x05, 0x06]) ||
    hasPrefix(buffer, [0x50, 0x4b, 0x07, 0x08]);
}

function isPdf(buffer: Buffer): boolean {
  return buffer.subarray(0, 5).toString("ascii") === "%PDF-";
}

function imageMime(buffer: Buffer): "image/png" | "image/jpeg" | "image/webp" | null {
  if (hasPrefix(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (hasPrefix(buffer, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  return null;
}

function pngDimensions(buffer: Buffer): readonly [number, number] | null {
  if (buffer.length < 24 || imageMime(buffer) !== "image/png") return null;
  return [buffer.readUInt32BE(16), buffer.readUInt32BE(20)] as const;
}

function jpegDimensions(buffer: Buffer): readonly [number, number] | null {
  if (imageMime(buffer) !== "image/jpeg") return null;
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) return null;
    const marker = buffer[offset + 1];
    if (marker === undefined) return null;
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > buffer.length) return null;
    if (marker >= 0xc0 && marker <= 0xc3) {
      return [buffer.readUInt16BE(offset + 7), buffer.readUInt16BE(offset + 5)] as const;
    }
    offset += 2 + length;
  }
  return null;
}

function webpDimensions(buffer: Buffer): readonly [number, number] | null {
  if (buffer.length < 30 || imageMime(buffer) !== "image/webp") return null;
  const chunk = buffer.subarray(12, 16).toString("ascii");
  if (chunk === "VP8X") {
    const width = 1 + buffer.readUIntLE(24, 3);
    const height = 1 + buffer.readUIntLE(27, 3);
    return [width, height] as const;
  }
  if (chunk === "VP8 ") {
    const start = buffer.indexOf(Buffer.from([0x9d, 0x01, 0x2a]), 20);
    if (start < 0 || start + 7 > buffer.length) return null;
    return [buffer.readUInt16LE(start + 3) & 0x3fff, buffer.readUInt16LE(start + 5) & 0x3fff] as const;
  }
  if (chunk === "VP8L" && buffer[20] === 0x2f) {
    const bits = buffer.readUInt32LE(21);
    return [(bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1] as const;
  }
  return null;
}

function assertImageDimensions(buffer: Buffer, mimeType: string): void {
  const dimensions = mimeType === "image/png"
    ? pngDimensions(buffer)
    : mimeType === "image/jpeg"
      ? jpegDimensions(buffer)
      : webpDimensions(buffer);
  if (dimensions === null) return fail("ASSET_FILE_SIGNATURE_INVALID");
  const [width, height] = dimensions;
  if (width <= 0 || height <= 0 || width * height > MAX_IMAGE_PIXELS) return fail("ASSET_IMAGE_TOO_LARGE");
}

function assertUtf8Text(buffer: Buffer): void {
  if (buffer.includes(0)) return fail("ASSET_FILE_SIGNATURE_INVALID");
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return fail("ASSET_FILE_SIGNATURE_INVALID");
  }
}

export function detectAssetFile(fileName: string, buffer: Buffer): DetectedAssetFile {
  const policy = getUploadPolicy();
  if (buffer.length === 0) return fail("ASSET_FILE_EMPTY");
  if (buffer.length > policy.maxFileBytes) return fail("ASSET_FILE_TOO_LARGE");
  const extension = path.extname(fileName).toLowerCase();
  const detectedImageMime = imageMime(buffer);
  if (detectedImageMime !== null) {
    if (buffer.length > policy.maxImageBytes) return fail("ASSET_FILE_TOO_LARGE");
    assertImageDimensions(buffer, detectedImageMime);
    const expected = detectedImageMime === "image/png" ? ".png" : detectedImageMime === "image/jpeg" ? new Set([".jpg", ".jpeg"]) : ".webp";
    if (typeof expected === "string" ? extension !== expected : !expected.has(extension)) return fail("ASSET_FILE_SIGNATURE_INVALID");
    return Object.freeze({ kind: "image", mimeType: detectedImageMime, extension });
  }
  if (extension === ".pdf") {
    if (!isPdf(buffer)) return fail("ASSET_FILE_SIGNATURE_INVALID");
    return Object.freeze({ kind: "document", mimeType: "application/pdf", extension });
  }
  const office = {
    ".docx": ["document", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ".pptx": ["presentation", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
    ".xlsx": ["spreadsheet", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  } as const;
  if (extension in office) {
    if (!isZip(buffer)) return fail("ASSET_FILE_SIGNATURE_INVALID");
    const [kind, mimeType] = office[extension as keyof typeof office];
    return Object.freeze({ kind, mimeType, extension });
  }
  if (TEXT_EXTENSIONS.has(extension)) {
    assertUtf8Text(buffer);
    const mimeType = extension === ".md" || extension === ".markdown"
      ? "text/markdown"
      : extension === ".csv"
        ? "text/csv"
        : extension === ".json"
          ? "application/json"
          : "text/plain";
    return Object.freeze({ kind: "text", mimeType, extension });
  }
  return fail("ASSET_FILE_TYPE_UNSUPPORTED");
}

export function assetContentHash(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export function sanitizeAssetFileName(value: string): string {
  const leaf = path.basename(value.normalize("NFC")).replace(/[\u0000-\u001f\u007f]/gu, "").trim();
  const safe = leaf.replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ");
  if (safe.length === 0) return "未命名资料";
  if (safe.length <= 180) return safe;
  const extension = path.extname(safe).slice(0, 16);
  return `${safe.slice(0, Math.max(1, 180 - extension.length))}${extension}`;
}

export function assetStorageRoot(): string {
  const configured = process.env.AI_PROJECT_OS_ASSET_DIR;
  if (configured !== undefined && configured.trim().length > 0) {
    if (!path.isAbsolute(configured)) return fail("ASSET_STORAGE_UNAVAILABLE");
    return path.resolve(configured);
  }
  return process.env.NODE_ENV === "production"
    ? "/var/lib/ai-project-os/uploads"
    : path.join(process.cwd(), ".data", "uploads");
}

function storagePath(storageKey: string): string {
  if (!STORAGE_KEY_PATTERN.test(storageKey)) return fail("ASSET_STORAGE_INVALID_KEY");
  const root = path.resolve(assetStorageRoot());
  const resolved = path.resolve(root, storageKey);
  if (!resolved.startsWith(`${root}${path.sep}`)) return fail("ASSET_STORAGE_INVALID_KEY");
  return resolved;
}

function deletionStagingPaths(deletionId: string): Readonly<{ staged: string; stagingRoot: string }> {
  if (!UUID_PATTERN.test(deletionId)) return fail("ASSET_STORAGE_INVALID_KEY");
  const root = path.resolve(assetStorageRoot());
  const stagingRoot = path.resolve(root, ".project-deletions");
  const staged = path.resolve(stagingRoot, deletionId);
  if (!staged.startsWith(`${stagingRoot}${path.sep}`)) return fail("ASSET_STORAGE_INVALID_KEY");
  return Object.freeze({ staged, stagingRoot });
}

function projectStorageDeletionPaths(projectId: string, deletionId: string): Readonly<{ source: string; staged: string; stagingRoot: string }> {
  if (!UUID_PATTERN.test(projectId)) return fail("ASSET_STORAGE_INVALID_KEY");
  const root = path.resolve(assetStorageRoot());
  const source = path.resolve(root, projectId);
  if (!source.startsWith(`${root}${path.sep}`)) return fail("ASSET_STORAGE_INVALID_KEY");
  return Object.freeze({ source, ...deletionStagingPaths(deletionId) });
}

async function pathExists(location: string): Promise<boolean> {
  try {
    await stat(location);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false;
    return fail("ASSET_STORAGE_UNAVAILABLE");
  }
}

export async function stageProjectAssetStorageForDeletion(projectId: string, deletionId: string): Promise<boolean> {
  const paths = projectStorageDeletionPaths(projectId, deletionId);
  const [stagedExists, sourceExists] = await Promise.all([pathExists(paths.staged), pathExists(paths.source)]);
  if (stagedExists && sourceExists) return fail("ASSET_STORAGE_UNAVAILABLE");
  if (stagedExists) return true;
  if (!sourceExists) return false;
  try {
    await mkdir(paths.stagingRoot, { recursive: true, mode: 0o700 });
    await rename(paths.source, paths.staged);
    return true;
  } catch {
    return fail("ASSET_STORAGE_UNAVAILABLE");
  }
}

export async function restoreStagedProjectAssetStorage(projectId: string, deletionId: string): Promise<void> {
  const paths = projectStorageDeletionPaths(projectId, deletionId);
  if (!(await pathExists(paths.staged))) return;
  if (await pathExists(paths.source)) return fail("ASSET_STORAGE_UNAVAILABLE");
  try {
    await rename(paths.staged, paths.source);
  } catch {
    return fail("ASSET_STORAGE_UNAVAILABLE");
  }
}

export async function purgeStagedProjectAssetStorage(deletionId: string): Promise<void> {
  const paths = deletionStagingPaths(deletionId);
  try {
    await rm(paths.staged, { recursive: true, force: true });
    try {
      await rmdir(paths.stagingRoot);
    } catch (error) {
      if (!(typeof error === "object" && error !== null && "code" in error && (error.code === "ENOENT" || error.code === "ENOTEMPTY"))) throw error;
    }
  } catch {
    return fail("ASSET_STORAGE_UNAVAILABLE");
  }
}

export function assetBlobStorageKey(projectId: string, assetId: string, versionId: string): string {
  if (![projectId, assetId, versionId].every((value) => UUID_PATTERN.test(value))) {
    return fail("ASSET_STORAGE_INVALID_KEY");
  }
  return `${projectId}/${assetId}/${versionId}/original`;
}

async function unlinkIfPresent(location: string): Promise<void> {
  try {
    await unlink(location);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

async function removeEmptyParentDirectories(location: string): Promise<void> {
  // A storage key is root/project/asset/version/original. Stop after the
  // version, asset and project directories; never attempt to remove root.
  let directory = path.dirname(location);
  for (let level = 0; level < 3; level += 1) {
    try {
      await rmdir(directory);
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && (error.code === "ENOENT" || error.code === "ENOTEMPTY")) {
        return;
      }
      throw error;
    }
    directory = path.dirname(directory);
  }
}

export async function writeAssetBlob(input: Readonly<{
  projectId: string;
  assetId: string;
  versionId: string;
  buffer: Buffer;
}>): Promise<string> {
  const storageKey = assetBlobStorageKey(input.projectId, input.assetId, input.versionId);
  const destination = storagePath(storageKey);
  const directory = path.dirname(destination);
  const temporary = `${destination}.tmp`;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(temporary, input.buffer, { flag: "wx", mode: 0o600 });
    await rename(temporary, destination);
    return storageKey;
  } catch {
    try {
      // A failed rename/write can leave either path behind. Do not silently
      // swallow cleanup errors: callers must retain the durable reservation
      // until both paths are confirmed absent.
      await unlinkIfPresent(temporary);
      await unlinkIfPresent(destination);
    } catch {
      return fail("ASSET_STORAGE_UNAVAILABLE");
    }
    return fail("ASSET_STORAGE_UNAVAILABLE");
  }
}

export async function readAssetBlob(storageKey: string, expectedBytes?: bigint): Promise<Buffer> {
  const location = storagePath(storageKey);
  try {
    const metadata = await stat(location);
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > getUploadPolicy().maxFileBytes) {
      return fail("ASSET_STORAGE_UNAVAILABLE");
    }
    if (expectedBytes !== undefined && BigInt(metadata.size) !== expectedBytes) return fail("ASSET_STORAGE_UNAVAILABLE");
    return await readFile(location);
  } catch (error) {
    if (error instanceof ProjectAssetStorageError) throw error;
    return fail("ASSET_STORAGE_UNAVAILABLE");
  }
}

export async function removeAssetBlob(storageKey: string): Promise<void> {
  const location = storagePath(storageKey);
  for (const artifact of [location, `${location}.tmp`]) {
    try {
      await unlink(artifact);
    } catch (error) {
      if (error instanceof ProjectAssetStorageError) throw error;
      if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) {
        throw new ProjectAssetStorageError("ASSET_STORAGE_UNAVAILABLE");
      }
    }
  }
  try {
    await removeEmptyParentDirectories(location);
  } catch {
    throw new ProjectAssetStorageError("ASSET_STORAGE_UNAVAILABLE");
  }
}
