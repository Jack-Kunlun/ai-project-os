import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("管理员 MCP 页面由服务器守住权限并挂载审核工作台", async () => {
  const page = await readFile("src/app/admin/connectors/mcp/page.tsx", "utf8");
  assert.match(page, /requireSystemAdminPage/u);
  assert.match(page, /McpReviewWorkbench/u);
  assert.match(page, /AdminPageFrame active="mcp"/u);
});

test("MCP 审核工作台只消费净化候选 API，不暴露连接材料或动作入口", async () => {
  const workbench = await readFile("src/app/admin/connectors/mcp/mcp-review-workbench.tsx", "utf8");
  assert.match(workbench, /^"use client";/u);
  assert.match(workbench, /\/api\/system\/mcp-tool-attestation-candidates/u);
  assert.match(workbench, /\/api\/system\/mcp-tool-reviews/u);
  assert.match(workbench, /inputSchema/u);
  assert.match(workbench, /outputSchema/u);
  assert.match(workbench, /annotations/u);
  assert.match(workbench, /remoteTextTrust/u);
  assert.match(workbench, /definitionFingerprint/u);
  assert.match(workbench, /networkFingerprint/u);
  assert.match(workbench, /credentialFingerprint/u);
  assert.match(workbench, /connectionConfigurationRevision/u);
  assert.match(workbench, /不可信远端声明，仅供人工审核/u);
  assert.match(workbench, /read_only_verified/u);
  assert.match(workbench, /read_only_rejected/u);
  assert.match(workbench, /needs_research/u);
  assert.match(workbench, /maxLength=\{240\}/u);
  assert.match(workbench, /normalize\("NFKC"\)/u);
  assert.match(workbench, /role="tab"/u);
  assert.match(workbench, /focus-visible:outline-2/u);
  assert.doesNotMatch(workbench, /endpointUrl|maskedSuffix|ciphertext|nonce|authTag|rawHeaders|bearerToken/u);
  assert.doesNotMatch(workbench, /调用|审批|派发|dispatch/iu);
  assert.doesNotMatch(workbench, /from ["']@\/lib\/mcp["']/u);
});

test("MCP 审核工作台的禁用按钮保持可读对比度", async () => {
  const workbench = await readFile("src/app/admin/connectors/mcp/mcp-review-workbench.tsx", "utf8");
  const disabledClassNames = [...workbench.matchAll(/className="([^"]*disabled:[^"]*)"/gu)].map((match) => match[1]);
  assert.equal(disabledClassNames.length, 4);
  for (const className of disabledClassNames) {
    assert.match(className, /disabled:border-slate-400/u);
    assert.match(className, /disabled:bg-slate-200/u);
    assert.match(className, /disabled:text-slate-700/u);
  }
  assert.doesNotMatch(workbench, /disabled:opacity-/u);
});
