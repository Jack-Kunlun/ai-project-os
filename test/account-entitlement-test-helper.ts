import type { Prisma, PrismaClient } from "@prisma/client";
import { activateAccountEntitlements } from "../src/lib/account-entitlement-activation-service";

type TestEntitlementDb = PrismaClient | Prisma.TransactionClient;

export async function activateCanonicalSignupGrant(
  db: TestEntitlementDb,
  input: Readonly<{
    userId: string;
    actorId: string;
    source?: "githubRegistration" | "oidcRegistration" | "oidcInvitationRegistration" | "localProvisioning";
    now?: Date;
  }>,
) {
  const [user, actor] = await Promise.all([
    db.appUser.findUnique({ where: { id: input.userId }, select: { id: true, accountAccessVersion: true } }),
    db.appUser.findUnique({ where: { id: input.actorId }, select: { id: true, accountAccessVersion: true } }),
  ]);
  if (user === null || actor === null) throw new Error("TEST_ACCOUNT_ENTITLEMENT_USER_NOT_FOUND");
  const activation = await activateAccountEntitlements({
    userId: user.id,
    source: input.source ?? "githubRegistration",
    actorId: actor.id,
    actorAccountAccessVersion: actor.accountAccessVersion,
    accountAccessVersion: user.accountAccessVersion,
    evidenceKind: "test-registration",
    evidenceRef: `test:${user.id}`,
    now: input.now,
  }, db);
  if (activation.grantId === null) throw new Error("TEST_ACCOUNT_ENTITLEMENT_GRANT_UNAVAILABLE");
  return db.platformTokenGrant.findUniqueOrThrow({ where: { id: activation.grantId } });
}
