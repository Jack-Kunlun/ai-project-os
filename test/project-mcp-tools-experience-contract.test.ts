import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("project MCP tools page exposes only the server-authorized control plane", async () => {
  const source = await readFile("src/app/projects/[projectId]/tools/project-tools-client.tsx", "utf8");
  assert.match(source, /\/api\/projects\/\$\{projectId\}\/mcp-connection-delegations/u);
  assert.match(source, /\/api\/projects\/\$\{projectId\}\/mcp-tool-grants/u);
  for (const action of ["owner-confirmation", "project-confirmation", "rejection", "revocation"]) {
    assert.match(source, new RegExp(action, "u"), `project MCP page must support ${action}`);
  }
  assert.match(source, /acknowledgeCredentialUse/u);
  assert.match(source, /acknowledgeProjectScope/u);
  assert.match(source, /acknowledgeDataEgress/u);
  assert.match(source, /acknowledgeReadOnly/u);
  assert.match(source, /控制面开放；动作调用冻结/u);
  assert.match(source, /仅管理连接委托和只读工具授权/u);
  assert.match(source, /不可信远端声明，仅供审核/u);
  assert.match(source, /grant\.effective/u);
  assert.match(source, /grant\.reviewRequired/u);
  assert.match(source, /不会计入有效额度/u);
  assert.match(source, /费用承担者为连接所有者/u);
  assert.match(source, /平台不代扣，也不计入项目平台额度/u);
  assert.match(source, /新连接保存时仅执行受限 DNS\/地址安全解析/u);
  assert.match(source, /当前不能成为项目可委托连接/u);
  assert.match(source, /现场 MCP 验证入口尚未开放/u);
  assert.doesNotMatch(source, /个人 MCP 设置<\/Link>中完成验证/u);
  assert.doesNotMatch(source, /\/mcp-actions|tools\/call|\/dispatch|result-import/u);
  assert.doesNotMatch(source, /endpointUrl|bearerToken|ciphertext|nonce|authTag|rawHeaders/u);
});

test("personal MCP page gives owners a minimal, project-name-free delegation queue", async () => {
  const source = await readFile("src/app/profile/connections/mcp/mcp-connections-client.tsx", "utf8");
  assert.match(source, /\/api\/me\/mcp-delegations/u);
  assert.match(source, /owner-confirmation/u);
  assert.match(source, /rejection/u);
  assert.match(source, /revocation/u);
  assert.match(source, /待连接所有者确认/u);
  assert.match(source, /待项目 Owner 确认/u);
  assert.match(source, /已启用控制面授权/u);
  assert.match(source, /项目名称和项目标识不会在个人页面展示/u);
  assert.doesNotMatch(source, /project\.name|project\.slug/u);
  assert.match(source, /费用承担者为连接所有者/u);
  assert.match(source, /平台不代扣，也不计入项目平台额度/u);
});

test("project Git page keeps payer semantics visible", async () => {
  const source = await readFile("src/app/projects/[projectId]/repositories/project-repositories-client.tsx", "utf8");
  assert.match(source, /费用承担者为连接所有者/u);
  assert.match(source, /第三方费用由其与服务商约定/u);
  assert.match(source, /平台不代扣，也不计入项目平台额度/u);
});
