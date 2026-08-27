import assert from "node:assert/strict";
import test from "node:test";
import {
  OPENAI_CREDENTIAL_CONTRACT_VERSION,
  OPENAI_EMBEDDING_DIMENSIONS,
  OPENAI_EMBEDDINGS_ENDPOINT,
  OPENAI_EMBEDDINGS_ENDPOINT_FINGERPRINT,
  OPENAI_EMBEDDINGS_PROFILE_VERSION,
  OPENAI_EMBEDDINGS_PROVIDER_FINGERPRINT,
  OPENAI_EMBEDDINGS_RETENTION_FINGERPRINT,
  OPENAI_HTTP_TRANSPORT_VERSION,
  buildOpenAiEmbeddingsTransportPlan,
  executeOpenAiEmbeddingsTransport,
  loadOpenAiCredential,
  type OpenAiCredentialHandle,
} from "@/lib/ai-runtime";

const apiKey = "sk-testcredentialvalue1234567890";
const runId = "a1111111-1111-4111-8111-111111111111";
const inputId = "b2222222-2222-4222-8222-222222222222";
const fingerprintA = "a".repeat(64);
const fingerprintB = "b".repeat(64);
const modelId = "text-embedding-3-small";

function plan() {
  return buildOpenAiEmbeddingsTransportPlan(
    {
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
    },
    {
      runId,
      operationKey: fingerprintA,
      inputs: [{ inputId, content: "Owner is Cedar." }],
    },
  );
}

function credential(): OpenAiCredentialHandle {
  const handle = loadOpenAiCredential({ OPENAI_API_KEY: apiKey });
  if (handle === null) {
    throw new Error("test credential fixture must be valid");
  }
  return handle;
}

function embedding(value: number): number[] {
  return Array.from({ length: OPENAI_EMBEDDING_DIMENSIONS }, () => value);
}

test("embedding transport performs one fixed request and returns only verified vectors", async () => {
  let calls = 0;
  const issuedPlan = plan();
  const result = await executeOpenAiEmbeddingsTransport(
    issuedPlan,
    credential(),
    {
      fetchImplementation: async (input, init) => {
        calls += 1;
        assert.equal(input, OPENAI_EMBEDDINGS_ENDPOINT);
        assert.equal(init?.method, "POST");
        assert.equal(init?.redirect, "error");
        assert.equal(init?.credentials, "omit");
        const headers = new Headers(init?.headers);
        assert.equal(headers.get("authorization"), `Bearer ${apiKey}`);
        assert.deepEqual(JSON.parse(String(init?.body)), issuedPlan.body);
        return new Response(
          JSON.stringify({
            object: "list",
            model: modelId,
            data: [
              { object: "embedding", index: 0, embedding: embedding(0.125) },
            ],
            usage: { prompt_tokens: 6, total_tokens: 6 },
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-request-id": "req_embedding_123",
            },
          },
        );
      },
    },
  );

  assert.equal(calls, 1);
  assert.equal(result.transportVersion, OPENAI_HTTP_TRANSPORT_VERSION);
  assert.deepEqual(result.providerResult, {
    kind: "completed",
    providerRequestId: "req_embedding_123",
    usage: { inputTokens: 6, outputTokens: 0, requestCount: 1 },
  });
  assert.equal(result.verifiedResponse?.vectors.length, 1);
  assert.equal(result.verifiedResponse?.vectors[0]?.inputId, inputId);
  assert.equal(
    result.verifiedResponse?.vectors[0]?.vector.length,
    OPENAI_EMBEDDING_DIMENSIONS,
  );
  assert.equal("rawResponse" in result, false);
  assert.equal("apiKey" in result, false);
});

test("embedding transport rejects malformed vectors without returning provider JSON", async () => {
  const result = await executeOpenAiEmbeddingsTransport(plan(), credential(), {
    fetchImplementation: async () =>
      new Response(
        JSON.stringify({
          object: "list",
          model: modelId,
          data: [{ object: "embedding", index: 0, embedding: [0.1] }],
          usage: { prompt_tokens: 6, total_tokens: 6 },
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-request-id": "req_embedding_invalid_123",
          },
        },
      ),
  });

  assert.deepEqual(result, {
    transportVersion: OPENAI_HTTP_TRANSPORT_VERSION,
    providerResult: {
      kind: "invalid_response",
      sentAt: true,
      providerRequestId: "req_embedding_invalid_123",
    },
    verifiedResponse: null,
  });
});

test("embedding transport shares the credential handle contract", async () => {
  let called = false;
  await assert.rejects(() =>
    executeOpenAiEmbeddingsTransport(
      plan(),
      {
        contractVersion: OPENAI_CREDENTIAL_CONTRACT_VERSION,
        provider: "openai",
      },
      {
        fetchImplementation: async () => {
          called = true;
          return new Response();
        },
      },
    ),
  );
  assert.equal(called, false);
});
