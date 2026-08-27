import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { AiSafeErrorCode as DbAiSafeErrorCodeValue, Prisma } from "@prisma/client";
import { hashSourceContent } from "@/lib/source";
import {
  AiRuntimeServiceError,
  FAKE_OPERATION_PROFILE,
  FAKE_PROFILE,
  FakeAdmissibilityGate,
  FakeAdmissibilityRecorder,
  FakeProviderRecorder,
  assertExactInputManifest,
  assertFakeInputWithinProfile,
  buildEvidenceManifestFingerprint,
  buildOperationKey,
  buildInputManifest,
  buildInputManifestFingerprint,
  calculateFakeBudgetMicros,
  buildAiRuntimeCompletionFailureResult,
  createAiRuntimeService,
  inputManifestsEqual,
  loadAiRuntimeConfig,
  assessFakeInput,
  sumInputBytes,
  isAiRuntimeRunAttemptParityValid,
  normalizeAiRuntimeProviderClassification,
  type EvidenceManifestEntry,
  type FakeAdmissibilityInput,
  type InputManifest,
} from "@/lib/ai-runtime";
import {
  isAiRuntimeOperationKeyConflict,
  isAiRuntimeSerializationConflict,
  parseClaimAndDispatchRunRequest,
  parsePrepareOrGetRequest,
} from "@/lib/ai-runtime/service";

const projectId = "a1111111-1111-4111-8111-111111111111";
const runId = "b2222222-2222-4222-8222-222222222222";
const attemptId = "c3333333-3333-4333-8333-333333333333";
const sourceAId = "d4444444-4444-4444-8444-444444444444";
const sourceBId = "e5555555-5555-4555-8555-555555555555";
const fingerprintA = "a".repeat(64);
const fingerprintB = "b".repeat(64);
const revisionId = "f6666666-6666-4666-8666-666666666666";

function preparedQueryResponses(contentText = "safe-source"): unknown[][] {
  const contentHash = hashSourceContent(contentText);
  const contentBytes = Buffer.byteLength(contentText, "utf8");
  return [
    [{ id: projectId }],
    [{ currentRevisionId: revisionId }],
    [{
      id: revisionId,
      projectId,
      revision: 1,
      outboundEnabled: true,
      embeddingEnabled: false,
      autoExtractEnabled: false,
      sourceSummaryEnabled: false,
      projectAnalysisEnabled: true,
      generateWithContextEnabled: false,
      profileFingerprint: fingerprintA,
      processorFingerprint: fingerprintA,
      regionFingerprint: fingerprintA,
      retentionFingerprint: fingerprintA,
      endpointFingerprint: fingerprintA,
      budgetFingerprint: fingerprintA,
      scannerFingerprint: fingerprintA,
    }],
    [{
      id: "f7777777-7777-4777-8777-777777777777",
      projectId,
      policyRevisionId: revisionId,
      operation: "projectAnalysis",
      profileFingerprint: fingerprintA,
      providerFingerprint: fingerprintA,
      modelFingerprint: fingerprintA,
      modelId: "synthetic-provider/model-v1",
      processorFingerprint: fingerprintA,
      regionFingerprint: fingerprintA,
      retentionFingerprint: fingerprintA,
      endpointFingerprint: fingerprintA,
    }],
    [{
      id: runId,
      projectId,
      status: "issued",
      policyRevisionId: revisionId,
      profileFingerprint: fingerprintA,
      providerFingerprint: fingerprintA,
      modelFingerprint: fingerprintA,
      modelId: "synthetic-provider/model-v1",
      processorFingerprint: fingerprintA,
      regionFingerprint: fingerprintA,
      retentionFingerprint: fingerprintA,
      endpointFingerprint: fingerprintA,
      grantFingerprint: fingerprintA,
      effectivePolicyVersion: 1,
      budgetFingerprint: fingerprintA,
      scannerFingerprint: fingerprintA,
      scannerVersion: "scanner-v1",
      budgetProfile: "standard",
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: null,
      expiresAtIsLive: true,
    }],
    [{ operation: "projectAnalysis" }],
    [{ sourceId: sourceAId, contentFingerprint: contentHash, contentBytes }],
    [{ sourceId: sourceAId, contentText, contentHash }],
    [],
  ];
}

const reconciliationContentText = "safe-source";
const reconciliationContentHash = hashSourceContent(reconciliationContentText);
const reconciliationContentBytes = Buffer.byteLength(reconciliationContentText, "utf8");
const reconciliationManifest = buildInputManifest([
  {
    sourceId: sourceAId,
    contentFingerprint: reconciliationContentHash,
    contentBytes: reconciliationContentBytes,
    scannerVersion: "scanner-v1",
  },
]);
const reconciliationInputManifestFingerprint = buildInputManifestFingerprint(
  reconciliationManifest,
);
const reconciliationOperationKey = buildOperationKey({
  schemaVersion: "ai-operation-key:v1",
  projectId,
  operation: "projectAnalysis",
  sourceManifest: reconciliationManifest.map((entry) => ({
    sourceId: entry.sourceId,
    contentFingerprint: entry.contentFingerprint,
    contentBytes: entry.contentBytes,
    evidenceManifestFingerprint: entry.evidenceManifestFingerprint,
  })),
  promptFingerprint: FAKE_PROFILE.promptFingerprint,
  promptVersion: FAKE_PROFILE.promptVersion,
  profileFingerprint: fingerprintA,
  providerFingerprint: fingerprintA,
  modelId: FAKE_PROFILE.modelId,
  modelFingerprint: fingerprintA,
  grantFingerprint: fingerprintA,
  effectivePolicyVersion: 1,
  processorFingerprint: fingerprintA,
  processorEndpointFingerprint: fingerprintA,
  processorRegionFingerprint: fingerprintA,
  processorRetentionFingerprint: fingerprintA,
  noRagSnapshotMarker: "no-rag-snapshot:v1",
});

type ReconciliationRunStatus = "queued" | "running" | "succeeded";

function reconciliationRun(status: ReconciliationRunStatus): Record<string, unknown> {
  const completed = status === "succeeded";
  return {
    id: runId,
    projectId,
    grantId: runId,
    policyRevisionId: revisionId,
    operation: "projectAnalysis",
    operationKey: reconciliationOperationKey,
    operationKeySchemaVersion: "ai-operation-key:v1",
    inputManifestFingerprint: reconciliationInputManifestFingerprint,
    promptFingerprint: FAKE_PROFILE.promptFingerprint,
    promptVersion: FAKE_PROFILE.promptVersion,
    providerFingerprint: fingerprintA,
    modelId: FAKE_PROFILE.modelId,
    modelFingerprint: fingerprintA,
    profileFingerprint: fingerprintA,
    grantFingerprint: fingerprintA,
    effectivePolicyVersion: 1,
    processorFingerprint: fingerprintA,
    processorEndpointFingerprint: fingerprintA,
    processorRegionFingerprint: fingerprintA,
    processorRetentionFingerprint: fingerprintA,
    noRagSnapshotMarker: "no-rag-snapshot:v1",
    status,
    inputBytes: reconciliationContentBytes,
    outputBytes: 0,
    maxInputTokens: FAKE_PROFILE.maxInputTokens,
    maxOutputTokens: FAKE_PROFILE.maxOutputTokens,
    maxRequests: 1,
    maxBudgetMicros: FAKE_PROFILE.maxBudgetMicros,
    inputTokens: completed ? 3 : 0,
    outputTokens: completed ? 4 : 0,
    requestCount: status === "queued" ? 0 : 1,
    budgetUsedMicros: completed
      ? calculateFakeBudgetMicros({
          inputBytes: reconciliationContentBytes,
          outputTokens: 4,
        })
      : 0,
    pricingSnapshotId: FAKE_PROFILE.pricingSnapshotId,
    budgetStatus: status === "queued" ? "pending" : "allowed",
    safeErrorCode: null,
    httpStatus: null,
    providerRequestId: null,
    providerResponseId: null,
  };
}

function reconciliationAttempt(
  status: "sent" | "succeeded",
): Record<string, unknown> {
  const completed = status === "succeeded";
  return {
    id: attemptId,
    projectId,
    aiRunId: runId,
    attemptNumber: 1,
    dispatchToken: "dispatch-reconciliation-00000001",
    status,
    providerRequestId: null,
    providerResponseId: null,
    httpStatus: null,
    inputTokens: completed ? 3 : 0,
    outputTokens: completed ? 4 : 0,
    requestCount: 1,
    safeErrorCode: null,
  };
}

function reconciliationResponses(
  status: ReconciliationRunStatus,
  attempts: readonly Record<string, unknown>[] =
    status === "running" ? [reconciliationAttempt("sent")] :
      status === "succeeded" ? [reconciliationAttempt("succeeded")] : [],
): unknown[][] {
  const responses = preparedQueryResponses(reconciliationContentText);
  responses.pop();
  responses.push(
    [reconciliationRun(status)],
    [{
      sourceId: sourceAId,
      contentFingerprint: reconciliationContentHash,
      contentBytes: reconciliationContentBytes,
      scannerVersion: "scanner-v1",
      safeScanResult: "passed",
      evidenceManifestFingerprint: reconciliationManifest[0]?.evidenceManifestFingerprint,
    }],
    [...attempts],
  );
  return responses;
}

