import { consumeGraphicCaptcha, type GraphicCaptchaProof } from "@/lib/graphic-captcha-service";
import { randomInt, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient, type SmsAuthChallenge } from "@prisma/client";
import { ApiError } from "@/lib/api-errors";
import { assertEntitlementWriterSession, getEntitlementDb, isEntitlementDatabase } from "@/lib/db";
import { assertAccountAccessForActor } from "@/lib/account-access-guard";
import type { SafeSessionUser } from "@/lib/auth";
import { lockActorAccess } from "@/lib/access-linearization";
import { createPasswordRecord, createPhoneSessionInTransaction, validateAccountPassword, type CreatedSession } from "@/lib/auth";
import { createOrdinaryAccountInTransaction, normalizeLocalRegistrationUsername } from "@/lib/local-registration-service";
import { reserveLocalRegistrationAttempt } from "@/lib/local-registration-abuse-budget";
import { isLocalRegistrationEnabled, requireLocalRegistrationEnabled } from "@/lib/local-registration-config";
import { phoneAuthSecret, loadActiveSmsConfig, lockSmsConfiguration, assertSmsConfigVersion } from "@/lib/phone-auth-config";
import { equalSmsDigest, normalizeMainlandPhone, phoneFingerprint, smsCodeDigest, type SmsCodePurpose } from "@/lib/phone-auth-identity";
import { reserveSmsSendBudget, reserveSmsVerifyBudget, smsDatabaseClock } from "@/lib/phone-auth-budget";
import { smsProviderScheme, checkSmsCode, sendSmsCode } from "@/lib/sms-providers";

const MINUTE = 60_000;

