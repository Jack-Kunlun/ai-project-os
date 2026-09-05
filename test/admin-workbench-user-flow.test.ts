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
  assert.doesNotMatch(client, /api\/settings\/git-connections|isSystemAdmin|RepositoryForm|gitConnectionId/u);
  assert.match(client, /项目 Git 委托与仓库同步当前未开放/u);
  assert.match(client, /href="\/profile\/connections\/git"/u);
  assert.match(client, /已导入资料仍可查看/u);
  assert.doesNotMatch(client, /fetch\(|method:\s*"(?:POST|PATCH|DELETE)"|async function (?:sync|disable)\(\)/u);
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
    appUser: { count: async () => { calls.push("users"); return 7; } },
    membershipSubscription: { count: async () => { calls.push("memberships"); return 3; } },
    aiProviderConnection: { count: async () => { calls.push("providers"); return 2; } },
    platformTokenGrant: { aggregate: async (input: { where?: unknown }) => { calls.push(input.where ? "available" : "issued"); return { _sum: input.where ? { remainingTokens: 420 } : { amount: 500_000 } }; } },
    platformTokenReservation: { aggregate: async (input: { where?: unknown }) => { calls.push("reservations"); return JSON.stringify(input.where).includes("settled") ? { _sum: { settledTokens: 35 } } : { _sum: { reservedTokens: 80 } }; } },
    workerRuntime: { findUnique: async () => { calls.push("worker"); return { status: "running", heartbeatAt: new Date(now.getTime() - 1_000), consecutiveFailures: 0 }; } },
  } as unknown as PrismaClient;

  const overview = await getSystemOverview(db, now);
  assert.deepEqual(overview.counts, { users: 7, activeMemberships: 3, verifiedPlatformModels: 2 });
  assert.deepEqual(overview.tokens, { issuedTokens: 500_000, availableTokens: 420, reservedTokens: 80, consumedTokens: 35 });
  assert.equal(overview.service.database, "up");
  assert.equal(overview.service.worker.status, "up");
  assert.deepEqual(calls.sort(), ["available", "health", "issued", "memberships", "providers", "reservations", "reservations", "users", "worker"].sort());
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
  assert.match(userDocs, /个人 Git 连接与项目委托正在改造/u);
  assert.match(adminDocs, /管理工作台/u);
  assert.match(adminDocs, /管理员配置并验证后，可作为平台默认路由建议\/供项目选择/u);
  assert.match(adminDocs, /planned.*后续能力/u);
  assert.match(adminDocs, /`\/system\/memberships`[^。]*兼容跳转 `\/admin\/users\/memberships`/u);
  assert.match(adminDocs, /`\/system\/operations` 仅 initial super admin 可用[^。]*兼容跳转 `\/admin\/operations\/backups`/u);
  assert.match(adminDocs, /其他 system admin 按现有安全行为返回不可见页面/u);
  assert.doesNotMatch(adminDocs, /`\/system\/\*`[^。]*把系统管理员导向上述页面/u);
  assert.match(adminDocs, /legacy 项目仓库新增接口(?:均)?已冻结/u);
  assert.match(adminDocs, /个人 Git 连接与项目委托是 planned 后续能力/u);
  assert.match(readme, /旧版项目 Git 连接、首次关联和同步入口已冻结/u);
  assert.match(readme, /进入项目仓库页查看已有安全摘要/u);
  assert.match(adminGuide, /管理员配置并验证后，可作为平台默认路由建议\/供项目选择/u);
  assert.match(adminGuide, /planned.*后续能力/u);
  assert.match(readme, /\/admin\/models/u);
  assert.match(readme, /\/admin\/connectors\/git/u);
  assert.match(readme, /\/admin\/connectors\/mcp/u);
  assert.match(readme, /\/admin\/users\/memberships/u);
  assert.match(readme, /\/admin\/operations\/backups/u);
  assert.match(manual, /user-operation-guide\.md/u);
  assert.match(manual, /admin-operation-guide\.md/u);
  assert.doesNotMatch(repositories, /api\/projects\/\$\{projectId\}\/git-connections/u);
  assert.doesNotMatch(repositories, /api\/settings\/git-connections|isSystemAdmin|RepositoryForm|gitConnectionId/u);
  assert.match(repositories, /项目 Git 委托与仓库同步当前未开放/u);
  assert.match(guide, /个人 Git 与 MCP 连接可以在个人中心配置/u);
  assert.match(repositories, /href="\/profile\/connections\/git"/u);
  assert.match(repositories, /历史已导入的项目资料仍可在项目资料中查看/u);
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
