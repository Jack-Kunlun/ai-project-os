import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { EFFECTIVE_AI_ROUTE_SOURCES } from "../src/lib/effective-ai-route";

const root = process.cwd();
const legacyRouteModel = ["Project", "Ai", "Route"].join("");
const legacyRouteRevisionModel = ["Project", "Ai", "Route", "Revision"].join("");
const legacyOwnershipAuditModel = ["Ai", "Provider", "Ownership", "Audit"].join("");

function read(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

test("clean-slate routing removes the legacy project route runtime graph", () => {
  assert.equal(existsSync(join(root, "src/lib/project-ai-routes.ts")), false);
  assert.equal(existsSync(join(root, "src/app/api/projects/[projectId]/ai-routes/route.ts")), false);

  const schema = read("prisma/schema.prisma");
  assert.doesNotMatch(schema, new RegExp(`^model ${legacyRouteModel}\\s*\\{`, "mu"));
  assert.doesNotMatch(schema, new RegExp(`^model ${legacyRouteRevisionModel}\\s*\\{`, "mu"));
  assert.doesNotMatch(schema, new RegExp(`^model ${legacyOwnershipAuditModel}\\s*\\{`, "mu"));
  assert.doesNotMatch(schema, new RegExp(`${legacyRouteModel}|${legacyRouteRevisionModel}|${legacyOwnershipAuditModel}`, "u"));

  const cleanSlateMigration = read("prisma/migrations/20260910010000_clean_slate_ai_provider_model/migration.sql");
  assert.match(cleanSlateMigration, new RegExp(`DROP TABLE IF EXISTS "${legacyRouteModel}"`, "u"));
  assert.match(cleanSlateMigration, new RegExp(`DROP TABLE IF EXISTS "${legacyRouteRevisionModel}"`, "u"));
  assert.match(cleanSlateMigration, new RegExp(`DROP TABLE IF EXISTS "${legacyOwnershipAuditModel}"`, "u"));
});

test("clean-slate transition fences legacy writes before destructive DDL", () => {
  const fenceName = "20260910005000_fence_clean_slate_transition";
  const cleanSlateName = "20260910010000_clean_slate_ai_provider_model";
  assert.ok(fenceName < cleanSlateName);

  const migration = read(`prisma/migrations/${fenceName}/migration.sql`);
  assert.match(migration, /CREATE OR REPLACE FUNCTION "clean_slate_transition_write_fence"\(\)/u);
  assert.match(migration, /row_data JSONB := to_jsonb\(NEW\)/u);
  assert.match(migration, /CLEAN_SLATE_TRANSITION_WRITE_FENCED/u);
  assert.match(migration, /row_data ->> 'role' = 'member'/u);
  assert.match(migration, /row_data ->> 'scope' = 'workspace'/u);
  assert.match(migration, /row_data \? 'workspaceId'/u);

  for (const relation of [
    "AppUser",
    "AiProviderConnection",
  ]) {
    assert.match(
      migration,
      new RegExp(`CREATE TRIGGER "${relation}_clean_slate_transition_write_fence"[\\s\\S]*BEFORE INSERT OR UPDATE ON "${relation}"`, "u"),
    );
  }
  for (const relation of [legacyRouteModel, legacyRouteRevisionModel, legacyOwnershipAuditModel]) {
    assert.match(migration, new RegExp(`to_regclass\\('public\\."${relation}"'\\) IS NOT NULL`, "u"));
    assert.match(
      migration,
      new RegExp(`CREATE TRIGGER "${relation}_clean_slate_transition_write_fence"[\\s\\S]*BEFORE INSERT OR UPDATE ON "${relation}"`, "u"),
    );
  }
  assert.doesNotMatch(migration, /SECURITY DEFINER|current_setting|DATABASE_URL|password|secret/iu);
});

test("effective route resolution retains only platform defaults and personal delegation", () => {
  assert.deepEqual(EFFECTIVE_AI_ROUTE_SOURCES, ["platform_default", "personal_delegation"]);

  const resolver = read("src/lib/effective-ai-route.ts");
  assert.match(resolver, /platform_default/u);
  assert.match(resolver, /personal_delegation/u);
  assert.doesNotMatch(resolver, new RegExp(legacyRouteModel, "u"));
});

test("provider schema is limited to platform and personal ownership", () => {
  const schema = read("prisma/schema.prisma");
  const providerModel = schema.match(/model AiProviderConnection \{[\s\S]*?\n\}/u)?.[0] ?? "";
  assert.match(schema, /enum AppUserRole \{[\s\S]*?admin[\s\S]*?user[\s\S]*?\}/u);
  assert.match(schema, /enum AiProviderScope \{[\s\S]*?platform[\s\S]*?user[\s\S]*?\}/u);
  assert.doesNotMatch(providerModel, /workspaceId|ownershipState/u);
  assert.doesNotMatch(schema, /enum AiProviderScope \{[^}]*workspace/u);
});

test("current APIs retain platform and personal provider entry points", () => {
  for (const path of [
    "src/app/api/settings/providers/route.ts",
    "src/app/api/me/ai-providers/route.ts",
    "src/lib/ai-providers/service.ts",
    "src/lib/personal-ai-provider-service.ts",
  ]) {
    assert.equal(existsSync(join(root, path)), true, path);
  }
  assert.match(read("src/app/api/settings/providers/route.ts"), /listProviderConnections|createProviderConnection/u);
  assert.match(read("src/app/api/me/ai-providers/route.ts"), /listPersonalProviderConnections|createPersonalProviderConnection/u);
});

test("clean-slate production surfaces do not retain removed route or workspace provider fields", () => {
  const governanceClient = read("src/app/projects/[projectId]/governance/project-governance-client.tsx");
  assert.doesNotMatch(governanceClient, /governance\/routes|RouteRevision|RouteBox|route-history|fetchRoutes/u);

  const delegationService = read("src/lib/project-ai-provider-delegation-service.ts");
  assert.doesNotMatch(delegationService, /scope:\s*["']platform["']\s*\|\s*["']workspace["']\s*\|\s*["']user["']/u);

  const workspaceSummary = read("src/lib/workspace-summary.ts");
  assert.doesNotMatch(workspaceSummary, /webAiRoutes/u);
});
