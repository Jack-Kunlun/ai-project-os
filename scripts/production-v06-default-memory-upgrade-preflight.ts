import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { readCliArguments } from "./cli-arguments";

const TARGET_TAG = "v0.6.0-dev.11" as const;
const SOURCE_MIGRATION_COUNT = 116;
const TARGET_MIGRATION_COUNT = 117;
const SOURCE_LAST_MIGRATION = "20260922050000_harden_personal_knowledge_qa_audit" as const;
const TARGET_LAST_MIGRATION = "20260924010000_add_personal_knowledge_graph_suggestions" as const;
const ALLOWED_PHASES = new Set(["pre-stop", "post-stop", "post-migration"]);

interface MigrationRow {
  migration_name: string;
  checksum: string;
  finished_at: Date | null;
  rolled_back_at: Date | null;
  applied_steps_count: number;
}

interface ExpectedMigration { name: string; checksum: string }

const BASELINE_RELATIONS = [
  "PersonalKnowledgeRelation",
  "PersonalConnectionProbeAttempt",
  "PersonalKnowledgeQaChallenge",
  "PersonalKnowledgeQaAudit",
  "PersonalKnowledgeSemanticIndexState",
  "PersonalKnowledgeSemanticGeneration",
  "PersonalKnowledgeSemanticEntry",
  "PersonalKnowledgeSemanticChallenge",
  "PersonalKnowledgeSemanticAudit",
] as const;

const BASELINE_TRIGGERS = [
  ["PersonalKnowledgeRelation_document_delete_guard", "PersonalKnowledgeDocument"],
  ["PersonalConnectionProbeAttempt_updated_at", "PersonalConnectionProbeAttempt"],
  ["PersonalConnectionProbeAttempt_guard", "PersonalConnectionProbeAttempt"],
  ["GitConnection_personal_probe_create_guard", "GitConnection"],
  ["McpConnection_personal_probe_create_guard", "McpConnection"],
  ["GitConnection_personal_probe_update_guard", "GitConnection"],
  ["McpConnection_personal_probe_update_guard", "McpConnection"],
  ["PersonalKnowledgeQaChallenge_guard", "PersonalKnowledgeQaChallenge"],
  ["PersonalKnowledgeQaAudit_guard", "PersonalKnowledgeQaAudit"],
  ["PersonalKnowledgeSemanticDocument_invalidate", "PersonalKnowledgeDocument"],
  ["PersonalKnowledgeSemanticDocument_invalidate_insert", "PersonalKnowledgeDocument"],
  ["PersonalKnowledgeSemanticProvider_invalidate", "AiProviderConnection"],
  ["PersonalKnowledgeSemanticEntry_guard", "PersonalKnowledgeSemanticEntry"],
  ["PersonalKnowledgeSemanticChallenge_guard", "PersonalKnowledgeSemanticChallenge"],
  ["PersonalKnowledgeSemanticAudit_guard", "PersonalKnowledgeSemanticAudit"],
  ["PersonalKnowledgeSemanticChallenge_immutable_guard", "PersonalKnowledgeSemanticChallenge"],
  ["PersonalKnowledgeSemanticAudit_immutable_guard", "PersonalKnowledgeSemanticAudit"],
] as const;

const BASELINE_ENUMS = Object.freeze({
  PersonalConnectionProbeAction: ["create", "update"],
  PersonalConnectionProbeKind: ["git", "mcp"],
  PersonalConnectionProbeStatus: ["running", "settled", "rejected", "held"],
  PersonalKnowledgeQaAuditStatus: ["running", "succeeded", "failed", "unknown"],
  PersonalKnowledgeQaChallengeStatus: ["issued", "consumed"],
  PersonalKnowledgeRelationState: ["active", "revoked"],
  PersonalKnowledgeSemanticAuditStatus: ["running", "succeeded", "failed", "unknown"],
  PersonalKnowledgeSemanticChallengeKind: ["build", "search"],
  PersonalKnowledgeSemanticChallengeStatus: ["issued", "consumed"],
  PersonalKnowledgeSemanticGenerationStatus: ["building", "ready", "failed", "superseded"],
  PersonalKnowledgeSemanticIndexStatus: ["not_built", "building", "ready", "stale", "failed"],
} as const);

function stableCode(error: unknown): string {
  return error instanceof Error && /^[A-Z0-9_]+$/u.test(error.message)
    ? error.message
    : "V06_DEFAULT_MEMORY_PREFLIGHT_UNEXPECTED_FAILURE";
}

