import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import {
  PROJECT_AGENT_TOOLS,
  ProjectIntelligenceError,
  parseProjectAgentAnswer,
  parseProjectAgentPlan,
  parseProjectIntelligenceReport,
  runProjectAgentJob,
  runProjectBriefJob,
} from "../src/lib/web-project-intelligence";

const projectId = "11111111-1111-4111-8111-111111111111";
const memoryId = "22222222-2222-4222-8222-222222222222";

test("read-only project agent accepts only its fixed bounded tool plan", () => {
  const plan = parseProjectAgentPlan(JSON.stringify({
    objective: "核对当前风险及其证据",
    calls: [
      { tool: "project_overview", arguments: {} },
      { tool: "confirmed_items", arguments: { types: ["issue", "risk"], take: 10 } },
      { tool: "memory_search", arguments: { query: "当前风险和阻塞", take: 6 } },
      { tool: "repository_status", arguments: {} },
    ],
  }));

  assert.equal(plan.calls.length, 4);
  assert.deepEqual(PROJECT_AGENT_TOOLS, [
    "project_overview",
    "confirmed_items",
    "memory_search",
    "repository_status",
  ]);
});

test("project agent rejects write tools, missing required reads and extra fields", () => {
  const invalidPlans = [
    {
      objective: "修改代码",
      calls: [
        { tool: "project_overview", arguments: {} },
        { tool: "memory_search", arguments: { query: "问题", take: 4 } },
        { tool: "github_write", arguments: { path: "src/app.ts" } },
      ],
    },
    {
      objective: "只看概况",
      calls: [{ tool: "project_overview", arguments: {} }, { tool: "repository_status", arguments: {} }],
    },
    {
      objective: "重复概况",
      calls: [
        { tool: "project_overview", arguments: {} },
        { tool: "project_overview", arguments: {} },
        { tool: "memory_search", arguments: { query: "风险", take: 4 } },
      ],
    },
    {
      objective: "额外字段",
      calls: [
        { tool: "project_overview", arguments: {}, shell: "pwd" },
        { tool: "memory_search", arguments: { query: "风险", take: 4 } },
      ],
    },
  ];

  for (const value of invalidPlans) {
    assert.throws(
      () => parseProjectAgentPlan(JSON.stringify(value)),
      (error) => error instanceof ProjectIntelligenceError && error.code === "PROJECT_INTELLIGENCE_INVALID_PLAN",
    );
  }
});

test("project brief and agent answer accept only issued citation IDs", () => {
  const allowed = new Set([projectId, memoryId]);
  const report = parseProjectIntelligenceReport(JSON.stringify({
    status: "needs_attention",
    headline: "当前需要关注一个风险",
    summary: "证据显示当前风险仍未关闭。",
    citations: [memoryId],
    progress: [],
    decisions: [],
    issues: [],
    risks: [{ text: "当前风险仍未关闭", citations: [memoryId] }],
    needsAttention: [{ text: "需要确认负责人", citations: [projectId] }],
    questions: [],
  }), allowed);
  assert.equal(report.status, "needs_attention");

  const answer = parseProjectAgentAnswer(JSON.stringify({
    answer: "当前项目需要先确认风险负责人。",
    citations: [projectId, memoryId],
    recommendations: [{ text: "确认风险负责人", citations: [projectId] }],
    uncertainties: ["当前证据没有负责人信息"],
  }), allowed);
  assert.equal(answer.recommendations.length, 1);

  const forged = "33333333-3333-4333-8333-333333333333";
  assert.throws(
    () => parseProjectAgentAnswer(JSON.stringify({
      answer: "伪造引用",
      citations: [forged],
      recommendations: [],
      uncertainties: [],
    }), allowed),
    (error) => error instanceof ProjectIntelligenceError && error.code === "PROJECT_INTELLIGENCE_INVALID_CITATION",
  );
});

test("project intelligence runtime has no direct host execution or external write capability", () => {
  const source = readFileSync(join(process.cwd(), "src/lib/web-project-intelligence.ts"), "utf8");
  assert.doesNotMatch(source, /\bexec(?:File|Sync)?\s*\(/u);
  assert.doesNotMatch(source, /\bspawn\s*\(/u);
  assert.doesNotMatch(source, /\bwriteFile(?:Sync)?\s*\(/u);
  assert.doesNotMatch(source, /\bfetch\s*\(/u);
  assert.doesNotMatch(source, /node:(?:child_process|fs)/u);
});

test("project intelligence requires per-run consent before database or provider work", async () => {
  const unreachableDb = {} as PrismaClient;
  await assert.rejects(
    () => runProjectBriefJob({
      projectId,
      requestedBy: { id: projectId },
      clientKey: "brief-without-consent",
      consent: { acknowledged: false, version: "invalid" },
    }, unreachableDb),
    (error: unknown) => error instanceof Error && error.message === "WEB_AI_CONSENT_REQUIRED",
  );
  await assert.rejects(
    () => runProjectAgentJob({
      projectId,
      requestedBy: { id: projectId },
      clientKey: "agent-without-consent",
      consent: { acknowledged: false, version: "invalid" },
      question: "当前状态如何？",
    }, unreachableDb),
    (error: unknown) => error instanceof Error && error.message === "WEB_AI_CONSENT_REQUIRED",
  );
});

test("project intelligence write routes reject cross-site requests before authentication", async () => {
  const [briefRoute, agentRoute] = await Promise.all([
    import("../src/app/api/projects/[projectId]/intelligence/brief/route"),
    import("../src/app/api/projects/[projectId]/intelligence/agent/route"),
  ]);
  const context = { params: Promise.resolve({ projectId }) };
  const request = () => new Request(`http://127.0.0.1:3000/api/projects/${projectId}/intelligence`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      host: "127.0.0.1:3000",
      origin: "https://attacker.example",
    },
    body: "{}",
  });
  const [briefResponse, agentResponse] = await Promise.all([
    briefRoute.POST(request(), context),
    agentRoute.POST(request(), context),
  ]);
  assert.equal(briefResponse.status, 403);
  assert.equal(agentResponse.status, 403);
  assert.equal((await briefResponse.json()).error.code, "AUTH_CSRF_REJECTED");
  assert.equal((await agentResponse.json()).error.code, "AUTH_CSRF_REJECTED");
});
