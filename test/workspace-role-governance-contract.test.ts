import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync("prisma/migrations/20260912020000_add_workspace_role_governance/migration.sql", "utf8");
const schema = readFileSync("prisma/schema.prisma", "utf8");
const service = readFileSync("src/lib/workspace-role-governance-service.ts", "utf8");
const workspaces = readFileSync("src/lib/workspaces.ts", "utf8");
const oidc = readFileSync("src/lib/oidc.ts", "utf8");
const accountAccess = readFileSync("src/lib/account-access-service.ts", "utf8");
const team = readFileSync("src/app/team/team-client.tsx", "utf8");
const previewRoute = readFileSync("src/app/api/workspaces/[workspaceId]/members/[userId]/role/preview/route.ts", "utf8");
const executeRoute = readFileSync("src/app/api/workspaces/[workspaceId]/members/[userId]/role/execute/route.ts", "utf8");
const catalog = readFileSync("src/lib/database-principal-catalog.ts", "utf8");
const auditCatalog = readFileSync("src/lib/system-audit-catalog.ts", "utf8");
const audit = readFileSync("src/lib/system-audit.ts", "utf8");

test("workspace role governance has one durable preview/execute control plane", () => {
  assert.match(schema, /enum WorkspaceRoleMutationAction/u);
  assert.match(schema, /model WorkspaceRoleMutationPreview/u);
  assert.match(schema, /model WorkspaceRoleMutationAudit/u);
  assert.match(schema, /@@unique\(\[actorId, requestKey\]\)/u);
  assert.match(schema, /@@unique\(\[previewId\]\)/u);
  assert.match(migration, /createdById.*IS NULL/u);
  assert.match(migration, /enabled,\s*confirmed.*owner|initialized workspace must retain/u);
  assert.match(migration, /WorkspaceMembership_owner_invariant_guard/u);
  assert.match(migration, /NEW\."reason" IS DISTINCT FROM preview_row\."reason"/u);
  assert.match(migration, /OLD\."expiresAt" <= now_utc/u);
  assert.match(migration, /access_audit\."action" = 'revoked'[\s\S]*access_audit\."actorId" = NEW\."actorId"/u);
  assert.match(migration, /access_audit\."action" = 'confirmed'[\s\S]*access_audit\."actorId" = NEW\."actorId"/u);
  assert.match(migration, /AppUser_workspace_owner_invariant_guard/u);
  assert.match(migration, /DEFERRABLE INITIALLY DEFERRED/u);
  for (const functionName of [
    "workspace_role_mutation_preview_guard",
    "workspace_role_mutation_audit_guard",
    "workspace_role_mutation_transition_guard",
    "workspace_role_check_owner",
    "workspace_role_owner_membership_guard",
    "workspace_role_owner_workspace_guard",
    "workspace_role_owner_account_guard",
  ]) {
    const definition = migration.match(new RegExp(`CREATE OR REPLACE FUNCTION "${functionName}"[\\s\\S]*?\\$\\$;`, "u"))?.[0] ?? "";
    assert.notEqual(definition, "", functionName);
    assert.match(definition, /SET search_path = pg_catalog, public/u, functionName);
  }
  assert.match(migration, /REVOKE ALL ON FUNCTION "workspace_role_mutation_preview_guard"\(\) FROM PUBLIC/u);
  assert.match(migration, /REVOKE ALL ON FUNCTION "workspace_role_owner_account_guard"\(\) FROM PUBLIC/u);
  assert.match(migration, /Workspace_owner_invariant_guard/u);
});

test("role writes stay behind the runtime control plane, serializable locks and durable evidence", () => {
  assert.match(service, /getDb\(\)/u);
  assert.doesNotMatch(service, /getEntitlementDb\(\)/u);
  assert.doesNotMatch(service, /assertEntitlementWriterSession/u);
  assert.match(service, /isolationLevel:\s*Prisma\.TransactionIsolationLevel\.Serializable/u);
  assert.match(service, /lockActorsAccess\(tx, \[actorId, subjectId\]\)/u);
  assert.match(service, /lockWorkspaceAccess\(tx, workspaceId\)/u);
  assert.match(service, /lockSubjectProjects\(tx, workspaceId, subjectId\)/u);
  assert.match(service, /await lockSubjectProjects\(tx, workspaceId, subjectId\);[\s\S]*const now = await databaseNow\(tx\);/u);
  assert.match(service, /clock_timestamp\(\) AT TIME ZONE 'UTC'/u);
  assert.match(service, /existing\.issuedAt[\s\S]*existing\.expiresAt/u);
  assert.match(service, /confirmationUsername/u);
  assert.match(service, /consumedAt:\s*now/u);
  assert.match(service, /grantWorkspaceMembership/u);
  assert.match(service, /workspaceRoleMutationAudit\.create/u);
  assert.match(service, /existingAudit/u);
  assert.match(workspaces, /WORKSPACE_ROLE_GOVERNANCE_REQUIRED/u);
  assert.match(workspaces, /roleSchema\.exclude\(\["owner", "admin"\]\)/u);
  assert.match(workspaces, /Historical invitations[\s\S]*WORKSPACE_ROLE_GOVERNANCE_REQUIRED/u);
  assert.match(accountAccess, /last_enabled_workspace_owner/u);
});

test("role API and Team UI cannot silently perform direct role or project-grant writes", () => {
  for (const route of [previewRoute, executeRoute]) {
    assert.match(route, /dynamic = "force-dynamic"/u);
    assert.match(route, /assertSameOrigin/u);
    assert.match(route, /private, no-store/u);
    assert.match(route, /context: \{ params: Promise/u);
  }
  assert.match(team, /role\/preview/u);
  assert.match(team, /role\/execute/u);
  assert.doesNotMatch(team, /method:\s*["']PATCH["'][^\n]*members\//u);
  assert.match(team, /输入.*确认/u);
  assert.doesNotMatch(team, /options=\{\[\['owner','Owner'\]/u);
  assert.match(workspaces, /projectProvisioningRoleSchema = projectRoleSchema\.exclude\(\["owner"\]\)/u);
  assert.match(workspaces, /invitation\.projectRole === "owner"/u);
  assert.match(workspaces, /Pick<AppUser, "id" \| "accountAccessVersion">/u);
  assert.match(oidc, /invitation\.workspaceRole === "owner"[\s\S]*invitation\.projectRole === "owner"/u);
});

test("new relations and audit source are explicitly catalogued", () => {
  assert.match(catalog, /"WorkspaceRoleMutationPreview", "WorkspaceRoleMutationAudit"/u);
  assert.match(catalog, /RUNTIME_ONLY_CONTROL_PLANE_RELATIONS[\s\S]*WorkspaceRoleMutationPreview/u);
  assert.match(auditCatalog, /workspaceRoleMutation/u);
  assert.match(audit, /workspaceRoleMutation:\s*\{/u);
  assert.match(audit, /oldRole/u);
  assert.match(audit, /projectGrantCount/u);
});
