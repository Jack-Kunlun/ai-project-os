import assert from "node:assert/strict";
import test from "node:test";
import { createInquiryReveal, InquiryReveal } from "../src/lib/inquiry-reveal";

import { beginInquiryRequest, clearInquirySession, startInquiryPreview } from "../src/lib/inquiry-session";

function fixture() {
  let now = 0, id = 0, reduced = false;
  const frames = new Map<number, (time: number) => void>();
  const rendered: string[] = [];
  const buffer = new InquiryReveal(text => rendered.push(text), {
    now: () => now,
    request: callback => { frames.set(++id, callback); return id; },
    cancel: handle => { frames.delete(handle); },
  }, () => reduced);
  return { buffer, rendered, frames, reduce: () => { reduced = true; buffer.flush(); },
    advance(milliseconds: number) {
      for (let elapsed = 0; elapsed < milliseconds; elapsed += 16) {
        now += 16;
        const pending = [...frames.values()]; frames.clear();
        pending.forEach(callback => callback(now));
      }
    },
  };
}

test("a network burst reveals multiple prefixes promptly and catches up without losing the next delta", async () => {
  const f = fixture(), first = "逐字呈现回答内容，不再一整段跳出来。";
  f.buffer.append(first);
  assert.equal(f.rendered.length, 0);
  f.advance(48);
  assert.ok(f.rendered.at(-1)!.length > 0 && f.rendered.at(-1)!.length < first.length);
  f.buffer.append("接着读下一段。");
  f.advance(1000);
  const expected = first + "接着读下一段。";
  assert.equal(f.rendered.at(-1), expected.slice(0, -1));
  const done=f.buffer.finish(expected);f.advance(400);await done;
  assert.equal(f.rendered.at(-1), expected);
  assert.ok(f.rendered.length > 5);
  f.rendered.forEach((text, i) => { assert.ok(expected.startsWith(text)); if(i)assert.ok(text.length>f.rendered[i-1].length); });
  assert.equal(f.frames.size, 0);
});

test("visible prefixes end at full Chinese, combining-mark and emoji grapheme boundaries", async () => {
  const f = fixture(), text = "你好👩🏽‍💻e\u0301🇨🇳🚀完成";
  const boundaries = new Set(Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text), p => p.index + p.segment.length));
  f.buffer.append(text); f.advance(1000);
  const done=f.buffer.finish(text);f.advance(400);await done;
  assert.equal(f.rendered.at(-1), text);
  for(const prefix of f.rendered)assert.ok(boundaries.has(prefix.length));
});

test("completion drains the authoritative tail smoothly within a short bounded delay", async () => {
  const f = fixture(), text = "持续生成的正文。".repeat(500);
  f.buffer.append(text);f.advance(32);
  const before=f.rendered.at(-1)!;
  let complete=false;
  const done=f.buffer.finish(text+"最后一句。").then(()=>{complete=true;});
  await Promise.resolve();assert.equal(complete,false);
  f.advance(64);
  assert.ok(f.rendered.at(-1)!.length>before.length);
  assert.ok(f.rendered.at(-1)!.length<text.length);
  f.advance(320);await done;
  assert.equal(f.rendered.at(-1),text+"最后一句。");
  assert.equal(f.frames.size,0);
});

test("reduced motion and hidden-page flushing do not leave a completion waiting on animation frames", async () => {
  const f=fixture();f.buffer.append("尚未全部显示的正文");f.advance(32);f.reduce();
  assert.equal(f.rendered.at(-1),"尚未全部显示的正文");
  f.buffer.append("新分块立即显示");
  assert.equal(f.rendered.at(-1),"尚未全部显示的正文新分块立即显示");
  await f.buffer.finish("已核对的最终正文");
  assert.equal(f.rendered.at(-1),"已核对的最终正文");assert.equal(f.frames.size,0);
});

test("cancellation discards scheduled output and releases completion without writing stale text", async () => {
  const f=fixture();f.buffer.append("旧账户尚未显示的正文");f.advance(32);
  const done=f.buffer.finish("旧账户尚未显示的正文");const before=[...f.rendered];
  f.buffer.cancel();f.advance(1000);f.buffer.append("不能出现");await done;
  assert.deepEqual(f.rendered,before);assert.equal(f.frames.size,0);
});

test("a corrected final answer replaces incompatible provisional content immediately", async () => {
  const f=fixture();f.buffer.append("临时正文与最终内容不一致");f.advance(64);
  await f.buffer.finish("最终校验后的正文");
  assert.equal(f.rendered.at(-1),"最终校验后的正文");assert.equal(f.frames.size,0);
});


test("the request cursor releases pending completion on session reset or a hidden-page event", async t => {
  const frames = new Map<number, FrameRequestCallback>();
  const motion = Object.assign(new EventTarget(), { matches: false });
  const document = Object.assign(new EventTarget(), { hidden: false });
  let next = 0;
  const globals = { window: { matchMedia: () => motion }, document,
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++next, callback); return next; },
    cancelAnimationFrame: (id: number) => { frames.delete(id); },
  };
  const descriptors = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  t.after(() => {
    clearInquirySession();
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  clearInquirySession();
  const first = beginInquiryRequest("execute")!; startInquiryPreview(first, "旧问题");
  const old = createInquiryReveal(first);
  const cancelled = old.buffer.finish("旧账号的待显示正文");
  assert.equal(frames.size, 1);
  clearInquirySession(); await cancelled;
  old.buffer.append("过期分块"); assert.equal(frames.size, 0);
  const second = beginInquiryRequest("execute")!; startInquiryPreview(second, "新问题");
  const current = createInquiryReveal(second);
  const completed = current.buffer.finish("后台页面的最终正文");
  assert.equal(frames.size, 1);
  document.hidden = true; document.dispatchEvent(new Event("visibilitychange"));
  await completed; assert.equal(frames.size, 0);
  current.dispose();
});


test("a trailing grapheme stays pending when emoji or accents span network deltas", async () => {
  const f = fixture();
  f.buffer.append("A👩"); f.advance(1000);
  assert.equal(f.rendered.at(-1), "A");
  f.buffer.append("‍💻e"); f.advance(1000);
  assert.equal(f.rendered.at(-1), "A👩‍💻");
  f.buffer.append("\u0301完成"); f.advance(1000);
  assert.equal(f.rendered.at(-1), "A👩‍💻e\u0301完");
  const done=f.buffer.finish("A👩‍💻e\u0301完成");f.advance(400);await done;
  assert.equal(f.rendered.at(-1), "A👩‍💻e\u0301完成");
  assert.ok(!f.rendered.includes("A👩"));
});
