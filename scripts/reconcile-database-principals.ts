import "dotenv/config";
import { Client } from "pg";
import {
  DATABASE_PRINCIPAL_RELATIONS,
  ENTITLEMENT_PROTECTED_RELATIONS,
  runtimeMutableRelations,
  SIGNUP_GRANT_RELATION,
  TOKEN_LEDGER_RELATION,
} from "../src/lib/database-principal-catalog";
import {
  ENTITLEMENT_WRITER_DATABASE_PRINCIPAL,
  MIGRATOR_DATABASE_PRINCIPAL,
  RUNTIME_DATABASE_PRINCIPAL,
} from "../src/lib/db";

const MIGRATOR_DATABASE_URL_ENV = "MIGRATOR_DATABASE_URL" as const;
const RUNTIME_DATABASE_URL_ENV = "DATABASE_URL" as const;
const WRITER_DATABASE_URL_ENV = "ENTITLEMENT_DATABASE_URL" as const;
const ADMIN_DATABASE_URL_ENV = "DATABASE_PRINCIPAL_ADMIN_URL" as const;
const LEGACY_DATABASE_URL_ENV = "DATABASE_PRINCIPAL_LEGACY_BOOTSTRAP_URL" as const;
const CLUSTER_ADMIN_DATABASE_PRINCIPAL = "ai_project_os_cluster_admin" as const;
const LEGACY_BOOTSTRAP_DATABASE_PRINCIPAL = "ai_project_os_legacy_bootstrap" as const;
const INVENTORY_READER_DATABASE_PRINCIPAL = "ai_project_os_entitlement_inventory_reader" as const;
const INVENTORY_READER_PASSWORD_ENV = "POSTGRES_ENTITLEMENT_INVENTORY_READER_PASSWORD" as const;
const INVENTORY_READER_RELATIONS = Object.freeze(["AccountEntitlementActivation", "AccountEntitlementBackfillRun", "AccountEntitlementBackfillItem", "PlatformTokenGrant"] as const);
const INVENTORY_AGGREGATE_FUNCTION = "account_entitlement_inventory_counts" as const;
const REQUIRED_EXTENSIONS = Object.freeze(["vector", "pg_trgm", "pgcrypto", "plpgsql"] as const);
const FIRST_NORMAL_OBJECT_ID = 16384 as const;
const DATABASE_PRINCIPAL_LOCK_KEY = "ai-project-os:database-principals";

class DatabasePrincipalError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "DatabasePrincipalError";
  }
}

function fail(code: string): never {
  throw new DatabasePrincipalError(code);
}

function requiredUrl(name: string): URL {
  const raw = process.env[name];
  if (typeof raw !== "string" || raw.length === 0) return fail(`${name}_REQUIRED`);
  let value: URL;
  try {
    value = new URL(raw);
  } catch {
    return fail(`${name}_INVALID`);
  }
  if (value.protocol !== "postgres:" && value.protocol !== "postgresql:") return fail(`${name}_INVALID`);
  if (value.username.length === 0 || value.password.length === 0 || value.search !== "" || value.hash !== "") return fail(`${name}_INVALID`);
  try {
    decodeURIComponent(value.username);
    decodeURIComponent(value.password);
  } catch {
    return fail(`${name}_INVALID`);
  }
  return value;
}

function optionalUrl(name: string): URL | null {
  const raw = process.env[name];
  return raw === undefined || raw.length === 0 ? null : requiredUrl(name);
}

function quoteIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) return fail("DATABASE_PRINCIPAL_IDENTIFIER_INVALID");
  return `"${value}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function relationIdentifier(relation: string): string {
  if (!(DATABASE_PRINCIPAL_RELATIONS as readonly string[]).includes(relation)) return fail("DATABASE_PRINCIPAL_RELATION_NOT_CATALOGUED");
  return quoteIdentifier(relation);
}

function rolePassword(url: URL): string {
  return decodeURIComponent(url.password);
}

function requiredSecret(name: string): string {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0) return fail(`${name}_REQUIRED`);
  return value;
}

function roleUsername(url: URL): string {
  return decodeURIComponent(url.username);
}

function assertSameDatabase(urls: readonly URL[]): void {
  const signatures = new Set(urls.map((url) => {
    const port = url.port || "5432";
    return `postgresql://${url.hostname.toLowerCase()}:${port}${url.pathname}`;
  }));
  if (signatures.size !== 1 || urls[0]?.pathname === "/") return fail("DATABASE_PRINCIPAL_DATABASE_MISMATCH");
}

type SessionPrincipal = Readonly<{
  oid: string;
  session_user: string;
  current_user: string;
  rolcanlogin: boolean;
  is_superuser: boolean;
  can_create_role: boolean;
  rolreplication: boolean;
  database_owner: string;
}>;

async function readSessionPrincipal(client: Client): Promise<SessionPrincipal> {
  const result = await client.query<SessionPrincipal>(`
    SELECT (SELECT oid::text FROM pg_roles WHERE rolname = session_user) AS oid,
           session_user,
           current_user,
           (SELECT rolcanlogin FROM pg_roles WHERE rolname = session_user) AS rolcanlogin,
           (SELECT rolsuper FROM pg_roles WHERE rolname = session_user) AS is_superuser,
           (SELECT rolcreaterole FROM pg_roles WHERE rolname = session_user) AS can_create_role,
           (SELECT rolreplication FROM pg_roles WHERE rolname = session_user) AS rolreplication,
           pg_get_userbyid((SELECT datdba FROM pg_database WHERE datname = current_database())) AS database_owner
  `);
  const row = result.rows[0];
  if (row === undefined) return fail("DATABASE_PRINCIPAL_SESSION_INVALID");
  return row;
}

async function verifyMigratorSession(client: Client, failureCode = "DATABASE_PRINCIPAL_MIGRATOR_SESSION_INVALID"): Promise<SessionPrincipal> {
  const row = await readSessionPrincipal(client);
  if (row.session_user !== MIGRATOR_DATABASE_PRINCIPAL
    || row.current_user !== MIGRATOR_DATABASE_PRINCIPAL
    || row.database_owner !== MIGRATOR_DATABASE_PRINCIPAL) {
    return fail(failureCode);
  }
  return row;
}

async function assertClusterAdminSession(client: Client): Promise<SessionPrincipal> {
  const row = await readSessionPrincipal(client);
  if (row.session_user !== CLUSTER_ADMIN_DATABASE_PRINCIPAL
    || row.current_user !== CLUSTER_ADMIN_DATABASE_PRINCIPAL
    || !row.is_superuser
    || !row.rolcanlogin) {
    return fail("DATABASE_PRINCIPAL_ADMIN_SESSION_INVALID");
  }
  return row;
}

async function lockCoordinator(client: Client): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [DATABASE_PRINCIPAL_LOCK_KEY]);
}

async function ensureRole(client: Client, role: string, password: string, login: boolean): Promise<void> {
  const identifier = quoteIdentifier(role);
  await client.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${quoteLiteral(role)}) THEN CREATE ROLE ${identifier} ${login ? "LOGIN" : "NOLOGIN"} PASSWORD ${quoteLiteral(password)}; END IF; END $$`);
  await client.query(`ALTER ROLE ${identifier} WITH ${login ? "LOGIN" : "NOLOGIN"} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD ${quoteLiteral(password)}`);
}

async function ensureClusterAdmin(client: Client, password: string): Promise<void> {
  const identifier = quoteIdentifier(CLUSTER_ADMIN_DATABASE_PRINCIPAL);
  await client.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${quoteLiteral(CLUSTER_ADMIN_DATABASE_PRINCIPAL)}) THEN CREATE ROLE ${identifier} LOGIN SUPERUSER CREATEDB CREATEROLE PASSWORD ${quoteLiteral(password)}; END IF; END $$`);
  await client.query(`ALTER ROLE ${identifier} WITH LOGIN SUPERUSER CREATEDB CREATEROLE INHERIT NOREPLICATION NOBYPASSRLS PASSWORD ${quoteLiteral(password)}`);
}

async function ensureInventoryReader(client: Client, password: string): Promise<void> {
  // Keep the maintenance reader sealed while ACLs/defaults are being
  // normalized.  It is opened only after the terminal reconcile assertions.
  await ensureRole(client, INVENTORY_READER_DATABASE_PRINCIPAL, password, false);
  const database = await client.query<{ datname: string }>("SELECT current_database() AS datname");
  const databaseName = database.rows[0]?.datname;
  if (databaseName === undefined) return fail("DATABASE_PRINCIPAL_DATABASE_NOT_FOUND");
  await client.query(`ALTER ROLE ${quoteIdentifier(INVENTORY_READER_DATABASE_PRINCIPAL)} SET default_transaction_read_only = on`);
  await client.query(`ALTER ROLE ${quoteIdentifier(INVENTORY_READER_DATABASE_PRINCIPAL)} IN DATABASE ${quoteIdentifier(databaseName)} RESET ALL`);
}

async function revokePublicDdl(client: Client, databaseName: string): Promise<void> {
  // PUBLIC's built-in database TEMPORARY privilege must be removed before the
  // sealed inventory reader is verified; direct reader ACL revocation alone
  // cannot remove inherited PUBLIC privileges.
  await client.query(`REVOKE CREATE, TEMPORARY ON DATABASE ${quoteIdentifier(databaseName)} FROM PUBLIC`);
  await client.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
}

