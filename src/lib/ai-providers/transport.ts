import type { AiOperation, AiProviderConnection } from "@prisma/client";
import { CredentialVaultError, readCredentialSecret } from "@/lib/credential-vault";
import { prepareModelProviderFetch } from "@/lib/model-provider-http";

/** Upper bound used for one provider HTTP request when no earlier deadline applies. */
export const PROVIDER_REQUEST_TIMEOUT_MS = 45_000;
/**
 * Interactive transaction budget for the manual provider connectivity test.
 * It must outlive the single shared provider probe deadline by a bounded
 * amount so the membership lock stays held through the final CAS write.
 */
export const PROVIDER_CONNECTION_TEST_TRANSACTION_TIMEOUT_MS = PROVIDER_REQUEST_TIMEOUT_MS + 10_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_PROVIDER_ERROR_BYTES = 16 * 1024;
const PROVIDER_ERROR_READ_TIMEOUT_MS = 500;
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
    /** The HTTP status received from the provider, if any. */
    readonly providerHttpStatus: number | null = null,
    /** True only for an allowlisted structured quota/balance rejection. */
    readonly providerQuotaExceeded = false,
    /** True only for an allowlisted explicit rejection before content or usage arrived. */
    readonly providerRejectedBeforeOutput = false,
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
  outputTruncated?: boolean;
}>;

export type EmbeddingResult = Readonly<{
  vectors: readonly (readonly number[])[];
  dimensions: number;
  inputTokens: number;
  usageKnown: boolean;
  providerRequestId: string | null;
}>;

export type VisionUsageObservation = Readonly<{
  inputTokens: number;
  outputTokens: number;
  usageKnown: boolean;
  providerRequestId: string | null;
}>;

type RuntimeConnection = Pick<
  AiProviderConnection,
  "id" | "kind" | "baseUrl" | "credentialId" | "status"
> & Readonly<{
  /** In-memory credential used only by the unsaved draft probe path. */
  apiKey?: string;
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

function fail(code: ProviderTransportErrorCode, status = 502, responseReceived = false,
  providerHttpStatus: number | null = null, providerQuotaExceeded = false, providerRejectedBeforeOutput = false): never {
  throw new ProviderTransportError(code, status, true, responseReceived, providerHttpStatus,
    providerQuotaExceeded, providerRejectedBeforeOutput);
}

function safeRequestId(response: Response): string | null {
  const value = response.headers.get("x-request-id") ?? response.headers.get("request-id");
  return value !== null && /^[\x20-\x7e]{1,256}$/.test(value) ? value : null;
}

function isAbortError(error: unknown): boolean {
  return (error instanceof DOMException && error.name === "AbortError") ||
    (typeof error === "object" && error !== null && "name" in error && error.name === "AbortError");
}

function cancelResponseBody(response: Response): void {
  if (response.body === null) return;
  try {
    // Start stream cancellation without waiting on an arbitrary underlying
    // cancel hook; cleanup must not delay or replace the classified error.
    void response.body.cancel().catch(() => {});
  } catch {
    // Cancellation is best effort. The safe provider classification wins.
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const lengthHeader = response.headers.get("content-length");
  if (lengthHeader !== null) {
    const length = Number(lengthHeader);
    if (!Number.isFinite(length) || length < 0 || length > MAX_RESPONSE_BYTES) {
      cancelResponseBody(response);
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

async function readProviderErrorJson(response: Response): Promise<unknown | null> {
  const type = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!type.includes("application/json") && !type.includes("+json")) {
    cancelResponseBody(response);
    return null;
  }
  const lengthHeader = response.headers.get("content-length");
  if (lengthHeader !== null) {
    const length = Number(lengthHeader);
    if (!Number.isFinite(length) || length < 0 || length > MAX_PROVIDER_ERROR_BYTES) {
      cancelResponseBody(response);
      return null;
    }
  }
  if (response.body === null) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const deadline = Date.now() + PROVIDER_ERROR_READ_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("PROVIDER_ERROR_BODY_TIMEOUT");
      const next = await Promise.race([
        reader.read(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("PROVIDER_ERROR_BODY_TIMEOUT")), remaining);
        }),
      ]);
      if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_PROVIDER_ERROR_BYTES) {
        void reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(next.value);
    }
  } catch {
    void reader.cancel().catch(() => {});
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    try { reader.releaseLock(); } catch { /* A failed bounded read remains a generic provider rejection. */ }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown; }
  catch { return null; }
}

