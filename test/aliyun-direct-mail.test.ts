import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "@/lib/api-errors";
import {
  readAliyunDirectMailConfig,
  sendAliyunEmailCode,
  signAliyunDirectMailParameters,
  type AliyunDirectMailConfig,
  type AliyunDirectMailRegion,
} from "@/lib/aliyun-direct-mail";

const config: AliyunDirectMailConfig = Object.freeze({
  accessKeyId: "test-access-key",
  accessKeySecret: "test-access-secret",
  regionId: "cn-hangzhou",
  accountName: "no-reply@example.com",
});
const fixedNonce = "407f1e2d-1f1f-4c3b-9b78-2d9446449f11";
const fixedNow = () => new Date("2026-10-13T01:02:03.000Z");
const testInput = { email: "  User+Tag@Example.COM ", code: "012345", purpose: "register" as const };
const dependencies = { now: fixedNow, nonce: () => fixedNonce };

function configEnv(regionId = "cn-hangzhou", accountName = "no-reply@example.com"): Record<string, string> {
  return {
    AI_PROJECT_OS_ALIYUN_DM_ACCESS_KEY_ID: config.accessKeyId,
    AI_PROJECT_OS_ALIYUN_DM_ACCESS_KEY_SECRET: config.accessKeySecret,
    AI_PROJECT_OS_ALIYUN_DM_REGION_ID: regionId,
    AI_PROJECT_OS_ALIYUN_DM_ACCOUNT_NAME: accountName,
  };
}

