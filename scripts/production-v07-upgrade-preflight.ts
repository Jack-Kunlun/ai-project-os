import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { readCliArguments } from "./cli-arguments";

const SOURCE_MIGRATION_COUNT = 117;
const TARGET_MIGRATION_COUNT = 133;
const SOURCE_LAST_MIGRATION = "20260924010000_add_personal_knowledge_graph_suggestions";
const TARGET_LAST_MIGRATION = "20260930020000_add_project_git_material_import";
const ALLOWED_PHASES = new Set(["pre-stop", "post-stop", "post-migration"]);
const TARGET_TAG_PATTERN = /^v0\.7\.0(?:-dev\.[1-9][0-9]*)?$/u;
const GIT_AUTOMATION_WORKER = "ai_project_os_git_automation_worker";

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

const TARGET_RELATIONS = [
  "LocalRegistrationBudget",
  "McpExportGrant",
  "McpExportApproval",
  "McpExportDispatchAudit",
  "ProjectMcpActionResultImport",
  "OidcIdentityLinkAttempt",
  "OidcIdentityLinkAudit",
  "WebSourceReviewAudit",
  "WebSourceIdentityFence",
  "ProjectGitRepositoryAutomationGrant",
  "ProjectGitRepositoryAutomationGrantAudit",
  "ProjectGitRepositoryAutomationScheduleCursor",
  "ProjectGitRepositoryAutomationRun",
  "ProjectGitRepositoryAutomationRunAudit",
  "McpExportOAuthAuthorizationRequest",
  "McpExportOAuthCode",
  "McpExportOAuthAccessToken",
  "McpExportOAuthAdmissionBudget",
  "ProjectGitRepositoryPublicationVersion",
  "ProjectGitRepositoryPublicationEntry",
  "ProjectGitRepositoryPublicationHead",
  "ProjectGitRepositoryMaterialCursor",
  "ProjectGitRepositoryMaterialRun",
  "ProjectGitRepositoryMaterialRunAudit",
  "ProjectGitRepositoryMaterialConsentAudit",
  "ProjectGitRepositoryMaterialPublicationVersion",
  "ProjectGitRepositoryMaterialPublicationHead",
  "ProjectGitRepositoryMaterialPublicationEntry",
  "ProjectGitRepositoryMaterialSourceVersion",
] as const;

const TARGET_ENUMS = [
  "LocalRegistrationBudgetScope",
  "McpExportGrantType",
  "McpExportOAuthAdmissionScope",
  "WebSourceAuthenticationMode",
  "WebSourceRevisionReviewStatus",
  "ProjectGitRepositoryAutomationGrantStatus",
  "ProjectGitRepositoryAutomationRunStatus",
  "ProjectGitRepositoryPublicationRunKind",
  "ProjectGitRepositoryMaterialKind",
  "ProjectGitRepositoryMaterialCursorStatus",
  "ProjectGitRepositoryMaterialRunStatus",
  "ProjectGitRepositoryMaterialRunAuditAction",
] as const;

const GIT_AUTOMATION_FUNCTIONS = [
  { signature: 'public."project_git_automation_claim_due"(uuid, character varying)' },
  { signature: 'public."project_git_automation_mutate_lease"(uuid, character varying, uuid, character varying)' },
  { signature: 'public."project_git_automation_reconcile_expired"(uuid)' },
  { signature: 'public."project_git_automation_finalize_result"(uuid, character varying, uuid, character varying, character varying, jsonb)' },
  { signature: 'public."project_git_automation_read_context"(uuid, character varying, uuid)' },
  { signature: 'public."project_git_material_claim_due"(uuid, "ProjectGitRepositoryMaterialKind", character varying)' },
  { signature: 'public."project_git_material_mutate_lease"(uuid, character varying, uuid, character varying)' },
  { signature: 'public."project_git_material_reconcile_expired"(uuid)' },
  { signature: 'public."project_git_material_read_context"(uuid, character varying, uuid)' },
  { signature: 'public."project_git_material_finalize_result"(uuid, character varying, uuid, bigint, character varying, character varying, jsonb)' },
] as const;

