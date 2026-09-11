import { createHash, createHmac, randomUUID } from "node:crypto";
import { Prisma, type AccountEntitlementBackfillItemClassification, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import {
  AccountAccessGuardError,
  assertAccountAccessForActor,
  requireAccountAccessVersion,
} from "@/lib/account-access-guard";
import { lockActorsAccess } from "@/lib/access-linearization";
import { type PlatformGrantOfferPolicyActor } from "@/lib/platform-grant-offer-policy-service";
import {
  activateAccountEntitlements,
  accountEntitlementPolicyFingerprint,
  AccountEntitlementActivationError,
} from "@/lib/account-entitlement-activation-service";
import { loadOrCreateMasterKey } from "@/lib/credential-vault";
import { assertEntitlementWriterSession, getEntitlementDb, isEntitlementDatabase } from "@/lib/db";
import { isSerializationConflict } from "@/lib/project-snapshot-errors";

export const ACCOUNT_ENTITLEMENT_BACKFILL_CONTEXT = "service-v1" as const;
export const ACCOUNT_ENTITLEMENT_BACKFILL_MAX_BODY_BYTES = 4 * 1_024;
export const ACCOUNT_ENTITLEMENT_BACKFILL_MAX_CANDIDATES = 10_000;
export const ACCOUNT_ENTITLEMENT_BACKFILL_TTL_MS = 15 * 60 * 1_000;

const BACKFILL_LOCK_ID = 781452905;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;

export type AccountEntitlementBackfillDb = PrismaClient | Prisma.TransactionClient;
export type AccountEntitlementBackfillActor = PlatformGrantOfferPolicyActor;
export type AccountEntitlementBackfillClock = () => Date;
export type AccountEntitlementBackfillNow = Date | AccountEntitlementBackfillClock;

export type AccountEntitlementBackfillErrorCode =
  | "ACCOUNT_ENTITLEMENT_BACKFILL_INVALID_INPUT"
  | "ACCOUNT_ENTITLEMENT_BACKFILL_ADMIN_REQUIRED"
  | "ACCOUNT_ENTITLEMENT_BACKFILL_NOT_FOUND"
  | "ACCOUNT_ENTITLEMENT_BACKFILL_EXPIRED"
  | "ACCOUNT_ENTITLEMENT_BACKFILL_STALE"
  | "ACCOUNT_ENTITLEMENT_BACKFILL_IDEMPOTENCY_CONFLICT"
  | "ACCOUNT_ENTITLEMENT_BACKFILL_EPOCH_STALE"
  | "ACCOUNT_ENTITLEMENT_BACKFILL_CONFLICT"
  | "ACCOUNT_ENTITLEMENT_BACKFILL_SERVICE_CONTEXT_REQUIRED";

export class AccountEntitlementBackfillError extends Error {
  constructor(readonly code: AccountEntitlementBackfillErrorCode) {
    super(code);
    this.name = "AccountEntitlementBackfillError";
  }
}

function fail(code: AccountEntitlementBackfillErrorCode): never {
  throw new AccountEntitlementBackfillError(code);
}

function normalizeBackfillClock(now: AccountEntitlementBackfillNow | undefined): AccountEntitlementBackfillClock {
  if (now === undefined) return () => new Date();
  if (now instanceof Date) {
    const timestamp = now.getTime();
    return () => new Date(timestamp);
  }
  return now;
}

function validUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function isPrismaClient(db: AccountEntitlementBackfillDb): db is PrismaClient {
  return typeof (db as unknown as { $transaction?: unknown }).$transaction === "function";
}

function isUniqueConflict(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) return error.code === "P2002";
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: unknown }).code === "P2002";
}

async function withUniqueConflictMapping<T>(callback: () => Promise<T>): Promise<T> {
  try {
    return await callback();
  } catch (error) {
    if (isUniqueConflict(error)) return fail("ACCOUNT_ENTITLEMENT_BACKFILL_IDEMPOTENCY_CONFLICT");
    throw error;
  }
}

async function withSerializableRetry<T>(db: PrismaClient, callback: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await db.$transaction(async (tx) => {
        if (isEntitlementDatabase(db)) await assertEntitlementWriterSession(tx);
        return callback(tx);
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (!isSerializationConflict(error) || attempt === 2) throw error;
    }
  }
  throw new Error("ACCOUNT_ENTITLEMENT_BACKFILL_RETRY_EXHAUSTED");
}

async function transaction<T>(db: AccountEntitlementBackfillDb, callback: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  if (isPrismaClient(db)) return withSerializableRetry(db, callback);
  return callback(db);
}

async function setBackfillContext(db: Prisma.TransactionClient, transactionId = randomUUID()): Promise<void> {
  await db.$executeRaw`SELECT set_config('app.account_entitlement_backfill_context', ${ACCOUNT_ENTITLEMENT_BACKFILL_CONTEXT}, true)`;
  await db.$executeRaw`SELECT set_config('app.account_entitlement_backfill_transaction_id', ${transactionId}, true)`;
}