async function grantInventoryReader(client: Client, requireAll = false): Promise<void> {
  const database = await client.query<{ datname: string }>("SELECT current_database() AS datname");
  const databaseName = database.rows[0]?.datname;
  if (databaseName === undefined) return fail("DATABASE_PRINCIPAL_DATABASE_NOT_FOUND");
  await revokePublicDdl(client, databaseName);
  await client.query(`REVOKE ALL ON DATABASE ${quoteIdentifier(databaseName)} FROM ${quoteIdentifier(INVENTORY_READER_DATABASE_PRINCIPAL)}`);
  await client.query(`GRANT CONNECT ON DATABASE ${quoteIdentifier(databaseName)} TO ${quoteIdentifier(INVENTORY_READER_DATABASE_PRINCIPAL)}`);
  await client.query(`REVOKE ALL ON SCHEMA public FROM ${quoteIdentifier(INVENTORY_READER_DATABASE_PRINCIPAL)}`);
  await client.query(`GRANT USAGE ON SCHEMA public TO ${quoteIdentifier(INVENTORY_READER_DATABASE_PRINCIPAL)}`);
  for (const relation of INVENTORY_READER_RELATIONS) {
    const quoted = relationIdentifier(relation);
    const exists = await client.query<{ exists: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = $1
      ) AS exists
    `, [relation]);
    if (exists.rows[0]?.exists !== true) {
      if (requireAll) return fail("DATABASE_PRINCIPAL_INVENTORY_RELATION_MISSING");
      continue;
    }
    await client.query(`REVOKE ALL ON TABLE public.${quoted} FROM ${quoteIdentifier(INVENTORY_READER_DATABASE_PRINCIPAL)}`);
  }
}

async function ensureInventoryAggregateFunction(client: Client): Promise<void> {
  const functionIdentifier = quoteIdentifier(INVENTORY_AGGREGATE_FUNCTION);
  await client.query(`
    CREATE OR REPLACE FUNCTION public.${functionIdentifier}()
    RETURNS TABLE (eligible bigint, issued bigint, ambiguous bigint, missing bigint)
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path = pg_catalog, public
    AS $inventory$
      WITH latest_run AS (
        SELECT "id" FROM public."AccountEntitlementBackfillRun"
        ORDER BY "createdAt" DESC, "id" DESC LIMIT 1
      ),
      item_counts AS (
        SELECT
          COUNT(*) FILTER (WHERE "classification" IN ('eligible_missing', 'already_issued'))::bigint AS eligible,
          COUNT(*) FILTER (WHERE "classification" = 'eligible_missing' AND "status" = 'pending')::bigint AS missing,
          COUNT(*) FILTER (WHERE "classification" = 'legacy_ambiguous')::bigint AS ambiguous
        FROM public."AccountEntitlementBackfillItem" item
        WHERE item."runId" = (SELECT "id" FROM latest_run)
      ),
      issued_counts AS (
        SELECT COUNT(DISTINCT "userId")::bigint AS issued
        FROM public."PlatformTokenGrant"
        WHERE "kind" = 'signup'
      )
      SELECT item_counts.eligible, issued_counts.issued, item_counts.ambiguous, item_counts.missing
        FROM item_counts CROSS JOIN issued_counts
    $inventory$;
  `);
  await client.query(`ALTER FUNCTION public.${functionIdentifier}() OWNER TO ${quoteIdentifier(MIGRATOR_DATABASE_PRINCIPAL)}`);
  await client.query(`REVOKE ALL ON FUNCTION public.${functionIdentifier}() FROM PUBLIC, ${quoteIdentifier(INVENTORY_READER_DATABASE_PRINCIPAL)}`);
  await client.query(`GRANT EXECUTE ON FUNCTION public.${functionIdentifier}() TO ${quoteIdentifier(INVENTORY_READER_DATABASE_PRINCIPAL)}`);
}

async function assertInventoryReader(client: Client, requireAggregate = false, expectedLogin = true): Promise<void> {
  const role = await client.query<{ can_login: boolean; superuser: boolean; createdb: boolean; createrole: boolean; inherit: boolean; replication: boolean; bypassrls: boolean }>(`
    SELECT rolcanlogin AS can_login, rolsuper AS superuser, rolcreatedb AS createdb, rolcreaterole AS createrole,
           rolinherit AS inherit, rolreplication AS replication, rolbypassrls AS bypassrls
      FROM pg_roles WHERE rolname = $1
  `, [INVENTORY_READER_DATABASE_PRINCIPAL]);
  const row = role.rows[0];
  if (row === undefined || row.can_login !== expectedLogin || row.superuser || row.createdb || row.createrole || row.inherit || row.replication || row.bypassrls) return fail("DATABASE_PRINCIPAL_INVENTORY_READER_ATTRIBUTES_INVALID");
  const settings = await client.query<{ global: boolean; target: boolean }>(`
    SELECT EXISTS (SELECT 1 FROM pg_roles r, unnest(COALESCE(r.rolconfig, ARRAY[]::text[])) config(value)
                    WHERE r.rolname = $1 AND split_part(config.value, '=', 1) = 'default_transaction_read_only'
                      AND lower(split_part(config.value, '=', 2)) IN ('on', 'true', '1')) AS global,
           EXISTS (SELECT 1 FROM pg_db_role_setting s WHERE s.setrole = (SELECT oid FROM pg_roles WHERE rolname = $1)
                    AND s.setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database())) AS target
  `, [INVENTORY_READER_DATABASE_PRINCIPAL]);
  if (settings.rows[0]?.global !== true || settings.rows[0]?.target === true) return fail("DATABASE_PRINCIPAL_INVENTORY_READER_SETTINGS_INVALID");
  await assertNoRoleMembership(client, INVENTORY_READER_DATABASE_PRINCIPAL);
  const direct = await client.query<{ database_create: boolean; database_temp: boolean; schema_create: boolean }>(`
    SELECT has_database_privilege($1, current_database(), 'CREATE') AS database_create,
           has_database_privilege($1, current_database(), 'TEMPORARY') AS database_temp,
           has_schema_privilege($1, 'public', 'CREATE') AS schema_create
  `, [INVENTORY_READER_DATABASE_PRINCIPAL]);
  if (direct.rows[0]?.database_create || direct.rows[0]?.database_temp || direct.rows[0]?.schema_create) return fail("DATABASE_PRINCIPAL_INVENTORY_READER_ACL_INVALID");
  const defaults = await client.query(`
    SELECT 1 FROM pg_default_acl
     WHERE defaclrole = (SELECT oid FROM pg_roles WHERE rolname = $1)
     LIMIT 1
  `, [INVENTORY_READER_DATABASE_PRINCIPAL]);
  if (defaults.rowCount !== 0) return fail("DATABASE_PRINCIPAL_INVENTORY_READER_DEFAULT_ACL_INVALID");
  for (const relation of INVENTORY_READER_RELATIONS) {
    const acl = await client.query<{ exists: boolean; reader_select: boolean; reader_extra: boolean; public_grant: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = $1
      ) AS exists,
      EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, ARRAY[]::aclitem[])) privilege
        WHERE n.nspname = 'public' AND c.relname = $1
          AND privilege.grantee = (SELECT oid FROM pg_roles WHERE rolname = $2)
          AND privilege.privilege_type = 'SELECT'
      ) AS reader_select,
      EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, ARRAY[]::aclitem[])) privilege
        WHERE n.nspname = 'public' AND c.relname = $1
          AND privilege.grantee = (SELECT oid FROM pg_roles WHERE rolname = $2)
          AND privilege.privilege_type <> 'SELECT'
      ) AS reader_extra,
      EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, ARRAY[]::aclitem[])) privilege
        WHERE n.nspname = 'public' AND c.relname = $1
          AND privilege.grantee = 0::oid
      ) AS public_grant
    `, [relation, INVENTORY_READER_DATABASE_PRINCIPAL]);
    const aclRow = acl.rows[0];
    if (aclRow?.exists && (aclRow.reader_select || aclRow.reader_extra || aclRow.public_grant)) return fail("DATABASE_PRINCIPAL_INVENTORY_READER_ACL_INVALID");
    if (aclRow?.exists) {
      const effective = await client.query<{ select: boolean; mutate: boolean }>(`
        SELECT has_table_privilege($1, $2, 'SELECT') AS select,
               (has_table_privilege($1, $2, 'INSERT') OR has_table_privilege($1, $2, 'UPDATE')
                OR has_table_privilege($1, $2, 'DELETE') OR has_table_privilege($1, $2, 'TRUNCATE')) AS mutate
      `, [INVENTORY_READER_DATABASE_PRINCIPAL, `public.${relationIdentifier(relation)}`]);
      if (effective.rows[0]?.select || effective.rows[0]?.mutate) return fail("DATABASE_PRINCIPAL_INVENTORY_READER_ACL_INVALID");
    }
  }
  if (requireAggregate) {
    const aggregate = await client.query<{ exists: boolean; owner: string; reader_execute: boolean; reader_extra: boolean; public_grant: boolean; safe_definition: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = $1 AND pg_get_function_identity_arguments(p.oid) = ''
      ) AS exists,
      COALESCE((SELECT pg_get_userbyid(p.proowner) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname = 'public' AND p.proname = $1 AND pg_get_function_identity_arguments(p.oid) = ''), '') AS owner,
      EXISTS (
        SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, ARRAY[]::aclitem[])) privilege
        WHERE n.nspname = 'public' AND p.proname = $1 AND pg_get_function_identity_arguments(p.oid) = ''
          AND privilege.grantee = (SELECT oid FROM pg_roles WHERE rolname = $2)
          AND privilege.privilege_type = 'EXECUTE'
      ) AS reader_execute,
      EXISTS (
        SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, ARRAY[]::aclitem[])) privilege
        WHERE n.nspname = 'public' AND p.proname = $1 AND pg_get_function_identity_arguments(p.oid) = ''
          AND privilege.grantee = (SELECT oid FROM pg_roles WHERE rolname = $2)
          AND privilege.privilege_type <> 'EXECUTE'
      ) AS reader_extra,
      EXISTS (
        SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, ARRAY[]::aclitem[])) privilege
        WHERE n.nspname = 'public' AND p.proname = $1 AND pg_get_function_identity_arguments(p.oid) = ''
          AND privilege.grantee = 0::oid
      ) AS public_grant,
      EXISTS (
        SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        JOIN pg_language l ON l.oid = p.prolang
        WHERE n.nspname = 'public' AND p.proname = $1 AND pg_get_function_identity_arguments(p.oid) = ''
          AND p.prosecdef AND l.lanname = 'sql'
          AND COALESCE(p.proconfig, ARRAY[]::text[]) = ARRAY['search_path=pg_catalog, public']::text[]
          AND pg_get_function_result(p.oid) = 'TABLE(eligible bigint, issued bigint, ambiguous bigint, missing bigint)'
      ) AS safe_definition
    `, [INVENTORY_AGGREGATE_FUNCTION, INVENTORY_READER_DATABASE_PRINCIPAL]);
    const aggregateRow = aggregate.rows[0];
    if (aggregateRow === undefined || !aggregateRow.exists || aggregateRow.owner !== MIGRATOR_DATABASE_PRINCIPAL
      || !aggregateRow.reader_execute || aggregateRow.reader_extra || aggregateRow.public_grant || !aggregateRow.safe_definition) {
      return fail("DATABASE_PRINCIPAL_INVENTORY_READER_AGGREGATE_INVALID");
    }
    const effective = await client.query<{ execute: boolean }>("SELECT has_function_privilege($1, 'public.account_entitlement_inventory_counts()', 'EXECUTE') AS execute", [INVENTORY_READER_DATABASE_PRINCIPAL]);
    if (effective.rows[0]?.execute !== true) return fail("DATABASE_PRINCIPAL_INVENTORY_READER_AGGREGATE_INVALID");
  }
  const owned = await client.query(`
    SELECT 1 FROM pg_class WHERE relowner = (SELECT oid FROM pg_roles WHERE rolname = $1)
    UNION ALL SELECT 1 FROM pg_proc WHERE proowner = (SELECT oid FROM pg_roles WHERE rolname = $1)
    UNION ALL SELECT 1 FROM pg_type WHERE typowner = (SELECT oid FROM pg_roles WHERE rolname = $1)
  `, [INVENTORY_READER_DATABASE_PRINCIPAL]);
  if (owned.rowCount !== 0) return fail("DATABASE_PRINCIPAL_INVENTORY_READER_OWNERSHIP_INVALID");
}

async function assertFinalRoleShape(client: Client, expectedLogin = true, failureCode = "DATABASE_PRINCIPAL_ROLE_ATTRIBUTES_INVALID"): Promise<void> {
  const result = await client.query<{
    rolname: string;
    rolcanlogin: boolean;
    rolsuper: boolean;
    rolcreatedb: boolean;
    rolcreaterole: boolean;
    rolinherit: boolean;
    rolreplication: boolean;
    rolbypassrls: boolean;
  }>(`
    SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolreplication, rolbypassrls
      FROM pg_roles
     WHERE rolname IN ($1, $2, $3)
     ORDER BY rolname
  `, [RUNTIME_DATABASE_PRINCIPAL, ENTITLEMENT_WRITER_DATABASE_PRINCIPAL, MIGRATOR_DATABASE_PRINCIPAL]);
  if (result.rows.length !== 3 || result.rows.some((row) => row.rolcanlogin !== (row.rolname === MIGRATOR_DATABASE_PRINCIPAL ? true : expectedLogin) || row.rolsuper || row.rolcreatedb || row.rolcreaterole || row.rolinherit || row.rolreplication || row.rolbypassrls)) {
    return fail(failureCode);
  }
}

async function verifyRoleSession(connectionString: string, expectedUser: string, failureCode = "DATABASE_PRINCIPAL_ROLE_SESSION_INVALID"): Promise<void> {
  const client = new Client({ connectionString, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
    const result = await client.query<{ session_user: string; current_user: string }>("SELECT session_user, current_user");
    const row = result.rows[0];
    if (row === undefined || row.session_user !== expectedUser || row.current_user !== expectedUser) {
      return fail(failureCode);
    }
  } catch (error) {
    if (error instanceof DatabasePrincipalError) throw error;
    return fail(failureCode);
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function verifyRuntimeAndWriterSessions(runtimeUrl: URL, writerUrl: URL, failureCode = "DATABASE_PRINCIPAL_ROLE_SESSION_INVALID"): Promise<void> {
  await verifyRoleSession(runtimeUrl.toString(), RUNTIME_DATABASE_PRINCIPAL, failureCode);
  await verifyRoleSession(writerUrl.toString(), ENTITLEMENT_WRITER_DATABASE_PRINCIPAL, failureCode);
}

async function assertNoRoleMembership(client: Client, role: string): Promise<void> {
  const result = await client.query(`
    SELECT 1
      FROM pg_auth_members membership
      JOIN pg_roles member ON member.oid = membership.member
      JOIN pg_roles parent ON parent.oid = membership.roleid
     WHERE member.rolname = $1
        OR parent.rolname = $1
     LIMIT 1
  `, [role]);
  if (result.rowCount !== 0) return fail("DATABASE_PRINCIPAL_ROLE_MEMBERSHIP_FORBIDDEN");
}

async function revokeRoleMembershipEdges(client: Client, role: string): Promise<void> {
  const result = await client.query<{ member: string; parent: string }>(`
    SELECT member.rolname AS member, parent.rolname AS parent
      FROM pg_auth_members membership
      JOIN pg_roles member ON member.oid = membership.member
      JOIN pg_roles parent ON parent.oid = membership.roleid
     WHERE member.rolname = $1 OR parent.rolname = $1
  `, [role]);
  for (const edge of result.rows) {
    await client.query(`REVOKE ${quoteIdentifier(edge.parent)} FROM ${quoteIdentifier(edge.member)}`);
  }
  await assertNoRoleMembership(client, role);
}

const FINAL_DATABASE_PRINCIPALS = Object.freeze([
  MIGRATOR_DATABASE_PRINCIPAL,
  RUNTIME_DATABASE_PRINCIPAL,
  ENTITLEMENT_WRITER_DATABASE_PRINCIPAL,
] as const);
const CONTROLLED_DATABASE_PRINCIPALS = Object.freeze([
  CLUSTER_ADMIN_DATABASE_PRINCIPAL,
  ...FINAL_DATABASE_PRINCIPALS,
] as const);

async function assertOriginReplicationRole(client: Client): Promise<void> {
  const result = await client.query<{ session_replication_role: string }>("SHOW session_replication_role");
  if (result.rows[0]?.session_replication_role !== "origin") return fail("DATABASE_PRINCIPAL_SESSION_REPLICATION_ROLE_INVALID");
}

type TargetRoleSession = Readonly<{
  pid: number;
  role_oid: string;
  backend_type: string;
  datid: string | null;
  datname: string | null;
}>;

type TargetRoleSessionDisposition = "drain" | "ignore";

/**
 * Only sessions with a client-facing backend can be terminated as part of a
 * role transition.  Server-owned workers are not ordinary authenticated
 * sessions; classifying them separately lets the caller fail closed before
 * it mutates any client session.
 */
function targetRoleSessionPredicate(session: TargetRoleSession): boolean {
  return session.backend_type === "client backend" || session.backend_type === "walsender";
}

async function readTargetRoleSessions(client: Client, role: string): Promise<TargetRoleSession[]> {
  const result = await client.query<TargetRoleSession>(`
    SELECT activity.pid,
           activity.usesysid::text AS role_oid,
           activity.backend_type,
           activity.datid::text,
           activity.datname
      FROM pg_stat_activity activity
     WHERE activity.usesysid = (SELECT oid FROM pg_roles WHERE rolname = $1)
       AND activity.pid <> pg_backend_pid()
  `, [role]);
  return result.rows;
}

function classifyTargetRoleSession(session: TargetRoleSession, pinnedSuperuser: boolean): TargetRoleSessionDisposition {
  if (targetRoleSessionPredicate(session)) return "drain";
  if (pinnedSuperuser
    && session.role_oid === "10"
    && session.backend_type === "logical replication launcher"
    && session.datid === null
    && session.datname === null) {
    return "ignore";
  }
  return fail("DATABASE_PRINCIPAL_TARGET_BACKGROUND_WORKER_ACTIVE");
}

function classifyTargetRoleSessions(
  sessions: readonly TargetRoleSession[],
  pinnedSuperuser: boolean,
): TargetRoleSessionDisposition[] {
  // Classify the complete snapshot before any termination.  An unexpected
  // worker must fail closed without partially draining the target role.
  return sessions.map((session) => classifyTargetRoleSession(session, pinnedSuperuser));
}

async function assertTargetRoleSessionsDrained(
  client: Client,
  role: string,
  pinnedSuperuser = false,
  failureCode = "DATABASE_PRINCIPAL_BOOTSTRAP_SESSIONS_ACTIVE",
): Promise<void> {
  const dispositions = classifyTargetRoleSessions(await readTargetRoleSessions(client, role), pinnedSuperuser);
  if (dispositions.includes("drain")) return fail(failureCode);
}

async function assertNoExternalRoleSettings(client: Client): Promise<void> {
  const result = await client.query(`
    SELECT role_setting.setrole,
           database_row.datname
      FROM pg_db_role_setting role_setting
      JOIN pg_roles role_row ON role_row.oid = role_setting.setrole
      JOIN pg_database database_row ON database_row.oid = role_setting.setdatabase
     WHERE role_row.rolname = ANY($1::text[])
       AND role_setting.setdatabase <> 0
       AND database_row.datname <> current_database()
  `, [[...CONTROLLED_DATABASE_PRINCIPALS, INVENTORY_READER_DATABASE_PRINCIPAL]]);
  if (result.rowCount !== 0) return fail("DATABASE_PRINCIPAL_EXTERNAL_ROLE_SETTINGS_FORBIDDEN");
}

async function assertNoUnexpectedRoleSettings(client: Client): Promise<void> {
  await assertNoExternalRoleSettings(client);
  const databaseBaseline = await client.query<{ read_only: boolean }>(`
    SELECT EXISTS (
      SELECT 1
        FROM pg_db_role_setting
       WHERE setrole = 0
         AND setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database())
         AND EXISTS (
           SELECT 1
             FROM unnest(COALESCE(setconfig, ARRAY[]::text[])) AS config(value)
            WHERE split_part(config.value, '=', 1) = 'default_transaction_read_only'
              AND lower(split_part(config.value, '=', 2)) IN ('on', 'true', '1')
         )
    ) AS read_only
  `);
  if (databaseBaseline.rows[0]?.read_only !== true) return fail("DATABASE_PRINCIPAL_DATABASE_READ_ONLY_BASELINE_INVALID");
  const target = await client.query<{ rolname: string; config: string[] | null }>(`
    SELECT role_row.rolname, role_setting.setconfig AS config
      FROM pg_db_role_setting role_setting
      JOIN pg_roles role_row ON role_row.oid = role_setting.setrole
     WHERE role_row.rolname = ANY($1::text[])
       AND role_setting.setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database())
  `, [CONTROLLED_DATABASE_PRINCIPALS]);
  for (const role of CONTROLLED_DATABASE_PRINCIPALS) {
    const row = target.rows.find((value) => value.rolname === role);
    if (row === undefined || row.config?.length !== 1 || row.config[0] !== "default_transaction_read_only=off") return fail("DATABASE_PRINCIPAL_ROLE_SETTINGS_INVALID");
  }
  const inventory = await client.query<{ config: string[] | null }>(`
    SELECT role_row.rolconfig AS config
      FROM pg_roles role_row
     WHERE role_row.rolname = $1
  `, [INVENTORY_READER_DATABASE_PRINCIPAL]);
  if (inventory.rows[0]?.config?.length !== 1 || inventory.rows[0].config[0] !== "default_transaction_read_only=on") return fail("DATABASE_PRINCIPAL_INVENTORY_READER_SETTINGS_INVALID");
}

async function resetFinalRoleSettings(client: Client): Promise<void> {
  await assertNoExternalRoleSettings(client);
  const database = await client.query<{ datname: string }>("SELECT current_database() AS datname");
  const databaseName = database.rows[0]?.datname;
  if (databaseName === undefined) return fail("DATABASE_PRINCIPAL_DATABASE_NOT_FOUND");
  await client.query(`ALTER DATABASE ${quoteIdentifier(databaseName)} SET default_transaction_read_only = on`);
  for (const role of CONTROLLED_DATABASE_PRINCIPALS) {
    await client.query(`ALTER ROLE ${quoteIdentifier(role)} RESET ALL`);
    await client.query(`ALTER ROLE ${quoteIdentifier(role)} IN DATABASE ${quoteIdentifier(databaseName)} RESET ALL`);
    await client.query(`ALTER ROLE ${quoteIdentifier(role)} IN DATABASE ${quoteIdentifier(databaseName)} SET default_transaction_read_only = off`);
  }
  await client.query(`ALTER ROLE ${quoteIdentifier(INVENTORY_READER_DATABASE_PRINCIPAL)} RESET ALL`);
  await client.query(`ALTER ROLE ${quoteIdentifier(INVENTORY_READER_DATABASE_PRINCIPAL)} IN DATABASE ${quoteIdentifier(databaseName)} RESET ALL`);
  await client.query(`ALTER ROLE ${quoteIdentifier(INVENTORY_READER_DATABASE_PRINCIPAL)} SET default_transaction_read_only = on`);
  await assertNoUnexpectedRoleSettings(client);
}

type SharedOwnerSnapshot = Readonly<{
  databases: ReadonlyArray<Readonly<{ name: string; owner: string }>>;
  tablespaces: ReadonlyArray<Readonly<{ name: string; owner: string }>>;
}>;

async function snapshotSharedOwnership(client: Client, role: string): Promise<SharedOwnerSnapshot> {
  const databases = await client.query<{ name: string; owner: string }>(`
    SELECT database_row.datname AS name, pg_get_userbyid(database_row.datdba) AS owner
      FROM pg_database database_row
      JOIN pg_roles owner_role ON owner_role.oid = database_row.datdba
     WHERE owner_role.rolname = $1
       AND database_row.datname <> current_database()
  `, [role]);
  const tablespaces = await client.query<{ name: string; owner: string }>(`
    SELECT tablespace.spcname AS name, pg_get_userbyid(tablespace.spcowner) AS owner
      FROM pg_tablespace tablespace
      JOIN pg_roles owner_role ON owner_role.oid = tablespace.spcowner
     WHERE owner_role.rolname = $1
  `, [role]);
  return { databases: databases.rows, tablespaces: tablespaces.rows };
}

async function restoreSharedOwnership(client: Client, snapshot: SharedOwnerSnapshot): Promise<void> {
  for (const database of snapshot.databases) {
    await client.query(`ALTER DATABASE ${quoteIdentifier(database.name)} OWNER TO ${quoteIdentifier(database.owner)}`);
  }
  for (const tablespace of snapshot.tablespaces) {
    await client.query(`ALTER TABLESPACE ${quoteIdentifier(tablespace.name)} OWNER TO ${quoteIdentifier(tablespace.owner)}`);
  }
}

async function assertNoUnsupportedCurrentOwnership(client: Client, role: string, pinnedSuperuser = false): Promise<void> {
  const pinnedSystemNamespaceClause = "AND namespace.nspname NOT LIKE 'pg_%' AND namespace.nspname <> 'information_schema'";
  const result = await client.query<{ object_kind: string; object_name: string }>(`
    SELECT 'schema' AS object_kind, namespace.nspname AS object_name
      FROM pg_namespace namespace
      JOIN pg_roles owner_role ON owner_role.oid = namespace.nspowner
     WHERE owner_role.rolname = $1
       AND namespace.nspname <> 'public'
       AND namespace.nspname NOT LIKE 'pg_%'
       AND namespace.nspname <> 'information_schema'
    UNION ALL
    SELECT 'relation' AS object_kind, namespace.nspname || '.' || relation.relname AS object_name
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      JOIN pg_roles owner_role ON owner_role.oid = relation.relowner
     WHERE owner_role.rolname = $1
       AND namespace.nspname <> 'public'
       ${pinnedSystemNamespaceClause}
    UNION ALL
    SELECT 'function' AS object_kind, namespace.nspname || '.' || function_row.proname AS object_name
      FROM pg_proc function_row
      JOIN pg_namespace namespace ON namespace.oid = function_row.pronamespace
      JOIN pg_roles owner_role ON owner_role.oid = function_row.proowner
     WHERE owner_role.rolname = $1
       AND namespace.nspname <> 'public'
       ${pinnedSystemNamespaceClause}
    UNION ALL
    SELECT 'type' AS object_kind, namespace.nspname || '.' || type_row.typname AS object_name
      FROM pg_type type_row
      JOIN pg_namespace namespace ON namespace.oid = type_row.typnamespace
      JOIN pg_roles owner_role ON owner_role.oid = type_row.typowner
     WHERE owner_role.rolname = $1
       AND namespace.nspname <> 'public'
       ${pinnedSystemNamespaceClause}
  `, [role]);
  if (result.rowCount !== 0) return fail("DATABASE_PRINCIPAL_UNSUPPORTED_OWNER_OBJECT");
  const unsupportedCatalogs = [
    ["pg_foreign_server", "srvowner", null],
    ["pg_event_trigger", "evtowner", null],
    ["pg_publication", "pubowner", null],
    ["pg_subscription", "subowner", null],
    ["pg_collation", "collowner", "collnamespace"],
    ["pg_conversion", "conowner", "connamespace"],
    ["pg_operator", "oprowner", "oprnamespace"],
    ["pg_opclass", "opcowner", "opcnamespace"],
    ["pg_opfamily", "opfowner", "opfnamespace"],
    ["pg_language", "lanowner", null],
    ["pg_ts_config", "cfgowner", "cfgnamespace"],
    ["pg_ts_dict", "dictowner", "dictnamespace"],
    ["pg_statistic_ext", "stxowner", "stxnamespace"],
    ["pg_largeobject_metadata", "lomowner", null],
  ] as const;
  for (const [catalog, ownerColumn, namespaceColumn] of unsupportedCatalogs) {
    const unsupportedCatalogNamespaceClause = pinnedSuperuser && namespaceColumn !== null
      ? `AND (catalog_row.oid >= ${FIRST_NORMAL_OBJECT_ID}
              OR EXISTS (
                SELECT 1
                  FROM pg_namespace
                 WHERE oid = catalog_row.${namespaceColumn}
                   AND nspname NOT LIKE 'pg_%'
                   AND nspname <> 'information_schema'
              ))`
      : "";
    const builtinLanguageClause = pinnedSuperuser && catalog === "pg_language"
      ? "AND catalog_row.lanname NOT IN ('c', 'internal', 'plpgsql', 'sql')"
      : "";
    const result = await client.query(`
      SELECT 1
        FROM pg_catalog.${catalog} AS catalog_row
       WHERE catalog_row.${ownerColumn} = (SELECT oid FROM pg_roles WHERE rolname = $1)
         AND NOT EXISTS (
           SELECT 1
             FROM pg_depend dependency
             JOIN pg_extension extension_row ON extension_row.oid = dependency.refobjid
            WHERE dependency.classid = 'pg_catalog.${catalog}'::regclass
              AND dependency.objid = catalog_row.oid
              AND dependency.refclassid = 'pg_extension'::regclass
              AND dependency.deptype = 'e'
         )
         ${unsupportedCatalogNamespaceClause}
         ${builtinLanguageClause}
       LIMIT 1
    `, [role]);
    if (result.rowCount !== 0) return fail("DATABASE_PRINCIPAL_UNSUPPORTED_OWNER_OBJECT");
  }
}

async function isExtensionMember(client: Client, className: string, oid: string): Promise<boolean> {
  const result = await client.query<{ member: boolean }>(`
    SELECT EXISTS (
      SELECT 1
        FROM pg_depend dependency
        JOIN pg_extension extension_row ON extension_row.oid = dependency.refobjid
       WHERE dependency.classid = $1::regclass
         AND dependency.objid = $2::oid
         AND dependency.refclassid = 'pg_extension'::regclass
         AND dependency.deptype = 'e'
    ) AS member
  `, [className, oid]);
  return result.rows[0]?.member === true;
}

type CurrentOwnedObject =
  | Readonly<{ kind: "relation"; oid: string; relname: string; relkind: string }>
  | Readonly<{ kind: "routine"; oid: string; proname: string; identity_arguments: string }>
  | Readonly<{ kind: "type"; oid: string; typname: string }>;

async function readCurrentOwnedObjects(client: Client, sourceOid: string): Promise<CurrentOwnedObject[]> {
  const objects: CurrentOwnedObject[] = [];
  const relations = await client.query<{ oid: string; relname: string; relkind: string }>(`
    SELECT c.oid::text, c.relname, c.relkind
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relowner = $1::oid
       AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
  `, [sourceOid]);
  for (const relation of relations.rows) {
    if (!(await isExtensionMember(client, "pg_class", relation.oid))) objects.push({ kind: "relation", ...relation });
  }
  const routines = await client.query<{ oid: string; proname: string; identity_arguments: string }>(`
    SELECT p.oid::text, p.proname, pg_get_function_identity_arguments(p.oid) AS identity_arguments
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proowner = $1::oid
  `, [sourceOid]);
  for (const routine of routines.rows) {
    if (!(await isExtensionMember(client, "pg_proc", routine.oid))) objects.push({ kind: "routine", ...routine });
  }
  const types = await client.query<{ oid: string; typname: string }>(`
    SELECT t.oid::text, t.typname
      FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = 'public'
       AND t.typowner = $1::oid
       AND t.typrelid = 0
       AND t.typtype IN ('d', 'e', 'r', 'm')
       AND t.typname NOT LIKE '\\_%'
  `, [sourceOid]);
  for (const type of types.rows) {
    if (!(await isExtensionMember(client, "pg_type", type.oid))) objects.push({ kind: "type", ...type });
  }
  return objects;
}

async function assignCurrentOwnedObjects(client: Client, objects: readonly CurrentOwnedObject[]): Promise<void> {
  for (const object of objects) {
    if (object.kind === "relation") {
      const command = object.relkind === "S"
        ? "SEQUENCE"
        : object.relkind === "v"
          ? "VIEW"
          : object.relkind === "m"
            ? "MATERIALIZED VIEW"
            : object.relkind === "f"
              ? "FOREIGN TABLE"
              : "TABLE";
      await client.query(`ALTER ${command} public.${quoteIdentifier(object.relname)} OWNER TO ${quoteIdentifier(MIGRATOR_DATABASE_PRINCIPAL)}`);
    } else if (object.kind === "routine") {
      await client.query(`ALTER ROUTINE public.${quoteIdentifier(object.proname)}(${object.identity_arguments}) OWNER TO ${quoteIdentifier(MIGRATOR_DATABASE_PRINCIPAL)}`);
    } else {
      await client.query(`ALTER TYPE public.${quoteIdentifier(object.typname)} OWNER TO ${quoteIdentifier(MIGRATOR_DATABASE_PRINCIPAL)}`);
    }
  }
}

async function transferCurrentOwnedObjects(client: Client, sourceRole: string, pinnedSuperuser: boolean): Promise<void> {
  await assertNoUnsupportedCurrentOwnership(client, sourceRole, pinnedSuperuser);
  const source = await client.query<{ oid: string }>("SELECT oid::text FROM pg_roles WHERE rolname = $1", [sourceRole]);
  const sourceOid = source.rows[0]?.oid;
  if (sourceOid === undefined) return fail("DATABASE_PRINCIPAL_BOOTSTRAP_ROLE_REQUIRED");
  const objects = await readCurrentOwnedObjects(client, sourceOid);
  const shared = pinnedSuperuser ? null : await snapshotSharedOwnership(client, sourceRole);
  if (!pinnedSuperuser) await client.query(`REASSIGN OWNED BY ${quoteIdentifier(sourceRole)} TO ${quoteIdentifier(CLUSTER_ADMIN_DATABASE_PRINCIPAL)}`);
  if (shared !== null) await restoreSharedOwnership(client, shared);
  await assignCurrentOwnedObjects(client, objects);
  const remaining = await client.query(`
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relowner = $1::oid
       AND NOT EXISTS (SELECT 1 FROM pg_depend dependency WHERE dependency.classid = 'pg_class'::regclass AND dependency.objid = c.oid AND dependency.refclassid = 'pg_extension'::regclass AND dependency.deptype = 'e')
    UNION ALL
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proowner = $1::oid
       AND NOT EXISTS (SELECT 1 FROM pg_depend dependency WHERE dependency.classid = 'pg_proc'::regclass AND dependency.objid = p.oid AND dependency.refclassid = 'pg_extension'::regclass AND dependency.deptype = 'e')
    UNION ALL
    SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = 'public' AND t.typowner = $1::oid AND t.typname NOT LIKE '\\_%'
       AND NOT EXISTS (SELECT 1 FROM pg_depend dependency WHERE dependency.classid = 'pg_type'::regclass AND dependency.objid = t.oid AND dependency.refclassid = 'pg_extension'::regclass AND dependency.deptype = 'e')
  `, [sourceOid]);
  if (remaining.rowCount !== 0) return fail("DATABASE_PRINCIPAL_CURRENT_OWNER_REMAINS");
}

type DefaultPrivilege = Readonly<{
  owner: string;
  schema_name: string | null;
  namespace_oid: string;
  object_type: string;
  grantee: string | null;
}>;

function defaultPrivilegeObjectType(code: string): { sql: string; schemaScoped: boolean } {
  switch (code) {
    case "r": return { sql: "TABLES", schemaScoped: true };
    case "S": return { sql: "SEQUENCES", schemaScoped: true };
    case "f": return { sql: "FUNCTIONS", schemaScoped: true };
    case "T": return { sql: "TYPES", schemaScoped: true };
    case "n": return { sql: "SCHEMAS", schemaScoped: false };
    case "L": return { sql: "LARGE OBJECTS", schemaScoped: false };
    default: return fail("DATABASE_PRINCIPAL_DEFAULT_ACL_INVALID");
  }
}

function defaultPrivilegeOwners(legacyOwner?: string): string[] {
  const owners: string[] = [...FINAL_DATABASE_PRINCIPALS];
  if (legacyOwner !== undefined) {
    if (legacyOwner !== LEGACY_BOOTSTRAP_DATABASE_PRINCIPAL) return fail("DATABASE_PRINCIPAL_DEFAULT_ACL_OWNER_REQUIRED");
    owners.push(legacyOwner);
  }
  return owners;
}

function defaultPrivilegeGrantee(grantee: string | null): string {
  return grantee === "PUBLIC" ? "PUBLIC" : quoteIdentifier(grantee ?? "");
}

async function readStaleDefaultPrivileges(client: Client, legacyOwner?: string): Promise<DefaultPrivilege[]> {
  const owners = defaultPrivilegeOwners(legacyOwner);
  const result = await client.query<DefaultPrivilege>(`
    SELECT owner_role.rolname AS owner,
           namespace.nspname AS schema_name,
           default_acl.defaclnamespace::text AS namespace_oid,
           default_acl.defaclobjtype AS object_type,
           CASE WHEN privilege.grantee = 0::oid THEN 'PUBLIC' ELSE grantee.rolname END AS grantee
      FROM pg_default_acl default_acl
      JOIN pg_roles owner_role ON owner_role.oid = default_acl.defaclrole
      LEFT JOIN pg_namespace namespace ON namespace.oid = default_acl.defaclnamespace
      LEFT JOIN LATERAL aclexplode(COALESCE(default_acl.defaclacl, ARRAY[]::aclitem[])) privilege ON true
      LEFT JOIN pg_roles grantee ON grantee.oid = privilege.grantee
     WHERE owner_role.rolname = ANY($1::text[])
  `, [owners]);
  return result.rows;
}

async function normalizeDefaultPrivileges(client: Client, legacyOwner?: string): Promise<void> {
  const session = await client.query<{ session_user: string; is_superuser: boolean }>(`
    SELECT session_user,
           (SELECT rolsuper FROM pg_roles WHERE rolname = session_user) AS is_superuser
  `);
  const sessionRow = session.rows[0];
  if (sessionRow === undefined) return fail("DATABASE_PRINCIPAL_SESSION_INVALID");
  const groups = new Map<string, { owner: string; schema_name: string | null; namespace_oid: string; object_type: string; grantees: Set<string> }>();
  for (const privilege of await readStaleDefaultPrivileges(client, legacyOwner)) {
    const objectType = defaultPrivilegeObjectType(privilege.object_type);
    if (privilege.owner.length === 0) return fail("DATABASE_PRINCIPAL_DEFAULT_ACL_INVALID");
    if (privilege.namespace_oid !== "0" && privilege.schema_name !== "public") return fail("DATABASE_PRINCIPAL_DEFAULT_ACL_INVALID");
    if (privilege.namespace_oid !== "0" && !objectType.schemaScoped) return fail("DATABASE_PRINCIPAL_DEFAULT_ACL_INVALID");
    const key = `${privilege.owner}\u0000${privilege.namespace_oid}\u0000${privilege.object_type}`;
    const group = groups.get(key) ?? {
      owner: privilege.owner,
      schema_name: privilege.schema_name,
      namespace_oid: privilege.namespace_oid,
      object_type: privilege.object_type,
      grantees: new Set<string>(),
    };
    if (privilege.grantee !== null) group.grantees.add(privilege.grantee);
    groups.set(key, group);
  }
  for (const objectType of ["f"] as const) {
    const key = `${MIGRATOR_DATABASE_PRINCIPAL}\u0000${"0"}\u0000${objectType}`;
    if (!groups.has(key)) {
      groups.set(key, {
        owner: MIGRATOR_DATABASE_PRINCIPAL,
        schema_name: null,
        namespace_oid: "0",
        object_type: objectType,
        grantees: new Set<string>(),
      });
    }
  }
  for (const group of groups.values()) {
    quoteIdentifier(group.owner);
    if (group.owner !== sessionRow.session_user && !sessionRow.is_superuser) return fail("DATABASE_PRINCIPAL_DEFAULT_ACL_OWNER_REQUIRED");
    const objectType = defaultPrivilegeObjectType(group.object_type);
    const schemaClause = group.namespace_oid === "0" ? "" : ` IN SCHEMA ${quoteIdentifier(group.schema_name ?? "")}`;
    // Default ACLs only persist deviations from PostgreSQL's hard-wired
    // baseline.  Always clear PUBLIC as well as explicit grantees before
    // restoring that baseline; otherwise an implicit PUBLIC privilege can
    // survive a row that only records a different direct grant.
    const revocationTargets = new Set<string>([quoteIdentifier(group.owner), "PUBLIC"]);
    for (const grantee of group.grantees) revocationTargets.add(defaultPrivilegeGrantee(grantee));
    await client.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${quoteIdentifier(group.owner)}${schemaClause} REVOKE ALL ON ${objectType.sql} FROM ${[...revocationTargets].join(", ")}`);
    const hardenedMigrator = group.owner === MIGRATOR_DATABASE_PRINCIPAL
      && group.namespace_oid === "0"
      && group.object_type === "f";
    if (hardenedMigrator) {
      await client.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${quoteIdentifier(group.owner)} GRANT ALL ON FUNCTIONS TO ${quoteIdentifier(group.owner)}`);
    } else if (group.namespace_oid === "0" && group.object_type === "f") {
      // PostgreSQL's global function baseline is PUBLIC EXECUTE.
      await client.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${quoteIdentifier(group.owner)} GRANT EXECUTE ON FUNCTIONS TO PUBLIC`);
    } else if (group.namespace_oid === "0" && group.object_type === "T") {
      // PostgreSQL's global type baseline is PUBLIC USAGE.  Do not create an
      // owner-specific row: ownership already supplies the owner privileges.
      await client.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${quoteIdentifier(group.owner)} GRANT USAGE ON TYPES TO PUBLIC`);
    }
  }
  await assertNoStaleDefaultPrivileges(client, legacyOwner);
}

async function assertNoStaleDefaultPrivileges(client: Client, legacyOwner?: string): Promise<void> {
  const rows = await readStaleDefaultPrivileges(client, legacyOwner);
  for (const privilege of rows) {
    const objectType = defaultPrivilegeObjectType(privilege.object_type);
    if (privilege.namespace_oid !== "0" && privilege.schema_name !== "public") return fail("DATABASE_PRINCIPAL_DEFAULT_ACL_INVALID");
    if (privilege.namespace_oid !== "0" && !objectType.schemaScoped) return fail("DATABASE_PRINCIPAL_DEFAULT_ACL_INVALID");
    if (privilege.owner !== MIGRATOR_DATABASE_PRINCIPAL
      || privilege.namespace_oid !== "0"
      || privilege.object_type !== "f"
      || privilege.grantee !== MIGRATOR_DATABASE_PRINCIPAL) {
      return fail("DATABASE_PRINCIPAL_DEFAULT_ACL_INVALID");
    }
  }
}

async function assertRetiredRoleAttributes(client: Client, role: string, pinnedSuperuser = false): Promise<void> {
  const result = await client.query<{
    rolname: string;
    rolcanlogin: boolean;
    rolsuper: boolean;
    rolcreatedb: boolean;
    rolcreaterole: boolean;
    rolinherit: boolean;
    rolreplication: boolean;
    rolbypassrls: boolean;
  }>(`
    SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolreplication, rolbypassrls
      FROM pg_roles
     WHERE rolname = $1
  `, [role]);
  const row = result.rows[0];
  if (row === undefined || row.rolcanlogin || row.rolsuper !== pinnedSuperuser || row.rolcreatedb || row.rolcreaterole || row.rolinherit || row.rolreplication || row.rolbypassrls) {
    return fail("DATABASE_PRINCIPAL_BOOTSTRAP_ROLE_NOT_RETIRED");
  }
}

async function assertRetiredRolePasswordNull(client: Client, role: string): Promise<void> {
  const result = await client.query<{ rolpassword: string | null }>(`
    SELECT rolpassword
      FROM pg_authid
     WHERE rolname = $1
  `, [role]);
  if (result.rows[0]?.rolpassword !== null) return fail("DATABASE_PRINCIPAL_BOOTSTRAP_ROLE_NOT_RETIRED");
}

async function assertRetiredRoleShape(client: Client, role: string, pinnedSuperuser = false): Promise<void> {
  await assertRetiredRoleAttributes(client, role, pinnedSuperuser);
  await assertRetiredRolePasswordNull(client, role);
}

async function verifyRetiredRoleCannotLogin(connectionString: string): Promise<void> {
  const client = new Client({ connectionString, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
    return fail("DATABASE_PRINCIPAL_BOOTSTRAP_ROLE_LOGIN_ACTIVE");
  } catch (error) {
    if (error instanceof DatabasePrincipalError) throw error;
    const code = typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : undefined;
    if (code !== "28000" && code !== "28P01") return fail("DATABASE_PRINCIPAL_BOOTSTRAP_ROLE_LOGIN_CHECK_FAILED");
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function assertRelationInventory(client: Client): Promise<void> {
  const result = await client.query<{ relname: string }>(`
    SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
       AND c.relname <> '_prisma_migrations'
  `);
  const known = new Set<string>(DATABASE_PRINCIPAL_RELATIONS);
  const unknown = result.rows.map((row) => row.relname).filter((name) => !known.has(name));
  const missing = DATABASE_PRINCIPAL_RELATIONS.filter((name) => !result.rows.some((row) => row.relname === name));
  if (unknown.length > 0 || missing.length > 0) return fail("DATABASE_PRINCIPAL_RELATION_INVENTORY_MISMATCH");
}

async function ensureAllowedExtensions(client: Client): Promise<void> {
  for (const extension of REQUIRED_EXTENSIONS.filter((value) => value !== "plpgsql")) {
    await client.query(`CREATE EXTENSION IF NOT EXISTS ${quoteIdentifier(extension)} WITH SCHEMA public`);
  }
  const result = await client.query<{ extname: string; schema_name: string; owner: string }>(`
    SELECT extension_row.extname,
           namespace.nspname AS schema_name,
           pg_get_userbyid(extension_row.extowner) AS owner
      FROM pg_extension extension_row
      JOIN pg_namespace namespace ON namespace.oid = extension_row.extnamespace
  `);
  const actual = result.rows.map((row) => row.extname).sort();
  const expected = [...REQUIRED_EXTENSIONS].sort();
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) return fail("DATABASE_PRINCIPAL_EXTENSION_INVENTORY_INVALID");
  const sealedLegacy = await client.query<{ oid: string }>("SELECT oid::text FROM pg_roles WHERE rolname = $1 AND rolsuper AND NOT rolcanlogin", [LEGACY_BOOTSTRAP_DATABASE_PRINCIPAL]);
  const allowedOwners = new Set<string>([CLUSTER_ADMIN_DATABASE_PRINCIPAL]);
  if (sealedLegacy.rows[0]?.oid === "10") allowedOwners.add(LEGACY_BOOTSTRAP_DATABASE_PRINCIPAL);
  if (result.rows.some((row) => (row.extname !== "plpgsql" && row.schema_name !== "public") || !allowedOwners.has(row.owner))) return fail("DATABASE_PRINCIPAL_EXTENSION_OWNER_INVALID");
}

async function setOwners(client: Client): Promise<void> {
  const database = await client.query<{ datname: string }>("SELECT current_database() AS datname");
  const databaseName = database.rows[0]?.datname;
  if (databaseName === undefined) return fail("DATABASE_PRINCIPAL_DATABASE_NOT_FOUND");
  await client.query(`ALTER DATABASE ${quoteIdentifier(databaseName)} OWNER TO ${quoteIdentifier(MIGRATOR_DATABASE_PRINCIPAL)}`);
  await client.query(`ALTER SCHEMA public OWNER TO ${quoteIdentifier(MIGRATOR_DATABASE_PRINCIPAL)}`);
  const relations = await client.query<{ oid: string; relname: string; relkind: string }>(`
    SELECT c.oid::text, c.relname, c.relkind
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
  `);
  for (const relation of relations.rows) {
    if (await isExtensionMember(client, "pg_class", relation.oid)) continue;
    const command = relation.relkind === "S"
      ? "SEQUENCE"
      : relation.relkind === "v"
        ? "VIEW"
        : relation.relkind === "m"
          ? "MATERIALIZED VIEW"
          : relation.relkind === "f"
            ? "FOREIGN TABLE"
            : "TABLE";
    await client.query(`ALTER ${command} public.${quoteIdentifier(relation.relname)} OWNER TO ${quoteIdentifier(MIGRATOR_DATABASE_PRINCIPAL)}`);
  }
}

async function assertOwnershipShape(client: Client): Promise<void> {
  const relationOwners = await client.query<{ owner: string; extension_member: boolean }>(`
    SELECT pg_get_userbyid(c.relowner) AS owner,
           EXISTS (SELECT 1 FROM pg_depend dependency WHERE dependency.classid = 'pg_class'::regclass AND dependency.objid = c.oid AND dependency.refclassid = 'pg_extension'::regclass AND dependency.deptype = 'e') AS extension_member
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
  `);
  if (relationOwners.rows.some((row) => !row.extension_member && row.owner !== MIGRATOR_DATABASE_PRINCIPAL)) return fail("DATABASE_PRINCIPAL_RELATION_OWNER_INVALID");
  const functionOwners = await client.query<{ owner: string; extension_member: boolean }>(`
    SELECT pg_get_userbyid(proowner) AS owner,
           EXISTS (SELECT 1 FROM pg_depend dependency WHERE dependency.classid = 'pg_proc'::regclass AND dependency.objid = function_row.oid AND dependency.refclassid = 'pg_extension'::regclass AND dependency.deptype = 'e') AS extension_member
      FROM pg_proc function_row
      JOIN pg_namespace namespace ON namespace.oid = function_row.pronamespace
     WHERE namespace.nspname = 'public'
  `);
  const typeOwners = await client.query<{ owner: string; extension_member: boolean }>(`
    SELECT pg_get_userbyid(type_row.typowner) AS owner,
           EXISTS (SELECT 1 FROM pg_depend dependency WHERE dependency.classid = 'pg_type'::regclass AND dependency.objid = type_row.oid AND dependency.refclassid = 'pg_extension'::regclass AND dependency.deptype = 'e') AS extension_member
      FROM pg_type type_row
      JOIN pg_namespace namespace ON namespace.oid = type_row.typnamespace
     WHERE namespace.nspname = 'public'
       AND type_row.typtype IN ('c', 'd', 'e', 'r', 'm')
       AND type_row.typname NOT LIKE '\\_%'
  `);
  if (functionOwners.rows.some((row) => !row.extension_member && row.owner !== MIGRATOR_DATABASE_PRINCIPAL)
    || typeOwners.rows.some((row) => !row.extension_member && row.owner !== MIGRATOR_DATABASE_PRINCIPAL)) {
    return fail("DATABASE_PRINCIPAL_NONCLASS_OWNER_INVALID");
  }
  const applicationOwners = await client.query<{ owner: string; count: string }>(`
    SELECT owner, count(*)::text AS count
      FROM (
        SELECT pg_get_userbyid(c.relowner) AS owner
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
           AND NOT EXISTS (SELECT 1 FROM pg_depend dependency WHERE dependency.classid = 'pg_class'::regclass AND dependency.objid = c.oid AND dependency.refclassid = 'pg_extension'::regclass AND dependency.deptype = 'e')
        UNION ALL
        SELECT pg_get_userbyid(function_row.proowner) AS owner
          FROM pg_proc function_row
          JOIN pg_namespace namespace ON namespace.oid = function_row.pronamespace
         WHERE namespace.nspname = 'public'
           AND NOT EXISTS (SELECT 1 FROM pg_depend dependency WHERE dependency.classid = 'pg_proc'::regclass AND dependency.objid = function_row.oid AND dependency.refclassid = 'pg_extension'::regclass AND dependency.deptype = 'e')
        UNION ALL
        SELECT pg_get_userbyid(type_row.typowner) AS owner
          FROM pg_type type_row
          JOIN pg_namespace namespace ON namespace.oid = type_row.typnamespace
         WHERE namespace.nspname = 'public'
           AND type_row.typtype IN ('c', 'd', 'e', 'r', 'm')
           AND type_row.typname NOT LIKE '\\_%'
           AND NOT EXISTS (SELECT 1 FROM pg_depend dependency WHERE dependency.classid = 'pg_type'::regclass AND dependency.objid = type_row.oid AND dependency.refclassid = 'pg_extension'::regclass AND dependency.deptype = 'e')
      ) owned
     WHERE owner IN ($1, $2)
     GROUP BY owner
  `, [RUNTIME_DATABASE_PRINCIPAL, ENTITLEMENT_WRITER_DATABASE_PRINCIPAL]);
  if (applicationOwners.rows.length !== 0) return fail("DATABASE_PRINCIPAL_APPLICATION_OWNER_INVALID");
}

/**
 * Bootstrap is a pre-migrate gate.  It must not report success merely because
 * the coordinator role is usable: the next process is the non-superuser
 * migrator, so every supported current-database object must already be
 * reachable by that role.  Extension members are intentionally excluded;
 * their maintenance owner remains the cluster admin (or the sealed pinned
 * legacy OID10 role).
 */
async function assertBootstrapOwnershipReady(client: Client): Promise<void> {
  const owners = await client.query<{ database_owner: string; schema_owner: string }>(`
    SELECT pg_get_userbyid(database_row.datdba) AS database_owner,
           pg_get_userbyid(namespace.nspowner) AS schema_owner
      FROM pg_database database_row
      CROSS JOIN pg_namespace namespace
     WHERE database_row.datname = current_database()
       AND namespace.nspname = 'public'
  `);
  const owner = owners.rows[0];
  if (owner === undefined || owner.database_owner !== MIGRATOR_DATABASE_PRINCIPAL || owner.schema_owner !== MIGRATOR_DATABASE_PRINCIPAL) {
    return fail("DATABASE_PRINCIPAL_BOOTSTRAP_OWNERSHIP_INVALID");
  }
  await assertOwnershipShape(client);
}

/**
 * Existing deployments may still be owned by the pre-split application role.
 * An explicitly supplied owner-only bootstrap URL adopts all objects in the
 * current database before the migrator URL is used for an upgrade, then
 * retires that bootstrap principal without dropping the role. This path is
 * deliberately opt-in; without it a non-owner migrator fails closed before
 * running SQL.
 */
async function freezeRoleSessions(client: Client, role: string, pinnedSuperuser = false): Promise<void> {
  await client.query(`ALTER ROLE ${quoteIdentifier(role)} NOLOGIN`);
  const initialSessions = await readTargetRoleSessions(client, role);
  const initialDispositions = classifyTargetRoleSessions(initialSessions, pinnedSuperuser);
  const drainableSessions = initialSessions.filter((_, index) => initialDispositions[index] === "drain");
  for (const session of drainableSessions) {
    const result = await client.query<{ terminated: boolean }>("SELECT pg_terminate_backend($1::integer) AS terminated", [session.pid]);
    if (result.rows[0]?.terminated !== true) return fail("DATABASE_PRINCIPAL_TARGET_SESSIONS_ACTIVE");
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const activeSessions = await readTargetRoleSessions(client, role);
    const activeDispositions = classifyTargetRoleSessions(activeSessions, pinnedSuperuser);
    if (!activeDispositions.includes("drain")) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return fail("DATABASE_PRINCIPAL_TARGET_SESSIONS_ACTIVE");
}

async function assertNoPreparedTransactions(client: Client, roles: readonly string[] = [
  ...FINAL_DATABASE_PRINCIPALS,
  CLUSTER_ADMIN_DATABASE_PRINCIPAL,
  INVENTORY_READER_DATABASE_PRINCIPAL,
]): Promise<void> {
  const result = await client.query(`
    SELECT gid
      FROM pg_prepared_xacts
     WHERE database = current_database()
        OR owner = ANY($1::text[])
     LIMIT 1
  `, [roles]);
  if (result.rowCount !== 0) return fail("DATABASE_PRINCIPAL_PREPARED_TRANSACTION_ACTIVE");
}

async function bootstrapExistingOwners(client: Client, bootstrapRole: string, pinnedSuperuser: boolean): Promise<void> {
  if ([CLUSTER_ADMIN_DATABASE_PRINCIPAL, MIGRATOR_DATABASE_PRINCIPAL, RUNTIME_DATABASE_PRINCIPAL, ENTITLEMENT_WRITER_DATABASE_PRINCIPAL].includes(bootstrapRole as typeof CLUSTER_ADMIN_DATABASE_PRINCIPAL)) {
    return fail("DATABASE_PRINCIPAL_BOOTSTRAP_ROLE_RESERVED");
  }
  const database = await client.query<{ datname: string }>("SELECT current_database() AS datname");
  const databaseName = database.rows[0]?.datname;
  if (databaseName === undefined) return fail("DATABASE_PRINCIPAL_DATABASE_NOT_FOUND");
  const session = await readSessionPrincipal(client);
  if (!session.is_superuser && !session.can_create_role) {
    return fail("DATABASE_PRINCIPAL_BOOTSTRAP_OWNER_REQUIRED");
  }
  await assertNoPreparedTransactions(client, [...FINAL_DATABASE_PRINCIPALS, CLUSTER_ADMIN_DATABASE_PRINCIPAL, INVENTORY_READER_DATABASE_PRINCIPAL, bootstrapRole]);
  await client.query(`ALTER DATABASE ${quoteIdentifier(databaseName)} OWNER TO ${quoteIdentifier(MIGRATOR_DATABASE_PRINCIPAL)}`);
  await client.query(`ALTER SCHEMA public OWNER TO ${quoteIdentifier(MIGRATOR_DATABASE_PRINCIPAL)}`);
  await transferCurrentOwnedObjects(client, bootstrapRole, pinnedSuperuser);
  await revokeRoleMembershipEdges(client, bootstrapRole);
  await assertNoRoleMembership(client, MIGRATOR_DATABASE_PRINCIPAL);
  await assertNoRoleMembership(client, RUNTIME_DATABASE_PRINCIPAL);
  await assertNoRoleMembership(client, ENTITLEMENT_WRITER_DATABASE_PRINCIPAL);
  await assertNoRoleMembership(client, CLUSTER_ADMIN_DATABASE_PRINCIPAL);
  await client.query(`ALTER ROLE ${quoteIdentifier(bootstrapRole)} WITH NOLOGIN PASSWORD NULL ${pinnedSuperuser ? "SUPERUSER" : "NOSUPERUSER"} NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
}

