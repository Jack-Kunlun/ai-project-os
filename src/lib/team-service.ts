import {
  MembershipAccessAuditMembershipKind,
  Prisma,
  type PrismaClient,
  type WorkspaceMembershipRole,
  type ProjectMembershipRole,
} from "@prisma/client";
import { AccountAccessGuardError, assertAccountAccessForActor } from "@/lib/account-access-guard";
import { AccessControlError, accessibleProjectWhere, type AccessUser } from "@/lib/access-control";
import { lockActorAccess, lockProjectAccess, lockWorkspaceAccess } from "@/lib/access-linearization";
import { getDb } from "@/lib/db";
import { findConfirmedWorkspaceMembership } from "@/lib/membership-governance";

type TeamDb = PrismaClient | Prisma.TransactionClient;

const PROJECT_SELECT = {
  id: true,
  name: true,
  slug: true,
  description: true,
  archivedAt: true,
  updatedAt: true,
  _count: {
    select: {
      sources: { where: { retiredAt: null } },
      items: { where: { reviewStatus: "confirmed" } },
    },
  },
} as const satisfies Prisma.ProjectSelect;

const MEMBER_PREVIEW_SELECT = {
  userId: true,
  role: true,
  user: { select: { username: true, displayName: true } },
} as const satisfies Prisma.WorkspaceMembershipSelect;

const MAX_ACTIVITY_LIMIT = 50;
const MAX_TEAM_PROJECTION = 100;
const MAX_PROJECT_PROJECTION = 100;
const MAX_PROJECT_LOCKS = 1_000;

type TeamTransaction = Prisma.TransactionClient;

export type TeamProject = Prisma.ProjectGetPayload<{ select: typeof PROJECT_SELECT }>;

export type TeamSummary = Readonly<{
  workspace: Readonly<{ id: string; name: string; slug: string }>;
  role: WorkspaceMembershipRole;
  counts: Readonly<{ memberships: number; projects: number }>;
}>;

export type TeamOverview = Readonly<{
  workspace: Readonly<{ id: string; name: string; slug: string }>;
  role: WorkspaceMembershipRole;
  counts: Readonly<{ memberships: number; projects: number }>;
  members: ReadonlyArray<Readonly<{
    userId: string;
    role: WorkspaceMembershipRole;
    username: string;
    displayName: string | null;
  }>>;
  projects: ReadonlyArray<TeamProject>;
}>;

export type TeamPermission = Readonly<{
  project: Readonly<{ id: string; name: string; slug: string }>;
  permission: ProjectMembershipRole;
  source: "workspace-role" | "project-grant";
}>;

export type TeamActivity = Readonly<{
  id: string;
  kind: "membership" | "invitation" | "role";
  label: string;
  createdAt: string;
  project: Readonly<{ id: string; name: string }> | null;
}>;

function fail(code: "ACCESS_FORBIDDEN" | "ACCOUNT_DISABLED" | "ACCOUNT_ACCESS_STALE"): never {
  throw new AccessControlError(code);
}

async function assertActiveAccount(actor: AccessUser, db: TeamDb): Promise<void> {
  try {
    await assertAccountAccessForActor(db, actor);
  } catch (error) {
    if (error instanceof AccountAccessGuardError && error.code === "ACCOUNT_DISABLED") return fail("ACCOUNT_DISABLED");
    if (error instanceof AccountAccessGuardError && error.code === "ACCOUNT_ACCESS_STALE") return fail("ACCOUNT_ACCESS_STALE");
    return fail("ACCESS_FORBIDDEN");
  }
}

async function personalWorkspaceId(actor: AccessUser, db: TeamDb): Promise<string | null> {
  const workspace = await db.workspace.findUnique({
    where: { slug: `user-${actor.id}` },
    select: { id: true, createdById: true },
  });
  // A slug collision owned by another account is a real team and must not be
  // hidden just because its name looks like a personal workspace slug.
  return workspace?.createdById === actor.id ? workspace.id : null;
}

async function requireTeamMembership(actor: AccessUser, workspaceId: string, db: TeamDb): Promise<Readonly<{ role: WorkspaceMembershipRole; workspace: { id: string; name: string; slug: string } }>> {
  await assertActiveAccount(actor, db);
  const membership = await findConfirmedWorkspaceMembership(db, workspaceId, actor.id);
  if (membership === null) return fail("ACCESS_FORBIDDEN");
  const workspace = await db.workspace.findUnique({ where: { id: workspaceId }, select: { id: true, name: true, slug: true, createdById: true } });
  if (workspace === null) return fail("ACCESS_FORBIDDEN");
  // Project collaborators may belong to somebody else's personal workspace.
  // Its team controls remain limited to confirmed workspace owners and admins.
  if (workspace.createdById !== null && workspace.slug === `user-${workspace.createdById}`
    && membership.role !== "owner" && membership.role !== "admin") return fail("ACCESS_FORBIDDEN");
  return { role: membership.role, workspace: { id: workspace.id, name: workspace.name, slug: workspace.slug } };
}

