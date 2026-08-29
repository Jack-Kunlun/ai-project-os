import { Prisma, type AppUserRole, type PrismaClient, type ProjectMembershipRole, type WorkspaceMembershipRole } from "@prisma/client";
import { getDb } from "@/lib/db";

const PROJECT_PATH_PATTERN = /^\/api\/projects\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?:\/|$)/u;

export type AccessControlErrorCode =
  | "ACCESS_FORBIDDEN"
  | "ACCESS_PROJECT_NOT_FOUND"
  | "ACCESS_WORKSPACE_NOT_FOUND"
  | "ACCESS_LAST_OWNER_REQUIRED";

export class AccessControlError extends Error {
  constructor(readonly code: AccessControlErrorCode) {
    super(code);
    this.name = "AccessControlError";
  }
}

export type AccessUser = Readonly<{ id: string; role: AppUserRole }>;
export type ProjectPermission = "owner" | "edit" | "view";

function fail(code: AccessControlErrorCode): never {
  throw new AccessControlError(code);
}

function projectRolePermission(role: ProjectMembershipRole): ProjectPermission {
  return role === "owner" ? "owner" : role === "editor" ? "edit" : "view";
}

function workspaceRolePermission(role: WorkspaceMembershipRole): ProjectPermission | null {
  if (role === "owner" || role === "admin") return "owner";
  return null;
}

function satisfies(actual: ProjectPermission, required: ProjectPermission): boolean {
  const rank: Record<ProjectPermission, number> = { view: 1, edit: 2, owner: 3 };
  return rank[actual] >= rank[required];
}

export function accessibleProjectWhere(user: AccessUser): Prisma.ProjectWhereInput {
  if (user.role === "admin") return {};
  return {
    OR: [
      { workspace: { memberships: { some: { userId: user.id, role: { in: ["owner", "admin"] } } } } },
      { memberships: { some: { userId: user.id } } },
    ],
  };
}

export async function getProjectPermission(user: AccessUser, projectId: string, db: PrismaClient = getDb()): Promise<ProjectPermission | null> {
  if (user.role === "admin") {
    return (await db.project.count({ where: { id: projectId } })) === 1 ? "owner" : null;
  }
  const project = await db.project.findUnique({
    where: { id: projectId },
    select: {
      workspace: { select: { memberships: { where: { userId: user.id }, take: 1, select: { role: true } } } },
      memberships: { where: { userId: user.id }, take: 1, select: { role: true } },
    },
  });
  if (project === null) return null;
  const workspacePermission = project.workspace.memberships[0] ? workspaceRolePermission(project.workspace.memberships[0].role) : null;
  const projectPermission = project.memberships[0] ? projectRolePermission(project.memberships[0].role) : null;
  if (workspacePermission === "owner" || projectPermission === "owner") return "owner";
  if (projectPermission === "edit") return "edit";
  return projectPermission;
}

export async function assertProjectAccess(user: AccessUser, projectId: string, required: ProjectPermission, db: PrismaClient = getDb()): Promise<ProjectPermission> {
  const permission = await getProjectPermission(user, projectId, db);
  if (permission === null) {
    const exists = await db.project.count({ where: { id: projectId } });
    if (exists === 0) return fail("ACCESS_PROJECT_NOT_FOUND");
    return fail("ACCESS_FORBIDDEN");
  }
  if (!satisfies(permission, required)) return fail("ACCESS_FORBIDDEN");
  return permission;
}

export async function assertWorkspaceAdmin(user: AccessUser, workspaceId: string, db: PrismaClient = getDb()): Promise<WorkspaceMembershipRole> {
  if (user.role === "admin") return "owner";
  const membership = await db.workspaceMembership.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: user.id } },
    select: { role: true },
  });
  if (membership === null) {
    const exists = await db.workspace.count({ where: { id: workspaceId } });
    if (exists === 0) return fail("ACCESS_WORKSPACE_NOT_FOUND");
    return fail("ACCESS_FORBIDDEN");
  }
  if (membership.role !== "owner" && membership.role !== "admin") return fail("ACCESS_FORBIDDEN");
  return membership.role;
}

export async function resolveProjectCreationWorkspace(user: AccessUser, db: PrismaClient = getDb()): Promise<string> {
  if (user.role === "admin") {
    const workspace = await db.workspace.findFirst({ orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true } });
    if (workspace === null) return fail("ACCESS_WORKSPACE_NOT_FOUND");
    return workspace.id;
  }
  const membership = await db.workspaceMembership.findFirst({
    where: { userId: user.id, role: { in: ["owner", "admin"] } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { workspaceId: true },
  });
  if (membership === null) return fail("ACCESS_FORBIDDEN");
  return membership.workspaceId;
}

export async function authorizeApiRequest(user: AccessUser, request: Request, db: PrismaClient = getDb()): Promise<void> {
  const path = new URL(request.url).pathname;
  if (path.startsWith("/api/settings/")) {
    if (user.role !== "admin") return fail("ACCESS_FORBIDDEN");
    return;
  }
  const projectId = path.match(PROJECT_PATH_PATTERN)?.[1];
  if (projectId === undefined) return;
  const write = !["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase());
  const ownerOnly = write && (
    /\/(?:lifecycle|export|action-policies|mcp-tool-grants)(?:\/|$)/u.test(path)
    || /\/actions\/[0-9a-f-]+\/decision(?:\/|$)/u.test(path)
  );
  await assertProjectAccess(user, projectId, ownerOnly ? "owner" : write ? "edit" : "view", db);
}
