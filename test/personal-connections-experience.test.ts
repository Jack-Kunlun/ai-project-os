import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("personal connection pages are canonical workspace resources with authenticated legacy redirects", async () => {
  const [gitPage, mcpPage, legacyGitPage, legacyMcpPage, profile, legacyGit, legacyMcp] = await Promise.all([
    readFile("src/app/personal/connections/git/page.tsx", "utf8"),
    readFile("src/app/personal/connections/mcp/page.tsx", "utf8"),
    readFile("src/app/profile/connections/git/page.tsx", "utf8"),
    readFile("src/app/profile/connections/mcp/page.tsx", "utf8"),
    readFile("src/app/profile/profile-client.tsx", "utf8"),
    readFile("src/app/connections/page.tsx", "utf8"),
    readFile("src/app/connections/mcp/page.tsx", "utf8"),
  ]);

  for (const page of [gitPage, mcpPage]) {
    assert.match(page, /requirePageSession\(\)/u);
    assert.match(page, /active="personalKnowledge"/u);
    assert.match(page, /PersonalWorkspaceNav/u);
    assert.match(page, /isSystemAdmin/iu);
  }
  assert.match(legacyGitPage, /requirePageSession\(\)/u);
  assert.match(legacyGitPage, /redirect\("\/personal\/connections\/git"\)/u);
  assert.match(legacyMcpPage, /requirePageSession\(\)/u);
  assert.match(legacyMcpPage, /redirect\("\/personal\/connections\/mcp"\)/u);
  assert.doesNotMatch(profile, /我的连接|\/profile\/connections/u);
  assert.match(legacyGit, /\/personal\/connections\/git/u);
  assert.match(legacyMcp, /\/personal\/connections\/mcp/u);
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
  assert.match(git, /项目页支持一次性手动只读委托和单独的自动读取双确认授权/u);
  assert.match(git, /写入\/提交和旧 PAT 路径保持关闭/u);
  assert.match(git, /费用承担者为连接所有者/u);
  assert.match(git, /manualSyncAllowed/u);
  assert.match(git, /canReject|canRevoke/u);
  assert.match(git, /rejection|revocation/u);
  assert.match(git, /\/api\/me\/git-connections\/probe/u);
  assert.match(git, /测试指定仓库和 ref，确认结果后再保存/u);
  assert.match(git, /draftProbeId: testedProbe\.draftProbeId/u);

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
  assert.match(mcp, /\/api\/me\/mcp-connections\/probe/u);
  assert.match(mcp, /新建连接会先执行受限 DNS\/地址安全解析，再完成 initialize 和 tools\/list 只读测试/u);
  assert.match(mcp, /draftProbeId: testedProbe\.draftProbeId/u);
});

test("personal connection forms keep project automation boundary visible", async () => {
  const [git, mcp, guide, repositories, personalConfiguration] = await Promise.all([
    readFile("src/app/profile/connections/git/git-connections-client.tsx", "utf8"),
    readFile("src/app/profile/connections/mcp/mcp-connections-client.tsx", "utf8"),
    readFile("src/app/guide/page.tsx", "utf8"),
    readFile("src/app/projects/[projectId]/repositories/project-repositories-client.tsx", "utf8"),
    readFile("src/app/personal/configuration/page.tsx", "utf8"),
  ]);
  assert.match(git, /Git 授权管理/u);
  assert.match(git, /项目代码仓库从项目配置发起连接和范围提案/u);
  assert.match(git, /项目页支持一次性手动只读委托和单独的自动读取双确认授权/u);
  assert.match(git, /写入\/提交和旧 PAT 路径保持关闭/u);
  assert.match(git, /已完成 Git 仓库只读测试并加密保存。密钥输入框已清空；后续变更请在连接卡片中通过安全治理预览管理/u);
  assert.doesNotMatch(git, /请在卡片中测试连接/u);
  assert.match(mcp, /项目委托控制面已开放/u);
  assert.match(mcp, /只读动作在受控环境逐次审批，生产开放仍需验收；自动化保持关闭/u);
  assert.match(mcp, /新建连接会先执行受限 DNS\/地址安全解析，再完成 initialize 和 tools\/list 只读测试/u);
  assert.match(mcp, /已完成 MCP initialize 和 tools\/list 只读测试并加密保存。Token 输入框已清空；后续变更请在连接卡片中通过安全治理预览管理/u);
  assert.doesNotMatch(mcp, /请在卡片中发现工具/u);
  assert.doesNotMatch(mcp, /当前不会发起网络请求，外部连通性仍未验证/u);
  assert.match(mcp, /api\/me\/mcp-delegations/u);
  assert.match(guide, /代码仓库接入和读取范围在“项目配置 → 代码仓库”管理/u);
  assert.match(guide, /“我的空间 → 配置 → Git 授权管理”维护个人凭据/u);
  assert.doesNotMatch(guide, /普通用户不需要也不能配置平台凭据/u);
  assert.match(personalConfiguration, /title="Git 授权管理"/u);
  assert.match(personalConfiguration, /项目绑定从项目的代码仓库配置发起/u);
  assert.match(repositories, /添加并验证 Git 服务/u);
  assert.match(repositories, /GitCreateForm catalog=\{catalog\} requireCredential/u);
  assert.match(git, /requireCredential && draft.authKind === "none"/u);
  assert.match(repositories, /onProjectSaved=\{onProjectConnectionSaved\}/u);
  assert.match(repositories, /const freshConnections = await onRefreshConnections()/u);
  const refreshOptions = repositories.slice(repositories.indexOf("const refreshProjectOptions"), repositories.indexOf("async function mutate"));
  assert.match(refreshOptions, /\[401, 403, 404\]\.includes\(status\)\) await load\(\)/u);
  assert.match(repositories, /setConnectionId\(target\.connectionId\)/u);
  assert.match(repositories, /setRepositoryPath\(target\.repositoryPath\)/u);
  assert.match(repositories, /setTrackedRef\(target\.trackedRef\)/u);
  assert.match(repositories, /!connectionsFresh || selectedConnectionId === ""/u);
  const projectSaveCallback = git.slice(git.indexOf("const result = { connectionId: connection.id"), git.indexOf("setMessage({ tone: \"error\", text: \"Git 连接已保存"));
  assert.match(projectSaveCallback, /repositoryPath: testedProbe\.repositoryPath/u);
  assert.match(projectSaveCallback, /trackedRef: testedProbe\.trackedRef/u);
  assert.doesNotMatch(projectSaveCallback, /secret|baseUrl|username|credential/u);
  assert.match(repositories, /manualSyncAllowed: true/u);
  assert.match(repositories, /automationAllowed: false/u);
  const projectSavedHandler = repositories.slice(repositories.indexOf("async function onProjectConnectionSaved"), repositories.indexOf("async function submit", repositories.indexOf("async function onProjectConnectionSaved")));
  assert.doesNotMatch(projectSavedHandler, /confirmOwner|owner-confirmation|project-confirmation|automation-grants/u);
});
