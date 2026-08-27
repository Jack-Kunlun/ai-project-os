import { randomUUID } from "node:crypto";
import {
  AiSafeErrorCode as DbAiSafeErrorCodeValue,
  Prisma,
  PrismaClient,
} from "@prisma/client";
import type {
  AiAuditEventType as DbAiAuditEventType,
  AiBudgetStatus as DbAiBudgetStatus,
  AiOperation as DbAiOperation,
  AiRunStatus as DbAiRunStatus,
  AiSafeErrorCode as DbAiSafeErrorCode,
  AiSafeScanResult as DbAiSafeScanResult,
} from "@prisma/client";
import { hashSourceContent } from "@/lib/source";
import {
  AiRuntimeServiceError,
  throwAiRuntimeServiceError,
} from "./errors";
import {
  buildInputManifest,
  buildInputManifestFingerprint,
  sumInputBytes,
  type InputManifest,
} from "./manifest";
import {
  assertAiExecutionInputWithinProfile,
  calculateAiExecutionBudgetMicros,
  getSyntheticAiExecutionProfile,
  resolveAiExecutionProfile,
  type AiExecutionProfile,
} from "./execution-profile";
import {
  AI_OPERATIONS,
  AI_RUN_STATUSES,
  NO_RAG_SNAPSHOT_MARKER,
  OPERATION_KEY_SCHEMA_VERSION,
  type AiOperation,
  type AiRunStatus,
  type AiSafeErrorCode,
  type ProviderClassification,
  type SafeUsage,
} from "./types";
import { buildOperationKey } from "./operation-key";
import type { FakeAdmissibilityResult } from "./fake-provider";

const REQUEST_FIELDS = ["projectId", "grantId", "operation", "sourceIds"] as const;
const CLAIM_REQUEST_FIELDS = [
  "projectId",
  "grantId",
  "operation",
  "sourceIds",
  "runId",
  "operationKey",
] as const;
const SERVICE_OPTION_FIELDS = [
  "db",
  "admissibilityGate",
  "idFactory",
  "transactionRetryLimit",
  "provider",
  "completionHandler",
] as const;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const MODEL_ID_PATTERN = /^[A-Za-z0-9._:/@-]{1,128}$/;
const SECRET_OR_URL_PATTERN =
  /(https?:\/\/|api[-_]?key|bearer|password|secret|token|sk-)/i;
const OPAQUE_PROVIDER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,512}$/;
const SAFE_PROVIDER_ERROR_CODES = [
  "AI_PROVIDER_INCOMPLETE",
  "AI_PROVIDER_UNKNOWN",
  "AI_PROVIDER_FAILED",
  "AI_PROVIDER_CANCELLED",
] as const;
const AI_SAFE_ERROR_CODE_TO_DB = {
  AI_DISABLED: DbAiSafeErrorCodeValue.aiDisabled,
  AI_PROVIDER_DISABLED: DbAiSafeErrorCodeValue.aiProviderDisabled,
  AI_INVALID_OPERATION_KEY_INPUT: DbAiSafeErrorCodeValue.aiInvalidOperationKeyInput,
  AI_INVALID_STATE_TRANSITION: DbAiSafeErrorCodeValue.aiInvalidStateTransition,
  AI_REDISPATCH_FORBIDDEN: DbAiSafeErrorCodeValue.aiRedispatchForbidden,
  AI_PROVIDER_INCOMPLETE: DbAiSafeErrorCodeValue.aiProviderIncomplete,
  AI_PROVIDER_UNKNOWN: DbAiSafeErrorCodeValue.aiProviderUnknown,
  AI_PROVIDER_FAILED: DbAiSafeErrorCodeValue.aiProviderFailed,
  AI_PROVIDER_CANCELLED: DbAiSafeErrorCodeValue.aiProviderCancelled,
  AI_DISPATCH_NOT_SENT: DbAiSafeErrorCodeValue.aiDispatchNotSent,
  AI_POLICY_DENIED: DbAiSafeErrorCodeValue.aiPolicyDenied,
  AI_GRANT_DENIED: DbAiSafeErrorCodeValue.aiGrantDenied,
  AI_SCANNER_DENIED: DbAiSafeErrorCodeValue.aiScannerDenied,
  AI_BUDGET_DENIED: DbAiSafeErrorCodeValue.aiBudgetDenied,
  AI_INVALID_PROVIDER_RESPONSE: DbAiSafeErrorCodeValue.aiInvalidProviderResponse,
  SOURCE_IN_USE: DbAiSafeErrorCodeValue.sourceInUse,
} satisfies Record<AiSafeErrorCode, DbAiSafeErrorCode>;
const DEFAULT_TRANSACTION_RETRY_LIMIT = 3;
const MAX_SOURCE_IDS = 100;
const PROVIDER_CLASSIFICATION_FIELDS = [
  "runStatus",
  "attemptStatus",
  "safeCode",
  "httpStatus",
  "automaticRetry",
  "providerRequestId",
  "providerResponseId",
  "usage",
] as const;
const USAGE_FIELDS = ["inputTokens", "outputTokens", "requestCount"] as const;
const PROVIDER_DISPATCH_ENVELOPE_FIELDS = [
  "classification",
  "completionPayload",
  "outputBytes",
] as const;
const MAX_PROVIDER_OUTPUT_BYTES = 1_048_576;

function dbSafeErrorCode(
  value: AiSafeErrorCode | null,
): DbAiSafeErrorCode | null {
  return value === null ? null : AI_SAFE_ERROR_CODE_TO_DB[value];
}

type TransactionRunner = <T>(
  callback: (transaction: Prisma.TransactionClient) => Promise<T>,
  options: { isolationLevel: Prisma.TransactionIsolationLevel },
) => Promise<T>;

export interface AiAdmissibilityGate {
  assess(value: unknown): FakeAdmissibilityResult;
}

export interface AiRuntimeProvider {
  dispatch(
    value: unknown,
  ): AiRuntimeProviderDispatchResult | Promise<AiRuntimeProviderDispatchResult>;
}

export type AiRuntimeProviderDispatchResult =
  | ProviderClassification
  | Readonly<{
      classification: ProviderClassification;
      completionPayload: unknown;
      outputBytes: number;
    }>;

export interface AiRuntimeCompletionHandler {
  complete(
    tx: Prisma.TransactionClient,
    value: Readonly<{
      projectId: string;
      runId: string;
      operation: AiOperation;
      completionPayload: unknown;
    }>,
  ): Promise<void>;
}

export interface CreateAiRuntimeServiceOptions {
  db: PrismaClient;
  admissibilityGate: AiAdmissibilityGate;
  idFactory?: () => string;
  transactionRetryLimit?: number;
  provider?: AiRuntimeProvider;
  completionHandler?: AiRuntimeCompletionHandler;
}

export interface PrepareOrGetRunRequest {
  projectId: string;
  grantId: string;
  operation: AiOperation;
  sourceIds: readonly string[];
}

export type PrepareOrGetRunResult =
  | {
      kind: "created" | "existing";
      status: AiRunStatus;
      runId: string;
      operationKey: string;
      inputManifestFingerprint: string;
      inputBytes: number;
      sourceCount: number;
      safeCode: null;
    }
  | {
      kind: "rejected";
      status: "failed";
      safeCode: AiSafeErrorCode;
      operationKey?: string;
      inputManifestFingerprint?: string;
    };

export interface ClaimAndDispatchRunRequest extends PrepareOrGetRunRequest {
  runId: string;
  operationKey: string;
}

export type ClaimAndDispatchRunResult =
  | {
      kind: "claimed" | "existing";
      status: AiRunStatus;
      runId: string;
      operationKey: string;
      attemptId?: string;
      safeCode: AiSafeErrorCode | null;
    }
  | {
      kind: "rejected";
      status: "failed";
      runId?: string;
      operationKey?: string;
      safeCode: AiSafeErrorCode;
    };

type PolicyRevisionRow = {
  id: string;
  projectId: string;
  revision: number;
  outboundEnabled: boolean;
  embeddingEnabled: boolean;
  autoExtractEnabled: boolean;
  sourceSummaryEnabled: boolean;
  projectAnalysisEnabled: boolean;
  generateWithContextEnabled: boolean;
  profileFingerprint: string;
  processorFingerprint: string;
  regionFingerprint: string;
  retentionFingerprint: string;
  endpointFingerprint: string;
  budgetFingerprint: string;
  scannerFingerprint: string;
};

type OperationProfileRow = {
  id: string;
  projectId: string;
  policyRevisionId: string;
  operation: string;
  profileFingerprint: string;
  providerFingerprint: string;
  modelFingerprint: string;
  modelId: string;
  processorFingerprint: string;
  regionFingerprint: string;
  retentionFingerprint: string;
  endpointFingerprint: string;
};

type GrantRow = {
  id: string;
  projectId: string;
  status: string;
  policyRevisionId: string;
  profileFingerprint: string;
  providerFingerprint: string;
  modelFingerprint: string;
  modelId: string;
  processorFingerprint: string;
  regionFingerprint: string;
  retentionFingerprint: string;
  endpointFingerprint: string;
  grantFingerprint: string;
  effectivePolicyVersion: number;
  budgetFingerprint: string;
  scannerFingerprint: string;
  scannerVersion: string;
  budgetProfile: string;
  expiresAt: Date | null;
  revokedAt: Date | null;
  expiresAtIsLive: boolean;
};

type GrantSourceRow = {
  sourceId: string;
  contentFingerprint: string;
  contentBytes: number;
};

type ProjectSourceRow = {
  sourceId: string;
  contentText: string;
  contentHash: string;
};

type ExistingRunRow = {
  id: string;
  projectId: string;
  grantId: string;
  policyRevisionId: string;
  operation: string;
  operationKey: string;
  operationKeySchemaVersion: string;
  inputManifestFingerprint: string;
  promptFingerprint: string;
  promptVersion: string;
  providerFingerprint: string;
  modelId: string;
  modelFingerprint: string;
  profileFingerprint: string;
  grantFingerprint: string;
  effectivePolicyVersion: number;
  processorFingerprint: string;
  processorEndpointFingerprint: string;
  processorRegionFingerprint: string;
  processorRetentionFingerprint: string;
  noRagSnapshotMarker: string;
  status: string;
  inputBytes: number;
  outputBytes: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxRequests: number;
  maxBudgetMicros: number;
  inputTokens: number;
  outputTokens: number;
  requestCount: number;
  budgetUsedMicros: number;
  pricingSnapshotId: string | null;
  budgetStatus: string;
  safeErrorCode: string | null;
  httpStatus: number | null;
  providerRequestId: string | null;
  providerResponseId: string | null;
};

type ExistingInputRow = {
  sourceId: string;
  contentFingerprint: string;
  contentBytes: number;
  scannerVersion: string;
  safeScanResult: string;
  evidenceManifestFingerprint: string;
};

type ExistingAttemptRow = {
  id: string;
  projectId: string;
  aiRunId: string;
  attemptNumber: number;
  dispatchToken: string;
  status: string;
  providerRequestId: string | null;
  providerResponseId: string | null;
  httpStatus: number | null;
  inputTokens: number;
  outputTokens: number;
  requestCount: number;
  safeErrorCode: string | null;
};

type PreparedContext = {
  request: PrepareOrGetRunRequest;
  revision: PolicyRevisionRow;
  grant: GrantRow;
  executionProfile: AiExecutionProfile;
  manifest: InputManifest;
  inputManifestFingerprint: string;
  inputBytes: number;
  operationKey: string;
};

function invalidInput(): never {
  return throwAiRuntimeServiceError("AI_INVALID_OPERATION_KEY_INPUT");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  try {
    return Object.getPrototypeOf(value) === Object.prototype;
  } catch {
    return false;
  }
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  try {
    const actual = Object.keys(value).sort();
    const sortedExpected = [...expected].sort();
    return (
      actual.length === sortedExpected.length &&
      actual.every((key, index) => key === sortedExpected[index])
    );
  } catch {
    return false;
  }
}

function safeText(value: unknown, maxLength: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    value.trim() !== value ||
    value.normalize("NFC") !== value ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value) ||
    /\s/u.test(value) ||
    SECRET_OR_URL_PATTERN.test(value)
  ) {
    invalidInput();
  }
  return value;
}

function safeUuid(value: unknown): string {
  const result = safeText(value, 36);
  if (!UUID_PATTERN.test(result) || result !== result.toLowerCase()) {
    invalidInput();
  }
  return result;
}

function safeFingerprint(value: unknown): string {
  const result = safeText(value, 64);
  if (!FINGERPRINT_PATTERN.test(result)) {
    invalidInput();
  }
  return result;
}

function safeOperation(value: unknown): AiOperation {
  const result = safeText(value, 64);
  if (!(AI_OPERATIONS as readonly string[]).includes(result)) {
    invalidInput();
  }
  return result as AiOperation;
}

