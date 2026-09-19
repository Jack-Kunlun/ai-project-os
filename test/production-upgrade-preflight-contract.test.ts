import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import {
  buildProductionUpgradePreflightFailure,
  LEGACY_MIGRATION_MANIFEST,
  PRODUCTION_UPGRADE_PREFLIGHT_APPLICATION_NAME,
  PRODUCTION_UPGRADE_PREFLIGHT_CONNECTION_TIMEOUT_MILLIS,
  PRODUCTION_UPGRADE_PREFLIGHT_LOCK_TIMEOUT_MILLIS,
  PRODUCTION_UPGRADE_PREFLIGHT_QUERY_TIMEOUT_MILLIS,
  PRODUCTION_UPGRADE_CLUSTER_ADMIN_ROLE,
  PRODUCTION_UPGRADE_REQUIRED_EXTENSIONS,
  PRODUCTION_UPGRADE_SEALED_LEGACY_ROLE,
  REQUIRED_LEGACY_SCHEMA,
  PRODUCTION_UPGRADE_SOURCE_VERSION,
  PRODUCTION_UPGRADE_TARGET_TAG,
  parseProductionUpgradePreflightArguments,
  parseProductionUpgradePreflightDatabaseUrl,
  readProductionUpgradePreflightDatabaseCandidates,
  readProductionUpgradePreflightDatabaseConfig,
  readProductionUpgradePreflightLegacyRole,
  safeProductionUpgradePreflightErrorCode,
} from "../scripts/production-upgrade-preflight-contract";
import {
  PRODUCTION_UPGRADE_PREFLIGHT_SQL,
  connectProductionUpgradePreflightClient,
  runProductionUpgradePreflight,
} from "../scripts/production-upgrade-preflight";

const validUrl = "postgresql://legacy_owner:legacy%40password@postgres:5432/ai_project_os";

type FakeState = {
  ledger?: readonly Record<string, unknown>[];
  relations?: readonly Record<string, unknown>[];
  columns?: readonly Record<string, unknown>[];
  enumTypes?: readonly Record<string, unknown>[];
  constraints?: readonly Record<string, unknown>[];
  indexes?: readonly Record<string, unknown>[];
  otherClientBackend?: boolean;
  settings?: Record<string, unknown>;
  databasePrincipalSession?: Record<string, unknown>;
  databasePrincipalRoles?: readonly Record<string, unknown>[];
  databasePrincipalExtensions?: readonly Record<string, unknown>[];
};

function validLedger(): readonly Record<string, unknown>[] {
  return LEGACY_MIGRATION_MANIFEST.map((entry) => ({
    migration_name: entry.name,
    checksum: entry.checksum,
    finished: true,
    rolled_back: false,
    applied_steps_count: 1,
  }));
}

function validRelations(): readonly Record<string, unknown>[] {
  return REQUIRED_LEGACY_SCHEMA.relations
    .map((relation_name) => ({ relation_name, present: true }));
}

function validColumns(): readonly Record<string, unknown>[] {
  return REQUIRED_LEGACY_SCHEMA.columns
    .map(({ relation: relation_name, column: column_name }) => ({ relation_name, column_name, present: true }));
}

function validEnumTypes(): readonly Record<string, unknown>[] {
  return REQUIRED_LEGACY_SCHEMA.enumTypes
    .map(({ type: type_name, labels }) => ({ type_name, labels: [...labels] }));
}

function validConstraints(): readonly Record<string, unknown>[] {
  return REQUIRED_LEGACY_SCHEMA.constraints
    .map(({ relation: relation_name, name: constraint_name, type: constraint_type }) => ({
      relation_name,
      constraint_name,
      constraint_type,
      present: true,
      validated: true,
    }));
}

function validIndexes(): readonly Record<string, unknown>[] {
  return REQUIRED_LEGACY_SCHEMA.indexes
    .map(({ relation: relation_name, name: index_name, unique }) => ({
      relation_name,
      index_name,
      present: true,
      unique,
      valid: true,
      ready: true,
    }));
}

function validDatabasePrincipalSession(): Record<string, unknown> {
  return {
    session_user: PRODUCTION_UPGRADE_CLUSTER_ADMIN_ROLE,
    current_user: PRODUCTION_UPGRADE_CLUSTER_ADMIN_ROLE,
    session_role_oid: "25546",
    session_is_superuser: true,
  };
}

