import { createHash, randomUUID } from "node:crypto";
import {
  Prisma,
  type PrismaClient,
  type ProjectGitRepositoryAutomationGrantStatus,
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

const uuidSchema = z.string().uuid();
const versionSchema = z.number().int().positive().max(2_147_483_646);
const utcDateSchema = z.string().datetime({ offset: true }).refine((value) => value.endsWith("Z"), "timestamp must be UTC");
const proposalSchema = z.object({
  baseDelegationId: uuidSchema,
  runIntervalMinutes: z.number().int().min(60).max(43_200),
  issuesEnabled: z.boolean().default(false),
  pullRequestsEnabled: z.boolean().default(false),
  releasesEnabled: z.boolean().default(false),
  expiresAt: utcDateSchema,
}).strict();
const ownerConfirmationSchema = z.object({
  expectedVersion: versionSchema,
  acknowledgeReadOnlyScheduledAccess: z.literal(true),
  acknowledgeIssueRead: z.boolean().default(false),
  acknowledgePullRequestRead: z.boolean().default(false),
  acknowledgeReleaseRead: z.boolean().default(false),
}).strict();
const projectActivationSchema = z.object({
  expectedVersion: versionSchema,
  acknowledgeExactRepositoryScope: z.literal(true),
  acknowledgeReadOnlyDataEgress: z.literal(true),
  acknowledgeIssueRead: z.boolean().default(false),
  acknowledgePullRequestRead: z.boolean().default(false),
  acknowledgeReleaseRead: z.boolean().default(false),
}).strict();
const revocationSchema = z.object({
  expectedVersion: versionSchema,
  reason: z.string().trim().min(1).max(500).refine((value) => !/[\u0000-\u001f\u007f-\u009f]/u.test(value)),
}).strict();

export type ProjectGitAutomationGrantErrorCode =
  | "PROJECT_GIT_AUTOMATION_GRANT_INVALID_INPUT"
  | "PROJECT_GIT_AUTOMATION_GRANT_NOT_FOUND"
  | "PROJECT_GIT_AUTOMATION_GRANT_FORBIDDEN"
  | "PROJECT_GIT_AUTOMATION_GRANT_PROJECT_ARCHIVED"
  | "PROJECT_GIT_AUTOMATION_GRANT_BASE_UNAVAILABLE"
  | "PROJECT_GIT_AUTOMATION_GRANT_STATE_CONFLICT"
  | "PROJECT_GIT_AUTOMATION_GRANT_VERSION_CONFLICT"
  | "PROJECT_GIT_AUTOMATION_GRANT_CONFLICT"
  | "PROJECT_GIT_AUTOMATION_GRANT_EXPIRED";

export class ProjectGitAutomationGrantError extends Error {
  constructor(readonly code: ProjectGitAutomationGrantErrorCode) {
    super(code);
    this.name = "ProjectGitAutomationGrantError";
  }
}

type GrantDb = PrismaClient;

const grantSelect = {
  id: true,
  projectId: true,
  gitConnectionId: true,
  baseDelegationId: true,
  connectionOwnerId: true,
  connectionOwnerAccountAccessVersion: true,
  baseDelegationVersion: true,
  baseDelegationFingerprint: true,
  repositoryPath: true,
  trackedRef: true,
  includeRoots: true,
  softExcludePatterns: true,
  runIntervalMinutes: true,
  issuesEnabled: true,
  pullRequestsEnabled: true,
  releasesEnabled: true,
  expiresAt: true,
  grantFingerprint: true,
  version: true,
  status: true,
  proposedById: true,
  proposedProjectMembershipId: true,
  proposedMembershipCreatedAt: true,
  proposedAt: true,
  ownerConfirmedById: true,
  ownerConfirmedProjectMembershipId: true,
  ownerConfirmedMembershipCreatedAt: true,
  ownerConfirmedAt: true,
  projectActivatedById: true,
  projectActivatedMembershipId: true,
  projectActivatedMembershipCreatedAt: true,
  activatedAt: true,
  terminalActorKind: true,
  terminalActorId: true,
  terminalActorProjectMembershipId: true,
  terminalActorMembershipCreatedAt: true,
  terminalReason: true,
  createdAt: true,
  updatedAt: true,
  project: { select: { name: true, archivedAt: true } },
  gitConnection: { select: { name: true, providerKind: true } },
  connectionOwner: { select: { displayName: true } },
} satisfies Prisma.ProjectGitRepositoryAutomationGrantSelect;

type GrantRow = Prisma.ProjectGitRepositoryAutomationGrantGetPayload<{ select: typeof grantSelect }>;

function fail(code: ProjectGitAutomationGrantErrorCode): never {
  throw new ProjectGitAutomationGrantError(code);
}

function parseUuid(value: unknown): string {
  const parsed = uuidSchema.safeParse(value);
  if (!parsed.success) return fail("PROJECT_GIT_AUTOMATION_GRANT_INVALID_INPUT");
  return parsed.data.toLowerCase();
}

function parseBody<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) return fail("PROJECT_GIT_AUTOMATION_GRANT_INVALID_INPUT");
  return parsed.data;
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function mapError(error: unknown): never {
  if (error instanceof ProjectGitAutomationGrantError) throw error;
  if (error instanceof WebAiAccessError) return fail("PROJECT_GIT_AUTOMATION_GRANT_FORBIDDEN");
  if (error instanceof Prisma.PrismaClientKnownRequestError
    && ["P2002", "P2003", "P2025"].includes(error.code)) return fail("PROJECT_GIT_AUTOMATION_GRANT_CONFLICT");
  if (isSerializationConflict(error)) return fail("PROJECT_GIT_AUTOMATION_GRANT_CONFLICT");
  const message = error instanceof Error ? error.message : "";
  if (message.includes("PROJECT_GIT_AUTOMATION_GRANT_EXPIRED")) return fail("PROJECT_GIT_AUTOMATION_GRANT_EXPIRED");
  if (message.includes("PROJECT_GIT_AUTOMATION_GRANT_BASE_DRIFT")) return fail("PROJECT_GIT_AUTOMATION_GRANT_BASE_UNAVAILABLE");
  if (message.includes("PROJECT_GIT_AUTOMATION_GRANT_")) return fail("PROJECT_GIT_AUTOMATION_GRANT_CONFLICT");
  throw error;
}

