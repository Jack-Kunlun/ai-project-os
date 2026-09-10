import { randomUUID } from "node:crypto";
import { Prisma, type PlatformGrantOfferPolicyStatus, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { assertAccountAccessForActor, requireAccountAccessVersion } from "@/lib/account-access-guard";
import { getDb } from "@/lib/db";
import { isSerializationConflict } from "@/lib/project-snapshot-errors";

export const PLATFORM_GRANT_OFFER_ELIGIBILITY_KEY = "verified_identity_v1" as const;
export const PLATFORM_GRANT_OFFER_DEFAULT_VERSION = "signup-500k-v1" as const;
export const PLATFORM_GRANT_OFFER_DEFAULT_AMOUNT = 500_000 as const;
export const PLATFORM_GRANT_OFFER_DEFAULT_VALID_FOR_DAYS = 30 as const;
export const PLATFORM_GRANT_OFFER_MAX_AMOUNT = 10_000_000 as const;
export const PLATFORM_GRANT_OFFER_MAX_VALID_FOR_DAYS = 3_650 as const;
export const PLATFORM_GRANT_OFFER_MAX_BODY_BYTES = 4 * 1_024;

const POLICY_LOCK_ID = 781452904;
const POLICY_CONTEXT = "service-v1";
const POLICY_RETRY_LIMIT = 3;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const OFFER_VERSION_PATTERN = /^[a-z0-9][a-z0-9._-]{2,63}$/u;
const SIGNUP_ELIGIBILITY_SOURCES = ["verifiedGithub", "verifiedOidc"] as const;

export type SignupEligibilitySource = "verifiedGithub" | "verifiedOidc";
export type PlatformGrantOfferPolicyDb = PrismaClient | Prisma.TransactionClient;
export type PlatformGrantOfferPolicyActor = Readonly<{
  id: string;
  role: string;
  accountAccessVersion?: number;
}>;

export type PlatformGrantOfferPolicyErrorCode =
  | "PLATFORM_GRANT_OFFER_POLICY_INVALID_INPUT"
  | "PLATFORM_GRANT_OFFER_POLICY_ADMIN_REQUIRED"
  | "PLATFORM_GRANT_OFFER_POLICY_NOT_FOUND"
  | "PLATFORM_GRANT_OFFER_POLICY_CONFLICT"
  | "PLATFORM_GRANT_OFFER_POLICY_STALE"
  | "PLATFORM_GRANT_OFFER_POLICY_INVALID_TRANSITION"
  | "PLATFORM_GRANT_OFFER_POLICY_REASON_REQUIRED"
  | "PLATFORM_GRANT_OFFER_POLICY_BOOTSTRAP_CONFLICT";

export class PlatformGrantOfferPolicyError extends Error {
  constructor(readonly code: PlatformGrantOfferPolicyErrorCode) {
    super(code);
    this.name = "PlatformGrantOfferPolicyError";
  }
}

function fail(code: PlatformGrantOfferPolicyErrorCode): never {
  throw new PlatformGrantOfferPolicyError(code);
}

function isPrismaClient(db: PlatformGrantOfferPolicyDb): db is PrismaClient {
  return typeof (db as unknown as { $transaction?: unknown }).$transaction === "function";
}

function isKnown(error: unknown, code: string): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
}

function canonicalActorHint(actor: unknown): PlatformGrantOfferPolicyActor {
  if (typeof actor !== "object" || actor === null) return fail("PLATFORM_GRANT_OFFER_POLICY_ADMIN_REQUIRED");
  const value = actor as { id?: unknown; role?: unknown; accountAccessVersion?: unknown };
  if (!z.string().uuid().safeParse(value.id).success || value.role !== "admin") {
    return fail("PLATFORM_GRANT_OFFER_POLICY_ADMIN_REQUIRED");
  }
  try {
    requireAccountAccessVersion(value);
  } catch {
    return fail("PLATFORM_GRANT_OFFER_POLICY_ADMIN_REQUIRED");
  }
  return Object.freeze({ id: value.id as string, role: "admin", accountAccessVersion: value.accountAccessVersion as number });
}

async function assertCurrentAdmin(actor: PlatformGrantOfferPolicyActor, db: PlatformGrantOfferPolicyDb): Promise<PlatformGrantOfferPolicyActor> {
  const current = await db.appUser.findUnique({
    where: { id: actor.id },
    select: { id: true, role: true, disabledAt: true, accountAccessVersion: true },
  });
  if (current === null || current.role !== "admin" || current.disabledAt !== null) {
    return fail("PLATFORM_GRANT_OFFER_POLICY_ADMIN_REQUIRED");
  }
  try {
    await assertAccountAccessForActor(db, actor);
  } catch {
    return fail("PLATFORM_GRANT_OFFER_POLICY_ADMIN_REQUIRED");
  }
  return Object.freeze({ id: current.id, role: "admin", accountAccessVersion: current.accountAccessVersion });
}

