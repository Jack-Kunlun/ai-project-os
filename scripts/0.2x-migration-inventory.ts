import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { Client } from "pg";
import {
  buildOwnershipInventoryFailure,
  buildOwnershipInventoryReport,
  CLEAN_SLATE_REMOVED_PROVIDER_COLUMNS,
  CLEAN_SLATE_REMOVED_RELATIONS,
  CLEAN_SLATE_REMOVED_TRIGGERS,
  INVENTORY_TABLES,
  REQUIRED_CONSTRAINTS,
  REQUIRED_ENUMS,
  REQUIRED_MIGRATIONS,
  OwnershipInventoryError,
  parseOwnershipInventoryArguments,
  readOwnershipInventoryDatabaseConfig,
  safeOwnershipInventoryErrorCode,
  type CountValue,
  type CleanSlateAccountAggregateRow,
  type CleanSlateLegacyArtifactRow,
  type CleanSlateProviderAggregateRow,
  type OwnershipInventoryReport,
  type OwnershipInventoryRows,
} from "./0.2x-migration-inventory-contract";
import { readCliArguments } from "./cli-arguments";

export interface InventoryQueryClient {
  query<Row = unknown>(text: string, values?: readonly unknown[]): Promise<{ rows: readonly Row[] }>;
}

interface MigrationPreflightRow {
  migration_name: string;
  applied: boolean;
  applied_migration_count: CountValue;
}

interface ConstraintPreflightRow {
  constraint_name: string;
  relation_name: string;
  constraint_type: string;
  validated: boolean;
}

interface EnumPreflightRow {
  enum_name: string;
  enum_value: string;
}

interface RlsPreflightRow {
  relation_name: string;
  row_security: boolean;
  force_row_security: boolean;
}

interface RolePreflightRow {
  role_name: string;
  is_superuser: boolean;
  bypass_rls: boolean;
  can_replicate: boolean;
  owns_database: boolean;
  owns_schema: boolean;
  owns_target_table: boolean;
  can_create_database: boolean;
  can_create_database_role: boolean;
  can_create_role: boolean;
  can_create_schema: boolean;
  can_create_temporary: boolean;
  role_default_transaction_read_only: boolean;
  database_default_transaction_read_only: boolean;
  has_database_role_read_only_override: boolean;
  default_transaction_read_only: string;
  can_select_target: boolean;
  has_unapproved_select: boolean;
  can_insert_target: boolean;
  can_update_target: boolean;
  can_delete_target: boolean;
  can_truncate_target: boolean;
  can_references_target: boolean;
  can_trigger_target: boolean;
}