async function databaseNow(tx: Prisma.TransactionClient): Promise<Date> {
  const rows = await tx.$queryRaw<Array<{ now: Date | string }>>(Prisma.sql`SELECT clock_timestamp() AS "now"`);
  const value = rows[0]?.now;
  const now = value instanceof Date ? value : new Date(value ?? "");
  if (!Number.isFinite(now.getTime())) return fail("PROJECT_GIT_AUTOMATION_GRANT_CONFLICT");
  return now;
}

async function withProjectLock(tx: Prisma.TransactionClient, projectId: string): Promise<void> {
  // Match the project lifecycle lock order, then serialize with manual Git
  // delegation and personal Git connection governance writes.
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${projectId}::text, 23082915))`);
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended('ai-project-git-repository-delegation-global', 0))`);
}

async function runProjectMutation<T>(
  projectId: string,
  actor: WebAiActor,
  operation: (tx: Prisma.TransactionClient, admission: ProjectAccessAdmission) => Promise<T>,
  allowArchived = false,
  db: GrantDb = getDb(),
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
        await withProjectLock(tx, projectId);
        if (!allowArchived && admission.project.archivedAt !== null) return fail("PROJECT_GIT_AUTOMATION_GRANT_PROJECT_ARCHIVED");
        return operation(tx, admission);
      });
    } catch (error) {
      if (isSerializationConflict(error) && attempt < 3) continue;
      return mapError(error);
    }
  }
  return fail("PROJECT_GIT_AUTOMATION_GRANT_CONFLICT");
}

/** The personal connection owner retains only terminal revocation after losing project access. */
async function runTerminalMutation<T>(
  projectId: string,
  grantId: string,
  actor: WebAiActor,
  operation: (tx: Prisma.TransactionClient, admission: ProjectAccessAdmission) => Promise<T>,
  db: GrantDb,
): Promise<T> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await db.$transaction(async (tx) => {
        const located = await tx.project.findUnique({ where: { id: projectId }, select: { id: true, workspaceId: true } });
        if (located === null) return fail("PROJECT_GIT_AUTOMATION_GRANT_FORBIDDEN");
        await lockActorWorkspaceProjectAccess(tx, {
          actorIds: [actor.id],
          workspaceId: located.workspaceId,
          projectId,
        });
        await withProjectLock(tx, projectId);
        const [currentActor, project, grant] = await Promise.all([
          tx.appUser.findUnique({ where: { id: actor.id }, select: { id: true, role: true, disabledAt: true, accountAccessVersion: true } }),
          tx.project.findUnique({ where: { id: projectId }, select: { id: true, workspaceId: true, archivedAt: true } }),
          tx.projectGitRepositoryAutomationGrant.findFirst({ where: { id: grantId, projectId }, select: { connectionOwnerId: true } }),
        ]);
        if (currentActor === null || currentActor.disabledAt !== null || project === null || project.workspaceId !== located.workspaceId) {
          return fail("PROJECT_GIT_AUTOMATION_GRANT_FORBIDDEN");
        }
        try {
          await assertAccountAccessForActor(tx, actor);
        } catch {
          return fail("PROJECT_GIT_AUTOMATION_GRANT_FORBIDDEN");
        }
        if (grant?.connectionOwnerId !== actor.id) {
          const admission = await admitWebAiProjectAccess(tx, { actor, projectId, required: "edit", allowArchived: true });
          return operation(tx, admission);
        }
        const admission: ProjectAccessAdmission = Object.freeze({
          actor: Object.freeze({ id: currentActor.id, role: currentActor.role, accountAccessVersion: currentActor.accountAccessVersion }),
          workspace: Object.freeze({ id: project.workspaceId }),
          project: Object.freeze({ id: project.id, workspaceId: project.workspaceId, archivedAt: project.archivedAt }),
          permission: "edit",
        });
        return operation(tx, admission);
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (isSerializationConflict(error) && attempt < 3) continue;
      return mapError(error);
    }
  }
  return fail("PROJECT_GIT_AUTOMATION_GRANT_CONFLICT");
}