async function grantTablePrivileges(client: Client): Promise<void> {
  const database = await client.query<{ datname: string }>("SELECT current_database() AS datname");
  const databaseName = database.rows[0]?.datname;
  if (databaseName === undefined) return fail("DATABASE_PRINCIPAL_DATABASE_NOT_FOUND");
  await normalizeDefaultPrivileges(client);
  await client.query(`REVOKE ALL ON DATABASE ${quoteIdentifier(databaseName)} FROM ${quoteIdentifier(RUNTIME_DATABASE_PRINCIPAL)}, ${quoteIdentifier(ENTITLEMENT_WRITER_DATABASE_PRINCIPAL)}`);
  await client.query(`GRANT CONNECT ON DATABASE ${quoteIdentifier(databaseName)} TO ${quoteIdentifier(RUNTIME_DATABASE_PRINCIPAL)}, ${quoteIdentifier(ENTITLEMENT_WRITER_DATABASE_PRINCIPAL)}`);
  const runtimeMutable = runtimeMutableRelations();
  const relations = await client.query<{ relname: string }>(`
    SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
  `);
  for (const relation of relations.rows) {
    const quoted = quoteIdentifier(relation.relname);
    await client.query(`REVOKE ALL ON TABLE public.${quoted} FROM PUBLIC, ${quoteIdentifier(RUNTIME_DATABASE_PRINCIPAL)}, ${quoteIdentifier(ENTITLEMENT_WRITER_DATABASE_PRINCIPAL)}`);
  }
  for (const relation of DATABASE_PRINCIPAL_RELATIONS) {
    const quoted = relationIdentifier(relation);
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.${quoted} TO ${quoteIdentifier(ENTITLEMENT_WRITER_DATABASE_PRINCIPAL)}`);
    if ((ENTITLEMENT_PROTECTED_RELATIONS as readonly string[]).includes(relation)) {
      await client.query(`GRANT SELECT ON TABLE public.${quoted} TO ${quoteIdentifier(RUNTIME_DATABASE_PRINCIPAL)}`);
    } else if (relation === SIGNUP_GRANT_RELATION) {
      await client.query(`GRANT SELECT, UPDATE ("remainingTokens", "updatedAt") ON TABLE public.${quoted} TO ${quoteIdentifier(RUNTIME_DATABASE_PRINCIPAL)}`);
    } else if (relation === TOKEN_LEDGER_RELATION) {
      await client.query(`GRANT SELECT, INSERT ON TABLE public.${quoted} TO ${quoteIdentifier(RUNTIME_DATABASE_PRINCIPAL)}`);
    } else if (runtimeMutable.includes(relation)) {
      await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.${quoted} TO ${quoteIdentifier(RUNTIME_DATABASE_PRINCIPAL)}`);
    }
  }
  await client.query(`REVOKE ALL ON SCHEMA public FROM PUBLIC, ${quoteIdentifier(RUNTIME_DATABASE_PRINCIPAL)}, ${quoteIdentifier(ENTITLEMENT_WRITER_DATABASE_PRINCIPAL)}`);
  await client.query(`GRANT USAGE ON SCHEMA public TO ${quoteIdentifier(RUNTIME_DATABASE_PRINCIPAL)}, ${quoteIdentifier(ENTITLEMENT_WRITER_DATABASE_PRINCIPAL)}`);
  const sequences = await client.query<{ relname: string }>("SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='S'");
  for (const sequence of sequences.rows) {
    const quoted = quoteIdentifier(sequence.relname);
    await client.query(`REVOKE ALL ON SEQUENCE public.${quoted} FROM PUBLIC, ${quoteIdentifier(RUNTIME_DATABASE_PRINCIPAL)}, ${quoteIdentifier(ENTITLEMENT_WRITER_DATABASE_PRINCIPAL)}`);
    await client.query(`GRANT USAGE, SELECT, UPDATE ON SEQUENCE public.${quoted} TO ${quoteIdentifier(ENTITLEMENT_WRITER_DATABASE_PRINCIPAL)}`);
    await client.query(`GRANT USAGE, SELECT ON SEQUENCE public.${quoted} TO ${quoteIdentifier(RUNTIME_DATABASE_PRINCIPAL)}`);
  }
}

