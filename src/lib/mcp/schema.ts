import { createHash } from "node:crypto";
import { McpCapabilityError, failMcp } from "./errors";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/u;
const HEADER_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/u;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const MAX_SCHEMA_BYTES = 32 * 1024;
const MAX_ARGUMENT_BYTES = 64 * 1024;
const MAX_SCHEMA_DEPTH = 8;
const MAX_SCHEMA_NODES = 256;
export const MCP_RESULT_MAX_DEPTH = 8;
export const MCP_RESULT_MAX_NODES = 256;
export const MCP_RESULT_MAX_STRING_BYTES = 64 * 1024;
export const MCP_RESULT_MAX_BYTES = 64 * 1024;

const SENSITIVE_RESULT_KEY = /(?:authorization|cookie|set-cookie|bearer|token|secret|password|credential|api[-_ ]?key|private[-_ ]?key|access[-_ ]?(?:key|token)|refresh[-_ ]?(?:key|token)|client[-_ ]?(?:secret|key))/iu;
const SENSITIVE_RESULT_FIELD_SOURCE = String.raw`(?:authorization|proxy-authorization|bearer|access(?:[_ -]?token|[_ -]?key)|refresh(?:[_ -]?token|[_ -]?key)|client(?:[_ -]?secret|[_ -]?key)|api(?:[_ -]?key)|private(?:[_ -]?key)|cookie|set-cookie|token|secret|password|credential)`;
const SENSITIVE_RESULT_TRIGGER = new RegExp(String.raw`\b${SENSITIVE_RESULT_FIELD_SOURCE}\b`, "iu");
const ENCODED_ASCII = /\\+u00[0-7][0-9a-f]/iu;
const AMBIGUOUS_RESULT_ENCODING = /[<>]|\\|&(?:#|[a-z])|%(?:[0-9a-f]{2}|u(?:[0-9a-f]{4}|\{[0-9a-f]{1,6}\}))|\p{Cf}|\p{M}/iu;
const COMPACT_SENSITIVE_RESULT_TOKENS = Object.freeze([
  "authorization",
  "proxyauthorization",
  "bearer",
  "accesstoken",
  "accesskey",
  "refreshtoken",
  "refreshkey",
  "clientsecret",
  "clientkey",
  "apikey",
  "privatekey",
  "cookie",
  "setcookie",
  "token",
  "secret",
  "password",
  "credential",
]);
const UNSAFE_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const ALLOWED_SCHEMA_KEYS = new Set([
  "$schema", "type", "title", "description", "default", "examples", "enum", "const",
  "properties", "required", "additionalProperties", "items", "minItems", "maxItems",
  "uniqueItems", "minLength", "maxLength", "minimum", "maximum", "exclusiveMinimum",
  "exclusiveMaximum", "multipleOf", "minProperties", "maxProperties", "x-mcp-header",
]);

export type NormalizedMcpTool = Readonly<{
  name: string;
  title: string | null;
  description: string | null;
  inputSchema: JsonObject;
  outputSchema: JsonObject | null;
  annotations: JsonObject;
  /** Untrusted read-only/destructive hints supplied by the remote server. */
  remoteReadOnlyHint: boolean;
  /** @deprecated Use remoteReadOnlyHint. This compatibility alias is never an authorization signal. */
  readOnlyEligible: boolean;
  definitionFingerprint: string;
}>;

export type McpHeaderBinding = Readonly<{
  headerName: string;
  path: readonly string[];
  valueType: "string" | "integer" | "boolean";
}>;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toJsonValue(value: unknown, depth = 0): JsonValue {
  if (depth > 12) return failMcp("MCP_TOOL_CATALOG_INVALID");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((entry) => toJsonValue(entry, depth + 1));
  if (!isObject(value)) return failMcp("MCP_TOOL_CATALOG_INVALID");
  const output: JsonObject = {};
  for (const key of Object.keys(value).sort()) {
    if (key.length === 0 || key.length > 256 || CONTROL.test(key) || UNSAFE_OBJECT_KEYS.has(key)) return failMcp("MCP_TOOL_CATALOG_INVALID");
    output[key] = toJsonValue(value[key], depth + 1);
  }
  return output;
}

function stableJson(value: JsonValue): string {
  return JSON.stringify(value);
}

function shortText(value: unknown, maximum: number): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > maximum || CONTROL.test(value)) return failMcp("MCP_TOOL_CATALOG_INVALID");
  return value;
}

