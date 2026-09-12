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
import {
  PLATFORM_GRANT_OFFER_DEFAULT_AMOUNT,
  PLATFORM_GRANT_OFFER_DEFAULT_VALID_FOR_DAYS,
  PLATFORM_GRANT_OFFER_DEFAULT_VERSION,
} from "@/lib/platform-grant-offer-policy-service";

/** Compatibility aliases; issuance reads the active policy, never these values. */
export const SIGNUP_TOKEN_AMOUNT = PLATFORM_GRANT_OFFER_DEFAULT_AMOUNT;
export const SIGNUP_TOKEN_TTL_DAYS = PLATFORM_GRANT_OFFER_DEFAULT_VALID_FOR_DAYS;
export const SIGNUP_OFFER_VERSION = PLATFORM_GRANT_OFFER_DEFAULT_VERSION;

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
  | "AI_PLATFORM_TOKEN_USAGE_UNVERIFIED"
  | "AI_PLATFORM_TOKEN_PROJECTION_INCONSISTENT"
  | "AI_SIGNUP_ELIGIBILITY_REQUIRED";

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

type AllocationDelegate = {
  create: (args: { data: Record<string, unknown> }) => Promise<unknown>;
  findMany: (args: Record<string, unknown>) => Promise<ReadonlyArray<Record<string, unknown>>>;
  update: (args: { where: { id: string }; data: Record<string, unknown> }) => Promise<unknown>;
};

function allocationDelegate(db: EntitlementDb): AllocationDelegate | null {
  const delegate = (db as unknown as { platformTokenReservationAllocation?: AllocationDelegate }).platformTokenReservationAllocation;
  return delegate === undefined ? null : delegate;
}

async function setRuntimeMutationContext(db: EntitlementDb): Promise<void> {
  // The runtime principal is granted only the allocation/reservation lifecycle
  // tables.  This transaction-local marker lets the database trigger
  // distinguish that narrow balance transition from a governance mutation.
  await db.$executeRaw`SELECT set_config('app.platform_token_runtime_context', '1', true)`;
}

type RuntimeAllocationMutation = Readonly<{
  id: string;
  grantId: string;
  ordinal: number;
  reservedTokens: number;
  settledTokens: number;
  releasedTokens: number;
}>;

type RuntimeLedgerMutation = Readonly<{
  id: string;
  userId: string;
  grantId: string;
  reservationId: string;
  entryKind: "reserve" | "settle" | "release" | "hold";
  amount: number;
  usageTokens: number | null;
  reasonCode: string;
  idempotencyKey: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}>;

async function applyRuntimeMutation(
  db: EntitlementDb,
  action: "reserve" | "settle" | "release" | "hold",
  reservation: Record<string, unknown>,
  allocations: readonly RuntimeAllocationMutation[],
  ledger: readonly RuntimeLedgerMutation[],
): Promise<void> {
  await db.$executeRaw`SELECT "platform_token_runtime_apply"(
    ${action},
    ${JSON.stringify(reservation)}::jsonb,
    ${JSON.stringify(allocations)}::jsonb,
    ${JSON.stringify(ledger)}::jsonb
  )`;
}

async function applyTerminalRuntimeMutation(
  db: EntitlementDb,
  action: "settle" | "release" | "hold",
  reservation: AllocationReservationRow,
  allocations: readonly RuntimeAllocationMutation[],
  ledger: readonly RuntimeLedgerMutation[],
  now: Date,
  terminal: Readonly<{ settledTokens?: number; rawSettledTokens?: number; safeErrorCode?: string }>,
): Promise<PlatformTokenReservationResult> {
  await applyRuntimeMutation(db, action, {
    id: reservation.id, userId: reservation.userId, callKey: reservation.callKey,
    reservedTokens: reservation.reservedTokens,
    ...(action === "settle" ? { settledTokens: terminal.settledTokens, rawSettledTokens: terminal.rawSettledTokens, settledAt: now.toISOString() } : {}),
    ...(action === "release" ? { releasedAt: now.toISOString() } : {}),
    ...(action === "hold" ? { safeErrorCode: terminal.safeErrorCode } : {}),
  }, allocations, ledger);
  const row = await db.platformTokenReservation.findUniqueOrThrow({ where: { id: reservation.id }, select: {
    id: true, status: true, reservedTokens: true, settledTokens: true, rawEstimatedTokens: true,
    rawSettledTokens: true, quotaMultiplierBps: true, webAiGrantId: true, routeFenceFingerprint: true,
  } });
  return reservationResult(row);
}

function runtimeLedger(input: Omit<RuntimeLedgerMutation, "id" | "createdAt">, now: Date): RuntimeLedgerMutation {
  return Object.freeze({ id: randomUUID(), ...input, createdAt: now.toISOString() });
}

