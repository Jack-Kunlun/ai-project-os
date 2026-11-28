import assert from "node:assert/strict";
import test from "node:test";
import { invokeChatCompletion, ProviderTransportError } from "../src/lib/ai-providers/transport";

const connection = { id: "quota-fixture", kind: "openai" as const, baseUrl: "https://api.openai.com/v1", credentialId: "unused", status: "verified" as const, apiKey: "fixture-only" };
const input = { connection, operation: "generateWithContext" as const, modelId: "gpt-4.1-mini", messages: [{ role: "user" as const, content: "question" }], maxOutputTokens: 16 };

test("provider quota evidence is distinct from generic 429 for JSON and streaming calls", async t => {
  for (const streaming of [false, true]) {
    for (const fixture of [
      { kind: "openai", status: 429, body: { error: { code: "insufficient_quota", message: "SECRET" } }, quota: true, code: "AI_PROVIDER_REJECTED" },
      { kind: "openai", status: 429, body: { error: { type: "credit_balance_exhausted" } }, quota: true, code: "AI_PROVIDER_REJECTED" },
      { kind: "openai", status: 429, body: { error: { code: "rate_limit_exceeded", message: "insufficient_quota" } }, quota: false, code: "AI_PROVIDER_RATE_LIMITED" },
      { kind: "openai", status: 429, body: { error: { message: "Your balance is low" } }, quota: false, code: "AI_PROVIDER_RATE_LIMITED" },
      { kind: "deepseek", status: 402, body: {}, quota: true, code: "AI_PROVIDER_REJECTED" },
    ] as const) {
      t.mock.method(globalThis, "fetch", async () => Response.json(fixture.body, { status: fixture.status }));
      await assert.rejects(invokeChatCompletion({ ...input, connection: { ...connection, kind: fixture.kind, baseUrl: fixture.kind === "deepseek" ? "https://api.deepseek.com/v1" : connection.baseUrl }, ...(streaming ? { onContentDelta: () => assert.fail("rejection has no delta") } : {}) }), error => {
        assert.ok(error instanceof ProviderTransportError);
        assert.equal(error.code, fixture.code); assert.equal(error.providerQuotaExceeded, fixture.quota);
        assert.equal(error.providerHttpStatus, fixture.status); assert.equal(error.responseReceived, true);
        assert.doesNotMatch(error.message, /SECRET/u);
        return true;
      });
    }
  }
});

test("SSE error frames release only allowlisted rejection codes before content or usage", async t => {
  const fixtures = [
    { payload: { error: { code: "insufficient_quota", message: "private body" } }, code: "AI_PROVIDER_REJECTED", quota: true },
    { payload: { error: { code: "rate_limit_exceeded", message: "private body" } }, code: "AI_PROVIDER_RATE_LIMITED", quota: false },
    { payload: { error: { code: "AI_PROVIDER_AUTH_FAILED", message: "private body" } }, code: "AI_PROVIDER_AUTH_FAILED", quota: false },
  ] as const;
  for (const fixture of fixtures) {
    t.mock.method(globalThis, "fetch", async () => new Response(
      `event: error\ndata: ${JSON.stringify(fixture.payload)}\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    ));
    await assert.rejects(invokeChatCompletion({ ...input, onContentDelta: () => assert.fail("first SSE error must precede answer content") }), error => {
      assert.ok(error instanceof ProviderTransportError);
      assert.equal(error.code, fixture.code);
      assert.equal(error.providerHttpStatus, 200);
      assert.equal(error.providerQuotaExceeded, fixture.quota);
      assert.equal(error.providerRejectedBeforeOutput, true);
      assert.doesNotMatch(error.message, /private body/u);
      return true;
    });
  }
});

test("unknown or post-output SSE errors never carry the no-execution release marker", async t => {
  t.mock.method(globalThis, "fetch", async () => new Response(
    `event: error\ndata: ${JSON.stringify({ error: { code: "new_unclassified_quota_code", message: "private body" } })}\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  ));
  await assert.rejects(invokeChatCompletion({ ...input, onContentDelta: () => assert.fail("unknown error has no content") }), error => {
    assert.ok(error instanceof ProviderTransportError);
    assert.equal(error.code, "AI_PROVIDER_UNAVAILABLE");
    assert.equal(error.providerQuotaExceeded, false);
    assert.equal(error.providerRejectedBeforeOutput, false);
    assert.equal(error.providerHttpStatus, 200);
    assert.doesNotMatch(error.message, /private body/u);
    return true;
  });

  const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
  t.mock.method(globalThis, "fetch", async () => new Response([
    frame({ choices: [{ delta: { content: "partial" }, finish_reason: null }] }),
    frame({ error: { code: "insufficient_quota", message: "private body" } }),
  ].join(""), { headers: { "content-type": "text/event-stream" } }));
  let seenContent = "";
  await assert.rejects(invokeChatCompletion({ ...input, onContentDelta: text => { seenContent += text; } }), error => {
    assert.ok(error instanceof ProviderTransportError);
    assert.equal(error.code, "AI_PROVIDER_REJECTED");
    assert.equal(error.providerQuotaExceeded, true);
    assert.equal(error.providerRejectedBeforeOutput, false);
    assert.equal(seenContent, "partial");
    assert.doesNotMatch(error.message, /private body/u);
    return true;
  });

  t.mock.method(globalThis, "fetch", async () => new Response([
    frame({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 0, total_tokens: 3 } }),
    frame({ error: { code: "insufficient_quota" } }),
  ].join(""), { headers: { "content-type": "text/event-stream" } }));
  await assert.rejects(invokeChatCompletion({ ...input, onContentDelta: () => {} }), error => {
    assert.ok(error instanceof ProviderTransportError);
    assert.equal(error.providerQuotaExceeded, true);
    assert.equal(error.providerRejectedBeforeOutput, false);
    return true;
  });
});