function integerKeyword(value: unknown, minimum: number, maximum: number): void {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) return failMcp("MCP_TOOL_CATALOG_INVALID");
}

function numberKeyword(value: unknown): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isFinite(value)) return failMcp("MCP_TOOL_CATALOG_INVALID");
}

function validateSchemaNode(value: unknown, state: { nodes: number }, depth: number, location: "root" | "property" | "items" | "additional"): JsonObject {
  if (!isObject(value) || depth > MAX_SCHEMA_DEPTH) return failMcp("MCP_TOOL_CATALOG_INVALID");
  state.nodes += 1;
  if (state.nodes > MAX_SCHEMA_NODES) return failMcp("MCP_TOOL_CATALOG_INVALID");
  for (const key of Object.keys(value)) if (!ALLOWED_SCHEMA_KEYS.has(key)) return failMcp("MCP_TOOL_CATALOG_INVALID");

  const type = value.type;
  if (type !== undefined && !["object", "array", "string", "number", "integer", "boolean", "null"].includes(String(type))) {
    return failMcp("MCP_TOOL_CATALOG_INVALID");
  }
  if (location === "root" && type !== "object") return failMcp("MCP_TOOL_CATALOG_INVALID");
  if (value.title !== undefined) shortText(value.title, 200);
  if (value.description !== undefined) shortText(value.description, 4000);
  if (value.examples !== undefined && !Array.isArray(value.examples)) return failMcp("MCP_TOOL_CATALOG_INVALID");
  if (value.enum !== undefined && (!Array.isArray(value.enum) || value.enum.length === 0 || value.enum.length > 128)) return failMcp("MCP_TOOL_CATALOG_INVALID");

  integerKeyword(value.minLength, 0, 65_536);
  integerKeyword(value.maxLength, 0, 65_536);
  integerKeyword(value.minItems, 0, 1_000);
  integerKeyword(value.maxItems, 0, 1_000);
  integerKeyword(value.minProperties, 0, 256);
  integerKeyword(value.maxProperties, 0, 256);
  numberKeyword(value.minimum);
  numberKeyword(value.maximum);
  numberKeyword(value.exclusiveMinimum);
  numberKeyword(value.exclusiveMaximum);
  numberKeyword(value.multipleOf);
  if (value.uniqueItems !== undefined && typeof value.uniqueItems !== "boolean") return failMcp("MCP_TOOL_CATALOG_INVALID");

  if (value.properties !== undefined) {
    if (type !== "object" || !isObject(value.properties) || Object.keys(value.properties).length > 128) return failMcp("MCP_TOOL_CATALOG_INVALID");
    for (const [key, child] of Object.entries(value.properties)) {
      if (key.length === 0 || key.length > 128 || CONTROL.test(key)) return failMcp("MCP_TOOL_CATALOG_INVALID");
      validateSchemaNode(child, state, depth + 1, "property");
    }
  }
  if (value.required !== undefined) {
    if (type !== "object" || !Array.isArray(value.required) || value.required.length > 128 || value.required.some((entry) => typeof entry !== "string") || new Set(value.required).size !== value.required.length) {
      return failMcp("MCP_TOOL_CATALOG_INVALID");
    }
  }
  if (value.additionalProperties !== undefined && typeof value.additionalProperties !== "boolean") {
    validateSchemaNode(value.additionalProperties, state, depth + 1, "additional");
  }
  if (value.items !== undefined) {
    if (type !== "array") return failMcp("MCP_TOOL_CATALOG_INVALID");
    validateSchemaNode(value.items, state, depth + 1, "items");
  }
  if (type === "array" && value.items === undefined) return failMcp("MCP_TOOL_CATALOG_INVALID");

  if (value["x-mcp-header"] !== undefined) {
    if (location !== "property" || !["string", "integer", "boolean"].includes(String(type)) || typeof value["x-mcp-header"] !== "string" || !HEADER_TOKEN.test(value["x-mcp-header"])) {
      return failMcp("MCP_TOOL_CATALOG_INVALID");
    }
  }
  return toJsonValue(value) as JsonObject;
}

