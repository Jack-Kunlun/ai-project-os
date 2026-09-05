import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import { mapApiError } from "../src/lib/api-errors";
import { AccessControlError, accessibleProjectWhere, assertProjectAccess, authorizeApiRequest, getProjectPermission, resolveProjectCreationWorkspace } from "../src/lib/access-control";
import { memoryTextSimilarity, normalizeMemoryText } from "../src/lib/memory-quality";
import { canonicalIssuerUrl, OidcError } from "../src/lib/oidc";
import { canonicalWebSourceUrl, extractWebDocument, WebSourceError } from "../src/lib/web-sources";
import { getWorkspaceOverview, resolveUserWorkspace, WorkspaceError } from "../src/lib/workspaces";

function errorCode(operation: () => unknown): string | null {
  try { operation(); return null; }
  catch (error) {
    if (error instanceof WebSourceError || error instanceof OidcError) return error.code;
    return "unexpected";
  }
}

test("记忆质量规则对中英文标点归一化并区分相似与冲突内容", () => {
  assert.equal(normalizeMemoryText("  API，已经上线！ "), "api已经上线");
  assert.ok(memoryTextSimilarity("决定采用 PostgreSQL 作为主数据库", "决定：采用 PostgreSQL 作为主数据库。") > 0.9);
  assert.ok(memoryTextSimilarity("已经启用自动同步", "明确禁止自动同步") < 0.65);
});

test("网页与 OIDC 地址默认要求公网 HTTPS，内网 HTTP 需要明确授权", () => {
  assert.equal(canonicalWebSourceUrl("https://docs.example.com/guide#part", false), "https://docs.example.com/guide");
  assert.equal(errorCode(() => canonicalWebSourceUrl("http://docs.example.com/guide", false)), "WEB_SOURCE_INVALID_INPUT");
  assert.equal(canonicalWebSourceUrl("http://127.0.0.1:9000/guide", true), "http://127.0.0.1:9000/guide");
  assert.equal(canonicalIssuerUrl("https://login.example.com/tenant/", false), "https://login.example.com/tenant");
  assert.equal(errorCode(() => canonicalIssuerUrl("http://login.example.com", false)), "OIDC_INVALID_INPUT");
});

test("网页提取会移除可执行内容并保留标题、来源与正文", () => {
  const result = extractWebDocument(Buffer.from("<html><head><title>项目 文档</title><style>secret{}</style></head><body><h1>使用方法</h1><script>alert(1)</script><p>先配置连接。</p></body></html>"), "text/html; charset=utf-8", "https://docs.example.com/guide");
  assert.equal(result.title, "项目 文档");
  assert.match(result.text, /来源：https:\/\/docs\.example\.com\/guide/u);
  assert.match(result.text, /先配置连接/u);
  assert.doesNotMatch(result.text, /alert|secret/u);
});

test("V3 迁移包含默认工作区回填、服务端角色和 OIDC 安全状态", async () => {
  const migration = await readFile(join(process.cwd(), "prisma/migrations/20260829210000_add_workspaces_rbac_oidc/migration.sql"), "utf8");
  const sourceDedupeMigration = await readFile(join(process.cwd(), "prisma/migrations/20260829212000_scope_manual_source_deduplication/migration.sql"), "utf8");
  const oidcPinningMigration = await readFile(join(process.cwd(), "prisma/migrations/20260829213000_add_oidc_endpoint_pinning/migration.sql"), "utf8");
  const oidcDefaultMigration = await readFile(join(process.cwd(), "prisma/migrations/20260829214000_align_oidc_discovery_defaults/migration.sql"), "utf8");
  assert.match(migration, /UPDATE "Project" SET "workspaceId"/u);
  assert.match(migration, /WorkspaceMembership_workspaceId_userId_key/u);
  assert.match(migration, /ProjectMembership_projectId_userId_key/u);
  assert.match(migration, /OidcLoginAttempt_stateHash_key/u);
  assert.match(migration, /OidcProvider_default_role_check/u);
  assert.match(migration, /AppUser_password_pair_check/u);
  assert.match(sourceDedupeMigration, /"kind" = 'manual'/u);
  assert.match(sourceDedupeMigration, /"kind" <> 'manual'/u);
  assert.match(oidcPinningMigration, /tokenAddressFingerprint/u);
  assert.match(oidcPinningMigration, /jwksAddressFingerprint/u);
  assert.match(oidcPinningMigration, /OidcProvider_endpoint_fingerprints_check/u);
  assert.match(oidcDefaultMigration, /DEFAULT 'client_secret_basic'/u);
});