type Tx = Prisma.TransactionClient;
export type SmsTransport = {
  send: typeof sendSmsCode;
  check: typeof checkSmsCode;
};
const transport: SmsTransport = { send: sendSmsCode, check: checkSmsCode };
const ACTOR_PHONE_PURPOSES = new Set<SmsCodePurpose>(["bind", "change-old", "change-new"]);
const SUBJECT_PHONE_PURPOSES = new Set<SmsCodePurpose>(["recover", "bind", "change-old", "change-new"]);
function invalidCode(): ApiError { return new ApiError(400, "PHONE_AUTH_CODE_INVALID", "验证码无效或已过期，请重新获取"); }
function requireActorSecurity(actor: SafeSessionUser, current: { accountAccessVersion: number; securityRevision: number }): void {
  if (actor.accountAccessVersion !== current.accountAccessVersion || actor.securityRevision !== current.securityRevision) {
    throw new ApiError(401, "AUTH_SESSION_STALE", "登录状态已失效，请重新登录后再试");
  }
}
function requireSmsAutoRegistration(): void {
  if (!isLocalRegistrationEnabled()) throw new ApiError(503, "LOCAL_REGISTRATION_DISABLED", "该手机号尚未注册，当前暂未开放新账号注册。");
}
async function writer(tx: Tx, db: PrismaClient): Promise<void> {
  if (isEntitlementDatabase(db)) await assertEntitlementWriterSession(tx);
}
/** Reserve durable limits before any billable request. Failure retains budgets. */
export async function issueSmsChallenge(input: { phone: unknown; purpose: SmsCodePurpose; actor?: SafeSessionUser; captcha: GraphicCaptchaProof; browserToken: string }, db = getEntitlementDb(), sms: SmsTransport = transport): Promise<{ challengeId: string; retryAfterSeconds: 60; expiresInSeconds: 300 }> {
  await consumeGraphicCaptcha(input, db);
  const active = await loadActiveSmsConfig(db);
  if (input.purpose === "register") requireLocalRegistrationEnabled();
  const phone = normalizeMainlandPhone(input.phone);
  const fingerprint = phoneFingerprint(phone, phoneAuthSecret());
  const id = randomUUID();
  const scheme = smsProviderScheme(input.purpose, active.config);
  const code = active.provider === "aliyun-pnvs" ? undefined : randomInt(1_000_000).toString().padStart(6, "0");
  const expectedCodeDigest = code === undefined ? null : smsCodeDigest({ id, phone, purpose: input.purpose, code }, phoneAuthSecret());
  await db.$transaction(async tx => {
    await writer(tx, db);
    await lockSmsConfiguration(tx);
    await assertSmsConfigVersion(tx, active.version);
    const { now } = await reserveSmsSendBudget(tx, phone);
    let subjectUserId: string | null = null;
    let subjectAccountAccessVersion: number | null = null;
    let subjectSecurityRevision: number | null = null;
    let subjectPhoneFingerprint: string | null = null;
    if (SUBJECT_PHONE_PURPOSES.has(input.purpose)) await lockPhoneIdentity(tx, phone);
    if (input.purpose === "recover") {
      const user = await tx.appUser.findUnique({ where: { phoneE164: phone }, select: { id: true, accountAccessVersion: true, securityRevision: true, disabledAt: true, closedAt: true, phoneVerifiedAt: true } });
      if (user && !user.disabledAt && !user.closedAt && user.phoneVerifiedAt) {
        subjectUserId = user.id;
        subjectAccountAccessVersion = user.accountAccessVersion;
        subjectSecurityRevision = user.securityRevision;
        subjectPhoneFingerprint = fingerprint;
      }
    }
    if (ACTOR_PHONE_PURPOSES.has(input.purpose) || input.purpose === "close") {
      if (!input.actor) throw new ApiError(401, "AUTH_REQUIRED", "请先登录");
      await lockActorAccess(tx, input.actor.id);
      await assertAccountAccessForActor(tx, input.actor);
      const current = await tx.appUser.findUnique({ where: { id: input.actor.id }, select: { id: true, phoneE164: true, phoneVerifiedAt: true, passwordHash: true, passwordSalt: true, accountAccessVersion: true, securityRevision: true, disabledAt: true, closedAt: true } });
      if (!current || current.disabledAt || current.closedAt) throw new ApiError(403, "PHONE_AUTH_FORBIDDEN", "当前账号不能执行此操作");
      requireActorSecurity(input.actor, current);
      if (input.purpose === "close" && (current.phoneE164 !== phone || !current.phoneVerifiedAt)) throw new ApiError(403, "PHONE_AUTH_FORBIDDEN", "只能验证当前账号绑定的手机号");
      if (input.purpose === "bind") {
        if (current.phoneE164 || current.phoneVerifiedAt) throw new ApiError(409, "ACCOUNT_PHONE_ALREADY_BOUND", "账号已绑定手机号，请使用换绑流程");
        if (!current.passwordHash || !current.passwordSalt) throw new ApiError(409, "ACCOUNT_LOCAL_PASSWORD_REQUIRED", "请先设置本地密码并重新登录，再绑定手机号");
      }
      if (input.purpose === "change-old" && (current.phoneE164 !== phone || !current.phoneVerifiedAt)) throw new ApiError(403, "PHONE_AUTH_FORBIDDEN", "只能验证当前账号绑定的手机号");
      if (input.purpose === "change-new") {
        if (!current.phoneE164 || !current.phoneVerifiedAt) throw new ApiError(409, "ACCOUNT_PHONE_NOT_BOUND", "账号尚未绑定手机号，请使用绑定流程");
        if (current.phoneE164 === phone) throw new ApiError(409, "PHONE_AUTH_PHONE_UNCHANGED", "新手机号与当前绑定手机号相同");
        const owner = await tx.appUser.findUnique({ where: { phoneE164: phone }, select: { id: true } });
        if (owner && owner.id !== current.id) throw new ApiError(409, "PHONE_AUTH_PHONE_IN_USE", "该手机号已绑定其他账号");
      }
      if (ACTOR_PHONE_PURPOSES.has(input.purpose)) {
        subjectUserId = current.id;
        subjectAccountAccessVersion = current.accountAccessVersion;
        subjectSecurityRevision = current.securityRevision;
        subjectPhoneFingerprint = current.phoneE164 ? phoneFingerprint(current.phoneE164, phoneAuthSecret()) : null;
      }
    }
    if ((await tx.appUser.count({ where: { role: "admin" } })) === 0) throw new ApiError(503, "PHONE_AUTH_UNAVAILABLE", "平台尚未完成初始化");
    await tx.smsAuthChallenge.updateMany({ where: { phoneFingerprint: fingerprint, purpose: input.purpose, status: { in: ["pending", "sent"] }, consumedAt: null }, data: { status: "superseded" } });
    await tx.smsAuthChallenge.create({ data: { id, phoneE164: phone, phoneFingerprint: fingerprint, providerScheme: scheme, configVersion: active.version, expectedCodeDigest, purpose: input.purpose, subjectUserId, subjectAccountAccessVersion, subjectSecurityRevision, subjectPhoneFingerprint, createdAt: now, expiresAt: new Date(now.getTime() + 5 * MINUTE) } });
  });
  try {
    await sms.send({ phoneE164: phone, purpose: input.purpose, challengeId: id, code }, active.config);
    const ready = await db.$transaction(async tx => {
      await writer(tx, db);
      await lockSmsConfiguration(tx);
      await assertSmsConfigVersion(tx, active.version);
      const now = await smsDatabaseClock(tx);
      return tx.smsAuthChallenge.updateMany({ where: { id, configVersion: active.version, status: "pending", expiresAt: { gt: now } }, data: { status: "sent" } });
    });
    if (ready.count !== 1) throw new ApiError(503, "PHONE_AUTH_SEND_FAILED", "验证码未能发送，请稍后重新获取");
  } catch {
    await db.smsAuthChallenge.updateMany({ where: { id, status: "pending" }, data: { status: "failed" } }).catch(() => undefined);
    throw new ApiError(503, "PHONE_AUTH_SEND_FAILED", "验证码未能发送，请稍后重新获取");
  }
  return { challengeId: id, retryAfterSeconds: 60, expiresInSeconds: 300 };
}

