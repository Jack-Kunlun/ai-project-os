import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { lockActorAccess, lockWorkspaceAccess } from "@/lib/access-linearization";
import { withSerializableRetry } from "@/lib/prisma-transaction";
import { DEFAULT_WORKSPACE_ID } from "@/lib/workspace-constants";

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

async function databaseNow(db: FirstAdminOnboardingDb): Promise<Date> {
  const rows = await db.$queryRaw<Array<{ now?: Date | string }>>(
    Prisma.sql`SELECT (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) AS "now"`,
  );
  const value = rows[0]?.now;
  const now = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  if (now === null || Number.isNaN(now.getTime())) return fail("FIRST_ADMIN_ONBOARDING_CONFLICT");
  return now;
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
  const [user, workspace] = await Promise.all([
    db.appUser.findUnique({
      where: { id: userId },
      select: { id: true, role: true, disabledAt: true },
    }),
    db.workspace.findUnique({
      where: { id: DEFAULT_WORKSPACE_ID },
      select: { createdById: true, initialAdminOnboardingCompletedAt: true },
    }),
  ]);
  if (
    user === null
    || user.role !== "admin"
    || user.disabledAt !== null
    || workspace === null
    || workspace.createdById !== userId
  ) return "ineligible";
  return workspace.initialAdminOnboardingCompletedAt === null ? "pending" : "completed";
}

async function setOnboardingContext(tx: Prisma.TransactionClient, actorId: string): Promise<void> {
  await tx.$executeRaw(Prisma.sql`SELECT set_config('app.first_admin_onboarding_context', '1', true)`);
  await tx.$executeRaw(Prisma.sql`SELECT set_config('app.first_admin_onboarding_actor_id', ${actorId}, true)`);
}

/**
 * Complete the first-admin acknowledgement once.  The actor lock is acquired
 * before the default-workspace lock, matching the account/workspace mutation
 * order used elsewhere in the application.  The row is re-read after both
 * locks so a stale session cannot complete the guide after disable/restore or
 * an access-version change.
 */
export async function completeFirstAdminOnboarding(
  actorInput: FirstAdminOnboardingActor,
  db: PrismaClient = getDb(),
): Promise<FirstAdminOnboardingCompletion> {
  const actor = canonicalActor(actorInput);
  return withSerializableRetry(db, async (tx) => {
    await lockActorAccess(tx, actor.id);
    await lockWorkspaceAccess(tx, DEFAULT_WORKSPACE_ID);

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

    const workspace = await tx.workspace.findUnique({
      where: { id: DEFAULT_WORKSPACE_ID },
      select: { id: true, createdById: true, initialAdminOnboardingCompletedAt: true },
    });
    if (workspace === null || workspace.createdById !== actor.id) return fail("FIRST_ADMIN_ONBOARDING_FORBIDDEN");
    if (workspace.initialAdminOnboardingCompletedAt !== null) {
      return Object.freeze({ completedAt: workspace.initialAdminOnboardingCompletedAt });
    }

    const completedAt = await databaseNow(tx);
    await setOnboardingContext(tx, actor.id);
    const update = await tx.workspace.updateMany({
      where: {
        id: DEFAULT_WORKSPACE_ID,
        createdById: actor.id,
        initialAdminOnboardingCompletedAt: null,
      },
      data: { initialAdminOnboardingCompletedAt: completedAt },
    });
    if (update.count !== 1) {
      const current = await tx.workspace.findUnique({
        where: { id: DEFAULT_WORKSPACE_ID },
        select: { initialAdminOnboardingCompletedAt: true },
      });
      if (current?.initialAdminOnboardingCompletedAt !== null && current?.initialAdminOnboardingCompletedAt !== undefined) {
        return Object.freeze({ completedAt: current.initialAdminOnboardingCompletedAt });
      }
      return fail("FIRST_ADMIN_ONBOARDING_CONFLICT");
    }
    return Object.freeze({ completedAt });
  });
}
