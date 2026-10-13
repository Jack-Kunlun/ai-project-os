import { randomInt, randomUUID } from "node:crypto";
import { Prisma, type EmailAuthChallenge, type PrismaClient } from "@prisma/client";
import { ApiError } from "@/lib/api-errors";
import { assertEntitlementWriterSession, getEntitlementDb, isEntitlementDatabase } from "@/lib/db";
import { assertAccountAccessForActor } from "@/lib/account-access-guard";
import { lockActorAccess } from "@/lib/access-linearization";
import type { SafeSessionUser } from "@/lib/auth";
import { isLocalRegistrationEnabled, requireLocalRegistrationEnabled } from "@/lib/local-registration-config";
import { readCaptchaBrowserToken, validCaptchaBrowserToken } from "@/lib/graphic-captcha-cookie";
import { consumeEmailGraphicCaptcha, type ConsumedEmailGraphicCaptchaBinding, type EmailAuthPurpose, type EmailGraphicCaptchaProof } from "@/lib/email-graphic-captcha-service";
import { emailDatabaseClock, lockEmailAuthAdmission, reserveEmailSendBudget, reserveEmailVerifyBudget } from "@/lib/email-auth-budget";
import { loadEmailAuthConfig, type ActiveEmailAuthConfig } from "@/lib/email-auth-config";
import { emailBudgetFingerprint, emailCodeDigest, emailFingerprint, equalEmailDigest, normalizeEmailAddress } from "@/lib/email-auth-identity";
import { sendAliyunEmailCode } from "@/lib/aliyun-direct-mail";

const CODE_TTL_MS = 10 * 60_000;
const ACTOR_PURPOSES = new Set<EmailAuthPurpose>(["verify", "password"]);
type Tx = Prisma.TransactionClient;
type Db = PrismaClient;
type EmailActor = SafeSessionUser;
type ActorSnapshot = Readonly<{
  id: string;
  accountAccessVersion: number;
  securityRevision: number;
  emailRevision: number;
  email: string;
  emailFingerprint: string;
  emailVerifiedAt: Date | null;
  disabledAt: Date | null;
  closedAt: Date | null;
}>;

export type EmailAuthProof = Readonly<{
  id: string;
  purpose: EmailAuthPurpose;
  emailFingerprint: string;
  browserFingerprint: string;
  configFingerprint: string;
  digest: string;
  subjectUserId: string | null;
  subjectAccountAccessVersion: number | null;
  subjectSecurityRevision: number | null;
  subjectEmailRevision: number | null;
  subjectEmailFingerprint: string | null;
}>;

export type EmailMailTransport = Readonly<{
  send: typeof sendAliyunEmailCode;
}>;
const defaultMailTransport: EmailMailTransport = Object.freeze({ send: sendAliyunEmailCode });

function invalidCode(): ApiError {
  return new ApiError(400, "EMAIL_AUTH_CODE_INVALID", "邮箱验证码无效或已过期，请重新获取");
}

function invalidCaptcha(): ApiError {
  return new ApiError(400, "EMAIL_GRAPHIC_CAPTCHA_INVALID", "图形验证码错误或已失效，请换一张后重试");
}

function matchesCaptchaBinding(
  binding: ConsumedEmailGraphicCaptchaBinding,
  purpose: EmailAuthPurpose,
  browserFingerprint: string,
  recipientFingerprint: string,
  actor: ActorSnapshot | null,
  config: ActiveEmailAuthConfig,
): boolean {
  return binding.purpose === purpose
    && binding.configFingerprint === config.configFingerprint
    && binding.browserFingerprint === browserFingerprint
    && binding.recipientFingerprint === recipientFingerprint
    && binding.actorId === (actor?.id ?? null)
    && binding.accountAccessVersion === (actor?.accountAccessVersion ?? null)
    && binding.securityRevision === (actor?.securityRevision ?? null)
    && binding.emailRevision === (actor?.emailRevision ?? null);
}

function writer(tx: Tx, db: Db): Promise<void> {
  return isEntitlementDatabase(db) ? assertEntitlementWriterSession(tx) : Promise.resolve();
}

