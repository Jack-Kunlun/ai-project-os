import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Prisma } from "@prisma/client";
import { getDb } from "../src/lib/db";
import {
  admitWebAiProjectAccess,
  lockActorWorkspaceProjectAccess,
  type WebAiActor,
  WebAiAccessError,
} from "../src/lib/access-linearization";
import { revokeProjectMembership, grantProjectMembership, grantWorkspaceMembership } from "../src/lib/membership-governance";
import { exportProjectData } from "../src/lib/project-export";
import { updateProjectLifecycle } from "../src/lib/project-lifecycle";
import { isSerializationConflict } from "../src/lib/project-snapshot-errors";

const shouldRun = process.env.PROJECT_ACCESS_REVOCATION_POSTGRES_GATE === "1";

function deferred(): Readonly<{ promise: Promise<void>; resolve: () => void }> {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return Object.freeze({ promise, resolve });
}

async function createFixture(db: ReturnType<typeof getDb>, suffix: string) {
  const owner = await db.appUser.create({ data: { id: randomUUID(), username: `access_race_owner_${suffix}`, role: "user" } });
  const backupOwner = await db.appUser.create({ data: { id: randomUUID(), username: `access_race_backup_${suffix}`, role: "user" } });
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const project = await db.$transaction(async (tx) => {
    await tx.workspace.create({
      data: { id: workspaceId, name: `Access race ${suffix}`, slug: `access-race-${suffix}`, createdById: owner.id },
    });
    const created = await tx.project.create({
      data: { id: projectId, workspaceId, name: `Access race ${suffix}`, slug: `access-race-${suffix}` },
    });
    await grantWorkspaceMembership(tx, {
      workspaceId,
      userId: owner.id,
      role: "owner",
      actorId: backupOwner.id,
      reason: "project_access_race_fixture_owner",
    });
    await grantWorkspaceMembership(tx, {
      workspaceId,
      userId: backupOwner.id,
      role: "owner",
      actorId: backupOwner.id,
      reason: "project_access_race_fixture_backup_owner",
    });
    await grantProjectMembership(tx, {
      projectId,
      workspaceId,
      userId: owner.id,
      role: "owner",
      actorId: backupOwner.id,
      reason: "project_access_race_fixture_project_owner",
    });
    return created;
  });
  const actor: WebAiActor = { id: owner.id, role: "user", accountAccessVersion: owner.accountAccessVersion };
  return Object.freeze({ actor, owner, backupOwner, workspaceId, projectId, project });
}

test(
  "RepeatableRead export rechecks a project membership after a concurrent revoke",
  { skip: !shouldRun ? "PROJECT_ACCESS_REVOCATION_POSTGRES_GATE=1 is required" : false },
  async () => {
    const db = getDb();
    const fixture = await createFixture(db, randomUUID().slice(0, 8));
    const revokeLocked = deferred();
    const releaseRevoke = deferred();
    let callbackCalled = false;
    try {
      const revocation = db.$transaction(async (tx) => {
        await lockActorWorkspaceProjectAccess(tx, {
          actorIds: [fixture.owner.id],
          workspaceId: fixture.workspaceId,
          projectId: fixture.projectId,
        });
        revokeLocked.resolve();
        await revokeProjectMembership(tx, fixture.projectId, fixture.owner.id, fixture.workspaceId, {
          actorId: fixture.backupOwner.id,
          reason: "project_access_race_revoke_before_export",
        });
        await releaseRevoke.promise;
      });
      await revokeLocked.promise;
      const exported = exportProjectData({
        projectId: fixture.projectId,
        actor: fixture.actor,
        expectedUpdatedAt: fixture.project.updatedAt,
      }, db).then(() => {
        callbackCalled = true;
      });
      releaseRevoke.resolve();
      await revocation;
      await assert.rejects(
        exported,
        (error: unknown) => error instanceof WebAiAccessError && error.code === "ACCESS_FORBIDDEN",
      );
      assert.equal(callbackCalled, false);
      assert.equal(await db.projectDataExportAudit.count({ where: { projectId: fixture.projectId } }), 0);
    } finally {
      await db.project.deleteMany({ where: { id: fixture.projectId } });
      await db.workspace.deleteMany({ where: { id: fixture.workspaceId } });
      await db.appUser.deleteMany({ where: { id: { in: [fixture.owner.id, fixture.backupOwner.id] } } });
    }
  },
);

