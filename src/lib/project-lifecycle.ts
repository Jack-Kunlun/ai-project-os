import { createHash } from "node:crypto";
import { Prisma, type PrismaClient, type ProjectDeletionReceipt } from "@prisma/client";
import { type AccessUser } from "@/lib/access-control";
import { admitWebAiProjectAccess } from "@/lib/access-linearization";
import { getDb } from "@/lib/db";
import {
  ProjectAssetStorageError,
  purgeStagedProjectAssetStorage,
  restoreStagedProjectAssetStorage,
  stageProjectAssetStorageForDeletion,
} from "@/lib/project-assets/storage";
import { isSerializationConflict } from "@/lib/project-snapshot-errors";

export type ProjectLifecycleErrorCode =
  | "PROJECT_NOT_FOUND"
  | "PROJECT_ARCHIVED"
  | "PROJECT_ALREADY_ACTIVE"
  | "PROJECT_LIFECYCLE_STALE"
  | "PROJECT_HAS_UNRESOLVED_JOBS"
  | "PROJECT_LIFECYCLE_CONFLICT"
  | "PROJECT_DELETE_REQUIRES_ARCHIVED"
  | "PROJECT_DELETE_CONFIRMATION_MISMATCH"
  | "PROJECT_DELETE_ACTIVE_UPLOAD"
  | "PROJECT_DELETE_CONFLICT"
  | "PROJECT_MCP_GRANT_RETENTION_REQUIRED"
  | "PROJECT_MCP_ACTION_PENDING";

export class ProjectLifecycleError extends Error {
  constructor(readonly code: ProjectLifecycleErrorCode) {
    super(code);
    this.name = "ProjectLifecycleError";
  }
}

const lifecycleProjectSelect = {
  id: true,
  name: true,
  slug: true,
  description: true,
  archivedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

function isForeignKeyConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003";
}

function isMcpGrantRetentionConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError
    && (error.message.includes("PROJECT_MCP_GRANT_RETENTION_REQUIRED")
      || JSON.stringify(error.meta ?? {}).includes("PROJECT_MCP_GRANT_RETENTION_REQUIRED"));
}

type DeletionProject = Readonly<{
  id: string;
  workspaceId: string;
  name: string;
  slug: string;
  archivedAt: Date | null;
  updatedAt: Date;
}>;

function deletionFingerprint(project: DeletionProject): string {
  return createHash("sha256").update(JSON.stringify({
    id: project.id,
    workspaceId: project.workspaceId,
    name: project.name,
    slug: project.slug,
    archivedAt: project.archivedAt?.toISOString() ?? null,
    updatedAt: project.updatedAt.toISOString(),
  }), "utf8").digest("hex");
}

async function assertProjectReadyForDeletion(
  tx: Prisma.TransactionClient,
  projectId: string,
  now: Date,
): Promise<void> {
  const [jobs, automationRuns, actions, mcpActions, extractionRuns, manualRuns, uploadReservations, uploadAdmissions] = await Promise.all([
    tx.backgroundJob.count({
      where: {
        projectId,
        OR: [
          { status: { in: ["queued", "waitingConsent", "running"] } },
          { reconciliationRequired: true },
        ],
      },
    }),
    tx.automationRun.count({ where: { projectId, status: { in: ["queued", "running", "waitingConsent"] } } }),
    tx.projectAction.count({ where: { projectId, status: { in: ["waitingApproval", "queued", "running"] } } }),
    tx.projectMcpAction.count({ where: { projectId, status: { in: ["waitingApproval", "approved", "dispatchReserved"] } } }),
    tx.projectAssetExtractionRun.count({ where: { projectId, status: { in: ["queued", "running", "unknown"] } } }),
    tx.projectGitRepositoryManualRun.count({ where: { projectId, status: { in: ["queued", "running"] } } }),
    tx.projectAssetUploadReservation.count({ where: { projectId, leaseExpiresAt: { gt: now } } }),
    tx.projectAssetUploadAdmission.count({ where: { projectId, releasedAt: null, leaseExpiresAt: { gt: now } } }),
  ]);
  if (mcpActions > 0) {
    throw new ProjectLifecycleError("PROJECT_MCP_ACTION_PENDING");
  }
  if (jobs > 0 || automationRuns > 0 || actions > 0 || extractionRuns > 0 || manualRuns > 0) {
    throw new ProjectLifecycleError("PROJECT_HAS_UNRESOLVED_JOBS");
  }
  if (uploadReservations > 0 || uploadAdmissions > 0) {
    throw new ProjectLifecycleError("PROJECT_DELETE_ACTIVE_UPLOAD");
  }
}

