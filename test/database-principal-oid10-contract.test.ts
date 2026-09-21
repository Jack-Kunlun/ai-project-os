import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const runner = readFileSync("scripts/run-database-principal-oid10-gate.ts", "utf8");
const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as { scripts?: Record<string, string> };

test("OID10 PostgreSQL gate is isolated, pinned, and self-cleaning", () => {
  assert.equal(packageJson.scripts?.["test:database-principal-oid10"], "tsx scripts/run-database-principal-oid10-gate.ts");
  const image = runner.match(/const POSTGRES_IMAGE = "([^"]+)";/u)?.[1];
  assert.match(image ?? "", /^pgvector\/pgvector:0\.8\.6-pg18-trixie@sha256:[a-f0-9]{64}$/u);
  assert.match(runner, /function ensurePinnedImage\(\)/u);
  assert.match(runner, /\["image", "pull", POSTGRES_IMAGE\]/u);
  assert.match(runner, /pinned-image-reinspect/u);
  assert.match(runner, /DATABASE_PRINCIPAL_OID10_DOCKER_UNAVAILABLE/u);
  assert.match(runner, /DATABASE_PRINCIPAL_OID10_PINNED_IMAGE_REGISTRY_FAILED/u);
  const firstInspect = runner.indexOf('["image", "inspect", POSTGRES_IMAGE');
  const pull = runner.indexOf('["image", "pull", POSTGRES_IMAGE');
  const secondInspect = runner.indexOf('["image", "inspect", POSTGRES_IMAGE', firstInspect + 1);
  const volumeCreate = runner.indexOf('["volume", "create"');
  assert.ok(firstInspect >= 0 && pull > firstInspect && secondInspect > pull && volumeCreate > secondInspect);
  assert.match(runner, /POSTGRES_USER=\$\{INITDB_ROLE\}/u);
  assert.match(runner, /row\.oid !== "10"/u);
  assert.match(runner, /FROM pg_authid/u);
  assert.match(runner, /FROM pg_auth_members/u);
  assert.match(runner, /pg_shdepend/u);
  assert.match(runner, /docker.*restart|\["restart", resources\.container\]/u);
  assert.match(runner, /DATABASE_PRINCIPAL_LEGACY_BOOTSTRAP_URL/u);
  assert.match(runner, /migrate-noop-before-retry/u);
  assert.match(runner, /migrate-noop-post-restart/u);
  assert.match(runner, /const EXPECTED_MIGRATION_COUNT = 107;/u);
  assert.match(runner, /\["rm", "--force", resources\.container\]/u);
  assert.match(runner, /\["volume", "rm", resources\.volume\]/u);
  assert.match(runner, /\["network", "rm", resources\.network\]/u);
  assert.doesNotMatch(runner, /volume\s+prune|down\s+-v|rm\s+-rf|REASSIGN\s+OWNED\s+BY|DROP\s+EXTENSION/iu);
  assert.doesNotMatch(runner, /UPDATE\s+pg_(?:extension|shdepend)/iu);
});
