import { randomUUID } from "node:crypto";
import {
  Prisma,
  type AiOperation,
  type AiProviderConnection,
  type AppUserRole,
  type PlatformTokenReservationStatus,
  type PrismaClient,
  type ProjectAiRoute,
} from "@prisma/client";
import { getDb } from "@/lib/db";

/** The signup offer is a product constant, not a value supplied by a client. */
export const SIGNUP_TOKEN_AMOUNT = 500_000;
export const SIGNUP_TOKEN_TTL_DAYS = 30;
export const SIGNUP_OFFER_VERSION = "signup-500k-v1";

const LEDGER_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,180}$/u;
const RESERVATION_TTL_MS = 60 * 60 * 1_000;
const CONCURRENCY_LOCK_NAMESPACE = 29082027;

export type AiEntitlementErrorCode =
  | "AI_MEMBERSHIP_REQUIRED"
  | "AI_MEMBERSHIP_EXPIRED"
  | "AI_PROVIDER_SCOPE_FORBIDDEN"
  | "AI_PROVIDER_OWNER_REQUIRED"
  | "AI_ROUTE_CONFIGURATION_FORBIDDEN"
  | "AI_PLATFORM_TOKEN_EXHAUSTED"
  | "AI_PLATFORM_TOKEN_EXPIRED"
  | "AI_PLATFORM_CONCURRENCY_LIMIT"
  | "AI_MODEL_CAPABILITY_MISMATCH"
  | "AI_PROVIDER_CONNECTION_UNAVAILABLE"
  | "AI_PROVIDER_CALL_RECONCILIATION_REQUIRED"
  | "AI_PLATFORM_TOKEN_USAGE_UNVERIFIED";

export class AiEntitlementError extends Error {
  constructor(readonly code: AiEntitlementErrorCode) {
    super(code);
    this.name = "AiEntitlementError";
  }
}

export type EntitlementDb = PrismaClient | Prisma.TransactionClient;

function fail(code: AiEntitlementErrorCode): never {
  throw new AiEntitlementError(code);
}

function assertPositiveTokens(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 10_000_000) {
    return fail("AI_PLATFORM_TOKEN_EXHAUSTED");
  }
  return value;
}

function assertLedgerKey(value: string): string {
  if (!LEDGER_KEY_PATTERN.test(value)) return fail("AI_PROVIDER_CALL_RECONCILIATION_REQUIRED");
  return value;
}

function isPrismaClient(db: EntitlementDb): db is PrismaClient {
  return typeof (db as unknown as { $transaction?: unknown }).$transaction === "function";
}

