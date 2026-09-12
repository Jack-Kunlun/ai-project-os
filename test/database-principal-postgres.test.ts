import "dotenv/config";
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import { Client } from "pg";
import { initializeAdmin } from "../src/lib/auth";
import { getDb, getEntitlementDb } from "../src/lib/db";
import {
  changePlatformGrantOfferPolicyLifecycle,
  createPlatformGrantOfferPolicy,
  type PlatformGrantOfferPolicyActor,
} from "../src/lib/platform-grant-offer-policy-service";
import {
  reservePlatformTokens,
  settlePlatformTokenReservation,
} from "../src/lib/ai-entitlements";
import { grantWorkspaceMembership } from "../src/lib/membership-governance";
import {
  executeWorkspaceRoleMutation,
  previewWorkspaceRoleMutation,
  WorkspaceRoleGovernanceError,
} from "../src/lib/workspace-role-governance-service";
import {
  DATABASE_PRINCIPAL_INVOKER_FUNCTION_MATRIX,
  DATABASE_PRINCIPAL_RELATIONS,
} from "../src/lib/database-principal-catalog";

const execFile = promisify(execFileCallback);
const shouldRun = process.env.DATABASE_PRINCIPAL_POSTGRES_GATE === "1";
const databaseUrl = process.env.DATABASE_URL;
const adminUrl = process.env.POSTGRES_GATE_ADMIN_URL;
const clusterAdminRole = "ai_project_os_cluster_admin";
const runtimeRole = "ai_project_os_runtime";
const migratorRole = "ai_project_os_migrator";
const writerRole = "ai_project_os_entitlement_writer";
const repositoryRoot = process.cwd();

function targetAdminUrl(): string {
  if (typeof adminUrl !== "string" || typeof databaseUrl !== "string") throw new Error("DATABASE_PRINCIPAL_GATE_URL_REQUIRED");
  const target = new URL(adminUrl);
  target.pathname = new URL(databaseUrl).pathname;
  target.username = clusterAdminRole;
  return target.toString();
}

function configuredGateAdminUrl(): string {
  if (typeof adminUrl !== "string" || typeof databaseUrl !== "string") throw new Error("DATABASE_PRINCIPAL_GATE_URL_REQUIRED");
  const target = new URL(adminUrl);
  target.pathname = new URL(databaseUrl).pathname;
  return target.toString();
}

async function ensureClusterAdminForGate(): Promise<void> {
  const configured = new URL(configuredGateAdminUrl());
  const password = decodeURIComponent(configured.password);
  const bootstrap = new Client({ connectionString: configured.toString(), connectionTimeoutMillis: 5_000 });
  await bootstrap.connect();
  try {
    await bootstrap.query("SET default_transaction_read_only = off");
    await bootstrap.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${quoteLiteral(clusterAdminRole)}) THEN CREATE ROLE ${quoteIdentifier(clusterAdminRole)} LOGIN SUPERUSER CREATEDB CREATEROLE PASSWORD ${quoteLiteral(password)}; END IF; END $$`);
    await bootstrap.query(`ALTER ROLE ${quoteIdentifier(clusterAdminRole)} WITH LOGIN SUPERUSER CREATEDB CREATEROLE INHERIT NOREPLICATION NOBYPASSRLS PASSWORD ${quoteLiteral(password)}`);
  } finally {
    await bootstrap.end();
  }
}

function roleUrl(role: string, password: string): string {
  if (typeof databaseUrl !== "string") throw new Error("DATABASE_PRINCIPAL_GATE_DATABASE_URL_REQUIRED");
  const target = new URL(databaseUrl);
  target.username = role;
  target.password = password;
  target.search = "";
  target.hash = "";
  return target.toString();
}

function quoteIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) throw new Error("DATABASE_PRINCIPAL_IDENTIFIER_INVALID");
  return `"${value}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function reportCleanupFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[database-principal-postgres] cleanup failed: ${message}`);
}

async function roleExists(admin: Client, role: string): Promise<boolean> {
  const result = await admin.query<{ exists: boolean }>("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists", [role]);
  return result.rows[0]?.exists === true;
}

async function dropRole(admin: Client, role: string): Promise<void> {
  await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = $1 AND pid <> pg_backend_pid()", [role]);
  await admin.query(`DROP OWNED BY ${quoteIdentifier(role)}`).catch(reportCleanupFailure);
  await admin.query(`DROP ROLE IF EXISTS ${quoteIdentifier(role)}`);
}

async function expectPermissionDenied(action: () => Promise<unknown>): Promise<void> {
  await assert.rejects(action, (error: unknown) => ["42501", "55006"].includes(errorCode(error) ?? ""));
}

async function assertInvokerHelperAcls(admin: Client): Promise<void> {
  const helperNames = [...new Set(DATABASE_PRINCIPAL_INVOKER_FUNCTION_MATRIX.map((helper) => helper.name))];
  const expectedOids = new Set<string>();
  const rows = await admin.query<{ oid: string; name: string }>(`
    SELECT p.oid::text AS oid, p.proname AS name
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prokind = 'f'
       AND p.proname = ANY($1::text[])
  `, [helperNames]);
  assert.equal(rows.rows.length, DATABASE_PRINCIPAL_INVOKER_FUNCTION_MATRIX.length);
  for (const helper of DATABASE_PRINCIPAL_INVOKER_FUNCTION_MATRIX) {
    const signature = `public.${quoteIdentifier(helper.name)}(${helper.identityArguments})`;
    const result = await admin.query<{
      oid: string;
      identity_arguments: string;
      runtime_execute: boolean;
      runtime_direct: boolean;
      writer_execute: boolean;
      writer_direct: boolean;
      public_execute: boolean;
      owner: string | null;
      prosecdef: boolean;
    }>(`
      SELECT p.oid::text AS oid,
             pg_get_function_identity_arguments(p.oid) AS identity_arguments,
             has_function_privilege($1, $3, 'EXECUTE') AS runtime_execute,
             EXISTS (
               SELECT 1
                 FROM pg_proc acl_proc
                 CROSS JOIN LATERAL aclexplode(COALESCE(acl_proc.proacl, acldefault('f', acl_proc.proowner))) privilege
                WHERE acl_proc.oid = p.oid
                  AND privilege.grantee = (SELECT oid FROM pg_roles WHERE rolname = $1)
                  AND privilege.privilege_type = 'EXECUTE'
             ) AS runtime_direct,
             has_function_privilege($2, $3, 'EXECUTE') AS writer_execute,
             EXISTS (
               SELECT 1
                 FROM pg_proc acl_proc
                 CROSS JOIN LATERAL aclexplode(COALESCE(acl_proc.proacl, acldefault('f', acl_proc.proowner))) privilege
                WHERE acl_proc.oid = p.oid
                  AND privilege.grantee = (SELECT oid FROM pg_roles WHERE rolname = $2)
                  AND privilege.privilege_type = 'EXECUTE'
             ) AS writer_direct,
             EXISTS (
               SELECT 1
                 FROM pg_proc acl_proc
                 CROSS JOIN LATERAL aclexplode(COALESCE(acl_proc.proacl, acldefault('f', acl_proc.proowner))) privilege
                WHERE acl_proc.oid = p.oid
                  AND privilege.grantee = 0::oid
                  AND privilege.privilege_type = 'EXECUTE'
             ) AS public_execute,
             pg_get_userbyid(p.proowner) AS owner,
             p.prosecdef
        FROM pg_proc p
       WHERE p.oid = pg_catalog.to_regprocedure($3)
    `, [runtimeRole, writerRole, signature]);
    const row = result.rows[0];
    assert.ok(row, `missing invoker helper ${signature}`);
    expectedOids.add(row.oid);
    assert.equal(row.owner, migratorRole, signature);
    assert.equal(row.prosecdef, false, signature);
    assert.equal(row.public_execute, false, signature);
    assert.equal(row.runtime_execute, helper.runtime, signature);
    assert.equal(row.runtime_direct, helper.runtime, signature);
    assert.equal(row.writer_execute, helper.entitlementWriter, signature);
    assert.equal(row.writer_direct, helper.entitlementWriter, signature);
  }
  assert.ok(rows.rows.every((row) => expectedOids.has(row.oid)));
  assert.equal(DATABASE_PRINCIPAL_INVOKER_FUNCTION_MATRIX.filter((helper) => helper.runtime).length, 42);
  assert.equal(DATABASE_PRINCIPAL_INVOKER_FUNCTION_MATRIX.filter((helper) => helper.entitlementWriter).length, 8);
}

