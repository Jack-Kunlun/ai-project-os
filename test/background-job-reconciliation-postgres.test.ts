import "dotenv/config";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { Client } from "pg";
import {
  ProjectWorkflowError,
  reconcileProjectJob,
} from "../src/lib/project-workflow";
import { grantProjectMembership } from "../src/lib/membership-governance";

const repositoryRoot = process.cwd();
const databaseName = "ai_project_os_background_job_reconciliation_test";
const databasePort = "56432";
const configuredUrl = process.env.DATABASE_URL;
const gate = process.env.BACKGROUND_JOB_RECONCILIATION_POSTGRES_GATE;
const shouldRun = gate === "1";
const execFile = promisify(execFileCallback);
const baseMigrationNames = [
  "20260826021100_init",
  "20260826030732_integrity_boundaries",
  "20260827090000_add_ai_runtime_governance",
  "20260827120000_add_ai_memory_candidates",
  "20260827140000_add_item_evidence_history",
  "20260828100000_add_source_chunks",
  "20260828123000_add_index_generations",
  "20260828150000_publish_ai_candidate_items",
  "20260828170000_add_ai_operation_profiles",
  "20260828210000_add_project_rag_snapshots",
  "20260828233000_add_ai_derived_artifacts",
  "20260829010000_add_github_repository_ledger",
  "20260829020000_bind_github_scan_security",
  "20260829033000_add_repository_code_indexes",
  "20260829050000_add_repository_material_ledger",
  "20260829051000_harden_repository_material_policy",
  "20260829052000_seal_repository_material_terminal_rows",
  "20260829053000_add_repository_material_indexes",
  "20260829060000_add_repository_rag_snapshots",
  "20260829070000_restore_grant_operation_profile_guard",
  "20260829080000_add_web_control_plane",
  "20260829090000_expand_web_ai_jobs",
  "20260829100000_add_project_intelligence",
  "20260829110000_add_project_ai_route_revisions",
  "20260829120000_add_recoverable_job_attempts",
  "20260829130000_add_github_project_sync_job_kind",
  "20260829131000_add_project_github_sync_runs",
  "20260829140000_add_memory_index_build_modes",
  "20260829141000_add_memory_index_candidates",
] as const;
const postD0ThroughWorkspaceRbacMigrationNames = [
  "20260829150000_add_project_lifecycle_and_export_audits",
  "20260829151000_guard_archived_project_jobs",
  "20260829160000_add_project_assets",
  "20260829170000_add_multi_git_repositories",
  "20260829180000_add_automation_worker",
  "20260829190000_add_memory_quality",
  "20260829200000_add_web_sources",
  "20260829210000_add_workspaces_rbac_oidc",
] as const;
const postWorkspaceRbacMigrationNames = [
  "20260829211000_fix_long_path_constraints",
  "20260829212000_scope_manual_source_deduplication",
  "20260829213000_add_oidc_endpoint_pinning",
  "20260829214000_align_oidc_discovery_defaults",
  "20260829220000_add_project_action_engine",
  "20260829230000_add_controlled_mcp_capabilities",
  "20260830010000_add_action_result_intake",
  "20260830020000_add_evidence_driven_project_plan",
  "20260830030000_add_project_operations_loop",
  "20260830040000_add_project_world_model",
  "20260830050000_harden_source_provenance_and_mcp_attestation",
  "20260831000000_add_worker_runtime_health",
  "20260901000000_add_project_asset_upload_admission",
  "20260901010000_add_safe_project_deletion",
  "20260902000000_add_github_oauth_login",
  "20260902010000_add_ai_entitlements_and_provider_scope",
  "20260903010000_add_user_system_role_compatibility",
  "20260903020000_add_user_ai_provider_scope",
  "20260903030000_add_platform_policies_and_connection_ownership",
  "20260904010000_default_new_app_users_to_user",
  "20260904020000_add_platform_default_route_control_plane",
  "20260904030000_add_ai_provider_ownership_audit",
  "20260904040000_add_membership_access_governance",
] as const;
const postMemorySchemaMigrationNames = [
  "20260904060000_add_runtime_ai_route_snapshots",
  "20260904070000_add_runtime_ai_grant_billing_fences",
  "20260904080000_add_personal_ai_provider_ownership",
  "20260904090000_add_project_ai_provider_delegations",
  "20260904100000_allow_delegation_owner_safety_switch",
  "20260904110000_add_personal_ai_runtime_evidence",
  "20260904120000_harden_personal_memory_runtime_invalidation",
  "20260904130000_bind_personal_memory_dispatch_admission",
  "20260904140000_scope_personal_git_mcp_connections",
  "20260904150000_add_project_git_repository_delegations",
  "20260904160000_add_project_git_manual_runtime",
  "20260904170000_add_project_git_manual_run_reconciliation",
  "20260904180000_add_project_mcp_connection_delegations",
  "20260904190000_add_mcp_control_plane_v2",
  "20260904200000_add_project_mcp_grant_retention_ledger",
  "20260904210000_add_project_mcp_action_approval_control_plane",
  "20260904220000_add_project_mcp_action_dispatch_runtime",
  "20260904230000_quarantine_legacy_mcp_sources",
  "20260905010000_harden_workspace_invitation_governance",
  "20260905020000_harden_membership_subscription_lifecycle",
  "20260905030000_harden_account_access_lifecycle",
  "20260905040000_bind_personal_ai_owner_access_epoch",
  "20260905045000_preserve_personal_ai_audit_on_project_deletion",
  "20260905046000_preserve_personal_ai_audit_multi_fk_cascade",
  "20260905050000_bind_personal_git_owner_access_epoch",
  "20260905060000_bind_personal_mcp_owner_access_epoch",
] as const;

