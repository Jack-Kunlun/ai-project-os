import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Prisma, type AppUser, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { assertProjectActive } from "@/lib/project-lifecycle";
import { hashSourceContent, MAX_SOURCE_CONTENT_LENGTH } from "@/lib/source";

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const REQUEST_TIMEOUT_MS = 20_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SUPPORTED_CONTENT_TYPE = /^(?:text\/(?:plain|html|markdown|xml)|application\/(?:json|xml|xhtml\+xml))(?:\s*;|$)/iu;

export type WebSourceErrorCode =
  | "WEB_SOURCE_INVALID_INPUT"
  | "WEB_SOURCE_PROJECT_NOT_FOUND"
  | "WEB_SOURCE_NOT_FOUND"
  | "WEB_SOURCE_CONFLICT"
  | "WEB_SOURCE_DISABLED"
  | "WEB_SOURCE_NETWORK_BLOCKED"
  | "WEB_SOURCE_NETWORK_CHANGED"
  | "WEB_SOURCE_HOST_UNRESOLVED"
  | "WEB_SOURCE_REDIRECT_REJECTED"
  | "WEB_SOURCE_FETCH_FAILED"
  | "WEB_SOURCE_HTTP_STATUS"
  | "WEB_SOURCE_TOO_LARGE"
  | "WEB_SOURCE_TYPE_UNSUPPORTED"
  | "WEB_SOURCE_CONTENT_EMPTY";

export class WebSourceError extends Error {
  constructor(readonly code: WebSourceErrorCode) {
    super(code);
    this.name = "WebSourceError";
  }
}

const createSchema = z.object({
  name: z.string().trim().min(1).max(160),
  url: z.string().trim().min(8).max(2048),
  allowPrivateNetwork: z.boolean().default(false),
}).strict();

const updateSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  enabled: z.boolean().optional(),
  trustCurrentNetwork: z.boolean().optional(),
}).strict();

const webSourceSelect = {
  id: true,
  projectId: true,
  name: true,
  url: true,
  allowPrivateNetwork: true,
  status: true,
  lastFetchedAt: true,
  lastErrorCode: true,
  createdAt: true,
  updatedAt: true,
  pointer: {
    select: {
      publishedAt: true,
      revision: {
        select: { id: true, status: true, finalUrl: true, title: true, contentHash: true, contentBytes: true, fetchedAt: true, completedAt: true },
      },
    },
  },
} satisfies Prisma.WebSourceSelect;

type ResolvedEndpoint = Readonly<{ address: string; family: 4 | 6; fingerprint: string }>;
type RawResponse = Readonly<{ status: number; headers: Readonly<Record<string, string>>; body: Buffer }>;

function fail(code: WebSourceErrorCode): never {
  throw new WebSourceError(code);
}

function uuid(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) return fail("WEB_SOURCE_INVALID_INPUT");
  return value;
}

function isPrismaCode(error: unknown, code: string): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
}

function ipv4Parts(address: string): readonly number[] | null {
  if (isIP(address) !== 4) return null;
  const parts = address.split(".").map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) ? parts : null;
}

function isMetadataAddress(address: string): boolean {
  const normalized = address.toLowerCase().split("%")[0]!;
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/u)?.[1];
  return normalized === "169.254.169.254" || normalized === "fd00:ec2::254" || mapped === "169.254.169.254";
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase().split("%")[0]!;
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/u)?.[1];
  if (mapped !== undefined) return isPrivateAddress(mapped);
  const parts = ipv4Parts(normalized);
  if (parts !== null) {
    const [a, b] = parts;
    return a === 0 || a === 10 || a === 127 || (a === 100 && b! >= 64 && b! <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) || a! >= 224;
  }
  if (isIP(normalized) !== 6) return true;
  return normalized === "::" || normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || /^fe[89ab]/u.test(normalized);
}

export function canonicalWebSourceUrl(value: unknown, allowPrivateNetwork: boolean): string {
  if (typeof value !== "string" || value.trim() !== value || value.length < 8 || value.length > 2048 || /[\u0000-\u001f\u007f]/u.test(value)) {
    return fail("WEB_SOURCE_INVALID_INPUT");
  }
  let url: URL;
  try { url = new URL(value); } catch { return fail("WEB_SOURCE_INVALID_INPUT"); }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    (url.protocol === "http:" && !allowPrivateNetwork) ||
    url.username.length > 0 || url.password.length > 0 || url.hostname.length === 0
  ) return fail("WEB_SOURCE_INVALID_INPUT");
  url.hash = "";
  return url.toString();
}