test("服务端权限入口覆盖所有项目 API 与全局连接设置", async () => {
  const access = await readFile(join(process.cwd(), "src/lib/access-control.ts"), "utf8");
  const auth = await readFile(join(process.cwd(), "src/lib/auth.ts"), "utf8");
  const projectLayout = await readFile(join(process.cwd(), "src/app/projects/[projectId]/layout.tsx"), "utf8");
  const syncPage = await readFile(join(process.cwd(), "src/app/projects/[projectId]/github-syncs/[syncRunId]/page.tsx"), "utf8");
  assert.match(access, /PROJECT_PATH_PATTERN/u);
  assert.match(access, /path\.startsWith\("\/api\/settings\/"\)/u);
  assert.match(access, /assertProjectAccess/u);
  assert.match(auth, /authorizeApiRequest\(user, request, db\)/u);
  assert.match(projectLayout, /assertProjectAccess\(user, parsed\.data, "view"\)/u);
  assert.match(syncPage, /assertProjectAccess\(user, projectId, "view"\)/u);
});

test("项目 API 授权对 UUID 大小写、编码路径和新版 UUID 使用同一 RBAC 记录", async () => {
  const projectId = "11111111-1111-4111-8111-111111111111";
  const projectIdV7 = "0198f1a0-7b2c-7def-8abc-1234567890ab";
  const seen: string[] = [];
  let role: "viewer" | "editor" = "viewer";
  const db = {
    project: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        seen.push(where.id);
        return { workspace: { memberships: [] }, memberships: [{ role }] };
      },
      count: async () => 1,
    },
    projectMembership: {
      findMany: async () => [{ role, accessState: "confirmed" }],
    },
    workspaceMembership: {
      findMany: async () => [],
    },
  } as unknown as PrismaClient;
  const member = { id: "22222222-2222-4222-8222-222222222222", role: "member" as const };

  await assert.rejects(
    () => authorizeApiRequest(member, new Request(`http://localhost/api/projects/${projectId}/items`, { method: "POST" }), db),
    (error: unknown) => error instanceof AccessControlError && error.code === "ACCESS_FORBIDDEN",
  );
  await assert.rejects(
    () => authorizeApiRequest(member, new Request(`http://localhost/api/projects/${projectId.toUpperCase()}/items`, { method: "POST" }), db),
    (error: unknown) => error instanceof AccessControlError && error.code === "ACCESS_FORBIDDEN",
  );
  await assert.rejects(
    () => authorizeApiRequest(member, new Request(`http://localhost/api/%70rojects/${projectId.replaceAll("1", "%31")}/items`, { method: "POST" }), db),
    (error: unknown) => error instanceof AccessControlError && error.code === "ACCESS_FORBIDDEN",
  );
  await assert.rejects(
    () => authorizeApiRequest(member, new Request(`http://localhost/api/projects/${projectIdV7}/items`, { method: "POST" }), db),
    (error: unknown) => error instanceof AccessControlError && error.code === "ACCESS_FORBIDDEN",
  );
  assert.deepEqual(seen, [projectId, projectId, projectId, projectIdV7]);

  role = "editor";
  await authorizeApiRequest(member, new Request(`http://localhost/api/projects/${projectId}/items`, { method: "POST" }), db);
  await authorizeApiRequest(member, new Request(`http://localhost/api/projects/${projectId.toUpperCase()}/items`, { method: "POST" }), db);
  assert.deepEqual(seen, [projectId, projectId, projectId, projectIdV7, projectId, projectId]);
});

