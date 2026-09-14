import { createHash } from "node:crypto";
import {
  Prisma,
  type PrismaClient,
  type ProjectGitRepositoryManualRunAuditAction,
  type ProjectGitRepositoryManualRunDispatchState,
  type ProjectGitRepositoryManualRunStatus,
  type ProjectRepositoryRole,
} from "@prisma/client";
import { z } from "zod";
import {
  assertPinnedGitEndpoint,
  canonicalExcludePatterns,
  canonicalIncludeRoots,
  canonicalRepositoryPath,
  canonicalTrackedRef,
  GitRunnerError,
  GitSafetyError,
  GitServiceError,
  isDefinitelyPreDispatchGitSyncFailure,
  readGitRepositoryFilesForDelegation,
  type GitConnectionWithSecret,
  type GitScannedFile,
} from "@/lib/git";
import { getDb } from "@/lib/db";
import { lockActorAccess, withWebAiProjectAccessTransaction, type ProjectAccessAdmission } from "@/lib/access-linearization";
import { assertWebAiProjectAccess, type WebAiActor } from "@/lib/web-ai-access";

const UUID = z.string().uuid();
const requestSchema = z.object({ clientRequestKey: UUID }).strict();
const GLOBAL_LOCK_SQL = "ai-project-git-repository-delegation-global";
export const PROJECT_GIT_MANUAL_STALE_AFTER_MS = 5 * 60 * 1000;
const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const PROJECT_GIT_MANUAL_LEGACY_EPOCH_INVALIDATED = "PROJECT_GIT_MANUAL_LEGACY_EPOCH_INVALIDATED";
export const PROJECT_GIT_MANUAL_FINAL_ADMISSION_REJECTED = "PROJECT_GIT_MANUAL_FINAL_ADMISSION_REJECTED";
export const PROJECT_GIT_MANUAL_FINAL_ADMISSION_REJECTED_REASON = "manual_sync_final_admission_rejected";
type DelegationDb = PrismaClient | Prisma.TransactionClient;

export type ProjectDelegatedGitRuntimeErrorCode =
  | "PROJECT_GIT_MANUAL_INVALID_INPUT"
  | "PROJECT_GIT_MANUAL_NOT_FOUND"
  | "PROJECT_GIT_MANUAL_FORBIDDEN"
  | "PROJECT_GIT_MANUAL_MEMBERSHIP_REQUIRED"
  | "PROJECT_GIT_MANUAL_PROJECT_ARCHIVED"
  | "PROJECT_GIT_MANUAL_INELIGIBLE"
  | "PROJECT_GIT_MANUAL_CONNECTION_UNAVAILABLE"
  | "PROJECT_GIT_MANUAL_NETWORK_CHANGED"
  | "PROJECT_GIT_MANUAL_CONFLICT"
  | "PROJECT_GIT_MANUAL_CURSOR_INVALID"
  | "PROJECT_GIT_MANUAL_RECONCILIATION_STATE_CONFLICT"
  | "PROJECT_GIT_MANUAL_RECONCILIATION_CONFLICT"
  | "PROJECT_GIT_MANUAL_RUN_FAILED"
  | "PROJECT_GIT_MANUAL_RUN_UNKNOWN"
  | "PROJECT_GIT_MANUAL_FINAL_ADMISSION_REJECTED";

export class ProjectDelegatedGitRuntimeError extends Error {
  constructor(readonly code: ProjectDelegatedGitRuntimeErrorCode) {
    super(code);
    this.name = "ProjectDelegatedGitRuntimeError";
  }
}

function fail(code: ProjectDelegatedGitRuntimeErrorCode): never {
  throw new ProjectDelegatedGitRuntimeError(code);
}

function isPrismaCode(error: unknown, code: string): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
}

function isSerializationConflict(error: unknown): boolean {
  return isPrismaCode(error, "P2034") || (error instanceof Error && "code" in error && (error as { code?: unknown }).code === "40001");
}

function uuid(value: unknown): string {
  const parsed = UUID.safeParse(value);
  return parsed.success && parsed.data !== NIL_UUID ? parsed.data : fail("PROJECT_GIT_MANUAL_INVALID_INPUT");
}

function deterministicUuid(input: string): string {
  const bytes = Buffer.from(createHash("sha256").update(input, "utf8").digest().subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function safeFailureCode(error: unknown): string {
  if (error instanceof ProjectDelegatedGitRuntimeError) return error.code;
  if (error instanceof GitSafetyError || error instanceof GitRunnerError || error instanceof GitServiceError) return error.code;
  return "PROJECT_GIT_MANUAL_RUN_FAILED";
}

function publicFailureCode(code: string | null): string | null {
  if (code === null) return null;
  return /^[A-Z0-9_]{1,64}$/u.test(code) ? code : "PROJECT_GIT_MANUAL_RUN_FAILED";
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
      throw error;
    }
  }
  return fail("PROJECT_GIT_MANUAL_CONFLICT");
}

const runSelect = {
  id: true,
  projectId: true,
  delegationId: true,
  requestedById: true,
  requestedByAccountAccessVersion: true,
  requestedByProjectMembershipId: true,
  requestedByMembershipCreatedAt: true,
  projectConfirmedById: true,
  clientRequestKey: true,
  status: true,
  stage: true,
  dispatchState: true,
  failureCode: true,
  result: true,
  delegationVersion: true,
  delegationFingerprint: true,
  connectionOwnerId: true,
  connectionOwnerAccountAccessVersion: true,
  ownerProjectMembershipId: true,
  ownerMembershipCreatedAt: true,
  projectConfirmedProjectMembershipId: true,
  projectConfirmedMembershipCreatedAt: true,
  connectionConfigurationVersion: true,
  resolvedAddressFingerprint: true,
  credentialFingerprint: true,
  repositoryPath: true,
  trackedRef: true,
  role: true,
  requiredForProjectSnapshot: true,
  codeEnabled: true,
  metadataEnabled: true,
  manualSyncAllowed: true,
  automationAllowed: true,
  frozenCommitSha: true,
  manifestFingerprint: true,
  fileCount: true,
  decodedTextBytes: true,
  createdAt: true,
  startedAt: true,
  completedAt: true,
} satisfies Prisma.ProjectGitRepositoryManualRunSelect;

type RunRow = Prisma.ProjectGitRepositoryManualRunGetPayload<{ select: typeof runSelect }>;

function publicRun(row: RunRow) {
  return Object.freeze({
    id: row.id,
    projectId: row.projectId,
    delegationId: row.delegationId,
    status: row.status,
    stage: row.stage,
    dispatchState: row.dispatchState,
    failureCode: publicFailureCode(row.failureCode),
    delegationVersion: row.delegationVersion,
    frozenCommitSha: row.frozenCommitSha,
    fileCount: row.fileCount,
    decodedTextBytes: row.decodedTextBytes,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
  });
}

const manualRunHistorySelect = {
  id: true,
  projectId: true,
  delegationId: true,
  status: true,
  stage: true,
  dispatchState: true,
  failureCode: true,
  delegationVersion: true,
  frozenCommitSha: true,
  fileCount: true,
  decodedTextBytes: true,
  createdAt: true,
  startedAt: true,
  completedAt: true,
} satisfies Prisma.ProjectGitRepositoryManualRunSelect;

type ManualRunHistoryRow = Prisma.ProjectGitRepositoryManualRunGetPayload<{ select: typeof manualRunHistorySelect }>;

function publicManualRunHistory(row: ManualRunHistoryRow, acknowledged: boolean) {
  return Object.freeze({
    id: row.id,
    projectId: row.projectId,
    delegationId: row.delegationId,
    status: row.status,
    stage: row.stage,
    dispatchState: row.dispatchState,
    failureCode: publicFailureCode(row.failureCode),
    delegationVersion: row.delegationVersion,
    frozenCommitSha: row.frozenCommitSha,
    fileCount: row.fileCount,
    decodedTextBytes: row.decodedTextBytes,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    acknowledged,
  });
}

const manualRunQuerySchema = z.object({
  cursor: z.string().trim().min(1).max(1024).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
}).strict();

type ManualRunCursor = Readonly<{ projectId: string; delegationId: string; createdAt: string; id: string }>;

function encodeManualRunCursor(cursor: ManualRunCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeManualRunCursor(value: string, projectId: string, delegationId: string): ManualRunCursor {
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<ManualRunCursor>;
    if (decoded.projectId !== projectId || decoded.delegationId !== delegationId
      || typeof decoded.createdAt !== "string" || Number.isNaN(new Date(decoded.createdAt).getTime())
      || typeof decoded.id !== "string" || !UUID.safeParse(decoded.id).success) {
      return fail("PROJECT_GIT_MANUAL_CURSOR_INVALID");
    }
    return { projectId, delegationId, createdAt: decoded.createdAt, id: decoded.id };
  } catch {
    return fail("PROJECT_GIT_MANUAL_CURSOR_INVALID");
  }
}

async function loadManualRunAcknowledgements(
  db: DelegationDb,
  runIds: readonly string[],
): Promise<ReadonlySet<string>> {
  if (runIds.length === 0) return new Set();
  const rows = await db.projectGitRepositoryManualRunReconciliation.findMany({ where: { runId: { in: [...runIds] } }, select: { runId: true } });
  return new Set(rows.map((row) => row.runId));
}

async function canAcknowledgeManualRun(
  db: Prisma.TransactionClient,
  projectId: string,
  actorId: string,
  projectArchivedAt: Date | null,
): Promise<boolean> {
  if (projectArchivedAt !== null) return false;
  const membership = await db.projectMembership.findFirst({
    where: { projectId, userId: actorId, accessState: "confirmed", role: { in: ["owner", "editor"] } },
    select: { id: true },
  });
  return membership !== null;
}

type AdmissionConnection = Readonly<{
  id: string;
  name: string;
  providerKind: GitConnectionWithSecret["providerKind"];
  transport: GitConnectionWithSecret["transport"];
  baseUrl: string;
  authKind: GitConnectionWithSecret["authKind"];
  username: string | null;
  allowPrivateNetwork: boolean;
  tlsCaCertificate: string | null;
  sshKnownHost: string | null;
  status: GitConnectionWithSecret["status"];
  configurationVersion: number;
  resolvedAddressFingerprint: string | null;
  credentialId: string | null;
  ownerUserId: string | null;
  ownerAccountAccessVersion: number | null;
  ownershipState: GitConnectionWithSecret["ownershipState"];
  credential: Readonly<{ id: string; kind: string; secretFingerprint: string }> | null;
}>;

