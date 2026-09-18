import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { getDb } from "../src/lib/db";
import {
  initializeAdmin,
  initializeFirstOwner,
} from "../src/lib/auth";
import {
  completeFirstAdminOnboarding,
  FirstAdminOnboardingError,
  getFirstAdminOnboardingState,
} from "../src/lib/first-admin-onboarding-service";

const enabled = process.env.FIRST_ADMIN_ONBOARDING_POSTGRES_GATE === "1";
const DEFAULT_WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const GATE_DATABASE_NAME = "ai_project_os_first_admin_onboarding_test";

function assertGateDatabaseUrl(): void {
  const configuredDatabaseUrl = process.env.DATABASE_URL;
  if (typeof configuredDatabaseUrl !== "string" || configuredDatabaseUrl.length === 0) {
    throw new Error("FIRST_ADMIN_ONBOARDING_DATABASE_URL_REQUIRED");
  }
  let databaseUrl: URL;
  try {
    databaseUrl = new URL(configuredDatabaseUrl);
  } catch {
    throw new Error("FIRST_ADMIN_ONBOARDING_DATABASE_URL_INVALID");
  }
  if (
    !["postgres:", "postgresql:"].includes(databaseUrl.protocol)
    || !["localhost", "127.0.0.1", "[::1]"].includes(databaseUrl.hostname.toLowerCase())
    || databaseUrl.port !== "56432"
    || databaseUrl.pathname !== `/${GATE_DATABASE_NAME}`
    || databaseUrl.search !== ""
    || databaseUrl.hash !== ""
  ) throw new Error("FIRST_ADMIN_ONBOARDING_DATABASE_URL_INVALID");
}

