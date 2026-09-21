import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { Client } from "pg";
import { runV06UpgradePreflight } from "../scripts/production-v06-upgrade-preflight";

const runFile = promisify(execFile);
const repositoryRoot = process.cwd();
const migrationRoot = join(repositoryRoot, "prisma/migrations");
const targetMigration = "20260921010000_add_personal_knowledge_domain";
const configuredUrl = process.env.PRODUCTION_V06_UPGRADE_TEST_DATABASE_URL;
const shouldRun = process.env.PRODUCTION_V06_UPGRADE_POSTGRES_GATE === "1"
  && typeof configuredUrl === "string"
  && configuredUrl.length > 0;

/** Reject any accidental attempt to point this destructive gate outside its loopback database. */
function validateDisposableDatabaseUrl(value: string): string {
  const parsed = new URL(value);
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol)
    || !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname.toLowerCase())
    || parsed.port !== "56432"
    || parsed.pathname !== "/ai_project_os_v06_upgrade_test"
    || parsed.search !== ""
    || parsed.hash !== ""
  ) {
    throw new Error("PRODUCTION_V06_UPGRADE_DATABASE_URL_INVALID");
  }
  return value;
}

/** List the exact historical migration directories that form the 0.5 ledger. */
async function readSourceMigrationNames(): Promise<readonly string[]> {
  const names = (await readdir(migrationRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^\d{14}_/u.test(entry.name))
    .map((entry) => entry.name)
    .filter((name) => name !== targetMigration)
    .sort();
  assert.equal(names.length, 106);
  assert.equal(names.includes(targetMigration), false);
  return names;
}

/**
 * Build a temporary Prisma migration tree containing only the 0.5 baseline.
 * Prisma itself applies it, so the ledger shape and checksums match production.
 */
async function createSourceMigrationConfig(): Promise<{ directory: string; configPath: string }> {
  const directory = await mkdtemp(join(repositoryRoot, ".tmp-v06-upgrade-"));
  const stagedMigrations = join(directory, "migrations");
  await mkdir(stagedMigrations);
  await cp(join(migrationRoot, "migration_lock.toml"), join(stagedMigrations, "migration_lock.toml"));
  for (const name of await readSourceMigrationNames()) {
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

/** Run Prisma against the disposable database and surface its full diagnostics. */
async function migrateWithConfig(configPath: string, databaseUrl: string): Promise<void> {
  await runFile("pnpm", ["exec", "prisma", "migrate", "deploy", "--config", configPath], {
    cwd: repositoryRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    maxBuffer: 16 * 1024 * 1024,
  });
}

/** Insert one valid owner-scoped document graph used to exercise database guards. */
async function insertValidKnowledgeGraph(client: Client): Promise<{
  ownerId: string;
  otherOwnerId: string;
  documentId: string;
  revisionId: string;
  auditId: string;
}> {
  const ownerId = randomUUID();
  const otherOwnerId = randomUUID();
  const documentId = randomUUID();
  const revisionId = randomUUID();
  const auditId = randomUUID();
  const now = new Date("2026-09-21T00:00:00.000Z");
  await client.query(
    `INSERT INTO "AppUser" ("id", "username", "role", "updatedAt") VALUES ($1, $2, 'user', $3), ($4, $5, 'user', $3)`,
    [ownerId, `v06_owner_${ownerId.slice(0, 8)}`, now, otherOwnerId, `v06_other_${otherOwnerId.slice(0, 8)}`],
  );
  await client.query("BEGIN");
  try {
    await client.query(
      `INSERT INTO "PersonalKnowledgeDocument" ("id", "ownerUserId", "updatedAt") VALUES ($1, $2, $3)`,
      [documentId, ownerId, now],
    );
    await client.query(
      `INSERT INTO "PersonalKnowledgeRevision" ("id", "documentId", "ownerUserId", "version", "title", "content", "contentHash", "byteCount") VALUES ($1, $2, $3, 1, 'Release gate', 'hello', repeat('a', 64), 5)`,
      [revisionId, documentId, ownerId],
    );
    await client.query(
      `UPDATE "PersonalKnowledgeDocument" SET "currentRevisionId" = $1 WHERE "id" = $2`,
      [revisionId, documentId],
    );
    await client.query(
      `INSERT INTO "PersonalKnowledgeAudit" ("id", "ownerUserId", "documentId", "revisionId", "event", "schemaVersion", "contentHash", "byteCount", "references") VALUES ($1, $2, $3, $4::uuid, 'created', 'v1', repeat('a', 64), 5, jsonb_build_object('revisionId', $4::uuid::text, 'version', 1))`,
      [auditId, ownerId, documentId, revisionId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
  return { ownerId, otherOwnerId, documentId, revisionId, auditId };
}

test("0.6 upgrades an exact 106-entry ledger and enforces personal knowledge integrity", {
  skip: !shouldRun ? "explicit disposable PostgreSQL 0.6 upgrade gate is required" : false,
}, async () => {
  const databaseUrl = validateDisposableDatabaseUrl(configuredUrl as string);
  const staged = await createSourceMigrationConfig();
  try {
    await migrateWithConfig(staged.configPath, databaseUrl);
    assert.deepEqual(await runV06UpgradePreflight("pre-stop", databaseUrl), {
      ok: true,
      kind: "v06-upgrade-preflight",
      phase: "pre-stop",
      targetTag: "v0.6.0-dev.6",
      migrationCount: 106,
      writerSessions: "not-checked",
    });
    assert.equal((await runV06UpgradePreflight("post-stop", databaseUrl)).writerSessions, "stopped");

    await migrateWithConfig(join(repositoryRoot, "prisma.config.ts"), databaseUrl);
    assert.equal((await runV06UpgradePreflight("post-migration", databaseUrl)).migrationCount, 107);

    const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
    await client.connect();
    try {
      const catalog = await client.query<{
        relations: string;
        triggers: string;
        functions: string;
        constraints: string;
        indexes: string;
        document_states: string[];
        audit_events: string[];
      }>(`
        SELECT
          (SELECT count(*)::text FROM pg_class WHERE relname IN ('PersonalKnowledgeDocument', 'PersonalKnowledgeRevision', 'PersonalKnowledgeAudit', 'PersonalKnowledgeIndexPointer')) AS relations,
          (SELECT count(*)::text FROM pg_trigger WHERE tgname IN ('PersonalKnowledgeDocument_current_guard', 'PersonalKnowledgeRevision_immutable_guard', 'PersonalKnowledgeAudit_immutable_guard', 'PersonalKnowledgeAudit_references_guard')) AS triggers,
          (SELECT count(*)::text FROM pg_proc WHERE proname IN ('personal_knowledge_document_current_guard', 'personal_knowledge_revision_immutable_guard', 'personal_knowledge_audit_immutable_guard', 'personal_knowledge_audit_references_guard')) AS functions,
          (SELECT count(*)::text FROM pg_constraint WHERE conname LIKE 'PersonalKnowledge%' AND contype IN ('f', 'c') AND convalidated) AS constraints,
          (SELECT count(*)::text FROM pg_index index_row JOIN pg_class index_class ON index_class.oid = index_row.indexrelid WHERE index_class.relname IN (
            'PersonalKnowledgeDocument_id_ownerUserId_key',
            'PersonalKnowledgeDocument_currentRevisionId_ownerUserId_key',
            'PersonalKnowledgeDocument_ownerUserId_state_updatedAt_id_idx',
            'PersonalKnowledgeDocument_ownerUserId_currentRevisionId_idx',
            'PersonalKnowledgeRevision_documentId_version_key',
            'PersonalKnowledgeRevision_ownerUserId_id_key',
            'PersonalKnowledgeRevision_ownerUserId_documentId_version_idx',
            'PersonalKnowledgeAudit_ownerUserId_id_key',
            'PersonalKnowledgeAudit_ownerUserId_documentId_createdAt_idx',
            'PersonalKnowledgeAudit_ownerUserId_event_createdAt_idx',
            'PersonalKnowledgeIndexPointer_ownerUserId_documentId_key',
            'PersonalKnowledgeIndexPointer_documentId_ownerUserId_key',
            'PersonalKnowledgeIndexPointer_ownerUserId_invalidatedAt_idx'
          ) AND index_row.indisvalid AND index_row.indisready) AS indexes,
          enum_range(NULL::"PersonalKnowledgeDocumentState")::text[] AS document_states,
          enum_range(NULL::"PersonalKnowledgeAuditEvent")::text[] AS audit_events
      `);
      assert.deepEqual(catalog.rows[0], {
        relations: "4",
        triggers: "4",
        functions: "4",
        constraints: "17",
        indexes: "13",
        document_states: ["active", "deleted"],
        audit_events: ["created", "revised", "deleted", "exported"],
      });

      const fixture = await insertValidKnowledgeGraph(client);
      await assert.rejects(
        () => client.query(`UPDATE "PersonalKnowledgeRevision" SET "title" = 'rewritten' WHERE "id" = $1`, [fixture.revisionId]),
        /PERSONAL_KNOWLEDGE_REVISION_IMMUTABLE/u,
      );
      await assert.rejects(
        () => client.query(`DELETE FROM "PersonalKnowledgeAudit" WHERE "id" = $1`, [fixture.auditId]),
        /PERSONAL_KNOWLEDGE_AUDIT_IMMUTABLE/u,
      );
      await assert.rejects(
        () => client.query(
          `INSERT INTO "PersonalKnowledgeRevision" ("id", "documentId", "ownerUserId", "version", "title", "content", "contentHash", "byteCount") VALUES ($1, $2, $3, 2, 'cross owner', 'x', repeat('b', 64), 1)`,
          [randomUUID(), fixture.documentId, fixture.otherOwnerId],
        ),
        /foreign key constraint/u,
      );

      await client.query("BEGIN");
      await client.query(
        `INSERT INTO "PersonalKnowledgeDocument" ("id", "ownerUserId", "updatedAt") VALUES ($1, $2, clock_timestamp())`,
        [randomUUID(), fixture.ownerId],
      );
      await assert.rejects(() => client.query("COMMIT"), /PERSONAL_KNOWLEDGE_CURRENT_REVISION_REQUIRED/u);
      await client.query("ROLLBACK");

      await assert.rejects(
        () => client.query(
          `INSERT INTO "PersonalKnowledgeAudit" ("id", "ownerUserId", "documentId", "revisionId", "event", "schemaVersion", "contentHash", "byteCount", "references") VALUES ($1, $2, $3, $4::uuid, 'exported', 'v1', repeat('a', 64), 5, jsonb_build_object('revisionId', $4::uuid::text, 'version', 1, 'format', 'html'))`,
          [randomUUID(), fixture.ownerId, fixture.documentId, fixture.revisionId],
        ),
        /PERSONAL_KNOWLEDGE_AUDIT_REFERENCES_INVALID/u,
      );
    } finally {
      await client.end();
    }
  } finally {
    await rm(staged.directory, { recursive: true, force: true });
  }
});
