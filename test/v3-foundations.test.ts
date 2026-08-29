import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { memoryTextSimilarity, normalizeMemoryText } from "../src/lib/memory-quality";
import { canonicalIssuerUrl, OidcError } from "../src/lib/oidc";
import { canonicalWebSourceUrl, extractWebDocument, WebSourceError } from "../src/lib/web-sources";

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