function conflictObserverDatabase(responses: unknown[][]): {
  db: unknown;
  state: {
    isolationLevels: Prisma.TransactionIsolationLevel[];
    queryCount: number;
    writeCount: number;
  };
} {
  const state = {
    isolationLevels: [] as Prisma.TransactionIsolationLevel[],
    queryCount: 0,
    writeCount: 0,
  };
  const pendingResponses = [...responses];
  const recordWrite = async (): Promise<Record<string, never>> => {
    state.writeCount += 1;
    return {};
  };
  const observerTransaction = {
    $queryRaw: async () => {
      state.queryCount += 1;
      return pendingResponses.shift() ?? [];
    },
    $executeRaw: recordWrite,
    aiAuditEvent: { create: recordWrite },
    aiRun: { create: recordWrite },
    aiRunInputSource: { create: recordWrite },
  };
  return {
    db: {
      $transaction: async (
        callback: (transaction: unknown) => Promise<unknown>,
        options: { isolationLevel: Prisma.TransactionIsolationLevel },
      ) => {
        state.isolationLevels.push(options.isolationLevel);
        if (state.isolationLevels.length <= 3) {
          throw { code: "P2034" };
        }
        return callback(observerTransaction);
      },
    },
    state,
  };
}

function completionLockOrderDatabase(): {
  db: unknown;
  state: {
    isolationLevels: Prisma.TransactionIsolationLevel[];
    completionQueries: string[];
    completionEvents: string[];
    auditWrites: number;
    auditData: unknown[];
  };
} {
  const claimResponses = reconciliationResponses("queued");
  const completionResponses: unknown[][] = [
    [{ id: projectId }],
    [{ id: revisionId, projectId, outboundEnabled: false }],
    [{ id: runId, projectId, status: "revoked" }],
    [reconciliationRun("running")],
    [{
      sourceId: sourceAId,
      contentFingerprint: reconciliationContentHash,
      contentBytes: reconciliationContentBytes,
      scannerVersion: "scanner-v1",
      safeScanResult: "passed",
      evidenceManifestFingerprint: reconciliationManifest[0]?.evidenceManifestFingerprint,
    }],
    [{ ...reconciliationAttempt("sent"), dispatchToken: `dispatch-${attemptId}` }],
  ];
  const state = {
    isolationLevels: [] as Prisma.TransactionIsolationLevel[],
    completionQueries: [] as string[],
    completionEvents: [] as string[],
    auditWrites: 0,
    auditData: [] as unknown[],
  };

  const sqlText = (value: unknown): string => {
    if (typeof value !== "object" || value === null) {
      return "";
    }
    const strings = (value as { strings?: unknown }).strings;
    if (
      !Array.isArray(strings) ||
      !strings.every((part) => typeof part === "string")
    ) {
      return "";
    }
    return strings.join("");
  };

  const makeTransaction = (
    responses: unknown[][],
    completion: boolean,
  ) => ({
    $queryRaw: async (query: unknown) => {
      const text = sqlText(query);
      if (completion) {
        state.completionQueries.push(text);
        state.completionEvents.push(`query:${text}`);
      }
      return responses.shift() ?? [];
    },
    $executeRaw: async () => {
      if (completion) {
        state.completionEvents.push("write");
      }
      return 1;
    },
    aiAuditEvent: {
      create: async (value: unknown) => {
        if (completion) {
          state.auditWrites += 1;
          state.auditData.push(value);
          state.completionEvents.push("audit");
        }
        return {};
      },
    },
    aiRun: { create: async () => ({}) },
    aiRunInputSource: { create: async () => ({}) },
  });

  const claimTransaction = makeTransaction(claimResponses, false);
  const completionTransaction = makeTransaction(completionResponses, true);
  let transactionNumber = 0;
  return {
    db: {
      $transaction: async (
        callback: (transaction: unknown) => Promise<unknown>,
        options: { isolationLevel: Prisma.TransactionIsolationLevel },
      ) => {
        state.isolationLevels.push(options.isolationLevel);
        transactionNumber += 1;
        return callback(
          transactionNumber === 1 ? claimTransaction : completionTransaction,
        );
      },
    },
    state,
  };
}

function fakePreparedDb(contentText = "safe-source"): {
  db: unknown;
  audits: unknown[];
  creates: { runs: number; inputs: number };
} {
  const responses = preparedQueryResponses(contentText);
  const audits: unknown[] = [];
  const creates = { runs: 0, inputs: 0 };
  const tx = {
    $queryRaw: async () => responses.shift() ?? [],
    aiAuditEvent: {
      create: async (value: unknown) => {
        audits.push(value);
        return value;
      },
    },
    aiRun: {
      create: async () => {
        creates.runs += 1;
        return {};
      },
    },
    aiRunInputSource: {
      create: async () => {
        creates.inputs += 1;
        return {};
      },
    },
  };
  return {
    db: {
      $transaction: async (
        callback: (transaction: unknown) => Promise<unknown>,
      ) => callback(tx),
    },
    audits,
    creates,
  };
}

function operationKeyForTestManifest(manifest: InputManifest): string {
  return buildOperationKey({
    schemaVersion: "ai-operation-key:v1",
    projectId,
    operation: "projectAnalysis",
    sourceManifest: manifest.map((entry) => ({
      sourceId: entry.sourceId,
      contentFingerprint: entry.contentFingerprint,
      contentBytes: entry.contentBytes,
      evidenceManifestFingerprint: entry.evidenceManifestFingerprint,
    })),
    promptFingerprint: FAKE_PROFILE.promptFingerprint,
    promptVersion: FAKE_PROFILE.promptVersion,
    profileFingerprint: fingerprintA,
    providerFingerprint: fingerprintA,
    modelId: FAKE_PROFILE.modelId,
    modelFingerprint: fingerprintA,
    grantFingerprint: fingerprintA,
    effectivePolicyVersion: 1,
    processorFingerprint: fingerprintA,
    processorEndpointFingerprint: fingerprintA,
    processorRegionFingerprint: fingerprintA,
    processorRetentionFingerprint: fingerprintA,
    noRagSnapshotMarker: "no-rag-snapshot:v1",
  });
}

function queuedClosureResponses(
  liveFailure: "policy" | "grant",
): unknown[][] {
  const prepared = preparedQueryResponses(reconciliationContentText);
  const currentRevision = prepared[2]?.[0];
  const currentOperationProfile = prepared[3]?.[0];
  const currentGrant = {
    ...(prepared[4]?.[0] as Record<string, unknown>),
    ...(liveFailure === "grant" ? { status: "revoked" } : {}),
  };
  const frozenRevision = prepared[2]?.[0];
  const frozenGrant = prepared[4]?.[0];
  return [
    [{ id: projectId }],
    [{ currentRevisionId: revisionId }],
    [currentRevision],
    ...(liveFailure === "policy"
      ? [[]]
      : [[currentOperationProfile], [currentGrant]]),
    [{
      id: runId,
      projectId,
      grantId: runId,
      policyRevisionId: revisionId,
      operation: "projectAnalysis",
      operationKey: reconciliationOperationKey,
    }],
    [{ id: projectId }],
    [frozenRevision],
    [frozenGrant],
    [reconciliationRun("queued")],
    [{
      sourceId: sourceAId,
      contentFingerprint: reconciliationContentHash,
      contentBytes: reconciliationContentBytes,
      scannerVersion: "scanner-v1",
      safeScanResult: "passed",
      evidenceManifestFingerprint: reconciliationManifest[0]?.evidenceManifestFingerprint,
    }],
    [],
  ];
}

function oversizedQueuedClosureResponses(): {
  responses: unknown[][];
  operationKey: string;
} {
  const contentText = "x".repeat(FAKE_PROFILE.maxInputBytes + 1);
  const contentFingerprint = hashSourceContent(contentText);
  const contentBytes = Buffer.byteLength(contentText, "utf8");
  const manifest = buildInputManifest([{
    sourceId: sourceAId,
    contentFingerprint,
    contentBytes,
    scannerVersion: "scanner-v1",
  }]);
  const operationKey = operationKeyForTestManifest(manifest);
  const run = {
    ...reconciliationRun("queued"),
    operationKey,
    inputManifestFingerprint: buildInputManifestFingerprint(manifest),
    inputBytes: contentBytes,
  };
  const prepared = preparedQueryResponses(contentText);
  prepared.pop();
  prepared.push(
    [run],
    [{
      sourceId: sourceAId,
      contentFingerprint,
      contentBytes,
      scannerVersion: "scanner-v1",
      safeScanResult: "passed",
      evidenceManifestFingerprint: manifest[0]?.evidenceManifestFingerprint,
    }],
    [],
  );
  return { responses: prepared, operationKey };
}

