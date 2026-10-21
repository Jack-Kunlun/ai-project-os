import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { unifiedQuestionPresentationSchema } from "../src/lib/unified-question-contract";

test("conversation display changes require a revision and a bounded single-line title or an explicit pin value", () => {
  assert.deepEqual(unifiedQuestionPresentationSchema.parse({ expectedRevision: 0, title: "  项目讨论  " }), { expectedRevision: 0, title: "项目讨论" });
  assert.equal(unifiedQuestionPresentationSchema.safeParse({ expectedRevision: 3, pinned: false }).success, true);
  for (const input of [{}, { expectedRevision: 0 }, { expectedRevision: -1, pinned: true }, { expectedRevision: 0, title: " " },
    { expectedRevision: 0, title: "x".repeat(121) }, { expectedRevision: 0, title: "a\nb" }, { expectedRevision: 0, title: "a\u0085b" },
    { expectedRevision: 0, pinned: "false" }, { expectedRevision: 0, pinned: true, ownerUserId: "other" }]) {
    assert.equal(unifiedQuestionPresentationSchema.safeParse(input).success, false);
  }
});
import {
  buildUnifiedQuestionMessages,
  parseUnifiedQuestionModelOutput,
  unifiedQuestionEvidenceManifest,
  unifiedQuestionExcerpt,
  unifiedQuestionHistoryFingerprint,
  unifiedQuestionLexicalScore,
  unifiedQuestionPrepareSchema,
  unifiedQuestionExecuteSchema,
  unifiedQuestionSha256,
} from "../src/lib/unified-question-contract";

const conversationId = "00000000-0000-4000-8000-000000000001";
const turnId = "00000000-0000-4000-8000-000000000002";
const confirmationId = "00000000-0000-4000-8000-000000000003";

test("prepare and execute wire contracts are strict and accept the UI challenge alias", () => {
  const prepare = {
    phase: "prepare",
    expectedLastTurnId: null,
    scope: "all",
    question: "本项目的计划是什么？",
    clientKey: "request-key-001",
  };
  assert.equal(unifiedQuestionPrepareSchema.safeParse(prepare).success, true);
  assert.equal(unifiedQuestionPrepareSchema.safeParse({ ...prepare, hiddenField: true }).success, false);
  assert.equal(unifiedQuestionPrepareSchema.safeParse({ ...prepare, scope: "project" }).success, false);
  assert.equal(unifiedQuestionPrepareSchema.safeParse({ ...prepare, scope: "all", projectId: conversationId }).success, false);
  assert.equal(unifiedQuestionPrepareSchema.safeParse({ ...prepare, scope: "personal", focusDocumentId: turnId }).success, true);

  const execute = {
    phase: "execute",
    conversationId,
    expectedLastTurnId: turnId,
    scope: "personal",
    question: "请继续说明项目背景",
    clientKey: "request-key-002",
    challengeId: confirmationId,
  };
  assert.equal(unifiedQuestionExecuteSchema.safeParse(execute).success, true);
  assert.equal(unifiedQuestionExecuteSchema.safeParse({ ...execute, confirmationId }).success, true);
  assert.equal(unifiedQuestionExecuteSchema.safeParse({ ...execute, confirmationId: turnId }).success, false);
  assert.equal(unifiedQuestionExecuteSchema.safeParse({ ...execute, challengeId: undefined }).success, false);
});

test("source selection helpers are keyword based and return a bounded original-text excerpt", () => {
  const question = "ABC计划 项目目标";
  const source = `前置信息。全角ＡＢＣ计划和项目目标写在这里。${"后续内容。".repeat(800)}`;
  assert.ok(unifiedQuestionLexicalScore(question, source) > 0);
  const excerpt = unifiedQuestionExcerpt(question, source);
  assert.ok(excerpt);
  assert.ok(excerpt.includes("全角ＡＢＣ计划"));
  assert.ok(excerpt.length <= 4_000);
  assert.equal(unifiedQuestionLexicalScore("不存在的词组", source), 0);
});

test("model messages carry every prior Q&A verbatim but keep old citations out of context", () => {
  const messages = buildUnifiedQuestionMessages({
    question: "继续说明",
    history: [
      { question: "第一轮问题", answer: "第一轮完整回答" },
      { question: "第二轮问题", answer: "第二轮完整回答" },
    ],
    evidence: [{ id: "s1", scope: "personal", title: "目标文档", contentHash: "a".repeat(64), content: "本轮可引用的证据片段" }],
  });
  const payload = JSON.parse(messages[1].content) as {
    completeHistory: Array<{ question: string; answer: string }>;
    currentTurnEvidence: Array<{ id: string; content: string }>;
  };
  assert.deepEqual(payload.completeHistory, [
    { question: "第一轮问题", answer: "第一轮完整回答" },
    { question: "第二轮问题", answer: "第二轮完整回答" },
  ]);
  assert.deepEqual(payload.currentTurnEvidence.map((source) => source.id), ["s1"]);
  assert.ok(messages[0].content.includes("bounded keyword matching"));
});

