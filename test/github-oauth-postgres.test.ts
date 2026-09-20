import "dotenv/config";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@prisma/client";
import { completeGitHubOAuth, beginGitHubOAuth, GitHubOAuthError } from "@/lib/github-oauth";
import { initializeAdmin } from "@/lib/auth";
import { appendWorkspaceMembershipAudit, grantProjectMembership, grantWorkspaceMembership } from "@/lib/membership-governance";

const gate = process.env.GITHUB_OAUTH_POSTGRES_GATE;
const configuredUrl = process.env.GITHUB_OAUTH_TEST_DATABASE_URL;
const shouldRun = gate === "1";
const DEFAULT_WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const BARRIER_KEY = 9_999_990_001;
const SNAPSHOT_GATE_KEY = 9_999_990_002;
const LEGACY_BARRIER_KEY = 9_999_990_003;
const LEGACY_SNAPSHOT_GATE_KEY = 9_999_990_004;

function testDatabaseUrl(): string {
  if (typeof configuredUrl !== "string" || configuredUrl.length === 0) throw new Error("GITHUB_OAUTH_TEST_DATABASE_URL_REQUIRED");
  let parsed: URL;
  try {
    parsed = new URL(configuredUrl);
  } catch {
    throw new Error("GITHUB_OAUTH_TEST_DATABASE_URL_INVALID");
  }
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol)
    || !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname.toLowerCase())
    || parsed.port !== "56432"
    || parsed.pathname !== "/ai_project_os_github_oauth_test"
    || parsed.username !== "ai_project_os_gate"
    || parsed.password.length === 0
    || parsed.search !== ""
    || parsed.hash !== ""
  ) throw new Error("GITHUB_OAUTH_TEST_DATABASE_URL_INVALID");
  return parsed.toString();
}

async function installFailureTrigger(db: PrismaClient, suffix: string): Promise<Readonly<{ trigger: string; functionName: string }>> {
  const functionName = `github_oauth_test_fail_${suffix}`;
  const trigger = `github_oauth_test_fail_trigger_${suffix}`;
  await db.$executeRawUnsafe(`
    CREATE FUNCTION public."${functionName}"()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      RAISE EXCEPTION 'GITHUB_OAUTH_POSTGRES_ROLLBACK_PROBE' USING ERRCODE = 'P0001';
    END;
    $$;
  `);
  await db.$executeRawUnsafe(`
    CREATE TRIGGER "${trigger}"
    AFTER INSERT ON "GitHubIdentity"
    FOR EACH ROW EXECUTE FUNCTION public."${functionName}"();
  `);
  return Object.freeze({ trigger, functionName });
}

