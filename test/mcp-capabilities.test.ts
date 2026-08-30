import assert from "node:assert/strict";
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
