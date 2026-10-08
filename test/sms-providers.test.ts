import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "@/lib/api-errors";
import {
  checkSmsCode,
  normalizeSmsProviderConfig,
  sendSmsCode,
  smsProviderId,
  smsProviderMetadata,
  smsProviderScheme,
  type SmsProviderConfig,
} from "@/lib/sms-providers";

const challengeId = "62ea96d1-e37f-4e46-a6a0-ec6d19e5500d";
const fixedNow = () => new Date("2026-10-06T01:02:03.000Z");
const pnvsConfig = Object.freeze({
  accessKeyId: "test-access-key",
  accessKeySecret: "test-access-secret",
  signName: "AI OS签名",
  templateCode: "100001",
  schemePrefix: "projectos",
});
const aliyunConfig = Object.freeze({
  provider: "aliyun-sms" as const,
  accessKeyId: "test-access-key",
  accessKeySecret: "test-access-secret",
  signName: "AI OS签名&测试",
  templateCode: "SMS_123456789",
  codeParamName: "code",
  validityParamName: "minutes",
});
const tencentConfig = Object.freeze({
  provider: "tencent-sms" as const,
  secretId: "test-secret-id",
  secretKey: "test-secret-key",
  smsSdkAppId: "1400006666",
  signName: "AI OS签名",
  templateId: "1110",
  region: "ap-guangzhou" as const,
  templateParams: Object.freeze(["minutes", "code"] as const),
});

function providerError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 503 && error.code === "SMS_PROVIDER_UNAVAILABLE";
}

function captureFetch(responseBody: unknown = { Code: "OK", BizId: "request-id" }) {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    calls.push({ url: new URL(String(input)), init });
    return new Response(JSON.stringify(responseBody), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
  };
  return { calls, fetchImpl };
}

test("normalizer keeps PNVS legacy JSON shape and strips an explicit legacy provider id", () => {
  const legacy = normalizeSmsProviderConfig(pnvsConfig);
  const explicit = normalizeSmsProviderConfig({ provider: "aliyun-pnvs", ...pnvsConfig });
  assert.deepEqual(legacy, pnvsConfig);
  assert.deepEqual(explicit, pnvsConfig);
  assert.deepEqual(Object.keys(legacy), ["accessKeyId", "accessKeySecret", "signName", "templateCode", "schemePrefix"]);
  assert.equal(smsProviderId(legacy), "aliyun-pnvs");
  assert.equal(smsProviderScheme("register", legacy), "projectos-register");
});

test("account security purposes use short bounded PNVS schemes while legacy names stay stable", () => {
  const longestValidLegacyPrefix = { ...pnvsConfig, schemePrefix: "p".repeat(11) };
  assert.equal(smsProviderScheme("register", longestValidLegacyPrefix), `${longestValidLegacyPrefix.schemePrefix}-register`);
  assert.equal(smsProviderScheme("close", longestValidLegacyPrefix), `${longestValidLegacyPrefix.schemePrefix}-close`);
  assert.equal(smsProviderScheme("recover", longestValidLegacyPrefix), `${longestValidLegacyPrefix.schemePrefix}-recover`);
  assert.equal(smsProviderScheme("bind", longestValidLegacyPrefix), `${longestValidLegacyPrefix.schemePrefix}-bind`);
  assert.equal(smsProviderScheme("change-old", longestValidLegacyPrefix), `${longestValidLegacyPrefix.schemePrefix}-old`);
  assert.equal(smsProviderScheme("change-new", longestValidLegacyPrefix), `${longestValidLegacyPrefix.schemePrefix}-new`);
  for (const purpose of ["register", "login", "close", "recover", "bind", "change-old", "change-new"] as const) {
    assert.ok(smsProviderScheme(purpose, longestValidLegacyPrefix).length <= 20);
  }
});

test("normalizer rejects unknown fields, URL overrides, malformed credentials, and out-of-bound PNVS values", () => {
  const invalidConfigs: unknown[] = [
    { ...pnvsConfig, endpoint: "https://sms.example.invalid" },
    { ...pnvsConfig, provider: "other" },
    { ...pnvsConfig, accessKeySecret: "https://example.invalid/key" },
    { ...pnvsConfig, accessKeySecret: "s".repeat(257) },
    { ...pnvsConfig, signName: "签".repeat(65) },
    { ...pnvsConfig, schemePrefix: "x".repeat(12) },
  ];
  for (const config of invalidConfigs) assert.throws(() => normalizeSmsProviderConfig(config), (error: unknown) => error instanceof ApiError && error.code === "SMS_NOT_CONFIGURED");
});