function validDatabasePrincipalRoles(): readonly Record<string, unknown>[] {
  return [{
    role_name: PRODUCTION_UPGRADE_CLUSTER_ADMIN_ROLE,
    role_oid: "25546",
    can_login: true,
    password: "cluster-admin-password",
    is_superuser: true,
    can_create_db: true,
    can_create_role: true,
    inherit: true,
    replication: false,
    bypass_rls: false,
    has_membership: false,
  }];
}

function validDatabasePrincipalExtensions(
  ownerName: string = PRODUCTION_UPGRADE_CLUSTER_ADMIN_ROLE,
  ownerOid: string = "25546",
): readonly Record<string, unknown>[] {
  return PRODUCTION_UPGRADE_REQUIRED_EXTENSIONS.map((extension_name) => ({
    extension_name,
    schema_name: extension_name === "plpgsql" ? "pg_catalog" : "public",
    owner_name: ownerName,
    owner_oid: ownerOid,
  }));
}

function fakeClient(state: FakeState = {}) {
  const calls: string[] = [];
  const client = {
    async query<Row = unknown>(text: string): Promise<{ rows: readonly Row[] }> {
      calls.push(text);
      if (text === PRODUCTION_UPGRADE_PREFLIGHT_SQL.transactionSettings) {
        return {
          rows: [state.settings ?? {
            transaction_read_only: "on",
            transaction_isolation: "repeatable read",
            lock_timeout: "5s",
            statement_timeout: "30s",
          }] as unknown as readonly Row[],
        };
      }
      if (text === PRODUCTION_UPGRADE_PREFLIGHT_SQL.databasePrincipalSession) {
        return { rows: [state.databasePrincipalSession ?? validDatabasePrincipalSession()] as unknown as readonly Row[] };
      }
      if (text === PRODUCTION_UPGRADE_PREFLIGHT_SQL.databasePrincipalRoles) {
        return { rows: (state.databasePrincipalRoles ?? validDatabasePrincipalRoles()) as unknown as readonly Row[] };
      }
      if (text === PRODUCTION_UPGRADE_PREFLIGHT_SQL.databasePrincipalExtensions) {
        return { rows: (state.databasePrincipalExtensions ?? validDatabasePrincipalExtensions()) as unknown as readonly Row[] };
      }
      if (text === PRODUCTION_UPGRADE_PREFLIGHT_SQL.migrationLedger) return { rows: (state.ledger ?? validLedger()) as readonly Row[] };
      if (text === PRODUCTION_UPGRADE_PREFLIGHT_SQL.schemaRelations) return { rows: (state.relations ?? validRelations()) as readonly Row[] };
      if (text === PRODUCTION_UPGRADE_PREFLIGHT_SQL.schemaColumns) return { rows: (state.columns ?? validColumns()) as readonly Row[] };
      if (text === PRODUCTION_UPGRADE_PREFLIGHT_SQL.schemaEnumTypes) return { rows: (state.enumTypes ?? validEnumTypes()) as readonly Row[] };
      if (text === PRODUCTION_UPGRADE_PREFLIGHT_SQL.schemaConstraints) return { rows: (state.constraints ?? validConstraints()) as readonly Row[] };
      if (text === PRODUCTION_UPGRADE_PREFLIGHT_SQL.schemaIndexes) return { rows: (state.indexes ?? validIndexes()) as readonly Row[] };
      if (text === PRODUCTION_UPGRADE_PREFLIGHT_SQL.otherClientBackends) return { rows: [{ other_client_backend: state.otherClientBackend ?? false }] as unknown as readonly Row[] };
      return { rows: [] as readonly Row[] };
    },
  };
  return { client, calls };
}

