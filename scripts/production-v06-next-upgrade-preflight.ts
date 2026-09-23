import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { readCliArguments } from "./cli-arguments";

const TARGET_TAG = "v0.6.0-dev.8" as const;
const SOURCE_MIGRATION_COUNT = 107;
const TARGET_MIGRATION_COUNT = 116;
const SOURCE_LAST_MIGRATION = "20260921010000_add_personal_knowledge_domain" as const;
const TARGET_LAST_MIGRATION = "20260922050000_harden_personal_knowledge_qa_audit" as const;
const ALLOWED_PHASES = new Set(["pre-stop", "post-stop", "post-migration"]);

interface MigrationRow {
  migration_name: string;
  checksum: string;
  finished_at: Date | null;
  rolled_back_at: Date | null;
  applied_steps_count: number;
}

interface ExpectedMigration { name: string; checksum: string }

const TARGET_RELATIONS = [
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

const TARGET_TRIGGERS = [
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

const TARGET_ENUMS = Object.freeze({
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
    : "V06_NEXT_PREFLIGHT_UNEXPECTED_FAILURE";
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
    throw new Error("V06_NEXT_PREFLIGHT_RELEASE_MIGRATION_MANIFEST_INVALID");
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
  if (result.rows.length !== expected.length) throw new Error("V06_NEXT_PREFLIGHT_DATABASE_MIGRATION_COUNT_INVALID");
  result.rows.forEach((row, index) => {
    const wanted = expected[index];
    if (wanted === undefined || row.migration_name !== wanted.name || row.checksum !== wanted.checksum
      || row.finished_at === null || row.rolled_back_at !== null || Number(row.applied_steps_count) < 1) {
      throw new Error("V06_NEXT_PREFLIGHT_DATABASE_MIGRATION_LEDGER_INVALID");
    }
  });
}

async function assertTargetCatalog(client: Client, shouldExist: boolean): Promise<void> {
  const relations = await client.query<{ name: string }>(`
    SELECT relname AS name FROM pg_class
     WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND relname = ANY($1::text[])
     ORDER BY relname
  `, [TARGET_RELATIONS]);
  if (relations.rows.length !== (shouldExist ? TARGET_RELATIONS.length : 0)) {
    throw new Error("V06_NEXT_PREFLIGHT_TARGET_RELATIONS_INVALID");
  }
  if (!shouldExist) return;

  const triggerNames = TARGET_TRIGGERS.map(([name]) => name);
  const triggers = await client.query<{ name: string; relation: string }>(`
    SELECT trigger.tgname AS name, relation.relname AS relation
      FROM pg_trigger trigger JOIN pg_class relation ON relation.oid = trigger.tgrelid
     WHERE NOT trigger.tgisinternal AND trigger.tgenabled <> 'D' AND trigger.tgname = ANY($1::text[])
     ORDER BY trigger.tgname, relation.relname
  `, [triggerNames]);
  const expectedTriggers = TARGET_TRIGGERS.map(([name, relation]) => ({ name, relation }))
    .sort((left, right) => left.name.localeCompare(right.name) || left.relation.localeCompare(right.relation));
  if (JSON.stringify(triggers.rows) !== JSON.stringify(expectedTriggers)) {
    throw new Error("V06_NEXT_PREFLIGHT_TARGET_TRIGGERS_INVALID");
  }

  const enumNames = Object.keys(TARGET_ENUMS);
  const enums = await client.query<{ type_name: string; labels: string[] }>(`
    SELECT type.typname AS type_name,
           array_agg(enum.enumlabel ORDER BY enum.enumsortorder)::text[] AS labels
      FROM pg_type type JOIN pg_enum enum ON enum.enumtypid = type.oid
     WHERE type.typname = ANY($1::text[])
     GROUP BY type.typname ORDER BY type.typname
  `, [enumNames]);
  const expectedEnums = Object.entries(TARGET_ENUMS)
    .map(([type_name, labels]) => ({ type_name, labels: [...labels] }))
    .sort((left, right) => left.type_name.localeCompare(right.type_name));
  if (JSON.stringify(enums.rows) !== JSON.stringify(expectedEnums)) {
    throw new Error("V06_NEXT_PREFLIGHT_TARGET_ENUMS_INVALID");
  }
}

async function assertWriterSessionsStopped(client: Client): Promise<void> {
  const result = await client.query<{ count: string }>(`
    SELECT count(*)::text AS count FROM pg_stat_activity
     WHERE datname = current_database() AND pid <> pg_backend_pid()
       AND backend_type = 'client backend'
       AND usename IN ('ai_project_os_runtime', 'ai_project_os_entitlement_writer')
  `);
  if (result.rows[0]?.count !== "0") throw new Error("V06_NEXT_PREFLIGHT_WRITER_SESSIONS_PRESENT");
}

export async function runV06NextUpgradePreflight(phase: string, databaseUrl: string): Promise<Record<string, unknown>> {
  if (!ALLOWED_PHASES.has(phase)) throw new Error("V06_NEXT_PREFLIGHT_PHASE_INVALID");
  const postMigration = phase === "post-migration";
  const expected = await expectedMigrations(postMigration);
  const client = new Client({ connectionString: databaseUrl, application_name: "ai-project-os-v06-next-upgrade-preflight" });
  await client.connect();
  try {
    await assertLedger(client, expected);
    await assertTargetCatalog(client, postMigration);
    if (phase === "post-stop") await assertWriterSessionsStopped(client);
  } finally {
    await client.end();
  }
  return {
    ok: true,
    kind: "v06-next-upgrade-preflight",
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
    if (!databaseUrl) throw new Error("V06_NEXT_PREFLIGHT_DATABASE_URL_REQUIRED");
    console.log(JSON.stringify(await runV06NextUpgradePreflight(args[0] ?? "", databaseUrl)));
    return 0;
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: { code: stableCode(error) } }));
    return 1;
  }
}

const direct = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (direct) void main().then((exitCode) => { process.exitCode = exitCode; });
