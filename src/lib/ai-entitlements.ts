import { randomUUID } from "node:crypto";
import {
  Prisma,
  type AiOperation,
  type AppUserRole,
  type PlatformTokenReservationStatus,
  type PrismaClient,
} from "@prisma/client";
import { getDb } from "@/lib/db";
import type { EffectiveAiRoute } from "@/lib/effective-ai-route";

/** The signup offer is a product constant, not a value supplied by a client. */
export const SIGNUP_TOKEN_AMOUNT = 500_000;
export const SIGNUP_TOKEN_TTL_DAYS = 30;
export const SIGNUP_OFFER_VERSION = "signup-500k-v1";

const LEDGER_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,180}$/u;
const RESERVATION_TTL_MS = 60 * 60 * 1_000;
const CONCURRENCY_LOCK_NAMESPACE = 29082027;
export const PLATFORM_QUOTA_BPS_MIN = 1;
export const PLATFORM_QUOTA_BPS_MAX = 100_000;
export const PLATFORM_RAW_TOKEN_LIMIT = 10_000_000;
export const PLATFORM_CHARGED_TOKEN_LIMIT = 1_000_000_000;

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
  if (!Number.isSafeInteger(value) || value <= 0 || value > PLATFORM_RAW_TOKEN_LIMIT) {
    return fail("AI_PLATFORM_TOKEN_EXHAUSTED");
  }
  return value;
}

function assertRawUsageTokens(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > PLATFORM_RAW_TOKEN_LIMIT) {
    return fail("AI_PLATFORM_TOKEN_USAGE_UNVERIFIED");
  }
  return value;
}

function assertQuotaMultiplierBps(value: number): number {
  if (!Number.isSafeInteger(value) || value < PLATFORM_QUOTA_BPS_MIN || value > PLATFORM_QUOTA_BPS_MAX) {
    return fail("AI_ROUTE_CONFIGURATION_FORBIDDEN");
  }
  return value;
}

/**
 * Convert raw provider tokens to platform quota units without floating point
 * rounding or an overflowing JavaScript number.  The database stores the
 * resulting charged amount; provider usage remains raw.
 */
export function calculateChargedPlatformTokens(rawTokens: number, quotaMultiplierBps: number): number {
  const raw = assertRawUsageTokens(rawTokens);
  const bps = assertQuotaMultiplierBps(quotaMultiplierBps);
  const charged = (BigInt(raw) * BigInt(bps) + BigInt(9_999)) / BigInt(10_000);
  if (charged < BigInt(0) || charged > BigInt(PLATFORM_CHARGED_TOKEN_LIMIT)) {
    return fail("AI_PLATFORM_TOKEN_EXHAUSTED");
  }
  return Number(charged);
}

type RouteSnapshotInput = Readonly<Pick<EffectiveAiRoute, "source" | "routeId" | "routeVersion" | "routeUpdatedAt" | "providerConfigurationVersion" | "quotaMultiplierBps" | "routeFenceFingerprint">>;

function routeSnapshotInput(route: RouteSnapshotInput | undefined) {
  if (route === undefined) {
    return {
      routeSource: null,
      routeId: null,
      routeVersion: null,
      routeUpdatedAt: null,
      providerConfigurationVersion: null,
      quotaMultiplierBps: 10_000,
      routeFenceFingerprint: null,
    } as const;
  }
  if (route.source === "personal_delegation") return fail("AI_ROUTE_CONFIGURATION_FORBIDDEN");
  return {
    routeSource: route.source,
    routeId: route.routeId,
    routeVersion: route.routeVersion,
    routeUpdatedAt: route.routeUpdatedAt,
    providerConfigurationVersion: route.providerConfigurationVersion,
    quotaMultiplierBps: assertQuotaMultiplierBps(route.quotaMultiplierBps),
    routeFenceFingerprint: route.routeFenceFingerprint,
  } as const;
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
 * transaction. The user/kind ledger key makes retries and concurrent
 * callbacks idempotent; no caller should invoke this for invitations or local
 * members.
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
  rawEstimatedTokens?: number;
  rawSettledTokens?: number | null;
  quotaMultiplierBps?: number;
  webAiGrantId?: string | null;
  routeFenceFingerprint?: string | null;
  billingMode: "platform";
  created: boolean;
}>;