test("production upgrade preflight has an exact source/target contract and fixed connection limits", () => {
  assert.equal(PRODUCTION_UPGRADE_TARGET_TAG, "v0.4.0-dev.1");
  assert.equal(PRODUCTION_UPGRADE_SOURCE_VERSION, "0.3.0-dev.1");
  assert.equal(LEGACY_MIGRATION_MANIFEST.length, 103);
  assert.equal(new Set(LEGACY_MIGRATION_MANIFEST.map((entry) => entry.name)).size, 103);
  assert.ok(LEGACY_MIGRATION_MANIFEST.every((entry) => /^[0-9a-f]{64}$/u.test(entry.checksum)));
  assert.ok(REQUIRED_LEGACY_SCHEMA.relations.includes("PlatformProviderProbeAttempt"));
  assert.ok(REQUIRED_LEGACY_SCHEMA.columns.some(({ relation, column }) => relation === "PlatformProviderProbeAttempt" && column === "providerConnectionId"));
  assert.ok(REQUIRED_LEGACY_SCHEMA.columns.some(({ relation, column }) => relation === "PlatformDefaultAiRoute" && column === "id"));
  assert.deepEqual(REQUIRED_LEGACY_SCHEMA.enumTypes.find(({ type }) => type === "AiOperation")?.labels, ["embedding", "autoExtract", "sourceSummary", "projectAnalysis", "generateWithContext", "visionExtract"]);
  assert.deepEqual(REQUIRED_LEGACY_SCHEMA.enumTypes.find(({ type }) => type === "PlatformProviderProbeAttemptStatus")?.labels, ["rejected", "reserved", "running", "settled", "released", "held"]);
  assert.deepEqual(REQUIRED_LEGACY_SCHEMA.constraints, [
    { relation: "PlatformProviderProbeAttempt", name: "PlatformProviderProbeAttempt_shape_check", type: "c" },
    { relation: "PlatformProviderProbeAttempt", name: "PlatformProviderProbeAttempt_provider_fkey", type: "f" },
  ]);
  assert.deepEqual(REQUIRED_LEGACY_SCHEMA.indexes, [
    { relation: "PlatformProviderProbeAttempt", name: "PlatformProviderProbeAttempt_providerConnectionId_actorId_clien", unique: true },
  ]);
  assert.equal(Buffer.byteLength(REQUIRED_LEGACY_SCHEMA.indexes[0]?.name ?? "", "utf8"), 63);
  assert.equal(PRODUCTION_UPGRADE_PREFLIGHT_APPLICATION_NAME, "ai-project-os-production-upgrade-preflight");
  assert.equal(PRODUCTION_UPGRADE_PREFLIGHT_CONNECTION_TIMEOUT_MILLIS, 5_000);
  assert.equal(PRODUCTION_UPGRADE_PREFLIGHT_QUERY_TIMEOUT_MILLIS, 30_000);
  assert.equal(PRODUCTION_UPGRADE_PREFLIGHT_LOCK_TIMEOUT_MILLIS, 5_000);
});

test("source migration manifest matches the first 103 migration files byte-for-byte", async () => {
  const migrationRoot = resolve(process.cwd(), "prisma/migrations");
  for (const entry of LEGACY_MIGRATION_MANIFEST) {
    const sql = await readFile(resolve(migrationRoot, entry.name, "migration.sql"));
    assert.equal(createHash("sha256").update(sql).digest("hex"), entry.checksum, entry.name);
  }
});

