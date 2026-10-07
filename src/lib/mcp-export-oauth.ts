import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { assertAccountAccessForActor } from "@/lib/account-access-guard";
import { WebAiAccessError, withWebAiProjectAccessTransaction, type WebAiActor } from "@/lib/access-linearization";
import { getDb } from "@/lib/db";
import { canonicalWebSourceUrl, securePinnedHttpRequest } from "@/lib/web-sources";
import { getMcpExportOAuthConfiguration, getMcpExportPublicOrigin, isMcpExportOAuthEnabled } from "@/lib/mcp-export-oauth-config";

export const MCP_EXPORT_OAUTH_SCOPE = "project:read" as const;
export const MCP_EXPORT_OAUTH_ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const OAUTH_AUTHORIZATION_REQUEST_TTL_MS = 10 * 60 * 1_000;
const OAUTH_AUTHORIZATION_CODE_TTL_MS = 2 * 60 * 1_000;
const OAUTH_GRANT_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_ACTIVE_MCP_EXPORT_GRANTS_PER_OWNER = 10;
const OAUTH_ADMISSION_HOUR_MS = 60 * 60 * 1_000;
const OAUTH_ADMISSION_RETENTION_MS = 24 * OAUTH_ADMISSION_HOUR_MS;
const OAUTH_STATE_CLEANUP_BATCH_SIZE = 100;
const OAUTH_STATE_CLEANUP_MAX_BATCHES_PER_RUN = 10;
const OAUTH_CLIENT_HOURLY_ATTEMPT_LIMIT = 20;
const OAUTH_GLOBAL_HOURLY_ATTEMPT_LIMIT = 200;
const OAUTH_CLIENT_OUTSTANDING_LIMIT = 5;
const OAUTH_GLOBAL_OUTSTANDING_LIMIT = 200;
const OAUTH_ADMISSION_LOCK_KEY = "ai-project-os:mcp-export-oauth-admission:v1";
const OAUTH_GLOBAL_ADMISSION_FINGERPRINT = "0".repeat(64);
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const uuidSchema = z.string().uuid();
let activeCimdFetches = 0;
const MAX_CONCURRENT_CIMD_FETCHES_PER_PROCESS = 8;

export type McpExportOAuthClientMetadata = Readonly<{
  clientId: string;
  clientName: string;
  redirectUris: readonly string[];
  fingerprint: string;
}>;

export type McpExportOAuthErrorCode =
  | "MCP_EXPORT_OAUTH_INVALID_REQUEST"
  | "MCP_EXPORT_OAUTH_INVALID_CLIENT"
  | "MCP_EXPORT_OAUTH_ACCESS_DENIED"
  | "MCP_EXPORT_OAUTH_INVALID_GRANT"
  | "MCP_EXPORT_OAUTH_RATE_LIMITED"
  | "MCP_EXPORT_OAUTH_ADMISSION_UNAVAILABLE"
  | "MCP_EXPORT_OAUTH_UNAUTHORIZED";

export class McpExportOAuthError extends Error {
  constructor(readonly code: McpExportOAuthErrorCode) {
    super(code);
    this.name = "McpExportOAuthError";
  }
}

