import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { readCliArguments } from "./cli-arguments";

/** Exact release tag this read-only preflight is allowed to certify. */
const TARGET_TAG = "v0.6.0-dev.7" as const;
/** Last migration directory in the v0.6.0-dev.6 database baseline. */
const LAST_MIGRATION = "20260921010000_add_personal_knowledge_domain" as const;
/** Number of completed migrations required before and after the patch. */
const EXPECTED_MIGRATION_COUNT = 107;
/** Lifecycle phases accepted by the deployment script. */
const ALLOWED_PHASES = new Set(["pre-stop", "post-stop", "post-cutover"]);

interface MigrationRow {
  /** Prisma migration directory name recorded in the database ledger. */
  migration_name: string;
  /** SHA-256 checksum of the migration SQL recorded by Prisma. */
  checksum: string;
  /** Timestamp set only when Prisma applied the migration successfully. */
  finished_at: Date | null;
  /** Rollback timestamp; a valid baseline must keep this null. */
  rolled_back_at: Date | null;
  /** Number of SQL steps applied for this migration. */
  applied_steps_count: number;
}

interface ExpectedMigration {
  /** Directory name read from the candidate checkout. */
  name: string;
  /** Checksum calculated from that checkout's migration.sql. */
  checksum: string;
}

interface TargetCatalogRow {
  /** Count of validated PersonalKnowledge constraints. */
  constraints: string;
  /** Count of valid PersonalKnowledge indexes. */
  indexes: string;
  /** Count of enabled PersonalKnowledge triggers. */
  triggers: string;
  /** Count of PersonalKnowledge guard functions. */
  functions: string;
  /** Ordered enum values for document lifecycle states. */
  document_states: string[];
  /** Ordered enum values for audit event types. */
  audit_events: string[];
}

/** Keep this .7 patch preflight scoped to Prisma migration directories. */
function isMigrationDirectoryName(name: string): boolean {
  return /^\d{14}_/u.test(name);
}

/** Convert an internal failure into a stable code without exposing credentials. */
function safeErrorCode(error: unknown): string {
  if (error instanceof Error && /^[A-Z0-9_]+$/u.test(error.message)) return error.message;
  return "V06_PATCH_PREFLIGHT_UNEXPECTED_FAILURE";
}

/** Read exactly the 107 migrations shipped by the .6 schema baseline. */
async function readExpectedMigrations(): Promise<readonly ExpectedMigration[]> {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const migrationsRoot = resolve(repositoryRoot, "prisma/migrations");
  const names = (await readdir(migrationsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && isMigrationDirectoryName(entry.name))
    .map((entry) => entry.name)
    .filter((name) => name <= LAST_MIGRATION)
    .sort();

  if (names.length !== EXPECTED_MIGRATION_COUNT) {
    throw new Error("V06_PATCH_PREFLIGHT_MIGRATION_COUNT_INVALID");
  }
  if (names.at(-1) !== LAST_MIGRATION) {
    throw new Error("V06_PATCH_PREFLIGHT_LAST_MIGRATION_INVALID");
  }

  return Promise.all(names.map(async (name) => {
    const contents = await readFile(resolve(migrationsRoot, name, "migration.sql"));
    return { name, checksum: createHash("sha256").update(contents).digest("hex") };
  }));
}

/** Require an exact, successfully applied 107-row Prisma ledger. */
async function assertMigrationLedger(
  client: Client,
  expected: readonly ExpectedMigration[],
): Promise<void> {
  const result = await client.query<MigrationRow>(`
    SELECT "migration_name", "checksum", "finished_at", "rolled_back_at", "applied_steps_count"
      FROM "_prisma_migrations"
     ORDER BY "migration_name"
  `);
  if (result.rows.length !== EXPECTED_MIGRATION_COUNT || result.rows.length !== expected.length) {
    throw new Error("V06_PATCH_PREFLIGHT_DATABASE_MIGRATION_COUNT_INVALID");
  }
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
      throw new Error("V06_PATCH_PREFLIGHT_DATABASE_MIGRATION_LEDGER_INVALID");
    }
  });
}

/** Verify that the personal knowledge relations remain present and unchanged. */
async function assertTargetRelations(client: Client): Promise<void> {
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
  if (presentCount !== 4) throw new Error("V06_PATCH_PREFLIGHT_TARGET_RELATIONS_INVALID");
}

/** Require every database-owned integrity object before .7 writers start. */
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
    throw new Error("V06_PATCH_PREFLIGHT_TARGET_CATALOG_INVALID");
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
    throw new Error("V06_PATCH_PREFLIGHT_WRITER_SESSIONS_PRESENT");
  }
}

/**
 * Run the no-migration .6 to .7 patch contract for one cutover phase.
 *
 * @param phase Deployment lifecycle phase being checked.
 * @param databaseUrl Cluster-admin connection string supplied by Compose.
 */
export async function runV06PatchUpgradePreflight(
  phase: string,
  databaseUrl: string,
): Promise<Record<string, unknown>> {
  if (!ALLOWED_PHASES.has(phase)) throw new Error("V06_PATCH_PREFLIGHT_PHASE_INVALID");
  const expected = await readExpectedMigrations();
  const client = new Client({
    connectionString: databaseUrl,
    application_name: "ai-project-os-v06-patch-upgrade-preflight",
  });
  await client.connect();
  try {
    await assertMigrationLedger(client, expected);
    await assertTargetRelations(client);
    await assertTargetCatalog(client);
    if (phase === "post-stop") await assertWriterSessionsStopped(client);
  } finally {
    await client.end();
  }
  return {
    ok: true,
    kind: "v06-patch-upgrade-preflight",
    phase,
    targetTag: TARGET_TAG,
    migrationCount: EXPECTED_MIGRATION_COUNT,
    migrationChange: "none",
    writerSessions: phase === "post-stop" ? "stopped" : "not-checked",
  };
}

/**
 * Parse CLI input, run the contract, and emit a machine-readable result.
 *
 * @param args CLI arguments; the first argument is the lifecycle phase.
 * @param env Environment map used to read the preflight database URL.
 */
export async function main(
  args: readonly string[] = readCliArguments(),
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<number> {
  try {
    const phase = args[0] ?? "";
    const databaseUrl = env.PRODUCTION_UPGRADE_PREFLIGHT_DATABASE_URL;
    if (databaseUrl === undefined || databaseUrl.length === 0) {
      throw new Error("V06_PATCH_PREFLIGHT_DATABASE_URL_REQUIRED");
    }
    console.log(JSON.stringify(await runV06PatchUpgradePreflight(phase, databaseUrl)));
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
