import type { Prisma } from "@prisma/client";
import { ApiError } from "@/lib/api-errors";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ZERO_FINGERPRINT = "0".repeat(64);
type Tx = Prisma.TransactionClient;

function rateLimited(): ApiError {
  return new ApiError(429, "EMAIL_AUTH_RATE_LIMITED", "操作过于频繁，请稍后再试");
}

export async function lockEmailAuthAdmission(tx: Tx): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('email-auth-admission-v1',0))`;
}

export async function emailDatabaseClock(tx: Tx): Promise<Date> {
  const [row] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`;
  if (!(row?.now instanceof Date) || !Number.isFinite(row.now.getTime())) {
    throw new ApiError(503, "EMAIL_AUTH_UNAVAILABLE", "邮箱验证暂不可用，请稍后重试");
  }
  return row.now;
}

async function updateBudget(
  table: "emailAuthBudget" | "emailGraphicCaptchaBudget",
  tx: Tx,
  scope: string,
  keyFingerprint: string,
  duration: number,
  limit: number,
  now: Date,
): Promise<void> {
  const where = { scope_keyFingerprint: { scope, keyFingerprint } };
  const old = table === "emailAuthBudget"
    ? await tx.emailAuthBudget.findUnique({ where })
    : await tx.emailGraphicCaptchaBudget.findUnique({ where });
  const expired = !old || old.windowStartedAt.getTime() + duration <= now.getTime();
  if (!expired && old.attemptCount >= limit) throw rateLimited();
  const data = expired
    ? { windowStartedAt: now, attemptCount: 1, updatedAt: now }
    : { attemptCount: { increment: 1 }, updatedAt: now };
  if (table === "emailAuthBudget") {
    await tx.emailAuthBudget.upsert({ where, create: { scope, keyFingerprint, windowStartedAt: now, attemptCount: 1, updatedAt: now }, update: data });
  } else {
    await tx.emailGraphicCaptchaBudget.upsert({ where, create: { scope, keyFingerprint, windowStartedAt: now, attemptCount: 1, updatedAt: now }, update: data });
  }
}

/** Caller holds the global email admission lock and uses the database clock. */
export async function reserveEmailSendBudget(
  tx: Tx,
  input: { recipientFingerprint: string; browserFingerprint: string; actorFingerprint: string | null },
  now: Date,
): Promise<void> {
  const recent = await tx.emailAuthChallenge.findFirst({
    where: { emailFingerprint: input.recipientFingerprint, createdAt: { gt: new Date(now.getTime() - MINUTE) } },
    select: { id: true },
  });
  if (recent) throw rateLimited();
  await updateBudget("emailAuthBudget", tx, "send_email_hour", input.recipientFingerprint, HOUR, 5, now);
  await updateBudget("emailAuthBudget", tx, "send_email_day", input.recipientFingerprint, DAY, 10, now);
  await updateBudget("emailAuthBudget", tx, "send_browser_hour", input.browserFingerprint, HOUR, 30, now);
  await updateBudget("emailAuthBudget", tx, "send_global_hour", ZERO_FINGERPRINT, HOUR, 50, now);
  await updateBudget("emailAuthBudget", tx, "send_global_day", ZERO_FINGERPRINT, DAY, 200, now);
  if (input.actorFingerprint) {
    await updateBudget("emailAuthBudget", tx, "send_actor_hour", input.actorFingerprint, HOUR, 10, now);
  }
}

/** Caller holds the global email admission lock and uses the database clock. */
export async function reserveEmailVerifyBudget(
  tx: Tx,
  input: { recipientFingerprint: string; browserFingerprint: string; actorFingerprint: string | null },
  now: Date,
): Promise<void> {
  await updateBudget("emailAuthBudget", tx, "verify_email_hour", input.recipientFingerprint, HOUR, 30, now);
  await updateBudget("emailAuthBudget", tx, "verify_browser_hour", input.browserFingerprint, HOUR, 60, now);
  await updateBudget("emailAuthBudget", tx, "verify_global_hour", ZERO_FINGERPRINT, HOUR, 500, now);
  if (input.actorFingerprint) {
    await updateBudget("emailAuthBudget", tx, "verify_actor_hour", input.actorFingerprint, HOUR, 20, now);
  }
}

/** Caller holds the email CAPTCHA admission lock and uses the database clock. */
export async function reserveEmailCaptchaBudget(
  tx: Tx,
  operation: "issue" | "consume",
  input: { recipientFingerprint: string; browserFingerprint: string },
  now: Date,
): Promise<void> {
  const window = 10 * MINUTE;
  await updateBudget("emailGraphicCaptchaBudget", tx, `${operation}_browser`, input.browserFingerprint, window, 40, now);
  await updateBudget("emailGraphicCaptchaBudget", tx, `${operation}_email`, input.recipientFingerprint, window, 20, now);
  await updateBudget("emailGraphicCaptchaBudget", tx, `${operation}_global`, ZERO_FINGERPRINT, window, 1_000, now);
}