function stableCode(error: unknown): string {
  return error instanceof Error && /^V07_UPGRADE_PREFLIGHT_[A-Z0-9_]+$/u.test(error.message)
    ? error.message
    : "V07_UPGRADE_PREFLIGHT_UNEXPECTED_FAILURE";
}

async function expectedMigrations(includeTarget: boolean): Promise<readonly ExpectedMigration[]> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "prisma", "migrations");
  const entries = await readdir(root, { withFileTypes: true });
  const candidates = entries.filter((entry) => entry.isDirectory() && /^\d{14}_/u.test(entry.name));
  const names = candidates.map((entry) => entry.name).sort();
  if (names.some((name) => !/^\d{14}_[a-z0-9_]+$/u.test(name))
    || names.length !== TARGET_MIGRATION_COUNT
    || names[SOURCE_MIGRATION_COUNT - 1] !== SOURCE_LAST_MIGRATION
    || names.at(-1) !== TARGET_LAST_MIGRATION) {
    throw new Error("V07_UPGRADE_PREFLIGHT_RELEASE_MIGRATION_MANIFEST_INVALID");
  }

  const selected = includeTarget ? names : names.slice(0, SOURCE_MIGRATION_COUNT);
  if (selected.length !== (includeTarget ? TARGET_MIGRATION_COUNT : SOURCE_MIGRATION_COUNT)) {
    throw new Error("V07_UPGRADE_PREFLIGHT_RELEASE_MIGRATION_MANIFEST_INVALID");
  }

  try {
    return await Promise.all(selected.map(async (name) => ({
      name,
      checksum: createHash("sha256").update(await readFile(resolve(root, name, "migration.sql"))).digest("hex"),
    })));
  } catch {
    throw new Error("V07_UPGRADE_PREFLIGHT_RELEASE_MIGRATION_MANIFEST_INVALID");
  }
}

async function assertMigrationLedger(client: Client, expected: readonly ExpectedMigration[]): Promise<void> {
  const result = await client.query<MigrationRow>(`
    SELECT "migration_name", "checksum", "finished_at", "rolled_back_at", "applied_steps_count"
      FROM public."_prisma_migrations"
     ORDER BY "migration_name"
  `);
  if (result.rows.length !== expected.length) {
    throw new Error("V07_UPGRADE_PREFLIGHT_DATABASE_MIGRATION_COUNT_INVALID");
  }
  result.rows.forEach((row, index) => {
    const wanted = expected[index];
    if (wanted === undefined || row.migration_name !== wanted.name || row.checksum !== wanted.checksum
      || row.finished_at === null || row.rolled_back_at !== null || !Number.isSafeInteger(Number(row.applied_steps_count))
      || Number(row.applied_steps_count) < 1) {
      throw new Error("V07_UPGRADE_PREFLIGHT_DATABASE_MIGRATION_LEDGER_INVALID");
    }
  });
}

async function assertTargetRelations(client: Client, shouldExist: boolean): Promise<void> {
  const result = await client.query<{ relation_name: string; present: boolean }>(`
    SELECT expected.relation_name,
           relation.oid IS NOT NULL AS present
      FROM unnest($1::text[]) AS expected(relation_name)
      LEFT JOIN pg_class relation
        ON relation.relnamespace = 'public'::regnamespace
       AND relation.relname = expected.relation_name
       AND relation.relkind IN ('r', 'p')
     ORDER BY expected.relation_name
  `, [[...TARGET_RELATIONS]]);
  if (result.rows.some((row) => row.present !== shouldExist)) {
    throw new Error("V07_UPGRADE_PREFLIGHT_TARGET_RELATIONS_INVALID");
  }
}

async function assertTargetEnums(client: Client, shouldExist: boolean): Promise<void> {
  const result = await client.query<{ type_name: string; present: boolean }>(`
    SELECT expected.type_name,
           type_row.oid IS NOT NULL AS present
      FROM unnest($1::text[]) AS expected(type_name)
      LEFT JOIN pg_type type_row
        ON type_row.typnamespace = 'public'::regnamespace
       AND type_row.typname = expected.type_name
       AND type_row.typtype = 'e'
     ORDER BY expected.type_name
  `, [[...TARGET_ENUMS]]);
  if (result.rows.some((row) => row.present !== shouldExist)) {
    throw new Error("V07_UPGRADE_PREFLIGHT_TARGET_TYPES_INVALID");
  }
}

