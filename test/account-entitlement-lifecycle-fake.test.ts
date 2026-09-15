import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  AccountEntitlementActivationError,
  activateAccountEntitlements,
  accountEntitlementPolicyFingerprint,
  publicAccountEntitlementActivation,
} from "../src/lib/account-entitlement-activation-service";
import {
  ACCOUNT_ENTITLEMENT_BACKFILL_TTL_MS,
  AccountEntitlementBackfillError,
  executeAccountEntitlementBackfill,
  previewAccountEntitlementBackfill,
} from "../src/lib/account-entitlement-backfill-service";
import { PLATFORM_GRANT_OFFER_ELIGIBILITY_KEY } from "../src/lib/platform-grant-offer-policy-service";

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_ID = "22222222-2222-4222-8222-222222222222";
const NO_OFFER_ID = "33333333-3333-4333-8333-333333333333";
const EXISTING_GRANT_ID = "44444444-4444-4444-8444-444444444444";
const NO_ACTIVATION_GRANT_ID = "55555555-5555-4555-8555-555555555555";
const DISABLED_ID = "66666666-6666-4666-8666-666666666666";
const LEGACY_ID = "77777777-7777-4777-8777-777777777777";
const STALE_ACTOR_ID = "88888888-8888-4888-8888-888888888888";
const POLICY_ID = "99999999-9999-4999-8999-999999999999";
const LEGACY_AMBIGUOUS_ID = "aaaaaaa6-aaaa-4aaa-8aaa-aaaaaaaaaaa6";
const MISSING_USER_ID = "aaaaaaa7-aaaa-4aaa-8aaa-aaaaaaaaaaa7";

type UserRow = {
  id: string;
  role: "admin" | "user";
  disabledAt: Date | null;
  accountAccessVersion: number;
};

type PolicyRow = {
  id: string;
  offerVersion: string;
  status: "active" | "draft" | "retired";
  amount: number;
  validForDays: number;
  eligibilityKey: string;
  activatedAt: Date | null;
};

