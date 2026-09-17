import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { Client } from "pg";
import { readCliArguments } from "./cli-arguments";
import {
  buildProductionUpgradePreflightFailure,
  buildProductionUpgradePreflightReport,
  CLEAN_SLATE_DATA_GATES,
  LEGACY_MIGRATION_MANIFEST,
  ProductionUpgradePreflightError,
  parseProductionUpgradePreflightArguments,
  readProductionUpgradePreflightDatabaseConfig,
  REQUIRED_LEGACY_SCHEMA,
  safeProductionUpgradePreflightErrorCode,
  type ProductionUpgradePreflightPhase,
  type ProductionUpgradePreflightReport,
} from "./production-upgrade-preflight-contract";

export interface ProductionUpgradePreflightQueryClient {
  query<Row = unknown>(text: string, values?: readonly unknown[]): Promise<{ rows: readonly Row[] }>;
}

interface MigrationLedgerRow {
  migration_name: string;
  checksum: string;
  finished?: boolean;
  rolled_back?: boolean;
  applied_steps_count?: number | string | bigint;
  finished_at?: unknown;
  rolled_back_at?: unknown;
}

interface SchemaRelationRow {
  relation_name: string;
  present: boolean;
}

interface SchemaColumnRow {
  relation_name: string;
  column_name: string;
  present: boolean;
}

interface DataGateRow {
  app_user_member: boolean;
  workspace_provider_or_workspace_id: boolean;
  project_ai_route: boolean;
  project_ai_route_revision: boolean;
  ai_provider_ownership_audit?: boolean;
}

interface OptionalRelationRow {
  relation_name: string;
  present: boolean;
}

interface AuditDataGateRow {
  ai_provider_ownership_audit: boolean;
}

interface ClientBackendRow {
  other_client_backend: boolean;
}

interface TransactionSettingsRow {
  transaction_read_only: string;
  transaction_isolation: string;
  lock_timeout: string;
  statement_timeout: string;
}

