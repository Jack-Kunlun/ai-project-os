import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { POSTGRES_GATES } from "../scripts/postgres-gate-contract";

const schema = readFileSync("prisma/schema.prisma", "utf8");
const migration = readFileSync(
  "prisma/migrations/20260904150000_add_project_git_repository_delegations/migration.sql",
  "utf8",
);
const service = readFileSync("src/lib/project-git-repository-delegation-service.ts", "utf8");
const gitService = readFileSync("src/lib/git/service.ts", "utf8");

test("Git repository delegation has an independent typed two-party schema", () => {
  assert.match(schema, /enum ProjectGitRepositoryDelegationStatus/u);
  assert.match(schema, /enum ProjectGitRepositoryDelegationActorKind/u);
  assert.match(schema, /enum ProjectGitRepositoryDelegationAuditAction/u);
  assert.match(schema, /model ProjectGitRepositoryDelegation \{/u);
  assert.match(schema, /model ProjectGitRepositoryDelegationAudit \{/u);
  assert.match(schema, /configurationVersion\s+Int\s+@default\(1\)/u);
  assert.match(schema, /ownerProjectMembershipId\s+String\s+@db\.Uuid/u);
  assert.match(schema, /projectConfirmedProjectMembershipId\s+String\?\s+@db\.Uuid/u);
  assert.match(schema, /resolvedAddressFingerprint\s+String\s+@db\.Char\(64\)/u);
  assert.match(schema, /credentialFingerprint\s+String\s+@db\.Char\(64\)/u);
  assert.match(schema, /delegationFingerprint\s+String\s+@db\.Char\(64\)/u);
  assert.match(schema, /gitConnection\s+GitConnection\s+@relation\(fields:\s*\[gitConnectionId\],\s*references:\s*\[id\],\s*onDelete:\s*Cascade/u);
  assert.match(schema, /gitRepositoryDelegations\s+ProjectGitRepositoryDelegation\[\]/u);
});

test("Git delegation migration is additive, append-only, and remains runtime-frozen", () => {
  assert.match(migration, /CREATE TABLE "ProjectGitRepositoryDelegation"/u);
  assert.match(migration, /CREATE TABLE "ProjectGitRepositoryDelegationAudit"/u);
  assert.match(migration, /PGRD_live_project_connection_repository_key/u);
  assert.match(migration, /WHERE "status" IN \('draft', 'owner_confirmed', 'active'\)/u);
  assert.match(migration, /PGRD_global_lock/u);
  assert.match(migration, /pg_try_advisory_xact_lock/u);
  assert.match(migration, /PROJECT_GIT_REPOSITORY_DELEGATION_LOCK_BUSY/u);
  assert.match(migration, /PROJECT_GIT_REPOSITORY_DELEGATION_AUDIT_IMMUTABLE/u);
  assert.match(migration, /PROJECT_GIT_REPOSITORY_DELEGATION_AUDIT_REQUIRED/u);
  assert.match(migration, /PGRD_audit_entity_guard/u);
  assert.match(migration, /audit\."delegationVersion" = row_data\."version" - 1/u);
  assert.match(migration, /audit\."statusBefore" IS NOT DISTINCT FROM previous_status/u);
  assert.match(migration, /terminalActorProjectMembershipId" IS NOT DISTINCT FROM row_data\."terminalActorProjectMembershipId/u);
  assert.match(migration, /terminalActorMembershipCreatedAt" IS NOT DISTINCT FROM row_data\."terminalActorMembershipCreatedAt/u);
  assert.match(migration, /PROJECT_GIT_REPOSITORY_DELEGATION_AUDIT_ACTOR_INVALID/u);
  assert.match(migration, /PROJECT_GIT_REPOSITORY_DELEGATION_ACTIVE_CONNECTION_INVALID/u);
  assert.match(migration, /PROJECT_GIT_REPOSITORY_DELEGATION_ACTIVE_OWNER_INVALID/u);
  assert.match(migration, /PROJECT_GIT_REPOSITORY_DELEGATION_ACTIVE_PROJECT_OWNER_INVALID/u);
  assert.match(migration, /PROJECT_GIT_REPOSITORY_DELEGATION_LIVE_EXPIRED/u);
  assert.match(migration, /GIT_CONNECTION_CONFIGURATION_VERSION_INVALID/u);
  assert.doesNotMatch(migration, /changed := OLD\."name" IS DISTINCT FROM NEW\."name"/u);
  assert.match(migration, /PGRD_connection_fkey[\s\S]*ON DELETE CASCADE/u);
  assert.match(migration, /actor\."id" = NEW\."connectionOwnerId"[\s\S]*NEW\."terminalActorProjectMembershipId" = NEW\."ownerProjectMembershipId"/u);
  assert.match(migration, /membership\."role" = 'owner'[\s\S]*membership\."accessState" = 'confirmed'/u);
  assert.match(migration, /clock_timestamp\(\)/u);
  assert.doesNotMatch(migration, /INSERT\s+INTO\s+"ProjectGitRepositoryLink"/u);
  assert.doesNotMatch(migration, /UPDATE\s+"ProjectGitRepositoryLink"/u);
  const tableDefinitions = migration.slice(0, migration.indexOf("CREATE UNIQUE INDEX"));
  assert.doesNotMatch(tableDefinitions, /baseUrl|username|tlsCaCertificate|sshKnownHost|maskedSuffix|credentialId/u);
});

test("service keeps ownership, membership epochs, CAS, and secret-free projection explicit", () => {
  assert.match(service, /ownerUserId, ownershipState: "confirmed"/u);
  assert.match(service, /requireProjectEditorMembership/u);
  assert.match(service, /requireProjectOwnerMembership/u);
  assert.match(service, /expectedVersion/u);
  assert.match(service, /connectionConfigurationVersion/u);
  assert.match(service, /credentialFingerprint/u);
  assert.match(service, /getProjectGitRepositoryDelegationLiveEligibility/u);
  assert.match(service, /runTerminalMutation/u);
  assert.match(service, /lockActorWorkspaceProjectAccess/u);
  assert.match(service, /requireProjectMembershipEpoch/u);
  assert.doesNotMatch(service, /projectPersonalDelegationEnabled/u);
  assert.doesNotMatch(service, /readCredentialSecret|withGitRunner|resolveGitEndpoint/u);
  const publicProjection = service.slice(service.indexOf("function delegationView"), service.indexOf("async function readProjectOwnerFlag"));
  assert.doesNotMatch(publicProjection, /baseUrl|username|tlsCaCertificate|sshKnownHost|maskedSuffix|credentialId|Fingerprint/u);
});

test("delegation mutations re-admit the project and archived projects before connection reads", () => {
  const mutationAdmission = service.slice(service.indexOf("async function runMutation"), service.indexOf("async function requireProjectEditorMembership"));
  assert.match(mutationAdmission, /withWebAiProjectAccessTransaction/u);
  assert.match(mutationAdmission, /required: "edit"/u);
  assert.match(mutationAdmission, /allowArchived: true/u);
  assert.match(mutationAdmission, /if \(admission\.project\.archivedAt !== null\) return fail\("PROJECT_GIT_REPOSITORY_DELEGATION_PROJECT_ARCHIVED"\)/u);
  assert.ok(mutationAdmission.indexOf("archivedAt") < mutationAdmission.indexOf("return operation(tx, admission)"));
  const terminalAdmission = service.slice(service.indexOf("async function runTerminalMutation"), service.indexOf("async function requireProjectEditorMembership"));
  assert.match(terminalAdmission, /lockActorWorkspaceProjectAccess/u);
  assert.match(terminalAdmission, /delegation\?\.connectionOwnerId !== actor\.id/u);
  assert.match(terminalAdmission, /admitWebAiProjectAccess/u);
  assert.match(terminalAdmission, /if \(admission\.project\.archivedAt !== null\) return fail\("PROJECT_GIT_REPOSITORY_DELEGATION_PROJECT_ARCHIVED"\)/u);
  assert.match(service, /return transition === "revoked" \|\| transition === "rejected"/u);

  for (const mutation of [
    "proposeProjectGitRepositoryDelegation",
    "confirmProjectGitRepositoryDelegationOwner",
    "confirmProjectGitRepositoryDelegationProject",
    "rejectProjectGitRepositoryDelegation",
    "revokeProjectGitRepositoryDelegation",
  ]) {
    assert.match(service, new RegExp(`export async function ${mutation}[\\s\\S]*?(?:return runMutation|return mutateDelegation)`, "u"));
  }
  assert.match(service, /requireConnectionEvidence\(await loadConnectionForOwner\(tx, current\.gitConnectionId, admission\.actor\.id\)\)/u);
  assert.match(service, /requireConnectionEvidence\(await loadConnectionForOwner\(tx, current\.gitConnectionId, current\.connectionOwnerId\)\)/u);
});

test("database live-integrity guard rejects frozen connection evidence drift before confirmation commits", () => {
  assert.match(migration, /connection\."configurationVersion" = NEW\."connectionConfigurationVersion"/u);
  assert.match(migration, /connection\."resolvedAddressFingerprint" = NEW\."resolvedAddressFingerprint"/u);
  assert.match(migration, /credential\."secretFingerprint" = NEW\."credentialFingerprint"/u);
  assert.match(migration, /IF NEW\."status" = 'active' THEN[\s\S]*?PROJECT_GIT_REPOSITORY_DELEGATION_ACTIVE_CONNECTION_INVALID/u);
  assert.match(migration, /RAISE EXCEPTION 'PROJECT_GIT_REPOSITORY_DELEGATION_LIVE_CONNECTION_INVALID'/u);
});

test("Git connection updates leave version ownership to the database guard", () => {
  assert.match(gitService, /parsed\.allowPrivateNetwork !== undefined && parsed\.allowPrivateNetwork !== current\.allowPrivateNetwork/u);
  assert.match(gitService, /parsed\.username !== undefined && parsed\.username !== current\.username/u);
  assert.match(gitService, /ai-project-git-repository-delegation-global/u);
  assert.match(gitService, /status: \{ in: \["draft", "ownerConfirmed", "active"\] \}/u);
  assert.match(gitService, /securityChanged && current\.status !== "disabled"/u);
  assert.doesNotMatch(gitService, /configurationVersion:\s*\{\s*increment/u);

  for (const [mutation, nextMutation] of [
    ["export async function updateGitConnection", "export async function disableGitConnection"],
    ["export async function deleteGitConnection", "export async function testGitConnection"],
  ] as const) {
    const mutationSource = gitService.slice(gitService.indexOf(mutation), gitService.indexOf(nextMutation));
    assert.ok(
      mutationSource.indexOf("pg_advisory_xact_lock") < mutationSource.indexOf("FOR UPDATE"),
      `${mutation} must acquire the delegation fence before the Git connection row lock`,
    );
  }
});

test("Git delegation API uses same-origin writes and no external runtime dispatch", () => {
  const route = readFileSync("src/app/api/projects/[projectId]/git-repository-delegations/route.ts", "utf8");
  assert.match(route, /assertSameOrigin/u);
  assert.match(route, /listProjectGitRepositoryDelegations/u);
  assert.match(route, /proposeProjectGitRepositoryDelegation/u);
  for (const file of [
    "owner-confirmation/route.ts",
    "project-confirmation/route.ts",
    "rejection/route.ts",
    "revocation/route.ts",
  ]) {
    const source = readFileSync(`src/app/api/projects/[projectId]/git-repository-delegations/[delegationId]/${file}`, "utf8");
    assert.match(source, /assertSameOrigin/u);
  }
});

test("Git delegation is registered as a disposable migrated PostgreSQL gate", () => {
  assert.deepEqual(POSTGRES_GATES.find((gate) => gate.id === "project-git-repository-delegation"), {
    id: "project-git-repository-delegation",
    file: "test/project-git-repository-delegation-postgres.test.ts",
    database: "ai_project_os_project_git_repository_delegation_test",
    gateEnv: "PROJECT_GIT_REPOSITORY_DELEGATION_POSTGRES_GATE",
    seedAdmin: true,
    setup: "migrate",
  });
});
