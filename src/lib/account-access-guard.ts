import { type Prisma, type PrismaClient } from "@prisma/client";

export type AccountAccessGuardDb = PrismaClient | Prisma.TransactionClient;
/**
 * Actors coming from an authenticated request carry the account epoch that
 * was current when the request was authenticated.  Keep the property
 * optional at the type boundary so legacy/in-memory callers still compile;
 * `assertAccountAccessForActor` rejects a missing value instead of silently
 * treating it as epoch 1.
 */
export type AccountAccessActor = Readonly<{ id: string; accountAccessVersion?: number }>;

export type AccountAccessGuardErrorCode =
  | "ACCOUNT_NOT_FOUND"
  | "ACCOUNT_DISABLED"
  | "ACCOUNT_ACCESS_STALE";

export class AccountAccessGuardError extends Error {
  constructor(readonly code: AccountAccessGuardErrorCode) {
    super(code);
    this.name = "AccountAccessGuardError";
  }
}

function fail(code: AccountAccessGuardErrorCode): never {
  throw new AccountAccessGuardError(code);
}

export function requireAccountAccessVersion(actor: Readonly<{ accountAccessVersion?: unknown }>): number {
  if (
    typeof actor.accountAccessVersion !== "number"
    || !Number.isSafeInteger(actor.accountAccessVersion)
    || actor.accountAccessVersion < 1
  ) return fail("ACCOUNT_ACCESS_STALE");
  return actor.accountAccessVersion;
}

/**
 * Account access is an epoch fence, not just a nullable disabledAt check.
 * Callers that received a session snapshot must pass that snapshot here so a
 * restore cannot accidentally revive an old request or delegation.
 */
export async function assertAccountAccess(
  db: AccountAccessGuardDb,
  userId: string,
  expectedVersion?: number,
): Promise<Readonly<{ id: string; accountAccessVersion: number }>> {
  const user = await db.appUser.findUnique({
    where: { id: userId },
    select: { id: true, disabledAt: true, accountAccessVersion: true },
  });
  if (user === null) return fail("ACCOUNT_NOT_FOUND");
  if (user.disabledAt !== null) return fail("ACCOUNT_DISABLED");
  if (expectedVersion !== undefined && user.accountAccessVersion !== expectedVersion) return fail("ACCOUNT_ACCESS_STALE");
  return Object.freeze({ id: user.id, accountAccessVersion: user.accountAccessVersion });
}

export async function assertAccountAccessForOwner(
  db: AccountAccessGuardDb,
  userId: string,
  ownerVersion: number,
): Promise<Readonly<{ id: string; accountAccessVersion: number }>> {
  return assertAccountAccess(db, userId, ownerVersion);
}

export async function assertAccountAccessForActor(
  db: AccountAccessGuardDb,
  actor: AccountAccessActor,
): Promise<Readonly<{ id: string; accountAccessVersion: number }>> {
  return assertAccountAccess(db, actor.id, requireAccountAccessVersion(actor));
}