export const PRODUCTION_UPGRADE_PREFLIGHT_SQL = Object.freeze({
  begin: "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
  searchPath: "SET LOCAL search_path = pg_catalog, public",
  lockTimeout: "SET LOCAL lock_timeout = '5s'",
  statementTimeout: "SET LOCAL statement_timeout = '30s'",
  transactionSettings: `
    SELECT current_setting('transaction_read_only') AS transaction_read_only,
           current_setting('transaction_isolation') AS transaction_isolation,
           current_setting('lock_timeout') AS lock_timeout,
           current_setting('statement_timeout') AS statement_timeout
  `,
  migrationLedger: `
    SELECT migration."migration_name" AS migration_name,
           migration."checksum" AS checksum,
           migration."finished_at" IS NOT NULL AS finished,
           migration."rolled_back_at" IS NOT NULL AS rolled_back,
           migration."applied_steps_count" AS applied_steps_count
      FROM "public"."_prisma_migrations" AS migration
     ORDER BY migration."migration_name"
  `,
  schemaRelations: `
    SELECT expected.relation_name,
           EXISTS (
             SELECT 1
               FROM pg_catalog.pg_class AS relation_meta
               JOIN pg_catalog.pg_namespace AS namespace_meta
                 ON namespace_meta.oid = relation_meta.relnamespace
              WHERE namespace_meta.nspname = 'public'
                AND relation_meta.relname = expected.relation_name
                AND relation_meta.relkind IN ('r', 'p')
           ) AS present
      FROM unnest($1::text[]) WITH ORDINALITY AS expected(relation_name, ordinal)
     ORDER BY expected.ordinal
  `,
  schemaColumns: `
    SELECT expected.relation_name,
           expected.column_name,
           EXISTS (
             SELECT 1
               FROM pg_catalog.pg_attribute AS attribute_meta
               JOIN pg_catalog.pg_class AS relation_meta
                 ON relation_meta.oid = attribute_meta.attrelid
               JOIN pg_catalog.pg_namespace AS namespace_meta
                 ON namespace_meta.oid = relation_meta.relnamespace
              WHERE namespace_meta.nspname = 'public'
                AND relation_meta.relname = expected.relation_name
                AND relation_meta.relkind IN ('r', 'p')
                AND attribute_meta.attname = expected.column_name
                AND attribute_meta.attnum > 0
                AND NOT attribute_meta.attisdropped
           ) AS present
      FROM unnest($1::text[], $2::text[]) WITH ORDINALITY AS expected(relation_name, column_name, ordinal)
     ORDER BY expected.ordinal
  `,
  optionalRelations: `
    SELECT 'AiProviderOwnershipAudit' AS relation_name,
           EXISTS (
             SELECT 1
               FROM pg_catalog.pg_class AS relation_meta
               JOIN pg_catalog.pg_namespace AS namespace_meta
                 ON namespace_meta.oid = relation_meta.relnamespace
              WHERE namespace_meta.nspname = 'public'
                AND relation_meta.relname = 'AiProviderOwnershipAudit'
                AND relation_meta.relkind IN ('r', 'p')
           ) AS present
  `,
  dataGates: `
    SELECT EXISTS (
             SELECT 1 FROM "public"."AppUser" AS app_user
              WHERE app_user."role"::text = 'member'
           ) AS app_user_member,
           EXISTS (
             SELECT 1 FROM "public"."AiProviderConnection" AS provider
             WHERE pg_catalog.to_jsonb(provider) ->> 'scope' = 'workspace'
                 OR (pg_catalog.to_jsonb(provider) ? 'workspaceId' AND pg_catalog.to_jsonb(provider) ->> 'workspaceId' IS NOT NULL)
           ) AS workspace_provider_or_workspace_id,
           EXISTS (
             SELECT 1
               FROM pg_catalog.pg_class AS relation_meta
               JOIN pg_catalog.pg_namespace AS namespace_meta
                 ON namespace_meta.oid = relation_meta.relnamespace
              WHERE namespace_meta.nspname = 'public'
                AND relation_meta.relname = 'ProjectAiRoute'
                AND relation_meta.relkind IN ('r', 'p')
           ) AS project_ai_route,
           EXISTS (
             SELECT 1
               FROM pg_catalog.pg_class AS relation_meta
               JOIN pg_catalog.pg_namespace AS namespace_meta
                 ON namespace_meta.oid = relation_meta.relnamespace
              WHERE namespace_meta.nspname = 'public'
                AND relation_meta.relname = 'ProjectAiRouteRevision'
                AND relation_meta.relkind IN ('r', 'p')
           ) AS project_ai_route_revision,
           false AS ai_provider_ownership_audit
  `,
  auditDataGate: `
    SELECT EXISTS (SELECT 1 FROM "public"."AiProviderOwnershipAudit") AS ai_provider_ownership_audit
  `,
  otherClientBackends: `
    SELECT EXISTS (
             SELECT 1
              FROM pg_catalog.pg_stat_activity AS activity
              WHERE activity.backend_type = 'client backend'
                AND activity.datname = pg_catalog.current_database()
                AND activity.pid <> pg_catalog.pg_backend_pid()
           ) AS other_client_backend
  `,
  rollback: "ROLLBACK",
});

export async function queryProductionUpgradePreflightRows<Row>(
  client: ProductionUpgradePreflightQueryClient,
  query: string,
  values: readonly unknown[] = [],
): Promise<readonly Row[]> {
  try {
    return (await client.query<Row>(query, values)).rows;
  } catch {
    throw new ProductionUpgradePreflightError("PRODUCTION_UPGRADE_PREFLIGHT_QUERY_FAILED");
  }
}

