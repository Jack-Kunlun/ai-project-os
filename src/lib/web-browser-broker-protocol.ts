import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, isAbsolute, normalize } from "node:path";
import { normalizeWebBrowserSiteForm, normalizeWebBrowserTarget, WebBrowserProxyError, type WebBrowserSiteForm } from "./web-browser-policy";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HEX64 = /^[0-9a-f]{64}$/u;
const NONCE = /^[A-Za-z0-9_-]{22}$/u;
export const WEB_BROWSER_BROKER_MAX_REQUEST_BYTES = 16 * 1024;
export const WEB_BROWSER_BROKER_MAX_RESPONSE_BYTES = 128 * 1024;
export const WEB_BROWSER_BROKER_CLOCK_SKEW_MS = 30_000;

export type WebBrowserBrokerRequest = Readonly<{
  jobId: string;
  projectId: string;
  sourceId: string;
  revisionId: string;
  url: string;
  expectedNetworkFingerprint: string;
  siteForm?: WebBrowserSiteForm;
}>;

export type WebBrowserBrokerResult = Readonly<{
  jobId: string;
  url: string;
  text: string;
  networkFingerprint: string;
  imageDigest: string;
}>;

export type WebBrowserBrokerCancellation = Readonly<{ jobIds: readonly string[] }>;

function fail(): never {
  throw new WebBrowserProxyError("WEB_BROWSER_ISOLATION_UNAVAILABLE");
}

export function parseWebBrowserBrokerRequest(value: unknown): WebBrowserBrokerRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return fail();
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row);
  if (
    keys.length < 6 || keys.length > 7 ||
    !["jobId", "projectId", "sourceId", "revisionId", "url", "expectedNetworkFingerprint"].every((key) => keys.includes(key)) ||
    keys.some((key) => !["jobId", "projectId", "sourceId", "revisionId", "url", "expectedNetworkFingerprint", "siteForm"].includes(key)) ||
    typeof row.expectedNetworkFingerprint !== "string" || !HEX64.test(row.expectedNetworkFingerprint) ||
    ![row.jobId, row.projectId, row.sourceId, row.revisionId].every((id) => typeof id === "string" && UUID.test(id))
  ) return fail();
  const target = normalizeWebBrowserTarget(row.url);
  return Object.freeze({
    jobId: row.jobId as string,
    projectId: row.projectId as string,
    sourceId: row.sourceId as string,
    revisionId: row.revisionId as string,
    url: target.url,
    expectedNetworkFingerprint: row.expectedNetworkFingerprint as string,
    ...(row.siteForm === undefined ? {} : { siteForm: normalizeWebBrowserSiteForm(row.siteForm, target.url) }),
  });
}

export function parseWebBrowserBrokerCancellation(value: unknown): WebBrowserBrokerCancellation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return fail();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== 1 || !Array.isArray(row.jobIds) || row.jobIds.length < 1 || row.jobIds.length > 100 ||
      row.jobIds.some((id) => typeof id !== "string" || !UUID.test(id)) || new Set(row.jobIds).size !== row.jobIds.length) return fail();
  return Object.freeze({ jobIds: Object.freeze([...row.jobIds] as string[]) });
}

export function parseWebBrowserBrokerResult(value: unknown, expectedJobId: string, expectedImageDigest: string): WebBrowserBrokerResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return fail();
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).length !== 5 ||
    row.jobId !== expectedJobId || row.imageDigest !== expectedImageDigest ||
    typeof row.url !== "string" || typeof row.text !== "string" ||
    row.text.length < 1 || row.text.length > 20_000 ||
    typeof row.networkFingerprint !== "string" || !HEX64.test(row.networkFingerprint)
  ) return fail();
  return Object.freeze({
    jobId: expectedJobId,
    url: normalizeWebBrowserTarget(row.url).url,
    text: row.text,
    networkFingerprint: row.networkFingerprint,
    imageDigest: expectedImageDigest,
  });
}

export async function readPrivateWebBrowserBrokerFile(path: string, maxBytes: number): Promise<Buffer> {
  if (!isAbsolute(path) || normalize(path) !== path) return fail();
  const parent = await lstat(dirname(path));
  if (!parent.isDirectory() || (parent.mode & 0o022) !== 0 || ![0, process.getuid?.()].includes(parent.uid)) return fail();
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o077) !== 0 || metadata.size < 1 || metadata.size > maxBytes) return fail();
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

export async function readWebBrowserBrokerKey(path: string): Promise<Buffer> {
  const encoded = (await readPrivateWebBrowserBrokerFile(path, 128)).toString("utf8").trimEnd();
  if (!/^[A-Za-z0-9_-]{43}$/u.test(encoded)) return fail();
  const key = Buffer.from(encoded, "base64url");
  if (key.length !== 32 || key.toString("base64url") !== encoded) return fail();
  return key;
}

export function createWebBrowserBrokerNonce(): string {
  return randomBytes(16).toString("base64url");
}

export function browserResourceIdForJob(jobId: string): string {
  if (!UUID.test(jobId)) return fail();
  return createHash("sha256").update(`browser-resource-v1:${jobId}`, "utf8").digest("hex").slice(0, 24);
}

export function signWebBrowserBrokerRequest(key: Buffer, body: Buffer, timestampMs: number, nonce: string): string {
  if (key.length !== 32 || body.length < 2 || body.length > WEB_BROWSER_BROKER_MAX_REQUEST_BYTES ||
      !Number.isSafeInteger(timestampMs) || !NONCE.test(nonce)) return fail();
  const bodyHash = createHash("sha256").update(body).digest("hex");
  return createHmac("sha256", key).update(`web-browser-broker-v1\n${timestampMs}\n${nonce}\n${bodyHash}`, "utf8").digest("hex");
}

export function verifyWebBrowserBrokerRequestSignature(
  key: Buffer,
  body: Buffer,
  timestampHeader: string | undefined,
  nonce: string | undefined,
  signature: string | undefined,
  nowMs = Date.now(),
): boolean {
  if (
    timestampHeader === undefined || !/^[1-9][0-9]{12}$/u.test(timestampHeader) ||
    nonce === undefined || !NONCE.test(nonce) ||
    signature === undefined || !HEX64.test(signature)
  ) return false;
  const timestampMs = Number(timestampHeader);
  if (!Number.isSafeInteger(timestampMs) || Math.abs(nowMs - timestampMs) > WEB_BROWSER_BROKER_CLOCK_SKEW_MS) return false;
  try {
    const expected = Buffer.from(signWebBrowserBrokerRequest(key, body, timestampMs, nonce), "hex");
    const received = Buffer.from(signature, "hex");
    return received.length === expected.length && timingSafeEqual(received, expected);
  } catch {
    return false;
  }
}
