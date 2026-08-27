import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  AiRuntimeContractError,
  AI_OPERATIONS,
  OPERATION_KEY_SCHEMA_VERSION,
  buildOperationKey,
  canRedispatchRun,
  checkAiRuntimeAvailability,
  classifyProviderResult,
  loadAiRuntimeConfig,
  transitionAiRunAttemptStatus,
  transitionAiRunStatus,
  type OperationKeyInput,
  type ProviderResultInput,
} from "@/lib/ai-runtime";

const projectId = "a1111111-1111-4111-8111-111111111111";
const otherProjectId = "b2222222-2222-4222-8222-222222222222";
const sourceAId = "c3333333-3333-4333-8333-333333333333";
const sourceBId = "d4444444-4444-4444-8444-444444444444";
const sourceCId = "e5555555-5555-4555-8555-555555555555";
const fingerprint = "a".repeat(64);
const otherFingerprint = "b".repeat(64);

function source(
  sourceId: string,
  contentBytes = 12,
  contentFingerprint = fingerprint,
  evidenceManifestFingerprint = otherFingerprint,
) {
  return {
    sourceId,
    contentFingerprint,
    contentBytes,
    evidenceManifestFingerprint,
  };
}

function operationKeyInput(overrides: Partial<OperationKeyInput> = {}): OperationKeyInput {
  return {
    schemaVersion: OPERATION_KEY_SCHEMA_VERSION,
    projectId,
    operation: "projectAnalysis",
    sourceManifest: [source(sourceBId), source(sourceAId)],
    promptFingerprint: fingerprint,
    promptVersion: "prompt-v1",
    profileFingerprint: fingerprint,
    providerFingerprint: fingerprint,
    modelId: "synthetic-provider/model-v1",
    modelFingerprint: fingerprint,
    grantFingerprint: fingerprint,
    effectivePolicyVersion: 1,
    processorFingerprint: fingerprint,
    processorEndpointFingerprint: fingerprint,
    processorRegionFingerprint: fingerprint,
    processorRetentionFingerprint: fingerprint,
    noRagSnapshotMarker: "no-rag-snapshot:v1",
    ...overrides,
  };
}

function assertInvalidOperationKey(value: unknown): void {
  assert.throws(
    () => buildOperationKey(value),
    (error: unknown) =>
      error instanceof AiRuntimeContractError &&
      error.message === "AI_INVALID_OPERATION_KEY_INPUT" &&
      error.code === "AI_INVALID_OPERATION_KEY_INPUT",
  );
}

test("operation key is deterministic and canonicalizes source order", () => {
  const first = buildOperationKey(operationKeyInput());
  const second = buildOperationKey(
    operationKeyInput({ sourceManifest: [source(sourceAId), source(sourceBId)] }),
  );

  assert.equal(first, second);
  assert.match(first, /^[0-9a-f]{64}$/);
});

test("each governed top-level operation-key field changes the key", () => {
  const baseline = buildOperationKey(operationKeyInput());
  const mutations: Array<[string, Partial<OperationKeyInput>]> = [
    ["projectId", { projectId: otherProjectId }],
    ["operation", { operation: "embedding" }],
    ["promptFingerprint", { promptFingerprint: otherFingerprint }],
    ["promptVersion", { promptVersion: "prompt-v2" }],
    ["profileFingerprint", { profileFingerprint: otherFingerprint }],
    ["providerFingerprint", { providerFingerprint: otherFingerprint }],
    ["modelId", { modelId: "synthetic-provider/model-v2" }],
    ["modelFingerprint", { modelFingerprint: otherFingerprint }],
    ["grantFingerprint", { grantFingerprint: otherFingerprint }],
    ["effectivePolicyVersion", { effectivePolicyVersion: 2 }],
    ["processorFingerprint", { processorFingerprint: otherFingerprint }],
    ["processorEndpointFingerprint", { processorEndpointFingerprint: otherFingerprint }],
    ["processorRegionFingerprint", { processorRegionFingerprint: otherFingerprint }],
    ["processorRetentionFingerprint", { processorRetentionFingerprint: otherFingerprint }],
    ["sourceManifest", { sourceManifest: [source(sourceAId), source(sourceCId)] }],
  ];

  for (const [field, mutation] of mutations) {
    assert.notEqual(
      buildOperationKey(operationKeyInput(mutation)),
      baseline,
      `governed field ${field} must affect operationKey`,
    );
  }
});

