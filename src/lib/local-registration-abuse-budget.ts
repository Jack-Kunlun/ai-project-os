import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { ApiError } from "@/lib/api-errors";
import { assertEntitlementWriterSession, isEntitlementDatabase } from "@/lib/db";
import { isLocalRegistrationEnabled, requireLocalRegistrationEnabled } from "@/lib/local-registration-config";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const USERNAME_HOURLY_LIMIT = 5;
const GLOBAL_HOURLY_LIMIT = 50;
const GLOBAL_DAILY_LIMIT = 200;
const GLOBAL_HOUR_FINGERPRINT = "0".repeat(64);
const GLOBAL_DAY_FINGERPRINT = "1".repeat(64);
const GLOBAL_ADMISSION_LOCK_KEY = "ai-project-os-local-registration-admission-v1";

export function localRegistrationUsernameFingerprint(normalizedUsername: string): string {
  return createHash("sha256")
    .update(`ai-project-os:local-registration:username:v1:${normalizedUsername}`, "utf8")
    .digest("hex");
}

function rateLimitError(): ApiError {
  return new ApiError(429, "LOCAL_REGISTRATION_RATE_LIMITED", "注册尝试过于频繁，请稍后再试");
}

async function reserveBucket(
  tx: Prisma.TransactionClient,
  input: Readonly<{
    scope: "username_hour" | "global_hour" | "global_day";
    keyFingerprint: string;
    durationMs: number;
    limit: number;
    now: Date;
  }>,
): Promise<void> {
  const where = {
    scope_keyFingerprint: {
      scope: input.scope,
      keyFingerprint: input.keyFingerprint,
    },
  };
  const existing = await tx.localRegistrationBudget.findUnique({ where });

  if (existing === null) {
    await tx.localRegistrationBudget.create({
      data: {
        scope: input.scope,
        keyFingerprint: input.keyFingerprint,
        windowStartedAt: input.now,
        attemptCount: 1,
        updatedAt: input.now,
      },
    });
    return;
  }

  if (existing.windowStartedAt.getTime() + input.durationMs <= input.now.getTime()) {
    await tx.localRegistrationBudget.update({
      where,
      data: { windowStartedAt: input.now, attemptCount: 1, updatedAt: input.now },
    });
    return;
  }

  if (existing.attemptCount >= input.limit) throw rateLimitError();
  await tx.localRegistrationBudget.update({
    where,
    data: { attemptCount: { increment: 1 }, updatedAt: input.now },
  });
}

/**
 * Atomically claim a username and deployment-wide admission budget before
 * password hashing or account creation. A single transaction-level global
 * advisory lock serializes reservations across app replicas, so global limits
 * cannot be exceeded by concurrent requests. Only a domain-separated hash of
 * the normalized username is persisted; proxy headers are intentionally unused.
 */
export async function reserveLocalRegistrationAttempt(normalizedUsername: string, db: PrismaClient): Promise<void> {
  requireLocalRegistrationEnabled();
  const usernameFingerprint = localRegistrationUsernameFingerprint(normalizedUsername);

  try {
    await db.$transaction(async (tx) => {
      if (isEntitlementDatabase(db)) await assertEntitlementWriterSession(tx);

      // Acquire the deployment-wide lock before reading or changing any bucket.
      // All callers follow the same order and therefore cannot deadlock on
      // cross-bucket contention.
      await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${GLOBAL_ADMISSION_LOCK_KEY}, 0))`);
      const [clock] = await tx.$queryRaw<Array<{ now: Date }>>(Prisma.sql`SELECT clock_timestamp() AS "now"`);
      if (clock === undefined || !(clock.now instanceof Date) || !Number.isFinite(clock.now.getTime())) {
        throw new Error("LOCAL_REGISTRATION_DATABASE_CLOCK_UNAVAILABLE");
      }

      // There can be at most 200 fresh usernames per 24-hour budget window.
      // Remove stale fingerprints opportunistically so the table stays bounded.
      await tx.localRegistrationBudget.deleteMany({
        where: {
          scope: "username_hour",
          windowStartedAt: { lt: new Date(clock.now.getTime() - DAY_MS) },
        },
      });

      await reserveBucket(tx, {
        scope: "username_hour",
        keyFingerprint: usernameFingerprint,
        durationMs: HOUR_MS,
        limit: USERNAME_HOURLY_LIMIT,
        now: clock.now,
      });
      await reserveBucket(tx, {
        scope: "global_hour",
        keyFingerprint: GLOBAL_HOUR_FINGERPRINT,
        durationMs: HOUR_MS,
        limit: GLOBAL_HOURLY_LIMIT,
        now: clock.now,
      });
      await reserveBucket(tx, {
        scope: "global_day",
        keyFingerprint: GLOBAL_DAY_FINGERPRINT,
        durationMs: DAY_MS,
        limit: GLOBAL_DAILY_LIMIT,
        now: clock.now,
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    // Any database/configuration failure means the admission budget was not
    // proven and must not allow the caller to continue with account creation.
    throw new ApiError(503, "LOCAL_REGISTRATION_BUDGET_UNAVAILABLE", "本地注册暂不可用，请稍后重试");
  }
}

export { isLocalRegistrationEnabled };
