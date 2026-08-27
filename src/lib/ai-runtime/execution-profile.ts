import {
  OPENAI_PROJECT_ANALYSIS_PROMPT_FINGERPRINT,
  OPENAI_PROJECT_ANALYSIS_PROMPT_VERSION,
  OPENAI_SOURCE_SUMMARY_PROMPT_FINGERPRINT,
  OPENAI_SOURCE_SUMMARY_PROMPT_VERSION,
} from "./openai-grounded-analysis-contract";
import {
  OPENAI_GROUNDED_RAG_PROMPT_FINGERPRINT,
  OPENAI_GROUNDED_RAG_PROMPT_VERSION,
} from "./openai-grounded-rag-contract";
import {
  FAKE_PROFILE,
  assertFakeInputWithinProfile,
  calculateFakeBudgetMicros,
} from "./fake-profile";
import {
  OPENAI_RESPONSES_AUTO_EXTRACT_PROMPT_FINGERPRINT,
  OPENAI_RESPONSES_AUTO_EXTRACT_PROMPT_VERSION,
  OPENAI_RESPONSES_ENDPOINT_FINGERPRINT,
  OPENAI_RESPONSES_PROVIDER_FINGERPRINT,
  OPENAI_RESPONSES_RETENTION_FINGERPRINT,
} from "./openai-responses-contract";
import {
  OPENAI_AUTO_EXTRACT_MODEL_FINGERPRINT,
  OPENAI_AUTO_EXTRACT_MODEL_ID,
  OPENAI_AUTO_EXTRACT_PROFILE_FINGERPRINT,
  OPENAI_GENERATE_WITH_CONTEXT_MODEL_FINGERPRINT,
  OPENAI_GENERATE_WITH_CONTEXT_MODEL_ID,
  OPENAI_GENERATE_WITH_CONTEXT_PROFILE_FINGERPRINT,
  OPENAI_PROJECT_ANALYSIS_MODEL_FINGERPRINT,
  OPENAI_PROJECT_ANALYSIS_MODEL_ID,
  OPENAI_PROJECT_ANALYSIS_PROFILE_FINGERPRINT,
  OPENAI_PROCESSOR_REGION_FINGERPRINT,
  OPENAI_SOURCE_SUMMARY_MODEL_FINGERPRINT,
  OPENAI_SOURCE_SUMMARY_MODEL_ID,
  OPENAI_SOURCE_SUMMARY_PROFILE_FINGERPRINT,
} from "./openai-runtime-profile";
import { throwAiRuntimeServiceError } from "./errors";
import type { AiOperation } from "./types";

export const OPENAI_AUTO_EXTRACT_PRICING_SNAPSHOT_ID =
  "openai-gpt-5.4-mini-standard-2026-08-28" as const;
export const OPENAI_AUTO_EXTRACT_MAX_INPUT_TOKENS = 64_000 as const;
export const OPENAI_AUTO_EXTRACT_MAX_BUDGET_MICROS = 60_000 as const;
export const OPENAI_GENERATE_WITH_CONTEXT_PRICING_SNAPSHOT_ID =
  OPENAI_AUTO_EXTRACT_PRICING_SNAPSHOT_ID;
export const OPENAI_GENERATE_WITH_CONTEXT_MAX_INPUT_TOKENS = 64_000 as const;
export const OPENAI_GENERATE_WITH_CONTEXT_MAX_BUDGET_MICROS = 60_000 as const;
export const OPENAI_SOURCE_SUMMARY_PRICING_SNAPSHOT_ID =
  OPENAI_AUTO_EXTRACT_PRICING_SNAPSHOT_ID;
export const OPENAI_SOURCE_SUMMARY_MAX_INPUT_TOKENS = 64_000 as const;
export const OPENAI_SOURCE_SUMMARY_MAX_BUDGET_MICROS = 60_000 as const;
export const OPENAI_PROJECT_ANALYSIS_PRICING_SNAPSHOT_ID =
  OPENAI_AUTO_EXTRACT_PRICING_SNAPSHOT_ID;
