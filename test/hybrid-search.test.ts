import assert from "node:assert/strict";
import test from "node:test";
import {
  HYBRID_SEARCH_RRF_K,
  HybridSearchError,
  rankHybridSearch,
  type HybridSearchDocument,
} from "@/lib/ai-memory";
import {
  RETRIEVAL_METRIC_CONTRACT,
  calculateRetrievalRecallAt5,
  crossProjectIsolationSamples,
  retrievalCorpus,
  retrievalSamples,
} from "./fixtures/ai-memory-eval-v1";

const EVAL_PROJECT_ID = "eval-project";

const evaluationDocuments: readonly HybridSearchDocument[] = retrievalCorpus.map((source, ordinal) => ({
  id: source.sourceId,
  projectId: EVAL_PROJECT_ID,
  sourceId: source.sourceId,
  contentText: source.content,
  ordinal,
}));

test("CJK, identifier, substring and token RRF exceeds the frozen Recall@5 gate", () => {
  const rankings = Object.fromEntries(retrievalSamples.map((sample) => [
    sample.id,
    rankHybridSearch({
      projectId: EVAL_PROJECT_ID,
      query: sample.query,
      documents: evaluationDocuments,
      take: RETRIEVAL_METRIC_CONTRACT.k,
    }).map((result) => result.document.sourceId),
  ]));
  const recall = calculateRetrievalRecallAt5(retrievalSamples, rankings);
  assert.equal(recall >= RETRIEVAL_METRIC_CONTRACT.threshold, true, `Recall@5 ${recall}`);
});

test("vector distance participates in stable RRF without changing project scope", () => {
  const documents: HybridSearchDocument[] = [
    { id: "lexical", projectId: "project-a", sourceId: "source-a", contentText: "Orion current milestone current milestone", ordinal: 0 },
    { id: "semantic", projectId: "project-a", sourceId: "source-b", contentText: "Orion schedule evidence", ordinal: 1 },
    { id: "forbidden", projectId: "project-b", sourceId: "source-c", contentText: "Orion current milestone", ordinal: 0 },
  ];
  const ranked = rankHybridSearch({
    projectId: "project-a",
    query: "Orion current milestone",
    documents,
    vectorRanks: [
      { documentId: "semantic", distance: 0.01 },
      { documentId: "lexical", distance: 0.8 },
      { documentId: "forbidden", distance: 0 },
    ],
    take: 3,
  });
  assert.equal(HYBRID_SEARCH_RRF_K, 60);
  assert.equal(ranked.every((result) => result.document.projectId === "project-a"), true);
  assert.equal(ranked.some((result) => result.ranks.vector !== null), true);
  assert.equal(ranked.some((result) => result.document.id === "forbidden"), false);
  assert.deepEqual(
    rankHybridSearch({
      projectId: "project-a",
      query: "Orion current milestone",
      documents,
      vectorRanks: [
        { documentId: "semantic", distance: 0.01 },
        { documentId: "lexical", distance: 0.8 },
        { documentId: "forbidden", distance: 0 },
      ],
      take: 3,
    }),
    ranked,
  );
});

test("cross-project fixtures never expose forbidden project evidence", () => {
  for (const sample of crossProjectIsolationSamples) {
    const results = rankHybridSearch({
      projectId: sample.allowed.projectId,
      query: sample.input,
      documents: [
        {
          id: sample.allowed.sourceId,
          projectId: sample.allowed.projectId,
          sourceId: sample.allowed.sourceId,
          contentText: sample.allowed.content,
          ordinal: 0,
        },
        {
          id: sample.forbidden.sourceId,
          projectId: sample.forbidden.projectId,
          sourceId: sample.forbidden.sourceId,
          contentText: sample.forbidden.content,
          ordinal: 0,
        },
      ],
      take: 5,
    });
    assert.equal(results.some((result) => result.document.sourceId === sample.forbidden.sourceId), false);
  }
});

test("invalid and oversized inputs fail with stable safe errors", () => {
  assert.throws(
    () => rankHybridSearch({
      projectId: "project-a",
      query: "x".repeat(2_001),
      documents: [],
    }),
    (error: unknown) => error instanceof HybridSearchError && error.code === "HYBRID_SEARCH_QUERY_TOO_LARGE",
  );
  assert.throws(
    () => rankHybridSearch({
      projectId: "project-a",
      query: "query",
      documents: [
        { id: "same", projectId: "project-a", sourceId: "a", contentText: "one", ordinal: 0 },
        { id: "same", projectId: "project-a", sourceId: "b", contentText: "two", ordinal: 1 },
      ],
    }),
    (error: unknown) => error instanceof HybridSearchError && error.code === "HYBRID_SEARCH_INVALID_INPUT",
  );
});