async function lockBackfillDomain(db: Prisma.TransactionClient): Promise<void> {
  await db.$executeRaw`SELECT pg_advisory_xact_lock(${BACKFILL_LOCK_ID})`;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry) => entry instanceof Date ? entry.toISOString() : entry);
}

async function impactFingerprint(input: Readonly<{
  snapshotAt: Date;
  expiresAt: Date;
  policy: Readonly<{ id: string; offerVersion: string; amount: number; validForDays: number; eligibilityKey: string }> | null;
  items: readonly Readonly<{ userId: string; accountAccessVersion: number; classification: AccountEntitlementBackfillItemClassification }>[];
}>): Promise<string> {
  const key = await loadOrCreateMasterKey();
  return createHmac("sha256", key)
    .update("ai-project-os:account-entitlement-backfill:v1", "utf8")
    .update("\0", "utf8")
    .update(canonicalJson({
      snapshotAt: input.snapshotAt,
      expiresAt: input.expiresAt,
      policy: input.policy,
      items: input.items,
    }), "utf8")
    .digest("hex");
}

const executeInputSchema = z.object({
  runId: z.string().uuid(),
  impactFingerprint: z.string().regex(DIGEST_PATTERN),
  confirmation: z.literal(true),
  requestKey: z.string().uuid(),
  reason: z.string().trim().min(1).max(500),
}).strict().superRefine((value, context) => {
  if (CONTROL_PATTERN.test(value.reason)) context.addIssue({ code: "custom", path: ["reason"], message: "reason contains control characters" });
});

export type AccountEntitlementBackfillExecuteInput = Readonly<{
  runId: string;
  impactFingerprint: string;
  confirmation: true;
  requestKey: string;
  reason: string;
}>;

function parseExecuteInput(input: unknown): AccountEntitlementBackfillExecuteInput {
  const parsed = executeInputSchema.safeParse(input);
  if (!parsed.success) return fail("ACCOUNT_ENTITLEMENT_BACKFILL_INVALID_INPUT");
  return parsed.data;
}

export type AccountEntitlementBackfillPublic = Readonly<{
  runId: string;
  status: "previewed" | "executing" | "completed" | "stale" | "expired" | "failed";
  snapshotAt: Date;
  expiresAt: Date;
  candidateCount: number;
  alreadyIssuedCount: number;
  eligibleMissingCount: number;
  legacyAmbiguousCount: number;
  grantedCount: number;
  skippedCount: number;
  impactFingerprint: string;
}>;

type BackfillRunRow = Prisma.AccountEntitlementBackfillRunGetPayload<{
  include: { items: true };
}>;

function publicRun(run: Pick<BackfillRunRow, "id" | "status" | "snapshotAt" | "expiresAt" | "candidateCount" | "alreadyIssuedCount" | "eligibleMissingCount" | "legacyAmbiguousCount" | "grantedCount" | "skippedCount" | "impactFingerprint">): AccountEntitlementBackfillPublic {
  return Object.freeze({
    runId: run.id,
    status: run.status,
    snapshotAt: run.snapshotAt,
    expiresAt: run.expiresAt,
    candidateCount: run.candidateCount,
    alreadyIssuedCount: run.alreadyIssuedCount,
    eligibleMissingCount: run.eligibleMissingCount,
    legacyAmbiguousCount: run.legacyAmbiguousCount,
    grantedCount: run.grantedCount,
    skippedCount: run.skippedCount,
    impactFingerprint: run.impactFingerprint,
  });
}

function nextTransitionAt(now: Date, previous: Date): Date {
  return new Date(Math.max(now.getTime(), previous.getTime() + 1));
}

async function loadCurrentAdmin(db: Prisma.TransactionClient, actor: AccountEntitlementBackfillActor): Promise<{ id: string; accountAccessVersion: number }> {
  if (!validUuid(actor.id) || actor.role !== "admin") return fail("ACCOUNT_ENTITLEMENT_BACKFILL_ADMIN_REQUIRED");
  let expectedVersion: number;
  try {
    expectedVersion = requireAccountAccessVersion(actor);
  } catch {
    return fail("ACCOUNT_ENTITLEMENT_BACKFILL_EPOCH_STALE");
  }
  const current = await db.appUser.findUnique({
    where: { id: actor.id },
    select: { id: true, role: true, disabledAt: true, accountAccessVersion: true },
  });
  if (current === null || current.role !== "admin" || current.disabledAt !== null) return fail("ACCOUNT_ENTITLEMENT_BACKFILL_ADMIN_REQUIRED");
  try {
    await assertAccountAccessForActor(db, { id: current.id, accountAccessVersion: expectedVersion });
  } catch (error) {
    if (error instanceof AccountAccessGuardError && error.code === "ACCOUNT_ACCESS_STALE") {
      return fail("ACCOUNT_ENTITLEMENT_BACKFILL_EPOCH_STALE");
    }
    return fail("ACCOUNT_ENTITLEMENT_BACKFILL_ADMIN_REQUIRED");
  }
  return { id: current.id, accountAccessVersion: expectedVersion };
}

