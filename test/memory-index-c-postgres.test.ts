import "dotenv/config";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, ProjectRepositoryRole } from "@prisma/client";
import { Client } from "pg";
import {
  GITHUB_READ_ONLY_CLIENT_VERSION,
  GITHUB_SOFT_EXCLUDE_CLASSES,
  createGitHubCodeScanService,
  createGitHubRepositoryLedgerService,
  type GitHubReadOnlyClient,
  type VerifiedGitHubRepository,
} from "../src/lib/github";
import { createProviderConnection } from "../src/lib/ai-providers/service";
import { upsertProjectAiRoute } from "../src/lib/project-ai-routes";
import { WEB_AI_TRANSFER_CONSENT_VERSION } from "../src/lib/web-ai-contract";
import {
  getProjectMemoryIndexPlan,
  reconcileMemoryIndexJob,
  runProjectMemoryIndexJob,
} from "../src/lib/web-memory-index";

const execFile = promisify(execFileCallback);
const repositoryRoot = process.cwd();
const databaseName = "ai_project_os_memory_index_c_test";
const databasePort = "56432";
const gate = process.env.MEMORY_INDEX_C_POSTGRES_GATE;
// Do not inherit the repository's normal local DATABASE_URL unless the gate
// was explicitly enabled. A test-only URL is preferred and is documented by
// the execution contract.
const configuredUrl = process.env.MEMORY_INDEX_C_TEST_DATABASE_URL ??
  (gate === "1" ? process.env.DATABASE_URL : undefined);
const hasUrl = typeof configuredUrl === "string" && configuredUrl.length > 0;
const shouldRun = gate === "1";
const consent = { acknowledged: true, version: WEB_AI_TRANSFER_CONSENT_VERSION } as const;

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function vector(text: string): number[] {
  const seed = [...text].reduce((sum, character) => sum + character.codePointAt(0)!, 0);
  return Array.from({ length: 8 }, (_, index) => ((seed + index * 13) % 37) / 37 + 0.1);
}

function repositoryConfig() {
  return {
    role: ProjectRepositoryRole.application,
    requiredForProjectSnapshot: true,
    trackedRef: "refs/heads/main",
    codeEnabled: true,
    metadataEnabled: false,
    readmeEnabled: false,
    markdownEnabled: false,
    markdownPaths: [],
    issuesEnabled: false,
    pullRequestsEnabled: false,
    releasesEnabled: false,
    includeRoots: ["src"],
    softExcludePatterns: [...GITHUB_SOFT_EXCLUDE_CLASSES],
  };
}

type CodePointerVersion = 0 | 1 | 2;

type ChangingCodeFile = Readonly<{ blobSha: string; content: string }>;

type ChangingCodeSnapshot = Readonly<{
  commitSha: string;
  rootTreeSha: string;
  directoryTreeSha: string;
  files: Readonly<Record<string, ChangingCodeFile>>;
}>;

function codeSnapshot(version: CodePointerVersion, fileCount = 34): ChangingCodeSnapshot {
  const files: Record<string, ChangingCodeFile> = {};
  for (let index = 0; index < fileCount; index += 1) {
    if (version === 2 && index === 33) continue;
    const content = version >= 1 && index % 2 === 1
      ? `export const sparse_${index} = 'updated';\n`
      : `export const sparse_${index} = 'stable';\n`;
    files[`file-${String(index).padStart(2, "0")}.ts`] = {
      blobSha: `${version}${index.toString(16).padStart(2, "0")}`.repeat(20).slice(0, 40),
      content,
    };
  }
  return Object.freeze({
    commitSha: `${version + 1}`.repeat(40),
    rootTreeSha: `${version + 4}`.repeat(40),
    directoryTreeSha: `${version + 7}`.repeat(40),
    files: Object.freeze(files),
  });
}

