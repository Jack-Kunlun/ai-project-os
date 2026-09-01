import { Prisma, type PrismaClient } from "@prisma/client";
import { getDb } from "@/lib/db";
import { isSerializableTransactionConflict, withSerializableRetry } from "@/lib/prisma-transaction";
import { getUploadPolicy } from "@/lib/project-assets/policy";
import { ProjectAssetStorageError, removeAssetBlob } from "@/lib/project-assets/storage";

const UPLOAD_QUOTA_LOCK_NAMESPACE = 2026090102;
export const PROJECT_ASSET_UPLOAD_RESERVATION_LOCK_NAMESPACE = 2026090103;
const STALE_RESERVATION_BATCH_SIZE = 50;

export type UploadQuotaErrorCode =
  | "PROJECT_ASSET_PROJECT_QUOTA_EXCEEDED"
  | "PROJECT_ASSET_WORKSPACE_QUOTA_EXCEEDED"
  | "PROJECT_ASSET_DEPLOYMENT_QUOTA_EXCEEDED"
  | "PROJECT_ASSET_COUNT_QUOTA_EXCEEDED"
  | "PROJECT_ASSET_PROJECT_RETAINED_OBJECTS_EXCEEDED"
  | "PROJECT_ASSET_WORKSPACE_RETAINED_OBJECTS_EXCEEDED"
  | "PROJECT_ASSET_DEPLOYMENT_RETAINED_OBJECTS_EXCEEDED";

export class UploadQuotaError extends Error {
  constructor(readonly code: UploadQuotaErrorCode) {
    super(code);
    this.name = "UploadQuotaError";
  }
}

export type ProjectAssetUploadUsage = Readonly<{
  projectBytes: bigint;
  workspaceBytes: bigint;
  deploymentBytes: bigint;
  activeAssetCount: number;
  reservedAssetCount: number;
  projectRetainedObjectCount: number;
  workspaceRetainedObjectCount: number;
  deploymentRetainedObjectCount: number;
}>;

export type ProjectAssetUploadReservation = Readonly<{
  id: string;
  projectId: string;
  workspaceId: string;
  userId: string;
  storageKey: string;
  sizeBytes: bigint;
  leaseExpiresAt: Date;
}>;

function fail(code: UploadQuotaErrorCode): never {
  throw new UploadQuotaError(code);
}

async function projectWorkspaceId(projectId: string, db: PrismaClient | Prisma.TransactionClient): Promise<string> {
  const project = await db.project.findUnique({ where: { id: projectId }, select: { workspaceId: true } });
  if (project === null) throw new UploadQuotaError("PROJECT_ASSET_PROJECT_QUOTA_EXCEEDED");
  return project.workspaceId;
}

export async function getProjectAssetUploadUsage(
  projectId: string,
  db: PrismaClient | Prisma.TransactionClient = getDb(),
): Promise<ProjectAssetUploadUsage> {
  const workspaceId = await projectWorkspaceId(projectId, db);
  const [
    projectBytes,
    workspaceBytes,
    deploymentBytes,
    activeAssetCount,
    projectRetainedObjects,
    workspaceRetainedObjects,
    deploymentRetainedObjects,
    projectReservations,
    workspaceReservations,
    deploymentReservations,
  ] = await Promise.all([
    db.projectAssetVersion.aggregate({ where: { projectId }, _sum: { sizeBytes: true } }),
    db.projectAssetVersion.aggregate({ where: { asset: { project: { workspaceId } } }, _sum: { sizeBytes: true } }),
    db.projectAssetVersion.aggregate({ _sum: { sizeBytes: true } }),
    db.projectAsset.count({ where: { projectId, status: { not: "deleted" } } }),
    db.projectAssetVersion.count({ where: { projectId } }),
    db.projectAssetVersion.count({ where: { asset: { project: { workspaceId } } } }),
    db.projectAssetVersion.count(),
    db.projectAssetUploadReservation.aggregate({ where: { projectId }, _sum: { sizeBytes: true }, _count: { _all: true } }),
    db.projectAssetUploadReservation.aggregate({ where: { workspaceId }, _sum: { sizeBytes: true }, _count: { _all: true } }),
    db.projectAssetUploadReservation.aggregate({ _sum: { sizeBytes: true }, _count: { _all: true } }),
  ]);
  return Object.freeze({
    projectBytes: (projectBytes._sum.sizeBytes ?? BigInt(0)) + (projectReservations._sum.sizeBytes ?? BigInt(0)),
    workspaceBytes: (workspaceBytes._sum.sizeBytes ?? BigInt(0)) + (workspaceReservations._sum.sizeBytes ?? BigInt(0)),
    deploymentBytes: (deploymentBytes._sum.sizeBytes ?? BigInt(0)) + (deploymentReservations._sum.sizeBytes ?? BigInt(0)),
    activeAssetCount,
    reservedAssetCount: projectReservations._count._all,
    projectRetainedObjectCount: projectRetainedObjects + projectReservations._count._all,
    workspaceRetainedObjectCount: workspaceRetainedObjects + workspaceReservations._count._all,
    deploymentRetainedObjectCount: deploymentRetainedObjects + deploymentReservations._count._all,
  });
}