test("each source-manifest field changes the key", () => {
  const baseline = buildOperationKey(operationKeyInput());
  const mutations: Array<[string, Partial<OperationKeyInput>]> = [
    [
      "sourceId",
      { sourceManifest: [source(sourceBId), source(sourceCId)] },
    ],
    [
      "contentFingerprint",
      { sourceManifest: [source(sourceBId, 12, otherFingerprint), source(sourceAId)] },
    ],
    [
      "contentBytes",
      { sourceManifest: [source(sourceBId, 13), source(sourceAId)] },
    ],
    [
      "evidenceManifestFingerprint",
      {
        sourceManifest: [
          source(sourceBId, 12, fingerprint, fingerprint),
          source(sourceAId),
        ],
      },
    ],
  ];

  for (const [field, mutation] of mutations) {
    assert.notEqual(
      buildOperationKey(operationKeyInput(mutation)),
      baseline,
      `source-manifest field ${field} must affect operationKey`,
    );
  }
});

test("operation key rejects invalid UUID, normalization, numeric and URL inputs", () => {
  assertInvalidOperationKey(operationKeyInput({ projectId: projectId.toUpperCase() }));
  assertInvalidOperationKey(operationKeyInput({ projectId: "not-a-uuid" }));
  assertInvalidOperationKey(operationKeyInput({ promptVersion: "prompt-e\u0301" }));
  assertInvalidOperationKey(operationKeyInput({ modelId: "synthetic provider/model-v1" }));
  assertInvalidOperationKey(operationKeyInput({ modelId: "synthetic-provider/model-\u0001" }));
  assertInvalidOperationKey(operationKeyInput({ modelId: "https://provider.invalid/model-v1" }));
  assertInvalidOperationKey(operationKeyInput({ modelId: "synthetic-provider/" + "m".repeat(120) }));
  assertInvalidOperationKey(operationKeyInput({ sourceManifest: [] }));
  assertInvalidOperationKey(
    operationKeyInput({ sourceManifest: [source(sourceAId), source(sourceAId)] }),
  );
  assertInvalidOperationKey(operationKeyInput({ sourceManifest: [source("")] }));
  assertInvalidOperationKey(operationKeyInput({ sourceManifest: [source("not-a-uuid")] }));
  assertInvalidOperationKey(
    operationKeyInput({ sourceManifest: [source(sourceAId.toUpperCase())] }),
  );
  assertInvalidOperationKey(operationKeyInput({ sourceManifest: [source(sourceAId, -1)] }));
  assertInvalidOperationKey(
    operationKeyInput({ sourceManifest: [source(sourceAId, Number.NaN)] }),
  );
  assertInvalidOperationKey(
    operationKeyInput({ sourceManifest: [source(sourceAId, Number.POSITIVE_INFINITY)] }),
  );
  assertInvalidOperationKey(operationKeyInput({ promptFingerprint: "A".repeat(64) }));
  assertInvalidOperationKey(operationKeyInput({ modelId: "latest" }));
  assertInvalidOperationKey(operationKeyInput({ modelId: "synthetic-provider/model:latest" }));
  assertInvalidOperationKey({ ...operationKeyInput(), endpointUrl: "https://example.invalid" });
  assertInvalidOperationKey({
    ...operationKeyInput(),
    sourceManifest: [{ ...source(sourceAId), contentBytes: "12" }],
  });
  assertInvalidOperationKey({ ...operationKeyInput(), effectivePolicyVersion: 0 });
  assertInvalidOperationKey({ ...operationKeyInput(), effectivePolicyVersion: Number.POSITIVE_INFINITY });
  assertInvalidOperationKey({ ...operationKeyInput(), noRagSnapshotMarker: "rag-snapshot:v1" });
  assertInvalidOperationKey({ ...operationKeyInput(), schemaVersion: "ai-operation-key:v2" });
});