export function normalizeMcpToolDefinition(value: unknown): NormalizedMcpTool {
  if (!isObject(value) || typeof value.name !== "string" || !TOOL_NAME.test(value.name)) return failMcp("MCP_TOOL_CATALOG_INVALID");
  const title = shortText(value.title, 200);
  const description = shortText(value.description, 4000);
  const inputSchema = validateSchemaNode(value.inputSchema, { nodes: 0 }, 0, "root");
  const outputSchema = value.outputSchema == null ? null : validateSchemaNode(value.outputSchema, { nodes: 0 }, 0, "root");
  const annotations = value.annotations == null ? {} : toJsonValue(value.annotations);
  if (!isObject(annotations)) return failMcp("MCP_TOOL_CATALOG_INVALID");
  if (Buffer.byteLength(stableJson(inputSchema), "utf8") > MAX_SCHEMA_BYTES || (outputSchema !== null && Buffer.byteLength(stableJson(outputSchema), "utf8") > MAX_SCHEMA_BYTES)) {
    return failMcp("MCP_TOOL_CATALOG_INVALID");
  }
  const normalizedAnnotations = annotations as JsonObject;
  const remoteReadOnlyHint = normalizedAnnotations.readOnlyHint === true && normalizedAnnotations.destructiveHint === false;
  const identity: JsonObject = {
    name: value.name,
    title,
    description,
    inputSchema,
    outputSchema,
    annotations: normalizedAnnotations,
  };
  const definitionFingerprint = createHash("sha256").update(stableJson(identity), "utf8").digest("hex");
  return Object.freeze({
    name: value.name,
    title,
    description,
    inputSchema,
    outputSchema,
    annotations: normalizedAnnotations,
    remoteReadOnlyHint,
    // Keep the old in-memory shape for callers that only render the remote hint.
    // Persistence and authorization use remoteReadOnlyHint plus an admin attestation.
    readOnlyEligible: remoteReadOnlyHint,
    definitionFingerprint,
  });
}

/**
 * Remote tool metadata is persisted as a capability definition. Reject a
 * definition if it contains a credential-shaped field or echoes the current
 * bearer token. This check intentionally fails closed instead of redacting a
 * tool definition into a different capability fingerprint.
 */
export function assertMcpToolDefinitionSafe(value: unknown, currentBearerToken: string | null = null): void {
  const visited = new WeakSet<object>();
  const visit = (candidate: unknown, depth: number): void => {
    if (depth > 12) return failMcp("MCP_TOOL_CATALOG_INVALID");
    if (typeof candidate === "string") {
      if (currentBearerToken !== null && currentBearerToken.length > 0 && candidate.includes(currentBearerToken)) {
        return failMcp("MCP_TOOL_CATALOG_INVALID");
      }
      // A credential assignment in free-form metadata is still a secret echo
      // even when the server does not use a sensitive JSON key.
      if (/(?:authorization|bearer|access(?:[_ -]?token|[_ -]?key)|refresh(?:[_ -]?token|[_ -]?key)|client(?:[_ -]?secret|[_ -]?key)|api(?:[_ -]?key)|private(?:[_ -]?key)|cookie|set-cookie|token|secret|password|credential)\s*[:=]\s*\S+/iu.test(candidate)) {
        return failMcp("MCP_TOOL_CATALOG_INVALID");
      }
      return;
    }
    if (candidate === null || typeof candidate !== "object") return;
    if (visited.has(candidate)) return failMcp("MCP_TOOL_CATALOG_INVALID");
    visited.add(candidate);
    if (Array.isArray(candidate)) {
      for (const entry of candidate) visit(entry, depth + 1);
      return;
    }
    for (const [key, entry] of Object.entries(candidate)) {
      if (key.length === 0 || key.length > 256 || CONTROL.test(key) || UNSAFE_OBJECT_KEYS.has(key) || SENSITIVE_RESULT_KEY.test(key)) {
        return failMcp("MCP_TOOL_CATALOG_INVALID");
      }
      if (currentBearerToken !== null && currentBearerToken.length > 0 && key.includes(currentBearerToken)) {
        return failMcp("MCP_TOOL_CATALOG_INVALID");
      }
      visit(entry, depth + 1);
    }
  };
  visit(value, 0);
}

function equalJson(left: JsonValue, right: JsonValue): boolean {
  return stableJson(toJsonValue(left)) === stableJson(toJsonValue(right));
}

