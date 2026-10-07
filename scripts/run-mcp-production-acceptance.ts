import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type ClientRequest, type Server, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { createInterface } from "node:readline";
import clientAMetadata from "../test/fixtures/mcp-production-clients/client-a.json";
import clientBMetadata from "../test/fixtures/mcp-production-clients/client-b.json";

const PRODUCTION_ORIGIN = "https://ai-project-os.com";
const PRODUCTION_RESOURCE = `${PRODUCTION_ORIGIN}/api/mcp`;
const RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource/api/mcp";
const AUTHORIZATION_METADATA_PATH = "/.well-known/oauth-authorization-server";
const MAX_RESPONSE_BYTES = 128 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const CALLBACK_TIMEOUT_MS = 10 * 60 * 1_000;
const AUTHORIZATION_CONFIRMATION = "CONFIRM_PRODUCTION_SYNTHETIC_MCP_ACCEPTANCE";
const OPERATION_NAMES = ["project_summary", "project_evidence", "project_plan"] as const;

type Operation = typeof OPERATION_NAMES[number];
type ClientLabel = "A" | "B";
type ClientTransport = "fetch" | "node-https";
type WireResponse = Readonly<{ status: number; headers: Headers; body: string }>;
type CallState = "notAttempted" | "inFlight" | "returnedSuccess" | "denied" | "unknown" | "invalidSuccess";
type ReplayState = "notAttempted" | "inFlight" | "denied" | "returnedSuccess" | "unknown";
type CallbackState = "waiting" | "exchanging" | "ready" | "denied" | "expired" | "failed";

type ClientFixture = Readonly<{
  client_id: string;
  client_name: string;
  redirect_uris: readonly string[];
  token_endpoint_auth_method: string;
  grant_types: readonly string[];
  response_types: readonly string[];
}>;

type ClientFlow = {
  label: ClientLabel;
  transport: ClientTransport;
  protocolVersion: "2025-11-25" | "2026-07-28";
  port: number;
  fixture: ClientFixture;
  resource: string | null;
  authorizationEndpoint: string | null;
  tokenEndpoint: string | null;
  redirectUri: string;
  state: string | null;
  verifier: string | null;
  authorizationUrl: string | null;
  callbackCode: string | null;
  callbackStatus: CallbackState;
  callbackAccepted: boolean;
  callbackServer: Server | null;
  callbackTimer: NodeJS.Timeout | null;
  token: string | null;
  tokenExpiresAt: number | null;
  sessionId: string | null;
  protocolNegotiated: boolean;
  codeReplayRejected: boolean;
  toolsListed: boolean;
  summaryVerified: boolean;
  calls: Record<Operation, CallState>;
  replays: Record<Operation, ReplayState>;
  revocationChecks: number;
  revoked: boolean;
};

type Runtime = {
  projectId: string;
  flows: readonly ClientFlow[];
  shutdown: AbortController;
  activeRequests: Set<ClientRequest>;
  fatal: boolean;
  fatalCode: string | null;
  interrupted: boolean;
  actualReads: number;
  isolation: "notAttempted" | "passed" | "unexpected" | "unknown";
  peerLimit: "notRun" | "nginxHtml429" | "applicationJson429" | "other429" | "no429" | "incomplete";
};

class AcceptanceFailure extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "AcceptanceFailure";
  }
}

function fail(code: string): never {
  throw new AcceptanceFailure(code);
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function safeJson(value: string, code: string): Record<string, unknown> {
  try {
    const parsed = record(JSON.parse(value) as unknown);
    if (parsed === null) return fail(code);
    return parsed;
  } catch (error) {
    if (error instanceof AcceptanceFailure) throw error;
    return fail(code);
  }
}

function mediaType(headers: Headers): string {
  return (headers.get("content-type")?.split(";", 1)[0] ?? "").trim().toLowerCase();
}

function parseArguments(args: readonly string[]): string {
  if (args.length !== 3 || args[0] !== AUTHORIZATION_CONFIRMATION || args[1] !== "--project"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(args[2] ?? "")) {
    console.error(`Usage: pnpm exec tsx scripts/run-mcp-production-acceptance.ts ${AUTHORIZATION_CONFIRMATION} --project <synthetic-project-uuid>`);
    console.error("The confirmation argument is required before this runner makes any production HTTPS requests.");
    process.exitCode = 2;
    return fail("CLI_ARGUMENTS_INVALID");
  }
  return args[2]!;
}

function flowFor(
  label: ClientLabel,
  transport: ClientTransport,
  protocolVersion: ClientFlow["protocolVersion"],
  port: number,
  fixture: ClientFixture,
): ClientFlow {
  const expectedName = `AI Project OS 验收模拟客户端 ${label}`;
  const expectedClientId = `https://cdn.jsdelivr.net/gh/Jack-Kunlun/ai-project-os@main/test/fixtures/mcp-production-clients/client-${label.toLowerCase()}.json`;
  const expectedRedirectUri = `http://127.0.0.1:${port}/oauth/callback`;
  if (fixture.client_id !== expectedClientId || fixture.client_name !== expectedName
    || fixture.redirect_uris.length !== 1 || fixture.redirect_uris[0] !== expectedRedirectUri
    || fixture.token_endpoint_auth_method !== "none"
    || !fixture.grant_types.includes("authorization_code") || !fixture.response_types.includes("code")) {
    return fail("CLIENT_FIXTURE_CONTRACT_INVALID");
  }
  return {
    label, transport, protocolVersion, port, fixture,
    resource: null, authorizationEndpoint: null, tokenEndpoint: null,
    redirectUri: expectedRedirectUri, state: null, verifier: null, authorizationUrl: null,
    callbackCode: null, callbackStatus: "waiting", callbackAccepted: false,
    callbackServer: null, callbackTimer: null, token: null, tokenExpiresAt: null,
    sessionId: null, protocolNegotiated: false,
    codeReplayRejected: false, toolsListed: false, summaryVerified: false,
    calls: { project_summary: "notAttempted", project_evidence: "notAttempted", project_plan: "notAttempted" },
    replays: { project_summary: "notAttempted", project_evidence: "notAttempted", project_plan: "notAttempted" },
    revocationChecks: 0, revoked: false,
  };
}

function scopedAbort(runtime: Runtime): Readonly<{ controller: AbortController; cleanup: () => void }> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, REQUEST_TIMEOUT_MS);
  runtime.shutdown.signal.addEventListener("abort", abort, { once: true });
  if (runtime.shutdown.signal.aborted) abort();
  return {
    controller,
    cleanup: () => {
      clearTimeout(timer);
      runtime.shutdown.signal.removeEventListener("abort", abort);
    },
  };
}

async function readFetchBody(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) return "";
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        return fail("HTTP_RESPONSE_TOO_LARGE");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

function checkedProductionUrl(path: string): URL {
  if (!path.startsWith("/") || path.startsWith("//")) return fail("HTTP_PATH_INVALID");
  const url = new URL(path, PRODUCTION_ORIGIN);
  if (url.origin !== PRODUCTION_ORIGIN) return fail("HTTP_ORIGIN_INVALID");
  return url;
}