test("state machine permits only governed transitions and explicit failed retry", () => {
  assert.deepEqual(transitionAiRunStatus("queued", "running"), { ok: true, status: "running" });
  assert.deepEqual(transitionAiRunStatus("running", "succeeded"), {
    ok: true,
    status: "succeeded",
  });
  assert.deepEqual(transitionAiRunStatus("running", "failed"), { ok: true, status: "failed" });
  assert.deepEqual(transitionAiRunStatus("running", "unknown"), { ok: true, status: "unknown" });
  assert.deepEqual(transitionAiRunStatus("running", "cancelled"), {
    ok: true,
    status: "cancelled",
  });
  assert.deepEqual(transitionAiRunStatus("failed", "queued"), {
    ok: false,
    code: "AI_INVALID_STATE_TRANSITION",
  });
  assert.deepEqual(transitionAiRunStatus("failed", "queued", { explicitRetry: true }), {
    ok: true,
    status: "queued",
  });
  assert.deepEqual(transitionAiRunStatus("unknown", "queued", { explicitRetry: true }), {
    ok: false,
    code: "AI_INVALID_STATE_TRANSITION",
  });
  assert.deepEqual(transitionAiRunStatus("succeeded", "running"), {
    ok: false,
    code: "AI_INVALID_STATE_TRANSITION",
  });
  assert.equal(canRedispatchRun("unknown", true), false);
  assert.equal(canRedispatchRun("failed", false), false);
  assert.equal(canRedispatchRun("failed", true), true);
});

test("attempt state machine has no outgoing transition from unknown", () => {
  assert.deepEqual(transitionAiRunAttemptStatus("sent", "succeeded"), {
    ok: true,
    status: "succeeded",
  });
  assert.deepEqual(transitionAiRunAttemptStatus("sent", "failed"), {
    ok: true,
    status: "failed",
  });
  assert.deepEqual(transitionAiRunAttemptStatus("sent", "unknown"), {
    ok: true,
    status: "unknown",
  });
  assert.deepEqual(transitionAiRunAttemptStatus("unknown", "sent"), {
    ok: false,
    code: "AI_INVALID_STATE_TRANSITION",
  });
});

test("provider statuses and transports classify without automatic retry", () => {
  const cases: Array<[
    string,
    ProviderResultInput,
    "succeeded" | "failed" | "unknown" | "cancelled",
    "succeeded" | "failed" | "unknown" | "cancelled",
  ]> = [
    ["completed", { kind: "completed" }, "succeeded", "succeeded"],
    ["failed", { kind: "failed", httpStatus: 400 }, "failed", "failed"],
    ["too many requests", { kind: "http_error", httpStatus: 429 }, "failed", "failed"],
    ["server error", { kind: "http_error", httpStatus: 503 }, "failed", "failed"],
    ["redirect refusal", { kind: "http_error", httpStatus: 302 }, "failed", "failed"],
    ["incomplete", { kind: "incomplete" }, "failed", "failed"],
    ["cancelled", { kind: "cancelled" }, "cancelled", "cancelled"],
    ["queued", { kind: "queued" }, "unknown", "unknown"],
    ["in progress", { kind: "in_progress" }, "unknown", "unknown"],
    ["timeout", { kind: "timeout", sentAt: true }, "unknown", "unknown"],
    ["abort", { kind: "abort", sentAt: true }, "unknown", "unknown"],
    ["connection", { kind: "connection", sentAt: true }, "unknown", "unknown"],
    ["invalid response", { kind: "invalid_response", sentAt: true }, "unknown", "unknown"],
  ];

  for (const [name, result, runStatus, attemptStatus] of cases) {
    const classified = classifyProviderResult(result);
    assert.equal(classified.runStatus, runStatus, name);
    assert.equal(classified.attemptStatus, attemptStatus, name);
    assert.equal(classified.automaticRetry, false, name);
  }

  const notSent = classifyProviderResult({ kind: "connection", sentAt: false });
  assert.equal(notSent.runStatus, "failed");
  assert.equal(notSent.safeCode, "AI_DISPATCH_NOT_SENT");
});

