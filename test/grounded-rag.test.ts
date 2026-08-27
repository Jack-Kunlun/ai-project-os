import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  GroundedRagError,
  buildGroundedRagPlan,
  createGroundedRagService,
  verifyGroundedRagOutput,
  type GroundedRagContextEntry,
  type ProjectSearchResponse,
} from "@/lib/ai-memory";
import {
  ragAnswerableSamples,
  ragConflictSamples,
  ragMustRefuseSamples,
} from "./fixtures/ai-memory-eval-v1";

const PROJECT_ID = "eval-project";
const SNAPSHOT_ID = "eval-rag-snapshot";
const SNAPSHOT_FINGERPRINT = "a".repeat(64);

function contentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function contexts(
  values: readonly { sourceId: string; content: string }[],
): readonly GroundedRagContextEntry[] {
  return values.map((value, index) => ({
    projectId: PROJECT_ID,
    sourceId: value.sourceId,
    chunkId: `chunk-${index + 1}-${value.sourceId}`,
    sourceKind: "manual",
    externalRef: null,
    contentHash: contentHash(value.content),
    contentText: value.content,
    rangeUnit: "utf8_byte",
    rangeStart: 0,
    rangeEnd: Buffer.byteLength(value.content, "utf8"),
  }));
}

function searchResponse(
  values: readonly { sourceId: string; content: string }[],
): ProjectSearchResponse {
  return {
    searchVersion: "project-search:v1",
    mode: "lexical",
    snapshot: {
      id: SNAPSHOT_ID,
      manifestFingerprint: SNAPSHOT_FINGERPRINT,
      manualIndexGenerationId: "index-generation",
      manualCorpusGenerationId: "corpus-generation",
      effectivePolicyVersion: 1,
      publishedAt: new Date("2026-08-28T00:00:00.000Z"),
    },
    results: values.map((value, index) => ({
      rank: index + 1,
      score: 1 / (61 + index),
      matchedFeatures: ["token"],
      componentRanks: {
        vector: null,
        cjk: null,
        identifier: null,
        substring: null,
        token: index + 1,
      },
      citation: {
        projectId: PROJECT_ID,
        sourceId: value.sourceId,
        sourceKind: "manual",
        externalRef: null,
        chunkId: `chunk-${index + 1}`,
        rangeUnit: "utf8_byte",
        rangeStart: 0,
        rangeEnd: Buffer.byteLength(value.content, "utf8"),
        contentHash: contentHash(value.content),
        excerpt: value.content,
      },
    })),
  };
}

test("all frozen RAG answer, conflict and refusal samples pass the grounded contract", () => {
  let supportedClaims = 0;
  let verifiedCitations = 0;

  for (const sample of ragAnswerableSamples) {
    assert.equal(sample.expected.kind, "answer");
    if (sample.expected.kind !== "answer") continue;
    const plan = buildGroundedRagPlan({
      projectId: PROJECT_ID,
      snapshotId: SNAPSHOT_ID,
      snapshotManifestFingerprint: SNAPSHOT_FINGERPRINT,
      question: sample.question,
      contexts: contexts(sample.context),
    });
    const evidence = sample.expected.evidence[0]!;
    const citationIndex = sample.context.findIndex((entry) => entry.sourceId === evidence.sourceId);
    const result = verifyGroundedRagOutput(plan, {
      kind: "answer",
      claims: [{
        text: evidence.excerpt,
        citations: [{ citationKey: `c${citationIndex + 1}`, excerpt: evidence.excerpt }],
      }],
    });
    assert.equal(result.kind, "answer");
    if (result.kind !== "answer") continue;
    assert.equal(result.answer, sample.expected.answer);
    supportedClaims += result.claims.length;
    verifiedCitations += result.claims.flatMap((claim) => claim.citations).length;
  }

  for (const sample of ragConflictSamples) {
    assert.equal(sample.expected.kind, "conflict");
    if (sample.expected.kind !== "conflict") continue;
    const plan = buildGroundedRagPlan({
      projectId: PROJECT_ID,
      snapshotId: SNAPSHOT_ID,
      snapshotManifestFingerprint: SNAPSHOT_FINGERPRINT,
      question: sample.question,
      contexts: contexts(sample.context),
    });
    const expected = sample.expected.conflict;
    const leftIndex = sample.context.findIndex((entry) => entry.sourceId === expected.left.sourceId);
    const rightIndex = sample.context.findIndex((entry) => entry.sourceId === expected.right.sourceId);
    const result = verifyGroundedRagOutput(plan, {
      kind: "conflict",
      conflicts: [{
        factKey: expected.factKey,
        left: {
          text: expected.left.excerpt,
          citations: [{ citationKey: `c${leftIndex + 1}`, excerpt: expected.left.excerpt }],
        },
        right: {
          text: expected.right.excerpt,
          citations: [{ citationKey: `c${rightIndex + 1}`, excerpt: expected.right.excerpt }],
        },
      }],
    });
    assert.equal(result.kind, "conflict");
    if (result.kind !== "conflict") continue;
    supportedClaims += result.conflicts.length * 2;
    verifiedCitations += result.conflicts.flatMap((conflict) => [
      ...conflict.left.citations,
      ...conflict.right.citations,
    ]).length;
  }

  for (const sample of ragMustRefuseSamples) {
    const plan = buildGroundedRagPlan({
      projectId: PROJECT_ID,
      snapshotId: SNAPSHOT_ID,
      snapshotManifestFingerprint: SNAPSHOT_FINGERPRINT,
      question: sample.question,
      contexts: contexts(sample.context),
    });
    const result = verifyGroundedRagOutput(plan, {
      kind: "refusal",
      reasonCode: "INSUFFICIENT_EVIDENCE",
    });
    assert.equal(result.kind, "refusal");
    assert.equal(result.answer, "当前检索证据不足，无法可靠回答。");
  }

  assert.equal(supportedClaims, 60);
  assert.equal(verifiedCitations, 60);
  assert.equal(ragAnswerableSamples.length, 40);
  assert.equal(ragConflictSamples.length, 10);
  assert.equal(ragMustRefuseSamples.length, 10);
});

