import { AiRuntimeServiceError, throwAiRuntimeServiceError } from "./errors";
import {
  getIssuedOpenAiEmbeddingPlanInputs,
  verifyOpenAiEmbeddingsResponse,
  type OpenAiEmbeddingsTransportPlan,
  type VerifiedOpenAiEmbeddingsResponse,
} from "./openai-embeddings-contract";
import { getIssuedOpenAiAutoExtractPlanSources } from "./openai-responses-contract";
import type { OpenAiResponsesTransportPlan } from "./openai-responses-contract";
import {
  inspectOpenAiAutoExtractResponse,
  type VerifiedOpenAiAutoExtractResponse,
} from "./openai-responses-output";
import type { ProviderResultInput } from "./types";

export const OPENAI_CREDENTIAL_CONTRACT_VERSION =
  "openai-credential:v1" as const;
export const OPENAI_HTTP_TRANSPORT_VERSION =
  "openai-http-transport:v1" as const;

const API_KEY_PATTERN = /^sk-[A-Za-z0-9._-]{17,509}$/;
const PROVIDER_REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,512}$/;
const SECRET_LIKE_PATTERN =
  /(https?:\/\/|api[-_]?key|bearer|password|secret|token|sk-[a-z0-9])/i;
const JSON_CONTENT_TYPE_PATTERN = /^application\/json(?:\s*;|$)/i;
const MAX_RESPONSES_BODY_BYTES = 1_048_576;
const MAX_EMBEDDINGS_BODY_BYTES = 16_777_216;

type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;
type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface OpenAiCredentialHandle {
  readonly contractVersion: typeof OPENAI_CREDENTIAL_CONTRACT_VERSION;
  readonly provider: "openai";
}

export interface ExecuteOpenAiAutoExtractOptions {
  fetchImplementation?: FetchImplementation;
}

export type ExecuteOpenAiEmbeddingsOptions = ExecuteOpenAiAutoExtractOptions;

export interface OpenAiAutoExtractTransportResult {
  transportVersion: typeof OPENAI_HTTP_TRANSPORT_VERSION;
  providerResult: ProviderResultInput;
  verifiedResponse: VerifiedOpenAiAutoExtractResponse | null;
}

export interface OpenAiEmbeddingsTransportResult {
  transportVersion: typeof OPENAI_HTTP_TRANSPORT_VERSION;
  providerResult: ProviderResultInput;
  verifiedResponse: VerifiedOpenAiEmbeddingsResponse | null;
}

type JsonPostOutcome =
  | {
      kind: "json";
      rawResponse: unknown;
      providerRequestId: string | undefined;
    }
  | {
      kind: "provider_result";
      providerResult: ProviderResultInput;
    };

const credentialValues = new WeakMap<object, string>();

function invalidInput(): never {
  return throwAiRuntimeServiceError("AI_INVALID_OPERATION_KEY_INPUT");
}

function providerDisabled(): never {
  return throwAiRuntimeServiceError("AI_PROVIDER_DISABLED");
}

function isSafeApiKey(value: unknown): value is string {
  return typeof value === "string" && API_KEY_PATTERN.test(value);
}

function resolveCredential(value: unknown): string {
  if (typeof value !== "object" || value === null) {
    providerDisabled();
  }
  const apiKey = credentialValues.get(value);
  if (apiKey === undefined) {
    providerDisabled();
  }
  return apiKey;
}

/**
 * Loads an API key into a non-serializable, in-memory handle. The key is never
 * placed on an enumerable object field or returned by this module.
 */
export function loadOpenAiCredential(
  environment: RuntimeEnvironment = process.env,
): OpenAiCredentialHandle | null {
  const apiKey = environment.OPENAI_API_KEY;
  if (!isSafeApiKey(apiKey)) {
    return null;
  }
  const handle = Object.freeze({
    contractVersion: OPENAI_CREDENTIAL_CONTRACT_VERSION,
    provider: "openai" as const,
  });
  credentialValues.set(handle, apiKey);
  return handle;
}

export function isOpenAiCredentialConfigured(
  environment: RuntimeEnvironment = process.env,
): boolean {
  return isSafeApiKey(environment.OPENAI_API_KEY);
}

