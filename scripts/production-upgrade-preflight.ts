import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { Client } from "pg";
import { readCliArguments } from "./cli-arguments";
import {
  buildProductionUpgradePreflightFailure,
  buildProductionUpgradePreflightReport,
  CLEAN_SLATE_DATA_GATES,
  LEGACY_MIGRATION_MANIFEST,
  PRODUCTION_UPGRADE_CLUSTER_ADMIN_ROLE,
  PRODUCTION_UPGRADE_REQUIRED_EXTENSIONS,
  PRODUCTION_UPGRADE_SEALED_LEGACY_ROLE,
  ProductionUpgradePreflightError,
  parseProductionUpgradePreflightArguments,
  readProductionUpgradePreflightDatabaseCandidates,
  readProductionUpgradePreflightLegacyRole,
  REQUIRED_LEGACY_SCHEMA,
  safeProductionUpgradePreflightErrorCode,
  type ProductionUpgradePreflightPhase,
  type ProductionUpgradePreflightDatabaseConfig,
  type ProductionUpgradePreflightReport,
} from "./production-upgrade-preflight-contract";

export interface ProductionUpgradePreflightQueryClient {
  query<Row = unknown>(text: string, values?: readonly unknown[]): Promise<{ rows: readonly Row[] }>;
}

interface ProductionUpgradePreflightConnectableClient extends ProductionUpgradePreflightQueryClient {
  connect(): Promise<void>;
  end(): Promise<void>;
}

type ProductionUpgradePreflightClientFactory = (
  config: ProductionUpgradePreflightDatabaseConfig,
) => ProductionUpgradePreflightConnectableClient;

