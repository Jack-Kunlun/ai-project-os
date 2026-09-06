import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { lockActorWorkspaceProjectAccess } from "@/lib/access-linearization";
import { isSerializationConflict } from "@/lib/project-snapshot-errors";
import { canonicalMcpToolArguments, stableMcpJson } from "@/lib/mcp/schema";
import { McpCapabilityError } from "@/lib/mcp/errors";

const UUID = z.string().uuid();
const VERSION = z.number().int().positive();
const HASH = z.string().regex(/^[0-9a-f]{64}$/u);
const MAX_SERIALIZABLE_RETRIES = 3;
const NO_CREDENTIAL_FINGERPRINT = "d2ab012fb807b99b7d059aabe98a45dd6edf6941a5f22699f8d04b5906dc2c2b";
const DB_OWNED_HASH_PLACEHOLDER = "0".repeat(64);

const proposalSchema = z.object({
  clientRequestId: UUID,
  grantId: UUID,
  expectedGrantVersion: z.literal(1),
  arguments: z.unknown(),
}).strict();

const decisionSchema = z.discriminatedUnion("decision", [
  z.object({
    decision: z.literal("approved"),
    expectedStateVersion: VERSION,
    expectedActionRevision: HASH,
    acknowledgeSingleUse: z.literal(true),
  }).strict(),
  z.object({
    decision: z.literal("rejected"),
    expectedStateVersion: VERSION,
    expectedActionRevision: HASH,
    reasonCode: z.enum(["unsafe_arguments", "stale_snapshot", "not_needed", "policy_denied"]),
  }).strict(),
]);

const cancelSchema = z.object({
  expectedStateVersion: VERSION,
  expectedActionRevision: HASH,
}).strict();

const rejectReasonMap = {
  unsafe_arguments: "unsafeArguments",
  stale_snapshot: "staleSnapshot",
  not_needed: "notNeeded",
  policy_denied: "policyDenied",
} as const;

export type ProjectMcpActionServiceErrorCode =
  | "PROJECT_MCP_ACTION_INVALID_INPUT"
  | "PROJECT_MCP_ACTION_FORBIDDEN"
  | "PROJECT_MCP_ACTION_PROJECT_OWNER_REQUIRED"
  | "PROJECT_MCP_ACTION_ACCOUNT_DISABLED"
  | "PROJECT_MCP_ACTION_NOT_FOUND"
  | "PROJECT_MCP_ACTION_PROJECT_ARCHIVED"
  | "PROJECT_MCP_ACTION_STALE"
  | "PROJECT_MCP_ACTION_CONFLICT"
  | "PROJECT_MCP_ACTION_IDEMPOTENCY_CONFLICT"
  | "PROJECT_MCP_ACTION_DECISION_CONFLICT"
  | "PROJECT_MCP_ACTION_INPUT_INVALID"
  | "PROJECT_MCP_ACTION_APPROVAL_EXPIRED";

export class ProjectMcpActionServiceError extends Error {
  constructor(readonly code: ProjectMcpActionServiceErrorCode) {
    super(code);
    this.name = "ProjectMcpActionServiceError";
  }
}

type Tx = Prisma.TransactionClient;
type Actor = Readonly<{ id: string; role: string }>;
type OwnerEpoch = Readonly<{ id: string; userId: string; createdAt: Date }>;

function fail(code: ProjectMcpActionServiceErrorCode): never {
  throw new ProjectMcpActionServiceError(code);
}

function parseUuid(value: unknown): string {
  const parsed = UUID.safeParse(value);
  return parsed.success ? parsed.data.toLowerCase() : fail("PROJECT_MCP_ACTION_INVALID_INPUT");
}

function parseActor(actor: Actor): string {
  return parseUuid(actor.id);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function actionRevisionFromFingerprint(actionFingerprint: string): string {
  return sha256(`project-mcp-action-revision:v1:${actionFingerprint}`);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(stableMcpJson(value));
}

function safeDate(value: Date | null | undefined): string | null {
  return value?.toISOString() ?? null;
}

function mapInputError(error: unknown): never {
  if (error instanceof McpCapabilityError && error.code === "MCP_TOOL_INPUT_INVALID") {
    return fail("PROJECT_MCP_ACTION_INPUT_INVALID");
  }
  throw error;
}

function isSerializable(error: unknown): boolean {
  if (isSerializationConflict(error)) return true;
  return error instanceof Prisma.PrismaClientKnownRequestError
    && error.code === "P2010"
    && /\b(?:40001|40P01)\b/u.test(JSON.stringify([error.message, error.meta]));
}

function mapMutationError(error: unknown): never | undefined {
  if (error instanceof ProjectMcpActionServiceError) throw error;
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (["P2002", "P2003", "P2025", "P2010"].includes(error.code)) return fail("PROJECT_MCP_ACTION_CONFLICT");
  }
  if (error instanceof Error && /PROJECT_MCP_ACTION/u.test(error.message)) return fail("PROJECT_MCP_ACTION_CONFLICT");
  return undefined;
}

async function withSerializableRetry<T>(db: PrismaClient, operation: (tx: Tx) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < MAX_SERIALIZABLE_RETRIES; attempt += 1) {
    try {
      return await db.$transaction(operation, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (isSerializable(error)) {
        if (attempt === MAX_SERIALIZABLE_RETRIES - 1) return fail("PROJECT_MCP_ACTION_CONFLICT");
        continue;
      }
      if (mapMutationError(error) === undefined) throw error;
    }
  }
  return fail("PROJECT_MCP_ACTION_CONFLICT");
}

