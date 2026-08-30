import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildProjectItemPlanEvidence,
  buildProjectPlanHealth,
  buildRepositoryImpactEvidence,
  isProjectPlanEvidenceStale,
} from "../src/lib/project-operations";

const projectId = "00000000-0000-4000-8000-000000000501";
const workItemId = "00000000-0000-4000-8000-000000000502";

test("项目健康状态确定性识别逾期、受阻、依赖和运营缺口", () => {
  const health = buildProjectPlanHealth({
    now: new Date("2026-08-30T15:00:00.000Z"),
    dueSoonDays: 3,
    workItems: [
      { id: workItemId, title: "逾期项", status: "inProgress", targetDate: new Date("2026-08-29T00:00:00.000Z"), assigneeId: null, acceptanceCriteria: null, origin: "manual" },
      { id: "00000000-0000-4000-8000-000000000503", title: "前置项", status: "blocked", targetDate: null, assigneeId: "00000000-0000-4000-8000-000000000504", acceptanceCriteria: "解除阻塞", origin: "manual" },
      { id: "00000000-0000-4000-8000-000000000505", title: "依赖项", status: "planned", targetDate: new Date("2026-09-02T00:00:00.000Z"), assigneeId: "00000000-0000-4000-8000-000000000504", acceptanceCriteria: "验证结果", origin: "agentRecommendation" },
      { id: "00000000-0000-4000-8000-000000000506", title: "建议", status: "proposed", targetDate: null, assigneeId: null, acceptanceCriteria: null, origin: "agentRecommendation" },
    ],
    dependencies: [{ workItemId: "00000000-0000-4000-8000-000000000505", dependsOnId: "00000000-0000-4000-8000-000000000503" }],
    evidenceLinks: [{ workItemId: "00000000-0000-4000-8000-000000000503", stale: true }],
    impacts: [{ status: "proposed" }],
    actions: [{ status: "waitingApproval" }],
  });
  assert.equal(health.status, "atRisk");
  assert.equal(health.counts.overdue, 1);
  assert.equal(health.counts.blocked, 1);
  assert.equal(health.counts.dependencyBlocked, 1);
  assert.equal(health.counts.unassigned, 1);
  assert.equal(health.counts.missingAcceptance, 1);
  assert.equal(health.counts.missingEvidence, 2);
  assert.equal(health.counts.staleEvidence, 1);
  assert.equal(health.counts.pendingRecommendations, 1);
  assert.equal(health.counts.openImpacts, 1);
  assert.equal(health.counts.pendingApprovals, 1);
});

test("工作项事实证据固定内容且能识别后续事实修订", () => {
  const updatedAt = new Date("2026-08-30T03:00:00.000Z");
  const built = buildProjectItemPlanEvidence({
    projectId,
    workItemId,
    item: {
      id: "00000000-0000-4000-8000-000000000507",
      type: "decision",
      reviewStatus: "confirmed",
      title: "采用 PostgreSQL",
      content: "项目主数据库使用 PostgreSQL。",
      sourceExcerpt: "PostgreSQL",
      updatedAt,
      lastVerifiedAt: updatedAt,
      sourceId: "00000000-0000-4000-8000-000000000508",
      sourceContentHash: "a".repeat(64),
    },
  });
  assert.match(built.fingerprint, /^[0-9a-f]{64}$/u);
  assert.equal(isProjectPlanEvidenceStale({ workItemId, kind: "projectItem", evidenceSnapshot: built.snapshot, projectItem: { reviewStatus: "confirmed", updatedAt }, projectSource: null, repositorySyncRun: null }), false);
  assert.equal(isProjectPlanEvidenceStale({ workItemId, kind: "projectItem", evidenceSnapshot: built.snapshot, projectItem: { reviewStatus: "confirmed", updatedAt: new Date("2026-08-30T04:00:00.000Z") }, projectSource: null, repositorySyncRun: null }), true);
});

test("仓库变更信号顺序稳定且只陈述变更、不推断影响", () => {
  const run = { id: "00000000-0000-4000-8000-000000000509", manifestFingerprint: "b".repeat(64), completedAt: new Date("2026-08-30T05:00:00.000Z"), addedCount: 1, updatedCount: 1, deletedCount: 0, withheldCount: 0 };
  const changes = [
    { identity: "z", changeType: "updated", targetKind: "code", normalizedPath: "src/z.ts", remoteIdentity: null, beforeContentHash: "c".repeat(64), afterContentHash: "d".repeat(64) },
    { identity: "a", changeType: "added", targetKind: "code", normalizedPath: "src/a.ts", remoteIdentity: null, beforeContentHash: null, afterContentHash: "e".repeat(64) },
  ];
  const first = buildRepositoryImpactEvidence({ projectId, run, changes });
  const second = buildRepositoryImpactEvidence({ projectId, run, changes: [...changes].reverse() });
  assert.equal(first.fingerprint, second.fingerprint);
  assert.equal(first.totalChanges, 2);
  assert.match(first.summary, /不推断/u);
  assert.doesNotMatch(first.summary, /自动修改/u);
});

test("项目运营迁移固定成员、证据、终态和影响状态数据库门禁", async () => {
  const migration = await readFile("prisma/migrations/20260830030000_add_project_operations_loop/migration.sql", "utf8");
  assert.match(migration, /ProjectWorkItemEvidenceLink_target_check/u);
  assert.match(migration, /project work item evidence links are append-only/u);
  assert.match(migration, /project work item completion evidence is required/u);
  assert.match(migration, /terminal project work items are immutable/u);
  assert.match(migration, /invalid project plan impact transition/u);
  assert.doesNotMatch(migration, /shell\.execute|code\.write|pull-request\.create|deploy\.execute/u);
});

test("计划健康自动化只读取本地运营状态且不进入模型运行", async () => {
  const automation = await readFile("src/lib/automation.ts", "utf8");
  assert.match(automation, /getProjectOperationsSummary/u);
  assert.match(automation, /run\.rule\.kind === "projectPlanHealth"/u);
  const branch = automation.slice(automation.indexOf("async function executeProjectPlanHealth"), automation.indexOf("async function executeRun"));
  assert.doesNotMatch(branch, /requireProjectAiRoute|AiProvider|fetch\(|model/u);
});
