import { createHash, randomBytes } from "node:crypto";
import { MembershipAccessState, Prisma, type AppUser, type PrismaClient, type ProjectMembershipRole, type WorkspaceMembershipRole } from "@prisma/client";
import { z } from "zod";
import { AccessControlError, assertWorkspaceAdmin, type AccessUser } from "@/lib/access-control";
import { createPasswordRecord } from "@/lib/auth";
import { lockActorsAccess, lockProjectAccess, lockWorkspaceAccess, lockWorkspaceInvitationAccess } from "@/lib/access-linearization";
import { assertEntitlementWriterSession, getDb, getEntitlementDb, isEntitlementDatabase } from "@/lib/db";
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
import { activateAccountEntitlements } from "@/lib/account-entitlement-activation-service";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const UNSAFE_AUDIT_TEXT_PATTERN = /[\u0000-\u001f\u007f-\u009f]|[A-Za-z0-9_-]{40,128}/u;
const EMAIL_SHAPED_AUDIT_TEXT_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/u;

export type WorkspaceErrorCode =
  | "WORKSPACE_INVALID_INPUT"
  | "WORKSPACE_NOT_FOUND"
  | "WORKSPACE_MEMBER_NOT_FOUND"
  | "WORKSPACE_MEMBER_CONFLICT"
  | "MEMBERSHIP_REVIEW_REQUIRED"
  | "WORKSPACE_INVITATION_NOT_FOUND"
  | "WORKSPACE_INVITATION_EXPIRED"
  | "WORKSPACE_INVITATION_EMAIL_MISMATCH"
  | "WORKSPACE_INVITATION_IDEMPOTENCY_CONFLICT"
  | "WORKSPACE_INVITATION_IMPACT_STALE"
  | "WORKSPACE_INVITATION_REASON_REQUIRED"
  | "WORKSPACE_INVITATION_EMAIL_UNVERIFIED"
  | "WORKSPACE_INVITATION_UNSAFE_AUDIT_TEXT"
  | "WORKSPACE_INVITATION_STATE_CONFLICT"
  | "WORKSPACE_INVITATION_EXISTING_MEMBER"
  | "WORKSPACE_LAST_OWNER_REQUIRED"
  | "WORKSPACE_ROLE_GOVERNANCE_REQUIRED";

export class WorkspaceError extends Error {
  constructor(readonly code: WorkspaceErrorCode) {
    super(code);
    this.name = "WorkspaceError";
  }
}

const roleSchema = z.enum(["owner", "admin", "member", "viewer"]);
const projectRoleSchema = z.enum(["owner", "editor", "viewer"]);
// Provisioning and invitation inputs may only grant project Editor/Viewer.
// Project Owner remains a governance-only transition and historical elevated
// invitation rows are rejected during acceptance.
const projectProvisioningRoleSchema = projectRoleSchema.exclude(["owner"]);
const projectGrantSchema = z.object({ projectId: z.string().uuid(), role: projectProvisioningRoleSchema }).strict();
const createMemberSchema = z.object({
  username: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/u),
  password: z.string().min(12).max(128),
  displayName: z.string().trim().min(1).max(160).nullable().optional(),
  email: z.string().trim().toLowerCase().max(320).nullable().optional(),
  // Creation is intentionally a narrow provisioning path.  Owner/Admin role
  // changes use the dedicated preview -> confirm -> execute governance API.
  workspaceRole: roleSchema.exclude(["owner", "admin"]).default("member"),
  projectGrants: z.array(projectGrantSchema).max(100).default([]),
}).strict();
const updateMemberSchema = z.object({
  workspaceRole: roleSchema.optional(),
  projectGrants: z.array(projectGrantSchema).max(100).optional(),
}).strict();
const invitationSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  workspaceRole: roleSchema.exclude(["owner", "admin"]).default("member"),
  projectId: z.string().uuid().nullable().optional(),
  projectRole: projectProvisioningRoleSchema.nullable().optional(),
  expiresInDays: z.number().int().min(1).max(30).default(7),
  requestKey: z.string().trim().min(8).max(180),
}).strict();

