import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  compareGovernanceReviews,
  decodeGovernanceListCursor,
  decodeGovernanceReviewCursor,
  encodeGovernanceListCursor,
  encodeGovernanceReviewCursor,
  governanceJobCapability,
  ProjectGovernanceError,
  toGovernanceVerifiedReview,
  toGovernanceWebReview,
  type GovernanceReview,
} from "../src/lib/project-governance";

const projectId = "11111111-1111-4111-8111-111111111111";
const candidateId = "22222222-2222-4222-8222-222222222222";
const otherCandidateId = "33333333-3333-4333-8333-333333333333";
const createdAt = new Date("2026-08-29T01:02:03.000Z");

test("governance cursors are typed, canonical, and route-bound", () => {
  const review = encodeGovernanceReviewCursor({
    createdAt: createdAt.toISOString(),
    source: "verified",
    id: candidateId,
  });
  assert.deepEqual(decodeGovernanceReviewCursor(review), {
    v: 1,
    kind: "reviews",
    createdAt: createdAt.toISOString(),
    source: "verified",
    id: candidateId,
  });

  const operations = encodeGovernanceListCursor("operations", {
    createdAt: createdAt.toISOString(),
    id: candidateId,
  });
  assert.equal(decodeGovernanceListCursor("operations", operations).kind, "operations");
  assert.throws(
    () => decodeGovernanceListCursor("routes", operations),
    (error: unknown) => error instanceof ProjectGovernanceError && error.code === "GOVERNANCE_CURSOR_INVALID",
  );
  assert.throws(() => decodeGovernanceReviewCursor(`${review}=`), ProjectGovernanceError);
  assert.throws(() => decodeGovernanceReviewCursor("not-json"), ProjectGovernanceError);
});

function review(source: GovernanceReview["source"], id: string, timestamp = createdAt.toISOString()): GovernanceReview {
  return {
    source,
    id,
    createdAt: timestamp,
    model: { providerName: null, providerKind: null, modelId: "model" },
    evidence: { sourceId: projectId, sourceKind: "manual", contentHash: "a".repeat(64), excerpt: "evidence" },
    item: { id: projectId, type: "decision", title: "title", content: "content", occurredAt: null, updatedAt: timestamp },
  };
}

test("review ordering is stable across source and UUID tie breakers", () => {
  const older = review("verified", candidateId, "2026-08-28T01:02:03.000Z");
  const rows = [
    older,
    review("web", candidateId),
    review("verified", otherCandidateId),
    review("verified", candidateId),
  ].sort(compareGovernanceReviews);
  assert.deepEqual(rows.map((row) => `${row.source}:${row.id}`), [
    `verified:${candidateId}`,
    `verified:${otherCandidateId}`,
    `web:${candidateId}`,
    `verified:${candidateId}`,
  ]);
  assert.equal(rows[3]?.createdAt, older.createdAt);
});

test("review DTOs contain review evidence but no source body or runtime secrets", () => {
  const web = toGovernanceWebReview({
    id: candidateId,
    modelId: "qwen-plus",
    createdAt,
    providerConnection: { name: "Qwen", kind: "qwen" },
    source: { id: projectId, kind: "manual", contentHash: "b".repeat(64) },
    projectItem: {
      id: otherCandidateId,
      type: "risk",
      title: "风险",
      content: "需要复核",
      sourceExcerpt: "精确摘录",
      occurredAt: null,
      updatedAt: createdAt,
    },
  });
  const verified = toGovernanceVerifiedReview({
    id: otherCandidateId,
    modelId: "verified-model",
    createdAt,
    sourceExcerpt: "已验证摘录",
    source: { id: projectId, kind: "manual", contentHash: "c".repeat(64) },
    projectItem: {
      id: candidateId,
      type: "decision",
      title: "决策",
      content: "已冻结候选",
      occurredAt: createdAt,
      updatedAt: createdAt,
    },
  });
  assert.equal(web.evidence.excerpt, "精确摘录");
  assert.equal(verified.evidence.excerpt, "已验证摘录");
  const serialized = JSON.stringify([web, verified]);
  assert.doesNotMatch(serialized, /contentText|externalRef|payload|idempotencyKey|leaseToken|providerRequest|credential|embedding/u);
});

test("job capabilities preserve specialized reconciliation and terminal semantics", () => {
  for (const kind of ["autoExtract", "semanticSearch", "ragAnswer", "projectBrief", "projectAgent", "memoryIndex", "githubProjectSync"] as const) {
    assert.deepEqual(governanceJobCapability({ kind, status: "unknown", reconciliationRequired: true }), {
      action: "reconcile",
      reason: "available",
    });
  }
  for (const kind of ["githubScan", "githubMaterialSync"] as const) {
    assert.deepEqual(governanceJobCapability({ kind, status: "unknown", reconciliationRequired: true }), {
      action: null,
      reason: "specializedReconciliationRequired",
    });
    assert.equal(governanceJobCapability({ kind, status: "queued", reconciliationRequired: false }).action, "cancel");
  }
  assert.deepEqual(governanceJobCapability({ kind: "projectBrief", status: "running", reconciliationRequired: false }), {
    action: null,
    reason: "running",
  });
  assert.deepEqual(governanceJobCapability({ kind: "projectBrief", status: "failed", reconciliationRequired: false }), {
    action: null,
    reason: "terminal",
  });
});

test("governance routes are authenticated no-store reads and UI reuses bounded action APIs", async () => {
  const service = await readFile("src/lib/project-governance.ts", "utf8");
  for (const forbidden of ["contentText:", "idempotencyKey:", "leaseTokenHash:", "providerRequestId:", "credentialSecretFingerprint:", "embedding:"]) {
    assert.doesNotMatch(service, new RegExp(forbidden, "u"));
  }

  const routes = [
    "src/app/api/projects/[projectId]/governance/route.ts",
    "src/app/api/projects/[projectId]/governance/reviews/route.ts",
    "src/app/api/projects/[projectId]/governance/operations/route.ts",
    "src/app/api/projects/[projectId]/governance/routes/route.ts",
  ];
  for (const path of routes) {
    const source = await readFile(path, "utf8");
    assert.match(source, /requireApiSession\(request\)/u);
    assert.match(source, /cache-control": "no-store"/u);
    assert.doesNotMatch(source, /export async function (POST|PATCH|DELETE)/u);
  }

  const client = await readFile("src/app/projects/[projectId]/governance/project-governance-client.tsx", "utf8");
  assert.match(client, /\/memory\/candidates\/\$\{review\.id\}/u);
  assert.match(client, /\/ai-memory\/candidates\/\$\{review\.id\}/u);
  assert.match(client, /\/jobs\/\$\{operation\.id\}/u);
  assert.doesNotMatch(client, /action:\s*"acceptAll"|bulkAccept/u);
});