test("preflight arguments and Compose database URL are strict", () => {
  assert.equal(parseProductionUpgradePreflightArguments(["pre-stop"]), "pre-stop");
  assert.equal(parseProductionUpgradePreflightArguments(["post-stop"]), "post-stop");
  for (const args of [[], ["--write"], ["pre-stop", "extra"], ["during-stop"]]) {
    assert.throws(() => parseProductionUpgradePreflightArguments(args), /PRODUCTION_UPGRADE_PREFLIGHT_ARGUMENTS_INVALID/u);
  }

  assert.deepEqual(parseProductionUpgradePreflightDatabaseUrl(validUrl), {
    host: "postgres",
    port: 5432,
    user: "legacy_owner",
    password: "legacy@password",
    database: "ai_project_os",
    application_name: "ai-project-os-production-upgrade-preflight",
    connectionTimeoutMillis: 5_000,
    query_timeout: 30_000,
    statement_timeout: 30_000,
    ssl: false,
  });
  for (const value of [
    "postgresql://legacy_owner:password@127.0.0.1:5432/ai_project_os",
    "postgresql://legacy_owner:password@postgres:5433/ai_project_os",
    "postgresql://legacy_owner:password@postgres:5432/ai_project_os?sslmode=disable",
    "postgresql://legacy_owner:password@postgres:5432/ai_project_os/extra",
    "postgresql://legacy_owner:password@postgres:5432/ai_project_os#fragment",
    "postgresql://legacy_owner:password@postgres:5432/ai_project_os%2Fextra",
    " postgresql://legacy_owner:password@postgres:5432/ai_project_os",
  ]) assert.throws(() => parseProductionUpgradePreflightDatabaseUrl(value), /PRODUCTION_UPGRADE_PREFLIGHT_DATABASE_URL_INVALID/u);
  assert.throws(() => readProductionUpgradePreflightDatabaseConfig({}), /PRODUCTION_UPGRADE_PREFLIGHT_DATABASE_URL_REQUIRED/u);
  assert.equal(readProductionUpgradePreflightDatabaseConfig({
    PRODUCTION_UPGRADE_PREFLIGHT_DATABASE_URL: "postgresql://cluster_admin:new-password@postgres:5432/ai_project_os",
    DATABASE_PRINCIPAL_LEGACY_BOOTSTRAP_URL: validUrl,
  }).user, "legacy_owner");
  assert.deepEqual(readProductionUpgradePreflightDatabaseCandidates({
    PRODUCTION_UPGRADE_PREFLIGHT_DATABASE_URL: "postgresql://cluster_admin:new-password@postgres:5432/ai_project_os",
    DATABASE_PRINCIPAL_LEGACY_BOOTSTRAP_URL: validUrl,
  }).map((config) => config.user), ["legacy_owner", "cluster_admin"]);
  assert.equal(readProductionUpgradePreflightLegacyRole({
    PRODUCTION_UPGRADE_PREFLIGHT_DATABASE_URL: "postgresql://cluster_admin:new-password@postgres:5432/ai_project_os",
    DATABASE_PRINCIPAL_LEGACY_BOOTSTRAP_URL: validUrl,
  }), "legacy_owner");
  assert.equal(readProductionUpgradePreflightLegacyRole({
    PRODUCTION_UPGRADE_PREFLIGHT_DATABASE_URL: "postgresql://cluster_admin:new-password@postgres:5432/ai_project_os",
    DATABASE_PRINCIPAL_LEGACY_BOOTSTRAP_URL: "",
  }), null);
  assert.equal(readProductionUpgradePreflightDatabaseConfig({
    PRODUCTION_UPGRADE_PREFLIGHT_DATABASE_URL: "postgresql://cluster_admin:new-password@postgres:5432/ai_project_os",
    DATABASE_PRINCIPAL_LEGACY_BOOTSTRAP_URL: "",
  }).user, "cluster_admin");
  assert.throws(() => readProductionUpgradePreflightDatabaseConfig({
    PRODUCTION_UPGRADE_PREFLIGHT_DATABASE_URL: "postgresql://cluster_admin:new-password@postgres:5432/ai_project_os",
    DATABASE_PRINCIPAL_LEGACY_BOOTSTRAP_URL: "postgresql://legacy_owner:old-password@postgres:5432/another_database",
  }), /PRODUCTION_UPGRADE_PREFLIGHT_DATABASE_MISMATCH/u);
  assert.throws(() => readProductionUpgradePreflightDatabaseConfig({
    DATABASE_PRINCIPAL_LEGACY_BOOTSTRAP_URL: validUrl,
  }), /PRODUCTION_UPGRADE_PREFLIGHT_DATABASE_URL_REQUIRED/u);
});

test("preflight connection prefers the explicit legacy source and falls back safely", async () => {
  const configs = readProductionUpgradePreflightDatabaseCandidates({
    PRODUCTION_UPGRADE_PREFLIGHT_DATABASE_URL: "postgresql://cluster_admin:new-password@postgres:5432/ai_project_os",
    DATABASE_PRINCIPAL_LEGACY_BOOTSTRAP_URL: validUrl,
  });
  const attempts: string[] = [];
  const ended: string[] = [];
  const makeClient = (config: (typeof configs)[number], fail: boolean) => ({
    async connect(): Promise<void> {
      attempts.push(config.user);
      if (fail) throw new Error("connection details are redacted");
    },
    async end(): Promise<void> {
      ended.push(config.user);
    },
    async query<Row = unknown>(): Promise<{ rows: readonly Row[] }> {
      return { rows: [] };
    },
  });

  const firstRunClient = await connectProductionUpgradePreflightClient(configs, (config) => makeClient(config, false));
  assert.equal(attempts.join(","), "legacy_owner");
  assert.equal(ended.length, 0);
  await firstRunClient.end();

  attempts.length = 0;
  ended.length = 0;
  const fallbackClient = await connectProductionUpgradePreflightClient(configs, (config) => makeClient(config, config.user === "legacy_owner"));
  assert.equal(attempts.join(","), "legacy_owner,cluster_admin");
  assert.deepEqual(ended, ["legacy_owner"]);
  await fallbackClient.end();

  attempts.length = 0;
  await assert.rejects(
    () => connectProductionUpgradePreflightClient(configs, (config) => makeClient(config, true)),
    (error: unknown) => safeProductionUpgradePreflightErrorCode(error) === "PRODUCTION_UPGRADE_PREFLIGHT_DATABASE_CONNECT_FAILED",
  );
  assert.equal(attempts.join(","), "legacy_owner,cluster_admin");
});

