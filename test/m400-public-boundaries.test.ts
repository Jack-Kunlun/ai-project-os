import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import { AccessControlError } from "../src/lib/access-control";
import { createSession } from "../src/lib/auth";
import { listMemberships } from "../src/lib/membership-service";
import { createLocalWorkspaceMember, listWorkspaceMembers, updateWorkspaceMember } from "../src/lib/workspaces";
import { toSystemRole } from "../src/lib/system-role";

const adminId = "11111111-1111-4111-8111-111111111111";
const memberId = "22222222-2222-4222-8222-222222222222";
const workspaceId = "33333333-3333-4333-8333-333333333333";

const safeMember = {
  id: "55555555-5555-4555-8555-555555555555",
  workspaceId,
  userId: memberId,
  role: "member" as const,
  accessState: "confirmed" as const,
  createdAt: new Date("2026-09-04T00:00:00.000Z"),
  updatedAt: new Date("2026-09-04T00:00:00.000Z"),
  user: {
    id: memberId,
    username: "member",
    displayName: null,
    email: null,
    disabledAt: null,
    createdAt: new Date("2026-09-04T00:00:00.000Z"),
    oidcIdentities: [],
  },
  workspace: { projects: [] },
};

test("session, profile, and admin membership boundaries expose canonical system roles", async () => {
  let sessionCreateInput: Record<string, unknown> | undefined;
  const sessionDb = {
    appSession: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        sessionCreateInput = data;
        return data;
      },
    },
  } as unknown as PrismaClient;
  const currentSession = await createSession(sessionDb, { id: memberId, username: "current-user", role: "user", accountAccessVersion: 1 });
  const adminSession = await createSession(sessionDb, { id: adminId, username: "admin", role: "admin", accountAccessVersion: 1 });
  assert.equal(currentSession.user.role, "user");
  assert.equal(adminSession.user.role, "admin");
  assert.equal(sessionCreateInput?.userId, adminId);

  const selectedUserFields: string[][] = [];
  const membershipDb = {
    appUser: {
      findUnique: async () => ({ role: "admin" as const, disabledAt: null }),
      findMany: async ({ select }: { select: Record<string, unknown> }) => {
        selectedUserFields.push(Object.keys(select));
        return [
          { id: memberId, username: "current-user", displayName: null, email: null, role: "user" as const, disabledAt: null, membershipSubscription: null },
          { id: adminId, username: "admin", displayName: null, email: null, role: "admin" as const, disabledAt: null, membershipSubscription: null },
        ];
      },
    },
  } as unknown as PrismaClient;
  const membershipResult = await listMemberships({ adminUserId: adminId }, membershipDb);
  assert.deepEqual(membershipResult.items.map((item) => item.role), ["user", "admin"]);
  assert.deepEqual(selectedUserFields, [["id", "username", "displayName", "email", "role", "disabledAt", "membershipSubscription"]]);
  assert.doesNotMatch(JSON.stringify(membershipResult), /passwordHash|passwordSalt/u);

  const [profileRoute, authSource] = await Promise.all([
    readFile("src/app/api/profile/route.ts", "utf8"),
    readFile("src/lib/auth.ts", "utf8"),
  ]);
  assert.match(profileRoute, /toSystemRole\(role\)/u);
  assert.match(authSource, /role:\s*toSystemRole\(user\.role\)/u);
});