function validateUrl(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("BACKGROUND_JOB_RECONCILIATION_TEST_DATABASE_URL_REQUIRED");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("BACKGROUND_JOB_RECONCILIATION_TEST_DATABASE_URL_INVALID");
  }
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname.toLowerCase()) ||
    parsed.port !== databasePort ||
    parsed.pathname !== `/${databaseName}` ||
    parsed.search !== "?schema=public" ||
    parsed.hash !== ""
  ) {
    throw new Error("BACKGROUND_JOB_RECONCILIATION_TEST_DATABASE_URL_NOT_DISPOSABLE");
  }
  return value;
}

async function stageMigrations(tempRoot: string, names: readonly string[]): Promise<void> {
  const migrationsRoot = join(tempRoot, "prisma", "migrations");
  await mkdir(migrationsRoot, { recursive: true });
  for (const name of names) {
    await cp(join(repositoryRoot, "prisma", "migrations", name), join(migrationsRoot, name), { recursive: true });
  }
}

async function deployStagedMigrations(tempRoot: string, url: string): Promise<void> {
  await execFile(
    "pnpm",
    ["exec", "prisma", "migrate", "deploy", "--config", join(tempRoot, "prisma.config.ts")],
    { cwd: repositoryRoot, env: { ...process.env, DATABASE_URL: url } },
  );
}

function fixedKey(prefix: string): string {
  return `${prefix}${"0".repeat(64 - prefix.length)}`;
}

