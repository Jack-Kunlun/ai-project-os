import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { Client } from "pg";
import {
  ACCOUNT_ENTITLEMENT_INVENTORY_APPLICATION_NAME,
  ACCOUNT_ENTITLEMENT_INVENTORY_TABLES,
  AccountEntitlementInventoryError,
  buildAccountEntitlementInventoryFailure,
  buildAccountEntitlementInventoryReport,
  parseAccountEntitlementInventoryArguments,
  readAccountEntitlementInventoryDatabaseUrl,
  safeAccountEntitlementInventoryErrorCode,
  type InventoryQueryClient,
} from "./account-entitlement-inventory-contract";
import { readCliArguments } from "./cli-arguments";

const SQL = Object.freeze({
  begin: "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
  settings: "SET LOCAL search_path = pg_catalog, public; SET LOCAL statement_timeout = '5000ms'",
  rollback: "ROLLBACK",
  txReadOnly: "SELECT current_setting('transaction_read_only') AS transaction_read_only",
  preflight: `
    SELECT r.rolsuper AS is_superuser,
           r.rolcanlogin AS can_login,
           r.rolinherit AS inherits_roles,
           r.rolbypassrls AS bypass_rls,
           r.rolreplication AS can_replicate,
           r.rolcreatedb AS can_create_database,
           r.rolcreaterole AS can_create_role,
           session_user = current_user AS same_session_user,
           d.datdba = r.oid AS owns_database,
           n.nspowner = r.oid AS owns_schema,
           has_database_privilege(current_user, current_database(), 'CREATE') AS can_create_database_object,
           has_schema_privilege(current_user, 'public', 'USAGE') AS can_use_schema,
           has_schema_privilege(current_user, 'public', 'CREATE') AS can_create_schema,
           current_setting('transaction_read_only') AS transaction_read_only,
           EXISTS (SELECT 1 FROM unnest(COALESCE(r.rolconfig, ARRAY[]::text[])) AS config(value)
                    WHERE split_part(config.value, '=', 1) = 'default_transaction_read_only'
                      AND lower(split_part(config.value, '=', 2)) IN ('on','true','1')) AS role_default_read_only,
           EXISTS (SELECT 1 FROM pg_db_role_setting s
                    WHERE s.setdatabase = d.oid AND s.setrole = 0
                      AND EXISTS (SELECT 1 FROM unnest(COALESCE(s.setconfig, ARRAY[]::text[])) AS config(value)
                                   WHERE split_part(config.value, '=', 1) = 'default_transaction_read_only'
                                     AND lower(split_part(config.value, '=', 2)) IN ('on','true','1'))) AS database_default_read_only,
           EXISTS (SELECT 1 FROM pg_db_role_setting s
                    WHERE s.setdatabase = d.oid AND s.setrole = r.oid
                      AND EXISTS (SELECT 1 FROM unnest(COALESCE(s.setconfig, ARRAY[]::text[])) AS config(value)
                                   WHERE split_part(config.value, '=', 1) = 'default_transaction_read_only')) AS database_role_override,
           has_function_privilege(current_user, 'public.account_entitlement_inventory_counts()', 'EXECUTE') AS can_execute_inventory_function,
           EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                    WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f') AND c.relname = ANY($1::text[])
                      AND has_table_privilege(current_user, c.oid, 'SELECT')) AS can_select_target,
           EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                    WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f') AND c.relname = ANY($1::text[])
                      AND (has_table_privilege(current_user,c.oid,'INSERT') OR has_table_privilege(current_user,c.oid,'UPDATE')
                           OR has_table_privilege(current_user,c.oid,'DELETE') OR has_table_privilege(current_user,c.oid,'TRUNCATE')
                           OR has_table_privilege(current_user,c.oid,'REFERENCES') OR has_table_privilege(current_user,c.oid,'TRIGGER'))) AS can_mutate_target,
           EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                    WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f')
                      AND has_table_privilege(current_user,c.oid,'SELECT') AND NOT c.relname = ANY($1::text[])) AS has_unapproved_select,
           EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                    WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f')
                      AND c.relname = ANY($1::text[]) AND c.relowner = r.oid) AS owns_target
      FROM pg_roles r
      JOIN pg_database d ON d.datname = current_database()
      JOIN pg_namespace n ON n.nspname = 'public'
     WHERE r.rolname = current_user
  `,
  counts: `
    SELECT eligible, issued, ambiguous, missing
      FROM public.account_entitlement_inventory_counts()
  `,
});