function normalizeBackfillActor(actor: AccountEntitlementBackfillActor): AccountEntitlementBackfillActor {
  if (typeof actor !== "object" || actor === null) return fail("ACCOUNT_ENTITLEMENT_BACKFILL_ADMIN_REQUIRED");
  const value = actor as { id?: unknown; role?: unknown; accountAccessVersion?: unknown };
  if (!validUuid(value.id) || value.role !== "admin") return fail("ACCOUNT_ENTITLEMENT_BACKFILL_ADMIN_REQUIRED");
  try {
    return Object.freeze({
      id: value.id,
      role: "admin",
      accountAccessVersion: requireAccountAccessVersion(value),
    });
  } catch {
    return fail("ACCOUNT_ENTITLEMENT_BACKFILL_EPOCH_STALE");
  }
}

async function previewInTransaction(
  db: Prisma.TransactionClient,
  actor: AccountEntitlementBackfillActor,
  now: Date,
): Promise<AccountEntitlementBackfillPublic> {
  await lockActorsAccess(db, [actor.id]);
  await lockBackfillDomain(db);
  const current = await loadCurrentAdmin(db, actor);
  const users = await db.appUser.findMany({
    orderBy: { id: "asc" },
    take: ACCOUNT_ENTITLEMENT_BACKFILL_MAX_CANDIDATES + 1,
    select: { id: true, accountAccessVersion: true },
  });
  if (users.length > ACCOUNT_ENTITLEMENT_BACKFILL_MAX_CANDIDATES) return fail("ACCOUNT_ENTITLEMENT_BACKFILL_CONFLICT");
  const userIds = users.map((user) => user.id);
  const [activations, grants, activePolicy] = await Promise.all([
    userIds.length === 0 ? [] : db.accountEntitlementActivation.findMany({ where: { userId: { in: userIds } }, select: { id: true, userId: true, decision: true, status: true } }),
    userIds.length === 0 ? [] : db.platformTokenGrant.findMany({ where: { userId: { in: userIds }, kind: "signup" }, select: { id: true, userId: true } }),
    db.platformGrantOfferPolicy.findFirst({ where: { status: "active" }, orderBy: [{ activatedAt: "desc" }, { id: "desc" }], select: { id: true, offerVersion: true, amount: true, validForDays: true, eligibilityKey: true } }),
  ]);
  const activationByUser = new Map(activations.map((row) => [row.userId, row]));
  const issuedUsers = new Set([
    ...activations.filter((row) => row.decision === "granted" || row.decision === "already_issued").map((row) => row.userId),
    ...grants.map((row) => row.userId),
  ]);
  const eligibleMissingUsers = new Set(activations.filter((row) => row.decision === "no_active_offer" && !issuedUsers.has(row.userId)).map((row) => row.userId));
  const grantByUser = new Map(grants.map((row) => [row.userId, row.id]));
  const items = users.map((user) => {
    const classification = issuedUsers.has(user.id)
      ? "already_issued" as const
      : eligibleMissingUsers.has(user.id)
        ? "eligible_missing" as const
        : "legacy_ambiguous" as const;
    return {
      userId: user.id,
      accountAccessVersion: user.accountAccessVersion,
      classification,
      existingGrantId: grantByUser.get(user.id) ?? null,
      activationId: classification !== "legacy_ambiguous" ? activationByUser.get(user.id)?.id ?? null : null,
    };
  });
  const snapshotAt = now;
  const expiresAt = new Date(now.getTime() + ACCOUNT_ENTITLEMENT_BACKFILL_TTL_MS);
  const fingerprint = await impactFingerprint({ snapshotAt, expiresAt, policy: activePolicy, items });
  await setBackfillContext(db);
  const runId = randomUUID();
  const alreadyIssuedCount = items.filter((item) => item.classification === "already_issued").length;
  const eligibleMissingCount = items.filter((item) => item.classification === "eligible_missing").length;
  const legacyAmbiguousCount = items.length - alreadyIssuedCount - eligibleMissingCount;
  const run = await db.accountEntitlementBackfillRun.create({
    data: {
      id: runId,
      actorId: current.id,
      actorAccountAccessVersion: current.accountAccessVersion,
      status: "previewed",
      snapshotAt,
      expiresAt,
      candidateCount: items.length,
      alreadyIssuedCount,
      eligibleMissingCount,
      legacyAmbiguousCount,
      activePolicyId: activePolicy?.id ?? null,
      activePolicyRevision: activePolicy === null ? null : 1,
      activePolicyFingerprint: activePolicy === null ? null : accountEntitlementPolicyFingerprint(activePolicy),
      activeOfferVersion: activePolicy?.offerVersion ?? null,
      activeOfferAmount: activePolicy?.amount ?? null,
      activeOfferValidForDays: activePolicy?.validForDays ?? null,
      impactFingerprint: fingerprint,
      transitionAt: now,
      createdAt: now,
    },
  });
  if (items.length > 0) {
    await db.accountEntitlementBackfillItem.createMany({
      data: items.map((item) => ({
        id: randomUUID(),
        runId: run.id,
        userId: item.userId,
        accountAccessVersion: item.accountAccessVersion,
        classification: item.classification,
        status: "pending" as const,
        evidenceKind: item.classification === "already_issued" ? "existing-entitlement" : "unproven-history",
        evidenceRefDigest: digest(`account:${item.userId}`),
        existingGrantId: item.existingGrantId,
        resultGrantId: null,
        activationId: item.activationId,
        createdAt: now,
      })),
    });
  }
  await db.accountEntitlementBackfillAudit.create({
    data: {
      id: randomUUID(),
      runId: run.id,
      action: "previewed",
      statusBefore: null,
      statusAfter: "previewed",
      actorId: current.id,
      reasonRecorded: false,
      createdAt: now,
    },
  });
  return publicRun(run);
}

