import { createHash, randomUUID } from "node:crypto";
import {
  Prisma,
  type PrismaClient,
  type ProjectMcpConnectionDelegation,
  type ProjectMcpConnectionDelegationActorKind,
  type ProjectMcpConnectionDelegationAuditAction,
  type ProjectMcpConnectionDelegationStatus,
} from "@prisma/client";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { AccountAccessGuardError, assertAccountAccessForActor } from "@/lib/account-access-guard";
import {
  admitWebAiProjectAccess,
  lockActorWorkspaceProjectAccess,
  type ProjectAccessAdmission,
  type WebAiActor,
  WebAiAccessError,
} from "@/lib/access-linearization";
import { isSerializationConflict } from "@/lib/project-snapshot-errors";

const MIN_EXPIRY_MS = 10 * 60 * 1_000;
const MAX_EXPIRY_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_VERSION = 2_147_483_646;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/u;
const NO_CREDENTIAL_FINGERPRINT = "d2ab012fb807b99b7d059aabe98a45dd6edf6941a5f22699f8d04b5906dc2c2b";
const UUID_SCHEMA = z.string().uuid();
const UTC_TIMESTAMP_SCHEMA = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
const VERSION_SCHEMA = z.number().int().positive().max(MAX_VERSION);

const proposalSchema = z.object({
  mcpConnectionId: UUID_SCHEMA,
  expiresAt: UTC_TIMESTAMP_SCHEMA,
}).strict();

const ownerConfirmationSchema = z.object({
  expectedVersion: VERSION_SCHEMA,
  acknowledgeCredentialUse: z.literal(true),
}).strict();

const projectConfirmationSchema = z.object({
  expectedVersion: VERSION_SCHEMA,
  acknowledgeProjectScope: z.literal(true),
  acknowledgeDataEgress: z.literal(true),
}).strict();

const terminalSchema = z.object({
  expectedVersion: VERSION_SCHEMA,
  reason: z.string().trim().min(1).max(500),
}).strict();

export type ProjectMcpConnectionDelegationServiceErrorCode =
  | "PROJECT_MCP_CONNECTION_DELEGATION_INVALID_INPUT"
  | "PROJECT_MCP_CONNECTION_DELEGATION_NOT_FOUND"
  | "PROJECT_MCP_CONNECTION_DELEGATION_CONNECTION_NOT_FOUND"
  | "PROJECT_MCP_CONNECTION_DELEGATION_FORBIDDEN"
  | "PROJECT_MCP_CONNECTION_DELEGATION_MEMBERSHIP_REQUIRED"
  | "PROJECT_MCP_CONNECTION_DELEGATION_PROJECT_OWNER_REQUIRED"
  | "PROJECT_MCP_CONNECTION_DELEGATION_PROJECT_ARCHIVED"
  | "PROJECT_MCP_CONNECTION_DELEGATION_CONNECTION_UNAVAILABLE"
  | "PROJECT_MCP_CONNECTION_DELEGATION_STATE_CONFLICT"
  | "PROJECT_MCP_CONNECTION_DELEGATION_VERSION_CONFLICT"
  | "PROJECT_MCP_CONNECTION_DELEGATION_CONFLICT"
  | "PROJECT_MCP_CONNECTION_DELEGATION_EXPIRED"
  | "PROJECT_MCP_CONNECTION_DELEGATION_ACCOUNT_DISABLED";

export class ProjectMcpConnectionDelegationServiceError extends Error {
  constructor(readonly code: ProjectMcpConnectionDelegationServiceErrorCode) {
    super(code);
    this.name = "ProjectMcpConnectionDelegationServiceError";
  }
}

type DelegationDb = PrismaClient | Prisma.TransactionClient;

const delegationSelect = {
  id: true,
  projectId: true,
  mcpConnectionId: true,
  connectionOwnerId: true,
  connectionOwnerAccountAccessVersion: true,
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
  proposedById: true,
  proposedAt: true,
  ownerConfirmedById: true,
  ownerConfirmedAt: true,
  projectConfirmedById: true,
  projectConfirmedAt: true,
  activatedAt: true,
  rejectedAt: true,
  revokedAt: true,
  expiredAt: true,
  terminalActorKind: true,
  terminalActorId: true,
  terminalActorProjectMembershipId: true,
  terminalActorMembershipCreatedAt: true,
  terminalReason: true,
  createdAt: true,
  updatedAt: true,
  connectionOwner: { select: { displayName: true, disabledAt: true, accountAccessVersion: true } },
  projectConfirmedBy: { select: { displayName: true } },
  terminalActor: { select: { displayName: true } },
  project: { select: { id: true, name: true, archivedAt: true, workspaceId: true } },
  mcpConnection: {
    select: {
      id: true,
      name: true,
      authKind: true,
      status: true,
      disabledAt: true,
      ownershipState: true,
      ownerUserId: true,
      ownerAccountAccessVersion: true,
      configurationRevision: true,
      resolvedAddressFingerprint: true,
      credentialFingerprint: true,
      credential: { select: { kind: true, secretFingerprint: true } },
    },
  },
  ownerProjectMembership: { select: { projectId: true, userId: true, role: true, accessState: true, createdAt: true, user: { select: { disabledAt: true, accountAccessVersion: true } } } },
  projectConfirmedProjectMembership: { select: { projectId: true, userId: true, role: true, accessState: true, createdAt: true, user: { select: { disabledAt: true, accountAccessVersion: true } } } },
} as const;

type DelegationRow = Prisma.ProjectMcpConnectionDelegationGetPayload<{ select: typeof delegationSelect }>;

type MembershipEpoch = Readonly<{ id: string; projectId: string; userId: string; role: string; accessState: string; createdAt: Date }>;

export type ProjectMcpConnectionDelegationCapabilities = Readonly<{
  canOwnerConfirm: boolean;
  canProjectConfirm: boolean;
  canReject: boolean;
  canRevoke: boolean;
}>;

export type ProjectMcpConnectionDelegationEffectiveEligibility = Readonly<{
  eligible: boolean;
  reason: "NOT_ACTIVE" | "EXPIRED" | "PROJECT_ARCHIVED" | "CONNECTION_EVIDENCE_DRIFT" | "OWNER_MEMBERSHIP_DRIFT" | "PROJECT_OWNER_MEMBERSHIP_DRIFT" | null;
}>;