test("个人 Git 终止旁路只匹配原始精确 POST 路径", async () => {
  const projectId = "12121212-1212-4121-8121-121212121212";
  const delegationId = "14141414-1414-4141-8141-141414141414";
  const projectIdV7 = "0198f1a0-7b2c-7def-8abc-1234567890ab";
  const delegationIdV8 = "14141414-1414-8141-8141-141414141414";
  const nilProjectId = "00000000-0000-0000-0000-000000000000";
  const nilDelegationId = "00000000-0000-0000-0000-000000000000";
  const invalidDelegationId = "not-a-uuid";
  const zodRejectedDelegationId = "14141414-1414-0141-0141-141414141414";
  const actor = { id: "15151515-1515-4151-8151-151515151515", role: "member" as const };
  const denyDb = {
    project: {
      findUnique: async () => ({ workspace: { memberships: [] }, memberships: [] }),
      count: async () => 1,
    },
    projectMembership: { findMany: async () => [] },
    workspaceMembership: { findMany: async () => [] },
  } as unknown as PrismaClient;
  const exact = `http://localhost/api/projects/${projectId}/git-repository-delegations/${delegationId}/rejection`;
  const exactRevocation = `http://localhost/api/projects/${projectId}/git-repository-delegations/${delegationId}/revocation`;

  await assert.doesNotReject(() => authorizeApiRequest(actor, new Request(exact, { method: "POST" }), {} as PrismaClient));
  await assert.doesNotReject(() => authorizeApiRequest(actor, new Request(`${exact}/`, { method: "POST" }), {} as PrismaClient));
  await assert.doesNotReject(() => authorizeApiRequest(actor, new Request(exactRevocation, { method: "POST" }), {} as PrismaClient));
  await assert.doesNotReject(() => authorizeApiRequest(actor, new Request(`${exactRevocation}/`, { method: "POST" }), {} as PrismaClient));
  await assert.doesNotReject(() => authorizeApiRequest(actor, new Request(`http://localhost/api/projects/${projectIdV7}/git-repository-delegations/${delegationIdV8}/rejection`, { method: "POST" }), {} as PrismaClient));
  await assert.doesNotReject(() => authorizeApiRequest(actor, new Request(`http://localhost/api/projects/${projectId.toUpperCase()}/git-repository-delegations/${delegationId.toUpperCase()}/revocation`, { method: "POST" }), {} as PrismaClient));
  await assert.rejects(
    () => authorizeApiRequest(actor, new Request(exact, { method: "GET" }), denyDb),
    (error: unknown) => error instanceof AccessControlError && error.code === "ACCESS_FORBIDDEN",
  );
  await assert.rejects(
    () => authorizeApiRequest(actor, new Request(`${exact}/extra`, { method: "POST" }), denyDb),
    (error: unknown) => error instanceof AccessControlError && error.code === "ACCESS_FORBIDDEN",
  );
  await assert.rejects(
    () => authorizeApiRequest(actor, new Request(`http://localhost/api/projects/${projectId}/git-repository-delegations-legacy/${delegationId}/rejection`, { method: "POST" }), denyDb),
    (error: unknown) => error instanceof AccessControlError && error.code === "ACCESS_FORBIDDEN",
  );
  await assert.rejects(
    () => authorizeApiRequest(actor, new Request(`http://localhost/api/%70rojects/${projectId}/git-repository-delegations/${delegationId}/rejection`, { method: "POST" }), denyDb),
    (error: unknown) => error instanceof AccessControlError && error.code === "ACCESS_FORBIDDEN",
  );
  await assert.rejects(
    () => authorizeApiRequest(actor, new Request(`http://localhost/api/projects/${projectId}/git-repository-delegations/${invalidDelegationId}/rejection`, { method: "POST" }), denyDb),
    (error: unknown) => error instanceof AccessControlError && error.code === "ACCESS_FORBIDDEN",
  );
  await assert.rejects(
    () => authorizeApiRequest(actor, new Request(`http://localhost/api/projects/${projectId}/git-repository-delegations/${zodRejectedDelegationId}/revocation`, { method: "POST" }), denyDb),
    (error: unknown) => error instanceof AccessControlError && error.code === "ACCESS_FORBIDDEN",
  );
  await assert.rejects(
    () => authorizeApiRequest(actor, new Request(`http://localhost/api/projects/${nilProjectId}/git-repository-delegations/${delegationId}/rejection`, { method: "POST" }), denyDb),
    (error: unknown) => error instanceof AccessControlError && error.code === "ACCESS_FORBIDDEN",
  );
  await assert.rejects(
    () => authorizeApiRequest(actor, new Request(`http://localhost/api/projects/${projectId}/git-repository-delegations/${nilDelegationId}/revocation`, { method: "POST" }), denyDb),
    (error: unknown) => error instanceof AccessControlError && error.code === "ACCESS_FORBIDDEN",
  );
});

