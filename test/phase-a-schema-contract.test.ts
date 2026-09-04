import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const roleMigrationName = "20260903010000_add_user_system_role_compatibility";
const providerScopeMigrationName = "20260903020000_add_user_ai_provider_scope";
const platformPolicyMigrationName = "20260903030000_add_platform_policies_and_connection_ownership";
const defaultAppUserRoleMigrationName = "20260904010000_default_new_app_users_to_user";
const platformRouteControlPlaneMigrationName = "20260904020000_add_platform_default_route_control_plane";
const providerOwnershipAuditMigrationName = "20260904030000_add_ai_provider_ownership_audit";

async function readRoleEnum(): Promise<string> {
  const schema = await readFile("prisma/schema.prisma", "utf8");
  const roleEnum = schema.match(/^enum AppUserRole \{([\s\S]*?)^\}/mu)?.[1];
  assert.ok(roleEnum, "AppUserRole enum is missing");
  return roleEnum;
}

function readModel(schema: string, modelName: string): string {
  const model = schema.match(new RegExp(`^model ${modelName} \\{([\\s\\S]*?)^\\}`, "mu"))?.[1];
  assert.ok(model, `${modelName} model is missing`);
  return model;
}

test("AppUserRole keeps legacy values and AppUser defaults to the semantic user value", async () => {
  const roleEnum = await readRoleEnum();
  const values = roleEnum
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => /^[a-z]+$/u.test(line));
  assert.deepEqual(values, ["admin", "member", "user"]);

  const schema = await readFile("prisma/schema.prisma", "utf8");
  const appUserModel = schema.match(/^model AppUser \{([\s\S]*?)^\}/mu)?.[1];
  assert.ok(appUserModel, "AppUser model is missing");
  assert.match(appUserModel, /^\s*role\s+AppUserRole\s+@default\(user\)\s*$/mu);
});

test("the compatibility migration is a standalone additive enum change", async () => {
  const migration = await readFile(`prisma/migrations/${roleMigrationName}/migration.sql`, "utf8");
  const executableSql = migration.replace(/--[^\n]*(?:\n|$)/gu, "").trim();
  assert.equal(executableSql, 'ALTER TYPE "AppUserRole" ADD VALUE IF NOT EXISTS \'user\';');
  assert.doesNotMatch(migration, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|DROP|CREATE)\b/iu);
  assert.doesNotMatch(migration, /\bALTER\s+TABLE\b/iu);
  assert.doesNotMatch(migration, /\b(?:SET\s+DEFAULT|DEFAULT\s+)\b/iu);
  assert.doesNotMatch(migration, /\b(?:admin|member)\b/iu);
});

test("the compatibility migration occupies stable migration slot 55", async () => {
  const entries = await readdir("prisma/migrations", { withFileTypes: true });
  const migrations = entries
    .filter((entry) => entry.isDirectory() && /^\d{14}_[a-z0-9_]+$/u.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  assert.equal(migrations.indexOf(roleMigrationName), 54);
});

test("AiProviderScope preserves existing values and adds the user value", async () => {
  const schema = await readFile("prisma/schema.prisma", "utf8");
  const scopeEnum = schema.match(/^enum AiProviderScope \{([\s\S]*?)^\}/mu)?.[1];
  assert.ok(scopeEnum, "AiProviderScope enum is missing");
  const values = scopeEnum
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => /^[a-z]+$/u.test(line));
  assert.deepEqual(values, ["platform", "workspace", "user"]);
});

test("the AI provider scope migration is a standalone additive enum change", async () => {
  const migration = await readFile(`prisma/migrations/${providerScopeMigrationName}/migration.sql`, "utf8");
  const executableSql = migration.replace(/--[^\n]*(?:\n|$)/gu, "").trim();
  assert.equal(executableSql, 'ALTER TYPE "AiProviderScope" ADD VALUE IF NOT EXISTS \'user\';');
  assert.doesNotMatch(migration, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|DROP|CREATE)\b/iu);
  assert.doesNotMatch(migration, /\bALTER\s+TABLE\b/iu);
  assert.doesNotMatch(migration, /\b(?:SET\s+DEFAULT|DEFAULT\s+)\b/iu);
  assert.doesNotMatch(migration, /\bCHECK\b/iu);
});