async function verifyAcl(client: Client): Promise<void> {
  const result = await client.query<{ rolname: string; rolsuper: boolean; rolcreaterole: boolean; rolcreatedb: boolean; rolinherit: boolean; rolreplication: boolean; rolbypassrls: boolean }>(`
    SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolinherit, rolreplication, rolbypassrls
      FROM pg_roles
     WHERE rolname IN ($1, $2, $3)
     ORDER BY rolname
  `, [RUNTIME_DATABASE_PRINCIPAL, ENTITLEMENT_WRITER_DATABASE_PRINCIPAL, MIGRATOR_DATABASE_PRINCIPAL]);
  if (result.rows.length !== 3 || result.rows.some((row) => row.rolsuper || row.rolcreatedb || row.rolcreaterole || row.rolinherit || row.rolreplication || row.rolbypassrls)) return fail("DATABASE_PRINCIPAL_ROLE_ATTRIBUTES_INVALID");
  const protectedPolicy = await client.query<{ allowed: boolean; runtime_insert: boolean; writer_insert: boolean }>(`
    SELECT has_table_privilege($1, 'public."PlatformGrantOfferPolicy"', 'SELECT') AS allowed,
           has_table_privilege($1, 'public."PlatformGrantOfferPolicy"', 'INSERT') AS runtime_insert,
           has_table_privilege($2, 'public."PlatformGrantOfferPolicy"', 'INSERT') AS writer_insert
  `, [RUNTIME_DATABASE_PRINCIPAL, ENTITLEMENT_WRITER_DATABASE_PRINCIPAL]);
  const row = protectedPolicy.rows[0];
  if (row === undefined || !row.allowed || row.runtime_insert || !row.writer_insert) return fail("DATABASE_PRINCIPAL_ACL_INVALID");
  const directPrivileges = await client.query<{
    runtime_database_create: boolean;
    runtime_database_temp: boolean;
    writer_database_create: boolean;
    writer_database_temp: boolean;
    runtime_schema_create: boolean;
    writer_schema_create: boolean;
  }>(`
    SELECT has_database_privilege($1, current_database(), 'CREATE') AS runtime_database_create,
           has_database_privilege($1, current_database(), 'TEMPORARY') AS runtime_database_temp,
           has_database_privilege($2, current_database(), 'CREATE') AS writer_database_create,
           has_database_privilege($2, current_database(), 'TEMPORARY') AS writer_database_temp,
           has_schema_privilege($1, 'public', 'CREATE') AS runtime_schema_create,
           has_schema_privilege($2, 'public', 'CREATE') AS writer_schema_create
  `, [RUNTIME_DATABASE_PRINCIPAL, ENTITLEMENT_WRITER_DATABASE_PRINCIPAL]);
  const directPrivilegeRow = directPrivileges.rows[0];
  if (directPrivilegeRow === undefined
    || directPrivilegeRow.runtime_database_create
    || directPrivilegeRow.runtime_database_temp
    || directPrivilegeRow.writer_database_create
    || directPrivilegeRow.writer_database_temp
    || directPrivilegeRow.runtime_schema_create
    || directPrivilegeRow.writer_schema_create) {
    return fail("DATABASE_PRINCIPAL_ACL_INVALID");
  }
  for (const relation of ENTITLEMENT_PROTECTED_RELATIONS) {
    const protectedRelation = await client.query<{ runtime_insert: boolean; runtime_update: boolean; runtime_delete: boolean }>(`
      SELECT has_table_privilege($1, $2, 'INSERT') AS runtime_insert,
             has_table_privilege($1, $2, 'UPDATE') AS runtime_update,
             has_table_privilege($1, $2, 'DELETE') AS runtime_delete
    `, [RUNTIME_DATABASE_PRINCIPAL, `public.${relationIdentifier(relation)}`]);
    const protectedRow = protectedRelation.rows[0];
    if (protectedRow === undefined || protectedRow.runtime_insert || protectedRow.runtime_update || protectedRow.runtime_delete) return fail("DATABASE_PRINCIPAL_ACL_INVALID");
  }
  const publicPrivileges = await client.query<{ database_public: boolean; schema_public: boolean }>(`
    SELECT EXISTS (
             SELECT 1
               FROM pg_database database_row
               CROSS JOIN LATERAL aclexplode(COALESCE(database_row.datacl, acldefault('d', database_row.datdba))) privilege
              WHERE database_row.datname = current_database()
                AND privilege.grantee = 0::oid
                AND privilege.privilege_type IN ('CREATE', 'TEMPORARY')
           ) AS database_public,
           EXISTS (
             SELECT 1
               FROM pg_namespace schema_row
               CROSS JOIN LATERAL aclexplode(COALESCE(schema_row.nspacl, acldefault('n', schema_row.nspowner))) privilege
              WHERE schema_row.nspname = 'public'
                AND privilege.grantee = 0::oid
                AND privilege.privilege_type = 'CREATE'
           ) AS schema_public
  `);
  if (publicPrivileges.rows[0]?.database_public || publicPrivileges.rows[0]?.schema_public) return fail("DATABASE_PRINCIPAL_PUBLIC_ACL_INVALID");
  await assertInventoryReader(client, true, false);
  await assertNoStaleDefaultPrivileges(client);
  await assertNoUnexpectedRoleSettings(client);
}

