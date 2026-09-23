import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { getDb } from "../src/lib/db";
import {
  createPersonalKnowledgeDocument,
  createPersonalKnowledgeRelation,
  deletePersonalKnowledgeDocument,
  getPersonalKnowledgeOverview,
  PersonalKnowledgeError,
  revisePersonalKnowledgeDocument,
} from "../src/lib/personal-knowledge-service";

const shouldRun = process.env.PERSONAL_KNOWLEDGE_POSTGRES_GATE === "1";

function serviceCode(error: unknown): string | null {
  return error instanceof PersonalKnowledgeError ? error.code : null;
}

test(
  "personal knowledge relations enforce owner, revision, lifecycle and capacity invariants in PostgreSQL",
  { skip: !shouldRun ? "PERSONAL_KNOWLEDGE_POSTGRES_GATE=1 is required" : false },
  async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (typeof databaseUrl !== "string" || databaseUrl.length === 0) {
      throw new Error("PERSONAL_KNOWLEDGE_POSTGRES_DATABASE_URL_REQUIRED");
    }
    const db = getDb();
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const ownerId = randomUUID();
    const otherOwnerId = randomUUID();
    const owner = { id: ownerId, role: "user" as const, accountAccessVersion: 1 };
    const otherOwner = { id: otherOwnerId, role: "user" as const, accountAccessVersion: 1 };
    const now = new Date("2026-09-22T00:00:00.000Z");
    let relationId: string | null = null;

    try {
      await db.appUser.createMany({
        data: [
          { id: ownerId, username: `personal_knowledge_owner_${suffix}`, role: "user" },
          { id: otherOwnerId, username: `personal_knowledge_other_${suffix}`, role: "user" },
        ],
      });

      const first = await createPersonalKnowledgeDocument(
        { title: "中文文档", content: "你好🙂" },
        owner,
        db,
        now,
      );
      const second = await createPersonalKnowledgeDocument(
        { title: "第二篇", content: "abc" },
        owner,
        db,
        new Date(now.getTime() + 1),
      );
      const other = await createPersonalKnowledgeDocument(
        { title: "他人的文档", content: "private" },
        otherOwner,
        db,
        now,
      );
      const firstId = String(first.id);
      const secondId = String(second.id);
      const otherId = String(other.id);

      const relation = await createPersonalKnowledgeRelation(
        { fromDocumentId: firstId, toDocumentId: secondId },
        owner,
        db,
        new Date(now.getTime() + 2),
      );
      relationId = String(relation.id);

      const firstRevision = await db.personalKnowledgeDocument.findUniqueOrThrow({
        where: { id: firstId },
        select: { currentRevisionId: true },
      });
      const secondRevision = await db.personalKnowledgeDocument.findUniqueOrThrow({
        where: { id: secondId },
        select: { currentRevisionId: true },
      });
      assert.ok(firstRevision.currentRevisionId);
      assert.ok(secondRevision.currentRevisionId);

      const initial = await getPersonalKnowledgeOverview(owner, db, new Date(now.getTime() + 3));
      assert.equal(initial.capacity.documentCount, 2);
      assert.equal(initial.capacity.usedBytes, Buffer.byteLength("你好🙂", "utf8") + Buffer.byteLength("abc", "utf8"));
      assert.equal(initial.capacity.limitBytes, null);
      assert.equal(initial.capacity.limitLabel, "未设置上限");
      assert.equal(initial.index.status, "not_available");
      assert.equal(initial.graph.nodes.length, 2);
      assert.equal(initial.graph.edges.length, 1);
      assert.equal(initial.graph.edges[0]?.stale, false);

      const otherOverview = await getPersonalKnowledgeOverview(otherOwner, db);
      assert.equal(otherOverview.capacity.documentCount, 1);
      assert.equal(otherOverview.graph.nodes.length, 1);
      assert.equal(otherOverview.graph.edges.length, 0);
      await assert.rejects(
        () => createPersonalKnowledgeRelation({ fromDocumentId: firstId, toDocumentId: otherId }, owner, db),
        (error: unknown) => serviceCode(error) === "PERSONAL_KNOWLEDGE_DOCUMENT_NOT_FOUND",
      );

      await assert.rejects(
        () => createPersonalKnowledgeRelation({ fromDocumentId: firstId, toDocumentId: secondId }, owner, db),
        (error: unknown) => serviceCode(error) === "PERSONAL_KNOWLEDGE_RELATION_CONFLICT",
      );
      await assert.rejects(
        () => createPersonalKnowledgeRelation({ fromDocumentId: firstId, toDocumentId: firstId }, owner, db),
        (error: unknown) => serviceCode(error) === "PERSONAL_KNOWLEDGE_INVALID_INPUT",
      );

      await assert.rejects(
        () => db.personalKnowledgeRelation.create({
          data: {
            id: randomUUID(),
            ownerUserId: ownerId,
            fromDocumentId: String(relation.fromDocumentId),
            fromRevisionId: String(relation.fromRevisionId),
            toDocumentId: String(relation.toDocumentId),
            toRevisionId: String(relation.toRevisionId),
            state: "active",
            createdAt: new Date(now.getTime() + 4),
            revokedAt: null,
          },
        }),
        (error: unknown) => error instanceof Error,
      );
      await assert.rejects(
        () => db.personalKnowledgeRelation.create({
          data: {
            id: randomUUID(),
            ownerUserId: ownerId,
            fromDocumentId: String(relation.fromDocumentId),
            fromRevisionId: String(relation.toRevisionId),
            toDocumentId: String(relation.toDocumentId),
            toRevisionId: String(relation.toRevisionId),
            state: "revoked",
            createdAt: new Date(now.getTime() + 5),
            revokedAt: new Date(now.getTime() + 5),
          },
        }),
        (error: unknown) => error instanceof Error,
      );
      await assert.rejects(
        () => db.personalKnowledgeRelation.create({
          data: {
            id: randomUUID(),
            ownerUserId: ownerId,
            fromDocumentId: firstId,
            fromRevisionId: String(firstRevision.currentRevisionId),
            toDocumentId: firstId,
            toRevisionId: String(firstRevision.currentRevisionId),
            state: "active",
            createdAt: new Date(now.getTime() + 6),
            revokedAt: null,
          },
        }),
        (error: unknown) => error instanceof Error,
      );

      await revisePersonalKnowledgeDocument(
        firstId,
        { expectedVersion: 1, content: "新版本🙂" },
        owner,
        db,
        new Date(now.getTime() + 7),
      );
      const stale = await getPersonalKnowledgeOverview(owner, db, new Date(now.getTime() + 8));
      assert.equal(stale.capacity.documentCount, 2);
      assert.equal(stale.capacity.usedBytes, Buffer.byteLength("新版本🙂", "utf8") + 3);
      assert.equal(stale.graph.edges[0]?.stale, true);

      await deletePersonalKnowledgeDocument(
        firstId,
        { expectedVersion: 2 },
        owner,
        db,
        new Date(now.getTime() + 9),
      );
      const revoked = await db.personalKnowledgeRelation.findUniqueOrThrow({
        where: { id: relationId },
        select: { state: true, revokedAt: true },
      });
      assert.equal(revoked.state, "revoked");
      assert.ok(revoked.revokedAt);
      const afterDelete = await getPersonalKnowledgeOverview(owner, db, new Date(now.getTime() + 10));
      assert.equal(afterDelete.capacity.documentCount, 1);
      assert.equal(afterDelete.capacity.usedBytes, Buffer.byteLength("abc", "utf8"));
      assert.equal(afterDelete.graph.edges.length, 0);
    } finally {
      // Personal knowledge documents and audits are intentionally durable and
      // audit rows are append-only. Remove only relation fixtures; the
      // disposable database is torn down by the gate runner.
      await db.personalKnowledgeRelation.deleteMany({ where: { ownerUserId: { in: [ownerId, otherOwnerId] } } });
    }
  },
);