async function expectedMigrations(includeTarget: boolean): Promise<readonly ExpectedMigration[]> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "prisma", "migrations");
  const last = includeTarget ? TARGET_LAST_MIGRATION : SOURCE_LAST_MIGRATION;
  const names = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^\d{14}_/u.test(entry.name) && entry.name <= last)
    .map((entry) => entry.name)
    .sort();
  const count = includeTarget ? TARGET_MIGRATION_COUNT : SOURCE_MIGRATION_COUNT;
  if (names.length !== count || names.at(-1) !== last) {
    throw new Error("V06_DEFAULT_MEMORY_PREFLIGHT_RELEASE_MIGRATION_MANIFEST_INVALID");
  }
  return Promise.all(names.map(async (name) => ({
    name,
    checksum: createHash("sha256").update(await readFile(resolve(root, name, "migration.sql"))).digest("hex"),
  })));
}

async function assertLedger(client: Client, expected: readonly ExpectedMigration[]): Promise<void> {
  const result = await client.query<MigrationRow>(`
    SELECT "migration_name", "checksum", "finished_at", "rolled_back_at", "applied_steps_count"
      FROM "_prisma_migrations" ORDER BY "migration_name"
  `);
  if (result.rows.length !== expected.length) throw new Error("V06_DEFAULT_MEMORY_PREFLIGHT_DATABASE_MIGRATION_COUNT_INVALID");
  result.rows.forEach((row, index) => {
    const wanted = expected[index];
    if (wanted === undefined || row.migration_name !== wanted.name || row.checksum !== wanted.checksum
      || row.finished_at === null || row.rolled_back_at !== null || Number(row.applied_steps_count) < 1) {
      throw new Error("V06_DEFAULT_MEMORY_PREFLIGHT_DATABASE_MIGRATION_LEDGER_INVALID");
    }
  });
}

async function assertBaselineCatalog(client: Client): Promise<void> {
  const relations = await client.query<{ name: string }>(`
    SELECT relname AS name FROM pg_class
     WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND relname = ANY($1::text[])
     ORDER BY relname
  `, [BASELINE_RELATIONS]);
  if (relations.rows.length !== BASELINE_RELATIONS.length) {
    throw new Error("V06_DEFAULT_MEMORY_PREFLIGHT_BASELINE_RELATIONS_INVALID");
  }

  const triggerNames = BASELINE_TRIGGERS.map(([name]) => name);
  const triggers = await client.query<{ name: string; relation: string }>(`
    SELECT trigger.tgname AS name, relation.relname AS relation
      FROM pg_trigger trigger JOIN pg_class relation ON relation.oid = trigger.tgrelid
     WHERE NOT trigger.tgisinternal AND trigger.tgenabled <> 'D' AND trigger.tgname = ANY($1::text[])
     ORDER BY trigger.tgname, relation.relname
  `, [triggerNames]);
  const expectedTriggers = BASELINE_TRIGGERS.map(([name, relation]) => ({ name, relation }))
    .sort((left, right) => left.name.localeCompare(right.name) || left.relation.localeCompare(right.relation));
  if (JSON.stringify(triggers.rows) !== JSON.stringify(expectedTriggers)) {
    throw new Error("V06_DEFAULT_MEMORY_PREFLIGHT_BASELINE_TRIGGERS_INVALID");
  }

  const enumNames = Object.keys(BASELINE_ENUMS);
  const enums = await client.query<{ type_name: string; labels: string[] }>(`
    SELECT type.typname AS type_name,
           array_agg(enum.enumlabel ORDER BY enum.enumsortorder)::text[] AS labels
      FROM pg_type type JOIN pg_enum enum ON enum.enumtypid = type.oid
     WHERE type.typname = ANY($1::text[])
     GROUP BY type.typname ORDER BY type.typname
  `, [enumNames]);
  const expectedEnums = Object.entries(BASELINE_ENUMS)
    .map(([type_name, labels]) => ({ type_name, labels: [...labels] }))
    .sort((left, right) => left.type_name.localeCompare(right.type_name));
  if (JSON.stringify(enums.rows) !== JSON.stringify(expectedEnums)) {
    throw new Error("V06_DEFAULT_MEMORY_PREFLIGHT_BASELINE_ENUMS_INVALID");
  }
}

const RELEASE_RELATIONS = [
  "PersonalKnowledgeGraphSuggestion",
  "PersonalKnowledgeExtractionAttempt",
] as const;