function allocationRows(value: unknown): Array<{
  id: string;
  grantId: string;
  ordinal: number;
  reservedTokens: number;
  settledTokens: number;
  releasedTokens: number;
}> {
  if (!Array.isArray(value)) return [];
  return value.map((row) => {
    const item = row as Record<string, unknown>;
    return {
      id: String(item.id),
      grantId: String(item.grantId),
      ordinal: Number(item.ordinal),
      reservedTokens: Number(item.reservedTokens),
      settledTokens: Number(item.settledTokens ?? 0),
      releasedTokens: Number(item.releasedTokens ?? 0),
    };
  }).sort((left, right) => left.ordinal - right.ordinal);
}

function allocationLedgerKey(kind: string, userId: string, callKey: string, ordinal: number): string {
  return ordinal === 1 ? `${kind}:${userId}:${callKey}` : `${kind}:${userId}:${callKey}:allocation:${ordinal}`;
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
      userId: true,
      grantId: true,
      jobId: true,
      callKey: true,
      reservedTokens: true,
      providerCallAudit: { select: { id: true } },
      allocations: {
        orderBy: [{ ordinal: "asc" as const }],
        select: { id: true, grantId: true, ordinal: true, reservedTokens: true, settledTokens: true, releasedTokens: true },
      },
    },
  });
  const allocations = allocationDelegate(db);
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
      const exactAllocations = allocationRows((reservation as unknown as { allocations?: unknown }).allocations);
      if (isPrismaClient(db) && exactAllocations.length > 0) {
        const current = await db.platformTokenReservation.findUnique({ where: { id: reservation.id }, select: { status: true } });
        if (current?.status !== "reserved") continue;
        await applyTerminalRuntimeMutation(db, "hold", reservation as unknown as AllocationReservationRow, exactAllocations,
          exactAllocations.map((allocation) => runtimeLedger({ userId, grantId: allocation.grantId, reservationId: reservation.id,
            entryKind: "hold", amount: 0, usageTokens: null, reasonCode: "AI_PROVIDER_CALL_RECONCILIATION_REQUIRED",
            idempotencyKey: allocationLedgerKey("hold", userId, reservation.callKey, allocation.ordinal),
            metadata: { recovery: "expired-reservation", allocationOrdinal: allocation.ordinal } }, now)),
          now, { safeErrorCode: "AI_PROVIDER_CALL_RECONCILIATION_REQUIRED" });
        held += 1;
        continue;
      }
      const transitioned = await db.platformTokenReservation.updateMany({
        where: { id: reservation.id, status: "reserved" },
        data: { status: "held", reconciliationRequired: true, safeErrorCode: "AI_PROVIDER_CALL_RECONCILIATION_REQUIRED" },
      });
      if (transitioned.count !== 1) continue;
      if (allocations !== null && exactAllocations.length > 0) {
        for (const allocation of exactAllocations) {
          await db.platformTokenLedgerEntry.createMany({
            data: {
              id: randomUUID(), userId, grantId: allocation.grantId, reservationId: reservation.id,
              entryKind: "hold", amount: 0, usageTokens: null,
              reasonCode: "AI_PROVIDER_CALL_RECONCILIATION_REQUIRED", callKey: reservation.callKey,
              idempotencyKey: allocationLedgerKey("hold", userId, reservation.callKey, allocation.ordinal),
              metadata: { recovery: "expired-reservation", allocationOrdinal: allocation.ordinal }, createdAt: now,
            }, skipDuplicates: true,
          });
        }
      } else {
        await db.platformTokenLedgerEntry.createMany({
          data: {
            id: randomUUID(), userId, grantId: reservation.grantId, reservationId: reservation.id,
            entryKind: "hold", amount: 0, usageTokens: null,
            reasonCode: "AI_PROVIDER_CALL_RECONCILIATION_REQUIRED", callKey: reservation.callKey,
            idempotencyKey: `hold:${userId}:${reservation.callKey}`,
            metadata: { recovery: "expired-reservation" }, createdAt: now,
          }, skipDuplicates: true,
        });
      }
      held += 1;
      continue;
    }

      const exactAllocations = allocationRows((reservation as unknown as { allocations?: unknown }).allocations);
      if (isPrismaClient(db) && exactAllocations.length > 0) {
        const current = await db.platformTokenReservation.findUnique({ where: { id: reservation.id }, select: { status: true } });
        if (current?.status !== "reserved") continue;
        const releasedAllocations = exactAllocations.map((allocation) => ({ ...allocation, releasedTokens: allocation.reservedTokens }));
        await applyTerminalRuntimeMutation(db, "release", reservation as unknown as AllocationReservationRow, releasedAllocations,
          releasedAllocations.flatMap((allocation) => {
            const original = exactAllocations.find((row) => row.id === allocation.id)!;
            const amount = allocation.reservedTokens - original.settledTokens - original.releasedTokens;
            return amount > 0 ? [runtimeLedger({ userId, grantId: allocation.grantId, reservationId: reservation.id,
              entryKind: "release", amount, usageTokens: null, reasonCode: "AI_PLATFORM_TOKEN_EXPIRED_RESERVATION_RELEASED",
              idempotencyKey: allocationLedgerKey("release", userId, reservation.callKey, allocation.ordinal),
              metadata: { recovery: "expired-reservation", allocationOrdinal: allocation.ordinal } }, now)] : [];
          }), now, {});
        released += 1;
        continue;
      }
      const transitioned = await db.platformTokenReservation.updateMany({
        where: { id: reservation.id, status: "reserved" },
        data: { status: "released", releasedAt: now, reconciliationRequired: false, safeErrorCode: null },
      });
      if (transitioned.count !== 1) continue;
      if (allocations !== null && exactAllocations.length > 0) {
        await setRuntimeMutationContext(db);
        for (const allocation of exactAllocations) {
          await db.platformTokenGrant.update({ where: { id: allocation.grantId }, data: { remainingTokens: { increment: allocation.reservedTokens - allocation.settledTokens - allocation.releasedTokens } } });
          await allocations.update({ where: { id: allocation.id }, data: { releasedTokens: allocation.reservedTokens } });
          await db.platformTokenLedgerEntry.createMany({
            data: {
              id: randomUUID(), userId, grantId: allocation.grantId, reservationId: reservation.id,
              entryKind: "release", amount: allocation.reservedTokens - allocation.settledTokens - allocation.releasedTokens,
              usageTokens: null, reasonCode: "AI_PLATFORM_TOKEN_EXPIRED_RESERVATION_RELEASED", callKey: reservation.callKey,
              idempotencyKey: allocationLedgerKey("release", userId, reservation.callKey, allocation.ordinal),
              metadata: { recovery: "expired-reservation", allocationOrdinal: allocation.ordinal }, createdAt: now,
            }, skipDuplicates: true,
          });
        }
      } else {
        await setRuntimeMutationContext(db);
        await db.platformTokenGrant.update({ where: { id: reservation.grantId }, data: { remainingTokens: { increment: reservation.reservedTokens } } });
        await db.platformTokenLedgerEntry.createMany({
          data: {
            id: randomUUID(), userId, grantId: reservation.grantId, reservationId: reservation.id,
            entryKind: "release", amount: reservation.reservedTokens, usageTokens: null,
            reasonCode: "AI_PLATFORM_TOKEN_EXPIRED_RESERVATION_RELEASED", callKey: reservation.callKey,
            idempotencyKey: `release:${userId}:${reservation.callKey}`,
            metadata: { recovery: "expired-reservation" }, createdAt: now,
          }, skipDuplicates: true,
        });
      }
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
    const allocationsToCreate: Array<{ grantId: string; ordinal: number; reservedTokens: number; expiresAt: Date }> = [];
    let remainingToAllocate = reservedTokens;
    for (const candidate of grants) {
      if (remainingToAllocate <= 0) break;
      const amount = Math.min(candidate.remainingTokens, remainingToAllocate);
      if (amount <= 0) continue;
      allocationsToCreate.push({ grantId: candidate.id, ordinal: allocationsToCreate.length + 1, reservedTokens: amount, expiresAt: candidate.expiresAt });
      remainingToAllocate -= amount;
    }
    if (remainingToAllocate !== 0) return fail("AI_PLATFORM_TOKEN_EXHAUSTED");
    const grant = grants.find((candidate) => candidate.id === allocationsToCreate[0]?.grantId);
    if (grant === undefined) return fail("AI_PLATFORM_TOKEN_EXHAUSTED");
    const reservationId = randomUUID();
    const reservationExpiresAt = new Date(Math.min(
      ...allocationsToCreate.map((allocation) => allocation.expiresAt.getTime()),
      now.getTime() + RESERVATION_TTL_MS,
    ));
    const reservationData = {
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
        expiresAt: reservationExpiresAt,
        createdAt: now,
      };
    const allocationDelegateForCreate = allocationDelegate(tx);
    if (isPrismaClient(db) && allocationDelegateForCreate !== null) {
      const runtimeAllocations = allocationsToCreate.map((allocation) => ({
        id: randomUUID(), grantId: allocation.grantId, ordinal: allocation.ordinal,
        reservedTokens: allocation.reservedTokens, settledTokens: 0, releasedTokens: 0,
      }));
      await applyRuntimeMutation(tx, "reserve", {
        ...reservationData, status: "reserved", webAiGrantReferenceId: input.webAiGrantId ?? null,
        expiresAt: reservationExpiresAt.toISOString(), createdAt: now.toISOString(),
        routeUpdatedAt: snapshot.routeUpdatedAt?.toISOString() ?? null,
      }, runtimeAllocations, runtimeAllocations.map((allocation) => runtimeLedger({
        userId: input.userId, grantId: allocation.grantId, reservationId, entryKind: "reserve",
        amount: -allocation.reservedTokens, usageTokens: null, reasonCode: "AI_PLATFORM_TOKEN_RESERVED",
        idempotencyKey: allocationLedgerKey("reserve", input.userId, callKey, allocation.ordinal),
        metadata: { operation: input.operation, modelId: input.modelId, rawEstimatedTokens, quotaMultiplierBps: snapshot.quotaMultiplierBps, routeFenceFingerprint: snapshot.routeFenceFingerprint, allocationOrdinal: allocation.ordinal },
      }, now)));
    } else {
      await setRuntimeMutationContext(tx);
      for (const allocation of allocationsToCreate) {
        const updated = await tx.platformTokenGrant.updateMany({
          where: { id: allocation.grantId, remainingTokens: { gte: allocation.reservedTokens }, revokedAt: null, expiresAt: { gt: now } },
          data: { remainingTokens: { decrement: allocation.reservedTokens } },
        });
        if (updated.count !== 1) return fail("AI_PLATFORM_TOKEN_EXHAUSTED");
      }
    }
    const reservation = isPrismaClient(db) && allocationDelegateForCreate !== null
      ? await tx.platformTokenReservation.findUniqueOrThrow({ where: { id: reservationId },
      select: {
        id: true, status: true, reservedTokens: true, settledTokens: true, rawEstimatedTokens: true,
        rawSettledTokens: true, quotaMultiplierBps: true, webAiGrantId: true, routeFenceFingerprint: true,
      } })
      : await tx.platformTokenReservation.create({
      data: reservationData,
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
    if (!isPrismaClient(db) && allocationDelegateForCreate === null) {
      // Compatibility path for isolated contract fakes and pre-ENT-010
      // callers.  Real Prisma clients always have the allocation delegate.
      const legacyReservation = await tx.platformTokenReservation.update({
        where: { id: reservation.id },
        data: {
          ledgerEntries: {
            create: {
              id: randomUUID(), userId: input.userId, grantId: grant.id,
              entryKind: "reserve", amount: -reservedTokens, reasonCode: "AI_PLATFORM_TOKEN_RESERVED",
              callKey, idempotencyKey: `reserve:${input.userId}:${callKey}`,
              metadata: { operation: input.operation, modelId: input.modelId, rawEstimatedTokens, quotaMultiplierBps: snapshot.quotaMultiplierBps, routeFenceFingerprint: snapshot.routeFenceFingerprint },
              createdAt: now,
            },
          },
        },
      });
      void legacyReservation;
    } else if (!isPrismaClient(db) && allocationDelegateForCreate !== null) {
      for (const allocation of allocationsToCreate) {
        const allocationId = randomUUID();
        await allocationDelegateForCreate.create({ data: {
          id: allocationId, reservationId, grantId: allocation.grantId, ordinal: allocation.ordinal,
          reservedTokens: allocation.reservedTokens, settledTokens: 0, releasedTokens: 0, createdAt: now,
        } });
        await tx.platformTokenLedgerEntry.create({
          data: {
            id: randomUUID(), userId: input.userId, grantId: allocation.grantId, reservationId,
            entryKind: "reserve", amount: -allocation.reservedTokens, reasonCode: "AI_PLATFORM_TOKEN_RESERVED",
            callKey, idempotencyKey: allocationLedgerKey("reserve", input.userId, callKey, allocation.ordinal),
            metadata: { operation: input.operation, modelId: input.modelId, rawEstimatedTokens, quotaMultiplierBps: snapshot.quotaMultiplierBps, routeFenceFingerprint: snapshot.routeFenceFingerprint, allocationOrdinal: allocation.ordinal },
            createdAt: now,
          },
        });
      }
    }
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
    include: {
      grant: { select: { id: true, remainingTokens: true } },
      allocations: {
        orderBy: [{ ordinal: "asc" as const }],
        select: { id: true, grantId: true, ordinal: true, reservedTokens: true, settledTokens: true, releasedTokens: true },
      },
    },
  });
}

