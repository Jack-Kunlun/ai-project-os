import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { AccountAccessGuardError, assertAccountAccessForActor } from "@/lib/account-access-guard";
import { getDb } from "@/lib/db";
import { lockActorWorkspaceProjectAccess } from "@/lib/access-linearization";
import { isSerializationConflict } from "@/lib/project-snapshot-errors";
import { sanitizeMcpAttestationJson } from "@/lib/mcp-attestation-control-plane-service";
import { hasApprovedMcpToolReview } from "@/lib/mcp-tool-review-service";

const UUID = z.string().uuid();
const VERSION = z.number().int().positive();
const NO_CREDENTIAL_FINGERPRINT = "d2ab012fb807b99b7d059aabe98a45dd6edf6941a5f22699f8d04b5906dc2c2b";
const MAX_SERIALIZABLE_RETRIES = 3;

const createSchema = z.object({
  delegationId: UUID,
  toolDefinitionId: UUID,
  attestationId: UUID,
  expectedDelegationVersion: VERSION,
  expectedAttestationVersion: z.literal(1),
  acknowledgeReadOnly: z.literal(true),
}).strict();

const revokeSchema = z.object({ expectedGrantVersion: VERSION }).strict();

export type ProjectMcpToolGrantServiceErrorCode =
  | "PROJECT_MCP_TOOL_GRANT_INVALID_INPUT"
  | "PROJECT_MCP_TOOL_GRANT_FORBIDDEN"
  | "PROJECT_MCP_TOOL_GRANT_PROJECT_OWNER_REQUIRED"
  | "PROJECT_MCP_TOOL_GRANT_NOT_FOUND"
  | "PROJECT_MCP_TOOL_GRANT_PROJECT_ARCHIVED"
  | "PROJECT_MCP_TOOL_GRANT_STALE"
  | "PROJECT_MCP_TOOL_GRANT_CONFLICT"
  | "PROJECT_MCP_TOOL_GRANT_ACCOUNT_DISABLED";

export class ProjectMcpToolGrantServiceError extends Error {
  constructor(readonly code: ProjectMcpToolGrantServiceErrorCode) {
    super(code);
    this.name = "ProjectMcpToolGrantServiceError";
  }
}

type Tx = Prisma.TransactionClient;
type Actor = Readonly<{ id: string; role: string; accountAccessVersion?: number }>;

function fail(code: ProjectMcpToolGrantServiceErrorCode): never {
  throw new ProjectMcpToolGrantServiceError(code);
}

function parseUuid(value: unknown): string {
  const parsed = UUID.safeParse(value);
  return parsed.success ? parsed.data : fail("PROJECT_MCP_TOOL_GRANT_INVALID_INPUT");
}

function parseActor(actor: Actor): string {
  return parseUuid(actor.id);
}

type CreateGrantPreflight = Readonly<{
  delegationId: string;
  toolDefinitionId: string;
  attestationId: string;
  connectionId: string;
  toolName: string;
  connectionOwnerId: string;
  connectionOwnerAccountAccessVersion: number;
  projectConfirmedById: string;
  attestationVerifierId: string;
}>;

async function withSerializableRetry<T>(db: PrismaClient, operation: (tx: Tx) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < MAX_SERIALIZABLE_RETRIES; attempt += 1) {
    try {
      return await db.$transaction(operation, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (isGrantSerializationConflict(error)) {
        if (attempt === MAX_SERIALIZABLE_RETRIES - 1) return fail("PROJECT_MCP_TOOL_GRANT_CONFLICT");
        continue;
      }
      if (mapDatabaseMutationError(error) === undefined) throw error;
    }
  }
  return fail("PROJECT_MCP_TOOL_GRANT_CONFLICT");
}

function isGrantSerializationConflict(error: unknown): boolean {
  if (isSerializationConflict(error)) return true;
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2010") return false;
  return /\b(?:40001|40P01)\b/u.test(JSON.stringify([error.message, error.meta]));
}

function mapDatabaseMutationError(error: unknown): never | undefined {
  if (error instanceof ProjectMcpToolGrantServiceError) throw error;
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2002" || error.code === "P2003" || error.code === "P2025" || error.code === "P2010") {
      return fail("PROJECT_MCP_TOOL_GRANT_CONFLICT");
    }
  }
  if (error instanceof Error && /PROJECT_MCP_TOOL_GRANT|MCP_TOOL_GRANT/u.test(error.message)) {
    return fail("PROJECT_MCP_TOOL_GRANT_CONFLICT");
  }
  return undefined;
}

async function lockConnection(tx: Tx, connectionId: string): Promise<void> {
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${connectionId}::text, 32010000))`);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "McpConnection" WHERE "id" = ${connectionId}::uuid FOR UPDATE`);
}

async function lockTuple(tx: Tx, connectionId: string, toolDefinitionId: string): Promise<void> {
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${connectionId}:${toolDefinitionId}`}::text, 32010003))`);
}

