import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import { getPlatformTokenAdvisory } from "../src/lib/ai-entitlements";
import {
  PROJECT_AGENT_TOOLS,
  ProjectIntelligenceError,
  parseProjectAgentAnswer,
  parseProjectAgentPlan,
  parseProjectIntelligenceReport,
  listProjectIntelligence,
  publicRouteSource,
} from "../src/lib/web-project-intelligence";
import { decideProjectIntelligenceRuntime } from "../src/lib/project-intelligence-runtime-decision";

const projectId = "11111111-1111-4111-8111-111111111111";
const memoryId = "22222222-2222-4222-8222-222222222222";

const platformRoute = {
  available: true,
  source: "platform_default" as const,
  payer: "platform_caller" as const,
  errorCode: null,
};
const personalRoute = {
  available: true,
  source: "personal_delegation" as const,
  payer: "personal_connection_owner" as const,
  errorCode: null,
};
const blockedPlatformRoute = {
  available: false,
  source: "platform_default" as const,
  payer: "platform_caller" as const,
  errorCode: "PLATFORM_ROUTE_UNAVAILABLE" as const,
};
const blockedPersonalRoute = {
  available: false,
  source: "personal_delegation" as const,
  payer: "personal_connection_owner" as const,
  errorCode: "PERSONAL_ROUTE_UNAVAILABLE" as const,
};
const unknownRoute = {
  available: true,
  source: null,
  payer: null,
  errorCode: null,
};

test("project intelligence runtime decision preserves payer and one next action", () => {
  const base = {
    projectId,
    permission: "edit" as const,
    archived: false,
    embeddingRoute: platformRoute,
    projectAnalysisRoute: platformRoute,
  };
  const ready = decideProjectIntelligenceRuntime({ ...base, indexState: "ready" });
  assert.equal(ready.code, "ready");
  assert.equal(ready.canRun, true);
  assert.equal(ready.payer, "platform_caller");
  assert.equal(ready.payerLabel, "平台额度，由当前发起人扣减");
  assert.equal(ready.nextAction.kind, "run_project_ai");

  const personal = decideProjectIntelligenceRuntime({
    ...base,
    embeddingRoute: personalRoute,
    projectAnalysisRoute: personalRoute,
    indexState: "ready",
  });
  assert.equal(personal.payer, "personal_connection_owner");
  assert.equal(personal.payerLabel, "个人连接承担");

  const mixed = decideProjectIntelligenceRuntime({
    ...base,
    embeddingRoute: personalRoute,
    projectAnalysisRoute: platformRoute,
    indexState: "ready",
  });
  assert.equal(mixed.code, "ready");
  assert.equal(mixed.payer, "mixed");
  assert.equal(mixed.routeSource, "mixed");
  assert.equal(mixed.payerLabel, "混合承担：平台额度与个人连接");

  const observedQuota = decideProjectIntelligenceRuntime({
    ...base,
    indexState: "ready",
    platformQuotaAvailable: true,
  });
  assert.match(observedQuota.detail, /已观察到有剩余额度/u);
  assert.match(observedQuota.detail, /提交时仍复核额度、并发与授权/u);

  const blocked = decideProjectIntelligenceRuntime({ ...base, projectAnalysisRoute: blockedPlatformRoute, indexState: "ready" });
  assert.equal(blocked.code, "platform_route_blocked");
  assert.equal(blocked.canRun, false);
  assert.equal(blocked.nextAction.kind, "contact_platform_admin");

  const unknown = decideProjectIntelligenceRuntime({ ...base, projectAnalysisRoute: unknownRoute, indexState: "ready" });
  assert.equal(unknown.code, "platform_route_blocked");
  assert.equal(unknown.canRun, false);

  const quotaBlocked = decideProjectIntelligenceRuntime({ ...base, indexState: "ready", platformQuotaAvailable: false });
  assert.equal(quotaBlocked.code, "platform_quota_advisory_blocked");
  assert.equal(quotaBlocked.payerLabel, "平台额度，由当前发起人扣减");
  assert.equal(quotaBlocked.nextAction.kind, "contact_platform_admin");

  const personalBlocked = decideProjectIntelligenceRuntime({
    ...base,
    embeddingRoute: blockedPersonalRoute,
    projectAnalysisRoute: blockedPersonalRoute,
    indexState: "ready",
  });
  assert.equal(personalBlocked.code, "personal_route_blocked");
  assert.equal(personalBlocked.payer, "personal_connection_owner");

  const viewer = decideProjectIntelligenceRuntime({ ...base, permission: "view", indexState: "ready" });
  assert.equal(viewer.code, "run_forbidden");
  assert.equal(viewer.canRun, false);
  assert.equal(viewer.nextAction.kind, "request_edit_access");

  const archived = decideProjectIntelligenceRuntime({ ...base, archived: true, indexState: "ready" });
  assert.equal(archived.code, "run_forbidden");
  assert.equal(archived.reason, "archived");
  assert.equal(archived.nextAction.kind, "contact_project_admin");

  assert.equal(publicRouteSource("platform_default"), "platform_default");
  assert.equal(publicRouteSource("personal_delegation"), "personal_delegation");
  assert.equal(publicRouteSource("project_override"), null);
  assert.equal(publicRouteSource("unknown_route"), null);

  for (const [indexState, code] of [
    ["indexMissing", "index_missing"],
    ["legacyIndex", "legacy_index"],
    ["routeIncompatible", "index_incompatible"],
    ["inputsChanged", "inputs_changed"],
  ] as const) {
    const decision = decideProjectIntelligenceRuntime({ ...base, indexState });
    assert.equal(decision.code, code);
    assert.equal(decision.canRun, false);
    assert.match(decision.nextAction.kind, /memory_index/iu);
  }
});

