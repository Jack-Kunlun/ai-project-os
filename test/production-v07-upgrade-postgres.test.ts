import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { Client } from "pg";
import test from "node:test";
import { runV07UpgradePreflight } from "../scripts/production-v07-upgrade-preflight";

const runFile = promisify(execFileCallback);
const migrationRoot = resolve(process.cwd(), "prisma/migrations");
const sourceLastMigration = "20260924010000_add_personal_knowledge_graph_suggestions";
const targetLastMigration = "20261001010000_add_browser_web_source_modes";
const sourceMigrationCount = 117;
const targetMigrationCount = 135;
const configuredUrl = process.env.PRODUCTION_V07_UPGRADE_TEST_DATABASE_URL;
const shouldRun = process.env.PRODUCTION_V07_UPGRADE_POSTGRES_GATE === "1"
  && typeof configuredUrl === "string" && configuredUrl.length > 0;
const principalNames = [
  "ai_project_os_migrator",
  "ai_project_os_runtime",
  "ai_project_os_entitlement_writer",
  "ai_project_os_git_automation_worker",
] as const;
const writerNames = [
  "ai_project_os_runtime",
  "ai_project_os_entitlement_writer",
  "ai_project_os_git_automation_worker",
] as const;
const gitAutomationWorker = "ai_project_os_git_automation_worker";

interface LedgerRow {
  id: string;
  checksum: string;
  finished_at: Date | null;
  migration_name: string;
  logs: string | null;
  rolled_back_at: Date | null;
  started_at: Date;
  applied_steps_count: number;
}

function validateDisposableDatabaseUrl(value: string): string {
  const parsed = new URL(value);
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)
    || !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname.toLowerCase())
    || parsed.port !== "56432"
    || parsed.pathname !== "/ai_project_os_production_v07_upgrade_test"
    || parsed.username !== "ai_project_os_gate"
    || parsed.password.length === 0
    || parsed.search !== ""
    || parsed.hash !== "") {
    throw new Error("PRODUCTION_V07_UPGRADE_DATABASE_URL_INVALID");
  }
  return parsed.toString();
}

function roleDatabaseUrl(databaseUrl: string, role: string, password: string): string {
  const parsed = new URL(databaseUrl);
  parsed.username = role;
  parsed.password = password;
  return parsed.toString();
}