async function currentMembership(
  tx: Prisma.TransactionClient,
  projectId: string,
  userId: string,
  roles: readonly ("owner" | "editor")[],
) {
  return tx.projectMembership.findFirst({
    where: { projectId, userId, accessState: "confirmed", role: { in: [...roles] } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, createdAt: true, role: true },
  });
}

function asJsonArray(value: Prisma.JsonValue): readonly Prisma.JsonValue[] {
  return Array.isArray(value) ? value : [];
}

function sameJson(left: Prisma.JsonValue, right: Prisma.JsonValue): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export type LiveEligibilityReason =
  | "NOT_FOUND"
  | "NOT_ACTIVE"
  | "EXPIRED"
  | "PROJECT_ARCHIVED"
  | "BASE_DELEGATION_DRIFT"
  | "CONNECTION_DRIFT"
  | "OWNER_MEMBERSHIP_DRIFT"
  | "PROJECT_OWNER_MEMBERSHIP_DRIFT"
  | null;

export type LiveEligibility = Readonly<{
  eligible: boolean;
  reason: LiveEligibilityReason;
  status: ProjectGitRepositoryAutomationGrantStatus | null;
  version: number | null;
}>;

export async function liveEligibility(
  tx: Prisma.TransactionClient,
  projectId: string,
  grantId: string,
): Promise<LiveEligibility> {
  const row = await tx.projectGitRepositoryAutomationGrant.findFirst({
    where: { id: grantId, projectId },
    select: {
      projectId: true,
      gitConnectionId: true,
      baseDelegationId: true,
      connectionOwnerId: true,
      connectionOwnerAccountAccessVersion: true,
      baseDelegationVersion: true,
      baseDelegationFingerprint: true,
      repositoryPath: true,
      trackedRef: true,
      includeRoots: true,
      softExcludePatterns: true,
      runIntervalMinutes: true,
      expiresAt: true,
      grantFingerprint: true,
      version: true,
      status: true,
      proposedById: true,
      proposedProjectMembershipId: true,
      proposedMembershipCreatedAt: true,
      ownerConfirmedById: true,
      ownerConfirmedProjectMembershipId: true,
      ownerConfirmedMembershipCreatedAt: true,
      projectActivatedById: true,
      projectActivatedMembershipId: true,
      projectActivatedMembershipCreatedAt: true,
      project: { select: { archivedAt: true } },
      baseDelegation: {
        select: {
          id: true,
          projectId: true,
          gitConnectionId: true,
          connectionOwnerId: true,
          connectionOwnerAccountAccessVersion: true,
          version: true,
          delegationFingerprint: true,
          repositoryPath: true,
          trackedRef: true,
          includeRoots: true,
          softExcludePatterns: true,
          manualSyncAllowed: true,
          automationAllowed: true,
          status: true,
          expiresAt: true,
          ownerProjectMembershipId: true,
          ownerMembershipCreatedAt: true,
          connectionConfigurationVersion: true,
          resolvedAddressFingerprint: true,
          credentialFingerprint: true,
          gitConnection: {
            select: {
              ownerUserId: true,
              ownerAccountAccessVersion: true,
              ownershipState: true,
              status: true,
              configurationVersion: true,
              resolvedAddressFingerprint: true,
              credential: { select: { kind: true, secretFingerprint: true } },
              ownerUser: { select: { disabledAt: true, accountAccessVersion: true } },
            },
          },
        },
      },
    },
  });
  if (row === null) return { eligible: false, reason: "NOT_FOUND", status: null, version: null };
  if (row.status !== "active") return { eligible: false, reason: "NOT_ACTIVE", status: row.status, version: row.version };
  const now = await databaseNow(tx);
  if (row.expiresAt <= now) return { eligible: false, reason: "EXPIRED", status: row.status, version: row.version };
  if (row.project.archivedAt !== null) return { eligible: false, reason: "PROJECT_ARCHIVED", status: row.status, version: row.version };
  const base = row.baseDelegation;
  if (base.status !== "active"
    || base.id !== row.baseDelegationId
    || base.projectId !== projectId
    || base.gitConnectionId !== row.gitConnectionId
    || base.connectionOwnerId !== row.connectionOwnerId
    || base.version !== row.baseDelegationVersion
    || base.delegationFingerprint !== row.baseDelegationFingerprint
    || base.automationAllowed
    || !base.manualSyncAllowed
    || base.expiresAt < row.expiresAt
    || base.repositoryPath !== row.repositoryPath
    || base.trackedRef !== row.trackedRef
    || !sameJson(base.includeRoots, row.includeRoots)
    || !sameJson(base.softExcludePatterns, row.softExcludePatterns)) {
    return { eligible: false, reason: "BASE_DELEGATION_DRIFT", status: row.status, version: row.version };
  }
  const connection = base.gitConnection;
  if (connection.ownerUserId !== row.connectionOwnerId
    || connection.ownerAccountAccessVersion !== row.connectionOwnerAccountAccessVersion
    || connection.ownerAccountAccessVersion !== base.connectionOwnerAccountAccessVersion
    || connection.ownerUser?.disabledAt !== null
    || connection.ownerUser.accountAccessVersion !== row.connectionOwnerAccountAccessVersion
    || connection.ownershipState !== "confirmed"
    || connection.status !== "verified"
    || connection.configurationVersion !== base.connectionConfigurationVersion
    || connection.resolvedAddressFingerprint !== base.resolvedAddressFingerprint
    || connection.credential?.kind !== "git"
    || connection.credential.secretFingerprint !== base.credentialFingerprint) {
    return { eligible: false, reason: "CONNECTION_DRIFT", status: row.status, version: row.version };
  }
  const [proposer, ownerConfirmer, projectActivator] = await Promise.all([
    tx.projectMembership.findFirst({ where: { id: row.proposedProjectMembershipId, projectId, userId: row.proposedById, createdAt: row.proposedMembershipCreatedAt, role: { in: ["owner", "editor"] }, accessState: "confirmed" }, select: { id: true } }),
    row.ownerConfirmedProjectMembershipId === null || row.ownerConfirmedById === null || row.ownerConfirmedMembershipCreatedAt === null
      ? Promise.resolve(null)
      : tx.projectMembership.findFirst({ where: { id: row.ownerConfirmedProjectMembershipId, projectId, userId: row.ownerConfirmedById, createdAt: row.ownerConfirmedMembershipCreatedAt, role: { in: ["owner", "editor"] }, accessState: "confirmed" }, select: { id: true } }),
    row.projectActivatedMembershipId === null || row.projectActivatedById === null || row.projectActivatedMembershipCreatedAt === null
      ? Promise.resolve(null)
      : tx.projectMembership.findFirst({ where: { id: row.projectActivatedMembershipId, projectId, userId: row.projectActivatedById, createdAt: row.projectActivatedMembershipCreatedAt, role: "owner", accessState: "confirmed" }, select: { id: true } }),
  ]);
  if (proposer === null || ownerConfirmer === null) return { eligible: false, reason: "OWNER_MEMBERSHIP_DRIFT", status: row.status, version: row.version };
  if (projectActivator === null) return { eligible: false, reason: "PROJECT_OWNER_MEMBERSHIP_DRIFT", status: row.status, version: row.version };
  const [proposerUser, projectOwner] = await Promise.all([
    tx.appUser.findUnique({ where: { id: row.proposedById }, select: { disabledAt: true } }),
    tx.appUser.findUnique({ where: { id: row.projectActivatedById! }, select: { disabledAt: true } }),
  ]);
  if (proposerUser?.disabledAt !== null || proposerUser === null || proposerUser.disabledAt !== null) {
    return { eligible: false, reason: "OWNER_MEMBERSHIP_DRIFT", status: row.status, version: row.version };
  }
  if (projectOwner?.disabledAt !== null || projectOwner === null || projectOwner.disabledAt !== null) {
    return { eligible: false, reason: "PROJECT_OWNER_MEMBERSHIP_DRIFT", status: row.status, version: row.version };
  }
  return { eligible: true, reason: null, status: row.status, version: row.version };
}

