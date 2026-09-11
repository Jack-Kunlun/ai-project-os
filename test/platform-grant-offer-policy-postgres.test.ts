import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Prisma, type PrismaClient } from "@prisma/client";
import { initializeAdmin } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { activateAccountEntitlements } from "../src/lib/account-entitlement-activation-service";
import {
  changePlatformGrantOfferPolicyLifecycle,
  createPlatformGrantOfferPolicy,
  listPlatformGrantOfferPolicies,
  PLATFORM_GRANT_OFFER_ELIGIBILITY_KEY,
  type PlatformGrantOfferPolicyActor,
} from "../src/lib/platform-grant-offer-policy-service";
import { activateCanonicalSignupGrant } from "./account-entitlement-test-helper";

const shouldRun = process.env.PLATFORM_GRANT_OFFER_POLICY_POSTGRES_GATE === "1";

type LegacyPolicyRow = Readonly<{
  offerVersion: string;
  status: "draft" | "active" | "retired";
  amount: number;
  validForDays: number;
  eligibilityKey: string;
}>;

async function legacyPreflightSql(): Promise<string> {
  const migration = await readFile(new URL("../prisma/migrations/20260910030000_add_platform_grant_offer_policy_governance/migration.sql", import.meta.url), "utf8");
  const block = migration.match(/DO \$\$[\s\S]*?\$\$;/u)?.[0];
  if (block === undefined) throw new Error("PLATFORM_GRANT_OFFER_POLICY_PREFLIGHT_MISSING");
  return block;
}

async function runLegacyPreflightCase(db: PrismaClient, row: LegacyPolicyRow): Promise<void> {
  const sql = await legacyPreflightSql();
  await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`CREATE TEMP TABLE "PlatformGrantOfferPolicy" (
      "id" uuid NOT NULL,
      "offerVersion" varchar(64) NOT NULL,
      "status" "PlatformGrantOfferPolicyStatus" NOT NULL,
      "amount" integer NOT NULL,
      "validForDays" integer NOT NULL,
      "eligibilityKey" varchar(64) NOT NULL
    ) ON COMMIT DROP`);
    await tx.$executeRaw`
      INSERT INTO "PlatformGrantOfferPolicy" ("id", "offerVersion", "status", "amount", "validForDays", "eligibilityKey")
      VALUES (${randomUUID()}::uuid, ${row.offerVersion}, ${row.status}::"PlatformGrantOfferPolicyStatus", ${row.amount}, ${row.validForDays}, ${row.eligibilityKey})
    `;
    await tx.$executeRawUnsafe(sql);
  });
}

async function retireActiveForNegativeCase(
  tx: Prisma.TransactionClient,
  policy: Readonly<{ id: string; offerVersion: string; amount: number; validForDays: number; eligibilityKey: string }>,
  actorId: string,
  transactionId: string,
): Promise<void> {
  const retiredAt = new Date();
  await tx.platformGrantOfferPolicy.update({
    where: { id: policy.id },
    data: { status: "retired", retiredById: actorId, retiredAt, updatedById: actorId, updatedAt: retiredAt },
  });
  await tx.platformGrantOfferPolicyAudit.create({
    data: {
      id: randomUUID(), policyId: policy.id, action: "retired", statusBefore: "active", statusAfter: "retired",
      offerVersion: policy.offerVersion, amount: policy.amount, validForDays: policy.validForDays,
      eligibilityKey: policy.eligibilityKey, reasonRecorded: true, reason: "negative-case setup",
      actorId, transactionId, createdAt: retiredAt,
    },
  });
}

async function activateDraftForNegativeCase(
  tx: Prisma.TransactionClient,
  active: Readonly<{ id: string; offerVersion: string; amount: number; validForDays: number; eligibilityKey: string }>,
  draft: Readonly<{ id: string; offerVersion: string; amount: number; validForDays: number; eligibilityKey: string }>,
  actorId: string,
  transactionId: string,
): Promise<Date> {
  await retireActiveForNegativeCase(tx, active, actorId, transactionId);
  const activatedAt = new Date();
  await tx.platformGrantOfferPolicy.update({
    where: { id: draft.id },
    data: { status: "active", activatedById: actorId, activatedAt, updatedById: actorId, updatedAt: activatedAt },
  });
  await tx.platformGrantOfferPolicyAudit.create({
    data: {
      id: randomUUID(), policyId: draft.id, action: "activated", statusBefore: "draft", statusAfter: "active",
      offerVersion: draft.offerVersion, amount: draft.amount, validForDays: draft.validForDays,
      eligibilityKey: draft.eligibilityKey, reasonRecorded: true, reason: "negative-case setup",
      actorId, transactionId, createdAt: activatedAt,
    },
  });
  return activatedAt;
}

