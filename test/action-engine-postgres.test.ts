import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { AccessControlError } from "../src/lib/access-control";
import {
  ActionEngineError,
  cancelProjectAction,
  decideProjectAction,
  requestProjectAction,
  runProjectActionWorkerCycle,
  updateProjectActionPolicy,
} from "../src/lib/action-engine";
import { getDb } from "../src/lib/db";
import { updateProjectLifecycle } from "../src/lib/project-lifecycle";

const shouldRun = process.env.ACTION_ENGINE_POSTGRES_GATE === "1";

test("Action Engine persists policy, approval, execution, recovery and archive boundaries", { skip: !shouldRun ? "ACTION_ENGINE_POSTGRES_GATE=1 is required" : false }, async () => {
  const db = getDb();
  const suffix = randomUUID().slice(0, 8);
  const adminId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const admin = { id: adminId, role: "admin" as const };
  const editor = { id: editorId, role: "member" as const };
  const viewer = { id: viewerId, role: "member" as const };

  await db.appUser.createMany({ data: [
    { id: adminId, username: `action_admin_${suffix}`, role: "admin" },
    { id: editorId, username: `action_editor_${suffix}`, role: "member" },
    { id: viewerId, username: `action_viewer_${suffix}`, role: "member" },
  ] });
  await db.workspace.create({ data: { id: workspaceId, name: `Action ${suffix}`, slug: `action-${suffix}`, createdById: adminId } });
  await db.workspaceMembership.createMany({ data: [
    { workspaceId, userId: adminId, role: "owner" },
    { workspaceId, userId: editorId, role: "member" },
    { workspaceId, userId: viewerId, role: "viewer" },
  ] });
  await db.project.create({ data: { id: projectId, workspaceId, name: `Action project ${suffix}`, slug: `action-project-${suffix}` } });
  await db.projectMembership.createMany({ data: [
    { projectId, userId: editorId, role: "editor" },
    { projectId, userId: viewerId, role: "viewer" },
  ] });

  try {
    await assert.rejects(
      () => requestProjectAction(projectId, { capability: "project.memory-quality.scan", input: {}, clientRequestId: randomUUID() }, viewer),
      (error: unknown) => error instanceof AccessControlError && error.code === "ACCESS_FORBIDDEN",
    );

    const automaticRequestId = randomUUID();
    const automatic = await requestProjectAction(projectId, { capability: "project.memory-quality.scan", input: {}, clientRequestId: automaticRequestId }, editor);
    assert.equal((await requestProjectAction(projectId, { capability: "project.memory-quality.scan", input: {}, clientRequestId: automaticRequestId }, editor)).id, automatic.id);
    await assert.rejects(
      () => requestProjectAction(projectId, { capability: "project.repository.sync", input: {}, clientRequestId: automaticRequestId }, editor),
      (error: unknown) => error instanceof ActionEngineError && error.code === "ACTION_IDEMPOTENCY_CONFLICT",
    );
    assert.equal(automatic.status, "queued");
    assert.equal((await runProjectActionWorkerCycle({ workerId: `action-test:${suffix}`, maximumActions: 1 }, db)).succeeded, 1);
    assert.equal((await db.projectAction.findUniqueOrThrow({ where: { id: automatic.id } })).status, "succeeded");
    assert.deepEqual(await db.projectActionAudit.findMany({ where: { actionId: automatic.id }, orderBy: { createdAt: "asc" }, select: { event: true } }), [
      { event: "requested" }, { event: "queued" }, { event: "claimed" }, { event: "succeeded" },
    ]);

    const policy = await updateProjectActionPolicy(projectId, "project.memory-quality.scan", { mode: "approvalRequired", expectedUpdatedAt: null }, admin, db);
    assert.equal(policy.mode, "approvalRequired");
    const waiting = await requestProjectAction(projectId, { capability: "project.memory-quality.scan", input: {}, clientRequestId: randomUUID() }, editor, db);
    assert.equal(waiting.status, "waitingApproval");
    await assert.rejects(
      () => decideProjectAction(projectId, waiting.id, { decision: "approved", expectedUpdatedAt: waiting.updatedAt.toISOString(), expectedFingerprint: waiting.inputFingerprint, note: null }, editor, db),
      (error: unknown) => error instanceof AccessControlError && error.code === "ACCESS_FORBIDDEN",
    );
    const approved = await decideProjectAction(projectId, waiting.id, { decision: "approved", expectedUpdatedAt: waiting.updatedAt.toISOString(), expectedFingerprint: waiting.inputFingerprint, note: "已核对本地能力" }, admin, db);
    assert.equal(approved.status, "queued");
    assert.equal(approved.approval?.decision, "approved");
    assert.equal((await runProjectActionWorkerCycle({ workerId: `action-test:${suffix}`, maximumActions: 1 }, db)).succeeded, 1);

    const rejectedWaiting = await requestProjectAction(projectId, { capability: "project.memory-quality.scan", input: {}, clientRequestId: randomUUID() }, editor, db);
    const rejected = await decideProjectAction(projectId, rejectedWaiting.id, { decision: "rejected", expectedUpdatedAt: rejectedWaiting.updatedAt.toISOString(), expectedFingerprint: rejectedWaiting.inputFingerprint, note: "当前不需要" }, admin, db);
    assert.equal(rejected.status, "rejected");

    const approvalPolicy = await db.projectActionPolicy.findUniqueOrThrow({ where: { projectId_capability: { projectId, capability: "project.memory-quality.scan" } } });
    const denied = await updateProjectActionPolicy(projectId, "project.memory-quality.scan", { mode: "denied", expectedUpdatedAt: approvalPolicy.updatedAt.toISOString() }, admin, db);
    assert.equal(denied.mode, "denied");
    await assert.rejects(
      () => requestProjectAction(projectId, { capability: "project.memory-quality.scan", input: {}, clientRequestId: randomUUID() }, editor, db),
      (error: unknown) => error instanceof ActionEngineError && error.code === "ACTION_POLICY_DENIED",
    );

    const automaticPolicy = await updateProjectActionPolicy(projectId, "project.memory-quality.scan", { mode: "automatic", expectedUpdatedAt: denied.updatedAt.toISOString() }, admin, db);
    const cancellable = await requestProjectAction(projectId, { capability: "project.memory-quality.scan", input: {}, clientRequestId: randomUUID() }, editor, db);
    const cancelled = await cancelProjectAction(projectId, cancellable.id, { expectedUpdatedAt: cancellable.updatedAt.toISOString() }, editor, db);
    assert.equal(cancelled.status, "cancelled");

    const approvalAgain = await updateProjectActionPolicy(projectId, "project.memory-quality.scan", { mode: "approvalRequired", expectedUpdatedAt: automaticPolicy.updatedAt.toISOString() }, admin, db);
    const expiring = await requestProjectAction(projectId, { capability: "project.memory-quality.scan", input: {}, clientRequestId: randomUUID() }, editor, db);
    await db.projectAction.update({ where: { id: expiring.id }, data: { approvalExpiresAt: new Date(Date.now() - 1000) } });
    const expirationCycle = await runProjectActionWorkerCycle({ workerId: `action-test:${suffix}`, maximumActions: 1 }, db);
    assert.equal(expirationCycle.expiredApprovals, 1);
    assert.equal((await db.projectAction.findUniqueOrThrow({ where: { id: expiring.id } })).status, "expired");

    const automaticAgain = await updateProjectActionPolicy(projectId, "project.memory-quality.scan", { mode: "automatic", expectedUpdatedAt: approvalAgain.updatedAt.toISOString() }, admin, db);
    assert.equal(automaticAgain.mode, "automatic");
    const leaseAction = await requestProjectAction(projectId, { capability: "project.memory-quality.scan", input: {}, clientRequestId: randomUUID() }, editor, db);
    const expiredAt = new Date(Date.now() - 1000);
    await db.projectAction.update({ where: { id: leaseAction.id }, data: { status: "running", workerId: `expired:${suffix}`, leaseExpiresAt: expiredAt, startedAt: expiredAt, attemptCount: 1 } });
    const recovery = await runProjectActionWorkerCycle({ workerId: `action-test:${suffix}`, maximumActions: 1 }, db);
    assert.equal(recovery.recoveredLeases, 1);
    const recovered = await db.projectAction.findUniqueOrThrow({ where: { id: leaseAction.id } });
    assert.equal(recovered.status, "failed");
    assert.equal(recovered.failureCode, "ACTION_LEASE_EXPIRED");

    const archivePending = await requestProjectAction(projectId, { capability: "project.memory-quality.scan", input: {}, clientRequestId: randomUUID() }, editor, db);
    const project = await db.project.findUniqueOrThrow({ where: { id: projectId }, select: { updatedAt: true } });
    await updateProjectLifecycle({ projectId, actorId: adminId, action: "archive", expectedUpdatedAt: project.updatedAt }, db);
    assert.equal((await db.projectAction.findUniqueOrThrow({ where: { id: archivePending.id } })).status, "cancelled");
    assert.equal(await db.projectActionPolicyRevision.count({ where: { projectId } }), 5);

    const approval = await db.projectActionApproval.findUniqueOrThrow({ where: { actionId: waiting.id } });
    await assert.rejects(() => db.projectActionApproval.update({ where: { id: approval.id }, data: { note: "不可修改" } }));
    const audit = await db.projectActionAudit.findFirstOrThrow({ where: { actionId: automatic.id } });
    await assert.rejects(() => db.projectActionAudit.update({ where: { id: audit.id }, data: { details: { changed: true } } }));
  } finally {
    await db.project.deleteMany({ where: { id: projectId } });
    await db.workspace.deleteMany({ where: { id: workspaceId } });
    await db.appUser.deleteMany({ where: { id: { in: [adminId, editorId, viewerId] } } });
  }
});