async function assertGitAutomationFunctions(client: Client, shouldExist: boolean): Promise<void> {
  const signatures = GIT_AUTOMATION_FUNCTIONS.map(({ signature }) => signature);
  if (!shouldExist) {
    const result = await client.query<{ present: boolean }>(`
      SELECT to_regprocedure(signature) IS NOT NULL AS present
        FROM unnest($1::text[]) AS expected(signature)
    `, [signatures]);
    if (result.rows.some((row) => row.present)) throw new Error("V07_UPGRADE_PREFLIGHT_TARGET_FUNCTIONS_INVALID");
    return;
  }

  const functions = await client.query<{
    signature: string;
    present: boolean;
    owner: string | null;
    security_definer: boolean | null;
    configuration: string[] | null;
    worker_execute: boolean | null;
    worker_direct_execute: boolean | null;
    runtime_execute: boolean | null;
    writer_execute: boolean | null;
    public_execute: boolean | null;
  }>(`
    SELECT expected.signature,
           function_row.oid IS NOT NULL AS present,
           pg_get_userbyid(function_row.proowner) AS owner,
           function_row.prosecdef AS security_definer,
           function_row.proconfig AS configuration,
           CASE WHEN function_row.oid IS NULL THEN NULL
                ELSE has_function_privilege($2, function_row.oid, 'EXECUTE') END AS worker_execute,
           CASE WHEN function_row.oid IS NULL THEN NULL ELSE EXISTS (
             SELECT 1 FROM aclexplode(COALESCE(function_row.proacl, acldefault('f', function_row.proowner))) privilege
              WHERE privilege.grantee = (SELECT oid FROM pg_roles WHERE rolname = $2)
                AND privilege.privilege_type = 'EXECUTE'
           ) END AS worker_direct_execute,
           CASE WHEN function_row.oid IS NULL THEN NULL
                ELSE has_function_privilege($3, function_row.oid, 'EXECUTE') END AS runtime_execute,
           CASE WHEN function_row.oid IS NULL THEN NULL
                ELSE has_function_privilege($4, function_row.oid, 'EXECUTE') END AS writer_execute,
           CASE WHEN function_row.oid IS NULL THEN NULL ELSE EXISTS (
             SELECT 1 FROM aclexplode(COALESCE(function_row.proacl, acldefault('f', function_row.proowner))) privilege
              WHERE privilege.grantee = 0::oid AND privilege.privilege_type = 'EXECUTE'
           ) END AS public_execute
      FROM unnest($1::text[]) AS expected(signature)
      LEFT JOIN pg_proc function_row ON function_row.oid = to_regprocedure(expected.signature)
     ORDER BY expected.signature
  `, [signatures, GIT_AUTOMATION_WORKER, "ai_project_os_runtime", "ai_project_os_entitlement_writer"]);

  if (functions.rows.length !== GIT_AUTOMATION_FUNCTIONS.length || functions.rows.some((row) => {
    const expected = GIT_AUTOMATION_FUNCTIONS.find(({ signature }) => signature === row.signature);
    return !row.present || expected === undefined || row.owner !== "ai_project_os_migrator"
      || row.security_definer !== true || !row.configuration?.includes("search_path=pg_catalog")
      || row.worker_execute !== true || row.worker_direct_execute !== true
      || row.runtime_execute !== false || row.writer_execute !== false || row.public_execute !== false;
  })) {
    throw new Error("V07_UPGRADE_PREFLIGHT_TARGET_FUNCTIONS_INVALID");
  }
}

async function assertLeastPrivilegeLoginRole(client: Client, roleName: string): Promise<void> {
  const result = await client.query<{
    can_login: boolean;
    is_superuser: boolean;
    can_create_db: boolean;
    can_create_role: boolean;
    can_replicate: boolean;
    bypasses_rls: boolean;
    inherits_privileges: boolean;
  }>(`
    SELECT rolcanlogin AS can_login,
           rolsuper AS is_superuser,
           rolcreatedb AS can_create_db,
           rolcreaterole AS can_create_role,
           rolreplication AS can_replicate,
           rolbypassrls AS bypasses_rls,
           rolinherit AS inherits_privileges
      FROM pg_roles
     WHERE rolname = $1
  `, [roleName]);
  const role = result.rows[0];
  if (role === undefined || !role.can_login || role.is_superuser || role.can_create_db
    || role.can_create_role || role.can_replicate || role.bypasses_rls || role.inherits_privileges) {
    throw new Error("V07_UPGRADE_PREFLIGHT_PRINCIPAL_INVALID");
  }
}

