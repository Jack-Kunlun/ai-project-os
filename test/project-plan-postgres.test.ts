import "dotenv/config";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { ProjectItemRevisionAction } from "@prisma/client";
import { AccessControlError } from "../src/lib/access-control";
import { createProjectAutomationRule, runAutomationWorkerCycle } from "../src/lib/automation";
import { getDb } from "../src/lib/db";
import { ProjectLifecycleError } from "../src/lib/project-lifecycle";
import { buildRepositoryImpactEvidence } from "../src/lib/project-operations";
import { appendProjectItemRevision, createPrimaryProjectItemEvidence } from "../src/lib/project-item-history";
import { ProjectPlanError, createProjectPlanEntry, getProjectPlan, updateProjectPlanEntry } from "../src/lib/project-plan";

const shouldRun = process.env.PROJECT_PLAN_POSTGRES_GATE === "1";

test("project plan persists governed objectives, work items, dependencies and audit", { skip: !shouldRun ? "PROJECT_PLAN_POSTGRES_GATE=1 is required" : false }, async () => {
  const db = getDb();
  const suffix = randomUUID().slice(0, 8);
  const adminId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();
  const outsiderId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const admin = { id: adminId, role: "admin" as const };
  const editor = { id: editorId, role: "member" as const };
  const viewer = { id: viewerId, role: "member" as const };

  await db.appUser.createMany({ data: [
    { id: adminId, username: `plan_admin_${suffix}`, role: "admin" },
    { id: editorId, username: `plan_editor_${suffix}`, role: "member" },
    { id: viewerId, username: `plan_viewer_${suffix}`, role: "member" },
    { id: outsiderId, username: `plan_outsider_${suffix}`, role: "member" },
  ] });
  await db.workspace.create({ data: { id: workspaceId, name: `Plan ${suffix}`, slug: `plan-${suffix}`, createdById: adminId } });
  await db.workspaceMembership.create({ data: { workspaceId, userId: adminId, role: "owner" } });
  await db.project.create({ data: { id: projectId, workspaceId, name: `Plan project ${suffix}`, slug: `plan-project-${suffix}` } });
  await db.projectMembership.createMany({ data: [
    { projectId, userId: editorId, role: "editor" },
    { projectId, userId: viewerId, role: "viewer" },
  ] });

  try {
    await assert.rejects(
      () => createProjectPlanEntry(projectId, { operation: "createObjective", title: "无权目标" }, viewer, db),
      (error: unknown) => error instanceof AccessControlError && error.code === "ACCESS_FORBIDDEN",
    );
    const createdObjective = await createProjectPlanEntry(projectId, { operation: "createObjective", title: "发布闭环", description: "完成验证与部署", targetDate: "2026-09-05" }, editor, db);
    assert.ok("objective" in createdObjective);
    const objective = createdObjective.objective!;
    assert.equal(objective.status, "draft");
    await assert.rejects(
      () => updateProjectPlanEntry(projectId, { entity: "objective", id: objective.id, expectedUpdatedAt: new Date(0).toISOString(), status: "active" }, editor, db),
      (error: unknown) => error instanceof ProjectPlanError && error.code === "PROJECT_PLAN_VERSION_CONFLICT",
    );
    const active = await updateProjectPlanEntry(projectId, { entity: "objective", id: objective.id, expectedUpdatedAt: objective.updatedAt.toISOString(), status: "active" }, editor, db);
    assert.ok("objective" in active);
    const activeObjective = active.objective!;
    assert.equal(activeObjective.status, "active");

    const firstResult = await createProjectPlanEntry(projectId, { operation: "createWorkItem", title: "A", objectiveId: objective.id, priority: "high" }, editor, db);
    const secondResult = await createProjectPlanEntry(projectId, { operation: "createWorkItem", title: "B", objectiveId: objective.id }, editor, db);
    const thirdResult = await createProjectPlanEntry(projectId, { operation: "createWorkItem", title: "C" }, editor, db);
    assert.ok("workItem" in firstResult && firstResult.workItem !== undefined);
    assert.ok("workItem" in secondResult && secondResult.workItem !== undefined);
    assert.ok("workItem" in thirdResult && thirdResult.workItem !== undefined);
    const first = firstResult.workItem;
    const second = secondResult.workItem;
    const third = thirdResult.workItem;
    const firstDependencyResult = await createProjectPlanEntry(projectId, { operation: "addDependency", workItemId: first.id, dependsOnId: second.id, expectedUpdatedAt: first.updatedAt.toISOString() }, editor, db);
    assert.ok("dependency" in firstDependencyResult && firstDependencyResult.dependency !== undefined);
    const firstDependency = firstDependencyResult.dependency;
    const currentSecond = await db.projectWorkItem.findUniqueOrThrow({ where: { id: second.id } });
    await createProjectPlanEntry(projectId, { operation: "addDependency", workItemId: second.id, dependsOnId: third.id, expectedUpdatedAt: currentSecond.updatedAt.toISOString() }, editor, db);
    const currentThird = await db.projectWorkItem.findUniqueOrThrow({ where: { id: third.id } });
    await assert.rejects(
      () => createProjectPlanEntry(projectId, { operation: "addDependency", workItemId: third.id, dependsOnId: first.id, expectedUpdatedAt: currentThird.updatedAt.toISOString() }, editor, db),
      (error: unknown) => error instanceof ProjectPlanError && error.code === "PROJECT_PLAN_DEPENDENCY_CYCLE",
    );
    const currentFirst = await db.projectWorkItem.findUniqueOrThrow({ where: { id: first.id } });
    await createProjectPlanEntry(projectId, { operation: "removeDependency", dependencyId: firstDependency.id, expectedUpdatedAt: currentFirst.updatedAt.toISOString() }, editor, db);
    assert.notEqual((await db.projectWorkItemDependency.findUniqueOrThrow({ where: { id: firstDependency.id } })).removedAt, null);

    const sourceContent = `运营证据 ${suffix}`;
    const sourceHash = createHash("sha256").update(sourceContent, "utf8").digest("hex");
    const source = await db.projectSource.create({ data: { projectId, kind: "manual", contentText: sourceContent, contentHash: sourceHash, manualContentDedupeKey: sourceHash } });
    const confirmedItem = await db.$transaction(async (tx) => {
      const created = await tx.projectItem.create({ data: { projectId, sourceId: source.id, type: "progress", reviewStatus: "confirmed", title: "运营验收证据", content: "目标行为已通过核对。", sourceExcerpt: sourceContent, confirmedAt: new Date() } });
      const primaryEvidence = await createPrimaryProjectItemEvidence(tx, { projectId, projectItemId: created.id, projectSourceId: source.id, sourceText: sourceContent, sourceExcerpt: sourceContent, createdAt: created.createdAt });
      await appendProjectItemRevision(tx, { item: created, action: ProjectItemRevisionAction.manualCreated, actorId: adminId, evidences: [primaryEvidence], createdAt: created.createdAt });
      return created;
    });
    const operationalResult = await createProjectPlanEntry(projectId, { operation: "createWorkItem", title: "运营闭环", objectiveId: objective.id }, editor, db);
    assert.ok("workItem" in operationalResult && operationalResult.workItem !== undefined);
    const operational = operationalResult.workItem;
    await assert.rejects(
      () => updateProjectPlanEntry(projectId, { entity: "workItem", id: operational.id, expectedUpdatedAt: operational.updatedAt.toISOString(), status: "inProgress" }, editor, db),
      (error: unknown) => error instanceof ProjectPlanError && error.code === "PROJECT_PLAN_READINESS_REQUIRED",
    );
    await assert.rejects(
      () => updateProjectPlanEntry(projectId, { entity: "workItem", id: operational.id, expectedUpdatedAt: operational.updatedAt.toISOString(), assigneeId: outsiderId }, editor, db),
      (error: unknown) => error instanceof ProjectPlanError && error.code === "PROJECT_PLAN_ASSIGNEE_NOT_ELIGIBLE",
    );
    await assert.rejects(
      () => updateProjectPlanEntry(projectId, { entity: "workItem", id: operational.id, expectedUpdatedAt: operational.updatedAt.toISOString(), assigneeId: viewerId }, editor, db),
      (error: unknown) => error instanceof ProjectPlanError && error.code === "PROJECT_PLAN_ASSIGNEE_NOT_ELIGIBLE",
    );
    const readyResult = await updateProjectPlanEntry(projectId, { entity: "workItem", id: operational.id, expectedUpdatedAt: operational.updatedAt.toISOString(), assigneeId: editorId, acceptanceCriteria: "至少关联一条已确认事实并完成人工验收" }, editor, db);
    assert.ok("workItem" in readyResult && readyResult.workItem !== undefined);
    const ready = readyResult.workItem;
    const linked = await createProjectPlanEntry(projectId, { operation: "linkEvidence", workItemId: operational.id, evidenceKind: "projectItem", evidenceId: confirmedItem.id, expectedUpdatedAt: ready.updatedAt.toISOString() }, editor, db);
    assert.ok("evidenceLinkId" in linked);
    const evidenceLink = await db.projectWorkItemEvidenceLink.findUniqueOrThrow({ where: { id: linked.evidenceLinkId }, select: { id: true, evidenceFingerprint: true, evidenceSnapshot: true } });
    assert.match(evidenceLink.evidenceFingerprint, /^[0-9a-f]{64}$/u);
    await assert.rejects(() => db.projectWorkItemEvidenceLink.update({ where: { id: evidenceLink.id }, data: { label: "篡改" } }));
    const readyCurrent = await db.projectWorkItem.findUniqueOrThrow({ where: { id: operational.id } });
    const startedResult = await updateProjectPlanEntry(projectId, { entity: "workItem", id: operational.id, expectedUpdatedAt: readyCurrent.updatedAt.toISOString(), status: "inProgress" }, editor, db);
    assert.ok("workItem" in startedResult && startedResult.workItem !== undefined);
    const completedWorkResult = await updateProjectPlanEntry(projectId, { entity: "workItem", id: operational.id, expectedUpdatedAt: startedResult.workItem.updatedAt.toISOString(), status: "completed" }, editor, db);
    assert.ok("workItem" in completedWorkResult && completedWorkResult.workItem !== undefined);
    await assert.rejects(() => db.projectWorkItem.update({ where: { id: operational.id }, data: { title: "终态篡改" } }));
    await assert.rejects(() => db.projectWorkItemEvidenceLink.delete({ where: { id: evidenceLink.id } }));

    const parentJob = await db.backgroundJob.create({ data: { projectId, kind: "githubProjectSync", status: "succeeded", stage: "terminal", payload: {}, result: {}, idempotencyKey: createHash("sha256").update(`plan-impact-${suffix}`, "utf8").digest("hex"), requestedById: adminId, completedAt: new Date() } });
    const syncRun = await db.projectGitHubSyncRun.create({ data: { projectId, parentJobId: parentJob.id, status: "succeeded", stage: "terminal", scopeFingerprint: "a".repeat(64), manifestFingerprint: "b".repeat(64), deadlineAt: new Date(Date.now() + 60_000), addedCount: 1, completedAt: new Date() } });
    const impactEvidence = buildRepositoryImpactEvidence({ projectId, run: { id: syncRun.id, manifestFingerprint: "b".repeat(64), completedAt: syncRun.completedAt!, addedCount: 1, updatedCount: 0, deletedCount: 0, withheldCount: 0 }, changes: [{ identity: "src/new.ts", changeType: "added", targetKind: "code", normalizedPath: "src/new.ts", remoteIdentity: null, beforeContentHash: null, afterContentHash: "c".repeat(64) }] });
    const impact = await db.projectPlanImpactSuggestion.create({ data: { projectId, repositorySyncRunId: syncRun.id, title: impactEvidence.title, summary: impactEvidence.summary, evidenceSnapshot: impactEvidence.snapshot, evidenceFingerprint: impactEvidence.fingerprint } });
    const secondCurrentForImpact = await db.projectWorkItem.findUniqueOrThrow({ where: { id: second.id } });
    const linkedImpact = await createProjectPlanEntry(projectId, { operation: "linkImpact", impactId: impact.id, workItemId: second.id, expectedUpdatedAt: secondCurrentForImpact.updatedAt.toISOString() }, editor, db);
    assert.ok("acknowledgedImpactId" in linkedImpact);
    assert.equal((await db.projectPlanImpactSuggestion.findUniqueOrThrow({ where: { id: impact.id } })).status, "acknowledged");
    await assert.rejects(() => db.projectPlanImpactSuggestion.update({ where: { id: impact.id }, data: { status: "dismissed" } }));

    const secondCurrentForAssignment = await db.projectWorkItem.findUniqueOrThrow({ where: { id: second.id } });
    const assignedSecondResult = await updateProjectPlanEntry(projectId, { entity: "workItem", id: second.id, expectedUpdatedAt: secondCurrentForAssignment.updatedAt.toISOString(), assigneeId: editorId, acceptanceCriteria: "完成仓库变化核对" }, editor, db);
    assert.ok("workItem" in assignedSecondResult && assignedSecondResult.workItem !== undefined);
    const revokedRule = await createProjectAutomationRule(projectId, { name: `Revoked plan health ${suffix}`, kind: "projectPlanHealth", intervalMinutes: 60, config: { dueSoonDays: 3, includeAssignees: true }, startAt: new Date().toISOString() }, editor, db);
    await db.projectMembership.delete({ where: { projectId_userId: { projectId, userId: editorId } } });
    await assert.rejects(
      () => updateProjectPlanEntry(projectId, { entity: "workItem", id: second.id, expectedUpdatedAt: assignedSecondResult.workItem.updatedAt.toISOString(), status: "inProgress" }, admin, db),
      (error: unknown) => error instanceof ProjectPlanError && error.code === "PROJECT_PLAN_ASSIGNEE_NOT_ELIGIBLE",
    );
    const revokedWorkerResult = await runAutomationWorkerCycle({ workerId: `plan-health-revoked-${suffix}`, maximumRuns: 1 }, db);
    assert.equal(revokedWorkerResult.succeeded, 1);
    assert.equal((await db.automationRun.findFirstOrThrow({ where: { automationRuleId: revokedRule.id } })).status, "succeeded");
    assert.equal(await db.notification.count({ where: { projectId, userId: editorId, kind: "projectPlanHealth" } }), 0);

    const healthRule = await createProjectAutomationRule(projectId, { name: `Plan health ${suffix}`, kind: "projectPlanHealth", intervalMinutes: 60, config: { dueSoonDays: 3, includeAssignees: true }, startAt: new Date().toISOString() }, admin, db);
    const workerResult = await runAutomationWorkerCycle({ workerId: `plan-health-${suffix}`, maximumRuns: 1 }, db);
    assert.equal(workerResult.succeeded, 1);
    assert.equal((await db.automationRun.findFirstOrThrow({ where: { automationRuleId: healthRule.id } })).status, "succeeded");
    assert.ok(await db.notification.count({ where: { projectId, kind: "projectPlanHealth" } }) >= 1);

    const audit = await db.projectPlanAudit.findFirstOrThrow({ where: { projectId } });
    await assert.rejects(() => db.projectPlanAudit.update({ where: { id: audit.id }, data: { details: { changed: true } } }));
    await assert.rejects(() => db.projectWorkItemDependency.delete({ where: { id: firstDependency.id } }));
    const viewerPlan = await getProjectPlan(projectId, viewer, db);
    assert.equal(viewerPlan.canEdit, false);
    assert.equal(viewerPlan.objectives.length, 1);
    assert.equal(viewerPlan.workItems.length, 4);
    assert.equal(viewerPlan.dependencies.length, 1);
    assert.equal(viewerPlan.evidenceLinks.length, 2);
    assert.equal(viewerPlan.impactSuggestions[0]?.status, "acknowledged");

    const completed = await updateProjectPlanEntry(projectId, { entity: "objective", id: objective.id, expectedUpdatedAt: activeObjective.updatedAt.toISOString(), status: "completed" }, admin, db);
    assert.ok("objective" in completed);
    const completedObjective = completed.objective!;
    assert.notEqual(completedObjective.completedAt, null);
    await assert.rejects(
      () => updateProjectPlanEntry(projectId, { entity: "objective", id: objective.id, expectedUpdatedAt: completedObjective.updatedAt.toISOString(), status: "active" }, admin, db),
      (error: unknown) => error instanceof ProjectPlanError && error.code === "PROJECT_PLAN_STATUS_CONFLICT",
    );
    await db.project.update({ where: { id: projectId }, data: { archivedAt: new Date() } });
    await assert.rejects(
      () => createProjectPlanEntry(projectId, { operation: "createWorkItem", title: "归档后写入" }, admin, db),
      (error: unknown) => error instanceof ProjectLifecycleError && error.code === "PROJECT_ARCHIVED",
    );
  } finally {
    await db.project.deleteMany({ where: { id: projectId } });
    await db.workspace.deleteMany({ where: { id: workspaceId } });
    await db.appUser.deleteMany({ where: { id: { in: [adminId, editorId, viewerId, outsiderId] } } });
  }
});