type AdmissionSnapshot = Readonly<{
  projectId: string;
  workspaceId: string;
  requestedById: string;
  requestedByAccountAccessVersion: number;
  requestedByProjectMembershipId: string;
  requestedByMembershipCreatedAt: Date;
  delegationId: string;
  delegationVersion: number;
  delegationFingerprint: string;
  connectionOwnerId: string;
  connectionOwnerAccountAccessVersion: number;
  ownerProjectMembershipId: string;
  ownerMembershipCreatedAt: Date;
  projectConfirmedById: string;
  projectConfirmedProjectMembershipId: string;
  projectConfirmedMembershipCreatedAt: Date;
  connectionConfigurationVersion: number;
  resolvedAddressFingerprint: string;
  credentialFingerprint: string;
  repositoryPath: string;
  trackedRef: string;
  role: ProjectRepositoryRole;
  requiredForProjectSnapshot: boolean;
  codeEnabled: boolean;
  metadataEnabled: boolean;
  includeRoots: readonly string[];
  softExcludePatterns: readonly string[];
  manualSyncAllowed: true;
  automationAllowed: boolean;
  connection: AdmissionConnection;
  pinnedResolution: Readonly<{ addresses: readonly string[]; fingerprint: string }>;
}>;

function assertStoredScope(snapshot: Readonly<{
  repositoryPath: string;
  trackedRef: string;
  includeRoots: unknown;
  softExcludePatterns: unknown;
}>): { repositoryPath: string; trackedRef: string; includeRoots: readonly string[]; softExcludePatterns: readonly string[] } {
  let repositoryPath: string;
  let trackedRef: string;
  let includeRoots: readonly string[];
  let softExcludePatterns: readonly string[];
  try {
    repositoryPath = canonicalRepositoryPath(snapshot.repositoryPath);
    trackedRef = canonicalTrackedRef(snapshot.trackedRef);
    includeRoots = canonicalIncludeRoots(snapshot.includeRoots);
    softExcludePatterns = canonicalExcludePatterns(snapshot.softExcludePatterns);
  } catch {
    return fail("PROJECT_GIT_MANUAL_INELIGIBLE");
  }
  // The runtime is branch-only.  Do not strip refs/heads from an old row,
  // because that would alter the frozen delegation evidence.
  if (trackedRef.startsWith("refs/")) return fail("PROJECT_GIT_MANUAL_INELIGIBLE");
  if (repositoryPath !== snapshot.repositoryPath || trackedRef !== snapshot.trackedRef
    || !jsonEqual(includeRoots, snapshot.includeRoots)
    || !jsonEqual(softExcludePatterns, snapshot.softExcludePatterns)) {
    return fail("PROJECT_GIT_MANUAL_INELIGIBLE");
  }
  return { repositoryPath, trackedRef, includeRoots, softExcludePatterns };
}

function assertConnectionSnapshot(connection: AdmissionConnection, snapshot: AdmissionSnapshot): void {
  if (
    connection.ownerUserId !== snapshot.connectionOwnerId
    || connection.ownerAccountAccessVersion !== snapshot.connectionOwnerAccountAccessVersion
    || connection.ownershipState !== "confirmed"
    || connection.status !== "verified"
    || connection.configurationVersion !== snapshot.connectionConfigurationVersion
    || connection.resolvedAddressFingerprint !== snapshot.resolvedAddressFingerprint
    || connection.credential?.secretFingerprint !== snapshot.credentialFingerprint
    || connection.credential?.kind !== "git"
  ) return fail("PROJECT_GIT_MANUAL_CONNECTION_UNAVAILABLE");
}

async function lockActorWorkspaceProject(
  tx: Prisma.TransactionClient,
  snapshot: Readonly<{ projectId: string; workspaceId: string; actorIds: readonly string[] }>,
): Promise<void> {
  for (const actorId of [...new Set(snapshot.actorIds)].sort()) {
    await lockActorAccess(tx, actorId);
    await tx.$queryRaw`SELECT "id" FROM "AppUser" WHERE "id" = ${actorId}::uuid FOR SHARE`;
  }
  await tx.$queryRaw`SELECT "id" FROM "Workspace" WHERE "id" = ${snapshot.workspaceId}::uuid FOR SHARE`;
  await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${snapshot.projectId}::uuid FOR SHARE`;
}

async function databaseNow(db: PrismaClient | Prisma.TransactionClient): Promise<Date> {
  const rows = await db.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
  const value = rows[0]?.now;
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) return fail("PROJECT_GIT_MANUAL_CONFLICT");
  return value;
}

async function isStaleManualRun(tx: Prisma.TransactionClient, runId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ stale: boolean }>>`
    SELECT (
      "startedAt" IS NULL
      OR "startedAt" <= clock_timestamp() - (${PROJECT_GIT_MANUAL_STALE_AFTER_MS} * interval '1 millisecond')
    ) AS stale
    FROM "ProjectGitRepositoryManualRun"
    WHERE "id" = ${runId}::uuid
  `;
  return rows[0]?.stale === true;
}

async function lockDelegationEvidence(tx: Prisma.TransactionClient, snapshot: AdmissionSnapshot): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${GLOBAL_LOCK_SQL}, 0))`;
  await tx.$queryRaw`SELECT "id" FROM "GitConnection" WHERE "id" = ${snapshot.connection.id}::uuid FOR SHARE`;
  if (snapshot.connection.credentialId !== null) {
    await tx.$queryRaw`SELECT "id" FROM "ExternalCredential" WHERE "id" = ${snapshot.connection.credentialId}::uuid FOR SHARE`;
  }
  await tx.$queryRaw`SELECT "id" FROM "ProjectMembership" WHERE "id" = ${snapshot.ownerProjectMembershipId}::uuid FOR SHARE`;
  await tx.$queryRaw`SELECT "id" FROM "ProjectMembership" WHERE "id" = ${snapshot.projectConfirmedProjectMembershipId}::uuid FOR SHARE`;
  await tx.$queryRaw`SELECT "id" FROM "ProjectMembership" WHERE "id" = ${snapshot.requestedByProjectMembershipId}::uuid FOR SHARE`;
}

async function setAuditContext(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw`SELECT set_config('ai.project_git_manual_runtime_audit', '1', true)`;
}

async function appendAudit(
  tx: Prisma.TransactionClient,
  row: Readonly<{
    id: string;
    projectId: string;
    delegationId: string;
    status: ProjectGitRepositoryManualRunStatus;
    dispatchState: ProjectGitRepositoryManualRunDispatchState;
    delegationVersion: number;
    delegationFingerprint: string;
    connectionConfigurationVersion: number;
    resolvedAddressFingerprint: string;
    credentialFingerprint: string;
    requestedById: string;
    requestedByAccountAccessVersion: number | null;
    requestedByProjectMembershipId: string;
    requestedByMembershipCreatedAt: Date;
    connectionOwnerId: string;
    connectionOwnerAccountAccessVersion: number | null;
    ownerProjectMembershipId: string;
    ownerMembershipCreatedAt: Date;
    projectConfirmedById: string;
    projectConfirmedProjectMembershipId: string;
    projectConfirmedMembershipCreatedAt: Date;
    role: ProjectRepositoryRole;
    requiredForProjectSnapshot: boolean;
    codeEnabled: boolean;
    metadataEnabled: boolean;
    manualSyncAllowed: boolean;
    automationAllowed: boolean;
    frozenCommitSha?: string | null;
    manifestFingerprint?: string | null;
  }>,
  action: ProjectGitRepositoryManualRunAuditAction,
  statusBefore: ProjectGitRepositoryManualRunStatus | null,
  actorId: string | null,
  reason: string,
  auditTime?: Date,
): Promise<void> {
  await tx.projectGitRepositoryManualRunAudit.create({
    data: {
      runId: row.id,
      projectId: row.projectId,
      delegationId: row.delegationId,
      action,
      statusBefore,
      statusAfter: row.status,
      dispatchState: row.dispatchState,
      actorId,
      reason: reason.slice(0, 500),
      requestedById: row.requestedById,
      requestedByAccountAccessVersion: row.requestedByAccountAccessVersion,
      requestedByProjectMembershipId: row.requestedByProjectMembershipId,
      requestedByMembershipCreatedAt: row.requestedByMembershipCreatedAt,
      connectionOwnerId: row.connectionOwnerId,
      connectionOwnerAccountAccessVersion: row.connectionOwnerAccountAccessVersion,
      ownerProjectMembershipId: row.ownerProjectMembershipId,
      ownerMembershipCreatedAt: row.ownerMembershipCreatedAt,
      projectConfirmedById: row.projectConfirmedById,
      projectConfirmedProjectMembershipId: row.projectConfirmedProjectMembershipId,
      projectConfirmedMembershipCreatedAt: row.projectConfirmedMembershipCreatedAt,
      delegationVersion: row.delegationVersion,
      delegationFingerprint: row.delegationFingerprint,
      connectionConfigurationVersion: row.connectionConfigurationVersion,
      resolvedAddressFingerprint: row.resolvedAddressFingerprint,
      credentialFingerprint: row.credentialFingerprint,
      role: row.role,
      requiredForProjectSnapshot: row.requiredForProjectSnapshot,
      codeEnabled: row.codeEnabled,
      metadataEnabled: row.metadataEnabled,
      manualSyncAllowed: row.manualSyncAllowed,
      automationAllowed: row.automationAllowed,
      commitSha: row.frozenCommitSha ?? null,
      manifestFingerprint: row.manifestFingerprint ?? null,
      ...(auditTime === undefined ? {} : { transitionAt: auditTime, createdAt: auditTime }),
    },
  });
}