test("pre-stop and post-stop preflight are read-only, fixed-query, and rollback-only", async () => {
  for (const phase of ["pre-stop", "post-stop"] as const) {
    const { client, calls } = fakeClient();
    const report = await runProductionUpgradePreflight(client, phase);
    assert.equal(report.ok, true);
    assert.equal(report.phase, phase);
    assert.equal(report.checks.databasePrincipal, "cluster-admin-owned");
    assert.equal(report.checks.rollback, "verified");
    assert.equal(calls[0], PRODUCTION_UPGRADE_PREFLIGHT_SQL.begin);
    assert.equal(calls.filter((call) => call === PRODUCTION_UPGRADE_PREFLIGHT_SQL.rollback).length, 1);
    assert.ok(!calls.some((call) => /(?:^|\n)\s*(?:INSERT|UPDATE|DELETE|TRUNCATE|CREATE|ALTER|DROP|COMMIT)\b/iu.test(call)));
    if (phase === "pre-stop") {
      assert.equal(calls.at(-1), PRODUCTION_UPGRADE_PREFLIGHT_SQL.rollback);
      assert.equal(calls.includes(PRODUCTION_UPGRADE_PREFLIGHT_SQL.otherClientBackends), false);
    } else {
      assert.equal(calls.at(-2), PRODUCTION_UPGRADE_PREFLIGHT_SQL.rollback);
      assert.equal(calls.at(-1), PRODUCTION_UPGRADE_PREFLIGHT_SQL.otherClientBackends);
    }
  }
});

test("every ledger integrity failure fails closed and rolls back", async () => {
  const ledgerFailures = [
    [],
    [...validLedger().slice(1)],
    [...validLedger(), { ...validLedger()[0] }],
    validLedger().map((row, index) => index === 0 ? { ...row, checksum: "0".repeat(64) } : row),
    validLedger().map((row, index) => index === 0 ? { ...row, finished: false } : row),
    validLedger().map((row, index) => index === 0 ? { ...row, rolled_back: true } : row),
    validLedger().map((row, index) => index === 0 ? { ...row, applied_steps_count: 0 } : row),
    validLedger().map((row, index) => index === 0 ? { ...row, applied_steps_count: undefined } : row),
  ];
  for (const ledger of ledgerFailures) {
    const { client, calls } = fakeClient({ ledger });
    await assert.rejects(() => runProductionUpgradePreflight(client, "pre-stop"), /PRODUCTION_UPGRADE_PREFLIGHT_MIGRATION_LEDGER_INVALID/u);
    assert.equal(calls.at(-1), PRODUCTION_UPGRADE_PREFLIGHT_SQL.rollback);
  }
});

