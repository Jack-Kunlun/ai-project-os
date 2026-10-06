import assert from "node:assert/strict";
import { signAliyunAcs3 } from "@/lib/aliyun-acs3";
import test from "node:test";
import { ApiError } from "@/lib/api-errors";
import { aliyunSmsScheme, checkAliyunSmsCode, readAliyunSmsConfig, sendAliyunSmsCode, type AliyunSmsConfig } from "@/lib/aliyun-sms";

const challengeId = "62ea96d1-e37f-4e46-a6a0-ec6d19e5500d";
const fixedNonce = "407f1e2d-1f1f-4c3b-9b78-2d9446449f11";
const config: AliyunSmsConfig = Object.freeze({
  accessKeyId: "test-access-key",
  accessKeySecret: "test-access-secret",
  signName: "AI OS签名&测试",
  templateCode: "100001",
  schemePrefix: "projectos",
});
const fixedNow = () => new Date("2026-10-06T01:02:03.000Z");
const dependencies = { now: fixedNow, nonce: () => fixedNonce };

function captureFetch(responseBody: unknown = { Code: "OK", Success: true }) {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    calls.push({ url: new URL(String(input)), init });
    return new Response(JSON.stringify(responseBody), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { calls, fetchImpl };
}

function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function sampleEnv(prefix = "projectos"): Record<string,string> {
  return {
    ALIYUN_SMS_AUTH_ACCESS_KEY_ID: config.accessKeyId,
    ALIYUN_SMS_AUTH_ACCESS_KEY_SECRET: config.accessKeySecret,
    ALIYUN_SMS_AUTH_SIGN_NAME: config.signName,
    ALIYUN_SMS_AUTH_TEMPLATE_CODE: config.templateCode,
    ALIYUN_SMS_AUTH_SCHEME_PREFIX: prefix,
  };
}

test("SMS config requires every active PNVS setting and valid bounded schemes", () => {
  assert.deepEqual(readAliyunSmsConfig(sampleEnv()), config);
  assert.equal(aliyunSmsScheme("register", config), "projectos-register");
  assert.equal(aliyunSmsScheme("login", config), "projectos-login");
  assert.equal(aliyunSmsScheme("test", config), "projectos-test");
  assert.equal(aliyunSmsScheme("close", config), "projectos-close");
  assert.throws(() => readAliyunSmsConfig({}), (error: unknown) => error instanceof ApiError && error.code === "SMS_NOT_CONFIGURED" && error.status === 503);
  assert.throws(() => readAliyunSmsConfig(sampleEnv("abcdefghijkl")), (error: unknown) => error instanceof ApiError && error.code === "SMS_NOT_CONFIGURED");
});

test("PNVS SendSmsVerifyCode uses the fixed POST endpoint, safe query encoding and ACS3 signature", async () => {
  const capture = captureFetch({ Code: "OK", Success: true, Model: { VerifyCode: "should-not-escape" } });
  await sendAliyunSmsCode({ phoneE164: "+8613800138000", purpose: "register", challengeId }, config, { ...dependencies, fetchImpl: capture.fetchImpl });

  assert.equal(capture.calls.length, 1, "billable SMS must not be retried");
  const [{ url, init }] = capture.calls;
  assert.equal(url.origin, "https://dypnsapi.aliyuncs.com");
  assert.equal(url.pathname, "/");
  assert.equal(init.method, "POST");
  assert.equal(init.redirect, "error");
  assert.equal(init.body, undefined);
  assert.equal(url.searchParams.get("Action"), "SendSmsVerifyCode");
  assert.equal(url.searchParams.get("Version"), "2017-05-25");
  assert.equal(url.searchParams.get("Format"), "json");
  assert.equal(url.searchParams.get("CountryCode"), "86");
  assert.equal(url.searchParams.get("PhoneNumber"), "13800138000");
  assert.equal(url.searchParams.get("SchemeName"), "projectos-register");
  assert.equal(url.searchParams.get("SignName"), config.signName);
  assert.equal(url.searchParams.get("TemplateCode"), config.templateCode);
  assert.equal(url.searchParams.get("TemplateParam"), JSON.stringify({ code: "##code##", min: "5" }));
  assert.equal(url.searchParams.get("CodeLength"), "6");
  assert.equal(url.searchParams.get("CodeType"), "1");
  assert.equal(url.searchParams.get("ValidTime"), "300");
  assert.equal(url.searchParams.get("Interval"), "60");
  assert.equal(url.searchParams.get("DuplicatePolicy"), "1");
  assert.equal(url.searchParams.get("ReturnVerifyCode"), "false");
  assert.equal(url.searchParams.get("AutoRetry"), "0");
  assert.equal(url.searchParams.get("OutId"), challengeId);
  assert.equal(url.search, `?${[...url.searchParams.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${rfc3986(k)}=${rfc3986(v)}`).join("&")}`);
  const headers = new Headers(init.headers);
  assert.equal(headers.get("x-acs-action"), "SendSmsVerifyCode");
  assert.equal(headers.get("x-acs-version"), "2017-05-25");
  assert.equal(headers.get("x-acs-date"), "2026-10-06T01:02:03Z");
  assert.equal(headers.get("x-acs-signature-nonce"), fixedNonce);
  assert.match(headers.get("authorization")!, /^ACS3-HMAC-SHA256 Credential=test-access-key,SignedHeaders=host;x-acs-action;x-acs-content-sha256;x-acs-date;x-acs-signature-nonce;x-acs-version,Signature=[a-f0-9]{64}$/u);
  assert.equal(url.search.includes(config.accessKeySecret), false);
});

test("PNVS CheckSmsVerifyCode returns true only for the documented PASS result", async () => {
  const pass = captureFetch({ Code: "OK", Success: true, Model: { VerifyResult: "PASS", OutId: challengeId } });
  assert.equal(await checkAliyunSmsCode({ phoneE164: "+8613800138000", purpose: "login", challengeId, code: "012345" }, config, { ...dependencies, fetchImpl: pass.fetchImpl }), true);
  const [passCall] = pass.calls;
  assert.equal(passCall.url.searchParams.get("Action"), "CheckSmsVerifyCode");
  assert.equal(passCall.url.searchParams.get("VerifyCode"), "012345");
  assert.equal(passCall.url.searchParams.get("SchemeName"), "projectos-login");

  for (const providerResult of [
    { Code: "OK", Success: true, Model: { VerifyResult: "UNKNOWN" } },
    { Code: "OK", Success: true, Model: { VerifyResult: "unexpected" } },
  ]) {
    const failed = captureFetch(providerResult);
    assert.equal(await checkAliyunSmsCode({ phoneE164: "+8613800138000", purpose: "login", challengeId, code: "012345" }, config, { ...dependencies, fetchImpl: failed.fetchImpl }), false);
  }
});

test("provider failures and oversized responses stay generic and do not disclose provider payloads", async () => {
  const failureFetch: typeof fetch = async () => new Response(JSON.stringify({ Code: "BILLING_DEBUG", Message: "secret diagnostic", Model: { VerifyCode: "654321" } }), { status: 503 });
  await assert.rejects(
    sendAliyunSmsCode({ phoneE164: "+8613800138000", purpose: "test", challengeId }, config, { ...dependencies, fetchImpl: failureFetch }),
    (error: unknown) => error instanceof ApiError && error.status === 503 && error.code === "SMS_PROVIDER_UNAVAILABLE" && !error.message.includes("secret diagnostic") && !error.message.includes("654321"),
  );

  const oversizedFetch: typeof fetch = async () => new Response(`${JSON.stringify({ Code: "OK", Success: true })}${" ".repeat(65 * 1024)}`, { status: 200 });
  await assert.rejects(
    sendAliyunSmsCode({ phoneE164: "+8613800138000", purpose: "test", challengeId }, config, { ...dependencies, fetchImpl: oversizedFetch }),
    (error: unknown) => error instanceof ApiError && error.code === "SMS_PROVIDER_UNAVAILABLE",
  );
});

test("PNVS check permission rejection gives fixed guidance without exposing the provider payload", async () => {
  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({
    Code: "Forbidden.NoPermission", Message: `private-detail ${config.accessKeySecret}`,
    AccessDeniedDetail: "private-policy", Model: { VerifyResult: "PASS" },
  }), { status: 403 });
  await assert.rejects(checkAliyunSmsCode({ phoneE164: "+8613800138000", purpose: "test", challengeId, code: "012345" }, config, { ...dependencies, fetchImpl }),
    (error: unknown) => error instanceof ApiError && error.status === 503
      && error.code === "SMS_PROVIDER_VERIFY_PERMISSION_DENIED"
      && error.message.includes("dypns:CheckSmsVerifyCode")
      && !error.message.includes(config.accessKeySecret) && !error.message.includes("private"));
  await assert.rejects(sendAliyunSmsCode({ phoneE164: "+8613800138000", purpose: "test", challengeId }, config, { ...dependencies, fetchImpl }),
    (error: unknown) => error instanceof ApiError && error.code === "SMS_PROVIDER_UNAVAILABLE");
});

test("unrecognized, malformed and oversized check permission responses remain fail closed", async () => {
  for (const body of [JSON.stringify({ Code: "OTHER", Message: "private-detail" }), "invalid-json",
    `${JSON.stringify({ Code: "Forbidden.NoPermission" })}${" ".repeat(65 * 1024)}`]) {
    const fetchImpl: typeof fetch = async () => new Response(body, { status: 403 });
    await assert.rejects(checkAliyunSmsCode({ phoneE164: "+8613800138000", purpose: "test", challengeId, code: "012345" }, config, { ...dependencies, fetchImpl }),
      (error: unknown) => error instanceof ApiError && error.code === "SMS_PROVIDER_UNAVAILABLE" && !error.message.includes("private-detail"));
  }
});

// Golden expected output published by Aliyun, independent of this implementation:
// https://help.aliyun.com/zh/sdk/product-overview/v3-request-structure-and-signature
// 固定参数示例 (RunInstances, YourAccessKeyId / YourAccessKeySecret).
test("ACS3 signature matches the official independently published known vector",()=>{
 const empty="e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
 assert.equal(signAliyunAcs3({method:"POST",query:"ImageId=win2019_1809_x64_dtc_zh-cn_40G_alibase_20230811.vhd&RegionId=cn-shanghai",headers:{host:"ecs.cn-shanghai.aliyuncs.com","x-acs-action":"RunInstances","x-acs-content-sha256":empty,"x-acs-date":"2023-10-26T10:22:32Z","x-acs-signature-nonce":"3156853299f313e23d1673dc12e1703d","x-acs-version":"2014-05-26"},payloadHash:empty,accessKeyId:"YourAccessKeyId",accessKeySecret:"YourAccessKeySecret"}),"ACS3-HMAC-SHA256 Credential=YourAccessKeyId,SignedHeaders=host;x-acs-action;x-acs-content-sha256;x-acs-date;x-acs-signature-nonce;x-acs-version,Signature=06563a9e1b43f5dfe96b81484da74bceab24a1d853912eee15083a6f0f3283c0");
});
test("HTTP success or malformed provider models never becomes authentication proof",async()=>{
 for(const body of [{Code:"OK",Success:true},{Code:"OK",Success:true,Model:{VerifyResult:"pass"}},{Code:"OK",Success:false,Model:{VerifyResult:"PASS"}},{Code:"FAILED",Success:true,Model:{VerifyResult:"PASS"}}]){
  const capture=captureFetch(body);
  if(body.Success===true&&body.Code==="OK")assert.equal(await checkAliyunSmsCode({phoneE164:"+8613800138000",purpose:"close",challengeId,code:"012345"},config,{...dependencies,fetchImpl:capture.fetchImpl}),false);
  else await assert.rejects(checkAliyunSmsCode({phoneE164:"+8613800138000",purpose:"close",challengeId,code:"012345"},config,{...dependencies,fetchImpl:capture.fetchImpl}),ApiError);
 }
});
test("transport errors redact URLs and verification codes; requests do not follow redirects or retry",async()=>{
 let calls=0;
 const fetchImpl:typeof fetch=async(input)=>{calls++;throw new Error(`secret-provider-trace ${String(input)} ${config.accessKeySecret}`);};
 await assert.rejects(checkAliyunSmsCode({phoneE164:"+8613800138000",purpose:"login",challengeId,code:"012345"},config,{...dependencies,fetchImpl}),(e:unknown)=>e instanceof ApiError&&e.code==="SMS_PROVIDER_UNAVAILABLE"&&!e.message.includes("012345")&&!e.message.includes("aliyuncs")&&!e.message.includes(config.accessKeySecret));
 assert.equal(calls,1);
});
