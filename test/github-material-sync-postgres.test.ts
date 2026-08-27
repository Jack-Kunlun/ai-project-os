import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { AiOperation, PrismaClient, ProjectRepositoryRole } from "@prisma/client";
import { Client } from "pg";
import {
  GITHUB_READ_ONLY_CLIENT_VERSION,
  GITHUB_SOFT_EXCLUDE_CLASSES,
  REPOSITORY_MATERIAL_MODEL_TRANSFER_CONSENT_VERSION,
  RepositoryMaterialIndexError,
  createGitHubMaterialSyncService,
  createGitHubRepositoryLedgerService,
  createRepositoryMaterialIndexService,
  createRepositoryMaterialModelGrantService,
  type GitHubMaterialReadOnlyClient,
} from "@/lib/github";
import {
  OPENAI_EMBEDDING_PROCESSOR_FINGERPRINT,
  OPENAI_EMBEDDING_MODEL_ID,
  getOpenAiEmbeddingProfile,
  loadOpenAiCredential,
} from "@/lib/ai-runtime";

const execFile = promisify(execFileCallback);
const repositoryRoot = process.cwd();
const databaseName = "ai_project_os_material_sync_test";
const databasePort = "56432";
const configuredUrl = process.env.GITHUB_MATERIAL_SYNC_TEST_DATABASE_URL;
const gate = process.env.GITHUB_MATERIAL_SYNC_POSTGRES_GATE;
const hasUrl = typeof configuredUrl === "string" && configuredUrl.length > 0;
const shouldRun = hasUrl && gate === "1";

const projectId = "11111111-1111-4111-8111-111111111111";
const commitSha = "a".repeat(40);
const rootTreeSha = "b".repeat(40);
const readmeSha = "c".repeat(40);
const docsTreeSha = "d".repeat(40);
const architectureSha = "e".repeat(40);
const secretSha = "f".repeat(40);

const repositoryA = Object.freeze({
  repositoryId: 3_000_001,
  nodeId: "R_SYNC_A",
  owner: "acme",
  name: "application",
  fullName: "acme/application",
  private: true,
  archived: false,
  disabled: false,
  defaultBranch: "main",
});

const repositoryB = Object.freeze({
  repositoryId: 3_000_002,
  nodeId: "R_SYNC_B",
  owner: "acme",
  name: "infrastructure",
  fullName: "acme/infrastructure",
  private: true,
  archived: false,
  disabled: false,
  defaultBranch: "main",
});

function validateDisposableUrl(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("GITHUB_MATERIAL_SYNC_TEST_DATABASE_URL_INVALID");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("GITHUB_MATERIAL_SYNC_TEST_DATABASE_URL_INVALID");
  }
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname.toLowerCase()) ||
    parsed.port !== databasePort ||
    parsed.pathname !== `/${databaseName}` ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error("GITHUB_MATERIAL_SYNC_TEST_DATABASE_URL_INVALID");
  }
  return value;
}

function repositoryConfig(role: ProjectRepositoryRole) {
  return Object.freeze({
    role,
    requiredForProjectSnapshot: role === ProjectRepositoryRole.application,
    trackedRef: "refs/heads/main",
    codeEnabled: true,
    metadataEnabled: true,
    readmeEnabled: true,
    markdownEnabled: true,
    markdownPaths: ["docs/architecture.md", "docs/secret.md"],
    issuesEnabled: true,
    pullRequestsEnabled: true,
    releasesEnabled: true,
    includeRoots: ["README.md", "src"],
    softExcludePatterns: [...GITHUB_SOFT_EXCLUDE_CLASSES],
  });
}

function encoded(text: string) {
  const bytes = Buffer.from(text, "utf8");
  return Object.freeze({ size: bytes.byteLength, content: bytes.toString("base64") });
}