const SQL = Object.freeze({
  begin: "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
  searchPath: "SET LOCAL search_path = pg_catalog, public",
  rollback: "ROLLBACK",
  transactionReadOnly: "SELECT current_setting('transaction_read_only') AS transaction_read_only",
  migrations: `
    SELECT expected."migration_name" AS migration_name,
           EXISTS (
             SELECT 1 FROM "_prisma_migrations" AS migration
              WHERE migration."migration_name" = expected."migration_name"
                AND migration."finished_at" IS NOT NULL
                AND migration."rolled_back_at" IS NULL
           ) AS applied,
           (SELECT COUNT(*)::bigint FROM "_prisma_migrations" AS applied_migration
             WHERE applied_migration."finished_at" IS NOT NULL
               AND applied_migration."rolled_back_at" IS NULL) AS applied_migration_count
      FROM unnest($1::text[]) WITH ORDINALITY AS expected("migration_name", ordinal)
     ORDER BY expected.ordinal
  `,
  constraints: `
    SELECT constraint_meta.conname AS constraint_name,
           relation_meta.relname AS relation_name,
           constraint_meta.contype::text AS constraint_type,
           constraint_meta.convalidated AS validated
      FROM pg_constraint AS constraint_meta
      JOIN pg_class AS relation_meta ON relation_meta.oid = constraint_meta.conrelid
      JOIN pg_namespace AS namespace_meta ON namespace_meta.oid = relation_meta.relnamespace
     WHERE namespace_meta.nspname = 'public'
       AND constraint_meta.conname = ANY($1::text[])
       AND relation_meta.relname = ANY($2::text[])
       AND constraint_meta.contype = 'c'
     ORDER BY array_position($1::text[], constraint_meta.conname)
  `,
  enums: `
    SELECT type_meta.typname AS enum_name, enum_meta.enumlabel AS enum_value
      FROM pg_type AS type_meta
      JOIN pg_enum AS enum_meta ON enum_meta.enumtypid = type_meta.oid
      JOIN pg_namespace AS namespace_meta ON namespace_meta.oid = type_meta.typnamespace
     WHERE namespace_meta.nspname = 'public'
       AND type_meta.typname = ANY($1::text[])
     ORDER BY array_position($1::text[], type_meta.typname), enum_meta.enumsortorder
  `,
  rls: `
    SELECT relation_meta.relname AS relation_name,
           relation_meta.relrowsecurity AS row_security,
           relation_meta.relforcerowsecurity AS force_row_security
      FROM pg_class AS relation_meta
      JOIN pg_namespace AS namespace_meta ON namespace_meta.oid = relation_meta.relnamespace
     WHERE namespace_meta.nspname = 'public'
       AND relation_meta.relkind IN ('r', 'p')
       AND relation_meta.relname = ANY($1::text[])
     ORDER BY array_position($1::text[], relation_meta.relname)
  `,
  role: `
    SELECT role_meta.rolname AS role_name,
           role_meta.rolsuper AS is_superuser,
           role_meta.rolbypassrls AS bypass_rls,
           role_meta.rolreplication AS can_replicate,
           database_meta.datdba = role_meta.oid AS owns_database,
           namespace_meta.nspowner = role_meta.oid AS owns_schema,
           EXISTS (
             SELECT 1 FROM pg_class AS target_meta
              WHERE target_meta.relnamespace = namespace_meta.oid
                AND target_meta.relkind IN ('r', 'p')
                AND target_meta.relname = ANY($1::text[])
                AND target_meta.relowner = role_meta.oid
           ) AS owns_target_table,
           has_database_privilege(current_user, current_database(), 'CREATE') AS can_create_database,
           role_meta.rolcreatedb AS can_create_database_role,
           role_meta.rolcreaterole AS can_create_role,
           has_schema_privilege(current_user, 'public', 'CREATE') AS can_create_schema,
           has_database_privilege(current_user, current_database(), 'TEMPORARY') AS can_create_temporary,
           EXISTS (
             SELECT 1 FROM unnest(COALESCE(role_meta.rolconfig, ARRAY[]::text[])) AS role_setting(setting)
              WHERE split_part(role_setting.setting, '=', 1) = 'default_transaction_read_only'
                AND lower(split_part(role_setting.setting, '=', 2)) IN ('on', 'true', '1')
           ) AS role_default_transaction_read_only,
           EXISTS (
             SELECT 1 FROM pg_db_role_setting AS database_setting
              WHERE database_setting.setdatabase = database_meta.oid
                AND database_setting.setrole = 0
                AND EXISTS (
                  SELECT 1 FROM unnest(COALESCE(database_setting.setconfig, ARRAY[]::text[])) AS setting(value)
                   WHERE split_part(setting.value, '=', 1) = 'default_transaction_read_only'
                     AND lower(split_part(setting.value, '=', 2)) IN ('on', 'true', '1')
                )
           ) AS database_default_transaction_read_only,
           EXISTS (
             SELECT 1 FROM pg_db_role_setting AS database_role_setting
              WHERE database_role_setting.setdatabase = database_meta.oid
                AND database_role_setting.setrole = role_meta.oid
                AND EXISTS (
                  SELECT 1 FROM unnest(COALESCE(database_role_setting.setconfig, ARRAY[]::text[])) AS override_setting(setting)
                   WHERE split_part(override_setting.setting, '=', 1) = 'default_transaction_read_only'
                )
           ) AS has_database_role_read_only_override,
           current_setting('transaction_read_only') AS default_transaction_read_only,
           NOT EXISTS (SELECT 1 FROM unnest($1::text[]) AS expected_table(table_name)
                        WHERE NOT EXISTS (
                          SELECT 1 FROM pg_class AS target_meta
                           WHERE target_meta.relnamespace = namespace_meta.oid
                             AND target_meta.relkind IN ('r', 'p')
                             AND target_meta.relname = expected_table.table_name
                             AND has_table_privilege(current_user, target_meta.oid, 'SELECT')
                        )) AS can_select_target,
           EXISTS (SELECT 1 FROM pg_class AS visible_table
                    WHERE visible_table.relnamespace = namespace_meta.oid
                      AND visible_table.relkind IN ('r', 'p')
                      AND has_table_privilege(current_user, visible_table.oid, 'SELECT')
                      AND NOT (visible_table.relname = ANY($1::text[]))) AS has_unapproved_select,
           EXISTS (SELECT 1 FROM pg_class AS target_meta
                    WHERE target_meta.relnamespace = namespace_meta.oid
                      AND target_meta.relkind IN ('r', 'p')
                      AND target_meta.relname = ANY($1::text[])
                      AND has_table_privilege(current_user, target_meta.oid, 'INSERT')) AS can_insert_target,
           EXISTS (SELECT 1 FROM pg_class AS target_meta
                    WHERE target_meta.relnamespace = namespace_meta.oid
                      AND target_meta.relkind IN ('r', 'p')
                      AND target_meta.relname = ANY($1::text[])
                      AND has_table_privilege(current_user, target_meta.oid, 'UPDATE')) AS can_update_target,
           EXISTS (SELECT 1 FROM pg_class AS target_meta
                    WHERE target_meta.relnamespace = namespace_meta.oid
                      AND target_meta.relkind IN ('r', 'p')
                      AND target_meta.relname = ANY($1::text[])
                      AND has_table_privilege(current_user, target_meta.oid, 'DELETE')) AS can_delete_target,
           EXISTS (SELECT 1 FROM pg_class AS target_meta
                    WHERE target_meta.relnamespace = namespace_meta.oid
                      AND target_meta.relkind IN ('r', 'p')
                      AND target_meta.relname = ANY($1::text[])
                      AND has_table_privilege(current_user, target_meta.oid, 'TRUNCATE')) AS can_truncate_target,
           EXISTS (SELECT 1 FROM pg_class AS target_meta
                    WHERE target_meta.relnamespace = namespace_meta.oid
                      AND target_meta.relkind IN ('r', 'p')
                      AND target_meta.relname = ANY($1::text[])
                      AND has_table_privilege(current_user, target_meta.oid, 'REFERENCES')) AS can_references_target,
           EXISTS (SELECT 1 FROM pg_class AS target_meta
                    WHERE target_meta.relnamespace = namespace_meta.oid
                      AND target_meta.relkind IN ('r', 'p')
                      AND target_meta.relname = ANY($1::text[])
                      AND has_table_privilege(current_user, target_meta.oid, 'TRIGGER')) AS can_trigger_target
      FROM pg_roles AS role_meta
      JOIN pg_database AS database_meta ON database_meta.datname = current_database()
      JOIN pg_namespace AS namespace_meta ON namespace_meta.nspname = 'public'
     WHERE role_meta.rolname = current_user
  `,
  legacyArtifacts: `
    SELECT
      (SELECT COUNT(*)::bigint FROM pg_class AS relation_meta
        JOIN pg_namespace AS namespace_meta ON namespace_meta.oid = relation_meta.relnamespace
       WHERE namespace_meta.nspname = 'public'
         AND relation_meta.relname = ANY($1::text[])
         AND relation_meta.relkind IN ('r', 'p', 'v', 'm', 'f')) AS removed_relations,
      (SELECT COUNT(*)::bigint FROM pg_attribute AS attribute_meta
        JOIN pg_class AS relation_meta ON relation_meta.oid = attribute_meta.attrelid
        JOIN pg_namespace AS namespace_meta ON namespace_meta.oid = relation_meta.relnamespace
       WHERE namespace_meta.nspname = 'public'
         AND relation_meta.relname = 'AiProviderConnection'
         AND attribute_meta.attname = ANY($2::text[])
         AND attribute_meta.attnum > 0
         AND NOT attribute_meta.attisdropped) AS removed_provider_columns,
      (SELECT COUNT(*)::bigint FROM pg_trigger AS trigger_meta
        JOIN pg_class AS relation_meta ON relation_meta.oid = trigger_meta.tgrelid
        JOIN pg_namespace AS namespace_meta ON namespace_meta.oid = relation_meta.relnamespace
       WHERE namespace_meta.nspname = 'public'
         AND trigger_meta.tgname = ANY($3::text[])
         AND NOT trigger_meta.tgisinternal) AS removed_triggers
  `,
  accounts: `
    SELECT COUNT(*)::bigint AS total,
           COUNT(*) FILTER (WHERE "role" = 'admin')::bigint AS admin,
           COUNT(*) FILTER (WHERE "role" = 'user')::bigint AS "user",
           COUNT(*) FILTER (WHERE "role" NOT IN ('admin', 'user'))::bigint AS invalid,
           COUNT(*) FILTER (WHERE "disabledAt" IS NULL)::bigint AS enabled,
           COUNT(*) FILTER (WHERE "disabledAt" IS NOT NULL)::bigint AS disabled
      FROM "AppUser"
  `,
  aiProvider: `
    SELECT COUNT(*)::bigint AS total,
           COUNT(*) FILTER (WHERE "scope" = 'platform')::bigint AS platform,
           COUNT(*) FILTER (WHERE "scope" = 'user')::bigint AS "user",
           COUNT(*) FILTER (WHERE "scope" NOT IN ('platform', 'user'))::bigint AS invalid,
           COUNT(*) FILTER (WHERE "scope" = 'platform' AND "ownerUserId" IS NOT NULL)::bigint AS platform_with_owner,
           COUNT(*) FILTER (WHERE "scope" = 'user' AND "ownerUserId" IS NULL)::bigint AS user_without_owner,
           COUNT(*) FILTER (WHERE "status" = 'configured')::bigint AS configured,
           COUNT(*) FILTER (WHERE "status" = 'verified')::bigint AS verified,
           COUNT(*) FILTER (WHERE "status" = 'error')::bigint AS error,
           COUNT(*) FILTER (WHERE "status" = 'disabled')::bigint AS disabled
      FROM "AiProviderConnection"
  `,
});

