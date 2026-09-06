import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { callMcpToolDetailed } from "../src/lib/mcp/client";
import { sanitizeMcpToolResult } from "../src/lib/mcp/schema";
import { resolveSecureEndpointFingerprint } from "../src/lib/web-sources";

const inputSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

type FakeResponse = Readonly<{
  status: number;
  contentType: string;
  body: string | Buffer;
}> | "reset";

async function runDetailedCase(
  responseFactory: (requestId: string) => FakeResponse,
  options: Readonly<{ expectedFingerprint?: string; outputSchema?: unknown; rejectBoundary?: boolean }> = {},
): Promise<Readonly<{ result: Awaited<ReturnType<typeof callMcpToolDetailed>>; postCount: number; boundaryCount: number }>> {
  let postCount = 0;
  let boundaryCount = 0;
  const server = createServer((request, response) => {
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    postCount += 1;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id: string };
      const fake = responseFactory(body.id);
      if (fake === "reset") {
        response.destroy();
        return;
      }
      response.writeHead(fake.status, { "content-type": fake.contentType }).end(fake.body);
    });
  });
  const port = await listen(server);
  try {
    const endpoint = `http://127.0.0.1:${port}/mcp`;
    const { fingerprint } = await resolveSecureEndpointFingerprint({ url: endpoint, allowPrivateNetwork: true });
    const result = await callMcpToolDetailed({
      endpointUrl: endpoint,
      allowPrivateNetwork: true,
      expectedAddressFingerprint: options.expectedFingerprint ?? fingerprint,
      bearerToken: null,
      rpcRequestId: randomUUID(),
      toolName: "read_safe_value",
      inputSchema,
      outputSchema: options.outputSchema,
      arguments: {},
      onDispatchBoundary: () => {
        boundaryCount += 1;
        return options.rejectBoundary === true ? false : undefined;
      },
    });
    return Object.freeze({ result, postCount, boundaryCount });
  } finally {
    await close(server);
  }
}

function jsonRpcError(id: string): FakeResponse {
  return { status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: "remote failure" } }) };
}

function jsonRpcResult(id: string, result: Record<string, unknown>, status = 200): FakeResponse {
  return { status, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id, result }) };
}

test("detailed MCP dispatch sends one loopback POST with the persisted request id", async () => {
  const requestId = randomUUID();
  let postCount = 0;
  let boundaryCount = 0;
  let seenRequestId: string | undefined;
  const server = createServer((request, response) => {
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    postCount += 1;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id: string };
      seenRequestId = body.id;
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result: { resultType: "complete", content: [{ type: "text", text: "safe result" }] },
      }));
    });
  });
  const port = await listen(server);
  try {
    const endpoint = `http://127.0.0.1:${port}/mcp`;
    const { fingerprint } = await resolveSecureEndpointFingerprint({ url: endpoint, allowPrivateNetwork: true });
    const result = await callMcpToolDetailed({
      endpointUrl: endpoint,
      allowPrivateNetwork: true,
      expectedAddressFingerprint: fingerprint,
      bearerToken: null,
      rpcRequestId: requestId,
      toolName: "read_safe_value",
      inputSchema,
      arguments: {},
      onDispatchBoundary: () => { boundaryCount += 1; },
    });
    assert.equal(result.outcome, "succeeded");
    assert.equal(result.requestId, requestId);
    assert.equal(seenRequestId, requestId);
    assert.equal(boundaryCount, 1);
    assert.equal(postCount, 1);
  } finally {
    await close(server);
  }
});

test("detailed dispatch accepts only a request-scoped SSE response", async () => {
  const requestId = randomUUID();
  let postCount = 0;
  const server = createServer((request, response) => {
    postCount += 1;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id: string };
      response.writeHead(200, { "content-type": "text/event-stream" }).end([
        "event: message",
        `data: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { resultType: "complete", content: [{ type: "text", text: "sse result" }] } })}`,
        "",
      ].join("\n"));
    });
  });
  const port = await listen(server);
  try {
    const endpoint = `http://127.0.0.1:${port}/mcp`;
    const { fingerprint } = await resolveSecureEndpointFingerprint({ url: endpoint, allowPrivateNetwork: true });
    const result = await callMcpToolDetailed({
      endpointUrl: endpoint,
      allowPrivateNetwork: true,
      expectedAddressFingerprint: fingerprint,
      bearerToken: null,
      rpcRequestId: requestId,
      toolName: "read_safe_value",
      inputSchema,
      arguments: {},
      onDispatchBoundary: () => undefined,
    });
    assert.equal(result.outcome, "succeeded");
    assert.equal(postCount, 1);
  } finally {
    await close(server);
  }
});