function projectWhere(actor: AccessUser, workspaceId: string): Prisma.ProjectWhereInput {
  return { AND: [accessibleProjectWhere(actor), { workspaceId }] };
}

/**
 * Team projections share the same actor -> workspace -> project advisory lock
 * order as access mutations.  The fallback keeps service-level unit doubles
 * useful; real Prisma clients always enter a transaction and expose
 * `$executeRaw` for the fence.
 */
async function withTeamReadTransaction<T>(db: TeamDb, callback: (tx: TeamDb) => Promise<T>): Promise<T> {
  const transaction = (db as unknown as { $transaction?: unknown }).$transaction;
  if (typeof transaction !== "function") return callback(db);
  return (db as PrismaClient).$transaction(
    (tx) => callback(tx),
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
  );
}

function canTakeAdvisoryLock(db: TeamDb): db is TeamTransaction {
  return typeof (db as unknown as { $executeRaw?: unknown }).$executeRaw === "function";
}

async function lockTeamActor(db: TeamDb, actorId: string): Promise<void> {
  if (canTakeAdvisoryLock(db)) await lockActorAccess(db, actorId);
}

async function lockTeamWorkspaces(db: TeamDb, workspaceIds: readonly string[]): Promise<void> {
  if (!canTakeAdvisoryLock(db)) return;
  for (const workspaceId of [...new Set(workspaceIds)].sort()) await lockWorkspaceAccess(db, workspaceId);
}

async function lockTeamProjects(db: TeamDb, projectIds: readonly string[]): Promise<void> {
  if (!canTakeAdvisoryLock(db)) return;
  for (const projectId of [...new Set(projectIds)].sort()) await lockProjectAccess(db, projectId);
}