async function removeFailureTrigger(db: PrismaClient, value: Readonly<{ trigger: string; functionName: string }>): Promise<void> {
  await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${value.trigger}" ON "GitHubIdentity"`);
  await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS public."${value.functionName}"()`);
}

async function installIdentityBarrierTrigger(
  db: PrismaClient,
  suffix: string,
  barrierKey: number,
): Promise<Readonly<{ trigger: string; functionName: string }>> {
  const functionName = `github_oauth_test_barrier_${suffix}`;
  const trigger = `github_oauth_test_barrier_trigger_${suffix}`;
  await db.$executeRawUnsafe(`
    CREATE FUNCTION public."${functionName}"()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      PERFORM pg_advisory_xact_lock(${barrierKey}::bigint);
      RETURN NEW;
    END;
    $$;
  `);
  await db.$executeRawUnsafe(`
    CREATE TRIGGER "${trigger}"
    AFTER INSERT ON "GitHubIdentity"
    FOR EACH ROW EXECUTE FUNCTION public."${functionName}"();
  `);
  return Object.freeze({ trigger, functionName });
}

async function installWorkspaceBarrierTrigger(
  db: PrismaClient,
  suffix: string,
  barrierKey: number,
): Promise<Readonly<{ trigger: string; functionName: string }>> {
  const functionName = `github_oauth_test_workspace_barrier_${suffix}`;
  const trigger = `github_oauth_test_workspace_barrier_trigger_${suffix}`;
  await db.$executeRawUnsafe(`
    CREATE FUNCTION public."${functionName}"()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      PERFORM pg_advisory_xact_lock(${barrierKey}::bigint);
      RETURN NEW;
    END;
    $$;
  `);
  await db.$executeRawUnsafe(`
    CREATE TRIGGER "${trigger}"
    AFTER INSERT ON "Workspace"
    FOR EACH ROW WHEN (NEW."slug" LIKE 'user-%')
    EXECUTE FUNCTION public."${functionName}"();
  `);
  return Object.freeze({ trigger, functionName });
}

async function removeWorkspaceBarrierTrigger(
  db: PrismaClient,
  value: Readonly<{ trigger: string; functionName: string }>,
): Promise<void> {
  await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${value.trigger}" ON "Workspace"`);
  await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS public."${value.functionName}"()`);
}

async function waitForAdvisoryWaiters(client: Client, minimum: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await client.query<{ count: string }>(`
      SELECT count(*)::text AS count
      FROM pg_locks AS locks
      JOIN pg_stat_activity AS activity ON activity.pid = locks.pid
      WHERE locks.locktype = 'advisory'
        AND locks.granted = false
        AND locks.pid <> pg_backend_pid()
        AND activity.datname = current_database()
    `);
    if (Number(result.rows[0]?.count ?? 0) >= minimum) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`GITHUB_OAUTH_POSTGRES_BARRIER_TIMEOUT: waiters=${minimum}`);
}

function snapshotPrimedClient(
  db: PrismaClient,
  diagnostics: { freshIdentityReads: number },
  gateOptions: Readonly<{ snapshotGateKey: number; isolationLevel?: Prisma.TransactionIsolationLevel }>,
): PrismaClient {
  const identityDelegate = new Proxy(db.gitHubIdentity, {
    get(target, property, receiver) {
      const method = Reflect.get(target, property, receiver);
      if (property !== "findUnique" || typeof method !== "function") return method;
      return (...args: readonly unknown[]) => {
        diagnostics.freshIdentityReads += 1;
        return Reflect.apply(method, target, args);
      };
    },
  });
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property === "gitHubIdentity") return identityDelegate;
      if (property !== "$transaction") return Reflect.get(target, property, receiver);
      return ((callback: (tx: Prisma.TransactionClient) => Promise<unknown>, transactionOptions?: { isolationLevel?: Prisma.TransactionIsolationLevel; maxWait?: number; timeout?: number }) => target.$transaction(async (tx) => {
        // Establish the transaction snapshot before the production callback
        // waits on its bootstrap/profile advisory locks. Keep this transaction
        // paused until the concurrent winner has committed so the production
        // callback resumes from a stale snapshot and exercises P2002 recovery.
        await tx.$queryRaw`SELECT "id" FROM "PlatformBootstrap" WHERE "id" = 'platform'`;
        await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(${gateOptions.snapshotGateKey}::bigint)`);
        return callback(tx);
      }, {
        ...transactionOptions,
        ...(gateOptions.isolationLevel === undefined ? {} : { isolationLevel: gateOptions.isolationLevel }),
      })) as PrismaClient["$transaction"];
    },
  }) as unknown as PrismaClient;
}

