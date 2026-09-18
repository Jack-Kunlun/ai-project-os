import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("first-admin onboarding creates a separate business owner behind a durable bootstrap gate", async () => {
  const [schema, migration, auth, service, route, page, client, setup, principalCatalog] = await Promise.all([
    readFile("prisma/schema.prisma", "utf8"),
    readFile("prisma/migrations/20260917010000_add_platform_bootstrap/migration.sql", "utf8"),
    readFile("src/lib/auth.ts", "utf8"),
    readFile("src/lib/first-admin-onboarding-service.ts", "utf8"),
    readFile("src/app/api/admin/onboarding/complete/route.ts", "utf8"),
    readFile("src/app/onboarding/page.tsx", "utf8"),
    readFile("src/app/onboarding/first-admin-onboarding-client.tsx", "utf8"),
    readFile("src/app/setup/setup-form.tsx", "utf8"),
    readFile("src/lib/database-principal-catalog.ts", "utf8"),
  ]);
  const initializeAdminSource = auth.slice(
    auth.indexOf("export async function initializeAdmin"),
    auth.indexOf("export async function initializeFirstOwner"),
  );

  assert.match(schema, /model PlatformBootstrap \{[\s\S]*initialAdminUserId\s+String\s+@unique[\s\S]*initialOwnerUserId\s+String\?\s+@unique[\s\S]*adminOnboardingCompletedAt\s+DateTime\?/u);
  assert.match(migration, /CREATE TABLE "PlatformBootstrap"/u);
  assert.match(migration, /CONSTRAINT "PlatformBootstrap_singleton_check" CHECK \("id" = 'platform'\)/u);
  assert.match(migration, /FOREIGN KEY \("initialAdminUserId"\) REFERENCES "AppUser"\("id"\)/u);
  assert.match(migration, /REVOKE ALL ON TABLE "PlatformBootstrap" FROM PUBLIC/u);
  assert.doesNotMatch(migration, /INSERT INTO|UPDATE "Workspace"|FROM "AppUser"/u);
  assert.match(principalCatalog, /DATABASE_PRINCIPAL_RELATIONS[\s\S]*"PlatformBootstrap"/u);
  assert.match(principalCatalog, /ENTITLEMENT_PROTECTED_RELATIONS[\s\S]*"PlatformBootstrap"/u);

  assert.match(auth, /getFirstAdminOnboardingState\(user\.id, db\)/u);
  assert.match(auth, /requireFirstAdminOnboardingPage/u);
  const authenticatedPageGuard = auth.slice(auth.indexOf("export async function requireAuthenticatedPageSession"), auth.indexOf("export async function requireUserPageSession"));
  assert.doesNotMatch(authenticatedPageGuard, /redirect\("\/onboarding"\)/u);
  assert.match(auth, /requireFirstAdminOnboardingPage/u);
  assert.match(auth, /export async function initializeFirstOwner/u);
  assert.match(auth, /role: "user" as const/u);
  assert.match(auth, /workspaceMembership\.create\([\s\S]*role: "owner"[\s\S]*accessState: "confirmed"/u);
  assert.match(auth, /source: "localProvisioning"[\s\S]*evidenceKind: "initial-owner-bootstrap"/u);
  assert.match(auth, /platformBootstrap\.updateMany\([\s\S]*initialOwnerUserId: owner\.id[\s\S]*adminOnboardingCompletedAt: createdAt/u);
  assert.match(auth, /platformBootstrap\.create\([\s\S]*initialAdminUserId: user\.id/u);
  assert.doesNotMatch(initializeAdminSource, /workspaceMembership\.create|activateAccountEntitlements|createdById/u);

  assert.match(service, /platformBootstrap\.findUnique/u);
  assert.match(service, /bootstrap\.initialAdminUserId !== userId/u);
  assert.match(service, /withSerializableRetry\(db/u);
  assert.match(service, /FIRST_ADMIN_ONBOARDING_ACCOUNT_STALE/u);
  assert.match(service, /bootstrap\.initialOwnerUserId === null \|\| bootstrap\.adminOnboardingCompletedAt === null/u);

  assert.match(route, /assertSameOrigin\(request\)[\s\S]*requireApiSession\(request\)[\s\S]*initializeFirstOwner\(actor, input\)/u);
  assert.match(route, /username: z\.string\(\)[\s\S]*password: z\.string\(\)/u);
  assert.match(route, /status: 201/u);
  assert.match(route, /cache-control": "no-store"/u);
  assert.doesNotMatch(page, /AdminOverviewClient/u);
  assert.match(page, /AdminPageHeader title="初始化业务 Owner"/u);
  assert.match(page, /FirstAdminOnboardingClient/u);
  assert.match(page, /requireFirstAdminOnboardingPage/u);
  assert.match(client, /创建首个业务 Owner/u);
  assert.match(client, /JSON\.stringify\(\{ username, password \}\)/u);
  assert.match(client, /router\.replace\("\/admin"\)/u);
  assert.match(client, /disabled:bg-slate-500/u);
  assert.match(setup, /router\.replace\("\/admin"\)/u);
});