test("the AI provider scope migration occupies stable migration slot 56", async () => {
  const entries = await readdir("prisma/migrations", { withFileTypes: true });
  const migrations = entries
    .filter((entry) => entry.isDirectory() && /^\d{14}_[a-z0-9_]+$/u.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  assert.equal(migrations.indexOf(roleMigrationName), 54);
  assert.equal(migrations.indexOf(providerScopeMigrationName), 55);
});

test("M400 default-role migration occupies stable migration slot 58 and changes only the default", async () => {
  const entries = await readdir("prisma/migrations", { withFileTypes: true });
  const migrations = entries
    .filter((entry) => entry.isDirectory() && /^\d{14}_[a-z0-9_]+$/u.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  assert.equal(migrations.indexOf(defaultAppUserRoleMigrationName), 57);

  const migration = await readFile(`prisma/migrations/${defaultAppUserRoleMigrationName}/migration.sql`, "utf8");
  const executableSql = migration.replace(/--[^\n]*(?:\n|$)/gu, "").trim();
  assert.equal(executableSql, 'ALTER TABLE "AppUser" ALTER COLUMN "role" SET DEFAULT \'user\';');
  assert.doesNotMatch(executableSql, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|DROP|CREATE)\b/iu);
  assert.doesNotMatch(executableSql, /\bALTER\s+TYPE\b/iu);
  assert.doesNotMatch(executableSql, /\b(?:admin|member)\b/iu);
});

test("M300 schema declares additive ownership, audit, and empty policy carriers", async () => {
  const schema = await readFile("prisma/schema.prisma", "utf8");
  assert.match(
    schema,
    /^enum ResourceOwnershipState \{\s*legacyPending @map\("legacy_pending"\)\s*ambiguous\s*confirmed\s*\}/mu,
  );
  assert.match(schema, /^enum PlatformGrantOfferPolicyStatus \{\s*draft\s*active\s*retired\s*\}/mu);
  assert.match(schema, /^enum PlatformDefaultAiRouteStatus \{\s*draft\s*verified\s*active\s*retired\s*\}/mu);

  const appUser = readModel(schema, "AppUser");
  assert.match(appUser, /^\s*disabledReason\s+String\?\s+@db\.VarChar\(500\)\s*$/mu);
  assert.match(appUser, /^\s*disabledById\s+String\?\s+@db\.Uuid\s*$/mu);
  assert.match(appUser, /disabledBy\s+AppUser\?\s+@relation\("AppUserDisabledBy"/u);
  assert.match(appUser, /disabledUsers\s+AppUser\[\]\s+@relation\("AppUserDisabledBy"/u);
  assert.match(appUser, /createdGitConnections\s+GitConnection\[\]\s+@relation\("GitConnectionCreatedBy"/u);
  assert.match(appUser, /ownedGitConnections\s+GitConnection\[\]\s+@relation\("GitConnectionOwner"/u);
  assert.match(appUser, /createdMcpConnections\s+McpConnection\[\]\s+@relation\("McpConnectionCreatedBy"/u);
  assert.match(appUser, /ownedMcpConnections\s+McpConnection\[\]\s+@relation\("McpConnectionOwner"/u);
  assert.match(appUser, /revokedWorkspaceInvitations\s+WorkspaceInvitation\[\]\s+@relation\("WorkspaceInvitationRevokedBy"/u);
  assert.match(appUser, /createdPlatformGrantOfferPolicies\s+PlatformGrantOfferPolicy\[\]\s+@relation\("PlatformGrantOfferPolicyCreatedBy"/u);
  assert.match(appUser, /updatedPlatformGrantOfferPolicies\s+PlatformGrantOfferPolicy\[\]\s+@relation\("PlatformGrantOfferPolicyUpdatedBy"/u);
  assert.match(appUser, /createdPlatformDefaultAiRoutes\s+PlatformDefaultAiRoute\[\]\s+@relation\("PlatformDefaultAiRouteCreatedBy"/u);
  assert.match(appUser, /updatedPlatformDefaultAiRoutes\s+PlatformDefaultAiRoute\[\]\s+@relation\("PlatformDefaultAiRouteUpdatedBy"/u);

  const membership = readModel(schema, "MembershipSubscription");
  assert.match(membership, /^\s*revocationReason\s+String\?\s+@db\.VarChar\(500\)\s*$/mu);

  const invitation = readModel(schema, "WorkspaceInvitation");
  assert.match(invitation, /^\s*revokedById\s+String\?\s+@db\.Uuid\s*$/mu);
  assert.match(invitation, /^\s*revocationReason\s+String\?\s+@db\.VarChar\(500\)\s*$/mu);
  assert.match(invitation, /^\s*updatedAt\s+DateTime\s+@updatedAt\s*$/mu);
  assert.match(invitation, /revokedBy\s+AppUser\?\s+@relation\("WorkspaceInvitationRevokedBy"/u);

  for (const modelName of ["GitConnection", "McpConnection"]) {
    const model = readModel(schema, modelName);
    assert.match(model, /^\s*ownerUserId\s+String\?\s+@db\.Uuid\s*$/mu);
    assert.match(model, /^\s*ownershipState\s+ResourceOwnershipState\s+@default\(legacyPending\)\s*$/mu);
    assert.match(model, new RegExp(`createdBy\\s+AppUser\\s+@relation\\("${modelName}CreatedBy"`));
    assert.match(model, new RegExp(`ownerUser\\s+AppUser\\?\\s+@relation\\("${modelName}Owner"`));
    assert.match(model, /@@index\(\[ownerUserId, ownershipState, updatedAt\]\)/u);
  }

  const provider = readModel(schema, "AiProviderConnection");
  assert.match(provider, /^\s*ownershipState\s+ResourceOwnershipState\s+@default\(legacyPending\)\s*$/mu);
  assert.match(provider, /@@index\(\[ownerUserId, updatedAt\]\)/u);
  assert.match(provider, /@@index\(\[ownerUserId, ownershipState, updatedAt\]\)/u);
  assert.match(provider, /platformDefaultAiRoutes\s+PlatformDefaultAiRoute\[\]\s+@relation\("PlatformDefaultAiRouteProvider"/u);

  const offerPolicy = readModel(schema, "PlatformGrantOfferPolicy");
  assert.match(offerPolicy, /offerVersion\s+String\s+@unique\s+@db\.VarChar\(64\)/u);
  assert.match(offerPolicy, /status\s+PlatformGrantOfferPolicyStatus\s+@default\(draft\)/u);
  assert.match(offerPolicy, /createdBy\s+AppUser\s+@relation\("PlatformGrantOfferPolicyCreatedBy"/u);
  assert.match(offerPolicy, /updatedBy\s+AppUser\s+@relation\("PlatformGrantOfferPolicyUpdatedBy"/u);
  assert.match(offerPolicy, /@@index\(\[status, updatedAt\]\)/u);

  const defaultRoute = readModel(schema, "PlatformDefaultAiRoute");
  assert.match(defaultRoute, /operation\s+AiOperation/u);
  assert.match(defaultRoute, /version\s+Int/u);
  assert.match(defaultRoute, /status\s+PlatformDefaultAiRouteStatus\s+@default\(draft\)/u);
  assert.match(defaultRoute, /providerConnection\s+AiProviderConnection\s+@relation\("PlatformDefaultAiRouteProvider"/u);
  assert.match(defaultRoute, /quotaMultiplierBps\s+Int\s+@default\(10000\)/u);
  assert.match(defaultRoute, /@@unique\(\[operation, version\]\)/u);
  assert.match(defaultRoute, /@@index\(\[operation, status, updatedAt\]\)/u);
  assert.match(defaultRoute, /@@index\(\[providerConnectionId, status\]\)/u);

  for (const uniqueField of [
    /model GitConnection \{[\s\S]*?^\s*name\s+String\s+@unique/mu,
    /model GitConnection \{[\s\S]*?^\s*credentialId\s+String\?\s+@db\.Uuid/mu,
    /model McpConnection \{[\s\S]*?^\s*name\s+String\s+@unique/mu,
    /model McpConnection \{[\s\S]*?^\s*credentialId\s+String\?\s+@unique\s+@db\.Uuid/mu,
  ]) assert.match(schema, uniqueField);
});

test("M300 migration occupies stable migration slot 57 and contains additive DDL only", async () => {
  const entries = await readdir("prisma/migrations", { withFileTypes: true });
  const migrations = entries
    .filter((entry) => entry.isDirectory() && /^\d{14}_[a-z0-9_]+$/u.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  assert.equal(migrations.indexOf(platformPolicyMigrationName), 56);

  const schema = await readFile("prisma/schema.prisma", "utf8");
  const migration = await readFile(`prisma/migrations/${platformPolicyMigrationName}/migration.sql`, "utf8");
  const historicalEntitlementsMigration = await readFile(
    "prisma/migrations/20260902010000_add_ai_entitlements_and_provider_scope/migration.sql",
    "utf8",
  );
  const executableSql = migration.replace(/--[^\n]*(?:\n|$)/gu, "");
  assert.doesNotMatch(executableSql, /(?:^|;)\s*(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/imu);
  assert.doesNotMatch(executableSql, /\bDROP\s+(?:TABLE|TYPE|INDEX)\b/iu);
  assert.doesNotMatch(executableSql, /\bDROP\s+CONSTRAINT\s+(?!"AiProviderConnection_scope_check")/iu);
  assert.doesNotMatch(migration, /MembershipSubscription_revokedById_fkey/u);
  assert.match(historicalEntitlementsMigration, /MembershipSubscription_revokedById_fkey/u);
  assert.match(executableSql, /ALTER TABLE "WorkspaceInvitation"[\s\S]*ALTER COLUMN "updatedAt" DROP DEFAULT/iu);
  assert.match(executableSql, /DROP CONSTRAINT "AiProviderConnection_scope_check"/u);
  assert.match(executableSql, /AppUser_disabled_metadata_check[\s\S]*disabledAt[\s\S]*disabledReason[\s\S]*disabledById/u);
  assert.match(executableSql, /MembershipSubscription_revocation_check[\s\S]*revocationReason[\s\S]*revokedAt/u);
  assert.match(executableSql, /WorkspaceInvitation_revocation_check[\s\S]*revokedById[\s\S]*revokedAt/u);
  assert.match(executableSql, /GitConnection_ownership_check[\s\S]*confirmed[\s\S]*ownerUserId[\s\S]*legacy_pending[\s\S]*ambiguous/u);
  assert.match(executableSql, /McpConnection_ownership_check[\s\S]*confirmed[\s\S]*ownerUserId[\s\S]*legacy_pending[\s\S]*ambiguous/u);
  assert.match(executableSql, /AiProviderConnection_scope_check[\s\S]*platform[\s\S]*legacy_pending[\s\S]*workspace[\s\S]*ambiguous[\s\S]*user[\s\S]*confirmed/u);
  assert.match(executableSql, /PlatformGrantOfferPolicy_amount_check[\s\S]*amount[\s\S]*validForDays/u);
  assert.match(executableSql, /PlatformGrantOfferPolicy_active_key[\s\S]*WHERE "status" = 'active'/u);
  assert.match(executableSql, /PlatformDefaultAiRoute_version_check[\s\S]*version/u);
  assert.match(executableSql, /PlatformDefaultAiRoute_quota_multiplier_check[\s\S]*quotaMultiplierBps/u);
  assert.match(executableSql, /PlatformDefaultAiRoute_operation_payload_check[\s\S]*embedding[\s\S]*"embeddingDimensions" IS NOT NULL[\s\S]*"maxOutputTokens" IS NULL/u);
  assert.match(executableSql, /PlatformDefaultAiRoute_operation_payload_check[\s\S]*operation.*"maxOutputTokens" IS NOT NULL/u);
  assert.match(executableSql, /PlatformDefaultAiRoute_operation_active_key[\s\S]*WHERE "status" = 'active'/u);
  assert.match(executableSql, /FOREIGN KEY \("disabledById"\)[\s\S]*ON DELETE NO ACTION ON UPDATE CASCADE/u);
  assert.match(executableSql, /FOREIGN KEY \("ownerUserId"\)[\s\S]*ON DELETE NO ACTION ON UPDATE CASCADE/u);
  assert.match(executableSql, /FOREIGN KEY \("createdById"\)[\s\S]*PlatformGrantOfferPolicy/u);
  assert.match(executableSql, /FOREIGN KEY \("updatedById"\)[\s\S]*PlatformDefaultAiRoute/u);

  assert.match(schema, /model GitConnection \{[\s\S]*?^\s*name\s+String\s+@unique/mu);
  assert.match(schema, /model GitConnection \{[\s\S]*?^\s*credentialId\s+String\?/mu);
  assert.match(schema, /model McpConnection \{[\s\S]*?^\s*name\s+String\s+@unique/mu);
  assert.match(schema, /model McpConnection \{[\s\S]*?^\s*credentialId\s+String\?\s+@unique/mu);
  assert.doesNotMatch(schema, /model AiProviderConnection \{[\s\S]*?^\s*name\s+String\s+@unique/mu);
  assert.match(schema, /model AiProviderConnection \{[\s\S]*?^\s*credentialId\s+String\s+@unique/mu);
  assert.match(schema, /model PlatformTokenGrant \{[\s\S]*?@@unique\(\[userId, kind\]\)/mu);
});

test("personal provider ownership migration scopes names and freezes identity", async () => {
  const migrationName = "20260904080000_add_personal_ai_provider_ownership";
  const delegationMigrationName = "20260904090000_add_project_ai_provider_delegations";
  const entries = await readdir("prisma/migrations", { withFileTypes: true });
  const migrations = entries
    .filter((entry) => entry.isDirectory() && /^\d{14}_[a-z0-9_]+$/u.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  assert.equal(migrations[64], migrationName);
  assert.equal(migrations[65], delegationMigrationName);

  const schema = await readFile("prisma/schema.prisma", "utf8");
  const provider = readModel(schema, "AiProviderConnection");
  assert.match(provider, /^\s*name\s+String\s+@db\.VarChar\(80\)\s*$/mu);
  assert.match(provider, /@@index\(\[scope, name\]\)/u);
  assert.match(provider, /@@index\(\[ownerUserId, name\]\)/u);

  const migration = await readFile(`prisma/migrations/${migrationName}/migration.sql`, "utf8");
  assert.match(migration, /DROP INDEX IF EXISTS "AiProviderConnection_name_key"/u);
  assert.match(migration, /AiProviderConnection_legacy_scope_name_key[\s\S]*WHERE "scope" IN \('platform', 'workspace'\)/u);
  assert.match(migration, /AiProviderConnection_user_name_key[\s\S]*WHERE "scope" = 'user'/u);
  assert.match(migration, /ai_provider_connection_identity_guard/u);
  assert.match(migration, /OLD\."credentialId" IS DISTINCT FROM NEW\."credentialId"/u);
  assert.match(migration, /CREATE TRIGGER "AiProviderConnection_identity_guard"/u);
});

test("platform default route control plane occupies stable migration slot 59", async () => {
  const entries = await readdir("prisma/migrations", { withFileTypes: true });
  const migrations = entries
    .filter((entry) => entry.isDirectory() && /^\d{14}_[a-z0-9_]+$/u.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  assert.equal(migrations.indexOf(platformRouteControlPlaneMigrationName), 58);

  const schema = await readFile("prisma/schema.prisma", "utf8");
  const migration = await readFile(`prisma/migrations/${platformRouteControlPlaneMigrationName}/migration.sql`, "utf8");
  const provider = readModel(schema, "AiProviderConnection");
  const defaultRoute = readModel(schema, "PlatformDefaultAiRoute");
  const audit = readModel(schema, "PlatformDefaultAiRouteAudit");
  assert.match(provider, /^\s*configurationVersion\s+Int\s+@default\(1\)\s*$/mu);
  assert.match(defaultRoute, /^\s*validatedProviderConfigurationVersion\s+Int\?\s*$/mu);
  assert.match(defaultRoute, /^\s*validatedAt\s+DateTime\?\s*$/mu);
  assert.match(defaultRoute, /audits\s+PlatformDefaultAiRouteAudit\[\]/u);
  assert.match(audit, /action\s+PlatformDefaultAiRouteAuditAction/u);
  assert.match(audit, /safeSnapshot\s+Json\s+@default\("\{\}"\)\s+@db\.JsonB/u);
  assert.match(migration, /ADD COLUMN "configurationVersion" INTEGER NOT NULL DEFAULT 1/u);
  assert.match(migration, /CREATE TYPE "PlatformDefaultAiRouteAuditAction"/u);
  assert.match(migration, /BEFORE UPDATE OR DELETE ON "PlatformDefaultAiRouteAudit"/u);
  const executableSql = migration.replace(/--[^\n]*(?:\n|$)/gu, "");
  assert.doesNotMatch(executableSql, /(?:^|;)\s*(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/imu);
  assert.doesNotMatch(executableSql, /\bDROP\s+(?:TABLE|TYPE|INDEX)\b/iu);
  assert.match(executableSql, /DROP CONSTRAINT "AiProviderConnection_scope_check"/u);
});

test("provider ownership confirmation audit occupies stable migration slot 60 and is append-only", async () => {
  const entries = await readdir("prisma/migrations", { withFileTypes: true });
  const migrations = entries
    .filter((entry) => entry.isDirectory() && /^\d{14}_[a-z0-9_]+$/u.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  assert.equal(migrations.indexOf(providerOwnershipAuditMigrationName), 59);

  const schema = await readFile("prisma/schema.prisma", "utf8");
  const migration = await readFile(`prisma/migrations/${providerOwnershipAuditMigrationName}/migration.sql`, "utf8");
  const audit = readModel(schema, "AiProviderOwnershipAudit");
  assert.match(schema, /enum AiProviderOwnershipAuditAction\s*\{[\s\S]*legacyOwnershipConfirmed\s+@map\("legacy_ownership_confirmed"\)/u);
  assert.match(audit, /providerConnectionId\s+String\s+@db\.Uuid/u);
  assert.match(audit, /actorId\s+String\s+@db\.Uuid/u);
  assert.match(audit, /reason\s+String\s+@db\.VarChar\(500\)/u);
  assert.match(audit, /oldOwnershipState\s+ResourceOwnershipState/u);
  assert.match(audit, /newOwnershipState\s+ResourceOwnershipState/u);
  assert.match(audit, /providerConnection\s+AiProviderConnection\s+@relation\("AiProviderOwnershipAuditProvider"/u);
  assert.match(audit, /actor\s+AppUser\s+@relation\("AiProviderOwnershipAuditActor"/u);
  assert.match(migration, /CREATE TYPE "AiProviderOwnershipAuditAction"/u);
  assert.match(migration, /CREATE TABLE "AiProviderOwnershipAudit"/u);
  assert.match(migration, /BEFORE UPDATE OR DELETE ON "AiProviderOwnershipAudit"/u);
  const executableSql = migration.replace(/--[^\n]*(?:\n|$)/gu, "");
  assert.doesNotMatch(executableSql, /(?:^|;)\s*(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/imu);
  assert.doesNotMatch(executableSql, /\bDROP\s+(?:TABLE|TYPE|INDEX)\b/iu);
});