function safeSourceIds(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SOURCE_IDS) {
    invalidInput();
  }
  const sourceIds = value.map((sourceId) => safeUuid(sourceId));
  const unique = new Set(sourceIds);
  if (unique.size !== sourceIds.length) {
    invalidInput();
  }
  return Object.freeze(
    [...sourceIds].sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  );
}

/** Parses the only public request shape without reading a database. */
export function parsePrepareOrGetRequest(value: unknown): PrepareOrGetRunRequest {
  if (!isPlainRecord(value) || !exactKeys(value, REQUEST_FIELDS)) {
    invalidInput();
  }
  return Object.freeze({
    projectId: safeUuid(value.projectId),
    grantId: safeUuid(value.grantId),
    operation: safeOperation(value.operation),
    sourceIds: safeSourceIds(value.sourceIds),
  });
}

/** Parses the only claim shape; dispatch credentials and request bodies cannot enter it. */
export function parseClaimAndDispatchRunRequest(
  value: unknown,
): ClaimAndDispatchRunRequest {
  if (!isPlainRecord(value) || !exactKeys(value, CLAIM_REQUEST_FIELDS)) {
    invalidInput();
  }
  const prepareRequest = parsePrepareOrGetRequest({
    projectId: value.projectId,
    grantId: value.grantId,
    operation: value.operation,
    sourceIds: value.sourceIds,
  });
  return Object.freeze({
    ...prepareRequest,
    runId: safeUuid(value.runId),
    operationKey: safeFingerprint(value.operationKey),
  });
}

function safeGeneratedId(idFactory: () => string): string {
  try {
    const value: unknown = idFactory();
    if (
      typeof value !== "string" ||
      !UUID_PATTERN.test(value) ||
      value !== value.toLowerCase()
    ) {
      throw new Error("invalid generated id");
    }
    return value;
  } catch {
    throwAiRuntimeServiceError("AI_INVALID_PROVIDER_RESPONSE");
  }
}

function samePolicySnapshot(
  revision: PolicyRevisionRow,
  operationProfile: OperationProfileRow,
  grant: GrantRow,
): boolean {
  return (
    operationProfile.projectId === revision.projectId &&
    operationProfile.policyRevisionId === revision.id &&
    grant.policyRevisionId === revision.id &&
    grant.effectivePolicyVersion === revision.revision &&
    grant.profileFingerprint === operationProfile.profileFingerprint &&
    grant.providerFingerprint === operationProfile.providerFingerprint &&
    grant.modelFingerprint === operationProfile.modelFingerprint &&
    grant.modelId === operationProfile.modelId &&
    grant.processorFingerprint === operationProfile.processorFingerprint &&
    grant.regionFingerprint === operationProfile.regionFingerprint &&
    grant.retentionFingerprint === operationProfile.retentionFingerprint &&
    grant.endpointFingerprint === operationProfile.endpointFingerprint &&
    grant.budgetFingerprint === revision.budgetFingerprint &&
    grant.scannerFingerprint === revision.scannerFingerprint
  );
}

function operationKeyForContext(
  request: PrepareOrGetRunRequest,
  revision: PolicyRevisionRow,
  grant: GrantRow,
  executionProfile: AiExecutionProfile,
  manifest: InputManifest,
): string {
  return buildOperationKey({
    schemaVersion: OPERATION_KEY_SCHEMA_VERSION,
    projectId: request.projectId,
    operation: request.operation,
    sourceManifest: manifest.map((entry) => ({
      sourceId: entry.sourceId,
      contentFingerprint: entry.contentFingerprint,
      contentBytes: entry.contentBytes,
      evidenceManifestFingerprint: entry.evidenceManifestFingerprint,
    })),
    promptFingerprint: executionProfile.promptFingerprint,
    promptVersion: executionProfile.promptVersion,
    profileFingerprint: grant.profileFingerprint,
    providerFingerprint: grant.providerFingerprint,
    modelId: grant.modelId,
    modelFingerprint: grant.modelFingerprint,
    grantFingerprint: grant.grantFingerprint,
    effectivePolicyVersion: revision.revision,
    processorFingerprint: grant.processorFingerprint,
    processorEndpointFingerprint: grant.endpointFingerprint,
    processorRegionFingerprint: grant.regionFingerprint,
    processorRetentionFingerprint: grant.retentionFingerprint,
    noRagSnapshotMarker: NO_RAG_SNAPSHOT_MARKER,
  });
}

function safeRunStatus(value: string): AiRunStatus {
  if (!(AI_RUN_STATUSES as readonly string[]).includes(value)) {
    throwAiRuntimeServiceError("AI_INVALID_PROVIDER_RESPONSE");
  }
  return value as AiRunStatus;
}

function rejected(
  safeCode: AiSafeErrorCode,
  context?: Pick<PreparedContext, "operationKey" | "inputManifestFingerprint">,
): PrepareOrGetRunResult {
  return {
    kind: "rejected",
    status: "failed",
    safeCode,
    ...(context === undefined
      ? {}
      : {
          operationKey: context.operationKey,
          inputManifestFingerprint: context.inputManifestFingerprint,
        }),
  };
}

function claimRejected(
  safeCode: AiSafeErrorCode,
  request?: Pick<ClaimAndDispatchRunRequest, "runId" | "operationKey">,
): ClaimAndDispatchRunResult {
  return {
    kind: "rejected",
    status: "failed",
    safeCode,
    ...(request === undefined
      ? {}
      : { runId: request.runId, operationKey: request.operationKey }),
  };
}

function existingClaimResult(
  run: ExistingRunRow,
  attempts: readonly ExistingAttemptRow[],
): ClaimAndDispatchRunResult {
  try {
    const status = safeRunStatus(run.status);
    if (!isAiRuntimeRunAttemptParityValid(run, attempts)) {
      return {
        kind: "rejected",
        status: "failed",
        runId: run.id,
        operationKey: run.operationKey,
        safeCode: "AI_INVALID_PROVIDER_RESPONSE",
      };
    }
    const latestAttempt = attempts[attempts.length - 1];
    const safeCode =
      status === "succeeded" || status === "running"
        ? null
        : (run.safeErrorCode as AiSafeErrorCode);
    return {
      kind: "existing",
      status,
      runId: run.id,
      operationKey: run.operationKey,
      ...(latestAttempt === undefined ? {} : { attemptId: latestAttempt.id }),
      safeCode,
    };
  } catch {
    return {
      kind: "rejected",
      status: "failed",
      runId: run.id,
      operationKey: run.operationKey,
      safeCode: "AI_INVALID_PROVIDER_RESPONSE",
    };
  }
}

/**
 * A committed dispatch whose completion transaction did not finish is still
 * persisted as running. Reconciliation, not a guessed terminal result, must
 * resolve that sent attempt later.
 */
export function buildAiRuntimeCompletionFailureResult(
  runId: string,
  operationKey: string,
  attemptId: string,
): ClaimAndDispatchRunResult {
  return {
    kind: "claimed",
    status: "running",
    runId: safeUuid(runId),
    operationKey: safeFingerprint(operationKey),
    attemptId: safeUuid(attemptId),
    safeCode: "AI_PROVIDER_UNKNOWN",
  };
}

function rowHasOperationKeyTarget(target: unknown): boolean {
  if (target === "AiRun_projectId_operationKey_key") {
    return true;
  }
  if (!Array.isArray(target)) {
    return false;
  }
  try {
    if (target.length !== 2) {
      return false;
    }
    const fields = [target[0], target[1]];
    return (
      fields.includes("projectId") &&
      fields.includes("operationKey") &&
      !fields.includes("policyRevisionId")
    );
  } catch {
    return false;
  }
}

function readDatabaseErrorProperty(value: unknown, property: string): unknown {
  if (
    (typeof value !== "object" && typeof value !== "function") ||
    value === null
  ) {
    return undefined;
  }
  try {
    return Reflect.get(value, property);
  } catch {
    return undefined;
  }
}

function isNestedOperationKeyViolation(meta: unknown): boolean {
  const driverAdapterError = readDatabaseErrorProperty(meta, "driverAdapterError");
  const cause = readDatabaseErrorProperty(driverAdapterError, "cause");
  const constraint = readDatabaseErrorProperty(cause, "constraint");
  return (
    readDatabaseErrorProperty(meta, "modelName") === "AiRun" &&
    readDatabaseErrorProperty(cause, "kind") === "UniqueConstraintViolation" &&
    readDatabaseErrorProperty(cause, "originalCode") === "23505" &&
    readDatabaseErrorProperty(constraint, "index") ===
      "AiRun_projectId_operationKey_key"
  );
}

/** True only for recognized PostgreSQL pre-dispatch transaction conflicts. */
export function isAiRuntimeSerializationConflict(error: unknown): boolean {
  const code = readDatabaseErrorProperty(error, "code");
  if (code === "P2034") {
    return true;
  }
  if (code !== "P2010") {
    return false;
  }
  const meta = readDatabaseErrorProperty(error, "meta");
  const metaCode = readDatabaseErrorProperty(meta, "code");
  if (metaCode === "40001" || metaCode === "40P01") {
    return true;
  }
  const driverAdapterError = readDatabaseErrorProperty(meta, "driverAdapterError");
  const cause = readDatabaseErrorProperty(driverAdapterError, "cause");
  const originalCode = readDatabaseErrorProperty(cause, "originalCode");
  return originalCode === "40001" || originalCode === "40P01";
}

/** True only for the AiRun(projectId, operationKey) unique conflict. */
export function isAiRuntimeOperationKeyConflict(error: unknown): boolean {
  if (readDatabaseErrorProperty(error, "code") !== "P2002") {
    return false;
  }
  const meta = readDatabaseErrorProperty(error, "meta");
  if (rowHasOperationKeyTarget(readDatabaseErrorProperty(meta, "target"))) {
    return true;
  }
  return isNestedOperationKeyViolation(meta);
}

function safeGateResult(
  value: unknown,
  context: PreparedContext,
  runId: string,
): FakeAdmissibilityResult {
  const fields = [
    "admissible",
    "projectId",
    "runId",
    "operationKey",
    "inputManifestFingerprint",
    "inputBytes",
    "sourceCount",
    "scannerVersion",
    "safeScanResult",
    "safeCode",
  ] as const;
  if (!isPlainRecord(value) || !exactKeys(value, fields)) {
    throwAiRuntimeServiceError("AI_INVALID_PROVIDER_RESPONSE");
  }
  if (
    value.projectId !== context.request.projectId ||
    value.runId !== runId ||
    value.operationKey !== context.operationKey ||
    value.inputManifestFingerprint !== context.inputManifestFingerprint ||
    value.inputBytes !== context.inputBytes ||
    value.sourceCount !== context.manifest.length ||
    value.scannerVersion !== context.grant.scannerVersion ||
    !["passed", "blocked", "unavailable"].includes(String(value.safeScanResult)) ||
    (value.safeCode !== null &&
      value.safeCode !== "AI_SCANNER_DENIED" &&
      value.safeCode !== "AI_BUDGET_DENIED") ||
    typeof value.admissible !== "boolean"
  ) {
    throwAiRuntimeServiceError("AI_INVALID_PROVIDER_RESPONSE");
  }
  const coherentResult =
    (value.admissible === true &&
      value.safeCode === null &&
      value.safeScanResult === "passed") ||
    (value.admissible === false &&
      value.safeCode === "AI_SCANNER_DENIED" &&
      (value.safeScanResult === "blocked" || value.safeScanResult === "unavailable")) ||
    (value.admissible === false &&
      value.safeCode === "AI_BUDGET_DENIED" &&
      value.safeScanResult === "passed");
  if (!coherentResult) {
    throwAiRuntimeServiceError("AI_INVALID_PROVIDER_RESPONSE");
  }
  return Object.freeze({
    admissible: value.admissible,
    projectId: value.projectId,
    runId: value.runId,
    operationKey: value.operationKey,
    inputManifestFingerprint: value.inputManifestFingerprint,
    inputBytes: value.inputBytes,
    sourceCount: value.sourceCount,
    scannerVersion: value.scannerVersion,
    safeScanResult: value.safeScanResult,
    safeCode: value.safeCode,
  }) as FakeAdmissibilityResult;
}

function unknownProviderClassification(): ProviderClassification {
  return {
    runStatus: "unknown",
    attemptStatus: "unknown",
    safeCode: "AI_PROVIDER_UNKNOWN",
    httpStatus: null,
    automaticRetry: false,
    providerRequestId: null,
    providerResponseId: null,
    usage: null,
  };
}

const PREFLIGHT_TERMINAL_ERROR_CODES = [
  "AI_POLICY_DENIED",
  "AI_GRANT_DENIED",
  "AI_SCANNER_DENIED",
  "AI_BUDGET_DENIED",
] as const;

