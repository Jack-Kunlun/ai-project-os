import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import { mapApiError } from "../src/lib/api-errors";
import {
  McpCapabilityError,
  createMcpControlPlaneAttestation,
  listMcpControlPlaneAttestationCandidates,
  revokeMcpControlPlaneAttestation,
  sanitizeMcpAttestationJson,
} from "../src/lib/mcp";

const actorId = "00000000-0000-4000-8000-000000000001";
const attestationId = "00000000-0000-4000-8000-000000000002";
const toolDefinitionId = "00000000-0000-4000-8000-000000000003";
const fingerprint = "a".repeat(64);

function code(error: unknown): string {
  return error instanceof McpCapabilityError ? error.code : "unexpected";
}

test("C2 candidate projection recursively removes secret-bearing remote metadata", () => {
  const input = JSON.parse(JSON.stringify({
    type: "object",
    properties: {
      query: { type: "string", description: "safe query" },
      "https://private.example.invalid/mcp": { type: "string" },
      sk_1234567890: { type: "string" },
      authorization: { default: "Bearer top-secret-value" },
      endpointUrl: "https://mcp.example.invalid",
      bareUrl: "mcp.example.invalid/path",
      inlineUrl: "see=https://mcp.example.invalid",
      bearerValue: "Bearer abcdefghijklmnop",
      opaqueValue: "Abcdefghijklmnop1234567890",
      uriValue: "urn:secret-value",
      defaultValue: "Bearer top-secret-value",
      constValue: "secret-value",
      __proto__: { polluted: true },
      constructor: { polluted: true },
      prototype: { polluted: true },
      nested: {
        annotations: {
          "x-mcp-header": "Authorization",
          tokenValue: "do-not-return",
          safe: "plain text",
        },
      },
    },
    oneOf: [{ type: "string", description: "safe branch" }],
    allOf: [{ type: "object", properties: { result: { type: "boolean" } } }],
    examples: [{ password: "do-not-return" }],
    metadata: { url: "https://secret.example.invalid" },
  }));
  Object.defineProperty(input.properties, "__proto__", { value: { polluted: true }, enumerable: true });
  const controlPropertyName = "unsafe\u0000name";
  const longPropertyName = "x".repeat(257);
  Object.defineProperty(input.properties, controlPropertyName, { value: { type: "string" }, enumerable: true });
  Object.defineProperty(input.properties, longPropertyName, { value: { type: "string" }, enumerable: true });
  const projected = sanitizeMcpAttestationJson(input);
  const serialized = JSON.stringify(projected);
  assert.doesNotMatch(serialized, /authorization|top-secret|tokenValue|password|x-mcp-header|endpointUrl|mcp\.example\.invalid|private\.example\.invalid|sk_1234567890|polluted|metadata/iu);
  assert.match(serialized, /safe query|safe branch|result/u);
  assert.equal(Object.getPrototypeOf(projected), null);
  const projectedProperties = (projected as { properties: Record<string, unknown> }).properties;
  assert.equal(Object.getPrototypeOf(projectedProperties), null);
  assert.equal(Object.getPrototypeOf((projectedProperties as { query: unknown }).query), null);
  assert.equal("__proto__" in projectedProperties, false);
  assert.equal(Object.prototype.hasOwnProperty.call(projectedProperties, "__proto__"), false);
  assert.equal("https://private.example.invalid/mcp" in projectedProperties, false);
  assert.equal("sk_1234567890" in projectedProperties, false);
  assert.equal(controlPropertyName in projectedProperties, false);
  assert.equal(longPropertyName in projectedProperties, false);
  assert.equal(JSON.parse(serialized).properties.query.description, "safe query");
});

test("C2 create and revoke inputs are strict before any database access", async () => {
  const noDb = {} as PrismaClient;
  await assert.rejects(
    () => createMcpControlPlaneAttestation({ id: actorId, role: "user" }, {
      toolDefinitionId,
      expectedConnectionConfigurationRevision: 1,
      expectedDefinitionFingerprint: fingerprint,
      expectedNetworkFingerprint: fingerprint,
      expectedCredentialFingerprint: fingerprint,
      conclusion: "read_only_verified",
      riskLevel: "low",
      evidenceNote: "manual_read_only_review",
      evidence: {},
    }, noDb),
    (error: unknown) => code(error) === "MCP_INVALID_INPUT",
  );
  await assert.rejects(
    () => revokeMcpControlPlaneAttestation(actorId, attestationId, {
      expectedVersion: 1,
      note: "not accepted",
    }, noDb),
    (error: unknown) => code(error) === "MCP_INVALID_INPUT",
  );
});

