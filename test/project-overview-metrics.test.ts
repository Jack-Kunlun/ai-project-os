import assert from "node:assert/strict";
import test from "node:test";
import { projectIndexReadinessDetail, projectIndexReadinessLabel, summarizeProjectOverview } from "../src/lib/project-overview-metrics";

test("overview attention total is the sum of every displayed category", () => {
  const summary = summarizeProjectOverview({
    itemCounts: { candidate: 2, confirmed: 7 },
    snapshotStale: false,
    governance: {
      pendingReviews: { total: 3 },
      jobs: { failed: 2, reconciliationRequired: 1 },
      github: { partial: 1, rateLimited: 2, unknown: 1 },
      index: { readiness: "indexMissing" },
    },
  });

  assert.equal(summary.pendingContent, 3);
  assert.equal(summary.failedJobs, 2);
  assert.equal(summary.reconciliationRequired, 1);
  assert.equal(summary.githubIssues, 4);
  assert.equal(summary.indexRisk, 1);
  assert.equal(summary.attentionTotal, 11);
});

test("ready memory index contributes no attention and missing index is not described as a running job", () => {
  const summary = summarizeProjectOverview({
    itemCounts: { candidate: 0, confirmed: 1 },
    snapshotStale: true,
    governance: {
      pendingReviews: { total: 0 },
      jobs: { failed: 0, reconciliationRequired: 0 },
      github: { partial: 0, rateLimited: 0, unknown: 0 },
      index: { readiness: "ready" },
    },
  });

  assert.equal(summary.indexRisk, 0);
  assert.equal(summary.attentionTotal, 0);
  assert.equal(projectIndexReadinessLabel("indexMissing"), "尚未建立索引");
  assert.match(projectIndexReadinessDetail("indexMissing"), /不代表后台任务正在运行/u);
});