async function assertProjectMcpGrantRetentionReady(
  tx: Prisma.TransactionClient,
  projectId: string,
): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ blocked: boolean }>>(Prisma.sql`
    SELECT (
      EXISTS (
        SELECT 1
        FROM "ProjectMcpToolGrant" AS grant_row
        WHERE grant_row."projectId" = ${projectId}::uuid
          AND grant_row."controlPlaneVersion" = 2
          AND (
            grant_row."status" = 'active'
            OR NOT "project_mcp_tool_grant_v2_retention_complete"(grant_row)
          )
      )
      OR EXISTS (
        SELECT 1
        FROM "ProjectMcpToolGrantLedger" AS ledger
        WHERE ledger."projectId" = ${projectId}::uuid
          AND NOT EXISTS (
            SELECT 1
            FROM "ProjectMcpToolGrant" AS grant_row
            WHERE grant_row."projectId" = ledger."projectId"
              AND grant_row."id" = ledger."grantId"
              AND grant_row."controlPlaneVersion" = 2
              AND "project_mcp_tool_grant_v2_retention_complete"(grant_row)
          )
      )
      OR EXISTS (
        SELECT 1
        FROM "ProjectMcpToolGrantAudit" AS audit
        WHERE audit."projectId" = ${projectId}::uuid
          AND audit."controlPlaneVersion" = 2
          AND NOT EXISTS (
            SELECT 1
            FROM "ProjectMcpToolGrant" AS grant_row
            WHERE grant_row."projectId" = audit."projectId"
              AND grant_row."id" = audit."grantId"
              AND grant_row."controlPlaneVersion" = 2
              AND "project_mcp_tool_grant_v2_retention_complete"(grant_row)
          )
      )
    ) AS blocked
  `);
  if (rows[0]?.blocked === true) {
    throw new ProjectLifecycleError("PROJECT_MCP_GRANT_RETENTION_REQUIRED");
  }
}

export async function assertProjectActive(projectId: string, db: PrismaClient = getDb()): Promise<void> {
  const project = await db.project.findUnique({ where: { id: projectId }, select: { archivedAt: true } });
  if (project === null) throw new ProjectLifecycleError("PROJECT_NOT_FOUND");
  if (project.archivedAt !== null) throw new ProjectLifecycleError("PROJECT_ARCHIVED");
}

