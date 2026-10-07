import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { request as httpRequest } from "node:http";
import test from "node:test";
import { GET as getAuthorizationServerMetadata } from "../src/app/.well-known/oauth-authorization-server/route";
import { GET as getProtectedResourceMetadata } from "../src/app/.well-known/oauth-protected-resource/api/mcp/route";
import { GET as getMcp, POST as postMcp } from "../src/app/api/mcp/route";
import { POST as postOAuthToken } from "../src/app/oauth/token/route";
import { getDb } from "../src/lib/db";
import {
  McpExportGrantError,
  confirmMcpExportApproval,
  listMcpExportDispatchAudits,
  prepareMcpExportApproval,
  revokeMcpExportGrant,
} from "../src/lib/mcp-export-grants";
import {
  bindMcpExportOAuthAuthorizationRequest,
  createMcpExportOAuthAuthorizationRequest,
  decideMcpExportOAuthAuthorization,
  mcpExportOAuthClientAdmissionFingerprint,
  parseMcpExportOAuthAuthorizationParameters,
  parseMcpExportOAuthClientMetadata,
} from "../src/lib/mcp-export-oauth";
import { POSTGRES_GATE_TEST_USER } from "../scripts/postgres-gate-contract";
import { grantProjectMembership, grantWorkspaceMembership } from "../src/lib/membership-governance";

const shouldRun = process.env.MCP_CLIENT_ACCEPTANCE_POSTGRES_GATE === "1";
const operations = ["project_summary", "project_evidence", "project_plan"] as const;
type Operation = typeof operations[number];
type ClientKind = "fetch" | "node-http";
type WireResponse = Readonly<{ status: number; headers: Headers; body: string }>;
type RpcEnvelope = Readonly<{
  result?: Readonly<{
    tools?: readonly Readonly<{ name: string; annotations?: Record<string, unknown> }> [];
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  }>;
}>;
type SimulatedClient = Readonly<{ kind: ClientKind; port: number; protocolVersion: string; name: string }>;

async function readBody(request: IncomingMessage, maximumBytes = 64 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += data.byteLength;
    if (size > maximumBytes) throw new Error("bridge_body_too_large");
    chunks.push(data);
  }
  return Buffer.concat(chunks);
}

async function writeResponse(response: Response, outgoing: ServerResponse): Promise<void> {
  outgoing.statusCode = response.status;
  response.headers.forEach((value, name) => {
    if (!new Set(["connection", "keep-alive", "transfer-encoding"]).has(name.toLowerCase())) {
      outgoing.setHeader(name, value);
    }
  });
  outgoing.end(Buffer.from(await response.arrayBuffer()));
}

function handlerFor(method: string, pathname: string): ((request: Request) => Promise<Response>) | null {
  if (method === "GET" && pathname === "/.well-known/oauth-authorization-server") return getAuthorizationServerMetadata;
  if (method === "GET" && pathname === "/.well-known/oauth-protected-resource/api/mcp") return getProtectedResourceMetadata;
  if (method === "POST" && pathname === "/oauth/token") return postOAuthToken;
  if (method === "GET" && pathname === "/api/mcp") return getMcp;
  if (method === "POST" && pathname === "/api/mcp") return postMcp;
  return null;
}

function createRouteBridge(): Server {
  return createServer(async (incoming, outgoing) => {
    try {
      const headers = new Headers();
      for (const [name, raw] of Object.entries(incoming.headers)) {
        if (raw === undefined) continue;
        headers.set(name, Array.isArray(raw) ? raw.join(", ") : raw);
      }
      const host = headers.get("host");
      if (host === null) {
        outgoing.writeHead(400, { "cache-control": "no-store" });
        outgoing.end();
        return;
      }
      const path = incoming.url ?? "/";
      const requestUrl = new URL(path, `http://${host}`);
      const handler = handlerFor(incoming.method ?? "GET", requestUrl.pathname);
      if (handler === null) {
        outgoing.writeHead(404, { "cache-control": "no-store" });
        outgoing.end();
        return;
      }
      const body = incoming.method === "GET" || incoming.method === "HEAD" ? undefined : await readBody(incoming);
      const request = new Request(requestUrl, {
        method: incoming.method,
        headers,
        ...(body === undefined ? {} : { body: Uint8Array.from(body).buffer }),
      });
      await writeResponse(await handler(request), outgoing);
    } catch {
      if (!outgoing.headersSent) outgoing.writeHead(500, { "cache-control": "no-store" });
      outgoing.end();
    }
  });
}

