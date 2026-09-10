import type { AiOperation, AiProviderConnection } from "@prisma/client";
import { CredentialVaultError, readCredentialSecret } from "@/lib/credential-vault";

/** Upper bound used for one provider HTTP request when no earlier deadline applies. */
export const PROVIDER_REQUEST_TIMEOUT_MS = 45_000;
/**
 * Interactive transaction budget for the manual provider connectivity test.
 * It must outlive the single shared provider probe deadline by a bounded
 * amount so the membership lock stays held through the final CAS write.
 */
export const PROVIDER_CONNECTION_TEST_TRANSACTION_TIMEOUT_MS = PROVIDER_REQUEST_TIMEOUT_MS + 10_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_EMBEDDING_BATCH = 32;
const MAX_EMBEDDING_INPUT_CHARS = 24_000;

export type ProviderTransportErrorCode =
  | "AI_PROVIDER_AUTH_FAILED"
  | "AI_PROVIDER_RATE_LIMITED"
  | "AI_PROVIDER_REJECTED"
  | "AI_PROVIDER_UNAVAILABLE"
  | "AI_PROVIDER_TIMEOUT"
  | "AI_PROVIDER_RESPONSE_TOO_LARGE"
  | "AI_PROVIDER_INVALID_RESPONSE"
  | "AI_PROVIDER_EMBEDDING_UNSUPPORTED"
  | "AI_PROVIDER_VISION_UNSUPPORTED";

export class ProviderTransportError extends Error {
  constructor(
    readonly code: ProviderTransportErrorCode,
    readonly status: number = 502,
    /** Whether the provider request may already have reached the network. */
    readonly requestDispatched = true,
    /** Whether a provider response was received before the error was raised. */
    readonly responseReceived = false,
  ) {
    super(code);
    this.name = "ProviderTransportError";
  }
}

export type ChatMessage = Readonly<{
  role: "system" | "user" | "assistant";
  content: string;
}>;

export type ChatResult = Readonly<{
  content: string;
  inputTokens: number;
  outputTokens: number;
  usageKnown: boolean;
  providerRequestId: string | null;
}>;

export type EmbeddingResult = Readonly<{
  vectors: readonly (readonly number[])[];
  dimensions: number;
  inputTokens: number;
  usageKnown: boolean;
  providerRequestId: string | null;
}>;

type RuntimeConnection = Pick<
  AiProviderConnection,
  "id" | "kind" | "baseUrl" | "credentialId" | "status"
> & Readonly<{
  /** Present only for a governed dispatch admitted against an exact secret. */
  credentialSecretFingerprint?: string;
  /**
   * Fresh control-plane fence immediately before the credential is read.
   * Governed callers attach this to the in-process connection instead of
   * widening every provider call site with a second dispatch argument.
   */
  onBeforeCredentialRead?: () => void | boolean | Promise<void | boolean>;
  /** Fresh control-plane fence after credential read and before fetch(). */
  onBeforeRequest?: () => void | boolean | Promise<void | boolean>;
}>;

function fail(code: ProviderTransportErrorCode, status = 502, responseReceived = false): never {
  throw new ProviderTransportError(code, status, true, responseReceived);
}

function safeRequestId(response: Response): string | null {
  const value = response.headers.get("x-request-id") ?? response.headers.get("request-id");
  return value !== null && /^[\x20-\x7e]{1,256}$/.test(value) ? value : null;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const lengthHeader = response.headers.get("content-length");
  if (lengthHeader !== null) {
    const length = Number(lengthHeader);
    if (!Number.isFinite(length) || length < 0 || length > MAX_RESPONSE_BYTES) {
      return fail("AI_PROVIDER_RESPONSE_TOO_LARGE", 502, true);
    }
  }
  const body = await response.arrayBuffer();
  if (body.byteLength > MAX_RESPONSE_BYTES) return fail("AI_PROVIDER_RESPONSE_TOO_LARGE", 502, true);
  try {
    return JSON.parse(new TextDecoder().decode(body)) as unknown;
  } catch {
    return fail("AI_PROVIDER_INVALID_RESPONSE", 502, true);
  }
}

function mapHttpError(status: number): never {
  if (status === 401 || status === 403) return fail("AI_PROVIDER_AUTH_FAILED", 422, true);
  if (status === 429) return fail("AI_PROVIDER_RATE_LIMITED", 429, true);
  if (status >= 400 && status < 500) return fail("AI_PROVIDER_REJECTED", 422, true);
  return fail("AI_PROVIDER_UNAVAILABLE", 502, true);
}

