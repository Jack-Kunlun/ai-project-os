import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  ProjectPlanError,
  canonicalAgentRecommendationEvidence,
  isProjectObjectiveStatusTransitionAllowed,
  isProjectWorkItemStatusTransitionAllowed,
  wouldCreateProjectWorkItemDependencyCycle,
} from "../src/lib/project-plan";

const projectId = "00000000-0000-4000-8000-000000000401";
const agentRunId = "00000000-0000-4000-8000-000000000402";
const firstCitation = { id: "00000000-0000-4000-8000-000000000403", kind: "item", label: "风险", excerpt: "需要修复", path: null, externalRef: null, frozenCommitSha: null, contentHash: "a".repeat(64) };
const secondCitation = { id: "00000000-0000-4000-8000-000000000404", kind: "repository", label: "代码", excerpt: "测试缺失", path: "src/index.ts", externalRef: null, frozenCommitSha: "b".repeat(40), contentHash: "c".repeat(64) };

test("项目目标与工作项状态机只允许人工可解释的前向转换", () => {
  assert.equal(isProjectObjectiveStatusTransitionAllowed("draft", "active"), true);
  assert.equal(isProjectObjectiveStatusTransitionAllowed("active", "completed"), true);
  assert.equal(isProjectObjectiveStatusTransitionAllowed("completed", "active"), false);
  assert.equal(isProjectWorkItemStatusTransitionAllowed("proposed", "planned"), true);
  assert.equal(isProjectWorkItemStatusTransitionAllowed("planned", "inProgress"), true);
  assert.equal(isProjectWorkItemStatusTransitionAllowed("inProgress", "completed"), true);
  assert.equal(isProjectWorkItemStatusTransitionAllowed("blocked", "planned"), true);
  assert.equal(isProjectWorkItemStatusTransitionAllowed("completed", "inProgress"), false);
});

test("工作项依赖检查拒绝直接与传递循环", () => {
  const a = "00000000-0000-4000-8000-000000000411";
  const b = "00000000-0000-4000-8000-000000000412";
  const c = "00000000-0000-4000-8000-000000000413";
  assert.equal(wouldCreateProjectWorkItemDependencyCycle(a, a, []), true);
  assert.equal(wouldCreateProjectWorkItemDependencyCycle(a, b, []), false);
  assert.equal(wouldCreateProjectWorkItemDependencyCycle(a, b, [{ workItemId: b, dependsOnId: c }, { workItemId: c, dependsOnId: a }]), true);
});

test("智能体建议证据快照固定完整引用且不受输入对象顺序影响", () => {
  const input = {
    projectId,
    agentRunId,
    recommendationIndex: 0,
    recommendation: { text: "补充回归测试", citations: [firstCitation.id, secondCitation.id] },
    inputManifestFingerprint: "d".repeat(64),
    createdAt: new Date("2026-08-30T02:00:00.000Z"),
  };
  const first = canonicalAgentRecommendationEvidence({ ...input, citations: [firstCitation, secondCitation] });
  const second = canonicalAgentRecommendationEvidence({ ...input, citations: [secondCitation, firstCitation] });
  assert.equal(first.fingerprint, second.fingerprint);
  assert.deepEqual(first.snapshot, second.snapshot);
  assert.match(first.fingerprint, /^[0-9a-f]{64}$/u);
  assert.throws(
    () => canonicalAgentRecommendationEvidence({ ...input, citations: [firstCitation] }),
    (error) => error instanceof ProjectPlanError && error.code === "PROJECT_PLAN_EVIDENCE_INVALID",
  );
});

test("V4 迁移固定来源、状态、依赖和不可变审计", async () => {
  const migration = await readFile("prisma/migrations/20260830020000_add_evidence_driven_project_plan/migration.sql", "utf8");
  assert.match(migration, /ProjectWorkItem_origin_check/u);
  assert.match(migration, /invalid project objective status transition/u);
  assert.match(migration, /invalid project work item status transition/u);
  assert.match(migration, /ProjectWorkItemDependency_active_key/u);
  assert.match(migration, /project work item dependencies are append-only/u);
  assert.match(migration, /project plan audit is immutable/u);
  assert.doesNotMatch(migration, /shell\.execute|code\.write|pull-request\.create|deploy\.execute/u);
});

test("项目计划写入口同时执行同源、会话与生命周期校验", async () => {
  const route = await readFile("src/app/api/projects/[projectId]/plan/route.ts", "utf8");
  assert.equal(route.match(/assertSameOrigin\(request\)/gu)?.length, 2);
  assert.equal(route.match(/assertProjectActive\(id\)/gu)?.length, 2);
  assert.equal(route.match(/requireApiSession\(request\)/gu)?.length, 3);
  const service = await readFile("src/lib/project-plan.ts", "utf8");
  assert.doesNotMatch(service, /child_process|execSync|spawn\(|shell\.execute|code\.write|deploy\.execute/u);
  assert.match(service, /assertProjectAccess\(actor, projectId\.data, "edit"/u);
  assert.match(service, /evidenceFingerprint/u);
});
