import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import {
  MODEL_TRANSFER_CONSENT_VERSION,
  ProjectAiConfigError,
  createProjectAiConfigService,
} from "@/lib/ai-memory";
import { hashSourceContent } from "@/lib/source";
import {
  ProjectAiConfigCliError,
  parseProjectAiConfigArgs,
} from "../scripts/project-ai-config-contract";

const projectId = "11111111-1111-4111-8111-111111111111";
const sourceAId = "22222222-2222-4222-8222-222222222222";
const sourceBId = "33333333-3333-4333-8333-333333333333";

function configureRequest(overrides: Record<string, unknown> = {}): unknown {
  return {
    projectId,
    sourceIds: [sourceAId],
    consentVersion: MODEL_TRANSFER_CONSENT_VERSION,
    acknowledgeExternalModelTransfer: true,
    ...overrides,
  };
}

function transactionTrap(): {
  db: PrismaClient;
  calls: () => number;
} {
  let calls = 0;
  const db = {
    $transaction: async () => {
      calls += 1;
      throw new Error("TRANSACTION_MUST_NOT_RUN");
    },
  } as unknown as PrismaClient;
  return { db, calls: () => calls };
}

async function expectConfigError(
  action: () => Promise<unknown>,
  code: ProjectAiConfigError["code"],
): Promise<void> {
  await assert.rejects(
    action,
    (error: unknown) =>
      error instanceof ProjectAiConfigError && error.code === code,
  );
}

test("local AI configuration CLI accepts only explicit, scoped commands", () => {
  assert.deepEqual(
    parseProjectAiConfigArgs(["status", "--project-id", projectId]),
    { operation: "status", projectId },
  );
  assert.deepEqual(
    parseProjectAiConfigArgs([
      "configure",
      "--project-id",
      projectId,
      "--source-id",
      sourceBId,
      "--source-id",
      sourceAId,
      "--acknowledge-external-model-transfer",
      MODEL_TRANSFER_CONSENT_VERSION,
    ]),
    {
      operation: "configure",
      projectId,
      sourceIds: [sourceAId, sourceBId],
      consentVersion: MODEL_TRANSFER_CONSENT_VERSION,
    },
  );
  assert.deepEqual(
    parseProjectAiConfigArgs(["revoke", "--project-id", projectId]),
    { operation: "revoke", projectId },
  );
});

test("local AI configuration CLI rejects implicit consent and command overreach", () => {
  for (const args of [
    ["configure", "--project-id", projectId, "--source-id", sourceAId],
    [
      "configure",
      "--project-id",
      projectId,
      "--source-id",
      sourceAId,
      "--source-id",
      sourceAId,
      "--acknowledge-external-model-transfer",
      MODEL_TRANSFER_CONSENT_VERSION,
    ],
    ["status", "--project-id", projectId, "--source-id", sourceAId],
    ["revoke", "--project-id", projectId, "--unknown", "value"],
  ]) {
    assert.throws(
      () => parseProjectAiConfigArgs(args),
      (error: unknown) => error instanceof ProjectAiConfigCliError,
    );
  }
});

test("configuration request validation finishes before opening a transaction", async () => {
  for (const request of [
    configureRequest({ acknowledgeExternalModelTransfer: false }),
    configureRequest({ consentVersion: "older-consent" }),
    configureRequest({ sourceIds: [sourceAId, sourceAId] }),
    { ...(configureRequest() as Record<string, unknown>), extra: "forbidden" },
  ]) {
    const trap = transactionTrap();
    const service = createProjectAiConfigService({ db: trap.db });
    await expectConfigError(
      () => service.configure(request),
      "PROJECT_AI_CONFIG_INVALID_INPUT",
    );
    assert.equal(trap.calls(), 0);
  }
});

function serviceWithSelectedSource(contentText: string, contentHash: string) {
  let transactionCalls = 0;
  let policyReads = 0;
  const tx = {
    $queryRaw: async () => [{ id: projectId }],
    projectSource: {
      findMany: async () => [{ id: sourceAId, contentText, contentHash }],
    },
    projectAiPolicy: {
      findUnique: async () => {
        policyReads += 1;
        throw new Error("POLICY_MUST_NOT_BE_READ");
      },
    },
  };
  const db = {
    $transaction: async (
      callback: (value: typeof tx) => Promise<unknown>,
    ) => {
      transactionCalls += 1;
      return callback(tx);
    },
  } as unknown as PrismaClient;
  return {
    service: createProjectAiConfigService({ db }),
    transactionCalls: () => transactionCalls,
    policyReads: () => policyReads,
  };
}

test("configuration blocks changed, oversized, and locally sensitive sources before policy writes", async () => {
  const cases = [
    {
      content: "safe content",
      hash: hashSourceContent("different content"),
      code: "SOURCE_CHANGED" as const,
    },
    {
      content: "x".repeat(64_001),
      hash: hashSourceContent("x".repeat(64_001)),
      code: "SOURCE_TOO_LARGE" as const,
    },
    {
      content: "password=abcdefgh",
      hash: hashSourceContent("password=abcdefgh"),
      code: "SOURCE_SCAN_BLOCKED" as const,
    },
  ];
  for (const fixture of cases) {
    const configured = serviceWithSelectedSource(fixture.content, fixture.hash);
    await expectConfigError(
      () => configured.service.configure(configureRequest()),
      fixture.code,
    );
    assert.equal(configured.transactionCalls(), 1);
    assert.equal(configured.policyReads(), 0);
  }
});

test("configuration rejects missing projects and sources with stable errors", async () => {
  const missingProjectDb = {
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({ $queryRaw: async () => [] }),
  } as unknown as PrismaClient;
  await expectConfigError(
    () => createProjectAiConfigService({ db: missingProjectDb }).configure(configureRequest()),
    "PROJECT_NOT_FOUND",
  );

  const missingSourceDb = {
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        $queryRaw: async () => [{ id: projectId }],
        projectSource: { findMany: async () => [] },
      }),
  } as unknown as PrismaClient;
  await expectConfigError(
    () => createProjectAiConfigService({ db: missingSourceDb }).configure(configureRequest()),
    "SOURCE_NOT_FOUND",
  );
});

test("status stops after an unknown project and does not inspect candidate state", async () => {
  let candidateReads = 0;
  const db = {
    $transaction: async () => undefined,
    project: { findUnique: async () => null },
    aiCandidateClaim: {
      count: async () => {
        candidateReads += 1;
        return 0;
      },
    },
  } as unknown as PrismaClient;
  await expectConfigError(
    () => createProjectAiConfigService({ db }).getStatus(projectId),
    "PROJECT_NOT_FOUND",
  );
  assert.equal(candidateReads, 0);
});