const RELEASE_TRIGGERS = [
  ["PersonalKnowledgeGraphSuggestion_guard", "PersonalKnowledgeGraphSuggestion"],
  ["PersonalKnowledgeExtractionAttempt_guard", "PersonalKnowledgeExtractionAttempt"],
] as const;

const RELEASE_INDEXES = [
  ["PersonalKnowledgeDocument_owner_default_idx", "PersonalKnowledgeDocument", false],
  ["PersonalKnowledgeGraphSuggestion_source_triple_key", "PersonalKnowledgeGraphSuggestion", true],
  ["PersonalKnowledgeGraphSuggestion_owner_status_idx", "PersonalKnowledgeGraphSuggestion", false],
  ["PersonalKnowledgeGraphSuggestion_owner_document_idx", "PersonalKnowledgeGraphSuggestion", false],
  ["PersonalKnowledgeExtractionAttempt_ownerUserId_id_key", "PersonalKnowledgeExtractionAttempt", true],
  ["PersonalKnowledgeExtractionAttempt_ownerUserId_issuedAt_idx", "PersonalKnowledgeExtractionAttempt", false],
  ["PersonalKnowledgeExtractionAttempt_provider_status_issued_idx", "PersonalKnowledgeExtractionAttempt", false],
  ["PersonalKnowledgeExtractionAttempt_expiresAt_status_idx", "PersonalKnowledgeExtractionAttempt", false],
] as const;

const RELEASE_CONSTRAINTS = [
  ["PersonalKnowledgeGraphSuggestion_pkey", "PersonalKnowledgeGraphSuggestion", "p"],
  ["PersonalKnowledgeGraphSuggestion_text_check", "PersonalKnowledgeGraphSuggestion", "c"],
  ["PersonalKnowledgeGraphSuggestion_kind_check", "PersonalKnowledgeGraphSuggestion", "c"],
  ["PersonalKnowledgeGraphSuggestion_status_check", "PersonalKnowledgeGraphSuggestion", "c"],
  ["PersonalKnowledgeGraphSuggestion_ownerUserId_fkey", "PersonalKnowledgeGraphSuggestion", "f"],
  ["PersonalKnowledgeGraphSuggestion_document_fkey", "PersonalKnowledgeGraphSuggestion", "f"],
  ["PersonalKnowledgeGraphSuggestion_revision_fkey", "PersonalKnowledgeGraphSuggestion", "f"],
  ["PersonalKnowledgeGraphSuggestion_reviewer_fkey", "PersonalKnowledgeGraphSuggestion", "f"],
  ["PersonalKnowledgeExtractionAttempt_pkey", "PersonalKnowledgeExtractionAttempt", "p"],
  ["PersonalKnowledgeExtractionAttempt_operation_check", "PersonalKnowledgeExtractionAttempt", "c"],
  ["PersonalKnowledgeExtractionAttempt_fingerprint_check", "PersonalKnowledgeExtractionAttempt", "c"],
  ["PersonalKnowledgeExtractionAttempt_counts_check", "PersonalKnowledgeExtractionAttempt", "c"],
  ["PersonalKnowledgeExtractionAttempt_status_check", "PersonalKnowledgeExtractionAttempt", "c"],
  ["PersonalKnowledgeExtractionAttempt_expiry_check", "PersonalKnowledgeExtractionAttempt", "c"],
  ["PersonalKnowledgeExtractionAttempt_owner_fkey", "PersonalKnowledgeExtractionAttempt", "f"],
  ["PersonalKnowledgeExtractionAttempt_document_fkey", "PersonalKnowledgeExtractionAttempt", "f"],
  ["PersonalKnowledgeExtractionAttempt_revision_fkey", "PersonalKnowledgeExtractionAttempt", "f"],
  ["PersonalKnowledgeExtractionAttempt_provider_fkey", "PersonalKnowledgeExtractionAttempt", "f"],
] as const;

const RELEASE_COLUMNS = [
  ["PersonalKnowledgeDocument", "isDefaultMemory"],
  ...[
    "id", "ownerUserId", "documentId", "revisionId", "subject", "subjectKind", "predicate", "object",
    "objectKind", "evidence", "status", "createdAt", "reviewerUserId", "reviewedAt",
  ].map((column) => ["PersonalKnowledgeGraphSuggestion", column] as const),
  ...[
    "id", "ownerUserId", "operation", "documentId", "revisionId", "inputHash", "inputBytes", "pageManifestHash",
    "providerConnectionId", "providerConfigurationVersion", "modelId", "credentialSecretFingerprint",
    "actorAccountAccessVersion", "status", "issuedAt", "expiresAt", "consumedAt", "finalizedAt", "requestCount",
    "providerRequestIds", "inputTokens", "outputTokens", "usageKnown", "safeErrorCode",
  ].map((column) => ["PersonalKnowledgeExtractionAttempt", column] as const),
] as const;

