import { createHash } from "node:crypto";
import { failMcp } from "./errors";

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
    if (key.length === 0 || key.length > 256 || CONTROL.test(key)) return failMcp("MCP_TOOL_CATALOG_INVALID");
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
  const readOnlyEligible = normalizedAnnotations.readOnlyHint === true && normalizedAnnotations.destructiveHint === false;
  const identity: JsonObject = {
    name: value.name,
    title,
    description,
    inputSchema,
    outputSchema,
    annotations: normalizedAnnotations,
  };
  const definitionFingerprint = createHash("sha256").update(stableJson(identity), "utf8").digest("hex");
  return Object.freeze({ name: value.name, title, description, inputSchema, outputSchema, annotations: normalizedAnnotations, readOnlyEligible, definitionFingerprint });
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
