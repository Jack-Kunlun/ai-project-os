import assert from "node:assert/strict";
import test from "node:test";
import {
  EMBEDDING_STORAGE_PROFILE_FINGERPRINT,
  ProjectSearchError,
  createProjectSearchService,
} from "@/lib/ai-memory";

test("project search validates scope, query and vectors before a transaction", async () => {
  let transactions = 0;
  const db = {
    $transaction: async () => {
      transactions += 1;
      throw new Error("must not run");
    },
  };
  const service = createProjectSearchService({ db: db as never });

  await assert.rejects(
    service.search({ projectId: "not-a-project", query: "query" }),
    (error: unknown) =>
      error instanceof ProjectSearchError &&
      error.code === "PROJECT_SEARCH_INVALID_INPUT",
  );
  await assert.rejects(
    service.search({
      projectId: "11111111-1111-4111-8111-111111111111",
      query: " ",
    }),
    (error: unknown) =>
      error instanceof ProjectSearchError &&
      error.code === "PROJECT_SEARCH_INVALID_INPUT",
  );
  await assert.rejects(
    service.search({
      projectId: "11111111-1111-4111-8111-111111111111",
      query: "query",
      queryEmbedding: {
        profileFingerprint: EMBEDDING_STORAGE_PROFILE_FINGERPRINT,
        vector: Array.from({ length: 1_536 }, () => 0),
      },
    }),
    (error: unknown) =>
      error instanceof ProjectSearchError &&
      error.code === "PROJECT_SEARCH_INVALID_INPUT",
  );
  await assert.rejects(
    service.search({
      projectId: "11111111-1111-4111-8111-111111111111",
      query: "query",
      queryEmbedding: {
        profileFingerprint: "0".repeat(64) as typeof EMBEDDING_STORAGE_PROFILE_FINGERPRINT,
        vector: Array.from({ length: 1_536 }, (_, index) => index === 0 ? 1 : 0),
      },
    }),
    (error: unknown) =>
      error instanceof ProjectSearchError &&
      error.code === "PROJECT_SEARCH_INVALID_INPUT",
  );
  assert.equal(transactions, 0);
});

test("project search requires a database transaction capability", () => {
  assert.throws(
    () => createProjectSearchService({ db: {} as never }),
    (error: unknown) =>
      error instanceof ProjectSearchError &&
      error.code === "PROJECT_SEARCH_INVALID_INPUT",
  );
});
