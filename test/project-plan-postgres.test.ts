import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { AccessControlError } from "../src/lib/access-control";
import { getDb } from "../src/lib/db";
import { ProjectLifecycleError } from "../src/lib/project-lifecycle";
import { ProjectPlanError, createProjectPlanEntry, getProjectPlan, updateProjectPlanEntry } from "../src/lib/project-plan";

const shouldRun = process.env.PROJECT_PLAN_POSTGRES_GATE === "1";

test("project plan persists governed objectives, work items, dependencies and audit", { skip: !shouldRun ? "PROJECT_PLAN_POSTGRES_GATE=1 is required" : false }, async () => {
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
    { id: adminId, username: `plan_admin_${suffix}`, role: "admin" },
    { id: editorId, username: `plan_editor_${suffix}`, role: "member" },
    { id: viewerId, username: `plan_viewer_${suffix}`, role: "member" },
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

    const audit = await db.projectPlanAudit.findFirstOrThrow({ where: { projectId } });
    await assert.rejects(() => db.projectPlanAudit.update({ where: { id: audit.id }, data: { details: { changed: true } } }));
    await assert.rejects(() => db.projectWorkItemDependency.delete({ where: { id: firstDependency.id } }));
    const viewerPlan = await getProjectPlan(projectId, viewer, db);
    assert.equal(viewerPlan.canEdit, false);
    assert.equal(viewerPlan.objectives.length, 1);
    assert.equal(viewerPlan.workItems.length, 3);
    assert.equal(viewerPlan.dependencies.length, 1);

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
      () => createProjectPlanEntry(projectId, { operation: "createWorkItem", title: "归档后写入" }, editor, db),
      (error: unknown) => error instanceof ProjectLifecycleError && error.code === "PROJECT_ARCHIVED",
    );
  } finally {
    await db.project.deleteMany({ where: { id: projectId } });
    await db.workspace.deleteMany({ where: { id: workspaceId } });
    await db.appUser.deleteMany({ where: { id: { in: [adminId, editorId, viewerId] } } });
  }
});
