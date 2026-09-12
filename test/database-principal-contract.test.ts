import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DATABASE_PRINCIPAL_INVOKER_FUNCTION_MATRIX } from "../src/lib/database-principal-catalog";

const compose = readFileSync("compose.yaml", "utf8");
const envExample = readFileSync(".env.example", "utf8");
const db = readFileSync("src/lib/db.ts", "utf8");
const reconcile = readFileSync("scripts/reconcile-database-principals.ts", "utf8");
const postgresGate = readFileSync("test/database-principal-postgres.test.ts", "utf8");
const migration = readFileSync("prisma/migrations/20260910050000_harden_account_entitlement_database_principals/migration.sql", "utf8");
const catalog = readFileSync("src/lib/database-principal-catalog.ts", "utf8");
const activation = readFileSync("src/lib/account-entitlement-activation-service.ts", "utf8");
const backfill = readFileSync("src/lib/account-entitlement-backfill-service.ts", "utf8");
const policy = readFileSync("src/lib/platform-grant-offer-policy-service.ts", "utf8");
const auth = readFileSync("src/lib/auth.ts", "utf8");
const github = readFileSync("src/lib/github-oauth.ts", "utf8");
const oidc = readFileSync("src/lib/oidc.ts", "utf8");
const workspaces = readFileSync("src/lib/workspaces.ts", "utf8");
const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as { scripts?: Record<string, string> };

test("invoker helper ACL matrix is complete, immutable and uniquely signed", () => {
  assert.equal(DATABASE_PRINCIPAL_INVOKER_FUNCTION_MATRIX.length, 43);
  assert.equal(DATABASE_PRINCIPAL_INVOKER_FUNCTION_MATRIX.filter((helper) => helper.runtime).length, 42);
  assert.equal(DATABASE_PRINCIPAL_INVOKER_FUNCTION_MATRIX.filter((helper) => helper.entitlementWriter).length, 8);
  assert.equal(DATABASE_PRINCIPAL_INVOKER_FUNCTION_MATRIX.filter((helper) => helper.runtime && helper.entitlementWriter).length, 7);
  const signatures = DATABASE_PRINCIPAL_INVOKER_FUNCTION_MATRIX.map((helper) => `${helper.name}(${helper.identityArguments})`);
  assert.equal(new Set(signatures).size, DATABASE_PRINCIPAL_INVOKER_FUNCTION_MATRIX.length);
  assert.ok(Object.isFrozen(DATABASE_PRINCIPAL_INVOKER_FUNCTION_MATRIX));
  const ownerHelper = DATABASE_PRINCIPAL_INVOKER_FUNCTION_MATRIX.find((helper) => helper.name === "workspace_role_check_owner");
  assert.deepEqual(ownerHelper, {
    name: "workspace_role_check_owner",
    identityArguments: "uuid",
    runtime: true,
    entitlementWriter: true,
    reason: "workspace enabled-owner invariant validation",
  });
  assert.ok(DATABASE_PRINCIPAL_INVOKER_FUNCTION_MATRIX.every((helper) => Object.isFrozen(helper) && helper.reason.trim().length > 0));
});

