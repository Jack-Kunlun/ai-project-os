import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import test from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { ApiError } from "@/lib/api-errors";
import { previewAccountAccess, executeAccountAccess } from "@/lib/account-access-service";
import { closeOwnAccount } from "@/lib/account-closure-service";
import { changeAccountPassword, createPasswordRecord, createSession, loginAdmin, readSessionToken, setLocalAccountPassword } from "@/lib/auth";
import { changeAccountPhone, bindAccountPhone, recoverAccountPassword } from "@/lib/account-security-service";
import { issueSmsChallenge, loginWithSms, registerPhoneAccount, type SmsTransport } from "@/lib/phone-auth-service";
import { sealSmsConfig } from "@/lib/phone-auth-config";
import { grantWorkspaceMembership } from "@/lib/membership-governance";
import { issueGraphicCaptchaFixture } from "./graphic-captcha-fixture";
import { seedVerifiedSmsConfigFixture } from "./sms-provider-config-fixture";

const enabled = process.env.PHONE_AUTH_POSTGRES_GATE === "1";
function url(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error("ACCOUNT_SECURITY_ISOLATED_URL_REQUIRED");
  const parsed = new URL(value);
  if (!["postgres:", "postgresql:"].includes(parsed.protocol) || parsed.hostname !== "127.0.0.1" || parsed.port !== "56329" || parsed.pathname !== "/ai_project_os_phone_auth_test" || parsed.search || parsed.hash) throw new Error("ACCOUNT_SECURITY_ISOLATED_URL_INVALID");
  return value;
}

const code = "123456";
const password = "AccountSecurity_2026";
const smsConfig = { accessKeyId: "security-gate-key", accessKeySecret: "isolated-account-security-secret", signName: "隔离测试", templateCode: "100001", schemePrefix: "security" };
const sms: SmsTransport = { send: async () => undefined, check: async (input) => input.code === code };
function apiCode(expected: string) {
  return (error: unknown) => error instanceof ApiError && error.code === expected;
}

