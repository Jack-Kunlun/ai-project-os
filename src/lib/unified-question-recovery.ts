import { Prisma, type PrismaClient } from "@prisma/client";
import { lockActorAccess } from "@/lib/access-linearization";
import { holdPlatformTokenReservation } from "@/lib/ai-entitlements";
import { getDb } from "@/lib/db";

export const UNIFIED_QUESTION_HEARTBEAT_INTERVAL_MS = 500;
export const UNIFIED_QUESTION_STALE_REQUEST_MS = 120_000;

type RecoveryDb = PrismaClient | Prisma.TransactionClient;
type ProgressStatus = "running" | "stopping" | "stopped" | "succeeded" | "failed" | "unknown";

async function mutationContext(db: RecoveryDb): Promise<void> {
  await db.$executeRaw`SELECT set_config('app.unified_question_mutation_context', 'service-v1', true)`;
}

async function databaseNow(db: RecoveryDb): Promise<Date> {
  const rows = await db.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
  return rows[0]?.now instanceof Date ? rows[0].now : new Date();
}

function inTransaction<T>(db: RecoveryDb, callback: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  if (typeof (db as PrismaClient).$transaction === "function") {
    return (db as PrismaClient).$transaction(callback, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 15_000 });
  }
  return callback(db as Prisma.TransactionClient);
}

export async function createUnifiedQuestionProgress(
  db: Prisma.TransactionClient,
  input: Readonly<{ confirmationId: string; ownerUserId: string; conversationId: string; partialAnswer?: string }>,
): Promise<void> {
  const now = await databaseNow(db);
  await mutationContext(db);
  await db.unifiedQuestionProgress.create({ data: {
    confirmationId: input.confirmationId,
    ownerUserId: input.ownerUserId,
    conversationId: input.conversationId,
    status: "running",
    partialAnswer: input.partialAnswer ?? "",
    heartbeatAt: now,
    updatedAt: now,
  } });
}

/** Persist an answer prefix and heartbeat only while the request remains live. */
export async function checkpointUnifiedQuestionProgress(
  input: Readonly<{ confirmationId: string; ownerUserId: string; partialAnswer: string }>,
  db: RecoveryDb = getDb(),
): Promise<Readonly<{ status: ProgressStatus | null; stopRequested: boolean }>> {
  return inTransaction(db, async tx => {
    const now = await databaseNow(tx);
    await mutationContext(tx);
    const updated = await tx.unifiedQuestionProgress.updateMany({
      where: { confirmationId: input.confirmationId, ownerUserId: input.ownerUserId, status: "running", stopRequestedAt: null },
      data: { partialAnswer: input.partialAnswer, heartbeatAt: now, updatedAt: now },
    });
    if (updated.count === 1) return Object.freeze({ status: "running", stopRequested: false });
    const current = await tx.unifiedQuestionProgress.findFirst({
      where: { confirmationId: input.confirmationId, ownerUserId: input.ownerUserId },
      select: { status: true, stopRequestedAt: true },
    });
    return Object.freeze({ status: current?.status ?? null, stopRequested: current?.stopRequestedAt !== null && current?.stopRequestedAt !== undefined });
  });
}

/** Heartbeat and poll the durable stop flag even while the provider is silent. */
export async function heartbeatUnifiedQuestionProgress(
  input: Readonly<{ confirmationId: string; ownerUserId: string }>,
  db: RecoveryDb = getDb(),
): Promise<Readonly<{ status: ProgressStatus | null; stopRequested: boolean }>> {
  return inTransaction(db, async tx => {
    const now = await databaseNow(tx);
    await mutationContext(tx);
    const updated = await tx.unifiedQuestionProgress.updateMany({
      where: { confirmationId: input.confirmationId, ownerUserId: input.ownerUserId, status: "running", stopRequestedAt: null },
      data: { heartbeatAt: now, updatedAt: now },
    });
    if (updated.count === 1) return Object.freeze({ status: "running", stopRequested: false });
    const current = await tx.unifiedQuestionProgress.findFirst({
      where: { confirmationId: input.confirmationId, ownerUserId: input.ownerUserId },
      select: { status: true, stopRequestedAt: true },
    });
    return Object.freeze({ status: current?.status ?? null, stopRequested: current?.stopRequestedAt !== null && current?.stopRequestedAt !== undefined });
  });
}

