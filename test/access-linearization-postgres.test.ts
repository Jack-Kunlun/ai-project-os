import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { getDb } from "../src/lib/db";
import {
  admitWebAiProjectAccess,
  lockActorAccess,
  lockActorWorkspaceProjectAccess,
  lockActorsAccess,
  lockProjectAccess,
  lockWorkspaceAccess,
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

test(
  "PostgreSQL access admission and revocation share actor, workspace and project locks",
  { skip: !shouldRun ? "ACCESS_LINEARIZATION_POSTGRES_GATE=1 is required" : false },
  async () => {
    const db = getDb();
    const suffix = randomUUID().slice(0, 8);
    const workspaceId = randomUUID();
    const memberId = randomUUID();
    const ownerId = randomUUID();
    const membershipProjectId = randomUUID();
    const archiveProjectId = randomUUID();
    const legacyProjectOnlyId = randomUUID();
    const member: WebAiActor = { id: memberId, role: "user" };
    const owner: WebAiActor = { id: ownerId, role: "user" };
    let admissionCallbackCalled = false;

    await db.appUser.createMany({ data: [
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
      const admissionAfterRevoke = db.$transaction(async (tx) => {
        const admitted = await admitWebAiProjectAccess(tx, { actor: member, projectId: membershipProjectId, required: "edit" });
        admissionCallbackCalled = true;
        return admitted;
      });
      releaseRevoke.resolve();
      await revoke;
      await assert.rejects(admissionAfterRevoke, accessCode("ACCESS_FORBIDDEN"));
      assert.equal(admissionCallbackCalled, false);

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
      const disableLocked = deferred();
      const releaseDisable = deferred();
      const disable = db.$transaction(async (tx) => {
        await lockActorAccess(tx, ownerId);
        disableLocked.resolve();
        await tx.appUser.update({ where: { id: ownerId }, data: { disabledAt: new Date() } });
        await releaseDisable.promise;
      });
      await disableLocked.promise;
      const admissionAfterDisable = db.$transaction((tx) => admitWebAiProjectAccess(tx, { actor: owner, projectId: archiveProjectId, required: "owner" }));
      releaseDisable.resolve();
      await disable;
      await assert.rejects(admissionAfterDisable, accessCode("ACCOUNT_DISABLED"));
      await db.appUser.update({ where: { id: ownerId }, data: { disabledAt: null } });

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
      const admissionAfterArchive = db.$transaction((tx) => admitWebAiProjectAccess(tx, { actor: owner, projectId: archiveProjectId, required: "owner" }));
      releaseArchive.resolve();
      await archive;
      await assert.rejects(admissionAfterArchive, accessCode("ACCESS_FORBIDDEN"));

      // Admission wins: archive waits for the already-admitted transaction,
      // then succeeds against the active project version.
      const activeArchiveProject = await db.project.update({ where: { id: archiveProjectId }, data: { archivedAt: null } });
      const admissionBeforeArchiveReady = deferred();
      const releaseAdmissionBeforeArchive = deferred();
      const admissionBeforeArchive = db.$transaction(async (tx) => {
        const admitted = await admitWebAiProjectAccess(tx, { actor: owner, projectId: archiveProjectId, required: "owner" });
        admissionBeforeArchiveReady.resolve();
        await releaseAdmissionBeforeArchive.promise;
        return admitted;
      });
      await admissionBeforeArchiveReady.promise;
      const archiveAfterAdmission = updateProjectLifecycle({
        projectId: archiveProjectId,
        actor: owner,
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
      await db.appUser.deleteMany({ where: { id: { in: [memberId, ownerId] } } });
    }
  },
);