function requireSingleRow<Row>(rows: readonly Row[]): Row {
  if (rows.length !== 1 || rows[0] === undefined) {
    throw new ProductionUpgradePreflightError("PRODUCTION_UPGRADE_PREFLIGHT_RESULT_INVALID");
  }
  return rows[0];
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function validateTransactionSettings(row: TransactionSettingsRow): void {
  if (
    row.transaction_read_only !== "on"
    || row.transaction_isolation !== "repeatable read"
    || row.lock_timeout !== "5s"
    || row.statement_timeout !== "30s"
  ) {
    throw new ProductionUpgradePreflightError("PRODUCTION_UPGRADE_PREFLIGHT_TRANSACTION_INVALID");
  }
}

function rowFinished(row: MigrationLedgerRow): boolean {
  if (typeof row.finished === "boolean") return row.finished;
  return row.finished_at !== null && row.finished_at !== undefined;
}

function rowRolledBack(row: MigrationLedgerRow): boolean {
  if (typeof row.rolled_back === "boolean") return row.rolled_back;
  return row.rolled_back_at !== null && row.rolled_back_at !== undefined;
}

function rowHasAppliedSteps(row: MigrationLedgerRow): boolean {
  if (row.applied_steps_count === undefined) return false;
  const count = typeof row.applied_steps_count === "bigint"
    ? Number(row.applied_steps_count)
    : typeof row.applied_steps_count === "number"
      ? row.applied_steps_count
      : Number(row.applied_steps_count);
  return Number.isSafeInteger(count) && count > 0;
}

function validateMigrationLedger(rows: readonly MigrationLedgerRow[]): void {
  if (rows.length !== LEGACY_MIGRATION_MANIFEST.length) {
    throw new ProductionUpgradePreflightError("PRODUCTION_UPGRADE_PREFLIGHT_MIGRATION_LEDGER_INVALID");
  }
  const expected = new Map<string, string>(LEGACY_MIGRATION_MANIFEST.map((entry) => [entry.name, entry.checksum]));
  const actual = new Set<string>();
  for (const row of rows) {
    if (
      typeof row.migration_name !== "string"
      || actual.has(row.migration_name)
      || !expected.has(row.migration_name)
      || row.checksum !== expected.get(row.migration_name)
      || !rowFinished(row)
      || rowRolledBack(row)
      || !rowHasAppliedSteps(row)
    ) {
      throw new ProductionUpgradePreflightError("PRODUCTION_UPGRADE_PREFLIGHT_MIGRATION_LEDGER_INVALID");
    }
    actual.add(row.migration_name);
  }
  if (actual.size !== expected.size) {
    throw new ProductionUpgradePreflightError("PRODUCTION_UPGRADE_PREFLIGHT_MIGRATION_LEDGER_INVALID");
  }
}

function validateLegacySchema(
  relationRows: readonly SchemaRelationRow[],
  columnRows: readonly SchemaColumnRow[],
): void {
  const expectedRelations = REQUIRED_LEGACY_SCHEMA.relations;
  if (
    relationRows.length !== expectedRelations.length
    || expectedRelations.some((relation, index) => relationRows[index]?.relation_name !== relation || relationRows[index]?.present !== true)
  ) {
    throw new ProductionUpgradePreflightError("PRODUCTION_UPGRADE_PREFLIGHT_SCHEMA_INVALID");
  }
  const expectedColumns = REQUIRED_LEGACY_SCHEMA.columns.map(({ relation, column }) => [relation, column] as const);
  if (
    columnRows.length !== expectedColumns.length
    || expectedColumns.some(([relation, column], index) => {
      const row = columnRows[index];
      return row?.relation_name !== relation || row.column_name !== column || row.present !== true;
    })
  ) {
    throw new ProductionUpgradePreflightError("PRODUCTION_UPGRADE_PREFLIGHT_SCHEMA_INVALID");
  }
}

function validateDataGates(row: DataGateRow): void {
  for (const gate of CLEAN_SLATE_DATA_GATES) {
    if (!isBoolean(row[gate])) {
      throw new ProductionUpgradePreflightError("PRODUCTION_UPGRADE_PREFLIGHT_RESULT_INVALID");
    }
    if (row[gate]) {
      throw new ProductionUpgradePreflightError("PRODUCTION_UPGRADE_PREFLIGHT_DATA_BLOCKED");
    }
  }
}

export async function runProductionUpgradePreflight(
  client: ProductionUpgradePreflightQueryClient,
  phase: ProductionUpgradePreflightPhase,
): Promise<ProductionUpgradePreflightReport> {
  let failure: ProductionUpgradePreflightError | undefined;
  let checksPassed = false;
  try {
    try {
      await client.query(PRODUCTION_UPGRADE_PREFLIGHT_SQL.begin);
      await client.query(PRODUCTION_UPGRADE_PREFLIGHT_SQL.searchPath);
      await client.query(PRODUCTION_UPGRADE_PREFLIGHT_SQL.lockTimeout);
      await client.query(PRODUCTION_UPGRADE_PREFLIGHT_SQL.statementTimeout);
    } catch {
      throw new ProductionUpgradePreflightError("PRODUCTION_UPGRADE_PREFLIGHT_QUERY_FAILED");
    }

    validateTransactionSettings(requireSingleRow(await queryProductionUpgradePreflightRows<TransactionSettingsRow>(client, PRODUCTION_UPGRADE_PREFLIGHT_SQL.transactionSettings)));
    const migrationRows = await queryProductionUpgradePreflightRows<MigrationLedgerRow>(client, PRODUCTION_UPGRADE_PREFLIGHT_SQL.migrationLedger);
    validateMigrationLedger(migrationRows);

    const relationNames = REQUIRED_LEGACY_SCHEMA.relations;
    const schemaRelations = await queryProductionUpgradePreflightRows<SchemaRelationRow>(client, PRODUCTION_UPGRADE_PREFLIGHT_SQL.schemaRelations, [relationNames]);
    const schemaColumns = REQUIRED_LEGACY_SCHEMA.columns.map(({ relation, column }) => [relation, column] as const);
    const schemaColumnRows = await queryProductionUpgradePreflightRows<SchemaColumnRow>(client, PRODUCTION_UPGRADE_PREFLIGHT_SQL.schemaColumns, [schemaColumns.map(([relation]) => relation), schemaColumns.map(([, column]) => column)]);
    validateLegacySchema(schemaRelations, schemaColumnRows);

    const dataGates = requireSingleRow(await queryProductionUpgradePreflightRows<DataGateRow>(client, PRODUCTION_UPGRADE_PREFLIGHT_SQL.dataGates));
    const optionalRelations = requireSingleRow(await queryProductionUpgradePreflightRows<OptionalRelationRow>(client, PRODUCTION_UPGRADE_PREFLIGHT_SQL.optionalRelations));
    if (optionalRelations.relation_name !== "AiProviderOwnershipAudit" || typeof optionalRelations.present !== "boolean") {
      throw new ProductionUpgradePreflightError("PRODUCTION_UPGRADE_PREFLIGHT_RESULT_INVALID");
    }
    if (optionalRelations.present) {
      const audit = requireSingleRow(await queryProductionUpgradePreflightRows<AuditDataGateRow>(client, PRODUCTION_UPGRADE_PREFLIGHT_SQL.auditDataGate));
      dataGates.ai_provider_ownership_audit = audit.ai_provider_ownership_audit;
    } else {
      dataGates.ai_provider_ownership_audit = false;
    }
    validateDataGates(dataGates);

    checksPassed = true;
  } catch (error) {
    failure = error instanceof ProductionUpgradePreflightError
      ? error
      : new ProductionUpgradePreflightError("PRODUCTION_UPGRADE_PREFLIGHT_FAILED");
  } finally {
    try {
      await client.query(PRODUCTION_UPGRADE_PREFLIGHT_SQL.rollback);
    } catch {
      if (failure === undefined) failure = new ProductionUpgradePreflightError("PRODUCTION_UPGRADE_PREFLIGHT_ROLLBACK_FAILED");
    }
  }

  if (failure !== undefined) throw failure;
  if (!checksPassed) throw new ProductionUpgradePreflightError("PRODUCTION_UPGRADE_PREFLIGHT_RESULT_INVALID");
  // PostgreSQL fixes a REPEATABLE READ snapshot at the first SELECT. Perform
  // the quiescence check only after ROLLBACK so a client that connected while
  // the ledger/schema snapshot was being inspected cannot be hidden from the
  // final pre-mutation observation.
  if (phase === "post-stop") {
    const clientBackends = requireSingleRow(await queryProductionUpgradePreflightRows<ClientBackendRow>(client, PRODUCTION_UPGRADE_PREFLIGHT_SQL.otherClientBackends));
    if (clientBackends.other_client_backend !== false) {
      throw new ProductionUpgradePreflightError("PRODUCTION_UPGRADE_PREFLIGHT_CLIENT_BACKENDS_PRESENT");
    }
  }
  return buildProductionUpgradePreflightReport(phase);
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value));
}

