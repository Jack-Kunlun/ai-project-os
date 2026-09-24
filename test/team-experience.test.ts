import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import { AccessControlError } from "../src/lib/access-control";
import { getTeamOverview, listTeams } from "../src/lib/team-service";

const actorId = "11111111-1111-4111-8111-111111111111";
const personalId = "22222222-2222-4222-8222-222222222222";
const teamId = "33333333-3333-4333-8333-333333333333";
const projectId = "44444444-4444-4444-8444-444444444444";

test("team list excludes only the caller-owned personal workspace and scopes project counts", async () => {
  let membershipWhere: Record<string, unknown> | undefined;
  let projectWhere: Record<string, unknown> | undefined;
  const db = {
    appUser: { findUnique: async () => ({ id: actorId, disabledAt: null, accountAccessVersion: 1 }) },
    workspace: {
      findUnique: async () => ({ id: personalId, createdById: actorId }),
    },
    workspaceMembership: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        membershipWhere = where;
        return [{ workspaceId: teamId, role: "member", workspace: { id: teamId, name: "Design team", slug: "design" } }];
      },
      groupBy: async () => [{ workspaceId: teamId, _count: { _all: 2 } }],
    },
    project: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        projectWhere = where;
        return [{ id: projectId, workspaceId: teamId }];
      },
      groupBy: async () => [{ workspaceId: teamId, _count: { _all: 1 } }],
    },
  } as unknown as PrismaClient;

  const teams = await listTeams({ id: actorId, role: "user", accountAccessVersion: 1 }, db);
  assert.deepEqual(teams, [{ workspace: { id: teamId, name: "Design team", slug: "design" }, role: "member", counts: { memberships: 2, projects: 1 } }]);
  assert.deepEqual((membershipWhere?.workspaceId as { not: string }).not, personalId);
  const scopedWhere = projectWhere?.AND as Array<Record<string, unknown>>;
  assert.deepEqual(scopedWhere[1]?.workspaceId, { in: [teamId] });
  assert.ok(Array.isArray((scopedWhere[0]?.OR)), "project projection must retain the shared access predicate");
});

test("personal workspace team controls require an owner or admin", async () => {
  const makeDb = (role: "owner" | "admin" | "member", userId = actorId) => ({
    appUser: { findUnique: async () => ({ id: userId, disabledAt: null, accountAccessVersion: 1 }) },
    workspace: { findUnique: async () => ({ id: personalId, name: "个人工作台", slug: `user-${actorId}`, createdById: actorId }) },
    workspaceMembership: {
      findMany: async ({ where }: { where: { userId?: string } }) => where.userId
        ? [{ id: "55555555-5555-4555-8555-555555555555", workspaceId: personalId, userId, role, accessState: "confirmed", createdAt: new Date(), updatedAt: new Date() }]
        : [],
      count: async () => 1,
    },
    project: { findMany: async () => [], count: async () => 0 },
  }) as unknown as PrismaClient;
  const actor = { id: actorId, role: "user" as const, accountAccessVersion: 1 };
  const overview = await getTeamOverview(actor, personalId, makeDb("owner"));
  assert.equal(overview.role, "owner");
  assert.equal(overview.workspace.id, personalId);
  await assert.rejects(
    () => getTeamOverview(actor, personalId, makeDb("member")),
    (error: unknown) => error instanceof AccessControlError && error.code === "ACCESS_FORBIDDEN",
  );
  const collaboratorId = "66666666-6666-4666-8666-666666666666";
  const collaborator = { id: collaboratorId, role: "user" as const, accountAccessVersion: 1 };
  await assert.rejects(
    () => getTeamOverview(collaborator, personalId, makeDb("member", collaboratorId)),
    (error: unknown) => error instanceof AccessControlError && error.code === "ACCESS_FORBIDDEN",
  );
  const delegatedAdmin = await getTeamOverview(collaborator, personalId, makeDb("admin", collaboratorId));
  assert.equal(delegatedAdmin.role, "admin");
});

test("team routes and UI expose useful member views while keeping activity on approved audit sources", async () => {
  const [service, listRoute, overviewRoute, permissionsRoute, activityRoute, page, client] = await Promise.all([
    readFile("src/lib/team-service.ts", "utf8"),
    readFile("src/app/api/teams/route.ts", "utf8"),
    readFile("src/app/api/teams/[workspaceId]/overview/route.ts", "utf8"),
    readFile("src/app/api/teams/[workspaceId]/permissions/route.ts", "utf8"),
    readFile("src/app/api/teams/[workspaceId]/activity/route.ts", "utf8"),
    readFile("src/app/team/[workspaceId]/page.tsx", "utf8"),
    readFile("src/app/team/team-client.tsx", "utf8"),
  ]);
  assert.match(service, /accessState: "confirmed"/u);
  assert.match(service, /accessibleProjectWhere/u);
  assert.match(service, /withTeamReadTransaction/u);
  assert.match(service, /lockActorAccess/u);
  assert.match(service, /lockWorkspaceAccess/u);
  assert.match(service, /lockProjectAccess/u);
  assert.match(service, /membershipAccessAudit/u);
  assert.match(service, /workspaceInvitationAudit/u);
  assert.match(service, /workspaceRoleMutationAudit/u);
  assert.match(service, /isProjectAudit/u);
  assert.match(service, /finalProjectNames\.has/u);
  assert.match(service, /return \[\]/u);
  assert.doesNotMatch(service, /systemAudit/u);
  assert.match(service, /projectMembership\.findMany\(\{ where: \{ userId: actor\.id/u);
  assert.match(listRoute, /listTeams/u);
  assert.match(overviewRoute, /getTeamOverview/u);
  assert.match(permissionsRoute, /getTeamPermissions/u);
  assert.match(activityRoute, /getTeamActivity/u);
  assert.match(page, /WorkspaceTeamClient/u);
  assert.match(client, /团队总览/u);
  assert.match(client, /我的权限/u);
  assert.match(client, /活动记录/u);
  assert.match(client, /成员与角色/u);
  assert.match(client, /\/api\/teams/u);
});

test("disabled accounts and revoked or cross-team memberships fail closed", async () => {
  const disabledDb = {
    appUser: { findUnique: async () => ({ id: actorId, disabledAt: new Date(), accountAccessVersion: 1 }) },
  } as unknown as PrismaClient;
  await assert.rejects(
    () => listTeams({ id: actorId, role: "user", accountAccessVersion: 1 }, disabledDb),
    (error: unknown) => error instanceof AccessControlError && error.code === "ACCOUNT_DISABLED",
  );

  const crossTeamDb = {
    appUser: { findUnique: async () => ({ id: actorId, disabledAt: null, accountAccessVersion: 1 }) },
    workspace: { findUnique: async () => ({ id: teamId, createdById: "55555555-5555-4555-8555-555555555555" }) },
    workspaceMembership: { findMany: async () => [] },
  } as unknown as PrismaClient;
  await assert.rejects(
    () => getTeamOverview({ id: actorId, role: "user", accountAccessVersion: 1 }, teamId, crossTeamDb),
    (error: unknown) => error instanceof AccessControlError && error.code === "ACCESS_FORBIDDEN",
  );
});
