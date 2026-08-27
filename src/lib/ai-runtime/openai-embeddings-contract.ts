import { createHash } from "node:crypto";
import { throwAiRuntimeServiceError } from "./errors";
import type { SafeUsage } from "./types";

export const OPENAI_EMBEDDINGS_CONTRACT_VERSION =
  "openai-embeddings-contract:v1" as const;
export const OPENAI_EMBEDDINGS_PROFILE_VERSION =
  "openai-embeddings-profile:v1" as const;
export const OPENAI_EMBEDDINGS_ENDPOINT =
  "https://api.openai.com/v1/embeddings" as const;
export const OPENAI_EMBEDDING_DIMENSIONS = 1_536 as const;

const PROFILE_FIELDS = [
  "profileVersion",
  "providerFingerprint",
  "profileFingerprint",
  "modelId",
  "modelFingerprint",
  "processorEndpointFingerprint",
  "processorRegionFingerprint",
  "processorRetentionFingerprint",
  "maxInputBytes",
  "maxTotalInputBytes",
  "maxInputs",
  "dimensions",
  "timeoutMs",
] as const;
const REQUEST_FIELDS = ["runId", "operationKey", "inputs"] as const;
const INPUT_FIELDS = ["inputId", "content"] as const;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SECRET_LIKE_IDENTIFIER_PATTERN =
  /(api[-_]?key|bearer|password|secret|token|sk-)/i;
const UNSAFE_INPUT_CONTROL_PATTERN =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;

const MAX_PROFILE_INPUT_BYTES = 8_192;
const MAX_PROFILE_TOTAL_INPUT_BYTES = 256_000;
const MAX_PROFILE_INPUTS = 100;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;

function fingerprint(label: string): string {
  return createHash("sha256")
    .update(`${OPENAI_EMBEDDINGS_CONTRACT_VERSION}:${label}`, "utf8")
    .digest("hex");
}

export const OPENAI_EMBEDDINGS_PROVIDER_FINGERPRINT = fingerprint(
  "provider:openai",
);
export const OPENAI_EMBEDDINGS_ENDPOINT_FINGERPRINT = fingerprint(
  `endpoint:${OPENAI_EMBEDDINGS_ENDPOINT}`,
);
export const OPENAI_EMBEDDINGS_RETENTION_FINGERPRINT = fingerprint(
  "retention:no-request-state-field",
);

export interface OpenAiEmbeddingsProfile {
  profileVersion: typeof OPENAI_EMBEDDINGS_PROFILE_VERSION;
  providerFingerprint: string;
  profileFingerprint: string;
  modelId: string;
  modelFingerprint: string;
  processorEndpointFingerprint: string;
  processorRegionFingerprint: string;
  processorRetentionFingerprint: string;
  maxInputBytes: number;
  maxTotalInputBytes: number;
  maxInputs: number;
  dimensions: typeof OPENAI_EMBEDDING_DIMENSIONS;
  timeoutMs: number;
}

export interface OpenAiEmbeddingInput {
  inputId: string;
  content: string;
}

export interface OpenAiEmbeddingsRequest {
  runId: string;
  operationKey: string;
  inputs: readonly OpenAiEmbeddingInput[];
}

export type OpenAiEmbeddingsBody = Readonly<{
  model: string;
  input: readonly string[];
  encoding_format: "float";
  dimensions: typeof OPENAI_EMBEDDING_DIMENSIONS;
}>;

export type OpenAiEmbeddingsTransportPlan = Readonly<{
  contractVersion: typeof OPENAI_EMBEDDINGS_CONTRACT_VERSION;
  operation: "embedding";
  profileFingerprint: string;
  providerFingerprint: typeof OPENAI_EMBEDDINGS_PROVIDER_FINGERPRINT;
  modelFingerprint: string;
  processorEndpointFingerprint: typeof OPENAI_EMBEDDINGS_ENDPOINT_FINGERPRINT;
  processorRegionFingerprint: string;
  processorRetentionFingerprint: typeof OPENAI_EMBEDDINGS_RETENTION_FINGERPRINT;
  runId: string;
  operationKey: string;
  endpoint: typeof OPENAI_EMBEDDINGS_ENDPOINT;
  method: "POST";
  redirect: "error";
  timeoutMs: number;
  automaticRetry: false;
  maximumAttempts: 1;
  body: OpenAiEmbeddingsBody;
}>;

