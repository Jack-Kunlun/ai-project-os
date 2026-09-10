import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import {
  buildOwnershipInventoryFailure,
  buildOwnershipInventoryReport,
  CLEAN_SLATE_REMOVED_PROVIDER_COLUMNS,
  CLEAN_SLATE_REMOVED_RELATIONS,
  CLEAN_SLATE_REMOVED_TRIGGERS,
  INVENTORY_TABLES,
  OWNERSHIP_INVENTORY_KIND,
  OWNERSHIP_INVENTORY_REPORT_VERSION,
  REQUIRED_CONSTRAINTS,
  REQUIRED_ENUMS,
  REQUIRED_MIGRATIONS,
  parseOwnershipInventoryArguments,
  parseOwnershipInventoryDatabaseUrl,
  readOwnershipInventoryDatabaseConfig,
  type OwnershipInventoryRows,
} from "../scripts/0.2x-migration-inventory-contract";
import { INVENTORY_SQL, main, runOwnershipInventory } from "../scripts/0.2x-migration-inventory";

function zeroRows(): OwnershipInventoryRows {
  return {
    appliedMigrationCount: 64,
    accounts: { total: 0, admin: 0, user: 0, invalid: 0, enabled: 0, disabled: 0 },
    aiProvider: {
      total: 0,
      platform: 0,
      user: 0,
      invalid: 0,
      platform_with_owner: 0,
      user_without_owner: 0,
      configured: 0,
      verified: 0,
      error: 0,
      disabled: 0,
    },
    legacyArtifacts: { removed_relations: 0, removed_provider_columns: 0, removed_triggers: 0 },
  };
}

function preflightRows() {
  return {
    migrationRows: REQUIRED_MIGRATIONS.map((migration_name) => ({ migration_name, applied: true, applied_migration_count: "64" })),
    constraintRows: REQUIRED_CONSTRAINTS.map(({ name, table }) => ({ constraint_name: name, relation_name: table, constraint_type: "c", validated: true })),
    enumRows: [
      ...REQUIRED_ENUMS.AppUserRole.map((enum_value) => ({ enum_name: "AppUserRole", enum_value })),
      ...REQUIRED_ENUMS.AiProviderScope.map((enum_value) => ({ enum_name: "AiProviderScope", enum_value })),
    ],
    rlsRows: INVENTORY_TABLES.map((relation_name) => ({ relation_name, row_security: false, force_row_security: false })),
    roleRows: [{
      role_name: "inventory_reader",
      is_superuser: false,
      bypass_rls: false,
      can_replicate: false,
      owns_database: false,
      owns_schema: false,
      owns_target_table: false,
      can_create_database: false,
      can_create_database_role: false,
      can_create_role: false,
      can_create_schema: false,
      can_create_temporary: false,
      role_default_transaction_read_only: true,
      database_default_transaction_read_only: false,
      has_database_role_read_only_override: false,
      default_transaction_read_only: "on",
      can_select_target: true,
      has_unapproved_select: false,
      can_insert_target: false,
      can_update_target: false,
      can_delete_target: false,
      can_truncate_target: false,
      can_references_target: false,
      can_trigger_target: false,
    }],
    legacyArtifacts: [{ removed_relations: 0, removed_provider_columns: 0, removed_triggers: 0 }],
  };
}

test("clean-slate inventory exposes the current role, scope and removal contract", () => {
  assert.equal(OWNERSHIP_INVENTORY_KIND, "clean-slate-schema-inventory");
  assert.equal(OWNERSHIP_INVENTORY_REPORT_VERSION, 2);
  assert.deepEqual(REQUIRED_MIGRATIONS, ["20260910010000_clean_slate_ai_provider_model"]);
  assert.deepEqual(REQUIRED_ENUMS, { AppUserRole: ["admin", "user"], AiProviderScope: ["platform", "user"] });
  assert.equal(INVENTORY_TABLES.includes("AppUser"), true);
  assert.equal(INVENTORY_TABLES.includes("AiProviderConnection"), true);
  for (const removed of CLEAN_SLATE_REMOVED_RELATIONS) assert.equal(INVENTORY_TABLES.includes(removed as never), false);
  assert.deepEqual(CLEAN_SLATE_REMOVED_PROVIDER_COLUMNS, ["workspaceId", "ownershipState"]);
  assert.ok(CLEAN_SLATE_REMOVED_TRIGGERS.length >= 3);
});

