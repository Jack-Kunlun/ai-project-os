/**
 * Pure, server-side AI runtime contract types.
 *
 * These types intentionally describe fingerprints, IDs, counts and safe codes
 * only. They do not model prompts, source bodies, provider bodies or secrets.
 */

export const AI_OPERATIONS = [
  "embedding",
  "autoExtract",
  "sourceSummary",
  "projectAnalysis",
  "generateWithContext",
] as const;

export type AiOperation = (typeof AI_OPERATIONS)[number];

export const AI_RUN_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "unknown",
  "cancelled",
] as const;

export type AiRunStatus = (typeof AI_RUN_STATUSES)[number];

export const AI_RUN_ATTEMPT_STATUSES = [
  "sent",
  "succeeded",
  "failed",
  "unknown",
  "cancelled",
] as const;

export type AiRunAttemptStatus = (typeof AI_RUN_ATTEMPT_STATUSES)[number];

export const OPERATION_KEY_SCHEMA_VERSION = "ai-operation-key:v1" as const;
export const NO_RAG_SNAPSHOT_MARKER = "no-rag-snapshot:v1" as const;

export type Fingerprint = string;

export interface OperationKeySource {
  sourceId: string;
  contentFingerprint: Fingerprint;
  contentBytes: number;
  evidenceManifestFingerprint: Fingerprint;
}

export interface OperationKeyInput {
  schemaVersion: typeof OPERATION_KEY_SCHEMA_VERSION;
  projectId: string;
  operation: AiOperation;
  sourceManifest: readonly OperationKeySource[];
  promptFingerprint: Fingerprint;
  promptVersion: string;
  profileFingerprint: Fingerprint;
  providerFingerprint: Fingerprint;
  modelId: string;
  modelFingerprint: Fingerprint;
  grantFingerprint: Fingerprint;
  effectivePolicyVersion: number;
  processorFingerprint: Fingerprint;
  processorEndpointFingerprint: Fingerprint;
  processorRegionFingerprint: Fingerprint;
  processorRetentionFingerprint: Fingerprint;
  noRagSnapshotMarker: typeof NO_RAG_SNAPSHOT_MARKER;
}

export type AiSafeErrorCode =
  | "AI_DISABLED"
  | "AI_PROVIDER_DISABLED"
  | "AI_INVALID_OPERATION_KEY_INPUT"
  | "AI_INVALID_STATE_TRANSITION"
  | "AI_REDISPATCH_FORBIDDEN"
  | "AI_PROVIDER_INCOMPLETE"
  | "AI_PROVIDER_UNKNOWN"
  | "AI_PROVIDER_FAILED"
  | "AI_PROVIDER_CANCELLED"
  | "AI_DISPATCH_NOT_SENT"
  | "AI_POLICY_DENIED"
  | "AI_GRANT_DENIED"
  | "AI_SCANNER_DENIED"
  | "AI_BUDGET_DENIED"
  | "AI_INVALID_PROVIDER_RESPONSE"
  | "SOURCE_IN_USE";

export interface SafeUsage {
  inputTokens: number;
  outputTokens: number;
  requestCount: number;
}

export type ProviderResultInput =
  | {
      kind: "completed";
      providerRequestId?: string;
      providerResponseId?: string;
      usage?: SafeUsage;
    }
  | {
      kind: "failed";
      httpStatus?: number;
      providerRequestId?: string;
      providerResponseId?: string;
      safeCode?: string;
      usage?: SafeUsage;
    }
  | {
      kind: "cancelled";
      providerRequestId?: string;
      providerResponseId?: string;
      safeCode?: string;
    }
  | {
      kind: "incomplete";
      providerRequestId?: string;
      providerResponseId?: string;
      safeCode?: string;
      usage?: SafeUsage;
    }
  | {
      kind: "queued" | "in_progress";
      providerRequestId?: string;
      providerResponseId?: string;
    }
  | {
      kind: "timeout" | "abort" | "connection" | "invalid_response";
      sentAt: boolean;
      providerRequestId?: string;
    }
  | {
      kind: "http_error";
      httpStatus: number;
      providerRequestId?: string;
      providerResponseId?: string;
      usage?: SafeUsage;
    };

export interface ProviderClassification {
  runStatus: Extract<AiRunStatus, "succeeded" | "failed" | "unknown" | "cancelled">;
  attemptStatus: Extract<AiRunAttemptStatus, "succeeded" | "failed" | "unknown" | "cancelled">;
  safeCode: AiSafeErrorCode | null;
  httpStatus: number | null;
  automaticRetry: false;
  providerRequestId: string | null;
  providerResponseId: string | null;
  usage: SafeUsage | null;
}

export interface AiRuntimeConfigDisabled {
  enabled: false;
  status: "disabled";
  errorCode: "AI_DISABLED";
}

export interface AiRuntimeConfigProviderDisabled {
  enabled: true;
  status: "provider_disabled";
  errorCode: "AI_PROVIDER_DISABLED";
}

export interface AiRuntimeConfigReady {
  enabled: true;
  status: "ready";
  provider: "openai";
  responseModelId: string;
  embeddingModelId: string;
}

export type AiRuntimeConfig =
  | AiRuntimeConfigDisabled
  | AiRuntimeConfigProviderDisabled
  | AiRuntimeConfigReady;

export type AiRuntimeAvailability =
  | {
      enabled: false;
      available: false;
      errorCode: "AI_DISABLED";
    }
  | {
      enabled: true;
      available: false;
      errorCode: "AI_PROVIDER_DISABLED";
    }
  | {
      enabled: true;
      available: true;
      errorCode: null;
      provider: "openai";
      responseModelId: string;
      embeddingModelId: string;
    };
