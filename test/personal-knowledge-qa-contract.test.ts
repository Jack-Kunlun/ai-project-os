import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPersonalKnowledgeQaEvidence,
  buildPersonalKnowledgeQaMessages,
  parsePersonalKnowledgeQaModelOutput,
  personalKnowledgeQaEvidenceManifest,
  personalKnowledgeQaSha256,
} from "../src/lib/personal-knowledge-qa-contract";
import {
  PersonalKnowledgeQaError,
  executePersonalKnowledgeQa,
  preparePersonalKnowledgeQa,
} from "../src/lib/personal-knowledge-qa-service";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const PROVIDER_ID = "22222222-2222-4222-8222-222222222222";
const CHALLENGE_ID = "33333333-3333-4333-8333-333333333333";

const qaPrepareInput = {
  question: "人工审核需要什么？",
  clientKey: "qa-contract-boundary",
  providerId: PROVIDER_ID,
};

const qaExecuteInput = {
  challengeId: CHALLENGE_ID,
  question: "人工审核需要什么？",
  clientKey: "qa-contract-boundary",
};

function qaCode(error: unknown): string {
  return error instanceof PersonalKnowledgeQaError ? error.code : "unexpected";
}

class NoDispatchQaDb {
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

const page = {
  documentId: "11111111-1111-4111-8111-111111111111",
  revisionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  version: 2,
  title: "产品规则",
  content: "订单必须经过人工审核后才能发布。\n\n发布前需要确认来源和版本。",
  contentHash: personalKnowledgeQaSha256("订单必须经过人工审核后才能发布。\n\n发布前需要确认来源和版本。"),
};

test("个人页面问答拒绝非法请求键和未授权角色，并在数据库事务前停止", async () => {
  const db = new NoDispatchQaDb();
  await assert.rejects(
    () => preparePersonalKnowledgeQa(
      page.documentId,
      { ...qaPrepareInput, clientKey: "bad key" },
      { id: OWNER_ID, role: "user", accountAccessVersion: 1 },
      db as never,
    ),
    (error: unknown) => qaCode(error) === "PERSONAL_KNOWLEDGE_QA_INVALID_INPUT",
  );
  await assert.rejects(
    () => preparePersonalKnowledgeQa(
      page.documentId,
      qaPrepareInput,
      { id: OWNER_ID, role: "admin", accountAccessVersion: 1 },
      db as never,
    ),
    (error: unknown) => qaCode(error) === "PERSONAL_KNOWLEDGE_QA_FORBIDDEN",
  );
  assert.equal(db.transactions, 0);
  assert.equal(db.rawQueries, 0);
});

test("个人页面问答执行拒绝无效挑战和过期账号快照，不触发 provider", async () => {
  const db = new NoDispatchQaDb();
  await assert.rejects(
    () => executePersonalKnowledgeQa(
      page.documentId,
      { ...qaExecuteInput, challengeId: "invalid-challenge" },
      { id: OWNER_ID, role: "user", accountAccessVersion: 1 },
      db as never,
    ),
    (error: unknown) => qaCode(error) === "PERSONAL_KNOWLEDGE_QA_INVALID_INPUT",
  );
  await assert.rejects(
    () => executePersonalKnowledgeQa(
      page.documentId,
      qaExecuteInput,
      { id: OWNER_ID, role: "user", accountAccessVersion: 0 },
      db as never,
    ),
    (error: unknown) => qaCode(error) === "PERSONAL_KNOWLEDGE_QA_ACCOUNT_ACCESS_STALE",
  );
  assert.equal(db.transactions, 0);
  assert.equal(db.rawQueries, 0);
});

test("个人页面问答只为当前页面生成词法命中证据，并固定引用别名", () => {
  const evidence = buildPersonalKnowledgeQaEvidence(page, "人工审核");
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0]?.citationKey, "p1");
  assert.equal(evidence[0]?.revisionId, page.revisionId);
  assert.match(evidence[0]?.excerpt ?? "", /人工审核/u);
  assert.equal(personalKnowledgeQaEvidenceManifest(evidence)[0]?.excerptHash, personalKnowledgeQaSha256(evidence[0]?.excerpt ?? ""));
});

test("没有词法证据时必须在模型调用前返回空集合", () => {
  assert.deepEqual(buildPersonalKnowledgeQaEvidence(page, "完全不相关的问题"), []);
  assert.deepEqual(buildPersonalKnowledgeQaEvidence(page, "产品规则"), []);
});

test("长段落和多字符换行的引用范围精确对应原文，外发片段有上限", () => {
  const content = `${"无关内容".repeat(900)}\r\n\r\n关键证据位于页面后半段。`;
  const longPage = { ...page, content, contentHash: personalKnowledgeQaSha256(content) };
  const evidence = buildPersonalKnowledgeQaEvidence(longPage, "关键证据");
  assert.ok(evidence.length > 0);
  assert.ok(evidence.every((item) => item.excerpt.length <= 4_000));
  assert.ok(evidence.some((item) => item.excerpt.includes("关键证据")));
  for (const item of evidence) assert.equal(content.slice(item.rangeStart, item.rangeEnd), item.excerpt);
});

test("问答消息把证据作为不受信数据，并要求严格 JSON 引用", () => {
  const evidence = buildPersonalKnowledgeQaEvidence(page, "订单审核");
  const messages = buildPersonalKnowledgeQaMessages("订单审核", evidence);
  assert.match(messages[0].content, /untrusted data/u);
  assert.match(messages[0].content, /citations/u);
  assert.match(messages[1].content, /"p1"/u);
  assert.doesNotMatch(messages[1].content, /secret|apiKey|credential/u);
});

test("模型回答只接受服务端发出的引用别名", () => {
  assert.deepEqual(
    parsePersonalKnowledgeQaModelOutput('{"answer":"需要审核。","citations":["p1","p1"]}', new Set(["p1"])),
    { answer: "需要审核。", citations: ["p1"] },
  );
  assert.throws(
    () => parsePersonalKnowledgeQaModelOutput('{"answer":"越权","citations":["p2"]}', new Set(["p1"])),
    /PERSONAL_KNOWLEDGE_QA_INVALID_CITATION/u,
  );
  assert.throws(
    () => parsePersonalKnowledgeQaModelOutput('{"answer":"没有引用","citations":[]}', new Set(["p1"])),
    /PERSONAL_KNOWLEDGE_QA_INVALID_MODEL_OUTPUT/u,
  );
});
