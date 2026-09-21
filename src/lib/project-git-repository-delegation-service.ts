import { createHash, randomUUID } from "node:crypto";
import {
  Prisma,
  type PrismaClient,
  type ProjectGitRepositoryDelegation,
  type ProjectGitRepositoryDelegationActorKind,
  type ProjectGitRepositoryDelegationAuditAction,
  type ProjectGitRepositoryDelegationStatus,
  type ProjectRepositoryRole,
} from "@prisma/client";
import { z } from "zod";
import { assertAccountAccessForActor } from "@/lib/account-access-guard";
import { getDb } from "@/lib/db";
import {
  admitWebAiProjectAccess,
  lockActorWorkspaceProjectAccess,
  withWebAiProjectAccessTransaction,
  type ProjectAccessAdmission,
  type WebAiActor,
  WebAiAccessError,
} from "@/lib/access-linearization";
import { isSerializationConflict } from "@/lib/project-snapshot-errors";
import {
  canonicalExcludePatterns,
  canonicalIncludeRoots,
  canonicalRepositoryPath,
  canonicalTrackedRef,
  GitSafetyError,
} from "@/lib/git/safety";

const MIN_EXPIRY_MS = 10 * 60 * 1_000;
const MAX_EXPIRY_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_VERSION = 2_147_483_646;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/u;
const uuidSchema = z.string().uuid();
const versionSchema = z.number().int().positive().max(MAX_VERSION);
const utcDateSchema = z.string().datetime({ offset: true }).refine((value) => value.endsWith("Z"), "timestamp must be UTC");
const roleSchema = z.enum(["primary", "application", "infrastructure", "library", "documentation", "other"]);

const proposalSchema = z.object({
  gitConnectionId: uuidSchema,
  repositoryPath: z.string().min(1).max(768),
  trackedRef: z.string().min(1).max(255),
  includeRoots: z.array(z.string()).min(1).max(32),
  softExcludePatterns: z.array(z.string()).max(64),
  role: roleSchema,
  requiredForProjectSnapshot: z.boolean().default(true),
  codeEnabled: z.boolean().default(true),
  metadataEnabled: z.boolean().default(true),
  manualSyncAllowed: z.literal(true).default(true),
  automationAllowed: z.literal(false).default(false),
  expiresAt: utcDateSchema,
}).strict();

const ownerConfirmationSchema = z.object({
  expectedVersion: versionSchema,
  acknowledgeReadOnlyCredentialUse: z.literal(true),
}).strict();

const projectConfirmationSchema = z.object({
  expectedVersion: versionSchema,
  acknowledgeRepositoryScope: z.literal(true),
  acknowledgeDataEgress: z.literal(true),
}).strict();

const terminalSchema = z.object({
  expectedVersion: versionSchema,
  reason: z.string().trim().min(1).max(500),
}).strict();

export type ProjectGitRepositoryDelegationServiceErrorCode =
  | "PROJECT_GIT_REPOSITORY_DELEGATION_INVALID_INPUT"
  | "PROJECT_GIT_REPOSITORY_DELEGATION_NOT_FOUND"
  | "PROJECT_GIT_REPOSITORY_DELEGATION_CONNECTION_NOT_FOUND"
  | "PROJECT_GIT_REPOSITORY_DELEGATION_FORBIDDEN"
  | "PROJECT_GIT_REPOSITORY_DELEGATION_MEMBERSHIP_REQUIRED"
  | "PROJECT_GIT_REPOSITORY_DELEGATION_PROJECT_OWNER_REQUIRED"
  | "PROJECT_GIT_REPOSITORY_DELEGATION_PROJECT_ARCHIVED"
  | "PROJECT_GIT_REPOSITORY_DELEGATION_CONNECTION_UNAVAILABLE"
  | "PROJECT_GIT_REPOSITORY_DELEGATION_STATE_CONFLICT"
  | "PROJECT_GIT_REPOSITORY_DELEGATION_VERSION_CONFLICT"
  | "PROJECT_GIT_REPOSITORY_DELEGATION_CONFLICT"
  | "PROJECT_GIT_REPOSITORY_DELEGATION_EXPIRED";

export class ProjectGitRepositoryDelegationServiceError extends Error {
  constructor(readonly code: ProjectGitRepositoryDelegationServiceErrorCode) {
    super(code);
    this.name = "ProjectGitRepositoryDelegationServiceError";
  }
}

type DelegationDb = PrismaClient | Prisma.TransactionClient;

const delegationSelect = {
  id: true,
  projectId: true,
  gitConnectionId: true,
  connectionOwnerId: true,
  connectionOwnerAccountAccessVersion: true,
  repositoryPath: true,
  trackedRef: true,
  includeRoots: true,
  softExcludePatterns: true,
  role: true,
  requiredForProjectSnapshot: true,
  codeEnabled: true,
  metadataEnabled: true,
  manualSyncAllowed: true,
  automationAllowed: true,
  expiresAt: true,
  connectionConfigurationVersion: true,
  resolvedAddressFingerprint: true,
  credentialFingerprint: true,
  delegationFingerprint: true,
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
  connectionOwner: { select: { displayName: true } },
  ownerConfirmedBy: { select: { displayName: true } },
  projectConfirmedBy: { select: { displayName: true } },
  terminalActor: { select: { displayName: true } },
  gitConnection: {
    select: {
      id: true,
      name: true,
      providerKind: true,
      transport: true,
      status: true,
      ownershipState: true,
      ownerUserId: true,
      configurationVersion: true,
      resolvedAddressFingerprint: true,
      ownerAccountAccessVersion: true,
      credential: { select: { kind: true, secretFingerprint: true } },
    },
  },
} as const;

type DelegationRow = Prisma.ProjectGitRepositoryDelegationGetPayload<{ select: typeof delegationSelect }>;

function fail(code: ProjectGitRepositoryDelegationServiceErrorCode): never {
  throw new ProjectGitRepositoryDelegationServiceError(code);
}

function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) return fail("PROJECT_GIT_REPOSITORY_DELEGATION_INVALID_INPUT");
  return result.data;
}

function parseUuid(value: unknown): string {
  const result = uuidSchema.safeParse(value);
  if (!result.success) return fail("PROJECT_GIT_REPOSITORY_DELEGATION_INVALID_INPUT");
  return result.data.toLowerCase();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "";
}

function isPrismaCode(error: unknown, code: string): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
}