function createChangingCodeClient(state: { version: CodePointerVersion }, fileCount = 34): GitHubReadOnlyClient {
  const repository: VerifiedGitHubRepository = Object.freeze({
    repositoryId: 3_900_001,
    nodeId: "R_MEMORY_INDEX_C",
    owner: "acme",
    name: "memory-index-c",
    fullName: "acme/memory-index-c",
    private: true,
    archived: false,
    disabled: false,
    defaultBranch: "main",
  });
  const versions: Readonly<Record<CodePointerVersion, ChangingCodeSnapshot>> = {
    0: codeSnapshot(0, fileCount),
    1: codeSnapshot(1, fileCount),
    2: codeSnapshot(2, fileCount),
  };
  return {
    version: GITHUB_READ_ONLY_CLIENT_VERSION,
    async getRepository() {
      return repository;
    },
    async getReference(input) {
      const current = versions[state.version];
      return { ref: input.trackedRef, commitSha: current.commitSha };
    },
    async getCommit(input) {
      const current = versions[state.version];
      if (input.commitSha !== current.commitSha) throw new Error("UNEXPECTED_COMMIT");
      return { commitSha: input.commitSha, treeSha: current.rootTreeSha };
    },
    async getTree(input) {
      const current = versions[state.version];
      if (input.treeSha === current.rootTreeSha) {
        return {
          treeSha: current.rootTreeSha,
          truncated: false,
          entries: [{ path: "src", mode: "040000", type: "tree", sha: current.directoryTreeSha, size: null }],
        };
      }
      if (input.treeSha === current.directoryTreeSha) {
        return {
          treeSha: current.directoryTreeSha,
          truncated: false,
          entries: Object.entries(current.files).map(([path, file]) => ({
            path,
            mode: "100644" as const,
            type: "blob" as const,
            sha: file.blobSha,
            size: Buffer.byteLength(file.content, "utf8"),
          })),
        };
      }
      throw new Error("UNEXPECTED_TREE");
    },
    async getBlob(input) {
      const current = versions[state.version];
      const file = Object.values(current.files).find((candidate) => candidate.blobSha === input.blobSha);
      if (file === undefined) throw new Error("UNEXPECTED_BLOB");
      return {
        blobSha: input.blobSha,
        size: Buffer.byteLength(file.content, "utf8"),
        encoding: "base64",
        content: Buffer.from(file.content, "utf8").toString("base64"),
      };
    },
  };
}

function validateDisposableUrl(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new Error("MEMORY_INDEX_C_TEST_DATABASE_URL_INVALID");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("MEMORY_INDEX_C_TEST_DATABASE_URL_INVALID");
  }
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname.toLowerCase()) ||
    parsed.port !== databasePort ||
    parsed.pathname !== `/${databaseName}` ||
    parsed.search !== "?schema=public" ||
    parsed.hash !== ""
  ) throw new Error("MEMORY_INDEX_C_TEST_DATABASE_URL_INVALID");
  return value;
}

async function createMemoryJob(db: PrismaClient, projectId: string, requestedById: string, label: string) {
  return db.backgroundJob.create({
    data: {
      id: randomUUID(),
      projectId,
      kind: "memoryIndex",
      requestedById,
      idempotencyKey: digest(`memory-index-c:${label}`),
      payload: {},
    },
  });
}

async function createStagingGeneration(
  db: PrismaClient,
  input: Readonly<{ projectId: string; jobId: string; providerConnectionId: string; expectedActiveIndexGenerationId?: string | null }>,
) {
  return db.memoryIndexGeneration.create({
    data: {
      id: randomUUID(),
      projectId: input.projectId,
      jobId: input.jobId,
      providerConnectionId: input.providerConnectionId,
      modelId: "embedding-test",
      dimensions: 8,
      status: "staging",
      buildMode: "incremental",
      inputManifestFingerprint: digest(`manifest:${input.jobId}`),
      expectedActiveIndexGenerationId: input.expectedActiveIndexGenerationId ?? null,
      expectedEmbeddingRouteUpdatedAt: new Date(),
      expectedInputCount: 0,
      generatedRecordCount: 0,
      reusedRecordCount: 0,
      recordCount: 0,
    },
  });
}

test(
  "memory index PostgreSQL gate requires an explicit disposable target",
  { skip: gate !== "1" && !hasUrl },
  () => {
    if (gate !== "1" || !hasUrl) throw new Error("MEMORY_INDEX_C_POSTGRES_GATE and a disposable test URL are required");
    validateDisposableUrl(configuredUrl);
  },
);