async function visibleProjectIds(actor: AccessUser, workspaceIds: readonly string[], db: TeamDb): Promise<readonly string[]> {
  if (workspaceIds.length === 0) return [];
  const rows = await db.project.findMany({
    where: { AND: [accessibleProjectWhere(actor), { workspaceId: { in: [...workspaceIds] } }] },
    orderBy: [{ id: "asc" }],
    take: MAX_PROJECT_LOCKS,
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

async function visibleProjectIdsForWorkspace(
  actor: AccessUser,
  workspaceId: string,
  db: TeamDb,
  orderBy: Prisma.ProjectOrderByWithRelationInput[],
): Promise<readonly string[]> {
  const rows = await db.project.findMany({ where: projectWhere(actor, workspaceId), orderBy, take: MAX_PROJECT_PROJECTION, select: { id: true } });
  return rows.map((row) => row.id);
}

export async function listTeams(actor: AccessUser, db: TeamDb = getDb()): Promise<ReadonlyArray<TeamSummary>> {
  return withTeamReadTransaction(db, async (tx) => {
    await lockTeamActor(tx, actor.id);
    await assertActiveAccount(actor, tx);
    const personalId = await personalWorkspaceId(actor, tx);
    const candidateMemberships = await tx.workspaceMembership.findMany({
      where: {
        userId: actor.id,
        accessState: "confirmed",
        ...(personalId === null ? {} : { workspaceId: { not: personalId } }),
      },
      orderBy: [{ workspace: { name: "asc" } }, { workspaceId: "asc" }],
      take: MAX_TEAM_PROJECTION,
      select: { workspaceId: true },
    });
    const candidateWorkspaceIds = candidateMemberships.map((membership) => membership.workspaceId);
    await lockTeamWorkspaces(tx, candidateWorkspaceIds);
    await lockTeamProjects(tx, await visibleProjectIds(actor, candidateWorkspaceIds, tx));

    // Re-read every authorization fence after the shared locks. No membership
    // or account revoke can commit until this transaction releases them.
    await assertActiveAccount(actor, tx);
    const finalPersonalId = await personalWorkspaceId(actor, tx);
    const memberships = await tx.workspaceMembership.findMany({
      where: {
        userId: actor.id,
        accessState: "confirmed",
        ...(finalPersonalId === null ? {} : { workspaceId: { not: finalPersonalId } }),
      },
      orderBy: [{ workspace: { name: "asc" } }, { workspaceId: "asc" }],
      take: MAX_TEAM_PROJECTION,
      select: { workspaceId: true, role: true, workspace: { select: { id: true, name: true, slug: true } } },
    });
    if (memberships.length === 0) return [];
    const workspaceIds = memberships.map((membership) => membership.workspaceId);
    const [projectCounts, memberCounts] = await Promise.all([
      tx.project.groupBy({ by: ["workspaceId"], where: { AND: [accessibleProjectWhere(actor), { workspaceId: { in: workspaceIds } }] }, _count: { _all: true } }),
      tx.workspaceMembership.groupBy({ by: ["workspaceId"], where: { workspaceId: { in: workspaceIds }, accessState: "confirmed" }, _count: { _all: true } }),
    ]);
    const projectsByWorkspace = new Map(projectCounts.map((row) => [row.workspaceId, row._count._all]));
    const membersByWorkspace = new Map(memberCounts.map((row) => [row.workspaceId, row._count._all]));
    return memberships.map((membership) => ({
      workspace: membership.workspace,
      role: membership.role,
      counts: { memberships: membersByWorkspace.get(membership.workspaceId) ?? 0, projects: projectsByWorkspace.get(membership.workspaceId) ?? 0 },
    }));
  });
}

export async function getTeamOverview(actor: AccessUser, workspaceId: string, db: TeamDb = getDb()): Promise<TeamOverview> {
  return withTeamReadTransaction(db, async (tx) => {
    await lockTeamActor(tx, actor.id);
    await assertActiveAccount(actor, tx);
    await lockTeamWorkspaces(tx, [workspaceId]);
    await requireTeamMembership(actor, workspaceId, tx);
    const projectIds = await visibleProjectIdsForWorkspace(actor, workspaceId, tx, [{ updatedAt: "desc" }, { id: "desc" }]);
    await lockTeamProjects(tx, projectIds);

    // Membership, account and project access are all checked again while the
    // actor/workspace/project locks remain held through the projection reads.
    const finalAccess = await requireTeamMembership(actor, workspaceId, tx);
    const projectScope = projectWhere(actor, workspaceId);
    const [finalMemberships, finalMembershipCount, finalProjectCount, finalProjectIds, projects] = await Promise.all([
      tx.workspaceMembership.findMany({ where: { workspaceId, accessState: "confirmed" }, orderBy: [{ role: "asc" }, { createdAt: "asc" }], take: 100, select: MEMBER_PREVIEW_SELECT }),
      tx.workspaceMembership.count({ where: { workspaceId, accessState: "confirmed" } }),
      tx.project.count({ where: projectScope }),
      tx.project.findMany({ where: projectScope, orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take: MAX_PROJECT_PROJECTION, select: { id: true } }),
      tx.project.findMany({ where: projectScope, orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take: MAX_PROJECT_PROJECTION, select: PROJECT_SELECT }),
    ]);
    const finalProjectIdSet = new Set(finalProjectIds.map((project) => project.id));
    return {
      workspace: finalAccess.workspace,
      role: finalAccess.role,
      counts: { memberships: finalMembershipCount, projects: finalProjectCount },
      members: finalMemberships.map((membership) => ({ userId: membership.userId, role: membership.role, username: membership.user.username, displayName: membership.user.displayName })),
      projects: projects.filter((project) => finalProjectIdSet.has(project.id)),
    };
  });
}

function projectPermissionFor(role: WorkspaceMembershipRole, project: Readonly<{ membershipInheritanceMode: "workspaceInherited" | "projectOnly" }>, direct: ProjectMembershipRole | null): Readonly<{ permission: ProjectMembershipRole; source: "workspace-role" | "project-grant" }> | null {
  if ((role === "owner" || role === "admin") && project.membershipInheritanceMode === "workspaceInherited") return { permission: "owner", source: "workspace-role" };
  if (direct === null) return null;
  return { permission: direct, source: "project-grant" };
}

export async function getTeamPermissions(actor: AccessUser, workspaceId: string, db: TeamDb = getDb()): Promise<Readonly<{ workspace: Readonly<{ id: string; name: string; slug: string }>; role: WorkspaceMembershipRole; projects: ReadonlyArray<TeamPermission> }>> {
  return withTeamReadTransaction(db, async (tx) => {
    await lockTeamActor(tx, actor.id);
    await assertActiveAccount(actor, tx);
    await lockTeamWorkspaces(tx, [workspaceId]);
    await requireTeamMembership(actor, workspaceId, tx);
    await lockTeamProjects(tx, await visibleProjectIdsForWorkspace(actor, workspaceId, tx, [{ name: "asc" }, { id: "asc" }]));

    // This is intentionally the caller's own effective permission view. It
    // never enumerates another member's grants or returns raw grant history.
    const finalAccess = await requireTeamMembership(actor, workspaceId, tx);
    const finalProjects = await tx.project.findMany({ where: projectWhere(actor, workspaceId), orderBy: [{ name: "asc" }, { id: "asc" }], take: 100, select: { id: true, name: true, slug: true, membershipInheritanceMode: true } });
    const finalDirectMemberships = finalProjects.length === 0 ? [] : await tx.projectMembership.findMany({ where: { userId: actor.id, accessState: "confirmed", projectId: { in: finalProjects.map((project) => project.id) } }, select: { projectId: true, role: true } });
    const finalDirectByProject = new Map(finalDirectMemberships.map((membership) => [membership.projectId, membership.role]));
    return {
      workspace: finalAccess.workspace,
      role: finalAccess.role,
      projects: finalProjects.flatMap((project) => {
        const permission = projectPermissionFor(finalAccess.role, project, finalDirectByProject.get(project.id) ?? null);
        return permission === null ? [] : [{ project: { id: project.id, name: project.name, slug: project.slug }, ...permission }];
      }),
    };
  });
}

function membershipLabel(kind: MembershipAccessAuditMembershipKind, action: string): string {
  if (kind === MembershipAccessAuditMembershipKind.project) return action === "revoked" ? "项目访问已撤销" : action === "confirmed" ? "项目访问已授予" : "项目访问记录已更新";
  return action === "revoked" ? "团队成员访问已撤销" : action === "confirmed" ? "团队成员已加入" : "团队成员关系已更新";
}

function invitationLabel(event: string): string {
  return event === "accepted" ? "团队邀请已接受" : event === "revoked" ? "团队邀请已撤销" : "团队邀请已创建";
}

type TeamMembershipAuditRow = Readonly<{
  id: string;
  membershipKind: MembershipAccessAuditMembershipKind;
  action: string;
  projectId: string | null;
  createdAt: Date;
}>;

/**
 * Filter project audit rows in SQL before applying the activity page limit.
 * MembershipAccessAudit intentionally has no Prisma relation to Project, so
 * the raw query keeps the join and the access predicate in one statement.
 * Workspace audit rows remain visible without a project join.
 */
async function findVisibleMembershipAudits(
  actor: AccessUser,
  workspaceId: string,
  db: TeamDb,
  limit: number,
): Promise<readonly TeamMembershipAuditRow[]> {
  const queryRawMethod = (db as unknown as {
    $queryRaw?: <T>(query: Prisma.Sql) => Promise<readonly T[]>;
  }).$queryRaw;
  if (typeof queryRawMethod === "function") {
    const queryRaw = queryRawMethod.bind(db);
    return queryRaw<TeamMembershipAuditRow>(Prisma.sql`
      SELECT
        audit."id",
        audit."membershipKind",
        audit."action",
        audit."projectId",
        audit."createdAt"
      FROM "MembershipAccessAudit" AS audit
      LEFT JOIN "Project" AS project
        ON project."id" = audit."projectId"
       AND audit."membershipKind" = 'project'::"MembershipAccessAuditMembershipKind"
      WHERE audit."workspaceId" = ${workspaceId}::uuid
        AND (
          audit."membershipKind" = 'workspace'::"MembershipAccessAuditMembershipKind"
          OR (
            audit."membershipKind" = 'project'::"MembershipAccessAuditMembershipKind"
            AND project."workspaceId" = ${workspaceId}::uuid
            AND (
              (
                project."membershipInheritanceMode" = 'workspace_inherited'::"ProjectMembershipInheritanceMode"
                AND EXISTS (
                  SELECT 1
                  FROM "WorkspaceMembership" AS inherited_membership
                  WHERE inherited_membership."workspaceId" = project."workspaceId"
                    AND inherited_membership."userId" = ${actor.id}::uuid
                    AND inherited_membership."accessState" = 'confirmed'::"MembershipAccessState"
                    AND inherited_membership."role" IN ('owner'::"WorkspaceMembershipRole", 'admin'::"WorkspaceMembershipRole")
                )
              )
              OR EXISTS (
                SELECT 1
                FROM "ProjectMembership" AS direct_membership
                WHERE direct_membership."projectId" = project."id"
                  AND direct_membership."userId" = ${actor.id}::uuid
                  AND direct_membership."accessState" = 'confirmed'::"MembershipAccessState"
              )
            )
          )
        )
      ORDER BY audit."createdAt" DESC, audit."id" DESC
      LIMIT ${limit}
    `);
  }

  // Unit doubles do not expose $queryRaw. Keep their fallback access-scoped
  // and bounded; real Prisma clients always use the SQL branch above.
  const visibleProjectIds = await visibleProjectIdsForWorkspace(actor, workspaceId, db, [{ id: "asc" }]);
  return db.membershipAccessAudit.findMany({
    where: {
      workspaceId,
      OR: [
        { membershipKind: MembershipAccessAuditMembershipKind.workspace },
        { membershipKind: MembershipAccessAuditMembershipKind.project, projectId: { in: [...visibleProjectIds] } },
      ],
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit,
    select: { id: true, membershipKind: true, action: true, projectId: true, createdAt: true },
  });
}

export async function getTeamActivity(actor: AccessUser, workspaceId: string, limit = 30, db: TeamDb = getDb()): Promise<Readonly<{ workspace: Readonly<{ id: string; name: string; slug: string }>; role: WorkspaceMembershipRole; activity: ReadonlyArray<TeamActivity> }>> {
  const safeLimit = Math.min(Math.max(Number.isSafeInteger(limit) ? limit : 30, 1), MAX_ACTIVITY_LIMIT);
  return withTeamReadTransaction(db, async (tx) => {
    await lockTeamActor(tx, actor.id);
    await assertActiveAccount(actor, tx);
    await lockTeamWorkspaces(tx, [workspaceId]);
    await requireTeamMembership(actor, workspaceId, tx);
    const candidateProjectAudits = await findVisibleMembershipAudits(actor, workspaceId, tx, MAX_ACTIVITY_LIMIT);
    const candidateProjectIds = candidateProjectAudits.flatMap((row) => row.membershipKind === MembershipAccessAuditMembershipKind.project && row.projectId !== null ? [row.projectId] : []);
    await lockTeamProjects(tx, candidateProjectIds);

    const finalAccess = await requireTeamMembership(actor, workspaceId, tx);
    const projectScope = projectWhere(actor, workspaceId);
    const [membershipAudits, invitationAudits, roleAudits] = await Promise.all([
      findVisibleMembershipAudits(actor, workspaceId, tx, MAX_ACTIVITY_LIMIT),
      tx.workspaceInvitationAudit.findMany({ where: { workspaceId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: MAX_ACTIVITY_LIMIT, select: { id: true, event: true, createdAt: true } }),
      tx.workspaceRoleMutationAudit.findMany({ where: { workspaceId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: MAX_ACTIVITY_LIMIT, select: { id: true, event: true, createdAt: true } }),
    ]);
    const finalProjectIds = [...new Set(membershipAudits.flatMap((row) => row.membershipKind === MembershipAccessAuditMembershipKind.project && row.projectId !== null ? [row.projectId] : []))];
    const finalVisibleProjects = finalProjectIds.length === 0
      ? []
      : await tx.project.findMany({ where: { AND: [projectScope, { id: { in: finalProjectIds } }] }, take: MAX_PROJECT_PROJECTION, select: { id: true, name: true } });
    const finalProjectNames = new Map(finalVisibleProjects.map((project) => [project.id, project.name]));
    const activity: TeamActivity[] = [
      ...membershipAudits.flatMap((row) => {
        const isProjectAudit = row.membershipKind === MembershipAccessAuditMembershipKind.project;
        // A private project audit is omitted altogether. Returning its generic
        // label or timestamp would still disclose that the project exists.
        if (isProjectAudit && (row.projectId === null || !finalProjectNames.has(row.projectId))) return [];
        return [{ id: row.id, kind: "membership" as const, label: membershipLabel(row.membershipKind, row.action), createdAt: row.createdAt.toISOString(), project: isProjectAudit ? { id: row.projectId!, name: finalProjectNames.get(row.projectId!)! } : null }];
      }),
      ...invitationAudits.map((row) => ({ id: row.id, kind: "invitation" as const, label: invitationLabel(row.event), createdAt: row.createdAt.toISOString(), project: null })),
      ...roleAudits.map((row) => ({ id: row.id, kind: "role" as const, label: row.event === "roleChanged" ? "团队角色已调整" : "团队角色记录已更新", createdAt: row.createdAt.toISOString(), project: null })),
    ];
    activity.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
    return { workspace: finalAccess.workspace, role: finalAccess.role, activity: activity.slice(0, safeLimit) };
  });
}