export async function previewAccountEntitlementBackfill(
  actor: AccountEntitlementBackfillActor,
  db: AccountEntitlementBackfillDb = getEntitlementDb(),
  now?: AccountEntitlementBackfillNow,
): Promise<AccountEntitlementBackfillPublic> {
  const normalizedActor = normalizeBackfillActor(actor);
  const clock = normalizeBackfillClock(now);
  return withUniqueConflictMapping(() => transaction(db, (tx) => previewInTransaction(tx, normalizedActor, clock())));
}

async function markRun(
  db: Prisma.TransactionClient,
  run: BackfillRunRow,
  actorId: string,
  status: BackfillRunRow["status"],
  action: "stale" | "expired" | "failed",
  now: Date,
): Promise<BackfillRunRow> {
  await setBackfillContext(db);
  const transitionAt = nextTransitionAt(now, run.transitionAt);
  const grantedCount = run.items.filter((item) => item.status === "applied" && item.classification === "eligible_missing").length;
  const skippedCount = run.items.filter((item) => item.status === "skipped").length;
  const updated = await db.accountEntitlementBackfillRun.update({
    where: { id: run.id },
    data: { status, grantedCount, skippedCount, transitionAt },
    include: { items: true },
  });
  await db.accountEntitlementBackfillAudit.create({
    data: {
      id: randomUUID(),
      runId: run.id,
      action,
      statusBefore: run.status,
      statusAfter: status,
      actorId,
      reasonRecorded: false,
      createdAt: transitionAt,
    },
  });
  return updated;
}

function isEpochStale(error: unknown): boolean {
  return error instanceof AccountEntitlementBackfillError
    && error.code === "ACCOUNT_ENTITLEMENT_BACKFILL_EPOCH_STALE";
}

async function markExecutingRunStaleAfterEpochDrift(
  db: Prisma.TransactionClient,
  actor: AccountEntitlementBackfillActor,
  input: AccountEntitlementBackfillExecuteInput,
  now: Date,
): Promise<AccountEntitlementBackfillPublic | null> {
  const run = await db.accountEntitlementBackfillRun.findUnique({ where: { id: input.runId }, include: { items: true } });
  if (
    run === null
    || run.actorId !== actor.id
    || run.requestKey !== input.requestKey
    || run.impactFingerprint !== input.impactFingerprint
    || run.reason !== input.reason
    || run.status !== "executing"
  ) return null;
  return publicRun(await markRun(db, run, actor.id, "stale", "stale", now));
}

type BackfillProcessResult = Readonly<{
  processed: boolean;
  terminal?: AccountEntitlementBackfillPublic;
}>;

type BackfillPolicySnapshot = Readonly<{ id: string; offerVersion: string; amount: number; validForDays: number; eligibilityKey: string }>;

async function readActivePolicy(db: Prisma.TransactionClient): Promise<BackfillPolicySnapshot | null> {
  return db.platformGrantOfferPolicy.findFirst({
    where: { status: "active" },
    orderBy: [{ activatedAt: "desc" }, { id: "desc" }],
    select: { id: true, offerVersion: true, amount: true, validForDays: true, eligibilityKey: true },
  });
}

