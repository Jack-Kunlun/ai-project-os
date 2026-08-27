import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  EVAL_SET_VERSION,
  RETRIEVAL_CORPUS_ID,
  RETRIEVAL_METRIC_CONTRACT,
  SYNTHETIC_MINI_REPOSITORY,
  aiMemoryEvalV1,
  calculateRetrievalRecallAt5,
  costBudgetSamples,
  crossProjectIsolationSamples,
  evalSetDigest,
  extractionDocuments,
  promptInjectionSamples,
  ragAnswerableSamples,
  ragConflictSamples,
  ragMustRefuseSamples,
  retrievalCorpus,
  retrievalCodeIdentifierSamples,
  retrievalConflictSamples,
  retrievalNoAnswerSamples,
  retrievalProjectMaterialSamples,
  retrievalSamples,
} from "./fixtures/ai-memory-eval-v1";

const forbiddenFixturePatterns = [
  /(?:password|passwd|secret|api[_ -]?key|access[_ -]?token)\s*[:=]/i,
  /(?:postgres(?:ql)?|mysql|redis|mongodb):\/\//i,
  /https?:\/\/[^/\s:@]+:[^/\s@]+@/i,
  /\b(?:sk|ghp|glpat)-[A-Za-z0-9_-]{12,}\b/i,
  /(?:^|[^\w.+-])[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}(?:$|[^\w.-])/i,
  /\b1[3-9]\d{9}\b/,
];

function assertEvidenceInSources(
  sources: readonly { sourceId: string; content: string }[],
  evidence: readonly { sourceId: string; excerpt: string }[],
) {
  const sourceById = new Map(sources.map((source) => [source.sourceId, source.content]));
  for (const item of evidence) {
    const content = sourceById.get(item.sourceId);
    assert.ok(content, `source ${item.sourceId} should exist`);
    assert.notEqual(content.indexOf(item.excerpt), -1, `${item.sourceId} should contain exact evidence`);
  }
}

test("evaluation fixture keeps a fixed candidate version and canonical digest", () => {
  assert.equal(EVAL_SET_VERSION, "ai-memory-eval-v1.0");
  assert.equal(aiMemoryEvalV1.evalSetVersion, EVAL_SET_VERSION);
  assert.match(evalSetDigest, /^[a-f0-9]{64}$/);
  const digest = createHash("sha256").update(JSON.stringify(aiMemoryEvalV1)).digest("hex");
  assert.equal(evalSetDigest, digest);
});

test("retrieval fixture has exact category counts, unique IDs, and grounded evidence", () => {
  assert.equal(retrievalProjectMaterialSamples.length, 40);
  assert.equal(retrievalCodeIdentifierSamples.length, 20);
  assert.equal(retrievalConflictSamples.length, 10);
  assert.equal(retrievalNoAnswerSamples.length, 10);
  assert.equal(retrievalSamples.length, 80);
  assert.deepEqual(
    Object.fromEntries(
      [...new Set(retrievalSamples.map((sample) => sample.category))].map((category) => [
        category,
        retrievalSamples.filter((sample) => sample.category === category).length,
      ]),
    ),
    { bilingual_project_material: 40, code_identifier: 20, conflict: 10, no_answer: 10 },
  );
  assert.equal(new Set(retrievalSamples.map((sample) => sample.id)).size, retrievalSamples.length);
  for (const sample of retrievalProjectMaterialSamples) {
    assert.equal(sample.goldTargetSourceIds.length, 1);
  }
  for (const sample of retrievalCodeIdentifierSamples) {
    assert.equal(sample.goldTargetSourceIds.length, 1);
  }
  for (const sample of retrievalConflictSamples) {
    assert.equal(sample.goldTargetSourceIds.length, 2);
  }
  for (const sample of retrievalNoAnswerSamples) {
    assert.equal(sample.goldTargetSourceIds.length, 0);
  }

  for (const sample of retrievalSamples) {
    assert.equal(sample.evalSetVersion, EVAL_SET_VERSION);
    assert.equal(sample.goldTargetSourceIds.every((sourceId) => sample.candidates.some((candidate) => candidate.sourceId === sourceId)), true);
    if (sample.expected.kind === "conflict") {
      assertEvidenceInSources(sample.candidates, sample.expected.evidence);
      assert.notEqual(sample.expected.conflict.left.sourceId, sample.expected.conflict.right.sourceId);
      assert.notEqual(sample.expected.conflict.left.excerpt, sample.expected.conflict.right.excerpt);
      assert.ok(sample.expected.conflict.factKey);
      assert.ok(sample.expected.conflict.leftValue);
      assert.ok(sample.expected.conflict.rightValue);
      assert.notEqual(sample.expected.conflict.leftValue, sample.expected.conflict.rightValue);
      assert.match(sample.expected.conflict.left.excerpt, new RegExp(sample.expected.conflict.leftValue));
      assert.match(sample.expected.conflict.right.excerpt, new RegExp(sample.expected.conflict.rightValue));
      continue;
    }
    assertEvidenceInSources(sample.candidates, sample.expected.evidence);
    if (sample.expected.kind === "refusal") {
      assert.equal(sample.expected.evidence.length, 0);
    }
  }
});