test(
  "memory index full/incremental candidates publish atomically and reconcile unknown locally",
  { skip: !shouldRun ? "explicit disposable PostgreSQL gate is required" : false },
  async () => {
    const url = validateDisposableUrl(configuredUrl);
    const raw = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
    const previousDatabaseUrl = process.env.DATABASE_URL;
    const masterKeyPath = `/tmp/ai-project-os-memory-index-c-${process.pid}.key`;
    const previousKeyPath = process.env.AI_PROJECT_OS_MASTER_KEY_FILE;
    const previousFetch = globalThis.fetch;
    const userId = randomUUID();
    const projectId = randomUUID();
    const otherProjectId = randomUUID();
    const concurrentProjectId = randomUUID();
    const pointerProjectId = randomUUID();
    const publishedLocallyProjectId = randomUUID();
    const deadlineProjectId = randomUUID();
    const sourceId = randomUUID();
    const changedSourceId = randomUUID();
    const uncertainSourceId = randomUUID();
    let providerId: string | null = null;
    let credentialId: string | null = null;
    let db: PrismaClient | null = null;
    let rawConnected = false;
    let fetchMode: "success" | "unknown" = "success";
    let fetchCalls = 0;
    const embeddingInputs: string[][] = [];

    try {
      await raw.connect();
      rawConnected = true;
      process.env.DATABASE_URL = url;
      process.env.AI_PROJECT_OS_MASTER_KEY_FILE = masterKeyPath;
      // Keep administrator-owned extensions intact while removing every
      // application object created by the disposable test role.
      await raw.query("DROP OWNED BY CURRENT_USER CASCADE;");
      await execFile(
        "pnpm",
        ["exec", "prisma", "migrate", "deploy", "--config", "prisma.config.ts"],
        { cwd: repositoryRoot, env: { ...process.env, DATABASE_URL: url } },
      );
      db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
      globalThis.fetch = async (_input, init) => {
        fetchCalls += 1;
        if (fetchMode === "unknown") throw new Error("simulated provider network failure");
        const body = JSON.parse(String(init?.body)) as { input?: unknown };
        const texts = Array.isArray(body.input) ? body.input.filter((value): value is string => typeof value === "string") : [];
        embeddingInputs.push(texts);
        return new Response(JSON.stringify({
          data: texts.map((text, index) => ({ index, embedding: vector(text) })),
          usage: { prompt_tokens: texts.length, completion_tokens: 0 },
        }), { status: 200, headers: { "content-type": "application/json" } });
      };

      await db.appUser.create({
        data: {
          id: userId,
          username: `memory_index_c_${randomUUID().slice(0, 8)}`,
          passwordHash: "a".repeat(43),
          passwordSalt: "b".repeat(22),
          role: "admin",
        },
      });
      await db.project.createMany({
        data: [
          { id: projectId, name: "Memory index C", slug: `memory-index-c-${randomUUID()}` },
          { id: otherProjectId, name: "Memory index C other", slug: `memory-index-c-other-${randomUUID()}` },
          { id: concurrentProjectId, name: "Memory index C concurrent", slug: `memory-index-c-concurrent-${randomUUID()}` },
        ],
      });
      const provider = await createProviderConnection({
        name: `Memory index C provider ${randomUUID().slice(0, 8)}`,
        kind: "openai",
        apiKey: "sk-memory-index-c-secret",
        generationModelId: "generation-test",
        embeddingModelId: "embedding-test",
        embeddingDimensions: 8,
      }, db);
      providerId = provider.id;
      const providerRow = await db.aiProviderConnection.update({
        where: { id: provider.id },
        data: { status: "verified", lastTestedAt: new Date() },
      });
      credentialId = providerRow.credentialId;
      await upsertProjectAiRoute(projectId, {
        operation: "embedding",
        providerConnectionId: provider.id,
        modelId: "embedding-test",
        embeddingDimensions: 8,
      }, db);
      const originalText = "原始事实：项目使用可追溯的长期记忆。";
      const originalHash = digest(originalText);
      await db.projectSource.create({
        data: {
          id: sourceId,
          projectId,
          kind: "manual",
          originScope: "project",
          externalRef: "manual://original",
          contentText: originalText,
          contentHash: originalHash,
          manualContentDedupeKey: originalHash,
        },
      });

      const fullJob = await runProjectMemoryIndexJob({
        projectId,
        requestedBy: { id: userId },
        clientKey: `full-${randomUUID()}`,
        consent,
        mode: "full",
      }, db);
      assert.equal(fullJob.status, "succeeded");
      const firstPointer = await db.memoryIndexPointer.findUniqueOrThrow({
        where: { projectId },
        include: { generation: { include: { records: true } } },
      });
      assert.equal(firstPointer.generation.status, "complete");
      assert.equal(firstPointer.generation.recordCount, 1);
      assert.equal(firstPointer.generation.generatedRecordCount, 1);
      const firstRecord = firstPointer.generation.records[0]!;
      assert.equal(firstRecord.reusedFromMemoryRecordId, null);
      assert.equal(embeddingInputs.length, 1);

      const changedText = "新增事实：增量计划只为变化内容生成向量。";
      const changedHash = digest(changedText);
      await db.projectSource.create({
        data: {
          id: changedSourceId,
          projectId,
          kind: "manual",
          originScope: "project",
          externalRef: "manual://new",
          contentText: changedText,
          contentHash: changedHash,
          manualContentDedupeKey: changedHash,
        },
      });
      embeddingInputs.length = 0;
      const incrementalJob = await runProjectMemoryIndexJob({
        projectId,
        requestedBy: { id: userId },
        clientKey: `incremental-${randomUUID()}`,
        consent,
        mode: "incremental",
      }, db);
      assert.equal(incrementalJob.status, "succeeded");
      assert.equal(embeddingInputs.length, 1);
      assert.deepEqual(embeddingInputs[0], [changedText]);
      const secondPointer = await db.memoryIndexPointer.findUniqueOrThrow({
        where: { projectId },
        include: { generation: { include: { records: true } } },
      });
      assert.equal(secondPointer.generation.status, "complete");
      assert.equal(secondPointer.generation.recordCount, 2);
      assert.equal(secondPointer.generation.generatedRecordCount, 1);
      assert.equal(secondPointer.generation.reusedRecordCount, 1);
      const reusedRecord = secondPointer.generation.records.find((record) => record.projectSourceId === sourceId);
      const generatedRecord = secondPointer.generation.records.find((record) => record.projectSourceId === changedSourceId);
      assert.equal(reusedRecord?.reusedFromMemoryRecordId, firstRecord.id);
      assert.equal(generatedRecord?.reusedFromMemoryRecordId, null);
      assert.equal(secondPointer.generation.records.some((record) => record.embeddingFingerprint === firstRecord.embeddingFingerprint), true);

      // A post-dispatch provider failure produces an unknown candidate and
      // leaves the previous complete pointer untouched.
      const changedAgain = "不确定事实：本次模型请求结果未知。";
      const changedAgainHash = digest(changedAgain);
      await db.projectSource.create({
        data: {
          id: uncertainSourceId,
          projectId,
          kind: "manual",
          originScope: "project",
          externalRef: "manual://uncertain",
          contentText: changedAgain,
          contentHash: changedAgainHash,
          manualContentDedupeKey: changedAgainHash,
        },
      });
      fetchMode = "unknown";
      const callsBeforeUnknown = fetchCalls;
      await assert.rejects(
        () => runProjectMemoryIndexJob({
          projectId,
          requestedBy: { id: userId },
          clientKey: `unknown-${randomUUID()}`,
          consent,
          mode: "incremental",
        }, db!),
        (error: unknown) => typeof error === "object" && error !== null && "code" in error &&
          (error as { code?: unknown }).code === "AI_PROVIDER_UNAVAILABLE",
      );
      const unknownJob = await db.backgroundJob.findFirstOrThrow({
        where: { projectId, kind: "memoryIndex" },
        orderBy: { createdAt: "desc" },
      });
      assert.equal(unknownJob.status, "unknown");
      assert.equal(unknownJob.reconciliationRequired, true);
      const unknownGeneration = await db.memoryIndexGeneration.findUniqueOrThrow({
        where: { projectId_jobId: { projectId, jobId: unknownJob.id } },
      });
      assert.equal(unknownGeneration.status, "unknown");
      assert.equal(unknownGeneration.reconciliationRequired, true);
      const preservedPointer = await db.memoryIndexPointer.findUniqueOrThrow({ where: { projectId } });
      assert.equal(preservedPointer.indexGenerationId, secondPointer.indexGenerationId);
      assert.equal(fetchCalls, callsBeforeUnknown + 1);

      // A direct release without immutable local evidence must be rejected;
      // the service inserts the reconciliation row before releasing it.
      await assert.rejects(() => db!.memoryIndexGeneration.update({
        where: { projectId_id: { projectId, id: unknownGeneration.id } },
        data: { reconciliationRequired: false },
      }));

      const reconciled = await reconcileMemoryIndexJob({ projectId, jobId: unknownJob.id, requestedById: userId }, db);
      assert.equal(reconciled.status, "unknown");
      assert.equal(reconciled.reconciliationRequired, false);
      assert.equal((reconciled.result as { reconciliation?: string }).reconciliation, "explicitAbandon");
      assert.equal(fetchCalls, callsBeforeUnknown + 1);
      assert.equal(await db.memoryIndexReconciliation.count({ where: { projectId, indexGenerationId: unknownGeneration.id } }), 1);
      const releasedGeneration = await db.memoryIndexGeneration.findUniqueOrThrow({ where: { projectId_id: { projectId, id: unknownGeneration.id } } });
      assert.equal(releasedGeneration.status, "unknown");
      assert.equal(releasedGeneration.reconciliationRequired, false);

      // The admission is released only after that explicit local action; a
      // fresh client key can now start a new candidate and the old pointer is
      // still the baseline.
      fetchMode = "success";
      const resumedJob = await runProjectMemoryIndexJob({
        projectId,
        requestedBy: { id: userId },
        clientKey: `resumed-${randomUUID()}`,
        consent,
        mode: "incremental",
      }, db);
      assert.equal(resumedJob.status, "succeeded");

      const resumedPointer = await db.memoryIndexPointer.findUniqueOrThrow({ where: { projectId } });
      await assert.rejects(() => db!.memoryIndexGeneration.update({
        where: { projectId_id: { projectId, id: resumedPointer.indexGenerationId } },
        data: { status: "superseded", supersededAt: new Date() },
      }));

      // Exercise sparse interleaving and deletion through the real repository
      // code snapshot pointer. The scanner creates immutable generations and
      // swaps the project snapshot pointer; this test never edits a source
      // revision in place.
      await db.project.createMany({
        data: [
          { id: pointerProjectId, name: "Memory index C repository pointer", slug: `memory-index-c-pointer-${randomUUID()}` },
          { id: publishedLocallyProjectId, name: "Memory index C local reconciliation", slug: `memory-index-c-local-${randomUUID()}` },
          { id: deadlineProjectId, name: "Memory index C deadline", slug: `memory-index-c-deadline-${randomUUID()}` },
        ],
      });
      const codeState = { version: 0 as CodePointerVersion };
      const repositoryClient = createChangingCodeClient(codeState);
      await createGitHubRepositoryLedgerService({ db }).connect({
        projectId: pointerProjectId,
        repository: {
          repositoryId: 3_900_001,
          nodeId: "R_MEMORY_INDEX_C",
          owner: "acme",
          name: "memory-index-c",
          fullName: "acme/memory-index-c",
          private: true,
          archived: false,
          disabled: false,
          defaultBranch: "main",
        },
        config: repositoryConfig(),
      });
      const codeScanner = createGitHubCodeScanService({ db, client: repositoryClient });
      const initialScan = await codeScanner.scanProject(pointerProjectId);
      assert.equal(initialScan.status, "succeeded");
      await upsertProjectAiRoute(pointerProjectId, {
        operation: "embedding",
        providerConnectionId: provider.id,
        modelId: "embedding-test",
        embeddingDimensions: 8,
      }, db);
      const pointerFullJob = await runProjectMemoryIndexJob({
        projectId: pointerProjectId,
        requestedBy: { id: userId },
        clientKey: `pointer-full-${randomUUID()}`,
        consent,
        mode: "full",
      }, db);
      assert.equal(pointerFullJob.status, "succeeded");

      codeState.version = 1;
      const sparseScan = await codeScanner.scanProject(pointerProjectId);
      assert.equal(sparseScan.status, "succeeded");
      const sparsePlan = await getProjectMemoryIndexPlan(pointerProjectId, "incremental", db);
      assert.equal(sparsePlan.expectedInputCount, 34);
      assert.equal(sparsePlan.reuseCount, 17);
      assert.equal(sparsePlan.generateCount, 17);
      assert.equal(sparsePlan.estimatedProviderCalls, 2);
      assert.equal(sparsePlan.deadlineEligible, true);
      embeddingInputs.length = 0;
      const sparseCallsBefore = fetchCalls;
      const sparseJob = await runProjectMemoryIndexJob({
        projectId: pointerProjectId,
        requestedBy: { id: userId },
        clientKey: `pointer-sparse-${randomUUID()}`,
        consent,
        mode: "incremental",
        planFingerprint: sparsePlan.planFingerprint,
      }, db);
      assert.equal(sparseJob.status, "succeeded");
      assert.equal(fetchCalls - sparseCallsBefore, sparsePlan.estimatedProviderCalls);
      assert.equal(embeddingInputs.length, sparsePlan.estimatedProviderCalls);
      assert.equal(embeddingInputs.reduce((total, batch) => total + batch.length, 0), sparsePlan.generateCount);

      codeState.version = 2;
      const deleteScan = await codeScanner.scanProject(pointerProjectId);
      assert.equal(deleteScan.status, "succeeded");
      const deletePlan = await getProjectMemoryIndexPlan(pointerProjectId, "incremental", db);
      assert.equal(deletePlan.expectedInputCount, 33);
      assert.ok(deletePlan.deleteCount >= 1);
      assert.equal(deletePlan.generateCount, 0);
      const deleteCallsBefore = fetchCalls;
      const deleteJob = await runProjectMemoryIndexJob({
        projectId: pointerProjectId,
        requestedBy: { id: userId },
        clientKey: `pointer-delete-${randomUUID()}`,
        consent,
        mode: "incremental",
        planFingerprint: deletePlan.planFingerprint,
      }, db);
      assert.equal(deleteJob.status, "succeeded");
      assert.equal(fetchCalls, deleteCallsBefore);
      const deletePointer = await db.memoryIndexPointer.findUniqueOrThrow({
        where: { projectId: pointerProjectId },
        include: { generation: { include: { records: true } } },
      });
      assert.equal(deletePointer.generation.records.length, 33);
      assert.equal(deletePointer.generation.records.some((record) => record.path === "src/file-33.ts"), false);

      // A complete candidate can be locally confirmed as published without
      // making any provider request. This is the one-step publishedLocally
      // reconciliation path for an interrupted post-publish response.
      const localJobId = randomUUID();
      const localGenerationId = randomUUID();
      const localManifest = digest("published-locally-manifest");
      const localNow = new Date();
      await db.backgroundJob.create({
        data: {
          id: localJobId,
          projectId: publishedLocallyProjectId,
          kind: "memoryIndex",
          status: "unknown",
          stage: "reconciliation_required",
          payload: {},
          failureCode: "AI_PROVIDER_UNAVAILABLE",
          reconciliationRequired: true,
          idempotencyKey: digest("published-locally-job"),
          requestedById: userId,
          startedAt: localNow,
          completedAt: localNow,
        },
      });
      await db.memoryIndexGeneration.create({
        data: {
          id: localGenerationId,
          projectId: publishedLocallyProjectId,
          jobId: localJobId,
          providerConnectionId: provider.id,
          modelId: "embedding-test",
          dimensions: 8,
          status: "complete",
          buildMode: "full",
          inputManifestFingerprint: localManifest,
          expectedInputCount: 0,
          generatedRecordCount: 0,
          reusedRecordCount: 0,
          recordCount: 0,
          completedAt: localNow,
        },
      });
      await db.memoryIndexPointer.create({
        data: {
          projectId: publishedLocallyProjectId,
          indexGenerationId: localGenerationId,
          publishedAt: localNow,
        },
      });
      const localFetchCalls = fetchCalls;
      const localReconciled = await reconcileMemoryIndexJob({
        projectId: publishedLocallyProjectId,
        jobId: localJobId,
        requestedById: userId,
      }, db);
      assert.equal(localReconciled.status, "succeeded");
      assert.equal(localReconciled.reconciliationRequired, false);
      assert.equal((localReconciled.result as { reconciliation?: string }).reconciliation, "publishedLocally");
      assert.equal(fetchCalls, localFetchCalls);
      assert.equal(await db.providerCallAudit.count({ where: { jobId: localJobId } }), 0);
      assert.equal(await db.webAiGrant.count({ where: { projectId: publishedLocallyProjectId } }), 0);
      assert.equal(await db.memoryIndexReconciliation.count({ where: { projectId: publishedLocallyProjectId, indexGenerationId: localGenerationId } }), 1);

      const deadlineState = { version: 0 as CodePointerVersion };
      const deadlineClient = createChangingCodeClient(deadlineState, 97);
      await createGitHubRepositoryLedgerService({ db }).connect({
        projectId: deadlineProjectId,
        repository: {
          repositoryId: 3_900_001,
          nodeId: "R_MEMORY_INDEX_C",
          owner: "acme",
          name: "memory-index-c",
          fullName: "acme/memory-index-c",
          private: true,
          archived: false,
          disabled: false,
          defaultBranch: "main",
        },
        config: repositoryConfig(),
      });
      const deadlineScanner = createGitHubCodeScanService({ db, client: deadlineClient });
      const deadlineScan = await deadlineScanner.scanProject(deadlineProjectId);
      assert.equal(deadlineScan.status, "succeeded");
      await upsertProjectAiRoute(deadlineProjectId, {
        operation: "embedding",
        providerConnectionId: provider.id,
        modelId: "embedding-test",
        embeddingDimensions: 8,
      }, db);
      const deadlineFetchCalls = fetchCalls;
      await assert.rejects(
        () => runProjectMemoryIndexJob({
          projectId: deadlineProjectId,
          requestedBy: { id: userId },
          clientKey: `deadline-${randomUUID()}`,
          consent,
          mode: "full",
        }, db!),
        (error: unknown) => typeof error === "object" && error !== null && "code" in error &&
          (error as { code?: unknown }).code === "MEMORY_INDEX_DEADLINE_EXCEEDED",
      );
      assert.equal(fetchCalls, deadlineFetchCalls);
      assert.equal(await db.backgroundJob.count({ where: { projectId: deadlineProjectId, kind: "memoryIndex" } }), 0);

      // Database guards and project-scoped composite FKs reject an invalid
      // staging pointer and cross-project baseline/reuse references.
      const otherJob = await createMemoryJob(db, otherProjectId, userId, `other-${randomUUID()}`);
      const otherGeneration = await createStagingGeneration(db, {
        projectId: otherProjectId,
        jobId: otherJob.id,
        providerConnectionId: provider.id,
      });
      await assert.rejects(() => db!.memoryIndexPointer.create({
        data: { projectId: otherProjectId, indexGenerationId: otherGeneration.id },
      }));
      const crossProjectJob = await createMemoryJob(db, otherProjectId, userId, `cross-${randomUUID()}`);
      await assert.rejects(() => createStagingGeneration(db!, {
        projectId: otherProjectId,
        jobId: crossProjectJob.id,
        providerConnectionId: provider.id,
        expectedActiveIndexGenerationId: secondPointer.indexGenerationId,
      }));
      await assert.rejects(() => db!.memoryRecord.create({
        data: {
          id: randomUUID(),
          projectId: otherProjectId,
          indexGenerationId: otherGeneration.id,
          scope: "projectSource",
          rangeStart: 0,
          rangeEnd: 1,
          contentText: "cross project reuse must fail",
          contentHash: digest("cross project reuse must fail"),
          embedding: vector("cross project reuse must fail"),
          inputFingerprint: digest("cross-input"),
          embeddingFingerprint: digest("cross-embedding"),
          reusedFromMemoryRecordId: firstRecord.id,
        },
      }));

      const concurrentJobA = await createMemoryJob(db, concurrentProjectId, userId, `concurrent-a-${randomUUID()}`);
      const concurrentJobB = await createMemoryJob(db, concurrentProjectId, userId, `concurrent-b-${randomUUID()}`);
      const admissions = await Promise.allSettled([
        createStagingGeneration(db, { projectId: concurrentProjectId, jobId: concurrentJobA.id, providerConnectionId: provider.id }),
        createStagingGeneration(db, { projectId: concurrentProjectId, jobId: concurrentJobB.id, providerConnectionId: provider.id }),
      ]);
      assert.equal(admissions.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(admissions.filter((result) => result.status === "rejected").length, 1);
    } finally {
      globalThis.fetch = previousFetch;
      if (db !== null) {
        await db.project.deleteMany({ where: { id: { in: [projectId, otherProjectId, concurrentProjectId, pointerProjectId, publishedLocallyProjectId, deadlineProjectId] } } });
        if (providerId !== null) await db.aiProviderConnection.deleteMany({ where: { id: providerId } });
        if (credentialId !== null) await db.externalCredential.deleteMany({ where: { id: credentialId } });
        await db.$disconnect();
      }
      if (rawConnected) await raw.end();
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
      if (previousKeyPath === undefined) delete process.env.AI_PROJECT_OS_MASTER_KEY_FILE;
      else process.env.AI_PROJECT_OS_MASTER_KEY_FILE = previousKeyPath;
    }
  },
);
