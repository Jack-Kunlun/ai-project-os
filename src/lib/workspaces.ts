import { createHash, randomBytes } from "node:crypto";
import { Prisma, type AppUser, type PrismaClient, type ProjectMembershipRole, type WorkspaceMembershipRole } from "@prisma/client";
import { z } from "zod";
import { AccessControlError, assertWorkspaceAdmin, type AccessUser } from "@/lib/access-control";
import { createPasswordRecord, DEFAULT_WORKSPACE_ID } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { canonicalInternalReturnPath } from "@/lib/redirects";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

export type WorkspaceErrorCode =
  | "WORKSPACE_INVALID_INPUT"
  | "WORKSPACE_NOT_FOUND"
  | "WORKSPACE_MEMBER_NOT_FOUND"
  | "WORKSPACE_MEMBER_CONFLICT"
  | "WORKSPACE_INVITATION_NOT_FOUND"
  | "WORKSPACE_INVITATION_EXPIRED"
  | "WORKSPACE_INVITATION_EMAIL_MISMATCH"
  | "WORKSPACE_LAST_OWNER_REQUIRED";

export class WorkspaceError extends Error {
  constructor(readonly code: WorkspaceErrorCode) {
    super(code);
    this.name = "WorkspaceError";
  }
}

const roleSchema = z.enum(["owner", "admin", "member", "viewer"]);
const projectRoleSchema = z.enum(["owner", "editor", "viewer"]);
const projectGrantSchema = z.object({ projectId: z.string().uuid(), role: projectRoleSchema }).strict();
const createMemberSchema = z.object({
  username: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/u),
  password: z.string().min(12).max(128),
  displayName: z.string().trim().min(1).max(160).nullable().optional(),
  email: z.string().trim().toLowerCase().max(320).nullable().optional(),
  workspaceRole: roleSchema.exclude(["owner"]).default("member"),
  projectGrants: z.array(projectGrantSchema).max(100).default([]),
}).strict();
const updateMemberSchema = z.object({
  workspaceRole: roleSchema.optional(),
  disabled: z.boolean().optional(),
  projectGrants: z.array(projectGrantSchema).max(100).optional(),
}).strict();
const invitationSchema = z.object({
  email: z.string().trim().toLowerCase().max(320).nullable().optional(),
  workspaceRole: roleSchema.exclude(["owner"]).default("member"),
  projectId: z.string().uuid().nullable().optional(),
  projectRole: projectRoleSchema.nullable().optional(),
  expiresInDays: z.number().int().min(1).max(30).default(7),
}).strict();

const workspaceRoleRank: Record<WorkspaceMembershipRole, number> = { viewer: 1, member: 2, admin: 3, owner: 4 };
const projectRoleRank: Record<ProjectMembershipRole, number> = { viewer: 1, editor: 2, owner: 3 };

export function highestWorkspaceRole(left: WorkspaceMembershipRole, right: WorkspaceMembershipRole): WorkspaceMembershipRole {
  return workspaceRoleRank[left] >= workspaceRoleRank[right] ? left : right;
}

export function highestProjectRole(left: ProjectMembershipRole, right: ProjectMembershipRole): ProjectMembershipRole {
  return projectRoleRank[left] >= projectRoleRank[right] ? left : right;
}

function fail(code: WorkspaceErrorCode): never {
  throw new WorkspaceError(code);
}

function uuid(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) return fail("WORKSPACE_INVALID_INPUT");
  return value;
}

function email(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  return EMAIL_PATTERN.test(value) ? value : fail("WORKSPACE_INVALID_INPUT");
}

function hashToken(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isPrismaCode(error: unknown, code: string): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
}

async function assertProjectsInWorkspace(workspaceId: string, grants: readonly { projectId: string }[], db: PrismaClient | Prisma.TransactionClient) {
  const uniqueIds = [...new Set(grants.map((grant) => grant.projectId))];
  if (uniqueIds.length !== grants.length) return fail("WORKSPACE_INVALID_INPUT");
  if (uniqueIds.length === 0) return;
  const count = await db.project.count({ where: { workspaceId, id: { in: uniqueIds } } });
  if (count !== uniqueIds.length) return fail("WORKSPACE_INVALID_INPUT");
}

export async function resolveUserWorkspace(user: AccessUser, db: PrismaClient = getDb()) {
  if (user.role === "admin") {
    const workspace = await db.workspace.findUnique({ where: { id: DEFAULT_WORKSPACE_ID } });
    if (workspace !== null) return workspace;
  }
  const membership = await db.workspaceMembership.findFirst({
    where: { userId: user.id },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    include: { workspace: true },
  });
  if (membership === null) return fail("WORKSPACE_NOT_FOUND");
  return membership.workspace;
}

