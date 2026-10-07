import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  buildPostgresGateDatabaseUrl,
  POSTGRES_GATES,
  selectPostgresGates,
  SPECIALIZED_POSTGRES_GATE_RUNNERS,
  validatePostgresGateAdminUrl,
} from "../scripts/postgres-gate-contract";

test("PostgreSQL gate manifest covers every opt-in postgres test exactly once", async () => {
  // v0.3 -> v0.4 upgrade preflight remains an explicit historical test, but
  // v0.5 production uses a clean reset and must not run that old upgrade gate.
  const historicalOnly = new Set(["test/production-upgrade-preflight-postgres.test.ts"]);
  const specializedFiles = SPECIALIZED_POSTGRES_GATE_RUNNERS.flatMap((entry) => [...entry.files]);
  const specializedFileSet = new Set<string>(specializedFiles);
  assert.equal(specializedFileSet.size, specializedFiles.length, "specialized gate files must be listed once");
  assert.ok(specializedFiles.every((file) => !POSTGRES_GATES.some((gate) => gate.file === file)));
  const testRoot = join(process.cwd(), "test");
  const files = (await readdir(testRoot))
    .filter((file) => file.endsWith("-postgres.test.ts"));
  const gatedFiles: string[] = [];
  for (const file of files) {
    const content = await readFile(join(testRoot, file), "utf8");
    if (content.includes("POSTGRES_GATE")) gatedFiles.push(`test/${file}`);
  }

  assert.deepEqual(
    POSTGRES_GATES.map((gate) => gate.file).sort(),
    gatedFiles.filter((file) => !historicalOnly.has(file) && !specializedFileSet.has(file)).sort(),
  );
  assert.deepEqual(gatedFiles.filter((file) => historicalOnly.has(file)), [...historicalOnly]);
  assert.deepEqual(gatedFiles.filter((file) => specializedFileSet.has(file)).sort(), [...specializedFileSet].sort());
  for (const specialized of SPECIALIZED_POSTGRES_GATE_RUNNERS) {
    const runner = await readFile(specialized.runner, "utf8");
    const filesBlock = runner.match(/const files\s*=\s*\[([\s\S]*?)\];/u)?.[1] ?? "";
    const runnerFiles = [...filesBlock.matchAll(/"(test\/[^"]+\.test\.ts)"/gu)].map((match) => match[1]);
    assert.deepEqual(runnerFiles.sort(), [...specialized.files].sort(), `${specialized.runner} must execute its manifest exactly once`);
  }
  assert.equal(new Set(POSTGRES_GATES.map((gate) => gate.id)).size, POSTGRES_GATES.length);
  assert.deepEqual(
    POSTGRES_GATES.filter((gate) => gate.seedAdmin === true).map((gate) => gate.id),
    ["v3", "membership-governance-manifest", "project-ai-provider-delegation", "project-git-repository-delegation", "project-git-automation-run-ledger", "project-git-automation-read-context", "project-git-automation-material", "project-delegated-git-runtime", "personal-runtime-evidence", "personal-web-ai-runtime", "system-failure-inbox", "platform-provider-probe", "notification-subjects"],
  );
  assert.deepEqual(POSTGRES_GATES.find((gate) => gate.id === "local-registration"), {
    id: "local-registration",
    file: "test/local-registration-postgres.test.ts",
    database: "ai_project_os_local_registration_test",
    gateEnv: "LOCAL_REGISTRATION_POSTGRES_GATE",
    databaseUrlEnv: "LOCAL_REGISTRATION_TEST_DATABASE_URL",
    setup: "migrate",
  });
  assert.deepEqual(POSTGRES_GATES.find((gate) => gate.id === "authenticated-web-source"), {
    id: "authenticated-web-source",
    file: "test/authenticated-web-source-postgres.test.ts",
    database: "ai_project_os_authenticated_web_source_test",
    gateEnv: "AUTHENTICATED_WEB_SOURCE_POSTGRES_GATE",
    setup: "principals",
  });
  assert.deepEqual(POSTGRES_GATES.find((gate) => gate.id === "project-git-automation-run-ledger"), {
    id: "project-git-automation-run-ledger",
    file: "test/project-git-automation-run-ledger-postgres.test.ts",
    database: "ai_project_os_project_git_automation_run_ledger_test",
    gateEnv: "PROJECT_GIT_AUTOMATION_RUN_LEDGER_POSTGRES_GATE",
    seedAdmin: true,
    setup: "principals",
  });
  assert.deepEqual(POSTGRES_GATES.find((gate) => gate.id === "project-git-automation-material"), {
    id: "project-git-automation-material",
    file: "test/project-git-automation-material-postgres.test.ts",
    database: "ai_project_os_project_git_automation_material_test",
    gateEnv: "PROJECT_GIT_AUTOMATION_MATERIAL_POSTGRES_GATE",
    seedAdmin: true,
    setup: "principals",
  });
  assert.deepEqual(POSTGRES_GATES.find((gate) => gate.id === "mcp-client-acceptance"), {
    id: "mcp-client-acceptance",
    file: "test/mcp-client-acceptance-postgres.test.ts",
    database: "ai_project_os_mcp_client_acceptance_test",
    gateEnv: "MCP_CLIENT_ACCEPTANCE_POSTGRES_GATE",
    setup: "migrate",
  });
});