function closureDatabase(responses: unknown[][]): {
  db: unknown;
  state: {
    queries: string[];
    writes: string[];
    audits: unknown[];
  };
} {
  const pendingResponses = [...responses];
  const state = { queries: [] as string[], writes: [] as string[], audits: [] as unknown[] };
  const sqlText = (value: unknown): string => {
    if (typeof value !== "object" || value === null) {
      return "";
    }
    const strings = (value as { strings?: unknown }).strings;
    return Array.isArray(strings) && strings.every((part) => typeof part === "string")
      ? strings.join("")
      : "";
  };
  const tx = {
    $queryRaw: async (query: unknown) => {
      state.queries.push(sqlText(query));
      return pendingResponses.shift() ?? [];
    },
    $executeRaw: async (query: unknown) => {
      state.writes.push(sqlText(query));
      return 1;
    },
    aiAuditEvent: {
      create: async (value: unknown) => {
        state.audits.push(value);
        return value;
      },
    },
  };
  return {
    db: {
      $transaction: async (callback: (transaction: unknown) => Promise<unknown>) =>
        callback(tx),
    },
    state,
  };
}

function source(
  sourceId: string,
  contentBytes = 12,
  contentFingerprint = fingerprintA,
  scannerVersion = "scanner-v1",
): EvidenceManifestEntry {
  return { sourceId, contentFingerprint, contentBytes, scannerVersion };
}

function inputForManifest(manifest: InputManifest): FakeAdmissibilityInput {
  return {
    projectId,
    runId,
    operationKey: fingerprintA,
    inputManifest: manifest,
    inputManifestFingerprint: buildInputManifestFingerprint(manifest),
  };
}

function assertServiceError(action: () => unknown, code: string): void {
  assert.throws(
    action,
    (error: unknown) =>
      error instanceof AiRuntimeServiceError &&
      error.code === code &&
      error.message === code,
  );
}

test("prepare request parsing is exact, canonical, and database-free", () => {
  const parsed = parsePrepareOrGetRequest({
    projectId,
    grantId: runId,
    operation: "projectAnalysis",
    sourceIds: [sourceBId, sourceAId],
  });
  assert.deepEqual(parsed, {
    projectId,
    grantId: runId,
    operation: "projectAnalysis",
    sourceIds: [sourceAId, sourceBId],
  });
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed.sourceIds));

  for (const invalid of [
    { projectId, grantId: runId, operation: "projectAnalysis", sourceIds: [] },
    { projectId, grantId: runId, operation: "projectAnalysis", sourceIds: [sourceAId, sourceAId] },
    { projectId, grantId: runId, operation: "projectAnalysis", sourceIds: [sourceAId], prompt: "raw" },
    { projectId, grantId: runId, operation: "projectAnalysis", sourceIds: [sourceAId], retry: true },
    { projectId, grantId: runId, operation: "projectAnalysis", sourceIds: [sourceAId], endpoint: "https://example.invalid" },
    { projectId, grantId: runId, operation: "projectAnalysis", sourceIds: [sourceAId], apiKey: "secret" },
    { projectId, grantId: "not-a-uuid", operation: "projectAnalysis", sourceIds: [sourceAId] },
    { projectId, grantId: runId, operation: "projectAnalysis", sourceIds: [sourceAId.toUpperCase()] },
    { projectId, grantId: runId, operation: "not-an-operation", sourceIds: [sourceAId] },
  ]) {
    assertServiceError(
      () => parsePrepareOrGetRequest(invalid),
      "AI_INVALID_OPERATION_KEY_INPUT",
    );
  }

  let transactionCalled = false;
  const service = createAiRuntimeService({
    db: {
      $transaction: async () => {
        transactionCalled = true;
        throw new Error("must not run");
      },
    } as never,
    admissibilityGate: { assess: () => { throw new Error("must not run"); } },
  });
  return service.prepareOrGetRun({
    projectId,
    grantId: runId,
    operation: "projectAnalysis",
    sourceIds: [sourceAId],
    body: "raw",
  }).then(
    () => { throw new Error("invalid request must reject"); },
    (error: unknown) => {
      assert.ok(error instanceof AiRuntimeServiceError);
      assert.equal(error.code, "AI_INVALID_OPERATION_KEY_INPUT");
      assert.equal(transactionCalled, false);
    },
  );
});

test("claim request is exact and absent provider fails closed without a transaction", async () => {
  const valid = {
    projectId,
    grantId: runId,
    operation: "projectAnalysis" as const,
    sourceIds: [sourceAId],
    runId,
    operationKey: fingerprintA,
  };
  assert.deepEqual(parseClaimAndDispatchRunRequest({ ...valid, sourceIds: [sourceAId] }), valid);

  let transactionCalled = false;
  const service = createAiRuntimeService({
    db: {
      $transaction: async () => {
        transactionCalled = true;
        throw new Error("must not run");
      },
    } as never,
    admissibilityGate: { assess: () => { throw new Error("must not run"); } },
  });
  assert.deepEqual(await service.claimAndDispatchRun(valid), {
    kind: "rejected",
    status: "failed",
    runId,
    operationKey: fingerprintA,
    safeCode: "AI_PROVIDER_DISABLED",
  });
  assert.deepEqual(await service.execute({
    projectId,
    grantId: runId,
    operation: "projectAnalysis",
    sourceIds: [sourceAId],
  }), {
    kind: "rejected",
    status: "failed",
    safeCode: "AI_PROVIDER_DISABLED",
  });
  assert.equal(transactionCalled, false);

  for (const invalid of [
    { ...valid, prompt: "raw" },
    { ...valid, body: "provider body" },
    { ...valid, endpoint: "https://provider.invalid" },
    { ...valid, apiKey: "secret-sentinel" },
    { ...valid, operationKey: fingerprintA.toUpperCase() },
    { ...valid, sourceIds: [sourceAId, sourceAId] },
  ]) {
    await assert.rejects(
      () => service.claimAndDispatchRun(invalid),
      (error: unknown) =>
        error instanceof AiRuntimeServiceError &&
        error.code === "AI_INVALID_OPERATION_KEY_INPUT",
    );
  }
});

test("provider normalization enforces exact terminal status and safe-code parity", () => {
  const completed = {
    runStatus: "succeeded" as const,
    attemptStatus: "succeeded" as const,
    safeCode: null,
    httpStatus: null,
    automaticRetry: false as const,
    providerRequestId: null,
    providerResponseId: null,
    usage: null,
  };
  assert.deepEqual(normalizeAiRuntimeProviderClassification(completed, 12), completed);
  assert.equal(
    normalizeAiRuntimeProviderClassification({
      ...completed,
      runStatus: "failed",
      attemptStatus: "failed",
      safeCode: "AI_PROVIDER_FAILED",
    }, 12).runStatus,
    "failed",
  );
  assert.equal(
    normalizeAiRuntimeProviderClassification({
      ...completed,
      runStatus: "failed",
      attemptStatus: "failed",
      safeCode: "AI_PROVIDER_INCOMPLETE",
    }, 12).runStatus,
    "failed",
  );
  assert.equal(
    normalizeAiRuntimeProviderClassification({
      ...completed,
      runStatus: "cancelled",
      attemptStatus: "cancelled",
      safeCode: "AI_PROVIDER_CANCELLED",
    }, 12).runStatus,
    "cancelled",
  );
  assert.equal(
    normalizeAiRuntimeProviderClassification({
      ...completed,
      runStatus: "unknown",
      attemptStatus: "unknown",
      safeCode: "AI_PROVIDER_UNKNOWN",
    }, 12).runStatus,
    "unknown",
  );

  for (const invalid of [
    { ...completed, runStatus: "failed", attemptStatus: "failed", safeCode: "AI_PROVIDER_CANCELLED" },
    { ...completed, runStatus: "cancelled", attemptStatus: "cancelled", safeCode: "AI_PROVIDER_FAILED" },
    { ...completed, runStatus: "succeeded", attemptStatus: "succeeded", safeCode: "AI_PROVIDER_FAILED" },
    { ...completed, runStatus: "unknown", attemptStatus: "unknown", safeCode: "AI_PROVIDER_FAILED" },
    { ...completed, usage: { inputTokens: 1, outputTokens: 1, requestCount: 2 } },
    { ...completed, automaticRetry: true },
  ]) {
    const normalized = normalizeAiRuntimeProviderClassification(invalid, 12);
    assert.deepEqual(normalized, {
      runStatus: "unknown",
      attemptStatus: "unknown",
      safeCode: "AI_PROVIDER_UNKNOWN",
      httpStatus: null,
      automaticRetry: false,
      providerRequestId: null,
      providerResponseId: null,
      usage: null,
    });
  }
});