export const OPENAI_PROJECT_ANALYSIS_MAX_INPUT_TOKENS = 64_000 as const;
export const OPENAI_PROJECT_ANALYSIS_MAX_BUDGET_MICROS = 90_000 as const;

export type AiExecutionProfile = Readonly<{
  kind:
    | "synthetic"
    | "openaiAutoExtract"
    | "openaiGenerateWithContext"
    | "openaiSourceSummary"
    | "openaiProjectAnalysis";
  promptFingerprint: string;
  promptVersion: string;
  pricingSnapshotId: string;
  maxInputBytes: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxRequests: 1;
  maxBudgetMicros: number;
}>;

export type AiExecutionBoundary = Readonly<{
  profileFingerprint: string;
  providerFingerprint: string;
  modelFingerprint: string;
  modelId: string;
  regionFingerprint: string;
  retentionFingerprint: string;
  endpointFingerprint: string;
}>;

const SYNTHETIC_EXECUTION_PROFILE: AiExecutionProfile = Object.freeze({
  kind: "synthetic",
  promptFingerprint: FAKE_PROFILE.promptFingerprint,
  promptVersion: FAKE_PROFILE.promptVersion,
  pricingSnapshotId: FAKE_PROFILE.pricingSnapshotId,
  maxInputBytes: FAKE_PROFILE.maxInputBytes,
  maxInputTokens: FAKE_PROFILE.maxInputTokens,
  maxOutputTokens: FAKE_PROFILE.maxOutputTokens,
  maxRequests: FAKE_PROFILE.maxRequests,
  maxBudgetMicros: FAKE_PROFILE.maxBudgetMicros,
});

export function getSyntheticAiExecutionProfile(): AiExecutionProfile {
  return SYNTHETIC_EXECUTION_PROFILE;
}

const OPENAI_AUTO_EXTRACT_EXECUTION_PROFILE: AiExecutionProfile = Object.freeze({
  kind: "openaiAutoExtract",
  promptFingerprint: OPENAI_RESPONSES_AUTO_EXTRACT_PROMPT_FINGERPRINT,
  promptVersion: OPENAI_RESPONSES_AUTO_EXTRACT_PROMPT_VERSION,
  pricingSnapshotId: OPENAI_AUTO_EXTRACT_PRICING_SNAPSHOT_ID,
  maxInputBytes: 64_000,
  maxInputTokens: OPENAI_AUTO_EXTRACT_MAX_INPUT_TOKENS,
  maxOutputTokens: 2_048,
  maxRequests: 1,
  maxBudgetMicros: OPENAI_AUTO_EXTRACT_MAX_BUDGET_MICROS,
});

const OPENAI_GENERATE_WITH_CONTEXT_EXECUTION_PROFILE: AiExecutionProfile =
  Object.freeze({
    kind: "openaiGenerateWithContext",
    promptFingerprint: OPENAI_GROUNDED_RAG_PROMPT_FINGERPRINT,
    promptVersion: OPENAI_GROUNDED_RAG_PROMPT_VERSION,
    pricingSnapshotId: OPENAI_GENERATE_WITH_CONTEXT_PRICING_SNAPSHOT_ID,
    maxInputBytes: 128_000,
    maxInputTokens: OPENAI_GENERATE_WITH_CONTEXT_MAX_INPUT_TOKENS,
    maxOutputTokens: 2_048,
    maxRequests: 1,
    maxBudgetMicros: OPENAI_GENERATE_WITH_CONTEXT_MAX_BUDGET_MICROS,
  });

const OPENAI_SOURCE_SUMMARY_EXECUTION_PROFILE: AiExecutionProfile = Object.freeze({
  kind: "openaiSourceSummary",
  promptFingerprint: OPENAI_SOURCE_SUMMARY_PROMPT_FINGERPRINT,
  promptVersion: OPENAI_SOURCE_SUMMARY_PROMPT_VERSION,
  pricingSnapshotId: OPENAI_SOURCE_SUMMARY_PRICING_SNAPSHOT_ID,
  maxInputBytes: 128_000,
  maxInputTokens: OPENAI_SOURCE_SUMMARY_MAX_INPUT_TOKENS,
  maxOutputTokens: 2_048,
  maxRequests: 1,
  maxBudgetMicros: OPENAI_SOURCE_SUMMARY_MAX_BUDGET_MICROS,
});