for (const isolationLevel of [Prisma.TransactionIsolationLevel.RepeatableRead, Prisma.TransactionIsolationLevel.Serializable] as const) {
  test(
    `stale ${isolationLevel} admission fails closed after a membership update`,
    { skip: !shouldRun ? "PROJECT_ACCESS_REVOCATION_POSTGRES_GATE=1 is required" : false },
    async () => {
      const db = getDb();
      const fixture = await createFixture(db, randomUUID().slice(0, 8));
      const snapshotReady = deferred();
      const releaseAdmission = deferred();
      try {
        const staleAdmission = db.$transaction(async (tx) => {
          // Establish the old transaction snapshot before the membership
          // update commits. The admission helper must reject when its locked
          // FOR SHARE reload encounters that changed row.
          await tx.project.findUnique({ where: { id: fixture.projectId }, select: { id: true } });
          snapshotReady.resolve();
          await releaseAdmission.promise;
          return admitWebAiProjectAccess(tx, {
            actor: fixture.actor,
            projectId: fixture.projectId,
            required: "owner",
          });
        }, { isolationLevel });
        await snapshotReady.promise;
        await db.$transaction(async (tx) => {
          await lockActorWorkspaceProjectAccess(tx, {
            actorIds: [fixture.owner.id],
            workspaceId: fixture.workspaceId,
            projectId: fixture.projectId,
          });
          await revokeProjectMembership(tx, fixture.projectId, fixture.owner.id, fixture.workspaceId, {
            actorId: fixture.backupOwner.id,
            reason: `project_access_race_${isolationLevel}_revoke`,
          });
        });
        releaseAdmission.resolve();
        await assert.rejects(staleAdmission, (error: unknown) => isSerializationConflict(error));
        assert.equal(await db.projectDataExportAudit.count({ where: { projectId: fixture.projectId } }), 0);
      } finally {
        releaseAdmission.resolve();
        await db.project.deleteMany({ where: { id: fixture.projectId } });
        await db.workspace.deleteMany({ where: { id: fixture.workspaceId } });
        await db.appUser.deleteMany({ where: { id: { in: [fixture.owner.id, fixture.backupOwner.id] } } });
      }
    },
  );
}

test(
  "lifecycle admission rejects an Owner after membership revocation without a revision",
  { skip: !shouldRun ? "PROJECT_ACCESS_REVOCATION_POSTGRES_GATE=1 is required" : false },
  async () => {
    const db = getDb();
    const fixture = await createFixture(db, randomUUID().slice(0, 8));
    try {
      await db.$transaction(async (tx) => {
        await lockActorWorkspaceProjectAccess(tx, {
          actorIds: [fixture.owner.id],
          workspaceId: fixture.workspaceId,
          projectId: fixture.projectId,
        });
        await revokeProjectMembership(tx, fixture.projectId, fixture.owner.id, fixture.workspaceId, {
          actorId: fixture.backupOwner.id,
          reason: "project_access_race_lifecycle_revoke",
        });
      });
      await assert.rejects(
        () => updateProjectLifecycle({
          projectId: fixture.projectId,
          actor: fixture.actor,
          action: "archive",
          expectedUpdatedAt: fixture.project.updatedAt,
        }, db),
        (error: unknown) => error instanceof WebAiAccessError && error.code === "ACCESS_FORBIDDEN",
      );
      assert.equal(await db.projectLifecycleRevision.count({ where: { projectId: fixture.projectId } }), 0);
      assert.equal((await db.project.findUniqueOrThrow({ where: { id: fixture.projectId }, select: { archivedAt: true } })).archivedAt, null);
    } finally {
      await db.project.deleteMany({ where: { id: fixture.projectId } });
      await db.workspace.deleteMany({ where: { id: fixture.workspaceId } });
      await db.appUser.deleteMany({ where: { id: { in: [fixture.owner.id, fixture.backupOwner.id] } } });
    }
  },
);
