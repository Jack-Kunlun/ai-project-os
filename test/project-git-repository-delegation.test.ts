import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { POSTGRES_GATES } from "../scripts/postgres-gate-contract";
import {
  ProjectGitRepositoryDelegationServiceError,
  proposeProjectGitRepositoryDelegation,
} from "../src/lib/project-git-repository-delegation-service";
import { GitRunnerError, GitServiceError, isDefinitelyPreDispatchGitSyncFailure } from "../src/lib/git";

const schema = readFileSync("prisma/schema.prisma", "utf8");
const migration = readFileSync(
  "prisma/migrations/20260904150000_add_project_git_repository_delegations/migration.sql",
  "utf8",
);
const runtimeMigration = readFileSync(
  "prisma/migrations/20260904170000_add_project_git_manual_run_reconciliation/migration.sql",
  "utf8",
);
const epochMigration = readFileSync(
  "prisma/migrations/20260905050000_bind_personal_git_owner_access_epoch/migration.sql",
  "utf8",
);
const service = readFileSync("src/lib/project-git-repository-delegation-service.ts", "utf8");
const gitService = readFileSync("src/lib/git/service.ts", "utf8");
const runtimeService = readFileSync("src/lib/project-delegated-git-runtime-service.ts", "utf8");
const repositoriesClient = readFileSync("src/app/projects/[projectId]/repositories/project-repositories-client.tsx", "utf8");
const personalGitClient = readFileSync("src/app/profile/connections/git/git-connections-client.tsx", "utf8");
const accessControl = readFileSync("src/lib/access-control.ts", "utf8");
const projectControlClient = readFileSync("src/app/projects/[projectId]/control/project-control-client.tsx", "utf8");
const guidePage = readFileSync("src/app/guide/page.tsx", "utf8");