async function sendWithFetch(
  runtime: Runtime,
  path: string,
  method: string,
  body: string | undefined,
  headers: Headers,
): Promise<WireResponse> {
  const url = checkedProductionUrl(path);
  const scoped = scopedAbort(runtime);
  try {
    const response = await fetch(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      redirect: "manual",
      cache: "no-store",
      signal: scoped.controller.signal,
    });
    return { status: response.status, headers: response.headers, body: await readFetchBody(response) };
  } catch (error) {
    if (error instanceof AcceptanceFailure) throw error;
    if (runtime.shutdown.signal.aborted) return fail("RUN_INTERRUPTED");
    return fail("FETCH_TRANSPORT_FAILED");
  } finally {
    scoped.cleanup();
  }
}

function nodeHeadersToFetch(headers: NodeJS.Dict<string | string[]>): Headers {
  const result = new Headers();
  for (const [name, raw] of Object.entries(headers)) {
    if (raw === undefined) continue;
    result.set(name, Array.isArray(raw) ? raw.join(", ") : raw);
  }
  return result;
}

async function sendWithNodeHttps(
  runtime: Runtime,
  path: string,
  method: string,
  body: string | undefined,
  headers: Headers,
): Promise<WireResponse> {
  const url = checkedProductionUrl(path);
  if (url.protocol !== "https:") return fail("HTTPS_ORIGIN_REQUIRED");
  const outgoingHeaders: Record<string, string> = {};
  headers.forEach((value, name) => { outgoingHeaders[name] = value; });
  if (body !== undefined && outgoingHeaders["content-length"] === undefined) {
    outgoingHeaders["content-length"] = String(Buffer.byteLength(body));
  }

  return new Promise<WireResponse>((resolve, reject) => {
    let settled = false;
    let size = 0;
    const chunks: Buffer[] = [];
    const requestState: { request?: ClientRequest; timer?: NodeJS.Timeout } = {};
    const finish = (error?: AcceptanceFailure, response?: WireResponse) => {
      if (settled) return;
      settled = true;
      if (requestState.timer !== undefined) clearTimeout(requestState.timer);
      runtime.shutdown.signal.removeEventListener("abort", abort);
      if (requestState.request !== undefined) runtime.activeRequests.delete(requestState.request);
      if (error !== undefined) reject(error);
      else if (response !== undefined) resolve(response);
      else reject(new AcceptanceFailure("HTTPS_TRANSPORT_FAILED"));
    };
    const abort = () => {
      requestState.request?.destroy();
      finish(new AcceptanceFailure(runtime.shutdown.signal.aborted ? "RUN_INTERRUPTED" : "HTTPS_TIMEOUT"));
    };
    const request = httpsRequest({
      protocol: "https:",
      hostname: url.hostname,
      port: url.port === "" ? 443 : Number(url.port),
      path: `${url.pathname}${url.search}`,
      method,
      headers: outgoingHeaders,
      agent: false,
      rejectUnauthorized: true,
    }, (incoming) => {
      incoming.on("data", (chunk: Buffer | string) => {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += data.byteLength;
        if (size > MAX_RESPONSE_BYTES) {
          incoming.destroy();
          request.destroy();
          finish(new AcceptanceFailure("HTTP_RESPONSE_TOO_LARGE"));
          return;
        }
        chunks.push(data);
      });
      incoming.once("aborted", () => finish(new AcceptanceFailure("HTTPS_RESPONSE_ABORTED")));
      incoming.once("error", () => finish(new AcceptanceFailure("HTTPS_RESPONSE_FAILED")));
      incoming.once("end", () => finish(undefined, {
        status: incoming.statusCode ?? 0,
        headers: nodeHeadersToFetch(incoming.headers),
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    requestState.request = request;
    runtime.activeRequests.add(request);
    runtime.shutdown.signal.addEventListener("abort", abort, { once: true });
    requestState.timer = setTimeout(abort, REQUEST_TIMEOUT_MS);
    if (runtime.shutdown.signal.aborted) abort();
    request.once("error", () => finish(new AcceptanceFailure("HTTPS_TRANSPORT_FAILED")));
    if (body !== undefined) request.write(body);
    request.end();
  });
}

function send(
  runtime: Runtime,
  flow: ClientFlow,
  path: string,
  method = "GET",
  body?: string,
  headers = new Headers(),
): Promise<WireResponse> {
  return flow.transport === "fetch"
    ? sendWithFetch(runtime, path, method, body, headers)
    : sendWithNodeHttps(runtime, path, method, body, headers);
}

function jsonBody(response: WireResponse, code: string): Record<string, unknown> {
  if (mediaType(response.headers) !== "application/json") return fail(code);
  return safeJson(response.body, code);
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : null;
}

async function discoverProductionEndpoints(runtime: Runtime, flow: ClientFlow): Promise<void> {
  const resourceResponse = await send(runtime, flow, RESOURCE_METADATA_PATH);
  if (resourceResponse.status !== 200) return fail(`RESOURCE_METADATA_HTTP_${resourceResponse.status}`);
  const resourceMetadata = jsonBody(resourceResponse, "RESOURCE_METADATA_INVALID");
  const authorizationServers = stringArray(resourceMetadata.authorization_servers);
  const supportedScopes = stringArray(resourceMetadata.scopes_supported);
  if (resourceMetadata.resource !== PRODUCTION_RESOURCE || authorizationServers === null
    || !authorizationServers.includes(PRODUCTION_ORIGIN) || supportedScopes === null || !supportedScopes.includes("project:read")) {
    return fail("RESOURCE_METADATA_MISMATCH");
  }

  const authorizationMetadataResponse = await send(runtime, flow, AUTHORIZATION_METADATA_PATH);
  if (authorizationMetadataResponse.status !== 200) return fail(`AUTHORIZATION_METADATA_HTTP_${authorizationMetadataResponse.status}`);
  const authorizationMetadata = jsonBody(authorizationMetadataResponse, "AUTHORIZATION_METADATA_INVALID");
  const codeChallengeMethods = stringArray(authorizationMetadata.code_challenge_methods_supported);
  const authzEndpoint = typeof authorizationMetadata.authorization_endpoint === "string" ? authorizationMetadata.authorization_endpoint : "";
  const tokenEndpoint = typeof authorizationMetadata.token_endpoint === "string" ? authorizationMetadata.token_endpoint : "";
  if (authorizationMetadata.issuer !== PRODUCTION_ORIGIN
    || authzEndpoint !== `${PRODUCTION_ORIGIN}/oauth/authorize`
    || tokenEndpoint !== `${PRODUCTION_ORIGIN}/oauth/token`
    || !codeChallengeMethods?.includes("S256")
    || authorizationMetadata.client_id_metadata_document_supported !== true
    || authorizationMetadata.authorization_response_iss_parameter_supported !== true
    || !stringArray(authorizationMetadata.scopes_supported)?.includes("project:read")) {
    return fail("AUTHORIZATION_METADATA_MISMATCH");
  }

  const challengeResponse = await send(runtime, flow, "/api/mcp");
  const challenge = challengeResponse.headers.get("www-authenticate") ?? "";
  if (challengeResponse.status !== 401
    || !challenge.includes(`resource_metadata="${PRODUCTION_ORIGIN}${RESOURCE_METADATA_PATH}"`)
    || !challenge.includes('scope="project:read"')) {
    return fail("MCP_OAUTH_CHALLENGE_MISMATCH");
  }

  flow.resource = PRODUCTION_RESOURCE;
  flow.authorizationEndpoint = authzEndpoint;
  flow.tokenEndpoint = tokenEndpoint;
}

function authorizationUrlFor(flow: ClientFlow): string {
  if (flow.authorizationEndpoint === null || flow.resource === null) return fail("AUTHORIZATION_ENDPOINT_UNAVAILABLE");
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
  const url = new URL(flow.authorizationEndpoint);
  if (url.origin !== PRODUCTION_ORIGIN || url.pathname !== "/oauth/authorize" || url.search !== "" || url.hash !== "") {
    return fail("AUTHORIZATION_ENDPOINT_INVALID");
  }
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", flow.fixture.client_id);
  url.searchParams.set("redirect_uri", flow.redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", flow.resource);
  url.searchParams.set("scope", "project:read");
  flow.verifier = verifier;
  flow.state = state;
  flow.authorizationUrl = url.toString();
  flow.callbackTimer = setTimeout(() => {
    if (flow.callbackStatus === "waiting") {
      flow.callbackStatus = "expired";
      flow.state = null;
      flow.verifier = null;
      flow.authorizationUrl = null;
      console.error(`CLIENT_${flow.label} callback expired; restart this client flow only after reviewing production state.`);
    }
  }, CALLBACK_TIMEOUT_MS);
  flow.callbackTimer.unref();
  return flow.authorizationUrl;
}

function callbackHeaders(): Record<string, string> {
  return {
    "cache-control": "no-store, no-cache, max-age=0",
    pragma: "no-cache",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  };
}

function callbackResponse(response: ServerResponse, status: number, text: string): void {
  response.writeHead(status, { ...callbackHeaders(), "content-type": "text/plain; charset=utf-8" });
  response.end(text);
}

function isLoopbackAddress(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function exactlyOne(url: URL, name: string): string | null {
  const values = url.searchParams.getAll(name);
  return values.length === 1 ? values[0]! : null;
}

function callbackQueryIsAllowed(url: URL): boolean {
  const allowed = new Set(["code", "state", "iss", "error", "error_description"]);
  return [...url.searchParams.keys()].every((key) => allowed.has(key));
}

function stateMatches(received: string, expected: string | null): boolean {
  if (expected === null) return false;
  const actualBytes = Buffer.from(received, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function createCallbackServer(runtime: Runtime, flow: ClientFlow): Server {
  return createServer({ maxHeaderSize: 8 * 1024 }, (request, response) => {
    if (!isLoopbackAddress(request.socket.remoteAddress) || request.headers.host !== `127.0.0.1:${flow.port}`
      || request.method !== "GET" || typeof request.url !== "string" || request.url.length > 4_096
      || !request.url.startsWith("/")) {
      callbackResponse(response, 400, "Invalid local callback. Return to the terminal.");
      return;
    }

    let url: URL;
    try {
      url = new URL(request.url, `http://127.0.0.1:${flow.port}`);
    } catch {
      callbackResponse(response, 400, "Invalid local callback. Return to the terminal.");
      return;
    }

    if (url.pathname === "/complete" && url.search === "") {
      callbackResponse(response, 200, "OAuth callback received. Return to the terminal.");
      return;
    }
    if (url.pathname !== "/oauth/callback" || flow.callbackAccepted || flow.callbackStatus !== "waiting"
      || !callbackQueryIsAllowed(url)) {
      callbackResponse(response, 400, "Invalid or already used OAuth callback. Return to the terminal.");
      return;
    }

    const receivedState = exactlyOne(url, "state");
    const issuer = exactlyOne(url, "iss");
    const codeValues = url.searchParams.getAll("code");
    const errorValues = url.searchParams.getAll("error");
    const descriptionValues = url.searchParams.getAll("error_description");
    if (receivedState === null || !stateMatches(receivedState, flow.state) || issuer !== PRODUCTION_ORIGIN
      || descriptionValues.length > 1) {
      callbackResponse(response, 400, "OAuth callback validation failed. Return to the terminal.");
      return;
    }

    if (errorValues.length === 1 && codeValues.length === 0 && errorValues[0] !== "") {
      flow.callbackAccepted = true;
      flow.callbackStatus = "denied";
      flow.state = null;
      flow.verifier = null;
      flow.authorizationUrl = null;
      if (flow.callbackTimer !== null) clearTimeout(flow.callbackTimer);
      response.writeHead(303, { ...callbackHeaders(), location: "/complete" });
      response.end();
      console.error(`CLIENT_${flow.label} OAuth consent was denied; no token was issued.`);
      return;
    }

    const code = exactlyOne(url, "code");
    if (errorValues.length !== 0 || codeValues.length !== 1 || code === null
      || descriptionValues.length !== 0 || !/^apos_mcp_code_[A-Za-z0-9_-]{43}$/u.test(code)) {
      callbackResponse(response, 400, "OAuth callback validation failed. Return to the terminal.");
      return;
    }

    flow.callbackAccepted = true;
    flow.callbackStatus = "exchanging";
    flow.callbackCode = code;
    flow.state = null;
    flow.authorizationUrl = null;
    if (flow.callbackTimer !== null) clearTimeout(flow.callbackTimer);
    response.writeHead(303, { ...callbackHeaders(), location: "/complete" });
    response.end();
    void completeAuthorization(runtime, flow).catch((error: unknown) => {
      flow.callbackStatus = "failed";
      flow.callbackCode = null;
      flow.verifier = null;
      if (error instanceof AcceptanceFailure) console.error(`CLIENT_${flow.label} OAuth completion failed: ${error.code}.`);
      else console.error(`CLIENT_${flow.label} OAuth completion failed: OAUTH_COMPLETION_FAILED.`);
    });
  });
}

async function startCallbackListener(runtime: Runtime, flow: ClientFlow): Promise<void> {
  const server = createCallbackServer(runtime, flow);
  server.maxConnections = 8;
  await new Promise<void>((resolve, reject) => {
    server.once("error", () => reject(new AcceptanceFailure(`CALLBACK_PORT_${flow.port}_UNAVAILABLE`)));
    server.listen(flow.port, "127.0.0.1", () => resolve());
  });
  flow.callbackServer = server;
}

function parseJsonRpc(body: string): Record<string, unknown> {
  const eventData = body.split(/\r?\n/u).flatMap((line) => line.startsWith("data:") ? [line.slice(5).trimStart()] : []);
  const json = eventData.at(-1) ?? body;
  return safeJson(json, "MCP_RESPONSE_INVALID");
}

function modernMetadata(flow: ClientFlow): Record<string, unknown> {
  if (flow.protocolVersion !== "2026-07-28") return {};
  return {
    "io.modelcontextprotocol/protocolVersion": flow.protocolVersion,
    "io.modelcontextprotocol/clientInfo": { name: flow.fixture.client_name, version: "1.0" },
    "io.modelcontextprotocol/clientCapabilities": {},
  };
}

async function mcpRequest(
  runtime: Runtime,
  flow: ClientFlow,
  token: string,
  method: "server/discover" | "tools/list" | "tools/call",
  operation?: Operation,
): Promise<Readonly<{ response: WireResponse; requestId: string }>> {
  if (method === "server/discover" && flow.protocolVersion !== "2026-07-28") return fail("MODERN_DISCOVERY_VERSION_MISMATCH");
  if (method !== "server/discover" && !flow.protocolNegotiated) return fail("MCP_PROTOCOL_NOT_NEGOTIATED");
  const requestId = randomUUID();
  const metadata = modernMetadata(flow);
  const params = method === "tools/call"
    ? { name: operation, arguments: {}, ...(Object.keys(metadata).length === 0 ? {} : { _meta: metadata }) }
    : Object.keys(metadata).length === 0 ? {} : { _meta: metadata };
  const headers = new Headers({
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "mcp-protocol-version": flow.protocolVersion,
    "mcp-method": method,
    authorization: `Bearer ${token}`,
  });
  if (flow.sessionId !== null) headers.set("mcp-session-id", flow.sessionId);
  if (method === "tools/call" && operation !== undefined) headers.set("mcp-name", operation);
  const body = JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params });
  return { response: await send(runtime, flow, "/api/mcp", "POST", body, headers), requestId };
}

function retainSessionId(flow: ClientFlow, response: WireResponse): void {
  const sessionId = response.headers.get("mcp-session-id");
  if (sessionId === null) return;
  if (!/^[\x21-\x7e]{1,512}$/u.test(sessionId)) return fail("MCP_SESSION_ID_INVALID");
  if (flow.sessionId !== null && flow.sessionId !== sessionId) return fail("MCP_SESSION_ID_CHANGED");
  flow.sessionId = sessionId;
}

async function negotiateProtocol(runtime: Runtime, flow: ClientFlow): Promise<void> {
  if (flow.token === null) return fail("CLIENT_TOKEN_UNAVAILABLE");
  if (flow.protocolNegotiated) return fail("MCP_PROTOCOL_ALREADY_NEGOTIATED");

  if (flow.protocolVersion === "2025-11-25") {
    const requestId = randomUUID();
    const headers = new Headers({
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-method": "initialize",
      authorization: `Bearer ${flow.token}`,
    });
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: requestId,
      method: "initialize",
      params: {
        protocolVersion: flow.protocolVersion,
        capabilities: {},
        clientInfo: { name: flow.fixture.client_name, version: "1.0" },
      },
    });
    const response = await send(runtime, flow, "/api/mcp", "POST", body, headers);
    if (response.status !== 200) return fail(`MCP_INITIALIZE_HTTP_${response.status}`);
    const responseProtocol = response.headers.get("mcp-protocol-version");
    if (responseProtocol !== null && responseProtocol !== flow.protocolVersion) return fail("MCP_INITIALIZE_PROTOCOL_MISMATCH");
    retainSessionId(flow, response);
    const envelope = parseJsonRpc(response.body);
    const result = record(envelope.result);
    const serverInfo = record(result?.serverInfo);
    if (envelope.jsonrpc !== "2.0" || envelope.id !== requestId || result === null
      || result.protocolVersion !== flow.protocolVersion || record(result.capabilities) === null
      || typeof serverInfo?.name !== "string" || typeof serverInfo.version !== "string"
      || envelope.error !== undefined) {
      return fail("MCP_INITIALIZE_RESPONSE_INVALID");
    }

    const notificationHeaders = new Headers({
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": flow.protocolVersion,
      "mcp-method": "notifications/initialized",
      authorization: `Bearer ${flow.token}`,
    });
    if (flow.sessionId !== null) notificationHeaders.set("mcp-session-id", flow.sessionId);
    const notification = JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    });
    const initialized = await send(runtime, flow, "/api/mcp", "POST", notification, notificationHeaders);
    if (initialized.status !== 202 || initialized.body !== "") return fail(`MCP_INITIALIZED_NOTIFICATION_HTTP_${initialized.status}`);
    retainSessionId(flow, initialized);
  } else {
    const { response, requestId } = await mcpRequest(runtime, flow, flow.token, "server/discover");
    if (response.status !== 200) return fail(`MCP_SERVER_DISCOVER_HTTP_${response.status}`);
    retainSessionId(flow, response);
    const envelope = parseJsonRpc(response.body);
    const result = record(envelope.result);
    const supportedVersions = stringArray(result?.supportedVersions);
    if (envelope.jsonrpc !== "2.0" || envelope.id !== requestId || envelope.error !== undefined
      || result === null || supportedVersions === null || !supportedVersions.includes(flow.protocolVersion)
      || record(result.capabilities) === null) {
      return fail("MCP_SERVER_DISCOVER_RESPONSE_INVALID");
    }
  }

  flow.protocolNegotiated = true;
}

function validateToolsList(envelope: Record<string, unknown>, requestId: string): boolean {
  if (envelope.jsonrpc !== "2.0" || envelope.id !== requestId) return false;
  const result = record(envelope.result);
  if (result === null || result.isError === true || !Array.isArray(result.tools)) return false;
  const tools = result.tools.map(record);
  if (tools.some((tool) => tool === null)) return false;
  const names = tools.map((tool) => tool!.name).sort();
  if (JSON.stringify(names) !== JSON.stringify([...OPERATION_NAMES].sort())) return false;
  return tools.every((tool) => {
    const annotations = record(tool!.annotations);
    return annotations?.readOnlyHint === true && annotations.destructiveHint === false && annotations.openWorldHint === false;
  });
}

async function listTools(runtime: Runtime, flow: ClientFlow): Promise<void> {
  if (flow.token === null) return fail("CLIENT_TOKEN_UNAVAILABLE");
  const { response, requestId } = await mcpRequest(runtime, flow, flow.token, "tools/list");
  if (response.status !== 200) return fail(`TOOLS_LIST_HTTP_${response.status}`);
  retainSessionId(flow, response);
  if (!validateToolsList(parseJsonRpc(response.body), requestId)) return fail("TOOLS_LIST_CONTRACT_MISMATCH");
  flow.toolsListed = true;
}

function tokenRequestBody(flow: ClientFlow, code: string, verifier: string): string {
  const parameters = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: flow.fixture.client_id,
    redirect_uri: flow.redirectUri,
    resource: PRODUCTION_RESOURCE,
    code_verifier: verifier,
  });
  return parameters.toString();
}

function validTokenResponse(payload: Record<string, unknown>): payload is Record<string, unknown> & {
  access_token: string; token_type: "Bearer"; scope: "project:read"; expires_in: number;
} {
  return typeof payload.access_token === "string" && /^apos_mcp_oauth_[A-Za-z0-9_-]{43}$/u.test(payload.access_token)
    && payload.token_type === "Bearer" && payload.scope === "project:read"
    && typeof payload.expires_in === "number" && Number.isInteger(payload.expires_in)
    && payload.expires_in > 0 && payload.expires_in <= 15 * 60;
}

async function completeAuthorization(runtime: Runtime, flow: ClientFlow): Promise<void> {
  if (runtime.fatal) return fail("RUN_STOPPED_AFTER_SECURITY_FAILURE");
  const code = flow.callbackCode;
  const verifier = flow.verifier;
  flow.verifier = null;
  if (code === null || verifier === null || flow.tokenEndpoint === null) return fail("OAUTH_CALLBACK_STATE_MISSING");
  const requestBody = tokenRequestBody(flow, code, verifier);
  const headers = new Headers({ "content-type": "application/x-www-form-urlencoded" });
  const first = await send(runtime, flow, "/oauth/token", "POST", requestBody, headers);
  flow.callbackCode = null;
  if (first.status !== 200) return fail(`TOKEN_EXCHANGE_HTTP_${first.status}`);
  const tokenPayload = jsonBody(first, "TOKEN_EXCHANGE_RESPONSE_INVALID");
  if (!validTokenResponse(tokenPayload)) return fail("TOKEN_EXCHANGE_RESPONSE_INVALID");
  flow.token = tokenPayload.access_token;
  flow.tokenExpiresAt = Date.now() + tokenPayload.expires_in * 1_000;

  const replay = await send(runtime, flow, "/oauth/token", "POST", requestBody, headers);
  if (replay.status !== 400) {
    if (replay.status === 200) {
      runtime.fatal = true;
      runtime.fatalCode = "OAUTH_CODE_REPLAY_ACCEPTED";
    }
    return fail(replay.status === 200 ? "OAUTH_CODE_REPLAY_ACCEPTED" : `OAUTH_CODE_REPLAY_HTTP_${replay.status}`);
  }
  flow.codeReplayRejected = true;
  await negotiateProtocol(runtime, flow);
  await listTools(runtime, flow);
  flow.callbackStatus = "ready";
  const lifecycle = flow.protocolVersion === "2025-11-25" ? "initialize+initialized" : "server/discover";
  const session = flow.sessionId === null ? "none" : "retained-in-memory";
  console.log(`CLIENT_${flow.label} ready transport=${flow.transport} protocol=${flow.protocolVersion} lifecycle=${lifecycle} session=${session} tools=list:project_summary,project_evidence,project_plan codeReplay=rejected token=memory-only`);
}

function syntheticMarker(value: string): boolean {
  const normalized = value.toLowerCase();
  return normalized.includes("synthetic") || value.includes("合成") || value.includes("模拟");
}

function validateToolContent(operation: Operation, structured: unknown, projectId: string): "valid" | "project_mismatch" | "synthetic_mismatch" | "fixture_not_empty" | "shape_invalid" {
  const content = record(structured);
  if (content === null) return "shape_invalid";
  if (operation === "project_summary") {
    const project = record(content.project);
    if (project === null || typeof project.id !== "string" || typeof project.name !== "string") return "shape_invalid";
    if (project.id !== projectId) return "project_mismatch";
    return syntheticMarker(project.name) ? "valid" : "synthetic_mismatch";
  }
  if (operation === "project_evidence") {
    const evidence = record(content.evidence);
    if (evidence === null || !Array.isArray(evidence.items) || typeof evidence.hasMore !== "boolean") return "shape_invalid";
    return evidence.items.length === 0 && evidence.hasMore === false ? "valid" : "fixture_not_empty";
  }
  const plan = record(content.plan);
  if (plan === null || !Array.isArray(plan.objectives) || !Array.isArray(plan.workItems)
    || typeof plan.objectivesHaveMore !== "boolean" || typeof plan.workItemsHaveMore !== "boolean") return "shape_invalid";
  return plan.objectives.length === 0 && plan.workItems.length === 0
    && plan.objectivesHaveMore === false && plan.workItemsHaveMore === false ? "valid" : "fixture_not_empty";
}

function markFatal(runtime: Runtime, code: string): void {
  runtime.fatal = true;
  runtime.fatalCode = code;
}

function parseResult(envelope: Record<string, unknown>, requestId: string): Record<string, unknown> | null {
  if (envelope.jsonrpc !== "2.0" || envelope.id !== requestId) return null;
  return record(envelope.result);
}

async function callOneApprovedRead(runtime: Runtime, flow: ClientFlow, operation: Operation): Promise<void> {
  if (runtime.fatal) return fail("RUN_STOPPED_AFTER_SECURITY_FAILURE");
  if (flow.callbackStatus !== "ready" || flow.token === null || !flow.toolsListed || flow.revoked) return fail("CLIENT_NOT_READY");
  if (flow.tokenExpiresAt === null || flow.tokenExpiresAt <= Date.now()) return fail("CLIENT_TOKEN_EXPIRED");
  if (operation !== "project_summary" && !flow.summaryVerified) return fail("PROJECT_SUMMARY_REQUIRED_FIRST");
  if (flow.calls[operation] !== "notAttempted") return fail("OPERATION_ALREADY_ATTEMPTED_NO_RETRY");

  flow.calls[operation] = "inFlight";
  let first: Readonly<{ response: WireResponse; requestId: string }>;
  try {
    first = await mcpRequest(runtime, flow, flow.token, "tools/call", operation);
  } catch {
    flow.calls[operation] = "unknown";
    return fail("TOOL_CALL_OUTCOME_UNKNOWN_NO_RETRY");
  }
  if (first.response.status !== 200) {
    flow.calls[operation] = first.response.status === 401 ? "denied" : "unknown";
    return fail(`TOOL_CALL_HTTP_${first.response.status}_NO_RETRY`);
  }

  let envelope: Record<string, unknown>;
  try {
    envelope = parseJsonRpc(first.response.body);
  } catch {
    flow.calls[operation] = "unknown";
    markFatal(runtime, "TOOL_CALL_RESPONSE_UNCLASSIFIED");
    return fail("TOOL_CALL_RESPONSE_UNCLASSIFIED_STOP");
  }
  const result = parseResult(envelope, first.requestId);
  if (envelope.jsonrpc !== "2.0" || envelope.id !== first.requestId) {
    flow.calls[operation] = "unknown";
    markFatal(runtime, "TOOL_CALL_RESPONSE_ID_MISMATCH");
    return fail("TOOL_CALL_RESPONSE_ID_MISMATCH_STOP");
  }
  if (result?.isError === true || envelope.error !== undefined) {
    flow.calls[operation] = "denied";
    return fail("APPROVED_TOOL_CALL_DENIED_NO_RETRY");
  }
  if (result === null) {
    flow.calls[operation] = "unknown";
    markFatal(runtime, "TOOL_CALL_RESPONSE_UNCLASSIFIED");
    return fail("TOOL_CALL_RESPONSE_UNCLASSIFIED_STOP");
  }

  runtime.actualReads += 1;
  flow.calls[operation] = "returnedSuccess";
  const shape = validateToolContent(operation, result.structuredContent, runtime.projectId);
  if (shape !== "valid") {
    flow.calls[operation] = "invalidSuccess";
    markFatal(runtime, shape === "project_mismatch" ? "TOOL_PROJECT_ID_MISMATCH" : shape === "synthetic_mismatch"
      ? "TOOL_PROJECT_NOT_SYNTHETIC" : shape === "fixture_not_empty" ? "SYNTHETIC_PROJECT_HAS_CONTENT" : "TOOL_CONTENT_SHAPE_INVALID");
    return fail(`${runtime.fatalCode}_STOP_WITHOUT_CONTENT_OUTPUT`);
  }
  if (operation === "project_summary") flow.summaryVerified = true;

  flow.replays[operation] = "inFlight";
  let replay: Readonly<{ response: WireResponse; requestId: string }>;
  try {
    replay = await mcpRequest(runtime, flow, flow.token, "tools/call", operation);
  } catch {
    flow.replays[operation] = "unknown";
    markFatal(runtime, "APPROVAL_REPLAY_OUTCOME_UNKNOWN");
    return fail("APPROVAL_REPLAY_OUTCOME_UNKNOWN_STOP_NO_RETRY");
  }
  if (replay.response.status !== 200) {
    flow.replays[operation] = "unknown";
    markFatal(runtime, "APPROVAL_REPLAY_NOT_CLASSIFIED");
    return fail(`APPROVAL_REPLAY_HTTP_${replay.response.status}_STOP_NO_RETRY`);
  }
  let replayEnvelope: Record<string, unknown>;
  try {
    replayEnvelope = parseJsonRpc(replay.response.body);
  } catch {
    flow.replays[operation] = "unknown";
    markFatal(runtime, "APPROVAL_REPLAY_RESPONSE_UNCLASSIFIED");
    return fail("APPROVAL_REPLAY_RESPONSE_UNCLASSIFIED_STOP");
  }
  const replayResult = parseResult(replayEnvelope, replay.requestId);
  if (replayEnvelope.jsonrpc !== "2.0" || replayEnvelope.id !== replay.requestId) {
    flow.replays[operation] = "unknown";
    markFatal(runtime, "APPROVAL_REPLAY_ID_MISMATCH");
    return fail("APPROVAL_REPLAY_ID_MISMATCH_STOP");
  }
  if (replayResult?.isError === true || replayEnvelope.error !== undefined) {
    flow.replays[operation] = "denied";
    console.log(`READ client=${flow.label} tool=${operation} result=success scope=synthetic-project replay=denied`);
    return;
  }
  if (replayResult === null) {
    flow.replays[operation] = "unknown";
    markFatal(runtime, "APPROVAL_REPLAY_RESPONSE_UNCLASSIFIED");
    return fail("APPROVAL_REPLAY_RESPONSE_UNCLASSIFIED_STOP");
  }
  runtime.actualReads += 1;
  flow.replays[operation] = "returnedSuccess";
  markFatal(runtime, "APPROVAL_REPLAY_RETURNED_DATA");
  return fail("APPROVAL_REPLAY_RETURNED_DATA_STOP_WITHOUT_CONTENT_OUTPUT");
}

function parseClientLabel(value: string | undefined): ClientLabel | null {
  return value === "A" || value === "B" ? value : null;
}

function parseOperation(value: string | undefined): Operation | null {
  return OPERATION_NAMES.includes(value as Operation) ? value as Operation : null;
}

function flowByLabel(runtime: Runtime, label: ClientLabel): ClientFlow {
  const flow = runtime.flows.find((item) => item.label === label);
  if (flow === undefined) return fail("CLIENT_LABEL_INVALID");
  return flow;
}

async function checkCrossClientIsolation(
  runtime: Runtime,
  approvedLabel: ClientLabel,
  otherLabel: ClientLabel,
  operation: Operation,
): Promise<void> {
  if (runtime.fatal) return fail("RUN_STOPPED_AFTER_SECURITY_FAILURE");
  if (runtime.isolation !== "notAttempted") return fail("ISOLATION_CHECK_ALREADY_ATTEMPTED");
  if (approvedLabel !== "A" || otherLabel !== "B" || operation !== "project_summary") return fail("ISOLATION_CHECK_ARGUMENTS_INVALID");
  const approved = flowByLabel(runtime, approvedLabel);
  const other = flowByLabel(runtime, otherLabel);
  if (approved.callbackStatus !== "ready" || other.callbackStatus !== "ready"
    || approved.token === null || other.token === null || !approved.toolsListed || !other.toolsListed
    || approved.calls.project_summary !== "notAttempted" || other.calls.project_summary !== "notAttempted") {
    return fail("ISOLATION_CHECK_CLIENT_STATE_INVALID");
  }
  runtime.isolation = "unknown";
  let attempt: Readonly<{ response: WireResponse; requestId: string }>;
  try {
    attempt = await mcpRequest(runtime, other, other.token, "tools/call", operation);
  } catch {
    return fail("ISOLATION_CHECK_OUTCOME_UNKNOWN_NO_RETRY");
  }
  if (attempt.response.status !== 200) {
    runtime.isolation = "unknown";
    return fail(`ISOLATION_CHECK_HTTP_${attempt.response.status}`);
  }
  let envelope: Record<string, unknown>;
  try {
    envelope = parseJsonRpc(attempt.response.body);
  } catch {
    markFatal(runtime, "ISOLATION_RESPONSE_UNCLASSIFIED");
    return fail("ISOLATION_RESPONSE_UNCLASSIFIED_STOP");
  }
  const result = parseResult(envelope, attempt.requestId);
  if (envelope.jsonrpc !== "2.0" || envelope.id !== attempt.requestId) {
    markFatal(runtime, "ISOLATION_RESPONSE_ID_MISMATCH");
    return fail("ISOLATION_RESPONSE_ID_MISMATCH_STOP");
  }
  if (result?.isError === true) {
    runtime.isolation = "passed";
    console.log(`ISOLATION approved=${approvedLabel} other=${otherLabel} tool=${operation} result=denied`);
    return;
  }
  if (result === null || envelope.error !== undefined) {
    runtime.isolation = "unknown";
    return fail("ISOLATION_RESPONSE_NOT_A_TOOL_DENIAL");
  }
  runtime.actualReads += 1;
  runtime.isolation = "unexpected";
  markFatal(runtime, "CROSS_CLIENT_APPROVAL_ISOLATION_FAILED");
  return fail("CROSS_CLIENT_APPROVAL_ISOLATION_FAILED_STOP_WITHOUT_CONTENT_OUTPUT");
}

async function checkRevocation(runtime: Runtime, flow: ClientFlow): Promise<void> {
  if (flow.token === null || flow.revoked) return fail("REVOCATION_CHECK_TOKEN_UNAVAILABLE");
  if (flow.tokenExpiresAt === null || flow.tokenExpiresAt <= Date.now()) return fail("REVOCATION_CHECK_TOKEN_EXPIRED");
  if (flow.revocationChecks >= 3) return fail("REVOCATION_CHECK_LIMIT_REACHED");
  flow.revocationChecks += 1;
  let result: Readonly<{ response: WireResponse; requestId: string }>;
  try {
    result = await mcpRequest(runtime, flow, flow.token, "tools/list");
  } catch {
    return fail("REVOCATION_CHECK_OUTCOME_UNKNOWN");
  }
  if (result.response.status === 401) {
    flow.token = null;
    flow.tokenExpiresAt = null;
    flow.revoked = true;
    console.log(`REVOKE client=${flow.label} result=unauthorized token=cleared`);
    return;
  }
  if (result.response.status === 200) {
    console.error(`REVOKE client=${flow.label} result=still-authorized; revoke it in the Owner page before retrying this check.`);
    return;
  }
  return fail(`REVOCATION_CHECK_HTTP_${result.response.status}`);
}

function contentTypeClass(headers: Headers): string {
  return mediaType(headers) || "missing";
}

function nginxHtml429(body: string, headers: Headers): boolean {
  const signature = /<title>\s*429\s+Too Many Requests\s*<\/title>/iu.test(body)
    && /<center>\s*nginx\s*<\/center>/iu.test(body);
  const serverHeader = (headers.get("server") ?? "").toLowerCase().includes("nginx");
  return mediaType(headers) === "text/html" && (signature || serverHeader);
}

async function probePeerRateLimit(runtime: Runtime): Promise<void> {
  if (runtime.fatal) return fail("RUN_STOPPED_AFTER_SECURITY_FAILURE");
  if (runtime.peerLimit !== "notRun") return fail("PEER_LIMIT_PROBE_ALREADY_RUN");
  if (runtime.flows.some((flow) => flow.callbackStatus !== "ready" || flow.token === null || !flow.toolsListed
    || flow.tokenExpiresAt === null || flow.tokenExpiresAt <= Date.now())) {
    return fail("PEER_LIMIT_PROBE_REQUIRES_BOTH_CONSENTS");
  }
  const flow = flowByLabel(runtime, "A");
  for (let index = 1; index <= 6; index += 1) {
    const params = new URLSearchParams({
      response_type: "invalid",
      client_id: flow.fixture.client_id,
      redirect_uri: flow.redirectUri,
      state: randomBytes(24).toString("base64url"),
      code_challenge: randomBytes(32).toString("base64url"),
      code_challenge_method: "S256",
      resource: PRODUCTION_RESOURCE,
      scope: "project:read",
    });
    const headers = new Headers({ "x-forwarded-for": `198.51.100.${index}` });
    let response: WireResponse;
    try {
      response = await send(runtime, flow, `/oauth/authorize?${params.toString()}`, "GET", undefined, headers);
    } catch {
      runtime.peerLimit = "incomplete";
      return fail("PEER_LIMIT_PROBE_OUTCOME_UNKNOWN_STOP");
    }
    if (response.status === 429) {
      runtime.peerLimit = nginxHtml429(response.body, response.headers) ? "nginxHtml429"
        : mediaType(response.headers) === "application/json" ? "applicationJson429" : "other429";
      const layer = runtime.peerLimit === "nginxHtml429" ? "nginx-html"
        : runtime.peerLimit === "applicationJson429" ? "application-json" : "unclassified";
      console.log(`PEER_LIMIT result=429 requests=${index} contentType=${contentTypeClass(response.headers)} layer=${layer}`);
      return;
    }
    if (response.status !== 400 || mediaType(response.headers) !== "application/json") {
      runtime.peerLimit = "incomplete";
      return fail(`PEER_LIMIT_PROBE_STOPPED status=${response.status} contentType=${contentTypeClass(response.headers)}`);
    }
    const errorBody = safeJson(response.body, "PEER_LIMIT_PROBE_RESPONSE_INVALID");
    if (errorBody.error !== "invalid_request") {
      runtime.peerLimit = "incomplete";
      return fail("PEER_LIMIT_PROBE_RESPONSE_NOT_EXPECTED_STOP");
    }
  }
  runtime.peerLimit = "no429";
  console.log("PEER_LIMIT result=no-429-within-bound requests=6");
}

function completedReads(runtime: Runtime): number {
  return runtime.flows.flatMap((flow) => OPERATION_NAMES.map((operation) => flow.calls[operation]))
    .filter((state) => state === "returnedSuccess").length;
}

function printStatus(runtime: Runtime): void {
  for (const flow of runtime.flows) {
    const operations = OPERATION_NAMES.map((operation) => `${operation}:${flow.calls[operation]}/${flow.replays[operation]}`).join(" ");
    const tokenState = flow.token === null ? flow.revoked ? "revoked" : "none" : "in-memory";
    console.log(`STATUS client=${flow.label} callback=${flow.callbackStatus} token=${tokenState} lifecycle=${flow.protocolNegotiated ? flow.protocolVersion : "pending"} session=${flow.sessionId === null ? "none" : "retained-in-memory"} codeReplay=${flow.codeReplayRejected ? "rejected" : "pending"} tools=${flow.toolsListed ? "verified" : "pending"} reads=[${operations}]`);
  }
  console.log(`STATUS isolation=${runtime.isolation} peerLimit=${runtime.peerLimit} actualReads=${runtime.actualReads} successfulReads=${completedReads(runtime)} fatal=${runtime.fatalCode ?? "none"}`);
}

function printSummary(runtime: Runtime): boolean {
  const eachClientComplete = runtime.flows.every((flow) => flow.callbackStatus === "ready"
      && flow.codeReplayRejected && flow.protocolNegotiated && flow.toolsListed && flow.summaryVerified
      && OPERATION_NAMES.every((operation) => flow.calls[operation] === "returnedSuccess" && flow.replays[operation] === "denied")
      && flow.revoked);
  const complete = eachClientComplete && runtime.isolation === "passed" && runtime.actualReads === 6 && !runtime.fatal;
  console.log(`SUMMARY status=${complete ? "CLIENT_PROTOCOL_CRITERIA_COMPLETE" : "INCOMPLETE"} actualReads=${runtime.actualReads} successfulReads=${completedReads(runtime)} expectedReads=6 codeReplayRejected=${runtime.flows.filter((flow) => flow.codeReplayRejected).length}/2 approvalReplayDenied=${runtime.flows.flatMap((flow) => OPERATION_NAMES.map((operation) => flow.replays[operation])).filter((state) => state === "denied").length}/6 crossClientIsolation=${runtime.isolation} revoked=${runtime.flows.filter((flow) => flow.revoked).length}/2 peerLimit=${runtime.peerLimit}`);
  if (complete) console.log("This reports the external client protocol checks only; verify production audit records and other release gates separately.");
  return complete;
}

function usage(): void {
  console.log("Commands:");
  console.log("  status");
  console.log("  read A|B project_summary|project_evidence|project_plan");
  console.log("  isolation A B project_summary CONFIRM_A_APPROVED_B_NOT_APPROVED");
  console.log("  revoke-check A|B CONFIRM_REVOKED_ACCESS_CHECK");
  console.log("  peer-limit CONFIRM_SIX_OAUTH_AUTHORIZE_PROBE");
  console.log("  summary");
  console.log("  quit");
  console.log("For each read: manually approve that exact operation in the production Owner page, then enter one `read` command. This sends one MCP call followed by one replay check; the runner will never retry a tool call.");
  console.log("For approval records, identify the recipient as the synthetic Node protocol harness and use `protocol-only; no model` for the model field.");
  console.log("Peer-limit sends at most six malformed /oauth/authorize requests, only after both consents, and stops at the first 429 or unexpected response.");
}

async function handleCommand(runtime: Runtime, line: string): Promise<boolean> {
  const tokens = line.trim().split(/\s+/u).filter(Boolean);
  if (tokens.length === 0) return false;
  if (tokens[0] === "quit" && tokens.length === 1) return true;
  if (tokens[0] === "help" && tokens.length === 1) {
    usage();
    return false;
  }
  if (tokens[0] === "status" && tokens.length === 1) {
    printStatus(runtime);
    return false;
  }
  if (tokens[0] === "summary" && tokens.length === 1) {
    if (!printSummary(runtime)) process.exitCode = runtime.interrupted ? 130 : 1;
    return false;
  }
  if (tokens[0] === "read" && tokens.length === 3) {
    const label = parseClientLabel(tokens[1]);
    const operation = parseOperation(tokens[2]);
    if (label === null || operation === null) return fail("READ_COMMAND_INVALID");
    if (runtime.fatal) return fail("RUN_STOPPED_AFTER_SECURITY_FAILURE");
    await callOneApprovedRead(runtime, flowByLabel(runtime, label), operation);
    return false;
  }
  if (tokens[0] === "isolation" && tokens.length === 5 && tokens[4] === "CONFIRM_A_APPROVED_B_NOT_APPROVED") {
    const approved = parseClientLabel(tokens[1]);
    const other = parseClientLabel(tokens[2]);
    const operation = parseOperation(tokens[3]);
    if (approved === null || other === null || operation === null) return fail("ISOLATION_COMMAND_INVALID");
    if (runtime.fatal) return fail("RUN_STOPPED_AFTER_SECURITY_FAILURE");
    await checkCrossClientIsolation(runtime, approved, other, operation);
    return false;
  }
  if (tokens[0] === "revoke-check" && tokens.length === 3 && tokens[2] === "CONFIRM_REVOKED_ACCESS_CHECK") {
    const label = parseClientLabel(tokens[1]);
    if (label === null) return fail("REVOCATION_COMMAND_INVALID");
    await checkRevocation(runtime, flowByLabel(runtime, label));
    return false;
  }
  if (tokens[0] === "peer-limit" && tokens.length === 2 && tokens[1] === "CONFIRM_SIX_OAUTH_AUTHORIZE_PROBE") {
    await probePeerRateLimit(runtime);
    return false;
  }
  return fail("COMMAND_INVALID_RUN_HELP");
}

async function startInteractive(runtime: Runtime): Promise<void> {
  const readline = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const interrupt = () => {
    runtime.interrupted = true;
    runtime.shutdown.abort();
    readline.close();
  };
  readline.on("SIGINT", interrupt);
  const onProcessInterrupt = () => interrupt();
  process.once("SIGINT", onProcessInterrupt);
  usage();
  process.stdout.write("mcp-production-acceptance> ");
  try {
    for await (const line of readline) {
      try {
        const shouldQuit = await handleCommand(runtime, line);
        if (shouldQuit) {
          readline.close();
          break;
        }
      } catch (error) {
        const code = error instanceof AcceptanceFailure ? error.code : "COMMAND_FAILED";
        console.error(`ERROR ${code}`);
      }
      if (!runtime.interrupted) process.stdout.write("mcp-production-acceptance> ");
    }
  } finally {
    process.removeListener("SIGINT", onProcessInterrupt);
    readline.close();
  }
}

async function closeServer(server: Server | null): Promise<void> {
  if (server === null || !server.listening) return;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function cleanup(runtime: Runtime): Promise<void> {
  runtime.shutdown.abort();
  for (const request of runtime.activeRequests) request.destroy();
  for (const flow of runtime.flows) {
    if (flow.callbackTimer !== null) clearTimeout(flow.callbackTimer);
    flow.state = null;
    flow.verifier = null;
    flow.authorizationUrl = null;
    flow.callbackCode = null;
    flow.token = null;
    flow.tokenExpiresAt = null;
    flow.sessionId = null;
  }
  await Promise.all(runtime.flows.map((flow) => closeServer(flow.callbackServer)));
}

async function main(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("This production acceptance runner requires an interactive terminal.");
    process.exitCode = 2;
    return;
  }
  let projectId: string;
  try {
    projectId = parseArguments(process.argv.slice(2));
  } catch {
    return;
  }

  const flows: readonly ClientFlow[] = [
    flowFor("A", "fetch", "2025-11-25", 49_152, clientAMetadata),
    flowFor("B", "node-https", "2026-07-28", 49_153, clientBMetadata),
  ];
  const runtime: Runtime = {
    projectId,
    flows,
    shutdown: new AbortController(),
    activeRequests: new Set(),
    fatal: false,
    fatalCode: null,
    interrupted: false,
    actualReads: 0,
    isolation: "notAttempted",
    peerLimit: "notRun",
  };

  try {
    for (const flow of flows) await startCallbackListener(runtime, flow);
    for (const flow of flows) await discoverProductionEndpoints(runtime, flow);
    const authorizationUrls = flows.map((flow) => authorizationUrlFor(flow));
    console.log(`PRODUCTION_ORIGIN ${PRODUCTION_ORIGIN}`);
    console.log(`PROJECT_OWNER_PAGE ${PRODUCTION_ORIGIN}/projects/${projectId}/mcp-export`);
    console.log("Two loopback listeners are ready. Open each authorization URL in a browser session signed in as the project Owner; inspect the exact client, redirect URI, scope, and project before granting.");
    for (const [index, flow] of flows.entries()) {
      console.log(`CLIENT_${flow.label}_AUTHORIZATION_URL ${authorizationUrls[index]}`);
      console.log(`CLIENT_${flow.label} transport=${flow.transport} protocol=${flow.protocolVersion} redirect=${flow.redirectUri} metadata=${flow.fixture.client_id}`);
    }
    await startInteractive(runtime);
    printSummary(runtime);
  } catch (error) {
    const code = error instanceof AcceptanceFailure ? error.code : "PRODUCTION_ACCEPTANCE_SETUP_FAILED";
    console.error(`FATAL ${code}`);
    process.exitCode = 1;
  } finally {
    await cleanup(runtime);
  }
}

void main().catch(() => {
  console.error("FATAL PRODUCTION_ACCEPTANCE_SETUP_FAILED");
  process.exitCode = 1;
});
