import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { getDb } from "../src/lib/db";
import {
  cancelProjectJob,
  claimProjectJob,
  finishProjectJob,
  heartbeatProjectJob,
  markProviderAcknowledged,
  markProviderDispatched,
  ProjectWorkflowError,
  reconcileProjectJob,
  updateProjectJobProgress,
} from "../src/lib/project-workflow";

const shouldRun = process.env.PROJECT_WORKFLOW_POSTGRES_GATE === "1";

test(
  "PostgreSQL serializes claims and preserves recovery boundaries",
  { skip: !shouldRun ? "PROJECT_WORKFLOW_POSTGRES_GATE=1 is required" : false },
  async () => {
    const db = getDb();
    const suffix = randomUUID().slice(0, 8);
    const projectId = randomUUID();
    const otherProjectId = randomUUID();
    const jobId = randomUUID();
    const queuedJobId = randomUUID();
    const interruptedJobId = randomUUID();
    let createdUserId: string | null = null;
    let user = await db.appUser.findFirst({ where: { role: "admin" } });
    if (user === null) {
      user = await db.appUser.create({
        data: {
          username: `workflow_${suffix}`,
          role: "admin",
          passwordHash: "a".repeat(43),
          passwordSalt: "b".repeat(22),
          passwordVersion: 1,
        },
      });
      createdUserId = user.id;
    }

    try {
      await db.project.createMany({
        data: [
          { id: projectId, name: `Workflow ${suffix}`, slug: `workflow-${suffix}` },
          { id: otherProjectId, name: `Workflow other ${suffix}`, slug: `workflow-other-${suffix}` },
        ],
      });
      const baseJob = {
        projectId,
        kind: "projectBrief" as const,
        requestedById: user.id,
        payload: {},
      };
      await db.backgroundJob.createMany({
        data: [
          { ...baseJob, id: jobId, idempotencyKey: `${"a".repeat(56)}${suffix}` },
          { ...baseJob, id: queuedJobId, idempotencyKey: `${"b".repeat(56)}${suffix}` },
          { ...baseJob, id: interruptedJobId, idempotencyKey: `${"c".repeat(56)}${suffix}` },
        ],
      });

      const claims = await Promise.all([
        claimProjectJob(jobId, db),
        claimProjectJob(jobId, db),
      ]);
      assert.equal(claims.filter((claim) => claim !== false).length, 1);
      const claim = claims.find((candidate) => candidate !== false)!;
      const attempts = await db.backgroundJobAttempt.findMany({ where: { jobId } });
      assert.equal(attempts.length, 1);
      assert.equal(attempts[0]!.attemptNumber, 1);
      assert.equal(attempts[0]!.leaseTokenHash.length, 64);
      assert.notEqual(attempts[0]!.leaseTokenHash, claim.claimToken);

      const beforeHeartbeat = attempts[0]!.leaseExpiresAt;
      await heartbeatProjectJob({ jobId, ...claim }, db);
      const afterHeartbeat = await db.backgroundJobAttempt.findUniqueOrThrow({ where: { id: claim.attemptId } });
      assert.equal(afterHeartbeat.leaseExpiresAt > beforeHeartbeat, true);
      await markProviderDispatched({ jobId, ...claim }, db);
      await markProviderAcknowledged({ jobId, ...claim }, db);
      await markProviderDispatched({ jobId, ...claim }, db);
      await markProviderAcknowledged({ jobId, ...claim }, db);

      await assert.rejects(
        () => updateProjectJobProgress({ jobId, ...claim, claimToken: "forged-token", stage: "work", current: 1, total: 2 }, db),
        (error: unknown) => error instanceof ProjectWorkflowError && error.code === "PROJECT_WORKFLOW_STALE_ATTEMPT",
      );
      await updateProjectJobProgress({ jobId, ...claim, stage: "work", current: 1, total: 2 }, db);
      await finishProjectJob({ jobId, ...claim, result: { ok: true } }, db);
      const finished = await db.backgroundJob.findUniqueOrThrow({ where: { id: jobId } });
      assert.equal(finished.status, "succeeded");
      assert.equal((await db.backgroundJobAttempt.findUniqueOrThrow({ where: { id: claim.attemptId } })).status, "succeeded");

      const unknownGenericJob = await db.backgroundJob.create({
        data: {
          id: randomUUID(),
          projectId,
          kind: "projectBrief",
          status: "unknown",
          stage: "reconciliation_required",
          failureCode: "RECONCILIATION_REQUIRED",
          reconciliationRequired: true,
          requestedById: user.id,
          idempotencyKey: `${"d".repeat(56)}${suffix}`,
          payload: {},
        },
      });
      await assert.rejects(
        () => db.backgroundJob.update({ where: { id: unknownGenericJob.id }, data: { reconciliationRequired: false } }),
      );
      await assert.rejects(
        () => reconcileProjectJob(otherProjectId, unknownGenericJob.id, user.id, db),
        (error: unknown) => error instanceof ProjectWorkflowError && error.code === "PROJECT_WORKFLOW_PROJECT_MISMATCH",
      );
      const reconciledGeneric = await reconcileProjectJob(projectId, unknownGenericJob.id, user.id, db);
      assert.equal(reconciledGeneric.status, "unknown");
      assert.equal(reconciledGeneric.stage, "reconciled_unknown");
      assert.equal(reconciledGeneric.reconciliationRequired, false);
      const genericEvidence = await db.backgroundJobReconciliation.findUniqueOrThrow({
        where: { projectId_jobId: { projectId, jobId: unknownGenericJob.id } },
      });
      assert.equal(genericEvidence.requestedById, user.id);
      assert.equal(genericEvidence.resolution, "explicitAbandon");
      assert.equal(genericEvidence.evidenceFingerprint.length, 64);
      const replayedGeneric = await reconcileProjectJob(projectId, unknownGenericJob.id, user.id, db);
      assert.equal(replayedGeneric.id, reconciledGeneric.id);
      assert.equal(await db.backgroundJobReconciliation.count({ where: { projectId, jobId: unknownGenericJob.id } }), 1);
      await assert.rejects(
        () => db.backgroundJobReconciliation.update({ where: { id: genericEvidence.id }, data: { resolution: "explicitAbandon" } }),
      );
      await assert.rejects(
        () => db.backgroundJobReconciliation.delete({ where: { id: genericEvidence.id } }),
      );

      const cascadeProjectId = randomUUID();
      await db.project.create({
        data: { id: cascadeProjectId, name: `Workflow cascade ${suffix}`, slug: `workflow-cascade-${suffix}` },
      });
      const cascadeJob = await db.backgroundJob.create({
        data: {
          id: randomUUID(),
          projectId: cascadeProjectId,
          kind: "projectBrief",
          status: "unknown",
          stage: "reconciliation_required",
          failureCode: "RECONCILIATION_REQUIRED",
          reconciliationRequired: true,
          requestedById: user.id,
          idempotencyKey: `${"g".repeat(56)}${suffix}`,
          payload: {},
        },
      });
      await db.backgroundJobReconciliation.create({
        data: {
          projectId: cascadeProjectId,
          jobId: cascadeJob.id,
          requestedById: user.id,
          resolution: "explicitAbandon",
          evidenceFingerprint: "a".repeat(64),
        },
      });
      await db.project.delete({ where: { id: cascadeProjectId } });
      assert.equal(await db.backgroundJobReconciliation.count({ where: { projectId: cascadeProjectId } }), 0);

      const wrongActorJob = await db.backgroundJob.create({
        data: {
          id: randomUUID(),
          projectId,
          kind: "projectBrief",
          status: "unknown",
          stage: "reconciliation_required",
          failureCode: "RECONCILIATION_REQUIRED",
          reconciliationRequired: true,
          requestedById: user.id,
          idempotencyKey: `${"e".repeat(56)}${suffix}`,
          payload: {},
        },
      });
      await assert.rejects(
        () => reconcileProjectJob(projectId, wrongActorJob.id, randomUUID(), db),
        (error: unknown) => error instanceof ProjectWorkflowError && error.code === "PROJECT_WORKFLOW_INVALID_INPUT",
      );

      const specializedJob = await db.backgroundJob.create({
        data: {
          id: randomUUID(),
          projectId,
          kind: "memoryIndex",
          status: "unknown",
          stage: "reconciliation_required",
          failureCode: "RECONCILIATION_REQUIRED",
          reconciliationRequired: true,
          requestedById: user.id,
          idempotencyKey: `${"f".repeat(56)}${suffix}`,
          payload: {},
        },
      });
      await assert.rejects(
        () => reconcileProjectJob(projectId, specializedJob.id, user.id, db),
        (error: unknown) => error instanceof ProjectWorkflowError && error.code === "PROJECT_WORKFLOW_SPECIALIZED_OPERATION_REQUIRED",
      );
      await assert.rejects(
        () => db.backgroundJob.update({ where: { id: specializedJob.id }, data: { reconciliationRequired: false } }),
      );
      await assert.rejects(
        () => reconcileProjectJob(projectId, queuedJobId, user.id, db),
        (error: unknown) => error instanceof ProjectWorkflowError && error.code === "PROJECT_WORKFLOW_INVALID_STATE",
      );

      const interruptedClaim = await claimProjectJob(interruptedJobId, db);
      assert.notEqual(interruptedClaim, false);
      if (interruptedClaim === false) return;
      await db.backgroundJobAttempt.update({
        where: { id: interruptedClaim.attemptId },
        data: { leaseExpiresAt: new Date(Date.now() - 1) },
      });
      const reconciled = await reconcileProjectJob(projectId, interruptedJobId, user.id, db);
      assert.equal(reconciled.status, "unknown");
      assert.equal(reconciled.reconciliationRequired, false);
      assert.equal(reconciled.stage, "reconciled_unknown");
      assert.equal(await db.backgroundJobReconciliation.count({ where: { projectId, jobId: interruptedJobId } }), 1);
      assert.equal((await db.backgroundJobAttempt.findUniqueOrThrow({ where: { id: interruptedClaim.attemptId } })).status, "unknown");
      await assert.rejects(
        () => cancelProjectJob(projectId, interruptedJobId, db),
        (error: unknown) => error instanceof ProjectWorkflowError && error.code === "PROJECT_WORKFLOW_CANCEL_NOT_ALLOWED",
      );
      await assert.rejects(
        () => finishProjectJob({ jobId: interruptedJobId, ...interruptedClaim, result: { stale: true } }, db),
        (error: unknown) => error instanceof ProjectWorkflowError && error.code === "PROJECT_WORKFLOW_STALE_ATTEMPT",
      );

      const cancelled = await cancelProjectJob(projectId, queuedJobId, db);
      assert.equal(cancelled.status, "cancelled");
      await assert.rejects(
        () => cancelProjectJob(otherProjectId, queuedJobId, db),
        (error: unknown) => error instanceof ProjectWorkflowError && error.code === "PROJECT_WORKFLOW_PROJECT_MISMATCH",
      );
      const detail = await (await import("../src/lib/project-workflow")).getProjectJob(projectId, jobId, db);
      const serialized = JSON.stringify(detail);
      assert.doesNotMatch(serialized, /leaseTokenHash|claimToken/u);
    } finally {
      await db.project.deleteMany({ where: { id: { in: [projectId, otherProjectId] } } });
      if (createdUserId !== null) await db.appUser.deleteMany({ where: { id: createdUserId } });
    }
  },
);