async function mintHistoricalBackfillGrantInTransaction(
  db: Prisma.TransactionClient,
  context: Readonly<{
    run: BackfillRunRow;
    item: BackfillRunRow["items"][number];
    current: Readonly<{ id: string; accountAccessVersion: number }>;
    input: AccountEntitlementBackfillExecuteInput;
    policy: BackfillPolicySnapshot;
    now: Date;
  }>,
): Promise<Readonly<{ activationId: string; grantId: string }>> {
  const { run, item, current, input, policy, now } = context;
  if (run.status !== "executing" || run.requestKey !== input.requestKey || run.reason !== input.reason
    || run.actorId !== current.id || run.actorAccountAccessVersion !== current.accountAccessVersion
    || run.expiresAt <= now || run.confirmedAt === null || run.activePolicyFingerprint === null
    || run.activePolicyId !== policy.id || run.activeOfferVersion !== policy.offerVersion
    || run.activeOfferAmount !== policy.amount || run.activeOfferValidForDays !== policy.validForDays
    || accountEntitlementPolicyFingerprint(policy) !== run.activePolicyFingerprint) {
    throw new AccountEntitlementActivationError("ACCOUNT_ENTITLEMENT_ACTIVATION_CONFLICT");
  }
  if (item.runId !== run.id || item.status !== "pending" || item.classification !== "eligible_missing" || item.activationId === null) {
    throw new AccountEntitlementActivationError("ACCOUNT_ENTITLEMENT_ACTIVATION_CONFLICT");
  }
  await lockActorsAccess(db, [item.userId]);
  const [actor, user, activation, existingGrant] = await Promise.all([
    loadCurrentAdmin(db, { id: current.id, role: "admin", accountAccessVersion: current.accountAccessVersion }),
    db.appUser.findUnique({ where: { id: item.userId }, select: { id: true, disabledAt: true, accountAccessVersion: true } }),
    db.accountEntitlementActivation.findUnique({
      where: { id: item.activationId },
      select: { id: true, userId: true, decision: true, status: true, accountAccessVersion: true },
    }),
    db.platformTokenGrant.findFirst({ where: { userId: item.userId, kind: "signup" }, select: { id: true } }),
  ]);
  if (actor.id !== current.id || actor.accountAccessVersion !== current.accountAccessVersion) {
    throw new AccountEntitlementActivationError("ACCOUNT_ENTITLEMENT_ACTOR_INVALID");
  }
  if (user === null) throw new AccountEntitlementActivationError("ACCOUNT_ENTITLEMENT_ACCOUNT_NOT_FOUND");
  if (user.disabledAt !== null) throw new AccountEntitlementActivationError("ACCOUNT_ENTITLEMENT_ACCOUNT_DISABLED");
  if (user.accountAccessVersion !== item.accountAccessVersion) throw new AccountEntitlementActivationError("ACCOUNT_ENTITLEMENT_EPOCH_STALE");
  if (activation === null || activation.userId !== item.userId || activation.decision !== "no_active_offer"
    || activation.status !== "no_active_offer" || activation.accountAccessVersion !== item.accountAccessVersion) {
    throw new AccountEntitlementActivationError("ACCOUNT_ENTITLEMENT_ACTIVATION_CONFLICT");
  }
  if (existingGrant !== null) throw new AccountEntitlementActivationError("ACCOUNT_ENTITLEMENT_ACTIVATION_CONFLICT");

  const issuedAt = run.confirmedAt;
  const grantId = randomUUID();
  await db.platformTokenGrant.create({
    data: {
      id: grantId,
      userId: item.userId,
      kind: "signup",
      amount: policy.amount,
      remainingTokens: policy.amount,
      offerVersion: policy.offerVersion,
      offerAmount: policy.amount,
      offerValidForDays: policy.validForDays,
      eligibilityKey: policy.eligibilityKey,
      eligibilitySource: "historicalBackfill",
      issuedById: current.id,
      issuedAt,
      expiresAt: new Date(issuedAt.getTime() + policy.validForDays * 86_400_000),
      createdAt: issuedAt,
      updatedAt: issuedAt,
    },
  });
  await db.platformTokenLedgerEntry.create({
    data: {
      id: randomUUID(),
      userId: item.userId,
      grantId,
      entryKind: "grant",
      amount: policy.amount,
      reasonCode: "AI_SIGNUP_GRANT",
      callKey: null,
      idempotencyKey: `grant:signup:${item.userId}:${policy.offerVersion}`,
      metadata: { offerVersion: policy.offerVersion, eligibilityKey: policy.eligibilityKey, eligibilitySource: "historicalBackfill" },
      createdAt: issuedAt,
    },
  });
  return { activationId: activation.id, grantId };
}

