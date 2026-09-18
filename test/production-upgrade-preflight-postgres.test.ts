import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { Client } from "pg";
import {
  LEGACY_MIGRATION_MANIFEST,
  PRODUCTION_UPGRADE_CLUSTER_ADMIN_ROLE,
} from "../scripts/production-upgrade-preflight-contract";
import { runProductionUpgradePreflight } from "../scripts/production-upgrade-preflight";

const shouldRun = process.env.PRODUCTION_UPGRADE_PREFLIGHT_POSTGRES_GATE === "1";
const configuredUrl = process.env.PRODUCTION_UPGRADE_PREFLIGHT_TEST_DATABASE_URL;
const testDatabaseName = "ai_project_os_production_preflight_test";
const compatibilityDatabaseName = "ai_project_os_production_preflight_compat_test";
const cleanSlateFenceMigration = "20260910005000_fence_clean_slate_transition";
const execFile = promisify(execFileCallback);

function testDatabaseUrl(): string {
  if (typeof configuredUrl !== "string" || configuredUrl.length === 0) {
    throw new Error("PRODUCTION_UPGRADE_PREFLIGHT_TEST_DATABASE_URL_REQUIRED");
  }
  const parsed = new URL(configuredUrl);
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol)
    || !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname.toLowerCase())
    || parsed.port !== "56432"
    || parsed.pathname !== `/${testDatabaseName}`
    || parsed.username !== "ai_project_os_gate"
    || parsed.password.length === 0
    || parsed.search !== ""
    || parsed.hash !== ""
  ) throw new Error("PRODUCTION_UPGRADE_PREFLIGHT_TEST_DATABASE_URL_INVALID");
  return parsed.toString();
}

function testDatabaseAdminUrl(): string {
  const configuredAdminUrl = process.env.POSTGRES_GATE_ADMIN_URL;
  if (typeof configuredAdminUrl !== "string" || configuredAdminUrl.length === 0) {
    throw new Error("POSTGRES_GATE_ADMIN_URL_REQUIRED");
  }
  const parsed = new URL(configuredAdminUrl);
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol)
    || !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname.toLowerCase())
    || parsed.port !== "56432"
    || parsed.pathname !== "/postgres"
    || parsed.username.length === 0
    || parsed.password.length === 0
    || parsed.search !== ""
    || parsed.hash !== ""
  ) throw new Error("POSTGRES_GATE_ADMIN_URL_INVALID");
  parsed.pathname = `/${testDatabaseName}`;
  return parsed.toString();
}

async function prepareOid10ExtensionOwner(databaseUrl: string): Promise<string> {
  const admin = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  await admin.connect();
  try {
    const session = await admin.query<{ session_user: string; session_oid: string; is_superuser: boolean }>(`
      SELECT session_user,
             (SELECT oid::text FROM pg_authid WHERE rolname = session_user) AS session_oid,
             (SELECT rolsuper FROM pg_authid WHERE rolname = session_user) AS is_superuser
    `);
    const sessionRow = session.rows[0];
    assert.equal(sessionRow?.session_oid, "10");
    assert.equal(sessionRow?.is_superuser, true);
    for (const extension of ["vector", "pg_trgm", "pgcrypto"] as const) {
      await admin.query(`CREATE EXTENSION IF NOT EXISTS "${extension}" WITH SCHEMA public`);
    }
    const extensions = await admin.query<{ extension_name: string; schema_name: string; owner_name: string; owner_oid: string }>(`
      SELECT extension_row.extname AS extension_name,
             namespace.nspname AS schema_name,
             pg_get_userbyid(extension_row.extowner) AS owner_name,
             extension_row.extowner::text AS owner_oid
        FROM pg_extension extension_row
        JOIN pg_namespace namespace ON namespace.oid = extension_row.extnamespace
       ORDER BY extension_row.extname
    `);
    assert.deepEqual(
      extensions.rows.map((row) => [row.extension_name, row.schema_name, row.owner_name, row.owner_oid]),
      [
        ["pg_trgm", "public", sessionRow?.session_user, "10"],
        ["pgcrypto", "public", sessionRow?.session_user, "10"],
        ["plpgsql", "pg_catalog", sessionRow?.session_user, "10"],
        ["vector", "public", sessionRow?.session_user, "10"],
      ],
    );
    return sessionRow?.session_user ?? "";
  } finally {
    await admin.end();
  }
}