export async function updateProjectLifecycle(
  input: Readonly<{
    projectId: string;
    actor: AccessUser;
    action: "archive" | "restore";
    expectedUpdatedAt: Date;
  }>,
  db: PrismaClient = getDb(),
) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await db.$transaction(async (tx) => {
        const admission = await admitWebAiProjectAccess(tx, {
          actor: input.actor,
          projectId: input.projectId,
          required: "owner",
          allowArchived: input.action === "restore",
        });
        await tx.$executeRaw(Prisma.sql`
          SELECT pg_advisory_xact_lock(hashtextextended(${admission.project.id}::text, 23082915))
        `);
        const current = await tx.project.findUnique({
          where: { id: admission.project.id },
          select: { ...lifecycleProjectSelect, archivedAt: true },
        });
        if (current === null) throw new ProjectLifecycleError("PROJECT_NOT_FOUND");
        if (current.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) {
          throw new ProjectLifecycleError("PROJECT_LIFECYCLE_STALE");
        }

        if (input.action === "archive") {
          if (current.archivedAt !== null) throw new ProjectLifecycleError("PROJECT_ARCHIVED");
          const unresolvedJobs = await tx.backgroundJob.count({
              where: {
                projectId: admission.project.id,
              OR: [
                { status: { in: ["queued", "waitingConsent", "running"] } },
                { reconciliationRequired: true },
              ],
            },
          });
          const unresolvedManualRuns = await tx.projectGitRepositoryManualRun.count({
            where: { projectId: admission.project.id, status: { in: ["queued", "running"] } },
          });
          const runningAutomations = await tx.automationRun.count({ where: { projectId: admission.project.id, status: "running" } });
          const runningActions = await tx.projectAction.count({ where: { projectId: admission.project.id, status: "running" } });
          const pendingMcpActions = await tx.projectMcpAction.count({ where: { projectId: admission.project.id, status: { in: ["waitingApproval", "approved", "dispatchReserved"] } } });
          if (pendingMcpActions > 0) throw new ProjectLifecycleError("PROJECT_MCP_ACTION_PENDING");
          if (unresolvedJobs > 0 || unresolvedManualRuns > 0 || runningAutomations > 0 || runningActions > 0) throw new ProjectLifecycleError("PROJECT_HAS_UNRESOLVED_JOBS");
        } else if (current.archivedAt === null) {
          throw new ProjectLifecycleError("PROJECT_ALREADY_ACTIVE");
        }

        const changedAt = new Date();
        const archivedAt = input.action === "archive" ? changedAt : null;
        const project = await tx.project.update({
          where: { id: admission.project.id },
          data: { archivedAt, updatedAt: changedAt },
          select: lifecycleProjectSelect,
        });
        if (input.action === "archive") {
          await tx.automationRule.updateMany({ where: { projectId: admission.project.id, status: "active" }, data: { status: "paused" } });
          const pendingActions = await tx.projectAction.findMany({ where: { projectId: admission.project.id, status: { in: ["waitingApproval", "queued"] } }, select: { id: true, status: true } });
          for (const action of pendingActions) {
            const cancelled = await tx.projectAction.updateMany({
              where: { id: action.id, status: action.status },
              data: { status: "cancelled", completedAt: changedAt, updatedAt: changedAt },
            });
            if (cancelled.count === 1) await tx.projectActionAudit.create({ data: {
              projectId: admission.project.id,
              actionId: action.id,
              event: "cancelled",
              actorId: admission.actor.id,
              details: { previousStatus: action.status, reason: "PROJECT_ARCHIVED" },
            } });
          }
        }
        const revision = await tx.projectLifecycleRevision.create({
          data: {
            projectId: admission.project.id,
            action: input.action === "archive" ? "archived" : "restored",
            actorId: admission.actor.id,
            previousArchivedAt: current.archivedAt,
            currentArchivedAt: archivedAt,
            projectUpdatedAt: project.updatedAt,
          },
          select: { id: true, action: true, createdAt: true },
        });
        return Object.freeze({ project, revision });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (isSerializationConflict(error) && attempt < 3) continue;
      if (isSerializationConflict(error)) throw new ProjectLifecycleError("PROJECT_LIFECYCLE_CONFLICT");
      throw error;
    }
  }
  throw new ProjectLifecycleError("PROJECT_LIFECYCLE_CONFLICT");
}