test("项目 API 预授权隐藏非成员项目是否存在，但直接权限校验保留 not found 语义", async () => {
  const existingProjectId = "33333333-3333-4333-8333-333333333333";
  const missingProjectId = "44444444-4444-4444-8444-444444444444";
  const nonMember = { id: "55555555-5555-4555-8555-555555555555", role: "member" as const };
  const authorized = { id: "66666666-6666-4666-8666-666666666666", role: "member" as const };
  type ProjectLookupArgs = {
    where: { id: string };
    select?: { memberships?: { where?: { userId?: string } } };
  };
  const db = {
    project: {
      findUnique: async ({ where, select }: ProjectLookupArgs) => {
        if (where.id !== existingProjectId) return null;
        const requestedUserId = select?.memberships?.where?.userId;
        return {
          workspace: { memberships: [] },
          memberships: requestedUserId === authorized.id ? [{ role: "viewer" }] : [],
        };
      },
      count: async ({ where }: { where: { id: string } }) => (where.id === existingProjectId ? 1 : 0),
    },
    projectMembership: {
      findMany: async ({ where }: { where: { projectId: string; userId: string } }) =>
        where.projectId === existingProjectId && where.userId === authorized.id
          ? [{ role: "viewer", accessState: "confirmed" }]
          : [],
    },
    workspaceMembership: {
      findMany: async () => [],
    },
  } as unknown as PrismaClient;
  const captureAccessError = async (action: () => Promise<void>): Promise<AccessControlError> => {
    try {
      await action();
    } catch (error) {
      if (error instanceof AccessControlError) return error;
      throw error;
    }
    throw new Error("ACCESS_CONTROL_EXPECTED_ERROR");
  };

  const existingError = await captureAccessError(() =>
    authorizeApiRequest(
      nonMember,
      new Request(`http://localhost/api/projects/${existingProjectId}/items`, { method: "GET" }),
      db,
    ),
  );
  const missingError = await captureAccessError(() =>
    authorizeApiRequest(
      nonMember,
      new Request(`http://localhost/api/projects/${missingProjectId}/items`, { method: "GET" }),
      db,
    ),
  );
  assert.equal(existingError.code, "ACCESS_FORBIDDEN");
  assert.equal(missingError.code, "ACCESS_FORBIDDEN");
  assert.equal(mapApiError(existingError).status, 403);
  assert.equal(mapApiError(missingError).status, 403);

  await authorizeApiRequest(
    authorized,
    new Request(`http://localhost/api/projects/${existingProjectId}/items`, { method: "GET" }),
    db,
  );
  await assert.rejects(
    () => assertProjectAccess(nonMember, missingProjectId, "view", db),
    (error: unknown) => error instanceof AccessControlError && error.code === "ACCESS_PROJECT_NOT_FOUND",
  );
});