const OPENAI_PROJECT_ANALYSIS_EXECUTION_PROFILE: AiExecutionProfile = Object.freeze({
  kind: "openaiProjectAnalysis",
  promptFingerprint: OPENAI_PROJECT_ANALYSIS_PROMPT_FINGERPRINT,
  promptVersion: OPENAI_PROJECT_ANALYSIS_PROMPT_VERSION,
  pricingSnapshotId: OPENAI_PROJECT_ANALYSIS_PRICING_SNAPSHOT_ID,
  maxInputBytes: 128_000,
  maxInputTokens: OPENAI_PROJECT_ANALYSIS_MAX_INPUT_TOKENS,
  maxOutputTokens: 4_096,
  maxRequests: 1,
  maxBudgetMicros: OPENAI_PROJECT_ANALYSIS_MAX_BUDGET_MICROS,
});

function isOpenAiAutoExtractBoundary(boundary: AiExecutionBoundary): boolean {
  return (
    boundary.profileFingerprint === OPENAI_AUTO_EXTRACT_PROFILE_FINGERPRINT &&
    boundary.providerFingerprint === OPENAI_RESPONSES_PROVIDER_FINGERPRINT &&
    boundary.modelFingerprint === OPENAI_AUTO_EXTRACT_MODEL_FINGERPRINT &&
    boundary.modelId === OPENAI_AUTO_EXTRACT_MODEL_ID &&
    boundary.regionFingerprint === OPENAI_PROCESSOR_REGION_FINGERPRINT &&
    boundary.retentionFingerprint === OPENAI_RESPONSES_RETENTION_FINGERPRINT &&
    boundary.endpointFingerprint === OPENAI_RESPONSES_ENDPOINT_FINGERPRINT
  );
}

function isOpenAiGenerateWithContextBoundary(
  boundary: AiExecutionBoundary,
): boolean {
  return (
    boundary.profileFingerprint ===
      OPENAI_GENERATE_WITH_CONTEXT_PROFILE_FINGERPRINT &&
    boundary.providerFingerprint === OPENAI_RESPONSES_PROVIDER_FINGERPRINT &&
    boundary.modelFingerprint ===
      OPENAI_GENERATE_WITH_CONTEXT_MODEL_FINGERPRINT &&
    boundary.modelId === OPENAI_GENERATE_WITH_CONTEXT_MODEL_ID &&
    boundary.regionFingerprint === OPENAI_PROCESSOR_REGION_FINGERPRINT &&
    boundary.retentionFingerprint === OPENAI_RESPONSES_RETENTION_FINGERPRINT &&
    boundary.endpointFingerprint === OPENAI_RESPONSES_ENDPOINT_FINGERPRINT
  );
}

function isOpenAiSourceSummaryBoundary(boundary: AiExecutionBoundary): boolean {
  return (
    boundary.profileFingerprint === OPENAI_SOURCE_SUMMARY_PROFILE_FINGERPRINT &&
    boundary.providerFingerprint === OPENAI_RESPONSES_PROVIDER_FINGERPRINT &&
    boundary.modelFingerprint === OPENAI_SOURCE_SUMMARY_MODEL_FINGERPRINT &&
    boundary.modelId === OPENAI_SOURCE_SUMMARY_MODEL_ID &&
    boundary.regionFingerprint === OPENAI_PROCESSOR_REGION_FINGERPRINT &&
    boundary.retentionFingerprint === OPENAI_RESPONSES_RETENTION_FINGERPRINT &&
    boundary.endpointFingerprint === OPENAI_RESPONSES_ENDPOINT_FINGERPRINT
  );
}