async function migrationNames(): Promise<string[]> {
  const names = (await readdir(migrationRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^\d{14}_[a-z0-9_]+$/u.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  assert.ok(names.length >= targetMigrationCount);
  assert.equal(names[sourceMigrationCount - 1], sourceLastMigration);
  assert.equal(names[targetMigrationCount - 1], targetLastMigration);
  return names.slice(0, targetMigrationCount);
}

test("v0.7 upgrade snapshot stays on the historical 117-to-135 migration prefix", async () => {
  const names = await migrationNames();
  assert.equal(names.length, targetMigrationCount);
  assert.equal(names[sourceMigrationCount - 1], sourceLastMigration);
  assert.equal(names[targetMigrationCount - 1], targetLastMigration);
});

async function createMigrationSnapshot(names: readonly string[]): Promise<{ root: string; configPath: string }> {
  const root = await mkdtemp(resolve(tmpdir(), "ai-project-os-v07-upgrade-"));
  const stagedMigrations = resolve(root, "migrations");
  await mkdir(stagedMigrations);
  await cp(resolve(migrationRoot, "migration_lock.toml"), resolve(stagedMigrations, "migration_lock.toml"));
  for (const name of names) {
    await cp(resolve(migrationRoot, name), resolve(stagedMigrations, name), { recursive: true });
  }
  await cp(resolve(process.cwd(), "prisma/schema.prisma"), resolve(root, "schema.prisma"));
  const configPath = resolve(root, "prisma.config.ts");
  await writeFile(configPath, [
    'import { defineConfig, env } from "prisma/config";',
    "export default defineConfig({",
    '  schema: "schema.prisma",',
    '  migrations: { path: "migrations" },',
    '  datasource: { url: env("DATABASE_URL") },',
    "});",
    "",
  ].join("\n"), { mode: 0o600 });
  return { root, configPath };
}

async function migrate(configPath: string, databaseUrl: string): Promise<void> {
  await runFile("pnpm", ["exec", "prisma", "migrate", "deploy", "--config", configPath], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    maxBuffer: 16 * 1024 * 1024,
  });
}

async function createTestPrincipals(client: Client): Promise<Map<string, string>> {
  const existing = await client.query<{ rolname: string }>(
    "SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[]) ORDER BY rolname",
    [[...principalNames]],
  );
  assert.deepEqual(existing.rows, [], "isolated gate role names must be unused before this test");

  const passwords = new Map<string, string>();
  const created: string[] = [];
  try {
    for (const name of principalNames) {
      const password = randomBytes(24).toString("hex");
      await client.query(`CREATE ROLE "${name}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
      passwords.set(name, password);
      created.push(name);
    }
  } catch (error) {
    for (const name of created.reverse()) {
      await client.query(`DROP OWNED BY "${name}"`).catch(() => undefined);
      await client.query(`DROP ROLE IF EXISTS "${name}"`).catch(() => undefined);
    }
    throw error;
  }
  return passwords;
}

async function dropTestPrincipals(client: Client): Promise<void> {
  for (const name of [...principalNames].reverse()) {
    await client.query(`DROP OWNED BY "${name}"`);
    await client.query(`DROP ROLE IF EXISTS "${name}"`);
  }
}

async function expectPreflightCode(
  phase: string,
  tag: string,
  databaseUrl: string,
  code: string,
): Promise<void> {
  await assert.rejects(
    runV07UpgradePreflight(phase, tag, databaseUrl),
    new RegExp(code, "u"),
  );
}

test("v0.7 preflight rejects invalid phase and tag before connecting", async () => {
  await expectPreflightCode("during-stop", "v0.7.3", "", "V07_UPGRADE_PREFLIGHT_PHASE_INVALID");
  await expectPreflightCode("pre-stop", "v0.7.3-dev.0", "", "V07_UPGRADE_PREFLIGHT_TARGET_TAG_INVALID");
});

test("v0.7.3-dev.1 preflight validates the 117 to 135 migration transition and stopped writers", {
  skip: !shouldRun ? "disposable PostgreSQL v0.7 upgrade gate is required" : false,
}, async () => {
  const databaseUrl = validateDisposableDatabaseUrl(configuredUrl as string);
  const names = await migrationNames();
  const source = await createMigrationSnapshot(names.slice(0, sourceMigrationCount));
  const target = await createMigrationSnapshot(names);
  const admin = new Client({ connectionString: databaseUrl, application_name: "v07-upgrade-gate" });
  const connectedWriters: Client[] = [];
  let rolesCreated = false;

  try {
    await admin.connect();
    const passwords = await createTestPrincipals(admin);
    rolesCreated = true;
    await migrate(source.configPath, databaseUrl);

    const ownerId = randomUUID();
    await admin.query(`
      INSERT INTO "AppUser" ("id", "username", "passwordHash", "passwordSalt", "passwordVersion", "role", "updatedAt")
      VALUES ($1, $2, repeat('a', 43), repeat('b', 22), 1, 'user', CURRENT_TIMESTAMP)
    `, [ownerId, `v07_upgrade_${ownerId.slice(0, 8)}`]);

    assert.deepEqual(await runV07UpgradePreflight("pre-stop", "v0.7.3-dev.1", databaseUrl), {
      ok: true,
      kind: "v07-upgrade-preflight",
      phase: "pre-stop",
      targetTag: "v0.7.3-dev.1",
      migrationCount: sourceMigrationCount,
      writerSessions: "not-checked",
    });

    const sourceLastChecksum = (await admin.query<LedgerRow>(`
      SELECT "id", "checksum", "finished_at", "migration_name", "logs", "rolled_back_at", "started_at", "applied_steps_count"
        FROM public."_prisma_migrations"
       WHERE "migration_name" = $1
    `, [sourceLastMigration])).rows[0];
    assert.ok(sourceLastChecksum);

    await admin.query('UPDATE public."_prisma_migrations" SET "checksum" = $1 WHERE "migration_name" = $2', ["0".repeat(64), sourceLastMigration]);
    await expectPreflightCode("pre-stop", "v0.7.3-dev.1", databaseUrl, "V07_UPGRADE_PREFLIGHT_DATABASE_MIGRATION_LEDGER_INVALID");
    await admin.query('UPDATE public."_prisma_migrations" SET "checksum" = $1 WHERE "migration_name" = $2', [sourceLastChecksum.checksum, sourceLastMigration]);

    await admin.query('UPDATE public."_prisma_migrations" SET "finished_at" = NULL WHERE "migration_name" = $1', [sourceLastMigration]);
    await expectPreflightCode("pre-stop", "v0.7.3-dev.1", databaseUrl, "V07_UPGRADE_PREFLIGHT_DATABASE_MIGRATION_LEDGER_INVALID");
    await admin.query('UPDATE public."_prisma_migrations" SET "finished_at" = $1 WHERE "migration_name" = $2', [sourceLastChecksum.finished_at, sourceLastMigration]);

    await admin.query('UPDATE public."_prisma_migrations" SET "rolled_back_at" = clock_timestamp() WHERE "migration_name" = $1', [sourceLastMigration]);
    await expectPreflightCode("pre-stop", "v0.7.3-dev.1", databaseUrl, "V07_UPGRADE_PREFLIGHT_DATABASE_MIGRATION_LEDGER_INVALID");
    await admin.query('UPDATE public."_prisma_migrations" SET "rolled_back_at" = NULL WHERE "migration_name" = $1', [sourceLastMigration]);

    await admin.query('DELETE FROM public."_prisma_migrations" WHERE "migration_name" = $1', [sourceLastMigration]);
    await expectPreflightCode("pre-stop", "v0.7.3-dev.1", databaseUrl, "V07_UPGRADE_PREFLIGHT_DATABASE_MIGRATION_COUNT_INVALID");
    await admin.query(`
      INSERT INTO public."_prisma_migrations"
        ("id", "checksum", "finished_at", "migration_name", "logs", "rolled_back_at", "started_at", "applied_steps_count")
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [
      sourceLastChecksum.id,
      sourceLastChecksum.checksum,
      sourceLastChecksum.finished_at,
      sourceLastChecksum.migration_name,
      sourceLastChecksum.logs,
      sourceLastChecksum.rolled_back_at,
      sourceLastChecksum.started_at,
      sourceLastChecksum.applied_steps_count,
    ]);

    await admin.query(`
      INSERT INTO public."_prisma_migrations"
        ("id", "checksum", "finished_at", "migration_name", "logs", "rolled_back_at", "started_at", "applied_steps_count")
      VALUES ($1, $2, NULL, $3, NULL, NULL, CURRENT_TIMESTAMP, 0)
    `, [randomUUID(), "0".repeat(64), "20260924010000_incomplete_extra_gate_row"]);
    await expectPreflightCode("pre-stop", "v0.7.3-dev.1", databaseUrl, "V07_UPGRADE_PREFLIGHT_DATABASE_MIGRATION_COUNT_INVALID");
    await admin.query('DELETE FROM public."_prisma_migrations" WHERE "migration_name" = $1', ["20260924010000_incomplete_extra_gate_row"]);

    assert.equal((await runV07UpgradePreflight("post-stop", "v0.7.3-dev.1", databaseUrl)).writerSessions, "stopped");
    for (const name of writerNames) {
      const password = passwords.get(name);
      assert.ok(password);
      const writer = new Client({
        connectionString: roleDatabaseUrl(databaseUrl, name, password),
        application_name: `v07-upgrade-gate-${name}`,
        connectionTimeoutMillis: 5_000,
      });
      await writer.connect();
      connectedWriters.push(writer);
      await expectPreflightCode("post-stop", "v0.7.3-dev.1", databaseUrl, "V07_UPGRADE_PREFLIGHT_WRITER_SESSIONS_PRESENT");
      await writer.end();
      connectedWriters.pop();
    }

    await migrate(target.configPath, databaseUrl);
    await admin.query('GRANT CREATE ON SCHEMA public TO "ai_project_os_migrator"');
    await admin.query(`
      ALTER FUNCTION public."project_git_automation_claim_due"(uuid, character varying) OWNER TO "ai_project_os_migrator";
      ALTER FUNCTION public."project_git_automation_mutate_lease"(uuid, character varying, uuid, character varying) OWNER TO "ai_project_os_migrator";
      ALTER FUNCTION public."project_git_automation_reconcile_expired"(uuid) OWNER TO "ai_project_os_migrator";
      ALTER FUNCTION public."project_git_automation_finalize_result"(uuid, character varying, uuid, character varying, character varying, jsonb) OWNER TO "ai_project_os_migrator";
      ALTER FUNCTION public."project_git_automation_read_context"(uuid, character varying, uuid) OWNER TO "ai_project_os_migrator";
      ALTER FUNCTION public."project_git_material_claim_due"(uuid, public."ProjectGitRepositoryMaterialKind", character varying) OWNER TO "ai_project_os_migrator";
      ALTER FUNCTION public."project_git_material_mutate_lease"(uuid, character varying, uuid, character varying) OWNER TO "ai_project_os_migrator";
      ALTER FUNCTION public."project_git_material_reconcile_expired"(uuid) OWNER TO "ai_project_os_migrator";
      ALTER FUNCTION public."project_git_material_read_context"(uuid, character varying, uuid) OWNER TO "ai_project_os_migrator";
      ALTER FUNCTION public."project_git_material_finalize_result"(uuid, character varying, uuid, bigint, character varying, character varying, jsonb) OWNER TO "ai_project_os_migrator";
    `);
    await admin.query('REVOKE CREATE ON SCHEMA public FROM "ai_project_os_migrator"');
    await admin.query(`
      GRANT EXECUTE ON FUNCTION public."project_git_automation_claim_due"(uuid, character varying) TO "${gitAutomationWorker}";
      GRANT EXECUTE ON FUNCTION public."project_git_automation_mutate_lease"(uuid, character varying, uuid, character varying) TO "${gitAutomationWorker}";
      GRANT EXECUTE ON FUNCTION public."project_git_automation_reconcile_expired"(uuid) TO "${gitAutomationWorker}";
      GRANT EXECUTE ON FUNCTION public."project_git_automation_finalize_result"(uuid, character varying, uuid, character varying, character varying, jsonb) TO "${gitAutomationWorker}";
      GRANT EXECUTE ON FUNCTION public."project_git_automation_read_context"(uuid, character varying, uuid) TO "${gitAutomationWorker}";
      GRANT EXECUTE ON FUNCTION public."project_git_material_claim_due"(uuid, public."ProjectGitRepositoryMaterialKind", character varying) TO "${gitAutomationWorker}";
      GRANT EXECUTE ON FUNCTION public."project_git_material_mutate_lease"(uuid, character varying, uuid, character varying) TO "${gitAutomationWorker}";
      GRANT EXECUTE ON FUNCTION public."project_git_material_reconcile_expired"(uuid) TO "${gitAutomationWorker}";
      GRANT EXECUTE ON FUNCTION public."project_git_material_read_context"(uuid, character varying, uuid) TO "${gitAutomationWorker}";
      GRANT EXECUTE ON FUNCTION public."project_git_material_finalize_result"(uuid, character varying, uuid, bigint, character varying, character varying, jsonb) TO "${gitAutomationWorker}";
    `);

    assert.deepEqual(await runV07UpgradePreflight("post-migration", "v0.7.3", databaseUrl), {
      ok: true,
      kind: "v07-upgrade-preflight",
      phase: "post-migration",
      targetTag: "v0.7.3",
      migrationCount: targetMigrationCount,
      writerSessions: "not-checked",
    });
    assert.equal((await admin.query('SELECT count(*)::text AS count FROM "AppUser" WHERE "id" = $1', [ownerId])).rows[0]?.count, "1");
  } finally {
    for (const writer of connectedWriters) await writer.end().catch(() => undefined);
    await admin.end().catch(() => undefined);
    if (rolesCreated) {
      const cleanup = new Client({ connectionString: databaseUrl, application_name: "v07-upgrade-gate-cleanup" });
      await cleanup.connect();
      try {
        await dropTestPrincipals(cleanup);
      } finally {
        await cleanup.end();
      }
    }
    await rm(source.root, { recursive: true, force: true });
    await rm(target.root, { recursive: true, force: true });
  }
});
