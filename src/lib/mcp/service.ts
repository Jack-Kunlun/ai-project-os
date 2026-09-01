import { createHash, randomUUID } from "node:crypto";
import { Prisma, type AppUser, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { assertProjectAccess, getProjectPermission, type AccessUser } from "@/lib/access-control";
import { createCredential, readCredentialSecret, rotateCredential } from "@/lib/credential-vault";
import { getDb } from "@/lib/db";
import { assertProjectActive } from "@/lib/project-lifecycle";
import { resolveSecureEndpointFingerprint } from "@/lib/web-sources";
import { callMcpTool, discoverMcpTools, MCP_PROTOCOL_VERSION, type McpToolCallResult } from "./client";
import { McpCapabilityError, failMcp } from "./errors";
import { canonicalMcpToolArguments, stableMcpJson, type JsonValue } from "./schema";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/u;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/u;

const createConnectionSchema = z.object({
  name: z.string().trim().min(1).max(80),
  endpointUrl: z.string().trim().min(8).max(1024),
  authKind: z.enum(["none", "bearer"]),
  bearerToken: z.string().min(8).max(4096).nullable().optional(),
  allowPrivateNetwork: z.boolean().default(false),
}).strict();

const updateConnectionSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  bearerToken: z.string().min(8).max(4096).optional(),
  enabled: z.boolean().optional(),
  trustCurrentNetwork: z.boolean().optional(),
  expectedUpdatedAt: z.string().datetime({ offset: true }),
}).strict();

const deleteConnectionSchema = z.object({
  confirmationName: z.string().min(1).max(80),
  expectedUpdatedAt: z.string().datetime({ offset: true }),
}).strict();

const grantSchema = z.object({
  toolDefinitionId: z.string().uuid(),
  acknowledgeReadOnly: z.literal(true),
  expectedUpdatedAt: z.string().datetime({ offset: true }).nullable(),
}).strict();

const revokeSchema = z.object({ expectedUpdatedAt: z.string().datetime({ offset: true }) }).strict();
const attestSchema = z.object({
  note: z.string().trim().max(2_000).nullable().optional(),
  evidence: z.record(z.string(), z.unknown()).default({}),
}).strict();
const revokeAttestationSchema = z.object({
  expectedAttestedAt: z.string().datetime({ offset: true }),
  note: z.string().trim().max(2_000).nullable().optional(),
}).strict();
const clientCallSchema = z.object({ grantId: z.string().uuid(), arguments: z.unknown() }).strict();
const snapshotSchema = z.object({
  grantId: z.string().uuid(),
  connectionId: z.string().uuid(),
  toolName: z.string().regex(TOOL_NAME_PATTERN),
  toolDefinitionId: z.string().uuid(),
  attestationId: z.string().uuid(),
  toolDefinitionFingerprint: z.string().regex(FINGERPRINT_PATTERN),
  networkFingerprint: z.string().regex(FINGERPRINT_PATTERN),
  credentialFingerprint: z.string().regex(FINGERPRINT_PATTERN),
  arguments: z.unknown(),
}).strict();

const connectionSelect = {
  id: true,
  name: true,
  endpointUrl: true,
  authKind: true,
  allowPrivateNetwork: true,
  protocolVersion: true,
  catalogFingerprint: true,
  status: true,
  lastDiscoveredAt: true,
  lastErrorCode: true,
  disabledAt: true,
  createdAt: true,
  updatedAt: true,
  credential: { select: { maskedSuffix: true, rotatedAt: true, updatedAt: true } },
  toolDefinitions: {
    where: { current: true },
    orderBy: { name: "asc" as const },
    select: {
      id: true,
      name: true,
      title: true,
      description: true,
      inputSchema: true,
      outputSchema: true,
      annotations: true,
      remoteReadOnlyHint: true,
      definitionFingerprint: true,
      discoveredAt: true,
      attestations: {
        orderBy: [{ createdAt: "desc" as const }, { id: "desc" as const }],
        take: 1,
        select: {
          id: true,
          definitionFingerprint: true,
          networkFingerprint: true,
          credentialFingerprint: true,
          attestedAt: true,
          audits: { orderBy: [{ createdAt: "desc" as const }, { id: "desc" as const }], take: 8, select: { event: true } },
        },
      },
    },
  },
} satisfies Prisma.McpConnectionSelect;

type McpDb = PrismaClient | Prisma.TransactionClient;
type McpFingerprintTuple = Readonly<{
  connectionId: string;
  toolDefinitionId: string;
  toolName: string;
  definitionFingerprint: string;
  networkFingerprint: string;
  credentialFingerprint: string;
}>;

