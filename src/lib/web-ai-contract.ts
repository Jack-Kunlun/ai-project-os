export const WEB_AI_TRANSFER_CONSENT_VERSION = "web-ai-transfer-consent:v1" as const;

/**
 * Current Web AI browser protocol. The legacy consent version remains on
 * grants as historical evidence, but it is not accepted by the seven public
 * Web AI routes anymore.
 */
export const WEB_AI_CONFIRMATION_PROTOCOL_VERSION = "web-ai-confirmation:v1" as const;
export type WebAiConfirmationPhase = "prepare" | "execute";
