import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getDb } from "../src/lib/db";
import { grantProjectMembership, grantWorkspaceMembership } from "../src/lib/membership-governance";
import {
  McpCapabilityError,
  buildMcpActionSnapshot,
  createMcpConnection,
  discoverMcpConnectionTools,
  executeMcpActionSnapshot,
  getProjectMcpToolCenter,
  grantProjectMcpTool,
  updateMcpConnection,
} from "../src/lib/mcp";

const shouldRun = process.env.MCP_CAPABILITIES_POSTGRES_GATE === "1";

test("MCP personal discovery remains available while project runtime is fail-closed", { skip: !shouldRun ? "MCP_CAPABILITIES_POSTGRES_GATE=1 is required" : false }, async () => {
  const db = getDb();
  const suffix = randomUUID().slice(0, 8);
  const adminId = randomUUID();
  const editorId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const admin = { id: adminId, role: "admin" as const, accountAccessVersion: 1 };
  const token = `mcp-test-token-${suffix}`;
  const definitionRevision = 1;
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id: string; method: string; params: Record<string, unknown> };
      requests.push(body.method);
      if (request.headers.authorization !== `Bearer ${token}`) {
        response.writeHead(401, { "content-type": "application/json" }); response.end("{}"); return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      if (body.method === "tools/list") {
        response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { resultType: "complete", tools: [{
          name: "project.lookup", description: `Revision ${definitionRevision}`,
          inputSchema: { type: "object", properties: { query: { type: "string", minLength: 1 }, revision: { type: "integer", const: definitionRevision } }, required: ["query", "revision"], additionalProperties: false },
          outputSchema: { type: "object", properties: { found: { type: "boolean" } }, required: ["found"], additionalProperties: false },
          annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        }] } }));
        return;
      }
      response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { resultType: "complete", content: [{ type: "text", text: "found" }], structuredContent: { found: true }, isError: false } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const serverPort = address.port;
  const keyDirectory = await mkdtemp(join(tmpdir(), "ai-project-os-mcp-test-"));
  const previousKeyFile = process.env.AI_PROJECT_OS_MASTER_KEY_FILE;
  process.env.AI_PROJECT_OS_MASTER_KEY_FILE = join(keyDirectory, "master.key");
  let connectionId: string | null = null;
  let credentialId: string | null = null;

  await db.appUser.createMany({ data: [
    { id: adminId, username: `mcp_admin_${suffix}`, role: "admin" },
    { id: editorId, username: `mcp_editor_${suffix}`, role: "member" },
  ] });
  await db.workspace.create({ data: { id: workspaceId, name: `MCP ${suffix}`, slug: `mcp-${suffix}`, createdById: adminId } });
  await db.$transaction((tx) => grantWorkspaceMembership(tx, { workspaceId, userId: adminId, role: "owner", actorId: adminId, reason: "mcp_capabilities_fixture" }));
  await db.project.create({ data: { id: projectId, workspaceId, name: `MCP project ${suffix}`, slug: `mcp-project-${suffix}` } });
  await db.$transaction(async (tx) => {
    await grantProjectMembership(tx, { projectId, workspaceId, userId: adminId, role: "owner", actorId: adminId, reason: "mcp_capabilities_fixture" });
    await grantProjectMembership(tx, { projectId, workspaceId, userId: editorId, role: "editor", actorId: adminId, reason: "mcp_capabilities_fixture" });
  });

  try {
    const connection = await createMcpConnection({ name: `MCP ${suffix}`, endpointUrl: `http://127.0.0.1:${serverPort}/mcp`, authKind: "bearer", bearerToken: token, allowPrivateNetwork: true }, admin, db);
    connectionId = connection.id;
    credentialId = (await db.mcpConnection.findUniqueOrThrow({ where: { id: connection.id }, select: { credentialId: true } })).credentialId;
    await assert.rejects(
      () => updateMcpConnection(connection.id, { enabled: true, expectedUpdatedAt: new Date(0).toISOString() }, admin, db),
      (error: unknown) => error instanceof McpCapabilityError && error.code === "MCP_CONNECTION_CONFLICT",
    );
    const disabled = await updateMcpConnection(connection.id, { bearerToken: token, enabled: false, expectedUpdatedAt: connection.updatedAt.toISOString() }, admin, db);
    assert.equal(disabled.status, "disabled");
    const disabledWithImplicitSecret = await updateMcpConnection(connection.id, { bearerToken: token, expectedUpdatedAt: disabled.updatedAt.toISOString() }, admin, db);
    assert.equal(disabledWithImplicitSecret.status, "disabled");
    const enabled = await updateMcpConnection(connection.id, { enabled: true, expectedUpdatedAt: disabledWithImplicitSecret.updatedAt.toISOString() }, admin, db);
    assert.equal(enabled.status, "configured");
    await assert.rejects(
      () => discoverMcpConnectionTools(connection.id, { expectedUpdatedAt: new Date(0).toISOString() }, admin, db),
      (error: unknown) => error instanceof McpCapabilityError && error.code === "MCP_CONNECTION_CONFLICT",
    );
    assert.deepEqual(requests, []);
    const discovery = await discoverMcpConnectionTools(connection.id, { expectedUpdatedAt: enabled.updatedAt.toISOString() }, admin, db);
    assert.equal(discovery.discoveredCount, 1);
    assert.equal(discovery.eligibleCount, 1);
    const definition = await db.mcpToolDefinition.findFirstOrThrow({ where: { connectionId: connection.id, current: true } });
    await assert.rejects(
      () => getProjectMcpToolCenter(projectId, admin, db),
      (error: unknown) => error instanceof McpCapabilityError && error.code === "MCP_LEGACY_PROJECT_RUNTIME_FROZEN",
    );
    await assert.rejects(
      () => grantProjectMcpTool(projectId, { toolDefinitionId: definition.id, acknowledgeReadOnly: true, expectedUpdatedAt: null }, admin, db),
      (error: unknown) => error instanceof McpCapabilityError && error.code === "MCP_LEGACY_PROJECT_RUNTIME_FROZEN",
    );
    await assert.rejects(
      () => buildMcpActionSnapshot(projectId, { grantId: randomUUID(), arguments: { query: "release", revision: 1 } }, db),
      (error: unknown) => error instanceof McpCapabilityError && error.code === "MCP_LEGACY_PROJECT_RUNTIME_FROZEN",
    );
    await assert.rejects(
      () => executeMcpActionSnapshot(projectId, {
        grantId: randomUUID(),
        connectionId: connection.id,
        toolName: "project.lookup",
        toolDefinitionId: definition.id,
        attestationId: randomUUID(),
        toolDefinitionFingerprint: "a".repeat(64),
        networkFingerprint: "b".repeat(64),
        credentialFingerprint: "c".repeat(64),
        arguments: { query: "release", revision: 1 },
      }, db),
      (error: unknown) => error instanceof McpCapabilityError && error.code === "MCP_LEGACY_PROJECT_RUNTIME_FROZEN",
    );
    assert.deepEqual(requests, ["tools/list"]);
  } finally {
    await db.project.deleteMany({ where: { id: projectId } });
    if (connectionId !== null) await db.mcpConnection.deleteMany({ where: { id: connectionId } });
    if (credentialId !== null) await db.externalCredential.deleteMany({ where: { id: credentialId } });
    await db.workspace.deleteMany({ where: { id: workspaceId } });
    await db.appUser.deleteMany({ where: { id: { in: [adminId, editorId] } } });
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (previousKeyFile === undefined) delete process.env.AI_PROJECT_OS_MASTER_KEY_FILE;
    else process.env.AI_PROJECT_OS_MASTER_KEY_FILE = previousKeyFile;
    await rm(keyDirectory, { recursive: true, force: true });
  }
});