test("retrieval corpus and Recall@5 contract are frozen and executable", () => {
  assert.equal(RETRIEVAL_CORPUS_ID, "synthetic-memory-retrieval-corpus-v1");
  assert.equal(RETRIEVAL_METRIC_CONTRACT.corpusId, RETRIEVAL_CORPUS_ID);
  assert.equal(RETRIEVAL_METRIC_CONTRACT.k, 5);
  assert.equal(RETRIEVAL_METRIC_CONTRACT.threshold, 0.85);
  assert.equal(RETRIEVAL_METRIC_CONTRACT.goldUnit, "sourceId");
  assert.equal(RETRIEVAL_METRIC_CONTRACT.aggregation, "macro_average_per_query");
  assert.match(RETRIEVAL_METRIC_CONTRACT.formula, /top5SourceIds/);
  assert.match(RETRIEVAL_METRIC_CONTRACT.eligibleQueryRule, /no_answer/);

  const expectedCorpusIds = [...new Set(retrievalSamples.flatMap((sample) => sample.candidates.map((candidate) => candidate.sourceId)))];
  assert.deepEqual(retrievalCorpus.map((source) => source.sourceId), expectedCorpusIds);
  assert.equal(new Set(retrievalCorpus.map((source) => source.sourceId)).size, retrievalCorpus.length);
  for (const sample of retrievalSamples) {
    for (const sourceId of sample.goldTargetSourceIds) {
      assert.equal(retrievalCorpus.some((source) => source.sourceId === sourceId), true);
    }
  }

  const perfectRankings = Object.fromEntries(
    retrievalSamples.map((sample) => [sample.id, sample.goldTargetSourceIds]),
  );
  const missedRankings = Object.fromEntries(retrievalSamples.map((sample) => [sample.id, []]));
  assert.equal(calculateRetrievalRecallAt5(retrievalSamples, perfectRankings), 1);
  assert.equal(calculateRetrievalRecallAt5(retrievalSamples, missedRankings), 0);

  const conflictSample = retrievalConflictSamples[0];
  assert.ok(conflictSample);
  const conflict = conflictSample.expected;
  assert.equal(conflict.kind, "conflict");
  if (conflict.kind !== "conflict") {
    return;
  }
  assert.equal(
    calculateRetrievalRecallAt5([conflictSample], { [conflictSample.id]: [conflict.conflict.left.sourceId] }),
    0.5,
  );
  assert.equal(
    calculateRetrievalRecallAt5([conflictSample], {
      [conflictSample.id]: [
        conflict.conflict.left.sourceId,
        "synthetic-distractor-01",
        "synthetic-distractor-02",
        "synthetic-distractor-03",
        "synthetic-distractor-04",
        conflict.conflict.right.sourceId,
      ],
    }),
    0.5,
  );
});

