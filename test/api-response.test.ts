import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "../src/lib/api-errors";
import { MAX_JSON_BODY_BYTES, readJsonBody, readRequestBody } from "../src/lib/api-response";

function streamedRequest(chunks: readonly Uint8Array[], headers: HeadersInit = {}): Request {
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk === undefined) controller.close();
      else controller.enqueue(chunk);
    },
  });
  return new Request("http://localhost/api/test", {
    method: "POST",
    headers,
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

function errorCode(operation: () => Promise<unknown>): Promise<string> {
  return operation().then(
    () => "none",
    (error: unknown) => error instanceof ApiError ? `${error.status}:${error.code}` : "unexpected",
  );
}

test("JSON body reader parses normal requests without request.json", async () => {
  const payload = JSON.stringify({ title: "项目结论", enabled: true });
  const result = await readJsonBody(streamedRequest([new TextEncoder().encode(payload)], { "content-length": String(Buffer.byteLength(payload)) }));
  assert.deepEqual(result, { title: "项目结论", enabled: true });
});

test("JSON body reader preserves malformed JSON as a stable 400", async () => {
  assert.equal(
    await errorCode(() => readJsonBody(streamedRequest([new TextEncoder().encode("{broken")]))),
    "400:INVALID_JSON",
  );
});

test("JSON body reader rejects declared and chunked bodies over the bound", async () => {
  const declared = streamedRequest([new Uint8Array([123])], { "content-length": String(MAX_JSON_BODY_BYTES + 1) });
  assert.equal(await errorCode(() => readJsonBody(declared)), "413:REQUEST_BODY_TOO_LARGE");

  const chunked = streamedRequest([new Uint8Array(MAX_JSON_BODY_BYTES), new Uint8Array([123])]);
  assert.equal(await errorCode(() => readJsonBody(chunked)), "413:REQUEST_BODY_TOO_LARGE");
});

test("bounded request reader rejects invalid Content-Length without trusting it", async () => {
  assert.equal(
    await errorCode(() => readRequestBody(streamedRequest([new Uint8Array([1])], { "content-length": "not-a-number" }), 32)),
    "400:REQUEST_CONTENT_LENGTH_INVALID",
  );
});

test("bounded request reader aborts a body that exceeds its total read deadline", async () => {
  const body = new ReadableStream<Uint8Array>({
    pull() {
      return new Promise<void>(() => undefined);
    },
  });
  const request = new Request("http://localhost/api/test", {
    method: "POST",
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  assert.equal(
    await errorCode(() => readRequestBody(request, 32, undefined, {
      milliseconds: 5,
      error: () => new ApiError(408, "REQUEST_BODY_TIMEOUT", "Request body timed out"),
    })),
    "408:REQUEST_BODY_TIMEOUT",
  );
});
