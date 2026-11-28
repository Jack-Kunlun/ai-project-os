import assert from "node:assert/strict";
import test from "node:test";
import { beginInquiryRead, beginInquiryRequest, clearInquirySession, finishInquiryRequest, inquiryDrafts, inquiryEpochIsCurrent, inquiryReadIsCurrent, inquiryRequestIsCurrent, invalidateInquiryReads, savedInquiryRequest, setInquiryRecovery } from "../src/lib/inquiry-session";

test("the full page and floating Ask share one request lock and stale completion cannot unlock a new account", () => {
  clearInquirySession();
  const first = beginInquiryRequest("execute")!;
  assert.equal(beginInquiryRequest("prepare"), null);
  assert.equal(beginInquiryRead(), null);
  inquiryDrafts.set("private-conversation", "private draft");
  clearInquirySession();
  assert.equal(inquiryDrafts.size, 0);
  assert.equal(inquiryEpochIsCurrent(first.epoch), false);
  assert.equal(inquiryRequestIsCurrent(first), false);
  const second = beginInquiryRequest("prepare")!;
  finishInquiryRequest(first);
  assert.equal(inquiryRequestIsCurrent(second), true);
  assert.equal(beginInquiryRequest("execute"), null);
  finishInquiryRequest(second);
  assert.ok(beginInquiryRead());
  clearInquirySession();
});

test("older reads across Ask instances cannot replace a newer read, generated answer, or cleared account", () => {
  clearInquirySession();
  const first = beginInquiryRead()!;
  const second = beginInquiryRead()!;
  assert.equal(inquiryReadIsCurrent(first), false);
  assert.equal(inquiryReadIsCurrent(second), true);
  const request = beginInquiryRequest("execute")!;
  assert.equal(inquiryReadIsCurrent(second), false);
  finishInquiryRequest(request);
  assert.equal(inquiryReadIsCurrent(second), false);
  const third = beginInquiryRead()!;
  assert.equal(inquiryReadIsCurrent(third), true);
  invalidateInquiryReads(); // A deliberate new/empty conversation is still an intent.
  assert.equal(inquiryReadIsCurrent(third), false);
  const fourth = beginInquiryRead()!;
  clearInquirySession();
  assert.equal(inquiryReadIsCurrent(fourth), false);
});

test("a confirmation keeps reads and other senders locked until its own execution or dismissal", () => {
  clearInquirySession();
  const prepared = beginInquiryRequest("prepare")!;
  assert.equal(beginInquiryRead(), null);
  assert.equal(beginInquiryRequest("execute"), null);
  assert.equal(beginInquiryRequest("execute", { ...prepared }), null);
  const executing = beginInquiryRequest("execute", prepared)!;
  assert.ok(executing);
  assert.equal(inquiryRequestIsCurrent(prepared), false);
  finishInquiryRequest(prepared);
  assert.equal(inquiryRequestIsCurrent(executing), true);
  finishInquiryRequest(executing);
  assert.ok(beginInquiryRead());
  clearInquirySession();
});

test("browser recovery persistence contains only an opaque request id and is cleared at sign-out", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window"), storage = new Map<string, string>();
  Object.defineProperty(globalThis, "window", { configurable: true, value: { sessionStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  } } });
  try {
    clearInquirySession();
    setInquiryRecovery({ id: "opaque-request", conversationId: "private-conversation", status: "stopped", question: "private question", answer: "private answer", scope: "personal", contextName: "private scope", canResume: true, errorCode: null });
    assert.equal(savedInquiryRequest(), "opaque-request");
    assert.deepEqual([...storage.values()], ["opaque-request"]);
    clearInquirySession();
    assert.equal(storage.size, 0);
  } finally {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