function queryClient(client: Client) {
  return {
    query: async <Row = unknown>(text: string, values?: readonly unknown[]) => {
      const result = await client.query(text, values === undefined ? undefined : [...values]);
      return { rows: result.rows as readonly Row[] };
    },
  };
}

async function migrationNamesThrough(cutoff?: string): Promise<string[]> {
  return (await readdir(resolve(process.cwd(), "prisma/migrations"), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^\d{14}_[a-z0-9_]+$/u.test(entry.name))
    .map((entry) => entry.name)
    .filter((name) => cutoff === undefined || name <= cutoff)
    .sort();
}

async function installMigrationSnapshot(
  databaseUrl: string,
  temporaryPrismaRoot: string,
  migrationNames: readonly string[],
): Promise<void> {
  const migrationsRoot = resolve(temporaryPrismaRoot, "migrations");
  await mkdir(migrationsRoot, { recursive: true });
  await cp(resolve(process.cwd(), "prisma/schema.prisma"), resolve(temporaryPrismaRoot, "schema.prisma"));
  await cp(resolve(process.cwd(), "prisma/migrations/migration_lock.toml"), resolve(migrationsRoot, "migration_lock.toml"));
  for (const name of migrationNames) {
    await cp(
      resolve(process.cwd(), "prisma/migrations", name),
      resolve(migrationsRoot, name),
      { recursive: true },
    );
  }
  const configPath = resolve(temporaryPrismaRoot, "prisma.config.ts");
  await writeFile(configPath, `
import { defineConfig } from "prisma/config";
export default defineConfig({
  schema: "schema.prisma",
  migrations: { path: "migrations" },
  datasource: { url: process.env.DATABASE_URL },
});
`, { mode: 0o600 });
  await execFile("pnpm", ["exec", "prisma", "migrate", "deploy", "--config", configPath], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
}

async function installLegacySchema(databaseUrl: string, temporaryPrismaRoot: string): Promise<void> {
  await installMigrationSnapshot(databaseUrl, temporaryPrismaRoot, LEGACY_MIGRATION_MANIFEST.map((entry) => entry.name));
}

test(
  "production upgrade preflight accepts the exact v0.2 schema and upgrades 102 migrations to 103",
  { skip: !shouldRun ? "PRODUCTION_UPGRADE_PREFLIGHT_POSTGRES_GATE=1 is required" : false },
  async (context) => {
    const url = testDatabaseUrl();
    const pinnedAdminUrl = testDatabaseAdminUrl();
    const cacheRoot = resolve(process.cwd(), "node_modules/.cache");
    await mkdir(cacheRoot, { recursive: true });
    const temporaryPrismaRoot = await mkdtemp(resolve(cacheRoot, "production-preflight-prisma-"));
    context.after(async () => {
      await rm(temporaryPrismaRoot, { recursive: true, force: true });
    });
    const pinnedAdminRole = await prepareOid10ExtensionOwner(pinnedAdminUrl);
    const client = new Client({ connectionString: pinnedAdminUrl, connectionTimeoutMillis: 5_000 });
    await client.connect();
    try {
      await installLegacySchema(url, temporaryPrismaRoot);
      const preflightOptions = { legacyRole: pinnedAdminRole } as const;
      const expectedDatabasePrincipal = pinnedAdminRole === PRODUCTION_UPGRADE_CLUSTER_ADMIN_ROLE
        ? "cluster-admin-owned"
        : "pinned-oid10-extension-owners-supported";

      const preStop = await runProductionUpgradePreflight(queryClient(client), "pre-stop", preflightOptions);
      assert.equal(preStop.checks.databasePrincipal, expectedDatabasePrincipal);
      assert.equal(preStop.checks.rollback, "verified");
      const afterRollback = await client.query<{ transaction_read_only: string; transaction_isolation: string }>(`
        SELECT current_setting('transaction_read_only') AS transaction_read_only,
               current_setting('transaction_isolation') AS transaction_isolation
      `);
      assert.deepEqual(afterRollback.rows, [{ transaction_read_only: "off", transaction_isolation: "read committed" }]);

      const memberRole = await client.query<{ has_member: boolean }>(`
        SELECT EXISTS (
          SELECT 1
            FROM pg_catalog.pg_enum AS enum_value
            JOIN pg_catalog.pg_type AS enum_type
              ON enum_type.oid = enum_value.enumtypid
           WHERE enum_type.typname = 'AppUserRole'
             AND enum_value.enumlabel = 'member'
        ) AS has_member
      `);
      assert.deepEqual(memberRole.rows, [{ has_member: false }]);

      const sameDatabaseBackend = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
      await sameDatabaseBackend.connect();
      try {
        await assert.rejects(
          () => runProductionUpgradePreflight(queryClient(client), "post-stop", preflightOptions),
          /PRODUCTION_UPGRADE_PREFLIGHT_CLIENT_BACKENDS_PRESENT/u,
        );
      } finally {
        await sameDatabaseBackend.end();
      }

      let lateBackend: Client | undefined;
      const lateBackendAdapter = {
        query: async <Row = unknown>(text: string, values?: readonly unknown[]) => {
          const result = await client.query(text, values === undefined ? undefined : [...values]);
          if (text === "ROLLBACK") {
            lateBackend = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
            await lateBackend.connect();
          }
          return { rows: result.rows as readonly Row[] };
        },
      };
      try {
        await assert.rejects(
          () => runProductionUpgradePreflight(lateBackendAdapter, "post-stop", preflightOptions),
          /PRODUCTION_UPGRADE_PREFLIGHT_CLIENT_BACKENDS_PRESENT/u,
        );
      } finally {
        await lateBackend?.end();
      }

      const adminDatabaseUrl = new URL(url);
      adminDatabaseUrl.pathname = "/postgres";
      const otherDatabaseBackend = new Client({ connectionString: adminDatabaseUrl.toString(), connectionTimeoutMillis: 5_000 });
      await otherDatabaseBackend.connect();
      try {
      const postStop = await runProductionUpgradePreflight(queryClient(client), "post-stop", preflightOptions);
        assert.equal(postStop.checks.databasePrincipal, expectedDatabasePrincipal);
        assert.equal(postStop.checks.clientBackends, "clear");
        assert.equal(postStop.checks.rollback, "verified");
      } finally {
        await otherDatabaseBackend.end();
      }

      await cp(
        resolve(process.cwd(), "prisma/migrations/20260917010000_add_platform_bootstrap"),
        resolve(temporaryPrismaRoot, "migrations/20260917010000_add_platform_bootstrap"),
        { recursive: true },
      );

      await execFile("pnpm", ["exec", "prisma", "migrate", "deploy", "--config", "prisma.config.ts"], {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: url },
      });
      const upgraded = await client.query<{
        migration_count: number;
        platform_bootstrap: string | null;
        project_ai_route: string | null;
        project_ai_route_revision: string | null;
        ownership_audit: string | null;
        member_role: boolean;
        workspace_id_column: boolean;
      }>(`
        SELECT (SELECT count(*)::integer FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL) AS migration_count,
               pg_catalog.to_regclass('public."PlatformBootstrap"')::text AS platform_bootstrap,
               pg_catalog.to_regclass('public."ProjectAiRoute"')::text AS project_ai_route,
               pg_catalog.to_regclass('public."ProjectAiRouteRevision"')::text AS project_ai_route_revision,
               pg_catalog.to_regclass('public."AiProviderOwnershipAudit"')::text AS ownership_audit,
               EXISTS (
                 SELECT 1 FROM pg_catalog.pg_enum enum_value
                 JOIN pg_catalog.pg_type enum_type ON enum_type.oid = enum_value.enumtypid
                 WHERE enum_type.typname = 'AppUserRole' AND enum_value.enumlabel = 'member'
               ) AS member_role,
               EXISTS (
                 SELECT 1 FROM pg_catalog.pg_attribute attribute_meta
                 JOIN pg_catalog.pg_class relation_meta ON relation_meta.oid = attribute_meta.attrelid
                 WHERE relation_meta.relnamespace = 'public'::pg_catalog.regnamespace
                   AND relation_meta.relname = 'AiProviderConnection'
                   AND attribute_meta.attname = 'workspaceId'
                   AND attribute_meta.attnum > 0
                   AND NOT attribute_meta.attisdropped
               ) AS workspace_id_column
      `);
      assert.deepEqual(upgraded.rows, [{
        migration_count: 103,
        platform_bootstrap: '"PlatformBootstrap"',
        project_ai_route: null,
        project_ai_route_revision: null,
        ownership_audit: null,
        member_role: false,
        workspace_id_column: false,
      }]);
    } finally {
      await client.end();
    }
  },
);

test(
  "production upgrade fence is a safe 102 to 103 compatibility migration after clean-slate",
  { skip: !shouldRun ? "PRODUCTION_UPGRADE_PREFLIGHT_POSTGRES_GATE=1 is required" : false },
  async (context) => {
    const sourceUrl = new URL(testDatabaseUrl());
    const adminUrl = new URL(sourceUrl);
    adminUrl.pathname = "/postgres";
    const compatibilityUrl = new URL(sourceUrl);
    compatibilityUrl.pathname = `/${compatibilityDatabaseName}`;
    const admin = new Client({ connectionString: adminUrl.toString(), connectionTimeoutMillis: 5_000 });
    const cacheRoot = resolve(process.cwd(), "node_modules/.cache");
    await mkdir(cacheRoot, { recursive: true });
    const temporaryPrismaRoot = await mkdtemp(resolve(cacheRoot, "production-preflight-compat-prisma-"));
    context.after(async () => {
      await rm(temporaryPrismaRoot, { recursive: true, force: true });
    });

    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${compatibilityDatabaseName}" WITH (FORCE)`);
      await admin.query(`CREATE DATABASE "${compatibilityDatabaseName}" OWNER "ai_project_os_gate"`);
      const originalMigrationNames = (await migrationNamesThrough()).filter((name) => name !== cleanSlateFenceMigration);
      assert.equal(originalMigrationNames.length, 102);
      await installMigrationSnapshot(compatibilityUrl.toString(), temporaryPrismaRoot, originalMigrationNames);

      await execFile("pnpm", ["exec", "prisma", "migrate", "deploy", "--config", "prisma.config.ts"], {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: compatibilityUrl.toString() },
      });

      const compatibilityClient = new Client({ connectionString: compatibilityUrl.toString(), connectionTimeoutMillis: 5_000 });
      await compatibilityClient.connect();
      try {
        const result = await compatibilityClient.query<{ migration_count: number; trigger_names: string[] }>(`
          SELECT
            (SELECT count(*)::integer FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL) AS migration_count,
            (
              SELECT COALESCE(
                jsonb_agg(trigger_meta.tgname ORDER BY trigger_meta.tgname),
                '[]'::jsonb
              )
              FROM pg_catalog.pg_trigger AS trigger_meta
              WHERE NOT trigger_meta.tgisinternal
                AND trigger_meta.tgname LIKE '%clean_slate_transition_write_fence'
            ) AS trigger_names
        `);
        assert.deepEqual(result.rows, [{
          migration_count: 103,
          trigger_names: [
            "AiProviderConnection_clean_slate_transition_write_fence",
            "AppUser_clean_slate_transition_write_fence",
          ],
        }]);
      } finally {
        await compatibilityClient.end();
      }
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS "${compatibilityDatabaseName}" WITH (FORCE)`);
      await admin.end();
    }
  },
);