test("existing run reads require service-owned Run/Attempt parity", () => {
  const run = {
    id: runId,
    projectId,
    grantId: revisionId,
    policyRevisionId: revisionId,
    operation: "projectAnalysis",
    operationKey: fingerprintA,
    operationKeySchemaVersion: "ai-operation-key:v1",
    inputManifestFingerprint: fingerprintA,
    promptFingerprint: fingerprintA,
    promptVersion: "fake-prompt-v1",
    providerFingerprint: fingerprintA,
    modelId: "synthetic-provider/model-v1",
    modelFingerprint: fingerprintA,
    profileFingerprint: fingerprintA,
    grantFingerprint: fingerprintA,
    effectivePolicyVersion: 1,
    processorFingerprint: fingerprintA,
    processorEndpointFingerprint: fingerprintA,
    processorRegionFingerprint: fingerprintA,
    processorRetentionFingerprint: fingerprintA,
    noRagSnapshotMarker: "no-rag-snapshot:v1",
    status: "succeeded",
    inputBytes: 12,
    outputBytes: 0,
    maxInputTokens: 4096,
    maxOutputTokens: 1024,
    maxRequests: 1,
    maxBudgetMicros: 1000000,
    inputTokens: 3,
    outputTokens: 4,
    requestCount: 1,
    budgetUsedMicros: 140,
    pricingSnapshotId: "fake-pricing-v1",
    budgetStatus: "allowed",
    safeErrorCode: null,
    httpStatus: 200,
    providerRequestId: "req-1",
    providerResponseId: "resp-1",
  };
  const attempt = {
    id: attemptId,
    projectId,
    aiRunId: runId,
    attemptNumber: 1,
    dispatchToken: "dispatch-safe-00000001",
    status: "succeeded",
    providerRequestId: "req-1",
    providerResponseId: "resp-1",
    httpStatus: 200,
    inputTokens: 3,
    outputTokens: 4,
    requestCount: 1,
    safeErrorCode: null,
  };
  assert.equal(isAiRuntimeRunAttemptParityValid(run, [attempt]), true);
  assert.equal(
    isAiRuntimeRunAttemptParityValid({ ...run, safeErrorCode: "AI_PROVIDER_FAILED" }, [attempt]),
    false,
  );
  assert.equal(
    isAiRuntimeRunAttemptParityValid({ ...run, outputTokens: 5 }, [attempt]),
    false,
  );
  assert.equal(
    isAiRuntimeRunAttemptParityValid({ ...run, budgetUsedMicros: 141 }, [attempt]),
    false,
  );
  assert.equal(
    isAiRuntimeRunAttemptParityValid(
      run,
      [{ ...attempt, projectId: runId }],
    ),
    false,
  );
  assert.equal(
    isAiRuntimeRunAttemptParityValid(
      run,
      [{ ...attempt, attemptNumber: 2 }],
    ),
    false,
  );
  assert.equal(
    isAiRuntimeRunAttemptParityValid({ ...run, status: "unknown", safeErrorCode: "AI_PROVIDER_UNKNOWN" }, [
      { ...attempt, status: "unknown", safeErrorCode: "AI_PROVIDER_UNKNOWN" },
    ]),
    true,
  );
  assert.equal(
    isAiRuntimeRunAttemptParityValid({
      ...run,
      status: "failed",
      safeErrorCode: "AI_BUDGET_DENIED",
      inputTokens: 0,
      outputTokens: 0,
      requestCount: 0,
      budgetUsedMicros: 0,
      budgetStatus: "rejected",
      httpStatus: null,
      providerRequestId: null,
      providerResponseId: null,
    }, []),
    true,
  );
  assert.equal(
    isAiRuntimeRunAttemptParityValid({ ...run, status: "running", safeErrorCode: null }, [
      { ...attempt, status: "sent", providerRequestId: null, providerResponseId: null, httpStatus: null, inputTokens: 0, outputTokens: 0, safeErrorCode: null },
    ]),
    false,
  );
});

test("completion failure result keeps persisted status running for reconciliation", () => {
  assert.deepEqual(
    buildAiRuntimeCompletionFailureResult(runId, fingerprintA, attemptId),
    {
      kind: "claimed",
      status: "running",
      runId,
      operationKey: fingerprintA,
      attemptId,
      safeCode: "AI_PROVIDER_UNKNOWN",
    },
  );
});

test("transaction conflict classifiers retry only bounded serialization and operation-key conflicts", () => {
  assert.equal(
    isAiRuntimeSerializationConflict(
      new Prisma.PrismaClientKnownRequestError("serialization", {
        code: "P2034",
        clientVersion: "7.10.0",
      }),
    ),
    true,
  );
  assert.equal(isAiRuntimeSerializationConflict({ code: "P2010", meta: { code: "40001" } }), true);
  assert.equal(isAiRuntimeSerializationConflict({ code: "P2010", meta: { code: "40P01" } }), true);
  assert.equal(
    isAiRuntimeSerializationConflict({
      code: "P2010",
      meta: {
        driverAdapterError: {
          cause: { originalCode: "40001" },
        },
      },
    }),
    true,
  );
  assert.equal(
    isAiRuntimeSerializationConflict({
      code: "P2010",
      meta: {
        driverAdapterError: {
          cause: { originalCode: "23505" },
        },
      },
    }),
    false,
  );
  assert.equal(isAiRuntimeSerializationConflict({ code: "P2010", meta: { code: "23505" } }), false);
  assert.equal(isAiRuntimeSerializationConflict({ code: "P2002", meta: { target: ["projectId", "operationKey"] } }), false);
  assert.equal(
    isAiRuntimeOperationKeyConflict({
      code: "P2002",
      meta: { target: ["projectId", "operationKey"] },
    }),
    true,
  );
  assert.equal(
    isAiRuntimeOperationKeyConflict({
      code: "P2002",
      meta: { target: ["operationKey", "projectId"] },
    }),
    true,
  );
  assert.equal(
    isAiRuntimeOperationKeyConflict({
      code: "P2002",
      meta: { target: "AiRun_projectId_operationKey_key" },
    }),
    true,
  );
  assert.equal(
    isAiRuntimeOperationKeyConflict(
      new Prisma.PrismaClientKnownRequestError("unique", {
        code: "P2002",
        clientVersion: "7.10.0",
        meta: {
          modelName: "AiRun",
          driverAdapterError: {
            cause: {
              kind: "UniqueConstraintViolation",
              originalCode: "23505",
              constraint: { index: "AiRun_projectId_operationKey_key" },
            },
          },
        },
      }),
    ),
    true,
  );
  assert.equal(
    isAiRuntimeSerializationConflict({
      code: "P2010",
      meta: {
        driverAdapterError: {
          cause: { originalCode: "40P01" },
        },
      },
    }),
    true,
  );
  assert.equal(
    isAiRuntimeOperationKeyConflict({
      code: "P2002",
      meta: {
        modelName: "OtherModel",
        driverAdapterError: {
          cause: {
            kind: "UniqueConstraintViolation",
            originalCode: "23505",
            constraint: { index: "AiRun_projectId_operationKey_key" },
          },
        },
      },
    }),
    false,
  );
  assert.equal(
    isAiRuntimeOperationKeyConflict({
      code: "P2002",
      meta: {
        modelName: "AiRun",
        driverAdapterError: {
          cause: {
            kind: "ForeignKeyViolation",
            originalCode: "23505",
            constraint: { index: "AiRun_projectId_operationKey_key" },
          },
        },
      },
    }),
    false,
  );
  assert.equal(
    isAiRuntimeOperationKeyConflict({
      code: "P2002",
      meta: {
        modelName: "AiRun",
        driverAdapterError: {
          cause: {
            kind: "UniqueConstraintViolation",
            originalCode: "23503",
            constraint: { index: "AiRun_projectId_operationKey_key" },
          },
        },
      },
    }),
    false,
  );
  assert.equal(
    isAiRuntimeOperationKeyConflict({
      code: "P2002",
      meta: {
        modelName: "AiRun",
        driverAdapterError: {
          cause: {
            kind: "UniqueConstraintViolation",
            originalCode: "23505",
            constraint: { index: "AiRun_projectId_id_key" },
          },
        },
      },
    }),
    false,
  );
  assert.equal(
    isAiRuntimeOperationKeyConflict({
      code: "P2002",
      meta: { target: ["projectId", "id"] },
    }),
    false,
  );
  assert.equal(
    isAiRuntimeOperationKeyConflict({
      code: "P2002",
      meta: { target: "AiRun_projectId_operationKey_key" },
    }),
    true,
  );
  assert.equal(
    isAiRuntimeOperationKeyConflict({
      code: "P2002",
      meta: { target: ["projectId", "operationKey", "otherField"] },
    }),
    false,
  );
  assert.equal(
    isAiRuntimeSerializationConflict(
      new Prisma.PrismaClientKnownRequestError("serialization", {
        code: "P2010",
        clientVersion: "7.10.0",
        meta: {
          driverAdapterError: {
            cause: { originalCode: "40001" },
          },
        },
      }),
    ),
    true,
  );
  assert.equal(
    isAiRuntimeSerializationConflict(
      new Prisma.PrismaClientKnownRequestError("deadlock", {
        code: "P2010",
        clientVersion: "7.10.0",
        meta: { code: "40P01" },
      }),
    ),
    true,
  );
  assert.equal(
    isAiRuntimeSerializationConflict({ code: "P2010", meta: { code: "40002" } }),
    false,
  );
  assert.equal(
    isAiRuntimeSerializationConflict({
      code: "P2010",
      meta: { driverAdapterError: { cause: { originalCode: "40P02" } } },
    }),
    false,
  );
  assert.equal(
    isAiRuntimeSerializationConflict({
      code: "P2010",
      meta: { driverAdapterError: { cause: { originalCode: "23505" } } },
    }),
    false,
  );

  const throwingGetter = {};
  Object.defineProperty(throwingGetter, "code", {
    get: () => {
      throw new Error("must not escape");
    },
  });
  assert.equal(isAiRuntimeSerializationConflict(throwingGetter), false);
  assert.equal(isAiRuntimeOperationKeyConflict(throwingGetter), false);
  const throwingProxy = new Proxy(
    {},
    {
      get: () => {
        throw new Error("must not escape");
      },
    },
  );
  assert.equal(isAiRuntimeSerializationConflict(throwingProxy), false);
  assert.equal(isAiRuntimeOperationKeyConflict(throwingProxy), false);
});