type GrantRow = {
  id: string;
  userId: string;
  kind: "signup";
  amount: number;
  remainingTokens: number;
  offerVersion: string;
  offerAmount: number;
  offerValidForDays: number | null;
  eligibilityKey: string;
  eligibilitySource: string;
  issuedById: string | null;
  issuedAt: Date;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

type ActivationRow = Record<string, unknown> & {
  id: string;
  userId: string;
  lifecycleKey: string;
  decision: "granted" | "already_issued" | "no_active_offer";
  status: "granted" | "already_issued" | "no_active_offer";
  grantId: string | null;
  accountAccessVersion: number;
};

type BackfillRunRow = Record<string, unknown> & { id: string; items?: BackfillItemRow[] };
type BackfillItemRow = Record<string, unknown> & {
  id: string;
  runId: string;
  userId: string;
  classification: "already_issued" | "eligible_missing" | "legacy_ambiguous";
  status: "pending" | "applied" | "skipped";
};

type Snapshot = {
  users: Array<[string, UserRow]>;
  policies: PolicyRow[];
  grants: Array<[string, GrantRow]>;
  ledger: Record<string, unknown>[];
  activations: Array<[string, ActivationRow]>;
  activationAudits: Record<string, unknown>[];
  runs: Array<[string, BackfillRunRow]>;
  items: Array<[string, BackfillItemRow]>;
  backfillAudits: Record<string, unknown>[];
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function knownError(code: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError("fake database error", { code, clientVersion: "7.10.0" });
}

class EntitlementLifecycleFakeDb {
  readonly users = new Map<string, UserRow>();
  readonly policies: PolicyRow[] = [];
  readonly grants = new Map<string, GrantRow>();
  readonly ledger: Record<string, unknown>[] = [];
  readonly activations = new Map<string, ActivationRow>();
  readonly activationAudits: Record<string, unknown>[] = [];
  readonly runs = new Map<string, BackfillRunRow>();
  readonly items = new Map<string, BackfillItemRow>();
  readonly backfillAudits: Record<string, unknown>[] = [];
  nextTransactionError: unknown;
  nextWriteError: unknown;
  backfillUsersOverride: UserRow[] | undefined;
  transactionCount = 0;
  afterTransaction: ((count: number) => void) | undefined;

  readonly appUser = {
    findUnique: async ({ where }: { where: { id: string } }) => {
      const user = this.users.get(where.id);
      return user === undefined ? null : clone(user);
    },
    findMany: async ({ take = 20 }: { take?: number }) => (this.backfillUsersOverride ?? [...this.users.values()])
      .sort((left, right) => left.id.localeCompare(right.id))
      .slice(0, take)
      .map(clone),
  };

  readonly platformGrantOfferPolicy = {
    findFirst: async () => {
      const active = this.policies
        .filter((policy) => policy.status === "active")
        .sort((left, right) => (right.activatedAt?.getTime() ?? 0) - (left.activatedAt?.getTime() ?? 0) || right.id.localeCompare(left.id))[0];
      return active === undefined ? null : clone(active);
    },
    findUnique: async ({ where }: { where: { offerVersion: string } }) => {
      const policy = this.policies.find((candidate) => candidate.offerVersion === where.offerVersion);
      return policy === undefined ? null : clone(policy);
    },
  };

  readonly platformTokenGrant = {
    findFirst: async ({ where }: { where: { userId?: string; kind?: string } }) => {
      const grant = [...this.grants.values()].find((candidate) => (where.userId === undefined || candidate.userId === where.userId)
        && (where.kind === undefined || candidate.kind === where.kind));
      return grant === undefined ? null : clone(grant);
    },
    findMany: async ({ where }: { where: { userId?: { in: string[] }; kind?: string } }) => [...this.grants.values()]
      .filter((grant) => (where.userId?.in === undefined || where.userId.in.includes(grant.userId))
        && (where.kind === undefined || grant.kind === where.kind))
      .map(clone),
    create: async ({ data }: { data: unknown }) => {
      this.consumeWriteError();
      const row = clone(asRecord(data)) as unknown as GrantRow;
      if ([...this.grants.values()].some((grant) => grant.userId === row.userId && grant.kind === row.kind)) throw knownError("P2002");
      this.grants.set(row.id, row);
      return clone(row);
    },
  };

  readonly platformTokenLedgerEntry = {
    create: async ({ data }: { data: unknown }) => {
      this.consumeWriteError();
      const row = clone(asRecord(data));
      if (this.ledger.some((entry) => entry.idempotencyKey === row.idempotencyKey)) throw knownError("P2002");
      this.ledger.push(row);
      return clone(row);
    },
  };

  readonly accountEntitlementActivation = {
    findUnique: async ({ where }: { where: Record<string, unknown> }) => {
      const compound = asRecord(where.userId_lifecycleKey);
      const id = typeof where.id === "string" ? where.id : undefined;
      const row = id === undefined
        ? [...this.activations.values()].find((candidate) => candidate.userId === compound.userId && candidate.lifecycleKey === compound.lifecycleKey)
        : this.activations.get(id);
      return row === undefined ? null : clone(row);
    },
    findMany: async ({ where }: { where: { userId: { in: string[] } } }) => [...this.activations.values()]
      .filter((activation) => where.userId.in.includes(activation.userId))
      .map(clone),
    create: async ({ data }: { data: unknown }) => {
      this.consumeWriteError();
      const row = clone(asRecord(data)) as unknown as ActivationRow;
      if ([...this.activations.values()].some((activation) => activation.userId === row.userId && activation.lifecycleKey === row.lifecycleKey)) throw knownError("P2002");
      this.activations.set(row.id, row);
      return clone(row);
    },
  };

  readonly accountEntitlementActivationAudit = {
    create: async ({ data }: { data: unknown }) => {
      this.consumeWriteError();
      const row = clone(asRecord(data));
      if (this.activationAudits.some((audit) => audit.activationId === row.activationId)) throw knownError("P2002");
      this.activationAudits.push(row);
      return clone(row);
    },
  };

  readonly accountEntitlementBackfillRun = {
    create: async ({ data }: { data: unknown }) => {
      this.consumeWriteError();
      const source = clone(asRecord(data));
      const row = {
        ...source,
        id: String(source.id),
        grantedCount: source.grantedCount ?? 0,
        skippedCount: source.skippedCount ?? 0,
        requestKey: source.requestKey ?? null,
        reason: source.reason ?? null,
        confirmedAt: source.confirmedAt ?? null,
        consumedAt: source.consumedAt ?? null,
        executedAt: source.executedAt ?? null,
        items: [],
      } as unknown as BackfillRunRow;
      this.runs.set(String(row.id), row);
      return this.withItems(row);
    },
    findUnique: async ({ where }: { where: { id: string } }) => {
      const row = this.runs.get(where.id);
      return row === undefined ? null : this.withItems(row);
    },
    findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
      const row = this.runs.get(where.id);
      if (row === undefined) throw new Error("FAKE_BACKFILL_RUN_NOT_FOUND");
      return this.withItems(row);
    },
    findFirst: async ({ where }: { where: { actorId: string; requestKey: string } }) => {
      const row = [...this.runs.values()].find((candidate) => candidate.actorId === where.actorId && candidate.requestKey === where.requestKey);
      return row === undefined ? null : { id: row.id };
    },
    update: async ({ where, data }: { where: { id: string }; data: unknown }) => {
      this.consumeWriteError();
      const row = this.runs.get(where.id);
      if (row === undefined) throw new Error("FAKE_BACKFILL_RUN_NOT_FOUND");
      Object.assign(row, clone(asRecord(data)));
      return this.withItems(row);
    },
    updateMany: async ({ where, data }: { where: { id: string; status?: string; requestKey?: null }; data: unknown }) => {
      this.consumeWriteError();
      const row = this.runs.get(where.id);
      if (row === undefined || (where.status !== undefined && row.status !== where.status)
        || (where.requestKey === null && row.requestKey !== null)) return { count: 0 };
      Object.assign(row, clone(asRecord(data)));
      return { count: 1 };
    },
  };

  readonly accountEntitlementBackfillItem = {
    createMany: async ({ data }: { data: unknown[] }) => {
      this.consumeWriteError();
      for (const candidate of data) {
        const source = clone(asRecord(candidate));
        const row = { ...source, status: source.status ?? "pending" } as BackfillItemRow;
        this.items.set(String(row.id), row);
      }
      return { count: data.length };
    },
    update: async ({ where, data }: { where: { id: string }; data: unknown }) => {
      this.consumeWriteError();
      const row = this.items.get(where.id);
      if (row === undefined) throw new Error("FAKE_BACKFILL_ITEM_NOT_FOUND");
      Object.assign(row, clone(asRecord(data)));
      return clone(row);
    },
  };

  readonly accountEntitlementBackfillAudit = {
    create: async ({ data }: { data: unknown }) => {
      this.consumeWriteError();
      const row = clone(asRecord(data));
      this.backfillAudits.push(row);
      return clone(row);
    },
  };

  async $transaction<T>(callback: (tx: this) => Promise<T>): Promise<T> {
    if (this.nextTransactionError !== undefined) {
      const error = this.nextTransactionError;
      this.nextTransactionError = undefined;
      throw error;
    }
    const snapshot = this.snapshot();
    try {
      const result = await callback(this.transactionView());
      this.transactionCount += 1;
      this.afterTransaction?.(this.transactionCount);
      return result;
    } catch (error) {
      this.restore(snapshot);
      throw error;
    }
  }

  async $executeRaw(): Promise<number> {
    return 1;
  }

  private consumeWriteError(): void {
    if (this.nextWriteError === undefined) return;
    const error = this.nextWriteError;
    this.nextWriteError = undefined;
    throw error;
  }

  private withItems(row: BackfillRunRow): BackfillRunRow {
    return {
      ...clone(row),
      items: [...this.items.values()].filter((item) => item.runId === row.id).map(clone),
    };
  }

  private transactionView(): this {
    return new Proxy(this, {
      get(object, property, receiver) {
        if (property === "$transaction") return undefined;
        const value = Reflect.get(object, property, receiver);
        return typeof value === "function" ? value.bind(object) : value;
      },
    }) as this;
  }

  private snapshot(): Snapshot {
    return clone({
      users: [...this.users.entries()],
      policies: this.policies,
      grants: [...this.grants.entries()],
      ledger: this.ledger,
      activations: [...this.activations.entries()],
      activationAudits: this.activationAudits,
      runs: [...this.runs.entries()],
      items: [...this.items.entries()],
      backfillAudits: this.backfillAudits,
    });
  }

  private restore(snapshot: Snapshot): void {
    this.users.clear();
    for (const [id, row] of snapshot.users) this.users.set(id, row);
    this.policies.splice(0, this.policies.length, ...snapshot.policies);
    this.grants.clear();
    for (const [id, row] of snapshot.grants) this.grants.set(id, row);
    this.ledger.splice(0, this.ledger.length, ...snapshot.ledger);
    this.activations.clear();
    for (const [id, row] of snapshot.activations) this.activations.set(id, row);
    this.activationAudits.splice(0, this.activationAudits.length, ...snapshot.activationAudits);
    this.runs.clear();
    for (const [id, row] of snapshot.runs) this.runs.set(id, row);
    this.items.clear();
    for (const [id, row] of snapshot.items) this.items.set(id, row);
    this.backfillAudits.splice(0, this.backfillAudits.length, ...snapshot.backfillAudits);
  }
}

function dbAsPrisma(db: EntitlementLifecycleFakeDb): PrismaClient {
  return db as unknown as PrismaClient;
}

function addUser(db: EntitlementLifecycleFakeDb, row: UserRow): void {
  db.users.set(row.id, row);
}

function addPolicy(db: EntitlementLifecycleFakeDb, input: Partial<PolicyRow> & Pick<PolicyRow, "id" | "offerVersion">): PolicyRow {
  const policy: PolicyRow = {
    status: "active",
    amount: 500_000,
    validForDays: 30,
    eligibilityKey: PLATFORM_GRANT_OFFER_ELIGIBILITY_KEY,
    activatedAt: new Date("2026-09-15T00:00:00.000Z"),
    ...input,
  };
  db.policies.push(policy);
  return policy;
}

function addGrant(db: EntitlementLifecycleFakeDb, input: Partial<GrantRow> & Pick<GrantRow, "id" | "userId">): GrantRow {
  const issuedAt = input.issuedAt ?? new Date("2026-09-14T00:00:00.000Z");
  const grant: GrantRow = {
    kind: "signup",
    amount: 500_000,
    remainingTokens: 500_000,
    offerVersion: "signup-v1",
    offerAmount: 500_000,
    offerValidForDays: 30,
    eligibilityKey: PLATFORM_GRANT_OFFER_ELIGIBILITY_KEY,
    eligibilitySource: "githubRegistration",
    issuedById: ADMIN_ID,
    issuedAt,
    expiresAt: new Date(issuedAt.getTime() + 30 * 86_400_000),
    createdAt: issuedAt,
    updatedAt: issuedAt,
    ...input,
  };
  db.grants.set(grant.id, grant);
  return grant;
}

function activationInput(userId: string, extra: Record<string, unknown> = {}) {
  return {
    userId,
    source: "githubRegistration" as const,
    actorId: ADMIN_ID,
    actorAccountAccessVersion: 1,
    accountAccessVersion: 1,
    evidenceKind: "github",
    evidenceRef: `github:${userId}`,
    now: new Date("2026-09-15T01:00:00.000Z"),
    ...extra,
  };
}

function backfillActor() {
  return { id: ADMIN_ID, role: "admin" as const, accountAccessVersion: 1 };
}

function backfillInput(runId: string, impactFingerprint: string, requestKey: string, reason: string) {
  return { runId, impactFingerprint, confirmation: true as const, requestKey, reason };
}

function code(error: unknown): string | null {
  if (error instanceof AccountEntitlementActivationError || error instanceof AccountEntitlementBackfillError) return error.code;
  return null;
}

test("account entitlement activation fake-DB creates one immutable grant fact and fails closed", async () => {
  const db = new EntitlementLifecycleFakeDb();
  const now = new Date("2026-09-15T01:00:00.000Z");
  addUser(db, { id: ADMIN_ID, role: "admin", disabledAt: null, accountAccessVersion: 1 });
  addUser(db, { id: TARGET_ID, role: "user", disabledAt: null, accountAccessVersion: 1 });
  addPolicy(db, { id: POLICY_ID, offerVersion: "signup-v1" });
  const typedDb = dbAsPrisma(db);

  const granted = await activateAccountEntitlements(activationInput(TARGET_ID), typedDb);
  assert.equal(granted.decision, "granted");
  assert.ok(granted.grantId);
  assert.equal(db.grants.size, 1);
  assert.equal(db.ledger.length, 1);
  assert.equal(db.activationAudits.length, 1);
  assert.equal(db.ledger[0]?.idempotencyKey, `grant:signup:${TARGET_ID}:signup-v1`);
  assert.equal(db.activationAudits[0]?.action, "created");
  assert.deepEqual(publicAccountEntitlementActivation(granted), {
    id: granted.id,
    source: "githubRegistration",
    decision: "granted",
    status: "granted",
    createdAt: now,
  });

  const replay = await activateAccountEntitlements(activationInput(TARGET_ID), typedDb);
  assert.equal(replay.id, granted.id);
  assert.equal(db.grants.size, 1);
  assert.equal(db.activationAudits.length, 1);

  addUser(db, { id: EXISTING_GRANT_ID, role: "user", disabledAt: null, accountAccessVersion: 1 });
  addGrant(db, { id: NO_ACTIVATION_GRANT_ID, userId: EXISTING_GRANT_ID });
  const linked = await activateAccountEntitlements(activationInput(EXISTING_GRANT_ID, { evidenceRefDigest: "a".repeat(64), evidenceRef: undefined }), typedDb);
  assert.equal(linked.decision, "already_issued");
  assert.equal(linked.grantId, NO_ACTIVATION_GRANT_ID);
  assert.equal(db.activationAudits.at(-1)?.action, "linked");

  addUser(db, { id: LEGACY_ID, role: "user", disabledAt: null, accountAccessVersion: 1 });
  const legacyIssuedAt = new Date("2026-09-10T01:00:00.000Z");
  addGrant(db, {
    id: "legacy-grant-exact",
    userId: LEGACY_ID,
    offerVersion: "legacy-v0",
    offerValidForDays: null,
    issuedAt: legacyIssuedAt,
    expiresAt: new Date(legacyIssuedAt.getTime() + 30 * 86_400_000),
  });
  addPolicy(db, { id: "legacy-policy-v0", offerVersion: "legacy-v0", status: "retired" });
  const legacyLinked = await activateAccountEntitlements(activationInput(LEGACY_ID), typedDb);
  assert.equal(legacyLinked.decision, "already_issued");
  assert.equal(db.activations.get(legacyLinked.id)?.offerValidForDays, 30);

  addUser(db, { id: LEGACY_AMBIGUOUS_ID, role: "user", disabledAt: null, accountAccessVersion: 1 });
  const ambiguousIssuedAt = new Date("2026-09-10T02:00:00.000Z");
  addGrant(db, {
    id: "legacy-grant-ambiguous",
    userId: LEGACY_AMBIGUOUS_ID,
    offerVersion: "legacy-v-ambiguous",
    offerValidForDays: null,
    issuedAt: ambiguousIssuedAt,
    expiresAt: new Date(ambiguousIssuedAt.getTime() + 12 * 60 * 60_000),
  });
  addPolicy(db, { id: "legacy-policy-ambiguous", offerVersion: "legacy-v-ambiguous", status: "retired" });
  const ambiguousLinked = await activateAccountEntitlements(activationInput(LEGACY_AMBIGUOUS_ID), typedDb);
  assert.equal(ambiguousLinked.decision, "already_issued");
  assert.equal(db.activations.get(ambiguousLinked.id)?.offerValidForDays, null);

  addUser(db, { id: MISSING_USER_ID, role: "user", disabledAt: null, accountAccessVersion: 1 });
  addGrant(db, { id: "legacy-grant-no-active-policy", userId: MISSING_USER_ID, offerVersion: "legacy-v0" });
  for (const policy of db.policies) policy.status = "retired";
  const linkedWithoutActivePolicy = await activateAccountEntitlements(activationInput(MISSING_USER_ID), typedDb);
  assert.equal(linkedWithoutActivePolicy.decision, "already_issued");
  assert.equal(linkedWithoutActivePolicy.grantId, "legacy-grant-no-active-policy");
  db.policies[0]!.status = "active";

  await assert.rejects(
    () => activateAccountEntitlements(activationInput("aaaaaaa8-aaaa-4aaa-8aaa-aaaaaaaaaaa8"), typedDb),
    (error: unknown) => code(error) === "ACCOUNT_ENTITLEMENT_ACCOUNT_NOT_FOUND",
  );
  db.users.get(ADMIN_ID)!.disabledAt = now;
  await assert.rejects(
    () => activateAccountEntitlements(activationInput(TARGET_ID), typedDb),
    (error: unknown) => code(error) === "ACCOUNT_ENTITLEMENT_ACTOR_INVALID",
  );
  db.users.get(ADMIN_ID)!.disabledAt = null;
  await assert.rejects(
    () => activateAccountEntitlements(activationInput(TARGET_ID, { accountAccessVersion: 0 }), typedDb),
    (error: unknown) => code(error) === "ACCOUNT_ENTITLEMENT_INVALID_INPUT",
  );
  await assert.rejects(
    () => activateAccountEntitlements(activationInput(TARGET_ID, { actorAccountAccessVersion: 0 }), typedDb),
    (error: unknown) => code(error) === "ACCOUNT_ENTITLEMENT_INVALID_INPUT",
  );
  await assert.rejects(
    () => activateAccountEntitlements(activationInput(TARGET_ID, { evidenceRef: "" }), typedDb),
    (error: unknown) => code(error) === "ACCOUNT_ENTITLEMENT_INVALID_INPUT",
  );
  await assert.rejects(
    () => activateAccountEntitlements(activationInput(TARGET_ID, { evidenceRef: "r".repeat(513) }), typedDb),
    (error: unknown) => code(error) === "ACCOUNT_ENTITLEMENT_INVALID_INPUT",
  );

  const systemUser = "aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
  addUser(db, { id: systemUser, role: "user", disabledAt: null, accountAccessVersion: 1 });
  const systemActivation = await activateAccountEntitlements({
    userId: systemUser,
    source: "bootstrap",
    now,
  }, typedDb);
  assert.equal(systemActivation.actorId, null);
  assert.equal(systemActivation.actorKind, "system");

  const noPolicyUser = "aaaaaaa2-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
  addUser(db, { id: noPolicyUser, role: "user", disabledAt: null, accountAccessVersion: 1 });
  db.policies[0]!.status = "retired";
  const noPolicy = await activateAccountEntitlements(activationInput(noPolicyUser), typedDb);
  assert.equal(noPolicy.decision, "no_active_offer");
  assert.equal(noPolicy.grantId, null);
  assert.equal(db.grants.has(noPolicyUser), false);
  assert.equal((await activateAccountEntitlements(activationInput(noPolicyUser), typedDb)).id, noPolicy.id);
  db.policies[0]!.status = "active";

  const invalidPolicyUser = "aaaaaaa3-aaaa-4aaa-8aaa-aaaaaaaaaaa3";
  addUser(db, { id: invalidPolicyUser, role: "user", disabledAt: null, accountAccessVersion: 1 });
  db.policies[0]!.eligibilityKey = "unverified_identity_v1";
  const beforeInvalid = { grants: db.grants.size, activations: db.activations.size };
  await assert.rejects(
    () => activateAccountEntitlements(activationInput(invalidPolicyUser), typedDb),
    (error: unknown) => code(error) === "ACCOUNT_ENTITLEMENT_POLICY_INVALID",
  );
  assert.deepEqual({ grants: db.grants.size, activations: db.activations.size }, beforeInvalid);
  db.policies[0]!.eligibilityKey = PLATFORM_GRANT_OFFER_ELIGIBILITY_KEY;

  const disabledUser = "aaaaaaa4-aaaa-4aaa-8aaa-aaaaaaaaaaa4";
  addUser(db, { id: disabledUser, role: "user", disabledAt: now, accountAccessVersion: 1 });
  await assert.rejects(
    () => activateAccountEntitlements(activationInput(disabledUser), typedDb),
    (error: unknown) => code(error) === "ACCOUNT_ENTITLEMENT_ACCOUNT_DISABLED",
  );
  await assert.rejects(
    () => activateAccountEntitlements(activationInput(TARGET_ID, { accountAccessVersion: 2 }), typedDb),
    (error: unknown) => code(error) === "ACCOUNT_ENTITLEMENT_EPOCH_STALE",
  );
  await assert.rejects(
    () => activateAccountEntitlements(activationInput(TARGET_ID, { actorId: NO_OFFER_ID }), typedDb),
    (error: unknown) => code(error) === "ACCOUNT_ENTITLEMENT_ACTOR_INVALID",
  );
  await assert.rejects(
    () => activateAccountEntitlements(activationInput("not-a-uuid"), typedDb),
    (error: unknown) => code(error) === "ACCOUNT_ENTITLEMENT_INVALID_INPUT",
  );
  await assert.rejects(
    () => activateAccountEntitlements(activationInput(TARGET_ID, { evidenceKind: "Bad Evidence" }), typedDb),
    (error: unknown) => code(error) === "ACCOUNT_ENTITLEMENT_INVALID_INPUT",
  );
  await assert.rejects(
    () => activateAccountEntitlements(activationInput(TARGET_ID, { evidenceRefDigest: "bad" }), typedDb),
    (error: unknown) => code(error) === "ACCOUNT_ENTITLEMENT_INVALID_INPUT",
  );

  db.nextTransactionError = knownError("P2034");
  const retryUser = "aaaaaaa5-aaaa-4aaa-8aaa-aaaaaaaaaaa5";
  addUser(db, { id: retryUser, role: "user", disabledAt: null, accountAccessVersion: 1 });
  const retried = await activateAccountEntitlements(activationInput(retryUser), typedDb);
  assert.equal(retried.decision, "granted");
  assert.equal(db.activations.get(retried.id)?.userId, retryUser);
  assert.match(accountEntitlementPolicyFingerprint({
    offerVersion: "signup-v1",
    amount: 500_000,
    validForDays: 30,
    eligibilityKey: PLATFORM_GRANT_OFFER_ELIGIBILITY_KEY,
  }), /^[0-9a-f]{64}$/u);
});

test("account entitlement backfill fake-DB freezes classifications, applies only eligible users, and rolls back failures", async () => {
  const db = new EntitlementLifecycleFakeDb();
  const baseNow = new Date("2026-09-15T02:00:00.000Z");
  addUser(db, { id: ADMIN_ID, role: "admin", disabledAt: null, accountAccessVersion: 1 });
  addUser(db, { id: TARGET_ID, role: "user", disabledAt: null, accountAccessVersion: 1 });
  addUser(db, { id: NO_OFFER_ID, role: "user", disabledAt: null, accountAccessVersion: 1 });
  addUser(db, { id: EXISTING_GRANT_ID, role: "user", disabledAt: null, accountAccessVersion: 1 });
  addUser(db, { id: DISABLED_ID, role: "user", disabledAt: null, accountAccessVersion: 1 });
  addUser(db, { id: LEGACY_ID, role: "user", disabledAt: null, accountAccessVersion: 1 });
  addPolicy(db, { id: POLICY_ID, offerVersion: "signup-v1" });
  const typedDb = dbAsPrisma(db);
  const keyDirectory = await mkdtemp(join(tmpdir(), "ai-project-os-entitlement-fake-"));
  const keyPath = join(keyDirectory, "master.key");
  const previousKeyPath = process.env.AI_PROJECT_OS_MASTER_KEY_FILE;
  process.env.AI_PROJECT_OS_MASTER_KEY_FILE = keyPath;
  try {
    await writeFile(keyPath, `${randomBytes(32).toString("base64url")}\n`, { mode: 0o600 });
    await chmod(keyPath, 0o600);

    const existingActivation = await activateAccountEntitlements(activationInput(EXISTING_GRANT_ID), typedDb);
    assert.equal(existingActivation.decision, "granted");
    db.policies[0]!.status = "retired";
    const missingActivation = await activateAccountEntitlements(activationInput(NO_OFFER_ID), typedDb);
    const disabledActivation = await activateAccountEntitlements(activationInput(DISABLED_ID), typedDb);
    assert.equal(missingActivation.decision, "no_active_offer");
    assert.equal(disabledActivation.decision, "no_active_offer");
    db.policies[0]!.status = "active";
    addGrant(db, { id: NO_ACTIVATION_GRANT_ID, userId: TARGET_ID });

    const preview = await previewAccountEntitlementBackfill(backfillActor(), typedDb, baseNow);
    assert.equal(preview.status, "previewed");
    assert.ok(preview.alreadyIssuedCount >= 2);
    assert.ok(preview.eligibleMissingCount >= 2);
    assert.ok(preview.legacyAmbiguousCount >= 1);
    assert.equal(preview.candidateCount, db.users.size);
    const runBeforeFailure = clone(db.runs.get(preview.runId));
    const itemsBeforeFailure = clone([...db.items.values()]);

    db.nextWriteError = knownError("P2002");
    await assert.rejects(
      () => executeAccountEntitlementBackfill(backfillInput(preview.runId, preview.impactFingerprint, "00000000-0000-4000-8000-000000000001", "unique failure"), backfillActor(), typedDb, baseNow),
      (error: unknown) => code(error) === "ACCOUNT_ENTITLEMENT_BACKFILL_IDEMPOTENCY_CONFLICT",
    );
    assert.deepEqual(db.runs.get(preview.runId), runBeforeFailure);
    assert.deepEqual([...db.items.values()], itemsBeforeFailure);

    db.users.get(DISABLED_ID)!.disabledAt = baseNow;
    const requestKey = "00000000-0000-4000-8000-000000000002";
    const result = await executeAccountEntitlementBackfill(
      backfillInput(preview.runId, preview.impactFingerprint, requestKey, "apply controlled historical entitlements"),
      backfillActor(),
      typedDb,
      new Date(baseNow.getTime() + 1_000),
    );
    assert.equal(result.status, "completed");
    assert.ok(result.grantedCount >= 1);
    assert.ok(result.skippedCount >= 2);
    assert.equal(db.grants.get(NO_ACTIVATION_GRANT_ID)?.userId, TARGET_ID);
    assert.equal([...db.grants.values()].filter((grant) => grant.userId === NO_OFFER_ID).length, 1);
    assert.equal([...db.grants.values()].filter((grant) => grant.userId === DISABLED_ID).length, 0);
    const resultItems = [...db.items.values()].filter((item) => item.runId === preview.runId);
    assert.equal(resultItems.find((item) => item.userId === LEGACY_ID)?.skipCode, "LEGACY_AMBIGUOUS");
    assert.equal(resultItems.find((item) => item.userId === DISABLED_ID)?.skipCode, "ACCOUNT_DISABLED");
    assert.equal(db.backfillAudits.some((audit) => audit.action === "executed"), true);

    const replay = await executeAccountEntitlementBackfill(
      backfillInput(preview.runId, preview.impactFingerprint, requestKey, "apply controlled historical entitlements"),
      backfillActor(),
      typedDb,
      new Date(baseNow.getTime() + 2_000),
    );
    assert.equal(replay.status, "completed");
    await assert.rejects(
      () => executeAccountEntitlementBackfill(backfillInput(preview.runId, preview.impactFingerprint, requestKey, "different reason"), backfillActor(), typedDb, baseNow),
      (error: unknown) => code(error) === "ACCOUNT_ENTITLEMENT_BACKFILL_IDEMPOTENCY_CONFLICT",
    );

    const stalePreview = await previewAccountEntitlementBackfill(backfillActor(), typedDb, baseNow);
    db.policies[0]!.status = "retired";
    const stale = await executeAccountEntitlementBackfill(
      backfillInput(stalePreview.runId, stalePreview.impactFingerprint, "00000000-0000-4000-8000-000000000003", "policy drift"),
      backfillActor(),
      typedDb,
      baseNow,
    );
    assert.equal(stale.status, "stale");
    db.policies[0]!.status = "active";

    const expiredPreview = await previewAccountEntitlementBackfill(backfillActor(), typedDb, baseNow);
    const expired = await executeAccountEntitlementBackfill(
      backfillInput(expiredPreview.runId, expiredPreview.impactFingerprint, "00000000-0000-4000-8000-000000000004", "expired preview"),
      backfillActor(),
      typedDb,
      new Date(baseNow.getTime() + ACCOUNT_ENTITLEMENT_BACKFILL_TTL_MS + 1),
    );
    assert.equal(expired.status, "expired");

    const retryPreview = await previewAccountEntitlementBackfill(backfillActor(), typedDb, baseNow);
    assert.equal(retryPreview.status, "previewed");
    db.nextTransactionError = knownError("P2034");
    const retryAfterSerialization = await previewAccountEntitlementBackfill(backfillActor(), typedDb, baseNow);
    assert.equal(retryAfterSerialization.status, "previewed");

    await assert.rejects(
      () => executeAccountEntitlementBackfill({ ...backfillInput(retryPreview.runId, retryPreview.impactFingerprint, "not-a-uuid", "invalid request"), confirmation: false }, backfillActor(), typedDb, baseNow),
      (error: unknown) => code(error) === "ACCOUNT_ENTITLEMENT_BACKFILL_INVALID_INPUT",
    );

    const resumePreview = await previewAccountEntitlementBackfill(backfillActor(), typedDb, baseNow);
    const resumeRun = db.runs.get(resumePreview.runId)!;
    const resumeRequestKey = "00000000-0000-4000-8000-000000000006";
    const resumeReason = "resume an already claimed run";
    resumeRun.status = "executing";
    resumeRun.requestKey = resumeRequestKey;
    resumeRun.reason = resumeReason;
    resumeRun.confirmedAt = baseNow;
    resumeRun.consumedAt = baseNow;
    resumeRun.transitionAt = baseNow;
    for (const item of db.items.values()) {
      if (item.runId === resumePreview.runId) item.status = "skipped";
    }
    const resumed = await executeAccountEntitlementBackfill(
      backfillInput(resumePreview.runId, resumePreview.impactFingerprint, resumeRequestKey, resumeReason),
      backfillActor(),
      typedDb,
      new Date(baseNow.getTime() + 1_000),
    );
    assert.equal(resumed.status, "completed");
    assert.equal(db.runs.get(resumePreview.runId)?.status, "completed");

    const epochPreview = await previewAccountEntitlementBackfill(backfillActor(), typedDb, baseNow);
    const grantsBeforeEpochDrift = db.grants.size;
    const claimTransaction = db.transactionCount + 1;
    db.afterTransaction = (count) => {
      if (count === claimTransaction) db.users.get(ADMIN_ID)!.accountAccessVersion = 2;
    };
    const epochDrift = await executeAccountEntitlementBackfill(
      backfillInput(epochPreview.runId, epochPreview.impactFingerprint, "00000000-0000-4000-8000-000000000007", "actor epoch drift"),
      backfillActor(),
      typedDb,
      new Date(baseNow.getTime() + 2_000),
    );
    assert.equal(epochDrift.status, "stale");
    assert.equal(db.runs.get(epochPreview.runId)?.status, "stale");
    assert.equal(db.grants.size, grantsBeforeEpochDrift);
    assert.equal(db.backfillAudits.at(-1)?.action, "stale");
    db.afterTransaction = undefined;
    db.users.get(ADMIN_ID)!.accountAccessVersion = 1;

    db.backfillUsersOverride = [];
    const emptyPreview = await previewAccountEntitlementBackfill(backfillActor(), typedDb, baseNow);
    assert.equal(emptyPreview.candidateCount, 0);
    assert.equal(emptyPreview.alreadyIssuedCount, 0);
    assert.equal(emptyPreview.eligibleMissingCount, 0);
    assert.equal(emptyPreview.legacyAmbiguousCount, 0);
    const emptyResult = await executeAccountEntitlementBackfill(
      backfillInput(emptyPreview.runId, emptyPreview.impactFingerprint, "00000000-0000-4000-8000-000000000008", "complete empty candidate set"),
      backfillActor(),
      typedDb,
      baseNow,
    );
    assert.equal(emptyResult.status, "completed");
    assert.equal(emptyResult.grantedCount, 0);
    assert.equal(emptyResult.skippedCount, 0);
    db.backfillUsersOverride = undefined;

    db.users.get(ADMIN_ID)!.disabledAt = baseNow;
    await assert.rejects(
      () => previewAccountEntitlementBackfill(backfillActor(), typedDb, baseNow),
      (error: unknown) => code(error) === "ACCOUNT_ENTITLEMENT_BACKFILL_ADMIN_REQUIRED",
    );
    db.users.get(ADMIN_ID)!.disabledAt = null;
    await assert.rejects(
      () => previewAccountEntitlementBackfill({ id: ADMIN_ID, role: "user", accountAccessVersion: 1 }, typedDb, baseNow),
      (error: unknown) => code(error) === "ACCOUNT_ENTITLEMENT_BACKFILL_ADMIN_REQUIRED",
    );
    await assert.rejects(
      () => previewAccountEntitlementBackfill({ id: ADMIN_ID, role: "admin" }, typedDb),
      (error: unknown) => code(error) === "ACCOUNT_ENTITLEMENT_BACKFILL_EPOCH_STALE",
    );
    await assert.rejects(
      () => previewAccountEntitlementBackfill({ id: STALE_ACTOR_ID, role: "admin", accountAccessVersion: 1 }, typedDb, baseNow),
      (error: unknown) => code(error) === "ACCOUNT_ENTITLEMENT_BACKFILL_ADMIN_REQUIRED",
    );
    addUser(db, { id: STALE_ACTOR_ID, role: "admin", disabledAt: null, accountAccessVersion: 2 });
    await assert.rejects(
      () => previewAccountEntitlementBackfill({ id: STALE_ACTOR_ID, role: "admin", accountAccessVersion: 1 }, typedDb, baseNow),
      (error: unknown) => code(error) === "ACCOUNT_ENTITLEMENT_BACKFILL_EPOCH_STALE",
    );
    const missingRun = await assert.rejects(
      () => executeAccountEntitlementBackfill(backfillInput("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", "b".repeat(64), "00000000-0000-4000-8000-000000000005", "missing run"), backfillActor(), typedDb, baseNow),
      (error: unknown) => code(error) === "ACCOUNT_ENTITLEMENT_BACKFILL_NOT_FOUND",
    );
    assert.equal(missingRun, undefined);
  } finally {
    try {
      if (previousKeyPath === undefined) delete process.env.AI_PROJECT_OS_MASTER_KEY_FILE;
      else process.env.AI_PROJECT_OS_MASTER_KEY_FILE = previousKeyPath;
    } finally {
      try {
        const metadata = await stat(keyPath);
        assert.equal(metadata.mode & 0o077, 0);
        const encodedKey = await readFile(keyPath, "utf8");
        assert.equal(Buffer.from(encodedKey.trim(), "base64url").length, 32);
      } finally {
        await rm(keyDirectory, { recursive: true, force: true });
      }
    }
  }
});
