import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { getDb } from "@/lib/db";
import { getUploadPolicy } from "@/lib/project-assets/policy";
import { isSerializableTransactionConflict, withSerializableRetry } from "@/lib/prisma-transaction";

const UPLOAD_ADMISSION_LOCK_NAMESPACE = 2026090101;
const ADMISSION_RETENTION_MS = 60 * 60 * 1000;
const TRANSACTION_RETRY_LIMIT = 3;
const RELEASE_RETRY_LIMIT = 3;
const STALE_ADMISSION_BATCH_SIZE = 50;

export type UploadAdmissionErrorCode =
  | "UPLOAD_ADMISSION_PROJECT_NOT_FOUND"
  | "UPLOAD_RATE_LIMITED"
  | "UPLOAD_CONCURRENCY_LIMITED"
  | "UPLOAD_GLOBAL_CONCURRENCY_LIMITED";

export class UploadAdmissionError extends Error {
  constructor(readonly code: UploadAdmissionErrorCode) {
    super(code);
    this.name = "UploadAdmissionError";
  }
}

function fail(code: UploadAdmissionErrorCode): never {
  throw new UploadAdmissionError(code);
}

/**
 * Reclaim only a bounded batch of old terminal/expired rows. The global query
 * is intentionally independent of the current user so inactive users cannot
 * make the durable admission table grow forever. Recent rate-window rows and
 * unexpired leases are never selected.
 */
export async function cleanupStaleUploadAdmissions(
  tx: Prisma.TransactionClient,
  now = new Date(),
): Promise<void> {
  const olderThan = new Date(now.getTime() - ADMISSION_RETENTION_MS);
  await tx.$executeRaw(Prisma.sql`
    WITH stale AS (
      SELECT "id"
      FROM "ProjectAssetUploadAdmission"
      WHERE "createdAt" < ${olderThan}
        AND ("releasedAt" IS NOT NULL OR "leaseExpiresAt" < ${now})
      ORDER BY "createdAt" ASC, "id" ASC
      LIMIT ${STALE_ADMISSION_BATCH_SIZE}
      FOR UPDATE SKIP LOCKED
    )
    DELETE FROM "ProjectAssetUploadAdmission" AS admission
    USING stale
    WHERE admission."id" = stale."id"
  `);
}

export async function acquireUploadAdmission(
  input: Readonly<{ projectId: string; userId: string }>,
  db: PrismaClient = getDb(),
): Promise<string> {
  const policy = getUploadPolicy();
  const now = new Date();
  const windowStartedAt = new Date(now.getTime() - 60 * 1000);
  const leaseExpiresAt = new Date(now.getTime() + policy.admissionLeaseMs);
  const result = await withSerializableRetry(db, async (tx) => {
    // The deployment lock must be acquired before the user lock everywhere.
    // It makes the in-database global admission count authoritative across all
    // app replicas before any request body is buffered in application memory.
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${"deployment"}::text, ${UPLOAD_ADMISSION_LOCK_NAMESPACE}))`);
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.userId}::text, ${UPLOAD_ADMISSION_LOCK_NAMESPACE}))`);
    await cleanupStaleUploadAdmissions(tx, now);
    const project = await tx.project.findUnique({ where: { id: input.projectId }, select: { workspaceId: true } });
    if (project === null) return { denied: "UPLOAD_ADMISSION_PROJECT_NOT_FOUND" as const };

    const [requests, active, globalActive] = await Promise.all([
      tx.projectAssetUploadAdmission.count({ where: { userId: input.userId, createdAt: { gte: windowStartedAt } } }),
      tx.projectAssetUploadAdmission.count({ where: { userId: input.userId, releasedAt: null, leaseExpiresAt: { gt: now } } }),
      tx.projectAssetUploadAdmission.count({ where: { releasedAt: null, leaseExpiresAt: { gt: now } } }),
    ]);
    const denied: UploadAdmissionErrorCode | null = requests >= policy.maxUploadsPerMinute
      ? "UPLOAD_RATE_LIMITED"
      : active >= policy.maxConcurrentUploads
        ? "UPLOAD_CONCURRENCY_LIMITED"
        : globalActive >= policy.maxGlobalConcurrentUploads
          ? "UPLOAD_GLOBAL_CONCURRENCY_LIMITED"
          : null;
    const admission = await tx.projectAssetUploadAdmission.create({
      data: {
        id: randomUUID(),
        projectId: input.projectId,
        workspaceId: project.workspaceId,
        userId: input.userId,
        windowStartedAt,
        leaseExpiresAt,
        releasedAt: denied === null ? null : now,
        createdAt: now,
      },
      select: { id: true },
    });
    return { id: admission.id, denied };
  }, TRANSACTION_RETRY_LIMIT);

  if (result?.denied !== null) return fail(result?.denied ?? "UPLOAD_ADMISSION_PROJECT_NOT_FOUND");
  if (result.id === undefined) return fail("UPLOAD_ADMISSION_PROJECT_NOT_FOUND");
  return result.id;
}

export async function releaseUploadAdmission(admissionId: string, db: PrismaClient = getDb()): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < RELEASE_RETRY_LIMIT; attempt += 1) {
    try {
      await db.projectAssetUploadAdmission.updateMany({
        where: { id: admissionId, releasedAt: null },
        data: { releasedAt: new Date() },
      });
      return;
    } catch (error) {
      lastError = error;
      if (!isSerializableTransactionConflict(error)) break;
    }
  }
  throw lastError;
}

export async function countActiveUploadAdmissions(userId: string, db: PrismaClient = getDb()): Promise<number> {
  return db.projectAssetUploadAdmission.count({
    where: { userId, releasedAt: null, leaseExpiresAt: { gt: new Date() } },
  });
}
