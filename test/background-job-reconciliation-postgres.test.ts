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
    const unknownJobId = "55555555-5555-4555-8555-555555555555";
    const crossProjectJobId = "66666666-6666-4666-8666-666666666666";
    const wrongActorJobId = "77777777-7777-4777-8777-777777777777";
    const memoryJobId = "88888888-8888-4888-8888-888888888888";
    const githubJobId = "99999999-9999-4999-8999-999999999999";
    const queuedJobId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const cascadeJobId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const genericCrossJobId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const memoryGenerationId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
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

      db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
      await assert.rejects(
        () => db!.backgroundJob.update({ where: { id: unknownJobId }, data: { reconciliationRequired: false } }),
      );
      const unreleased = await db.backgroundJob.findUniqueOrThrow({ where: { id: unknownJobId } });
      assert.equal(unreleased.reconciliationRequired, true);

      const reconciled = await reconcileProjectJob(projectId, unknownJobId, userId, db);
      assert.equal(reconciled.status, "unknown");
      assert.equal(reconciled.stage, "reconciled_unknown");
      assert.equal(reconciled.reconciliationRequired, false);
      assert.doesNotMatch(JSON.stringify(reconciled), /payload|idempotencyKey|leaseTokenHash|claimToken|requestedById/u);
      const evidence = await db.backgroundJobReconciliation.findUniqueOrThrow({
        where: { projectId_jobId: { projectId, jobId: unknownJobId } },
      });
      assert.equal(evidence.requestedById, userId);
      assert.equal(evidence.resolution, "explicitAbandon");
      assert.match(evidence.evidenceFingerprint, /^[0-9a-f]{64}$/u);
      const replay = await reconcileProjectJob(projectId, unknownJobId, userId, db);
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
        () => reconcileProjectJob(projectId, crossProjectJob.id, userId, db!),
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
            id: memoryJobId,
            projectId,
            kind: "memoryIndex",
            status: "unknown",
            stage: "reconciliation_required",
            failureCode: "RECONCILIATION_REQUIRED",
            reconciliationRequired: true,
            requestedById: userId,
            idempotencyKey: fixedKey("memory-"),
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
        () => reconcileProjectJob(projectId, wrongActorJobId, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", db!),
        (error: unknown) => error instanceof ProjectWorkflowError && error.code === "PROJECT_WORKFLOW_INVALID_INPUT",
      );
      await assert.rejects(
        () => reconcileProjectJob(projectId, memoryJobId, userId, db!),
        (error: unknown) => error instanceof ProjectWorkflowError && error.code === "PROJECT_WORKFLOW_SPECIALIZED_OPERATION_REQUIRED",
      );
      await assert.rejects(
        () => reconcileProjectJob(projectId, githubJobId, userId, db!),
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

      await raw.query(
        `INSERT INTO "ExternalCredential"
          ("id", "kind", "ciphertext", "nonce", "authTag", "keyVersion", "maskedSuffix", "secretFingerprint", "createdAt", "updatedAt")
         VALUES ($1, 'ai_provider', decode('00', 'hex'), decode('00', 'hex'), decode('00', 'hex'), 1, '0000', $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [memoryCredentialId, "f".repeat(64)],
      );
      await raw.query(
        `INSERT INTO "AiProviderConnection"
          ("id", "name", "kind", "protocol", "baseUrl", "credentialId", "defaultGenerationModelId", "defaultEmbeddingModelId", "embeddingDimensions", "status", "createdAt", "updatedAt")
         VALUES ($1, $2, 'openai', 'chat_completions', 'https://api.openai.com/v1', $3,
                 'generation-background-reconciliation', 'embedding-background-reconciliation', 8, 'verified', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [memoryProviderId, `Background reconciliation provider ${projectId.slice(0, 8)}`, memoryCredentialId],
      );
      await db.memoryIndexGeneration.create({
        data: {
          id: memoryGenerationId,
          projectId,
          jobId: memoryJobId,
          providerConnectionId: memoryProviderId,
          modelId: "embedding-background-reconciliation",
          dimensions: 8,
          status: "unknown",
          buildMode: "full",
          inputManifestFingerprint: "1".repeat(64),
          expectedInputCount: 0,
          generatedRecordCount: 0,
          reusedRecordCount: 0,
          recordCount: 0,
          failureCode: "RECONCILIATION_REQUIRED",
          reconciliationRequired: true,
          completedAt: new Date(),
        },
      });
      await db.memoryIndexReconciliation.create({
        data: {
          projectId,
          indexGenerationId: memoryGenerationId,
          requestedById: userId,
          resolution: "explicitAbandon",
          evidenceFingerprint: "2".repeat(64),
        },
      });
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
        () => reconcileProjectJob(projectId, queuedJobId, userId, db!),
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
      await reconcileProjectJob(cascadeProjectId, cascadeJob.id, userId, db);
      // This gate intentionally stops before the later project-lifecycle
      // migrations. Use SQL that does not ask the current Prisma Client to
      // select fields (such as Project.archivedAt) that do not exist yet.
      await raw.query('DELETE FROM "Project" WHERE "id" = $1', [cascadeProjectId]);
      assert.equal(await db.backgroundJob.findUnique({ where: { id: cascadeJob.id } }), null);
      assert.equal(await db.backgroundJobReconciliation.count({ where: { projectId: cascadeProjectId } }), 0);
    } finally {
      if (db !== null) {
        if (rawConnected) {
          await raw.query('DELETE FROM "Project" WHERE "id" IN ($1, $2)', [projectId, otherProjectId]);
        }
        await db.aiProviderConnection.deleteMany({ where: { id: memoryProviderId } });
        await db.externalCredential.deleteMany({ where: { id: memoryCredentialId } });
        await db.$disconnect();
      }
      if (rawConnected) await raw.end();
      if (tempRoot !== null) await rm(tempRoot, { recursive: true, force: true });
    }
  },
);
