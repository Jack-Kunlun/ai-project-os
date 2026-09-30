import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import {
  buildPostgresGateDatabaseUrl,
  POSTGRES_GATE_TEST_USER,
  selectPostgresGates,
  validatePostgresGateAdminUrl,
  type PostgresGateDefinition,
} from "./postgres-gate-contract";
import { activateAccountEntitlements } from "../src/lib/account-entitlement-activation-service";
import { createBootstrapSignupOfferPolicy } from "../src/lib/platform-grant-offer-policy-service";

const SEEDED_ADMIN_ID = "00000000-0000-4000-8000-000000000010";
const SEEDED_OWNER_ID = "00000000-0000-4000-8000-000000000012";
const SEEDED_OWNER_MEMBERSHIP_ID = "00000000-0000-4000-8000-000000000011";
const SEEDED_WORKSPACE_ID = "00000000-0000-4000-8000-000000000099";
const PRINCIPAL_GATE_ROLES = Object.freeze([
  { name: "ai_project_os_cluster_admin", attributes: "SUPERUSER CREATEDB CREATEROLE INHERIT NOREPLICATION NOBYPASSRLS", login: true },
  { name: "ai_project_os_migrator", attributes: "NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS", login: true },
  { name: "ai_project_os_runtime", attributes: "NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS", login: false },
  { name: "ai_project_os_entitlement_writer", attributes: "NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS", login: false },
  { name: "ai_project_os_git_automation_worker", attributes: "NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS", login: false },
  { name: "ai_project_os_entitlement_inventory_reader", attributes: "NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS", login: false },
] as const);
const DATABASE_PRINCIPAL_GATE_TEMPORARY_ROLES = Object.freeze([
  "ai_project_os_cluster_admin",
  "ai_project_os_entitlement_inventory_reader",
] as const);

function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`POSTGRES_GATE_COMMAND_FAILED: code=${code ?? "null"} signal=${signal ?? "none"}`));
    });
  });
}

function quoteDatabaseName(database: string): string {
  if (!/^ai_project_os_[a-z0-9_]+(?:_test|_world)$/u.test(database)) {
    throw new Error("POSTGRES_GATE_DATABASE_NAME_INVALID");
  }
  return `"${database}"`;
}

function quoteIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) throw new Error("POSTGRES_GATE_IDENTIFIER_INVALID");
  return `"${value}"`;
}

async function recreateDatabase(admin: Client, database: string): Promise<void> {
  const quoted = quoteDatabaseName(database);
  await admin.query(`DROP DATABASE IF EXISTS ${quoted} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${quoted} OWNER "${POSTGRES_GATE_TEST_USER}"`);
}

async function prepareLegacyPrincipalGateExtensions(adminUrl: URL, database: string, testPassword: string): Promise<void> {
  const gateUrl = buildPostgresGateDatabaseUrl(adminUrl, database, testPassword);
  const gate = new Client({ connectionString: gateUrl, connectionTimeoutMillis: 5_000 });
  await gate.connect();
  try {
    // The legacy-owner recovery test transfers all objects owned by the
    // disposable gate role. Recreate template plpgsql under that role before
    // migrations, as the production bootstrap does for its cluster admin.
    await gate.query("DROP EXTENSION plpgsql");
    await gate.query("CREATE EXTENSION plpgsql");
  } finally {
    await gate.end();
  }
}

async function dropDatabase(admin: Client, database: string): Promise<void> {
  await admin.query(`DROP DATABASE IF EXISTS ${quoteDatabaseName(database)} WITH (FORCE)`);
}

async function dropDatabasePrincipalGateTemporaryRoles(admin: Client): Promise<void> {
  for (const role of DATABASE_PRINCIPAL_GATE_TEMPORARY_ROLES) {
    const exists = await admin.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists",
      [role],
    );
    if (exists.rows[0]?.exists !== true) continue;
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = $1 AND pid <> pg_backend_pid()",
      [role],
    );
    await admin.query(`DROP OWNED BY ${quoteIdentifier(role)}`);
    await admin.query(`DROP ROLE ${quoteIdentifier(role)}`);
  }
}

