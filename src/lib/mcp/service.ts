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

const grantSchema = z.object({
  toolDefinitionId: z.string().uuid(),
  acknowledgeReadOnly: z.literal(true),
  expectedUpdatedAt: z.string().datetime({ offset: true }).nullable(),
}).strict();

const revokeSchema = z.object({ expectedUpdatedAt: z.string().datetime({ offset: true }) }).strict();
const clientCallSchema = z.object({ grantId: z.string().uuid(), arguments: z.unknown() }).strict();
const snapshotSchema = z.object({
  grantId: z.string().uuid(),
  connectionId: z.string().uuid(),
  toolName: z.string().regex(TOOL_NAME_PATTERN),
  toolDefinitionId: z.string().uuid(),
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
      readOnlyEligible: true,
      definitionFingerprint: true,
      discoveredAt: true,
    },
  },
} satisfies Prisma.McpConnectionSelect;

export type McpActionSnapshot = Readonly<{
  grantId: string;
  connectionId: string;
  toolName: string;
  toolDefinitionId: string;
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
              readOnlyEligible: tool.readOnlyEligible, definitionFingerprint: tool.definitionFingerprint,
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
    return Object.freeze({ connection: stored, discoveredCount: discovery.tools.length, eligibleCount: discovery.tools.filter((tool) => tool.readOnlyEligible).length, rejectedCount: discovery.rejectedCount });
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
  status: true,
  acknowledgedAt: true,
  revokedAt: true,
  createdAt: true,
  updatedAt: true,
  managedBy: { select: { id: true, username: true, displayName: true } },
  toolDefinition: {
    select: {
      id: true, name: true, title: true, description: true, inputSchema: true, annotations: true,
      readOnlyEligible: true, definitionFingerprint: true, current: true,
      connection: { select: { id: true, name: true, status: true, endpointUrl: true } },
    },
  },
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
        readOnlyEligible: true, definitionFingerprint: true, discoveredAt: true,
        connection: { select: { id: true, name: true, endpointUrl: true, status: true, lastDiscoveredAt: true } },
      },
    }),
    db.projectMcpToolGrant.findMany({ where: { projectId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: grantSelect }),
    db.project.findUnique({ where: { id: projectId }, select: { archivedAt: true } }),
  ]);
  if (project === null) return failMcp("MCP_GRANT_NOT_FOUND");
  const currentIds = new Set(definitions.map((definition) => definition.id));
  return Object.freeze({
    definitions,
    grants: grants.map((grant) => Object.freeze({ ...grant, stale: grant.status === "active" && (!currentIds.has(grant.toolDefinitionId) || grant.toolDefinition.connection.status !== "verified") })),
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
      include: { connection: true },
    });
    if (definition === null || !definition.current) return failMcp("MCP_TOOL_NOT_FOUND");
    if (!definition.readOnlyEligible) return failMcp("MCP_TOOL_NOT_READ_ONLY");
    if (definition.connection.status !== "verified") return failMcp("MCP_CONNECTION_NOT_VERIFIED");
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${projectId}:${definition.connectionId}:${definition.name}`}::text, 32010001))`);
    const existing = await tx.projectMcpToolGrant.findUnique({ where: { projectId_connectionId_toolName: { projectId, connectionId: definition.connectionId, toolName: definition.name } } });
    const expected = parsed.data.expectedUpdatedAt === null ? null : timestamp(parsed.data.expectedUpdatedAt);
    if ((existing === null) !== (expected === null) || (existing !== null && expected !== null && existing.updatedAt.getTime() !== expected.getTime())) return failMcp("MCP_GRANT_CONFLICT");
    if (existing?.status === "active" && existing.toolDefinitionId === definition.id) return tx.projectMcpToolGrant.findUniqueOrThrow({ where: { id: existing.id }, select: grantSelect });
    const now = new Date();
    const grant = existing === null
      ? await tx.projectMcpToolGrant.create({ data: { id: randomUUID(), projectId, connectionId: definition.connectionId, toolName: definition.name, toolDefinitionId: definition.id, status: "active", managedById: actor.id, acknowledgedAt: now, revokedAt: null, createdAt: now, updatedAt: now } })
      : await tx.projectMcpToolGrant.update({ where: { id: existing.id }, data: { toolDefinitionId: definition.id, status: "active", managedById: actor.id, acknowledgedAt: now, revokedAt: null, updatedAt: now } });
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
    include: { toolDefinition: { include: { connection: { include: { credential: true } } } } },
  });
  if (grant === null) return failMcp("MCP_GRANT_NOT_FOUND");
  if (grant.status !== "active") return failMcp("MCP_GRANT_REVOKED");
  const definition = grant.toolDefinition;
  const connection = definition.connection;
  if (!definition.current) return failMcp("MCP_TOOL_DEFINITION_STALE");
  if (!definition.readOnlyEligible) return failMcp("MCP_TOOL_NOT_READ_ONLY");
  if (connection.status !== "verified" || connection.resolvedAddressFingerprint === null) return failMcp("MCP_CONNECTION_NOT_VERIFIED");
  const argumentsValue = canonicalMcpToolArguments(definition.inputSchema, parsed.data.arguments);
  return Object.freeze({
    grantId: grant.id,
    connectionId: connection.id,
    toolName: definition.name,
    toolDefinitionId: definition.id,
    toolDefinitionFingerprint: definition.definitionFingerprint,
    networkFingerprint: connection.resolvedAddressFingerprint,
    credentialFingerprint: connection.credential?.secretFingerprint ?? noCredentialFingerprint(),
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
    include: { toolDefinition: { include: { connection: { include: { credential: true } } } } },
  });
  if (grant === null) return failMcp("MCP_GRANT_NOT_FOUND");
  if (grant.status !== "active") return failMcp("MCP_GRANT_REVOKED");
  const definition = grant.toolDefinition;
  const connection = definition.connection;
  if (grant.connectionId !== snapshot.connectionId || grant.toolName !== snapshot.toolName || grant.toolDefinitionId !== snapshot.toolDefinitionId || !definition.current || definition.definitionFingerprint !== snapshot.toolDefinitionFingerprint) return failMcp("MCP_TOOL_DEFINITION_STALE");
  if (!definition.readOnlyEligible) return failMcp("MCP_TOOL_NOT_READ_ONLY");
  if (connection.status !== "verified" || connection.resolvedAddressFingerprint !== snapshot.networkFingerprint) return failMcp("MCP_NETWORK_CHANGED");
  if ((connection.credential?.secretFingerprint ?? noCredentialFingerprint()) !== snapshot.credentialFingerprint) return failMcp("MCP_TOOL_DEFINITION_STALE");
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