export const INVENTORY_SQL = SQL;

async function queryRows<Row>(client: InventoryQueryClient, text: string, values: readonly unknown[] = []): Promise<readonly Row[]> {
  try {
    return (await client.query<Row>(text, values)).rows;
  } catch {
    throw new OwnershipInventoryError("OWNERSHIP_INVENTORY_QUERY_FAILED");
  }
}

function requireSingleRow<Row>(rows: readonly Row[]): Row {
  if (rows.length !== 1 || rows[0] === undefined) throw new OwnershipInventoryError("OWNERSHIP_INVENTORY_RESULT_INVALID");
  return rows[0];
}

function sameCount(left: CountValue, right: CountValue): boolean {
  return String(left) === String(right);
}

async function validateReadOnlyTransaction(client: InventoryQueryClient): Promise<void> {
  const row = requireSingleRow(await queryRows<{ transaction_read_only: string }>(client, SQL.transactionReadOnly));
  if (row.transaction_read_only !== "on") throw new OwnershipInventoryError("OWNERSHIP_INVENTORY_PREFLIGHT_FAILED");
}

function assertFalse(value: boolean, code = "OWNERSHIP_INVENTORY_PREFLIGHT_FAILED"): void {
  if (value !== false) throw new OwnershipInventoryError(code as "OWNERSHIP_INVENTORY_PREFLIGHT_FAILED");
}

