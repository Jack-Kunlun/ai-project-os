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