async function claimBackfillInTransaction(
  db: Prisma.TransactionClient,
  actor: AccountEntitlementBackfillActor,
  input: AccountEntitlementBackfillExecuteInput,
  clock: AccountEntitlementBackfillClock,
): Promise<BackfillRunRow> {
  await lockActorsAccess(db, [actor.id]);
  await lockBackfillDomain(db);
  const now = clock();
  const current = await loadCurrentAdmin(db, actor);
  const run = await db.accountEntitlementBackfillRun.findUnique({ where: { id: input.runId }, include: { items: true } });
  const duplicateRequest = await db.accountEntitlementBackfillRun.findFirst({
    where: { actorId: current.id, requestKey: input.requestKey },
    select: { id: true },
  });
  if (duplicateRequest !== null && duplicateRequest.id !== input.runId) {
    return fail("ACCOUNT_ENTITLEMENT_BACKFILL_IDEMPOTENCY_CONFLICT");
  }
  if (run === null || run.actorId !== current.id) return fail("ACCOUNT_ENTITLEMENT_BACKFILL_NOT_FOUND");
  if (run.impactFingerprint !== input.impactFingerprint) return fail("ACCOUNT_ENTITLEMENT_BACKFILL_CONFLICT");
  if (run.requestKey !== null && run.requestKey !== input.requestKey) return fail("ACCOUNT_ENTITLEMENT_BACKFILL_IDEMPOTENCY_CONFLICT");
  if (run.status === "completed" && run.requestKey === input.requestKey) {
    if (run.reason !== input.reason) return fail("ACCOUNT_ENTITLEMENT_BACKFILL_IDEMPOTENCY_CONFLICT");
    return run;
  }
  if (run.status === "stale" || run.status === "failed") return fail("ACCOUNT_ENTITLEMENT_BACKFILL_STALE");
  if (run.status === "expired") return fail("ACCOUNT_ENTITLEMENT_BACKFILL_EXPIRED");
  if (run.status === "executing") {
    if (run.reason !== input.reason) return fail("ACCOUNT_ENTITLEMENT_BACKFILL_IDEMPOTENCY_CONFLICT");
    if (run.expiresAt <= now) return markRun(db, run, current.id, "expired", "expired", now);
    if (run.actorAccountAccessVersion !== current.accountAccessVersion) return markRun(db, run, current.id, "stale", "stale", now);
    const activePolicy = await readActivePolicy(db);
    const currentFingerprint = activePolicy === null ? null : accountEntitlementPolicyFingerprint(activePolicy);
    if (currentFingerprint !== run.activePolicyFingerprint) return markRun(db, run, current.id, "stale", "stale", now);
    if (run.eligibleMissingCount > 0 && run.activePolicyFingerprint === null) return markRun(db, run, current.id, "stale", "stale", now);
    return run;
  }
  if (run.status !== "previewed") return fail("ACCOUNT_ENTITLEMENT_BACKFILL_STALE");
  if (run.expiresAt <= now) return markRun(db, run, current.id, "expired", "expired", now);
  if (run.actorAccountAccessVersion !== current.accountAccessVersion) return markRun(db, run, current.id, "stale", "stale", now);
  const activePolicy = await readActivePolicy(db);
  const currentFingerprint = activePolicy === null ? null : accountEntitlementPolicyFingerprint(activePolicy);
  if (currentFingerprint !== run.activePolicyFingerprint) return markRun(db, run, current.id, "stale", "stale", now);
  if (run.eligibleMissingCount > 0 && run.activePolicyFingerprint === null) return markRun(db, run, current.id, "stale", "stale", now);
  const confirmationAt = nextTransitionAt(now, run.transitionAt);
  await setBackfillContext(db);
  const claimed = await db.accountEntitlementBackfillRun.updateMany({
    where: { id: run.id, status: "previewed", requestKey: null },
    data: { status: "executing", requestKey: input.requestKey, reason: input.reason, confirmedAt: confirmationAt, consumedAt: confirmationAt, transitionAt: confirmationAt },
  });
  if (claimed.count !== 1) return fail("ACCOUNT_ENTITLEMENT_BACKFILL_CONFLICT");
  await db.accountEntitlementBackfillAudit.create({
    data: {
      id: randomUUID(),
      runId: run.id,
      action: "confirmed",
      statusBefore: "previewed",
      statusAfter: "executing",
      actorId: current.id,
      reasonRecorded: true,
      createdAt: confirmationAt,
    },
  });
  return db.accountEntitlementBackfillRun.findUniqueOrThrow({ where: { id: run.id }, include: { items: true } });
}