function mapDatabaseError(error: unknown): never {
  if (error instanceof ProjectGitRepositoryDelegationServiceError) throw error;
  if (error instanceof WebAiAccessError) return fail("PROJECT_GIT_REPOSITORY_DELEGATION_FORBIDDEN");
  if (isPrismaCode(error, "P2002") || isPrismaCode(error, "P2025") || isPrismaCode(error, "P2003")) {
    return fail("PROJECT_GIT_REPOSITORY_DELEGATION_CONFLICT");
  }
  if (isSerializationConflict(error)) return fail("PROJECT_GIT_REPOSITORY_DELEGATION_CONFLICT");
  const message = errorMessage(error);
  if (message.includes("PROJECT_GIT_REPOSITORY_DELEGATION_LIVE_EXPIRED")) {
    return fail("PROJECT_GIT_REPOSITORY_DELEGATION_EXPIRED");
  }
  if (message.includes("PROJECT_GIT_REPOSITORY_DELEGATION_LIVE_CONNECTION_INVALID")
    || message.includes("PROJECT_GIT_REPOSITORY_DELEGATION_ACTIVE_CONNECTION_INVALID")) {
    return fail("PROJECT_GIT_REPOSITORY_DELEGATION_CONNECTION_UNAVAILABLE");
  }
  if (message.includes("PROJECT_GIT_REPOSITORY_DELEGATION_LIVE_OWNER_INVALID")
    || message.includes("PROJECT_GIT_REPOSITORY_DELEGATION_ACTIVE_OWNER_INVALID")) {
    return fail("PROJECT_GIT_REPOSITORY_DELEGATION_MEMBERSHIP_REQUIRED");
  }
  if (message.includes("PROJECT_GIT_REPOSITORY_DELEGATION_ACTIVE_PROJECT_OWNER_INVALID")) {
    return fail("PROJECT_GIT_REPOSITORY_DELEGATION_PROJECT_OWNER_REQUIRED");
  }
  if (message.includes("PROJECT_GIT_REPOSITORY_DELEGATION_STATE_INVALID")
    || message.includes("PROJECT_GIT_REPOSITORY_DELEGATION_VERSION_INVALID")) {
    return fail("PROJECT_GIT_REPOSITORY_DELEGATION_STATE_CONFLICT");
  }
  if (message.includes("PROJECT_GIT_REPOSITORY_DELEGATION_")) {
    return fail("PROJECT_GIT_REPOSITORY_DELEGATION_CONFLICT");
  }
  throw error;
}

async function databaseNow(db: Prisma.TransactionClient): Promise<Date> {
  const rows = await db.$queryRaw<Array<{ now: Date | string }>>(Prisma.sql`SELECT clock_timestamp() AS "now"`);
  const value = rows[0]?.now;
  const result = value instanceof Date ? value : new Date(value ?? "");
  if (!Number.isFinite(result.getTime())) return fail("PROJECT_GIT_REPOSITORY_DELEGATION_CONFLICT");
  return result;
}

async function runRead<T>(
  db: PrismaClient,
  actor: WebAiActor,
  projectId: string,
  operation: (tx: Prisma.TransactionClient, admission: ProjectAccessAdmission) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await withWebAiProjectAccessTransaction(db, {
        actor,
        projectId,
        required: "view",
        allowArchived: true,
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      }, operation);
    } catch (error) {
      if (isSerializationConflict(error) && attempt < 3) continue;
      return mapDatabaseError(error);
    }
  }
  return fail("PROJECT_GIT_REPOSITORY_DELEGATION_CONFLICT");
}

async function runMutation<T>(
  db: DelegationDb,
  actor: WebAiActor,
  projectId: string,
  operation: (tx: Prisma.TransactionClient, admission: ProjectAccessAdmission) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await withWebAiProjectAccessTransaction(db, {
        actor,
        projectId,
        required: "edit",
        allowArchived: true,
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      }, async (tx, admission) => {
        if (admission.project.archivedAt !== null) return fail("PROJECT_GIT_REPOSITORY_DELEGATION_PROJECT_ARCHIVED");
        return operation(tx, admission);
      });
    } catch (error) {
      if (isSerializationConflict(error) && attempt < 3) continue;
      return mapDatabaseError(error);
    }
  }
  return fail("PROJECT_GIT_REPOSITORY_DELEGATION_CONFLICT");
}

/**
 * Revocation is the one terminal action that remains available to the
 * personal connection owner after their project membership is revoked.  It
 * uses the same actor -> workspace -> project lock order, then grants only a
 * narrow synthetic admission for this terminal transition.  Project owners
 * still go through the canonical current-membership admission below.
 */
async function runTerminalMutation<T>(
  db: DelegationDb,
  actor: WebAiActor,
  projectId: string,
  delegationId: string,
  operation: (tx: Prisma.TransactionClient, admission: ProjectAccessAdmission) => Promise<T>,
): Promise<T> {
  const run = async (tx: Prisma.TransactionClient): Promise<T> => {
    const located = await tx.project.findUnique({ where: { id: projectId }, select: { id: true, workspaceId: true } });
    if (located === null) return fail("PROJECT_GIT_REPOSITORY_DELEGATION_FORBIDDEN");
    await lockActorWorkspaceProjectAccess(tx, {
      actorIds: [actor.id],
      workspaceId: located.workspaceId,
      projectId,
    });
    const [currentActor, project, delegation] = await Promise.all([
      tx.appUser.findUnique({ where: { id: actor.id }, select: { id: true, role: true, disabledAt: true, accountAccessVersion: true } }),
      tx.project.findUnique({ where: { id: projectId }, select: { id: true, workspaceId: true, archivedAt: true } }),
      tx.projectGitRepositoryDelegation.findFirst({ where: { id: delegationId, projectId }, select: { connectionOwnerId: true } }),
    ]);
    if (currentActor === null || currentActor.disabledAt !== null) return fail("PROJECT_GIT_REPOSITORY_DELEGATION_FORBIDDEN");
    try {
      await assertAccountAccessForActor(tx, actor);
    } catch {
      return fail("PROJECT_GIT_REPOSITORY_DELEGATION_FORBIDDEN");
    }
    if (project === null || project.workspaceId !== located.workspaceId) return fail("PROJECT_GIT_REPOSITORY_DELEGATION_FORBIDDEN");
    if (delegation?.connectionOwnerId !== actor.id) {
      const admission = await admitWebAiProjectAccess(tx, {
        actor,
        projectId,
        required: "edit",
        allowArchived: true,
      });
      if (admission.project.archivedAt !== null) return fail("PROJECT_GIT_REPOSITORY_DELEGATION_PROJECT_ARCHIVED");
      return operation(tx, admission);
    }
    const admission: ProjectAccessAdmission = Object.freeze({
      actor: Object.freeze({ id: currentActor.id, role: currentActor.role, accountAccessVersion: currentActor.accountAccessVersion }),
      workspace: Object.freeze({ id: project.workspaceId }),
      project: Object.freeze({ id: project.id, workspaceId: project.workspaceId, archivedAt: project.archivedAt }),
      permission: "edit",
    });
    return operation(tx, admission);
  };
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      if (typeof (db as { $transaction?: unknown }).$transaction !== "function") return run(db as Prisma.TransactionClient);
      return await (db as PrismaClient).$transaction(run, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (isSerializationConflict(error) && attempt < 3) continue;
      return mapDatabaseError(error);
    }
  }
  return fail("PROJECT_GIT_REPOSITORY_DELEGATION_CONFLICT");
}

