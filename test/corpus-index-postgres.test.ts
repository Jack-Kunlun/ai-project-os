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
  loadOpenAiCredential,
} from "@/lib/ai-runtime";
import { CorpusIndexError, createCorpusIndexService } from "@/lib/ai-memory";
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
              return new Response(JSON.stringify({
                object: "list",
                model: OPENAI_EMBEDDING_MODEL_ID,
                data: body.input.map((_, index) => ({
                  object: "embedding",
                  index,
                  embedding: Array.from(
                    { length: 1_536 },
                    (__, component) => component === index ? 1 : 0,
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