async function resolveEndpoint(url: URL, allowPrivateNetwork: boolean): Promise<ResolvedEndpoint> {
  let rows: readonly { address: string; family: number }[];
  try { rows = await lookup(url.hostname, { all: true, verbatim: true }); } catch { return fail("WEB_SOURCE_HOST_UNRESOLVED"); }
  const normalized = [...new Map(rows.map((row) => [`${row.family}:${row.address.toLowerCase()}`, row] as const)).values()]
    .map((row) => ({ address: row.address.toLowerCase(), family: row.family }))
    .sort((left, right) => `${left.family}:${left.address}`.localeCompare(`${right.family}:${right.address}`));
  if (normalized.length === 0) return fail("WEB_SOURCE_HOST_UNRESOLVED");
  if (normalized.some((row) => isMetadataAddress(row.address))) return fail("WEB_SOURCE_NETWORK_BLOCKED");
  if (!allowPrivateNetwork && normalized.some((row) => isPrivateAddress(row.address))) return fail("WEB_SOURCE_NETWORK_BLOCKED");
  const first = normalized[0]!;
  if (first.family !== 4 && first.family !== 6) return fail("WEB_SOURCE_HOST_UNRESOLVED");
  const fingerprint = createHash("sha256")
    .update(`${url.hostname.toLowerCase()}:${url.port || (url.protocol === "https:" ? "443" : "80")}:${normalized.map((row) => `${row.family}:${row.address}`).join(",")}`, "utf8")
    .digest("hex");
  return Object.freeze({ address: first.address, family: first.family, fingerprint });
}

export async function resolveSecureEndpointFingerprint(input: Readonly<{
  url: string;
  allowPrivateNetwork: boolean;
}>): Promise<Readonly<{ url: string; fingerprint: string }>> {
  const canonical = canonicalWebSourceUrl(input.url, input.allowPrivateNetwork);
  const endpoint = await resolveEndpoint(new URL(canonical), input.allowPrivateNetwork);
  return Object.freeze({ url: canonical, fingerprint: endpoint.fingerprint });
}

async function requestPinned(url: URL, endpoint: ResolvedEndpoint, options: Readonly<{
  method?: "GET" | "POST";
  headers?: Readonly<Record<string, string>>;
  body?: string;
  maximumResponseBytes?: number;
}> = {}): Promise<RawResponse> {
  const maximumResponseBytes = options.maximumResponseBytes ?? MAX_RESPONSE_BYTES;
  if (!Number.isInteger(maximumResponseBytes) || maximumResponseBytes < 1 || maximumResponseBytes > MAX_RESPONSE_BYTES) {
    return fail("WEB_SOURCE_INVALID_INPUT");
  }
  return new Promise<RawResponse>((resolve, reject) => {
    const lookupPinned: LookupFunction = (_hostname, options, callback) => {
      callback(null, options.all ? [{ address: endpoint.address, family: endpoint.family }] : endpoint.address, endpoint.family);
    };
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      method: options.method ?? "GET",
      headers: { accept: "text/html,text/plain,application/json,application/xml;q=0.9", "accept-encoding": "identity", "user-agent": "AI-Project-OS-Web-Source/1.0", ...options.headers },
      lookup: lookupPinned,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maximumResponseBytes) {
          response.destroy(new WebSourceError("WEB_SOURCE_TOO_LARGE"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(response.headers)) if (value !== undefined) headers[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
        resolve(Object.freeze({ status: response.statusCode ?? 0, headers: Object.freeze(headers), body: Buffer.concat(chunks) }));
      });
      response.on("error", reject);
    });
    request.on("error", reject);
    request.end(options.body);
  }).catch((error: unknown) => {
    if (error instanceof WebSourceError) throw error;
    return fail("WEB_SOURCE_FETCH_FAILED");
  });
}

export async function securePinnedHttpRequest(input: Readonly<{
  url: string;
  allowPrivateNetwork: boolean;
  expectedFingerprint?: string | null;
  method?: "GET" | "POST";
  headers?: Readonly<Record<string, string>>;
  body?: string;
  maximumResponseBytes?: number;
}>): Promise<Readonly<{
  status: number;
  headers: Readonly<Record<string, string>>;
  body: Buffer;
  finalUrl: string;
  fingerprint: string;
}>> {
  const canonical = canonicalWebSourceUrl(input.url, input.allowPrivateNetwork);
  const url = new URL(canonical);
  const endpoint = await resolveEndpoint(url, input.allowPrivateNetwork);
  if (input.expectedFingerprint !== undefined && input.expectedFingerprint !== null && endpoint.fingerprint !== input.expectedFingerprint) {
    return fail("WEB_SOURCE_NETWORK_CHANGED");
  }
  const response = await requestPinned(url, endpoint, {
    method: input.method,
    headers: input.headers,
    body: input.body,
    maximumResponseBytes: input.maximumResponseBytes,
  });
  return Object.freeze({ ...response, finalUrl: canonical, fingerprint: endpoint.fingerprint });
}

