import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PlatformTokenGrantMutationAction, type PlatformTokenGrantMutationPreview, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { assertAccountAccessForActor } from "@/lib/account-access-guard";
import { assertEntitlementWriterSession, getEntitlementDb, isEntitlementDatabase } from "@/lib/db";

export const PLATFORM_CREDIT_GOVERNANCE_PREVIEW_TTL_MS = 5 * 60 * 1_000;
export const PLATFORM_CREDIT_GOVERNANCE_MAX_AMOUNT = 10_000_000;
export const PLATFORM_CREDIT_GOVERNANCE_MAX_BODY_BYTES = 32 * 1_024;
const GOVERNANCE_LOCK_NAMESPACE = 29082028;
const USER_LOCK_NAMESPACE = 29082027;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const REQUEST_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,180}$/u;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export type PlatformCreditGovernanceActor = Readonly<{
  id: string;
  role: string;
  accountAccessVersion?: number;
}>;

export type PlatformCreditGovernanceErrorCode =
  | "PLATFORM_CREDIT_GOVERNANCE_INVALID_INPUT"
  | "PLATFORM_CREDIT_GOVERNANCE_ADMIN_REQUIRED"
  | "PLATFORM_CREDIT_GOVERNANCE_USER_NOT_FOUND"
  | "PLATFORM_CREDIT_GOVERNANCE_USER_DISABLED"
  | "PLATFORM_CREDIT_GOVERNANCE_GRANT_NOT_FOUND"
  | "PLATFORM_CREDIT_GOVERNANCE_GRANT_NOT_MANUAL"
  | "PLATFORM_CREDIT_GOVERNANCE_GRANT_REVOKED"
  | "PLATFORM_CREDIT_GOVERNANCE_ALLOCATION_BLOCKED"
  | "PLATFORM_CREDIT_GOVERNANCE_CONFIRMATION_REQUIRED"
  | "PLATFORM_CREDIT_GOVERNANCE_CONFIRMATION_MISMATCH"
  | "PLATFORM_CREDIT_GOVERNANCE_PREVIEW_STALE"
  | "PLATFORM_CREDIT_GOVERNANCE_PREVIEW_EXPIRED"
  | "PLATFORM_CREDIT_GOVERNANCE_PREVIEW_CONSUMED"
  | "PLATFORM_CREDIT_GOVERNANCE_IDEMPOTENCY_CONFLICT"
  | "PLATFORM_CREDIT_GOVERNANCE_REQUEST_KEY_CONFLICT"
  | "PLATFORM_CREDIT_GOVERNANCE_UNSAFE_REASON"
  | "PLATFORM_CREDIT_GOVERNANCE_TRANSACTION_CONFLICT"
  | "PLATFORM_CREDIT_GOVERNANCE_WRITER_REQUIRED";

export class PlatformCreditGovernanceError extends Error {
  constructor(readonly code: PlatformCreditGovernanceErrorCode) {
    super(code);
    this.name = "PlatformCreditGovernanceError";
  }
}

function fail(code: PlatformCreditGovernanceErrorCode): never {
  throw new PlatformCreditGovernanceError(code);
}

function isPrismaClient(db: PlatformCreditGovernanceDb): db is PrismaClient {
  return typeof (db as unknown as { $transaction?: unknown }).$transaction === "function";
}

export type PlatformCreditGovernanceDb = PrismaClient | Prisma.TransactionClient;

function uuid(value: unknown, code: PlatformCreditGovernanceErrorCode = "PLATFORM_CREDIT_GOVERNANCE_INVALID_INPUT"): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) return fail(code);
  return value.toLowerCase();
}

function requestKey(value: unknown): string {
  if (typeof value !== "string" || !REQUEST_KEY_PATTERN.test(value)) return fail("PLATFORM_CREDIT_GOVERNANCE_INVALID_INPUT");
  return value;
}

function fingerprint(value: unknown): string {
  if (typeof value !== "string" || !FINGERPRINT_PATTERN.test(value)) return fail("PLATFORM_CREDIT_GOVERNANCE_INVALID_INPUT");
  return value.toLowerCase();
}

function safeReason(value: unknown): string {
  if (typeof value !== "string") return fail("PLATFORM_CREDIT_GOVERNANCE_INVALID_INPUT");
  const reason = value.trim();
  if (reason.length < 1 || reason.length > 500 || reason !== value || CONTROL_PATTERN.test(reason)) return fail("PLATFORM_CREDIT_GOVERNANCE_UNSAFE_REASON");
  if (/(?:password|passwd|secret|api[ _-]?key|bearer|access[ _-]?token|refresh[ _-]?token)/iu.test(reason)) return fail("PLATFORM_CREDIT_GOVERNANCE_UNSAFE_REASON");
  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu.test(reason)) return fail("PLATFORM_CREDIT_GOVERNANCE_UNSAFE_REASON");
  if (/(?:^|[^a-z0-9])[0-9a-f]{64}(?:$|[^a-z0-9])/iu.test(reason)) return fail("PLATFORM_CREDIT_GOVERNANCE_UNSAFE_REASON");
  if (/[A-Za-z0-9+/_=-]{32,}/u.test(reason)) return fail("PLATFORM_CREDIT_GOVERNANCE_UNSAFE_REASON");
  return reason;
}

function parseTimestamp(value: unknown): Date {
  if (typeof value !== "string" || !z.string().datetime({ offset: true }).safeParse(value).success) return fail("PLATFORM_CREDIT_GOVERNANCE_INVALID_INPUT");
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return fail("PLATFORM_CREDIT_GOVERNANCE_INVALID_INPUT");
  return parsed;
}

function hashFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function manualLedgerIdempotencyKey(action: "grant" | "revoke", actorId: string, requestKeyValue: string): string {
  // The request key is intentionally allowed to be long for the governance
  // API, while PlatformTokenLedgerEntry.idempotencyKey is capped at 180 bytes.
  // Hash only the actor/key suffix so the evidence remains deterministic and
  // bounded without copying user-controlled text into a ledger identifier.
  const suffix = createHash("sha256").update(`${actorId}:${requestKeyValue}`, "utf8").digest("hex");
  return `${action}:manual:${suffix}`;
}

async function databaseNow(db: PlatformCreditGovernanceDb): Promise<Date> {
  const rows = await db.$queryRaw<Array<{ now: Date }>>`SELECT (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) AS now`;
  const value = rows[0]?.now;
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new Error("PLATFORM_CREDIT_GOVERNANCE_DATABASE_TIME_INVALID");
  return value;
}

async function lockActors(db: PlatformCreditGovernanceDb, ids: readonly string[]): Promise<void> {
  for (const id of [...new Set(ids)].sort()) {
    await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${id}, ${USER_LOCK_NAMESPACE}))`;
  }
}

async function lockGrant(db: PlatformCreditGovernanceDb, grantId: string): Promise<void> {
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${grantId}, ${GOVERNANCE_LOCK_NAMESPACE}))`;
}

async function createGovernancePreview(db: PlatformCreditGovernanceDb, payload: Record<string, unknown>): Promise<void> {
  await db.$executeRaw`SELECT "platform_token_governance_preview"(${JSON.stringify(payload)}::jsonb)`;
}

async function applyGovernanceMutation(db: PlatformCreditGovernanceDb, payload: Record<string, unknown>): Promise<string> {
  const rows = await db.$queryRaw<Array<{ grant_id: string }>>`
    SELECT "platform_token_governance_apply"(${JSON.stringify(payload)}::jsonb)::text AS grant_id
  `;
  const grantId = rows[0]?.grant_id;
  if (grantId === undefined) return fail("PLATFORM_CREDIT_GOVERNANCE_TRANSACTION_CONFLICT");
  return grantId;
}

async function assertCurrentAdmin(db: PlatformCreditGovernanceDb, actor: PlatformCreditGovernanceActor): Promise<{ id: string; username: string; accountAccessVersion: number }> {
  if (typeof actor !== "object" || actor === null || actor.role !== "admin") return fail("PLATFORM_CREDIT_GOVERNANCE_ADMIN_REQUIRED");
  const actorId = uuid(actor.id, "PLATFORM_CREDIT_GOVERNANCE_ADMIN_REQUIRED");
  const current = await db.appUser.findUnique({ where: { id: actorId }, select: { id: true, username: true, role: true, disabledAt: true, accountAccessVersion: true } });
  if (current === null || current.role !== "admin" || current.disabledAt !== null) return fail("PLATFORM_CREDIT_GOVERNANCE_ADMIN_REQUIRED");
  if (actor.accountAccessVersion !== undefined && actor.accountAccessVersion !== current.accountAccessVersion) return fail("PLATFORM_CREDIT_GOVERNANCE_ADMIN_REQUIRED");
  try {
    await assertAccountAccessForActor(db, { id: current.id, accountAccessVersion: current.accountAccessVersion });
  } catch {
    return fail("PLATFORM_CREDIT_GOVERNANCE_ADMIN_REQUIRED");
  }
  return current;
}

async function governedTransaction<T>(db: PlatformCreditGovernanceDb, callback: (tx: PlatformCreditGovernanceDb, sqlGovernance: boolean) => Promise<T>): Promise<T> {
  if (!isPrismaClient(db)) return callback(db, false);
  return db.$transaction(async (tx) => {
    if (isEntitlementDatabase(db)) await assertEntitlementWriterSession(tx);
    // Transaction clients do not expose `$transaction`, so pass the
    // top-level capability explicitly instead of falling back to direct DML.
    return callback(tx, true);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 15_000 });
}

const previewGrantSchema = z.object({
  action: z.literal("grant"),
  userId: z.string().uuid(),
  amount: z.number().int().min(1).max(PLATFORM_CREDIT_GOVERNANCE_MAX_AMOUNT),
  expiresAt: z.string().datetime({ offset: true }),
  requestKey: z.string().regex(REQUEST_KEY_PATTERN),
  reason: z.string().min(1).max(500),
}).strict();
const previewRevokeSchema = z.object({
  action: z.literal("revoke"),
  grantId: z.string().uuid(),
  requestKey: z.string().regex(REQUEST_KEY_PATTERN),
  reason: z.string().min(1).max(500),
}).strict();
const previewSchema = z.discriminatedUnion("action", [previewGrantSchema, previewRevokeSchema]);

type ParsedPreviewInput = z.infer<typeof previewSchema>;

const executeSchema = z.object({
  action: z.enum(["grant", "revoke"]),
  userId: z.string().uuid(),
  grantId: z.string().uuid().nullable().optional(),
  amount: z.number().int().min(1).max(PLATFORM_CREDIT_GOVERNANCE_MAX_AMOUNT).nullable().optional(),
  expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
  previewId: z.string().uuid(),
  expectedVersion: z.number().int().min(1),
  expectedRemainingTokens: z.number().int().min(0).nullable().optional(),
  impactFingerprint: z.string().regex(FINGERPRINT_PATTERN),
  requestFingerprint: z.string().regex(FINGERPRINT_PATTERN),
  requestKey: z.string().regex(REQUEST_KEY_PATTERN),
  reason: z.string().min(1).max(500),
  previewIssuedAt: z.string().datetime({ offset: true }),
  previewExpiresAt: z.string().datetime({ offset: true }),
  confirmation: z.literal(true),
  confirmationUsername: z.string().min(1).max(64),
}).strict();
type ParsedExecuteInput = z.infer<typeof executeSchema>;

