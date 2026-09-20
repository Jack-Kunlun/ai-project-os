import { Prisma, type AppUserRole, type PrismaClient, type ProjectMembershipRole, type WorkspaceMembershipRole } from "@prisma/client";
import { z } from "zod";
import { AccountAccessGuardError, assertAccountAccessForActor } from "@/lib/account-access-guard";
import { getDb } from "@/lib/db";
import { findConfirmedProjectMembership, findConfirmedWorkspaceMembership } from "@/lib/membership-governance";

const PROJECT_ID_SCHEMA = z.string().uuid();
const PROJECT_PATH_PATTERN = /^\/api\/projects\/([^/]+)(?:\/|$)/u;
const PLATFORM_API_PREFIXES = ["/api/admin", "/api/system", "/api/settings"] as const;
const DEPRECATED_PLATFORM_API_PREFIXES = ["/api/settings/git-connections"] as const;
const ORDINARY_USER_API_PREFIXES = [
  "/api/dashboard",
  "/api/projects",
  "/api/workspaces",
  "/api/workspace-invitations",
  "/api/me",
  "/api/notifications",
  "/api/profile",
] as const;
const SHARED_API_PREFIXES = ["/api/auth"] as const;
const PUBLIC_API_PREFIXES = ["/api/health", "/api/setup"] as const;
// Keep the narrow terminal bypass limited to Zod UUIDs with a non-NIL value:
// versions 1-8 and RFC 4122 variant 8/9/a/b, for both dynamic path segments.
const UUID_PATH_SEGMENT = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}";
const GIT_DELEGATION_TERMINAL_PATH_PATTERN = new RegExp(`^/api/projects/${UUID_PATH_SEGMENT}/git-repository-delegations/${UUID_PATH_SEGMENT}/(?:rejection|revocation)/?$`, "u");
const MCP_DELEGATION_TERMINAL_PATH_PATTERN = new RegExp(`^/api/projects/${UUID_PATH_SEGMENT}/mcp-connection-delegations/${UUID_PATH_SEGMENT}/(?:rejection|revocation)/?$`, "u");

function canonicalProjectId(projectId: string): string {
  return PROJECT_ID_SCHEMA.safeParse(projectId).success ? projectId.toLowerCase() : projectId;
}

function decodedApiPath(request: Request): string {
  const rawPath = new URL(request.url).pathname;
  try {
    // Next.js decodes dynamic route parameters before route handlers receive
    // them. Authorization must inspect that same representation exactly once,
    // otherwise percent-encoded project paths can bypass the global RBAC gate.
    return decodeURIComponent(rawPath);
  } catch {
    // A malformed escape cannot be a valid Next.js project route. Keep the raw
    // path so it cannot accidentally become a different authorized resource.
    return rawPath;
  }
}

export type AccessControlErrorCode =
  | "ACCESS_FORBIDDEN"
  | "ACCESS_PROJECT_NOT_FOUND"
  | "ACCESS_WORKSPACE_NOT_FOUND"
  | "ACCESS_LAST_OWNER_REQUIRED"
  | "ACCOUNT_DISABLED"
  | "ACCOUNT_ACCESS_STALE";

export class AccessControlError extends Error {
  constructor(readonly code: AccessControlErrorCode) {
    super(code);
    this.name = "AccessControlError";
  }
}

export type AccessUser = Readonly<{ id: string; role: AppUserRole; accountAccessVersion?: number }>;
export type ProjectPermission = "owner" | "edit" | "view";

export type ApiNamespace = "platform" | "ordinary-user" | "shared" | "public" | "deprecated" | "unknown";

function pathMatchesPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function normalizeApiPath(path: string): string {
  if (path.length <= 1) return path;
  return path.replace(/\/+$/u, "");
}

/**
 * Classify API paths before resource-level RBAC.  Platform routes are kept
 * separate from the ordinary user domain so a valid session cannot cross the
 * product boundary merely by calling a different URL.
 */
export function classifyApiPath(path: string): ApiNamespace {
  const normalized = normalizeApiPath(path);
  if (DEPRECATED_PLATFORM_API_PREFIXES.some((prefix) => pathMatchesPrefix(normalized, prefix))) return "deprecated";
  if (PLATFORM_API_PREFIXES.some((prefix) => pathMatchesPrefix(normalized, prefix))) return "platform";
  if (ORDINARY_USER_API_PREFIXES.some((prefix) => pathMatchesPrefix(normalized, prefix))) return "ordinary-user";
  if (SHARED_API_PREFIXES.some((prefix) => pathMatchesPrefix(normalized, prefix))) return "shared";
  if (PUBLIC_API_PREFIXES.some((prefix) => pathMatchesPrefix(normalized, prefix))) return "public";
  return "unknown";
}