export async function validateOwnershipInventoryPreflight(client: InventoryQueryClient): Promise<CountValue> {
  try {
    const migrationRows = await queryRows<MigrationPreflightRow>(client, SQL.migrations, [REQUIRED_MIGRATIONS]);
    if (
      migrationRows.length !== REQUIRED_MIGRATIONS.length
      || migrationRows.some((row, index) => row.migration_name !== REQUIRED_MIGRATIONS[index] || row.applied !== true)
    ) throw new OwnershipInventoryError("OWNERSHIP_INVENTORY_PREFLIGHT_FAILED");
    const appliedMigrationCount = migrationRows[0]?.applied_migration_count;
    if (appliedMigrationCount === undefined || migrationRows.some((row) => !sameCount(row.applied_migration_count, appliedMigrationCount))) {
      throw new OwnershipInventoryError("OWNERSHIP_INVENTORY_RESULT_INVALID");
    }

    const constraintRows = await queryRows<ConstraintPreflightRow>(client, SQL.constraints, [
      REQUIRED_CONSTRAINTS.map((constraint) => constraint.name),
      REQUIRED_CONSTRAINTS.map((constraint) => constraint.table),
    ]);
    if (
      constraintRows.length !== REQUIRED_CONSTRAINTS.length
      || REQUIRED_CONSTRAINTS.some((expected) => {
        const matches = constraintRows.filter((row) => row.constraint_name === expected.name && row.relation_name === expected.table);
        return matches.length !== 1 || matches[0]!.constraint_type !== "c" || matches[0]!.validated !== true;
      })
    ) throw new OwnershipInventoryError("OWNERSHIP_INVENTORY_PREFLIGHT_FAILED");

    const enumNames = Object.keys(REQUIRED_ENUMS) as Array<keyof typeof REQUIRED_ENUMS>;
    const enumRows = await queryRows<EnumPreflightRow>(client, SQL.enums, [enumNames]);
    for (const enumName of enumNames) {
      const actualValues = enumRows.filter((row) => row.enum_name === enumName).map((row) => row.enum_value);
      if (JSON.stringify(actualValues) !== JSON.stringify(REQUIRED_ENUMS[enumName])) throw new OwnershipInventoryError("OWNERSHIP_INVENTORY_PREFLIGHT_FAILED");
    }

    const rlsRows = await queryRows<RlsPreflightRow>(client, SQL.rls, [INVENTORY_TABLES]);
    if (
      rlsRows.length !== INVENTORY_TABLES.length
      || INVENTORY_TABLES.some((table) => {
        const matches = rlsRows.filter((row) => row.relation_name === table);
        return matches.length !== 1 || matches[0]!.row_security !== false || matches[0]!.force_row_security !== false;
      })
    ) throw new OwnershipInventoryError("OWNERSHIP_INVENTORY_PREFLIGHT_FAILED");

    const role = requireSingleRow(await queryRows<RolePreflightRow>(client, SQL.role, [INVENTORY_TABLES]));
    assertFalse(role.is_superuser);
    assertFalse(role.bypass_rls);
    assertFalse(role.can_replicate);
    assertFalse(role.owns_database);
    assertFalse(role.owns_schema);
    assertFalse(role.owns_target_table);
    assertFalse(role.can_create_database);
    assertFalse(role.can_create_database_role);
    assertFalse(role.can_create_role);
    assertFalse(role.can_create_schema);
    assertFalse(role.can_create_temporary);
    if (
      role.role_default_transaction_read_only !== true
      || typeof role.database_default_transaction_read_only !== "boolean"
      || role.has_database_role_read_only_override !== false
      || role.default_transaction_read_only !== "on"
      || role.can_select_target !== true
      || role.has_unapproved_select !== false
      || role.can_insert_target !== false
      || role.can_update_target !== false
      || role.can_delete_target !== false
      || role.can_truncate_target !== false
      || role.can_references_target !== false
      || role.can_trigger_target !== false
    ) throw new OwnershipInventoryError("OWNERSHIP_INVENTORY_PREFLIGHT_FAILED");

    const legacy = requireSingleRow(await queryRows<CleanSlateLegacyArtifactRow>(client, SQL.legacyArtifacts, [
      CLEAN_SLATE_REMOVED_RELATIONS,
      CLEAN_SLATE_REMOVED_PROVIDER_COLUMNS,
      CLEAN_SLATE_REMOVED_TRIGGERS,
    ]));
    if (String(legacy.removed_relations) !== "0" || String(legacy.removed_provider_columns) !== "0" || String(legacy.removed_triggers) !== "0") {
      throw new OwnershipInventoryError("OWNERSHIP_INVENTORY_PREFLIGHT_FAILED");
    }
    return appliedMigrationCount;
  } catch (error) {
    if (error instanceof OwnershipInventoryError && (error.code === "OWNERSHIP_INVENTORY_QUERY_FAILED" || error.code === "OWNERSHIP_INVENTORY_RESULT_INVALID")) throw error;
    throw new OwnershipInventoryError("OWNERSHIP_INVENTORY_PREFLIGHT_FAILED");
  }
}

