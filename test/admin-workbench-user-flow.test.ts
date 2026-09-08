import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import { connectProjectGitRepository, GitServiceError } from "../src/lib/git";
import { getSystemOverview } from "../src/lib/system-overview";
import { updateWorkspaceMember } from "../src/lib/workspaces";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const memberId = "22222222-2222-4222-8222-222222222222";
const actorId = "33333333-3333-4333-8333-333333333333";
const projectId = "44444444-4444-4444-8444-444444444444";
const gitConnectionId = "55555555-5555-4555-8555-555555555555";
const currentAdminActor = { id: actorId, role: "admin" as const, accountAccessVersion: 1 };

const repositoryLinkInput = {
  gitConnectionId,
  repositoryPath: "team/service",
  trackedRef: "main",
  role: "application",
  requiredForProjectSnapshot: true,
  codeEnabled: true,
  metadataEnabled: true,
  includeRoots: ["."],
  softExcludePatterns: [],
};

test("workspace member API rejects a direct global disable payload before opening a write transaction", async () => {
  let transactionOpened = false;
  const db = {
    workspaceMembership: { findUnique: async () => ({ role: "owner" as const }) },
    $transaction: async () => {
      transactionOpened = true;
      throw new Error("transaction should not open for invalid member input");
    },
  } as unknown as PrismaClient;

  await assert.rejects(
    () => updateWorkspaceMember(workspaceId, memberId, { disabled: true }, { id: actorId, role: "member" }, db),
    (error: unknown) => error instanceof Error && error.name === "ZodError",
  );
  assert.equal(transactionOpened, false);
});