const attestationPublicSelect = {
  id: true,
  connectionId: true,
  toolDefinitionId: true,
  toolName: true,
  definitionFingerprint: true,
  networkFingerprint: true,
  credentialFingerprint: true,
  verifiedBy: { select: { id: true, username: true, displayName: true } },
  note: true,
  evidence: true,
  attestedAt: true,
  createdAt: true,
  audits: {
    orderBy: [{ createdAt: "asc" as const }, { id: "asc" as const }],
    select: { id: true, event: true, actorId: true, details: true, createdAt: true },
  },
} satisfies Prisma.McpToolAttestationSelect;

export type McpActionSnapshot = Readonly<{
  grantId: string;
  connectionId: string;
  toolName: string;
  toolDefinitionId: string;
  attestationId: string;
  toolDefinitionFingerprint: string;
  networkFingerprint: string;
  credentialFingerprint: string;
  arguments: Readonly<Record<string, JsonValue>>;
}>;

function uuid(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) return failMcp("MCP_INVALID_INPUT");
  return value;
}

function isPrismaCode(error: unknown, code: string): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
}

function timestamp(value: string): Date {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : failMcp("MCP_INVALID_INPUT");
}

function noCredentialFingerprint(): string {
  return createHash("sha256").update("mcp:no-credential:v1", "utf8").digest("hex");
}

function stableInputObject(value: unknown): Readonly<Record<string, JsonValue>> {
  const normalized = stableMcpJson(value);
  if (typeof normalized !== "object" || normalized === null || Array.isArray(normalized)) return failMcp("MCP_TOOL_INPUT_INVALID");
  return normalized;
}

