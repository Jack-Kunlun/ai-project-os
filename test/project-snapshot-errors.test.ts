import assert from "node:assert/strict";
import test from "node:test";
import { Prisma, type PrismaClient } from "@prisma/client";
import { isProjectSnapshotGenerationConflict } from "@/lib/project-snapshot-errors";
import { withSerializableRetry } from "@/lib/prisma-transaction";

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
  assert.equal(isProjectSnapshotGenerationConflict(knownError("P2010", { code: "40001" })), true);
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
    true,
  );
  assert.equal(isProjectSnapshotGenerationConflict(new Error("40001")), false);
});

test("serializable retry is bounded and ignores non-serialization P2010 errors", async () => {
  const serialization = knownError("P2010", { code: "40001" });
  let attempts = 0;
  const retryingDb = {
    $transaction: async (work: (tx: Prisma.TransactionClient) => Promise<string>) => {
      attempts += 1;
      if (attempts < 2) throw serialization;
      return work({} as Prisma.TransactionClient);
    },
  } as unknown as PrismaClient;
  assert.equal(await withSerializableRetry(retryingDb, async () => "ok"), "ok");
  assert.equal(attempts, 2);

  const unrelated = knownError("P2010", { code: "23505" });
  let unrelatedAttempts = 0;
  const nonRetryingDb = {
    $transaction: async () => {
      unrelatedAttempts += 1;
      throw unrelated;
    },
  } as unknown as PrismaClient;
  await assert.rejects(() => withSerializableRetry(nonRetryingDb, async () => "never"), (error: unknown) => error === unrelated);
  assert.equal(unrelatedAttempts, 1);
});
