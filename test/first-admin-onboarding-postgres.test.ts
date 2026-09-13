import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { Client } from "pg";
import { getDb } from "../src/lib/db";
import {
  completeFirstAdminOnboarding,
  FirstAdminOnboardingError,
  getFirstAdminOnboardingState,
} from "../src/lib/first-admin-onboarding-service";

const enabled = process.env.FIRST_ADMIN_ONBOARDING_POSTGRES_GATE === "1";
const DEFAULT_WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const GATE_DATABASE_NAME = "ai_project_os_first_admin_onboarding_test";
const TARGET_MIGRATION_PATH = join(
  process.cwd(),
  "prisma/migrations/20260913010000_add_first_admin_onboarding/migration.sql",
);

function assertGateDatabaseUrl(): string {
  const configuredDatabaseUrl = process.env.DATABASE_URL;
  if (typeof configuredDatabaseUrl !== "string" || configuredDatabaseUrl.length === 0) {
    throw new Error("FIRST_ADMIN_ONBOARDING_DATABASE_URL_REQUIRED");
  }
  let databaseUrl: URL;
  try {
    databaseUrl = new URL(configuredDatabaseUrl);
  } catch {
    throw new Error("FIRST_ADMIN_ONBOARDING_DATABASE_URL_INVALID");
  }
  if (
    !["postgres:", "postgresql:"].includes(databaseUrl.protocol)
    || !["localhost", "127.0.0.1", "[::1]"].includes(databaseUrl.hostname.toLowerCase())
    || databaseUrl.port !== "56432"
    || databaseUrl.pathname !== `/${GATE_DATABASE_NAME}`
    || databaseUrl.search !== ""
    || databaseUrl.hash !== ""
  ) throw new Error("FIRST_ADMIN_ONBOARDING_DATABASE_URL_INVALID");

  const configuredAdminUrl = process.env.POSTGRES_GATE_ADMIN_URL;
  if (typeof configuredAdminUrl !== "string" || configuredAdminUrl.length === 0) {
    throw new Error("FIRST_ADMIN_ONBOARDING_ADMIN_URL_REQUIRED");
  }
  let adminUrl: URL;
  try {
    adminUrl = new URL(configuredAdminUrl);
  } catch {
    throw new Error("FIRST_ADMIN_ONBOARDING_ADMIN_URL_INVALID");
  }
  if (
    !["postgres:", "postgresql:"].includes(adminUrl.protocol)
    || !["localhost", "127.0.0.1", "[::1]"].includes(adminUrl.hostname.toLowerCase())
    || adminUrl.port !== "56432"
    || adminUrl.username.length === 0
    || adminUrl.password.length === 0
    || adminUrl.search !== ""
    || adminUrl.hash !== ""
  ) throw new Error("FIRST_ADMIN_ONBOARDING_ADMIN_URL_INVALID");
  adminUrl.pathname = `/${GATE_DATABASE_NAME}`;
  return adminUrl.toString();
}