async function loadAdmissionSnapshot(
  projectId: string,
  delegationId: string,
  actor: WebAiActor,
  db: PrismaClient,
): Promise<AdmissionSnapshot> {
  const currentActor = await assertWebAiProjectAccess(actor, projectId, "edit", db);
  const project = await db.project.findUnique({ where: { id: projectId }, select: { id: true, workspaceId: true, archivedAt: true } });
  if (project === null) return fail("PROJECT_GIT_MANUAL_NOT_FOUND");
  if (project.archivedAt !== null) return fail("PROJECT_GIT_MANUAL_PROJECT_ARCHIVED");
  const membership = await db.projectMembership.findFirst({
    where: { projectId, userId: actor.id, accessState: "confirmed", role: { in: ["owner", "editor"] } },
    select: { id: true, createdAt: true },
  });
  if (membership === null) return fail("PROJECT_GIT_MANUAL_MEMBERSHIP_REQUIRED");
  const delegation = await db.projectGitRepositoryDelegation.findFirst({
    where: { id: delegationId, projectId },
    select: {
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
      projectConfirmedById: true,
      gitConnection: {
        select: {
          id: true,
          name: true,
          providerKind: true,
          transport: true,
          baseUrl: true,
          authKind: true,
          username: true,
          allowPrivateNetwork: true,
          tlsCaCertificate: true,
          sshKnownHost: true,
          status: true,
          configurationVersion: true,
          resolvedAddressFingerprint: true,
          credentialId: true,
          ownerUserId: true,
          ownerAccountAccessVersion: true,
          ownershipState: true,
          credential: { select: { id: true, kind: true, secretFingerprint: true } },
        },
      },
    },
  });
  if (delegation === null) return fail("PROJECT_GIT_MANUAL_NOT_FOUND");
  if (delegation.status !== "active" || !delegation.manualSyncAllowed || delegation.expiresAt.getTime() <= (await databaseNow(db)).getTime()) {
    return fail("PROJECT_GIT_MANUAL_INELIGIBLE");
  }
  if (delegation.projectConfirmedById === null || delegation.projectConfirmedProjectMembershipId === null || delegation.projectConfirmedMembershipCreatedAt === null) {
    return fail("PROJECT_GIT_MANUAL_INELIGIBLE");
  }
  const scope = assertStoredScope(delegation);
  const connection = delegation.gitConnection as AdmissionConnection;
  if (connection.id !== delegation.gitConnectionId || connection.ownerUserId !== delegation.connectionOwnerId) {
    return fail("PROJECT_GIT_MANUAL_CONNECTION_UNAVAILABLE");
  }
  if (delegation.connectionOwnerAccountAccessVersion === null
    || connection.ownerAccountAccessVersion === null
    || connection.ownerAccountAccessVersion !== delegation.connectionOwnerAccountAccessVersion) {
    return fail("PROJECT_GIT_MANUAL_CONNECTION_UNAVAILABLE");
  }
  const connectionOwner = await db.appUser.findUnique({
    where: { id: delegation.connectionOwnerId },
    select: { disabledAt: true, accountAccessVersion: true },
  });
  if (connectionOwner === null || connectionOwner.disabledAt !== null
    || connectionOwner.accountAccessVersion !== delegation.connectionOwnerAccountAccessVersion) {
    return fail("PROJECT_GIT_MANUAL_CONNECTION_UNAVAILABLE");
  }
  if (connection.status !== "verified" || connection.ownershipState !== "confirmed" || connection.credential?.kind !== "git"
    || connection.resolvedAddressFingerprint !== delegation.resolvedAddressFingerprint
    || connection.configurationVersion !== delegation.connectionConfigurationVersion
    || connection.credential.secretFingerprint !== delegation.credentialFingerprint) {
    return fail("PROJECT_GIT_MANUAL_CONNECTION_UNAVAILABLE");
  }
  let pinnedResolution: Readonly<{ addresses: readonly string[]; fingerprint: string }>;
  try {
    pinnedResolution = await assertPinnedGitEndpoint({
      baseUrl: connection.baseUrl,
      allowPrivateNetwork: connection.allowPrivateNetwork,
      expectedFingerprint: delegation.resolvedAddressFingerprint,
    });
  } catch (error) {
    if (error instanceof GitSafetyError && error.code === "GIT_NETWORK_CHANGED") return fail("PROJECT_GIT_MANUAL_NETWORK_CHANGED");
    throw error;
  }
  return Object.freeze({
    projectId,
    workspaceId: project.workspaceId,
    requestedById: actor.id,
    requestedByAccountAccessVersion: currentActor.accountAccessVersion,
    requestedByProjectMembershipId: membership.id,
    requestedByMembershipCreatedAt: membership.createdAt,
    delegationId,
    delegationVersion: delegation.version,
    delegationFingerprint: delegation.delegationFingerprint,
    connectionOwnerId: delegation.connectionOwnerId,
    connectionOwnerAccountAccessVersion: delegation.connectionOwnerAccountAccessVersion,
    ownerProjectMembershipId: delegation.ownerProjectMembershipId,
    ownerMembershipCreatedAt: delegation.ownerMembershipCreatedAt,
    projectConfirmedById: delegation.projectConfirmedById,
    projectConfirmedProjectMembershipId: delegation.projectConfirmedProjectMembershipId,
    projectConfirmedMembershipCreatedAt: delegation.projectConfirmedMembershipCreatedAt,
    connectionConfigurationVersion: delegation.connectionConfigurationVersion,
    resolvedAddressFingerprint: delegation.resolvedAddressFingerprint,
    credentialFingerprint: delegation.credentialFingerprint,
    repositoryPath: scope.repositoryPath,
    trackedRef: scope.trackedRef,
    role: delegation.role,
    requiredForProjectSnapshot: delegation.requiredForProjectSnapshot,
    codeEnabled: delegation.codeEnabled,
    metadataEnabled: delegation.metadataEnabled,
    includeRoots: scope.includeRoots,
    softExcludePatterns: scope.softExcludePatterns,
    manualSyncAllowed: true,
    automationAllowed: delegation.automationAllowed,
    connection,
    pinnedResolution,
  });
}

async function readRunForUpdate(tx: Prisma.TransactionClient, runId: string): Promise<RunRow | null> {
  await tx.$queryRaw`SELECT "id" FROM "ProjectGitRepositoryManualRun" WHERE "id" = ${runId}::uuid FOR UPDATE`;
  return tx.projectGitRepositoryManualRun.findUnique({ where: { id: runId }, select: runSelect });
}

/**
 * Invalidate one pre-epoch run without loading a credential or crossing a
 * network boundary.  The lock order mirrors admission and dispatch: actors,
 * workspace/project, global delegation fence, delegation/connection/
 * credential, memberships, then the run row.  The final update is a state CAS
 * and its audit is appended in the same transaction.
 */
async function reconcileLegacyProjectGitManualRunById(
  runId: string,
  db: PrismaClient,
): Promise<boolean> {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await db.$transaction(async (tx) => {
        const seed = await tx.projectGitRepositoryManualRun.findUnique({
          where: { id: runId },
          select: {
            id: true,
            projectId: true,
            delegationId: true,
            requestedById: true,
            requestedByProjectMembershipId: true,
            connectionOwnerId: true,
            ownerProjectMembershipId: true,
            projectConfirmedById: true,
            projectConfirmedProjectMembershipId: true,
          },
        });
        if (seed === null) return false;
        const project = await tx.project.findUnique({
          where: { id: seed.projectId },
          select: { workspaceId: true },
        });
        if (project === null) return false;

        await lockActorWorkspaceProject(tx, {
          projectId: seed.projectId,
          workspaceId: project.workspaceId,
          actorIds: [seed.requestedById, seed.connectionOwnerId, seed.projectConfirmedById],
        });
        const actors = await tx.appUser.findMany({
          where: { id: { in: [seed.requestedById, seed.connectionOwnerId, seed.projectConfirmedById] } },
          select: { id: true },
        });
        if (actors.length !== new Set([seed.requestedById, seed.connectionOwnerId, seed.projectConfirmedById]).size) return false;

        const delegation = await tx.projectGitRepositoryDelegation.findFirst({
          where: { id: seed.delegationId, projectId: seed.projectId },
          select: { id: true, gitConnectionId: true },
        });
        if (delegation === null) return false;
        const delegationLock = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id"
          FROM "ProjectGitRepositoryDelegation"
          WHERE "id" = ${delegation.id}::uuid AND "projectId" = ${seed.projectId}::uuid
          FOR SHARE
        `;
        if (delegationLock.length !== 1) return false;

        const connection = await tx.gitConnection.findUnique({
          where: { id: delegation.gitConnectionId },
          select: { id: true, credentialId: true },
        });
        if (connection === null) return false;
        const connectionLock = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id"
          FROM "GitConnection"
          WHERE "id" = ${connection.id}::uuid
          FOR SHARE
        `;
        if (connectionLock.length !== 1) return false;
        if (connection.credentialId !== null) {
          const credentialLock = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT "id"
            FROM "ExternalCredential"
            WHERE "id" = ${connection.credentialId}::uuid
            FOR SHARE
          `;
          if (credentialLock.length !== 1) return false;
        }

        const membershipIds = [
          seed.requestedByProjectMembershipId,
          seed.ownerProjectMembershipId,
          seed.projectConfirmedProjectMembershipId,
        ];
        for (const membershipId of [...new Set(membershipIds)].sort()) {
          const membership = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT "id"
            FROM "ProjectMembership"
            WHERE "id" = ${membershipId}::uuid
            FOR SHARE
          `;
          if (membership.length !== 1) return false;
        }

        const current = await readRunForUpdate(tx, runId);
        if (current === null
          || current.projectId !== seed.projectId
          || current.delegationId !== seed.delegationId
          || current.requestedById !== seed.requestedById
          || current.connectionOwnerId !== seed.connectionOwnerId
          || current.ownerProjectMembershipId !== seed.ownerProjectMembershipId
          || current.projectConfirmedById !== seed.projectConfirmedById
          || current.projectConfirmedProjectMembershipId !== seed.projectConfirmedProjectMembershipId
          || current.requestedByAccountAccessVersion !== null
          || current.connectionOwnerAccountAccessVersion !== null
          || current.result !== null
          || current.frozenCommitSha !== null
          || current.manifestFingerprint !== null
          || current.fileCount !== 0
          || current.decodedTextBytes !== 0) return false;

        const chainRows = await tx.$queryRaw<Array<{ valid: boolean | null }>>`
          SELECT "personal_git_manual_run_legacy_chain_valid"(run_row) AS valid
          FROM "ProjectGitRepositoryManualRun" run_row
          WHERE run_row."id" = ${runId}::uuid
        `;
        if (chainRows[0]?.valid !== true) return false;

        let terminalStatus: "failed" | "unknown";
        let terminalDispatchState: "acknowledged" | "dispatched";
        if (current.status === "queued"
          && current.stage === "queued"
          && current.dispatchState === "pending"
          && current.startedAt === null) {
          terminalStatus = "failed";
          terminalDispatchState = "acknowledged";
        } else if (current.status === "running"
          && current.stage === "admitted"
          && current.dispatchState === "pending"
          && current.startedAt !== null) {
          terminalStatus = "failed";
          terminalDispatchState = "acknowledged";
        } else if (current.status === "running"
          && (current.stage === "fetching" || current.stage === "validating" || current.stage === "publishing")
          && (current.dispatchState === "dispatched" || current.dispatchState === "acknowledged")
          && current.startedAt !== null) {
          terminalStatus = "unknown";
          terminalDispatchState = "dispatched";
        } else {
          return false;
        }

        const completedAt = await databaseNow(tx);
        const updated = await tx.projectGitRepositoryManualRun.updateMany({
          where: {
            id: current.id,
            projectId: current.projectId,
            connectionOwnerAccountAccessVersion: null,
            status: current.status,
            stage: current.stage,
            dispatchState: current.dispatchState,
            failureCode: current.failureCode,
          },
          data: {
            status: terminalStatus,
            stage: "terminal",
            dispatchState: terminalDispatchState,
            failureCode: PROJECT_GIT_MANUAL_LEGACY_EPOCH_INVALIDATED,
            completedAt,
          },
        });
        if (updated.count !== 1) return false;

        const terminal = await tx.projectGitRepositoryManualRun.findUnique({ where: { id: current.id }, select: runSelect });
        if (terminal === null) return false;
        await setAuditContext(tx);
        await appendAudit(
          tx,
          terminal,
          terminalStatus === "failed" ? "failed" : "unknown",
          current.status,
          null,
          PROJECT_GIT_MANUAL_LEGACY_EPOCH_INVALIDATED,
        );
        return true;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (isSerializationConflict(error) && attempt < 2) continue;
      if (isSerializationConflict(error)) return false;
      throw error;
    }
  }
  return false;
}

