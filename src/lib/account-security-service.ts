import { Prisma, type PrismaClient } from "@prisma/client";
import { ApiError } from "@/lib/api-errors";
import { assertAccountAccessForActor } from "@/lib/account-access-guard";
import { lockActorAccess } from "@/lib/access-linearization";
import { appendAccountSecurityAudit } from "@/lib/account-security-audit";
import { getEntitlementDb, isEntitlementDatabase, assertEntitlementWriterSession } from "@/lib/db";
import { verifyPasswordRecord, createPasswordRecord, validateAccountPassword, type SafeSessionUser } from "@/lib/auth";
import { phoneAuthSecret, lockSmsConfiguration } from "@/lib/phone-auth-config";
import { phoneFingerprint } from "@/lib/phone-auth-identity";
import { reserveAccountPasswordVerifyBudget, smsDatabaseClock } from "@/lib/phone-auth-budget";
import { assertPhoneAliasAvailable, consumePhoneChallenge, lockPhoneIdentity, verifyPhoneChallenge, type PhoneAuthProof, type SmsTransport } from "@/lib/phone-auth-service";

type Tx = Prisma.TransactionClient;
const UNKNOWN_RECOVERY_USER = "00000000-0000-0000-0000-000000000000";
function recoveryInvalid(): ApiError { return new ApiError(400, "ACCOUNT_RECOVERY_INVALID", "账号信息或验证码无效，请重新获取验证码后重试"); }
function securityForbidden(): ApiError { return new ApiError(403, "ACCOUNT_SECURITY_FORBIDDEN", "当前账号不能执行此安全操作，请重新登录后再试"); }
function currentPasswordInvalid(): ApiError { return new ApiError(403, "ACCOUNT_CURRENT_PASSWORD_INVALID", "当前密码错误"); }
function phoneInUse(): ApiError { return new ApiError(409, "PHONE_AUTH_PHONE_IN_USE", "该手机号已绑定其他账号"); }
async function writer(tx: Tx, db: PrismaClient): Promise<void> {
  if (isEntitlementDatabase(db)) await assertEntitlementWriterSession(tx);
}
function securityErrorFresh(actor: SafeSessionUser, current: { accountAccessVersion: number; securityRevision: number }): void {
  if (actor.accountAccessVersion !== current.accountAccessVersion || actor.securityRevision !== current.securityRevision) {
    throw new ApiError(401, "AUTH_SESSION_STALE", "登录状态已失效，请重新登录后再试");
  }
}
function proofMatchesActor(proof: PhoneAuthProof, actor: SafeSessionUser, currentPhone: string | null): boolean {
  const expectedPhoneFingerprint = currentPhone ? phoneFingerprint(currentPhone, phoneAuthSecret()) : null;
  return proof.subjectUserId === actor.id
    && proof.subjectAccountAccessVersion === actor.accountAccessVersion
    && proof.subjectSecurityRevision === actor.securityRevision
    && proof.subjectPhoneFingerprint === expectedPhoneFingerprint;
}
async function currentActor(tx: Tx, actor: SafeSessionUser) {
  await lockActorAccess(tx, actor.id);
  await assertAccountAccessForActor(tx, actor);
  const current = await tx.appUser.findUnique({ where: { id: actor.id } });
  if (!current || current.disabledAt || current.closedAt) throw securityForbidden();
  securityErrorFresh(actor, current);
  return current;
}
async function revokeAllSessions(tx: Tx, userId: string, now: Date): Promise<void> {
  await tx.appSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } });
}
async function invalidatePhoneChallenges(tx: Tx, phones: readonly string[]): Promise<void> {
  const uniquePhones = [...new Set(phones)];
  if (uniquePhones.length === 0) return;
  await tx.smsAuthChallenge.updateMany({
    where: { phoneE164: { in: uniquePhones }, status: { in: ["pending", "sent"] }, consumedAt: null },
    data: { status: "superseded" },
  });
}
async function consumeFailedBindingProof(db: PrismaClient, actor: SafeSessionUser, proof: PhoneAuthProof): Promise<void> {
  await db.$transaction(async tx => {
    await writer(tx, db);
    await lockSmsConfiguration(tx);
    await lockPhoneIdentity(tx, proof.phone);
    await lockActorAccess(tx, actor.id);
    const now = await smsDatabaseClock(tx);
    await consumePhoneChallenge(tx, proof, actor.id, now);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}

export async function recoverAccountPassword(
  input: { phone: unknown; challengeId: string; code: string; newPassword: unknown },
  db: PrismaClient = getEntitlementDb(),
  sms?: SmsTransport,
): Promise<{ username: string }> {
  validateAccountPassword(input.newPassword);
  const proof = await verifyPhoneChallenge(input, "recover", db, sms);
  if (!proof.subjectUserId) {
    await db.$transaction(async tx => {
      await writer(tx, db);
      await lockSmsConfiguration(tx);
      await lockPhoneIdentity(tx, proof.phone);
      const now = await smsDatabaseClock(tx);
      await consumePhoneChallenge(tx, proof, UNKNOWN_RECOVERY_USER, now);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    throw recoveryInvalid();
  }
  const password = await createPasswordRecord(input.newPassword);
  const result = await db.$transaction(async tx => {
    await writer(tx, db);
    await lockSmsConfiguration(tx);
    await lockPhoneIdentity(tx, proof.phone);
    await lockActorAccess(tx, proof.subjectUserId!);
    const now = await smsDatabaseClock(tx);
    const current = await tx.appUser.findUnique({ where: { id: proof.subjectUserId! } });
    const matches = current !== null
      && !current.disabledAt
      && !current.closedAt
      && current.phoneE164 === proof.phone
      && current.phoneVerifiedAt !== null
      && current.accountAccessVersion === proof.subjectAccountAccessVersion
      && current.securityRevision === proof.subjectSecurityRevision
      && proof.subjectPhoneFingerprint === proof.fingerprint;
    if (!matches || !current) {
      await consumePhoneChallenge(tx, proof, proof.subjectUserId!, now);
      return null;
    }
    await consumePhoneChallenge(tx, proof, current.id, now);
    await appendAccountSecurityAudit(tx, {
      userId: current.id,
      actorId: null,
      action: "password_recovered",
      securityRevisionBefore: current.securityRevision,
      phoneFingerprintBefore: proof.fingerprint,
      phoneFingerprintAfter: proof.fingerprint,
      proofChallengeId: proof.id,
    });
    await tx.appUser.update({ where: { id: current.id }, data: { ...password, securityRevision: { increment: 1 } } });
    await revokeAllSessions(tx, current.id, now);
    await invalidatePhoneChallenges(tx, [proof.phone]);
    return { username: current.username };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 15_000 });
  if (!result) throw recoveryInvalid();
  return result;
}

export async function bindAccountPhone(
  actor: SafeSessionUser,
  input: { phone: unknown; challengeId: string; code: string; currentPassword: unknown },
  db: PrismaClient = getEntitlementDb(),
  sms?: SmsTransport,
): Promise<void> {
  const proof = await verifyPhoneChallenge(input, "bind", db, sms);
  const admitted = await db.$transaction(async tx => {
    await writer(tx, db);
    await lockSmsConfiguration(tx);
    await reserveAccountPasswordVerifyBudget(tx, actor.id);
    await lockPhoneIdentity(tx, proof.phone);
    const current = await currentActor(tx, actor);
    if (current.phoneE164 || current.phoneVerifiedAt) throw new ApiError(409, "ACCOUNT_PHONE_ALREADY_BOUND", "账号已绑定手机号，请使用换绑流程");
    if (!current.passwordHash || !current.passwordSalt) throw new ApiError(409, "ACCOUNT_LOCAL_PASSWORD_REQUIRED", "请先设置本地密码并重新登录，再绑定手机号");
    if (proof.subjectUserId !== current.id || proof.subjectAccountAccessVersion !== current.accountAccessVersion
      || proof.subjectSecurityRevision !== current.securityRevision || proof.subjectPhoneFingerprint !== null) throw securityForbidden();
    return current;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  if (!await verifyPasswordRecord(input.currentPassword, admitted)) {
    await consumeFailedBindingProof(db, actor, proof).catch(() => undefined);
    throw currentPasswordInvalid();
  }
  try {
    await db.$transaction(async tx => {
      await writer(tx, db);
      await lockSmsConfiguration(tx);
      await lockPhoneIdentity(tx, proof.phone);
      const current = await currentActor(tx, actor);
      if (current.phoneE164 || current.phoneVerifiedAt) throw new ApiError(409, "ACCOUNT_PHONE_ALREADY_BOUND", "账号已绑定手机号，请使用换绑流程");
      if (current.passwordHash !== admitted.passwordHash || current.passwordSalt !== admitted.passwordSalt
        || current.securityRevision !== admitted.securityRevision) throw securityForbidden();
      if (proof.subjectUserId !== current.id || proof.subjectAccountAccessVersion !== current.accountAccessVersion
        || proof.subjectSecurityRevision !== current.securityRevision || proof.subjectPhoneFingerprint !== null) throw securityForbidden();
      const owner = await tx.appUser.findUnique({ where: { phoneE164: proof.phone }, select: { id: true } });
      if (owner && owner.id !== current.id) throw phoneInUse();
      await assertPhoneAliasAvailable(tx, proof.phone, current.id);
      const now = await smsDatabaseClock(tx);
      await consumePhoneChallenge(tx, proof, current.id, now);
      await appendAccountSecurityAudit(tx, {
        userId: current.id,
        actorId: current.id,
        action: "phone_bound",
        securityRevisionBefore: current.securityRevision,
        phoneFingerprintAfter: proof.fingerprint,
        proofChallengeId: proof.id,
      });
      await tx.appUser.update({ where: { id: current.id }, data: { phoneE164: proof.phone, phoneVerifiedAt: now, securityRevision: { increment: 1 } } });
      await revokeAllSessions(tx, current.id, now);
      await invalidatePhoneChallenges(tx, [proof.phone]);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 15_000 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw phoneInUse();
    throw error;
  }
}

export async function changeAccountPhone(
  actor: SafeSessionUser,
  input: { oldPhone: unknown; oldChallengeId: string; oldCode: string; phone: unknown; challengeId: string; code: string },
  db: PrismaClient = getEntitlementDb(),
  sms?: SmsTransport,
): Promise<void> {
  const oldProof = await verifyPhoneChallenge({ phone: input.oldPhone, challengeId: input.oldChallengeId, code: input.oldCode }, "change-old", db, sms);
  const newProof = await verifyPhoneChallenge({ phone: input.phone, challengeId: input.challengeId, code: input.code }, "change-new", db, sms);
  const identityPhones = [oldProof.phone, newProof.phone].sort();
  try {
    await db.$transaction(async tx => {
      await writer(tx, db);
      await lockSmsConfiguration(tx);
      for (const phone of identityPhones) await lockPhoneIdentity(tx, phone);
      const current = await currentActor(tx, actor);
      if (!current.phoneE164 || !current.phoneVerifiedAt || current.phoneE164 !== oldProof.phone) throw securityForbidden();
      if (current.username === oldProof.phone.slice(3)) {
        throw new ApiError(409, "PHONE_AUTH_LOGIN_NAME_UPDATE_REQUIRED", "当前登录名仍是旧手机号，请先修改登录名后再换绑");
      }
      if (!proofMatchesActor(oldProof, actor, current.phoneE164) || !proofMatchesActor(newProof, actor, current.phoneE164)) throw securityForbidden();
      if (oldProof.purpose !== "change-old" || newProof.purpose !== "change-new") throw recoveryInvalid();
      if (newProof.phone === oldProof.phone) throw new ApiError(409, "PHONE_AUTH_PHONE_UNCHANGED", "新手机号与当前绑定手机号相同");
      const owner = await tx.appUser.findUnique({ where: { phoneE164: newProof.phone }, select: { id: true } });
      if (owner && owner.id !== current.id) throw phoneInUse();
      await assertPhoneAliasAvailable(tx, newProof.phone, current.id);
      const now = await smsDatabaseClock(tx);
      await consumePhoneChallenge(tx, oldProof, current.id, now);
      await consumePhoneChallenge(tx, newProof, current.id, now);
      await appendAccountSecurityAudit(tx, {
        userId: current.id,
        actorId: current.id,
        action: "phone_changed",
        securityRevisionBefore: current.securityRevision,
        phoneFingerprintBefore: oldProof.fingerprint,
        phoneFingerprintAfter: newProof.fingerprint,
        proofChallengeId: oldProof.id,
        secondaryProofChallengeId: newProof.id,
      });
      await tx.appUser.update({ where: { id: current.id }, data: { phoneE164: newProof.phone, phoneVerifiedAt: now, securityRevision: { increment: 1 } } });
      await revokeAllSessions(tx, current.id, now);
      await invalidatePhoneChallenges(tx, [oldProof.phone, newProof.phone]);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 15_000 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw phoneInUse();
    throw error;
  }
}