function roleDatabaseUrl(adminUrl: URL, database: string, role: string, password: string): string {
  const target = new URL(adminUrl);
  target.pathname = `/${database}`;
  target.username = role;
  target.password = password;
  target.search = "";
  target.hash = "";
  return target.toString();
}

async function assertPrincipalGateRolesAvailable(admin: Client): Promise<void> {
  const existing = await admin.query<{ rolname: string }>(
    "SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[]) ORDER BY rolname",
    [PRINCIPAL_GATE_ROLES.map(({ name }) => name)],
  );
  if (existing.rows.length > 0) throw new Error("POSTGRES_GATE_PRINCIPAL_ROLE_COLLISION");
}

async function createPrincipalGateEnvironment(admin: Client, adminUrl: URL, database: string): Promise<NodeJS.ProcessEnv> {
  const suffix = randomBytes(18).toString("hex");
  const passwords = new Map(PRINCIPAL_GATE_ROLES.map(({ name }) => [name, `${name.split("_").at(-1)}_${suffix}`]));
  for (const role of PRINCIPAL_GATE_ROLES) {
    const password = passwords.get(role.name);
    if (password === undefined) throw new Error("POSTGRES_GATE_PRINCIPAL_PASSWORD_INVALID");
    await admin.query(`CREATE ROLE ${quoteIdentifier(role.name)} ${role.login ? "LOGIN" : "NOLOGIN"} ${role.attributes} PASSWORD '${password}'`);
  }
  await admin.query(`DROP DATABASE IF EXISTS ${quoteDatabaseName(database)} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${quoteDatabaseName(database)} OWNER ${quoteIdentifier("ai_project_os_cluster_admin")}`);

  const adminRoleUrl = roleDatabaseUrl(adminUrl, database, "ai_project_os_cluster_admin", passwords.get("ai_project_os_cluster_admin")!);
  const clusterAdmin = new Client({ connectionString: adminRoleUrl, connectionTimeoutMillis: 5_000 });
  await clusterAdmin.connect();
  try {
    // The template database's plpgsql extension belongs to its initdb role;
    // recreate it under the disposable cluster admin before principal bootstrap.
    await clusterAdmin.query("DROP EXTENSION plpgsql");
    await clusterAdmin.query("CREATE EXTENSION plpgsql");
  } finally {
    await clusterAdmin.end();
  }

  const runtimeUrl = roleDatabaseUrl(adminUrl, database, "ai_project_os_runtime", passwords.get("ai_project_os_runtime")!);
  const writerUrl = roleDatabaseUrl(adminUrl, database, "ai_project_os_entitlement_writer", passwords.get("ai_project_os_entitlement_writer")!);
  const gitAutomationUrl = roleDatabaseUrl(adminUrl, database, "ai_project_os_git_automation_worker", passwords.get("ai_project_os_git_automation_worker")!);
  const migratorUrl = roleDatabaseUrl(adminUrl, database, "ai_project_os_migrator", passwords.get("ai_project_os_migrator")!);
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_PRINCIPAL_ADMIN_URL: adminRoleUrl,
    DATABASE_URL: runtimeUrl,
    ENTITLEMENT_DATABASE_URL: writerUrl,
    GIT_AUTOMATION_DATABASE_URL: gitAutomationUrl,
    MIGRATOR_DATABASE_URL: migratorUrl,
    POSTGRES_ENTITLEMENT_INVENTORY_READER_PASSWORD: passwords.get("ai_project_os_entitlement_inventory_reader"),
  };
  await run("pnpm", ["exec", "tsx", "scripts/reconcile-database-principals.ts", "--bootstrap-if-needed"], environment);
  await run("pnpm", ["exec", "prisma", "migrate", "deploy", "--config", "prisma.config.ts"], { ...environment, DATABASE_URL: migratorUrl });
  await run("pnpm", ["exec", "tsx", "scripts/reconcile-database-principals.ts"], environment);
  // Reconciliation verifies the bootstrap NOLOGIN shape, then enables LOGIN
  // for the runtime and writer sessions it checks. The disposable gate uses
  // those same principals and their exact production ACLs.
  return environment;
}