export async function finalizeUnifiedQuestionProgress(
  db: Prisma.TransactionClient,
  input: Readonly<{ confirmationId: string; ownerUserId: string; status: "stopped" | "succeeded" | "failed" | "unknown"; partialAnswer?: string }>,
): Promise<boolean> {
  const now = await databaseNow(db);
  await mutationContext(db);
  const updated = await db.unifiedQuestionProgress.updateMany({
    where: { confirmationId: input.confirmationId, ownerUserId: input.ownerUserId, status: { in: ["running", "stopping"] } },
    data: { status: input.status, ...(input.partialAnswer === undefined ? {} : { partialAnswer: input.partialAnswer }), heartbeatAt: now, updatedAt: now },
  });
  return updated.count === 1;
}

export async function requestUnifiedQuestionStop(
  ownerUserId: string,
  confirmationId: string,
  db: RecoveryDb = getDb(),
): Promise<Readonly<{ status: ProgressStatus | "prepared" | null }>> {
  return inTransaction(db, async tx => {
    const progress = await tx.unifiedQuestionProgress.findFirst({
      where: { ownerUserId, confirmationId },
      select: { status: true, stopRequestedAt: true },
    });
    if (progress === null) {
      const confirmation = await tx.unifiedQuestionConfirmation.findFirst({
        where: { ownerUserId, id: confirmationId, status: "issued" },
        select: { id: true },
      });
      return Object.freeze({ status: confirmation === null ? null : "prepared" });
    }
    if (progress.status !== "running") return Object.freeze({ status: progress.status });
    const now = await databaseNow(tx);
    await mutationContext(tx);
    await tx.unifiedQuestionProgress.updateMany({
      where: { ownerUserId, confirmationId, status: "running", stopRequestedAt: null },
      data: { status: "stopping", stopRequestedAt: now, heartbeatAt: now, updatedAt: now },
    });
    const after = await tx.unifiedQuestionProgress.findFirst({ where: { ownerUserId, confirmationId }, select: { status: true } });
    return Object.freeze({ status: after?.status ?? null });
  });
}

/** Reclaim stale per-user running slots while keeping any ambiguous billing hold. */
export async function reconcileStaleUnifiedQuestionRequests(
  ownerUserId: string,
  db: PrismaClient = getDb(),
): Promise<number> {
  return db.$transaction(async tx => {
    await lockActorAccess(tx, ownerUserId);
    const stale = await tx.$queryRaw<Array<{ ownerUserId: string; confirmationId: string }>>(Prisma.sql`
      SELECT audit."ownerUserId", audit."confirmationId"
      FROM "UnifiedQuestionAudit" AS audit
      JOIN "UnifiedQuestionConfirmation" AS confirmation
        ON confirmation."ownerUserId" = audit."ownerUserId" AND confirmation."id" = audit."confirmationId"
      LEFT JOIN "UnifiedQuestionProgress" AS progress
        ON progress."ownerUserId" = audit."ownerUserId" AND progress."confirmationId" = audit."confirmationId"
      WHERE audit."ownerUserId" = ${ownerUserId}::uuid
        AND audit."status" = 'running'::"UnifiedQuestionAuditStatus"
        AND ((progress."confirmationId" IS NULL AND audit."createdAt" <= clock_timestamp() - interval '120 seconds')
          OR (progress."confirmationId" IS NOT NULL AND progress."heartbeatAt" <= clock_timestamp() - interval '120 seconds'))
      ORDER BY audit."createdAt", audit."confirmationId"
      LIMIT 32
      FOR UPDATE OF audit SKIP LOCKED
    `);
    let recovered = 0;
    for (const item of stale) {
      const now = await databaseNow(tx);
      await mutationContext(tx);
      const audit = await tx.unifiedQuestionAudit.updateMany({
        where: { ownerUserId: item.ownerUserId, confirmationId: item.confirmationId, status: "running" },
        data: { status: "unknown", safeErrorCode: "UNIFIED_QUESTION_OUTCOME_UNRESOLVED", completedAt: now },
      });
      if (audit.count !== 1) continue;
      await tx.unifiedQuestionProgress.updateMany({
        where: { ownerUserId: item.ownerUserId, confirmationId: item.confirmationId, status: { in: ["running", "stopping"] } },
        data: { status: "unknown", heartbeatAt: now, updatedAt: now },
      });
      await holdPlatformTokenReservation({
        userId: item.ownerUserId,
        callKey: `unified-question:${item.confirmationId}`,
        errorCode: "AI_PROVIDER_CALL_RECONCILIATION_REQUIRED",
        now,
      }, tx);
      recovered += 1;
    }
    return recovered;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 20_000 });
}