function publicView(row: GrantRow, actorId: string, projectOwner: boolean, readiness: LiveEligibility) {
  return Object.freeze({
    id: row.id,
    project: Object.freeze({ id: row.projectId, name: row.project.name, archivedAt: row.project.archivedAt?.toISOString() ?? null }),
    connection: Object.freeze({ id: row.gitConnectionId, name: row.gitConnection.name, providerKind: row.gitConnection.providerKind }),
    connectionOwner: Object.freeze({ displayName: row.connectionOwner.displayName?.trim() || "项目成员" }),
    baseDelegationId: row.baseDelegationId,
    baseDelegationVersion: row.baseDelegationVersion,
    scope: Object.freeze({
      repositoryPath: row.repositoryPath,
      trackedRef: row.trackedRef,
      includeRoots: asJsonArray(row.includeRoots),
      softExcludePatterns: asJsonArray(row.softExcludePatterns),
    }),
    schedule: Object.freeze({ runIntervalMinutes: row.runIntervalMinutes, expiresAt: row.expiresAt.toISOString() }),
    materialReads: Object.freeze({
      issues: row.issuesEnabled,
      pullRequests: row.pullRequestsEnabled,
      releases: row.releasesEnabled,
    }),
    status: row.status,
    version: row.version,
    proposedAt: row.proposedAt.toISOString(),
    ownerConfirmedAt: row.ownerConfirmedAt?.toISOString() ?? null,
    activatedAt: row.activatedAt?.toISOString() ?? null,
    terminalReason: row.connectionOwnerId === actorId || projectOwner ? row.terminalReason : null,
    readiness,
    capabilities: Object.freeze({
      canConfirmConnectionOwner: row.status === "draft" && row.connectionOwnerId === actorId,
      canActivateProjectOwner: row.status === "ownerConfirmed" && projectOwner,
      canRevoke: ["draft", "ownerConfirmed", "active"].includes(row.status)
        && (row.connectionOwnerId === actorId || projectOwner),
    }),
  });
}

