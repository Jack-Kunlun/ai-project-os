import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import {
  REPOSITORY_MODEL_TRANSFER_CONSENT_VERSION,
  RepositoryCodeSearchError,
  createRepositoryCodeSearchService,
} from "@/lib/github";
import {
  RepositoryCodeSearchCliError,
  parseRepositoryCodeSearchArgs,
} from "../scripts/repository-code-search-contract";
import {
  RepositoryModelGrantCliError,
  parseRepositoryModelGrantArgs,
} from "../scripts/repository-model-grant-contract";

const projectId = "11111111-1111-4111-8111-111111111111";
const linkId = "22222222-2222-4222-8222-222222222222";

test("repository grant CLI requires explicit destination and rights acknowledgements", () => {
  assert.deepEqual(parseRepositoryModelGrantArgs([
    "issue",
    "--project", projectId,
    "--link", linkId,
    "--operations", "embedding,generateWithContext",
    "--consent", REPOSITORY_MODEL_TRANSFER_CONSENT_VERSION,
    "--acknowledge-external-transfer",
    "--acknowledge-processing-rights",
  ]), {
    operation: "issue",
    request: {
      projectId,
      projectRepositoryLinkId: linkId,
      operations: ["embedding", "generateWithContext"],
      consentVersion: REPOSITORY_MODEL_TRANSFER_CONSENT_VERSION,
      acknowledgeExternalModelTransfer: true,
      acknowledgeProcessingRights: true,
    },
  });
  assert.throws(
    () => parseRepositoryModelGrantArgs([
      "issue",
      "--project", projectId,
      "--link", linkId,
      "--operations", "embedding",
      "--consent", REPOSITORY_MODEL_TRANSFER_CONSENT_VERSION,
      "--acknowledge-external-transfer",
    ]),
    RepositoryModelGrantCliError,
  );
  assert.throws(
    () => parseRepositoryModelGrantArgs([
      "issue",
      "--project", projectId,
      "--link", linkId,
      "--operations", "autoExtract",
      "--consent", REPOSITORY_MODEL_TRANSFER_CONSENT_VERSION,
      "--acknowledge-external-transfer",
      "--acknowledge-processing-rights",
    ]),
    RepositoryModelGrantCliError,
  );
});

test("repository code search CLI defaults to required project scope", () => {
  assert.deepEqual(parseRepositoryCodeSearchArgs([
    "--project", projectId,
    "--query", "RepositoryCodeGeneration",
  ]), {
    projectId,
    query: "RepositoryCodeGeneration",
    take: 10,
    projectRepositoryLinkId: null,
  });
  assert.deepEqual(parseRepositoryCodeSearchArgs([
    "--project", projectId,
    "--query", "入口",
    "--link", linkId,
    "--take", "5",
  ]), {
    projectId,
    query: "入口",
    take: 5,
    projectRepositoryLinkId: linkId,
  });
  assert.throws(
    () => parseRepositoryCodeSearchArgs(["--project", projectId, "--query", ""]),
    RepositoryCodeSearchCliError,
  );
});

test("repository code search rejects extra service fields before a transaction", async () => {
  let transactionCalls = 0;
  const db = {
    $transaction: async () => {
      transactionCalls += 1;
      throw new Error("TRANSACTION_MUST_NOT_RUN");
    },
  } as unknown as PrismaClient;
  await assert.rejects(
    () => createRepositoryCodeSearchService({ db }).search({
      projectId,
      query: "RepositoryCodeGeneration",
      scope: { kind: "project" },
      extra: true,
    } as never),
    (error: unknown) =>
      error instanceof RepositoryCodeSearchError &&
      error.code === "REPOSITORY_CODE_SEARCH_INVALID_INPUT",
  );
  assert.equal(transactionCalls, 0);
});
