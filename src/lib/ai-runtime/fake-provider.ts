import {
  buildInputManifestFingerprint,
  normalizeInputManifest,
  sumInputBytes,
  type InputManifest,
} from "./manifest";
import { AiRuntimeServiceError, throwAiRuntimeServiceError } from "./errors";
import { FAKE_PROFILE } from "./fake-profile";
import {
  AI_OPERATIONS,
  type AiOperation,
  type AiSafeErrorCode,
  type ProviderClassification,
  type ProviderResultInput,
  type SafeUsage,
} from "./types";
import { classifyProviderResult } from "./provider-result";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const DISPATCH_TOKEN_PATTERN = /^[A-Za-z0-9._:-]{16,128}$/;
const SECRET_OR_URL_PATTERN = /(https?:\/\/|api[-_]?key|bearer|password|secret|token|sk-)/i;
const SAFE_ERROR_CODES: readonly AiSafeErrorCode[] = [
  "AI_DISABLED",
  "AI_PROVIDER_DISABLED",
  "AI_INVALID_OPERATION_KEY_INPUT",
  "AI_INVALID_STATE_TRANSITION",
  "AI_REDISPATCH_FORBIDDEN",
  "AI_PROVIDER_INCOMPLETE",
  "AI_PROVIDER_UNKNOWN",
  "AI_PROVIDER_FAILED",
  "AI_PROVIDER_CANCELLED",
  "AI_DISPATCH_NOT_SENT",
  "AI_POLICY_DENIED",
  "AI_GRANT_DENIED",
  "AI_SCANNER_DENIED",
  "AI_BUDGET_DENIED",
  "AI_INVALID_PROVIDER_RESPONSE",
  "SOURCE_IN_USE",
];

