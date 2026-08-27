import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import {
  MODEL_TRANSFER_CONSENT_VERSION,
} from "@/lib/ai-memory";
import {
  REPOSITORY_MODEL_TRANSFER_CONSENT_VERSION,
  REPOSITORY_MATERIAL_MODEL_TRANSFER_CONSENT_VERSION,
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
import {
  RepositoryMaterialModelGrantCliError,
  parseRepositoryMaterialModelGrantArgs,
} from "../scripts/repository-material-model-grant-contract";
import {
  GitHubRepositoryCliError,
  parseGitHubRepositoryArgs,
} from "../scripts/github-repository-contract";
import {
  ProjectMemoryIndexCliError,
  parseProjectMemoryIndexArgs,
} from "../scripts/project-memory-index-contract";
import {
  ProjectMemoryPublishCliError,
  parseProjectMemoryPublishArgs,
} from "../scripts/project-memory-publish-contract";

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

test("repository material grant CLI supports extraction but requires explicit consent", () => {
  assert.deepEqual(parseRepositoryMaterialModelGrantArgs([
    "issue",
    "--project", projectId,
    "--link", linkId,
    "--operations", "embedding,autoExtract,sourceSummary",
    "--consent", REPOSITORY_MATERIAL_MODEL_TRANSFER_CONSENT_VERSION,
    "--acknowledge-external-transfer",
    "--acknowledge-processing-rights",
  ]), {
    operation: "issue",
    request: {
      projectId,
      projectRepositoryLinkId: linkId,
      operations: ["embedding", "autoExtract", "sourceSummary"],
      consentVersion: REPOSITORY_MATERIAL_MODEL_TRANSFER_CONSENT_VERSION,
      acknowledgeExternalModelTransfer: true,
      acknowledgeProcessingRights: true,
    },
  });
  assert.throws(
    () => parseRepositoryMaterialModelGrantArgs([
      "issue",
      "--project", projectId,
      "--link", linkId,
      "--operations", "embedding",
      "--consent", REPOSITORY_MATERIAL_MODEL_TRANSFER_CONSENT_VERSION,
      "--acknowledge-processing-rights",
    ]),
    RepositoryMaterialModelGrantCliError,
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

test("GitHub repository CLI keeps remote reads behind explicit local commands", () => {
  assert.deepEqual(parseGitHubRepositoryArgs([
    "connect",
    "--project-id", projectId,
    "--repository", "openai/example",
    "--config-file", "/tmp/github-repository.json",
  ]), {
    operation: "connect",
    projectId,
    owner: "openai",
    repository: "example",
    configFile: "/tmp/github-repository.json",
  });
  assert.deepEqual(parseGitHubRepositoryArgs([
    "scan-code",
    "--project-id", projectId,
  ]), { operation: "scan-code", projectId });
  assert.deepEqual(parseGitHubRepositoryArgs([
    "sync-material",
    "--project-id", projectId,
    "--link-id", linkId,
  ]), { operation: "sync-material", projectId, linkId });
  assert.throws(
    () => parseGitHubRepositoryArgs([
      "connect",
      "--project-id", projectId,
      "--repository", "openai/example",
      "--config-file", "relative.json",
    ]),
    GitHubRepositoryCliError,
  );
});

test("project memory index CLI requires per-execution transfer consent", () => {
  assert.deepEqual(parseProjectMemoryIndexArgs([
    "project",
    "--project-id", projectId,
    "--grant-id", linkId,
    "--acknowledge-external-model-transfer", MODEL_TRANSFER_CONSENT_VERSION,
  ]), {
    scope: "project",
    projectId,
    grantId: linkId,
    consentVersion: MODEL_TRANSFER_CONSENT_VERSION,
  });
  assert.deepEqual(parseProjectMemoryIndexArgs([
    "repository-code",
    "--project-id", projectId,
    "--link-id", linkId,
    "--grant-id", projectId,
    "--acknowledge-external-model-transfer",
    REPOSITORY_MODEL_TRANSFER_CONSENT_VERSION,
    "--acknowledge-processing-rights",
  ]), {
    scope: "repository-code",
    projectId,
    linkId,
    grantId: projectId,
    consentVersion: REPOSITORY_MODEL_TRANSFER_CONSENT_VERSION,
  });
  assert.throws(
    () => parseProjectMemoryIndexArgs([
      "repository-code",
      "--project-id", projectId,
      "--link-id", linkId,
      "--grant-id", projectId,
      "--acknowledge-external-model-transfer",
      REPOSITORY_MODEL_TRANSFER_CONSENT_VERSION,
    ]),
    ProjectMemoryIndexCliError,
  );
});

test("project memory publication CLI separates repository and project scopes", () => {
  assert.deepEqual(parseProjectMemoryPublishArgs([
    "repository",
    "--project-id", projectId,
    "--link-id", linkId,
  ]), { scope: "repository", projectId, linkId });
  assert.deepEqual(parseProjectMemoryPublishArgs([
    "project",
    "--project-id", projectId,
  ]), { scope: "project", projectId });
  assert.throws(
    () => parseProjectMemoryPublishArgs([
      "project",
      "--project-id", projectId,
      "--link-id", linkId,
    ]),
    ProjectMemoryPublishCliError,
  );
});
