import type {
  AiRuntimeAvailability,
  AiRuntimeConfig,
} from "./types";
import { isOpenAiCredentialConfigured } from "./openai-http-transport";
import {
  OPENAI_AUTO_EXTRACT_MODEL_ID,
  OPENAI_EMBEDDING_MODEL_ID,
} from "./openai-runtime-profile";

type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * Returns only safe runtime availability. A credential is checked through an
 * in-memory handle but never copied into this serializable result.
 */
export function loadAiRuntimeConfig(
  environment: RuntimeEnvironment = process.env,
): AiRuntimeConfig {
  const enabled = environment.AI_ENABLED?.trim().toLowerCase() === "true";
  if (!enabled) {
    return {
      enabled: false,
      status: "disabled",
      errorCode: "AI_DISABLED",
    };
  }
  const provider = environment.AI_PROVIDER?.trim().toLowerCase();
  if (provider !== "openai" || !isOpenAiCredentialConfigured(environment)) {
    return {
      enabled: true,
      status: "provider_disabled",
      errorCode: "AI_PROVIDER_DISABLED",
    };
  }
  return {
    enabled: true,
    status: "ready",
    provider: "openai",
    responseModelId: OPENAI_AUTO_EXTRACT_MODEL_ID,
    embeddingModelId: OPENAI_EMBEDDING_MODEL_ID,
  };
}

/**
 * Missing switches, provider selection or credentials always fail closed.
 */
export function checkAiRuntimeAvailability(
  config: AiRuntimeConfig,
): AiRuntimeAvailability {
  if (!config.enabled) {
    return { enabled: false, available: false, errorCode: "AI_DISABLED" };
  }
  return config.status === "ready"
    ? {
        enabled: true,
        available: true,
        errorCode: null,
        provider: config.provider,
        responseModelId: config.responseModelId,
        embeddingModelId: config.embeddingModelId,
      }
    : { enabled: true, available: false, errorCode: "AI_PROVIDER_DISABLED" };
}