function parsePreviewInput(input: unknown): ParsedPreviewInput {
  const parsed = previewSchema.safeParse(input);
  if (!parsed.success) return fail("PLATFORM_CREDIT_GOVERNANCE_INVALID_INPUT");
  safeReason(parsed.data.reason);
  return parsed.data;
}

function parseExecuteInput(input: unknown): ParsedExecuteInput {
  const parsed = executeSchema.safeParse(input);
  if (!parsed.success) return fail("PLATFORM_CREDIT_GOVERNANCE_INVALID_INPUT");
  safeReason(parsed.data.reason);
  if (parsed.data.action === "grant") {
    if (parsed.data.grantId !== undefined && parsed.data.grantId !== null
      || parsed.data.amount === undefined || parsed.data.amount === null
      || parsed.data.expiresAt === undefined || parsed.data.expiresAt === null
      || parsed.data.expectedRemainingTokens !== undefined && parsed.data.expectedRemainingTokens !== null) {
      return fail("PLATFORM_CREDIT_GOVERNANCE_INVALID_INPUT");
    }
  } else if (parsed.data.grantId === undefined || parsed.data.grantId === null
    || parsed.data.amount !== undefined && parsed.data.amount !== null
    || parsed.data.expiresAt !== undefined && parsed.data.expiresAt !== null
    || parsed.data.expectedRemainingTokens === undefined || parsed.data.expectedRemainingTokens === null) {
    return fail("PLATFORM_CREDIT_GOVERNANCE_INVALID_INPUT");
  }
  return parsed.data;
}

type UserRow = Readonly<{ id: string; username: string; displayName: string | null; role: string; disabledAt: Date | null; accountAccessVersion: number }>;
async function loadUser(db: PlatformCreditGovernanceDb, userId: string): Promise<UserRow | null> {
  return db.appUser.findUnique({ where: { id: userId }, select: { id: true, username: true, displayName: true, role: true, disabledAt: true, accountAccessVersion: true } });
}

type GrantRow = Readonly<{ id: string; userId: string; kind: "signup" | "manual"; amount: number; remainingTokens: number; offerVersion: string; issuedAt: Date; expiresAt: Date; revokedAt: Date | null; version: number }>;
async function loadGrant(db: PlatformCreditGovernanceDb, grantId: string): Promise<GrantRow | null> {
  return db.platformTokenGrant.findUnique({ where: { id: grantId }, select: { id: true, userId: true, kind: true, amount: true, remainingTokens: true, offerVersion: true, issuedAt: true, expiresAt: true, revokedAt: true, version: true } });
}

async function blockerCount(db: PlatformCreditGovernanceDb, grantId: string): Promise<number> {
  const allocationDelegate = (db as unknown as { platformTokenReservationAllocation?: { count?: (args: Record<string, unknown>) => Promise<number> } }).platformTokenReservationAllocation;
  if (allocationDelegate?.count !== undefined) {
    return allocationDelegate.count({ where: { grantId, reservation: { status: { in: ["reserved", "held"] } } } });
  }
  return db.platformTokenReservation.count({ where: { grantId, status: { in: ["reserved", "held"] } } });
}

function grantStatus(grant: GrantRow, now: Date): "active" | "expired" | "revoked" {
  if (grant.revokedAt !== null) return "revoked";
  if (grant.expiresAt <= now) return "expired";
  return "active";
}

function impactForGrant(input: Readonly<{ userId: string; amount: number; expiresAt: Date; targetVersion: number }>): string {
  return hashFingerprint({ action: "grant", userId: input.userId, amount: input.amount, expiresAt: input.expiresAt.toISOString(), targetVersion: input.targetVersion });
}

function impactForRevoke(input: Readonly<{ grant: GrantRow; blockers: number }>): string {
  return hashFingerprint({ action: "revoke", grantId: input.grant.id, userId: input.grant.userId, version: input.grant.version, remainingTokens: input.grant.remainingTokens, blockers: input.blockers, kind: input.grant.kind, revokedAt: input.grant.revokedAt?.toISOString() ?? null });
}

export function platformCreditGovernanceRequestFingerprint(input: Readonly<{ action: "grant" | "revoke"; userId: string; grantId?: string | null; amount?: number | null; expiresAt?: string | Date | null; expectedVersion: number; expectedRemainingTokens?: number | null; impactFingerprint: string; requestKey: string; reason: string; previewIssuedAt: string | Date; previewExpiresAt: string | Date }>): string {
  return hashFingerprint({
    action: input.action,
    userId: uuid(input.userId),
    grantId: input.grantId === undefined || input.grantId === null ? null : uuid(input.grantId),
    amount: input.amount ?? null,
    expiresAt: input.expiresAt instanceof Date ? input.expiresAt.toISOString() : input.expiresAt ?? null,
    expectedVersion: input.expectedVersion,
    expectedRemainingTokens: input.expectedRemainingTokens ?? null,
    impactFingerprint: fingerprint(input.impactFingerprint),
    requestKey: requestKey(input.requestKey),
    reason: safeReason(input.reason),
    previewIssuedAt: input.previewIssuedAt instanceof Date ? input.previewIssuedAt.toISOString() : parseTimestamp(input.previewIssuedAt).toISOString(),
    previewExpiresAt: input.previewExpiresAt instanceof Date ? input.previewExpiresAt.toISOString() : parseTimestamp(input.previewExpiresAt).toISOString(),
  });
}