export async function securePinnedJsonRequest(input: Readonly<{
  url: string;
  allowPrivateNetwork: boolean;
  expectedFingerprint?: string | null;
  method?: "GET" | "POST";
  headers?: Readonly<Record<string, string>>;
  body?: string;
}>): Promise<Readonly<{ value: unknown; finalUrl: string; fingerprint: string; status: number }>> {
  const response = await securePinnedHttpRequest(input);
  if (response.status < 200 || response.status >= 300) return fail("WEB_SOURCE_HTTP_STATUS");
  const contentType = response.headers["content-type"] ?? "";
  if (!/^application\/(?:[A-Za-z0-9.+-]*\+)?json(?:\s*;|$)/iu.test(contentType)) return fail("WEB_SOURCE_TYPE_UNSUPPORTED");
  let value: unknown;
  try { value = JSON.parse(response.body.toString("utf8")); } catch { return fail("WEB_SOURCE_CONTENT_EMPTY"); }
  return Object.freeze({ value, finalUrl: response.finalUrl, fingerprint: response.fingerprint, status: response.status });
}

async function fetchWebSource(input: Readonly<{ url: string; allowPrivateNetwork: boolean; expectedFingerprint: string | null }>) {
  let url = new URL(input.url);
  const originHost = url.hostname.toLowerCase();
  let originFingerprint: string | null = null;
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const endpoint = await resolveEndpoint(url, input.allowPrivateNetwork);
    if (redirect === 0) {
      originFingerprint = endpoint.fingerprint;
      if (input.expectedFingerprint !== null && input.expectedFingerprint !== originFingerprint) return fail("WEB_SOURCE_NETWORK_CHANGED");
    }
    const response = await requestPinned(url, endpoint);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.location;
      if (location === undefined || redirect === MAX_REDIRECTS) return fail("WEB_SOURCE_REDIRECT_REJECTED");
      let target: URL;
      try { target = new URL(location, url); } catch { return fail("WEB_SOURCE_REDIRECT_REJECTED"); }
      if (target.hostname.toLowerCase() !== originHost || !["http:", "https:"].includes(target.protocol) || (target.protocol === "http:" && !input.allowPrivateNetwork)) {
        return fail("WEB_SOURCE_REDIRECT_REJECTED");
      }
      target.username = ""; target.password = ""; target.hash = "";
      url = target;
      continue;
    }
    if (response.status < 200 || response.status >= 300) return fail("WEB_SOURCE_HTTP_STATUS");
    const contentType = response.headers["content-type"]?.slice(0, 255) ?? "";
    if (!SUPPORTED_CONTENT_TYPE.test(contentType)) return fail("WEB_SOURCE_TYPE_UNSUPPORTED");
    return Object.freeze({ finalUrl: url.toString(), originFingerprint: originFingerprint!, response, contentType });
  }
  return fail("WEB_SOURCE_REDIRECT_REJECTED");
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };
  return value.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/giu, (match, decimal: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (decimal !== undefined) return String.fromCodePoint(Math.min(0x10ffff, Number(decimal)));
    if (hex !== undefined) return String.fromCodePoint(Math.min(0x10ffff, Number.parseInt(hex, 16)));
    return name === undefined ? match : named[name.toLowerCase()] ?? match;
  });
}

