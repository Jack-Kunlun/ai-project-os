import "dotenv/config";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { ProjectItemRevisionAction, type Prisma } from "@prisma/client";
import { AccessControlError } from "../src/lib/access-control";
import { getDb } from "../src/lib/db";
import { appendProjectItemRevision, createPrimaryProjectItemEvidence } from "../src/lib/project-item-history";
import { ProjectWorldError, getProjectWorld, getProjectWorldSummaries, mutateProjectWorld } from "../src/lib/project-world";

const shouldRun = process.env.PROJECT_WORLD_POSTGRES_GATE === "1";

function assertDisposableDatabase(): void {
  const url = new URL(process.env.DATABASE_URL ?? "postgresql://invalid/invalid");
  assert.match(url.pathname, /^\/ai_project_os_v5_gate(?:_[a-z0-9_]+)?$/u, "project world gate requires a disposable ai_project_os_v5_gate database");
}

test("project world persists version-bound relations, supersession and immutable snapshots", { skip: !shouldRun ? "PROJECT_WORLD_POSTGRES_GATE=1 is required" : false }, async () => {
  assertDisposableDatabase();
  const db = getDb();
  const suffix = randomUUID().slice(0, 8);
  const adminId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const otherProjectId = randomUUID();
  const editor = { id: editorId, username: `world_editor_${suffix}`, role: "member" as const };
  const viewer = { id: viewerId, username: `world_viewer_${suffix}`, role: "member" as const };

  await db.appUser.createMany({ data: [
    { id: adminId, username: `world_admin_${suffix}`, role: "admin" },
    { id: editorId, username: editor.username, role: "member" },
    { id: viewerId, username: viewer.username, role: "member" },
  ] });
  await db.workspace.create({ data: { id: workspaceId, name: `World ${suffix}`, slug: `world-${suffix}`, createdById: adminId } });
  await db.workspaceMembership.create({ data: { workspaceId, userId: adminId, role: "owner" } });
  await db.project.createMany({ data: [
    { id: projectId, workspaceId, name: `World project ${suffix}`, slug: `world-project-${suffix}` },
    { id: otherProjectId, workspaceId, name: `Other project ${suffix}`, slug: `other-project-${suffix}` },
  ] });
  await db.projectMembership.createMany({ data: [
    { projectId, userId: editorId, role: "editor" },
    { projectId, userId: viewerId, role: "viewer" },
  ] });

  async function createFact(input: { projectId: string; type: "decision" | "progress"; title: string; advanceRevision?: boolean }) {
    const content = `${input.title} ${suffix}`;
    const contentHash = createHash("sha256").update(content, "utf8").digest("hex");
    return db.$transaction(async (tx) => {
      const source = await tx.projectSource.create({ data: { projectId: input.projectId, kind: "manual", contentText: content, contentHash, manualContentDedupeKey: contentHash } });
      let item = await tx.projectItem.create({ data: { projectId: input.projectId, sourceId: source.id, type: input.type, reviewStatus: "confirmed", title: input.title, content, sourceExcerpt: content, confirmedAt: new Date() } });
      const evidence = await createPrimaryProjectItemEvidence(tx, { projectId: input.projectId, projectItemId: item.id, projectSourceId: source.id, sourceText: content, sourceExcerpt: content, createdAt: item.createdAt });
      const firstRevision = await appendProjectItemRevision(tx, { item, action: ProjectItemRevisionAction.manualCreated, actorId: adminId, evidences: [evidence], createdAt: item.createdAt });
      let currentRevision = firstRevision;
      if (input.advanceRevision) {
        const changedAt = new Date(item.updatedAt.getTime() + 5);
        item = await tx.projectItem.update({ where: { id: item.id }, data: { importance: 61, updatedAt: changedAt } });
        currentRevision = await appendProjectItemRevision(tx, { item, action: ProjectItemRevisionAction.metadataUpdated, actorId: adminId, reason: "验证版本绑定", evidences: [evidence], createdAt: changedAt });
      }
      return { item, source, evidence, firstRevision, currentRevision };
    });
  }

  try {
    const provenanceFunctions = await db.$queryRaw<Array<{ definition: string }>>`
      SELECT pg_get_functiondef(p.oid) AS definition
      FROM pg_proc AS p
      JOIN pg_namespace AS n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname IN ('ai_candidate_item_provenance_guard', 'assert_ai_candidate_item_consistency')
      ORDER BY p.proname
    `;
    assert.equal(provenanceFunctions.length, 2);
    assert.ok(provenanceFunctions.every((entry) => entry.definition.includes("NOT IN ('confirmed', 'superseded')")));

    const predecessor = await createFact({ projectId, type: "decision", title: "旧技术决策" });
    const successor = await createFact({ projectId, type: "decision", title: "新技术决策", advanceRevision: true });
    const progress = await createFact({ projectId, type: "progress", title: "核心能力已验收" });
    const other = await createFact({ projectId: otherProjectId, type: "progress", title: "另一项目事实" });

    await assert.rejects(
      () => mutateProjectWorld(projectId, { operation: "captureState" }, viewer, db),
      (error: unknown) => error instanceof AccessControlError && error.code === "ACCESS_FORBIDDEN",
    );
    await assert.rejects(
      () => mutateProjectWorld(projectId, { operation: "createRelation", sourceItemId: predecessor.item.id, targetItemId: other.item.id, kind: "supports", rationale: "跨项目关系" }, editor, db),
      (error: unknown) => error instanceof ProjectWorldError && error.code === "PROJECT_WORLD_FACT_NOT_FOUND",
    );

    await assert.rejects(() => db.projectFactRelation.create({ data: {
      projectId,
      sourceItemId: successor.item.id,
      sourceRevisionId: successor.firstRevision.id,
      targetItemId: progress.item.id,
      targetRevisionId: progress.currentRevision.id,
      kind: "supports",
      rationale: "尝试绑定陈旧版本",
      fingerprint: "e".repeat(64),
      createdById: editor.id,
    } }));

    const relation = await mutateProjectWorld(projectId, { operation: "createRelation", sourceItemId: predecessor.item.id, targetItemId: progress.item.id, kind: "supports", rationale: "当前决策支持这项进展" }, editor, db);
    assert.ok("fingerprint" in relation);
    await assert.rejects(
      () => mutateProjectWorld(projectId, { operation: "createRelation", sourceItemId: predecessor.item.id, targetItemId: progress.item.id, kind: "supports", rationale: "重复关系" }, editor, db),
      (error: unknown) => error instanceof ProjectWorldError && error.code === "PROJECT_WORLD_RELATION_CONFLICT",
    );

    const before = await getProjectWorld(projectId, viewer, db);
    assert.equal(before.permission, "view");
    assert.equal(before.state.status, "on_track");
    assert.equal(before.relations.length, 1);
    assert.equal(before.relations[0]?.stale, false);
    const beforeSummary = (await getProjectWorldSummaries([projectId], db)).get(projectId)!;
    assert.equal(beforeSummary.status, before.state.status);
    assert.equal(beforeSummary.counts.activeFacts, before.state.counts.activeFacts);

    const firstCapture = await mutateProjectWorld(projectId, { operation: "captureState" }, editor, db);
    const secondCapture = await mutateProjectWorld(projectId, { operation: "captureState" }, editor, db);
    assert.ok("created" in firstCapture && firstCapture.created);
    assert.ok("created" in secondCapture && !secondCapture.created);
    assert.equal(firstCapture.snapshot.snapshotFingerprint, secondCapture.snapshot.snapshotFingerprint);
    await assert.rejects(() => db.projectWorldSnapshot.update({ where: { id: firstCapture.snapshot.id }, data: { status: "at_risk" } }));
    await assert.rejects(() => db.projectWorldSnapshot.delete({ where: { id: firstCapture.snapshot.id } }));

    await mutateProjectWorld(projectId, {
      operation: "supersedeFact",
      predecessorItemId: predecessor.item.id,
      successorItemId: successor.item.id,
      predecessorUpdatedAt: predecessor.item.updatedAt.toISOString(),
      successorUpdatedAt: successor.item.updatedAt.toISOString(),
      reason: "新决策已经通过人工确认并取代旧决策",
    }, editor, db);
    const after = await getProjectWorld(projectId, viewer, db);
    assert.equal(after.state.status, "needs_attention");
    assert.equal(after.state.counts.superseded, 1);
    assert.equal(after.state.counts.staleRelations, 1);
    assert.equal(after.relations[0]?.stale, true);
    const afterSummary = (await getProjectWorldSummaries([projectId], db)).get(projectId)!;
    assert.equal(afterSummary.status, after.state.status);
    assert.equal(afterSummary.counts.staleRelations, after.state.counts.staleRelations);
    const persistedFacts = await db.projectItem.findMany({ where: { id: { in: [predecessor.item.id, successor.item.id] } }, orderBy: { title: "asc" } });
    assert.equal(persistedFacts.find((fact) => fact.id === predecessor.item.id)?.reviewStatus, "superseded");
    assert.equal(persistedFacts.find((fact) => fact.id === successor.item.id)?.supersedesItemId, predecessor.item.id);
    assert.equal(await db.projectItemRevision.count({ where: { projectItemId: predecessor.item.id, action: "superseded" } }), 1);
    assert.equal(await db.projectItemRevision.count({ where: { projectItemId: successor.item.id, action: "supersessionLinked" } }), 1);

    await assert.rejects(
      () => mutateProjectWorld(projectId, { operation: "supersedeFact", predecessorItemId: successor.item.id, successorItemId: predecessor.item.id, predecessorUpdatedAt: after.facts.find((fact) => fact.id === successor.item.id)!.updatedAt.toISOString(), successorUpdatedAt: after.facts.find((fact) => fact.id === predecessor.item.id)!.updatedAt.toISOString(), reason: "尝试反向建立循环" }, editor, db),
      (error: unknown) => error instanceof ProjectWorldError && error.code === "PROJECT_WORLD_SUPERSESSION_CONFLICT",
    );

    await mutateProjectWorld(projectId, { operation: "retireRelation", relationId: relation.id, expectedFingerprint: relation.fingerprint, reason: "端点事实已经被替代" }, editor, db);
    const retired = await db.projectFactRelation.findUniqueOrThrow({ where: { id: relation.id } });
    assert.notEqual(retired.retiredAt, null);
    await assert.rejects(() => db.projectFactRelation.update({ where: { id: relation.id }, data: { rationale: "篡改历史" } }));
    const audit = await db.projectWorldAudit.findFirstOrThrow({ where: { projectId } });
    await assert.rejects(() => db.projectWorldAudit.update({ where: { id: audit.id }, data: { details: { changed: true } as Prisma.InputJsonValue } }));
    assert.ok(await db.projectWorldAudit.count({ where: { projectId } }) >= 4);
  } finally {
    await db.$disconnect();
  }
});
