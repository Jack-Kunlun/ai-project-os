import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { AccountAccessGuardError, assertAccountAccessForActor } from "@/lib/account-access-guard";
import { getDb } from "@/lib/db";
import { McpCapabilityError, failMcp } from "@/lib/mcp/errors";
import { hasApprovedMcpToolReview } from "@/lib/mcp-tool-review-service";

const UUID = z.string().uuid();
const FINGERPRINT = z.string().regex(/^[0-9a-f]{64}$/u);
const NO_CREDENTIAL_FINGERPRINT = "d2ab012fb807b99b7d059aabe98a45dd6edf6941a5f22699f8d04b5906dc2c2b";
const MAX_SERIALIZABLE_RETRIES = 3;

const createAttestationSchema = z.object({
  toolDefinitionId: UUID,
  expectedConnectionConfigurationRevision: z.number().int().positive(),
  expectedDefinitionFingerprint: FINGERPRINT,
  expectedNetworkFingerprint: FINGERPRINT,
  expectedCredentialFingerprint: FINGERPRINT,
  conclusion: z.literal("read_only_verified"),
  riskLevel: z.enum(["low", "medium", "high"]),
  evidenceNote: z.literal("manual_read_only_review"),
}).strict();

const revokeAttestationSchema = z.object({
  expectedVersion: z.number().int().positive(),
}).strict();

const candidateQuerySchema = z.object({
  state: z.enum(["eligible", "active"]).default("eligible"),
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
}).strict();

type CandidateState = z.infer<typeof candidateQuerySchema>["state"];
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type Tx = Prisma.TransactionClient;

type ConnectionSnapshot = Readonly<{
  id: string;
  name: string;
  authKind: "none" | "bearer";
  credentialId: string | null;
  credentialFingerprint: string;
  ownerAccountAccessVersion: number | null;
  configurationRevision: number;
  updatedAt: Date;
  resolvedAddressFingerprint: string | null;
  status: "configured" | "verified" | "error" | "disabled";
  disabledAt: Date | null;
  ownerUserId: string | null;
  ownershipState: "legacyPending" | "ambiguous" | "confirmed";
  credential: Readonly<{ kind: string; secretFingerprint: string }> | null;
  ownerUser: Readonly<{ id: string; disabledAt: Date | null; accountAccessVersion: number }> | null;
}>;

type DefinitionSnapshot = Readonly<{
  id: string;
  connectionId: string;
  name: string;
  title: string | null;
  description: string | null;
  inputSchema: unknown;
  outputSchema: unknown;
  annotations: unknown;
  remoteReadOnlyHint: boolean;
  definitionFingerprint: string;
  current: boolean;
  connection: ConnectionSnapshot;
}>;

type AttestationSnapshot = Readonly<{
  id: string;
  controlPlaneVersion: number | null;
  status: "active" | "revoked" | null;
  version: number | null;
  connectionId: string;
  toolDefinitionId: string;
  toolName: string;
  definitionFingerprint: string;
  networkFingerprint: string;
  credentialFingerprint: string;
  connectionOwnerAccountAccessVersion: number | null;
  conclusion: string | null;
  riskLevel: string | null;
  evidenceNote: string | null;
  connectionConfigurationRevision: number | null;
  verifiedById: string;
  verifiedBy: Readonly<{ id: string; role: string; disabledAt: Date | null }>;
  note: string | null;
  evidence: unknown;
  revokedById: string | null;
  revokedAt: Date | null;
  attestedAt: Date;
  createdAt: Date;
  connection: ConnectionSnapshot;
  toolDefinition: Readonly<{
    id: string;
    connectionId: string;
    name: string;
    title: string | null;
    description: string | null;
    inputSchema: unknown;
    outputSchema: unknown;
    annotations: unknown;
    remoteReadOnlyHint: boolean;
    definitionFingerprint: string;
    current: boolean;
  }>;
}>;

function uuid(value: unknown): string {
  const parsed = UUID.safeParse(value);
  return parsed.success ? parsed.data : failMcp("MCP_INVALID_INPUT");
}

function actorIdFromInput(value: unknown): string {
  return isObject(value) && "id" in value ? uuid(value.id) : uuid(value);
}

function actorAccountAccessVersionFromInput(value: unknown): number | undefined {
  if (!isObject(value)) return undefined;
  const version = value.accountAccessVersion;
  return typeof version === "number" ? version : undefined;
}

function isPrismaCode(error: unknown, code: string): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
}

function isSerializationConflict(error: unknown): boolean {
  if (isPrismaCode(error, "P2034")) return true;
  if (error instanceof Error && "code" in error && (error as { code?: unknown }).code === "40001") return true;
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; message?: unknown; meta?: unknown };
  try {
    return /\b(?:40001|40P01)\b/u.test(JSON.stringify([candidate.code, candidate.message, candidate.meta]));
  } catch {
    return false;
  }
}

