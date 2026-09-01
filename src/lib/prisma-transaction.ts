import { Prisma, type PrismaClient } from "@prisma/client";
import { isProjectSnapshotGenerationConflict } from "@/lib/project-snapshot-errors";

export const SERIALIZABLE_RETRY_LIMIT = 3;

/**
 * PostgreSQL serialization conflicts can be reported by Prisma either as the
 * documented P2034 or as a raw-query P2010 with SQLSTATE 40001 in adapter
 * metadata. Keep this classifier deliberately narrow: other database errors
 * must fail instead of being retried as if they were transient conflicts.
 */
export function isSerializableTransactionConflict(error: unknown): boolean {
  return isProjectSnapshotGenerationConflict(error);
}

export async function withSerializableRetry<T>(
  db: PrismaClient,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
  retryLimit = SERIALIZABLE_RETRY_LIMIT,
): Promise<T> {
  for (let attempt = 0; attempt < retryLimit; attempt += 1) {
    try {
      return await db.$transaction(work, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (!isSerializableTransactionConflict(error) || attempt + 1 >= retryLimit) throw error;
    }
  }
  throw new Error("SERIALIZABLE_TRANSACTION_RESULT_MISSING");
}