/** Worker entry point for bounded, no-network invalidation of legacy runs. */
export async function reconcileLegacyProjectGitManualRuns(
  db: PrismaClient = getDb(),
  maximum = 50,
): Promise<number> {
  if (!Number.isInteger(maximum) || maximum <= 0) return 0;
  let reconciled = 0;
  while (reconciled < maximum) {
    const candidates = await db.projectGitRepositoryManualRun.findMany({
      where: {
        connectionOwnerAccountAccessVersion: null,
        status: { in: ["queued", "running"] },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: Math.max(maximum * 2, maximum + 8),
      select: { id: true },
    });
    if (candidates.length === 0) break;
    let progress = false;
    for (const candidate of candidates) {
      if (await reconcileLegacyProjectGitManualRunById(candidate.id, db)) {
        reconciled += 1;
        progress = true;
        if (reconciled >= maximum) break;
      }
    }
    if (!progress) break;
  }
  return reconciled;
}

type ExistingRunReplayInput = Readonly<{
  projectId: string;
  workspaceId: string;
  delegationId: string;
  clientRequestKey: string;
  actor: WebAiActor;
}>;

/**
 * Same-key replay is a read/reconciliation operation, but reconciliation is
 * still a state change. Keep this helper transaction-local so both the
 * normal replay path and the admit/P2002 race path perform the same requester,
 * active-project, and explicit membership-epoch checks before locking or
 * reconciling a run.
 */
async function replayExistingRunInTransaction(
  tx: Prisma.TransactionClient,
  input: ExistingRunReplayInput,
): Promise<RunRow> {
  const project = await tx.project.findUnique({ where: { id: input.projectId }, select: { workspaceId: true, archivedAt: true } });
  if (project === null) return fail("PROJECT_GIT_MANUAL_NOT_FOUND");
  if (project.workspaceId !== input.workspaceId) return fail("PROJECT_GIT_MANUAL_CONFLICT");
  if (project.archivedAt !== null) return fail("PROJECT_GIT_MANUAL_PROJECT_ARCHIVED");
  const actor = await tx.appUser.findUnique({ where: { id: input.actor.id }, select: { disabledAt: true, accountAccessVersion: true } });
  const current = await tx.projectGitRepositoryManualRun.findUnique({
    where: { delegationId_clientRequestKey: { delegationId: input.delegationId, clientRequestKey: input.clientRequestKey } },
    select: runSelect,
  });
  if (current === null || current.projectId !== input.projectId) return fail("PROJECT_GIT_MANUAL_NOT_FOUND");
  if (current.requestedById !== input.actor.id || actor === null || actor.disabledAt !== null
    || input.actor.accountAccessVersion !== actor.accountAccessVersion) {
    return fail("PROJECT_GIT_MANUAL_FORBIDDEN");
  }
  const membership = await tx.projectMembership.findFirst({
    where: {
      id: current.requestedByProjectMembershipId,
      projectId: input.projectId,
      userId: input.actor.id,
      role: { in: ["owner", "editor"] },
      accessState: "confirmed",
    },
    select: { createdAt: true },
  });
  if (membership === null || membership.createdAt.getTime() !== current.requestedByMembershipCreatedAt.getTime()) {
    return fail("PROJECT_GIT_MANUAL_FORBIDDEN");
  }
  const locked = await readRunForUpdate(tx, current.id);
  if (locked === null || locked.projectId !== input.projectId || locked.delegationId !== input.delegationId || locked.clientRequestKey !== input.clientRequestKey) {
    return fail("PROJECT_GIT_MANUAL_NOT_FOUND");
  }
  if (locked.status !== "running") return locked;
  if (locked.requestedByAccountAccessVersion === null
    || locked.requestedByAccountAccessVersion !== actor.accountAccessVersion) {
    const terminal = await tx.projectGitRepositoryManualRun.update({
      where: { id: locked.id },
      data: {
        status: "unknown",
        stage: "terminal",
        dispatchState: "dispatched",
        failureCode: "PROJECT_GIT_MANUAL_RUN_STALE",
        completedAt: await databaseNow(tx),
      },
      select: runSelect,
    });
    await setAuditContext(tx);
    await appendAudit(tx, terminal, "unknown", "running", null, "PROJECT_GIT_MANUAL_RUN_STALE");
    return terminal;
  }
  const now = await databaseNow(tx);
  const stale = await isStaleManualRun(tx, locked.id);
  if (!stale) return locked;
  const terminal = await tx.projectGitRepositoryManualRun.update({
    where: { id: locked.id },
    data: {
      status: "unknown",
      stage: "terminal",
      dispatchState: "dispatched",
      failureCode: "PROJECT_GIT_MANUAL_RUN_STALE",
      completedAt: now,
    },
    select: runSelect,
  });
  await setAuditContext(tx);
  await appendAudit(tx, terminal, "unknown", "running", null, "stale_dispatch_reconciled");
  return terminal;
}

async function replayExistingRun(
  input: Readonly<{
    projectId: string;
    delegationId: string;
    clientRequestKey: string;
    actor: WebAiActor;
  }>,
  db: PrismaClient,
): Promise<RunRow> {
  const projectHint = await db.project.findUnique({ where: { id: input.projectId }, select: { workspaceId: true } });
  if (projectHint === null) return fail("PROJECT_GIT_MANUAL_NOT_FOUND");
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await db.$transaction(async (tx) => {
        const transactionInput: ExistingRunReplayInput = { ...input, workspaceId: projectHint.workspaceId };
        await lockActorWorkspaceProject(tx, {
          projectId: transactionInput.projectId,
          workspaceId: transactionInput.workspaceId,
          actorIds: [transactionInput.actor.id],
        });
        return replayExistingRunInTransaction(tx, transactionInput);
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (isSerializationConflict(error) && attempt < 2) continue;
      if (isSerializationConflict(error)) return fail("PROJECT_GIT_MANUAL_CONFLICT");
      throw error;
    }
  }
  return fail("PROJECT_GIT_MANUAL_CONFLICT");
}

type AdmissionResult = Readonly<{ run: RunRow; claimed: boolean }>;

async function admitRun(snapshot: AdmissionSnapshot, clientRequestKey: string, db: PrismaClient): Promise<AdmissionResult> {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await db.$transaction(async (tx) => {
        await lockActorWorkspaceProject(tx, {
          projectId: snapshot.projectId,
          workspaceId: snapshot.workspaceId,
          actorIds: [snapshot.requestedById, snapshot.connectionOwnerId, snapshot.projectConfirmedById],
        });
        const project = await tx.project.findUnique({ where: { id: snapshot.projectId }, select: { workspaceId: true, archivedAt: true } });
        if (project === null) return fail("PROJECT_GIT_MANUAL_NOT_FOUND");
        if (project.archivedAt !== null) return fail("PROJECT_GIT_MANUAL_PROJECT_ARCHIVED");
        const currentActor = await tx.appUser.findUnique({ where: { id: snapshot.requestedById }, select: { disabledAt: true, accountAccessVersion: true } });
        const currentMembership = await tx.projectMembership.findFirst({
          where: { id: snapshot.requestedByProjectMembershipId, projectId: snapshot.projectId, userId: snapshot.requestedById, role: { in: ["owner", "editor"] }, accessState: "confirmed" },
          select: { id: true, createdAt: true },
        });
        if (currentActor === null || currentActor.disabledAt !== null
          || currentActor.accountAccessVersion !== snapshot.requestedByAccountAccessVersion
          || currentMembership === null
          || currentMembership.createdAt.getTime() !== snapshot.requestedByMembershipCreatedAt.getTime()) {
          return fail("PROJECT_GIT_MANUAL_FORBIDDEN");
        }
        const existing = await tx.projectGitRepositoryManualRun.findUnique({
          where: { delegationId_clientRequestKey: { delegationId: snapshot.delegationId, clientRequestKey } },
          select: runSelect,
        });
        if (existing !== null) {
          const replayed = await replayExistingRunInTransaction(tx, {
            projectId: snapshot.projectId,
            workspaceId: snapshot.workspaceId,
            delegationId: snapshot.delegationId,
            clientRequestKey,
            actor: { id: snapshot.requestedById, role: "user", accountAccessVersion: snapshot.requestedByAccountAccessVersion },
          });
          return { run: replayed, claimed: false };
        }
        const liveRunIds = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id"
          FROM "ProjectGitRepositoryManualRun"
          WHERE "projectId" = ${snapshot.projectId}::uuid
            AND "delegationId" = ${snapshot.delegationId}::uuid
            AND "status" = 'running'
          ORDER BY "createdAt" ASC
          LIMIT 1
          FOR UPDATE
        `;
        const liveRunId = liveRunIds[0]?.id;
        if (liveRunId !== undefined && !(await isStaleManualRun(tx, liveRunId))) return fail("PROJECT_GIT_MANUAL_CONFLICT");
        await lockDelegationEvidence(tx, snapshot);
        const delegation = await tx.projectGitRepositoryDelegation.findFirst({ where: { id: snapshot.delegationId, projectId: snapshot.projectId } });
        if (delegation === null) return fail("PROJECT_GIT_MANUAL_NOT_FOUND");
        if (delegation.status !== "active" || !delegation.manualSyncAllowed || delegation.expiresAt.getTime() <= (await databaseNow(tx)).getTime()) return fail("PROJECT_GIT_MANUAL_INELIGIBLE");
        if (delegation.version !== snapshot.delegationVersion || delegation.delegationFingerprint !== snapshot.delegationFingerprint
          || delegation.connectionOwnerAccountAccessVersion !== snapshot.connectionOwnerAccountAccessVersion
          || delegation.connectionConfigurationVersion !== snapshot.connectionConfigurationVersion
          || delegation.resolvedAddressFingerprint !== snapshot.resolvedAddressFingerprint
          || delegation.credentialFingerprint !== snapshot.credentialFingerprint
          || delegation.projectConfirmedById !== snapshot.projectConfirmedById
          || delegation.role !== snapshot.role
          || delegation.requiredForProjectSnapshot !== snapshot.requiredForProjectSnapshot
          || delegation.codeEnabled !== snapshot.codeEnabled
          || delegation.metadataEnabled !== snapshot.metadataEnabled
          || delegation.manualSyncAllowed !== snapshot.manualSyncAllowed
          || delegation.automationAllowed !== snapshot.automationAllowed) return fail("PROJECT_GIT_MANUAL_CONFLICT");
        const currentConnection = await tx.gitConnection.findFirst({
          where: { id: snapshot.connection.id },
          select: {
            id: true,
            ownerUserId: true,
            ownerAccountAccessVersion: true,
            ownershipState: true,
            status: true,
            configurationVersion: true,
            resolvedAddressFingerprint: true,
            credential: { select: { kind: true, secretFingerprint: true } },
          },
        });
        const connectionOwner = await tx.appUser.findUnique({
          where: { id: snapshot.connectionOwnerId },
          select: { disabledAt: true, accountAccessVersion: true },
        });
        if (currentConnection === null
          || currentConnection.ownerUserId !== snapshot.connectionOwnerId
          || currentConnection.ownerAccountAccessVersion !== snapshot.connectionOwnerAccountAccessVersion
          || currentConnection.ownershipState !== "confirmed"
          || currentConnection.status !== "verified"
          || currentConnection.configurationVersion !== snapshot.connectionConfigurationVersion
          || currentConnection.resolvedAddressFingerprint !== snapshot.resolvedAddressFingerprint
          || currentConnection.credential?.kind !== "git"
          || currentConnection.credential.secretFingerprint !== snapshot.credentialFingerprint
          || connectionOwner === null
          || connectionOwner.disabledAt !== null
          || connectionOwner.accountAccessVersion !== snapshot.connectionOwnerAccountAccessVersion) {
          return fail("PROJECT_GIT_MANUAL_CONNECTION_UNAVAILABLE");
        }
        const ownerMembership = await tx.projectMembership.findFirst({ where: { id: snapshot.ownerProjectMembershipId, projectId: snapshot.projectId, userId: snapshot.connectionOwnerId, role: { in: ["owner", "editor"] }, accessState: "confirmed" }, select: { createdAt: true } });
        const projectOwnerMembership = await tx.projectMembership.findFirst({ where: { id: snapshot.projectConfirmedProjectMembershipId, projectId: snapshot.projectId, userId: snapshot.projectConfirmedById, role: "owner", accessState: "confirmed" }, select: { createdAt: true } });
        const projectOwner = delegation.projectConfirmedById === null
          ? null
          : await tx.appUser.findUnique({ where: { id: snapshot.projectConfirmedById }, select: { disabledAt: true } });
        if (ownerMembership === null || ownerMembership.createdAt.getTime() !== snapshot.ownerMembershipCreatedAt.getTime()
          || projectOwnerMembership === null || projectOwnerMembership.createdAt.getTime() !== snapshot.projectConfirmedMembershipCreatedAt.getTime()
          || projectOwner === null || projectOwner.disabledAt !== null) {
          return fail("PROJECT_GIT_MANUAL_INELIGIBLE");
        }
        if (liveRunId !== undefined) {
          const staleRun = await tx.projectGitRepositoryManualRun.findUnique({ where: { id: liveRunId }, select: runSelect });
          if (staleRun === null || staleRun.status !== "running") return fail("PROJECT_GIT_MANUAL_CONFLICT");
          await setAuditContext(tx);
          const reconciled = await tx.projectGitRepositoryManualRun.update({
            where: { id: liveRunId },
            data: {
              status: "unknown",
              stage: "terminal",
              dispatchState: "dispatched",
              failureCode: "PROJECT_GIT_MANUAL_RUN_STALE",
              completedAt: await databaseNow(tx),
            },
            select: runSelect,
          });
          await appendAudit(tx, reconciled, "unknown", "running", null, "stale_dispatch_reconciled_before_new_request");
        }
        const run = await tx.projectGitRepositoryManualRun.create({
          data: {
            projectId: snapshot.projectId,
            delegationId: snapshot.delegationId,
            requestedById: snapshot.requestedById,
            requestedByAccountAccessVersion: snapshot.requestedByAccountAccessVersion,
            requestedByProjectMembershipId: snapshot.requestedByProjectMembershipId,
            requestedByMembershipCreatedAt: snapshot.requestedByMembershipCreatedAt,
            clientRequestKey,
            delegationVersion: snapshot.delegationVersion,
            delegationFingerprint: snapshot.delegationFingerprint,
            connectionOwnerId: snapshot.connectionOwnerId,
            connectionOwnerAccountAccessVersion: snapshot.connectionOwnerAccountAccessVersion,
            ownerProjectMembershipId: snapshot.ownerProjectMembershipId,
            ownerMembershipCreatedAt: snapshot.ownerMembershipCreatedAt,
            projectConfirmedById: snapshot.projectConfirmedById,
            projectConfirmedProjectMembershipId: snapshot.projectConfirmedProjectMembershipId,
            projectConfirmedMembershipCreatedAt: snapshot.projectConfirmedMembershipCreatedAt,
            connectionConfigurationVersion: snapshot.connectionConfigurationVersion,
            resolvedAddressFingerprint: snapshot.resolvedAddressFingerprint,
            credentialFingerprint: snapshot.credentialFingerprint,
            repositoryPath: snapshot.repositoryPath,
            trackedRef: snapshot.trackedRef,
            includeRoots: snapshot.includeRoots,
            softExcludePatterns: snapshot.softExcludePatterns,
            role: snapshot.role,
            requiredForProjectSnapshot: snapshot.requiredForProjectSnapshot,
            codeEnabled: snapshot.codeEnabled,
            metadataEnabled: snapshot.metadataEnabled,
            manualSyncAllowed: true,
            automationAllowed: snapshot.automationAllowed,
          },
          select: runSelect,
        });
        await setAuditContext(tx);
        await appendAudit(tx, run, "requested", null, snapshot.requestedById, "manual_sync_requested");
        const running = await tx.projectGitRepositoryManualRun.update({
          where: { id: run.id },
          data: { status: "running", stage: "admitted", dispatchState: "pending", startedAt: await databaseNow(tx) },
          select: runSelect,
        });
        await appendAudit(tx, running, "admitted", "queued", snapshot.requestedById, "manual_sync_admitted");
        return { run: running, claimed: true };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (isPrismaCode(error, "P2002")) {
        const existing = await db.projectGitRepositoryManualRun.findUnique({ where: { delegationId_clientRequestKey: { delegationId: snapshot.delegationId, clientRequestKey } }, select: runSelect });
        if (existing !== null) {
          const replayed = await replayExistingRun({
            projectId: snapshot.projectId,
            delegationId: snapshot.delegationId,
            clientRequestKey,
            actor: { id: snapshot.requestedById, role: "user", accountAccessVersion: snapshot.requestedByAccountAccessVersion },
          }, db);
          return { run: replayed, claimed: false };
        }
        if (attempt < 2) continue;
        return fail("PROJECT_GIT_MANUAL_CONFLICT");
      }
      if (isSerializationConflict(error) && attempt < 2) continue;
      if (isSerializationConflict(error)) return fail("PROJECT_GIT_MANUAL_CONFLICT");
      throw error;
    }
  }
  return fail("PROJECT_GIT_MANUAL_CONFLICT");
}

/**
 * Commit the database-owned dispatch marker immediately before the first
 * network-capable Git command.  Admission deliberately leaves the run in
 * `running/admitted/pending`; this second transaction is the only operation
 * that may move it to `running/fetching/dispatched`.
 */
type GitDispatchBoundaryResult = Readonly<
  | { outcome: "accepted"; run: RunRow }
  | { outcome: "rejected"; run: RunRow }
  | { outcome: "settled"; run: RunRow }
>;

async function rejectGitDispatchBoundary(
  tx: Prisma.TransactionClient,
  runId: string,
): Promise<GitDispatchBoundaryResult> {
  const completedAt = await databaseNow(tx);
  const terminal = await tx.projectGitRepositoryManualRun.update({
    where: { id: runId },
    data: {
      status: "failed",
      stage: "terminal",
      dispatchState: "acknowledged",
      failureCode: PROJECT_GIT_MANUAL_FINAL_ADMISSION_REJECTED,
      completedAt,
    },
    select: runSelect,
  });
  await setAuditContext(tx);
  await appendAudit(
    tx,
    terminal,
    "failed",
    "running",
    null,
    PROJECT_GIT_MANUAL_FINAL_ADMISSION_REJECTED_REASON,
    completedAt,
  );
  return Object.freeze({ outcome: "rejected", run: terminal });
}

async function markGitDispatchBoundary(
  runId: string,
  snapshot: AdmissionSnapshot,
  db: PrismaClient,
): Promise<GitDispatchBoundaryResult> {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await db.$transaction(async (tx) => {
        await lockActorWorkspaceProject(tx, {
          projectId: snapshot.projectId,
          workspaceId: snapshot.workspaceId,
          actorIds: [snapshot.requestedById, snapshot.connectionOwnerId, snapshot.projectConfirmedById],
        });
        const current = await readRunForUpdate(tx, runId);
        if (current === null) throw new Error("PROJECT_GIT_MANUAL_FINAL_FENCE_RUN_MISSING");
        if (current.status !== "running") return Object.freeze({ outcome: "settled", run: current });
        if (current.stage !== "admitted"
          || current.dispatchState !== "pending"
          || current.projectId !== snapshot.projectId
          || current.delegationId !== snapshot.delegationId
          || current.delegationVersion !== snapshot.delegationVersion
          || current.delegationFingerprint !== snapshot.delegationFingerprint
          || current.connectionOwnerId !== snapshot.connectionOwnerId
          || current.connectionOwnerAccountAccessVersion !== snapshot.connectionOwnerAccountAccessVersion
          || current.requestedByAccountAccessVersion !== snapshot.requestedByAccountAccessVersion) {
          throw new Error("PROJECT_GIT_MANUAL_FINAL_FENCE_STATE_CHANGED");
        }
        const project = await tx.project.findUnique({
          where: { id: snapshot.projectId },
          select: { workspaceId: true, archivedAt: true },
        });
        const [requester, connectionOwner, projectConfirmer] = await Promise.all([
          tx.appUser.findUnique({ where: { id: snapshot.requestedById }, select: { disabledAt: true, accountAccessVersion: true } }),
          tx.appUser.findUnique({ where: { id: snapshot.connectionOwnerId }, select: { disabledAt: true, accountAccessVersion: true } }),
          tx.appUser.findUnique({ where: { id: snapshot.projectConfirmedById }, select: { disabledAt: true } }),
        ]);
        if (project === null || project.workspaceId !== snapshot.workspaceId || project.archivedAt !== null
          || requester === null || requester.disabledAt !== null
          || requester.accountAccessVersion !== snapshot.requestedByAccountAccessVersion
          || connectionOwner === null || connectionOwner.disabledAt !== null
          || connectionOwner.accountAccessVersion !== snapshot.connectionOwnerAccountAccessVersion
          || projectConfirmer === null || projectConfirmer.disabledAt !== null) {
          return rejectGitDispatchBoundary(tx, runId);
        }
        const requesterMembership = await tx.projectMembership.findFirst({
          where: {
            id: snapshot.requestedByProjectMembershipId,
            projectId: snapshot.projectId,
            userId: snapshot.requestedById,
            role: { in: ["owner", "editor"] },
            accessState: "confirmed",
          },
          select: { createdAt: true },
        });
        const ownerMembership = await tx.projectMembership.findFirst({
          where: {
            id: snapshot.ownerProjectMembershipId,
            projectId: snapshot.projectId,
            userId: snapshot.connectionOwnerId,
            role: { in: ["owner", "editor"] },
            accessState: "confirmed",
          },
          select: { createdAt: true },
        });
        const projectOwnerMembership = await tx.projectMembership.findFirst({
          where: {
            id: snapshot.projectConfirmedProjectMembershipId,
            projectId: snapshot.projectId,
            userId: snapshot.projectConfirmedById,
            role: "owner",
            accessState: "confirmed",
          },
          select: { createdAt: true },
        });
        if (requesterMembership === null
          || requesterMembership.createdAt.getTime() !== snapshot.requestedByMembershipCreatedAt.getTime()
          || ownerMembership === null
          || ownerMembership.createdAt.getTime() !== snapshot.ownerMembershipCreatedAt.getTime()
          || projectOwnerMembership === null
          || projectOwnerMembership.createdAt.getTime() !== snapshot.projectConfirmedMembershipCreatedAt.getTime()) {
          return rejectGitDispatchBoundary(tx, runId);
        }

        // Keep the same global -> connection -> credential -> membership lock
        // sequence used by admission and lifecycle mutations.  All reads
        // below therefore observe one linearized control-plane snapshot.
        await lockDelegationEvidence(tx, snapshot);
        const delegation = await tx.projectGitRepositoryDelegation.findFirst({
          where: { id: snapshot.delegationId, projectId: snapshot.projectId },
          select: {
            status: true,
            version: true,
            delegationFingerprint: true,
            connectionOwnerId: true,
            connectionOwnerAccountAccessVersion: true,
            projectConfirmedById: true,
            connectionConfigurationVersion: true,
            resolvedAddressFingerprint: true,
            credentialFingerprint: true,
            role: true,
            requiredForProjectSnapshot: true,
            codeEnabled: true,
            metadataEnabled: true,
            manualSyncAllowed: true,
            automationAllowed: true,
            expiresAt: true,
          },
        });
        const connection = await tx.gitConnection.findFirst({
          where: { id: snapshot.connection.id },
          select: {
            id: true,
            ownerUserId: true,
            ownerAccountAccessVersion: true,
            ownershipState: true,
            status: true,
            configurationVersion: true,
            resolvedAddressFingerprint: true,
            credential: { select: { kind: true, secretFingerprint: true } },
          },
        });
        const now = await databaseNow(tx);
        if (delegation === null
          || delegation.status !== "active"
          || delegation.expiresAt.getTime() <= now.getTime()
          || delegation.version !== snapshot.delegationVersion
          || delegation.delegationFingerprint !== snapshot.delegationFingerprint
          || delegation.connectionOwnerId !== snapshot.connectionOwnerId
          || delegation.connectionOwnerAccountAccessVersion !== snapshot.connectionOwnerAccountAccessVersion
          || delegation.projectConfirmedById !== snapshot.projectConfirmedById
          || delegation.connectionConfigurationVersion !== snapshot.connectionConfigurationVersion
          || delegation.resolvedAddressFingerprint !== snapshot.resolvedAddressFingerprint
          || delegation.credentialFingerprint !== snapshot.credentialFingerprint
          || delegation.role !== snapshot.role
          || delegation.requiredForProjectSnapshot !== snapshot.requiredForProjectSnapshot
          || delegation.codeEnabled !== snapshot.codeEnabled
          || delegation.metadataEnabled !== snapshot.metadataEnabled
          || delegation.manualSyncAllowed !== snapshot.manualSyncAllowed
          || delegation.automationAllowed !== snapshot.automationAllowed
          || connection === null
          || connection.id !== snapshot.connection.id
          || connection.ownerUserId !== snapshot.connectionOwnerId
          || connection.ownerAccountAccessVersion !== snapshot.connectionOwnerAccountAccessVersion
          || connection.ownershipState !== "confirmed"
          || connection.status !== "verified"
          || connection.configurationVersion !== snapshot.connectionConfigurationVersion
          || connection.resolvedAddressFingerprint !== snapshot.resolvedAddressFingerprint
          || connection.credential?.kind !== "git"
          || connection.credential.secretFingerprint !== snapshot.credentialFingerprint) {
          return rejectGitDispatchBoundary(tx, runId);
        }
        const dispatched = await tx.projectGitRepositoryManualRun.update({
          where: { id: runId },
          data: { stage: "fetching", dispatchState: "dispatched" },
          select: runSelect,
        });
        await setAuditContext(tx);
        await appendAudit(tx, dispatched, "dispatched", "running", null, "manual_sync_dispatch_boundary_committed");
        return Object.freeze({ outcome: "accepted", run: dispatched });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (isSerializationConflict(error) && attempt < 2) continue;
      throw error;
    }
  }
  throw new Error("PROJECT_GIT_MANUAL_FINAL_FENCE_UNREACHABLE");
}

async function loadFreshConnection(snapshot: AdmissionSnapshot, db: PrismaClient): Promise<GitConnectionWithSecret> {
  const connection = await db.gitConnection.findFirst({ where: { id: snapshot.connection.id }, include: { credential: true } });
  if (connection === null) return fail("PROJECT_GIT_MANUAL_CONNECTION_UNAVAILABLE");
  assertConnectionSnapshot(connection, snapshot);
  return connection;
}

async function terminalizeRun(
  runId: string,
  snapshot: AdmissionSnapshot,
  status: "failed" | "unknown",
  failureCode: string,
  db: PrismaClient,
): Promise<RunRow | null> {
  try {
    return await db.$transaction(async (tx) => {
      const current = await readRunForUpdate(tx, runId);
      if (current === null || current.status !== "running"
        || current.requestedByAccountAccessVersion !== snapshot.requestedByAccountAccessVersion
        || current.connectionOwnerAccountAccessVersion !== snapshot.connectionOwnerAccountAccessVersion) return current;
      const completedAt = await databaseNow(tx);
      const terminal = await tx.projectGitRepositoryManualRun.update({
        where: { id: runId },
        data: {
          status,
          stage: "terminal",
          dispatchState: status === "failed" ? "acknowledged" : "dispatched",
          failureCode: publicFailureCode(failureCode) ?? "PROJECT_GIT_MANUAL_RUN_FAILED",
          completedAt,
        },
        select: runSelect,
      });
      await setAuditContext(tx);
      await appendAudit(tx, terminal, status === "failed" ? "failed" : "unknown", "running", status === "failed" ? snapshot.requestedById : null, failureCode);
      return terminal;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (isSerializationConflict(error)) return null;
    throw error;
  }
}

async function canonicalManifest(tx: Prisma.TransactionClient, runId: string): Promise<string> {
  const rows = await tx.$queryRaw<Array<{ manifest: string | null }>>`
    SELECT "project_git_manual_runtime_manifest"(${runId}::uuid) AS manifest
  `;
  const manifest = rows[0]?.manifest;
  if (typeof manifest !== "string" || !/^[0-9a-f]{64}$/u.test(manifest)) return fail("PROJECT_GIT_MANUAL_CONFLICT");
  return manifest;
}

async function publishResult(
  runId: string,
  snapshot: AdmissionSnapshot,
  connection: GitConnectionWithSecret,
  result: Readonly<{ commitSha: string; addressFingerprint: string; files: readonly GitScannedFile[] }>,
  db: PrismaClient,
): Promise<RunRow | null> {
  if (result.addressFingerprint !== snapshot.resolvedAddressFingerprint) return null;
  try {
    return await db.$transaction(async (tx) => {
      await lockActorWorkspaceProject(tx, {
        projectId: snapshot.projectId,
        workspaceId: snapshot.workspaceId,
        actorIds: [snapshot.requestedById, snapshot.connectionOwnerId, snapshot.projectConfirmedById],
      });
      const project = await tx.project.findUnique({ where: { id: snapshot.projectId }, select: { workspaceId: true, archivedAt: true } });
      if (project === null || project.archivedAt !== null) return null;
      const current = await readRunForUpdate(tx, runId);
      if (current === null || current.status !== "running") return current;
      await lockDelegationEvidence(tx, snapshot);
      const delegation = await tx.projectGitRepositoryDelegation.findFirst({ where: { id: snapshot.delegationId, projectId: snapshot.projectId } });
      const now = await databaseNow(tx);
      const currentConnection = await tx.gitConnection.findFirst({ where: { id: snapshot.connection.id }, select: { id: true, ownerUserId: true, ownerAccountAccessVersion: true, ownershipState: true, status: true, configurationVersion: true, resolvedAddressFingerprint: true, credentialId: true, credential: { select: { kind: true, secretFingerprint: true } } } });
      const actor = await tx.appUser.findUnique({ where: { id: snapshot.requestedById }, select: { disabledAt: true, accountAccessVersion: true } });
      const connectionOwner = await tx.appUser.findUnique({ where: { id: snapshot.connectionOwnerId }, select: { disabledAt: true, accountAccessVersion: true } });
      const actorMembership = await tx.projectMembership.findFirst({ where: { id: snapshot.requestedByProjectMembershipId, projectId: snapshot.projectId, userId: snapshot.requestedById, role: { in: ["owner", "editor"] }, accessState: "confirmed" }, select: { createdAt: true } });
      const ownerMembership = await tx.projectMembership.findFirst({ where: { id: snapshot.ownerProjectMembershipId, projectId: snapshot.projectId, userId: snapshot.connectionOwnerId, role: { in: ["owner", "editor"] }, accessState: "confirmed" }, select: { createdAt: true } });
      const projectOwnerMembership = await tx.projectMembership.findFirst({ where: { id: snapshot.projectConfirmedProjectMembershipId, projectId: snapshot.projectId, userId: snapshot.projectConfirmedById, role: "owner", accessState: "confirmed" }, select: { createdAt: true } });
      const projectOwner = delegation?.projectConfirmedById === undefined || delegation.projectConfirmedById === null
        ? null
        : await tx.appUser.findUnique({ where: { id: snapshot.projectConfirmedById }, select: { disabledAt: true } });
      if (delegation === null || delegation.status !== "active" || !delegation.manualSyncAllowed || delegation.expiresAt.getTime() <= now.getTime()
        || delegation.version !== snapshot.delegationVersion || delegation.delegationFingerprint !== snapshot.delegationFingerprint
        || delegation.connectionOwnerAccountAccessVersion !== snapshot.connectionOwnerAccountAccessVersion
        || delegation.connectionConfigurationVersion !== snapshot.connectionConfigurationVersion || delegation.resolvedAddressFingerprint !== snapshot.resolvedAddressFingerprint || delegation.credentialFingerprint !== snapshot.credentialFingerprint
        || delegation.projectConfirmedById !== snapshot.projectConfirmedById
        || delegation.role !== snapshot.role || delegation.requiredForProjectSnapshot !== snapshot.requiredForProjectSnapshot || delegation.codeEnabled !== snapshot.codeEnabled || delegation.metadataEnabled !== snapshot.metadataEnabled || delegation.manualSyncAllowed !== snapshot.manualSyncAllowed || delegation.automationAllowed !== snapshot.automationAllowed
        || current.projectConfirmedById !== snapshot.projectConfirmedById
        || currentConnection === null || currentConnection.ownerUserId !== snapshot.connectionOwnerId || currentConnection.ownerAccountAccessVersion !== snapshot.connectionOwnerAccountAccessVersion || currentConnection.ownershipState !== "confirmed" || currentConnection.status !== "verified" || currentConnection.configurationVersion !== snapshot.connectionConfigurationVersion || currentConnection.resolvedAddressFingerprint !== snapshot.resolvedAddressFingerprint || currentConnection.credential?.secretFingerprint !== snapshot.credentialFingerprint || currentConnection.credential?.kind !== "git"
        || connectionOwner === null || connectionOwner.disabledAt !== null || connectionOwner.accountAccessVersion !== snapshot.connectionOwnerAccountAccessVersion
        || current.requestedByAccountAccessVersion !== snapshot.requestedByAccountAccessVersion
        || actor === null || actor.disabledAt !== null || actor.accountAccessVersion !== snapshot.requestedByAccountAccessVersion
        || actorMembership === null || actorMembership.createdAt.getTime() !== snapshot.requestedByMembershipCreatedAt.getTime()
        || ownerMembership === null || ownerMembership.createdAt.getTime() !== snapshot.ownerMembershipCreatedAt.getTime()
        || projectOwnerMembership === null || projectOwnerMembership.createdAt.getTime() !== snapshot.projectConfirmedMembershipCreatedAt.getTime()
        || projectOwner === null || projectOwner.disabledAt !== null) return null;
      if (connection.id !== currentConnection.id) return null;

      await tx.projectGitRepositoryManualRun.update({ where: { id: runId }, data: { stage: "validating" } });
      await tx.projectGitRepositoryManualRun.update({ where: { id: runId }, data: { stage: "publishing" } });
      const publishedAt = await databaseNow(tx);
      const pointer = await tx.projectGitRepositoryManualPointer.findUnique({ where: { projectId_delegationId: { projectId: snapshot.projectId, delegationId: snapshot.delegationId } }, select: { runId: true } });
      if (pointer !== null && pointer.runId !== runId) {
        const oldEntries = await tx.projectGitRepositoryManualRunEntry.findMany({ where: { projectId: snapshot.projectId, runId: pointer.runId }, select: { projectSourceId: true } });
        if (oldEntries.length > 0) await tx.projectSource.updateMany({ where: { projectId: snapshot.projectId, id: { in: oldEntries.map((entry) => entry.projectSourceId) }, retiredAt: null }, data: { retiredAt: publishedAt } });
      }
      for (let ordinal = 0; ordinal < result.files.length; ordinal += 1) {
        const file = result.files[ordinal]!;
        const sourceIdentity = deterministicUuid(`git-delegated-source:${snapshot.delegationId}:${snapshot.delegationVersion}:${snapshot.delegationFingerprint}:${file.path}`);
        const revisionKey = deterministicUuid(`git-delegated-revision:${snapshot.delegationId}:${snapshot.delegationVersion}:${snapshot.delegationFingerprint}:${result.commitSha}:${file.path}:${file.contentHash}`);
        const existing = await tx.projectSource.findUnique({ where: { projectId_sourceIdentity_revisionKey: { projectId: snapshot.projectId, sourceIdentity, revisionKey } }, select: { id: true } });
        const source = existing === null
          ? await tx.projectSource.create({ data: { projectId: snapshot.projectId, kind: "git", originScope: "project", projectRepositoryLinkId: null, sourceIdentity, revisionKey, externalRef: null, contentText: file.contentText, contentHash: file.contentHash, capturedAt: publishedAt }, select: { id: true } })
          : await tx.projectSource.update({ where: { projectId_id: { projectId: snapshot.projectId, id: existing.id } }, data: { retiredAt: null }, select: { id: true } });
        await tx.projectGitRepositoryManualRunEntry.create({ data: { projectId: snapshot.projectId, runId, delegationId: snapshot.delegationId, delegationVersion: snapshot.delegationVersion, delegationFingerprint: snapshot.delegationFingerprint, projectSourceId: source.id, ordinal, normalizedPath: file.path, blobOid: file.blobOid, contentHash: file.contentHash, contentBytes: file.contentBytes, lineCount: file.lineCount } });
      }
      const manifest = await canonicalManifest(tx, runId);
      const completed = await tx.projectGitRepositoryManualRun.update({
        where: { id: runId },
        data: { status: "succeeded", stage: "terminal", dispatchState: "acknowledged", frozenCommitSha: result.commitSha, manifestFingerprint: manifest, fileCount: result.files.length, decodedTextBytes: result.files.reduce((sum, file) => sum + file.contentBytes, 0), completedAt: publishedAt, result: { fileCount: result.files.length, decodedTextBytes: result.files.reduce((sum, file) => sum + file.contentBytes, 0) } },
        select: runSelect,
      });
      await tx.projectGitRepositoryManualPointer.upsert({
        where: { projectId_delegationId: { projectId: snapshot.projectId, delegationId: snapshot.delegationId } },
        create: { projectId: snapshot.projectId, delegationId: snapshot.delegationId, runId, delegationVersion: snapshot.delegationVersion, delegationFingerprint: snapshot.delegationFingerprint, frozenCommitSha: result.commitSha, manifestFingerprint: manifest, publishedAt },
        update: { runId, delegationVersion: snapshot.delegationVersion, delegationFingerprint: snapshot.delegationFingerprint, frozenCommitSha: result.commitSha, manifestFingerprint: manifest, publishedAt: publishedAt },
      });
      await setAuditContext(tx);
      await appendAudit(tx, completed, "succeeded", "running", snapshot.requestedById, "manual_sync_published");
      return completed;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (isSerializationConflict(error)) return null;
    throw error;
  }
}

export async function runProjectDelegatedGitManualSync(input: Readonly<{
  projectId: unknown;
  delegationId: unknown;
  request: unknown;
  actor: WebAiActor;
}>, db: PrismaClient = getDb()) {
  const projectId = uuid(input.projectId);
  const delegationId = uuid(input.delegationId);
  const parsed = requestSchema.safeParse(input.request);
  if (!parsed.success || parsed.data.clientRequestKey === NIL_UUID) return fail("PROJECT_GIT_MANUAL_INVALID_INPUT");
  await assertWebAiProjectAccess(input.actor, projectId, "edit", db);
  const existing = await db.projectGitRepositoryManualRun.findUnique({
    where: { delegationId_clientRequestKey: { delegationId, clientRequestKey: parsed.data.clientRequestKey } },
    select: runSelect,
  });
  if (existing !== null) {
    if (existing.projectId !== projectId) return fail("PROJECT_GIT_MANUAL_NOT_FOUND");
    if (existing.connectionOwnerAccountAccessVersion === null
      && (existing.status === "queued" || existing.status === "running")) {
      await reconcileLegacyProjectGitManualRunById(existing.id, db);
      const reconciled = await db.projectGitRepositoryManualRun.findUnique({ where: { id: existing.id }, select: runSelect });
      if (reconciled !== null && reconciled.connectionOwnerAccountAccessVersion === null
        && (reconciled.status === "queued" || reconciled.status === "running")) {
        // A malformed legacy chain stays durable but non-executable.  Do not
        // send it through the ordinary stale replay path, which would invent a
        // dispatch outcome without the required legacy evidence.
        return publicRun(reconciled);
      }
      if (reconciled !== null) return publicRun(reconciled);
    }
    return publicRun(await replayExistingRun({ projectId, delegationId, clientRequestKey: parsed.data.clientRequestKey, actor: input.actor }, db));
  }
  const snapshot = await loadAdmissionSnapshot(projectId, delegationId, input.actor, db);
  const admission = await admitRun(snapshot, parsed.data.clientRequestKey, db);
  const admitted = admission.run;
  if (!admission.claimed || admitted.status !== "running") return publicRun(admitted);
  let dispatched = false;
  let finalFenceTerminal: RunRow | null = null;
  let finalFenceUnavailable = false;
  let result: Readonly<{ commitSha: string; addressFingerprint: string; files: readonly GitScannedFile[] }>;
  try {
    const connection = await loadFreshConnection(snapshot, db);
    result = await readGitRepositoryFilesForDelegation({
      connection,
      repositoryPath: snapshot.repositoryPath,
      trackedRef: snapshot.trackedRef,
      includeRoots: snapshot.includeRoots,
      softExcludePatterns: snapshot.softExcludePatterns,
      db,
      pinnedResolution: snapshot.pinnedResolution,
      onDispatchBoundary: async () => {
        let boundary: GitDispatchBoundaryResult;
        try {
          boundary = await markGitDispatchBoundary(admitted.id, snapshot, db);
        } catch (error) {
          finalFenceUnavailable = true;
          throw error;
        }
        if (boundary.outcome !== "accepted") finalFenceTerminal = boundary.run;
        dispatched = boundary.outcome === "accepted";
        return boundary.outcome === "accepted";
      },
    });
  } catch (error) {
    if (finalFenceTerminal !== null) return publicRun(finalFenceTerminal);
    // The database never admitted dispatch, so do not fabricate a requester-
    // or system-attributed terminal for a control-plane failure that the
    // database cannot independently prove.  The durable admitted/pending run
    // remains available for stale-run reconciliation and no secret is read.
    if (finalFenceUnavailable) throw error;
    const terminal = await terminalizeRun(
      admitted.id,
      snapshot,
      dispatched && !isDefinitelyPreDispatchGitSyncFailure(error) ? "unknown" : "failed",
      safeFailureCode(error),
      db,
    );
    if (terminal !== null) return publicRun(terminal);
    throw error;
  }
  try {
    const postFetchResolution = await assertPinnedGitEndpoint({
      baseUrl: snapshot.connection.baseUrl,
      allowPrivateNetwork: snapshot.connection.allowPrivateNetwork,
      expectedFingerprint: snapshot.resolvedAddressFingerprint,
    });
    if (postFetchResolution.fingerprint !== snapshot.resolvedAddressFingerprint) {
      const terminal = await terminalizeRun(admitted.id, snapshot, "failed", "PROJECT_GIT_MANUAL_NETWORK_CHANGED", db);
      return publicRun(terminal ?? await db.projectGitRepositoryManualRun.findUniqueOrThrow({ where: { id: admitted.id }, select: runSelect }));
    }
  } catch (error) {
    const terminal = await terminalizeRun(admitted.id, snapshot, "unknown", safeFailureCode(error), db);
    return publicRun(terminal ?? await db.projectGitRepositoryManualRun.findUniqueOrThrow({ where: { id: admitted.id }, select: runSelect }));
  }
  let currentConnection: GitConnectionWithSecret;
  try {
    currentConnection = await loadFreshConnection(snapshot, db);
  } catch (error) {
    const terminal = await terminalizeRun(admitted.id, snapshot, "unknown", safeFailureCode(error), db);
    if (terminal !== null) return publicRun(terminal);
    return publicRun(await db.projectGitRepositoryManualRun.findUniqueOrThrow({ where: { id: admitted.id }, select: runSelect }));
  }
  let published: RunRow | null;
  try {
    published = await publishResult(admitted.id, snapshot, currentConnection, result, db);
  } catch (error) {
    const terminal = await terminalizeRun(admitted.id, snapshot, "unknown", safeFailureCode(error), db);
    if (terminal !== null) return publicRun(terminal);
    return publicRun(await db.projectGitRepositoryManualRun.findUniqueOrThrow({ where: { id: admitted.id }, select: runSelect }));
  }
  if (published === null) {
    const terminal = await terminalizeRun(admitted.id, snapshot, "unknown", "PROJECT_GIT_MANUAL_CONNECTION_UNAVAILABLE", db);
    return terminal === null ? publicRun(await db.projectGitRepositoryManualRun.findUniqueOrThrow({ where: { id: admitted.id }, select: runSelect })) : publicRun(terminal);
  }
  return publicRun(published);
}

export async function listProjectDelegatedGitManualRuns(
  projectIdInput: unknown,
  delegationIdInput: unknown,
  input: unknown,
  actor: WebAiActor,
  db: PrismaClient = getDb(),
) {
  const projectId = uuid(projectIdInput);
  const delegationId = uuid(delegationIdInput);
  const query = manualRunQuerySchema.safeParse(input);
  if (!query.success) return fail("PROJECT_GIT_MANUAL_INVALID_INPUT");
  const cursor = query.data.cursor === undefined ? null : decodeManualRunCursor(query.data.cursor, projectId, delegationId);
  return runRead(db, actor, projectId, async (tx, admission) => {
    const delegation = await tx.projectGitRepositoryDelegation.findFirst({ where: { id: delegationId, projectId }, select: { id: true } });
    if (delegation === null) return fail("PROJECT_GIT_MANUAL_NOT_FOUND");
    const rows = await tx.projectGitRepositoryManualRun.findMany({
      where: {
        projectId,
        delegationId,
        ...(cursor === null ? {} : {
          OR: [
            { createdAt: { lt: new Date(cursor.createdAt) } },
            { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } },
          ],
        }),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: query.data.limit + 1,
      select: manualRunHistorySelect,
    });
    const page = rows.slice(0, query.data.limit);
    const acknowledged = await loadManualRunAcknowledgements(tx, page.map((row) => row.id));
    const canAcknowledge = await canAcknowledgeManualRun(tx, projectId, actor.id, admission.project.archivedAt);
    const last = page.at(-1);
    return Object.freeze({
      runs: page.map((row) => publicManualRunHistory(row, acknowledged.has(row.id))),
      nextCursor: rows.length > query.data.limit && last !== undefined
        ? encodeManualRunCursor({ projectId, delegationId, createdAt: last.createdAt.toISOString(), id: last.id })
        : null,
      capabilities: Object.freeze({ canView: admission.permission === "view" || admission.permission === "edit" || admission.permission === "owner", canAcknowledge }),
    });
  });
}

export async function getProjectDelegatedGitManualRunDetail(
  projectIdInput: unknown,
  delegationIdInput: unknown,
  runIdInput: unknown,
  actor: WebAiActor,
  db: PrismaClient = getDb(),
) {
  const projectId = uuid(projectIdInput);
  const delegationId = uuid(delegationIdInput);
  const runId = uuid(runIdInput);
  return runRead(db, actor, projectId, async (tx, admission) => {
    const row = await tx.projectGitRepositoryManualRun.findFirst({ where: { id: runId, projectId, delegationId }, select: manualRunHistorySelect });
    if (row === null) return fail("PROJECT_GIT_MANUAL_NOT_FOUND");
    const acknowledgement = await tx.projectGitRepositoryManualRunReconciliation.findUnique({ where: { runId }, select: { id: true, acknowledgedAt: true } });
    const canAcknowledge = await canAcknowledgeManualRun(tx, projectId, actor.id, admission.project.archivedAt);
    const entries = row.status === "succeeded"
      ? await tx.projectGitRepositoryManualRunEntry.findMany({
        where: { projectId, runId },
        orderBy: [{ ordinal: "asc" }],
        select: { ordinal: true, normalizedPath: true, contentBytes: true, lineCount: true, projectSourceId: true },
      })
      : [];
    return Object.freeze({
      run: publicManualRunHistory(row, acknowledgement !== null),
      acknowledgement: acknowledgement === null ? null : Object.freeze({ acknowledgedAt: acknowledgement.acknowledgedAt }),
      entries,
      capabilities: Object.freeze({ canAcknowledge }),
    });
  });
}

export async function acknowledgeProjectDelegatedGitManualRun(
  projectIdInput: unknown,
  delegationIdInput: unknown,
  runIdInput: unknown,
  input: unknown,
  actor: WebAiActor,
  db: PrismaClient = getDb(),
) {
  const projectId = uuid(projectIdInput);
  const delegationId = uuid(delegationIdInput);
  const runId = uuid(runIdInput);
  if (!z.object({}).strict().safeParse(input).success) return fail("PROJECT_GIT_MANUAL_INVALID_INPUT");
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await withWebAiProjectAccessTransaction(db, {
        actor,
        projectId,
        required: "edit",
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      }, async (tx, admission) => {
        if (admission.project.archivedAt !== null) return fail("PROJECT_GIT_MANUAL_PROJECT_ARCHIVED");
        await tx.$queryRaw`SELECT "id" FROM "ProjectGitRepositoryManualRun" WHERE "id" = ${runId}::uuid FOR UPDATE`;
        const run = await tx.projectGitRepositoryManualRun.findFirst({ where: { id: runId, projectId, delegationId }, select: { id: true, projectId: true, delegationId: true, status: true } });
        if (run === null) return fail("PROJECT_GIT_MANUAL_NOT_FOUND");
        if (run.status !== "unknown") return fail("PROJECT_GIT_MANUAL_RECONCILIATION_STATE_CONFLICT");
        const membership = await tx.projectMembership.findFirst({
          where: { projectId, userId: admission.actor.id, accessState: "confirmed", role: { in: ["owner", "editor"] } },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: { id: true, createdAt: true },
        });
        if (membership === null) return fail("PROJECT_GIT_MANUAL_FORBIDDEN");
        const existing = await tx.projectGitRepositoryManualRunReconciliation.findUnique({ where: { runId }, select: { id: true, runId: true, acknowledgedAt: true } });
        if (existing !== null) return Object.freeze({ runId: existing.runId, acknowledged: true, acknowledgedAt: existing.acknowledgedAt });
        await tx.$executeRaw`SELECT set_config('ai.project_git_manual_run_reconciliation', '1', true)`;
        const acknowledgement = await tx.projectGitRepositoryManualRunReconciliation.create({
          data: {
            runId,
            projectId,
            delegationId,
            actorId: admission.actor.id,
            actorProjectMembershipId: membership.id,
            actorMembershipCreatedAt: membership.createdAt,
          },
          select: { runId: true, acknowledgedAt: true },
        });
        return Object.freeze({ runId: acknowledgement.runId, acknowledged: true, acknowledgedAt: acknowledgement.acknowledgedAt });
      });
    } catch (error) {
      if (isPrismaCode(error, "P2002")) {
        if (attempt < 3) continue;
        return fail("PROJECT_GIT_MANUAL_RECONCILIATION_CONFLICT");
      }
      if (isSerializationConflict(error) && attempt < 3) continue;
      if (isSerializationConflict(error)) return fail("PROJECT_GIT_MANUAL_RECONCILIATION_CONFLICT");
      throw error;
    }
  }
  return fail("PROJECT_GIT_MANUAL_RECONCILIATION_CONFLICT");
}

export async function getProjectDelegatedGitManualRun(
  projectIdInput: unknown,
  delegationIdInput: unknown,
  clientRequestKeyInput: unknown,
  actor: WebAiActor,
  db: PrismaClient = getDb(),
) {
  const projectId = uuid(projectIdInput);
  const delegationId = uuid(delegationIdInput);
  const clientRequestKey = uuid(clientRequestKeyInput);
  await assertWebAiProjectAccess(actor, projectId, "view", db);
  const row = await db.projectGitRepositoryManualRun.findUnique({ where: { delegationId_clientRequestKey: { delegationId, clientRequestKey } }, select: runSelect });
  if (row === null || row.projectId !== projectId) return fail("PROJECT_GIT_MANUAL_NOT_FOUND");
  return publicRun(row);
}
