import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  buildPostgresGateDatabaseUrl,
  POSTGRES_GATES,
  selectPostgresGates,
  validatePostgresGateAdminUrl,
} from "../scripts/postgres-gate-contract";

test("PostgreSQL gate manifest covers every opt-in postgres test exactly once", async () => {
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
    gatedFiles.sort(),
  );
  assert.equal(new Set(POSTGRES_GATES.map((gate) => gate.id)).size, POSTGRES_GATES.length);
  assert.deepEqual(
    POSTGRES_GATES.filter((gate) => gate.seedAdmin === true).map((gate) => gate.id),
    ["v3"],
  );
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