async function requireProjectEditorMembership(
  db: Prisma.TransactionClient,
  projectId: string,
  userId: string,
): Promise<{ id: string; createdAt: Date; role: "owner" | "editor" }> {
  const membership = await db.projectMembership.findFirst({
    where: { projectId, userId, accessState: "confirmed", role: { in: ["owner", "editor"] } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, createdAt: true, role: true },
  });
  if (membership === null) return fail("PROJECT_GIT_REPOSITORY_DELEGATION_MEMBERSHIP_REQUIRED");
  return membership as { id: string; createdAt: Date; role: "owner" | "editor" };
}

async function requireProjectMembershipEpoch(
  db: Prisma.TransactionClient,
  projectId: string,
  userId: string,
  membershipId: string,
  membershipCreatedAt: Date,
): Promise<{ id: string; createdAt: Date; role: "owner" | "editor" }> {
  const membership = await db.projectMembership.findFirst({
    where: {
      id: membershipId,
      projectId,
      userId,
      role: { in: ["owner", "editor"] },
      createdAt: membershipCreatedAt,
    },
    select: { id: true, createdAt: true, role: true },
  });
  if (membership === null) return fail("PROJECT_GIT_REPOSITORY_DELEGATION_MEMBERSHIP_REQUIRED");
  return membership as { id: string; createdAt: Date; role: "owner" | "editor" };
}

async function requireProjectOwnerMembership(
  db: Prisma.TransactionClient,
  projectId: string,
  userId: string,
): Promise<{ id: string; createdAt: Date; role: "owner" }> {
  const membership = await db.projectMembership.findFirst({
    where: { projectId, userId, accessState: "confirmed", role: "owner" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, createdAt: true, role: true },
  });
  if (membership === null) return fail("PROJECT_GIT_REPOSITORY_DELEGATION_PROJECT_OWNER_REQUIRED");
  return membership as { id: string; createdAt: Date; role: "owner" };
}

async function loadDelegation(db: DelegationDb, projectId: string, delegationId: string): Promise<DelegationRow | null> {
  return db.projectGitRepositoryDelegation.findFirst({
    where: { id: delegationId, projectId },
    select: delegationSelect,
  });
}

async function loadConnectionForOwner(db: Prisma.TransactionClient, connectionId: string, ownerUserId: string) {
  // Owner and ownership state are part of the predicate.  A foreign id is
  // intentionally indistinguishable from a missing personal connection.
  const connection = await db.gitConnection.findFirst({
    where: { id: connectionId, ownerUserId, ownershipState: "confirmed" },
    select: {
      id: true,
      name: true,
      providerKind: true,
      transport: true,
      status: true,
      ownershipState: true,
      ownerUserId: true,
      ownerAccountAccessVersion: true,
      configurationVersion: true,
      resolvedAddressFingerprint: true,
      credential: { select: { id: true, kind: true, secretFingerprint: true } },
      ownerUser: { select: { disabledAt: true, accountAccessVersion: true } },
    },
  });
  if (connection === null) return fail("PROJECT_GIT_REPOSITORY_DELEGATION_CONNECTION_NOT_FOUND");
  return connection;
}

function requireConnectionEvidence(connection: Awaited<ReturnType<typeof loadConnectionForOwner>>) {
  if (
    connection.status !== "verified"
    || connection.ownershipState !== "confirmed"
    || connection.ownerUserId === null
    || connection.ownerAccountAccessVersion === null
    || connection.ownerUser === null
    || connection.ownerUser.disabledAt !== null
    || connection.ownerUser.accountAccessVersion !== connection.ownerAccountAccessVersion
    || connection.credential === null
    || connection.credential.kind !== "git"
    || connection.resolvedAddressFingerprint === null
    || !FINGERPRINT_PATTERN.test(connection.resolvedAddressFingerprint)
    || !FINGERPRINT_PATTERN.test(connection.credential.secretFingerprint)
  ) return fail("PROJECT_GIT_REPOSITORY_DELEGATION_CONNECTION_UNAVAILABLE");
  return connection as typeof connection & {
    resolvedAddressFingerprint: string;
    credential: NonNullable<typeof connection.credential>;
  };
}

function canonicalFingerprint(input: Readonly<{
  projectId: string;
  gitConnectionId: string;
  connectionOwnerId: string;
  repositoryPath: string;
  trackedRef: string;
  includeRoots: readonly string[];
  softExcludePatterns: readonly string[];
  role: ProjectRepositoryRole;
  requiredForProjectSnapshot: boolean;
  codeEnabled: boolean;
  metadataEnabled: boolean;
  manualSyncAllowed: boolean;
  automationAllowed: boolean;
  expiresAt: Date;
  connectionConfigurationVersion: number;
  resolvedAddressFingerprint: string;
  credentialFingerprint: string;
}>): string {
  return createHash("sha256").update(JSON.stringify({
    ...input,
    expiresAt: input.expiresAt.toISOString(),
  }), "utf8").digest("hex");
}

function publicIdentity(user: { displayName: string | null } | null) {
  return user === null ? null : { displayName: user.displayName?.trim() || "项目成员" };
}

export type ProjectGitRepositoryDelegationCapabilities = Readonly<{
  canOwnerConfirm: boolean;
  canProjectConfirm: boolean;
  canReject: boolean;
  canRevoke: boolean;
  canManualSync: boolean;
}>;

const noDelegationCapabilities: ProjectGitRepositoryDelegationCapabilities = Object.freeze({
  canOwnerConfirm: false,
  canProjectConfirm: false,
  canReject: false,
  canRevoke: false,
  canManualSync: false,
});

type CapabilityContext = Readonly<{
  actorId: string;
  projectArchivedAt: Date | null;
  now: Date;
  explicitMembership: { id: string; createdAt: Date; role: "owner" | "editor" } | null;
  membershipEvidence: ReadonlyMap<string, { id: string; userId: string; createdAt: Date; role: "owner" | "editor"; accessState: string }>;
  userEvidence: ReadonlyMap<string, { id: string; disabledAt: Date | null; accountAccessVersion: number }>;
}>;