test("provider registry returns only public metadata and deterministic bounded schemes", () => {
  assert.equal(smsProviderId(aliyunConfig), "aliyun-sms");
  assert.equal(smsProviderId(tencentConfig), "tencent-sms");
  assert.equal(smsProviderScheme("close", aliyunConfig), "aliyun-sms-close");
  assert.equal(smsProviderScheme("test", tencentConfig), "tencent-sms-test");
  assert.deepEqual(smsProviderMetadata(aliyunConfig), {
    signName: aliyunConfig.signName,
    templateCode: aliyunConfig.templateCode,
    schemePrefix: null,
    codeParamName: "code",
    validityParamName: "minutes",
  });
  assert.deepEqual(smsProviderMetadata(tencentConfig), {
    signName: tencentConfig.signName,
    templateCode: tencentConfig.templateId,
    schemePrefix: null,
    region: "ap-guangzhou",
    smsSdkAppId: "1400006666",
    templateParams: ["minutes", "code"],
  });
  for (const metadata of [smsProviderMetadata(aliyunConfig), smsProviderMetadata(tencentConfig)]) {
    const serialized = JSON.stringify(metadata);
    assert.equal(serialized.includes("test-access-secret"), false);
    assert.equal(serialized.includes("test-secret-key"), false);
  }
});

test("registry validates provider-specific fields and exact Tencent parameter mapping", () => {
  const invalidConfigs: unknown[] = [
    { ...aliyunConfig, templateCode: "100001" },
    { ...aliyunConfig, codeParamName: "" },
    { ...aliyunConfig, validityParamName: "code" },
    { ...aliyunConfig, extra: "not accepted" },
    { ...tencentConfig, region: "ap-singapore" },
    { ...tencentConfig, templateParams: [] },
    { ...tencentConfig, templateParams: ["minutes"] },
    { ...tencentConfig, templateParams: ["code", "code"] },
    { ...tencentConfig, templateParams: ["code", "minutes", "minutes"] },
    { ...tencentConfig, endpoint: "https://sms.example.invalid" },
  ];
  for (const config of invalidConfigs) assert.throws(() => normalizeSmsProviderConfig(config), (error: unknown) => error instanceof ApiError && error.code === "SMS_NOT_CONFIGURED");
});

test("standard Aliyun SendSms uses the fixed endpoint, signed parameters, no retry, and requires BizId", async () => {
  const capture = captureFetch({ Code: "OK", BizId: "biz-123" });
  await sendSmsCode({ phoneE164: "+8613800138000", purpose: "register", challengeId, code: "012345" }, aliyunConfig, {
    now: fixedNow,
    nonce: () => "407f1e2d-1f1f-4c3b-9b78-2d9446449f11",
    fetchImpl: capture.fetchImpl,
  });

  assert.equal(capture.calls.length, 1);
  const [{ url, init }] = capture.calls;
  assert.equal(url.origin, "https://dysmsapi.aliyuncs.com");
  assert.equal(url.pathname, "/");
  assert.equal(init.method, "POST");
  assert.equal(init.redirect, "error");
  assert.equal(init.body, "");
  assert.equal(url.searchParams.get("Action"), "SendSms");
  assert.equal(url.searchParams.get("Version"), "2017-05-25");
  assert.equal(url.searchParams.get("PhoneNumbers"), "13800138000");
  assert.equal(url.searchParams.get("SignName"), aliyunConfig.signName);
  assert.equal(url.searchParams.get("TemplateCode"), "SMS_123456789");
  assert.equal(url.searchParams.get("TemplateParam"), JSON.stringify({ code: "012345", minutes: "5" }));
  assert.equal(url.searchParams.get("OutId"), challengeId);
  const headers = new Headers(init.headers);
  assert.equal(headers.get("x-acs-action"), "SendSms");
  assert.equal(headers.get("x-acs-version"), "2017-05-25");
  assert.match(headers.get("authorization") ?? "", /^ACS3-HMAC-SHA256 Credential=test-access-key,SignedHeaders=host;x-acs-action;x-acs-content-sha256;x-acs-date;x-acs-signature-nonce;x-acs-version,Signature=[a-f0-9]{64}$/u);
  assert.equal(headers.get("authorization")?.includes(aliyunConfig.accessKeySecret), false);

  for (const body of [{ Code: "OK" }, { Code: "FAIL", BizId: "biz-123" }, { Code: "OK", BizId: " " }]) {
    const failed = captureFetch(body);
    await assert.rejects(sendSmsCode({ phoneE164: "+8613800138000", purpose: "test", challengeId, code: "123456" }, aliyunConfig, { now: fixedNow, fetchImpl: failed.fetchImpl }), providerError);
    assert.equal(failed.calls.length, 1);
  }
});

