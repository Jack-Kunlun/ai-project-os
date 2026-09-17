import type { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { lockActorAccess } from "@/lib/access-linearization";
import { withSerializableRetry } from "@/lib/prisma-transaction";

export type FirstAdminOnboardingState = "pending" | "completed" | "ineligible";

export type FirstAdminOnboardingActor = Readonly<{
  id: unknown;
  role: unknown;
  accountAccessVersion: unknown;
}>;

export type FirstAdminOnboardingCompletion = Readonly<{
  completedAt: Date;
}>;

export type FirstAdminOnboardingErrorCode =
  | "FIRST_ADMIN_ONBOARDING_INVALID_INPUT"
  | "FIRST_ADMIN_ONBOARDING_FORBIDDEN"
  | "FIRST_ADMIN_ONBOARDING_ACCOUNT_STALE"
  | "FIRST_ADMIN_ONBOARDING_CONFLICT";

export class FirstAdminOnboardingError extends Error {
  constructor(readonly code: FirstAdminOnboardingErrorCode) {
    super(code);
    this.name = "FirstAdminOnboardingError";
  }
}

type FirstAdminOnboardingDb = PrismaClient | Prisma.TransactionClient;

const UUID_SCHEMA = z.string().uuid();

function fail(code: FirstAdminOnboardingErrorCode): never {
  throw new FirstAdminOnboardingError(code);
}

function canonicalUserId(value: unknown): string | null {
  const parsed = UUID_SCHEMA.safeParse(value);
  return parsed.success ? parsed.data.toLowerCase() : null;
}

function canonicalActor(actor: FirstAdminOnboardingActor): Readonly<{ id: string; accountAccessVersion: number }> {
  const id = canonicalUserId(actor.id);
  if (id === null || actor.role !== "admin") return fail("FIRST_ADMIN_ONBOARDING_FORBIDDEN");
  if (
    typeof actor.accountAccessVersion !== "number"
    || !Number.isSafeInteger(actor.accountAccessVersion)
    || actor.accountAccessVersion < 1
  ) return fail("FIRST_ADMIN_ONBOARDING_INVALID_INPUT");
  return Object.freeze({ id, accountAccessVersion: actor.accountAccessVersion });
}

/**
 * Read the durable first-run state without treating a role or session claim as
 * sufficient authorization.  An ineligible actor receives no completion
 * state, which keeps /onboarding from becoming an information oracle.
 */
export async function getFirstAdminOnboardingState(
  userIdInput: unknown,
  db: FirstAdminOnboardingDb = getDb(),
): Promise<FirstAdminOnboardingState> {
  const userId = canonicalUserId(userIdInput);
  if (userId === null) return "ineligible";
  const [user, bootstrap] = await Promise.all([
    db.appUser.findUnique({
      where: { id: userId },
      select: { id: true, role: true, disabledAt: true },
    }),
    db.platformBootstrap.findUnique({
      where: { id: "platform" },
      select: {
        initialAdminUserId: true,
        initialOwnerUserId: true,
        adminOnboardingCompletedAt: true,
      },
    }),
  ]);
  if (
    user === null
    || user.role !== "admin"
    || user.disabledAt !== null
    || bootstrap === null
    || bootstrap.initialAdminUserId !== userId
  ) return "ineligible";
  return bootstrap.initialOwnerUserId === null || bootstrap.adminOnboardingCompletedAt === null
    ? "pending"
    : "completed";
}

/**
 * Read the durable completion record after locking the administrator and the
 * singleton bootstrap row. Owner creation performs the state transition in
 * initializeFirstOwner; this helper only returns an already completed state.
 */
export async function completeFirstAdminOnboarding(
  actorInput: FirstAdminOnboardingActor,
  db: PrismaClient = getDb(),
): Promise<FirstAdminOnboardingCompletion> {
  const actor = canonicalActor(actorInput);
  return withSerializableRetry(db, async (tx) => {
    await lockActorAccess(tx, actor.id);
    await tx.$queryRaw`SELECT "id" FROM "PlatformBootstrap" WHERE "id" = 'platform' FOR UPDATE`;

    const currentUser = await tx.appUser.findUnique({
      where: { id: actor.id },
      select: { id: true, role: true, disabledAt: true, accountAccessVersion: true },
    });
    if (currentUser === null || currentUser.role !== "admin" || currentUser.disabledAt !== null) {
      return fail("FIRST_ADMIN_ONBOARDING_FORBIDDEN");
    }
    if (currentUser.accountAccessVersion !== actor.accountAccessVersion) {
      return fail("FIRST_ADMIN_ONBOARDING_ACCOUNT_STALE");
    }

    const bootstrap = await tx.platformBootstrap.findUnique({
      where: { id: "platform" },
      select: {
        initialAdminUserId: true,
        initialOwnerUserId: true,
        adminOnboardingCompletedAt: true,
      },
    });
    if (bootstrap === null || bootstrap.initialAdminUserId !== actor.id) {
      return fail("FIRST_ADMIN_ONBOARDING_FORBIDDEN");
    }
    if (bootstrap.initialOwnerUserId === null || bootstrap.adminOnboardingCompletedAt === null) {
      return fail("FIRST_ADMIN_ONBOARDING_CONFLICT");
    }
    return Object.freeze({ completedAt: bootstrap.adminOnboardingCompletedAt });
  });
}