async function activeMcpAttestation(db: McpDb, tuple: McpFingerprintTuple) {
  const candidates = await db.mcpToolAttestation.findMany({
    where: {
      connectionId: tuple.connectionId,
      toolDefinitionId: tuple.toolDefinitionId,
      toolName: tuple.toolName,
      definitionFingerprint: tuple.definitionFingerprint,
      networkFingerprint: tuple.networkFingerprint,
      credentialFingerprint: tuple.credentialFingerprint,
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    include: { audits: { select: { event: true } } },
  });
  const latest = candidates[0];
  return latest !== undefined && latest.audits.some((audit) => audit.event === "attested") && !latest.audits.some((audit) => audit.event === "revoked") ? latest : null;
}

function assertMcpAdmin(actor: AccessUser): void {
  if (actor.role !== "admin") return failMcp("MCP_ADMIN_REQUIRED");
}

function attestationEvidence(value: unknown): Prisma.InputJsonValue {
  const normalized = stableMcpJson(value);
  if (typeof normalized !== "object" || normalized === null || Array.isArray(normalized) || Buffer.byteLength(JSON.stringify(normalized), "utf8") > 16 * 1024) {
    return failMcp("MCP_INVALID_INPUT");
  }
  return normalized as Prisma.InputJsonValue;
}

async function loadMcpAttestationDefinition(db: McpDb, toolDefinitionId: string) {
  const definition = await db.mcpToolDefinition.findUnique({
    where: { id: toolDefinitionId },
    include: { connection: { include: { credential: true } } },
  });
  if (definition === null) return failMcp("MCP_TOOL_NOT_FOUND");
  if (!definition.current) return failMcp("MCP_TOOL_DEFINITION_STALE");
  if (!definition.remoteReadOnlyHint) return failMcp("MCP_TOOL_NOT_READ_ONLY");
  if (definition.connection.status !== "verified" || definition.connection.resolvedAddressFingerprint === null) return failMcp("MCP_CONNECTION_NOT_VERIFIED");
  return {
    definition,
    tuple: {
      connectionId: definition.connectionId,
      toolDefinitionId: definition.id,
      toolName: definition.name,
      definitionFingerprint: definition.definitionFingerprint,
      networkFingerprint: definition.connection.resolvedAddressFingerprint,
      credentialFingerprint: definition.connection.credential?.secretFingerprint ?? noCredentialFingerprint(),
    } satisfies McpFingerprintTuple,
  };
}

export async function attestMcpToolDefinition(
  toolDefinitionIdInput: unknown,
  input: unknown,
  actor: AccessUser,
  db: PrismaClient = getDb(),
  connectionIdInput?: unknown,
) {
  assertMcpAdmin(actor);
  const toolDefinitionId = uuid(toolDefinitionIdInput);
  const expectedConnectionId = connectionIdInput === undefined ? null : uuid(connectionIdInput);
  const parsed = attestSchema.safeParse(input);
  if (!parsed.success) return failMcp("MCP_INVALID_INPUT");
  const evidence = attestationEvidence(parsed.data.evidence);
  const loaded = await loadMcpAttestationDefinition(db, toolDefinitionId);
  if (expectedConnectionId !== null && loaded.tuple.connectionId !== expectedConnectionId) return failMcp("MCP_TOOL_NOT_FOUND");
  return db.$transaction(async (tx) => {
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${loaded.tuple.connectionId}::text, 32010003))`);
    const current = await loadMcpAttestationDefinition(tx, toolDefinitionId);
    if (JSON.stringify(current.tuple) !== JSON.stringify(loaded.tuple)) return failMcp("MCP_TOOL_DEFINITION_STALE");
    const now = new Date();
    const attestation = await tx.mcpToolAttestation.create({
      data: {
        id: randomUUID(),
        connectionId: current.tuple.connectionId,
        toolDefinitionId: current.tuple.toolDefinitionId,
        toolName: current.tuple.toolName,
        definitionFingerprint: current.tuple.definitionFingerprint,
        networkFingerprint: current.tuple.networkFingerprint,
        credentialFingerprint: current.tuple.credentialFingerprint,
        verifiedById: actor.id,
        note: parsed.data.note ?? null,
        evidence,
        attestedAt: now,
        createdAt: now,
      },
    });
    await tx.mcpToolAttestationAudit.create({
      data: {
        id: randomUUID(),
        attestationId: attestation.id,
        connectionId: current.tuple.connectionId,
        toolDefinitionId: current.tuple.toolDefinitionId,
        event: "attested",
        actorId: actor.id,
        definitionFingerprint: current.tuple.definitionFingerprint,
        networkFingerprint: current.tuple.networkFingerprint,
        credentialFingerprint: current.tuple.credentialFingerprint,
        details: { note: parsed.data.note ?? null, evidence },
      },
    });
    return tx.mcpToolAttestation.findUniqueOrThrow({ where: { id: attestation.id }, select: attestationPublicSelect });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function revokeMcpToolAttestation(
  attestationIdInput: unknown,
  input: unknown,
  actor: AccessUser,
  db: PrismaClient = getDb(),
) {
  assertMcpAdmin(actor);
  const attestationId = uuid(attestationIdInput);
  const parsed = revokeAttestationSchema.safeParse(input);
  if (!parsed.success) return failMcp("MCP_INVALID_INPUT");
  return db.$transaction(async (tx) => {
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${attestationId}::text, 32010004))`);
    const existing = await tx.mcpToolAttestation.findUnique({ where: { id: attestationId }, include: { audits: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] } } });
    if (existing === null) return failMcp("MCP_ATTESTATION_NOT_FOUND");
    if (existing.attestedAt.getTime() !== timestamp(parsed.data.expectedAttestedAt).getTime()) return failMcp("MCP_ATTESTATION_CONFLICT");
    if (!existing.audits.some((audit) => audit.event === "revoked")) {
      await tx.mcpToolAttestationAudit.create({
        data: {
          id: randomUUID(),
          attestationId: existing.id,
          connectionId: existing.connectionId,
          toolDefinitionId: existing.toolDefinitionId,
          event: "revoked",
          actorId: actor.id,
          definitionFingerprint: existing.definitionFingerprint,
          networkFingerprint: existing.networkFingerprint,
          credentialFingerprint: existing.credentialFingerprint,
          details: { note: parsed.data.note ?? null },
        },
      });
    }
    return tx.mcpToolAttestation.findUniqueOrThrow({ where: { id: existing.id }, select: attestationPublicSelect });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function listMcpConnections(db: PrismaClient = getDb()) {
  return db.mcpConnection.findMany({ orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: connectionSelect });
}

export async function createMcpConnection(input: unknown, actor: Pick<AppUser, "id">, db: PrismaClient = getDb()) {
  const parsed = createConnectionSchema.safeParse(input);
  if (!parsed.success || (parsed.data.authKind === "none") !== (parsed.data.bearerToken == null)) return failMcp("MCP_INVALID_INPUT");
  const endpoint = await resolveSecureEndpointFingerprint({ url: parsed.data.endpointUrl, allowPrivateNetwork: parsed.data.allowPrivateNetwork })
    .catch((error: unknown) => {
      if (error instanceof Error && error.message === "WEB_SOURCE_NETWORK_BLOCKED") return failMcp("MCP_NETWORK_BLOCKED");
      return failMcp("MCP_TRANSPORT_FAILED");
    });
  try {
    return await db.$transaction(async (tx) => {
      const credential = parsed.data.authKind === "bearer"
        ? await createCredential("mcp", parsed.data.bearerToken, tx)
        : null;
      return tx.mcpConnection.create({
        data: {
          id: randomUUID(),
          name: parsed.data.name,
          endpointUrl: endpoint.url,
          authKind: parsed.data.authKind,
          credentialId: credential?.id ?? null,
          allowPrivateNetwork: parsed.data.allowPrivateNetwork,
          resolvedAddressFingerprint: endpoint.fingerprint,
          createdById: actor.id,
        },
        select: connectionSelect,
      });
    });
  } catch (error) {
    if (isPrismaCode(error, "P2002")) return failMcp("MCP_CONNECTION_NAME_CONFLICT");
    throw error;
  }
}