/** Public project views deliberately do not disclose workspace/deployment usage. */
export function publicProjectAssetUploadUsage(usage: ProjectAssetUploadUsage) {
  return {
    projectBytes: usage.projectBytes.toString(),
    activeAssetCount: usage.activeAssetCount,
    retainedObjectCount: usage.projectRetainedObjectCount,
  };
}

async function lockUploadQuota(tx: Prisma.TransactionClient, projectId: string, workspaceId: string): Promise<void> {
  // A stable lock order makes project, workspace and deployment checks atomic
  // across app instances and prevents two simultaneous uploads from overselling
  // the same byte quota.
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${"deployment"}::text, ${UPLOAD_QUOTA_LOCK_NAMESPACE}))`);
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`workspace:${workspaceId}`}::text, ${UPLOAD_QUOTA_LOCK_NAMESPACE}))`);
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`project:${projectId}`}::text, ${UPLOAD_QUOTA_LOCK_NAMESPACE}))`);
}

function assertUsageWithinPolicy(usage: ProjectAssetUploadUsage, incoming: bigint): void {
  const policy = getUploadPolicy();
  if (usage.activeAssetCount + usage.reservedAssetCount >= policy.maxProjectAssets) return fail("PROJECT_ASSET_COUNT_QUOTA_EXCEEDED");
  if (usage.projectRetainedObjectCount >= policy.maxProjectRetainedObjects) return fail("PROJECT_ASSET_PROJECT_RETAINED_OBJECTS_EXCEEDED");
  if (usage.workspaceRetainedObjectCount >= policy.maxWorkspaceRetainedObjects) return fail("PROJECT_ASSET_WORKSPACE_RETAINED_OBJECTS_EXCEEDED");
  if (usage.deploymentRetainedObjectCount >= policy.maxDeploymentRetainedObjects) return fail("PROJECT_ASSET_DEPLOYMENT_RETAINED_OBJECTS_EXCEEDED");
  if (usage.projectBytes + incoming > BigInt(policy.maxProjectBytes)) return fail("PROJECT_ASSET_PROJECT_QUOTA_EXCEEDED");
  if (usage.workspaceBytes + incoming > BigInt(policy.maxWorkspaceBytes)) return fail("PROJECT_ASSET_WORKSPACE_QUOTA_EXCEEDED");
  if (usage.deploymentBytes + incoming > BigInt(policy.maxDeploymentBytes)) return fail("PROJECT_ASSET_DEPLOYMENT_QUOTA_EXCEEDED");
}

/** Compatibility helper for non-upload callers. */
export async function assertUploadQuota(
  tx: Prisma.TransactionClient,
  input: Readonly<{ projectId: string; sizeBytes: number }>,
): Promise<ProjectAssetUploadUsage> {
  const workspaceId = await projectWorkspaceId(input.projectId, tx);
  await lockUploadQuota(tx, input.projectId, workspaceId);
  const usage = await getProjectAssetUploadUsage(input.projectId, tx);
  assertUsageWithinPolicy(usage, BigInt(input.sizeBytes));
  return usage;
}

export async function assertProjectAssetCountAvailable(
  tx: Prisma.TransactionClient,
  projectId: string,
): Promise<ProjectAssetUploadUsage> {
  const workspaceId = await projectWorkspaceId(projectId, tx);
  await lockUploadQuota(tx, projectId, workspaceId);
  const usage = await getProjectAssetUploadUsage(projectId, tx);
  if (usage.activeAssetCount + usage.reservedAssetCount >= getUploadPolicy().maxProjectAssets) return fail("PROJECT_ASSET_COUNT_QUOTA_EXCEEDED");
  return usage;
}

/**
 * Atomically reserves project/workspace/deployment bytes before any blob write.
 * Every reservation remains billable until it is converted or reconciled, even
 * after its lease expires.
 */
export async function createProjectAssetUploadReservation(input: Readonly<{
  projectId: string;
  userId: string;
  storageKey: string;
  sizeBytes: number;
  id: string;
}>, db: PrismaClient = getDb()): Promise<ProjectAssetUploadReservation> {
  const policy = getUploadPolicy();
  const createdAt = new Date();
  const leaseExpiresAt = new Date(createdAt.getTime() + policy.admissionLeaseMs);
  return withSerializableRetry(db, async (tx) => {
    const workspaceId = await projectWorkspaceId(input.projectId, tx);
    await lockUploadQuota(tx, input.projectId, workspaceId);
    const usage = await getProjectAssetUploadUsage(input.projectId, tx);
    assertUsageWithinPolicy(usage, BigInt(input.sizeBytes));
    return tx.projectAssetUploadReservation.create({
      data: {
        id: input.id,
        projectId: input.projectId,
        workspaceId,
        userId: input.userId,
        storageKey: input.storageKey,
        sizeBytes: BigInt(input.sizeBytes),
        leaseExpiresAt,
        createdAt,
      },
      select: { id: true, projectId: true, workspaceId: true, userId: true, storageKey: true, sizeBytes: true, leaseExpiresAt: true },
    });
  });
}

/** Delete is only safe after the caller has confirmed the blob is absent. */
export async function releaseProjectAssetUploadReservation(
  reservationId: string,
  storageKey: string,
  db: PrismaClient = getDb(),
): Promise<void> {
  await withSerializableRetry(db, async (tx) => {
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${reservationId}::text, ${PROJECT_ASSET_UPLOAD_RESERVATION_LOCK_NAMESPACE}))`);
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "ProjectAssetUploadReservation" WHERE "id" = ${reservationId} FOR UPDATE`);
    await tx.projectAssetUploadReservation.deleteMany({ where: { id: reservationId, storageKey } });
  });
}

/**
 * Reconcile at most a small, global batch of expired reservations. Filesystem
 * deletion happens while the reservation transaction is locked; if it fails,
 * the transaction rolls back and the reservation continues to count quota.
 */
export async function reconcileStaleProjectAssetUploadReservations(
  db: PrismaClient = getDb(),
  limit = STALE_RESERVATION_BATCH_SIZE,
): Promise<number> {
  const boundedLimit = Math.max(1, Math.min(STALE_RESERVATION_BATCH_SIZE, Math.floor(limit)));
  const now = new Date();
  const candidates = await db.projectAssetUploadReservation.findMany({
    where: { leaseExpiresAt: { lt: now } },
    orderBy: [{ leaseExpiresAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    take: boundedLimit,
    select: { id: true },
  });
  let reconciled = 0;
  for (const candidate of candidates) {
    try {
      const removed = await withSerializableRetry(db, async (tx) => {
        await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${candidate.id}::text, ${PROJECT_ASSET_UPLOAD_RESERVATION_LOCK_NAMESPACE}))`);
        const rows = await tx.$queryRaw<Array<{ id: string; storageKey: string; leaseExpiresAt: Date }>>(Prisma.sql`
          SELECT "id", "storageKey", "leaseExpiresAt"
          FROM "ProjectAssetUploadReservation"
          WHERE "id" = ${candidate.id}
          FOR UPDATE
        `);
        const reservation = rows[0];
        if (reservation === undefined || reservation.leaseExpiresAt >= now) return false;
        const committed = await tx.projectAssetVersion.findFirst({ where: { storageKey: reservation.storageKey }, select: { id: true } });
        if (committed === null) await removeAssetBlob(reservation.storageKey);
        await tx.projectAssetUploadReservation.deleteMany({ where: { id: reservation.id, storageKey: reservation.storageKey } });
        return true;
      });
      if (removed) reconciled += 1;
    } catch (error) {
      if (error instanceof ProjectAssetStorageError) {
        console.error("Stale upload reservation retained because its blob could not be removed");
        continue;
      }
      if (isSerializableTransactionConflict(error)) continue;
      throw error;
    }
  }
  return reconciled;
}
