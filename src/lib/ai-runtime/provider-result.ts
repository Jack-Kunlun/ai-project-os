import {
  type AiRunAttemptStatus,
  type AiRunStatus,
  type AiSafeErrorCode,
  type ProviderClassification,
  type ProviderResultInput,
  type SafeUsage,
} from "./types";

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

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,512}$/;
const SECRET_LIKE_PATTERN = /(https?:\/\/|api[-_]?key|bearer|password|secret|token|sk-[a-z0-9])/i;

type Sanitized<T> = { valid: true; value: T } | { valid: false; value: null };

function safeProviderId(value: unknown): Sanitized<string | null> {
  if (value === undefined) {
    return { valid: true, value: null };
  }
  if (
    typeof value !== "string" ||
    !OPAQUE_ID_PATTERN.test(value) ||
    SECRET_LIKE_PATTERN.test(value)
  ) {
    return { valid: false, value: null };
  }
  return { valid: true, value };
}

function safeHttpStatus(value: unknown): Sanitized<number | null> {
  if (value === undefined) {
    return { valid: true, value: null };
  }
  return Number.isInteger(value) && (value as number) >= 100 && (value as number) <= 599
    ? { valid: true, value: value as number }
    : { valid: false, value: null };
}

function safeUsage(value: unknown): Sanitized<SafeUsage | null> {
  if (value === undefined) {
    return { valid: true, value: null };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { valid: false, value: null };
  }
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  if (keys.join(",") !== "inputTokens,outputTokens,requestCount") {
    return { valid: false, value: null };
  }
  if (
    !Number.isFinite(candidate.inputTokens) ||
    !Number.isFinite(candidate.outputTokens) ||
    !Number.isFinite(candidate.requestCount) ||
    !Number.isSafeInteger(candidate.inputTokens) ||
    !Number.isSafeInteger(candidate.outputTokens) ||
    !Number.isSafeInteger(candidate.requestCount) ||
    (candidate.inputTokens as number) < 0 ||
    (candidate.outputTokens as number) < 0 ||
    candidate.requestCount !== 1
  ) {
    return { valid: false, value: null };
  }
  return {
    valid: true,
    value: {
      inputTokens: candidate.inputTokens as number,
      outputTokens: candidate.outputTokens as number,
      requestCount: candidate.requestCount as number,
    },
  };
}

function safeErrorCode(value: unknown, fallback: AiSafeErrorCode): AiSafeErrorCode {
  return typeof value === "string" && (SAFE_ERROR_CODES as readonly string[]).includes(value)
    ? (value as AiSafeErrorCode)
    : fallback;
}

function classification(
  runStatus: Extract<AiRunStatus, "succeeded" | "failed" | "unknown" | "cancelled">,
  attemptStatus: Extract<AiRunAttemptStatus, "succeeded" | "failed" | "unknown" | "cancelled">,
  safeCode: AiSafeErrorCode | null,
  fields: {
    providerRequestId?: unknown;
    providerResponseId?: unknown;
    httpStatus?: unknown;
    usage?: unknown;
  },
): ProviderClassification {
  const providerRequestId = safeProviderId(fields.providerRequestId);
  const providerResponseId = safeProviderId(fields.providerResponseId);
  const httpStatus = safeHttpStatus(fields.httpStatus);
  const usage = safeUsage(fields.usage);
  return {
    runStatus,
    attemptStatus,
    safeCode,
    httpStatus: httpStatus.valid ? httpStatus.value : null,
    automaticRetry: false,
    providerRequestId: providerRequestId.valid ? providerRequestId.value : null,
    providerResponseId: providerResponseId.valid ? providerResponseId.value : null,
    usage: usage.valid ? usage.value : null,
  };
}

function hasInvalidSafeFields(fields: {
  providerRequestId?: unknown;
  providerResponseId?: unknown;
  httpStatus?: unknown;
  usage?: unknown;
}): boolean {
  return (
    !safeProviderId(fields.providerRequestId).valid ||
    !safeProviderId(fields.providerResponseId).valid ||
    !safeHttpStatus(fields.httpStatus).valid ||
    !safeUsage(fields.usage).valid
  );
}

/**
 * Classifies an already-returned safe provider outcome. This function has no
 * network or retry behavior and intentionally ignores any untyped provider
 * body that a caller may have received outside the contract.
 */
export function classifyProviderResult(result: ProviderResultInput): ProviderClassification {
  switch (result.kind) {
    case "completed":
      return hasInvalidSafeFields(result)
        ? classification("unknown", "unknown", "AI_PROVIDER_UNKNOWN", result)
        : classification("succeeded", "succeeded", null, result);
    case "failed":
      return hasInvalidSafeFields(result)
        ? classification("unknown", "unknown", "AI_PROVIDER_UNKNOWN", result)
        : classification(
            "failed",
            "failed",
            safeErrorCode(result.safeCode, "AI_PROVIDER_FAILED"),
            result,
          );
    case "cancelled":
      return hasInvalidSafeFields(result)
        ? classification("unknown", "unknown", "AI_PROVIDER_UNKNOWN", result)
        : classification(
            "cancelled",
            "cancelled",
            safeErrorCode(result.safeCode, "AI_PROVIDER_CANCELLED"),
            result,
          );
    case "incomplete":
      return hasInvalidSafeFields(result)
        ? classification("unknown", "unknown", "AI_PROVIDER_UNKNOWN", result)
        : classification(
            "failed",
            "failed",
            safeErrorCode(result.safeCode, "AI_PROVIDER_INCOMPLETE"),
            result,
          );
    case "queued":
    case "in_progress":
      return classification("unknown", "unknown", "AI_PROVIDER_UNKNOWN", result);
    case "timeout":
    case "abort":
    case "connection":
    case "invalid_response":
      return result.sentAt
        ? classification("unknown", "unknown", "AI_PROVIDER_UNKNOWN", result)
        : classification("failed", "failed", "AI_DISPATCH_NOT_SENT", result);
    case "http_error": {
      const httpStatus = safeHttpStatus(result.httpStatus);
      if (!httpStatus.valid) {
        return classification("unknown", "unknown", "AI_PROVIDER_UNKNOWN", result);
      }
      return httpStatus.value !== null && httpStatus.value >= 300 && httpStatus.value <= 599
        ? hasInvalidSafeFields(result)
          ? classification("unknown", "unknown", "AI_PROVIDER_UNKNOWN", result)
          : classification("failed", "failed", "AI_PROVIDER_FAILED", result)
        : classification("unknown", "unknown", "AI_PROVIDER_UNKNOWN", result);
    }
  }
}