async function readAggregateRow<Row>(client: InventoryQueryClient, query: string, values: readonly unknown[] = []): Promise<Row> {
  return requireSingleRow(await queryRows<Row>(client, query, values));
}

async function readInventoryRows(client: InventoryQueryClient, appliedMigrationCount: CountValue): Promise<OwnershipInventoryRows> {
  return {
    appliedMigrationCount,
    accounts: await readAggregateRow<CleanSlateAccountAggregateRow>(client, SQL.accounts),
    aiProvider: await readAggregateRow<CleanSlateProviderAggregateRow>(client, SQL.aiProvider),
    legacyArtifacts: await readAggregateRow<CleanSlateLegacyArtifactRow>(client, SQL.legacyArtifacts, [
      CLEAN_SLATE_REMOVED_RELATIONS,
      CLEAN_SLATE_REMOVED_PROVIDER_COLUMNS,
      CLEAN_SLATE_REMOVED_TRIGGERS,
    ]),
  };
}

export async function runOwnershipInventory(
  client: InventoryQueryClient,
  generatedAt: Date = new Date(),
): Promise<OwnershipInventoryReport> {
  let failure: OwnershipInventoryError | undefined;
  let report: OwnershipInventoryReport | undefined;
  try {
    try {
      await client.query(SQL.begin);
      await client.query(SQL.searchPath);
    } catch {
      throw new OwnershipInventoryError("OWNERSHIP_INVENTORY_QUERY_FAILED");
    }
    await validateReadOnlyTransaction(client);
    const appliedMigrationCount = await validateOwnershipInventoryPreflight(client);
    report = buildOwnershipInventoryReport(await readInventoryRows(client, appliedMigrationCount), generatedAt);
  } catch (error) {
    failure = error instanceof OwnershipInventoryError ? error : new OwnershipInventoryError("OWNERSHIP_INVENTORY_FAILED");
  } finally {
    try {
      await client.query(SQL.rollback);
    } catch {
      if (failure === undefined) failure = new OwnershipInventoryError("OWNERSHIP_INVENTORY_ROLLBACK_FAILED");
    }
  }
  if (failure !== undefined) throw failure;
  if (report === undefined) throw new OwnershipInventoryError("OWNERSHIP_INVENTORY_RESULT_INVALID");
  return report;
}