test("claim conflicts use one read-committed observer without dispatch or writes", async () => {
  for (const status of ["running", "succeeded"] as const) {
    const fake = conflictObserverDatabase(reconciliationResponses(status));
    let assessCalls = 0;
    let dispatchCalls = 0;
    const service = createAiRuntimeService({
      db: fake.db as never,
      admissibilityGate: {
        assess: () => {
          assessCalls += 1;
          throw new Error("observer must not assess");
        },
      },
      provider: {
        dispatch: () => {
          dispatchCalls += 1;
          throw new Error("observer must not dispatch");
        },
      },
    });
    const result = await service.claimAndDispatchRun({
      projectId,
      grantId: runId,
      operation: "projectAnalysis",
      sourceIds: [sourceAId],
      runId,
      operationKey: reconciliationOperationKey,
    });
    assert.deepEqual(result, {
      kind: "existing",
      status,
      runId,
      operationKey: reconciliationOperationKey,
      attemptId,
      safeCode: null,
    });
    assert.deepEqual(fake.state.isolationLevels, [
      Prisma.TransactionIsolationLevel.Serializable,
      Prisma.TransactionIsolationLevel.Serializable,
      Prisma.TransactionIsolationLevel.Serializable,
      Prisma.TransactionIsolationLevel.ReadCommitted,
    ]);
    assert.equal(fake.state.queryCount, 11);
    assert.equal(fake.state.writeCount, 0);
    assert.equal(assessCalls, 0);
    assert.equal(dispatchCalls, 0);
  }
});

test("claim conflict reconciliation preserves safe authorization failures and parity rejection", async () => {
  const cases: Array<{
    name: string;
    responses: unknown[][];
    safeCode: string;
  }> = [];

  const policyMismatch = reconciliationResponses("running");
  (policyMismatch[2]?.[0] as Record<string, unknown>).outboundEnabled = false;
  cases.push({
    name: "policy mismatch",
    responses: policyMismatch,
    safeCode: "AI_POLICY_DENIED",
  });

  const grantMismatch = reconciliationResponses("running");
  (grantMismatch[4]?.[0] as Record<string, unknown>).status = "revoked";
  cases.push({
    name: "grant mismatch",
    responses: grantMismatch,
    safeCode: "AI_GRANT_DENIED",
  });

  const operationProfileMismatch = reconciliationResponses("running");
  (operationProfileMismatch[3]?.[0] as Record<string, unknown>).profileFingerprint =
    fingerprintB;
  cases.push({
    name: "operation profile mismatch",
    responses: operationProfileMismatch,
    safeCode: "AI_GRANT_DENIED",
  });

  const sourceMismatch = reconciliationResponses("running");
  (sourceMismatch[7]?.[0] as Record<string, unknown>).contentHash = fingerprintB;
  cases.push({
    name: "source mismatch",
    responses: sourceMismatch,
    safeCode: "AI_GRANT_DENIED",
  });

  const operationMismatch = reconciliationResponses("running");
  operationMismatch[5] = [];
  cases.push({
    name: "operation mismatch",
    responses: operationMismatch,
    safeCode: "AI_GRANT_DENIED",
  });

  cases.push({
    name: "queued run",
    responses: reconciliationResponses("queued"),
    safeCode: "AI_INVALID_PROVIDER_RESPONSE",
  });

  cases.push({
    name: "missing attempt",
    responses: reconciliationResponses("running", []),
    safeCode: "AI_INVALID_PROVIDER_RESPONSE",
  });

  cases.push({
    name: "parity corruption",
    responses: reconciliationResponses("running", [
      { ...reconciliationAttempt("sent"), requestCount: 2 },
    ]),
    safeCode: "AI_INVALID_PROVIDER_RESPONSE",
  });

  for (const reconciliationCase of cases) {
    const fake = conflictObserverDatabase(reconciliationCase.responses);
    let assessCalls = 0;
    let dispatchCalls = 0;
    const service = createAiRuntimeService({
      db: fake.db as never,
      admissibilityGate: {
        assess: () => {
          assessCalls += 1;
          throw new Error(`${reconciliationCase.name} must not assess`);
        },
      },
      provider: {
        dispatch: () => {
          dispatchCalls += 1;
          throw new Error(`${reconciliationCase.name} must not dispatch`);
        },
      },
    });
    const result = await service.claimAndDispatchRun({
      projectId,
      grantId: runId,
      operation: "projectAnalysis",
      sourceIds: [sourceAId],
      runId,
      operationKey: reconciliationOperationKey,
    });
    assert.deepEqual(
      result,
      {
        kind: "rejected",
        status: "failed",
        runId,
        operationKey: reconciliationOperationKey,
        safeCode: reconciliationCase.safeCode,
      },
      reconciliationCase.name,
    );
    assert.equal(fake.state.isolationLevels.length, 4, reconciliationCase.name);
    assert.equal(
      fake.state.isolationLevels[3],
      Prisma.TransactionIsolationLevel.ReadCommitted,
      reconciliationCase.name,
    );
    assert.equal(fake.state.writeCount, 0, reconciliationCase.name);
    assert.equal(assessCalls, 0, reconciliationCase.name);
    assert.equal(dispatchCalls, 0, reconciliationCase.name);
  }
});

test("unrecognized claim errors do not enter reconciliation", async () => {
  const isolationLevels: Prisma.TransactionIsolationLevel[] = [];
  let transactionCalls = 0;
  const db = {
    $transaction: async (
      _callback: (transaction: unknown) => Promise<unknown>,
      options: { isolationLevel: Prisma.TransactionIsolationLevel },
    ) => {
      transactionCalls += 1;
      isolationLevels.push(options.isolationLevel);
      throw { code: "P2010", meta: { code: "23505" } };
    },
  };
  let assessCalls = 0;
  let dispatchCalls = 0;
  const service = createAiRuntimeService({
    db: db as never,
    admissibilityGate: {
      assess: () => {
        assessCalls += 1;
        throw new Error("must not assess");
      },
    },
    provider: {
      dispatch: () => {
        dispatchCalls += 1;
        throw new Error("must not dispatch");
      },
    },
  });
  assert.deepEqual(
    await service.claimAndDispatchRun({
      projectId,
      grantId: runId,
      operation: "projectAnalysis",
      sourceIds: [sourceAId],
      runId,
      operationKey: reconciliationOperationKey,
    }),
    {
      kind: "rejected",
      status: "failed",
      runId,
      operationKey: reconciliationOperationKey,
      safeCode: "AI_INVALID_PROVIDER_RESPONSE",
    },
  );
  assert.equal(transactionCalls, 1);
  assert.deepEqual(isolationLevels, [Prisma.TransactionIsolationLevel.Serializable]);
  assert.equal(assessCalls, 0);
  assert.equal(dispatchCalls, 0);
});

test("completion locks frozen audit parents before Run and Attempt and ignores live policy state", async () => {
  const fake = completionLockOrderDatabase();
  let gateCalls = 0;
  const gate = new FakeAdmissibilityGate();
  const provider = new FakeProviderRecorder();
  const service = createAiRuntimeService({
    db: fake.db as never,
    admissibilityGate: {
      assess: (value: unknown) => {
        gateCalls += 1;
        return gate.assess(value);
      },
    },
    provider,
    transactionRetryLimit: 1,
    idFactory: () => attemptId,
  });

  const result = await service.claimAndDispatchRun({
    projectId,
    grantId: runId,
    operation: "projectAnalysis",
    sourceIds: [sourceAId],
    runId,
    operationKey: reconciliationOperationKey,
  });

  assert.deepEqual(result, {
    kind: "claimed",
    status: "succeeded",
    runId,
    operationKey: reconciliationOperationKey,
    attemptId,
    safeCode: null,
  });
  assert.equal(provider.count, 1);
  assert.equal(gateCalls, 1);
  assert.deepEqual(fake.state.isolationLevels, [
    Prisma.TransactionIsolationLevel.Serializable,
    Prisma.TransactionIsolationLevel.Serializable,
  ]);
  assert.equal(fake.state.completionQueries.length, 6);
  assert.match(fake.state.completionQueries[0] ?? "", /FROM "Project"[\s\S]*FOR UPDATE/);
  assert.match(
    fake.state.completionQueries[1] ?? "",
    /FROM "ProjectAiPolicyRevision"[\s\S]*FOR KEY SHARE/,
  );
  assert.match(
    fake.state.completionQueries[2] ?? "",
    /FROM "ModelProcessingGrant"[\s\S]*FOR KEY SHARE/,
  );
  assert.match(fake.state.completionQueries[3] ?? "", /FROM "AiRun"[\s\S]*FOR UPDATE/);
  assert.match(
    fake.state.completionQueries[5] ?? "",
    /FROM "AiRunAttempt"[\s\S]*FOR UPDATE/,
  );
  assert.doesNotMatch(
    fake.state.completionQueries.join("\n"),
    /FROM "ProjectAiPolicy"\s/,
  );
  const firstWrite = fake.state.completionEvents.findIndex((event) => event === "write");
  assert.equal(firstWrite, 6);
  assert.equal(fake.state.auditWrites, 2);
  assert.deepEqual(
    fake.state.auditData.map(
      (entry) => (entry as { data: { safeCode: unknown } }).data.safeCode,
    ),
    [null, null],
  );
});