async function getActorSnapshot(
  tx: Tx,
  actor: EmailActor,
  inputEmail: unknown,
  config: ActiveEmailAuthConfig,
): Promise<ActorSnapshot> {
  await lockActorAccess(tx, actor.id);
  try { await assertAccountAccessForActor(tx, actor); }
  catch { throw new ApiError(401, "AUTH_SESSION_STALE", "登录状态已失效，请重新登录后再试"); }
  const current = await tx.appUser.findUnique({
    where: { id: actor.id },
    select: { id: true, email: true, emailVerifiedAt: true, emailRevision: true, accountAccessVersion: true, securityRevision: true, disabledAt: true, closedAt: true },
  });
  if (!current || current.disabledAt || current.closedAt || !current.email) {
    throw new ApiError(403, "EMAIL_AUTH_FORBIDDEN", "当前账号没有可验证的邮箱");
  }
  if (actor.securityRevision !== current.securityRevision) throw new ApiError(401, "AUTH_SESSION_STALE", "登录状态已失效，请重新登录后再试");
  const email = normalizeEmailAddress(current.email);
  if (inputEmail !== undefined && normalizeEmailAddress(inputEmail) !== email) {
    throw new ApiError(409, "EMAIL_AUTH_RECIPIENT_CHANGED", "当前绑定邮箱已变化，请刷新后重试");
  }
  return {
    id: current.id,
    accountAccessVersion: current.accountAccessVersion,
    securityRevision: current.securityRevision,
    emailRevision: current.emailRevision,
    email,
    emailFingerprint: emailFingerprint(email, config.key),
    emailVerifiedAt: current.emailVerifiedAt,
    disabledAt: current.disabledAt,
    closedAt: current.closedAt,
  };
}

function requirePurposeState(purpose: EmailAuthPurpose, actor: ActorSnapshot | null): void {
  if (purpose === "register") {
    requireLocalRegistrationEnabled();
    return;
  }
  if (!actor) throw new ApiError(401, "AUTH_REQUIRED", "请先登录");
  if (purpose === "verify" && actor.emailVerifiedAt !== null) throw new ApiError(409, "EMAIL_AUTH_ALREADY_VERIFIED", "当前邮箱已经验证");
  if (purpose === "password" && actor.emailVerifiedAt === null) throw new ApiError(409, "EMAIL_AUTH_EMAIL_UNVERIFIED", "请先验证当前邮箱，再使用邮箱验证码修改密码");
}