test("系统管理员的租户项目权限必须来自真实 workspace/project membership", async () => {
  const projectId = "77777777-7777-4777-8777-777777777777";
  const missingProjectId = "88888888-8888-4888-8888-888888888888";
  const admin = { id: "99999999-9999-4999-8999-999999999999", role: "admin" as const };
  let workspaceRole: "owner" | "admin" | "member" | null = null;
  let projectRole: "owner" | "editor" | "viewer" | null = null;
  let inheritanceMode: "workspaceInherited" | "projectOnly" = "workspaceInherited";
  const db = {
    project: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        if (where.id !== projectId) return null;
        return {
          membershipInheritanceMode: inheritanceMode,
          workspace: { memberships: workspaceRole === null ? [] : [{ role: workspaceRole, accessState: "confirmed" }] },
          memberships: projectRole === null ? [] : [{ role: projectRole, accessState: "confirmed" }],
        };
      },
      count: async ({ where }: { where: { id: string } }) => (where.id === projectId ? 1 : 0),
    },
    projectMembership: {
      findMany: async () => projectRole === null ? [] : [{ role: projectRole, accessState: "confirmed" }],
    },
    workspaceMembership: {
      findMany: async () => workspaceRole === null ? [] : [{ role: workspaceRole, accessState: "confirmed" }],
    },
  } as unknown as PrismaClient;

  assert.deepEqual(accessibleProjectWhere(admin), {
    OR: [
      {
        membershipInheritanceMode: "workspaceInherited",
        workspace: { memberships: { some: { userId: admin.id, accessState: "confirmed", role: { in: ["owner", "admin"] } } } },
      },
      { memberships: { some: { userId: admin.id, accessState: "confirmed" } } },
    ],
  });
  assert.equal(await getProjectPermission(admin, projectId, db), null);
  await assert.rejects(
    () => assertProjectAccess(admin, projectId, "view", db),
    (error: unknown) => error instanceof AccessControlError && error.code === "ACCESS_FORBIDDEN",
  );

  workspaceRole = "admin";
  assert.equal(await getProjectPermission(admin, projectId, db), "owner");
  await assertProjectAccess(admin, projectId, "owner", db);

  inheritanceMode = "projectOnly";
  assert.equal(await getProjectPermission(admin, projectId, db), null);
  await assert.rejects(
    () => assertProjectAccess(admin, projectId, "view", db),
    (error: unknown) => error instanceof AccessControlError && error.code === "ACCESS_FORBIDDEN",
  );

  inheritanceMode = "workspaceInherited";
  workspaceRole = null;
  projectRole = "editor";
  assert.equal(await getProjectPermission(admin, projectId, db), "edit");
  await assertProjectAccess(admin, projectId, "edit", db);
  projectRole = "viewer";
  assert.equal(await getProjectPermission(admin, projectId, db), "view");
  await assert.rejects(
    () => assertProjectAccess(admin, projectId, "edit", db),
    (error: unknown) => error instanceof AccessControlError && error.code === "ACCESS_FORBIDDEN",
  );

  await assert.rejects(
    () => assertProjectAccess(admin, missingProjectId, "view", db),
    (error: unknown) => error instanceof AccessControlError && error.code === "ACCESS_PROJECT_NOT_FOUND",
  );
});

test("系统管理员不能凭全局角色自动解析租户工作区", async () => {
  const workspaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const admin = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", role: "admin" as const };
  const workspace = { id: workspaceId, name: "租户工作区" };
  let membership: { role: "owner" | "admin"; accessState: "confirmed" } | null = null;
  const db = {
    workspaceMembership: {
      findFirst: async () => membership === null ? null : { workspaceId, workspace, role: membership.role },
      findMany: async () => membership === null ? [] : [{ workspaceId, role: membership.role, accessState: membership.accessState }],
      findUnique: async () => membership,
    },
    workspace: {
      findUniqueOrThrow: async () => ({ _count: { memberships: 1, projects: 0, oidcProviders: 0 } }),
    },
  } as unknown as PrismaClient;

  await assert.rejects(
    () => resolveProjectCreationWorkspace(admin, db),
    (error: unknown) => error instanceof AccessControlError && error.code === "ACCESS_FORBIDDEN",
  );
  await assert.rejects(
    () => resolveUserWorkspace(admin, db),
    (error: unknown) => error instanceof WorkspaceError && error.code === "WORKSPACE_NOT_FOUND",
  );

  membership = { role: "admin", accessState: "confirmed" };
  assert.equal(await resolveProjectCreationWorkspace(admin, db), workspaceId);
  assert.deepEqual(await resolveUserWorkspace(admin, db), workspace);
  const overview = await getWorkspaceOverview(admin, db);
  assert.equal(overview.role, "admin");
  assert.deepEqual(overview.counts, { memberships: 1, projects: 0, oidcProviders: 0 });
});

test("自动化 Worker 入口兼容容器内 CommonJS 转换", async () => {
  const source = await readFile("scripts/automation-worker.ts", "utf8");
  const dockerfile = await readFile("Dockerfile", "utf8");
  assert.doesNotMatch(source, /^await main\(\);$/mu);
  assert.match(source, /void main\(\)\.catch/u);
  assert.match(dockerfile, /CMD \["node", "node_modules\/tsx\/dist\/cli\.mjs", "scripts\/automation-worker\.ts"\]/u);
});

test("团队凭据表单阻止浏览器把当前登录凭据误填为 OIDC 配置", async () => {
  const source = await readFile("src/app/team/team-client.tsx", "utf8");
  assert.match(source, /name="oidc-client-id" autoComplete="off"/u);
  assert.match(source, /name="oidc-client-secret" autoComplete="new-password"/u);
  assert.match(source, /name="new-member-password" autoComplete="new-password"/u);
});