export type PlatformTokenDispatchFenceResult = Readonly<{
  reservationId: string;
  status: PlatformTokenReservationStatus;
  reservedTokens: number;
  webAiGrantId?: string | null;
  routeFenceFingerprint?: string | null;
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
  webAiGrantId?: string | null;
  webAiGrantProjectId?: string | null;
  callKey: string;
  operation: AiOperation;
  modelId: string;
  /** Raw provider-token estimate. `estimatedTokens` remains a compatibility
   * alias for non-runtime accounting callers and uses a 1x multiplier. */
  rawEstimatedTokens?: number;
  estimatedTokens?: number;
  routeSnapshot?: RouteSnapshotInput;
  now?: Date;
}>, db: EntitlementDb = getDb()): Promise<PlatformTokenReservationResult> {
  const rawEstimatedTokens = assertPositiveTokens(input.rawEstimatedTokens ?? input.estimatedTokens ?? 0);
  const snapshot = routeSnapshotInput(input.routeSnapshot);
  const reservedTokens = calculateChargedPlatformTokens(rawEstimatedTokens, snapshot.quotaMultiplierBps);
  const callKey = assertLedgerKey(input.callKey);
  const now = input.now ?? new Date();
  return serializable(db, async (tx) => {
    await lockUser(tx, input.userId);
    await recoverExpiredPlatformTokenReservationsInTransaction(input.userId, now, 100, tx);
    const existing = await tx.platformTokenReservation.findUnique({
      where: { userId_callKey: { userId: input.userId, callKey } },
      select: {
        id: true,
        status: true,
        reservedTokens: true,
        settledTokens: true,
        rawEstimatedTokens: true,
        rawSettledTokens: true,
        quotaMultiplierBps: true,
        webAiGrantId: true,
        routeSource: true,
        routeId: true,
        routeVersion: true,
        routeUpdatedAt: true,
        providerConfigurationVersion: true,
        routeFenceFingerprint: true,
        jobId: true,
        providerConnectionId: true,
        operation: true,
        modelId: true,
      },
    });
    if (existing !== null) {
      const existingRawEstimatedTokens = existing.rawEstimatedTokens ?? existing.reservedTokens;
      const existingQuotaMultiplierBps = existing.quotaMultiplierBps ?? 10_000;
      if (
        (existing.jobId ?? null) !== (input.jobId ?? null)
        || (existing.providerConnectionId ?? null) !== (input.providerConnectionId ?? null)
        || (existing.webAiGrantId ?? null) !== (input.webAiGrantId ?? null)
        || existing.operation !== input.operation
        || existing.modelId !== input.modelId
        || existingRawEstimatedTokens !== rawEstimatedTokens
        || existing.reservedTokens !== reservedTokens
        || existingQuotaMultiplierBps !== snapshot.quotaMultiplierBps
        || (existing.routeSource ?? null) !== snapshot.routeSource
        || (existing.routeId ?? null) !== snapshot.routeId
        || (existing.routeVersion ?? null) !== snapshot.routeVersion
        || (existing.routeUpdatedAt?.getTime() ?? null) !== (snapshot.routeUpdatedAt?.getTime() ?? null)
        || (existing.providerConfigurationVersion ?? null) !== snapshot.providerConfigurationVersion
        || (existing.routeFenceFingerprint ?? null) !== snapshot.routeFenceFingerprint
      ) return fail("AI_ROUTE_CONFIGURATION_FORBIDDEN");
      return Object.freeze({
        reservationId: existing.id,
        status: existing.status,
        reservedTokens: existing.reservedTokens,
        settledTokens: existing.settledTokens,
        rawEstimatedTokens: existingRawEstimatedTokens,
        rawSettledTokens: existing.rawSettledTokens ?? null,
        quotaMultiplierBps: existingQuotaMultiplierBps,
        webAiGrantId: existing.webAiGrantId ?? null,
        routeFenceFingerprint: existing.routeFenceFingerprint ?? null,
        billingMode: "platform" as const,
        created: false,
      });
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
    const grant = grants.find((candidate) => candidate.remainingTokens >= reservedTokens);
    if (grant === undefined) return fail("AI_PLATFORM_TOKEN_EXHAUSTED");
    const updated = await tx.platformTokenGrant.updateMany({
      where: { id: grant.id, remainingTokens: { gte: reservedTokens }, revokedAt: null, expiresAt: { gt: now } },
      data: { remainingTokens: { decrement: reservedTokens } },
    });
    if (updated.count !== 1) return fail("AI_PLATFORM_TOKEN_EXHAUSTED");
    const reservationId = randomUUID();
    const reservation = await tx.platformTokenReservation.create({
      data: {
        id: reservationId,
        userId: input.userId,
        grantId: grant.id,
        webAiGrantId: input.webAiGrantId ?? null,
        webAiGrantReferenceId: input.webAiGrantId ?? null,
        webAiGrantProjectId: input.webAiGrantProjectId ?? null,
        jobId: input.jobId ?? null,
        providerConnectionId: input.providerConnectionId ?? null,
        callKey,
        operation: input.operation,
        modelId: input.modelId,
        reservedTokens,
        rawEstimatedTokens,
        quotaMultiplierBps: snapshot.quotaMultiplierBps,
        routeSource: snapshot.routeSource,
        routeId: snapshot.routeId,
        routeVersion: snapshot.routeVersion,
        routeUpdatedAt: snapshot.routeUpdatedAt,
        providerConfigurationVersion: snapshot.providerConfigurationVersion,
        routeFenceFingerprint: snapshot.routeFenceFingerprint,
        expiresAt: new Date(Math.min(grant.expiresAt.getTime(), now.getTime() + RESERVATION_TTL_MS)),
        createdAt: now,
        ledgerEntries: {
          create: {
            id: randomUUID(),
            userId: input.userId,
            grantId: grant.id,
            entryKind: "reserve",
            amount: -reservedTokens,
            reasonCode: "AI_PLATFORM_TOKEN_RESERVED",
            callKey,
            idempotencyKey: `reserve:${input.userId}:${callKey}`,
            metadata: {
              operation: input.operation,
              modelId: input.modelId,
              rawEstimatedTokens,
              quotaMultiplierBps: snapshot.quotaMultiplierBps,
              routeFenceFingerprint: snapshot.routeFenceFingerprint,
            },
            createdAt: now,
          },
        },
      },
      select: {
        id: true,
        status: true,
        reservedTokens: true,
        settledTokens: true,
        rawEstimatedTokens: true,
        rawSettledTokens: true,
        quotaMultiplierBps: true,
        webAiGrantId: true,
        routeFenceFingerprint: true,
      },
    });
    return Object.freeze({
      reservationId: reservation.id,
      status: reservation.status,
      reservedTokens: reservation.reservedTokens,
      settledTokens: reservation.settledTokens,
      rawEstimatedTokens: reservation.rawEstimatedTokens,
      rawSettledTokens: reservation.rawSettledTokens,
      quotaMultiplierBps: reservation.quotaMultiplierBps,
      webAiGrantId: reservation.webAiGrantId,
      routeFenceFingerprint: reservation.routeFenceFingerprint,
      billingMode: "platform" as const,
      created: true,
    });
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
  jobId?: string | null;
  operation?: AiOperation;
  modelId?: string;
  webAiGrantId?: string | null;
  routeFenceFingerprint?: string | null;
  quotaMultiplierBps?: number;
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
    if (
      (input.jobId !== undefined && reservation.jobId !== input.jobId)
      || (input.operation !== undefined && reservation.operation !== input.operation)
      || (input.modelId !== undefined && reservation.modelId !== input.modelId)
      || (input.webAiGrantId !== undefined && reservation.webAiGrantId !== input.webAiGrantId)
      || (input.routeFenceFingerprint !== undefined && reservation.routeFenceFingerprint !== input.routeFenceFingerprint)
      || (input.quotaMultiplierBps !== undefined && reservation.quotaMultiplierBps !== input.quotaMultiplierBps)
    ) return fail("AI_ROUTE_CONFIGURATION_FORBIDDEN");
    return Object.freeze({
      reservationId: reservation.id,
      status: reservation.status,
      reservedTokens: reservation.reservedTokens,
      webAiGrantId: reservation.webAiGrantId,
      routeFenceFingerprint: reservation.routeFenceFingerprint,
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
      return Object.freeze({
        reservationId: reservation.id,
        status: reservation.status,
        reservedTokens: reservation.reservedTokens,
        settledTokens: reservation.settledTokens,
        rawEstimatedTokens: reservation.rawEstimatedTokens,
        rawSettledTokens: reservation.rawSettledTokens,
        quotaMultiplierBps: reservation.quotaMultiplierBps,
        webAiGrantId: reservation.webAiGrantId,
        routeFenceFingerprint: reservation.routeFenceFingerprint,
        billingMode: "platform" as const,
        created: false,
      });
    }
    const quotaMultiplierBps = reservation.quotaMultiplierBps ?? 10_000;
    const actual = input.actualTokens;
    if (!input.usageKnown || typeof actual !== "number" || !Number.isSafeInteger(actual) || actual < 0) {
      const held = await tx.platformTokenReservation.update({
        where: { id: reservation.id },
        data: { status: "held", reconciliationRequired: true, safeErrorCode: "AI_PLATFORM_TOKEN_USAGE_UNVERIFIED" },
        select: {
          id: true,
          status: true,
          reservedTokens: true,
          settledTokens: true,
          rawEstimatedTokens: true,
          rawSettledTokens: true,
          quotaMultiplierBps: true,
          webAiGrantId: true,
          routeFenceFingerprint: true,
        },
      });
      await tx.platformTokenLedgerEntry.create({
        data: {
          id: randomUUID(), userId: input.userId, grantId: reservation.grantId, reservationId: reservation.id,
          entryKind: "hold", amount: 0, usageTokens: null, reasonCode: "AI_PLATFORM_TOKEN_USAGE_UNVERIFIED",
          callKey: input.callKey, idempotencyKey: `hold:${input.userId}:${input.callKey}`, metadata: {}, createdAt: now,
        },
      });
      return Object.freeze({
        reservationId: held.id,
        status: held.status,
        reservedTokens: held.reservedTokens,
        settledTokens: held.settledTokens,
        rawEstimatedTokens: held.rawEstimatedTokens,
        rawSettledTokens: held.rawSettledTokens,
        quotaMultiplierBps: held.quotaMultiplierBps,
        webAiGrantId: held.webAiGrantId,
        routeFenceFingerprint: held.routeFenceFingerprint,
        billingMode: "platform" as const,
        created: false,
      });
    }
    let chargedActual: number;
    try {
      chargedActual = calculateChargedPlatformTokens(actual, quotaMultiplierBps);
    } catch {
      chargedActual = Number.POSITIVE_INFINITY;
    }
    if (!Number.isSafeInteger(chargedActual) || chargedActual > reservation.reservedTokens) {
      const safeUsageTokens = Number.isSafeInteger(actual) && actual >= 0 && actual <= PLATFORM_RAW_TOKEN_LIMIT ? actual : null;
      const held = await tx.platformTokenReservation.update({
        where: { id: reservation.id },
        data: { status: "held", reconciliationRequired: true, safeErrorCode: "AI_PROVIDER_CALL_RECONCILIATION_REQUIRED" },
        select: {
          id: true,
          status: true,
          reservedTokens: true,
          settledTokens: true,
          rawEstimatedTokens: true,
          rawSettledTokens: true,
          quotaMultiplierBps: true,
          webAiGrantId: true,
          routeFenceFingerprint: true,
        },
      });
      await tx.platformTokenLedgerEntry.create({
        data: {
          id: randomUUID(), userId: input.userId, grantId: reservation.grantId, reservationId: reservation.id,
          entryKind: "hold", amount: 0, usageTokens: safeUsageTokens, reasonCode: "AI_PROVIDER_CALL_RECONCILIATION_REQUIRED",
          callKey: input.callKey, idempotencyKey: `hold:${input.userId}:${input.callKey}`, metadata: {}, createdAt: now,
        },
      });
      return Object.freeze({
        reservationId: held.id,
        status: held.status,
        reservedTokens: held.reservedTokens,
        settledTokens: held.settledTokens,
        rawEstimatedTokens: held.rawEstimatedTokens,
        rawSettledTokens: held.rawSettledTokens,
        quotaMultiplierBps: held.quotaMultiplierBps,
        webAiGrantId: held.webAiGrantId,
        routeFenceFingerprint: held.routeFenceFingerprint,
        billingMode: "platform" as const,
        created: false,
      });
    }
    const release = reservation.reservedTokens - chargedActual;
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
      data: {
        status: "settled",
        settledTokens: chargedActual,
        rawSettledTokens: actual,
        settledAt: now,
        reconciliationRequired: false,
        safeErrorCode: null,
      },
      select: {
        id: true,
        status: true,
        reservedTokens: true,
        settledTokens: true,
        rawEstimatedTokens: true,
        rawSettledTokens: true,
        quotaMultiplierBps: true,
        webAiGrantId: true,
        routeFenceFingerprint: true,
      },
    });
    await tx.platformTokenLedgerEntry.create({
      data: {
        id: randomUUID(), userId: input.userId, grantId: reservation.grantId, reservationId: reservation.id,
        entryKind: "settle", amount: 0, usageTokens: actual, reasonCode: "AI_PLATFORM_TOKEN_SETTLED",
        callKey: input.callKey, idempotencyKey: `settle:${input.userId}:${input.callKey}`, metadata: {}, createdAt: now,
      },
    });
    return Object.freeze({
      reservationId: settled.id,
      status: settled.status,
      reservedTokens: settled.reservedTokens,
      settledTokens: settled.settledTokens,
      rawEstimatedTokens: settled.rawEstimatedTokens,
      rawSettledTokens: settled.rawSettledTokens,
      quotaMultiplierBps: settled.quotaMultiplierBps,
      webAiGrantId: settled.webAiGrantId,
      routeFenceFingerprint: settled.routeFenceFingerprint,
      billingMode: "platform" as const,
      created: false,
    });
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
      return Object.freeze({
        reservationId: reservation.id,
        status: reservation.status,
        reservedTokens: reservation.reservedTokens,
        settledTokens: reservation.settledTokens,
        rawEstimatedTokens: reservation.rawEstimatedTokens,
        rawSettledTokens: reservation.rawSettledTokens,
        quotaMultiplierBps: reservation.quotaMultiplierBps,
        webAiGrantId: reservation.webAiGrantId,
        routeFenceFingerprint: reservation.routeFenceFingerprint,
        billingMode: "platform" as const,
        created: false,
      });
    }
    await tx.platformTokenGrant.update({ where: { id: reservation.grantId }, data: { remainingTokens: { increment: reservation.reservedTokens } } });
    const released = await tx.platformTokenReservation.update({
      where: { id: reservation.id },
      data: { status: "released", releasedAt: now, safeErrorCode: null },
      select: {
        id: true,
        status: true,
        reservedTokens: true,
        settledTokens: true,
        rawEstimatedTokens: true,
        rawSettledTokens: true,
        quotaMultiplierBps: true,
        webAiGrantId: true,
        routeFenceFingerprint: true,
      },
    });
    await tx.platformTokenLedgerEntry.create({
      data: {
        id: randomUUID(), userId: input.userId, grantId: reservation.grantId, reservationId: reservation.id,
        entryKind: "release", amount: reservation.reservedTokens, usageTokens: null, reasonCode: "AI_PLATFORM_TOKEN_RELEASED",
        callKey: input.callKey, idempotencyKey: `release:${input.userId}:${input.callKey}`, metadata: {}, createdAt: now,
      },
    });
    return Object.freeze({
      reservationId: released.id,
      status: released.status,
      reservedTokens: released.reservedTokens,
      settledTokens: released.settledTokens,
      rawEstimatedTokens: released.rawEstimatedTokens,
      rawSettledTokens: released.rawSettledTokens,
      quotaMultiplierBps: released.quotaMultiplierBps,
      webAiGrantId: released.webAiGrantId,
      routeFenceFingerprint: released.routeFenceFingerprint,
      billingMode: "platform" as const,
      created: false,
    });
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
      return Object.freeze({
        reservationId: reservation.id,
        status: reservation.status,
        reservedTokens: reservation.reservedTokens,
        settledTokens: reservation.settledTokens,
        rawEstimatedTokens: reservation.rawEstimatedTokens,
        rawSettledTokens: reservation.rawSettledTokens,
        quotaMultiplierBps: reservation.quotaMultiplierBps,
        webAiGrantId: reservation.webAiGrantId,
        routeFenceFingerprint: reservation.routeFenceFingerprint,
        billingMode: "platform" as const,
        created: false,
      });
    }
    const safeErrorCode = input.errorCode === "AI_PLATFORM_TOKEN_USAGE_UNVERIFIED"
      ? input.errorCode
      : "AI_PROVIDER_CALL_RECONCILIATION_REQUIRED";
    const held = await tx.platformTokenReservation.update({
      where: { id: reservation.id },
      data: { status: "held", reconciliationRequired: true, safeErrorCode },
      select: {
        id: true,
        status: true,
        reservedTokens: true,
        settledTokens: true,
        rawEstimatedTokens: true,
        rawSettledTokens: true,
        quotaMultiplierBps: true,
        webAiGrantId: true,
        routeFenceFingerprint: true,
      },
    });
    await tx.platformTokenLedgerEntry.create({
      data: {
        id: randomUUID(), userId: input.userId, grantId: reservation.grantId, reservationId: reservation.id,
        entryKind: "hold", amount: 0, usageTokens: null, reasonCode: safeErrorCode,
        callKey: input.callKey, idempotencyKey: `hold:${input.userId}:${input.callKey}`, metadata: {}, createdAt: now,
      },
    });
    return Object.freeze({
      reservationId: held.id,
      status: held.status,
      reservedTokens: held.reservedTokens,
      settledTokens: held.settledTokens,
      rawEstimatedTokens: held.rawEstimatedTokens,
      rawSettledTokens: held.rawSettledTokens,
      quotaMultiplierBps: held.quotaMultiplierBps,
      webAiGrantId: held.webAiGrantId,
      routeFenceFingerprint: held.routeFenceFingerprint,
      billingMode: "platform" as const,
      created: false,
    });
  });
}

