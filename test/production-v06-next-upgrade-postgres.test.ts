import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { runV06NextUpgradePreflight } from "../scripts/production-v06-next-upgrade-preflight";

const databaseUrl = process.env.PRODUCTION_V06_NEXT_UPGRADE_TEST_DATABASE_URL;
const shouldRun = process.env.PRODUCTION_V06_NEXT_UPGRADE_POSTGRES_GATE === "1"
  && typeof databaseUrl === "string" && databaseUrl.length > 0;
const run = promisify(execFile);

async function configForCutoff(includeTarget: boolean): Promise<{ root: string; config: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "ai-project-os-v06-next-"));
  const migrations = path.join(root, "migrations");
  await run("cp", ["-R", path.join(process.cwd(), "prisma/migrations"), migrations]);
  // Keep this historical replay pinned to the migrations shipped by .8.
  const cutoff = includeTarget
    ? "20260922050000_harden_personal_knowledge_qa_audit"
    : "20260921010000_add_personal_knowledge_domain";
  const entries = await import("node:fs/promises").then(({ readdir }) => readdir(migrations));
  await Promise.all(entries.filter((name) => name > cutoff)
    .map((name) => rm(path.join(migrations, name), { recursive: true, force: true })));
  const config = path.join(root, "prisma.config.ts");
  await writeFile(config, `import { defineConfig } from "prisma/config";
export default defineConfig({ schema: "${path.join(process.cwd(), "prisma/schema.prisma")}", migrations: { path: "${migrations}" }, datasource: { url: process.env.DATABASE_URL } });
`);
  return { root, config };
}

test("0.6.0-dev.8 preflight verifies the exact 107 to 116 migration transition", {
  skip: !shouldRun ? "explicit disposable PostgreSQL v06 next upgrade gate is required" : false,
}, async () => {
  const source = await configForCutoff(false);
  const target = await configForCutoff(true);
  try {
    await run("pnpm", ["exec", "prisma", "migrate", "deploy", "--config", source.config], {
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });
    assert.equal((await runV06NextUpgradePreflight("pre-stop", databaseUrl as string)).migrationCount, 107);
    assert.equal((await runV06NextUpgradePreflight("post-stop", databaseUrl as string)).writerSessions, "stopped");

    await run("pnpm", ["exec", "prisma", "migrate", "deploy", "--config", target.config], {
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });
    const report = await runV06NextUpgradePreflight("post-migration", databaseUrl as string);
    assert.equal(report.migrationCount, 116);
    assert.equal(report.targetTag, "v0.6.0-dev.8");
  } finally {
    await rm(source.root, { recursive: true, force: true });
    await rm(target.root, { recursive: true, force: true });
  }
});