async function dropPrincipalGateRoles(admin: Client): Promise<void> {
  for (const { name } of [...PRINCIPAL_GATE_ROLES].reverse()) {
    await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = $1 AND pid <> pg_backend_pid()", [name]);
    await admin.query(`DROP ROLE IF EXISTS ${quoteIdentifier(name)}`);
  }
}

async function seedInitialAdmin(databaseUrl: string, entitlementDatabaseUrl = databaseUrl): Promise<void> {
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      INSERT INTO "AppUser"
        ("id", "username", "passwordHash", "passwordSalt", "passwordVersion", "role", "updatedAt")
      VALUES
        ('${SEEDED_ADMIN_ID}', 'postgres_gate_admin', repeat('a', 43), repeat('b', 22), 1, 'admin', (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3))
      ON CONFLICT ("username") DO NOTHING
    `);
    await client.query(`
      INSERT INTO "AppUser"
        ("id", "username", "passwordHash", "passwordSalt", "passwordVersion", "role", "updatedAt")
      VALUES
        ('${SEEDED_OWNER_ID}', 'postgres_gate_owner', repeat('c', 43), repeat('d', 22), 1, 'user', (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3))
      ON CONFLICT ("username") DO NOTHING
    `);
    await client.query(`
      INSERT INTO "PlatformBootstrap"
        ("id", "initialAdminUserId", "version")
      VALUES
        ('platform', '${SEEDED_ADMIN_ID}', 1)
      ON CONFLICT ("id") DO NOTHING
    `);
    await client.query(`
      INSERT INTO "Workspace" ("id", "name", "slug", "createdById", "createdAt", "updatedAt")
      VALUES ('${SEEDED_WORKSPACE_ID}', 'Postgres gate fixture', 'postgres-gate-workspace', '${SEEDED_OWNER_ID}',
        (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3), (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3))
      ON CONFLICT ("id") DO NOTHING
    `);
    await client.query(`
      WITH inserted AS (
        INSERT INTO "WorkspaceMembership"
          ("id", "workspaceId", "userId", "role", "accessState", "updatedAt")
        VALUES
          ('${SEEDED_OWNER_MEMBERSHIP_ID}', '${SEEDED_WORKSPACE_ID}', '${SEEDED_OWNER_ID}', 'owner', 'confirmed', (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3))
        ON CONFLICT ("id") DO NOTHING
        RETURNING "id", "workspaceId", "userId", "role", "accessState", "createdAt", "updatedAt"
      )
      INSERT INTO "MembershipAccessAudit"
        ("id", "membershipKind", "membershipId", "workspaceId", "projectId", "userId", "action", "previousState", "newState", "roleSnapshot", "actorId", "reason", "membershipFingerprint")
      SELECT
        gen_random_uuid(), 'workspace', inserted."id", inserted."workspaceId", NULL, inserted."userId",
        'confirmed', NULL, 'confirmed', inserted."role", '${SEEDED_OWNER_ID}',
        'postgres_gate_workspace_owner_fixture',
        encode(digest(convert_to(concat_ws(
          E'\\x1f', inserted."id"::text, inserted."workspaceId"::text, inserted."userId"::text,
          inserted."role"::text,
          to_char(inserted."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS'),
          to_char(inserted."updatedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS')
        ), 'UTF8'), 'sha256'), 'hex')
      FROM inserted
    `);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: entitlementDatabaseUrl }) });
  try {
    const now = new Date();
    await prisma.$transaction((tx) => createBootstrapSignupOfferPolicy(tx, SEEDED_ADMIN_ID, now));
    await activateAccountEntitlements({
      userId: SEEDED_OWNER_ID,
      source: "localProvisioning",
      actorId: SEEDED_ADMIN_ID,
      actorAccountAccessVersion: 1,
      accountAccessVersion: 1,
      evidenceKind: "postgres-gate-seed",
      evidenceRef: `workspace:${SEEDED_WORKSPACE_ID}`,
      now,
    }, prisma);
  } finally {
    await prisma.$disconnect();
  }
}

async function runGate(
  admin: Client,
  adminUrl: URL,
  gate: PostgresGateDefinition,
  testPassword: string,
  position: number,
  total: number,
): Promise<void> {
  console.log(`[${position}/${total}] ${gate.id}`);
  if (gate.setup === "principals") {
    let cleanupPrincipalRoles = false;
    try {
      await assertPrincipalGateRolesAvailable(admin);
      cleanupPrincipalRoles = true;
      const environment = await createPrincipalGateEnvironment(admin, adminUrl, gate.database);
      if (gate.seedAdmin === true) {
        const principalAdminUrl = environment.DATABASE_PRINCIPAL_ADMIN_URL;
        const entitlementWriterUrl = environment.ENTITLEMENT_DATABASE_URL;
        if (typeof principalAdminUrl !== "string" || typeof entitlementWriterUrl !== "string") {
          throw new Error("POSTGRES_GATE_PRINCIPAL_SEED_URL_REQUIRED");
        }
        await seedInitialAdmin(principalAdminUrl, entitlementWriterUrl);
      }
      environment[gate.gateEnv] = "1";
      await run("pnpm", ["exec", "tsx", "--test", gate.file], environment);
    } finally {
      await dropDatabase(admin, gate.database);
      if (cleanupPrincipalRoles) await dropPrincipalGateRoles(admin);
    }
    return;
  }
  await recreateDatabase(admin, gate.database);
  if (gate.id === "database-principals") {
    await prepareLegacyPrincipalGateExtensions(adminUrl, gate.database, testPassword);
  }
  const databaseUrl = buildPostgresGateDatabaseUrl(adminUrl, gate.database, testPassword, gate.schema);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    ENTITLEMENT_DATABASE_URL: databaseUrl,
    [gate.gateEnv]: "1",
  };
  if (gate.databaseUrlEnv !== undefined) env[gate.databaseUrlEnv] = databaseUrl;

  try {
    if (gate.setup === "migrate") {
      await run("pnpm", ["exec", "prisma", "migrate", "deploy", "--config", "prisma.config.ts"], env);
    }
    if (gate.seedAdmin === true) await seedInitialAdmin(databaseUrl);
    await run("pnpm", ["exec", "tsx", "--test", gate.file], env);
  } finally {
    try {
      await dropDatabase(admin, gate.database);
    } finally {
      if (gate.id === "database-principals") {
        await dropDatabasePrincipalGateTemporaryRoles(admin);
      }
    }
  }
}

async function main(): Promise<void> {
  const adminUrl = validatePostgresGateAdminUrl(process.env.POSTGRES_GATE_ADMIN_URL);
  const testPassword = process.env.POSTGRES_GATE_TEST_PASSWORD;
  if (typeof testPassword !== "string" || !/^[A-Za-z0-9_-]{16,128}$/u.test(testPassword)) {
    throw new Error("POSTGRES_GATE_TEST_PASSWORD_INVALID");
  }
  const gates = selectPostgresGates(process.env.POSTGRES_GATE_FILTER);
  const admin = new Client({ connectionString: adminUrl.toString(), connectionTimeoutMillis: 5_000 });
  await admin.connect();
  try {
    await admin.query(`DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${POSTGRES_GATE_TEST_USER}') THEN
          ALTER ROLE "${POSTGRES_GATE_TEST_USER}" WITH LOGIN SUPERUSER PASSWORD '${testPassword}';
          ALTER ROLE "${POSTGRES_GATE_TEST_USER}" SET default_transaction_read_only = 'off';
        ELSE
          CREATE ROLE "${POSTGRES_GATE_TEST_USER}" LOGIN SUPERUSER PASSWORD '${testPassword}';
          ALTER ROLE "${POSTGRES_GATE_TEST_USER}" SET default_transaction_read_only = 'off';
        END IF;
      END
    $$`);
    await admin.query("SET default_transaction_read_only = off");
    for (const [index, gate] of gates.entries()) {
      await runGate(admin, adminUrl, gate, testPassword, index + 1, gates.length);
    }
  } finally {
    await admin.end();
  }
  console.log(`PostgreSQL gates passed: ${gates.length}/${gates.length}`);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
