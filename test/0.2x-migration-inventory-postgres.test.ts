import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import {
  CLEAN_SLATE_REMOVED_PROVIDER_COLUMNS,
  CLEAN_SLATE_REMOVED_RELATIONS,
  CLEAN_SLATE_REMOVED_TRIGGERS,
  INVENTORY_TABLES,
  parseOwnershipInventoryDatabaseUrl,
} from "../scripts/0.2x-migration-inventory-contract";
import { runOwnershipInventory } from "../scripts/0.2x-migration-inventory";

const shouldRun = process.env.CLEAN_SLATE_SCHEMA_POSTGRES_GATE === "1";
const testDatabaseName = "ai_project_os_ownership_inventory_test";
const readerRole = "ai_project_os_inventory_reader";

interface PublicAclEntry {
  privilege_type: string;
  is_grantable: boolean;
}

interface PublicAccessSnapshot {
  database: PublicAclEntry[];
  schema: PublicAclEntry[];
  tables: Map<string, PublicAclEntry[]>;
  databaseReadOnlySetting: string | undefined;
}

function adminDatabaseConfig() {
  const value = process.env.CLEAN_SLATE_SCHEMA_TEST_DATABASE_URL;
  if (typeof value !== "string" || value.length === 0) throw new Error("CLEAN_SLATE_SCHEMA_TEST_DATABASE_URL_REQUIRED");
  const parsed = new URL(value);
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol)
    || !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname.toLowerCase())
    || parsed.port !== "56432"
    || parsed.pathname !== `/${testDatabaseName}`
    || parsed.username !== "ai_project_os_gate"
    || parsed.password.length === 0
    || parsed.search !== ""
    || parsed.hash !== ""
  ) throw new Error("CLEAN_SLATE_SCHEMA_TEST_DATABASE_URL_INVALID");
  parsed.searchParams.set("sslmode", "disable");
  return { connectionString: parsed.toString() };
}

function readerConfig(adminConfig: ReturnType<typeof adminDatabaseConfig>, password: string) {
  const parsed = new URL(adminConfig.connectionString);
  parsed.username = readerRole;
  parsed.password = password;
  return parseOwnershipInventoryDatabaseUrl(parsed.toString());
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : undefined;
}

async function removeReaderRole(admin: Client): Promise<void> {
  await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = $1 AND pid <> pg_backend_pid()", [readerRole]);
  const existing = await admin.query<{ exists: boolean }>("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists", [readerRole]);
  if (existing.rows[0]?.exists === true) {
    await admin.query(`DROP OWNED BY "${readerRole}"`);
    await admin.query(`DROP ROLE IF EXISTS "${readerRole}"`);
  }
}

