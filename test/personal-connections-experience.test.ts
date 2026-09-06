import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("personal connection pages are server-authenticated and expose the personal entry points", async () => {
  const [gitPage, mcpPage, profile, legacyGit, legacyMcp] = await Promise.all([
    readFile("src/app/profile/connections/git/page.tsx", "utf8"),
    readFile("src/app/profile/connections/mcp/page.tsx", "utf8"),
    readFile("src/app/profile/profile-client.tsx", "utf8"),
    readFile("src/app/connections/page.tsx", "utf8"),
    readFile("src/app/connections/mcp/page.tsx", "utf8"),
  ]);

  for (const page of [gitPage, mcpPage]) {
    assert.match(page, /requirePageSession\(\)/u);
    assert.match(page, /active="profile"/u);
    assert.match(page, /isSystemAdmin/iu);
  }
  assert.match(profile, /href="\/profile\/connections\/git"/u);
  assert.match(profile, /href="\/profile\/connections\/mcp"/u);
  assert.match(profile, /Git 完成连接所有者与项目 Owner 双确认后，可发起一次性手动只读读取/u);
  assert.match(profile, /MCP 的项目授权和自动化仍保持关闭/u);
  assert.match(legacyGit, /\/profile\/connections\/git/u);
  assert.match(legacyMcp, /\/profile\/connections\/mcp/u);
});

test("personal Git and MCP clients use only owner APIs and preserve lifecycle safety", async () => {
  const [git, mcp] = await Promise.all([
    readFile("src/app/profile/connections/git/git-connections-client.tsx", "utf8"),
    readFile("src/app/profile/connections/mcp/mcp-connections-client.tsx", "utf8"),
  ]);

  assert.match(git, /api\/me\/git-connections/u);
  assert.match(git, /expectedUpdatedAt/u);
  assert.match(git, /repositoryPath/u);
  assert.match(git, /trackedRef/u);
  assert.match(git, /readConnectionError/u);
  assert.match(git, /isConnectionConflict/u);
  assert.match(git, /setDraft\(\(current\) => \(\{ \.\.\.current, secret: "" \}\)\)/u);
  assert.match(git, /api\/me\/git-delegations/u);
  assert.match(git, /项目委托安全管理/u);
  assert.doesNotMatch(git, /api\/settings\/git-connections|admin\/connectors|attestation|projectMcpToolGrant/u);
  assert.doesNotMatch(git, /definitionFingerprint|networkFingerprint|credentialFingerprint/u);
  assert.match(git, /项目页已支持一次性手动只读委托/u);
  assert.match(git, /自动化、写入\/提交和旧 PAT 路径保持关闭；目标 Git 服务是否可用，以连接测试和单次读取结果为准/u);
  assert.match(git, /后续项目手动读取将停止，自动化仍保持关闭/u);
  assert.match(git, /manualSyncAllowed/u);
  assert.match(git, /canReject|canRevoke/u);
  assert.match(git, /rejection|revocation/u);

  assert.match(mcp, /api\/me\/mcp-connections/u);
  assert.match(mcp, /expectedUpdatedAt/u);
  assert.match(mcp, /discover/u);
  assert.match(mcp, /trustCurrentNetwork/u);
  assert.match(mcp, /isConnectionConflict/u);
  assert.match(mcp, /setDraft\(\(current\) => \(\{ \.\.\.current, bearerToken: "" \}\)\)/u);
  assert.doesNotMatch(mcp, /api\/settings\/mcp-connections|admin\/connectors|method: "POST"[\s\S]*attestation|grantProjectMcpTool/u);
  assert.doesNotMatch(mcp, /definitionFingerprint|networkFingerprint|credentialFingerprint/u);
  assert.match(mcp, /管理员审核与项目授权不在个人页面操作/u);
});

test("personal connection forms keep project automation boundary visible", async () => {
  const [git, mcp, guide] = await Promise.all([
    readFile("src/app/profile/connections/git/git-connections-client.tsx", "utf8"),
    readFile("src/app/profile/connections/mcp/mcp-connections-client.tsx", "utf8"),
    readFile("src/app/guide/page.tsx", "utf8"),
  ]);
  assert.match(git, /项目页已支持一次性手动只读委托/u);
  assert.match(git, /自动化、写入\/提交和旧 PAT 路径保持关闭；目标 Git 服务是否可用，以连接测试和单次读取结果为准/u);
  assert.match(mcp, /项目委托入口尚未开放/u);
  assert.match(mcp, /当前连接不能用于项目或自动化/u);
  assert.match(guide, /个人 Git 与 MCP 连接可以在个人中心配置/u);
  assert.doesNotMatch(guide, /普通用户不需要也不能配置平台凭据/u);
});
