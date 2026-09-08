import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Prisma } from "@prisma/client";
import { createSession, readSessionToken } from "../src/lib/auth";
import { AccountAccessGuardError, assertAccountAccessForActor } from "../src/lib/account-access-guard";
import { getDb } from "../src/lib/db";
import {
  AccountAccessServiceError,
  executeAccountAccess,
  listAccountAccess,
  previewAccountAccess,
  type AccountAccessPreview,
} from "../src/lib/account-access-service";

const shouldRun = process.env.ACCOUNT_ACCESS_POSTGRES_GATE === "1";
const testDatabaseName = "ai_project_os_account_access_lifecycle_test";
const gateUser = "ai_project_os_gate";

function assertDisposableGateDatabase(): void {
  const configuredUrl = process.env.DATABASE_URL;
  if (typeof configuredUrl !== "string" || configuredUrl.length === 0) throw new Error("ACCOUNT_ACCESS_TEST_DATABASE_URL_REQUIRED");
  const parsed = new URL(configuredUrl);
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol)
    || !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname.toLowerCase())
    || parsed.port !== "56432"
    || parsed.pathname !== `/${testDatabaseName}`
    || parsed.username !== gateUser
    || parsed.password.length === 0
    || parsed.search !== ""
    || parsed.hash !== ""
  ) throw new Error("ACCOUNT_ACCESS_TEST_DATABASE_URL_INVALID");
}

function serviceCode(error: unknown): string | null {
  return error instanceof AccountAccessServiceError ? error.code : null;
}

function executeInput(preview: AccountAccessPreview, input: Readonly<{ adminUserId: string; adminAccountAccessVersion: number; reason: string; requestKey: string }>) {
  return {
    adminUserId: input.adminUserId,
    adminAccountAccessVersion: input.adminAccountAccessVersion,
    userId: preview.user.id,
    action: preview.action,
    reason: input.reason,
    expectedVersion: preview.current.accountAccessVersion,
    expectedImpactFingerprint: preview.impactFingerprint,
    requestKey: input.requestKey,
    requestFingerprint: preview.requestFingerprint,
    previewId: preview.previewId,
    previewIssuedAt: preview.previewIssuedAt,
    previewExpiresAt: preview.previewExpiresAt,
    confirmation: true as const,
    confirmationUsername: preview.user.username,
  };
}

