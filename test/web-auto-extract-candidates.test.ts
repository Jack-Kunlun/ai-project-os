import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAutoExtractEvidenceBlocks,
  parseAutoExtractCandidates,
  WebAutoExtractError,
} from "../src/lib/web-auto-extract";

function candidate(sourceExcerpt: string, overrides: Record<string, unknown> = {}) {
  return {
    type: "decision",
    title: "采用逐条校验",
    content: "自动抽取候选改为逐条校验。",
    sourceExcerpt,
    ...overrides,
  };
}

test("auto extract keeps grounded candidates and skips invalid siblings", () => {
  const source = "第一段原文。\n第二段是可验证的决策证据。\n第三段原文。";
  const parsed = parseAutoExtractCandidates(JSON.stringify({
    candidates: [
      candidate("第二段是可验证的决策证据。"),
      candidate("模型改写了原文，不能作为证据。", { type: "risk" }),
      candidate("第一段原文。", { type: "unsupported" }),
    ],
  }), source);

  assert.equal(parsed.returnedCandidateCount, 3);
  assert.equal(parsed.candidates.length, 1);
  assert.equal(parsed.rejectedCandidateCount, 2);
  assert.equal(parsed.recoveredExcerptCount, 0);
  assert.equal(parsed.anchoredExcerptCount, 0);
  assert.equal(parsed.candidates[0]?.sourceExcerpt, "第二段是可验证的决策证据。");
});

test("auto extract recovers unique whitespace-only differences to the exact server source", () => {
  const source = "结论：系统会逐条校验。\n\n  有效候选继续进入人工审核。";
  const proposed = "结论：系统会逐条校验。 有效候选继续进入人工审核。";
  const parsed = parseAutoExtractCandidates(JSON.stringify({ candidates: [candidate(proposed)] }), source);

  assert.equal(parsed.candidates.length, 1);
  assert.equal(parsed.recoveredExcerptCount, 1);
  assert.equal(parsed.anchoredExcerptCount, 0);
  assert.equal(parsed.rejectedCandidateCount, 0);
  assert.equal(parsed.candidates[0]?.sourceExcerpt, "结论：系统会逐条校验。\n\n  有效候选继续进入人工审核。");
  assert.ok(source.includes(parsed.candidates[0]!.sourceExcerpt));
});

test("auto extract rejects ambiguous whitespace recovery", () => {
  const repeated = "这是一段重复且足够长的原文证据";
  const source = `${repeated}\n其他内容\n${repeated}`;
  const parsed = parseAutoExtractCandidates(JSON.stringify({ candidates: [candidate(repeated.replace("且", "且  "))] }), source);

  assert.equal(parsed.candidates.length, 0);
  assert.equal(parsed.returnedCandidateCount, 1);
  assert.equal(parsed.rejectedCandidateCount, 1);
  assert.equal(parsed.recoveredExcerptCount, 0);
  assert.equal(parsed.anchoredExcerptCount, 0);
});

test("valid evidence ids recover exact server-owned source blocks when a model paraphrases the excerpt", () => {
  const source = `${"A".repeat(700)}\n\n数据库最终采用 PostgreSQL，并保留每日备份。\n\n${"B".repeat(700)}`;
  const blocks = buildAutoExtractEvidenceBlocks(source);
  const evidence = blocks.find((block) => block.text.includes("PostgreSQL"));
  assert.ok(evidence);
  const parsed = parseAutoExtractCandidates(JSON.stringify({ candidates: [{
    type: "decision",
    title: "数据库",
    content: "采用 PostgreSQL",
    evidenceId: evidence.id,
    sourceExcerpt: "模型改写后的非原文摘录",
  }] }), source, blocks);

  assert.equal(parsed.candidates.length, 1);
  assert.equal(parsed.candidates[0]?.sourceExcerpt, evidence.text);
  assert.equal(source.includes(parsed.candidates[0]!.sourceExcerpt), true);
  assert.equal(parsed.anchoredExcerptCount, 1);
  assert.equal(parsed.rejectedCandidateCount, 0);
});

test("unknown evidence ids do not bypass exact provenance checks", () => {
  const source = "数据库最终采用 PostgreSQL。";
  const parsed = parseAutoExtractCandidates(JSON.stringify({ candidates: [{
    type: "decision",
    title: "数据库",
    content: "采用 PostgreSQL",
    evidenceId: "E9999",
    sourceExcerpt: "模型改写后的非原文摘录",
  }] }), source, buildAutoExtractEvidenceBlocks(source));

  assert.equal(parsed.candidates.length, 0);
  assert.equal(parsed.anchoredExcerptCount, 0);
  assert.equal(parsed.rejectedCandidateCount, 1);
});

test("auto extract still rejects a malformed response envelope", () => {
  assert.throws(
    () => parseAutoExtractCandidates("not-json", "原文"),
    (error: unknown) => error instanceof WebAutoExtractError && error.code === "AUTO_EXTRACT_INVALID_MODEL_OUTPUT",
  );
  assert.throws(
    () => parseAutoExtractCandidates(JSON.stringify({ result: [] }), "原文"),
    (error: unknown) => error instanceof WebAutoExtractError && error.code === "AUTO_EXTRACT_INVALID_MODEL_OUTPUT",
  );
});