async function assertTargetPrincipals(client: Client): Promise<void> {
  await assertLeastPrivilegeLoginRole(client, "ai_project_os_migrator");
  await assertLeastPrivilegeLoginRole(client, "ai_project_os_runtime");
  await assertLeastPrivilegeLoginRole(client, "ai_project_os_entitlement_writer");
  await assertLeastPrivilegeLoginRole(client, GIT_AUTOMATION_WORKER);
}

async function assertWriterSessionsStopped(client: Client): Promise<void> {
  const result = await client.query<{ count: string }>(`
    SELECT count(*)::text AS count
      FROM pg_stat_activity
     WHERE datname = current_database()
       AND pid <> pg_backend_pid()
       AND backend_type = 'client backend'
       AND usename = ANY($1::text[])
  `, [["ai_project_os_runtime", "ai_project_os_entitlement_writer", GIT_AUTOMATION_WORKER]]);
  if (result.rows[0]?.count !== "0") {
    throw new Error("V07_UPGRADE_PREFLIGHT_WRITER_SESSIONS_PRESENT");
  }
}

export async function runV07UpgradePreflight(
  phase: string,
  targetTag: string,
  databaseUrl: string,
): Promise<Record<string, unknown>> {
  if (!ALLOWED_PHASES.has(phase)) throw new Error("V07_UPGRADE_PREFLIGHT_PHASE_INVALID");
  if (!TARGET_TAG_PATTERN.test(targetTag)) throw new Error("V07_UPGRADE_PREFLIGHT_TARGET_TAG_INVALID");
  if (databaseUrl.length === 0) throw new Error("V07_UPGRADE_PREFLIGHT_DATABASE_URL_REQUIRED");

  const postMigration = phase === "post-migration";
  const expected = await expectedMigrations(postMigration);
  const client = new Client({
    connectionString: databaseUrl,
    application_name: "ai-project-os-v07-upgrade-preflight",
    connectionTimeoutMillis: 5_000,
    options: "-c default_transaction_read_only=on -c statement_timeout=10000",
  });
  await client.connect();
  try {
    const readOnly = await client.query<{ transaction_read_only: string }>("SHOW transaction_read_only");
    if (readOnly.rows[0]?.transaction_read_only !== "on") {
      throw new Error("V07_UPGRADE_PREFLIGHT_READ_ONLY_CONNECTION_REQUIRED");
    }
    await assertMigrationLedger(client, expected);
    await assertTargetRelations(client, postMigration);
    await assertTargetEnums(client, postMigration);
    await assertGitAutomationFunctions(client, postMigration);
    if (postMigration) await assertTargetPrincipals(client);
    if (phase === "post-stop") await assertWriterSessionsStopped(client);
  } finally {
    await client.end();
  }

  return {
    ok: true,
    kind: "v07-upgrade-preflight",
    phase,
    targetTag,
    migrationCount: expected.length,
    writerSessions: phase === "post-stop" ? "stopped" : "not-checked",
  };
}

export async function main(
  args: readonly string[] = readCliArguments(),
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<number> {
  try {
    if (args.length !== 2) throw new Error("V07_UPGRADE_PREFLIGHT_ARGUMENTS_INVALID");
    const databaseUrl = env.PRODUCTION_UPGRADE_PREFLIGHT_DATABASE_URL;
    if (!databaseUrl) throw new Error("V07_UPGRADE_PREFLIGHT_DATABASE_URL_REQUIRED");
    console.log(JSON.stringify(await runV07UpgradePreflight(args[0] ?? "", args[1] ?? "", databaseUrl)));
    return 0;
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: { code: stableCode(error) } }));
    return 1;
  }
}

const direct = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (direct) void main().then((exitCode) => { process.exitCode = exitCode; });