function currentConnectionEvidence(row: DelegationRow): boolean {
  const connection = row.gitConnection;
  return connection.ownerUserId === row.connectionOwnerId
    && connection.ownerAccountAccessVersion !== null
    && row.connectionOwnerAccountAccessVersion !== null
    && connection.ownerAccountAccessVersion === row.connectionOwnerAccountAccessVersion
    && connection.ownershipState === "confirmed"
    && connection.status === "verified"
    && connection.configurationVersion === row.connectionConfigurationVersion
    && connection.resolvedAddressFingerprint === row.resolvedAddressFingerprint
    && connection.credential?.kind === "git"
    && connection.credential?.secretFingerprint === row.credentialFingerprint;
}

function delegationCapabilities(row: DelegationRow, context: CapabilityContext): ProjectGitRepositoryDelegationCapabilities {
  const membership = context.explicitMembership;
  const explicitEditor = membership !== null;
  const explicitProjectOwner = membership?.role === "owner";
  const ownerMembership = context.membershipEvidence.get(row.ownerProjectMembershipId);
  const currentOwnerMembership = ownerMembership !== undefined
    && ownerMembership.userId === row.connectionOwnerId
    && ownerMembership.accessState === "confirmed"
    && ownerMembership.createdAt.getTime() === row.ownerMembershipCreatedAt.getTime();
  const ownerEvidence = context.userEvidence.get(row.connectionOwnerId);
  const ownerActorActive = ownerEvidence?.disabledAt === null
    && ownerEvidence.accountAccessVersion === row.connectionOwnerAccountAccessVersion;
  const projectOwnerMembership = row.projectConfirmedProjectMembershipId === null
    ? undefined
    : context.membershipEvidence.get(row.projectConfirmedProjectMembershipId);
  const currentProjectOwnerMembership = row.projectConfirmedById !== null
    && projectOwnerMembership !== undefined
    && projectOwnerMembership.userId === row.projectConfirmedById
    && projectOwnerMembership.role === "owner"
    && projectOwnerMembership.accessState === "confirmed"
    && projectOwnerMembership.createdAt.getTime() === row.projectConfirmedMembershipCreatedAt?.getTime();
  const projectConfirmerActive = row.projectConfirmedById !== null
    && context.userEvidence.get(row.projectConfirmedById)?.disabledAt === null;
  const currentProjectOwner = explicitProjectOwner && context.userEvidence.get(context.actorId)?.disabledAt === null;
  const projectActive = context.projectArchivedAt === null;
  const unexpired = row.expiresAt.getTime() > context.now.getTime();
  const evidenceCurrent = currentConnectionEvidence(row);
  return Object.freeze({
    canOwnerConfirm: projectActive && unexpired && evidenceCurrent && currentOwnerMembership && ownerActorActive && row.connectionOwnerId === context.actorId && row.status === "draft",
    canProjectConfirm: projectActive && unexpired && evidenceCurrent && currentOwnerMembership && ownerActorActive && currentProjectOwner && row.status === "ownerConfirmed",
    canReject: projectActive && ((currentOwnerMembership && ownerActorActive && row.connectionOwnerId === context.actorId) || currentProjectOwner) && (row.status === "draft" || row.status === "ownerConfirmed"),
    canRevoke: projectActive && ((currentOwnerMembership && ownerActorActive && row.connectionOwnerId === context.actorId) || currentProjectOwner) && row.status === "active",
    canManualSync: projectActive && unexpired && evidenceCurrent && explicitEditor && row.status === "active" && row.manualSyncAllowed
      && currentOwnerMembership && ownerActorActive && currentProjectOwnerMembership && projectConfirmerActive,
  });
}

async function loadCapabilityContext(
  db: DelegationDb,
  projectId: string,
  actorId: string,
  projectArchivedAt: Date | null,
  rows: readonly DelegationRow[],
): Promise<CapabilityContext> {
  const membershipIds = [...new Set(rows.flatMap((row) => [row.ownerProjectMembershipId, row.projectConfirmedProjectMembershipId].filter((value): value is string => value !== null)))];
  const userIds = [...new Set(rows.flatMap((row) => [row.connectionOwnerId, row.projectConfirmedById].filter((value): value is string => value !== null)).concat(actorId))];
  const [membership, nowRows, membershipRows, userRows] = await Promise.all([
    db.projectMembership.findFirst({
      where: { projectId, userId: actorId, accessState: "confirmed", role: { in: ["owner", "editor"] } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, createdAt: true, role: true },
    }),
    db.$queryRaw<Array<{ now: Date | string }>>(Prisma.sql`SELECT clock_timestamp() AS "now"`),
    membershipIds.length === 0
      ? Promise.resolve([])
      : db.projectMembership.findMany({ where: { projectId, id: { in: membershipIds } }, select: { id: true, userId: true, createdAt: true, role: true, accessState: true } }),
    userIds.length === 0
      ? Promise.resolve([])
      : db.appUser.findMany({ where: { id: { in: userIds } }, select: { id: true, disabledAt: true, accountAccessVersion: true } }),
  ]);
  const value = nowRows[0]?.now;
  const now = value instanceof Date ? value : new Date(value ?? "");
  if (!Number.isFinite(now.getTime())) return fail("PROJECT_GIT_REPOSITORY_DELEGATION_CONFLICT");
  return Object.freeze({
    actorId,
    projectArchivedAt,
    now,
    explicitMembership: membership === null ? null : membership as { id: string; createdAt: Date; role: "owner" | "editor" },
    membershipEvidence: new Map(membershipRows.map((row) => [row.id, row as { id: string; userId: string; createdAt: Date; role: "owner" | "editor"; accessState: string }])),
    userEvidence: new Map(userRows.map((row) => [row.id, row as { id: string; disabledAt: Date | null; accountAccessVersion: number }])),
  });
}