export async function assertPlatformConcurrency(
  user: Readonly<{ id: string; role: AppUserRole }>,
  db: EntitlementDb = getDb(),
): Promise<void> {
  await lockUser(db, user.id);
  const count = await db.backgroundJob.count({
    where: {
      requestedById: user.id,
      OR: [
        { status: { in: ["queued", "waitingConsent", "running"] } },
        { status: "unknown", reconciliationRequired: true },
      ],
    },
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

type RuntimeRoute = EffectiveAiRoute;

function platformModelAllowed(route: RuntimeRoute, operation: AiOperation): boolean {
  const provider = route.providerConnection;
  if (provider.scope !== "platform") return false;
  if (operation === "embedding") {
    return provider.defaultEmbeddingModelId !== null &&
      provider.embeddingDimensions !== null &&
      route.modelId === provider.defaultEmbeddingModelId &&
      route.embeddingDimensions === provider.embeddingDimensions;
  }
  if (operation === "visionExtract") {
    return provider.defaultVisionModelId !== null &&
      route.modelId === provider.defaultVisionModelId &&
      route.embeddingDimensions === null;
  }
  return provider.defaultGenerationModelId !== null &&
    route.modelId === provider.defaultGenerationModelId &&
    route.embeddingDimensions === null;
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
  // Personal control-plane routes can be resolved for evidence construction,
  // but the platform reservation/ledger path remains platform-only until the
  // separately gated BYOK dispatcher is delivered.
  if (input.route.source === "personal_delegation") return fail("AI_ROUTE_CONFIGURATION_FORBIDDEN");
  if (input.operation !== undefined && input.operation !== input.route.operation) {
    return fail("AI_ROUTE_CONFIGURATION_FORBIDDEN");
  }
  const operation = input.operation ?? input.route.operation;
  const project = await db.project.findUnique({ where: { id: input.projectId }, select: { workspaceId: true } });
  if (project === null) return fail("AI_ROUTE_CONFIGURATION_FORBIDDEN");
  const provider = input.route.providerConnection;
  if (provider.status !== "verified" || provider.disabledAt !== null) return fail("AI_PROVIDER_CONNECTION_UNAVAILABLE");
  // Workspace connections remain configurable for the future paid-member
  // surface, but they are deliberately unreachable from this runtime
  // admission boundary until that entitlement is implemented.  In
  // particular, a free user (or a system admin) cannot turn a legacy
  // workspace BYOK row into an outbound platform call.
  if (
    provider.scope !== "platform"
    || provider.ownershipState !== "confirmed"
    || provider.workspaceId !== null
    || provider.ownerUserId !== null
  ) {
    return fail("AI_PROVIDER_SCOPE_FORBIDDEN");
  }
  const user = await db.appUser.findUnique({ where: { id: input.requestedById }, select: { id: true, role: true } });
  if (user === null) return fail("AI_ROUTE_CONFIGURATION_FORBIDDEN");
  // System-admin governance permissions do not grant a model or billing
  // exception when the admin is also the caller of a platform AI operation.
  if (!platformModelAllowed(input.route, operation)) return fail("AI_MODEL_CAPABILITY_MISMATCH");
  if (input.enforceConcurrency !== false) await assertPlatformConcurrency(user, db);
  return Object.freeze({ billingMode: "platform", billingUserId: user.id, reservationRequired: true });
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

/**
 * Read-only quota information for status/advisory views. Unlike
 * getPlatformTokenSummary, this deliberately does not recover expired
 * reservations or touch grants, reservations, or ledger rows.
 */
export async function getPlatformTokenAdvisory(
  userId: string,
  db: EntitlementDb = getDb(),
  now = new Date(),
) {
  const [grants, reservations] = await Promise.all([
    db.platformTokenGrant.findMany({ where: { userId, revokedAt: null }, select: { remainingTokens: true, expiresAt: true } }),
    db.platformTokenReservation.findMany({ where: { userId, status: { in: ["reserved", "held"] } }, select: { reservedTokens: true } }),
  ]);
  const activeGrants = grants.filter((grant) => grant.expiresAt > now);
  const availableTokens = activeGrants.reduce((sum, grant) => sum + grant.remainingTokens, 0);
  return Object.freeze({
    availableTokens,
    reservedTokens: reservations.reduce((sum, reservation) => sum + reservation.reservedTokens, 0),
    nextExpiryAt: activeGrants.map((grant) => grant.expiresAt).sort((left, right) => left.getTime() - right.getTime())[0] ?? null,
    hasAvailableTokens: availableTokens > 0,
  });
}