async function processBackfillItemInTransaction(
  db: Prisma.TransactionClient,
  actor: AccountEntitlementBackfillActor,
  input: AccountEntitlementBackfillExecuteInput,
  clock: AccountEntitlementBackfillClock,
): Promise<BackfillProcessResult> {
  await lockActorsAccess(db, [actor.id]);
  await lockBackfillDomain(db);
  const now = clock();
  let current: { id: string; accountAccessVersion: number };
  try {
    current = await loadCurrentAdmin(db, actor);
  } catch (error) {
    if (isEpochStale(error)) {
      const terminal = await markExecutingRunStaleAfterEpochDrift(db, actor, input, now);
      if (terminal !== null) return { processed: false, terminal };
    }
    throw error;
  }
  const run = await db.accountEntitlementBackfillRun.findUnique({ where: { id: input.runId }, include: { items: true } });
  if (run === null || run.actorId !== current.id) return fail("ACCOUNT_ENTITLEMENT_BACKFILL_NOT_FOUND");
  if (run.impactFingerprint !== input.impactFingerprint) return fail("ACCOUNT_ENTITLEMENT_BACKFILL_CONFLICT");
  if (run.requestKey !== input.requestKey) return fail("ACCOUNT_ENTITLEMENT_BACKFILL_IDEMPOTENCY_CONFLICT");
  if (run.status !== "executing") {
    return { processed: false, terminal: run.status === "completed" ? publicRun(run) : undefined };
  }
  if (run.expiresAt <= now) return { processed: false, terminal: publicRun(await markRun(db, run, current.id, "expired", "expired", now)) };
  if (run.actorAccountAccessVersion !== current.accountAccessVersion) return { processed: false, terminal: publicRun(await markRun(db, run, current.id, "stale", "stale", now)) };
  const activePolicy = await readActivePolicy(db);
  const currentFingerprint = activePolicy === null ? null : accountEntitlementPolicyFingerprint(activePolicy);
  if (currentFingerprint !== run.activePolicyFingerprint) return { processed: false, terminal: publicRun(await markRun(db, run, current.id, "stale", "stale", now)) };
  if (run.eligibleMissingCount > 0 && run.activePolicyFingerprint === null) return { processed: false, terminal: publicRun(await markRun(db, run, current.id, "stale", "stale", now)) };
  const item = [...run.items]
    .filter((candidate) => candidate.status === "pending")
    .sort((left, right) => left.userId.localeCompare(right.userId) || left.id.localeCompare(right.id))[0];
  if (item === undefined) return { processed: false };

  let nextStatus: "applied" | "skipped" = "skipped";
  let activationId: string | null = item.activationId;
  let resultGrantId: string | null = null;
  let skipCode: string | null = null;
  if (item.classification === "eligible_missing") {
    try {
      if (item.activationId === null || run.activePolicyFingerprint === null) throw new Error("ACCOUNT_ENTITLEMENT_ACTIVATION_CONFLICT");
      const grant = await mintHistoricalBackfillGrantInTransaction(db, {
        run,
        item,
        current,
        input,
        policy: activePolicy!,
        now,
      });
      activationId = grant.activationId;
      resultGrantId = grant.grantId;
      nextStatus = "applied";
    } catch (error) {
      if (!(error instanceof AccountEntitlementActivationError)) throw error;
      skipCode = error.code === "ACCOUNT_ENTITLEMENT_ACCOUNT_DISABLED" ? "ACCOUNT_DISABLED" : "ACCOUNT_STATE_CHANGED";
    }
  } else if (item.classification === "already_issued") {
    if (item.activationId !== null) {
      const activation = await db.accountEntitlementActivation.findUnique({ where: { id: item.activationId }, select: { grantId: true } });
      if (activation?.grantId !== null && activation?.grantId !== undefined) {
        resultGrantId = activation.grantId;
        nextStatus = "applied";
      } else {
        skipCode = "ACCOUNT_STATE_CHANGED";
      }
    } else {
      try {
        const activation = await activateAccountEntitlements({
          userId: item.userId,
          source: "historicalBackfill",
          actorId: current.id,
          accountAccessVersion: item.accountAccessVersion,
          actorAccountAccessVersion: current.accountAccessVersion,
          evidenceKind: "existing-entitlement",
          evidenceRefDigest: item.evidenceRefDigest,
          now,
        }, db);
        activationId = activation.id;
        resultGrantId = activation.grantId;
        if (resultGrantId === null) throw new Error("ACCOUNT_ENTITLEMENT_ACTIVATION_CONFLICT");
        nextStatus = "applied";
      } catch (error) {
        if (!(error instanceof AccountEntitlementActivationError)) throw error;
        skipCode = error.code === "ACCOUNT_ENTITLEMENT_ACCOUNT_DISABLED" ? "ACCOUNT_DISABLED" : "ACCOUNT_STATE_CHANGED";
      }
    }
  } else {
    skipCode = "LEGACY_AMBIGUOUS";
  }
  await setBackfillContext(db);
  await db.accountEntitlementBackfillItem.update({
    where: { id: item.id },
    data: { status: nextStatus, activationId, resultGrantId: nextStatus === "applied" ? resultGrantId : null, skipCode },
  });
  return { processed: true };
}