test("claims require current exact evidence and absolute UTF-8 ranges", () => {
  const content = "项目状态：当前里程碑为领域模型评审。";
  const plan = buildGroundedRagPlan({
    projectId: PROJECT_ID,
    snapshotId: SNAPSHOT_ID,
    snapshotManifestFingerprint: SNAPSHOT_FINGERPRINT,
    question: "当前里程碑是什么？",
    contexts: contexts([{ sourceId: "source-one", content }]),
  });
  const result = verifyGroundedRagOutput(plan, {
    kind: "answer",
    claims: [{
      text: "当前里程碑为领域模型评审",
      citations: [{
        citationKey: "c1",
        excerpt: "当前里程碑为领域模型评审",
      }],
    }],
  });
  assert.equal(result.kind, "answer");
  if (result.kind !== "answer") return;
  const citation = result.claims[0]!.citations[0]!;
  assert.equal(citation.excerpt, "当前里程碑为领域模型评审");
  assert.equal(citation.rangeStart, Buffer.byteLength("项目状态：", "utf8"));
  assert.equal(citation.rangeEnd, citation.rangeStart + Buffer.byteLength(citation.excerpt, "utf8"));
});

test("unsupported, forged, cross-project and capability-bearing outputs fail closed", () => {
  const baseContext = contexts([{
    sourceId: "source-one",
    content: "项目状态只记录当前里程碑。",
  }]);
  const plan = buildGroundedRagPlan({
    projectId: PROJECT_ID,
    snapshotId: SNAPSHOT_ID,
    snapshotManifestFingerprint: SNAPSHOT_FINGERPRINT,
    question: "负责人是谁？",
    contexts: baseContext,
  });
  const invalidOutputs = [
    {
      kind: "answer",
      claims: [{ text: "负责人是岚", citations: [{ citationKey: "c1", excerpt: "项目状态只记录当前里程碑" }] }],
    },
    {
      kind: "answer",
      claims: [{ text: "当前里程碑", citations: [{ citationKey: "missing", excerpt: "当前里程碑" }] }],
    },
    { kind: "refusal", reasonCode: "INSUFFICIENT_EVIDENCE", citations: [] },
    { kind: "answer", claims: [], tool: { name: "shell" } },
  ];
  for (const output of invalidOutputs) {
    assert.throws(
      () => verifyGroundedRagOutput(plan, output),
      (error: unknown) => error instanceof GroundedRagError,
    );
  }

  assert.throws(
    () => buildGroundedRagPlan({
      projectId: PROJECT_ID,
      snapshotId: SNAPSHOT_ID,
      snapshotManifestFingerprint: SNAPSHOT_FINGERPRINT,
      question: "query",
      contexts: [{ ...baseContext[0]!, projectId: "other-project" }],
    }),
    (error: unknown) =>
      error instanceof GroundedRagError &&
      error.code === "GROUNDED_RAG_CONTEXT_CONFLICT",
  );

  const forged = { ...plan };
  assert.throws(
    () => verifyGroundedRagOutput(forged, {
      kind: "refusal",
      reasonCode: "INSUFFICIENT_EVIDENCE",
    }),
    (error: unknown) =>
      error instanceof GroundedRagError &&
      error.code === "GROUNDED_RAG_INVALID_INPUT",
  );
});

test("RAG orchestration fixes one search snapshot, resolves once and skips empty context", async () => {
  const evidence = "当前风险是测试数据不足";
  let resolverCalls = 0;
  const search = searchResponse([{ sourceId: "source-one", content: `项目周报：${evidence}。` }]);
  const service = createGroundedRagService({
    searchService: {
      search: async () => search,
    },
    resolveOutput: async (plan) => {
      resolverCalls += 1;
      assert.equal(plan.snapshotId, SNAPSHOT_ID);
      return {
        kind: "answer",
        claims: [{
          text: evidence,
          citations: [{ citationKey: "c1", excerpt: evidence }],
        }],
      };
    },
  });
  const run = await service.ask({
    projectId: PROJECT_ID,
    question: "当前风险是什么？",
  });
  assert.equal(resolverCalls, 1);
  assert.equal(run.search.snapshot.id, SNAPSHOT_ID);
  assert.equal(run.search.resultCount, 1);
  assert.equal(run.result.kind, "answer");

  const emptyService = createGroundedRagService({
    searchService: {
      search: async () => searchResponse([]),
    },
    resolveOutput: async () => {
      throw new Error("empty retrieval must not resolve a model output");
    },
  });
  const emptyRun = await emptyService.ask({
    projectId: PROJECT_ID,
    question: "没有证据的问题",
  });
  assert.equal(emptyRun.search.resultCount, 0);
  assert.equal(emptyRun.result.kind, "refusal");
});