test("provider IDs and usage are conservative and invalid responses become unknown", () => {
  const invalidId = classifyProviderResult({
    kind: "completed",
    providerResponseId: "https://provider.invalid/response",
  });
  assert.equal(invalidId.runStatus, "unknown");
  assert.equal(invalidId.safeCode, "AI_PROVIDER_UNKNOWN");

  const secretLikeId = classifyProviderResult({
    kind: "completed",
    providerRequestId: "sk-test-secret",
  });
  assert.equal(secretLikeId.runStatus, "unknown");

  const invalidUsage = classifyProviderResult({
    kind: "completed",
    usage: { inputTokens: Number.NaN, outputTokens: 1, requestCount: 1 },
  });
  assert.equal(invalidUsage.runStatus, "unknown");
  assert.equal(invalidUsage.usage, null);

  for (const requestCount of [0, 2]) {
    const invalidRequestCount = classifyProviderResult({
      kind: "completed",
      usage: { inputTokens: 1, outputTokens: 1, requestCount },
    });
    assert.equal(invalidRequestCount.runStatus, "unknown");
    assert.equal(invalidRequestCount.safeCode, "AI_PROVIDER_UNKNOWN");
    assert.equal(invalidRequestCount.usage, null);
  }
});

test("runtime configuration is disabled by default and fails closed when enabled", () => {
  const disabled = loadAiRuntimeConfig({ AI_PROVIDER_KEY: "test-secret-sentinel" });
  assert.deepEqual(disabled, {
    enabled: false,
    status: "disabled",
    errorCode: "AI_DISABLED",
  });
  assert.deepEqual(checkAiRuntimeAvailability(disabled), {
    enabled: false,
    available: false,
    errorCode: "AI_DISABLED",
  });

  const providerDisabled = loadAiRuntimeConfig({
    AI_ENABLED: "true",
    AI_PROVIDER_KEY: "test-secret-sentinel",
  });
  assert.deepEqual(providerDisabled, {
    enabled: true,
    status: "provider_disabled",
    errorCode: "AI_PROVIDER_DISABLED",
  });
  assert.deepEqual(checkAiRuntimeAvailability(providerDisabled), {
    enabled: true,
    available: false,
    errorCode: "AI_PROVIDER_DISABLED",
  });
  assert.doesNotMatch(JSON.stringify(providerDisabled), /test-secret-sentinel/);
});

test("safe result serialization does not carry raw provider material", () => {
  const result = classifyProviderResult({
    kind: "failed",
    httpStatus: 500,
    safeCode: "provider error body: test-secret-sentinel",
    providerRequestId: "request-safe",
  });
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /provider error body|test-secret-sentinel|raw prompt|source content/);
  assert.equal(result.safeCode, "AI_PROVIDER_FAILED");
});