function captureFetch(responseBody: unknown = { RequestId: "request-123", EnvId: "600000987654" }) {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    calls.push({ url: new URL(String(input)), init });
    return new Response(JSON.stringify(responseBody), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { calls, fetchImpl };
}

function assertApiError(error: unknown, status: number, code: string): boolean {
  return error instanceof ApiError && error.status === status && error.code === code;
}

test("DirectMail HMAC-SHA1 signature matches Alibaba's published test vector", () => {
  const signature = signAliyunDirectMailParameters({
    AccessKeyId: "testid",
    AccountName: "<a%b'>",
    Action: "SingleSendMail",
    AddressType: 1,
    Format: "XML",
    HtmlBody: 4,
    RegionId: "cn-hangzhou",
    ReplyToAddress: true,
    SignatureMethod: "HMAC-SHA1",
    SignatureNonce: "c1b2c332-4cfb-4a0f-b8cc-ebe622aa0a5c",
    SignatureVersion: "1.0",
    Subject: 3,
    TagName: 2,
    Timestamp: "2016-10-20T06:27:56Z",
    ToAddress: "1@test.com",
    Version: "2015-11-23",
  }, "testsecret");

  assert.equal(signature, "llJfXJjBW3OacrVgxxsITgYaYm0=");
  assert.equal(signAliyunDirectMailParameters({ Signature: "ignored", Subject: "test" }, "testsecret"), signAliyunDirectMailParameters({ Subject: "test" }, "testsecret"));
});

test("DirectMail config requires all settings and validates region and sender", () => {
  assert.deepEqual(readAliyunDirectMailConfig(configEnv()), config);
  assert.equal(readAliyunDirectMailConfig(configEnv("cn-hangzhou", "No-Reply@Example.com")).accountName, "No-Reply@Example.com");
  assert.throws(() => readAliyunDirectMailConfig({}), (error: unknown) => assertApiError(error, 503, "EMAIL_NOT_CONFIGURED"));
  assert.throws(() => readAliyunDirectMailConfig(configEnv("cn-beijing")), (error: unknown) => assertApiError(error, 503, "EMAIL_NOT_CONFIGURED"));
  assert.throws(() => readAliyunDirectMailConfig(configEnv("cn-hangzhou", "bad sender")), (error: unknown) => assertApiError(error, 503, "EMAIL_NOT_CONFIGURED"));
  assert.throws(() => readAliyunDirectMailConfig({ ...configEnv(), AI_PROJECT_OS_ALIYUN_DM_ACCESS_KEY_SECRET: "bad\nsecret" }), (error: unknown) => assertApiError(error, 503, "EMAIL_NOT_CONFIGURED"));
});

test("DirectMail uses only the five fixed public HTTPS endpoints", async () => {
  const endpoints: Readonly<Record<AliyunDirectMailRegion, string>> = {
    "cn-hangzhou": "dm.aliyuncs.com",
    "ap-southeast-1": "dm.ap-southeast-1.aliyuncs.com",
    "ap-southeast-2": "dm.ap-southeast-2.aliyuncs.com",
    "us-east-1": "dm.us-east-1.aliyuncs.com",
    "eu-central-1": "dm.eu-central-1.aliyuncs.com",
  };

  for (const [regionId, hostname] of Object.entries(endpoints) as Array<[AliyunDirectMailRegion, string]>) {
    const capture = captureFetch();
    await sendAliyunEmailCode(testInput, { ...config, regionId }, { ...dependencies, fetchImpl: capture.fetchImpl });
    assert.equal(capture.calls.length, 1);
    assert.equal(capture.calls[0].url.href, `https://${hostname}/`);
    assert.equal(capture.calls[0].url.search, "");
  }
});

test("SingleSendMail posts signed form data and returns only bounded safe acknowledgement IDs", async () => {
  const capture = captureFetch({ RequestId: "2D086F6-1234-5678-9012-006DED011A85", EnvId: "600000987654" });
  const result = await sendAliyunEmailCode(testInput, config, { ...dependencies, fetchImpl: capture.fetchImpl });

  assert.deepEqual(result, { requestId: "2D086F6-1234-5678-9012-006DED011A85", envId: "600000987654" });
  assert.deepEqual(Object.keys(result).sort(), ["envId", "requestId"]);
  assert.equal(capture.calls.length, 1, "billable mail must not be retried");
  const [{ url, init }] = capture.calls;
  assert.equal(url.href, "https://dm.aliyuncs.com/");
  assert.equal(init.method, "POST");
  assert.equal(init.redirect, "error");
  assert.equal(init.cache, "no-store");
  const headers = new Headers(init.headers);
  assert.equal(headers.get("content-type"), "application/x-www-form-urlencoded; charset=UTF-8");
  const body = new URLSearchParams(String(init.body));
  assert.equal(body.get("Action"), "SingleSendMail");
  assert.equal(body.get("Format"), "JSON");
  assert.equal(body.get("Version"), "2015-11-23");
  assert.equal(body.get("RegionId"), "cn-hangzhou");
  assert.equal(body.get("Timestamp"), "2026-10-13T01:02:03Z");
  assert.equal(body.get("SignatureMethod"), "HMAC-SHA1");
  assert.equal(body.get("SignatureVersion"), "1.0");
  assert.equal(body.get("SignatureNonce"), fixedNonce);
  assert.equal(body.get("AccountName"), "no-reply@example.com");
  assert.equal(body.get("AddressType"), "1");
  assert.equal(body.get("ReplyToAddress"), "false");
  assert.equal(body.get("ToAddress"), "user+tag@example.com");
  assert.equal(body.get("FromAlias"), "AI Project OS");
  assert.equal(body.get("Subject"), "AI Project OS 注册邮箱验证码");
  assert.equal(body.get("TextBody"), "你正在使用 AI Project OS 注册。验证码：012345。验证码 10 分钟内有效，请勿泄露给他人。");
  assert.equal(body.get("ClickTrace"), "0");
  const signature = body.get("Signature");
  assert.ok(signature);
  body.delete("Signature");
  const parameters = Object.fromEntries([...body.entries()].map(([name, value]) => [name, value]));
  assert.equal(signature, signAliyunDirectMailParameters(parameters, config.accessKeySecret));
  assert.equal(JSON.stringify(result).includes("012345"), false);
  assert.equal(JSON.stringify(result).includes("user+tag@example.com"), false);
});

test("register, verify, and password purposes use distinct fixed text templates", async () => {
  const subjects = new Map<string, string>();
  for (const purpose of ["register", "verify", "password"] as const) {
    const capture = captureFetch();
    await sendAliyunEmailCode({ ...testInput, purpose }, config, { ...dependencies, fetchImpl: capture.fetchImpl });
    const body = new URLSearchParams(String(capture.calls[0].init.body));
    subjects.set(purpose, body.get("Subject") ?? "");
    assert.match(body.get("TextBody") ?? "", /012345/u);
    assert.match(body.get("TextBody") ?? "", /验证码 10 分钟内有效/u);
  }
  assert.equal(new Set(subjects.values()).size, 3);
});

test("invalid request values fail with EMAIL_REQUEST_INVALID before any provider call", async () => {
  const capture = captureFetch();
  const invalidInputs = [
    { email: "用户@example.com", code: "012345", purpose: "register" as const },
    { email: "person@example.com,other@example.com", code: "012345", purpose: "register" as const },
    { email: "person..name@example.com", code: "012345", purpose: "register" as const },
    { email: "person@example.com", code: "12345", purpose: "register" as const },
    { email: "person@example.com", code: "012345", purpose: "login" as unknown as "register" },
  ];

  for (const input of invalidInputs) {
    await assert.rejects(sendAliyunEmailCode(input, config, { ...dependencies, fetchImpl: capture.fetchImpl }), (error: unknown) => assertApiError(error, 400, "EMAIL_REQUEST_INVALID"));
  }
  assert.equal(capture.calls.length, 0);
});

test("invalid supplied configs fail closed without a provider request", async () => {
  const capture = captureFetch();
  await assert.rejects(sendAliyunEmailCode(testInput, { ...config, regionId: "attacker.example" as AliyunDirectMailRegion }, { ...dependencies, fetchImpl: capture.fetchImpl }), (error: unknown) => assertApiError(error, 503, "EMAIL_NOT_CONFIGURED"));
  await assert.rejects(sendAliyunEmailCode(testInput, { ...config, accountName: "bad sender" }, { ...dependencies, fetchImpl: capture.fetchImpl }), (error: unknown) => assertApiError(error, 503, "EMAIL_NOT_CONFIGURED"));
  assert.equal(capture.calls.length, 0);
});

test("timeout, redirect, HTTP, malformed, oversized, and provider Code errors stay generic and never retry", async () => {
  for (const [label, fetchImpl] of [
    ["timeout", (async () => { throw new DOMException("request aborted", "AbortError"); }) as typeof fetch],
    ["redirect", (async () => { throw new TypeError("redirected to https://attacker.example with private trace"); }) as typeof fetch],
    ["HTTP", (async () => new Response(JSON.stringify({ Code: "AccessDenied", Message: "private provider detail" }), { status: 403 })) as typeof fetch],
    ["malformed JSON", (async () => new Response("not-json")) as typeof fetch],
    ["invalid shape", (async () => Response.json({ RequestId: "request-123" })) as typeof fetch],
    ["unsafe ID", (async () => Response.json({ RequestId: "<private>", EnvId: "600000987654" })) as typeof fetch],
    ["provider Code", (async () => Response.json({ Code: "InternalError", RequestId: "request-123", EnvId: "600000987654", Message: "private provider detail" })) as typeof fetch],
    ["oversized", (async () => new Response(`${JSON.stringify({ RequestId: "request-123", EnvId: "600000987654" })}${" ".repeat(65 * 1024)}`)) as typeof fetch],
  ] as const) {
    let calls = 0;
    const singleCallFetch: typeof fetch = async (input, init) => {
      calls += 1;
      if (label === "redirect") assert.equal(init?.redirect, "error");
      if (label === "timeout") assert.ok(init?.signal instanceof AbortSignal);
      return fetchImpl(input, init);
    };
    await assert.rejects(
      sendAliyunEmailCode(testInput, config, { ...dependencies, fetchImpl: singleCallFetch }),
      (error: unknown) => error instanceof ApiError
        && error.status === 503
        && error.code === "EMAIL_PROVIDER_UNAVAILABLE"
        && !error.message.includes("private provider detail")
        && !error.message.includes("attacker.example")
        && !error.message.includes(testInput.email)
        && !error.message.includes(testInput.code),
    );
    assert.equal(calls, 1, `${label} request must not be retried`);
  }
});