type PublicPreview = Readonly<{
  previewId: string;
  action: PlatformTokenGrantMutationAction;
  target: Readonly<{ id: string; username: string; displayName: string | null; disabled: boolean }>;
  grant: Readonly<{ id: string | null; amount: number | null; expiresAt: Date | null; remainingTokens: number | null; version: number }>;
  reclaimableTokens: number;
  blockerCount: number;
  blockingCategories: readonly string[];
  canExecute: boolean;
  expectedVersion: number;
  expectedRemainingTokens: number | null;
  impactFingerprint: string;
  requestFingerprint: string;
  requestKey: string;
  reason: string;
  issuedAt: Date;
  expiresAt: Date;
}>;

type PreviewRow = PlatformTokenGrantMutationPreview;
function publicPreview(row: PreviewRow, user: UserRow, grant: GrantRow | null, blockers: number): PublicPreview {
  return Object.freeze({
    previewId: row.id,
    action: row.action,
    target: Object.freeze({ id: user.id, username: user.username, displayName: user.displayName, disabled: user.disabledAt !== null }),
    grant: Object.freeze({ id: grant?.id ?? null, amount: row.amount ?? grant?.amount ?? null, expiresAt: row.expiresAt ?? grant?.expiresAt ?? null, remainingTokens: grant?.remainingTokens ?? null, version: row.expectedVersion }),
    reclaimableTokens: row.reclaimableTokens ?? 0,
    blockerCount: blockers,
    blockingCategories: Object.freeze(blockers > 0 ? ["active_reservation_allocation"] : []),
    canExecute: blockers === 0 && (row.action === "revoke" || user.disabledAt === null),
    expectedVersion: row.expectedVersion,
    expectedRemainingTokens: row.expectedRemainingTokens ?? null,
    impactFingerprint: row.impactFingerprint,
    requestFingerprint: row.requestFingerprint,
    requestKey: row.requestKey,
    reason: row.reason,
    issuedAt: row.issuedAt,
    expiresAt: row.previewExpiresAt,
  });
}

async function findExistingPreview(db: PlatformCreditGovernanceDb, actorId: string, key: string): Promise<PreviewRow | null> {
  return db.platformTokenGrantMutationPreview.findFirst({ where: { actorId, requestKey: key }, orderBy: { createdAt: "asc" } });
}

function samePreviewRequest(row: PreviewRow, input: ParsedPreviewInput, grant: GrantRow | null): boolean {
  if (row.action !== input.action || row.requestKey !== input.requestKey || row.reason !== input.reason) return false;
  if (input.action === "grant") return row.userId === input.userId && row.amount === input.amount && row.expiresAt?.getTime() === parseTimestamp(input.expiresAt).getTime();
  return row.grantId === input.grantId && grant?.id === input.grantId;
}

async function previewInTransaction(db: PlatformCreditGovernanceDb, actor: PlatformCreditGovernanceActor, input: ParsedPreviewInput, now: Date, sqlGovernance: boolean): Promise<PublicPreview> {
  const revokeGrant = input.action === "revoke" ? await loadGrant(db, uuid(input.grantId)) : null;
  if (input.action === "revoke" && revokeGrant === null) return fail("PLATFORM_CREDIT_GOVERNANCE_GRANT_NOT_FOUND");
  const targetId = input.action === "grant" ? uuid(input.userId) : revokeGrant!.userId;
  await lockActors(db, [actor.id, targetId]);
  // The first admin check happens before the transaction is opened.  Repeat
  // it after the actor lock so an account disable/role change cannot race this
  // preview and leave evidence issued by a stale administrator.
  await assertCurrentAdmin(db, { id: actor.id, role: "admin", accountAccessVersion: actor.accountAccessVersion });
  const target = await loadUser(db, targetId);
  if (target === null) return fail("PLATFORM_CREDIT_GOVERNANCE_USER_NOT_FOUND");
  if (target.role !== "user") return fail("PLATFORM_CREDIT_GOVERNANCE_USER_NOT_FOUND");
  const grant = revokeGrant;
  if (input.action === "revoke" && (grant === null || grant.userId !== target.id)) return fail("PLATFORM_CREDIT_GOVERNANCE_GRANT_NOT_FOUND");
  if (grant !== null) await lockGrant(db, grant.id);
  const existing = await findExistingPreview(db, actor.id, requestKey(input.requestKey));
  if (existing !== null) {
    if (!samePreviewRequest(existing, input, grant)) return fail("PLATFORM_CREDIT_GOVERNANCE_REQUEST_KEY_CONFLICT");
    if (existing.consumedAt !== null) return fail("PLATFORM_CREDIT_GOVERNANCE_PREVIEW_CONSUMED");
    if (existing.previewExpiresAt <= now) return fail("PLATFORM_CREDIT_GOVERNANCE_PREVIEW_EXPIRED");
    const existingBlockers = grant === null ? 0 : await blockerCount(db, grant.id);
    return publicPreview(existing, target, grant, existingBlockers);
  }
  if (input.action === "grant" && target.disabledAt !== null) return fail("PLATFORM_CREDIT_GOVERNANCE_USER_DISABLED");
  const amount = input.action === "grant" ? input.amount : null;
  const requestedExpiry = input.action === "grant" ? parseTimestamp(input.expiresAt) : null;
  if (requestedExpiry !== null && requestedExpiry <= now) return fail("PLATFORM_CREDIT_GOVERNANCE_INVALID_INPUT");
  const blockers = grant === null ? 0 : await blockerCount(db, grant.id);
  const impact = grant === null
    ? impactForGrant({ userId: target.id, amount: amount!, expiresAt: requestedExpiry!, targetVersion: target.accountAccessVersion })
    : impactForRevoke({ grant, blockers });
  const issuedAt = new Date(now.getTime());
  const expiresAt = new Date(issuedAt.getTime() + PLATFORM_CREDIT_GOVERNANCE_PREVIEW_TTL_MS);
  const expectedRemainingTokens = grant?.remainingTokens ?? null;
  const request = platformCreditGovernanceRequestFingerprint({
    action: input.action, userId: target.id, grantId: grant?.id ?? null, amount, expiresAt: requestedExpiry,
    expectedVersion: grant?.version ?? target.accountAccessVersion, expectedRemainingTokens, impactFingerprint: impact,
    requestKey: input.requestKey, reason: input.reason, previewIssuedAt: issuedAt, previewExpiresAt: expiresAt,
  });
  const previewId = randomUUID();
  const previewData = {
      id: previewId, actorId: actor.id, userId: target.id, grantId: grant?.id ?? null, action: input.action,
      amount, expiresAt: requestedExpiry, reclaimableTokens: grant?.remainingTokens ?? 0,
      expectedVersion: grant?.version ?? target.accountAccessVersion, expectedRemainingTokens,
      requestKey: input.requestKey, reason: input.reason, impactFingerprint: impact, requestFingerprint: request,
      issuedAt, previewExpiresAt: expiresAt, createdAt: issuedAt,
    };
  if (sqlGovernance) await createGovernancePreview(db, previewData);
  else {
    await db.platformTokenGrantMutationPreview.create({ data: previewData });
  }
  const created = await db.platformTokenGrantMutationPreview.findUniqueOrThrow({ where: { id: previewId } });
  return publicPreview(created, target, grant, blockers);
}