function safeProviderRequestId(value: string | null): string | undefined {
  return value !== null &&
    PROVIDER_REQUEST_ID_PATTERN.test(value) &&
    !SECRET_LIKE_PATTERN.test(value)
    ? value
    : undefined;
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Provider error bodies are intentionally not inspected or logged.
  }
}

async function readJsonWithinLimit(
  response: Response,
  maximumBytes: number,
): Promise<unknown> {
  const contentType = response.headers.get("content-type");
  if (
    contentType === null ||
    !JSON_CONTENT_TYPE_PATTERN.test(contentType)
  ) {
    await discardBody(response);
    throw new AiRuntimeServiceError("AI_INVALID_PROVIDER_RESPONSE");
  }
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^[0-9]+$/.test(declaredLength)) {
      await discardBody(response);
      throw new AiRuntimeServiceError("AI_INVALID_PROVIDER_RESPONSE");
    }
    const parsedLength = Number(declaredLength);
    if (
      !Number.isSafeInteger(parsedLength) ||
      parsedLength < 0 ||
      parsedLength > maximumBytes
    ) {
      await discardBody(response);
      throw new AiRuntimeServiceError("AI_INVALID_PROVIDER_RESPONSE");
    }
  }
  if (response.body === null) {
    throw new AiRuntimeServiceError("AI_INVALID_PROVIDER_RESPONSE");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      if (!(result.value instanceof Uint8Array)) {
        throw new AiRuntimeServiceError("AI_INVALID_PROVIDER_RESPONSE");
      }
      totalBytes += result.value.byteLength;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > maximumBytes) {
        throw new AiRuntimeServiceError("AI_INVALID_PROVIDER_RESPONSE");
      }
      chunks.push(result.value);
    }
  } catch (error: unknown) {
    try {
      await reader.cancel();
    } catch {
      // The original safe classification remains authoritative.
    }
    throw error;
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch {
    throw new AiRuntimeServiceError("AI_INVALID_PROVIDER_RESPONSE");
  }
}

function withProviderRequestId(
  providerResult: ProviderResultInput,
  providerRequestId: string | undefined,
): ProviderResultInput {
  if (providerRequestId === undefined) {
    return providerResult;
  }
  return { ...providerResult, providerRequestId } as ProviderResultInput;
}

function autoExtractTransportResult(
  providerResult: ProviderResultInput,
  verifiedResponse: VerifiedOpenAiAutoExtractResponse | null,
): OpenAiAutoExtractTransportResult {
  return Object.freeze({
    transportVersion: OPENAI_HTTP_TRANSPORT_VERSION,
    providerResult: Object.freeze(providerResult),
    verifiedResponse,
  });
}

function embeddingsTransportResult(
  providerResult: ProviderResultInput,
  verifiedResponse: VerifiedOpenAiEmbeddingsResponse | null,
): OpenAiEmbeddingsTransportResult {
  return Object.freeze({
    transportVersion: OPENAI_HTTP_TRANSPORT_VERSION,
    providerResult: Object.freeze(providerResult),
    verifiedResponse,
  });
}