function fail(code: McpExportOAuthErrorCode): never {
  throw new McpExportOAuthError(code);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hashJson(value: unknown): string {
  return sha256(JSON.stringify(value));
}

function safeEqualHex(left: string, right: string): boolean {
  if (!/^[0-9a-f]{64}$/u.test(left) || !/^[0-9a-f]{64}$/u.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function configuredResource(): string {
  const configuration = getMcpExportOAuthConfiguration();
  if (configuration === null) return fail("MCP_EXPORT_OAUTH_UNAUTHORIZED");
  return configuration.resource;
}

function canonicalClientId(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048 || value.trim() !== value) return fail("MCP_EXPORT_OAUTH_INVALID_CLIENT");
  let parsed: URL;
  try { parsed = new URL(value); } catch { return fail("MCP_EXPORT_OAUTH_INVALID_CLIENT"); }
  let canonical: string;
  try { canonical = canonicalWebSourceUrl(value, false); } catch { return fail("MCP_EXPORT_OAUTH_INVALID_CLIENT"); }
  if (parsed.protocol !== "https:" || parsed.pathname === "/" || parsed.username !== "" || parsed.password !== ""
    || parsed.hash !== "" || canonical !== value) return fail("MCP_EXPORT_OAUTH_INVALID_CLIENT");
  return value;
}

export function canonicalRedirectUri(value: unknown): string {
  if (typeof value !== "string" || value.length < 8 || value.length > 2048 || value.trim() !== value
    || /[\u0000-\u0020\u007f]/u.test(value)) return fail("MCP_EXPORT_OAUTH_INVALID_CLIENT");
  let parsed: URL;
  try { parsed = new URL(value); } catch { return fail("MCP_EXPORT_OAUTH_INVALID_CLIENT"); }
  if (parsed.username !== "" || parsed.password !== "" || parsed.hash !== "" || parsed.hostname.includes("*")) {
    return fail("MCP_EXPORT_OAUTH_INVALID_CLIENT");
  }
  if (parsed.protocol === "https:") return value;
  if (parsed.protocol === "http:") {
    const hostname = parsed.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
    if (!["localhost", "127.0.0.1", "::1"].includes(hostname)) {
      return fail("MCP_EXPORT_OAUTH_INVALID_CLIENT");
    }
    return value;
  }
  return fail("MCP_EXPORT_OAUTH_INVALID_CLIENT");
}

export function parseMcpExportOAuthClientMetadata(clientIdInput: unknown, raw: unknown): McpExportOAuthClientMetadata {
  const clientId = canonicalClientId(clientIdInput);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return fail("MCP_EXPORT_OAUTH_INVALID_CLIENT");
  const input = raw as Record<string, unknown>;
  if (input.client_id !== clientId || typeof input.client_name !== "string"
    || input.client_name.trim() !== input.client_name || input.client_name.length < 1 || input.client_name.length > 160
    || /[\u0000-\u001f\u007f-\u009f]/u.test(input.client_name)
    || !Array.isArray(input.redirect_uris) || input.redirect_uris.length < 1 || input.redirect_uris.length > 20) {
    return fail("MCP_EXPORT_OAUTH_INVALID_CLIENT");
  }
  if (input.token_endpoint_auth_method !== undefined && input.token_endpoint_auth_method !== "none") {
    return fail("MCP_EXPORT_OAUTH_INVALID_CLIENT");
  }
  if (input.grant_types !== undefined && (!Array.isArray(input.grant_types)
    || input.grant_types.some((entry) => typeof entry !== "string")
    || !input.grant_types.includes("authorization_code"))) {
    return fail("MCP_EXPORT_OAUTH_INVALID_CLIENT");
  }
  if (input.response_types !== undefined && (!Array.isArray(input.response_types)
    || input.response_types.some((entry) => typeof entry !== "string")
    || !input.response_types.includes("code"))) {
    return fail("MCP_EXPORT_OAUTH_INVALID_CLIENT");
  }
  let redirectUris: string[];
  try {
    redirectUris = input.redirect_uris.map(canonicalRedirectUri);
  } catch {
    return fail("MCP_EXPORT_OAUTH_INVALID_CLIENT");
  }
  if (new Set(redirectUris).size !== redirectUris.length) return fail("MCP_EXPORT_OAUTH_INVALID_CLIENT");
  const sortedRedirectUris = [...redirectUris].sort();
  const grantTypes = [...new Set((input.grant_types as string[] | undefined) ?? ["authorization_code"])].sort();
  const responseTypes = [...new Set((input.response_types as string[] | undefined) ?? ["code"])].sort();
  const fingerprint = hashJson({
    clientId,
    clientName: input.client_name,
    redirectUris: sortedRedirectUris,
    tokenEndpointAuthMethod: input.token_endpoint_auth_method ?? "none",
    grantTypes,
    responseTypes,
  });
  return Object.freeze({ clientId, clientName: input.client_name, redirectUris: Object.freeze(sortedRedirectUris), fingerprint });
}

export function isMcpExportOAuthRedirectUriRegistered(
  metadata: McpExportOAuthClientMetadata,
  redirectUri: string,
): boolean {
  return metadata.redirectUris.includes(redirectUri);
}

export function mcpExportOAuthClientAdmissionFingerprint(clientIdInput: unknown): string {
  const clientId = canonicalClientId(clientIdInput);
  return sha256(`ai-project-os:mcp-export-oauth:client-admission:v1:${clientId}`);
}

type AdmissionBudgetRow = Readonly<{ windowStartedAt: Date; attemptCount: number }> | null;

function nextAdmissionAttemptCount(row: AdmissionBudgetRow, now: Date, limit: number): number | null {
  if (row === null || row.windowStartedAt.getTime() + OAUTH_ADMISSION_HOUR_MS <= now.getTime()) return 1;
  if (row.attemptCount >= limit) return null;
  return row.attemptCount + 1;
}

async function lockOAuthAdmission(tx: Prisma.TransactionClient): Promise<Date> {
  await tx.$queryRaw<Array<{ locked: boolean }>>(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${OAUTH_ADMISSION_LOCK_KEY}, 0)) IS NULL AS "locked"
  `);
  return readOAuthDatabaseClock(tx);
}

async function tryLockOAuthAdmission(tx: Prisma.TransactionClient): Promise<Date | null> {
  const [lock] = await tx.$queryRaw<Array<{ acquired: boolean }>>(Prisma.sql`
    SELECT pg_try_advisory_xact_lock(hashtextextended(${OAUTH_ADMISSION_LOCK_KEY}, 0)) AS "acquired"
  `);
  if (lock === undefined || typeof lock.acquired !== "boolean") {
    throw new Error("MCP_EXPORT_OAUTH_ADMISSION_LOCK_UNAVAILABLE");
  }
  if (!lock.acquired) return null;
  return readOAuthDatabaseClock(tx);
}

async function readOAuthDatabaseClock(tx: Prisma.TransactionClient): Promise<Date> {
  const [clock] = await tx.$queryRaw<Array<{ now: Date }>>(Prisma.sql`SELECT clock_timestamp() AS "now"`);
  if (clock === undefined || !(clock.now instanceof Date) || !Number.isFinite(clock.now.getTime())) {
    throw new Error("MCP_EXPORT_OAUTH_DATABASE_CLOCK_UNAVAILABLE");
  }
  return clock.now;
}

export type McpExportOAuthStateCleanupCounts = Readonly<{
  authorizationRequestsDeleted: number;
  codesDeleted: number;
  accessTokensDeleted: number;
  admissionBudgetsDeleted: number;
}>;

async function pruneExpiredOAuthState(
  tx: Prisma.TransactionClient,
  now: Date,
): Promise<McpExportOAuthStateCleanupCounts> {
  const retentionCutoff = new Date(now.getTime() - OAUTH_ADMISSION_RETENTION_MS);
  const staleRequests = await tx.mcpExportOAuthAuthorizationRequest.findMany({
    where: { OR: [{ expiresAt: { lt: retentionCutoff } }, { resolvedAt: { lt: retentionCutoff } }] },
    orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
    take: OAUTH_STATE_CLEANUP_BATCH_SIZE,
    select: { id: true },
  });
  const staleCodes = await tx.mcpExportOAuthCode.findMany({
    where: { OR: [{ expiresAt: { lt: retentionCutoff } }, { consumedAt: { lt: retentionCutoff } }] },
    orderBy: [{ expiresAt: "asc" }, { codeHash: "asc" }],
    take: OAUTH_STATE_CLEANUP_BATCH_SIZE,
    select: { codeHash: true },
  });
  const staleTokens = await tx.mcpExportOAuthAccessToken.findMany({
    where: { OR: [{ expiresAt: { lt: retentionCutoff } }, { revokedAt: { lt: retentionCutoff } }] },
    orderBy: [{ expiresAt: "asc" }, { tokenHash: "asc" }],
    take: OAUTH_STATE_CLEANUP_BATCH_SIZE,
    select: { tokenHash: true },
  });
  const staleBudgets = await tx.mcpExportOAuthAdmissionBudget.findMany({
    where: { windowStartedAt: { lt: retentionCutoff } },
    orderBy: [{ windowStartedAt: "asc" }, { scope: "asc" }, { keyFingerprint: "asc" }],
    take: OAUTH_STATE_CLEANUP_BATCH_SIZE,
    select: { scope: true, keyFingerprint: true },
  });

  const [requests, codes, accessTokens, admissionBudgets] = await Promise.all([
    staleRequests.length === 0 ? Promise.resolve({ count: 0 }) : tx.mcpExportOAuthAuthorizationRequest.deleteMany({
      where: { AND: [
        { id: { in: staleRequests.map(({ id }) => id) } },
        { OR: [{ expiresAt: { lt: retentionCutoff } }, { resolvedAt: { lt: retentionCutoff } }] },
      ] },
    }),
    staleCodes.length === 0 ? Promise.resolve({ count: 0 }) : tx.mcpExportOAuthCode.deleteMany({
      where: { AND: [
        { codeHash: { in: staleCodes.map(({ codeHash }) => codeHash) } },
        { OR: [{ expiresAt: { lt: retentionCutoff } }, { consumedAt: { lt: retentionCutoff } }] },
      ] },
    }),
    staleTokens.length === 0 ? Promise.resolve({ count: 0 }) : tx.mcpExportOAuthAccessToken.deleteMany({
      where: { AND: [
        { tokenHash: { in: staleTokens.map(({ tokenHash }) => tokenHash) } },
        { OR: [{ expiresAt: { lt: retentionCutoff } }, { revokedAt: { lt: retentionCutoff } }] },
      ] },
    }),
    staleBudgets.length === 0 ? Promise.resolve({ count: 0 }) : tx.mcpExportOAuthAdmissionBudget.deleteMany({
      where: { OR: staleBudgets.map(({ scope, keyFingerprint }) => ({
        scope, keyFingerprint, windowStartedAt: { lt: retentionCutoff },
      })) },
    }),
  ]);
  return Object.freeze({
    authorizationRequestsDeleted: requests.count,
    codesDeleted: codes.count,
    accessTokensDeleted: accessTokens.count,
    admissionBudgetsDeleted: admissionBudgets.count,
  });
}

/**
 * Prune bounded batches of OAuth state using the runtime database role.
 * This maintenance path deliberately ignores the public OAuth enable flag so
 * that historical rows continue to expire after OAuth has been disabled. A
 * try-lock avoids blocking request traffic or overlapping worker replicas.
 * Rows become eligible after 24 hours; periodic cleanup is asynchronous and
 * makes at most ten short transactions, each deleting at most 100 rows/table.
 */
export async function cleanupExpiredMcpExportOAuthState(
  db: PrismaClient = getDb(),
): Promise<McpExportOAuthStateCleanupCounts & Readonly<{ acquired: boolean }>> {
  try {
    let acquired = false;
    const totals = {
      authorizationRequestsDeleted: 0,
      codesDeleted: 0,
      accessTokensDeleted: 0,
      admissionBudgetsDeleted: 0,
    };
    for (let batch = 0; batch < OAUTH_STATE_CLEANUP_MAX_BATCHES_PER_RUN; batch += 1) {
      const result = await db.$transaction(async (tx) => {
        const now = await tryLockOAuthAdmission(tx);
        if (now === null) return { acquired: false, ...totals };
        return { acquired: true, ...await pruneExpiredOAuthState(tx, now) };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
      if (!result.acquired) break;
      acquired = true;
      totals.authorizationRequestsDeleted += result.authorizationRequestsDeleted;
      totals.codesDeleted += result.codesDeleted;
      totals.accessTokensDeleted += result.accessTokensDeleted;
      totals.admissionBudgetsDeleted += result.admissionBudgetsDeleted;
      if (result.authorizationRequestsDeleted + result.codesDeleted + result.accessTokensDeleted
        + result.admissionBudgetsDeleted === 0) break;
    }
    return Object.freeze({ acquired, ...totals });
  } catch {
    throw new Error("MCP_EXPORT_OAUTH_CLEANUP_UNAVAILABLE");
  }
}

async function saveAdmissionBucket(
  tx: Prisma.TransactionClient,
  scope: "client_hour" | "global_hour",
  keyFingerprint: string,
  existing: AdmissionBudgetRow,
  nextCount: number,
  now: Date,
): Promise<void> {
  if (existing === null) {
    await tx.mcpExportOAuthAdmissionBudget.create({
      data: { scope, keyFingerprint, windowStartedAt: now, attemptCount: nextCount, createdAt: now, updatedAt: now },
    });
    return;
  }
  const windowExpired = existing.windowStartedAt.getTime() + OAUTH_ADMISSION_HOUR_MS <= now.getTime();
  await tx.mcpExportOAuthAdmissionBudget.update({
    where: { scope_keyFingerprint: { scope, keyFingerprint } },
    data: { ...(windowExpired ? { windowStartedAt: now } : {}), attemptCount: nextCount, updatedAt: now },
  });
}

/** Persistent hour buckets use a transaction advisory lock shared by all app
 * replicas. No forwarded/client IP header is trusted: source identity is the
 * canonical CIMD URL plus a separate global bucket. */
export async function reserveMcpExportOAuthAuthorizationAttempt(
  clientIdInput: unknown,
  db: PrismaClient = getDb(),
): Promise<void> {
  if (!isMcpExportOAuthEnabled()) return fail("MCP_EXPORT_OAUTH_UNAUTHORIZED");
  const clientFingerprint = mcpExportOAuthClientAdmissionFingerprint(clientIdInput);
  let admitted: boolean;
  try {
    admitted = await db.$transaction(async (tx) => {
      const now = await lockOAuthAdmission(tx);
      await pruneExpiredOAuthState(tx, now);
      const [client, global] = await Promise.all([
        tx.mcpExportOAuthAdmissionBudget.findUnique({
          where: { scope_keyFingerprint: { scope: "client_hour", keyFingerprint: clientFingerprint } },
          select: { windowStartedAt: true, attemptCount: true },
        }),
        tx.mcpExportOAuthAdmissionBudget.findUnique({
          where: { scope_keyFingerprint: { scope: "global_hour", keyFingerprint: OAUTH_GLOBAL_ADMISSION_FINGERPRINT } },
          select: { windowStartedAt: true, attemptCount: true },
        }),
      ]);
      const clientCount = nextAdmissionAttemptCount(client, now, OAUTH_CLIENT_HOURLY_ATTEMPT_LIMIT);
      const globalCount = nextAdmissionAttemptCount(global, now, OAUTH_GLOBAL_HOURLY_ATTEMPT_LIMIT);
      if (clientCount === null || globalCount === null) return false;
      await saveAdmissionBucket(tx, "client_hour", clientFingerprint, client, clientCount, now);
      await saveAdmissionBucket(tx, "global_hour", OAUTH_GLOBAL_ADMISSION_FINGERPRINT, global, globalCount, now);
      return true;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  } catch {
    return fail("MCP_EXPORT_OAUTH_ADMISSION_UNAVAILABLE");
  }
  if (!admitted) return fail("MCP_EXPORT_OAUTH_RATE_LIMITED");
}

/** Keep outbound metadata retrieval bounded within each app process. The
 * database-backed hourly budgets provide the cross-replica bound. */
export async function withMcpExportOAuthCimdFetchSlot<T>(fetch: () => Promise<T>): Promise<T> {
  if (activeCimdFetches >= MAX_CONCURRENT_CIMD_FETCHES_PER_PROCESS) return fail("MCP_EXPORT_OAUTH_RATE_LIMITED");
  activeCimdFetches += 1;
  try {
    return await fetch();
  } finally {
    activeCimdFetches -= 1;
  }
}

export async function fetchMcpExportOAuthClientMetadata(
  clientIdInput: unknown,
  db: PrismaClient = getDb(),
): Promise<McpExportOAuthClientMetadata> {
  if (!isMcpExportOAuthEnabled()) return fail("MCP_EXPORT_OAUTH_UNAUTHORIZED");
  const clientId = canonicalClientId(clientIdInput);
  return withMcpExportOAuthCimdFetchSlot(async () => {
    await reserveMcpExportOAuthAuthorizationAttempt(clientId, db);
    let response: Awaited<ReturnType<typeof securePinnedHttpRequest>>;
    try {
      response = await securePinnedHttpRequest({
        url: clientId,
        allowPrivateNetwork: false,
        method: "GET",
        headers: { accept: "application/json" },
        maximumResponseBytes: 32 * 1024,
      });
    } catch {
      return fail("MCP_EXPORT_OAUTH_INVALID_CLIENT");
    }
    const contentType = response.headers["content-type"] ?? "";
    if (response.finalUrl !== clientId || response.status < 200 || response.status >= 300
      || !/^application\/(?:[A-Za-z0-9.+-]*\+)?json(?:\s*;|$)/iu.test(contentType)) {
      return fail("MCP_EXPORT_OAUTH_INVALID_CLIENT");
    }
    let value: unknown;
    try { value = JSON.parse(response.body.toString("utf8")); } catch { return fail("MCP_EXPORT_OAUTH_INVALID_CLIENT"); }
    return parseMcpExportOAuthClientMetadata(clientId, value);
  });
}

function singleParameter(params: URLSearchParams, key: string): string | null {
  const entries = params.getAll(key);
  return entries.length === 1 ? entries[0]! : null;
}

export type McpExportOAuthAuthorizationParameters = Readonly<{
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  resource: string;
  scopes: typeof MCP_EXPORT_OAUTH_SCOPE;
}>;

export function parseMcpExportOAuthAuthorizationParameters(params: URLSearchParams): McpExportOAuthAuthorizationParameters {
  const responseType = singleParameter(params, "response_type");
  const clientId = singleParameter(params, "client_id");
  const redirectUri = singleParameter(params, "redirect_uri");
  const state = singleParameter(params, "state");
  const codeChallenge = singleParameter(params, "code_challenge");
  const codeChallengeMethod = singleParameter(params, "code_challenge_method");
  const resource = singleParameter(params, "resource");
  const scopes = singleParameter(params, "scope");
  const allowed = new Set(["response_type", "client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method", "resource", "scope"]);
  if ([...params.keys()].some((key) => !allowed.has(key)) || responseType !== "code"
    || clientId === null || redirectUri === null || state === null || state.length < 1 || state.length > 512
    || codeChallenge === null || !SECRET_PATTERN.test(codeChallenge) || codeChallengeMethod !== "S256"
    || resource !== configuredResource() || scopes !== MCP_EXPORT_OAUTH_SCOPE) {
    return fail("MCP_EXPORT_OAUTH_INVALID_REQUEST");
  }
  return Object.freeze({ clientId: canonicalClientId(clientId), redirectUri: canonicalRedirectUri(redirectUri), state, codeChallenge, resource, scopes: MCP_EXPORT_OAUTH_SCOPE });
}

export function isMcpExportOAuthCsrfTokenValid(token: unknown, csrfHash: string): token is string {
  return typeof token === "string" && SECRET_PATTERN.test(token) && safeEqualHex(sha256(token), csrfHash);
}

export async function createMcpExportOAuthAuthorizationRequest(
  input: McpExportOAuthAuthorizationParameters,
  metadata: McpExportOAuthClientMetadata,
  db: PrismaClient = getDb(),
) {
  if (!isMcpExportOAuthEnabled()) return fail("MCP_EXPORT_OAUTH_UNAUTHORIZED");
  if (metadata.clientId !== input.clientId || !isMcpExportOAuthRedirectUriRegistered(metadata, input.redirectUri)
    || input.resource !== configuredResource()) return fail("MCP_EXPORT_OAUTH_INVALID_CLIENT");
  const requestId = randomUUID();
  const csrfToken = randomBytes(32).toString("base64url");
  let expiresAt: Date | null = null;
  await db.$transaction(async (tx) => {
    const createdAt = await lockOAuthAdmission(tx);
    await pruneExpiredOAuthState(tx, createdAt);
    const [perClientOutstanding, globalOutstanding] = await Promise.all([
      tx.mcpExportOAuthAuthorizationRequest.count({
        where: { clientId: input.clientId, resolvedAt: null, expiresAt: { gt: createdAt } },
      }),
      tx.mcpExportOAuthAuthorizationRequest.count({
        where: { resolvedAt: null, expiresAt: { gt: createdAt } },
      }),
    ]);
    if (perClientOutstanding >= OAUTH_CLIENT_OUTSTANDING_LIMIT
      || globalOutstanding >= OAUTH_GLOBAL_OUTSTANDING_LIMIT) return;
    expiresAt = new Date(createdAt.getTime() + OAUTH_AUTHORIZATION_REQUEST_TTL_MS);
    await tx.mcpExportOAuthAuthorizationRequest.create({
      data: {
        id: requestId,
        clientId: input.clientId,
        clientName: metadata.clientName,
        clientMetadataFingerprint: metadata.fingerprint,
        redirectUri: input.redirectUri,
        state: input.state,
        codeChallenge: input.codeChallenge,
        resource: input.resource,
        scopes: input.scopes,
        csrfHash: sha256(csrfToken),
        expiresAt,
        createdAt,
      },
    });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  if (expiresAt === null) return fail("MCP_EXPORT_OAUTH_RATE_LIMITED");
  return Object.freeze({ requestId, csrfToken, expiresAt });
}

export async function getMcpExportOAuthAuthorizationRequest(requestIdInput: unknown, db: PrismaClient = getDb()) {
  const parsedId = uuidSchema.safeParse(requestIdInput);
  if (!parsedId.success || !isMcpExportOAuthEnabled()) return fail("MCP_EXPORT_OAUTH_INVALID_REQUEST");
  const row = await db.mcpExportOAuthAuthorizationRequest.findUnique({
    where: { id: parsedId.data },
    select: { id: true, clientId: true, clientName: true, redirectUri: true, resource: true, scopes: true, expiresAt: true, resolvedAt: true },
  });
  if (row === null || row.resolvedAt !== null || row.expiresAt <= new Date()) return fail("MCP_EXPORT_OAUTH_INVALID_REQUEST");
  return Object.freeze(row);
}

/** Bind a browser authorization request to the first authenticated account
 * that opens its consent page. This prevents switching accounts between the
 * consent GET and POST while keeping the CSRF secret out of the database. */
export async function bindMcpExportOAuthAuthorizationRequest(
  actor: WebAiActor,
  requestIdInput: unknown,
  csrfToken: unknown,
  db: PrismaClient = getDb(),
) {
  const parsedId = uuidSchema.safeParse(requestIdInput);
  const accessVersion = actor.accountAccessVersion;
  if (!parsedId.success || !Number.isSafeInteger(accessVersion) || accessVersion === undefined || accessVersion < 1
    || !isMcpExportOAuthEnabled()) return fail("MCP_EXPORT_OAUTH_INVALID_REQUEST");
  await assertAccountAccessForActor(db, actor);
  return db.$transaction(async (tx) => {
    const request = await lockOAuthAuthorizationRequest(tx, parsedId.data);
    if (request === null || request.resolvedAt !== null || request.expiresAt <= new Date()
      || request.resource !== configuredResource() || !isMcpExportOAuthCsrfTokenValid(csrfToken, request.csrfHash)) {
      return fail("MCP_EXPORT_OAUTH_INVALID_REQUEST");
    }
    if (request.presentedToUserId !== null
      && (request.presentedToUserId !== actor.id || request.presentedToAccessVersion !== accessVersion)) {
      return fail("MCP_EXPORT_OAUTH_INVALID_REQUEST");
    }
    if (request.presentedToUserId === null) {
      await tx.mcpExportOAuthAuthorizationRequest.update({
        where: { id: request.id },
        data: { presentedToUserId: actor.id, presentedToAccessVersion: accessVersion },
      });
    }
    return Object.freeze({ id: request.id, clientId: request.clientId, clientName: request.clientName,
      redirectUri: request.redirectUri, resource: request.resource, scopes: request.scopes, expiresAt: request.expiresAt });
  });
}

export async function listMcpExportOAuthOwnerProjects(actor: WebAiActor, db: PrismaClient = getDb()) {
  await assertAccountAccessForActor(db, actor);
  const projects = await db.project.findMany({
    where: {
      archivedAt: null,
      OR: [
        { memberships: { some: { userId: actor.id, accessState: "confirmed", role: "owner" } } },
        { membershipInheritanceMode: "workspaceInherited", workspace: { memberships: {
          some: { userId: actor.id, accessState: "confirmed", role: { in: ["owner", "admin"] } },
        } } },
      ],
    },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: 100,
    select: { id: true, name: true },
  });
  return Object.freeze(projects.map((project) => Object.freeze({ id: project.id, name: project.name.slice(0, 160) })));
}

export type McpExportOAuthDecision = Readonly<{
  redirectUri: string;
  state: string;
  issuer: string;
  code: string | null;
  error: "access_denied" | null;
}>;

type OAuthAuthorizationRequestRow = Readonly<{
  id: string; clientId: string; clientName: string; clientMetadataFingerprint: string; redirectUri: string;
  state: string; codeChallenge: string; resource: string; scopes: string; csrfHash: string;
  presentedToUserId: string | null; presentedToAccessVersion: number | null;
  expiresAt: Date; resolvedAt: Date | null;
}>;

async function lockOAuthAuthorizationRequest(tx: Prisma.TransactionClient, id: string) {
  const rows = await tx.$queryRaw<OAuthAuthorizationRequestRow[]>(Prisma.sql`
    SELECT "id", "clientId", "clientName", "clientMetadataFingerprint", "redirectUri", "state",
      "codeChallenge", "resource", "scopes", "csrfHash", "presentedToUserId", "presentedToAccessVersion", "expiresAt", "resolvedAt"
    FROM "McpExportOAuthAuthorizationRequest" WHERE "id" = ${id}::uuid FOR UPDATE
  `);
  return rows[0] ?? null;
}

async function issueMcpExportOAuthGrantAndCode(
  tx: Prisma.TransactionClient,
  request: OAuthAuthorizationRequestRow,
  owner: WebAiActor,
  projectId: string,
) {
  const now = new Date();
  const activeGrants = await tx.mcpExportGrant.count({ where: { ownerUserId: owner.id, revokedAt: null, expiresAt: { gt: now } } });
  if (activeGrants >= MAX_ACTIVE_MCP_EXPORT_GRANTS_PER_OWNER) return fail("MCP_EXPORT_OAUTH_INVALID_REQUEST");
  // The legacy table requires tokenHash. This random digest is only a shape
  // placeholder: its raw value is discarded, and legacy auth rejects oauth grants.
  const unissuedPlaceholder = randomBytes(32).toString("base64url");
  const grant = await tx.mcpExportGrant.create({
    data: {
      projectId,
      ownerUserId: owner.id,
      ownerAccessVersion: owner.accountAccessVersion ?? 1,
      grantType: "oauth",
      oauthClientId: request.clientId,
      oauthClientName: request.clientName,
      oauthRedirectUri: request.redirectUri,
      oauthScopes: MCP_EXPORT_OAUTH_SCOPE,
      label: request.clientName.slice(0, 80),
      tokenHash: sha256(unissuedPlaceholder),
      expiresAt: new Date(now.getTime() + OAUTH_GRANT_TTL_MS),
    },
    select: { id: true, expiresAt: true },
  });
  const code = `apos_mcp_code_${randomBytes(32).toString("base64url")}`;
  const codeExpiresAt = new Date(Math.min(now.getTime() + OAUTH_AUTHORIZATION_CODE_TTL_MS, grant.expiresAt.getTime()));
  await tx.mcpExportOAuthCode.create({
    data: {
      codeHash: sha256(code), grantId: grant.id, clientId: request.clientId,
      redirectUri: request.redirectUri, resource: request.resource, scopes: request.scopes,
      codeChallenge: request.codeChallenge, expiresAt: codeExpiresAt,
    },
  });
  await tx.mcpExportOAuthAuthorizationRequest.update({ where: { id: request.id }, data: { resolvedAt: now } });
  const config = getMcpExportOAuthConfiguration();
  if (config === null) return fail("MCP_EXPORT_OAUTH_UNAUTHORIZED");
  return Object.freeze({ redirectUri: request.redirectUri, state: request.state, issuer: config.issuer, code, error: null });
}

export async function decideMcpExportOAuthAuthorization(
  actor: WebAiActor,
  input: Readonly<{ requestId: unknown; csrfToken: unknown; decision: unknown; projectId?: unknown }>,
  db: PrismaClient = getDb(),
  dependencies: Readonly<{ fetchClientMetadata?: typeof fetchMcpExportOAuthClientMetadata }> = {},
): Promise<McpExportOAuthDecision> {
  if (!isMcpExportOAuthEnabled()) return fail("MCP_EXPORT_OAUTH_UNAUTHORIZED");
  const parsedId = uuidSchema.safeParse(input.requestId);
  const parsedDecision = z.enum(["approve", "deny"]).safeParse(input.decision);
  if (!parsedId.success || !parsedDecision.success) return fail("MCP_EXPORT_OAUTH_INVALID_REQUEST");
  const id = parsedId.data;
  const seed = await db.mcpExportOAuthAuthorizationRequest.findUnique({
    where: { id }, select: { clientId: true, csrfHash: true, expiresAt: true, resolvedAt: true,
      presentedToUserId: true, presentedToAccessVersion: true },
  });
  if (seed === null) return fail("MCP_EXPORT_OAUTH_INVALID_REQUEST");
  if (seed.resolvedAt !== null || seed.expiresAt <= new Date()
    || seed.presentedToUserId !== actor.id || seed.presentedToAccessVersion !== actor.accountAccessVersion
    || !isMcpExportOAuthCsrfTokenValid(input.csrfToken, seed.csrfHash)) return fail("MCP_EXPORT_OAUTH_INVALID_REQUEST");
  let metadata: McpExportOAuthClientMetadata | null = null;
  if (parsedDecision.data === "approve") {
    metadata = await (dependencies.fetchClientMetadata ?? fetchMcpExportOAuthClientMetadata)(seed.clientId);
  }

  if (parsedDecision.data === "deny") {
    await assertAccountAccessForActor(db, actor);
    return db.$transaction(async (tx) => {
      const request = await lockOAuthAuthorizationRequest(tx, id);
      if (request === null || request.resolvedAt !== null || request.expiresAt <= new Date()
        || !isMcpExportOAuthCsrfTokenValid(input.csrfToken, request.csrfHash)
        || request.presentedToUserId !== actor.id || request.presentedToAccessVersion !== actor.accountAccessVersion
        || request.resource !== configuredResource()) return fail("MCP_EXPORT_OAUTH_INVALID_REQUEST");
      const config = getMcpExportOAuthConfiguration();
      if (config === null) return fail("MCP_EXPORT_OAUTH_UNAUTHORIZED");
      const now = new Date();
      await tx.mcpExportOAuthAuthorizationRequest.update({ where: { id }, data: { resolvedAt: now } });
      return Object.freeze({ redirectUri: request.redirectUri, state: request.state, issuer: config.issuer, code: null, error: "access_denied" as const });
    });
  }
  const projectId = uuidSchema.safeParse(input.projectId);
  if (!projectId.success) return fail("MCP_EXPORT_OAUTH_INVALID_REQUEST");
  try {
    return await withWebAiProjectAccessTransaction(db, { actor, projectId: projectId.data, required: "owner" }, async (tx, admission) => {
      // Reuse the transaction and authorization fence already held by the
      // project access admission; no network work occurs after this point.
      const request = await lockOAuthAuthorizationRequest(tx, id);
      if (request === null || request.resolvedAt !== null || request.expiresAt <= new Date()
        || !isMcpExportOAuthCsrfTokenValid(input.csrfToken, request.csrfHash)
        || request.presentedToUserId !== admission.actor.id || request.presentedToAccessVersion !== admission.actor.accountAccessVersion
        || request.resource !== configuredResource()) return fail("MCP_EXPORT_OAUTH_INVALID_REQUEST");
      if (metadata === null || metadata.clientId !== request.clientId
        || metadata.fingerprint !== request.clientMetadataFingerprint || !metadata.redirectUris.includes(request.redirectUri)) {
        return fail("MCP_EXPORT_OAUTH_INVALID_CLIENT");
      }
      return issueMcpExportOAuthGrantAndCode(tx, request, admission.actor, admission.project.id);
    });
  } catch (error) {
    if (error instanceof WebAiAccessError) return fail("MCP_EXPORT_OAUTH_ACCESS_DENIED");
    throw error;
  }

}

export type McpExportOAuthTokenRequest = Readonly<{
  grantType: "authorization_code";
  code: string;
  clientId: string;
  redirectUri: string;
  resource: string;
  codeVerifier: string;
}>;

export function parseMcpExportOAuthTokenRequest(params: URLSearchParams): McpExportOAuthTokenRequest {
  const grantType = singleParameter(params, "grant_type");
  const code = singleParameter(params, "code");
  const clientId = singleParameter(params, "client_id");
  const redirectUri = singleParameter(params, "redirect_uri");
  const resource = singleParameter(params, "resource");
  const codeVerifier = singleParameter(params, "code_verifier");
  const allowed = new Set(["grant_type", "code", "client_id", "redirect_uri", "resource", "code_verifier"]);
  if ([...params.keys()].some((key) => !allowed.has(key)) || grantType !== "authorization_code"
    || code === null || !/^apos_mcp_code_[A-Za-z0-9_-]{43}$/u.test(code)
    || clientId === null || redirectUri === null || resource === null
    || codeVerifier === null || codeVerifier.length < 43 || codeVerifier.length > 128
    || !/^[A-Za-z0-9._~-]+$/u.test(codeVerifier)) return fail("MCP_EXPORT_OAUTH_INVALID_GRANT");
  const normalizedClientId = canonicalClientId(clientId);
  const normalizedRedirectUri = canonicalRedirectUri(redirectUri);
  if (resource !== configuredResource()) return fail("MCP_EXPORT_OAUTH_INVALID_GRANT");
  return Object.freeze({ grantType: "authorization_code", code, clientId: normalizedClientId,
    redirectUri: normalizedRedirectUri, resource, codeVerifier });
}

function calculateCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

type OAuthCodeRow = Readonly<{
  id: string; codeHash: string; grantId: string; clientId: string; redirectUri: string;
  resource: string; scopes: string; codeChallenge: string; expiresAt: Date; consumedAt: Date | null;
}>;

async function lockOAuthCode(tx: Prisma.TransactionClient, codeHash: string): Promise<OAuthCodeRow | null> {
  const rows = await tx.$queryRaw<OAuthCodeRow[]>(Prisma.sql`
    SELECT "id", "codeHash", "grantId", "clientId", "redirectUri", "resource", "scopes", "codeChallenge", "expiresAt", "consumedAt"
    FROM "McpExportOAuthCode" WHERE "codeHash" = ${codeHash}::char(64) FOR UPDATE
  `);
  return rows[0] ?? null;
}

type OAuthGrantRow = Readonly<{
  id: string; projectId: string; ownerUserId: string; ownerAccessVersion: number;
  grantType: string; oauthClientId: string | null; oauthRedirectUri: string | null; oauthScopes: string | null;
  revokedAt: Date | null; expiresAt: Date; label: string;
}>;

async function lockOAuthGrant(tx: Prisma.TransactionClient, grantId: string): Promise<OAuthGrantRow | null> {
  const rows = await tx.$queryRaw<OAuthGrantRow[]>(Prisma.sql`
    SELECT "id", "projectId", "ownerUserId", "ownerAccessVersion", "grantType", "oauthClientId",
      "oauthRedirectUri", "oauthScopes", "revokedAt", "expiresAt", "label"
    FROM "McpExportGrant" WHERE "id" = ${grantId}::uuid FOR SHARE
  `);
  return rows[0] ?? null;
}

export async function exchangeMcpExportOAuthAuthorizationCode(
  input: McpExportOAuthTokenRequest,
  db: PrismaClient = getDb(),
) {
  if (!isMcpExportOAuthEnabled()) return fail("MCP_EXPORT_OAUTH_UNAUTHORIZED");
  const codeHash = sha256(input.code);
  const seed = await db.mcpExportOAuthCode.findUnique({ where: { codeHash }, select: { grantId: true } });
  if (seed === null) return fail("MCP_EXPORT_OAUTH_INVALID_GRANT");
  const grantSeed = await db.mcpExportGrant.findUnique({
    where: { id: seed.grantId }, select: { id: true, projectId: true, ownerUserId: true, ownerAccessVersion: true, grantType: true },
  });
  if (grantSeed === null || grantSeed.grantType !== "oauth") return fail("MCP_EXPORT_OAUTH_INVALID_GRANT");
  const owner = await db.appUser.findUnique({ where: { id: grantSeed.ownerUserId }, select: { id: true, role: true } });
  if (owner === null) return fail("MCP_EXPORT_OAUTH_INVALID_GRANT");
  try {
    return await withWebAiProjectAccessTransaction(db, {
      actor: { id: owner.id, role: owner.role, accountAccessVersion: grantSeed.ownerAccessVersion },
      projectId: grantSeed.projectId,
      required: "owner",
    }, async (tx, admission) => {
      const code = await lockOAuthCode(tx, codeHash);
      const grant = await lockOAuthGrant(tx, grantSeed.id);
      const now = new Date();
      if (code === null || grant === null || code.grantId !== grant.id || code.consumedAt !== null || code.expiresAt <= now
        || grant.projectId !== admission.project.id || grant.ownerUserId !== admission.actor.id
        || grant.ownerAccessVersion !== admission.actor.accountAccessVersion || grant.grantType !== "oauth"
        || grant.revokedAt !== null || grant.expiresAt <= now
        || grant.oauthClientId !== input.clientId || grant.oauthRedirectUri !== input.redirectUri
        || grant.oauthScopes !== MCP_EXPORT_OAUTH_SCOPE
        || code.clientId !== input.clientId || code.redirectUri !== input.redirectUri
        || code.resource !== input.resource || code.resource !== configuredResource()
        || code.scopes !== MCP_EXPORT_OAUTH_SCOPE || code.codeChallenge !== calculateCodeChallenge(input.codeVerifier)) {
        return fail("MCP_EXPORT_OAUTH_INVALID_GRANT");
      }
      const token = `apos_mcp_oauth_${randomBytes(32).toString("base64url")}`;
      const expiresAt = new Date(Math.min(
        now.getTime() + MCP_EXPORT_OAUTH_ACCESS_TOKEN_TTL_SECONDS * 1_000,
        grant.expiresAt.getTime(),
      ));
      const expiresIn = Math.max(1, Math.floor((expiresAt.getTime() - now.getTime()) / 1_000));
      await tx.mcpExportOAuthCode.update({ where: { id: code.id }, data: { consumedAt: now } });
      await tx.mcpExportOAuthAccessToken.create({
        data: { tokenHash: sha256(token), grantId: grant.id, clientId: input.clientId, resource: input.resource,
          scopes: MCP_EXPORT_OAUTH_SCOPE, expiresAt },
      });
      return Object.freeze({ accessToken: token, tokenType: "Bearer" as const,
        expiresIn, scope: MCP_EXPORT_OAUTH_SCOPE });
    });
  } catch (error) {
    if (error instanceof WebAiAccessError) return fail("MCP_EXPORT_OAUTH_INVALID_GRANT");
    throw error;
  }
}

export type McpExportOAuthAccessSeed = Readonly<{
  tokenId: string;
  tokenHash: string;
  grantId: string;
  clientId: string;
  resource: string;
  scopes: string;
  tokenExpiresAt: Date;
  tokenRevokedAt: Date | null;
  grant: OAuthGrantRow;
}>;

export function parseMcpExportOAuthBearer(authorization: string | null): string | null {
  if (authorization === null || !authorization.startsWith("Bearer ")) return null;
  const token = authorization.slice(7);
  return /^apos_mcp_oauth_[A-Za-z0-9_-]{43}$/u.test(token) ? token : null;
}

export async function findMcpExportOAuthAccessSeed(
  token: string,
  db: PrismaClient = getDb(),
): Promise<McpExportOAuthAccessSeed | null> {
  if (!isMcpExportOAuthEnabled()) return null;
  const tokenHash = sha256(token);
  const row = await db.mcpExportOAuthAccessToken.findUnique({
    where: { tokenHash },
    select: {
      id: true, tokenHash: true, grantId: true, clientId: true, resource: true, scopes: true, expiresAt: true, revokedAt: true,
      grant: { select: { id: true, projectId: true, ownerUserId: true, ownerAccessVersion: true, grantType: true,
        oauthClientId: true, oauthRedirectUri: true, oauthScopes: true, revokedAt: true, expiresAt: true, label: true } },
    },
  });
  if (row === null) return null;
  const now = new Date();
  if (row.revokedAt !== null || row.expiresAt <= now || row.resource !== configuredResource()
    || row.scopes !== MCP_EXPORT_OAUTH_SCOPE || row.grant.grantType !== "oauth"
    || row.grant.oauthClientId !== row.clientId || row.grant.oauthRedirectUri === null
    || row.grant.oauthScopes !== MCP_EXPORT_OAUTH_SCOPE) return null;
  return Object.freeze({ tokenId: row.id, tokenHash: row.tokenHash, grantId: row.grantId,
    clientId: row.clientId, resource: row.resource, scopes: row.scopes, tokenExpiresAt: row.expiresAt,
    tokenRevokedAt: row.revokedAt, grant: row.grant });
}

export async function revokeMcpExportOAuthAccessTokensForGrant(grantId: string, db: Prisma.TransactionClient): Promise<void> {
  await db.mcpExportOAuthAccessToken.updateMany({ where: { grantId, revokedAt: null }, data: { revokedAt: new Date() } });
}

export function getMcpExportOAuthIssuer(): string | null {
  return isMcpExportOAuthEnabled() ? getMcpExportPublicOrigin() : null;
}