test("pre-boundary input rejection is deterministic and sends no request", async () => {
  let postCount = 0;
  let boundaryCount = 0;
  const server = createServer((_request, response) => {
    postCount += 1;
    response.writeHead(500).end();
  });
  const port = await listen(server);
  try {
    const endpoint = `http://127.0.0.1:${port}/mcp`;
    const { fingerprint } = await resolveSecureEndpointFingerprint({ url: endpoint, allowPrivateNetwork: true });
    const result = await callMcpToolDetailed({
      endpointUrl: endpoint,
      allowPrivateNetwork: true,
      expectedAddressFingerprint: fingerprint,
      bearerToken: null,
      rpcRequestId: randomUUID(),
      toolName: "read_safe_value",
      inputSchema: { type: "object", properties: { requiredValue: { type: "string" } }, required: ["requiredValue"], additionalProperties: false },
      arguments: {},
      onDispatchBoundary: () => { boundaryCount += 1; },
    });
    assert.equal(result.outcome, "failed");
    assert.equal(boundaryCount, 0);
    assert.equal(postCount, 0);
  } finally {
    await close(server);
  }
});

test("matching JSON-RPC failures are failed after exactly one POST", async () => {
  const cases: readonly [string, (id: string) => FakeResponse, string][] = [
    ["rpc error", jsonRpcError, "MCP_TOOL_CALL_FAILED"],
    ["isError", (id) => jsonRpcResult(id, { resultType: "complete", isError: true, content: [{ type: "text", text: "rejected" }] }), "MCP_TOOL_CALL_FAILED"],
    ["input required", (id) => jsonRpcResult(id, { resultType: "input_required", content: [] }), "MCP_TOOL_INPUT_REQUIRED_UNSUPPORTED"],
  ];
  for (const [name, responseFactory, errorCode] of cases) {
    const run = await runDetailedCase(responseFactory);
    assert.equal(run.result.outcome, "failed", name);
    assert.equal(run.result.safeErrorCode, errorCode, name);
    assert.equal(run.postCount, 1, name);
    assert.equal(run.boundaryCount, 1, name);
  }
});

test("output schema rejection is failed and never retried", async () => {
  const outputSchema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false };
  const run = await runDetailedCase((id) => jsonRpcResult(id, {
    resultType: "complete",
    content: [],
    structuredContent: { wrong: true },
  }), { outputSchema });
  assert.equal(run.result.outcome, "failed");
  assert.equal(run.result.safeErrorCode, "MCP_TOOL_OUTPUT_INVALID");
  assert.equal(run.postCount, 1);
  assert.equal(run.boundaryCount, 1);
});

test("missing structured output is rejected when an output schema is attested", async () => {
  const outputSchema = { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } }, additionalProperties: false };
  const run = await runDetailedCase((id) => jsonRpcResult(id, {
    resultType: "complete",
    content: [],
  }), { outputSchema });
  assert.equal(run.result.outcome, "failed");
  assert.equal(run.result.safeErrorCode, "MCP_TOOL_OUTPUT_INVALID");
  assert.equal(run.postCount, 1);
  assert.equal(run.boundaryCount, 1);
});

test("boundary callback rejection is pre-send failed and creates no POST", async () => {
  let postCount = 0;
  let boundaryCount = 0;
  const server = createServer((_request, response) => {
    postCount += 1;
    response.writeHead(500).end();
  });
  const port = await listen(server);
  try {
    const endpoint = `http://127.0.0.1:${port}/mcp`;
    const { fingerprint } = await resolveSecureEndpointFingerprint({ url: endpoint, allowPrivateNetwork: true });
    const result = await callMcpToolDetailed({
      endpointUrl: endpoint,
      allowPrivateNetwork: true,
      expectedAddressFingerprint: fingerprint,
      bearerToken: null,
      rpcRequestId: randomUUID(),
      toolName: "read_safe_value",
      inputSchema,
      arguments: {},
      onDispatchBoundary: () => {
        boundaryCount += 1;
        throw new Error("DB boundary rejected");
      },
    });
    assert.equal(result.outcome, "failed");
    assert.equal(boundaryCount, 1);
    assert.equal(postCount, 0);
  } finally {
    await close(server);
  }
});

