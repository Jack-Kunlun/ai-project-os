import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { ApiError } from "@/lib/api-errors";
import { getEntitlementDb } from "@/lib/db";
import { openSmsConfig, phoneAuthSecret, sealSmsConfig } from "@/lib/phone-auth-config";
import { smsCodeDigest } from "@/lib/phone-auth-identity";
import { issueSmsChallenge, loginWithSms, registerPhoneAccount, verifyPhoneChallenge } from "@/lib/phone-auth-service";
import { getSmsProviderAdminState, saveSmsProviderConfig, sendSmsProviderProbe, verifySmsProviderProbe } from "@/lib/sms-provider-admin-service";
import type { SmsProviderConfig } from "@/lib/sms-providers";
import { issueGraphicCaptchaFixture } from "./graphic-captcha-fixture";
import { seedVerifiedSmsConfigFixture } from "./sms-provider-config-fixture";

const enabled = process.env.PHONE_AUTH_POSTGRES_GATE === "1";
function isolated(name: string) {
  const value = process.env[name];
  if (!value) throw new Error("ISOLATED_PROVIDER_DATABASE_REQUIRED");
  const u = new URL(value);
  if (!["postgresql:", "postgres:"].includes(u.protocol) || u.hostname !== "127.0.0.1" || u.port !== "56329" || u.pathname !== "/ai_project_os_phone_auth_test" || u.search || u.hash) throw new Error("ISOLATED_PROVIDER_DATABASE_REQUIRED");
}
const pnvs = { accessKeyId: "adapter-key", accessKeySecret: "isolated-adapter-secret", signName: "隔离测试", templateCode: "100001", schemePrefix: "adapter" };
const aliyun = { provider: "aliyun-sms", accessKeyId: "adapter-enterprise-key", accessKeySecret: "isolated-enterprise-secret", signName: "隔离测试", templateCode: "SMS_123456", codeParamName: "otp", validityParamName: "ttl" } as const;
const tencent = { provider: "tencent-sms", secretId: "adapter-tencent-id", secretKey: "isolated-tencent-secret", smsSdkAppId: "140000001", signName: "隔离测试", templateId: "123456", region: "ap-guangzhou", templateParams: ["minutes", "code"] } as const;
const invalidOtp = (e: unknown) => e instanceof ApiError && e.code === "PHONE_AUTH_CODE_INVALID";