test("project intelligence workbench does not advertise legacy project route controls", () => {
  const source = readFileSync(join(process.cwd(), "src/app/projects/[projectId]/intelligence/project-intelligence-client.tsx"), "utf8");
  const runtimeSource = readFileSync(join(process.cwd(), "src/lib/project-intelligence-runtime-decision.ts"), "utf8");
  assert.doesNotMatch(source, /\/control/u);
  assert.match(source, /operation: "embedding" \| "projectAnalysis"/u);
  assert.match(runtimeSource, /平台额度，由当前发起人扣减/u);
  assert.match(runtimeSource, /个人连接承担/u);
});

test("platform quota advisory is read-only and does not recover reservations", async () => {
  let grantReads = 0;
  let reservationReads = 0;
  const db = {
    platformTokenGrant: {
      findMany: async () => {
        grantReads += 1;
        return [{ remainingTokens: 12, expiresAt: new Date("2030-01-01T00:00:00.000Z") }];
      },
    },
    platformTokenReservation: {
      findMany: async () => {
        reservationReads += 1;
        return [{ reservedTokens: 3 }];
      },
    },
  } as unknown as PrismaClient;
  const advisory = await getPlatformTokenAdvisory("11111111-1111-4111-8111-111111111111", db, new Date("2029-01-01T00:00:00.000Z"));
  assert.equal(advisory.availableTokens, 12);
  assert.equal(advisory.reservedTokens, 3);
  assert.equal(advisory.hasAvailableTokens, true);
  assert.equal(grantReads, 1);
  assert.equal(reservationReads, 1);
});

