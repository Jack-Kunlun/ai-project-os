import type { AiOperation, AiProviderConnection } from "@prisma/client";
import { readCredentialSecret } from "@/lib/credential-vault";

const REQUEST_TIMEOUT_MS = 45_000;
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
  | "AI_PROVIDER_EMBEDDING_UNSUPPORTED";

export class ProviderTransportError extends Error {
  constructor(
    readonly code: ProviderTransportErrorCode,
    readonly status: number = 502,
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
  path: "/chat/completions" | "/embeddings",
  body: Readonly<Record<string, unknown>>,
): Promise<Readonly<{ payload: unknown; requestId: string | null }>> {
  if (connection.status === "disabled") return fail("AI_PROVIDER_UNAVAILABLE", 409);
  const apiKey = await readCredentialSecret(connection.credentialId, "aiProvider");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
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
  const input = record.prompt_tokens;
  const output = record.completion_tokens;
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

export async function invokeEmbeddings(input: Readonly<{
  connection: RuntimeConnection;
  modelId: string;
  texts: readonly string[];
  expectedDimensions?: number | null;
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
  });
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