async function runPrincipalBootstrap(
  runtimePassword: string,
  migratorPassword: string,
  writerPassword: string,
  bootstrapConnectionString?: string,
): Promise<void> {
  await ensureClusterAdminForGate();
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_PRINCIPAL_ADMIN_URL: targetAdminUrl(),
    DATABASE_URL: roleUrl(runtimeRole, runtimePassword),
    ENTITLEMENT_DATABASE_URL: roleUrl(writerRole, writerPassword),
    MIGRATOR_DATABASE_URL: roleUrl(migratorRole, migratorPassword),
    POSTGRES_ENTITLEMENT_INVENTORY_READER_PASSWORD: `Inventory_${randomUUID().replaceAll("-", "")}`,
  };
  if (bootstrapConnectionString !== undefined) environment.DATABASE_PRINCIPAL_LEGACY_BOOTSTRAP_URL = bootstrapConnectionString;
  await execFile(
    process.execPath,
    ["node_modules/tsx/dist/cli.mjs", "scripts/reconcile-database-principals.ts", "--bootstrap-if-needed"],
    { cwd: repositoryRoot, env: environment, maxBuffer: 1_024 * 1_024 },
  );
}

async function runMigrations(migratorPassword: string): Promise<void> {
  const migratorUrl = roleUrl(migratorRole, migratorPassword);
  await execFile(
    process.execPath,
    ["node_modules/prisma/build/index.js", "migrate", "deploy", "--config", "prisma.config.ts"],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        DATABASE_URL: migratorUrl,
        MIGRATOR_DATABASE_URL: migratorUrl,
      },
      maxBuffer: 1_024 * 1_024,
    },
  );
}

async function runProductionReconcile(
  runtimePassword: string,
  migratorPassword: string,
  writerPassword: string,
): Promise<void> {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_PRINCIPAL_ADMIN_URL: targetAdminUrl(),
    DATABASE_URL: roleUrl(runtimeRole, runtimePassword),
    ENTITLEMENT_DATABASE_URL: roleUrl(writerRole, writerPassword),
    MIGRATOR_DATABASE_URL: roleUrl(migratorRole, migratorPassword),
    POSTGRES_ENTITLEMENT_INVENTORY_READER_PASSWORD: `Inventory_${randomUUID().replaceAll("-", "")}`,
  };
  delete environment.DATABASE_PRINCIPAL_LEGACY_BOOTSTRAP_URL;
  await execFile(
    process.execPath,
    ["node_modules/tsx/dist/cli.mjs", "scripts/reconcile-database-principals.ts"],
    { cwd: repositoryRoot, env: environment, maxBuffer: 1_024 * 1_024 },
  );
}

async function transferPublicOwnership(admin: Client, sourceOwner: string, owner: string): Promise<void> {
  const database = await admin.query<{ datname: string }>("SELECT current_database() AS datname");
  const databaseName = database.rows[0]?.datname;
  assert.ok(databaseName);
  let firstError: unknown;
  try {
    // Reassign as one operation so extension members cannot interrupt an
    // object-by-object transfer and leave the fixture half moved.
    await admin.query(`REASSIGN OWNED BY ${quoteIdentifier(sourceOwner)} TO ${quoteIdentifier(owner)}`);
  } catch (error) {
    firstError = error;
  }
  for (const statement of [
    `ALTER DATABASE ${quoteIdentifier(databaseName)} OWNER TO ${quoteIdentifier(owner)}`,
    `ALTER SCHEMA public OWNER TO ${quoteIdentifier(owner)}`,
  ]) {
    try {
      await admin.query(statement);
    } catch (error) {
      if (firstError === undefined) firstError = error;
    }
  }
  if (firstError !== undefined) throw firstError;
}

async function findRepresentativeOwnedObjects(admin: Client, owner: string): Promise<{ functionOid: string; typeOid: string }> {
  const result = await admin.query<{ functionOid: string | null; typeOid: string | null }>(`
    SELECT
      (SELECT p.oid::text
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         JOIN pg_roles r ON r.oid = p.proowner
        WHERE n.nspname = 'public' AND r.rolname = $1 AND p.proname NOT LIKE 'pg_%'
        ORDER BY p.oid
        LIMIT 1) AS "functionOid",
      (SELECT t.oid::text
         FROM pg_type t
         JOIN pg_namespace n ON n.oid = t.typnamespace
         JOIN pg_roles r ON r.oid = t.typowner
        WHERE n.nspname = 'public' AND r.rolname = $1 AND t.typtype IN ('c', 'd', 'e') AND t.typname NOT LIKE '\\_%'
        ORDER BY t.oid
        LIMIT 1) AS "typeOid"
  `, [owner]);
  const row = result.rows[0];
  assert.ok(row?.functionOid);
  assert.ok(row.typeOid);
  return { functionOid: row.functionOid, typeOid: row.typeOid };
}

test("database principal gate requires the explicit isolated environment", {
  skip: !shouldRun ? "DATABASE_PRINCIPAL_POSTGRES_GATE=1 is required" : false,
}, () => {
  assert.ok(databaseUrl);
  assert.ok(adminUrl);
});