function validateValue(schema: JsonObject, value: JsonValue, depth: number): void {
  if (depth > 12) return failMcp("MCP_TOOL_INPUT_INVALID");
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => equalJson(entry, value))) return failMcp("MCP_TOOL_INPUT_INVALID");
  if (Object.prototype.hasOwnProperty.call(schema, "const") && !equalJson(schema.const!, value)) return failMcp("MCP_TOOL_INPUT_INVALID");
  const type = schema.type;
  if (type === "null") { if (value !== null) return failMcp("MCP_TOOL_INPUT_INVALID"); return; }
  if (type === "string") {
    if (typeof value !== "string") return failMcp("MCP_TOOL_INPUT_INVALID");
    if (typeof schema.minLength === "number" && [...value].length < schema.minLength) return failMcp("MCP_TOOL_INPUT_INVALID");
    if (typeof schema.maxLength === "number" && [...value].length > schema.maxLength) return failMcp("MCP_TOOL_INPUT_INVALID");
    return;
  }
  if (type === "number" || type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value) || (type === "integer" && !Number.isSafeInteger(value))) return failMcp("MCP_TOOL_INPUT_INVALID");
    if (typeof schema.minimum === "number" && value < schema.minimum) return failMcp("MCP_TOOL_INPUT_INVALID");
    if (typeof schema.maximum === "number" && value > schema.maximum) return failMcp("MCP_TOOL_INPUT_INVALID");
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) return failMcp("MCP_TOOL_INPUT_INVALID");
    if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) return failMcp("MCP_TOOL_INPUT_INVALID");
    if (typeof schema.multipleOf === "number" && schema.multipleOf > 0 && Math.abs(value / schema.multipleOf - Math.round(value / schema.multipleOf)) > 1e-9) return failMcp("MCP_TOOL_INPUT_INVALID");
    return;
  }
  if (type === "boolean") { if (typeof value !== "boolean") return failMcp("MCP_TOOL_INPUT_INVALID"); return; }
  if (type === "array") {
    if (!Array.isArray(value) || !isObject(schema.items)) return failMcp("MCP_TOOL_INPUT_INVALID");
    if (typeof schema.minItems === "number" && value.length < schema.minItems) return failMcp("MCP_TOOL_INPUT_INVALID");
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return failMcp("MCP_TOOL_INPUT_INVALID");
    if (schema.uniqueItems === true && new Set(value.map((entry) => stableJson(entry))).size !== value.length) return failMcp("MCP_TOOL_INPUT_INVALID");
    for (const entry of value) validateValue(schema.items as JsonObject, entry, depth + 1);
    return;
  }
  if (type === "object") {
    if (!isObject(value)) return failMcp("MCP_TOOL_INPUT_INVALID");
    const properties = isObject(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) if (typeof key === "string" && !Object.prototype.hasOwnProperty.call(value, key)) return failMcp("MCP_TOOL_INPUT_INVALID");
    if (typeof schema.minProperties === "number" && Object.keys(value).length < schema.minProperties) return failMcp("MCP_TOOL_INPUT_INVALID");
    if (typeof schema.maxProperties === "number" && Object.keys(value).length > schema.maxProperties) return failMcp("MCP_TOOL_INPUT_INVALID");
    for (const [key, entry] of Object.entries(value)) {
      const propertySchema = properties[key];
      if (isObject(propertySchema)) validateValue(propertySchema as JsonObject, toJsonValue(entry), depth + 1);
      else if (schema.additionalProperties === false) return failMcp("MCP_TOOL_INPUT_INVALID");
      else if (isObject(schema.additionalProperties)) validateValue(schema.additionalProperties as JsonObject, toJsonValue(entry), depth + 1);
    }
    return;
  }
  return failMcp("MCP_TOOL_INPUT_INVALID");
}

export function canonicalMcpToolArguments(schemaInput: unknown, argumentsInput: unknown): JsonObject {
  const schema = validateSchemaNode(schemaInput, { nodes: 0 }, 0, "root");
  if (!isObject(argumentsInput)) return failMcp("MCP_TOOL_INPUT_INVALID");
  const value = toJsonValue(argumentsInput);
  if (!isObject(value) || Buffer.byteLength(stableJson(value as JsonObject), "utf8") > MAX_ARGUMENT_BYTES) return failMcp("MCP_TOOL_INPUT_INVALID");
  validateValue(schema, value as JsonObject, 0);
  return value as JsonObject;
}

/** Validate structured MCP output against the server-attested output schema. */
export function validateMcpToolOutput(schemaInput: unknown, outputInput: unknown): JsonValue {
  try {
    const schema = validateSchemaNode(schemaInput, { nodes: 0 }, 0, "root");
    const value = toJsonValue(outputInput);
    validateValue(schema, value, 0);
    return value;
  } catch (error) {
    if (error instanceof McpCapabilityError) return failMcp("MCP_TOOL_OUTPUT_INVALID");
    throw error;
  }
}