test("clean-slate inventory report rejects legacy artifacts and validates partitions", () => {
  const rows = zeroRows();
  rows.accounts = { total: 3, admin: 1, user: 2, invalid: 0, enabled: 2, disabled: 1 };
  rows.aiProvider = { total: 3, platform: 1, user: 2, invalid: 0, platform_with_owner: 0, user_without_owner: 0, configured: 1, verified: 1, error: 0, disabled: 1 };
  const report = buildOwnershipInventoryReport(rows, new Date("2026-09-10T00:00:00.000Z"));
  assert.deepEqual(report.snapshot, {
    readOnly: true,
    isolation: "repeatable_read",
    migrations: { cleanSlate: "applied" },
    appliedMigrationCount: 64,
  });
  assert.deepEqual(report.resources.accounts.systemRole, { admin: 1, user: 2, invalid: 0 });
  assert.deepEqual(report.resources.aiProvider.scope, { platform: 1, user: 2, invalid: 0 });
  assert.throws(
    () => buildOwnershipInventoryReport({ ...rows, legacyArtifacts: { removed_relations: 1, removed_provider_columns: 0, removed_triggers: 0 } }, new Date()),
    /OWNERSHIP_INVENTORY_PREFLIGHT_FAILED/u,
  );
  assert.throws(
    () => buildOwnershipInventoryReport({ ...rows, accounts: { ...rows.accounts, user: 3 } }, new Date()),
    /OWNERSHIP_INVENTORY_RESULT_INVALID/u,
  );
  assert.deepEqual(buildOwnershipInventoryFailure(new Error("secret detail")), { ok: false, error: { code: "OWNERSHIP_INVENTORY_FAILED" } });
});

test("inventory database URL and CLI boundaries stay strict", async () => {
  assert.doesNotThrow(() => parseOwnershipInventoryArguments([]));
  assert.throws(() => parseOwnershipInventoryArguments(["--write"]), /OWNERSHIP_INVENTORY_ARGUMENTS_INVALID/u);
  assert.throws(() => readOwnershipInventoryDatabaseConfig({ DATABASE_URL: "postgresql://fallback/db" }), /OWNERSHIP_INVENTORY_DATABASE_URL_REQUIRED/u);
  assert.deepEqual(
    parseOwnershipInventoryDatabaseUrl("postgresql://reader:secret%40value@127.0.0.1:56432/inventory?sslmode=disable"),
    {
      host: "127.0.0.1",
      port: 56432,
      user: "reader",
      password: "secret@value",
      database: "inventory",
      binary: false,
      client_encoding: "UTF8",
      replication: "false",
      ssl: false,
      connectionTimeoutMillis: 5_000,
      application_name: "ai-project-os-clean-slate-inventory",
      options: "-c default_transaction_read_only=on",
    },
  );
  for (const value of [
    "https://example.test/inventory?sslmode=verify-full",
    "postgresql://reader:secret@127.0.0.1:56432/inventory",
    "postgresql://reader:secret@127.0.0.1:56432/inventory?sslmode=require",
    "postgresql://reader:secret@db.internal:56432/inventory?sslmode=disable",
  ]) assert.throws(() => parseOwnershipInventoryDatabaseUrl(value), /OWNERSHIP_INVENTORY_DATABASE_URL_INVALID/u);

  const output: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => output.push(values.map(String).join(" "));
  try {
    assert.equal(await main(["--write"], { OWNERSHIP_INVENTORY_DATABASE_URL: "postgresql://invalid:invalid@127.0.0.1:56432/inventory?sslmode=disable" }), 1);
  } finally {
    console.log = originalLog;
  }
  assert.deepEqual(JSON.parse(output[0] ?? "{}"), { ok: false, error: { code: "OWNERSHIP_INVENTORY_ARGUMENTS_INVALID" } });
});