function fail(code: ProjectMcpConnectionDelegationServiceErrorCode): never {
  throw new ProjectMcpConnectionDelegationServiceError(code);
}

function parseUuid(value: unknown): string {
  const parsed = UUID_SCHEMA.safeParse(value);
  if (!parsed.success) return fail("PROJECT_MCP_CONNECTION_DELEGATION_INVALID_INPUT");
  return parsed.data.toLowerCase();
}

function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) return fail("PROJECT_MCP_CONNECTION_DELEGATION_INVALID_INPUT");
  return parsed.data;
}

function parseUtcTimestamp(value: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) return fail("PROJECT_MCP_CONNECTION_DELEGATION_INVALID_INPUT");
  return parsed;
}

function isPrismaCode(error: unknown, code: string): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "";
}

function mapDatabaseError(error: unknown): never {
  if (error instanceof ProjectMcpConnectionDelegationServiceError) throw error;
  if (error instanceof WebAiAccessError) return fail("PROJECT_MCP_CONNECTION_DELEGATION_FORBIDDEN");
  if (isPrismaCode(error, "P2002") || isPrismaCode(error, "P2003") || isPrismaCode(error, "P2025")) {
    return fail("PROJECT_MCP_CONNECTION_DELEGATION_CONFLICT");
  }
  if (isSerializationConflict(error)) return fail("PROJECT_MCP_CONNECTION_DELEGATION_CONFLICT");
  const message = errorText(error);
  if (message.includes("PROJECT_MCP_CONNECTION_DELEGATION_LIVE_EXPIRED") || message.includes("PROJECT_MCP_CONNECTION_DELEGATION_NOT_EXPIRED")) {
    return fail("PROJECT_MCP_CONNECTION_DELEGATION_EXPIRED");
  }
  if (message.includes("PROJECT_MCP_CONNECTION_DELEGATION_LIVE_CONNECTION_INVALID")) {
    return fail("PROJECT_MCP_CONNECTION_DELEGATION_CONNECTION_UNAVAILABLE");
  }
  if (message.includes("PROJECT_MCP_CONNECTION_DELEGATION_LIVE_OWNER_INVALID")) {
    return fail("PROJECT_MCP_CONNECTION_DELEGATION_MEMBERSHIP_REQUIRED");
  }
  if (message.includes("PROJECT_MCP_CONNECTION_DELEGATION_ACTIVE_PROJECT_OWNER_INVALID")) {
    return fail("PROJECT_MCP_CONNECTION_DELEGATION_PROJECT_OWNER_REQUIRED");
  }
  if (message.includes("PROJECT_MCP_CONNECTION_DELEGATION_AUDIT_ACTOR_INVALID")) {
    return fail("PROJECT_MCP_CONNECTION_DELEGATION_FORBIDDEN");
  }
  if (message.includes("PROJECT_MCP_CONNECTION_DELEGATION_STATE_INVALID") || message.includes("PROJECT_MCP_CONNECTION_DELEGATION_VERSION_INVALID")) {
    return fail("PROJECT_MCP_CONNECTION_DELEGATION_STATE_CONFLICT");
  }
  if (message.includes("PROJECT_MCP_CONNECTION_DELEGATION_")) {
    return fail("PROJECT_MCP_CONNECTION_DELEGATION_CONFLICT");
  }
  throw error;
}

async function databaseNow(db: PrismaClient | Prisma.TransactionClient): Promise<Date> {
  const rows = await db.$queryRaw<Array<{ now: Date | string }>>(Prisma.sql`SELECT (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) AS "now"`);
  const value = rows[0]?.now;
  const now = value instanceof Date ? value : new Date(value ?? "");
  if (!Number.isFinite(now.getTime())) return fail("PROJECT_MCP_CONNECTION_DELEGATION_CONFLICT");
  return now;
}

