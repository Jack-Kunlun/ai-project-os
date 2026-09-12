import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const panel = readFileSync("src/app/profile/connections/governance-panel.tsx", "utf8");
const gitClient = readFileSync("src/app/profile/connections/git/git-connections-client.tsx", "utf8");
const mcpClient = readFileSync("src/app/profile/connections/mcp/mcp-connections-client.tsx", "utf8");

test("personal Git and MCP pages use governance preview and execute only", () => {
  for (const source of [gitClient, mcpClient]) {
    assert.match(source, /ConnectionGovernancePanel/u);
    assert.doesNotMatch(source, /method:\s*["']PATCH["']/u);
    assert.doesNotMatch(source, /method:\s*["']DELETE["']/u);
    assert.doesNotMatch(source, /\/governance\/preview/u);
    assert.doesNotMatch(source, /\/governance\/execute/u);
  }
  assert.match(panel, /governance\/\$\{operation\}/u);
  assert.match(panel, /method:\s*"POST"/gu);
  assert.match(panel, /action/u);
  assert.match(panel, /requestKey/u);
  assert.match(panel, /expectedUpdatedAt/u);
  assert.match(panel, /requestFingerprint/u);
  assert.match(panel, /impactFingerprint/u);
  assert.match(panel, /preview\.expiresAt/u);
  assert.match(panel, /onRemoved\(\)/u);
});

test("personal governance UI is secret-safe and keeps external actions fail-closed", () => {
  assert.match(panel, /仅当前浏览器暂存/u);
  assert.match(panel, /不会在预览或响应中回显/u);
  assert.match(panel, /尚未开放，不能绕过治理/u);
  assert.match(panel, /GIT_EXTERNAL_IO_PLANNED_NOT_DISPATCHED/u);
  assert.match(panel, /MCP_EXTERNAL_IO_PLANNED_NOT_DISPATCHED/u);
  assert.doesNotMatch(panel, /maskedSuffix/u);
  assert.doesNotMatch(panel, /endpointUrl/u);
  assert.doesNotMatch(panel, /payload\.secret/u);
  assert.doesNotMatch(panel, /payload\.token/u);
  assert.match(panel, /requiredValue: action === "delete" \? connection\.name : "确认"/u);
  assert.match(panel, /费用承担者为连接所有者/u);
  assert.match(panel, /governanceBoundary\(kind\)/u);
  assert.match(panel, /MCP 连接保存时会执行受限 DNS\/地址安全解析/u);
  assert.match(panel, /不会发起 MCP 协议请求或向远端发送凭据/u);
  assert.match(panel, /不会自动发起网络请求，外部连通性仍未验证/u);
  assert.match(gitClient, /当前不会发起网络请求，外部连通性仍未验证/u);
  assert.match(mcpClient, /保存时会执行受限 DNS\/地址安全解析/u);
  assert.match(mcpClient, /不会发起 MCP 协议请求或向远端发送凭据/u);
  assert.doesNotMatch(mcpClient, /当前不会发起网络请求，外部连通性仍未验证/u);
});

test("personal governance impact display is bounded to safe project fields", () => {
  assert.match(panel, /liveDelegations/u);
  assert.match(panel, /legacyLinks/u);
  assert.match(panel, /manualRuns/u);
  assert.match(panel, /activeToolGrants/u);
  assert.match(panel, /v2Attestations/u);
  assert.match(panel, /nonTerminalActions/u);
  assert.match(panel, /reservedDispatches/u);
  assert.match(panel, /projectName/u);
  assert.match(panel, /项目名称不可见/u);
  assert.match(panel, /不展示 endpoint、凭据或原始指纹/u);
});