function isOpenAiProjectAnalysisBoundary(boundary: AiExecutionBoundary): boolean {
  return (
    boundary.profileFingerprint === OPENAI_PROJECT_ANALYSIS_PROFILE_FINGERPRINT &&
    boundary.providerFingerprint === OPENAI_RESPONSES_PROVIDER_FINGERPRINT &&
    boundary.modelFingerprint === OPENAI_PROJECT_ANALYSIS_MODEL_FINGERPRINT &&
    boundary.modelId === OPENAI_PROJECT_ANALYSIS_MODEL_ID &&
    boundary.regionFingerprint === OPENAI_PROCESSOR_REGION_FINGERPRINT &&
    boundary.retentionFingerprint === OPENAI_RESPONSES_RETENTION_FINGERPRINT &&
    boundary.endpointFingerprint === OPENAI_RESPONSES_ENDPOINT_FINGERPRINT
  );
}

export function resolveAiExecutionProfile(
  operation: AiOperation,
  boundary: AiExecutionBoundary,
): AiExecutionProfile | null {
  if (operation === "autoExtract") {
    return isOpenAiAutoExtractBoundary(boundary)
      ? OPENAI_AUTO_EXTRACT_EXECUTION_PROFILE
      : null;
  }
  if (operation === "embedding") {
    return null;
  }
  if (operation === "generateWithContext") {
    return isOpenAiGenerateWithContextBoundary(boundary)
      ? OPENAI_GENERATE_WITH_CONTEXT_EXECUTION_PROFILE
      : null;
  }
  if (operation === "sourceSummary") {
    if (isOpenAiSourceSummaryBoundary(boundary)) {
      return OPENAI_SOURCE_SUMMARY_EXECUTION_PROFILE;
    }
    return boundary.modelId === FAKE_PROFILE.modelId
      ? SYNTHETIC_EXECUTION_PROFILE
      : null;
  }
  if (operation === "projectAnalysis") {
    if (isOpenAiProjectAnalysisBoundary(boundary)) {
      return OPENAI_PROJECT_ANALYSIS_EXECUTION_PROFILE;
    }
    return boundary.modelId === FAKE_PROFILE.modelId
      ? SYNTHETIC_EXECUTION_PROFILE
      : null;
  }
  return SYNTHETIC_EXECUTION_PROFILE;
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function assertAiExecutionInputWithinProfile(
  profile: AiExecutionProfile,
  inputBytes: number,
): void {
  if (profile.kind === "synthetic") {
    assertFakeInputWithinProfile(inputBytes);
    return;
  }
  if (!nonNegativeSafeInteger(inputBytes) || inputBytes > profile.maxInputBytes) {
    throwAiRuntimeServiceError("AI_BUDGET_DENIED");
  }
}

function ceilingRatio(value: number, numerator: number, denominator: number): number {
  const multiplied = value * numerator;
  if (!Number.isSafeInteger(multiplied)) {
    throwAiRuntimeServiceError("AI_BUDGET_DENIED");
  }
  return Math.ceil(multiplied / denominator);
}

export function calculateAiExecutionBudgetMicros(
  profile: AiExecutionProfile,
  usage: Readonly<{
    inputBytes: number;
    inputTokens: number;
    outputTokens: number;
  }>,
): number {
  assertAiExecutionInputWithinProfile(profile, usage.inputBytes);
  if (
    !nonNegativeSafeInteger(usage.inputTokens) ||
    !nonNegativeSafeInteger(usage.outputTokens) ||
    usage.inputTokens > profile.maxInputTokens ||
    usage.outputTokens > profile.maxOutputTokens
  ) {
    throwAiRuntimeServiceError("AI_BUDGET_DENIED");
  }
  if (profile.kind === "synthetic") {
    return calculateFakeBudgetMicros({
      inputBytes: usage.inputBytes,
      outputTokens: usage.outputTokens,
    });
  }

  // Frozen standard pricing: $0.75 / 1M input tokens and $4.50 / 1M output
  // tokens. Values are stored as integer micro-dollars and rounded upward.
  const inputCost = ceilingRatio(usage.inputTokens, 3, 4);
  const outputCost = ceilingRatio(usage.outputTokens, 9, 2);
  if (
    inputCost > Number.MAX_SAFE_INTEGER - outputCost ||
    inputCost + outputCost > profile.maxBudgetMicros
  ) {
    throwAiRuntimeServiceError("AI_BUDGET_DENIED");
  }
  return inputCost + outputCost;
}
