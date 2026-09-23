import { createHash, randomUUID } from "node:crypto";
import { WebSourceError, securePinnedHttpRequest, type SecurePinnedRequestDispatchResult } from "@/lib/web-sources";
import { APP_VERSION } from "@/lib/version";
import { McpCapabilityError, failMcp } from "./errors";
import {
  canonicalMcpToolArguments,
  encodeMcpNameHeader,
  mcpArgumentHeaders,
  normalizeMcpToolDefinition,
  sanitizeMcpToolResult,
  stableMcpJson,
  type JsonValue,
  type NormalizedMcpTool,
} from "./schema";

export const MCP_PROTOCOL_VERSION = "2026-07-28" as const;
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_TOOL_COUNT = 100;
const MAX_PAGES = 10;
const MAX_RESULT_TEXT = 64 * 1024;
const MAX_RESULT_JSON = 64 * 1024;

type RpcResponse = Readonly<{ jsonrpc: "2.0"; id: string; result?: unknown; error?: Readonly<{ code: number; message: string }> }>;

export type McpDiscoveryResult = Readonly<{
  tools: readonly NormalizedMcpTool[];
  rejectedCount: number;
  catalogFingerprint: string;
  addressFingerprint: string;
  protocolVersion: typeof MCP_PROTOCOL_VERSION;
}>;

export type McpToolCallResult = Readonly<{
  text: string | null;
  structuredContent: JsonValue | null;
  omittedContentCount: number;
  resultFingerprint: string;
  resultBytes?: number;
  resultNodes?: number;
  resultDepth?: number;
}>;

export type McpDetailedToolCallResult = Readonly<{
  outcome: "succeeded" | "failed" | "unknown";
  requestId: string;
  result?: McpToolCallResult;
  safeErrorCode?: string;
  httpStatus: number | null;
}>;

export type McpDispatchBoundary = () => void | boolean | Promise<void | boolean>;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mapTransportError(error: unknown): never {
  if (error instanceof McpCapabilityError) throw error;
  if (error instanceof WebSourceError) {
    if (error.code === "WEB_SOURCE_NETWORK_BLOCKED") return failMcp("MCP_NETWORK_BLOCKED");
    if (error.code === "WEB_SOURCE_NETWORK_CHANGED") return failMcp("MCP_NETWORK_CHANGED");
    if (error.code === "WEB_SOURCE_REQUEST_BOUNDARY_REJECTED") return failMcp("MCP_CONNECTION_CONFLICT");
    if (error.code === "WEB_SOURCE_TOO_LARGE") return failMcp("MCP_RESPONSE_TOO_LARGE");
  }
  return failMcp("MCP_TRANSPORT_FAILED");
}

function rpcMetadata(): Readonly<Record<string, unknown>> {
  return Object.freeze({
    "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
    "io.modelcontextprotocol/clientInfo": Object.freeze({ name: "AI Project OS", version: APP_VERSION }),
    "io.modelcontextprotocol/clientCapabilities": Object.freeze({}),
  });
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value); }
  catch { return failMcp("MCP_RESPONSE_INVALID"); }
}

function parseSse(body: string, expectedId: string): unknown {
  let matched: unknown;
  for (const block of body.split(/\r?\n\r?\n/u)) {
    const data = block.split(/\r?\n/u)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /u, ""))
      .join("\n");
    if (data.length === 0) continue;
    const value = parseJson(data);
    if (isObject(value) && value.id === expectedId) matched = value;
  }
  return matched ?? failMcp("MCP_RESPONSE_INVALID");
}

function parseDetailedRpcResponse(body: Buffer, contentType: string, expectedId: string): RpcResponse {
  const text = body.toString("utf8");
  if (/^application\/(?:[A-Za-z0-9.+-]*\+)?json(?:\s*;|$)/iu.test(contentType)) {
    return parseRpcResponse(body, contentType, expectedId);
  }
  if (!/^text\/event-stream(?:\s*;|$)/iu.test(contentType)) return failMcp("MCP_RESPONSE_INVALID");
  let matched: RpcResponse | null = null;
  let dataSeen = false;
  for (const block of text.split(/\r?\n\r?\n/u)) {
    const data = block.split(/\r?\n/u)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /u, ""))
      .join("\n");
    if (data.length === 0) continue;
    dataSeen = true;
    const value = parseJson(data);
    if (!isObject(value) || value.jsonrpc !== "2.0" || value.id !== expectedId || (value.result === undefined) === (value.error === undefined)) {
      return failMcp("MCP_RESPONSE_INVALID");
    }
    if (matched !== null) return failMcp("MCP_RESPONSE_INVALID");
    matched = value as RpcResponse;
  }
  if (!dataSeen || matched === null) return failMcp("MCP_RESPONSE_INVALID");
  return matched;
}

