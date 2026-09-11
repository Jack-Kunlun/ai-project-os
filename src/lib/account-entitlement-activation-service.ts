import { createHash, randomUUID } from "node:crypto";
import { Prisma, type AccountEntitlementActivationDecision, type AccountEntitlementActivationSource, type PrismaClient } from "@prisma/client";
import { assertEntitlementWriterSession, getEntitlementDb, isEntitlementDatabase } from "@/lib/db";
import {
  PLATFORM_GRANT_OFFER_ELIGIBILITY_KEY,
} from "@/lib/platform-grant-offer-policy-service";
import { isSerializationConflict } from "@/lib/project-snapshot-errors";

export const ACCOUNT_ENTITLEMENT_LIFECYCLE_KEY = "initial_account_v1" as const;
export const ACCOUNT_ENTITLEMENT_ACTIVATION_CONTEXT = "service-v1" as const;
export const ACCOUNT_ENTITLEMENT_ACTIVATION_SOURCES = [
  "bootstrap",
  "localProvisioning",
  "githubRegistration",
  "oidcRegistration",
  "oidcInvitationRegistration",
  "historicalBackfill",
] as const satisfies readonly AccountEntitlementActivationSource[];

const ACCOUNT_ENTITLEMENT_LOCK_NAMESPACE = 29082041;
const ACCOUNT_ENTITLEMENT_RETRY_LIMIT = 3;
const DAY_MS = 86_400_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;

export type AccountEntitlementActivationSourceName = typeof ACCOUNT_ENTITLEMENT_ACTIVATION_SOURCES[number];
export type AccountEntitlementActivationDb = PrismaClient | Prisma.TransactionClient;

export type AccountEntitlementActivationContext = Readonly<{
  userId: string;
  source: AccountEntitlementActivationSourceName;
  actorId?: string | null;
  actorAccountAccessVersion?: number;
  accountAccessVersion?: number;
  evidenceKind?: string | null;
  evidenceRef?: string | null;
  evidenceRefDigest?: string | null;
  now?: Date;
}>;

export type AccountEntitlementActivationErrorCode =
  | "ACCOUNT_ENTITLEMENT_INVALID_INPUT"
  | "ACCOUNT_ENTITLEMENT_ACCOUNT_NOT_FOUND"
  | "ACCOUNT_ENTITLEMENT_ACCOUNT_DISABLED"
  | "ACCOUNT_ENTITLEMENT_ACTOR_INVALID"
  | "ACCOUNT_ENTITLEMENT_EPOCH_STALE"
  | "ACCOUNT_ENTITLEMENT_POLICY_INVALID"
  | "ACCOUNT_ENTITLEMENT_BACKFILL_POLICY_STALE"
  | "ACCOUNT_ENTITLEMENT_ACTIVATION_CONFLICT"
  | "ACCOUNT_ENTITLEMENT_SERVICE_CONTEXT_REQUIRED";

export class AccountEntitlementActivationError extends Error {
  constructor(readonly code: AccountEntitlementActivationErrorCode) {
    super(code);
    this.name = "AccountEntitlementActivationError";
  }
}

function fail(code: AccountEntitlementActivationErrorCode): never {
  throw new AccountEntitlementActivationError(code);
}

function validUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function accountEntitlementPolicyFingerprint(input: Readonly<{ offerVersion: string; amount: number; validForDays: number; eligibilityKey: string }>): string {
  return digest(JSON.stringify({
    offerVersion: input.offerVersion,
    amount: input.amount,
    validForDays: input.validForDays,
    eligibilityKey: input.eligibilityKey,
  }));
}

function isPrismaClient(db: AccountEntitlementActivationDb): db is PrismaClient {
  return typeof (db as unknown as { $transaction?: unknown }).$transaction === "function";
}

