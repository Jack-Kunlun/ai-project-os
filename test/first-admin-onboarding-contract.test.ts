import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("first-admin onboarding contract keeps the durable gate and explicit acknowledgement", async () => {
  const [schema, migration, auth, service, route, page, client, setup, smoke, audit, confirmation, manifest, postgresTest] = await Promise.all([
    readFile("prisma/schema.prisma", "utf8"),
    readFile("prisma/migrations/20260913010000_add_first_admin_onboarding/migration.sql", "utf8"),
    readFile("src/lib/auth.ts", "utf8"),
    readFile("src/lib/first-admin-onboarding-service.ts", "utf8"),
    readFile("src/app/api/admin/onboarding/complete/route.ts", "utf8"),
    readFile("src/app/onboarding/page.tsx", "utf8"),
    readFile("src/app/onboarding/first-admin-onboarding-client.tsx", "utf8"),
    readFile("src/app/setup/setup-form.tsx", "utf8"),
    readFile("e2e/smoke.spec.ts", "utf8"),
    readFile("e2e/system-audit.spec.ts", "utf8"),
    readFile("e2e/web-ai-confirmation.spec.ts", "utf8"),
    readFile("scripts/postgres-gate-contract.ts", "utf8"),
    readFile("test/first-admin-onboarding-postgres.test.ts", "utf8"),
  ]);

  assert.match(schema, /initialAdminOnboardingCompletedAt\s+DateTime\?\s+@db\.Timestamp\(3\)/u);
  assert.match(migration, /ADD COLUMN "initialAdminOnboardingCompletedAt" TIMESTAMP\(3\)/u);
  assert.match(migration, /WHERE "id" = '00000000-0000-4000-8000-000000000001'\s+AND EXISTS \([\s\S]*FROM "AppUser"[\s\S]*WHERE "role" = 'admin'/u);
  assert.match(migration, /first_admin_onboarding_completion_guard/u);
  assert.match(migration, /IF TG_OP = 'INSERT'[\s\S]*NEW\."initialAdminOnboardingCompletedAt" IS NOT NULL[\s\S]*must start NULL/u);
  assert.match(migration, /OLD\."initialAdminOnboardingCompletedAt" IS NOT NULL/u);
  assert.match(migration, /NEW\."id" <> '00000000-0000-4000-8000-000000000001'::uuid/u);
  assert.match(migration, /BEFORE INSERT OR UPDATE OF "initialAdminOnboardingCompletedAt" ON "Workspace"/u);
  assert.match(migration, /REVOKE ALL ON FUNCTION "first_admin_onboarding_completion_guard"\(\) FROM PUBLIC/u);

  assert.match(auth, /getFirstAdminOnboardingState\(user\.id, db\)/u);
  assert.match(auth, /redirect\("\/onboarding"\)/u);
  assert.match(auth, /requireFirstAdminOnboardingPage/u);
  assert.match(service, /lockActorAccess\(tx, actor\.id\)[\s\S]*lockWorkspaceAccess\(tx, DEFAULT_WORKSPACE_ID\)/u);
  assert.match(service, /accountAccessVersion: actor\.accountAccessVersion/u);
  assert.match(service, /withSerializableRetry\(db/u);
  assert.match(service, /FIRST_ADMIN_ONBOARDING_ACCOUNT_STALE/u);
  assert.match(service, /initialAdminOnboardingCompletedAt: null/u);
  assert.match(service, /set_config\('app\.first_admin_onboarding_context'/u);
  assert.doesNotMatch(service, /timestampInput|returnTo|userId.*input/u);

  assert.match(route, /assertSameOrigin\(request\)[\s\S]*requireApiSession\(request\)[\s\S]*completeFirstAdminOnboarding\(actor\)/u);
  assert.match(route, /z\.object\(\{\}\)\.strict\(\)/u);
  assert.match(route, /cache-control": "no-store"/u);
  assert.match(page, /AdminOverviewClient/u);
  assert.match(page, /requireFirstAdminOnboardingPage/u);
  assert.match(client, /我已查看，进入日常工作区/u);
  assert.match(client, /完成引导只记录你已查看管理工作台，不等于模型、Git、MCP/u);
  assert.match(client, /router\.replace\("\/dashboard"\)/u);
  assert.match(client, /disabled:bg-slate-500/u);
  assert.match(setup, /router\.replace\("\/onboarding"\)/u);
  assert.match(smoke, /\/onboarding/u);
  assert.match(audit, /我已查看，进入日常工作区/u);
  assert.match(confirmation, /我已查看，进入日常工作区/u);
  assert.match(manifest, /first-admin-onboarding/u);
  assert.match(postgresTest, /POSTGRES_GATE_ADMIN_URL/u);
  assert.match(postgresTest, /DROP TRIGGER IF EXISTS "Workspace_first_admin_onboarding_completion_guard"/u);
  assert.match(postgresTest, /DROP COLUMN IF EXISTS "initialAdminOnboardingCompletedAt"/u);
  assert.match(postgresTest, /targetSql/u);
  assert.match(postgresTest, /pg_trigger/u);
});