export function extractWebDocument(body: Buffer, contentType: string, finalUrl: string): Readonly<{ title: string; text: string }> {
  const raw = body.toString("utf8").replace(/^\uFEFF/u, "");
  let title = new URL(finalUrl).pathname.split("/").filter(Boolean).at(-1) ?? new URL(finalUrl).hostname;
  let text = raw;
  if (/html|xhtml/iu.test(contentType)) {
    const match = raw.match(/<title(?:\s[^>]*)?>([\s\S]*?)<\/title>/iu);
    if (match?.[1]) title = decodeEntities(match[1].replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ").trim()).slice(0, 512) || title;
    text = raw
      .replace(/<(?:script|style|noscript|template|svg|canvas|iframe)\b[^>]*>[\s\S]*?<\/(?:script|style|noscript|template|svg|canvas|iframe)>/giu, " ")
      .replace(/<(?:br|hr)\s*\/?>/giu, "\n")
      .replace(/<\/(?:p|div|section|article|main|header|footer|li|h[1-6]|tr)>/giu, "\n")
      .replace(/<[^>]+>/gu, " ");
  }
  text = decodeEntities(text).replace(/\r\n?/gu, "\n").replace(/[\t ]+/gu, " ").replace(/ *\n */gu, "\n").replace(/\n{3,}/gu, "\n\n").trim();
  if (text.length === 0) return fail("WEB_SOURCE_CONTENT_EMPTY");
  const prefix = `# ${title}\n\n来源：${finalUrl}\n\n`;
  return Object.freeze({ title: title.slice(0, 512), text: `${prefix}${text}`.slice(0, MAX_SOURCE_CONTENT_LENGTH) });
}

export async function listProjectWebSources(projectIdInput: unknown, db: PrismaClient = getDb()) {
  const projectId = uuid(projectIdInput);
  const project = await db.project.findUnique({ where: { id: projectId }, select: { id: true } });
  if (project === null) return fail("WEB_SOURCE_PROJECT_NOT_FOUND");
  return db.webSource.findMany({ where: { projectId }, orderBy: [{ createdAt: "desc" }, { id: "asc" }], select: webSourceSelect });
}

export async function createProjectWebSource(
  projectIdInput: unknown,
  input: unknown,
  actor: Pick<AppUser, "id">,
  db: PrismaClient = getDb(),
) {
  const projectId = uuid(projectIdInput);
  await assertProjectActive(projectId, db);
  const parsed = createSchema.parse(input);
  const url = canonicalWebSourceUrl(parsed.url, parsed.allowPrivateNetwork);
  const endpoint = await resolveEndpoint(new URL(url), parsed.allowPrivateNetwork);
  let source: { id: string };
  try {
    source = await db.webSource.create({
      data: { projectId, name: parsed.name, url, allowPrivateNetwork: parsed.allowPrivateNetwork, resolvedAddressFingerprint: endpoint.fingerprint, createdById: actor.id },
      select: { id: true },
    });
  } catch (error) {
    if (isPrismaCode(error, "P2002")) return fail("WEB_SOURCE_CONFLICT");
    if (isPrismaCode(error, "P2003")) return fail("WEB_SOURCE_PROJECT_NOT_FOUND");
    throw error;
  }
  await syncProjectWebSource(projectId, source.id, actor, db);
  return db.webSource.findUniqueOrThrow({ where: { id: source.id }, select: webSourceSelect });
}

export async function updateProjectWebSource(
  projectIdInput: unknown,
  webSourceIdInput: unknown,
  input: unknown,
  db: PrismaClient = getDb(),
) {
  const projectId = uuid(projectIdInput);
  const webSourceId = uuid(webSourceIdInput);
  const parsed = updateSchema.parse(input);
  const current = await db.webSource.findFirst({ where: { id: webSourceId, projectId } });
  if (current === null) return fail("WEB_SOURCE_NOT_FOUND");
  const fingerprint = parsed.trustCurrentNetwork === true ? (await resolveEndpoint(new URL(current.url), current.allowPrivateNetwork)).fingerprint : undefined;
  if (parsed.enabled === false) {
    await db.$transaction(async (tx) => {
      const pointer = await tx.webSourcePointer.findUnique({ where: { projectId_webSourceId: { projectId, webSourceId } }, select: { revision: { select: { projectSourceId: true } } } });
      await tx.webSource.update({ where: { id: webSourceId }, data: { status: "disabled", disabledAt: new Date(), ...(parsed.name === undefined ? {} : { name: parsed.name }), ...(fingerprint === undefined ? {} : { resolvedAddressFingerprint: fingerprint }) } });
      if (pointer?.revision.projectSourceId) await tx.projectSource.updateMany({ where: { projectId, id: pointer.revision.projectSourceId }, data: { retiredAt: new Date() } });
      await tx.webSourcePointer.deleteMany({ where: { projectId, webSourceId } });
    });
  } else {
    await db.webSource.update({ where: { id: webSourceId }, data: { ...(parsed.name === undefined ? {} : { name: parsed.name }), ...(parsed.enabled === true ? { status: "active", disabledAt: null, lastErrorCode: null } : {}), ...(fingerprint === undefined ? {} : { resolvedAddressFingerprint: fingerprint, status: "active", lastErrorCode: null, disabledAt: null }) } });
  }
  return db.webSource.findUniqueOrThrow({ where: { id: webSourceId }, select: webSourceSelect });
}

export async function syncProjectWebSource(
  projectIdInput: unknown,
  webSourceIdInput: unknown,
  _actor: Pick<AppUser, "id">,
  db: PrismaClient = getDb(),
) {
  const projectId = uuid(projectIdInput);
  const webSourceId = uuid(webSourceIdInput);
  const webSource = await db.webSource.findFirst({ where: { id: webSourceId, projectId } });
  if (webSource === null) return fail("WEB_SOURCE_NOT_FOUND");
  if (webSource.status === "disabled") return fail("WEB_SOURCE_DISABLED");
  const revision = await db.webSourceRevision.create({ data: { projectId, webSourceId }, select: { id: true } });
  try {
    const fetched = await fetchWebSource({ url: webSource.url, allowPrivateNetwork: webSource.allowPrivateNetwork, expectedFingerprint: webSource.resolvedAddressFingerprint });
    const document = extractWebDocument(fetched.response.body, fetched.contentType, fetched.finalUrl);
    const contentHash = hashSourceContent(document.text);
    const completedAt = new Date();
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${projectId}:${webSourceId}`}, 29082026))`;
      const currentPointer = await tx.webSourcePointer.findUnique({
        where: { projectId_webSourceId: { projectId, webSourceId } },
        select: { webSourceRevisionId: true, revision: { select: { projectSourceId: true, contentHash: true } } },
      });
      let projectSourceId = currentPointer?.revision.contentHash === contentHash ? currentPointer.revision.projectSourceId : null;
      if (projectSourceId === null) {
        const created = await tx.projectSource.create({
          data: { projectId, kind: "web", sourceIdentity: webSourceId, revisionKey: revision.id, externalRef: fetched.finalUrl, contentText: document.text, contentHash, capturedAt: completedAt },
          select: { id: true },
        });
        projectSourceId = created.id;
        if (currentPointer?.revision.projectSourceId) await tx.projectSource.updateMany({ where: { projectId, id: currentPointer.revision.projectSourceId }, data: { retiredAt: completedAt } });
      }
      await tx.webSourceRevision.update({
        where: { id: revision.id },
        data: { status: "complete", finalUrl: fetched.finalUrl, httpStatus: fetched.response.status, contentType: fetched.contentType, title: document.title, contentHash, contentBytes: fetched.response.body.length, projectSourceId, completedAt },
      });
      if (currentPointer !== null) await tx.webSourceRevision.updateMany({ where: { id: currentPointer.webSourceRevisionId, status: "complete" }, data: { status: "superseded", supersededAt: completedAt } });
      await tx.webSourcePointer.upsert({
        where: { projectId_webSourceId: { projectId, webSourceId } },
        create: { projectId, webSourceId, webSourceRevisionId: revision.id, publishedAt: completedAt },
        update: { webSourceRevisionId: revision.id, publishedAt: completedAt },
      });
      await tx.webSource.update({ where: { id: webSourceId }, data: { status: "active", lastFetchedAt: completedAt, lastErrorCode: null, resolvedAddressFingerprint: fetched.originFingerprint, disabledAt: null } });
      await tx.project.update({ where: { id: projectId }, data: { updatedAt: completedAt } });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    return db.webSource.findUniqueOrThrow({ where: { id: webSourceId }, select: webSourceSelect });
  } catch (error) {
    const code = error instanceof WebSourceError ? error.code : "WEB_SOURCE_FETCH_FAILED";
    const completedAt = new Date();
    await db.$transaction([
      db.webSourceRevision.update({ where: { id: revision.id }, data: { status: "failed", failureCode: code, completedAt } }),
      db.webSource.update({ where: { id: webSourceId }, data: { status: "error", lastErrorCode: code, lastFetchedAt: completedAt } }),
    ]).catch(() => undefined);
    throw error instanceof WebSourceError ? error : new WebSourceError("WEB_SOURCE_FETCH_FAILED");
  }
}

export async function syncAllProjectWebSources(projectIdInput: unknown, actor: Pick<AppUser, "id">, db: PrismaClient = getDb()) {
  const projectId = uuid(projectIdInput);
  const sources = await db.webSource.findMany({ where: { projectId, status: { not: "disabled" } }, orderBy: { id: "asc" }, select: { id: true } });
  const results: Array<{ id: string; status: "succeeded" | "failed"; failureCode?: string }> = [];
  for (const source of sources) {
    try {
      await syncProjectWebSource(projectId, source.id, actor, db);
      results.push({ id: source.id, status: "succeeded" });
    } catch (error) {
      results.push({ id: source.id, status: "failed", failureCode: error instanceof WebSourceError ? error.code : "WEB_SOURCE_FETCH_FAILED" });
    }
  }
  return Object.freeze(results);
}