test("standard Aliyun skips the validity parameter when its configured key is empty", async () => {
  const config = { ...aliyunConfig, validityParamName: "" };
  const capture = captureFetch();
  await sendSmsCode({ phoneE164: "+8613800138000", purpose: "login", challengeId, code: "654321" }, config, { now: fixedNow, fetchImpl: capture.fetchImpl });
  assert.equal(capture.calls[0].url.searchParams.get("TemplateParam"), JSON.stringify({ code: "654321" }));
});

test("Tencent SendSms signs the fixed JSON request and preserves template parameter order", async () => {
  const capture = captureFetch({
    Response: {
      SendStatusSet: [{ Code: "Ok", PhoneNumber: "+8613800138000", SerialNo: "5000:serial", SessionContext: challengeId }],
      RequestId: "request-id",
    },
  });
  await sendSmsCode({ phoneE164: "+8613800138000", purpose: "register", challengeId, code: "012345" }, tencentConfig, { now: fixedNow, fetchImpl: capture.fetchImpl });

  const [{ url, init }] = capture.calls;
  assert.equal(url.href, "https://sms.tencentcloudapi.com/");
  assert.equal(init.method, "POST");
  assert.equal(init.redirect, "error");
  assert.equal(init.body, JSON.stringify({
    PhoneNumberSet: ["+8613800138000"],
    SmsSdkAppId: "1400006666",
    SignName: "AI OS签名",
    TemplateId: "1110",
    TemplateParamSet: ["5", "012345"],
    SessionContext: challengeId,
  }));
  const headers = new Headers(init.headers);
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(headers.get("x-tc-action"), "SendSms");
  assert.equal(headers.get("x-tc-version"), "2021-01-11");
  assert.equal(headers.get("x-tc-region"), "ap-guangzhou");
  assert.equal(headers.get("x-tc-timestamp"), "1791248523");
  assert.equal(headers.get("authorization"), "TC3-HMAC-SHA256 Credential=test-secret-id/2026-10-06/sms/tc3_request, SignedHeaders=content-type;host, Signature=dbb4ae1da4c96d04194137addabbc5db621b9baf21ee447ea8c6f3d6782c2a13");
  assert.equal(headers.get("authorization")?.includes(tencentConfig.secretKey), false);
  assert.equal(capture.calls.length, 1);
});

test("Tencent accepts only one exact successful recipient status", async () => {
  const failedBodies = [
    { Response: { Error: { Code: "UnauthorizedOperation.RequestPermissionDeny" }, SendStatusSet: [] } },
    { Response: { SendStatusSet: [] } },
    { Response: { SendStatusSet: [{ Code: "FailedOperation", PhoneNumber: "+8613800138000", SerialNo: "serial" }] } },
    { Response: { SendStatusSet: [{ Code: "Ok", PhoneNumber: "+8613800138001", SerialNo: "serial" }] } },
    { Response: { SendStatusSet: [{ Code: "Ok", PhoneNumber: "+8613800138000", SerialNo: "" }] } },
    { Response: { SendStatusSet: [{ Code: "Ok", PhoneNumber: "+8613800138000", SerialNo: "serial", SessionContext: "wrong" }] } },
    { Response: { SendStatusSet: [
      { Code: "Ok", PhoneNumber: "+8613800138000", SerialNo: "serial" },
      { Code: "Ok", PhoneNumber: "+8613800138000", SerialNo: "serial-2" },
    ] } },
  ];
  for (const body of failedBodies) {
    const capture = captureFetch(body);
    await assert.rejects(sendSmsCode({ phoneE164: "+8613800138000", purpose: "register", challengeId, code: "012345" }, tencentConfig, { now: fixedNow, fetchImpl: capture.fetchImpl }), providerError);
    assert.equal(capture.calls.length, 1);
  }
});