function safeTerminalCodeMatches(
  status: AiRunStatus,
  safeCode: string | null,
  hasAttempt: boolean,
): boolean {
  if (status === "succeeded") {
    return safeCode === null;
  }
  if (status === "unknown") {
    return safeCode === "AI_PROVIDER_UNKNOWN";
  }
  if (status === "failed") {
    return hasAttempt
      ? safeCode === "AI_PROVIDER_FAILED" || safeCode === "AI_PROVIDER_INCOMPLETE"
      : (PREFLIGHT_TERMINAL_ERROR_CODES as readonly string[]).includes(
          safeCode ?? "",
        );
  }
  if (status === "cancelled") {
    return hasAttempt
      ? safeCode === "AI_PROVIDER_CANCELLED"
      : (PREFLIGHT_TERMINAL_ERROR_CODES as readonly string[]).includes(
          safeCode ?? "",
        );
  }
  return status === "running" && safeCode === null;
}

/**
 * Checks only the service-owned Run/Attempt parity used by idempotent reads.
 * It intentionally accepts no source, prompt, provider body or dispatch token.
 */
export function isAiRuntimeRunAttemptParityValid(
  run: ExistingRunRow,
  attempts: readonly ExistingAttemptRow[],
): boolean {
  try {
    const status = safeRunStatus(run.status);
    if (!(AI_OPERATIONS as readonly string[]).includes(run.operation)) {
      return false;
    }
    const executionProfile = resolveAiExecutionProfile(
      run.operation as AiOperation,
      {
        profileFingerprint: run.profileFingerprint,
        providerFingerprint: run.providerFingerprint,
        modelFingerprint: run.modelFingerprint,
        modelId: run.modelId,
        regionFingerprint: run.processorRegionFingerprint,
        retentionFingerprint: run.processorRetentionFingerprint,
        endpointFingerprint: run.processorEndpointFingerprint,
      },
    );
    if (
      executionProfile === null ||
      run.promptFingerprint !== executionProfile.promptFingerprint ||
      run.promptVersion !== executionProfile.promptVersion ||
      run.pricingSnapshotId !== executionProfile.pricingSnapshotId ||
      run.maxInputTokens !== executionProfile.maxInputTokens ||
      run.maxOutputTokens !== executionProfile.maxOutputTokens ||
      run.maxRequests !== executionProfile.maxRequests ||
      run.maxBudgetMicros !== executionProfile.maxBudgetMicros
    ) {
      return false;
    }
    if (!safeTerminalCodeMatches(status, run.safeErrorCode, attempts.length === 1)) {
      return false;
    }
    if (status === "running") {
      const attempt = attempts[0];
      return (
        attempt !== undefined &&
        attempt.projectId === run.projectId &&
        attempt.aiRunId === run.id &&
        attempt.attemptNumber === 1 &&
        attempt.status === "sent" &&
        attempts.length === 1 &&
        run.requestCount === 1 &&
        attempt.requestCount === 1 &&
        run.budgetStatus === "allowed" &&
        run.inputTokens === 0 &&
        run.outputTokens === 0 &&
        run.outputBytes === 0 &&
        run.budgetUsedMicros === 0 &&
        run.safeErrorCode === null &&
        run.httpStatus === null &&
        run.providerRequestId === null &&
        run.providerResponseId === null &&
        attempt.inputTokens === 0 &&
        attempt.outputTokens === 0 &&
        attempt.safeErrorCode === null &&
        attempt.httpStatus === null &&
        attempt.providerRequestId === null &&
        attempt.providerResponseId === null
      );
    }
    if (status === "failed" || status === "cancelled") {
      if (attempts.length === 0) {
        return (
          run.requestCount === 0 &&
          run.inputTokens === 0 &&
          run.outputTokens === 0 &&
          run.outputBytes === 0 &&
          run.budgetUsedMicros === 0 &&
          (run.budgetStatus === "pending" || run.budgetStatus === "rejected") &&
          run.httpStatus === null &&
          run.providerRequestId === null &&
          run.providerResponseId === null
        );
      }
    }
    const attempt = attempts[0];
    const expectedAttemptStatus = status as
      | "succeeded"
      | "failed"
      | "unknown"
      | "cancelled";
    const expectedBudget = calculateAiExecutionBudgetMicros(executionProfile, {
      inputBytes: run.inputBytes,
      inputTokens: run.inputTokens,
      outputTokens: run.outputTokens,
    });
    return (
      attempt !== undefined &&
      attempt.projectId === run.projectId &&
      attempt.aiRunId === run.id &&
      attempt.attemptNumber === 1 &&
      attempts.length === 1 &&
      attempt.status === expectedAttemptStatus &&
      run.requestCount === 1 &&
      attempt.requestCount === 1 &&
      run.budgetStatus === "allowed" &&
      run.budgetUsedMicros === expectedBudget &&
      run.budgetUsedMicros <= run.maxBudgetMicros &&
      run.inputTokens === attempt.inputTokens &&
      run.outputTokens === attempt.outputTokens &&
      run.httpStatus === attempt.httpStatus &&
      run.providerRequestId === attempt.providerRequestId &&
      run.providerResponseId === attempt.providerResponseId &&
      run.safeErrorCode === attempt.safeErrorCode &&
      Number.isSafeInteger(run.outputBytes) &&
      run.outputBytes >= 0 &&
      (status === "succeeded" || run.outputBytes === 0)
    );
  } catch {
    return false;
  }
}

function safeProviderIdentifier(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  if (
    typeof value !== "string" ||
    !OPAQUE_PROVIDER_ID_PATTERN.test(value) ||
    SECRET_OR_URL_PATTERN.test(value)
  ) {
    throwAiRuntimeServiceError("AI_INVALID_PROVIDER_RESPONSE");
  }
  return value;
}

function safeProviderUsage(value: unknown): SafeUsage | null {
  if (value === null) {
    return null;
  }
  if (!isPlainRecord(value) || !exactKeys(value, USAGE_FIELDS)) {
    throwAiRuntimeServiceError("AI_INVALID_PROVIDER_RESPONSE");
  }
  if (
    !Number.isFinite(value.inputTokens) ||
    !Number.isSafeInteger(value.inputTokens) ||
    (value.inputTokens as number) < 0 ||
    !Number.isFinite(value.outputTokens) ||
    !Number.isSafeInteger(value.outputTokens) ||
    (value.outputTokens as number) < 0 ||
    value.requestCount !== 1
  ) {
    throwAiRuntimeServiceError("AI_INVALID_PROVIDER_RESPONSE");
  }
  return {
    inputTokens: value.inputTokens as number,
    outputTokens: value.outputTokens as number,
    requestCount: 1,
  };
}

export function normalizeAiRuntimeProviderClassification(
  value: unknown,
  inputBytes: number,
  executionProfile: AiExecutionProfile = getSyntheticAiExecutionProfile(),
): ProviderClassification {
  try {
    if (!isPlainRecord(value) || !exactKeys(value, PROVIDER_CLASSIFICATION_FIELDS)) {
      return unknownProviderClassification();
    }
    const runStatus = value.runStatus;
    const attemptStatus = value.attemptStatus;
    if (
      !["succeeded", "failed", "unknown", "cancelled"].includes(String(runStatus)) ||
      runStatus !== attemptStatus ||
      value.automaticRetry !== false
    ) {
      return unknownProviderClassification();
    }
    const safeCode = value.safeCode;
    if (
      safeCode !== null &&
      (typeof safeCode !== "string" ||
        !(SAFE_PROVIDER_ERROR_CODES as readonly string[]).includes(safeCode))
    ) {
      return unknownProviderClassification();
    }
    const httpStatus = value.httpStatus;
    if (
      httpStatus !== null &&
      (!Number.isSafeInteger(httpStatus) ||
        (httpStatus as number) < 100 ||
        (httpStatus as number) > 599)
    ) {
      return unknownProviderClassification();
    }
    const providerRequestId = safeProviderIdentifier(value.providerRequestId);
    const providerResponseId = safeProviderIdentifier(value.providerResponseId);
    const usage = safeProviderUsage(value.usage);
    if (
      usage !== null &&
      (usage.inputTokens > executionProfile.maxInputTokens ||
        usage.outputTokens > executionProfile.maxOutputTokens ||
        usage.requestCount !== 1)
    ) {
      return unknownProviderClassification();
    }
    assertAiExecutionInputWithinProfile(executionProfile, inputBytes);
    calculateAiExecutionBudgetMicros(executionProfile, {
      inputBytes,
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
    });
    const validStatusCode =
      (runStatus === "succeeded" && safeCode === null) ||
      (runStatus === "failed" &&
        (safeCode === "AI_PROVIDER_FAILED" || safeCode === "AI_PROVIDER_INCOMPLETE")) ||
      (runStatus === "cancelled" && safeCode === "AI_PROVIDER_CANCELLED") ||
      (runStatus === "unknown" && safeCode === "AI_PROVIDER_UNKNOWN");
    if (!validStatusCode) {
      return unknownProviderClassification();
    }
    return {
      runStatus: runStatus as ProviderClassification["runStatus"],
      attemptStatus: attemptStatus as ProviderClassification["attemptStatus"],
      safeCode: safeCode as AiSafeErrorCode | null,
      httpStatus: httpStatus as number | null,
      automaticRetry: false,
      providerRequestId,
      providerResponseId,
      usage,
    };
  } catch {
    return unknownProviderClassification();
  }
}

type NormalizedProviderDispatch = Readonly<{
  classification: ProviderClassification;
  completionPayload: unknown;
  hasCompletionPayload: boolean;
  outputBytes: number;
}>;

function normalizeProviderDispatch(
  value: unknown,
  inputBytes: number,
  executionProfile: AiExecutionProfile,
): NormalizedProviderDispatch {
  if (
    !isPlainRecord(value) ||
    !exactKeys(value, PROVIDER_DISPATCH_ENVELOPE_FIELDS)
  ) {
    return Object.freeze({
      classification: normalizeAiRuntimeProviderClassification(
        value,
        inputBytes,
        executionProfile,
      ),
      completionPayload: null,
      hasCompletionPayload: false,
      outputBytes: 0,
    });
  }

  try {
    const classificationDescriptor = Object.getOwnPropertyDescriptor(
      value,
      "classification",
    );
    const payloadDescriptor = Object.getOwnPropertyDescriptor(
      value,
      "completionPayload",
    );
    const outputBytesDescriptor = Object.getOwnPropertyDescriptor(
      value,
      "outputBytes",
    );
    if (
      classificationDescriptor === undefined ||
      !("value" in classificationDescriptor) ||
      payloadDescriptor === undefined ||
      !("value" in payloadDescriptor) ||
      outputBytesDescriptor === undefined ||
      !("value" in outputBytesDescriptor)
    ) {
      throw new Error("invalid provider dispatch envelope");
    }
    const classification = normalizeAiRuntimeProviderClassification(
      classificationDescriptor.value,
      inputBytes,
      executionProfile,
    );
    const outputBytes = outputBytesDescriptor.value;
    if (
      !Number.isSafeInteger(outputBytes) ||
      outputBytes < 0 ||
      outputBytes > MAX_PROVIDER_OUTPUT_BYTES ||
      (classification.runStatus === "succeeded" && outputBytes === 0) ||
      (classification.runStatus !== "succeeded" &&
        (outputBytes !== 0 || payloadDescriptor.value !== null))
    ) {
      throw new Error("invalid provider dispatch output");
    }
    return Object.freeze({
      classification,
      completionPayload: payloadDescriptor.value,
      hasCompletionPayload: classification.runStatus === "succeeded",
      outputBytes,
    });
  } catch {
    return Object.freeze({
      classification: unknownProviderClassification(),
      completionPayload: null,
      hasCompletionPayload: false,
      outputBytes: 0,
    });
  }
}

function expectedRunFields(context: PreparedContext): Record<string, unknown> {
  return {
    projectId: context.request.projectId,
    grantId: context.request.grantId,
    policyRevisionId: context.revision.id,
    operation: context.request.operation,
    operationKey: context.operationKey,
    operationKeySchemaVersion: OPERATION_KEY_SCHEMA_VERSION,
    inputManifestFingerprint: context.inputManifestFingerprint,
    promptFingerprint: context.executionProfile.promptFingerprint,
    promptVersion: context.executionProfile.promptVersion,
    providerFingerprint: context.grant.providerFingerprint,
    modelId: context.grant.modelId,
    modelFingerprint: context.grant.modelFingerprint,
    profileFingerprint: context.grant.profileFingerprint,
    grantFingerprint: context.grant.grantFingerprint,
    effectivePolicyVersion: context.revision.revision,
    processorFingerprint: context.grant.processorFingerprint,
    processorEndpointFingerprint: context.grant.endpointFingerprint,
    processorRegionFingerprint: context.grant.regionFingerprint,
    processorRetentionFingerprint: context.grant.retentionFingerprint,
    noRagSnapshotMarker: NO_RAG_SNAPSHOT_MARKER,
    inputBytes: context.inputBytes,
    outputBytes: 0,
    maxInputTokens: context.executionProfile.maxInputTokens,
    maxOutputTokens: context.executionProfile.maxOutputTokens,
    maxRequests: context.executionProfile.maxRequests,
    maxBudgetMicros: context.executionProfile.maxBudgetMicros,
    inputTokens: 0,
    outputTokens: 0,
    requestCount: 0,
    budgetUsedMicros: 0,
    pricingSnapshotId: context.executionProfile.pricingSnapshotId,
    budgetStatus: "pending",
    safeErrorCode: null,
    httpStatus: null,
    providerRequestId: null,
    providerResponseId: null,
  };
}

