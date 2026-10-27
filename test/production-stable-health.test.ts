import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { fetchProductionHealth } from "../scripts/production-stable-health.mjs";

const health = { status: "ok", version: "1.2.18", database: "up", worker: { status: "up", consecutiveFailures: 0 } };
const noRetry = () => { throw new Error("Unexpected retry"); };

test("public health uses the fixed HTTPS endpoint, forbids redirects and returns the actual payload", async () => {
  let calls = 0;
  const payload = await fetchProductionHealth({
    fetchImpl: async (url: Parameters<typeof fetch>[0], options?: RequestInit) => {
      calls += 1;
      assert.equal(url, "https://ai-project-os.com/api/health");
      assert.ok(options);
      assert.equal(options.redirect, "error");
      assert.deepEqual(options.headers, { Accept: "application/json" });
      assert.ok(options.signal instanceof AbortSignal);
      return Response.json(health);
    }, wait: noRetry, onRetry: noRetry,
  });
  assert.deepEqual(payload, health);
  assert.equal(calls, 1);
});

test("one transient connection failure retries once with a fresh timeout signal", async () => {
  const signals: AbortSignal[] = [];
  const delays: number[] = [];
  const retries: unknown[] = [];
  const payload = await fetchProductionHealth({
    fetchImpl: async (_url: Parameters<typeof fetch>[0], options?: RequestInit) => {
      assert.ok(options);
      signals.push(options.signal as AbortSignal);
      if (signals.length === 1) throw new TypeError("Private transport diagnostic", { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } });
      return Response.json(health);
    },
    wait: async (delay: number) => { delays.push(delay); },
    onRetry: (attempt: number, reason: string) => { retries.push([attempt, reason]); },
  });
  assert.deepEqual(payload, health);
  assert.equal(signals.length, 2);
  assert.notEqual(signals[0], signals[1]);
  assert.deepEqual(delays, [750]);
  assert.deepEqual(retries, [[1, "transport"]]);
});

test("repeated transport failure is bounded and never substitutes healthy or guessed source evidence", async () => {
  let calls = 0;
  const retries: unknown[] = [];
  await assert.rejects(fetchProductionHealth({
    fetchImpl: async () => { calls += 1; throw new TypeError("Untrusted response details", { cause: { code: "ECONNRESET" } }); },
    wait: async () => undefined,
    onRetry: (attempt: number, reason: string) => { retries.push([attempt, reason]); },
  }), /^Error: STABLE_PUBLIC_HEALTH_REQUEST_FAILED$/u);
  assert.equal(calls, 2);
  assert.deepEqual(retries, [[1, "transport"]]);
});

test("temporary HTTP failures retry once and release the failed response body", async () => {
  for (const status of [429, 500, 502, 503, 504]) {
    let calls = 0;
    let cancelled = false;
    const payload = await fetchProductionHealth({
      fetchImpl: async () => ++calls === 1 ? new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status }) : Response.json(health),
      wait: async () => undefined, onRetry: () => undefined,
    });
    assert.deepEqual(payload, health);
    assert.equal(calls, 2);
    assert.equal(cancelled, true);
  }
});

test("permanent HTTP errors, redirects and malformed JSON fail closed", async () => {
  for (const status of [301, 302, 401, 403, 404]) {
    let calls = 0;
    await assert.rejects(fetchProductionHealth({
      fetchImpl: async () => { calls += 1; return new Response(null, { status }); },
      wait: noRetry, onRetry: noRetry,
    }), /STABLE_PUBLIC_HEALTH_HTTP_INVALID/u);
    assert.equal(calls, 1);
  }
  await assert.rejects(fetchProductionHealth({
    fetchImpl: async () => new Response("not-json", { status: 200 }), wait: noRetry, onRetry: noRetry,
  }), /STABLE_PUBLIC_HEALTH_JSON_INVALID/u);
});

test("valid JSON with unhealthy business status is left to the existing health validators", async () => {
  const actual = { ...health, worker: { status: "down", consecutiveFailures: 1 } };
  assert.deepEqual(await fetchProductionHealth({ fetchImpl: async () => Response.json(actual), wait: noRetry, onRetry: noRetry }), actual);
});

test("unknown and certificate failures are not retried as transient network failures", async () => {
  for (const error of [new TypeError("Unknown rejection"), new TypeError("fetch failed", { cause: { code: "CERT_HAS_EXPIRED" } })]) {
    let calls = 0;
    await assert.rejects(fetchProductionHealth({
      fetchImpl: async () => { calls += 1; throw error; }, wait: noRetry, onRetry: noRetry,
    }), /STABLE_PUBLIC_HEALTH_REQUEST_FAILED/u);
    assert.equal(calls, 1);
  }
});

test("native redirect:error rejects a real redirect without following or retrying it", async () => {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    response.writeHead(302, { location: "/must-not-follow" });
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await assert.rejects(fetchProductionHealth({
      fetchImpl: (_url: Parameters<typeof fetch>[0], init?: RequestInit) => fetch(`http://127.0.0.1:${address.port}/redirect`, init),
      wait: noRetry, onRetry: noRetry,
    }), /STABLE_PUBLIC_HEALTH_REQUEST_FAILED/u);
    assert.deepEqual(requests, ["/redirect"]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