async function serializable<T>(db: EntitlementDb, callback: (tx: EntitlementDb) => Promise<T>): Promise<T> {
  if (!isPrismaClient(db)) return callback(db);
  return db.$transaction((tx) => callback(tx), { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export type MembershipPublicStatus = Readonly<{
  status: "active" | "expired" | "revoked" | "none";
  startsAt: Date | null;
  expiresAt: Date | null;
  version: number | null;
}>;

export async function getMembershipStatus(
  userId: string,
  db: EntitlementDb = getDb(),
  now = new Date(),
): Promise<MembershipPublicStatus> {
  const subscription = await db.membershipSubscription.findUnique({
    where: { userId },
    select: { status: true, startsAt: true, expiresAt: true, version: true },
  });
  if (subscription === null) return Object.freeze({ status: "none", startsAt: null, expiresAt: null, version: null });
  if (subscription.status === "revoked") {
    return Object.freeze({ status: "revoked", startsAt: subscription.startsAt, expiresAt: subscription.expiresAt, version: subscription.version });
  }
  if (subscription.startsAt > now || subscription.expiresAt <= now) {
    return Object.freeze({ status: "expired", startsAt: subscription.startsAt, expiresAt: subscription.expiresAt, version: subscription.version });
  }
  return Object.freeze({ status: "active", startsAt: subscription.startsAt, expiresAt: subscription.expiresAt, version: subscription.version });
}

export async function assertActiveMembership(
  userId: string,
  db: EntitlementDb = getDb(),
  now = new Date(),
): Promise<void> {
  const status = await getMembershipStatus(userId, db, now);
  if (status.status === "none" || status.status === "revoked") return fail("AI_MEMBERSHIP_REQUIRED");
  if (status.status !== "active") return fail("AI_MEMBERSHIP_EXPIRED");
}

/**
 * Issue the verified-identity signup grant from inside the identity creation
 * transaction. The compound unique key makes retries and concurrent callbacks
 * idempotent; no caller should invoke this for invitations or local members.
 */
async function issueVerifiedSignupGrantInTransaction(
  userId: string,
  options: Readonly<{ issuedById?: string | null; now?: Date }>,
  db: EntitlementDb,
) {
  const now = options.now ?? new Date();
  const existing = await db.platformTokenGrant.findUnique({
    where: { userId_kind: { userId, kind: "signup" } },
  });
  if (existing !== null) return existing;

  const expiresAt = new Date(now.getTime() + SIGNUP_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1_000);
  // `skipDuplicates` turns a concurrent callback into the same idempotent
  // result without raising a unique violation inside the surrounding login
  // transaction (which must remain usable for session creation).
  const grantId = randomUUID();
  const inserted = await db.platformTokenGrant.createMany({
    data: {
      id: grantId,
      userId,
      kind: "signup",
      amount: SIGNUP_TOKEN_AMOUNT,
      remainingTokens: SIGNUP_TOKEN_AMOUNT,
      offerVersion: SIGNUP_OFFER_VERSION,
      issuedById: options.issuedById ?? null,
      issuedAt: now,
      expiresAt,
    },
    skipDuplicates: true,
  });
  if (inserted.count === 1) {
    await db.platformTokenLedgerEntry.createMany({
      data: {
        id: randomUUID(),
        userId,
        grantId,
        entryKind: "grant",
        amount: SIGNUP_TOKEN_AMOUNT,
        reasonCode: "AI_SIGNUP_GRANT",
        callKey: null,
        idempotencyKey: `grant:signup:${userId}`,
        metadata: { offerVersion: SIGNUP_OFFER_VERSION },
        createdAt: now,
      },
      skipDuplicates: true,
    });
  }
  return db.platformTokenGrant.findUniqueOrThrow({
    where: { userId_kind: { userId, kind: "signup" } },
  });
}

export async function issueVerifiedSignupGrant(
  userId: string,
  options: Readonly<{ issuedById?: string | null; now?: Date }> = {},
  db: EntitlementDb = getDb(),
) {
  // Auth callbacks pass a transaction client and therefore stay inside the
  // surrounding serializable identity-creation transaction. Direct callers
  // get the same isolation guarantee instead of relying on the unique index
  // alone for concurrent first-login callbacks.
  return serializable(db, (tx) => issueVerifiedSignupGrantInTransaction(userId, options, tx));
}

export type PlatformTokenReservationResult = Readonly<{
  reservationId: string;
  status: PlatformTokenReservationStatus;
  reservedTokens: number;
  settledTokens: number | null;
  billingMode: "platform";
  created: boolean;
}>;

export type PlatformTokenDispatchFenceResult = Readonly<{
  reservationId: string;
  status: PlatformTokenReservationStatus;
  reservedTokens: number;
  expiresAt: Date;
  allowed: boolean;
}>;

export type ExpiredReservationRecoveryResult = Readonly<{
  inspected: number;
  released: number;
  held: number;
}>;

/**
 * Serialize entitlement and membership transitions for one user. Membership
 * grant/revoke and provider verification use this same transaction-scoped
 * lock so a final eligibility check cannot race a revoke.
 */
export async function lockMembershipUser(db: EntitlementDb, userId: string): Promise<void> {
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, ${CONCURRENCY_LOCK_NAMESPACE}))`;
}

async function lockUser(db: EntitlementDb, userId: string): Promise<void> {
  await lockMembershipUser(db, userId);
}

const DISPATCH_EVIDENCE_STATES = ["dispatched", "acknowledged"] as const;

async function recoverExpiredPlatformTokenReservationsInTransaction(
  userId: string,
  now: Date,
  limit: number,
  db: EntitlementDb,
): Promise<ExpiredReservationRecoveryResult> {
  const reservations = await db.platformTokenReservation.findMany({
    where: { userId, status: "reserved", expiresAt: { lte: now } },
    orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
    take: limit,
    select: {
      id: true,
      grantId: true,
      jobId: true,
      callKey: true,
      reservedTokens: true,
      providerCallAudit: { select: { id: true } },
    },
  });
  let released = 0;
  let held = 0;
  for (const reservation of reservations) {
    const dispatchedAttempt = reservation.jobId === null
      ? null
      : await db.backgroundJobAttempt.findFirst({
          where: { jobId: reservation.jobId, dispatchState: { in: [...DISPATCH_EVIDENCE_STATES] } },
          select: { id: true },
        });
    const hasDispatchEvidence = reservation.providerCallAudit !== null || dispatchedAttempt !== null;
    if (hasDispatchEvidence) {
      const transitioned = await db.platformTokenReservation.updateMany({
        where: { id: reservation.id, status: "reserved" },
        data: { status: "held", reconciliationRequired: true, safeErrorCode: "AI_PROVIDER_CALL_RECONCILIATION_REQUIRED" },
      });
      if (transitioned.count !== 1) continue;
      await db.platformTokenLedgerEntry.createMany({
        data: {
          id: randomUUID(),
          userId,
          grantId: reservation.grantId,
          reservationId: reservation.id,
          entryKind: "hold",
          amount: 0,
          usageTokens: null,
          reasonCode: "AI_PROVIDER_CALL_RECONCILIATION_REQUIRED",
          callKey: reservation.callKey,
          idempotencyKey: `hold:${userId}:${reservation.callKey}`,
          metadata: { recovery: "expired-reservation" },
          createdAt: now,
        },
        skipDuplicates: true,
      });
      held += 1;
      continue;
    }

    const transitioned = await db.platformTokenReservation.updateMany({
      where: { id: reservation.id, status: "reserved" },
      data: { status: "released", releasedAt: now, reconciliationRequired: false, safeErrorCode: null },
    });
    if (transitioned.count !== 1) continue;
    await db.platformTokenGrant.update({ where: { id: reservation.grantId }, data: { remainingTokens: { increment: reservation.reservedTokens } } });
    await db.platformTokenLedgerEntry.createMany({
      data: {
        id: randomUUID(),
        userId,
        grantId: reservation.grantId,
        reservationId: reservation.id,
        entryKind: "release",
        amount: reservation.reservedTokens,
        usageTokens: null,
        reasonCode: "AI_PLATFORM_TOKEN_EXPIRED_RESERVATION_RELEASED",
        callKey: reservation.callKey,
        idempotencyKey: `release:${userId}:${reservation.callKey}`,
        metadata: { recovery: "expired-reservation" },
        createdAt: now,
      },
      skipDuplicates: true,
    });
    released += 1;
  }
  return Object.freeze({ inspected: reservations.length, released, held });
}

/**
 * Recover expired reservations only after checking whether there is evidence
 * that the provider could have been reached. A reservation with any audit or
 * dispatched attempt is held for reconciliation; only a provably pre-dispatch
 * reservation is released and credited back.
 */
export async function recoverExpiredPlatformTokenReservations(
  input: Readonly<{ userId: string; now?: Date; limit?: number }>,
  db: EntitlementDb = getDb(),
): Promise<ExpiredReservationRecoveryResult> {
  const now = input.now ?? new Date();
  const limit = Number.isSafeInteger(input.limit) && (input.limit ?? 100) > 0 ? Math.min(input.limit ?? 100, 500) : 100;
  return serializable(db, async (tx) => {
    await lockUser(tx, input.userId);
    return recoverExpiredPlatformTokenReservationsInTransaction(input.userId, now, limit, tx);
  });
}

export async function reservePlatformTokens(input: Readonly<{
  userId: string;
  jobId?: string | null;
  providerConnectionId?: string | null;
  callKey: string;
  operation: AiOperation;
  modelId: string;
  estimatedTokens: number;
  now?: Date;
}>, db: EntitlementDb = getDb()): Promise<PlatformTokenReservationResult> {
  const estimatedTokens = assertPositiveTokens(input.estimatedTokens);
  const callKey = assertLedgerKey(input.callKey);
  const now = input.now ?? new Date();
  return serializable(db, async (tx) => {
    await lockUser(tx, input.userId);
    await recoverExpiredPlatformTokenReservationsInTransaction(input.userId, now, 100, tx);
    const existing = await tx.platformTokenReservation.findUnique({
      where: { userId_callKey: { userId: input.userId, callKey } },
      select: { id: true, status: true, reservedTokens: true, settledTokens: true },
    });
    if (existing !== null) {
      return Object.freeze({ reservationId: existing.id, status: existing.status, reservedTokens: existing.reservedTokens, settledTokens: existing.settledTokens, billingMode: "platform" as const, created: false });
    }

    const grants = await tx.platformTokenGrant.findMany({
      where: { userId: input.userId, revokedAt: null, expiresAt: { gt: now }, remainingTokens: { gt: 0 } },
      orderBy: [{ expiresAt: "asc" }, { issuedAt: "asc" }, { id: "asc" }],
      select: { id: true, remainingTokens: true, expiresAt: true },
    });
    if (grants.length === 0) {
      const activeGrantCount = await tx.platformTokenGrant.count({ where: { userId: input.userId, revokedAt: null, expiresAt: { gt: now } } });
      if (activeGrantCount > 0) return fail("AI_PLATFORM_TOKEN_EXHAUSTED");
      const expiredGrantCount = await tx.platformTokenGrant.count({ where: { userId: input.userId, expiresAt: { lte: now } } });
      return fail(expiredGrantCount > 0 ? "AI_PLATFORM_TOKEN_EXPIRED" : "AI_PLATFORM_TOKEN_EXHAUSTED");
    }
    const grant = grants.find((candidate) => candidate.remainingTokens >= estimatedTokens);
    if (grant === undefined) return fail("AI_PLATFORM_TOKEN_EXHAUSTED");
    const updated = await tx.platformTokenGrant.updateMany({
      where: { id: grant.id, remainingTokens: { gte: estimatedTokens }, revokedAt: null, expiresAt: { gt: now } },
      data: { remainingTokens: { decrement: estimatedTokens } },
    });
    if (updated.count !== 1) return fail("AI_PLATFORM_TOKEN_EXHAUSTED");
    const reservationId = randomUUID();
    const reservation = await tx.platformTokenReservation.create({
      data: {
        id: reservationId,
        userId: input.userId,
        grantId: grant.id,
        jobId: input.jobId ?? null,
        providerConnectionId: input.providerConnectionId ?? null,
        callKey,
        operation: input.operation,
        modelId: input.modelId,
        reservedTokens: estimatedTokens,
        expiresAt: new Date(Math.min(grant.expiresAt.getTime(), now.getTime() + RESERVATION_TTL_MS)),
        createdAt: now,
        ledgerEntries: {
          create: {
            id: randomUUID(),
            userId: input.userId,
            grantId: grant.id,
            entryKind: "reserve",
            amount: -estimatedTokens,
            reasonCode: "AI_PLATFORM_TOKEN_RESERVED",
            callKey,
            idempotencyKey: `reserve:${input.userId}:${callKey}`,
            metadata: { operation: input.operation, modelId: input.modelId },
            createdAt: now,
          },
        },
      },
      select: { id: true, status: true, reservedTokens: true, settledTokens: true },
    });
    return Object.freeze({ reservationId: reservation.id, status: reservation.status, reservedTokens: reservation.reservedTokens, settledTokens: reservation.settledTokens, billingMode: "platform" as const, created: true });
  });
}

/**
 * Establish the final, user-serialized admission point immediately before a
 * platform provider call. Recovery and this fence use the same advisory lock:
 * if recovery wins, the reservation is released/held before the worker can
 * proceed; if the fence wins, the persisted dispatch evidence makes later
 * recovery hold rather than refund the reservation.
 */
export async function acquirePlatformTokenDispatchFence(input: Readonly<{
  userId: string;
  callKey: string;
  now?: Date;
}>, db: EntitlementDb = getDb()): Promise<PlatformTokenDispatchFenceResult | null> {
  const now = input.now ?? new Date();
  return serializable(db, async (tx) => {
    await lockUser(tx, input.userId);
    // A worker may resume after its reservation TTL. Reconcile it while the
    // same lock is held, so an expired pre-dispatch reservation cannot be
    // observed as still admissible by this fence.
    await recoverExpiredPlatformTokenReservationsInTransaction(input.userId, now, 100, tx);
    const reservation = await reservationForCall(tx, input.userId, input.callKey);
    if (reservation === null) return null;
    return Object.freeze({
      reservationId: reservation.id,
      status: reservation.status,
      reservedTokens: reservation.reservedTokens,
      expiresAt: reservation.expiresAt,
      allowed: reservation.status === "reserved" && reservation.expiresAt > now,
    });
  });
}

async function reservationForCall(
  db: EntitlementDb,
  userId: string,
  callKey: string,
) {
  return db.platformTokenReservation.findUnique({
    where: { userId_callKey: { userId, callKey: assertLedgerKey(callKey) } },
    include: { grant: { select: { id: true, remainingTokens: true } } },
  });
}

export async function settlePlatformTokenReservation(input: Readonly<{
  userId: string;
  callKey: string;
  actualTokens?: number;
  usageKnown: boolean;
  now?: Date;
}>, db: EntitlementDb = getDb()): Promise<PlatformTokenReservationResult> {
  const now = input.now ?? new Date();
  return serializable(db, async (tx) => {
    await lockUser(tx, input.userId);
    const reservation = await reservationForCall(tx, input.userId, input.callKey);
    if (reservation === null) return fail("AI_PROVIDER_CALL_RECONCILIATION_REQUIRED");
    if (reservation.status !== "reserved") {
      return Object.freeze({ reservationId: reservation.id, status: reservation.status, reservedTokens: reservation.reservedTokens, settledTokens: reservation.settledTokens, billingMode: "platform" as const, created: false });
    }
    const actual = input.actualTokens;
    if (!input.usageKnown || typeof actual !== "number" || !Number.isSafeInteger(actual) || actual < 0) {
      const held = await tx.platformTokenReservation.update({
        where: { id: reservation.id },
        data: { status: "held", reconciliationRequired: true, safeErrorCode: "AI_PLATFORM_TOKEN_USAGE_UNVERIFIED" },
        select: { id: true, status: true, reservedTokens: true, settledTokens: true },
      });
      await tx.platformTokenLedgerEntry.create({
        data: {
          id: randomUUID(), userId: input.userId, grantId: reservation.grantId, reservationId: reservation.id,
          entryKind: "hold", amount: 0, usageTokens: null, reasonCode: "AI_PLATFORM_TOKEN_USAGE_UNVERIFIED",
          callKey: input.callKey, idempotencyKey: `hold:${input.userId}:${input.callKey}`, metadata: {}, createdAt: now,
        },
      });
      return Object.freeze({ reservationId: held.id, status: held.status, reservedTokens: held.reservedTokens, settledTokens: held.settledTokens, billingMode: "platform" as const, created: false });
    }
    if (actual > reservation.reservedTokens) {
      const held = await tx.platformTokenReservation.update({
        where: { id: reservation.id },
        data: { status: "held", reconciliationRequired: true, safeErrorCode: "AI_PROVIDER_CALL_RECONCILIATION_REQUIRED" },
        select: { id: true, status: true, reservedTokens: true, settledTokens: true },
      });
      await tx.platformTokenLedgerEntry.create({
        data: {
          id: randomUUID(), userId: input.userId, grantId: reservation.grantId, reservationId: reservation.id,
          entryKind: "hold", amount: 0, usageTokens: actual, reasonCode: "AI_PROVIDER_CALL_RECONCILIATION_REQUIRED",
          callKey: input.callKey, idempotencyKey: `hold:${input.userId}:${input.callKey}`, metadata: {}, createdAt: now,
        },
      });
      return Object.freeze({ reservationId: held.id, status: held.status, reservedTokens: held.reservedTokens, settledTokens: held.settledTokens, billingMode: "platform" as const, created: false });
    }
    const release = reservation.reservedTokens - actual;
    if (release > 0) {
      await tx.platformTokenGrant.update({ where: { id: reservation.grantId }, data: { remainingTokens: { increment: release } } });
      await tx.platformTokenLedgerEntry.create({
        data: {
          id: randomUUID(), userId: input.userId, grantId: reservation.grantId, reservationId: reservation.id,
          entryKind: "release", amount: release, usageTokens: null, reasonCode: "AI_PLATFORM_TOKEN_SETTLE_RELEASE",
          callKey: input.callKey, idempotencyKey: `release:${input.userId}:${input.callKey}`, metadata: {}, createdAt: now,
        },
      });
    }
    const settled = await tx.platformTokenReservation.update({
      where: { id: reservation.id },
      data: { status: "settled", settledTokens: actual, settledAt: now, reconciliationRequired: false, safeErrorCode: null },
      select: { id: true, status: true, reservedTokens: true, settledTokens: true },
    });
    await tx.platformTokenLedgerEntry.create({
      data: {
        id: randomUUID(), userId: input.userId, grantId: reservation.grantId, reservationId: reservation.id,
        entryKind: "settle", amount: 0, usageTokens: actual, reasonCode: "AI_PLATFORM_TOKEN_SETTLED",
        callKey: input.callKey, idempotencyKey: `settle:${input.userId}:${input.callKey}`, metadata: {}, createdAt: now,
      },
    });
    return Object.freeze({ reservationId: settled.id, status: settled.status, reservedTokens: settled.reservedTokens, settledTokens: settled.settledTokens, billingMode: "platform" as const, created: false });
  });
}

export async function releasePlatformTokenReservation(input: Readonly<{
  userId: string;
  callKey: string;
  now?: Date;
}>, db: EntitlementDb = getDb()): Promise<PlatformTokenReservationResult | null> {
  const now = input.now ?? new Date();
  return serializable(db, async (tx) => {
    await lockUser(tx, input.userId);
    const reservation = await reservationForCall(tx, input.userId, input.callKey);
    if (reservation === null) return null;
    if (reservation.status !== "reserved") {
      return Object.freeze({ reservationId: reservation.id, status: reservation.status, reservedTokens: reservation.reservedTokens, settledTokens: reservation.settledTokens, billingMode: "platform" as const, created: false });
    }
    await tx.platformTokenGrant.update({ where: { id: reservation.grantId }, data: { remainingTokens: { increment: reservation.reservedTokens } } });
    const released = await tx.platformTokenReservation.update({
      where: { id: reservation.id },
      data: { status: "released", releasedAt: now, safeErrorCode: null },
      select: { id: true, status: true, reservedTokens: true, settledTokens: true },
    });
    await tx.platformTokenLedgerEntry.create({
      data: {
        id: randomUUID(), userId: input.userId, grantId: reservation.grantId, reservationId: reservation.id,
        entryKind: "release", amount: reservation.reservedTokens, usageTokens: null, reasonCode: "AI_PLATFORM_TOKEN_RELEASED",
        callKey: input.callKey, idempotencyKey: `release:${input.userId}:${input.callKey}`, metadata: {}, createdAt: now,
      },
    });
    return Object.freeze({ reservationId: released.id, status: released.status, reservedTokens: released.reservedTokens, settledTokens: released.settledTokens, billingMode: "platform" as const, created: false });
  });
}

export async function holdPlatformTokenReservation(
  input: Readonly<{ userId: string; callKey: string; errorCode?: string; now?: Date }>,
  db: EntitlementDb = getDb(),
): Promise<PlatformTokenReservationResult | null> {
  const now = input.now ?? new Date();
  return serializable(db, async (tx) => {
    await lockUser(tx, input.userId);
    const reservation = await reservationForCall(tx, input.userId, input.callKey);
    if (reservation === null) return null;
    if (reservation.status !== "reserved") {
      return Object.freeze({ reservationId: reservation.id, status: reservation.status, reservedTokens: reservation.reservedTokens, settledTokens: reservation.settledTokens, billingMode: "platform" as const, created: false });
    }
    const safeErrorCode = input.errorCode === "AI_PLATFORM_TOKEN_USAGE_UNVERIFIED"
      ? input.errorCode
      : "AI_PROVIDER_CALL_RECONCILIATION_REQUIRED";
    const held = await tx.platformTokenReservation.update({
      where: { id: reservation.id },
      data: { status: "held", reconciliationRequired: true, safeErrorCode },
      select: { id: true, status: true, reservedTokens: true, settledTokens: true },
    });
    await tx.platformTokenLedgerEntry.create({
      data: {
        id: randomUUID(), userId: input.userId, grantId: reservation.grantId, reservationId: reservation.id,
        entryKind: "hold", amount: 0, usageTokens: null, reasonCode: safeErrorCode,
        callKey: input.callKey, idempotencyKey: `hold:${input.userId}:${input.callKey}`, metadata: {}, createdAt: now,
      },
    });
    return Object.freeze({ reservationId: held.id, status: held.status, reservedTokens: held.reservedTokens, settledTokens: held.settledTokens, billingMode: "platform" as const, created: false });
  });
}

export async function assertPlatformConcurrency(
  user: Readonly<{ id: string; role: AppUserRole }>,
  db: EntitlementDb = getDb(),
): Promise<void> {
  if (user.role === "admin") return;
  await lockUser(db, user.id);
  const count = await db.backgroundJob.count({
    where: { requestedById: user.id, status: { in: ["queued", "waitingConsent", "running", "unknown"] } },
  });
  if (count > 0) return fail("AI_PLATFORM_CONCURRENCY_LIMIT");
}

export function estimatePlatformTokens(input: unknown, maxOutputTokens: number): number {
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1) return fail("AI_MODEL_CAPABILITY_MISMATCH");
  const serialized = JSON.stringify(input) ?? "null";
  const inputBytes = Buffer.byteLength(serialized, "utf8");
  // This is intentionally a conservative platform-unit estimate, not a
  // claim about any provider's tokenizer.
  return assertPositiveTokens(Math.max(1, inputBytes + 64 + maxOutputTokens));
}

type RuntimeRoute = ProjectAiRoute & { providerConnection: AiProviderConnection };

function platformModelAllowed(route: RuntimeRoute, operation: AiOperation): boolean {
  const provider = route.providerConnection;
  if (provider.scope !== "platform") return false;
  if (operation === "embedding") {
    return provider.kind === "glm" && provider.defaultEmbeddingModelId === "embedding-3" && provider.embeddingDimensions === 1024 && route.modelId === "embedding-3" && route.embeddingDimensions === 1024;
  }
  if (operation === "visionExtract") return false;
  return provider.kind === "deepseek" && provider.defaultGenerationModelId === "deepseek-v4-flash" && route.modelId === "deepseek-v4-flash";
}

export type AiOutboundEntitlement = Readonly<{
  billingMode: "platform" | "byok";
  billingUserId: string;
  reservationRequired: boolean;
}>;

export async function assertAiOutboundEntitlement(input: Readonly<{
  projectId: string;
  requestedById: string;
  route: RuntimeRoute;
  operation?: AiOperation;
  db?: EntitlementDb;
  now?: Date;
  enforceConcurrency?: boolean;
}>): Promise<AiOutboundEntitlement> {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  const operation = input.operation ?? input.route.operation;
  const project = await db.project.findUnique({ where: { id: input.projectId }, select: { workspaceId: true } });
  if (project === null) return fail("AI_ROUTE_CONFIGURATION_FORBIDDEN");
  const provider = input.route.providerConnection;
  if (provider.status !== "verified" || provider.disabledAt !== null) return fail("AI_PROVIDER_CONNECTION_UNAVAILABLE");
  if (provider.scope === "platform") {
    const user = await db.appUser.findUnique({ where: { id: input.requestedById }, select: { id: true, role: true } });
    if (user === null) return fail("AI_ROUTE_CONFIGURATION_FORBIDDEN");
    // Existing system-admin platform work must remain operational after the
    // entitlement rollout. Ordinary users are limited to the no-cost routes
    // below; admin work is still audited but does not consume a grant.
    if (user.role !== "admin" && !platformModelAllowed(input.route, operation)) return fail("AI_MODEL_CAPABILITY_MISMATCH");
    if (input.enforceConcurrency !== false) await assertPlatformConcurrency(user, db);
    return Object.freeze({ billingMode: "platform", billingUserId: user.id, reservationRequired: user.role !== "admin" });
  }
  if (provider.workspaceId === null || provider.workspaceId !== project.workspaceId) return fail("AI_PROVIDER_SCOPE_FORBIDDEN");
  if (provider.ownerUserId === null) return fail("AI_PROVIDER_OWNER_REQUIRED");
  const ownerMembership = await db.workspaceMembership.findUnique({
    where: { workspaceId_userId: { workspaceId: provider.workspaceId, userId: provider.ownerUserId } },
    select: { role: true },
  });
  if (ownerMembership === null || (ownerMembership.role !== "owner" && ownerMembership.role !== "admin")) return fail("AI_PROVIDER_OWNER_REQUIRED");
  await assertActiveMembership(provider.ownerUserId, db, now);
  if (operation === "embedding" && (provider.defaultEmbeddingModelId !== input.route.modelId || provider.embeddingDimensions !== input.route.embeddingDimensions)) return fail("AI_MODEL_CAPABILITY_MISMATCH");
  if (operation === "visionExtract" && provider.defaultVisionModelId !== input.route.modelId) return fail("AI_MODEL_CAPABILITY_MISMATCH");
  if (operation !== "embedding" && operation !== "visionExtract" && provider.defaultGenerationModelId !== input.route.modelId) return fail("AI_MODEL_CAPABILITY_MISMATCH");
  return Object.freeze({ billingMode: "byok", billingUserId: provider.ownerUserId, reservationRequired: false });
}

export async function getPlatformTokenSummary(userId: string, db: EntitlementDb = getDb(), now = new Date()) {
  await recoverExpiredPlatformTokenReservations({ userId, now }, db);
  const [grants, reservations, membership] = await Promise.all([
    db.platformTokenGrant.findMany({ where: { userId, revokedAt: null }, select: { remainingTokens: true, expiresAt: true } }),
    db.platformTokenReservation.findMany({ where: { userId, status: { in: ["reserved", "held"] } }, select: { reservedTokens: true, status: true } }),
    getMembershipStatus(userId, db, now),
  ]);
  const activeGrants = grants.filter((grant) => grant.expiresAt > now);
  return Object.freeze({
    availableTokens: activeGrants.reduce((sum, grant) => sum + grant.remainingTokens, 0),
    reservedTokens: reservations.reduce((sum, reservation) => sum + reservation.reservedTokens, 0),
    nextExpiryAt: activeGrants.map((grant) => grant.expiresAt).sort((left, right) => left.getTime() - right.getTime())[0] ?? null,
    membership,
  });
}