function fail(code: AccessControlErrorCode): never {
  throw new AccessControlError(code);
}

async function assertCurrentAccountAccess(user: AccessUser, db: PrismaClient | Prisma.TransactionClient): Promise<void> {
  try {
    await assertAccountAccessForActor(db, user);
  } catch (error) {
    if (error instanceof AccountAccessGuardError && error.code === "ACCOUNT_DISABLED") return fail("ACCOUNT_DISABLED");
    if (error instanceof AccountAccessGuardError && error.code === "ACCOUNT_ACCESS_STALE") return fail("ACCOUNT_ACCESS_STALE");
    return fail("ACCESS_FORBIDDEN");
  }
}

/**
 * Keep the role-to-permission projection shared by runtime authorization and
 * control-plane access explanations.  The latter must never grow a second,
 * subtly different interpretation of a membership role.
 */
export function projectRolePermission(role: ProjectMembershipRole): ProjectPermission {
  return role === "owner" ? "owner" : role === "editor" ? "edit" : "view";
}

export function workspaceRolePermission(role: WorkspaceMembershipRole): ProjectPermission | null {
  if (role === "owner" || role === "admin") return "owner";
  return null;
}

export function highestProjectPermission(
  left: ProjectPermission | null,
  right: ProjectPermission | null,
): ProjectPermission | null {
  if (left === null) return right;
  if (right === null) return left;
  const rank: Record<ProjectPermission, number> = { view: 1, edit: 2, owner: 3 };
  return rank[left] >= rank[right] ? left : right;
}

function satisfies(actual: ProjectPermission, required: ProjectPermission): boolean {
  const rank: Record<ProjectPermission, number> = { view: 1, edit: 2, owner: 3 };
  return rank[actual] >= rank[required];
}

export function accessibleProjectWhere(user: AccessUser): Prisma.ProjectWhereInput {
  return {
    OR: [
      {
        membershipInheritanceMode: "workspaceInherited",
        workspace: {
          memberships: {
            some: { userId: user.id, accessState: "confirmed", role: { in: ["owner", "admin"] } },
          },
        },
      },
      { memberships: { some: { userId: user.id, accessState: "confirmed" } } },
    ],
  };
}

export async function getProjectPermission(
  user: AccessUser,
  projectId: string,
  db: PrismaClient | Prisma.TransactionClient = getDb(),
): Promise<ProjectPermission | null> {
  const canonicalId = canonicalProjectId(projectId);
  const project = await db.project.findUnique({
    where: { id: canonicalId },
    select: {
      membershipInheritanceMode: true,
      workspaceId: true,
    },
  });
  if (project === null) return null;
  const [workspaceMembership, projectMembership] = await Promise.all([
    project.membershipInheritanceMode === "workspaceInherited"
      ? findConfirmedWorkspaceMembership(db, project.workspaceId, user.id)
      : Promise.resolve(null),
    findConfirmedProjectMembership(db, canonicalId, user.id),
  ]);
  const workspacePermission = project.membershipInheritanceMode === "workspaceInherited" && workspaceMembership !== null
    ? workspaceRolePermission(workspaceMembership.role)
    : null;
  const projectPermission = projectMembership !== null ? projectRolePermission(projectMembership.role) : null;
  return highestProjectPermission(workspacePermission, projectPermission);
}

export async function assertProjectAccess(
  user: AccessUser,
  projectId: string,
  required: ProjectPermission,
  db: PrismaClient | Prisma.TransactionClient = getDb(),
): Promise<ProjectPermission> {
  await assertCurrentAccountAccess(user, db);
  const canonicalId = canonicalProjectId(projectId);
  const permission = await getProjectPermission(user, canonicalId, db);
  if (permission === null) {
    const exists = await db.project.count({ where: { id: canonicalId } });
    if (exists === 0) return fail("ACCESS_PROJECT_NOT_FOUND");
    return fail("ACCESS_FORBIDDEN");
  }
  if (!satisfies(permission, required)) return fail("ACCESS_FORBIDDEN");
  return permission;
}

