import { createHash, randomBytes } from "node:crypto";
import { MembershipAccessState, Prisma, type AppUser, type PrismaClient, type ProjectMembershipRole, type WorkspaceMembershipRole } from "@prisma/client";
import { z } from "zod";
import { AccessControlError, assertWorkspaceAdmin, type AccessUser } from "@/lib/access-control";
import { createPasswordRecord } from "@/lib/auth";
import { lockActorsAccess, lockProjectAccess, lockWorkspaceAccess, lockWorkspaceInvitationAccess } from "@/lib/access-linearization";
import { getDb } from "@/lib/db";
import {
  appendProjectMembershipAudit,
  appendWorkspaceMembershipAudit,
  findConfirmedWorkspaceMembership,
  findCurrentProjectMembership,
  findCurrentWorkspaceMembership,
  grantProjectMembership,
  grantWorkspaceMembership,
  hasRevokedProjectMembership,
  hasRevokedWorkspaceMembership,
  revokeProjectMembership,
} from "@/lib/membership-governance";
import { canonicalInternalReturnPath } from "@/lib/redirects";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

export type WorkspaceErrorCode =
  | "WORKSPACE_INVALID_INPUT"
  | "WORKSPACE_NOT_FOUND"
  | "WORKSPACE_MEMBER_NOT_FOUND"
  | "WORKSPACE_MEMBER_CONFLICT"
  | "MEMBERSHIP_REVIEW_REQUIRED"
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
  projectGrants: z.array(projectGrantSchema).max(100).optional(),
}).strict();
const invitationSchema = z.object({
  email: z.string().trim().toLowerCase().max(320).nullable().optional(),
  workspaceRole: roleSchema.exclude(["owner"]).default("member"),
  projectId: z.string().uuid().nullable().optional(),
  projectRole: projectRoleSchema.nullable().optional(),
  expiresInDays: z.number().int().min(1).max(30).default(7),
}).strict();

const workspaceMemberSelect = {
  role: true,
  accessState: true,
  createdAt: true,
  user: {
    select: {
      id: true,
      username: true,
      displayName: true,
      email: true,
      disabledAt: true,
      createdAt: true,
      oidcIdentities: { select: { provider: { select: { id: true, name: true } }, lastLoginAt: true } },
    },
  },
  workspace: { select: { projects: { orderBy: { name: "asc" }, select: { id: true, name: true } } } },
  userId: true,
} satisfies Prisma.WorkspaceMembershipSelect;

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
  const membership = await db.workspaceMembership.findFirst({
    where: { userId: user.id, accessState: "confirmed" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    include: { workspace: true },
  });
  if (membership === null) return fail("WORKSPACE_NOT_FOUND");
  return membership.workspace;
}

export async function getWorkspaceOverview(user: AccessUser, db: PrismaClient = getDb()) {
  const workspace = await resolveUserWorkspace(user, db);
  const membership = await findConfirmedWorkspaceMembership(db, workspace.id, user.id);
  if (membership === null) return fail("WORKSPACE_NOT_FOUND");
  const counts = await db.workspace.findUniqueOrThrow({
    where: { id: workspace.id },
    select: { _count: { select: { memberships: { where: { accessState: "confirmed" } }, projects: true, oidcProviders: true } } },
  });
  return Object.freeze({ workspace, role: membership.role, counts: counts._count });
}