export async function previewPlatformTokenGrantMutation(input: unknown, actor: PlatformCreditGovernanceActor, db: PlatformCreditGovernanceDb = getEntitlementDb()): Promise<PublicPreview> {
  const parsed = parsePreviewInput(input);
  return governedTransaction(db, async (tx, sqlGovernance) => {
    const current = await assertCurrentAdmin(tx, actor);
    return previewInTransaction(tx, { id: current.id, role: "admin", accountAccessVersion: current.accountAccessVersion }, parsed, await databaseNow(tx), sqlGovernance);
  });
}

type PublicMutationResult = Readonly<{
  action: PlatformTokenGrantMutationAction;
  grantId: string;
  userId: string;
  username: string;
  status: "active" | "expired" | "revoked";
  amount: number;
  remainingTokens: number;
  expiresAt: Date;
  version: number;
  reclaimableTokens: number;
  replayed?: boolean;
}>;

function publicMutation(grant: GrantRow, user: UserRow, action: PlatformTokenGrantMutationAction, reclaimableTokens: number, now: Date, replayed = false): PublicMutationResult {
  return Object.freeze({ action, grantId: grant.id, userId: grant.userId, username: user.username, status: grantStatus(grant, now), amount: grant.amount, remainingTokens: grant.remainingTokens, expiresAt: grant.expiresAt, version: grant.version, reclaimableTokens, ...(replayed ? { replayed: true } : {}) });
}

