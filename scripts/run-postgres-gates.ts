import { spawn } from "node:child_process";
import { Client } from "pg";
import {
  buildPostgresGateDatabaseUrl,
  POSTGRES_GATE_TEST_USER,
  selectPostgresGates,
  validatePostgresGateAdminUrl,
  type PostgresGateDefinition,
} from "./postgres-gate-contract";

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
        ('00000000-0000-4000-8000-000000000010', 'postgres_gate_admin', repeat('a', 43), repeat('b', 22), 1, 'admin', CURRENT_TIMESTAMP)
      ON CONFLICT ("username") DO NOTHING
    `);
    await client.query(`
      UPDATE "Workspace"
      SET "createdById" = '00000000-0000-4000-8000-000000000010', "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = '00000000-0000-4000-8000-000000000001'
    `);
    await client.query(`
      INSERT INTO "WorkspaceMembership"
        ("id", "workspaceId", "userId", "role", "updatedAt")
      VALUES
        ('00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000010', 'owner', CURRENT_TIMESTAMP)
      ON CONFLICT ("workspaceId", "userId") DO UPDATE
      SET "role" = 'owner', "updatedAt" = CURRENT_TIMESTAMP
    `);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
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
        ELSE
          CREATE ROLE "${POSTGRES_GATE_TEST_USER}" LOGIN SUPERUSER PASSWORD '${testPassword}';
        END IF;
      END
    $$`);
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