test(
  "GitHub OAuth creates one personal owner workspace under concurrent callbacks and rolls back atomically",
  { skip: !shouldRun ? "GITHUB_OAUTH_POSTGRES_GATE=1 is required" : false },
  async () => {
    const url = testDatabaseUrl();
    const temp = await mkdtemp(join(tmpdir(), "ai-project-os-github-oauth-postgres-"));
    const previousClientId = process.env.AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_ID;
    const previousClientSecret = process.env.AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_SECRET;
    const previousPublicOrigin = process.env.AI_PROJECT_OS_PUBLIC_ORIGIN;
    const previousMasterKey = process.env.AI_PROJECT_OS_MASTER_KEY_FILE;
    process.env.AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_ID = "Iv1.1234567890";
    process.env.AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_SECRET = "github-oauth-secret-for-tests";
    process.env.AI_PROJECT_OS_PUBLIC_ORIGIN = "http://127.0.0.1:3000";
    process.env.AI_PROJECT_OS_MASTER_KEY_FILE = join(temp, "master.key");
    const db = new PrismaClient({
      adapter: new PrismaPg({ connectionString: url }),
      transactionOptions: { timeout: 15_000 },
    });
    let barrierClient: Client | null = null;
    const originalFetch = globalThis.fetch;
    const fetchCounts = { token: 0, profile: 0, email: 0, revoke: 0 };
    let profile = { id: 1001, login: "rollback-user", email: "rollback-user@github.test", name: "Rollback User" };
    const accessTokenProfiles = new Map<string, typeof profile>();

    globalThis.fetch = async (input, init) => {
      const requestUrl = String(input);
      if (requestUrl.endsWith("/login/oauth/access_token")) {
        fetchCounts.token += 1;
        const code = typeof init?.body === "string" ? new URLSearchParams(init.body).get("code") : null;
        const responseProfile = code === "github-concurrent-code-b"
          ? { id: 1002, login: "concurrent-user-b", email: "concurrent-user-b@github.test", name: "Concurrent User" }
          : code === "github-serializable-code-d"
            ? { id: 1004, login: "serializable-user-b", email: "serializable-user-b@github.test", name: "Serializable User" }
            : code === "github-legacy-migration-code-b"
              ? { id: 1009, login: "legacy-migration-user", email: "legacy-migration-user@github.test", name: "Legacy Migration User" }
            : profile;
        const accessToken = `github-temporary-${fetchCounts.token}-${code ?? "unknown"}`;
        accessTokenProfiles.set(accessToken, responseProfile);
        return Response.json({ access_token: accessToken, token_type: "bearer", scope: "read:user,user:email" });
      }
      if (requestUrl.endsWith("/user/emails")) {
        fetchCounts.email += 1;
        const authorization = typeof init?.headers === "object" && init.headers !== null && !Array.isArray(init.headers)
          ? (init.headers as Record<string, string>).authorization
          : undefined;
        const responseProfile = accessTokenProfiles.get(authorization?.replace(/^Bearer /u, "") ?? "") ?? profile;
        return Response.json([{ email: responseProfile.email, primary: true, verified: true }]);
      }
      if (requestUrl.endsWith("/user")) {
        fetchCounts.profile += 1;
        const authorization = typeof init?.headers === "object" && init.headers !== null && !Array.isArray(init.headers)
          ? (init.headers as Record<string, string>).authorization
          : undefined;
        const responseProfile = accessTokenProfiles.get(authorization?.replace(/^Bearer /u, "") ?? "") ?? profile;
        return Response.json({ id: responseProfile.id, login: responseProfile.login, name: responseProfile.name, type: "User" });
      }
      if (requestUrl.includes("/applications/") && init?.method === "DELETE") {
        fetchCounts.revoke += 1;
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected request: ${requestUrl}`);
    };

    try {
      assert.equal(await db.workspace.count({ where: { id: DEFAULT_WORKSPACE_ID } }), 0);
      const adminSession = await initializeAdmin({ username: `github_oauth_admin_${randomUUID().slice(0, 8)}`, password: "GitHubOauthAdminPassword_2026" }, db);
      assert.equal(await db.platformBootstrap.count({ where: { initialAdminUserId: adminSession.user.id } }), 1);

      const trigger = await installFailureTrigger(db, randomUUID().replaceAll("-", ""));
      try {
        const failedFlow = await beginGitHubOAuth({ intent: "login", returnTo: "/dashboard" }, db);
        await assert.rejects(
          completeGitHubOAuth({ code: "github-rollback-code", state: failedFlow.state, cookieState: failedFlow.state }, db),
          (error: unknown) => error instanceof Error && error.message.includes("GITHUB_OAUTH_POSTGRES_ROLLBACK_PROBE"),
        );
      } finally {
        await removeFailureTrigger(db, trigger);
      }
      assert.equal(await db.appUser.count({ where: { role: "user" } }), 0);
      assert.equal(await db.gitHubIdentity.count(), 0);
      assert.equal(await db.workspace.count({ where: { slug: { startsWith: "user-" } } }), 0);
      assert.equal(await db.workspaceMembership.count(), 0);
      assert.equal(await db.membershipAccessAudit.count(), 0);
      assert.equal(await db.accountEntitlementActivation.count(), 0);
      assert.equal(await db.platformTokenGrant.count(), 0);

      fetchCounts.token = 0;
      fetchCounts.profile = 0;
      fetchCounts.email = 0;
      fetchCounts.revoke = 0;
      profile = { id: 1002, login: "concurrent-user", email: "concurrent-user@github.test", name: "Concurrent User" };
      barrierClient = new Client({ connectionString: url });
      await barrierClient.connect();
      await barrierClient.query("SELECT pg_advisory_lock($1::bigint)", [BARRIER_KEY]);
      await barrierClient.query("SELECT pg_advisory_lock($1::bigint)", [SNAPSHOT_GATE_KEY]);
      const barrierTrigger = await installIdentityBarrierTrigger(db, randomUUID().replaceAll("-", ""), BARRIER_KEY);
      const firstFlow = await beginGitHubOAuth({ intent: "login", returnTo: "/dashboard" }, db);
      const secondFlow = await beginGitHubOAuth({ intent: "login", returnTo: "/dashboard" }, db);
      const snapshotDiagnostics = { freshIdentityReads: 0 };
      try {
        const secondCompletion = completeGitHubOAuth(
          { code: "github-concurrent-code-b", state: secondFlow.state, cookieState: secondFlow.state },
          snapshotPrimedClient(db, snapshotDiagnostics, {
            snapshotGateKey: SNAPSHOT_GATE_KEY,
            // PostgreSQL SSI reports this stale-index race as 40001/P2034;
            // RepeatableRead gives the adapter's P2002 representation a
            // deterministic, real-database regression path as well.
            isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
          }),
        );
        await waitForAdvisoryWaiters(barrierClient, 1);
        const firstCompletion = completeGitHubOAuth({ code: "github-concurrent-code-a", state: firstFlow.state, cookieState: firstFlow.state }, db);
        await waitForAdvisoryWaiters(barrierClient, 2);
        // The second transaction established its snapshot and is
        // paused before the production callback. The first transaction can
        // therefore commit while the second snapshot remains stale.
        await barrierClient.query("SELECT pg_advisory_unlock($1::bigint)", [BARRIER_KEY]);
        const firstCompleted = await firstCompletion;
        await barrierClient.query("SELECT pg_advisory_unlock($1::bigint)", [SNAPSHOT_GATE_KEY]);
        const secondCompleted = await secondCompletion;
        const completed = [firstCompleted, secondCompleted];
        assert.equal(snapshotDiagnostics.freshIdentityReads, 1);
        assert.deepEqual(fetchCounts, { token: 2, profile: 2, email: 2, revoke: 2 });
        assert.equal(completed[0]?.session?.user.id, completed[1]?.session?.user.id);
        const registeredUserId = completed[0]?.session?.user.id;
        assert.ok(registeredUserId);
        assert.equal(await db.appUser.count({ where: { role: "user" } }), 1);
        assert.equal(await db.gitHubIdentity.count({ where: { githubUserId: BigInt(profile.id) } }), 1);
        assert.equal(await db.workspace.count({ where: { slug: `user-${registeredUserId}` } }), 1);
        assert.equal(await db.workspace.count({ where: { slug: { startsWith: "user-" } } }), 1);
        assert.equal(await db.workspaceMembership.count({ where: { userId: registeredUserId, role: "owner", accessState: "confirmed" } }), 1);
        assert.equal(await db.membershipAccessAudit.count({ where: { userId: registeredUserId, action: "confirmed" } }), 1);
        assert.equal(await db.accountEntitlementActivation.count({ where: { userId: registeredUserId, lifecycleKey: "initial_account_v1" } }), 1);
        assert.equal(await db.platformTokenGrant.count({ where: { userId: registeredUserId, kind: "signup" } }), 1);
        assert.equal(await db.workspaceMembership.count({ where: { workspaceId: DEFAULT_WORKSPACE_ID } }), 0);
      } finally {
        await barrierClient.query("SELECT pg_advisory_unlock($1::bigint)", [BARRIER_KEY]).catch(() => undefined);
        await barrierClient.query("SELECT pg_advisory_unlock($1::bigint)", [SNAPSHOT_GATE_KEY]).catch(() => undefined);
        await removeFailureTrigger(db, barrierTrigger);
      }

      fetchCounts.token = 0;
      fetchCounts.profile = 0;
      fetchCounts.email = 0;
      fetchCounts.revoke = 0;
      profile = { id: 1004, login: "serializable-user", email: "serializable-user@github.test", name: "Serializable User" };
      await barrierClient.query("SELECT pg_advisory_lock($1::bigint)", [BARRIER_KEY]);
      await barrierClient.query("SELECT pg_advisory_lock($1::bigint)", [SNAPSHOT_GATE_KEY]);
      const serializableBarrierTrigger = await installIdentityBarrierTrigger(db, randomUUID().replaceAll("-", ""), BARRIER_KEY);
      const serializableFirstFlow = await beginGitHubOAuth({ intent: "login", returnTo: "/dashboard" }, db);
      const serializableSecondFlow = await beginGitHubOAuth({ intent: "login", returnTo: "/dashboard" }, db);
      const serializableDiagnostics = { freshIdentityReads: 0 };
      try {
        const serializableSecondCompletion = completeGitHubOAuth(
          { code: "github-serializable-code-d", state: serializableSecondFlow.state, cookieState: serializableSecondFlow.state },
          snapshotPrimedClient(db, serializableDiagnostics, { snapshotGateKey: SNAPSHOT_GATE_KEY }),
        );
        await waitForAdvisoryWaiters(barrierClient, 1);
        const serializableFirstCompletion = completeGitHubOAuth(
          { code: "github-serializable-code-c", state: serializableFirstFlow.state, cookieState: serializableFirstFlow.state },
          db,
        );
        await waitForAdvisoryWaiters(barrierClient, 2);
        await barrierClient.query("SELECT pg_advisory_unlock($1::bigint)", [BARRIER_KEY]);
        const serializableFirstCompleted = await serializableFirstCompletion;
        await barrierClient.query("SELECT pg_advisory_unlock($1::bigint)", [SNAPSHOT_GATE_KEY]);
        const serializableSecondCompleted = await serializableSecondCompletion;
        assert.equal(serializableDiagnostics.freshIdentityReads, 0);
        assert.deepEqual(fetchCounts, { token: 2, profile: 2, email: 2, revoke: 2 });
        assert.equal(serializableFirstCompleted.session?.user.id, serializableSecondCompleted.session?.user.id);
        const serializableUserId = serializableFirstCompleted.session?.user.id;
        assert.ok(serializableUserId);
        assert.equal(await db.gitHubIdentity.count({ where: { githubUserId: BigInt(profile.id) } }), 1);
        assert.equal(await db.workspace.count({ where: { slug: { startsWith: "user-" } } }), 2);
        assert.equal(await db.workspaceMembership.count({ where: { userId: serializableUserId, role: "owner", accessState: "confirmed" } }), 1);
      } finally {
        await barrierClient.query("SELECT pg_advisory_unlock($1::bigint)", [BARRIER_KEY]).catch(() => undefined);
        await barrierClient.query("SELECT pg_advisory_unlock($1::bigint)", [SNAPSHOT_GATE_KEY]).catch(() => undefined);
        await removeFailureTrigger(db, serializableBarrierTrigger);
      }

      fetchCounts.token = 0;
      fetchCounts.profile = 0;
      fetchCounts.email = 0;
      fetchCounts.revoke = 0;
      const legacyUser = await db.appUser.create({
        data: {
          username: `github_legacy_${randomUUID().slice(0, 8)}`,
          email: "legacy-migration-user@github.test",
          role: "user",
        },
      });
      const legacyWorkspace = await db.$transaction(async (tx) => {
        const workspace = await tx.workspace.create({
          data: {
            name: "Legacy workspace",
            slug: `legacy-${randomUUID()}`,
            createdById: legacyUser.id,
          },
        });
        await grantWorkspaceMembership(tx, {
          workspaceId: workspace.id,
          userId: adminSession.user.id,
          role: "owner",
          actorId: adminSession.user.id,
          reason: "github_oauth_postgres_legacy_fixture_admin_owner",
        });
        await grantWorkspaceMembership(tx, {
          workspaceId: workspace.id,
          userId: legacyUser.id,
          role: "member",
          actorId: legacyUser.id,
          reason: "github_oauth_postgres_legacy_fixture",
        });
        return workspace;
      });
      await db.gitHubIdentity.create({
        data: {
          userId: legacyUser.id,
          githubUserId: BigInt(1009),
          login: "legacy-migration-user",
          email: "legacy-migration-user@github.test",
          displayName: "Legacy Migration User",
        },
      });
      profile = { id: 1009, login: "legacy-migration-user", email: "legacy-migration-user@github.test", name: "Legacy Migration User" };
      await barrierClient.query("SELECT pg_advisory_lock($1::bigint)", [LEGACY_BARRIER_KEY]);
      await barrierClient.query("SELECT pg_advisory_lock($1::bigint)", [LEGACY_SNAPSHOT_GATE_KEY]);
      const legacyBarrierTrigger = await installWorkspaceBarrierTrigger(db, randomUUID().replaceAll("-", ""), LEGACY_BARRIER_KEY);
      const legacyFirstFlow = await beginGitHubOAuth({ intent: "login", returnTo: "/dashboard" }, db);
      const legacySecondFlow = await beginGitHubOAuth({ intent: "login", returnTo: "/dashboard" }, db);
      const legacyDiagnostics = { freshIdentityReads: 0 };
      try {
        const legacySecondCompletion = completeGitHubOAuth(
          { code: "github-legacy-migration-code-b", state: legacySecondFlow.state, cookieState: legacySecondFlow.state },
          snapshotPrimedClient(db, legacyDiagnostics, {
            snapshotGateKey: LEGACY_SNAPSHOT_GATE_KEY,
            isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
          }),
        );
        await waitForAdvisoryWaiters(barrierClient, 1);
        const legacyFirstCompletion = completeGitHubOAuth(
          { code: "github-legacy-migration-code-a", state: legacyFirstFlow.state, cookieState: legacyFirstFlow.state },
          db,
        );
        await waitForAdvisoryWaiters(barrierClient, 2);
        await barrierClient.query("SELECT pg_advisory_unlock($1::bigint)", [LEGACY_BARRIER_KEY]);
        const legacyFirstCompleted = await legacyFirstCompletion;
        await barrierClient.query("SELECT pg_advisory_unlock($1::bigint)", [LEGACY_SNAPSHOT_GATE_KEY]);
        const legacySecondCompleted = await legacySecondCompletion;
        // PostgreSQL may report the stale canonical-slug insert as a
        // serialization failure rather than P2002. The inner bounded retry
        // handles that form; the outer fresh-identity P2002 path is exercised
        // by the new-identity barrier above.
        assert.equal(legacyDiagnostics.freshIdentityReads, 0);
        assert.deepEqual(fetchCounts, { token: 2, profile: 2, email: 2, revoke: 2 });
        assert.equal(legacyFirstCompleted.session?.user.id, legacyUser.id);
        assert.equal(legacySecondCompleted.session?.user.id, legacyUser.id);
        assert.equal(await db.workspace.count({ where: { slug: `user-${legacyUser.id}` } }), 1);
        assert.equal(await db.workspace.count({ where: { slug: { startsWith: "user-" } } }), 3);
        const personalWorkspace = await db.workspace.findUnique({ where: { slug: `user-${legacyUser.id}` } });
        assert.ok(personalWorkspace);
        assert.equal(personalWorkspace.createdById, legacyUser.id);
        assert.equal(await db.workspaceMembership.count({ where: { workspaceId: legacyWorkspace.id, userId: legacyUser.id, role: "member", accessState: "confirmed" } }), 1);
        assert.equal(await db.workspaceMembership.count({ where: { workspaceId: personalWorkspace.id, userId: legacyUser.id, role: "owner", accessState: "confirmed" } }), 1);
        assert.equal(await db.membershipAccessAudit.count({ where: { userId: legacyUser.id, action: "confirmed" } }), 2);
      } finally {
        await barrierClient.query("SELECT pg_advisory_unlock($1::bigint)", [LEGACY_BARRIER_KEY]).catch(() => undefined);
        await barrierClient.query("SELECT pg_advisory_unlock($1::bigint)", [LEGACY_SNAPSHOT_GATE_KEY]).catch(() => undefined);
        await removeWorkspaceBarrierTrigger(db, legacyBarrierTrigger);
      }

      const projectOnlyUser = await db.appUser.create({
        data: {
          username: `github_project_only_${randomUUID().slice(0, 8)}`,
          email: "github-project-only@github.test",
          role: "user",
        },
      });
      const directProject = await db.project.create({
        data: {
          name: "Legacy direct project",
          slug: `legacy-direct-project-${randomUUID()}`,
          workspaceId: legacyWorkspace.id,
        },
      });
      const directGrant = await db.$transaction(async (tx) => grantProjectMembership(tx, {
        projectId: directProject.id,
        workspaceId: legacyWorkspace.id,
        userId: projectOnlyUser.id,
        role: "viewer",
        actorId: adminSession.user.id,
        reason: "github_oauth_postgres_project_only_fixture",
      }));
      await db.gitHubIdentity.create({
        data: {
          userId: projectOnlyUser.id,
          githubUserId: BigInt(1013),
          login: "github-project-only",
          email: "github-project-only@github.test",
          displayName: "Project Only User",
        },
      });
      fetchCounts.token = 0;
      fetchCounts.profile = 0;
      fetchCounts.email = 0;
      fetchCounts.revoke = 0;
      profile = { id: 1013, login: "github-project-only", email: "github-project-only@github.test", name: "Project Only User" };
      const projectOnlyFlow = await beginGitHubOAuth({ intent: "login", returnTo: "/dashboard" }, db);
      const projectOnlyCompleted = await completeGitHubOAuth({ code: "github-project-only-code", state: projectOnlyFlow.state, cookieState: projectOnlyFlow.state }, db);
      assert.equal(projectOnlyCompleted.session?.user.id, projectOnlyUser.id);
      assert.deepEqual(fetchCounts, { token: 1, profile: 1, email: 1, revoke: 1 });
      assert.equal(await db.workspaceMembership.count({ where: { userId: projectOnlyUser.id, role: "owner", accessState: "confirmed" } }), 1);
      assert.equal(await db.projectMembership.count({ where: { id: directGrant.id, userId: projectOnlyUser.id, accessState: "confirmed" } }), 1);
      const preservedDirectGrant = await db.projectMembership.findUnique({ where: { id: directGrant.id } });
      assert.equal(preservedDirectGrant?.role, "viewer");
      assert.equal(await db.workspace.count({ where: { slug: { startsWith: "user-" } } }), 4);

      const reviewOwner = await db.appUser.create({
        data: {
          username: `github_review_owner_${randomUUID().slice(0, 8)}`,
          email: "github-review-owner@github.test",
          role: "user",
        },
      });
      await db.$transaction(async (tx) => {
        const workspace = await tx.workspace.create({
          data: { name: "Review legacy workspace", slug: `legacy-review-${randomUUID()}`, createdById: reviewOwner.id },
        });
        await grantWorkspaceMembership(tx, {
          workspaceId: workspace.id,
          userId: adminSession.user.id,
          role: "owner",
          actorId: adminSession.user.id,
          reason: "github_oauth_postgres_review_fixture_admin_owner",
        });
        await grantWorkspaceMembership(tx, {
          workspaceId: workspace.id,
          userId: reviewOwner.id,
          role: "member",
          actorId: reviewOwner.id,
          reason: "github_oauth_postgres_review_fixture",
        });
        return workspace;
      });
      const wrongOwnerWorkspace = await db.$transaction(async (tx) => {
        const workspace = await tx.workspace.create({
          data: { name: "Wrong owner personal workspace", slug: `user-${reviewOwner.id}`, createdById: adminSession.user.id },
        });
        await grantWorkspaceMembership(tx, {
          workspaceId: workspace.id,
          userId: adminSession.user.id,
          role: "owner",
          actorId: adminSession.user.id,
          reason: "github_oauth_postgres_wrong_owner_fixture",
        });
        return workspace;
      });
      await db.gitHubIdentity.create({
        data: { userId: reviewOwner.id, githubUserId: BigInt(1010), login: "github-review-owner", email: "github-review-owner@github.test", displayName: "Review Owner" },
      });
      profile = { id: 1010, login: "github-review-owner", email: "github-review-owner@github.test", name: "Review Owner" };
      const wrongOwnerFlow = await beginGitHubOAuth({ intent: "login", returnTo: "/dashboard" }, db);
      await assert.rejects(
        completeGitHubOAuth({ code: "github-wrong-owner-code", state: wrongOwnerFlow.state, cookieState: wrongOwnerFlow.state }, db),
        (error: unknown) => error instanceof GitHubOAuthError && error.code === "GITHUB_OAUTH_MEMBERSHIP_REVIEW_REQUIRED",
      );
      assert.equal(await db.workspace.count({ where: { id: wrongOwnerWorkspace.id } }), 1);
      assert.equal(await db.workspaceMembership.count({ where: { workspaceId: wrongOwnerWorkspace.id, userId: reviewOwner.id } }), 0);

      const pendingOwner = await db.appUser.create({
        data: {
          username: `github_pending_owner_${randomUUID().slice(0, 8)}`,
          email: "github-pending-owner@github.test",
          role: "user",
        },
      });
      await db.$transaction(async (tx) => {
        const pendingLegacyWorkspace = await tx.workspace.create({
          data: { name: "Pending legacy workspace", slug: `legacy-pending-${randomUUID()}`, createdById: pendingOwner.id },
        });
        await grantWorkspaceMembership(tx, {
          workspaceId: pendingLegacyWorkspace.id,
          userId: adminSession.user.id,
          role: "owner",
          actorId: adminSession.user.id,
          reason: "github_oauth_postgres_pending_fixture_admin_owner",
        });
        await grantWorkspaceMembership(tx, {
          workspaceId: pendingLegacyWorkspace.id,
          userId: pendingOwner.id,
          role: "member",
          actorId: pendingOwner.id,
          reason: "github_oauth_postgres_pending_fixture",
        });
        const pendingWorkspace = await tx.workspace.create({
          data: { name: "Pending personal workspace", slug: `user-${pendingOwner.id}`, createdById: pendingOwner.id },
        });
        await grantWorkspaceMembership(tx, {
          workspaceId: pendingWorkspace.id,
          userId: adminSession.user.id,
          role: "owner",
          actorId: adminSession.user.id,
          reason: "github_oauth_postgres_pending_personal_fixture_admin_owner",
        });
        const pendingMembership = await tx.workspaceMembership.create({
          data: { workspaceId: pendingWorkspace.id, userId: pendingOwner.id, role: "owner", accessState: "pending" },
        });
        await appendWorkspaceMembershipAudit(tx, pendingMembership, {
          action: "migrationQuarantined",
          previousState: null,
          actorId: pendingOwner.id,
          reason: "github_oauth_postgres_pending_fixture",
        });
      });
      await db.gitHubIdentity.create({
        data: { userId: pendingOwner.id, githubUserId: BigInt(1011), login: "github-pending-owner", email: "github-pending-owner@github.test", displayName: "Pending Owner" },
      });
      profile = { id: 1011, login: "github-pending-owner", email: "github-pending-owner@github.test", name: "Pending Owner" };
      const pendingOwnerFlow = await beginGitHubOAuth({ intent: "login", returnTo: "/dashboard" }, db);
      await assert.rejects(
        completeGitHubOAuth({ code: "github-pending-owner-code", state: pendingOwnerFlow.state, cookieState: pendingOwnerFlow.state }, db),
        (error: unknown) => error instanceof GitHubOAuthError && error.code === "GITHUB_OAUTH_MEMBERSHIP_REVIEW_REQUIRED",
      );

      const revokedOwner = await db.appUser.create({
        data: {
          username: `github_revoked_owner_${randomUUID().slice(0, 8)}`,
          email: "github-revoked-owner@github.test",
          role: "user",
        },
      });
      await db.$transaction(async (tx) => {
        const revokedLegacyWorkspace = await tx.workspace.create({
          data: { name: "Revoked legacy workspace", slug: `legacy-revoked-${randomUUID()}`, createdById: revokedOwner.id },
        });
        await grantWorkspaceMembership(tx, {
          workspaceId: revokedLegacyWorkspace.id,
          userId: adminSession.user.id,
          role: "owner",
          actorId: adminSession.user.id,
          reason: "github_oauth_postgres_revoked_fixture_admin_owner",
        });
        await grantWorkspaceMembership(tx, {
          workspaceId: revokedLegacyWorkspace.id,
          userId: revokedOwner.id,
          role: "member",
          actorId: revokedOwner.id,
          reason: "github_oauth_postgres_revoked_fixture",
        });
        const revokedWorkspace = await tx.workspace.create({
          data: { name: "Revoked personal workspace", slug: `user-${revokedOwner.id}`, createdById: revokedOwner.id },
        });
        await grantWorkspaceMembership(tx, {
          workspaceId: revokedWorkspace.id,
          userId: adminSession.user.id,
          role: "owner",
          actorId: adminSession.user.id,
          reason: "github_oauth_postgres_revoked_personal_fixture_admin_owner",
        });
        const revokedMembership = await tx.workspaceMembership.create({
          data: { workspaceId: revokedWorkspace.id, userId: revokedOwner.id, role: "owner", accessState: "revoked" },
        });
        await appendWorkspaceMembershipAudit(tx, revokedMembership, {
          action: "revoked",
          previousState: null,
          actorId: revokedOwner.id,
          reason: "github_oauth_postgres_revoked_fixture",
        });
      });
      await db.gitHubIdentity.create({
        data: { userId: revokedOwner.id, githubUserId: BigInt(1012), login: "github-revoked-owner", email: "github-revoked-owner@github.test", displayName: "Revoked Owner" },
      });
      profile = { id: 1012, login: "github-revoked-owner", email: "github-revoked-owner@github.test", name: "Revoked Owner" };
      const revokedOwnerFlow = await beginGitHubOAuth({ intent: "login", returnTo: "/dashboard" }, db);
      await assert.rejects(
        completeGitHubOAuth({ code: "github-revoked-owner-code", state: revokedOwnerFlow.state, cookieState: revokedOwnerFlow.state }, db),
        (error: unknown) => error instanceof GitHubOAuthError && error.code === "GITHUB_OAUTH_MEMBERSHIP_REVIEW_REQUIRED",
      );

      const orphan = await db.appUser.create({ data: { username: `github_orphan_${randomUUID().slice(0, 8)}`, email: "orphan@github.test", role: "user" } });
      await db.gitHubIdentity.create({ data: { userId: orphan.id, githubUserId: BigInt(1003), login: "orphan", email: "orphan@github.test", displayName: "Orphan" } });
      profile = { id: 1003, login: "orphan", email: "orphan@github.test", name: "Orphan" };
      const orphanFlow = await beginGitHubOAuth({ intent: "login", returnTo: "/dashboard" }, db);
      const orphanCompleted = await completeGitHubOAuth({ code: "github-orphan-code", state: orphanFlow.state, cookieState: orphanFlow.state }, db);
      assert.equal(orphanCompleted.session?.user.id, orphan.id);
      assert.equal(await db.workspace.count({ where: { slug: `user-${orphan.id}` } }), 1);
      assert.equal(await db.workspaceMembership.count({ where: { userId: orphan.id, role: "owner", accessState: "confirmed" } }), 1);
      assert.equal(await db.workspace.count({ where: { slug: { startsWith: "user-" } } }), 8);
    } finally {
      globalThis.fetch = originalFetch;
      if (previousClientId === undefined) delete process.env.AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_ID; else process.env.AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_ID = previousClientId;
      if (previousClientSecret === undefined) delete process.env.AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_SECRET; else process.env.AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_SECRET = previousClientSecret;
      if (previousPublicOrigin === undefined) delete process.env.AI_PROJECT_OS_PUBLIC_ORIGIN; else process.env.AI_PROJECT_OS_PUBLIC_ORIGIN = previousPublicOrigin;
      if (previousMasterKey === undefined) delete process.env.AI_PROJECT_OS_MASTER_KEY_FILE; else process.env.AI_PROJECT_OS_MASTER_KEY_FILE = previousMasterKey;
      if (barrierClient !== null) await barrierClient.end();
      await db.$disconnect();
      await rm(temp, { recursive: true, force: true });
    }
  },
);
