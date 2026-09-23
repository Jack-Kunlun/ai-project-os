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
  executeMcpConnectionMutation,
  executeMcpActionSnapshot,
  getProjectMcpToolCenter,
  grantProjectMcpTool,
  probeMcpConnectionDraft,
  previewMcpConnectionMutation,
} from "../src/lib/mcp";

const shouldRun = process.env.MCP_CAPABILITIES_POSTGRES_GATE === "1";

type GovernanceActor = Readonly<{ id: string; accountAccessVersion?: number }>;

function compactRequestKey(prefix: string, suffix: string): string {
  const key = `${prefix}-${suffix}`;
  assert.ok(key.length < 40, `request key must stay below 40 characters: ${key}`);
  return key;
}

async function governMcpMutation(
  connectionId: string,
  current: Readonly<{ updatedAt: Date }>,
  action: "rotateCredential" | "retrust" | "rediscover" | "disable" | "enable" | "delete",
  requestKey: string,
  reason: string,
  actor: GovernanceActor,
  db: ReturnType<typeof getDb>,
  options: Readonly<{ secret?: string; confirmationName?: string }> = {},
) {
  const preview = await previewMcpConnectionMutation(connectionId, {
    action,
    requestKey,
    reason,
    expectedUpdatedAt: current.updatedAt.toISOString(),
    ...(options.secret === undefined ? {} : { secret: options.secret }),
    ...(options.confirmationName === undefined ? {} : { confirmationName: options.confirmationName }),
  }, actor, db);
  const result = await executeMcpConnectionMutation(connectionId, {
    previewId: preview.id,
    requestKey: preview.requestKey,
    requestFingerprint: preview.requestFingerprint,
    impactFingerprint: preview.impactFingerprint,
    expectedUpdatedAt: preview.connection.updatedAt,
    ...(options.secret === undefined ? {} : { secret: options.secret }),
    ...(options.confirmationName === undefined ? {} : { confirmationName: options.confirmationName }),
  }, actor, db);
  return { preview, result };
}

async function cleanupMcpConnection(connectionId: string, actor: GovernanceActor, suffix: string, db: ReturnType<typeof getDb>): Promise<void> {
  let current = await db.mcpConnection.findUnique({ where: { id: connectionId }, select: { id: true, name: true, status: true, updatedAt: true } });
  if (current === null) return;
  if (current.status !== "disabled") {
    await governMcpMutation(connectionId, current, "disable", compactRequestKey("m-cln-x", suffix), "test fixture cleanup", actor, db);
    current = await db.mcpConnection.findUnique({ where: { id: connectionId }, select: { id: true, name: true, status: true, updatedAt: true } });
  }
  if (current === null) return;
  const deletion = await previewMcpConnectionMutation(connectionId, {
    action: "delete",
    requestKey: compactRequestKey("m-cln-d", suffix),
    reason: "test fixture cleanup",
    expectedUpdatedAt: current.updatedAt.toISOString(),
    confirmationName: current.name,
  }, actor, db);
  if (!deletion.canExecute) return;
  await executeMcpConnectionMutation(connectionId, {
    previewId: deletion.id,
    requestKey: deletion.requestKey,
    requestFingerprint: deletion.requestFingerprint,
    impactFingerprint: deletion.impactFingerprint,
    expectedUpdatedAt: deletion.connection.updatedAt,
    confirmationName: current.name,
  }, actor, db);
}

