import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  AiRuntimeServiceError,
  OPENAI_CREDENTIAL_CONTRACT_VERSION,
  OPENAI_HTTP_TRANSPORT_VERSION,
  OPENAI_RESPONSES_ENDPOINT,
  OPENAI_RESPONSES_ENDPOINT_FINGERPRINT,
  OPENAI_RESPONSES_PROFILE_VERSION,
  OPENAI_RESPONSES_PROVIDER_FINGERPRINT,
  OPENAI_RESPONSES_RETENTION_FINGERPRINT,
  buildOpenAiAutoExtractTransportPlan,
  executeOpenAiAutoExtractTransport,
  loadOpenAiCredential,
  type OpenAiCredentialHandle,
  type OpenAiResponsesTransportPlan,
} from "@/lib/ai-runtime";

const apiKey = "sk-testcredentialvalue1234567890";
const runId = "a1111111-1111-4111-8111-111111111111";
const sourceId = "b2222222-2222-4222-8222-222222222222";
const fingerprintA = "a".repeat(64);
const fingerprintB = "b".repeat(64);
const modelId = "gpt-test-model-2026-08-27";

function plan(timeoutMs = 30_000): OpenAiResponsesTransportPlan {
  return buildOpenAiAutoExtractTransportPlan(
    {
      profileVersion: OPENAI_RESPONSES_PROFILE_VERSION,
      providerFingerprint: OPENAI_RESPONSES_PROVIDER_FINGERPRINT,
      profileFingerprint: fingerprintA,
      modelId,
      modelFingerprint: fingerprintB,
      processorEndpointFingerprint: OPENAI_RESPONSES_ENDPOINT_FINGERPRINT,
      processorRegionFingerprint: fingerprintA,
      processorRetentionFingerprint: OPENAI_RESPONSES_RETENTION_FINGERPRINT,
      maxInputBytes: 8_192,
      maxOutputTokens: 1_024,
      timeoutMs,
    },
    {
      runId,
      operationKey: fingerprintA,
      sources: [{ sourceId, content: "Owner is Cedar." }],
    },
  );
}

function completedResponse(): Record<string, unknown> {
  const outputText = JSON.stringify({
    candidates: [
      {
        statement: "The owner is Cedar.",
        sourceId,
        sourceExcerpt: "Owner is Cedar.",
      },
    ],
  });
  return {
    id: "resp_safe_123",
    object: "response",
    status: "completed",
    error: null,
    incomplete_details: null,
    model: modelId,
    store: false,
    tool_choice: "none",
    parallel_tool_calls: false,
    tools: [],
    metadata: { run_id: runId, operation_key: fingerprintA },
    output: [
      {
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: outputText, annotations: [] }],
      },
    ],
    output_text: outputText,
    usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 },
  };
}

function credential(): OpenAiCredentialHandle {
  const handle = loadOpenAiCredential({ OPENAI_API_KEY: apiKey });
  if (handle === null) {
    throw new Error("test credential fixture must be valid");
  }
  return handle;
}

test("credential loader keeps the key out of the serializable handle", () => {
  const handle = credential();
  assert.deepEqual(handle, {
    contractVersion: OPENAI_CREDENTIAL_CONTRACT_VERSION,
    provider: "openai",
  });
  assert.equal(Object.isFrozen(handle), true);
  assert.doesNotMatch(JSON.stringify(handle), /testcredentialvalue/);

  for (const environment of [
    {},
    { AI_PROVIDER_KEY: apiKey },
    { OPENAI_API_KEY: "sk-short" },
    { OPENAI_API_KEY: `${apiKey} ` },
    { OPENAI_API_KEY: "not-an-openai-key-1234567890" },
  ]) {
    assert.equal(loadOpenAiCredential(environment), null);
  }
});

test("transport performs one fixed-origin no-redirect POST and returns verified candidates", async () => {
  let calls = 0;
  const issuedPlan = plan();
  const result = await executeOpenAiAutoExtractTransport(
    issuedPlan,
    credential(),
    {
      fetchImplementation: async (input, init) => {
        calls += 1;
        assert.equal(input, OPENAI_RESPONSES_ENDPOINT);
        assert.equal(init?.method, "POST");
        assert.equal(init?.redirect, "error");
        assert.equal(init?.credentials, "omit");
        assert.equal(init?.referrerPolicy, "no-referrer");
        assert.equal(init?.cache, "no-store");
        assert.ok(init?.signal instanceof AbortSignal);
        const headers = new Headers(init?.headers);
        assert.equal(headers.get("accept"), "application/json");
        assert.equal(headers.get("content-type"), "application/json");
        assert.equal(headers.get("authorization"), `Bearer ${apiKey}`);
        assert.deepEqual(JSON.parse(String(init?.body)), issuedPlan.body);
        return new Response(JSON.stringify(completedResponse()), {
          status: 200,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "x-request-id": "req_safe_123",
          },
        });
      },
    },
  );

  assert.equal(calls, 1);
  assert.equal(result.transportVersion, OPENAI_HTTP_TRANSPORT_VERSION);
  assert.deepEqual(result.providerResult, {
    kind: "completed",
    providerRequestId: "req_safe_123",
    providerResponseId: "resp_safe_123",
    usage: { inputTokens: 20, outputTokens: 10, requestCount: 1 },
  });
  assert.equal(result.verifiedResponse?.candidates.length, 1);
  assert.equal(
    result.verifiedResponse?.candidates[0]?.sourceExcerpt,
    "Owner is Cedar.",
  );
  assert.equal("rawResponse" in result, false);
  assert.equal("apiKey" in result, false);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.providerResult), true);
});