export async function getWorkspaceOverview(user: AccessUser, db: PrismaClient = getDb()) {
  const workspace = await resolveUserWorkspace(user, db);
  const membership = user.role === "admin"
    ? { role: "owner" as WorkspaceMembershipRole }
    : await db.workspaceMembership.findUnique({ where: { workspaceId_userId: { workspaceId: workspace.id, userId: user.id } }, select: { role: true } });
  if (membership === null) return fail("WORKSPACE_NOT_FOUND");
  const counts = await db.workspace.findUniqueOrThrow({
    where: { id: workspace.id },
    select: { _count: { select: { memberships: true, projects: true, oidcProviders: true } } },
  });
  return Object.freeze({ workspace, role: membership.role, counts: counts._count });
}

export async function listWorkspaceMembers(workspaceIdInput: unknown, actor: AccessUser, db: PrismaClient = getDb()) {
  const workspaceId = uuid(workspaceIdInput);
  await assertWorkspaceAdmin(actor, workspaceId, db);
  return db.workspaceMembership.findMany({
    where: { workspaceId },
    orderBy: [{ role: "asc" }, { createdAt: "asc" }],
    select: {
      role: true,
      createdAt: true,
      user: { select: { id: true, username: true, displayName: true, email: true, role: true, disabledAt: true, createdAt: true, oidcIdentities: { select: { provider: { select: { id: true, name: true } }, lastLoginAt: true } } } },
      workspace: { select: { projects: { orderBy: { name: "asc" }, select: { id: true, name: true } } } },
      userId: true,
    },
  }).then(async (memberships) => {
    const grants = await db.projectMembership.findMany({ where: { project: { workspaceId }, userId: { in: memberships.map((entry) => entry.userId) } }, select: { userId: true, projectId: true, role: true } });
    return memberships.map((membership) => ({ ...membership, projectGrants: grants.filter((grant) => grant.userId === membership.userId) }));
  });
}

export async function createLocalWorkspaceMember(workspaceIdInput: unknown, input: unknown, actor: AccessUser, db: PrismaClient = getDb()) {
  const workspaceId = uuid(workspaceIdInput);
  await assertWorkspaceAdmin(actor, workspaceId, db);
  const parsed = createMemberSchema.parse(input);
  const normalizedEmail = email(parsed.email);
  const password = await createPasswordRecord(parsed.password);
  await assertProjectsInWorkspace(workspaceId, parsed.projectGrants, db);
  try {
    return await db.$transaction(async (tx) => {
      const user = await tx.appUser.create({ data: { username: parsed.username, displayName: parsed.displayName ?? null, email: normalizedEmail, role: "member", ...password } });
      await tx.workspaceMembership.create({ data: { workspaceId, userId: user.id, role: parsed.workspaceRole } });
      if (parsed.projectGrants.length > 0) await tx.projectMembership.createMany({ data: parsed.projectGrants.map((grant) => ({ projectId: grant.projectId, userId: user.id, role: grant.role })) });
      return user;
    });
  } catch (error) {
    if (isPrismaCode(error, "P2002")) return fail("WORKSPACE_MEMBER_CONFLICT");
    throw error;
  }
}

export async function updateWorkspaceMember(
  workspaceIdInput: unknown,
  userIdInput: unknown,
  input: unknown,
  actor: AccessUser,
  db: PrismaClient = getDb(),
) {
  const workspaceId = uuid(workspaceIdInput);
  const userId = uuid(userIdInput);
  const actorRole = await assertWorkspaceAdmin(actor, workspaceId, db);
  const parsed = updateMemberSchema.parse(input);
  if (parsed.workspaceRole === "owner" && actor.role !== "admin" && actorRole !== "owner") throw new AccessControlError("ACCESS_FORBIDDEN");
  if (parsed.projectGrants) await assertProjectsInWorkspace(workspaceId, parsed.projectGrants, db);
  return db.$transaction(async (tx) => {
    const current = await tx.workspaceMembership.findUnique({ where: { workspaceId_userId: { workspaceId, userId } } });
    if (current === null) return fail("WORKSPACE_MEMBER_NOT_FOUND");
    if (actor.role !== "admin" && actorRole !== "owner" && current.role === "owner") {
      throw new AccessControlError("ACCESS_FORBIDDEN");
    }
    if (current.role === "owner" && parsed.workspaceRole !== undefined && parsed.workspaceRole !== "owner") {
      const owners = await tx.workspaceMembership.count({ where: { workspaceId, role: "owner", user: { disabledAt: null } } });
      if (owners <= 1) return fail("WORKSPACE_LAST_OWNER_REQUIRED");
    }
    if (current.role === "owner" && parsed.disabled === true) {
      const owners = await tx.workspaceMembership.count({ where: { workspaceId, role: "owner", user: { disabledAt: null } } });
      if (owners <= 1) return fail("WORKSPACE_LAST_OWNER_REQUIRED");
    }
    if (parsed.workspaceRole !== undefined) await tx.workspaceMembership.update({ where: { id: current.id }, data: { role: parsed.workspaceRole } });
    if (parsed.disabled !== undefined) {
      await tx.appUser.update({ where: { id: userId }, data: { disabledAt: parsed.disabled ? new Date() : null } });
      if (parsed.disabled) await tx.appSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
    }
    if (parsed.projectGrants !== undefined) {
      await tx.projectMembership.deleteMany({ where: { userId, project: { workspaceId } } });
      if (parsed.projectGrants.length > 0) await tx.projectMembership.createMany({ data: parsed.projectGrants.map((grant) => ({ userId, projectId: grant.projectId, role: grant.role })) });
    }
    return tx.workspaceMembership.findUniqueOrThrow({ where: { workspaceId_userId: { workspaceId, userId } }, include: { user: true } });
  });
}