async function completeBackfillInTransaction(
  db: Prisma.TransactionClient,
  actor: AccountEntitlementBackfillActor,
  input: AccountEntitlementBackfillExecuteInput,
  clock: AccountEntitlementBackfillClock,
): Promise<AccountEntitlementBackfillPublic> {
  await lockActorsAccess(db, [actor.id]);
  await lockBackfillDomain(db);
  const now = clock();
  let current: { id: string; accountAccessVersion: number };
  try {
    current = await loadCurrentAdmin(db, actor);
  } catch (error) {
    if (isEpochStale(error)) {
      const terminal = await markExecutingRunStaleAfterEpochDrift(db, actor, input, now);
      if (terminal !== null) return terminal;
    }
    throw error;
  }
  const run = await db.accountEntitlementBackfillRun.findUnique({ where: { id: input.runId }, include: { items: true } });
  if (run === null || run.actorId !== current.id) return fail("ACCOUNT_ENTITLEMENT_BACKFILL_NOT_FOUND");
  if (run.impactFingerprint !== input.impactFingerprint) return fail("ACCOUNT_ENTITLEMENT_BACKFILL_CONFLICT");
  if (run.requestKey !== input.requestKey) return fail("ACCOUNT_ENTITLEMENT_BACKFILL_IDEMPOTENCY_CONFLICT");
  if (run.status === "completed") return publicRun(run);
  if (run.status !== "executing") return fail(run.status === "expired" ? "ACCOUNT_ENTITLEMENT_BACKFILL_EXPIRED" : "ACCOUNT_ENTITLEMENT_BACKFILL_STALE");
  if (run.expiresAt <= now) return publicRun(await markRun(db, run, current.id, "expired", "expired", now));
  if (run.actorAccountAccessVersion !== current.accountAccessVersion) return publicRun(await markRun(db, run, current.id, "stale", "stale", now));
  const pending = run.items.some((item) => item.status === "pending");
  if (pending) return fail("ACCOUNT_ENTITLEMENT_BACKFILL_CONFLICT");
  const activePolicy = await readActivePolicy(db);
  const currentFingerprint = activePolicy === null ? null : accountEntitlementPolicyFingerprint(activePolicy);
  if (currentFingerprint !== run.activePolicyFingerprint) return publicRun(await markRun(db, run, current.id, "stale", "stale", now));
  if (run.eligibleMissingCount > 0 && run.activePolicyFingerprint === null) return publicRun(await markRun(db, run, current.id, "stale", "stale", now));
  const grantedCount = run.items.filter((item) => item.status === "applied" && item.classification === "eligible_missing").length;
  const skippedCount = run.items.filter((item) => item.status === "skipped").length;
  const completionAt = nextTransitionAt(now, run.transitionAt);
  await setBackfillContext(db);
  const completed = await db.accountEntitlementBackfillRun.update({
    where: { id: run.id },
    data: { status: "completed", grantedCount, skippedCount, executedAt: completionAt, transitionAt: completionAt },
    include: { items: true },
  });
  await db.accountEntitlementBackfillAudit.create({
    data: {
      id: randomUUID(),
      runId: run.id,
      action: "executed",
      statusBefore: "executing",
      statusAfter: "completed",
      actorId: current.id,
      reasonRecorded: true,
      createdAt: completionAt,
    },
  });
  return publicRun(completed);
}

async function executeInSingleTransaction(
  db: Prisma.TransactionClient,
  actor: AccountEntitlementBackfillActor,
  input: AccountEntitlementBackfillExecuteInput,
  clock: AccountEntitlementBackfillClock,
): Promise<AccountEntitlementBackfillPublic> {
  const claimed = await claimBackfillInTransaction(db, actor, input, clock);
  if (claimed.status !== "executing") return publicRun(claimed);
  while (true) {
    const result = await processBackfillItemInTransaction(db, actor, input, clock);
    if (result.terminal !== undefined) return result.terminal;
    if (!result.processed) break;
  }
  return completeBackfillInTransaction(db, actor, input, clock);
}

export async function executeAccountEntitlementBackfill(
  input: unknown,
  actor: AccountEntitlementBackfillActor,
  db: AccountEntitlementBackfillDb = getEntitlementDb(),
  now?: AccountEntitlementBackfillNow,
): Promise<AccountEntitlementBackfillPublic> {
  const parsed = parseExecuteInput(input);
  const normalizedActor = normalizeBackfillActor(actor);
  const clock = normalizeBackfillClock(now);
  return withUniqueConflictMapping(async () => {
    if (!isPrismaClient(db)) return executeInSingleTransaction(db, normalizedActor, parsed, clock);
    const claimed = await transaction(db, (tx) => claimBackfillInTransaction(tx, normalizedActor, parsed, clock));
    if (claimed.status !== "executing") return publicRun(claimed);
    while (true) {
      const result = await transaction(db, (tx) => processBackfillItemInTransaction(tx, normalizedActor, parsed, clock));
      if (result.terminal !== undefined) return result.terminal;
      if (!result.processed) break;
    }
    return transaction(db, (tx) => completeBackfillInTransaction(tx, normalizedActor, parsed, clock));
  });
}
