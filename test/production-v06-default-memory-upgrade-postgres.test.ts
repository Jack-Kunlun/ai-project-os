import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { Client } from "pg";
import test from "node:test";
import { runV06DefaultMemoryUpgradePreflight } from "../scripts/production-v06-default-memory-upgrade-preflight";

const databaseUrl = process.env.PRODUCTION_V06_DEFAULT_MEMORY_UPGRADE_TEST_DATABASE_URL;
const shouldRun = process.env.PRODUCTION_V06_DEFAULT_MEMORY_UPGRADE_POSTGRES_GATE === "1"
  && typeof databaseUrl === "string" && databaseUrl.length > 0;
const run = promisify(execFile);
const SOURCE_LAST_MIGRATION = "20260922050000_harden_personal_knowledge_qa_audit";

async function configForCutoff(includeTarget: boolean): Promise<{ root: string; config: string }> {
  const root = await mkdtemp(path.join(path.dirname(process.cwd()), "ai-project-os-v06-default-memory-"));
  const migrations = path.join(root, "migrations");
  await run("cp", ["-R", path.join(process.cwd(), "prisma/migrations"), migrations]);
  if (!includeTarget) {
    const entries = await readdir(migrations);
    await Promise.all(entries.filter((name) => name > SOURCE_LAST_MIGRATION)
      .map((name) => rm(path.join(migrations, name), { recursive: true, force: true })));
  }
  const config = path.join(root, "prisma.config.ts");
  await writeFile(config, `import { defineConfig } from "prisma/config";\nexport default defineConfig({ schema: "${path.join(process.cwd(), "prisma/schema.prisma")}", migrations: { path: "${migrations}" }, datasource: { url: process.env.DATABASE_URL } });\n`);
  return { root, config };
}

test("v0.6.0-dev.11 preflight proves the exact 116 to 117 ledger and catalog transition", {
  skip: !shouldRun ? "disposable PostgreSQL v06 default-memory upgrade gate is required" : false,
}, async () => {
  const source = await configForCutoff(false);
  const target = await configForCutoff(true);
  const client = new Client({ connectionString: databaseUrl as string, application_name: "v06-default-memory-upgrade-test" });
  try {
    await run("pnpm", ["exec", "prisma", "migrate", "deploy", "--config", source.config], {
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });

    const sourceReport = await runV06DefaultMemoryUpgradePreflight("pre-stop", databaseUrl as string);
    assert.equal(sourceReport.migrationCount, 116);
    assert.equal(sourceReport.targetTag, "v0.6.0-dev.11");
    assert.equal((await runV06DefaultMemoryUpgradePreflight("post-stop", databaseUrl as string)).writerSessions, "stopped");

    const checksum = createHash("sha256").update(await readFile(path.join(
      process.cwd(), "prisma/migrations", SOURCE_LAST_MIGRATION, "migration.sql",
    ))).digest("hex");
    await client.connect();
    try {
      await client.query('UPDATE "_prisma_migrations" SET "checksum" = $1 WHERE "migration_name" = $2', ["0".repeat(64), SOURCE_LAST_MIGRATION]);
      await assert.rejects(
        runV06DefaultMemoryUpgradePreflight("pre-stop", databaseUrl as string),
        /V06_DEFAULT_MEMORY_PREFLIGHT_DATABASE_MIGRATION_LEDGER_INVALID/u,
      );
      await client.query('UPDATE "_prisma_migrations" SET "checksum" = $1 WHERE "migration_name" = $2', [checksum, SOURCE_LAST_MIGRATION]);
    } finally {
      await client.end();
    }

    await run("pnpm", ["exec", "prisma", "migrate", "deploy", "--config", target.config], {
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });
    const targetReport = await runV06DefaultMemoryUpgradePreflight("post-migration", databaseUrl as string);
    assert.equal(targetReport.migrationCount, 117);
    assert.equal(targetReport.targetTag, "v0.6.0-dev.11");
  } finally {
    await rm(source.root, { recursive: true, force: true });
    await rm(target.root, { recursive: true, force: true });
  }
});