export async function deleteArchivedProject(
  input: Readonly<{
    projectId: string;
    actor: AccessUser;
    confirmationName: string;
    expectedUpdatedAt: Date;
  }>,
  db: PrismaClient = getDb(),
) {
  let receipt: ProjectDeletionReceipt | null = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      receipt = await db.$transaction(async (tx) => {
        const admission = await admitWebAiProjectAccess(tx, {
          actor: input.actor,
          projectId: input.projectId,
          required: "owner",
          allowArchived: true,
        });
        await tx.$executeRaw(Prisma.sql`
          SELECT pg_advisory_xact_lock(hashtextextended(${admission.project.id}::text, 23082916))
        `);
        const project = await tx.project.findUnique({
          where: { id: admission.project.id },
          select: { id: true, workspaceId: true, name: true, slug: true, archivedAt: true, updatedAt: true },
        });
        if (project === null) throw new ProjectLifecycleError("PROJECT_NOT_FOUND");
        if (project.archivedAt === null) throw new ProjectLifecycleError("PROJECT_DELETE_REQUIRES_ARCHIVED");
        if (project.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) {
          throw new ProjectLifecycleError("PROJECT_LIFECYCLE_STALE");
        }
        if (project.name !== input.confirmationName) {
          throw new ProjectLifecycleError("PROJECT_DELETE_CONFIRMATION_MISMATCH");
        }
        await assertProjectReadyForDeletion(tx, admission.project.id, new Date());
        await assertProjectMcpGrantRetentionReady(tx, admission.project.id);
        const fingerprint = deletionFingerprint(project);
        const existing = await tx.projectDeletionReceipt.findUnique({ where: { deletedProjectId: admission.project.id } });
        if (existing !== null) {
          if (existing.status !== "pending" || existing.projectFingerprint !== fingerprint || existing.expectedUpdatedAt.getTime() !== input.expectedUpdatedAt.getTime()) {
            throw new ProjectLifecycleError("PROJECT_DELETE_CONFLICT");
          }
          return existing;
        }
        return tx.projectDeletionReceipt.create({
          data: {
            deletedProjectId: project.id,
            workspaceId: project.workspaceId,
            requestedById: admission.actor.id,
            projectFingerprint: fingerprint,
            expectedUpdatedAt: input.expectedUpdatedAt,
          },
        });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      break;
    } catch (error) {
      if (isMcpGrantRetentionConflict(error)) {
        throw new ProjectLifecycleError("PROJECT_MCP_GRANT_RETENTION_REQUIRED");
      }
      if (isSerializationConflict(error) && attempt < 3) continue;
      if (isSerializationConflict(error)) throw new ProjectLifecycleError("PROJECT_DELETE_CONFLICT");
      throw error;
    }
  }
  if (receipt === null) throw new ProjectLifecycleError("PROJECT_DELETE_CONFLICT");

  let databaseDeletedAt = receipt.databaseDeletedAt;
  for (let attempt = 1; attempt <= 3 && databaseDeletedAt === null; attempt += 1) {
    let storageStagedThisAttempt = false;
    try {
      // Preflight is deliberately a short database transaction.  It checks
      // the receipt/project tuple under the common access locks, then releases
      // those locks before touching the filesystem.  The final transaction
      // below repeats the complete admission and fingerprint checks before
      // deleting anything, so archive/restore/revocation can win the gap.
      const prepared = await db.$transaction(async (tx) => {
        const admission = await admitWebAiProjectAccess(tx, {
          actor: input.actor,
          projectId: input.projectId,
          required: "owner",
          allowArchived: true,
        });
        await tx.$executeRaw(Prisma.sql`
          SELECT pg_advisory_xact_lock(hashtextextended(${admission.project.id}::text, 23082916))
        `);
        const currentReceipt = await tx.projectDeletionReceipt.findUniqueOrThrow({ where: { id: receipt.id } });
        if (currentReceipt.status !== "pending") return Object.freeze({ receipt: currentReceipt, projectId: admission.project.id, shouldStage: false });
        const project = await tx.project.findUnique({
          where: { id: admission.project.id },
          select: { id: true, workspaceId: true, name: true, slug: true, archivedAt: true, updatedAt: true },
        });
        if (project === null || deletionFingerprint(project) !== currentReceipt.projectFingerprint) {
          throw new ProjectLifecycleError("PROJECT_DELETE_CONFLICT");
        }
        if (project.archivedAt === null) throw new ProjectLifecycleError("PROJECT_DELETE_REQUIRES_ARCHIVED");
        if (project.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) {
          throw new ProjectLifecycleError("PROJECT_LIFECYCLE_STALE");
        }
        await assertProjectReadyForDeletion(tx, admission.project.id, new Date());
        await assertProjectMcpGrantRetentionReady(tx, admission.project.id);
        const storedVersionCount = await tx.projectAssetVersion.count({ where: { projectId: admission.project.id } });
        return Object.freeze({ receipt: currentReceipt, projectId: admission.project.id, shouldStage: storedVersionCount > 0 });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      if (prepared.receipt.status !== "pending") {
        databaseDeletedAt = prepared.receipt.databaseDeletedAt;
        break;
      }

      storageStagedThisAttempt = await stageProjectAssetStorageForDeletion(prepared.projectId, prepared.receipt.id);
      if (prepared.shouldStage && !storageStagedThisAttempt) {
        throw new ProjectAssetStorageError("ASSET_STORAGE_UNAVAILABLE");
      }

      const committed = await db.$transaction(async (tx) => {
        const admission = await admitWebAiProjectAccess(tx, {
          actor: input.actor,
          projectId: input.projectId,
          required: "owner",
          allowArchived: true,
        });
        await tx.$executeRaw(Prisma.sql`
          SELECT pg_advisory_xact_lock(hashtextextended(${admission.project.id}::text, 23082916))
        `);
        const currentReceipt = await tx.projectDeletionReceipt.findUniqueOrThrow({ where: { id: receipt.id } });
        if (currentReceipt.status !== "pending") return currentReceipt;
        const project = await tx.project.findUnique({
          where: { id: admission.project.id },
          select: { id: true, workspaceId: true, name: true, slug: true, archivedAt: true, updatedAt: true },
        });
        if (project === null || deletionFingerprint(project) !== currentReceipt.projectFingerprint) {
          throw new ProjectLifecycleError("PROJECT_DELETE_CONFLICT");
        }
        if (project.archivedAt === null) throw new ProjectLifecycleError("PROJECT_DELETE_REQUIRES_ARCHIVED");
        if (project.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) {
          throw new ProjectLifecycleError("PROJECT_LIFECYCLE_STALE");
        }
        await assertProjectReadyForDeletion(tx, admission.project.id, new Date());
        await assertProjectMcpGrantRetentionReady(tx, admission.project.id);
        const credentialRows = await Promise.all([
          tx.gitHubConnection.findMany({ where: { projectId: admission.project.id, credentialId: { not: null } }, select: { credentialId: true } }),
          tx.projectGitHubSyncEntry.findMany({ where: { projectId: admission.project.id }, select: { credentialId: true } }),
        ]);
        const credentialIds = [...new Set(credentialRows.flat().flatMap((entry) => entry.credentialId ? [entry.credentialId] : []))];
        await tx.projectAssetUploadReservation.deleteMany({ where: { projectId: admission.project.id } });
        await tx.project.delete({ where: { id: admission.project.id } });
        if (credentialIds.length > 0) {
          await tx.externalCredential.deleteMany({
            where: {
              id: { in: credentialIds },
              aiProvider: null,
              githubConnections: { none: {} },
              gitConnections: { none: {} },
              mcpConnection: null,
              oidcProviders: { none: {} },
              oidcLoginAttempts: { none: {} },
              githubSyncEntries: { none: {} },
            },
          });
        }
        const deletedAt = new Date();
        return tx.projectDeletionReceipt.update({
          where: { id: receipt.id },
          data: {
            status: "databaseDeleted",
            storageStaged: storageStagedThisAttempt,
            databaseDeletedAt: deletedAt,
          },
        });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      databaseDeletedAt = committed.databaseDeletedAt;
    } catch (error) {
      if (storageStagedThisAttempt) {
        await restoreStagedProjectAssetStorage(receipt.deletedProjectId, receipt.id);
      }
      if (isMcpGrantRetentionConflict(error)) {
        throw new ProjectLifecycleError("PROJECT_MCP_GRANT_RETENTION_REQUIRED");
      }
      if (isSerializationConflict(error) && attempt < 3) continue;
      if (isSerializationConflict(error) || isForeignKeyConflict(error)) {
        throw new ProjectLifecycleError("PROJECT_DELETE_CONFLICT");
      }
      throw error;
    }
  }
  if (databaseDeletedAt === null) throw new ProjectLifecycleError("PROJECT_DELETE_CONFLICT");
  const cleanup = await completeProjectDeletionStorage(receipt.id, db);
  return Object.freeze({
    projectId: input.projectId,
    receiptId: receipt.id,
    deletedAt: databaseDeletedAt,
    storageCleanupStatus: cleanup ? "completed" as const : "pending" as const,
  });
}

async function completeProjectDeletionStorage(receiptId: string, db: PrismaClient): Promise<boolean> {
  const receipt = await db.projectDeletionReceipt.findUnique({ where: { id: receiptId } });
  if (receipt === null || receipt.status === "completed") return true;
  if (receipt.status === "pending") return false;
  try {
    if (receipt.storageStaged) await purgeStagedProjectAssetStorage(receipt.id);
    await db.projectDeletionReceipt.updateMany({
      where: { id: receipt.id, status: { in: ["databaseDeleted", "cleanupFailed"] } },
      data: { status: "completed", storageFailureCode: null, completedAt: new Date() },
    });
    return true;
  } catch (error) {
    if (!(error instanceof ProjectAssetStorageError)) throw error;
    await db.projectDeletionReceipt.updateMany({
      where: { id: receipt.id, status: { in: ["databaseDeleted", "cleanupFailed"] } },
      data: { status: "cleanupFailed", storageFailureCode: error.code, completedAt: null },
    });
    return false;
  }
}

export async function reconcileProjectDeletionStorage(
  db: PrismaClient = getDb(),
  limit = 20,
): Promise<Readonly<{ completed: number; failed: number }>> {
  const receipts = await db.projectDeletionReceipt.findMany({
    where: { status: { in: ["databaseDeleted", "cleanupFailed"] } },
    orderBy: [{ requestedAt: "asc" }, { id: "asc" }],
    take: Math.max(1, Math.min(100, Math.floor(limit))),
    select: { id: true },
  });
  let completed = 0;
  let failed = 0;
  for (const receipt of receipts) {
    if (await completeProjectDeletionStorage(receipt.id, db)) completed += 1;
    else failed += 1;
  }
  return Object.freeze({ completed, failed });
}
