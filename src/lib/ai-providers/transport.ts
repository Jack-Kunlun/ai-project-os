import type { AiOperation, AiProviderConnection } from "@prisma/client";
import { readCredentialSecret } from "@/lib/credential-vault";

/** Upper bound used for one provider HTTP request when no earlier deadline applies. */
export const PROVIDER_REQUEST_TIMEOUT_MS = 45_000;
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
  providerRequestId: string | null;
}>;

export type EmbeddingResult = Readonly<{
  vectors: readonly (readonly number[])[];
  dimensions: number;
  inputTokens: number;
  providerRequestId: string | null;
}>;

type RuntimeConnection = Pick<
  AiProviderConnection,
  "id" | "kind" | "baseUrl" | "credentialId" | "status"
>;

function fail(code: ProviderTransportErrorCode, status = 502): never {
  throw new ProviderTransportError(code, status);
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
      return fail("AI_PROVIDER_RESPONSE_TOO_LARGE");
    }
  }
  const body = await response.arrayBuffer();
  if (body.byteLength > MAX_RESPONSE_BYTES) return fail("AI_PROVIDER_RESPONSE_TOO_LARGE");
  try {
    return JSON.parse(new TextDecoder().decode(body)) as unknown;
  } catch {
    return fail("AI_PROVIDER_INVALID_RESPONSE");
  }
}

function mapHttpError(status: number): never {
  if (status === 401 || status === 403) return fail("AI_PROVIDER_AUTH_FAILED", 422);
  if (status === 429) return fail("AI_PROVIDER_RATE_LIMITED", 429);
  if (status >= 400 && status < 500) return fail("AI_PROVIDER_REJECTED", 422);
  return fail("AI_PROVIDER_UNAVAILABLE", 502);
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
  const apiKey = await readCredentialSecret(connection.credentialId, "aiProvider");
  const remainingAfterCredential = absoluteDeadlineAt === undefined
    ? PROVIDER_REQUEST_TIMEOUT_MS
    : absoluteDeadlineAt.getTime() - Date.now();
  if (remainingAfterCredential <= 0) {
    throw new ProviderTransportError("AI_PROVIDER_TIMEOUT", 504, false);
  }
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
    return Object.freeze({ payload: await readBoundedJson(response), requestId });
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

function usageCounts(payload: Record<string, unknown>): Readonly<{ input: number; output: number }> {
  const usage = payload.usage;
  if (typeof usage !== "object" || usage === null) return Object.freeze({ input: 0, output: 0 });
  const record = usage as Record<string, unknown>;
  const input = record.prompt_tokens ?? record.input_tokens;
  const output = record.completion_tokens ?? record.output_tokens;
  return Object.freeze({
    input: typeof input === "number" && Number.isSafeInteger(input) && input >= 0 ? input : 0,
    output: typeof output === "number" && Number.isSafeInteger(output) && output >= 0 ? output : 0,
  });
}

export async function invokeChatCompletion(input: Readonly<{
  connection: RuntimeConnection;
  operation: Exclude<AiOperation, "embedding">;
  modelId: string;
  messages: readonly ChatMessage[];
  maxOutputTokens: number;
  temperature?: number;
}>): Promise<ChatResult> {
  const { payload, requestId } = await providerPost(input.connection, "/chat/completions", {
    model: input.modelId,
    messages: input.messages,
    max_tokens: input.maxOutputTokens,
    temperature: input.temperature ?? 0,
    stream: false,
  });
  if (typeof payload !== "object" || payload === null) return fail("AI_PROVIDER_INVALID_RESPONSE");
  const record = payload as Record<string, unknown>;
  const choices = record.choices;
  if (!Array.isArray(choices) || choices.length === 0) return fail("AI_PROVIDER_INVALID_RESPONSE");
  const first = choices[0];
  if (typeof first !== "object" || first === null) return fail("AI_PROVIDER_INVALID_RESPONSE");
  const message = (first as Record<string, unknown>).message;
  if (typeof message !== "object" || message === null) return fail("AI_PROVIDER_INVALID_RESPONSE");
  const content = (message as Record<string, unknown>).content;
  if (typeof content !== "string" || content.trim().length === 0 || content.length > 1_000_000) {
    return fail("AI_PROVIDER_INVALID_RESPONSE");
  }
  const usage = usageCounts(record);
  return Object.freeze({
    content,
    inputTokens: usage.input,
    outputTokens: usage.output,
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
    });
    if (typeof payload !== "object" || payload === null) return fail("AI_PROVIDER_INVALID_RESPONSE");
    const record = payload as Record<string, unknown>;
    const content = responseText(record);
    if (content === null || content.length > 1_000_000) return fail("AI_PROVIDER_INVALID_RESPONSE");
    const usage = usageCounts(record);
    return Object.freeze({
      content,
      inputTokens: usage.input,
      outputTokens: usage.output,
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
  });
  if (typeof payload !== "object" || payload === null) return fail("AI_PROVIDER_INVALID_RESPONSE");
  const record = payload as Record<string, unknown>;
  const choices = record.choices;
  if (!Array.isArray(choices) || choices.length === 0) return fail("AI_PROVIDER_INVALID_RESPONSE");
  const first = choices[0];
  if (typeof first !== "object" || first === null) return fail("AI_PROVIDER_INVALID_RESPONSE");
  const message = (first as Record<string, unknown>).message;
  if (typeof message !== "object" || message === null) return fail("AI_PROVIDER_INVALID_RESPONSE");
  const content = (message as Record<string, unknown>).content;
  if (typeof content !== "string" || content.trim().length === 0 || content.length > 1_000_000) {
    return fail("AI_PROVIDER_INVALID_RESPONSE");
  }
  const usage = usageCounts(record);
  return Object.freeze({
    content,
    inputTokens: usage.input,
    outputTokens: usage.output,
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
    ...(input.connection.kind === "openai" && input.expectedDimensions
      ? { dimensions: input.expectedDimensions }
      : {}),
  }, input.absoluteDeadlineAt);
  if (typeof payload !== "object" || payload === null) return fail("AI_PROVIDER_INVALID_RESPONSE");
  const record = payload as Record<string, unknown>;
  const data = record.data;
  if (!Array.isArray(data) || data.length !== input.texts.length) return fail("AI_PROVIDER_INVALID_RESPONSE");
  const ordered = data
    .map((entry, fallbackIndex) => {
      if (typeof entry !== "object" || entry === null) return fail("AI_PROVIDER_INVALID_RESPONSE");
      const candidate = entry as Record<string, unknown>;
      const index = candidate.index;
      const embedding = candidate.embedding;
      if (!Array.isArray(embedding) || embedding.length === 0) return fail("AI_PROVIDER_INVALID_RESPONSE");
      if (embedding.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
        return fail("AI_PROVIDER_INVALID_RESPONSE");
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
    return fail("AI_PROVIDER_INVALID_RESPONSE");
  }
  const usage = usageCounts(record);
  return Object.freeze({
    vectors: Object.freeze(ordered.map((entry) => Object.freeze(entry.vector))),
    dimensions,
    inputTokens: usage.input,
    providerRequestId: requestId,
  });
}