test("Git repository delegation has an independent typed two-party schema", () => {
  assert.match(schema, /enum ProjectGitRepositoryDelegationStatus/u);
  assert.match(schema, /enum ProjectGitRepositoryDelegationActorKind/u);
  assert.match(schema, /enum ProjectGitRepositoryDelegationAuditAction/u);
  assert.match(schema, /model ProjectGitRepositoryDelegation \{/u);
  assert.match(schema, /model ProjectGitRepositoryDelegationAudit \{/u);
  assert.match(schema, /manualSyncAllowed\s+Boolean\s+@default\(true\)/u);
  assert.match(schema, /automationAllowed\s+Boolean\s+@default\(false\)/u);
  assert.match(schema, /configurationVersion\s+Int\s+@default\(1\)/u);
  assert.match(schema, /ownerProjectMembershipId\s+String\s+@db\.Uuid/u);
  assert.match(schema, /projectConfirmedProjectMembershipId\s+String\?\s+@db\.Uuid/u);
  assert.match(schema, /resolvedAddressFingerprint\s+String\s+@db\.Char\(64\)/u);
  assert.match(schema, /credentialFingerprint\s+String\s+@db\.Char\(64\)/u);
  assert.match(schema, /delegationFingerprint\s+String\s+@db\.Char\(64\)/u);
  assert.match(schema, /connectionOwnerAccountAccessVersion\s+Int\?/u);
  assert.match(schema, /ownerAccountAccessVersion\s+Int\?/u);
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
  assert.match(runtimeMigration, /PGRD_MANUAL_READ_ONLY_PREFLIGHT_FAILED[\s\S]*manual remediation/u);
  assert.match(runtimeMigration, /ADD CONSTRAINT "PGRD_manual_read_only_check"[\s\S]*CHECK \("manualSyncAllowed" = true AND "automationAllowed" = false\)/u);
  assert.match(epochMigration, /personal_git_connection_epoch_guard/u);
  assert.match(epochMigration, /personal_git_delegation_epoch_guard/u);
  assert.match(epochMigration, /personal_git_manual_run_epoch_guard/u);
  assert.match(epochMigration, /personal_git_manual_run_audit_epoch_guard/u);
  assert.match(epochMigration, /personal_git_credential_rotation_context/u);
  assert.match(epochMigration, /project_git_manual_runtime_shape_guard/u);
});

test("Git delegation proposals accept only the canonical one-shot read-only scope", async () => {
  const baseInput = {
    gitConnectionId: "55555555-5555-4555-8555-555555555555",
    repositoryPath: "org/repo",
    trackedRef: "main",
    includeRoots: ["."],
    softExcludePatterns: [],
    role: "primary",
    expiresAt: "2026-09-06T12:00:00.000Z",
  };
  const actor = { id: "33333333-3333-4333-8333-333333333333", role: "user" as const };
  for (const input of [
    { ...baseInput, automationAllowed: true },
    { ...baseInput, manualSyncAllowed: false },
  ]) {
    await assert.rejects(
      () => proposeProjectGitRepositoryDelegation(
        "44444444-4444-4444-8444-444444444444",
        input,
        actor,
        {} as never,
      ),
      (error: unknown) => error instanceof ProjectGitRepositoryDelegationServiceError
        && error.code === "PROJECT_GIT_REPOSITORY_DELEGATION_INVALID_INPUT",
    );
  }
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
  const delegationSelection = service.slice(0, service.indexOf("type DelegationRow"));
  assert.doesNotMatch(delegationSelection, /connectionOwner: \{ select: \{[^}]*username|ownerConfirmedBy: \{ select: \{[^}]*username|projectConfirmedBy: \{ select: \{[^}]*username/u);
  const publicIdentitySource = service.slice(service.indexOf("function publicIdentity"), service.indexOf("export type ProjectGitRepositoryDelegationCapabilities"));
  assert.doesNotMatch(publicIdentitySource, /username/u);
  assert.match(publicIdentitySource, /displayName\?\.trim\(\) \|\| "项目成员"/u);
  assert.doesNotMatch(service.slice(service.indexOf("function delegationView"), service.indexOf("async function appendAudit")), /baseUrl|username|tlsCaCertificate|sshKnownHost|maskedSuffix|credentialId|Fingerprint/u);
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
  assert.match(gitService, /export function isDefinitelyPreDispatchGitSyncFailure/u);
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

test("Git connection probes re-admit immediately before ls-remote", () => {
  const probeStart = gitService.indexOf("async function probeRepository");
  const probeEnd = gitService.indexOf("\nfunction canonicalWebUrl", probeStart);
  const probe = gitService.slice(probeStart, probeEnd);
  const boundary = probe.indexOf("options.onDispatchBoundary");
  const credential = probe.indexOf("loadCredential");
  const runner = probe.indexOf("withGitRunner");
  const remoteCall = probe.indexOf('"ls-remote"');
  assert.ok(boundary >= 0 && credential > boundary && runner > credential && remoteCall > runner);

  const readStart = gitService.indexOf("async function readRepositoryFiles");
  const readEnd = gitService.indexOf("\n/**", readStart);
  const read = gitService.slice(readStart, readEnd);
  const readBoundary = read.indexOf("input.onDispatchBoundary");
  const readCredential = read.indexOf("loadCredential");
  const readRunner = read.indexOf("withGitRunner");
  assert.ok(readBoundary >= 0 && readCredential > readBoundary && readRunner > readCredential);

  const admissionStart = gitService.indexOf("async function acceptGitProbeDispatchBoundary");
  const admission = gitService.slice(admissionStart, probeStart);
  assert.match(admission, /lockActorAccess/u);
  assert.match(admission, /FOR UPDATE/u);
  assert.match(admission, /accountAccessVersion/u);
  assert.match(admission, /updatedAt\.getTime/u);
  assert.match(admission, /secretFingerprint/u);
  assert.match(gitService, /onDispatchBoundary: \(\) => acceptGitProbeDispatchBoundary/u);
});

test("Git delegation API uses same-origin writes and no external runtime dispatch", () => {
  const route = readFileSync("src/app/api/projects/[projectId]/git-repository-delegations/route.ts", "utf8");
  const manualSyncRoute = readFileSync("src/app/api/projects/[projectId]/git-repository-delegations/[delegationId]/manual-sync/route.ts", "utf8");
  assert.match(route, /assertSameOrigin/u);
  assert.match(route, /listProjectGitRepositoryDelegations/u);
  assert.match(route, /proposeProjectGitRepositoryDelegation/u);
  assert.match(manualSyncRoute, /headers: \{ "cache-control": "no-store" \}/u);
  assert.match(manualSyncRoute, /noStore\(handleApiError\(error\)\)/u);
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

test("Git delegation workbench exposes server capabilities and safe run projections", () => {
  assert.match(service, /canOwnerConfirm/u);
  assert.match(service, /canProjectConfirm/u);
  assert.match(service, /canReject/u);
  assert.match(service, /canRevoke/u);
  assert.match(service, /canManualSync/u);
  assert.match(service, /canProjectConfirm:[\s\S]*currentOwnerMembership && ownerActorActive/u);
  assert.match(service, /credential\?\.kind === "git"/u);
  const connectionsProjection = service.slice(service.indexOf("connections:"), service.indexOf("delegations:"));
  assert.doesNotMatch(connectionsProjection, /baseUrl|username|credential|fingerprint|tlsCa|knownHost/u);
  const historyProjection = runtimeService.slice(runtimeService.indexOf("const manualRunHistorySelect"), runtimeService.indexOf("function encodeManualRunCursor"));
  assert.doesNotMatch(historyProjection, /clientRequestKey|requestedById|Membership|Fingerprint|credential|baseUrl|username/u);
  const manualSyncProjection = runtimeService.slice(runtimeService.indexOf("function publicRun"), runtimeService.indexOf("const manualRunHistorySelect"));
  assert.doesNotMatch(manualSyncProjection, /clientRequestKey|requestedById|Membership|Fingerprint|credential|baseUrl|username/u);
  assert.match(runtimeService, /acknowledgeProjectDelegatedGitManualRun/u);
  assert.match(runtimeService, /dispatched && !isDefinitelyPreDispatchGitSyncFailure\(error\)[\s\S]*?"unknown"[\s\S]*?"failed"/u);
  assert.match(runtimeService, /terminalizeRun\(admitted\.id, snapshot, "unknown", safeFailureCode\(error\), db\)/u);
  assert.match(runtimeService, /capabilities: Object\.freeze\(\{ canAcknowledge \}\)/u);
  assert.match(runtimeService, /orderBy: \[\{ createdAt: "desc" \}, \{ id: "desc" \}\]/u);
  assert.match(repositoriesClient, /crypto\.randomUUID/u);
  assert.match(repositoriesClient, /getTimezoneOffset\(\)/u);
  assert.match(repositoriesClient, /localDateTimeValue\(new Date\(Date\.now\(\) \+ 24 \* 60 \* 60 \* 1000\)\)/u);
  assert.match(repositoriesClient, /canAcknowledge && run\.status === "unknown"/u);
  assert.match(repositoriesClient, /人工核对未知运行/u);
  assert.match(repositoriesClient, /await loadRuns\(\)/u);
  assert.doesNotMatch(repositoriesClient, /window\.(?:alert|confirm)/u);
  assert.doesNotMatch(repositoriesClient, /manual-runs[^`]*clientRequestKey/u);
  assert.match(projectControlClient, /一次性手动只读委托/u);
  assert.match(guidePage, /一次性手动只读读取/u);
  for (const file of [
    "manual-runs/route.ts",
    "manual-runs/[runId]/route.ts",
    "manual-runs/[runId]/reconciliation/route.ts",
  ]) {
    const source = readFileSync(`src/app/api/projects/[projectId]/git-repository-delegations/[delegationId]/${file}`, "utf8");
    assert.match(source, /cache-control.*no-store/u);
  }
});

test("delegated Git runtime treats post-dispatch failures as unknown", () => {
  assert.equal(isDefinitelyPreDispatchGitSyncFailure(new GitRunnerError("GIT_OPERATION_TIMEOUT")), false);
  assert.equal(isDefinitelyPreDispatchGitSyncFailure(new GitRunnerError("GIT_REMOTE_UNAVAILABLE")), false);
  assert.equal(isDefinitelyPreDispatchGitSyncFailure(new GitServiceError("GIT_REPOSITORY_EMPTY")), false);
  assert.equal(isDefinitelyPreDispatchGitSyncFailure(new GitServiceError("GIT_CONNECTION_INVALID_INPUT")), true);
  assert.match(runtimeService, /onDispatchBoundary/u);
  assert.doesNotMatch(runtimeService, /onDispatchStart/u);
  assert.match(runtimeService, /dispatched && !isDefinitelyPreDispatchGitSyncFailure\(error\)/u);
  assert.match(repositoriesClient, /结果未知；外部读取可能已发出，系统不会自动重试/u);
});

test("connection owners retain a secret-free safety surface after project access changes", () => {
  const ownerRoute = readFileSync("src/app/api/me/git-delegations/route.ts", "utf8");
  assert.match(ownerRoute, /listConnectionOwnerProjectGitRepositoryDelegations/u);
  assert.match(ownerRoute, /no-store/u);
  assert.match(service, /listConnectionOwnerProjectGitRepositoryDelegations/u);
  const ownerProjection = service.slice(service.indexOf("const connectionOwnerDelegationSelect"), service.indexOf("export async function proposeProjectGitRepositoryDelegation"));
  assert.match(ownerProjection, /ownerMembershipCreatedAt/u);
  assert.match(ownerProjection, /row\.ownerProjectMembership\.createdAt\.getTime\(\) === row\.ownerMembershipCreatedAt\.getTime\(\)/u);
  assert.doesNotMatch(ownerProjection, /includeRoots|softExcludePatterns|codeEnabled|metadataEnabled/u);
  assert.doesNotMatch(ownerProjection, /baseUrl|username|credential|Fingerprint|membershipId/u);
  assert.match(personalGitClient, /项目委托安全管理/u);
  assert.match(personalGitClient, /\/api\/me\/git-delegations/u);
  assert.match(personalGitClient, /拒绝委托|撤销委托/u);
});

test("terminal Git delegation routes narrowly bypass generic project edit admission", () => {
  assert.match(accessControl, /GIT_DELEGATION_TERMINAL_PATH_PATTERN/u);
  assert.match(accessControl, /MCP_DELEGATION_TERMINAL_PATH_PATTERN/u);
  assert.match(accessControl, /request\.method\.toUpperCase\(\) === "POST"[\s\S]*GIT_DELEGATION_TERMINAL_PATH_PATTERN\.test\(path\) \|\| MCP_DELEGATION_TERMINAL_PATH_PATTERN\.test\(path\)/u);
  for (const file of ["rejection/route.ts", "revocation/route.ts"]) {
    const route = readFileSync(`src/app/api/projects/[projectId]/git-repository-delegations/[delegationId]/${file}`, "utf8");
    assert.match(route, /requireApiSession/u);
    assert.match(route, /assertSameOrigin/u);
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