test("provider transport errors, malformed JSON, and oversized responses stay generic", async () => {
  const transportFailure: typeof fetch = async () => { throw new Error(`provider trace ${aliyunConfig.accessKeySecret} 012345`); };
  await assert.rejects(sendSmsCode({ phoneE164: "+8613800138000", purpose: "register", challengeId, code: "012345" }, aliyunConfig, { now: fixedNow, fetchImpl: transportFailure }), (error: unknown) => {
    return error instanceof ApiError
      && providerError(error)
      && error.message.includes("短信服务暂不可用")
      && !error.message.includes(aliyunConfig.accessKeySecret)
      && !error.message.includes("012345");
  });

  const invalidJson: typeof fetch = async () => new Response("not-json", { status: 200, headers: { "content-type": "application/json" } });
  await assert.rejects(sendSmsCode({ phoneE164: "+8613800138000", purpose: "register", challengeId, code: "012345" }, aliyunConfig, { now: fixedNow, fetchImpl: invalidJson }), providerError);

  const oversized: typeof fetch = async () => new Response(`${JSON.stringify({ Code: "OK", BizId: "biz-123" })}${"x".repeat(65 * 1024)}`, { status: 200, headers: { "content-type": "application/json" } });
  await assert.rejects(sendSmsCode({ phoneE164: "+8613800138000", purpose: "register", challengeId, code: "012345" }, aliyunConfig, { now: fixedNow, fetchImpl: oversized }), providerError);
});

test("send validates local code/phone/challenge and standard providers never verify remotely", async () => {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    calls.push(String(input));
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  for (const input of [
    { phoneE164: "+14155550100", purpose: "login" as const, challengeId, code: "012345" },
    { phoneE164: "+8613800138000", purpose: "login" as const, challengeId: "invalid", code: "012345" },
    { phoneE164: "+8613800138000", purpose: "login" as const, challengeId, code: "12345" },
  ]) {
    await assert.rejects(sendSmsCode(input, aliyunConfig, { now: fixedNow, fetchImpl }), (error: unknown) => error instanceof ApiError && error.code === "SMS_REQUEST_INVALID");
  }
  await assert.rejects(checkSmsCode({ phoneE164: "+8613800138000", purpose: "login", challengeId, code: "012345" }, aliyunConfig, { fetchImpl }), providerError);
  await assert.rejects(checkSmsCode({ phoneE164: "+8613800138000", purpose: "login", challengeId, code: "012345" }, tencentConfig, { fetchImpl }), providerError);
  assert.deepEqual(calls, []);

  const pnvsCapture = captureFetch({ Code: "OK", Success: true });
  await sendSmsCode({ phoneE164: "+8613800138000", purpose: "login", challengeId }, pnvsConfig, { now: fixedNow, nonce: () => "407f1e2d-1f1f-4c3b-9b78-2d9446449f11", fetchImpl: pnvsCapture.fetchImpl });
  assert.equal(pnvsCapture.calls[0].url.origin, "https://dypnsapi.aliyuncs.com");
});

test("PNVS keeps its existing CheckSmsVerifyCode path while new providers fail closed", async () => {
  const pnvsCapture = captureFetch({ Code: "OK", Success: true, Model: { VerifyResult: "PASS" } });
  assert.equal(await checkSmsCode({ phoneE164: "+8613800138000", purpose: "login", challengeId, code: "012345" }, pnvsConfig, { now: fixedNow, nonce: () => "407f1e2d-1f1f-4c3b-9b78-2d9446449f11", fetchImpl: pnvsCapture.fetchImpl }), true);
  assert.equal(pnvsCapture.calls[0].url.searchParams.get("Action"), "CheckSmsVerifyCode");

  const capture = captureFetch({ Code: "OK", Success: true, Model: { VerifyResult: "PASS" } });
  await assert.rejects(checkSmsCode({ phoneE164: "+8613800138000", purpose: "login", challengeId, code: "012345" }, tencentConfig, { fetchImpl: capture.fetchImpl }), providerError);
  assert.equal(capture.calls.length, 0);
});

test("typed provider union remains assignable to the public config signature", () => {
  const config: SmsProviderConfig = tencentConfig;
  assert.equal(smsProviderId(config), "tencent-sms");
});