test("non-rendered provider frames cannot be mistaken for a request rejected before execution", async t => {
  const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
  for (const delta of [{ reasoning_content: "already reasoning" }, { role: "assistant" }, { unknown_output: "private generated data" }]) {
    t.mock.method(globalThis, "fetch", async () => new Response(
      frame({ choices: [{ delta, finish_reason: null }] }) + frame({ error: { code: "insufficient_quota" } }),
      { headers: { "content-type": "text/event-stream" } },
    ));
    await assert.rejects(invokeChatCompletion({ ...input, onContentDelta: () => assert.fail("non-rendered data is not answer text") }), error => {
      assert.ok(error instanceof ProviderTransportError);
      assert.equal(error.providerQuotaExceeded, true);
      assert.equal(error.providerRejectedBeforeOutput, false);
      return true;
    });
  }
  t.mock.method(globalThis, "fetch", async () => new Response(frame({ error: { code: "insufficient_quota" }, choices: [{ delta: { content: "mixed output" } }] }), { headers: { "content-type": "text/event-stream" } }));
  await assert.rejects(invokeChatCompletion({ ...input, onContentDelta: () => {} }), error => error instanceof ProviderTransportError && !error.providerRejectedBeforeOutput);
});

test("error body size and total time are bounded, even with trickled chunks or a hanging cancel", async t => {
  for (const mode of ["oversize", "silent", "trickle"] as const) {
    let cancelled = false, timer: ReturnType<typeof setInterval> | undefined;
    t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        if (mode === "oversize") controller.enqueue(new Uint8Array(16_385));
        if (mode === "trickle") timer = setInterval(() => controller.enqueue(new TextEncoder().encode(" ")), 80);
      },
      cancel() { cancelled = true; clearInterval(timer); return new Promise(() => {}); },
    }), { status: 429, headers: { "content-type": "application/json" } }));
    const start = Date.now();
    try {
      await assert.rejects(Promise.race([
        invokeChatCompletion(input),
        new Promise((_, reject) => { const deadline = setTimeout(() => reject(new Error("ERROR_BODY_BUDGET_EXCEEDED")), 1500); deadline.unref(); }),
      ]), error => error instanceof ProviderTransportError && error.code === "AI_PROVIDER_RATE_LIMITED" && !error.providerQuotaExceeded);
      assert.ok(Date.now() - start < 1200, "the overall read budget does not restart for each chunk");
      assert.equal(cancelled, true);
    } finally { clearInterval(timer); }
  }
});

test("caller abort stops a silent provider stream and reports dispatch uncertainty", async t => {
  const stop = new AbortController();
  let cancelled = false, resolveDelta!: () => void;
  const delta = new Promise<void>(resolve => { resolveDelta = resolve; });
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "partial" }, finish_reason: null }] })}\n\n`)); },
    cancel() { cancelled = true; },
  }), { headers: { "content-type": "text/event-stream" } }));
  const execution = invokeChatCompletion({ ...input, signal: stop.signal, onContentDelta: () => resolveDelta() });
  const rejection = assert.rejects(execution, error => error instanceof ProviderTransportError && error.requestDispatched && error.responseReceived);
  await delta; stop.abort(); await rejection;
  assert.equal(cancelled, true);
});
