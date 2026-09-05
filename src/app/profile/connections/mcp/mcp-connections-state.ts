export type McpConnectionStatus = "configured" | "verified" | "error" | "disabled";

export type McpToolDefinition = Readonly<{
  id: string;
  name: string;
  title: string | null;
  description: string | null;
  remoteReadOnlyHint: boolean;
  discoveredAt: string;
  attestations: ReadonlyArray<{
    attestedAt: string;
    audits: ReadonlyArray<{ event: "attested" | "revoked" }>;
  }>;
}>;

export type McpConnection = Readonly<{
  id: string;
  name: string;
  endpointUrl: string;
  authKind: "none" | "bearer";
  allowPrivateNetwork: boolean;
  protocolVersion: string | null;
  catalogFingerprint: string | null;
  status: McpConnectionStatus;
  ownershipState: "legacyPending" | "confirmed" | "ambiguous";
  lastDiscoveredAt: string | null;
  lastErrorCode: string | null;
  disabledAt: string | null;
  createdAt: string;
  updatedAt: string;
  credential: { maskedSuffix: string; rotatedAt: string | null; updatedAt: string } | null;
  toolDefinitions: ReadonlyArray<McpToolDefinition>;
}>;

export type McpConnectionDraft = Readonly<{
  name: string;
  endpointUrl: string;
  authKind: "none" | "bearer";
  bearerToken: string;
  allowPrivateNetwork: boolean;
}>;

export const mcpStatusLabels: Record<McpConnectionStatus, string> = {
  configured: "待发现",
  verified: "已发现",
  error: "发现失败",
  disabled: "已停用",
};

export function createDefaultMcpDraft(): McpConnectionDraft {
  return {
    name: "",
    endpointUrl: "",
    authKind: "bearer",
    bearerToken: "",
    allowPrivateNetwork: false,
  };
}

export function isActiveMcpAttestation(tool: McpToolDefinition): boolean {
  const attestation = tool.attestations[0];
  return attestation !== undefined && attestation.audits.some((audit) => audit.event === "attested") && !attestation.audits.some((audit) => audit.event === "revoked");
}

export function mcpCredentialLabel(connection: Pick<McpConnection, "authKind" | "credential">): string {
  return connection.authKind === "none" ? "无凭据" : `····${connection.credential?.maskedSuffix ?? "未配置"}`;
}
