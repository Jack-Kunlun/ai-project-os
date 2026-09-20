import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { AuthError, createPasswordRecord, loginAdmin } from "@/lib/auth";
import { grantProjectMembership, grantWorkspaceMembership } from "@/lib/membership-governance";
import { lockActorAccess, lockProjectAccess, lockWorkspaceAccess } from "@/lib/access-linearization";

const shouldRun = process.env.LOCAL_LOGIN_POSTGRES_GATE === "1";
const configuredUrl = process.env.LOCAL_LOGIN_TEST_DATABASE_URL;

function testDatabaseUrl(): string {
  if (typeof configuredUrl !== "string" || configuredUrl.length === 0) throw new Error("LOCAL_LOGIN_TEST_DATABASE_URL_REQUIRED");
  let parsed: URL;
  try {
    parsed = new URL(configuredUrl);
  } catch {
    throw new Error("LOCAL_LOGIN_TEST_DATABASE_URL_INVALID");
  }
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol)
    || !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname.toLowerCase())
    || parsed.port !== "56432"
    || parsed.pathname !== "/ai_project_os_local_login_test"
    || parsed.username !== "ai_project_os_gate"
    || parsed.password.length === 0
    || parsed.search !== ""
    || parsed.hash !== ""
  ) throw new Error("LOCAL_LOGIN_TEST_DATABASE_URL_INVALID");
  return parsed.toString();
}

async function createLocalUser(
  db: PrismaClient,
  input: Readonly<{ username: string; password: string }>,
): Promise<Readonly<{ id: string; password: string }>> {
  const userId = randomUUID();
  const password = await createPasswordRecord(input.password);
  await db.appUser.create({ data: { id: userId, username: input.username, role: "user", ...password } });
  return Object.freeze({ id: userId, password: input.password });
}

async function createLegacyUser(
  db: PrismaClient,
  input: Readonly<{ username: string; password: string }>,
): Promise<Readonly<{ id: string; password: string }>> {
  const legacy = await createLocalUser(db, input);
  const workspaceId = randomUUID();
  await db.$transaction(async (tx) => {
    await lockActorAccess(tx, legacy.id);
    await lockWorkspaceAccess(tx, workspaceId);
    await tx.workspace.create({
      data: {
        id: workspaceId,
        name: `${input.username} legacy workspace`,
        slug: `legacy-${legacy.id}`,
        createdById: legacy.id,
      },
    });
    await grantWorkspaceMembership(tx, {
      workspaceId,
      userId: legacy.id,
      role: "owner",
      actorId: legacy.id,
      reason: "local_login_legacy_fixture",
    });
  });
  return legacy;
}

