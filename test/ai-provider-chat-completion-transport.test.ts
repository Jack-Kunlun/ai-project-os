import assert from "node:assert/strict";
import test from "node:test";
import { invokeChatCompletion, ProviderTransportError } from "../src/lib/ai-providers/transport";

const deepseekConnection = {
  id: "deepseek-test-connection",
  kind: "deepseek" as const,
  baseUrl: "https://api.deepseek.com/v1",
  credentialId: "unused-test-credential",
  status: "verified" as const,
  apiKey: "test-provider-key",
};

function response(content: unknown, finishReason: string, requestId = "test-request") {
  return new Response(JSON.stringify({
    choices: [{ message: { content }, finish_reason: finishReason }],
    usage: { prompt_tokens: 451, completion_tokens: 2048 },
  }), {
    status: 200,
    headers: { "content-type": "application/json", "x-request-id": requestId },
  });
}

test("DeepSeek JSON extraction sends explicit JSON and no-thinking flags and preserves truncation usage", async () => {
  const previousFetch = globalThis.fetch;
  const requests: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return response('{"candidates":[]}', "length");
  };
  try {
    const result = await invokeChatCompletion({
      connection: deepseekConnection,
      operation: "autoExtract",
      modelId: "deepseek-flash",
      messages: [{ role: "user", content: "Return a JSON object." }],
      maxOutputTokens: 2048,
      disableThinking: true,
      jsonOutput: true,
    });

    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0]?.response_format, { type: "json_object" });
    assert.deepEqual(requests[0]?.thinking, { type: "disabled" });
    assert.equal(result.outputTruncated, true);
    assert.equal(result.inputTokens, 451);
    assert.equal(result.outputTokens, 2048);
    assert.equal(result.usageKnown, true);
    assert.equal(result.providerRequestId, "test-request");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

for (const content of ["", null]) {
  test(`DeepSeek JSON extraction preserves usage when length-truncated content is ${content === null ? "null" : "empty"}`, async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => response(content, "length");
    try {
      const result = await invokeChatCompletion({
        connection: deepseekConnection,
        operation: "autoExtract",
        modelId: "deepseek-flash",
        messages: [{ role: "user", content: "Return a JSON object." }],
        maxOutputTokens: 2048,
        disableThinking: true,
        jsonOutput: true,
      });

      assert.equal(result.content, "");
      assert.equal(result.outputTruncated, true);
      assert.equal(result.inputTokens, 451);
      assert.equal(result.outputTokens, 2048);
      assert.equal(result.usageKnown, true);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
}

test("DeepSeek calls without explicit JSON mode still reject empty truncated content", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => response(null, "length");
  try {
    await assert.rejects(invokeChatCompletion({
      connection: deepseekConnection,
      operation: "autoExtract",
      modelId: "deepseek-flash",
      messages: [{ role: "user", content: "Connectivity check. Reply OK." }],
      maxOutputTokens: 8,
      disableThinking: true,
    }), (error: unknown) => error instanceof ProviderTransportError && error.code === "AI_PROVIDER_INVALID_RESPONSE");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("DeepSeek probe-style autoExtract call does not implicitly enable JSON mode", async () => {
  const previousFetch = globalThis.fetch;
  const requests: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return response("OK", "stop");
  };
  try {
    await invokeChatCompletion({
      connection: deepseekConnection,
      operation: "autoExtract",
      modelId: "deepseek-flash",
      messages: [{ role: "user", content: "Connectivity check. Reply OK." }],
      maxOutputTokens: 8,
      disableThinking: true,
    });

    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.response_format, undefined);
    assert.deepEqual(requests[0]?.thinking, { type: "disabled" });
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("explicit DeepSeek-only request options are omitted for other providers", async () => {
  const previousFetch = globalThis.fetch;
  const requests: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return response("{}", "stop");
  };
  try {
    await invokeChatCompletion({
      connection: { ...deepseekConnection, kind: "glm", baseUrl: "https://glm.example/v1" },
      operation: "autoExtract",
      modelId: "glm-4-flash",
      messages: [{ role: "user", content: "Return a JSON object." }],
      maxOutputTokens: 64,
      disableThinking: true,
      jsonOutput: true,
    });

    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.response_format, undefined);
    assert.equal(requests[0]?.thinking, undefined);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
