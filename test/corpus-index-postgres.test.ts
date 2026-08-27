import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { Client } from "pg";
import {
  OPENAI_EMBEDDINGS_ENDPOINT_FINGERPRINT,
  OPENAI_EMBEDDINGS_PROVIDER_FINGERPRINT,
  OPENAI_EMBEDDINGS_RETENTION_FINGERPRINT,
  OPENAI_EMBEDDING_MODEL_FINGERPRINT,
  OPENAI_EMBEDDING_MODEL_ID,
  OPENAI_EMBEDDING_PROFILE_FINGERPRINT,
  OPENAI_PROCESSOR_REGION_FINGERPRINT,
  OPENAI_PROJECT_ANALYSIS_MODEL_FINGERPRINT,
  OPENAI_PROJECT_ANALYSIS_MODEL_ID,
  OPENAI_PROJECT_ANALYSIS_PROCESSOR_FINGERPRINT,
  OPENAI_PROJECT_ANALYSIS_PROFILE_FINGERPRINT,
  OPENAI_RESPONSES_ENDPOINT_FINGERPRINT,
  OPENAI_RESPONSES_PROVIDER_FINGERPRINT,
  OPENAI_RESPONSES_RETENTION_FINGERPRINT,
  OPENAI_SOURCE_SUMMARY_MODEL_FINGERPRINT,
  OPENAI_SOURCE_SUMMARY_MODEL_ID,
  OPENAI_SOURCE_SUMMARY_PROCESSOR_FINGERPRINT,
  OPENAI_SOURCE_SUMMARY_PROFILE_FINGERPRINT,
  loadOpenAiCredential,
} from "@/lib/ai-runtime";
import {
  AiDerivedArtifactError,
  ReadOnlyAgentError,
  EMBEDDING_STORAGE_PROFILE_FINGERPRINT,
  CorpusIndexError,
  ProjectSearchError,
  buildGroundedRagPlanFromSearch,
  createAiDerivedArtifactService,
  createCorpusIndexService,
  createProjectSearchService,
  createReadOnlyProjectAgent,
} from "@/lib/ai-memory";
import { hashSourceContent } from "@/lib/source";

const execFile = promisify(execFileCallback);
const repositoryRoot = process.cwd();
const databaseName = "ai_project_os_ai_runtime_test";
const databasePort = "56432";
const configuredUrl = process.env.CORPUS_INDEX_TEST_DATABASE_URL;
const gate = process.env.CORPUS_INDEX_POSTGRES_GATE;
const hasUrl = typeof configuredUrl === "string" && configuredUrl.length > 0;
const shouldRun = hasUrl && gate === "1";

const projectId = "11111111-1111-4111-8111-111111111111";
const otherProjectId = "22222222-2222-4222-8222-222222222222";
const sourceAId = "33333333-3333-4333-8333-333333333333";
const sourceBId = "44444444-4444-4444-8444-444444444444";
const policyRevisionId = "55555555-5555-4555-8555-555555555555";
const grantId = "66666666-6666-4666-8666-666666666666";
const grantSourceAId = "77777777-7777-4777-8777-777777777771";
const grantSourceBId = "77777777-7777-4777-8777-777777777772";
const grantOperationId = "88888888-8888-4888-8888-888888888888";
const secondGrantId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const secondGrantSourceAId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const secondGrantSourceBId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";
const secondGrantOperationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4";
const summaryGrantId = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
const summaryGrantSourceAId = "cccccccc-cccc-4ccc-8ccc-ccccccccccc2";
const summaryGrantSourceBId = "cccccccc-cccc-4ccc-8ccc-ccccccccccc3";
const summaryGrantOperationId = "cccccccc-cccc-4ccc-8ccc-ccccccccccc4";
const analysisGrantId = "dddddddd-dddd-4ddd-8ddd-ddddddddddd1";
const analysisGrantSourceAId = "dddddddd-dddd-4ddd-8ddd-ddddddddddd2";
const analysisGrantSourceBId = "dddddddd-dddd-4ddd-8ddd-ddddddddddd3";
const analysisGrantOperationId = "dddddddd-dddd-4ddd-8ddd-ddddddddddd4";
const sourceAContent = "项目负责人是岚。\n\n当前目标是建立可追溯的长期记忆。";
const sourceBContent = "Repository Alpha owns the API. Repository Beta owns the UI.";

function validateDisposableUrl(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("CORPUS_INDEX_TEST_DATABASE_URL_INVALID");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("CORPUS_INDEX_TEST_DATABASE_URL_INVALID");
  }
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname.toLowerCase()) ||
    parsed.port !== databasePort ||
    parsed.pathname !== `/${databaseName}` ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error("CORPUS_INDEX_TEST_DATABASE_URL_INVALID");
  }
  return value;
}

