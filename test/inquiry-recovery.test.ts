import assert from "node:assert/strict";
import test from "node:test";
import { recoverInquiryRequest, stopInquiryRequest } from "../src/lib/inquiry-recovery";
import { beginInquiryConversationChange, beginInquiryRequest, clearInquirySession, getInquirySession, inquiryRequestIsCurrent, setInquiryRecovery, type InquiryRecovery } from "../src/lib/inquiry-session";
import { InquiryResponseError } from "../src/lib/inquiry-errors";
import { INQUIRY_STREAM_TYPE, readInquiryResponse } from "../src/lib/inquiry-stream";

const request: InquiryRecovery = { id: "request-1", conversationId: "conversation-1", status: "stopped", question: "原问题", answer: "中断内容", scope: "all", contextName: "全量可访问内容", errorCode: "UNIFIED_QUESTION_STOPPED", canResume: true };
const conversation = { id: request.conversationId, title: "会话", turns: [], lastTurnId: null };

test("quota and throttling retain distinct safe feedback for both HTTP and streamed errors", async () => {
  for (const code of ["AI_PLATFORM_TOKEN_EXHAUSTED", "AI_PROVIDER_QUOTA_EXHAUSTED", "AI_PROVIDER_RATE_LIMITED"]) {
    for (const streaming of [false, true]) {
      const error = { code, message: "SECRET_PROVIDER_BODY" };
      const response = streaming ? new Response(`${JSON.stringify({ type: "error", error })}\n`, { headers: { "content-type": INQUIRY_STREAM_TYPE } }) : Response.json({ error }, { status: 429 });
      await assert.rejects(readInquiryResponse(response, () => assert.fail("error has no output")), cause => {
        assert.ok(cause instanceof InquiryResponseError);
        assert.equal(cause.feedback.code, code);
        assert.doesNotMatch(cause.message, /SECRET/u);
        assert.match(cause.message, code === "AI_PROVIDER_RATE_LIMITED" ? /频率/u : /额度|配额/u);
        return true;
      });
    }
  }
});

test("recovering a stopped request retains its question and partial answer without a model dispatch", async t => {
  clearInquirySession();
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    calls.push(`${init.method ?? "GET"} ${url}`);
    return Response.json({ request, conversation });
  });
  await recoverInquiryRequest(request.id);
  assert.deepEqual(calls, [`GET /api/ask/requests/${request.id}`]);
  assert.equal(getInquirySession().request, null);
  assert.equal(getInquirySession().question, request.question);
  assert.equal(getInquirySession().recovery?.answer, request.answer);
  assert.equal(getInquirySession().recovery?.canResume, true);
  assert.equal(getInquirySession().preview, null);
  assert.ok(beginInquiryRequest("prepare"), "the failure does not poison a new conversation lock");
  clearInquirySession();
});

test("recovery polls the original request to completion and never resends it", async t => {
  clearInquirySession();
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, `/api/ask/requests/${request.id}`); assert.equal(init.method, undefined);
    return Response.json({ request: { ...request, status: ++calls === 1 ? "running" : "succeeded", errorCode: null, canResume: false }, conversation });
  });
  await recoverInquiryRequest(request.id);
  assert.equal(calls, 2);
  assert.equal(getInquirySession().recovery, null);
  assert.deepEqual(getInquirySession().conversation, conversation);
  assert.equal(getInquirySession().question, "");
  assert.equal(getInquirySession().request, null);
});

test("stop is a POST acknowledgement followed by authoritative recovery, never local success", async t => {
  clearInquirySession();
  const executing = beginInquiryRequest("execute")!;
  setInquiryRecovery({ ...request, status: "running", canResume: false }, executing);
  const methods: string[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    methods.push(init.method ?? "GET");
    if (init.method === "POST") assert.deepEqual(JSON.parse(init.body as string), { action: "stop" });
    return Response.json({ request, conversation });
  });
  await stopInquiryRequest(request.id);
  assert.deepEqual(methods, ["POST", "GET"]);
  assert.equal(getInquirySession().recovery?.status, "stopped");
  assert.equal(inquiryRequestIsCurrent(executing), false);
  assert.equal(getInquirySession().request, null);
});

test("late recovery after sign-out cannot publish private text or release a new account request", async t => {
  clearInquirySession();
  let respond!: (value: Response) => void;
  t.mock.method(globalThis, "fetch", () => new Promise<Response>(resolve => { respond = resolve; }));
  const recovery = recoverInquiryRequest(request.id);
  clearInquirySession();
  const newRequest = beginInquiryRequest("prepare")!;
  respond(Response.json({ request, conversation }));
  await recovery;
  assert.equal(getInquirySession().question, "");
  assert.equal(getInquirySession().recovery, null);
  assert.equal(inquiryRequestIsCurrent(newRequest), true);
  clearInquirySession();
});

test("unreachable recovery releases its lock after bounded attempts and leaves an explicit retry pointer", async t => {
  clearInquirySession();
  let attempts = 0;
  t.mock.method(globalThis, "fetch", async () => { attempts++; throw new TypeError("offline"); });
  await recoverInquiryRequest(request.id);
  assert.equal(attempts, 3);
  assert.equal(getInquirySession().request, null);
  assert.equal(getInquirySession().recovery?.id, request.id);
  assert.equal(getInquirySession().recovery?.canResume, false);
  clearInquirySession();
});

test("a stored request from another conversation cannot replace the explicitly opened conversation", async t => {
  clearInquirySession();
  t.mock.method(globalThis, "fetch", async () => Response.json({ request, conversation }));
  await recoverInquiryRequest(request.id, "another-conversation");
  assert.equal(getInquirySession().conversation, null);
  assert.equal(getInquirySession().question, "");
  assert.equal(getInquirySession().recovery, null);
  assert.equal(getInquirySession().request, null);
});

test("a rejected stop never claims that generation stopped or unlocks the active request", async t => {
  clearInquirySession();
  const running = beginInquiryRequest("execute")!;
  setInquiryRecovery({ ...request, status: "running", canResume: false }, running);
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: { code: "INTERNAL_ERROR", message: "secret" } }, { status: 503 }));
  await assert.rejects(stopInquiryRequest(request.id), InquiryResponseError);
  assert.equal(getInquirySession().recovery?.status, "running");
  assert.equal(inquiryRequestIsCurrent(running), true);
  clearInquirySession();
});


test("a hanging recovery never prevents leaving for a new conversation, and its late response cannot replace it", async t => {
  clearInquirySession();
  let respond!: (value: Response) => void;
  t.mock.method(globalThis, "fetch", () => new Promise<Response>(resolve => { respond = resolve; }));
  const epoch = getInquirySession().epoch;
  const pending = recoverInquiryRequest(request.id);
  assert.equal(getInquirySession().request?.phase, "recover");
  assert.equal(beginInquiryConversationChange(), true);
  assert.equal(getInquirySession().epoch, epoch, "conversation changes must not remount the floating surface or mimic account changes");
  const next = beginInquiryRequest("prepare")!;
  assert.ok(next);
  assert.equal(beginInquiryConversationChange(), false, "an actual submission remains protected");
  respond(Response.json({ request, conversation }));
  await pending;
  assert.equal(getInquirySession().conversation, null);
  assert.equal(getInquirySession().recovery, null);
  assert.equal(getInquirySession().question, "");
  assert.equal(inquiryRequestIsCurrent(next), true);
  clearInquirySession();
});
