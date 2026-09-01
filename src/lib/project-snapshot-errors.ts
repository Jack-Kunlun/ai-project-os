import { Prisma } from "@prisma/client";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isKnownRequestError(error: unknown): error is Prisma.PrismaClientKnownRequestError {
  return error instanceof Prisma.PrismaClientKnownRequestError;
}

/**
 * Prisma 7 can surface PostgreSQL serialization failures from raw queries as
 * P2010, with the original SQLSTATE nested in the driver adapter metadata.
 */
export function isProjectSnapshotGenerationConflict(error: unknown): boolean {
  if (!isKnownRequestError(error)) return false;
  if (error.code === "P2034") return true;
  if (error.code !== "P2010" || !isRecord(error.meta)) return false;

  if (error.meta.code === "40001") return true;

  const driverAdapterError = error.meta.driverAdapterError;
  if (!isRecord(driverAdapterError) || !isRecord(driverAdapterError.cause)) return false;

  return driverAdapterError.cause.originalCode === "40001";
}