function asQueryClient(client: Client): ProductionUpgradePreflightQueryClient {
  return {
    query: async <Row = unknown>(text: string, values?: readonly unknown[]) => {
      const result = await client.query(text, values === undefined ? undefined : [...values]);
      return { rows: result.rows as readonly Row[] };
    },
  };
}

export async function main(
  args: readonly string[] = readCliArguments(),
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<number> {
  try {
    const phase = parseProductionUpgradePreflightArguments(args);
    const client = new Client(readProductionUpgradePreflightDatabaseConfig(env));
    try {
      await client.connect();
    } catch {
      printJson(buildProductionUpgradePreflightFailure(new ProductionUpgradePreflightError("PRODUCTION_UPGRADE_PREFLIGHT_DATABASE_CONNECT_FAILED")));
      return 1;
    }
    try {
      printJson(await runProductionUpgradePreflight(asQueryClient(client), phase));
      return 0;
    } catch (error) {
      printJson(buildProductionUpgradePreflightFailure(error));
      return 1;
    } finally {
      try {
        await client.end();
      } catch {
        // The result is already redacted and independent from close details.
      }
    }
  } catch (error) {
    printJson(buildProductionUpgradePreflightFailure(error));
    return 1;
  }
}

const isDirectExecution = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  void main().then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error) => {
    printJson({ ok: false, error: { code: safeProductionUpgradePreflightErrorCode(error) } });
    process.exitCode = 1;
  });
}