test("inventory execution is read-only, fixed-query and rollback-only", async () => {
  const fixtures = preflightRows();
  const calls: string[] = [];
  const legacyQueryValues: unknown[][] = [];
  const client = {
    async query<Row = unknown>(text: string, values?: readonly unknown[]): Promise<{ rows: readonly Row[] }> {
      calls.push(text);
      if (text === INVENTORY_SQL.begin || text === INVENTORY_SQL.searchPath || text === INVENTORY_SQL.rollback) return { rows: [] as readonly Row[] };
      if (text === INVENTORY_SQL.transactionReadOnly) return { rows: [{ transaction_read_only: "on" }] as unknown as readonly Row[] };
      if (text === INVENTORY_SQL.migrations) return { rows: fixtures.migrationRows as unknown as readonly Row[] };
      if (text === INVENTORY_SQL.constraints) return { rows: fixtures.constraintRows as unknown as readonly Row[] };
      if (text === INVENTORY_SQL.enums) return { rows: fixtures.enumRows as unknown as readonly Row[] };
      if (text === INVENTORY_SQL.rls) return { rows: fixtures.rlsRows as unknown as readonly Row[] };
      if (text === INVENTORY_SQL.role) return { rows: fixtures.roleRows as unknown as readonly Row[] };
      if (text === INVENTORY_SQL.legacyArtifacts) {
        legacyQueryValues.push(values === undefined ? [] : [...values]);
        return { rows: fixtures.legacyArtifacts as unknown as readonly Row[] };
      }
      if (text === INVENTORY_SQL.accounts) return { rows: [zeroRows().accounts] as unknown as readonly Row[] };
      if (text === INVENTORY_SQL.aiProvider) return { rows: [zeroRows().aiProvider] as unknown as readonly Row[] };
      throw new Error("unexpected query");
    },
  };
  const report = await runOwnershipInventory(client);
  assert.equal(report.ok, true);
  assert.equal(calls[0], INVENTORY_SQL.begin);
  assert.equal(calls[1], INVENTORY_SQL.searchPath);
  assert.equal(calls.at(-1), INVENTORY_SQL.rollback);
  assert.equal(calls.filter((call) => call === INVENTORY_SQL.rollback).length, 1);
  assert.equal(legacyQueryValues.length, 2);
  for (const values of legacyQueryValues) {
    assert.deepEqual(values, [CLEAN_SLATE_REMOVED_RELATIONS, CLEAN_SLATE_REMOVED_PROVIDER_COLUMNS, CLEAN_SLATE_REMOVED_TRIGGERS]);
  }
  assert.ok(!calls.some((call) => /(?:^|\n)\s*(?:INSERT|UPDATE|DELETE|TRUNCATE|CREATE|ALTER|DROP|COMMIT)\b/iu.test(call)));
});

test("inventory implementation does not query removed provider fields or route models", async () => {
  const source = await readFile(resolve(process.cwd(), "scripts/0.2x-migration-inventory.ts"), "utf8");
  assert.doesNotMatch(source, /SELECT\s+\*/iu);
  assert.doesNotMatch(source, /(?:^|\n)\s*(?:INSERT|UPDATE|DELETE|TRUNCATE|CREATE|ALTER|DROP|COMMIT)\b/iu);
  assert.doesNotMatch(INVENTORY_SQL.aiProvider, /workspaceId|ownershipState/u);
  for (const removedRelation of CLEAN_SLATE_REMOVED_RELATIONS) {
    assert.doesNotMatch(INVENTORY_SQL.aiProvider, new RegExp(removedRelation, "u"));
  }
  assert.match(INVENTORY_SQL.legacyArtifacts, /pg_class/u);
  assert.match(INVENTORY_SQL.legacyArtifacts, /pg_attribute/u);
  assert.match(INVENTORY_SQL.legacyArtifacts, /pg_trigger/u);
  assert.match(source, /readOwnershipInventoryDatabaseConfig\(env\)/u);
  assert.match(source, /new Client\(clientConfig\)/u);
});

test("inventory role preflight distinguishes database-wide and database-role read-only settings", async () => {
  assert.match(
    INVENTORY_SQL.role,
    /database_setting\.setdatabase\s*=\s*database_meta\.oid\s+AND\s+database_setting\.setrole\s*=\s*0/iu,
  );
  assert.match(
    INVENTORY_SQL.role,
    /database_role_setting\.setdatabase\s*=\s*database_meta\.oid\s+AND\s+database_role_setting\.setrole\s*=\s*role_meta\.oid/iu,
  );
  assert.doesNotMatch(INVENTORY_SQL.role, /database_role_setting\.setdatabase\s+IN\s*\(0,\s*database_meta\.oid\)/iu);
  assert.doesNotMatch(INVENTORY_SQL.role, /database_role_setting\.setrole\s+IN\s*\(0,\s*role_meta\.oid\)/iu);

  const databaseRoleOverride = INVENTORY_SQL.role.slice(
    INVENTORY_SQL.role.indexOf("AS has_database_role_read_only_override") - 900,
    INVENTORY_SQL.role.indexOf("AS has_database_role_read_only_override") + 40,
  );
  assert.match(databaseRoleOverride, /split_part\(override_setting\.setting,\s*'=',\s*1\)\s*=\s*'default_transaction_read_only'/iu);
  assert.doesNotMatch(databaseRoleOverride, /lower\(split_part\(override_setting\.setting/iu);
  assert.match(INVENTORY_SQL.role, /has_database_privilege\(current_user,\s*current_database\(\),\s*'CREATE'\)\s+AS\s+can_create_database/iu);
  assert.match(INVENTORY_SQL.role, /has_schema_privilege\(current_user,\s*'public',\s*'CREATE'\)\s+AS\s+can_create_schema/iu);
  const source = await readFile(resolve(process.cwd(), "scripts/0.2x-migration-inventory.ts"), "utf8");
  assert.match(source, /assertFalse\(role\.can_create_database\)/u);
  assert.match(source, /assertFalse\(role\.can_create_schema\)/u);
});