test("account access is epoch-bound, preview-confirmed, idempotent and append-only in PostgreSQL", {
  skip: !shouldRun ? "ACCOUNT_ACCESS_POSTGRES_GATE=1 is required" : false,
}, async () => {
  assertDisposableGateDatabase();
  const db = getDb();
  const suffix = randomUUID().slice(0, 8);
  const adminId = randomUUID();
  const secondAdminId = randomUUID();
  const targetId = randomUUID();
  const targetUsername = `account_access_target_${suffix}`;
  await db.appUser.createMany({
    data: [
      { id: adminId, username: `account_access_admin_${suffix}`, role: "admin" },
      { id: secondAdminId, username: `account_access_admin_two_${suffix}`, role: "admin" },
      { id: targetId, username: targetUsername, role: "user" },
    ],
  });

  const target = await db.appUser.findUniqueOrThrow({ where: { id: targetId } });
  const targetSession = await createSession(db, target);
  assert.ok(await readSessionToken(targetSession.token, db));
  const adminAccountAccessVersion = 1;

  const disableReason = "security policy review";
  const disablePreview = await previewAccountAccess({ adminUserId: adminId, adminAccountAccessVersion, userId: targetId, action: "disable", reason: disableReason, expectedVersion: 1 }, db);
  assert.equal(disablePreview.current.accountAccessVersion, 1);
  assert.equal(disablePreview.current.sessionCount, 1);
  assert.equal(disablePreview.target.accountAccessVersion, 2);
  assert.equal(disablePreview.canExecute, true);
  const disableInput = executeInput(disablePreview, { adminUserId: adminId, adminAccountAccessVersion, reason: disableReason, requestKey: `acct-disable-${suffix}` });
  await assert.rejects(
    () => executeAccountAccess({ ...disableInput, adminAccountAccessVersion: 2 }, db),
    (error: unknown) => serviceCode(error) === "ACCOUNT_ACCESS_ADMIN_STALE",
  );
  const disabled = await executeAccountAccess(disableInput, db);
  assert.equal(disabled.state, "disabled");
  assert.equal(disabled.accountAccessVersion, 2);
  assert.equal(disabled.revokedSessionCount, 1);
  assert.equal(await readSessionToken(targetSession.token, db), null);
  assert.equal((await db.appUser.findUniqueOrThrow({ where: { id: targetId } })).accountAccessVersion, 2);

  const replay = await executeAccountAccess(disableInput, db);
  assert.equal(replay.replayed, true);
  assert.equal(replay.accountAccessVersion, 2);

  const restoreReason = "identity review completed";
  const restorePreview = await previewAccountAccess({ adminUserId: adminId, adminAccountAccessVersion, userId: targetId, action: "restore", reason: restoreReason, expectedVersion: 2 }, db);
  const restored = await executeAccountAccess(executeInput(restorePreview, { adminUserId: adminId, adminAccountAccessVersion, reason: restoreReason, requestKey: `acct-restore-${suffix}` }), db);
  assert.equal(restored.state, "enabled");
  assert.equal(restored.accountAccessVersion, 3);
  assert.equal(await readSessionToken(targetSession.token, db), null);

  const newSession = await createSession(db, await db.appUser.findUniqueOrThrow({ where: { id: targetId } }));
  assert.ok(await readSessionToken(newSession.token, db));
  await assert.rejects(
    () => assertAccountAccessForActor(db, { id: targetId, accountAccessVersion: 1 }),
    (error: unknown) => error instanceof AccountAccessGuardError && error.code === "ACCOUNT_ACCESS_STALE",
  );
  await assert.doesNotReject(() => assertAccountAccessForActor(db, { id: targetId, accountAccessVersion: 3 }));

  await assert.rejects(
    () => previewAccountAccess({ adminUserId: adminId, adminAccountAccessVersion, userId: adminId, action: "disable", reason: "self check", expectedVersion: 1 }, db),
    (error: unknown) => serviceCode(error) === "ACCOUNT_ACCESS_SELF_FORBIDDEN",
  );

  const stalePreview = await previewAccountAccess({ adminUserId: adminId, adminAccountAccessVersion, userId: targetId, action: "disable", reason: "stale check", expectedVersion: 3 }, db);
  const staleInput = executeInput(stalePreview, { adminUserId: adminId, adminAccountAccessVersion, reason: "stale check", requestKey: `acct-stale-${suffix}` });
  await executeAccountAccess(staleInput, db);
  await assert.rejects(
    () => executeAccountAccess({ ...staleInput, requestKey: `acct-stale-retry-${suffix}` }, db),
    (error: unknown) => serviceCode(error) === "ACCOUNT_ACCESS_PREVIEW_STALE",
  );

  await assert.rejects(
    () => previewAccountAccess({ adminUserId: adminId, adminAccountAccessVersion: 2, userId: targetId, action: "restore", reason: "stale admin session", expectedVersion: 4 }, db),
    (error: unknown) => serviceCode(error) === "ACCOUNT_ACCESS_ADMIN_STALE",
  );

  await assert.rejects(
    () => listAccountAccess({ adminUserId: adminId, adminAccountAccessVersion: 2 }, db),
    (error: unknown) => serviceCode(error) === "ACCOUNT_ACCESS_ADMIN_STALE",
  );

  const disableSecondAdminPreview = await previewAccountAccess({
    adminUserId: adminId,
    adminAccountAccessVersion,
    userId: secondAdminId,
    action: "disable",
    reason: "concurrent administrator review",
    expectedVersion: 1,
  }, db);
  const disableFirstAdminPreview = await previewAccountAccess({
    adminUserId: secondAdminId,
    adminAccountAccessVersion,
    userId: adminId,
    action: "disable",
    reason: "concurrent administrator review",
    expectedVersion: 1,
  }, db);
  const concurrentResults = await Promise.allSettled([
    executeAccountAccess(executeInput(disableSecondAdminPreview, {
      adminUserId: adminId,
      adminAccountAccessVersion,
      reason: "concurrent administrator review",
      requestKey: `acct-concurrent-a-${suffix}`,
    }), db),
    executeAccountAccess(executeInput(disableFirstAdminPreview, {
      adminUserId: secondAdminId,
      adminAccountAccessVersion,
      reason: "concurrent administrator review",
      requestKey: `acct-concurrent-b-${suffix}`,
    }), db),
  ]);
  assert.equal(concurrentResults.filter((result) => result.status === "fulfilled").length, 1);
  const administratorRows = await db.appUser.findMany({
    where: { role: "admin" },
    select: { id: true, disabledAt: true, accountAccessVersion: true },
  });
  const enabledAdministrators = administratorRows.filter((administrator) => administrator.disabledAt === null);
  assert.equal(enabledAdministrators.length, 1);

  const soleAdministrator = enabledAdministrators[0];
  assert.ok(soleAdministrator);
  await assert.rejects(
    () => previewAccountAccess({
      adminUserId: soleAdministrator.id,
      adminAccountAccessVersion: soleAdministrator.accountAccessVersion,
      userId: soleAdministrator.id,
      action: "disable",
      reason: "sole administrator self disable",
      expectedVersion: soleAdministrator.accountAccessVersion,
    }, db),
    (error: unknown) => serviceCode(error) === "ACCOUNT_ACCESS_SELF_FORBIDDEN",
  );

  const disabledAdministrator = administratorRows.find((administrator) => administrator.disabledAt !== null);
  assert.ok(disabledAdministrator);
  await assert.rejects(
    () => db.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.account_access_lifecycle_context', '1', true)`);
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.account_access_lifecycle_actor_id', ${disabledAdministrator.id}, true)`);
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.account_access_lifecycle_user_id', ${soleAdministrator.id}, true)`);
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.account_access_lifecycle_action', 'disable', true)`);
      await tx.$executeRaw(Prisma.sql`
        UPDATE "AppUser"
           SET "accountAccessVersion" = "accountAccessVersion" + 1,
               "disabledAt" = clock_timestamp(),
               "disabledReason" = 'direct transition bypass attempt',
               "disabledById" = ${disabledAdministrator.id}::uuid
         WHERE "id" = ${soleAdministrator.id}::uuid
      `);
    }),
    (error: unknown) => /at least one enabled system admin is required|check_violation|account access lifecycle/u.test(error instanceof Error ? error.message : ""),
  );

  await assert.rejects(
    () => db.appUser.update({ where: { id: targetId }, data: { disabledAt: null } }),
    (error: unknown) => /check_violation|account access lifecycle/u.test(error instanceof Error ? error.message : ""),
  );

  const audit = await db.accountAccessAudit.findFirstOrThrow({ where: { userId: targetId }, orderBy: { createdAt: "desc" } });
  await assert.rejects(
    () => db.accountAccessAudit.update({ where: { id: audit.id }, data: { reason: "tampered" } }),
    (error: unknown) => /check_violation|append-only/u.test(error instanceof Error ? error.message : ""),
  );
  await assert.rejects(
    () => db.accountAccessAudit.delete({ where: { id: audit.id } }),
    (error: unknown) => /check_violation|append-only/u.test(error instanceof Error ? error.message : ""),
  );

  const rawSessionId = randomUUID();
  await assert.rejects(
    () => db.appSession.create({ data: { id: rawSessionId, userId: targetId, accountAccessVersion: 3, tokenHash: "a".repeat(64), expiresAt: new Date(Date.now() + 60_000) } }),
    (error: unknown) => /check_violation|session requires/u.test(error instanceof Error ? error.message : ""),
  );

  assert.equal(await db.membershipSubscription.findUnique({ where: { userId: targetId } }), null);
  const sessionRows = await db.appSession.findMany({ where: { userId: targetId }, orderBy: { createdAt: "asc" } });
  assert.equal(sessionRows.length, 2);
  assert.equal(sessionRows[0]?.accountAccessVersion, 1);
  assert.equal(sessionRows[1]?.accountAccessVersion, 3);
});