async function executeOpenAiJsonPost(
  plan: Readonly<{
    endpoint: string;
    method: "POST";
    redirect: "error";
    timeoutMs: number;
    body: unknown;
  }>,
  apiKey: string,
  fetchImplementation: FetchImplementation,
  maximumResponseBytes: number,
): Promise<JsonPostOutcome> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), plan.timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetchImplementation(plan.endpoint, {
        method: plan.method,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(plan.body),
        cache: "no-store",
        credentials: "omit",
        redirect: plan.redirect,
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      });
    } catch (error: unknown) {
      const kind =
        controller.signal.aborted ||
        (error instanceof DOMException && error.name === "TimeoutError")
          ? "timeout"
          : error instanceof DOMException && error.name === "AbortError"
            ? "abort"
            : "connection";
      return {
        kind: "provider_result",
        providerResult: { kind, sentAt: true },
      };
    }

    const providerRequestId = safeProviderRequestId(
      response.headers.get("x-request-id"),
    );
    if (!response.ok) {
      await discardBody(response);
      return {
        kind: "provider_result",
        providerResult: {
          kind: "http_error",
          httpStatus: response.status,
          ...(providerRequestId === undefined ? {} : { providerRequestId }),
        },
      };
    }

    try {
      return {
        kind: "json",
        rawResponse: await readJsonWithinLimit(
          response,
          maximumResponseBytes,
        ),
        providerRequestId,
      };
    } catch (error: unknown) {
      const kind = controller.signal.aborted
        ? "timeout"
        : error instanceof AiRuntimeServiceError
          ? "invalid_response"
          : "connection";
      return {
        kind: "provider_result",
        providerResult: {
          kind,
          sentAt: true,
          ...(providerRequestId === undefined ? {} : { providerRequestId }),
        },
      };
    }
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Performs exactly one fixed-origin Responses POST. It never retries or follows
 * redirects, and never reads error bodies, logs payloads or returns raw JSON.
 */
export async function executeOpenAiAutoExtractTransport(
  plan: OpenAiResponsesTransportPlan,
  credential: OpenAiCredentialHandle,
  options: ExecuteOpenAiAutoExtractOptions = {},
): Promise<OpenAiAutoExtractTransportResult> {
  if (getIssuedOpenAiAutoExtractPlanSources(plan) === null) {
    invalidInput();
  }
  const apiKey = resolveCredential(credential);
  const fetchImplementation = options.fetchImplementation ?? globalThis.fetch;
  if (typeof fetchImplementation !== "function") {
    providerDisabled();
  }
  const outcome = await executeOpenAiJsonPost(
    plan,
    apiKey,
    fetchImplementation,
    MAX_RESPONSES_BODY_BYTES,
  );
  if (outcome.kind === "provider_result") {
    return autoExtractTransportResult(outcome.providerResult, null);
  }
  try {
    const inspected = inspectOpenAiAutoExtractResponse(
      plan,
      outcome.rawResponse,
    );
    return autoExtractTransportResult(
      withProviderRequestId(
        inspected.providerResult,
        outcome.providerRequestId,
      ),
      inspected.verifiedResponse,
    );
  } catch {
    return autoExtractTransportResult(
      {
        kind: "invalid_response",
        sentAt: true,
        ...(outcome.providerRequestId === undefined
          ? {}
          : { providerRequestId: outcome.providerRequestId }),
      },
      null,
    );
  }
}

/** Executes one fixed-origin Embeddings POST and returns only verified vectors. */
export async function executeOpenAiEmbeddingsTransport(
  plan: OpenAiEmbeddingsTransportPlan,
  credential: OpenAiCredentialHandle,
  options: ExecuteOpenAiEmbeddingsOptions = {},
): Promise<OpenAiEmbeddingsTransportResult> {
  if (getIssuedOpenAiEmbeddingPlanInputs(plan) === null) {
    invalidInput();
  }
  const apiKey = resolveCredential(credential);
  const fetchImplementation = options.fetchImplementation ?? globalThis.fetch;
  if (typeof fetchImplementation !== "function") {
    providerDisabled();
  }
  const outcome = await executeOpenAiJsonPost(
    plan,
    apiKey,
    fetchImplementation,
    MAX_EMBEDDINGS_BODY_BYTES,
  );
  if (outcome.kind === "provider_result") {
    return embeddingsTransportResult(outcome.providerResult, null);
  }
  try {
    const verifiedResponse = verifyOpenAiEmbeddingsResponse(
      plan,
      outcome.rawResponse,
    );
    return embeddingsTransportResult(
      {
        kind: "completed",
        ...(outcome.providerRequestId === undefined
          ? {}
          : { providerRequestId: outcome.providerRequestId }),
        usage: verifiedResponse.usage,
      },
      verifiedResponse,
    );
  } catch {
    return embeddingsTransportResult(
      {
        kind: "invalid_response",
        sentAt: true,
        ...(outcome.providerRequestId === undefined
          ? {}
          : { providerRequestId: outcome.providerRequestId }),
      },
      null,
    );
  }
}