test("DB-owned stale boundary rejection is unknown and creates no POST", async () => {
  const run = await runDetailedCase((id) => jsonRpcError(id), { rejectBoundary: true });
  assert.equal(run.result.outcome, "unknown");
  assert.equal(run.result.safeErrorCode, "MCP_DISPATCH_RESERVATION_STALE");
  assert.equal(run.boundaryCount, 1);
  assert.equal(run.postCount, 0);
});

test("post-boundary transport ambiguity is unknown with no retry", async () => {
  const cases: readonly [string, (id: string) => FakeResponse][] = [
    ["3xx", (id) => ({ status: 302, contentType: "application/json", body: JSON.stringify({ redirect: true, id }) })],
    ["4xx without matching RPC error", (id) => ({ status: 400, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: `wrong-${id}`, result: {} }) })],
    ["5xx without matching RPC error", () => ({ status: 500, contentType: "application/json", body: JSON.stringify({ message: "server failed" }) })],
    ["wrong JSON-RPC id", (id) => ({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: `wrong-${id}`, result: { resultType: "complete", content: [] } }) })],
    ["malformed JSON", () => ({ status: 200, contentType: "application/json", body: "{malformed" })],
    ["malformed SSE", () => ({ status: 200, contentType: "text/event-stream", body: "data: not-json\n\n" })],
    ["request-scoped SSE id mismatch", (id) => ({ status: 200, contentType: "text/event-stream", body: `data: ${JSON.stringify({ jsonrpc: "2.0", id: `wrong-${id}`, result: { resultType: "complete", content: [] } })}\n\n` })],
    ["connection reset", () => "reset"],
    ["oversized body", () => ({ status: 200, contentType: "application/json", body: Buffer.alloc(512 * 1024 + 1, 0x78) })],
  ];
  for (const [name, responseFactory] of cases) {
    const run = await runDetailedCase(responseFactory);
    assert.equal(run.result.outcome, "unknown", name);
    assert.equal(run.postCount, 1, name);
    assert.equal(run.boundaryCount, 1, name);
  }
});

test("pre-boundary network fingerprint mismatch sends no request", async () => {
  const run = await runDetailedCase((id) => jsonRpcError(id), { expectedFingerprint: "0".repeat(64) });
  assert.equal(run.result.outcome, "failed");
  assert.equal(run.result.safeErrorCode, "WEB_SOURCE_NETWORK_CHANGED");
  assert.equal(run.postCount, 0);
  assert.equal(run.boundaryCount, 0);
});

test("successful output is bounded and sanitizes sensitive keys and text", async () => {
  const run = await runDetailedCase((id) => jsonRpcResult(id, {
    resultType: "complete",
    content: [{ type: "text", text: "authorization: top-secret; bearer=hidden-token; Authorization: Bearer standalone-marker; Authorization=Bearer equals-bearer-marker; Authorization: Basic basic-marker; access_token: Bearer access-bearer-marker; Bearer standalone-token; access_key=access-marker; access token: access-token-marker; refresh_key=refresh-marker; refresh token: refresh-token-marker; client_secret=client-secret-marker; client key: client-key-marker; Authorization: Bearer \"quoted-authorization-marker with space\"; Bearer \"quoted-standalone-marker nested\"; token: \"quoted-token-marker with space\"\nAuthorization: Bearer \"unclosed-authorization-marker with space\nAuthorization: Basic 'unclosed-basic-marker with space\naccess_token=\"unclosed-token-marker with space" }],
    structuredContent: {
      apiKey: "secret-key",
      access_token: "access-structured-marker",
      refreshToken: "refresh-structured-marker",
      client_secret: "client-structured-marker",
      nested: { authorization: "Bearer hidden-marker", safe: "visible" },
    },
  }));
  assert.equal(run.result.outcome, "succeeded");
  assert.equal(run.postCount, 1);
  assert.equal(run.boundaryCount, 1);
  assert.ok(run.result.result);
  assert.match(run.result.result.text ?? "", /\[REDACTED\]/u);
  assert.doesNotMatch(run.result.result.text ?? "", /top-secret|hidden-token|standalone-marker|equals-bearer-marker|basic-marker|access-bearer-marker|standalone-token|access-marker|access-token-marker|refresh-marker|refresh-token-marker|client-secret-marker|client-key-marker|quoted-authorization-marker|quoted-standalone-marker|quoted-token-marker|unclosed-authorization-marker|unclosed-basic-marker|unclosed-token-marker|with space|nested/u);
  const structuredContent = run.result.result.structuredContent;
  assert.equal(structuredContent !== null && typeof structuredContent === "object" && !Array.isArray(structuredContent) && "apiKey" in structuredContent, false);
  assert.deepEqual(run.result.result.structuredContent, { nested: { safe: "visible" } });
  // The first credential-shaped text prefix consumes the remaining text
  // fail-closed; the five structured credential keys are omitted separately.
  assert.equal(run.result.result.omittedContentCount, 6);
});

