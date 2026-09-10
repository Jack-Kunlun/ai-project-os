import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  AiEntitlementError,
  acquirePlatformTokenDispatchFence,
  assertActiveMembership,
  assertAiOutboundEntitlement,
  assertPlatformConcurrency,
  calculateChargedPlatformTokens,
  estimatePlatformTokens,
  holdPlatformTokenReservation,
  issueVerifiedSignupGrant,
  recoverExpiredPlatformTokenReservations,
  releasePlatformTokenReservation,
  reservePlatformTokens,
  settlePlatformTokenReservation,
  SIGNUP_OFFER_VERSION,
  SIGNUP_TOKEN_AMOUNT,
  SIGNUP_TOKEN_TTL_DAYS,
} from "../src/lib/ai-entitlements";
import { stableAiCallKey } from "../src/lib/web-ai-governance";
import { getProviderDefinition } from "../src/lib/ai-providers";

test("platform token estimates are conservative UTF-8 byte upper bounds", () => {
  const input = { text: "中文内容" };
  const estimate = estimatePlatformTokens(input, 128);
  const serializedBytes = Buffer.byteLength(JSON.stringify(input), "utf8");
  assert.ok(estimate >= serializedBytes + 64 + 128);
  assert.ok(estimate > 128);
});

test("platform quota charging is integer ceil arithmetic with bounded multipliers", () => {
  assert.equal(calculateChargedPlatformTokens(1, 10_001), 2);
  assert.equal(calculateChargedPlatformTokens(10_000, 12_500), 12_500);
  assert.equal(calculateChargedPlatformTokens(10_001, 12_500), 12_502);
  assert.throws(() => calculateChargedPlatformTokens(1, 0), entitlementError("AI_ROUTE_CONFIGURATION_FORBIDDEN"));
  assert.throws(() => calculateChargedPlatformTokens(1, 100_001), entitlementError("AI_ROUTE_CONFIGURATION_FORBIDDEN"));
});

test("web AI call keys are deterministic and job-scoped", () => {
  const first = stableAiCallKey("job-a", "embedding", "batch-0");
  assert.equal(first, stableAiCallKey("job-a", "embedding", "batch-0"));
  assert.notEqual(first, stableAiCallKey("job-b", "embedding", "batch-0"));
  assert.notEqual(first, stableAiCallKey("job-a", "embedding", "batch-1"));
  assert.match(first, /^ai:[0-9a-f]{64}$/u);
});

test("signup offer and GLM embedding defaults remain explicit", () => {
  assert.equal(SIGNUP_TOKEN_AMOUNT, 500_000);
  assert.equal(SIGNUP_TOKEN_TTL_DAYS, 30);
  assert.equal(SIGNUP_OFFER_VERSION, "signup-500k-v1");
  assert.deepEqual(getProviderDefinition("glm").embeddingModelSuggestions[0], { id: "embedding-3", dimensions: 1024 });
});

