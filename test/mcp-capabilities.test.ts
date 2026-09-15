import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import test from "node:test";
import {
  McpCapabilityError,
  callMcpTool,
  canonicalMcpToolArguments,
  discoverMcpTools,
  normalizeMcpToolDefinition,
} from "../src/lib/mcp";

const readOnlyTool = {
  name: "project.search",
  title: "Project search",
  description: "Search an explicitly selected project index.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", minLength: 1, maxLength: 100 },
      region: { type: "string", "x-mcp-header": "Region" },
    },
    required: ["query", "region"],
    additionalProperties: false,
  },
  outputSchema: { type: "object", properties: { matches: { type: "integer" } }, required: ["matches"], additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
};

function mcpCode(error: unknown): string {
  return error instanceof McpCapabilityError ? error.code : "unexpected";
}

test("MCP 工具定义只把明确只读且非破坏性的工具列为可授权", () => {
  const normalized = normalizeMcpToolDefinition(readOnlyTool);
  assert.equal(normalized.remoteReadOnlyHint, true);
  assert.equal(normalized.readOnlyEligible, true);
  assert.match(normalized.definitionFingerprint, /^[0-9a-f]{64}$/u);
  assert.equal(normalizeMcpToolDefinition({ ...readOnlyTool, name: "unsafe", annotations: { readOnlyHint: true } }).readOnlyEligible, false);
  assert.deepEqual(canonicalMcpToolArguments(readOnlyTool.inputSchema, { region: "cn", query: "release" }), { query: "release", region: "cn" });
  assert.throws(() => canonicalMcpToolArguments(readOnlyTool.inputSchema, { query: "release" }), (error) => mcpCode(error) === "MCP_TOOL_INPUT_INVALID");
  assert.throws(() => normalizeMcpToolDefinition({ ...readOnlyTool, inputSchema: { type: "object", oneOf: [] } }), (error) => mcpCode(error) === "MCP_TOOL_CATALOG_INVALID");
});

test("远程 Streamable HTTP MCP 完成工具发现、固定请求头和 SSE 只读调用", async (context) => {
  const requests: Array<{ method: string; headers: Record<string, string | string[] | undefined>; body: unknown }> = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id: string; method: string };
      requests.push({ method: body.method, headers: request.headers, body });
      if (body.method === "tools/list") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { resultType: "complete", tools: [readOnlyTool] } }));
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { resultType: "complete", content: [{ type: "text", text: "2 matches" }], structuredContent: { matches: 2 }, isError: false } })}\n\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const endpointUrl = `http://127.0.0.1:${address.port}/mcp`;
  const discovery = await discoverMcpTools({ endpointUrl, allowPrivateNetwork: true, expectedAddressFingerprint: null, bearerToken: "test-token-1234" });
  assert.equal(discovery.tools.length, 1);
  assert.equal(discovery.tools[0]?.readOnlyEligible, true);
  const result = await callMcpTool({
    endpointUrl,
    allowPrivateNetwork: true,
    expectedAddressFingerprint: discovery.addressFingerprint,
    bearerToken: "test-token-1234",
    toolName: "project.search",
    inputSchema: discovery.tools[0]!.inputSchema,
    arguments: { query: "release", region: "cn-north" },
  });
  assert.equal(result.text, "2 matches");
  assert.deepEqual(result.structuredContent, { matches: 2 });
  assert.equal(requests[0]?.headers["mcp-protocol-version"], "2026-07-28");
  assert.equal(requests[0]?.headers["mcp-method"], "tools/list");
  assert.equal(requests[1]?.headers["mcp-method"], "tools/call");
  assert.equal(requests[1]?.headers["mcp-name"], "project.search");
  assert.equal(requests[1]?.headers["mcp-param-region"], "cn-north");
  assert.equal(requests[1]?.headers.authorization, "Bearer test-token-1234");
});

test("MCP 数据库迁移固定逐次审批、当前定义唯一和追加式审计", async () => {
  const migration = await readFile("prisma/migrations/20260829230000_add_controlled_mcp_capabilities/migration.sql", "utf8");
  assert.match(migration, /project\.mcp\.read-tool\.invoke/u);
  assert.match(migration, /ProjectAction_mcp_approval_check/u);
  assert.match(migration, /ProjectActionPolicy_mcp_mode_check/u);
  assert.match(migration, /McpToolDefinition_current_key/u);
  assert.match(migration, /MCP tool definitions are append-only/u);
  assert.match(migration, /project MCP tool grant audit is immutable/u);
  assert.doesNotMatch(migration, /stdio|shell\.execute|code\.write|deploy\.execute/u);
});

