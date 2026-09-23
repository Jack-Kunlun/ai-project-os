import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPersonalKnowledgeSemanticChunks,
  personalKnowledgeSemanticExcerpt,
  personalKnowledgeSemanticManifest,
  personalKnowledgeSemanticManifestFingerprint,
  personalKnowledgeSemanticSha256,
  personalKnowledgeSemanticTotalEntries,
} from "../src/lib/personal-knowledge-semantic-contract";
import {
  PersonalKnowledgeSemanticError,
  executePersonalKnowledgeSemantic,
  getPersonalKnowledgeSemanticOverview,
  preparePersonalKnowledgeSemantic,
} from "../src/lib/personal-knowledge-semantic-service";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const PROVIDER_ID = "33333333-3333-4333-8333-333333333333";
const CHALLENGE_ID = "44444444-4444-4444-8444-444444444444";

const semanticPrepareInput = {
  kind: "build" as const,
  providerId: PROVIDER_ID,
  clientKey: "semantic-contract-boundary",
};

const semanticExecuteInput = {
  challengeId: CHALLENGE_ID,
  clientKey: "semantic-contract-boundary",
};

function semanticCode(error: unknown): string {
  return error instanceof PersonalKnowledgeSemanticError ? error.code : "unexpected";
}

class NoDispatchSemanticDb {
  transactions = 0;
  rawQueries = 0;

  async $transaction(): Promise<never> {
    this.transactions += 1;
    throw new Error("database transaction should not start");
  }

  async $queryRaw(): Promise<never> {
    this.rawQueries += 1;
    throw new Error("database query should not start");
  }
}

const PAGE = {
  documentId: "11111111-1111-4111-8111-111111111111",
  revisionId: "22222222-2222-4222-8222-222222222222",
  version: 2,
  title: "知识页",
  content: "第一段内容。\n\n第二段内容，包含向量搜索引用。",
  contentHash: "",
};

test("语义索引拒绝非法请求键和管理员 actor，并在事务前停止", async () => {
  const db = new NoDispatchSemanticDb();
  await assert.rejects(
    () => preparePersonalKnowledgeSemantic(
      { ...semanticPrepareInput, clientKey: "bad key" },
      { id: OWNER_ID, role: "user", accountAccessVersion: 1 },
      db as never,
    ),
    (error: unknown) => semanticCode(error) === "PERSONAL_KNOWLEDGE_SEMANTIC_INVALID_INPUT",
  );
  await assert.rejects(
    () => preparePersonalKnowledgeSemantic(
      semanticPrepareInput,
      { id: OWNER_ID, role: "admin", accountAccessVersion: 1 },
      db as never,
    ),
    (error: unknown) => semanticCode(error) === "PERSONAL_KNOWLEDGE_SEMANTIC_FORBIDDEN",
  );
  assert.equal(db.transactions, 0);
  assert.equal(db.rawQueries, 0);
});

test("语义搜索执行拒绝非法挑战和过期账号快照，overview 同样不触碰数据库", async () => {
  const db = new NoDispatchSemanticDb();
  await assert.rejects(
    () => executePersonalKnowledgeSemantic(
      { ...semanticExecuteInput, challengeId: "invalid-challenge" },
      { id: OWNER_ID, role: "user", accountAccessVersion: 1 },
      db as never,
    ),
    (error: unknown) => semanticCode(error) === "PERSONAL_KNOWLEDGE_SEMANTIC_INVALID_INPUT",
  );
  await assert.rejects(
    () => executePersonalKnowledgeSemantic(
      semanticExecuteInput,
      { id: OWNER_ID, role: "user", accountAccessVersion: 0 },
      db as never,
    ),
    (error: unknown) => semanticCode(error) === "PERSONAL_KNOWLEDGE_SEMANTIC_ACCOUNT_ACCESS_STALE",
  );
  await assert.rejects(
    () => getPersonalKnowledgeSemanticOverview(
      { id: OWNER_ID, role: "admin", accountAccessVersion: 1 },
      db as never,
    ),
    (error: unknown) => semanticCode(error) === "PERSONAL_KNOWLEDGE_SEMANTIC_FORBIDDEN",
  );
  assert.equal(db.transactions, 0);
  assert.equal(db.rawQueries, 0);
});

test("semantic contract creates deterministic ranges and an owner-safe manifest", () => {
  const page = { ...PAGE, contentHash: personalKnowledgeSemanticSha256(PAGE.content) };
  const chunks = buildPersonalKnowledgeSemanticChunks(page);
  const manifest = personalKnowledgeSemanticManifest([{ page, chunks }]);
  assert.equal(personalKnowledgeSemanticTotalEntries(manifest), chunks.length);
  assert.equal(manifest[0]?.documentId, page.documentId);
  assert.equal(manifest[0]?.revisionId, page.revisionId);
  assert.equal("content" in (manifest[0] ?? {}), false);
  assert.equal("title" in (manifest[0] ?? {}), false);
  assert.equal(personalKnowledgeSemanticManifestFingerprint(manifest), personalKnowledgeSemanticManifestFingerprint(manifest));
  const first = chunks[0]!;
  assert.equal(personalKnowledgeSemanticExcerpt(page.content, first.rangeStart, first.rangeEnd), first.contentText);
});

test("semantic contract rejects a body whose hash does not match the current revision", () => {
  assert.throws(
    () => buildPersonalKnowledgeSemanticChunks(PAGE),
    /PERSONAL_KNOWLEDGE_SEMANTIC_INVALID_PAGE/u,
  );
});

test("semantic excerpt rejects ranges outside UTF-8 byte boundaries", () => {
  const content = "知识";
  assert.throws(
    () => personalKnowledgeSemanticExcerpt(content, 1, 3),
    /PERSONAL_KNOWLEDGE_SEMANTIC_INVALID_RANGE/u,
  );
});