function delegationView(
  row: DelegationRow,
  actorId: string,
  explicitProjectOwner: boolean,
  capabilities: ProjectGitRepositoryDelegationCapabilities = noDelegationCapabilities,
) {
  const connectionOwnerView = actorId === row.connectionOwnerId;
  const privileged = connectionOwnerView || explicitProjectOwner;
  return Object.freeze({
    id: row.id,
    projectId: row.projectId,
    // A personal connection name is private account metadata. Project scope
    // remains visible, but only its owner receives the connection identity.
    connection: connectionOwnerView
      ? Object.freeze({
          id: row.gitConnection.id,
          name: row.gitConnection.name,
          providerKind: row.gitConnection.providerKind,
          transport: row.gitConnection.transport,
        })
      : null,
    connectionOwner: publicIdentity(row.connectionOwner),
    scope: {
      repositoryPath: row.repositoryPath,
      trackedRef: row.trackedRef,
      includeRoots: row.includeRoots as Prisma.InputJsonValue,
      softExcludePatterns: row.softExcludePatterns as Prisma.InputJsonValue,
      role: row.role,
      requiredForProjectSnapshot: row.requiredForProjectSnapshot,
      codeEnabled: row.codeEnabled,
      metadataEnabled: row.metadataEnabled,
      manualSyncAllowed: row.manualSyncAllowed,
      automationAllowed: row.automationAllowed,
    },
    status: row.status,
    version: row.version,
    expiresAt: row.expiresAt.toISOString(),
    proposedAt: row.proposedAt.toISOString(),
    ownerConfirmedAt: row.ownerConfirmedAt?.toISOString() ?? null,
    projectConfirmedAt: row.projectConfirmedAt?.toISOString() ?? null,
    activatedAt: row.activatedAt?.toISOString() ?? null,
    rejectedAt: row.rejectedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    expiredAt: row.expiredAt?.toISOString() ?? null,
    ownerConfirmedBy: publicIdentity(row.ownerConfirmedBy),
    projectConfirmedBy: publicIdentity(row.projectConfirmedBy),
    terminalReason: privileged ? row.terminalReason : null,
    capabilities,
  });
}

async function appendAudit(
  db: Prisma.TransactionClient,
  row: ProjectGitRepositoryDelegation,
  action: ProjectGitRepositoryDelegationAuditAction,
  statusBefore: ProjectGitRepositoryDelegationStatus | null,
  actorKind: ProjectGitRepositoryDelegationActorKind,
  actorId: string | null,
  actorMembershipId: string | null,
  actorMembershipCreatedAt: Date | null,
  reason: string,
) {
  const transitionAt = action === "proposed"
    ? row.proposedAt
    : action === "ownerConfirmed"
      ? row.ownerConfirmedAt
      : action === "activated"
        ? row.activatedAt
        : action === "rejected"
          ? row.rejectedAt
          : action === "revoked"
            ? row.revokedAt
            : row.expiredAt;
  if (transitionAt === null || transitionAt === undefined) return fail("PROJECT_GIT_REPOSITORY_DELEGATION_CONFLICT");
  await db.projectGitRepositoryDelegationAudit.create({
    data: {
      id: randomUUID(),
      projectId: row.projectId,
      gitConnectionId: row.gitConnectionId,
      delegationId: row.id,
      connectionOwnerId: row.connectionOwnerId,
      connectionOwnerAccountAccessVersion: row.connectionOwnerAccountAccessVersion,
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
      repositoryPath: row.repositoryPath,
      trackedRef: row.trackedRef,
      includeRoots: row.includeRoots as Prisma.InputJsonValue,
      softExcludePatterns: row.softExcludePatterns as Prisma.InputJsonValue,
      role: row.role,
      requiredForProjectSnapshot: row.requiredForProjectSnapshot,
      codeEnabled: row.codeEnabled,
      metadataEnabled: row.metadataEnabled,
      manualSyncAllowed: row.manualSyncAllowed,
      automationAllowed: row.automationAllowed,
      expiresAt: row.expiresAt,
      connectionConfigurationVersion: row.connectionConfigurationVersion,
      resolvedAddressFingerprint: row.resolvedAddressFingerprint,
      credentialFingerprint: row.credentialFingerprint,
      delegationFingerprint: row.delegationFingerprint,
      reason,
      transitionAt,
    },
  });
}

export async function listProjectGitRepositoryDelegations(
  projectIdInput: string,
  actor: WebAiActor,
  db: PrismaClient = getDb(),
) {
  const projectId = parseUuid(projectIdInput);
  return runRead(db, actor, projectId, async (tx, admission) => {
    const [rows, connections] = await Promise.all([
      tx.projectGitRepositoryDelegation.findMany({ where: { projectId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: delegationSelect }),
      tx.gitConnection.findMany({
        where: { ownerUserId: admission.actor.id, ownershipState: "confirmed", status: "verified" },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true, name: true, providerKind: true, transport: true, status: true, ownershipState: true },
      }),
    ]);
    const capabilityContext = await loadCapabilityContext(tx, projectId, admission.actor.id, admission.project.archivedAt, rows);
    const explicitProjectOwner = capabilityContext.explicitMembership?.role === "owner";
    return Object.freeze({
      capabilities: Object.freeze({ canPropose: capabilityContext.projectArchivedAt === null && capabilityContext.explicitMembership !== null }),
      connections: connections.map((connection) => Object.freeze(connection)),
      delegations: rows.map((row) => delegationView(row, admission.actor.id, explicitProjectOwner, delegationCapabilities(row, capabilityContext))),
    });
  });
}

export async function getProjectGitRepositoryDelegation(
  projectIdInput: string,
  delegationIdInput: string,
  actor: WebAiActor,
  db: PrismaClient = getDb(),
) {
  const projectId = parseUuid(projectIdInput);
  const delegationId = parseUuid(delegationIdInput);
  return runRead(db, actor, projectId, async (tx, admission) => {
    const row = await loadDelegation(tx, projectId, delegationId);
    if (row === null) return fail("PROJECT_GIT_REPOSITORY_DELEGATION_NOT_FOUND");
    const capabilityContext = await loadCapabilityContext(tx, projectId, admission.actor.id, admission.project.archivedAt, [row]);
    return delegationView(row, admission.actor.id, capabilityContext.explicitMembership?.role === "owner", delegationCapabilities(row, capabilityContext));
  });
}

const connectionOwnerDelegationSelect = {
  id: true,
  projectId: true,
  repositoryPath: true,
  trackedRef: true,
  manualSyncAllowed: true,
  automationAllowed: true,
  expiresAt: true,
  version: true,
  status: true,
  connectionOwnerId: true,
  connectionOwnerAccountAccessVersion: true,
  ownerProjectMembershipId: true,
  ownerMembershipCreatedAt: true,
  project: { select: { id: true, name: true, archivedAt: true } },
  gitConnection: { select: { id: true, name: true, providerKind: true, transport: true, status: true, ownershipState: true, ownerUserId: true, ownerAccountAccessVersion: true } },
  ownerProjectMembership: { select: { userId: true, createdAt: true } },
} as const;