function fixtureClient(requests: { count: number }): GitHubMaterialReadOnlyClient {
  const readme = encoded("# Governed memory\n");
  const architecture = encoded("# Architecture\nRepository material is immutable.\n");
  const secret = encoded('password = "CorrectHorseBatteryStaple"\n');
  const called = <T>(value: T): T => {
    requests.count += 1;
    return value;
  };
  return Object.freeze({
    version: GITHUB_READ_ONLY_CLIENT_VERSION,
    async getRepository(input: Readonly<{ owner: string; repository: string }>) {
      assert.equal(input.owner, repositoryA.owner);
      assert.equal(input.repository, repositoryA.name);
      return called(repositoryA);
    },
    async getReference() {
      return called(Object.freeze({ ref: "refs/heads/main", commitSha }));
    },
    async getCommit() {
      return called(Object.freeze({ commitSha, treeSha: rootTreeSha }));
    },
    async getTree(input: Readonly<{ owner: string; repository: string; treeSha: string }>) {
      if (input.treeSha === rootTreeSha) {
        return called(Object.freeze({
          treeSha: rootTreeSha,
          truncated: false,
          entries: Object.freeze([
            Object.freeze({ path: "README.md", mode: "100644" as const, type: "blob" as const, sha: readmeSha, size: readme.size }),
            Object.freeze({ path: "docs", mode: "040000" as const, type: "tree" as const, sha: docsTreeSha, size: null }),
          ]),
        }));
      }
      assert.equal(input.treeSha, docsTreeSha);
      return called(Object.freeze({
        treeSha: docsTreeSha,
        truncated: false,
        entries: Object.freeze([
          Object.freeze({ path: "architecture.md", mode: "100644" as const, type: "blob" as const, sha: architectureSha, size: architecture.size }),
          Object.freeze({ path: "secret.md", mode: "100644" as const, type: "blob" as const, sha: secretSha, size: secret.size }),
        ]),
      }));
    },
    async getBlob(input: Readonly<{ owner: string; repository: string; blobSha: string }>) {
      const value = input.blobSha === readmeSha
        ? readme
        : input.blobSha === architectureSha
          ? architecture
          : secret;
      return called(Object.freeze({
        blobSha: input.blobSha,
        encoding: "base64" as const,
        ...value,
      }));
    },
    async getIssuesPage() {
      return called(Object.freeze({
        items: Object.freeze([Object.freeze({
          nodeId: "I_SYNC_7",
          number: 7,
          title: "Keep citations immutable",
          body: "The citation must retain its source identity.",
          state: "open" as const,
          labels: Object.freeze(["memory"]),
          createdAt: "2026-08-01T00:00:00Z",
          updatedAt: "2026-08-02T00:00:00Z",
          closedAt: null,
          htmlUrl: "https://github.com/acme/application/issues/7",
        })]),
        nextPage: null,
      }));
    },
    async getPullRequestsPage() {
      return called(Object.freeze({
        items: Object.freeze([Object.freeze({
          nodeId: "PR_SYNC_12",
          number: 12,
          updatedAt: "2026-08-03T00:00:00Z",
        })]),
        nextPage: null,
      }));
    },
    async getPullRequest() {
      return called(Object.freeze({
        nodeId: "PR_SYNC_12",
        number: 12,
        title: "Add immutable citations",
        body: "Includes line-scoped citations.",
        state: "closed" as const,
        draft: false,
        baseRef: "main",
        baseSha: "2".repeat(40),
        headRef: "feature/citations",
        headSha: "3".repeat(40),
        additions: 20,
        deletions: 3,
        changedFiles: 1,
        createdAt: "2026-08-01T00:00:00Z",
        updatedAt: "2026-08-03T00:00:00Z",
        closedAt: "2026-08-03T00:00:00Z",
        mergedAt: "2026-08-03T00:00:00Z",
        htmlUrl: "https://github.com/acme/application/pull/12",
      }));
    },
    async getPullRequestFilesPage() {
      return called(Object.freeze({
        items: Object.freeze([Object.freeze({
          blobSha: "4".repeat(40),
          filename: "src/citations.ts",
          previousFilename: null,
          status: "modified" as const,
          additions: 20,
          deletions: 3,
          changes: 23,
        })]),
        nextPage: null,
      }));
    },
    async getReleasesPage() {
      return called(Object.freeze({
        items: Object.freeze([Object.freeze({
          releaseId: 99,
          nodeId: "RE_SYNC_99",
          tagName: "v1.0.0",
          name: "V1",
          body: "First governed memory release.",
          draft: false,
          prerelease: false,
          createdAt: "2026-08-04T00:00:00Z",
          updatedAt: "2026-08-04T02:00:00Z",
          publishedAt: "2026-08-04T01:00:00Z",
          htmlUrl: "https://github.com/acme/application/releases/tag/v1.0.0",
        })]),
        nextPage: null,
      }));
    },
  });
}