type ResultSanitizeState = { nodes: number; depth: number; omittedContentCount: number };

function hasSensitiveOrAmbiguousResultText(value: string): boolean {
  const normalizedValue = value.normalize("NFKC");
  const sensitiveMatch = SENSITIVE_RESULT_TRIGGER.exec(normalizedValue);
  const encodedMatch = ENCODED_ASCII.exec(normalizedValue);
  const compactValue = normalizedValue.replace(/[^a-z0-9]/giu, "").toLowerCase();
  const compactSensitive = COMPACT_SENSITIVE_RESULT_TOKENS.some((token) => compactValue.includes(token));
  return sensitiveMatch !== null
    || encodedMatch !== null
    || compactSensitive
    || AMBIGUOUS_RESULT_ENCODING.test(normalizedValue);
}

function sanitizeResultPatterns(value: string, state: ResultSanitizeState): string {
  if (!hasSensitiveOrAmbiguousResultText(value)) return value;

  // A remote tool controls both the value syntax and surrounding prose. Once
  // a credential-shaped token, markup delimiter, or ambiguous encoding appears, punctuation,
  // malformed quoting, escapes, entities, combining/format characters, and
  // folded lines cannot provide a provably safe boundary. Discard the entire
  // attacker-controlled string rather than retaining a decodable fragment.
  state.omittedContentCount += 1;
  return "[REDACTED]";
}

function sanitizeResultText(value: string, state: ResultSanitizeState): string {
  const sanitized = sanitizeResultPatterns(value, state);
  if (Buffer.byteLength(sanitized, "utf8") > MCP_RESULT_MAX_STRING_BYTES) return failMcp("MCP_RESPONSE_TOO_LARGE");
  return sanitized;
}

function sanitizeResultValue(value: unknown, state: ResultSanitizeState, depth: number): JsonValue {
  if (depth > MCP_RESULT_MAX_DEPTH) return failMcp("MCP_RESPONSE_TOO_LARGE");
  state.nodes += 1;
  state.depth = Math.max(state.depth, depth);
  if (state.nodes > MCP_RESULT_MAX_NODES) return failMcp("MCP_RESPONSE_TOO_LARGE");
  if (typeof value === "string") return sanitizeResultText(value, state);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((entry) => sanitizeResultValue(entry, state, depth + 1));
  if (!isObject(value)) return failMcp("MCP_TOOL_OUTPUT_INVALID");
  const output: JsonObject = {};
  for (const key of Object.keys(value).sort()) {
    if (key.length === 0 || key.length > 256 || CONTROL.test(key)) return failMcp("MCP_TOOL_OUTPUT_INVALID");
    if (UNSAFE_OBJECT_KEYS.has(key)) {
      state.omittedContentCount += 1;
      continue;
    }
    // Keys are controlled by the remote server too. Credential field names
    // can be hidden behind JSON/unicode/HTML/percent escapes or invisible
    // format characters; omit the entire field so its value cannot survive
    // under a decodable key.
    if (SENSITIVE_RESULT_KEY.test(key) || hasSensitiveOrAmbiguousResultText(key)) {
      state.omittedContentCount += 1;
      continue;
    }
    output[key] = sanitizeResultValue(value[key], state, depth + 1);
  }
  return output;
}

export type SanitizedMcpToolResult = Readonly<{
  payload: JsonValue;
  resultFingerprint: string;
  resultBytes: number;
  resultNodes: number;
  resultDepth: number;
  omittedContentCount: number;
}>;

/**
 * Produce the only result shape that may be persisted by the dispatch
 * runtime. It never retains an HTTP body, headers, or authorization material.
 */