test("MCP personal rediscovery stays held while project runtime is fail-closed", { skip: !shouldRun ? "MCP_CAPABILITIES_POSTGRES_GATE=1 is required" : false }, async () => {
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
      if (body.method === "initialize") {
        response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2026-07-28", capabilities: {}, serverInfo: { name: "fixture", version: "1" } } }));
        return;
      }
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
    { id: editorId, username: `mcp_editor_${suffix}`, role: "user" },
  ] });
  await db.$transaction(async (tx) => {
    await tx.workspace.create({ data: { id: workspaceId, name: `MCP ${suffix}`, slug: `mcp-${suffix}`, createdById: adminId } });
    await grantWorkspaceMembership(tx, { workspaceId, userId: adminId, role: "owner", actorId: adminId, reason: "mcp_capabilities_fixture" });
  });
  await db.project.create({ data: { id: projectId, workspaceId, name: `MCP project ${suffix}`, slug: `mcp-project-${suffix}` } });
  await db.$transaction(async (tx) => {
    await grantProjectMembership(tx, { projectId, workspaceId, userId: adminId, role: "owner", actorId: adminId, reason: "mcp_capabilities_fixture" });
    await grantProjectMembership(tx, { projectId, workspaceId, userId: editorId, role: "editor", actorId: adminId, reason: "mcp_capabilities_fixture" });
  });

  try {
    const connectionName = `MCP ${suffix}`;
    const endpointUrl = `http://127.0.0.1:${serverPort}/mcp`;
    const createRequestKey = randomUUID();
    const probe = await probeMcpConnectionDraft({ name: connectionName, endpointUrl, authKind: "bearer", bearerToken: token, allowPrivateNetwork: true, clientRequestKey: createRequestKey }, admin, db);
    assert.equal(probe.status, "settled");
    assert.equal(probe.safeErrorCode, null);
    assert.ok(probe.draftProbeId);
    const connection = await createMcpConnection({
      name: connectionName,
      endpointUrl,
      authKind: "bearer",
      bearerToken: token,
      allowPrivateNetwork: true,
      draftProbeId: probe.draftProbeId,
      createRequestKey,
    }, admin, db);
    connectionId = connection.id;
    credentialId = (await db.mcpConnection.findUniqueOrThrow({ where: { id: connection.id }, select: { credentialId: true } })).credentialId;
    assert.deepEqual(requests, ["initialize", "tools/list"]);
    await assert.rejects(
      () => previewMcpConnectionMutation(connection.id, {
        action: "enable",
        requestKey: compactRequestKey("m-stale-en", suffix),
        reason: "stale CAS must fail",
        expectedUpdatedAt: new Date(0).toISOString(),
      }, admin, db),
      (error: unknown) => error instanceof McpCapabilityError && error.code === "MCP_CONNECTION_CONFLICT",
    );
    await assert.rejects(
      () => db.mcpConnection.update({ where: { id: connection.id }, data: { endpointUrl: `https://direct-write.example.test/${suffix}` } }),
      (error: unknown) => error instanceof Error && error.message.includes("security fields require governance context"),
    );
    await assert.rejects(
      () => db.mcpConnection.delete({ where: { id: connection.id } }),
      (error: unknown) => error instanceof Error && error.message.includes("delete requires governance context"),
    );
    const beforeRotation = await db.mcpConnection.findUniqueOrThrow({ where: { id: connection.id } });
    const rotatedToken = `mcp-rotated-token-${suffix}`;
    const rotation = await governMcpMutation(
      connection.id,
      beforeRotation,
      "rotateCredential",
      compactRequestKey("m-rot", suffix),
      "rotate MCP credential through governed preview",
      admin,
      db,
      { secret: rotatedToken },
    );
    assert.equal(rotation.preview.canExecute, true);
    assert.equal(rotation.result.status, "completed");
    let current = await db.mcpConnection.findUniqueOrThrow({ where: { id: connection.id } });
    assert.equal(current.status, "configured");
    assert.equal(current.configurationRevision, beforeRotation.configurationRevision + 1);
    assert.notEqual(current.credentialFingerprint, beforeRotation.credentialFingerprint);
    assert.equal(current.protocolVersion, null);
    assert.equal(current.catalogFingerprint, null);
    assert.equal(current.lastDiscoveredAt, null);

    const disable = await governMcpMutation(
      connection.id,
      current,
      "disable",
      compactRequestKey("m-dis", suffix),
      "disable MCP connection through governed preview",
      admin,
      db,
    );
    assert.equal(disable.preview.canExecute, true);
    assert.equal(disable.result.status, "completed");
    current = await db.mcpConnection.findUniqueOrThrow({ where: { id: connection.id } });
    assert.equal(current.status, "disabled");
    assert.equal(current.configurationRevision, beforeRotation.configurationRevision + 2);
    const disabledRediscover = await previewMcpConnectionMutation(connection.id, {
      action: "rediscover",
      requestKey: compactRequestKey("m-dis-redisc", suffix),
      reason: "disabled connection cannot rediscover",
      expectedUpdatedAt: current.updatedAt.toISOString(),
    }, admin, db);
    assert.equal(disabledRediscover.canExecute, false);
    assert.equal(disabledRediscover.blockers.includes("connection_disabled"), true);
    assert.equal(disabledRediscover.blockers.includes("external_io_planned_not_dispatched"), true);

    const enable = await governMcpMutation(
      connection.id,
      current,
      "enable",
      compactRequestKey("m-en", suffix),
      "enable MCP connection through governed preview",
      admin,
      db,
    );
    assert.equal(enable.preview.canExecute, true);
    assert.equal(enable.result.status, "completed");
    current = await db.mcpConnection.findUniqueOrThrow({ where: { id: connection.id } });
    assert.equal(current.status, "configured");
    const rediscover = await previewMcpConnectionMutation(connection.id, {
      action: "rediscover",
      requestKey: compactRequestKey("m-redisc", suffix),
      reason: "rediscovery is held until external dispatch is implemented",
      expectedUpdatedAt: current.updatedAt.toISOString(),
    }, admin, db);
    assert.equal(rediscover.canExecute, false);
    assert.equal(rediscover.blockers.includes("external_io_planned_not_dispatched"), true);
    assert.deepEqual(requests, ["initialize", "tools/list"]);
    await assert.rejects(
      () => getProjectMcpToolCenter(projectId, admin, db),
      (error: unknown) => error instanceof McpCapabilityError && error.code === "MCP_LEGACY_PROJECT_RUNTIME_FROZEN",
    );
    await assert.rejects(
      () => grantProjectMcpTool(projectId, { toolDefinitionId: randomUUID(), acknowledgeReadOnly: true, expectedUpdatedAt: null }, admin, db),
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
        toolDefinitionId: randomUUID(),
        attestationId: randomUUID(),
        toolDefinitionFingerprint: "a".repeat(64),
        networkFingerprint: "b".repeat(64),
        credentialFingerprint: "c".repeat(64),
        arguments: { query: "release", revision: 1 },
      }, db),
      (error: unknown) => error instanceof McpCapabilityError && error.code === "MCP_LEGACY_PROJECT_RUNTIME_FROZEN",
    );
  } finally {
    await db.project.deleteMany({ where: { id: projectId } });
    if (connectionId !== null) await cleanupMcpConnection(connectionId, admin, suffix, db);
    if (credentialId !== null) await db.externalCredential.deleteMany({ where: { id: credentialId } });
    await db.workspace.deleteMany({ where: { id: workspaceId } });
    // Immutable governance previews/audits retain actor FKs; the disposable gate runner drops this database.
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (previousKeyFile === undefined) delete process.env.AI_PROJECT_OS_MASTER_KEY_FILE;
    else process.env.AI_PROJECT_OS_MASTER_KEY_FILE = previousKeyFile;
    await rm(keyDirectory, { recursive: true, force: true });
  }
});