test("versioned signup offer policy bootstraps, rotates atomically, and fails closed", {
  skip: !shouldRun ? "PLATFORM_GRANT_OFFER_POLICY_POSTGRES_GATE=1 is required" : false,
}, async () => {
  const db = getDb();
  const suffix = randomUUID().slice(0, 8);
  const bootstrap = await initializeAdmin({ username: `policy_admin_${suffix}`, password: "PolicyGatePassword_2026" }, db);
  const actor: PlatformGrantOfferPolicyActor = bootstrap.user;

  assert.equal(await db.platformTokenGrant.count({ where: { userId: actor.id } }), 1);
  assert.equal(await db.platformTokenLedgerEntry.count({ where: { userId: actor.id } }), 1);
  assert.equal(await db.accountEntitlementActivation.count({ where: { userId: actor.id } }), 1);

  await runLegacyPreflightCase(db, {
    offerVersion: "legacy-draft-v1",
    status: "draft",
    amount: 500_000,
    validForDays: 30,
    eligibilityKey: PLATFORM_GRANT_OFFER_ELIGIBILITY_KEY,
  });
  for (const legacy of [
    { offerVersion: "legacy-active-v1", status: "active" as const, amount: 500_000, validForDays: 30, eligibilityKey: PLATFORM_GRANT_OFFER_ELIGIBILITY_KEY },
    { offerVersion: "legacy-retired-v1", status: "retired" as const, amount: 500_000, validForDays: 30, eligibilityKey: PLATFORM_GRANT_OFFER_ELIGIBILITY_KEY },
    { offerVersion: "legacy-invalid-v1", status: "draft" as const, amount: 0, validForDays: 30, eligibilityKey: PLATFORM_GRANT_OFFER_ELIGIBILITY_KEY },
  ]) {
    await assert.rejects(
      () => runLegacyPreflightCase(db, legacy),
      (error: unknown) => error instanceof Error && error.message.includes("PLATFORM_GRANT_OFFER_POLICY_LEGACY_RECONCILIATION_REQUIRED"),
    );
  }

  const initial = await listPlatformGrantOfferPolicies(actor, db);
  assert.equal(initial.length, 1);
  assert.equal(initial[0]?.offerVersion, "signup-500k-v1");
  assert.equal(initial[0]?.status, "active");
  assert.equal(initial[0]?.amount, 500_000);
  assert.equal(initial[0]?.validForDays, 30);
  assert.equal(initial[0]?.eligibilityKey, PLATFORM_GRANT_OFFER_ELIGIBILITY_KEY);
  assert.equal(initial[0]?.audits.length, 1);
  assert.equal(initial[0]?.audits[0]?.action, "created");
  assert.equal((await listPlatformGrantOfferPolicies(actor, db))[0]?.audits[0]?.statusAfter, "active");

  const draft = await createPlatformGrantOfferPolicy({
    offerVersion: "signup-600k-v2",
    amount: 600_000,
    validForDays: 45,
    reason: "rotate verified signup offer",
  }, actor, db);
  assert.equal(draft.status, "draft");
  assert.equal(draft.activatedAt, null);

  const otherActor = await db.appUser.create({ data: { id: randomUUID(), username: `policy_other_${suffix}`, role: "admin" } });

  await assert.rejects(
    () => db.$transaction(async (tx) => {
      const transactionId = randomUUID();
      const createdAt = new Date();
      await tx.$executeRaw`SELECT set_config('app.platform_grant_offer_policy_context', 'service-v1', true)`;
      await tx.$executeRaw`SELECT set_config('app.platform_grant_offer_policy_transaction_id', ${transactionId}, true)`;
      await tx.platformGrantOfferPolicy.create({
        data: {
          id: randomUUID(), offerVersion: "negative-created-by-v1", status: "draft", amount: 500_000,
          validForDays: 30, eligibilityKey: PLATFORM_GRANT_OFFER_ELIGIBILITY_KEY,
          createdById: actor.id, updatedById: otherActor.id, createdAt, updatedAt: createdAt,
          activatedById: null, activatedAt: null, retiredById: null, retiredAt: null,
        },
      });
    }),
    (error: unknown) => error instanceof Error && /creation metadata|check_violation/u.test(error.message),
  );

  await assert.rejects(
    () => db.$transaction(async (tx) => {
      const transactionId = randomUUID();
      const createdAt = new Date();
      const updatedAt = new Date(createdAt.getTime() + 1);
      await tx.$executeRaw`SELECT set_config('app.platform_grant_offer_policy_context', 'service-v1', true)`;
      await tx.$executeRaw`SELECT set_config('app.platform_grant_offer_policy_transaction_id', ${transactionId}, true)`;
      await tx.platformGrantOfferPolicy.create({
        data: {
          id: randomUUID(), offerVersion: "negative-created-at-v1", status: "draft", amount: 500_000,
          validForDays: 30, eligibilityKey: PLATFORM_GRANT_OFFER_ELIGIBILITY_KEY,
          createdById: actor.id, updatedById: actor.id, createdAt, updatedAt,
          activatedById: null, activatedAt: null, retiredById: null, retiredAt: null,
        },
      });
    }),
    (error: unknown) => error instanceof Error && /creation metadata|check_violation/u.test(error.message),
  );

  await assert.rejects(
    () => db.$transaction(async (tx) => {
      const transactionId = randomUUID();
      const createdAt = new Date();
      await tx.$executeRaw`SELECT set_config('app.platform_grant_offer_policy_context', 'service-v1', true)`;
      await tx.$executeRaw`SELECT set_config('app.platform_grant_offer_policy_transaction_id', ${transactionId}, true)`;
      await tx.platformGrantOfferPolicy.create({
        data: {
          id: randomUUID(), offerVersion: "negative-active-actor-v1", status: "active", amount: 500_000,
          validForDays: 30, eligibilityKey: PLATFORM_GRANT_OFFER_ELIGIBILITY_KEY,
          createdById: actor.id, updatedById: actor.id, createdAt, updatedAt: createdAt,
          activatedById: otherActor.id, activatedAt: createdAt, retiredById: null, retiredAt: null,
        },
      });
    }),
    (error: unknown) => error instanceof Error && /creation metadata|check_violation/u.test(error.message),
  );

  await assert.rejects(
    () => db.$transaction(async (tx) => {
      const transactionId = randomUUID();
      const createdAt = new Date();
      const activatedAt = new Date(createdAt.getTime() + 1);
      await tx.$executeRaw`SELECT set_config('app.platform_grant_offer_policy_context', 'service-v1', true)`;
      await tx.$executeRaw`SELECT set_config('app.platform_grant_offer_policy_transaction_id', ${transactionId}, true)`;
      await tx.platformGrantOfferPolicy.create({
        data: {
          id: randomUUID(), offerVersion: "negative-active-time-v1", status: "active", amount: 500_000,
          validForDays: 30, eligibilityKey: PLATFORM_GRANT_OFFER_ELIGIBILITY_KEY,
          createdById: actor.id, updatedById: actor.id, createdAt, updatedAt: createdAt,
          activatedById: actor.id, activatedAt, retiredById: null, retiredAt: null,
        },
      });
    }),
    (error: unknown) => error instanceof Error && /creation metadata|check_violation/u.test(error.message),
  );

  const guardedDraftUpdate = randomUUID();
  await assert.rejects(
    () => db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.platform_grant_offer_policy_context', 'service-v1', true)`;
      await tx.$executeRaw`SELECT set_config('app.platform_grant_offer_policy_transaction_id', ${guardedDraftUpdate}, true)`;
      await tx.platformGrantOfferPolicy.update({ where: { id: draft.id }, data: { amount: draft.amount + 1, updatedAt: new Date(), updatedById: actor.id } });
    }),
    (error: unknown) => error instanceof Error && /identity and terms are immutable|invalid/u.test(error.message),
  );

  await assert.rejects(
    () => db.$transaction(async (tx) => {
      const transactionId = randomUUID();
      const transitionAt = new Date();
      await tx.$executeRaw`SELECT set_config('app.platform_grant_offer_policy_context', 'service-v1', true)`;
      await tx.$executeRaw`SELECT set_config('app.platform_grant_offer_policy_transaction_id', ${transactionId}, true)`;
      await retireActiveForNegativeCase(tx, initial[0]!, actor.id, transactionId);
      await tx.platformGrantOfferPolicy.update({
        where: { id: draft.id },
        data: { status: "active", activatedById: actor.id, activatedAt: transitionAt, updatedById: otherActor.id, updatedAt: transitionAt },
      });
    }),
    (error: unknown) => error instanceof Error && /activation metadata|check_violation/u.test(error.message),
  );

  await assert.rejects(
    () => db.$transaction(async (tx) => {
      const transactionId = randomUUID();
      const activatedAt = new Date();
      const updatedAt = new Date(activatedAt.getTime() + 1);
      await tx.$executeRaw`SELECT set_config('app.platform_grant_offer_policy_context', 'service-v1', true)`;
      await tx.$executeRaw`SELECT set_config('app.platform_grant_offer_policy_transaction_id', ${transactionId}, true)`;
      await retireActiveForNegativeCase(tx, initial[0]!, actor.id, transactionId);
      await tx.platformGrantOfferPolicy.update({
        where: { id: draft.id },
        data: { status: "active", activatedById: actor.id, activatedAt, updatedById: actor.id, updatedAt },
      });
    }),
    (error: unknown) => error instanceof Error && /activation metadata|check_violation/u.test(error.message),
  );

  await assert.rejects(
    () => db.$transaction(async (tx) => {
      const transactionId = randomUUID();
      await tx.$executeRaw`SELECT set_config('app.platform_grant_offer_policy_context', 'service-v1', true)`;
      await tx.$executeRaw`SELECT set_config('app.platform_grant_offer_policy_transaction_id', ${transactionId}, true)`;
      const activatedAt = await activateDraftForNegativeCase(tx, initial[0]!, draft, actor.id, transactionId);
      const retiredAt = new Date();
      await tx.platformGrantOfferPolicy.update({
        where: { id: draft.id },
        data: { status: "retired", activatedById: otherActor.id, activatedAt, retiredById: actor.id, retiredAt, updatedById: actor.id, updatedAt: retiredAt },
      });
    }),
    (error: unknown) => error instanceof Error && /retirement metadata|check_violation/u.test(error.message),
  );

  await assert.rejects(
    () => db.$transaction(async (tx) => {
      const transactionId = randomUUID();
      await tx.$executeRaw`SELECT set_config('app.platform_grant_offer_policy_context', 'service-v1', true)`;
      await tx.$executeRaw`SELECT set_config('app.platform_grant_offer_policy_transaction_id', ${transactionId}, true)`;
      const activatedAt = await activateDraftForNegativeCase(tx, initial[0]!, draft, actor.id, transactionId);
      const retiredAt = new Date();
      await tx.platformGrantOfferPolicy.update({
        where: { id: draft.id },
        data: { status: "retired", activatedById: actor.id, activatedAt: new Date(activatedAt.getTime() + 1), retiredById: actor.id, retiredAt, updatedById: actor.id, updatedAt: retiredAt },
      });
    }),
    (error: unknown) => error instanceof Error && /retirement metadata|check_violation/u.test(error.message),
  );

  await assert.rejects(
    () => db.$transaction(async (tx) => {
      const transactionId = randomUUID();
      await tx.$executeRaw`SELECT set_config('app.platform_grant_offer_policy_context', 'service-v1', true)`;
      await tx.$executeRaw`SELECT set_config('app.platform_grant_offer_policy_transaction_id', ${transactionId}, true)`;
      const activatedAt = await activateDraftForNegativeCase(tx, initial[0]!, draft, actor.id, transactionId);
      const retiredAt = new Date();
      await tx.platformGrantOfferPolicy.update({
        where: { id: draft.id },
        data: { status: "retired", activatedById: actor.id, activatedAt, retiredById: actor.id, retiredAt, updatedById: actor.id, updatedAt: retiredAt },
      });
      await tx.platformGrantOfferPolicyAudit.create({
        data: {
          id: randomUUID(), policyId: draft.id, action: "retired", statusBefore: "active", statusAfter: "retired",
          offerVersion: draft.offerVersion, amount: draft.amount, validForDays: draft.validForDays,
          eligibilityKey: draft.eligibilityKey, reasonRecorded: false, reason: null,
          actorId: actor.id, transactionId, createdAt: retiredAt,
        },
      });
    }),
    (error: unknown) => error instanceof Error && /reason|snapshot|check_violation/u.test(error.message),
  );

  await assert.rejects(
    () => db.$transaction(async (tx) => {
      const transactionId = randomUUID();
      const transitionAt = new Date();
      await tx.$executeRaw`SELECT set_config('app.platform_grant_offer_policy_context', 'service-v1', true)`;
      await tx.$executeRaw`SELECT set_config('app.platform_grant_offer_policy_transaction_id', ${transactionId}, true)`;
      await retireActiveForNegativeCase(tx, initial[0]!, actor.id, transactionId);
      await tx.platformGrantOfferPolicy.update({ where: { id: draft.id }, data: { status: "active", activatedById: actor.id, activatedAt: transitionAt, updatedById: actor.id, updatedAt: transitionAt } });
      await tx.platformGrantOfferPolicyAudit.create({ data: {
        id: randomUUID(), policyId: draft.id, action: "created", statusBefore: null, statusAfter: "active",
        offerVersion: draft.offerVersion, amount: draft.amount, validForDays: draft.validForDays,
        eligibilityKey: PLATFORM_GRANT_OFFER_ELIGIBILITY_KEY, reasonRecorded: true, reason: "forged action",
        actorId: actor.id, transactionId, createdAt: transitionAt,
      } });
    }),
    (error: unknown) => error instanceof Error && /snapshot|check_violation|transition/u.test(error.message),
  );

  await assert.rejects(
    () => db.$transaction(async (tx) => {
      const transactionId = randomUUID();
      const transitionAt = new Date();
      await tx.$executeRaw`SELECT set_config('app.platform_grant_offer_policy_context', 'service-v1', true)`;
      await tx.$executeRaw`SELECT set_config('app.platform_grant_offer_policy_transaction_id', ${transactionId}, true)`;
      await retireActiveForNegativeCase(tx, initial[0]!, actor.id, transactionId);
      await tx.platformGrantOfferPolicy.update({ where: { id: draft.id }, data: { status: "active", activatedById: actor.id, activatedAt: transitionAt, updatedById: actor.id, updatedAt: transitionAt } });
      await tx.platformGrantOfferPolicyAudit.create({ data: {
        id: randomUUID(), policyId: draft.id, action: "activated", statusBefore: "draft", statusAfter: "active",
        offerVersion: draft.offerVersion, amount: draft.amount, validForDays: draft.validForDays,
        eligibilityKey: PLATFORM_GRANT_OFFER_ELIGIBILITY_KEY, reasonRecorded: true, reason: "wrong actor",
        actorId: otherActor.id, transactionId, createdAt: transitionAt,
      } });
    }),
    (error: unknown) => error instanceof Error && /snapshot|check_violation/u.test(error.message),
  );

  await assert.rejects(
    () => db.$transaction(async (tx) => {
      const transactionId = randomUUID();
      const transitionAt = new Date();
      const auditCreatedAt = new Date(transitionAt.getTime() + 1);
      await tx.$executeRaw`SELECT set_config('app.platform_grant_offer_policy_context', 'service-v1', true)`;
      await tx.$executeRaw`SELECT set_config('app.platform_grant_offer_policy_transaction_id', ${transactionId}, true)`;
      await retireActiveForNegativeCase(tx, initial[0]!, actor.id, transactionId);
      await tx.platformGrantOfferPolicy.update({ where: { id: draft.id }, data: { status: "active", activatedById: actor.id, activatedAt: transitionAt, updatedById: actor.id, updatedAt: transitionAt } });
      await tx.platformGrantOfferPolicyAudit.create({ data: {
        id: randomUUID(), policyId: draft.id, action: "activated", statusBefore: "draft", statusAfter: "active",
        offerVersion: draft.offerVersion, amount: draft.amount, validForDays: draft.validForDays,
        eligibilityKey: PLATFORM_GRANT_OFFER_ELIGIBILITY_KEY, reasonRecorded: true, reason: "wrong timestamp",
        actorId: actor.id, transactionId, createdAt: auditCreatedAt,
      } });
    }),
    (error: unknown) => error instanceof Error && /snapshot|check_violation/u.test(error.message),
  );

  await assert.rejects(
    () => db.$transaction(async (tx) => {
      const transactionId = randomUUID();
      const transitionAt = new Date();
      await tx.$executeRaw`SELECT set_config('app.platform_grant_offer_policy_context', 'service-v1', true)`;
      await tx.$executeRaw`SELECT set_config('app.platform_grant_offer_policy_transaction_id', ${transactionId}, true)`;
      await retireActiveForNegativeCase(tx, initial[0]!, actor.id, transactionId);
      await tx.platformGrantOfferPolicy.update({ where: { id: draft.id }, data: { status: "active", activatedById: actor.id, activatedAt: transitionAt, updatedById: actor.id, updatedAt: transitionAt } });
      await tx.platformGrantOfferPolicyAudit.create({ data: {
        id: randomUUID(), policyId: draft.id, action: "activated", statusBefore: "draft", statusAfter: "active",
        offerVersion: draft.offerVersion, amount: draft.amount + 1, validForDays: draft.validForDays,
        eligibilityKey: PLATFORM_GRANT_OFFER_ELIGIBILITY_KEY, reasonRecorded: true, reason: "wrong snapshot",
        actorId: actor.id, transactionId, createdAt: transitionAt,
      } });
    }),
    (error: unknown) => error instanceof Error && /snapshot|check_violation/u.test(error.message),
  );

  await assert.rejects(
    () => db.$transaction(async (tx) => {
      const transitionAt = new Date();
      const transactionId = randomUUID();
      await tx.$executeRaw`SELECT set_config('app.platform_grant_offer_policy_context', 'service-v1', true)`;
      await tx.$executeRaw`SELECT set_config('app.platform_grant_offer_policy_transaction_id', ${transactionId}, true)`;
      await retireActiveForNegativeCase(tx, initial[0]!, actor.id, transactionId);
      await tx.platformGrantOfferPolicy.update({ where: { id: draft.id }, data: { status: "active", activatedById: actor.id, activatedAt: transitionAt, updatedById: actor.id, updatedAt: transitionAt } });
    }),
    (error: unknown) => error instanceof Error && /paired audit|check_violation/u.test(error.message),
  );

  await assert.rejects(
    () => db.$transaction(async (tx) => {
      const policy = await tx.platformGrantOfferPolicy.findUniqueOrThrow({ where: { id: draft.id }, select: { offerVersion: true, amount: true, validForDays: true, eligibilityKey: true } });
      const transactionId = randomUUID();
      await tx.$executeRaw`SELECT set_config('app.platform_grant_offer_policy_context', 'service-v1', true)`;
      await tx.$executeRaw`SELECT set_config('app.platform_grant_offer_policy_transaction_id', ${transactionId}, true)`;
      await tx.platformGrantOfferPolicyAudit.create({ data: {
        id: randomUUID(), policyId: draft.id, action: "activated", statusBefore: "draft", statusAfter: "active",
        offerVersion: policy.offerVersion, amount: policy.amount, validForDays: policy.validForDays,
        eligibilityKey: policy.eligibilityKey, reasonRecorded: true, reason: "standalone audit",
        actorId: actor.id, transactionId, createdAt: new Date(),
      } });
    }),
    (error: unknown) => error instanceof Error && /not bound|check_violation/u.test(error.message),
  );

  await assert.rejects(
    () => db.$transaction(async (tx) => {
      const policy = await tx.platformGrantOfferPolicy.findUniqueOrThrow({ where: { id: draft.id }, select: { offerVersion: true, amount: true, validForDays: true, eligibilityKey: true } });
      await tx.$executeRaw`SELECT set_config('app.platform_grant_offer_policy_context', 'service-v1', true)`;
      await tx.$executeRaw`SELECT set_config('app.platform_grant_offer_policy_transaction_id', ${randomUUID()}, true)`;
      await tx.platformGrantOfferPolicy.create({ data: {
        id: randomUUID(), offerVersion: "forged-retired-policy", status: "retired", amount: policy.amount,
        validForDays: policy.validForDays, eligibilityKey: policy.eligibilityKey, createdById: actor.id,
        updatedById: actor.id, activatedById: actor.id, activatedAt: new Date(), retiredById: actor.id, retiredAt: new Date(),
        createdAt: new Date(), updatedAt: new Date(),
      } });
    }),
    (error: unknown) => error instanceof Error && /invalid platform grant offer policy transition/u.test(error.message),
  );

  const active = await changePlatformGrantOfferPolicyLifecycle(draft.id, {
    action: "activate",
    expectedUpdatedAt: draft.updatedAt.toISOString(),
    reason: "activate reviewed signup offer",
  }, actor, db);
  assert.equal(active.status, "active");
  assert.equal(active.offerVersion, "signup-600k-v2");

  const policies = await listPlatformGrantOfferPolicies(actor, db);
  assert.equal(policies.filter((policy) => policy.status === "active").length, 1);
  assert.equal(policies.find((policy) => policy.offerVersion === "signup-500k-v1")?.status, "retired");
  assert.equal(policies.find((policy) => policy.offerVersion === "signup-600k-v2")?.audits.some((audit) => audit.action === "activated"), true);

  const eligibleUser = await db.appUser.create({ data: { id: randomUUID(), username: `policy_user_${suffix}`, role: "user" } });
  const grant = await activateCanonicalSignupGrant(db, { userId: eligibleUser.id, actorId: actor.id, now: new Date("2026-09-10T00:00:00.000Z") });
  assert.equal(grant.amount, 600_000);
  assert.equal(grant.offerVersion, "signup-600k-v2");
  assert.equal(grant.offerAmount, 600_000);
  assert.equal(grant.offerValidForDays, 45);
  assert.equal(grant.eligibilityKey, PLATFORM_GRANT_OFFER_ELIGIBILITY_KEY);
  assert.equal(grant.eligibilitySource, "githubRegistration");
  assert.equal(grant.expiresAt.getTime(), new Date("2026-09-10T00:00:00.000Z").getTime() + 45 * 86_400_000);
  assert.equal(await db.platformTokenLedgerEntry.count({ where: { idempotencyKey: `grant:signup:${eligibleUser.id}:signup-600k-v2` } }), 1);

  await assert.rejects(
    () => changePlatformGrantOfferPolicyLifecycle(active.id, { action: "activate", expectedUpdatedAt: active.updatedAt.toISOString(), reason: "invalid" }, actor, db),
    (error: unknown) => error instanceof Error && error.message === "PLATFORM_GRANT_OFFER_POLICY_INVALID_TRANSITION",
  );
  await assert.rejects(
    () => db.platformGrantOfferPolicy.update({ where: { id: active.id }, data: { amount: 1 } }),
    (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError || error instanceof Error,
  );
  await assert.rejects(
    () => db.platformGrantOfferPolicy.delete({ where: { id: active.id } }),
    (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError || error instanceof Error,
  );
  await assert.rejects(
    () => db.platformGrantOfferPolicyAudit.deleteMany({ where: { policyId: active.id } }),
    (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError || error instanceof Error,
  );

  const retired = await changePlatformGrantOfferPolicyLifecycle(active.id, {
    action: "retire",
    expectedUpdatedAt: active.updatedAt.toISOString(),
    reason: "temporarily retire offer",
  }, actor, db);
  assert.equal(retired.status, "retired");
  const noActiveUser = await db.appUser.create({ data: { id: randomUUID(), username: `policy_no_active_${suffix}`, role: "user" } });
  const noActiveActivation = await activateAccountEntitlements({
    userId: noActiveUser.id,
    source: "oidcRegistration",
    actorId: actor.id,
    actorAccountAccessVersion: actor.accountAccessVersion,
    accountAccessVersion: noActiveUser.accountAccessVersion,
    evidenceKind: "oidc",
    evidenceRef: `no-active:${noActiveUser.id}`,
  }, db);
  assert.equal(noActiveActivation.decision, "no_active_offer");
  assert.equal(await db.platformTokenGrant.count({ where: { userId: noActiveUser.id, kind: "signup" } }), 0);
});