type PreflightRow = Readonly<{
  is_superuser: boolean;
  can_login: boolean;
  inherits_roles: boolean;
  bypass_rls: boolean;
  can_replicate: boolean;
  can_create_database: boolean;
  can_create_role: boolean;
  same_session_user: boolean;
  owns_database: boolean;
  owns_schema: boolean;
  can_create_database_object: boolean;
  can_use_schema: boolean;
  can_create_schema: boolean;
  transaction_read_only: string;
  role_default_read_only: boolean;
  database_default_read_only: boolean;
  database_role_override: boolean;
  can_execute_inventory_function: boolean;
  can_select_target: boolean;
  can_mutate_target: boolean;
  has_unapproved_select: boolean;
  owns_target: boolean;
}>;

type CountRow = Readonly<{ eligible: string | number; issued: string | number; ambiguous: string | number; missing: string | number }>;

function count(value: string | number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new AccountEntitlementInventoryError("ACCOUNT_ENTITLEMENT_INVENTORY_RESULT_INVALID");
  return parsed;
}

export async function runAccountEntitlementInventory(client: InventoryQueryClient, generatedAt = new Date()) {
  let failure: AccountEntitlementInventoryError | undefined;
  let report: ReturnType<typeof buildAccountEntitlementInventoryReport> | undefined;
  try {
    await client.query(SQL.begin);
    await client.query(SQL.settings);
    const readOnly = await client.query<{ transaction_read_only: string }>(SQL.txReadOnly);
    const preflight = await client.query<PreflightRow>(SQL.preflight, [ACCOUNT_ENTITLEMENT_INVENTORY_TABLES]);
    const row = preflight.rows[0];
    if (row === undefined || !row.can_login || row.is_superuser || row.inherits_roles || row.bypass_rls || row.can_replicate || !row.same_session_user
      || !row.can_use_schema || row.can_create_schema || row.can_create_database_object
      || row.can_create_database || row.can_create_role || row.owns_database || row.owns_schema
      || row.can_create_schema || row.transaction_read_only !== "on" || readOnly.rows[0]?.transaction_read_only !== "on"
      || !row.role_default_read_only || !row.database_default_read_only || row.database_role_override
      || !row.can_execute_inventory_function || row.can_select_target || row.can_mutate_target || row.has_unapproved_select || row.owns_target) {
      throw new AccountEntitlementInventoryError("ACCOUNT_ENTITLEMENT_INVENTORY_PREFLIGHT_FAILED");
    }
    const counts = await client.query<CountRow>(SQL.counts);
    const result = counts.rows[0];
    if (result === undefined) throw new AccountEntitlementInventoryError("ACCOUNT_ENTITLEMENT_INVENTORY_RESULT_INVALID");
    report = buildAccountEntitlementInventoryReport({ eligible: count(result.eligible), issued: count(result.issued), ambiguous: count(result.ambiguous), missing: count(result.missing) }, generatedAt);
  } catch (error) {
    failure = error instanceof AccountEntitlementInventoryError ? error : new AccountEntitlementInventoryError("ACCOUNT_ENTITLEMENT_INVENTORY_QUERY_FAILED");
  } finally {
    try { await client.query(SQL.rollback); } catch { if (failure === undefined) failure = new AccountEntitlementInventoryError("ACCOUNT_ENTITLEMENT_INVENTORY_ROLLBACK_FAILED"); }
  }
  if (failure !== undefined) throw failure;
  if (report === undefined) throw new AccountEntitlementInventoryError("ACCOUNT_ENTITLEMENT_INVENTORY_RESULT_INVALID");
  return report;
}

function printJson(value: unknown): void { console.log(JSON.stringify(value)); }

export async function main(args: readonly string[] = readCliArguments(), env: Readonly<Record<string, string | undefined>> = process.env): Promise<number> {
  try {
    parseAccountEntitlementInventoryArguments(args);
    const client = new Client({ connectionString: readAccountEntitlementInventoryDatabaseUrl(env), application_name: ACCOUNT_ENTITLEMENT_INVENTORY_APPLICATION_NAME });
    try { await client.connect(); } catch { printJson(buildAccountEntitlementInventoryFailure(new AccountEntitlementInventoryError("ACCOUNT_ENTITLEMENT_INVENTORY_CONNECT_FAILED"))); return 1; }
    try {
      printJson(await runAccountEntitlementInventory({ query: async <Row = unknown>(text: string, values?: readonly unknown[]) => ({ rows: (await client.query(text, values === undefined ? undefined : [...values])).rows as readonly Row[] }) }));
      return 0;
    } catch (error) { printJson(buildAccountEntitlementInventoryFailure(error)); return 1; }
    finally { await client.end().catch(() => undefined); }
  } catch (error) { printJson(buildAccountEntitlementInventoryFailure(error)); return 1; }
}

const isDirectExecution = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) void main().then((code) => { process.exitCode = code; }).catch((error) => { printJson({ ok: false, error: { code: safeAccountEntitlementInventoryErrorCode(error) } }); process.exitCode = 1; });
