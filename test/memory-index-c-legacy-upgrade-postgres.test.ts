import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { Client } from "pg";
import { createProviderConnection } from "../src/lib/ai-providers/service";
import {
  activatePlatformDefaultAiRoute,
  createPlatformDefaultAiRoute,
  validatePlatformDefaultAiRoute,
} from "../src/lib/platform-default-ai-routes";
import { resolveEffectiveAiRoute } from "../src/lib/effective-ai-route";
import { getActiveMemoryIndex } from "../src/lib/web-rag";
import {
  getProjectMemoryIndexStatus,
  runProjectMemoryIndexJob,
} from "../src/lib/web-memory-index";
import { WEB_AI_TRANSFER_CONSENT_VERSION } from "../src/lib/web-ai-contract";
import { createControlledMembership } from "./membership-fixture";

const repositoryRoot = process.cwd();
const databaseName = "ai_project_os_memory_index_c_legacy_upgrade_test";
const databasePort = "56432";
const configuredUrl = process.env.MEMORY_INDEX_C_LEGACY_TEST_DATABASE_URL;
const gate = process.env.MEMORY_INDEX_C_LEGACY_POSTGRES_GATE;
const shouldRun = gate === "1" && typeof configuredUrl === "string" && configuredUrl.length > 0;
const execFile = promisify(execFileCallback);
const migrationNames = [
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
] as const;
const consent = { acknowledged: true, version: WEB_AI_TRANSFER_CONSENT_VERSION } as const;