function structuredProviderError(payload: unknown, eventName?: string): Record<string, unknown> | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const error = record.error;
  if (typeof error === "object" && error !== null && !Array.isArray(error)) return error as Record<string, unknown>;
  return eventName === "error" ? record : null;
}

function hasAllowlistedStructuredCode(payload: unknown, allowedCodes: readonly string[], eventName?: string): boolean {
  const record = structuredProviderError(payload, eventName);
  if (record === null) return false;
  const allowed = new Set(allowedCodes);
  return [record.code, record.type].some(value => typeof value === "string" && allowed.has(value.toLowerCase()));
}

function hasAllowlistedQuotaCode(payload: unknown, eventName?: string): boolean {
  return hasAllowlistedStructuredCode(payload,
    ["insufficient_quota", "billing_hard_limit_reached", "credit_balance_exhausted"], eventName);
}

function mapStructuredStreamError(payload: unknown, eventName: string, beforeOutput: boolean): never {
  if (hasAllowlistedQuotaCode(payload, eventName)) {
    return fail("AI_PROVIDER_REJECTED", 402, true, 200, true, beforeOutput);
  }
  if (hasAllowlistedStructuredCode(payload, ["rate_limit_exceeded", "ai_provider_rate_limited"], eventName)) {
    return fail("AI_PROVIDER_RATE_LIMITED", 429, true, 200, false, beforeOutput);
  }
  if (hasAllowlistedStructuredCode(payload, ["ai_provider_auth_failed"], eventName)) {
    return fail("AI_PROVIDER_AUTH_FAILED", 422, true, 200, false, beforeOutput);
  }
  return fail("AI_PROVIDER_UNAVAILABLE", 502, true, 200);
}

async function mapHttpError(status: number, kind: AiProviderConnection["kind"], response: Response): Promise<never> {
  let quotaExceeded = false;
  if (kind === "deepseek" && status === 402) {
    quotaExceeded = true;
    cancelResponseBody(response);
  } else if (kind === "openai" && (status === 402 || status === 429)) {
    quotaExceeded = hasAllowlistedQuotaCode(await readProviderErrorJson(response));
  } else if (!quotaExceeded) {
    cancelResponseBody(response);
  }
  if (quotaExceeded) return fail("AI_PROVIDER_REJECTED", status, true, status, true);
  if (status === 401 || status === 403) return fail("AI_PROVIDER_AUTH_FAILED", 422, true, status);
  if (status === 429) return fail("AI_PROVIDER_RATE_LIMITED", 429, true, status);
  if (status >= 400 && status < 500) return fail("AI_PROVIDER_REJECTED", 422, true, status);
  return fail("AI_PROVIDER_UNAVAILABLE", 502, true, status);
}