export async function createWorkspaceInvitation(workspaceIdInput: unknown, input: unknown, actor: AccessUser, db: PrismaClient = getDb()) {
  const workspaceId = uuid(workspaceIdInput);
  await assertWorkspaceAdmin(actor, workspaceId, db);
  const parsed = invitationSchema.parse(input);
  const normalizedEmail = email(parsed.email);
  const projectId = parsed.projectId ?? null;
  const projectRole = parsed.projectRole ?? null;
  if ((projectId === null) !== (projectRole === null)) return fail("WORKSPACE_INVALID_INPUT");
  if (projectId !== null) await assertProjectsInWorkspace(workspaceId, [{ projectId }], db);
  const token = randomBytes(32).toString("base64url");
  const invitation = await db.workspaceInvitation.create({
    data: { workspaceId, email: normalizedEmail, tokenHash: hashToken(token), workspaceRole: parsed.workspaceRole, projectId, projectRole, invitedById: actor.id, expiresAt: new Date(Date.now() + parsed.expiresInDays * 86_400_000) },
    select: { id: true, email: true, workspaceRole: true, projectId: true, projectRole: true, expiresAt: true, createdAt: true },
  });
  return Object.freeze({ invitation, token, acceptPath: `/accept-invitation?token=${encodeURIComponent(token)}` });
}

export async function listWorkspaceInvitations(workspaceIdInput: unknown, actor: AccessUser, db: PrismaClient = getDb()) {
  const workspaceId = uuid(workspaceIdInput);
  await assertWorkspaceAdmin(actor, workspaceId, db);
  return db.workspaceInvitation.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: { id: true, email: true, workspaceRole: true, projectId: true, projectRole: true, expiresAt: true, acceptedAt: true, revokedAt: true, createdAt: true, project: { select: { name: true } }, invitedBy: { select: { username: true } } },
  });
}

export async function acceptWorkspaceInvitation(tokenInput: unknown, actor: Pick<AppUser, "id" | "email">, returnToInput: unknown, db: PrismaClient = getDb()) {
  if (typeof tokenInput !== "string" || !/^[A-Za-z0-9_-]{40,128}$/u.test(tokenInput)) return fail("WORKSPACE_INVALID_INPUT");
  const returnTo = canonicalInternalReturnPath(returnToInput);
  return db.$transaction(async (tx) => {
    const invitation = await tx.workspaceInvitation.findUnique({ where: { tokenHash: hashToken(tokenInput) } });
    if (invitation === null || invitation.revokedAt !== null || invitation.acceptedAt !== null) return fail("WORKSPACE_INVITATION_NOT_FOUND");
    if (invitation.expiresAt <= new Date()) return fail("WORKSPACE_INVITATION_EXPIRED");
    if (invitation.email !== null && invitation.email !== actor.email?.toLowerCase()) return fail("WORKSPACE_INVITATION_EMAIL_MISMATCH");
    const currentWorkspaceMembership = await tx.workspaceMembership.findUnique({ where: { workspaceId_userId: { workspaceId: invitation.workspaceId, userId: actor.id } }, select: { role: true } });
    const workspaceRole = currentWorkspaceMembership === null ? invitation.workspaceRole : highestWorkspaceRole(currentWorkspaceMembership.role, invitation.workspaceRole);
    await tx.workspaceMembership.upsert({ where: { workspaceId_userId: { workspaceId: invitation.workspaceId, userId: actor.id } }, create: { workspaceId: invitation.workspaceId, userId: actor.id, role: workspaceRole }, update: { role: workspaceRole } });
    if (invitation.projectId !== null && invitation.projectRole !== null) {
      const currentProjectMembership = await tx.projectMembership.findUnique({ where: { projectId_userId: { projectId: invitation.projectId, userId: actor.id } }, select: { role: true } });
      const projectRole = currentProjectMembership === null ? invitation.projectRole : highestProjectRole(currentProjectMembership.role, invitation.projectRole);
      await tx.projectMembership.upsert({ where: { projectId_userId: { projectId: invitation.projectId, userId: actor.id } }, create: { projectId: invitation.projectId, userId: actor.id, role: projectRole }, update: { role: projectRole } });
    }
    await tx.workspaceInvitation.update({ where: { id: invitation.id }, data: { acceptedById: actor.id, acceptedAt: new Date() } });
    return Object.freeze({ workspaceId: invitation.workspaceId, returnTo });
  });
}

export function asProjectRole(value: string): ProjectMembershipRole {
  return projectRoleSchema.parse(value);
}