async function executeInTransaction(db: PlatformCreditGovernanceDb, actor: PlatformCreditGovernanceActor, input: ParsedExecuteInput, now: Date, sqlGovernance: boolean): Promise<PublicMutationResult> {
  if (input.confirmation !== true) return fail("PLATFORM_CREDIT_GOVERNANCE_CONFIRMATION_REQUIRED");
  const targetId = uuid(input.userId);
  await lockActors(db, [actor.id, targetId]);
  // Re-check the locked actor snapshot immediately before inspecting or
  // mutating the target.  This is the write-side counterpart to the preview
  // fence and keeps account-access linearization on the same lock namespace.
  const lockedActor = await assertCurrentAdmin(db, { id: actor.id, role: "admin", accountAccessVersion: actor.accountAccessVersion });
  const target = await loadUser(db, targetId);
  if (target === null) return fail("PLATFORM_CREDIT_GOVERNANCE_USER_NOT_FOUND");
  if (target.role !== "user") return fail("PLATFORM_CREDIT_GOVERNANCE_USER_NOT_FOUND");
  if (target.username !== input.confirmationUsername) return fail("PLATFORM_CREDIT_GOVERNANCE_CONFIRMATION_MISMATCH");
  const grant = input.grantId === null || input.grantId === undefined ? null : await loadGrant(db, uuid(input.grantId));
  if (input.action === "revoke") {
    if (grant === null || grant.userId !== target.id) return fail("PLATFORM_CREDIT_GOVERNANCE_GRANT_NOT_FOUND");
    await lockGrant(db, grant.id);
  }
  const preview = await db.platformTokenGrantMutationPreview.findUnique({ where: { id: uuid(input.previewId) } });
  if (preview === null || preview.actorId !== actor.id || preview.userId !== target.id || preview.action !== input.action || preview.requestKey !== input.requestKey) return fail("PLATFORM_CREDIT_GOVERNANCE_PREVIEW_STALE");
  if (preview.consumedAt !== null) return fail("PLATFORM_CREDIT_GOVERNANCE_PREVIEW_CONSUMED");
  if (preview.previewExpiresAt <= now || preview.issuedAt > now) return fail("PLATFORM_CREDIT_GOVERNANCE_PREVIEW_EXPIRED");
  if (preview.issuedAt.getTime() !== parseTimestamp(input.previewIssuedAt).getTime() || preview.previewExpiresAt.getTime() !== parseTimestamp(input.previewExpiresAt).getTime()) return fail("PLATFORM_CREDIT_GOVERNANCE_PREVIEW_STALE");
  const suppliedImpact = fingerprint(input.impactFingerprint);
  const expectedVersion = input.expectedVersion;
  const expectedRemainingTokens = input.expectedRemainingTokens ?? null;
  if (preview.expectedVersion !== expectedVersion || preview.expectedRemainingTokens !== expectedRemainingTokens || preview.impactFingerprint !== suppliedImpact) return fail("PLATFORM_CREDIT_GOVERNANCE_PREVIEW_STALE");
  const currentBlockers = grant === null ? 0 : await blockerCount(db, grant.id);
  const currentImpact = grant === null
    ? impactForGrant({ userId: target.id, amount: input.amount!, expiresAt: parseTimestamp(input.expiresAt!), targetVersion: target.accountAccessVersion })
    : impactForRevoke({ grant, blockers: currentBlockers });
  if (currentImpact !== suppliedImpact) return fail("PLATFORM_CREDIT_GOVERNANCE_PREVIEW_STALE");
  const calculatedRequest = platformCreditGovernanceRequestFingerprint({ action: input.action, userId: target.id, grantId: grant?.id ?? null, amount: input.amount ?? null, expiresAt: input.expiresAt === null || input.expiresAt === undefined ? null : parseTimestamp(input.expiresAt), expectedVersion, expectedRemainingTokens, impactFingerprint: suppliedImpact, requestKey: input.requestKey, reason: input.reason, previewIssuedAt: input.previewIssuedAt, previewExpiresAt: input.previewExpiresAt });
  if (calculatedRequest !== fingerprint(input.requestFingerprint) || preview.requestFingerprint !== calculatedRequest) return fail("PLATFORM_CREDIT_GOVERNANCE_IDEMPOTENCY_CONFLICT");
  if (input.action === "grant") {
    if (target.disabledAt !== null) return fail("PLATFORM_CREDIT_GOVERNANCE_USER_DISABLED");
    const amount = input.amount!;
    const expiresAt = parseTimestamp(input.expiresAt!);
    if (sqlGovernance) {
      const createdId = await applyGovernanceMutation(db, { action: "grant", actorId: lockedActor.id, userId: target.id,
        previewId: preview.id, requestKey: input.requestKey, requestFingerprint: calculatedRequest, impactFingerprint: suppliedImpact,
        newGrantId: randomUUID(), ledgerId: randomUUID(), auditId: randomUUID(), ledgerKey: manualLedgerIdempotencyKey("grant", lockedActor.id, input.requestKey), transitionAt: now.toISOString() });
      const created = await loadGrant(db, createdId);
      if (created === null) return fail("PLATFORM_CREDIT_GOVERNANCE_TRANSACTION_CONFLICT");
      return publicMutation(created, target, "grant", amount, now);
    }
    const created = await db.platformTokenGrant.create({ data: { id: randomUUID(), userId: target.id, kind: "manual", amount, remainingTokens: amount, offerVersion: "manual-governance-v1", offerAmount: null, offerValidForDays: null, eligibilityKey: null, eligibilitySource: null, issuedById: lockedActor.id, issuedAt: now, expiresAt, revokedAt: null, version: 1, createdAt: now }, select: { id: true, userId: true, kind: true, amount: true, remainingTokens: true, offerVersion: true, issuedAt: true, expiresAt: true, revokedAt: true, version: true } });
    await db.platformTokenLedgerEntry.create({ data: { id: randomUUID(), userId: target.id, grantId: created.id, entryKind: "grant", amount, reasonCode: "AI_MANUAL_GRANT", idempotencyKey: manualLedgerIdempotencyKey("grant", lockedActor.id, input.requestKey), metadata: { governance: "platform-credit-v1" }, createdAt: now } });
    const consumed = await db.platformTokenGrantMutationPreview.updateMany({ where: { id: preview.id, consumedAt: null }, data: { consumedAt: now } });
    if (consumed.count !== 1) return fail("PLATFORM_CREDIT_GOVERNANCE_TRANSACTION_CONFLICT");
    await db.platformTokenGrantAudit.create({ data: { id: randomUUID(), grantId: created.id, userId: target.id, actorId: lockedActor.id, event: "grant", versionBefore: 0, versionAfter: 1, statusBefore: "absent", statusAfter: "active", amount, remainingBefore: 0, remainingAfter: amount, previewId: preview.id, reason: input.reason, requestKey: input.requestKey, requestFingerprint: calculatedRequest, impactFingerprint: suppliedImpact, transitionAt: now, createdAt: now } });
    return publicMutation(created, target, "grant", amount, now);
  }
  if (grant === null || grant.kind !== "manual") return fail("PLATFORM_CREDIT_GOVERNANCE_GRANT_NOT_MANUAL");
  if (grant.revokedAt !== null) return fail("PLATFORM_CREDIT_GOVERNANCE_GRANT_REVOKED");
  if (currentBlockers > 0) return fail("PLATFORM_CREDIT_GOVERNANCE_ALLOCATION_BLOCKED");
  if (sqlGovernance) {
    await applyGovernanceMutation(db, { action: "revoke", actorId: lockedActor.id, userId: target.id, grantId: grant.id,
      previewId: preview.id, requestKey: input.requestKey, requestFingerprint: calculatedRequest, impactFingerprint: suppliedImpact,
      ledgerId: randomUUID(), auditId: randomUUID(), ledgerKey: manualLedgerIdempotencyKey("revoke", lockedActor.id, input.requestKey), transitionAt: now.toISOString() });
    const result = await loadGrant(db, grant.id);
    if (result === null) return fail("PLATFORM_CREDIT_GOVERNANCE_TRANSACTION_CONFLICT");
    return publicMutation(result, target, "revoke", grant.remainingTokens, now);
  }
  const updated = await db.platformTokenGrant.updateMany({ where: { id: grant.id, kind: "manual", revokedAt: null, version: grant.version }, data: { remainingTokens: 0, revokedAt: now, version: { increment: 1 } } });
  if (updated.count !== 1) return fail("PLATFORM_CREDIT_GOVERNANCE_PREVIEW_STALE");
  await db.platformTokenLedgerEntry.create({ data: { id: randomUUID(), userId: target.id, grantId: grant.id, entryKind: "adjustment", amount: -grant.remainingTokens, reasonCode: "AI_MANUAL_GRANT_REVOKED", idempotencyKey: manualLedgerIdempotencyKey("revoke", lockedActor.id, input.requestKey), metadata: { governance: "platform-credit-v1" }, createdAt: now } });
  const consumed = await db.platformTokenGrantMutationPreview.updateMany({ where: { id: preview.id, consumedAt: null }, data: { consumedAt: now } });
  if (consumed.count !== 1) return fail("PLATFORM_CREDIT_GOVERNANCE_TRANSACTION_CONFLICT");
  await db.platformTokenGrantAudit.create({ data: { id: randomUUID(), grantId: grant.id, userId: target.id, actorId: lockedActor.id, event: "revoke", versionBefore: grant.version, versionAfter: grant.version + 1, statusBefore: grantStatus(grant, now), statusAfter: "revoked", amount: grant.remainingTokens, remainingBefore: grant.remainingTokens, remainingAfter: 0, previewId: preview.id, reason: input.reason, requestKey: input.requestKey, requestFingerprint: calculatedRequest, impactFingerprint: suppliedImpact, transitionAt: now, createdAt: now } });
  const result = await loadGrant(db, grant.id);
  if (result === null) return fail("PLATFORM_CREDIT_GOVERNANCE_TRANSACTION_CONFLICT");
  return publicMutation(result, target, "revoke", grant.remainingTokens, now);
}

