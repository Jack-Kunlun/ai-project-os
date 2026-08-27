import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  AiRuntimeServiceError,
  OPENAI_EMBEDDING_DIMENSIONS,
  OPENAI_EMBEDDINGS_CONTRACT_VERSION,
  OPENAI_EMBEDDINGS_ENDPOINT,
  OPENAI_EMBEDDINGS_ENDPOINT_FINGERPRINT,
  OPENAI_EMBEDDINGS_PROFILE_VERSION,
  OPENAI_EMBEDDINGS_PROVIDER_FINGERPRINT,
  OPENAI_EMBEDDINGS_RETENTION_FINGERPRINT,
  buildOpenAiEmbeddingsTransportPlan,
  verifyOpenAiEmbeddingsResponse,
} from "@/lib/ai-runtime";

const runId = "a1111111-1111-4111-8111-111111111111";
const inputAId = "b2222222-2222-4222-8222-222222222222";
const inputBId = "c3333333-3333-4333-8333-333333333333";
const fingerprintA = "a".repeat(64);
const fingerprintB = "b".repeat(64);
const modelId = "text-embedding-3-small";

function profile(overrides: Record<string, unknown> = {}) {
  return {
    profileVersion: OPENAI_EMBEDDINGS_PROFILE_VERSION,
    providerFingerprint: OPENAI_EMBEDDINGS_PROVIDER_FINGERPRINT,
    profileFingerprint: fingerprintA,
    modelId,
    modelFingerprint: fingerprintB,
    processorEndpointFingerprint: OPENAI_EMBEDDINGS_ENDPOINT_FINGERPRINT,
    processorRegionFingerprint: fingerprintA,
    processorRetentionFingerprint: OPENAI_EMBEDDINGS_RETENTION_FINGERPRINT,
    maxInputBytes: 8_192,
    maxTotalInputBytes: 32_768,
    maxInputs: 10,
    dimensions: OPENAI_EMBEDDING_DIMENSIONS,
    timeoutMs: 30_000,
    ...overrides,
  };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    runId,
    operationKey: fingerprintA,
    inputs: [
      { inputId: inputBId, content: "Risk review is Friday." },
      { inputId: inputAId, content: "Owner is Cedar." },
    ],
    ...overrides,
  };
}

function vector(value: number): number[] {
  return Array.from({ length: OPENAI_EMBEDDING_DIMENSIONS }, () => value);
}

function assertInvalid(
  code: "AI_INVALID_OPERATION_KEY_INPUT" | "AI_INVALID_PROVIDER_RESPONSE",
  callback: () => unknown,
): void {
  assert.throws(
    callback,
    (error: unknown) =>
      error instanceof AiRuntimeServiceError &&
      error.code === code &&
      error.message === code,
  );
}

test("embedding compiler produces a sorted fixed-origin single-attempt plan", () => {
  const plan = buildOpenAiEmbeddingsTransportPlan(profile(), request());

  assert.equal(plan.contractVersion, OPENAI_EMBEDDINGS_CONTRACT_VERSION);
  assert.equal(plan.operation, "embedding");
  assert.equal(plan.endpoint, OPENAI_EMBEDDINGS_ENDPOINT);
  assert.equal(plan.method, "POST");
  assert.equal(plan.redirect, "error");
  assert.equal(plan.automaticRetry, false);
  assert.equal(plan.maximumAttempts, 1);
  assert.equal(plan.runId, runId);
  assert.equal(plan.operationKey, fingerprintA);
  assert.deepEqual(plan.body, {
    model: modelId,
    input: ["Owner is Cedar.", "Risk review is Friday."],
    encoding_format: "float",
    dimensions: OPENAI_EMBEDDING_DIMENSIONS,
  });
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan.body), true);
  assert.equal(Object.isFrozen(plan.body.input), true);
  assert.equal("apiKey" in plan, false);
  assert.equal("headers" in plan, false);
  assert.equal("user" in plan.body, false);
});

test("embedding compiler rejects profile expansion and unsafe identifiers", () => {
  for (const invalid of [
    profile({ endpoint: "https://example.invalid" }),
    profile({ apiKey: "secret-sentinel" }),
    profile({ providerFingerprint: fingerprintA }),
    profile({ processorEndpointFingerprint: fingerprintA }),
    profile({ processorRetentionFingerprint: fingerprintA }),
    profile({ modelId: "latest" }),
    profile({ modelId: "text-embedding-latest" }),
    profile({ modelId: "sk-secret-sentinel" }),
    profile({ maxInputBytes: 8_193 }),
    profile({ maxTotalInputBytes: 256_001 }),
    profile({ maxInputs: 101 }),
    profile({ dimensions: 512 }),
    profile({ timeoutMs: 999 }),
  ]) {
    assertInvalid("AI_INVALID_OPERATION_KEY_INPUT", () =>
      buildOpenAiEmbeddingsTransportPlan(invalid, request()),
    );
  }
});

test("embedding compiler rejects duplicate, unsafe and oversized input", () => {
  const valid = { inputId: inputAId, content: "safe" };
  for (const invalid of [
    request({ endpoint: "https://example.invalid" }),
    request({ inputs: [] }),
    request({ inputs: [valid, valid] }),
    request({ inputs: [{ inputId: inputAId, content: "" }] }),
    request({ inputs: [{ inputId: inputAId, content: "unsafe\u0001" }] }),
    request({ inputs: [{ inputId: inputAId, content: "unpaired\ud800" }] }),
    request({ inputs: [{ ...valid, prompt: "caller prompt" }] }),
    request({ inputs: [{ inputId: inputAId, content: "x".repeat(8_193) }] }),
  ]) {
    assertInvalid("AI_INVALID_OPERATION_KEY_INPUT", () =>
      buildOpenAiEmbeddingsTransportPlan(profile(), invalid),
    );
  }

  assertInvalid("AI_INVALID_OPERATION_KEY_INPUT", () =>
    buildOpenAiEmbeddingsTransportPlan(
      profile({ maxInputBytes: 8_192, maxTotalInputBytes: 8_192 }),
      request({
        inputs: [
          { inputId: inputAId, content: "a".repeat(5_000) },
          { inputId: inputBId, content: "b".repeat(5_000) },
        ],
      }),
    ),
  );
});

