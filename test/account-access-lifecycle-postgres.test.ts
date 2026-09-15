import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { MembershipAccessAuditAction, Prisma } from "@prisma/client";
import { createSession, readSessionToken } from "../src/lib/auth";
import { AccountAccessGuardError, assertAccountAccessForActor } from "../src/lib/account-access-guard";
import { appendProjectMembershipAudit, appendWorkspaceMembershipAudit, grantProjectMembership, grantWorkspaceMembership, revokeProjectMembership, revokeWorkspaceMembership } from "../src/lib/membership-governance";
import { getDb } from "../src/lib/db";
import {
  AccountAccessServiceError,
  executeAccountAccess,
  getEffectiveAccessMatrix,
  listAccountAccess,
  previewAccountAccess,
  type AccountAccessPreview,
} from "../src/lib/account-access-service";
import { createControlledMembership, revokeControlledMembershipInTransaction } from "./membership-fixture";

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

test("effective access matrix preserves independent role facts and disabled overlays in PostgreSQL", {
  skip: !shouldRun ? "ACCOUNT_ACCESS_POSTGRES_GATE=1 is required" : false,
}, async () => {
  assertDisposableGateDatabase();
  const db = getDb();
  const suffix = randomUUID().slice(0, 8);
  const adminId = randomUUID();
  const disabledAdminId = randomUUID();
  const orphanOwnerId = randomUUID();
  const subjectId = randomUUID();
  const futureId = randomUUID();
  const expiredId = randomUUID();
  const revokedId = randomUUID();
  const noneId = randomUUID();
  const now = new Date();
  await db.appUser.createMany({
    data: [
      { id: adminId, username: `matrix_admin_${suffix}`, role: "admin" },
      { id: disabledAdminId, username: `matrix_disabled_admin_${suffix}`, role: "admin" },
      { id: orphanOwnerId, username: `matrix_orphan_owner_${suffix}`, role: "user" },
      { id: subjectId, username: `matrix_subject_${suffix}`, role: "user" },
      { id: futureId, username: `matrix_future_${suffix}`, role: "user" },
      { id: expiredId, username: `matrix_expired_${suffix}`, role: "user" },
      { id: revokedId, username: `matrix_revoked_${suffix}`, role: "user" },
      { id: noneId, username: `matrix_none_${suffix}`, role: "user" },
    ],
  });
  await createControlledMembership(db, {
    adminId,
    userId: subjectId,
    startsAt: new Date(now.getTime() - 60_000),
    expiresAt: new Date(now.getTime() + 24 * 60 * 60_000),
    note: "matrix active fixture",
  });
  await createControlledMembership(db, {
    adminId,
    userId: futureId,
    startsAt: new Date(now.getTime() + 60 * 60_000),
    expiresAt: new Date(now.getTime() + 2 * 60 * 60_000),
    note: "matrix future fixture",
  });
  await createControlledMembership(db, {
    adminId,
    userId: expiredId,
    startsAt: new Date(now.getTime() - 2 * 60 * 60_000),
    expiresAt: new Date(now.getTime() - 60_000),
    note: "matrix expired fixture",
  });
  const revokedSubscription = await createControlledMembership(db, {
    adminId,
    userId: revokedId,
    startsAt: new Date(now.getTime() - 2 * 60 * 60_000),
    expiresAt: new Date(now.getTime() + 24 * 60 * 60_000),
    note: "matrix revoked fixture",
  });
  await db.$transaction((tx) => revokeControlledMembershipInTransaction(tx, {
    subscriptionId: revokedSubscription.id,
    adminId,
    reason: "matrix revoked fixture",
  }));

  const workspaceId = randomUUID();
  const pendingWorkspaceId = randomUUID();
  const revokedWorkspaceId = randomUUID();
  const inheritedProjectId = randomUUID();
  const directProjectId = randomUUID();
  const combinedProjectId = randomUUID();
  const pendingProjectId = randomUUID();
  const oldRevokedProjectId = randomUUID();
  const pendingInheritedProjectId = randomUUID();
  const memberWorkspaceId = randomUUID();
  const memberCombinedProjectId = randomUUID();
  const memberInheritedProjectId = randomUUID();
  const orphanWorkspaceId = randomUUID();
  const orphanProjectId = randomUUID();
  const revokedInheritedProjectId = randomUUID();
  const historyWorkspaceId = randomUUID();
  const historyProjectId = randomUUID();
  await db.$transaction(async (tx) => {
    await tx.workspace.createMany({
      data: [
        { id: workspaceId, name: `Matrix workspace ${suffix}`, slug: `matrix-workspace-${suffix}`, createdById: adminId },
        { id: pendingWorkspaceId, name: `Matrix pending ${suffix}`, slug: `matrix-pending-${suffix}`, createdById: adminId },
        { id: revokedWorkspaceId, name: `Matrix revoked ${suffix}`, slug: `matrix-revoked-${suffix}`, createdById: adminId },
        { id: historyWorkspaceId, name: `Matrix history ${suffix}`, slug: `matrix-history-${suffix}`, createdById: adminId },
      ],
    });
    await grantWorkspaceMembership(tx, { workspaceId, userId: adminId, role: "owner", actorId: adminId, reason: "matrix backup owner" });
    await grantWorkspaceMembership(tx, { workspaceId, userId: subjectId, role: "owner", actorId: adminId, reason: "matrix subject owner" });
    await grantWorkspaceMembership(tx, { workspaceId: pendingWorkspaceId, userId: adminId, role: "owner", actorId: adminId, reason: "matrix pending backup owner" });
    const pendingWorkspace = await tx.workspaceMembership.create({ data: { id: randomUUID(), workspaceId: pendingWorkspaceId, userId: subjectId, role: "member", accessState: "pending" } });
    await appendWorkspaceMembershipAudit(tx, pendingWorkspace, { action: MembershipAccessAuditAction.migrationQuarantined, previousState: null, actorId: adminId, reason: "matrix pending workspace" });
    await grantWorkspaceMembership(tx, { workspaceId: revokedWorkspaceId, userId: adminId, role: "owner", actorId: adminId, reason: "matrix revoked backup owner" });
    await grantWorkspaceMembership(tx, { workspaceId: revokedWorkspaceId, userId: subjectId, role: "viewer", actorId: adminId, reason: "matrix revoked workspace" });
    await grantWorkspaceMembership(tx, { workspaceId: historyWorkspaceId, userId: adminId, role: "owner", actorId: adminId, reason: "matrix history backup owner" });

    await tx.project.createMany({
      data: [
        { id: inheritedProjectId, workspaceId, name: `Matrix inherited ${suffix}`, slug: `matrix-inherited-${suffix}`, membershipInheritanceMode: "workspaceInherited" },
        { id: directProjectId, workspaceId, name: `Matrix direct ${suffix}`, slug: `matrix-direct-${suffix}`, membershipInheritanceMode: "projectOnly" },
        { id: combinedProjectId, workspaceId, name: `Matrix combined ${suffix}`, slug: `matrix-combined-${suffix}`, membershipInheritanceMode: "workspaceInherited" },
        { id: pendingProjectId, workspaceId, name: `Matrix pending project ${suffix}`, slug: `matrix-pending-project-${suffix}`, membershipInheritanceMode: "projectOnly" },
        { id: oldRevokedProjectId, workspaceId, name: `Matrix regrant ${suffix}`, slug: `matrix-regrant-${suffix}`, membershipInheritanceMode: "projectOnly" },
        { id: historyProjectId, workspaceId: historyWorkspaceId, name: `Matrix project history ${suffix}`, slug: `matrix-project-history-${suffix}`, membershipInheritanceMode: "projectOnly" },
      ],
    });
    await grantProjectMembership(tx, { projectId: directProjectId, workspaceId, userId: subjectId, role: "viewer", actorId: adminId, reason: "matrix direct viewer" });
    await grantProjectMembership(tx, { projectId: combinedProjectId, workspaceId, userId: subjectId, role: "viewer", actorId: adminId, reason: "matrix combined viewer" });
    const pendingProject = await tx.projectMembership.create({ data: { id: randomUUID(), projectId: pendingProjectId, userId: subjectId, role: "editor", accessState: "pending" } });
    await appendProjectMembershipAudit(tx, { ...pendingProject, workspaceId }, { action: MembershipAccessAuditAction.migrationQuarantined, previousState: null, actorId: adminId, reason: "matrix pending project" });
    await grantProjectMembership(tx, { projectId: oldRevokedProjectId, workspaceId, userId: subjectId, role: "viewer", actorId: adminId, reason: "matrix old direct viewer" });
  });
  for (let index = 0; index < 12; index += 1) {
    await db.$transaction((tx) => grantWorkspaceMembership(tx, { workspaceId: historyWorkspaceId, userId: subjectId, role: "viewer", actorId: adminId, reason: `matrix history workspace grant ${index}` }));
    await db.$transaction(async (tx) => {
      const revoked = await revokeWorkspaceMembership(tx, historyWorkspaceId, subjectId, { actorId: adminId, reason: `matrix history workspace revoke ${index}` });
      assert.ok(revoked);
    });
  }
  for (let index = 0; index < 12; index += 1) {
    await db.$transaction((tx) => grantProjectMembership(tx, { projectId: historyProjectId, workspaceId: historyWorkspaceId, userId: subjectId, role: "viewer", actorId: adminId, reason: `matrix history project grant ${index}` }));
    await db.$transaction(async (tx) => {
      const revoked = await revokeProjectMembership(tx, historyProjectId, subjectId, historyWorkspaceId, { actorId: adminId, reason: `matrix history project revoke ${index}` });
      assert.ok(revoked);
    });
  }
  await db.$transaction((tx) => revokeWorkspaceMembership(tx, revokedWorkspaceId, subjectId, { actorId: adminId, reason: "matrix revoked workspace" }));
  await db.$transaction((tx) => revokeProjectMembership(tx, oldRevokedProjectId, subjectId, workspaceId, { actorId: adminId, reason: "matrix old direct revoke" }));
  await db.$transaction((tx) => grantProjectMembership(tx, { projectId: oldRevokedProjectId, workspaceId, userId: subjectId, role: "editor", actorId: adminId, reason: "matrix direct regrant editor" }));

  const enabledMatrix = await getEffectiveAccessMatrix({
    adminUserId: adminId,
    adminAccountAccessVersion: 1,
    userId: subjectId,
    pageSize: 4,
  }, db);
  assert.ok(enabledMatrix.projects.nextCursor);
  const validProjectCursor = enabledMatrix.projects.nextCursor;
  const tamperedProjectCursor = `${validProjectCursor.slice(0, -1)}${validProjectCursor.endsWith("A") ? "B" : "A"}`;
  await assert.rejects(
    () => getEffectiveAccessMatrix({ adminUserId: adminId, adminAccountAccessVersion: 1, userId: subjectId, projectCursor: tamperedProjectCursor, pageSize: 4 }, db),
    (error: unknown) => serviceCode(error) === "ACCOUNT_ACCESS_INVALID_INPUT",
  );
  await assert.rejects(
    () => getEffectiveAccessMatrix({ adminUserId: adminId, adminAccountAccessVersion: 1, userId: futureId, projectCursor: validProjectCursor, pageSize: 4 }, db),
    (error: unknown) => serviceCode(error) === "ACCOUNT_ACCESS_INVALID_INPUT",
  );
  await assert.rejects(
    () => getEffectiveAccessMatrix({ adminUserId: adminId, adminAccountAccessVersion: 1, userId: subjectId, workspaceCursor: validProjectCursor, pageSize: 4 }, db),
    (error: unknown) => serviceCode(error) === "ACCOUNT_ACCESS_INVALID_INPUT",
  );
  await assert.rejects(
    () => getEffectiveAccessMatrix({ adminUserId: adminId, adminAccountAccessVersion: 1, userId: subjectId, projectCursor: validProjectCursor, pageSize: 3 }, db),
    (error: unknown) => serviceCode(error) === "ACCOUNT_ACCESS_INVALID_INPUT",
  );
  const enabledProjectContinuation = await getEffectiveAccessMatrix({
    adminUserId: adminId,
    adminAccountAccessVersion: 1,
    userId: subjectId,
    projectCursor: enabledMatrix.projects.nextCursor,
    pageSize: 4,
  }, db);
  assert.equal(enabledMatrix.system.role, "user");
  assert.equal(enabledMatrix.system.effective, true);
  assert.equal(enabledMatrix.commercial.tier, "member");
  assert.equal(enabledMatrix.commercial.entitlementEffective, true);
  assert.equal(enabledMatrix.workspaces.hasMore, false);
  assert.equal(enabledMatrix.projects.hasMore, true);
  assert.equal(enabledProjectContinuation.projects.hasMore, false);
  assert.equal(enabledProjectContinuation.projects.items.length, 2);
  const enabledProjects = [...enabledMatrix.projects.items, ...enabledProjectContinuation.projects.items];
  assert.equal(new Set(enabledProjects.map((project) => project.id)).size, 6);
  const inherited = enabledProjects.find((project) => project.id === inheritedProjectId);
  const direct = enabledProjects.find((project) => project.id === directProjectId);
  const combined = enabledProjects.find((project) => project.id === combinedProjectId);
  const pending = enabledProjects.find((project) => project.id === pendingProjectId);
  const regrant = enabledProjects.find((project) => project.id === oldRevokedProjectId);
  const pendingWorkspace = enabledMatrix.workspaces.items.find((workspace) => workspace.id === pendingWorkspaceId);
  const revokedWorkspace = enabledMatrix.workspaces.items.find((workspace) => workspace.id === revokedWorkspaceId);
  const historyWorkspace = enabledMatrix.workspaces.items.find((workspace) => workspace.id === historyWorkspaceId);
  assert.ok(inherited && direct && combined && pending && regrant && pendingWorkspace && revokedWorkspace && historyWorkspace);
  assert.equal(pendingWorkspace.provenance.kind, "none");
  assert.equal(revokedWorkspace.provenance.kind, "none");
  assert.equal(historyWorkspace.provenance.kind, "none");
  assert.equal(historyWorkspace.current, null);
  assert.ok(historyWorkspace.latestRevocation);
  assert.equal(inherited.grantedPermission, "owner");
  assert.equal(inherited.effectivePermission, "owner");
  assert.equal(inherited.provenance.kind, "workspace_inherited_owner_or_admin");
  assert.equal(direct.grantedPermission, "view");
  assert.equal(direct.effectivePermission, "view");
  assert.equal(direct.provenance.kind, "direct_project_assignment");
  assert.equal(combined.grantedPermission, "owner");
  assert.equal(combined.effectivePermission, "owner");
  assert.equal(combined.provenance.kind, "direct_and_workspace_inherited");
  assert.equal(pending.grantedPermission, null);
  assert.equal(pending.effectivePermission, null);
  assert.equal(pending.direct?.accessState, "pending");
  assert.equal(regrant.direct?.role, "editor");
  assert.ok(regrant.latestDirectRevocation);
  const serializedEnabledMatrix = JSON.stringify({ enabledMatrix, enabledProjectContinuation });
  assert.doesNotMatch(serializedEnabledMatrix, /"(?:reason|note|actorId|disabledReason|passwordHash|tokenHash|connection|credential|secret)"\s*:/iu);

  const disabledAdminPreview = await previewAccountAccess({
    adminUserId: adminId,
    adminAccountAccessVersion: 1,
    userId: disabledAdminId,
    action: "disable",
    reason: "matrix disabled administrator fixture",
    expectedVersion: 1,
  }, db);
  await executeAccountAccess(executeInput(disabledAdminPreview, {
    adminUserId: adminId,
    adminAccountAccessVersion: 1,
    reason: "matrix disabled administrator fixture",
    requestKey: `matrix-disable-admin-${suffix}`,
  }), db);
  await assert.rejects(
    () => getEffectiveAccessMatrix({ adminUserId: disabledAdminId, adminAccountAccessVersion: 1, userId: subjectId, pageSize: 4 }, db),
    (error: unknown) => serviceCode(error) === "ACCOUNT_ACCESS_ADMIN_REQUIRED",
  );
  await assert.rejects(
    () => getEffectiveAccessMatrix({ adminUserId: adminId, adminAccountAccessVersion: 2, userId: subjectId, pageSize: 4 }, db),
    (error: unknown) => serviceCode(error) === "ACCOUNT_ACCESS_ADMIN_STALE",
  );

  await db.$transaction(async (tx) => {
    await tx.workspace.createMany({
      data: [
        { id: memberWorkspaceId, name: `Matrix member ${suffix}`, slug: `matrix-member-${suffix}`, createdById: adminId },
        { id: orphanWorkspaceId, name: `Matrix orphan ${suffix}`, slug: `matrix-orphan-${suffix}`, createdById: adminId },
      ],
    });
    await grantWorkspaceMembership(tx, { workspaceId: memberWorkspaceId, userId: adminId, role: "owner", actorId: adminId, reason: "matrix member backup owner" });
    await grantWorkspaceMembership(tx, { workspaceId: memberWorkspaceId, userId: subjectId, role: "member", actorId: adminId, reason: "matrix member relationship" });
    await grantWorkspaceMembership(tx, { workspaceId: orphanWorkspaceId, userId: orphanOwnerId, role: "owner", actorId: adminId, reason: "matrix orphan backup owner" });
    await grantWorkspaceMembership(tx, { workspaceId: orphanWorkspaceId, userId: subjectId, role: "member", actorId: adminId, reason: "matrix orphan subject member" });
    await tx.project.createMany({
      data: [
        { id: pendingInheritedProjectId, workspaceId, name: `Matrix pending inherited ${suffix}`, slug: `matrix-pending-inherited-${suffix}`, membershipInheritanceMode: "workspaceInherited" },
        { id: memberCombinedProjectId, workspaceId: memberWorkspaceId, name: `Matrix member direct ${suffix}`, slug: `matrix-member-direct-${suffix}`, membershipInheritanceMode: "workspaceInherited" },
        { id: memberInheritedProjectId, workspaceId: memberWorkspaceId, name: `Matrix member inherited ${suffix}`, slug: `matrix-member-inherited-${suffix}`, membershipInheritanceMode: "workspaceInherited" },
        { id: orphanProjectId, workspaceId: orphanWorkspaceId, name: `Matrix orphan project ${suffix}`, slug: `matrix-orphan-project-${suffix}`, membershipInheritanceMode: "workspaceInherited" },
        { id: revokedInheritedProjectId, workspaceId: revokedWorkspaceId, name: `Matrix revoked inherited ${suffix}`, slug: `matrix-revoked-inherited-${suffix}`, membershipInheritanceMode: "workspaceInherited" },
      ],
    });
    const pendingInheritedProject = await tx.projectMembership.create({ data: { id: randomUUID(), projectId: pendingInheritedProjectId, userId: subjectId, role: "editor", accessState: "pending" } });
    await appendProjectMembershipAudit(tx, { ...pendingInheritedProject, workspaceId }, { action: MembershipAccessAuditAction.migrationQuarantined, previousState: null, actorId: adminId, reason: "matrix pending inherited direct" });
    await grantProjectMembership(tx, { projectId: memberCombinedProjectId, workspaceId: memberWorkspaceId, userId: subjectId, role: "viewer", actorId: adminId, reason: "matrix member direct viewer" });
  });

  const provenanceMatrix = await getEffectiveAccessMatrix({
    adminUserId: adminId,
    adminAccountAccessVersion: 1,
    userId: subjectId,
    pageSize: 100,
  }, db);
  const pendingInherited = provenanceMatrix.projects.items.find((project) => project.id === pendingInheritedProjectId);
  const memberCombined = provenanceMatrix.projects.items.find((project) => project.id === memberCombinedProjectId);
  const memberInherited = provenanceMatrix.projects.items.find((project) => project.id === memberInheritedProjectId);
  const revokedInherited = provenanceMatrix.projects.items.find((project) => project.id === revokedInheritedProjectId);
  const provenanceHistoryWorkspace = provenanceMatrix.workspaces.items.find((workspace) => workspace.id === historyWorkspaceId);
  const provenanceHistoryProject = provenanceMatrix.projects.items.find((project) => project.id === historyProjectId);
  assert.ok(pendingInherited && memberCombined && memberInherited && revokedInherited && provenanceHistoryWorkspace && provenanceHistoryProject);
  assert.equal(pendingInherited.direct?.accessState, "pending");
  assert.equal(pendingInherited.grantedPermission, "owner");
  assert.equal(pendingInherited.provenance.kind, "workspace_inherited_owner_or_admin");
  assert.equal(pendingInherited.inheritedFromWorkspace?.provenance.kind, "workspace_inherited_owner_or_admin");
  assert.equal(memberCombined.direct?.accessState, "confirmed");
  assert.equal(memberCombined.inheritedFromWorkspace?.role, "member");
  assert.equal(memberCombined.inheritedFromWorkspace?.provenance.kind, "none");
  assert.equal(memberCombined.grantedPermission, "view");
  assert.equal(memberCombined.provenance.kind, "direct_project_assignment");
  assert.equal(memberInherited.grantedPermission, null);
  assert.equal(memberInherited.inheritedFromWorkspace?.provenance.kind, "none");
  assert.equal(memberInherited.provenance.kind, "none");
  assert.equal(revokedInherited.inheritedFromWorkspace?.accessState, "revoked");
  assert.equal(revokedInherited.inheritedFromWorkspace?.provenance.kind, "none");
  assert.equal(revokedInherited.grantedPermission, null);
  assert.equal(revokedInherited.provenance.kind, "none");
  assert.equal(provenanceHistoryWorkspace.current, null);
  assert.ok(provenanceHistoryWorkspace.latestRevocation);
  assert.equal(provenanceHistoryWorkspace.provenance.kind, "none");
  assert.equal(provenanceHistoryProject.direct, null);
  assert.ok(provenanceHistoryProject.latestDirectRevocation);
  assert.equal(provenanceHistoryProject.inheritedFromWorkspace?.accessState, "revoked");
  assert.equal(provenanceHistoryProject.inheritedFromWorkspace?.provenance.kind, "none");
  assert.equal(provenanceHistoryProject.provenance.kind, "none");
  const latestHistoryWorkspaceMembership = await db.workspaceMembership.findFirstOrThrow({
    where: { workspaceId: historyWorkspaceId, userId: subjectId, accessState: "revoked" },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    select: { id: true },
  });
  const latestHistoryProjectMembership = await db.projectMembership.findFirstOrThrow({
    where: { projectId: historyProjectId, userId: subjectId, accessState: "revoked" },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    select: { id: true },
  });
  const newestHistoryWorkspaceAudit = await db.membershipAccessAudit.findFirstOrThrow({
    where: { membershipKind: "workspace", membershipId: latestHistoryWorkspaceMembership.id, action: MembershipAccessAuditAction.revoked },
    select: { createdAt: true },
  });
  const newestHistoryProjectAudit = await db.membershipAccessAudit.findFirstOrThrow({
    where: { membershipKind: "project", membershipId: latestHistoryProjectMembership.id, action: MembershipAccessAuditAction.revoked },
    select: { createdAt: true },
  });
  assert.equal(provenanceHistoryWorkspace.latestRevocation.recordedAt, newestHistoryWorkspaceAudit.createdAt.toISOString());
  assert.equal(provenanceHistoryProject.latestDirectRevocation.recordedAt, newestHistoryProjectAudit.createdAt.toISOString());

  const adminMatrix = await getEffectiveAccessMatrix({
    adminUserId: adminId,
    adminAccountAccessVersion: 1,
    userId: adminId,
    pageSize: 100,
  }, db);
  assert.equal(adminMatrix.projects.items.some((project) => project.id === orphanProjectId), false);

  const disablePreview = await previewAccountAccess({
    adminUserId: adminId,
    adminAccountAccessVersion: 1,
    userId: subjectId,
    action: "disable",
    reason: "matrix disabled overlay",
    expectedVersion: 1,
  }, db);
  await executeAccountAccess({
    adminUserId: adminId,
    adminAccountAccessVersion: 1,
    userId: subjectId,
    action: "disable",
    reason: "matrix disabled overlay",
    expectedVersion: disablePreview.current.accountAccessVersion,
    expectedImpactFingerprint: disablePreview.impactFingerprint,
    requestKey: `matrix-disable-${suffix}`,
    requestFingerprint: disablePreview.requestFingerprint,
    previewId: disablePreview.previewId,
    previewIssuedAt: disablePreview.previewIssuedAt,
    previewExpiresAt: disablePreview.previewExpiresAt,
    confirmation: true,
    confirmationUsername: `matrix_subject_${suffix}`,
  }, db);
  const disabledMatrix = await getEffectiveAccessMatrix({
    adminUserId: adminId,
    adminAccountAccessVersion: 1,
    userId: subjectId,
    pageSize: 100,
  }, db);
  assert.equal(disabledMatrix.system.accountState, "disabled");
  assert.equal(disabledMatrix.commercial.tier, "member");
  assert.equal(disabledMatrix.commercial.entitlementEffective, false);
  const disabledCombined = disabledMatrix.projects.items.find((project) => project.id === combinedProjectId);
  assert.ok(disabledCombined);
  assert.equal(disabledCombined.grantedPermission, "owner");
  assert.equal(disabledCombined.effectivePermission, null);
  assert.equal(disabledCombined.provenance.kind, "direct_and_workspace_inherited");
  assert.ok(disabledCombined.reasons.includes("workspace_membership_confirmed"));
  const disabledWorkspace = disabledMatrix.workspaces.items.find((workspace) => workspace.id === workspaceId);
  assert.ok(disabledWorkspace);
  assert.equal(disabledWorkspace.effective, false);
  assert.doesNotMatch(JSON.stringify(disabledMatrix), /"(?:reason|note|actorId|disabledReason|passwordHash|tokenHash|connection|credential|secret)"\s*:/iu);

  const lifecycleChecks = [
    [futureId, "not_started"],
    [expiredId, "expired"],
    [revokedId, "revoked"],
    [noneId, "none"],
  ] as const;
  for (const [userId, lifecycle] of lifecycleChecks) {
    const result = await getEffectiveAccessMatrix({ adminUserId: adminId, adminAccountAccessVersion: 1, userId, pageSize: 100 }, db);
    assert.equal(result.commercial.lifecycle, lifecycle);
    assert.equal(result.commercial.tier, "free");
  }
});