async function assertHistoricalAdminBackfill(adminId: string): Promise<void> {
  const client = new Client({ connectionString: assertGateDatabaseUrl(), connectionTimeoutMillis: 5_000 });
  await client.connect();
  try {
    const targetSql = await readFile(TARGET_MIGRATION_PATH, "utf8");
    const before = await client.query<{ columnCount: string; triggerCount: string; functionCount: string }>(`
      SELECT
        (SELECT COUNT(*)::text
           FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'Workspace'
            AND column_name = 'initialAdminOnboardingCompletedAt') AS "columnCount",
        (SELECT COUNT(*)::text
           FROM pg_trigger AS trigger_row
           JOIN pg_class AS relation ON relation.oid = trigger_row.tgrelid
           JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname = 'public'
            AND relation.relname = 'Workspace'
            AND trigger_row.tgname = 'Workspace_first_admin_onboarding_completion_guard') AS "triggerCount",
        (SELECT COUNT(*)::text
           FROM pg_proc AS procedure_row
           JOIN pg_namespace AS namespace ON namespace.oid = procedure_row.pronamespace
          WHERE namespace.nspname = 'public'
            AND procedure_row.proname = 'first_admin_onboarding_completion_guard') AS "functionCount"
    `);
    assert.deepEqual(before.rows[0], { columnCount: "1", triggerCount: "1", functionCount: "1" });

    await client.query("BEGIN");
    try {
      await client.query('DROP TRIGGER IF EXISTS "Workspace_first_admin_onboarding_completion_guard" ON "Workspace"');
      await client.query('DROP FUNCTION IF EXISTS "first_admin_onboarding_completion_guard"()');
      await client.query('ALTER TABLE "Workspace" DROP COLUMN IF EXISTS "initialAdminOnboardingCompletedAt"');
      const preflight = await client.query<{ createdById: string | null; adminCount: string }>(`
        SELECT
          workspace."createdById" AS "createdById",
          (SELECT COUNT(*)::text FROM "AppUser" WHERE "role" = 'admin') AS "adminCount"
          FROM "Workspace" AS workspace
         WHERE workspace."id" = $1::uuid
      `, [DEFAULT_WORKSPACE_ID]);
      assert.deepEqual(preflight.rows[0], { createdById: adminId, adminCount: "1" });

      // A real deployment commits the historical schema before the next
      // migration starts, so preserve that cross-version transaction boundary.
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }

    await client.query("BEGIN");
    try {
      await client.query(targetSql);
      const backfilled = await client.query<{ createdById: string | null; completedAt: Date | null }>(`
        SELECT "createdById", "initialAdminOnboardingCompletedAt" AS "completedAt"
          FROM "Workspace"
         WHERE "id" = $1::uuid
      `, [DEFAULT_WORKSPACE_ID]);
      assert.equal(backfilled.rows[0]?.createdById, adminId);
      assert.notEqual(backfilled.rows[0]?.completedAt, null);
      const trigger = await client.query(
        `SELECT 1
           FROM pg_trigger AS trigger_row
           JOIN pg_class AS relation ON relation.oid = trigger_row.tgrelid
           JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname = 'public'
            AND relation.relname = 'Workspace'
            AND trigger_row.tgname = $1`,
        ["Workspace_first_admin_onboarding_completion_guard"],
      );
      assert.equal(trigger.rowCount, 1);

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }

    const final = await client.query<{ createdById: string | null; completedAt: Date | null }>(`
      SELECT "createdById", "initialAdminOnboardingCompletedAt" AS "completedAt"
        FROM "Workspace"
       WHERE "id" = $1::uuid
    `, [DEFAULT_WORKSPACE_ID]);
    assert.equal(final.rows[0]?.createdById, adminId);
    assert.notEqual(final.rows[0]?.completedAt, null);
  } finally {
    await client.end();
  }
}