test(
  "GitHub material sync PostgreSQL gate requires an explicit disposable target",
  { skip: !hasUrl || gate === "1" },
  () => {
    throw new Error("GITHUB_MATERIAL_SYNC_POSTGRES_GATE must equal 1");
  },
);

test(
  "material sync publishes safe sources atomically and reuses immutable revisions",
  { skip: !shouldRun ? "explicit disposable PostgreSQL gate is required" : false },
  async () => {
    const url = validateDisposableUrl(configuredUrl);
    const raw = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
    const previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = url;
    try {
      await raw.connect();
      await raw.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
      await execFile(
        "pnpm",
        ["exec", "prisma", "migrate", "deploy", "--config", "prisma.config.ts"],
        { cwd: repositoryRoot, env: { ...process.env, DATABASE_URL: url } },
      );
      const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
      try {
        await prisma.project.create({
          data: { id: projectId, name: "Material sync", slug: "material-sync" },
        });
        const ledger = createGitHubRepositoryLedgerService({ db: prisma });
        const linkA = await ledger.connect({
          projectId,
          repository: repositoryA,
          config: repositoryConfig(ProjectRepositoryRole.application),
        });
        const linkB = await ledger.connect({
          projectId,
          repository: repositoryB,
          config: repositoryConfig(ProjectRepositoryRole.infrastructure),
        });
        const requests = { count: 0 };
        const service = createGitHubMaterialSyncService({
          db: prisma,
          client: fixtureClient(requests),
        });

        const prepared = await Promise.all([
          service.prepareRepositorySync({ projectId, linkId: linkA.id }),
          service.prepareRepositorySync({ projectId, linkId: linkA.id }),
        ]);
        assert.equal(prepared[0]?.id, prepared[1]?.id);
        assert.equal(prepared[0]?.status, "queued");
        const first = await service.executeRepositorySync({
          projectId,
          runId: prepared[0]!.id,
        });
        assert.equal(first.status, "succeeded");
        assert.equal(first.stage, "terminal");
        assert.equal(first.publishedSourceCount, 6);
        assert.equal(first.quarantineCount, 1);
        assert.equal(first.requestCount, 15);
        assert.equal(first.activeMaterialGenerationId, first.repositoryMaterialGenerationId);
        const requestsAfterFirst = requests.count;
        const replayed = await service.executeRepositorySync({ projectId, runId: first.id });
        assert.deepEqual(replayed, first);
        assert.equal(requests.count, requestsAfterFirst);

        const firstGenerationId = first.repositoryMaterialGenerationId!;
        assert.equal(await prisma.projectSource.count({ where: { projectId } }), 6);
        assert.equal(await prisma.gitHubSourceVersion.count({ where: { projectId } }), 6);
        assert.equal(await prisma.gitHubMaterialQuarantine.count({ where: { projectId } }), 1);
        const firstIdentities = new Map(
          (await prisma.gitHubSourceVersion.findMany({
            where: { projectId, projectRepositoryLinkId: linkA.id },
            include: { projectSource: { select: { sourceIdentity: true } } },
          })).map((version) => [version.remoteIdentity, version.projectSource.sourceIdentity]),
        );

        const second = await service.syncRepository({ projectId, linkId: linkA.id });
        assert.equal(second.status, "succeeded");
        assert.notEqual(second.repositoryMaterialGenerationId, firstGenerationId);
        assert.equal(second.activeMaterialGenerationId, second.repositoryMaterialGenerationId);
        assert.equal(await prisma.projectSource.count({ where: { projectId } }), 6);
        assert.equal(await prisma.gitHubSourceVersion.count({ where: { projectId } }), 6);
        assert.equal(await prisma.gitHubMaterialQuarantine.count({ where: { projectId } }), 2);
        assert.equal(
          (await prisma.repositoryMaterialGeneration.findUniqueOrThrow({
            where: { id: firstGenerationId },
          })).status,
          "superseded",
        );
        for (const version of await prisma.gitHubSourceVersion.findMany({
          where: { projectId, projectRepositoryLinkId: linkA.id },
          include: { projectSource: { select: { sourceIdentity: true } } },
        })) {
          assert.equal(version.projectSource.sourceIdentity, firstIdentities.get(version.remoteIdentity));
        }

        const embedding = getOpenAiEmbeddingProfile();
        const policyFingerprint = "1".repeat(64);
        const policyRevisionId = "22222222-2222-4222-8222-222222222222";
        await prisma.projectAiPolicyRevision.create({
          data: {
            id: policyRevisionId,
            projectId,
            revision: 1,
            policyFingerprint,
            outboundEnabled: true,
            embeddingEnabled: true,
            autoExtractEnabled: false,
            sourceSummaryEnabled: false,
            projectAnalysisEnabled: false,
            generateWithContextEnabled: false,
            profileFingerprint: "2".repeat(64),
            processorFingerprint: "3".repeat(64),
            regionFingerprint: embedding.processorRegionFingerprint,
            retentionFingerprint: embedding.processorRetentionFingerprint,
            endpointFingerprint: embedding.processorEndpointFingerprint,
            budgetFingerprint: "4".repeat(64),
            scannerFingerprint: "5".repeat(64),
            operationProfiles: {
              create: {
                id: "33333333-3333-4333-8333-333333333333",
                operation: AiOperation.embedding,
                profileFingerprint: embedding.profileFingerprint,
                providerFingerprint: embedding.providerFingerprint,
                modelFingerprint: embedding.modelFingerprint,
                modelId: embedding.modelId,
                processorFingerprint: OPENAI_EMBEDDING_PROCESSOR_FINGERPRINT,
                regionFingerprint: embedding.processorRegionFingerprint,
                retentionFingerprint: embedding.processorRetentionFingerprint,
                endpointFingerprint: embedding.processorEndpointFingerprint,
              },
            },
          },
        });
        await prisma.projectAiPolicy.create({
          data: { projectId, currentRevisionId: policyRevisionId },
        });
        const materialGrants = createRepositoryMaterialModelGrantService({ db: prisma });
        const issued = await materialGrants.issue({
          projectId,
          projectRepositoryLinkId: linkA.id,
          operations: [AiOperation.embedding],
          consentVersion: REPOSITORY_MATERIAL_MODEL_TRANSFER_CONSENT_VERSION,
          acknowledgeExternalModelTransfer: true,
          acknowledgeProcessingRights: true,
        });
        assert.equal(issued.grants.length, 1);
        assert.equal(issued.grants[0]?.operation, AiOperation.embedding);
        assert.equal(issued.eligibleMaterialGeneration?.id, second.repositoryMaterialGenerationId);
        assert.equal(
          await prisma.repositoryMaterialModelGrantSource.count({
            where: { projectId, grantId: issued.grants[0]!.id },
          }),
          6,
        );
        const replayedGrant = await materialGrants.issue({
          projectId,
          projectRepositoryLinkId: linkA.id,
          operations: [AiOperation.embedding],
          consentVersion: REPOSITORY_MATERIAL_MODEL_TRANSFER_CONSENT_VERSION,
          acknowledgeExternalModelTransfer: true,
          acknowledgeProcessingRights: true,
        });
        assert.equal(replayedGrant.grants[0]?.id, issued.grants[0]?.id);

        const materialIndex = createRepositoryMaterialIndexService({ db: prisma });
        const preparedIndexes = await Promise.all([
          materialIndex.prepareRepositoryMaterialIndex({
            projectId,
            projectRepositoryLinkId: linkA.id,
            grantId: issued.grants[0]!.id,
          }),
          materialIndex.prepareRepositoryMaterialIndex({
            projectId,
            projectRepositoryLinkId: linkA.id,
            grantId: issued.grants[0]!.id,
          }),
        ]);
        assert.equal(preparedIndexes[0]?.id, preparedIndexes[1]?.id);
        assert.equal(preparedIndexes[0]?.status, "building");
        assert.ok(preparedIndexes[0]!.expectedInputCount >= 6);
        assert.equal(preparedIndexes[0]?.capturedFullName, repositoryA.fullName);
        assert.equal(preparedIndexes[0]?.observedHeadCommitSha, commitSha);
        assert.equal(
          await prisma.repositoryMaterialIndexGeneration.count({
            where: { projectId, projectRepositoryLinkId: linkA.id },
          }),
          1,
        );
        assert.equal(
          await prisma.repositoryMaterialIndexInput.count({
            where: {
              projectId,
              projectRepositoryLinkId: linkA.id,
              indexGenerationId: preparedIndexes[0]!.id,
            },
          }),
          preparedIndexes[0]!.expectedInputCount,
        );

        const credential = loadOpenAiCredential({
          OPENAI_API_KEY: "sk-" + "a".repeat(32),
        });
        assert.notEqual(credential, null);
        let embeddingCalls = 0;
        const publishedIndex = await materialIndex.executeRepositoryMaterialIndex(
          {
            projectId,
            projectRepositoryLinkId: linkA.id,
            indexGenerationId: preparedIndexes[0]!.id,
          },
          credential!,
          {
            fetchImplementation: async (_request, init) => {
              embeddingCalls += 1;
              const body = JSON.parse(String(init?.body)) as {
                model: string;
                input: string[];
                dimensions: number;
              };
              assert.equal(body.model, OPENAI_EMBEDDING_MODEL_ID);
              assert.equal(body.dimensions, 1_536);
              assert.ok(body.input.length >= 6);
              return new Response(JSON.stringify({
                object: "list",
                model: OPENAI_EMBEDDING_MODEL_ID,
                data: body.input.map((_content, index) => ({
                  object: "embedding",
                  index,
                  embedding: Array.from(
                    { length: 1_536 },
                    (_, component) => component === 0 ? 1 : 0,
                  ),
                })),
                usage: {
                  prompt_tokens: body.input.length * 8,
                  total_tokens: body.input.length * 8,
                },
              }), {
                status: 200,
                headers: {
                  "content-type": "application/json",
                  "x-request-id": "req_repository_material_index_success",
                },
              });
            },
          },
        );
        assert.equal(publishedIndex.kind, "published");
        assert.equal(embeddingCalls, 1);
        assert.equal(
          await prisma.repositoryMaterialIndexPointer.count({
            where: { projectId, projectRepositoryLinkId: linkA.id },
          }),
          1,
        );
        assert.equal(
          await prisma.repositoryMaterialEmbedding.count({
            where: {
              projectId,
              projectRepositoryLinkId: linkA.id,
              indexGenerationId: preparedIndexes[0]!.id,
            },
          }),
          preparedIndexes[0]!.expectedInputCount,
        );
        const materialVectors = await raw.query<{
          dimensions: number;
          magnitude: number;
        }>(
          `SELECT vector_dims("vector") AS dimensions,
                  vector_norm("vector") AS magnitude
             FROM "RepositoryMaterialEmbedding"
            WHERE "projectId" = $1 AND "indexGenerationId" = $2`,
          [projectId, preparedIndexes[0]!.id],
        );
        assert.equal(
          materialVectors.rows.length,
          preparedIndexes[0]!.expectedInputCount,
        );
        assert.ok(materialVectors.rows.every((row) =>
          row.dimensions === 1_536 && row.magnitude === 1));

        const alreadyPublished =
          await materialIndex.executeRepositoryMaterialIndex(
            {
              projectId,
              projectRepositoryLinkId: linkA.id,
              indexGenerationId: preparedIndexes[0]!.id,
            },
            credential!,
            {
              fetchImplementation: async () => {
                throw new Error("published material index must not dispatch again");
              },
            },
          );
        assert.equal(alreadyPublished.kind, "published");
        assert.equal(embeddingCalls, 1);

        await materialGrants.revoke({ projectId, projectRepositoryLinkId: linkA.id });
        assert.equal(
          (await materialGrants.getStatus({ projectId, projectRepositoryLinkId: linkA.id })).grants.length,
          0,
        );
        await assert.rejects(
          () => materialIndex.prepareRepositoryMaterialIndex({
            projectId,
            projectRepositoryLinkId: linkA.id,
            grantId: issued.grants[0]!.id,
          }),
          (error: unknown) =>
            error instanceof RepositoryMaterialIndexError &&
            error.code === "REPOSITORY_MATERIAL_INDEX_GRANT_INELIGIBLE",
        );

        const queuedB = await service.prepareRepositorySync({ projectId, linkId: linkB.id });
        await ledger.disable({ projectId, linkId: linkB.id });
        const requestsBeforeIneligible = requests.count;
        const failedB = await service.executeRepositorySync({ projectId, runId: queuedB.id });
        assert.equal(failedB.status, "failed");
        assert.equal(failedB.failureCode, "GITHUB_MATERIAL_SYNC_LINK_INELIGIBLE");
        assert.equal(failedB.repositoryMaterialGenerationId, null);
        assert.equal(requests.count, requestsBeforeIneligible);
        assert.equal(
          await prisma.repositoryMaterialGenerationPointer.count({
            where: { projectId, projectRepositoryLinkId: linkB.id },
          }),
          0,
        );
      } finally {
        await prisma.$disconnect();
      }
    } finally {
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
      await raw.end().catch(() => undefined);
    }
  },
);
