import { createHash } from "node:crypto";
import { Prisma, type PrismaClient, type ProjectDeletionReceipt } from "@prisma/client";
import { getDb } from "@/lib/db";
import {
  ProjectAssetStorageError,
  purgeStagedProjectAssetStorage,
  restoreStagedProjectAssetStorage,
  stageProjectAssetStorageForDeletion,
} from "@/lib/project-assets/storage";

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
  | "PROJECT_DELETE_CONFLICT";

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

function isSerializationConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034";
}

function isForeignKeyConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003";
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
  const [jobs, automationRuns, actions, extractionRuns, uploadReservations, uploadAdmissions] = await Promise.all([
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
    tx.projectAssetExtractionRun.count({ where: { projectId, status: { in: ["queued", "running", "unknown"] } } }),
    tx.projectAssetUploadReservation.count({ where: { projectId, leaseExpiresAt: { gt: now } } }),
    tx.projectAssetUploadAdmission.count({ where: { projectId, releasedAt: null, leaseExpiresAt: { gt: now } } }),
  ]);
  if (jobs > 0 || automationRuns > 0 || actions > 0 || extractionRuns > 0) {
    throw new ProjectLifecycleError("PROJECT_HAS_UNRESOLVED_JOBS");
  }
  if (uploadReservations > 0 || uploadAdmissions > 0) {
    throw new ProjectLifecycleError("PROJECT_DELETE_ACTIVE_UPLOAD");
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
    actorId: string;
    action: "archive" | "restore";
    expectedUpdatedAt: Date;
  }>,
  db: PrismaClient = getDb(),
) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await db.$transaction(async (tx) => {
        await tx.$executeRaw(Prisma.sql`
          SELECT pg_advisory_xact_lock(hashtextextended(${input.projectId}::text, 23082915))
        `);
        const current = await tx.project.findUnique({
          where: { id: input.projectId },
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
              projectId: input.projectId,
              OR: [
                { status: { in: ["queued", "waitingConsent", "running"] } },
                { reconciliationRequired: true },
              ],
            },
          });
          const runningAutomations = await tx.automationRun.count({ where: { projectId: input.projectId, status: "running" } });
          const runningActions = await tx.projectAction.count({ where: { projectId: input.projectId, status: "running" } });
          if (unresolvedJobs > 0 || runningAutomations > 0 || runningActions > 0) throw new ProjectLifecycleError("PROJECT_HAS_UNRESOLVED_JOBS");
        } else if (current.archivedAt === null) {
          throw new ProjectLifecycleError("PROJECT_ALREADY_ACTIVE");
        }

        const changedAt = new Date();
        const archivedAt = input.action === "archive" ? changedAt : null;
        const project = await tx.project.update({
          where: { id: input.projectId },
          data: { archivedAt, updatedAt: changedAt },
          select: lifecycleProjectSelect,
        });
        if (input.action === "archive") {
          await tx.automationRule.updateMany({ where: { projectId: input.projectId, status: "active" }, data: { status: "paused" } });
          const pendingActions = await tx.projectAction.findMany({ where: { projectId: input.projectId, status: { in: ["waitingApproval", "queued"] } }, select: { id: true, status: true } });
          for (const action of pendingActions) {
            const cancelled = await tx.projectAction.updateMany({
              where: { id: action.id, status: action.status },
              data: { status: "cancelled", completedAt: changedAt, updatedAt: changedAt },
            });
            if (cancelled.count === 1) await tx.projectActionAudit.create({ data: {
              projectId: input.projectId,
              actionId: action.id,
              event: "cancelled",
              actorId: input.actorId,
              details: { previousStatus: action.status, reason: "PROJECT_ARCHIVED" },
            } });
          }
        }
        const revision = await tx.projectLifecycleRevision.create({
          data: {
            projectId: input.projectId,
            action: input.action === "archive" ? "archived" : "restored",
            actorId: input.actorId,
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
    actorId: string;
    confirmationName: string;
    expectedUpdatedAt: Date;
  }>,
  db: PrismaClient = getDb(),
) {
  let receipt: ProjectDeletionReceipt | null = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      receipt = await db.$transaction(async (tx) => {
        await tx.$executeRaw(Prisma.sql`
          SELECT pg_advisory_xact_lock(hashtextextended(${input.projectId}::text, 23082916))
        `);
        const project = await tx.project.findUnique({
          where: { id: input.projectId },
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
        await assertProjectReadyForDeletion(tx, input.projectId, new Date());
        const fingerprint = deletionFingerprint(project);
        const existing = await tx.projectDeletionReceipt.findUnique({ where: { deletedProjectId: input.projectId } });
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
            requestedById: input.actorId,
            projectFingerprint: fingerprint,
            expectedUpdatedAt: input.expectedUpdatedAt,
          },
        });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      break;
    } catch (error) {
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
      const committed = await db.$transaction(async (tx) => {
        await tx.$executeRaw(Prisma.sql`
          SELECT pg_advisory_xact_lock(hashtextextended(${input.projectId}::text, 23082916))
        `);
        const currentReceipt = await tx.projectDeletionReceipt.findUniqueOrThrow({ where: { id: receipt.id } });
        if (currentReceipt.status !== "pending") return currentReceipt;
        const project = await tx.project.findUnique({
          where: { id: input.projectId },
          select: { id: true, workspaceId: true, name: true, slug: true, archivedAt: true, updatedAt: true },
        });
        if (project === null || deletionFingerprint(project) !== currentReceipt.projectFingerprint) {
          throw new ProjectLifecycleError("PROJECT_DELETE_CONFLICT");
        }
        if (project.archivedAt === null) throw new ProjectLifecycleError("PROJECT_DELETE_REQUIRES_ARCHIVED");
        if (project.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) {
          throw new ProjectLifecycleError("PROJECT_LIFECYCLE_STALE");
        }
        await assertProjectReadyForDeletion(tx, input.projectId, new Date());
        const storedVersionCount = await tx.projectAssetVersion.count({ where: { projectId: input.projectId } });
        storageStagedThisAttempt = await stageProjectAssetStorageForDeletion(input.projectId, receipt.id);
        if (storedVersionCount > 0 && !storageStagedThisAttempt) {
          throw new ProjectAssetStorageError("ASSET_STORAGE_UNAVAILABLE");
        }
        const credentialRows = await Promise.all([
          tx.gitHubConnection.findMany({ where: { projectId: input.projectId, credentialId: { not: null } }, select: { credentialId: true } }),
          tx.projectGitHubSyncEntry.findMany({ where: { projectId: input.projectId }, select: { credentialId: true } }),
        ]);
        const credentialIds = [...new Set(credentialRows.flat().flatMap((entry) => entry.credentialId ? [entry.credentialId] : []))];
        await tx.projectAssetUploadReservation.deleteMany({ where: { projectId: input.projectId } });
        await tx.project.delete({ where: { id: input.projectId } });
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
        await restoreStagedProjectAssetStorage(input.projectId, receipt.id);
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