test("complete history fingerprints and citation manifests retain immutable evidence", () => {
  const turn = { id: turnId, sequence: 1, question: "问题", answer: "答案", citations: [{ id: "s1", content: "旧引用" }], projectIds: [] as string[] };
  const baseline = unifiedQuestionHistoryFingerprint([turn]);
  assert.notEqual(unifiedQuestionHistoryFingerprint([{ ...turn, answer: "答案已修改" }]), baseline);
  assert.throws(() => unifiedQuestionHistoryFingerprint([{
    id: turnId, sequence: 1, question: "问".repeat(60_001), answer: "答", citations: [],
  }]), /UNIFIED_QUESTION_HISTORY_OVER_BUDGET/u);

  const snapshot = {
    id: "s1", scope: "project" as const, projectId: conversationId, sourceId: turnId,
    revision: "unknown/legacy", contentHash: "b".repeat(64), title: "旧版本项目资料",
    excerpt: "保存的摘录", content: "该轮实际发送的内容", legacy: true,
  };
  const [manifest] = unifiedQuestionEvidenceManifest([snapshot]);
  assert.equal(manifest?.revision, "unknown/legacy");
  assert.equal(manifest?.contentHash, snapshot.contentHash);
  assert.equal(manifest?.contentHashUsed, unifiedQuestionSha256(snapshot.content));
  assert.equal(Object.hasOwn(manifest ?? {}, "content"), false);
});

test("model citations are limited to protocol IDs and deduplicated before evidence resolution", () => {
  assert.deepEqual(parseUnifiedQuestionModelOutput('{"answer":"已完成","citations":["s1","s1"]}'), {
    answer: "已完成", citations: ["s1"],
  });
  assert.throws(() => parseUnifiedQuestionModelOutput('{"answer":"已完成","citations":["s9"]}'), /UNIFIED_QUESTION_INVALID_MODEL_OUTPUT/u);
  assert.deepEqual(parseUnifiedQuestionModelOutput('{"answer":"已完成","citations":["s1","s2"]}'), {
    answer: "已完成", citations: ["s1", "s2"],
  });
});

test("legacy import is restricted to known user-owned RagAnswer rows and labels missing revisions", () => {
  const migration = readFileSync("prisma/migrations/20261018010000_add_unified_question/migration.sql", "utf8");
  assert.match(migration, /JOIN "BackgroundJob" j ON j\."id" = r\."jobId"[\s\S]*?JOIN "AppUser" u ON u\."id" = j\."requestedById" AND u\."role" = 'user'/u);
  assert.match(migration, /'revision', 'unknown\/legacy'/u);
  assert.match(migration, /left\(COALESCE\(citation\.value->>'excerpt', ''\), 4000\)/u);
  assert.doesNotMatch(migration, /PersonalKnowledgeQaAudit[\s\S]{0,500}INSERT INTO "UnifiedQuestion/u);
});

test("turn project guard retains every sent project even when the model cites none of them", () => {
  const migration = readFileSync("prisma/migrations/20261018010000_add_unified_question/migration.sql", "utf8");
  const insertGuard = migration.match(/CREATE FUNCTION "unified_question_turn_insert_guard"\(\)[\s\S]*?\$\$;/u)?.[0];
  assert.ok(insertGuard);
  assert.match(insertGuard, /citation_project_ids\s*<@\s*NEW\."projectIds"/u);
  assert.match(insertGuard, /NEW\."projectId"\s*=\s*ANY\(NEW\."projectIds"\)/u);
  assert.match(insertGuard, /NEW\."scope"\s*=\s*'personal'[\s\S]*?cardinality\(NEW\."projectIds"\)\s*<>\s*0/u);
});

import { inquiryModelMatches } from "../src/lib/inquiry-send";
test("direct Send authorizes only the public provider, model and billing terms already shown", () => {
  const shown = { providerName: "DeepSeek", modelId: "deepseek-chat", quotaMultiplierBps: 10000, maxOutputTokens: 2048 };
  const prepared = { providerName: shown.providerName, modelId: shown.modelId, billing: { quotaMultiplierBps: shown.quotaMultiplierBps, maxOutputTokens: shown.maxOutputTokens } };
  assert.equal(inquiryModelMatches(shown, prepared), true);
  for (const change of [{ providerName: "other" }, { modelId: "other" }, { billing: { ...prepared.billing, quotaMultiplierBps: 15000 } }, { billing: { ...prepared.billing, maxOutputTokens: 4096 } }]) {
    assert.equal(inquiryModelMatches(shown, { ...prepared, ...change }), false);
  }
  assert.equal(unifiedQuestionPresentationSchema.safeParse({ expectedRevision: 1, archived: true }).success, true);
  assert.equal(unifiedQuestionPresentationSchema.safeParse({ expectedRevision: 2, deleted: false }).success, true);
  assert.equal(unifiedQuestionPresentationSchema.safeParse({ expectedRevision: 2, deleted: "false" }).success, false);
});