test("schema and migration statically declare the governance contract", () => {
  // This is a static contract check only; it does not replace real PostgreSQL tests.
  const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const schema = readFileSync(join(repositoryRoot, "prisma/schema.prisma"), "utf8");
  const migration = readFileSync(
    join(repositoryRoot, "prisma/migrations/20260827090000_add_ai_runtime_governance/migration.sql"),
    "utf8",
  );
  const sourceRoute = readFileSync(
    join(repositoryRoot, "src/app/api/projects/[projectId]/sources/[sourceId]/route.ts"),
    "utf8",
  );

  for (const model of [
    "ProjectAiPolicy",
    "ProjectAiPolicyRevision",
    "ModelProcessingGrant",
    "ModelProcessingGrantSource",
    "ModelProcessingGrantOperation",
    "AiRun",
    "AiRunAttempt",
    "AiRunInputSource",
    "AiAuditEvent",
  ]) {
    assert.match(schema, new RegExp(`model ${model} \\{`));
    assert.match(migration, new RegExp(`CREATE TABLE "${model}"`));
  }
  for (const operation of AI_OPERATIONS) {
    assert.match(schema, new RegExp(`\\s${operation}\\s`));
    assert.match(migration, new RegExp(`'${operation}'`));
  }

  assert.match(schema, /outboundEnabled\s+Boolean\s+@default\(false\)/);
  const policyRevisionModel = schema.match(/model ProjectAiPolicyRevision \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.notEqual(policyRevisionModel, "", "ProjectAiPolicyRevision model must be present");
  for (const operationFlag of [
    "embeddingEnabled",
    "autoExtractEnabled",
    "sourceSummaryEnabled",
    "projectAnalysisEnabled",
    "generateWithContextEnabled",
  ]) {
    assert.match(policyRevisionModel, new RegExp(`${operationFlag}\\s+Boolean\\s+@default\\(false\\)`));
    assert.match(migration, new RegExp(`"${operationFlag}" BOOLEAN NOT NULL DEFAULT false`));
  }
  assert.match(schema, /enum ModelProcessingGrantStatus \{[\s\S]*draft[\s\S]*issued[\s\S]*revoked/);
  assert.match(schema, /enum ModelProcessingGrantRevocationReasonCode \{/);
  const policyModel = schema.match(/model ProjectAiPolicy \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.notEqual(policyModel, "", "ProjectAiPolicy model must be present");
  assert.doesNotMatch(policyModel, /outboundEnabled/);
  assert.doesNotMatch(migration, /ProjectAiPolicy_outboundEnabled/);
  const policyTable = migration.match(/CREATE TABLE "ProjectAiPolicy" \([\s\S]*?\n\);/)?.[0] ?? "";
  assert.notEqual(policyTable, "", "ProjectAiPolicy table must be present");
  assert.doesNotMatch(policyTable, /outboundEnabled/);
  assert.match(schema, /currentRevisionId/);
  assert.match(schema, /policyRevisionId/);
  assert.match(schema, /processorFingerprint\s+String\s+@db\.VarChar\(64\)/);
  assert.match(schema, /budgetFingerprint\s+String\s+@db\.VarChar\(64\)/);
  assert.match(schema, /scannerFingerprint\s+String\s+@db\.VarChar\(64\)/);
  assert.match(schema, /providerFingerprint\s+String\s+@db\.VarChar\(64\)/);
  assert.match(schema, /modelId\s+String\s+@db\.VarChar\(128\)/);
  assert.match(schema, /contentFingerprint\s+String\s+@db\.VarChar\(64\)/);
  assert.match(schema, /maxRequests\s+Int\s+@default\(1\)/);
  const grantModel = schema.match(/model ModelProcessingGrant \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.notEqual(grantModel, "", "ModelProcessingGrant model must be present");
  assert.match(grantModel, /status\s+ModelProcessingGrantStatus\s+@default\(draft\)/);
  assert.match(grantModel, /modelId\s+String\s+@db\.VarChar\(128\)/);
  assert.match(grantModel, /issuedAt\s+DateTime\?/);
  assert.match(grantModel, /expiresAt\s+DateTime\?/);
  assert.match(grantModel, /revocationReasonCode\s+ModelProcessingGrantRevocationReasonCode\?/);
  assert.doesNotMatch(grantModel, /revocationReason\s+String/);
  assert.match(schema, /@@unique\(\[projectId, id, policyRevisionId\]\)/);
  assert.match(schema, /@@unique\(\[projectId, operationKey\]\)/);
  assert.match(schema, /@@unique\(\[projectId, id, grantId\]\)/);
  assert.match(schema, /@@unique\(\[projectId, id, aiRunId\]\)/);
  assert.match(schema, /@@unique\(\[projectId, aiRunId, attemptNumber\]\)/);
  assert.match(schema, /dispatchToken\s+String\s+@unique/);
  assert.match(schema, /operationGrant\s+ModelProcessingGrantOperation/);
  assert.match(schema, /grantSource\s+ModelProcessingGrantSource/);
  assert.match(schema, /safeScanResult\s+AiSafeScanResult/);
  assert.match(schema, /budgetStatus\s+AiBudgetStatus/);
  const runModel = schema.match(/model AiRun \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.notEqual(runModel, "", "AiRun model must be present");
  assert.match(runModel, /providerFingerprint/);
  assert.match(runModel, /modelId/);
  assert.match(runModel, /operationKeySchemaVersion\s+String\s+@db\.VarChar\(32\)/);
  assert.match(runModel, /noRagSnapshotMarker\s+String\s+@db\.VarChar\(32\)/);
  assert.doesNotMatch(runModel, /noRagSnapshotFingerprint/);
  const auditModel = schema.match(/model AiAuditEvent \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.notEqual(auditModel, "", "AiAuditEvent model must be present");
  assert.match(auditModel, /policyRevisionId\s+String\s+@db\.Uuid/);
  assert.doesNotMatch(auditModel, /metadata\s+Json/);
  assert.match(schema, /AiRunAttempt.*[\s\S]*aiRun[\s\S]*onDelete: NoAction/);
  assert.match(schema, /AiRunInputSource[\s\S]*aiRun[\s\S]*onDelete: NoAction/);

  assert.match(migration, /FOREIGN KEY \("projectId", "grantId", "policyRevisionId"\)/);
  assert.match(migration, /FOREIGN KEY \("projectId", "grantId", "operation"\)/);
  assert.match(migration, /FOREIGN KEY \("projectId", "aiRunId", "grantId"\)/);
  assert.match(migration, /FOREIGN KEY \("projectId", "grantId", "sourceId"\)/);
  assert.match(migration, /AiAuditEvent_projectId_policyRevisionId_fkey/);
  assert.match(migration, /AiAuditEvent_projectId_grantId_policyRevisionId_fkey/);
  assert.match(migration, /AiAuditEvent_projectId_aiRunId_grantId_policyRevisionId_fkey/);
  assert.match(migration, /AiAuditEvent_projectId_attemptId_aiRunId_fkey/);
  assert.match(migration, /AiRunAttempt_projectId_id_aiRunId_key/);
  assert.match(migration, /FOREIGN KEY \("projectId", "sourceId"\)[^\n]*ON DELETE NO ACTION/);
  assert.match(migration, /AiRunAttempt_projectId_aiRunId_fkey[^\n]*ON DELETE NO ACTION/);
  assert.match(migration, /AiRunInputSource_projectId_aiRunId_grantId_fkey[^\n]*ON DELETE NO ACTION/);
  assert.match(migration, /CHECK \("revision" > 0\)/);
  assert.match(migration, /CHECK \("attemptNumber" > 0\)/);
  assert.match(migration, /CHECK \("requestCount" = 1\)/);
  assert.match(migration, /CHECK \("maxRequests" > 0\)/);
  assert.match(migration, /CHECK \("inputTokens" >= 0 AND "inputTokens" <= "maxInputTokens"\)/);
  assert.match(migration, /CHECK \("outputTokens" >= 0 AND "outputTokens" <= "maxOutputTokens"\)/);
  assert.match(migration, /CHECK \("requestCount" >= 0 AND "requestCount" <= "maxRequests"\)/);
  assert.match(migration, /CHECK \("budgetUsedMicros" >= 0 AND "budgetUsedMicros" <= "maxBudgetMicros"\)/);
  assert.match(migration, /AiRun_status_timestamps_check/);
  assert.match(migration, /AiRunAttempt_status_timestamps_check/);
  assert.match(migration, /AiAuditEvent_subjects_check/);
  assert.match(migration, /AiAuditEvent_subjects_check[\s\S]*"policyRevisionId" IS NOT NULL/);
  assert.match(
    migration,
    /'policyCreated', 'policyAdvanced'[\s\S]*"grantId" IS NULL[\s\S]*"aiRunId" IS NULL[\s\S]*"attemptId" IS NULL/,
  );
  assert.match(
    migration,
    /'preflightRejected', 'scannerRejected', 'budgetRejected'[\s\S]*"aiRunId" IS NULL[\s\S]*"attemptId" IS NULL/,
  );
  assert.match(migration, /'runCreated'[\s\S]*"grantId" IS NOT NULL[\s\S]*"aiRunId" IS NOT NULL/);
  assert.match(migration, /'attemptSucceeded'[\s\S]*"attemptId" IS NOT NULL/);
  assert.match(migration, /"expiresAt" > "issuedAt"/);
  assert.match(
    migration,
    /"status" = 'draft'[\s\S]*"issuedAt" IS NULL[\s\S]*"revocationReasonCode" IS NULL/,
  );
  assert.match(migration, /ModelProcessingGrant_lifecycle_check/);
  assert.match(migration, /ModelProcessingGrantRevocationReasonCode/);
  assert.match(migration, /ModelProcessingGrant_issuedBy_check/);
  assert.match(migration, /ModelProcessingGrant_purposeCode_check/);
  assert.match(migration, /ai_policy_revision_immutable_guard/);
  assert.match(migration, /IF TG_OP = 'INSERT'[\s\S]*policy revision must advance/);
  assert.match(
    migration,
    /CREATE TRIGGER "ProjectAiPolicyRevision_immutable_trigger"\s+BEFORE INSERT OR UPDATE OR DELETE ON "ProjectAiPolicyRevision"/,
  );
  assert.match(migration, /FROM "Project"[\s\S]*WHERE "id" = OLD\."projectId"/);
  assert.match(migration, /ai_policy_current_revision_guard/);
  assert.match(migration, /policy project is immutable/);
  assert.match(
    migration,
    /CREATE TRIGGER "ModelProcessingGrant_revision_snapshot_trigger"\s+BEFORE INSERT OR UPDATE ON "ModelProcessingGrant"/,
  );
  assert.match(
    migration,
    /CREATE TRIGGER "AiRun_revision_snapshot_trigger"\s+BEFORE INSERT OR UPDATE ON "AiRun"/,
  );
  const triggerContract: Array<[string, string, string]> = [
    [
      "ProjectAiPolicyRevision_immutable_trigger",
      "BEFORE INSERT OR UPDATE OR DELETE",
      "ProjectAiPolicyRevision",
    ],
    ["ModelProcessingGrant_lifecycle_trigger", "BEFORE INSERT OR UPDATE", "ModelProcessingGrant"],
    ["ModelProcessingGrant_delete_guard_trigger", "BEFORE DELETE", "ModelProcessingGrant"],
    [
      "ModelProcessingGrantSource_draft_only_trigger",
      "BEFORE INSERT OR UPDATE OR DELETE",
      "ModelProcessingGrantSource",
    ],
    [
      "ModelProcessingGrantOperation_draft_only_trigger",
      "BEFORE INSERT OR UPDATE OR DELETE",
      "ModelProcessingGrantOperation",
    ],
    ["ModelProcessingGrant_issuance_trigger", "BEFORE UPDATE OF \"status\"", "ModelProcessingGrant"],
    ["ProjectAiPolicy_delete_guard_trigger", "BEFORE DELETE", "ProjectAiPolicy"],
    ["AiRun_lifecycle_trigger", "BEFORE INSERT OR UPDATE OR DELETE", "AiRun"],
    ["AiRunAttempt_lifecycle_trigger", "BEFORE INSERT OR UPDATE OR DELETE", "AiRunAttempt"],
    ["AiRunInputSource_lifecycle_trigger", "BEFORE INSERT OR UPDATE OR DELETE", "AiRunInputSource"],
    ["AiAuditEvent_append_only_trigger", "BEFORE INSERT OR UPDATE OR DELETE", "AiAuditEvent"],
  ];
  for (const [name, timing, table] of triggerContract) {
    assert.match(
      migration,
      new RegExp(`CREATE TRIGGER "${name}"\\s+${timing} ON "${table}"`),
      `${name} must be mounted for ${timing}`,
    );
  }
  assert.match(migration, /ai_grant_issuance_guard[\s\S]*currentRevisionId[\s\S]*outboundEnabled/);
  for (const operationFlag of [
    "embeddingEnabled",
    "autoExtractEnabled",
    "sourceSummaryEnabled",
    "projectAnalysisEnabled",
    "generateWithContextEnabled",
  ]) {
    assert.match(migration, new RegExp(`r\\."${operationFlag}"`));
  }
  assert.match(migration, /grant scope is incomplete/);
  assert.match(migration, /grant operation is not allowed by policy/);
  assert.match(migration, /TG_TABLE_NAME = 'ModelProcessingGrantOperation'/);
  assert.match(migration, /grant identity is immutable/);
  assert.match(migration, /grant scope identity is immutable/);
  assert.match(migration, /issued grant is sealed/);
  assert.match(migration, /revoked grant is immutable/);
  assert.match(migration, /failed run retry is service-only/);
  assert.match(migration, /queued run is immutable/);
  assert.match(migration, /running run is immutable/);
  assert.match(migration, /terminal run is immutable/);
  assert.match(migration, /NEW\."requestCount" <> 1/);
  assert.match(migration, /AiRun_status_timestamps_check[\s\S]*"status" = 'running'[\s\S]*"requestCount" >= 1/);
  assert.match(
    migration,
    /AiRun_status_timestamps_check[\s\S]*"status" IN \('failed', 'cancelled'\)[\s\S]*"requestCount" = 0[\s\S]*"requestCount" >= 1/,
  );
  assert.match(migration, /IF NEW\."status" <> 'sent'[\s\S]*NEW\."inputTokens" <> 0[\s\S]*NEW\."providerRequestId" IS NOT NULL[\s\S]*NEW\."safeErrorCode" IS NOT NULL[\s\S]*attempt must start sent/);
  assert.match(migration, /run claim is no longer issuable/);
  assert.match(migration, /attempt identity is sealed/);
  assert.match(migration, /input provenance is not admissible/);
  assert.match(migration, /run_status IS DISTINCT FROM 'queued'/);
  assert.match(migration, /audit event is append-only/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION "ai_run_attempt_consistency_guard"/);
  assert.match(
    migration,
    /CREATE CONSTRAINT TRIGGER "AiRun_attempt_consistency_constraint_trigger"\s+AFTER INSERT OR UPDATE OR DELETE ON "AiRun"\s+DEFERRABLE INITIALLY DEFERRED[\s\S]*EXECUTE FUNCTION "ai_run_attempt_consistency_guard"/,
  );
  assert.match(
    migration,
    /CREATE CONSTRAINT TRIGGER "AiRunAttempt_run_consistency_constraint_trigger"\s+AFTER INSERT OR UPDATE OR DELETE ON "AiRunAttempt"\s+DEFERRABLE INITIALLY DEFERRED[\s\S]*EXECUTE FUNCTION "ai_run_attempt_consistency_guard"/,
  );
  assert.match(migration, /running run and attempt mismatch/);
  assert.match(migration, /terminal run and attempt mismatch/);
  for (const field of [
    "profileFingerprint",
    "processorFingerprint",
    "regionFingerprint",
    "retentionFingerprint",
    "endpointFingerprint",
    "budgetFingerprint",
    "scannerFingerprint",
  ]) {
    assert.match(migration, new RegExp(`NEW\\."${field}" IS DISTINCT FROM`));
  }
  for (const field of [
    "providerFingerprint",
    "modelFingerprint",
    "modelId",
    "profileFingerprint",
    "grantFingerprint",
    "processorFingerprint",
    "processorEndpointFingerprint",
    "processorRegionFingerprint",
    "processorRetentionFingerprint",
  ]) {
    assert.match(migration, new RegExp(`NEW\\."${field}" IS DISTINCT FROM`));
  }
  assert.match(migration, /g\."modelId"[\s\S]*bound_model_id/);
  assert.match(migration, /AiRun_modelId_check/);
  assert.match(migration, /AiRun_operationKeySchemaVersion_check/);
  assert.match(migration, /AiRun_noRagSnapshotMarker_check/);
  assert.doesNotMatch(migration, /\{\s*1\s*,\s*512\s*\}/);
  const providerIdChecks =
    migration.match(
      /CONSTRAINT "Ai(?:Run|RunAttempt)_provider(?:Request|Response)Id_check" CHECK \([\s\S]*?\n    \),/g,
    ) ?? [];
  assert.equal(providerIdChecks.length, 4);
  for (const check of providerIdChecks) {
    assert.match(
      check,
      /char_length\("provider(?:Request|Response)Id"\) BETWEEN 1 AND 512/,
    );
    assert.match(check, /"provider(?:Request|Response)Id" ~ '\^\[A-Za-z0-9\._:-\]\+\$'/);
    assert.match(check, /"provider(?:Request|Response)Id" !~\* '\(https\?:\/\//);
  }
  assert.doesNotMatch(migration, /pgvector|pg_trgm|Chunk|Artifact|RAG|GitHub|CREATE EXTENSION/);
  assert.match(sourceRoute, /Source is referenced by project records/);
});
