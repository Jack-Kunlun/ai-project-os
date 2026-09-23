import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "pg";
import { runV06NextUpgradePreflight } from "./production-v06-next-upgrade-preflight";

const phases = new Set(["pre-stop", "post-stop", "post-cutover"]);
const tagPattern = /^v0\.6\.0-dev\.[1-9][0-9]*$/u;

export async function runAppUpgradePreflight(phase: string, targetTag: string, databaseUrl: string) {
  if (!phases.has(phase)) throw new Error("APP_PREFLIGHT_PHASE_INVALID");
  if (!tagPattern.test(targetTag)) throw new Error("APP_PREFLIGHT_TARGET_INVALID");
  const migrations = (await readdir(resolve(process.cwd(), "prisma/migrations")))
    .filter((name) => /^\d{14}_/u.test(name));
  if (migrations.length !== 116) throw new Error("APP_PREFLIGHT_MIGRATION_MANIFEST_INVALID");
  await runV06NextUpgradePreflight("post-migration", databaseUrl);
  if (phase === "post-stop") {
    const client = new Client({ connectionString: databaseUrl, application_name: "ai-project-os-app-upgrade-preflight" });
    await client.connect();
    try {
      const result = await client.query<{ count: string }>(`
        SELECT count(*)::text AS count FROM pg_stat_activity
         WHERE datname = current_database() AND pid <> pg_backend_pid()
           AND backend_type = 'client backend'
           AND usename IN ('ai_project_os_runtime', 'ai_project_os_entitlement_writer')
      `);
      if (result.rows[0]?.count !== "0") throw new Error("APP_PREFLIGHT_WRITER_SESSIONS_PRESENT");
    } finally {
      await client.end();
    }
  }
  return { ok: true, kind: "app-upgrade-preflight", phase, targetTag, migrationCount: 116,
    migrationChange: "none", writerSessions: phase === "post-stop" ? "stopped" : "not-checked" };
}

if (process.argv[1]?.endsWith("production-app-upgrade-preflight.ts")) {
  const [phase = "", targetTag = ""] = process.argv.slice(2);
  const databaseUrl = process.env.PRODUCTION_UPGRADE_PREFLIGHT_DATABASE_URL;
  if (!databaseUrl) {
    console.log(JSON.stringify({ ok: false, error: { code: "APP_PREFLIGHT_DATABASE_URL_REQUIRED" } }));
    process.exitCode = 1;
  } else {
    runAppUpgradePreflight(phase, targetTag, databaseUrl).then(
      (result) => console.log(JSON.stringify(result)),
      (error: unknown) => {
        const code = error instanceof Error && /^[A-Z0-9_]+$/u.test(error.message)
          ? error.message : "APP_PREFLIGHT_UNEXPECTED_FAILURE";
        console.log(JSON.stringify({ ok: false, error: { code } }));
        process.exitCode = 1;
      },
    );
  }
}