test("database principals are explicit and separated across Compose services", () => {
  assert.match(compose, /POSTGRES_USER:\s*\$\{POSTGRES_USER:-ai_project_os_cluster_admin\}/u);
  assert.match(compose, /POSTGRES_CLUSTER_ADMIN_PASSWORD/u);
  assert.match(compose, /POSTGRES_MIGRATOR_PASSWORD/u);
  assert.match(compose, /POSTGRES_ENTITLEMENT_INVENTORY_READER_PASSWORD/u);
  assert.match(compose, /principal-bootstrap:/u);
  assert.match(compose, /scripts\/reconcile-database-principals\.ts", "--bootstrap-if-needed/u);
  assert.match(compose, /ENTITLEMENT_DATABASE_URL:/u);
  assert.match(compose, /MIGRATOR_DATABASE_URL:/u);
  assert.match(compose, /principal-bootstrap:[\s\S]*?condition: service_completed_successfully[\s\S]*?migrate:/u);
  assert.ok(compose.indexOf("principal-bootstrap:") < compose.indexOf("migrate:"));
  assert.ok(compose.indexOf("migrate:") < compose.indexOf("reconcile:"));
  assert.ok(compose.indexOf("reconcile:") < compose.indexOf("app:"));
  assert.ok(compose.indexOf("reconcile:") < compose.indexOf("worker:"));
  const principalBootstrap = compose.match(/\n  principal-bootstrap:\n([\s\S]*?)(?=\n  [a-z-]+:\n|\nvolumes:)/u)?.[1] ?? "";
  assert.notEqual(principalBootstrap, "");
  assert.match(principalBootstrap, /DATABASE_PRINCIPAL_ADMIN_URL/u);
  assert.match(principalBootstrap, /DATABASE_PRINCIPAL_LEGACY_BOOTSTRAP_URL/u);
  const worker = compose.match(/\n  worker:\n([\s\S]*?)(?=\n  [a-z-]+:\n|\nvolumes:)/u)?.[1] ?? "";
  assert.notEqual(worker, "");
  const app = compose.match(/\n  app:\n([\s\S]*?)(?=\n  [a-z-]+:\n|\nvolumes:)/u)?.[1] ?? "";
  assert.doesNotMatch(`${app}\n${worker}`, /DATABASE_PRINCIPAL_ADMIN_URL|DATABASE_PRINCIPAL_LEGACY_BOOTSTRAP_URL|MIGRATOR_DATABASE_URL|POSTGRES_ENTITLEMENT_INVENTORY_READER_PASSWORD/u);
  assert.doesNotMatch(worker, /ENTITLEMENT_DATABASE_URL/u);
  assert.match(compose, /reconcile:\n[\s\S]*?condition: service_completed_successfully/u);
  assert.match(envExample, /DATABASE_PRINCIPAL_ADMIN_URL=/u);
  assert.match(envExample, /DATABASE_PRINCIPAL_LEGACY_BOOTSTRAP_URL=/u);
  assert.equal(packageJson.scripts?.["db:principals:bootstrap"], "tsx scripts/reconcile-database-principals.ts --bootstrap-if-needed");
});

test("writer access has a fail-closed URL and observed PostgreSQL session check", () => {
  assert.match(db, /ENTITLEMENT_WRITER_DATABASE_PRINCIPAL = "ai_project_os_entitlement_writer"/u);
  assert.match(db, /ENTITLEMENT_DATABASE_URL_REQUIRED/u);
  assert.match(db, /ENTITLEMENT_DATABASE_PRINCIPAL_INVALID/u);
  assert.match(db, /session_user, current_user/u);
  assert.match(db, /ENTITLEMENT_WRITER_SESSION_INVALID/u);
  assert.doesNotMatch(db, /getEntitlementDb[\s\S]{0,500}getDb\(\)/u);
  assert.match(activation, /assertEntitlementWriterSession/u);
  assert.match(backfill, /assertEntitlementWriterSession/u);
  assert.match(policy, /assertEntitlementWriterSession/u);
  for (const source of [auth, github, oidc, workspaces]) assert.match(source, /assertEntitlementWriterSession/u);
});