type AllocationReservationRow = Readonly<{
  id: string;
  grantId: string;
  userId: string;
  callKey: string;
  status: PlatformTokenReservationStatus;
  reservedTokens: number;
  settledTokens: number | null;
  rawEstimatedTokens: number;
  rawSettledTokens: number | null;
  quotaMultiplierBps: number;
  webAiGrantId: string | null;
  routeFenceFingerprint: string | null;
  allocations?: unknown;
}>;

function reservationResult(row: Readonly<{
  id: string;
  status: PlatformTokenReservationStatus;
  reservedTokens: number;
  settledTokens: number | null;
  rawEstimatedTokens: number;
  rawSettledTokens: number | null;
  quotaMultiplierBps: number;
  webAiGrantId: string | null;
  routeFenceFingerprint: string | null;
}>): PlatformTokenReservationResult {
  return Object.freeze({
    reservationId: row.id,
    status: row.status,
    reservedTokens: row.reservedTokens,
    settledTokens: row.settledTokens,
    rawEstimatedTokens: row.rawEstimatedTokens,
    rawSettledTokens: row.rawSettledTokens,
    quotaMultiplierBps: row.quotaMultiplierBps,
    webAiGrantId: row.webAiGrantId,
    routeFenceFingerprint: row.routeFenceFingerprint,
    billingMode: "platform" as const,
    created: false,
  });
}

