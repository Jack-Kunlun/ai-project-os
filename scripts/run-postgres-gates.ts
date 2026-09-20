import { spawn } from "node:child_process";
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

async function recreateDatabase(admin: Client, database: string): Promise<void> {
  const quoted = quoteDatabaseName(database);
  await admin.query(`DROP DATABASE IF EXISTS ${quoted} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${quoted} OWNER "${POSTGRES_GATE_TEST_USER}"`);
}

async function dropDatabase(admin: Client, database: string): Promise<void> {
  await admin.query(`DROP DATABASE IF EXISTS ${quoteDatabaseName(database)} WITH (FORCE)`);
}

async function seedInitialAdmin(databaseUrl: string): Promise<void> {
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

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
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
  await recreateDatabase(admin, gate.database);
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
    await dropDatabase(admin, gate.database);
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
