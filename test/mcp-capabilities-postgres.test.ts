import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ActionEngineError, decideProjectAction, requestProjectAction, runProjectActionWorkerCycle, updateProjectActionPolicy } from "../src/lib/action-engine";
import { getDb } from "../src/lib/db";
import {
  McpCapabilityError,
  createMcpConnection,
  discoverMcpConnectionTools,
  grantProjectMcpTool,
  revokeProjectMcpToolGrant,
  updateMcpConnection,
} from "../src/lib/mcp";

const shouldRun = process.env.MCP_CAPABILITIES_POSTGRES_GATE === "1";

test("MCP capabilities persist discovery, grants, approval, execution and drift closure", { skip: !shouldRun ? "MCP_CAPABILITIES_POSTGRES_GATE=1 is required" : false }, async () => {
  const db = getDb();
  const suffix = randomUUID().slice(0, 8);
  const adminId = randomUUID();
  const editorId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const admin = { id: adminId, role: "admin" as const };
  const editor = { id: editorId, role: "member" as const };
  const token = `mcp-test-token-${suffix}`;
  let definitionRevision = 1;
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
  await db.workspaceMembership.create({ data: { workspaceId, userId: adminId, role: "owner" } });
  await db.project.create({ data: { id: projectId, workspaceId, name: `MCP project ${suffix}`, slug: `mcp-project-${suffix}` } });
  await db.projectMembership.create({ data: { projectId, userId: editorId, role: "editor" } });

  try {
    const connection = await createMcpConnection({ name: `MCP ${suffix}`, endpointUrl: `http://127.0.0.1:${address.port}/mcp`, authKind: "bearer", bearerToken: token, allowPrivateNetwork: true }, admin, db);
    connectionId = connection.id;
    credentialId = (await db.mcpConnection.findUniqueOrThrow({ where: { id: connection.id }, select: { credentialId: true } })).credentialId;
    await assert.rejects(
      () => updateMcpConnection(connection.id, { enabled: true, expectedUpdatedAt: new Date(0).toISOString() }, db),
      (error: unknown) => error instanceof McpCapabilityError && error.code === "MCP_CONNECTION_CONFLICT",
    );
    const disabled = await updateMcpConnection(connection.id, { bearerToken: token, enabled: false, expectedUpdatedAt: connection.updatedAt.toISOString() }, db);
    assert.equal(disabled.status, "disabled");
    const enabled = await updateMcpConnection(connection.id, { enabled: true, expectedUpdatedAt: disabled.updatedAt.toISOString() }, db);
    assert.equal(enabled.status, "configured");
    const discovery = await discoverMcpConnectionTools(connection.id, db);
    assert.equal(discovery.discoveredCount, 1);
    assert.equal(discovery.eligibleCount, 1);
    const definition = await db.mcpToolDefinition.findFirstOrThrow({ where: { connectionId: connection.id, current: true } });
    const grant = await grantProjectMcpTool(projectId, { toolDefinitionId: definition.id, acknowledgeReadOnly: true, expectedUpdatedAt: null }, admin, db);
    assert.equal(grant.status, "active");
    await assert.rejects(
      () => updateProjectActionPolicy(projectId, "project.mcp.read-tool.invoke", { mode: "automatic", expectedUpdatedAt: null }, admin, db),
      (error: unknown) => error instanceof ActionEngineError && error.code === "ACTION_INVALID_INPUT",
    );

    const waiting = await requestProjectAction(projectId, { capability: "project.mcp.read-tool.invoke", input: { grantId: grant.id, arguments: { query: "release", revision: 1 } }, clientRequestId: randomUUID() }, editor, db);
    assert.equal(waiting.status, "waitingApproval");
    const approved = await decideProjectAction(projectId, waiting.id, { decision: "approved", expectedUpdatedAt: waiting.updatedAt.toISOString(), expectedFingerprint: waiting.inputFingerprint, note: "已核对只读参数" }, admin, db);
    assert.equal(approved.status, "queued");
    assert.equal((await runProjectActionWorkerCycle({ workerId: `mcp-test:${suffix}`, maximumActions: 1 }, db)).succeeded, 1);
    const succeeded = await db.projectAction.findUniqueOrThrow({ where: { id: waiting.id } });
    assert.equal(succeeded.status, "succeeded");
    assert.equal((succeeded.result as { toolName?: string }).toolName, "project.lookup");

    const staleWaiting = await requestProjectAction(projectId, { capability: "project.mcp.read-tool.invoke", input: { grantId: grant.id, arguments: { query: "release", revision: 1 } }, clientRequestId: randomUUID() }, editor, db);
    await decideProjectAction(projectId, staleWaiting.id, { decision: "approved", expectedUpdatedAt: staleWaiting.updatedAt.toISOString(), expectedFingerprint: staleWaiting.inputFingerprint, note: null }, admin, db);
    definitionRevision = 2;
    await discoverMcpConnectionTools(connection.id, db);
    const driftCycle = await runProjectActionWorkerCycle({ workerId: `mcp-test:${suffix}`, maximumActions: 1 }, db);
    assert.equal(driftCycle.failed, 1);
    const failed = await db.projectAction.findUniqueOrThrow({ where: { id: staleWaiting.id } });
    assert.equal(failed.status, "failed");
    assert.equal(failed.failureCode, "MCP_TOOL_DEFINITION_STALE");

    await assert.rejects(
      () => requestProjectAction(projectId, { capability: "project.mcp.read-tool.invoke", input: { grantId: grant.id, arguments: { query: "release", revision: 1 } }, clientRequestId: randomUUID() }, editor, db),
      (error: unknown) => error instanceof McpCapabilityError && error.code === "MCP_TOOL_DEFINITION_STALE",
    );
    const current = await db.mcpToolDefinition.findFirstOrThrow({ where: { connectionId: connection.id, current: true } });
    const refreshed = await grantProjectMcpTool(projectId, { toolDefinitionId: current.id, acknowledgeReadOnly: true, expectedUpdatedAt: (await db.projectMcpToolGrant.findUniqueOrThrow({ where: { id: grant.id } })).updatedAt.toISOString() }, admin, db);
    assert.equal(refreshed.toolDefinitionId, current.id);
    const revoked = await revokeProjectMcpToolGrant(projectId, refreshed.id, { expectedUpdatedAt: refreshed.updatedAt.toISOString() }, admin, db);
    assert.equal(revoked.status, "revoked");
    const audit = await db.projectMcpToolGrantAudit.findFirstOrThrow({ where: { grantId: grant.id } });
    await assert.rejects(() => db.projectMcpToolGrantAudit.update({ where: { id: audit.id }, data: { details: { changed: true } } }));
    assert.deepEqual(requests, ["tools/list", "tools/call", "tools/list"]);
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