function parseRpcResponse(body: Buffer, contentType: string, expectedId: string): RpcResponse {
  const text = body.toString("utf8");
  const value = /^application\/(?:[A-Za-z0-9.+-]*\+)?json(?:\s*;|$)/iu.test(contentType)
    ? parseJson(text)
    : /^text\/event-stream(?:\s*;|$)/iu.test(contentType)
      ? parseSse(text, expectedId)
      : failMcp("MCP_RESPONSE_INVALID");
  if (!isObject(value) || value.jsonrpc !== "2.0" || value.id !== expectedId || (value.result === undefined) === (value.error === undefined)) {
    return failMcp("MCP_RESPONSE_INVALID");
  }
  if (value.error !== undefined) {
    if (!isObject(value.error) || typeof value.error.code !== "number" || typeof value.error.message !== "string") return failMcp("MCP_RESPONSE_INVALID");
    return Object.freeze({ jsonrpc: "2.0", id: expectedId, error: Object.freeze({ code: value.error.code, message: value.error.message.slice(0, 500) }) });
  }
  return Object.freeze({ jsonrpc: "2.0", id: expectedId, result: value.result });
}

async function rpcRequest(input: Readonly<{
  endpointUrl: string;
  allowPrivateNetwork: boolean;
  expectedAddressFingerprint: string | null;
  bearerToken: string | null;
  method: "initialize" | "tools/list" | "tools/call";
  params: Readonly<Record<string, unknown>>;
  sessionId?: string | null;
  name?: string;
  extraHeaders?: Readonly<Record<string, string>>;
  /** Called after DNS/fingerprint admission, before each request is built. */
  onDispatchBoundary?: McpDispatchBoundary;
  /** Read the saved credential only after the dispatch boundary succeeds. */
  readBearerToken?: () => Promise<string | null>;
}>): Promise<Readonly<{ result: unknown; addressFingerprint: string; sessionId: string | null }>> {
  const id = randomUUID();
  const params = { ...input.params, _meta: rpcMetadata() };
  const body = JSON.stringify({ jsonrpc: "2.0", id, method: input.method, params });
  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
    "accept-encoding": "identity",
    "content-type": "application/json",
    "mcp-protocol-version": MCP_PROTOCOL_VERSION,
    "mcp-method": input.method,
    "user-agent": "AI-Project-OS-MCP/3.2",
    ...input.extraHeaders,
  };
  if (input.sessionId !== undefined && input.sessionId !== null) headers["mcp-session-id"] = input.sessionId;
  if (input.name !== undefined) headers["mcp-name"] = encodeMcpNameHeader(input.name);
  if (input.onDispatchBoundary === undefined && input.readBearerToken === undefined && input.bearerToken !== null) {
    headers.authorization = `Bearer ${input.bearerToken}`;
  }
  try {
    const response = await securePinnedHttpRequest({
      url: input.endpointUrl,
      allowPrivateNetwork: input.allowPrivateNetwork,
      expectedFingerprint: input.expectedAddressFingerprint,
      method: "POST",
      headers,
      body,
      maximumResponseBytes: MAX_RESPONSE_BYTES,
      onRequestBodyWriteStart: input.onDispatchBoundary === undefined && input.readBearerToken === undefined
        ? undefined
        : async (): Promise<SecurePinnedRequestDispatchResult | boolean> => {
          const accepted = await input.onDispatchBoundary?.() ?? true;
          if (!accepted) return false;
          const bearerToken = input.readBearerToken === undefined ? input.bearerToken : await input.readBearerToken();
          if (bearerToken === null) return {};
          return { headers: { ...headers, authorization: `Bearer ${bearerToken}` } };
        },
    });
    if (response.status === 400 || response.status === 404 || response.status === 405) {
      const maybe = (() => { try { return parseRpcResponse(response.body, response.headers["content-type"] ?? "application/json", id); } catch { return null; } })();
      if (maybe?.error?.code === -32601 || maybe === null) return failMcp("MCP_PROTOCOL_UNSUPPORTED");
    }
    if (response.status < 200 || response.status >= 300) return failMcp("MCP_TRANSPORT_FAILED");
    const rpc = parseRpcResponse(response.body, response.headers["content-type"] ?? "", id);
    if (rpc.error !== undefined) {
      if (input.method === "tools/call") return failMcp("MCP_TOOL_CALL_FAILED");
      if (input.method === "initialize") return failMcp("MCP_PROTOCOL_UNSUPPORTED");
      return failMcp("MCP_TOOL_CATALOG_INVALID");
    }
    return Object.freeze({ result: rpc.result, addressFingerprint: response.fingerprint, sessionId: response.headers["mcp-session-id"] ?? null });
  } catch (error) {
    return mapTransportError(error);
  }
}

