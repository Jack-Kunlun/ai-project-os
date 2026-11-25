import assert from "node:assert/strict";
import test from "node:test";
import { invokeChatCompletion, ProviderTransportError } from "../src/lib/ai-providers/transport";

const encoder = new TextEncoder();
const baseConnection = {
  id: "stream-test-connection",
  kind: "deepseek" as const,
  baseUrl: "https://api.deepseek.com/v1",
  credentialId: "unused-stream-test-credential",
  status: "verified" as const,
  apiKey: "test-provider-key",
};

function frame(payload: unknown): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
}

function streamResponse(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8", "x-request-id": "stream-test-request" },
  });
}

function requestBody(init: RequestInit | undefined): Record<string, unknown> {
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

test("streamed chat delivers text before the provider closes and returns final usage", async () => {
  const previousFetch = globalThis.fetch;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let streamClosed = false;
  const deltas: string[] = [];
  let resolveFirstDelta = () => {};
  const firstDelta = new Promise<void>((resolve) => { resolveFirstDelta = resolve; });
  globalThis.fetch = async (_input, init) => {
    assert.equal(requestBody(init).stream, true);
    assert.deepEqual(requestBody(init).stream_options, { include_usage: true });
    return streamResponse(new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
        value.enqueue(frame({ choices: [{ index: 0, delta: { role: "assistant", content: "正在生成" }, finish_reason: null }] }));
      },
      cancel() { streamClosed = true; },
    }));
  };
  try {
    const completion = invokeChatCompletion({
      connection: baseConnection,
      operation: "generateWithContext",
      modelId: "deepseek-flash",
      messages: [{ role: "user", content: "回答问题" }],
      maxOutputTokens: 128,
      jsonOutput: true,
      onContentDelta(delta) {
        assert.equal(streamClosed, false);
        deltas.push(delta);
        resolveFirstDelta();
      },
    });

    await firstDelta;
    assert.deepEqual(deltas, ["正在生成"]);
    let completed = false;
    void completion.then(() => { completed = true; });
    await Promise.resolve();
    assert.equal(completed, false);

    controller?.enqueue(frame({
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 18, completion_tokens: 7 },
    }));
    controller?.enqueue(encoder.encode("data: [DONE]\n\n"));
    const result = await completion;
    assert.equal(result.content, "正在生成");
    assert.equal(result.inputTokens, 18);
    assert.equal(result.outputTokens, 7);
    assert.equal(result.usageKnown, true);
    assert.equal(result.providerRequestId, "stream-test-request");
    assert.equal(streamClosed, true);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("stream parser handles split UTF-8, CRLF, usage-only frames and GLM reasoning fields safely", async () => {
  const previousFetch = globalThis.fetch;
  let sentBody: Record<string, unknown> | undefined;
  const body = [
    "data: {\"choices\":[{\"index\":0,\"delta\":{\"reasoning_content\":\"secret\",\"content\":\"早\"},\"finish_reason\":null}]}\r\n\r\n",
    "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"安\"},\"finish_reason\":null}]}\n\n",
    "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
    "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":9,\"completion_tokens\":4}}\n\n",
    "data: [DONE]\n\n",
  ].join("");
  const bytes = encoder.encode(body);
  globalThis.fetch = async (_input, init) => {
    sentBody = requestBody(init);
    return streamResponse(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    },
    }));
  };
  try {
    const deltas: string[] = [];
    const usage: Array<{ inputTokens: number; outputTokens: number; usageKnown: boolean }> = [];
    const result = await invokeChatCompletion({
      connection: { ...baseConnection, kind: "glm", baseUrl: "https://open.bigmodel.cn/api/paas/v4" },
      operation: "generateWithContext",
      modelId: "glm-5.3",
      messages: [{ role: "user", content: "回答问题" }],
      maxOutputTokens: 128,
      onContentDelta: (delta) => { deltas.push(delta); },
      onUsage: ({ inputTokens, outputTokens, usageKnown }) => { usage.push({ inputTokens, outputTokens, usageKnown }); },
    });
    assert.deepEqual(deltas, ["早", "安"]);
    assert.equal(result.content, "早安");
    assert.equal(result.usageKnown, true);
    assert.deepEqual(usage, [{ inputTokens: 9, outputTokens: 4, usageKnown: true }]);
    assert.equal(sentBody?.stream, true);
    assert.equal(sentBody?.stream_options, undefined);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("Qwen requests provider-documented final usage chunks for streamed chat", async () => {
  const previousFetch = globalThis.fetch;
  let sentBody: Record<string, unknown> | undefined;
  globalThis.fetch = async (_input, init) => {
    sentBody = requestBody(init);
    return streamResponse(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(frame({ choices: [{ delta: { content: "Qwen" }, finish_reason: null }] }));
        controller.enqueue(frame({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1 } }));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    }));
  };
  try {
    const result = await invokeChatCompletion({
      connection: { ...baseConnection, kind: "qwen", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
      operation: "generateWithContext",
      modelId: "qwen4-max",
      messages: [{ role: "user", content: "Question" }],
      maxOutputTokens: 32,
      onContentDelta: () => {},
    });
    assert.equal(sentBody?.stream, true);
    assert.deepEqual(sentBody?.stream_options, { include_usage: true });
    assert.equal(result.usageKnown, true);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("provider usage is unknown until a valid finish accompanies the usage frame", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => streamResponse(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(frame({ choices: [{ delta: { content: "A" }, finish_reason: null }], usage: { prompt_tokens: 2, completion_tokens: 1 } }));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  }));
  try {
    const usage: boolean[] = [];
    await assert.rejects(invokeChatCompletion({
      connection: baseConnection,
      operation: "generateWithContext",
      modelId: "deepseek-flash",
      messages: [{ role: "user", content: "Question" }],
      maxOutputTokens: 32,
      onContentDelta: () => {},
      onUsage: (value) => { usage.push(value.usageKnown); },
    }), (error: unknown) => error instanceof ProviderTransportError && error.code === "AI_PROVIDER_INVALID_RESPONSE");
    assert.deepEqual(usage, [false]);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("intermediate usage counters remain unknown when the finished stream has no final usage", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => streamResponse(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(frame({ choices: [{ delta: { content: "Answer" }, finish_reason: null }], usage: { prompt_tokens: 8, completion_tokens: 3 } }));
      controller.enqueue(frame({ choices: [{ delta: {}, finish_reason: "stop" }] }));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  }));
  try {
    const usage: boolean[] = [];
    const result = await invokeChatCompletion({
      connection: baseConnection,
      operation: "generateWithContext",
      modelId: "deepseek-flash",
      messages: [{ role: "user", content: "Question" }],
      maxOutputTokens: 32,
      onContentDelta: () => {},
      onUsage: (value) => { usage.push(value.usageKnown); },
    });
    assert.equal(result.content, "Answer");
    assert.equal(result.inputTokens, 8);
    assert.equal(result.outputTokens, 3);
    assert.equal(result.usageKnown, false);
    assert.deepEqual(usage, [false]);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("stream completion rejects malformed EOF and upstream error events", async () => {
  const previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => streamResponse(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(frame({ choices: [{ delta: { content: "partial" }, finish_reason: "stop" }] }));
        controller.close();
      },
    }));
    await assert.rejects(invokeChatCompletion({
      connection: baseConnection,
      operation: "generateWithContext",
      modelId: "deepseek-flash",
      messages: [{ role: "user", content: "Question" }],
      maxOutputTokens: 32,
      onContentDelta: () => {},
    }), (error: unknown) => error instanceof ProviderTransportError && error.code === "AI_PROVIDER_INVALID_RESPONSE");

    globalThis.fetch = async () => streamResponse(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`event: error\ndata: {"error":{"message":"provider secret"}}\n\n`));
        controller.close();
      },
    }));
    await assert.rejects(invokeChatCompletion({
      connection: baseConnection,
      operation: "generateWithContext",
      modelId: "deepseek-flash",
      messages: [{ role: "user", content: "Question" }],
      maxOutputTokens: 32,
      onContentDelta: () => {},
    }), (error: unknown) => error instanceof ProviderTransportError && error.code === "AI_PROVIDER_UNAVAILABLE" && !error.message.includes("provider secret"));
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("stream timeout cancels a stalled response body", async () => {
  const previousFetch = globalThis.fetch;
  let cancelled = false;
  globalThis.fetch = async () => streamResponse(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(encoder.encode(": keepalive\n\n")); },
    cancel() { cancelled = true; },
  }));
  try {
    await assert.rejects(invokeChatCompletion({
      connection: baseConnection,
      operation: "generateWithContext",
      modelId: "deepseek-flash",
      messages: [{ role: "user", content: "Question" }],
      maxOutputTokens: 32,
      absoluteDeadlineAt: new Date(Date.now() + 25),
      onContentDelta: () => {},
    }), (error: unknown) => error instanceof ProviderTransportError && error.code === "AI_PROVIDER_TIMEOUT"
      && error.requestDispatched && error.responseReceived);
    assert.equal(cancelled, true);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("a valid finish and DONE frame resolves without waiting for HTTP EOF", async () => {
  const previousFetch = globalThis.fetch;
  let cancelled = false;
  globalThis.fetch = async () => streamResponse(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(frame({ choices: [{ delta: { content: "finished" }, finish_reason: null }] }));
      controller.enqueue(frame({ choices: [{ delta: {}, finish_reason: "stop" }] }));
      controller.enqueue(encoder.encode("data: [DONE]\n\ntrailing bytes that must be ignored"));
    },
    cancel() { cancelled = true; },
  }));
  try {
    const result = await invokeChatCompletion({
      connection: baseConnection,
      operation: "generateWithContext",
      modelId: "deepseek-flash",
      messages: [{ role: "user", content: "Question" }],
      maxOutputTokens: 32,
      onContentDelta: () => {},
    });
    assert.equal(result.content, "finished");
    assert.equal(cancelled, true);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("a network failure before response headers remains marked uncertain", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("network failure details"); };
  try {
    await assert.rejects(invokeChatCompletion({
      connection: baseConnection,
      operation: "generateWithContext",
      modelId: "deepseek-flash",
      messages: [{ role: "user", content: "Question" }],
      maxOutputTokens: 32,
      onContentDelta: () => {},
    }), (error: unknown) => error instanceof ProviderTransportError
      && error.code === "AI_PROVIDER_UNAVAILABLE"
      && error.requestDispatched
      && !error.responseReceived
      && !error.message.includes("network failure details"));

    globalThis.fetch = async () => new Promise<Response>(() => {});
    await assert.rejects(invokeChatCompletion({
      connection: baseConnection,
      operation: "generateWithContext",
      modelId: "deepseek-flash",
      messages: [{ role: "user", content: "Question" }],
      maxOutputTokens: 32,
      absoluteDeadlineAt: new Date(Date.now() + 25),
      onContentDelta: () => {},
    }), (error: unknown) => error instanceof ProviderTransportError
      && error.code === "AI_PROVIDER_TIMEOUT"
      && error.requestDispatched
      && !error.responseReceived);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("stream callback errors are preserved and cancel the upstream body", async () => {
  const previousFetch = globalThis.fetch;
  const expectedError = Object.assign(new Error("safe confirmation code"), { code: "CONFIRMATION_STALE" });
  let cancelled = false;
  globalThis.fetch = async () => streamResponse(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(frame({ choices: [{ delta: { content: "partial" }, finish_reason: null }] })); },
    cancel() { cancelled = true; },
  }));
  try {
    await assert.rejects(invokeChatCompletion({
      connection: baseConnection,
      operation: "generateWithContext",
      modelId: "deepseek-flash",
      messages: [{ role: "user", content: "Question" }],
      maxOutputTokens: 32,
      onContentDelta: () => { throw expectedError; },
    }), (error: unknown) => error === expectedError);
    assert.equal(cancelled, true);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("nonstream chat behavior stays unchanged when no delta callback is supplied", async () => {
  const previousFetch = globalThis.fetch;
  let sentStreamValue: unknown;
  globalThis.fetch = async (_input, init) => {
    sentStreamValue = requestBody(init).stream;
    return Response.json({
      choices: [{ message: { content: "complete" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    });
  };
  try {
    const result = await invokeChatCompletion({
      connection: baseConnection,
      operation: "sourceSummary",
      modelId: "deepseek-flash",
      messages: [{ role: "user", content: "Question" }],
      maxOutputTokens: 32,
    });
    assert.equal(sentStreamValue, false);
    assert.equal(result.content, "complete");
    assert.equal(result.usageKnown, true);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
