import { randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "pg";

const execFileAsync = promisify(execFile);

const POSTGRES_IMAGE = "pgvector/pgvector:0.8.6-pg18-trixie@sha256:78bf48b801e792f99e3ac62b5036fd3876e9be48afda16c1e331af1c75ceb2ff";
const DATABASE_NAME = "ai_project_os";
const INITDB_ROLE = "ai_project_os";
const CLUSTER_ADMIN_ROLE = "ai_project_os_cluster_admin";
const LEGACY_ROLE = "ai_project_os_legacy_bootstrap";
const MIGRATOR_ROLE = "ai_project_os_migrator";
const RUNTIME_ROLE = "ai_project_os_runtime";
const WRITER_ROLE = "ai_project_os_entitlement_writer";
const REQUIRED_EXTENSIONS = Object.freeze(["vector", "pg_trgm", "pgcrypto", "plpgsql"] as const);
const EXPECTED_MIGRATION_COUNT = 105;
const COMMAND_TIMEOUT_MS = 5 * 60 * 1_000;
const READY_TIMEOUT_MS = 2 * 60 * 1_000;

type CommandResult = Readonly<{ stdout: string; stderr: string; code: number }>;
type GateResources = Readonly<{ container: string; volume: string; network: string }>;
type GateSecrets = Readonly<{
  clusterAdmin: string;
  migrator: string;
  runtime: string;
  writer: string;
  inventory: string;
  legacy: string;
}>;

class GateError extends Error {
  constructor(readonly code: string, readonly stage: string, readonly detail?: string) {
    super(code);
    this.name = "GateError";
  }
}

function fail(code: string, stage: string, detail?: string): never {
  throw new GateError(code, stage, detail);
}

function safeDetail(value: string): string {
  return value
    .replace(/postgres(?:ql)?:\/\/[^\s"']+/gu, "postgresql://[redacted]")
    .replace(/POSTGRES_[A-Z0-9_]+=[^\s]+/gu, "POSTGRES_[REDACTED]=[redacted]")
    .trim()
    .slice(-4_000);
}

function resourceName(kind: string): string {
  const suffix = `${process.pid}-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  return `ai-project-os-oid10-${kind}-${suffix}`;
}

function secret(prefix: string): string {
  return `${prefix}_${randomBytes(24).toString("hex")}`;
}

async function runCommand(
  command: string,
  args: readonly string[],
  stage: string,
  timeoutMs = COMMAND_TIMEOUT_MS,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<CommandResult> {
  try {
    const result = await execFileAsync(command, [...args], {
      cwd: process.cwd(),
      env: environment,
      maxBuffer: 2 * 1024 * 1024,
      timeout: timeoutMs,
      killSignal: "SIGTERM",
    });
    return { stdout: result.stdout, stderr: result.stderr, code: 0 };
  } catch (error) {
    const detail = error instanceof Error
      ? safeDetail(`${error.message}\n${"stdout" in error ? String(error.stdout ?? "") : ""}\n${"stderr" in error ? String(error.stderr ?? "") : ""}`)
      : undefined;
    const code = error !== null && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code ?? "1")
      : "1";
    return { stdout: detail ?? "", stderr: code, code: 1 };
  }
}

async function requireCommand(command: string, args: readonly string[], stage: string, timeoutMs = COMMAND_TIMEOUT_MS): Promise<CommandResult> {
  const result = await runCommand(command, args, stage, timeoutMs);
  if (result.code !== 0) fail(`DATABASE_PRINCIPAL_OID10_${stage.toUpperCase().replaceAll("-", "_")}_FAILED`, stage, safeDetail(`${result.stdout}\n${result.stderr}`));
  return result;
}

async function docker(args: readonly string[], stage: string, timeoutMs = COMMAND_TIMEOUT_MS): Promise<CommandResult> {
  return requireCommand("docker", args, stage, timeoutMs);
}

function connectionUrl(role: string, password: string, port: number): string {
  return `postgresql://${encodeURIComponent(role)}:${encodeURIComponent(password)}@127.0.0.1:${port}/${DATABASE_NAME}`;
}

async function withClient<T>(connectionString: string, operation: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString, connectionTimeoutMillis: 5_000, query_timeout: 30_000 });
  await client.connect();
  try {
    return await operation(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function queryOne<T extends Record<string, unknown>>(connectionString: string, text: string, values: readonly unknown[] = []): Promise<T> {
  return withClient(connectionString, async (client) => {
    const result = await client.query<T>(text, [...values]);
    const row = result.rows[0];
    if (row === undefined) fail("DATABASE_PRINCIPAL_OID10_QUERY_EMPTY", "query");
    return row;
  });
}

async function assertInitialOid10(legacyUrl: string): Promise<void> {
  const row = await queryOne<{
    oid: string;
    rolname: string;
    rolcanlogin: boolean;
    rolsuper: boolean;
  }>(legacyUrl, `
    SELECT oid::text, rolname, rolcanlogin, rolsuper
      FROM pg_authid
     WHERE rolname = $1
  `, [INITDB_ROLE]);
  if (row.oid !== "10" || row.rolname !== INITDB_ROLE || !row.rolcanlogin || !row.rolsuper) {
    fail("DATABASE_PRINCIPAL_OID10_INITDB_ROLE_INVALID", "initial-role");
  }
}

async function createAndAssertInitialOid10Extensions(legacyUrl: string): Promise<void> {
  await withClient(legacyUrl, async (client) => {
    for (const extension of ["vector", "pg_trgm", "pgcrypto"] as const) {
      await client.query(`CREATE EXTENSION IF NOT EXISTS "${extension}" WITH SCHEMA public`);
    }
    const result = await client.query<{
      extname: string;
      schema_name: string;
      owner_oid: string;
    }>(`
      SELECT extension_row.extname,
             namespace.nspname AS schema_name,
             extension_row.extowner::text AS owner_oid
        FROM pg_extension extension_row
        JOIN pg_namespace namespace ON namespace.oid = extension_row.extnamespace
    `);
    const expected = [...REQUIRED_EXTENSIONS].sort();
    const actual = result.rows.map((row) => row.extname).sort();
    if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
      fail("DATABASE_PRINCIPAL_OID10_INITDB_EXTENSION_INVENTORY_INVALID", "initial-extensions");
    }
    if (result.rows.some((row) => row.owner_oid !== "10"
      || row.schema_name !== (row.extname === "plpgsql" ? "pg_catalog" : "public"))) {
      fail("DATABASE_PRINCIPAL_OID10_INITDB_EXTENSION_OWNER_INVALID", "initial-extensions");
    }
  });
}

async function waitForPostgres(container: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await runCommand("docker", ["exec", container, "pg_isready", "-U", INITDB_ROLE, "-d", DATABASE_NAME], "postgres-ready", 10_000);
    if (result.code === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  const status = await runCommand("docker", ["inspect", "--format", "{{.State.Status}}", container], "postgres-status", 10_000);
  const logs = await runCommand("docker", ["logs", "--tail", "80", container], "postgres-logs", 10_000);
  fail("DATABASE_PRINCIPAL_OID10_POSTGRES_NOT_READY", "postgres-ready", safeDetail(`status=${status.stdout}\n${logs.stdout}\n${logs.stderr}`));
}

async function publishedPort(container: string): Promise<number> {
  const result = await docker(["port", container, "5432/tcp"], "postgres-port", 10_000);
  const match = result.stdout.match(/127\.0\.0\.1:(\d+)/u);
  if (match === null) fail("DATABASE_PRINCIPAL_OID10_PORT_INVALID", "postgres-port");
  const port = Number(match[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) fail("DATABASE_PRINCIPAL_OID10_PORT_INVALID", "postgres-port");
  return port;
}

function principalEnvironment(
  urls: Readonly<{ admin: string; runtime: string; writer: string; migrator: string }>,
  inventoryPassword: string,
  legacyUrl?: string,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "test",
    DATABASE_PRINCIPAL_ADMIN_URL: urls.admin,
    DATABASE_URL: urls.runtime,
    ENTITLEMENT_DATABASE_URL: urls.writer,
    MIGRATOR_DATABASE_URL: urls.migrator,
    POSTGRES_ENTITLEMENT_INVENTORY_READER_PASSWORD: inventoryPassword,
  };
  if (legacyUrl === undefined) delete environment.DATABASE_PRINCIPAL_LEGACY_BOOTSTRAP_URL;
  else environment.DATABASE_PRINCIPAL_LEGACY_BOOTSTRAP_URL = legacyUrl;
  return environment;
}

async function runRepositoryCommand(args: readonly string[], stage: string, environment: NodeJS.ProcessEnv): Promise<void> {
  const result = await runCommand(process.execPath, args, stage, COMMAND_TIMEOUT_MS, environment);
  if (result.code !== 0) fail(`DATABASE_PRINCIPAL_OID10_${stage.toUpperCase().replaceAll("-", "_")}_FAILED`, stage, safeDetail(`${result.stdout}\n${result.stderr}`));
}

async function assertSealedLegacyRole(adminUrl: string): Promise<void> {
  const row = await queryOne<{
    oid: string;
    rolcanlogin: boolean;
    rolpassword: string | null;
    rolsuper: boolean;
    rolcreatedb: boolean;
    rolcreaterole: boolean;
    rolinherit: boolean;
    rolreplication: boolean;
    rolbypassrls: boolean;
  }>(adminUrl, `
    SELECT oid::text, rolcanlogin, rolpassword, rolsuper, rolcreatedb, rolcreaterole,
           rolinherit, rolreplication, rolbypassrls
      FROM pg_authid
     WHERE rolname = $1
  `, [LEGACY_ROLE]);
  if (row.oid !== "10" || row.rolcanlogin || row.rolpassword !== null || !row.rolsuper
    || row.rolcreatedb || row.rolcreaterole || row.rolinherit || row.rolreplication || row.rolbypassrls) {
    fail("DATABASE_PRINCIPAL_OID10_SEALED_ROLE_INVALID", "sealed-role");
  }
  const membership = await queryOne<{ count: string }>(adminUrl, `
    SELECT count(*)::text AS count
      FROM pg_auth_members
     WHERE member = (SELECT oid FROM pg_roles WHERE rolname = $1)
        OR roleid = (SELECT oid FROM pg_roles WHERE rolname = $1)
  `, [LEGACY_ROLE]);
  if (membership.count !== "0") fail("DATABASE_PRINCIPAL_OID10_SEALED_MEMBERSHIP_INVALID", "sealed-role");
}

async function assertClusterAdminReachable(adminUrl: string, stage: string): Promise<void> {
  try {
    const row = await queryOne<{ session_user: string; current_user: string; rolsuper: boolean; rolcanlogin: boolean }>(adminUrl, `
      SELECT session_user,
             current_user,
             (SELECT rolsuper FROM pg_roles WHERE rolname = session_user) AS rolsuper,
             (SELECT rolcanlogin FROM pg_roles WHERE rolname = session_user) AS rolcanlogin
    `);
    if (row.session_user !== CLUSTER_ADMIN_ROLE || row.current_user !== CLUSTER_ADMIN_ROLE || !row.rolsuper || !row.rolcanlogin) {
      fail("DATABASE_PRINCIPAL_OID10_CLUSTER_ADMIN_INVALID", stage);
    }
  } catch (error) {
    if (error instanceof GateError) throw error;
    fail("DATABASE_PRINCIPAL_OID10_CLUSTER_ADMIN_UNREACHABLE", stage, safeDetail(error instanceof Error ? error.message : String(error)));
  }
}

async function assertExtensionPolicy(adminUrl: string): Promise<void> {
  const rows = await withClient(adminUrl, async (client) => (await client.query<{
    extname: string;
    schema_name: string;
    owner: string;
    owner_oid: string;
  }>(`
    SELECT extension_row.extname,
           namespace.nspname AS schema_name,
           pg_get_userbyid(extension_row.extowner) AS owner,
           extension_row.extowner::text AS owner_oid
      FROM pg_extension extension_row
      JOIN pg_namespace namespace ON namespace.oid = extension_row.extnamespace
     ORDER BY extension_row.extname
  `)).rows);
  const actual = rows.map((row) => row.extname);
  if (actual.length !== REQUIRED_EXTENSIONS.length || actual.some((value, index) => value !== [...REQUIRED_EXTENSIONS].sort()[index])) {
    fail("DATABASE_PRINCIPAL_OID10_EXTENSION_INVENTORY_INVALID", "extension-policy");
  }
  if (rows.some((row) => {
    const schemaValid = row.schema_name === (row.extname === "plpgsql" ? "pg_catalog" : "public");
    const ownerValid = row.owner === CLUSTER_ADMIN_ROLE || (row.owner === LEGACY_ROLE && row.owner_oid === "10");
    return !schemaValid || !ownerValid;
  }) || !rows.some((row) => row.owner === LEGACY_ROLE && row.owner_oid === "10")) {
    fail("DATABASE_PRINCIPAL_OID10_EXTENSION_OWNER_INVALID", "extension-policy");
  }
  const sharedDependency = await queryOne<{ count: string }>(adminUrl, `
    SELECT count(*)::text AS count
      FROM pg_shdepend dependency
      JOIN pg_extension extension_row ON extension_row.oid = dependency.objid
     WHERE dependency.classid = 'pg_extension'::regclass
       AND dependency.refclassid = 'pg_authid'::regclass
       AND dependency.refobjid = 10
       AND extension_row.extowner = 10
  `);
  if (sharedDependency.count !== "0") fail("DATABASE_PRINCIPAL_OID10_EXTENSION_SHARED_DEPENDENCY_INVALID", "extension-policy");
}

async function assertApplicationOwnership(adminUrl: string): Promise<void> {
  const owner = await queryOne<{ database_owner: string; schema_owner: string }>(adminUrl, `
    SELECT pg_get_userbyid(database_row.datdba) AS database_owner,
           pg_get_userbyid(namespace.nspowner) AS schema_owner
      FROM pg_database database_row
      CROSS JOIN pg_namespace namespace
     WHERE database_row.datname = current_database()
       AND namespace.nspname = 'public'
  `);
  if (owner.database_owner !== MIGRATOR_ROLE || owner.schema_owner !== MIGRATOR_ROLE) {
    fail("DATABASE_PRINCIPAL_OID10_DATABASE_OWNERSHIP_INVALID", "application-ownership");
  }
  const result = await queryOne<{ count: string }>(adminUrl, `
    SELECT count(*)::text AS count
      FROM (
        SELECT pg_get_userbyid(c.relowner) AS owner
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
           AND NOT EXISTS (
             SELECT 1 FROM pg_depend dependency
              WHERE dependency.classid = 'pg_class'::regclass
                AND dependency.objid = c.oid
                AND dependency.refclassid = 'pg_extension'::regclass
                AND dependency.deptype = 'e'
           )
        UNION ALL
        SELECT pg_get_userbyid(p.proowner) AS owner
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND NOT EXISTS (
             SELECT 1 FROM pg_depend dependency
              WHERE dependency.classid = 'pg_proc'::regclass
                AND dependency.objid = p.oid
                AND dependency.refclassid = 'pg_extension'::regclass
                AND dependency.deptype = 'e'
           )
        UNION ALL
        SELECT pg_get_userbyid(t.typowner) AS owner
          FROM pg_type t
          JOIN pg_namespace n ON n.oid = t.typnamespace
         WHERE n.nspname = 'public'
           AND t.typtype IN ('c', 'd', 'e', 'r', 'm')
           AND t.typname NOT LIKE '\\_%'
           AND NOT EXISTS (
             SELECT 1 FROM pg_depend dependency
              WHERE dependency.classid = 'pg_type'::regclass
                AND dependency.objid = t.oid
                AND dependency.refclassid = 'pg_extension'::regclass
                AND dependency.deptype = 'e'
           )
      ) owned
     WHERE owner <> $1
  `, [MIGRATOR_ROLE]);
  if (result.count !== "0") fail("DATABASE_PRINCIPAL_OID10_APPLICATION_OWNERSHIP_INVALID", "application-ownership");
}

async function assertMigrationLedger(adminUrl: string): Promise<void> {
  const ledger = await queryOne<{ total: string; finished: string; rolled_back: string }>(adminUrl, `
    SELECT count(*)::text AS total,
           count(*) FILTER (WHERE finished_at IS NOT NULL)::text AS finished,
           count(*) FILTER (WHERE rolled_back_at IS NOT NULL)::text AS rolled_back
      FROM "_prisma_migrations"
  `);
  if (ledger.total !== String(EXPECTED_MIGRATION_COUNT) || ledger.finished !== ledger.total || ledger.rolled_back !== "0") {
    fail("DATABASE_PRINCIPAL_OID10_MIGRATION_LEDGER_INVALID", "migration-ledger");
  }
}

async function cleanup(resources: GateResources, created: Readonly<{ container: boolean; volume: boolean; network: boolean }>): Promise<void> {
  const errors: string[] = [];
  if (created.container) {
    const result = await runCommand("docker", ["rm", "--force", resources.container], "cleanup-container", 30_000);
    if (result.code !== 0) errors.push("container");
  }
  if (created.volume) {
    const result = await runCommand("docker", ["volume", "rm", resources.volume], "cleanup-volume", 30_000);
    if (result.code !== 0) errors.push("volume");
  }
  if (created.network) {
    const result = await runCommand("docker", ["network", "rm", resources.network], "cleanup-network", 30_000);
    if (result.code !== 0) errors.push("network");
  }
  if (errors.length > 0) throw new Error(`DATABASE_PRINCIPAL_OID10_CLEANUP_FAILED:${errors.join(",")}`);
}

async function main(): Promise<void> {
  const resources: GateResources = Object.freeze({
    container: resourceName("container"),
    volume: resourceName("volume"),
    network: resourceName("network"),
  });
  const secrets: GateSecrets = Object.freeze({
    clusterAdmin: secret("oid10_cluster"),
    migrator: secret("oid10_migrator"),
    runtime: secret("oid10_runtime"),
    writer: secret("oid10_writer"),
    inventory: secret("oid10_inventory"),
    legacy: secret("oid10_legacy"),
  });
  const created = { container: false, volume: false, network: false };
  let primaryError: unknown = null;
  try {
    await docker(["version", "--format", "{{.Server.Version}}"], "docker-version", 30_000);
    await docker(["image", "inspect", POSTGRES_IMAGE, "--format", "{{.Id}}"], "pinned-image", 30_000);
    await docker(["volume", "create", "--label", "ai-project-os.gate=database-principal-oid10", resources.volume], "create-volume", 30_000);
    created.volume = true;
    await docker(["network", "create", "--label", "ai-project-os.gate=database-principal-oid10", resources.network], "create-network", 30_000);
    created.network = true;
    await docker([
      "run", "--detach", "--name", resources.container,
      "--network", resources.network,
      "--network-alias", "postgres",
      "--publish", "127.0.0.1::5432",
      "--mount", `type=volume,source=${resources.volume},destination=/var/lib/postgresql`,
      "--env", `POSTGRES_USER=${INITDB_ROLE}`,
      "--env", `POSTGRES_PASSWORD=${secrets.legacy}`,
      "--env", `POSTGRES_DB=${DATABASE_NAME}`,
      "--label", "ai-project-os.gate=database-principal-oid10",
      POSTGRES_IMAGE,
    ], "create-container", 60_000);
    created.container = true;
    await waitForPostgres(resources.container);
    let port = await publishedPort(resources.container);
    const legacyUrl = connectionUrl(INITDB_ROLE, secrets.legacy, port);
    let adminUrl = connectionUrl(CLUSTER_ADMIN_ROLE, secrets.clusterAdmin, port);
    let migratorUrl = connectionUrl(MIGRATOR_ROLE, secrets.migrator, port);
    let runtimeUrl = connectionUrl(RUNTIME_ROLE, secrets.runtime, port);
    let writerUrl = connectionUrl(WRITER_ROLE, secrets.writer, port);
    let urls = Object.freeze({ admin: adminUrl, runtime: runtimeUrl, writer: writerUrl, migrator: migratorUrl });

    await assertInitialOid10(legacyUrl);
    await createAndAssertInitialOid10Extensions(legacyUrl);
    await runRepositoryCommand(["node_modules/tsx/dist/cli.mjs", "scripts/reconcile-database-principals.ts", "--bootstrap-if-needed"], "principal-bootstrap-initial", principalEnvironment(urls, secrets.inventory, legacyUrl));
    await assertSealedLegacyRole(adminUrl);
    await assertExtensionPolicy(adminUrl);
    await runRepositoryCommand(["node_modules/prisma/build/index.js", "migrate", "deploy", "--config", "prisma.config.ts"], "migrate-initial", { ...principalEnvironment(urls, secrets.inventory), DATABASE_URL: migratorUrl, MIGRATOR_DATABASE_URL: migratorUrl });
    await runRepositoryCommand(["node_modules/prisma/build/index.js", "migrate", "deploy", "--config", "prisma.config.ts"], "migrate-noop-before-retry", { ...principalEnvironment(urls, secrets.inventory), DATABASE_URL: migratorUrl, MIGRATOR_DATABASE_URL: migratorUrl });
    await runRepositoryCommand(["node_modules/tsx/dist/cli.mjs", "scripts/reconcile-database-principals.ts", "--bootstrap-if-needed"], "principal-bootstrap-completed-retry", principalEnvironment(urls, secrets.inventory));
    await runRepositoryCommand(["node_modules/tsx/dist/cli.mjs", "scripts/reconcile-database-principals.ts"], "reconcile-completed-retry", principalEnvironment(urls, secrets.inventory));
    await assertSealedLegacyRole(adminUrl);
    await assertExtensionPolicy(adminUrl);
    await assertApplicationOwnership(adminUrl);
    await assertMigrationLedger(adminUrl);
    await docker(["restart", resources.container], "postgres-restart", 60_000);
    await waitForPostgres(resources.container);
    port = await publishedPort(resources.container);
    adminUrl = connectionUrl(CLUSTER_ADMIN_ROLE, secrets.clusterAdmin, port);
    migratorUrl = connectionUrl(MIGRATOR_ROLE, secrets.migrator, port);
    runtimeUrl = connectionUrl(RUNTIME_ROLE, secrets.runtime, port);
    writerUrl = connectionUrl(WRITER_ROLE, secrets.writer, port);
    urls = Object.freeze({ admin: adminUrl, runtime: runtimeUrl, writer: writerUrl, migrator: migratorUrl });
    await assertClusterAdminReachable(adminUrl, "post-restart-admin");
    await runRepositoryCommand(["node_modules/tsx/dist/cli.mjs", "scripts/reconcile-database-principals.ts", "--bootstrap-if-needed"], "principal-bootstrap-post-restart", principalEnvironment(urls, secrets.inventory));
    await runRepositoryCommand(["node_modules/tsx/dist/cli.mjs", "scripts/reconcile-database-principals.ts"], "reconcile-post-restart", principalEnvironment(urls, secrets.inventory));
    await runRepositoryCommand(["node_modules/prisma/build/index.js", "migrate", "deploy", "--config", "prisma.config.ts"], "migrate-noop-post-restart", { ...principalEnvironment(urls, secrets.inventory), DATABASE_URL: migratorUrl, MIGRATOR_DATABASE_URL: migratorUrl });
    await assertSealedLegacyRole(adminUrl);
    await assertExtensionPolicy(adminUrl);
    await assertApplicationOwnership(adminUrl);
    await assertMigrationLedger(adminUrl);
    console.log(`DATABASE_PRINCIPAL_OID10_GATE_OK image=${POSTGRES_IMAGE} container=${resources.container} migrationLedger=${EXPECTED_MIGRATION_COUNT}`);
  } catch (error) {
    primaryError = error;
  }
  let cleanupError: unknown = null;
  try {
    await cleanup(resources, created);
  } catch (error) {
    cleanupError = error;
  }
  if (primaryError !== null) {
    const detail = primaryError instanceof GateError && primaryError.detail !== undefined ? ` detail=${primaryError.detail}` : "";
    const label = primaryError instanceof GateError ? `${primaryError.code} stage=${primaryError.stage}` : "DATABASE_PRINCIPAL_OID10_GATE_FAILED";
    console.error(`${label}${detail}`);
    if (cleanupError !== null) console.error(`DATABASE_PRINCIPAL_OID10_CLEANUP_FAILED detail=${safeDetail(String(cleanupError))}`);
    process.exitCode = 1;
    return;
  }
  if (cleanupError !== null) {
    console.error(`DATABASE_PRINCIPAL_OID10_CLEANUP_FAILED detail=${safeDetail(String(cleanupError))}`);
    process.exitCode = 1;
  }
}

void main().catch((error: unknown) => {
  console.error(`DATABASE_PRINCIPAL_OID10_GATE_FAILED detail=${safeDetail(error instanceof Error ? error.message : String(error))}`);
  process.exitCode = 1;
});