test("workspace member updates cannot mutate a global account", async () => {
  const [service, route, team] = await Promise.all([
    readFile("src/lib/workspaces.ts", "utf8"),
    readFile("src/app/api/workspaces/[workspaceId]/members/[userId]/route.ts", "utf8"),
    readFile("src/app/team/team-client.tsx", "utf8"),
  ]);

  assert.match(service, /updateMemberSchema = z\.object\([\s\S]*?\)\.strict\(\)/u);
  assert.doesNotMatch(service, /disabled:\s*z\.boolean\(\)/u);
  assert.doesNotMatch(service, /tx\.appUser\.(?:update|updateMany)/u);
  assert.match(route, /assertSameOrigin\(request\)/u);
  assert.match(route, /updateWorkspaceMember/u);
  assert.doesNotMatch(team, /patch\(\{\s*disabled:/u);
});

test("legacy project Git connect is frozen before project metadata for ordinary users", async () => {
  let gitConnectionReads = 0;
  let transactionOpened = false;
  const db = {
    appUser: { findUnique: async () => ({ id: actorId, role: "member" as const, disabledAt: null }) },
    project: {
      findUnique: async (input: { select?: { archivedAt?: boolean } }) => input.select?.archivedAt === true
        ? { archivedAt: null }
        : { workspace: { memberships: [] }, memberships: [{ role: "owner" as const }] },
    },
    gitConnection: { findUnique: async () => { gitConnectionReads += 1; throw new Error("ordinary users must not load Git connections"); } },
    $transaction: async () => { transactionOpened = true; throw new Error("ordinary users must not open a write transaction"); },
  } as unknown as PrismaClient;

  await assert.rejects(
    () => connectProjectGitRepository(projectId, null, { id: actorId, role: "member" }, db),
    (error: unknown) => error instanceof GitServiceError && error.code === "GIT_LEGACY_PROJECT_CONNECT_FROZEN",
  );
  assert.equal(gitConnectionReads, 0);
  assert.equal(transactionOpened, false);
});

test("legacy project Git connect is frozen for system admins too", async () => {
  for (const status of ["configured", "verified"] as const) {
    const calls: Array<Record<string, unknown>> = [];
    const db = {
      appUser: { findUnique: async () => ({ id: actorId, role: "admin" as const, disabledAt: null }) },
      project: {
        findUnique: async (input: { select?: { archivedAt?: boolean } }) => input.select?.archivedAt === true
          ? { archivedAt: null }
          : { workspace: { memberships: [] }, memberships: [{ role: "owner" as const }] },
      },
      gitConnection: {
        findUnique: async (input: Record<string, unknown>) => {
          calls.push(input);
          return { id: gitConnectionId, status, disabledAt: null };
        },
      },
    } as unknown as PrismaClient;

    await assert.rejects(
      () => connectProjectGitRepository(projectId, repositoryLinkInput, { id: actorId, role: "admin" }, db),
      (error: unknown) => error instanceof GitServiceError && error.code === "GIT_LEGACY_PROJECT_CONNECT_FROZEN",
    );
    assert.deepEqual(calls, []);
  }
});

test("Git project repository routes pass the session actor to the service authorization gate", async () => {
  const [route, deleteRoute, client, service] = await Promise.all([
    readFile("src/app/api/projects/[projectId]/git-repositories/route.ts", "utf8"),
    readFile("src/app/api/projects/[projectId]/git-repositories/[linkId]/route.ts", "utf8"),
    readFile("src/app/projects/[projectId]/repositories/project-repositories-client.tsx", "utf8"),
    readFile("src/lib/git/service.ts", "utf8"),
  ]);
  assert.doesNotMatch(route, /user\.role !== "admin"/u);
  assert.doesNotMatch(route, /assertProjectActive/u);
  assert.match(route, /listProjectGitRepositories\(id, user\)/u);
  assert.match(route, /connectProjectGitRepository\(id, await readJsonBody\(request\), user\)/u);
  assert.doesNotMatch(deleteRoute, /assertProjectActive/u);
  assert.match(deleteRoute, /disableProjectGitRepository\(projectId, idSchema\.parse\(params\.linkId\), user\)/u);
  assert.doesNotMatch(client, /api\/projects\/\$\{projectId\}\/git-connections/u);
  assert.doesNotMatch(client, /api\/settings\/git-connections|api\/me\/git-connections|isSystemAdmin|RepositoryForm/u);
  assert.match(client, /api\/projects\/\$\{projectId\}\/git-repository-delegations/u);
  assert.match(client, /manual-sync/u);
  assert.match(client, /manual-runs/u);
  assert.match(client, /gitConnectionId:/u);
  assert.match(client, /manualSyncAllowed:\s*true/u);
  assert.match(client, /automationAllowed:\s*false/u);
  assert.match(client, /owner-confirmation/u);
  assert.match(client, /project-confirmation/u);
  assert.match(client, /acknowledgeReadOnlyCredentialUse:\s*true/u);
  assert.match(client, /acknowledgeRepositoryScope:\s*true/u);
  assert.match(client, /acknowledgeDataEgress:\s*true/u);
  assert.match(client, /自动化、写入\/提交和旧 PAT 路径保持关闭；目标 Git 服务是否可用，以连接测试和单次读取结果为准/u);
  assert.match(client, /不会写入、提交或创建 Pull Request/u);
  assert.match(client, /href="\/profile\/connections\/git"/u);
  assert.match(client, /资料已发布到项目/u);
  assert.doesNotMatch(client, /\/git-(?:push|commit)|\/pull-requests?/u);
  assert.doesNotMatch(client, /repository\.connection\.baseUrl/u);
  assert.match(service, /listProjectGitRepositories[\s\S]*select: projectRepositoryLinkSelect/u);
  assert.match(service, /connection: \{ select: \{ id: true, name: true, providerKind: true, transport: true \} \}/u);
});

test("admin workbench and overview are server protected and dashboard has no global provider count", async () => {
  const [layout, page, overviewRoute, overviewService, shell, header, profile, dashboardRoute, settings, connections, connectionsMcp, memberships, operations] = await Promise.all([
    readFile("src/app/admin/layout.tsx", "utf8"),
    readFile("src/app/admin/page.tsx", "utf8"),
    readFile("src/app/api/system/overview/route.ts", "utf8"),
    readFile("src/lib/system-overview.ts", "utf8"),
    readFile("src/components/admin-shell.tsx", "utf8"),
    readFile("src/components/app-header.tsx", "utf8"),
    readFile("src/app/profile/profile-client.tsx", "utf8"),
    readFile("src/app/api/dashboard/route.ts", "utf8"),
    readFile("src/app/settings/page.tsx", "utf8"),
    readFile("src/app/connections/page.tsx", "utf8"),
    readFile("src/app/connections/mcp/page.tsx", "utf8"),
    readFile("src/app/system/memberships/page.tsx", "utf8"),
    readFile("src/app/system/operations/page.tsx", "utf8"),
  ]);

  assert.match(layout, /requireSystemAdminPage\(\)/u);
  assert.match(page, /AdminShell active="overview"/u);
  assert.match(overviewRoute, /user\.role !== "admin"/u);
  assert.match(overviewRoute, /status: 403/u);
  assert.doesNotMatch(overviewService, /getPlatformTokenSummary/u);
  assert.match(overviewService, /platformTokenGrant\.aggregate/u);
  assert.match(overviewService, /platformTokenReservation\.aggregate/u);
  assert.match(overviewService, /status: \{ in: \["reserved", "held"\] \}/u);
  assert.match(shell, /平台模型/u);
  assert.match(shell, /Git 连接/u);
  assert.match(shell, /MCP 连接/u);
  assert.match(shell, /用户与会员/u);
  assert.match(shell, /备份 \/ 运维/u);
  assert.doesNotMatch(header, /label: "模型设置"/u);
  assert.doesNotMatch(header, /label: "连接器"/u);
  assert.match(header, /isSystemAdmin \? <Link href="\/admin"/u);
  assert.doesNotMatch(profile, /系统管理员操作|系统运维|平台模型|Git \/ MCP 连接/u);
  assert.doesNotMatch(dashboardRoute, /aiProviderConnection/u);
  assert.match(settings, /redirect\(user\.role === "admin" \? "\/admin\/models" : "\/dashboard"\)/u);
  assert.match(connections, /await requirePageSession\(\);\s*redirect\("\/profile\/connections\/git"\)/u);
  assert.doesNotMatch(connections, /user\.role/u);
  assert.match(connectionsMcp, /await requirePageSession\(\);\s*redirect\("\/profile\/connections\/mcp"\)/u);
  assert.doesNotMatch(connectionsMcp, /user\.role/u);
  assert.match(memberships, /redirect\(user\.role === "admin" \? "\/admin\/users\/memberships" : "\/dashboard"\)/u);
  assert.match(operations, /if \(user\.role !== "admin"\) redirect\("\/dashboard"\)/u);
});

test("admin overview uses read-only aggregates and exposes no identity or credential fields", async () => {
  const now = new Date("2026-09-03T00:00:00.000Z");
  const calls: string[] = [];
  const db = {
    $queryRaw: async () => { calls.push("health"); return [{ ok: 1 }]; },
    appUser: {
      findUnique: async () => ({ id: actorId, role: "admin" as const, disabledAt: null, accountAccessVersion: 1 }),
      count: async () => { calls.push("users"); return 7; },
    },
    membershipSubscription: { count: async () => { calls.push("memberships"); return 3; } },
    aiProviderConnection: { count: async () => { calls.push("providers"); return 2; } },
    platformTokenGrant: { aggregate: async (input: { where?: unknown }) => { calls.push(input.where ? "available" : "issued"); return { _sum: input.where ? { remainingTokens: 420 } : { amount: 500_000 } }; } },
    platformTokenReservation: { aggregate: async (input: { where?: unknown }) => { calls.push("reservations"); return JSON.stringify(input.where).includes("settled") ? { _sum: { settledTokens: 35 } } : { _sum: { reservedTokens: 80 } }; } },
    workerRuntime: { findUnique: async () => { calls.push("worker"); return { status: "running", heartbeatAt: new Date(now.getTime() - 1_000), consecutiveFailures: 0 }; } },
    workspace: { findUnique: async () => ({ createdById: "99999999-9999-4999-8999-999999999999" }) },
  } as unknown as PrismaClient;

  const overview = await getSystemOverview(currentAdminActor, db, now);
  assert.deepEqual(overview.counts, { users: 7, activeMemberships: 3, verifiedPlatformModels: 2 });
  assert.deepEqual(overview.tokens, { issuedTokens: 500_000, availableTokens: 420, reservedTokens: 80, consumedTokens: 35 });
  assert.equal(overview.service.database, "up");
  assert.equal(overview.service.worker.status, "up");
  assert.equal(overview.backup.access, "restricted");
  assert.equal(overview.backup.snapshotRead, "restricted");
  assert.equal(overview.backup.freshness.status, "restricted");
  assert.deepEqual(calls.sort(), ["available", "health", "health", "issued", "memberships", "providers", "reservations", "reservations", "users", "worker"].sort());
});

test("admin overview keeps control-plane readiness separate from live-call evidence", async () => {
  const now = new Date("2026-09-03T00:00:00.000Z");
  const db = {
    $queryRaw: async () => [{ ok: 1 }],
    appUser: {
      findUnique: async () => ({ id: actorId, role: "admin" as const, disabledAt: null, accountAccessVersion: 1 }),
      count: async () => 1,
    },
    membershipSubscription: { count: async () => 0 },
    aiProviderConnection: { count: async () => 1 },
    platformTokenGrant: { aggregate: async (input: { where?: unknown }) => ({ _sum: input.where ? { remainingTokens: 10 } : { amount: 10 } }) },
    platformTokenReservation: { aggregate: async (input: { where?: unknown }) => ({ _sum: input.where && JSON.stringify(input.where).includes("settled") ? { settledTokens: 2 } : { reservedTokens: 3 } }) },
    workerRuntime: { findUnique: async () => ({ status: "running", heartbeatAt: new Date(now.getTime() - 1_000), consecutiveFailures: 2 }) },
    platformDefaultAiRoute: { findMany: async () => [] },
    project: { count: async () => 0 },
    workspace: { findUnique: async () => ({ createdById: actorId }) },
    providerCallAudit: { groupBy: async () => [{ safeErrorCode: "PROVIDER_TIMEOUT", _count: { _all: 2 } }] },
    projectMcpActionDispatchAttempt: { groupBy: async () => [{ safeErrorCode: "MCP_DISPATCH_FAILED", _count: { _all: 1 } }] },
    backgroundJob: { groupBy: async () => [{ failureCode: "JOB_FAILED", _count: { _all: 3 } }] },
    automationRun: { groupBy: async () => [] },
    projectAction: { groupBy: async () => [] },
  } as unknown as PrismaClient;

  const overview = await getSystemOverview(currentAdminActor, db, now);
  assert.equal(overview.defaultRoutes.total, 6);
  assert.equal(overview.defaultRoutes.ready, 0);
  assert.equal(overview.defaultRoutes.controlPlane, "attention");
  assert.equal(overview.defaultRoutes.liveCallEvidence, "not_obtained");
  assert.equal(overview.defaultRoutes.operations.embedding.code, "missing");
  assert.equal(overview.service.worker.consecutiveFailures, 2);
  assert.equal(overview.mcp.pendingAttestations, null);
  assert.equal(overview.mcp.evidence, "not_obtained");
  assert.equal(overview.failures.total, 6);
  assert.equal(overview.failures.window.days, 7);
  assert.equal(overview.failures.window.from, "2026-08-27T00:00:00.000Z");
  assert.equal(overview.failures.window.to, now.toISOString());
  assert.deepEqual(overview.failures.providerCalls.byCode, [{ code: "PROVIDER_TIMEOUT", count: 2 }]);
  assert.equal(overview.backup.access, "full");
  assert.equal(overview.backup.snapshotRead, "read");
  assert.equal(overview.backup.latestValidRecord.status, "none");
  assert.equal(overview.backup.freshness.status, "unknown");
  assert.equal(overview.backup.recoveryDrill.status, "not_obtained");
  assert.equal(overview.setupChecklist.find((item) => item.key === "backup-source")?.status, "unknown");
  assert.equal(overview.setupChecklist.find((item) => item.key === "default-routes")?.status, "attention");
});

test("MCP overview queue requires the same owner, verifier, and V2 attestation shape as the control plane", async () => {
  const [overview, attestationService] = await Promise.all([
    readFile("src/lib/system-overview.ts", "utf8"),
    readFile("src/lib/mcp-attestation-control-plane-service.ts", "utf8"),
  ]);
  assert.match(overview, /owner\."id"\s*=\s*connection\."ownerUserId"[\s\S]*owner\."disabledAt"\s+IS\s+NULL/u);
  assert.match(overview, /verifier\."role"\s*=\s*'admin'[\s\S]*verifier\."disabledAt"\s+IS\s+NULL/u);
  assert.match(overview, /attestation\."version"\s*=\s*1[\s\S]*attestation\."conclusion"\s*=\s*'read_only_verified'[\s\S]*attestation\."evidence"\s*=\s*'\{\}'::jsonb/u);
  assert.match(attestationService, /row\.version !== 1[\s\S]*row\.conclusion !== "read_only_verified"/u);
  assert.match(attestationService, /row\.verifiedBy\.role !== "admin"[\s\S]*row\.verifiedBy\.disabledAt !== null/u);
  assert.match(attestationService, /definition\.connection\.ownerUser\.disabledAt !== null/u);
});

test("admin overview labels MCP failures as bounded control-plane evidence and keeps backup incomplete without a drill", async () => {
  const client = await readFile("src/components/admin-overview-client.tsx", "utf8");
  assert.match(client, /调度\/控制面失败聚合/u);
  assert.match(client, /MCP 调度\/控制面失败/u);
  assert.match(client, /包括出站前拒绝，不表示已经出站/u);
  assert.match(client, /overview\.failures\.window\.days/u);
  assert.match(client, /backup\.sourceStatus/u);
  assert.match(client, /backup\.recoveryDrill\.status === "verified"/u);
  assert.match(client, /backup\.latestValidRecord\.state === "succeeded"/u);
  assert.match(client, /Worker 循环异常/u);
  assert.doesNotMatch(client, /连续失败/u);
});

test("admin failure aggregates use terminal completedAt windows, retain null-code evidence, exclude personal BYOK, and include automation and controlled actions", async () => {
  const now = new Date("2026-09-03T00:00:00.000Z");
  const whereBySource: Array<{ source: string; where: Record<string, unknown> }> = [];
  const capture = (source: string, rows: readonly Record<string, unknown>[]) => async (input: { where?: Record<string, unknown> }) => {
    whereBySource.push({ source, where: input.where ?? {} });
    return rows;
  };
  const db = {
    $queryRaw: async () => [],
    appUser: {
      findUnique: async () => ({ id: actorId, role: "admin" as const, disabledAt: null, accountAccessVersion: 1 }),
      count: async () => 1,
    },
    membershipSubscription: { count: async () => 0 },
    aiProviderConnection: { count: async () => 0 },
    platformTokenGrant: { aggregate: async (input: { where?: unknown }) => ({ _sum: input.where ? { remainingTokens: 0 } : { amount: 0 } }) },
    platformTokenReservation: { aggregate: async (input: { where?: unknown }) => ({ _sum: input.where && JSON.stringify(input.where).includes("settled") ? { settledTokens: 0 } : { reservedTokens: 0 } }) },
    workerRuntime: { findUnique: async () => null },
    project: { count: async () => 0 },
    workspace: { findUnique: async () => ({ createdById: actorId }) },
    // Simulate both ownership classes. A Prisma groupBy applies the predicate
    // before returning rows, so this callback models platform inclusion and
    // personal BYOK exclusion together with the captured where clause.
    providerCallAudit: {
      groupBy: async (input: { where?: Record<string, unknown> }) => {
        whereBySource.push({ source: "provider", where: input.where ?? {} });
        return input.where?.billingMode === "platform" && input.where?.payerKind === "platformCaller"
          ? [{ safeErrorCode: "PLATFORM_PROVIDER_FAILURE", _count: { _all: 1 } }]
          : [
            { safeErrorCode: "PLATFORM_PROVIDER_FAILURE", _count: { _all: 1 } },
            { safeErrorCode: "PERSONAL_BYOK_FAILURE", _count: { _all: 1 } },
          ];
      },
    },
    projectMcpActionDispatchAttempt: { groupBy: capture("mcp", [{ safeErrorCode: "MCP_PRE_DISPATCH_REJECTED", _count: { _all: 1 } }]) },
    backgroundJob: { groupBy: capture("background", [{ failureCode: null, _count: { _all: 1 } }]) },
    automationRun: { groupBy: capture("automation", [{ failureCode: "AUTOMATION_EXECUTION_FAILED", _count: { _all: 1 } }]) },
    projectAction: { groupBy: capture("controlled-action", [{ failureCode: null, _count: { _all: 1 } }]) },
  } as unknown as PrismaClient;

  const overview = await getSystemOverview(currentAdminActor, db, now);
  assert.equal(overview.failures.total, 5);
  assert.deepEqual(overview.failures.providerCalls.byCode, [{ code: "PLATFORM_PROVIDER_FAILURE", count: 1 }]);
  assert.deepEqual(overview.failures.backgroundJobs.byCode, [{ code: "UNCLASSIFIED_FAILURE", count: 1 }]);
  assert.deepEqual(overview.failures.automationRuns.byCode, [{ code: "AUTOMATION_EXECUTION_FAILED", count: 1 }]);
  assert.deepEqual(overview.failures.controlledActions.byCode, [{ code: "UNCLASSIFIED_FAILURE", count: 1 }]);
  assert.equal(overview.failures.mcpCalls.byCode[0]?.code, "MCP_PRE_DISPATCH_REJECTED");
  assert.equal(overview.failures.window.from, "2026-08-27T00:00:00.000Z");
  assert.equal(overview.failures.window.to, now.toISOString());
  assert.equal(whereBySource.length, 5);
  for (const entry of whereBySource) {
    const completedAt = entry.where.completedAt as { gte?: Date; lte?: Date } | undefined;
    assert.equal(completedAt?.gte?.toISOString(), "2026-08-27T00:00:00.000Z", entry.source);
    assert.equal(completedAt?.lte?.toISOString(), now.toISOString(), entry.source);
    assert.equal("createdAt" in entry.where, false, entry.source);
  }
  const providerWhere = whereBySource.find((entry) => entry.source === "provider")?.where;
  assert.equal(providerWhere?.billingMode, "platform");
  assert.equal(providerWhere?.payerKind, "platformCaller");
});

test("admin overview keeps backup permission failures distinct from restricted access", async () => {
  const now = new Date("2026-09-03T00:00:00.000Z");
  const db = {
    $queryRaw: async () => [],
    appUser: {
      findUnique: async () => ({ id: actorId, role: "admin" as const, disabledAt: null, accountAccessVersion: 1 }),
      count: async () => 1,
    },
    membershipSubscription: { count: async () => 0 },
    aiProviderConnection: { count: async () => 0 },
    platformTokenGrant: { aggregate: async (input: { where?: unknown }) => ({ _sum: input.where ? { remainingTokens: 0 } : { amount: 0 } }) },
    platformTokenReservation: { aggregate: async (input: { where?: unknown }) => ({ _sum: input.where && JSON.stringify(input.where).includes("settled") ? { settledTokens: 0 } : { reservedTokens: 0 } }) },
    workerRuntime: { findUnique: async () => null },
    project: { count: async () => 0 },
    workspace: { findUnique: async () => { throw new Error("permission lookup unavailable"); } },
  } as unknown as PrismaClient;

  const overview = await getSystemOverview(currentAdminActor, db, now);
  assert.equal(overview.backup.access, "not_obtained");
  assert.equal(overview.backup.snapshotRead, "not_obtained");
  assert.equal(overview.backup.latestValidRecord.status, "not_obtained");
  assert.equal(overview.backup.freshness.status, "not_obtained");
  assert.equal(overview.backup.recoveryDrill.status, "not_obtained");
  assert.equal(overview.setupChecklist.find((item) => item.key === "backup-source")?.status, "unknown");
});

test("admin backup projection preserves an invalid source status instead of presenting an empty ready source", async () => {
  const previousRoot = process.env.AI_PROJECT_OS_OPERATIONS_STATUS_ROOT;
  process.env.AI_PROJECT_OS_OPERATIONS_STATUS_ROOT = "/";
  try {
    const now = new Date("2026-09-03T00:00:00.000Z");
    const db = {
      $queryRaw: async () => [],
      appUser: {
        findUnique: async () => ({ id: actorId, role: "admin" as const, disabledAt: null, accountAccessVersion: 1 }),
        count: async () => 1,
      },
      membershipSubscription: { count: async () => 0 },
      aiProviderConnection: { count: async () => 0 },
      platformTokenGrant: { aggregate: async (input: { where?: unknown }) => ({ _sum: input.where ? { remainingTokens: 0 } : { amount: 0 } }) },
      platformTokenReservation: { aggregate: async (input: { where?: unknown }) => ({ _sum: input.where && JSON.stringify(input.where).includes("settled") ? { settledTokens: 0 } : { reservedTokens: 0 } }) },
      workerRuntime: { findUnique: async () => null },
      project: { count: async () => 0 },
      workspace: { findUnique: async () => ({ createdById: actorId }) },
    } as unknown as PrismaClient;

    const overview = await getSystemOverview(currentAdminActor, db, now);
    assert.equal(overview.backup.access, "full");
    assert.equal(overview.backup.snapshotRead, "read");
    assert.equal(overview.backup.sourceStatus, "invalid");
    assert.equal(overview.backup.latestValidRecord.status, "none");
    assert.equal(overview.backup.freshness.status, "unknown");
    assert.equal(overview.setupChecklist.find((item) => item.key === "backup-source")?.status, "unknown");
  } finally {
    if (previousRoot === undefined) delete process.env.AI_PROJECT_OS_OPERATIONS_STATUS_ROOT;
    else process.env.AI_PROJECT_OS_OPERATIONS_STATUS_ROOT = previousRoot;
  }
});

test("admin overview rejects an unverified actor before reading operational aggregates", async () => {
  let operationalRead = false;
  const db = {
    appUser: {
      findUnique: async () => ({ id: actorId, role: "member" as const, disabledAt: null }),
      count: async () => { operationalRead = true; return 1; },
    },
    $queryRaw: async () => { operationalRead = true; throw new Error("database health must not be read"); },
  } as unknown as PrismaClient;

  await assert.rejects(
    () => getSystemOverview({ id: actorId, role: "member" }, db, new Date("2026-09-03T00:00:00.000Z")),
    (error: unknown) => error instanceof Error && error.name === "AuthError" && (error as { code?: unknown }).code === "AUTH_FORBIDDEN",
  );
  assert.equal(operationalRead, false);
});

test("admin navigation source implements a persistent desktop rail and focus-contained mobile drawer", async () => {
  const shell = await readFile("src/components/admin-shell.tsx", "utf8");
  assert.match(shell, /^"use client";/u);
  // AppHeader owns the sticky top layer; the admin sub-navigation remains in
  // normal flow so it cannot cover the header at any viewport width.
  assert.doesNotMatch(shell, /sticky top-2 z-40/u);
  assert.match(shell, /rounded-3xl border border-indigo-100/u);
  assert.match(shell, /lg:flex/u);
  assert.match(shell, /aria-expanded=\{drawerOpen\}/u);
  assert.match(shell, /role="dialog"/u);
  assert.match(shell, /aria-modal="true"/u);
  assert.match(shell, /event\.key === "Escape"/u);
  assert.match(shell, /querySelectorAll<HTMLElement>\(focusableSelector\)/u);
  assert.match(shell, /previousFocus\?\.focus\(\)/u);
  assert.match(shell, /tabIndex=\{-1\}/u);
  assert.match(shell, /originalBodyOverflow/u);
  assert.match(shell, /addEventListener\("focusin"/u);
  assert.match(shell, /drawerRef\.current\?\.contains/u);
  assert.match(shell, /focus-visible:outline-2/u);
  assert.match(shell, /用户私有连接边界/u);
});

test("user guide and project surfaces keep admin controls out of the ordinary flow", async () => {
  const [guide, adminGuide, userDocs, adminDocs, manual, readme, repositories, repositoriesPage, tools, projects, materials, jobDetail] = await Promise.all([
    readFile("src/app/guide/page.tsx", "utf8"),
    readFile("src/app/admin/guide/page.tsx", "utf8"),
    readFile("docs/user-operation-guide.md", "utf8"),
    readFile("docs/admin-operation-guide.md", "utf8"),
    readFile("docs/operation-manual.md", "utf8"),
    readFile("README.md", "utf8"),
    readFile("src/app/projects/[projectId]/repositories/project-repositories-client.tsx", "utf8"),
    readFile("src/app/projects/[projectId]/repositories/page.tsx", "utf8"),
    readFile("src/app/projects/[projectId]/tools/project-tools-client.tsx", "utf8"),
    readFile("src/app/projects/projects-client.tsx", "utf8"),
    readFile("src/app/projects/[projectId]/project-client.tsx", "utf8"),
    readFile("src/app/projects/[projectId]/jobs/[jobId]/project-job-detail-client.tsx", "utf8"),
  ]);

  assert.match(guide, /普通用户操作指南/u);
  assert.match(guide, /个人 Git 与 MCP 连接可以在个人中心配置/u);
  assert.match(userDocs, /项目概览/u);
  assert.match(userDocs, /项目六个一级入口/u);
  assert.match(userDocs, /只有当前工作区 Owner\/Admin 可以创建项目/u);
  assert.match(userDocs, /个人 Git 与 MCP 连接都由当前用户在个人中心管理/u);
  assert.match(userDocs, /项目页支持 Git 连接所有者与项目 Owner 双确认后的一次性手动只读读取/u);
  assert.match(userDocs, /一次性手动读取只读取双确认委托中明确的分支、目录和文本文件/u);
  assert.doesNotMatch(userDocs, /迁移期间不启动新的外部仓库访问|个人连接开放后/u);
  assert.match(adminDocs, /管理工作台/u);
  assert.match(adminDocs, /管理员配置并验证平台托管模型，并为视觉、抽取、向量和生成能力维护默认路由/u);
  assert.match(adminDocs, /普通用户不能配置个人模型，只能消费平台赠送额度；只有有效会员可以维护个人模型连接/u);
  assert.match(adminDocs, /`\/system\/memberships`[^。]*兼容跳转 `\/admin\/users\/memberships`/u);
  assert.match(adminDocs, /`\/system\/operations` 仅 initial super admin 可用[^。]*兼容跳转 `\/admin\/operations\/backups`/u);
  assert.match(adminDocs, /其他 system admin 按现有安全行为返回不可见页面/u);
  assert.doesNotMatch(adminDocs, /`\/system\/\*`[^。]*把系统管理员导向上述页面/u);
  assert.match(adminDocs, /legacy 项目仓库新增接口(?:均)?已冻结/u);
  assert.match(adminDocs, /个人 Git 连接和项目页的一次性手动只读委托由用户和项目 Owner 管理/u);
  assert.match(adminDocs, /管理员不代替用户持有或配置凭据/u);
  assert.match(readme, /旧版项目 Git 连接、首次关联和同步入口已冻结/u);
  assert.match(readme, /进入项目仓库页查看已有安全摘要/u);
  assert.match(adminGuide, /管理员配置并验证平台托管模型，并为各项能力设置默认路由/u);
  assert.match(adminGuide, /普通用户只能消费平台赠送额度，不能配置个人模型；有效会员才可维护自己的模型连接/u);
  assert.match(readme, /\/admin\/models/u);
  assert.match(readme, /\/admin\/connectors\/git/u);
  assert.match(readme, /\/admin\/connectors\/mcp/u);
  assert.match(readme, /\/admin\/users\/memberships/u);
  assert.match(readme, /\/admin\/operations\/backups/u);
  assert.match(manual, /user-operation-guide\.md/u);
  assert.match(manual, /admin-operation-guide\.md/u);
  assert.doesNotMatch(repositories, /api\/projects\/\$\{projectId\}\/git-connections/u);
  assert.doesNotMatch(repositories, /api\/settings\/git-connections|api\/me\/git-connections|isSystemAdmin|RepositoryForm/u);
  assert.match(repositories, /api\/projects\/\$\{projectId\}\/git-repository-delegations/u);
  assert.match(repositories, /manual-sync/u);
  assert.match(repositories, /manual-runs/u);
  assert.match(repositories, /gitConnectionId:/u);
  assert.match(repositories, /manualSyncAllowed:\s*true/u);
  assert.match(repositories, /automationAllowed:\s*false/u);
  assert.match(repositories, /owner-confirmation/u);
  assert.match(repositories, /project-confirmation/u);
  assert.match(repositories, /不会写入、提交或创建 Pull Request/u);
  assert.match(repositories, /自动化、写入\/提交和旧 PAT 路径保持关闭；目标 Git 服务是否可用，以连接测试和单次读取结果为准/u);
  assert.match(guide, /个人 Git 与 MCP 连接可以在个人中心配置/u);
  assert.match(repositories, /href="\/profile\/connections\/git"/u);
  assert.match(repositories, /资料已发布到项目/u);
  assert.doesNotMatch(guide, /新增模型、Git 或 MCP 连接/u);
  assert.match(tools, /项目级 MCP 授权与动作调用当前未开放/u);
  assert.match(tools, /href="\/profile\/connections\/mcp"/u);
  assert.doesNotMatch(tools, /MCP 连接由管理员维护|fetch\(|method:\s*"(?:POST|PATCH|DELETE)"|授权给项目|创建并请求审批/u);
  assert.doesNotMatch(repositoriesPage, /user\.role === "admin"/u);
  assert.doesNotMatch(repositoriesPage, /isSystemAdmin/u);
  assert.doesNotMatch(tools, /href="\/connections\/mcp"/u);
  assert.match(projects, /payload\.pagination\.totalPages > 1 \?/u);
  assert.match(materials, /items-stretch/u);
  assert.doesNotMatch(materials, /self-start lg:h-fit/u);
  assert.match(jobDetail, /autoExtractResult/u);
  assert.match(jobDetail, /auto-extract-review/u);
});

test("split operation guides keep their local Markdown links resolvable", async () => {
  const documents = ["docs/operation-manual.md", "docs/user-operation-guide.md", "docs/admin-operation-guide.md"];
  for (const document of documents) {
    const content = await readFile(document, "utf8");
    for (const match of content.matchAll(/\]\((\.\/[^)]+\.md)\)/gu)) {
      await stat(join(process.cwd(), "docs", match[1]!.slice(2)));
    }
  }
});