export async function updateMcpConnection(connectionIdInput: unknown, input: unknown, db: PrismaClient = getDb()) {
  const connectionId = uuid(connectionIdInput);
  const parsed = updateConnectionSchema.safeParse(input);
  if (!parsed.success) return failMcp("MCP_INVALID_INPUT");
  const existing = await db.mcpConnection.findUnique({ where: { id: connectionId } });
  if (existing === null) return failMcp("MCP_CONNECTION_NOT_FOUND");
  if (parsed.data.bearerToken !== undefined && (existing.authKind !== "bearer" || existing.credentialId === null)) return failMcp("MCP_INVALID_INPUT");
  const trusted = parsed.data.trustCurrentNetwork === true
    ? await resolveSecureEndpointFingerprint({ url: existing.endpointUrl, allowPrivateNetwork: existing.allowPrivateNetwork }).catch(() => failMcp("MCP_TRANSPORT_FAILED"))
    : null;
  try {
    return await db.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${connectionId}::text, 32010000))`);
      const current = await tx.mcpConnection.findUnique({ where: { id: connectionId } });
      if (current === null) return failMcp("MCP_CONNECTION_NOT_FOUND");
      if (current.updatedAt.getTime() !== timestamp(parsed.data.expectedUpdatedAt).getTime()) return failMcp("MCP_CONNECTION_CONFLICT");
      if (parsed.data.bearerToken !== undefined && (current.authKind !== "bearer" || current.credentialId === null)) return failMcp("MCP_INVALID_INPUT");
      if (parsed.data.bearerToken !== undefined) await rotateCredential(current.credentialId!, "mcp", parsed.data.bearerToken, tx);
      const securityChanged = parsed.data.bearerToken !== undefined || trusted !== null;
      const requestedStatus = parsed.data.enabled === false
        ? { status: "disabled" as const, disabledAt: new Date() }
        : parsed.data.enabled === true || securityChanged
          ? { status: "configured" as const, disabledAt: null }
          : {};
      return tx.mcpConnection.update({
        where: { id: connectionId },
        data: {
          ...(parsed.data.name === undefined ? {} : { name: parsed.data.name }),
          ...(trusted === null ? {} : { resolvedAddressFingerprint: trusted.fingerprint }),
          ...requestedStatus,
          ...(securityChanged ? { protocolVersion: null, catalogFingerprint: null, lastDiscoveredAt: null, lastErrorCode: null } : {}),
        },
        select: connectionSelect,
      });
    });
  } catch (error) {
    if (isPrismaCode(error, "P2002")) return failMcp("MCP_CONNECTION_NAME_CONFLICT");
    throw error;
  }
}

export async function deleteMcpConnection(connectionIdInput: unknown, input: unknown, db: PrismaClient = getDb()) {
  const connectionId = uuid(connectionIdInput);
  const parsed = deleteConnectionSchema.safeParse(input);
  if (!parsed.success) return failMcp("MCP_INVALID_INPUT");
  try {
    return await db.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${connectionId}::text, 32010005))`);
      const connection = await tx.mcpConnection.findUnique({
        where: { id: connectionId },
        select: { id: true, name: true, status: true, credentialId: true, updatedAt: true },
      });
      if (connection === null) return failMcp("MCP_CONNECTION_NOT_FOUND");
      if (connection.updatedAt.getTime() !== timestamp(parsed.data.expectedUpdatedAt).getTime()) {
        return failMcp("MCP_CONNECTION_CONFLICT");
      }
      if (connection.status !== "disabled") return failMcp("MCP_CONNECTION_DELETE_REQUIRES_DISABLED");
      if (connection.name !== parsed.data.confirmationName) return failMcp("MCP_CONNECTION_CONFIRMATION_MISMATCH");
      const grantCount = await tx.projectMcpToolGrant.count({ where: { connectionId } });
      if (grantCount > 0) return failMcp("MCP_CONNECTION_IN_USE");
      await tx.mcpConnection.delete({ where: { id: connection.id } });
      if (connection.credentialId !== null) {
        await tx.externalCredential.delete({ where: { id: connection.credentialId } });
      }
      return Object.freeze({ id: connection.id });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (isPrismaCode(error, "P2003")) return failMcp("MCP_CONNECTION_IN_USE");
    throw error;
  }
}

