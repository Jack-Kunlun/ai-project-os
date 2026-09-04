import { Prisma } from "@prisma/client";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isKnownRequestError(error: unknown): error is Prisma.PrismaClientKnownRequestError {
  return error instanceof Prisma.PrismaClientKnownRequestError;
}

function isSerializationSqlState(value: unknown): boolean {
  return value === "40001";
}

function messageContainsSerializationSqlState(value: unknown): boolean {
  return typeof value === "string" && /(?:sqlstate|code)\s*[:=]\s*(?:`40001`|40001)(?![`0-9A-Za-z_])/iu.test(value);
}

/**
 * Prisma 7 can surface PostgreSQL serialization failures from raw queries as
 * P2010, with the original SQLSTATE nested in the driver adapter metadata or
 * included in the raw-query error message. Keep this classifier deliberately
 * narrow: other database errors must fail instead of being retried as if they
 * were transient conflicts.
 */
export function isSerializationConflict(error: unknown): boolean {
  if (!isKnownRequestError(error)) return false;
  if (error.code === "P2034") return true;
  if (error.code !== "P2010") return false;
  if (messageContainsSerializationSqlState(error.message)) return true;
  if (!isRecord(error.meta)) return false;

  if (
    isSerializationSqlState(error.meta.code)
    || isSerializationSqlState(error.meta.sqlState)
    || isSerializationSqlState(error.meta.sqlstate)
    || messageContainsSerializationSqlState(error.meta.message)
  ) {
    return true;
  }

  const driverAdapterError = error.meta.driverAdapterError;
  if (!isRecord(driverAdapterError) || !isRecord(driverAdapterError.cause)) return false;

  return isSerializationSqlState(driverAdapterError.cause.originalCode)
    || isSerializationSqlState(driverAdapterError.cause.sqlState)
    || isSerializationSqlState(driverAdapterError.cause.sqlstate)
    || messageContainsSerializationSqlState(driverAdapterError.cause.originalMessage);
}

export function isProjectSnapshotGenerationConflict(error: unknown): boolean {
  return isSerializationConflict(error);
}