async function providerPost(
  connection: RuntimeConnection,
  path: "/chat/completions" | "/embeddings" | "/responses",
  body: Readonly<Record<string, unknown>>,
  absoluteDeadlineAt?: Date,
): Promise<Readonly<{ payload: unknown; requestId: string | null }>> {
  if (connection.status === "disabled") throw new ProviderTransportError("AI_PROVIDER_UNAVAILABLE", 409, false);
  const remaining = absoluteDeadlineAt === undefined
    ? PROVIDER_REQUEST_TIMEOUT_MS
    : absoluteDeadlineAt.getTime() - Date.now();
  if (remaining <= 0) throw new ProviderTransportError("AI_PROVIDER_TIMEOUT", 504, false);
  await runProviderBoundary(connection.onBeforeCredentialRead);
  let apiKey: string;
  try {
    apiKey = await readCredentialSecretWithDeadline(
      connection.credentialId,
      absoluteDeadlineAt,
      connection.credentialSecretFingerprint,
    );
  } catch (error) {
    // Credential rotation is a pre-dispatch fence. Do not let a vault error
    // fall through to the generic transport handler, which would otherwise
    // conservatively classify the request as network-uncertain.
    if (error instanceof CredentialVaultError) {
      throw new ProviderTransportError("AI_PROVIDER_UNAVAILABLE", 409, false);
    }
    throw error;
  }
  const remainingAfterCredential = absoluteDeadlineAt === undefined
    ? PROVIDER_REQUEST_TIMEOUT_MS
    : absoluteDeadlineAt.getTime() - Date.now();
  if (remainingAfterCredential <= 0) {
    throw new ProviderTransportError("AI_PROVIDER_TIMEOUT", 504, false);
  }
  await runProviderBoundary(connection.onBeforeRequest);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.min(PROVIDER_REQUEST_TIMEOUT_MS, remainingAfterCredential));
  try {
    const response = await fetch(`${connection.baseUrl}${path}`, {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
    });
    const requestId = safeRequestId(response);
    if (!response.ok) return mapHttpError(response.status);
    const payload = await readBoundedJson(response);
    if (absoluteDeadlineAt !== undefined && absoluteDeadlineAt.getTime() <= Date.now()) {
      return fail("AI_PROVIDER_TIMEOUT", 504, true);
    }
    return Object.freeze({ payload, requestId });
  } catch (error) {
    if (error instanceof ProviderTransportError) throw error;
    if (error instanceof DOMException && error.name === "AbortError") {
      return fail("AI_PROVIDER_TIMEOUT", 504);
    }
    return fail("AI_PROVIDER_UNAVAILABLE", 502);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * A rejected fresh fence is still pre-dispatch. Keep that classification
 * explicit so auditedProviderCall can release a reservation and reset the
 * durable dispatch marker instead of treating a rejected request as unknown.
 * Any unexpected fence error is conservatively mapped to the same safe
 * pre-dispatch outcome; the caller must never reach fetch after a fence
 * failure.
 */
async function runProviderBoundary(
  boundary: (() => void | boolean | Promise<void | boolean>) | undefined,
): Promise<void> {
  if (boundary === undefined) return;
  try {
    const accepted = await boundary();
    if (accepted === false) throw new ProviderTransportError("AI_PROVIDER_UNAVAILABLE", 409, false);
  } catch (error) {
    if (error instanceof ProviderTransportError && error.requestDispatched === false) throw error;
    throw new ProviderTransportError("AI_PROVIDER_UNAVAILABLE", 409, false);
  }
}

async function readCredentialSecretWithDeadline(
  credentialId: string,
  absoluteDeadlineAt: Date | undefined,
  expectedSecretFingerprint?: string,
): Promise<string> {
  const options = expectedSecretFingerprint === undefined ? {} : { expectedSecretFingerprint };
  if (absoluteDeadlineAt === undefined) return readCredentialSecret(credentialId, "aiProvider", undefined, options);
  const remaining = absoluteDeadlineAt.getTime() - Date.now();
  if (remaining <= 0) throw new ProviderTransportError("AI_PROVIDER_TIMEOUT", 504, false);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new ProviderTransportError("AI_PROVIDER_TIMEOUT", 504, false)), remaining);
  });
  try {
    return await Promise.race([readCredentialSecret(credentialId, "aiProvider", undefined, options), deadline]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function usageCounts(payload: Record<string, unknown>, outputRequired = true): Readonly<{ input: number; output: number; known: boolean }> {
  const usage = payload.usage;
  if (typeof usage !== "object" || usage === null) return Object.freeze({ input: 0, output: 0, known: false });
  const record = usage as Record<string, unknown>;
  const input = record.prompt_tokens ?? record.input_tokens;
  const output = record.completion_tokens ?? record.output_tokens;
  const inputKnown = typeof input === "number" && Number.isSafeInteger(input) && input >= 0;
  const outputKnown = typeof output === "number" && Number.isSafeInteger(output) && output >= 0;
  return Object.freeze({
    input: inputKnown ? input : 0,
    output: outputKnown ? output : 0,
    known: inputKnown && (outputRequired ? outputKnown : true),
  });
}

export async function invokeChatCompletion(input: Readonly<{
  connection: RuntimeConnection;
  operation: Exclude<AiOperation, "embedding">;
  modelId: string;
  messages: readonly ChatMessage[];
  maxOutputTokens: number;
  temperature?: number;
  absoluteDeadlineAt?: Date;
}>): Promise<ChatResult> {
  const { payload, requestId } = await providerPost(input.connection, "/chat/completions", {
    model: input.modelId,
    messages: input.messages,
    max_tokens: input.maxOutputTokens,
    temperature: input.temperature ?? 0,
    stream: false,
  }, input.absoluteDeadlineAt);
  if (typeof payload !== "object" || payload === null) return fail("AI_PROVIDER_INVALID_RESPONSE", 502, true);
  const record = payload as Record<string, unknown>;
  const choices = record.choices;
  if (!Array.isArray(choices) || choices.length === 0) return fail("AI_PROVIDER_INVALID_RESPONSE", 502, true);
  const first = choices[0];
  if (typeof first !== "object" || first === null) return fail("AI_PROVIDER_INVALID_RESPONSE", 502, true);
  const message = (first as Record<string, unknown>).message;
  if (typeof message !== "object" || message === null) return fail("AI_PROVIDER_INVALID_RESPONSE", 502, true);
  const content = (message as Record<string, unknown>).content;
  if (typeof content !== "string" || content.trim().length === 0 || content.length > 1_000_000) {
    return fail("AI_PROVIDER_INVALID_RESPONSE", 502, true);
  }
  const usage = usageCounts(record);
  return Object.freeze({
    content,
    inputTokens: usage.input,
    outputTokens: usage.output,
    usageKnown: usage.known,
    providerRequestId: requestId,
  });
}

function responseText(payload: Record<string, unknown>): string | null {
  if (typeof payload.output_text === "string" && payload.output_text.trim().length > 0) return payload.output_text;
  if (!Array.isArray(payload.output)) return null;
  for (const item of payload.output) {
    if (typeof item !== "object" || item === null) continue;
    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (typeof part !== "object" || part === null) continue;
      const record = part as Record<string, unknown>;
      if ((record.type === "output_text" || record.type === "text") && typeof record.text === "string" && record.text.trim().length > 0) {
        return record.text;
      }
    }
  }
  return null;
}

export async function invokeVisionCompletion(input: Readonly<{
  connection: RuntimeConnection;
  modelId: string;
  image: Buffer;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  prompt: string;
  maxOutputTokens: number;
  absoluteDeadlineAt?: Date;
}>): Promise<ChatResult> {
  if (input.image.length === 0 || input.image.length > 10 * 1024 * 1024 || input.prompt.length < 1 || input.prompt.length > 8_000) {
    return fail("AI_PROVIDER_REJECTED", 400);
  }
  const dataUrl = `data:${input.mimeType};base64,${input.image.toString("base64")}`;
  if (input.connection.kind === "deepseek") {
    if (input.modelId !== "deepseek-v4-flash-vision-exp") return fail("AI_PROVIDER_VISION_UNSUPPORTED", 422);
    const { payload, requestId } = await providerPost(input.connection, "/responses", {
      model: input.modelId,
      instructions: "Extract only evidence visible in the image. Never infer hidden facts. Return the requested JSON object only.",
      input: [{
        role: "user",
        content: [
          { type: "input_text", text: input.prompt },
          { type: "input_image", image_url: dataUrl, detail: "high" },
        ],
      }],
      max_output_tokens: input.maxOutputTokens,
      store: false,
    }, input.absoluteDeadlineAt);
    if (typeof payload !== "object" || payload === null) return fail("AI_PROVIDER_INVALID_RESPONSE", 502, true);
    const record = payload as Record<string, unknown>;
    const content = responseText(record);
    if (content === null || content.length > 1_000_000) return fail("AI_PROVIDER_INVALID_RESPONSE", 502, true);
    const usage = usageCounts(record);
    return Object.freeze({
      content,
      inputTokens: usage.input,
      outputTokens: usage.output,
      usageKnown: usage.known,
      providerRequestId: requestId,
    });
  }
  const { payload, requestId } = await providerPost(input.connection, "/chat/completions", {
    model: input.modelId,
    messages: [{
      role: "user",
      content: [
        { type: "image_url", image_url: { url: dataUrl } },
        { type: "text", text: input.prompt },
      ],
    }],
    max_tokens: input.maxOutputTokens,
    temperature: 0,
    stream: false,
  }, input.absoluteDeadlineAt);
  if (typeof payload !== "object" || payload === null) return fail("AI_PROVIDER_INVALID_RESPONSE", 502, true);
  const record = payload as Record<string, unknown>;
  const choices = record.choices;
  if (!Array.isArray(choices) || choices.length === 0) return fail("AI_PROVIDER_INVALID_RESPONSE", 502, true);
  const first = choices[0];
  if (typeof first !== "object" || first === null) return fail("AI_PROVIDER_INVALID_RESPONSE", 502, true);
  const message = (first as Record<string, unknown>).message;
  if (typeof message !== "object" || message === null) return fail("AI_PROVIDER_INVALID_RESPONSE", 502, true);
  const content = (message as Record<string, unknown>).content;
  if (typeof content !== "string" || content.trim().length === 0 || content.length > 1_000_000) {
    return fail("AI_PROVIDER_INVALID_RESPONSE", 502, true);
  }
  const usage = usageCounts(record);
  return Object.freeze({
    content,
    inputTokens: usage.input,
    outputTokens: usage.output,
    usageKnown: usage.known,
    providerRequestId: requestId,
  });
}

export async function invokeEmbeddings(input: Readonly<{
  connection: RuntimeConnection;
  modelId: string;
  texts: readonly string[];
  expectedDimensions?: number | null;
  absoluteDeadlineAt?: Date;
}>): Promise<EmbeddingResult> {
  if (input.connection.kind === "deepseek") return fail("AI_PROVIDER_EMBEDDING_UNSUPPORTED", 422);
  if (
    input.texts.length === 0 ||
    input.texts.length > MAX_EMBEDDING_BATCH ||
    input.texts.some((text) => text.length === 0 || text.length > MAX_EMBEDDING_INPUT_CHARS)
  ) {
    return fail("AI_PROVIDER_REJECTED", 400);
  }
  const { payload, requestId } = await providerPost(input.connection, "/embeddings", {
    model: input.modelId,
    input: input.texts,
    ...((input.connection.kind === "openai" || input.connection.kind === "glm") && input.expectedDimensions
      ? { dimensions: input.expectedDimensions }
      : {}),
  }, input.absoluteDeadlineAt);
  if (typeof payload !== "object" || payload === null) return fail("AI_PROVIDER_INVALID_RESPONSE", 502, true);
  const record = payload as Record<string, unknown>;
  const data = record.data;
  if (!Array.isArray(data) || data.length !== input.texts.length) return fail("AI_PROVIDER_INVALID_RESPONSE", 502, true);
  const ordered = data
    .map((entry, fallbackIndex) => {
      if (typeof entry !== "object" || entry === null) return fail("AI_PROVIDER_INVALID_RESPONSE", 502, true);
      const candidate = entry as Record<string, unknown>;
      const index = candidate.index;
      const embedding = candidate.embedding;
      if (!Array.isArray(embedding) || embedding.length === 0) return fail("AI_PROVIDER_INVALID_RESPONSE", 502, true);
      if (embedding.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
        return fail("AI_PROVIDER_INVALID_RESPONSE", 502, true);
      }
      return {
        index: typeof index === "number" && Number.isSafeInteger(index) ? index : fallbackIndex,
        vector: embedding as number[],
      };
    })
    .sort((left, right) => left.index - right.index);
  const dimensions = ordered[0]?.vector.length ?? 0;
  if (
    dimensions === 0 ||
    ordered.some((entry, index) => entry.index !== index || entry.vector.length !== dimensions) ||
    (input.expectedDimensions != null && dimensions !== input.expectedDimensions)
  ) {
    return fail("AI_PROVIDER_INVALID_RESPONSE", 502, true);
  }
  const usage = usageCounts(record, false);
  return Object.freeze({
    vectors: Object.freeze(ordered.map((entry) => Object.freeze(entry.vector))),
    dimensions,
    inputTokens: usage.input,
    usageKnown: usage.known,
    providerRequestId: requestId,
  });
}