export async function initializeMcpSession(input: Readonly<{
  endpointUrl: string;
  allowPrivateNetwork: boolean;
  expectedAddressFingerprint: string | null;
  bearerToken: string | null;
  onDispatchBoundary?: McpDispatchBoundary;
  readBearerToken?: () => Promise<string | null>;
}>): Promise<Readonly<{ protocolVersion: typeof MCP_PROTOCOL_VERSION; sessionId: string | null; addressFingerprint: string }>> {
  const response = await rpcRequest({
    ...input,
    method: "initialize",
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "AI Project OS", version: APP_VERSION },
    },
  });
  if (!isObject(response.result) || response.result.protocolVersion !== MCP_PROTOCOL_VERSION || !isObject(response.result.serverInfo)) return failMcp("MCP_PROTOCOL_UNSUPPORTED");
  if (response.sessionId !== null && (response.sessionId.length < 1 || response.sessionId.length > 256 || /[\u0000-\u001f\u007f]/u.test(response.sessionId))) return failMcp("MCP_RESPONSE_INVALID");
  return Object.freeze({ protocolVersion: MCP_PROTOCOL_VERSION, sessionId: response.sessionId, addressFingerprint: response.addressFingerprint });
}

export async function discoverMcpTools(input: Readonly<{
  endpointUrl: string;
  allowPrivateNetwork: boolean;
  expectedAddressFingerprint: string | null;
  bearerToken: string | null;
  sessionId?: string | null;
  onDispatchBoundary?: McpDispatchBoundary;
  readBearerToken?: () => Promise<string | null>;
}>): Promise<McpDiscoveryResult> {
  const definitions = new Map<string, NormalizedMcpTool>();
  let rejectedCount = 0;
  let cursor: string | undefined;
  let addressFingerprint: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await rpcRequest({ ...input, method: "tools/list", params: cursor === undefined ? {} : { cursor } });
    if (addressFingerprint !== null && addressFingerprint !== response.addressFingerprint) return failMcp("MCP_NETWORK_CHANGED");
    addressFingerprint = response.addressFingerprint;
    if (!isObject(response.result) || response.result.resultType !== "complete" || !Array.isArray(response.result.tools)) return failMcp("MCP_TOOL_CATALOG_INVALID");
    for (const raw of response.result.tools) {
      try {
        const tool = normalizeMcpToolDefinition(raw);
        if (definitions.has(tool.name)) return failMcp("MCP_TOOL_CATALOG_INVALID");
        definitions.set(tool.name, tool);
      } catch (error) {
        if (!(error instanceof McpCapabilityError) || error.code !== "MCP_TOOL_CATALOG_INVALID") throw error;
        rejectedCount += 1;
      }
      if (definitions.size + rejectedCount > MAX_TOOL_COUNT) return failMcp("MCP_TOOL_CATALOG_INVALID");
    }
    const nextCursor = response.result.nextCursor;
    if (nextCursor === undefined || nextCursor === null || nextCursor === "") break;
    if (typeof nextCursor !== "string" || nextCursor.length > 1024 || nextCursor === cursor) return failMcp("MCP_TOOL_CATALOG_INVALID");
    cursor = nextCursor;
    if (page === MAX_PAGES - 1) return failMcp("MCP_TOOL_CATALOG_INVALID");
  }
  const tools = [...definitions.values()].sort((left, right) => left.name.localeCompare(right.name));
  const catalogFingerprint = createHash("sha256")
    .update(tools.map((tool) => `${tool.name}:${tool.definitionFingerprint}`).join("\n"), "utf8")
    .digest("hex");
  return Object.freeze({ tools: Object.freeze(tools), rejectedCount, catalogFingerprint, addressFingerprint: addressFingerprint ?? failMcp("MCP_TOOL_CATALOG_INVALID"), protocolVersion: MCP_PROTOCOL_VERSION });
}

