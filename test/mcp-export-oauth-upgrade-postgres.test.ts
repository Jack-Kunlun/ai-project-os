import "dotenv/config";
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { Client } from "pg";

const shouldRun = process.env.MCP_EXPORT_OAUTH_UPGRADE_POSTGRES_GATE === "1";
const databaseUrl = process.env.DATABASE_URL;
const targetMigration = "20260929050000_harden_mcp_export_oauth";
const run = promisify(execFileCallback);

function requireDisposableDatabase(): string {
  if (typeof databaseUrl !== "string") throw new Error("MCP_EXPORT_OAUTH_UPGRADE_DATABASE_URL_REQUIRED");
  const parsed = new URL(databaseUrl);
  if (!(["postgres:", "postgresql:"].includes(parsed.protocol)
    && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname.toLowerCase())
    && parsed.port === "56432"
    && parsed.pathname === "/ai_project_os_mcp_export_oauth_upgrade_test"
    && parsed.username === "ai_project_os_gate"
    && parsed.password.length > 0
    && parsed.search === ""
    && parsed.hash === "")) throw new Error("MCP_EXPORT_OAUTH_UPGRADE_DATABASE_URL_INVALID");
  return parsed.toString();
}

test("129 upgrades historical immutable MCP dispatch audits without inventing OAuth client identity", {
  skip: !shouldRun ? "MCP_EXPORT_OAUTH_UPGRADE_POSTGRES_GATE=1 is required" : false,
}, async () => {
  const url = requireDisposableDatabase();
  const root = await mkdtemp(join(tmpdir(), "ai-project-os-oauth-upgrade-"));
  const migrationsRoot = join(root, "migrations");
  const config = join(root, "prisma.config.ts");
  const migrations = (await readdir(join(process.cwd(), "prisma", "migrations"), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^\d{14}_[a-z0-9_]+$/u.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const targetIndex = migrations.indexOf(targetMigration);
  assert.ok(targetIndex > 0, "target migration is present after prior migrations");
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  const deploy = async () => run("pnpm", ["exec", "prisma", "migrate", "deploy", "--config", config], {
    cwd: process.cwd(), env: { ...process.env, DATABASE_URL: url }, timeout: 90_000, maxBuffer: 4 * 1024 * 1024,
  });
  try {
    await mkdir(migrationsRoot, { recursive: true });
    await writeFile(config, `import { defineConfig } from "prisma/config";\nexport default defineConfig({ schema: ${JSON.stringify(join(process.cwd(), "prisma", "schema.prisma"))}, migrations: { path: ${JSON.stringify(migrationsRoot)} }, datasource: { url: process.env.DATABASE_URL } });\n`);
    for (const name of migrations.slice(0, targetIndex)) {
      await cp(join(process.cwd(), "prisma", "migrations", name), join(migrationsRoot, name), { recursive: true });
    }
    await deploy();
    await client.connect();

    const auditId = randomUUID();
    const approvalId = randomUUID();
    const grantId = randomUUID();
    const projectId = randomUUID();
    const ownerUserId = randomUUID();
    await client.query(
      `INSERT INTO "McpExportDispatchAudit" (
         "id", "approvalId", "grantId", "projectId", "ownerUserId", "recipientLabel", "provider", "model",
         "operation", "inputFingerprint", "contentFingerprint"
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7, $8, $9, $10, $11)`,
      [auditId, approvalId, grantId, projectId, ownerUserId, "legacy recipient", "legacy", "legacy",
        "project_summary", "1".repeat(64), "2".repeat(64)],
    );
    await cp(join(process.cwd(), "prisma", "migrations", targetMigration), join(migrationsRoot, targetMigration), { recursive: true });
    await deploy();

    const upgraded = await client.query<{
      recipientLabel: string;
      oauthClientId: string | null;
      oauthClientName: string | null;
      completedMigrations: string;
    }>(
      `SELECT audit."recipientLabel", audit."oauthClientId", audit."oauthClientName",
              (SELECT count(*)::text FROM "_prisma_migrations"
                WHERE "migration_name" = $2 AND "finished_at" IS NOT NULL) AS "completedMigrations"
         FROM "McpExportDispatchAudit" audit WHERE audit."id" = $1::uuid`,
      [auditId, targetMigration],
    );
    assert.deepEqual(upgraded.rows, [{
      recipientLabel: "legacy recipient", oauthClientId: null, oauthClientName: null, completedMigrations: "1",
    }]);
    await assert.rejects(
      () => client.query(`UPDATE "McpExportDispatchAudit" SET "recipientLabel" = 'rewritten' WHERE "id" = $1::uuid`, [auditId]),
      (error: unknown) => (error as { code?: string }).code === "23514",
    );
    await assert.rejects(
      () => client.query(`DELETE FROM "McpExportDispatchAudit" WHERE "id" = $1::uuid`, [auditId]),
      (error: unknown) => (error as { code?: string }).code === "23514",
    );
  } finally {
    await client.end().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