test("first-admin onboarding completion is persistent, idempotent and database-guarded", { skip: !enabled }, async () => {
  const db = getDb();
  const admin = await db.appUser.findUniqueOrThrow({
    where: { username: "postgres_gate_admin" },
    select: { id: true, role: true, accountAccessVersion: true },
  });
  const actor = { id: admin.id, role: admin.role, accountAccessVersion: admin.accountAccessVersion } as const;
  assert.equal(await getFirstAdminOnboardingState(actor.id, db), "pending");
  await assert.rejects(
    () => completeFirstAdminOnboarding({ ...actor, accountAccessVersion: actor.accountAccessVersion + 1 }, db),
    (error: unknown) => error instanceof FirstAdminOnboardingError && error.code === "FIRST_ADMIN_ONBOARDING_ACCOUNT_STALE",
  );
  assert.equal(await getFirstAdminOnboardingState(actor.id, db), "pending");

  const disabledAdminId = randomUUID();
  await db.appUser.create({
    data: {
      id: disabledAdminId,
      username: `onboarding-disabled-admin-${disabledAdminId.slice(0, 8)}`,
      role: "admin",
      disabledAt: new Date(),
      disabledReason: "postgres gate disabled actor fixture",
      disabledById: actor.id,
      passwordHash: "a",
      passwordSalt: "b",
    },
  });
  try {
    await assert.rejects(
      () => completeFirstAdminOnboarding({ id: disabledAdminId, role: "admin", accountAccessVersion: 1 }, db),
      (error: unknown) => error instanceof FirstAdminOnboardingError && error.code === "FIRST_ADMIN_ONBOARDING_FORBIDDEN",
    );
  } finally {
    await db.appUser.delete({ where: { id: disabledAdminId } });
  }

  const completions = await Promise.all([
    completeFirstAdminOnboarding(actor, db),
    completeFirstAdminOnboarding(actor, db),
    completeFirstAdminOnboarding(actor, db),
  ]);
  assert.equal(new Set(completions.map((completion) => completion.completedAt.toISOString())).size, 1);
  const completedAt = completions[0]!.completedAt.toISOString();
  assert.equal(await getFirstAdminOnboardingState(actor.id, db), "completed");
  assert.equal((await completeFirstAdminOnboarding(actor, db)).completedAt.toISOString(), completedAt);

  await assert.rejects(
    () => db.$executeRaw`UPDATE "Workspace" SET "initialAdminOnboardingCompletedAt" = NULL WHERE "id" = '00000000-0000-4000-8000-000000000001'`,
    /first-admin onboarding completion is immutable/u,
  );
  await assert.rejects(
    () => db.$executeRaw`UPDATE "Workspace" SET "initialAdminOnboardingCompletedAt" = ${new Date("2026-09-13T00:00:00.000Z")} WHERE "id" = '00000000-0000-4000-8000-000000000001'`,
    /first-admin onboarding completion is immutable/u,
  );

  const nonDefaultWorkspaceId = randomUUID();
  const nonDefaultInsertWorkspaceId = randomUUID();
  await assert.rejects(
    () => db.$executeRaw`
      INSERT INTO "Workspace" ("id", "name", "slug", "initialAdminOnboardingCompletedAt")
      VALUES (${nonDefaultInsertWorkspaceId}::uuid, 'Onboarding insert guard fixture', ${`onboarding-insert-guard-${nonDefaultInsertWorkspaceId.slice(0, 8)}`}, ${new Date("2026-09-13T00:00:00.000Z")})
    `,
    /first-admin onboarding completion must start NULL/u,
  );
  await db.workspace.create({ data: { id: nonDefaultWorkspaceId, name: "Onboarding guard fixture", slug: `onboarding-guard-${nonDefaultWorkspaceId.slice(0, 8)}` } });
  try {
    await assert.rejects(
      () => db.$executeRaw`UPDATE "Workspace" SET "initialAdminOnboardingCompletedAt" = ${new Date("2026-09-13T00:00:00.000Z")} WHERE "id" = ${nonDefaultWorkspaceId}`,
      /requires the authenticated default owner/u,
    );
  } finally {
    await db.workspace.delete({ where: { id: nonDefaultWorkspaceId } });
  }

  const ordinaryUserId = randomUUID();
  const secondAdminId = randomUUID();
  await db.appUser.create({ data: { id: ordinaryUserId, username: `onboarding-user-${ordinaryUserId.slice(0, 8)}`, role: "user", passwordHash: "a", passwordSalt: "b" } });
  await db.appUser.create({ data: { id: secondAdminId, username: `onboarding-admin-${secondAdminId.slice(0, 8)}`, role: "admin", passwordHash: "a", passwordSalt: "b" } });
  try {
    await assert.rejects(
      () => completeFirstAdminOnboarding({ id: ordinaryUserId, role: "user", accountAccessVersion: 1 }, db),
      (error: unknown) => error instanceof FirstAdminOnboardingError && error.code === "FIRST_ADMIN_ONBOARDING_FORBIDDEN",
    );
    await assert.rejects(
      () => completeFirstAdminOnboarding({ id: secondAdminId, role: "admin", accountAccessVersion: 1 }, db),
      (error: unknown) => error instanceof FirstAdminOnboardingError && error.code === "FIRST_ADMIN_ONBOARDING_FORBIDDEN",
    );
  } finally {
    await db.appUser.deleteMany({ where: { id: { in: [ordinaryUserId, secondAdminId] } } });
  }

  await assertHistoricalAdminBackfill(actor.id);
});