async function reconcile(): Promise<void> {
  const migratorUrl = requiredUrl(MIGRATOR_DATABASE_URL_ENV);
  const runtimeUrl = requiredUrl(RUNTIME_DATABASE_URL_ENV);
  const writerUrl = requiredUrl(WRITER_DATABASE_URL_ENV);
  const adminUrl = requiredUrl(ADMIN_DATABASE_URL_ENV);
  const inventoryPassword = requiredSecret(INVENTORY_READER_PASSWORD_ENV);
  assertSameDatabase([migratorUrl, runtimeUrl, writerUrl, adminUrl]);
  if (roleUsername(migratorUrl) !== MIGRATOR_DATABASE_PRINCIPAL || roleUsername(runtimeUrl) !== RUNTIME_DATABASE_PRINCIPAL || roleUsername(writerUrl) !== ENTITLEMENT_WRITER_DATABASE_PRINCIPAL) return fail("DATABASE_PRINCIPAL_URL_USER_MISMATCH");
  if (new Set([roleUsername(migratorUrl), roleUsername(runtimeUrl), roleUsername(writerUrl)]).size !== 3) return fail("DATABASE_PRINCIPAL_URL_USER_MISMATCH");
  if (roleUsername(adminUrl) !== CLUSTER_ADMIN_DATABASE_PRINCIPAL) return fail("DATABASE_PRINCIPAL_ADMIN_URL_USER_MISMATCH");
  const admin = new Client({ connectionString: adminUrl.toString(), connectionTimeoutMillis: 5_000 });
  await admin.connect();
  try {
    await assertClusterAdminSession(admin);
    await assertOriginReplicationRole(admin);
    await admin.query("BEGIN");
    await lockCoordinator(admin);
    await ensureAllowedExtensions(admin);
    await ensureRole(admin, MIGRATOR_DATABASE_PRINCIPAL, rolePassword(migratorUrl), true);
    await ensureRole(admin, RUNTIME_DATABASE_PRINCIPAL, rolePassword(runtimeUrl), false);
    await ensureRole(admin, ENTITLEMENT_WRITER_DATABASE_PRINCIPAL, rolePassword(writerUrl), false);
    await ensureInventoryReader(admin, inventoryPassword);
    await freezeRoleSessions(admin, RUNTIME_DATABASE_PRINCIPAL);
    await freezeRoleSessions(admin, ENTITLEMENT_WRITER_DATABASE_PRINCIPAL);
    await freezeRoleSessions(admin, INVENTORY_READER_DATABASE_PRINCIPAL);
    await resetFinalRoleSettings(admin);
    await assertNoPreparedTransactions(admin);
    await revokeRoleMembershipEdges(admin, MIGRATOR_DATABASE_PRINCIPAL);
    await revokeRoleMembershipEdges(admin, RUNTIME_DATABASE_PRINCIPAL);
    await revokeRoleMembershipEdges(admin, ENTITLEMENT_WRITER_DATABASE_PRINCIPAL);
    await revokeRoleMembershipEdges(admin, CLUSTER_ADMIN_DATABASE_PRINCIPAL);
    await revokeRoleMembershipEdges(admin, INVENTORY_READER_DATABASE_PRINCIPAL);
    await transferCurrentOwnedObjects(admin, RUNTIME_DATABASE_PRINCIPAL, false);
    await transferCurrentOwnedObjects(admin, ENTITLEMENT_WRITER_DATABASE_PRINCIPAL, false);
    await assertRelationInventory(admin);
    await ensureInventoryAggregateFunction(admin);
    await setOwners(admin);
    await assertOwnershipShape(admin);
    await grantTablePrivileges(admin);
    await grantInventoryReader(admin, true);
    await assertInventoryReader(admin, true, false);
    await assertNoRoleMembership(admin, MIGRATOR_DATABASE_PRINCIPAL);
    await assertNoRoleMembership(admin, RUNTIME_DATABASE_PRINCIPAL);
    await assertNoRoleMembership(admin, ENTITLEMENT_WRITER_DATABASE_PRINCIPAL);
    await assertNoRoleMembership(admin, CLUSTER_ADMIN_DATABASE_PRINCIPAL);
    await assertFinalRoleShape(admin, false);
    await verifyAcl(admin);
    await admin.query(`ALTER ROLE ${quoteIdentifier(RUNTIME_DATABASE_PRINCIPAL)} LOGIN`);
    await admin.query(`ALTER ROLE ${quoteIdentifier(ENTITLEMENT_WRITER_DATABASE_PRINCIPAL)} LOGIN`);
    await admin.query(`ALTER ROLE ${quoteIdentifier(INVENTORY_READER_DATABASE_PRINCIPAL)} LOGIN`);
    await assertFinalRoleShape(admin, true);
    await assertInventoryReader(admin, true, true);
    await admin.query("COMMIT");
  } catch (error) {
    await admin.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await admin.end();
  }
  await verifyRuntimeAndWriterSessions(runtimeUrl, writerUrl);
}