export async function listConnectionOwnerProjectGitRepositoryDelegations(
  actor: WebAiActor,
  db: PrismaClient = getDb(),
) {
  const currentActor = await db.appUser.findUnique({ where: { id: actor.id }, select: { id: true, disabledAt: true, accountAccessVersion: true } });
  if (currentActor === null || currentActor.disabledAt !== null) return fail("PROJECT_GIT_REPOSITORY_DELEGATION_FORBIDDEN");
  const rows = await db.projectGitRepositoryDelegation.findMany({
    where: {
      connectionOwnerId: actor.id,
      status: { in: ["draft", "ownerConfirmed", "active"] },
      gitConnection: { ownerUserId: actor.id, ownershipState: "confirmed" },
    },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    select: connectionOwnerDelegationSelect,
  });
  return Object.freeze(rows.flatMap((row) => {
    const ownerEpochMatches = row.connectionOwnerId === actor.id
      && row.gitConnection.ownerUserId === actor.id
      && row.connectionOwnerAccountAccessVersion !== null
      && row.gitConnection.ownerAccountAccessVersion === row.connectionOwnerAccountAccessVersion
      && row.connectionOwnerAccountAccessVersion === currentActor.accountAccessVersion
      && row.ownerProjectMembership.userId === actor.id
      && row.ownerProjectMembership.createdAt.getTime() === row.ownerMembershipCreatedAt.getTime();
    if (!ownerEpochMatches) return [];
    return [Object.freeze({
      id: row.id,
      project: Object.freeze({ id: row.project.id, name: row.project.name, archivedAt: row.project.archivedAt?.toISOString() ?? null }),
      connection: Object.freeze({ id: row.gitConnection.id, name: row.gitConnection.name, providerKind: row.gitConnection.providerKind, transport: row.gitConnection.transport, status: row.gitConnection.status, ownershipState: row.gitConnection.ownershipState }),
      scope: Object.freeze({
        repositoryPath: row.repositoryPath,
        trackedRef: row.trackedRef,
        manualSyncAllowed: row.manualSyncAllowed,
        automationAllowed: row.automationAllowed,
      }),
      status: row.status,
      version: row.version,
      expiresAt: row.expiresAt.toISOString(),
      capabilities: Object.freeze({
        canReject: row.status === "draft" || row.status === "ownerConfirmed",
        canRevoke: row.status === "active",
      }),
    })];
  }));
}

export async function proposeProjectGitRepositoryDelegation(
  projectIdInput: string,
  input: unknown,
  actor: WebAiActor,
  db: DelegationDb = getDb(),
) {
  const projectId = parseUuid(projectIdInput);
  const parsed = parseInput(proposalSchema, input);
  const connectionId = parseUuid(parsed.gitConnectionId);
  let repositoryPath: string;
  let trackedRef: string;
  let includeRoots: readonly string[];
  let softExcludePatterns: readonly string[];
  try {
    repositoryPath = canonicalRepositoryPath(parsed.repositoryPath);
    trackedRef = canonicalTrackedRef(parsed.trackedRef);
    includeRoots = canonicalIncludeRoots(parsed.includeRoots);
    softExcludePatterns = canonicalExcludePatterns(parsed.softExcludePatterns);
  } catch (error) {
    if (error instanceof GitSafetyError) return fail("PROJECT_GIT_REPOSITORY_DELEGATION_INVALID_INPUT");
    throw error;
  }
  return runMutation(db, actor, projectId, async (tx, admission) => {
    const membership = await requireProjectEditorMembership(tx, projectId, admission.actor.id);
    const connection = requireConnectionEvidence(await loadConnectionForOwner(tx, connectionId, admission.actor.id));
    const now = await databaseNow(tx);
    const expiresAt = new Date(parsed.expiresAt);
    if (expiresAt.getTime() < now.getTime() + MIN_EXPIRY_MS || expiresAt.getTime() > now.getTime() + MAX_EXPIRY_MS) {
      return fail("PROJECT_GIT_REPOSITORY_DELEGATION_INVALID_INPUT");
    }
    const delegationFingerprint = canonicalFingerprint({
      projectId,
      gitConnectionId: connection.id,
      connectionOwnerId: admission.actor.id,
      repositoryPath,
      trackedRef,
      includeRoots,
      softExcludePatterns,
      role: parsed.role,
      requiredForProjectSnapshot: parsed.requiredForProjectSnapshot,
      codeEnabled: parsed.codeEnabled,
      metadataEnabled: parsed.metadataEnabled,
      manualSyncAllowed: parsed.manualSyncAllowed,
      automationAllowed: parsed.automationAllowed,
      expiresAt,
      connectionConfigurationVersion: connection.configurationVersion,
      resolvedAddressFingerprint: connection.resolvedAddressFingerprint,
      credentialFingerprint: connection.credential.secretFingerprint,
    });
    const draft = await tx.projectGitRepositoryDelegation.create({
      data: {
        id: randomUUID(),
        projectId,
        gitConnectionId: connection.id,
        connectionOwnerId: admission.actor.id,
        connectionOwnerAccountAccessVersion: connection.ownerAccountAccessVersion,
        repositoryPath,
        trackedRef,
        includeRoots,
        softExcludePatterns,
        role: parsed.role,
        requiredForProjectSnapshot: parsed.requiredForProjectSnapshot,
        codeEnabled: parsed.codeEnabled,
        metadataEnabled: parsed.metadataEnabled,
        manualSyncAllowed: parsed.manualSyncAllowed,
        automationAllowed: parsed.automationAllowed,
        expiresAt,
        connectionConfigurationVersion: connection.configurationVersion,
        resolvedAddressFingerprint: connection.resolvedAddressFingerprint,
        credentialFingerprint: connection.credential.secretFingerprint,
        delegationFingerprint,
        ownerProjectMembershipId: membership.id,
        ownerMembershipCreatedAt: membership.createdAt,
        proposedById: admission.actor.id,
      },
    });
    await appendAudit(tx, draft, "proposed", null, "user", admission.actor.id, membership.id, membership.createdAt, "delegation_proposed");
    const row = await loadDelegation(tx, projectId, draft.id);
    if (row === null) return fail("PROJECT_GIT_REPOSITORY_DELEGATION_CONFLICT");
    return delegationView(row, admission.actor.id, membership.role === "owner");
  });
}