test("database-principal preflight accepts supported owners and rejects unsafe extension or role states", async () => {
  const clusterAdminReport = await runProductionUpgradePreflight(fakeClient().client, "pre-stop");
  assert.equal(clusterAdminReport.checks.databasePrincipal, "cluster-admin-owned");

  const oid10ClusterAdminReport = await runProductionUpgradePreflight(fakeClient({
    databasePrincipalSession: {
      session_user: PRODUCTION_UPGRADE_CLUSTER_ADMIN_ROLE,
      current_user: PRODUCTION_UPGRADE_CLUSTER_ADMIN_ROLE,
      session_role_oid: "10",
      session_is_superuser: true,
    },
    databasePrincipalRoles: validDatabasePrincipalRoles().map((row) => ({ ...row, role_oid: "10" })),
    databasePrincipalExtensions: validDatabasePrincipalExtensions(PRODUCTION_UPGRADE_CLUSTER_ADMIN_ROLE, "10"),
  }).client, "pre-stop");
  assert.equal(oid10ClusterAdminReport.checks.databasePrincipal, "cluster-admin-owned");

  const activeLegacyRoles = [
    ...validDatabasePrincipalRoles(),
    {
      role_name: "legacy_owner",
      role_oid: "10",
      can_login: true,
      password: "legacy-password",
      is_superuser: true,
      can_create_db: true,
      can_create_role: true,
      inherit: true,
      replication: false,
      bypass_rls: false,
      has_membership: false,
    },
  ];
  const activeLegacyExtensions = validDatabasePrincipalExtensions().map((row, index) => index === 0
    ? { ...row, owner_name: "legacy_owner", owner_oid: "10" }
    : row);
  const activeLegacyReport = await runProductionUpgradePreflight(fakeClient({
    databasePrincipalRoles: activeLegacyRoles,
    databasePrincipalExtensions: activeLegacyExtensions,
  }).client, "pre-stop", { legacyRole: "legacy_owner" });
  assert.equal(activeLegacyReport.checks.databasePrincipal, "pinned-oid10-extension-owners-supported");

  const firstRunLegacyReport = await runProductionUpgradePreflight(fakeClient({
    databasePrincipalSession: {
      session_user: "legacy_owner",
      current_user: "legacy_owner",
      session_role_oid: "10",
      session_is_superuser: true,
    },
    databasePrincipalRoles: [activeLegacyRoles[1]],
    databasePrincipalExtensions: validDatabasePrincipalExtensions("legacy_owner", "10"),
  }).client, "pre-stop", { legacyRole: "legacy_owner" });
  assert.equal(firstRunLegacyReport.checks.databasePrincipal, "pinned-oid10-extension-owners-supported");

  const noLoginLegacyReport = await runProductionUpgradePreflight(fakeClient({
    databasePrincipalRoles: activeLegacyRoles.map((row) => row.role_name === "legacy_owner"
      ? { ...row, can_login: false }
      : row),
    databasePrincipalExtensions: activeLegacyExtensions,
  }).client, "pre-stop", { legacyRole: "legacy_owner" });
  assert.equal(noLoginLegacyReport.checks.databasePrincipal, "pinned-oid10-extension-owners-supported");

  const ordinaryLegacyRoles = activeLegacyRoles.map((row) => row.role_name === "legacy_owner"
    ? { ...row, role_oid: "16384", can_login: true }
    : row);
  const ordinaryLegacyExtensions = activeLegacyExtensions.map((row, index) => index === 0
    ? { ...row, owner_oid: "16384" }
    : row);
  const ordinaryLegacyReport = await runProductionUpgradePreflight(fakeClient({
    databasePrincipalRoles: ordinaryLegacyRoles,
    databasePrincipalExtensions: ordinaryLegacyExtensions,
  }).client, "pre-stop", { legacyRole: "legacy_owner" });
  assert.equal(ordinaryLegacyReport.checks.databasePrincipal, "legacy-extension-owners-reassignable");

  const sealedLegacyRoles = [
    ...validDatabasePrincipalRoles(),
    {
      role_name: PRODUCTION_UPGRADE_SEALED_LEGACY_ROLE,
      role_oid: "10",
      can_login: false,
      password: null,
      is_superuser: true,
      can_create_db: false,
      can_create_role: false,
      inherit: false,
      replication: false,
      bypass_rls: false,
      has_membership: false,
    },
  ];
  const sealedLegacyExtensions = validDatabasePrincipalExtensions().map((row, index) => index === 1
    ? { ...row, owner_name: PRODUCTION_UPGRADE_SEALED_LEGACY_ROLE, owner_oid: "10" }
    : row);
  const sealedLegacyReport = await runProductionUpgradePreflight(fakeClient({
    databasePrincipalRoles: sealedLegacyRoles,
    databasePrincipalExtensions: sealedLegacyExtensions,
  }).client, "post-stop");
  assert.equal(sealedLegacyReport.checks.databasePrincipal, "pinned-oid10-extension-owners-supported");

  const rejectedStates: FakeState[] = [
    {
      databasePrincipalExtensions: validDatabasePrincipalExtensions().map((row, index) => index === 0
        ? { ...row, owner_name: "arbitrary_owner", owner_oid: "10" }
        : row),
    },
    {
      databasePrincipalRoles: activeLegacyRoles,
      databasePrincipalExtensions: activeLegacyExtensions.map((row, index) => index === 0
        ? { ...row, owner_name: "legacy_owner", owner_oid: "999" }
        : row),
    },
    {
      databasePrincipalExtensions: validDatabasePrincipalExtensions().map((row, index) => index === 0
        ? { ...row, schema_name: "pg_catalog" }
        : row),
    },
    {
      databasePrincipalRoles: activeLegacyRoles.map((row) => row.role_name === "legacy_owner"
        ? { ...row, has_membership: true }
        : row),
      databasePrincipalExtensions: activeLegacyExtensions,
    },
    {
      databasePrincipalRoles: sealedLegacyRoles.map((row) => row.role_name === PRODUCTION_UPGRADE_SEALED_LEGACY_ROLE
        ? { ...row, password: "unexpected-password" }
        : row),
      databasePrincipalExtensions: sealedLegacyExtensions,
    },
    {
      databasePrincipalExtensions: [
        ...validDatabasePrincipalExtensions(),
        { extension_name: "hstore", schema_name: "public", owner_name: PRODUCTION_UPGRADE_CLUSTER_ADMIN_ROLE, owner_oid: "25546" },
      ],
    },
  ];
  for (const state of rejectedStates) {
    const { client, calls } = fakeClient(state);
    await assert.rejects(
      () => runProductionUpgradePreflight(client, "pre-stop", {
        legacyRole: state.databasePrincipalRoles?.some((row) => row.role_name === "legacy_owner") ? "legacy_owner" : null,
      }),
      /PRODUCTION_UPGRADE_PREFLIGHT_DATABASE_PRINCIPAL_INVALID/u,
    );
    assert.equal(calls.at(-1), PRODUCTION_UPGRADE_PREFLIGHT_SQL.rollback);
  }
});