function runMatchesSnapshot(
  run: ExistingRunRow,
  context: PreparedContext,
  inputRows: readonly ExistingInputRow[],
): boolean {
  const expected = expectedRunFields(context);
  const sealedFields = [
    "projectId",
    "grantId",
    "policyRevisionId",
    "operation",
    "operationKey",
    "operationKeySchemaVersion",
    "inputManifestFingerprint",
    "promptFingerprint",
    "promptVersion",
    "providerFingerprint",
    "modelId",
    "modelFingerprint",
    "profileFingerprint",
    "grantFingerprint",
    "effectivePolicyVersion",
    "processorFingerprint",
    "processorEndpointFingerprint",
    "processorRegionFingerprint",
    "processorRetentionFingerprint",
    "noRagSnapshotMarker",
    "inputBytes",
    "maxInputTokens",
    "maxOutputTokens",
    "maxRequests",
    "maxBudgetMicros",
    "pricingSnapshotId",
  ] as const;
  if (sealedFields.some((field) => run[field] !== expected[field])) {
    return false;
  }
  if (inputRows.length !== context.manifest.length) {
    return false;
  }
  const expectedSources = [...context.manifest].sort((left, right) =>
    left.sourceId < right.sourceId ? -1 : left.sourceId > right.sourceId ? 1 : 0,
  );
  return inputRows.every((input, index) => {
    const expectedSource = expectedSources[index];
    return (
      expectedSource !== undefined &&
      input.sourceId === expectedSource.sourceId &&
      input.contentFingerprint === expectedSource.contentFingerprint &&
      input.contentBytes === expectedSource.contentBytes &&
      input.scannerVersion === expectedSource.scannerVersion &&
      input.safeScanResult === "passed" &&
      input.evidenceManifestFingerprint === expectedSource.evidenceManifestFingerprint
    );
  });
}

/**
 * Reconstructs only the immutable preparation context from a persisted Run.
 * This is used after live policy/grant rejection; persisted children are
 * evidence to validate, never authorization input.
 */
function buildClosureContext(
  request: PrepareOrGetRunRequest,
  expectedOperationKey: string,
  revision: PolicyRevisionRow,
  grant: GrantRow,
  run: ExistingRunRow,
  inputRows: readonly ExistingInputRow[],
): PreparedContext | null {
  try {
    if (
      run.projectId !== request.projectId ||
      run.grantId !== request.grantId ||
      run.policyRevisionId !== revision.id ||
      run.operation !== request.operation ||
      run.operationKey !== expectedOperationKey
    ) {
      return null;
    }
    if (
      inputRows.length !== request.sourceIds.length ||
      inputRows.some((row, index) => row.sourceId !== request.sourceIds[index])
    ) {
      return null;
    }
    const manifest = buildInputManifest(
      inputRows.map((row) => ({
        sourceId: row.sourceId,
        contentFingerprint: row.contentFingerprint,
        contentBytes: row.contentBytes,
        scannerVersion: row.scannerVersion,
      })),
    );
    const inputManifestFingerprint = buildInputManifestFingerprint(manifest);
    const inputBytes = sumInputBytes(manifest);
    const executionProfile = resolveAiExecutionProfile(request.operation, grant);
    if (executionProfile === null) {
      return null;
    }
    const operationKey = operationKeyForContext(
      request,
      revision,
      grant,
      executionProfile,
      manifest,
    );
    const context: PreparedContext = {
      request,
      revision,
      grant,
      executionProfile,
      manifest,
      inputManifestFingerprint,
      inputBytes,
      operationKey,
    };
    return operationKey === expectedOperationKey &&
      runMatchesSnapshot(run, context, inputRows)
      ? context
      : null;
  } catch {
    return null;
  }
}

function runResult(
  kind: "created" | "existing",
  run: ExistingRunRow,
  context: PreparedContext,
): PrepareOrGetRunResult {
  return {
    kind,
    status: safeRunStatus(run.status),
    runId: run.id,
    operationKey: context.operationKey,
    inputManifestFingerprint: context.inputManifestFingerprint,
    inputBytes: context.inputBytes,
    sourceCount: context.manifest.length,
    safeCode: null,
  };
}

async function lockProject(
  tx: Prisma.TransactionClient,
  projectId: string,
): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id"::text AS "id"
      FROM "Project"
     WHERE "id" = ${projectId}::uuid
     FOR UPDATE
  `);
  return rows.length === 1;
}

/**
 * Lock only the frozen parents needed by completion-time audit foreign keys.
 *
 * Completion must observe the claim's sealed revision and grant, not the
 * current policy pointer or grant lifecycle.  Keeping this helper separate
 * from the preflight lock path preserves the Project -> revision -> grant ->
 * Run -> Attempt order without re-running authorization after dispatch.
 */
async function lockCompletionFrozenParents(
  tx: Prisma.TransactionClient,
  projectId: string,
  policyRevisionId: string,
  grantId: string,
): Promise<boolean> {
  const projectRows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id"::text AS "id"
      FROM "Project"
     WHERE "id" = ${projectId}::uuid
     FOR UPDATE
  `);
  if (projectRows.length !== 1 || projectRows[0]?.id !== projectId) {
    return false;
  }

  const revisionRows = await tx.$queryRaw<
    Array<{ id: string; projectId: string }>
  >(Prisma.sql`
    SELECT
      "id"::text AS "id",
      "projectId"::text AS "projectId"
      FROM "ProjectAiPolicyRevision"
     WHERE "projectId" = ${projectId}::uuid
       AND "id" = ${policyRevisionId}::uuid
     FOR KEY SHARE
  `);
  if (
    revisionRows.length !== 1 ||
    revisionRows[0]?.id !== policyRevisionId ||
    revisionRows[0]?.projectId !== projectId
  ) {
    return false;
  }

  const grantRows = await tx.$queryRaw<
    Array<{ id: string; projectId: string }>
  >(Prisma.sql`
    SELECT
      "id"::text AS "id",
      "projectId"::text AS "projectId"
      FROM "ModelProcessingGrant"
     WHERE "projectId" = ${projectId}::uuid
       AND "id" = ${grantId}::uuid
     FOR KEY SHARE
  `);
  return (
    grantRows.length === 1 &&
    grantRows[0]?.id === grantId &&
    grantRows[0]?.projectId === projectId
  );
}

async function lockPolicyPointer(
  tx: Prisma.TransactionClient,
  projectId: string,
): Promise<{ currentRevisionId: string } | null> {
  const rows = await tx.$queryRaw<Array<{ currentRevisionId: string }>>(Prisma.sql`
    SELECT "currentRevisionId"::text AS "currentRevisionId"
      FROM "ProjectAiPolicy"
     WHERE "projectId" = ${projectId}::uuid
     FOR UPDATE
  `);
  return rows[0] ?? null;
}

async function lockPolicyRevision(
  tx: Prisma.TransactionClient,
  projectId: string,
  revisionId: string,
): Promise<PolicyRevisionRow | null> {
  const rows = await tx.$queryRaw<PolicyRevisionRow[]>(Prisma.sql`
    SELECT
      "id"::text AS "id",
      "projectId"::text AS "projectId",
      "revision",
      "outboundEnabled",
      "embeddingEnabled",
      "autoExtractEnabled",
      "sourceSummaryEnabled",
      "projectAnalysisEnabled",
      "generateWithContextEnabled",
      "profileFingerprint",
      "processorFingerprint",
      "regionFingerprint",
      "retentionFingerprint",
      "endpointFingerprint",
      "budgetFingerprint",
      "scannerFingerprint"
    FROM "ProjectAiPolicyRevision"
    WHERE "projectId" = ${projectId}::uuid
      AND "id" = ${revisionId}::uuid
    FOR KEY SHARE
  `);
  return rows[0] ?? null;
}

async function lockOperationProfile(
  tx: Prisma.TransactionClient,
  projectId: string,
  revisionId: string,
  operation: AiOperation,
): Promise<OperationProfileRow | null> {
  const rows = await tx.$queryRaw<OperationProfileRow[]>(Prisma.sql`
    SELECT
      "id"::text AS "id",
      "projectId"::text AS "projectId",
      "policyRevisionId"::text AS "policyRevisionId",
      "operation"::text AS "operation",
      "profileFingerprint",
      "providerFingerprint",
      "modelFingerprint",
      "modelId",
      "processorFingerprint",
      "regionFingerprint",
      "retentionFingerprint",
      "endpointFingerprint"
    FROM "ProjectAiPolicyOperationProfile"
    WHERE "projectId" = ${projectId}::uuid
      AND "policyRevisionId" = ${revisionId}::uuid
      AND "operation" = ${operation}::"AiOperation"
    FOR KEY SHARE
  `);
  return rows[0] ?? null;
}

async function lockGrant(
  tx: Prisma.TransactionClient,
  projectId: string,
  grantId: string,
): Promise<GrantRow | null> {
  const rows = await tx.$queryRaw<GrantRow[]>(Prisma.sql`
    SELECT
      "id"::text AS "id",
      "projectId"::text AS "projectId",
      "status"::text AS "status",
      "policyRevisionId"::text AS "policyRevisionId",
      "profileFingerprint",
      "providerFingerprint",
      "modelFingerprint",
      "modelId",
      "processorFingerprint",
      "regionFingerprint",
      "retentionFingerprint",
      "endpointFingerprint",
      "grantFingerprint",
      "effectivePolicyVersion",
      "budgetFingerprint",
      "scannerFingerprint",
      "scannerVersion",
      "budgetProfile"::text AS "budgetProfile",
      "expiresAt",
      "revokedAt",
      ("expiresAt" > CURRENT_TIMESTAMP) AS "expiresAtIsLive"
    FROM "ModelProcessingGrant"
    WHERE "projectId" = ${projectId}::uuid
      AND "id" = ${grantId}::uuid
    FOR UPDATE
  `);
  return rows[0] ?? null;
}

/**
 * Closure uses the frozen grant as an audit parent, not as a live
 * authorization decision.  KEY SHARE preserves the completion/closure
 * Project -> revision -> grant lock order without re-checking lifecycle.
 */
async function lockFrozenGrant(
  tx: Prisma.TransactionClient,
  projectId: string,
  grantId: string,
): Promise<GrantRow | null> {
  const rows = await tx.$queryRaw<GrantRow[]>(Prisma.sql`
    SELECT
      "id"::text AS "id",
      "projectId"::text AS "projectId",
      "status"::text AS "status",
      "policyRevisionId"::text AS "policyRevisionId",
      "profileFingerprint",
      "providerFingerprint",
      "modelFingerprint",
      "modelId",
      "processorFingerprint",
      "regionFingerprint",
      "retentionFingerprint",
      "endpointFingerprint",
      "grantFingerprint",
      "effectivePolicyVersion",
      "budgetFingerprint",
      "scannerFingerprint",
      "scannerVersion",
      "budgetProfile"::text AS "budgetProfile",
      "expiresAt",
      "revokedAt",
      ("expiresAt" > CURRENT_TIMESTAMP) AS "expiresAtIsLive"
    FROM "ModelProcessingGrant"
    WHERE "projectId" = ${projectId}::uuid
      AND "id" = ${grantId}::uuid
    FOR KEY SHARE
  `);
  return rows[0] ?? null;
}

async function lockClosureFrozenParents(
  tx: Prisma.TransactionClient,
  projectId: string,
  policyRevisionId: string,
  grantId: string,
): Promise<{ revision: PolicyRevisionRow; grant: GrantRow } | null> {
  if (!(await lockProject(tx, projectId))) {
    return null;
  }
  const revision = await lockPolicyRevision(tx, projectId, policyRevisionId);
  if (
    revision === null ||
    revision.projectId !== projectId ||
    revision.id !== policyRevisionId
  ) {
    return null;
  }
  const grant = await lockFrozenGrant(tx, projectId, grantId);
  if (
    grant === null ||
    grant.projectId !== projectId ||
    grant.id !== grantId ||
    grant.policyRevisionId !== policyRevisionId
  ) {
    return null;
  }
  return { revision, grant };
}