async function mutateDelegation(
  projectIdInput: string,
  delegationIdInput: string,
  input: unknown,
  actor: WebAiActor,
  transition: "ownerConfirmed" | "active" | "rejected" | "revoked",
  db: DelegationDb,
) {
  const projectId = parseUuid(projectIdInput);
  const delegationId = parseUuid(delegationIdInput);
  const parsed = transition === "ownerConfirmed"
    ? parseInput(ownerConfirmationSchema, input)
    : transition === "active"
      ? parseInput(projectConfirmationSchema, input)
      : parseInput(terminalSchema, input);
  const expectedVersion = parsed.expectedVersion;
  const operation = async (tx: Prisma.TransactionClient, admission: ProjectAccessAdmission) => {
    const current = await loadDelegation(tx, projectId, delegationId);
    if (current === null) return fail("PROJECT_GIT_REPOSITORY_DELEGATION_NOT_FOUND");
    if (current.version !== expectedVersion) return fail("PROJECT_GIT_REPOSITORY_DELEGATION_VERSION_CONFLICT");
    const now = await databaseNow(tx);
    if (current.expiresAt <= now && transition !== "rejected" && transition !== "revoked") return fail("PROJECT_GIT_REPOSITORY_DELEGATION_EXPIRED");

    if (transition === "ownerConfirmed") {
      if (current.status !== "draft" || current.connectionOwnerId !== admission.actor.id) return fail("PROJECT_GIT_REPOSITORY_DELEGATION_STATE_CONFLICT");
      const membership = await requireProjectEditorMembership(tx, projectId, admission.actor.id);
      if (membership.id !== current.ownerProjectMembershipId || membership.createdAt.getTime() !== current.ownerMembershipCreatedAt.getTime()) {
        return fail("PROJECT_GIT_REPOSITORY_DELEGATION_MEMBERSHIP_REQUIRED");
      }
      requireConnectionEvidence(await loadConnectionForOwner(tx, current.gitConnectionId, admission.actor.id));
      const changed = await tx.projectGitRepositoryDelegation.updateMany({
        where: { id: current.id, version: expectedVersion, status: "draft" },
        data: { version: expectedVersion + 1, status: "ownerConfirmed", ownerConfirmedById: admission.actor.id },
      });
      if (changed.count !== 1) return fail("PROJECT_GIT_REPOSITORY_DELEGATION_VERSION_CONFLICT");
      const next = await tx.projectGitRepositoryDelegation.findUniqueOrThrow({ where: { id: current.id } });
      await appendAudit(tx, next, "ownerConfirmed", current.status, "user", admission.actor.id, membership.id, membership.createdAt, "owner_confirmation_acknowledged_read_only_credential_use");
      const row = await loadDelegation(tx, projectId, current.id);
      if (row === null) return fail("PROJECT_GIT_REPOSITORY_DELEGATION_CONFLICT");
      return delegationView(row, admission.actor.id, membership.role === "owner");
    }

    if (transition === "active") {
      if (current.status !== "ownerConfirmed") return fail("PROJECT_GIT_REPOSITORY_DELEGATION_STATE_CONFLICT");
      const membership = await requireProjectOwnerMembership(tx, projectId, admission.actor.id);
      requireConnectionEvidence(await loadConnectionForOwner(tx, current.gitConnectionId, current.connectionOwnerId));
      const changed = await tx.projectGitRepositoryDelegation.updateMany({
        where: { id: current.id, version: expectedVersion, status: "ownerConfirmed" },
        data: {
          version: expectedVersion + 1,
          status: "active",
          projectConfirmedById: admission.actor.id,
          projectConfirmedProjectMembershipId: membership.id,
          projectConfirmedMembershipCreatedAt: membership.createdAt,
        },
      });
      if (changed.count !== 1) return fail("PROJECT_GIT_REPOSITORY_DELEGATION_VERSION_CONFLICT");
      const next = await tx.projectGitRepositoryDelegation.findUniqueOrThrow({ where: { id: current.id } });
      await appendAudit(tx, next, "activated", current.status, "user", admission.actor.id, membership.id, membership.createdAt, "project_confirmation_acknowledged_repository_scope_and_data_egress");
      const row = await loadDelegation(tx, projectId, current.id);
      if (row === null) return fail("PROJECT_GIT_REPOSITORY_DELEGATION_CONFLICT");
      return delegationView(row, admission.actor.id, true);
    }

    const projectOwnerMembership = await dbProjectOwnerMembership(tx, projectId, admission.actor.id);
    const isConnectionOwner = current.connectionOwnerId === admission.actor.id;
    if (!isConnectionOwner && projectOwnerMembership === null) return fail("PROJECT_GIT_REPOSITORY_DELEGATION_FORBIDDEN");
    const membership = isConnectionOwner
      ? await requireProjectMembershipEpoch(tx, projectId, admission.actor.id, current.ownerProjectMembershipId, current.ownerMembershipCreatedAt)
      : projectOwnerMembership!;
    if (transition === "rejected") {
      if (current.status !== "draft" && current.status !== "ownerConfirmed") return fail("PROJECT_GIT_REPOSITORY_DELEGATION_STATE_CONFLICT");
    } else if (current.status !== "active") {
      return fail("PROJECT_GIT_REPOSITORY_DELEGATION_STATE_CONFLICT");
    }
    const reason = "reason" in parsed ? parsed.reason : fail("PROJECT_GIT_REPOSITORY_DELEGATION_INVALID_INPUT");
    const changed = await tx.projectGitRepositoryDelegation.updateMany({
      where: { id: current.id, version: expectedVersion, status: current.status },
      data: {
        version: expectedVersion + 1,
        status: transition,
        terminalActorId: admission.actor.id,
        terminalActorProjectMembershipId: membership.id,
        terminalActorMembershipCreatedAt: membership.createdAt,
        terminalReason: reason,
      },
    });
    if (changed.count !== 1) return fail("PROJECT_GIT_REPOSITORY_DELEGATION_VERSION_CONFLICT");
    const next = await tx.projectGitRepositoryDelegation.findUniqueOrThrow({ where: { id: current.id } });
    await appendAudit(tx, next, transition, current.status, "user", admission.actor.id, membership.id, membership.createdAt, reason);
    const row = await loadDelegation(tx, projectId, current.id);
    if (row === null) return fail("PROJECT_GIT_REPOSITORY_DELEGATION_CONFLICT");
    return delegationView(row, admission.actor.id, projectOwnerMembership !== null);
  };
  return transition === "revoked" || transition === "rejected"
    ? runTerminalMutation(db, actor, projectId, delegationId, operation)
    : runMutation(db, actor, projectId, operation);
}

async function dbProjectOwnerMembership(db: Prisma.TransactionClient, projectId: string, userId: string) {
  return db.projectMembership.findFirst({
    where: { projectId, userId, accessState: "confirmed", role: "owner" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, createdAt: true, role: true },
  });
}

export async function confirmProjectGitRepositoryDelegationOwner(projectId: string, delegationId: string, input: unknown, actor: WebAiActor, db: DelegationDb = getDb()) {
  return mutateDelegation(projectId, delegationId, input, actor, "ownerConfirmed", db);
}

