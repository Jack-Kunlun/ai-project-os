import assert from "node:assert/strict";
import test from "node:test";
import { parseRateLimitRetryAfter, readSmsSendResponse } from "@/lib/sms-send-response";

const NOW = Date.parse("2026-10-13T03:00:00.000Z");
const CHALLENGE_ID = "c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
const SMS = { channel: "sms", allowedCode: "PHONE_AUTH_RATE_LIMITED" } as const;
const EMAIL = { channel: "email", allowedCode: "EMAIL_AUTH_RATE_LIMITED" } as const;

test("edge HTML 429 is shown as a protection limit without starting the SMS cooldown", async () => {
  const result = await readSmsSendResponse(new Response("<html>upstream busy</html>", {
    status: 429,
    headers: { "content-type": "text/html", "retry-after": "90" },
  }), SMS, NOW);

  assert.deepEqual(result, {
    kind: "error",
    message: "短信请求触发网络防护限制，请稍后重试。",
  });
  assert.equal(result.message.includes("<html>"), false);
});

test("application SMS JSON 429 preserves the server message and starts its cooldown", async () => {
  const result = await readSmsSendResponse(Response.json({ error: { code: "PHONE_AUTH_RATE_LIMITED", message: "操作过于频繁" } }, {
    status: 429,
    headers: { "retry-after": "120" },
  }), SMS, NOW);

  assert.deepEqual(result, {
    kind: "rate-limited",
    retryAfterSeconds: 120,
    message: "短信发送受限：操作过于频繁 请在 120 秒后重试。",
  });
});

test("other JSON 429 errors do not become SMS cooldowns", async () => {
  const result = await readSmsSendResponse(Response.json({ error: { code: "GRAPHIC_CAPTCHA_RATE_LIMITED", message: "获取图形验证码过于频繁，请稍后再试" } }, {
    status: 429,
  }), SMS, NOW);

  assert.deepEqual(result, {
    kind: "error",
    message: "获取图形验证码过于频繁，请稍后再试",
  });
});

test("email application 429 uses email wording and starts the email cooldown", async () => {
  const result = await readSmsSendResponse(Response.json({ error: { code: "EMAIL_AUTH_RATE_LIMITED", message: "操作过于频繁" } }, {
    status: 429,
    headers: { "retry-after": "90" },
  }), EMAIL, NOW);

  assert.deepEqual(result, {
    kind: "rate-limited",
    retryAfterSeconds: 90,
    message: "邮件发送受限：操作过于频繁 请在 90 秒后重试。",
  });
});

test("SMS and email cooldowns require their own application error code", async () => {
  const emailInSmsFlow = await readSmsSendResponse(Response.json({ error: { code: "EMAIL_AUTH_RATE_LIMITED", message: "操作过于频繁" } }, { status: 429 }), SMS, NOW);
  const smsInEmailFlow = await readSmsSendResponse(Response.json({ error: { code: "PHONE_AUTH_RATE_LIMITED", message: "操作过于频繁" } }, { status: 429 }), EMAIL, NOW);
  const captchaInEmailFlow = await readSmsSendResponse(Response.json({ error: { code: "GRAPHIC_CAPTCHA_RATE_LIMITED", message: "图形验证码请求过于频繁" } }, { status: 429 }), EMAIL, NOW);
  const edgeInEmailFlow = await readSmsSendResponse(new Response("<html>upstream busy</html>", { status: 429 }), EMAIL, NOW);

  assert.deepEqual(emailInSmsFlow, { kind: "error", message: "操作过于频繁" });
  assert.deepEqual(smsInEmailFlow, { kind: "error", message: "操作过于频繁" });
  assert.deepEqual(captchaInEmailFlow, { kind: "error", message: "图形验证码请求过于频繁" });
  assert.deepEqual(edgeInEmailFlow, { kind: "error", message: "邮件请求触发网络防护限制，请稍后重试。" });
});

test("Retry-After accepts HTTP dates and clamps values to safe bounds", () => {
  assert.equal(parseRateLimitRetryAfter("Tue, 13 Oct 2026 03:02:30 GMT", NOW), 150);
  assert.equal(parseRateLimitRetryAfter("Tue, 13 Oct 2026 02:59:00 GMT", NOW), 60);
  assert.equal(parseRateLimitRetryAfter("2", NOW), 60);
  assert.equal(parseRateLimitRetryAfter("7200", NOW), 3_600);
});

test("missing and invalid Retry-After values use the default cooldown", () => {
  for (const value of [null, "", "later", "1.5", "not a date", "x".repeat(129)]) {
    assert.equal(parseRateLimitRetryAfter(value, NOW), 60, `header: ${String(value).slice(0, 24)}`);
  }
});

test("non-429 JSON errors keep the server message and other failures use the fallback", async () => {
  const jsonError = await readSmsSendResponse(Response.json({ error: { message: "图形验证已过期" } }, { status: 400 }), SMS, NOW);
  const htmlError = await readSmsSendResponse(new Response("<html>bad gateway</html>", { status: 502 }), SMS, NOW);

  assert.deepEqual(jsonError, { kind: "error", message: "图形验证已过期" });
  assert.deepEqual(htmlError, { kind: "error", message: "验证码暂时无法发送，请稍后重试。" });
});

test("a valid UUID response keeps the existing success cooldown and malformed responses fail", async () => {
  const success = await readSmsSendResponse(Response.json({ challengeId: CHALLENGE_ID, retryAfterSeconds: 75 }), SMS, NOW);
  const invalidUuid = await readSmsSendResponse(Response.json({ challengeId: "not-a-uuid" }), SMS, NOW);
  const malformedJson = await readSmsSendResponse(new Response("not-json", { status: 200 }), SMS, NOW);

  assert.deepEqual(success, { kind: "success", challengeId: CHALLENGE_ID, retryAfterSeconds: 75 });
  assert.deepEqual(invalidUuid, { kind: "error", message: "验证码暂时无法发送，请稍后重试。" });
  assert.deepEqual(malformedJson, { kind: "error", message: "验证码暂时无法发送，请稍后重试。" });
});