async function lockGrantSlot(tx: Tx, key: string): Promise<void> {
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}::text, 32010007))`);
}

async function lockGrantRow(tx: Tx, projectId: string, grantId: string): Promise<void> {
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${grantId}::text, 32010002))`);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "ProjectMcpToolGrant" WHERE "id" = ${grantId}::uuid AND "projectId" = ${projectId}::uuid AND "controlPlaneVersion" = 2 FOR UPDATE`);
}

type ProjectOwnerEpoch = Readonly<{ id: string; userId: string; createdAt: Date }>;

async function reloadOwnerEpoch(tx: Tx, projectId: string, actorId: string): Promise<ProjectOwnerEpoch> {
  const actor = await tx.appUser.findUnique({ where: { id: actorId }, select: { id: true, disabledAt: true } });
  if (actor === null || actor.disabledAt !== null) return fail("PROJECT_MCP_TOOL_GRANT_ACCOUNT_DISABLED");
  const membership = await tx.projectMembership.findFirst({
    where: { projectId, userId: actorId, accessState: "confirmed" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, userId: true, role: true, createdAt: true },
  });
  if (membership === null) return fail("PROJECT_MCP_TOOL_GRANT_FORBIDDEN");
  if (membership.role !== "owner") return fail("PROJECT_MCP_TOOL_GRANT_PROJECT_OWNER_REQUIRED");
  return membership;
}

async function lockAdmission(
  tx: Tx,
  projectId: string,
  actorIds: readonly string[],
  connectionId?: string,
  toolDefinitionId?: string,
  grantSlot?: string,
  grantId?: string,
): Promise<void> {
  const project = await tx.project.findUnique({ where: { id: projectId }, select: { id: true, workspaceId: true } });
  if (project === null) return fail("PROJECT_MCP_TOOL_GRANT_FORBIDDEN");
  await lockActorWorkspaceProjectAccess(tx, { actorIds, workspaceId: project.workspaceId, projectId });
  if (connectionId !== undefined) await lockConnection(tx, connectionId);
  if (connectionId !== undefined && toolDefinitionId !== undefined) await lockTuple(tx, connectionId, toolDefinitionId);
  if (grantSlot !== undefined) await lockGrantSlot(tx, grantSlot);
  if (grantId !== undefined) await lockGrantRow(tx, projectId, grantId);
}

async function requireActorAndProject(
  tx: Tx,
  projectId: string,
  actorId: string,
  allowArchived: boolean,
  accountAccessVersion?: number,
): Promise<{ project: { id: string; workspaceId: string; archivedAt: Date | null }; membership: ProjectOwnerEpoch }> {
  const [actor, project] = await Promise.all([
    tx.appUser.findUnique({ where: { id: actorId }, select: { id: true, disabledAt: true, accountAccessVersion: true } }),
    tx.project.findUnique({ where: { id: projectId }, select: { id: true, workspaceId: true, archivedAt: true } }),
  ]);
  if (actor === null || project === null) return fail("PROJECT_MCP_TOOL_GRANT_FORBIDDEN");
  if (actor.disabledAt !== null) return fail("PROJECT_MCP_TOOL_GRANT_ACCOUNT_DISABLED");
  try {
    await assertAccountAccessForActor(tx, { id: actorId, accountAccessVersion });
  } catch (error) {
    if (error instanceof AccountAccessGuardError && error.code === "ACCOUNT_DISABLED") {
      return fail("PROJECT_MCP_TOOL_GRANT_ACCOUNT_DISABLED");
    }
    return fail("PROJECT_MCP_TOOL_GRANT_FORBIDDEN");
  }
  if (!allowArchived && project.archivedAt !== null) return fail("PROJECT_MCP_TOOL_GRANT_PROJECT_ARCHIVED");
  const membership = await reloadOwnerEpoch(tx, projectId, actorId);
  return { project, membership };
}

function safeDate(value: Date | null | undefined): string | null {
  return value?.toISOString() ?? null;
}

function safeText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const sanitized = sanitizeMcpAttestationJson(value);
  return typeof sanitized === "string" ? sanitized : "[redacted]";
}

type GrantProjectionRow = {
  id: string;
  projectId: string;
  connectionId: string;
  delegationId: string | null;
  controlPlaneVersion: number | null;
  grantVersion: number | null;
  toolName: string;
  toolDefinitionId: string;
  attestationId: string | null;
  connectionOwnerAccountAccessVersion: number | null;
  status: "active" | "revoked";
  acknowledgedAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
  toolDefinition: {
    id: string;
    name: string;
    title: string | null;
    description: string | null;
    inputSchema: unknown;
    outputSchema: unknown;
    annotations: unknown;
    remoteReadOnlyHint: boolean;
    current: boolean;
    definitionFingerprint: string;
  };
  delegation: { id: string; status: string; version: number; expiresAt: Date } | null;
  attestation: {
    id: string;
    connectionId: string;
    toolDefinitionId: string;
    toolName: string;
    definitionFingerprint: string;
    networkFingerprint: string;
    credentialFingerprint: string;
    connectionConfigurationRevision: number | null;
    connectionOwnerAccountAccessVersion: number | null;
    status: string | null;
    version: number | null;
    conclusion: string | null;
    riskLevel: string | null;
    evidenceNote: string | null;
  } | null;
};

const grantProjectionSelect = {
  id: true,
  projectId: true,
  connectionId: true,
  delegationId: true,
  controlPlaneVersion: true,
  grantVersion: true,
  toolName: true,
  toolDefinitionId: true,
  attestationId: true,
  connectionOwnerAccountAccessVersion: true,
  status: true,
  acknowledgedAt: true,
  revokedAt: true,
  createdAt: true,
  toolDefinition: { select: { id: true, name: true, title: true, description: true, inputSchema: true, outputSchema: true, annotations: true, remoteReadOnlyHint: true, current: true, definitionFingerprint: true } },
  delegation: { select: { id: true, status: true, version: true, expiresAt: true } },
  attestation: { select: { id: true, connectionId: true, toolDefinitionId: true, toolName: true, definitionFingerprint: true, networkFingerprint: true, credentialFingerprint: true, connectionConfigurationRevision: true, connectionOwnerAccountAccessVersion: true, status: true, version: true, conclusion: true, riskLevel: true, evidenceNote: true } },
} satisfies Prisma.ProjectMcpToolGrantSelect;

type GrantAdmission = Readonly<{ effective: boolean; effectiveReason: string | null }>;

function projectGrant(row: GrantProjectionRow, admission: GrantAdmission = { effective: row.status === "active", effectiveReason: null }): Readonly<Record<string, unknown>> {
  return Object.freeze({
    id: row.id,
    delegationId: row.delegationId,
    toolDefinitionId: row.toolDefinitionId,
    attestationId: row.attestationId,
    status: row.status,
    effective: admission.effective,
    ...(admission.effectiveReason === null ? {} : { effectiveReason: admission.effectiveReason }),
    reviewRequired: admission.effectiveReason === "review_required",
    grantVersion: row.grantVersion,
    toolName: safeText(row.toolName),
    tool: {
      id: row.toolDefinition.id,
      name: safeText(row.toolDefinition.name),
      title: safeText(row.toolDefinition.title),
      description: safeText(row.toolDefinition.description),
      inputSchema: sanitizeMcpAttestationJson(row.toolDefinition.inputSchema),
      outputSchema: sanitizeMcpAttestationJson(row.toolDefinition.outputSchema),
      annotations: sanitizeMcpAttestationJson(row.toolDefinition.annotations),
      remoteTextTrust: "untrusted",
    },
    delegation: row.delegation === null ? null : {
      id: row.delegation.id,
      status: row.delegation.status,
      version: row.delegation.version,
      expiresAt: safeDate(row.delegation.expiresAt),
    },
    attestation: row.attestation === null ? null : {
      id: row.attestation.id,
      status: row.attestation.status,
      version: row.attestation.version,
      conclusion: row.attestation.conclusion,
      riskLevel: row.attestation.riskLevel,
      evidenceNote: row.attestation.evidenceNote,
    },
    acknowledgedAt: safeDate(row.acknowledgedAt),
    revokedAt: safeDate(row.revokedAt),
    createdAt: safeDate(row.createdAt),
  });
}

type FullDelegation = {
  id: string;
  projectId: string;
  mcpConnectionId: string;
  connectionOwnerId: string;
  connectionOwnerAccountAccessVersion: number | null;
  connectionConfigurationRevision: number;
  resolvedAddressFingerprint: string;
  credentialFingerprint: string;
  delegationFingerprint: string;
  expiresAt: Date;
  version: number;
  status: string;
  ownerProjectMembershipId: string;
  ownerMembershipCreatedAt: Date;
  projectConfirmedProjectMembershipId: string | null;
  projectConfirmedMembershipCreatedAt: Date | null;
  projectConfirmedById: string | null;
};

const delegationSelect = {
  id: true, projectId: true, mcpConnectionId: true, connectionOwnerId: true, connectionOwnerAccountAccessVersion: true,
  connectionConfigurationRevision: true, resolvedAddressFingerprint: true, credentialFingerprint: true,
  delegationFingerprint: true, expiresAt: true, version: true, status: true,
  ownerProjectMembershipId: true, ownerMembershipCreatedAt: true,
  projectConfirmedProjectMembershipId: true, projectConfirmedMembershipCreatedAt: true,
  projectConfirmedById: true,
} satisfies Prisma.ProjectMcpConnectionDelegationSelect;

type FullDefinition = {
  id: string;
  connectionId: string;
  name: string;
  definitionFingerprint: string;
  current: boolean;
  remoteReadOnlyHint: boolean;
  connection: {
    id: string;
    authKind: "none" | "bearer";
    credentialId: string | null;
    credentialFingerprint: string;
    configurationRevision: number;
    resolvedAddressFingerprint: string | null;
    status: "configured" | "verified" | "error" | "disabled";
    disabledAt: Date | null;
    ownerUserId: string | null;
    ownerAccountAccessVersion: number | null;
    ownershipState: "legacyPending" | "ambiguous" | "confirmed";
    credential: { kind: string; secretFingerprint: string } | null;
    ownerUser: { id: string; disabledAt: Date | null; accountAccessVersion: number } | null;
  };
};

const definitionSelect = {
  id: true, connectionId: true, name: true, definitionFingerprint: true, current: true, remoteReadOnlyHint: true,
  connection: {
    select: {
      id: true, authKind: true, credentialId: true, credentialFingerprint: true, configurationRevision: true,
      resolvedAddressFingerprint: true, status: true, disabledAt: true, ownerUserId: true, ownerAccountAccessVersion: true, ownershipState: true,
      credential: { select: { kind: true, secretFingerprint: true } },
      ownerUser: { select: { id: true, disabledAt: true, accountAccessVersion: true } },
    },
  },
} satisfies Prisma.McpToolDefinitionSelect;

const attestationSelect = {
  id: true, controlPlaneVersion: true, status: true, version: true, connectionId: true, toolDefinitionId: true,
  toolName: true, definitionFingerprint: true, networkFingerprint: true, credentialFingerprint: true,
  conclusion: true, riskLevel: true, evidenceNote: true, connectionConfigurationRevision: true,
  connectionOwnerAccountAccessVersion: true,
  note: true, evidence: true, verifiedById: true,
  verifiedBy: { select: { role: true, disabledAt: true } },
} satisfies Prisma.McpToolAttestationSelect;

type FullAttestation = Prisma.McpToolAttestationGetPayload<{ select: typeof attestationSelect }>;

function credentialFingerprint(connection: FullDefinition["connection"]): string | null {
  if (connection.authKind === "none") {
    return connection.credentialId === null && connection.credentialFingerprint === NO_CREDENTIAL_FINGERPRINT
      ? NO_CREDENTIAL_FINGERPRINT
      : null;
  }
  if (connection.authKind !== "bearer" || connection.credential?.kind !== "mcp" || connection.credential.secretFingerprint !== connection.credentialFingerprint) return null;
  return connection.credentialFingerprint;
}

async function validateCreateTuple(
  tx: Tx,
  projectId: string,
  parsed: z.infer<typeof createSchema>,
): Promise<{ delegation: FullDelegation; definition: FullDefinition; attestation: FullAttestation; networkFingerprint: string; credentialFingerprint: string }> {
  const [delegation, definition, attestation] = await Promise.all([
    tx.projectMcpConnectionDelegation.findUnique({ where: { id: parsed.delegationId }, select: delegationSelect }),
    tx.mcpToolDefinition.findUnique({ where: { id: parsed.toolDefinitionId }, select: definitionSelect }),
    tx.mcpToolAttestation.findUnique({ where: { id: parsed.attestationId }, select: attestationSelect }),
  ]);
  if (delegation === null || definition === null || attestation === null) return fail("PROJECT_MCP_TOOL_GRANT_STALE");
  const now = await tx.$queryRaw<Array<{ now: Date }>>(Prisma.sql`SELECT (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) AS now`);
  const databaseNow = now[0]?.now ?? new Date();
  const currentCredentialFingerprint = credentialFingerprint(definition.connection);
  const ownerEpoch = delegation.ownerProjectMembershipId === "" ? null : await tx.projectMembership.findUnique({ where: { id: delegation.ownerProjectMembershipId }, select: { projectId: true, userId: true, role: true, accessState: true, createdAt: true, user: { select: { disabledAt: true, accountAccessVersion: true } } } });
  const confirmerEpoch = delegation.projectConfirmedProjectMembershipId === null ? null : await tx.projectMembership.findUnique({ where: { id: delegation.projectConfirmedProjectMembershipId }, select: { projectId: true, userId: true, role: true, accessState: true, createdAt: true, user: { select: { disabledAt: true } } } });
  const valid = delegation.projectId === projectId
    && delegation.status === "active"
    && delegation.version === parsed.expectedDelegationVersion
    && delegation.expiresAt > databaseNow
    && ownerEpoch !== null
    && ownerEpoch.projectId === projectId
    && ownerEpoch.userId === delegation.connectionOwnerId
    && (ownerEpoch.role === "owner" || ownerEpoch.role === "editor")
    && ownerEpoch.accessState === "confirmed"
    && ownerEpoch.createdAt.getTime() === delegation.ownerMembershipCreatedAt.getTime()
    && ownerEpoch.user.disabledAt === null
    && delegation.connectionOwnerAccountAccessVersion !== null
    && ownerEpoch.user.accountAccessVersion === delegation.connectionOwnerAccountAccessVersion
    && delegation.projectConfirmedProjectMembershipId !== null
    && delegation.projectConfirmedMembershipCreatedAt !== null
    && delegation.projectConfirmedById !== null
    && confirmerEpoch !== null
    && confirmerEpoch.projectId === projectId
    && confirmerEpoch.userId === delegation.projectConfirmedById
    && confirmerEpoch.role === "owner"
    && confirmerEpoch.accessState === "confirmed"
    && confirmerEpoch.createdAt.getTime() === delegation.projectConfirmedMembershipCreatedAt.getTime()
    && confirmerEpoch.user.disabledAt === null
    && definition.id === parsed.toolDefinitionId
    && definition.connectionId === delegation.mcpConnectionId
    && definition.current
    && definition.remoteReadOnlyHint
    && definition.connection.ownerUserId === delegation.connectionOwnerId
    && definition.connection.ownerAccountAccessVersion === delegation.connectionOwnerAccountAccessVersion
    && definition.connection.ownerUser !== null
    && definition.connection.ownerUser.disabledAt === null
    && definition.connection.ownerUser.accountAccessVersion === delegation.connectionOwnerAccountAccessVersion
    && definition.connection.ownershipState === "confirmed"
    && definition.connection.status === "verified"
    && definition.connection.disabledAt === null
    && definition.connection.configurationRevision === delegation.connectionConfigurationRevision
    && definition.connection.resolvedAddressFingerprint === delegation.resolvedAddressFingerprint
    && definition.connection.credentialFingerprint === delegation.credentialFingerprint
    && currentCredentialFingerprint !== null
    && attestation.controlPlaneVersion === 2
    && attestation.status === "active"
    && attestation.version === parsed.expectedAttestationVersion
    && attestation.connectionId === definition.connectionId
    && attestation.toolDefinitionId === definition.id
    && attestation.toolName === definition.name
    && attestation.definitionFingerprint === definition.definitionFingerprint
    && attestation.networkFingerprint === delegation.resolvedAddressFingerprint
    && attestation.credentialFingerprint === currentCredentialFingerprint
    && attestation.connectionOwnerAccountAccessVersion === delegation.connectionOwnerAccountAccessVersion
    && attestation.connectionConfigurationRevision === definition.connection.configurationRevision
    && attestation.conclusion === "read_only_verified"
    && (attestation.riskLevel === "low" || attestation.riskLevel === "medium" || attestation.riskLevel === "high")
    && attestation.evidenceNote === "manual_read_only_review"
    && attestation.note === null
    && JSON.stringify(attestation.evidence) === "{}"
    && attestation.verifiedBy.role === "admin"
    && attestation.verifiedBy.disabledAt === null;
  if (!valid) return fail("PROJECT_MCP_TOOL_GRANT_STALE");
  if (!(await hasApprovedMcpToolReview(tx, attestation))) return fail("PROJECT_MCP_TOOL_GRANT_STALE");
  return { delegation, definition, attestation, networkFingerprint: delegation.resolvedAddressFingerprint, credentialFingerprint: currentCredentialFingerprint };
}

function isSameTuple(existing: { controlPlaneVersion: number | null; grantVersion: number | null; status: string; managedById: string; delegationId: string | null; toolDefinitionId: string; attestationId: string | null; delegationVersion: number | null; grantorProjectMembershipId: string | null; grantorMembershipCreatedAt: Date | null; connectionConfigurationRevision: number | null; definitionFingerprint: string | null; networkFingerprint: string | null; credentialFingerprint: string | null; delegationFingerprint: string | null; connectionOwnerAccountAccessVersion: number | null }, tuple: { delegationId: string; toolDefinitionId: string; attestationId: string; delegationVersion: number; grantorProjectMembershipId: string; grantorMembershipCreatedAt: Date; connectionConfigurationRevision: number; definitionFingerprint: string; networkFingerprint: string; credentialFingerprint: string; delegationFingerprint: string; connectionOwnerAccountAccessVersion: number }, actorMembership: ProjectOwnerEpoch, actorId: string): boolean {
  return existing.controlPlaneVersion === 2
    && existing.grantVersion === 1
    && existing.status === "active"
    && existing.managedById === actorId
    && existing.delegationId === tuple.delegationId
    && existing.toolDefinitionId === tuple.toolDefinitionId
    && existing.attestationId === tuple.attestationId
    && existing.delegationVersion === tuple.delegationVersion
    && existing.grantorProjectMembershipId === actorMembership.id
    && existing.grantorMembershipCreatedAt?.getTime() === actorMembership.createdAt.getTime()
    && existing.connectionConfigurationRevision === tuple.connectionConfigurationRevision
    && existing.definitionFingerprint === tuple.definitionFingerprint
    && existing.networkFingerprint === tuple.networkFingerprint
    && existing.credentialFingerprint === tuple.credentialFingerprint
    && existing.delegationFingerprint === tuple.delegationFingerprint
    && existing.connectionOwnerAccountAccessVersion === tuple.connectionOwnerAccountAccessVersion;
}

async function loadProjectedGrant(tx: Tx, id: string): Promise<GrantProjectionRow> {
  return tx.projectMcpToolGrant.findUniqueOrThrow({ where: { id }, select: grantProjectionSelect }) as unknown as Promise<GrantProjectionRow>;
}

const grantAdmissionDelegationSelect = {
  id: true,
  projectId: true,
  mcpConnectionId: true,
  connectionOwnerId: true,
  connectionOwnerAccountAccessVersion: true,
  connectionConfigurationRevision: true,
  resolvedAddressFingerprint: true,
  credentialFingerprint: true,
  expiresAt: true,
  status: true,
  ownerProjectMembershipId: true,
  ownerMembershipCreatedAt: true,
  projectConfirmedProjectMembershipId: true,
  projectConfirmedMembershipCreatedAt: true,
  projectConfirmedById: true,
  project: { select: { id: true, archivedAt: true } },
  mcpConnection: {
    select: {
      id: true,
      authKind: true,
      credentialId: true,
      credentialFingerprint: true,
      configurationRevision: true,
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
  ownerProjectMembership: {
    select: {
      projectId: true,
      userId: true,
      role: true,
      accessState: true,
      createdAt: true,
      user: { select: { disabledAt: true, accountAccessVersion: true } },
    },
  },
  projectConfirmedProjectMembership: {
    select: {
      projectId: true,
      userId: true,
      role: true,
      accessState: true,
      createdAt: true,
      user: { select: { disabledAt: true } },
    },
  },
} satisfies Prisma.ProjectMcpConnectionDelegationSelect;

function currentDelegationCredentialFingerprint(delegation: Prisma.ProjectMcpConnectionDelegationGetPayload<{ select: typeof grantAdmissionDelegationSelect }>): string | null {
  const connection = delegation.mcpConnection;
  if (connection.authKind === "none") {
    return connection.credentialId === null && connection.credentialFingerprint === NO_CREDENTIAL_FINGERPRINT
      ? NO_CREDENTIAL_FINGERPRINT
      : null;
  }
  if (connection.authKind !== "bearer" || connection.credential?.kind !== "mcp" || connection.credential.secretFingerprint !== connection.credentialFingerprint) return null;
  return connection.credentialFingerprint;
}

async function assessGrantAdmission(tx: Tx, row: GrantProjectionRow, projectArchivedAt: Date | null = null): Promise<GrantAdmission> {
  if (row.status !== "active") return { effective: false, effectiveReason: "grant_revoked" };
  if (projectArchivedAt !== null) return { effective: false, effectiveReason: "project_archived" };
  if (row.delegationId === null) return { effective: false, effectiveReason: "delegation_missing" };
  const delegation = await tx.projectMcpConnectionDelegation.findUnique({ where: { id: row.delegationId }, select: grantAdmissionDelegationSelect });
  if (delegation === null || delegation.projectId !== row.projectId) return { effective: false, effectiveReason: "delegation_missing" };
  const nowRows = await tx.$queryRaw<Array<{ now: Date }>>(Prisma.sql`SELECT (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) AS now`);
  const now = nowRows[0]?.now ?? new Date();
  if (delegation.status !== "active") return { effective: false, effectiveReason: "delegation_not_active" };
  if (delegation.expiresAt <= now) return { effective: false, effectiveReason: "delegation_expired" };
  if (delegation.project.archivedAt !== null) return { effective: false, effectiveReason: "project_archived" };
  const connection = delegation.mcpConnection;
  const expectedCredential = currentDelegationCredentialFingerprint(delegation);
  const connectionCurrent = connection.id === delegation.mcpConnectionId
    && connection.ownerUserId === delegation.connectionOwnerId
    && connection.ownerAccountAccessVersion === delegation.connectionOwnerAccountAccessVersion
    && connection.ownerUser !== null
    && connection.ownerUser.id === delegation.connectionOwnerId
    && connection.ownerUser.disabledAt === null
    && connection.ownerUser.accountAccessVersion === delegation.connectionOwnerAccountAccessVersion
    && connection.ownershipState === "confirmed"
    && connection.status === "verified"
    && connection.disabledAt === null
    && connection.configurationRevision === delegation.connectionConfigurationRevision
    && connection.resolvedAddressFingerprint === delegation.resolvedAddressFingerprint
    && expectedCredential !== null
    && connection.credentialFingerprint === delegation.credentialFingerprint;
  if (!connectionCurrent) return { effective: false, effectiveReason: "connection_evidence_drift" };
  const ownerMembership = delegation.ownerProjectMembership;
  const ownerMembershipCurrent = ownerMembership !== null
    && ownerMembership.projectId === delegation.projectId
    && ownerMembership.userId === delegation.connectionOwnerId
    && (ownerMembership.role === "owner" || ownerMembership.role === "editor")
    && ownerMembership.accessState === "confirmed"
    && ownerMembership.createdAt.getTime() === delegation.ownerMembershipCreatedAt.getTime()
    && ownerMembership.user.disabledAt === null
    && delegation.connectionOwnerAccountAccessVersion !== null
    && ownerMembership.user.accountAccessVersion === delegation.connectionOwnerAccountAccessVersion;
  if (!ownerMembershipCurrent) return { effective: false, effectiveReason: "owner_membership_drift" };
  const projectMembership = delegation.projectConfirmedProjectMembership;
  const projectMembershipCurrent = delegation.projectConfirmedById !== null
    && projectMembership !== null
    && projectMembership.projectId === delegation.projectId
    && projectMembership.userId === delegation.projectConfirmedById
    && projectMembership.role === "owner"
    && projectMembership.accessState === "confirmed"
    && projectMembership.createdAt.getTime() === delegation.projectConfirmedMembershipCreatedAt?.getTime()
    && projectMembership.user.disabledAt === null;
  if (!projectMembershipCurrent) return { effective: false, effectiveReason: "project_owner_membership_drift" };
  if (row.toolDefinition.current !== true || row.toolDefinition.remoteReadOnlyHint !== true || row.toolDefinition.definitionFingerprint !== row.attestation?.definitionFingerprint) return { effective: false, effectiveReason: "definition_drift" };
  if (row.controlPlaneVersion !== 2 || row.attestation === null) return { effective: false, effectiveReason: "attestation_missing" };
  if (row.attestation.status !== "active"
    || row.attestation.version !== 1
    || row.attestation.conclusion !== "read_only_verified"
    || !["low", "medium", "high"].includes(row.attestation.riskLevel ?? "")
    || row.attestation.evidenceNote !== "manual_read_only_review") return { effective: false, effectiveReason: "attestation_invalid" };
  if (row.attestation.connectionId !== delegation.mcpConnectionId
    || row.attestation.toolDefinitionId !== row.toolDefinitionId
    || row.attestation.toolName !== row.toolName
    || row.attestation.networkFingerprint !== connection.resolvedAddressFingerprint
    || row.attestation.credentialFingerprint !== expectedCredential
    || row.attestation.connectionConfigurationRevision !== connection.configurationRevision
    || row.attestation.connectionOwnerAccountAccessVersion !== delegation.connectionOwnerAccountAccessVersion) return { effective: false, effectiveReason: "attestation_drift" };
  if (!(await hasApprovedMcpToolReview(tx, row.attestation))) return { effective: false, effectiveReason: "review_required" };
  return { effective: true, effectiveReason: null };
}

export async function listProjectMcpToolGrantsV2(projectIdInput: unknown, actor: Actor, db: PrismaClient = getDb()) {
  const projectId = parseUuid(projectIdInput);
  const actorId = parseActor(actor);
  return withSerializableRetry(db, async (tx) => {
    await lockAdmission(tx, projectId, [actorId]);
    const { project } = await requireActorAndProject(tx, projectId, actorId, true, actor.accountAccessVersion);
    const rows = await tx.projectMcpToolGrant.findMany({ where: { projectId, controlPlaneVersion: 2 }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: grantProjectionSelect });
    const projectedRows = await Promise.all(rows.map(async (row) => ({
      row: row as unknown as GrantProjectionRow,
      admission: await assessGrantAdmission(tx, row as unknown as GrantProjectionRow, project.archivedAt),
    })));
    if (project.archivedAt !== null) {
      return Object.freeze({ projectId, archived: true, grants: projectedRows.map(({ row, admission }) => projectGrant(row, admission)), candidates: [] });
    }
    // Only a grant backed by an immutable APPROVED review occupies a usable
    // V2 slot. Legacy grants remain a compatibility blocker; an upgraded V2
    // row without review is shown as ineffective and never as an active slot.
    const activeSlots = await tx.projectMcpToolGrant.findMany({ where: { projectId, status: "active" }, select: { connectionId: true, toolName: true } });
    const effectiveGrantSlotKeys = new Set(projectedRows
      .filter(({ admission }) => admission.effective)
      .map(({ row }) => `${row.connectionId}:${row.toolName}`));
    const projectedV2SlotKeys = new Set(projectedRows.map(({ row }) => `${row.connectionId}:${row.toolName}`));
    const activeSlotKeys = new Set(activeSlots
      .filter((row) => !projectedV2SlotKeys.has(`${row.connectionId}:${row.toolName}`)
        || effectiveGrantSlotKeys.has(`${row.connectionId}:${row.toolName}`))
      .map((row) => `${row.connectionId}:${row.toolName}`));
    const nowRows = await tx.$queryRaw<Array<{ now: Date }>>(Prisma.sql`SELECT (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) AS now`);
    const now = nowRows[0]?.now ?? new Date();
    const delegations = await tx.projectMcpConnectionDelegation.findMany({
      where: { projectId, status: "active", expiresAt: { gt: now } },
      select: { id: true, mcpConnectionId: true, connectionOwnerId: true, connectionOwnerAccountAccessVersion: true, version: true, expiresAt: true, connectionConfigurationRevision: true, resolvedAddressFingerprint: true, credentialFingerprint: true, ownerProjectMembershipId: true, ownerMembershipCreatedAt: true, projectConfirmedProjectMembershipId: true, projectConfirmedMembershipCreatedAt: true, projectConfirmedById: true },
    });
    const candidates: Array<Readonly<Record<string, unknown>>> = [];
    const definitions = await tx.mcpToolDefinition.findMany({
      where: { current: true, remoteReadOnlyHint: true, connectionId: { in: delegations.map((row) => row.mcpConnectionId) } },
      orderBy: [{ connectionId: "asc" }, { name: "asc" }, { id: "asc" }],
      select: {
        id: true, connectionId: true, name: true, title: true, description: true, inputSchema: true, outputSchema: true, annotations: true,
        definitionFingerprint: true,
        connection: { select: { id: true, authKind: true, credentialId: true, credentialFingerprint: true, configurationRevision: true, resolvedAddressFingerprint: true, status: true, disabledAt: true, ownerUserId: true, ownerAccountAccessVersion: true, ownershipState: true, credential: { select: { kind: true, secretFingerprint: true } }, ownerUser: { select: { id: true, disabledAt: true, accountAccessVersion: true } } } },
      },
    });
    for (const definition of definitions) {
      if (activeSlotKeys.has(`${definition.connectionId}:${definition.name}`)) continue;
      const delegation = delegations.find((row) => row.mcpConnectionId === definition.connectionId);
      if (delegation === undefined || delegation.projectConfirmedProjectMembershipId === null || delegation.projectConfirmedMembershipCreatedAt === null || delegation.projectConfirmedById === null) continue;
      const ownerEpoch = await tx.projectMembership.findUnique({ where: { id: delegation.ownerProjectMembershipId }, select: { projectId: true, userId: true, role: true, accessState: true, createdAt: true, user: { select: { disabledAt: true, accountAccessVersion: true } } } });
      if (ownerEpoch === null || ownerEpoch.projectId !== projectId || ownerEpoch.userId !== delegation.connectionOwnerId || (ownerEpoch.role !== "owner" && ownerEpoch.role !== "editor") || ownerEpoch.accessState !== "confirmed" || ownerEpoch.createdAt.getTime() !== delegation.ownerMembershipCreatedAt.getTime() || ownerEpoch.user.disabledAt !== null) continue;
      if (delegation.connectionOwnerAccountAccessVersion === null || ownerEpoch.user.accountAccessVersion !== delegation.connectionOwnerAccountAccessVersion) continue;
      const confirmer = await tx.projectMembership.findUnique({ where: { id: delegation.projectConfirmedProjectMembershipId }, select: { projectId: true, userId: true, role: true, accessState: true, createdAt: true, user: { select: { disabledAt: true } } } });
      if (confirmer === null || confirmer.projectId !== projectId || confirmer.userId !== delegation.projectConfirmedById || confirmer.role !== "owner" || confirmer.accessState !== "confirmed" || confirmer.createdAt.getTime() !== delegation.projectConfirmedMembershipCreatedAt.getTime() || confirmer.user.disabledAt !== null) continue;
      const connection = definition.connection;
      const expectedCredential = connection.authKind === "none"
        ? connection.credentialId === null && connection.credentialFingerprint === NO_CREDENTIAL_FINGERPRINT ? NO_CREDENTIAL_FINGERPRINT : null
        : connection.authKind === "bearer" && connection.credential?.kind === "mcp" && connection.credential.secretFingerprint === connection.credentialFingerprint ? connection.credentialFingerprint : null;
      if (connection.status !== "verified" || connection.disabledAt !== null || connection.ownerUserId !== delegation.connectionOwnerId || connection.ownerAccountAccessVersion !== delegation.connectionOwnerAccountAccessVersion || connection.ownerUser === null || connection.ownerUser.disabledAt !== null || connection.ownerUser.accountAccessVersion !== delegation.connectionOwnerAccountAccessVersion || connection.ownershipState !== "confirmed" || connection.resolvedAddressFingerprint === null || expectedCredential === null) continue;
      if (connection.configurationRevision !== delegation.connectionConfigurationRevision || connection.resolvedAddressFingerprint !== delegation.resolvedAddressFingerprint || expectedCredential !== delegation.credentialFingerprint) continue;
      const attestation = await tx.mcpToolAttestation.findFirst({ where: { controlPlaneVersion: 2, status: "active", version: 1, connectionId: definition.connectionId, toolDefinitionId: definition.id, toolName: definition.name, definitionFingerprint: definition.definitionFingerprint, networkFingerprint: connection.resolvedAddressFingerprint, credentialFingerprint: expectedCredential, connectionConfigurationRevision: connection.configurationRevision, connectionOwnerAccountAccessVersion: delegation.connectionOwnerAccountAccessVersion, audits: { none: { event: "revoked" } } }, select: { id: true, connectionId: true, toolDefinitionId: true, toolName: true, definitionFingerprint: true, networkFingerprint: true, credentialFingerprint: true, connectionConfigurationRevision: true, connectionOwnerAccountAccessVersion: true, conclusion: true, riskLevel: true, evidenceNote: true, note: true, evidence: true, verifiedBy: { select: { role: true, disabledAt: true } } } });
      if (attestation === null) continue;
      const reviewed = await hasApprovedMcpToolReview(tx, attestation);
      const effective = reviewed && attestation.conclusion === "read_only_verified"
        && ["low", "medium", "high"].includes(attestation.riskLevel ?? "")
        && attestation.evidenceNote === "manual_read_only_review"
        && attestation.note === null
        && JSON.stringify(attestation.evidence) === "{}"
        && attestation.verifiedBy.role === "admin"
        && attestation.verifiedBy.disabledAt === null;
      const effectiveReason = reviewed ? (effective ? null : "attestation_not_effective") : "review_required";
      candidates.push(Object.freeze({
        delegationId: delegation.id,
        toolDefinitionId: definition.id,
        attestationId: attestation.id,
        delegationVersion: delegation.version,
        expiresAt: safeDate(delegation.expiresAt),
        status: "eligible",
        effective,
        ...(effective ? {} : { blockingAttestationId: attestation.id, requiresRevocation: true, effectiveReason }),
        tool: { id: definition.id, name: safeText(definition.name), title: safeText(definition.title), description: safeText(definition.description), inputSchema: sanitizeMcpAttestationJson(definition.inputSchema), outputSchema: sanitizeMcpAttestationJson(definition.outputSchema), annotations: sanitizeMcpAttestationJson(definition.annotations), remoteTextTrust: "untrusted" },
      }));
    }
    return Object.freeze({ projectId, archived: project.archivedAt !== null, grants: projectedRows.map(({ row, admission }) => projectGrant(row, admission)), candidates });
  });
}

export async function createProjectMcpToolGrantV2(projectIdInput: unknown, input: unknown, actor: Actor, db: PrismaClient = getDb()) {
  const projectId = parseUuid(projectIdInput);
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return fail("PROJECT_MCP_TOOL_GRANT_INVALID_INPUT");
  const actorId = parseActor(actor);
  const preflight = await withSerializableRetry(db, async (tx): Promise<CreateGrantPreflight> => {
    // The first transaction deliberately knows only the target project and
    // acting user. No caller-supplied delegation, definition, or attestation
    // identifier is read or locked until direct Owner admission succeeds.
    await lockAdmission(tx, projectId, [actorId]);
    await requireActorAndProject(tx, projectId, actorId, false, actor.accountAccessVersion);

    const delegation = await tx.projectMcpConnectionDelegation.findFirst({
      where: { id: parsed.data.delegationId, projectId, status: "active" },
      select: { id: true, mcpConnectionId: true, connectionOwnerId: true, connectionOwnerAccountAccessVersion: true, projectConfirmedById: true },
    });
    if (delegation === null || delegation.projectConfirmedById === null || delegation.connectionOwnerAccountAccessVersion === null) return fail("PROJECT_MCP_TOOL_GRANT_STALE");
    const definition = await tx.mcpToolDefinition.findFirst({
      where: { id: parsed.data.toolDefinitionId, connectionId: delegation.mcpConnectionId },
      select: { id: true, connectionId: true, name: true },
    });
    if (definition === null) return fail("PROJECT_MCP_TOOL_GRANT_STALE");
    const attestation = await tx.mcpToolAttestation.findFirst({
      where: {
        id: parsed.data.attestationId,
        controlPlaneVersion: 2,
        status: "active",
        version: parsed.data.expectedAttestationVersion,
        connectionId: delegation.mcpConnectionId,
        toolDefinitionId: definition.id,
        toolName: definition.name,
      },
      select: { id: true, verifiedById: true },
    });
    if (attestation === null) return fail("PROJECT_MCP_TOOL_GRANT_STALE");
    return {
      delegationId: delegation.id,
      toolDefinitionId: definition.id,
      attestationId: attestation.id,
      connectionId: delegation.mcpConnectionId,
      toolName: definition.name,
      connectionOwnerId: delegation.connectionOwnerId,
      connectionOwnerAccountAccessVersion: delegation.connectionOwnerAccountAccessVersion,
      projectConfirmedById: delegation.projectConfirmedById,
      attestationVerifierId: attestation.verifiedById,
    };
  });

  return withSerializableRetry(db, async (tx) => {
    await lockAdmission(
      tx,
      projectId,
      [actorId, preflight.connectionOwnerId, preflight.projectConfirmedById, preflight.attestationVerifierId],
      preflight.connectionId,
      preflight.toolDefinitionId,
      `${projectId}:${preflight.connectionId}:${preflight.toolName}`,
    );
    const { membership } = await requireActorAndProject(tx, projectId, actorId, false, actor.accountAccessVersion);
    const liveSeed = await tx.projectMcpConnectionDelegation.findFirst({
      where: { id: preflight.delegationId, projectId, status: "active" },
      select: { id: true, mcpConnectionId: true, connectionOwnerId: true, connectionOwnerAccountAccessVersion: true, projectConfirmedById: true },
    });
    const liveDefinition = liveSeed === null ? null : await tx.mcpToolDefinition.findFirst({
      where: { id: preflight.toolDefinitionId, connectionId: liveSeed.mcpConnectionId },
      select: { id: true, connectionId: true, name: true },
    });
    const liveAttestation = liveSeed === null || liveDefinition === null ? null : await tx.mcpToolAttestation.findFirst({
      where: {
        id: preflight.attestationId,
        controlPlaneVersion: 2,
        status: "active",
        version: parsed.data.expectedAttestationVersion,
        connectionId: liveSeed.mcpConnectionId,
        toolDefinitionId: liveDefinition.id,
        toolName: liveDefinition.name,
      },
      select: { id: true, verifiedById: true },
    });
    if (
      liveSeed === null
      || liveSeed.mcpConnectionId !== preflight.connectionId
      || liveSeed.connectionOwnerId !== preflight.connectionOwnerId
      || liveSeed.connectionOwnerAccountAccessVersion !== preflight.connectionOwnerAccountAccessVersion
      || liveSeed.projectConfirmedById !== preflight.projectConfirmedById
      || liveDefinition === null
      || liveDefinition.connectionId !== preflight.connectionId
      || liveDefinition.name !== preflight.toolName
      || liveAttestation === null
      || liveAttestation.verifiedById !== preflight.attestationVerifierId
    ) return fail("PROJECT_MCP_TOOL_GRANT_STALE");
    const tuple = await validateCreateTuple(tx, projectId, parsed.data);
    const existing = await tx.projectMcpToolGrant.findFirst({ where: { projectId, connectionId: tuple.definition.connectionId, toolName: tuple.definition.name, status: "active" }, select: { id: true, controlPlaneVersion: true, grantVersion: true, status: true, managedById: true, delegationId: true, toolDefinitionId: true, attestationId: true, delegationVersion: true, grantorProjectMembershipId: true, grantorMembershipCreatedAt: true, connectionConfigurationRevision: true, definitionFingerprint: true, networkFingerprint: true, credentialFingerprint: true, delegationFingerprint: true, connectionOwnerAccountAccessVersion: true } });
    const expected = { delegationId: tuple.delegation.id, toolDefinitionId: tuple.definition.id, attestationId: tuple.attestation.id, delegationVersion: tuple.delegation.version, grantorProjectMembershipId: membership.id, grantorMembershipCreatedAt: membership.createdAt, connectionConfigurationRevision: tuple.definition.connection.configurationRevision, definitionFingerprint: tuple.definition.definitionFingerprint, networkFingerprint: tuple.networkFingerprint, credentialFingerprint: tuple.credentialFingerprint, delegationFingerprint: tuple.delegation.delegationFingerprint, connectionOwnerAccountAccessVersion: tuple.delegation.connectionOwnerAccountAccessVersion! };
    if (existing !== null) {
      if (!isSameTuple(existing, expected, membership, actorId)) return fail("PROJECT_MCP_TOOL_GRANT_CONFLICT");
      const projected = await loadProjectedGrant(tx, existing.id);
      return { created: false, grant: projectGrant(projected, await assessGrantAdmission(tx, projected)) };
    }
    const grantId = randomUUID();
    const grant = await tx.projectMcpToolGrant.create({ data: {
      id: grantId, projectId, connectionId: tuple.definition.connectionId, delegationId: tuple.delegation.id, controlPlaneVersion: 2, grantVersion: 1,
      toolName: tuple.definition.name, toolDefinitionId: tuple.definition.id, attestationId: tuple.attestation.id,
      definitionFingerprint: tuple.definition.definitionFingerprint, networkFingerprint: tuple.networkFingerprint, credentialFingerprint: tuple.credentialFingerprint,
      connectionOwnerAccountAccessVersion: tuple.delegation.connectionOwnerAccountAccessVersion,
      delegationVersion: tuple.delegation.version, delegationFingerprint: tuple.delegation.delegationFingerprint, connectionConfigurationRevision: tuple.definition.connection.configurationRevision,
      grantorProjectMembershipId: membership.id, grantorMembershipCreatedAt: membership.createdAt, status: "active", managedById: actorId,
      acknowledgedAt: new Date(0), creationTransactionId: BigInt(0),
    } });
    await tx.projectMcpToolGrantAudit.create({ data: {
      id: randomUUID(), projectId, grantId: grant.id, event: "granted", actorId, controlPlaneVersion: 2, grantVersion: 1,
      statusBefore: null, statusAfter: "active", delegationVersion: tuple.delegation.version, delegationFingerprint: tuple.delegation.delegationFingerprint,
      connectionConfigurationRevision: tuple.definition.connection.configurationRevision, grantorProjectMembershipId: membership.id,
      grantorMembershipCreatedAt: membership.createdAt, revokerProjectMembershipId: null, revokerMembershipCreatedAt: null,
      definitionFingerprint: tuple.definition.definitionFingerprint, connectionOwnerAccountAccessVersion: tuple.delegation.connectionOwnerAccountAccessVersion, details: {},
    } });
    await tx.projectMcpToolGrantLedger.create({ data: {
      id: randomUUID(), projectId, grantId: grant.id, connectionId: tuple.definition.connectionId, delegationId: tuple.delegation.id,
      toolDefinitionId: tuple.definition.id, attestationId: tuple.attestation.id, toolName: tuple.definition.name, controlPlaneVersion: 2,
      grantVersion: 1, event: "granted", statusBefore: null, statusAfter: "active", actorId, actorProjectMembershipId: membership.id,
      actorMembershipCreatedAt: membership.createdAt, delegationVersion: tuple.delegation.version, delegationFingerprint: tuple.delegation.delegationFingerprint,
      connectionConfigurationRevision: tuple.definition.connection.configurationRevision, grantorProjectMembershipId: membership.id,
      grantorMembershipCreatedAt: membership.createdAt, revokerProjectMembershipId: null, revokerMembershipCreatedAt: null,
      definitionFingerprint: tuple.definition.definitionFingerprint, networkFingerprint: tuple.networkFingerprint, credentialFingerprint: tuple.credentialFingerprint,
      connectionOwnerId: tuple.delegation.connectionOwnerId, connectionOwnerAccountAccessVersion: tuple.delegation.connectionOwnerAccountAccessVersion,
      acknowledgedAt: grant.acknowledgedAt, transactionId: BigInt(0), transitionAt: new Date(0), createdAt: new Date(0),
    } });
    const projected = await loadProjectedGrant(tx, grant.id);
    return { created: true, grant: projectGrant(projected, await assessGrantAdmission(tx, projected)) };
  });
}

export async function revokeProjectMcpToolGrantV2(projectIdInput: unknown, grantIdInput: unknown, input: unknown, actor: Actor, db: PrismaClient = getDb()) {
  const projectId = parseUuid(projectIdInput);
  const grantId = parseUuid(grantIdInput);
  const parsed = revokeSchema.safeParse(input);
  if (!parsed.success) return fail("PROJECT_MCP_TOOL_GRANT_INVALID_INPUT");
  const actorId = parseActor(actor);
  return withSerializableRetry(db, async (tx) => {
    // Admit the actor against the target project before touching any grant
    // keyed by the caller-supplied id. This keeps guessed ids and ids from a
    // different project on the same forbidden/not-found boundary without
    // locking or reading the other project's grant row.
    await lockAdmission(tx, projectId, [actorId]);
    await requireActorAndProject(tx, projectId, actorId, true, actor.accountAccessVersion);

    const scopedSeed = await tx.projectMcpToolGrant.findFirst({
      where: { id: grantId, projectId, controlPlaneVersion: 2 },
      select: { id: true, connectionId: true, toolDefinitionId: true },
    });
    if (scopedSeed === null) return fail("PROJECT_MCP_TOOL_GRANT_NOT_FOUND");

    // Only after target-project admission do we acquire the resource locks,
    // in the shared order connection -> definition tuple -> grant row.
    await lockAdmission(tx, projectId, [actorId], scopedSeed.connectionId, scopedSeed.toolDefinitionId, undefined, scopedSeed.id);
    const { membership } = await requireActorAndProject(tx, projectId, actorId, true, actor.accountAccessVersion);
    const existing = await tx.projectMcpToolGrant.findFirst({ where: { id: scopedSeed.id, projectId, controlPlaneVersion: 2 }, select: { id: true, controlPlaneVersion: true, status: true, grantVersion: true, revokedById: true, revokerProjectMembershipId: true, revokerMembershipCreatedAt: true } });
    if (existing === null) return fail("PROJECT_MCP_TOOL_GRANT_NOT_FOUND");
    if (existing.status === "revoked" && existing.grantVersion === 2 && parsed.data.expectedGrantVersion === 1 && existing.revokedById === actorId && existing.revokerProjectMembershipId === membership.id && existing.revokerMembershipCreatedAt?.getTime() === membership.createdAt.getTime()) {
      const projected = await loadProjectedGrant(tx, grantId);
      return { created: false, grant: projectGrant(projected, await assessGrantAdmission(tx, projected)) };
    }
    if (existing.status !== "active" || existing.grantVersion !== parsed.data.expectedGrantVersion) return fail("PROJECT_MCP_TOOL_GRANT_CONFLICT");
    const cas = await tx.projectMcpToolGrant.updateMany({ where: { id: grantId, projectId, controlPlaneVersion: 2, status: "active", grantVersion: parsed.data.expectedGrantVersion }, data: { status: "revoked", grantVersion: 2, revokedById: actorId, revokerProjectMembershipId: membership.id, revokerMembershipCreatedAt: membership.createdAt } });
    if (cas.count !== 1) return fail("PROJECT_MCP_TOOL_GRANT_CONFLICT");
    const current = await tx.projectMcpToolGrant.findFirstOrThrow({ where: { id: scopedSeed.id, projectId, controlPlaneVersion: 2 }, select: {
      projectId: true, connectionId: true, delegationId: true, toolDefinitionId: true, attestationId: true, toolName: true,
      controlPlaneVersion: true, grantVersion: true, definitionFingerprint: true, networkFingerprint: true, credentialFingerprint: true,
      connectionOwnerAccountAccessVersion: true, delegationVersion: true, delegationFingerprint: true, connectionConfigurationRevision: true, grantorProjectMembershipId: true,
      grantorMembershipCreatedAt: true, managedById: true, status: true, revokedById: true, revokerProjectMembershipId: true, revokerMembershipCreatedAt: true,
      acknowledgedAt: true,
      delegation: { select: { connectionOwnerId: true } },
    } });
    if (current.delegationId === null || current.delegation === null || current.attestationId === null || current.definitionFingerprint === null || current.networkFingerprint === null || current.credentialFingerprint === null || current.delegationVersion === null || current.delegationFingerprint === null || current.connectionConfigurationRevision === null || current.grantorProjectMembershipId === null || current.grantorMembershipCreatedAt === null || current.revokerProjectMembershipId === null || current.revokerMembershipCreatedAt === null) return fail("PROJECT_MCP_TOOL_GRANT_CONFLICT");
    await tx.projectMcpToolGrantAudit.create({ data: {
      id: randomUUID(), projectId, grantId, event: "revoked", actorId, controlPlaneVersion: 2, grantVersion: 2, statusBefore: "active", statusAfter: "revoked",
      delegationVersion: current.delegationVersion, delegationFingerprint: current.delegationFingerprint, connectionConfigurationRevision: current.connectionConfigurationRevision,
      grantorProjectMembershipId: current.grantorProjectMembershipId, grantorMembershipCreatedAt: current.grantorMembershipCreatedAt,
      revokerProjectMembershipId: current.revokerProjectMembershipId, revokerMembershipCreatedAt: current.revokerMembershipCreatedAt,
      definitionFingerprint: current.definitionFingerprint, connectionOwnerAccountAccessVersion: current.connectionOwnerAccountAccessVersion, details: {},
    } });
    await tx.projectMcpToolGrantLedger.create({ data: {
      id: randomUUID(), projectId, grantId, connectionId: current.connectionId, delegationId: current.delegationId, toolDefinitionId: current.toolDefinitionId,
      attestationId: current.attestationId, toolName: current.toolName, controlPlaneVersion: 2, grantVersion: 2, event: "revoked", statusBefore: "active", statusAfter: "revoked",
      actorId, actorProjectMembershipId: current.revokerProjectMembershipId, actorMembershipCreatedAt: current.revokerMembershipCreatedAt,
      delegationVersion: current.delegationVersion, delegationFingerprint: current.delegationFingerprint, connectionConfigurationRevision: current.connectionConfigurationRevision,
      grantorProjectMembershipId: current.grantorProjectMembershipId, grantorMembershipCreatedAt: current.grantorMembershipCreatedAt,
      revokerProjectMembershipId: current.revokerProjectMembershipId, revokerMembershipCreatedAt: current.revokerMembershipCreatedAt,
      definitionFingerprint: current.definitionFingerprint, networkFingerprint: current.networkFingerprint, credentialFingerprint: current.credentialFingerprint,
      connectionOwnerId: current.delegation.connectionOwnerId, connectionOwnerAccountAccessVersion: current.connectionOwnerAccountAccessVersion,
      acknowledgedAt: current.acknowledgedAt, transactionId: BigInt(0), transitionAt: new Date(0), createdAt: new Date(0),
    } });
    const projected = await loadProjectedGrant(tx, grantId);
    return { created: true, grant: projectGrant(projected, await assessGrantAdmission(tx, projected)) };
  });
}