test("code retrieval samples bind to one frozen synthetic mini-repository", () => {
  assert.equal(SYNTHETIC_MINI_REPOSITORY.isSynthetic, true);
  assert.equal(SYNTHETIC_MINI_REPOSITORY.repositoryId, "synthetic-memory-lab");
  assert.match(SYNTHETIC_MINI_REPOSITORY.commitSha, /^[a-f0-9]{40}$/);
  assert.equal(SYNTHETIC_MINI_REPOSITORY.corpusVersion, EVAL_SET_VERSION);
  const paths = new Set<string>();
  for (const sample of retrievalCodeIdentifierSamples) {
    assert.ok(sample.codeTarget);
    const target = sample.codeTarget;
    assert.equal(target.repositoryId, SYNTHETIC_MINI_REPOSITORY.repositoryId);
    assert.equal(target.commitSha, SYNTHETIC_MINI_REPOSITORY.commitSha);
    assert.equal(target.snapshotVersion, SYNTHETIC_MINI_REPOSITORY.snapshotVersion);
    assert.match(target.path, /^packages\/synthetic-memory-lab\//);
    assert.equal(target.path.startsWith("src/"), false);
    assert.ok(target.identifier);
    assert.equal(Number.isInteger(target.lineStart), true);
    assert.equal(Number.isInteger(target.lineEnd), true);
    assert.equal(target.lineStart <= target.lineEnd, true);
    assert.equal(paths.has(target.path), false);
    paths.add(target.path);
    const candidate = sample.candidates.find((source) => source.sourceId === sample.goldTargetSourceIds[0]);
    assert.ok(candidate);
    assert.match(candidate.content, new RegExp(`Path: ${target.path}`));
    assert.match(candidate.content, new RegExp(`Lines: ${target.lineStart}-${target.lineEnd}`));
    assert.match(candidate.content, new RegExp(target.identifier));
  }
  assert.equal(paths.size, 20);
});

test("RAG fixture has exact answerable, conflict, and refusal counts", () => {
  const ragSamples = [...ragAnswerableSamples, ...ragConflictSamples, ...ragMustRefuseSamples];
  assert.equal(ragAnswerableSamples.length, 40);
  assert.equal(ragConflictSamples.length, 10);
  assert.equal(ragMustRefuseSamples.length, 10);
  assert.equal(ragSamples.length, 60);
  assert.deepEqual(
    Object.fromEntries(
      [...new Set(ragSamples.map((sample) => sample.category))].map((category) => [
        category,
        ragSamples.filter((sample) => sample.category === category).length,
      ]),
    ),
    { answerable: 40, conflict: 10, must_refuse: 10 },
  );
  assert.equal(new Set(ragSamples.map((sample) => sample.id)).size, ragSamples.length);

  for (const sample of ragSamples) {
    assert.equal(sample.evalSetVersion, EVAL_SET_VERSION);
    assert.ok(sample.input);
    assert.ok(sample.question);
    if (sample.expected.kind === "refusal") {
      assert.equal(sample.expected.evidence.length, 0);
      continue;
    }
    assertEvidenceInSources(sample.context, sample.expected.evidence);
    if (sample.expected.kind === "conflict") {
      assert.notEqual(sample.expected.conflict.left.sourceId, sample.expected.conflict.right.sourceId);
      assert.notEqual(sample.expected.conflict.left.excerpt, sample.expected.conflict.right.excerpt);
      assert.ok(sample.expected.conflict.factKey);
      assert.ok(sample.expected.conflict.leftValue);
      assert.ok(sample.expected.conflict.rightValue);
      assert.notEqual(sample.expected.conflict.leftValue, sample.expected.conflict.rightValue);
      assert.match(sample.expected.conflict.left.excerpt, new RegExp(sample.expected.conflict.leftValue));
      assert.match(sample.expected.conflict.right.excerpt, new RegExp(sample.expected.conflict.rightValue));
      assertEvidenceInSources(sample.context, [sample.expected.conflict.left, sample.expected.conflict.right]);
    }
  }
});

test("extraction fixture has 60 documents and at least 120 exact gold claims", () => {
  assert.equal(extractionDocuments.length, 60);
  const claims = extractionDocuments.flatMap((document) => document.goldClaims);
  assert.equal(claims.length >= 120, true);
  assert.equal(new Set(extractionDocuments.map((document) => document.id)).size, extractionDocuments.length);
  assert.equal(new Set(claims.map((claim) => claim.claimId)).size, claims.length);

  for (const document of extractionDocuments) {
    assert.equal(document.evalSetVersion, EVAL_SET_VERSION);
    assert.equal(document.category, "extraction");
    assert.ok(document.input);
    assert.equal(document.goldClaims.length >= 2, true);
    for (const claim of document.goldClaims) {
      assert.equal(claim.evalSetVersion, EVAL_SET_VERSION);
      assert.equal(claim.sourceId, document.source.sourceId);
      assert.notEqual(document.source.content.indexOf(claim.evidence), -1, `${claim.claimId} evidence should be exact`);
    }
  }
});

test("prompt injection fixture refuses all five prohibited capability classes", () => {
  assert.equal(promptInjectionSamples.length, 20);
  const requiredCapabilities = ["shell", "arbitrary_network", "filesystem", "mcp", "write_operation"];
  assert.equal(new Set(promptInjectionSamples.map((sample) => sample.id)).size, promptInjectionSamples.length);
  for (const sample of promptInjectionSamples) {
    assert.equal(sample.evalSetVersion, EVAL_SET_VERSION);
    assert.equal(sample.expectedOutcome, "refuse");
    assert.deepEqual([...sample.forbiddenCapabilities].sort(), [...requiredCapabilities].sort());
    assert.equal(sample.expectedEvidence.length, 0);
  }
});

test("cross-project isolation fixture keeps allow and deny boundaries disjoint", () => {
  assert.equal(crossProjectIsolationSamples.length, 20);
  const allowedProjectIds = new Set(crossProjectIsolationSamples.map((sample) => sample.allowed.projectId));
  const forbiddenProjectIds = new Set(crossProjectIsolationSamples.map((sample) => sample.forbidden.projectId));
  const allowedSourceIds = new Set(crossProjectIsolationSamples.map((sample) => sample.allowed.sourceId));
  const forbiddenSourceIds = new Set(crossProjectIsolationSamples.map((sample) => sample.forbidden.sourceId));
  assert.equal(allowedProjectIds.size, 20);
  assert.equal(forbiddenProjectIds.size, 20);
  assert.equal(allowedSourceIds.size, 20);
  assert.equal(forbiddenSourceIds.size, 20);
  for (const sample of crossProjectIsolationSamples) {
    assert.equal(sample.evalSetVersion, EVAL_SET_VERSION);
    assert.notEqual(sample.allowed.projectId, sample.forbidden.projectId);
    assert.notEqual(sample.allowed.sourceId, sample.forbidden.sourceId);
    assert.equal(forbiddenProjectIds.has(sample.allowed.projectId), false);
    assert.equal(allowedProjectIds.has(sample.forbidden.projectId), false);
    assert.equal(forbiddenSourceIds.has(sample.allowed.sourceId), false);
    assert.equal(allowedSourceIds.has(sample.forbidden.sourceId), false);
    assertEvidenceInSources([sample.allowed], sample.expectedEvidence);
    assertEvidenceInSources([sample.forbidden], sample.forbiddenEvidence);
  }
});

test("cost fixture has auditable token, request, pricing, and report fields", () => {
  assert.equal(costBudgetSamples.length, 20);
  const requiredReportFields = [
    "evalSetVersion",
    "operation",
    "requestCount",
    "inputTokens",
    "outputTokens",
    "pricingSnapshotId",
    "budgetStatus",
  ];
  for (const sample of costBudgetSamples) {
    assert.equal(sample.evalSetVersion, EVAL_SET_VERSION);
    assert.equal(sample.category, "cost_budget");
    assert.ok(sample.input);
    assert.ok(sample.operation);
    assert.ok(sample.inputTokenLimit > 0);
    assert.ok(sample.outputTokenLimit > 0);
    assert.ok(sample.requestLimit > 0);
    assert.equal(sample.pricingSnapshotId, "synthetic-token-budget-v1");
    assert.deepEqual([...sample.reportFields], requiredReportFields);
  }
});

test("all fixture IDs are unique and synthetic text has no common secret patterns", () => {
  const ids = [
    ...retrievalSamples.map((sample) => sample.id),
    ...[...ragAnswerableSamples, ...ragConflictSamples, ...ragMustRefuseSamples].map((sample) => sample.id),
    ...extractionDocuments.map((document) => document.id),
    ...extractionDocuments.flatMap((document) => document.goldClaims.map((claim) => claim.claimId)),
    ...promptInjectionSamples.map((sample) => sample.id),
    ...crossProjectIsolationSamples.map((sample) => sample.id),
    ...costBudgetSamples.map((sample) => sample.id),
  ];
  assert.equal(new Set(ids).size, ids.length);
  const serialized = JSON.stringify(aiMemoryEvalV1);
  for (const pattern of forbiddenFixturePatterns) {
    assert.doesNotMatch(serialized, pattern);
  }
});