function statusTransactionDb() {
  const workspaceId = "33333333-3333-4333-8333-333333333333";
  const now = new Date("2026-01-01T00:00:00.000Z");
  let transactionDepth = 0;
  let accessTransactions = 0;
  let outsideReads = 0;
  let rawQueryCount = 0;
  const read = () => {
    if (transactionDepth === 0) outsideReads += 1;
  };
  const emptyModel = () => ({
    findMany: async () => { read(); return []; },
    findUnique: async () => { read(); return null; },
    findFirst: async () => { read(); return null; },
    count: async () => { read(); return 0; },
  });
  const project = {
    findUnique: async () => {
      read();
      return {
        id: projectId,
        workspaceId,
        membershipInheritanceMode: "projectOnly",
        archivedAt: null,
        name: "事务快照测试项目",
        slug: "transaction-snapshot-test",
        description: null,
        updatedAt: now,
        _count: { sources: 0, items: 0, repositoryLinks: 0 },
      };
    },
    findMany: async () => { read(); return [{ id: projectId, workspaceId, membershipInheritanceMode: "projectOnly" }]; },
    count: async () => { read(); return 1; },
  };
  const projectMembership = {
    findMany: async () => {
      read();
      return [{
        id: "44444444-4444-4444-8444-444444444444",
        projectId,
        workspaceId,
        userId: projectId,
        role: "editor",
        accessState: "confirmed",
        createdAt: now,
        updatedAt: now,
      }];
    },
    findFirst: async () => { read(); return null; },
    findUnique: async () => { read(); return null; },
  };
  const db = {
    appUser: {
      findUnique: async () => {
        read();
        return { id: projectId, role: "user", disabledAt: null, accountAccessVersion: 1 };
      },
    },
    project,
    projectMembership,
    workspaceMembership: emptyModel(),
    projectAiEffectiveRouteSelection: emptyModel(),
    platformDefaultAiRoute: emptyModel(),
    projectIntelligenceReport: emptyModel(),
    projectAgentRun: emptyModel(),
    memoryIndexPointer: emptyModel(),
    projectSource: emptyModel(),
    repositoryMaterialGenerationPointer: emptyModel(),
    projectCodeSnapshotPointer: emptyModel(),
    projectRepositoryLink: emptyModel(),
    projectItem: emptyModel(),
    projectFactRelation: emptyModel(),
    memoryQualityIssue: emptyModel(),
    projectWorkItem: emptyModel(),
    projectWorkItemDependency: emptyModel(),
    projectWorkItemEvidenceLink: emptyModel(),
    projectPlanImpactSuggestion: emptyModel(),
    projectAction: emptyModel(),
    platformTokenGrant: emptyModel(),
    platformTokenReservation: emptyModel(),
    $executeRaw: async () => { read(); return 0; },
    $queryRaw: async (query: unknown) => {
      read();
      const sql = ((query as { strings?: readonly string[] }).strings ?? []).join(" ");
      if (sql.includes('FROM "AppUser"')) return [{ id: projectId, role: "user", disabledAt: null, accountAccessVersion: 1 }];
      if (sql.includes('FROM "Project"')) return [{ id: projectId, workspaceId, membershipInheritanceMode: "project_only", archivedAt: null }];
      if (sql.includes('FROM "WorkspaceMembership"')) return [];
      if (sql.includes('FROM "ProjectMembership"')) return [{ role: "editor" }];
      rawQueryCount += 1;
      // The repository status service issues its repository and project
      // snapshot queries in this order. Both execute through the access tx.
      return rawQueryCount === 2 ? [{
        projectCodeSnapshotId: null,
        projectRagSnapshotId: null,
        requiredRepositoryCount: null,
        manualRagSnapshotId: null,
        publishedAt: null,
        ragReady: false,
      }] : [];
    },
  } as Record<string, unknown>;
  const tx = new Proxy(db, {
    get(target, property, receiver) {
      if (property === "$transaction") return undefined;
      return Reflect.get(target, property, receiver);
    },
  });
  db.$transaction = async (callback: (transaction: unknown) => Promise<unknown>) => {
    accessTransactions += 1;
    transactionDepth += 1;
    try {
      return await callback(tx);
    } finally {
      transactionDepth -= 1;
    }
  };
  return {
    db: db as unknown as PrismaClient,
    accessTransactions: () => accessTransactions,
    outsideReads: () => outsideReads,
  };
}

test("project intelligence status uses the access transaction admission for every read", async () => {
  const runtime = statusTransactionDb();
  const status = await listProjectIntelligence(projectId, { id: projectId, role: "user", accountAccessVersion: 1 }, runtime.db);
  assert.equal(runtime.accessTransactions(), 1);
  assert.equal(runtime.outsideReads(), 0);
  assert.equal(status.runtimeDecision.code, "platform_route_blocked");
});

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

test("project intelligence requires a server challenge before database or provider work", () => {
  for (const path of [
    "src/app/api/projects/[projectId]/intelligence/brief/route.ts",
    "src/app/api/projects/[projectId]/intelligence/agent/route.ts",
  ]) {
    const source = readFileSync(join(process.cwd(), path), "utf8");
    assert.match(source, /phase: z\.literal\("prepare"\)/u, path);
    assert.match(source, /phase: z\.literal\("execute"\)/u, path);
    assert.match(source, /challengeId: z\.string\(\)\.uuid\(\)/u, path);
    assert.doesNotMatch(source, /\b(?:acknowledged|consent|version)\b/u, path);
  }
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
