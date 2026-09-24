import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { getDb } from "../src/lib/db";
import { grantProjectMembership, grantWorkspaceMembership } from "../src/lib/membership-governance";
import {
  createPersonalKnowledgeDocument,
  revisePersonalKnowledgeDocument,
} from "../src/lib/personal-knowledge-service";
import {
  loadProjectPersonalDefaults,
  personalDefaultsForPrompt,
  requireUnchangedProjectPersonalDefaults,
  type ProjectPersonalDefaults,
} from "../src/lib/project-personal-default-memory";

const shouldRun = process.env.PROJECT_PERSONAL_DEFAULT_POSTGRES_GATE === "1";

test("project prompt receives only personal default titles and content", () => {
  const defaults: ProjectPersonalDefaults = {
    ownerUserId: randomUUID(), ownerAccountAccessVersion: 1, fingerprint: "test-fingerprint",
    documents: [{ documentId: randomUUID(), revisionId: randomUUID(), version: 2,
      title: "默认约定", content: "默认使用中文", contentHash: "test-content-hash" }],
  };
  assert.deepEqual(personalDefaultsForPrompt(defaults), [{ title: "默认约定", content: "默认使用中文" }]);
});

test("project AI loads only the caller's marked defaults and invalidates changed consent", {
  skip: !shouldRun ? "PROJECT_PERSONAL_DEFAULT_POSTGRES_GATE=1 is required" : false,
}, async () => {
  const db = getDb();
  const suffix = randomUUID().slice(0, 8);
  const ownerId = randomUUID();
  const teammateId = randomUUID();
  const outsiderId = randomUUID();
  const workspaceId = randomUUID();
  const projectA = randomUUID();
  const projectB = randomUUID();
  const owner = { id: ownerId, role: "user" as const, accountAccessVersion: 1 };
  const teammate = { id: teammateId, role: "user" as const, accountAccessVersion: 1 };
  const outsider = { id: outsiderId, role: "user" as const, accountAccessVersion: 1 };

  try {
    await db.appUser.createMany({ data: [
      { id: ownerId, username: `default_owner_${suffix}`, role: "user" },
      { id: teammateId, username: `default_teammate_${suffix}`, role: "user" },
      { id: outsiderId, username: `default_outsider_${suffix}`, role: "user" },
    ] });
    await db.$transaction(async (tx) => {
      await tx.workspace.create({ data: { id: workspaceId, name: `Default memory ${suffix}`, slug: `default-memory-${suffix}`, createdById: ownerId } });
      await grantWorkspaceMembership(tx, { workspaceId, userId: ownerId, role: "owner", actorId: ownerId, reason: "default_memory_gate" });
      await grantWorkspaceMembership(tx, { workspaceId, userId: teammateId, role: "member", actorId: ownerId, reason: "default_memory_gate" });
    });
    await db.project.createMany({ data: [
      { id: projectA, workspaceId, name: `Project A ${suffix}`, slug: `default-a-${suffix}` },
      { id: projectB, workspaceId, name: `Project B ${suffix}`, slug: `default-b-${suffix}` },
    ] });
    await db.$transaction(async (tx) => {
      await grantProjectMembership(tx, { projectId: projectA, workspaceId, userId: ownerId, role: "owner", actorId: ownerId, reason: "default_memory_gate" });
      await grantProjectMembership(tx, { projectId: projectB, workspaceId, userId: ownerId, role: "owner", actorId: ownerId, reason: "default_memory_gate" });
      await grantProjectMembership(tx, { projectId: projectA, workspaceId, userId: teammateId, role: "editor", actorId: ownerId, reason: "default_memory_gate" });
    });

    await createPersonalKnowledgeDocument({ title: "普通资料", content: "内部电话号码" }, owner, db);
    const ownerDefault = await createPersonalKnowledgeDocument({ title: "通用约定", content: "默认使用 Vue 3", isDefaultMemory: true }, owner, db);
    await createPersonalKnowledgeDocument({ title: "同事约定", content: "默认使用 Svelte", isDefaultMemory: true }, teammate, db);

    const ownerA = await loadProjectPersonalDefaults(projectA, owner, db);
    const ownerB = await loadProjectPersonalDefaults(projectB, owner, db);
    const teammateA = await loadProjectPersonalDefaults(projectA, teammate, db);
    assert.equal(ownerA.documents.length, 1);
    assert.deepEqual(personalDefaultsForPrompt(ownerA), [{ title: "通用约定", content: "默认使用 Vue 3" }]);
    assert.equal(ownerA.fingerprint, ownerB.fingerprint);
    assert.deepEqual(personalDefaultsForPrompt(teammateA), [{ title: "同事约定", content: "默认使用 Svelte" }]);
    await assert.rejects(() => loadProjectPersonalDefaults(projectB, teammate, db));
    await assert.rejects(() => loadProjectPersonalDefaults(projectA, outsider, db));

    await revisePersonalKnowledgeDocument(String(ownerDefault.id), { expectedVersion: 1, content: "默认使用 React" }, owner, db);
    await assert.rejects(
      () => requireUnchangedProjectPersonalDefaults(projectA, owner, ownerA.fingerprint, db),
      { code: "PROJECT_PERSONAL_DEFAULT_CHANGED" },
    );
    const updated = await loadProjectPersonalDefaults(projectA, owner, db);
    assert.deepEqual(personalDefaultsForPrompt(updated), [{ title: "通用约定", content: "默认使用 React" }]);

    await revisePersonalKnowledgeDocument(String(ownerDefault.id), { expectedVersion: 2, isDefaultMemory: false }, owner, db);
    const unmarked = await loadProjectPersonalDefaults(projectA, owner, db);
    assert.equal(unmarked.documents.length, 0);
    await assert.rejects(
      () => requireUnchangedProjectPersonalDefaults(projectA, owner, updated.fingerprint, db),
      { code: "PROJECT_PERSONAL_DEFAULT_CHANGED" },
    );
    await assert.rejects(
      () => createPersonalKnowledgeDocument({ title: "超长约定", content: "a".repeat(2_001), isDefaultMemory: true }, owner, db),
      { code: "PERSONAL_KNOWLEDGE_INVALID_INPUT" },
    );
    for (let index = 0; index < 8; index += 1) {
      await createPersonalKnowledgeDocument({ title: `默认约定 ${index}`, content: `约定 ${index}`, isDefaultMemory: true }, owner, db);
    }
    await assert.rejects(
      () => createPersonalKnowledgeDocument({ title: "第九条", content: "不能自动装配", isDefaultMemory: true }, owner, db),
      { code: "PERSONAL_KNOWLEDGE_DEFAULT_LIMIT_REACHED" },
    );
  } finally {
    await db.$disconnect();
  }
});