/** Admission commits before the one external email send; ambiguous sends are never retried. */
export async function issueEmailChallenge(
  input: {
    email?: unknown;
    purpose: EmailAuthPurpose;
    actor?: EmailActor;
    captcha: EmailGraphicCaptchaProof;
    browserToken: string;
  },
  db: Db = getEntitlementDb(),
  mail: EmailMailTransport = defaultMailTransport,
): Promise<{ challengeId: string; retryAfterSeconds: 60; expiresInSeconds: 600 }> {
  const config = await loadEmailAuthConfig();
  if (!validCaptchaBrowserToken(input.browserToken)) throw new ApiError(400, "EMAIL_GRAPHIC_CAPTCHA_INVALID", "图形验证码错误或已失效，请换一张后重试");
  const registerEmail = input.purpose === "register" ? normalizeEmailAddress(input.email) : undefined;
  const captchaBinding = await consumeEmailGraphicCaptcha({
    email: input.email,
    purpose: input.purpose,
    browserToken: input.browserToken,
    actor: input.actor,
    captcha: input.captcha,
  }, db);
  const id = randomUUID();
  const code = randomInt(1_000_000).toString().padStart(6, "0");
  const recipientFingerprint = registerEmail ? emailFingerprint(registerEmail, config.key) : null;
  const browserFingerprint = emailBudgetFingerprint("browser", input.browserToken, config.key);
  const expectedCodeDigest = registerEmail
    ? emailCodeDigest({ id, recipientFingerprint: recipientFingerprint!, purpose: input.purpose, code }, config.key)
    : null;
  let recipient = registerEmail ?? null;
  if (
    captchaBinding.purpose !== input.purpose
    || captchaBinding.configFingerprint !== config.configFingerprint
    || captchaBinding.browserFingerprint !== browserFingerprint
    || (registerEmail !== undefined && captchaBinding.recipientFingerprint !== emailFingerprint(registerEmail, config.key))
  ) throw invalidCaptcha();

  await db.$transaction(async (tx) => {
    await writer(tx, db);
    await lockEmailAuthAdmission(tx);
    const now = await emailDatabaseClock(tx);
    const actor = input.actor ? await getActorSnapshot(tx, input.actor, input.email, config) : null;
    const currentRecipientFingerprint = actor?.emailFingerprint
      ?? (registerEmail ? emailFingerprint(registerEmail, config.key) : null);
    if (!currentRecipientFingerprint || !matchesCaptchaBinding(captchaBinding, input.purpose, browserFingerprint, currentRecipientFingerprint, actor, config)) {
      throw invalidCaptcha();
    }
    requirePurposeState(input.purpose, actor);
    recipient = actor?.email ?? registerEmail ?? null;
    if (!recipient) throw new ApiError(400, "EMAIL_AUTH_INVALID_EMAIL", "请输入有效的邮箱地址");
    const emailFp = actor?.emailFingerprint ?? recipientFingerprint!;
    const browserFp = browserFingerprint;
    const actorFp = actor ? emailBudgetFingerprint("actor", actor.id, config.key) : null;
    const codeDigest = actor
      ? emailCodeDigest({ id, recipientFingerprint: emailFp, purpose: input.purpose, code }, config.key)
      : expectedCodeDigest!;
    await reserveEmailSendBudget(tx, { recipientFingerprint: emailFp, browserFingerprint: browserFp, actorFingerprint: actorFp }, now);
    if ((await tx.appUser.count({ where: { role: "admin" } })) === 0) throw new ApiError(503, "EMAIL_AUTH_UNAVAILABLE", "平台尚未完成初始化");
    await tx.emailAuthChallenge.updateMany({
      where: { emailFingerprint: emailFp, purpose: input.purpose, status: { in: ["pending", "sent"] }, consumedAt: null },
      data: { status: "superseded" },
    });
    await tx.emailAuthChallenge.create({ data: {
      id,
      emailFingerprint: emailFp,
      browserFingerprint: browserFp,
      purpose: input.purpose,
      configFingerprint: config.configFingerprint,
      expectedCodeDigest: codeDigest,
      status: "pending",
      attemptCount: 0,
      expiresAt: new Date(now.getTime() + CODE_TTL_MS),
      consumedAt: null,
      consumedByUserId: null,
      subjectUserId: actor?.id ?? null,
      subjectAccountAccessVersion: actor?.accountAccessVersion ?? null,
      subjectSecurityRevision: actor?.securityRevision ?? null,
      subjectEmailRevision: actor?.emailRevision ?? null,
      subjectEmailFingerprint: actor?.emailFingerprint ?? null,
      createdAt: now,
    } });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });

  try {
    const acknowledgement = await mail.send({ email: recipient!, code, purpose: input.purpose }, config.mail);
    const marked = await db.$transaction(async (tx) => {
      await writer(tx, db);
      await lockEmailAuthAdmission(tx);
      const now = await emailDatabaseClock(tx);
      return tx.emailAuthChallenge.updateMany({
        where: { id, status: "pending", configFingerprint: config.configFingerprint, expiresAt: { gt: now } },
        data: { status: "sent", providerRequestId: acknowledgement.requestId, providerEnvId: acknowledgement.envId },
      });
    });
    if (marked.count !== 1) throw new Error("EMAIL_CHALLENGE_NOT_READY");
  } catch {
    await db.emailAuthChallenge.updateMany({
      where: { id, status: "pending" },
      data: { status: "failed", safeErrorCode: "EMAIL_PROVIDER_UNAVAILABLE" },
    }).catch(() => undefined);
    throw new ApiError(503, "EMAIL_PROVIDER_UNAVAILABLE", "邮箱验证码未能发送，请稍后重新获取");
  }
  return { challengeId: id, retryAfterSeconds: 60, expiresInSeconds: 600 };
}