test("terminal unknown audits use the generated Prisma safe-code enum value", async () => {
  const fake = completionLockOrderDatabase();
  const service = createAiRuntimeService({
    db: fake.db as never,
    admissibilityGate: new FakeAdmissibilityGate(),
    provider: {
      dispatch: () => ({
        runStatus: "unknown" as const,
        attemptStatus: "unknown" as const,
        safeCode: "AI_PROVIDER_UNKNOWN" as const,
        httpStatus: null,
        automaticRetry: false as const,
        providerRequestId: null,
        providerResponseId: null,
        usage: null,
      }),
    },
    transactionRetryLimit: 1,
    idFactory: () => attemptId,
  });

  const result = await service.claimAndDispatchRun({
    projectId,
    grantId: runId,
    operation: "projectAnalysis",
    sourceIds: [sourceAId],
    runId,
    operationKey: reconciliationOperationKey,
  });

  assert.equal(result.kind, "claimed");
  assert.equal(result.status, "unknown");
  assert.equal(result.safeCode, "AI_PROVIDER_UNKNOWN");
  assert.deepEqual(
    fake.state.auditData.map(
      (entry) => (entry as { data: { safeCode: unknown } }).data.safeCode,
    ),
    [
      DbAiSafeErrorCodeValue.aiProviderUnknown,
      DbAiSafeErrorCodeValue.aiProviderUnknown,
    ],
  );
});

test("prepare gate output is sealed to the grant scanner and safe outcome matrix", async () => {
  const request = {
    projectId,
    grantId: runId,
    operation: "projectAnalysis" as const,
    sourceIds: [sourceAId],
  };
  const invalidGateResults = [
    {
      label: "scanner version drift",
      mutate: (result: Record<string, unknown>) => {
        result.scannerVersion = "scanner-v2";
      },
    },
    {
      label: "admissible blocked scan",
      mutate: (result: Record<string, unknown>) => {
        result.safeScanResult = "blocked";
      },
    },
    {
      label: "scanner denial passed scan",
      mutate: (result: Record<string, unknown>) => {
        result.admissible = false;
        result.safeCode = "AI_SCANNER_DENIED";
      },
    },
    {
      label: "budget denial blocked scan",
      mutate: (result: Record<string, unknown>) => {
        result.admissible = false;
        result.safeCode = "AI_BUDGET_DENIED";
        result.safeScanResult = "blocked";
      },
    },
  ] as const;

  for (const invalidResult of invalidGateResults) {
    const fake = fakePreparedDb();
    const service = createAiRuntimeService({
      db: fake.db as never,
      admissibilityGate: {
        assess: (input: unknown) => {
          const safeInput = input as Record<string, unknown>;
          const result: Record<string, unknown> = {
            admissible: true,
            projectId: safeInput.projectId,
            runId: safeInput.runId,
            operationKey: safeInput.operationKey,
            inputManifestFingerprint: safeInput.inputManifestFingerprint,
            inputBytes: sumInputBytes(safeInput.inputManifest),
            sourceCount: 1,
            scannerVersion: "scanner-v1",
            safeScanResult: "passed",
            safeCode: null,
          };
          invalidResult.mutate(result);
          return result as never;
        },
      },
    });
    const result = await service.prepareOrGetRun(request);
    assert.equal(result.kind, "rejected", invalidResult.label);
    assert.equal(result.safeCode, "AI_INVALID_PROVIDER_RESPONSE", invalidResult.label);
    assert.equal(fake.creates.runs, 0, invalidResult.label);
    assert.equal(fake.audits.length, 0, invalidResult.label);
  }
});

test("prepare performs its own fake profile budget gate before injected assessment", async () => {
  const oversizedContent = "x".repeat(FAKE_PROFILE.maxInputBytes + 1);
  const fake = fakePreparedDb(oversizedContent);
  let assessCalls = 0;
  const service = createAiRuntimeService({
    db: fake.db as never,
    admissibilityGate: {
      assess: () => {
        assessCalls += 1;
        throw new Error("injected gate must not run");
      },
    },
  });
  const result = await service.prepareOrGetRun({
    projectId,
    grantId: runId,
    operation: "projectAnalysis",
    sourceIds: [sourceAId],
  });
  assert.deepEqual(result, {
    kind: "rejected",
    status: "failed",
    safeCode: "AI_BUDGET_DENIED",
    operationKey: result.operationKey,
    inputManifestFingerprint: result.inputManifestFingerprint,
  });
  assert.equal(assessCalls, 0);
  assert.equal(fake.creates.runs, 0);
  assert.equal(fake.audits.length, 1);
  assert.equal(
    (fake.audits[0] as { data: { safeCode: unknown } }).data.safeCode,
    DbAiSafeErrorCodeValue.aiBudgetDenied,
  );
});

test("preflight scanner audits use the generated Prisma safe-code enum value", async () => {
  const fake = fakePreparedDb();
  const service = createAiRuntimeService({
    db: fake.db as never,
    admissibilityGate: {
      assess: (value: unknown) => {
        const input = value as {
          projectId: string;
          runId: string;
          operationKey: string;
          inputManifestFingerprint: string;
        };
        return {
          admissible: false,
          projectId: input.projectId,
          runId: input.runId,
          operationKey: input.operationKey,
          inputManifestFingerprint: input.inputManifestFingerprint,
          inputBytes: 11,
          sourceCount: 1,
          scannerVersion: "scanner-v1",
          safeScanResult: "blocked",
          safeCode: "AI_SCANNER_DENIED",
        };
      },
    },
  });
  const result = await service.prepareOrGetRun({
    projectId,
    grantId: runId,
    operation: "projectAnalysis",
    sourceIds: [sourceAId],
  });
  assert.equal(result.kind, "rejected");
  assert.equal(result.safeCode, "AI_SCANNER_DENIED");
  assert.equal(fake.audits.length, 1);
  assert.equal(
    (fake.audits[0] as { data: { safeCode: unknown } }).data.safeCode,
    DbAiSafeErrorCodeValue.aiScannerDenied,
  );
});

test("queued policy and grant failures close one frozen Run without dispatch", async () => {
  for (const liveFailure of ["policy", "grant"] as const) {
    const fake = closureDatabase(queuedClosureResponses(liveFailure));
    let gateCalls = 0;
    let dispatchCalls = 0;
    const service = createAiRuntimeService({
      db: fake.db as never,
      admissibilityGate: {
        assess: () => {
          gateCalls += 1;
          throw new Error("policy/grant closure must not assess");
        },
      },
      provider: {
        dispatch: () => {
          dispatchCalls += 1;
          throw new Error("policy/grant closure must not dispatch");
        },
      },
    });
    const result = await service.claimAndDispatchRun({
      projectId,
      grantId: runId,
      operation: "projectAnalysis",
      sourceIds: [sourceAId],
      runId,
      operationKey: reconciliationOperationKey,
    });
    const safeCode = liveFailure === "policy"
      ? "AI_POLICY_DENIED"
      : "AI_GRANT_DENIED";
    assert.deepEqual(result, {
      kind: "rejected",
      status: "failed",
      runId,
      operationKey: reconciliationOperationKey,
      safeCode,
    });
    assert.equal(gateCalls, 0);
    assert.equal(dispatchCalls, 0);
    assert.equal(fake.state.writes.length, 1);
    assert.equal(fake.state.audits.length, 1);
    const audit = (fake.state.audits[0] as { data: Record<string, unknown> }).data;
    assert.equal(audit.eventType, "runCancelled");
    assert.equal(audit.safeCode, liveFailure === "policy"
      ? DbAiSafeErrorCodeValue.aiPolicyDenied
      : DbAiSafeErrorCodeValue.aiGrantDenied);
    assert.equal(audit.policyRevisionId, revisionId);
    assert.equal(audit.grantId, runId);
    assert.equal(audit.aiRunId, runId);
    assert.equal(audit.attemptId, null);
    assert.equal(audit.eventFingerprint, reconciliationOperationKey);
    assert.equal(audit.requestCount, 0);
    if (liveFailure === "policy") {
      assert.match(fake.state.queries[0] ?? "", /FROM "Project"[\s\S]*FOR UPDATE/);
      assert.match(fake.state.queries[1] ?? "", /FROM "ProjectAiPolicy"[\s\S]*FOR UPDATE/);
      assert.match(fake.state.queries[2] ?? "", /FROM "ProjectAiPolicyRevision"[\s\S]*FOR KEY SHARE/);
      assert.match(fake.state.queries[3] ?? "", /FROM "ProjectAiPolicyOperationProfile"[\s\S]*FOR KEY SHARE/);
      assert.match(fake.state.queries[4] ?? "", /FROM "AiRun"[\s\S]*operationKey/);
      assert.match(fake.state.queries[5] ?? "", /FROM "Project"[\s\S]*FOR UPDATE/);
      assert.match(fake.state.queries[6] ?? "", /FROM "ProjectAiPolicyRevision"[\s\S]*FOR KEY SHARE/);
      assert.match(fake.state.queries[7] ?? "", /FROM "ModelProcessingGrant"[\s\S]*FOR KEY SHARE/);
      assert.match(fake.state.queries[8] ?? "", /FROM "AiRun"[\s\S]*FOR UPDATE/);
      assert.match(fake.state.queries[10] ?? "", /FROM "AiRunAttempt"[\s\S]*FOR UPDATE/);
    }
  }
});