export async function listWorkspaceMembers(workspaceIdInput: unknown, actor: AccessUser, db: PrismaClient = getDb()) {
  const workspaceId = uuid(workspaceIdInput);
  await assertWorkspaceAdmin(actor, workspaceId, db);
  return db.workspaceMembership.findMany({
    // Management views expose the current authorization epoch only. Revoked
    // rows remain queryable through governance/history tooling, but must not
    // reappear as duplicate members in the ordinary team view.
    where: { workspaceId, accessState: { not: MembershipAccessState.revoked } },
    orderBy: [{ role: "asc" }, { createdAt: "asc" }],
    select: workspaceMemberSelect,
  }).then(async (memberships) => {
    const grants = await db.projectMembership.findMany({ where: { project: { workspaceId }, userId: { in: memberships.map((entry) => entry.userId) }, accessState: { not: MembershipAccessState.revoked } }, select: { userId: true, projectId: true, role: true, accessState: true } });
    return memberships.map((membership) => ({ ...membership, projectGrants: grants.filter((grant) => grant.userId === membership.userId).map(({ projectId, role, accessState }) => ({ projectId, role, accessState })) }));
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
      await lockActorsAccess(tx, [actor.id]);
      await lockWorkspaceAccess(tx, workspaceId);
      const currentActor = await tx.appUser.findUnique({ where: { id: actor.id }, select: { id: true, disabledAt: true } });
      const actingMembership = await findConfirmedWorkspaceMembership(tx, workspaceId, actor.id);
      if (currentActor === null || currentActor.disabledAt !== null || actingMembership === null || (actingMembership.role !== "owner" && actingMembership.role !== "admin")) {
        throw new AccessControlError("ACCESS_FORBIDDEN");
      }
      await assertProjectsInWorkspace(workspaceId, parsed.projectGrants, tx);
      const user = await tx.appUser.create({ data: { username: parsed.username, displayName: parsed.displayName ?? null, email: normalizedEmail, role: "user", ...password } });
      const createdWorkspaceMembership = await tx.workspaceMembership.create({ data: { workspaceId, userId: user.id, role: parsed.workspaceRole, accessState: MembershipAccessState.confirmed } });
      await appendWorkspaceMembershipAudit(tx, createdWorkspaceMembership, {
        action: "confirmed",
        previousState: null,
        actorId: actor.id,
        reason: "local_member_created",
      });
      const createdProjectMemberships = [];
      for (const grant of parsed.projectGrants) {
        const created = await tx.projectMembership.create({ data: { projectId: grant.projectId, userId: user.id, role: grant.role, accessState: MembershipAccessState.confirmed }, include: { project: { select: { workspaceId: true } } } });
        createdProjectMemberships.push(created);
        await appendProjectMembershipAudit(tx, { ...created, workspaceId: created.project.workspaceId }, {
          action: "confirmed",
          previousState: null,
          actorId: actor.id,
          reason: "local_member_project_grant_created",
        });
      }
      const membership = await tx.workspaceMembership.findUniqueOrThrow({ where: { id: createdWorkspaceMembership.id }, select: workspaceMemberSelect });
      return { ...membership, projectGrants: createdProjectMemberships.map(({ projectId, role, accessState }) => ({ projectId, role, accessState })) };
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
  const parsed = updateMemberSchema.parse(input);
  return db.$transaction(async (tx) => {
    // Keep the lock order identical to project admission.  In particular,
    // target actor is locked before the workspace so a downgrade/removal and
    // a dispatch for that user cannot both pass their final checks.
    await lockActorsAccess(tx, [actor.id, userId]);
    await lockWorkspaceAccess(tx, workspaceId);
    const currentActor = await tx.appUser.findUnique({ where: { id: actor.id }, select: { id: true, disabledAt: true } });
    if (currentActor === null || currentActor.disabledAt !== null) throw new AccessControlError("ACCESS_FORBIDDEN");
    const actingMembership = await findConfirmedWorkspaceMembership(tx, workspaceId, actor.id);
    if (actingMembership === null || (actingMembership.role !== "owner" && actingMembership.role !== "admin")) {
      throw new AccessControlError("ACCESS_FORBIDDEN");
    }
    const actorRole = actingMembership.role;
    if (parsed.workspaceRole === "owner" && actorRole !== "owner") throw new AccessControlError("ACCESS_FORBIDDEN");
    if (parsed.projectGrants) await assertProjectsInWorkspace(workspaceId, parsed.projectGrants, tx);
    const current = await findCurrentWorkspaceMembership(tx, workspaceId, userId);
    if (current === null) return fail("WORKSPACE_MEMBER_NOT_FOUND");
    if (current.accessState !== "confirmed") return fail("MEMBERSHIP_REVIEW_REQUIRED");
    if (actorRole !== "owner" && current.role === "owner") {
      throw new AccessControlError("ACCESS_FORBIDDEN");
    }
    if (current.role === "owner" && parsed.workspaceRole !== undefined && parsed.workspaceRole !== "owner") {
      const owners = await tx.workspaceMembership.count({ where: { workspaceId, role: "owner", accessState: "confirmed", user: { disabledAt: null } } });
      if (owners <= 1) return fail("WORKSPACE_LAST_OWNER_REQUIRED");
    }
    let currentMembershipId = current.id;
    if (parsed.workspaceRole !== undefined && parsed.workspaceRole !== current.role) {
      const replaced = await grantWorkspaceMembership(tx, {
        workspaceId,
        userId,
        role: parsed.workspaceRole,
        actorId: actor.id,
        reason: "workspace_member_role_replaced",
      });
      currentMembershipId = replaced.id;
    }
    if (parsed.projectGrants !== undefined) {
      const existingGrants = await tx.projectMembership.findMany({ where: { userId, project: { workspaceId }, accessState: { not: MembershipAccessState.revoked } }, select: { id: true, projectId: true, userId: true, role: true, accessState: true, createdAt: true, updatedAt: true } });
      const projectIds = [...new Set([...existingGrants.map((grant) => grant.projectId), ...parsed.projectGrants.map((grant) => grant.projectId)])].sort();
      for (const projectId of projectIds) await lockProjectAccess(tx, projectId);
      const requestedProjectIds = new Set(parsed.projectGrants.map((grant) => grant.projectId));
      for (const grant of parsed.projectGrants) {
        await grantProjectMembership(tx, {
          projectId: grant.projectId,
          workspaceId,
          userId,
          role: grant.role,
          actorId: actor.id,
          reason: "project_grant_explicitly_managed",
        });
      }
      for (const existing of existingGrants) {
        if (!requestedProjectIds.has(existing.projectId) && existing.accessState === MembershipAccessState.confirmed) {
          await revokeProjectMembership(tx, existing.projectId, userId, workspaceId, { actorId: actor.id, reason: "project_grant_removed" });
        }
      }
    }
    const membership = await tx.workspaceMembership.findUniqueOrThrow({ where: { id: currentMembershipId }, select: workspaceMemberSelect });
    const projectGrants = await tx.projectMembership.findMany({ where: { project: { workspaceId }, userId, accessState: { not: MembershipAccessState.revoked } }, select: { projectId: true, role: true, accessState: true } });
    return { ...membership, projectGrants };
  });
}

export async function createWorkspaceInvitation(workspaceIdInput: unknown, input: unknown, actor: AccessUser, db: PrismaClient = getDb()) {
  const workspaceId = uuid(workspaceIdInput);
  const parsed = invitationSchema.parse(input);
  const normalizedEmail = email(parsed.email);
  const projectId = parsed.projectId ?? null;
  const projectRole = parsed.projectRole ?? null;
  if ((projectId === null) !== (projectRole === null)) return fail("WORKSPACE_INVALID_INPUT");
  const token = randomBytes(32).toString("base64url");
  const invitation = await db.$transaction(async (tx) => {
    // Invitation creation is fenced with the same actor -> workspace ->
    // project order as membership changes.  The pre-lock inputs only locate
    // lock keys; the actor and confirmed admin membership are reloaded after
    // the locks before any durable write.
    await lockActorsAccess(tx, [actor.id]);
    await lockWorkspaceAccess(tx, workspaceId);
    if (projectId !== null) await lockProjectAccess(tx, projectId);
    const currentActor = await tx.appUser.findUnique({ where: { id: actor.id }, select: { id: true, disabledAt: true } });
    if (currentActor === null || currentActor.disabledAt !== null) throw new AccessControlError("ACCESS_FORBIDDEN");
    await assertWorkspaceAdmin(actor, workspaceId, tx);
    if (projectId !== null) await assertProjectsInWorkspace(workspaceId, [{ projectId }], tx);
    return tx.workspaceInvitation.create({
      data: { workspaceId, email: normalizedEmail, tokenHash: hashToken(token), workspaceRole: parsed.workspaceRole, projectId, projectRole, invitedById: actor.id, expiresAt: new Date(Date.now() + parsed.expiresInDays * 86_400_000) },
      select: { id: true, email: true, workspaceRole: true, projectId: true, projectRole: true, expiresAt: true, createdAt: true },
    });
  });
  return Object.freeze({ invitation, token, acceptPath: `/accept-invitation?token=${encodeURIComponent(token)}` });
}

export async function listWorkspaceInvitations(workspaceIdInput: unknown, actor: AccessUser, db: PrismaClient = getDb()) {
  const workspaceId = uuid(workspaceIdInput);
  return db.$transaction(async (tx) => {
    // Listing is read-only but still needs the current confirmed admin check
    // inside the workspace lock, otherwise a concurrent downgrade could race
    // a check performed outside the transaction.
    await lockActorsAccess(tx, [actor.id]);
    await lockWorkspaceAccess(tx, workspaceId);
    await assertWorkspaceAdmin(actor, workspaceId, tx);
    return tx.workspaceInvitation.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
      take: 100,
      select: { id: true, email: true, workspaceRole: true, projectId: true, projectRole: true, expiresAt: true, acceptedAt: true, revokedAt: true, createdAt: true, project: { select: { name: true } }, invitedBy: { select: { username: true } } },
    });
  });
}