export async function confirmProjectGitRepositoryDelegationProject(projectId: string, delegationId: string, input: unknown, actor: WebAiActor, db: DelegationDb = getDb()) {
  return mutateDelegation(projectId, delegationId, input, actor, "active", db);
}

export async function rejectProjectGitRepositoryDelegation(projectId: string, delegationId: string, input: unknown, actor: WebAiActor, db: DelegationDb = getDb()) {
  return mutateDelegation(projectId, delegationId, input, actor, "rejected", db);
}

export async function revokeProjectGitRepositoryDelegation(projectId: string, delegationId: string, input: unknown, actor: WebAiActor, db: DelegationDb = getDb()) {
  return mutateDelegation(projectId, delegationId, input, actor, "revoked", db);
}

export type ProjectGitRepositoryDelegationLiveEligibility = Readonly<{
  eligible: boolean;
  reason: "NOT_FOUND" | "NOT_ACTIVE" | "EXPIRED" | "PROJECT_ARCHIVED" | "CONNECTION_DRIFT" | "OWNER_MEMBERSHIP_DRIFT" | "PROJECT_OWNER_MEMBERSHIP_DRIFT" | null;
  status: ProjectGitRepositoryDelegationStatus | null;
  version: number | null;
}>;

/** Internal read-only resolver for a future runtime consumer.  No current Git runtime imports it. */
export async function getProjectGitRepositoryDelegationLiveEligibility(
  projectIdInput: string,
  delegationIdInput: string,
  db: PrismaClient = getDb(),
): Promise<ProjectGitRepositoryDelegationLiveEligibility> {
  const projectId = parseUuid(projectIdInput);
  const delegationId = parseUuid(delegationIdInput);
  const row = await db.projectGitRepositoryDelegation.findFirst({
    where: { id: delegationId, projectId },
    select: {
      status: true,
      version: true,
      expiresAt: true,
      project: { select: { archivedAt: true } },
      connectionOwnerId: true,
      connectionOwnerAccountAccessVersion: true,
      ownerProjectMembershipId: true,
      ownerMembershipCreatedAt: true,
      projectConfirmedById: true,
      projectConfirmedProjectMembershipId: true,
      projectConfirmedMembershipCreatedAt: true,
      gitConnection: {
        select: {
          ownerUserId: true,
          ownerAccountAccessVersion: true,
          ownershipState: true,
          status: true,
          configurationVersion: true,
          resolvedAddressFingerprint: true,
          credential: { select: { kind: true, secretFingerprint: true } },
        },
      },
      connectionConfigurationVersion: true,
      resolvedAddressFingerprint: true,
      credentialFingerprint: true,
    },
  });
  if (row === null) return { eligible: false, reason: "NOT_FOUND", status: null, version: null };
  if (row.status !== "active") return { eligible: false, reason: "NOT_ACTIVE", status: row.status, version: row.version };
  const now = await db.$queryRaw<Array<{ now: Date | string }>>(Prisma.sql`SELECT clock_timestamp() AS "now"`);
  const nowDate = now[0]?.now instanceof Date ? now[0].now : new Date(now[0]?.now ?? "");
  if (row.expiresAt <= nowDate) return { eligible: false, reason: "EXPIRED", status: row.status, version: row.version };
  if (row.project.archivedAt !== null) return { eligible: false, reason: "PROJECT_ARCHIVED", status: row.status, version: row.version };
  const connection = row.gitConnection;
  if (
    connection.ownerUserId !== row.connectionOwnerId
    || connection.ownerAccountAccessVersion === null
    || row.connectionOwnerAccountAccessVersion === null
    || connection.ownerAccountAccessVersion !== row.connectionOwnerAccountAccessVersion
    || connection.ownershipState !== "confirmed"
    || connection.status !== "verified"
    || connection.configurationVersion !== row.connectionConfigurationVersion
    || connection.resolvedAddressFingerprint !== row.resolvedAddressFingerprint
    || connection.credential?.kind !== "git"
    || connection.credential.secretFingerprint !== row.credentialFingerprint
  ) return { eligible: false, reason: "CONNECTION_DRIFT", status: row.status, version: row.version };
  const ownerMembership = await db.projectMembership.findFirst({ where: { id: row.ownerProjectMembershipId }, select: { projectId: true, userId: true, role: true, accessState: true, createdAt: true, user: { select: { disabledAt: true, accountAccessVersion: true } } } });
  if (ownerMembership === null || ownerMembership.projectId !== projectId || ownerMembership.userId !== row.connectionOwnerId || ownerMembership.role !== "owner" && ownerMembership.role !== "editor" || ownerMembership.accessState !== "confirmed" || ownerMembership.createdAt.getTime() !== row.ownerMembershipCreatedAt.getTime() || ownerMembership.user.disabledAt !== null) {
    return { eligible: false, reason: "OWNER_MEMBERSHIP_DRIFT", status: row.status, version: row.version };
  }
  if (ownerMembership.user.accountAccessVersion !== row.connectionOwnerAccountAccessVersion) {
    return { eligible: false, reason: "OWNER_MEMBERSHIP_DRIFT", status: row.status, version: row.version };
  }
  const projectOwnerMembership = await db.projectMembership.findFirst({ where: { id: row.projectConfirmedProjectMembershipId ?? "00000000-0000-0000-0000-000000000000" }, select: { projectId: true, userId: true, role: true, accessState: true, createdAt: true, user: { select: { disabledAt: true } } } });
  if (projectOwnerMembership === null || projectOwnerMembership.projectId !== projectId || projectOwnerMembership.userId !== row.projectConfirmedById || projectOwnerMembership.role !== "owner" || projectOwnerMembership.accessState !== "confirmed" || projectOwnerMembership.createdAt.getTime() !== row.projectConfirmedMembershipCreatedAt?.getTime() || projectOwnerMembership.user.disabledAt !== null) {
    return { eligible: false, reason: "PROJECT_OWNER_MEMBERSHIP_DRIFT", status: row.status, version: row.version };
  }
  return { eligible: true, reason: null, status: row.status, version: row.version };
}

export async function assertProjectGitRepositoryDelegationLive(projectId: string, delegationId: string, db: PrismaClient = getDb()) {
  const result = await getProjectGitRepositoryDelegationLiveEligibility(projectId, delegationId, db);
  if (!result.eligible) {
    if (result.reason === "EXPIRED") return fail("PROJECT_GIT_REPOSITORY_DELEGATION_EXPIRED");
    if (result.reason === "NOT_FOUND") return fail("PROJECT_GIT_REPOSITORY_DELEGATION_NOT_FOUND");
    return fail("PROJECT_GIT_REPOSITORY_DELEGATION_CONNECTION_UNAVAILABLE");
  }
  return result;
}