test("transport classifies explicit incomplete responses without accepting partial output", async () => {
  const raw = {
    ...completedResponse(),
    status: "incomplete",
    error: null,
    incomplete_details: { reason: "max_output_tokens" },
    output: [],
    output_text: undefined,
    usage: { input_tokens: 20, output_tokens: 1_024, total_tokens: 1_044 },
  };
  delete raw.output_text;
  const result = await executeOpenAiAutoExtractTransport(plan(), credential(), {
    fetchImplementation: async () =>
      new Response(JSON.stringify(raw), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });

  assert.deepEqual(result.providerResult, {
    kind: "incomplete",
    providerResponseId: "resp_safe_123",
    safeCode: "AI_PROVIDER_INCOMPLETE",
    usage: { inputTokens: 20, outputTokens: 1_024, requestCount: 1 },
  });
  assert.equal(result.verifiedResponse, null);
});

test("transport never reads provider HTTP error bodies and never retries", async () => {
  let calls = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("provider-secret-error-body"));
    },
    cancel() {
      cancelled = true;
    },
  });
  const result = await executeOpenAiAutoExtractTransport(plan(), credential(), {
    fetchImplementation: async () => {
      calls += 1;
      return new Response(body, {
        status: 429,
        headers: {
          "content-type": "application/json",
          "x-request-id": "req_rate_limit_123",
        },
      });
    },
  });

  assert.equal(calls, 1);
  assert.equal(cancelled, true);
  assert.deepEqual(result, {
    transportVersion: OPENAI_HTTP_TRANSPORT_VERSION,
    providerResult: {
      kind: "http_error",
      httpStatus: 429,
      providerRequestId: "req_rate_limit_123",
    },
    verifiedResponse: null,
  });
});

test("transport maps invalid success bodies to unknown-safe invalid_response", async () => {
  for (const response of [
    new Response("not-json", {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    new Response(JSON.stringify(completedResponse()), {
      status: 200,
      headers: { "content-type": "text/plain" },
    }),
    new Response(JSON.stringify(completedResponse()), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-length": "0x10",
      },
    }),
    new Response("x".repeat(1_048_577), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    new Response(
      JSON.stringify({ ...completedResponse(), model: "wrong-model" }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    ),
  ]) {
    const result = await executeOpenAiAutoExtractTransport(plan(), credential(), {
      fetchImplementation: async () => response,
    });
    assert.deepEqual(result.providerResult, {
      kind: "invalid_response",
      sentAt: true,
    });
    assert.equal(result.verifiedResponse, null);
  }
});

test("transport classifies fetch failures after the dispatch boundary without retrying", async () => {
  let calls = 0;
  const connection = await executeOpenAiAutoExtractTransport(plan(), credential(), {
    fetchImplementation: async () => {
      calls += 1;
      throw new TypeError("network detail must not escape");
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(connection.providerResult, {
    kind: "connection",
    sentAt: true,
  });

  const aborted = await executeOpenAiAutoExtractTransport(plan(), credential(), {
    fetchImplementation: async () => {
      throw new DOMException("aborted detail", "AbortError");
    },
  });
  assert.deepEqual(aborted.providerResult, { kind: "abort", sentAt: true });
});

test("transport rejects forged plans and credential handles before fetch", async () => {
  let called = false;
  const issuedPlan = plan();
  const forgedPlan = JSON.parse(
    JSON.stringify(issuedPlan),
  ) as OpenAiResponsesTransportPlan;
  await assert.rejects(
    () =>
      executeOpenAiAutoExtractTransport(forgedPlan, credential(), {
        fetchImplementation: async () => {
          called = true;
          return new Response();
        },
      }),
    (error: unknown) =>
      error instanceof AiRuntimeServiceError &&
      error.code === "AI_INVALID_OPERATION_KEY_INPUT",
  );
  assert.equal(called, false);

  await assert.rejects(
    () =>
      executeOpenAiAutoExtractTransport(
        issuedPlan,
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
    (error: unknown) =>
      error instanceof AiRuntimeServiceError &&
      error.code === "AI_PROVIDER_DISABLED",
  );
  assert.equal(called, false);
});

test("transport module has no SDK, logging or retry loop", () => {
  const source = readFileSync(
    join(process.cwd(), "src/lib/ai-runtime/openai-http-transport.ts"),
    "utf8",
  );
  assert.doesNotMatch(source, /from\s+["']openai["']|\baxios\b/i);
  assert.doesNotMatch(source, /console\.|logger\.|provider-secret-error-body/i);
  assert.equal(source.match(/fetchImplementation\(/g)?.length, 1);
});
