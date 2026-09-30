import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  DATABASE_PRINCIPAL_RELATIONS,
  DATABASE_PRINCIPAL_COORDINATION_RELATIONS,
  DATABASE_PRINCIPAL_INVOKER_FUNCTION_MATRIX,
  DATABASE_PRINCIPAL_PRIVATE_FUNCTION_MATRIX,
  DATABASE_PRINCIPAL_GIT_AUTOMATION_WORKER_DEFINER_FUNCTION_MATRIX,
  DATABASE_PRINCIPAL_TRIGGER_FUNCTION_MATRIX,
  ENTITLEMENT_PROTECTED_RELATIONS,
  RUNTIME_ONLY_CONTROL_PLANE_RELATIONS,
  GIT_AUTOMATION_WORKER_CONTEXT_RELATIONS,
  GIT_AUTOMATION_WORKER_LEDGER_RELATIONS,
  GIT_AUTOMATION_WORKER_POLL_COLUMNS,
  WRITER_APPEND_ONLY_RELATIONS,
  runtimeMutableRelations,
} from "../src/lib/database-principal-catalog";

const compose = readFileSync("compose.yaml", "utf8");
const ci = readFileSync(".github/workflows/ci.yml", "utf8");
const envExample = readFileSync(".env.example", "utf8");
const db = readFileSync("src/lib/db.ts", "utf8");
const reconcile = readFileSync("scripts/reconcile-database-principals.ts", "utf8");
const automationRunService = readFileSync("src/lib/project-git-automation-run-service.ts", "utf8");
const postgresGate = readFileSync("test/database-principal-postgres.test.ts", "utf8");
const principalGateRunner = readFileSync("scripts/run-database-principal-oid10-gate.ts", "utf8");
const migration = readFileSync("prisma/migrations/20260910050000_harden_account_entitlement_database_principals/migration.sql", "utf8");
const connectionGovernanceMigration = readFileSync("prisma/migrations/20260912030000_add_connection_governance/migration.sql", "utf8");
const gitManualRuntimeRecoveryMigration = readFileSync("prisma/migrations/20260914010000_harden_git_manual_final_fence_and_connection_recovery/migration.sql", "utf8");
const mcpActionResultImportMigration = readFileSync("prisma/migrations/20260926090000_add_project_mcp_action_result_import/migration.sql", "utf8");
const oidcIdentityLinkMigration = readFileSync("prisma/migrations/20260927010000_add_oidc_identity_link/migration.sql", "utf8");
const authenticatedWebSourceMigration = readFileSync("prisma/migrations/20260927020100_add_authenticated_web_source_review/migration.sql", "utf8");
const authenticatedWebSourceIdentityMigration = readFileSync("prisma/migrations/20260929010000_preserve_authenticated_web_source_identity/migration.sql", "utf8");
const sharedGitPublicationMigration = readFileSync("prisma/migrations/20260929060000_add_git_shared_publication_head/migration.sql", "utf8");
const automaticGitPublicationMigration = readFileSync("prisma/migrations/20260929070000_add_project_git_automation_publication/migration.sql", "utf8");
const gitAutomationReadContextMigration = readFileSync("prisma/migrations/20260930010000_add_git_automation_read_context/migration.sql", "utf8");
const gitAutomationMaterialMigration = readFileSync("prisma/migrations/20260930020000_add_project_git_material_import/migration.sql", "utf8");
const catalog = readFileSync("src/lib/database-principal-catalog.ts", "utf8");
const activation = readFileSync("src/lib/account-entitlement-activation-service.ts", "utf8");
const backfill = readFileSync("src/lib/account-entitlement-backfill-service.ts", "utf8");
const policy = readFileSync("src/lib/platform-grant-offer-policy-service.ts", "utf8");
const auth = readFileSync("src/lib/auth.ts", "utf8");
const github = readFileSync("src/lib/github-oauth.ts", "utf8");
const oidc = readFileSync("src/lib/oidc.ts", "utf8");
const workspaces = readFileSync("src/lib/workspaces.ts", "utf8");
const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as { scripts?: Record<string, string> };