async function bearerToken(connection: Readonly<{ authKind: "none" | "bearer"; credentialId: string | null }>, db: PrismaClient): Promise<string | null> {
  if (connection.authKind === "none") return null;
  if (connection.credentialId === null) return failMcp("MCP_CONNECTION_NOT_VERIFIED");
  return readCredentialSecret(connection.credentialId, "mcp", db);
}

export async function discoverMcpConnectionTools(connectionIdInput: unknown, db: PrismaClient = getDb()) {
  const connectionId = uuid(connectionIdInput);
  const connection = await db.mcpConnection.findUnique({ where: { id: connectionId }, include: { credential: true } });
  if (connection === null) return failMcp("MCP_CONNECTION_NOT_FOUND");
  if (connection.status === "disabled") return failMcp("MCP_CONNECTION_DISABLED");
  try {
    const discovery = await discoverMcpTools({
      endpointUrl: connection.endpointUrl,
      allowPrivateNetwork: connection.allowPrivateNetwork,
      expectedAddressFingerprint: connection.resolvedAddressFingerprint,
      bearerToken: await bearerToken(connection, db),
    });
    const now = new Date();
    const stored = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "McpConnection" WHERE "id" = ${connectionId}::uuid FOR UPDATE`;
      const currentConnection = await tx.mcpConnection.findUnique({ where: { id: connectionId }, select: { status: true, updatedAt: true } });
      if (currentConnection === null || currentConnection.status === "disabled" || currentConnection.updatedAt.getTime() !== connection.updatedAt.getTime()) {
        return failMcp("MCP_CONNECTION_NOT_VERIFIED");
      }
      await tx.mcpToolDefinition.updateMany({ where: { connectionId, current: true }, data: { current: false, supersededAt: now } });
      for (const tool of discovery.tools) {
        const existing = await tx.mcpToolDefinition.findUnique({
          where: { connectionId_name_definitionFingerprint: { connectionId, name: tool.name, definitionFingerprint: tool.definitionFingerprint } },
          select: { id: true },
        });
        if (existing === null) {
          await tx.mcpToolDefinition.create({
            data: {
              id: randomUUID(), connectionId, name: tool.name, title: tool.title, description: tool.description,
              inputSchema: tool.inputSchema as Prisma.InputJsonValue,
              outputSchema: tool.outputSchema === null ? Prisma.DbNull : tool.outputSchema as Prisma.InputJsonValue,
              annotations: tool.annotations as Prisma.InputJsonValue,
              remoteReadOnlyHint: tool.remoteReadOnlyHint, definitionFingerprint: tool.definitionFingerprint,
              current: true, discoveredAt: now, supersededAt: null,
            },
          });
        } else {
          await tx.mcpToolDefinition.update({ where: { id: existing.id }, data: { current: true, supersededAt: null } });
        }
      }
      return tx.mcpConnection.update({
        where: { id: connectionId },
        data: {
          status: "verified", protocolVersion: MCP_PROTOCOL_VERSION, catalogFingerprint: discovery.catalogFingerprint,
          resolvedAddressFingerprint: discovery.addressFingerprint, lastDiscoveredAt: now, lastErrorCode: null, disabledAt: null,
        },
        select: connectionSelect,
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    return Object.freeze({ connection: stored, discoveredCount: discovery.tools.length, eligibleCount: discovery.tools.filter((tool) => tool.remoteReadOnlyHint).length, rejectedCount: discovery.rejectedCount });
  } catch (error) {
    const code = error instanceof McpCapabilityError ? error.code : "MCP_TRANSPORT_FAILED";
    const marked = await db.mcpConnection.updateMany({
      where: { id: connectionId, status: { not: "disabled" }, updatedAt: connection.updatedAt },
      data: { status: "error", lastErrorCode: code, lastDiscoveredAt: new Date() },
    });
    if (marked.count === 0) return failMcp("MCP_CONNECTION_NOT_VERIFIED");
    throw error;
  }
}

const grantSelect = {
  id: true,
  projectId: true,
  connectionId: true,
  toolName: true,
  toolDefinitionId: true,
  attestationId: true,
  definitionFingerprint: true,
  networkFingerprint: true,
  credentialFingerprint: true,
  status: true,
  acknowledgedAt: true,
  revokedAt: true,
  createdAt: true,
  updatedAt: true,
  managedBy: { select: { id: true, username: true, displayName: true } },
  toolDefinition: {
    select: {
      id: true, name: true, title: true, description: true, inputSchema: true, annotations: true,
      remoteReadOnlyHint: true, definitionFingerprint: true, current: true,
      connection: { select: { id: true, name: true, status: true, endpointUrl: true } },
    },
  },
  attestation: { select: { id: true, definitionFingerprint: true, networkFingerprint: true, credentialFingerprint: true, attestedAt: true } },
  audits: { orderBy: [{ createdAt: "desc" as const }, { id: "desc" as const }], take: 8, select: { id: true, event: true, definitionFingerprint: true, details: true, createdAt: true, actor: { select: { username: true, displayName: true } } } },
} satisfies Prisma.ProjectMcpToolGrantSelect;

export async function getProjectMcpToolCenter(projectIdInput: unknown, actor: AccessUser, db: PrismaClient = getDb()) {
  const projectId = uuid(projectIdInput);
  await assertProjectAccess(actor, projectId, "view", db);
  const permission = await getProjectPermission(actor, projectId, db);
  if (permission === null) return failMcp("MCP_GRANT_NOT_FOUND");
  const [definitions, grants, project] = await Promise.all([
    db.mcpToolDefinition.findMany({
      where: { current: true, connection: { status: { not: "disabled" } } },
      orderBy: [{ connection: { name: "asc" } }, { name: "asc" }],
      select: {
        id: true, name: true, title: true, description: true, inputSchema: true, annotations: true,
        remoteReadOnlyHint: true, definitionFingerprint: true, discoveredAt: true,
        attestations: {
          orderBy: [{ createdAt: "desc" as const }, { id: "desc" as const }],
          take: 1,
          select: { id: true, definitionFingerprint: true, networkFingerprint: true, credentialFingerprint: true, attestedAt: true, audits: { select: { event: true } } },
        },
        connection: { select: { id: true, name: true, endpointUrl: true, status: true, lastDiscoveredAt: true } },
      },
    }),
    db.projectMcpToolGrant.findMany({ where: { projectId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: grantSelect }),
    db.project.findUnique({ where: { id: projectId }, select: { archivedAt: true } }),
  ]);
  if (project === null) return failMcp("MCP_GRANT_NOT_FOUND");
  const currentIds = new Set(definitions.map((definition) => definition.id));
  const definitionViews = definitions.map(({ attestations, ...definition }) => {
    const latestAttestation = attestations[0];
    const attested = definition.connection.status === "verified"
      && latestAttestation !== undefined
      && latestAttestation.definitionFingerprint === definition.definitionFingerprint
      && latestAttestation.audits.some((audit) => audit.event === "attested")
      && !latestAttestation.audits.some((audit) => audit.event === "revoked");
    return Object.freeze({ ...definition, attested, attestationId: attested ? latestAttestation.id : null });
  });
  return Object.freeze({
    definitions: definitionViews,
    grants: grants.map((grant) => Object.freeze({ ...grant, stale: grant.status === "active" && (!currentIds.has(grant.toolDefinitionId) || grant.toolDefinition.connection.status !== "verified" || grant.attestationId === null || grant.attestation === null) })),
    canManage: permission === "owner",
    canInvoke: permission === "owner" || permission === "edit",
    archived: project.archivedAt !== null,
  });
}

export async function grantProjectMcpTool(projectIdInput: unknown, input: unknown, actor: AccessUser, db: PrismaClient = getDb()) {
  const projectId = uuid(projectIdInput);
  const parsed = grantSchema.safeParse(input);
  if (!parsed.success) return failMcp("MCP_INVALID_INPUT");
  await assertProjectActive(projectId, db);
  await assertProjectAccess(actor, projectId, "owner", db);
  return db.$transaction(async (tx) => {
    const definition = await tx.mcpToolDefinition.findUnique({
      where: { id: parsed.data.toolDefinitionId },
      include: { connection: { include: { credential: true } } },
    });
    if (definition === null || !definition.current) return failMcp("MCP_TOOL_NOT_FOUND");
    if (!definition.remoteReadOnlyHint) return failMcp("MCP_TOOL_NOT_READ_ONLY");
    if (definition.connection.status !== "verified" || definition.connection.resolvedAddressFingerprint === null) return failMcp("MCP_CONNECTION_NOT_VERIFIED");
    const attestation = await activeMcpAttestation(tx, {
      connectionId: definition.connectionId,
      toolDefinitionId: definition.id,
      toolName: definition.name,
      definitionFingerprint: definition.definitionFingerprint,
      networkFingerprint: definition.connection.resolvedAddressFingerprint,
      credentialFingerprint: definition.connection.credential?.secretFingerprint ?? noCredentialFingerprint(),
    });
    if (attestation === null) return failMcp("MCP_TOOL_NOT_ATTESTED");
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${projectId}:${definition.connectionId}:${definition.name}`}::text, 32010001))`);
    const existing = await tx.projectMcpToolGrant.findUnique({ where: { projectId_connectionId_toolName: { projectId, connectionId: definition.connectionId, toolName: definition.name } } });
    const expected = parsed.data.expectedUpdatedAt === null ? null : timestamp(parsed.data.expectedUpdatedAt);
    if ((existing === null) !== (expected === null) || (existing !== null && expected !== null && existing.updatedAt.getTime() !== expected.getTime())) return failMcp("MCP_GRANT_CONFLICT");
    if (
      existing?.status === "active"
      && existing.toolDefinitionId === definition.id
      && existing.attestationId === attestation.id
      && existing.definitionFingerprint === definition.definitionFingerprint
      && existing.networkFingerprint === definition.connection.resolvedAddressFingerprint
      && existing.credentialFingerprint === (definition.connection.credential?.secretFingerprint ?? noCredentialFingerprint())
    ) return tx.projectMcpToolGrant.findUniqueOrThrow({ where: { id: existing.id }, select: grantSelect });
    const now = new Date();
    const grant = existing === null
      ? await tx.projectMcpToolGrant.create({ data: { id: randomUUID(), projectId, connectionId: definition.connectionId, toolName: definition.name, toolDefinitionId: definition.id, attestationId: attestation.id, definitionFingerprint: definition.definitionFingerprint, networkFingerprint: definition.connection.resolvedAddressFingerprint, credentialFingerprint: definition.connection.credential?.secretFingerprint ?? noCredentialFingerprint(), status: "active", managedById: actor.id, acknowledgedAt: now, revokedAt: null, createdAt: now, updatedAt: now } })
      : await tx.projectMcpToolGrant.update({ where: { id: existing.id }, data: { toolDefinitionId: definition.id, attestationId: attestation.id, definitionFingerprint: definition.definitionFingerprint, networkFingerprint: definition.connection.resolvedAddressFingerprint, credentialFingerprint: definition.connection.credential?.secretFingerprint ?? noCredentialFingerprint(), status: "active", managedById: actor.id, acknowledgedAt: now, revokedAt: null, updatedAt: now } });
    await tx.projectMcpToolGrantAudit.create({
      data: { id: randomUUID(), projectId, grantId: grant.id, event: existing === null ? "granted" : "refreshed", actorId: actor.id, definitionFingerprint: definition.definitionFingerprint, details: { connectionId: definition.connectionId, toolName: definition.name, previousDefinitionId: existing?.toolDefinitionId ?? null } },
    });
    return tx.projectMcpToolGrant.findUniqueOrThrow({ where: { id: grant.id }, select: grantSelect });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function revokeProjectMcpToolGrant(projectIdInput: unknown, grantIdInput: unknown, input: unknown, actor: AccessUser, db: PrismaClient = getDb()) {
  const projectId = uuid(projectIdInput);
  const grantId = uuid(grantIdInput);
  const parsed = revokeSchema.safeParse(input);
  if (!parsed.success) return failMcp("MCP_INVALID_INPUT");
  await assertProjectActive(projectId, db);
  await assertProjectAccess(actor, projectId, "owner", db);
  return db.$transaction(async (tx) => {
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${grantId}::text, 32010002))`);
    const existing = await tx.projectMcpToolGrant.findFirst({ where: { id: grantId, projectId }, include: { toolDefinition: true } });
    if (existing === null) return failMcp("MCP_GRANT_NOT_FOUND");
    if (existing.updatedAt.getTime() !== timestamp(parsed.data.expectedUpdatedAt).getTime()) return failMcp("MCP_GRANT_CONFLICT");
    if (existing.status === "revoked") return tx.projectMcpToolGrant.findUniqueOrThrow({ where: { id: grantId }, select: grantSelect });
    const now = new Date();
    await tx.projectMcpToolGrant.update({ where: { id: grantId }, data: { status: "revoked", managedById: actor.id, revokedAt: now, updatedAt: now } });
    await tx.projectMcpToolGrantAudit.create({ data: { id: randomUUID(), projectId, grantId, event: "revoked", actorId: actor.id, definitionFingerprint: existing.toolDefinition.definitionFingerprint, details: { connectionId: existing.connectionId, toolName: existing.toolName } } });
    return tx.projectMcpToolGrant.findUniqueOrThrow({ where: { id: grantId }, select: grantSelect });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function buildMcpActionSnapshot(projectIdInput: unknown, input: unknown, db: PrismaClient = getDb()): Promise<McpActionSnapshot> {
  const projectId = uuid(projectIdInput);
  const parsed = clientCallSchema.safeParse(input);
  if (!parsed.success) return failMcp("MCP_INVALID_INPUT");
  const grant = await db.projectMcpToolGrant.findFirst({
    where: { id: parsed.data.grantId, projectId },
    include: { attestation: true, toolDefinition: { include: { connection: { include: { credential: true } } } } },
  });
  if (grant === null) return failMcp("MCP_GRANT_NOT_FOUND");
  if (grant.status !== "active") return failMcp("MCP_GRANT_REVOKED");
  const definition = grant.toolDefinition;
  const connection = definition.connection;
  if (!definition.current) return failMcp("MCP_TOOL_DEFINITION_STALE");
  if (!definition.remoteReadOnlyHint) return failMcp("MCP_TOOL_NOT_READ_ONLY");
  if (connection.status !== "verified" || connection.resolvedAddressFingerprint === null) return failMcp("MCP_CONNECTION_NOT_VERIFIED");
  const credentialFingerprint = connection.credential?.secretFingerprint ?? noCredentialFingerprint();
  const attestation = grant.attestationId === null
    ? null
    : await activeMcpAttestation(db, {
      connectionId: connection.id,
      toolDefinitionId: definition.id,
      toolName: definition.name,
      definitionFingerprint: definition.definitionFingerprint,
      networkFingerprint: connection.resolvedAddressFingerprint,
      credentialFingerprint,
    });
  if (attestation === null || attestation.id !== grant.attestationId) return failMcp("MCP_TOOL_NOT_ATTESTED");
  const argumentsValue = canonicalMcpToolArguments(definition.inputSchema, parsed.data.arguments);
  return Object.freeze({
    grantId: grant.id,
    connectionId: connection.id,
    toolName: definition.name,
    toolDefinitionId: definition.id,
    attestationId: attestation.id,
    toolDefinitionFingerprint: definition.definitionFingerprint,
    networkFingerprint: connection.resolvedAddressFingerprint,
    credentialFingerprint,
    arguments: stableInputObject(argumentsValue),
  });
}