test("PostgreSQL gate admin URL is restricted to the fixed disposable loopback target", () => {
  const admin = validatePostgresGateAdminUrl(
    "postgresql://audit:test-only@127.0.0.1:56432/postgres",
  );
  assert.equal(
    buildPostgresGateDatabaseUrl(admin, "ai_project_os_action_engine_test", "gate-test-password"),
    "postgresql://ai_project_os_gate:gate-test-password@127.0.0.1:56432/ai_project_os_action_engine_test",
  );
  assert.equal(
    buildPostgresGateDatabaseUrl(admin, "ai_project_os_memory_index_c_test", "gate-test-password", "public"),
    "postgresql://ai_project_os_gate:gate-test-password@127.0.0.1:56432/ai_project_os_memory_index_c_test?schema=public",
  );

  for (const invalid of [
    "postgresql://audit:test-only@db.internal:56432/postgres",
    "postgresql://audit:test-only@127.0.0.1:5432/postgres",
    "postgresql://audit:test-only@127.0.0.1:56432/ai_project_os",
    "postgresql://audit:test-only@127.0.0.1:56432/postgres?sslmode=disable",
    "postgresql://127.0.0.1:56432/postgres",
  ]) {
    assert.throws(() => validatePostgresGateAdminUrl(invalid), /POSTGRES_GATE_ADMIN_URL_INVALID/);
  }
  assert.throws(
    () => buildPostgresGateDatabaseUrl(admin, "production", "gate-test-password"),
    /POSTGRES_GATE_DATABASE_NAME_INVALID/,
  );
  assert.throws(
    () => buildPostgresGateDatabaseUrl(admin, "ai_project_os_action_engine_test", "short"),
    /POSTGRES_GATE_TEST_PASSWORD_INVALID/,
  );
});

test("PostgreSQL gate filters preserve manifest order and reject ambiguity", () => {
  assert.deepEqual(
    selectPostgresGates("project-world,ai-runtime").map((gate) => gate.id),
    ["ai-runtime", "project-world"],
  );
  assert.throws(() => selectPostgresGates("ai-runtime,ai-runtime"), /POSTGRES_GATE_FILTER_DUPLICATE/);
  assert.throws(() => selectPostgresGates("unknown"), /POSTGRES_GATE_FILTER_INVALID/);
});

test("PostgreSQL gate runner binds every database client to the disposable gate database", async () => {
  const runner = await readFile("scripts/run-postgres-gates.ts", "utf8");
  assert.match(runner, /DATABASE_URL: databaseUrl,/u);
  assert.match(runner, /ENTITLEMENT_DATABASE_URL: databaseUrl,/u);
  assert.match(runner, /const DATABASE_PRINCIPAL_GATE_TEMPORARY_ROLES = Object\.freeze\(\[[\s\S]*?"ai_project_os_cluster_admin"[\s\S]*?"ai_project_os_entitlement_inventory_reader"[\s\S]*?\]\s+as const\)/u);
  assert.match(runner, /if \(gate\.id === "database-principals"\)\s*\{\s*await dropDatabasePrincipalGateTemporaryRoles\(admin\)/u);
  assert.match(runner, /async function dropDatabasePrincipalGateTemporaryRoles\(admin: Client\)[\s\S]*?DROP OWNED BY \$\{quoteIdentifier\(role\)\}[\s\S]*?DROP ROLE \$\{quoteIdentifier\(role\)\}/u);
});

test("CI PostgreSQL administrator is separate from disposable principal gate roles", async () => {
  const [workflow, runner] = await Promise.all([
    readFile(".github/workflows/ci.yml", "utf8"),
    readFile("scripts/run-postgres-gates.ts", "utf8"),
  ]);
  const serviceUser = workflow.match(/POSTGRES_USER: (ai_project_os_[a-z_]+)/u)?.[1];
  const adminUrlUser = workflow.match(/POSTGRES_GATE_ADMIN_URL: postgresql:\/\/(ai_project_os_[a-z_]+):/u)?.[1];
  const healthUser = workflow.match(/--health-cmd "pg_isready -U (ai_project_os_[a-z_]+) -d postgres"/u)?.[1];
  assert.ok(serviceUser);
  assert.equal(adminUrlUser, serviceUser);
  assert.equal(healthUser, serviceUser);
  const principalRoleManifest = runner.split("const PRINCIPAL_GATE_ROLES = Object.freeze([", 2)[1]?.split("const DATABASE_PRINCIPAL_GATE_TEMPORARY_ROLES", 1)[0];
  assert.ok(principalRoleManifest);
  assert.doesNotMatch(principalRoleManifest, new RegExp(`name: "${serviceUser}"`, "u"));
});