async function lockPolicyDomain(db: PlatformGrantOfferPolicyDb): Promise<void> {
  await db.$executeRaw`SELECT pg_advisory_xact_lock(${POLICY_LOCK_ID})`;
}

async function lockActor(db: PlatformGrantOfferPolicyDb, actorId: string): Promise<void> {
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${actorId}, 29082027))`;
}

async function setPolicyContext(db: PlatformGrantOfferPolicyDb, transactionId: string): Promise<void> {
  await db.$executeRaw`SELECT set_config('app.platform_grant_offer_policy_context', ${POLICY_CONTEXT}, true)`;
  await db.$executeRaw`SELECT set_config('app.platform_grant_offer_policy_transaction_id', ${transactionId}, true)`;
}

const policySelect = {
  id: true,
  offerVersion: true,
  status: true,
  amount: true,
  validForDays: true,
  eligibilityKey: true,
  createdById: true,
  updatedById: true,
  activatedById: true,
  retiredById: true,
  createdAt: true,
  updatedAt: true,
  activatedAt: true,
  retiredAt: true,
  audits: {
    orderBy: { createdAt: "desc" as const },
    take: 20,
    select: {
      action: true,
      statusBefore: true,
      statusAfter: true,
      reasonRecorded: true,
      createdAt: true,
    },
  },
} as const;

type PolicyRow = Prisma.PlatformGrantOfferPolicyGetPayload<{ select: typeof policySelect }>;

export type PlatformGrantOfferPolicyPublic = Readonly<{
  id: string;
  offerVersion: string;
  status: PlatformGrantOfferPolicyStatus;
  amount: number;
  validForDays: number;
  eligibilityKey: typeof PLATFORM_GRANT_OFFER_ELIGIBILITY_KEY;
  createdAt: Date;
  updatedAt: Date;
  activatedAt: Date | null;
  retiredAt: Date | null;
  audits: readonly Readonly<{
    action: string;
    statusBefore: PlatformGrantOfferPolicyStatus | null;
    statusAfter: PlatformGrantOfferPolicyStatus;
    reasonRecorded: boolean;
    createdAt: Date;
  }>[];
}>;

function publicPolicy(row: PolicyRow): PlatformGrantOfferPolicyPublic {
  if (row.eligibilityKey !== PLATFORM_GRANT_OFFER_ELIGIBILITY_KEY) {
    return fail("PLATFORM_GRANT_OFFER_POLICY_CONFLICT");
  }
  return Object.freeze({
    id: row.id,
    offerVersion: row.offerVersion,
    status: row.status,
    amount: row.amount,
    validForDays: row.validForDays,
    eligibilityKey: PLATFORM_GRANT_OFFER_ELIGIBILITY_KEY,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    activatedAt: row.activatedAt,
    retiredAt: row.retiredAt,
    audits: Object.freeze(row.audits.map((audit) => Object.freeze({
      action: audit.action,
      statusBefore: audit.statusBefore,
      statusAfter: audit.statusAfter,
      reasonRecorded: audit.reasonRecorded,
      createdAt: audit.createdAt,
    }))),
  });
}

const policyInputSchema = z.object({
  offerVersion: z.string().regex(OFFER_VERSION_PATTERN),
  amount: z.number().int().min(1).max(PLATFORM_GRANT_OFFER_MAX_AMOUNT),
  validForDays: z.number().int().min(1).max(PLATFORM_GRANT_OFFER_MAX_VALID_FOR_DAYS),
  reason: z.string().trim().min(1).max(500),
}).strict().superRefine((value, context) => {
  if (CONTROL_PATTERN.test(value.reason)) context.addIssue({ code: "custom", path: ["reason"], message: "reason contains control characters" });
});

const lifecycleInputSchema = z.object({
  action: z.enum(["activate", "retire"]),
  expectedUpdatedAt: z.string().datetime({ offset: true }).transform((value) => new Date(value)),
  reason: z.string().trim().min(1).max(500),
}).strict().superRefine((value, context) => {
  if (CONTROL_PATTERN.test(value.reason)) context.addIssue({ code: "custom", path: ["reason"], message: "reason contains control characters" });
});

type PolicyInput = z.infer<typeof policyInputSchema>;
type LifecycleInput = z.infer<typeof lifecycleInputSchema>;

function parsePolicyInput(input: unknown): PolicyInput {
  try {
    return policyInputSchema.parse(input);
  } catch {
    return fail("PLATFORM_GRANT_OFFER_POLICY_INVALID_INPUT");
  }
}

export function parsePlatformGrantOfferPolicyInput(input: unknown): PolicyInput {
  return parsePolicyInput(input);
}

function parseLifecycleInput(input: unknown): LifecycleInput {
  try {
    return lifecycleInputSchema.parse(input);
  } catch {
    return fail("PLATFORM_GRANT_OFFER_POLICY_INVALID_INPUT");
  }
}

export function parsePlatformGrantOfferPolicyLifecycleInput(input: unknown): LifecycleInput {
  return parseLifecycleInput(input);
}

async function withSerializableRetry<T>(db: PrismaClient, callback: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < POLICY_RETRY_LIMIT; attempt += 1) {
    try {
      return await db.$transaction(callback, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (!isSerializationConflict(error) || attempt + 1 >= POLICY_RETRY_LIMIT) throw error;
    }
  }
  throw new Error("PLATFORM_GRANT_OFFER_POLICY_RETRY_EXHAUSTED");
}

async function policyTransaction<T>(db: PlatformGrantOfferPolicyDb, callback: (tx: PlatformGrantOfferPolicyDb) => Promise<T>): Promise<T> {
  if (isPrismaClient(db)) return withSerializableRetry(db, (tx) => callback(tx));
  return callback(db);
}

async function createPolicyWithAudit(
  db: PlatformGrantOfferPolicyDb,
  actorId: string,
  input: Readonly<{ offerVersion: string; amount: number; validForDays: number; reason: string; status: "draft" | "active" }>,
  now: Date,
): Promise<PolicyRow> {
  const transactionId = randomUUID();
  await setPolicyContext(db, transactionId);
  const policy = await db.platformGrantOfferPolicy.create({
    data: {
      id: randomUUID(),
      offerVersion: input.offerVersion,
      status: input.status,
      amount: input.amount,
      validForDays: input.validForDays,
      eligibilityKey: PLATFORM_GRANT_OFFER_ELIGIBILITY_KEY,
      createdById: actorId,
      updatedById: actorId,
      activatedById: input.status === "active" ? actorId : null,
      activatedAt: input.status === "active" ? now : null,
      retiredById: null,
      retiredAt: null,
      createdAt: now,
      updatedAt: now,
    },
    select: policySelect,
  });
  await db.platformGrantOfferPolicyAudit.create({
    data: {
      id: randomUUID(),
      policyId: policy.id,
      action: "created",
      statusBefore: null,
      statusAfter: input.status,
      offerVersion: input.offerVersion,
      amount: input.amount,
      validForDays: input.validForDays,
      eligibilityKey: PLATFORM_GRANT_OFFER_ELIGIBILITY_KEY,
      reasonRecorded: true,
      reason: input.reason,
      actorId,
      transactionId,
      createdAt: now,
    },
  });
  return db.platformGrantOfferPolicy.findUniqueOrThrow({ where: { id: policy.id }, select: policySelect });
}

export async function assertPlatformGrantOfferPolicyAdmin(actor: unknown, db: PlatformGrantOfferPolicyDb = getDb()): Promise<PlatformGrantOfferPolicyActor> {
  const hint = canonicalActorHint(actor);
  return assertCurrentAdmin(hint, db);
}

export async function listPlatformGrantOfferPolicies(actor: PlatformGrantOfferPolicyActor, db: PrismaClient = getDb()): Promise<readonly PlatformGrantOfferPolicyPublic[]> {
  const hint = canonicalActorHint(actor);
  await assertCurrentAdmin(hint, db);
  const rows = await db.platformGrantOfferPolicy.findMany({ orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: policySelect });
  return Object.freeze(rows.map(publicPolicy));
}

export async function getPlatformGrantOfferPolicy(policyId: string, actor: PlatformGrantOfferPolicyActor, db: PrismaClient = getDb()): Promise<PlatformGrantOfferPolicyPublic> {
  if (!z.string().uuid().safeParse(policyId).success) return fail("PLATFORM_GRANT_OFFER_POLICY_NOT_FOUND");
  const hint = canonicalActorHint(actor);
  await assertCurrentAdmin(hint, db);
  const row = await db.platformGrantOfferPolicy.findUnique({ where: { id: policyId }, select: policySelect });
  if (row === null) return fail("PLATFORM_GRANT_OFFER_POLICY_NOT_FOUND");
  return publicPolicy(row);
}

export async function createPlatformGrantOfferPolicy(input: unknown, actor: PlatformGrantOfferPolicyActor, db: PrismaClient = getDb()): Promise<PlatformGrantOfferPolicyPublic> {
  const parsed = parsePolicyInput(input);
  const hint = canonicalActorHint(actor);
  try {
    return await policyTransaction(db, async (tx) => {
      await lockActor(tx, hint.id);
      await lockPolicyDomain(tx);
      const current = await assertCurrentAdmin(hint, tx);
      const policy = await createPolicyWithAudit(tx, current.id, { ...parsed, status: "draft" }, new Date());
      return publicPolicy(policy);
    });
  } catch (error) {
    if (isKnown(error, "P2002")) return fail("PLATFORM_GRANT_OFFER_POLICY_CONFLICT");
    throw error;
  }
}

export async function changePlatformGrantOfferPolicyLifecycle(
  policyId: string,
  input: unknown,
  actor: PlatformGrantOfferPolicyActor,
  db: PrismaClient = getDb(),
): Promise<PlatformGrantOfferPolicyPublic> {
  if (!z.string().uuid().safeParse(policyId).success) return fail("PLATFORM_GRANT_OFFER_POLICY_NOT_FOUND");
  const parsed = parseLifecycleInput(input);
  const hint = canonicalActorHint(actor);
  try {
    return await policyTransaction(db, async (tx) => {
      await lockActor(tx, hint.id);
      await lockPolicyDomain(tx);
      const current = await assertCurrentAdmin(hint, tx);
      const existing = await tx.platformGrantOfferPolicy.findUnique({ where: { id: policyId }, select: policySelect });
      if (existing === null) return fail("PLATFORM_GRANT_OFFER_POLICY_NOT_FOUND");
      if (existing.updatedAt.getTime() !== parsed.expectedUpdatedAt.getTime()) return fail("PLATFORM_GRANT_OFFER_POLICY_STALE");
      if (parsed.action === "activate" && existing.status !== "draft") return fail("PLATFORM_GRANT_OFFER_POLICY_INVALID_TRANSITION");
      if (parsed.action === "retire" && existing.status !== "active") return fail("PLATFORM_GRANT_OFFER_POLICY_INVALID_TRANSITION");

      const transactionId = randomUUID();
      await setPolicyContext(tx, transactionId);
      if (parsed.action === "activate") {
      const active = await tx.platformGrantOfferPolicy.findFirst({ where: { status: "active" }, select: policySelect });
      if (active !== null) {
          const retiredAt = new Date();
          await tx.platformGrantOfferPolicy.update({
            where: { id: active.id },
            data: { status: "retired", retiredById: current.id, retiredAt, updatedById: current.id, updatedAt: retiredAt },
          });
          await tx.platformGrantOfferPolicyAudit.create({
            data: {
              id: randomUUID(), policyId: active.id, action: "retired", statusBefore: "active", statusAfter: "retired",
              offerVersion: active.offerVersion, amount: active.amount, validForDays: active.validForDays,
              eligibilityKey: active.eligibilityKey, reasonRecorded: true, reason: parsed.reason,
              actorId: current.id, transactionId, createdAt: retiredAt,
            },
          });
        }
        const activatedAt = new Date();
        await tx.platformGrantOfferPolicy.update({
          where: { id: existing.id },
          data: { status: "active", activatedById: current.id, activatedAt, updatedById: current.id, updatedAt: activatedAt },
        });
        await tx.platformGrantOfferPolicyAudit.create({
          data: {
            id: randomUUID(), policyId: existing.id, action: "activated", statusBefore: "draft", statusAfter: "active",
            offerVersion: existing.offerVersion, amount: existing.amount, validForDays: existing.validForDays,
            eligibilityKey: existing.eligibilityKey, reasonRecorded: true, reason: parsed.reason,
            actorId: current.id, transactionId, createdAt: activatedAt,
          },
        });
      } else {
        const retiredAt = new Date();
        await tx.platformGrantOfferPolicy.update({
          where: { id: existing.id },
          data: { status: "retired", retiredById: current.id, retiredAt, updatedById: current.id, updatedAt: retiredAt },
        });
        await tx.platformGrantOfferPolicyAudit.create({
          data: {
            id: randomUUID(), policyId: existing.id, action: "retired", statusBefore: "active", statusAfter: "retired",
            offerVersion: existing.offerVersion, amount: existing.amount, validForDays: existing.validForDays,
            eligibilityKey: existing.eligibilityKey, reasonRecorded: true, reason: parsed.reason,
            actorId: current.id, transactionId, createdAt: retiredAt,
          },
        });
      }
      const result = await tx.platformGrantOfferPolicy.findUniqueOrThrow({ where: { id: policyId }, select: policySelect });
      return publicPolicy(result);
    });
  } catch (error) {
    if (isKnown(error, "P2002") || isSerializationConflict(error)) return fail("PLATFORM_GRANT_OFFER_POLICY_CONFLICT");
    throw error;
  }
}

/**
 * Create the compatibility policy only during a genuinely fresh bootstrap.
 * Migrations intentionally never call this and initialized upgrades never
 * infer an actor or silently create an offer.
 */
export async function createBootstrapSignupOfferPolicy(
  db: Prisma.TransactionClient,
  actorId: string,
  now = new Date(),
): Promise<PlatformGrantOfferPolicyPublic> {
  await lockPolicyDomain(db);
  const existing = await db.platformGrantOfferPolicy.count();
  if (existing !== 0) return fail("PLATFORM_GRANT_OFFER_POLICY_BOOTSTRAP_CONFLICT");
  const policy = await createPolicyWithAudit(db, actorId, {
    offerVersion: PLATFORM_GRANT_OFFER_DEFAULT_VERSION,
    amount: PLATFORM_GRANT_OFFER_DEFAULT_AMOUNT,
    validForDays: PLATFORM_GRANT_OFFER_DEFAULT_VALID_FOR_DAYS,
    reason: "fresh_application_bootstrap",
    status: "active",
  }, now);
  return publicPolicy(policy);
}

/**
 * Called only by verified GitHub/OIDC identity creation paths.  It returns
 * null when an initialized upgrade has no active policy; the account flow is
 * still allowed to complete and no entitlement rows are written.
 */
export async function issueVerifiedSignupGrantFromActivePolicy(
  userId: string,
  eligibilitySource: SignupEligibilitySource,
  options: Readonly<{ issuedById?: string | null; now?: Date }> = {},
  db: PlatformGrantOfferPolicyDb = getDb(),
) {
  if (!z.string().uuid().safeParse(userId).success) return fail("PLATFORM_GRANT_OFFER_POLICY_INVALID_INPUT");
  if (!SIGNUP_ELIGIBILITY_SOURCES.includes(eligibilitySource)) return fail("PLATFORM_GRANT_OFFER_POLICY_INVALID_INPUT");
  const now = options.now ?? new Date();
  const run = async (tx: PlatformGrantOfferPolicyDb) => {
    const existing = await tx.platformTokenGrant.findUnique({ where: { userId_kind: { userId, kind: "signup" } } });
    if (existing !== null) return existing;
    await lockActor(tx, userId);
    await lockPolicyDomain(tx);
    const rechecked = await tx.platformTokenGrant.findUnique({ where: { userId_kind: { userId, kind: "signup" } } });
    if (rechecked !== null) return rechecked;
    const policy = await tx.platformGrantOfferPolicy.findFirst({
      where: { status: "active" },
      orderBy: [{ activatedAt: "desc" }, { id: "desc" }],
      select: { offerVersion: true, amount: true, validForDays: true, eligibilityKey: true },
    });
    if (policy === null) return null;
    if (policy.eligibilityKey !== PLATFORM_GRANT_OFFER_ELIGIBILITY_KEY) return fail("PLATFORM_GRANT_OFFER_POLICY_CONFLICT");
    const grantId = randomUUID();
    const inserted = await tx.platformTokenGrant.createMany({
      data: {
        id: grantId,
        userId,
        kind: "signup",
        amount: policy.amount,
        remainingTokens: policy.amount,
        offerVersion: policy.offerVersion,
        offerAmount: policy.amount,
        offerValidForDays: policy.validForDays,
        eligibilityKey: policy.eligibilityKey,
        eligibilitySource,
        issuedById: options.issuedById ?? null,
        issuedAt: now,
        expiresAt: new Date(now.getTime() + policy.validForDays * 86_400_000),
      },
      skipDuplicates: true,
    });
    if (inserted.count === 1) {
      await tx.platformTokenLedgerEntry.create({
        data: {
          id: randomUUID(),
          userId,
          grantId,
          entryKind: "grant",
          amount: policy.amount,
          reasonCode: "AI_SIGNUP_GRANT",
          callKey: null,
          idempotencyKey: `grant:signup:${userId}`,
          metadata: { offerVersion: policy.offerVersion, eligibilityKey: policy.eligibilityKey, eligibilitySource },
          createdAt: now,
        },
      });
    }
    return tx.platformTokenGrant.findUniqueOrThrow({ where: { userId_kind: { userId, kind: "signup" } } });
  };
  return policyTransaction(db, run);
}
