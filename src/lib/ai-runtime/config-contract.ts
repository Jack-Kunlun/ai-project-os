import type {
  AiRuntimeAvailability,
  AiRuntimeConfig,
} from "./types";

type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * Reads only the feature switch. Provider credentials are deliberately not
 * part of this contract and are never read here.
 */
export function loadAiRuntimeConfig(
  environment: RuntimeEnvironment = process.env,
): AiRuntimeConfig {
  const enabled = environment.AI_ENABLED?.trim().toLowerCase() === "true";
  return enabled
    ? {
        enabled: true,
        status: "provider_disabled",
        errorCode: "AI_PROVIDER_DISABLED",
      }
    : {
        enabled: false,
        status: "disabled",
        errorCode: "AI_DISABLED",
      };
}

/**
 * Layer A has no provider implementation. Even an explicit feature switch
 * therefore fails closed with a stable code and cannot make V0 depend on a
 * key, SDK, network call or provider configuration.
 */
export function checkAiRuntimeAvailability(
  config: AiRuntimeConfig,
): AiRuntimeAvailability {
  return config.enabled
    ? { enabled: true, available: false, errorCode: "AI_PROVIDER_DISABLED" }
    : { enabled: false, available: false, errorCode: "AI_DISABLED" };
}