const ADMISSIBILITY_FIELDS = [
  "projectId",
  "runId",
  "operationKey",
  "inputManifest",
  "inputManifestFingerprint",
] as const;
const DISPATCH_FIELDS = [
  "projectId",
  "runId",
  "attemptId",
  "dispatchToken",
  "operation",
  "operationKey",
] as const;
const ADMISSIBILITY_RESULT_FIELDS = [
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
const SCANNER_VERSION_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;

export type FakeScanResult = "passed" | "blocked" | "unavailable";

export interface FakeAdmissibilityInput {
  projectId: string;
  runId: string;
  operationKey: string;
  inputManifest: InputManifest;
  inputManifestFingerprint: string;
}

export interface FakeAdmissibilityResult {
  admissible: boolean;
  projectId: string;
  runId: string;
  operationKey: string;
  inputManifestFingerprint: string;
  inputBytes: number;
  sourceCount: number;
  scannerVersion: string;
  safeScanResult: FakeScanResult;
  safeCode: "AI_SCANNER_DENIED" | "AI_BUDGET_DENIED" | null;
}

export type FakeAdmissibilityRecord = Readonly<FakeAdmissibilityResult>;

export class FakeAdmissibilityRecorder {
  private readonly entries: FakeAdmissibilityRecord[] = [];

  record(value: unknown): void {
    this.entries.push(normalizeAdmissibilityResult(value));
  }

  get records(): readonly FakeAdmissibilityRecord[] {
    return Object.freeze([...this.entries]);
  }

  get count(): number {
    return this.entries.length;
  }
}

export interface FakeAdmissibilityOptions {
  scanResult?: FakeScanResult;
  recorder?: FakeAdmissibilityRecorder;
}

export type FakeDispatchRequest = Readonly<{
  projectId: string;
  runId: string;
  attemptId: string;
  dispatchToken: string;
  operation: AiOperation;
  operationKey: string;
}>;

export type FakeProviderThrow = Readonly<{
  mode: "throw";
  code: AiSafeErrorCode;
}>;

export type FakeProviderBehavior = ProviderResultInput | FakeProviderThrow;

export type FakeDispatchRecord = Readonly<{
  projectId: string;
  runId: string;
  attemptId: string;
  dispatchToken: string;
  operation: AiOperation;
  operationKey: string;
  runStatus: ProviderClassification["runStatus"];
  attemptStatus: ProviderClassification["attemptStatus"];
  safeCode: AiSafeErrorCode | null;
  httpStatus: number | null;
  automaticRetry: false;
  providerRequestId: string | null;
  providerResponseId: string | null;
  usage: SafeUsage | null;
}>;

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
    const canonicalExpected = [...expected].sort();
    return (
      actual.length === canonicalExpected.length &&
      actual.every((key, index) => key === canonicalExpected[index])
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

function safeDispatchToken(value: unknown): string {
  const result = safeText(value, 128);
  if (!DISPATCH_TOKEN_PATTERN.test(result)) {
    invalidInput();
  }
  return result;
}

function safeScannerVersion(value: unknown): string {
  const result = safeText(value, 64);
  if (!SCANNER_VERSION_PATTERN.test(result)) {
    invalidInput();
  }
  return result;
}

function safeNonNegativeInteger(value: unknown): number {
  if (!Number.isFinite(value) || !Number.isSafeInteger(value) || (value as number) < 0) {
    invalidInput();
  }
  return value as number;
}

function safeAdmissibilityCode(
  value: unknown,
): FakeAdmissibilityResult["safeCode"] {
  if (value === null) {
    return null;
  }
  if (value === "AI_SCANNER_DENIED" || value === "AI_BUDGET_DENIED") {
    return value;
  }
  invalidInput();
}

function safeScanResult(value: unknown): FakeScanResult {
  if (value === "passed" || value === "blocked" || value === "unavailable") {
    return value;
  }
  invalidInput();
}

function normalizeAdmissibilityResult(value: unknown): FakeAdmissibilityRecord {
  if (!isPlainRecord(value) || !exactKeys(value, ADMISSIBILITY_RESULT_FIELDS)) {
    invalidInput();
  }
  const admissible = value.admissible;
  const safeCode = safeAdmissibilityCode(value.safeCode);
  if (typeof admissible !== "boolean" || admissible !== (safeCode === null)) {
    invalidInput();
  }
  const result = Object.freeze({
    admissible,
    projectId: safeUuid(value.projectId),
    runId: safeUuid(value.runId),
    operationKey: safeFingerprint(value.operationKey),
    inputManifestFingerprint: safeFingerprint(value.inputManifestFingerprint),
    inputBytes: safeNonNegativeInteger(value.inputBytes),
    sourceCount: safeNonNegativeInteger(value.sourceCount),
    scannerVersion: safeScannerVersion(value.scannerVersion),
    safeScanResult: safeScanResult(value.safeScanResult),
    safeCode,
  });
  if (result.sourceCount < 1) {
    invalidInput();
  }
  return result;
}

function normalizeAdmissibilityInput(value: unknown): FakeAdmissibilityInput {
  if (!isPlainRecord(value) || !exactKeys(value, ADMISSIBILITY_FIELDS)) {
    invalidInput();
  }
  const projectId = safeUuid(value.projectId);
  const runId = safeUuid(value.runId);
  const operationKey = safeFingerprint(value.operationKey);
  const inputManifest = normalizeInputManifest(value.inputManifest);
  const inputManifestFingerprint = safeFingerprint(value.inputManifestFingerprint);
  if (buildInputManifestFingerprint(inputManifest) !== inputManifestFingerprint) {
    invalidInput();
  }
  return Object.freeze({
    projectId,
    runId,
    operationKey,
    inputManifest,
    inputManifestFingerprint,
  });
}

function normalizeDispatchRequest(value: unknown): FakeDispatchRequest {
  if (!isPlainRecord(value) || !exactKeys(value, DISPATCH_FIELDS)) {
    invalidInput();
  }
  return Object.freeze({
    projectId: safeUuid(value.projectId),
    runId: safeUuid(value.runId),
    attemptId: safeUuid(value.attemptId),
    dispatchToken: safeDispatchToken(value.dispatchToken),
    operation: safeOperation(value.operation),
    operationKey: safeFingerprint(value.operationKey),
  });
}

function safeCode(value: unknown): AiSafeErrorCode {
  if (typeof value !== "string" || !(SAFE_ERROR_CODES as readonly string[]).includes(value)) {
    throwAiRuntimeServiceError("AI_INVALID_PROVIDER_RESPONSE");
  }
  return value as AiSafeErrorCode;
}

function isFakeProviderThrow(value: unknown): value is FakeProviderThrow {
  return (
    isPlainRecord(value) &&
    exactKeys(value, ["mode", "code"]) &&
    value.mode === "throw"
  );
}

function validProviderKind(value: unknown): value is ProviderResultInput["kind"] {
  return (
    typeof value === "string" &&
    [
      "completed",
      "failed",
      "cancelled",
      "incomplete",
      "queued",
      "in_progress",
      "timeout",
      "abort",
      "connection",
      "invalid_response",
      "http_error",
    ].includes(value)
  );
}

function normalizeBehavior(value: FakeProviderBehavior):
  | { kind: "result"; classification: ProviderClassification }
  | { kind: "throw"; code: AiSafeErrorCode } {
  if (isFakeProviderThrow(value)) {
    return { kind: "throw", code: safeCode(value.code) };
  }
  if (!isPlainRecord(value) || !validProviderKind(value.kind)) {
    throwAiRuntimeServiceError("AI_INVALID_PROVIDER_RESPONSE");
  }
  return {
    kind: "result",
    classification: classifyProviderResult(value as ProviderResultInput),
  };
}

function copyClassification(classification: ProviderClassification): ProviderClassification {
  return {
    ...classification,
    usage: classification.usage === null ? null : Object.freeze({ ...classification.usage }),
  };
}

export class FakeAdmissibilityGate {
  private readonly scanResult: FakeScanResult;
  private readonly recorder: FakeAdmissibilityRecorder | null;

  constructor(options: FakeAdmissibilityOptions = {}) {
    const rawOptions: unknown = options;
    if (!isPlainRecord(rawOptions)) {
      throwAiRuntimeServiceError("AI_INVALID_OPERATION_KEY_INPUT");
    }
    const optionKeys = Object.keys(rawOptions).sort();
    const requestedScanResult = rawOptions.scanResult;
    const requestedRecorder = rawOptions.recorder;
    if (
      optionKeys.some((key) => key !== "recorder" && key !== "scanResult") ||
      (requestedScanResult !== undefined &&
        !["passed", "blocked", "unavailable"].includes(String(requestedScanResult))) ||
      (requestedRecorder !== undefined &&
        !(requestedRecorder instanceof FakeAdmissibilityRecorder))
    ) {
      throwAiRuntimeServiceError("AI_INVALID_OPERATION_KEY_INPUT");
    }
    this.scanResult =
      requestedScanResult === undefined ? "passed" : (requestedScanResult as FakeScanResult);
    this.recorder =
      requestedRecorder === undefined
        ? null
        : (requestedRecorder as FakeAdmissibilityRecorder);
  }

  assess(value: unknown): FakeAdmissibilityResult {
    const input = normalizeAdmissibilityInput(value);
    const inputBytes = sumInputBytes(input.inputManifest);
    const scannerVersions = new Set(input.inputManifest.map((entry) => entry.scannerVersion));
    const scannerVersion = scannerVersions.size === 1 ? [...scannerVersions][0] : "mixed";
    const safeScanResult =
      scannerVersion === FAKE_PROFILE.scannerVersion ? this.scanResult : "blocked";
    const overInputCap = inputBytes > FAKE_PROFILE.maxInputBytes;
    const safeCode = overInputCap
      ? "AI_BUDGET_DENIED"
      : safeScanResult === "passed"
        ? null
        : "AI_SCANNER_DENIED";
    const result = Object.freeze({
      admissible: safeCode === null,
      projectId: input.projectId,
      runId: input.runId,
      operationKey: input.operationKey,
      inputManifestFingerprint: input.inputManifestFingerprint,
      inputBytes,
      sourceCount: input.inputManifest.length,
      scannerVersion,
      safeScanResult,
      safeCode,
    });
    this.recorder?.record(result);
    return result;
  }
}

export function assessFakeInput(
  value: unknown,
  options: FakeAdmissibilityOptions = {},
): FakeAdmissibilityResult {
  return new FakeAdmissibilityGate(options).assess(value);
}

export class FakeProviderRecorder {
  private readonly behavior:
    | { kind: "result"; classification: ProviderClassification }
    | { kind: "throw"; code: AiSafeErrorCode };
  private readonly entries: FakeDispatchRecord[] = [];

  constructor(behavior: FakeProviderBehavior = { kind: "completed" }) {
    this.behavior = normalizeBehavior(behavior);
  }

  dispatch(value: unknown): ProviderClassification {
    const request = normalizeDispatchRequest(value);
    if (this.entries.some((entry) => entry.dispatchToken === request.dispatchToken)) {
      throw new AiRuntimeServiceError("AI_REDISPATCH_FORBIDDEN");
    }

    const classification =
      this.behavior.kind === "throw"
        ? {
            runStatus: "failed" as const,
            attemptStatus: "failed" as const,
            safeCode: this.behavior.code,
            httpStatus: null,
            automaticRetry: false as const,
            providerRequestId: null,
            providerResponseId: null,
            usage: null,
          }
        : copyClassification(this.behavior.classification);
    this.entries.push(
      Object.freeze({
        ...request,
        ...classification,
        usage: classification.usage === null ? null : Object.freeze({ ...classification.usage }),
      }),
    );
    if (this.behavior.kind === "throw") {
      throw new AiRuntimeServiceError(this.behavior.code);
    }
    return classification;
  }

  get records(): readonly FakeDispatchRecord[] {
    return Object.freeze([...this.entries]);
  }

  get count(): number {
    return this.entries.length;
  }
}