export function sanitizeMcpToolResult(input: Readonly<{
  text: string | null;
  structuredContent: unknown;
  omittedContentCount: number;
  outputSchema?: unknown;
}>): SanitizedMcpToolResult {
  if (!Number.isSafeInteger(input.omittedContentCount) || input.omittedContentCount < 0) return failMcp("MCP_RESPONSE_INVALID");
  if (input.text !== null && typeof input.text !== "string") return failMcp("MCP_RESPONSE_INVALID");
  // An attested output schema applies even when the server omits
  // structuredContent. A missing value is valid only if that schema allows
  // null; otherwise it is a deterministic output rejection.
  if (input.outputSchema !== undefined && input.outputSchema !== null) validateMcpToolOutput(input.outputSchema, input.structuredContent);
  // The persisted JSONB wrapper is the measured value: its object is depth 0,
  // and text/structuredContent/omittedContentCount are depth-1 children. Keep
  // this accounting identical to the database recursive walk, including null
  // children, so an accepted result cannot fail only during persistence.
  const state: ResultSanitizeState = { nodes: 1, depth: 0, omittedContentCount: input.omittedContentCount };
  const sanitizedTextValue = sanitizeResultValue(input.text, state, 1);
  if (sanitizedTextValue !== null && typeof sanitizedTextValue !== "string") return failMcp("MCP_RESPONSE_INVALID");
  const sanitizedStructuredContent = sanitizeResultValue(input.structuredContent, state, 1);
  const sanitizedOmittedContentCount = sanitizeResultValue(state.omittedContentCount, state, 1);
  if (typeof sanitizedOmittedContentCount !== "number") return failMcp("MCP_RESPONSE_INVALID");
  const payload: JsonObject = {
    text: sanitizedTextValue,
    structuredContent: sanitizedStructuredContent,
    omittedContentCount: sanitizedOmittedContentCount,
  };
  const encoded = JSON.stringify(payload);
  const resultBytes = Buffer.byteLength(encoded, "utf8");
  if (resultBytes > MCP_RESULT_MAX_BYTES) return failMcp("MCP_RESPONSE_TOO_LARGE");
  const resultFingerprint = createHash("sha256").update(encoded, "utf8").digest("hex");
  return Object.freeze({ payload, resultFingerprint, resultBytes, resultNodes: Math.max(state.nodes, 1), resultDepth: state.depth, omittedContentCount: state.omittedContentCount });
}

export function mcpHeaderBindings(schemaInput: unknown): readonly McpHeaderBinding[] {
  const schema = validateSchemaNode(schemaInput, { nodes: 0 }, 0, "root");
  const bindings: McpHeaderBinding[] = [];
  const names = new Set<string>();
  function visit(node: JsonObject, path: readonly string[]): void {
    const properties = isObject(node.properties) ? node.properties : {};
    for (const [key, childValue] of Object.entries(properties)) {
      if (!isObject(childValue)) continue;
      const child = childValue as JsonObject;
      const next = [...path, key];
      const header = child["x-mcp-header"];
      if (typeof header === "string") {
        const normalized = header.toLowerCase();
        if (names.has(normalized)) return failMcp("MCP_TOOL_CATALOG_INVALID");
        names.add(normalized);
        bindings.push(Object.freeze({ headerName: `Mcp-Param-${header}`, path: Object.freeze(next), valueType: child.type as "string" | "integer" | "boolean" }));
      }
      if (child.type === "object") visit(child, next);
    }
  }
  visit(schema, []);
  return Object.freeze(bindings);
}

function encodeHeaderValue(value: string): string {
  if (/^[\x20-\x7e]+$/u.test(value) && value.trim() === value && !value.startsWith("=?base64?")) return value;
  return `=?base64?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

export function mcpArgumentHeaders(schemaInput: unknown, argumentsInput: unknown): Readonly<Record<string, string>> {
  const argumentsValue = canonicalMcpToolArguments(schemaInput, argumentsInput);
  const headers: Record<string, string> = {};
  for (const binding of mcpHeaderBindings(schemaInput)) {
    let value: JsonValue | undefined = argumentsValue;
    for (const segment of binding.path) {
      value = isObject(value) ? (value as JsonObject)[segment] : undefined;
      if (value === undefined) break;
    }
    if (value === undefined || value === null) continue;
    if ((binding.valueType === "string" && typeof value !== "string") || (binding.valueType === "boolean" && typeof value !== "boolean") || (binding.valueType === "integer" && !Number.isSafeInteger(value))) {
      return failMcp("MCP_TOOL_INPUT_INVALID");
    }
    headers[binding.headerName] = encodeHeaderValue(String(value));
  }
  return Object.freeze(headers);
}

export function encodeMcpNameHeader(value: string): string {
  if (!TOOL_NAME.test(value)) return failMcp("MCP_TOOL_INPUT_INVALID");
  return encodeHeaderValue(value);
}

export function stableMcpJson(value: unknown): JsonValue {
  return toJsonValue(value);
}