async function settleAllocationAware(
  db: EntitlementDb,
  reservation: AllocationReservationRow,
  input: Readonly<{ actualTokens?: number; usageKnown: boolean }>,
  now: Date,
): Promise<PlatformTokenReservationResult> {
  const allocations = allocationRows(reservation.allocations);
  const allocationDb = allocationDelegate(db);
  if (allocationDb === null || allocations.length === 0) {
    throw new Error("PLATFORM_TOKEN_ALLOCATION_MISSING");
  }
  const hold = async (safeErrorCode: "AI_PLATFORM_TOKEN_USAGE_UNVERIFIED" | "AI_PROVIDER_CALL_RECONCILIATION_REQUIRED", usageTokens: number | null) => {
    if (isPrismaClient(db)) {
      const runtimeAllocations = allocations.map((allocation) => ({ ...allocation }));
      return applyTerminalRuntimeMutation(db, "hold", reservation, runtimeAllocations,
        runtimeAllocations.map((allocation) => runtimeLedger({
          userId: reservation.userId, grantId: allocation.grantId, reservationId: reservation.id,
          entryKind: "hold", amount: 0, usageTokens: allocation.ordinal === 1 ? usageTokens : null,
          reasonCode: safeErrorCode, idempotencyKey: allocationLedgerKey("hold", reservation.userId, reservation.callKey, allocation.ordinal),
          metadata: { allocationOrdinal: allocation.ordinal },
        }, now)), now, { safeErrorCode });
    }
    const held = await db.platformTokenReservation.update({
      where: { id: reservation.id },
      data: { status: "held", reconciliationRequired: true, safeErrorCode },
      select: { id: true, status: true, reservedTokens: true, settledTokens: true, rawEstimatedTokens: true, rawSettledTokens: true, quotaMultiplierBps: true, webAiGrantId: true, routeFenceFingerprint: true },
    });
    for (const allocation of allocations) {
      await db.platformTokenLedgerEntry.create({
        data: {
          id: randomUUID(), userId: reservation.userId, grantId: allocation.grantId, reservationId: reservation.id,
          entryKind: "hold", amount: 0, usageTokens: allocation.ordinal === 1 ? usageTokens : null, reasonCode: safeErrorCode,
          callKey: reservation.callKey, idempotencyKey: allocationLedgerKey("hold", reservation.userId, reservation.callKey, allocation.ordinal),
          metadata: { allocationOrdinal: allocation.ordinal }, createdAt: now,
        },
      });
    }
    return reservationResult(held);
  };
  if (!input.usageKnown || typeof input.actualTokens !== "number" || !Number.isSafeInteger(input.actualTokens) || input.actualTokens < 0) {
    return hold("AI_PLATFORM_TOKEN_USAGE_UNVERIFIED", null);
  }
  let chargedActual: number;
  try {
    chargedActual = calculateChargedPlatformTokens(input.actualTokens, reservation.quotaMultiplierBps);
  } catch {
    chargedActual = Number.POSITIVE_INFINITY;
  }
  if (!Number.isSafeInteger(chargedActual) || chargedActual > reservation.reservedTokens) {
    const safeUsageTokens = Number.isSafeInteger(input.actualTokens) && input.actualTokens >= 0 && input.actualTokens <= PLATFORM_RAW_TOKEN_LIMIT ? input.actualTokens : null;
    return hold("AI_PROVIDER_CALL_RECONCILIATION_REQUIRED", safeUsageTokens);
  }

  let remainingSettled = chargedActual;
  if (isPrismaClient(db)) {
    const runtimeAllocations = allocations.map((allocation) => {
      const settledTokens = Math.min(allocation.reservedTokens, remainingSettled);
      remainingSettled -= settledTokens;
      return { ...allocation, settledTokens, releasedTokens: allocation.reservedTokens - settledTokens };
    });
    return applyTerminalRuntimeMutation(db, "settle", reservation, runtimeAllocations,
      runtimeAllocations.flatMap((allocation) => {
        const released = allocation.releasedTokens - allocations.find((row) => row.id === allocation.id)!.releasedTokens;
        return [
          ...(released > 0 ? [runtimeLedger({ userId: reservation.userId, grantId: allocation.grantId, reservationId: reservation.id,
            entryKind: "release", amount: released, usageTokens: null, reasonCode: "AI_PLATFORM_TOKEN_SETTLE_RELEASE",
            idempotencyKey: allocationLedgerKey("release", reservation.userId, reservation.callKey, allocation.ordinal), metadata: { allocationOrdinal: allocation.ordinal } }, now)] : []),
          runtimeLedger({ userId: reservation.userId, grantId: allocation.grantId, reservationId: reservation.id,
            entryKind: "settle", amount: 0, usageTokens: allocation.ordinal === 1 ? input.actualTokens! : null,
            reasonCode: "AI_PLATFORM_TOKEN_SETTLED", idempotencyKey: allocationLedgerKey("settle", reservation.userId, reservation.callKey, allocation.ordinal), metadata: { allocationOrdinal: allocation.ordinal } }, now),
        ];
      }), now, { settledTokens: chargedActual, rawSettledTokens: input.actualTokens });
  }
  await setRuntimeMutationContext(db);
  for (const allocation of allocations) {
    const settledTokens = Math.min(allocation.reservedTokens, remainingSettled);
    remainingSettled -= settledTokens;
    const releasedTokens = allocation.reservedTokens - settledTokens - allocation.releasedTokens;
    if (releasedTokens > 0) {
      await db.platformTokenGrant.update({ where: { id: allocation.grantId }, data: { remainingTokens: { increment: releasedTokens } } });
      await db.platformTokenLedgerEntry.create({
        data: {
          id: randomUUID(), userId: reservation.userId, grantId: allocation.grantId, reservationId: reservation.id,
          entryKind: "release", amount: releasedTokens, usageTokens: null, reasonCode: "AI_PLATFORM_TOKEN_SETTLE_RELEASE",
          callKey: reservation.callKey, idempotencyKey: allocationLedgerKey("release", reservation.userId, reservation.callKey, allocation.ordinal),
          metadata: { allocationOrdinal: allocation.ordinal }, createdAt: now,
        },
      });
    }
    await allocationDb.update({ where: { id: allocation.id }, data: { settledTokens, releasedTokens: allocation.releasedTokens + releasedTokens } });
    await db.platformTokenLedgerEntry.create({
      data: {
        id: randomUUID(), userId: reservation.userId, grantId: allocation.grantId, reservationId: reservation.id,
        entryKind: "settle", amount: 0, usageTokens: allocation.ordinal === 1 ? input.actualTokens : null,
        reasonCode: "AI_PLATFORM_TOKEN_SETTLED", callKey: reservation.callKey,
        idempotencyKey: allocationLedgerKey("settle", reservation.userId, reservation.callKey, allocation.ordinal),
        metadata: { allocationOrdinal: allocation.ordinal }, createdAt: now,
      },
    });
  }
  const settled = await db.platformTokenReservation.update({
    where: { id: reservation.id },
    data: { status: "settled", settledTokens: chargedActual, rawSettledTokens: input.actualTokens, settledAt: now, reconciliationRequired: false, safeErrorCode: null },
    select: { id: true, status: true, reservedTokens: true, settledTokens: true, rawEstimatedTokens: true, rawSettledTokens: true, quotaMultiplierBps: true, webAiGrantId: true, routeFenceFingerprint: true },
  });
  return reservationResult(settled);
}

