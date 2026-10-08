import { seedVerifiedSmsConfigFixture } from "./sms-provider-config-fixture";
import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { ApiError } from "@/lib/api-errors";
import { phoneAuthSecret, sealSmsConfig } from "@/lib/phone-auth-config";
import { normalizeMainlandPhone, phoneFingerprint } from "@/lib/phone-auth-identity";
import { consumeGraphicCaptcha, issueGraphicCaptcha, type GraphicCaptchaPurpose } from "@/lib/graphic-captcha-service";
import { issueSmsChallenge, type SmsTransport } from "@/lib/phone-auth-service";
import { executeAccountAccess, previewAccountAccess } from "@/lib/account-access-service";
import { issueGraphicCaptchaFixture } from "./graphic-captcha-fixture";

const enabled = process.env.PHONE_AUTH_POSTGRES_GATE === "1";
function url(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error("PHONE_AUTH_ISOLATED_URL_REQUIRED");
  const parsed = new URL(value);
  if (!["postgresql:", "postgres:"].includes(parsed.protocol) || parsed.hostname !== "127.0.0.1" || parsed.port !== "56329"
    || parsed.pathname !== "/ai_project_os_phone_auth_test" || parsed.search || parsed.hash) throw new Error("PHONE_AUTH_ISOLATED_URL_INVALID");
  return value;
}

const invalidCaptcha = (error: unknown) => error instanceof ApiError && error.code === "GRAPHIC_CAPTCHA_INVALID";
const rateLimited = (error: unknown) => error instanceof ApiError && error.code === "GRAPHIC_CAPTCHA_RATE_LIMITED";
function newBrowserToken(): string { return randomBytes(32).toString("base64url"); }
function browserFingerprint(token: string): string {
  return createHmac("sha256", phoneAuthSecret()).update("graphic-captcha-v1:browser:").update(token).digest("hex");
}
function phoneFor(seed: number): string { return `138${String(seed).padStart(8, "0")}`; }