function connectionOwnerSafetyReceipt(row: GrantRow) {
  return Object.freeze({
    id: row.id,
    projectId: row.projectId,
    gitConnectionId: row.gitConnectionId,
    status: row.status,
    version: row.version,
    expiresAt: row.expiresAt.toISOString(),
  });
}

async function viewRow(tx: Prisma.TransactionClient, row: GrantRow, actorId: string) {
  const membership = await currentMembership(tx, row.projectId, actorId, ["owner"]);
  const readiness = await liveEligibility(tx, row.projectId, row.id);
  return publicView(row, actorId, membership !== null, readiness);
}

export async function proposeProjectGitAutomationGrant(
  projectIdInput: string,
  input: unknown,
  actor: WebAiActor,
  db: GrantDb = getDb(),
) {
  const projectId = parseUuid(projectIdInput);
  const parsed = parseBody(proposalSchema, input);
  const baseDelegationId = parseUuid(parsed.baseDelegationId);
  return runProjectMutation(projectId, actor, async (tx, admission) => {
    const proposerMembership = await currentMembership(tx, projectId, admission.actor.id, ["owner", "editor"]);
    if (proposerMembership === null) return fail("PROJECT_GIT_AUTOMATION_GRANT_FORBIDDEN");
    const base = await tx.projectGitRepositoryDelegation.findFirst({
      where: { id: baseDelegationId, projectId },
      select: {
        id: true,
        projectId: true,
        gitConnectionId: true,
        connectionOwnerId: true,
        connectionOwnerAccountAccessVersion: true,
        version: true,
        delegationFingerprint: true,
        repositoryPath: true,
        trackedRef: true,
        includeRoots: true,
        softExcludePatterns: true,
        manualSyncAllowed: true,
        automationAllowed: true,
        status: true,
        expiresAt: true,
        ownerProjectMembershipId: true,
        ownerMembershipCreatedAt: true,
        connectionConfigurationVersion: true,
        resolvedAddressFingerprint: true,
        credentialFingerprint: true,
        gitConnection: {
          select: {
            providerKind: true,
            transport: true,
            authKind: true,
            baseUrl: true,
            ownerUserId: true,
            ownerAccountAccessVersion: true,
            ownershipState: true,
            status: true,
            configurationVersion: true,
            resolvedAddressFingerprint: true,
            credential: { select: { kind: true, secretFingerprint: true } },
            ownerUser: { select: { disabledAt: true, accountAccessVersion: true } },
          },
        },
      },
    });
    if (base === null || base.status !== "active" || !base.manualSyncAllowed || base.automationAllowed) return fail("PROJECT_GIT_AUTOMATION_GRANT_BASE_UNAVAILABLE");
    const connection = base.gitConnection;
    if (base.connectionOwnerAccountAccessVersion === null
      || connection.ownerUserId !== base.connectionOwnerId
      || connection.ownerAccountAccessVersion !== base.connectionOwnerAccountAccessVersion
      || connection.ownerUser?.disabledAt !== null
      || connection.ownerUser.accountAccessVersion !== base.connectionOwnerAccountAccessVersion
      || connection.ownershipState !== "confirmed"
      || connection.status !== "verified"
      || connection.configurationVersion !== base.connectionConfigurationVersion
      || connection.resolvedAddressFingerprint !== base.resolvedAddressFingerprint
      || connection.credential?.kind !== "git"
      || connection.credential.secretFingerprint !== base.credentialFingerprint) return fail("PROJECT_GIT_AUTOMATION_GRANT_BASE_UNAVAILABLE");
    const ownerMembership = await tx.projectMembership.findFirst({
      where: { id: base.ownerProjectMembershipId, projectId, userId: base.connectionOwnerId, createdAt: base.ownerMembershipCreatedAt, role: { in: ["owner", "editor"] }, accessState: "confirmed" },
      select: { id: true },
    });
    if (ownerMembership === null) return fail("PROJECT_GIT_AUTOMATION_GRANT_BASE_UNAVAILABLE");
    const now = await databaseNow(tx);
    const expiresAt = new Date(parsed.expiresAt);
    if (expiresAt <= now) return fail("PROJECT_GIT_AUTOMATION_GRANT_INVALID_INPUT");
    if (expiresAt.getTime() > base.expiresAt.getTime()) return fail("PROJECT_GIT_AUTOMATION_GRANT_INVALID_INPUT");
    if (!Array.isArray(base.includeRoots) || !Array.isArray(base.softExcludePatterns)) return fail("PROJECT_GIT_AUTOMATION_GRANT_BASE_UNAVAILABLE");
    if (parsed.issuesEnabled || parsed.pullRequestsEnabled || parsed.releasesEnabled) {
      let gitHubOrigin: string | null = null;
      try {
        const configured = new URL(base.gitConnection.baseUrl);
        if (configured.protocol === "https:" && configured.username === "" && configured.password === ""
          && configured.search === "" && configured.hash === "" && (configured.pathname === "" || configured.pathname === "/")) {
          gitHubOrigin = configured.origin;
        }
      } catch {
        gitHubOrigin = null;
      }
      if (base.gitConnection.providerKind !== "github"
        || base.gitConnection.transport !== "https"
        || base.gitConnection.authKind !== "token"
        || gitHubOrigin !== "https://github.com"
        || !/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/u.test(base.repositoryPath)) {
        return fail("PROJECT_GIT_AUTOMATION_GRANT_BASE_UNAVAILABLE");
      }
    }
    const grantId = randomUUID();
    const fingerprint = hash({
      grantId,
      projectId,
      gitConnectionId: base.gitConnectionId,
      baseDelegationId: base.id,
      connectionOwnerId: base.connectionOwnerId,
      connectionOwnerAccountAccessVersion: base.connectionOwnerAccountAccessVersion,
      baseDelegationVersion: base.version,
      baseDelegationFingerprint: base.delegationFingerprint,
      repositoryPath: base.repositoryPath,
      trackedRef: base.trackedRef,
      includeRoots: base.includeRoots,
      softExcludePatterns: base.softExcludePatterns,
      runIntervalMinutes: parsed.runIntervalMinutes,
      issuesEnabled: parsed.issuesEnabled,
      pullRequestsEnabled: parsed.pullRequestsEnabled,
      releasesEnabled: parsed.releasesEnabled,
      expiresAt: expiresAt.toISOString(),
    });
    await tx.projectGitRepositoryAutomationGrant.create({
      data: {
        id: grantId,
        projectId,
        gitConnectionId: base.gitConnectionId,
        baseDelegationId: base.id,
        connectionOwnerId: base.connectionOwnerId,
        connectionOwnerAccountAccessVersion: base.connectionOwnerAccountAccessVersion,
        baseDelegationVersion: base.version,
        baseDelegationFingerprint: base.delegationFingerprint,
        repositoryPath: base.repositoryPath,
        trackedRef: base.trackedRef,
        includeRoots: base.includeRoots as Prisma.InputJsonValue,
        softExcludePatterns: base.softExcludePatterns as Prisma.InputJsonValue,
        runIntervalMinutes: parsed.runIntervalMinutes,
        issuesEnabled: parsed.issuesEnabled,
        pullRequestsEnabled: parsed.pullRequestsEnabled,
        releasesEnabled: parsed.releasesEnabled,
        expiresAt,
        grantFingerprint: fingerprint,
        proposedById: admission.actor.id,
        proposedProjectMembershipId: proposerMembership.id,
        proposedMembershipCreatedAt: proposerMembership.createdAt,
      },
      select: { id: true },
    });
    const row = await tx.projectGitRepositoryAutomationGrant.findFirst({ where: { id: grantId, projectId }, select: grantSelect });
    if (row === null) return fail("PROJECT_GIT_AUTOMATION_GRANT_CONFLICT");
    return viewRow(tx, row, admission.actor.id);
  }, false, db);
}