async function providerPost(
  connection: RuntimeConnection,
  path: "/chat/completions" | "/embeddings" | "/responses",
  body: Readonly<Record<string, unknown>>,
  absoluteDeadlineAt?: Date,
  onVisionUsage?: (usage: VisionUsageObservation) => void,
  externalSignal?: AbortSignal,
): Promise<Readonly<{ payload: unknown; requestId: string | null }>> {
  if (connection.status === "disabled") throw new ProviderTransportError("AI_PROVIDER_UNAVAILABLE", 409, false);
  const remaining = absoluteDeadlineAt === undefined
    ? PROVIDER_REQUEST_TIMEOUT_MS
    : absoluteDeadlineAt.getTime() - Date.now();
  if (remaining <= 0) throw new ProviderTransportError("AI_PROVIDER_TIMEOUT", 504, false);
  const endpoint = `${connection.baseUrl}${path}`;
  let openAiProxyFetch: ReturnType<typeof prepareModelProviderFetch> = undefined;
  if (connection.kind === "openai") {
    try {
      // Validate the root-only proxy setting before credential or dispatch
      // fences can mark this OpenAI request as sent.
      openAiProxyFetch = prepareModelProviderFetch(endpoint);
    } catch {
      throw new ProviderTransportError("AI_PROVIDER_UNAVAILABLE", 409, false);
    }
  }
  await runProviderBoundary(connection.onBeforeCredentialRead);
  let apiKey: string;
  if (connection.apiKey !== undefined) {
    if (connection.apiKey.trim().length === 0) throw new ProviderTransportError("AI_PROVIDER_UNAVAILABLE", 409, false);
    apiKey = connection.apiKey;
  } else {
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
  }
  const remainingAfterCredential = absoluteDeadlineAt === undefined
    ? PROVIDER_REQUEST_TIMEOUT_MS
    : absoluteDeadlineAt.getTime() - Date.now();
  if (remainingAfterCredential <= 0) {
    throw new ProviderTransportError("AI_PROVIDER_TIMEOUT", 504, false);
  }
  if (externalSignal?.aborted) throw new ProviderTransportError("AI_PROVIDER_UNAVAILABLE", 409, false);
  await runProviderBoundary(connection.onBeforeRequest);
  if (externalSignal?.aborted) throw new ProviderTransportError("AI_PROVIDER_UNAVAILABLE", 409, false);
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort();
  externalSignal?.addEventListener("abort", abortFromCaller, { once: true });
  if (externalSignal?.aborted) abortFromCaller();
  const timeout = setTimeout(() => controller.abort(), Math.min(PROVIDER_REQUEST_TIMEOUT_MS, remainingAfterCredential));
  let responseReceived = false;
  try {
    const response = await (openAiProxyFetch ?? fetch)(endpoint, {
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
    responseReceived = true;
    const requestId = safeRequestId(response);
    if (!response.ok) {
      return await mapHttpError(response.status, connection.kind, response);
    }
    const payload = await readBoundedJson(response);
    if (onVisionUsage !== undefined && typeof payload === "object" && payload !== null) {
      const usage = usageCounts(payload as Record<string, unknown>);
      onVisionUsage(Object.freeze({ inputTokens: usage.input, outputTokens: usage.output, usageKnown: usage.known, providerRequestId: requestId }));
    }
    if (absoluteDeadlineAt !== undefined && absoluteDeadlineAt.getTime() <= Date.now()) {
      return fail("AI_PROVIDER_TIMEOUT", 504, true);
    }
    return Object.freeze({ payload, requestId });
  } catch (error) {
    if (error instanceof ProviderTransportError) throw error;
    if (controller.signal.aborted || isAbortError(error)) {
      return fail("AI_PROVIDER_TIMEOUT", 504, responseReceived);
    }
    return fail("AI_PROVIDER_UNAVAILABLE", 502, responseReceived);
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", abortFromCaller);
  }
}

type StreamedChatResult = Readonly<{
  content: string;
  inputTokens: number;
  outputTokens: number;
  usageKnown: boolean;
  outputTruncated: boolean;
}>;

/**
 * Read a bounded OpenAI-compatible SSE chat completion. Only delta.content is
 * exposed to callers; reasoning and tool-call fields stay inside transport.
 */
async function providerPostStream(
  connection: RuntimeConnection,
  body: Readonly<Record<string, unknown>>,
  absoluteDeadlineAt: Date | undefined,
  onContentDelta: (delta: string) => void | Promise<void>,
  onUsage: ((usage: VisionUsageObservation) => void | Promise<void>) | undefined,
  externalSignal?: AbortSignal,
): Promise<Readonly<{ result: StreamedChatResult; requestId: string | null }>> {
  if (connection.status === "disabled") throw new ProviderTransportError("AI_PROVIDER_UNAVAILABLE", 409, false);
  const remaining = absoluteDeadlineAt === undefined
    ? PROVIDER_REQUEST_TIMEOUT_MS
    : absoluteDeadlineAt.getTime() - Date.now();
  if (remaining <= 0) throw new ProviderTransportError("AI_PROVIDER_TIMEOUT", 504, false);
  const endpoint = `${connection.baseUrl}/chat/completions`;
  let openAiProxyFetch: ReturnType<typeof prepareModelProviderFetch> = undefined;
  if (connection.kind === "openai") {
    try {
      openAiProxyFetch = prepareModelProviderFetch(endpoint);
    } catch {
      throw new ProviderTransportError("AI_PROVIDER_UNAVAILABLE", 409, false);
    }
  }
  await runProviderBoundary(connection.onBeforeCredentialRead);
  let apiKey: string;
  if (connection.apiKey !== undefined) {
    if (connection.apiKey.trim().length === 0) throw new ProviderTransportError("AI_PROVIDER_UNAVAILABLE", 409, false);
    apiKey = connection.apiKey;
  } else {
    try {
      apiKey = await readCredentialSecretWithDeadline(
        connection.credentialId,
        absoluteDeadlineAt,
        connection.credentialSecretFingerprint,
      );
    } catch (error) {
      if (error instanceof CredentialVaultError) {
        throw new ProviderTransportError("AI_PROVIDER_UNAVAILABLE", 409, false);
      }
      throw error;
    }
  }
  const remainingAfterCredential = absoluteDeadlineAt === undefined
    ? PROVIDER_REQUEST_TIMEOUT_MS
    : absoluteDeadlineAt.getTime() - Date.now();
  if (remainingAfterCredential <= 0) throw new ProviderTransportError("AI_PROVIDER_TIMEOUT", 504, false);
  if (externalSignal?.aborted) throw new ProviderTransportError("AI_PROVIDER_UNAVAILABLE", 409, false);
  await runProviderBoundary(connection.onBeforeRequest);
  if (externalSignal?.aborted) throw new ProviderTransportError("AI_PROVIDER_UNAVAILABLE", 409, false);

  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timeoutReject: ((error: ProviderTransportError) => void) | undefined;
  const timeoutFailure = new Promise<never>((_, reject) => { timeoutReject = reject; });
  let timedOut = false;
  let responseReceived = false;
  let sawDone = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
    if (reader !== undefined) void reader.cancel().catch(() => {});
    timeoutReject?.(new ProviderTransportError("AI_PROVIDER_TIMEOUT", 504, true, responseReceived));
  }, Math.min(PROVIDER_REQUEST_TIMEOUT_MS, remainingAfterCredential));
  const abortFromCaller = () => {
    timedOut = true;
    controller.abort();
    if (reader !== undefined) void reader.cancel().catch(() => {});
    timeoutReject?.(new ProviderTransportError("AI_PROVIDER_TIMEOUT", 504, true, responseReceived));
  };
  externalSignal?.addEventListener("abort", abortFromCaller, { once: true });
  if (externalSignal?.aborted) abortFromCaller();
  let callbackFailed = false;
  let callbackFailure: unknown;
  const deliverContent = async (value: string) => {
    try {
      await Promise.race([Promise.resolve().then(() => onContentDelta(value)), timeoutFailure]);
    } catch (error) {
      if (timedOut) throw error;
      callbackFailed = true;
      callbackFailure = error;
      throw error;
    }
  };
  const deliverUsage = async (usage: VisionUsageObservation) => {
    if (onUsage === undefined) return;
    try {
      await Promise.race([Promise.resolve().then(() => onUsage(usage)), timeoutFailure]);
    } catch (error) {
      if (timedOut) throw error;
      callbackFailed = true;
      callbackFailure = error;
      throw error;
    }
  };

  try {
    const responsePromise = (openAiProxyFetch ?? fetch)(endpoint, {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body: JSON.stringify(body),
    });
    const response = await Promise.race([responsePromise, timeoutFailure]);
    responseReceived = true;
    const requestId = safeRequestId(response);
    if (!response.ok) {
      return await mapHttpError(response.status, connection.kind, response);
    }
    if (response.body === null || !response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
      cancelResponseBody(response);
      return fail("AI_PROVIDER_INVALID_RESPONSE", 502, true);
    }
    reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const chunks: string[] = [];
    let contentLength = 0;
    let receivedBytes = 0;
    let line = "";
    let skipLf = false;
    let dataLines: string[] = [];
    let eventName = "";
    let finishReason: "stop" | "length" | null = null;
    let inputTokens = 0;
    let outputTokens = 0;
    let usageKnown = false;
    let usageFinalSeen = false;
    let usageFrameSeen = false;
    let dataFrameSeen = false;

    const processData = async (data: string) => {
      if (sawDone) return fail("AI_PROVIDER_INVALID_RESPONSE", 502, true);
      if (data === "[DONE]") {
        if (finishReason === null) return fail("AI_PROVIDER_INVALID_RESPONSE", 502, true);
        sawDone = true;
        return;
      }
      if (usageFinalSeen) return fail("AI_PROVIDER_INVALID_RESPONSE", 502, true);
      let payload: unknown;
      try { payload = JSON.parse(data) as unknown; } catch { return fail("AI_PROVIDER_INVALID_RESPONSE", 502, true); }
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return fail("AI_PROVIDER_INVALID_RESPONSE", 502, true);
      const record = payload as Record<string, unknown>;
      const frameHasUsage = record.usage !== undefined && record.usage !== null;
      if (frameHasUsage) usageFrameSeen = true;
      // Earlier frames may contain reasoning or other billable output we do not render.
      const firstFrameRejection = !dataFrameSeen && !usageFrameSeen && record.choices === undefined;
      dataFrameSeen = true;
      if (eventName === "error" || record.error !== undefined && record.error !== null) {
        return mapStructuredStreamError(payload, eventName, firstFrameRejection);
      }
      if (frameHasUsage) {
        const counts = usageCounts(record);
        inputTokens = counts.input;
        outputTokens = counts.output;
        usageKnown = counts.known;
      }
      const finishWasAlreadySeen = finishReason !== null;
      const choices = record.choices;
      if (!Array.isArray(choices)) return fail("AI_PROVIDER_INVALID_RESPONSE", 502, true);
      if (choices.length === 0) {
        if (!frameHasUsage) return fail("AI_PROVIDER_INVALID_RESPONSE", 502, true);
        const usageIsFinal = usageKnown && finishWasAlreadySeen;
        usageFinalSeen = usageIsFinal;
        await deliverUsage(Object.freeze({ inputTokens, outputTokens, usageKnown: usageIsFinal, providerRequestId: requestId }));
        return;
      }
      if (choices.length !== 1) return fail("AI_PROVIDER_INVALID_RESPONSE", 502, true);
      const choice = choices[0];
      if (typeof choice !== "object" || choice === null || Array.isArray(choice)) return fail("AI_PROVIDER_INVALID_RESPONSE", 502, true);
      const choiceRecord = choice as Record<string, unknown>;
      if (choiceRecord.index !== undefined && choiceRecord.index !== 0) return fail("AI_PROVIDER_INVALID_RESPONSE", 502, true);
      const reason = choiceRecord.finish_reason;
      let frameHasFinishReason = false;
      if (reason !== undefined && reason !== null) {
        if (reason !== "stop" && reason !== "length") return fail("AI_PROVIDER_INVALID_RESPONSE", 502, true);
        if (finishReason !== null && finishReason !== reason) return fail("AI_PROVIDER_INVALID_RESPONSE", 502, true);
        finishReason = reason;
        frameHasFinishReason = true;
      }
      const delta = choiceRecord.delta;
      if (delta !== undefined && delta !== null) {
        if (typeof delta !== "object" || Array.isArray(delta)) return fail("AI_PROVIDER_INVALID_RESPONSE", 502, true);
        const deltaRecord = delta as Record<string, unknown>;
        if (deltaRecord.role !== undefined && deltaRecord.role !== "assistant") return fail("AI_PROVIDER_INVALID_RESPONSE", 502, true);
        const text = deltaRecord.content;
        if (text !== undefined && text !== null) {
          if (typeof text !== "string") return fail("AI_PROVIDER_INVALID_RESPONSE", 502, true);
          contentLength += text.length;
          if (contentLength > 1_000_000) return fail("AI_PROVIDER_RESPONSE_TOO_LARGE", 502, true);
          chunks.push(text);
          await deliverContent(text);
        }
      }
      if (frameHasUsage) {
        const usageIsFinal = usageKnown && frameHasFinishReason;
        usageFinalSeen = usageIsFinal;
        await deliverUsage(Object.freeze({ inputTokens, outputTokens, usageKnown: usageIsFinal, providerRequestId: requestId }));
      }
    };

    const processLine = async (value: string) => {
      if (value === "") {
        if (dataLines.length > 0) await processData(dataLines.join("\n"));
        dataLines = [];
        eventName = "";
        return;
      }
      if (value.startsWith(":")) return;
      const separator = value.indexOf(":");
      const field = separator === -1 ? value : value.slice(0, separator);
      const fieldValue = separator === -1 ? "" : value.slice(separator + 1).replace(/^ /u, "");
      if (field === "data") dataLines.push(fieldValue);
      else if (field === "event") eventName = fieldValue;
    };

    while (true) {
      const readPromise = reader.read();
      const next = await Promise.race([readPromise, timeoutFailure]);
      if (timedOut) return fail("AI_PROVIDER_TIMEOUT", 504, true);
      if (next.done) break;
      receivedBytes += next.value.byteLength;
      if (receivedBytes > MAX_RESPONSE_BYTES) return fail("AI_PROVIDER_RESPONSE_TOO_LARGE", 502, true);
      let decoded: string;
      try { decoded = decoder.decode(next.value, { stream: true }); } catch { return fail("AI_PROVIDER_INVALID_RESPONSE", 502, true); }
      for (const character of decoded) {
        if (skipLf) {
          skipLf = false;
          if (character === "\n") continue;
        }
        if (character === "\r") {
          await processLine(line);
          line = "";
          skipLf = true;
          if (sawDone) break;
        } else if (character === "\n") {
          await processLine(line);
          line = "";
          if (sawDone) break;
        } else {
          line += character;
        }
      }
      if (sawDone) break;
    }
    if (!sawDone) {
      try {
        const finalText = decoder.decode();
        if (finalText.length > 0) line += finalText;
      } catch { return fail("AI_PROVIDER_INVALID_RESPONSE", 502, true); }
      if (line !== "" || dataLines.length > 0 || !sawDone || finishReason === null) return fail("AI_PROVIDER_INVALID_RESPONSE", 502, true);
    }
    return Object.freeze({
      requestId,
      result: Object.freeze({
        content: chunks.join(""),
        inputTokens,
        outputTokens,
        usageKnown: usageFinalSeen,
        outputTruncated: finishReason === "length",
      }),
    });
  } catch (error) {
    if (reader !== undefined) void reader.cancel().catch(() => {});
    if (callbackFailed) throw callbackFailure;
    if (error instanceof ProviderTransportError) throw error;
    if (controller.signal.aborted || isAbortError(error)) return fail("AI_PROVIDER_TIMEOUT", 504, responseReceived);
    return fail("AI_PROVIDER_UNAVAILABLE", 502, responseReceived);
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", abortFromCaller);
    if (reader !== undefined) {
      if (sawDone) {
        try { void reader.cancel().catch(() => {}); } catch { /* A completed terminal frame still wins. */ }
      }
      reader.releaseLock();
    }
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

function chatModelParameters(connection: RuntimeConnection, modelId: string, maxOutputTokens: number, temperature: number, disableThinking?: boolean) {
  if (connection.kind === "openai" && /^gpt-6\.2-(sol|astra)(?:$|-)/u.test(modelId)) {
    return { max_completion_tokens: maxOutputTokens, reasoning_effort: "low" };
  }
  if (connection.kind === "qwen") {
    if (disableThinking && /^(?:qwen4-max|qwen3\.8-(?:max|flash)|qwen3\.7-plus)(?:$|-)/u.test(modelId)) {
      return { max_tokens: maxOutputTokens, temperature, enable_thinking: false };
    }
    if (/^(?:qwen4-max|qwen3\.8-(?:max|flash))(?:$|-)/u.test(modelId)) {
      return { max_tokens: maxOutputTokens, temperature, preserve_thinking: false };
    }
  }
  return { max_tokens: maxOutputTokens, temperature };
}

export async function invokeChatCompletion(input: Readonly<{
  connection: RuntimeConnection;
  operation: Exclude<AiOperation, "embedding">;
  modelId: string;
  messages: readonly ChatMessage[];
  maxOutputTokens: number;
  temperature?: number;
  /** Disable provider reasoning for bounded probes or bounded extraction calls. */
  disableThinking?: boolean;
  /** Request a JSON object response from providers that support JSON mode. */
  jsonOutput?: boolean;
  absoluteDeadlineAt?: Date;
  /** Optional caller cancellation; omitted consumers keep existing behavior. */
  signal?: AbortSignal;
  /** Optional raw assistant text deltas for an explicitly streamed request. */
  onContentDelta?: (delta: string) => void | Promise<void>;
  /** Latest provider usage metadata received during a streamed request. */
  onUsage?: (usage: VisionUsageObservation) => void | Promise<void>;
}>): Promise<ChatResult> {
  const body = {
    model: input.modelId,
    messages: input.messages,
    ...chatModelParameters(input.connection, input.modelId, input.maxOutputTokens, input.temperature ?? 0, input.disableThinking),
    stream: input.onContentDelta !== undefined,
    ...(input.onContentDelta !== undefined && input.connection.kind !== "glm" ? { stream_options: { include_usage: true } } : {}),
    ...(input.connection.kind === "deepseek" && input.disableThinking ? { thinking: { type: "disabled" } } : {}),
    ...(input.connection.kind === "deepseek" && input.jsonOutput ? { response_format: { type: "json_object" } } : {}),
  };
  if (input.onContentDelta !== undefined) {
    const streamed = await providerPostStream(input.connection, body, input.absoluteDeadlineAt, input.onContentDelta, input.onUsage, input.signal);
    const { result, requestId } = streamed;
    if (result.content.trim().length === 0) return fail("AI_PROVIDER_INVALID_RESPONSE", 502, true);
    return Object.freeze({
      content: result.content,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      usageKnown: result.usageKnown,
      providerRequestId: requestId,
      outputTruncated: result.outputTruncated,
    });
  }
  const { payload, requestId } = await providerPost(input.connection, "/chat/completions", { ...body, stream: false }, input.absoluteDeadlineAt, undefined, input.signal);
  if (typeof payload !== "object" || payload === null) return fail("AI_PROVIDER_INVALID_RESPONSE", 502, true);
  const record = payload as Record<string, unknown>;
  const choices = record.choices;
  if (!Array.isArray(choices) || choices.length === 0) return fail("AI_PROVIDER_INVALID_RESPONSE", 502, true);
  const first = choices[0];
  if (typeof first !== "object" || first === null) return fail("AI_PROVIDER_INVALID_RESPONSE", 502, true);
  const choice = first as Record<string, unknown>;
  const outputTruncated = choice.finish_reason === "length";
  const message = choice.message;
  if (typeof message !== "object" || message === null) return fail("AI_PROVIDER_INVALID_RESPONSE", 502, true);
  const responseContent = (message as Record<string, unknown>).content;
  const acceptsEmptyTruncatedJson = input.connection.kind === "deepseek" && input.jsonOutput === true && outputTruncated;
  const content = responseContent === null && acceptsEmptyTruncatedJson ? "" : responseContent;
  if (
    typeof content !== "string"
    || (content.trim().length === 0 && !acceptsEmptyTruncatedJson)
    || content.length > 1_000_000
  ) {
    return fail("AI_PROVIDER_INVALID_RESPONSE", 502, true);
  }
  const usage = usageCounts(record);
  return Object.freeze({
    content,
    inputTokens: usage.input,
    outputTokens: usage.output,
    usageKnown: usage.known,
    providerRequestId: requestId,
    outputTruncated,
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
  /** Disable provider reasoning only for bounded connectivity probes. */
  disableThinking?: boolean;
  absoluteDeadlineAt?: Date;
  /** Safe usage metadata exposed before response-content validation. */
  onUsage?: (usage: VisionUsageObservation) => void;
}>): Promise<ChatResult> {
  if (input.image.length === 0 || input.image.length > 10 * 1024 * 1024 || input.prompt.length < 1 || input.prompt.length > 8_000) {
    throw new ProviderTransportError("AI_PROVIDER_REJECTED", 400, false);
  }
  const dataUrl = `data:${input.mimeType};base64,${input.image.toString("base64")}`;
  if (input.connection.kind === "deepseek") {
    if (input.modelId !== "deepseek-flash" && input.modelId !== "deepseek-v4-flash-vision-exp") throw new ProviderTransportError("AI_PROVIDER_VISION_UNSUPPORTED", 422, false);
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
      ...(input.disableThinking ? { reasoning: { effort: "none" } } : {}),
    }, input.absoluteDeadlineAt, input.onUsage);
    if (typeof payload !== "object" || payload === null) return fail("AI_PROVIDER_INVALID_RESPONSE", 502, true);
    const record = payload as Record<string, unknown>;
    const usage = usageCounts(record);
    const content = responseText(record);
    if (content === null || content.length > 1_000_000) return fail("AI_PROVIDER_INVALID_RESPONSE", 502, true);
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
    ...chatModelParameters(input.connection, input.modelId, input.maxOutputTokens, 0, input.disableThinking),
    stream: false,
  }, input.absoluteDeadlineAt, input.onUsage);
  if (typeof payload !== "object" || payload === null) return fail("AI_PROVIDER_INVALID_RESPONSE", 502, true);
  const record = payload as Record<string, unknown>;
  const usage = usageCounts(record);
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
  const sendsDimensions = input.connection.kind !== "qwen" || /^(?:qwen3\.7-text-embedding(?:-flash)?|text-embedding-v[34])$/u.test(input.modelId);
  const { payload, requestId } = await providerPost(input.connection, "/embeddings", {
    model: input.modelId,
    input: input.texts,
    ...(sendsDimensions && input.expectedDimensions
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