test("three SMS providers require verified configuration and standard OTPs are locally one-use", { skip: !enabled }, async (t) => {
  isolated("PHONE_AUTH_TEST_DATABASE_URL"); isolated("PHONE_AUTH_TEST_OWNER_URL");
  const db = getEntitlementDb();
  const actor = { id: randomUUID(), role: "admin", accountAccessVersion: 1 } as const;
  await db.appUser.create({ data: { id: actor.id, role: "admin", username: `adapter_admin_${actor.id.slice(0, 8)}` } });
  const prior = await db.smsProviderConfig.findUnique({ where: { id: "active" } });
  await db.smsProviderConfig.deleteMany();
  const savedFetch = globalThis.fetch;
  const codes = new Map<string, string>();
  let checkRequests = 0, sends = 0, nextPhone = 0;
  const phone = () => `13800008${String(++nextPhone).padStart(3, "0")}`;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(init?.redirect, "error"); assert.equal(init?.method, "POST");
    let body: unknown;
    if (url.origin === "https://dypnsapi.aliyuncs.com") {
      if (url.searchParams.get("Action") === "SendSmsVerifyCode") {
        sends++; codes.set(url.searchParams.get("OutId")!, "123456"); body = { Code: "OK", Success: true };
      } else {
        assert.equal(url.searchParams.get("Action"), "CheckSmsVerifyCode"); checkRequests++;
        body = { Code: "OK", Success: true, Model: { VerifyResult: url.searchParams.get("VerifyCode") === "123456" ? "PASS" : "FAIL" } };
      }
    } else if (url.origin === "https://dysmsapi.aliyuncs.com") {
      assert.equal(url.searchParams.get("Action"), "SendSms");
      const params = JSON.parse(url.searchParams.get("TemplateParam")!) as { otp: string; ttl: string };
      assert.match(params.otp, /^[0-9]{6}$/u); assert.equal(params.ttl, "5");
      codes.set(url.searchParams.get("OutId")!, params.otp); sends++; body = { Code: "OK", BizId: "isolated-biz-id" };
    } else {
      assert.equal(url.origin, "https://sms.tencentcloudapi.com");
      const payload = JSON.parse(String(init?.body)) as { SessionContext: string; PhoneNumberSet: string[]; TemplateParamSet: string[] };
      assert.equal(payload.TemplateParamSet[0], "5"); assert.match(payload.TemplateParamSet[1], /^[0-9]{6}$/u);
      codes.set(payload.SessionContext, payload.TemplateParamSet[1]); sends++;
      body = { Response: { SendStatusSet: [{ Code: "Ok", SerialNo: "isolated-serial", PhoneNumber: payload.PhoneNumberSet[0], SessionContext: payload.SessionContext }] } };
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  async function probe(config: SmsProviderConfig, version: number) {
    const number = phone();
    const captcha = await issueGraphicCaptchaFixture({ phone: number, purpose: "test", actor }, db);
    return sendSmsProviderProbe({ config, expectedVersion: version, phone: number, captcha: captcha.captcha }, actor, db, captcha.browserToken);
  }
  async function activate(config: SmsProviderConfig, version: number) {
    const started = await probe(config, version);
    await assert.rejects(saveSmsProviderConfig({ probeId: started.probeId, expectedVersion: version }, actor, db), ApiError);
    await verifySmsProviderProbe({ probeId: started.probeId, code: codes.get(started.probeId)! }, actor, db);
    return saveSmsProviderConfig({ probeId: started.probeId, expectedVersion: version }, actor, db);
  }
  async function issue(purpose: "login" | "register" = "login") {
    const number = phone();
    const captcha = await issueGraphicCaptchaFixture({ phone: number, purpose }, db);
    const result = await issueSmsChallenge({ phone: number, purpose, ...captcha }, db);
    return { phone: number, challengeId: result.challengeId, code: codes.get(result.challengeId)! };
  }
  try {
    await t.test("first active INSERT without a verified probe is rejected by PostgreSQL", async () => {
      const sealed = await sealSmsConfig(pnvs, "active");
      await assert.rejects(db.$transaction(async tx => {
        await tx.$executeRaw`SELECT set_config('app.sms_provider_admin_context','service-v1',true)`;
        await tx.smsProviderConfig.create({ data: { id: "active", provider: "aliyun-pnvs", version: 1, enabled: true, updatedById: actor.id, verifiedAt: new Date(), ...sealed } });
      }));
      assert.equal(await db.smsProviderConfig.count(), 0); assert.equal(sends, 0);
    });
    await t.test("PNVS legacy encryption and verified initial activation remain compatible", async () => {
      const sealed = await sealSmsConfig(pnvs, "active");
      assert.deepEqual(await openSmsConfig(sealed, "active"), pnvs);
      await assert.rejects(openSmsConfig({ ...sealed, provider: "aliyun-sms" }, "active"), ApiError);
      const result = await activate(pnvs, 0);
      assert.equal(result.config.provider, "aliyun-pnvs"); assert.equal(result.config.version, 1);
    });
    await t.test("switch without proof fails; an Aliyun verified test activates the new protocol", async () => {
      const sealed = await sealSmsConfig(aliyun, "active");
      await assert.rejects(db.$transaction(async tx => {
        await tx.$executeRaw`SELECT set_config('app.sms_provider_admin_context','service-v1',true)`;
        await tx.smsProviderConfig.update({ where: { id: "active" }, data: { provider: "aliyun-sms", version: 2, ...sealed } });
      }));
      const result = await activate(aliyun, 1);
      assert.equal(result.config.provider, "aliyun-sms"); assert.equal(result.config.version, 2);
      assert.equal(result.config.codeParamName, "otp");
      const active = await db.smsProviderConfig.findUniqueOrThrow({ where: { id: "active" } });
      assert.deepEqual(await openSmsConfig(active, "active"), aliyun);
      await assert.rejects(openSmsConfig({ ...active, provider: "tencent-sms" }, "active"), ApiError);
      const publicState = JSON.stringify(await getSmsProviderAdminState(actor, db));
      assert.equal(publicState.includes(aliyun.accessKeySecret), false); assert.equal(publicState.includes(aliyun.accessKeyId), false);
    });
    await t.test("standard admin codes count wrong attempts and cannot unlock a configuration after five guesses", async () => {
      const started = await probe(aliyun, 2);
      const code = codes.get(started.probeId)!; const wrong = code === "000000" ? "000001" : "000000";
      const before = checkRequests;
      for (let i = 0; i < 5; i++) await assert.rejects(verifySmsProviderProbe({ probeId: started.probeId, code: wrong }, actor, db), (e: unknown) => e instanceof ApiError && e.code === "SMS_PROVIDER_TEST_CODE_INVALID");
      await assert.rejects(verifySmsProviderProbe({ probeId: started.probeId, code }, actor, db), ApiError);
      const row = await db.smsProviderProbe.findUniqueOrThrow({ where: { id: started.probeId } });
      assert.equal(row.attemptCount, 5); assert.equal(row.status, "failed"); assert.equal(checkRequests, before);
    });
    await t.test("Aliyun registration stores only a keyed expected digest and verifies locally", async () => {
      const input = await issue("register"); const before = checkRequests;
      const row = await db.smsAuthChallenge.findUniqueOrThrow({ where: { id: input.challengeId } });
      assert.equal(row.expectedCodeDigest, smsCodeDigest({ id: input.challengeId, phone: "+86" + input.phone, purpose: "register", code: input.code }, phoneAuthSecret()));
      assert.equal(row.codeDigest, null); assert.equal(row.verifiedAt, null);
      await assert.rejects(db.smsAuthChallenge.update({ where: { id: row.id }, data: { expectedCodeDigest: "0".repeat(64) } }));
      await assert.rejects(db.smsAuthChallenge.update({ where: { id: row.id }, data: { codeDigest: "0".repeat(64), verifiedAt: new Date() } }));
      const result = await registerPhoneAccount({ ...input, username: `adapter_user_${randomUUID().slice(0, 8)}`, password: "AdapterAcceptance_2026" }, db);
      assert.equal(result.user.role, "user"); assert.equal(checkRequests, before);
      await assert.rejects(registerPhoneAccount({ ...input, username: `adapter_replay_${randomUUID().slice(0, 8)}`, password: "AdapterAcceptance_2026" }, db), invalidOtp);
    });
    await t.test("public wrong OTP attempts persist and expiry rejects even the correct code", async () => {
      const input = await issue(); const wrong = input.code === "000000" ? "000001" : "000000";
      for (let i = 0; i < 5; i++) await assert.rejects(verifyPhoneChallenge({ ...input, code: wrong }, "login", db), invalidOtp);
      await assert.rejects(verifyPhoneChallenge(input, "login", db), invalidOtp);
      assert.equal((await db.smsAuthChallenge.findUniqueOrThrow({ where: { id: input.challengeId } })).attemptCount, 5);
      const expired = await issue();
      await db.$executeRaw`UPDATE "SmsAuthChallenge" SET "createdAt"=CURRENT_TIMESTAMP-interval '6 minutes',"expiresAt"=CURRENT_TIMESTAMP-interval '1 minute' WHERE "id"=${expired.challengeId}::uuid`;
      await assert.rejects(verifyPhoneChallenge(expired, "login", db), invalidOtp);
    });
    await t.test("switch to Tencent invalidates verified unused challenges and candidate probes", async () => {
      const input = await issue(); await verifyPhoneChallenge(input, "login", db);
      const oldProbe = await probe(aliyun, 2);
      const result = await activate(tencent, 2);
      assert.equal(result.config.provider, "tencent-sms"); assert.equal(result.config.version, 3);
      assert.equal(result.config.smsSdkAppId, tencent.smsSdkAppId); assert.deepEqual(result.config.templateParams, ["minutes", "code"]);
      await assert.rejects(loginWithSms(input, db), invalidOtp);
      assert.equal((await db.smsAuthChallenge.findUniqueOrThrow({ where: { id: input.challengeId } })).status, "superseded");
      assert.equal((await db.smsProviderProbe.findUniqueOrThrow({ where: { id: oldProbe.probeId } })).status, "failed");
    });
    await t.test("Tencent local OTP creates exactly one user under concurrent consumption and rejects replay", async () => {
      const input = await issue(); const before = checkRequests;
      const results = await Promise.allSettled([loginWithSms(input, db), loginWithSms(input, db)]);
      assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
      assert.equal(await db.appUser.count({ where: { phoneE164: "+86" + input.phone } }), 1);
      await assert.rejects(loginWithSms(input, db), invalidOtp); assert.equal(checkRequests, before);
      const state = JSON.stringify(await getSmsProviderAdminState(actor, db));
      assert.equal(state.includes(tencent.secretId), false); assert.equal(state.includes(tencent.secretKey), false);
    });
  } finally {
    globalThis.fetch = savedFetch;
    await db.$transaction(async tx => {
      await tx.smsProviderConfig.deleteMany();
      if (prior) await seedVerifiedSmsConfigFixture(tx, prior);
    });
  }
});