export async function verifyEmailChallenge(
  input: { challengeId: string; code: string; purpose: EmailAuthPurpose; actor?: EmailActor; email?: unknown; browserToken: string },
  db: Db = getEntitlementDb(),
): Promise<EmailAuthProof> {
  const config = await loadEmailAuthConfig();
  if (!/^[0-9a-f-]{36}$/iu.test(input.challengeId) || !/^[0-9]{6}$/u.test(input.code) || !validCaptchaBrowserToken(input.browserToken)) throw invalidCode();
  const registerEmail = input.purpose === "register" ? normalizeEmailAddress(input.email) : undefined;
  const browserFingerprint = emailBudgetFingerprint("browser", input.browserToken, config.key);
  let proof: EmailAuthProof | null = null;
  await db.$transaction(async (tx) => {
    await writer(tx, db);
    await lockEmailAuthAdmission(tx);
    const now = await emailDatabaseClock(tx);
    let actor: ActorSnapshot | null = null;
    let actorReadValid = true;
    if (ACTOR_PURPOSES.has(input.purpose)) {
      if (!input.actor) actorReadValid = false;
      else {
        try { actor = await getActorSnapshot(tx, input.actor, input.email, config); }
        catch { actorReadValid = false; }
      }
    }
    const email = actor?.email ?? registerEmail ?? (input.email === undefined ? null : (() => { try { return normalizeEmailAddress(input.email); } catch { return null; } })());
    const recipientFp = actor?.emailFingerprint ?? (email ? emailFingerprint(email, config.key) : "0".repeat(64));
    const actorFp = input.actor ? emailBudgetFingerprint("actor", input.actor.id, config.key) : null;
    await reserveEmailVerifyBudget(tx, { recipientFingerprint: recipientFp, browserFingerprint, actorFingerprint: actorFp }, now);
    const [row] = await tx.$queryRaw<EmailAuthChallenge[]>`SELECT * FROM "EmailAuthChallenge" WHERE "id"=${input.challengeId}::uuid FOR UPDATE`;
    if (!row) return;

    const snapshotMatches = input.purpose === "register"
      ? row.subjectUserId === null && row.subjectAccountAccessVersion === null && row.subjectSecurityRevision === null && row.subjectEmailRevision === null && row.subjectEmailFingerprint === null
      : Boolean(actor && row.subjectUserId === actor.id
        && row.subjectAccountAccessVersion === actor.accountAccessVersion
        && row.subjectSecurityRevision === actor.securityRevision
        && row.subjectEmailRevision === actor.emailRevision
        && row.subjectEmailFingerprint === actor.emailFingerprint);
    const purposeStateValid = input.purpose === "register"
      ? isLocalRegistrationEnabled()
      : Boolean(actor && (input.purpose === "verify" ? actor.emailVerifiedAt === null : actor.emailVerifiedAt !== null));
    const bindingMatches = row.emailFingerprint === recipientFp
      && row.browserFingerprint === browserFingerprint
      && row.purpose === input.purpose
      && row.configFingerprint === config.configFingerprint
      && snapshotMatches;
    if (row.status !== "sent" || row.consumedAt || row.expiresAt <= now || row.attemptCount >= 5) return;
    const candidateDigest = emailCodeDigest({ id: row.id, recipientFingerprint: recipientFp, purpose: input.purpose, code: input.code }, config.key);
    const correct = bindingMatches && actorReadValid && purposeStateValid && equalEmailDigest(row.expectedCodeDigest, candidateDigest);
    await tx.emailAuthChallenge.update({
      where: { id: row.id },
      data: {
        attemptCount: { increment: 1 },
        ...(correct ? { codeDigest: candidateDigest, verifiedAt: row.verifiedAt ?? now } : {}),
      },
    });
    if (!correct) return;
    proof = Object.freeze({
      id: row.id,
      purpose: input.purpose,
      emailFingerprint: row.emailFingerprint,
      browserFingerprint: row.browserFingerprint,
      configFingerprint: row.configFingerprint,
      digest: candidateDigest,
      subjectUserId: row.subjectUserId,
      subjectAccountAccessVersion: row.subjectAccountAccessVersion,
      subjectSecurityRevision: row.subjectSecurityRevision,
      subjectEmailRevision: row.subjectEmailRevision,
      subjectEmailFingerprint: row.subjectEmailFingerprint,
    });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  if (!proof) throw invalidCode();
  return proof;
}

/** Final proof use is deliberately actor-lock -> challenge-row only; callers own actor serialization. */
export async function consumeEmailAuthProof(
  tx: Tx,
  proof: EmailAuthProof,
  userId: string,
  browserToken: string,
  now: Date,
  config: ActiveEmailAuthConfig,
): Promise<EmailAuthChallenge> {
  if (!validCaptchaBrowserToken(browserToken)) throw invalidCode();
  const browserFingerprint = emailBudgetFingerprint("browser", browserToken, config.key);
  const rows = await tx.$queryRaw<EmailAuthChallenge[]>`SELECT * FROM "EmailAuthChallenge" WHERE "id"=${proof.id}::uuid FOR UPDATE`;
  const row = rows[0];
  const lockedNow = await emailDatabaseClock(tx);
  const baseValid = row !== undefined
    && row.id === proof.id
    && row.purpose === proof.purpose
    && row.emailFingerprint === proof.emailFingerprint
    && row.browserFingerprint === browserFingerprint
    && row.browserFingerprint === proof.browserFingerprint
    && row.configFingerprint === config.configFingerprint
    && row.configFingerprint === proof.configFingerprint
    && row.status === "sent"
    && row.consumedAt === null
    && row.verifiedAt !== null
    && row.codeDigest !== null
    && row.codeDigest === proof.digest
    && row.expectedCodeDigest === proof.digest
    && row.expiresAt > now
    && row.expiresAt > lockedNow
    && row.attemptCount >= 1 && row.attemptCount <= 5
    && row.subjectUserId === proof.subjectUserId
    && row.subjectAccountAccessVersion === proof.subjectAccountAccessVersion
    && row.subjectSecurityRevision === proof.subjectSecurityRevision
    && row.subjectEmailRevision === proof.subjectEmailRevision
    && row.subjectEmailFingerprint === proof.subjectEmailFingerprint;
  if (!baseValid || !row) throw invalidCode();

  if (row.purpose === "register") {
    if (row.subjectUserId !== null || row.subjectEmailFingerprint !== null) throw invalidCode();
  } else {
    if (row.subjectUserId !== userId || !row.subjectEmailFingerprint) throw invalidCode();
    const subject = await tx.appUser.findUnique({
      where: { id: userId },
      select: { email: true, emailVerifiedAt: true, emailRevision: true, accountAccessVersion: true, securityRevision: true, disabledAt: true, closedAt: true },
    });
    if (!subject || subject.disabledAt || subject.closedAt || !subject.email
      || emailFingerprint(normalizeEmailAddress(subject.email), config.key) !== row.subjectEmailFingerprint
      || subject.emailRevision !== row.subjectEmailRevision
      || subject.accountAccessVersion !== row.subjectAccountAccessVersion
      || subject.securityRevision !== row.subjectSecurityRevision
      || (row.purpose === "verify" && subject.emailVerifiedAt !== null)
      || (row.purpose === "password" && subject.emailVerifiedAt === null)) throw invalidCode();
  }

  const consumed = await tx.emailAuthChallenge.updateMany({
    where: { id: row.id, status: "sent", consumedAt: null, verifiedAt: { not: null }, expiresAt: { gt: lockedNow } },
    data: { consumedAt: lockedNow, consumedByUserId: userId },
  });
  if (consumed.count !== 1) throw invalidCode();
  await tx.$executeRaw`SELECT set_config('app.email_auth_challenge_id',${row.id},true), set_config('app.email_auth_email_fingerprint',${row.emailFingerprint},true)`;
  return row;
}

/** Returns the actor's current email without accepting a client-selected recipient. */
export async function currentAccountEmail(actor: EmailActor, db: Db = getEntitlementDb()): Promise<string> {
  const current = await db.appUser.findUnique({ where: { id: actor.id }, select: { email: true, disabledAt: true, closedAt: true, securityRevision: true } });
  if (!current || current.disabledAt || current.closedAt || current.securityRevision !== actor.securityRevision || !current.email) {
    throw new ApiError(403, "EMAIL_AUTH_FORBIDDEN", "当前账号没有可验证的邮箱");
  }
  return normalizeEmailAddress(current.email);
}

export function browserTokenFromRequest(request: Request): string | undefined {
  return readCaptchaBrowserToken(request);
}