async function mutateGrant(
  projectIdInput: string,
  grantIdInput: string,
  input: unknown,
  actor: WebAiActor,
  transition: "ownerConfirmed" | "active" | "revoked",
  db: GrantDb,
) {
  const projectId = parseUuid(projectIdInput);
  const grantId = parseUuid(grantIdInput);
  const parsed = transition === "ownerConfirmed"
    ? parseBody(ownerConfirmationSchema, input)
    : transition === "active"
      ? parseBody(projectActivationSchema, input)
      : parseBody(revocationSchema, input);
  const operation = async (tx: Prisma.TransactionClient, admission: ProjectAccessAdmission) => {
    const current = await tx.projectGitRepositoryAutomationGrant.findFirst({ where: { id: grantId, projectId }, select: grantSelect });
    if (current === null) return fail("PROJECT_GIT_AUTOMATION_GRANT_NOT_FOUND");
    if (current.version !== parsed.expectedVersion) return fail("PROJECT_GIT_AUTOMATION_GRANT_VERSION_CONFLICT");
    const now = await databaseNow(tx);
    if (current.expiresAt <= now && transition !== "revoked") return fail("PROJECT_GIT_AUTOMATION_GRANT_EXPIRED");

    if (transition !== "revoked") {
      const acknowledgements = parsed as z.infer<typeof ownerConfirmationSchema> & z.infer<typeof projectActivationSchema>;
      if (acknowledgements.acknowledgeIssueRead !== current.issuesEnabled
        || acknowledgements.acknowledgePullRequestRead !== current.pullRequestsEnabled
        || acknowledgements.acknowledgeReleaseRead !== current.releasesEnabled) {
        return fail("PROJECT_GIT_AUTOMATION_GRANT_INVALID_INPUT");
      }
    }

    if (transition === "ownerConfirmed") {
      if (current.status !== "draft" || current.connectionOwnerId !== admission.actor.id) return fail("PROJECT_GIT_AUTOMATION_GRANT_STATE_CONFLICT");
      const membership = await currentMembership(tx, projectId, admission.actor.id, ["owner", "editor"]);
      if (membership === null) return fail("PROJECT_GIT_AUTOMATION_GRANT_FORBIDDEN");
      const user = await tx.appUser.findUnique({ where: { id: admission.actor.id }, select: { disabledAt: true, accountAccessVersion: true } });
      if (user === null || user.disabledAt !== null || user.accountAccessVersion !== current.connectionOwnerAccountAccessVersion) return fail("PROJECT_GIT_AUTOMATION_GRANT_BASE_UNAVAILABLE");
      const updated = await tx.projectGitRepositoryAutomationGrant.updateMany({
        where: { id: grantId, projectId, version: current.version, status: "draft" },
        data: {
          version: current.version + 1,
          status: "ownerConfirmed",
          ownerConfirmedById: admission.actor.id,
          ownerConfirmedProjectMembershipId: membership.id,
          ownerConfirmedMembershipCreatedAt: membership.createdAt,
          ownerConfirmedAt: now,
        },
      });
      if (updated.count !== 1) return fail("PROJECT_GIT_AUTOMATION_GRANT_VERSION_CONFLICT");
    } else if (transition === "active") {
      if (current.status !== "ownerConfirmed") return fail("PROJECT_GIT_AUTOMATION_GRANT_STATE_CONFLICT");
      const membership = await currentMembership(tx, projectId, admission.actor.id, ["owner"]);
      if (membership === null) return fail("PROJECT_GIT_AUTOMATION_GRANT_FORBIDDEN");
      const user = await tx.appUser.findUnique({ where: { id: admission.actor.id }, select: { disabledAt: true } });
      if (user === null || user.disabledAt !== null) return fail("PROJECT_GIT_AUTOMATION_GRANT_FORBIDDEN");
      const updated = await tx.projectGitRepositoryAutomationGrant.updateMany({
        where: { id: grantId, projectId, version: current.version, status: "ownerConfirmed" },
        data: {
          version: current.version + 1,
          status: "active",
          projectActivatedById: admission.actor.id,
          projectActivatedMembershipId: membership.id,
          projectActivatedMembershipCreatedAt: membership.createdAt,
          activatedAt: now,
        },
      });
      if (updated.count !== 1) return fail("PROJECT_GIT_AUTOMATION_GRANT_VERSION_CONFLICT");
    } else {
      if (!("reason" in parsed)) return fail("PROJECT_GIT_AUTOMATION_GRANT_INVALID_INPUT");
      if (!["draft", "ownerConfirmed", "active"].includes(current.status)) return fail("PROJECT_GIT_AUTOMATION_GRANT_STATE_CONFLICT");
      const isConnectionOwner = current.connectionOwnerId === admission.actor.id;
      const projectOwner = await currentMembership(tx, projectId, admission.actor.id, ["owner"]);
      if (!isConnectionOwner && projectOwner === null) return fail("PROJECT_GIT_AUTOMATION_GRANT_FORBIDDEN");
      const membership = isConnectionOwner
        ? await currentMembership(tx, projectId, admission.actor.id, ["owner", "editor"])
        : projectOwner;
      if (membership === null && !isConnectionOwner) return fail("PROJECT_GIT_AUTOMATION_GRANT_FORBIDDEN");
      const updated = await tx.projectGitRepositoryAutomationGrant.updateMany({
        where: { id: grantId, projectId, version: current.version, status: current.status },
        data: {
          version: current.version + 1,
          status: "revoked",
          terminalActorKind: "user",
          terminalActorId: admission.actor.id,
          terminalActorProjectMembershipId: membership?.id ?? null,
          terminalActorMembershipCreatedAt: membership?.createdAt ?? null,
          terminalReason: parsed.reason,
        },
      });
      if (updated.count !== 1) return fail("PROJECT_GIT_AUTOMATION_GRANT_VERSION_CONFLICT");
    }
    const next = await tx.projectGitRepositoryAutomationGrant.findUniqueOrThrow({ where: { id: grantId }, select: grantSelect });
    if (transition === "revoked" && await currentMembership(tx, projectId, admission.actor.id, ["owner", "editor"]) === null) {
      return connectionOwnerSafetyReceipt(next);
    }
    return viewRow(tx, next, admission.actor.id);
  };
  return transition === "revoked"
    ? runTerminalMutation(projectId, grantId, actor, operation, db)
    : runProjectMutation(projectId, actor, operation, false, db);
}

