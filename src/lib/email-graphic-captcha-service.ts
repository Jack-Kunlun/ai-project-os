import { randomUUID } from "node:crypto";
import { type EmailGraphicCaptchaChallenge, type Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { ApiError } from "@/lib/api-errors";
import { assertEntitlementWriterSession, getEntitlementDb, isEntitlementDatabase } from "@/lib/db";
import { assertAccountAccessForActor } from "@/lib/account-access-guard";
import { lockActorAccess } from "@/lib/access-linearization";
import type { SafeSessionUser } from "@/lib/auth";
import { newCaptchaAnswer, renderGraphicCaptcha } from "@/lib/graphic-captcha-image";
import { validCaptchaBrowserToken } from "@/lib/graphic-captcha-cookie";
import { emailDatabaseClock, reserveEmailCaptchaBudget } from "@/lib/email-auth-budget";
import { loadEmailAuthConfig, type ActiveEmailAuthConfig } from "@/lib/email-auth-config";
import { emailBudgetFingerprint, emailCaptchaDigest, emailFingerprint, normalizeEmailAddress } from "@/lib/email-auth-identity";

export const emailGraphicCaptchaProofSchema = z.object({ challengeId: z.string().uuid(), answer: z.string().regex(/^[A-Za-z0-9]{6}$/u) }).strict();
export type EmailGraphicCaptchaProof = z.infer<typeof emailGraphicCaptchaProofSchema>;
export type EmailAuthPurpose = "register" | "verify" | "password";
type Tx = Prisma.TransactionClient;
type ActorSnapshot = Readonly<{
  id: string;
  accountAccessVersion: number;
  securityRevision: number;
  emailRevision: number;
  email: string;
  emailFingerprint: string;
}>;
type CaptchaInput = Readonly<{
  email: unknown;
  purpose: EmailAuthPurpose;
  browserToken: string;
  actor?: SafeSessionUser;
}>;
export type ConsumedEmailGraphicCaptchaBinding = Readonly<{
  purpose: EmailAuthPurpose;
  recipientFingerprint: string;
  browserFingerprint: string;
  actorId: string | null;
  accountAccessVersion: number | null;
  securityRevision: number | null;
  emailRevision: number | null;
  configFingerprint: string;
}>;
const ACTOR_PURPOSES = new Set<EmailAuthPurpose>(["verify", "password"]);
const TTL = 180_000;

function invalidCaptcha(): ApiError {
  return new ApiError(400, "EMAIL_GRAPHIC_CAPTCHA_INVALID", "图形验证码错误或已失效，请换一张后重试");
}

async function writer(tx: Tx, db: PrismaClient): Promise<void> {
  if (isEntitlementDatabase(db)) await assertEntitlementWriterSession(tx);
}

async function actorSnapshot(
  tx: Tx,
  input: CaptchaInput,
  config: ActiveEmailAuthConfig,
  requestEmail?: string,
): Promise<ActorSnapshot | null> {
  if (!ACTOR_PURPOSES.has(input.purpose)) return null;
  if (!input.actor) throw new ApiError(401, "AUTH_REQUIRED", "请先登录");
  await lockActorAccess(tx, input.actor.id);
  try {
    await assertAccountAccessForActor(tx, input.actor);
  } catch {
    throw new ApiError(401, "AUTH_SESSION_STALE", "登录状态已失效，请重新登录后再试");
  }
  const user = await tx.appUser.findUnique({
    where: { id: input.actor.id },
    select: { id: true, email: true, emailVerifiedAt: true, accountAccessVersion: true, securityRevision: true, emailRevision: true, disabledAt: true, closedAt: true },
  });
  if (!user || user.disabledAt || user.closedAt || !user.email) throw new ApiError(403, "EMAIL_AUTH_FORBIDDEN", "当前账号不能执行邮箱验证");
  if (input.actor.securityRevision !== user.securityRevision) throw new ApiError(401, "AUTH_SESSION_STALE", "登录状态已失效，请重新登录后再试");
  const email = normalizeEmailAddress(user.email);
  if (requestEmail !== undefined && normalizeEmailAddress(requestEmail) !== email) {
    throw new ApiError(409, "EMAIL_AUTH_RECIPIENT_CHANGED", "当前绑定邮箱已变化，请刷新后重试");
  }
  if (input.purpose === "verify" && user.emailVerifiedAt !== null) throw new ApiError(409, "EMAIL_AUTH_ALREADY_VERIFIED", "当前邮箱已经验证");
  if (input.purpose === "password" && user.emailVerifiedAt === null) throw new ApiError(409, "EMAIL_AUTH_EMAIL_UNVERIFIED", "请先验证当前邮箱，再使用邮箱验证码修改密码");
  return {
    id: user.id,
    accountAccessVersion: user.accountAccessVersion,
    securityRevision: user.securityRevision,
    emailRevision: user.emailRevision,
    email,
    emailFingerprint: emailFingerprint(email, config.key),
  };
}

function captchaBindings(input: CaptchaInput, config: ActiveEmailAuthConfig, snapshot: ActorSnapshot | null, email: string) {
  const recipientFingerprint = snapshot?.emailFingerprint ?? emailFingerprint(email, config.key);
  const browserFingerprint = emailBudgetFingerprint("browser", input.browserToken, config.key);
  return {
    email,
    recipientFingerprint,
    browserFingerprint,
    actorId: snapshot?.id ?? null,
    actorAccountAccessVersion: snapshot?.accountAccessVersion ?? null,
    actorSecurityRevision: snapshot?.securityRevision ?? null,
    actorEmailRevision: snapshot?.emailRevision ?? null,
  };
}

export async function issueEmailGraphicCaptcha(
  input: CaptchaInput,
  db: PrismaClient = getEntitlementDb(),
  renderer: (answer: string) => Promise<Buffer> = renderGraphicCaptcha,
): Promise<{ challengeId: string; image: string; expiresInSeconds: 180 }> {
  const config = await loadEmailAuthConfig();
  if (!validCaptchaBrowserToken(input.browserToken)) throw invalidCaptcha();
  if (input.purpose === "register") {
    const email = normalizeEmailAddress(input.email);
    const browserFingerprint = emailBudgetFingerprint("browser", input.browserToken, config.key);
    const recipientFingerprint = emailFingerprint(email, config.key);
    const id = randomUUID();
    const answer = newCaptchaAnswer();
    await db.$transaction(async (tx) => {
      await writer(tx, db);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('email-graphic-captcha-admission-v1',0))`;
      const now = await emailDatabaseClock(tx);
      await tx.emailGraphicCaptchaChallenge.deleteMany({ where: { expiresAt: { lt: new Date(now.getTime() - 86_400_000) } } });
      await tx.emailGraphicCaptchaBudget.deleteMany({ where: { updatedAt: { lt: new Date(now.getTime() - 86_400_000) } } });
      await reserveEmailCaptchaBudget(tx, "issue", { recipientFingerprint, browserFingerprint }, now);
      await tx.emailGraphicCaptchaChallenge.create({ data: {
        id, emailFingerprint: recipientFingerprint, browserFingerprint, purpose: input.purpose,
        actorId: null, actorAccountAccessVersion: null, actorSecurityRevision: null, actorEmailRevision: null,
        answerDigest: emailCaptchaDigest({ id, recipientFingerprint, browserFingerprint, purpose: input.purpose, actorId: null, actorAccountAccessVersion: null, actorSecurityRevision: null, actorEmailRevision: null, answer }, config.key),
        createdAt: now, expiresAt: new Date(now.getTime() + TTL),
      } });
    });
    try { return { challengeId: id, image: `data:image/png;base64,${(await renderer(answer)).toString("base64")}`, expiresInSeconds: 180 }; }
    catch { await db.emailGraphicCaptchaChallenge.deleteMany({ where: { id } }).catch(() => undefined); throw new ApiError(503, "EMAIL_AUTH_UNAVAILABLE", "邮箱验证暂不可用，请稍后重试"); }
  }

  const preliminaryEmail = input.email === undefined ? null : normalizeEmailAddress(input.email);
  const id = randomUUID();
  const answer = newCaptchaAnswer();
  let bindings: ReturnType<typeof captchaBindings> | null = null;
  await db.$transaction(async (tx) => {
    await writer(tx, db);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('email-graphic-captcha-admission-v1',0))`;
    const now = await emailDatabaseClock(tx);
    const snapshot = await actorSnapshot(tx, input, config, preliminaryEmail ?? undefined);
    const email = snapshot?.email ?? preliminaryEmail;
    if (!email) throw invalidCaptcha();
    bindings = captchaBindings(input, config, snapshot, email);
    await tx.emailGraphicCaptchaChallenge.deleteMany({ where: { expiresAt: { lt: new Date(now.getTime() - 86_400_000) } } });
    await tx.emailGraphicCaptchaBudget.deleteMany({ where: { updatedAt: { lt: new Date(now.getTime() - 86_400_000) } } });
    await reserveEmailCaptchaBudget(tx, "issue", { recipientFingerprint: bindings.recipientFingerprint, browserFingerprint: bindings.browserFingerprint }, now);
    await tx.emailGraphicCaptchaChallenge.create({ data: {
      id, emailFingerprint: bindings.recipientFingerprint, browserFingerprint: bindings.browserFingerprint, purpose: input.purpose,
      actorId: bindings.actorId, actorAccountAccessVersion: bindings.actorAccountAccessVersion,
      actorSecurityRevision: bindings.actorSecurityRevision, actorEmailRevision: bindings.actorEmailRevision,
      answerDigest: emailCaptchaDigest({ id, ...bindings, purpose: input.purpose, answer }, config.key),
      createdAt: now, expiresAt: new Date(now.getTime() + TTL),
    } });
  });
  try { return { challengeId: id, image: `data:image/png;base64,${(await renderer(answer)).toString("base64")}`, expiresInSeconds: 180 }; }
  catch { await db.emailGraphicCaptchaChallenge.deleteMany({ where: { id } }).catch(() => undefined); throw new ApiError(503, "EMAIL_AUTH_UNAVAILABLE", "邮箱验证暂不可用，请稍后重试"); }
}

/** A valid challenge spends one attempt even when the answer or binding is wrong. */
export async function consumeEmailGraphicCaptcha(
  input: CaptchaInput & { captcha: unknown },
  db: PrismaClient = getEntitlementDb(),
): Promise<ConsumedEmailGraphicCaptchaBinding> {
  const parsed = emailGraphicCaptchaProofSchema.safeParse(input.captcha);
  if (!parsed.success || !validCaptchaBrowserToken(input.browserToken)) throw invalidCaptcha();
  const config = await loadEmailAuthConfig();
  const consumedBinding = await db.$transaction<ConsumedEmailGraphicCaptchaBinding | null>(async (tx) => {
    await writer(tx, db);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('email-graphic-captcha-admission-v1',0))`;
    const now = await emailDatabaseClock(tx);
    let snapshot: ActorSnapshot | null = null;
    try { snapshot = await actorSnapshot(tx, input, config, input.email === undefined ? undefined : normalizeEmailAddress(input.email)); }
    catch { /* Commit this CAPTCHA attempt even when its actor binding is stale. */ }
    const email = snapshot?.email ?? (input.email === undefined ? null : (() => { try { return normalizeEmailAddress(input.email); } catch { return null; } })());
    const recipientFingerprint = email ? emailFingerprint(email, config.key) : "0".repeat(64);
    const browserFingerprint = emailBudgetFingerprint("browser", input.browserToken, config.key);
    await reserveEmailCaptchaBudget(tx, "consume", { recipientFingerprint, browserFingerprint }, now);
    const [row] = await tx.$queryRaw<EmailGraphicCaptchaChallenge[]>`SELECT * FROM "EmailGraphicCaptchaChallenge" WHERE "id"=${parsed.data.challengeId}::uuid FOR UPDATE`;
    if (!row || row.consumedAt) return null;
    await tx.emailGraphicCaptchaChallenge.update({ where: { id: row.id }, data: { consumedAt: now } });
    if ((input.purpose !== "register" && !snapshot) || !email) return null;
    const bindings = captchaBindings(input, config, snapshot, email);
    const passed = row.expiresAt > now
      && row.emailFingerprint === bindings.recipientFingerprint
      && row.browserFingerprint === bindings.browserFingerprint
      && row.purpose === input.purpose
      && row.actorId === bindings.actorId
      && row.actorAccountAccessVersion === bindings.actorAccountAccessVersion
      && row.actorSecurityRevision === bindings.actorSecurityRevision
      && row.actorEmailRevision === bindings.actorEmailRevision
      && row.answerDigest === emailCaptchaDigest({ id: row.id, ...bindings, purpose: input.purpose, answer: parsed.data.answer }, config.key);
    if (!passed) return null;
    return Object.freeze({
      purpose: row.purpose as EmailAuthPurpose,
      recipientFingerprint: row.emailFingerprint,
      browserFingerprint: row.browserFingerprint,
      actorId: row.actorId,
      accountAccessVersion: row.actorAccountAccessVersion,
      securityRevision: row.actorSecurityRevision,
      emailRevision: row.actorEmailRevision,
      configFingerprint: config.configFingerprint,
    });
  });
  if (!consumedBinding) throw invalidCaptcha();
  return consumedBinding;
}
