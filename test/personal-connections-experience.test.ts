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
  assert.match(profile, /MCP 的连接委托和只读工具授权控制面已开放，远端动作、自动化和调用审批仍保持关闭/u);
  assert.match(profile, /配置 Git 服务、轮换凭据；后续变更通过安全治理预览管理，当前不会发起网络请求，外部连通性仍未验证/u);
  assert.match(profile, /管理连接委托和只读工具授权；保存时执行受限 DNS\/地址安全解析，不发起 MCP 协议请求或发送凭据，MCP 连通性仍未验证/u);
  assert.doesNotMatch(profile, /执行只读仓库测试/u);
  assert.doesNotMatch(profile, /发现远程工具并查看平台安全摘要/u);
  assert.match(legacyGit, /\/profile\/connections\/git/u);
  assert.match(legacyMcp, /\/profile\/connections\/mcp/u);
});

test("personal Git and MCP clients use only owner APIs and preserve lifecycle safety", async () => {
  const [git, mcp] = await Promise.all([
    readFile("src/app/profile/connections/git/git-connections-client.tsx", "utf8"),
    readFile("src/app/profile/connections/mcp/mcp-connections-client.tsx", "utf8"),
  ]);

  assert.match(git, /api\/me\/git-connections/u);
  assert.match(git, /repositoryPath/u);
  assert.match(git, /trackedRef/u);
  assert.match(git, /safeResponseError/u);
  assert.doesNotMatch(git, /payload\.error(?:\?\.)?message/u);
  assert.match(git, /ConnectionGovernancePanel/u);
  assert.match(git, /governance/u);
  assert.match(git, /setDraft\(\(current\) => \(\{ \.\.\.current, secret: "" \}\)\)/u);
  assert.match(git, /api\/me\/git-delegations/u);
  assert.match(git, /项目委托安全管理/u);
  assert.doesNotMatch(git, /api\/settings\/git-connections|admin\/connectors|attestation|projectMcpToolGrant/u);
  assert.doesNotMatch(git, /definitionFingerprint|networkFingerprint|credentialFingerprint/u);
  assert.match(git, /项目页已支持一次性手动只读委托/u);
  assert.match(git, /项目页已支持一次性手动只读委托；自动化、写入\/提交和旧 PAT 路径保持关闭/u);
  assert.match(git, /费用承担者为连接所有者/u);
  assert.match(git, /manualSyncAllowed/u);
  assert.match(git, /canReject|canRevoke/u);
  assert.match(git, /rejection|revocation/u);

  assert.match(mcp, /api\/me\/mcp-connections/u);
  assert.match(mcp, /safeResponseError/u);
  assert.doesNotMatch(mcp, /payload\.error(?:\?\.)?message/u);
  assert.match(mcp, /ConnectionGovernancePanel/u);
  assert.match(mcp, /governance/u);
  assert.match(mcp, /api\/me\/mcp-delegations/u);
  assert.match(mcp, /setDraft\(\(current\) => \(\{ \.\.\.current, bearerToken: "" \}\)\)/u);
  assert.doesNotMatch(mcp, /api\/settings\/mcp-connections|admin\/connectors|method: "POST"[\s\S]*attestation|grantProjectMcpTool/u);
  assert.doesNotMatch(mcp, /definitionFingerprint|networkFingerprint|credentialFingerprint/u);
  assert.match(mcp, /不提供管理员审核或项目授权按钮/u);
});

test("personal connection forms keep project automation boundary visible", async () => {
  const [git, mcp, guide] = await Promise.all([
    readFile("src/app/profile/connections/git/git-connections-client.tsx", "utf8"),
    readFile("src/app/profile/connections/mcp/mcp-connections-client.tsx", "utf8"),
    readFile("src/app/guide/page.tsx", "utf8"),
  ]);
  assert.match(git, /项目页已支持一次性手动只读委托/u);
  assert.match(git, /项目页已支持一次性手动只读委托；自动化、写入\/提交和旧 PAT 路径保持关闭/u);
  assert.match(git, /已加密保存。密钥输入框已清空；后续变更请在连接卡片中通过安全治理预览管理。当前不会发起网络请求，外部连通性仍未验证/u);
  assert.doesNotMatch(git, /请在卡片中测试连接/u);
  assert.match(mcp, /项目委托控制面已开放/u);
  assert.match(mcp, /远端动作、自动化和调用审批仍未开放/u);
  assert.match(mcp, /保存时会执行受限 DNS\/地址安全解析；不会发起 MCP 协议请求或向远端发送凭据，MCP 连通性仍未验证/u);
  assert.match(mcp, /已加密保存。Token 输入框已清空；后续变更请在连接卡片中通过安全治理预览管理。保存时已执行受限 DNS\/地址安全解析；未发起 MCP 协议请求或向远端发送凭据，MCP 连通性仍未验证/u);
  assert.doesNotMatch(mcp, /请在卡片中发现工具/u);
  assert.doesNotMatch(mcp, /当前不会发起网络请求，外部连通性仍未验证/u);
  assert.match(mcp, /api\/me\/mcp-delegations/u);
  assert.match(guide, /个人 Git 与 MCP 连接可以在个人中心配置/u);
  assert.doesNotMatch(guide, /普通用户不需要也不能配置平台凭据/u);
});