async function expectRejected(action: () => Promise<unknown>): Promise<void> {
  let rejected = false;
  try {
    await action();
  } catch {
    rejected = true;
  }
  assert.equal(rejected, true);
}

test(
  "corpus index PostgreSQL gate requires an explicit disposable target",
  { skip: !hasUrl || gate === "1" },
  () => {
    throw new Error("CORPUS_INDEX_POSTGRES_GATE must equal 1");
  },
);

test(
  "corpus and index generations are deterministic, isolated and atomically guarded",
  { skip: !shouldRun ? "explicit disposable PostgreSQL gate is required" : false },
  async () => {
    const url = validateDisposableUrl(configuredUrl);
    const raw = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
    await raw.connect();
    const previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = url;
    try {
      await raw.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
      await execFile(
        "pnpm",
        ["exec", "prisma", "migrate", "deploy", "--config", "prisma.config.ts"],
        { cwd: repositoryRoot, env: { ...process.env, DATABASE_URL: url } },
      );

      const adapter = new PrismaPg({ connectionString: url });
      const prisma = new PrismaClient({ adapter });
      try {
        await prisma.project.createMany({
          data: [
            { id: projectId, name: "Corpus project", slug: "corpus-project" },
            { id: otherProjectId, name: "Other project", slug: "other-corpus-project" },
          ],
        });
        await prisma.projectSource.createMany({
          data: [
            {
              id: sourceAId,
              projectId,
              kind: "manual",
              contentText: sourceAContent,
              contentHash: hashSourceContent(sourceAContent),
              manualContentDedupeKey: hashSourceContent(sourceAContent),
            },
            {
              id: sourceBId,
              projectId,
              kind: "manual",
              contentText: sourceBContent,
              contentHash: hashSourceContent(sourceBContent),
              manualContentDedupeKey: hashSourceContent(sourceBContent),
            },
          ],
        });
        const processorFingerprint = "1".repeat(64);
        const budgetFingerprint = "2".repeat(64);
        const scannerFingerprint = "3".repeat(64);
        await prisma.projectAiPolicyRevision.create({
          data: {
            id: policyRevisionId,
            projectId,
            revision: 1,
            policyFingerprint: "4".repeat(64),
            outboundEnabled: true,
            embeddingEnabled: true,
            sourceSummaryEnabled: true,
            projectAnalysisEnabled: true,
            profileFingerprint: OPENAI_EMBEDDING_PROFILE_FINGERPRINT,
            processorFingerprint,
            regionFingerprint: OPENAI_PROCESSOR_REGION_FINGERPRINT,
            retentionFingerprint: OPENAI_EMBEDDINGS_RETENTION_FINGERPRINT,
            endpointFingerprint: OPENAI_EMBEDDINGS_ENDPOINT_FINGERPRINT,
            budgetFingerprint,
            scannerFingerprint,
          },
        });
        await prisma.projectAiPolicyOperationProfile.create({
          data: {
            projectId,
            policyRevisionId,
            operation: "embedding",
            profileFingerprint: OPENAI_EMBEDDING_PROFILE_FINGERPRINT,
            providerFingerprint: OPENAI_EMBEDDINGS_PROVIDER_FINGERPRINT,
            modelFingerprint: OPENAI_EMBEDDING_MODEL_FINGERPRINT,
            modelId: OPENAI_EMBEDDING_MODEL_ID,
            processorFingerprint,
            regionFingerprint: OPENAI_PROCESSOR_REGION_FINGERPRINT,
            retentionFingerprint: OPENAI_EMBEDDINGS_RETENTION_FINGERPRINT,
            endpointFingerprint: OPENAI_EMBEDDINGS_ENDPOINT_FINGERPRINT,
          },
        });
        await prisma.projectAiPolicyOperationProfile.create({
          data: {
            projectId,
            policyRevisionId,
            operation: "projectAnalysis",
            profileFingerprint: OPENAI_PROJECT_ANALYSIS_PROFILE_FINGERPRINT,
            providerFingerprint: OPENAI_RESPONSES_PROVIDER_FINGERPRINT,
            modelFingerprint: OPENAI_PROJECT_ANALYSIS_MODEL_FINGERPRINT,
            modelId: OPENAI_PROJECT_ANALYSIS_MODEL_ID,
            processorFingerprint: OPENAI_PROJECT_ANALYSIS_PROCESSOR_FINGERPRINT,
            regionFingerprint: OPENAI_PROCESSOR_REGION_FINGERPRINT,
            retentionFingerprint: OPENAI_RESPONSES_RETENTION_FINGERPRINT,
            endpointFingerprint: OPENAI_RESPONSES_ENDPOINT_FINGERPRINT,
          },
        });
        await prisma.projectAiPolicyOperationProfile.create({
          data: {
            projectId,
            policyRevisionId,
            operation: "sourceSummary",
            profileFingerprint: OPENAI_SOURCE_SUMMARY_PROFILE_FINGERPRINT,
            providerFingerprint: OPENAI_RESPONSES_PROVIDER_FINGERPRINT,
            modelFingerprint: OPENAI_SOURCE_SUMMARY_MODEL_FINGERPRINT,
            modelId: OPENAI_SOURCE_SUMMARY_MODEL_ID,
            processorFingerprint: OPENAI_SOURCE_SUMMARY_PROCESSOR_FINGERPRINT,
            regionFingerprint: OPENAI_PROCESSOR_REGION_FINGERPRINT,
            retentionFingerprint: OPENAI_RESPONSES_RETENTION_FINGERPRINT,
            endpointFingerprint: OPENAI_RESPONSES_ENDPOINT_FINGERPRINT,
          },
        });
        await prisma.projectAiPolicy.create({
          data: { projectId, currentRevisionId: policyRevisionId },
        });
        await prisma.modelProcessingGrant.create({
          data: {
            id: grantId,
            projectId,
            sourceKind: "manual_text",
            policyRevisionId,
            profileFingerprint: OPENAI_EMBEDDING_PROFILE_FINGERPRINT,
            providerFingerprint: OPENAI_EMBEDDINGS_PROVIDER_FINGERPRINT,
            modelFingerprint: OPENAI_EMBEDDING_MODEL_FINGERPRINT,
            modelId: OPENAI_EMBEDDING_MODEL_ID,
            processorFingerprint,
            regionFingerprint: OPENAI_PROCESSOR_REGION_FINGERPRINT,
            retentionFingerprint: OPENAI_EMBEDDINGS_RETENTION_FINGERPRINT,
            endpointFingerprint: OPENAI_EMBEDDINGS_ENDPOINT_FINGERPRINT,
            grantFingerprint: "5".repeat(64),
            effectivePolicyVersion: 1,
            budgetFingerprint,
            scannerFingerprint,
            scannerVersion: "scanner-v1",
            budgetProfile: "standard",
            issuedBy: "test-owner",
            purposeCode: "semantic-index",
          },
        });
        await prisma.modelProcessingGrantSource.createMany({
          data: [
            {
              id: grantSourceAId,
              projectId,
              grantId,
              sourceId: sourceAId,
              contentFingerprint: hashSourceContent(sourceAContent),
              contentBytes: Buffer.byteLength(sourceAContent, "utf8"),
            },
            {
              id: grantSourceBId,
              projectId,
              grantId,
              sourceId: sourceBId,
              contentFingerprint: hashSourceContent(sourceBContent),
              contentBytes: Buffer.byteLength(sourceBContent, "utf8"),
            },
          ],
        });
        await prisma.modelProcessingGrantOperation.create({
          data: {
            id: grantOperationId,
            projectId,
            grantId,
            operation: "embedding",
          },
        });
        await prisma.modelProcessingGrant.update({
          where: { id: grantId },
          data: {
            status: "issued",
            issuedAt: new Date(Date.now() - 60_000),
            expiresAt: new Date(Date.now() + 3_600_000),
          },
        });
        await prisma.modelProcessingGrant.create({
          data: {
            id: summaryGrantId,
            projectId,
            sourceKind: "manual_text",
            policyRevisionId,
            profileFingerprint: OPENAI_SOURCE_SUMMARY_PROFILE_FINGERPRINT,
            providerFingerprint: OPENAI_RESPONSES_PROVIDER_FINGERPRINT,
            modelFingerprint: OPENAI_SOURCE_SUMMARY_MODEL_FINGERPRINT,
            modelId: OPENAI_SOURCE_SUMMARY_MODEL_ID,
            processorFingerprint: OPENAI_SOURCE_SUMMARY_PROCESSOR_FINGERPRINT,
            regionFingerprint: OPENAI_PROCESSOR_REGION_FINGERPRINT,
            retentionFingerprint: OPENAI_RESPONSES_RETENTION_FINGERPRINT,
            endpointFingerprint: OPENAI_RESPONSES_ENDPOINT_FINGERPRINT,
            grantFingerprint: "c".repeat(64),
            effectivePolicyVersion: 1,
            budgetFingerprint,
            scannerFingerprint,
            scannerVersion: "scanner-v1",
            budgetProfile: "standard",
            issuedBy: "test-owner",
            purposeCode: "source-summary",
          },
        });
        await prisma.modelProcessingGrantSource.createMany({
          data: [
            {
              id: summaryGrantSourceAId,
              projectId,
              grantId: summaryGrantId,
              sourceId: sourceAId,
              contentFingerprint: hashSourceContent(sourceAContent),
              contentBytes: Buffer.byteLength(sourceAContent, "utf8"),
            },
            {
              id: summaryGrantSourceBId,
              projectId,
              grantId: summaryGrantId,
              sourceId: sourceBId,
              contentFingerprint: hashSourceContent(sourceBContent),
              contentBytes: Buffer.byteLength(sourceBContent, "utf8"),
            },
          ],
        });
        await prisma.modelProcessingGrantOperation.create({
          data: {
            id: summaryGrantOperationId,
            projectId,
            grantId: summaryGrantId,
            operation: "sourceSummary",
          },
        });
        await prisma.modelProcessingGrant.update({
          where: { id: summaryGrantId },
          data: {
            status: "issued",
            issuedAt: new Date(Date.now() - 60_000),
            expiresAt: new Date(Date.now() + 3_600_000),
          },
        });
        await prisma.modelProcessingGrant.create({
          data: {
            id: analysisGrantId,
            projectId,
            sourceKind: "manual_text",
            policyRevisionId,
            profileFingerprint: OPENAI_PROJECT_ANALYSIS_PROFILE_FINGERPRINT,
            providerFingerprint: OPENAI_RESPONSES_PROVIDER_FINGERPRINT,
            modelFingerprint: OPENAI_PROJECT_ANALYSIS_MODEL_FINGERPRINT,
            modelId: OPENAI_PROJECT_ANALYSIS_MODEL_ID,
            processorFingerprint: OPENAI_PROJECT_ANALYSIS_PROCESSOR_FINGERPRINT,
            regionFingerprint: OPENAI_PROCESSOR_REGION_FINGERPRINT,
            retentionFingerprint: OPENAI_RESPONSES_RETENTION_FINGERPRINT,
            endpointFingerprint: OPENAI_RESPONSES_ENDPOINT_FINGERPRINT,
            grantFingerprint: "d".repeat(64),
            effectivePolicyVersion: 1,
            budgetFingerprint,
            scannerFingerprint,
            scannerVersion: "scanner-v1",
            budgetProfile: "standard",
            issuedBy: "test-owner",
            purposeCode: "project-analysis",
          },
        });
        await prisma.modelProcessingGrantSource.createMany({
          data: [
            {
              id: analysisGrantSourceAId,
              projectId,
              grantId: analysisGrantId,
              sourceId: sourceAId,
              contentFingerprint: hashSourceContent(sourceAContent),
              contentBytes: Buffer.byteLength(sourceAContent, "utf8"),
            },
            {
              id: analysisGrantSourceBId,
              projectId,
              grantId: analysisGrantId,
              sourceId: sourceBId,
              contentFingerprint: hashSourceContent(sourceBContent),
              contentBytes: Buffer.byteLength(sourceBContent, "utf8"),
            },
          ],
        });
        await prisma.modelProcessingGrantOperation.create({
          data: {
            id: analysisGrantOperationId,
            projectId,
            grantId: analysisGrantId,
            operation: "projectAnalysis",
          },
        });
        await prisma.modelProcessingGrant.update({
          where: { id: analysisGrantId },
          data: {
            status: "issued",
            issuedAt: new Date(Date.now() - 60_000),
            expiresAt: new Date(Date.now() + 3_600_000),
          },
        });

        const service = createCorpusIndexService({ db: prisma });
        const corpusResults = await Promise.all([
          service.ensureProjectCorpusGeneration({ projectId, grantId }),
          service.ensureProjectCorpusGeneration({ projectId, grantId }),
        ]);
        assert.equal(corpusResults[0]?.id, corpusResults[1]?.id);
        assert.equal(corpusResults[0]?.sourceCount, 2);
        assert.equal(corpusResults[0]?.expectedChunkCount, 2);
        assert.equal(await prisma.projectCorpusGeneration.count({ where: { projectId } }), 1);
        assert.equal(await prisma.projectCorpusGenerationEntry.count({ where: { projectId } }), 2);

        const indexResults = await Promise.all([
          service.prepareProjectCorpusIndex({
            projectId,
            corpusGenerationId: corpusResults[0]!.id,
          }),
          service.prepareProjectCorpusIndex({
            projectId,
            corpusGenerationId: corpusResults[0]!.id,
          }),
        ]);
        assert.equal(indexResults[0]?.id, indexResults[1]?.id);
        assert.equal(indexResults[0]?.status, "building");
        assert.equal(indexResults[0]?.attemptStatus, "queued");
        assert.equal(indexResults[0]?.expectedInputCount, 2);
        assert.equal(await prisma.indexGeneration.count({ where: { projectId } }), 1);
        assert.equal(await prisma.indexGenerationInputEntry.count({ where: { projectId } }), 2);
        assert.equal(await prisma.projectCorpusIndexInput.count({ where: { projectId } }), 2);
        assert.equal(await prisma.indexWorkItem.count({ where: { projectId } }), 2);
        assert.equal(await prisma.indexBuildAttempt.count({ where: { projectId } }), 1);

        await expectRejected(() => prisma.indexGeneration.update({
          where: { projectId_id: { projectId, id: indexResults[0]!.id } },
          data: {
            status: "ragReady",
            indexedInputCount: 2,
            completedAt: new Date(),
          },
        }));
        await expectRejected(() => prisma.projectCorpusIndexPointer.create({
          data: {
            projectId,
            indexGenerationId: indexResults[0]!.id,
            corpusGenerationId: corpusResults[0]!.id,
          },
        }));
        await expectRejected(() => raw.query(
          `INSERT INTO "ProjectCorpusIndexPointer"
             ("projectId", "indexGenerationId", "corpusGenerationId")
           VALUES ($1, $2, $3)`,
          [otherProjectId, indexResults[0]!.id, corpusResults[0]!.id],
        ));

        const firstInput = await prisma.indexGenerationInputEntry.findFirstOrThrow({
          where: { projectId, indexGenerationId: indexResults[0]!.id },
          orderBy: { ordinal: "asc" },
        });
        const forgedIndexId = "99999999-9999-4999-8999-999999999999";
        await prisma.indexGeneration.create({
          data: {
            id: forgedIndexId,
            projectId,
            kind: "projectCorpus",
            grantId,
            policyRevisionId,
            embeddingProfileId: indexResults[0]!.embeddingProfileId,
            generationKey: "6".repeat(64),
            inputManifestFingerprint: "7".repeat(64),
            processingBoundaryFingerprint: "8".repeat(64),
            expectedInputCount: 1,
          },
        });
        await expectRejected(async () => {
          await raw.query("BEGIN");
          try {
            await raw.query(
              `INSERT INTO "IndexGenerationInputEntry"
                 ("id", "projectId", "indexGenerationId", "ordinal", "entryKind",
                  "sourceChunkId", "contentHash", "contentBytes")
               VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', $1, $2, 0,
                       'project_corpus', $3, $4, $5)`,
              [
                projectId,
                forgedIndexId,
                firstInput.sourceChunkId,
                firstInput.contentHash,
                firstInput.contentBytes,
              ],
            );
            await raw.query("COMMIT");
          } catch (error) {
            await raw.query("ROLLBACK");
            throw error;
          }
        });

        const credential = loadOpenAiCredential({
          OPENAI_API_KEY: `sk-${"a".repeat(32)}`,
        });
        assert.notEqual(credential, null);
        let fetchCalls = 0;
        const published = await service.executeProjectCorpusIndex(
          { projectId, indexGenerationId: indexResults[0]!.id },
          credential!,
          {
            fetchImplementation: async (_request, init) => {
              fetchCalls += 1;
              const body = JSON.parse(String(init?.body)) as {
                model: string;
                input: string[];
                dimensions: number;
              };
              assert.equal(body.model, OPENAI_EMBEDDING_MODEL_ID);
              assert.equal(body.dimensions, 1_536);
              assert.equal(body.input.length, 2);
              assert.deepEqual(
                [...body.input].sort(),
                [sourceAContent, sourceBContent].sort(),
              );
              return new Response(JSON.stringify({
                object: "list",
                model: OPENAI_EMBEDDING_MODEL_ID,
                data: body.input.map((content, index) => ({
                  object: "embedding",
                  index,
                  embedding: Array.from(
                    { length: 1_536 },
                    (__, component) =>
                      component === (content === sourceAContent ? 0 : 1) ? 1 : 0,
                  ),
                })),
                usage: { prompt_tokens: 12, total_tokens: 12 },
              }), {
                status: 200,
                headers: {
                  "content-type": "application/json",
                  "x-request-id": "req_index_success",
                },
              });
            },
          },
        );
        assert.equal(published.kind, "published");
        assert.equal(fetchCalls, 1);
        assert.equal(await prisma.chunkEmbedding.count({ where: { projectId } }), 2);
        assert.equal(await prisma.projectCorpusIndexPointer.count({ where: { projectId } }), 1);
        assert.equal(await prisma.projectRagSnapshot.count({ where: { projectId, status: "complete" } }), 1);
        assert.equal(await prisma.projectRagSnapshotPointer.count({ where: { projectId } }), 1);
        assert.equal(await prisma.indexWorkItem.count({
          where: { projectId, status: "succeeded" },
        }), 2);
        const vectorShape = await raw.query<{
          dimensions: number;
          embeddings: string;
          minimum_norm: number;
          maximum_norm: number;
        }>(
          `SELECT (
                    SELECT vector_dims(e."vector")
                      FROM "ChunkEmbedding" AS e
                     WHERE e."projectId" = $1
                     LIMIT 1
                  ) AS dimensions,
                  (SELECT COUNT(*)::text
                     FROM "ChunkEmbedding" AS e
                    WHERE e."projectId" = $1) AS embeddings,
                  (SELECT MIN(vector_norm(e."vector"))
                     FROM "ChunkEmbedding" AS e
                    WHERE e."projectId" = $1) AS minimum_norm,
                  (SELECT MAX(vector_norm(e."vector"))
                     FROM "ChunkEmbedding" AS e
                    WHERE e."projectId" = $1) AS maximum_norm`,
          [projectId],
        );
        assert.deepEqual(vectorShape.rows[0], {
          dimensions: 1536,
          embeddings: "2",
          minimum_norm: 1,
          maximum_norm: 1,
        });
        const searchService = createProjectSearchService({ db: prisma });
        const lexicalSearch = await searchService.search({
          projectId,
          query: "可追溯的长期记忆",
          take: 2,
        });
        assert.equal(lexicalSearch.mode, "lexical");
        assert.equal(lexicalSearch.results[0]?.citation.sourceId, sourceAId);
        assert.equal(lexicalSearch.results[0]?.citation.excerpt, sourceAContent);
        assert.equal(lexicalSearch.snapshot.manualIndexGenerationId, indexResults[0]!.id);

        const summaryPlan = buildGroundedRagPlanFromSearch({
          projectId,
          question: "请按资料原文摘要项目负责人和目标。",
          search: lexicalSearch,
        });
        const summaryOutput = {
          kind: "source_summary" as const,
          paragraphs: [{
            text: sourceAContent,
            citations: [{ citationKey: "c1", excerpt: sourceAContent }],
          }],
        };
        const artifactService = createAiDerivedArtifactService({ db: prisma });
        const artifacts = await Promise.all([
          artifactService.publishAnalysis({
            projectId,
            operation: "sourceSummary",
            plan: summaryPlan,
            output: summaryOutput,
          }),
          artifactService.publishAnalysis({
            projectId,
            operation: "sourceSummary",
            plan: summaryPlan,
            output: summaryOutput,
          }),
        ]);
        assert.equal(artifacts[0]?.id, artifacts[1]?.id);
        assert.equal(artifacts[0]?.availability, "active");
        assert.equal(artifacts[0]?.kind, "source_summary");
        const summarySourceCount = new Set(
          summaryPlan.contexts.map((context) => context.sourceId),
        ).size;
        assert.equal(artifacts[0]?.dependencyCount, summarySourceCount + 1);
        assert.equal(artifacts[0]?.payload?.kind, "source_summary");
        const projectBrief = await artifactService.publishAnalysis({
          projectId,
          operation: "projectAnalysis",
          plan: summaryPlan,
          output: {
            kind: "project_brief",
            progress: [{
              text: "当前目标是建立可追溯的长期记忆",
              citations: [{
                citationKey: "c1",
                excerpt: "当前目标是建立可追溯的长期记忆",
              }],
            }],
            risks: [],
            unknowns: [],
            conflicts: [],
            questions: [],
          },
        });
        assert.equal(projectBrief.kind, "project_brief");
        assert.equal(projectBrief.availability, "active");
        assert.equal(projectBrief.payload?.kind, "project_brief");
        assert.equal(await prisma.aiDerivedArtifact.count({ where: { projectId } }), 2);
        assert.equal(
          await prisma.artifactDependency.count({ where: { projectId } }),
          (summarySourceCount + 1) * 2,
        );
        const writeCountsBeforeAgent = await Promise.all([
          prisma.project.count(),
          prisma.projectSource.count(),
          prisma.projectItem.count(),
          prisma.projectSnapshot.count(),
          prisma.projectScan.count(),
          prisma.aiRun.count(),
          prisma.aiAuditEvent.count(),
          prisma.aiDerivedArtifact.count(),
          prisma.artifactDependency.count(),
        ]);
        const readOnlyAgent = createReadOnlyProjectAgent({
          db: prisma,
          searchService,
          resolvePlan: async (input) => {
            assert.equal(input.project.id, projectId);
            assert.deepEqual(input.tools, [
              "read_project",
              "search_memory",
              "get_source",
              "get_snapshot",
            ]);
            return {
              calls: [
                { callId: "a1", tool: "read_project", arguments: {} },
                {
                  callId: "a2",
                  tool: "search_memory",
                  arguments: { query: "可追溯的长期记忆", take: 2 },
                },
                { callId: "a3", tool: "get_source", arguments: { sourceId: sourceAId } },
              ],
            };
          },
          resolveFinal: async (plan) => {
            assert.equal(plan.snapshotId, lexicalSearch.snapshot.id);
            assert.equal(plan.contexts.every((context) => context.projectId === projectId), true);
            return {
              kind: "answer",
              claims: [{
                text: "当前目标是建立可追溯的长期记忆",
                citations: [{
                  citationKey: "c1",
                  excerpt: "当前目标是建立可追溯的长期记忆",
                }],
              }],
            };
          },
        });
        const agentRun = await readOnlyAgent.run({
          projectId,
          question: "项目当前目标是什么？",
        });
        assert.equal(agentRun.result.kind, "answer");
        assert.equal(agentRun.capabilities.writeCount, 0);
        assert.deepEqual(agentRun.trace.map((entry) => entry.tool), [
          "read_project",
          "search_memory",
          "get_source",
        ]);
        const writeCountsAfterAgent = await Promise.all([
          prisma.project.count(),
          prisma.projectSource.count(),
          prisma.projectItem.count(),
          prisma.projectSnapshot.count(),
          prisma.projectScan.count(),
          prisma.aiRun.count(),
          prisma.aiAuditEvent.count(),
          prisma.aiDerivedArtifact.count(),
          prisma.artifactDependency.count(),
        ]);
        assert.deepEqual(writeCountsAfterAgent, writeCountsBeforeAgent);

        const crossProjectAgent = createReadOnlyProjectAgent({
          db: prisma,
          searchService,
          resolvePlan: async () => ({
            calls: [{
              callId: "a1",
              tool: "get_source",
              arguments: { sourceId: sourceAId },
            }],
          }),
          resolveFinal: async () => { throw new Error("must not resolve final"); },
        });
        await assert.rejects(
          () => crossProjectAgent.run({
            projectId: otherProjectId,
            question: "读取另一个项目的来源",
          }),
          (error: unknown) =>
            error instanceof ReadOnlyAgentError &&
            error.code === "READ_ONLY_AGENT_SOURCE_NOT_FOUND",
        );
        await assert.rejects(
          () => artifactService.publishAnalysis({
            projectId,
            operation: "sourceSummary",
            plan: summaryPlan,
            output: {
              kind: "source_summary",
              paragraphs: [{
                text: "不存在于证据中的结论",
                citations: [{ citationKey: "c1", excerpt: sourceAContent }],
              }],
            },
          }),
        );
        await prisma.modelProcessingGrant.update({
          where: { id: summaryGrantId },
          data: {
            status: "revoked",
            revokedAt: new Date(),
            revocationReasonCode: "userRequested",
          },
        });
        const restrictedArtifact = await artifactService.getArtifact({
          projectId,
          artifactId: artifacts[0]!.id,
        });
        assert.equal(restrictedArtifact.availability, "restricted");
        assert.equal(restrictedArtifact.restrictionReasonCode, "GRANT_INELIGIBLE");
        assert.equal(restrictedArtifact.payload, null);
        const stillActiveBrief = await artifactService.getArtifact({
          projectId,
          artifactId: projectBrief.id,
        });
        assert.equal(stillActiveBrief.availability, "active");
        await assert.rejects(
          () => artifactService.getArtifact({
            projectId: otherProjectId,
            artifactId: artifacts[0]!.id,
          }),
          (error: unknown) =>
            error instanceof AiDerivedArtifactError &&
            error.code === "AI_ARTIFACT_NOT_FOUND",
        );

        const hybridSearch = await searchService.search({
          projectId,
          query: "向量专用查询",
          take: 2,
          queryEmbedding: {
            profileFingerprint: EMBEDDING_STORAGE_PROFILE_FINGERPRINT,
            vector: Array.from({ length: 1_536 }, (_, index) => index === 0 ? 1 : 0),
          },
        });
        assert.equal(hybridSearch.mode, "hybrid");
        assert.equal(hybridSearch.results[0]?.citation.sourceId, sourceAId);
        assert.equal(hybridSearch.results[0]?.componentRanks.vector, 1);
        assert.equal(hybridSearch.results.every((result) => result.citation.projectId === projectId), true);
        await assert.rejects(
          () => searchService.search({
            projectId: otherProjectId,
            query: "长期记忆",
          }),
          (error: unknown) =>
            error instanceof ProjectSearchError &&
            error.code === "PROJECT_SEARCH_SNAPSHOT_NOT_READY",
        );
        const ragSnapshot = await prisma.projectRagSnapshot.findFirstOrThrow({
          where: { projectId, status: "complete" },
          select: { id: true },
        });
        await expectRejected(() => raw.query(
          `INSERT INTO "ProjectRagSnapshotPointer"
             ("projectId", "ragSnapshotId")
           VALUES ($1, $2)`,
          [otherProjectId, ragSnapshot.id],
        ));
        const replayed = await service.executeProjectCorpusIndex(
          { projectId, indexGenerationId: indexResults[0]!.id },
          credential!,
          { fetchImplementation: async () => { throw new Error("must not dispatch"); } },
        );
        assert.equal(replayed.kind, "published");
        assert.equal(fetchCalls, 1);

        await prisma.modelProcessingGrant.create({
          data: {
            id: secondGrantId,
            projectId,
            sourceKind: "manual_text",
            policyRevisionId,
            profileFingerprint: OPENAI_EMBEDDING_PROFILE_FINGERPRINT,
            providerFingerprint: OPENAI_EMBEDDINGS_PROVIDER_FINGERPRINT,
            modelFingerprint: OPENAI_EMBEDDING_MODEL_FINGERPRINT,
            modelId: OPENAI_EMBEDDING_MODEL_ID,
            processorFingerprint,
            regionFingerprint: OPENAI_PROCESSOR_REGION_FINGERPRINT,
            retentionFingerprint: OPENAI_EMBEDDINGS_RETENTION_FINGERPRINT,
            endpointFingerprint: OPENAI_EMBEDDINGS_ENDPOINT_FINGERPRINT,
            grantFingerprint: "a".repeat(64),
            effectivePolicyVersion: 1,
            budgetFingerprint,
            scannerFingerprint,
            scannerVersion: "scanner-v1",
            budgetProfile: "standard",
            issuedBy: "test-owner",
            purposeCode: "unknown-state",
          },
        });
        await prisma.modelProcessingGrantSource.createMany({
          data: [
            {
              id: secondGrantSourceAId,
              projectId,
              grantId: secondGrantId,
              sourceId: sourceAId,
              contentFingerprint: hashSourceContent(sourceAContent),
              contentBytes: Buffer.byteLength(sourceAContent, "utf8"),
            },
            {
              id: secondGrantSourceBId,
              projectId,
              grantId: secondGrantId,
              sourceId: sourceBId,
              contentFingerprint: hashSourceContent(sourceBContent),
              contentBytes: Buffer.byteLength(sourceBContent, "utf8"),
            },
          ],
        });
        await prisma.modelProcessingGrantOperation.create({
          data: {
            id: secondGrantOperationId,
            projectId,
            grantId: secondGrantId,
            operation: "embedding",
          },
        });
        await prisma.modelProcessingGrant.update({
          where: { id: secondGrantId },
          data: {
            status: "issued",
            issuedAt: new Date(Date.now() - 60_000),
            expiresAt: new Date(Date.now() + 3_600_000),
          },
        });
        const secondCorpus = await service.ensureProjectCorpusGeneration({
          projectId,
          grantId: secondGrantId,
        });
        const secondIndex = await service.prepareProjectCorpusIndex({
          projectId,
          corpusGenerationId: secondCorpus.id,
        });
        await expectRejected(() => prisma.indexBuildAttempt.update({
          where: { id: secondIndex.attemptId },
          data: { status: "running", startedAt: new Date() },
        }));
        const unknown = await service.executeProjectCorpusIndex(
          { projectId, indexGenerationId: secondIndex.id },
          credential!,
          {
            fetchImplementation: async () => {
              throw new TypeError("simulated connection ambiguity");
            },
          },
        );
        assert.deepEqual(unknown, {
          kind: "terminal",
          status: "unknown",
          safeCode: "AI_PROVIDER_UNKNOWN",
          indexGenerationId: secondIndex.id,
          attemptId: secondIndex.attemptId,
        });
        assert.equal(await prisma.indexWorkItem.count({
          where: {
            projectId,
            indexGenerationId: secondIndex.id,
            status: "unknown",
          },
        }), 2);
        await assert.rejects(
          () => service.executeProjectCorpusIndex(
            { projectId, indexGenerationId: secondIndex.id },
            credential!,
          ),
          (error: unknown) =>
            error instanceof CorpusIndexError &&
            error.code === "CORPUS_INDEX_RECONCILIATION_REQUIRED",
        );
        await expectRejected(() => prisma.indexBuildAttempt.create({
          data: {
            id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            projectId,
            indexGenerationId: secondIndex.id,
            grantId: secondGrantId,
            policyRevisionId,
            attemptNumber: 2,
            operationKey: "9".repeat(64),
            expectedInputCount: 2,
          },
        }));

        await prisma.modelProcessingGrant.update({
          where: { id: grantId },
          data: {
            status: "revoked",
            revokedAt: new Date(),
            revocationReasonCode: "userRequested",
          },
        });
        await assert.rejects(
          () => searchService.search({
            projectId,
            query: "长期记忆",
          }),
          (error: unknown) =>
            error instanceof ProjectSearchError &&
            error.code === "PROJECT_SEARCH_SNAPSHOT_INELIGIBLE",
        );
        await assert.rejects(
          () => service.ensureProjectCorpusGeneration({ projectId, grantId }),
          (error: unknown) =>
            error instanceof CorpusIndexError &&
            error.code === "CORPUS_INDEX_GRANT_INELIGIBLE",
        );
      } finally {
        await prisma.$disconnect();
      }
    } finally {
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
      await raw.end();
    }
  },
);