export async function executePlatformTokenGrantMutation(input: unknown, actor: PlatformCreditGovernanceActor, db: PlatformCreditGovernanceDb = getEntitlementDb()): Promise<PublicMutationResult> {
  const parsed = parseExecuteInput(input);
  return governedTransaction(db, async (tx, sqlGovernance) => {
    const current = await assertCurrentAdmin(tx, actor);
    const key = requestKey(parsed.requestKey);
    const canonicalUserId = uuid(parsed.userId);
    const canonicalPreviewId = uuid(parsed.previewId);
    const canonicalRequestFingerprint = fingerprint(parsed.requestFingerprint);
    await lockActors(tx, [current.id, canonicalUserId]);
    const lockedCurrent = await assertCurrentAdmin(tx, { id: current.id, role: "admin", accountAccessVersion: current.accountAccessVersion });
    const existing = await tx.platformTokenGrantAudit.findFirst({ where: { actorId: current.id, requestKey: key }, orderBy: { createdAt: "asc" } });
    if (existing !== null) {
      if (existing.event !== parsed.action
        || existing.requestFingerprint !== canonicalRequestFingerprint
        || existing.previewId !== canonicalPreviewId
        || existing.userId !== canonicalUserId) return fail("PLATFORM_CREDIT_GOVERNANCE_IDEMPOTENCY_CONFLICT");
      const existingUser = await loadUser(tx, existing.userId);
      const existingGrant = await loadGrant(tx, existing.grantId);
      if (existingUser === null || existingGrant === null) return fail("PLATFORM_CREDIT_GOVERNANCE_TRANSACTION_CONFLICT");
      return publicMutation(existingGrant, existingUser, existing.event, existing.event === "revoke" ? existing.remainingBefore : existing.amount, await databaseNow(tx), true);
    }
    return executeInTransaction(tx, { id: lockedCurrent.id, role: "admin", accountAccessVersion: lockedCurrent.accountAccessVersion }, parsed, await databaseNow(tx), sqlGovernance);
  });
}

export type PlatformCreditGrantListItem = Readonly<{
  id: string;
  userId: string;
  username: string;
  displayName: string | null;
  kind: "signup" | "manual";
  amount: number;
  remainingTokens: number;
  issuedAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  version: number;
  status: "active" | "expired" | "revoked";
  blockerCount: number;
}>;

export type PlatformCreditTargetUser = Readonly<{
  id: string;
  username: string;
  displayName: string | null;
  disabled: boolean;
  grantCount: number;
  activeGrantCount: number;
  availableTokens: number;
  reservedTokens: number;
  difference: "disabled" | "missing" | "available" | "exhausted" | "expired" | "revoked";
}>;

