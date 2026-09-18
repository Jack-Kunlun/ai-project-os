import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
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

async function seedLegacyProbeEvidence(client: Client): Promise<Readonly<{ settledAttemptId: string; rejectedAttemptId: string; providerConnectionId: string }>> {
  const actorId = randomUUID();
  const credentialId = randomUUID();
  const providerConnectionId = randomUUID();
  const budgetId = randomUUID();
  const settledAttemptId = randomUUID();
  const rejectedAttemptId = randomUUID();
  const settledRequestKey = "a".repeat(64);
  const settledRequestFingerprint = "b".repeat(64);
  const settledCredentialFingerprint = "c".repeat(64);
  const rejectedRequestKey = "d".repeat(64);
  const rejectedRequestFingerprint = "e".repeat(64);

  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL ai_project_os.platform_provider_probe_mutation = 'service-v1'");
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    await client.query(`
      INSERT INTO "AppUser" ("id", "username", "role", "accountAccessVersion", "createdAt", "updatedAt")
      VALUES ($1, $2, 'admin', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [actorId, `compat-probe-${actorId.slice(0, 8)}`]);
    await client.query(`
      INSERT INTO "ExternalCredential" ("id", "kind", "ciphertext", "nonce", "authTag", "maskedSuffix", "secretFingerprint", "createdAt", "updatedAt")
      VALUES ($1, 'ai_provider', decode('00', 'hex'), decode('00', 'hex'), decode('00', 'hex'), 'compat', $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [credentialId, "f".repeat(64)]);
    await client.query(`
      INSERT INTO "AiProviderConnection" ("id", "name", "kind", "scope", "protocol", "baseUrl", "credentialId", "defaultGenerationModelId", "configurationVersion", "status", "createdAt", "updatedAt")
      VALUES ($1, 'compat-provider', 'openai', 'platform', 'chat_completions', 'https://example.invalid/v1', $2, 'compat-model', 1, 'verified', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [providerConnectionId, credentialId]);
    await client.query(`
      INSERT INTO "PlatformProviderProbeBudget" ("id", "version", "status", "unitLimit", "alertThresholdUnits", "reservedUnits", "settledUnits", "heldUnits", "startsAt", "expiresAt", "createdById", "createdAt", "updatedAt")
      VALUES ($1, 1, 'draft', 2, 1, 0, 0, 0, CURRENT_TIMESTAMP - INTERVAL '1 minute', CURRENT_TIMESTAMP + INTERVAL '1 hour', $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [budgetId, actorId]);
    await client.query(`
      INSERT INTO "PlatformProviderProbeAttempt" ("id", "budgetId", "providerConnectionId", "actorId", "actorAccountAccessVersion", "providerConfigurationVersion", "credentialSecretFingerprint", "clientRequestKeyHash", "requestFingerprint", "status", "plannedUnits", "dispatchedUnits", "settledUnits", "releasedUnits", "heldUnits", "leaseExpiresAt", "startedAt", "terminalAt", "createdAt", "updatedAt")
      VALUES ($1, $2, $3, $4, 1, 1, $5, $6, $7, 'settled', 1, 1, 1, 0, 0, CURRENT_TIMESTAMP + INTERVAL '1 hour', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [settledAttemptId, budgetId, providerConnectionId, actorId, settledCredentialFingerprint, settledRequestKey, settledRequestFingerprint]);
    for (const [event, ordinal] of [["reserved", 1], ["dispatched", 1], ["settled", 1]] as const) {
      await client.query(`
        INSERT INTO "PlatformProviderProbeLedger" ("id", "budgetId", "attemptId", "actorId", "ordinal", "event", "capability", "units", "createdAt")
        VALUES ($1, $2, $3, $4, $5, $6, 'generation', 1, CURRENT_TIMESTAMP)
      `, [randomUUID(), budgetId, settledAttemptId, actorId, ordinal, event]);
    }
    await client.query(`
      INSERT INTO "PlatformProviderProbeAttempt" ("id", "providerConnectionId", "actorId", "actorAccountAccessVersion", "providerConfigurationVersion", "clientRequestKeyHash", "requestFingerprint", "status", "safeErrorCode", "plannedUnits", "dispatchedUnits", "settledUnits", "releasedUnits", "heldUnits", "leaseExpiresAt", "terminalAt", "createdAt", "updatedAt")
      VALUES ($1, $2, $3, 1, 1, $4, $5, 'rejected', 'PLATFORM_PROVIDER_PROBE_BUDGET_REQUIRED', 0, 0, 0, 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [rejectedAttemptId, providerConnectionId, actorId, rejectedRequestKey, rejectedRequestFingerprint]);
    await client.query(`
      INSERT INTO "PlatformProviderProbeLedger" ("id", "attemptId", "actorId", "ordinal", "event", "units", "safeErrorCode", "createdAt")
      VALUES ($1, $2, $3, 0, 'rejected', 0, 'PLATFORM_PROVIDER_PROBE_BUDGET_REQUIRED', CURRENT_TIMESTAMP)
    `, [randomUUID(), rejectedAttemptId, actorId]);
    await client.query(`UPDATE "PlatformProviderProbeBudget" SET "settledUnits" = 1 WHERE "id" = $1`, [budgetId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
  return { settledAttemptId, rejectedAttemptId, providerConnectionId };
}

test(
  "production upgrade preflight accepts the exact v0.3 schema and upgrades 103 migrations to 105",
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
      const legacyProbeEvidence = await seedLegacyProbeEvidence(client);
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
        probe_subject: string | null;
        consumed_route_id: string | null;
      }>(`
        SELECT (SELECT count(*)::integer FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL) AS migration_count,
               pg_catalog.to_regclass('public."PlatformBootstrap"')::text AS platform_bootstrap,
               pg_catalog.to_regclass('public."ProjectAiRoute"')::text AS project_ai_route,
               pg_catalog.to_regclass('public."ProjectAiRouteRevision"')::text AS project_ai_route_revision,
               pg_catalog.to_regclass('public."AiProviderOwnershipAudit"')::text AS ownership_audit,
               (SELECT attribute_meta.atttypid::regtype::text
                  FROM pg_catalog.pg_attribute attribute_meta
                  JOIN pg_catalog.pg_class relation_meta ON relation_meta.oid = attribute_meta.attrelid
                 WHERE relation_meta.relnamespace = 'public'::pg_catalog.regnamespace
                   AND relation_meta.relname = 'PlatformProviderProbeAttempt'
                   AND attribute_meta.attname = 'subject'
                   AND attribute_meta.attnum > 0
                   AND NOT attribute_meta.attisdropped) AS probe_subject,
               (SELECT attribute_meta.atttypid::regtype::text
                  FROM pg_catalog.pg_attribute attribute_meta
                  JOIN pg_catalog.pg_class relation_meta ON relation_meta.oid = attribute_meta.attrelid
                 WHERE relation_meta.relnamespace = 'public'::pg_catalog.regnamespace
                   AND relation_meta.relname = 'PlatformProviderProbeAttempt'
                   AND attribute_meta.attname = 'consumedRouteId'
                   AND attribute_meta.attnum > 0
                   AND NOT attribute_meta.attisdropped) AS consumed_route_id
      `);
      assert.deepEqual(upgraded.rows, [{
        migration_count: 105,
        platform_bootstrap: '"PlatformBootstrap"',
        project_ai_route: null,
        project_ai_route_revision: null,
        ownership_audit: null,
        probe_subject: '"PlatformProviderProbeSubject"',
        consumed_route_id: 'uuid',
      }]);

      const preservedEvidence = await client.query<{
        id: string;
        status: string;
        subject: string;
        provider_connection_id: string | null;
        ledger_count: number;
      }>(`
        SELECT attempt."id",
               attempt."status"::text AS status,
               attempt."subject"::text AS subject,
               attempt."providerConnectionId"::text AS provider_connection_id,
               count(ledger."id")::integer AS ledger_count
          FROM "PlatformProviderProbeAttempt" AS attempt
          LEFT JOIN "PlatformProviderProbeLedger" AS ledger ON ledger."attemptId" = attempt."id"
         WHERE attempt."id" IN ($1, $2)
         GROUP BY attempt."id", attempt."status", attempt."subject", attempt."providerConnectionId"
         ORDER BY attempt."id"
      `, [legacyProbeEvidence.rejectedAttemptId, legacyProbeEvidence.settledAttemptId]);
      assert.deepEqual(
        preservedEvidence.rows.map((row) => ({ ...row, provider_connection_id: row.provider_connection_id ?? null })),
        [
          {
            id: legacyProbeEvidence.rejectedAttemptId,
            status: "rejected",
            subject: "savedConnection",
            provider_connection_id: legacyProbeEvidence.providerConnectionId,
            ledger_count: 1,
          },
          {
            id: legacyProbeEvidence.settledAttemptId,
            status: "settled",
            subject: "savedConnection",
            provider_connection_id: legacyProbeEvidence.providerConnectionId,
            ledger_count: 3,
          },
        ].sort((left, right) => left.id.localeCompare(right.id)),
      );
      const constraints = await client.query<{ conname: string; contype: string; convalidated: boolean }>(`
        SELECT constraint_meta.conname,
               constraint_meta.contype,
               constraint_meta.convalidated
          FROM pg_catalog.pg_constraint AS constraint_meta
         WHERE constraint_meta.conrelid = 'public."PlatformProviderProbeAttempt"'::regclass
           AND constraint_meta.conname IN (
             'PlatformProviderProbeAttempt_provider_fkey',
             'PlatformProviderProbeAttempt_consumed_route_fkey',
             'PlatformProviderProbeAttempt_shape_check'
           )
         ORDER BY constraint_meta.conname
      `);
      assert.deepEqual(constraints.rows, [
        { conname: "PlatformProviderProbeAttempt_consumed_route_fkey", contype: "f", convalidated: true },
        { conname: "PlatformProviderProbeAttempt_provider_fkey", contype: "f", convalidated: true },
        { conname: "PlatformProviderProbeAttempt_shape_check", contype: "c", convalidated: true },
      ]);
    } finally {
      await client.end();
    }
  },
);

test(
  "production upgrade applies exactly the two additive v0.4 migrations after the 103-entry source ledger",
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
      const sourceMigrationNames = await migrationNamesThrough("20260917010000_add_platform_bootstrap");
      assert.equal(sourceMigrationNames.length, 103);
      assert.deepEqual(sourceMigrationNames, LEGACY_MIGRATION_MANIFEST.map((entry) => entry.name));
      await installMigrationSnapshot(compatibilityUrl.toString(), temporaryPrismaRoot, sourceMigrationNames);

      await execFile("pnpm", ["exec", "prisma", "migrate", "deploy", "--config", "prisma.config.ts"], {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: compatibilityUrl.toString() },
      });

      const compatibilityClient = new Client({ connectionString: compatibilityUrl.toString(), connectionTimeoutMillis: 5_000 });
      await compatibilityClient.connect();
      try {
        const result = await compatibilityClient.query<{ migration_count: number; target_migrations: string[] }>(`
          SELECT
            (SELECT count(*)::integer FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL) AS migration_count,
            (
              SELECT COALESCE(
                jsonb_agg(migration."migration_name" ORDER BY migration."migration_name"),
                '[]'::jsonb
              )
              FROM "_prisma_migrations" AS migration
              WHERE migration."migration_name" IN (
                '20260918020000_generalize_platform_probe_evidence',
                '20260918023000_add_platform_route_consumption_reference'
              )
            ) AS target_migrations
        `);
        assert.deepEqual(result.rows, [{
          migration_count: 105,
          target_migrations: [
            "20260918020000_generalize_platform_probe_evidence",
            "20260918023000_add_platform_route_consumption_reference",
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
