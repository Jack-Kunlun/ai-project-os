import "dotenv/config";
import assert from "node:assert/strict";
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
import { upsertProjectAiRoute } from "../src/lib/project-ai-routes";
import { getActiveMemoryIndex } from "../src/lib/web-rag";
import {
  getProjectMemoryIndexStatus,
  runProjectMemoryIndexJob,
} from "../src/lib/web-memory-index";
import { WEB_AI_TRANSFER_CONSENT_VERSION } from "../src/lib/web-ai-contract";

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
    const sourceId = "33333333-3333-4333-8333-333333333333";
    const legacyCompleteId = "44444444-4444-4444-8444-444444444444";
    const legacyStagingAId = "55555555-5555-4555-8555-555555555555";
    const legacyStagingBId = "66666666-6666-4666-8666-666666666666";
    const legacyProviderId = "77777777-7777-4777-8777-777777777777";
    const legacyCredentialId = "88888888-8888-4888-8888-888888888888";
    let db: PrismaClient | null = null;
    let rawConnected = false;
    let providerId: string | null = null;
    let credentialId: string | null = null;

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

      // The legacy schema has AppUser but no displayName. Seed the fixture with
      // raw SQL and do not let the current Prisma Client inspect that schema.
      await raw.query(
        `INSERT INTO "AppUser"
          ("id", "username", "passwordHash", "passwordSalt", "role", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, 'admin', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [userId, `memory_index_legacy_${projectId.slice(0, 8)}`, "a".repeat(43), "b".repeat(22)],
      );

      const currentMigrationNames = await migrationNamesFromDisk();
      const legacyMigrationNames = new Set<string>(migrationNames);
      const candidateMigrationNames = new Set([
        "20260829140000_add_memory_index_build_modes",
        "20260829141000_add_memory_index_candidates",
      ]);
      await stageMigrations(
        tempRoot,
        currentMigrationNames.filter((name) => !legacyMigrationNames.has(name) && !candidateMigrationNames.has(name)),
      );
      await deployStagedMigrations(tempRoot, url);

      db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
      await upsertProjectAiRoute(projectId, {
        operation: "embedding",
        providerConnectionId: legacyProviderId,
        modelId: "embedding-legacy",
        embeddingDimensions: 8,
      }, db);
      const before = await getProjectMemoryIndexStatus(projectId, db);
      assert.equal(before.readiness, "legacyIndex");
      assert.equal(before.compatible, false);
      await assert.rejects(() => getActiveMemoryIndex(projectId, db!), (error: unknown) => error instanceof Error && error.message === "SEMANTIC_INDEX_NOT_READY");

      const provider = await createProviderConnection({
        name: `Legacy upgrade provider ${projectId.slice(0, 8)}`,
        kind: "openai",
        apiKey: "sk-memory-index-legacy-upgrade",
        generationModelId: "generation-test",
        embeddingModelId: "embedding-test",
        embeddingDimensions: 8,
      }, db);
      providerId = provider.id;
      const verifiedProvider = await db.aiProviderConnection.update({
        where: { id: provider.id },
        data: { status: "verified", lastTestedAt: new Date() },
        select: { id: true, credentialId: true },
      });
      credentialId = verifiedProvider.credentialId;
      await upsertProjectAiRoute(projectId, {
        operation: "embedding",
        providerConnectionId: provider.id,
        modelId: "embedding-test",
        embeddingDimensions: 8,
        acknowledgeIndexRebuild: true,
      }, db);
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
        requestedBy: { id: userId },
        clientKey: `legacy-upgrade-${Date.now()}`,
        consent,
        mode: "full",
      }, db);
      assert.equal(rebuilt.status, "succeeded");
      assert.equal(fetchCalls, 1);
      const after = await getProjectMemoryIndexStatus(projectId, db);
      assert.equal(after.readiness, "ready");
      const pointer = await db.memoryIndexPointer.findUniqueOrThrow({ where: { projectId } });
      assert.notEqual(pointer.indexGenerationId, legacyCompleteId);
      const current = await db.memoryIndexGeneration.findUniqueOrThrow({ where: { projectId_id: { projectId, id: pointer.indexGenerationId } } });
      assert.notEqual(current.jobId, null);

      const jobA = await db.backgroundJob.create({
        data: { projectId, kind: "memoryIndex", requestedById: userId, idempotencyKey: "a".repeat(64), payload: {} },
      });
      const jobB = await db.backgroundJob.create({
        data: { projectId, kind: "memoryIndex", requestedById: userId, idempotencyKey: "b".repeat(64), payload: {} },
      });
      await db.memoryIndexGeneration.create({
        data: {
          projectId,
          jobId: jobA.id,
          providerConnectionId: provider.id,
          modelId: "embedding-test",
          dimensions: 8,
          status: "staging",
          buildMode: "full",
          inputManifestFingerprint: "c".repeat(64),
          expectedInputCount: 0,
          generatedRecordCount: 0,
          reusedRecordCount: 0,
          recordCount: 0,
        },
      });
      await assert.rejects(() => db!.memoryIndexGeneration.create({
        data: {
          projectId,
          jobId: jobB.id,
          providerConnectionId: provider.id,
          modelId: "embedding-test",
          dimensions: 8,
          status: "staging",
          buildMode: "full",
          inputManifestFingerprint: "d".repeat(64),
          expectedInputCount: 0,
          generatedRecordCount: 0,
          reusedRecordCount: 0,
          recordCount: 0,
        },
      }));
    } finally {
      globalThis.fetch = previousFetch;
      if (db !== null) {
        await db.project.deleteMany({ where: { id: projectId } });
        if (providerId !== null) await db.aiProviderConnection.deleteMany({ where: { id: providerId } });
        if (credentialId !== null) await db.externalCredential.deleteMany({ where: { id: credentialId } });
        await db.aiProviderConnection.deleteMany({ where: { id: legacyProviderId } });
        await db.externalCredential.deleteMany({ where: { id: legacyCredentialId } });
        await db.$disconnect();
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