async function assertReleaseCatalog(client: Client, shouldExist: boolean): Promise<void> {
  const relations = await client.query<{ name: string }>(`
    SELECT relname AS name FROM pg_class
     WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND relname = ANY($1::text[])
     ORDER BY relname
  `, [RELEASE_RELATIONS]);
  if (relations.rows.length !== (shouldExist ? RELEASE_RELATIONS.length : 0)) {
    throw new Error("V06_DEFAULT_MEMORY_PREFLIGHT_RELEASE_RELATIONS_INVALID");
  }

  const columns = await client.query<{ table_name: string; column_name: string }>(`
    SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND (
       (table_name = 'PersonalKnowledgeDocument' AND column_name = 'isDefaultMemory')
       OR table_name = ANY($1::text[])
     ) ORDER BY table_name, column_name
  `, [["PersonalKnowledgeGraphSuggestion", "PersonalKnowledgeExtractionAttempt"]]);
  const actualColumns = columns.rows
    .map(({ table_name, column_name }) => ({ table_name, column_name }))
    .sort((left, right) => left.table_name.localeCompare(right.table_name) || left.column_name.localeCompare(right.column_name));
  const expectedColumns = RELEASE_COLUMNS.map(([table_name, column_name]) => ({ table_name, column_name }))
    .sort((left, right) => left.table_name.localeCompare(right.table_name) || left.column_name.localeCompare(right.column_name));
  if (shouldExist ? JSON.stringify(actualColumns) !== JSON.stringify(expectedColumns) : columns.rows.length !== 0) {
    throw new Error("V06_DEFAULT_MEMORY_PREFLIGHT_RELEASE_COLUMNS_INVALID");
  }

  const defaultColumn = await client.query<{ data_type: string; is_nullable: string; column_default: string | null }>(`
    SELECT data_type, is_nullable, column_default FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'PersonalKnowledgeDocument' AND column_name = 'isDefaultMemory'
  `);
  if (shouldExist) {
    const column = defaultColumn.rows[0];
    if (column?.data_type !== "boolean" || column.is_nullable !== "NO" || column.column_default !== "false") {
      throw new Error("V06_DEFAULT_MEMORY_PREFLIGHT_DEFAULT_MEMORY_COLUMN_INVALID");
    }
  } else if (defaultColumn.rows.length !== 0) {
    throw new Error("V06_DEFAULT_MEMORY_PREFLIGHT_DEFAULT_MEMORY_COLUMN_ALREADY_PRESENT");
  }

  const triggerNames = RELEASE_TRIGGERS.map(([name]) => name);
  const triggers = await client.query<{ name: string; relation: string }>(`
    SELECT trigger.tgname AS name, relation.relname AS relation
      FROM pg_trigger trigger JOIN pg_class relation ON relation.oid = trigger.tgrelid
     WHERE NOT trigger.tgisinternal AND trigger.tgenabled <> 'D' AND trigger.tgname = ANY($1::text[])
     ORDER BY trigger.tgname, relation.relname
  `, [triggerNames]);
  const expectedTriggers = RELEASE_TRIGGERS.map(([name, relation]) => ({ name, relation }))
    .sort((left, right) => left.name.localeCompare(right.name) || left.relation.localeCompare(right.relation));
  if (shouldExist ? JSON.stringify(triggers.rows) !== JSON.stringify(expectedTriggers) : triggers.rows.length !== 0) {
    throw new Error("V06_DEFAULT_MEMORY_PREFLIGHT_RELEASE_TRIGGERS_INVALID");
  }

  const indexNames = RELEASE_INDEXES.map(([name]) => name);
  const indexes = await client.query<{ name: string; relation: string; is_unique: boolean }>(`
    SELECT index_class.relname AS name, table_class.relname AS relation, idx.indisunique AS is_unique
      FROM pg_index idx
      JOIN pg_class index_class ON index_class.oid = idx.indexrelid
      JOIN pg_class table_class ON table_class.oid = idx.indrelid
     WHERE index_class.relnamespace = 'public'::regnamespace AND index_class.relname = ANY($1::text[])
     ORDER BY index_class.relname
  `, [indexNames]);
  const expectedIndexes = RELEASE_INDEXES.map(([name, relation, is_unique]) => ({ name, relation, is_unique }))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (shouldExist ? JSON.stringify(indexes.rows) !== JSON.stringify(expectedIndexes) : indexes.rows.length !== 0) {
    throw new Error("V06_DEFAULT_MEMORY_PREFLIGHT_RELEASE_INDEXES_INVALID");
  }

  const constraintNames = RELEASE_CONSTRAINTS.map(([name]) => name);
  const constraints = await client.query<{ name: string; relation: string; type: string }>(`
    SELECT constraint_row.conname AS name, relation.relname AS relation, constraint_row.contype AS type
      FROM pg_constraint constraint_row JOIN pg_class relation ON relation.oid = constraint_row.conrelid
     WHERE relation.relnamespace = 'public'::regnamespace AND constraint_row.conname = ANY($1::text[])
     ORDER BY constraint_row.conname
  `, [constraintNames]);
  const expectedConstraints = RELEASE_CONSTRAINTS.map(([name, relation, type]) => ({ name, relation, type }))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (shouldExist ? JSON.stringify(constraints.rows) !== JSON.stringify(expectedConstraints) : constraints.rows.length !== 0) {
    throw new Error("V06_DEFAULT_MEMORY_PREFLIGHT_RELEASE_CONSTRAINTS_INVALID");
  }

  const auditGuard = await client.query<{ definition: string }>(`
    SELECT pg_get_functiondef('public.personal_knowledge_audit_references_guard()'::regprocedure) AS definition
  `);
  const normalizedGuard = auditGuard.rows[0]?.definition.replace(/\s+/gu, " ").toLowerCase() ?? "";
  if (shouldExist
    ? !normalizedGuard.includes("isdefaultmemory") || !normalizedGuard.includes("reference_key_count in (2, 3)")
      || !normalizedGuard.includes("reference_key_count in (4, 6)")
    : normalizedGuard.includes("isdefaultmemory")) {
    throw new Error("V06_DEFAULT_MEMORY_PREFLIGHT_RELEASE_AUDIT_GUARD_INVALID");
  }
}