test("queued scanner and pre-budget denials close exactly once with safe budget state", async () => {
  const scannerFake = closureDatabase(reconciliationResponses("queued"));
  let scannerGateCalls = 0;
  let scannerDispatchCalls = 0;
  const blockedGate = new FakeAdmissibilityGate({ scanResult: "blocked" });
  const scannerService = createAiRuntimeService({
    db: scannerFake.db as never,
    admissibilityGate: {
      assess: (value: unknown) => {
        scannerGateCalls += 1;
        return blockedGate.assess(value);
      },
    },
    provider: {
      dispatch: () => {
        scannerDispatchCalls += 1;
        throw new Error("scanner closure must not dispatch");
      },
    },
  });
  const scannerResult = await scannerService.claimAndDispatchRun({
    projectId,
    grantId: runId,
    operation: "projectAnalysis",
    sourceIds: [sourceAId],
    runId,
    operationKey: reconciliationOperationKey,
  });
  assert.equal(scannerResult.kind, "rejected");
  assert.equal(scannerResult.safeCode, "AI_SCANNER_DENIED");
  assert.equal(scannerGateCalls, 1);
  assert.equal(scannerDispatchCalls, 0);
  assert.equal(scannerFake.state.writes.length, 1);
  assert.equal(scannerFake.state.audits.length, 1);
  const scannerAudit = (scannerFake.state.audits[0] as { data: Record<string, unknown> }).data;
  assert.equal(scannerAudit.eventType, "runFailed");
  assert.equal(scannerAudit.safeCode, DbAiSafeErrorCodeValue.aiScannerDenied);
  assert.equal(scannerAudit.attemptId, null);
  assert.match(scannerFake.state.writes[0] ?? "", /'pending'::"AiBudgetStatus"/);

  const oversized = oversizedQueuedClosureResponses();
  const budgetFake = closureDatabase(oversized.responses);
  let budgetGateCalls = 0;
  let budgetDispatchCalls = 0;
  const budgetService = createAiRuntimeService({
    db: budgetFake.db as never,
    admissibilityGate: {
      assess: () => {
        budgetGateCalls += 1;
        throw new Error("pre-budget closure must not assess");
      },
    },
    provider: {
      dispatch: () => {
        budgetDispatchCalls += 1;
        throw new Error("budget closure must not dispatch");
      },
    },
  });
  const budgetResult = await budgetService.claimAndDispatchRun({
    projectId,
    grantId: runId,
    operation: "projectAnalysis",
    sourceIds: [sourceAId],
    runId,
    operationKey: oversized.operationKey,
  });
  assert.equal(budgetResult.kind, "rejected");
  assert.equal(budgetResult.safeCode, "AI_BUDGET_DENIED");
  assert.equal(budgetGateCalls, 0);
  assert.equal(budgetDispatchCalls, 0);
  assert.equal(budgetFake.state.writes.length, 1);
  assert.equal(budgetFake.state.audits.length, 1);
  const budgetAudit = (budgetFake.state.audits[0] as { data: Record<string, unknown> }).data;
  assert.equal(budgetAudit.eventType, "runFailed");
  assert.equal(budgetAudit.safeCode, DbAiSafeErrorCodeValue.aiBudgetDenied);
  assert.equal(budgetAudit.attemptId, null);
  assert.match(budgetFake.state.writes[0] ?? "", /'rejected'::"AiBudgetStatus"/);
});

test("prepare normalizes invalid generated identifiers to a provider-safe error", async () => {
  const fake = fakePreparedDb();
  let assessCalls = 0;
  const service = createAiRuntimeService({
    db: fake.db as never,
    idFactory: () => "not-a-uuid",
    admissibilityGate: {
      assess: () => {
        assessCalls += 1;
        throw new Error("must not run");
      },
    },
  });
  const result = await service.prepareOrGetRun({
    projectId,
    grantId: runId,
    operation: "projectAnalysis",
    sourceIds: [sourceAId],
  });
  assert.deepEqual(result, {
    kind: "rejected",
    status: "failed",
    safeCode: "AI_INVALID_PROVIDER_RESPONSE",
  });
  assert.equal(assessCalls, 0);
  assert.equal(fake.audits.length, 0);
});