async function releaseAllocationAware(
  db: EntitlementDb,
  reservation: AllocationReservationRow,
  now: Date,
): Promise<PlatformTokenReservationResult> {
  const allocations = allocationRows(reservation.allocations);
  const allocationDb = allocationDelegate(db);
  if (allocationDb === null || allocations.length === 0) throw new Error("PLATFORM_TOKEN_ALLOCATION_MISSING");
  if (isPrismaClient(db)) {
    const runtimeAllocations = allocations.map((allocation) => ({ ...allocation, releasedTokens: allocation.reservedTokens }));
    return applyTerminalRuntimeMutation(db, "release", reservation, runtimeAllocations,
      runtimeAllocations.flatMap((allocation) => {
        const amount = allocation.reservedTokens - allocation.settledTokens
          - allocations.find((row) => row.id === allocation.id)!.releasedTokens;
        return amount > 0 ? [runtimeLedger({ userId: reservation.userId, grantId: allocation.grantId, reservationId: reservation.id,
          entryKind: "release", amount, usageTokens: null, reasonCode: "AI_PLATFORM_TOKEN_RELEASED",
          idempotencyKey: allocationLedgerKey("release", reservation.userId, reservation.callKey, allocation.ordinal), metadata: { allocationOrdinal: allocation.ordinal } }, now)] : [];
      }), now, {});
  }
  await setRuntimeMutationContext(db);
  for (const allocation of allocations) {
    const unreleased = allocation.reservedTokens - allocation.settledTokens - allocation.releasedTokens;
    if (unreleased > 0) {
      await db.platformTokenGrant.update({ where: { id: allocation.grantId }, data: { remainingTokens: { increment: unreleased } } });
      await db.platformTokenLedgerEntry.create({
        data: {
          id: randomUUID(), userId: reservation.userId, grantId: allocation.grantId, reservationId: reservation.id,
          entryKind: "release", amount: unreleased, usageTokens: null, reasonCode: "AI_PLATFORM_TOKEN_RELEASED",
          callKey: reservation.callKey, idempotencyKey: allocationLedgerKey("release", reservation.userId, reservation.callKey, allocation.ordinal),
          metadata: { allocationOrdinal: allocation.ordinal }, createdAt: now,
        },
      });
    }
    await allocationDb.update({ where: { id: allocation.id }, data: { releasedTokens: allocation.reservedTokens } });
  }
  const released = await db.platformTokenReservation.update({
    where: { id: reservation.id },
    data: { status: "released", releasedAt: now, reconciliationRequired: false, safeErrorCode: null },
    select: { id: true, status: true, reservedTokens: true, settledTokens: true, rawEstimatedTokens: true, rawSettledTokens: true, quotaMultiplierBps: true, webAiGrantId: true, routeFenceFingerprint: true },
  });
  return reservationResult(released);
}