async function assertWriterSessionsStopped(client: Client): Promise<void> {
  const result = await client.query<{ count: string }>(`
    SELECT count(*)::text AS count FROM pg_stat_activity
     WHERE datname = current_database() AND pid <> pg_backend_pid()
       AND backend_type = 'client backend'
       AND usename IN ('ai_project_os_runtime', 'ai_project_os_entitlement_writer')
  `);
  if (result.rows[0]?.count !== "0") throw new Error("V06_DEFAULT_MEMORY_PREFLIGHT_WRITER_SESSIONS_PRESENT");
}

export async function runV06DefaultMemoryUpgradePreflight(phase: string, databaseUrl: string): Promise<Record<string, unknown>> {
  if (!ALLOWED_PHASES.has(phase)) throw new Error("V06_DEFAULT_MEMORY_PREFLIGHT_PHASE_INVALID");
  const postMigration = phase === "post-migration";
  const expected = await expectedMigrations(postMigration);
  const client = new Client({ connectionString: databaseUrl, application_name: "ai-project-os-v06-default-memory-upgrade-preflight" });
  await client.connect();
  try {
    await assertLedger(client, expected);
    await assertBaselineCatalog(client);
    await assertReleaseCatalog(client, postMigration);
    if (phase === "post-stop") await assertWriterSessionsStopped(client);
  } finally {
    await client.end();
  }
  return {
    ok: true,
    kind: "v06-default-memory-upgrade-preflight",
    phase,
    targetTag: TARGET_TAG,
    migrationCount: expected.length,
    writerSessions: phase === "post-stop" ? "stopped" : "not-checked",
  };
}

export async function main(
  args: readonly string[] = readCliArguments(),
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<number> {
  try {
    const databaseUrl = env.PRODUCTION_UPGRADE_PREFLIGHT_DATABASE_URL;
    if (!databaseUrl) throw new Error("V06_DEFAULT_MEMORY_PREFLIGHT_DATABASE_URL_REQUIRED");
    console.log(JSON.stringify(await runV06DefaultMemoryUpgradePreflight(args[0] ?? "", databaseUrl)));
    return 0;
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: { code: stableCode(error) } }));
    return 1;
  }
}

const direct = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (direct) void main().then((exitCode) => { process.exitCode = exitCode; });
