import { createHash } from "node:crypto";
import { throwAiRuntimeServiceError } from "./errors";

const FAKE_PROFILE_NAMESPACE = "ai-project-os:fake-runtime:v1";

function fingerprint(label: string): string {
  return createHash("sha256")
    .update(`${FAKE_PROFILE_NAMESPACE}:${label}`, "utf8")
    .digest("hex");
}

export const FAKE_PROFILE = Object.freeze({
  profileFingerprint: fingerprint("profile"),
  providerFingerprint: fingerprint("provider"),
  modelFingerprint: fingerprint("model"),
  modelId: "synthetic-provider/model-v1",
  promptFingerprint: fingerprint("prompt"),
  promptVersion: "fake-prompt-v1",
  pricingSnapshotId: "fake-pricing-v1",
  scannerVersion: "scanner-v1",
  maxInputBytes: 256_000,
  maxInputTokens: 4_096,
  maxOutputTokens: 1_024,
  maxRequests: 1,
  maxBudgetMicros: 1_000_000,
  baseBudgetMicros: 100,
  inputByteBudgetMicros: 2,
  outputTokenBudgetMicros: 4,
} as const);

export const FAKE_OPERATION_PROFILE = FAKE_PROFILE;

type BudgetInput = Readonly<{
  inputBytes: number;
  outputTokens: number;
}>;

function nonNegativeSafeInteger(value: unknown): value is number {
  return Number.isFinite(value) && Number.isSafeInteger(value) && (value as number) >= 0;
}

function validateBudgetInput(inputBytes: unknown, outputTokens: unknown): BudgetInput {
  if (!nonNegativeSafeInteger(inputBytes) || !nonNegativeSafeInteger(outputTokens)) {
    throwAiRuntimeServiceError("AI_BUDGET_DENIED");
  }
  if (
    inputBytes > FAKE_PROFILE.maxInputBytes ||
    outputTokens > FAKE_PROFILE.maxOutputTokens
  ) {
    throwAiRuntimeServiceError("AI_BUDGET_DENIED");
  }
  return { inputBytes, outputTokens };
}

export function calculateFakeBudgetMicros(input: BudgetInput): number;
export function calculateFakeBudgetMicros(inputBytes: number, outputTokens?: number): number;
export function calculateFakeBudgetMicros(
  inputOrBytes: BudgetInput | number,
  outputTokens = 0,
): number {
  const input =
    typeof inputOrBytes === "number"
      ? validateBudgetInput(inputOrBytes, outputTokens)
      : (() => {
          let isExactBudgetInput = false;
          try {
            isExactBudgetInput =
              typeof inputOrBytes === "object" &&
              inputOrBytes !== null &&
              !Array.isArray(inputOrBytes) &&
              Object.getPrototypeOf(inputOrBytes) === Object.prototype &&
              Object.keys(inputOrBytes).sort().join(",") === "inputBytes,outputTokens";
          } catch {
            isExactBudgetInput = false;
          }
          if (!isExactBudgetInput) {
            throwAiRuntimeServiceError("AI_BUDGET_DENIED");
          }
          return validateBudgetInput(inputOrBytes.inputBytes, inputOrBytes.outputTokens);
        })();

  const inputCost = input.inputBytes * FAKE_PROFILE.inputByteBudgetMicros;
  const outputCost = input.outputTokens * FAKE_PROFILE.outputTokenBudgetMicros;
  if (
    !Number.isSafeInteger(inputCost) ||
    !Number.isSafeInteger(outputCost) ||
    inputCost > Number.MAX_SAFE_INTEGER - FAKE_PROFILE.baseBudgetMicros ||
    inputCost + FAKE_PROFILE.baseBudgetMicros > Number.MAX_SAFE_INTEGER - outputCost
  ) {
    throwAiRuntimeServiceError("AI_BUDGET_DENIED");
  }
  const total = FAKE_PROFILE.baseBudgetMicros + inputCost + outputCost;
  if (total > FAKE_PROFILE.maxBudgetMicros) {
    throwAiRuntimeServiceError("AI_BUDGET_DENIED");
  }
  return total;
}

export function assertFakeInputWithinProfile(inputBytes: number): void {
  if (!nonNegativeSafeInteger(inputBytes) || inputBytes > FAKE_PROFILE.maxInputBytes) {
    throwAiRuntimeServiceError("AI_BUDGET_DENIED");
  }
}