test("C2 invalid active verifier maps to a stable reauthentication conflict", () => {
  const mapped = mapApiError(new McpCapabilityError("MCP_ATTESTATION_REAUTHENTICATION_REQUIRED"));
  assert.equal(mapped.status, 409);
  assert.equal(mapped.body.error.code, "MCP_ATTESTATION_REAUTHENTICATION_REQUIRED");
});

test("C2 API surface uses same-origin writes and the independent control-plane service", async () => {
  const [candidates, createRoute, revokeRoute, service] = await Promise.all([
    readFile("src/app/api/system/mcp-tool-attestation-candidates/route.ts", "utf8"),
    readFile("src/app/api/system/mcp-tool-attestations/route.ts", "utf8"),
    readFile("src/app/api/system/mcp-tool-attestations/[attestationId]/revocation/route.ts", "utf8"),
    readFile("src/lib/mcp-attestation-control-plane-service.ts", "utf8"),
  ]);
  assert.match(candidates, /requireApiSession/u);
  assert.match(candidates, /listMcpControlPlaneAttestationCandidates/u);
  assert.match(createRoute, /assertSameOrigin/u);
  assert.match(createRoute, /createMcpControlPlaneAttestation/u);
  assert.match(createRoute, /created \? 201 : 200/u);
  assert.match(revokeRoute, /assertSameOrigin/u);
  assert.match(revokeRoute, /revokeMcpControlPlaneAttestation/u);
  assert.match(service, /\.strict\(\)/u);
  assert.match(service, /TransactionIsolationLevel\.Serializable/u);
  assert.match(service, /29082027/u);
  assert.match(service, /32010000/u);
  assert.match(service, /32010003/u);
  assert.match(service, /32010004/u);
  assert.doesNotMatch(service, /endpointUrl|maskedSuffix|ciphertext|nonce|authTag/u);
});

test("C2 eligible lookup sends every exact tuple in a batch instead of truncating at 64", async () => {
  const connectionId = "00000000-0000-4000-8000-000000000010";
  const adminId = "00000000-0000-4000-8000-000000000011";
  const definitions = Array.from({ length: 65 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`,
    connectionId,
    name: `tool-${index}`,
    title: null,
    description: null,
    inputSchema: { type: "object" },
    outputSchema: null,
    annotations: { readOnlyHint: true },
    remoteReadOnlyHint: true,
    definitionFingerprint: `${String(index + 1).padStart(2, "0")}${"a".repeat(62)}`,
    current: true,
    connection: {
      id: connectionId,
      name: "connection",
      authKind: "none",
      credentialId: null,
      credentialFingerprint: "d2ab012fb807b99b7d059aabe98a45dd6edf6941a5f22699f8d04b5906dc2c2b",
      configurationRevision: 1,
      resolvedAddressFingerprint: "b".repeat(64),
      status: "verified",
      disabledAt: null,
      ownerUserId: adminId,
      ownershipState: "confirmed",
      credential: null,
      ownerUser: { id: adminId, disabledAt: null },
    },
  }));
  let definitionCalls = 0;
  let exactTupleCount = 0;
  const fakeDb = {
    $transaction: async (operation: (tx: unknown) => Promise<unknown>) => operation(fakeDb),
    $executeRaw: async () => 0,
    $queryRaw: async () => [],
    appUser: { findUnique: async () => ({ role: "admin", disabledAt: null, accountAccessVersion: 1 }) },
    mcpToolDefinition: {
      findMany: async () => {
        definitionCalls += 1;
        return definitionCalls === 1 ? definitions : [];
      },
    },
    mcpToolAttestation: {
      findMany: async (args: { where?: { OR?: unknown[] } }) => {
        exactTupleCount = args.where?.OR?.length ?? 0;
        return [];
      },
    },
  } as unknown as PrismaClient;
  const result = await listMcpControlPlaneAttestationCandidates(
    { id: adminId, role: "admin", accountAccessVersion: 1 },
    { state: "eligible", page: 1, pageSize: 50 },
    fakeDb,
  );
  assert.equal(result.total, 65);
  assert.equal(result.candidates.length, 50);
  assert.equal(exactTupleCount, 65);
});