test("sensitive text sanitization never treats punctuation as a safe credential boundary", () => {
  const cases = [
    "Authorization: Bearer, VERY_SECRET_TOKEN",
    "Authorization: Bearer; VERY_SECRET_TOKEN",
    "Authorization: Bearer] VERY_SECRET_TOKEN",
    "Authorization: Bearer} VERY_SECRET_TOKEN",
    'Authorization: Bearer" VERY_SECRET_TOKEN',
    "Authorization: Bearer: VERY_SECRET_TOKEN",
    "Authorization: Basic, VERY_SECRET_TOKEN",
    "access_token: Bearer, VERY_SECRET_TOKEN",
    "Authorization\r\n: VERY_SECRET_TOKEN",
    "Authorization\n: VERY_SECRET_TOKEN",
    "Authorization\u0085: VERY_SECRET_TOKEN",
    "Authorization：VERY_SECRET_TOKEN",
    "Authorization\u200b: VERY_SECRET_TOKEN",
    String.raw`\u0041uthorization\u003a VERY_SECRET_TOKEN`,
    String.raw`\u{0041}uthorization: VERY_SECRET_TOKEN`,
    String.raw`\x41uthorization: VERY_SECRET_TOKEN`,
    "&#65;uthorization: VERY_SECRET_TOKEN",
    "A\u200duthorization: VERY_SECRET_TOKEN",
    "Auth\u200borization: VERY_SECRET_TOKEN",
    "access\u200b_token: VERY_SECRET_TOKEN",
    "A\u0301uthorization: VERY_SECRET_TOKEN",
    "%41uthorization: VERY_SECRET_TOKEN",
    "Auth<!--x-->orization: VERY_SECRET_TOKEN",
    "Auth<b>x</b>orization: VERY_SECRET_TOKEN",
    "Au<span><i>x</i></span>thorization: VERY_SECRET_TOKEN",
  ];

  for (const entry of cases) {
    const sanitized = sanitizeMcpToolResult({ text: entry, structuredContent: null, omittedContentCount: 0 });
    const payload = sanitized.payload as { text: string };
    assert.match(payload.text, /\[REDACTED\]/u, entry);
    assert.doesNotMatch(payload.text, /VERY_SECRET_TOKEN/u, entry);
    assert.equal(sanitized.omittedContentCount, 1, entry);
  }
});

test("structured output omits credential keys hidden by escapes and format characters", () => {
  const cases: readonly [string, string][] = [
    [String.raw`\u{0041}uthorization`, "escaped-braced-marker"],
    [String.raw`\x41uthorization`, "escaped-hex-marker"],
    ["&#65;uthorization", "html-entity-marker"],
    ["A\u200duthorization", "joiner-marker"],
    ["Auth\u200borization", "zero-width-marker"],
    ["%41uthorization", "percent-marker"],
    ["%u0041ccess_key", "percent-unicode-access-marker"],
    ["%U0041pi_key", "percent-unicode-api-marker"],
    ["%u{0052}efresh_key", "percent-braced-unicode-marker"],
    ["％u0041ccess_key", "fullwidth-percent-unicode-marker"],
    ["＼u0041ccess_key", "fullwidth-backslash-unicode-marker"],
    ["＆#65;ccess_key", "fullwidth-ampersand-entity-marker"],
    ["﹪u0041ccess_key", "small-percent-unicode-marker"],
    ["﹨u0041ccess_key", "small-backslash-unicode-marker"],
    ["﹠#65;ccess_key", "small-ampersand-entity-marker"],
    ["Auth<!--x-->orization", "html-comment-marker"],
    ["Auth<b>x</b>orization", "html-element-marker"],
    ["Au<span><i>x</i></span>thorization", "nested-html-marker"],
  ];

  for (const [key, marker] of cases) {
    const sanitized = sanitizeMcpToolResult({
      text: null,
      structuredContent: { safe: "visible", [key]: marker },
      omittedContentCount: 0,
    });
    const payload = sanitized.payload as { structuredContent: Record<string, unknown> };
    assert.deepEqual(payload.structuredContent, { safe: "visible" }, key);
    assert.doesNotMatch(JSON.stringify(payload), new RegExp(marker, "u"), key);
    assert.equal(sanitized.omittedContentCount, 1, key);
  }
});

