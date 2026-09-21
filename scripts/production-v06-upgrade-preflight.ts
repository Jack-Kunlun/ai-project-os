import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { readCliArguments } from "./cli-arguments";

const TARGET_TAG = "v0.6.0-dev.1" as const;
const TARGET_MIGRATION = "20260921010000_add_personal_knowledge_domain" as const;
const SOURCE_MIGRATION_COUNT = 106;
const TARGET_MIGRATION_COUNT = 107;
const ALLOWED_PHASES = new Set(["pre-stop", "post-stop", "post-migration"]);

interface MigrationRow {
  migration_name: string;
  checksum: string;
  finished_at: Date | null;
  rolled_back_at: Date | null;
  applied_steps_count: number;
}

interface ExpectedMigration {
  name: string;
  checksum: string;
}

interface TargetCatalogRow {
  constraints: string;
  indexes: string;
  triggers: string;
  functions: string;
  document_states: string[];
  audit_events: string[];
}

/** Convert an internal failure into a stable code without exposing credentials. */
function safeErrorCode(error: unknown): string {
  if (error instanceof Error && /^[A-Z0-9_]+$/u.test(error.message)) return error.message;
  return "V06_PREFLIGHT_UNEXPECTED_FAILURE";
}

/** Read the immutable migration files from the checked-out release candidate. */
async function readExpectedMigrations(includeTarget: boolean): Promise<readonly ExpectedMigration[]> {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const migrationsRoot = resolve(repositoryRoot, "prisma/migrations");
  const names = (await readdir(migrationsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => includeTarget || name !== TARGET_MIGRATION)
    .sort();

  const expectedCount = includeTarget ? TARGET_MIGRATION_COUNT : SOURCE_MIGRATION_COUNT;
  if (names.length !== expectedCount) throw new Error("V06_PREFLIGHT_RELEASE_MIGRATION_COUNT_INVALID");
  if (includeTarget && names.at(-1) !== TARGET_MIGRATION) throw new Error("V06_PREFLIGHT_TARGET_MIGRATION_INVALID");
  if (!includeTarget && names.includes(TARGET_MIGRATION)) throw new Error("V06_PREFLIGHT_SOURCE_MANIFEST_INVALID");

  return Promise.all(names.map(async (name) => {
    const contents = await readFile(resolve(migrationsRoot, name, "migration.sql"));
    return { name, checksum: createHash("sha256").update(contents).digest("hex") };
  }));
}

/** Require an exact, successfully applied Prisma ledger in chronological order. */
async function assertMigrationLedger(
  client: Client,
  expected: readonly ExpectedMigration[],
): Promise<void> {
  const result = await client.query<MigrationRow>(`
    SELECT "migration_name", "checksum", "finished_at", "rolled_back_at", "applied_steps_count"
      FROM "_prisma_migrations"
     ORDER BY "migration_name"
  `);
  if (result.rows.length !== expected.length) throw new Error("V06_PREFLIGHT_DATABASE_MIGRATION_COUNT_INVALID");
  result.rows.forEach((row, index) => {
    const wanted = expected[index];
    if (
      wanted === undefined
      || row.migration_name !== wanted.name
      || row.checksum !== wanted.checksum
      || row.finished_at === null
      || row.rolled_back_at !== null
      || Number(row.applied_steps_count) < 1
    ) {
      throw new Error("V06_PREFLIGHT_DATABASE_MIGRATION_LEDGER_INVALID");
    }
  });
}

/** Verify whether all 0.6 personal knowledge relations have the expected presence. */
async function assertTargetRelations(client: Client, shouldExist: boolean): Promise<void> {
  const result = await client.query<{ relation_name: string | null }>(`
    SELECT relation::text AS relation_name
      FROM unnest(ARRAY[
        to_regclass('public."PersonalKnowledgeDocument"'),
        to_regclass('public."PersonalKnowledgeRevision"'),
        to_regclass('public."PersonalKnowledgeAudit"'),
        to_regclass('public."PersonalKnowledgeIndexPointer"')
      ]) AS relation
  `);
  const presentCount = result.rows.filter((row) => row.relation_name !== null).length;
  if ((shouldExist && presentCount !== 4) || (!shouldExist && presentCount !== 0)) {
    throw new Error("V06_PREFLIGHT_TARGET_RELATIONS_INVALID");
  }
}

/** Require every database-owned integrity object before starting 0.6 writers. */
async function assertTargetCatalog(client: Client): Promise<void> {
  const result = await client.query<TargetCatalogRow>(`
    SELECT
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
      (SELECT count(*)::text FROM pg_trigger WHERE tgname IN (
        'PersonalKnowledgeDocument_current_guard',
        'PersonalKnowledgeRevision_immutable_guard',
        'PersonalKnowledgeAudit_immutable_guard',
        'PersonalKnowledgeAudit_references_guard'
      ) AND tgenabled <> 'D') AS triggers,
      (SELECT count(*)::text FROM pg_proc WHERE proname IN (
        'personal_knowledge_document_current_guard',
        'personal_knowledge_revision_immutable_guard',
        'personal_knowledge_audit_immutable_guard',
        'personal_knowledge_audit_references_guard'
      )) AS functions,
      enum_range(NULL::"PersonalKnowledgeDocumentState")::text[] AS document_states,
      enum_range(NULL::"PersonalKnowledgeAuditEvent")::text[] AS audit_events
  `);
  const row = result.rows[0];
  if (
    result.rows.length !== 1
    || row === undefined
    || row.constraints !== "17"
    || row.indexes !== "13"
    || row.triggers !== "4"
    || row.functions !== "4"
    || row.document_states.join(",") !== "active,deleted"
    || row.audit_events.join(",") !== "created,revised,deleted,exported"
  ) {
    throw new Error("V06_PREFLIGHT_TARGET_CATALOG_INVALID");
  }
}

/** After writers stop, reject any remaining runtime or entitlement sessions. */
async function assertWriterSessionsStopped(client: Client): Promise<void> {
  const result = await client.query<{ count: string }>(`
    SELECT count(*)::text AS count
      FROM pg_stat_activity
     WHERE datname = current_database()
       AND pid <> pg_backend_pid()
       AND backend_type = 'client backend'
       AND usename IN ('ai_project_os_runtime', 'ai_project_os_entitlement_writer')
  `);
  if (result.rows.length !== 1 || result.rows[0]?.count !== "0") {
    throw new Error("V06_PREFLIGHT_WRITER_SESSIONS_PRESENT");
  }
}

/** Run the phase-specific 0.5 to 0.6 database contract checks. */
export async function runV06UpgradePreflight(
  phase: string,
  databaseUrl: string,
): Promise<Record<string, unknown>> {
  if (!ALLOWED_PHASES.has(phase)) throw new Error("V06_PREFLIGHT_PHASE_INVALID");
  const postMigration = phase === "post-migration";
  const expected = await readExpectedMigrations(postMigration);
  const client = new Client({
    connectionString: databaseUrl,
    application_name: "ai-project-os-v06-upgrade-preflight",
  });
  await client.connect();
  try {
    await assertMigrationLedger(client, expected);
    await assertTargetRelations(client, postMigration);
    if (postMigration) await assertTargetCatalog(client);
    if (phase === "post-stop") await assertWriterSessionsStopped(client);
  } finally {
    await client.end();
  }
  return {
    ok: true,
    kind: "v06-upgrade-preflight",
    phase,
    targetTag: TARGET_TAG,
    migrationCount: expected.length,
    writerSessions: phase === "post-stop" ? "stopped" : "not-checked",
  };
}

/** Parse CLI input, run the contract, and emit a machine-readable result. */
export async function main(
  args: readonly string[] = readCliArguments(),
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<number> {
  try {
    const phase = args[0] ?? "";
    const databaseUrl = env.PRODUCTION_UPGRADE_PREFLIGHT_DATABASE_URL;
    if (databaseUrl === undefined || databaseUrl.length === 0) {
      throw new Error("V06_PREFLIGHT_DATABASE_URL_REQUIRED");
    }
    console.log(JSON.stringify(await runV06UpgradePreflight(phase, databaseUrl)));
    return 0;
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: { code: safeErrorCode(error) } }));
    return 1;
  }
}

const isDirectExecution = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  void main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