export function canonicalMcpActionSnapshot(input: unknown): McpActionSnapshot {
  const parsed = snapshotSchema.safeParse(input);
  if (!parsed.success) return failMcp("MCP_INVALID_INPUT");
  return Object.freeze({ ...parsed.data, arguments: stableInputObject(parsed.data.arguments) });
}

export async function executeMcpActionSnapshot(projectIdInput: unknown, input: unknown, db: PrismaClient = getDb()): Promise<Readonly<McpToolCallResult & { connectionId: string; toolName: string; definitionFingerprint: string }>> {
  const projectId = uuid(projectIdInput);
  const snapshot = canonicalMcpActionSnapshot(input);
  const grant = await db.projectMcpToolGrant.findFirst({
    where: { id: snapshot.grantId, projectId },
    include: { attestation: true, toolDefinition: { include: { connection: { include: { credential: true } } } } },
  });
  if (grant === null) return failMcp("MCP_GRANT_NOT_FOUND");
  if (grant.status !== "active") return failMcp("MCP_GRANT_REVOKED");
  const definition = grant.toolDefinition;
  const connection = definition.connection;
  if (grant.connectionId !== snapshot.connectionId || grant.toolName !== snapshot.toolName || grant.toolDefinitionId !== snapshot.toolDefinitionId || grant.attestationId !== snapshot.attestationId || !definition.current || definition.definitionFingerprint !== snapshot.toolDefinitionFingerprint) return failMcp("MCP_TOOL_DEFINITION_STALE");
  if (!definition.remoteReadOnlyHint) return failMcp("MCP_TOOL_NOT_READ_ONLY");
  if (connection.status !== "verified" || connection.resolvedAddressFingerprint !== snapshot.networkFingerprint) return failMcp("MCP_NETWORK_CHANGED");
  const credentialFingerprint = connection.credential?.secretFingerprint ?? noCredentialFingerprint();
  if (credentialFingerprint !== snapshot.credentialFingerprint || grant.attestation === null) return failMcp("MCP_TOOL_DEFINITION_STALE");
  const attestation = grant.attestationId === null
    ? null
    : await activeMcpAttestation(db, {
      connectionId: connection.id,
      toolDefinitionId: definition.id,
      toolName: definition.name,
      definitionFingerprint: definition.definitionFingerprint,
      networkFingerprint: snapshot.networkFingerprint,
      credentialFingerprint,
    });
  if (attestation === null || attestation.id !== snapshot.attestationId) return failMcp("MCP_TOOL_NOT_ATTESTED");
  const argumentsValue = canonicalMcpToolArguments(definition.inputSchema, snapshot.arguments);
  const result = await callMcpTool({
    endpointUrl: connection.endpointUrl,
    allowPrivateNetwork: connection.allowPrivateNetwork,
    expectedAddressFingerprint: snapshot.networkFingerprint,
    bearerToken: await bearerToken(connection, db),
    toolName: definition.name,
    inputSchema: definition.inputSchema,
    arguments: argumentsValue,
  });
  return Object.freeze({ ...result, connectionId: connection.id, toolName: definition.name, definitionFingerprint: definition.definitionFingerprint });
}