async function lockGrantOperation(
  tx: Prisma.TransactionClient,
  projectId: string,
  grantId: string,
  operation: AiOperation,
): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ operation: string }>>(Prisma.sql`
    SELECT "operation"::text AS "operation"
      FROM "ModelProcessingGrantOperation"
     WHERE "projectId" = ${projectId}::uuid
       AND "grantId" = ${grantId}::uuid
       AND "operation" = ${operation}::"AiOperation"
     FOR KEY SHARE
  `);
  return rows.length === 1;
}

async function lockGrantSource(
  tx: Prisma.TransactionClient,
  projectId: string,
  grantId: string,
  sourceId: string,
): Promise<GrantSourceRow | null> {
  const rows = await tx.$queryRaw<GrantSourceRow[]>(Prisma.sql`
    SELECT
      "sourceId"::text AS "sourceId",
      "contentFingerprint",
      "contentBytes"
    FROM "ModelProcessingGrantSource"
    WHERE "projectId" = ${projectId}::uuid
      AND "grantId" = ${grantId}::uuid
      AND "sourceId" = ${sourceId}::uuid
    FOR KEY SHARE
  `);
  return rows[0] ?? null;
}

async function lockProjectSource(
  tx: Prisma.TransactionClient,
  projectId: string,
  sourceId: string,
): Promise<ProjectSourceRow | null> {
  const rows = await tx.$queryRaw<ProjectSourceRow[]>(Prisma.sql`
    SELECT
      "id"::text AS "sourceId",
      "contentText",
      "contentHash"
    FROM "ProjectSource"
    WHERE "projectId" = ${projectId}::uuid
      AND "id" = ${sourceId}::uuid
    FOR KEY SHARE
  `);
  return rows[0] ?? null;
}

const RUN_SELECT = Prisma.sql`
  SELECT
    "id"::text AS "id",
    "projectId"::text AS "projectId",
    "grantId"::text AS "grantId",
    "policyRevisionId"::text AS "policyRevisionId",
    "operation"::text AS "operation",
    "operationKey",
    "operationKeySchemaVersion",
    "inputManifestFingerprint",
    "promptFingerprint",
    "promptVersion",
    "providerFingerprint",
    "modelId",
    "modelFingerprint",
    "profileFingerprint",
    "grantFingerprint",
    "effectivePolicyVersion",
    "processorFingerprint",
    "processorEndpointFingerprint",
    "processorRegionFingerprint",
    "processorRetentionFingerprint",
    "noRagSnapshotMarker",
    "status"::text AS "status",
    "inputBytes",
    "outputBytes",
    "maxInputTokens",
    "maxOutputTokens",
    "maxRequests",
    "maxBudgetMicros",
    "inputTokens",
    "outputTokens",
    "requestCount",
    "budgetUsedMicros",
    "pricingSnapshotId",
    "budgetStatus"::text AS "budgetStatus",
    "safeErrorCode"::text AS "safeErrorCode",
    "httpStatus",
    "providerRequestId",
    "providerResponseId"
`;

type RunClosureProbe = {
  id: string;
  projectId: string;
  grantId: string;
  policyRevisionId: string;
  operation: string;
  operationKey: string;
};

/** Unlocked identity probe; authorization starts only after frozen parents lock. */
async function probeRunForClosure(
  tx: Prisma.TransactionClient,
  request: ClaimAndDispatchRunRequest,
): Promise<RunClosureProbe | null> {
  const rows = await tx.$queryRaw<RunClosureProbe[]>(Prisma.sql`
    SELECT
      "id"::text AS "id",
      "projectId"::text AS "projectId",
      "grantId"::text AS "grantId",
      "policyRevisionId"::text AS "policyRevisionId",
      "operation"::text AS "operation",
      "operationKey"
    FROM "AiRun"
    WHERE "projectId" = ${request.projectId}::uuid
      AND "id" = ${request.runId}::uuid
      AND "operationKey" = ${request.operationKey}
  `);
  return rows[0] ?? null;
}

async function readRunWithInputs(
  tx: Prisma.TransactionClient,
  projectId: string,
  operationKey: string,
  lock: boolean,
): Promise<{ run: ExistingRunRow; inputs: ExistingInputRow[] } | null> {
  const runRows = lock
    ? await tx.$queryRaw<ExistingRunRow[]>(Prisma.sql`
        ${RUN_SELECT}
        FROM "AiRun"
        WHERE "projectId" = ${projectId}::uuid
          AND "operationKey" = ${operationKey}
        FOR UPDATE
      `)
    : await tx.$queryRaw<ExistingRunRow[]>(Prisma.sql`
        ${RUN_SELECT}
        FROM "AiRun"
        WHERE "projectId" = ${projectId}::uuid
          AND "operationKey" = ${operationKey}
      `);
  const run = runRows[0];
  if (run === undefined) {
    return null;
  }
  const inputs = lock
    ? await tx.$queryRaw<ExistingInputRow[]>(Prisma.sql`
        SELECT
          "sourceId"::text AS "sourceId",
          "contentFingerprint",
          "contentBytes",
          "scannerVersion",
          "safeScanResult"::text AS "safeScanResult",
          "evidenceManifestFingerprint"
        FROM "AiRunInputSource"
        WHERE "projectId" = ${projectId}::uuid
          AND "aiRunId" = ${run.id}::uuid
        ORDER BY "sourceId" ASC
        FOR KEY SHARE
      `)
    : await tx.$queryRaw<ExistingInputRow[]>(Prisma.sql`
        SELECT
          "sourceId"::text AS "sourceId",
          "contentFingerprint",
          "contentBytes",
          "scannerVersion",
          "safeScanResult"::text AS "safeScanResult",
          "evidenceManifestFingerprint"
        FROM "AiRunInputSource"
        WHERE "projectId" = ${projectId}::uuid
          AND "aiRunId" = ${run.id}::uuid
        ORDER BY "sourceId" ASC
      `);
  return { run, inputs };
}

async function readRunAttempts(
  tx: Prisma.TransactionClient,
  projectId: string,
  runId: string,
  lock: boolean,
): Promise<ExistingAttemptRow[]> {
  const query = lock
    ? Prisma.sql`
        SELECT
          "id"::text AS "id",
          "projectId"::text AS "projectId",
          "aiRunId"::text AS "aiRunId",
          "attemptNumber",
          "dispatchToken",
          "status"::text AS "status",
          "providerRequestId",
          "providerResponseId",
          "httpStatus",
          "inputTokens",
          "outputTokens",
          "requestCount",
          "safeErrorCode"::text AS "safeErrorCode"
        FROM "AiRunAttempt"
        WHERE "projectId" = ${projectId}::uuid
          AND "aiRunId" = ${runId}::uuid
        ORDER BY "attemptNumber" ASC
        FOR UPDATE
      `
    : Prisma.sql`
        SELECT
          "id"::text AS "id",
          "projectId"::text AS "projectId",
          "aiRunId"::text AS "aiRunId",
          "attemptNumber",
          "dispatchToken",
          "status"::text AS "status",
          "providerRequestId",
          "providerResponseId",
          "httpStatus",
          "inputTokens",
          "outputTokens",
          "requestCount",
          "safeErrorCode"::text AS "safeErrorCode"
        FROM "AiRunAttempt"
        WHERE "projectId" = ${projectId}::uuid
          AND "aiRunId" = ${runId}::uuid
        ORDER BY "attemptNumber" ASC
      `;
  return tx.$queryRaw<ExistingAttemptRow[]>(query);
}

type ClaimedDispatch = {
  kind: "claimed";
  runId: string;
  operationKey: string;
  attemptId: string;
  dispatchToken: string;
  request: ClaimAndDispatchRunRequest;
  context: PreparedContext;
};

type ClaimTransactionResult = ClaimedDispatch | ClaimAndDispatchRunResult;

type QueuedRunClosure = {
  status: "failed" | "cancelled";
  safeCode:
    | "AI_POLICY_DENIED"
    | "AI_GRANT_DENIED"
    | "AI_SCANNER_DENIED"
    | "AI_BUDGET_DENIED";
  budgetStatus: "pending" | "rejected";
  eventType: "runFailed" | "runCancelled";
};

function queuedRunClosureFor(
  safeCode: QueuedRunClosure["safeCode"],
): QueuedRunClosure {
  if (safeCode === "AI_POLICY_DENIED" || safeCode === "AI_GRANT_DENIED") {
    return {
      status: "cancelled",
      safeCode,
      budgetStatus: "pending",
      eventType: "runCancelled",
    };
  }
  return {
    status: "failed",
    safeCode,
    budgetStatus: safeCode === "AI_BUDGET_DENIED" ? "rejected" : "pending",
    eventType: "runFailed",
  };
}

class AiRuntimeServiceImpl {
  private readonly db: PrismaClient;
  private readonly transaction: TransactionRunner;
  private readonly admissibilityGate: AiAdmissibilityGate;
  private readonly provider: AiRuntimeProvider | null;
  private readonly completionHandler: AiRuntimeCompletionHandler | null;
  private readonly idFactory: () => string;
  private readonly transactionRetryLimit: number;

  constructor(options: CreateAiRuntimeServiceOptions) {
    const rawOptions: unknown = options;
    if (
      !isPlainRecord(rawOptions) ||
      Object.keys(rawOptions).some(
        (key) => !(SERVICE_OPTION_FIELDS as readonly string[]).includes(key),
      ) ||
      rawOptions.db === undefined ||
      rawOptions.admissibilityGate === undefined
    ) {
      invalidInput();
    }
    const candidateDb = rawOptions.db;
    const candidateGate = rawOptions.admissibilityGate;
    if (
      typeof candidateDb !== "object" ||
      candidateDb === null ||
      typeof (candidateDb as { $transaction?: unknown }).$transaction !== "function"
    ) {
      invalidInput();
    }
    if (
      typeof candidateGate !== "object" ||
      candidateGate === null ||
      typeof (candidateGate as { assess?: unknown }).assess !== "function"
    ) {
      invalidInput();
    }
    const candidateProvider = rawOptions.provider;
    if (
      candidateProvider !== undefined &&
      (candidateProvider === null ||
        (typeof candidateProvider !== "object" && typeof candidateProvider !== "function") ||
        typeof (candidateProvider as { dispatch?: unknown }).dispatch !== "function")
    ) {
      invalidInput();
    }
    const candidateCompletionHandler = rawOptions.completionHandler;
    if (
      candidateCompletionHandler !== undefined &&
      (candidateCompletionHandler === null ||
        typeof candidateCompletionHandler !== "object" ||
        typeof (candidateCompletionHandler as { complete?: unknown }).complete !==
          "function")
    ) {
      invalidInput();
    }
    if (rawOptions.idFactory !== undefined && typeof rawOptions.idFactory !== "function") {
      invalidInput();
    }
    const retryLimit = rawOptions.transactionRetryLimit;
    if (
      retryLimit !== undefined &&
      (typeof retryLimit !== "number" ||
        !Number.isSafeInteger(retryLimit) ||
        retryLimit < 1 ||
        retryLimit > DEFAULT_TRANSACTION_RETRY_LIMIT)
    ) {
      invalidInput();
    }
    this.db = candidateDb as PrismaClient;
    this.transaction = this.db.$transaction.bind(this.db) as TransactionRunner;
    this.admissibilityGate = candidateGate as AiAdmissibilityGate;
    this.provider =
      candidateProvider === undefined ? null : (candidateProvider as AiRuntimeProvider);
    this.completionHandler = candidateCompletionHandler === undefined
      ? null
      : (candidateCompletionHandler as AiRuntimeCompletionHandler);
    this.idFactory = (rawOptions.idFactory as (() => string) | undefined) ?? randomUUID;
    this.transactionRetryLimit = retryLimit ?? DEFAULT_TRANSACTION_RETRY_LIMIT;
  }

