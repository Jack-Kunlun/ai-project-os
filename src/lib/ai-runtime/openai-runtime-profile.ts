import { createHash } from "node:crypto";
import {
  OPENAI_EMBEDDING_DIMENSIONS,
  OPENAI_EMBEDDINGS_ENDPOINT_FINGERPRINT,
  OPENAI_EMBEDDINGS_PROFILE_VERSION,
  OPENAI_EMBEDDINGS_PROVIDER_FINGERPRINT,
  OPENAI_EMBEDDINGS_RETENTION_FINGERPRINT,
  type OpenAiEmbeddingsProfile,
} from "./openai-embeddings-contract";
import {
  OPENAI_RESPONSES_ENDPOINT_FINGERPRINT,
  OPENAI_RESPONSES_PROFILE_VERSION,
  OPENAI_RESPONSES_PROVIDER_FINGERPRINT,
  OPENAI_RESPONSES_RETENTION_FINGERPRINT,
  type OpenAiResponsesProfile,
} from "./openai-responses-contract";

export const OPENAI_AUTO_EXTRACT_MODEL_ID =
  "gpt-5.4-mini-2026-03-17" as const;
export const OPENAI_EMBEDDING_MODEL_ID = "text-embedding-3-small" as const;
export const OPENAI_RUNTIME_PROFILE_VERSION =
  "ai-project-os-openai-profile:v1" as const;

function fingerprint(label: string): string {
  return createHash("sha256")
    .update(`${OPENAI_RUNTIME_PROFILE_VERSION}:${label}`, "utf8")
    .digest("hex");
}

export const OPENAI_PROCESSOR_REGION_FINGERPRINT = fingerprint(
  "processor-region:global",
);
export const OPENAI_AUTO_EXTRACT_MODEL_FINGERPRINT = fingerprint(
  `model:${OPENAI_AUTO_EXTRACT_MODEL_ID}`,
);
export const OPENAI_EMBEDDING_MODEL_FINGERPRINT = fingerprint(
  `model:${OPENAI_EMBEDDING_MODEL_ID}:dimensions:${OPENAI_EMBEDDING_DIMENSIONS}`,
);
export const OPENAI_AUTO_EXTRACT_PROFILE_FINGERPRINT = fingerprint(
  [
    "operation:autoExtract",
    OPENAI_AUTO_EXTRACT_MODEL_ID,
    OPENAI_RESPONSES_ENDPOINT_FINGERPRINT,
    OPENAI_PROCESSOR_REGION_FINGERPRINT,
    OPENAI_RESPONSES_RETENTION_FINGERPRINT,
    "max-input-bytes:64000",
    "max-output-tokens:2048",
    "timeout-ms:60000",
  ].join("\u0000"),
);
export const OPENAI_EMBEDDING_PROFILE_FINGERPRINT = fingerprint(
  [
    "operation:embedding",
    OPENAI_EMBEDDING_MODEL_ID,
    OPENAI_EMBEDDINGS_ENDPOINT_FINGERPRINT,
    OPENAI_PROCESSOR_REGION_FINGERPRINT,
    OPENAI_EMBEDDINGS_RETENTION_FINGERPRINT,
    "dimensions:1536",
    "max-input-bytes:8192",
    "max-total-input-bytes:256000",
    "max-inputs:100",
    "timeout-ms:60000",
  ].join("\u0000"),
);

export function getOpenAiAutoExtractProfile(): Readonly<OpenAiResponsesProfile> {
  return Object.freeze({
    profileVersion: OPENAI_RESPONSES_PROFILE_VERSION,
    providerFingerprint: OPENAI_RESPONSES_PROVIDER_FINGERPRINT,
    profileFingerprint: OPENAI_AUTO_EXTRACT_PROFILE_FINGERPRINT,
    modelId: OPENAI_AUTO_EXTRACT_MODEL_ID,
    modelFingerprint: OPENAI_AUTO_EXTRACT_MODEL_FINGERPRINT,
    processorEndpointFingerprint: OPENAI_RESPONSES_ENDPOINT_FINGERPRINT,
    processorRegionFingerprint: OPENAI_PROCESSOR_REGION_FINGERPRINT,
    processorRetentionFingerprint: OPENAI_RESPONSES_RETENTION_FINGERPRINT,
    maxInputBytes: 64_000,
    maxOutputTokens: 2_048,
    timeoutMs: 60_000,
  });
}

export function getOpenAiEmbeddingProfile(): Readonly<OpenAiEmbeddingsProfile> {
  return Object.freeze({
    profileVersion: OPENAI_EMBEDDINGS_PROFILE_VERSION,
    providerFingerprint: OPENAI_EMBEDDINGS_PROVIDER_FINGERPRINT,
    profileFingerprint: OPENAI_EMBEDDING_PROFILE_FINGERPRINT,
    modelId: OPENAI_EMBEDDING_MODEL_ID,
    modelFingerprint: OPENAI_EMBEDDING_MODEL_FINGERPRINT,
    processorEndpointFingerprint: OPENAI_EMBEDDINGS_ENDPOINT_FINGERPRINT,
    processorRegionFingerprint: OPENAI_PROCESSOR_REGION_FINGERPRINT,
    processorRetentionFingerprint: OPENAI_EMBEDDINGS_RETENTION_FINGERPRINT,
    maxInputBytes: 8_192,
    maxTotalInputBytes: 256_000,
    maxInputs: 100,
    dimensions: OPENAI_EMBEDDING_DIMENSIONS,
    timeoutMs: 60_000,
  });
}