async function lockConnectionPair(tx: Prisma.TransactionClient, projectId: string, connectionId: string): Promise<void> {
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${connectionId}::text, 32010000))`);
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${projectId}:${connectionId}`}::text, 32010006))`);
}

async function loadDelegation(tx: DelegationDb, projectId: string, delegationId: string): Promise<DelegationRow | null> {
  return tx.projectMcpConnectionDelegation.findFirst({ where: { id: delegationId, projectId }, select: delegationSelect });
}

async function loadProjectRouting(tx: Prisma.TransactionClient, projectId: string) {
  return tx.project.findUnique({ where: { id: projectId }, select: { id: true, workspaceId: true, archivedAt: true } });
}

async function loadDelegationSeed(tx: Prisma.TransactionClient, projectId: string, delegationId: string | null) {
  if (delegationId === null) return null;
  return tx.projectMcpConnectionDelegation.findFirst({ where: { id: delegationId, projectId }, select: { connectionOwnerId: true, mcpConnectionId: true } });
}

async function runLockedMutation<T>(
  db: DelegationDb,
  actor: WebAiActor,
  projectId: string,
  connectionId: string,
  delegationId: string | null,
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  const run = async (tx: Prisma.TransactionClient): Promise<T> => {
    const routing = await loadProjectRouting(tx, projectId);
    if (routing === null) return fail("PROJECT_MCP_CONNECTION_DELEGATION_FORBIDDEN");
    const seed = await loadDelegationSeed(tx, projectId, delegationId);
    await lockActorWorkspaceProjectAccess(tx, {
      actorIds: [actor.id, ...(seed === null ? [] : [seed.connectionOwnerId])],
      workspaceId: routing.workspaceId,
      projectId,
    });
    await lockConnectionPair(tx, projectId, seed?.mcpConnectionId ?? connectionId);
    return operation(tx);
  };
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      if (typeof (db as { $transaction?: unknown }).$transaction !== "function") return await run(db as Prisma.TransactionClient);
      return await (db as PrismaClient).$transaction(run, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (isSerializationConflict(error) && attempt < 3) continue;
      return mapDatabaseError(error);
    }
  }
  return fail("PROJECT_MCP_CONNECTION_DELEGATION_CONFLICT");
}

async function runRead<T>(
  db: PrismaClient,
  actor: WebAiActor,
  projectId: string,
  operation: (tx: Prisma.TransactionClient, admission: ProjectAccessAdmission) => Promise<T>,
): Promise<T> {
  try {
    return await db.$transaction(async (tx) => {
      const admission = await admitWebAiProjectAccess(tx, { actor, projectId, required: "view", allowArchived: true });
      return operation(tx, admission);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  } catch (error) {
    return mapDatabaseError(error);
  }
}

async function currentDirectEditorOrOwner(tx: Prisma.TransactionClient, projectId: string, userId: string): Promise<MembershipEpoch> {
  const membership = await tx.projectMembership.findFirst({
    where: { projectId, userId, accessState: "confirmed", role: { in: ["owner", "editor"] } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, projectId: true, userId: true, role: true, accessState: true, createdAt: true },
  });
  if (membership === null) return fail("PROJECT_MCP_CONNECTION_DELEGATION_MEMBERSHIP_REQUIRED");
  return membership;
}

async function currentDirectProjectOwner(tx: Prisma.TransactionClient, projectId: string, userId: string): Promise<MembershipEpoch> {
  const membership = await tx.projectMembership.findFirst({
    where: { projectId, userId, accessState: "confirmed", role: "owner" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, projectId: true, userId: true, role: true, accessState: true, createdAt: true },
  });
  if (membership === null) return fail("PROJECT_MCP_CONNECTION_DELEGATION_PROJECT_OWNER_REQUIRED");
  return membership;
}

async function frozenOwnerMembership(tx: Prisma.TransactionClient, row: DelegationRow, userId: string): Promise<MembershipEpoch> {
  const membership = await tx.projectMembership.findFirst({
    where: { id: row.ownerProjectMembershipId, projectId: row.projectId, userId, createdAt: row.ownerMembershipCreatedAt },
    select: { id: true, projectId: true, userId: true, role: true, accessState: true, createdAt: true },
  });
  if (membership === null) return fail("PROJECT_MCP_CONNECTION_DELEGATION_MEMBERSHIP_REQUIRED");
  return membership;
}

async function activeActor(tx: Prisma.TransactionClient, actor: WebAiActor): Promise<{ id: string; role: WebAiActor["role"] }> {
  const actorRow = await tx.appUser.findUnique({ where: { id: actor.id }, select: { id: true, role: true, disabledAt: true, accountAccessVersion: true } });
  const currentActor = actorRow === null ? null : { id: actorRow.id, role: actorRow.role, disabledAt: actorRow.disabledAt };
  if (currentActor === null) return fail("PROJECT_MCP_CONNECTION_DELEGATION_FORBIDDEN");
  if (currentActor.disabledAt !== null) return fail("PROJECT_MCP_CONNECTION_DELEGATION_ACCOUNT_DISABLED");
  try {
    await assertAccountAccessForActor(tx, actor);
  } catch (error) {
    if (error instanceof AccountAccessGuardError && error.code === "ACCOUNT_DISABLED") {
      return fail("PROJECT_MCP_CONNECTION_DELEGATION_ACCOUNT_DISABLED");
    }
    return fail("PROJECT_MCP_CONNECTION_DELEGATION_FORBIDDEN");
  }
  return currentActor;
}

function connectionEvidenceCurrent(row: DelegationRow): boolean {
  const connection = row.mcpConnection;
  const credentialValid = connection.authKind === "none"
    ? connection.credential === null && connection.credentialFingerprint === NO_CREDENTIAL_FINGERPRINT
    : connection.authKind === "bearer"
      && connection.credential?.kind === "mcp"
      && connection.credential.secretFingerprint === connection.credentialFingerprint;
  return connection.ownerUserId === row.connectionOwnerId
    && row.connectionOwnerAccountAccessVersion !== null
    && connection.ownerAccountAccessVersion === row.connectionOwnerAccountAccessVersion
    && row.connectionOwner?.accountAccessVersion === row.connectionOwnerAccountAccessVersion
    && connection.ownershipState === "confirmed"
    && connection.status === "verified"
    && connection.disabledAt === null
    && connection.configurationRevision === row.connectionConfigurationRevision
    && connection.resolvedAddressFingerprint === row.resolvedAddressFingerprint
    && connection.credentialFingerprint === row.credentialFingerprint
    && FINGERPRINT_PATTERN.test(connection.resolvedAddressFingerprint ?? "")
    && FINGERPRINT_PATTERN.test(connection.credentialFingerprint)
    && credentialValid;
}

function ownerMembershipCurrent(row: DelegationRow): boolean {
  const membership = row.ownerProjectMembership;
  return membership !== null
    && membership.projectId === row.projectId
    && membership.userId === row.connectionOwnerId
    && (membership.role === "owner" || membership.role === "editor")
    && membership.accessState === "confirmed"
    && membership.createdAt.getTime() === row.ownerMembershipCreatedAt.getTime()
    && membership.user.disabledAt === null
    && row.connectionOwnerAccountAccessVersion !== null
    && membership.user.accountAccessVersion === row.connectionOwnerAccountAccessVersion;
}

function projectOwnerMembershipCurrent(row: DelegationRow): boolean {
  const membership = row.projectConfirmedProjectMembership;
  return row.projectConfirmedById !== null
    && membership !== null
    && membership.projectId === row.projectId
    && membership.userId === row.projectConfirmedById
    && membership.role === "owner"
    && membership.accessState === "confirmed"
    && membership.createdAt.getTime() === row.projectConfirmedMembershipCreatedAt?.getTime()
    && membership.user.disabledAt === null;
}

function effectiveEligibility(row: DelegationRow, now: Date): ProjectMcpConnectionDelegationEffectiveEligibility {
  if (row.status !== "active") return { eligible: false, reason: "NOT_ACTIVE" };
  if (row.expiresAt <= now) return { eligible: false, reason: "EXPIRED" };
  if (row.project.archivedAt !== null) return { eligible: false, reason: "PROJECT_ARCHIVED" };
  if (!connectionEvidenceCurrent(row)) return { eligible: false, reason: "CONNECTION_EVIDENCE_DRIFT" };
  if (!ownerMembershipCurrent(row)) return { eligible: false, reason: "OWNER_MEMBERSHIP_DRIFT" };
  if (!projectOwnerMembershipCurrent(row)) return { eligible: false, reason: "PROJECT_OWNER_MEMBERSHIP_DRIFT" };
  return { eligible: true, reason: null };
}

function publicIdentity(value: { displayName: string | null } | null): { displayName: string } | null {
  return value === null ? null : { displayName: value.displayName?.trim() || "项目成员" };
}

function capabilities(row: DelegationRow, actorId: string, directProjectOwner: boolean, now: Date): ProjectMcpConnectionDelegationCapabilities {
  const ownerActor = row.connectionOwnerId === actorId;
  const ownerActive = row.mcpConnection.ownerUserId === row.connectionOwnerId
    && row.mcpConnection.ownershipState === "confirmed"
    && row.connectionOwner?.disabledAt === null
    && row.connectionOwnerAccountAccessVersion !== null
    && row.mcpConnection.ownerAccountAccessVersion === row.connectionOwnerAccountAccessVersion
    && row.connectionOwner?.accountAccessVersion === row.connectionOwnerAccountAccessVersion;
  const ownerEpoch = ownerMembershipCurrent(row);
  const actorMembership = ownerActor && ownerEpoch;
  const terminalOwnerSafe = ownerActor
    && ownerActive
    && row.status !== "expired";
  const projectTerminalSafe = directProjectOwner
    && row.status !== "expired";
  return Object.freeze({
    canOwnerConfirm: ownerActor && actorMembership && row.project.archivedAt === null && row.expiresAt > now && connectionEvidenceCurrent(row) && row.status === "draft",
    canProjectConfirm: directProjectOwner && row.project.archivedAt === null && row.expiresAt > now && connectionEvidenceCurrent(row) && ownerEpoch && row.status === "ownerConfirmed",
    canReject: (terminalOwnerSafe || projectTerminalSafe) && (row.status === "draft" || row.status === "ownerConfirmed"),
    canRevoke: (terminalOwnerSafe || projectTerminalSafe) && row.status === "active",
  });
}

function delegationView(
  row: DelegationRow,
  actorId: string,
  directProjectOwner: boolean,
  now: Date,
  capabilityOverride?: ProjectMcpConnectionDelegationCapabilities,
  physicalLiveOwnerView = false,
) {
  const ownerVisible = actorId === row.connectionOwnerId;
  const privileged = ownerVisible || directProjectOwner;
  const eligibility = physicalLiveOwnerView
    && row.status !== "expired"
    && row.expiresAt <= now
    ? { eligible: false as const, reason: "EXPIRED" as const }
    : effectiveEligibility(row, now);
  return Object.freeze({
    id: row.id,
    projectId: row.projectId,
    recordStatus: row.status,
    effectiveStatus: eligibility.eligible ? "eligible" : "ineligible",
    effectiveEligibility: eligibility,
    evidenceState: eligibility.reason === null ? "current" : eligibility.reason.toLowerCase(),
    version: row.version,
    expiresAt: row.expiresAt.toISOString(),
    proposedAt: row.proposedAt.toISOString(),
    ownerConfirmedAt: row.ownerConfirmedAt?.toISOString() ?? null,
    projectConfirmedAt: row.projectConfirmedAt?.toISOString() ?? null,
    activatedAt: row.activatedAt?.toISOString() ?? null,
    rejectedAt: row.rejectedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    expiredAt: row.expiredAt?.toISOString() ?? null,
    owner: publicIdentity(row.connectionOwner),
    projectConfirmedBy: publicIdentity(row.projectConfirmedBy),
    terminalReason: privileged ? row.terminalReason : null,
    connection: ownerVisible ? { id: row.mcpConnection.id, name: row.mcpConnection.name } : null,
    mcp: Object.freeze({
      transport: "streamable_http",
      protocol: "MCP Streamable HTTP",
      access: "read_only",
      description: "个人连接的受控、只读 MCP 项目委托（仅控制面，运行时尚未启用）",
    }),
    capabilities: capabilityOverride ?? capabilities(row, actorId, directProjectOwner, now),
  });
}

function canonicalFingerprint(input: Readonly<{
  projectId: string;
  mcpConnectionId: string;
  connectionOwnerId: string;
  expiresAt: Date;
  connectionConfigurationRevision: number;
  resolvedAddressFingerprint: string;
  credentialFingerprint: string;
}>): string {
  return createHash("sha256").update(JSON.stringify({ ...input, expiresAt: input.expiresAt.toISOString() }), "utf8").digest("hex");
}

async function appendAudit(
  tx: Prisma.TransactionClient,
  row: ProjectMcpConnectionDelegation,
  action: ProjectMcpConnectionDelegationAuditAction,
  statusBefore: ProjectMcpConnectionDelegationStatus | null,
  actorKind: ProjectMcpConnectionDelegationActorKind,
  actorId: string | null,
  actorMembershipId: string | null,
  actorMembershipCreatedAt: Date | null,
  reason: string,
): Promise<void> {
  const data = {
    id: randomUUID(),
    projectId: row.projectId,
    mcpConnectionId: row.mcpConnectionId,
    delegationId: row.id,
    connectionOwnerId: row.connectionOwnerId,
    action,
    delegationVersion: row.version,
    statusBefore,
    statusAfter: row.status,
    actorKind,
    actorId,
    actorProjectMembershipId: actorMembershipId,
    actorMembershipCreatedAt,
    terminalActorKind: row.terminalActorKind,
    terminalActorId: row.terminalActorId,
    terminalActorProjectMembershipId: row.terminalActorProjectMembershipId,
    terminalActorMembershipCreatedAt: row.terminalActorMembershipCreatedAt,
    terminalReason: row.terminalReason,
    ownerProjectMembershipId: row.ownerProjectMembershipId,
    ownerMembershipCreatedAt: row.ownerMembershipCreatedAt,
    projectConfirmedProjectMembershipId: row.projectConfirmedProjectMembershipId,
    projectConfirmedMembershipCreatedAt: row.projectConfirmedMembershipCreatedAt,
    expiresAt: row.expiresAt,
    connectionConfigurationRevision: row.connectionConfigurationRevision,
    resolvedAddressFingerprint: row.resolvedAddressFingerprint,
    credentialFingerprint: row.credentialFingerprint,
    connectionOwnerAccountAccessVersion: row.connectionOwnerAccountAccessVersion,
    delegationFingerprint: row.delegationFingerprint,
    reason,
    // Prisma requires a value for this non-null field; the migration's
    // BEFORE INSERT guard replaces it with the database-owned transition
    // timestamp derived from the entity state.
    transitionAt: new Date(0),
  } as unknown as Prisma.ProjectMcpConnectionDelegationAuditUncheckedCreateInput;
  await tx.projectMcpConnectionDelegationAudit.create({
    data,
  });
}

async function expireIfNeeded(tx: Prisma.TransactionClient, row: DelegationRow, now: Date): Promise<DelegationRow | null> {
  if (!(row.status === "draft" || row.status === "ownerConfirmed" || row.status === "active") || row.expiresAt > now) return null;
  const changed = await tx.projectMcpConnectionDelegation.updateMany({
    where: { id: row.id, projectId: row.projectId, version: row.version, status: row.status },
    data: { version: row.version + 1, status: "expired" },
  });
  if (changed.count !== 1) return fail("PROJECT_MCP_CONNECTION_DELEGATION_VERSION_CONFLICT");
  const next = await tx.projectMcpConnectionDelegation.findUniqueOrThrow({ where: { id: row.id } });
  await appendAudit(tx, next, "expired", row.status, "systemExpiry", null, null, null, "system_expiry");
  return loadDelegation(tx, row.projectId, row.id);
}

async function replayIfIdempotent(
  tx: Prisma.TransactionClient,
  row: DelegationRow,
  expectedVersion: number,
  target: ProjectMcpConnectionDelegationStatus,
  actorId: string,
  actorMembershipId: string,
  actorMembershipCreatedAt: Date,
  reason: string,
): Promise<DelegationRow | null> {
  if (row.version !== expectedVersion + 1 || row.status !== target) return null;
  const audit = await tx.projectMcpConnectionDelegationAudit.findUnique({
    where: { delegationId_delegationVersion: { delegationId: row.id, delegationVersion: row.version } },
    select: { action: true, actorKind: true, actorId: true, actorProjectMembershipId: true, actorMembershipCreatedAt: true, terminalReason: true, reason: true },
  });
  const expectedAction = target === "ownerConfirmed" ? "ownerConfirmed" : target === "active" ? "activated" : target === "rejected" ? "rejected" : "revoked";
  if (audit === null || audit.action !== expectedAction || audit.actorKind !== "user" || audit.actorId !== actorId || audit.actorProjectMembershipId !== actorMembershipId || audit.actorMembershipCreatedAt?.getTime() !== actorMembershipCreatedAt.getTime() || audit.reason !== reason || (target === "rejected" || target === "revoked") && audit.terminalReason !== reason) {
    return fail("PROJECT_MCP_CONNECTION_DELEGATION_VERSION_CONFLICT");
  }
  return row;
}

async function loadConnectionForOwner(tx: Prisma.TransactionClient, connectionId: string, ownerId: string) {
  const connection = await tx.mcpConnection.findFirst({
    where: { id: connectionId, ownerUserId: ownerId, ownershipState: "confirmed" },
    select: {
      id: true,
      name: true,
      authKind: true,
      status: true,
      disabledAt: true,
      ownershipState: true,
      ownerUserId: true,
      ownerAccountAccessVersion: true,
      configurationRevision: true,
      resolvedAddressFingerprint: true,
      credentialFingerprint: true,
      credential: { select: { kind: true, secretFingerprint: true } },
      ownerUser: { select: { id: true, disabledAt: true, accountAccessVersion: true } },
    },
  });
  if (connection === null) return fail("PROJECT_MCP_CONNECTION_DELEGATION_CONNECTION_NOT_FOUND");
  return connection;
}

function requireConnectionEvidence(connection: Awaited<ReturnType<typeof loadConnectionForOwner>>) {
  if (
    connection.status !== "verified"
    || connection.disabledAt !== null
    || connection.ownershipState !== "confirmed"
    || connection.ownerUserId === null
    || connection.ownerUser === null
    || connection.ownerUser.disabledAt !== null
    || connection.ownerAccountAccessVersion === null
    || connection.ownerUser.accountAccessVersion !== connection.ownerAccountAccessVersion
    || !FINGERPRINT_PATTERN.test(connection.credentialFingerprint)
    || connection.resolvedAddressFingerprint === null
    || !FINGERPRINT_PATTERN.test(connection.resolvedAddressFingerprint)
    || (connection.authKind === "none" && (connection.credential !== null || connection.credentialFingerprint !== NO_CREDENTIAL_FINGERPRINT))
    || (connection.authKind === "bearer" && (connection.credential?.kind !== "mcp" || connection.credential.secretFingerprint !== connection.credentialFingerprint))
  ) return fail("PROJECT_MCP_CONNECTION_DELEGATION_CONNECTION_UNAVAILABLE");
  return connection;
}

export async function listProjectMcpConnectionDelegations(projectIdInput: string, actor: WebAiActor, db: PrismaClient = getDb()) {
  const projectId = parseUuid(projectIdInput);
  return runRead(db, actor, projectId, async (tx, admission) => {
    const [rows, connections, directMembership] = await Promise.all([
      tx.projectMcpConnectionDelegation.findMany({ where: { projectId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: delegationSelect }),
      tx.mcpConnection.findMany({ where: { ownerUserId: admission.actor.id, ownershipState: "confirmed", status: "verified" }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true, name: true } }),
      tx.projectMembership.findFirst({ where: { projectId, userId: admission.actor.id, accessState: "confirmed", role: { in: ["owner", "editor"] } }, select: { role: true } }),
    ]);
    const now = await databaseNow(tx);
    return Object.freeze({
      connections: connections.map((connection) => Object.freeze(connection)),
      delegations: rows.map((row) => delegationView(row, admission.actor.id, directMembership?.role === "owner", now)),
      capabilities: Object.freeze({ canPropose: admission.project.archivedAt === null && directMembership !== null }),
    });
  });
}

export async function getProjectMcpConnectionDelegation(projectIdInput: string, delegationIdInput: string, actor: WebAiActor, db: PrismaClient = getDb()) {
  const projectId = parseUuid(projectIdInput);
  const delegationId = parseUuid(delegationIdInput);
  return runRead(db, actor, projectId, async (tx, admission) => {
    const row = await loadDelegation(tx, projectId, delegationId);
    if (row === null) return fail("PROJECT_MCP_CONNECTION_DELEGATION_NOT_FOUND");
    const directOwner = await tx.projectMembership.findFirst({ where: { projectId, userId: admission.actor.id, accessState: "confirmed", role: "owner" }, select: { id: true } });
    const now = await databaseNow(tx);
    return delegationView(row, admission.actor.id, directOwner !== null, now);
  });
}

export async function listConnectionOwnerProjectMcpConnectionDelegations(actor: WebAiActor, db: PrismaClient = getDb()) {
  try {
    const current = await db.appUser.findUnique({ where: { id: actor.id }, select: { id: true, role: true, disabledAt: true, accountAccessVersion: true } });
    if (current === null || current.disabledAt !== null) return fail("PROJECT_MCP_CONNECTION_DELEGATION_ACCOUNT_DISABLED");
    try {
      await assertAccountAccessForActor(db, actor);
    } catch (error) {
      if (error instanceof AccountAccessGuardError && error.code === "ACCOUNT_DISABLED") {
        return fail("PROJECT_MCP_CONNECTION_DELEGATION_ACCOUNT_DISABLED");
      }
      return fail("PROJECT_MCP_CONNECTION_DELEGATION_FORBIDDEN");
    }
    const now = await databaseNow(db);
    const rows = await db.projectMcpConnectionDelegation.findMany({
      where: { connectionOwnerId: actor.id, status: { in: ["draft", "ownerConfirmed", "active", "rejected", "revoked", "expired"] }, mcpConnection: { ownerUserId: actor.id, ownershipState: "confirmed" } },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      select: delegationSelect,
    });
    return Object.freeze(rows.map((row) => delegationView(row, actor.id, false, now, undefined, true)));
  } catch (error) {
    return mapDatabaseError(error);
  }
}

export async function proposeProjectMcpConnectionDelegation(projectIdInput: string, input: unknown, actor: WebAiActor, db: DelegationDb = getDb()) {
  const projectId = parseUuid(projectIdInput);
  const parsed = parseInput(proposalSchema, input);
  const connectionId = parseUuid(parsed.mcpConnectionId);
  const expiresAt = parseUtcTimestamp(parsed.expiresAt);
  return runLockedMutation(db, actor, projectId, connectionId, null, async (tx) => {
    const currentActor = await activeActor(tx, actor);
    const project = await loadProjectRouting(tx, projectId);
    if (project === null) return fail("PROJECT_MCP_CONNECTION_DELEGATION_FORBIDDEN");
    if (project.archivedAt !== null) return fail("PROJECT_MCP_CONNECTION_DELEGATION_PROJECT_ARCHIVED");
    const membership = await currentDirectEditorOrOwner(tx, projectId, actor.id);
    const now = await databaseNow(tx);
    if (expiresAt.getTime() < now.getTime() + MIN_EXPIRY_MS || expiresAt.getTime() > now.getTime() + MAX_EXPIRY_MS) return fail("PROJECT_MCP_CONNECTION_DELEGATION_INVALID_INPUT");
    let existing = await tx.projectMcpConnectionDelegation.findFirst({ where: { projectId, mcpConnectionId: connectionId, status: { in: ["draft", "ownerConfirmed", "active"] } }, select: { id: true, delegationFingerprint: true, expiresAt: true } });
    if (existing !== null && existing.expiresAt <= now) {
      const stale = await loadDelegation(tx, projectId, existing.id);
      if (stale === null) return fail("PROJECT_MCP_CONNECTION_DELEGATION_CONFLICT");
      await expireIfNeeded(tx, stale, now);
      existing = await tx.projectMcpConnectionDelegation.findFirst({ where: { projectId, mcpConnectionId: connectionId, status: { in: ["draft", "ownerConfirmed", "active"] } }, select: { id: true, delegationFingerprint: true, expiresAt: true } });
    }
    const connection = requireConnectionEvidence(await loadConnectionForOwner(tx, connectionId, actor.id));
    const fingerprint = canonicalFingerprint({ projectId, mcpConnectionId: connection.id, connectionOwnerId: currentActor.id, expiresAt, connectionConfigurationRevision: connection.configurationRevision, resolvedAddressFingerprint: connection.resolvedAddressFingerprint ?? "", credentialFingerprint: connection.credentialFingerprint });
    if (existing !== null) {
      if (existing.delegationFingerprint !== fingerprint) return fail("PROJECT_MCP_CONNECTION_DELEGATION_CONFLICT");
      const reused = await loadDelegation(tx, projectId, existing.id);
      if (reused === null) return fail("PROJECT_MCP_CONNECTION_DELEGATION_CONFLICT");
      return delegationView(reused, actor.id, membership.role === "owner", now);
    }
    const draft = await tx.projectMcpConnectionDelegation.create({
      data: {
        id: randomUUID(),
        projectId,
        mcpConnectionId: connection.id,
        connectionOwnerId: currentActor.id,
        connectionOwnerAccountAccessVersion: connection.ownerAccountAccessVersion,
        connectionConfigurationRevision: connection.configurationRevision,
        resolvedAddressFingerprint: connection.resolvedAddressFingerprint ?? "",
        credentialFingerprint: connection.credentialFingerprint,
        delegationFingerprint: fingerprint,
        expiresAt,
        ownerProjectMembershipId: membership.id,
        ownerMembershipCreatedAt: membership.createdAt,
        proposedById: currentActor.id,
      },
    });
    const row = await tx.projectMcpConnectionDelegation.findUniqueOrThrow({ where: { id: draft.id } });
    await appendAudit(tx, row, "proposed", null, "user", actor.id, membership.id, membership.createdAt, "proposal_created");
    const reloaded = await loadDelegation(tx, projectId, draft.id);
    if (reloaded === null) return fail("PROJECT_MCP_CONNECTION_DELEGATION_CONFLICT");
    return delegationView(reloaded, actor.id, membership.role === "owner", now);
  });
}

type Transition = "ownerConfirmed" | "active" | "rejected" | "revoked";

async function mutateDelegation(
  projectIdInput: string,
  delegationIdInput: string,
  input: unknown,
  actor: WebAiActor,
  transition: Transition,
  db: DelegationDb,
) {
  const projectId = parseUuid(projectIdInput);
  const delegationId = parseUuid(delegationIdInput);
  const parsed = transition === "ownerConfirmed"
    ? parseInput(ownerConfirmationSchema, input)
    : transition === "active"
      ? parseInput(projectConfirmationSchema, input)
      : parseInput(terminalSchema, input);
  const terminalReason = "reason" in parsed ? parsed.reason : null;
  const result = await runLockedMutation(db, actor, projectId, "00000000-0000-0000-0000-000000000000", delegationId, async (tx) => {
    const current = await loadDelegation(tx, projectId, delegationId);
    if (current === null) {
      // A terminal route intentionally bypasses the global project RBAC
      // middleware for an existing connection owner.  A missing row cannot
      // establish that owner relationship, so an actor without ordinary
      // project visibility must receive the same generic denial as for a
      // guessed existing UUID.  Project viewers may receive NOT_FOUND.
      if (transition === "rejected" || transition === "revoked") {
        await admitWebAiProjectAccess(tx, { actor, projectId, required: "view", allowArchived: true });
      }
      return fail("PROJECT_MCP_CONNECTION_DELEGATION_NOT_FOUND");
    }
    const now = await databaseNow(tx);
    await activeActor(tx, actor);
    const project = await loadProjectRouting(tx, projectId);
    if (project === null) return fail("PROJECT_MCP_CONNECTION_DELEGATION_FORBIDDEN");
    // Lazy expiry is a write.  Establish the same actor/ownership admission
    // as the requested transition before allowing it to commit, especially
    // for terminal routes that intentionally bypass project RBAC.
    if (transition === "ownerConfirmed") {
      if (project.archivedAt !== null) return fail("PROJECT_MCP_CONNECTION_DELEGATION_PROJECT_ARCHIVED");
      const membership = await currentDirectEditorOrOwner(tx, projectId, actor.id);
      if (current.connectionOwnerId !== actor.id
        || membership.id !== current.ownerProjectMembershipId
        || membership.createdAt.getTime() !== current.ownerMembershipCreatedAt.getTime()) {
        return fail("PROJECT_MCP_CONNECTION_DELEGATION_MEMBERSHIP_REQUIRED");
      }
      await loadConnectionForOwner(tx, current.mcpConnectionId, current.connectionOwnerId);
    } else if (transition === "active") {
      if (project.archivedAt !== null) return fail("PROJECT_MCP_CONNECTION_DELEGATION_PROJECT_ARCHIVED");
      await currentDirectProjectOwner(tx, projectId, actor.id);
      await loadConnectionForOwner(tx, current.mcpConnectionId, current.connectionOwnerId);
    } else {
      const ownerTerminal = current.connectionOwnerId === actor.id;
      if (ownerTerminal) {
        await frozenOwnerMembership(tx, current, actor.id);
        await loadConnectionForOwner(tx, current.mcpConnectionId, current.connectionOwnerId);
      } else {
        // Terminal routes bypass the global project RBAC gate so a former
        // connection owner can use the frozen epoch.  Every other actor must
        // first prove ordinary project visibility; otherwise a guessed UUID
        // must not reveal whether a delegation exists or is expired.
        await admitWebAiProjectAccess(tx, { actor, projectId, required: "view", allowArchived: true });
        await currentDirectProjectOwner(tx, projectId, actor.id);
      }
    }
    const expired = await expireIfNeeded(tx, current, now);
    if (expired !== null) return Object.freeze({ expired: true as const });
    const reloaded = await loadDelegation(tx, projectId, delegationId);
    if (reloaded === null) return fail("PROJECT_MCP_CONNECTION_DELEGATION_CONFLICT");
    if (transition === "ownerConfirmed" || transition === "active") {
      if (project.archivedAt !== null) return fail("PROJECT_MCP_CONNECTION_DELEGATION_PROJECT_ARCHIVED");
      if (reloaded.version === parsed.expectedVersion + 1) {
        const membership = transition === "ownerConfirmed"
          ? await currentDirectEditorOrOwner(tx, projectId, actor.id)
          : await currentDirectProjectOwner(tx, projectId, actor.id);
        if (transition === "ownerConfirmed"
          && (membership.id !== reloaded.ownerProjectMembershipId
            || membership.createdAt.getTime() !== reloaded.ownerMembershipCreatedAt.getTime())) {
          return fail("PROJECT_MCP_CONNECTION_DELEGATION_MEMBERSHIP_REQUIRED");
        }
        requireConnectionEvidence(await loadConnectionForOwner(tx, reloaded.mcpConnectionId, reloaded.connectionOwnerId));
        const reason = transition === "ownerConfirmed" ? "owner_confirmation_acknowledged_credential_use" : "project_confirmation_acknowledged_scope_and_data_egress";
        const replay = await replayIfIdempotent(tx, reloaded, parsed.expectedVersion, transition === "ownerConfirmed" ? "ownerConfirmed" : "active", actor.id, transition === "ownerConfirmed" ? reloaded.ownerProjectMembershipId : membership.id, transition === "ownerConfirmed" ? reloaded.ownerMembershipCreatedAt : membership.createdAt, reason);
        if (replay !== null) return delegationView(replay, actor.id, membership.role === "owner", now);
      }
      if (reloaded.version !== parsed.expectedVersion) return fail("PROJECT_MCP_CONNECTION_DELEGATION_VERSION_CONFLICT");
    } else {
      if (reloaded.version === parsed.expectedVersion + 1) {
        const membership = reloaded.connectionOwnerId === actor.id
          ? await frozenOwnerMembership(tx, reloaded, actor.id)
          : await currentDirectProjectOwner(tx, projectId, actor.id);
        await loadConnectionForOwner(tx, reloaded.mcpConnectionId, reloaded.connectionOwnerId);
        if (terminalReason === null) return fail("PROJECT_MCP_CONNECTION_DELEGATION_INVALID_INPUT");
        const replay = await replayIfIdempotent(tx, reloaded, parsed.expectedVersion, transition, actor.id, membership.id, membership.createdAt, terminalReason);
        if (replay !== null) return delegationView(replay, actor.id, membership.role === "owner", now);
      }
      if (reloaded.version !== parsed.expectedVersion) return fail("PROJECT_MCP_CONNECTION_DELEGATION_VERSION_CONFLICT");
    }

    if (transition === "ownerConfirmed") {
      if (reloaded.status !== "draft" || reloaded.connectionOwnerId !== actor.id) return fail("PROJECT_MCP_CONNECTION_DELEGATION_STATE_CONFLICT");
      const membership = await currentDirectEditorOrOwner(tx, projectId, actor.id);
      if (membership.id !== reloaded.ownerProjectMembershipId || membership.createdAt.getTime() !== reloaded.ownerMembershipCreatedAt.getTime()) return fail("PROJECT_MCP_CONNECTION_DELEGATION_MEMBERSHIP_REQUIRED");
      requireConnectionEvidence(await loadConnectionForOwner(tx, reloaded.mcpConnectionId, reloaded.connectionOwnerId));
      const changed = await tx.projectMcpConnectionDelegation.updateMany({
        where: { id: reloaded.id, projectId, version: reloaded.version, status: "draft" },
        data: { version: reloaded.version + 1, status: "ownerConfirmed", ownerConfirmedById: actor.id },
      });
      if (changed.count !== 1) return fail("PROJECT_MCP_CONNECTION_DELEGATION_VERSION_CONFLICT");
      const next = await tx.projectMcpConnectionDelegation.findUniqueOrThrow({ where: { id: reloaded.id } });
      await appendAudit(tx, next, "ownerConfirmed", reloaded.status, "user", actor.id, membership.id, membership.createdAt, "owner_confirmation_acknowledged_credential_use");
      const result = await loadDelegation(tx, projectId, reloaded.id);
      if (result === null) return fail("PROJECT_MCP_CONNECTION_DELEGATION_CONFLICT");
      return delegationView(result, actor.id, membership.role === "owner", now);
    }
    if (transition === "active") {
      if (reloaded.status !== "ownerConfirmed") return fail("PROJECT_MCP_CONNECTION_DELEGATION_STATE_CONFLICT");
      const membership = await currentDirectProjectOwner(tx, projectId, actor.id);
      requireConnectionEvidence(await loadConnectionForOwner(tx, reloaded.mcpConnectionId, reloaded.connectionOwnerId));
      const changed = await tx.projectMcpConnectionDelegation.updateMany({
        where: { id: reloaded.id, projectId, version: reloaded.version, status: "ownerConfirmed" },
        data: { version: reloaded.version + 1, status: "active", projectConfirmedById: actor.id, projectConfirmedProjectMembershipId: membership.id, projectConfirmedMembershipCreatedAt: membership.createdAt },
      });
      if (changed.count !== 1) return fail("PROJECT_MCP_CONNECTION_DELEGATION_VERSION_CONFLICT");
      const next = await tx.projectMcpConnectionDelegation.findUniqueOrThrow({ where: { id: reloaded.id } });
      await appendAudit(tx, next, "activated", reloaded.status, "user", actor.id, membership.id, membership.createdAt, "project_confirmation_acknowledged_scope_and_data_egress");
      const result = await loadDelegation(tx, projectId, reloaded.id);
      if (result === null) return fail("PROJECT_MCP_CONNECTION_DELEGATION_CONFLICT");
      return delegationView(result, actor.id, true, now);
    }
    const ownerTerminal = reloaded.connectionOwnerId === actor.id;
    const membership = ownerTerminal ? await frozenOwnerMembership(tx, reloaded, actor.id) : await currentDirectProjectOwner(tx, projectId, actor.id);
    await loadConnectionForOwner(tx, reloaded.mcpConnectionId, reloaded.connectionOwnerId);
    if (transition === "rejected" && reloaded.status !== "draft" && reloaded.status !== "ownerConfirmed") return fail("PROJECT_MCP_CONNECTION_DELEGATION_STATE_CONFLICT");
    if (transition === "revoked" && reloaded.status !== "active") return fail("PROJECT_MCP_CONNECTION_DELEGATION_STATE_CONFLICT");
    if (terminalReason === null) return fail("PROJECT_MCP_CONNECTION_DELEGATION_INVALID_INPUT");
    const changed = await tx.projectMcpConnectionDelegation.updateMany({
      where: { id: reloaded.id, projectId, version: reloaded.version, status: reloaded.status },
      data: { version: reloaded.version + 1, status: transition, terminalActorId: actor.id, terminalActorProjectMembershipId: membership.id, terminalActorMembershipCreatedAt: membership.createdAt, terminalReason },
    });
    if (changed.count !== 1) return fail("PROJECT_MCP_CONNECTION_DELEGATION_VERSION_CONFLICT");
    const next = await tx.projectMcpConnectionDelegation.findUniqueOrThrow({ where: { id: reloaded.id } });
    await appendAudit(tx, next, transition, reloaded.status, "user", actor.id, membership.id, membership.createdAt, terminalReason);
    const result = await loadDelegation(tx, projectId, reloaded.id);
    if (result === null) return fail("PROJECT_MCP_CONNECTION_DELEGATION_CONFLICT");
    return delegationView(result, actor.id, !ownerTerminal, now);
  });
  if (typeof result === "object" && result !== null && "expired" in result && result.expired === true) {
    return fail("PROJECT_MCP_CONNECTION_DELEGATION_EXPIRED");
  }
  return result;
}

export async function confirmProjectMcpConnectionDelegationOwner(projectId: string, delegationId: string, input: unknown, actor: WebAiActor, db: DelegationDb = getDb()) {
  return mutateDelegation(projectId, delegationId, input, actor, "ownerConfirmed", db);
}

export async function confirmProjectMcpConnectionDelegationProject(projectId: string, delegationId: string, input: unknown, actor: WebAiActor, db: DelegationDb = getDb()) {
  return mutateDelegation(projectId, delegationId, input, actor, "active", db);
}

export async function rejectProjectMcpConnectionDelegation(projectId: string, delegationId: string, input: unknown, actor: WebAiActor, db: DelegationDb = getDb()) {
  return mutateDelegation(projectId, delegationId, input, actor, "rejected", db);
}

export async function revokeProjectMcpConnectionDelegation(projectId: string, delegationId: string, input: unknown, actor: WebAiActor, db: DelegationDb = getDb()) {
  return mutateDelegation(projectId, delegationId, input, actor, "revoked", db);
}