export async function callMcpTool(input: Readonly<{
  endpointUrl: string;
  allowPrivateNetwork: boolean;
  expectedAddressFingerprint: string;
  bearerToken: string | null;
  toolName: string;
  inputSchema: unknown;
  arguments: unknown;
}>): Promise<McpToolCallResult> {
  const argumentsValue = canonicalMcpToolArguments(input.inputSchema, input.arguments);
  const response = await rpcRequest({
    endpointUrl: input.endpointUrl,
    allowPrivateNetwork: input.allowPrivateNetwork,
    expectedAddressFingerprint: input.expectedAddressFingerprint,
    bearerToken: input.bearerToken,
    method: "tools/call",
    name: input.toolName,
    params: { name: input.toolName, arguments: argumentsValue },
    extraHeaders: mcpArgumentHeaders(input.inputSchema, argumentsValue),
  });
  if (!isObject(response.result)) return failMcp("MCP_RESPONSE_INVALID");
  if (response.result.resultType === "input_required") return failMcp("MCP_TOOL_INPUT_REQUIRED_UNSUPPORTED");
  if (response.result.resultType !== "complete" || response.result.isError === true) return failMcp("MCP_TOOL_CALL_FAILED");
  if (!Array.isArray(response.result.content)) return failMcp("MCP_RESPONSE_INVALID");
  const textParts: string[] = [];
  let omittedContentCount = 0;
  for (const item of response.result.content) {
    if (isObject(item) && item.type === "text" && typeof item.text === "string") textParts.push(item.text);
    else omittedContentCount += 1;
  }
  let text = textParts.join("\n\n");
  if (Buffer.byteLength(text, "utf8") > MAX_RESULT_TEXT) {
    text = Buffer.from(text, "utf8").subarray(0, MAX_RESULT_TEXT).toString("utf8");
    omittedContentCount += 1;
  }
  const structuredContent = response.result.structuredContent === undefined ? null : stableMcpJson(response.result.structuredContent);
  if (structuredContent !== null && Buffer.byteLength(JSON.stringify(structuredContent), "utf8") > MAX_RESULT_JSON) return failMcp("MCP_RESPONSE_TOO_LARGE");
  const normalized = { text: text || null, structuredContent, omittedContentCount };
  const resultFingerprint = createHash("sha256").update(JSON.stringify(normalized), "utf8").digest("hex");
  return Object.freeze({ ...normalized, resultFingerprint });
}

function safeDetailedErrorCode(error: unknown): string {
  if (error instanceof McpCapabilityError) return error.code;
  if (error instanceof WebSourceError) return error.code;
  return "MCP_TRANSPORT_FAILED";
}

function detailedTransportOutcome(error: unknown, requestId: string, boundaryReached: boolean, httpStatus: number | null = null): McpDetailedToolCallResult {
  const code = safeDetailedErrorCode(error);
  if (code === "WEB_SOURCE_REQUEST_BOUNDARY_REJECTED") {
    return Object.freeze({ outcome: "unknown", requestId, safeErrorCode: "MCP_DISPATCH_RESERVATION_STALE", httpStatus });
  }
  if (boundaryReached) {
    return Object.freeze({ outcome: "unknown", requestId, safeErrorCode: code, httpStatus });
  }
  return Object.freeze({ outcome: "failed", requestId, safeErrorCode: code, httpStatus });
}

/**
 * One-shot detailed client for a single-use MCP dispatch. It deliberately
 * does not accept redirects, retries, or an internally generated request id.
 * A request-scoped JSON or SSE response must contain exactly the persisted id;
 * legacy standalone SSE transport is not used.
 */
