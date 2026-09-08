import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { assertProjectAccess, type ProjectPermission } from "@/lib/access-control";
import { AccountAccessGuardError, assertAccountAccessForActor } from "@/lib/account-access-guard";
import { WebAiAccessError, type WebAiAccessErrorCode, type CurrentWebAiActor, type WebAiActor } from "@/lib/access-linearization";
import { getDb } from "@/lib/db";
import { assertProjectActive } from "@/lib/project-lifecycle";

export { WebAiAccessError, type CurrentWebAiActor, type WebAiAccessErrorCode, type WebAiActor } from "@/lib/access-linearization";

const actorIdSchema = z.string().uuid();
const actorRoleSchema = z.enum(["admin", "member", "user"]);
const projectIdSchema = z.string().uuid();

function accessError(code: WebAiAccessErrorCode): never {
  throw new WebAiAccessError(code);
}

function mapAccountAccessError(error: unknown): never {
  if (error instanceof AccountAccessGuardError) {
    if (error.code === "ACCOUNT_DISABLED") return accessError("ACCOUNT_DISABLED");
    if (error.code === "ACCOUNT_ACCESS_STALE") return accessError("ACCOUNT_ACCESS_STALE");
  }
  return accessError("ACCESS_FORBIDDEN");
}

function validateActorShape(actor: unknown): asserts actor is WebAiActor {
  if (
    typeof actor !== "object" ||
    actor === null ||
    !actorIdSchema.safeParse((actor as { id?: unknown }).id).success ||
    !actorRoleSchema.safeParse((actor as { role?: unknown }).role).success
  ) {
    return accessError("ACCESS_FORBIDDEN");
  }
  const accountAccessVersion = (actor as { accountAccessVersion?: unknown }).accountAccessVersion;
  if (
    typeof accountAccessVersion !== "number"
    || !Number.isSafeInteger(accountAccessVersion)
    || accountAccessVersion < 1
  ) return accessError("ACCOUNT_ACCESS_STALE");
}

/**
 * Resolve the actor from the database before any project data is read. The
 * role on a session/request object is only a shape check; authorization uses
 * this current row so a stale or forged role cannot grant access.
 */
export async function loadCurrentWebAiActor(actor: WebAiActor, db: PrismaClient = getDb()): Promise<CurrentWebAiActor> {
  validateActorShape(actor);
  try {
    await assertAccountAccessForActor(db, actor);
  } catch (error) {
    return mapAccountAccessError(error);
  }
  const current = await db.appUser.findUnique({
    where: { id: actor.id },
    select: { id: true, role: true, accountAccessVersion: true },
  });
  if (current === null) return accessError("ACCESS_FORBIDDEN");
  return Object.freeze({ id: current.id, role: current.role, accountAccessVersion: current.accountAccessVersion });
}

/**
 * Service-layer project authorization. Reads require view; writes and model
 * work require edit. The active-project check is intentionally after RBAC so
 * an inaccessible project is not disclosed through its lifecycle state.
 */
export async function assertWebAiProjectAccess(
  actor: WebAiActor,
  projectId: string,
  required: ProjectPermission,
  db: PrismaClient,
): Promise<CurrentWebAiActor> {
  if (!projectIdSchema.safeParse(projectId).success) return accessError("ACCESS_FORBIDDEN");
  const current = await loadCurrentWebAiActor(actor, db);
  try {
    await assertProjectAccess(current, projectId, required, db);
  } catch (error) {
    if (error instanceof Error && "code" in error && (
      (error as { code?: unknown }).code === "ACCESS_FORBIDDEN" ||
      (error as { code?: unknown }).code === "ACCESS_PROJECT_NOT_FOUND" ||
      (error as { code?: unknown }).code === "ACCESS_WORKSPACE_NOT_FOUND"
    )) return accessError("ACCESS_FORBIDDEN");
    throw error;
  }
  if (required !== "view") await assertProjectActive(projectId, db);
  return current;
}