test("schema, client-backend, transaction, and rollback failures are safe", async () => {
  const { client: schemaClient } = fakeClient({ relations: validRelations().map((row, index) => index === 0 ? { ...row, present: false } : row) });
  await assert.rejects(() => runProductionUpgradePreflight(schemaClient, "pre-stop"), /PRODUCTION_UPGRADE_PREFLIGHT_SCHEMA_INVALID/u);

  const missingProbeDependency = fakeClient({
    columns: validColumns().map((row) => row.relation_name === "PlatformProviderProbeAttempt" && row.column_name === "providerConnectionId"
      ? { ...row, present: false }
      : row),
  });
  await assert.rejects(() => runProductionUpgradePreflight(missingProbeDependency.client, "pre-stop"), /PRODUCTION_UPGRADE_PREFLIGHT_SCHEMA_INVALID/u);
  assert.equal(missingProbeDependency.calls.includes(PRODUCTION_UPGRADE_PREFLIGHT_SQL.rollback), true);

  const driftedProbeEnum = fakeClient({
    enumTypes: validEnumTypes().map((row) => row.type_name === "PlatformProviderProbeAttemptStatus"
      ? { ...row, labels: ["rejected", "reserved", "running", "settled", "released"] }
      : row),
  });
  await assert.rejects(() => runProductionUpgradePreflight(driftedProbeEnum.client, "pre-stop"), /PRODUCTION_UPGRADE_PREFLIGHT_SCHEMA_INVALID/u);
  assert.equal(driftedProbeEnum.calls.includes(PRODUCTION_UPGRADE_PREFLIGHT_SQL.rollback), true);

  const missingProbeConstraint = fakeClient({
    constraints: validConstraints().map((row) => row.constraint_name === "PlatformProviderProbeAttempt_shape_check"
      ? { ...row, present: false }
      : row),
  });
  await assert.rejects(() => runProductionUpgradePreflight(missingProbeConstraint.client, "pre-stop"), /PRODUCTION_UPGRADE_PREFLIGHT_SCHEMA_INVALID/u);
  assert.equal(missingProbeConstraint.calls.includes(PRODUCTION_UPGRADE_PREFLIGHT_SQL.rollback), true);

  const unvalidatedProbeConstraint = fakeClient({
    constraints: validConstraints().map((row) => row.constraint_name === "PlatformProviderProbeAttempt_provider_fkey"
      ? { ...row, validated: false }
      : row),
  });
  await assert.rejects(() => runProductionUpgradePreflight(unvalidatedProbeConstraint.client, "pre-stop"), /PRODUCTION_UPGRADE_PREFLIGHT_SCHEMA_INVALID/u);
  assert.equal(unvalidatedProbeConstraint.calls.includes(PRODUCTION_UPGRADE_PREFLIGHT_SQL.rollback), true);

  const nonUniqueProbeIndex = fakeClient({
    indexes: validIndexes().map((row) => ({ ...row, unique: false })),
  });
  await assert.rejects(() => runProductionUpgradePreflight(nonUniqueProbeIndex.client, "pre-stop"), /PRODUCTION_UPGRADE_PREFLIGHT_SCHEMA_INVALID/u);
  assert.equal(nonUniqueProbeIndex.calls.includes(PRODUCTION_UPGRADE_PREFLIGHT_SQL.rollback), true);

  const { client: backendClient } = fakeClient({ otherClientBackend: true });
  await assert.rejects(() => runProductionUpgradePreflight(backendClient, "post-stop"), /PRODUCTION_UPGRADE_PREFLIGHT_CLIENT_BACKENDS_PRESENT/u);

  const { client: settingsClient } = fakeClient({ settings: { transaction_read_only: "off", transaction_isolation: "repeatable read", lock_timeout: "5s", statement_timeout: "30s" } });
  await assert.rejects(() => runProductionUpgradePreflight(settingsClient, "pre-stop"), /PRODUCTION_UPGRADE_PREFLIGHT_TRANSACTION_INVALID/u);

  const rollbackCalls: string[] = [];
  const rollbackClient = {
    async query<Row = unknown>(text: string): Promise<{ rows: readonly Row[] }> {
      rollbackCalls.push(text);
      if (text === PRODUCTION_UPGRADE_PREFLIGHT_SQL.rollback) throw new Error("rollback secret DSN");
      throw new Error("query secret SQL");
    },
  };
  await assert.rejects(() => runProductionUpgradePreflight(rollbackClient, "pre-stop"), /PRODUCTION_UPGRADE_PREFLIGHT_QUERY_FAILED/u);
  assert.equal(rollbackCalls.at(-1), PRODUCTION_UPGRADE_PREFLIGHT_SQL.rollback);
  assert.deepEqual(buildProductionUpgradePreflightFailure(new Error("postgres://secret")), {
    ok: false,
    error: { code: "PRODUCTION_UPGRADE_PREFLIGHT_FAILED" },
  });
});