type LegacyBootstrapContext = Readonly<{
  connectionString: string;
  originalRole: string;
  pinnedSuperuser: boolean;
  oid: string;
}>;

async function createClusterAdminFromLegacy(legacyUrl: URL, adminPassword: string): Promise<LegacyBootstrapContext> {
  const legacy = new Client({ connectionString: legacyUrl.toString(), connectionTimeoutMillis: 5_000 });
  await legacy.connect();
  try {
    await assertOriginReplicationRole(legacy);
    const session = await readSessionPrincipal(legacy);
    if (session.session_user !== session.current_user || !session.is_superuser) return fail("DATABASE_PRINCIPAL_BOOTSTRAP_OWNER_REQUIRED");
    if ([CLUSTER_ADMIN_DATABASE_PRINCIPAL, INVENTORY_READER_DATABASE_PRINCIPAL, LEGACY_BOOTSTRAP_DATABASE_PRINCIPAL].includes(session.session_user as typeof CLUSTER_ADMIN_DATABASE_PRINCIPAL)) {
      return fail("DATABASE_PRINCIPAL_BOOTSTRAP_ROLE_RESERVED");
    }
    await legacy.query("BEGIN");
    try {
      await lockCoordinator(legacy);
      await ensureClusterAdmin(legacy, adminPassword);
      await legacy.query("COMMIT");
    } catch (error) {
      await legacy.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
    return {
      connectionString: legacyUrl.toString(),
      originalRole: session.session_user,
      pinnedSuperuser: session.oid === "10",
      oid: session.oid,
    };
  } finally {
    await legacy.end();
  }
}

async function assertLegacyRetirementNameAvailable(client: Client, originalRole: string): Promise<void> {
  const result = await client.query<{ rolname: string }>("SELECT rolname FROM pg_roles WHERE rolname = $1", [LEGACY_BOOTSTRAP_DATABASE_PRINCIPAL]);
  if (originalRole === LEGACY_BOOTSTRAP_DATABASE_PRINCIPAL || result.rows.length !== 0) return fail("DATABASE_PRINCIPAL_LEGACY_ROLE_COLLISION");
}

async function probeClusterAdmin(connectionString: string): Promise<boolean> {
  const client = new Client({ connectionString, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
    await assertClusterAdminSession(client);
    await assertOriginReplicationRole(client);
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

/**
 * Tx A (creating the independent cluster admin) is intentionally committed
 * before the old pinned role is renamed.  If the process dies between those
 * transactions, the next invocation must resume adoption through the new
 * admin instead of trying to log in again as the old owner.  A sealed role or
 * an absent source means the previous adoption completed and is idempotent.
 */
async function discoverPendingLegacy(
  client: Client,
  legacyUrl: URL,
): Promise<LegacyBootstrapContext | null> {
  const originalRole = roleUsername(legacyUrl);
  const sealedRole = await client.query<{ oid: string; rolcanlogin: boolean; rolpassword: string | null; rolsuper: boolean; rolcreatedb: boolean; rolcreaterole: boolean; rolinherit: boolean; rolreplication: boolean; rolbypassrls: boolean }>(`
    SELECT oid::text, rolcanlogin, rolpassword, rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolreplication, rolbypassrls
      FROM pg_authid WHERE rolname = $1
  `, [LEGACY_BOOTSTRAP_DATABASE_PRINCIPAL]);
  const sealedRow = sealedRole.rows[0];
  if (sealedRow !== undefined) {
    const sealed = !sealedRow.rolcanlogin && sealedRow.rolsuper === (sealedRow.oid === "10") && sealedRow.rolpassword === null
      && !sealedRow.rolcreatedb && !sealedRow.rolcreaterole && !sealedRow.rolinherit
      && !sealedRow.rolreplication && !sealedRow.rolbypassrls;
    if (!sealed) return fail("DATABASE_PRINCIPAL_LEGACY_ROLE_NOT_RETIRED");
    await assertNoRoleMembership(client, LEGACY_BOOTSTRAP_DATABASE_PRINCIPAL);
    // A process may have been interrupted after the main conversion commit
    // but before its post-commit session drain.  The admin path is allowed to
    // heal that narrow state; an ordinary migrator must never inspect
    // pg_stat_activity because PostgreSQL masks other sessions there.
    await freezeRoleSessions(client, LEGACY_BOOTSTRAP_DATABASE_PRINCIPAL, sealedRow.oid === "10");
    const original = await client.query<{ rolname: string; rolcanlogin: boolean; rolsuper: boolean; rolcreatedb: boolean; rolcreaterole: boolean; rolinherit: boolean; rolreplication: boolean; rolbypassrls: boolean }>(`
      SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolreplication, rolbypassrls
        FROM pg_roles WHERE rolname = $1
    `, [originalRole]);
    const originalRow = original.rows[0];
    if (originalRow !== undefined) {
      const isRecreatedDataRole = FINAL_DATABASE_PRINCIPALS.includes(originalRole as typeof MIGRATOR_DATABASE_PRINCIPAL)
        && !originalRow.rolsuper && !originalRow.rolcreatedb && !originalRow.rolcreaterole
        && !originalRow.rolinherit && !originalRow.rolreplication && !originalRow.rolbypassrls
        && originalRow.rolcanlogin === (originalRole === MIGRATOR_DATABASE_PRINCIPAL);
      if (!isRecreatedDataRole) return fail("DATABASE_PRINCIPAL_LEGACY_ROLE_COLLISION");
    }
    await assertBootstrapOwnershipReady(client);
    // The old URL may still use ai_project_os_migrator.  That name is now
    // occupied by the newly-created ordinary migrator, while the original
    // OID10 is safely sealed under the maintenance name.  Treat this as the
    // completed state instead of mistaking the new migrator for the source.
    return null;
  }
  if (originalRole === LEGACY_BOOTSTRAP_DATABASE_PRINCIPAL) {
    return null;
  }
  const source = await client.query<{ oid: string; is_superuser: boolean; can_login: boolean }>(`
    SELECT oid::text, rolsuper AS is_superuser, rolcanlogin AS can_login
      FROM pg_roles WHERE rolname = $1
  `, [originalRole]);
  const row = source.rows[0];
  if (row === undefined) return null;
  // The legacy URL is an explicit identity proof, not a requirement to log
  // in again.  Tx A can have committed the cluster admin and the source
  // NOLOGIN barrier before the process was interrupted; accept that exact
  // superuser/OID state so the admin path can drain and resume adoption.
  if (!row.is_superuser) return fail("DATABASE_PRINCIPAL_BOOTSTRAP_OWNER_REQUIRED");
  return { connectionString: legacyUrl.toString(), originalRole, pinnedSuperuser: row.oid === "10", oid: row.oid };
}

/**
 * Seal the explicitly supplied legacy owner in a short, independently
 * committed transaction.  This is deliberately separate from the main
 * conversion transaction: once NOLOGIN is committed, no new legacy client
 * session can race the ownership transfer.  The old source may already be
 * NOLOGIN when a previous process was interrupted between this phase and its
 * main conversion; the exact OID and SUPERUSER checks make that recovery
 * path fail closed for an unrelated role.
 */
async function sealLegacySource(admin: Client, legacy: LegacyBootstrapContext): Promise<void> {
  await admin.query("BEGIN");
  try {
    await lockCoordinator(admin);
    await assertLegacyRetirementNameAvailable(admin, legacy.originalRole);
    const source = await admin.query<{ oid: string; is_superuser: boolean; can_login: boolean }>(
      "SELECT oid::text, rolsuper AS is_superuser, rolcanlogin AS can_login FROM pg_roles WHERE rolname = $1",
      [legacy.originalRole],
    );
    const sourceRow = source.rows[0];
    if (sourceRow === undefined || sourceRow.oid !== legacy.oid || !sourceRow.is_superuser) {
      return fail("DATABASE_PRINCIPAL_BOOTSTRAP_OWNER_REQUIRED");
    }
    if (sourceRow.can_login) await admin.query(`ALTER ROLE ${quoteIdentifier(legacy.originalRole)} NOLOGIN`);
    await admin.query("COMMIT");
  } catch (error) {
    await admin.query("ROLLBACK").catch(() => undefined);
    throw error;
  }

  // The authentication barrier is committed before this drain.  This call
  // intentionally runs on the cluster-admin connection, which can see and
  // terminate client backends across databases.
  await freezeRoleSessions(admin, legacy.originalRole, legacy.pinnedSuperuser);
}

async function bootstrapIfNeeded(): Promise<void> {
  const migratorUrl = requiredUrl(MIGRATOR_DATABASE_URL_ENV);
  const runtimeUrl = requiredUrl(RUNTIME_DATABASE_URL_ENV);
  const writerUrl = requiredUrl(WRITER_DATABASE_URL_ENV);
  const adminUrl = requiredUrl(ADMIN_DATABASE_URL_ENV);
  const legacyUrl = optionalUrl(LEGACY_DATABASE_URL_ENV);
  const inventoryPassword = requiredSecret(INVENTORY_READER_PASSWORD_ENV);
  const adminPassword = rolePassword(adminUrl);

  const coreUrls = [migratorUrl, runtimeUrl, writerUrl, adminUrl] as const;
  assertSameDatabase(coreUrls);
  if (roleUsername(migratorUrl) !== MIGRATOR_DATABASE_PRINCIPAL
    || roleUsername(runtimeUrl) !== RUNTIME_DATABASE_PRINCIPAL
    || roleUsername(writerUrl) !== ENTITLEMENT_WRITER_DATABASE_PRINCIPAL
    || roleUsername(adminUrl) !== CLUSTER_ADMIN_DATABASE_PRINCIPAL) {
    return fail("DATABASE_PRINCIPAL_URL_USER_MISMATCH");
  }

  // A successful first run seals the old URL's role. On restarts, use the
  // admin connection to inspect whether the old source still needs adoption;
  // never reconnect it merely because an operator has not removed the secret.
  const adminReady = await probeClusterAdmin(adminUrl.toString());
  if (!adminReady && legacyUrl === null) return fail("DATABASE_PRINCIPAL_LEGACY_BOOTSTRAP_URL_REQUIRED");
  if (legacyUrl !== null) assertSameDatabase([...coreUrls, legacyUrl]);
  let legacy = adminReady || legacyUrl === null ? null : await createClusterAdminFromLegacy(legacyUrl, adminPassword);
  const admin = new Client({ connectionString: adminUrl.toString(), connectionTimeoutMillis: 5_000 });
  let retiredRole: string | null = null;
  let retiredRoleConnectionString: string | null = null;
  let retiredRolePinned = false;
  await admin.connect();
  try {
    await assertClusterAdminSession(admin);
    await assertOriginReplicationRole(admin);

    // Discovery and the authentication barrier happen before the long
    // conversion transaction.  On a restart after Tx A, the explicit legacy
    // URL is only an identifier: discoverPendingLegacy can adopt a source
    // that is already NOLOGIN without trying to authenticate as it again.
    if (legacy === null && adminReady && legacyUrl !== null) legacy = await discoverPendingLegacy(admin, legacyUrl);
    if (legacy !== null) await sealLegacySource(admin, legacy);

    let mainCommitIssued = false;
    let mainCommitted = false;
    await admin.query("BEGIN");
    try {
      await lockCoordinator(admin);
      if (legacy !== null) await assertLegacyRetirementNameAvailable(admin, legacy.originalRole);
      if (legacy !== null) {
        // Re-discover under the main conversion lock.  The pre-seal context is
        // intentionally not trusted across the independent transaction.
        const source = await admin.query<{ oid: string; is_superuser: boolean; can_login: boolean }>(
          "SELECT oid::text, rolsuper AS is_superuser, rolcanlogin AS can_login FROM pg_roles WHERE rolname = $1",
          [legacy.originalRole],
        );
        if (source.rows[0] === undefined
          || source.rows[0].oid !== legacy.oid
          || !source.rows[0].is_superuser
          || source.rows[0].can_login) {
          return fail("DATABASE_PRINCIPAL_BOOTSTRAP_OWNER_REQUIRED");
        }
        await admin.query(`ALTER ROLE ${quoteIdentifier(legacy.originalRole)} RENAME TO ${quoteIdentifier(LEGACY_BOOTSTRAP_DATABASE_PRINCIPAL)}`);
      }
      await ensureClusterAdmin(admin, adminPassword);
      await ensureRole(admin, MIGRATOR_DATABASE_PRINCIPAL, rolePassword(migratorUrl), true);
      await ensureRole(admin, RUNTIME_DATABASE_PRINCIPAL, rolePassword(runtimeUrl), false);
      await ensureRole(admin, ENTITLEMENT_WRITER_DATABASE_PRINCIPAL, rolePassword(writerUrl), false);
      await ensureInventoryReader(admin, inventoryPassword);
      await freezeRoleSessions(admin, RUNTIME_DATABASE_PRINCIPAL);
      await freezeRoleSessions(admin, ENTITLEMENT_WRITER_DATABASE_PRINCIPAL);
      await freezeRoleSessions(admin, INVENTORY_READER_DATABASE_PRINCIPAL);
      await resetFinalRoleSettings(admin);
      await assertNoPreparedTransactions(admin);
      await revokeRoleMembershipEdges(admin, MIGRATOR_DATABASE_PRINCIPAL);
      await revokeRoleMembershipEdges(admin, RUNTIME_DATABASE_PRINCIPAL);
      await revokeRoleMembershipEdges(admin, ENTITLEMENT_WRITER_DATABASE_PRINCIPAL);
      await revokeRoleMembershipEdges(admin, CLUSTER_ADMIN_DATABASE_PRINCIPAL);
      await revokeRoleMembershipEdges(admin, INVENTORY_READER_DATABASE_PRINCIPAL);

      if (legacy !== null) {
        await transferCurrentOwnedObjects(admin, RUNTIME_DATABASE_PRINCIPAL, false);
        await transferCurrentOwnedObjects(admin, ENTITLEMENT_WRITER_DATABASE_PRINCIPAL, false);
        await normalizeDefaultPrivileges(admin, LEGACY_BOOTSTRAP_DATABASE_PRINCIPAL);
        await grantInventoryReader(admin);
        // This is the final privileged statement in the legacy transaction.
        // The helper freezes/transfers the source, removes every membership
        // edge, and seals the OID10 exception without attempting NOSUPERUSER.
        await bootstrapExistingOwners(admin, LEGACY_BOOTSTRAP_DATABASE_PRINCIPAL, legacy.pinnedSuperuser);
        await assertRetiredRoleShape(admin, LEGACY_BOOTSTRAP_DATABASE_PRINCIPAL, legacy.pinnedSuperuser);
        await ensureAllowedExtensions(admin);
        retiredRole = LEGACY_BOOTSTRAP_DATABASE_PRINCIPAL;
        const retiredUrl = new URL(legacy.connectionString);
        retiredUrl.username = LEGACY_BOOTSTRAP_DATABASE_PRINCIPAL;
        retiredRoleConnectionString = retiredUrl.toString();
        retiredRolePinned = legacy.pinnedSuperuser;
      } else {
        await ensureAllowedExtensions(admin);
        await transferCurrentOwnedObjects(admin, RUNTIME_DATABASE_PRINCIPAL, false);
        await transferCurrentOwnedObjects(admin, ENTITLEMENT_WRITER_DATABASE_PRINCIPAL, false);
        const database = await admin.query<{ datname: string }>("SELECT current_database() AS datname");
        const databaseName = database.rows[0]?.datname;
        if (databaseName === undefined) return fail("DATABASE_PRINCIPAL_DATABASE_NOT_FOUND");
        await admin.query(`ALTER DATABASE ${quoteIdentifier(databaseName)} OWNER TO ${quoteIdentifier(MIGRATOR_DATABASE_PRINCIPAL)}`);
        await admin.query(`ALTER SCHEMA public OWNER TO ${quoteIdentifier(MIGRATOR_DATABASE_PRINCIPAL)}`);
        await normalizeDefaultPrivileges(admin);
        await grantInventoryReader(admin);
      }
      await assertBootstrapOwnershipReady(admin);
      // Do not issue ROLLBACK after COMMIT has been sent.  A transport or
      // server error at that boundary cannot safely be treated as if the
      // conversion were uncommitted; the persisted state is designed to be
      // safe for the next admin-led retry instead.
      mainCommitIssued = true;
      await admin.query("COMMIT");
      mainCommitted = true;
    } catch (error) {
      if (!mainCommitIssued) await admin.query("ROLLBACK").catch(() => undefined);
      throw error;
    }

    if (mainCommitted && retiredRole !== null) {
      // Keep the cluster-admin session alive after the main commit.  This is a
      // fresh transaction and coordinator lock so a narrow post-commit
      // interruption is self-healing on the next invocation.
      let postCommitIssued = false;
      await admin.query("BEGIN");
      try {
        await lockCoordinator(admin);
        await freezeRoleSessions(admin, retiredRole, retiredRolePinned);
        await assertRetiredRoleShape(admin, retiredRole, retiredRolePinned);
        await assertNoRoleMembership(admin, retiredRole);
        await assertNoStaleDefaultPrivileges(admin, retiredRole);
        await assertTargetRoleSessionsDrained(admin, retiredRole, retiredRolePinned);
        postCommitIssued = true;
        await admin.query("COMMIT");
      } catch (error) {
        if (!postCommitIssued) await admin.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    }
  } finally {
    await admin.end();
  }

  const verifier = new Client({ connectionString: migratorUrl.toString(), connectionTimeoutMillis: 5_000 });
  try {
    await verifier.connect();
    await verifyMigratorSession(verifier);
    await assertFinalRoleShape(verifier, false);
    await assertInventoryReader(verifier, false, false);
    await assertNoUnexpectedRoleSettings(verifier);
    for (const role of [...FINAL_DATABASE_PRINCIPALS, CLUSTER_ADMIN_DATABASE_PRINCIPAL, INVENTORY_READER_DATABASE_PRINCIPAL]) {
      await assertNoRoleMembership(verifier, role);
    }
    if (retiredRole !== null) {
      // pg_roles masks rolpassword for non-superusers.  The cluster-admin
      // transaction already proved PASSWORD NULL; this verifier checks only
      // attributes visible to the ordinary migrator session.
      await assertRetiredRoleAttributes(verifier, retiredRole, retiredRolePinned);
      await assertNoRoleMembership(verifier, retiredRole);
      await assertNoStaleDefaultPrivileges(verifier, retiredRole);
    }
  } catch (error) {
    if (error instanceof DatabasePrincipalError) throw error;
    return fail("DATABASE_PRINCIPAL_ROLE_SESSION_INVALID");
  } finally {
    await verifier.end().catch(() => undefined);
  }
  if (retiredRoleConnectionString !== null) await verifyRetiredRoleCannotLogin(retiredRoleConnectionString);
}

function parseOperation(): "reconcile" | "bootstrap-if-needed" {
  const args = process.argv.slice(2);
  if (args.length === 0) return "reconcile";
  if (args.length === 1 && args[0] === "--bootstrap-if-needed") return "bootstrap-if-needed";
  return fail("DATABASE_PRINCIPAL_ARGUMENT_UNKNOWN");
}

async function main(): Promise<void> {
  const operation = parseOperation() === "bootstrap-if-needed" ? bootstrapIfNeeded() : reconcile();
  await operation;
  console.log(JSON.stringify({ ok: true, component: "database-principal-reconcile", migrator: MIGRATOR_DATABASE_PRINCIPAL, runtime: RUNTIME_DATABASE_PRINCIPAL, writer: ENTITLEMENT_WRITER_DATABASE_PRINCIPAL }));
}

void main().catch((error: unknown) => {
  console.error(error instanceof DatabasePrincipalError ? error.code : "DATABASE_PRINCIPAL_RECONCILE_FAILED");
  process.exitCode = 1;
});
