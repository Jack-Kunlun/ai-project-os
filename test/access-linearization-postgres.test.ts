import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Prisma } from "@prisma/client";
import { getDb } from "../src/lib/db";
import {
  executeAccountAccess,
  previewAccountAccess,
  type AccountAccessPreview,
} from "../src/lib/account-access-service";
import {
  admitWebAiProjectAccess,
  lockActorAccess,
  lockActorWorkspaceProjectAccess,
  lockActorsAccess,
  lockProjectAccess,
  lockWorkspaceAccess,
  withWebAiProjectAccessTransaction,
  WebAiAccessError,
  type WebAiActor,
} from "../src/lib/access-linearization";
import { updateProjectLifecycle } from "../src/lib/project-lifecycle";
import { grantProjectMembership, grantWorkspaceMembership, revokeProjectMembership } from "../src/lib/membership-governance";

const shouldRun = process.env.ACCESS_LINEARIZATION_POSTGRES_GATE === "1";

function accessCode(code: string) {
  return (error: unknown): boolean => error instanceof WebAiAccessError && error.code === code;
}

function deferred(): Readonly<{ promise: Promise<void>; resolve: () => void }> {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return Object.freeze({ promise, resolve });
}

function executeAccountAccessInput(
  preview: AccountAccessPreview,
  input: Readonly<{ adminUserId: string; adminAccountAccessVersion: number; reason: string; requestKey: string }>,
) {
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

async function previewGovernedAccountAccess(
  db: ReturnType<typeof getDb>,
  input: Readonly<{
    adminUserId: string;
    userId: string;
    action: "disable" | "restore";
    reason: string;
  }>,
): Promise<Readonly<{ preview: AccountAccessPreview; adminAccountAccessVersion: number }>> {
  const [admin, target] = await Promise.all([
    db.appUser.findUniqueOrThrow({ where: { id: input.adminUserId }, select: { accountAccessVersion: true } }),
    db.appUser.findUniqueOrThrow({ where: { id: input.userId }, select: { accountAccessVersion: true } }),
  ]);
  const preview = await previewAccountAccess({
    adminUserId: input.adminUserId,
    adminAccountAccessVersion: admin.accountAccessVersion,
    userId: input.userId,
    action: input.action,
    reason: input.reason,
    expectedVersion: target.accountAccessVersion,
  }, db);
  assert.equal(preview.canExecute, true);
  return Object.freeze({ preview, adminAccountAccessVersion: admin.accountAccessVersion });
}

async function executeGovernedAccountAccess(
  db: ReturnType<typeof getDb>,
  input: Readonly<{
    adminUserId: string;
    userId: string;
    action: "disable" | "restore";
    reason: string;
    requestKey: string;
  }>,
) {
  const prepared = await previewGovernedAccountAccess(db, input);
  return executeAccountAccess(executeAccountAccessInput(prepared.preview, {
    adminUserId: input.adminUserId,
    adminAccountAccessVersion: prepared.adminAccountAccessVersion,
    reason: input.reason,
    requestKey: input.requestKey,
  }), db);
}

async function waitForAdvisoryLockWait(db: ReturnType<typeof getDb>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const rows = await db.$queryRaw<Array<{ waiting: number }>>(Prisma.sql`
      SELECT count(*)::integer AS waiting
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock'
        AND query LIKE '%pg_advisory_xact_lock%'
    `);
    if ((rows[0]?.waiting ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("ACCESS_LINEARIZATION_ACTOR_FENCE_WAIT_NOT_OBSERVED");
}

test(
  "PostgreSQL access admission and revocation share actor, workspace and project locks",
  { skip: !shouldRun ? "ACCESS_LINEARIZATION_POSTGRES_GATE=1 is required" : false },
  async () => {
    const db = getDb();
    const suffix = randomUUID().slice(0, 8);
    const workspaceId = randomUUID();
    const adminId = randomUUID();
    const memberId = randomUUID();
    const ownerId = randomUUID();
    const membershipProjectId = randomUUID();
    const archiveProjectId = randomUUID();
    const legacyProjectOnlyId = randomUUID();
    const member: WebAiActor = { id: memberId, role: "user", accountAccessVersion: 1 };
    const owner: WebAiActor = { id: ownerId, role: "user", accountAccessVersion: 1 };
    let admissionCallbackCalled = false;

    await db.appUser.createMany({ data: [
      { id: adminId, username: `linearization_admin_${suffix}`, role: "admin" },
      { id: memberId, username: `linearization_member_${suffix}`, role: "user" },
      { id: ownerId, username: `linearization_owner_${suffix}`, role: "user" },
    ] });
    await db.workspace.create({ data: { id: workspaceId, name: `Linearization ${suffix}`, slug: `linearization-${suffix}`, createdById: ownerId } });
    await db.project.createMany({ data: [
      { id: membershipProjectId, workspaceId, name: `Membership ${suffix}`, slug: `linearization-membership-${suffix}` },
      { id: archiveProjectId, workspaceId, name: `Archive ${suffix}`, slug: `linearization-archive-${suffix}` },
      { id: legacyProjectOnlyId, workspaceId, name: `Legacy project only ${suffix}`, slug: `linearization-legacy-${suffix}` },
    ] });
    await db.$transaction(async (tx) => {
      await grantWorkspaceMembership(tx, { workspaceId, userId: ownerId, role: "owner", actorId: ownerId, reason: "access_linearization_fixture_owner" });
      await grantWorkspaceMembership(tx, { workspaceId, userId: memberId, role: "member", actorId: ownerId, reason: "access_linearization_fixture_member" });
      await grantProjectMembership(tx, { projectId: membershipProjectId, workspaceId, userId: memberId, role: "editor", actorId: ownerId, reason: "access_linearization_fixture_project" });
      await grantProjectMembership(tx, { projectId: archiveProjectId, workspaceId, userId: ownerId, role: "owner", actorId: ownerId, reason: "access_linearization_fixture_archive" });
    });

    try {
      // The default legacy projectOnly mode does not let a workspace owner
      // substitute for a confirmed project grant.
      await assert.rejects(
        () => db.$transaction((tx) => admitWebAiProjectAccess(tx, { actor: owner, projectId: legacyProjectOnlyId, required: "view" })),
        accessCode("ACCESS_FORBIDDEN"),
      );

      // Revoke wins: admission is already waiting on the target actor lock,
      // then observes the committed membership removal and never reaches the
      // caller's dispatch section.
      const revokeLocked = deferred();
      const releaseRevoke = deferred();
      const revoke = db.$transaction(async (tx) => {
        await lockActorAccess(tx, memberId);
        revokeLocked.resolve();
        await revokeProjectMembership(tx, membershipProjectId, memberId, workspaceId, { actorId: ownerId, reason: "access_linearization_revoke" });
        await releaseRevoke.promise;
      });
      await revokeLocked.promise;
      const blockedDescription = "must not persist after revocation";
      const admissionAfterRevoke = withWebAiProjectAccessTransaction(db, {
        actor: member,
        projectId: membershipProjectId,
        required: "edit",
      }, async (tx, admitted) => {
        admissionCallbackCalled = true;
        await tx.project.update({
          where: { id: membershipProjectId },
          data: { description: blockedDescription },
        });
        return admitted;
      });
      releaseRevoke.resolve();
      await revoke;
      await assert.rejects(admissionAfterRevoke, accessCode("ACCESS_FORBIDDEN"));
      assert.equal(admissionCallbackCalled, false);
      assert.notEqual(
        (await db.project.findUniqueOrThrow({ where: { id: membershipProjectId }, select: { description: true } })).description,
        blockedDescription,
      );

      // Restore the grant, then let admission commit first.  The subsequent
      // membership removal may complete, while the next admission fails.
      await db.$transaction((tx) => grantProjectMembership(tx, { projectId: membershipProjectId, workspaceId, userId: memberId, role: "editor", actorId: ownerId, reason: "access_linearization_restore" }));
      const admissionReady = deferred();
      const releaseAdmission = deferred();
      const admittedFirst = db.$transaction(async (tx) => {
        const admitted = await admitWebAiProjectAccess(tx, { actor: member, projectId: membershipProjectId, required: "edit" });
        admissionReady.resolve();
        await releaseAdmission.promise;
        return admitted;
      });
      await admissionReady.promise;
      const revokeAfterAdmission = db.$transaction(async (tx) => {
        await lockActorsAccess(tx, [memberId]);
        await lockWorkspaceAccess(tx, workspaceId);
        await lockProjectAccess(tx, membershipProjectId);
        await revokeProjectMembership(tx, membershipProjectId, memberId, workspaceId, { actorId: ownerId, reason: "access_linearization_revoke_after_admission" });
      });
      releaseAdmission.resolve();
      const committedAdmission = await admittedFirst;
      assert.equal(committedAdmission.project.id, membershipProjectId);
      await revokeAfterAdmission;
      await assert.rejects(
        () => db.$transaction((tx) => admitWebAiProjectAccess(tx, { actor: member, projectId: membershipProjectId, required: "edit" })),
        accessCode("ACCESS_FORBIDDEN"),
      );

      // Account disable wins under the same actor fence. The admission may
      // have read the old row before waiting, but its post-lock reload must
      // reject before a caller callback can record work.
      const disableReason = "access_linearization_disable";
      const disablePrepared = await previewGovernedAccountAccess(db, {
        adminUserId: adminId,
        userId: ownerId,
        action: "disable",
        reason: disableReason,
      });
      const disableLocked = deferred();
      const releaseDisable = deferred();
      const disableFence = db.$transaction(async (tx) => {
        await lockActorAccess(tx, ownerId);
        disableLocked.resolve();
        await releaseDisable.promise;
      });
      await disableLocked.promise;
      const disable = executeAccountAccess(executeAccountAccessInput(disablePrepared.preview, {
        adminUserId: adminId,
        adminAccountAccessVersion: disablePrepared.adminAccountAccessVersion,
        reason: disableReason,
        requestKey: `access-linearization-disable-${suffix}`,
      }), db);
      await waitForAdvisoryLockWait(db);
      const admissionAfterDisable = db.$transaction((tx) => admitWebAiProjectAccess(tx, { actor: owner, projectId: archiveProjectId, required: "owner" }));
      releaseDisable.resolve();
      await disable;
      await disableFence;
      await assert.rejects(admissionAfterDisable, accessCode("ACCOUNT_DISABLED"));
      const restored = await executeGovernedAccountAccess(db, {
        adminUserId: adminId,
        userId: ownerId,
        action: "restore",
        reason: "access_linearization_restore",
        requestKey: `access-linearization-restore-${suffix}`,
      });
      assert.equal(restored.state, "enabled");
      const restoredOwner: WebAiActor = {
        id: ownerId,
        role: "user",
        accountAccessVersion: restored.accountAccessVersion,
      };

      // Archive wins: lifecycle-style project state mutation holds the same
      // access lock while the admission waits, so the admission sees the
      // committed archive and is rejected.
      const archiveLocked = deferred();
      const releaseArchive = deferred();
      const archive = db.$transaction(async (tx) => {
        await lockActorWorkspaceProjectAccess(tx, { actorIds: [ownerId], workspaceId, projectId: archiveProjectId });
        archiveLocked.resolve();
        await tx.project.update({ where: { id: archiveProjectId }, data: { archivedAt: new Date() } });
        await releaseArchive.promise;
      });
      await archiveLocked.promise;
      const admissionAfterArchive = db.$transaction((tx) => admitWebAiProjectAccess(tx, { actor: restoredOwner, projectId: archiveProjectId, required: "owner" }));
      releaseArchive.resolve();
      await archive;
      await assert.rejects(admissionAfterArchive, accessCode("ACCESS_FORBIDDEN"));

      // Admission wins: archive waits for the already-admitted transaction,
      // then succeeds against the active project version.
      const activeArchiveProject = await db.project.update({ where: { id: archiveProjectId }, data: { archivedAt: null } });
      const admissionBeforeArchiveReady = deferred();
      const releaseAdmissionBeforeArchive = deferred();
      const admissionBeforeArchive = db.$transaction(async (tx) => {
        const admitted = await admitWebAiProjectAccess(tx, { actor: restoredOwner, projectId: archiveProjectId, required: "owner" });
        admissionBeforeArchiveReady.resolve();
        await releaseAdmissionBeforeArchive.promise;
        return admitted;
      });
      await admissionBeforeArchiveReady.promise;
      const archiveAfterAdmission = updateProjectLifecycle({
        projectId: archiveProjectId,
        actor: restoredOwner,
        action: "archive",
        expectedUpdatedAt: activeArchiveProject.updatedAt,
      }, db);
      releaseAdmissionBeforeArchive.resolve();
      const admittedBeforeArchive = await admissionBeforeArchive;
      assert.equal(admittedBeforeArchive.project.archivedAt, null);
      const archived = await archiveAfterAdmission;
      assert.notEqual(archived.project.archivedAt, null);
    } finally {
      await db.project.deleteMany({ where: { id: { in: [membershipProjectId, archiveProjectId, legacyProjectOnlyId] } } });
      await db.workspace.deleteMany({ where: { id: workspaceId } });
      // Account lifecycle previews and audits are intentionally append-only;
      // the disposable gate runner drops this database after the test, so the
      // fixture users remain until that boundary instead of bypassing guards.
    }
  },
);