function readerAdapter(client: Client) {
  return {
    query: async <Row = unknown>(text: string, values?: readonly unknown[]) => {
      const result = await client.query(text, values === undefined ? undefined : [...values]);
      return { rows: result.rows as readonly Row[] };
    },
  };
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function aclEntries<Row extends { privilege_type: string; is_grantable: boolean }>(rows: readonly Row[]): PublicAclEntry[] {
  return rows.map((row) => ({ privilege_type: row.privilege_type, is_grantable: row.is_grantable }));
}

async function capturePublicAccessSnapshot(admin: Client): Promise<PublicAccessSnapshot> {
  const database = await admin.query<{ privilege_type: string; is_grantable: boolean }>(`
    SELECT access.privilege_type, access.is_grantable
      FROM pg_database AS database_meta
      CROSS JOIN LATERAL aclexplode(COALESCE(database_meta.datacl, acldefault('d', database_meta.datdba))) AS access
     WHERE database_meta.datname = current_database()
       AND access.grantee = 0
     ORDER BY access.privilege_type
  `);
  const schema = await admin.query<{ privilege_type: string; is_grantable: boolean }>(`
    SELECT access.privilege_type, access.is_grantable
      FROM pg_namespace AS namespace_meta
      CROSS JOIN LATERAL aclexplode(COALESCE(namespace_meta.nspacl, acldefault('n', namespace_meta.nspowner))) AS access
     WHERE namespace_meta.nspname = 'public'
       AND access.grantee = 0
     ORDER BY access.privilege_type
  `);
  const tables = await admin.query<{ relation_name: string; privilege_type: string; is_grantable: boolean }>(`
    SELECT relation_meta.relname AS relation_name, access.privilege_type, access.is_grantable
      FROM pg_class AS relation_meta
      JOIN pg_namespace AS namespace_meta ON namespace_meta.oid = relation_meta.relnamespace
      CROSS JOIN LATERAL aclexplode(COALESCE(relation_meta.relacl, acldefault('r', relation_meta.relowner))) AS access
     WHERE namespace_meta.nspname = 'public'
       AND relation_meta.relkind IN ('r', 'p')
       AND relation_meta.relname = ANY($1::text[])
       AND access.grantee = 0
     ORDER BY array_position($1::text[], relation_meta.relname), access.privilege_type
  `, [INVENTORY_TABLES]);
  const databaseSetting = await admin.query<{ setting: string }>(`
    SELECT config.setting
      FROM pg_db_role_setting AS setting_meta
      JOIN pg_database AS database_meta ON database_meta.oid = setting_meta.setdatabase
      CROSS JOIN LATERAL unnest(COALESCE(setting_meta.setconfig, ARRAY[]::text[])) AS config(setting)
     WHERE database_meta.datname = current_database()
       AND setting_meta.setrole = 0
       AND split_part(config.setting, '=', 1) = 'default_transaction_read_only'
  `);
  const tablePrivileges = new Map<string, PublicAclEntry[]>(INVENTORY_TABLES.map((table) => [table, []]));
  for (const row of tables.rows) tablePrivileges.set(row.relation_name, [...(tablePrivileges.get(row.relation_name) ?? []), { privilege_type: row.privilege_type, is_grantable: row.is_grantable }]);
  return {
    database: aclEntries(database.rows),
    schema: aclEntries(schema.rows),
    tables: tablePrivileges,
    databaseReadOnlySetting: databaseSetting.rows[0]?.setting,
  };
}

async function restorePublicAcl(admin: Client, objectType: "DATABASE" | "SCHEMA" | "TABLE", objectName: string, entries: readonly PublicAclEntry[]): Promise<void> {
  const object = `${objectType} ${quoteIdentifier(objectName)}`;
  await admin.query(`REVOKE ALL PRIVILEGES ON ${object} FROM PUBLIC`);
  for (const entry of entries) {
    if (!/^[A-Z_]+$/u.test(entry.privilege_type)) throw new Error("CLEAN_SLATE_SCHEMA_POSTGRES_GATE_ACL_INVALID");
    await admin.query(`GRANT ${entry.privilege_type} ON ${object} TO PUBLIC${entry.is_grantable ? " WITH GRANT OPTION" : ""}`);
  }
}

async function restorePublicAccessSnapshot(admin: Client, snapshot: PublicAccessSnapshot): Promise<void> {
  await restorePublicAcl(admin, "DATABASE", testDatabaseName, snapshot.database);
  await restorePublicAcl(admin, "SCHEMA", "public", snapshot.schema);
  for (const table of INVENTORY_TABLES) await restorePublicAcl(admin, "TABLE", table, snapshot.tables.get(table) ?? []);
  await admin.query(`ALTER DATABASE ${quoteIdentifier(testDatabaseName)} RESET default_transaction_read_only`);
  if (snapshot.databaseReadOnlySetting !== undefined) {
    const separator = snapshot.databaseReadOnlySetting.indexOf("=");
    const value = separator < 0 ? snapshot.databaseReadOnlySetting : snapshot.databaseReadOnlySetting.slice(separator + 1);
    await admin.query(`ALTER DATABASE ${quoteIdentifier(testDatabaseName)} SET default_transaction_read_only = ${quoteLiteral(value)}`);
  }
}

async function assertInventoryPreflightFailure(config: ReturnType<typeof readerConfig>): Promise<void> {
  const reader = new Client(config);
  await reader.connect();
  try {
    await assert.rejects(
      () => runOwnershipInventory(readerAdapter(reader)),
      /OWNERSHIP_INVENTORY_PREFLIGHT_FAILED/u,
    );
  } finally {
    await reader.end();
  }
}

async function assertPreflightFailureAfterMutation(
  admin: Client,
  config: ReturnType<typeof readerConfig>,
  apply: () => Promise<void>,
  reset: () => Promise<void>,
): Promise<void> {
  await apply();
  try {
    await assertInventoryPreflightFailure(config);
  } finally {
    await reset();
  }
}

test(
  "clean-slate PostgreSQL gate contains only canonical roles and provider scopes",
  { skip: !shouldRun ? "CLEAN_SLATE_SCHEMA_POSTGRES_GATE=1 is required" : false },
  async () => {
    const admin = new Client(adminDatabaseConfig());
    const password = `InventoryReader_${randomUUID().replaceAll("-", "")}`;
    let publicAccessSnapshot: PublicAccessSnapshot | undefined;
    await admin.connect();
    try {
      publicAccessSnapshot = await capturePublicAccessSnapshot(admin);
      const roles = await admin.query<{ enum_name: string; enum_value: string }>(`
        SELECT type_meta.typname AS enum_name, enum_meta.enumlabel AS enum_value
          FROM pg_type AS type_meta
          JOIN pg_enum AS enum_meta ON enum_meta.enumtypid = type_meta.oid
          JOIN pg_namespace AS namespace_meta ON namespace_meta.oid = type_meta.typnamespace
         WHERE namespace_meta.nspname = 'public'
           AND type_meta.typname IN ('AppUserRole', 'AiProviderScope')
         ORDER BY type_meta.typname, enum_meta.enumsortorder
      `);
      assert.deepEqual(roles.rows, [
        { enum_name: "AiProviderScope", enum_value: "platform" },
        { enum_name: "AiProviderScope", enum_value: "user" },
        { enum_name: "AppUserRole", enum_value: "admin" },
        { enum_name: "AppUserRole", enum_value: "user" },
      ]);

      const removedRelations = await admin.query<{ relation_name: string }>(
        "SELECT relname AS relation_name FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname = ANY($1::text[])",
        [CLEAN_SLATE_REMOVED_RELATIONS],
      );
      assert.deepEqual(removedRelations.rows, []);

      const removedColumns = await admin.query<{ column_name: string }>(
        `SELECT attribute_meta.attname AS column_name
           FROM pg_attribute AS attribute_meta
           JOIN pg_class AS relation_meta ON relation_meta.oid = attribute_meta.attrelid
          WHERE relation_meta.relnamespace = 'public'::regnamespace
            AND relation_meta.relname = 'AiProviderConnection'
            AND attribute_meta.attname = ANY($1::text[])
            AND attribute_meta.attnum > 0
            AND NOT attribute_meta.attisdropped`,
        [CLEAN_SLATE_REMOVED_PROVIDER_COLUMNS],
      );
      assert.deepEqual(removedColumns.rows, []);

      const removedTriggers = await admin.query<{ trigger_name: string }>(
        `SELECT trigger_meta.tgname AS trigger_name
           FROM pg_trigger AS trigger_meta
           JOIN pg_class AS relation_meta ON relation_meta.oid = trigger_meta.tgrelid
          WHERE relation_meta.relnamespace = 'public'::regnamespace
            AND trigger_meta.tgname = ANY($1::text[])
            AND NOT trigger_meta.tgisinternal`,
        [CLEAN_SLATE_REMOVED_TRIGGERS],
      );
      assert.deepEqual(removedTriggers.rows, []);

      await removeReaderRole(admin);
      await admin.query(`CREATE ROLE "${readerRole}" LOGIN PASSWORD '${password}'`);
      await admin.query(`ALTER ROLE "${readerRole}" SET default_transaction_read_only = 'on'`);
      await admin.query(`ALTER DATABASE "${testDatabaseName}" SET default_transaction_read_only = 'on'`);
      await admin.query(`REVOKE TEMPORARY, CREATE ON DATABASE "${testDatabaseName}" FROM PUBLIC`);
      await admin.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
      await admin.query(`GRANT CONNECT ON DATABASE "${testDatabaseName}" TO "${readerRole}"`);
      await admin.query(`GRANT USAGE ON SCHEMA public TO "${readerRole}"`);
      for (const table of INVENTORY_TABLES) {
        await admin.query(`REVOKE ALL PRIVILEGES ON TABLE "${table}" FROM PUBLIC`);
        await admin.query(`GRANT SELECT ON TABLE "${table}" TO "${readerRole}"`);
      }

      const readerDatabaseConfig = readerConfig(adminDatabaseConfig(), password);
      await assertPreflightFailureAfterMutation(
        admin,
        readerDatabaseConfig,
        async () => { await admin.query(`ALTER ROLE "${readerRole}" IN DATABASE "${testDatabaseName}" SET default_transaction_read_only = 'on'`); },
        async () => { await admin.query(`ALTER ROLE "${readerRole}" IN DATABASE "${testDatabaseName}" RESET default_transaction_read_only`); },
      );
      await assertPreflightFailureAfterMutation(
        admin,
        readerDatabaseConfig,
        async () => { await admin.query(`ALTER ROLE "${readerRole}" IN DATABASE "${testDatabaseName}" SET default_transaction_read_only = 'off'`); },
        async () => { await admin.query(`ALTER ROLE "${readerRole}" IN DATABASE "${testDatabaseName}" RESET default_transaction_read_only`); },
      );
      await assertPreflightFailureAfterMutation(
        admin,
        readerDatabaseConfig,
        async () => { await admin.query(`ALTER ROLE "${readerRole}" SET default_transaction_read_only = 'off'`); },
        async () => { await admin.query(`ALTER ROLE "${readerRole}" SET default_transaction_read_only = 'on'`); },
      );
      await assertPreflightFailureAfterMutation(
        admin,
        readerDatabaseConfig,
        async () => { await admin.query(`GRANT CREATE ON DATABASE "${testDatabaseName}" TO "${readerRole}"`); },
        async () => { await admin.query(`REVOKE CREATE ON DATABASE "${testDatabaseName}" FROM "${readerRole}"`); },
      );
      await assertPreflightFailureAfterMutation(
        admin,
        readerDatabaseConfig,
        async () => { await admin.query(`GRANT CREATE ON SCHEMA public TO "${readerRole}"`); },
        async () => { await admin.query(`REVOKE CREATE ON SCHEMA public FROM "${readerRole}"`); },
      );

      const reader = new Client(readerDatabaseConfig);
      await reader.connect();
      try {
        const report = await runOwnershipInventory(readerAdapter(reader));
        assert.equal(report.ok, true);
        assert.equal(report.snapshot.readOnly, true);
        assert.equal(report.snapshot.isolation, "repeatable_read");
        assert.equal(report.resources.accounts.total, 0);
        assert.equal(report.resources.aiProvider.total, 0);
        assert.deepEqual(report.resources.legacyArtifacts, { removedRelations: 0, removedProviderColumns: 0, removedTriggers: 0 });

        await reader.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        try {
          await assert.rejects(
            () => reader.query("INSERT INTO \"AppUser\" (\"id\", \"username\") VALUES (gen_random_uuid(), 'should-fail')"),
            (error: unknown) => errorCode(error) === "25006" || errorCode(error) === "42501",
          );
        } finally {
          await reader.query("ROLLBACK");
        }
      } finally {
        await reader.end();
      }
    } finally {
      try {
        await removeReaderRole(admin);
      } finally {
        try {
          if (publicAccessSnapshot !== undefined) await restorePublicAccessSnapshot(admin, publicAccessSnapshot);
        } finally {
          await admin.end();
        }
      }
    }
  },
);