test("migration preserves project deletion while retaining billing history", () => {
  const migration = readFileSync("prisma/migrations/20260902010000_add_ai_entitlements_and_provider_scope/migration.sql", "utf8");
  assert.match(migration, /ALTER TABLE "ProviderCallAudit" ALTER COLUMN "jobId" DROP NOT NULL/u);
  assert.match(migration, /ProviderCallAudit_jobId_fkey" FOREIGN KEY \("jobId"\).*ON DELETE SET NULL/u);
  assert.doesNotMatch(migration, /PlatformTokenReservation_jobId_fkey/u);
  assert.match(migration, /ProviderCallAudit_reservationId_fkey" FOREIGN KEY \("reservationId"\).*PlatformTokenReservation/u);
  assert.match(migration, /ProviderCallAudit_jobId_callKey_key/u);
  assert.match(migration, /PlatformTokenLedgerEntry_idempotencyKey_key/u);
  const runtimeMigration = readFileSync("prisma/migrations/20260904070000_add_runtime_ai_grant_billing_fences/migration.sql", "utf8");
  assert.match(runtimeMigration, /PlatformTokenReservation_webAiGrantId_fkey[\s\S]*ON DELETE SET NULL/u);
  assert.match(runtimeMigration, /ProviderCallAudit_webAiGrantId_fkey[\s\S]*ON DELETE SET NULL/u);
  assert.match(runtimeMigration, /webAiGrantReferenceId/u);
  assert.match(runtimeMigration, /credentialSecretFingerprint/u);
  assert.match(runtimeMigration, /runtime_ai_evidence_consistency_guard/u);
  assert.match(runtimeMigration, /runtime_ai_evidence_identity_guard/u);
  assert.match(runtimeMigration, /rawEstimatedTokens" = "reservedTokens"[\s\S]*OR \(/u);
  assert.match(runtimeMigration, /PlatformDefaultAiRoute_quota_multiplier_guard/u);
  assert.match(runtimeMigration, /OLD\."quotaMultiplierBps" IS DISTINCT FROM NEW\."quotaMultiplierBps"/u);
  assert.match(runtimeMigration, /PlatformTokenLedgerEntry_usage_tokens_guard/u);
  assert.match(runtimeMigration, /OLD\."usageTokens" IS DISTINCT FROM NEW\."usageTokens"/u);
});

type FakeGrant = {
  id: string;
  userId: string;
  kind: "signup" | "manual";
  amount: number;
  remainingTokens: number;
  offerVersion: string;
  issuedById: string | null;
  issuedAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type FakeReservation = {
  id: string;
  userId: string;
  grantId: string;
  jobId: string | null;
  providerConnectionId: string | null;
  webAiGrantId?: string | null;
  callKey: string;
  operation: string;
  modelId: string;
  status: "reserved" | "settled" | "released" | "held";
  reservedTokens: number;
  settledTokens: number | null;
  reconciliationRequired: boolean;
  safeErrorCode: string | null;
  expiresAt: Date;
  createdAt: Date;
  settledAt: Date | null;
  releasedAt: Date | null;
  rawEstimatedTokens?: number;
  rawSettledTokens?: number | null;
  quotaMultiplierBps?: number;
  routeSource?: string | null;
  routeId?: string | null;
  routeVersion?: number | null;
  routeUpdatedAt?: Date | null;
  providerConfigurationVersion?: number | null;
  routeFenceFingerprint?: string | null;
};

class FakeEntitlementDb {
  readonly grants = new Map<string, FakeGrant>();
  readonly reservations = new Map<string, FakeReservation>();
  readonly ledgerEntries = new Map<string, Record<string, unknown>>();
  readonly subscriptions = new Map<string, { status: "active" | "revoked"; startsAt: Date; expiresAt: Date; version: number }>();
  readonly users = new Map<string, { id: string; role: "admin" | "user" }>();
  readonly workspaceMembers = new Map<string, "owner" | "admin" | "member" | "viewer">();
  readonly jobs: Array<{ requestedById: string; status: string; reconciliationRequired?: boolean }> = [];
  readonly providerAudits = new Set<string>();
  readonly dispatchedJobs = new Set<string>();
  readonly projectWorkspaceId = randomUUID();
  transactions = 0;

  readonly platformTokenGrant = {
    findUnique: async ({ where }: { where: { userId_kind?: { userId: string; kind: FakeGrant["kind"] }; id?: string } }) => {
      if (where.id !== undefined) return [...this.grants.values()].find((grant) => grant.id === where.id) ?? null;
      const compound = where.userId_kind!;
      return [...this.grants.values()].find((grant) => grant.userId === compound.userId && grant.kind === compound.kind) ?? null;
    },
    findUniqueOrThrow: async ({ where }: { where: { userId_kind: { userId: string; kind: FakeGrant["kind"] } } }) => {
      const grant = [...this.grants.values()].find((candidate) => candidate.userId === where.userId_kind.userId && candidate.kind === where.userId_kind.kind);
      if (grant === undefined) throw new Error("FAKE_GRANT_NOT_FOUND");
      return grant;
    },
    createMany: async ({ data, skipDuplicates }: { data: FakeGrant | FakeGrant[]; skipDuplicates?: boolean }) => {
      const rows = Array.isArray(data) ? data : [data];
      let count = 0;
      for (const row of rows) {
        const duplicate = [...this.grants.values()].some((grant) => grant.userId === row.userId && grant.kind === row.kind);
        if (duplicate && skipDuplicates) continue;
        if (duplicate) throw new Error("FAKE_GRANT_UNIQUE");
        this.grants.set(row.id, { ...row });
        count += 1;
      }
      return { count };
    },
    findMany: async ({ where }: { where: { userId: string; revokedAt: null; expiresAt: { gt: Date }; remainingTokens: { gt: number } } }) => [...this.grants.values()]
      .filter((grant) => grant.userId === where.userId && grant.revokedAt === null && grant.expiresAt > where.expiresAt.gt && grant.remainingTokens > where.remainingTokens.gt)
      .sort((left, right) => left.expiresAt.getTime() - right.expiresAt.getTime()),
    count: async ({ where }: { where: { userId: string; revokedAt?: null; expiresAt?: { gt?: Date; lte?: Date } } }) => [...this.grants.values()].filter((grant) => grant.userId === where.userId && (where.revokedAt === undefined || grant.revokedAt === where.revokedAt) && (where.expiresAt?.gt === undefined || grant.expiresAt > where.expiresAt.gt) && (where.expiresAt?.lte === undefined || grant.expiresAt <= where.expiresAt.lte)).length,
    updateMany: async ({ where, data }: { where: { id: string; remainingTokens: { gte: number }; revokedAt: null; expiresAt: { gt: Date } }; data: { remainingTokens: { decrement: number } } }) => {
      const grant = this.grants.get(where.id);
      if (grant === undefined || grant.remainingTokens < where.remainingTokens.gte || grant.revokedAt !== null || grant.expiresAt <= where.expiresAt.gt) return { count: 0 };
      grant.remainingTokens -= data.remainingTokens.decrement;
      return { count: 1 };
    },
    update: async ({ where, data }: { where: { id: string }; data: { remainingTokens: { increment: number } } }) => {
      const grant = this.grants.get(where.id);
      if (grant === undefined) throw new Error("FAKE_GRANT_NOT_FOUND");
      grant.remainingTokens += data.remainingTokens.increment;
      return grant;
    },
  };

  readonly platformGrantOfferPolicy = {
    findFirst: async () => ({
      offerVersion: SIGNUP_OFFER_VERSION,
      amount: SIGNUP_TOKEN_AMOUNT,
      validForDays: SIGNUP_TOKEN_TTL_DAYS,
      eligibilityKey: "verified_identity_v1",
    }),
  };

  readonly platformTokenReservation = {
    findUnique: async ({ where, include }: { where: { userId_callKey: { userId: string; callKey: string } }; include?: { grant: unknown } }) => {
      const reservation = [...this.reservations.values()].find((candidate) => candidate.userId === where.userId_callKey.userId && candidate.callKey === where.userId_callKey.callKey);
      if (reservation === undefined) return null;
      if (include?.grant !== undefined) return { ...reservation, grant: { id: reservation.grantId, remainingTokens: this.grants.get(reservation.grantId)?.remainingTokens ?? 0 } };
      return reservation;
    },
    create: async ({ data }: { data: Omit<FakeReservation, "id" | "status" | "settledTokens" | "reconciliationRequired" | "safeErrorCode" | "settledAt" | "releasedAt"> & { ledgerEntries?: { create: Record<string, unknown> } } }) => {
      const reservation: FakeReservation = {
        ...data,
        id: randomUUID(),
        status: "reserved",
        settledTokens: null,
        reconciliationRequired: false,
        safeErrorCode: null,
        settledAt: null,
        releasedAt: null,
      } as FakeReservation;
      this.reservations.set(reservation.id, reservation);
      if (data.ledgerEntries?.create !== undefined) this.ledgerEntries.set(String(data.ledgerEntries.create.id), { ...data.ledgerEntries.create });
      return reservation;
    },
    update: async ({ where, data }: { where: { id: string }; data: Partial<FakeReservation> }) => {
      const reservation = this.reservations.get(where.id);
      if (reservation === undefined) throw new Error("FAKE_RESERVATION_NOT_FOUND");
      Object.assign(reservation, data);
      return reservation;
    },
    updateMany: async ({ where, data }: { where: { id: string; status: FakeReservation["status"] }; data: Partial<FakeReservation> }) => {
      const reservation = this.reservations.get(where.id);
      if (reservation === undefined || reservation.status !== where.status) return { count: 0 };
      Object.assign(reservation, data);
      return { count: 1 };
    },
    findMany: async ({ where }: { where: { userId: string; status?: { in: FakeReservation["status"][] } | FakeReservation["status"]; expiresAt?: { lte?: Date } } }) => [...this.reservations.values()]
      .filter((reservation) => reservation.userId === where.userId)
      .filter((reservation) => where.status === undefined || (typeof where.status === "string" ? reservation.status === where.status : where.status.in.includes(reservation.status)))
      .filter((reservation) => where.expiresAt?.lte === undefined || reservation.expiresAt <= where.expiresAt.lte)
      .map((reservation) => ({ ...reservation, providerCallAudit: this.providerAudits.has(reservation.id) ? { id: `audit-${reservation.id}` } : null })),
  };

  readonly platformTokenLedgerEntry = {
    createMany: async ({ data, skipDuplicates }: { data: Record<string, unknown> | Record<string, unknown>[]; skipDuplicates?: boolean }) => {
      const rows = Array.isArray(data) ? data : [data];
      let count = 0;
      for (const row of rows) {
        const idempotencyKey = String(row.idempotencyKey);
        const duplicate = [...this.ledgerEntries.values()].some((entry) => entry.idempotencyKey === idempotencyKey);
        if (duplicate && skipDuplicates) continue;
        if (duplicate) throw new Error("FAKE_LEDGER_UNIQUE");
        this.ledgerEntries.set(String(row.id), { ...row });
        count += 1;
      }
      return { count };
    },
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const idempotencyKey = String(data.idempotencyKey);
      if ([...this.ledgerEntries.values()].some((entry) => entry.idempotencyKey === idempotencyKey)) throw new Error("FAKE_LEDGER_UNIQUE");
      this.ledgerEntries.set(String(data.id), { ...data });
      return data;
    },
  };

  readonly membershipSubscription = {
    findUnique: async ({ where }: { where: { userId: string } }) => this.subscriptions.get(where.userId) ?? null,
  };

  readonly appUser = {
    findUnique: async ({ where }: { where: { id: string } }) => {
      const user = this.users.get(where.id);
      return user === undefined ? null : { ...user, disabledAt: null };
    },
  };

  readonly project = {
    findUnique: async () => ({ workspaceId: this.projectWorkspaceId }),
  };

  readonly workspaceMembership = {
    findMany: async ({ where }: { where: { workspaceId: string; userId: string } }) => {
      const role = this.workspaceMembers.get(`${where.workspaceId}:${where.userId}`);
      return role === undefined ? [] : [{ role, accessState: "confirmed" as const }];
    },
  };

  readonly backgroundJob = {
    count: async ({ where }: { where: { requestedById: string; OR: Array<{ status: { in: string[] } } | { status: string; reconciliationRequired: boolean }> } }) => this.jobs.filter((job) => {
      if (job.requestedById !== where.requestedById) return false;
      return where.OR.some((condition) => "reconciliationRequired" in condition
        ? job.status === condition.status && job.reconciliationRequired === condition.reconciliationRequired
        : condition.status.in.includes(job.status));
    }).length,
  };

  readonly backgroundJobAttempt = {
    findFirst: async ({ where }: { where: { jobId: string; dispatchState: { in: string[] } } }) => this.dispatchedJobs.has(where.jobId) ? { id: `attempt-${where.jobId}` } : null,
  };

  async $executeRaw(): Promise<number> { return 0; }

  async $transaction<T>(callback: (tx: this) => Promise<T>, options?: unknown): Promise<T> {
    void options;
    this.transactions += 1;
    return callback(this);
  }

  addGrant(userId: string, amount: number, expiresAt: Date, remainingTokens = amount): FakeGrant {
    const now = new Date("2026-09-02T00:00:00.000Z");
    const grant: FakeGrant = { id: randomUUID(), userId, kind: "manual", amount, remainingTokens, offerVersion: "test", issuedById: null, issuedAt: now, expiresAt, revokedAt: null, createdAt: now, updatedAt: now };
    this.grants.set(grant.id, grant);
    return grant;
  }
}

function entitlementError(code: string) {
  return (error: unknown) => error instanceof AiEntitlementError && error.code === code;
}

test("signup grant is idempotent and has one auditable ledger entry", async () => {
  const fake = new FakeEntitlementDb();
  const userId = randomUUID();
  const now = new Date("2026-09-02T00:00:00.000Z");
  const first = await issueVerifiedSignupGrant(userId, { eligibilitySource: "verifiedGithub", now }, fake as never);
  const second = await issueVerifiedSignupGrant(userId, { eligibilitySource: "verifiedGithub", now: new Date(now.getTime() + 1_000) }, fake as never);
  assert.ok(first);
  assert.ok(second);
  assert.equal(first.id, second.id);
  assert.equal(first.amount, SIGNUP_TOKEN_AMOUNT);
  assert.equal(first.remainingTokens, SIGNUP_TOKEN_AMOUNT);
  assert.equal(first.expiresAt.getTime(), now.getTime() + SIGNUP_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1_000);
  assert.equal(fake.grants.size, 1);
  assert.equal(fake.ledgerEntries.size, 1);
  assert.ok(fake.transactions >= 2);
});

test("reservation settles known usage, refunds the difference, and is idempotent", async () => {
  const fake = new FakeEntitlementDb();
  const userId = randomUUID();
  const grant = fake.addGrant(userId, 250, new Date("2026-10-01T00:00:00.000Z"));
  const callKey = stableAiCallKey("job-reserve", "autoExtract", "source");
  const reserved = await reservePlatformTokens({ userId, callKey, operation: "autoExtract", modelId: "deepseek-v4-flash", estimatedTokens: 100 }, fake as never);
  await assert.rejects(
    () => reservePlatformTokens({ userId, callKey, operation: "autoExtract", modelId: "deepseek-v4-flash", estimatedTokens: 1 }, fake as never),
    entitlementError("AI_ROUTE_CONFIGURATION_FORBIDDEN"),
  );
  const replay = await reservePlatformTokens({ userId, callKey, operation: "autoExtract", modelId: "deepseek-v4-flash", estimatedTokens: 100 }, fake as never);
  assert.equal(reserved.created, true);
  assert.equal(replay.created, false);
  assert.equal(fake.grants.get(grant.id)?.remainingTokens, 150);
  const settled = await settlePlatformTokenReservation({ userId, callKey, actualTokens: 40, usageKnown: true }, fake as never);
  assert.equal(settled.status, "settled");
  assert.equal(settled.settledTokens, 40);
  assert.equal(fake.grants.get(grant.id)?.remainingTokens, 210);
  const ledgerCount = fake.ledgerEntries.size;
  const replayedSettlement = await settlePlatformTokenReservation({ userId, callKey, actualTokens: 30, usageKnown: true }, fake as never);
  assert.equal(replayedSettlement.status, "settled");
  assert.equal(fake.ledgerEntries.size, ledgerCount);
});

test("reservation idempotency rejects raw, charged, and complete route snapshot drift", async () => {
  const fake = new FakeEntitlementDb();
  const userId = randomUUID();
  fake.addGrant(userId, 10_000, new Date("2026-10-01T00:00:00.000Z"));
  const callKey = stableAiCallKey("job-reservation-fence", "autoExtract", "source");
  const routeSnapshot = {
    source: "platform_default" as const,
    routeId: randomUUID(),
    routeVersion: 4,
    routeUpdatedAt: new Date("2026-09-02T00:00:00.000Z"),
    providerConfigurationVersion: 3,
    quotaMultiplierBps: 12_500,
    routeFenceFingerprint: "b".repeat(64),
  };
  const first = await reservePlatformTokens({
    userId,
    callKey,
    operation: "autoExtract",
    modelId: "deepseek-v4-flash",
    rawEstimatedTokens: 9,
    routeSnapshot,
  }, fake as never);
  assert.equal(first.reservedTokens, 12);

  await assert.rejects(
    () => reservePlatformTokens({
      userId,
      callKey,
      operation: "autoExtract",
      modelId: "deepseek-v4-flash",
      rawEstimatedTokens: 10,
      routeSnapshot,
    }, fake as never),
    entitlementError("AI_ROUTE_CONFIGURATION_FORBIDDEN"),
  );
  await assert.rejects(
    () => reservePlatformTokens({
      userId,
      callKey,
      operation: "autoExtract",
      modelId: "deepseek-v4-flash",
      rawEstimatedTokens: 9,
      routeSnapshot: { ...routeSnapshot, routeVersion: 5 },
    }, fake as never),
    entitlementError("AI_ROUTE_CONFIGURATION_FORBIDDEN"),
  );
  const replay = await reservePlatformTokens({
    userId,
    callKey,
    operation: "autoExtract",
    modelId: "deepseek-v4-flash",
    rawEstimatedTokens: 9,
    routeSnapshot,
  }, fake as never);
  assert.equal(replay.created, false);
  assert.equal(replay.reservedTokens, 12);
});

test("pre-dispatch release restores the reservation and unknown usage is held", async () => {
  const fake = new FakeEntitlementDb();
  const userId = randomUUID();
  const grant = fake.addGrant(userId, 300, new Date("2026-10-01T00:00:00.000Z"));
  const releasedKey = stableAiCallKey("job-release", "autoExtract", "source");
  await reservePlatformTokens({ userId, callKey: releasedKey, operation: "autoExtract", modelId: "deepseek-v4-flash", estimatedTokens: 80 }, fake as never);
  const released = await releasePlatformTokenReservation({ userId, callKey: releasedKey }, fake as never);
  assert.equal(released?.status, "released");
  assert.equal(fake.grants.get(grant.id)?.remainingTokens, 300);
  assert.equal((await releasePlatformTokenReservation({ userId, callKey: releasedKey }, fake as never))?.status, "released");

  const heldKey = stableAiCallKey("job-held", "autoExtract", "source");
  await reservePlatformTokens({ userId, callKey: heldKey, operation: "autoExtract", modelId: "deepseek-v4-flash", estimatedTokens: 90 }, fake as never);
  const held = await settlePlatformTokenReservation({ userId, callKey: heldKey, usageKnown: false }, fake as never);
  assert.equal(held.status, "held");
  assert.equal((await holdPlatformTokenReservation({ userId, callKey: heldKey }, fake as never))?.status, "held");
  assert.equal((await reservePlatformTokens({ userId, callKey: heldKey, operation: "autoExtract", modelId: "deepseek-v4-flash", estimatedTokens: 90 }, fake as never)).created, false);

  const overflowKey = stableAiCallKey("job-overflow", "autoExtract", "source");
  await reservePlatformTokens({ userId, callKey: overflowKey, operation: "autoExtract", modelId: "deepseek-v4-flash", estimatedTokens: 20 }, fake as never);
  assert.equal((await settlePlatformTokenReservation({ userId, callKey: overflowKey, actualTokens: 21, usageKnown: true }, fake as never)).status, "held");
});

test("expired reservations release only when no provider-touch evidence exists", async () => {
  const fake = new FakeEntitlementDb();
  const userId = randomUUID();
  const grant = fake.addGrant(userId, 500, new Date("2026-10-01T00:00:00.000Z"));
  const startedAt = new Date("2026-09-02T00:00:00.000Z");
  const releaseKey = stableAiCallKey("job-expired-release", "autoExtract", "source");
  await reservePlatformTokens({ userId, jobId: randomUUID(), callKey: releaseKey, operation: "autoExtract", modelId: "deepseek-v4-flash", estimatedTokens: 100, now: startedAt }, fake as never);
  const recovered = await recoverExpiredPlatformTokenReservations({ userId, now: new Date("2026-09-02T02:00:00.000Z") }, fake as never);
  assert.deepEqual(recovered, { inspected: 1, released: 1, held: 0 });
  assert.equal(fake.grants.get(grant.id)?.remainingTokens, 500);
  const ledgerCount = fake.ledgerEntries.size;
  const repeated = await recoverExpiredPlatformTokenReservations({ userId, now: new Date("2026-09-02T03:00:00.000Z") }, fake as never);
  assert.deepEqual(repeated, { inspected: 0, released: 0, held: 0 });
  assert.equal(fake.ledgerEntries.size, ledgerCount);

  const heldKey = stableAiCallKey("job-expired-held", "autoExtract", "source");
  const heldReservation = await reservePlatformTokens({ userId, jobId: "job-with-audit", callKey: heldKey, operation: "autoExtract", modelId: "deepseek-v4-flash", estimatedTokens: 80, now: startedAt }, fake as never);
  fake.providerAudits.add(heldReservation.reservationId);
  const heldRecovery = await recoverExpiredPlatformTokenReservations({ userId, now: new Date("2026-09-02T02:00:00.000Z") }, fake as never);
  assert.deepEqual(heldRecovery, { inspected: 1, released: 0, held: 1 });
  assert.equal(fake.grants.get(grant.id)?.remainingTokens, 420);
  assert.equal((await reservePlatformTokens({ userId, jobId: "job-with-audit", callKey: heldKey, operation: "autoExtract", modelId: "deepseek-v4-flash", estimatedTokens: 80, now: new Date("2026-09-02T03:00:00.000Z") }, fake as never)).status, "held");
});

test("dispatch fence serializes expired recovery before a provider call", async () => {
  const fake = new FakeEntitlementDb();
  const userId = randomUUID();
  const grant = fake.addGrant(userId, 500, new Date("2026-10-01T00:00:00.000Z"));
  const startedAt = new Date("2026-09-02T00:00:00.000Z");
  const preDispatchKey = stableAiCallKey("job-fence-pre", "autoExtract", "source");
  await reservePlatformTokens({ userId, jobId: "job-fence-pre", callKey: preDispatchKey, operation: "autoExtract", modelId: "deepseek-v4-flash", estimatedTokens: 100, now: startedAt }, fake as never);
  const preDispatchReservation = [...fake.reservations.values()].find((reservation) => reservation.callKey === preDispatchKey);
  assert.ok(preDispatchReservation);
  preDispatchReservation.expiresAt = new Date("2026-09-02T01:00:00.000Z");
  const releasedFence = await acquirePlatformTokenDispatchFence({ userId, callKey: preDispatchKey, now: new Date("2026-09-02T02:00:00.000Z") }, fake as never);
  assert.equal(releasedFence?.status, "released");
  assert.equal(releasedFence?.allowed, false);
  assert.equal(fake.grants.get(grant.id)?.remainingTokens, 500);

  const dispatchedKey = stableAiCallKey("job-fence-dispatched", "autoExtract", "source");
  await reservePlatformTokens({ userId, jobId: "job-fence-dispatched", callKey: dispatchedKey, operation: "autoExtract", modelId: "deepseek-v4-flash", estimatedTokens: 80, now: startedAt }, fake as never);
  const dispatchedReservation = [...fake.reservations.values()].find((reservation) => reservation.callKey === dispatchedKey);
  assert.ok(dispatchedReservation);
  dispatchedReservation.expiresAt = new Date("2026-09-02T01:00:00.000Z");
  fake.dispatchedJobs.add("job-fence-dispatched");
  const heldFence = await acquirePlatformTokenDispatchFence({ userId, callKey: dispatchedKey, now: new Date("2026-09-02T02:00:00.000Z") }, fake as never);
  assert.equal(heldFence?.status, "held");
  assert.equal(heldFence?.allowed, false);
  assert.equal(fake.grants.get(grant.id)?.remainingTokens, 420);
});

test("insufficient or expired grants fail before creating a reservation", async () => {
  const fake = new FakeEntitlementDb();
  const userId = randomUUID();
  fake.addGrant(userId, 20, new Date("2026-10-01T00:00:00.000Z"));
  await assert.rejects(
    () => reservePlatformTokens({ userId, callKey: stableAiCallKey("job-low", "autoExtract", "source"), operation: "autoExtract", modelId: "deepseek-v4-flash", estimatedTokens: 21 }, fake as never),
    entitlementError("AI_PLATFORM_TOKEN_EXHAUSTED"),
  );
  assert.equal(fake.reservations.size, 0);

  const expiredUserId = randomUUID();
  fake.addGrant(expiredUserId, 20, new Date("2026-08-01T00:00:00.000Z"));
  await assert.rejects(
    () => reservePlatformTokens({ userId: expiredUserId, callKey: stableAiCallKey("job-expired", "autoExtract", "source"), operation: "autoExtract", modelId: "deepseek-v4-flash", estimatedTokens: 1 }, fake as never),
    entitlementError("AI_PLATFORM_TOKEN_EXPIRED"),
  );
  assert.equal(fake.reservations.size, 0);
});

test("reconciled unknown jobs release the concurrency slot while open reconciliation still blocks", async () => {
  const fake = new FakeEntitlementDb();
  const userId = randomUUID();
  const user = { id: userId, role: "user" as const };

  fake.jobs.push({ requestedById: userId, status: "unknown", reconciliationRequired: false });
  await assertPlatformConcurrency(user, fake as never);

  fake.jobs.push({ requestedById: userId, status: "unknown", reconciliationRequired: true });
  await assert.rejects(
    () => assertPlatformConcurrency(user, fake as never),
    entitlementError("AI_PLATFORM_CONCURRENCY_LIMIT"),
  );
});

test("personal BYOK is unreachable while platform admins follow platform entitlement gates", async () => {
  const fake = new FakeEntitlementDb();
  const ownerId = randomUUID();
  const workspaceId = fake.projectWorkspaceId;
  const workspaceProjectId = randomUUID();
  fake.users.set(ownerId, { id: ownerId, role: "user" });
  fake.workspaceMembers.set(`${workspaceId}:${ownerId}`, "owner");
  fake.subscriptions.set(ownerId, { status: "active", startsAt: new Date("2026-08-01T00:00:00.000Z"), expiresAt: new Date("2026-10-01T00:00:00.000Z"), version: 1 });
  const providerConnectionId = randomUUID();
  const workspaceRoute = {
    projectId: workspaceProjectId, operation: "autoExtract", providerConnectionId, modelId: "custom-deepseek-model", embeddingDimensions: null, maxOutputTokens: 256,
    providerConnection: { id: providerConnectionId, kind: "deepseek", status: "verified", disabledAt: null, scope: "user", ownerUserId: ownerId, defaultGenerationModelId: "custom-deepseek-model", defaultEmbeddingModelId: null, defaultVisionModelId: null, embeddingDimensions: null },
  };
  await assert.rejects(
    () => assertAiOutboundEntitlement({ projectId: workspaceProjectId, requestedById: ownerId, route: workspaceRoute as never, db: fake as never, now: new Date("2026-09-02T00:00:00.000Z"), enforceConcurrency: false }),
    entitlementError("AI_PROVIDER_SCOPE_FORBIDDEN"),
  );
  fake.subscriptions.get(ownerId)!.expiresAt = new Date("2026-08-02T00:00:00.000Z");
  await assert.rejects(() => assertActiveMembership(ownerId, fake as never, new Date("2026-09-02T00:00:00.000Z")), entitlementError("AI_MEMBERSHIP_EXPIRED"));
  await assert.rejects(() => assertAiOutboundEntitlement({ projectId: workspaceProjectId, requestedById: ownerId, route: workspaceRoute as never, db: fake as never, now: new Date("2026-09-02T00:00:00.000Z"), enforceConcurrency: false }), entitlementError("AI_PROVIDER_SCOPE_FORBIDDEN"));

  const adminId = randomUUID();
  fake.users.set(adminId, { id: adminId, role: "admin" });
  const platformProviderId = randomUUID();
  const platformRoute = {
    projectId: workspaceProjectId, operation: "autoExtract", providerConnectionId: platformProviderId, modelId: "deepseek-v4-flash", embeddingDimensions: null, maxOutputTokens: 256,
    providerConnection: { id: platformProviderId, kind: "deepseek", status: "verified", disabledAt: null, scope: "platform", ownerUserId: null, defaultGenerationModelId: "deepseek-v4-flash", defaultEmbeddingModelId: null, defaultVisionModelId: null, embeddingDimensions: null },
  } as never;
  const adminWithoutGrant = await assertAiOutboundEntitlement({ projectId: workspaceProjectId, requestedById: adminId, route: platformRoute, db: fake as never, enforceConcurrency: false });
  assert.deepEqual(adminWithoutGrant, { billingMode: "platform", billingUserId: adminId, reservationRequired: true });
  await assert.rejects(
    () => reservePlatformTokens({ userId: adminId, callKey: stableAiCallKey("admin-no-grant", "autoExtract", "source"), operation: "autoExtract", modelId: "deepseek-v4-flash", estimatedTokens: 1 }, fake as never),
    entitlementError("AI_PLATFORM_TOKEN_EXHAUSTED"),
  );

  await assert.rejects(
    () => assertAiOutboundEntitlement({
      projectId: workspaceProjectId,
      requestedById: adminId,
      route: {
        projectId: workspaceProjectId, operation: "autoExtract", providerConnectionId: platformProviderId, modelId: "admin-custom-model", embeddingDimensions: null, maxOutputTokens: 256,
        providerConnection: { id: platformProviderId, kind: "deepseek", status: "verified", disabledAt: null, scope: "platform", ownerUserId: null, defaultGenerationModelId: "deepseek-v4-flash", defaultEmbeddingModelId: null, defaultVisionModelId: null, embeddingDimensions: null },
      } as never,
      db: fake as never,
      enforceConcurrency: false,
    }),
    entitlementError("AI_MODEL_CAPABILITY_MISMATCH"),
  );
  fake.jobs.push({ requestedById: adminId, status: "running" });
  await assert.rejects(
    () => assertAiOutboundEntitlement({ projectId: workspaceProjectId, requestedById: adminId, route: platformRoute, db: fake as never }),
    entitlementError("AI_PLATFORM_CONCURRENCY_LIMIT"),
  );
  fake.jobs.length = 0;

  fake.addGrant(adminId, 128, new Date("2026-10-01T00:00:00.000Z"));
  const adminWithGrant = await assertAiOutboundEntitlement({ projectId: workspaceProjectId, requestedById: adminId, route: platformRoute, db: fake as never });
  assert.deepEqual(adminWithGrant, { billingMode: "platform", billingUserId: adminId, reservationRequired: true });
  const adminReservation = await reservePlatformTokens({ userId: adminId, callKey: stableAiCallKey("admin-with-grant", "autoExtract", "source"), operation: "autoExtract", modelId: "deepseek-v4-flash", estimatedTokens: 64 }, fake as never);
  assert.equal(adminReservation.created, true);

  for (const role of ["user"] as const) {
    const userId = randomUUID();
    fake.users.set(userId, { id: userId, role });
    const userEntitlement = await assertAiOutboundEntitlement({ projectId: workspaceProjectId, requestedById: userId, route: platformRoute, db: fake as never, enforceConcurrency: false });
    assert.deepEqual(userEntitlement, { billingMode: "platform", billingUserId: userId, reservationRequired: true });
  }
});

test("effective platform routes use the configured model for every supported operation", async () => {
  const fake = new FakeEntitlementDb();
  const userId = randomUUID();
  fake.users.set(userId, { id: userId, role: "user" });
  const providerId = randomUUID();
  const snapshot = {
    source: "platform_default" as const,
    routeId: randomUUID(),
    routeVersion: 2,
    routeUpdatedAt: new Date("2026-09-02T00:00:00.000Z"),
    providerConfigurationVersion: 1,
    quotaMultiplierBps: 10_000,
    routeFenceFingerprint: "a".repeat(64),
  };
  const embeddingRoute = {
    projectId: randomUUID(),
    operation: "embedding" as const,
    providerConnectionId: providerId,
    modelId: "text-embedding-3-small",
    embeddingDimensions: 1536,
    maxOutputTokens: 128,
    ...snapshot,
    providerConnection: {
      id: providerId,
      kind: "openai",
      status: "verified",
      disabledAt: null,
      scope: "platform",
      ownerUserId: null,
      defaultGenerationModelId: "gpt-4.1-mini",
      defaultEmbeddingModelId: "text-embedding-3-small",
      defaultVisionModelId: "gpt-4o-mini",
      embeddingDimensions: 1536,
    },
  };
  const embedding = await assertAiOutboundEntitlement({
    projectId: embeddingRoute.projectId,
    requestedById: userId,
    route: embeddingRoute as never,
    db: fake as never,
    enforceConcurrency: false,
  });
  assert.deepEqual(embedding, { billingMode: "platform", billingUserId: userId, reservationRequired: true });

  const vision = await assertAiOutboundEntitlement({
    projectId: embeddingRoute.projectId,
    requestedById: userId,
    route: {
      ...embeddingRoute,
      operation: "visionExtract",
      modelId: "gpt-4o-mini",
      embeddingDimensions: null,
    } as never,
    db: fake as never,
    enforceConcurrency: false,
  });
  assert.deepEqual(vision, { billingMode: "platform", billingUserId: userId, reservationRequired: true });

  await assert.rejects(
    () => assertAiOutboundEntitlement({
      projectId: embeddingRoute.projectId,
      requestedById: userId,
      route: { ...embeddingRoute, modelId: "admin-selected-model" } as never,
      db: fake as never,
      enforceConcurrency: false,
    }),
    entitlementError("AI_MODEL_CAPABILITY_MISMATCH"),
  );
});

test("personal control-plane routes fail before platform quota or database admission", async () => {
  let databaseReads = 0;
  const db = {
    membershipSubscription: {
      findUnique: async () => {
        databaseReads += 1;
        return null;
      },
    },
  };
  await assert.rejects(
    () => assertAiOutboundEntitlement({
      projectId: randomUUID(),
      requestedById: randomUUID(),
      route: { source: "personal_delegation" } as never,
      db: db as never,
      enforceConcurrency: false,
    }),
    entitlementError("AI_ROUTE_CONFIGURATION_FORBIDDEN"),
  );
  assert.equal(databaseReads, 0);
});
