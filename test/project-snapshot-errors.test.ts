import assert from "node:assert/strict";
import test from "node:test";
import { Prisma } from "@prisma/client";
import { isProjectSnapshotGenerationConflict } from "@/lib/project-snapshot-errors";

function knownError(code: string, meta?: Record<string, unknown>): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError("database error", {
    code,
    clientVersion: "7.10.0",
    meta,
  });
}

test("classifies Prisma transaction conflicts", () => {
  assert.equal(isProjectSnapshotGenerationConflict(knownError("P2034")), true);
});

test("classifies a raw-query P2010 with PostgreSQL serialization SQLSTATE", () => {
  assert.equal(
    isProjectSnapshotGenerationConflict(
      knownError("P2010", {
        driverAdapterError: {
          cause: {
            kind: "TransactionWriteConflict",
            originalCode: "40001",
            originalMessage: "could not serialize access due to concurrent update",
          },
        },
      }),
    ),
    true,
  );
});

test("does not broaden P2010 or classify unrelated errors", () => {
  assert.equal(
    isProjectSnapshotGenerationConflict(
      knownError("P2010", {
        driverAdapterError: { cause: { originalCode: "40P01" } },
      }),
    ),
    false,
  );
  assert.equal(
    isProjectSnapshotGenerationConflict(
      knownError("P2010", { driverAdapterError: { cause: { originalCode: 40001 } } }),
    ),
    false,
  );
  assert.equal(
    isProjectSnapshotGenerationConflict(
      knownError("P2010", { code: "40001", driverAdapterError: { cause: {} } }),
    ),
    false,
  );
  assert.equal(isProjectSnapshotGenerationConflict(new Error("40001")), false);
});