test(
  "local login lazily provisions one personal owner workspace for legacy users",
  { skip: !shouldRun ? "LOCAL_LOGIN_POSTGRES_GATE=1 is required" : false },
  async () => {
    const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: testDatabaseUrl() }) });
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    try {
      const legacy = await createLegacyUser(db, {
        username: `local_legacy_${suffix}`,
        password: "LocalLegacyLoginPassword_2026",
      });

      const [first, second] = await Promise.all([
        loginAdmin({ username: `local_legacy_${suffix}`, password: legacy.password }, db),
        loginAdmin({ username: `local_legacy_${suffix}`, password: legacy.password }, db),
      ]);
      assert.equal(first.user.id, legacy.id);
      assert.equal(second.user.id, legacy.id);
      assert.equal(first.user.role, "user");
      assert.equal(second.user.role, "user");
      assert.equal(await db.workspace.count({ where: { slug: `user-${legacy.id}` } }), 1);
      const personal = await db.workspace.findUniqueOrThrow({ where: { slug: `user-${legacy.id}` } });
      assert.equal(personal.createdById, legacy.id);
      assert.equal(await db.workspaceMembership.count({ where: { workspaceId: personal.id, userId: legacy.id, role: "owner", accessState: "confirmed" } }), 1);
      assert.equal(await db.membershipAccessAudit.count({ where: { workspaceId: personal.id, userId: legacy.id, action: "confirmed" } }), 1);
      assert.equal(await db.workspaceMembership.count({ where: { userId: legacy.id, accessState: "confirmed" } }), 2);
      assert.equal(await db.appSession.count({ where: { userId: legacy.id, revokedAt: null } }), 2);

      const adminPassword = "LocalAdminLoginPassword_2026";
      const admin = await db.appUser.create({ data: { username: `local_admin_${suffix}`, role: "admin", ...(await createPasswordRecord(adminPassword)) } });
      const adminSession = await loginAdmin({ username: admin.username, password: adminPassword }, db);
      assert.equal(adminSession.user.role, "admin");
      assert.equal(await db.workspace.count({ where: { slug: `user-${admin.id}` } }), 0);

      const projectOnly = await createLocalUser(db, {
        username: `local_project_only_${suffix}`,
        password: "LocalProjectOnlyLoginPassword_2026",
      });
      const projectOwner = await db.appUser.create({ data: { username: `local_project_owner_${suffix}`, role: "user" } });
      const projectWorkspaceId = randomUUID();
      const projectId = randomUUID();
      await db.$transaction(async (tx) => {
        await lockActorAccess(tx, projectOwner.id);
        await lockWorkspaceAccess(tx, projectWorkspaceId);
        await tx.workspace.create({
          data: {
            id: projectWorkspaceId,
            name: "Project-only legacy workspace",
            slug: `legacy-project-only-${suffix}`,
            createdById: projectOwner.id,
          },
        });
        await grantWorkspaceMembership(tx, {
          workspaceId: projectWorkspaceId,
          userId: projectOwner.id,
          role: "owner",
          actorId: projectOwner.id,
          reason: "local_login_project_only_workspace_fixture",
        });
        await tx.project.create({
          data: { id: projectId, workspaceId: projectWorkspaceId, name: "Project-only legacy grant", slug: `project-only-${suffix}` },
        });
      });
      await db.$transaction(async (tx) => {
        await lockActorAccess(tx, projectOnly.id);
        await lockWorkspaceAccess(tx, projectWorkspaceId);
        await lockProjectAccess(tx, projectId);
        await grantProjectMembership(tx, {
          projectId,
          workspaceId: projectWorkspaceId,
          userId: projectOnly.id,
          role: "editor",
          actorId: projectOnly.id,
          reason: "local_login_project_only_grant_fixture",
        });
      });
      assert.equal(await db.workspaceMembership.count({ where: { userId: projectOnly.id } }), 0);
      const projectGrantBeforeLogin = await db.projectMembership.findFirstOrThrow({ where: { projectId, userId: projectOnly.id } });
      const projectOnlySession = await loginAdmin({ username: `local_project_only_${suffix}`, password: projectOnly.password }, db);
      assert.equal(projectOnlySession.user.id, projectOnly.id);
      assert.equal(await db.workspace.count({ where: { slug: `user-${projectOnly.id}` } }), 1);
      assert.equal(await db.workspaceMembership.count({ where: { userId: projectOnly.id, role: "owner", accessState: "confirmed" } }), 1);
      const projectGrantAfterLogin = await db.projectMembership.findFirstOrThrow({ where: { projectId, userId: projectOnly.id } });
      assert.equal(projectGrantAfterLogin.id, projectGrantBeforeLogin.id);
      assert.equal(projectGrantAfterLogin.role, "editor");

      const noPassword = await db.appUser.create({ data: { username: `local_no_password_${suffix}`, role: "user" } });
      await assert.rejects(
        () => loginAdmin({ username: noPassword.username, password: "NoPasswordLoginPassword_2026" }, db),
        (error: unknown) => error instanceof AuthError && error.code === "AUTH_INVALID_CREDENTIALS",
      );
      assert.equal(await db.workspace.count({ where: { slug: `user-${noPassword.id}` } }), 0);

      const disabledPassword = await createPasswordRecord("LocalDisabledLoginPassword_2026");
      const disabled = await db.appUser.create({ data: { username: `local_disabled_${suffix}`, role: "user", disabledAt: new Date(), ...disabledPassword } });
      await assert.rejects(
        () => loginAdmin({ username: disabled.username, password: "LocalDisabledLoginPassword_2026" }, db),
        (error: unknown) => error instanceof AuthError && error.code === "AUTH_INVALID_CREDENTIALS",
      );
      assert.equal(await db.workspace.count({ where: { slug: `user-${disabled.id}` } }), 0);

      const wrongCreator = await db.appUser.create({ data: { username: `wrong_creator_${suffix}`, role: "user" } });
      const blocked = await createLegacyUser(db, {
        username: `local_blocked_${suffix}`,
        password: "LocalBlockedLoginPassword_2026",
      });
      const blockedWorkspaceId = randomUUID();
      await db.$transaction(async (tx) => {
        await lockActorAccess(tx, wrongCreator.id);
        await lockWorkspaceAccess(tx, blockedWorkspaceId);
        await tx.workspace.create({
          data: {
            id: blockedWorkspaceId,
            name: "Wrong creator personal workspace",
            slug: `user-${blocked.id}`,
            createdById: wrongCreator.id,
          },
        });
        await grantWorkspaceMembership(tx, {
          workspaceId: blockedWorkspaceId,
          userId: wrongCreator.id,
          role: "owner",
          actorId: wrongCreator.id,
          reason: "local_login_wrong_creator_fixture",
        });
      });
      await assert.rejects(
        () => loginAdmin({ username: `local_blocked_${suffix}`, password: blocked.password }, db),
        (error: unknown) => error instanceof AuthError && error.code === "AUTH_PERSONAL_WORKSPACE_NOT_READY",
      );
      assert.equal(await db.appSession.count({ where: { userId: blocked.id } }), 0);
      assert.equal(await db.workspace.count({ where: { slug: `user-${blocked.id}` } }), 1);

      const rollback = await createLegacyUser(db, {
        username: `local_rollback_${suffix}`,
        password: "LocalRollbackLoginPassword_2026",
      });
      const functionName = `local_login_fail_${suffix}`;
      const triggerName = `local_login_fail_trigger_${suffix}`;
      await db.$executeRawUnsafe(`
        CREATE FUNCTION public."${functionName}"()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
          RAISE EXCEPTION 'LOCAL_LOGIN_POSTGRES_ROLLBACK_PROBE' USING ERRCODE = 'P0001';
        END;
        $$;
      `);
      await db.$executeRawUnsafe(`
        CREATE TRIGGER "${triggerName}"
        AFTER INSERT ON "Workspace"
        FOR EACH ROW WHEN (NEW."slug" = 'user-${rollback.id}')
        EXECUTE FUNCTION public."${functionName}"();
      `);
      try {
        await assert.rejects(
          () => loginAdmin({ username: `local_rollback_${suffix}`, password: rollback.password }, db),
          (error: unknown) => error instanceof Error && error.message.includes("LOCAL_LOGIN_POSTGRES_ROLLBACK_PROBE"),
        );
      } finally {
        await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON "Workspace"`);
        await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS public."${functionName}"()`);
      }
      assert.equal(await db.workspace.count({ where: { slug: `user-${rollback.id}` } }), 0);
      assert.equal(await db.appSession.count({ where: { userId: rollback.id } }), 0);
    } finally {
      await db.$disconnect();
    }
  },
);
