import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildProjectHref, parseProjectHref } from "../src/lib/project-navigation";

const projectId = "11111111-1111-4111-8111-111111111111";

test("项目配置是受保护的一级项目导航路由", async () => {
  const [navigation, header, page] = await Promise.all([
    readFile("src/lib/project-navigation.ts", "utf8"),
    readFile("src/components/app-header.tsx", "utf8"),
    readFile("src/app/projects/[projectId]/configuration/page.tsx", "utf8"),
  ]);

  const href = buildProjectHref(projectId, "configuration", { from: "overview" });
  assert.equal(href, `/projects/${projectId}/configuration?from=overview`);
  assert.equal(parseProjectHref(projectId, href)?.route, "configuration");
  assert.match(navigation, /"configuration"/u);
  assert.match(navigation, /configuration: \{ suffix: "\/configuration"/u);
  assert.match(header, /projectSection === "configuration"/u);
  assert.match(header, /href=\{`\/projects\/\$\{projectId\}\/configuration`\}/u);
  assert.match(header, /项目配置/u);
  assert.match(page, /requirePageSession()/u);
  assert.match(page, /withWebAiProjectAccessTransaction/u);
  assert.match(page, /allowArchived: true/u);
  assert.match(page, /canManage: admission.permission === "owner"/u);
  assert.match(page, /ProjectConfigurationClient/u);
  assert.match(page, /isSystemAdmin=\{user\.role === "admin"\}/u);
});

test("项目配置四个快照分区独立读取并保护迟到响应", async () => {
  const source = await readFile("src/app/projects/[projectId]/configuration/project-configuration-client.tsx", "utf8");

  for (const endpoint of ["ai-provider-delegations", "git-repository-delegations", "mcp-connection-delegations", "mcp-tool-grants"]) {
    assert.match(source, new RegExp(`/api/projects/\\$\\{projectId\\}/${endpoint}`, "u"));
  }
  assert.equal((source.match(/useProjectSnapshot\(projectId,/gu) ?? []).length, 4);
  assert.match(source, /cache: "no-store"/u);
  assert.match(source, /AbortController/u);
  assert.match(source, /requestRef\.current\?\.controller\.abort()/u);
  assert.match(source, /request\.projectId/u);
  assert.match(source, /requestRef\.current\?\.token !== request\.token/u);
  assert.match(source, /state\.refresh/u);
  assert.match(source, /操作仍由原接口在提交前重新校验/u);
  assert.match(source, /operationExecutionAvailable/u);
  assert.match(source, /platformDefault/u);
  assert.match(source, /personalDelegation/u);
  assert.match(source, /连接所有者承担供应商费用/u);
  assert.match(source, /自动化范围需单独开放/u);
  assert.match(source, /自动化关闭/u);
  assert.doesNotMatch(source, /自动化 \{booleanLabel\(delegation\.automationAllowed, "开启", "关闭"\)\}/u);
  assert.match(source, /effectiveStatus/u);
  assert.match(source, /function readMcpReason/u);
  assert.match(source, /value\.toLowerCase\(\)/u);
  assert.match(source, /hasOwnProperty\.call\(mcpReasonLabels, normalized\)/u);
  assert.match(source, /reviewRequired/u);
  assert.match(source, /手动读取前仍会在 Git 页面由原接口重新校验/u);
  assert.match(source, /\/personal\/models/u);
  assert.match(source, /buildProjectHref\(projectId, "repositories"\)/u);
  assert.match(source, /buildProjectHref\(projectId, "tools"\)/u);
  assert.match(source, /errorState\?\.projectId === projectId/u);
  assert.match(source, /仅项目 Owner 可查看工具授权/u);
  assert.match(source, /自动化范围需单独开放/u);
  assert.match(source, /ProjectManagement/u);
  assert.match(source, /仅项目 Owner 可操作/u);
  assert.match(source, /导出 JSON/u);
  assert.match(source, /归档项目/u);
  assert.match(source, /恢复项目/u);
  assert.match(source, /永久删除/u);
  assert.match(source, /expectedUpdatedAt/u);
  for (const comment of ["Accept only plain object-like payloads", "Bound each displayed scope list", "Project the AI selection allowlist", "Read one independent control-plane endpoint"]) {
    assert.match(source, new RegExp(comment, "u"), `configuration source should document ${comment}`);
  }
  assert.doesNotMatch(source, /endpointUrl|bearerToken|ciphertext|nonce|authTag|secretFingerprint|resolvedAddressFingerprint|credentialFingerprint/u);
});