function asInventoryQueryClient(client: Client): InventoryQueryClient {
  return {
    query: async <Row = unknown>(text: string, values?: readonly unknown[]) => {
      const result = await client.query(text, values === undefined ? undefined : [...values]);
      return { rows: result.rows as readonly Row[] };
    },
  };
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value));
}

function validatePgDriverEnvironment(env: Readonly<Record<string, string | undefined>>): void {
  if ([env.PGBINARY, process.env.PGBINARY].some((value) => typeof value === "string" && value !== "")) {
    throw new OwnershipInventoryError("OWNERSHIP_INVENTORY_DATABASE_URL_INVALID");
  }
}

export async function main(
  args: readonly string[] = readCliArguments(),
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<number> {
  try {
    parseOwnershipInventoryArguments(args);
    const clientConfig = readOwnershipInventoryDatabaseConfig(env);
    validatePgDriverEnvironment(env);
    const client = new Client(clientConfig);
    try {
      await client.connect();
    } catch {
      printJson(buildOwnershipInventoryFailure(new OwnershipInventoryError("OWNERSHIP_INVENTORY_DATABASE_CONNECT_FAILED")));
      return 1;
    }
    try {
      printJson(await runOwnershipInventory(asInventoryQueryClient(client)));
      return 0;
    } catch (error) {
      printJson(buildOwnershipInventoryFailure(error));
      return 1;
    } finally {
      try {
        await client.end();
      } catch {
        // The report is already redacted and independent from close details.
      }
    }
  } catch (error) {
    printJson(buildOwnershipInventoryFailure(error));
    return 1;
  }
}

const isDirectExecution = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  void main().then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error) => {
    printJson({ ok: false, error: { code: safeOwnershipInventoryErrorCode(error) } });
    process.exitCode = 1;
  });
}

export type InventoryCountValue = CountValue;