test("sensitive text sanitization fails closed for escaped and malformed quotes", () => {
  const cases = [
    "Authorization: Bearer \"MARKER_DANGLING_DOUBLE" + "\\",
    "Authorization: Basic 'MARKER_DANGLING_SINGLE" + "\\",
    "access_token=\"MARKER_DANGLING_ACCESS" + "\\",
    "Authorization: Bearer \"MARKER_BARE_CR\r",
    "Authorization: Bearer \"MARKER_CR_NEXT\rnext",
    "Authorization: Bearer \"MARKER_DANGLING_CR" + "\\\r",
    String.raw`{\"Authorization\":\"MARKER_ESCAPED_JSON\"}`,
    String.raw`access_token\": \"MARKER_ESCAPED_ACCESS\"`,
    String.raw`Authorization: Bearer \"MARKER_ESCAPED_OPEN\"`,
    String.raw`{\\"Authorization\\":\\"MARKER_DOUBLE_ESCAPED_JSON\\"}`,
    String.raw`Authorization: Bearer \\"MARKER_DOUBLE_ESCAPED_OPEN\\"`,
    String.raw`{\u0022Authorization\u0022:\u0022MARKER_UNICODE_QUOTE\u0022}`,
    String.raw`{\u0041uthorization\u0022:\u0022MARKER_UNICODE_KEY\u0022}`,
    String.raw`{\u0022access\u005ftoken\u0022:\u0022Bearer MARKER_UNICODE_ACCESS_KEY\u0022}`,
    String.raw`Authorization:\u0009Bearer MARKER_UNICODE_TAB`,
    String.raw`Authorization:\u000aBearer MARKER_UNICODE_LF`,
    String.raw`Authorization:\nBearer MARKER_JSON_LF`,
    String.raw`access_token=\tMARKER_JSON_TAB`,
    "Authorization: Bearer \"" + "\\" + "\rMARKER_AFTER_CR",
    "Authorization: Bearer \"" + "\\" + "\nMARKER_AFTER_LF",
    "Authorization: Bearer \"" + "\\" + "\r\nMARKER_AFTER_CRLF",
    "Authorization: Bearer\r\n MARKER_FOLDED_EMPTY",
    "Authorization: Bearer MARKER_FOLDED_HEAD\r\n\tMARKER_FOLDED_TAIL",
    "access_token: Bearer \rMARKER_ACCESS_FOLDED",
  ];

  for (const entry of cases) {
    const sanitized = sanitizeMcpToolResult({ text: entry, structuredContent: null, omittedContentCount: 0 });
    const payload = sanitized.payload as { text: string };
    assert.match(payload.text, /\[REDACTED\]/u, entry);
    assert.doesNotMatch(payload.text, /MARKER_/u, entry);
    assert.equal(sanitized.omittedContentCount, 1, entry);
  }
});

test("sanitized result metrics count the persisted wrapper exactly", () => {
  const prototypePayload = JSON.parse('{"__proto__":{"safe":"prototype-marker"}}') as Record<string, unknown>;
  const cases = [
    { structuredContent: null, expectedNodes: 4, expectedDepth: 1 },
    { structuredContent: {}, expectedNodes: 4, expectedDepth: 1 },
    { structuredContent: { ok: true }, expectedNodes: 5, expectedDepth: 2 },
    { structuredContent: [null, true], expectedNodes: 6, expectedDepth: 2 },
    { structuredContent: Array.from({ length: 252 }, () => null), expectedNodes: 256, expectedDepth: 2 },
    { structuredContent: prototypePayload, expectedNodes: 4, expectedDepth: 1 },
  ] as const;
  for (const entry of cases) {
    const result = sanitizeMcpToolResult({ text: null, structuredContent: entry.structuredContent, omittedContentCount: 0 });
    assert.equal(result.resultNodes, entry.expectedNodes);
    assert.equal(result.resultDepth, entry.expectedDepth);
    assert.doesNotMatch(JSON.stringify(result.payload), /prototype-marker/u);
  }
  assert.throws(
    () => sanitizeMcpToolResult({ text: null, structuredContent: Array.from({ length: 253 }, () => null), omittedContentCount: 0 }),
    /MCP_RESPONSE_TOO_LARGE/u,
  );
});

