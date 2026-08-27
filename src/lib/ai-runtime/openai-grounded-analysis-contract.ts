import { createHash } from "node:crypto";

export const OPENAI_GROUNDED_ANALYSIS_CONTRACT_VERSION =
  "openai-grounded-analysis-contract:v1" as const;
export const OPENAI_SOURCE_SUMMARY_PROMPT_VERSION =
  "grounded-source-summary-provider-prompt:v1" as const;
export const OPENAI_PROJECT_ANALYSIS_PROMPT_VERSION =
  "grounded-project-analysis-provider-prompt:v1" as const;

function fingerprint(label: string): string {
  return createHash("sha256")
    .update(`${OPENAI_GROUNDED_ANALYSIS_CONTRACT_VERSION}:${label}`, "utf8")
    .digest("hex");
}

export const OPENAI_SOURCE_SUMMARY_PROMPT_FINGERPRINT = fingerprint(
  "source-summary:exact-citations:no-tools:no-external-knowledge",
);
export const OPENAI_PROJECT_ANALYSIS_PROMPT_FINGERPRINT = fingerprint(
  "project-analysis:progress-risks-unknowns-conflicts-questions:exact-citations:no-tools:no-external-knowledge",
);