test("workspace member list/create/update use a minimal DTO without system credentials", async () => {
  let listSelect: Record<string, unknown> | undefined;
  const listDb = {
    appUser: { findUnique: async () => ({ id: adminId, disabledAt: null, accountAccessVersion: 1 }) },
    workspaceMembership: {
      findMany: async ({ where, select }: { where?: { userId?: string }; select?: Record<string, unknown> }) => {
        if (where?.userId === adminId) return [{ role: "admin" as const, accessState: "confirmed" as const }];
        listSelect = select;
        return [safeMember];
      },
    },
    projectMembership: { findMany: async () => [] },
  } as unknown as PrismaClient;
  const listed = await listWorkspaceMembers(workspaceId, { id: adminId, role: "admin", accountAccessVersion: 1 }, listDb);
  assert.equal("role" in listed[0]!.user, false);
  assert.equal("passwordHash" in listed[0]!.user, false);
  assert.equal("passwordSalt" in listed[0]!.user, false);
  const userSelect = (listSelect?.user as { select: Record<string, unknown> }).select;
  assert.deepEqual(Object.keys(userSelect), ["id", "username", "displayName", "email", "disabledAt", "createdAt", "oidcIdentities"]);

  const noMembershipDb = {
    appUser: { findUnique: async () => ({ id: adminId, disabledAt: null, accountAccessVersion: 1 }) },
    workspace: { count: async () => 1 },
    workspaceMembership: { findMany: async () => [] },
  } as unknown as PrismaClient;
  await assert.rejects(
    () => listWorkspaceMembers(workspaceId, { id: adminId, role: "admin", accountAccessVersion: 1 }, noMembershipDb),
    (error: unknown) => error instanceof AccessControlError && error.code === "ACCESS_FORBIDDEN",
  );

  let createdData: Record<string, unknown> | undefined;
  let activationData: Record<string, unknown> | undefined;
  let activationAuditData: Record<string, unknown> | undefined;
  const actorSnapshot = { id: adminId, disabledAt: null, accountAccessVersion: 1 };
  const createdUserSnapshot = { id: memberId, disabledAt: null, accountAccessVersion: 1 };
  const createTx = {
    appUser: {
      findUnique: async ({ where }: { where: { id: string } }) => where.id === memberId ? createdUserSnapshot : actorSnapshot,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        createdData = data;
        return { ...data, ...createdUserSnapshot };
      },
    },
    accountEntitlementActivation: {
      findUnique: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        activationData = data;
        return { ...data };
      },
    },
    platformGrantOfferPolicy: { findFirst: async () => null },
    platformTokenGrant: { findFirst: async () => null },
    accountEntitlementActivationAudit: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        activationAuditData = data;
        return data;
      },
    },
    workspaceMembership: {
      findMany: async ({ where }: { where?: { userId?: string } }) => where?.userId === adminId ? [{ role: "admin" as const, accessState: "confirmed" as const }] : [],
      create: async () => ({ ...safeMember, id: "55555555-5555-4555-8555-555555555556" }),
      findUniqueOrThrow: async () => safeMember,
    },
    projectMembership: { createMany: async () => ({ count: 0 }) },
    membershipAccessAudit: { create: async () => ({}) },
    $executeRaw: async () => 0,
  };
  const createDb = {
    appUser: { findUnique: async () => ({ id: adminId, disabledAt: null, accountAccessVersion: 1 }) },
    project: { count: async () => 0 },
    workspaceMembership: { findMany: async () => [{ role: "admin" as const, accessState: "confirmed" as const }] },
    $transaction: async (callback: (tx: typeof createTx) => unknown) => callback(createTx),
  } as unknown as PrismaClient;
  const created = await createLocalWorkspaceMember(
    workspaceId,
    { username: "new-member", password: "ValidPassword123", displayName: null, email: null },
    { id: adminId, role: "admin", accountAccessVersion: 1 },
    createDb,
  );
  assert.equal(createdData?.role, "user");
  assert.equal(activationData?.userId, memberId);
  assert.equal(activationData?.source, "localProvisioning");
  assert.equal(activationData?.decision, "no_active_offer");
  assert.equal(activationData?.status, "no_active_offer");
  assert.equal(activationAuditData?.activationId, activationData?.id);
  assert.equal(activationAuditData?.decision, "no_active_offer");
  assert.equal("passwordHash" in created.user, false);
  assert.equal("passwordSalt" in created.user, false);
  assert.equal("role" in created.user, false);

  let targetRole: "member" | "viewer" = "member";
  let targetAccessState: "confirmed" | "revoked" = "confirmed";
  const updateTx = {
    workspaceMembership: {
      findMany: async ({ where }: { where?: { userId?: string } }) =>
        where?.userId === adminId
          ? [{ role: "admin" as const, accessState: "confirmed" as const }]
          : [{ ...safeMember, role: targetRole, accessState: targetAccessState }],
      updateMany: async ({ data }: { data: { accessState?: "confirmed" | "revoked" } }) => {
        if (data.accessState !== undefined) targetAccessState = data.accessState;
        return { count: 1 };
      },
      create: async ({ data }: { data: { id: string; role: "member" | "viewer"; accessState: "confirmed" } }) => {
        targetRole = data.role;
        targetAccessState = data.accessState;
        return { ...safeMember, ...data };
      },
      findUnique: async () => ({ ...safeMember, role: targetRole, accessState: targetAccessState }),
      findUniqueOrThrow: async () => safeMember,
    },
    projectMembership: { findMany: async () => [] },
    membershipAccessAudit: { create: async () => ({}) },
    appUser: { findUnique: async () => ({ id: adminId, disabledAt: null, accountAccessVersion: 1 }) },
    $executeRaw: async () => 0,
  };
  const updateDb = {
    appUser: { findUnique: async () => ({ id: adminId, disabledAt: null, accountAccessVersion: 1 }) },
    workspaceMembership: { findMany: async () => [{ role: "admin" as const, accessState: "confirmed" as const }] },
    $transaction: async (callback: (tx: typeof updateTx) => unknown) => callback(updateTx),
  } as unknown as PrismaClient;
  const updated = await updateWorkspaceMember(workspaceId, memberId, { workspaceRole: "viewer" }, { id: adminId, role: "admin", accountAccessVersion: 1 }, updateDb);
  assert.equal("passwordHash" in updated.user, false);
  assert.equal("passwordSalt" in updated.user, false);
  assert.equal("role" in updated.user, false);
  await assert.rejects(
    () => updateWorkspaceMember(workspaceId, memberId, { workspaceRole: "owner" }, { id: adminId, role: "admin", accountAccessVersion: 1 }, updateDb),
    (error: unknown) => error instanceof AccessControlError && error.code === "ACCESS_FORBIDDEN",
  );

  const source = await readFile("src/lib/workspaces.ts", "utf8");
  assert.doesNotMatch(source, /include:\s*\{\s*user:\s*true\s*\}/u);
  assert.doesNotMatch(source, /user:\s*\{[^}]*password(?:Hash|Salt)/u);
  assert.doesNotMatch(source, /user\.role\s*===\s*["']admin["']/u);
  assert.doesNotMatch(source, /actor\.role\s*===\s*["']admin["']/u);
});

test("system-role mapper is fail-closed and canonical for current storage values", () => {
  assert.equal(toSystemRole("admin"), "admin");
  assert.equal(toSystemRole("user"), "user");
  assert.throws(() => toSystemRole("future" as never), /UNSUPPORTED_APP_USER_ROLE/u);
});
