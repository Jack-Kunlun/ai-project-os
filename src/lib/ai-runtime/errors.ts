import type { AiSafeErrorCode } from "./types";

const SAFE_ERROR_MESSAGES: Readonly<Record<AiSafeErrorCode, string>> = {
  AI_DISABLED: "AI_DISABLED",
  AI_PROVIDER_DISABLED: "AI_PROVIDER_DISABLED",
  AI_INVALID_OPERATION_KEY_INPUT: "AI_INVALID_OPERATION_KEY_INPUT",
  AI_INVALID_STATE_TRANSITION: "AI_INVALID_STATE_TRANSITION",
  AI_REDISPATCH_FORBIDDEN: "AI_REDISPATCH_FORBIDDEN",
  AI_PROVIDER_INCOMPLETE: "AI_PROVIDER_INCOMPLETE",
  AI_PROVIDER_UNKNOWN: "AI_PROVIDER_UNKNOWN",
  AI_PROVIDER_FAILED: "AI_PROVIDER_FAILED",
  AI_PROVIDER_CANCELLED: "AI_PROVIDER_CANCELLED",
  AI_DISPATCH_NOT_SENT: "AI_DISPATCH_NOT_SENT",
  AI_POLICY_DENIED: "AI_POLICY_DENIED",
  AI_GRANT_DENIED: "AI_GRANT_DENIED",
  AI_SCANNER_DENIED: "AI_SCANNER_DENIED",
  AI_BUDGET_DENIED: "AI_BUDGET_DENIED",
  AI_INVALID_PROVIDER_RESPONSE: "AI_INVALID_PROVIDER_RESPONSE",
  SOURCE_IN_USE: "SOURCE_IN_USE",
};

const FALLBACK_ERROR_CODE = "AI_INVALID_PROVIDER_RESPONSE" as const;

function isSafeErrorCode(value: unknown): value is AiSafeErrorCode {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(SAFE_ERROR_MESSAGES, value)
  );
}

export class AiRuntimeServiceError extends Error {
  readonly code: AiSafeErrorCode;

  constructor(code: AiSafeErrorCode) {
    const safeCode = isSafeErrorCode(code) ? code : FALLBACK_ERROR_CODE;
    super(SAFE_ERROR_MESSAGES[safeCode]);
    this.name = "AiRuntimeServiceError";
    this.code = safeCode;
  }
}

export function isAiRuntimeServiceError(value: unknown): value is AiRuntimeServiceError {
  return value instanceof AiRuntimeServiceError;
}

export function throwAiRuntimeServiceError(code: AiSafeErrorCode): never {
  throw new AiRuntimeServiceError(code);
}