  async prepareOrGetRun(value: unknown): Promise<PrepareOrGetRunResult> {
    const request = parsePrepareOrGetRequest(value);
    for (let attempt = 0; attempt < this.transactionRetryLimit; attempt += 1) {
      try {
        return await this.transaction(
          (tx) => this.prepareInTransaction(tx, request, true),
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (error: unknown) {
        if (
          isAiRuntimeSerializationConflict(error) &&
          attempt + 1 < this.transactionRetryLimit
        ) {
          continue;
        }
        if (isAiRuntimeOperationKeyConflict(error)) {
          return this.reconcileOperationKey(request);
        }
        if (error instanceof AiRuntimeServiceError) {
          return rejected(error.code);
        }
        return rejected("AI_INVALID_PROVIDER_RESPONSE");
      }
    }
    return rejected("AI_INVALID_PROVIDER_RESPONSE");
  }

  async claimAndDispatchRun(value: unknown): Promise<ClaimAndDispatchRunResult> {
    const request = parseClaimAndDispatchRunRequest(value);
    const provider = this.provider;
    if (provider === null) {
      return claimRejected("AI_PROVIDER_DISABLED", request);
    }

    let claim: ClaimTransactionResult | undefined;
    for (let attempt = 0; attempt < this.transactionRetryLimit; attempt += 1) {
      try {
        claim = await this.transaction(
          (tx) => this.claimInTransaction(tx, request),
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
        break;
      } catch (error: unknown) {
        if (isAiRuntimeSerializationConflict(error)) {
          if (attempt + 1 < this.transactionRetryLimit) {
            continue;
          }
          return this.reconcileClaimConflict(request);
        }
        if (error instanceof AiRuntimeServiceError) {
          return claimRejected(error.code, request);
        }
        return claimRejected("AI_INVALID_PROVIDER_RESPONSE", request);
      }
    }

    if (claim === undefined || !("context" in claim)) {
      return claim ?? claimRejected("AI_INVALID_PROVIDER_RESPONSE", request);
    }

    let dispatched: NormalizedProviderDispatch;
    try {
      dispatched = normalizeProviderDispatch(
        await provider.dispatch({
          projectId: claim.request.projectId,
          runId: claim.runId,
          attemptId: claim.attemptId,
          dispatchToken: claim.dispatchToken,
          operation: claim.request.operation,
          operationKey: claim.operationKey,
        }),
        claim.context.inputBytes,
        claim.context.executionProfile,
      );
    } catch {
      dispatched = Object.freeze({
        classification: unknownProviderClassification(),
        completionPayload: null,
        hasCompletionPayload: false,
        outputBytes: 0,
      });
    }
    return this.completeClaim(claim, dispatched);
  }

  async execute(value: unknown): Promise<ClaimAndDispatchRunResult> {
    const request = parsePrepareOrGetRequest(value);
    if (this.provider === null) {
      return claimRejected("AI_PROVIDER_DISABLED");
    }
    const prepared = await this.prepareOrGetRun(request);
    if (prepared.kind === "rejected") {
      return {
        kind: "rejected",
        status: "failed",
        safeCode: prepared.safeCode,
        ...(prepared.operationKey === undefined
          ? {}
          : { operationKey: prepared.operationKey }),
      };
    }
    return this.claimAndDispatchRun({
      ...request,
      runId: prepared.runId,
      operationKey: prepared.operationKey,
    });
  }

  private async writePreflightRejectionAudit(
    tx: Prisma.TransactionClient,
    request: PrepareOrGetRunRequest,
    context: PreparedContext,
    safeCode: "AI_SCANNER_DENIED" | "AI_BUDGET_DENIED",
  ): Promise<void> {
    await tx.aiAuditEvent.create({
      data: {
        id: safeGeneratedId(this.idFactory),
        projectId: request.projectId,
        policyRevisionId: context.revision.id,
        eventType: (
          safeCode === "AI_BUDGET_DENIED" ? "budgetRejected" : "scannerRejected"
        ) as DbAiAuditEventType,
        safeCode: dbSafeErrorCode(safeCode),
        eventFingerprint: context.inputManifestFingerprint,
        fingerprintCount: context.manifest.length,
        byteCount: context.inputBytes,
        requestCount: 0,
        grantId: request.grantId,
        aiRunId: null,
        attemptId: null,
      },
    });
  }

  private async writeQueuedRunClosureAudit(
    tx: Prisma.TransactionClient,
    request: ClaimAndDispatchRunRequest,
    context: PreparedContext,
    runId: string,
    closure: QueuedRunClosure,
  ): Promise<void> {
    await tx.aiAuditEvent.create({
      data: {
        id: safeGeneratedId(this.idFactory),
        projectId: request.projectId,
        policyRevisionId: context.revision.id,
        eventType: closure.eventType as DbAiAuditEventType,
        safeCode: dbSafeErrorCode(closure.safeCode),
        eventFingerprint: context.operationKey,
        fingerprintCount: context.manifest.length,
        byteCount: context.inputBytes,
        tokenCount: 0,
        requestCount: 0,
        httpStatus: null,
        grantId: context.grant.id,
        aiRunId: runId,
        attemptId: null,
      },
    });
  }

  private async closeQueuedRunInTransaction(
    tx: Prisma.TransactionClient,
    request: ClaimAndDispatchRunRequest,
    context: PreparedContext,
    existing: { run: ExistingRunRow; inputs: ExistingInputRow[] },
    attempts: readonly ExistingAttemptRow[],
    closure: QueuedRunClosure,
  ): Promise<ClaimTransactionResult> {
    if (
      existing.run.projectId !== request.projectId ||
      existing.run.id !== request.runId ||
      existing.run.grantId !== request.grantId ||
      existing.run.policyRevisionId !== context.revision.id ||
      existing.run.operation !== request.operation ||
      existing.run.operationKey !== request.operationKey ||
      !runMatchesSnapshot(existing.run, context, existing.inputs)
    ) {
      return claimRejected("AI_INVALID_OPERATION_KEY_INPUT", request);
    }
    if (existing.run.status !== "queued") {
      return existingClaimResult(existing.run, attempts);
    }
    if (existing.run.requestCount !== 0 || attempts.length !== 0) {
      return claimRejected("AI_INVALID_PROVIDER_RESPONSE", request);
    }

    const terminalStatus =
      closure.status === "cancelled"
        ? Prisma.sql`'cancelled'::"AiRunStatus"`
        : Prisma.sql`'failed'::"AiRunStatus"`;
    const budgetStatus =
      closure.budgetStatus === "rejected"
        ? Prisma.sql`'rejected'::"AiBudgetStatus"`
        : Prisma.sql`'pending'::"AiBudgetStatus"`;
    const updated = await tx.$executeRaw<number>(Prisma.sql`
      UPDATE "AiRun"
         SET "status" = ${terminalStatus},
             "budgetStatus" = ${budgetStatus},
             "safeErrorCode" = ${closure.safeCode}::"AiSafeErrorCode",
             "completedAt" = CURRENT_TIMESTAMP
       WHERE "projectId" = ${request.projectId}::uuid
         AND "id" = ${request.runId}::uuid
         AND "grantId" = ${request.grantId}::uuid
         AND "policyRevisionId" = ${context.revision.id}::uuid
         AND "operation" = ${request.operation}::"AiOperation"
         AND "operationKey" = ${request.operationKey}
         AND "status" = 'queued'::"AiRunStatus"
         AND "requestCount" = 0
    `);
    if (Number(updated) !== 1) {
      const current = await readRunWithInputs(
        tx,
        request.projectId,
        request.operationKey,
        true,
      );
      if (
        current !== null &&
        current.run.id === request.runId &&
        runMatchesSnapshot(current.run, context, current.inputs) &&
        current.run.status !== "queued"
      ) {
        return existingClaimResult(
          current.run,
          await readRunAttempts(tx, request.projectId, request.runId, true),
        );
      }
      return claimRejected("AI_INVALID_PROVIDER_RESPONSE", request);
    }

    await this.writeQueuedRunClosureAudit(
      tx,
      request,
      context,
      existing.run.id,
      closure,
    );
    return claimRejected(closure.safeCode, request);
  }

  private async closeAfterLiveRejection(
    tx: Prisma.TransactionClient,
    request: ClaimAndDispatchRunRequest,
    liveRejection: PrepareOrGetRunResult,
  ): Promise<ClaimTransactionResult> {
    if (
      liveRejection.safeCode !== "AI_POLICY_DENIED" &&
      liveRejection.safeCode !== "AI_GRANT_DENIED"
    ) {
      return claimRejected(
        liveRejection.safeCode ?? "AI_INVALID_PROVIDER_RESPONSE",
        request,
      );
    }

    const probe = await probeRunForClosure(tx, request);
    if (
      probe === null ||
      probe.id !== request.runId ||
      probe.projectId !== request.projectId ||
      probe.grantId !== request.grantId ||
      probe.operation !== request.operation ||
      probe.operationKey !== request.operationKey
    ) {
      return claimRejected(liveRejection.safeCode, request);
    }

    const parents = await lockClosureFrozenParents(
      tx,
      request.projectId,
      probe.policyRevisionId,
      probe.grantId,
    );
    if (parents === null) {
      return claimRejected("AI_INVALID_PROVIDER_RESPONSE", request);
    }
    const existing = await readRunWithInputs(
      tx,
      request.projectId,
      request.operationKey,
      true,
    );
    if (existing === null) {
      return claimRejected("AI_INVALID_PROVIDER_RESPONSE", request);
    }
    const attempts = await readRunAttempts(
      tx,
      request.projectId,
      request.runId,
      true,
    );
    const context = buildClosureContext(
      request,
      request.operationKey,
      parents.revision,
      parents.grant,
      existing.run,
      existing.inputs,
    );
    if (context === null) {
      return claimRejected("AI_INVALID_OPERATION_KEY_INPUT", request);
    }
    return this.closeQueuedRunInTransaction(
      tx,
      request,
      context,
      existing,
      attempts,
      queuedRunClosureFor(liveRejection.safeCode),
    );
  }

  private async observeAfterLiveRejection(
    tx: Prisma.TransactionClient,
    request: ClaimAndDispatchRunRequest,
    liveRejection: PrepareOrGetRunResult,
  ): Promise<ClaimAndDispatchRunResult> {
    if (
      liveRejection.safeCode !== "AI_POLICY_DENIED" &&
      liveRejection.safeCode !== "AI_GRANT_DENIED"
    ) {
      return claimRejected(
        liveRejection.safeCode ?? "AI_INVALID_PROVIDER_RESPONSE",
        request,
      );
    }
    const probe = await probeRunForClosure(tx, request);
    if (
      probe === null ||
      probe.id !== request.runId ||
      probe.projectId !== request.projectId ||
      probe.grantId !== request.grantId ||
      probe.operation !== request.operation ||
      probe.operationKey !== request.operationKey
    ) {
      return claimRejected(liveRejection.safeCode, request);
    }
    const parents = await lockClosureFrozenParents(
      tx,
      request.projectId,
      probe.policyRevisionId,
      probe.grantId,
    );
    if (parents === null) {
      return claimRejected(liveRejection.safeCode, request);
    }
    const existing = await readRunWithInputs(
      tx,
      request.projectId,
      request.operationKey,
      true,
    );
    if (existing === null) {
      return claimRejected("AI_INVALID_PROVIDER_RESPONSE", request);
    }
    const context = buildClosureContext(
      request,
      request.operationKey,
      parents.revision,
      parents.grant,
      existing.run,
      existing.inputs,
    );
    if (context === null) {
      return claimRejected("AI_INVALID_OPERATION_KEY_INPUT", request);
    }
    const attempts = await readRunAttempts(
      tx,
      request.projectId,
      request.runId,
      true,
    );
    if (existing.run.status === "queued") {
      return claimRejected(liveRejection.safeCode, request);
    }
    return existingClaimResult(existing.run, attempts);
  }

  private async prepareInTransaction(
    tx: Prisma.TransactionClient,
    request: PrepareOrGetRunRequest,
    allowCreate: boolean,
  ): Promise<PrepareOrGetRunResult> {
    const context = await this.lockAndBuildContext(tx, request);
    if ("safeCode" in context) {
      return context;
    }

    const existing = await readRunWithInputs(tx, request.projectId, context.operationKey, true);
    if (existing !== null) {
      if (!runMatchesSnapshot(existing.run, context, existing.inputs)) {
        return rejected("AI_INVALID_OPERATION_KEY_INPUT", context);
      }
      return runResult("existing", existing.run, context);
    }
    if (!allowCreate) {
      return rejected("AI_INVALID_PROVIDER_RESPONSE", context);
    }

    try {
      assertAiExecutionInputWithinProfile(
        context.executionProfile,
        context.inputBytes,
      );
      calculateAiExecutionBudgetMicros(context.executionProfile, {
        inputBytes: context.inputBytes,
        inputTokens: 0,
        outputTokens: 0,
      });
    } catch (error: unknown) {
      if (
        !(error instanceof AiRuntimeServiceError) ||
        error.code !== "AI_BUDGET_DENIED"
      ) {
        throwAiRuntimeServiceError("AI_INVALID_PROVIDER_RESPONSE");
      }
      await this.writePreflightRejectionAudit(
        tx,
        request,
        context,
        "AI_BUDGET_DENIED",
      );
      return rejected("AI_BUDGET_DENIED", context);
    }

    const runId = safeGeneratedId(this.idFactory);
    let gateResult: FakeAdmissibilityResult;
    try {
      gateResult = safeGateResult(
        this.admissibilityGate.assess({
          projectId: request.projectId,
          runId,
          operationKey: context.operationKey,
          inputManifest: context.manifest,
          inputManifestFingerprint: context.inputManifestFingerprint,
        }),
        context,
        runId,
      );
    } catch (error: unknown) {
      if (error instanceof AiRuntimeServiceError) {
        throw error;
      }
      throwAiRuntimeServiceError("AI_INVALID_PROVIDER_RESPONSE");
    }

    if (!gateResult.admissible) {
      if (gateResult.safeCode === null) {
        throwAiRuntimeServiceError("AI_INVALID_PROVIDER_RESPONSE");
      }
      await this.writePreflightRejectionAudit(
        tx,
        request,
        context,
        gateResult.safeCode,
      );
      return rejected(gateResult.safeCode ?? "AI_SCANNER_DENIED", context);
    }

    const expected = expectedRunFields(context);
    await tx.aiRun.create({
      data: {
        id: runId,
        projectId: expected.projectId as string,
        grantId: expected.grantId as string,
        policyRevisionId: expected.policyRevisionId as string,
        operation: expected.operation as DbAiOperation,
        operationKey: expected.operationKey as string,
        operationKeySchemaVersion: expected.operationKeySchemaVersion as string,
        inputManifestFingerprint: expected.inputManifestFingerprint as string,
        promptFingerprint: expected.promptFingerprint as string,
        promptVersion: expected.promptVersion as string,
        providerFingerprint: expected.providerFingerprint as string,
        modelId: expected.modelId as string,
        modelFingerprint: expected.modelFingerprint as string,
        profileFingerprint: expected.profileFingerprint as string,
        grantFingerprint: expected.grantFingerprint as string,
        effectivePolicyVersion: expected.effectivePolicyVersion as number,
        processorFingerprint: expected.processorFingerprint as string,
        processorEndpointFingerprint: expected.processorEndpointFingerprint as string,
        processorRegionFingerprint: expected.processorRegionFingerprint as string,
        processorRetentionFingerprint: expected.processorRetentionFingerprint as string,
        noRagSnapshotMarker: expected.noRagSnapshotMarker as string,
        inputBytes: expected.inputBytes as number,
        outputBytes: expected.outputBytes as number,
        maxInputTokens: expected.maxInputTokens as number,
        maxOutputTokens: expected.maxOutputTokens as number,
        maxRequests: expected.maxRequests as number,
        maxBudgetMicros: expected.maxBudgetMicros as number,
        inputTokens: expected.inputTokens as number,
        outputTokens: expected.outputTokens as number,
        requestCount: expected.requestCount as number,
        budgetUsedMicros: expected.budgetUsedMicros as number,
        pricingSnapshotId: expected.pricingSnapshotId as string,
        budgetStatus: expected.budgetStatus as DbAiBudgetStatus,
        safeErrorCode: null,
        httpStatus: null,
        providerRequestId: null,
        providerResponseId: null,
        status: "queued" as DbAiRunStatus,
      },
    });

    for (const entry of context.manifest) {
      await tx.aiRunInputSource.create({
        data: {
          id: safeGeneratedId(this.idFactory),
          projectId: request.projectId,
          aiRunId: runId,
          grantId: request.grantId,
          sourceId: entry.sourceId,
          contentFingerprint: entry.contentFingerprint,
          contentBytes: entry.contentBytes,
          scannerVersion: entry.scannerVersion,
          safeScanResult: "passed" as DbAiSafeScanResult,
          evidenceManifestFingerprint: entry.evidenceManifestFingerprint,
        },
      });
    }

    await tx.aiAuditEvent.create({
      data: {
        id: safeGeneratedId(this.idFactory),
        projectId: request.projectId,
        policyRevisionId: context.revision.id,
        eventType: "runCreated" as DbAiAuditEventType,
        safeCode: null,
        eventFingerprint: context.operationKey,
        fingerprintCount: context.manifest.length,
        byteCount: context.inputBytes,
        requestCount: 0,
        grantId: request.grantId,
        aiRunId: runId,
        attemptId: null,
      },
    });

    const persisted = await readRunWithInputs(tx, request.projectId, context.operationKey, true);
    if (persisted === null || !runMatchesSnapshot(persisted.run, context, persisted.inputs)) {
      throwAiRuntimeServiceError("AI_INVALID_OPERATION_KEY_INPUT");
    }
    return runResult("created", persisted.run, context);
  }

  private async claimInTransaction(
    tx: Prisma.TransactionClient,
    request: ClaimAndDispatchRunRequest,
  ): Promise<ClaimTransactionResult> {
    const context = await this.lockAndBuildContext(tx, request);
    if ("kind" in context) {
      return this.closeAfterLiveRejection(tx, request, context);
    }
    if (context.operationKey !== request.operationKey) {
      return claimRejected("AI_INVALID_OPERATION_KEY_INPUT", request);
    }

    const existing = await readRunWithInputs(
      tx,
      request.projectId,
      request.operationKey,
      true,
    );
    if (
      existing === null ||
      existing.run.id !== request.runId ||
      !runMatchesSnapshot(existing.run, context, existing.inputs)
    ) {
      return claimRejected("AI_INVALID_OPERATION_KEY_INPUT", request);
    }
    const attempts = await readRunAttempts(tx, request.projectId, request.runId, true);
    if (existing.run.status !== "queued") {
      return existingClaimResult(existing.run, attempts);
    }
    if (existing.run.requestCount !== 0 || attempts.length !== 0) {
      return claimRejected("AI_INVALID_OPERATION_KEY_INPUT", request);
    }

    try {
      assertAiExecutionInputWithinProfile(
        context.executionProfile,
        context.inputBytes,
      );
      calculateAiExecutionBudgetMicros(context.executionProfile, {
        inputBytes: context.inputBytes,
        inputTokens: 0,
        outputTokens: 0,
      });
    } catch (error: unknown) {
      if (
        !(error instanceof AiRuntimeServiceError) ||
        error.code !== "AI_BUDGET_DENIED"
      ) {
        throwAiRuntimeServiceError("AI_INVALID_PROVIDER_RESPONSE");
      }
      return this.closeQueuedRunInTransaction(
        tx,
        request,
        context,
        existing,
        attempts,
        queuedRunClosureFor("AI_BUDGET_DENIED"),
      );
    }

    let gateResult: FakeAdmissibilityResult;
    try {
      gateResult = safeGateResult(
        this.admissibilityGate.assess({
          projectId: request.projectId,
          runId: request.runId,
          operationKey: context.operationKey,
          inputManifest: context.manifest,
          inputManifestFingerprint: context.inputManifestFingerprint,
        }),
        context,
        request.runId,
      );
    } catch (error: unknown) {
      if (error instanceof AiRuntimeServiceError) {
        throw error;
      }
      throwAiRuntimeServiceError("AI_INVALID_PROVIDER_RESPONSE");
    }
    if (!gateResult.admissible) {
      const safeCode = gateResult.safeCode;
      if (safeCode === null) {
        throwAiRuntimeServiceError("AI_INVALID_PROVIDER_RESPONSE");
      }
      return this.closeQueuedRunInTransaction(
        tx,
        request,
        context,
        existing,
        attempts,
        queuedRunClosureFor(safeCode),
      );
    }

    const claimedRows = await tx.$executeRaw<number>(Prisma.sql`
      UPDATE "AiRun"
         SET "status" = 'running'::"AiRunStatus",
             "requestCount" = 1,
             "budgetStatus" = 'allowed'::"AiBudgetStatus",
             "claimedAt" = CURRENT_TIMESTAMP,
             "sentAt" = CURRENT_TIMESTAMP
       WHERE "projectId" = ${request.projectId}::uuid
         AND "id" = ${request.runId}::uuid
         AND "grantId" = ${request.grantId}::uuid
         AND "policyRevisionId" = ${context.revision.id}::uuid
         AND "operationKey" = ${request.operationKey}
         AND "status" = 'queued'::"AiRunStatus"
         AND "requestCount" = 0
    `);
    if (Number(claimedRows) !== 1) {
      const current = await readRunWithInputs(
        tx,
        request.projectId,
        request.operationKey,
        true,
      );
      if (
        current !== null &&
        current.run.id === request.runId &&
        runMatchesSnapshot(current.run, context, current.inputs) &&
        current.run.status !== "queued"
      ) {
        return existingClaimResult(
          current.run,
          await readRunAttempts(tx, request.projectId, request.runId, true),
        );
      }
      return claimRejected("AI_INVALID_PROVIDER_RESPONSE", request);
    }

    const attemptId = safeGeneratedId(this.idFactory);
    const dispatchToken = `dispatch-${attemptId}`;
    if (
      dispatchToken.length < 16 ||
      dispatchToken.length > 128 ||
      !/^[A-Za-z0-9._:-]+$/.test(dispatchToken) ||
      SECRET_OR_URL_PATTERN.test(dispatchToken)
    ) {
      throwAiRuntimeServiceError("AI_INVALID_PROVIDER_RESPONSE");
    }
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "AiRunAttempt" (
        "id", "projectId", "aiRunId", "attemptNumber", "dispatchToken",
        "status", "inputTokens", "outputTokens", "requestCount",
        "createdAt", "sentAt"
      ) VALUES (
        ${attemptId}::uuid,
        ${request.projectId}::uuid,
        ${request.runId}::uuid,
        1,
        ${dispatchToken},
        'sent'::"AiRunAttemptStatus",
        0,
        0,
        1,
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
      )
    `);
    await this.writeDispatchAudit(
      tx,
      request,
      context,
      "runClaimed",
      null,
    );
    await this.writeDispatchAudit(
      tx,
      request,
      context,
      "dispatchSent",
      attemptId,
    );
    return {
      kind: "claimed",
      runId: request.runId,
      operationKey: context.operationKey,
      attemptId,
      dispatchToken,
      request,
      context,
    };
  }

  private async writeDispatchAudit(
    tx: Prisma.TransactionClient,
    request: ClaimAndDispatchRunRequest,
    context: PreparedContext,
    eventType: "runClaimed" | "dispatchSent",
    attemptId: string | null,
  ): Promise<void> {
    await tx.aiAuditEvent.create({
      data: {
        id: safeGeneratedId(this.idFactory),
        projectId: request.projectId,
        policyRevisionId: context.revision.id,
        eventType: eventType as DbAiAuditEventType,
        safeCode: null,
        eventFingerprint: context.operationKey,
        fingerprintCount: context.manifest.length,
        byteCount: context.inputBytes,
        requestCount: 1,
        grantId: request.grantId,
        aiRunId: request.runId,
        attemptId,
      },
    });
  }

  /**
   * Observe a winner after the final recognized pre-dispatch conflict. This
   * transaction is deliberately read-only: it reuses the normal lock order,
   * but never calls the gate/provider, allocates IDs, or writes a row.
   */
  private async reconcileClaimConflict(
    request: ClaimAndDispatchRunRequest,
  ): Promise<ClaimAndDispatchRunResult> {
    try {
      return await this.transaction(
        async (tx) => {
          const context = await this.lockAndBuildContext(tx, request);
          if ("kind" in context) {
            return this.observeAfterLiveRejection(tx, request, context);
          }
          if (context.operationKey !== request.operationKey) {
            return claimRejected("AI_INVALID_OPERATION_KEY_INPUT", request);
          }

          const existing = await readRunWithInputs(
            tx,
            request.projectId,
            context.operationKey,
            true,
          );
          if (
            existing === null ||
            existing.run.projectId !== request.projectId ||
            existing.run.id !== request.runId ||
            existing.run.grantId !== request.grantId ||
            existing.run.policyRevisionId !== context.revision.id ||
            existing.run.operation !== request.operation ||
            !runMatchesSnapshot(existing.run, context, existing.inputs)
          ) {
            return claimRejected("AI_INVALID_OPERATION_KEY_INPUT", request);
          }

          const attempts = await readRunAttempts(
            tx,
            request.projectId,
            request.runId,
            true,
          );
          if (existing.run.status === "queued") {
            return claimRejected("AI_INVALID_PROVIDER_RESPONSE", request);
          }
          const observed = existingClaimResult(existing.run, attempts);
          return observed.kind === "existing"
            ? observed
            : claimRejected("AI_INVALID_PROVIDER_RESPONSE", request);
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
      );
    } catch (error: unknown) {
      if (error instanceof AiRuntimeServiceError) {
        return claimRejected(error.code, request);
      }
      return claimRejected("AI_INVALID_PROVIDER_RESPONSE", request);
    }
  }

  private async completeClaim(
    claim: ClaimedDispatch,
    dispatched: NormalizedProviderDispatch,
  ): Promise<ClaimAndDispatchRunResult> {
    for (let attempt = 0; attempt < this.transactionRetryLimit; attempt += 1) {
      try {
        return await this.transaction(
          (tx) => this.completeInTransaction(tx, claim, dispatched),
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (error: unknown) {
        if (
          isAiRuntimeSerializationConflict(error) &&
          attempt + 1 < this.transactionRetryLimit
        ) {
          continue;
        }
        return buildAiRuntimeCompletionFailureResult(
          claim.runId,
          claim.operationKey,
          claim.attemptId,
        );
      }
    }
    return buildAiRuntimeCompletionFailureResult(
      claim.runId,
      claim.operationKey,
      claim.attemptId,
    );
  }

  private async completeInTransaction(
    tx: Prisma.TransactionClient,
    claim: ClaimedDispatch,
    dispatched: NormalizedProviderDispatch,
  ): Promise<ClaimAndDispatchRunResult> {
    const classification = dispatched.classification;
    // The claim is already committed.  Lock the frozen audit-FK parents first
    // and do not re-read the mutable policy pointer or grant lifecycle here.
    if (
      !(await lockCompletionFrozenParents(
        tx,
        claim.request.projectId,
        claim.context.revision.id,
        claim.request.grantId,
      ))
    ) {
      throwAiRuntimeServiceError("AI_INVALID_PROVIDER_RESPONSE");
    }
    const current = await readRunWithInputs(
      tx,
      claim.request.projectId,
      claim.operationKey,
      true,
    );
    if (
      current === null ||
      current.run.id !== claim.runId ||
      !runMatchesSnapshot(current.run, claim.context, current.inputs)
    ) {
      throwAiRuntimeServiceError("AI_INVALID_PROVIDER_RESPONSE");
    }
    const attempts = await readRunAttempts(tx, claim.request.projectId, claim.runId, true);
    if (current.run.status !== "running") {
      return existingClaimResult(current.run, attempts);
    }
    const attempt = attempts.find(
      (entry) =>
        entry.id === claim.attemptId &&
        entry.dispatchToken === claim.dispatchToken &&
        entry.status === "sent" &&
        entry.requestCount === 1,
    );
    if (attempt === undefined || attempts.length !== 1) {
      throwAiRuntimeServiceError("AI_INVALID_PROVIDER_RESPONSE");
    }

    const usage = classification.usage ?? {
      inputTokens: 0,
      outputTokens: 0,
      requestCount: 1,
    };
    let budgetUsedMicros: number;
    try {
      assertAiExecutionInputWithinProfile(
        claim.context.executionProfile,
        current.run.inputBytes,
      );
      if (
        usage.inputTokens > current.run.maxInputTokens ||
        usage.outputTokens > current.run.maxOutputTokens ||
        usage.requestCount !== 1
      ) {
        throwAiRuntimeServiceError("AI_BUDGET_DENIED");
      }
      budgetUsedMicros = calculateAiExecutionBudgetMicros(
        claim.context.executionProfile,
        {
        inputBytes: current.run.inputBytes,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        },
      );
      if (budgetUsedMicros > current.run.maxBudgetMicros) {
        throwAiRuntimeServiceError("AI_BUDGET_DENIED");
      }
    } catch {
      throwAiRuntimeServiceError("AI_INVALID_PROVIDER_RESPONSE");
    }

    const runStatus = classification.runStatus;
    const attemptStatus = classification.attemptStatus;
    const runEventType = {
      succeeded: "runSucceeded",
      failed: "runFailed",
      unknown: "runUnknown",
      cancelled: "runCancelled",
    }[runStatus] as DbAiAuditEventType;
    const attemptEventType = {
      succeeded: "attemptSucceeded",
      failed: "attemptFailed",
      unknown: "attemptUnknown",
      cancelled: "attemptCancelled",
    }[attemptStatus] as DbAiAuditEventType;

    const attemptUpdated = await tx.$executeRaw<number>(Prisma.sql`
      UPDATE "AiRunAttempt"
         SET "status" = ${attemptStatus}::"AiRunAttemptStatus",
             "providerRequestId" = ${classification.providerRequestId},
             "providerResponseId" = ${classification.providerResponseId},
             "httpStatus" = ${classification.httpStatus},
             "inputTokens" = ${usage.inputTokens},
             "outputTokens" = ${usage.outputTokens},
             "safeErrorCode" = ${classification.safeCode}::"AiSafeErrorCode",
             "completedAt" = CURRENT_TIMESTAMP
       WHERE "projectId" = ${claim.request.projectId}::uuid
         AND "id" = ${claim.attemptId}::uuid
         AND "aiRunId" = ${claim.runId}::uuid
         AND "dispatchToken" = ${claim.dispatchToken}
         AND "status" = 'sent'::"AiRunAttemptStatus"
         AND "requestCount" = 1
    `);
    if (Number(attemptUpdated) !== 1) {
      throwAiRuntimeServiceError("AI_INVALID_PROVIDER_RESPONSE");
    }

    const runUpdated = await tx.$executeRaw<number>(Prisma.sql`
      UPDATE "AiRun"
         SET "status" = ${runStatus}::"AiRunStatus",
             "outputBytes" = ${dispatched.outputBytes},
             "inputTokens" = ${usage.inputTokens},
             "outputTokens" = ${usage.outputTokens},
             "requestCount" = 1,
             "budgetUsedMicros" = ${budgetUsedMicros},
             "budgetStatus" = 'allowed'::"AiBudgetStatus",
             "safeErrorCode" = ${classification.safeCode}::"AiSafeErrorCode",
             "httpStatus" = ${classification.httpStatus},
             "providerRequestId" = ${classification.providerRequestId},
             "providerResponseId" = ${classification.providerResponseId},
             "completedAt" = CURRENT_TIMESTAMP
       WHERE "projectId" = ${claim.request.projectId}::uuid
         AND "id" = ${claim.runId}::uuid
         AND "grantId" = ${claim.request.grantId}::uuid
         AND "operationKey" = ${claim.operationKey}
         AND "status" = 'running'::"AiRunStatus"
         AND "requestCount" = 1
    `);
    if (Number(runUpdated) !== 1) {
      throwAiRuntimeServiceError("AI_INVALID_PROVIDER_RESPONSE");
    }

    if (classification.runStatus === "succeeded") {
      if (dispatched.hasCompletionPayload !== (this.completionHandler !== null)) {
        throwAiRuntimeServiceError("AI_INVALID_PROVIDER_RESPONSE");
      }
      if (this.completionHandler !== null) {
        await this.completionHandler.complete(tx, Object.freeze({
          projectId: claim.request.projectId,
          runId: claim.runId,
          operation: claim.request.operation,
          completionPayload: dispatched.completionPayload,
        }));
      }
    }

    await this.writeTerminalAudit(
      tx,
      claim,
      runEventType,
      null,
      usage,
      classification.safeCode,
      classification.httpStatus,
    );
    await this.writeTerminalAudit(
      tx,
      claim,
      attemptEventType,
      claim.attemptId,
      usage,
      classification.safeCode,
      classification.httpStatus,
    );
    return {
      kind: "claimed",
      status: runStatus,
      runId: claim.runId,
      operationKey: claim.operationKey,
      attemptId: claim.attemptId,
      safeCode: classification.safeCode,
    };
  }

  private async writeTerminalAudit(
    tx: Prisma.TransactionClient,
    claim: ClaimedDispatch,
    eventType: DbAiAuditEventType,
    attemptId: string | null,
    usage: SafeUsage,
    safeCode: AiSafeErrorCode | null,
    httpStatus: number | null,
  ): Promise<void> {
    await tx.aiAuditEvent.create({
      data: {
        id: safeGeneratedId(this.idFactory),
        projectId: claim.request.projectId,
        policyRevisionId: claim.context.revision.id,
        eventType,
        safeCode: dbSafeErrorCode(safeCode),
        eventFingerprint: claim.operationKey,
        fingerprintCount: claim.context.manifest.length,
        byteCount: claim.context.inputBytes,
        tokenCount: usage.inputTokens + usage.outputTokens,
        requestCount: 1,
        httpStatus,
        grantId: claim.request.grantId,
        aiRunId: claim.runId,
        attemptId,
      },
    });
  }

  private async lockAndBuildContext(
    tx: Prisma.TransactionClient,
    request: PrepareOrGetRunRequest,
  ): Promise<PreparedContext | PrepareOrGetRunResult> {
    if (!(await lockProject(tx, request.projectId))) {
      return rejected("AI_POLICY_DENIED");
    }
    const pointer = await lockPolicyPointer(tx, request.projectId);
    if (pointer === null) {
      return rejected("AI_POLICY_DENIED");
    }
    const revision = await lockPolicyRevision(
      tx,
      request.projectId,
      pointer.currentRevisionId,
    );
    if (
      revision === null ||
      revision.projectId !== request.projectId ||
      revision.outboundEnabled !== true
    ) {
      return rejected("AI_POLICY_DENIED");
    }

    const operationProfile = await lockOperationProfile(
      tx,
      request.projectId,
      revision.id,
      request.operation,
    );
    if (
      operationProfile === null ||
      operationProfile.projectId !== request.projectId ||
      operationProfile.policyRevisionId !== revision.id ||
      operationProfile.operation !== request.operation
    ) {
      return rejected("AI_POLICY_DENIED");
    }

    const grant = await lockGrant(tx, request.projectId, request.grantId);
    if (
      grant === null ||
      grant.projectId !== request.projectId ||
      grant.status !== "issued" ||
      grant.policyRevisionId !== revision.id ||
      grant.revokedAt !== null ||
      grant.expiresAt === null ||
      grant.expiresAtIsLive !== true ||
      !samePolicySnapshot(revision, operationProfile, grant) ||
      !MODEL_ID_PATTERN.test(grant.modelId) ||
      SECRET_OR_URL_PATTERN.test(grant.modelId) ||
      /(^|[/:@_-])latest($|[/:@_-])/i.test(grant.modelId) ||
      !FINGERPRINT_PATTERN.test(grant.grantFingerprint)
    ) {
      return rejected("AI_GRANT_DENIED");
    }
    if (!(await lockGrantOperation(tx, request.projectId, request.grantId, request.operation))) {
      return rejected("AI_GRANT_DENIED");
    }
    const executionProfile = resolveAiExecutionProfile(request.operation, grant);
    if (executionProfile === null) {
      return rejected("AI_GRANT_DENIED");
    }

    const sourceEntries: Array<{
      sourceId: string;
      contentFingerprint: string;
      contentBytes: number;
      scannerVersion: string;
    }> = [];
    for (const sourceId of request.sourceIds) {
      const grantSource = await lockGrantSource(
        tx,
        request.projectId,
        request.grantId,
        sourceId,
      );
      const projectSource = await lockProjectSource(tx, request.projectId, sourceId);
      if (grantSource === null || projectSource === null) {
        return rejected("AI_GRANT_DENIED");
      }
      const contentHash = hashSourceContent(projectSource.contentText);
      const contentBytes = Buffer.byteLength(projectSource.contentText, "utf8");
      if (
        contentHash !== projectSource.contentHash ||
        contentHash !== grantSource.contentFingerprint ||
        contentBytes !== grantSource.contentBytes
      ) {
        return rejected("AI_GRANT_DENIED");
      }
      sourceEntries.push({
        sourceId,
        contentFingerprint: grantSource.contentFingerprint,
        contentBytes: grantSource.contentBytes,
        scannerVersion: grant.scannerVersion,
      });
    }

    const manifest = buildInputManifest(sourceEntries);
    const inputManifestFingerprint = buildInputManifestFingerprint(manifest);
    const inputBytes = sumInputBytes(manifest);
    const operationKey = operationKeyForContext(
      request,
      revision,
      grant,
      executionProfile,
      manifest,
    );
    return {
      request,
      revision,
      grant,
      executionProfile,
      manifest,
      inputManifestFingerprint,
      inputBytes,
      operationKey,
    };
  }

  private async reconcileOperationKey(
    request: PrepareOrGetRunRequest,
  ): Promise<PrepareOrGetRunResult> {
    try {
      return await this.transaction(
        async (tx) => {
          if (!(await lockProject(tx, request.projectId))) {
            return rejected("AI_INVALID_OPERATION_KEY_INPUT");
          }
          // The failed transaction does not expose its candidate key. Rebuild
          // it from the same sealed policy/grant/source inputs in a read-only
          // reconciliation transaction before accepting the unique conflict.
          const context = await this.lockAndBuildContext(tx, request);
          if ("safeCode" in context) {
            return context;
          }
          const existing = await readRunWithInputs(
            tx,
            request.projectId,
            context.operationKey,
            true,
          );
          if (
            existing === null ||
            existing.run.operation !== request.operation ||
            existing.run.grantId !== request.grantId ||
            !runMatchesSnapshot(existing.run, context, existing.inputs)
          ) {
            return rejected("AI_INVALID_OPERATION_KEY_INPUT");
          }
          return runResult("existing", existing.run, context);
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error: unknown) {
      if (error instanceof AiRuntimeServiceError) {
        return rejected(error.code);
      }
      return rejected("AI_INVALID_PROVIDER_RESPONSE");
    }
  }
}

export function createAiRuntimeService(
  options: CreateAiRuntimeServiceOptions,
): Pick<
  AiRuntimeServiceImpl,
  "prepareOrGetRun" | "claimAndDispatchRun" | "execute"
> {
  return new AiRuntimeServiceImpl(options);
}