function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name} ${error.message}`;
  return String(error);
}

function validateUrl(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new Error("MEMORY_INDEX_C_LEGACY_TEST_DATABASE_URL_INVALID");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("MEMORY_INDEX_C_LEGACY_TEST_DATABASE_URL_INVALID");
  }
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname.toLowerCase()) ||
    parsed.port !== databasePort ||
    parsed.pathname !== `/${databaseName}` ||
    parsed.search !== "?schema=public" ||
    parsed.hash !== ""
  ) throw new Error("MEMORY_INDEX_C_LEGACY_TEST_DATABASE_URL_INVALID");
  return value;
}

async function stageMigrations(tempRoot: string, names: readonly string[]): Promise<void> {
  const migrationsRoot = join(tempRoot, "prisma", "migrations");
  await mkdir(migrationsRoot, { recursive: true });
  for (const name of names) {
    await cp(join(repositoryRoot, "prisma", "migrations", name), join(migrationsRoot, name), { recursive: true });
  }
}

async function migrationNamesFromDisk(): Promise<readonly string[]> {
  const entries = await readdir(join(repositoryRoot, "prisma", "migrations"), { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && /^\d{14}_[a-z0-9_]+$/u.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

async function deployStagedMigrations(tempRoot: string, url: string): Promise<void> {
  await execFile(
    "pnpm",
    ["exec", "prisma", "migrate", "deploy", "--config", join(tempRoot, "prisma.config.ts")],
    { cwd: repositoryRoot, env: { ...process.env, DATABASE_URL: url } },
  );
}

test(
  "memory index legacy upgrade gate requires an explicit disposable target",
  { skip: !shouldRun },
  () => {
    if (gate !== "1" || typeof configuredUrl !== "string") {
      throw new Error("MEMORY_INDEX_C_LEGACY_POSTGRES_GATE=1 and MEMORY_INDEX_C_LEGACY_TEST_DATABASE_URL are required");
    }
    validateUrl(configuredUrl);
  },
);

test(
  "27 to 29 upgrade preserves legacy pointer and requires a full rebuild",
  { skip: !shouldRun ? "explicit disposable PostgreSQL gate is required" : false },
  async () => {
    const url = validateUrl(configuredUrl);
    const raw = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
    const previousDatabaseUrl = process.env.DATABASE_URL;
    const previousKeyPath = process.env.AI_PROJECT_OS_MASTER_KEY_FILE;
    const masterKeyPath = `/tmp/ai-project-os-memory-index-c-legacy-${process.pid}.key`;
    let tempRoot: string | null = null;
    const previousFetch = globalThis.fetch;
    const projectId = "11111111-1111-4111-8111-111111111111";
    const userId = "22222222-2222-4222-8222-222222222222";
    const workspaceId = "00000000-0000-4000-8000-000000000001";
    const actor = { id: userId, role: "member" as const, accountAccessVersion: 1 };
    const sourceId = "33333333-3333-4333-8333-333333333333";
    const legacyCompleteId = "44444444-4444-4444-8444-444444444444";
    const legacyStagingAId = "55555555-5555-4555-8555-555555555555";
    const legacyStagingBId = "66666666-6666-4666-8666-666666666666";
    const legacyJobBackedId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const legacyJobBackedGenerationId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const legacyNullTimestampJobId = "abababab-abab-4aba-8aba-abababababab";
    const legacyNullTimestampGenerationId = "cdcdcdcd-cdcd-4cdc-8dcd-cdcdcdcdcdcd";
    const incompleteSnapshotProjectId = "13131313-1313-4131-8131-131313131313";
    const legacyProviderId = "77777777-7777-4777-8777-777777777777";
    const legacyCredentialId = "88888888-8888-4888-8888-888888888888";
    const legacyTokenGrantId = "99999999-9999-4999-8999-999999999999";
    const legacyReservationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const legacyRouteId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const legacyLedgerId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const legacyGrantId = "10101010-1010-4010-8010-101010101010";
    const legacyGrantJobId = "20202020-2020-4020-8020-202020202020";
    const legacyPlatformGrantId = "31313131-3131-4131-8131-313131313131";
    const legacyPlatformGrantJobId = "32323232-3232-4232-8232-323232323232";
    const legacyPlatformTokenGrantId = "34343434-3434-4434-8434-343434343434";
    const legacyPlatformReservationId = "35353535-3535-4535-8535-353535353535";
    const legacyPlatformAuditId = "36363636-3636-4636-8636-363636363636";
    const legacyPlatformNegativeReservationId = "37373737-3737-4737-8737-373737373737";
    const legacyPlatformNegativeAuditId = "38383838-3838-4838-8838-383838383838";
    const postRuntimeRouteId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const postRuntimeOutlierRouteId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const postRuntimeLedgerId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const postRuntimeOutlierLedgerId = "12121212-1212-4121-8121-121212121212";
    let db: PrismaClient | null = null;
    let rawConnected = false;

    try {
      await raw.connect();
      rawConnected = true;
      process.env.DATABASE_URL = url;
      process.env.AI_PROJECT_OS_MASTER_KEY_FILE = masterKeyPath;
      await raw.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");

      tempRoot = await mkdtemp(join(tmpdir(), "ai-project-os-memory-index-c-legacy-"));
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
      await stageMigrations(tempRoot, migrationNames);
      await deployStagedMigrations(tempRoot, url);

      await raw.query(
        `INSERT INTO "Project" ("id", "name", "slug", "createdAt", "updatedAt")
         VALUES ($1, 'Legacy memory index project', 'legacy-memory-index-project', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [projectId],
      );
      await raw.query(
        `INSERT INTO "ExternalCredential"
          ("id", "kind", "ciphertext", "nonce", "authTag", "keyVersion", "maskedSuffix", "secretFingerprint", "createdAt", "updatedAt")
         VALUES ($1, 'ai_provider', decode('00', 'hex'), decode('00', 'hex'), decode('00', 'hex'), 1, '0000', $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [legacyCredentialId, "a".repeat(64)],
      );
      await raw.query(
        `INSERT INTO "AiProviderConnection"
          ("id", "name", "kind", "protocol", "baseUrl", "credentialId", "defaultGenerationModelId", "defaultEmbeddingModelId", "embeddingDimensions", "status", "createdAt", "updatedAt")
         VALUES ($1, 'Legacy provider', 'openai', 'chat_completions', 'https://api.openai.com/v1', $2,
                 'generation-legacy', 'embedding-legacy', 8, 'verified', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [legacyProviderId, legacyCredentialId],
      );
      await raw.query(
        `INSERT INTO "ProjectSource"
          ("id", "projectId", "kind", "externalRef", "contentText", "contentHash")
         VALUES ($1, $2, 'manual', 'manual://legacy', 'Legacy source requiring rebuild', $3)`,
        [sourceId, projectId, "a".repeat(64)],
      );
      await raw.query(
        `INSERT INTO "MemoryIndexGeneration"
          ("id", "projectId", "providerConnectionId", "modelId", "dimensions", "status", "inputManifestFingerprint", "recordCount", "completedAt")
         VALUES
          ($1, $2, $3, 'embedding-legacy', 8, 'complete', $4, 0, CURRENT_TIMESTAMP),
          ($5, $2, $3, 'embedding-legacy', 8, 'staging', $4, 0, NULL),
          ($6, $2, $3, 'embedding-legacy', 8, 'staging', $4, 0, NULL)`,
        [legacyCompleteId, projectId, legacyProviderId, "b".repeat(64), legacyStagingAId, legacyStagingBId],
      );
      await raw.query(
        `INSERT INTO "MemoryIndexPointer" ("projectId", "indexGenerationId", "publishedAt")
         VALUES ($1, $2, CURRENT_TIMESTAMP)`,
        [projectId, legacyCompleteId],
      );

      // 28 and 29 are the candidate-build migrations. Both legacy staging
      // rows intentionally have NULL jobId and must not block the upgrade.
      await stageMigrations(tempRoot, [
        "20260829140000_add_memory_index_build_modes",
        "20260829141000_add_memory_index_candidates",
      ]);
      await deployStagedMigrations(tempRoot, url);
      const legacyRows = await raw.query<{ jobId: string | null; status: string }>(
        `SELECT "jobId", "status" FROM "MemoryIndexGeneration"
         WHERE "projectId" = $1 ORDER BY "id"`,
        [projectId],
      );
      assert.equal(legacyRows.rows.filter((row) => row.jobId === null && row.status === "staging").length, 2);
      await raw.query(
        `UPDATE "MemoryIndexGeneration"
            SET "expectedEmbeddingRouteUpdatedAt" = CURRENT_TIMESTAMP
          WHERE "id" = $1`,
        [legacyStagingAId],
      );

      // The legacy schema has AppUser but no displayName. Seed the fixture with
      // raw SQL and do not let the current Prisma Client inspect that schema.
      await raw.query(
        `INSERT INTO "AppUser"
          ("id", "username", "passwordHash", "passwordSalt", "role", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, 'admin', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [userId, `memory_index_legacy_${projectId.slice(0, 8)}`, "a".repeat(43), "b".repeat(22)],
      );

      // Before the route-snapshot migration, job-backed generations carried
      // only the original route-updated timestamp. Keep one such terminal row
      // in the upgrade fixture so 0600 proves it remains migratable and its
      // historical lifecycle remains usable without making it runtime-ready.
      await raw.query(
        `INSERT INTO "BackgroundJob"
          ("id", "projectId", "kind", "status", "stage", "payload", "idempotencyKey", "requestedById", "completedAt")
         VALUES ($1, $2, 'memory_index', 'succeeded', 'complete', '{}', $3, $4, CURRENT_TIMESTAMP)`,
        [legacyJobBackedId, projectId, "e".repeat(64), userId],
      );
      await raw.query(
        `INSERT INTO "MemoryIndexGeneration"
          ("id", "projectId", "jobId", "providerConnectionId", "modelId", "dimensions", "status",
           "buildMode", "inputManifestFingerprint", "expectedEmbeddingRouteUpdatedAt", "recordCount", "completedAt")
         VALUES ($1, $2, $3, $4, 'embedding-legacy', 8, 'complete', 'full', $5,
                 CURRENT_TIMESTAMP - INTERVAL '1 minute', 0, CURRENT_TIMESTAMP)`,
        [legacyJobBackedGenerationId, projectId, legacyJobBackedId, legacyProviderId, "c".repeat(64)],
      );
      await raw.query(
        `INSERT INTO "BackgroundJob"
          ("id", "projectId", "kind", "status", "stage", "payload", "idempotencyKey", "requestedById", "completedAt")
         VALUES ($1, $2, 'memory_index', 'succeeded', 'complete', '{}', $3, $4, CURRENT_TIMESTAMP)`,
        [legacyNullTimestampJobId, projectId, "f".repeat(64), userId],
      );
      await raw.query(
        `INSERT INTO "MemoryIndexGeneration"
          ("id", "projectId", "jobId", "providerConnectionId", "modelId", "dimensions", "status",
           "buildMode", "inputManifestFingerprint", "expectedEmbeddingRouteUpdatedAt", "recordCount", "completedAt")
         VALUES ($1, $2, $3, $4, 'embedding-legacy', 8, 'complete', 'full', $5,
                 NULL, 0, CURRENT_TIMESTAMP)`,
        [legacyNullTimestampGenerationId, projectId, legacyNullTimestampJobId, legacyProviderId, "d".repeat(64)],
      );

      const currentMigrationNames = await migrationNamesFromDisk();
      const legacyMigrationNames = new Set<string>(migrationNames);
      const candidateMigrationNames = new Set([
        "20260829140000_add_memory_index_build_modes",
        "20260829141000_add_memory_index_candidates",
      ]);
      const membershipEvidenceMigration = "20260904050000_add_membership_governance_manifest_evidence";
      const runtimeBillingMigration = "20260904070000_add_runtime_ai_grant_billing_fences";
      const personalRuntimeEvidenceMigration = "20260904110000_add_personal_ai_runtime_evidence";
      const remainingMigrationNames = currentMigrationNames.filter(
        (name) => !legacyMigrationNames.has(name) && !candidateMigrationNames.has(name),
      );
      await stageMigrations(
        tempRoot,
        remainingMigrationNames.filter((name) => name < membershipEvidenceMigration),
      );
      await deployStagedMigrations(tempRoot, url);
      await raw.query(
        `UPDATE "AiProviderConnection"
            SET "ownershipState" = 'confirmed', "updatedAt" = CURRENT_TIMESTAMP
          WHERE "id" = $1`,
        [legacyProviderId],
      );

      // This route was valid under the pre-0700 positive-only multiplier
      // constraint. It is deliberately an outlier so the later migration
      // must preserve it without silently clipping or deleting the value.
      // The route table itself is introduced by the pre-0500 migration batch.
      await raw.query(
        `INSERT INTO "PlatformDefaultAiRoute"
          ("id", "operation", "version", "status", "providerConnectionId", "modelId",
           "embeddingDimensions", "maxOutputTokens", "quotaMultiplierBps", "createdById", "updatedById",
           "createdAt", "updatedAt")
         VALUES ($1, 'embedding', 1, 'draft', $2, 'embedding-legacy', 8, NULL, 250000,
                 $3, $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [legacyRouteId, legacyProviderId, userId],
      );

      // The pre-manifest schema permits the migration fixture to establish a
      // confirmed membership with its ordinary same-transaction audit.  Do
      // that before installing the later double-signature transition guard;
      // the runtime test must never use a legacy pending row or a plain
      // application revoke as a governance bypass.
      await raw.query("BEGIN");
      try {
        const workspaceMembership = await raw.query<{ id: string }>(
          `SELECT "id" FROM "WorkspaceMembership"
           WHERE "workspaceId" = $1 AND "userId" = $2 AND "accessState" = 'pending'`,
          [workspaceId, userId],
        );
        const projectMembership = await raw.query<{ id: string }>(
          `SELECT "id" FROM "ProjectMembership"
           WHERE "projectId" = $1 AND "userId" = $2 AND "accessState" = 'pending'`,
          [projectId, userId],
        );
        assert.equal(workspaceMembership.rows.length, 1);
        assert.equal(projectMembership.rows.length, 1);
        const workspaceMembershipId = workspaceMembership.rows[0]!.id;
        const projectMembershipId = projectMembership.rows[0]!.id;

        await raw.query(
          `UPDATE "WorkspaceMembership"
              SET "accessState" = 'confirmed', "updatedAt" = CURRENT_TIMESTAMP
            WHERE "id" = $1`,
          [workspaceMembershipId],
        );
        await raw.query(
          `INSERT INTO "MembershipAccessAudit"
            ("id", "membershipKind", "membershipId", "workspaceId", "projectId", "userId",
             "action", "previousState", "newState", "roleSnapshot", "actorId", "reason",
             "membershipFingerprint", "transactionId")
           SELECT gen_random_uuid(), 'workspace', membership."id", membership."workspaceId", NULL,
                  membership."userId", 'confirmed', 'pending', 'confirmed', membership."role"::text,
                  membership."userId", 'legacy upgrade fixture confirmed before manifest boundary',
                  encode(digest(convert_to(concat_ws(
                    E'\\x1f', membership."id"::text, membership."workspaceId"::text,
                    membership."userId"::text, membership."role"::text,
                    to_char(membership."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS'),
                    to_char(membership."updatedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS')
                  ), 'UTF8'), 'sha256'), 'hex'), txid_current()
             FROM "WorkspaceMembership" AS membership
            WHERE membership."id" = $1`,
          [workspaceMembershipId],
        );
        await raw.query(
          `UPDATE "ProjectMembership"
              SET "accessState" = 'confirmed', "updatedAt" = CURRENT_TIMESTAMP
            WHERE "id" = $1`,
          [projectMembershipId],
        );
        await raw.query(
          `INSERT INTO "MembershipAccessAudit"
            ("id", "membershipKind", "membershipId", "workspaceId", "projectId", "userId",
             "action", "previousState", "newState", "roleSnapshot", "actorId", "reason",
             "membershipFingerprint", "transactionId")
           SELECT gen_random_uuid(), 'project', membership."id", project."workspaceId", membership."projectId",
                  membership."userId", 'confirmed', 'pending', 'confirmed', membership."role"::text,
                  membership."userId", 'legacy upgrade fixture confirmed before manifest boundary',
                  encode(digest(convert_to(concat_ws(
                    E'\\x1f', membership."id"::text, membership."projectId"::text,
                    membership."userId"::text, membership."role"::text,
                    to_char(membership."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS'),
                    to_char(membership."updatedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS')
                  ), 'UTF8'), 'sha256'), 'hex'), txid_current()
             FROM "ProjectMembership" AS membership
             JOIN "Project" AS project ON project."id" = membership."projectId"
            WHERE membership."id" = $1`,
          [projectMembershipId],
        );
        await raw.query("COMMIT");
      } catch (error) {
        await raw.query("ROLLBACK");
        throw error;
      }

      await stageMigrations(tempRoot, [
        membershipEvidenceMigration,
        ...remainingMigrationNames.filter((name) => name > membershipEvidenceMigration && name < runtimeBillingMigration),
      ]);
      await deployStagedMigrations(tempRoot, url);

      const preservedLegacyJobBackedGeneration = await raw.query<{
        jobId: string | null;
        status: string;
        expectedEmbeddingRouteUpdatedAt: Date | null;
        expectedEmbeddingRouteSource: string | null;
        expectedEmbeddingRouteId: string | null;
        expectedEmbeddingRouteVersion: number | null;
        expectedEmbeddingProviderConfigurationVersion: number | null;
        expectedEmbeddingRouteFenceFingerprint: string | null;
      }>(
        `SELECT "jobId", "status", "expectedEmbeddingRouteUpdatedAt",
                "expectedEmbeddingRouteSource", "expectedEmbeddingRouteId",
                "expectedEmbeddingRouteVersion", "expectedEmbeddingProviderConfigurationVersion",
                "expectedEmbeddingRouteFenceFingerprint"
           FROM "MemoryIndexGeneration" WHERE "id" = $1`,
        [legacyJobBackedGenerationId],
      );
      assert.equal(preservedLegacyJobBackedGeneration.rows.length, 1);
      assert.equal(preservedLegacyJobBackedGeneration.rows[0]!.jobId, legacyJobBackedId);
      assert.equal(preservedLegacyJobBackedGeneration.rows[0]!.status, "complete");
      assert.notEqual(preservedLegacyJobBackedGeneration.rows[0]!.expectedEmbeddingRouteUpdatedAt, null);
      assert.equal(preservedLegacyJobBackedGeneration.rows[0]!.expectedEmbeddingRouteSource, null);
      assert.equal(preservedLegacyJobBackedGeneration.rows[0]!.expectedEmbeddingRouteId, null);
      assert.equal(preservedLegacyJobBackedGeneration.rows[0]!.expectedEmbeddingRouteVersion, null);
      assert.equal(preservedLegacyJobBackedGeneration.rows[0]!.expectedEmbeddingProviderConfigurationVersion, null);
      assert.equal(preservedLegacyJobBackedGeneration.rows[0]!.expectedEmbeddingRouteFenceFingerprint, null);
      const preservedLegacyNullTimestampGeneration = await raw.query<{
        jobId: string | null;
        status: string;
        expectedEmbeddingRouteUpdatedAt: Date | null;
        expectedEmbeddingRouteSource: string | null;
        expectedEmbeddingRouteId: string | null;
        expectedEmbeddingRouteVersion: number | null;
        expectedEmbeddingProviderConfigurationVersion: number | null;
        expectedEmbeddingRouteFenceFingerprint: string | null;
      }>(
        `SELECT "jobId", "status", "expectedEmbeddingRouteUpdatedAt",
                "expectedEmbeddingRouteSource", "expectedEmbeddingRouteId",
                "expectedEmbeddingRouteVersion", "expectedEmbeddingProviderConfigurationVersion",
                "expectedEmbeddingRouteFenceFingerprint"
           FROM "MemoryIndexGeneration" WHERE "id" = $1`,
        [legacyNullTimestampGenerationId],
      );
      assert.equal(preservedLegacyNullTimestampGeneration.rows.length, 1);
      assert.equal(preservedLegacyNullTimestampGeneration.rows[0]!.jobId, legacyNullTimestampJobId);
      assert.equal(preservedLegacyNullTimestampGeneration.rows[0]!.status, "complete");
      assert.equal(preservedLegacyNullTimestampGeneration.rows[0]!.expectedEmbeddingRouteUpdatedAt, null);
      assert.equal(preservedLegacyNullTimestampGeneration.rows[0]!.expectedEmbeddingRouteSource, null);
      assert.equal(preservedLegacyNullTimestampGeneration.rows[0]!.expectedEmbeddingRouteId, null);
      assert.equal(preservedLegacyNullTimestampGeneration.rows[0]!.expectedEmbeddingRouteVersion, null);
      assert.equal(preservedLegacyNullTimestampGeneration.rows[0]!.expectedEmbeddingProviderConfigurationVersion, null);
      assert.equal(preservedLegacyNullTimestampGeneration.rows[0]!.expectedEmbeddingRouteFenceFingerprint, null);
      const preservedLegacyNoJobTimestamp = await raw.query<{
        jobId: string | null;
        expectedEmbeddingRouteUpdatedAt: Date | null;
      }>(
        `SELECT "jobId", "expectedEmbeddingRouteUpdatedAt"
           FROM "MemoryIndexGeneration" WHERE "id" = $1`,
        [legacyStagingAId],
      );
      assert.equal(preservedLegacyNoJobTimestamp.rows[0]!.jobId, null);
      assert.notEqual(preservedLegacyNoJobTimestamp.rows[0]!.expectedEmbeddingRouteUpdatedAt, null);

      // The pre-0600 terminal transitions remain valid when the historical
      // partial snapshots are unchanged; runtime still rejects both as
      // incomplete route fences and must rebuild instead of reusing them.
      await raw.query(
        `UPDATE "MemoryIndexGeneration"
            SET "status" = 'superseded', "supersededAt" = CURRENT_TIMESTAMP
          WHERE "id" = $1`,
        [legacyJobBackedGenerationId],
      );
      await raw.query(
        `UPDATE "MemoryIndexGeneration"
            SET "status" = 'superseded', "supersededAt" = CURRENT_TIMESTAMP
          WHERE "id" = $1`,
        [legacyNullTimestampGenerationId],
      );
      const supersededLegacyJobBackedGeneration = await raw.query<{ status: string }>(
        `SELECT "status" FROM "MemoryIndexGeneration" WHERE "id" = $1`,
        [legacyJobBackedGenerationId],
      );
      assert.equal(supersededLegacyJobBackedGeneration.rows[0]!.status, "superseded");
      const supersededLegacyNullTimestampGeneration = await raw.query<{ status: string }>(
        `SELECT "status" FROM "MemoryIndexGeneration" WHERE "id" = $1`,
        [legacyNullTimestampGenerationId],
      );
      assert.equal(supersededLegacyNullTimestampGeneration.rows[0]!.status, "superseded");

      // Seed a reservation that was valid under the pre-0700 integer domain
      // but is larger than the new runtime raw-token cap. The upgrade must
      // preserve it byte-for-byte rather than retroactively rejecting or
      // rewriting historical billing evidence.
      await raw.query(
        `INSERT INTO "PlatformTokenGrant"
          ("id", "userId", "kind", "amount", "remainingTokens", "offerVersion", "issuedAt", "expiresAt", "createdAt", "updatedAt")
         VALUES ($1, $2, 'signup', 20000001, 20000001, 'legacy-upgrade-fixture', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '1 day', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [legacyTokenGrantId, userId],
      );
      await raw.query(
        `INSERT INTO "PlatformTokenReservation"
          ("id", "userId", "grantId", "jobId", "providerConnectionId", "callKey", "operation", "modelId", "status", "reservedTokens", "expiresAt", "createdAt")
         VALUES ($1, $2, $3, NULL, $4, 'legacy-upgrade-reservation', 'embedding', 'embedding-legacy', 'reserved', 20000001, CURRENT_TIMESTAMP + INTERVAL '1 hour', CURRENT_TIMESTAMP)`,
        [legacyReservationId, userId, legacyTokenGrantId, legacyProviderId],
      );
      await raw.query(
        `INSERT INTO "PlatformTokenLedgerEntry"
          ("id", "userId", "grantId", "reservationId", "entryKind", "amount", "usageTokens",
           "reasonCode", "idempotencyKey", "metadata", "createdAt")
         VALUES ($1, $2, $3, $4, 'settle', 0, 10000001,
                 'legacy-upgrade-usage-outlier', 'legacy-upgrade-usage-outlier', '{}'::jsonb, CURRENT_TIMESTAMP)`,
        [legacyLedgerId, userId, legacyTokenGrantId, legacyReservationId],
      );

      await stageMigrations(tempRoot, [
        runtimeBillingMigration,
        ...remainingMigrationNames.filter((name) => name > runtimeBillingMigration && name < personalRuntimeEvidenceMigration),
      ]);
      await deployStagedMigrations(tempRoot, url);

      // Seed a pre-1100 platform runtime bundle. The provider and
      // credential are intentionally rotated below before 1100 is installed;
      // the migration must preserve this historical evidence rather than
      // replacing it with today's dimensions or fingerprint.
      await raw.query(
        `INSERT INTO "BackgroundJob"
          ("id", "projectId", "kind", "status", "stage", "payload", "idempotencyKey", "requestedById", "completedAt")
         VALUES ($1, $2, 'project_brief', 'running', 'dispatch', '{}'::jsonb, $3, $4, NULL)`,
        [legacyPlatformGrantJobId, projectId, "legacy-platform-grant-job-idempotency", userId],
      );
      await raw.query(
        `INSERT INTO "PlatformTokenGrant"
          ("id", "userId", "kind", "amount", "remainingTokens", "offerVersion", "issuedById", "issuedAt", "expiresAt", "createdAt", "updatedAt")
         VALUES ($1, $2, 'manual', 1000, 1000, 'legacy-platform-runtime', $2,
                 CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '1 day', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [legacyPlatformTokenGrantId, userId],
      );
      await raw.query(
        `INSERT INTO "WebAiGrant"
          ("id", "projectId", "operation", "scopeKind", "scopeIds", "manifestFingerprint",
           "providerConnectionId", "modelId", "consentVersion", "issuedById", "billingMode",
           "billingUserId", "callKey", "boundJobId", "routeSource", "routeId", "routeVersion",
           "routeUpdatedAt", "providerConfigurationVersion", "quotaMultiplierBps", "routeFenceFingerprint",
           "issuedAt", "expiresAt")
         VALUES ($1, $2, 'embedding', 'query', $3::jsonb, $4, $5, 'embedding-legacy', $6,
                 $7, 'platform', $7, $8, $9, 'platform_default', $10, 1,
                 CURRENT_TIMESTAMP, 1, 10000, $11, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '1 day')`,
        [
          legacyPlatformGrantId,
          projectId,
          JSON.stringify({ projectId }),
          "5".repeat(64),
          legacyProviderId,
          "legacy-platform-consent",
          userId,
          "legacy-platform-grant-call-key",
          legacyPlatformGrantJobId,
          legacyRouteId,
          "6".repeat(64),
        ],
      );
      await raw.query(
        `INSERT INTO "PlatformTokenReservation"
          ("id", "userId", "grantId", "webAiGrantId", "webAiGrantReferenceId", "webAiGrantProjectId",
           "jobId", "providerConnectionId", "callKey", "operation", "modelId", "status",
           "reservedTokens", "rawEstimatedTokens", "quotaMultiplierBps", "routeSource", "routeId",
           "routeVersion", "routeUpdatedAt", "providerConfigurationVersion", "routeFenceFingerprint",
           "expiresAt", "createdAt")
         VALUES ($1, $2, $3, $4, $4, $5, $6, $7, $8, 'embedding', 'embedding-legacy', 'reserved',
                 2, 2, 10000, 'platform_default', $9, 1,
                 (SELECT "routeUpdatedAt" FROM "WebAiGrant" WHERE "id" = $4), 1, $10,
                 CURRENT_TIMESTAMP + INTERVAL '1 hour', CURRENT_TIMESTAMP)`,
        [
          legacyPlatformReservationId,
          userId,
          legacyPlatformTokenGrantId,
          legacyPlatformGrantId,
          projectId,
          legacyPlatformGrantJobId,
          legacyProviderId,
          "legacy-platform-reservation-call-key",
          legacyRouteId,
          "6".repeat(64),
        ],
      );
      await raw.query(
        `INSERT INTO "ProviderCallAudit"
          ("id", "jobId", "webAiGrantId", "webAiGrantReferenceId", "webAiGrantProjectId",
           "providerConnectionId", "operation", "modelId", "billingMode", "billingUserId", "callKey",
           "reservationId", "routeSource", "routeId", "routeVersion", "routeUpdatedAt",
           "providerConfigurationVersion", "quotaMultiplierBps", "routeFenceFingerprint",
           "credentialSecretFingerprint", "status", "inputTokens", "outputTokens", "usageKnown", "createdAt")
         VALUES ($1, $2, $3, $3, $4, $5, 'embedding', 'embedding-legacy', 'platform', $6, $7,
                 $8, 'platform_default', $9, 1,
                 (SELECT "routeUpdatedAt" FROM "WebAiGrant" WHERE "id" = $3), 1, 10000, $10, $11,
                 'running', 0, 0, false, CURRENT_TIMESTAMP)`,
        [
          legacyPlatformAuditId,
          legacyPlatformGrantJobId,
          legacyPlatformGrantId,
          projectId,
          legacyProviderId,
          userId,
          "legacy-platform-audit-call-key",
          legacyPlatformReservationId,
          legacyRouteId,
          "6".repeat(64),
          "a".repeat(64),
        ],
      );
      await raw.query(
        `INSERT INTO "PlatformTokenReservation"
          ("id", "userId", "grantId", "webAiGrantId", "webAiGrantReferenceId", "webAiGrantProjectId",
           "jobId", "providerConnectionId", "callKey", "operation", "modelId", "status",
           "reservedTokens", "rawEstimatedTokens", "quotaMultiplierBps", "routeSource", "routeId",
           "routeVersion", "routeUpdatedAt", "providerConfigurationVersion", "routeFenceFingerprint",
           "expiresAt", "createdAt")
         VALUES ($1, $2, $3, $4, $4, $5, $6, $7, $8, 'embedding', 'embedding-legacy', 'reserved',
                 2, 2, 10000, 'platform_default', $9, 1,
                 (SELECT "routeUpdatedAt" FROM "WebAiGrant" WHERE "id" = $4), 1, $10,
                 CURRENT_TIMESTAMP + INTERVAL '1 hour', CURRENT_TIMESTAMP)`,
        [
          legacyPlatformNegativeReservationId,
          userId,
          legacyPlatformTokenGrantId,
          legacyPlatformGrantId,
          projectId,
          legacyPlatformGrantJobId,
          legacyProviderId,
          "legacy-platform-negative-reservation-call-key",
          legacyRouteId,
          "6".repeat(64),
        ],
      );
      await raw.query(
        `UPDATE "ExternalCredential"
            SET "secretFingerprint" = $2, "updatedAt" = CURRENT_TIMESTAMP
          WHERE "id" = $1`,
        [legacyCredentialId, "b".repeat(64)],
      );
      await raw.query(
        `UPDATE "AiProviderConnection"
            SET "embeddingDimensions" = 16, "configurationVersion" = 2, "updatedAt" = CURRENT_TIMESTAMP
          WHERE "id" = $1`,
        [legacyProviderId],
      );

      // This route-bound BYOK grant is valid under the pre-1100 schema. It
      // must survive as a read-only legacy row; 1100 must not backfill it into
      // the platform/personal runtime evidence shapes.
      await raw.query(
        `INSERT INTO "BackgroundJob"
          ("id", "projectId", "kind", "status", "stage", "payload", "idempotencyKey", "requestedById", "completedAt")
         VALUES ($1, $2, 'project_brief', 'succeeded', 'complete', '{}'::jsonb, $3, $4, CURRENT_TIMESTAMP)`,
        [legacyGrantJobId, projectId, "legacy-grant-job-idempotency", userId],
      );
      await raw.query(
        `INSERT INTO "WebAiGrant"
          ("id", "projectId", "operation", "scopeKind", "scopeIds", "manifestFingerprint",
           "providerConnectionId", "modelId", "consentVersion", "issuedById", "billingMode",
           "billingUserId", "callKey", "boundJobId", "routeSource", "routeUpdatedAt",
           "providerConfigurationVersion", "quotaMultiplierBps", "routeFenceFingerprint", "issuedAt", "expiresAt")
         VALUES ($1, $2, 'autoExtract', 'query', $3::jsonb, $4, $5, 'generation-legacy', $6,
                 $7, 'byok', $7, $8, $9, 'project_override', CURRENT_TIMESTAMP, 1, 10000, $10,
                 CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '1 day')`,
        [
          legacyGrantId,
          projectId,
          JSON.stringify({ projectId }),
          "1".repeat(64),
          legacyProviderId,
          "legacy-consent",
          userId,
          "legacy-grant-call-key",
          legacyGrantJobId,
          "2".repeat(64),
        ],
      );

      const preservedRoute = await raw.query<{ quotaMultiplierBps: number }>(
        `SELECT "quotaMultiplierBps" FROM "PlatformDefaultAiRoute" WHERE "id" = $1`,
        [legacyRouteId],
      );
      assert.deepEqual(preservedRoute.rows[0], { quotaMultiplierBps: 250000 });
      const preservedReservation = await raw.query<{ reservedTokens: number; rawEstimatedTokens: number; quotaMultiplierBps: number; routeSource: string | null }>(
        `SELECT "reservedTokens", "rawEstimatedTokens", "quotaMultiplierBps", "routeSource"
         FROM "PlatformTokenReservation" WHERE "id" = $1`,
        [legacyReservationId],
      );
      assert.deepEqual(preservedReservation.rows[0], {
        reservedTokens: 20000001,
        rawEstimatedTokens: 20000001,
        quotaMultiplierBps: 10000,
        routeSource: null,
      });
      const preservedLedger = await raw.query<{ usageTokens: number }>(
        `SELECT "usageTokens" FROM "PlatformTokenLedgerEntry" WHERE "id" = $1`,
        [legacyLedgerId],
      );
      assert.deepEqual(preservedLedger.rows[0], { usageTokens: 10000001 });

      await stageMigrations(tempRoot, [
        personalRuntimeEvidenceMigration,
        ...remainingMigrationNames.filter((name) => name > personalRuntimeEvidenceMigration),
      ]);
      await deployStagedMigrations(tempRoot, url);
      const preservedHistoricalPlatformEvidence = await raw.query<{
        payerKind: string | null;
        credentialSecretFingerprint: string | null;
        embeddingDimensions: number | null;
        maxOutputTokens: number | null;
        routeFenceFingerprint: string | null;
        providerConfigurationVersion: number | null;
      }>(
        `SELECT "payerKind", "credentialSecretFingerprint", "embeddingDimensions", "maxOutputTokens",
                "routeFenceFingerprint", "providerConfigurationVersion"
           FROM "WebAiGrant" WHERE "id" = $1`,
        [legacyPlatformGrantId],
      );
      assert.deepEqual(preservedHistoricalPlatformEvidence.rows[0], {
        payerKind: null,
        credentialSecretFingerprint: null,
        embeddingDimensions: null,
        maxOutputTokens: null,
        routeFenceFingerprint: "6".repeat(64),
        providerConfigurationVersion: 1,
      });
      const preservedHistoricalPlatformAudit = await raw.query<{
        payerKind: string | null;
        credentialSecretFingerprint: string | null;
        embeddingDimensions: number | null;
        maxOutputTokens: number | null;
      }>(
        `SELECT "payerKind", "credentialSecretFingerprint", "embeddingDimensions", "maxOutputTokens"
           FROM "ProviderCallAudit" WHERE "id" = $1`,
        [legacyPlatformAuditId],
      );
      assert.deepEqual(preservedHistoricalPlatformAudit.rows[0], {
        payerKind: null,
        credentialSecretFingerprint: "a".repeat(64),
        embeddingDimensions: null,
        maxOutputTokens: null,
      });
      await raw.query(
        `UPDATE "ProviderCallAudit"
            SET "status" = 'succeeded', "providerRequestId" = 'legacy-terminalized',
                "completedAt" = CURRENT_TIMESTAMP
          WHERE "id" = $1`,
        [legacyPlatformAuditId],
      );
      await raw.query(
        `UPDATE "BackgroundJob"
            SET "status" = 'succeeded', "stage" = 'complete', "completedAt" = CURRENT_TIMESTAMP
          WHERE "id" = $1`,
        [legacyPlatformGrantJobId],
      );
      const terminalizedHistoricalPlatformAudit = await raw.query<{ status: string; credentialSecretFingerprint: string }>(
        `SELECT "status", "credentialSecretFingerprint"
           FROM "ProviderCallAudit" WHERE "id" = $1`,
        [legacyPlatformAuditId],
      );
      assert.deepEqual(terminalizedHistoricalPlatformAudit.rows[0], {
        status: "succeeded",
        credentialSecretFingerprint: "a".repeat(64),
      });

      const preservedLegacyGrant = await raw.query<{
        billingMode: string;
        routeSource: string | null;
        routeUpdatedAt: Date | null;
        providerConfigurationVersion: number | null;
        quotaMultiplierBps: number | null;
        routeFenceFingerprint: string | null;
        payerKind: string | null;
        credentialSecretFingerprint: string | null;
        embeddingDimensions: number | null;
        maxOutputTokens: number | null;
      }>(
        `SELECT "billingMode", "routeSource", "routeUpdatedAt", "providerConfigurationVersion",
                "quotaMultiplierBps", "routeFenceFingerprint", "payerKind",
                "credentialSecretFingerprint", "embeddingDimensions", "maxOutputTokens"
           FROM "WebAiGrant" WHERE "id" = $1`,
        [legacyGrantId],
      );
      assert.equal(preservedLegacyGrant.rows.length, 1);
      assert.equal(preservedLegacyGrant.rows[0]!.billingMode, "byok");
      assert.equal(preservedLegacyGrant.rows[0]!.routeSource, "project_override");
      assert.notEqual(preservedLegacyGrant.rows[0]!.routeUpdatedAt, null);
      assert.equal(preservedLegacyGrant.rows[0]!.providerConfigurationVersion, 1);
      assert.equal(preservedLegacyGrant.rows[0]!.quotaMultiplierBps, 10000);
      assert.equal(preservedLegacyGrant.rows[0]!.routeFenceFingerprint, "2".repeat(64));
      assert.equal(preservedLegacyGrant.rows[0]!.payerKind, null);
      assert.equal(preservedLegacyGrant.rows[0]!.credentialSecretFingerprint, null);
      assert.equal(preservedLegacyGrant.rows[0]!.embeddingDimensions, null);
      assert.equal(preservedLegacyGrant.rows[0]!.maxOutputTokens, null);

      const newLegacyShapeJobId = "30303030-3030-4030-8030-303030303030";
      await raw.query(
        `INSERT INTO "BackgroundJob"
          ("id", "projectId", "kind", "status", "stage", "payload", "idempotencyKey", "requestedById", "completedAt")
         VALUES ($1, $2, 'project_brief', 'succeeded', 'complete', '{}'::jsonb, $3, $4, CURRENT_TIMESTAMP)`,
        [newLegacyShapeJobId, projectId, "new-legacy-shape-idempotency", userId],
      );
      await assert.rejects(
        () => raw.query(
          `INSERT INTO "WebAiGrant"
            ("id", "projectId", "operation", "scopeKind", "scopeIds", "manifestFingerprint",
             "providerConnectionId", "modelId", "consentVersion", "issuedById", "billingMode",
             "billingUserId", "callKey", "boundJobId", "routeSource", "routeUpdatedAt",
             "providerConfigurationVersion", "quotaMultiplierBps", "routeFenceFingerprint", "issuedAt", "expiresAt")
           VALUES ($1, $2, 'autoExtract', 'query', $3::jsonb, $4, $5, 'generation-legacy', $6,
                   $7, 'byok', $7, $8, $9, 'project_override', CURRENT_TIMESTAMP, 1, 10000, $10,
                   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '1 day')`,
          [
            randomUUID(),
            projectId,
            JSON.stringify({ projectId }),
            "3".repeat(64),
            legacyProviderId,
            "legacy-consent",
            userId,
            "new-legacy-shape-call-key",
            newLegacyShapeJobId,
            "4".repeat(64),
          ],
        ),
        (error: unknown) => errorText(error).includes("new platform grant requires credential fingerprint evidence"),
        "new legacy/byok route grant shape is rejected",
      );

      const incompletePlatformGrantJobId = randomUUID();
      await raw.query(
        `INSERT INTO "BackgroundJob"
          ("id", "projectId", "kind", "status", "stage", "payload", "idempotencyKey", "requestedById", "completedAt")
         VALUES ($1, $2, 'project_brief', 'succeeded', 'complete', '{}'::jsonb, $3, $4, CURRENT_TIMESTAMP)`,
        [incompletePlatformGrantJobId, projectId, `incomplete-platform-${randomUUID()}`.slice(0, 64), userId],
      );
      await assert.rejects(
        () => raw.query(
          `INSERT INTO "WebAiGrant"
            ("id", "projectId", "operation", "scopeKind", "scopeIds", "manifestFingerprint",
             "providerConnectionId", "modelId", "consentVersion", "issuedById", "billingMode",
             "billingUserId", "callKey", "boundJobId", "routeSource", "routeId", "routeVersion",
             "routeUpdatedAt", "providerConfigurationVersion", "quotaMultiplierBps", "routeFenceFingerprint",
             "issuedAt", "expiresAt")
           VALUES ($1, $2, 'embedding', 'query', $3::jsonb, $4, $5, 'embedding-legacy', $6,
                   $7, 'platform', $7, $8, $9, 'platform_default', $10, 1,
                   CURRENT_TIMESTAMP, 1, 10000, $11, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '1 day')`,
          [
            randomUUID(),
            projectId,
            JSON.stringify({ projectId }),
            "7".repeat(64),
            legacyProviderId,
            "legacy-consent",
            userId,
            `incomplete-platform-call-${randomUUID()}`.slice(0, 64),
            incompletePlatformGrantJobId,
            legacyRouteId,
            "8".repeat(64),
          ],
        ),
        (error: unknown) => errorText(error).includes("new platform grant requires credential fingerprint evidence"),
        "new incomplete platform grant shape is rejected",
      );
      await assert.rejects(
        () => raw.query(
          `INSERT INTO "ProviderCallAudit"
            ("id", "jobId", "webAiGrantId", "webAiGrantReferenceId", "webAiGrantProjectId",
             "providerConnectionId", "operation", "modelId", "billingMode", "billingUserId", "callKey",
             "routeSource", "routeId", "routeVersion", "routeUpdatedAt", "providerConfigurationVersion",
             "quotaMultiplierBps", "routeFenceFingerprint", "status", "inputTokens", "outputTokens", "usageKnown", "createdAt")
           VALUES ($1, $2, $3, $3, $4, $5, 'embedding', 'embedding-legacy', 'platform', $6, $7,
                   'platform_default', $8, 1, CURRENT_TIMESTAMP, 1, 10000, $9,
                   'running', 0, 0, false, CURRENT_TIMESTAMP)`,
          [
            randomUUID(),
            legacyPlatformGrantJobId,
            legacyPlatformGrantId,
            projectId,
            legacyProviderId,
            userId,
            `incomplete-platform-audit-${randomUUID()}`.slice(0, 128),
            legacyRouteId,
            "9".repeat(64),
          ],
        ),
        (error: unknown) => errorText(error).includes("provider-call audit grant tuple mismatch"),
        "new audit inserts cannot use the historical platform grant carve-out",
      );
      await assert.rejects(
        () => raw.query(
          `INSERT INTO "ProviderCallAudit"
            ("id", "jobId", "webAiGrantId", "webAiGrantReferenceId", "webAiGrantProjectId",
             "providerConnectionId", "operation", "modelId", "billingMode", "billingUserId", "callKey",
             "reservationId", "routeSource", "routeId", "routeVersion", "routeUpdatedAt",
             "providerConfigurationVersion", "quotaMultiplierBps", "routeFenceFingerprint",
             "credentialSecretFingerprint", "payerKind", "payerProviderConnectionId",
             "embeddingDimensions", "maxOutputTokens", "status", "inputTokens", "outputTokens", "usageKnown", "createdAt")
           VALUES ($1, $2, $3, $3, $4, $5, 'embedding', 'embedding-legacy', 'platform', $6, $7,
                   $8, 'platform_default', $9, 1, CURRENT_TIMESTAMP, 1, 10000, $10, $11,
                   'platform_caller', $5, 16, 128, 'running', 0, 0, false, CURRENT_TIMESTAMP)`,
          [
            legacyPlatformNegativeAuditId,
            legacyPlatformGrantJobId,
            legacyPlatformGrantId,
            projectId,
            legacyProviderId,
            userId,
            `complete-historical-audit-${randomUUID()}`.slice(0, 128),
            legacyPlatformNegativeReservationId,
            legacyRouteId,
            "6".repeat(64),
            "b".repeat(64),
          ],
        ),
        (error: unknown) => errorText(error).includes("provider-call audit grant tuple mismatch"),
        "complete new audit evidence cannot target a historical grant",
      );

      // A bounded row remains writable after the migration, but neither a
      // fresh outlier nor an update from the bounded domain may create a new
      // oversized runtime value.
      await raw.query(
        `INSERT INTO "PlatformDefaultAiRoute"
          ("id", "operation", "version", "status", "providerConnectionId", "modelId",
           "embeddingDimensions", "maxOutputTokens", "quotaMultiplierBps", "createdById", "updatedById",
           "createdAt", "updatedAt")
         VALUES ($1, 'projectAnalysis', 1, 'draft', $2, 'generation-legacy', NULL, 2048, 10000,
                 $3, $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [postRuntimeRouteId, legacyProviderId, userId],
      );
      await assert.rejects(
        () => raw.query(
          `INSERT INTO "PlatformDefaultAiRoute"
            ("id", "operation", "version", "status", "providerConnectionId", "modelId",
             "embeddingDimensions", "maxOutputTokens", "quotaMultiplierBps", "createdById", "updatedById",
             "createdAt", "updatedAt")
           VALUES ($1, 'sourceSummary', 1, 'draft', $2, 'generation-legacy', NULL, 2048, 100001,
                   $3, $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [postRuntimeOutlierRouteId, legacyProviderId, userId],
        ),
        (error: unknown) => errorText(error).includes("platform default AI route quota multiplier exceeds runtime limit"),
      );
      await assert.rejects(
        () => raw.query(
          `UPDATE "PlatformDefaultAiRoute"
              SET "quotaMultiplierBps" = 100001
            WHERE "id" = $1`,
          [postRuntimeRouteId],
        ),
        (error: unknown) => errorText(error).includes("platform default AI route quota multiplier exceeds runtime limit"),
      );
      const boundedRoute = await raw.query<{ quotaMultiplierBps: number }>(
        `SELECT "quotaMultiplierBps" FROM "PlatformDefaultAiRoute" WHERE "id" = $1`,
        [postRuntimeRouteId],
      );
      assert.deepEqual(boundedRoute.rows[0], { quotaMultiplierBps: 10000 });

      await raw.query(
        `INSERT INTO "PlatformTokenLedgerEntry"
          ("id", "userId", "grantId", "reservationId", "entryKind", "amount", "usageTokens",
           "reasonCode", "idempotencyKey", "metadata", "createdAt")
         VALUES ($1, $2, $3, $4, 'hold', 0, 1,
                 'post-runtime-bounded-usage', 'post-runtime-bounded-usage', '{}'::jsonb, CURRENT_TIMESTAMP)`,
        [postRuntimeLedgerId, userId, legacyTokenGrantId, legacyReservationId],
      );
      await assert.rejects(
        () => raw.query(
          `INSERT INTO "PlatformTokenLedgerEntry"
            ("id", "userId", "grantId", "reservationId", "entryKind", "amount", "usageTokens",
             "reasonCode", "idempotencyKey", "metadata", "createdAt")
           VALUES ($1, $2, $3, $4, 'hold', 0, 10000001,
                   'post-runtime-usage-outlier', 'post-runtime-usage-outlier', '{}'::jsonb, CURRENT_TIMESTAMP)`,
          [postRuntimeOutlierLedgerId, userId, legacyTokenGrantId, legacyReservationId],
        ),
        (error: unknown) => errorText(error).includes("platform token ledger usageTokens exceeds runtime limit"),
      );
      await assert.rejects(
        () => raw.query(
          `UPDATE "PlatformTokenLedgerEntry"
              SET "usageTokens" = 10000001
            WHERE "id" = $1`,
          [postRuntimeLedgerId],
        ),
        (error: unknown) => errorText(error).includes("platform token ledger usageTokens exceeds runtime limit"),
      );
      const boundedLedger = await raw.query<{ usageTokens: number }>(
        `SELECT "usageTokens" FROM "PlatformTokenLedgerEntry" WHERE "id" = $1`,
        [postRuntimeLedgerId],
      );
      assert.deepEqual(boundedLedger.rows[0], { usageTokens: 1 });

      db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
      const membershipNow = new Date();
      await createControlledMembership(db, {
        adminId: userId,
        userId,
        startsAt: new Date(membershipNow.getTime() - 60_000),
        expiresAt: new Date(membershipNow.getTime() + 86_400_000),
      });

      // Runtime routes are platform-owned.  The old provider remains only as
      // historical billing evidence; it is never used as a workspace or
      // project runtime route in this upgrade test.
      const platformActor = { id: userId, role: "admin" as const, accountAccessVersion: 1 };
      const provider = await createProviderConnection({
        name: `Legacy upgrade platform provider ${projectId.slice(0, 8)}`,
        kind: "glm",
        apiKey: "sk-memory-index-legacy-upgrade",
        generationModelId: "glm-4-flash",
        embeddingModelId: "embedding-3",
        embeddingDimensions: 8,
        visionModelId: null,
      }, platformActor, db);
      await db.aiProviderConnection.update({
        where: { id: provider.id },
        data: { status: "verified", lastTestedAt: new Date() },
      });
      const defaultEmbeddingDraft = await createPlatformDefaultAiRoute({
        operation: "embedding",
        providerConnectionId: provider.id,
        modelId: "embedding-3",
        embeddingDimensions: 8,
      }, platformActor, db);
      const defaultEmbeddingVerified = await validatePlatformDefaultAiRoute(
        defaultEmbeddingDraft.id,
        platformActor,
        db,
        defaultEmbeddingDraft.updatedAt,
      );
      await activatePlatformDefaultAiRoute(
        defaultEmbeddingVerified.id,
        platformActor,
        db,
        defaultEmbeddingVerified.updatedAt,
      );
      await db.appUser.update({ where: { id: userId }, data: { role: "member" } });
      const before = await getProjectMemoryIndexStatus(projectId, actor, db);
      assert.equal(before.readiness, "legacyIndex");
      assert.equal(before.compatible, false);
      await assert.rejects(() => getActiveMemoryIndex(projectId, actor, db!), (error: unknown) => error instanceof Error && error.message === "SEMANTIC_INDEX_NOT_READY");

      let fetchCalls = 0;
      globalThis.fetch = async (_input, init) => {
        fetchCalls += 1;
        const body = JSON.parse(String(init?.body)) as { input?: unknown };
        const texts = Array.isArray(body.input) ? body.input.filter((value): value is string => typeof value === "string") : [];
        return new Response(JSON.stringify({
          data: texts.map((_, index) => ({ index, embedding: Array.from({ length: 8 }, (_, offset) => (index + offset + 1) / 10) })),
          usage: { prompt_tokens: texts.length, completion_tokens: 0 },
        }), { status: 200, headers: { "content-type": "application/json" } });
      };
      const rebuilt = await runProjectMemoryIndexJob({
        projectId,
        requestedBy: actor,
        clientKey: `legacy-upgrade-${Date.now()}`,
        consent,
        mode: "full",
      }, db);
      assert.equal(rebuilt.status, "succeeded");
      assert.equal(fetchCalls, 1);
      const after = await getProjectMemoryIndexStatus(projectId, actor, db);
      assert.equal(after.readiness, "ready");
      const pointer = await db.memoryIndexPointer.findUniqueOrThrow({ where: { projectId } });
      assert.notEqual(pointer.indexGenerationId, legacyCompleteId);
      const current = await db.memoryIndexGeneration.findUniqueOrThrow({ where: { projectId_id: { projectId, id: pointer.indexGenerationId } } });
      assert.notEqual(current.jobId, null);

      const embeddingRoute = await resolveEffectiveAiRoute(projectId, "embedding", db);
      await db.project.create({
        data: {
          id: incompleteSnapshotProjectId,
          workspaceId,
          name: "Legacy upgrade route snapshot validation",
          slug: `legacy-upgrade-route-snapshot-${incompleteSnapshotProjectId.slice(0, 8)}`,
        },
      });
      const isolatedEmbeddingRoute = await resolveEffectiveAiRoute(incompleteSnapshotProjectId, "embedding", db);
      const terminatedJob = await db.backgroundJob.create({
        data: {
          id: randomUUID(),
          projectId: incompleteSnapshotProjectId,
          kind: "memoryIndex",
          requestedById: userId,
          idempotencyKey: "g".repeat(64),
          payload: {},
        },
      });
      await db.memoryIndexGeneration.create({
        data: {
          id: randomUUID(),
          projectId: incompleteSnapshotProjectId,
          jobId: terminatedJob.id,
          providerConnectionId: isolatedEmbeddingRoute.providerConnectionId,
          modelId: isolatedEmbeddingRoute.modelId,
          dimensions: isolatedEmbeddingRoute.embeddingDimensions ?? 0,
          status: "failed",
          buildMode: "full",
          inputManifestFingerprint: "e".repeat(64),
          expectedEmbeddingRouteSource: isolatedEmbeddingRoute.source,
          expectedEmbeddingRouteId: isolatedEmbeddingRoute.routeId,
          expectedEmbeddingRouteVersion: isolatedEmbeddingRoute.routeVersion,
          expectedEmbeddingRouteUpdatedAt: isolatedEmbeddingRoute.routeUpdatedAt,
          expectedEmbeddingProviderConfigurationVersion: isolatedEmbeddingRoute.providerConfigurationVersion,
          expectedEmbeddingRouteFenceFingerprint: isolatedEmbeddingRoute.routeFenceFingerprint,
          expectedInputCount: 0,
          generatedRecordCount: 0,
          reusedRecordCount: 0,
          recordCount: 0,
          failureCode: "TEST_TERMINATED",
          completedAt: new Date(),
        },
      });
      const incompleteSnapshotJob = await db.backgroundJob.create({
        data: {
          id: randomUUID(),
          projectId: incompleteSnapshotProjectId,
          kind: "memoryIndex",
          requestedById: userId,
          idempotencyKey: "h".repeat(64),
          payload: {},
        },
      });
      await assert.rejects(
        () => db!.memoryIndexGeneration.create({
          data: {
            id: randomUUID(),
            projectId: incompleteSnapshotProjectId,
            jobId: incompleteSnapshotJob.id,
            providerConnectionId: isolatedEmbeddingRoute.providerConnectionId,
            modelId: isolatedEmbeddingRoute.modelId,
            dimensions: isolatedEmbeddingRoute.embeddingDimensions ?? 0,
            status: "staging",
            buildMode: "full",
            inputManifestFingerprint: "f".repeat(64),
            expectedInputCount: 0,
            generatedRecordCount: 0,
            reusedRecordCount: 0,
            recordCount: 0,
          },
        }),
        (error: unknown) => error instanceof Error && error.message.includes("new job-backed memory index generation requires a complete route snapshot"),
      );
      const jobA = await db.backgroundJob.create({
        data: { projectId, kind: "memoryIndex", requestedById: userId, idempotencyKey: "a".repeat(64), payload: {} },
      });
      await db.memoryIndexGeneration.create({
        data: {
          projectId,
          jobId: jobA.id,
          providerConnectionId: provider.id,
          modelId: "embedding-3",
          dimensions: 8,
          status: "staging",
          buildMode: "full",
          inputManifestFingerprint: "c".repeat(64),
          expectedEmbeddingRouteSource: embeddingRoute.source,
          expectedEmbeddingRouteId: embeddingRoute.routeId,
          expectedEmbeddingRouteVersion: embeddingRoute.routeVersion,
          expectedEmbeddingRouteUpdatedAt: embeddingRoute.routeUpdatedAt,
          expectedEmbeddingProviderConfigurationVersion: embeddingRoute.providerConfigurationVersion,
          expectedEmbeddingRouteFenceFingerprint: embeddingRoute.routeFenceFingerprint,
          expectedInputCount: 0,
          generatedRecordCount: 0,
          reusedRecordCount: 0,
          recordCount: 0,
        },
      });
    } finally {
      globalThis.fetch = previousFetch;
      if (db !== null) {
        try {
          // This is an isolated upgrade database and the gate runner drops it
          // after the test. Do not delete the project before its runtime
          // evidence: the production evidence guard intentionally requires a
          // deletion receipt for the grant-FK SET NULL cascade. Keeping the
          // disposable rows also avoids a cleanup error masking the assertion
          // that caused the test to fail.
        } finally {
          await db.$disconnect();
        }
      }
      if (rawConnected) await raw.end();
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
      if (previousKeyPath === undefined) delete process.env.AI_PROJECT_OS_MASTER_KEY_FILE;
      else process.env.AI_PROJECT_OS_MASTER_KEY_FILE = previousKeyPath;
      await unlink(masterKeyPath).catch(() => undefined);
      if (tempRoot !== null) await rm(tempRoot, { recursive: true, force: true });
    }
  },
);