test("preflight implementation stays read-only and does not expose sensitive diagnostics", async () => {
  const source = await readFile(resolve(process.cwd(), "scripts/production-upgrade-preflight.ts"), "utf8");
  assert.doesNotMatch(source, /SELECT\s+\*/iu);
  assert.doesNotMatch(source, /(?:^|\n)\s*(?:INSERT|UPDATE|DELETE|TRUNCATE|CREATE|ALTER|DROP|COMMIT)\b/iu);
  assert.doesNotMatch(source, /pg_shdepend/iu);
  assert.match(source, /finally[\s\S]*PRODUCTION_UPGRADE_PREFLIGHT_SQL\.rollback/u);
  assert.match(PRODUCTION_UPGRADE_PREFLIGHT_SQL.databasePrincipalRoles, /pg_authid/u);
  assert.match(PRODUCTION_UPGRADE_PREFLIGHT_SQL.databasePrincipalExtensions, /pg_extension/u);
  assert.match(PRODUCTION_UPGRADE_PREFLIGHT_SQL.otherClientBackends, /datname = pg_catalog\.current_database\(\)/u);
  assert.match(PRODUCTION_UPGRADE_PREFLIGHT_SQL.schemaEnumTypes, /array_agg\(enum_meta\.enumlabel::text ORDER BY enum_meta\.enumsortorder\)/u);
  assert.match(source, /buildProductionUpgradePreflightFailure/u);
  assert.doesNotMatch(source, /console\.(error|warn).*?(password|database|url|sql|error)/iu);
});