export async function confirmProjectGitAutomationGrantConnectionOwner(projectId: string, grantId: string, input: unknown, actor: WebAiActor, db: GrantDb = getDb()) {
  return mutateGrant(projectId, grantId, input, actor, "ownerConfirmed", db);
}

export async function activateProjectGitAutomationGrantProjectOwner(projectId: string, grantId: string, input: unknown, actor: WebAiActor, db: GrantDb = getDb()) {
  return mutateGrant(projectId, grantId, input, actor, "active", db);
}

export async function revokeProjectGitAutomationGrant(projectId: string, grantId: string, input: unknown, actor: WebAiActor, db: GrantDb = getDb()) {
  return mutateGrant(projectId, grantId, input, actor, "revoked", db);
}

/** Safety view for personal connection owners who may no longer belong to the project. */
export async function listConnectionOwnerProjectGitAutomationGrants(actor: WebAiActor, db: GrantDb = getDb()) {
  try {
    await assertAccountAccessForActor(db, actor);
    const rows = await db.projectGitRepositoryAutomationGrant.findMany({
      where: {
        connectionOwnerId: actor.id,
        status: { in: ["draft", "ownerConfirmed", "active"] },
        gitConnection: { ownerUserId: actor.id, ownershipState: "confirmed" },
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      select: grantSelect,
    });
    return Object.freeze(rows.map(connectionOwnerSafetyReceipt));
  } catch (error) {
    return mapError(error);
  }
}

export async function listProjectGitAutomationGrants(projectIdInput: string, actor: WebAiActor, db: GrantDb = getDb()) {
  const projectId = parseUuid(projectIdInput);
  try {
    return await withWebAiProjectAccessTransaction(db, {
      actor,
      projectId,
      required: "view",
      allowArchived: true,
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    }, async (tx, admission) => {
      const rows = await tx.projectGitRepositoryAutomationGrant.findMany({
        where: { projectId },
        select: grantSelect,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      });
      return Object.freeze({ grants: await Promise.all(rows.map((row) => viewRow(tx, row, admission.actor.id))) });
    });
  } catch (error) {
    return mapError(error);
  }
}

export async function getProjectGitAutomationGrant(projectIdInput: string, grantIdInput: string, actor: WebAiActor, db: GrantDb = getDb()) {
  const projectId = parseUuid(projectIdInput);
  const grantId = parseUuid(grantIdInput);
  try {
    return await withWebAiProjectAccessTransaction(db, {
      actor,
      projectId,
      required: "view",
      allowArchived: true,
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    }, async (tx, admission) => {
      const row = await tx.projectGitRepositoryAutomationGrant.findFirst({ where: { projectId, id: grantId }, select: grantSelect });
      if (row === null) return fail("PROJECT_GIT_AUTOMATION_GRANT_NOT_FOUND");
      return viewRow(tx, row, admission.actor.id);
    });
  } catch (error) {
    return mapError(error);
  }
}
