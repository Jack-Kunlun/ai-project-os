import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { Client } from "pg";
import { runV06PatchUpgradePreflight } from "../scripts/production-v06-patch-upgrade-preflight";

const execFile = promisify(execFileCallback);
const configuredUrl = process.env.PRODUCTION_V06_PATCH_UPGRADE_TEST_DATABASE_URL;
const shouldRun = process.env.PRODUCTION_V06_PATCH_UPGRADE_POSTGRES_GATE === "1"
  && typeof configuredUrl === "string"
  && configuredUrl.length > 0;
const testDatabaseName = "ai_project_os_v06_patch_upgrade_test";
const repositoryRoot = process.cwd();
const migrationRoot = join(repositoryRoot, "prisma/migrations");
const lastMigration = "20260921010000_add_personal_knowledge_domain";
const WRITER_ROLE = "ai_project_os_runtime";
const WRITER_PASSWORD = "AiProjectOsPatchGateWriter_20260922";

/** Restrict this destructive gate to the disposable loopback database runner. */
function validateDisposableDatabaseUrl(value: string): string {
  const parsed = new URL(value);
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol)
    || !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname.toLowerCase())
    || parsed.port !== "56432"
    || parsed.pathname !== "/" + testDatabaseName
    || parsed.username !== "ai_project_os_gate"
    || parsed.password.length === 0
    || parsed.search !== ""
    || parsed.hash !== ""
  ) {
    throw new Error("PRODUCTION_V06_PATCH_UPGRADE_DATABASE_URL_INVALID");
  }
  return parsed.toString();
}

/** List the exact 107 migration directories shipped by the .6 schema baseline. */
async function readBaselineMigrationNames(): Promise<readonly string[]> {
  const names = (await readdir(migrationRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^\d{14}_/u.test(entry.name))
    .map((entry) => entry.name)
    .filter((name) => name <= lastMigration)
    .sort();
  assert.equal(names.length, 107);
  assert.equal(names.at(-1), lastMigration);
  return names;
}

/** Stage an exact .6 baseline so later next-version migrations cannot enter this gate. */
async function createBaselineMigrationConfig(): Promise<{ directory: string; configPath: string }> {
  const directory = await mkdtemp(join(repositoryRoot, ".tmp-v06-patch-upgrade-"));
  const stagedMigrations = join(directory, "migrations");
  await mkdir(stagedMigrations);
  await cp(join(migrationRoot, "migration_lock.toml"), join(stagedMigrations, "migration_lock.toml"));
  for (const name of await readBaselineMigrationNames()) {
    await cp(join(migrationRoot, name), join(stagedMigrations, name), { recursive: true });
  }
  const configPath = join(directory, "prisma.config.ts");
  await writeFile(configPath, [
    'import { defineConfig, env } from "prisma/config";',
    "export default defineConfig({",
    `  schema: ${JSON.stringify(join(repositoryRoot, "prisma/schema.prisma"))},`,
    `  migrations: { path: ${JSON.stringify(stagedMigrations)} },`,
    '  datasource: { url: env("DATABASE_URL") },',
    "});",
    "",
  ].join("\n"));
  return { directory, configPath };
}

/** Apply the exact 107 migration baseline before running the read-only patch checks. */
async function migrateBaseline(configPath: string, databaseUrl: string): Promise<void> {
  await execFile("pnpm", ["exec", "prisma", "migrate", "deploy", "--config", configPath], {
    cwd: repositoryRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    maxBuffer: 16 * 1024 * 1024,
  });
}

/** Create the named runtime session role only for the writer-session assertion. */
async function ensureWriterRole(databaseUrl: string): Promise<{ roleCreated: boolean }> {
  const admin = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  await admin.connect();
  try {
    const existing = await admin.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists",
      [WRITER_ROLE],
    );
    const roleCreated = existing.rows[0]?.exists !== true;
    if (roleCreated) {
      await admin.query("CREATE ROLE \"ai_project_os_runtime\" LOGIN PASSWORD 'AiProjectOsPatchGateWriter_20260922'");
    } else {
      await admin.query("ALTER ROLE \"ai_project_os_runtime\" WITH LOGIN PASSWORD 'AiProjectOsPatchGateWriter_20260922'");
    }
    return { roleCreated };
  } finally {
    await admin.end();
  }
}

/** Open a second backend as the runtime principal so post-stop rejects it. */
async function openWriterSession(databaseUrl: string): Promise<Client> {
  const writerUrl = new URL(databaseUrl);
  writerUrl.username = WRITER_ROLE;
  writerUrl.password = WRITER_PASSWORD;
  const writer = new Client({ connectionString: writerUrl.toString(), connectionTimeoutMillis: 5_000 });
  await writer.connect();
  return writer;
}

/** Remove the temporary role when this isolated gate created it. */
async function removeWriterRole(databaseUrl: string, roleCreated: boolean): Promise<void> {
  if (!roleCreated) return;
  const admin = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  await admin.connect();
  try {
    await admin.query("DROP ROLE IF EXISTS \"ai_project_os_runtime\"");
  } finally {
    await admin.end();
  }
}

test("0.6.0-dev.7 patch preflight verifies the 107 ledger across all phases and rejects active writers", {
  skip: !shouldRun ? "explicit disposable PostgreSQL 0.6 patch gate is required" : false,
}, async () => {
  const databaseUrl = validateDisposableDatabaseUrl(configuredUrl as string);
  const staged = await createBaselineMigrationConfig();
  try {
    await migrateBaseline(staged.configPath, databaseUrl);

    const preStop = await runV06PatchUpgradePreflight("pre-stop", databaseUrl);
    assert.deepEqual(preStop, {
      ok: true,
      kind: "v06-patch-upgrade-preflight",
      phase: "pre-stop",
      targetTag: "v0.6.0-dev.7",
      migrationCount: 107,
      migrationChange: "none",
      writerSessions: "not-checked",
    });

    const { roleCreated } = await ensureWriterRole(databaseUrl);
    let writer: Client | undefined;
    try {
      writer = await openWriterSession(databaseUrl);
      await assert.rejects(
        () => runV06PatchUpgradePreflight("post-stop", databaseUrl),
        (error: unknown) => error instanceof Error
          && error.message === "V06_PATCH_PREFLIGHT_WRITER_SESSIONS_PRESENT",
      );
      await writer.end();
      writer = undefined;

      assert.deepEqual(await runV06PatchUpgradePreflight("post-stop", databaseUrl), {
        ok: true,
        kind: "v06-patch-upgrade-preflight",
        phase: "post-stop",
        targetTag: "v0.6.0-dev.7",
        migrationCount: 107,
        migrationChange: "none",
        writerSessions: "stopped",
      });
      assert.deepEqual(await runV06PatchUpgradePreflight("post-cutover", databaseUrl), {
        ok: true,
        kind: "v06-patch-upgrade-preflight",
        phase: "post-cutover",
        targetTag: "v0.6.0-dev.7",
        migrationCount: 107,
        migrationChange: "none",
        writerSessions: "not-checked",
      });
    } finally {
      if (writer !== undefined) await writer.end();
      await removeWriterRole(databaseUrl, roleCreated);
    }
  } finally {
    await rm(staged.directory, { recursive: true, force: true });
  }
});