const revokeInvitationSchema = z.object({
  reason: z.string().trim().min(1).max(500),
  requestKey: z.string().trim().min(8).max(180),
  expectedVersion: z.number().int().positive(),
  expectedImpactFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  confirmation: z.literal(true),
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

function safeAuditText(value: string): string {
  if (UNSAFE_AUDIT_TEXT_PATTERN.test(value) || EMAIL_SHAPED_AUDIT_TEXT_PATTERN.test(value) || /^[0-9a-f]{64}$/iu.test(value)) return fail("WORKSPACE_INVITATION_UNSAFE_AUDIT_TEXT");
  return value;
}

function hashToken(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hashFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function sameFingerprint(left: string | null, right: string): boolean {
  return left?.trim() === right;
}

function invitationStatus(invitation: Readonly<{ acceptedAt: Date | null; revokedAt: Date | null; expiresAt: Date }>): "pending" | "accepted" | "revoked" | "expired" {
  if (invitation.revokedAt !== null) return "revoked";
  if (invitation.acceptedAt !== null) return "accepted";
  if (invitation.expiresAt <= new Date()) return "expired";
  return "pending";
}

function invitationImpact(invitation: Readonly<{
  id: string;
  workspaceId: string;
  workspaceRole: WorkspaceMembershipRole;
  projectId: string | null;
  projectRole: ProjectMembershipRole | null;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date;
  version: number;
}>, dependency: Readonly<{ existingMember: boolean; projectGrant: boolean }>) {
  const status = invitationStatus(invitation);
  const blockingCategories = status === "pending" ? [] : [status];
  const fingerprint = hashFingerprint({
    invitationId: invitation.id,
    workspaceRole: invitation.workspaceRole,
    projectId: invitation.projectId,
    projectRole: invitation.projectRole,
    status,
    version: invitation.version,
    existingMember: dependency.existingMember,
    projectGrant: dependency.projectGrant,
    blockingCategories,
  });
  return Object.freeze({
    target: Object.freeze({ invitationId: invitation.id, status, workspaceRole: invitation.workspaceRole, projectRole: invitation.projectRole }),
    expectedVersion: invitation.version,
    dependencyStats: Object.freeze({ existingWorkspaceMember: dependency.existingMember ? 1 : 0, projectGrant: dependency.projectGrant ? 1 : 0 }),
    blockingCategories,
    impactFingerprint: fingerprint,
  });
}

function invitationRequestFingerprint(input: Readonly<{ email: string; workspaceRole: WorkspaceMembershipRole; projectId: string | null; projectRole: ProjectMembershipRole | null; expiresInDays: number }>): string {
  return hashFingerprint({ email: input.email, workspaceRole: input.workspaceRole, projectId: input.projectId, projectRole: input.projectRole, expiresInDays: input.expiresInDays });
}

function invitationRevokeFingerprint(input: Readonly<{ invitationId: string; reason: string; requestKey: string; expectedVersion: number; expectedImpactFingerprint: string; confirmation: true }>): string {
  return hashFingerprint(input);
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

export async function createLocalWorkspaceMember(workspaceIdInput: unknown, input: unknown, actor: AccessUser, db: PrismaClient = getEntitlementDb()) {
  const workspaceId = uuid(workspaceIdInput);
  await assertWorkspaceAdmin(actor, workspaceId, db);
  const parsed = createMemberSchema.parse(input);
  const normalizedEmail = email(parsed.email);
  const password = await createPasswordRecord(parsed.password);
  await assertProjectsInWorkspace(workspaceId, parsed.projectGrants, db);
  try {
    return await db.$transaction(async (tx) => {
      if (isEntitlementDatabase(db)) await assertEntitlementWriterSession(tx);
      await lockActorsAccess(tx, [actor.id]);
      await lockWorkspaceAccess(tx, workspaceId);
      const currentActor = await tx.appUser.findUnique({ where: { id: actor.id }, select: { id: true, disabledAt: true, accountAccessVersion: true } });
      const actingMembership = await findConfirmedWorkspaceMembership(tx, workspaceId, actor.id);
      if (currentActor === null || currentActor.disabledAt !== null || actingMembership === null || (actingMembership.role !== "owner" && actingMembership.role !== "admin")) throw new AccessControlError("ACCESS_FORBIDDEN");
      if (currentActor.accountAccessVersion !== actor.accountAccessVersion) throw new AccessControlError("ACCOUNT_ACCESS_STALE");
      await assertProjectsInWorkspace(workspaceId, parsed.projectGrants, tx);
      const user = await tx.appUser.create({ data: { username: parsed.username, displayName: parsed.displayName ?? null, email: normalizedEmail, role: "user", ...password } });
      await activateAccountEntitlements({
        userId: user.id,
        source: "localProvisioning",
        actorId: actor.id,
        accountAccessVersion: user.accountAccessVersion,
        actorAccountAccessVersion: currentActor.accountAccessVersion,
        evidenceKind: "local-provisioning",
        evidenceRef: workspaceId,
      }, tx);
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
  if (parsed.workspaceRole !== undefined || parsed.projectGrants !== undefined) {
    return fail("WORKSPACE_ROLE_GOVERNANCE_REQUIRED");
  }
  return db.$transaction(async (tx) => {
    // Keep the lock order identical to project admission.  In particular,
    // target actor is locked before the workspace so a downgrade/removal and
    // a dispatch for that user cannot both pass their final checks.
    await lockActorsAccess(tx, [actor.id, userId]);
    await lockWorkspaceAccess(tx, workspaceId);
    const currentActor = await tx.appUser.findUnique({ where: { id: actor.id }, select: { id: true, disabledAt: true, accountAccessVersion: true } });
    if (currentActor === null || currentActor.disabledAt !== null || currentActor.accountAccessVersion !== actor.accountAccessVersion) throw new AccessControlError("ACCOUNT_ACCESS_STALE");
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
  const normalizedEmail = parsed.email;
  const projectId = parsed.projectId ?? null;
  const projectRole = parsed.projectRole ?? null;
  if ((projectId === null) !== (projectRole === null)) return fail("WORKSPACE_INVALID_INPUT");
  safeAuditText(parsed.requestKey);
  const requestFingerprint = invitationRequestFingerprint({ email: normalizedEmail, workspaceRole: parsed.workspaceRole, projectId, projectRole, expiresInDays: parsed.expiresInDays });
  const result = await db.$transaction(async (tx) => {
    // Invitation creation is fenced with the same actor -> workspace ->
    // project order as membership changes.  The pre-lock inputs only locate
    // lock keys; the actor and confirmed admin membership are reloaded after
    // the locks before any durable write.
    await lockActorsAccess(tx, [actor.id]);
    await lockWorkspaceAccess(tx, workspaceId);
    const located = await tx.workspaceInvitation.findFirst({ where: { workspaceId, invitedById: actor.id, requestKey: parsed.requestKey }, select: { id: true, projectId: true } });
    const projectIds = [...new Set([projectId, located?.projectId].filter((value): value is string => typeof value === "string" && UUID_PATTERN.test(value)))].sort();
    for (const candidateProjectId of projectIds) await lockProjectAccess(tx, candidateProjectId);
    if (located !== null) await lockWorkspaceInvitationAccess(tx, located.id);
    const currentActor = await tx.appUser.findUnique({ where: { id: actor.id }, select: { id: true, disabledAt: true, accountAccessVersion: true } });
    if (currentActor === null || currentActor.disabledAt !== null || currentActor.accountAccessVersion !== actor.accountAccessVersion) throw new AccessControlError("ACCOUNT_ACCESS_STALE");
    await assertWorkspaceAdmin(actor, workspaceId, tx);
    if (projectId !== null) await assertProjectsInWorkspace(workspaceId, [{ projectId }], tx);
    const existing = await tx.workspaceInvitation.findFirst({ where: { workspaceId, invitedById: actor.id, requestKey: parsed.requestKey }, select: { id: true, email: true, workspaceRole: true, projectId: true, projectRole: true, expiresAt: true, acceptedAt: true, revokedAt: true, version: true, createdAt: true, requestFingerprint: true } });
    if (existing !== null) {
      if (!sameFingerprint(existing.requestFingerprint, requestFingerprint)) return fail("WORKSPACE_INVITATION_IDEMPOTENCY_CONFLICT");
      return Object.freeze({ invitation: existing, token: null, alreadyCreated: true });
    }
    const token = randomBytes(32).toString("base64url");
    const invitation = await tx.workspaceInvitation.create({
      data: { workspaceId, email: normalizedEmail, tokenHash: hashToken(token), requestKey: parsed.requestKey, requestFingerprint, workspaceRole: parsed.workspaceRole, projectId, projectRole, invitedById: actor.id, expiresAt: new Date(Date.now() + parsed.expiresInDays * 86_400_000) },
      select: { id: true, email: true, workspaceRole: true, projectId: true, projectRole: true, expiresAt: true, acceptedAt: true, revokedAt: true, version: true, createdAt: true, requestFingerprint: true },
    });
    return Object.freeze({ invitation, token, alreadyCreated: false });
  });
  return Object.freeze({ invitation: result.invitation, alreadyCreated: result.alreadyCreated, token: result.token, acceptPath: result.token === null ? null : `/accept-invitation?token=${encodeURIComponent(result.token)}` });
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
      select: { id: true, email: true, workspaceRole: true, projectId: true, projectRole: true, expiresAt: true, acceptedAt: true, revokedAt: true, version: true, createdAt: true, project: { select: { name: true } }, invitedBy: { select: { username: true } } },
    });
  });
}

export async function acceptWorkspaceInvitation(
  tokenInput: unknown,
  actor: Pick<AppUser, "id" | "accountAccessVersion"> & Partial<Pick<AppUser, "email">>,
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
    // Historical invitations may still carry an elevated workspace role even
    // though new invitations are schema-restricted to member/viewer. They
    // must be closed rather than becoming an implicit role-mutation bypass.
    if (invitation.workspaceRole === "owner" || invitation.workspaceRole === "admin" || invitation.projectRole === "owner") return fail("WORKSPACE_ROLE_GOVERNANCE_REQUIRED");
    const currentActor = await tx.appUser.findUnique({ where: { id: actorId }, select: { id: true, email: true, emailVerifiedAt: true, disabledAt: true, accountAccessVersion: true } });
    if (currentActor === null || currentActor.disabledAt !== null) throw new AccessControlError("ACCESS_FORBIDDEN");
    if (currentActor.accountAccessVersion !== actor.accountAccessVersion) throw new AccessControlError("ACCOUNT_ACCESS_STALE");
    if (currentActor.emailVerifiedAt === null) return fail("WORKSPACE_INVITATION_EMAIL_UNVERIFIED");
    if (invitation.email === null || invitation.email !== currentActor.email?.toLowerCase()) return fail("WORKSPACE_INVITATION_EMAIL_MISMATCH");
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
      if (currentWorkspaceMembership !== null && currentWorkspaceMembership.accessState === MembershipAccessState.confirmed
        && (currentProjectMembership === null || projectRoleRank[invitation.projectRole] > projectRoleRank[currentProjectMembership.role])) {
        return fail("WORKSPACE_INVITATION_EXISTING_MEMBER");
      }
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
    await tx.workspaceInvitation.update({ where: { id: invitation.id }, data: { acceptedById: actorId, acceptedAt: new Date(), version: { increment: 1 } } });
    return Object.freeze({ workspaceId: invitation.workspaceId, returnTo });
  });
}

export async function getWorkspaceInvitationImpact(
  workspaceIdInput: unknown,
  invitationIdInput: unknown,
  actor: AccessUser,
  db: PrismaClient = getDb(),
) {
  const workspaceId = uuid(workspaceIdInput);
  const invitationId = uuid(invitationIdInput);
  return db.$transaction(async (tx) => {
    await lockActorsAccess(tx, [actor.id]);
    await lockWorkspaceAccess(tx, workspaceId);
    const located = await tx.workspaceInvitation.findUnique({ where: { id: invitationId }, select: { id: true, workspaceId: true, projectId: true } });
    if (located === null || located.workspaceId !== workspaceId) return fail("WORKSPACE_INVITATION_NOT_FOUND");
    if (located.projectId !== null) await lockProjectAccess(tx, located.projectId);
    await lockWorkspaceInvitationAccess(tx, invitationId);
    const currentActor = await tx.appUser.findUnique({ where: { id: actor.id }, select: { id: true, disabledAt: true, accountAccessVersion: true } });
    if (currentActor === null || currentActor.disabledAt !== null || currentActor.accountAccessVersion !== actor.accountAccessVersion) throw new AccessControlError("ACCOUNT_ACCESS_STALE");
    await assertWorkspaceAdmin(actor, workspaceId, tx);
    const invitation = await tx.workspaceInvitation.findUnique({ where: { id: invitationId }, select: { id: true, workspaceId: true, email: true, workspaceRole: true, projectId: true, projectRole: true, acceptedAt: true, revokedAt: true, expiresAt: true, version: true } });
    if (invitation === null || invitation.workspaceId !== workspaceId) return fail("WORKSPACE_INVITATION_NOT_FOUND");
    const currentMember = invitation.email === null ? false : await findConfirmedWorkspaceMembershipByEmail(tx, workspaceId, invitation.email);
    const projectGrant = invitation.projectId === null || invitation.email === null ? false : await findConfirmedProjectMembershipByEmail(tx, invitation.projectId, invitation.email);
    return invitationImpact(invitation, { existingMember: currentMember, projectGrant });
  });
}

export async function revokeWorkspaceInvitation(
  workspaceIdInput: unknown,
  invitationIdInput: unknown,
  input: unknown,
  actor: AccessUser,
  db: PrismaClient = getDb(),
) {
  const workspaceId = uuid(workspaceIdInput);
  const invitationId = uuid(invitationIdInput);
  const raw = typeof input === "object" && input !== null ? input as { reason?: unknown } : null;
  if (typeof raw?.reason !== "string" || raw.reason.trim().length === 0) return fail("WORKSPACE_INVITATION_REASON_REQUIRED");
  const parsed = revokeInvitationSchema.parse({ ...(input as object), reason: raw.reason.trim() });
  safeAuditText(parsed.reason);
  safeAuditText(parsed.requestKey);
  const requestFingerprint = invitationRevokeFingerprint({ ...parsed, invitationId });
  return db.$transaction(async (tx) => {
    await lockActorsAccess(tx, [actor.id]);
    await lockWorkspaceAccess(tx, workspaceId);
    const located = await tx.workspaceInvitation.findUnique({ where: { id: invitationId }, select: { id: true, workspaceId: true, projectId: true } });
    if (located === null || located.workspaceId !== workspaceId) return fail("WORKSPACE_INVITATION_NOT_FOUND");
    if (located.projectId !== null) await lockProjectAccess(tx, located.projectId);
    await lockWorkspaceInvitationAccess(tx, invitationId);
    const currentActor = await tx.appUser.findUnique({ where: { id: actor.id }, select: { id: true, disabledAt: true, accountAccessVersion: true } });
    if (currentActor === null || currentActor.disabledAt !== null || currentActor.accountAccessVersion !== actor.accountAccessVersion) throw new AccessControlError("ACCOUNT_ACCESS_STALE");
    await assertWorkspaceAdmin(actor, workspaceId, tx);
    const existing = await tx.workspaceInvitation.findUnique({ where: { id: invitationId }, select: { id: true, workspaceId: true, email: true, workspaceRole: true, projectId: true, projectRole: true, acceptedAt: true, revokedAt: true, expiresAt: true, version: true, revocationRequestKey: true, revocationRequestFingerprint: true } });
    if (existing === null || existing.workspaceId !== workspaceId) return fail("WORKSPACE_INVITATION_NOT_FOUND");
    if (existing.revocationRequestKey === parsed.requestKey) {
      if (!sameFingerprint(existing.revocationRequestFingerprint, requestFingerprint)) return fail("WORKSPACE_INVITATION_IDEMPOTENCY_CONFLICT");
      return Object.freeze({ invitation: existing, alreadyRevoked: true });
    }
    if (existing.acceptedAt !== null || existing.revokedAt !== null || invitationStatus(existing) !== "pending") return fail("WORKSPACE_INVITATION_STATE_CONFLICT");
    const currentImpact = await getInvitationImpactInsideTransaction(tx, existing, workspaceId);
    if (existing.version !== parsed.expectedVersion || currentImpact.impactFingerprint !== parsed.expectedImpactFingerprint) return fail("WORKSPACE_INVITATION_IMPACT_STALE");
    const now = new Date();
    const invitation = await tx.workspaceInvitation.update({
      where: { id: invitationId },
      data: { revokedAt: now, revokedById: actor.id, revocationReason: parsed.reason, revocationRequestKey: parsed.requestKey, revocationRequestFingerprint: requestFingerprint, revocationImpactFingerprint: currentImpact.impactFingerprint, version: { increment: 1 } },
      select: { id: true, email: true, workspaceRole: true, projectId: true, projectRole: true, expiresAt: true, acceptedAt: true, revokedAt: true, version: true, createdAt: true },
    });
    return Object.freeze({ invitation, alreadyRevoked: false });
  }).catch((error) => {
    if (isPrismaCode(error, "P2002")) return fail("WORKSPACE_INVITATION_IDEMPOTENCY_CONFLICT");
    throw error;
  });
}

async function findConfirmedWorkspaceMembershipByEmail(db: PrismaClient | Prisma.TransactionClient, workspaceId: string, invitationEmail: string): Promise<boolean> {
  const count = await db.workspaceMembership.count({ where: { workspaceId, accessState: "confirmed", user: { email: invitationEmail } } });
  return count > 0;
}

async function findConfirmedProjectMembershipByEmail(db: PrismaClient | Prisma.TransactionClient, projectId: string, invitationEmail: string): Promise<boolean> {
  const count = await db.projectMembership.count({ where: { projectId, accessState: "confirmed", user: { email: invitationEmail } } });
  return count > 0;
}

async function getInvitationImpactInsideTransaction(
  tx: Prisma.TransactionClient,
  invitation: Readonly<{ id: string; workspaceId: string; email: string | null; workspaceRole: WorkspaceMembershipRole; projectId: string | null; projectRole: ProjectMembershipRole | null; acceptedAt: Date | null; revokedAt: Date | null; expiresAt: Date; version: number }>,
  workspaceId: string,
) {
  const existingMember = invitation.email === null ? false : await findConfirmedWorkspaceMembershipByEmail(tx, workspaceId, invitation.email);
  const projectGrant = invitation.projectId === null || invitation.email === null ? false : await findConfirmedProjectMembershipByEmail(tx, invitation.projectId, invitation.email);
  return invitationImpact(invitation, { existingMember, projectGrant });
}

export function asProjectRole(value: string): ProjectMembershipRole {
  return projectRoleSchema.parse(value);
}