export interface VerifiedOpenAiEmbeddingVector {
  inputId: string;
  index: number;
  vector: readonly number[];
  vectorFingerprint: string;
}

export interface VerifiedOpenAiEmbeddingsResponse {
  contractVersion: typeof OPENAI_EMBEDDINGS_CONTRACT_VERSION;
  modelId: string;
  dimensions: typeof OPENAI_EMBEDDING_DIMENSIONS;
  usage: Readonly<SafeUsage>;
  vectors: readonly Readonly<VerifiedOpenAiEmbeddingVector>[];
  vectorSetFingerprint: string;
}

const issuedEmbeddingPlans = new WeakMap<
  object,
  readonly Readonly<OpenAiEmbeddingInput>[]
>();

function invalidInput(): never {
  return throwAiRuntimeServiceError("AI_INVALID_OPERATION_KEY_INPUT");
}

function invalidResponse(): never {
  return throwAiRuntimeServiceError("AI_INVALID_PROVIDER_RESPONSE");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  try {
    return Object.getPrototypeOf(value) === Object.prototype;
  } catch {
    return false;
  }
}

function hasExactDataFields(
  value: Record<string, unknown>,
  fields: readonly string[],
): boolean {
  try {
    const keys = Object.keys(value).sort();
    const expected = [...fields].sort();
    if (
      keys.length !== expected.length ||
      !keys.every((key, index) => key === expected[index])
    ) {
      return false;
    }
    return keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined && "value" in descriptor && descriptor.enumerable;
    });
  } catch {
    return false;
  }
}

function readDataField(
  value: Record<string, unknown>,
  field: string,
): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      invalidResponse();
    }
    return descriptor.value;
  } catch {
    invalidResponse();
  }
}

function invalidArray(responseError: boolean): never {
  return responseError ? invalidResponse() : invalidInput();
}

function dataArray(
  value: unknown,
  minimumLength: number,
  maximumLength: number,
  responseError: boolean,
): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    value.length < minimumLength ||
    value.length > maximumLength
  ) {
    invalidArray(responseError);
  }
  try {
    const keys = Object.keys(value);
    if (
      keys.length !== value.length ||
      !keys.every((key, index) => key === String(index))
    ) {
      invalidArray(responseError);
    }
    return keys.map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
        invalidArray(responseError);
      }
      return descriptor.value;
    });
  } catch {
    invalidArray(responseError);
  }
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function safeFingerprint(value: unknown): string {
  if (typeof value !== "string" || !FINGERPRINT_PATTERN.test(value)) {
    invalidInput();
  }
  return value;
}

function safeUuid(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    invalidInput();
  }
  return value;
}

function safeModelId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !MODEL_ID_PATTERN.test(value) ||
    /(^|[-_.])latest$/i.test(value) ||
    SECRET_LIKE_IDENTIFIER_PATTERN.test(value)
  ) {
    invalidInput();
  }
  return value;
}

function safePositiveInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    invalidInput();
  }
  return value as number;
}

function normalizeProfile(value: unknown): Readonly<OpenAiEmbeddingsProfile> {
  if (!isPlainRecord(value) || !hasExactDataFields(value, PROFILE_FIELDS)) {
    invalidInput();
  }
  if (
    value.profileVersion !== OPENAI_EMBEDDINGS_PROFILE_VERSION ||
    value.providerFingerprint !== OPENAI_EMBEDDINGS_PROVIDER_FINGERPRINT ||
    value.processorEndpointFingerprint !==
      OPENAI_EMBEDDINGS_ENDPOINT_FINGERPRINT ||
    value.processorRetentionFingerprint !==
      OPENAI_EMBEDDINGS_RETENTION_FINGERPRINT ||
    value.dimensions !== OPENAI_EMBEDDING_DIMENSIONS
  ) {
    invalidInput();
  }
  const maxInputBytes = safePositiveInteger(
    value.maxInputBytes,
    1,
    MAX_PROFILE_INPUT_BYTES,
  );
  const maxTotalInputBytes = safePositiveInteger(
    value.maxTotalInputBytes,
    maxInputBytes,
    MAX_PROFILE_TOTAL_INPUT_BYTES,
  );
  return Object.freeze({
    profileVersion: OPENAI_EMBEDDINGS_PROFILE_VERSION,
    providerFingerprint: OPENAI_EMBEDDINGS_PROVIDER_FINGERPRINT,
    profileFingerprint: safeFingerprint(value.profileFingerprint),
    modelId: safeModelId(value.modelId),
    modelFingerprint: safeFingerprint(value.modelFingerprint),
    processorEndpointFingerprint: OPENAI_EMBEDDINGS_ENDPOINT_FINGERPRINT,
    processorRegionFingerprint: safeFingerprint(value.processorRegionFingerprint),
    processorRetentionFingerprint: OPENAI_EMBEDDINGS_RETENTION_FINGERPRINT,
    maxInputBytes,
    maxTotalInputBytes,
    maxInputs: safePositiveInteger(value.maxInputs, 1, MAX_PROFILE_INPUTS),
    dimensions: OPENAI_EMBEDDING_DIMENSIONS,
    timeoutMs: safePositiveInteger(
      value.timeoutMs,
      MIN_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
    ),
  });
}