export async function acceptWorkspaceInvitation(
  tokenInput: unknown,
  actor: Pick<AppUser, "id"> & Partial<Pick<AppUser, "email">>,
  returnToInput: unknown,
  db: PrismaClient = getDb(),
) {
  if (typeof tokenInput !== "string" || !/^[A-Za-z0-9_-]{40,128}$/u.test(tokenInput)) return fail("WORKSPACE_INVALID_INPUT");
  const actorId = uuid(actor.id);
  const returnTo = canonicalInternalReturnPath(returnToInput);
  return db.$transaction(async (tx) => {
    // The token is only used to locate lock keys.  Every invitation and actor
    // field used for authorization is reloaded after the common lock order.
    const locatedInvitation = await tx.workspaceInvitation.findUnique({ where: { tokenHash: hashToken(tokenInput) }, select: { id: true, workspaceId: true, projectId: true } });
    if (locatedInvitation === null) return fail("WORKSPACE_INVITATION_NOT_FOUND");
    await lockActorsAccess(tx, [actorId]);
    await lockWorkspaceAccess(tx, locatedInvitation.workspaceId);
    if (locatedInvitation.projectId !== null) await lockProjectAccess(tx, locatedInvitation.projectId);
    await lockWorkspaceInvitationAccess(tx, locatedInvitation.id);

    const invitation = await tx.workspaceInvitation.findUnique({ where: { id: locatedInvitation.id } });
    if (invitation === null || invitation.revokedAt !== null || invitation.acceptedAt !== null) return fail("WORKSPACE_INVITATION_NOT_FOUND");
    if (invitation.expiresAt <= new Date()) return fail("WORKSPACE_INVITATION_EXPIRED");
    const currentActor = await tx.appUser.findUnique({ where: { id: actorId }, select: { id: true, email: true, disabledAt: true } });
    if (currentActor === null || currentActor.disabledAt !== null) throw new AccessControlError("ACCESS_FORBIDDEN");
    if (invitation.email !== null && invitation.email !== currentActor.email?.toLowerCase()) return fail("WORKSPACE_INVITATION_EMAIL_MISMATCH");
    if (invitation.projectId !== null) {
      const project = await tx.project.findUnique({ where: { id: invitation.projectId }, select: { workspaceId: true } });
      if (project === null || project.workspaceId !== invitation.workspaceId) return fail("WORKSPACE_INVITATION_NOT_FOUND");
    }
    const currentWorkspaceMembership = await findCurrentWorkspaceMembership(tx, invitation.workspaceId, actorId);
    if (currentWorkspaceMembership === null && await hasRevokedWorkspaceMembership(tx, invitation.workspaceId, actorId)) return fail("MEMBERSHIP_REVIEW_REQUIRED");
    if (currentWorkspaceMembership !== null && currentWorkspaceMembership.accessState !== MembershipAccessState.confirmed) return fail("MEMBERSHIP_REVIEW_REQUIRED");
    // An invitation may provision a first membership, but it can never
    // silently elevate an already-confirmed membership.
    const workspaceRole = currentWorkspaceMembership === null ? invitation.workspaceRole : currentWorkspaceMembership.role;
    if (currentWorkspaceMembership === null) {
      await grantWorkspaceMembership(tx, {
        workspaceId: invitation.workspaceId,
        userId: actorId,
        role: workspaceRole,
        actorId,
        reason: "workspace_invitation_accepted",
      });
    }
    if (invitation.projectId !== null && invitation.projectRole !== null) {
      const currentProjectMembership = await findCurrentProjectMembership(tx, invitation.projectId, actorId);
      if (currentProjectMembership === null && await hasRevokedProjectMembership(tx, invitation.projectId, actorId)) return fail("MEMBERSHIP_REVIEW_REQUIRED");
      if (currentProjectMembership !== null && currentProjectMembership.accessState !== MembershipAccessState.confirmed) return fail("MEMBERSHIP_REVIEW_REQUIRED");
      const projectRole = currentProjectMembership === null ? invitation.projectRole : currentProjectMembership.role;
      if (currentProjectMembership === null) {
        await grantProjectMembership(tx, {
          projectId: invitation.projectId,
          workspaceId: invitation.workspaceId,
          userId: actorId,
          role: projectRole,
          actorId,
          reason: "workspace_invitation_project_grant_accepted",
        });
      }
    }
    await tx.workspaceInvitation.update({ where: { id: invitation.id }, data: { acceptedById: actorId, acceptedAt: new Date() } });
    return Object.freeze({ workspaceId: invitation.workspaceId, returnTo });
  });
}

export function asProjectRole(value: string): ProjectMembershipRole {
  return projectRoleSchema.parse(value);
}