async function startRouteBridge(): Promise<{ server: Server; port: number }> {
  const server = createRouteBridge();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("MCP_CLIENT_ACCEPTANCE_BRIDGE_ADDRESS_INVALID");
  return { server, port: address.port };
}

async function stopRouteBridge(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function sendAsFetch(client: SimulatedClient, path: string, method = "GET", body?: string, headers: Record<string, string> = {}): Promise<WireResponse> {
  const response = await fetch(`http://localhost:${client.port}${path}`, {
    method,
    headers: { connection: "close", ...headers },
    ...(body === undefined ? {} : { body: new TextEncoder().encode(body) }),
    redirect: "manual",
  });
  return { status: response.status, headers: response.headers, body: await response.text() };
}

async function sendAsNodeHttp(client: SimulatedClient, path: string, method = "GET", body?: string, headers: Record<string, string> = {}): Promise<WireResponse> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: "127.0.0.1",
      port: client.port,
      path,
      method,
      headers: { host: `localhost:${client.port}`, connection: "close", ...headers },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        headers: new Headers(Object.entries(response.headers).flatMap(([name, value]) => {
          if (value === undefined) return [];
          return [[name, Array.isArray(value) ? value.join(", ") : value] as [string, string]];
        })),
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.on("error", reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

function send(client: SimulatedClient, path: string, method = "GET", body?: string, headers: Record<string, string> = {}): Promise<WireResponse> {
  return client.kind === "fetch"
    ? sendAsFetch(client, path, method, body, headers)
    : sendAsNodeHttp(client, path, method, body, headers);
}

function parseJsonRpc(body: string): RpcEnvelope {
  const data = [...body.matchAll(/^data: (.+)$/gmu)].map((match) => match[1]!);
  return JSON.parse(data.at(-1) ?? body) as RpcEnvelope;
}

function modernEnvelope(clientName: string) {
  return {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": { name: clientName, version: "1" },
    "io.modelcontextprotocol/clientCapabilities": {},
  };
}

async function mcpRequest(client: SimulatedClient, accessToken: string | null, method: "tools/list" | "tools/call", operation?: Operation): Promise<WireResponse> {
  const modern = client.protocolVersion === "2026-07-28";
  const id = randomUUID();
  const params = method === "tools/call"
    ? { name: operation, arguments: {}, ...(modern ? { _meta: modernEnvelope(client.name) } : {}) }
    : modern ? { _meta: modernEnvelope(client.name) } : {};
  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "mcp-protocol-version": client.protocolVersion,
    "mcp-method": method,
  };
  if (accessToken !== null) headers.authorization = `Bearer ${accessToken}`;
  if (method === "tools/call" && operation !== undefined) headers["mcp-name"] = operation;
  return send(client, "/api/mcp", "POST", JSON.stringify({ jsonrpc: "2.0", id, method, params }), headers);
}

async function exchangeCode(client: SimulatedClient, input: Readonly<{
  code: string;
  clientId: string;
  redirectUri: string;
  resource: string;
  verifier: string;
}>): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    resource: input.resource,
    code_verifier: input.verifier,
  }).toString();
  const request = () => send(client, "/oauth/token", "POST", body, { "content-type": "application/x-www-form-urlencoded" });
  const response = await request();
  assert.equal(response.status, 200, `${client.name} token exchange must succeed`);
  const token = JSON.parse(response.body) as { access_token?: unknown; token_type?: unknown; expires_in?: unknown; scope?: unknown };
  assert.equal(token.token_type, "Bearer");
  assert.equal(token.scope, "project:read");
  assert.ok(typeof token.expires_in === "number" && token.expires_in > 0 && token.expires_in <= 15 * 60);
  assert.ok(typeof token.access_token === "string" && /^apos_mcp_oauth_[A-Za-z0-9_-]{43}$/u.test(token.access_token), `${client.name} must receive an OAuth bearer`);
  assert.equal((await request()).status, 400, `${client.name} authorization code replay must fail`);
  return token.access_token as string;
}

