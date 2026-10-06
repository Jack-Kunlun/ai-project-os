import { seedVerifiedSmsConfigFixture } from "./sms-provider-config-fixture";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { newCaptchaBrowserToken } from "@/lib/graphic-captcha-cookie";
import { issueGraphicCaptchaFixture } from "./graphic-captcha-fixture";
import test from "node:test";
import { getEntitlementDb } from "../src/lib/db";
import { phoneAuthSecret } from "../src/lib/phone-auth-config";
import { phoneFingerprint } from "../src/lib/phone-auth-identity";
import {
  getSmsProviderAdminState,
  saveSmsProviderConfig,
  sendSmsProviderProbe,
  setSmsProviderEnabled,
  verifySmsProviderProbe,
} from "../src/lib/sms-provider-admin-service";
import { ApiError } from "../src/lib/api-errors";

const enabled = process.env.PHONE_AUTH_POSTGRES_GATE === "1";
const EXPECTED_DATABASE = "/ai_project_os_phone_auth_test";
function isolatedDatabaseUrl(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error("PHONE_AUTH_ISOLATED_URL_REQUIRED");
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error("PHONE_AUTH_ISOLATED_URL_INVALID"); }
  if (!["postgresql:", "postgres:"].includes(parsed.protocol) || parsed.hostname !== "127.0.0.1" || parsed.port !== "56329"
    || parsed.pathname !== EXPECTED_DATABASE || parsed.search !== "" || parsed.hash !== "") throw new Error("PHONE_AUTH_ISOLATED_URL_INVALID");
  return value;
}

const candidate = {
  accessKeyId: "LTAIphoneauthgate",
  accessKeySecret: "isolated-test-only-secret",
  signName: "隔离测试签名",
  templateCode: "10000001",
  schemePrefix: "phgate",
};