test("manifest fingerprints are versioned, deterministic, and field-sensitive", () => {
  const first = source(sourceAId);
  const second = source(sourceBId, 13, fingerprintB, "scanner-v2");
  const firstFingerprint = buildEvidenceManifestFingerprint(first);
  assert.match(firstFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(firstFingerprint, buildEvidenceManifestFingerprint({ ...first }));

  for (const mutation of [
    { ...first, sourceId: sourceBId },
    { ...first, contentFingerprint: fingerprintB },
    { ...first, contentBytes: 13 },
    { ...first, scannerVersion: "scanner-v2" },
  ]) {
    assert.notEqual(buildEvidenceManifestFingerprint(mutation), firstFingerprint);
  }

  const firstManifest = buildInputManifest([first, second]);
  const reversedManifest = buildInputManifest([second, first]);
  assert.deepEqual(
    firstManifest.map((entry) => entry.sourceId),
    [sourceAId, sourceBId],
  );
  assert.equal(
    buildInputManifestFingerprint(firstManifest),
    buildInputManifestFingerprint(reversedManifest),
  );
  assert.equal(sumInputBytes(firstManifest), 25);
  assert.ok(Object.isFrozen(firstManifest));
  assert.ok(Object.isFrozen(firstManifest[0]));
});

test("manifest equality validates the exact persisted child set", () => {
  const manifest = buildInputManifest([source(sourceAId), source(sourceBId)]);
  const reordered = buildInputManifest([source(sourceBId), source(sourceAId)]);
  assert.equal(inputManifestsEqual(manifest, reordered), true);
  assertExactInputManifest(manifest, reordered);
  assert.equal(
    inputManifestsEqual(manifest, buildInputManifest([source(sourceAId, 13)])),
    false,
  );
  assertServiceError(
    () =>
      assertExactInputManifest(manifest, [
        { ...manifest[0], evidenceManifestFingerprint: fingerprintB },
        manifest[1],
      ]),
    "AI_INVALID_OPERATION_KEY_INPUT",
  );
});

test("manifest runtime validation rejects raw, extra, non-NFC, invalid, and overflowing values", () => {
  const valid = source(sourceAId);
  const invalidEntries: unknown[] = [
    { ...valid, extra: "not allowed" },
    { ...valid, sourceId: sourceAId.toUpperCase() },
    { ...valid, sourceId: "not-a-uuid" },
    { ...valid, contentFingerprint: fingerprintA.toUpperCase() },
    { ...valid, contentBytes: -1 },
    { ...valid, contentBytes: Number.NaN },
    { ...valid, contentBytes: Number.POSITIVE_INFINITY },
    { ...valid, contentBytes: "12" },
    { ...valid, scannerVersion: "scanner-e\u0301" },
    { ...valid, scannerVersion: "scanner\u0001" },
    { ...valid, scannerVersion: "https://scanner.invalid" },
    { ...valid, scannerVersion: "scanner-token-v1" },
    { ...valid, scannerVersion: "scanner v1" },
  ];
  for (const entry of invalidEntries) {
    assertServiceError(() => buildInputManifest([entry]), "AI_INVALID_OPERATION_KEY_INPUT");
  }
  assertServiceError(() => buildInputManifest([]), "AI_INVALID_OPERATION_KEY_INPUT");
  assertServiceError(
    () => buildInputManifest([valid, valid]),
    "AI_INVALID_OPERATION_KEY_INPUT",
  );
  assertServiceError(
    () => sumInputBytes(buildInputManifest([source(sourceAId, Number.MAX_SAFE_INTEGER), source(sourceBId, 1)])),
    "AI_INVALID_OPERATION_KEY_INPUT",
  );
});

test("fixed fake profile and budget are immutable, deterministic, and capped", () => {
  assert.strictEqual(FAKE_PROFILE, FAKE_OPERATION_PROFILE);
  assert.ok(Object.isFrozen(FAKE_PROFILE));
  for (const value of [
    FAKE_PROFILE.profileFingerprint,
    FAKE_PROFILE.providerFingerprint,
    FAKE_PROFILE.modelFingerprint,
    FAKE_PROFILE.promptFingerprint,
  ]) {
    assert.match(value, /^[0-9a-f]{64}$/);
  }
  assert.equal(FAKE_PROFILE.modelId, "synthetic-provider/model-v1");
  assert.equal(FAKE_PROFILE.maxRequests, 1);
  assert.equal(
    calculateFakeBudgetMicros({ inputBytes: 12, outputTokens: 3 }),
    calculateFakeBudgetMicros({ inputBytes: 12, outputTokens: 3 }),
  );
  assert.notEqual(
    calculateFakeBudgetMicros({ inputBytes: 13, outputTokens: 3 }),
    calculateFakeBudgetMicros({ inputBytes: 12, outputTokens: 3 }),
  );
  assert.notEqual(calculateFakeBudgetMicros(12, 4), calculateFakeBudgetMicros(12, 3));
  assertServiceError(
    () => calculateFakeBudgetMicros({ inputBytes: 12, outputTokens: 3, extra: 1 } as never),
    "AI_BUDGET_DENIED",
  );
  assertServiceError(
    () => calculateFakeBudgetMicros(FAKE_PROFILE.maxInputBytes + 1),
    "AI_BUDGET_DENIED",
  );
  assertServiceError(
    () => assertFakeInputWithinProfile(FAKE_PROFILE.maxInputBytes + 1),
    "AI_BUDGET_DENIED",
  );
});

test("fake admissibility accepts only canonical metadata and records safe outcomes", () => {
  const manifest = buildInputManifest([source(sourceAId)]);
  const input = inputForManifest(manifest);
  const recorder = new FakeAdmissibilityRecorder();
  const gate = new FakeAdmissibilityGate({ recorder });
  const result = gate.assess(input);
  assert.deepEqual(result, {
    admissible: true,
    projectId,
    runId,
    operationKey: fingerprintA,
    inputManifestFingerprint: input.inputManifestFingerprint,
    inputBytes: 12,
    sourceCount: 1,
    scannerVersion: "scanner-v1",
    safeScanResult: "passed",
    safeCode: null,
  });
  assert.equal(recorder.count, 1);
  assert.ok(Object.isFrozen(recorder.records));
  assert.doesNotMatch(JSON.stringify(recorder.records), /source content|prompt|provider body|secret/i);

  assertServiceError(
    () => gate.assess({ ...input, sourceText: "must never be accepted" } as never),
    "AI_INVALID_OPERATION_KEY_INPUT",
  );
  assertServiceError(
    () => gate.assess({ ...input, inputManifestFingerprint: fingerprintB }),
    "AI_INVALID_OPERATION_KEY_INPUT",
  );

  for (const invalid of [
    { ...result, sourceText: "raw source" },
    { ...result, prompt: "raw prompt" },
    { ...result, safeCode: "provider body" },
    { ...result, operationKey: "secret-sentinel" },
  ]) {
    assertServiceError(
      () => recorder.record(invalid),
      "AI_INVALID_OPERATION_KEY_INPUT",
    );
  }
  assert.equal(recorder.count, 1);
});

test("fake admissibility returns stable scanner and budget decisions", () => {
  const scannerMismatch = buildInputManifest([source(sourceAId, 12, fingerprintA, "scanner-v2")]);
  const scannerResult = assessFakeInput(inputForManifest(scannerMismatch));
  assert.equal(scannerResult.admissible, false);
  assert.equal(scannerResult.safeScanResult, "blocked");
  assert.equal(scannerResult.safeCode, "AI_SCANNER_DENIED");

  const blocked = assessFakeInput(inputForManifest(buildInputManifest([source(sourceAId)])), {
    scanResult: "blocked",
  });
  assert.deepEqual(
    { admissible: blocked.admissible, safeScanResult: blocked.safeScanResult, safeCode: blocked.safeCode },
    { admissible: false, safeScanResult: "blocked", safeCode: "AI_SCANNER_DENIED" },
  );
  const unavailable = assessFakeInput(inputForManifest(buildInputManifest([source(sourceAId)])), {
    scanResult: "unavailable",
  });
  assert.equal(unavailable.safeScanResult, "unavailable");
  assert.equal(unavailable.safeCode, "AI_SCANNER_DENIED");

  const overCap = buildInputManifest([source(sourceAId, FAKE_PROFILE.maxInputBytes + 1)]);
  const budgetResult = assessFakeInput(inputForManifest(overCap));
  assert.equal(budgetResult.admissible, false);
  assert.equal(budgetResult.safeCode, "AI_BUDGET_DENIED");
});

test("fake provider accepts an exact safe dispatch shape and deduplicates tokens", () => {
  const provider = new FakeProviderRecorder();
  const request = {
    projectId,
    runId,
    attemptId,
    dispatchToken: "dispatch-20260827-00000001",
    operation: "projectAnalysis" as const,
    operationKey: fingerprintA,
  };
  const result = provider.dispatch(request);
  assert.equal(result.runStatus, "succeeded");
  assert.equal(provider.count, 1);
  assert.ok(Object.isFrozen(provider.records));
  assert.deepEqual(provider.records[0], {
    ...request,
    runStatus: "succeeded",
    attemptStatus: "succeeded",
    safeCode: null,
    httpStatus: null,
    automaticRetry: false,
    providerRequestId: null,
    providerResponseId: null,
    usage: null,
  });
  assertServiceError(() => provider.dispatch(request), "AI_REDISPATCH_FORBIDDEN");
  provider.dispatch({ ...request, dispatchToken: "dispatch-20260827-00000002" });
  assert.equal(provider.count, 2);
});

test("fake provider sanitizes injected results and supports stable throw mode", () => {
  const failedProvider = new FakeProviderRecorder({
    kind: "failed",
    httpStatus: 429,
    safeCode: "provider error body: secret-sentinel",
    providerResponseId: "https://provider.invalid/response",
  });
  const request = {
    projectId,
    runId,
    attemptId,
    dispatchToken: "dispatch-20260827-00000003",
    operation: "projectAnalysis" as const,
    operationKey: fingerprintA,
  };
  const failed = failedProvider.dispatch(request);
  assert.equal(failed.runStatus, "unknown");
  assert.equal(failed.safeCode, "AI_PROVIDER_UNKNOWN");
  assert.equal(failed.providerResponseId, null);
  assert.doesNotMatch(JSON.stringify(failedProvider.records), /provider error body|secret-sentinel|provider\.invalid/);

  const throwingProvider = new FakeProviderRecorder({ mode: "throw", code: "AI_PROVIDER_FAILED" });
  assertServiceError(
    () => throwingProvider.dispatch({ ...request, dispatchToken: "dispatch-20260827-00000004" }),
    "AI_PROVIDER_FAILED",
  );
  assert.equal(throwingProvider.count, 1);
  assert.equal(throwingProvider.records[0]?.safeCode, "AI_PROVIDER_FAILED");
});

test("fake provider rejects extra or unsafe dispatch fields without exposing them", () => {
  const provider = new FakeProviderRecorder();
  const request = {
    projectId,
    runId,
    attemptId,
    dispatchToken: "dispatch-20260827-00000005",
    operation: "projectAnalysis" as const,
    operationKey: fingerprintA,
  };
  for (const invalid of [
    { ...request, prompt: "raw prompt" },
    { ...request, sourceText: "raw source" },
    { ...request, body: "provider body" },
    { ...request, apiKey: "secret-sentinel" },
    { ...request, dispatchToken: "token-secret-sentinel" },
    { ...request, operationKey: fingerprintA.toUpperCase() },
  ]) {
    assertServiceError(() => provider.dispatch(invalid), "AI_INVALID_OPERATION_KEY_INPUT");
  }
  assert.equal(provider.count, 0);
});

test("service errors and runtime config expose only stable safe values", () => {
  const error = new AiRuntimeServiceError("AI_PROVIDER_FAILED");
  assert.equal(error.message, "AI_PROVIDER_FAILED");
  assert.deepEqual({ name: error.name, code: error.code }, {
    name: "AiRuntimeServiceError",
    code: "AI_PROVIDER_FAILED",
  });
  assert.doesNotMatch(JSON.stringify(error), /secret|raw|provider body/i);
  const invalidCode = new AiRuntimeServiceError("provider body: secret-sentinel" as never);
  assert.equal(invalidCode.code, "AI_INVALID_PROVIDER_RESPONSE");
  assert.equal(invalidCode.message, "AI_INVALID_PROVIDER_RESPONSE");
  assert.doesNotMatch(JSON.stringify(invalidCode), /provider body|secret-sentinel/i);
  assert.deepEqual(loadAiRuntimeConfig({}), {
    enabled: false,
    status: "disabled",
    errorCode: "AI_DISABLED",
  });
});

test("new runtime modules have no outbound client, credential environment, or raw transport fields", () => {
  const repositoryRoot = join(process.cwd());
  for (const file of [
    "manifest.ts",
    "fake-profile.ts",
    "fake-provider.ts",
    "errors.ts",
    "service.ts",
  ]) {
    const content = readFileSync(join(repositoryRoot, "src/lib/ai-runtime", file), "utf8");
    assert.doesNotMatch(content, /fetch\s*\(|axios|openai|process\.env|DATABASE_URL|getDb|API_KEY|apiKey|https?:\/\//i, file);
    assert.doesNotMatch(content, /sourceText|providerBody|prompt\s*:/i, file);
  }
  const serviceSource = readFileSync(
    join(repositoryRoot, "src/lib/ai-runtime/service.ts"),
    "utf8",
  );
  assert.doesNotMatch(serviceSource, /safeCode:\s*safeCode\s+as\s+DbAiSafeErrorCode/);
  assert.match(
    serviceSource,
    /satisfies\s+Record<AiSafeErrorCode,\s*DbAiSafeErrorCode>/,
  );
});