test("first-admin onboarding creates a separate platform admin and ordinary owner", { skip: !enabled }, async () => {
  assertGateDatabaseUrl();
  const db = getDb();
  const adminBootstrap = await initializeAdmin({
    username: "postgres_gate_admin",
    password: "PostgresGateAdminPassword_2026",
  }, db);
  const admin = adminBootstrap.user;

  assert.equal(admin.role, "admin");
  assert.equal(await db.workspaceMembership.count(), 0);
  assert.equal(await db.projectMembership.count(), 0);
  assert.equal(await db.platformTokenGrant.count({ where: { userId: admin.id } }), 0);
  assert.equal(await db.platformTokenLedgerEntry.count({ where: { userId: admin.id } }), 0);
  assert.equal(await db.accountEntitlementActivation.count({ where: { userId: admin.id } }), 0);
  assert.equal(await getFirstAdminOnboardingState(admin.id, db), "pending");
  const pendingBootstrap = await db.platformBootstrap.findUniqueOrThrow({
    where: { id: "platform" },
    select: { initialAdminUserId: true, initialOwnerUserId: true, adminOnboardingCompletedAt: true },
  });
  assert.deepEqual(pendingBootstrap, {
    initialAdminUserId: admin.id,
    initialOwnerUserId: null,
    adminOnboardingCompletedAt: null,
  });
  assert.equal(
    (await db.workspace.findUniqueOrThrow({ where: { id: DEFAULT_WORKSPACE_ID }, select: { createdById: true } })).createdById,
    null,
  );

  // Force a deterministic failure at the final bootstrap state transition.
  // The trigger is installed only in this disposable gate database, then
  // removed before the successful onboarding race below.  This proves that
  // all earlier owner, membership, workspace, and entitlement writes share
  // the same transaction as PlatformBootstrap completion.
  const rollbackTriggerSuffix = randomUUID().replaceAll("-", "");
  const rollbackFunction = `postgres_gate_owner_completion_failure_${rollbackTriggerSuffix}`;
  const rollbackTrigger = `postgres_gate_owner_completion_failure_trigger_${rollbackTriggerSuffix}`;
  const rollbackOwnerUsername = "postgres_gate_owner_rollback";
  const quoteIdentifier = (value: string): string => `"${value}"`;
  try {
    await db.$executeRawUnsafe(`
      CREATE FUNCTION public.${quoteIdentifier(rollbackFunction)}()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF OLD."initialOwnerUserId" IS NULL AND NEW."initialOwnerUserId" IS NOT NULL THEN
          RAISE EXCEPTION 'POSTGRES_GATE_INITIAL_OWNER_COMPLETION_FAILURE' USING ERRCODE = 'P0001';
        END IF;
        RETURN NEW;
      END;
      $$;
    `);
    await db.$executeRawUnsafe(`
      CREATE TRIGGER ${quoteIdentifier(rollbackTrigger)}
      BEFORE UPDATE OF "initialOwnerUserId" ON "PlatformBootstrap"
      FOR EACH ROW EXECUTE FUNCTION public.${quoteIdentifier(rollbackFunction)}();
    `);

    const entitlementActivationCount = await db.accountEntitlementActivation.count();
    const tokenGrantCount = await db.platformTokenGrant.count();
    const tokenLedgerCount = await db.platformTokenLedgerEntry.count();
    await assert.rejects(
      () => initializeFirstOwner(admin, { username: rollbackOwnerUsername, password: "PostgresGateRollbackPassword_2026" }, db),
      (error: unknown) => error instanceof Error && error.message.includes("POSTGRES_GATE_INITIAL_OWNER_COMPLETION_FAILURE"),
    );
    assert.equal(await db.appUser.count({ where: { username: rollbackOwnerUsername } }), 0);
    assert.equal(await db.workspaceMembership.count({ where: { workspaceId: DEFAULT_WORKSPACE_ID } }), 0);
    assert.equal(
      (await db.workspace.findUniqueOrThrow({ where: { id: DEFAULT_WORKSPACE_ID }, select: { createdById: true } })).createdById,
      null,
    );
    assert.equal(await db.accountEntitlementActivation.count(), entitlementActivationCount);
    assert.equal(await db.platformTokenGrant.count(), tokenGrantCount);
    assert.equal(await db.platformTokenLedgerEntry.count(), tokenLedgerCount);
    assert.deepEqual(
      await db.platformBootstrap.findUniqueOrThrow({
        where: { id: "platform" },
        select: { initialOwnerUserId: true, initialOwnerCreatedAt: true, adminOnboardingCompletedAt: true },
      }),
      { initialOwnerUserId: null, initialOwnerCreatedAt: null, adminOnboardingCompletedAt: null },
    );
  } finally {
    await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${quoteIdentifier(rollbackTrigger)} ON "PlatformBootstrap"`);
    await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS public.${quoteIdentifier(rollbackFunction)}()`);
  }

  await assert.rejects(
    () => completeFirstAdminOnboarding({ ...admin, accountAccessVersion: admin.accountAccessVersion + 1 }, db),
    (error: unknown) => error instanceof FirstAdminOnboardingError && error.code === "FIRST_ADMIN_ONBOARDING_ACCOUNT_STALE",
  );

  const ownerResults = await Promise.allSettled([
    initializeFirstOwner(admin, { username: "postgres_gate_owner_a", password: "PostgresGateOwnerPassword_2026" }, db),
    initializeFirstOwner(admin, { username: "postgres_gate_owner_b", password: "PostgresGateOwnerPassword_2026" }, db),
  ]);
  assert.equal(ownerResults.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(ownerResults.filter((result) => result.status === "rejected").length, 1);

  const ownerResult = ownerResults.find((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof initializeFirstOwner>>> => result.status === "fulfilled");
  assert.ok(ownerResult);
  const owner = ownerResult.value.user;
  assert.equal(owner.role, "user");
  assert.equal(await db.appUser.count({ where: { role: "user" } }), 1);
  assert.equal(await db.workspaceMembership.count({ where: { userId: admin.id } }), 0);
  assert.equal(await db.projectMembership.count({ where: { userId: admin.id } }), 0);
  assert.equal(await db.platformTokenGrant.count({ where: { userId: admin.id } }), 0);
  assert.equal(await db.accountEntitlementActivation.count({ where: { userId: admin.id } }), 0);
  assert.equal(await db.workspaceMembership.count({ where: { userId: owner.id, role: "owner", accessState: "confirmed" } }), 1);
  assert.equal(await db.platformTokenGrant.count({ where: { userId: owner.id, kind: "signup" } }), 1);
  assert.equal(await db.platformTokenLedgerEntry.count({ where: { userId: owner.id, reasonCode: "AI_SIGNUP_GRANT" } }), 1);
  assert.equal(await db.accountEntitlementActivation.count({ where: { userId: owner.id, lifecycleKey: "initial_account_v1" } }), 1);
  assert.equal(
    (await db.workspace.findUniqueOrThrow({ where: { id: DEFAULT_WORKSPACE_ID }, select: { createdById: true } })).createdById,
    owner.id,
  );
  assert.equal(await getFirstAdminOnboardingState(admin.id, db), "completed");

  const completed = await completeFirstAdminOnboarding(admin, db);
  assert.equal(completed.completedAt.getTime(), ownerResult.value.createdAt.getTime());
  await assert.rejects(
    () => initializeFirstOwner(admin, { username: "postgres_gate_owner_duplicate", password: "PostgresGateOwnerPassword_2026" }, db),
    (error: unknown) => error instanceof Error && error.message === "AUTH_ALREADY_INITIALIZED",
  );
});