test("embedding verifier binds out-of-order indexes to input IDs and float32 vectors", () => {
  const plan = buildOpenAiEmbeddingsTransportPlan(profile(), request());
  const verified = verifyOpenAiEmbeddingsResponse(plan, {
    object: "list",
    model: modelId,
    data: [
      { object: "embedding", index: 1, embedding: vector(0.2) },
      { object: "embedding", index: 0, embedding: vector(0.1) },
    ],
    usage: { prompt_tokens: 12, total_tokens: 12 },
  });

  assert.equal(verified.contractVersion, OPENAI_EMBEDDINGS_CONTRACT_VERSION);
  assert.equal(verified.modelId, modelId);
  assert.equal(verified.dimensions, OPENAI_EMBEDDING_DIMENSIONS);
  assert.deepEqual(verified.usage, {
    inputTokens: 12,
    outputTokens: 0,
    requestCount: 1,
  });
  assert.deepEqual(
    verified.vectors.map((item) => item.inputId),
    [inputAId, inputBId],
  );
  assert.equal(verified.vectors[0]?.index, 0);
  assert.equal(verified.vectors[0]?.vector[0], Math.fround(0.1));
  assert.equal(
    verified.vectors[0]?.vector.length,
    OPENAI_EMBEDDING_DIMENSIONS,
  );
  assert.match(verified.vectors[0]?.vectorFingerprint ?? "", /^[0-9a-f]{64}$/);
  assert.match(verified.vectorSetFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(Object.isFrozen(verified), true);
  assert.equal(Object.isFrozen(verified.vectors), true);
  assert.equal(Object.isFrozen(verified.vectors[0]?.vector), true);
  assert.equal("rawResponse" in verified, false);
});

test("embedding verifier rejects malformed models, indexes, vectors and usage", () => {
  const plan = buildOpenAiEmbeddingsTransportPlan(profile(), request());
  const validData = [
    { object: "embedding", index: 0, embedding: vector(0.1) },
    { object: "embedding", index: 1, embedding: vector(0.2) },
  ];
  for (const invalid of [
    { object: "wrong", model: modelId, data: validData, usage: { prompt_tokens: 1, total_tokens: 1 } },
    { object: "list", model: "wrong-model", data: validData, usage: { prompt_tokens: 1, total_tokens: 1 } },
    { object: "list", model: modelId, data: [validData[0]], usage: { prompt_tokens: 1, total_tokens: 1 } },
    {
      object: "list",
      model: modelId,
      data: [validData[0], { ...validData[1], index: 0 }],
      usage: { prompt_tokens: 1, total_tokens: 1 },
    },
    {
      object: "list",
      model: modelId,
      data: [validData[0], { ...validData[1], embedding: vector(0.2).slice(1) }],
      usage: { prompt_tokens: 1, total_tokens: 1 },
    },
    {
      object: "list",
      model: modelId,
      data: [validData[0], { ...validData[1], embedding: [Number.NaN, ...vector(0.2).slice(1)] }],
      usage: { prompt_tokens: 1, total_tokens: 1 },
    },
    { object: "list", model: modelId, data: validData, usage: { prompt_tokens: 1, total_tokens: 2 } },
  ]) {
    assertInvalid("AI_INVALID_PROVIDER_RESPONSE", () =>
      verifyOpenAiEmbeddingsResponse(plan, invalid),
    );
  }
});

test("embedding verifier rejects accessors and deserialized plans", () => {
  const plan = buildOpenAiEmbeddingsTransportPlan(profile(), request());
  let accessorRead = false;
  const response = {
    object: "list",
    model: modelId,
    data: [
      { object: "embedding", index: 0, embedding: vector(0.1) },
      { object: "embedding", index: 1, embedding: vector(0.2) },
    ],
    usage: { prompt_tokens: 1, total_tokens: 1 },
  };
  Object.defineProperty(response, "model", {
    enumerable: true,
    get: () => {
      accessorRead = true;
      return modelId;
    },
  });
  assertInvalid("AI_INVALID_PROVIDER_RESPONSE", () =>
    verifyOpenAiEmbeddingsResponse(plan, response),
  );
  assert.equal(accessorRead, false);

  const forged = JSON.parse(JSON.stringify(plan));
  assertInvalid("AI_INVALID_OPERATION_KEY_INPUT", () =>
    verifyOpenAiEmbeddingsResponse(forged, {
      object: "list",
      model: modelId,
      data: [],
      usage: { prompt_tokens: 0, total_tokens: 0 },
    }),
  );
});

test("embedding contract module has no transport, credential access or logging", () => {
  const source = readFileSync(
    join(process.cwd(), "src/lib/ai-runtime/openai-embeddings-contract.ts"),
    "utf8",
  );
  assert.doesNotMatch(source, /\bfetch\s*\(|\baxios\b|from\s+["']openai["']/i);
  assert.doesNotMatch(
    source,
    /process\.env|authorization|api[-_]?key|bearer\s|console\.|logger\./i,
  );
  assert.equal(
    source.match(/https:\/\/api\.openai\.com\/v1\/embeddings/g)?.length,
    1,
  );
});