test("graphic CAPTCHA is bound, single-use, and durably rate limited", { skip: !enabled }, async (t) => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url("PHONE_AUTH_TEST_DATABASE_URL") }) });
  const owner = new PrismaClient({ adapter: new PrismaPg({ connectionString: url("PHONE_AUTH_TEST_OWNER_URL") }) });
  const adminId = randomUUID();
  const otherAdminId = randomUUID();
  const outsiderId = randomUUID();
  const admin = { id: adminId, role: "admin", accountAccessVersion: 1 } as const;
  const otherAdmin = { id: otherAdminId, role: "admin", accountAccessVersion: 1 } as const;
  const outsider = { id: outsiderId, role: "user", accountAccessVersion: 1 } as const;
  const smsConfig = { accessKeyId: "captcha-gate-key", accessKeySecret: "test-only-captcha-secret", signName: "隔离测试", templateCode: "100001", schemePrefix: "captcha" };
  let sends = 0;
  const sms: SmsTransport = { send: async () => { sends++; }, check: async () => true };

  async function issueOnly(phone: string, purpose: GraphicCaptchaPurpose, token = newBrowserToken(), actor?: typeof admin) {
    return issueGraphicCaptcha({ phone, purpose, browserToken: token, ...(actor ? { actor } : {}) }, db, async () => Buffer.from("captcha-image"));
  }
  async function consumeFixture(fixture: Awaited<ReturnType<typeof issueGraphicCaptchaFixture>>, phone: string, purpose: GraphicCaptchaPurpose, actor?: typeof admin, browserToken = fixture.browserToken) {
    return consumeGraphicCaptcha({ phone, purpose, actor, browserToken, captcha: fixture.captcha }, db);
  }
  async function advanceActorEpoch(action: "disable" | "restore", expectedVersion: number) {
    const reason = `captcha test ${action} transition`;
    const preview = await previewAccountAccess({
      adminUserId: otherAdmin.id,
      adminAccountAccessVersion: otherAdmin.accountAccessVersion,
      userId: admin.id,
      action,
      reason,
      expectedVersion,
    }, db);
    assert.equal(preview.canExecute, true);
    return executeAccountAccess({
      adminUserId: otherAdmin.id,
      adminAccountAccessVersion: otherAdmin.accountAccessVersion,
      userId: preview.user.id,
      action: preview.action,
      reason,
      expectedVersion: preview.current.accountAccessVersion,
      expectedImpactFingerprint: preview.impactFingerprint,
      requestKey: randomUUID(),
      requestFingerprint: preview.requestFingerprint,
      previewId: preview.previewId,
      previewIssuedAt: preview.previewIssuedAt,
      previewExpiresAt: preview.previewExpiresAt,
      confirmation: true,
      confirmationUsername: preview.user.username,
    }, db);
  }

  try {
    await owner.appUser.createMany({ data: [
      { id: adminId, username: `captcha_admin_${adminId.slice(0, 8)}`, role: "admin" },
      { id: otherAdminId, username: `captcha_admin_${otherAdminId.slice(0, 8)}`, role: "admin" },
      { id: outsiderId, username: `captcha_user_${outsiderId.slice(0, 8)}`, role: "user" },
    ] });
    const sealedConfig = await sealSmsConfig(smsConfig, "active");
    await owner.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.sms_provider_admin_context','service-v1',true)`;
      await tx.smsProviderConfig.deleteMany({ where: { id: "active" } });
      await seedVerifiedSmsConfigFixture(tx, { id: "active", provider: "aliyun-pnvs", enabled: true, version: 1, verifiedAt: new Date(), updatedById: adminId, ...sealedConfig });
    });

    await t.test("missing CAPTCHA is rejected before the SMS provider", async () => {
      const phone = phoneFor(3001);
      const missingProof = { phone, purpose: "login" as const, browserToken: newBrowserToken() };
      await assert.rejects(issueSmsChallenge(missingProof as unknown as Parameters<typeof issueSmsChallenge>[0], db, sms), invalidCaptcha);
      assert.equal(sends, 0);
      assert.equal(await db.smsAuthChallenge.count({ where: { phoneE164: normalizeMainlandPhone(phone) } }), 0);
    });

    await t.test("wrong answer is durably consumed and cannot be retried with the right answer", async () => {
      const phone = phoneFor(3002);
      const fixture = await issueGraphicCaptchaFixture({ phone, purpose: "login" }, db);
      const wrongAnswer = `${fixture.captcha.answer[0] === "Z" ? "Y" : "Z"}${fixture.captcha.answer.slice(1)}`;
      const badProof = { ...fixture, captcha: { ...fixture.captcha, answer: wrongAnswer } };
      await assert.rejects(issueSmsChallenge({ phone, purpose: "login", ...badProof }, db, sms), invalidCaptcha);
      const stored = await db.graphicCaptchaChallenge.findUniqueOrThrow({ where: { id: fixture.captcha.challengeId } });
      assert.ok(stored.consumedAt);
      await assert.rejects(issueSmsChallenge({ phone, purpose: "login", ...fixture }, db, sms), invalidCaptcha);
      assert.equal(sends, 0);
    });

    await t.test("expired, phone, purpose, and browser mismatches consume and reject the proof", async () => {
      const expired = await issueGraphicCaptchaFixture({ phone: phoneFor(3003), purpose: "login" }, db);
      await owner.$executeRaw`UPDATE "GraphicCaptchaChallenge" SET "createdAt"=CURRENT_TIMESTAMP-interval '4 minutes',"expiresAt"=CURRENT_TIMESTAMP-interval '1 minute' WHERE "id"=${expired.captcha.challengeId}::uuid`;
      await assert.rejects(consumeFixture(expired, phoneFor(3003), "login"), invalidCaptcha);
      assert.ok((await db.graphicCaptchaChallenge.findUniqueOrThrow({ where: { id: expired.captcha.challengeId } })).consumedAt);

      const phoneMismatch = await issueGraphicCaptchaFixture({ phone: phoneFor(3004), purpose: "login" }, db);
      await assert.rejects(consumeFixture(phoneMismatch, phoneFor(3005), "login"), invalidCaptcha);

      const purposeMismatch = await issueGraphicCaptchaFixture({ phone: phoneFor(3006), purpose: "login" }, db);
      await assert.rejects(consumeFixture(purposeMismatch, phoneFor(3006), "register"), invalidCaptcha);

      const browserMismatch = await issueGraphicCaptchaFixture({ phone: phoneFor(3007), purpose: "login" }, db);
      await assert.rejects(consumeFixture(browserMismatch, phoneFor(3007), "login", undefined, newBrowserToken()), invalidCaptcha);
    });

    await t.test("a successful proof replays once only, including under concurrent consumption", async () => {
      const replay = await issueGraphicCaptchaFixture({ phone: phoneFor(3008), purpose: "login" }, db);
      await consumeFixture(replay, phoneFor(3008), "login");
      await assert.rejects(consumeFixture(replay, phoneFor(3008), "login"), invalidCaptcha);

      const concurrent = await issueGraphicCaptchaFixture({ phone: phoneFor(3009), purpose: "login" }, db);
      const results = await Promise.allSettled([
        consumeFixture(concurrent, phoneFor(3009), "login"),
        consumeFixture(concurrent, phoneFor(3009), "login"),
      ]);
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(results.filter((result) => result.status === "rejected" && invalidCaptcha(result.reason)).length, 1);
      assert.ok((await db.graphicCaptchaChallenge.findUniqueOrThrow({ where: { id: concurrent.captcha.challengeId } })).consumedAt);
    });

    await t.test("concurrent SMS issuance with the same proof calls the provider once", async () => {
      const phone = phoneFor(3014);
      const fixture = await issueGraphicCaptchaFixture({ phone, purpose: "login" }, db);
      const results = await Promise.allSettled([
        issueSmsChallenge({ phone, purpose: "login", ...fixture }, db, sms),
        issueSmsChallenge({ phone, purpose: "login", ...fixture }, db, sms),
      ]);
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(results.filter((result) => result.status === "rejected" && invalidCaptcha(result.reason)).length, 1);
      assert.equal(sends, 1);
    });

    await t.test("test-purpose CAPTCHA requires a current administrator and binds actor and access epoch", async () => {
      await assert.rejects(issueGraphicCaptcha({ phone: phoneFor(3010), purpose: "test", actor: outsider, browserToken: newBrowserToken() }, db, async () => Buffer.from("unused")),
        (error: unknown) => error instanceof ApiError && error.code === "GRAPHIC_CAPTCHA_FORBIDDEN");

      const actorBound = await issueGraphicCaptchaFixture({ phone: phoneFor(3011), purpose: "test", actor: admin }, db);
      await assert.rejects(consumeFixture(actorBound, phoneFor(3011), "test", otherAdmin), invalidCaptcha);

      const stale = await issueGraphicCaptchaFixture({ phone: phoneFor(3012), purpose: "test", actor: admin }, db);
      assert.equal((await advanceActorEpoch("disable", 1)).accountAccessVersion, 2);
      assert.equal((await advanceActorEpoch("restore", 2)).accountAccessVersion, 3);
      await assert.rejects(consumeFixture(stale, phoneFor(3012), "test", admin), invalidCaptcha);
      assert.ok((await db.graphicCaptchaChallenge.findUniqueOrThrow({ where: { id: stale.captcha.challengeId } })).consumedAt);
    });

    await t.test("renderer failure removes the challenge but preserves all issue budgets", async () => {
      const phone = phoneFor(3013);
      const normalized = normalizeMainlandPhone(phone);
      const token = newBrowserToken();
      const browserKey = browserFingerprint(token);
      const phoneKey = phoneFingerprint(normalized, phoneAuthSecret());
      const globalKey = "0".repeat(64);
      const previousGlobal = await db.graphicCaptchaBudget.findUnique({ where: { scope_keyFingerprint: { scope: "issue_global", keyFingerprint: globalKey } } });
      const globalBaseline = previousGlobal && previousGlobal.windowStartedAt.getTime() + 10 * 60_000 > Date.now() ? previousGlobal.attemptCount : 0;
      await assert.rejects(issueGraphicCaptcha({ phone, purpose: "login", browserToken: token }, db, async () => { throw new Error("synthetic renderer failure"); }),
        (error: unknown) => error instanceof ApiError && error.code === "GRAPHIC_CAPTCHA_UNAVAILABLE" && error.status === 503);
      assert.equal(await db.graphicCaptchaChallenge.count({ where: { phoneFingerprint: phoneKey } }), 0);
      assert.equal((await db.graphicCaptchaBudget.findUniqueOrThrow({ where: { scope_keyFingerprint: { scope: "issue_browser", keyFingerprint: browserKey } } })).attemptCount, 1);
      assert.equal((await db.graphicCaptchaBudget.findUniqueOrThrow({ where: { scope_keyFingerprint: { scope: "issue_phone", keyFingerprint: phoneKey } } })).attemptCount, 1);
      assert.equal((await db.graphicCaptchaBudget.findUniqueOrThrow({ where: { scope_keyFingerprint: { scope: "issue_global", keyFingerprint: globalKey } } })).attemptCount, globalBaseline + 1);
    });

    await t.test("issue budgets enforce 40 per browser, 20 per phone, and 1000 globally", async () => {
      const sharedBrowser = newBrowserToken();
      for (let index = 0; index < 40; index++) await issueOnly(phoneFor(4000 + index), "login", sharedBrowser);
      await assert.rejects(issueOnly(phoneFor(4040), "login", sharedBrowser), rateLimited);
      assert.equal((await db.graphicCaptchaBudget.findUniqueOrThrow({ where: { scope_keyFingerprint: { scope: "issue_browser", keyFingerprint: browserFingerprint(sharedBrowser) } } })).attemptCount, 40);

      const sharedPhone = phoneFor(4100);
      for (let index = 0; index < 20; index++) await issueOnly(sharedPhone, "login");
      await assert.rejects(issueOnly(sharedPhone, "login"), rateLimited);
      const sharedPhoneKey = phoneFingerprint(normalizeMainlandPhone(sharedPhone), phoneAuthSecret());
      assert.equal((await db.graphicCaptchaBudget.findUniqueOrThrow({ where: { scope_keyFingerprint: { scope: "issue_phone", keyFingerprint: sharedPhoneKey } } })).attemptCount, 20);

      // Preserve the prior shared global counter plus the one real issue below.
      // The isolated PostgreSQL runner executes this boundary setup sequentially.
      const globalKey = "0".repeat(64);
      const before = await owner.graphicCaptchaBudget.findUnique({ where: { scope_keyFingerprint: { scope: "issue_global", keyFingerprint: globalKey } } });
      const now = new Date();
      const activeBefore = before !== null && before.windowStartedAt.getTime() + 10 * 60_000 > now.getTime();
      const baseline = activeBefore ? before.attemptCount : 0;
      assert.ok(baseline < 999, "isolated global CAPTCHA budget baseline must leave room to exercise its cap");
      await owner.graphicCaptchaBudget.upsert({
        where: { scope_keyFingerprint: { scope: "issue_global", keyFingerprint: globalKey } },
        create: { scope: "issue_global", keyFingerprint: globalKey, windowStartedAt: now, attemptCount: 999 },
        update: { windowStartedAt: now, attemptCount: 999 },
      });
      let issued = false;
      try {
        await issueOnly(phoneFor(4200), "login");
        issued = true;
        assert.equal((await owner.graphicCaptchaBudget.findUniqueOrThrow({ where: { scope_keyFingerprint: { scope: "issue_global", keyFingerprint: globalKey } } })).attemptCount, 1000);
        await assert.rejects(issueOnly(phoneFor(4201), "login"), rateLimited);
        assert.equal((await owner.graphicCaptchaBudget.findUniqueOrThrow({ where: { scope_keyFingerprint: { scope: "issue_global", keyFingerprint: globalKey } } })).attemptCount, 1000);
      } finally {
        const countToPreserve = baseline + (issued ? 1 : 0);
        if (before || issued) {
          await owner.graphicCaptchaBudget.upsert({
            where: { scope_keyFingerprint: { scope: "issue_global", keyFingerprint: globalKey } },
            create: { scope: "issue_global", keyFingerprint: globalKey, windowStartedAt: activeBefore ? before!.windowStartedAt : now, attemptCount: countToPreserve },
            update: { windowStartedAt: activeBefore ? before!.windowStartedAt : now, attemptCount: countToPreserve },
          });
        } else {
          await owner.graphicCaptchaBudget.deleteMany({ where: { scope: "issue_global", keyFingerprint: globalKey } });
        }
      }
    });
  } finally {
    await db.$disconnect();
    await owner.$disconnect();
  }
});
