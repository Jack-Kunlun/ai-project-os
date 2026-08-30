export type McpCapabilityErrorCode =
  | "MCP_INVALID_INPUT"
  | "MCP_CONNECTION_NOT_FOUND"
  | "MCP_CONNECTION_NAME_CONFLICT"
  | "MCP_CONNECTION_CONFLICT"
  | "MCP_CONNECTION_DISABLED"
  | "MCP_CONNECTION_NOT_VERIFIED"
  | "MCP_NETWORK_BLOCKED"
  | "MCP_NETWORK_CHANGED"
  | "MCP_TRANSPORT_FAILED"
  | "MCP_PROTOCOL_UNSUPPORTED"
  | "MCP_RESPONSE_INVALID"
  | "MCP_RESPONSE_TOO_LARGE"
  | "MCP_TOOL_CATALOG_INVALID"
  | "MCP_TOOL_NOT_FOUND"
  | "MCP_TOOL_NOT_READ_ONLY"
  | "MCP_ADMIN_REQUIRED"
  | "MCP_TOOL_NOT_ATTESTED"
  | "MCP_ATTESTATION_NOT_FOUND"
  | "MCP_ATTESTATION_CONFLICT"
  | "MCP_TOOL_DEFINITION_STALE"
  | "MCP_GRANT_NOT_FOUND"
  | "MCP_GRANT_REVOKED"
  | "MCP_GRANT_CONFLICT"
  | "MCP_TOOL_INPUT_INVALID"
  | "MCP_TOOL_INPUT_REQUIRED_UNSUPPORTED"
  | "MCP_TOOL_CALL_FAILED";

export class McpCapabilityError extends Error {
  constructor(readonly code: McpCapabilityErrorCode) {
    super(code);
    this.name = "McpCapabilityError";
  }
}

export function failMcp(code: McpCapabilityErrorCode): never {
  throw new McpCapabilityError(code);
}
