import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PROJECT_KNOWLEDGE_FLOW_LABEL, PROJECT_KNOWLEDGE_TERMS } from "../src/lib/product-terminology";

test("project knowledge terminology has one shared four-step lifecycle", () => {
  assert.deepEqual(PROJECT_KNOWLEDGE_TERMS.map((term) => term.label), ["原始资料", "AI 候选", "已确认事实", "AI 可引用记忆"]);
  assert.equal(PROJECT_KNOWLEDGE_FLOW_LABEL, "原始资料 → AI 候选 → 已确认事实 → AI 可引用记忆");
});

test("R16 entry points use the shared navigation and evidence contracts", async () => {
  const [overview, materials, governance, review, intelligence, automations, settings, routes] = await Promise.all([
    readFile("src/app/projects/[projectId]/project-overview-client.tsx", "utf8"),
    readFile("src/app/projects/[projectId]/project-client.tsx", "utf8"),
    readFile("src/app/projects/[projectId]/governance/project-governance-client.tsx", "utf8"),
    readFile("src/app/projects/[projectId]/project-material-review-queue.tsx", "utf8"),
    readFile("src/app/projects/[projectId]/intelligence/project-intelligence-client.tsx", "utf8"),
    readFile("src/app/projects/[projectId]/automations/project-automations-client.tsx", "utf8"),
    readFile("src/app/settings/settings-client.tsx", "utf8"),
    readFile("src/app/settings/platform-default-routes-client.tsx", "utf8"),
  ]);
  assert.match(overview, /status: "failed"/u);
  assert.match(overview, /focus: "task-runs"/u);
  assert.match(overview, /parseProjectPageState\("overview"/u);
  assert.match(materials, /parseProjectPageState\("materials"/u);
  assert.match(materials, /navigation\.returnTo/u);
  assert.match(materials, /materialReviewHref/u);
  assert.match(materials, /focus: "review-queue"/u);
  assert.match(materials, /focus: "sources-heading"/u);
  assert.match(materials, /safeResponseError/u);
  assert.doesNotMatch(materials, /payload\.error\?\.message/u);
  assert.match(governance, /parseProjectPageState/u);
  assert.match(governance, /usage\.routes \?\? \[\]/u);
  assert.match(governance, /tabIndex=\{-1\}/u);
  assert.match(review, /KnowledgeLifecycle/u);
  assert.match(intelligence, /ScopeEvidenceCard/u);
  assert.match(intelligence, /当前缺失/u);
  assert.match(intelligence, /就绪条件/u);
  assert.match(intelligence, /当前状态接口未提供识别与抽取路由的就绪证据/u);
  assert.match(intelligence, /memoryRuntimeBlocked/u);
  assert.doesNotMatch(intelligence, /ready: !loading/u);
  assert.match(automations, /不使用模型或个人连接/u);
  assert.match(automations, /下一次预计运行（UTC）/u);
  assert.match(automations, /业务执行失败不会在当前周期内自动重试；Worker 租约过期会按恢复策略安排后续运行；连续失败 3 次后自动暂停规则/u);
  assert.match(automations, /<section aria-labelledby="automation-preview-title"/u);
  assert.doesNotMatch(automations, /role="dialog"|aria-modal/u);
  assert.match(automations, /confirmButtonRef\.current\?\.focus\(\)/u);
  assert.match(settings, /供应商配置边界/u);
  assert.match(settings, /safeResponseError/u);
  assert.match(routes, /路由配置边界/u);
  assert.match(routes, /safeResponseError/u);
});

test("R16 clients use safe error presentation instead of server messages", async () => {
  const clients = await Promise.all([
    readFile("src/app/profile/models/personal-models-client.tsx", "utf8"),
    readFile("src/app/profile/connections/git/git-connections-client.tsx", "utf8"),
    readFile("src/app/profile/connections/mcp/mcp-connections-client.tsx", "utf8"),
    readFile("src/app/team/team-client.tsx", "utf8"),
    readFile("src/app/admin/models/platform-grant-offer-policy-client.tsx", "utf8"),
  ]);

  for (const client of clients) {
    assert.match(client, /safeResponseError/u);
    assert.doesNotMatch(client, /payload\.error(?:\?\.)?message/u);
  }
});