export async function callMcpToolDetailed(input: Readonly<{
  endpointUrl: string;
  allowPrivateNetwork: boolean;
  expectedAddressFingerprint: string;
  bearerToken: string | null;
  rpcRequestId: string;
  toolName: string;
  inputSchema: unknown;
  outputSchema?: unknown;
  arguments: unknown;
  onDispatchBoundary: McpDispatchBoundary;
}>): Promise<McpDetailedToolCallResult> {
  const requestId = input.rpcRequestId;
  let boundaryReached = false;
  try {
    // Canonicalization and header binding are deterministic pre-boundary
    // checks. A rejected input therefore cannot become an unknown attempt.
    const argumentsValue = canonicalMcpToolArguments(input.inputSchema, input.arguments);
    const params = { name: input.toolName, arguments: argumentsValue, _meta: rpcMetadata() };
    const body = JSON.stringify({ jsonrpc: "2.0", id: requestId, method: "tools/call", params });
    const headers: Record<string, string> = {
      accept: "application/json, text/event-stream",
      "accept-encoding": "identity",
      "content-type": "application/json",
      "mcp-protocol-version": MCP_PROTOCOL_VERSION,
      "mcp-method": "tools/call",
      "user-agent": "AI-Project-OS-MCP/3.2",
      "mcp-name": encodeMcpNameHeader(input.toolName),
      ...mcpArgumentHeaders(input.inputSchema, argumentsValue),
    };
    if (input.bearerToken !== null) headers.authorization = `Bearer ${input.bearerToken}`;
    const response = await securePinnedHttpRequest({
      url: input.endpointUrl,
      allowPrivateNetwork: input.allowPrivateNetwork,
      expectedFingerprint: input.expectedAddressFingerprint,
      method: "POST",
      headers,
      body,
      maximumResponseBytes: MAX_RESPONSE_BYTES,
      onRequestBodyWriteStart: async () => {
        const accepted = await input.onDispatchBoundary();
        if (accepted === false) return false;
        boundaryReached = true;
        return true;
      },
    });
    const contentType = response.headers["content-type"] ?? "";
    let rpc: RpcResponse;
    try { rpc = parseDetailedRpcResponse(response.body, contentType, requestId); }
    catch (error) { return detailedTransportOutcome(error, requestId, boundaryReached, response.status); }
    if (response.status < 200 || response.status >= 300) {
      if (rpc.error !== undefined) {
        return Object.freeze({ outcome: "failed", requestId, safeErrorCode: "MCP_TOOL_CALL_FAILED", httpStatus: response.status });
      }
      return detailedTransportOutcome(new McpCapabilityError("MCP_TRANSPORT_FAILED"), requestId, true, response.status);
    }
    if (rpc.error !== undefined) {
      return Object.freeze({ outcome: "failed", requestId, safeErrorCode: "MCP_TOOL_CALL_FAILED", httpStatus: response.status });
    }
    const value = rpc.result;
    if (!isObject(value)) return detailedTransportOutcome(new McpCapabilityError("MCP_RESPONSE_INVALID"), requestId, true, response.status);
    if (value.resultType === "input_required") return Object.freeze({ outcome: "failed", requestId, safeErrorCode: "MCP_TOOL_INPUT_REQUIRED_UNSUPPORTED", httpStatus: response.status });
    if (value.resultType !== "complete" || value.isError === true || !Array.isArray(value.content)) {
      return Object.freeze({ outcome: "failed", requestId, safeErrorCode: "MCP_TOOL_CALL_FAILED", httpStatus: response.status });
    }
    const textParts: string[] = [];
    let omittedContentCount = 0;
    for (const item of value.content) {
      if (isObject(item) && item.type === "text" && typeof item.text === "string") textParts.push(item.text);
      else omittedContentCount += 1;
    }
    const sanitized = sanitizeMcpToolResult({
      text: textParts.length === 0 ? null : textParts.join("\n\n"),
      structuredContent: value.structuredContent === undefined ? null : value.structuredContent,
      omittedContentCount,
      outputSchema: input.outputSchema,
    });
    return Object.freeze({
      outcome: "succeeded",
      requestId,
      httpStatus: response.status,
      result: Object.freeze({
        text: sanitized.payload && isObject(sanitized.payload) && typeof sanitized.payload.text === "string" ? sanitized.payload.text : null,
        structuredContent: sanitized.payload && isObject(sanitized.payload) && sanitized.payload.structuredContent !== null ? sanitized.payload.structuredContent as JsonValue : null,
        omittedContentCount: sanitized.omittedContentCount,
        resultFingerprint: sanitized.resultFingerprint,
        resultBytes: sanitized.resultBytes,
        resultNodes: sanitized.resultNodes,
        resultDepth: sanitized.resultDepth,
      }),
    });
  } catch (error) {
    if (error instanceof McpCapabilityError && error.code === "MCP_TOOL_OUTPUT_INVALID") {
      return Object.freeze({ outcome: "failed", requestId, safeErrorCode: error.code, httpStatus: null });
    }
    return detailedTransportOutcome(error, requestId, boundaryReached, null);
  }
}

// Explicit alias used by dispatch callers and contract tests.
export const callMcpToolSingleUse = callMcpToolDetailed;