async function serializable<T>(db: AccountEntitlementActivationDb, callback: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  if (!isPrismaClient(db)) return callback(db);
  for (let attempt = 0; attempt < ACCOUNT_ENTITLEMENT_RETRY_LIMIT; attempt += 1) {
    try {
      return await db.$transaction(async (tx) => {
        if (isEntitlementDatabase(db)) await assertEntitlementWriterSession(tx);
        return callback(tx);
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (!isSerializationConflict(error) || attempt + 1 >= ACCOUNT_ENTITLEMENT_RETRY_LIMIT) throw error;
    }
  }
  throw new Error("ACCOUNT_ENTITLEMENT_RETRY_EXHAUSTED");
}

async function lockAccount(db: Prisma.TransactionClient, userId: string): Promise<void> {
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, ${ACCOUNT_ENTITLEMENT_LOCK_NAMESPACE}))`;
}

async function setActivationContext(db: Prisma.TransactionClient, mutationId: string): Promise<void> {
  await db.$executeRaw`SELECT set_config('app.account_entitlement_activation_context', ${ACCOUNT_ENTITLEMENT_ACTIVATION_CONTEXT}, true)`;
  await db.$executeRaw`SELECT set_config('app.account_entitlement_activation_transaction_id', ${mutationId}, true)`;
}

function canonicalEvidenceDigest(input: AccountEntitlementActivationContext): string | null {
  if (input.evidenceRefDigest !== undefined && input.evidenceRefDigest !== null) {
    if (!DIGEST_PATTERN.test(input.evidenceRefDigest)) return fail("ACCOUNT_ENTITLEMENT_INVALID_INPUT");
    return input.evidenceRefDigest;
  }
  if (input.evidenceRef === undefined || input.evidenceRef === null) return null;
  if (input.evidenceRef.length === 0 || input.evidenceRef.length > 512) return fail("ACCOUNT_ENTITLEMENT_INVALID_INPUT");
  return digest(input.evidenceRef);
}

function canonicalContext(input: AccountEntitlementActivationContext): AccountEntitlementActivationContext {
  if (!validUuid(input.userId) || !ACCOUNT_ENTITLEMENT_ACTIVATION_SOURCES.includes(input.source)) {
    return fail("ACCOUNT_ENTITLEMENT_INVALID_INPUT");
  }
  if (input.actorId !== undefined && input.actorId !== null && !validUuid(input.actorId)) {
    return fail("ACCOUNT_ENTITLEMENT_INVALID_INPUT");
  }
  if (input.evidenceKind !== undefined && input.evidenceKind !== null && (!/^[a-z][a-z0-9_-]{1,31}$/u.test(input.evidenceKind))) {
    return fail("ACCOUNT_ENTITLEMENT_INVALID_INPUT");
  }
  if (input.accountAccessVersion !== undefined && (!Number.isSafeInteger(input.accountAccessVersion) || input.accountAccessVersion < 1)) {
    return fail("ACCOUNT_ENTITLEMENT_INVALID_INPUT");
  }
  if (input.actorAccountAccessVersion !== undefined && (!Number.isSafeInteger(input.actorAccountAccessVersion) || input.actorAccountAccessVersion < 1)) {
    return fail("ACCOUNT_ENTITLEMENT_INVALID_INPUT");
  }
  return Object.freeze({ ...input, actorId: input.actorId ?? null, evidenceRefDigest: canonicalEvidenceDigest(input) });
}

const activationSelect = {
  id: true,
  userId: true,
  lifecycleKey: true,
  source: true,
  actorKind: true,
  actorId: true,
  actorAccountAccessVersion: true,
  accountAccessVersion: true,
  evidenceKind: true,
  evidenceRefDigest: true,
  policyId: true,
  policyRevision: true,
  policyFingerprint: true,
  offerVersion: true,
  offerAmount: true,
  offerValidForDays: true,
  eligibilityKey: true,
  grantId: true,
  decision: true,
  status: true,
  mutationTransactionId: true,
  createdAt: true,
} as const;

export type AccountEntitlementActivation = Prisma.AccountEntitlementActivationGetPayload<{ select: typeof activationSelect }>;

export type AccountEntitlementActivationPublic = Readonly<{
  id: string;
  source: AccountEntitlementActivationSourceName;
  decision: AccountEntitlementActivationDecision;
  status: AccountEntitlementActivationDecision;
  createdAt: Date;
}>;

export function publicAccountEntitlementActivation(row: AccountEntitlementActivation): AccountEntitlementActivationPublic {
  return Object.freeze({
    id: row.id,
    source: row.source,
    decision: row.decision,
    status: row.status,
    createdAt: row.createdAt,
  });
}

async function activateInTransaction(db: Prisma.TransactionClient, input: AccountEntitlementActivationContext): Promise<AccountEntitlementActivation> {
  const context = canonicalContext(input);
  const actorId = context.actorId ?? null;
  if (actorId !== null && actorId !== context.userId) await lockAccount(db, actorId);
  await lockAccount(db, context.userId);
  const user = await db.appUser.findUnique({
    where: { id: context.userId },
    select: { id: true, disabledAt: true, accountAccessVersion: true },
  });
  if (user === null) return fail("ACCOUNT_ENTITLEMENT_ACCOUNT_NOT_FOUND");
  if (user.disabledAt !== null) return fail("ACCOUNT_ENTITLEMENT_ACCOUNT_DISABLED");
  if (context.accountAccessVersion !== undefined && user.accountAccessVersion !== context.accountAccessVersion) {
    return fail("ACCOUNT_ENTITLEMENT_EPOCH_STALE");
  }
  let actorAccountAccessVersion: number | null = null;
  if (actorId !== null) {
    const actor = await db.appUser.findUnique({ where: { id: actorId }, select: { id: true, disabledAt: true, accountAccessVersion: true } });
    if (actor === null || actor.disabledAt !== null) return fail("ACCOUNT_ENTITLEMENT_ACTOR_INVALID");
    if (context.actorAccountAccessVersion !== undefined && actor.accountAccessVersion !== context.actorAccountAccessVersion) {
      return fail("ACCOUNT_ENTITLEMENT_EPOCH_STALE");
    }
    actorAccountAccessVersion = actor.accountAccessVersion;
  }

  const existing = await db.accountEntitlementActivation.findUnique({
    where: { userId_lifecycleKey: { userId: context.userId, lifecycleKey: ACCOUNT_ENTITLEMENT_LIFECYCLE_KEY } },
    select: activationSelect,
  });
  if (existing !== null) return existing;

  await db.$executeRaw`SELECT pg_advisory_xact_lock(${781452904})`;
  const activePolicy = await db.platformGrantOfferPolicy.findFirst({
    where: { status: "active" },
    orderBy: [{ activatedAt: "desc" }, { id: "desc" }],
    select: { id: true, offerVersion: true, amount: true, validForDays: true, eligibilityKey: true },
  });
  const existingGrant = await db.platformTokenGrant.findFirst({
    where: { userId: context.userId, kind: "signup" },
    orderBy: [{ issuedAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      offerVersion: true,
      amount: true,
      offerAmount: true,
      offerValidForDays: true,
      eligibilityKey: true,
      issuedAt: true,
      expiresAt: true,
    },
  });
  const now = context.now ?? new Date();
  const evidenceKind = context.evidenceKind ?? null;
  const evidenceRefDigest = context.evidenceRefDigest ?? null;
  const mutationId = randomUUID();
  await setActivationContext(db, mutationId);

  let decision: AccountEntitlementActivationDecision;
  let grantId: string | null = null;
  let policySnapshot = activePolicy;
  if (existingGrant !== null) {
    decision = "already_issued";
    grantId = existingGrant.id;
    if (policySnapshot === null || policySnapshot.offerVersion !== existingGrant.offerVersion) {
      policySnapshot = await db.platformGrantOfferPolicy.findUnique({
        where: { offerVersion: existingGrant.offerVersion },
        select: { id: true, offerVersion: true, amount: true, validForDays: true, eligibilityKey: true },
      });
    }
  } else if (activePolicy === null) {
    decision = "no_active_offer";
  } else {
    if (activePolicy.eligibilityKey !== PLATFORM_GRANT_OFFER_ELIGIBILITY_KEY) return fail("ACCOUNT_ENTITLEMENT_POLICY_INVALID");
    decision = "granted";
    grantId = randomUUID();
    await db.platformTokenGrant.create({
      data: {
        id: grantId,
        userId: context.userId,
        kind: "signup",
        amount: activePolicy.amount,
        remainingTokens: activePolicy.amount,
        offerVersion: activePolicy.offerVersion,
        offerAmount: activePolicy.amount,
        offerValidForDays: activePolicy.validForDays,
        eligibilityKey: activePolicy.eligibilityKey,
        eligibilitySource: context.source,
        issuedById: actorId,
        issuedAt: now,
        expiresAt: new Date(now.getTime() + activePolicy.validForDays * 86_400_000),
        createdAt: now,
        updatedAt: now,
      },
    });
    await db.platformTokenLedgerEntry.create({
      data: {
        id: randomUUID(),
        userId: context.userId,
        grantId,
        entryKind: "grant",
        amount: activePolicy.amount,
        reasonCode: "AI_SIGNUP_GRANT",
        callKey: null,
        idempotencyKey: `grant:signup:${context.userId}:${activePolicy.offerVersion}`,
        metadata: { offerVersion: activePolicy.offerVersion, eligibilityKey: activePolicy.eligibilityKey, eligibilitySource: context.source },
        createdAt: now,
      },
    });
  }

  const offerVersion = decision === "already_issued"
    ? existingGrant?.offerVersion ?? null
    : policySnapshot?.offerVersion ?? null;
  const offerAmount = decision === "already_issued"
    ? existingGrant?.offerAmount ?? existingGrant?.amount ?? null
    : policySnapshot?.amount ?? null;
  const inferredLegacyValidForDays = existingGrant === null || existingGrant.offerValidForDays !== null
    ? existingGrant?.offerValidForDays ?? null
    : (() => {
      const elapsed = existingGrant.expiresAt.getTime() - existingGrant.issuedAt.getTime();
      const days = elapsed / DAY_MS;
      return Number.isInteger(days) && days >= 1 && days <= 3650 ? days : null;
    })();
  const offerValidForDays = decision === "already_issued"
    ? inferredLegacyValidForDays
    : policySnapshot?.validForDays ?? null;
  const eligibilityKey = decision === "already_issued"
    ? existingGrant?.eligibilityKey ?? policySnapshot?.eligibilityKey ?? PLATFORM_GRANT_OFFER_ELIGIBILITY_KEY
    : policySnapshot?.eligibilityKey ?? null;
  const activation = await db.accountEntitlementActivation.create({
    data: {
      id: randomUUID(),
      userId: context.userId,
      lifecycleKey: ACCOUNT_ENTITLEMENT_LIFECYCLE_KEY,
      source: context.source,
      actorKind: actorId === null ? "system" : "user",
      actorId,
      actorAccountAccessVersion,
      accountAccessVersion: user.accountAccessVersion,
      evidenceKind,
      evidenceRefDigest,
      policyId: policySnapshot?.id ?? null,
      policyRevision: policySnapshot === null ? null : 1,
      policyFingerprint: policySnapshot === null ? null : accountEntitlementPolicyFingerprint(policySnapshot),
      offerVersion,
      offerAmount,
      offerValidForDays,
      eligibilityKey,
      grantId,
      decision,
      status: decision,
      mutationTransactionId: mutationId,
      createdAt: now,
    },
    select: activationSelect,
  });
  await db.accountEntitlementActivationAudit.create({
    data: {
      id: randomUUID(),
      activationId: activation.id,
      userId: activation.userId,
      source: activation.source,
      action: existingGrant === null ? "created" : "linked",
      decision: activation.decision,
      statusAfter: activation.status,
      actorKind: activation.actorKind,
      actorId: activation.actorId,
      actorAccountAccessVersion: activation.actorAccountAccessVersion,
      offerVersion: activation.offerVersion,
      offerAmount: activation.offerAmount,
      offerValidForDays: activation.offerValidForDays,
      eligibilityKey: activation.eligibilityKey,
      policyRevision: activation.policyRevision,
      mutationTransactionId: activation.mutationTransactionId ?? mutationId,
      createdAt: now,
    },
  });
  return activation;
}

/**
 * The only production entry point that creates the account entitlement
 * lifecycle fact. Callers must pass a server-selected source; the client can
 * never choose terms or eligibility.
 */
export async function activateAccountEntitlements(
  input: AccountEntitlementActivationContext,
  dbInput?: AccountEntitlementActivationDb,
): Promise<AccountEntitlementActivation> {
  const db = dbInput ?? getEntitlementDb();
  return serializable(db, (tx) => activateInTransaction(tx, input));
}

export const ACCOUNT_ENTITLEMENT_ACTIVATION_SELECT = activationSelect;