test("admin SMS configuration is test-before-save, encrypted, versioned, and invalidates old challenges", { skip: !enabled }, async (t) => {
  // Reject accidental connections to production or a shared developer database before creating any records.
  isolatedDatabaseUrl("PHONE_AUTH_TEST_DATABASE_URL");
  isolatedDatabaseUrl("PHONE_AUTH_TEST_OWNER_URL");
  const db = getEntitlementDb();
  const id = randomUUID();
  const actor = { id, role: "admin", accountAccessVersion: 1 } as const;
  const outsider = { id: randomUUID(), role: "user", accountAccessVersion: 1 } as const;
  const phone = "13800000991";
  const code = "123456";
  const savedFetch = globalThis.fetch;
  const seenActions: string[] = [];
  const priorConfig = await db.smsProviderConfig.findUnique({ where: { id: "active" } });
  await db.smsProviderConfig.deleteMany({ where: { id: "active" } });

  await db.appUser.create({ data: { id, username: `sms_admin_${id.slice(0, 8)}`, role: "admin" } });
  await db.appUser.create({ data: { id: outsider.id, username: `sms_user_${outsider.id.slice(0, 8)}`, role: "user" } });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input instanceof URL ? input.href : input);
    assert.equal(url.origin, "https://dypnsapi.aliyuncs.com");
    assert.equal(url.pathname, "/");
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "error");
    assert.match(new Headers(init?.headers).get("authorization") ?? "", /^ACS3-HMAC-SHA256 /u);
    const action = url.searchParams.get("Action");
    assert.ok(action === "SendSmsVerifyCode" || action === "CheckSmsVerifyCode");
    seenActions.push(action);
    if (action === "SendSmsVerifyCode") {
      assert.equal(url.searchParams.get("PhoneNumber"), phone);
      assert.equal(url.searchParams.get("CountryCode"), "86");
      return new Response(JSON.stringify({ Code: "OK", Success: true }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const valid = url.searchParams.get("VerifyCode") === code;
    return new Response(JSON.stringify({ Code: "OK", Success: true, Model: { VerifyResult: valid ? "PASS" : "FAIL" } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  try {
    await t.test("rejects non-admin operators before configuration or provider changes", async () => {
      await assert.rejects(() => getSmsProviderAdminState(outsider), (error: unknown) => error instanceof ApiError && error.status === 403);
      await assert.rejects(() => sendSmsProviderProbe({ config: candidate, phone, expectedVersion: 0, captcha: { challengeId: randomUUID(), answer: "ABCDEF" } }, outsider, db, newCaptchaBrowserToken()), (error: unknown) => error instanceof ApiError && error.status === 403);
      assert.deepEqual(seenActions, []);
    });

    await t.test("real provider send and verification are required before encrypted activation", async () => {
      const captcha = await issueGraphicCaptchaFixture({ phone, purpose: "test", actor }, db);
      const started = await sendSmsProviderProbe({ config: candidate, phone, expectedVersion: 0, captcha: captcha.captcha }, actor, db, captcha.browserToken);
      const probe = await db.smsProviderProbe.findUniqueOrThrow({ where: { id: started.probeId } });
      assert.equal(probe.status, "sent");
      assert.equal(probe.attemptCount, 0);
      assert.equal(probe.actorId, actor.id);
      assert.notEqual(Buffer.from(probe.ciphertext).toString("utf8").includes(candidate.accessKeySecret), true);
      await assert.rejects(() => saveSmsProviderConfig({ probeId: started.probeId, expectedVersion: 0 }, actor), ApiError);

      await assert.rejects(() => verifySmsProviderProbe({ probeId: started.probeId, code: "000000" }, actor), (error: unknown) => error instanceof ApiError && error.code === "SMS_PROVIDER_TEST_CODE_INVALID");
      assert.equal((await db.smsProviderProbe.findUniqueOrThrow({ where: { id: started.probeId } })).attemptCount, 1);
      assert.equal((await verifySmsProviderProbe({ probeId: started.probeId, code }, actor)).verified, true);
      const checksBeforeRetry = seenActions.filter((action) => action === "CheckSmsVerifyCode").length;
      assert.equal((await verifySmsProviderProbe({ probeId: started.probeId, code }, actor)).verified, true);
      assert.equal(seenActions.filter((action) => action === "CheckSmsVerifyCode").length, checksBeforeRetry);

      const saved = await saveSmsProviderConfig({ probeId: started.probeId, expectedVersion: 0 }, actor);
      assert.equal(saved.config.version, 1);
      assert.equal(saved.config.enabled, true);
      assert.equal(saved.config.signName, candidate.signName);
      const active = await db.smsProviderConfig.findUniqueOrThrow({ where: { id: "active" } });
      assert.equal(Buffer.from(active.ciphertext).toString("utf8").includes(candidate.accessKeySecret), false);
      const publicState = await getSmsProviderAdminState(actor);
      const responseText = JSON.stringify(publicState);
      assert.equal(responseText.includes(candidate.accessKeyId), false);
      assert.equal(responseText.includes(candidate.accessKeySecret), false);
      assert.equal(responseText.includes(Buffer.from(active.ciphertext).toString("base64")), false);
      assert.equal(seenActions.filter((action) => action === "SendSmsVerifyCode").length, 1);
      assert.equal(seenActions.filter((action) => action === "CheckSmsVerifyCode").length, 2);
      await assert.rejects(() => db.smsProviderConfigAudit.update({ where: { id: publicState.audits[0]!.id }, data: { enabled: false } }));
    });

    await t.test("switching provider state advances version and supersedes outstanding phone challenges", async () => {
      const now = new Date();
      const challengeId = randomUUID();
      await db.smsAuthChallenge.create({ data: {
        id: challengeId,
        phoneE164: "+86" + phone,
        phoneFingerprint: phoneFingerprint("+86" + phone, phoneAuthSecret()),
        purpose: "login",
        providerScheme: "phgate-login",
        configVersion: 1,
        status: "sent",
        attemptCount: 0,
        createdAt: now,
        expiresAt: new Date(now.getTime() + 4 * 60_000),
      } });
      const disabled = await setSmsProviderEnabled({ enabled: false, expectedVersion: 1 }, actor);
      assert.equal(disabled.config.version, 2);
      assert.equal(disabled.config.enabled, false);
      assert.equal((await db.smsAuthChallenge.findUniqueOrThrow({ where: { id: challengeId } })).status, "superseded");
      const audits = await db.smsProviderConfigAudit.findMany({ where: { actorId: actor.id }, orderBy: { configVersion: "asc" } });
      assert.deepEqual(audits.map((audit) => [audit.action, audit.configVersion, audit.enabled]), [["configured", 1, true], ["disabled", 2, false]]);
      await assert.rejects(() => setSmsProviderEnabled({ enabled: true, expectedVersion: 1 }, actor), (error: unknown) => error instanceof ApiError && error.code === "SMS_PROVIDER_CONFIG_STALE");
    });
  } finally {
    globalThis.fetch = savedFetch;
    await db.smsProviderConfig.deleteMany({ where: { id: "active" } });
    if (priorConfig) await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.sms_provider_admin_context', 'service-v1', true)`;
      await seedVerifiedSmsConfigFixture(tx, priorConfig);
    });
    await db.smsAuthChallenge.deleteMany({ where: { phoneE164: "+86" + phone } });
    await db.phoneAuthBudget.deleteMany({ where: { scope: { in: ["send_phone_hour", "send_phone_day", "send_global_hour", "send_global_day", "verify_phone_hour", "verify_global_hour"] }, keyFingerprint: { in: [phoneFingerprint("+86" + phone, phoneAuthSecret()), "0".repeat(64)] } } });
    await db.appUser.deleteMany({ where: { id: { in: [actor.id, outsider.id] } } });
  }
});