export async function connectProductionUpgradePreflightClient(
  configs: readonly ProductionUpgradePreflightDatabaseConfig[],
  clientFactory: ProductionUpgradePreflightClientFactory = (config) => new Client(config),
): Promise<ProductionUpgradePreflightConnectableClient> {
  for (const config of configs) {
    const client = clientFactory(config);
    try {
      await client.connect();
      return client;
    } catch {
      // A sealed or renamed legacy role is expected to fail here.  Do not
      // expose the driver error; the target candidate is the only fallback.
      await client.end().catch(() => undefined);
    }
  }
  throw new ProductionUpgradePreflightError("PRODUCTION_UPGRADE_PREFLIGHT_DATABASE_CONNECT_FAILED");
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

interface DatabasePrincipalSessionRow {
  session_user: string;
  current_user: string;
  session_role_oid: string | null;
  session_is_superuser: boolean;
}

interface DatabasePrincipalRoleRow {
  role_name: string;
  role_oid: string;
  can_login: boolean;
  password: string | null;
  is_superuser: boolean;
  can_create_db: boolean;
  can_create_role: boolean;
  inherit: boolean;
  replication: boolean;
  bypass_rls: boolean;
  has_membership: boolean;
}

interface DatabasePrincipalExtensionRow {
  extension_name: string;
  schema_name: string;
  owner_name: string | null;
  owner_oid: string;
}

type DatabasePrincipalCheck = "cluster-admin-owned" | "legacy-extension-owners-reassignable" | "pinned-oid10-extension-owners-supported";

interface ProductionUpgradePreflightOptions {
  legacyRole?: string | null;
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
  databasePrincipalSession: `
    SELECT session_user,
           current_user,
           (SELECT role_row.oid::text FROM pg_catalog.pg_roles AS role_row WHERE role_row.rolname = session_user) AS session_role_oid,
           (SELECT role_row.rolsuper FROM pg_catalog.pg_roles AS role_row WHERE role_row.rolname = session_user) AS session_is_superuser
  `,
  databasePrincipalRoles: `
    SELECT role_row.rolname AS role_name,
           role_row.oid::text AS role_oid,
           role_row.rolcanlogin AS can_login,
           role_row.rolpassword AS password,
           role_row.rolsuper AS is_superuser,
           role_row.rolcreatedb AS can_create_db,
           role_row.rolcreaterole AS can_create_role,
           role_row.rolinherit AS inherit,
           role_row.rolreplication AS replication,
           role_row.rolbypassrls AS bypass_rls,
           EXISTS (
             SELECT 1
               FROM pg_catalog.pg_auth_members AS membership
              WHERE membership.member = role_row.oid
                 OR membership.roleid = role_row.oid
           ) AS has_membership
      FROM pg_catalog.pg_authid AS role_row
     WHERE role_row.rolname = ANY($1::text[])
     ORDER BY role_row.rolname
  `,
  databasePrincipalExtensions: `
    SELECT extension_row.extname AS extension_name,
           namespace.nspname AS schema_name,
           pg_catalog.pg_get_userbyid(extension_row.extowner) AS owner_name,
           extension_row.extowner::text AS owner_oid
      FROM pg_catalog.pg_extension AS extension_row
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = extension_row.extnamespace
     ORDER BY extension_row.extname
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
           EXISTS (SELECT 1 FROM "public"."ProjectAiRoute") AS project_ai_route,
           EXISTS (SELECT 1 FROM "public"."ProjectAiRouteRevision") AS project_ai_route_revision,
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

function isExactSealedLegacyRole(row: DatabasePrincipalRoleRow | undefined): boolean {
  return row?.role_name === PRODUCTION_UPGRADE_SEALED_LEGACY_ROLE
    && row.role_oid === "10"
    && !row.can_login
    && row.password === null
    && row.is_superuser
    && !row.can_create_db
    && !row.can_create_role
    && !row.inherit
    && !row.replication
    && !row.bypass_rls
    && !row.has_membership;
}

function invalidDatabasePrincipal(): never {
  throw new ProductionUpgradePreflightError("PRODUCTION_UPGRADE_PREFLIGHT_DATABASE_PRINCIPAL_INVALID");
}

function isUsableAdministrativeRole(row: DatabasePrincipalRoleRow | undefined): row is DatabasePrincipalRoleRow {
  return row !== undefined && row.is_superuser && !row.has_membership;
}

function validateDatabasePrincipalFeasibility(
  session: DatabasePrincipalSessionRow,
  roles: readonly DatabasePrincipalRoleRow[],
  extensions: readonly DatabasePrincipalExtensionRow[],
  legacyRole: string | null,
): DatabasePrincipalCheck {
  if (
    session.session_user.length === 0
    || session.session_user !== session.current_user
    || session.session_role_oid === null
    || !session.session_is_superuser
  ) return invalidDatabasePrincipal();

  const expectedRoleNames = new Set<string>([
    session.session_user,
    PRODUCTION_UPGRADE_CLUSTER_ADMIN_ROLE,
    PRODUCTION_UPGRADE_SEALED_LEGACY_ROLE,
    ...(legacyRole === null ? [] : [legacyRole]),
  ]);
  const roleByName = new Map<string, DatabasePrincipalRoleRow>();
  for (const role of roles) {
    if (roleByName.has(role.role_name) || !expectedRoleNames.has(role.role_name)) return invalidDatabasePrincipal();
    roleByName.set(role.role_name, role);
  }

  const sessionIsClusterAdmin = session.session_user === PRODUCTION_UPGRADE_CLUSTER_ADMIN_ROLE;
  const sessionIsLegacy = legacyRole !== null && session.session_user === legacyRole;
  if (!sessionIsClusterAdmin && !sessionIsLegacy) return invalidDatabasePrincipal();
  const sessionRole = roleByName.get(session.session_user);
  if (
    !isUsableAdministrativeRole(sessionRole)
    || !sessionRole.can_login
    || sessionRole.role_oid !== session.session_role_oid
  ) return invalidDatabasePrincipal();

  const clusterAdminRole = roleByName.get(PRODUCTION_UPGRADE_CLUSTER_ADMIN_ROLE);
  if (clusterAdminRole !== undefined
    && !isUsableAdministrativeRole(clusterAdminRole)) {
    return invalidDatabasePrincipal();
  }

  const sealedRole = roleByName.get(PRODUCTION_UPGRADE_SEALED_LEGACY_ROLE);
  if (sealedRole !== undefined && !isExactSealedLegacyRole(sealedRole)) return invalidDatabasePrincipal();

  const configuredLegacyRole = legacyRole === null ? undefined : roleByName.get(legacyRole);
  if (configuredLegacyRole !== undefined
    && legacyRole !== PRODUCTION_UPGRADE_SEALED_LEGACY_ROLE
    && !isUsableAdministrativeRole(configuredLegacyRole)) {
    return invalidDatabasePrincipal();
  }

  const expectedExtensions = [...PRODUCTION_UPGRADE_REQUIRED_EXTENSIONS].sort();
  const actualExtensions = extensions.map((row) => row.extension_name).sort();
  if (
    actualExtensions.length !== expectedExtensions.length
    || actualExtensions.some((name, index) => name !== expectedExtensions[index])
  ) return invalidDatabasePrincipal();

  let highestCheck: DatabasePrincipalCheck = "cluster-admin-owned";
  for (const extension of extensions) {
    const expectedSchema = extension.extension_name === "plpgsql" ? "pg_catalog" : "public";
    if (extension.schema_name !== expectedSchema || extension.owner_name === null) return invalidDatabasePrincipal();

    const ownerRole = roleByName.get(extension.owner_name);
    if (ownerRole === undefined || ownerRole.role_oid !== extension.owner_oid) return invalidDatabasePrincipal();
    if (extension.owner_name === PRODUCTION_UPGRADE_CLUSTER_ADMIN_ROLE) {
      if (!isUsableAdministrativeRole(ownerRole)) return invalidDatabasePrincipal();
      continue;
    }
    if (extension.owner_name === PRODUCTION_UPGRADE_SEALED_LEGACY_ROLE) {
      if (extension.owner_oid !== "10" || !isExactSealedLegacyRole(sealedRole)) return invalidDatabasePrincipal();
      highestCheck = "pinned-oid10-extension-owners-supported";
      continue;
    }
    if (legacyRole !== null && extension.owner_name === legacyRole && legacyRole !== PRODUCTION_UPGRADE_SEALED_LEGACY_ROLE) {
      if (!isUsableAdministrativeRole(ownerRole)) return invalidDatabasePrincipal();
      if (ownerRole.role_oid === "10") {
        highestCheck = "pinned-oid10-extension-owners-supported";
      } else if (highestCheck === "cluster-admin-owned") {
        highestCheck = "legacy-extension-owners-reassignable";
      }
      continue;
    }
    return invalidDatabasePrincipal();
  }
  return highestCheck;
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
  options: ProductionUpgradePreflightOptions = {},
): Promise<ProductionUpgradePreflightReport> {
  let failure: ProductionUpgradePreflightError | undefined;
  let checksPassed = false;
  let databasePrincipal: DatabasePrincipalCheck | undefined;
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
    const databasePrincipalSession = requireSingleRow(await queryProductionUpgradePreflightRows<DatabasePrincipalSessionRow>(client, PRODUCTION_UPGRADE_PREFLIGHT_SQL.databasePrincipalSession));
    const databasePrincipalRoleNames = [
      databasePrincipalSession.session_user,
      PRODUCTION_UPGRADE_CLUSTER_ADMIN_ROLE,
      PRODUCTION_UPGRADE_SEALED_LEGACY_ROLE,
      ...(options.legacyRole === null || options.legacyRole === undefined ? [] : [options.legacyRole]),
    ];
    const databasePrincipalRoles = await queryProductionUpgradePreflightRows<DatabasePrincipalRoleRow>(
      client,
      PRODUCTION_UPGRADE_PREFLIGHT_SQL.databasePrincipalRoles,
      [Array.from(new Set(databasePrincipalRoleNames))],
    );
    const databasePrincipalExtensions = await queryProductionUpgradePreflightRows<DatabasePrincipalExtensionRow>(
      client,
      PRODUCTION_UPGRADE_PREFLIGHT_SQL.databasePrincipalExtensions,
    );
    databasePrincipal = validateDatabasePrincipalFeasibility(
      databasePrincipalSession,
      databasePrincipalRoles,
      databasePrincipalExtensions,
      options.legacyRole ?? null,
    );
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
  if (databasePrincipal === undefined) throw new ProductionUpgradePreflightError("PRODUCTION_UPGRADE_PREFLIGHT_RESULT_INVALID");
  return buildProductionUpgradePreflightReport(phase, databasePrincipal);
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value));
}

function asQueryClient(client: ProductionUpgradePreflightQueryClient): ProductionUpgradePreflightQueryClient {
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
    const databaseConfigs = readProductionUpgradePreflightDatabaseCandidates(env);
    const legacyRole = readProductionUpgradePreflightLegacyRole(env);
    let client: ProductionUpgradePreflightConnectableClient;
    try {
      client = await connectProductionUpgradePreflightClient(databaseConfigs);
    } catch (error) {
      printJson(buildProductionUpgradePreflightFailure(error));
      return 1;
    }
    try {
      printJson(await runProductionUpgradePreflight(asQueryClient(client), phase, { legacyRole }));
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