test("two simulated MCP clients use isolated OAuth grants and one-call Owner approvals over localhost HTTP", {
  skip: !shouldRun ? "MCP_CLIENT_ACCEPTANCE_POSTGRES_GATE=1 is required" : false,
}, async () => {
  const env = process.env as Record<string, string | undefined>;
  const savedEnv = new Map(["NODE_ENV", "AI_PROJECT_OS_MCP_EXPORT_ENABLED", "AI_PROJECT_OS_MCP_EXPORT_OAUTH_ENABLED", "AI_PROJECT_OS_MCP_EXPORT_PUBLIC_ORIGIN"]
    .map((key) => [key, env[key]]));
  env.NODE_ENV = "test";
  env.AI_PROJECT_OS_MCP_EXPORT_ENABLED = "true";
  env.AI_PROJECT_OS_MCP_EXPORT_OAUTH_ENABLED = "true";
  const db = getDb();
  const suffix = randomUUID().slice(0, 8);
  const userId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const actor = { id: userId, role: "user" as const, accountAccessVersion: 1 };
  const admissionFingerprints = new Set<string>();
  let server: Server | null = null;

  try {
    const [session] = await db.$queryRaw<Array<{ current_user: string }>>`SELECT current_user`;
    assert.equal(session?.current_user, POSTGRES_GATE_TEST_USER, "this gate uses its dedicated disposable superuser fixture");
    const bridge = await startRouteBridge();
    server = bridge.server;
    const publicOrigin = `http://localhost:${bridge.port}`;
    env.AI_PROJECT_OS_MCP_EXPORT_PUBLIC_ORIGIN = publicOrigin;
    const clients: readonly SimulatedClient[] = [
      { kind: "fetch", port: bridge.port, protocolVersion: "2025-11-25", name: `simulated-fetch-${suffix}` },
      { kind: "node-http", port: bridge.port, protocolVersion: "2026-07-28", name: `simulated-node-http-${suffix}` },
    ];
    const resourceMetadata = await Promise.all(clients.map(async (client) => {
      const response = await send(client, "/.well-known/oauth-protected-resource/api/mcp");
      assert.equal(response.status, 200, `${client.name} protected-resource metadata`);
      return JSON.parse(response.body) as { resource: string; authorization_servers: string[]; scopes_supported: string[] };
    }));
    assert.deepEqual(resourceMetadata.map((item) => item.resource), [`${publicOrigin}/api/mcp`, `${publicOrigin}/api/mcp`]);
    assert.ok(resourceMetadata.every((item) => item.authorization_servers[0] === publicOrigin && item.scopes_supported.includes("project:read")));
    const wrongHost = await sendAsNodeHttp(clients[1]!, "/.well-known/oauth-protected-resource/api/mcp", "GET", undefined, { host: "attacker.example" });
    assert.equal(wrongHost.status, 403, "route host validation must reject a mismatched Host header");
    const authorizationServerMetadata = await send(clients[1]!, "/.well-known/oauth-authorization-server");
    assert.equal(authorizationServerMetadata.status, 200);
    const authorizationMetadata = JSON.parse(authorizationServerMetadata.body) as { issuer: string; token_endpoint: string; code_challenge_methods_supported: string[] };
    assert.equal(authorizationMetadata.issuer, publicOrigin);
    assert.equal(authorizationMetadata.token_endpoint, `${publicOrigin}/oauth/token`);
    assert.ok(authorizationMetadata.code_challenge_methods_supported.includes("S256"));
    const unauthenticated = await send(clients[0]!, "/api/mcp", "GET");
    assert.equal(unauthenticated.status, 401);
    assert.match(unauthenticated.headers.get("www-authenticate") ?? "", /resource_metadata=/u);

    await db.appUser.create({ data: { id: userId, username: `mcp_client_acceptance_${suffix}`, role: "user" } });
    await db.$transaction(async (tx) => {
      await tx.workspace.create({ data: { id: workspaceId, name: `MCP client acceptance ${suffix}`, slug: `mcp-client-acceptance-${suffix}`, createdById: userId } });
      await grantWorkspaceMembership(tx, { workspaceId, userId, role: "owner", actorId: userId, reason: "mcp_client_acceptance_fixture" });
    });
    const projectName = `Synthetic MCP project ${suffix}`;
    await db.project.create({ data: { id: projectId, workspaceId, name: projectName, slug: `synthetic-mcp-project-${suffix}`, description: "Synthetic empty acceptance fixture" } });
    await db.$transaction(async (tx) => {
      await grantProjectMembership(tx, { projectId, workspaceId, userId, role: "owner", actorId: userId, reason: "mcp_client_acceptance_fixture" });
    });

    const flows = await Promise.all(clients.map(async (client, index) => {
      const clientId = `https://client-${index === 0 ? "a" : "b"}.example/oauth/${suffix}.json`;
      admissionFingerprints.add(mcpExportOAuthClientAdmissionFingerprint(clientId));
      const redirectUri = `http://localhost:${index === 0 ? 49152 : 49153}/oauth/callback`;
      const clientName = `Simulated MCP client ${index === 0 ? "A" : "B"} ${suffix}`;
      const verifier = randomBytes(32).toString("base64url");
      const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
      const parameters = parseMcpExportOAuthAuthorizationParameters(new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: redirectUri,
        state: randomUUID(),
        code_challenge: challenge,
        code_challenge_method: "S256",
        resource: `${publicOrigin}/api/mcp`,
        scope: "project:read",
      }));
      // Contract scope: CIMD is synthetic HTTPS fixture data, injected directly;
      // no client metadata document is fetched and no browser consent is claimed.
      const metadata = parseMcpExportOAuthClientMetadata(clientId, {
        client_id: clientId,
        client_name: clientName,
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code"],
        response_types: ["code"],
      });
      const authorizationRequest = await createMcpExportOAuthAuthorizationRequest(parameters, metadata, db);
      await bindMcpExportOAuthAuthorizationRequest(actor, authorizationRequest.requestId, authorizationRequest.csrfToken, db);
      const decision = await decideMcpExportOAuthAuthorization(actor, {
        requestId: authorizationRequest.requestId,
        csrfToken: authorizationRequest.csrfToken,
        decision: "approve",
        projectId,
      }, db, {
        fetchClientMetadata: async (requestedClientId) => {
          assert.equal(requestedClientId, clientId);
          return metadata;
        },
      });
      assert.ok(decision.code, `${client.name} simulated Owner approval must issue a code`);
      const accessToken = await exchangeCode(client, {
        code: decision.code,
        clientId,
        redirectUri,
        resource: `${publicOrigin}/api/mcp`,
        verifier,
      });
      const grant = await db.mcpExportGrant.findFirstOrThrow({ where: { oauthClientId: clientId }, select: { id: true } });
      return { client, clientId, clientName, grantId: grant.id, accessToken };
    }));
    assert.notEqual(flows[0]!.clientId, flows[1]!.clientId);
    assert.notEqual(flows[0]!.grantId, flows[1]!.grantId);
    assert.notEqual(flows[0]!.accessToken, flows[1]!.accessToken);

    await Promise.all(flows.map(async ({ client, accessToken }) => {
      const response = await mcpRequest(client, accessToken, "tools/list");
      assert.equal(response.status, 200, `${client.name} tools/list over HTTP`);
      const envelope = parseJsonRpc(response.body);
      const tools = envelope.result?.tools ?? [];
      assert.deepEqual(tools.map((item) => item.name).sort(), [...operations].sort());
      for (const item of tools) {
        assert.equal(item.annotations?.readOnlyHint, true);
        assert.equal(item.annotations?.destructiveHint, false);
        assert.equal(item.annotations?.openWorldHint, false);
      }
    }));

    const firstClient = flows[0]!;
    const secondClient = flows[1]!;
    const firstUnapproved = parseJsonRpc((await mcpRequest(firstClient.client, firstClient.accessToken, "tools/call", "project_summary")).body);
    assert.equal(firstUnapproved.result?.isError, true, "a token alone must not approve each read");
    assert.equal(await db.mcpExportDispatchAudit.count({ where: { projectId } }), 0);

    const prepareAndApprove = async (flow: typeof firstClient, operation: Operation) => {
      const prepared = await prepareMcpExportApproval(actor, flow.grantId, {
        provider: flow.client.name,
        model: "synthetic acceptance fixture",
        operation,
      }, db);
      if (operation === "project_evidence") {
        assert.equal(((prepared.content as { evidence: { items: unknown[] } }).evidence.items).length, 0);
      } else if (operation === "project_plan") {
        const plan = (prepared.content as { plan: { objectives: unknown[]; workItems: unknown[] } }).plan;
        assert.equal(plan.objectives.length, 0);
        assert.equal(plan.workItems.length, 0);
      }
      await confirmMcpExportApproval(actor, flow.grantId, {
        approvalId: prepared.approvalId,
        contentFingerprint: prepared.contentFingerprint,
        acknowledge: true,
      }, db);
      return prepared;
    };

    const callApproved = async (flow: typeof firstClient, operation: Operation) => {
      const auditsBeforeCall = await db.mcpExportDispatchAudit.count({ where: { grantId: flow.grantId } });
      const response = await mcpRequest(flow.client, flow.accessToken, "tools/call", operation);
      assert.equal(response.status, 200, `${flow.client.name} ${operation} after approval`);
      const success = parseJsonRpc(response.body);
      assert.ok(success.result, `${flow.client.name} ${operation} must return an MCP result`);
      assert.notEqual(success.result?.isError, true, `${flow.client.name} ${operation} should consume the approval once`);
      const content = success.result?.structuredContent;
      assert.ok(content, `${flow.client.name} ${operation} must return structured content`);
      if (operation === "project_summary") {
        const project = content.project as { id?: string; name?: string } | undefined;
        assert.equal(project?.id, projectId);
        assert.equal(project?.name, projectName);
      } else if (operation === "project_evidence") {
        const evidence = content.evidence as { items?: unknown[]; hasMore?: boolean } | undefined;
        assert.deepEqual(evidence?.items, []);
        assert.equal(evidence?.hasMore, false);
      } else {
        const plan = content.plan as { objectives?: unknown[]; workItems?: unknown[]; objectivesHaveMore?: boolean; workItemsHaveMore?: boolean } | undefined;
        assert.deepEqual(plan?.objectives, []);
        assert.deepEqual(plan?.workItems, []);
        assert.equal(plan?.objectivesHaveMore, false);
        assert.equal(plan?.workItemsHaveMore, false);
      }
      const auditsAfterCall = await db.mcpExportDispatchAudit.count({ where: { grantId: flow.grantId } });
      assert.equal(auditsAfterCall, auditsBeforeCall + 1);
      const replay = parseJsonRpc((await mcpRequest(flow.client, flow.accessToken, "tools/call", operation)).body);
      assert.equal(replay.result?.isError, true, `${flow.client.name} ${operation} approval replay must fail`);
      assert.equal(await db.mcpExportDispatchAudit.count({ where: { grantId: flow.grantId } }), auditsAfterCall);
    };

    const approveAndCall = async (flow: typeof firstClient, operation: Operation) => {
      await prepareAndApprove(flow, operation);
      await callApproved(flow, operation);
    };

    const firstSummaryApproval = await prepareAndApprove(firstClient, "project_summary");
    const aGrantCannotAuthorizeB = await mcpRequest(secondClient.client, secondClient.accessToken, "tools/call", "project_summary");
    assert.equal(parseJsonRpc(aGrantCannotAuthorizeB.body).result?.isError, true, "client A approval must not authorize client B");
    assert.equal(await db.mcpExportDispatchAudit.count({ where: { grantId: firstClient.grantId } }), 0);
    assert.equal(await db.mcpExportDispatchAudit.count({ where: { grantId: secondClient.grantId } }), 0);
    await assert.rejects(() => confirmMcpExportApproval(actor, secondClient.grantId, {
      approvalId: firstSummaryApproval.approvalId,
      contentFingerprint: firstSummaryApproval.contentFingerprint,
      acknowledge: true,
    }, db), (error: unknown) => error instanceof McpExportGrantError && error.code === "MCP_EXPORT_APPROVAL_STALE");
    assert.equal(await db.mcpExportDispatchAudit.count({ where: { grantId: firstClient.grantId } }), 0, "client B cannot consume client A approval");
    await callApproved(firstClient, "project_summary");
    await approveAndCall(firstClient, "project_evidence");
    await approveAndCall(firstClient, "project_plan");
    await approveAndCall(secondClient, "project_summary");
    await approveAndCall(secondClient, "project_evidence");
    await approveAndCall(secondClient, "project_plan");

    assert.equal(await db.mcpExportDispatchAudit.count({ where: { grantId: firstClient.grantId } }), operations.length);
    assert.equal(await db.mcpExportDispatchAudit.count({ where: { grantId: secondClient.grantId } }), operations.length);
    const audits = await listMcpExportDispatchAudits(actor, projectId, db);
    assert.equal(audits.length, operations.length * clients.length);
    assert.deepEqual(audits.map((row) => `${row.oauthClientId}:${row.operation}`).sort(), [
      ...operations.map((operation) => `${firstClient.clientId}:${operation}`),
      ...operations.map((operation) => `${secondClient.clientId}:${operation}`),
    ].sort());
    assert.ok(audits.every((row) => /^[0-9a-f]{64}$/u.test(row.inputFingerprint) && /^[0-9a-f]{64}$/u.test(row.contentFingerprint)));

    assert.equal(await revokeMcpExportGrant(actor, firstClient.grantId, db), true);
    assert.equal(await revokeMcpExportGrant(actor, secondClient.grantId, db), true);
    for (const flow of flows) {
      const revoked = await mcpRequest(flow.client, flow.accessToken, "tools/list");
      assert.equal(revoked.status, 401, `${flow.client.name} must be unauthorized after revoke`);
    }
    assert.equal(await db.mcpExportDispatchAudit.count({ where: { projectId } }), operations.length * clients.length);
  } finally {
    if (server !== null) await stopRouteBridge(server);
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
    await db.$disconnect();
  }
});