test("depth, node, and total-byte limits become unknown after the boundary", async () => {
  let deep: unknown = { leaf: "x" };
  for (let index = 0; index < 10; index += 1) deep = { nested: deep };
  const cases: readonly [string, unknown][] = [
    ["depth", deep],
    ["nodes", Array.from({ length: 257 }, () => "x")],
  ];
  for (const [name, structuredContent] of cases) {
    const run = await runDetailedCase((id) => jsonRpcResult(id, { resultType: "complete", content: [], structuredContent }));
    assert.equal(run.result.outcome, "unknown", name);
    assert.equal(run.postCount, 1, name);
    assert.equal(run.boundaryCount, 1, name);
  }
  const bytes = await runDetailedCase((id) => jsonRpcResult(id, { resultType: "complete", content: [{ type: "text", text: "x".repeat(65536) }] }));
  assert.equal(bytes.result.outcome, "unknown");
  assert.equal(bytes.postCount, 1);
  assert.equal(bytes.boundaryCount, 1);
});

test("dispatch runtime stays isolated from public routes, the legacy worker, and write paths", async () => {
  const [service, worker, route, apiGate, schema, migration] = await Promise.all([
    readFile("src/lib/project-mcp-action-dispatch-service.ts", "utf8"),
    readFile("scripts/automation-worker.ts", "utf8"),
    readFile("src/app/api/projects/[projectId]/mcp-actions/[actionId]/dispatch/route.ts", "utf8"),
    readFile("src/lib/project-mcp-action-api-gate.ts", "utf8"),
    readFile("prisma/schema.prisma", "utf8"),
    readFile("prisma/migrations/20260904220000_add_project_mcp_action_dispatch_runtime/migration.sql", "utf8"),
  ]);
  assert.doesNotMatch(service, /ProjectAction|action-engine|child_process|stdio|writeTool|executeMcpActionSnapshot/u);
  assert.doesNotMatch(worker, /callMcpTool|securePinnedHttpRequest|readCredentialSecret/u);
  assert.match(route, /projectMcpActionApiUnavailable/u);
  assert.doesNotMatch(route, /dispatchProjectMcpAction|requireApiSession|readJsonBody|assertSameOrigin/u);
  assert.match(apiGate, /PROJECT_MCP_ACTION_API_UNAVAILABLE/u);
  assert.match(apiGate, /status: 404/u);
  assert.match(apiGate, /cache-control": "no-store/u);
  assert.match(service, /reservationTokenHash/u);
  assert.match(service, /rpcRequestId/u);
  assert.match(schema, /ProjectMcpActionRuntimeLedger/u);
  assert.doesNotMatch(migration, /ai_project_os\.mcp_dispatch_recovery|current_setting\(|set_config\(/u);
});

test("legacy generic MCP results stay hidden, uncached, and non-importable", async () => {
  const [engine, intake, actionsRoute, decisionRoute, cancelRoute, intakeRoute, actionsClient] = await Promise.all([
    readFile("src/lib/action-engine.ts", "utf8"),
    readFile("src/lib/action-result-intake.ts", "utf8"),
    readFile("src/app/api/projects/[projectId]/actions/route.ts", "utf8"),
    readFile("src/app/api/projects/[projectId]/actions/[actionId]/decision/route.ts", "utf8"),
    readFile("src/app/api/projects/[projectId]/actions/[actionId]/route.ts", "utf8"),
    readFile("src/app/api/projects/[projectId]/actions/[actionId]/result-import/route.ts", "utf8"),
    readFile("src/app/projects/[projectId]/actions/project-actions-client.tsx", "utf8"),
  ]);
  assert.match(engine, /function publicProjectAction[\s\S]*input: \{\},[\s\S]*result: null,[\s\S]*resultImport: null/u);
  assert.match(engine, /action\.capability === "project\.mcp\.read-tool\.invoke"\) return fail\("ACTION_POLICY_DENIED"\)/u);
  assert.match(engine, /importableActions: \[\]/u);
  assert.match(engine, /canImportResults: false/u);
  assert.match(intake, /if \(!projectActionResultIntakeEnabled\(\)\) return fail\("ACTION_RESULT_INTAKE_NOT_IMPORTABLE"\)/u);
  assert.match(actionsRoute, /cache-control.*no-store/u);
  assert.match(decisionRoute, /cache-control.*no-store/u);
  assert.match(cancelRoute, /cache-control.*no-store/u);
  assert.match(intakeRoute, /cache-control.*no-store/u);
  assert.doesNotMatch(actionsClient, /result-import|MCP 结果纳入项目资料/u);
  assert.match(actionsClient, /project\.mcp\.read-tool\.invoke" \? \(\["denied"\]/u);
  assert.match(actionsClient, /查看 MCP 开放状态/u);
  assert.doesNotMatch(actionsClient, /选择已授权工具/u);
});

test("legacy MCP source quarantine fails closed for derived content and covers material reads", async () => {
  const [migration, helper, assetService, assetVision, projectExport, materialSearch, materialGrant, materialIndex, repositorySnapshot, repositoryStatus, materialSync] = await Promise.all([
    readFile("prisma/migrations/20260904230000_quarantine_legacy_mcp_sources/migration.sql", "utf8"),
    readFile("src/lib/legacy-mcp-source-quarantine.ts", "utf8"),
    readFile("src/lib/project-assets/service.ts", "utf8"),
    readFile("src/lib/project-assets/vision.ts", "utf8"),
    readFile("src/lib/project-export.ts", "utf8"),
    readFile("src/lib/github/project-repository-search.ts", "utf8"),
    readFile("src/lib/github/repository-material-model-grant.ts", "utf8"),
    readFile("src/lib/github/repository-material-index.ts", "utf8"),
    readFile("src/lib/github/repository-rag-snapshot.ts", "utf8"),
    readFile("src/lib/github/project-repository-status.ts", "utf8"),
    readFile("src/lib/github/material-sync-service.ts", "utf8"),
  ]);
  assert.match(migration, /LEGACY_MCP_PROJECT_ASSET_SEGMENT_PREFLIGHT_FAILED/u);
  assert.match(migration, /LEGACY_MCP_REPOSITORY_MATERIAL_PREFLIGHT_FAILED/u);
  assert.match(migration, /FROM "GitHubSourceVersion" AS source_version[\s\S]*source\."kind"::text = 'mcp'/u);
  assert.match(migration, /BEFORE INSERT OR UPDATE ON "RepositoryMaterialGenerationEntry"/u);
  assert.match(migration, /BEFORE INSERT OR UPDATE ON "RepositoryMaterialIndexInput"/u);
  assert.match(migration, /BEFORE INSERT OR UPDATE ON "ProjectGitRepositoryManualRunEntry"/u);
  assert.doesNotMatch(migration, /AS grant\b/u);
  assert.match(helper, /nonLegacyMcpProjectAssetSegmentWhere/u);
  assert.match(assetService, /segments: \{\s*where: nonLegacyMcpProjectAssetSegmentWhere/u);
  assert.match(assetVision, /segments: \{ where: nonLegacyMcpProjectAssetSegmentWhere/u);
  assert.match(projectExport, /segments: \{\s*where: nonLegacyMcpProjectAssetSegmentWhere/u);
  assert.match(materialSearch, /source\."kind"::text <> 'mcp'[\s\S]*source\."retiredAt" IS NULL/u);
  assert.match(materialGrant, /source\.kind === "mcp" \|\|[\s\S]*source\.retiredAt !== null/u);
  assert.match(materialIndex, /source\.kind === "mcp" \|\|[\s\S]*source\.retiredAt !== null/u);
  assert.match(materialIndex, /await revalidateClaimBeforeEgress\(claim\);/u);
  assert.match(repositorySnapshot, /entry\.sourceVersion\.projectSource\.kind === "mcp" \|\|[\s\S]*entry\.sourceVersion\.projectSource\.retiredAt !== null/u);
  assert.match(repositoryStatus, /material_source\."kind"::text = 'mcp'[\s\S]*material_source\."retiredAt" IS NOT NULL/u);
  assert.match(migration, /CREATE OR REPLACE FUNCTION "repository_rag_snapshot_is_current"[\s\S]*source\."kind"::text = 'mcp'[\s\S]*source\."retiredAt" IS NOT NULL/u);
  assert.match(materialSync, /existing\.projectSource\.kind === "mcp" \|\|[\s\S]*existing\.projectSource\.retiredAt !== null/u);
});
