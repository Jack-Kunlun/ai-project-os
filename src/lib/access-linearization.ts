import { Prisma, type AppUserRole, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { type ProjectPermission } from "@/lib/access-control";
import {
  findConfirmedProjectMembership,
  findConfirmedWorkspaceMembership,
} from "@/lib/membership-governance";

/**
 * Authorization changes and resource dispatches share these transaction
 * scoped advisory-lock namespaces.  The actor namespace intentionally uses
 * the same value as the existing entitlement membership lock so membership
 * grant/revoke and account disable operations can participate in the same
 * fence without taking a lock across an external call.
 */
export const ACCESS_ACTOR_LOCK_NAMESPACE = 29082027;
export const ACCESS_WORKSPACE_LOCK_NAMESPACE = 29082028;
export const ACCESS_PROJECT_LOCK_NAMESPACE = 29082029;
export const ACCESS_INVITATION_LOCK_NAMESPACE = 29082030;

const UUID_SCHEMA = z.string().uuid();
const ACTOR_ROLE_SCHEMA = z.enum(["admin", "member", "user"]);

export type AccessLinearizationDb = Prisma.TransactionClient;
export type WebAiActor = Readonly<{ id: string; role: AppUserRole; accountAccessVersion?: number }>;
export type CurrentWebAiActor = Readonly<{ id: string; role: AppUserRole; accountAccessVersion: number }>;
export type AccessLinearizationClient = PrismaClient | Prisma.TransactionClient;

export type WebAiAccessErrorCode = "ACCESS_FORBIDDEN" | "ACCOUNT_DISABLED" | "ACCOUNT_ACCESS_STALE";

/**
 * This error is shared by the ordinary service guard and the transactional
 * admission guard.  Keeping one runtime class means API error mapping stays
 * stable when a request loses access at the database admission point.
 */
export class WebAiAccessError extends Error {
  constructor(readonly code: WebAiAccessErrorCode) {
    super(code);
    this.name = "WebAiAccessError";
  }
}

export type ProjectAccessAdmission = Readonly<{
  actor: CurrentWebAiActor;
  workspace: Readonly<{ id: string }>;
  project: Readonly<{ id: string; workspaceId: string; archivedAt: Date | null }>;
  permission: ProjectPermission;
}>;

const permissionRank: Record<ProjectPermission, number> = { view: 1, edit: 2, owner: 3 };

function fail(code: WebAiAccessErrorCode): never {
  throw new WebAiAccessError(code);
}

function canonicalUuid(value: unknown): string | null {
  const parsed = UUID_SCHEMA.safeParse(value);
  return parsed.success ? parsed.data.toLowerCase() : null;
}

function requireUuid(value: unknown): string {
  const parsed = canonicalUuid(value);
  if (parsed === null) return fail("ACCESS_FORBIDDEN");
  return parsed;
}

function assertActorShape(actor: unknown): asserts actor is WebAiActor {
  if (typeof actor !== "object" || actor === null) return fail("ACCESS_FORBIDDEN");
  const candidate = actor as { id?: unknown; role?: unknown; accountAccessVersion?: unknown };
  if (canonicalUuid(candidate.id) === null || !ACTOR_ROLE_SCHEMA.safeParse(candidate.role).success) {
    return fail("ACCESS_FORBIDDEN");
  }
  if (
    typeof candidate.accountAccessVersion !== "number"
    || !Number.isSafeInteger(candidate.accountAccessVersion)
    || candidate.accountAccessVersion < 1
  ) return fail("ACCOUNT_ACCESS_STALE");
}

async function advisoryLock(db: AccessLinearizationDb, key: string, namespace: number): Promise<void> {
  await db.$executeRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${key}::text, ${namespace}))
  `);
}

/** Lock one or more AppUser rows in deterministic order. */
export async function lockActorAccess(db: AccessLinearizationDb, actorId: unknown): Promise<string> {
  const id = requireUuid(actorId);
  await advisoryLock(db, id, ACCESS_ACTOR_LOCK_NAMESPACE);
  return id;
}

/** Alias for future AppUser.disabledAt mutations. */
export async function lockAppUserAccess(db: AccessLinearizationDb, userId: unknown): Promise<string> {
  return lockActorAccess(db, userId);
}

/**
 * Lock all actor rows needed by a mutation.  Sorting and de-duplicating is
 * required because workspace-member edits can target the acting user itself;
 * it also prevents deadlocks when two requests involve the same pair in the
 * opposite order.
 */
export async function lockActorsAccess(db: AccessLinearizationDb, actorIds: readonly unknown[]): Promise<readonly string[]> {
  const ids = [...new Set(actorIds.map((value) => requireUuid(value)))].sort();
  for (const id of ids) await advisoryLock(db, id, ACCESS_ACTOR_LOCK_NAMESPACE);
  return ids;
}

export async function lockWorkspaceAccess(db: AccessLinearizationDb, workspaceId: unknown): Promise<string> {
  const id = requireUuid(workspaceId);
  await advisoryLock(db, id, ACCESS_WORKSPACE_LOCK_NAMESPACE);
  return id;
}

export async function lockProjectAccess(db: AccessLinearizationDb, projectId: unknown): Promise<string> {
  const id = requireUuid(projectId);
  await advisoryLock(db, id, ACCESS_PROJECT_LOCK_NAMESPACE);
  return id;
}

export async function lockWorkspaceInvitationAccess(db: AccessLinearizationDb, invitationId: unknown): Promise<string> {
  const id = requireUuid(invitationId);
  await advisoryLock(db, id, ACCESS_INVITATION_LOCK_NAMESPACE);
  return id;
}

/**
 * Take the common actor -> workspace -> project lock sequence.  The project
 * lookup intentionally returns only stable routing identifiers before locks
 * are acquired.  Callers must use the returned admission tuple, not that
 * pre-lock row, for authorization or sensitive data.
 */
export async function lockActorWorkspaceProjectAccess(
  db: AccessLinearizationDb,
  input: Readonly<{ actorIds: readonly unknown[]; workspaceId: unknown; projectId: unknown }>,
): Promise<Readonly<{ actorIds: readonly string[]; workspaceId: string; projectId: string }>> {
  const actorIds = await lockActorsAccess(db, input.actorIds);
  const workspaceId = await lockWorkspaceAccess(db, input.workspaceId);
  const projectId = await lockProjectAccess(db, input.projectId);
  return Object.freeze({ actorIds, workspaceId, projectId });
}

function projectPermission(
  workspaceRole: "owner" | "admin" | "member" | "viewer" | null,
  projectRole: "owner" | "editor" | "viewer" | null,
): ProjectPermission | null {
  if (workspaceRole === "owner" || workspaceRole === "admin" || projectRole === "owner") return "owner";
  if (projectRole === "editor") return "edit";
  if (projectRole === "viewer") return "view";
  return null;
}

type LockedActorRow = Readonly<{
  id: string;
  role: string;
  disabledAt: Date | null;
  accountAccessVersion: number;
}>;

type LockedProjectRow = Readonly<{
  id: string;
  workspaceId: string;
  archivedAt: Date | null;
  // Raw PostgreSQL enum values use the @map value (workspace_inherited or
  // project_only), while Prisma's client enum uses the camel-case name.
  membershipInheritanceMode: string;
}>;

type LockedMembershipRow = Readonly<{ role: string }>;

type AuthoritativeAccessRows = Readonly<{
  actor: LockedActorRow | null;
  project: LockedProjectRow | null;
  workspaceMembership: LockedMembershipRow | null;
  projectMembership: LockedMembershipRow | null;
}>;

function oneLockedRow<T>(rows: readonly T[]): T | null {
  // The partial unique indexes should make this impossible.  Treat any
  // unexpected duplicate as a closed authorization failure instead of
  // selecting an arbitrary row.
  if (rows.length > 1) return null;
  return rows[0] ?? null;
}

function normalizedWorkspaceRole(value: unknown): "owner" | "admin" | "member" | "viewer" | null {
  return value === "owner" || value === "admin" || value === "member" || value === "viewer" ? value : null;
}

function normalizedProjectRole(value: unknown): "owner" | "editor" | "viewer" | null {
  return value === "owner" || value === "editor" || value === "viewer" ? value : null;
}

function normalizedInheritanceMode(value: unknown): "workspaceInherited" | "projectOnly" | null {
  if (value === "workspaceInherited" || value === "workspace_inherited") return "workspaceInherited";
  if (value === "projectOnly" || value === "project_only") return "projectOnly";
  return null;
}

/**
 * Reload authorization rows after the advisory fence and take a PostgreSQL
 * row share lock on every row used as permission evidence.  This is kept as
 * raw SQL because Prisma's findUnique/findMany calls cannot express FOR SHARE.
 * The ORM branch exists only for the small in-memory doubles used by the
 * contract tests; real Prisma clients always expose $queryRaw.
 */
async function loadAuthoritativeAccessRows(
  db: AccessLinearizationDb,
  input: Readonly<{ actorId: string; workspaceId: string; projectId: string }>,
): Promise<AuthoritativeAccessRows> {
  const queryRaw = (db as unknown as {
    $queryRaw?: <T>(query: Prisma.Sql) => Promise<readonly T[]>;
  }).$queryRaw;
  if (typeof queryRaw !== "function") {
    const [actor, project, workspaceMembership, projectMembership] = await Promise.all([
      db.appUser.findUnique({ where: { id: input.actorId }, select: { id: true, role: true, disabledAt: true, accountAccessVersion: true } }),
      db.project.findUnique({ where: { id: input.projectId }, select: { id: true, workspaceId: true, archivedAt: true, membershipInheritanceMode: true } }),
      findConfirmedWorkspaceMembership(db, input.workspaceId, input.actorId),
      findConfirmedProjectMembership(db, input.projectId, input.actorId),
    ]);
    return { actor, project, workspaceMembership, projectMembership };
  }

  const runQuery = <T>(query: Prisma.Sql) => queryRaw.call(db, query) as Promise<readonly T[]>;
  const actorRows = await runQuery<LockedActorRow>(Prisma.sql`
    SELECT "id", "role", "disabledAt", "accountAccessVersion"
      FROM "AppUser"
     WHERE "id" = ${input.actorId}::uuid
     FOR SHARE
  `);
  const projectRows = await runQuery<LockedProjectRow>(Prisma.sql`
    SELECT "id", "workspaceId", "archivedAt", "membershipInheritanceMode"::text AS "membershipInheritanceMode"
      FROM "Project"
     WHERE "id" = ${input.projectId}::uuid
     FOR SHARE
  `);
  const workspaceMembershipRows = await runQuery<LockedMembershipRow>(Prisma.sql`
    SELECT "role"
      FROM "WorkspaceMembership"
     WHERE "workspaceId" = ${input.workspaceId}::uuid
       AND "userId" = ${input.actorId}::uuid
       AND "accessState" = 'confirmed'::"MembershipAccessState"
     ORDER BY "createdAt" ASC, "id" ASC
     LIMIT 2
     FOR SHARE
  `);
  const projectMembershipRows = await runQuery<LockedMembershipRow>(Prisma.sql`
    SELECT "role"
      FROM "ProjectMembership"
     WHERE "projectId" = ${input.projectId}::uuid
       AND "userId" = ${input.actorId}::uuid
       AND "accessState" = 'confirmed'::"MembershipAccessState"
     ORDER BY "createdAt" ASC, "id" ASC
     LIMIT 2
     FOR SHARE
  `);
  return {
    actor: actorRows[0] ?? null,
    project: projectRows[0] ?? null,
    workspaceMembership: oneLockedRow(workspaceMembershipRows),
    projectMembership: oneLockedRow(projectMembershipRows),
  };
}

/**
 * Authoritative project admission for a transaction that is about to record a
 * dispatch marker or other durable operation.  It never performs external
 * work and never returns project existence to an actor without permission.
 *
 * The initial project lookup is deliberately metadata-minimal and exists only
 * to discover the workspace lock key.  The actor, membership and project are
 * all reloaded after the fixed lock sequence.
 */
export async function admitWebAiProjectAccess(
  db: AccessLinearizationDb,
  input: Readonly<{
    actor: WebAiActor;
    projectId: unknown;
    required: ProjectPermission;
    allowArchived?: boolean;
    additionalActorIds?: readonly unknown[];
  }>,
): Promise<ProjectAccessAdmission> {
  assertActorShape(input.actor);
  const actorId = requireUuid(input.actor.id);
  const projectId = requireUuid(input.projectId);
  if (!(input.required in permissionRank)) return fail("ACCESS_FORBIDDEN");

  const located = await db.project.findUnique({ where: { id: projectId }, select: { id: true, workspaceId: true } });
  if (located === null) return fail("ACCESS_FORBIDDEN");
  const workspaceId = requireUuid(located.workspaceId);
  await lockActorsAccess(db, [actorId, ...(input.additionalActorIds ?? [])]);
  await lockWorkspaceAccess(db, workspaceId);
  await lockProjectAccess(db, projectId);

  const { actor: currentActor, project, workspaceMembership, projectMembership } = await loadAuthoritativeAccessRows(db, {
    actorId,
    workspaceId,
    projectId,
  });
  if (currentActor === null || project === null || project.workspaceId !== workspaceId) return fail("ACCESS_FORBIDDEN");
  if (currentActor.disabledAt !== null) return fail("ACCOUNT_DISABLED");
  if (currentActor.accountAccessVersion !== input.actor.accountAccessVersion) return fail("ACCOUNT_ACCESS_STALE");

  const currentRole = currentActor.role === "admin" || currentActor.role === "user" ? currentActor.role : null;
  if (currentRole === null) return fail("ACCESS_FORBIDDEN");
  const inheritanceMode = normalizedInheritanceMode(project.membershipInheritanceMode);
  if (inheritanceMode === null) return fail("ACCESS_FORBIDDEN");

  const workspaceRole = normalizedWorkspaceRole(workspaceMembership?.role) ?? null;
  const projectRole = normalizedProjectRole(projectMembership?.role) ?? null;
  // `projectOnly` is a legacy compatibility mode: no workspace membership,
  // including Owner/Admin, can substitute for a confirmed project grant.
  // `workspaceInherited` is the explicit opt-in for workspace role access.
  const inheritedWorkspaceRole = inheritanceMode === "workspaceInherited"
    ? workspaceRole
    : null;
  const permission = projectPermission(inheritedWorkspaceRole, projectRole);
  if (permission === null || permissionRank[permission] < permissionRank[input.required]) return fail("ACCESS_FORBIDDEN");
  // Archived projects are not dispatchable.  Lifecycle restore/delete are
  // explicit callers and must opt in so a future worker cannot accidentally
  // reuse the admission helper as an archived-project bypass.
  if (!input.allowArchived && project.archivedAt !== null) return fail("ACCESS_FORBIDDEN");
  return Object.freeze({
    actor: Object.freeze({ id: currentActor.id, role: currentRole, accountAccessVersion: currentActor.accountAccessVersion }),
    workspace: Object.freeze({ id: workspaceId }),
    project: Object.freeze({ id: project.id, workspaceId: project.workspaceId, archivedAt: project.archivedAt }),
    permission,
  });
}

/**
 * Run a database-only operation behind the canonical actor -> workspace ->
 * project access fence.  The callback receives a transaction client and must
 * not perform network, credential, blob, or other external I/O.  A caller
 * that is already inside a transaction can reuse the same helper; the access
 * locks are still acquired and no nested transaction is created.
 */
export async function withWebAiProjectAccessTransaction<T>(
  db: AccessLinearizationClient,
  input: Readonly<{
    actor: WebAiActor;
    projectId: unknown;
    required: ProjectPermission;
    allowArchived?: boolean;
    additionalActorIds?: readonly unknown[];
    isolationLevel?: Prisma.TransactionIsolationLevel;
  }>,
  callback: (tx: Prisma.TransactionClient, admission: ProjectAccessAdmission) => Promise<T>,
): Promise<T> {
  // Reject malformed request identities before opening a database transaction.
  // This is input validation only; the authoritative role, disabled state,
  // memberships, and project lifecycle are still reloaded after the locks.
  assertActorShape(input.actor);
  requireUuid(input.projectId);
  const run = (tx: Prisma.TransactionClient) => admitWebAiProjectAccess(tx, input)
    .then((admission) => callback(tx, admission));
  if (typeof (db as { $transaction?: unknown }).$transaction !== "function") {
    return run(db as Prisma.TransactionClient);
  }
  return (db as PrismaClient).$transaction(run, {
    isolationLevel: input.isolationLevel ?? Prisma.TransactionIsolationLevel.ReadCommitted,
  });
}
