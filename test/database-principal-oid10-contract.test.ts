import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const runner = readFileSync("scripts/run-database-principal-oid10-gate.ts", "utf8");
const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as { scripts?: Record<string, string> };

test("OID10 PostgreSQL gate is isolated, pinned, and self-cleaning", () => {
  assert.equal(packageJson.scripts?.["test:database-principal-oid10"], "tsx scripts/run-database-principal-oid10-gate.ts");
  assert.match(runner, /pgvector\/pgvector:0\.8\.6-pg18-trixie@sha256:/u);
  assert.match(runner, /POSTGRES_USER=\$\{INITDB_ROLE\}/u);
  assert.match(runner, /row\.oid !== "10"/u);
  assert.match(runner, /FROM pg_authid/u);
  assert.match(runner, /FROM pg_auth_members/u);
  assert.match(runner, /pg_shdepend/u);
  assert.match(runner, /docker.*restart|\["restart", resources\.container\]/u);
  assert.match(runner, /DATABASE_PRINCIPAL_LEGACY_BOOTSTRAP_URL/u);
  assert.match(runner, /migrate-noop-before-retry/u);
  assert.match(runner, /migrate-noop-post-restart/u);
  assert.match(runner, /const EXPECTED_MIGRATION_COUNT = 106;/u);
  assert.match(runner, /\["rm", "--force", resources\.container\]/u);
  assert.match(runner, /\["volume", "rm", resources\.volume\]/u);
  assert.match(runner, /\["network", "rm", resources\.network\]/u);
  assert.doesNotMatch(runner, /volume\s+prune|down\s+-v|rm\s+-rf|REASSIGN\s+OWNED\s+BY|DROP\s+EXTENSION/iu);
  assert.doesNotMatch(runner, /UPDATE\s+pg_(?:extension|shdepend)/iu);
});