export type PhoneAuthProof = { id: string; phone: string; fingerprint: string; purpose: SmsCodePurpose; digest: string; configVersion: number; subjectUserId: string | null; subjectAccountAccessVersion: number | null; subjectSecurityRevision: number | null; subjectPhoneFingerprint: string | null };
export async function verifyPhoneChallenge(input: { phone: unknown; challengeId: string; code: string }, purpose: SmsCodePurpose, db: PrismaClient, sms: SmsTransport = transport): Promise<PhoneAuthProof> {
  const active = await loadActiveSmsConfig(db);
  const phone = normalizeMainlandPhone(input.phone);
  if (!/^[0-9]{6}$/u.test(input.code) || !/^[0-9a-f-]{36}$/iu.test(input.challengeId)) throw invalidCode();
  const secret = phoneAuthSecret();
  const fingerprint = phoneFingerprint(phone, secret);
  const digest = smsCodeDigest({ id: input.challengeId, phone, purpose, code: input.code }, secret);
  // Wrong attempts commit before the error is returned; transaction rollback
  // cannot reset guessing limits. No provider request before admission succeeds.
  const ready = await db.$transaction(async tx => {
    await writer(tx, db);
    await lockSmsConfiguration(tx);
    await assertSmsConfigVersion(tx, active.version);
    const { now } = await reserveSmsVerifyBudget(tx, phone);
    const row = await tx.smsAuthChallenge.findUnique({ where: { id: input.challengeId } });
    if (!row || row.phoneFingerprint !== fingerprint || row.phoneE164 !== phone || row.purpose !== purpose || row.configVersion !== active.version || row.providerScheme !== smsProviderScheme(purpose, active.config) || row.status !== "sent" || row.consumedAt || row.expiresAt <= now || row.attemptCount >= 5) return null;
    if ((active.provider === "aliyun-pnvs") !== (row.expectedCodeDigest === null)) return null;
    await tx.smsAuthChallenge.update({ where: { id: row.id }, data: { attemptCount: { increment: 1 } } });
    return row;
  });
  if (!ready) throw invalidCode();
  if (ready.codeDigest) {
    if (!equalSmsDigest(ready.codeDigest, digest)) throw invalidCode();
  } else {
    let passed: boolean;
    try {
      if (active.provider === "aliyun-pnvs") {
        if (ready.expectedCodeDigest !== null) throw invalidCode();
        passed = await sms.check({ phoneE164: phone, purpose, challengeId: ready.id, code: input.code }, active.config);
      } else {
        passed = ready.expectedCodeDigest !== null && equalSmsDigest(ready.expectedCodeDigest, digest);
      }
    }
    catch {
      await db.smsAuthChallenge.updateMany({ where: { id: ready.id, status: "sent", consumedAt: null, verifiedAt: null }, data: { status: "failed" } }).catch(() => undefined);
      throw new ApiError(503, "PHONE_AUTH_VERIFY_UNAVAILABLE", "短信验证暂不可用，请重新获取验证码");
    }
    if (!passed) throw invalidCode();
    const verified = await db.$transaction(async tx => {
      await writer(tx, db);
      await lockSmsConfiguration(tx);
      await assertSmsConfigVersion(tx, active.version);
      const now = await smsDatabaseClock(tx);
      return tx.smsAuthChallenge.updateMany({ where: { id: ready.id, configVersion: active.version, status: "sent", consumedAt: null, expiresAt: { gt: now }, OR: [{ codeDigest: null }, { codeDigest: digest }] }, data: { codeDigest: digest, verifiedAt: now } });
    });
    if (verified.count !== 1) throw invalidCode();
  }
  return { id: ready.id, phone, fingerprint, purpose, digest, configVersion: active.version, subjectUserId: ready.subjectUserId, subjectAccountAccessVersion: ready.subjectAccountAccessVersion, subjectSecurityRevision: ready.subjectSecurityRevision, subjectPhoneFingerprint: ready.subjectPhoneFingerprint };
}