export async function assertWorkspaceAdmin(
  user: AccessUser,
  workspaceId: string,
  db: PrismaClient | Prisma.TransactionClient = getDb(),
): Promise<WorkspaceMembershipRole> {
  await assertCurrentAccountAccess(user, db);
  const membership = await findConfirmedWorkspaceMembership(db, workspaceId, user.id);
  if (membership === null) {
    const exists = await db.workspace.count({ where: { id: workspaceId } });
    if (exists === 0) return fail("ACCESS_WORKSPACE_NOT_FOUND");
    return fail("ACCESS_FORBIDDEN");
  }
  if (membership.role !== "owner" && membership.role !== "admin") return fail("ACCESS_FORBIDDEN");
  return membership.role;
}

export async function resolveProjectCreationWorkspace(user: AccessUser, db: PrismaClient = getDb()): Promise<string> {
  const personalWorkspace = await db.workspace.findUnique({
    where: { slug: `user-${user.id}` },
    select: { id: true, createdById: true },
  });
  if (personalWorkspace !== null) {
    if (personalWorkspace.createdById !== user.id) return fail("ACCESS_FORBIDDEN");
    const ownerMembership = await findConfirmedWorkspaceMembership(db, personalWorkspace.id, user.id);
    if (ownerMembership?.role !== "owner") return fail("ACCESS_FORBIDDEN");
    return personalWorkspace.id;
  }
  if (user.role === "user") return fail("ACCESS_FORBIDDEN");
  const membership = await db.workspaceMembership.findFirst({
    where: { userId: user.id, accessState: "confirmed", role: { in: ["owner", "admin"] } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { workspaceId: true },
  });
  if (membership === null) return fail("ACCESS_FORBIDDEN");
  return membership.workspaceId;
}

export async function authorizeApiRequest(
  user: AccessUser,
  request: Request,
  db: PrismaClient | Prisma.TransactionClient = getDb(),
): Promise<void> {
  await assertCurrentAccountAccess(user, db);
  const rawPath = new URL(request.url).pathname;
  const path = decodedApiPath(request);
  const namespace = classifyApiPath(path);
  if (namespace === "deprecated") return fail("ACCESS_FORBIDDEN");
  if (namespace === "platform" && user.role !== "admin") return fail("ACCESS_FORBIDDEN");
  if (namespace === "ordinary-user" && user.role === "admin") return fail("ACCESS_FORBIDDEN");
  if (user.role === "admin" && namespace === "unknown") return fail("ACCESS_FORBIDDEN");
  if (namespace === "platform" || namespace === "shared" || namespace === "public") return;
  const projectIdCandidate = path.match(PROJECT_PATH_PATTERN)?.[1];
  if (projectIdCandidate === undefined) return;
  const parsedProjectId = PROJECT_ID_SCHEMA.safeParse(projectIdCandidate);
  // A personal Git connection owner may need to reject/revoke their own
  // delegation after losing project access.  Keep this bypass exact to the
  // exact Git and MCP terminal routes; their service-layer predicates remain authoritative.
  // Match the raw path too, so percent-encoded or malformed paths do not gain
  // a broader bypass than the concrete Next route.
  if (parsedProjectId.success
    && rawPath === path
    && request.method.toUpperCase() === "POST"
    && (GIT_DELEGATION_TERMINAL_PATH_PATTERN.test(path) || MCP_DELEGATION_TERMINAL_PATH_PATTERN.test(path))) return;
  if (!parsedProjectId.success) return;
  const write = !["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase());
  const ownerOnly = write && (
    (request.method.toUpperCase() === "DELETE" && /^\/api\/projects\/[^/]+\/?$/u.test(path))
    || /\/(?:lifecycle|export|action-policies|mcp-tool-grants)(?:\/|$)/u.test(path)
    || /\/actions\/[0-9a-f-]+\/decision(?:\/|$)/iu.test(path)
  );
  try {
    await assertProjectAccess(user, canonicalProjectId(parsedProjectId.data), ownerOnly ? "owner" : write ? "edit" : "view", db);
  } catch (error) {
    if (error instanceof AccessControlError && error.code === "ACCESS_PROJECT_NOT_FOUND") {
      return fail("ACCESS_FORBIDDEN");
    }
    throw error;
  }
}