test("MCP Package A/C1 keeps delegation control-plane data isolated and project runtime frozen", async () => {
  const [schema, migration, v2Migration] = await Promise.all([
    readFile("prisma/schema.prisma", "utf8"),
    readFile("prisma/migrations/20260904180000_add_project_mcp_connection_delegations/migration.sql", "utf8"),
    readFile("prisma/migrations/20260904190000_add_mcp_control_plane_v2/migration.sql", "utf8"),
  ]);
  const sentinel = createHash("sha256").update("mcp:no-credential:v1").digest("hex");
  const schemaSentinel = schema.match(/credentialFingerprint\s+String\s+@default\("([0-9a-f]{64})"\)\s+@db\.Char\(64\)/u)?.[1];
  assert.equal(schemaSentinel, sentinel);
  const migrationSentinels = migration.match(/d2ab[0-9a-f]{60}/gu) ?? [];
  assert.ok(migrationSentinels.length >= 3);
  assert.ok(migrationSentinels.every((value) => value === sentinel));
  assert.match(schema, /configurationRevision\s+Int\s+@default\(1\)/u);
  assert.match(schema, /transactionId\s+BigInt\?\s+@db\.BigInt/u);
  assert.match(schema, /revocationTransactionId\s+BigInt\?\s+@db\.BigInt/u);
  assert.match(schema, /controlPlaneVersion\s+Int\?/u);
  assert.match(schema, /grantVersion\s+Int\?/u);
  assert.match(schema, /grantorProjectMembershipId\s+String\?/u);
  assert.match(schema, /revokerProjectMembershipId\s+String\?/u);
  assert.match(schema, /McpToolAttestationStatus/u);
  assert.match(schema, /model ProjectMcpConnectionDelegation \{/u);
  assert.match(schema, /model ProjectMcpConnectionDelegationAudit \{/u);
  assert.match(schema, /delegationId\s+String\?\s+@db\.Uuid/u);
  assert.match(migration, /LOCK TABLE "McpConnection", "ProjectMcpToolGrant", "ProjectMcpToolGrantAudit", "ProjectAction", "ExternalCredential"/u);
  assert.match(migration, /McpConnection_disabled_state_check/u);
  assert.match(migration, /PMCD_CONNECTION_EVIDENCE_PREFLIGHT_FAILED/u);
  assert.match(migration, /PMCD_NONTERMINAL_MCP_ACTION_PREFLIGHT_FAILED/u);
  assert.match(migration, /MCP_CONNECTION_CREDENTIAL_MIRROR_INVALID/u);
  assert.match(migration, /MCP_CONNECTION_CONFIGURATION_REVISION_INVALID/u);
  assert.match(migration, /ALTER CONSTRAINT "McpConnection_credentialId_fkey" DEFERRABLE INITIALLY DEFERRED/u);
  assert.match(migration, /FOREIGN KEY \("delegationId", "projectId", "connectionId"\)[\s\S]*?ON DELETE NO ACTION ON UPDATE NO ACTION/u);
  assert.match(migration, /PMCD_live_project_connection_key/u);
  assert.match(migration, /PMCD_audit_immutable_guard/u);
  assert.match(migration, /ProjectMcpToolGrant_revoke_audit_guard/u);
  assert.match(migration, /PROJECT_MCP_TOOL_GRANT_REVOKE_AUDIT_REQUIRED/u);
  assert.match(migration, /PROJECT_MCP_TOOL_GRANT_DELETE_FORBIDDEN/u);
  assert.match(migration, /NEW\."transactionId" := txid_current\(\)/u);
  assert.match(migration, /grant_source\.xmin::text::bigint AS row_xmin/u);
  assert.match(migration, /mod\(txid_current\(\), 4294967296::bigint\)/u);
  assert.match(migration, /existing\."transactionId" = txid_current\(\)/u);
  assert.match(migration, /PROJECT_MCP_TOOL_GRANT_INSERT_FROZEN/u);
  assert.match(migration, /PROJECT_MCP_ACTION_INSERT_FROZEN/u);
  assert.doesNotMatch(migration, /INSERT\s+INTO\s+"ProjectMcpToolGrant"/u);
  assert.doesNotMatch(migration, /INSERT\s+INTO\s+"ProjectAction"/u);
  assert.match(v2Migration, /ProjectMcpToolGrant_v2_shape_check/u);
  assert.match(v2Migration, /McpToolAttestation_v2_shape_check/u);
  assert.match(v2Migration, /revocationTransactionId/u);
  assert.match(v2Migration, /NEW\."revocationTransactionId" := txid_current\(\)/u);
  assert.match(v2Migration, /MCP_TOOL_ATTESTATION_AUDIT_REQUIRED/u);
  assert.match(v2Migration, /PROJECT_MCP_TOOL_GRANT_REVOKE_AUDIT_REQUIRED/u);
  assert.match(v2Migration, /MCP_CONNECTION_V2_ATTESTATION_DELETE_FORBIDDEN/u);
  assert.match(v2Migration, /"conclusion" = 'read_only_verified'/u);
  assert.match(v2Migration, /"riskLevel" IN \('low', 'medium', 'high'\)/u);
  assert.match(v2Migration, /"evidenceNote" = 'manual_read_only_review'/u);
  assert.match(v2Migration, /"note" IS NULL/u);
  assert.match(v2Migration, /"evidence" = '\{\}'::jsonb/u);
  assert.match(v2Migration, /CREATE UNIQUE INDEX "McpToolAttestation_v2_active_tuple_key"/u);
  assert.match(v2Migration, /CREATE UNIQUE INDEX "McpToolAttestationAudit_v2_event_key"/u);
  assert.match(v2Migration, /CREATE UNIQUE INDEX "ProjectMcpToolGrant_active_project_connection_tool_key"/u);
  assert.match(v2Migration, /DROP INDEX "ProjectMcpToolGrant_projectId_connectionId_toolName_key"/u);
  assert.match(v2Migration, /project_mcp_tool_grant_v2_history_valid/u);
  assert.match(v2Migration, /OLD\."managedById" IS DISTINCT FROM NEW\."managedById"/u);
  assert.match(v2Migration, /NEW\."revokedById"/u);
  assert.match(v2Migration, /grant_row\."controlPlaneVersion" IS DISTINCT FROM 2 AND NOT EXISTS/u);
  assert.match(v2Migration, /WHERE "controlPlaneVersion" = 2 AND "status" = 'active'/u);
  assert.doesNotMatch(v2Migration, /\bxmin\b/u);
  assert.match(v2Migration, /expiresAt" > clock_timestamp\(\)/u);
  assert.match(v2Migration, /project_row\."archivedAt" IS NULL/u);
  assert.match(v2Migration, /connection\."ownershipState" = 'confirmed'/u);
  assert.match(v2Migration, /connection\."credentialId" IS NULL/u);
  assert.match(v2Migration, /credential\."kind" = 'mcp'/u);
  assert.match(v2Migration, /credential\."secretFingerprint" = connection\."credentialFingerprint"/u);
  assert.match(v2Migration, /owner_membership\."role" IN \('owner', 'editor'\)/u);
  assert.match(v2Migration, /project_owner_membership\."role" = 'owner'/u);
  assert.match(v2Migration, /grant_row\."grantVersion" IS NOT NULL/u);
  assert.match(v2Migration, /COALESCE\(\(/u);
  assert.doesNotMatch(v2Migration, /ciphertext|nonce|authTag|maskedSuffix|\bsecret\b|authorization\b|Bearer\s+[^'"]+/u);
  const tableDefinitions = migration.slice(
    migration.indexOf('CREATE TABLE "ProjectMcpConnectionDelegation"'),
    migration.indexOf("CREATE UNIQUE INDEX"),
  );
  assert.doesNotMatch(tableDefinitions, /endpointUrl|credentialId|maskedSuffix|ciphertext|nonce|authTag/u);
});

test("MCP 页面指南表达当前个人发现、管理员审核与项目只读授权边界", async () => {
  const [guide, connections] = await Promise.all([
    readFile("src/app/guide/page.tsx", "utf8"),
    readFile("src/app/connections/mcp/mcp-connections-client.tsx", "utf8"),
  ]);
  assert.match(guide, /个人连接与工具发现、管理员净化快照审核、项目连接委托和只读工具授权控制面已开放/u);
  assert.match(guide, /MCP 工具必须由管理员审核精确工具后才能由项目 Owner 管理连接委托和只读工具授权/u);
  assert.match(guide, /远端动作调用、调用审批、派发和结果查看\/导入尚未开放，不能通过内部 API 绕过/u);
  assert.match(connections, /管理员认证精确定义、网络和凭据指纹/u);
  assert.match(connections, /完成工具发现与管理员认证/u);
});