test("legacy owner bootstrap preserves representative grant and ledger data", {
  skip: !shouldRun || databaseUrl === undefined || adminUrl === undefined
    ? "explicit disposable PostgreSQL gate is required"
    : false,
}, async () => {
  const admin = new Client({ connectionString: targetAdminUrl(), connectionTimeoutMillis: 5_000 });
  const runtimePassword = `Runtime_${randomUUID().replaceAll("-", "")}`;
  const migratorPassword = `Migrator_${randomUUID().replaceAll("-", "")}`;
  const writerPassword = `Writer_${randomUUID().replaceAll("-", "")}`;
  const legacyPassword = `Legacy_${randomUUID().replaceAll("-", "")}`;
  const legacyRole = `ai_project_os_legacy_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const legacyMemberRole = `ai_project_os_legacy_member_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const legacyParentRole = `ai_project_os_legacy_parent_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const runtimeFunctionName = `ent009_runtime_fn_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const writerTypeName = `ent009_writer_type_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const driftSequenceName = `ent009_drift_seq_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const bypassPassword = `Bypass_${randomUUID().replaceAll("-", "")}`;
  const bypassRole = `ai_project_os_bypass_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const bypassFunctionName = `ent009_bypass_fn_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const bypassTypeName = `ent009_bypass_type_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const externalDatabaseName = `ent009_external_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const userId = randomUUID();
  const now = new Date("2026-09-11T00:00:00.000Z");
  let initialDatabaseOwner: string | null = null;
  let cleanupAssertionError: unknown;
  try {
    await ensureClusterAdminForGate();
    await admin.connect();
    const databaseOwner = await admin.query<{ owner: string }>(`
      SELECT pg_get_userbyid(d.datdba) AS owner
        FROM pg_database d
       WHERE d.datname = current_database()
    `);
    initialDatabaseOwner = databaseOwner.rows[0]?.owner ?? null;
    assert.ok(initialDatabaseOwner);

    await admin.query(`CREATE ROLE ${quoteIdentifier(legacyRole)} LOGIN SUPERUSER PASSWORD ${quoteLiteral(legacyPassword)}`);
    await admin.query(`CREATE ROLE ${quoteIdentifier(legacyMemberRole)} NOLOGIN`);
    await admin.query(`CREATE ROLE ${quoteIdentifier(legacyParentRole)} NOLOGIN`);
    await admin.query(`CREATE ROLE ${quoteIdentifier(runtimeRole)} LOGIN REPLICATION PASSWORD ${quoteLiteral(runtimePassword)}`);
    await admin.query(`CREATE ROLE ${quoteIdentifier(writerRole)} LOGIN REPLICATION PASSWORD ${quoteLiteral(writerPassword)}`);
    await admin.query(`CREATE ROLE ${quoteIdentifier(migratorRole)} LOGIN REPLICATION PASSWORD ${quoteLiteral(migratorPassword)}`);
    await admin.query(`ALTER ROLE ${quoteIdentifier(runtimeRole)} SET session_replication_role = 'replica'`);
    await admin.query(`ALTER ROLE ${quoteIdentifier(runtimeRole)} IN DATABASE ${quoteIdentifier((await admin.query<{ datname: string }>("SELECT current_database() AS datname")).rows[0]!.datname)} SET search_path = pg_catalog`);
    await admin.query(`ALTER ROLE ${quoteIdentifier(writerRole)} SET search_path = pg_catalog`);
    await admin.query(`GRANT ${quoteIdentifier(legacyRole)} TO ${quoteIdentifier(legacyMemberRole)}`);
    await admin.query(`GRANT ${quoteIdentifier(legacyParentRole)} TO ${quoteIdentifier(legacyRole)}`);
    await admin.query(`GRANT ${quoteIdentifier(runtimeRole)} TO ${quoteIdentifier(legacyMemberRole)}`);
    await admin.query(`GRANT ${quoteIdentifier(legacyParentRole)} TO ${quoteIdentifier(writerRole)}`);
    await transferPublicOwnership(admin, initialDatabaseOwner, legacyRole);
    await admin.query(`CREATE SEQUENCE public.${quoteIdentifier(driftSequenceName)}`);
    await admin.query(`ALTER SEQUENCE public.${quoteIdentifier(driftSequenceName)} OWNER TO ${quoteIdentifier(legacyRole)}`);
    const targetDatabase = (await admin.query<{ datname: string }>("SELECT current_database() AS datname")).rows[0]?.datname;
    assert.ok(targetDatabase);
    await admin.query(`GRANT CREATE, TEMPORARY ON DATABASE ${quoteIdentifier(targetDatabase)} TO ${quoteIdentifier(runtimeRole)}, ${quoteIdentifier(writerRole)}`);
    await admin.query(`GRANT ALL ON SCHEMA public TO ${quoteIdentifier(runtimeRole)}, ${quoteIdentifier(writerRole)}`);
    await admin.query(`GRANT ALL ON TABLE public."PlatformGrantOfferPolicy" TO ${quoteIdentifier(runtimeRole)}, ${quoteIdentifier(writerRole)}`);
    await admin.query(`GRANT ALL ON SEQUENCE public.${quoteIdentifier(driftSequenceName)} TO ${quoteIdentifier(runtimeRole)}, ${quoteIdentifier(writerRole)}`);
    await admin.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${quoteIdentifier(runtimeRole)} GRANT EXECUTE ON FUNCTIONS TO PUBLIC`);
    await admin.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${quoteIdentifier(runtimeRole)} IN SCHEMA public GRANT ALL ON TABLES TO ${quoteIdentifier(runtimeRole)}`);
    await admin.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${quoteIdentifier(writerRole)} IN SCHEMA public GRANT ALL ON SEQUENCES TO ${quoteIdentifier(writerRole)}`);
    await admin.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${quoteIdentifier(migratorRole)} GRANT EXECUTE ON FUNCTIONS TO PUBLIC`);
    await admin.query(`CREATE DATABASE ${quoteIdentifier(externalDatabaseName)} OWNER ${quoteIdentifier(legacyRole)}`);
    await admin.query(`CREATE FUNCTION public.${quoteIdentifier(runtimeFunctionName)}() RETURNS integer LANGUAGE SQL IMMUTABLE AS 'SELECT 1'`);
    await admin.query(`ALTER FUNCTION public.${quoteIdentifier(runtimeFunctionName)}() OWNER TO ${quoteIdentifier(runtimeRole)}`);
    await admin.query(`CREATE TYPE public.${quoteIdentifier(writerTypeName)} AS ENUM ('legacy')`);
    await admin.query(`ALTER TYPE public.${quoteIdentifier(writerTypeName)} OWNER TO ${quoteIdentifier(writerRole)}`);
    const representativeObjects = await findRepresentativeOwnedObjects(admin, legacyRole);
    const finalOwnedObjectsResult = await admin.query<{ functionOid: string | null; typeOid: string | null }>(`
      SELECT
        (SELECT p.oid::text
           FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = $1) AS "functionOid",
        (SELECT t.oid::text
           FROM pg_type t
           JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE n.nspname = 'public' AND t.typname = $2) AS "typeOid"
    `, [runtimeFunctionName, writerTypeName]);
    const finalOwnedObjects = finalOwnedObjectsResult.rows[0];
    assert.ok(finalOwnedObjects?.functionOid);
    assert.ok(finalOwnedObjects.typeOid);
    const legacy = new Client({ connectionString: roleUrl(legacyRole, legacyPassword), connectionTimeoutMillis: 5_000 });
    try {
      await legacy.connect();
      await legacy.query(`
        INSERT INTO "AppUser" ("id", "username", "role", "updatedAt")
        VALUES ($1, $2, 'user', $3)
      `, [userId, `ent009_legacy_${userId.slice(0, 8)}`, now]);
    } catch (error) {
      await legacy.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      await legacy.end().catch(() => undefined);
    }
    // Exercise recovery after the independently committed NOLOGIN barrier:
    // the old URL remains explicit identity context, but must not be used to
    // authenticate again before the admin resumes the conversion.
    await admin.query(`ALTER ROLE ${quoteIdentifier(legacyRole)} NOLOGIN`);
    await runPrincipalBootstrap(runtimePassword, migratorPassword, writerPassword, roleUrl(legacyRole, legacyPassword));
    const extensionOwners = await admin.query<{ extname: string; owner: string }>(`
      SELECT extension_row.extname, pg_get_userbyid(extension_row.extowner) AS owner
        FROM pg_extension extension_row
       WHERE extension_row.extname <> 'plpgsql'
       ORDER BY extension_row.extname
    `);
    assert.ok(extensionOwners.rows.length > 0);
    assert.ok(extensionOwners.rows.every((row) => row.owner === clusterAdminRole));
    const externalOwner = await admin.query<{ owner: string }>("SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = $1", [externalDatabaseName]);
    assert.deepEqual(externalOwner.rows[0], { owner: "ai_project_os_legacy_bootstrap" });
    const currentOwnerAfterBootstrap = await admin.query<{ owner: string }>("SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = current_database()");
    assert.deepEqual(currentOwnerAfterBootstrap.rows[0], { owner: migratorRole });
    await runMigrations(migratorPassword);
    await runProductionReconcile(runtimePassword, migratorPassword, writerPassword);
    await assertInvokerHelperAcls(admin);
    // A rerun with the retained legacy URL must self-heal/verify through the
    // cluster-admin path after the sealed role has replaced the source OID.
    await runPrincipalBootstrap(runtimePassword, migratorPassword, writerPassword, roleUrl(legacyRole, legacyPassword));

    const retiredRole = await admin.query<{
      rolcanlogin: boolean;
      rolpassword: string | null;
      rolsuper: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolinherit: boolean;
      rolreplication: boolean;
      rolbypassrls: boolean;
    }>(`
      SELECT rolcanlogin, rolpassword, rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolreplication, rolbypassrls
        FROM pg_authid
       WHERE rolname = $1
    `, ["ai_project_os_legacy_bootstrap"]);
    assert.deepEqual(retiredRole.rows[0], {
      rolcanlogin: false,
      rolpassword: null,
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolinherit: false,
      rolreplication: false,
      rolbypassrls: false,
    });
    assert.equal(await roleExists(admin, legacyRole), false);
    const retiredLogin = new Client({ connectionString: roleUrl("ai_project_os_legacy_bootstrap", legacyPassword), connectionTimeoutMillis: 5_000 });
    await assert.rejects(
      () => retiredLogin.connect(),
      (error: unknown) => ["28000", "28P01"].includes(errorCode(error) ?? ""),
    );
    await retiredLogin.end().catch(() => undefined);
    const retiredSessions = await admin.query<{ client_sessions: string; unexpected_workers: string }>(`
      SELECT count(*) FILTER (WHERE activity.backend_type IN ('client backend', 'walsender'))::text AS client_sessions,
             count(*) FILTER (WHERE NOT (
               activity.backend_type IN ('client backend', 'walsender')
               OR (
                 activity.usesysid::text = '10'
                 AND activity.backend_type = 'logical replication launcher'
                 AND activity.datid IS NULL
                 AND activity.datname IS NULL
               )
             ))::text AS unexpected_workers
        FROM pg_stat_activity activity
       WHERE activity.usesysid = (SELECT oid FROM pg_roles WHERE rolname = $1)
         AND activity.pid <> pg_backend_pid()
    `, ["ai_project_os_legacy_bootstrap"]);
    assert.deepEqual(retiredSessions.rows[0], { client_sessions: "0", unexpected_workers: "0" });
    const retiredMemberships = await admin.query(`
      SELECT 1
        FROM pg_auth_members membership
        JOIN pg_roles member ON member.oid = membership.member
        JOIN pg_roles parent ON parent.oid = membership.roleid
       WHERE member.rolname = $1 OR parent.rolname = $1
    `, ["ai_project_os_legacy_bootstrap"]);
    assert.equal(retiredMemberships.rowCount, 0);

    const nonClassOwners = await admin.query<{ function_owner: string; type_owner: string }>(`
      SELECT
        (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid = $1::oid) AS function_owner,
        (SELECT pg_get_userbyid(typowner) FROM pg_type WHERE oid = $2::oid) AS type_owner
    `, [representativeObjects.functionOid, representativeObjects.typeOid]);
    assert.deepEqual(nonClassOwners.rows[0], { function_owner: migratorRole, type_owner: migratorRole });
    const finalObjectOwners = await admin.query<{ function_owner: string; type_owner: string }>(`
      SELECT
        (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid = $1::oid) AS function_owner,
        (SELECT pg_get_userbyid(typowner) FROM pg_type WHERE oid = $2::oid) AS type_owner
    `, [finalOwnedObjects.functionOid, finalOwnedObjects.typeOid]);
    assert.deepEqual(finalObjectOwners.rows[0], { function_owner: migratorRole, type_owner: migratorRole });

    const databaseAndSchema = await admin.query<{ database_owner: string; schema_owner: string }>(`
      SELECT
        (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database()) AS database_owner,
        (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'public') AS schema_owner
    `);
    assert.deepEqual(databaseAndSchema.rows[0], { database_owner: migratorRole, schema_owner: migratorRole });
    const relationOwners = await admin.query<{ owner: string }>(`
      SELECT pg_get_userbyid(c.relowner) AS owner
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
    `);
    assert.ok(relationOwners.rows.length > DATABASE_PRINCIPAL_RELATIONS.length);
    assert.ok(relationOwners.rows.every((row) => row.owner === migratorRole));
    const roles = await admin.query<{
      rolname: string;
      rolsuper: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolinherit: boolean;
      rolreplication: boolean;
      rolbypassrls: boolean;
    }>(`
      SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolreplication, rolbypassrls
        FROM pg_roles
       WHERE rolname = ANY($1::text[])
       ORDER BY rolname
    `, [[runtimeRole, writerRole, migratorRole]]);
    assert.equal(roles.rows.length, 3);
    assert.ok(roles.rows.every((row) => !row.rolsuper && !row.rolcreatedb && !row.rolcreaterole && !row.rolinherit && !row.rolreplication && !row.rolbypassrls));
    const memberships = await admin.query(`
      SELECT 1
        FROM pg_auth_members membership
        JOIN pg_roles member ON member.oid = membership.member
        JOIN pg_roles parent ON parent.oid = membership.roleid
       WHERE member.rolname = ANY($1::text[]) OR parent.rolname = ANY($1::text[])
    `, [[runtimeRole, writerRole, migratorRole]]);
    assert.equal(memberships.rowCount, 0);
    const directAcl = await admin.query<{
      runtime_database_create: boolean;
      runtime_database_temp: boolean;
      writer_database_create: boolean;
      writer_database_temp: boolean;
      runtime_schema_create: boolean;
      writer_schema_create: boolean;
      runtime_policy_insert: boolean;
      runtime_policy_update: boolean;
      runtime_policy_delete: boolean;
      runtime_sequence_update: boolean;
      writer_sequence_update: boolean;
    }>(`
      SELECT has_database_privilege($1, current_database(), 'CREATE') AS runtime_database_create,
             has_database_privilege($1, current_database(), 'TEMPORARY') AS runtime_database_temp,
             has_database_privilege($2, current_database(), 'CREATE') AS writer_database_create,
             has_database_privilege($2, current_database(), 'TEMPORARY') AS writer_database_temp,
             has_schema_privilege($1, 'public', 'CREATE') AS runtime_schema_create,
             has_schema_privilege($2, 'public', 'CREATE') AS writer_schema_create,
             has_table_privilege($1, 'public."PlatformGrantOfferPolicy"', 'INSERT') AS runtime_policy_insert,
             has_table_privilege($1, 'public."PlatformGrantOfferPolicy"', 'UPDATE') AS runtime_policy_update,
             has_table_privilege($1, 'public."PlatformGrantOfferPolicy"', 'DELETE') AS runtime_policy_delete,
             has_sequence_privilege($1, $3, 'UPDATE') AS runtime_sequence_update,
             has_sequence_privilege($2, $3, 'UPDATE') AS writer_sequence_update
    `, [runtimeRole, writerRole, `public.${quoteIdentifier(driftSequenceName)}`]);
    assert.deepEqual(directAcl.rows[0], {
      runtime_database_create: false,
      runtime_database_temp: false,
      writer_database_create: false,
      writer_database_temp: false,
      runtime_schema_create: false,
      writer_schema_create: false,
      runtime_policy_insert: false,
      runtime_policy_update: false,
      runtime_policy_delete: false,
      runtime_sequence_update: false,
      writer_sequence_update: true,
    });
    const staleDefaults = await admin.query<{ count: string }>(`
      SELECT count(*)::text AS count
        FROM pg_default_acl default_acl
        LEFT JOIN pg_namespace namespace ON namespace.oid = default_acl.defaclnamespace
        LEFT JOIN LATERAL aclexplode(COALESCE(default_acl.defaclacl, ARRAY[]::aclitem[])) privilege ON true
        LEFT JOIN pg_roles grantee ON grantee.oid = privilege.grantee
       WHERE (default_acl.defaclnamespace = 0 OR namespace.nspname = 'public')
         AND (privilege.grantee = 0::oid OR grantee.rolname = ANY($1::text[]))
    `, [[runtimeRole, writerRole]]);
    assert.equal(staleDefaults.rows[0]?.count, "0");
    const normalizedDefaults = await admin.query<{
      owner: string;
      namespace_oid: string;
      object_type: string;
      grantee: string | null;
      privilege_type: string | null;
    }>(`
      SELECT owner_role.rolname AS owner,
             default_acl.defaclnamespace::text AS namespace_oid,
             default_acl.defaclobjtype AS object_type,
             CASE WHEN privilege.grantee = 0::oid THEN 'PUBLIC' ELSE grantee.rolname END AS grantee,
             privilege.privilege_type
        FROM pg_default_acl default_acl
        JOIN pg_roles owner_role ON owner_role.oid = default_acl.defaclrole
        LEFT JOIN LATERAL aclexplode(COALESCE(default_acl.defaclacl, ARRAY[]::aclitem[])) privilege ON true
        LEFT JOIN pg_roles grantee ON grantee.oid = privilege.grantee
       WHERE owner_role.rolname = ANY($1::text[])
       ORDER BY owner, namespace_oid, object_type, grantee NULLS LAST, privilege_type NULLS LAST
    `, [[runtimeRole, writerRole, migratorRole]]);
    assert.equal(normalizedDefaults.rows.filter((row) => row.owner === runtimeRole || row.owner === writerRole).length, 0);
    const migratorDefaults = normalizedDefaults.rows.filter((row) => row.owner === migratorRole);
    assert.deepEqual(migratorDefaults, [{
      owner: migratorRole,
      namespace_oid: "0",
      object_type: "f",
      grantee: migratorRole,
      privilege_type: "EXECUTE",
    }]);
    const retiredDefaults = await admin.query(`
      SELECT 1
        FROM pg_default_acl default_acl
        JOIN pg_roles owner_role ON owner_role.oid = default_acl.defaclrole
       WHERE owner_role.rolname = 'ai_project_os_legacy_bootstrap'
    `);
    assert.equal(retiredDefaults.rowCount, 0);
    const roleSettings = await admin.query<{ rolname: string; config: string[] | null }>(`
      SELECT role_row.rolname, setting.setconfig AS config
        FROM pg_db_role_setting setting
        JOIN pg_roles role_row ON role_row.oid = setting.setrole
       WHERE role_row.rolname = ANY($1::text[])
         AND setting.setdatabase IN (0, (SELECT oid FROM pg_database WHERE datname = current_database()))
    `, [[runtimeRole, writerRole, migratorRole]]);
    assert.deepEqual(
      roleSettings.rows.sort((left, right) => left.rolname.localeCompare(right.rolname)),
      [runtimeRole, writerRole, migratorRole].sort().map((rolname) => ({ rolname, config: ["default_transaction_read_only=off"] })),
    );

    await admin.query(`DROP DATABASE ${quoteIdentifier(externalDatabaseName)}`);
    await dropRole(admin, "ai_project_os_legacy_bootstrap");

    await admin.query(`CREATE ROLE ${quoteIdentifier(bypassRole)} LOGIN SUPERUSER PASSWORD ${quoteLiteral(bypassPassword)}`);
    await admin.query(`CREATE FUNCTION public.${quoteIdentifier(bypassFunctionName)}() RETURNS integer LANGUAGE SQL IMMUTABLE AS 'SELECT 9'`);
    await admin.query(`ALTER FUNCTION public.${quoteIdentifier(bypassFunctionName)}() OWNER TO ${quoteIdentifier(bypassRole)}`);
    await admin.query(`CREATE TYPE public.${quoteIdentifier(bypassTypeName)} AS ENUM ('bypass')`);
    await admin.query(`ALTER TYPE public.${quoteIdentifier(bypassTypeName)} OWNER TO ${quoteIdentifier(bypassRole)}`);
    await runPrincipalBootstrap(runtimePassword, migratorPassword, writerPassword, roleUrl(bypassRole, bypassPassword));
    const bypassShape = await admin.query<{
      rolcanlogin: boolean;
      rolsuper: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolinherit: boolean;
      rolreplication: boolean;
      rolbypassrls: boolean;
    }>(`
      SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolreplication, rolbypassrls
        FROM pg_roles
       WHERE rolname = $1
    `, ["ai_project_os_legacy_bootstrap"]);
    assert.deepEqual(bypassShape.rows[0], {
      rolcanlogin: false,
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolinherit: false,
      rolreplication: false,
      rolbypassrls: false,
    });
    const bypassObjectOwners = await admin.query<{ function_owner: string; type_owner: string }>(`
      SELECT
        (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE proname = $1 AND pronamespace = 'public'::regnamespace) AS function_owner,
        (SELECT pg_get_userbyid(typowner) FROM pg_type WHERE typname = $2 AND typnamespace = 'public'::regnamespace) AS type_owner
    `, [bypassFunctionName, bypassTypeName]);
    assert.deepEqual(bypassObjectOwners.rows[0], { function_owner: migratorRole, type_owner: migratorRole });
  } finally {
    if (initialDatabaseOwner !== null) {
      await transferPublicOwnership(admin, legacyRole, initialDatabaseOwner).catch(reportCleanupFailure);
      await transferPublicOwnership(admin, migratorRole, initialDatabaseOwner).catch(reportCleanupFailure);
      await transferPublicOwnership(admin, "ai_project_os_legacy_bootstrap", initialDatabaseOwner).catch(reportCleanupFailure);
      await transferPublicOwnership(admin, bypassRole, initialDatabaseOwner).catch(reportCleanupFailure);
      await admin.query(`DELETE FROM "AppUser" WHERE "id" = $1`, [userId]).catch(reportCleanupFailure);
      await admin.query(`DROP FUNCTION IF EXISTS public.${quoteIdentifier(runtimeFunctionName)}()`).catch(reportCleanupFailure);
      await admin.query(`DROP TYPE IF EXISTS public.${quoteIdentifier(writerTypeName)}`).catch(reportCleanupFailure);
      await admin.query(`DROP FUNCTION IF EXISTS public.${quoteIdentifier(bypassFunctionName)}()`).catch(reportCleanupFailure);
      await admin.query(`DROP TYPE IF EXISTS public.${quoteIdentifier(bypassTypeName)}`).catch(reportCleanupFailure);
      await admin.query(`DROP SEQUENCE IF EXISTS public.${quoteIdentifier(driftSequenceName)}`).catch(reportCleanupFailure);
      await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(externalDatabaseName)}`).catch(reportCleanupFailure);
      await admin.query(`DROP ROLE IF EXISTS ${quoteIdentifier(legacyMemberRole)}`).catch(reportCleanupFailure);
      await admin.query(`DROP ROLE IF EXISTS ${quoteIdentifier(legacyParentRole)}`).catch(reportCleanupFailure);
      await dropRole(admin, legacyRole).catch(reportCleanupFailure);
      await dropRole(admin, "ai_project_os_legacy_bootstrap").catch(reportCleanupFailure);
      await dropRole(admin, bypassRole).catch(reportCleanupFailure);
      for (const role of [runtimeRole, writerRole, migratorRole]) await dropRole(admin, role).catch(reportCleanupFailure);
      for (const role of [legacyRole, legacyMemberRole, legacyParentRole, bypassRole, "ai_project_os_legacy_bootstrap"]) {
        try {
          assert.equal(await roleExists(admin, role), false, `database-principal cleanup left role ${role}`);
        } catch (error) {
          cleanupAssertionError ??= error;
          reportCleanupFailure(error);
        }
      }
    }
    await admin.end().catch(reportCleanupFailure);
    if (cleanupAssertionError !== undefined) throw cleanupAssertionError;
  }
});

test("production reconcile separates non-owner runtime from writer and preserves ordinary reservation flow", {
  skip: !shouldRun || databaseUrl === undefined || adminUrl === undefined
    ? "explicit disposable PostgreSQL gate is required"
    : false,
}, async () => {
  const admin = new Client({ connectionString: targetAdminUrl(), connectionTimeoutMillis: 5_000 });
  const runtimePassword = `Runtime_${randomUUID().replaceAll("-", "")}`;
  const migratorPassword = `Migrator_${randomUUID().replaceAll("-", "")}`;
  const writerPassword = `Writer_${randomUUID().replaceAll("-", "")}`;
  const runtimeUrl = roleUrl(runtimeRole, runtimePassword);
  const writerUrl = roleUrl(writerRole, writerPassword);
  const bootstrapPassword = `Bootstrap_${randomUUID().replaceAll("-", "")}`;
  const bootstrapRole = `ai_project_os_gate_bootstrap_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const existingRoles = new Map<string, boolean>();
  let writer: PrismaClient | null = null;
  let runtime: Client | null = null;
  let runtimeDb: PrismaClient | null = null;
  let initialDatabaseOwner: string | null = null;
  let cleanupAssertionError: unknown;
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  try {
    await ensureClusterAdminForGate();
    await admin.connect();
    for (const role of [runtimeRole, migratorRole, writerRole]) existingRoles.set(role, await roleExists(admin, role));
    const databaseOwner = await admin.query<{ owner: string }>(`
      SELECT pg_get_userbyid(d.datdba) AS owner
        FROM pg_database d
       WHERE d.datname = current_database()
    `);
    initialDatabaseOwner = databaseOwner.rows[0]?.owner ?? null;
    assert.ok(initialDatabaseOwner);
    await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${quoteLiteral(runtimeRole)}) THEN CREATE ROLE ${quoteIdentifier(runtimeRole)} LOGIN; END IF; END $$`);
    await admin.query(`ALTER ROLE ${quoteIdentifier(runtimeRole)} WITH LOGIN REPLICATION PASSWORD ${quoteLiteral(runtimePassword)}`);
    await admin.query(`CREATE ROLE ${quoteIdentifier(bootstrapRole)} LOGIN SUPERUSER PASSWORD ${quoteLiteral(bootstrapPassword)}`);
    await transferPublicOwnership(admin, initialDatabaseOwner, bootstrapRole);

    // Run the production owner/ACL reconcile command; this gate intentionally
    // does not replace it with a hand-written set of GRANT statements.
    await runPrincipalBootstrap(runtimePassword, migratorPassword, writerPassword, roleUrl(bootstrapRole, bootstrapPassword));
    await runProductionReconcile(runtimePassword, migratorPassword, writerPassword);
    // The second reconcile deliberately omits the bootstrap URL.  It proves that
    // the final migrator role is sufficient for owner/ACL reconciliation and
    // no longer depends on CREATEROLE.
    await runProductionReconcile(runtimePassword, migratorPassword, writerPassword);
    await assertInvokerHelperAcls(admin);

    const relationRows = await admin.query<{ relname: string; owner: string; relkind: string }>(`
      SELECT c.relname, pg_get_userbyid(c.relowner) AS owner, c.relkind
        FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
       ORDER BY c.relname
    `);
    assert.ok(relationRows.rows.length > DATABASE_PRINCIPAL_RELATIONS.length);
    assert.ok(relationRows.rows.every((row) => row.owner === migratorRole));
    assert.deepEqual(
      relationRows.rows.filter((row) => row.relkind !== "S" && row.relname !== "_prisma_migrations").map((row) => row.relname).sort(),
      [...DATABASE_PRINCIPAL_RELATIONS].sort(),
    );
    const acl = await admin.query<{
      rolname: string;
      rolsuper: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolinherit: boolean;
      rolreplication: boolean;
      rolbypassrls: boolean;
    }>(`
      SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolreplication, rolbypassrls
        FROM pg_roles
       WHERE rolname = ANY($1::text[])
       ORDER BY rolname
    `, [[runtimeRole, writerRole, migratorRole]]);
    assert.equal(acl.rows.length, 3);
    assert.deepEqual(acl.rows.map((row) => row.rolname), [writerRole, migratorRole, runtimeRole]);
    assert.ok(acl.rows.every((row) => !row.rolsuper && !row.rolcreatedb && !row.rolinherit && !row.rolreplication && !row.rolbypassrls));
    assert.equal(acl.rows.find((row) => row.rolname === migratorRole)?.rolcreaterole, false);
    assert.equal(acl.rows.find((row) => row.rolname === runtimeRole)?.rolcreaterole, false);
    assert.equal(acl.rows.find((row) => row.rolname === writerRole)?.rolcreaterole, false);
    const publicAcl = await admin.query<{ database_public: boolean; schema_public: boolean }>(`
      SELECT EXISTS (
               SELECT 1
                 FROM pg_database database_row
                 CROSS JOIN LATERAL aclexplode(COALESCE(database_row.datacl, acldefault('d', database_row.datdba))) privilege
                WHERE database_row.datname = current_database()
                  AND privilege.grantee = 0::oid
                  AND privilege.privilege_type IN ('CREATE', 'TEMPORARY')
             ) AS database_public,
             EXISTS (
               SELECT 1
                 FROM pg_namespace schema_row
                 CROSS JOIN LATERAL aclexplode(COALESCE(schema_row.nspacl, acldefault('n', schema_row.nspowner))) privilege
                WHERE schema_row.nspname = 'public'
                  AND privilege.grantee = 0::oid
                  AND privilege.privilege_type = 'CREATE'
             ) AS schema_public
    `);
    assert.deepEqual(publicAcl.rows[0], { database_public: false, schema_public: false });

    const previousDatabaseUrl = process.env.DATABASE_URL;
    const previousWriterUrl = process.env.ENTITLEMENT_DATABASE_URL;
    process.env.DATABASE_URL = runtimeUrl;
    process.env.ENTITLEMENT_DATABASE_URL = writerUrl;
    try {
      // The default production writer client is used, with no runtime fallback.
      writer = getEntitlementDb();
      const bootstrap = await initializeAdmin({ username: `database_principal_admin_${suffix}`, password: "DatabasePrincipalGatePassword_2026" }, writer);
      const actor: PlatformGrantOfferPolicyActor = bootstrap.user;
      assert.equal(actor.role, "admin");
      assert.equal(await writer.accountEntitlementActivation.count({ where: { userId: actor.id, lifecycleKey: "initial_account_v1" } }), 1);
      assert.equal(await writer.platformTokenGrant.count({ where: { userId: actor.id, kind: "signup" } }), 1);
      assert.equal(await writer.platformTokenLedgerEntry.count({ where: { userId: actor.id, reasonCode: "AI_SIGNUP_GRANT" } }), 1);

      const draft = await createPlatformGrantOfferPolicy({
        offerVersion: `principal-${suffix}`,
        amount: 100,
        validForDays: 7,
        reason: "database principal gate",
      }, actor);
      await changePlatformGrantOfferPolicyLifecycle(draft.id, {
        action: "activate",
        expectedUpdatedAt: draft.updatedAt.toISOString(),
        reason: "database principal gate activation",
      }, actor);

      // Ordinary runtime settlement remains usable through the explicitly
      // permitted grant columns and non-signup ledger append path.
      runtimeDb = getDb();
      const callKey = `database-principal:${suffix}:reservation`;
      const reservation = await reservePlatformTokens({
        userId: actor.id,
        callKey,
        operation: "autoExtract",
        modelId: "database-principal-test-model",
        estimatedTokens: 10,
      }, runtimeDb);
      assert.equal(reservation.created, true);
      const settled = await settlePlatformTokenReservation({ userId: actor.id, callKey, actualTokens: 5, usageKnown: true }, runtimeDb);
      assert.equal(settled.status, "settled");

      // Exercise the newly reconciled SECURITY INVOKER owner helper through
      // the real runtime role.  The fixture itself is created by the
      // entitlement writer, then preview is retried with the same stable
      // request key before the runtime execute path replaces the membership.
      assert.equal(typeof actor.accountAccessVersion, "number");
      const actorVersion = actor.accountAccessVersion as number;
      const roleSubject = await writer.appUser.create({
        data: {
          id: randomUUID(),
          username: `database_principal_subject_${suffix}`,
          email: `database-principal-subject-${suffix}@example.com`,
          emailVerifiedAt: new Date(),
          role: "user",
        },
        select: { id: true, username: true, accountAccessVersion: true },
      });
      const roleWorkspaceId = randomUUID();
      await writer.$transaction(async (tx) => {
        await tx.workspace.create({ data: { id: roleWorkspaceId, name: `Principal role ${suffix}`, slug: `principal-role-${suffix}`, createdById: actor.id } });
        await grantWorkspaceMembership(tx, { workspaceId: roleWorkspaceId, userId: actor.id, role: "owner", actorId: actor.id, reason: "principal_role_owner_fixture" });
        await grantWorkspaceMembership(tx, { workspaceId: roleWorkspaceId, userId: roleSubject.id, role: "member", actorId: actor.id, reason: "principal_role_subject_fixture" });
      });
      const rolePreviewInput = {
        workspaceId: roleWorkspaceId,
        subjectId: roleSubject.id,
        actorId: actor.id,
        actorAccountAccessVersion: actorVersion,
        targetRole: "admin" as const,
        reason: "principal role mutation",
        requestKey: `database-principal:${suffix}:role`,
      };
      const roleRuntimeDb = runtimeDb;
      assert.ok(roleRuntimeDb);
      const rolePreview = await previewWorkspaceRoleMutation(rolePreviewInput, roleRuntimeDb);
      const rolePreviewRetry = await previewWorkspaceRoleMutation(rolePreviewInput, roleRuntimeDb);
      assert.equal(rolePreviewRetry.previewId, rolePreview.previewId);
      await assert.rejects(
        () => previewWorkspaceRoleMutation({ ...rolePreviewInput, reason: "changed reason" }, roleRuntimeDb),
        (error: unknown) => error instanceof WorkspaceRoleGovernanceError && error.code === "WORKSPACE_ROLE_GOVERNANCE_IDEMPOTENCY_CONFLICT",
      );
      const roleResult = await executeWorkspaceRoleMutation({
        ...rolePreviewInput,
        previewId: rolePreview.previewId,
        currentRole: rolePreview.current.role,
        expectedTargetRole: rolePreview.target.role,
        expectedOwnerCount: rolePreview.ownerCount,
        expectedProjectGrantCount: rolePreview.projectGrantCount,
        expectedProjectGrantFingerprint: rolePreview.projectGrantFingerprint,
        expectedMembershipFingerprint: rolePreview.membershipFingerprint,
        expectedImpactFingerprint: rolePreview.impactFingerprint,
        requestFingerprint: rolePreview.requestFingerprint,
        previewIssuedAt: rolePreview.issuedAt,
        previewExpiresAt: rolePreview.expiresAt,
        confirmation: true,
        confirmationUsername: roleSubject.username,
      }, roleRuntimeDb);
      assert.equal(roleResult.newRole, "admin");

      // The writer cannot bypass governance by creating or deleting manual
      // accounting rows directly; production mutations use the functions.
      const entitlementWriter = writer;
      assert.ok(entitlementWriter);
      await assert.rejects(() => entitlementWriter.platformTokenGrant.create({ data: {
        userId: actor.id, kind: "manual", amount: 7, remainingTokens: 7,
        offerVersion: `principal-bypass-${suffix}`, issuedById: actor.id,
        expiresAt: new Date("2026-10-01T00:00:00.000Z"),
      } }));
      await assert.rejects(() => entitlementWriter.platformTokenLedgerEntry.deleteMany({ where: { reservationId: reservation.reservationId } }));
      await assert.rejects(() => entitlementWriter.platformTokenReservation.deleteMany({ where: { id: reservation.reservationId } }));
    } finally {
      if (runtimeDb !== null) await runtimeDb.$disconnect().catch(() => undefined);
      if (writer !== null) await writer.$disconnect().catch(() => undefined);
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
      if (previousWriterUrl === undefined) delete process.env.ENTITLEMENT_DATABASE_URL;
      else process.env.ENTITLEMENT_DATABASE_URL = previousWriterUrl;
    }

    runtime = new Client({ connectionString: runtimeUrl, connectionTimeoutMillis: 5_000 });
    await runtime.connect();
    const runtimeClient = runtime;
    const runtimeIdentity = await runtimeClient.query<{ session_user: string; current_user: string }>("SELECT session_user, current_user");
    assert.deepEqual(runtimeIdentity.rows[0], { session_user: runtimeRole, current_user: runtimeRole });
    const runtimePrivileges = await runtimeClient.query<{
      policySelect: boolean;
      policyInsert: boolean;
      grantInsert: boolean;
      grantRemainingUpdate: boolean;
      grantOfferVersionUpdate: boolean;
      ledgerInsert: boolean;
      ledgerDelete: boolean;
    }>(`
      SELECT has_table_privilege(current_user, 'public."PlatformGrantOfferPolicy"', 'SELECT') AS "policySelect",
             has_table_privilege(current_user, 'public."PlatformGrantOfferPolicy"', 'INSERT') AS "policyInsert",
             has_table_privilege(current_user, 'public."PlatformTokenGrant"', 'INSERT') AS "grantInsert",
             has_column_privilege(current_user, 'public."PlatformTokenGrant"', 'remainingTokens', 'UPDATE') AS "grantRemainingUpdate",
             has_column_privilege(current_user, 'public."PlatformTokenGrant"', 'offerVersion', 'UPDATE') AS "grantOfferVersionUpdate",
             has_table_privilege(current_user, 'public."PlatformTokenLedgerEntry"', 'INSERT') AS "ledgerInsert",
             has_table_privilege(current_user, 'public."PlatformTokenLedgerEntry"', 'DELETE') AS "ledgerDelete"
    `);
    assert.deepEqual(runtimePrivileges.rows[0], {
      policySelect: true,
      policyInsert: false,
      grantInsert: false,
      grantRemainingUpdate: false,
      grantOfferVersionUpdate: false,
      ledgerInsert: false,
      ledgerDelete: false,
    });

    // Setting every known application context does not elevate the runtime
    // session; only PostgreSQL session_user is authoritative in the guard.
    const forgedGucs = [
      ["app.platform_grant_offer_policy_context", "service-v1"],
      ["app.platform_grant_offer_policy_transaction_id", randomUUID()],
      ["app.account_entitlement_activation_context", "service-v1"],
      ["app.account_entitlement_activation_transaction_id", randomUUID()],
      ["app.account_entitlement_backfill_context", "service-v1"],
      ["app.account_entitlement_backfill_transaction_id", randomUUID()],
      ["app.platform_token_runtime_context", "1"],
      ["app.platform_credit_governance_context", "service-v1"],
      ["app.platform_credit_governance_action", "grant"],
      ["app.platform_credit_governance_actor_id", randomUUID()],
      ["app.platform_credit_governance_preview_context", "service-v1"],
      ["app.platform_credit_governance_execute_context", "service-v1"],
    ] as const;
    for (const [name, value] of forgedGucs) await runtimeClient.query("SELECT set_config($1, $2, true)", [name, value]);

    for (const statement of [
      `INSERT INTO "PlatformGrantOfferPolicy" ("id") VALUES (gen_random_uuid())`,
      `INSERT INTO "PlatformGrantOfferPolicyAudit" ("id") VALUES (gen_random_uuid())`,
      `INSERT INTO "AccountEntitlementActivation" ("id") VALUES (gen_random_uuid())`,
      `INSERT INTO "AccountEntitlementActivationAudit" ("id") VALUES (gen_random_uuid())`,
      `INSERT INTO "AccountEntitlementBackfillRun" ("id") VALUES (gen_random_uuid())`,
      `INSERT INTO "AccountEntitlementBackfillItem" ("id") VALUES (gen_random_uuid())`,
      `INSERT INTO "AccountEntitlementBackfillAudit" ("id") VALUES (gen_random_uuid())`,
      `INSERT INTO "PlatformTokenGrant" ("id") VALUES (gen_random_uuid())`,
      `INSERT INTO "PlatformTokenLedgerEntry" ("id", "reasonCode") VALUES (gen_random_uuid(), 'AI_SIGNUP_GRANT')`,
      `INSERT INTO "PlatformTokenReservation" ("id") VALUES (gen_random_uuid())`,
      `INSERT INTO "PlatformTokenReservationAllocation" ("id") VALUES (gen_random_uuid())`,
      `UPDATE "PlatformTokenReservation" SET "status" = "status"`,
      `UPDATE "PlatformTokenReservationAllocation" SET "ordinal" = "ordinal"`,
      `UPDATE "PlatformTokenGrant" SET "offerVersion" = "offerVersion"`,
      `DELETE FROM "PlatformTokenGrant"`,
      `DELETE FROM "PlatformTokenLedgerEntry"`,
    ]) await expectPermissionDenied(() => runtimeClient.query(statement));
    await expectPermissionDenied(() => runtimeClient.query(`SET ROLE ${quoteIdentifier(writerRole)}`));
    await expectPermissionDenied(() => runtimeClient.query(`SET SESSION AUTHORIZATION ${quoteIdentifier(writerRole)}`));
  } finally {
    if (runtime !== null) await runtime.end().catch(() => undefined);
    if (runtimeDb !== null) await runtimeDb.$disconnect().catch(() => undefined);
    if (writer !== null) await writer.$disconnect().catch(() => undefined);
    if (initialDatabaseOwner !== null) {
      await transferPublicOwnership(admin, bootstrapRole, initialDatabaseOwner).catch(reportCleanupFailure);
      await transferPublicOwnership(admin, migratorRole, initialDatabaseOwner).catch(reportCleanupFailure);
    }
    await dropRole(admin, "ai_project_os_legacy_bootstrap").catch(reportCleanupFailure);
    await dropRole(admin, bootstrapRole).catch(reportCleanupFailure);
    for (const role of [runtimeRole, writerRole, migratorRole]) {
      if (existingRoles.get(role) !== true) await dropRole(admin, role).catch(reportCleanupFailure);
    }
    for (const role of [bootstrapRole, "ai_project_os_legacy_bootstrap"]) {
      try {
        assert.equal(await roleExists(admin, role), false, `database-principal cleanup left role ${role}`);
      } catch (error) {
        cleanupAssertionError ??= error;
        reportCleanupFailure(error);
      }
    }
    await admin.end().catch(reportCleanupFailure);
    if (cleanupAssertionError !== undefined) throw cleanupAssertionError;
  }
});