function normalizeInput(
  value: unknown,
  maximumBytes: number,
): Readonly<OpenAiEmbeddingInput> {
  if (!isPlainRecord(value) || !hasExactDataFields(value, INPUT_FIELDS)) {
    invalidInput();
  }
  if (
    typeof value.content !== "string" ||
    value.content.trim().length === 0 ||
    Buffer.byteLength(value.content, "utf8") > maximumBytes ||
    UNSAFE_INPUT_CONTROL_PATTERN.test(value.content) ||
    hasUnpairedSurrogate(value.content)
  ) {
    invalidInput();
  }
  return Object.freeze({
    inputId: safeUuid(value.inputId),
    content: value.content,
  });
}

function normalizeRequest(
  value: unknown,
  profile: Readonly<OpenAiEmbeddingsProfile>,
): Readonly<OpenAiEmbeddingsRequest> {
  if (!isPlainRecord(value) || !hasExactDataFields(value, REQUEST_FIELDS)) {
    invalidInput();
  }
  const inputs = dataArray(value.inputs, 1, profile.maxInputs, false)
    .map((input) => normalizeInput(input, profile.maxInputBytes))
    .sort((left, right) =>
      left.inputId < right.inputId ? -1 : left.inputId > right.inputId ? 1 : 0,
    );
  if (new Set(inputs.map((input) => input.inputId)).size !== inputs.length) {
    invalidInput();
  }
  let totalBytes = 0;
  for (const input of inputs) {
    totalBytes += Buffer.byteLength(input.content, "utf8");
    if (!Number.isSafeInteger(totalBytes) || totalBytes > profile.maxTotalInputBytes) {
      invalidInput();
    }
  }
  return Object.freeze({
    runId: safeUuid(value.runId),
    operationKey: safeFingerprint(value.operationKey),
    inputs: Object.freeze(inputs),
  });
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

export function buildOpenAiEmbeddingsTransportPlan(
  rawProfile: unknown,
  rawRequest: unknown,
): OpenAiEmbeddingsTransportPlan {
  const profile = normalizeProfile(rawProfile);
  const request = normalizeRequest(rawRequest, profile);
  const plan: OpenAiEmbeddingsTransportPlan = deepFreeze({
    contractVersion: OPENAI_EMBEDDINGS_CONTRACT_VERSION,
    operation: "embedding" as const,
    profileFingerprint: profile.profileFingerprint,
    providerFingerprint: OPENAI_EMBEDDINGS_PROVIDER_FINGERPRINT,
    modelFingerprint: profile.modelFingerprint,
    processorEndpointFingerprint: OPENAI_EMBEDDINGS_ENDPOINT_FINGERPRINT,
    processorRegionFingerprint: profile.processorRegionFingerprint,
    processorRetentionFingerprint: OPENAI_EMBEDDINGS_RETENTION_FINGERPRINT,
    runId: request.runId,
    operationKey: request.operationKey,
    endpoint: OPENAI_EMBEDDINGS_ENDPOINT,
    method: "POST" as const,
    redirect: "error" as const,
    timeoutMs: profile.timeoutMs,
    automaticRetry: false as const,
    maximumAttempts: 1 as const,
    body: {
      model: profile.modelId,
      input: request.inputs.map((input) => input.content),
      encoding_format: "float" as const,
      dimensions: OPENAI_EMBEDDING_DIMENSIONS,
    },
  });
  issuedEmbeddingPlans.set(plan, request.inputs);
  return plan;
}

export function getIssuedOpenAiEmbeddingPlanInputs(
  value: unknown,
): readonly Readonly<OpenAiEmbeddingInput>[] | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  return issuedEmbeddingPlans.get(value) ?? null;
}

function responseInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    invalidResponse();
  }
  return value as number;
}

function canonicalFloat32Vector(
  value: unknown,
): { vector: readonly number[]; fingerprint: string } {
  const rawVector = dataArray(
    value,
    OPENAI_EMBEDDING_DIMENSIONS,
    OPENAI_EMBEDDING_DIMENSIONS,
    true,
  );
  const bytes = Buffer.allocUnsafe(OPENAI_EMBEDDING_DIMENSIONS * 4);
  const vector = rawVector.map((component, index) => {
    if (typeof component !== "number" || !Number.isFinite(component)) {
      invalidResponse();
    }
    const float32 = Math.fround(component);
    if (!Number.isFinite(float32)) {
      invalidResponse();
    }
    bytes.writeFloatLE(float32, index * 4);
    return float32;
  });
  return {
    vector: Object.freeze(vector),
    fingerprint: createHash("sha256")
      .update(OPENAI_EMBEDDINGS_CONTRACT_VERSION, "utf8")
      .update(bytes)
      .digest("hex"),
  };
}

export function verifyOpenAiEmbeddingsResponse(
  plan: OpenAiEmbeddingsTransportPlan,
  rawResponse: unknown,
): VerifiedOpenAiEmbeddingsResponse {
  const inputs = getIssuedOpenAiEmbeddingPlanInputs(plan);
  if (inputs === null) {
    invalidInput();
  }
  if (!isPlainRecord(rawResponse)) {
    invalidResponse();
  }
  if (
    readDataField(rawResponse, "object") !== "list" ||
    readDataField(rawResponse, "model") !== plan.body.model
  ) {
    invalidResponse();
  }
  const rawData = dataArray(
    readDataField(rawResponse, "data"),
    inputs.length,
    inputs.length,
    true,
  );
  const vectorsByIndex = new Map<number, Readonly<VerifiedOpenAiEmbeddingVector>>();
  for (const rawItem of rawData) {
    if (!isPlainRecord(rawItem) || readDataField(rawItem, "object") !== "embedding") {
      invalidResponse();
    }
    const index = responseInteger(readDataField(rawItem, "index"));
    const input = inputs[index];
    if (input === undefined || vectorsByIndex.has(index)) {
      invalidResponse();
    }
    const { vector, fingerprint: vectorFingerprint } = canonicalFloat32Vector(
      readDataField(rawItem, "embedding"),
    );
    vectorsByIndex.set(
      index,
      Object.freeze({
        inputId: input.inputId,
        index,
        vector,
        vectorFingerprint,
      }),
    );
  }
  const vectors = Object.freeze(
    inputs.map((_, index) => {
      const vector = vectorsByIndex.get(index);
      if (vector === undefined) {
        invalidResponse();
      }
      return vector;
    }),
  );

  const rawUsage = readDataField(rawResponse, "usage");
  if (!isPlainRecord(rawUsage)) {
    invalidResponse();
  }
  const inputTokens = responseInteger(readDataField(rawUsage, "prompt_tokens"));
  const totalTokens = responseInteger(readDataField(rawUsage, "total_tokens"));
  if (totalTokens !== inputTokens) {
    invalidResponse();
  }
  const usage = Object.freeze({
    inputTokens,
    outputTokens: 0,
    requestCount: 1,
  });
  const vectorSetFingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        contractVersion: OPENAI_EMBEDDINGS_CONTRACT_VERSION,
        modelId: plan.body.model,
        dimensions: OPENAI_EMBEDDING_DIMENSIONS,
        vectors: vectors.map((vector) => ({
          inputId: vector.inputId,
          vectorFingerprint: vector.vectorFingerprint,
        })),
      }),
      "utf8",
    )
    .digest("hex");
  return Object.freeze({
    contractVersion: OPENAI_EMBEDDINGS_CONTRACT_VERSION,
    modelId: plan.body.model,
    dimensions: OPENAI_EMBEDDING_DIMENSIONS,
    usage,
    vectors,
    vectorSetFingerprint,
  });
}