export async function listPlatformTokenGrants(input: Readonly<{
  userId?: string;
  search?: string;
  kind?: "signup" | "manual";
  status?: "active" | "expired" | "revoked";
  /** Legacy aliases for the grants table. */
  page?: number;
  pageSize?: number;
  grantPage?: number;
  grantPageSize?: number;
  userPage?: number;
  userPageSize?: number;
}>, actor: PlatformCreditGovernanceActor, db: PlatformCreditGovernanceDb = getEntitlementDb()): Promise<Readonly<{
  grants: readonly PlatformCreditGrantListItem[];
  users: readonly PlatformCreditTargetUser[];
  page: number;
  pageSize: number;
  hasNextPage: boolean;
  grantPage: number;
  grantPageSize: number;
  grantsHasNextPage: boolean;
  userPage: number;
  userPageSize: number;
  usersHasNextPage: boolean;
}>> {
  const current = await assertCurrentAdmin(db, actor);
  const requestedGrantPage = input.grantPage ?? input.page;
  const requestedGrantPageSize = input.grantPageSize ?? input.pageSize;
  const grantPage = Number.isSafeInteger(requestedGrantPage) && (requestedGrantPage ?? 1) >= 1 ? requestedGrantPage ?? 1 : 1;
  const grantPageSize = Number.isSafeInteger(requestedGrantPageSize) && (requestedGrantPageSize ?? 20) >= 1 ? Math.min(requestedGrantPageSize ?? 20, 100) : 20;
  const userPage = Number.isSafeInteger(input.userPage) && (input.userPage ?? 1) >= 1 ? input.userPage ?? 1 : 1;
  const userPageSize = Number.isSafeInteger(input.userPageSize) && (input.userPageSize ?? 20) >= 1 ? Math.min(input.userPageSize ?? 20, 100) : 20;
  const search = input.search?.trim().slice(0, 160) ?? "";
  const now = await databaseNow(db);
  const userWhere = {
    role: "user" as const,
    ...(input.userId === undefined ? {} : { id: input.userId }),
    ...(search.length === 0 ? {} : { OR: [{ username: { contains: search, mode: Prisma.QueryMode.insensitive } }, { displayName: { contains: search, mode: Prisma.QueryMode.insensitive } }] }),
  };
  const userRows = await db.appUser.findMany({
    where: userWhere,
    orderBy: [{ username: "asc" }, { id: "asc" }],
    skip: (userPage - 1) * userPageSize,
    take: userPageSize + 1,
    select: {
      id: true, username: true, displayName: true, disabledAt: true,
      platformTokenGrants: {
        select: {
          remainingTokens: true, expiresAt: true, revokedAt: true,
          allocations: {
            where: { reservation: { status: { in: ["reserved", "held"] } } },
            select: { reservedTokens: true, settledTokens: true, releasedTokens: true },
          },
        },
      },
    },
  });
  const usersHasNextPage = userRows.length > userPageSize;
  const users = userRows.slice(0, userPageSize);
  const statusWhere = input.status === undefined ? {} : input.status === "revoked"
    ? { revokedAt: { not: null } }
    : input.status === "expired"
      ? { revokedAt: null, expiresAt: { lte: now } }
      : { revokedAt: null, expiresAt: { gt: now } };
  const rows = await db.platformTokenGrant.findMany({
    where: { ...(input.kind === undefined ? {} : { kind: input.kind }), ...statusWhere, user: userWhere },
    orderBy: [{ issuedAt: "desc" }, { id: "desc" }], skip: (grantPage - 1) * grantPageSize, take: grantPageSize + 1,
    select: { id: true, userId: true, kind: true, amount: true, remainingTokens: true, issuedAt: true, expiresAt: true, revokedAt: true, version: true, offerVersion: true, user: { select: { username: true, displayName: true } } },
  });
  const grantsHasNextPage = rows.length > grantPageSize;
  const grants = await Promise.all(rows.slice(0, grantPageSize).map(async (row) => Object.freeze({ id: row.id, userId: row.userId, username: row.user.username, displayName: row.user.displayName, kind: row.kind, amount: row.amount, remainingTokens: row.remainingTokens, issuedAt: row.issuedAt, expiresAt: row.expiresAt, revokedAt: row.revokedAt, version: row.version, status: grantStatus(row, now), blockerCount: row.kind === "manual" ? await blockerCount(db, row.id) : 0 })));
  void current;
  return Object.freeze({ grants: Object.freeze(grants), users: Object.freeze(users.map((user) => {
    const active = user.platformTokenGrants.filter((grant) => grant.revokedAt === null && grant.expiresAt > now);
    const availableTokens = active.reduce((sum, grant) => sum + grant.remainingTokens, 0);
    const reservedTokens = active.reduce((sum, grant) => sum + grant.allocations.reduce((allocationSum, allocation) => allocationSum + allocation.reservedTokens - allocation.settledTokens - allocation.releasedTokens, 0), 0);
    const difference: PlatformCreditTargetUser["difference"] = user.disabledAt !== null ? "disabled"
      : user.platformTokenGrants.length === 0 ? "missing"
        : availableTokens > 0 ? "available"
          : active.length > 0 ? "exhausted"
            : user.platformTokenGrants.some((grant) => grant.revokedAt === null) ? "expired" : "revoked";
    return Object.freeze({ id: user.id, username: user.username, displayName: user.displayName, disabled: user.disabledAt !== null,
      grantCount: user.platformTokenGrants.length, activeGrantCount: active.length, availableTokens, reservedTokens, difference });
  })), page: grantPage, pageSize: grantPageSize, hasNextPage: grantsHasNextPage,
    grantPage, grantPageSize, grantsHasNextPage, userPage, userPageSize, usersHasNextPage });
}

// Aliases keep the control-plane API vocabulary explicit at call sites while
// allowing older tests and operational scripts to use the shorter names.
export const previewPlatformCreditGrant = previewPlatformTokenGrantMutation;
export const executePlatformCreditGrant = executePlatformTokenGrantMutation;
export const listPlatformCreditGrants = listPlatformTokenGrants;