test(
  "background-job reconciliation upgrade gate is isolated and auditable",
  { skip: !shouldRun ? "BACKGROUND_JOB_RECONCILIATION_POSTGRES_GATE=1 is required" : false },
  async () => {
    const url = validateUrl(configuredUrl);
    const raw = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
    let rawConnected = false;
    let tempRoot: string | null = null;
    let db: PrismaClient | null = null;
    const projectId = "11111111-1111-4111-8111-111111111111";
    const otherProjectId = "22222222-2222-4222-8222-222222222222";
    const cascadeProjectId = "33333333-3333-4333-8333-333333333333";
    const userId = "44444444-4444-4444-8444-444444444444";
    const actorId = "55555555-5555-4555-8555-555555555555";
    const actor = { id: actorId, role: "admin" as const, accountAccessVersion: 1 };
    const unknownJobId = "55555555-5555-4555-8555-555555555555";
    const crossProjectJobId = "66666666-6666-4666-8666-666666666666";
    const wrongActorJobId = "77777777-7777-4777-8777-777777777777";
    const memoryJobId = "88888888-8888-4888-8888-888888888888";
    const githubJobId = "99999999-9999-4999-8999-999999999999";
    const queuedJobId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const cascadeJobId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const genericCrossJobId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const memoryGenerationId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const memoryReconciliationId = "12121212-1212-4121-8121-121212121212";
    const memoryCredentialId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const memoryProviderId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const githubSyncRunId = "00000000-0000-4000-8000-000000000001";
    const githubScanJobId = "00000000-0000-4000-8000-000000000002";
    const githubMaterialJobId = "00000000-0000-4000-8000-000000000003";

    try {
      await raw.connect();
      rawConnected = true;
      // The URL has already been restricted to a dedicated disposable target.
      await raw.query("DROP OWNED BY CURRENT_USER CASCADE;");

      tempRoot = await mkdtemp(join(tmpdir(), "ai-project-os-background-job-reconciliation-"));
      await mkdir(join(tempRoot, "prisma"), { recursive: true });
      await symlink(join(repositoryRoot, "node_modules"), join(tempRoot, "node_modules"), "dir");
      await cp(join(repositoryRoot, "prisma", "schema.prisma"), join(tempRoot, "prisma", "schema.prisma"));
      await writeFile(join(tempRoot, "prisma.config.ts"), `import "dotenv/config";
import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: env("DATABASE_URL") },
});
`, "utf8");

      // First deploy only through 20260829141000. The unknown job is written
      // before D0 exists so this gate proves the upgrade never auto-closes it.
      await stageMigrations(tempRoot, baseMigrationNames);
      await deployStagedMigrations(tempRoot, url);
      await raw.query(
        `INSERT INTO "Project" ("id", "name", "slug", "createdAt", "updatedAt")
         VALUES ($1, 'Background reconciliation project', 'background-reconciliation-project', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
                ($2, 'Background reconciliation other project', 'background-reconciliation-other-project', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
                ($3, 'Background reconciliation cascade project', 'background-reconciliation-cascade-project', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [projectId, otherProjectId, cascadeProjectId],
      );
      await raw.query(
        `INSERT INTO "AppUser"
          ("id", "username", "passwordHash", "passwordSalt", "passwordVersion", "role", "createdAt", "updatedAt")
         VALUES ($1, 'background_reconciliation_gate', $2, $3, 1, 'admin', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [userId, "a".repeat(43), "b".repeat(22)],
      );
      await raw.query(
        `INSERT INTO "BackgroundJob"
          ("id", "projectId", "kind", "status", "stage", "payload", "failureCode", "idempotencyKey", "requestedById", "reconciliationRequired", "createdAt")
         VALUES ($1, $2, 'project_brief', 'unknown', 'reconciliation_required', '{}'::jsonb, 'RECONCILIATION_REQUIRED', $3, $4, true, CURRENT_TIMESTAMP)`,
        [unknownJobId, projectId, fixedKey("unknown-"), userId],
      );
      const beforeD0 = await raw.query<{ status: string; reconciliationRequired: boolean }>(
        `SELECT "status", "reconciliationRequired" FROM "BackgroundJob" WHERE "id" = $1`,
        [unknownJobId],
      );
      assert.deepEqual(beforeD0.rows[0], { status: "unknown", reconciliationRequired: true });

      await stageMigrations(tempRoot, ["20260829142000_add_background_job_reconciliations"]);
      await deployStagedMigrations(tempRoot, url);
      const afterD0 = await raw.query<{ status: string; reconciliationRequired: boolean }>(
        `SELECT "status", "reconciliationRequired" FROM "BackgroundJob" WHERE "id" = $1`,
        [unknownJobId],
      );
      assert.deepEqual(afterD0.rows[0], { status: "unknown", reconciliationRequired: true });

      await stageMigrations(tempRoot, postD0ThroughWorkspaceRbacMigrationNames);
      await deployStagedMigrations(tempRoot, url);
      await raw.query(
        `INSERT INTO "AppUser"
          ("id", "username", "passwordHash", "passwordSalt", "passwordVersion", "role", "createdAt", "updatedAt")
         VALUES ($1, 'background_reconciliation_actor', $2, $3, 1, 'admin', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [actorId, "c".repeat(43), "d".repeat(22)],
      );
      await stageMigrations(tempRoot, postWorkspaceRbacMigrationNames);
      await deployStagedMigrations(tempRoot, url);

      // Stop before runtime route snapshots so the memory job, its platform
      // provider, credential, and generation are genuine pre-0600 rows. The
      // subsequent migration chain must preserve this history as legacy data.
      await stageMigrations(tempRoot, ["20260904050000_add_membership_governance_manifest_evidence"]);
      await deployStagedMigrations(tempRoot, url);
      await raw.query(
        `INSERT INTO "ExternalCredential"
          ("id", "kind", "ciphertext", "nonce", "authTag", "keyVersion", "maskedSuffix", "secretFingerprint", "createdAt", "updatedAt")
         VALUES ($1, 'ai_provider', decode('00', 'hex'), decode('00', 'hex'), decode('00', 'hex'), 1, '0000', $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [memoryCredentialId, "f".repeat(64)],
      );
      await raw.query(
        `INSERT INTO "AiProviderConnection"
          ("id", "name", "kind", "scope", "workspaceId", "ownerUserId", "ownershipState", "protocol", "baseUrl", "credentialId", "defaultGenerationModelId", "defaultEmbeddingModelId", "embeddingDimensions", "configurationVersion", "status", "createdAt", "updatedAt")
         VALUES ($1, $2, 'openai', 'platform', NULL, NULL, 'legacy_pending', 'chat_completions', 'https://api.openai.com/v1', $3,
                 'generation-background-reconciliation', 'embedding-background-reconciliation', 8, 1, 'verified', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [memoryProviderId, `Background reconciliation provider ${projectId.slice(0, 8)}`, memoryCredentialId],
      );
      await raw.query(
        `INSERT INTO "BackgroundJob"
          ("id", "projectId", "kind", "status", "stage", "payload", "failureCode", "idempotencyKey", "requestedById", "reconciliationRequired", "createdAt", "completedAt")
         VALUES ($1, $2, 'memory_index', 'unknown', 'reconciliation_required', '{}'::jsonb, 'RECONCILIATION_REQUIRED', $3, $4, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [memoryJobId, projectId, fixedKey("memory-"), userId],
      );
      await raw.query(
        `INSERT INTO "MemoryIndexGeneration"
          ("id", "projectId", "jobId", "providerConnectionId", "modelId", "dimensions", "status", "buildMode", "inputManifestFingerprint", "expectedEmbeddingRouteUpdatedAt", "expectedInputCount", "generatedRecordCount", "reusedRecordCount", "deadlineAt", "failureCode", "reconciliationRequired", "recordCount", "createdAt", "completedAt")
         VALUES ($1, $2, $3, $4, 'embedding-background-reconciliation', 8, 'unknown', 'full', $5, NULL, 0, 0, 0, NULL, 'RECONCILIATION_REQUIRED', true, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [memoryGenerationId, projectId, memoryJobId, memoryProviderId, "1".repeat(64)],
      );
      await stageMigrations(tempRoot, postMemorySchemaMigrationNames);
      await deployStagedMigrations(tempRoot, url);

      db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
      const historicalProvider = await db.aiProviderConnection.findUniqueOrThrow({
        where: { id: memoryProviderId },
        select: { scope: true, ownershipState: true, ownerAccountAccessVersion: true },
      });
      assert.equal(historicalProvider.scope, "platform");
      assert.equal(historicalProvider.ownershipState, "legacyPending");
      assert.equal(historicalProvider.ownerAccountAccessVersion, null);
      const historicalGeneration = await db.memoryIndexGeneration.findUniqueOrThrow({
        where: { projectId_id: { projectId, id: memoryGenerationId } },
        select: {
          status: true,
          expectedEmbeddingRouteSource: true,
          expectedEmbeddingRouteId: true,
          expectedEmbeddingRouteVersion: true,
          expectedEmbeddingProviderConfigurationVersion: true,
          expectedEmbeddingConnectionOwnerAccountAccessVersion: true,
          expectedEmbeddingRouteFenceFingerprint: true,
          embeddingWebAiGrantId: true,
        },
      });
      assert.equal(historicalGeneration.status, "unknown");
      assert.equal(historicalGeneration.expectedEmbeddingRouteSource, null);
      assert.equal(historicalGeneration.expectedEmbeddingRouteId, null);
      assert.equal(historicalGeneration.expectedEmbeddingRouteVersion, null);
      assert.equal(historicalGeneration.expectedEmbeddingProviderConfigurationVersion, null);
      assert.equal(historicalGeneration.expectedEmbeddingConnectionOwnerAccountAccessVersion, null);
      assert.equal(historicalGeneration.expectedEmbeddingRouteFenceFingerprint, null);
      assert.equal(historicalGeneration.embeddingWebAiGrantId, null);
      const workspace = await db.project.findUniqueOrThrow({
        where: { id: projectId },
        select: { workspaceId: true },
      });
      await db.$transaction(async (tx) => {
        for (const directProjectId of [projectId, otherProjectId, cascadeProjectId]) {
          await grantProjectMembership(tx, {
            projectId: directProjectId,
            workspaceId: workspace.workspaceId,
            userId: actorId,
            role: "owner",
            actorId,
            reason: "background_reconciliation_gate_direct_project_owner",
          });
        }
      });
      await assert.rejects(
        () => db!.backgroundJob.update({ where: { id: unknownJobId }, data: { reconciliationRequired: false } }),
      );
      const unreleased = await db.backgroundJob.findUniqueOrThrow({ where: { id: unknownJobId } });
      assert.equal(unreleased.reconciliationRequired, true);

      const reconciled = await reconcileProjectJob(projectId, unknownJobId, actor, db);
      assert.equal(reconciled.status, "unknown");
      assert.equal(reconciled.stage, "reconciled_unknown");
      assert.equal(reconciled.reconciliationRequired, false);
      assert.doesNotMatch(JSON.stringify(reconciled), /payload|idempotencyKey|leaseTokenHash|claimToken|requestedById/u);
      const evidence = await db.backgroundJobReconciliation.findUniqueOrThrow({
        where: { projectId_jobId: { projectId, jobId: unknownJobId } },
      });
      assert.equal(evidence.requestedById, actorId);
      assert.equal(evidence.resolution, "explicitAbandon");
      assert.match(evidence.evidenceFingerprint, /^[0-9a-f]{64}$/u);
      const replay = await reconcileProjectJob(projectId, unknownJobId, actor, db);
      assert.equal(replay.id, reconciled.id);
      assert.equal(await db.backgroundJobReconciliation.count({ where: { projectId, jobId: unknownJobId } }), 1);
      await assert.rejects(
        () => db!.backgroundJobReconciliation.update({ where: { id: evidence.id }, data: { evidenceFingerprint: "b".repeat(64) } }),
      );
      await assert.rejects(
        () => db!.backgroundJobReconciliation.delete({ where: { id: evidence.id } }),
      );
      await assert.rejects(
        () => db!.backgroundJob.delete({ where: { id: unknownJobId } }),
      );
      assert.equal((await db.backgroundJob.findUniqueOrThrow({ where: { id: unknownJobId } })).id, unknownJobId);

      const crossProjectJob = await db.backgroundJob.create({
        data: {
          id: crossProjectJobId,
          projectId: otherProjectId,
          kind: "projectBrief",
          status: "unknown",
          stage: "reconciliation_required",
          failureCode: "RECONCILIATION_REQUIRED",
          reconciliationRequired: true,
          requestedById: userId,
          idempotencyKey: fixedKey("cross-project-"),
          payload: {},
        },
      });
      await assert.rejects(
        () => reconcileProjectJob(projectId, crossProjectJob.id, actor, db!),
        (error: unknown) => error instanceof ProjectWorkflowError && error.code === "PROJECT_WORKFLOW_PROJECT_MISMATCH",
      );
      await assert.rejects(
        () => db!.backgroundJobReconciliation.create({
          data: {
            projectId,
            jobId: crossProjectJob.id,
            requestedById: userId,
            resolution: "explicitAbandon",
            evidenceFingerprint: "c".repeat(64),
          },
        }),
      );

      await db.backgroundJob.createMany({
        data: [
          {
            id: wrongActorJobId,
            projectId,
            kind: "projectBrief",
            status: "unknown",
            stage: "reconciliation_required",
            failureCode: "RECONCILIATION_REQUIRED",
            reconciliationRequired: true,
            requestedById: userId,
            idempotencyKey: fixedKey("wrong-actor-"),
            payload: {},
          },
          {
            id: githubJobId,
            projectId,
            kind: "githubProjectSync",
            status: "unknown",
            stage: "reconciliation_required",
            failureCode: "RECONCILIATION_REQUIRED",
            reconciliationRequired: true,
            requestedById: userId,
            idempotencyKey: fixedKey("github-"),
            payload: {},
          },
          {
            id: queuedJobId,
            projectId,
            kind: "projectBrief",
            requestedById: userId,
            idempotencyKey: fixedKey("queued-"),
            payload: {},
          },
          {
            id: genericCrossJobId,
            projectId,
            kind: "projectBrief",
            status: "unknown",
            stage: "reconciliation_required",
            failureCode: "RECONCILIATION_REQUIRED",
            reconciliationRequired: true,
            requestedById: userId,
            idempotencyKey: fixedKey("generic-cross-"),
            payload: {},
          },
          {
            id: githubScanJobId,
            projectId,
            kind: "githubScan",
            status: "unknown",
            stage: "reconciliation_required",
            failureCode: "RECONCILIATION_REQUIRED",
            reconciliationRequired: true,
            requestedById: userId,
            idempotencyKey: fixedKey("github-scan-"),
            payload: {},
          },
          {
            id: githubMaterialJobId,
            projectId,
            kind: "githubMaterialSync",
            status: "unknown",
            stage: "reconciliation_required",
            failureCode: "RECONCILIATION_REQUIRED",
            reconciliationRequired: true,
            requestedById: userId,
            idempotencyKey: fixedKey("github-material-"),
            payload: {},
          },
        ],
      });
      await assert.rejects(
        () => reconcileProjectJob(projectId, wrongActorJobId, { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", role: "admin", accountAccessVersion: 1 }, db!),
        (error: unknown) => typeof error === "object" && error !== null && "code" in error &&
          (error as { code?: unknown }).code === "ACCESS_FORBIDDEN",
      );
      await assert.rejects(
        () => reconcileProjectJob(projectId, memoryJobId, actor, db!),
        (error: unknown) => error instanceof ProjectWorkflowError && error.code === "PROJECT_WORKFLOW_SPECIALIZED_OPERATION_REQUIRED",
      );
      await assert.rejects(
        () => reconcileProjectJob(projectId, githubJobId, actor, db!),
        (error: unknown) => error instanceof ProjectWorkflowError && error.code === "PROJECT_WORKFLOW_SPECIALIZED_OPERATION_REQUIRED",
      );
      for (const specializedJobId of [memoryJobId, githubJobId, githubScanJobId, githubMaterialJobId]) {
        await assert.rejects(
          () => db!.backgroundJobReconciliation.create({
            data: {
              projectId,
              jobId: specializedJobId,
              requestedById: userId,
              resolution: "explicitAbandon",
              evidenceFingerprint: "d".repeat(64),
            },
          }),
        );
        await assert.rejects(
          () => db!.backgroundJob.update({ where: { id: specializedJobId }, data: { reconciliationRequired: false } }),
        );
      }

      // Keep the historical memory generation without reconciliation evidence
      // until the generic specialized-job rejection checks have run. The
      // current client then appends the exact evidence required to release the
      // legacy memory job.
      await db.memoryIndexReconciliation.create({
        data: {
          id: memoryReconciliationId,
          projectId,
          indexGenerationId: memoryGenerationId,
          requestedById: userId,
          resolution: "explicitAbandon",
          evidenceFingerprint: "2".repeat(64),
        },
      });

      await db.backgroundJobReconciliation.create({
        data: {
          projectId,
          jobId: genericCrossJobId,
          requestedById: userId,
          resolution: "explicitAbandon",
          evidenceFingerprint: "e".repeat(64),
        },
      });
      await assert.rejects(
        () => db!.backgroundJob.update({
          where: { id: genericCrossJobId },
          data: { kind: "memoryIndex", reconciliationRequired: false },
        }),
      );
      const genericCrossJob = await db.backgroundJob.findUniqueOrThrow({ where: { id: genericCrossJobId } });
      assert.equal(genericCrossJob.kind, "projectBrief");
      assert.equal(genericCrossJob.reconciliationRequired, true);

      await assert.rejects(
        () => db!.backgroundJob.update({
          where: { id: memoryJobId },
          data: { kind: "projectBrief", reconciliationRequired: false },
        }),
      );
      const unreleasedMemoryJob = await db.backgroundJob.findUniqueOrThrow({ where: { id: memoryJobId } });
      assert.equal(unreleasedMemoryJob.kind, "memoryIndex");
      assert.equal(unreleasedMemoryJob.reconciliationRequired, true);
      await db.backgroundJob.update({ where: { id: memoryJobId }, data: { reconciliationRequired: false } });
      assert.equal((await db.backgroundJob.findUniqueOrThrow({ where: { id: memoryJobId } })).reconciliationRequired, false);

      await db.projectGitHubSyncRun.create({
        data: {
          id: githubSyncRunId,
          projectId,
          parentJobId: githubJobId,
          status: "unknown",
          stage: "terminal",
          scopeFingerprint: "3".repeat(64),
          deadlineAt: new Date(),
          completedAt: new Date(),
          failureCode: "RECONCILIATION_REQUIRED",
          reconciliationRequired: true,
        },
      });
      await db.projectGitHubSyncReconciliation.create({
        data: {
          projectId,
          syncRunId: githubSyncRunId,
          requestedById: userId,
          resolution: "explicitAbandon",
          childClassifications: [],
          evidenceFingerprint: "4".repeat(64),
        },
      });
      await assert.rejects(
        () => db!.backgroundJob.update({
          where: { id: githubJobId },
          data: { kind: "projectBrief", reconciliationRequired: false },
        }),
      );
      const unreleasedGitHubJob = await db.backgroundJob.findUniqueOrThrow({ where: { id: githubJobId } });
      assert.equal(unreleasedGitHubJob.kind, "githubProjectSync");
      assert.equal(unreleasedGitHubJob.reconciliationRequired, true);
      await db.backgroundJob.update({ where: { id: githubJobId }, data: { reconciliationRequired: false } });
      assert.equal((await db.backgroundJob.findUniqueOrThrow({ where: { id: githubJobId } })).reconciliationRequired, false);

      await assert.rejects(
        () => reconcileProjectJob(projectId, queuedJobId, actor, db!),
        (error: unknown) => error instanceof ProjectWorkflowError && error.code === "PROJECT_WORKFLOW_INVALID_STATE",
      );

      const cascadeJob = await db.backgroundJob.create({
        data: {
          id: cascadeJobId,
          projectId: cascadeProjectId,
          kind: "projectBrief",
          status: "unknown",
          stage: "reconciliation_required",
          failureCode: "RECONCILIATION_REQUIRED",
          reconciliationRequired: true,
          requestedById: userId,
          idempotencyKey: fixedKey("cascade-"),
          payload: {},
        },
      });
      await reconcileProjectJob(cascadeProjectId, cascadeJob.id, actor, db);
      // Keep the cascade as the only business cleanup assertion. The remaining
      // history is intentionally left for disposable-database teardown.
      await raw.query('DELETE FROM "Project" WHERE "id" = $1', [cascadeProjectId]);
      assert.equal(await db.backgroundJob.findUnique({ where: { id: cascadeJob.id } }), null);
      assert.equal(await db.backgroundJobReconciliation.count({ where: { projectId: cascadeProjectId } }), 0);
    } finally {
      if (db !== null) {
        await db.$disconnect();
      }
      if (rawConnected) await raw.end();
      if (tempRoot !== null) await rm(tempRoot, { recursive: true, force: true });
    }
  },
);