test("ACL reconcile rejects drift and does not widen ordinary roles with DDL privileges", () => {
  assert.match(reconcile, /DATABASE_PRINCIPAL_RELATION_INVENTORY_MISMATCH/u);
  assert.match(reconcile, /ALTER DATABASE/u);
  assert.match(reconcile, /ALTER SCHEMA public OWNER/u);
  assert.match(reconcile, /REVOKE CREATE, TEMPORARY ON DATABASE/u);
  assert.match(reconcile, /DATABASE_PRINCIPAL_BOOTSTRAP_OWNER_REQUIRED/u);
  assert.match(reconcile, /--bootstrap-if-needed/u);
  assert.match(reconcile, /DATABASE_PRINCIPAL_ARGUMENT_UNKNOWN/u);
  assert.match(reconcile, /assertSameDatabase\(coreUrls/u);
  assert.match(reconcile, /probeClusterAdmin/u);
  assert.match(reconcile, /DATABASE_PRINCIPAL_LEGACY_BOOTSTRAP_URL_REQUIRED/u);
  assert.doesNotMatch(reconcile, /REVOKE ALL ON ROLE/u);
  assert.doesNotMatch(reconcile, /GRANT[^\n]*(?:TRIGGER|REFERENCES)[^\n]*TO/u);
  assert.match(reconcile, /NOINHERIT NOREPLICATION NOBYPASSRLS/u);
  assert.match(reconcile, /NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS/u);
  assert.match(reconcile, /rolreplication/u);
  assert.match(reconcile, /!session\.is_superuser && !session\.can_create_role/u);
  assert.match(reconcile, /assertFinalRoleShape/u);
  assert.match(reconcile, /verifyRuntimeAndWriterSessions/u);
  assert.match(reconcile, /verifyMigratorSession\(verifier\)/u);
  assert.match(reconcile, /REASSIGN OWNED BY/u);
  assert.match(reconcile, /REASSIGN OWNED BY \$\{quoteIdentifier\(sourceRole\)\} TO \$\{quoteIdentifier\(CLUSTER_ADMIN_DATABASE_PRINCIPAL\)\}/u);
  assert.match(reconcile, /readCurrentOwnedObjects/u);
  assert.match(reconcile, /defaultPrivilegeOwners\(legacyOwner\)/u);
  assert.match(reconcile, /const revocationTargets = new Set<string>\(\[quoteIdentifier\(group\.owner\), "PUBLIC"\]\)/u);
  assert.match(reconcile, /GRANT EXECUTE ON FUNCTIONS TO PUBLIC/u);
  assert.match(reconcile, /hardenedMigrator/u);
  assert.match(reconcile, /privilege\.object_type !== "f"/u);
  assert.match(reconcile, /row\.extname === "plpgsql"[\s\S]*row\.owner_oid !== "10"/u);
  assert.match(reconcile, /row\.schema_name !== "public" \|\| row\.owner !== CLUSTER_ADMIN_DATABASE_PRINCIPAL/u);
  assert.doesNotMatch(reconcile, /ALTER EXTENSION[^\n]*OWNER TO/u);
  assert.match(reconcile, /NOLOGIN[\s\S]*NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS/u);
  assert.match(reconcile, /DATABASE_PRINCIPAL_BOOTSTRAP_ROLE_RESERVED/u);
  assert.match(reconcile, /DATABASE_PRINCIPAL_BOOTSTRAP_SESSIONS_ACTIVE/u);
  assert.match(reconcile, /async function readTargetRoleSessions/u);
  assert.match(reconcile, /function targetRoleSessionPredicate/u);
  assert.match(reconcile, /backend_type === "client backend" \|\| session\.backend_type === "walsender"/u);
  assert.match(reconcile, /function classifyTargetRoleSession/u);
  assert.match(reconcile, /DATABASE_PRINCIPAL_TARGET_BACKGROUND_WORKER_ACTIVE/u);
  assert.match(reconcile, /session\.role_oid === "10"/u);
  assert.match(reconcile, /session\.backend_type === "logical replication launcher"/u);
  assert.match(reconcile, /session\.datid === null/u);
  assert.match(reconcile, /session\.datname === null/u);
  const sessionDrain = reconcile.match(/async function freezeRoleSessions\([\s\S]*?\n\}\n\nasync function assertNoPreparedTransactions/u)?.[0] ?? "";
  assert.notEqual(sessionDrain, "");
  assert.match(sessionDrain, /readTargetRoleSessions\(client, role\)/u);
  assert.match(sessionDrain, /const drainableSessions = initialSessions\.filter/u);
  assert.match(sessionDrain, /classifyTargetRoleSessions\(initialSessions, pinnedSuperuser\)/u);
  assert.match(sessionDrain, /classifyTargetRoleSessions\(activeSessions, pinnedSuperuser\)/u);
  assert.match(sessionDrain, /pg_terminate_backend\(\$1::integer\)/u);
  assert.doesNotMatch(sessionDrain, /pg_terminate_backend\(\$1::integer,\s*\d+\)/u);
  assert.doesNotMatch(reconcile, /freezeRoleSessions\(client, bootstrapRole, pinnedSuperuser\)/u);
  assert.match(reconcile, /freezeRoleSessions\(admin, legacy\.originalRole, legacy\.pinnedSuperuser\)/u);
  assert.match(reconcile, /freezeRoleSessions\(client, LEGACY_BOOTSTRAP_DATABASE_PRINCIPAL, sealedRow\.oid === "10"\)/u);
  assert.match(reconcile, /freezeRoleSessions\(admin, retiredRole, retiredRolePinned\)/u);
  assert.match(reconcile, /assertTargetRoleSessionsDrained\(admin, retiredRole, retiredRolePinned\)/u);
  assert.doesNotMatch(reconcile, /assertTargetRoleSessionsDrained\(verifier, retiredRole, retiredRolePinned\)/u);
  assert.match(reconcile, /async function sealLegacySource/u);
  assert.match(reconcile, /if \(sourceRow\.can_login\) await admin\.query\(`ALTER ROLE/u);
  assert.match(reconcile, /mainCommitIssued/u);
  assert.match(reconcile, /if \(!mainCommitIssued\) await admin\.query\("ROLLBACK"\)/u);
  assert.match(reconcile, /let postCommitIssued = false/u);
  assert.match(reconcile, /if \(!postCommitIssued\) await admin\.query\("ROLLBACK"\)/u);
  assert.match(reconcile, /DATABASE_PRINCIPAL_BOOTSTRAP_OWNERSHIP_INVALID/u);
  assert.match(reconcile, /DATABASE_PRINCIPAL_EXTERNAL_ROLE_SETTINGS_FORBIDDEN/u);
  assert.match(reconcile, /DATABASE_PRINCIPAL_SESSION_REPLICATION_ROLE_INVALID/u);
  assert.match(reconcile, /DATABASE_PRINCIPAL_RELATION_OWNER_INVALID/u);
  assert.match(reconcile, /DATABASE_PRINCIPAL_NONCLASS_OWNER_INVALID/u);
  assert.match(reconcile, /DATABASE_PRINCIPAL_APPLICATION_OWNER_INVALID/u);
  assert.match(reconcile, /const FIRST_NORMAL_OBJECT_ID = 16384/u);
  const unsupportedOwnership = reconcile.match(/async function assertNoUnsupportedCurrentOwnership\([\s\S]*?\n\}\n\nasync function isExtensionMember/u)?.[0] ?? "";
  assert.notEqual(unsupportedOwnership, "");
  assert.match(unsupportedOwnership, /const unsupportedCatalogNamespaceClause/u);
  assert.match(unsupportedOwnership, /catalog_row\.oid >= \$\{FIRST_NORMAL_OBJECT_ID\}/u);
  assert.match(unsupportedOwnership, /EXISTS \([\s\S]*?oid = catalog_row\.\$\{namespaceColumn\}/u);
  assert.doesNotMatch(unsupportedOwnership, /AND NOT EXISTS \([\s\S]*?oid = catalog_row\.\$\{namespaceColumn\}/u);
  assert.match(reconcile, /ALTER ROLE[^\n]*RESET ALL/u);
  assert.match(reconcile, /ALTER ROLE[^\n]*IN DATABASE[^\n]*RESET ALL/u);
  assert.match(reconcile, /REVOKE ALL ON DATABASE/u);
  assert.match(reconcile, /REVOKE ALL ON TABLE public\./u);
  assert.match(reconcile, /REVOKE ALL ON SEQUENCE public\./u);
  assert.match(reconcile, /async function revokePublicDdl/u);
  assert.match(reconcile, /REVOKE CREATE, TEMPORARY ON DATABASE[^\n]*FROM PUBLIC/u);
  assert.match(reconcile, /REVOKE CREATE ON SCHEMA public FROM PUBLIC/u);
  const inventoryReaderGrant = reconcile.match(/async function grantInventoryReader\([\s\S]*?\n\}/u)?.[0] ?? "";
  assert.notEqual(inventoryReaderGrant, "");
  assert.ok(inventoryReaderGrant.indexOf("revokePublicDdl") < inventoryReaderGrant.indexOf("REVOKE ALL ON DATABASE"));
  assert.match(reconcile, /quoteIdentifier\(RUNTIME_DATABASE_PRINCIPAL\)/u);
  assert.match(reconcile, /quoteIdentifier\(ENTITLEMENT_WRITER_DATABASE_PRINCIPAL\)/u);
  assert.match(reconcile, /ALTER DEFAULT PRIVILEGES/u);
  assert.match(reconcile, /DATABASE_PRINCIPAL_DEFAULT_ACL_INVALID/u);
  assert.match(reconcile, /DATABASE_PRINCIPAL_DEFAULT_ACL_OWNER_REQUIRED/u);
  assert.match(reconcile, /assertRetiredRoleShape/u);
  assert.match(reconcile, /FROM pg_authid/u);
  assert.match(reconcile, /assertRetiredRoleShape\(admin, LEGACY_BOOTSTRAP_DATABASE_PRINCIPAL, legacy\.pinnedSuperuser\)/u);
  assert.match(reconcile, /assertRetiredRoleAttributes\(verifier, retiredRole, retiredRolePinned\)/u);
  const pendingLegacy = reconcile.match(/async function discoverPendingLegacy\([\s\S]*?\n\}\n\nasync function bootstrapIfNeeded/u)?.[0] ?? "";
  assert.notEqual(pendingLegacy, "");
  assert.match(pendingLegacy, /FROM pg_authid/u);
  assert.doesNotMatch(pendingLegacy, /FROM pg_roles[\s\S]*rolpassword/u);
  assert.match(pendingLegacy, /if \(!row\.is_superuser\)/u);
  assert.match(reconcile, /verifyRetiredRoleCannotLogin/u);
  assert.match(reconcile, /transferCurrentOwnedObjects/u);
  assert.match(reconcile, /GRANT EXECUTE ON FUNCTION/u);
  assert.match(catalog, /ACCOUNT_ENTITLEMENT_SIGNUP_GRANT_CLOSURE_FUNCTION/u);
  assert.match(catalog, /DATABASE_PRINCIPAL_INVOKER_FUNCTION_MATRIX/u);
  assert.match(reconcile, /DATABASE_PRINCIPAL_INVOKER_FUNCTION_MATRIX/u);
  assert.match(reconcile, /invokerFunctionSignature/u);
  assert.match(reconcile, /REVOKE ALL ON FUNCTION \$\{signature\} FROM PUBLIC/u);
  assert.match(reconcile, /GRANT EXECUTE ON FUNCTION \$\{signature\} TO \$\{grantees\.join/u);
  assert.match(reconcile, /helperRow\.prosecdef/u);
  assert.match(reconcile, /helperRow\.public_execute/u);
  assert.match(reconcile, /runtimeHelperCount !== 42/u);
  assert.match(reconcile, /writerHelperCount !== 8/u);
  assert.match(reconcile, /revokeRoleMembershipEdges\(admin, MIGRATOR_DATABASE_PRINCIPAL\)/u);
  assert.match(reconcile, /ALTER ROLE \$\{identifier\} WITH LOGIN SUPERUSER CREATEDB CREATEROLE/u);
  assert.match(reconcile, /assertNoRoleMembership/u);
  assert.match(reconcile, /value\.search !== "" \|\| value\.hash !== ""/u);
  assert.doesNotMatch(reconcile, /pg_ts_parser|prsowner|pg_ts_template|tmplowner/u);
});

test("protected entitlement relations require the real session principal", () => {
  assert.match(migration, /session_user/u);
  assert.match(migration, /ai_project_os_entitlement_writer/u);
  assert.match(migration, /pg_get_userbyid\(c\.relowner\)/u);
  assert.match(migration, /ERRCODE = '42501'/u);
  assert.match(migration, /IF TG_OP = 'DELETE'\s+THEN\s+RETURN OLD;\s+END IF;\s+RETURN NEW;/u);
  const entitlementMigration = readFileSync("prisma/migrations/20260911010000_add_platform_token_governance/migration.sql", "utf8");
  assert.match(entitlementMigration, /CREATE OR REPLACE FUNCTION "platform_token_runtime_apply"[\s\S]*SECURITY DEFINER[\s\S]*SET search_path = pg_catalog, public/u);
  assert.match(entitlementMigration, /CREATE OR REPLACE FUNCTION "platform_token_governance_apply"[\s\S]*SECURITY DEFINER[\s\S]*SET search_path = pg_catalog, public/u);
  for (const relation of [
    "PlatformGrantOfferPolicy",
    "AccountEntitlementActivation",
    "AccountEntitlementBackfillRun",
    "PlatformTokenGrant",
    "PlatformTokenLedgerEntry",
  ]) {
    assert.match(migration, new RegExp(`"${relation}_session_principal_guard"`, "u"));
  }
  assert.match(catalog, /DATABASE_PRINCIPAL_RELATIONS/u);
  assert.match(catalog, /ENTITLEMENT_PROTECTED_RELATIONS/u);
});

test("the PostgreSQL gate exercises production reconcile and both real principals", () => {
  assert.match(postgresGate, /scripts\/reconcile-database-principals\.ts/u);
  assert.match(postgresGate, /DATABASE_PRINCIPAL_ADMIN_URL/u);
  assert.match(postgresGate, /DATABASE_PRINCIPAL_LEGACY_BOOTSTRAP_URL/u);
  assert.match(postgresGate, /getEntitlementDb\(\)/u);
  assert.match(postgresGate, /reservePlatformTokens/u);
  assert.match(postgresGate, /SET SESSION AUTHORIZATION/u);
  assert.match(postgresGate, /AI_SIGNUP_GRANT/u);
  assert.match(postgresGate, /DATABASE_PRINCIPAL_INVOKER_FUNCTION_MATRIX/u);
  assert.match(postgresGate, /assertInvokerHelperAcls/u);
  assert.match(postgresGate, /pg_get_function_identity_arguments/u);
  assert.match(postgresGate, /AccountEntitlementBackfillRun/u);
  assert.match(postgresGate, /DELETE FROM "PlatformTokenLedgerEntry"/u);
  assert.match(postgresGate, /runPrincipalBootstrap\(runtimePassword, migratorPassword, writerPassword(?:, [^)]*)?\)/u);
  assert.match(postgresGate, /await runProductionReconcile\(runtimePassword, migratorPassword, writerPassword\)/u);
  assert.match(postgresGate, /REASSIGN OWNED BY/u);
  const ownershipHelper = postgresGate.match(/async function transferPublicOwnership\([\s\S]*?\n\}\n\nasync function findRepresentativeOwnedObjects/u)?.[0] ?? "";
  assert.notEqual(ownershipHelper, "");
  assert.ok(ownershipHelper.indexOf("REASSIGN OWNED BY") < ownershipHelper.indexOf("ALTER DATABASE"));
  assert.doesNotMatch(ownershipHelper, /for \(const relation of relations\.rows\)/u);
  assert.match(postgresGate, /transferPublicOwnership\(admin, legacyRole, initialDatabaseOwner\)/u);
  assert.match(postgresGate, /transferPublicOwnership\(admin, "ai_project_os_legacy_bootstrap", initialDatabaseOwner\)/u);
  assert.match(postgresGate, /cleanupAssertionError \?\?= error/u);
  assert.match(postgresGate, /database-principal cleanup left role/u);
  assert.match(postgresGate, /normalizedDefaults/u);
  assert.match(postgresGate, /migratorDefaults/u);
  assert.match(postgresGate, /retiredDefaults/u);
  assert.match(postgresGate, /findRepresentativeOwnedObjects/u);
  assert.match(postgresGate, /rolcanlogin: false/u);
  assert.match(postgresGate, /\["28000", "28P01"\]\.includes\(errorCode\(error\) \?\? ""\)/u);
  assert.match(postgresGate, /FROM pg_authid/u);
  assert.match(postgresGate, /backend_type IN \('client backend', 'walsender'\)/u);
  assert.match(postgresGate, /activity\.usesysid::text = '10'/u);
  assert.match(postgresGate, /row\.rolname === migratorRole\)\?\.rolcreaterole, false/u);
});