async function lockConnection(tx: Tx, connectionId: string): Promise<void> {
  // Share the MCP connection/tuple/grant namespaces with the V2 grant and
  // delegation services so approval cannot race a revoke or drift mutation.
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${connectionId}::text, 32010000))`);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "McpConnection" WHERE "id" = ${connectionId}::uuid FOR UPDATE`);
}

async function lockTuple(tx: Tx, connectionId: string, toolDefinitionId: string): Promise<void> {
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${connectionId}:${toolDefinitionId}`}::text, 32010003))`);
}

async function lockActionKey(tx: Tx, key: string): Promise<void> {
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}::text, 32020007))`);
}

export async function lockActionRow(tx: Tx, projectId: string, actionId: string): Promise<void> {
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${actionId}::text, 32020002))`);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "ProjectMcpAction" WHERE "id" = ${actionId}::uuid AND "projectId" = ${projectId}::uuid FOR UPDATE`);
}

export async function lockSourceRows(tx: Tx, projectId: string, grantId: string, delegationId: string, attestationId: string, toolDefinitionId: string): Promise<void> {
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${grantId}::text, 32010002))`);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "ProjectMcpToolGrant" WHERE "id" = ${grantId}::uuid AND "projectId" = ${projectId}::uuid AND "controlPlaneVersion" = 2 FOR UPDATE`);
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${delegationId}::text, 32020004))`);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "ProjectMcpConnectionDelegation" WHERE "id" = ${delegationId}::uuid AND "projectId" = ${projectId}::uuid FOR UPDATE`);
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${toolDefinitionId}::text, 32020005))`);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "McpToolDefinition" WHERE "id" = ${toolDefinitionId}::uuid FOR UPDATE`);
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${attestationId}::text, 32020006))`);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "McpToolAttestation" WHERE "id" = ${attestationId}::uuid FOR UPDATE`);
}

export async function lockAdmission(
  tx: Tx,
  projectId: string,
  actorIds: readonly string[],
  connectionId?: string,
  toolDefinitionId?: string,
  grantId?: string,
  delegationId?: string,
  attestationId?: string,
  actionKey?: string,
  actionId?: string,
): Promise<void> {
  const project = await tx.project.findUnique({ where: { id: projectId }, select: { workspaceId: true } });
  if (project === null) return fail("PROJECT_MCP_ACTION_FORBIDDEN");
  await lockActorWorkspaceProjectAccess(tx, { actorIds, workspaceId: project.workspaceId, projectId });
  if (connectionId !== undefined) await lockConnection(tx, connectionId);
  if (connectionId !== undefined && toolDefinitionId !== undefined) await lockTuple(tx, connectionId, toolDefinitionId);
  if (grantId !== undefined && delegationId !== undefined && attestationId !== undefined && toolDefinitionId !== undefined) {
    await lockSourceRows(tx, projectId, grantId, delegationId, attestationId, toolDefinitionId);
  }
  if (actionKey !== undefined) await lockActionKey(tx, actionKey);
  if (actionId !== undefined) await lockActionRow(tx, projectId, actionId);
}

export async function ownerAdmission(
  tx: Tx,
  projectId: string,
  actorId: string,
  allowArchived: boolean,
): Promise<{ project: { id: string; workspaceId: string; archivedAt: Date | null }; membership: OwnerEpoch }> {
  const [actor, project] = await Promise.all([
    tx.appUser.findUnique({ where: { id: actorId }, select: { id: true, disabledAt: true } }),
    tx.project.findUnique({ where: { id: projectId }, select: { id: true, workspaceId: true, archivedAt: true } }),
  ]);
  if (actor === null || project === null) return fail("PROJECT_MCP_ACTION_FORBIDDEN");
  if (actor.disabledAt !== null) return fail("PROJECT_MCP_ACTION_ACCOUNT_DISABLED");
  if (!allowArchived && project.archivedAt !== null) return fail("PROJECT_MCP_ACTION_PROJECT_ARCHIVED");
  const membership = await tx.projectMembership.findFirst({
    where: { projectId, userId: actorId, role: "owner", accessState: "confirmed" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, userId: true, role: true, createdAt: true },
  });
  if (membership === null) return fail("PROJECT_MCP_ACTION_PROJECT_OWNER_REQUIRED");
  return { project, membership };
}

export const grantSelect = {
  id: true,
  projectId: true,
  connectionId: true,
  delegationId: true,
  controlPlaneVersion: true,
  grantVersion: true,
  toolName: true,
  toolDefinitionId: true,
  attestationId: true,
  definitionFingerprint: true,
  networkFingerprint: true,
  credentialFingerprint: true,
  delegationVersion: true,
  delegationFingerprint: true,
  connectionConfigurationRevision: true,
  status: true,
  toolDefinition: {
    select: {
      id: true,
      connectionId: true,
      name: true,
      inputSchema: true,
      definitionFingerprint: true,
      current: true,
      remoteReadOnlyHint: true,
      connection: {
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
          ownershipState: true,
          updatedAt: true,
          allowPrivateNetwork: true,
          credential: { select: { kind: true, secretFingerprint: true, updatedAt: true } },
        },
      },
    },
  },
  delegation: {
    select: {
      id: true,
      projectId: true,
      mcpConnectionId: true,
      connectionOwnerId: true,
      connectionConfigurationRevision: true,
      resolvedAddressFingerprint: true,
      credentialFingerprint: true,
      delegationFingerprint: true,
      expiresAt: true,
      version: true,
      status: true,
      ownerProjectMembershipId: true,
      ownerMembershipCreatedAt: true,
      projectConfirmedProjectMembershipId: true,
      projectConfirmedMembershipCreatedAt: true,
      projectConfirmedById: true,
    },
  },
  attestation: {
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
      note: true,
      evidence: true,
      verifiedById: true,
      verifiedBy: { select: { role: true, disabledAt: true } },
    },
  },
} satisfies Prisma.ProjectMcpToolGrantSelect;

export type GrantRow = Prisma.ProjectMcpToolGrantGetPayload<{ select: typeof grantSelect }>;

function expectedCredentialFingerprint(connection: GrantRow["toolDefinition"]["connection"]): string | null {
  if (connection.authKind === "none") {
    return connection.credentialId === null && connection.credentialFingerprint === NO_CREDENTIAL_FINGERPRINT
      ? NO_CREDENTIAL_FINGERPRINT
      : null;
  }
  if (connection.authKind !== "bearer" || connection.credential?.kind !== "mcp" || connection.credential.secretFingerprint !== connection.credentialFingerprint) return null;
  return connection.credentialFingerprint;
}

export async function databaseNow(tx: Tx): Promise<Date> {
  // Prisma DateTime columns are PostgreSQL TIMESTAMP(3) UTC civil values. Read
  // the database clock in that same representation so comparisons remain
  // correct even when a connection has a non-UTC session TimeZone.
  const rows = await tx.$queryRaw<Array<{ now: Date }>>(Prisma.sql`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) AS now
  `);
  return rows[0]?.now ?? new Date();
}

export async function validateGrantTuple(tx: Tx, projectId: string, grantId: string, actorMembership: OwnerEpoch, expectedGrantVersion: 1): Promise<GrantRow> {
  const grant = await tx.projectMcpToolGrant.findFirst({ where: { id: grantId, projectId, controlPlaneVersion: 2 }, select: grantSelect });
  if (grant === null || grant.status !== "active" || grant.grantVersion !== expectedGrantVersion || grant.delegation === null || grant.attestation === null) return fail("PROJECT_MCP_ACTION_STALE");
  const now = await databaseNow(tx);
  const delegation = grant.delegation;
  const definition = grant.toolDefinition;
  const connection = definition.connection;
  const expectedCredential = expectedCredentialFingerprint(connection);
  const ownerMembership = await tx.projectMembership.findUnique({ where: { id: delegation.ownerProjectMembershipId }, select: { projectId: true, userId: true, role: true, accessState: true, createdAt: true, user: { select: { disabledAt: true } } } });
  const confirmedMembership = delegation.projectConfirmedProjectMembershipId === null
    ? null
    : await tx.projectMembership.findUnique({ where: { id: delegation.projectConfirmedProjectMembershipId }, select: { projectId: true, userId: true, role: true, accessState: true, createdAt: true, user: { select: { disabledAt: true } } } });
  const revokedAttestations = await tx.mcpToolAttestationAudit.count({ where: { attestationId: grant.attestation.id, event: "revoked" } });
  const valid = delegation.projectId === projectId
    && delegation.status === "active"
    && delegation.expiresAt > now
    && delegation.mcpConnectionId === grant.connectionId
    && delegation.version === grant.delegationVersion
    && delegation.delegationFingerprint === grant.delegationFingerprint
    && ownerMembership !== null
    && ownerMembership.projectId === projectId
    && ownerMembership.userId === delegation.connectionOwnerId
    && (ownerMembership.role === "owner" || ownerMembership.role === "editor")
    && ownerMembership.accessState === "confirmed"
    && ownerMembership.createdAt.getTime() === delegation.ownerMembershipCreatedAt.getTime()
    && ownerMembership.user.disabledAt === null
    && delegation.projectConfirmedProjectMembershipId !== null
    && delegation.projectConfirmedMembershipCreatedAt !== null
    && delegation.projectConfirmedById !== null
    && confirmedMembership !== null
    && confirmedMembership.projectId === projectId
    && confirmedMembership.userId === delegation.projectConfirmedById
    && confirmedMembership.role === "owner"
    && confirmedMembership.accessState === "confirmed"
    && confirmedMembership.createdAt.getTime() === delegation.projectConfirmedMembershipCreatedAt.getTime()
    && confirmedMembership.user.disabledAt === null
    && definition.id === grant.toolDefinitionId
    && definition.connectionId === grant.connectionId
    && definition.name === grant.toolName
    && definition.current
    && definition.remoteReadOnlyHint
    && definition.definitionFingerprint === grant.definitionFingerprint
    && connection.id === grant.connectionId
    && connection.status === "verified"
    && connection.disabledAt === null
    && connection.ownerUserId === delegation.connectionOwnerId
    && connection.ownershipState === "confirmed"
    && connection.resolvedAddressFingerprint !== null
    && connection.configurationRevision === delegation.connectionConfigurationRevision
    && connection.configurationRevision === grant.connectionConfigurationRevision
    && connection.resolvedAddressFingerprint === delegation.resolvedAddressFingerprint
    && connection.resolvedAddressFingerprint === grant.networkFingerprint
    && expectedCredential !== null
    && expectedCredential === delegation.credentialFingerprint
    && expectedCredential === grant.credentialFingerprint
    && grant.attestation.controlPlaneVersion === 2
    && grant.attestation.status === "active"
    && grant.attestation.version === 1
    && grant.attestation.connectionId === grant.connectionId
    && grant.attestation.toolDefinitionId === grant.toolDefinitionId
    && grant.attestation.toolName === grant.toolName
    && grant.attestation.definitionFingerprint === grant.definitionFingerprint
    && grant.attestation.networkFingerprint === grant.networkFingerprint
    && grant.attestation.credentialFingerprint === grant.credentialFingerprint
    && grant.attestation.connectionConfigurationRevision === connection.configurationRevision
    && grant.attestation.conclusion === "read_only_verified"
    && ["low", "medium", "high"].includes(grant.attestation.riskLevel ?? "")
    && grant.attestation.evidenceNote === "manual_read_only_review"
    && grant.attestation.note === null
    && JSON.stringify(grant.attestation.evidence) === "{}"
    && grant.attestation.verifiedBy.role === "admin"
    && grant.attestation.verifiedBy.disabledAt === null
    && revokedAttestations === 0;
  if (!valid) return fail("PROJECT_MCP_ACTION_STALE");
  return grant;
}

export type ActionProjectionRow = {
  id: string;
  projectId: string;
  clientRequestId: string;
  grantId: string;
  delegationId: string;
  toolDefinitionId: string;
  attestationId: string;
  toolName: string;
  status: string;
  stateVersion: number;
  createdAt: Date;
  transitionAt: Date;
  approvedAt: Date | null;
  approvalExpiresAt: Date | null;
  rejectedAt: Date | null;
  cancelledAt: Date | null;
  actionFingerprint: string;
  canonicalArguments: unknown;
  dispatchResult?: {
    sanitizedPayload: unknown;
    resultFingerprint: string;
    resultBytes: number;
    resultNodes: number;
    resultDepth: number;
    omittedContentCount: number;
  } | null;
};

const actionProjectionSelect = {
  id: true,
  projectId: true,
  clientRequestId: true,
  grantId: true,
  delegationId: true,
  toolDefinitionId: true,
  attestationId: true,
  toolName: true,
  status: true,
  stateVersion: true,
  createdAt: true,
  transitionAt: true,
  approvedAt: true,
  approvalExpiresAt: true,
  rejectedAt: true,
  cancelledAt: true,
  actionFingerprint: true,
} satisfies Prisma.ProjectMcpActionSelect;

const actionDetailSelect = {
  ...actionProjectionSelect,
  canonicalArguments: true,
  dispatchResult: {
    select: {
      sanitizedPayload: true,
      resultFingerprint: true,
      resultBytes: true,
      resultNodes: true,
      resultDepth: true,
      omittedContentCount: true,
    },
  },
} satisfies Prisma.ProjectMcpActionSelect;

const actionControlSelect = {
  ...actionDetailSelect,
  connectionId: true,
  grantVersion: true,
  delegationVersion: true,
  attestationVersion: true,
  delegationFingerprint: true,
  definitionFingerprint: true,
  networkFingerprint: true,
  credentialFingerprint: true,
  connectionConfigurationRevision: true,
  proposerProjectMembershipId: true,
  proposerMembershipCreatedAt: true,
  connectionOwnerId: true,
  connectionOwnershipState: true,
  connectionAllowPrivateNetwork: true,
  connectionUpdatedAt: true,
  credentialUpdatedAt: true,
  lastActorId: true,
  lastActorProjectMembershipId: true,
  lastActorMembershipCreatedAt: true,
  canonicalArgumentsHash: true,
  inputSchema: true,
} satisfies Prisma.ProjectMcpActionSelect;

export function projectAction(row: ActionProjectionRow, detail: boolean): Readonly<Record<string, unknown>> {
  const projection: Record<string, unknown> = {
    id: row.id,
    projectId: row.projectId,
    clientRequestId: row.clientRequestId,
    grantId: row.grantId,
    delegationId: row.delegationId,
    toolDefinitionId: row.toolDefinitionId,
    attestationId: row.attestationId,
    toolName: row.toolName,
    actionRevision: actionRevisionFromFingerprint(row.actionFingerprint),
    status: row.status,
    stateVersion: row.stateVersion,
    createdAt: safeDate(row.createdAt),
    transitionAt: safeDate(row.transitionAt),
    approvedAt: safeDate(row.approvedAt),
    approvalExpiresAt: safeDate(row.approvalExpiresAt),
    rejectedAt: safeDate(row.rejectedAt),
    cancelledAt: safeDate(row.cancelledAt),
  };
  if (detail) projection.arguments = stableMcpJson(row.canonicalArguments);
  if (detail && row.dispatchResult !== undefined && row.dispatchResult !== null) {
    projection.result = Object.freeze({
      payload: stableMcpJson(row.dispatchResult.sanitizedPayload),
      resultFingerprint: row.dispatchResult.resultFingerprint,
      resultBytes: row.dispatchResult.resultBytes,
      resultNodes: row.dispatchResult.resultNodes,
      resultDepth: row.dispatchResult.resultDepth,
      omittedContentCount: row.dispatchResult.omittedContentCount,
    });
  }
  return Object.freeze(projection);
}

export async function loadAction(tx: Tx, projectId: string, actionId: string, detail: boolean): Promise<Readonly<Record<string, unknown>>> {
  const action = await tx.projectMcpAction.findFirst({ where: { id: actionId, projectId }, select: detail ? actionDetailSelect : actionProjectionSelect });
  if (action === null) return fail("PROJECT_MCP_ACTION_NOT_FOUND");
  return projectAction(action as unknown as ActionProjectionRow, detail);
}

export async function loadActionRow(tx: Tx, projectId: string, actionId: string) {
  const row = await tx.projectMcpAction.findFirst({ where: { id: actionId, projectId }, select: actionControlSelect });
  if (row === null) return fail("PROJECT_MCP_ACTION_NOT_FOUND");
  return row;
}

export type ActionControlRow = Prisma.ProjectMcpActionGetPayload<{ select: typeof actionControlSelect }>;

function jsonEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export async function persistedActionHashesValid(tx: Tx, action: ActionControlRow): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ argumentsHash: string; fingerprint: string }>>(Prisma.sql`
    SELECT
      encode(digest(convert_to(source."canonicalArguments"::text, 'UTF8'), 'sha256'), 'hex') AS "argumentsHash",
      "project_mcp_action_snapshot_fingerprint"(source) AS "fingerprint"
    FROM "ProjectMcpAction" AS source
    WHERE source."id" = ${action.id}::uuid AND source."projectId" = ${action.projectId}::uuid
  `);
  return rows[0]?.argumentsHash === action.canonicalArgumentsHash && rows[0]?.fingerprint === action.actionFingerprint;
}

export function sourceSnapshotMatchesAction(action: ActionControlRow, grant: GrantRow): boolean {
  const delegation = grant.delegation;
  const attestation = grant.attestation;
  const connection = grant.toolDefinition.connection;
  return delegation !== null
    && attestation !== null
    && action.grantId === grant.id
    && action.delegationId === delegation.id
    && action.toolDefinitionId === grant.toolDefinition.id
    && action.attestationId === attestation.id
    && action.connectionId === grant.connectionId
    && action.toolName === grant.toolName
    && jsonEqual(action.inputSchema, grant.toolDefinition.inputSchema)
    && action.grantVersion === grant.grantVersion
    && action.delegationVersion === grant.delegationVersion
    && action.attestationVersion === attestation.version
    && action.delegationFingerprint === grant.delegationFingerprint
    && action.definitionFingerprint === grant.definitionFingerprint
    && action.networkFingerprint === grant.networkFingerprint
    && action.credentialFingerprint === grant.credentialFingerprint
    && action.connectionConfigurationRevision === grant.connectionConfigurationRevision
    && action.connectionOwnerId === connection.ownerUserId
    && action.connectionOwnershipState === connection.ownershipState
    && action.connectionAllowPrivateNetwork === connection.allowPrivateNetwork
    && action.connectionUpdatedAt.getTime() === connection.updatedAt.getTime()
    && (action.credentialUpdatedAt?.getTime() ?? null) === (connection.credential?.updatedAt?.getTime() ?? null);
}

async function preflightAction(tx: Tx, projectId: string, actionId: string): Promise<{ id: string; grantId: string; delegationId: string; attestationId: string; connectionId: string; toolDefinitionId: string }> {
  const row = await tx.projectMcpAction.findFirst({ where: { id: actionId, projectId }, select: { id: true, grantId: true, delegationId: true, attestationId: true, connectionId: true, toolDefinitionId: true } });
  if (row === null) return fail("PROJECT_MCP_ACTION_NOT_FOUND");
  return row;
}

export async function listProjectMcpActions(projectIdInput: unknown, actor: Actor, db: PrismaClient = getDb()) {
  const projectId = parseUuid(projectIdInput);
  const actorId = parseActor(actor);
  return withSerializableRetry(db, async (tx) => {
    await lockAdmission(tx, projectId, [actorId]);
    const { project } = await ownerAdmission(tx, projectId, actorId, true);
    const rows = await tx.projectMcpAction.findMany({ where: { projectId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: actionProjectionSelect });
    return Object.freeze({ projectId, archived: project.archivedAt !== null, actions: rows.map((row) => projectAction({ ...row, canonicalArguments: null } as unknown as ActionProjectionRow, false)) });
  });
}

export async function getProjectMcpAction(projectIdInput: unknown, actionIdInput: unknown, actor: Actor, db: PrismaClient = getDb()) {
  const projectId = parseUuid(projectIdInput);
  const actionId = parseUuid(actionIdInput);
  const actorId = parseActor(actor);
  return withSerializableRetry(db, async (tx) => {
    await lockAdmission(tx, projectId, [actorId]);
    await ownerAdmission(tx, projectId, actorId, true);
    const seed = await preflightAction(tx, projectId, actionId);
    await lockAdmission(tx, projectId, [actorId], seed.connectionId, seed.toolDefinitionId, seed.grantId, seed.delegationId, seed.attestationId, undefined, seed.id);
    await ownerAdmission(tx, projectId, actorId, true);
    return loadAction(tx, projectId, actionId, true);
  });
}

type ProposalPreflight = Readonly<{ grantId: string; delegationId: string; attestationId: string; connectionId: string; toolDefinitionId: string; toolName: string; connectionOwnerId: string; projectConfirmedById: string; attestationVerifierId: string }>;

async function proposalPreflight(tx: Tx, projectId: string, grantId: string): Promise<ProposalPreflight> {
  const grant = await tx.projectMcpToolGrant.findFirst({ where: { id: grantId, projectId, controlPlaneVersion: 2 }, select: {
    id: true,
    delegationId: true,
    attestationId: true,
    connectionId: true,
    toolDefinitionId: true,
    toolName: true,
    delegation: { select: { connectionOwnerId: true, projectConfirmedById: true } },
    attestation: { select: { verifiedById: true } },
  } });
  if (grant === null || grant.delegationId === null || grant.attestationId === null || grant.delegation === null || grant.delegation.projectConfirmedById === null || grant.attestation === null) return fail("PROJECT_MCP_ACTION_STALE");
  return { grantId: grant.id, delegationId: grant.delegationId, attestationId: grant.attestationId, connectionId: grant.connectionId, toolDefinitionId: grant.toolDefinitionId, toolName: grant.toolName, connectionOwnerId: grant.delegation.connectionOwnerId, projectConfirmedById: grant.delegation.projectConfirmedById, attestationVerifierId: grant.attestation.verifiedById };
}

export async function proposeProjectMcpAction(projectIdInput: unknown, input: unknown, actor: Actor, db: PrismaClient = getDb()) {
  const projectId = parseUuid(projectIdInput);
  const parsed = proposalSchema.safeParse(input);
  if (!parsed.success) return fail("PROJECT_MCP_ACTION_INVALID_INPUT");
  const actorId = parseActor(actor);
  let preflight: ProposalPreflight;
  try {
    preflight = await withSerializableRetry(db, async (tx) => {
      await lockAdmission(tx, projectId, [actorId]);
      await ownerAdmission(tx, projectId, actorId, false);
      return proposalPreflight(tx, projectId, parsed.data.grantId);
    });
  } catch (error) {
    if (error instanceof ProjectMcpActionServiceError) throw error;
    throw error;
  }

  return withSerializableRetry(db, async (tx) => {
    await lockAdmission(tx, projectId, [actorId, preflight.connectionOwnerId, preflight.projectConfirmedById, preflight.attestationVerifierId], preflight.connectionId, preflight.toolDefinitionId, preflight.grantId, preflight.delegationId, preflight.attestationId, `${projectId}:${parsed.data.clientRequestId}`);
    const { membership } = await ownerAdmission(tx, projectId, actorId, false);

    // Idempotent replays are resolved from the project-scoped request key before
    // re-reading the external grant tuple. A source grant may have been revoked
    // after the original proposal, but an exact replay must still be a zero-write
    // created:false response rather than being misreported as a fresh stale tuple.
    const requestedGrantId = parsed.data.grantId.toLowerCase();
    const existing = await tx.projectMcpAction.findUnique({ where: { projectId_clientRequestId: { projectId, clientRequestId: parsed.data.clientRequestId } }, select: { ...actionDetailSelect, canonicalArgumentsHash: true, grantId: true, inputSchema: true, grantVersion: true } });
    if (existing !== null) {
      let replayArguments: unknown;
      try {
        replayArguments = canonicalMcpToolArguments(existing.inputSchema, parsed.data.arguments);
      } catch {
        return fail("PROJECT_MCP_ACTION_IDEMPOTENCY_CONFLICT");
      }
      if (canonicalJson(replayArguments) !== canonicalJson(existing.canonicalArguments)
        || existing.grantId !== requestedGrantId
        || existing.grantVersion !== parsed.data.expectedGrantVersion) return fail("PROJECT_MCP_ACTION_IDEMPOTENCY_CONFLICT");
      return { created: false, action: projectAction(existing as unknown as ActionProjectionRow, true) };
    }

    const grant = await validateGrantTuple(tx, projectId, parsed.data.grantId, membership, parsed.data.expectedGrantVersion);
    const canonicalArguments = (() => {
      try {
        return canonicalMcpToolArguments(grant.toolDefinition.inputSchema, parsed.data.arguments);
      } catch (error) {
        return mapInputError(error);
      }
    })();
    const actionId = randomUUID();
    const connection = grant.toolDefinition.connection;
    const action = await tx.projectMcpAction.create({ data: {
      id: actionId,
      projectId,
      clientRequestId: parsed.data.clientRequestId,
      grantId: grant.id,
      delegationId: grant.delegation!.id,
      toolDefinitionId: grant.toolDefinition.id,
      attestationId: grant.attestation!.id,
      connectionId: grant.connectionId,
      toolName: grant.toolName,
      inputSchema: stableMcpJson(grant.toolDefinition.inputSchema) as Prisma.InputJsonValue,
      canonicalArguments: canonicalArguments as Prisma.InputJsonValue,
      canonicalArgumentsHash: DB_OWNED_HASH_PLACEHOLDER,
      actionFingerprint: DB_OWNED_HASH_PLACEHOLDER,
      status: "waitingApproval",
      stateVersion: 1,
      proposerProjectMembershipId: membership.id,
      proposerMembershipCreatedAt: membership.createdAt,
      lastActorId: actorId,
      lastActorProjectMembershipId: membership.id,
      lastActorMembershipCreatedAt: membership.createdAt,
      grantVersion: grant.grantVersion!,
      delegationVersion: grant.delegationVersion!,
      attestationVersion: grant.attestation!.version!,
      delegationFingerprint: grant.delegationFingerprint!,
      definitionFingerprint: grant.definitionFingerprint!,
      networkFingerprint: grant.networkFingerprint!,
      credentialFingerprint: grant.credentialFingerprint!,
      connectionConfigurationRevision: grant.connectionConfigurationRevision!,
      connectionOwnerId: connection.ownerUserId!,
      connectionOwnershipState: connection.ownershipState,
      connectionAllowPrivateNetwork: connection.allowPrivateNetwork,
      connectionUpdatedAt: connection.updatedAt,
      credentialUpdatedAt: connection.credential?.updatedAt ?? null,
      creationTransactionId: BigInt(0),
      transitionTransactionId: BigInt(0),
    } });
    await tx.projectMcpActionLedger.create({ data: {
      id: randomUUID(), projectId, actionId: action.id, clientRequestId: action.clientRequestId, grantId: action.grantId,
      delegationId: action.delegationId, toolDefinitionId: action.toolDefinitionId, attestationId: action.attestationId, connectionId: action.connectionId,
      toolName: action.toolName, event: "proposed", statusBefore: null, statusAfter: "waitingApproval", stateVersion: 1,
      actorId, actorProjectMembershipId: membership.id, actorMembershipCreatedAt: membership.createdAt,
      grantVersion: action.grantVersion, delegationVersion: action.delegationVersion, attestationVersion: action.attestationVersion,
      delegationFingerprint: action.delegationFingerprint, definitionFingerprint: action.definitionFingerprint, networkFingerprint: action.networkFingerprint,
      credentialFingerprint: action.credentialFingerprint, connectionConfigurationRevision: action.connectionConfigurationRevision,
      canonicalArgumentsHash: action.canonicalArgumentsHash, actionFingerprint: action.actionFingerprint,
      transactionId: BigInt(0), transitionAt: new Date(0), createdAt: new Date(0),
    } });
    const projected = await tx.projectMcpAction.findUniqueOrThrow({ where: { id: action.id }, select: actionDetailSelect });
    return { created: true, action: projectAction(projected as unknown as ActionProjectionRow, true) };
  });
}

function sameActorEpoch(row: { lastActorId: string; lastActorProjectMembershipId: string; lastActorMembershipCreatedAt: Date }, actorId: string, membership: OwnerEpoch): boolean {
  return row.lastActorId === actorId && row.lastActorProjectMembershipId === membership.id && row.lastActorMembershipCreatedAt.getTime() === membership.createdAt.getTime();
}

export async function decideProjectMcpAction(projectIdInput: unknown, actionIdInput: unknown, input: unknown, actor: Actor, db: PrismaClient = getDb()) {
  const projectId = parseUuid(projectIdInput);
  const actionId = parseUuid(actionIdInput);
  const parsed = decisionSchema.safeParse(input);
  if (!parsed.success) return fail("PROJECT_MCP_ACTION_INVALID_INPUT");
  const actorId = parseActor(actor);
  return withSerializableRetry(db, async (tx) => {
    await lockAdmission(tx, projectId, [actorId]);
    await ownerAdmission(tx, projectId, actorId, false);
    const seed = await preflightAction(tx, projectId, actionId);
    await lockAdmission(tx, projectId, [actorId], seed.connectionId, seed.toolDefinitionId, seed.grantId, seed.delegationId, seed.attestationId, undefined, seed.id);
    const { membership } = await ownerAdmission(tx, projectId, actorId, false);
    const action = await loadActionRow(tx, projectId, actionId);
    const existingDecision = await tx.projectMcpActionDecision.findUnique({ where: { projectId_actionId: { projectId, actionId } } });
    if (existingDecision !== null) {
      const exact = existingDecision.decision === parsed.data.decision
        && existingDecision.expectedStateVersion === parsed.data.expectedStateVersion
        && actionRevisionFromFingerprint(existingDecision.expectedActionFingerprint) === parsed.data.expectedActionRevision
        && existingDecision.actorId === actorId
        && existingDecision.actorProjectMembershipId === membership.id
        && existingDecision.actorMembershipCreatedAt.getTime() === membership.createdAt.getTime()
        && (parsed.data.decision === "approved"
          ? existingDecision.acknowledgedSingleUse === true
          : existingDecision.reasonCode === rejectReasonMap[parsed.data.reasonCode]);
      if (exact) return { created: false, action: projectAction(action as unknown as ActionProjectionRow, true) };
      return fail("PROJECT_MCP_ACTION_DECISION_CONFLICT");
    }
    if (actionRevisionFromFingerprint(action.actionFingerprint) !== parsed.data.expectedActionRevision || action.stateVersion !== parsed.data.expectedStateVersion || action.status !== "waitingApproval") return fail("PROJECT_MCP_ACTION_DECISION_CONFLICT");
    if (parsed.data.decision === "approved") {
      const grant = await validateGrantTuple(tx, projectId, action.grantId, membership, 1);
      let canonicalArguments: unknown;
      try {
        canonicalArguments = canonicalMcpToolArguments(grant.toolDefinition.inputSchema, action.canonicalArguments);
      } catch (error) {
        return mapInputError(error);
      }
      if (!sourceSnapshotMatchesAction(action, grant)
        || !jsonEqual(action.canonicalArguments, canonicalArguments)
        || !await persistedActionHashesValid(tx, action)) return fail("PROJECT_MCP_ACTION_STALE");
    }
    const nextStatus = parsed.data.decision === "approved" ? "approved" : "rejected";
    const updated = await tx.projectMcpAction.updateMany({ where: { id: actionId, projectId, status: "waitingApproval", stateVersion: parsed.data.expectedStateVersion, actionFingerprint: action.actionFingerprint }, data: { status: nextStatus, stateVersion: { increment: 1 }, lastActorId: actorId, lastActorProjectMembershipId: membership.id, lastActorMembershipCreatedAt: membership.createdAt } });
    if (updated.count !== 1) return fail("PROJECT_MCP_ACTION_DECISION_CONFLICT");
    await tx.projectMcpActionDecision.create({ data: {
      id: randomUUID(), projectId, actionId, decision: parsed.data.decision,
      expectedStateVersion: parsed.data.expectedStateVersion,
      expectedActionFingerprint: action.actionFingerprint,
      actorId, actorProjectMembershipId: membership.id, actorMembershipCreatedAt: membership.createdAt,
      reasonCode: parsed.data.decision === "rejected" ? rejectReasonMap[parsed.data.reasonCode] : null,
      acknowledgedSingleUse: parsed.data.decision === "approved",
      transactionId: BigInt(0), decidedAt: new Date(0), createdAt: new Date(0),
    } });
    await tx.projectMcpActionLedger.create({ data: {
      id: randomUUID(), projectId, actionId, clientRequestId: action.clientRequestId, grantId: action.grantId,
      delegationId: action.delegationId, toolDefinitionId: action.toolDefinitionId, attestationId: action.attestationId, connectionId: action.connectionId,
      toolName: action.toolName, event: parsed.data.decision === "approved" ? "approved" : "rejected", statusBefore: "waitingApproval", statusAfter: nextStatus,
      stateVersion: parsed.data.expectedStateVersion + 1, actorId, actorProjectMembershipId: membership.id, actorMembershipCreatedAt: membership.createdAt,
      grantVersion: action.grantVersion, delegationVersion: action.delegationVersion, attestationVersion: action.attestationVersion,
      delegationFingerprint: action.delegationFingerprint, definitionFingerprint: action.definitionFingerprint, networkFingerprint: action.networkFingerprint,
      credentialFingerprint: action.credentialFingerprint, connectionConfigurationRevision: action.connectionConfigurationRevision,
      canonicalArgumentsHash: action.canonicalArgumentsHash, actionFingerprint: action.actionFingerprint,
      transactionId: BigInt(0), transitionAt: new Date(0), createdAt: new Date(0),
    } });
    const projected = await tx.projectMcpAction.findUniqueOrThrow({ where: { id: actionId }, select: actionDetailSelect });
    return { created: true, action: projectAction(projected as unknown as ActionProjectionRow, true) };
  });
}

export async function cancelProjectMcpAction(projectIdInput: unknown, actionIdInput: unknown, input: unknown, actor: Actor, db: PrismaClient = getDb()) {
  const projectId = parseUuid(projectIdInput);
  const actionId = parseUuid(actionIdInput);
  const parsed = cancelSchema.safeParse(input);
  if (!parsed.success) return fail("PROJECT_MCP_ACTION_INVALID_INPUT");
  const actorId = parseActor(actor);
  return withSerializableRetry(db, async (tx) => {
    await lockAdmission(tx, projectId, [actorId]);
    await ownerAdmission(tx, projectId, actorId, true);
    const seed = await preflightAction(tx, projectId, actionId);
    await lockAdmission(tx, projectId, [actorId], seed.connectionId, seed.toolDefinitionId, seed.grantId, seed.delegationId, seed.attestationId, undefined, seed.id);
    const { membership } = await ownerAdmission(tx, projectId, actorId, true);
    const action = await loadActionRow(tx, projectId, actionId);
    const expectedActionFingerprint = action.actionFingerprint;
    if (action.status === "cancelled" && action.stateVersion === parsed.data.expectedStateVersion + 1 && actionRevisionFromFingerprint(expectedActionFingerprint) === parsed.data.expectedActionRevision && sameActorEpoch(action, actorId, membership)) {
      return { created: false, action: projectAction(action as unknown as ActionProjectionRow, true) };
    }
    if (actionRevisionFromFingerprint(expectedActionFingerprint) !== parsed.data.expectedActionRevision || action.stateVersion !== parsed.data.expectedStateVersion || !["waitingApproval", "approved"].includes(action.status)) return fail("PROJECT_MCP_ACTION_DECISION_CONFLICT");
    const previousStatus = action.status;
    const updated = await tx.projectMcpAction.updateMany({ where: { id: actionId, projectId, status: previousStatus === "approved" ? "approved" : "waitingApproval", stateVersion: parsed.data.expectedStateVersion, actionFingerprint: expectedActionFingerprint }, data: { status: "cancelled", stateVersion: { increment: 1 }, lastActorId: actorId, lastActorProjectMembershipId: membership.id, lastActorMembershipCreatedAt: membership.createdAt } });
    if (updated.count !== 1) return fail("PROJECT_MCP_ACTION_DECISION_CONFLICT");
    await tx.projectMcpActionLedger.create({ data: {
      id: randomUUID(), projectId, actionId, clientRequestId: action.clientRequestId, grantId: action.grantId,
      delegationId: action.delegationId, toolDefinitionId: action.toolDefinitionId, attestationId: action.attestationId, connectionId: action.connectionId,
      toolName: action.toolName, event: "cancelled", statusBefore: previousStatus, statusAfter: "cancelled", stateVersion: parsed.data.expectedStateVersion + 1,
      actorId, actorProjectMembershipId: membership.id, actorMembershipCreatedAt: membership.createdAt,
      grantVersion: action.grantVersion, delegationVersion: action.delegationVersion, attestationVersion: action.attestationVersion,
      delegationFingerprint: action.delegationFingerprint, definitionFingerprint: action.definitionFingerprint, networkFingerprint: action.networkFingerprint,
      credentialFingerprint: action.credentialFingerprint, connectionConfigurationRevision: action.connectionConfigurationRevision,
      canonicalArgumentsHash: action.canonicalArgumentsHash, actionFingerprint: action.actionFingerprint,
      transactionId: BigInt(0), transitionAt: new Date(0), createdAt: new Date(0),
    } });
    const projected = await tx.projectMcpAction.findUniqueOrThrow({ where: { id: actionId }, select: actionDetailSelect });
    return { created: true, action: projectAction(projected as unknown as ActionProjectionRow, true) };
  });
}