test("invoker helper ACL matrix is complete, immutable and uniquely signed", () => {
  assert.equal(DATABASE_PRINCIPAL_INVOKER_FUNCTION_MATRIX.length, 46);
  assert.equal(DATABASE_PRINCIPAL_INVOKER_FUNCTION_MATRIX.filter((helper) => helper.runtime).length, 45);
  assert.equal(DATABASE_PRINCIPAL_INVOKER_FUNCTION_MATRIX.filter((helper) => helper.entitlementWriter).length, 8);
  assert.equal(DATABASE_PRINCIPAL_INVOKER_FUNCTION_MATRIX.filter((helper) => helper.runtime && helper.entitlementWriter).length, 7);
  const signatures = DATABASE_PRINCIPAL_INVOKER_FUNCTION_MATRIX.map((helper) => `${helper.name}(${helper.identityArguments})`);
  assert.equal(new Set(signatures).size, DATABASE_PRINCIPAL_INVOKER_FUNCTION_MATRIX.length);
  assert.ok(Object.isFrozen(DATABASE_PRINCIPAL_INVOKER_FUNCTION_MATRIX));
  const ownerHelper = DATABASE_PRINCIPAL_INVOKER_FUNCTION_MATRIX.find((helper) => helper.name === "workspace_role_check_owner");
  assert.deepEqual(ownerHelper, {
    name: "workspace_role_check_owner",
    identityArguments: "uuid",
    runtime: true,
    entitlementWriter: true,
    reason: "workspace enabled-owner invariant validation",
  });
  assert.ok(DATABASE_PRINCIPAL_INVOKER_FUNCTION_MATRIX.every((helper) => Object.isFrozen(helper) && helper.reason.trim().length > 0));
  assert.equal(DATABASE_PRINCIPAL_PRIVATE_FUNCTION_MATRIX.length, 7);
  assert.equal(DATABASE_PRINCIPAL_GIT_AUTOMATION_WORKER_DEFINER_FUNCTION_MATRIX.length, 10);
  assert.equal(DATABASE_PRINCIPAL_TRIGGER_FUNCTION_MATRIX.length, 93);
  assert.ok(DATABASE_PRINCIPAL_TRIGGER_FUNCTION_MATRIX.every((trigger) => Object.isFrozen(trigger)
    && trigger.identityArguments === ""
    && trigger.runtime === false
    && trigger.entitlementWriter === false
    && typeof trigger.securityDefiner === "boolean"
    && trigger.reason.trim().length > 0));
  assert.equal(DATABASE_PRINCIPAL_TRIGGER_FUNCTION_MATRIX.filter((trigger) => trigger.securityDefiner).map((trigger) => trigger.name).join(","), "project_git_automation_pause_cursor_on_grant_terminal,project_git_automation_pause_cursor_after_unknown,project_git_material_guard_grant_scope,project_git_material_consent_audit_capture,project_git_material_cursor_audit_capture,project_git_material_run_audit_capture,project_git_material_initialize_cursors,project_git_material_pause_on_grant_terminal,project_git_material_pause_cursor_after_unknown,project_git_automation_guard_project_delete");
  assert.equal(new Set(DATABASE_PRINCIPAL_TRIGGER_FUNCTION_MATRIX.map((trigger) => trigger.name)).size, DATABASE_PRINCIPAL_TRIGGER_FUNCTION_MATRIX.length);
  assert.ok(Object.isFrozen(DATABASE_PRINCIPAL_TRIGGER_FUNCTION_MATRIX));
  assert.ok(DATABASE_PRINCIPAL_RELATIONS.includes("ProjectMcpActionResultImport"));
  assert.ok(DATABASE_PRINCIPAL_TRIGGER_FUNCTION_MATRIX.some((trigger) => trigger.name === "project_mcp_action_result_import_guard"));
  assert.match(mcpActionResultImportMigration, /CREATE OR REPLACE FUNCTION "project_mcp_action_result_import_guard"\(\)/u);
  assert.match(mcpActionResultImportMigration, /CREATE TRIGGER "ProjectMcpActionResultImport_guard"/u);
  assert.match(mcpActionResultImportMigration, /REVOKE ALL ON FUNCTION "project_mcp_action_result_import_guard"\(\) FROM PUBLIC/u);
  for (const relation of ["OidcIdentityLinkAttempt", "OidcIdentityLinkAudit"] as const) {
    assert.ok(DATABASE_PRINCIPAL_RELATIONS.includes(relation));
    assert.ok(RUNTIME_ONLY_CONTROL_PLANE_RELATIONS.includes(relation));
  }
  for (const functionName of ["oidc_identity_link_attempt_guard", "reject_oidc_identity_link_audit_mutation"]) {
    assert.ok(DATABASE_PRINCIPAL_TRIGGER_FUNCTION_MATRIX.some((trigger) => trigger.name === functionName));
    assert.match(oidcIdentityLinkMigration, new RegExp(`CREATE FUNCTION ${functionName}\\(\\)`, "u"));
    assert.match(oidcIdentityLinkMigration, new RegExp(`REVOKE ALL ON FUNCTION ${functionName}\\(\\) FROM PUBLIC`, "u"));
  }
  for (const functionName of ["web_source_authenticated_configuration_guard", "external_credential_web_source_guard", "web_source_pointer_delete_guard", "web_source_reviewed_revision_guard"]) {
    assert.ok(DATABASE_PRINCIPAL_TRIGGER_FUNCTION_MATRIX.some((trigger) => trigger.name === functionName));
    assert.match(authenticatedWebSourceMigration, new RegExp(`CREATE FUNCTION ${functionName}\\(\\)`, "u"));
    assert.match(authenticatedWebSourceMigration, new RegExp(`REVOKE ALL ON FUNCTION ${functionName}\\(\\) FROM PUBLIC`, "u"));
  }
  assert.ok(DATABASE_PRINCIPAL_TRIGGER_FUNCTION_MATRIX.some((trigger) => trigger.name === "web_source_authenticated_lifecycle_guard"));
  assert.match(authenticatedWebSourceIdentityMigration, /CREATE FUNCTION public\.web_source_authenticated_lifecycle_guard\(\)[\s\S]*?SECURITY INVOKER[\s\S]*?SET search_path = pg_catalog/u);
  assert.match(authenticatedWebSourceIdentityMigration, /REVOKE ALL ON FUNCTION public\.web_source_authenticated_lifecycle_guard\(\) FROM PUBLIC/u);
  assert.match(authenticatedWebSourceIdentityMigration, /CREATE TRIGGER "WebSource_authenticated_lifecycle_guard"\s+BEFORE UPDATE OR DELETE ON public\."WebSource"/u);
  for (const relation of [
    "ProjectGitRepositoryAutomationScheduleCursor",
    "ProjectGitRepositoryAutomationRun",
    "ProjectGitRepositoryAutomationRunAudit",
  ] as const) {
    assert.ok(DATABASE_PRINCIPAL_RELATIONS.includes(relation));
    assert.ok(GIT_AUTOMATION_WORKER_LEDGER_RELATIONS.includes(relation));
    assert.ok(!(RUNTIME_ONLY_CONTROL_PLANE_RELATIONS as readonly string[]).includes(relation));
    assert.ok(!(runtimeMutableRelations() as readonly string[]).includes(relation));
  }
  for (const relation of [
    "GitConnection",
    "ProjectGitRepositoryDelegation",
    "ExternalCredential",
    "ProjectSource",
    "ProjectGitRepositoryPublicationVersion",
    "ProjectGitRepositoryPublicationEntry",
    "ProjectGitRepositoryPublicationHead",
  ] as const) {
    assert.ok(GIT_AUTOMATION_WORKER_CONTEXT_RELATIONS.includes(relation));
    assert.ok(DATABASE_PRINCIPAL_RELATIONS.includes(relation));
  }
  for (const functionName of [
    "project_git_automation_cursor_shape_guard",
    "project_git_automation_run_shape_guard",
    "project_git_automation_run_audit_append_only",
    "project_git_automation_run_audit_insert_guard",
    "project_git_automation_cursor_audit_required",
    "project_git_automation_run_audit_required",
    "project_git_automation_pause_cursor_on_grant_terminal",
  ]) {
    assert.ok(DATABASE_PRINCIPAL_TRIGGER_FUNCTION_MATRIX.some((trigger) => trigger.name === functionName));
  }
  const automationLedgerMigration = readFileSync("prisma/migrations/20260929030000_add_project_git_automation_run_ledger/migration.sql", "utf8");
  assert.match(automationLedgerMigration, /CREATE TABLE "ProjectGitRepositoryAutomationRunAudit"/u);
  assert.match(automationLedgerMigration, /CREATE TRIGGER "PGARA_no_update_delete"/u);
  assert.match(automationLedgerMigration, /SECURITY DEFINER[\s\S]*?SET search_path = pg_catalog[\s\S]*?project_git_automation_claim_due/u);
  assert.match(automationLedgerMigration, /REVOKE ALL ON FUNCTION public\."project_git_automation_claim_due"\(UUID, VARCHAR\) FROM PUBLIC/u);
  assert.match(automationLedgerMigration, /pg_trigger_depth\(\) < 2/u);
  assert.match(automationLedgerMigration, /CREATE TRIGGER "PGARSC_no_delete"/u);
  assert.match(automationLedgerMigration, /CREATE TRIGGER "PGAR_no_delete"/u);
  assert.match(automationLedgerMigration, /CREATE TRIGGER "PGARSC_no_truncate"/u);
  assert.match(automationLedgerMigration, /CREATE TRIGGER "PGAR_no_truncate"/u);
  assert.match(automationLedgerMigration, /CREATE TRIGGER "Project_git_automation_delete_guard"/u);
  assert.match(reconcile, /GIT_AUTOMATION_WORKER_LEDGER_RELATIONS/u);
  assert.match(reconcile, /DATABASE_PRINCIPAL_GIT_AUTOMATION_WORKER_DEFINER_FUNCTION_MATRIX/u);
  assert.match(reconcile, /DATABASE_PRINCIPAL_PRIVATE_FUNCTION_MATRIX/u);
  assert.match(authenticatedWebSourceIdentityMigration, /NEW\."authenticationMode" IS DISTINCT FROM 'bearer'/u);
  assert.match(authenticatedWebSourceIdentityMigration, /NEW\."projectId" IS DISTINCT FROM OLD\."projectId"/u);
  assert.match(authenticatedWebSourceIdentityMigration, /NEW\."id" IS DISTINCT FROM OLD\."id"/u);
  assert.match(authenticatedWebSourceIdentityMigration, /NEW\."url" IS DISTINCT FROM OLD\."url"/u);
  assert.match(authenticatedWebSourceIdentityMigration, /EXISTS \(SELECT 1 FROM public\."Project" AS project_row WHERE project_row\."id" = OLD\."projectId"\)/u);
  assert.ok(DATABASE_PRINCIPAL_TRIGGER_FUNCTION_MATRIX.some((trigger) => trigger.name === "web_source_bearer_project_source_review_chain_guard"));
  assert.ok(DATABASE_PRINCIPAL_TRIGGER_FUNCTION_MATRIX.some((trigger) => trigger.name === "web_source_identity_fence_touch"));
  assert.ok(DATABASE_PRINCIPAL_RELATIONS.includes("WebSourceIdentityFence"));
  assert.ok(DATABASE_PRINCIPAL_COORDINATION_RELATIONS.includes("WebSourceIdentityFence"));
  assert.ok(!runtimeMutableRelations().includes("WebSourceIdentityFence"));
  assert.match(authenticatedWebSourceIdentityMigration, /CREATE TABLE public\."WebSourceIdentityFence"[\s\S]*?PRIMARY KEY \("projectId", "sourceIdentity"\)[\s\S]*?REFERENCES public\."Project"\("id"\) ON DELETE CASCADE/u);
  assert.match(authenticatedWebSourceIdentityMigration, /CREATE FUNCTION public\.web_source_identity_fence_touch\(\)[\s\S]*?SECURITY INVOKER[\s\S]*?SET search_path = pg_catalog/u);
  assert.match(authenticatedWebSourceIdentityMigration, /pair_keys\."sourceIdentity" IS NOT NULL[\s\S]*?ORDER BY pair_keys\."projectId", pair_keys\."sourceIdentity"/u);
  assert.equal(authenticatedWebSourceIdentityMigration.match(/FROM unnest\(pair_project_ids, pair_(?:source_ids|web_source_ids)\)/gu)?.length, 2);
  assert.doesNotMatch(authenticatedWebSourceIdentityMigration, /pg_catalog\.unnest\(pair_project_ids,/u);
  assert.match(authenticatedWebSourceIdentityMigration, /ON CONFLICT \("projectId", "sourceIdentity"\) DO UPDATE[\s\S]*?SET "lockVersion" = NOT current_fence\."lockVersion"/u);
  assert.match(authenticatedWebSourceIdentityMigration, /CREATE TRIGGER "ProjectSource_identity_fence_touch"[\s\S]*?ON public\."ProjectSource"[\s\S]*?CREATE TRIGGER "WebSource_identity_fence_touch"[\s\S]*?ON public\."WebSource"[\s\S]*?CREATE TRIGGER "WebSourcePointer_identity_fence_touch"[\s\S]*?ON public\."WebSourcePointer"/u);
  assert.match(authenticatedWebSourceIdentityMigration, /REVOKE ALL ON FUNCTION public\.web_source_identity_fence_touch\(\) FROM PUBLIC/u);
  assert.match(reconcile, /REVOKE ALL PRIVILEGES \("projectId", "sourceIdentity", "lockVersion"\)/u);
  assert.match(reconcile, /GRANT UPDATE \("lockVersion"\)/u);
  assert.match(authenticatedWebSourceIdentityMigration, /CREATE FUNCTION public\.web_source_bearer_project_source_review_chain_guard\(\)[\s\S]*?SECURITY INVOKER[\s\S]*?SET search_path = pg_catalog/u);
  assert.match(authenticatedWebSourceIdentityMigration, /REVOKE ALL ON FUNCTION public\.web_source_bearer_project_source_review_chain_guard\(\) FROM PUBLIC/u);
  assert.match(authenticatedWebSourceIdentityMigration, /ARRAY\['ai_project_os_runtime', 'ai_project_os_entitlement_writer'\]/u);
  assert.match(authenticatedWebSourceIdentityMigration, /LOCK TABLE public\."Project"[\s\S]*?IN SHARE ROW EXCLUSIVE MODE/u);
  assert.match(authenticatedWebSourceIdentityMigration, /existing active bearer project source lacks a current accepted review chain/u);
  assert.match(authenticatedWebSourceIdentityMigration, /pg_catalog\.current_setting\('transaction_isolation'\) <> 'read committed'/u);
  assert.match(authenticatedWebSourceIdentityMigration, /pg_catalog\.pg_advisory_xact_lock/u);
  assert.match(authenticatedWebSourceIdentityMigration, /CREATE CONSTRAINT TRIGGER "ProjectSource_bearer_review_chain_guard"[\s\S]*?DEFERRABLE INITIALLY DEFERRED/u);
  assert.match(authenticatedWebSourceIdentityMigration, /CREATE CONSTRAINT TRIGGER "WebSource_bearer_review_chain_guard"[\s\S]*?DEFERRABLE INITIALLY DEFERRED/u);
  assert.match(authenticatedWebSourceIdentityMigration, /CREATE CONSTRAINT TRIGGER "WebSourcePointer_bearer_review_chain_guard"[\s\S]*?DEFERRABLE INITIALLY DEFERRED/u);
  assert.match(authenticatedWebSourceIdentityMigration, /project_source\."originScope"::TEXT = 'project'[\s\S]*?project_source\."kind"::TEXT <> 'mcp'[\s\S]*?project_source\."retiredAt" IS NULL/u);
  assert.match(authenticatedWebSourceIdentityMigration, /project_source\."kind"::TEXT <> 'web'/u);
  assert.match(authenticatedWebSourceIdentityMigration, /revision\."projectSourceId" = project_source\."id"/u);
  assert.match(authenticatedWebSourceIdentityMigration, /IF NOT EXISTS \([\s\S]*?FROM public\."Project"[\s\S]*?\) THEN\s+CONTINUE;[\s\S]*?transaction_isolation/u);
  assert.doesNotMatch(authenticatedWebSourceIdentityMigration, /SECURITY DEFINER/u);
  const gitManualUnchangedMigration = readFileSync("prisma/migrations/20260927040000_add_git_manual_unchanged_outcome/migration.sql", "utf8");
  for (const functionName of ["project_git_manual_runtime_unchanged_shape_guard", "project_git_manual_runtime_unchanged_audit_guard", "project_git_manual_runtime_unchanged_guard"]) {
    assert.ok(DATABASE_PRINCIPAL_TRIGGER_FUNCTION_MATRIX.some((trigger) => trigger.name === functionName));
    assert.ok(gitManualUnchangedMigration.includes('CREATE OR REPLACE FUNCTION "' + functionName + '"()'));
    assert.ok(gitManualUnchangedMigration.includes('REVOKE ALL ON FUNCTION "' + functionName + '"() FROM PUBLIC'));
  }
  const principalRelations: ReadonlySet<string> = new Set(DATABASE_PRINCIPAL_RELATIONS);
  for (const relation of ["ProjectGitRepositoryPublicationVersion", "ProjectGitRepositoryPublicationEntry", "ProjectGitRepositoryPublicationHead"]) {
    assert.ok(principalRelations.has(relation));
  }
  for (const functionName of [
    "project_git_publication_row_immutable",
    "project_git_manual_expected_publication_guard",
    "project_git_publication_version_insert_guard",
    "project_git_publication_head_guard",
    "project_git_publication_version_required",
    "project_git_manual_publication_success_guard",
  ]) {
    assert.ok(DATABASE_PRINCIPAL_TRIGGER_FUNCTION_MATRIX.some((trigger) => trigger.name === functionName));
    assert.match(sharedGitPublicationMigration, new RegExp(String.raw`CREATE OR REPLACE FUNCTION "${functionName}"\(\)`, "u"));
    assert.match(sharedGitPublicationMigration, new RegExp(String.raw`REVOKE ALL ON FUNCTION public\."${functionName}"\(\) FROM PUBLIC`, "u"));
  }
  assert.match(sharedGitPublicationMigration, /PROJECT_GIT_PUBLICATION_BACKFILL_INCONSISTENT_MANUAL_POINTER/u);
  assert.match(sharedGitPublicationMigration, /CREATE TEMP TABLE publication_backfill_map/u);
  assert.match(sharedGitPublicationMigration, /PROJECT_GIT_PUBLICATION_HEAD_CAS_MISMATCH/u);
  assert.match(sharedGitPublicationMigration, /PROJECT_GIT_PUBLICATION_PREVIOUS_SOURCES_NOT_RETIRED/u);
  assert.match(sharedGitPublicationMigration, /CREATE OR REPLACE FUNCTION "project_git_manual_runtime_unchanged_guard"\(\)[\s\S]*?PublicationHead[\s\S]*?publication_manifest/u);
  assert.ok(DATABASE_PRINCIPAL_GIT_AUTOMATION_WORKER_DEFINER_FUNCTION_MATRIX.some((helper) => helper.name === "project_git_automation_finalize_result"));
  assert.deepEqual(GIT_AUTOMATION_WORKER_POLL_COLUMNS.ProjectGitRepositoryAutomationRun, ["id", "status", "leaseExpiresAt"]);
  assert.match(automationRunService, /assertGitAutomationWorkerSession/u);
  assert.match(automationRunService, /if \(!isGitAutomationWorkerDatabase\(db\)\)/u);
  assert.doesNotMatch(automationRunService, /\bgetDb\s*\(/u);
  assert.match(db, /function createGitAutomationWorkerPrismaClient\(\)[\s\S]*?GIT_AUTOMATION_DATABASE_URL_REQUIRED/u);
  assert.match(db, /export function getGitAutomationWorkerDb\(\)[\s\S]*?createGitAutomationWorkerPrismaClient\(\)/u);
  const principalBootstrap = compose.match(/\n  principal-bootstrap:\n([\s\S]*?)(?=\n  [a-z-]+:\n|\nvolumes:)/u)?.[1] ?? "";
  const reconcileService = compose.match(/\n  reconcile:\n([\s\S]*?)(?=\n  [a-z-]+:\n|\nvolumes:)/u)?.[1] ?? "";
  const worker = compose.match(/\n  worker:\n([\s\S]*?)(?=\n  [a-z-]+:\n|\nvolumes:)/u)?.[1] ?? "";
  const app = compose.match(/\n  app:\n([\s\S]*?)(?=\n  [a-z-]+:\n|\nvolumes:)/u)?.[1] ?? "";
  assert.match(principalBootstrap, /GIT_AUTOMATION_DATABASE_URL/u);
  assert.match(reconcileService, /GIT_AUTOMATION_DATABASE_URL/u);
  assert.doesNotMatch(worker, /GIT_AUTOMATION_DATABASE_URL/u);
  assert.doesNotMatch(app, /GIT_AUTOMATION_DATABASE_URL/u);
  assert.match(automaticGitPublicationMigration, /strpos\(body_value, E'\\r'\) > 0/u);
  assert.match(automaticGitPublicationMigration, /runStatusAfter" IN \('pending', 'dispatched', 'failed', 'unknown'\)[\s\S]*?expectedPublicationGeneration" IS NULL/u);
  assert.match(automaticGitPublicationMigration, /CREATE OR REPLACE FUNCTION public\."project_git_automation_guard_project_delete"\(\)[\s\S]*?SECURITY DEFINER[\s\S]*?SET search_path = pg_catalog/u);
  assert.match(automaticGitPublicationMigration, /REVOKE ALL ON FUNCTION public\."project_git_automation_guard_project_delete"\(\) FROM PUBLIC/u);
  assert.match(automaticGitPublicationMigration, /CREATE OR REPLACE FUNCTION public\."project_git_automation_finalize_result"\([\s\S]*?SECURITY DEFINER[\s\S]*?SET search_path = pg_catalog\n/u);
  assert.match(automaticGitPublicationMigration, /83886080[\s\S]*?jsonb_array_length\(result_files\) > 2000/u);
  assert.match(automaticGitPublicationMigration, /body_bytes > 98304[\s\S]*?total_body_bytes \+ body_bytes > 12582912/u);
  assert.match(automaticGitPublicationMigration, /project_git_automation_path_allowed"\(path_value, run_row\."includeRoots", run_row\."softExcludePatterns"\)/u);
  assert.match(automaticGitPublicationMigration, /PROJECT_GIT_PUBLICATION_HEAD_CAS_MISMATCH/u);
  assert.match(automaticGitPublicationMigration, /PROJECT_GIT_AUTOMATION_PUBLICATION_PREVIOUS_SOURCES_NOT_RETIRED|PROJECT_GIT_PUBLICATION_PREVIOUS_SOURCES_NOT_RETIRED/u);
  assert.match(automaticGitPublicationMigration, /"status" = 'unknown'[\s\S]*?"pauseReason" = 'run_outcome_unknown'/u);
  assert.match(automaticGitPublicationMigration, /REVOKE ALL ON FUNCTION public\."project_git_automation_finalize_result"\(UUID, VARCHAR, UUID, VARCHAR, VARCHAR, JSONB\) FROM PUBLIC/u);
  assert.ok(DATABASE_PRINCIPAL_GIT_AUTOMATION_WORKER_DEFINER_FUNCTION_MATRIX.some((helper) => helper.name === "project_git_automation_read_context"));
  assert.match(gitAutomationReadContextMigration, /CREATE OR REPLACE FUNCTION public\."project_git_automation_read_context"\(\s*run_id UUID,\s*worker_id VARCHAR\(128\),\s*lease_token UUID\s*\)[\s\S]*?SECURITY DEFINER[\s\S]*?SET search_path = pg_catalog/u);
  assert.match(gitAutomationReadContextMigration, /SESSION_USER IS DISTINCT FROM 'ai_project_os_git_automation_worker'/u);
  assert.match(gitAutomationReadContextMigration, /transaction_isolation'\) <> 'serializable'/u);
  assert.match(gitAutomationReadContextMigration, /project_git_automation_lock_grant"\(grant_id\)[\s\S]*?FOR SHARE[\s\S]*?project_git_automation_grant_eligibility"\(grant_id[\s\S]*?project_git_automation_run_snapshot_matches"\(run_id\)/u);
  assert.match(gitAutomationReadContextMigration, /'authKind', CASE connection_row\."authKind"::TEXT[\s\S]*?WHEN 'ssh_key' THEN 'sshKey'/u);
  assert.match(gitAutomationReadContextMigration, /'ciphertext', pg_catalog\.replace\(pg_catalog\.encode\(credential_row\."ciphertext", 'base64'\), E'\\n', ''\)/u);
  assert.match(gitAutomationReadContextMigration, /'nonce', pg_catalog\.replace\(pg_catalog\.encode\(credential_row\."nonce", 'base64'\), E'\\n', ''\)/u);
  assert.match(gitAutomationReadContextMigration, /'authTag', pg_catalog\.replace\(pg_catalog\.encode\(credential_row\."authTag", 'base64'\), E'\\n', ''\)/u);
  assert.match(gitAutomationReadContextMigration, /baseline_repository_path IS DISTINCT FROM run_row\."repositoryPath"/u);
  assert.match(gitAutomationReadContextMigration, /baseline_tracked_ref IS DISTINCT FROM run_row\."trackedRef"/u);
  assert.match(gitAutomationReadContextMigration, /baseline_published_at IS DISTINCT FROM head_row\."publishedAt"/u);
  assert.match(gitAutomationReadContextMigration, /baseline_file_count <= 0/u);
  assert.match(gitAutomationReadContextMigration, /'frozenCommitSha', baseline_frozen_commit_sha/u);
  assert.match(gitAutomationReadContextMigration, /REVOKE ALL ON FUNCTION public\."project_git_automation_read_context"\(UUID, VARCHAR, UUID\) FROM PUBLIC/u);
  assert.doesNotMatch(gitAutomationReadContextMigration, /\b(?:INSERT|UPDATE|DELETE)\s+INTO\b/u);
  for (const relation of [
    "ProjectGitRepositoryMaterialCursor",
    "ProjectGitRepositoryMaterialRun",
    "ProjectGitRepositoryMaterialRunAudit",
    "ProjectGitRepositoryMaterialConsentAudit",
    "ProjectGitRepositoryMaterialPublicationVersion",
    "ProjectGitRepositoryMaterialPublicationHead",
    "ProjectGitRepositoryMaterialPublicationEntry",
    "ProjectGitRepositoryMaterialSourceVersion",
  ]) {
    assert.ok(DATABASE_PRINCIPAL_RELATIONS.includes(relation as (typeof DATABASE_PRINCIPAL_RELATIONS)[number]));
  }
  assert.ok(DATABASE_PRINCIPAL_GIT_AUTOMATION_WORKER_DEFINER_FUNCTION_MATRIX.some((helper) => helper.name === "project_git_material_finalize_result"));
  assert.ok(DATABASE_PRINCIPAL_PRIVATE_FUNCTION_MATRIX.some((helper) => helper.name === "project_git_material_run_snapshot_matches"));
  assert.equal(GIT_AUTOMATION_WORKER_POLL_COLUMNS.ProjectGitRepositoryAutomationGrant.includes("issuesEnabled"), true);
  assert.equal(GIT_AUTOMATION_WORKER_POLL_COLUMNS.ProjectGitRepositoryAutomationGrant.includes("pullRequestsEnabled"), true);
  assert.equal(GIT_AUTOMATION_WORKER_POLL_COLUMNS.ProjectGitRepositoryAutomationGrant.includes("releasesEnabled"), true);
  assert.match(gitAutomationMaterialMigration, /"issuesEnabled" BOOLEAN NOT NULL DEFAULT FALSE/iu);
  assert.match(gitAutomationMaterialMigration, /"pullRequestsEnabled" BOOLEAN NOT NULL DEFAULT FALSE/iu);
  assert.match(gitAutomationMaterialMigration, /"releasesEnabled" BOOLEAN NOT NULL DEFAULT FALSE/iu);
  assert.match(gitAutomationMaterialMigration, /project_git_material_claim_due[\s\S]*?SESSION_USER IS DISTINCT FROM 'ai_project_os_git_automation_worker'/u);
  assert.match(gitAutomationMaterialMigration, /project_git_material_finalize_result[\s\S]*?project_git_material_run_snapshot_matches"\(target_run\)[\s\S]*?PUBLICATION_HEAD_STALE/u);
  const materialSnapshotPredicate = gitAutomationMaterialMigration.match(/CREATE OR REPLACE FUNCTION public\."project_git_material_run_snapshot_matches"\([\s\S]*?\n\$\$;/u)?.[0] ?? "";
  assert.match(materialSnapshotPredicate, /SECURITY INVOKER/u);
  assert.match(gitAutomationMaterialMigration, /'nodeId', version_row\."githubRepositoryNodeId"/u);
  const materialFinalizer = gitAutomationMaterialMigration.match(/CREATE OR REPLACE FUNCTION public\."project_git_material_finalize_result"\([\s\S]*?\n\$\$;/u)?.[0] ?? "";
  assert.match(materialFinalizer, /"ProjectGitRepositoryMaterialPublicationHead"/u);
  assert.doesNotMatch(materialFinalizer, /"ProjectGitRepositoryPublicationHead"/u);
  const legacySourceReferenceGuard = gitAutomationMaterialMigration.match(
    /CREATE OR REPLACE FUNCTION public\."legacy_mcp_source_reference_guard"\(\)[\s\S]*?\n\$\$;/u,
  )?.[0] ?? "";
  assert.match(legacySourceReferenceGuard, /SECURITY INVOKER/u);
  assert.doesNotMatch(legacySourceReferenceGuard, /SECURITY DEFINER/u);
  assert.match(legacySourceReferenceGuard, /SET search_path = pg_catalog/u);
  assert.match(legacySourceReferenceGuard, /FROM public\."ProjectSource"/u);
  assert.doesNotMatch(legacySourceReferenceGuard, /FROM\s+"ProjectSource"/u);
  assert.doesNotMatch(legacySourceReferenceGuard, /\b(?:GRANT|REVOKE)\b/u);
  for (const functionName of [
    "project_git_material_guard_grant_scope",
    "project_git_material_claim_due",
    "project_git_material_mutate_lease",
    "project_git_material_reconcile_expired",
    "project_git_material_read_context",
    "project_git_material_finalize_result",
  ]) {
    assert.match(gitAutomationMaterialMigration, new RegExp(String.raw`REVOKE ALL ON FUNCTION public\."${functionName}"\(`, "u"));
  }
  for (const relation of [
    "ProjectGitRepositoryPublicationEntry",
    "ProjectGitRepositoryMaterialPublicationEntry",
    "ProjectGitRepositoryMaterialSourceVersion",
  ]) {
    assert.match(gitAutomationMaterialMigration, new RegExp(String.raw`ON public\."${relation}"[\s\S]*?legacy_mcp_source_reference_guard`, "u"));
  }
  assert.match(gitAutomationMaterialMigration, /"ProjectGitRepositoryMaterialPublicationHead"[\s\S]*?project_git_material_head_guard/u);
  assert.ok(DATABASE_PRINCIPAL_TRIGGER_FUNCTION_MATRIX.some((trigger) => trigger.name === "legacy_mcp_source_reference_guard"));
  assert.match(principalGateRunner, /EXPECTED_MIGRATION_COUNT = 133/u);
  assert.ok(DATABASE_PRINCIPAL_RELATIONS.includes("LocalRegistrationBudget"));
  assert.ok(ENTITLEMENT_PROTECTED_RELATIONS.includes("LocalRegistrationBudget"));
  assert.ok(!(RUNTIME_ONLY_CONTROL_PLANE_RELATIONS as readonly string[]).includes("LocalRegistrationBudget"));
  assert.ok(!DATABASE_PRINCIPAL_TRIGGER_FUNCTION_MATRIX.some((trigger) => trigger.name.includes("local_registration")));
  assert.match(readFileSync("prisma/migrations/20260927030000_add_local_registration_budget/migration.sql", "utf8"), /CHECK \("keyFingerprint" ~ '\^\[a-f0-9\]\{64\}\$'\)/u);
  assert.ok(DATABASE_PRINCIPAL_RELATIONS.includes("WebSourceReviewAudit"));
  assert.ok(WRITER_APPEND_ONLY_RELATIONS.includes("WebSourceReviewAudit"));
  assert.ok(!(RUNTIME_ONLY_CONTROL_PLANE_RELATIONS as readonly string[]).includes("WebSourceReviewAudit"));
  assert.match(reconcile, /writerAppendOnlyRelation\s*\?\s*"SELECT, INSERT"/u);
  assert.match(reconcile, /appendOnlyRow\.runtime_select[^\n]*appendOnlyRow\.runtime_insert/u);
  assert.match(reconcile, /appendOnlyRow\.writer_select[^\n]*appendOnlyRow\.writer_insert/u);
});

test("database principals are explicit and separated across Compose services", () => {
  assert.match(compose, /POSTGRES_USER:\s*\$\{POSTGRES_USER:-ai_project_os_cluster_admin\}/u);
  assert.match(compose, /POSTGRES_CLUSTER_ADMIN_PASSWORD/u);
  assert.match(compose, /POSTGRES_MIGRATOR_PASSWORD/u);
  assert.match(compose, /POSTGRES_ENTITLEMENT_INVENTORY_READER_PASSWORD/u);
  assert.match(compose, /principal-bootstrap:/u);
  assert.match(compose, /scripts\/reconcile-database-principals\.ts", "--bootstrap-if-needed/u);
  assert.match(compose, /ENTITLEMENT_DATABASE_URL:/u);
  assert.match(compose, /MIGRATOR_DATABASE_URL:/u);
  assert.match(compose, /principal-bootstrap:[\s\S]*?condition: service_completed_successfully[\s\S]*?migrate:/u);
  assert.ok(compose.indexOf("principal-bootstrap:") < compose.indexOf("migrate:"));
  assert.ok(compose.indexOf("migrate:") < compose.indexOf("reconcile:"));
  assert.ok(compose.indexOf("reconcile:") < compose.indexOf("app:"));
  assert.ok(compose.indexOf("reconcile:") < compose.indexOf("worker:"));
  const principalBootstrap = compose.match(/\n  principal-bootstrap:\n([\s\S]*?)(?=\n  [a-z-]+:\n|\nvolumes:)/u)?.[1] ?? "";
  assert.notEqual(principalBootstrap, "");
  assert.match(principalBootstrap, /DATABASE_PRINCIPAL_ADMIN_URL/u);
  assert.match(principalBootstrap, /DATABASE_PRINCIPAL_LEGACY_BOOTSTRAP_URL/u);
  const worker = compose.match(/\n  worker:\n([\s\S]*?)(?=\n  [a-z-]+:\n|\nvolumes:)/u)?.[1] ?? "";
  assert.notEqual(worker, "");
  const app = compose.match(/\n  app:\n([\s\S]*?)(?=\n  [a-z-]+:\n|\nvolumes:)/u)?.[1] ?? "";
  assert.doesNotMatch(`${app}\n${worker}`, /DATABASE_PRINCIPAL_ADMIN_URL|DATABASE_PRINCIPAL_LEGACY_BOOTSTRAP_URL|MIGRATOR_DATABASE_URL|POSTGRES_ENTITLEMENT_INVENTORY_READER_PASSWORD/u);
  assert.doesNotMatch(worker, /ENTITLEMENT_DATABASE_URL/u);
  assert.match(compose, /reconcile:\n[\s\S]*?condition: service_completed_successfully/u);
  assert.match(envExample, /DATABASE_PRINCIPAL_ADMIN_URL=/u);
  assert.match(envExample, /DATABASE_PRINCIPAL_LEGACY_BOOTSTRAP_URL=/u);
  assert.equal(packageJson.scripts?.["db:principals:bootstrap"], "tsx scripts/reconcile-database-principals.ts --bootstrap-if-needed");
});

test("writer access has a fail-closed URL and observed PostgreSQL session check", () => {
  assert.match(db, /ENTITLEMENT_WRITER_DATABASE_PRINCIPAL = "ai_project_os_entitlement_writer"/u);
  assert.match(db, /ENTITLEMENT_DATABASE_URL_REQUIRED/u);
  assert.match(db, /ENTITLEMENT_DATABASE_PRINCIPAL_INVALID/u);
  assert.match(db, /session_user, current_user/u);
  assert.match(db, /ENTITLEMENT_WRITER_SESSION_INVALID/u);
  assert.doesNotMatch(db, /getEntitlementDb[\s\S]{0,500}getDb\(\)/u);
  assert.match(activation, /assertEntitlementWriterSession/u);
  assert.match(backfill, /assertEntitlementWriterSession/u);
  assert.match(policy, /assertEntitlementWriterSession/u);
  for (const source of [auth, github, oidc, workspaces]) assert.match(source, /assertEntitlementWriterSession/u);
});

test("ACL reconcile rejects drift and does not widen ordinary roles with DDL privileges", () => {
  assert.match(reconcile, /DATABASE_PRINCIPAL_RELATION_INVENTORY_MISMATCH/u);
  assert.match(reconcile, /ALTER DATABASE/u);
  assert.match(reconcile, /ALTER SCHEMA public OWNER/u);
  assert.match(reconcile, /REVOKE CREATE, TEMPORARY ON DATABASE/u);
  assert.match(reconcile, /DATABASE_PRINCIPAL_BOOTSTRAP_OWNER_REQUIRED/u);
  assert.match(reconcile, /--bootstrap-if-needed/u);
  assert.match(reconcile, /DATABASE_PRINCIPAL_ARGUMENT_UNKNOWN/u);
  assert.match(reconcile, /assertSameDatabase\(coreUrls/u);
  assert.match(reconcile, /probeClusterAdmin/u);
  assert.match(reconcile, /DATABASE_PRINCIPAL_LEGACY_BOOTSTRAP_URL_REQUIRED/u);
  assert.doesNotMatch(reconcile, /REVOKE ALL ON ROLE/u);
  assert.doesNotMatch(reconcile, /GRANT[^\n]*(?:TRIGGER|REFERENCES)[^\n]*TO/u);
  assert.match(reconcile, /NOINHERIT NOREPLICATION NOBYPASSRLS/u);
  assert.match(reconcile, /NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS/u);
  assert.match(reconcile, /rolreplication/u);
  assert.match(reconcile, /!session\.is_superuser && !session\.can_create_role/u);
  assert.match(reconcile, /assertFinalRoleShape/u);
  assert.match(reconcile, /verifyRuntimeAndWriterSessions/u);
  assert.match(reconcile, /verifyMigratorSession\(verifier\)/u);
  assert.match(reconcile, /REASSIGN OWNED BY/u);
  assert.match(reconcile, /REASSIGN OWNED BY \$\{quoteIdentifier\(policy\.sourceRole\)\} TO \$\{quoteIdentifier\(CLUSTER_ADMIN_DATABASE_PRINCIPAL\)\}/u);
  assert.match(reconcile, /readCurrentOwnedObjects/u);
  assert.match(reconcile, /defaultPrivilegeOwners\(legacyOwner\)/u);
  assert.match(reconcile, /const revocationTargets = new Set<string>\(\[quoteIdentifier\(group\.owner\), "PUBLIC"\]\)/u);
  assert.match(reconcile, /GRANT EXECUTE ON FUNCTIONS TO PUBLIC/u);
  assert.match(reconcile, /REVOKE ALL ON FUNCTION public\.\$\{runtimeFunction\}[\s\S]*?FROM PUBLIC, \$\{quoteIdentifier\(RUNTIME_DATABASE_PRINCIPAL\)\}, \$\{quoteIdentifier\(ENTITLEMENT_WRITER_DATABASE_PRINCIPAL\)\}, \$\{quoteIdentifier\(GIT_AUTOMATION_WORKER_DATABASE_PRINCIPAL\)\}/u);
  assert.equal((reconcile.match(/REVOKE ALL ON FUNCTION \$\{signature\} FROM PUBLIC, \$\{quoteIdentifier\(RUNTIME_DATABASE_PRINCIPAL\)\}, \$\{quoteIdentifier\(ENTITLEMENT_WRITER_DATABASE_PRINCIPAL\)\}, \$\{quoteIdentifier\(GIT_AUTOMATION_WORKER_DATABASE_PRINCIPAL\)\}/gu) ?? []).length, 4);
  assert.match(reconcile, /for \(const signature of forbiddenFunctionSignatures\)[\s\S]*row\.worker_execute \|\| row\.worker_direct/u);
  assert.match(reconcile, /hardenedMigrator/u);
  assert.match(reconcile, /privilege\.object_type !== "f"/u);
  assert.match(reconcile, /type LegacyOwnershipPolicy/u);
  assert.match(reconcile, /kind: "preserve-sealed-oid10"/u);
  assert.match(reconcile, /sourceRole: LEGACY_BOOTSTRAP_DATABASE_PRINCIPAL/u);
  assert.match(reconcile, /sourceOid: "10"/u);
  assert.match(reconcile, /readSealedLegacyOwnershipPolicy/u);
  assert.match(reconcile, /createRequiredExtensions/u);
  assert.match(reconcile, /assertAllowedExtensionOwnership/u);
  assert.match(reconcile, /const ownedByClusterAdmin = row\.owner === CLUSTER_ADMIN_DATABASE_PRINCIPAL/u);
  assert.match(reconcile, /const ownedBySealedOid10 = row\.owner === policy\.sourceRole && row\.owner_oid === policy\.sourceOid/u);
  assert.match(reconcile, /return !ownedByClusterAdmin && !ownedBySealedOid10/u);
  assert.match(reconcile, /row\.schema_name !== expectedSchema/u);
  assert.match(reconcile, /row\.owner !== CLUSTER_ADMIN_DATABASE_PRINCIPAL/u);
  assert.match(reconcile, /if \(policy\.kind === "reassign" && sourceOid === "10"\) return fail\("DATABASE_PRINCIPAL_LEGACY_ROLE_POLICY_INVALID"\)/u);
  const ownershipTransfer = reconcile.match(/async function transferCurrentOwnedObjects\([\s\S]*?\n\}\n\nasync function/u)?.[0] ?? "";
  assert.notEqual(ownershipTransfer, "");
  assert.ok(ownershipTransfer.indexOf("const source =") < ownershipTransfer.indexOf("assertNoUnsupportedCurrentOwnership"));
  assert.ok(ownershipTransfer.indexOf('sourceOid === "10"') < ownershipTransfer.indexOf("REASSIGN OWNED BY"));
  assert.doesNotMatch(reconcile, /ALTER EXTENSION[^\n]*OWNER TO/u);
  assert.doesNotMatch(reconcile, /UPDATE\s+pg_(?:extension|shdepend)/iu);
  assert.doesNotMatch(reconcile, /DROP\s+EXTENSION/iu);
  assert.match(reconcile, /NOLOGIN[\s\S]*NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS/u);
  assert.match(reconcile, /DATABASE_PRINCIPAL_BOOTSTRAP_ROLE_RESERVED/u);
  assert.match(reconcile, /DATABASE_PRINCIPAL_BOOTSTRAP_SESSIONS_ACTIVE/u);
  assert.match(reconcile, /async function readTargetRoleSessions/u);
  assert.match(reconcile, /function targetRoleSessionPredicate/u);
  assert.match(reconcile, /backend_type === "client backend" \|\| session\.backend_type === "walsender"/u);
  assert.match(reconcile, /function classifyTargetRoleSession/u);
  assert.match(reconcile, /DATABASE_PRINCIPAL_TARGET_BACKGROUND_WORKER_ACTIVE/u);
  assert.match(reconcile, /session\.role_oid === sessionPolicy\.sourceOid/u);
  assert.match(reconcile, /session\.backend_type === "logical replication launcher"/u);
  assert.match(reconcile, /session\.datid === null/u);
  assert.match(reconcile, /session\.datname === null/u);
  const sessionDrain = reconcile.match(/async function freezeRoleSessions\([\s\S]*?\n\}\n\nasync function assertNoPreparedTransactions/u)?.[0] ?? "";
  assert.notEqual(sessionDrain, "");
  assert.match(sessionDrain, /readTargetRoleSessions\(client, role\)/u);
  assert.match(sessionDrain, /const drainableSessions = initialSessions\.filter/u);
  assert.match(sessionDrain, /classifyTargetRoleSessions\(initialSessions, sessionPolicy\)/u);
  assert.match(sessionDrain, /classifyTargetRoleSessions\(activeSessions, sessionPolicy\)/u);
  assert.match(sessionDrain, /pg_terminate_backend\(\$1::integer\)/u);
  assert.doesNotMatch(sessionDrain, /pg_terminate_backend\(\$1::integer,\s*\d+\)/u);
  assert.doesNotMatch(reconcile, /freezeRoleSessions\(client, bootstrapRole, pinnedSuperuser\)/u);
  assert.match(reconcile, /freezeRoleSessions\(admin, legacy\.originalRole, oid10SessionPolicy\(legacy\.originalRole, legacy\.oid\)\)/u);
  assert.match(reconcile, /freezeRoleSessions\(client, LEGACY_BOOTSTRAP_DATABASE_PRINCIPAL, sessionPolicyForOwnership\(sealedPolicy\)\)/u);
  assert.match(reconcile, /freezeRoleSessions\(admin, retiredRole, sessionPolicyForOwnership\(retiredRolePolicy\)\)/u);
  assert.match(reconcile, /assertTargetRoleSessionsDrained\(admin, retiredRole, sessionPolicyForOwnership\(retiredRolePolicy\)\)/u);
  assert.doesNotMatch(reconcile, /assertTargetRoleSessionsDrained\(verifier, retiredRole/u);
  assert.match(reconcile, /async function sealLegacySource/u);
  assert.match(reconcile, /if \(sourceRow\.can_login\) await admin\.query\(`ALTER ROLE/u);
  assert.match(reconcile, /mainCommitIssued/u);
  assert.match(reconcile, /if \(!mainCommitIssued\) await admin\.query\("ROLLBACK"\)/u);
  assert.match(reconcile, /let postCommitIssued = false/u);
  assert.match(reconcile, /if \(!postCommitIssued\) await admin\.query\("ROLLBACK"\)/u);
  assert.match(reconcile, /DATABASE_PRINCIPAL_BOOTSTRAP_OWNERSHIP_INVALID/u);
  assert.match(reconcile, /DATABASE_PRINCIPAL_EXTERNAL_ROLE_SETTINGS_FORBIDDEN/u);
  assert.match(reconcile, /DATABASE_PRINCIPAL_SESSION_REPLICATION_ROLE_INVALID/u);
  assert.match(reconcile, /DATABASE_PRINCIPAL_RELATION_OWNER_INVALID/u);
  assert.match(reconcile, /DATABASE_PRINCIPAL_NONCLASS_OWNER_INVALID/u);
  assert.match(reconcile, /DATABASE_PRINCIPAL_APPLICATION_OWNER_INVALID/u);
  assert.match(reconcile, /const FIRST_NORMAL_OBJECT_ID = 16384/u);
  const unsupportedOwnership = reconcile.match(/async function assertNoUnsupportedCurrentOwnership\([\s\S]*?\n\}\n\nasync function isExtensionMember/u)?.[0] ?? "";
  assert.notEqual(unsupportedOwnership, "");
  assert.match(unsupportedOwnership, /const unsupportedCatalogNamespaceClause/u);
  assert.match(unsupportedOwnership, /namespace\.oid >= \$\{FIRST_NORMAL_OBJECT_ID\}/u);
  assert.match(unsupportedOwnership, /const pinnedNamespaceObjectClause = preservesSealedOid10\s+\? `[^`]*namespace\.nspname !~ '\^pg_temp_\[0-9\]\+\$'[^`]*namespace\.nspname !~ '\^pg_toast_temp_\[0-9\]\+\$'/u);
  assert.doesNotMatch(unsupportedOwnership, /const pinnedNamespaceObjectClause = preservesSealedOid10\s+\? `[^`]*NOT LIKE 'pg_%'/u);
  assert.match(unsupportedOwnership, /relation\.oid >= \$\{FIRST_NORMAL_OBJECT_ID\}/u);
  assert.match(unsupportedOwnership, /function_row\.oid >= \$\{FIRST_NORMAL_OBJECT_ID\}/u);
  assert.match(unsupportedOwnership, /type_row\.oid >= \$\{FIRST_NORMAL_OBJECT_ID\}/u);
  assert.match(unsupportedOwnership, /dependency\.classid = 'pg_namespace'::regclass/u);
  assert.match(unsupportedOwnership, /dependency\.classid = 'pg_class'::regclass/u);
  assert.match(unsupportedOwnership, /dependency\.classid = 'pg_proc'::regclass/u);
  assert.match(unsupportedOwnership, /dependency\.classid = 'pg_type'::regclass/u);
  assert.match(unsupportedOwnership, /AND NOT EXISTS \([\s\S]*?extension_row\.extname = ANY\(\$2::text\[\]\)/u);
  assert.match(unsupportedOwnership, /catalog_row\.oid >= \$\{FIRST_NORMAL_OBJECT_ID\}/u);
  assert.match(unsupportedOwnership, /EXISTS \([\s\S]*?oid = catalog_row\.\$\{namespaceColumn\}/u);
  const unsupportedCatalogNamespaceClause = unsupportedOwnership.match(/const unsupportedCatalogNamespaceClause = [\s\S]*?\n      : "";/u)?.[0] ?? "";
  assert.notEqual(unsupportedCatalogNamespaceClause, "");
  assert.doesNotMatch(unsupportedCatalogNamespaceClause, /AND NOT EXISTS \([\s\S]*?oid = catalog_row\.\$\{namespaceColumn\}/u);
  assert.match(reconcile, /ALTER ROLE[^\n]*RESET ALL/u);
  assert.match(reconcile, /ALTER ROLE[^\n]*IN DATABASE[^\n]*RESET ALL/u);
  assert.match(reconcile, /REVOKE ALL ON DATABASE/u);
  assert.match(reconcile, /REVOKE ALL ON TABLE public\./u);
  assert.match(reconcile, /REVOKE ALL ON SEQUENCE public\./u);
  assert.match(reconcile, /async function revokePublicDdl/u);
  assert.match(reconcile, /REVOKE CREATE, TEMPORARY ON DATABASE[^\n]*FROM PUBLIC/u);
  assert.match(reconcile, /REVOKE CREATE ON SCHEMA public FROM PUBLIC/u);
  const inventoryReaderGrant = reconcile.match(/async function grantInventoryReader\([\s\S]*?\n\}/u)?.[0] ?? "";
  assert.notEqual(inventoryReaderGrant, "");
  assert.ok(inventoryReaderGrant.indexOf("revokePublicDdl") < inventoryReaderGrant.indexOf("REVOKE ALL ON DATABASE"));
  assert.match(reconcile, /quoteIdentifier\(RUNTIME_DATABASE_PRINCIPAL\)/u);
  assert.match(reconcile, /quoteIdentifier\(ENTITLEMENT_WRITER_DATABASE_PRINCIPAL\)/u);
  assert.match(reconcile, /ALTER DEFAULT PRIVILEGES/u);
  assert.match(reconcile, /DATABASE_PRINCIPAL_DEFAULT_ACL_INVALID/u);
  assert.match(reconcile, /DATABASE_PRINCIPAL_DEFAULT_ACL_OWNER_REQUIRED/u);
  assert.match(reconcile, /assertRetiredRoleShape/u);
  assert.match(reconcile, /FROM pg_authid/u);
  assert.match(reconcile, /assertRetiredRoleShape\(admin, sealedPolicy\)/u);
  assert.match(reconcile, /assertRetiredRoleAttributes\(verifier, retiredRolePolicy\)/u);
  const pendingLegacy = reconcile.match(/async function discoverPendingLegacy\([\s\S]*?\n\}\n\nasync function bootstrapIfNeeded/u)?.[0] ?? "";
  assert.notEqual(pendingLegacy, "");
  assert.match(pendingLegacy, /readSealedLegacyOwnershipPolicy\(client\)/u);
  assert.doesNotMatch(pendingLegacy, /FROM pg_roles[\s\S]*rolpassword/u);
  assert.match(pendingLegacy, /if \(!row\.is_superuser\)/u);
  assert.match(reconcile, /verifyRetiredRoleCannotLogin/u);
  assert.match(reconcile, /transferCurrentOwnedObjects/u);
  assert.match(reconcile, /GRANT EXECUTE ON FUNCTION/u);
  assert.match(catalog, /ACCOUNT_ENTITLEMENT_SIGNUP_GRANT_CLOSURE_FUNCTION/u);
  assert.match(catalog, /DATABASE_PRINCIPAL_INVOKER_FUNCTION_MATRIX/u);
  assert.match(reconcile, /DATABASE_PRINCIPAL_INVOKER_FUNCTION_MATRIX/u);
  assert.match(catalog, /DATABASE_PRINCIPAL_TRIGGER_FUNCTION_MATRIX/u);
  assert.match(reconcile, /DATABASE_PRINCIPAL_TRIGGER_FUNCTION_MATRIX/u);
  assert.match(reconcile, /invokerFunctionSignature/u);
  assert.match(reconcile, /triggerFunctionSignature/u);
  assert.match(connectionGovernanceMigration, /REVOKE ALL ON FUNCTION "git_connection_configuration_version_guard"\(\) FROM PUBLIC/u);
  assert.match(connectionGovernanceMigration, /REVOKE ALL ON FUNCTION "mcp_connection_configuration_revision_guard"\(\) FROM PUBLIC/u);
  assert.match(gitManualRuntimeRecoveryMigration, /CREATE OR REPLACE FUNCTION "project_git_manual_runtime_audit_guard"\(\)/u);
  assert.match(gitManualRuntimeRecoveryMigration, /SET search_path = pg_catalog, public/u);
  assert.match(gitManualRuntimeRecoveryMigration, /PROJECT_GIT_MANUAL_FINAL_ADMISSION_REJECTED/u);
  assert.match(gitManualRuntimeRecoveryMigration, /ProjectGitRepositoryManualRunAudit_system_final_fence_key/u);
  assert.match(gitManualRuntimeRecoveryMigration, /PROJECT_GIT_MANUAL_FINAL_FENCE_EVIDENCE_STILL_VALID/u);
  assert.match(gitManualRuntimeRecoveryMigration, /PROJECT_GIT_MANUAL_FINAL_FENCE_PRE_DISPATCH_REQUIRED/u);
  assert.match(gitManualRuntimeRecoveryMigration, /REVOKE ALL ON FUNCTION "project_git_manual_runtime_audit_guard"\(\) FROM PUBLIC/u);
  assert.match(reconcile, /REVOKE ALL ON FUNCTION \$\{signature\} FROM PUBLIC/u);
  assert.match(reconcile, /GRANT EXECUTE ON FUNCTION \$\{signature\} TO \$\{grantees\.join/u);
  assert.match(reconcile, /helperRow\.prosecdef/u);
  assert.match(reconcile, /helperRow\.public_execute/u);
  assert.match(reconcile, /runtimeHelperCount !== 45/u);
  assert.match(reconcile, /writerHelperCount !== 8/u);
  assert.match(reconcile, /revokeRoleMembershipEdges\(admin, MIGRATOR_DATABASE_PRINCIPAL\)/u);
  assert.match(reconcile, /ALTER ROLE \$\{identifier\} WITH LOGIN SUPERUSER CREATEDB CREATEROLE/u);
  assert.match(reconcile, /assertNoRoleMembership/u);
  assert.match(reconcile, /value\.search !== "" \|\| value\.hash !== ""/u);
  assert.doesNotMatch(reconcile, /pg_ts_parser|prsowner|pg_ts_template|tmplowner/u);
});

test("the isolated OID10 PostgreSQL gate runs after the shared PostgreSQL gates", () => {
  const sharedGate = ci.indexOf("run: pnpm test:postgres-gates");
  const oid10Gate = ci.indexOf("run: pnpm test:database-principal-oid10");
  assert.ok(sharedGate >= 0);
  assert.ok(oid10Gate > sharedGate);
  assert.match(ci, /name: Run isolated PostgreSQL 18 OID10 gate/u);
});

test("protected entitlement relations require the real session principal", () => {
  assert.match(migration, /session_user/u);
  assert.match(migration, /ai_project_os_entitlement_writer/u);
  assert.match(migration, /pg_get_userbyid\(c\.relowner\)/u);
  assert.match(migration, /ERRCODE = '42501'/u);
  assert.match(migration, /IF TG_OP = 'DELETE'\s+THEN\s+RETURN OLD;\s+END IF;\s+RETURN NEW;/u);
  const entitlementMigration = readFileSync("prisma/migrations/20260911010000_add_platform_token_governance/migration.sql", "utf8");
  assert.match(entitlementMigration, /CREATE OR REPLACE FUNCTION "platform_token_runtime_apply"[\s\S]*SECURITY DEFINER[\s\S]*SET search_path = pg_catalog, public/u);
  assert.match(entitlementMigration, /CREATE OR REPLACE FUNCTION "platform_token_governance_apply"[\s\S]*SECURITY DEFINER[\s\S]*SET search_path = pg_catalog, public/u);
  for (const relation of [
    "PlatformGrantOfferPolicy",
    "AccountEntitlementActivation",
    "AccountEntitlementBackfillRun",
    "PlatformTokenGrant",
    "PlatformTokenLedgerEntry",
  ]) {
    assert.match(migration, new RegExp(`"${relation}_session_principal_guard"`, "u"));
  }
  assert.match(catalog, /DATABASE_PRINCIPAL_RELATIONS/u);
  assert.match(catalog, /ENTITLEMENT_PROTECTED_RELATIONS/u);
});

test("the PostgreSQL gate exercises production reconcile and both real principals", () => {
  assert.match(postgresGate, /scripts\/reconcile-database-principals\.ts/u);
  assert.match(postgresGate, /DATABASE_PRINCIPAL_ADMIN_URL/u);
  assert.match(postgresGate, /DATABASE_PRINCIPAL_LEGACY_BOOTSTRAP_URL/u);
  assert.match(postgresGate, /getEntitlementDb\(\)/u);
  assert.match(postgresGate, /reservePlatformTokens/u);
  assert.match(postgresGate, /SET SESSION AUTHORIZATION/u);
  assert.match(postgresGate, /AI_SIGNUP_GRANT/u);
  assert.match(postgresGate, /DATABASE_PRINCIPAL_INVOKER_FUNCTION_MATRIX/u);
  assert.match(postgresGate, /assertInvokerHelperAcls/u);
  assert.match(postgresGate, /pg_get_function_identity_arguments/u);
  assert.match(postgresGate, /AccountEntitlementBackfillRun/u);
  assert.match(postgresGate, /DELETE FROM "PlatformTokenLedgerEntry"/u);
  assert.match(postgresGate, /runPrincipalBootstrap\(runtimePassword, migratorPassword, writerPassword(?:, [^)]*)?\)/u);
  assert.match(postgresGate, /await runProductionReconcile\(runtimePassword, migratorPassword, writerPassword\)/u);
  assert.match(postgresGate, /REASSIGN OWNED BY/u);
  const ownershipHelper = postgresGate.match(/async function transferPublicOwnership\([\s\S]*?\n\}\n\nasync function findRepresentativeOwnedObjects/u)?.[0] ?? "";
  assert.notEqual(ownershipHelper, "");
  assert.ok(ownershipHelper.indexOf("REASSIGN OWNED BY") < ownershipHelper.indexOf("ALTER DATABASE"));
  assert.doesNotMatch(ownershipHelper, /for \(const relation of relations\.rows\)/u);
  assert.match(postgresGate, /transferPublicOwnership\(admin, legacyRole, initialDatabaseOwner\)/u);
  assert.match(postgresGate, /transferPublicOwnership\(admin, "ai_project_os_legacy_bootstrap", initialDatabaseOwner\)/u);
  assert.match(postgresGate, /cleanupAssertionError \?\?= error/u);
  assert.match(postgresGate, /database-principal cleanup left role/u);
  assert.match(postgresGate, /normalizedDefaults/u);
  assert.match(postgresGate, /migratorDefaults/u);
  assert.match(postgresGate, /retiredDefaults/u);
  assert.match(postgresGate, /findRepresentativeOwnedObjects/u);
  assert.match(postgresGate, /rolcanlogin: false/u);
  assert.match(postgresGate, /\["28000", "28P01"\]\.includes\(errorCode\(error\) \?\? ""\)/u);
  assert.match(postgresGate, /FROM pg_authid/u);
  assert.match(postgresGate, /backend_type IN \('client backend', 'walsender'\)/u);
  assert.match(postgresGate, /activity\.usesysid::text = '10'/u);
  assert.match(postgresGate, /row\.rolname === migratorRole\)\?\.rolcreaterole, false/u);
});
