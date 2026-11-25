import assert from "node:assert/strict";
import test from "node:test";
import { readInquiryResponse, INQUIRY_STREAM_TYPE } from "../src/lib/inquiry-stream";
import { UnifiedQuestionPreview } from "../src/lib/unified-question-preview";

test("answer preview decodes split JSON escapes and emits only the top-level answer", () => {
  for (const content of [
    '{"answer":"第一行\\n引号\\\"\\uD83D\\uDE80","citations":["s1"]}',
    '{"citations":["s1"],"answer":"第一行\\n引号\\\"\\uD83D\\uDE80"}',
  ]) {
    const decoder = new UnifiedQuestionPreview();
    let answer = "";
    for (const character of content) {
      const delta = decoder.push(character);
      assert.equal(/[\uD800-\uDBFF]$/u.test(delta), false);
      answer += delta;
    }
    assert.equal(answer, '第一行\n引号"🚀');
  }
  const decoder = new UnifiedQuestionPreview();
  assert.equal(decoder.push('{"untrusted":{"answer":"hidden"},"answer":"visible"}'), "visible");
  assert.equal(new UnifiedQuestionPreview().push('{"answer":"bad\\x"}'), "");
  assert.throws(() => new UnifiedQuestionPreview().push(`{"answer":"${"x".repeat(50_001)}`), /INVALID_MODEL_OUTPUT/u);
});

test("client delivers partial Chinese text before the final network chunk", async () => {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  let preview = "", complete = false;
  const reading = readInquiryResponse(new Response(body, { headers: { "content-type": INQUIRY_STREAM_TYPE } }), text => { preview += text; });
  void reading.then(() => { complete = true; });
  const bytes = encoder.encode(`${JSON.stringify({ type: "delta", text: "你好🚀" })}\n`);
  for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(preview, "你好🚀"); assert.equal(complete, false);
  const conversation = { id: "fixture", turns: [], lastTurnId: null, title: "fixture" };
  controller.enqueue(encoder.encode(`${JSON.stringify({ type: "complete", conversation })}\n`));
  assert.deepEqual(await reading, { conversation });
});

test("client rejects missing completion, corrupt frames, remote errors and truncated UTF-8", async () => {
  for (const body of ['{"type":"delta","text":"partial"}\n', '{broken}\n', 'null\n', '{"type":"unexpected"}\n', '{"type":"complete"}\n']) {
    await assert.rejects(readInquiryResponse(new Response(body, { headers: { "content-type": INQUIRY_STREAM_TYPE } }), () => {}), /连接中断/u);
  }
  await assert.rejects(readInquiryResponse(new Response(new Uint8Array([0xe4, 0xbd]), { headers: { "content-type": INQUIRY_STREAM_TYPE } }), () => {}), /连接中断/u);
  await assert.rejects(readInquiryResponse(new Response('{"type":"error","error":{"code":"INTERNAL_ERROR","message":"secret provider body"}}\n', { headers: { "content-type": INQUIRY_STREAM_TYPE } }), () => {}), error => error instanceof Error && !error.message.includes("secret"));
  const conversation = { id: "json-fixture", turns: [] };
  assert.deepEqual(await readInquiryResponse(Response.json({ conversation }), () => assert.fail("JSON response has no deltas")), { conversation });
});