export async function consumePhoneChallenge(tx: Tx, proof: PhoneAuthProof, userId: string, now: Date): Promise<void> {
  await assertSmsConfigVersion(tx, proof.configVersion);
  const rows = await tx.$queryRaw<SmsAuthChallenge[]>`SELECT * FROM "SmsAuthChallenge" WHERE "id"=${proof.id}::uuid FOR UPDATE`;
  const row = rows[0];
  if (!row || row.phoneE164 !== proof.phone || row.phoneFingerprint !== proof.fingerprint || row.purpose !== proof.purpose || row.configVersion !== proof.configVersion || row.subjectUserId !== proof.subjectUserId || row.subjectAccountAccessVersion !== proof.subjectAccountAccessVersion || row.subjectSecurityRevision !== proof.subjectSecurityRevision || row.subjectPhoneFingerprint !== proof.subjectPhoneFingerprint || row.status !== "sent" || row.consumedAt || !row.verifiedAt || !row.codeDigest || !equalSmsDigest(row.codeDigest, proof.digest) || row.expiresAt <= now || row.attemptCount > 5) throw invalidCode();
  await tx.smsAuthChallenge.update({ where: { id: proof.id }, data: { consumedAt: now, consumedByUserId: userId } });
  await tx.$executeRaw`SELECT set_config('app.phone_auth_challenge_id',${proof.id},true)`;
}
export async function lockPhoneIdentity(tx: Tx, phone: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`phone-auth-account:${phone}`},0))`;
}
export async function assertPhoneAliasAvailable(tx: Tx, phone: string, allowedUserId?: string): Promise<void> {
  const collision = await tx.appUser.findUnique({ where: { username: phone.slice(3) }, select: { id: true } });
  if (collision && collision.id !== allowedUserId) throw new ApiError(409, "PHONE_AUTH_ACCOUNT_LINK_REQUIRED", "此手机号与已有登录名冲突，请使用原登录方式联系管理员处理");
}
export async function registerPhoneAccount(input: { username: unknown; password: unknown; phone: unknown; challengeId: string; code: string }, db = getEntitlementDb(), sms: SmsTransport = transport): Promise<CreatedSession> {
  requireLocalRegistrationEnabled();
  const username = normalizeLocalRegistrationUsername(input.username);
  validateAccountPassword(input.password);
  await reserveLocalRegistrationAttempt(username, db);
  const proof = await verifyPhoneChallenge(input, "register", db, sms);
  const password = await createPasswordRecord(input.password);
  try {
    return await db.$transaction(async tx => {
    await writer(tx, db);
    await lockSmsConfiguration(tx);
    await assertSmsConfigVersion(tx, proof.configVersion);
    await lockPhoneIdentity(tx, proof.phone);
    const now = await smsDatabaseClock(tx);
    if ((await tx.appUser.count({ where: { role: "admin" } })) === 0) throw new ApiError(503, "PHONE_AUTH_UNAVAILABLE", "平台尚未完成初始化");
    if (await tx.appUser.findUnique({ where: { phoneE164: proof.phone }, select: { id: true } })) throw new ApiError(409, "PHONE_AUTH_ALREADY_REGISTERED", "该手机号已注册，请直接登录");
    await assertPhoneAliasAvailable(tx, proof.phone);
    const userId = randomUUID();
    await consumePhoneChallenge(tx, proof, userId, now);
    return createOrdinaryAccountInTransaction(tx, { id: userId, username, password, phoneE164: proof.phone }, now);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new ApiError(409, "LOCAL_REGISTRATION_USERNAME_TAKEN", "该用户名或手机号已注册，请更换用户名或直接登录");
    }
    throw error;
  }
}
export async function loginWithSms(input: { phone: unknown; challengeId: string; code: string }, db = getEntitlementDb(), sms: SmsTransport = transport): Promise<{ session: CreatedSession; registered: boolean }> {
  const proof = await verifyPhoneChallenge(input, "login", db, sms);
  // Same durable signup budget as explicit registration, before auto-creation.
  // A preliminary lookup is advisory; the transaction rechecks under phone lock.
  if (!(await db.appUser.findUnique({ where: { phoneE164: proof.phone }, select: { id: true } }))) {
    requireSmsAutoRegistration();
    await reserveLocalRegistrationAttempt(`phone_${proof.fingerprint.slice(0, 24)}`, db);
  }
  return db.$transaction(async tx => {
    await writer(tx, db);
    await lockSmsConfiguration(tx);
    await assertSmsConfigVersion(tx, proof.configVersion);
    await lockPhoneIdentity(tx, proof.phone);
    const now = await smsDatabaseClock(tx);
    if ((await tx.appUser.count({ where: { role: "admin" } })) === 0) throw new ApiError(503, "PHONE_AUTH_UNAVAILABLE", "平台尚未完成初始化");
    const user = await tx.appUser.findUnique({ where: { phoneE164: proof.phone }, select: { id: true, disabledAt: true } });
    if (user) {
      await lockActorAccess(tx, user.id);
      if (user.disabledAt) throw new ApiError(403, "AUTH_ACCOUNT_DISABLED", "该账号已停用，请联系管理员");
      await consumePhoneChallenge(tx, proof, user.id, now);
      return { session: await createPhoneSessionInTransaction(tx, user.id, now), registered: false };
    }
    requireSmsAutoRegistration();
    await assertPhoneAliasAvailable(tx, proof.phone);
    const userId = randomUUID();
    await consumePhoneChallenge(tx, proof, userId, now);
    const username = `phone_${userId.replaceAll("-", "").slice(0, 20)}`;
    return { session: await createOrdinaryAccountInTransaction(tx, { id: userId, username, phoneE164: proof.phone }, now), registered: true };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}