test("account recovery, phone binding and rebinding are transactionally proof-bound in PostgreSQL", { skip: !enabled }, async (t) => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url("PHONE_AUTH_TEST_DATABASE_URL") }) });
  const owner = new PrismaClient({ adapter: new PrismaPg({ connectionString: url("PHONE_AUTH_TEST_OWNER_URL") }) });
  const adminId = randomUUID();
  const adminUsername = `security_admin_${adminId.slice(0, 8)}`;
  await owner.appUser.create({ data: { id: adminId, username: adminUsername, role: "admin", ...await createPasswordRecord("SecurityAdmin_2026") } });
  const sealed = await sealSmsConfig(smsConfig, "active");
  await owner.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.sms_provider_admin_context','service-v1',true)`;
    await tx.smsProviderConfig.deleteMany();
    await seedVerifiedSmsConfigFixture(tx, { id: "active", provider: "aliyun-pnvs", version: 1, enabled: true, verifiedAt: new Date(), updatedById: adminId, ...sealed });
  });

  async function issue(phone: string, purpose: "register" | "login" | "close" | "recover" | "bind" | "change-old" | "change-new", actor?: Awaited<ReturnType<typeof loginAdmin>>["user"]) {
    const captcha = await issueGraphicCaptchaFixture({ phone, purpose, ...(actor ? { actor } : {}) }, db);
    const challenge = await issueSmsChallenge({ phone, purpose, ...(actor ? { actor } : {}), ...captcha }, db, sms);
    return { phone, challengeId: challenge.challengeId, code };
  }
  async function register(phone: string, username = `security_user_${randomUUID().slice(0, 8)}`) {
    const proof = await issue(phone, "register");
    return registerPhoneAccount({ ...proof, username, password }, db, sms);
  }
  async function resetCooldown(phone: string) {
    await owner.$executeRaw`UPDATE "SmsAuthChallenge" SET "createdAt"="createdAt"-interval '61 seconds',"expiresAt"="expiresAt"-interval '61 seconds' WHERE "phoneE164"=${`+86${phone}`}`;
  }
  async function newUnboundUser(username: string, withPassword = true) {
    const id = randomUUID();
    await owner.appUser.create({ data: { id, username, role: "user", ...(withPassword ? await createPasswordRecord(password) : {}) } });
    return id;
  }

  try {
    await t.test("unknown recovery is generic and does not create an account; passwordless SMS accounts can recover", async () => {
      const unknownPhone = "13800000301";
      const unknown = await issue(unknownPhone, "recover");
      await assert.rejects(recoverAccountPassword({ ...unknown, newPassword: password }, db, sms), apiCode("ACCOUNT_RECOVERY_INVALID"));
      assert.equal(await db.appUser.findUnique({ where: { phoneE164: `+86${unknownPhone}` } }), null);

      const phone = "13800000302";
      const loginProof = await issue(phone, "login");
      const loggedIn = await loginWithSms(loginProof, db, sms);
      assert.equal(loggedIn.registered, true);
      const oldSessionToken = loggedIn.session.token;
      await resetCooldown(phone);
      const recovery = await issue(phone, "recover");
      const attempts = await Promise.allSettled([
        recoverAccountPassword({ ...recovery, newPassword: password }, db, sms),
        recoverAccountPassword({ ...recovery, newPassword: password }, db, sms),
      ]);
      assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
      const recoveredAttempt = attempts.find((attempt) => attempt.status === "fulfilled");
      assert.ok(recoveredAttempt?.status === "fulfilled");
      const recovered = recoveredAttempt.value;
      assert.equal(recovered.username, loggedIn.session.user.username);
      assert.equal(await readSessionToken(oldSessionToken, db), null);
      const stored = await db.appUser.findUniqueOrThrow({ where: { id: loggedIn.session.user.id } });
      assert.equal(stored.securityRevision, loggedIn.session.user.securityRevision + 1);
      assert.ok(stored.passwordHash);
      assert.equal((await loginAdmin({ username: phone, password }, db)).user.id, stored.id);
      const audit = await db.appUserSecurityAudit.findFirstOrThrow({ where: { userId: stored.id, action: "password_recovered" } });
      const serializedAudit = JSON.stringify(audit, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value);
      assert.equal(serializedAudit.includes(password), false);
      assert.equal(serializedAudit.includes(code), false);
    });

    await t.test("account-scoped bad-password budget, password setup, and stale sessions are enforced", async () => {
      const id = await newUnboundUser(`security_passwordless_${randomUUID().slice(0, 8)}`, false);
      const initial = await db.appUser.findUniqueOrThrow({ where: { id } });
      const staleSession = await createSession(db, initial);
      await setLocalAccountPassword(id, password, db);
      assert.equal(await readSessionToken(staleSession.token, db), null);
      const fresh = await loginAdmin({ username: initial.username, password }, db);

      const collisionPhone = "13800000303", failedPasswordPhone = "13800000312", phone = "13800000314";
      const alreadyBound = await register(collisionPhone);
      const failedPasswordProof = await issue(failedPasswordPhone, "bind", fresh.user);
      await assert.rejects(bindAccountPhone(fresh.user, { ...failedPasswordProof, currentPassword: "WrongAccountPassword_2026" }, db, sms), apiCode("ACCOUNT_CURRENT_PASSWORD_INVALID"));
      const key = createHmac("sha256", Buffer.from(process.env.PHONE_AUTH_SECRET!, "base64url")).update("phone-auth:account-password:v1:").update(id).digest("hex");
      assert.ok((await db.phoneAuthBudget.findUniqueOrThrow({ where: { scope_keyFingerprint: { scope: "verify_account_password_hour", keyFingerprint: key } } })).attemptCount >= 1);

      const beforePasswordChange = await db.appUser.findUniqueOrThrow({ where: { id } });
      await changeAccountPassword(id, password, "AccountSecurity_New_2026", db);
      assert.equal(await readSessionToken(fresh.token, db), null);
      const newLogin = await loginAdmin({ username: initial.username, password: "AccountSecurity_New_2026" }, db);
      await assert.rejects(loginAdmin({ username: initial.username, password }, db));
      const revisionBeforeStaleIssue = await db.appUser.findUniqueOrThrow({ where: { id } });
      await assert.rejects(createSession(db, beforePasswordChange), (error: unknown) => error instanceof Error && error.message === "AUTH_INVALID_CREDENTIALS");
      assert.equal((await db.appUser.findUniqueOrThrow({ where: { id } })).securityRevision, revisionBeforeStaleIssue.securityRevision);

      const wrongActorId = await newUnboundUser(`security_wrong_actor_${randomUUID().slice(0, 8)}`);
      const wrongActor = await createSession(db, await db.appUser.findUniqueOrThrow({ where: { id: wrongActorId } }));
      const wrongActorProof = await issue(phone, "bind", newLogin.user);
      await assert.rejects(bindAccountPhone(wrongActor.user, { ...wrongActorProof, currentPassword: password }, db, sms), apiCode("ACCOUNT_SECURITY_FORBIDDEN"));
      assert.equal((await db.appUser.findUniqueOrThrow({ where: { id } })).phoneE164, null);

      assert.ok(alreadyBound.user.id);
      await resetCooldown(collisionPhone);
      const collisionProof = await issue(collisionPhone, "bind", newLogin.user);
      await assert.rejects(bindAccountPhone(newLogin.user, { ...collisionProof, currentPassword: "AccountSecurity_New_2026" }, db, sms), apiCode("PHONE_AUTH_PHONE_IN_USE"));

      await resetCooldown(phone);
      const phoneProof = await issue(phone, "bind", newLogin.user);
      await bindAccountPhone(newLogin.user, { ...phoneProof, currentPassword: "AccountSecurity_New_2026" }, db, sms);
      assert.equal(await readSessionToken(newLogin.token, db), null);
      const bound = await db.appUser.findUniqueOrThrow({ where: { id } });
      assert.equal(bound.phoneE164, `+86${phone}`);
      assert.equal((await loginAdmin({ username: phone, password: "AccountSecurity_New_2026" }, db)).user.id, id);
      await assert.rejects(db.appUser.update({ where: { id }, data: { phoneE164: "+8613800003999", phoneVerifiedAt: new Date() } }));
      const bindingAudit = await db.appUserSecurityAudit.findFirstOrThrow({ where: { userId: id, action: "phone_bound" } });
      await assert.rejects(owner.appUserSecurityAudit.update({ where: { id: bindingAudit.id }, data: { action: "phone_changed" } }));

      const beforeRotation = await loginAdmin({ username: phone, password: "AccountSecurity_New_2026" }, db);
      await resetCooldown(phone);
      const pendingLogin = await issue(phone, "login");
      await resetCooldown(phone);
      const pendingRecovery = await issue(phone, "recover");
      await resetCooldown(phone);
      const pendingClosure = await issue(phone, "close", beforeRotation.user);
      const previousEnabled = process.env.PHONE_AUTH_ENABLED;
      const previousSecret = process.env.PHONE_AUTH_SECRET;
      delete process.env.PHONE_AUTH_ENABLED;
      delete process.env.PHONE_AUTH_SECRET;
      try {
        await changeAccountPassword(id, "AccountSecurity_New_2026", "AccountSecurity_Rotated_2026", db);
      } finally {
        if (previousEnabled === undefined) delete process.env.PHONE_AUTH_ENABLED;
        else process.env.PHONE_AUTH_ENABLED = previousEnabled;
        if (previousSecret === undefined) delete process.env.PHONE_AUTH_SECRET;
        else process.env.PHONE_AUTH_SECRET = previousSecret;
      }
      assert.equal(await readSessionToken(beforeRotation.token, db), null);
      for (const pending of [pendingLogin, pendingRecovery, pendingClosure]) {
        assert.equal((await db.smsAuthChallenge.findUniqueOrThrow({ where: { id: pending.challengeId } })).status, "superseded");
      }
      assert.equal((await loginAdmin({ username: phone, password: "AccountSecurity_Rotated_2026" }, db)).user.id, id);
      await assert.rejects(loginAdmin({ username: phone, password: "AccountSecurity_New_2026" }, db));
    });

    await t.test("rebind requires both phone proofs, preserves identity/workspace, and retires the old alias", async () => {
      const oldPhone = "13800000304", newPhone = "13800000305";
      const registered = await register(oldPhone);
      const userId = registered.user.id;
      const oldWorkspace = await db.workspace.findUniqueOrThrow({ where: { slug: `user-${userId}` } });
      const project = await owner.project.create({ data: { workspaceId: oldWorkspace.id, slug: `security_keep_${randomUUID().slice(0, 8)}`, name: "retained account workspace", description: "security migration fixture" } });
      await resetCooldown(oldPhone);
      const oldProof = await issue(oldPhone, "change-old", registered.user);
      const newProof = await issue(newPhone, "change-new", registered.user);
      await assert.rejects(changeAccountPhone(registered.user, { oldPhone, oldChallengeId: oldProof.challengeId, oldCode: "999999", phone: newPhone, challengeId: newProof.challengeId, code }, db, sms), ApiError);
      await assert.rejects(changeAccountPhone(registered.user, { oldPhone, oldChallengeId: oldProof.challengeId, oldCode: code, phone: newPhone, challengeId: newProof.challengeId, code: "999999" }, db, sms), ApiError);
      assert.equal((await db.appUser.findUniqueOrThrow({ where: { id: userId } })).phoneE164, `+86${oldPhone}`);

      await changeAccountPhone(registered.user, { oldPhone, oldChallengeId: oldProof.challengeId, oldCode: code, phone: newPhone, challengeId: newProof.challengeId, code }, db, sms);
      assert.equal(await readSessionToken(registered.token, db), null);
      const updated = await db.appUser.findUniqueOrThrow({ where: { id: userId } });
      assert.equal(updated.phoneE164, `+86${newPhone}`);
      assert.equal(updated.id, userId);
      assert.equal((await db.workspace.findUniqueOrThrow({ where: { slug: `user-${userId}` } })).id, oldWorkspace.id);
      assert.equal((await db.project.findUniqueOrThrow({ where: { id: project.id } })).workspaceId, oldWorkspace.id);
      await assert.rejects(loginAdmin({ username: oldPhone, password }, db));
      assert.equal((await loginAdmin({ username: newPhone, password }, db)).user.id, userId);
      const audit = await db.appUserSecurityAudit.findFirstOrThrow({ where: { userId, action: "phone_changed" } });
      await assert.rejects(owner.appUserSecurityAudit.delete({ where: { id: audit.id } }));
    });

    await t.test("numeric old-phone username requires an explicit login-name change before rebinding", async () => {
      const oldPhone = "13800000306", newPhone = "13800000307";
      const registered = await register(oldPhone, oldPhone);
      await resetCooldown(oldPhone);
      const oldProof = await issue(oldPhone, "change-old", registered.user);
      const newProof = await issue(newPhone, "change-new", registered.user);
      await assert.rejects(changeAccountPhone(registered.user, { oldPhone, oldChallengeId: oldProof.challengeId, oldCode: code, phone: newPhone, challengeId: newProof.challengeId, code }, db, sms), apiCode("PHONE_AUTH_LOGIN_NAME_UPDATE_REQUIRED"));
      assert.equal((await db.appUser.findUniqueOrThrow({ where: { id: registered.user.id } })).phoneE164, `+86${oldPhone}`);
      assert.equal((await db.smsAuthChallenge.findUniqueOrThrow({ where: { id: oldProof.challengeId } })).consumedAt, null);
    });

    await t.test("disabled and closed accounts cannot recover; stale, expired, wrong-purpose, and config-drift proofs fail", async () => {
      const disabled = await register("13800000308");
      const admin = await loginAdmin({ username: adminUsername, password: "SecurityAdmin_2026" }, db);
      const disabledWorkspace = await db.workspace.findUniqueOrThrow({ where: { slug: `user-${disabled.user.id}` } });
      await owner.$transaction((tx) => grantWorkspaceMembership(tx, {
        workspaceId: disabledWorkspace.id, userId: adminId, role: "owner", actorId: disabled.user.id, reason: "isolated_security_backup_owner",
      }));
      const preview = await previewAccountAccess({ adminUserId: adminId, adminAccountAccessVersion: admin.user.accountAccessVersion, userId: disabled.user.id, action: "disable", reason: "account security isolated test", expectedVersion: 1 }, db);
      await executeAccountAccess({
        adminUserId: adminId,
        adminAccountAccessVersion: admin.user.accountAccessVersion,
        userId: disabled.user.id,
        action: "disable",
        reason: "account security isolated test",
        expectedVersion: preview.current.accountAccessVersion,
        expectedImpactFingerprint: preview.impactFingerprint,
        requestKey: `sec-disable-${randomUUID().slice(0, 8)}`,
        requestFingerprint: preview.requestFingerprint,
        previewId: preview.previewId,
        previewIssuedAt: preview.previewIssuedAt,
        previewExpiresAt: preview.previewExpiresAt,
        confirmation: true,
        confirmationUsername: preview.user.username,
      }, db);
      await resetCooldown("13800000308");
      const disabledRecovery = await issue("13800000308", "recover");
      await assert.rejects(recoverAccountPassword({ ...disabledRecovery, newPassword: "NeverSet_2026" }, db, sms), apiCode("ACCOUNT_RECOVERY_INVALID"));
      assert.equal((await db.appUser.findUniqueOrThrow({ where: { id: disabled.user.id } })).disabledAt === null, false);

      const closed = await register("13800000309");
      await closeOwnAccount({ method: "password", password, confirmation: "注销账号" }, closed.user, db, sms);
      await resetCooldown("13800000309");
      const closedRecovery = await issue("13800000309", "recover");
      await assert.rejects(recoverAccountPassword({ ...closedRecovery, newPassword: "NeverSet_2026" }, db, sms), apiCode("ACCOUNT_RECOVERY_INVALID"));
      assert.ok((await db.appUser.findUniqueOrThrow({ where: { id: closed.user.id } })).closedAt);

      const account = await register("13800000310");
      await resetCooldown("13800000310");
      const wrongPurpose = await issue("13800000310", "login");
      await assert.rejects(recoverAccountPassword({ ...wrongPurpose, newPassword: "NeverSet_2026" }, db, sms), ApiError);
      await resetCooldown("13800000310");
      const staleBySecurityRevision = await issue("13800000310", "recover");
      await changeAccountPassword(account.user.id, password, "AccountSecurity_Updated_2026", db);
      assert.equal((await db.smsAuthChallenge.findUniqueOrThrow({ where: { id: staleBySecurityRevision.challengeId } })).status, "superseded");
      await assert.rejects(recoverAccountPassword({ ...staleBySecurityRevision, newPassword: "NeverSet_2026" }, db, sms), apiCode("PHONE_AUTH_CODE_INVALID"));
      assert.equal((await db.appUser.findUniqueOrThrow({ where: { id: account.user.id } })).securityRevision, account.user.securityRevision + 1);

      await resetCooldown("13800000310");
      const expired = await issue("13800000310", "recover");
      await owner.$executeRaw`UPDATE "SmsAuthChallenge" SET "createdAt"=clock_timestamp()-interval '6 minutes',"expiresAt"=clock_timestamp()-interval '1 minute' WHERE "id"=${expired.challengeId}::uuid`;
      await assert.rejects(recoverAccountPassword({ ...expired, newPassword: "NeverSet_2026" }, db, sms), ApiError);

      await resetCooldown("13800000310");
      const configStale = await issue("13800000310", "recover");
      await owner.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.sms_provider_admin_context','service-v1',true)`;
        await tx.smsProviderConfig.update({ where: { id: "active" }, data: { version: { increment: 1 } } });
      });
      await assert.rejects(recoverAccountPassword({ ...configStale, newPassword: "NeverSet_2026" }, db, sms), ApiError);
    });
  } finally {
    await db.$disconnect();
    await owner.$disconnect();
  }
});