async function holdAllocationAware(
  db: EntitlementDb,
  reservation: AllocationReservationRow,
  safeErrorCode: "AI_PLATFORM_TOKEN_USAGE_UNVERIFIED" | "AI_PROVIDER_CALL_RECONCILIATION_REQUIRED",
  now: Date,
): Promise<PlatformTokenReservationResult> {
  const allocations = allocationRows(reservation.allocations);
  if (allocationDelegate(db) === null || allocations.length === 0) throw new Error("PLATFORM_TOKEN_ALLOCATION_MISSING");
  if (isPrismaClient(db)) {
    return applyTerminalRuntimeMutation(db, "hold", reservation, allocations,
      allocations.map((allocation) => runtimeLedger({ userId: reservation.userId, grantId: allocation.grantId, reservationId: reservation.id,
        entryKind: "hold", amount: 0, usageTokens: null, reasonCode: safeErrorCode,
        idempotencyKey: allocationLedgerKey("hold", reservation.userId, reservation.callKey, allocation.ordinal), metadata: { allocationOrdinal: allocation.ordinal } }, now)),
      now, { safeErrorCode });
  }
  const held = await db.platformTokenReservation.update({
    where: { id: reservation.id },
    data: { status: "held", reconciliationRequired: true, safeErrorCode },
    select: { id: true, status: true, reservedTokens: true, settledTokens: true, rawEstimatedTokens: true, rawSettledTokens: true, quotaMultiplierBps: true, webAiGrantId: true, routeFenceFingerprint: true },
  });
  for (const allocation of allocations) {
    await db.platformTokenLedgerEntry.create({
      data: {
        id: randomUUID(), userId: reservation.userId, grantId: allocation.grantId, reservationId: reservation.id,
        entryKind: "hold", amount: 0, usageTokens: null, reasonCode: safeErrorCode, callKey: reservation.callKey,
        idempotencyKey: allocationLedgerKey("hold", reservation.userId, reservation.callKey, allocation.ordinal),
        metadata: { allocationOrdinal: allocation.ordinal }, createdAt: now,
      },
    });
  }
  return reservationResult(held);
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
    if (allocationDelegate(tx) !== null && allocationRows((reservation as unknown as { allocations?: unknown }).allocations).length > 0) {
      return settleAllocationAware(tx, reservation as unknown as AllocationReservationRow, input, now);
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
    if (allocationDelegate(tx) !== null && allocationRows((reservation as unknown as { allocations?: unknown }).allocations).length > 0) {
      return releaseAllocationAware(tx, reservation as unknown as AllocationReservationRow, now);
    }
    await setRuntimeMutationContext(tx);
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
    if (allocationDelegate(tx) !== null && allocationRows((reservation as unknown as { allocations?: unknown }).allocations).length > 0) {
      const safeErrorCode = input.errorCode === "AI_PLATFORM_TOKEN_USAGE_UNVERIFIED"
        ? input.errorCode
        : "AI_PROVIDER_CALL_RECONCILIATION_REQUIRED";
      return holdAllocationAware(tx, reservation as unknown as AllocationReservationRow, safeErrorCode, now);
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
  if (provider.scope !== "platform" || provider.ownerUserId !== null) {
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

export type PlatformCreditRouteSnapshot = Readonly<{
  operation: AiOperation;
  version: number;
  quotaMultiplierBps: number;
}>;

export type PlatformCreditSummary = Readonly<{
  unit: "platform_credit";
  totalCredits: number;
  availableCredits: number;
  usedCredits: number;
  reservedCredits: number;
  heldCredits: number;
  nextExpiryAt: Date | null;
  routeSnapshots: readonly PlatformCreditRouteSnapshot[];
  membership: MembershipPublicStatus;
  // Server-internal compatibility aliases. The profile API exposes only the
  // platform-credit names above.
  availableTokens: number;
  reservedTokens: number;
}>;

async function platformCreditSummaryInTransaction(
  userId: string,
  db: EntitlementDb,
  fallbackNow: Date,
  readDatabaseClock = true,
): Promise<PlatformCreditSummary> {
  const queryRaw = (db as unknown as { $queryRaw?: (query: Prisma.Sql) => Promise<unknown> }).$queryRaw;
  let current = fallbackNow;
  if (readDatabaseClock && typeof queryRaw === "function") {
    const rows = await queryRaw.call(db, Prisma.sql`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS "now"`) as Array<{ now?: Date }>;
    if (!(rows[0]?.now instanceof Date) || Number.isNaN(rows[0]!.now!.getTime())) return fail("AI_PLATFORM_TOKEN_PROJECTION_INCONSISTENT");
    current = rows[0]!.now!;
  }
  const [grants, membership, routeSnapshots] = await Promise.all([
    db.platformTokenGrant.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: current } },
      select: {
        id: true,
        amount: true,
        remainingTokens: true,
        expiresAt: true,
        allocations: {
          select: {
            grantId: true,
            ordinal: true,
            reservedTokens: true,
            settledTokens: true,
            releasedTokens: true,
            reservation: { select: { userId: true, grantId: true, status: true } },
          },
        },
      },
    }),
    getMembershipStatus(userId, db, current),
    db.platformDefaultAiRoute.findMany({
      where: { status: "active" },
      orderBy: [{ operation: "asc" }, { version: "asc" }],
      select: { operation: true, version: true, quotaMultiplierBps: true },
    }),
  ]);
  let totalCredits = 0;
  let availableCredits = 0;
  let usedCredits = 0;
  let reservedCredits = 0;
  let heldCredits = 0;
  for (const grant of grants) {
    if (!Number.isSafeInteger(grant.amount) || grant.amount < 0 || !Number.isSafeInteger(grant.remainingTokens) || grant.remainingTokens < 0 || grant.remainingTokens > grant.amount) return fail("AI_PLATFORM_TOKEN_PROJECTION_INCONSISTENT");
    totalCredits += grant.amount;
    availableCredits += grant.remainingTokens;
    for (const allocation of grant.allocations) {
      // reservation.grantId is the legacy first-allocation pointer.  A
      // multi-grant reservation legitimately points every later allocation
      // back to that first grant, so only ordinal 1 may be checked against
      // the parent pointer; each allocation's own grantId remains mandatory.
      if (allocation.grantId !== grant.id || allocation.reservation.userId !== userId || (allocation.ordinal === 1 && allocation.reservation.grantId !== grant.id) || !Number.isSafeInteger(allocation.reservedTokens) || allocation.reservedTokens <= 0 || allocation.settledTokens < 0 || allocation.releasedTokens < 0 || allocation.settledTokens + allocation.releasedTokens > allocation.reservedTokens) return fail("AI_PLATFORM_TOKEN_PROJECTION_INCONSISTENT");
      if (allocation.reservation.status === "settled") usedCredits += allocation.settledTokens;
      else if (allocation.reservation.status === "reserved") reservedCredits += allocation.reservedTokens;
      else if (allocation.reservation.status === "held") heldCredits += allocation.reservedTokens;
    }
  }
  const sum = availableCredits + usedCredits + reservedCredits + heldCredits;
  if (![totalCredits, availableCredits, usedCredits, reservedCredits, heldCredits, sum].every((value) => Number.isSafeInteger(value) && value >= 0) || sum !== totalCredits) return fail("AI_PLATFORM_TOKEN_PROJECTION_INCONSISTENT");
  const route = routeSnapshots.map((row) => Object.freeze({ operation: row.operation, version: row.version, quotaMultiplierBps: row.quotaMultiplierBps }));
  const nextExpiryAt = grants.map((grant) => grant.expiresAt).sort((left, right) => left.getTime() - right.getTime())[0] ?? null;
  return Object.freeze({ unit: "platform_credit", totalCredits, availableCredits, usedCredits, reservedCredits, heldCredits, nextExpiryAt, routeSnapshots: Object.freeze(route), membership, availableTokens: availableCredits, reservedTokens: reservedCredits });
}

export async function getPlatformTokenSummary(userId: string, db: EntitlementDb = getDb(), now = new Date()): Promise<PlatformCreditSummary> {
  if (!isPrismaClient(db)) return platformCreditSummaryInTransaction(userId, db, now);
  return db.$transaction(async (tx) => {
    await tx.$executeRaw(Prisma.sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`);
    await tx.$executeRaw(Prisma.sql`SET TRANSACTION READ ONLY`);
    return platformCreditSummaryInTransaction(userId, tx, now);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

/**
 * Project entitlements inside a caller-owned transaction.  The caller must
 * provide the clock value captured by that transaction; this helper never
 * opens a nested transaction or reads a second, potentially different clock.
 */
export async function getPlatformTokenSummaryInTransaction(
  userId: string,
  db: EntitlementDb,
  now: Date,
): Promise<PlatformCreditSummary> {
  return platformCreditSummaryInTransaction(userId, db, now, false);
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