async function withSerializableRetry<T>(db: PrismaClient, operation: (tx: Tx) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < MAX_SERIALIZABLE_RETRIES; attempt += 1) {
    try {
      return await db.$transaction(operation, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (!isSerializationConflict(error) || attempt === MAX_SERIALIZABLE_RETRIES - 1) throw error;
    }
  }
  throw new Error("MCP_ATTESTATION_SERIALIZABLE_RETRY_EXHAUSTED");
}

async function lockNamespace(tx: Tx, value: string, namespace: number): Promise<void> {
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${value}::text, ${namespace}))`);
}

async function lockActor(tx: Tx, actorId: string): Promise<void> {
  await lockNamespace(tx, actorId, 29082027);
  await tx.$queryRaw`SELECT "id" FROM "AppUser" WHERE "id" = ${actorId}::uuid FOR UPDATE`;
}

async function lockConnection(tx: Tx, connectionId: string): Promise<void> {
  await lockNamespace(tx, connectionId, 32010000);
  await tx.$queryRaw`SELECT "id" FROM "McpConnection" WHERE "id" = ${connectionId}::uuid FOR UPDATE`;
}

async function lockTuple(tx: Tx, connectionId: string, toolDefinitionId: string): Promise<void> {
  await lockNamespace(tx, `${connectionId}:${toolDefinitionId}`, 32010003);
}

async function lockAttestation(tx: Tx, attestationId: string): Promise<void> {
  await lockNamespace(tx, attestationId, 32010004);
  await tx.$queryRaw`SELECT "id" FROM "McpToolAttestation" WHERE "id" = ${attestationId}::uuid FOR UPDATE`;
}

async function requireAdminActor(db: PrismaClient | Tx, actorId: string, accountAccessVersion?: number): Promise<void> {
  const actor = await db.appUser.findUnique({ where: { id: actorId }, select: { role: true, disabledAt: true } });
  if (actor === null || actor.role !== "admin" || actor.disabledAt !== null) return failMcp("MCP_ADMIN_REQUIRED");
  try {
    await assertAccountAccessForActor(db, { id: actorId, accountAccessVersion });
  } catch (error) {
    if (error instanceof AccountAccessGuardError) return failMcp("MCP_ADMIN_REQUIRED");
    throw error;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const MAX_SANITIZED_DEPTH = 16;
const MAX_SANITIZED_ARRAY_ITEMS = 256;
const MAX_SANITIZED_OBJECT_KEYS = 512;
const MAX_SANITIZED_STRING_LENGTH = 8_192;
const schemaKeys = new Set([
  "type",
  "title",
  "description",
  "properties",
  "required",
  "items",
  "enum",
  "oneOf",
  "anyOf",
  "allOf",
  "not",
  "additionalProperties",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minProperties",
  "maxProperties",
  "readOnlyHint",
  "destructiveHint",
  "openWorldHint",
]);
const blockedKey = /^(?:default|example|examples|const|\$schema)$/iu;
const sensitiveKey = /(?:endpoint|url|uri|host|server|header|auth|cookie|credential|token|secret|password|apikey|privatekey)/iu;
const sensitiveContent = /(?:authorization|cookie|bearer\s+|basic\s+|api[-_ ]?key|private[-_ ]?key|credential|token|secret|password)/iu;
const urlLikeContent = /(?:\b[a-z][a-z\d+.-]*:\/\/|(?:^|[^\w])\/\/)[^\s"'<>)}\]]+/iu;
const uriLikeContent = /\b[a-z][a-z\d+.-]{1,31}:[^\s"'<>)}\]]+/iu;
const bareUrlContent = /^(?:(?:[a-z\d](?:[a-z\d-]*[a-z\d])?\.)+[a-z]{2,}|(?:\d{1,3}\.){3}\d{1,3}|localhost)(?::\d+)?(?:[/?#]\S*)?$/iu;
const likelySecretContent = /^(?:sk|pk|rk|gh[pousr]|xox[baprs]|AIza|AKIA)[a-z\d_-]{10,}$/iu;
const opaqueSecretContent = /^(?=[a-z\d+/_=-]{24,}$)(?=.*[a-z])(?=.*\d)[a-z\d+/_=-]+$/iu;
const propertyNameControlCharacter = /[\u0000-\u001f\u007f-\u009f]/u;
const MAX_SCHEMA_PROPERTY_NAME_LENGTH = 256;

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[\s_-]/gu, "");
}

function isBlockedRemoteKey(key: string): boolean {
  const rawLower = key.toLowerCase();
  const normalized = normalizedKey(key);
  return /^(?:__proto__|constructor|prototype)$/u.test(rawLower)
    || normalized === "proto"
    || normalized === "constructor"
    || normalized === "prototype"
    || blockedKey.test(key)
    || normalized.startsWith("default")
    || normalized.startsWith("example")
    || normalized.startsWith("const")
    || normalized.startsWith("$schema")
    || sensitiveKey.test(normalized);
}

function isSafeSchemaPropertyName(propertyName: string): boolean {
  return propertyName.length > 0
    && propertyName.length <= MAX_SCHEMA_PROPERTY_NAME_LENGTH
    && !propertyNameControlCharacter.test(propertyName)
    && !isBlockedRemoteKey(propertyName)
    && !urlLikeContent.test(propertyName)
    && !uriLikeContent.test(propertyName)
    && !bareUrlContent.test(propertyName)
    && !likelySecretContent.test(propertyName)
    && !opaqueSecretContent.test(propertyName);
}

function sanitizeScalar(value: unknown): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value !== "string") return "[redacted]";
  const text = value.slice(0, MAX_SANITIZED_STRING_LENGTH);
  if (sensitiveContent.test(text) || urlLikeContent.test(text) || uriLikeContent.test(text) || bareUrlContent.test(text) || likelySecretContent.test(text) || opaqueSecretContent.test(text)) return "[redacted]";
  return text;
}

function sanitizeRemoteObject(value: Record<string, unknown>, depth: number): JsonValue {
  const output: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  for (const key of Object.keys(value).sort().slice(0, MAX_SANITIZED_OBJECT_KEYS)) {
    if (isBlockedRemoteKey(key) || !schemaKeys.has(key)) continue;
    const entry = value[key];
    if (key === "properties") {
      if (!isObject(entry)) {
        output[key] = "[redacted]";
        continue;
      }
      const properties: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
      for (const propertyName of Object.keys(entry).sort().slice(0, MAX_SANITIZED_OBJECT_KEYS)) {
        if (!isSafeSchemaPropertyName(propertyName)) continue;
        properties[propertyName] = sanitizeRemoteValue(entry[propertyName], depth + 1);
      }
      output[key] = properties;
      continue;
    }
    output[key] = sanitizeRemoteValue(entry, depth + 1);
  }
  return output;
}

function sanitizeRemoteValue(value: unknown, depth: number): JsonValue {
  if (depth > MAX_SANITIZED_DEPTH) return "[redacted]";
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return sanitizeScalar(value);
  if (Array.isArray(value)) return value.slice(0, MAX_SANITIZED_ARRAY_ITEMS).map((entry) => sanitizeRemoteValue(entry, depth + 1));
  if (!isObject(value)) return "[redacted]";
  return sanitizeRemoteObject(value, depth);
}

/** Remote MCP metadata is untrusted; project only safe JSON-schema structure. */
export function sanitizeMcpAttestationJson(value: unknown, depth = 0): JsonValue {
  return sanitizeRemoteValue(value, depth);
}

function safeText(value: string | null): string | null {
  if (value === null) return null;
  const sanitized = sanitizeMcpAttestationJson(value);
  return typeof sanitized === "string" ? sanitized : "[redacted]";
}

type ActiveAssessment = Readonly<{
  effective: boolean;
  reason: string | null;
}>;

function isEmptyJsonObject(value: unknown): boolean {
  return isObject(value) && Object.keys(value).length === 0;
}

function assessActiveAttestation(row: AttestationSnapshot, definition: DefinitionSnapshot): ActiveAssessment {
  if (row.controlPlaneVersion !== 2
    || row.status !== "active"
    || row.version !== 1
    || row.conclusion !== "read_only_verified"
    || row.riskLevel !== "low" && row.riskLevel !== "medium" && row.riskLevel !== "high"
    || row.evidenceNote !== "manual_read_only_review"
    || row.note !== null
    || !isEmptyJsonObject(row.evidence)) {
    return { effective: false, reason: "v2_shape_invalid" };
  }
  if (row.verifiedBy.role !== "admin") return { effective: false, reason: "verifier_not_admin" };
  if (row.verifiedBy.disabledAt !== null) return { effective: false, reason: "verifier_disabled" };
  if (!definition.current) return { effective: false, reason: "tool_definition_stale" };
  if (!definition.remoteReadOnlyHint) return { effective: false, reason: "tool_not_read_only" };
  const networkFingerprint = definition.connection.resolvedAddressFingerprint;
  let credentialFingerprint: string;
  try {
    credentialFingerprint = connectionCredentialFingerprint(definition.connection);
  } catch (error) {
    if (error instanceof McpCapabilityError && error.code === "MCP_CONNECTION_NOT_VERIFIED") {
      return { effective: false, reason: "connection_not_verified" };
    }
    throw error;
  }
  if (definition.connection.status !== "verified"
    || definition.connection.disabledAt !== null
    || definition.connection.ownershipState !== "confirmed"
    || definition.connection.ownerUserId === null
    || definition.connection.ownerUser === null
    || definition.connection.ownerUser.disabledAt !== null
    || definition.connection.ownerAccountAccessVersion === null
    || definition.connection.ownerAccountAccessVersion !== definition.connection.ownerUser.accountAccessVersion
    || row.connectionOwnerAccountAccessVersion === null
    || row.connectionOwnerAccountAccessVersion !== definition.connection.ownerAccountAccessVersion
    || networkFingerprint === null) {
    return { effective: false, reason: "connection_not_verified" };
  }
  if (row.connectionId !== definition.connection.id
    || row.toolDefinitionId !== definition.id
    || row.toolName !== definition.name
    || row.definitionFingerprint !== definition.definitionFingerprint
    || row.networkFingerprint !== networkFingerprint
    || row.credentialFingerprint !== credentialFingerprint
    || row.connectionConfigurationRevision !== definition.connection.configurationRevision) {
    return { effective: false, reason: "snapshot_drift" };
  }
  return { effective: true, reason: null };
}

function definitionFromAttestation(row: AttestationSnapshot): DefinitionSnapshot {
  return {
    id: row.toolDefinition.id,
    connectionId: row.toolDefinition.connectionId,
    name: row.toolDefinition.name,
    title: row.toolDefinition.title,
    description: row.toolDefinition.description,
    inputSchema: row.toolDefinition.inputSchema,
    outputSchema: row.toolDefinition.outputSchema,
    annotations: row.toolDefinition.annotations,
    remoteReadOnlyHint: row.toolDefinition.remoteReadOnlyHint,
    definitionFingerprint: row.toolDefinition.definitionFingerprint,
    current: row.toolDefinition.current,
    connection: row.connection,
  };
}

function activeTupleKey(tuple: Readonly<{
  connectionId: string;
  toolDefinitionId: string;
  toolName: string;
  definitionFingerprint: string;
  networkFingerprint: string;
  credentialFingerprint: string;
  connectionConfigurationRevision: number | null;
}>): string {
  return [
    tuple.connectionId,
    tuple.toolDefinitionId,
    tuple.toolName,
    tuple.definitionFingerprint,
    tuple.networkFingerprint,
    tuple.credentialFingerprint,
    tuple.connectionConfigurationRevision,
  ].join("\u0000");
}

function connectionCredentialFingerprint(connection: ConnectionSnapshot): string {
  if (connection.authKind === "none") {
    if (connection.credentialId !== null || connection.credentialFingerprint !== NO_CREDENTIAL_FINGERPRINT) return failMcp("MCP_CONNECTION_NOT_VERIFIED");
    return NO_CREDENTIAL_FINGERPRINT;
  }
  if (connection.authKind !== "bearer" || connection.credential === null || connection.credential.kind !== "mcp" || connection.credential.secretFingerprint !== connection.credentialFingerprint) {
    return failMcp("MCP_CONNECTION_NOT_VERIFIED");
  }
  return connection.credentialFingerprint;
}

function assertDefinitionEligible(definition: DefinitionSnapshot): string {
  const connection = definition.connection;
  if (!definition.current || !definition.remoteReadOnlyHint) return failMcp(definition.current ? "MCP_TOOL_NOT_READ_ONLY" : "MCP_TOOL_DEFINITION_STALE");
  if (connection.status !== "verified" || connection.disabledAt !== null || connection.resolvedAddressFingerprint === null) return failMcp("MCP_CONNECTION_NOT_VERIFIED");
  if (connection.ownerUserId === null
    || connection.ownershipState !== "confirmed"
    || connection.ownerUser === null
    || connection.ownerUser.disabledAt !== null
    || connection.ownerAccountAccessVersion === null
    || connection.ownerAccountAccessVersion !== connection.ownerUser.accountAccessVersion) return failMcp("MCP_CONNECTION_NOT_VERIFIED");
  return connectionCredentialFingerprint(connection);
}

function assertExpectedSnapshot(definition: DefinitionSnapshot, input: z.infer<typeof createAttestationSchema>): { networkFingerprint: string; credentialFingerprint: string } {
  const credentialFingerprint = assertDefinitionEligible(definition);
  const networkFingerprint = definition.connection.resolvedAddressFingerprint;
  if (networkFingerprint === null
    || definition.connection.configurationRevision !== input.expectedConnectionConfigurationRevision
    || definition.definitionFingerprint !== input.expectedDefinitionFingerprint
    || networkFingerprint !== input.expectedNetworkFingerprint
    || credentialFingerprint !== input.expectedCredentialFingerprint) {
    return failMcp("MCP_TOOL_DEFINITION_STALE");
  }
  return { networkFingerprint, credentialFingerprint };
}

type ProjectedAttestation = Readonly<Record<string, unknown> & { id: string }>;

function projectAttestation(row: AttestationSnapshot, assessment?: ActiveAssessment, reviewStatus?: "approved"): ProjectedAttestation {
  return Object.freeze({
    id: row.id,
    status: row.status,
    version: row.version,
    conclusion: row.conclusion,
    riskLevel: row.riskLevel,
    evidenceNote: row.evidenceNote,
    verifiedById: row.verifiedById,
    revokedById: row.revokedById,
    attestedAt: row.attestedAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    ...(assessment === undefined ? {} : {
      effective: assessment.effective,
      effectiveReason: assessment.reason,
      requiresRevocation: !assessment.effective,
    }),
    ...(reviewStatus === undefined ? {} : { reviewStatus }),
    connection: { id: row.connection.id, name: safeText(row.connection.name) },
    tool: {
      id: row.toolDefinition.id,
      name: safeText(row.toolDefinition.name),
      title: safeText(row.toolDefinition.title),
      description: safeText(row.toolDefinition.description),
      inputSchema: sanitizeMcpAttestationJson(row.toolDefinition.inputSchema),
      outputSchema: sanitizeMcpAttestationJson(row.toolDefinition.outputSchema),
      annotations: sanitizeMcpAttestationJson(row.toolDefinition.annotations),
      remoteTextTrust: "untrusted",
      definitionFingerprint: row.definitionFingerprint,
    },
    snapshots: {
      connectionConfigurationRevision: row.connectionConfigurationRevision,
      connectionUpdatedAt: row.connection.updatedAt.toISOString(),
      connectionOwnerAccountAccessVersion: row.connectionOwnerAccountAccessVersion,
      definitionFingerprint: row.definitionFingerprint,
      networkFingerprint: row.networkFingerprint,
      credentialFingerprint: row.credentialFingerprint,
    },
  });
}

async function loadDefinition(tx: Tx, toolDefinitionId: string): Promise<DefinitionSnapshot> {
  const definition = await tx.mcpToolDefinition.findUnique({
    where: { id: toolDefinitionId },
    select: {
      id: true,
      connectionId: true,
      name: true,
      title: true,
      description: true,
      inputSchema: true,
      outputSchema: true,
      annotations: true,
      remoteReadOnlyHint: true,
      definitionFingerprint: true,
      current: true,
      connection: {
        select: {
          id: true,
          name: true,
          authKind: true,
          credentialId: true,
          credentialFingerprint: true,
          configurationRevision: true,
          updatedAt: true,
          resolvedAddressFingerprint: true,
          status: true,
          disabledAt: true,
          ownerUserId: true,
          ownerAccountAccessVersion: true,
          ownershipState: true,
          credential: { select: { kind: true, secretFingerprint: true } },
          ownerUser: { select: { id: true, disabledAt: true, accountAccessVersion: true } },
        },
      },
    },
  });
  if (definition === null) return failMcp("MCP_TOOL_NOT_FOUND");
  return definition;
}

async function loadAttestation(tx: Tx, attestationId: string): Promise<AttestationSnapshot | null> {
  return tx.mcpToolAttestation.findUnique({
    where: { id: attestationId },
    select: {
      id: true,
      controlPlaneVersion: true,
      status: true,
      version: true,
      connectionId: true,
      toolDefinitionId: true,
      toolName: true,
      definitionFingerprint: true,
      networkFingerprint: true,
      credentialFingerprint: true,
      conclusion: true,
      riskLevel: true,
      evidenceNote: true,
      connectionConfigurationRevision: true,
      connectionOwnerAccountAccessVersion: true,
      verifiedById: true,
      note: true,
      evidence: true,
      revokedById: true,
      revokedAt: true,
      attestedAt: true,
      createdAt: true,
      connection: {
        select: {
          id: true,
          name: true,
          authKind: true,
          credentialId: true,
          credentialFingerprint: true,
          configurationRevision: true,
          updatedAt: true,
          resolvedAddressFingerprint: true,
          status: true,
          disabledAt: true,
          ownerUserId: true,
          ownerAccountAccessVersion: true,
          ownershipState: true,
          credential: { select: { kind: true, secretFingerprint: true } },
          ownerUser: { select: { id: true, disabledAt: true, accountAccessVersion: true } },
        },
      },
      toolDefinition: {
        select: {
          id: true,
          connectionId: true,
          name: true,
          title: true,
          description: true,
          inputSchema: true,
          outputSchema: true,
          annotations: true,
          remoteReadOnlyHint: true,
          definitionFingerprint: true,
          current: true,
        },
      },
      verifiedBy: { select: { id: true, role: true, disabledAt: true } },
    },
  }) as unknown as Promise<AttestationSnapshot | null>;
}

async function loadActiveTuple(tx: Tx, tuple: Readonly<{
  connectionId: string;
  toolDefinitionId: string;
  toolName: string;
  definitionFingerprint: string;
  networkFingerprint: string;
  credentialFingerprint: string;
  connectionConfigurationRevision: number;
}>): Promise<AttestationSnapshot | null> {
  const row = await tx.mcpToolAttestation.findFirst({
    where: {
      controlPlaneVersion: 2,
      status: "active",
      connectionId: tuple.connectionId,
      toolDefinitionId: tuple.toolDefinitionId,
      toolName: tuple.toolName,
      definitionFingerprint: tuple.definitionFingerprint,
      networkFingerprint: tuple.networkFingerprint,
      credentialFingerprint: tuple.credentialFingerprint,
      connectionConfigurationRevision: tuple.connectionConfigurationRevision,
    },
  });
  return row === null ? null : loadAttestation(tx, row.id);
}

export type McpAttestationCandidateQuery = Readonly<{
  state?: CandidateState;
  page?: number;
  pageSize?: number;
}>;

export async function listMcpControlPlaneAttestationCandidates(
  actorIdInput: unknown,
  input: unknown = {},
  db: PrismaClient = getDb(),
) {
  const actorId = actorIdFromInput(actorIdInput);
  const actorAccountAccessVersion = actorAccountAccessVersionFromInput(actorIdInput);
  const parsed = candidateQuerySchema.safeParse(input);
  if (!parsed.success) return failMcp("MCP_INVALID_INPUT");
  return withSerializableRetry(db, async (tx) => {
    await lockActor(tx, actorId);
    await requireAdminActor(tx, actorId, actorAccountAccessVersion);
    const start = (parsed.data.page - 1) * parsed.data.pageSize;
    if (parsed.data.state === "active") {
      const where = { controlPlaneVersion: 2, status: "active" } as const;
      const activeIds = await tx.mcpToolAttestation.findMany({
        where,
        orderBy: [{ connectionId: "asc" }, { toolName: "asc" }, { id: "asc" }],
        select: { id: true },
      });
      const activeAttestations = (await Promise.all(activeIds.map(async (row) => {
        const attestation = await loadAttestation(tx, row.id);
        if (attestation === null || !(await hasApprovedMcpToolReview(tx, attestation))) return null;
        return attestation;
      }))).filter(
        (row): row is AttestationSnapshot => row !== null,
      );
      const pageAttestations = activeAttestations.slice(start, start + parsed.data.pageSize);
      return Object.freeze({
        state: parsed.data.state,
        page: parsed.data.page,
        pageSize: parsed.data.pageSize,
        total: activeAttestations.length,
        candidates: pageAttestations.map((row) => projectAttestation(row, assessActiveAttestation(row, definitionFromAttestation(row)), "approved")),
      });
    }

    const baseWhere = {
      current: true,
      remoteReadOnlyHint: true,
      connection: {
        status: "verified" as const,
        disabledAt: null,
        ownershipState: "confirmed" as const,
        ownerUserId: { not: null },
      },
    };
    const scanPageSize = 100;
    let offset = 0;
    let total = 0;
    const candidates: Array<Readonly<Record<string, unknown>>> = [];
    while (true) {
      const definitions = await tx.mcpToolDefinition.findMany({
        where: baseWhere,
        skip: offset,
        take: scanPageSize,
        orderBy: [{ connectionId: "asc" }, { name: "asc" }, { id: "asc" }],
        include: {
          connection: {
            select: {
              id: true,
              name: true,
              authKind: true,
              credentialId: true,
              credentialFingerprint: true,
              configurationRevision: true,
              updatedAt: true,
              resolvedAddressFingerprint: true,
              status: true,
              disabledAt: true,
              ownerUserId: true,
              ownershipState: true,
              credential: { select: { kind: true, secretFingerprint: true } },
              ownerAccountAccessVersion: true,
              ownerUser: { select: { id: true, disabledAt: true, accountAccessVersion: true } },
            },
          },
        },
      });
      if (definitions.length === 0) break;
      offset += definitions.length;
      const prepared: Array<Readonly<{
        definition: DefinitionSnapshot;
        tuple: Readonly<{
          connectionId: string;
          toolDefinitionId: string;
          toolName: string;
          definitionFingerprint: string;
          networkFingerprint: string;
          credentialFingerprint: string;
          connectionConfigurationRevision: number;
        }>;
      }>> = [];
      for (const row of definitions) {
        const definition = row as unknown as DefinitionSnapshot;
        try {
          const eligibleCredential = assertDefinitionEligible(definition);
          const networkFingerprint = definition.connection.resolvedAddressFingerprint;
          if (networkFingerprint === null) continue;
          prepared.push({
            definition,
            tuple: {
              connectionId: definition.connection.id,
              toolDefinitionId: definition.id,
              toolName: definition.name,
              definitionFingerprint: definition.definitionFingerprint,
              networkFingerprint,
              credentialFingerprint: eligibleCredential,
              connectionConfigurationRevision: definition.connection.configurationRevision,
            },
          });
        } catch (error) {
          if (error instanceof McpCapabilityError && error.code === "MCP_CONNECTION_NOT_VERIFIED") continue;
          throw error;
        }
      }
      const activeIds = prepared.length === 0 ? [] : await tx.mcpToolAttestation.findMany({
        where: {
          controlPlaneVersion: 2,
          status: "active",
          OR: prepared.map(({ tuple }) => tuple),
        },
        select: { id: true },
      });
      const activeRows = (await Promise.all(activeIds.map((row) => loadAttestation(tx, row.id)))).filter(
        (row): row is AttestationSnapshot => row !== null,
      );
      const activeByKey = new Map(activeRows.map((row) => [activeTupleKey(row), row]));
      for (const { definition, tuple } of prepared) {
        const active = activeByKey.get(activeTupleKey(tuple));
        const reviewed = active === undefined ? false : await hasApprovedMcpToolReview(tx, active);
        const assessment = active === undefined
          ? undefined
          : reviewed
            ? assessActiveAttestation(active, definition)
            : { effective: false, reason: "review_required" };
        if (assessment?.effective === true) continue;
        total += 1;
        if (total > start && candidates.length < parsed.data.pageSize) {
          candidates.push(Object.freeze({
            state: "eligible",
            reviewStatus: reviewed ? "approved" : "unreviewed",
            ...(active === undefined || assessment === undefined ? {} : {
              effective: false,
              effectiveReason: assessment.reason,
              blockingAttestationId: active.id,
              requiresRevocation: true,
            }),
            connection: { id: definition.connection.id, name: safeText(definition.connection.name) },
            tool: {
              id: definition.id,
              name: safeText(definition.name),
              title: safeText(definition.title),
              description: safeText(definition.description),
              inputSchema: sanitizeMcpAttestationJson(definition.inputSchema),
              outputSchema: sanitizeMcpAttestationJson(definition.outputSchema),
              annotations: sanitizeMcpAttestationJson(definition.annotations),
              remoteTextTrust: "untrusted",
              definitionFingerprint: definition.definitionFingerprint,
            },
            snapshots: {
              connectionConfigurationRevision: tuple.connectionConfigurationRevision,
              connectionUpdatedAt: definition.connection.updatedAt.toISOString(),
              connectionOwnerAccountAccessVersion: definition.connection.ownerAccountAccessVersion,
              definitionFingerprint: tuple.definitionFingerprint,
              networkFingerprint: tuple.networkFingerprint,
              credentialFingerprint: tuple.credentialFingerprint,
            },
          }));
        }
      }
      if (definitions.length < scanPageSize) break;
    }
    return Object.freeze({
      state: parsed.data.state,
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
      total,
      candidates,
    });
  });
}

export async function createMcpControlPlaneAttestation(
  actorIdInput: unknown,
  input: unknown,
  db: PrismaClient = getDb(),
) {
  const actorId = actorIdFromInput(actorIdInput);
  const actorAccountAccessVersion = actorAccountAccessVersionFromInput(actorIdInput);
  const parsed = createAttestationSchema.safeParse(input);
  if (!parsed.success) return failMcp("MCP_INVALID_INPUT");
  return withSerializableRetry(db, async (tx) => {
    await lockActor(tx, actorId);
    await requireAdminActor(tx, actorId, actorAccountAccessVersion);
    const initial = await tx.mcpToolDefinition.findUnique({ where: { id: parsed.data.toolDefinitionId }, select: { connectionId: true } });
    if (initial === null) return failMcp("MCP_TOOL_NOT_FOUND");
    await lockConnection(tx, initial.connectionId);
    await lockTuple(tx, initial.connectionId, parsed.data.toolDefinitionId);
    await requireAdminActor(tx, actorId, actorAccountAccessVersion);
    const definition = await loadDefinition(tx, parsed.data.toolDefinitionId);
    if (definition.connectionId !== initial.connectionId) return failMcp("MCP_TOOL_DEFINITION_STALE");
    const { networkFingerprint, credentialFingerprint } = assertExpectedSnapshot(definition, parsed.data);
    const tuple = {
      connectionId: definition.connectionId,
      toolDefinitionId: definition.id,
      toolName: definition.name,
      definitionFingerprint: definition.definitionFingerprint,
      networkFingerprint,
      credentialFingerprint,
      connectionConfigurationRevision: definition.connection.configurationRevision,
    } as const;
    const existing = await loadActiveTuple(tx, tuple);
    if (existing !== null) {
      const assessment = assessActiveAttestation(existing, definition);
      if (!assessment.effective) return failMcp("MCP_ATTESTATION_REAUTHENTICATION_REQUIRED");
      if (existing.riskLevel !== parsed.data.riskLevel) return failMcp("MCP_ATTESTATION_CONFLICT");
      return Object.freeze({ ...projectAttestation(existing, assessment), created: false });
    }
    const attestation = await tx.mcpToolAttestation.create({
      data: {
        id: randomUUID(),
        controlPlaneVersion: 2,
        status: "active",
        version: 1,
        connectionId: definition.connectionId,
        toolDefinitionId: definition.id,
        toolName: definition.name,
        definitionFingerprint: definition.definitionFingerprint,
        networkFingerprint,
        credentialFingerprint,
        conclusion: parsed.data.conclusion,
        riskLevel: parsed.data.riskLevel,
        evidenceNote: parsed.data.evidenceNote,
        connectionConfigurationRevision: definition.connection.configurationRevision,
        connectionOwnerAccountAccessVersion: definition.connection.ownerAccountAccessVersion,
        verifiedById: actorId,
        note: null,
        evidence: {},
      },
    });
    await tx.mcpToolAttestationAudit.create({
      data: {
        id: randomUUID(),
        attestationId: attestation.id,
        connectionId: definition.connectionId,
        toolDefinitionId: definition.id,
        event: "attested",
        actorId,
        controlPlaneVersion: 2,
        attestationVersion: 1,
        statusBefore: null,
        statusAfter: "active",
        connectionConfigurationRevision: definition.connection.configurationRevision,
        connectionOwnerAccountAccessVersion: definition.connection.ownerAccountAccessVersion,
        definitionFingerprint: definition.definitionFingerprint,
        networkFingerprint,
        credentialFingerprint,
        details: {},
      },
    });
    const stored = await loadAttestation(tx, attestation.id);
    if (stored === null) throw new Error("MCP_ATTESTATION_CREATE_READBACK_FAILED");
    return Object.freeze({ ...projectAttestation(stored), created: true });
  });
}

export async function revokeMcpControlPlaneAttestation(
  actorIdInput: unknown,
  attestationIdInput: unknown,
  input: unknown,
  db: PrismaClient = getDb(),
) {
  const actorId = actorIdFromInput(actorIdInput);
  const actorAccountAccessVersion = actorAccountAccessVersionFromInput(actorIdInput);
  const attestationId = uuid(attestationIdInput);
  const parsed = revokeAttestationSchema.safeParse(input);
  if (!parsed.success) return failMcp("MCP_INVALID_INPUT");
  return withSerializableRetry(db, async (tx) => {
    await lockActor(tx, actorId);
    await requireAdminActor(tx, actorId, actorAccountAccessVersion);
    const initial = await tx.mcpToolAttestation.findUnique({
      where: { id: attestationId },
      select: { connectionId: true, toolDefinitionId: true },
    });
    if (initial === null) return failMcp("MCP_ATTESTATION_NOT_FOUND");
    await lockConnection(tx, initial.connectionId);
    await lockTuple(tx, initial.connectionId, initial.toolDefinitionId);
    await lockAttestation(tx, attestationId);
    await requireAdminActor(tx, actorId, actorAccountAccessVersion);
    const existing = await loadAttestation(tx, attestationId);
    if (existing === null || existing.controlPlaneVersion !== 2) return failMcp("MCP_ATTESTATION_NOT_FOUND");
    if (existing.connectionId !== initial.connectionId || existing.toolDefinitionId !== initial.toolDefinitionId) return failMcp("MCP_ATTESTATION_CONFLICT");
    if (existing.status !== "active" || existing.version !== parsed.data.expectedVersion || existing.version === null) return failMcp("MCP_ATTESTATION_CONFLICT");
    const nextVersion = existing.version + 1;
    await tx.mcpToolAttestation.update({
      where: { id: existing.id },
      data: { status: "revoked", version: nextVersion, revokedById: actorId },
    });
    await tx.mcpToolAttestationAudit.create({
      data: {
        id: randomUUID(),
        attestationId: existing.id,
        connectionId: existing.connectionId,
        toolDefinitionId: existing.toolDefinitionId,
        event: "revoked",
        actorId,
        controlPlaneVersion: 2,
        attestationVersion: nextVersion,
        statusBefore: "active",
        statusAfter: "revoked",
        connectionConfigurationRevision: existing.connectionConfigurationRevision,
        connectionOwnerAccountAccessVersion: existing.connectionOwnerAccountAccessVersion,
        definitionFingerprint: existing.definitionFingerprint,
        networkFingerprint: existing.networkFingerprint,
        credentialFingerprint: existing.credentialFingerprint,
        details: {},
      },
    });
    const stored = await loadAttestation(tx, existing.id);
    if (stored === null) throw new Error("MCP_ATTESTATION_REVOKE_READBACK_FAILED");
    return projectAttestation(stored);
  });
}
