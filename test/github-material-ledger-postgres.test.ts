import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import test from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  ContentOriginScope,
  GitHubMaterialKind,
  PrismaClient,
  ProjectRepositoryRole,
  ProjectSourceKind,
} from "@prisma/client";
import {
  GITHUB_SOFT_EXCLUDE_CLASSES,
  createGitHubRepositoryLedgerService,
} from "@/lib/github";

const execFile = promisify(execFileCallback);
const repositoryRoot = process.cwd();
const databaseName = "ai_project_os_material_ledger_test";
const databasePort = "56432";
const configuredUrl = process.env.GITHUB_MATERIAL_TEST_DATABASE_URL;
const gate = process.env.GITHUB_MATERIAL_POSTGRES_GATE;
const hasUrl = typeof configuredUrl === "string" && configuredUrl.length > 0;
const shouldRun = hasUrl && gate === "1";

const projectId = "11111111-1111-4111-8111-111111111111";
const observedHeadCommitSha = "a".repeat(40);
const scannerVersion = "github-material-scanner:v1";
const scannerFingerprint = digest("github-material-scanner:v1");

const repositoryA = Object.freeze({
  repositoryId: 2_000_001,
  nodeId: "R_MATERIAL_A",
  owner: "acme",
  name: "application",
  fullName: "acme/application",
  private: true,
  archived: false,
  disabled: false,
  defaultBranch: "main",
});

const repositoryB = Object.freeze({
  repositoryId: 2_000_002,
  nodeId: "R_MATERIAL_B",
  owner: "acme",
  name: "infrastructure",
  fullName: "acme/infrastructure",
  private: true,
  archived: false,
  disabled: false,
  defaultBranch: "main",
});

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function validateDisposableUrl(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("GITHUB_MATERIAL_TEST_DATABASE_URL_INVALID");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("GITHUB_MATERIAL_TEST_DATABASE_URL_INVALID");
  }
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname.toLowerCase()) ||
    parsed.port !== databasePort ||
    parsed.pathname !== `/${databaseName}` ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error("GITHUB_MATERIAL_TEST_DATABASE_URL_INVALID");
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
    markdownPaths: ["docs/architecture.md"],
    issuesEnabled: true,
    pullRequestsEnabled: true,
    releasesEnabled: true,
    includeRoots: ["README.md", "src"],
    softExcludePatterns: [...GITHUB_SOFT_EXCLUDE_CLASSES],
  });
}

function materialManifest(input: Readonly<{
  ordinal: number;
  entryId: string;
  githubSourceVersionId: string;
  projectSourceId: string;
  materialKind: "repository_metadata";
  sourceContentHash: string;
  sourceContentBytes: number;
}>): string {
  return digest([
    input.ordinal.toString(),
    input.entryId,
    input.githubSourceVersionId,
    input.projectSourceId,
    input.materialKind,
    input.sourceContentHash,
    input.sourceContentBytes.toString(),
  ].join("\u001f"));
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
  "GitHub material ledger PostgreSQL gate requires an explicit disposable target",
  { skip: !hasUrl || gate === "1" },
  () => {
    throw new Error("GITHUB_MATERIAL_POSTGRES_GATE must equal 1");
  },
);

test(
  "repository material generations are isolated, immutable and CAS-published",
  { skip: !shouldRun ? "explicit disposable PostgreSQL gate is required" : false },
  async () => {
    const url = validateDisposableUrl(configuredUrl);
    const raw = new (await import("pg")).Client({
      connectionString: url,
      connectionTimeoutMillis: 5_000,
    });
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
          data: { id: projectId, name: "Material ledger", slug: "material-ledger" },
        });
        const service = createGitHubRepositoryLedgerService({ db: prisma });
        const linkA = await service.connect({
          projectId,
          repository: repositoryA,
          config: repositoryConfig(ProjectRepositoryRole.application),
        });
        const linkB = await service.connect({
          projectId,
          repository: repositoryB,
          config: repositoryConfig(ProjectRepositoryRole.infrastructure),
        });
        assert.deepEqual(linkA.config.markdownPaths, ["docs/architecture.md"]);

        const runA = await prisma.gitHubMaterialSyncRun.create({
          data: {
            projectId,
            projectRepositoryLinkId: linkA.id,
            linkConfigVersion: linkA.config.version,
            expectedEffectivePolicyVersion: linkA.effectivePolicyVersion,
            expectedActiveMaterialGenerationId: null,
            operationKey: digest("material-run-a"),
          },
        });
        await expectRejected(() =>
          prisma.gitHubMaterialSyncRun.create({
            data: {
              projectId,
              projectRepositoryLinkId: linkA.id,
              linkConfigVersion: linkA.config.version,
              expectedEffectivePolicyVersion: linkA.effectivePolicyVersion,
              expectedActiveMaterialGenerationId: null,
              operationKey: digest("material-run-a-concurrent"),
            },
          }),
        );
        const startedAt = new Date("2026-08-28T00:00:00.000Z");
        await prisma.gitHubMaterialSyncRun.update({
          where: { id: runA.id },
          data: { status: "running", stage: "freezing", startedAt },
        });
        await prisma.gitHubMaterialQuarantine.create({
          data: {
            projectId,
            projectRepositoryLinkId: linkA.id,
            githubMaterialSyncRunId: runA.id,
            materialKind: GitHubMaterialKind.issue,
            remoteIdentityFingerprint: digest("issue:7"),
            reasonCode: "secretDetected",
          },
        });

        const contentText = JSON.stringify({
          archived: false,
          defaultBranch: "main",
          disabled: false,
          fullName: repositoryA.fullName,
          private: true,
          repositoryId: repositoryA.repositoryId.toString(),
        });
        const sourceContentHash = digest(contentText);
        const sourceContentBytes = Buffer.byteLength(contentText, "utf8");
        const projectSourceId = randomUUID();
        const sourceRevisionKey = randomUUID();
        const sourceVersionId = randomUUID();
        const entryId = randomUUID();

        await prisma.projectSource.create({
          data: {
            id: projectSourceId,
            projectId,
            kind: ProjectSourceKind.github,
            originScope: ContentOriginScope.repository_link,
            projectRepositoryLinkId: linkA.id,
            sourceIdentity: randomUUID(),
            revisionKey: sourceRevisionKey,
            externalRef: "https://github.com/acme/application",
            contentText,
            contentHash: sourceContentHash,
            capturedAt: startedAt,
          },
        });
        const sourceVersion = await prisma.gitHubSourceVersion.create({
          data: {
            id: sourceVersionId,
            projectId,
            projectRepositoryLinkId: linkA.id,
            projectSourceId,
            sourceRevisionKey,
            materialKind: GitHubMaterialKind.repositoryMetadata,
            remoteIdentity: `repository:${repositoryA.repositoryId}`,
            remoteRevisionFingerprint: digest(`metadata:${contentText}`),
            capturedGitHubRepositoryId: BigInt(repositoryA.repositoryId),
            capturedFullName: repositoryA.fullName,
            observedHeadCommitSha,
            sourceContentHash,
            sourceContentBytes,
            capturedAt: startedAt,
          },
        });
        await expectRejected(() =>
          prisma.gitHubSourceVersion.create({
            data: {
              id: randomUUID(),
              projectId,
              projectRepositoryLinkId: linkB.id,
              projectSourceId,
              sourceRevisionKey,
              materialKind: GitHubMaterialKind.repositoryMetadata,
              remoteIdentity: `repository:${repositoryA.repositoryId}:forged`,
              remoteRevisionFingerprint: digest("forged-cross-link"),
              capturedGitHubRepositoryId: BigInt(repositoryA.repositoryId),
              capturedFullName: repositoryA.fullName,
              observedHeadCommitSha,
              sourceContentHash,
              sourceContentBytes,
              capturedAt: startedAt,
            },
          }),
        );

        const manifestFingerprint = materialManifest({
          ordinal: 0,
          entryId,
          githubSourceVersionId: sourceVersionId,
          projectSourceId,
          materialKind: "repository_metadata",
          sourceContentHash,
          sourceContentBytes,
        });
        const generationA = await prisma.repositoryMaterialGeneration.create({
          data: {
            projectId,
            projectRepositoryLinkId: linkA.id,
            linkConfigVersion: linkA.config.version,
            githubMaterialSyncRunId: runA.id,
            generationKey: digest("material-generation-a"),
            capturedGitHubRepositoryId: BigInt(repositoryA.repositoryId),
            capturedFullName: repositoryA.fullName,
            observedHeadCommitSha,
            effectivePolicyVersion: linkA.effectivePolicyVersion,
            manifestFingerprint,
            enabledClassManifest: { metadata: true },
            coverageManifest: { metadata: "complete" },
            scannerVersion,
            scannerFingerprint,
            sourceCount: 1,
            decodedTextBytes: sourceContentBytes,
          },
        });
        await expectRejected(() =>
          prisma.repositoryMaterialGeneration.update({
            where: { id: generationA.id },
            data: { status: "complete", completedAt: new Date() },
          }),
        );
        await expectRejected(() =>
          prisma.gitHubMaterialSyncRun.update({
            where: { id: runA.id },
            data: {
              status: "succeeded",
              stage: "terminal",
              observedHeadCommitSha,
              publishedSourceCount: 1,
              completedAt: new Date(),
            },
          }),
        );
        await expectRejected(() =>
          prisma.repositoryMaterialGenerationEntry.create({
            data: {
              id: randomUUID(),
              projectId,
              projectRepositoryLinkId: linkA.id,
              repositoryMaterialGenerationId: generationA.id,
              githubSourceVersionId: sourceVersionId,
              projectSourceId,
              ordinal: 0,
              materialKind: GitHubMaterialKind.repositoryMetadata,
              sourceContentHash: digest("forged-content"),
              sourceContentBytes,
            },
          }),
        );
        await prisma.repositoryMaterialGenerationEntry.create({
          data: {
            id: entryId,
            projectId,
            projectRepositoryLinkId: linkA.id,
            repositoryMaterialGenerationId: generationA.id,
            githubSourceVersionId: sourceVersionId,
            projectSourceId,
            ordinal: 0,
            materialKind: GitHubMaterialKind.repositoryMetadata,
            sourceContentHash,
            sourceContentBytes,
          },
        });
        await prisma.repositoryMaterialGeneration.update({
          where: { id: generationA.id },
          data: { status: "complete", completedAt: new Date() },
        });
        await prisma.gitHubMaterialSyncRun.update({
          where: { id: runA.id },
          data: {
            status: "succeeded",
            stage: "terminal",
            observedHeadCommitSha,
            requestCount: 3,
            fetchedObjectCount: 2,
            publishedSourceCount: 1,
            quarantineCount: 1,
            completedAt: new Date(),
          },
        });
        await prisma.repositoryMaterialGenerationPointer.create({
          data: {
            projectId,
            projectRepositoryLinkId: linkA.id,
            repositoryMaterialGenerationId: generationA.id,
            linkConfigVersion: linkA.config.version,
            effectivePolicyVersion: linkA.effectivePolicyVersion,
          },
        });
        await expectRejected(() =>
          prisma.gitHubMaterialSyncRun.update({
            where: { id: runA.id },
            data: { requestCount: 4 },
          }),
        );
        await expectRejected(() =>
          prisma.repositoryMaterialGeneration.update({
            where: { id: generationA.id },
            data: { completedAt: new Date("2030-01-01T00:00:00.000Z") },
          }),
        );
        await expectRejected(() =>
          prisma.gitHubSourceVersion.update({
            where: { id: sourceVersion.id },
            data: { remoteIdentity: "repository:mutated" },
          }),
        );
        await expectRejected(() =>
          prisma.gitHubMaterialQuarantine.create({
            data: {
              projectId,
              projectRepositoryLinkId: linkA.id,
              githubMaterialSyncRunId: runA.id,
              materialKind: GitHubMaterialKind.release,
              remoteIdentityFingerprint: digest("release:1"),
              reasonCode: "unsafeContent",
            },
          }),
        );

        async function createEmptyCompletedGeneration(label: string) {
          const activePointer = await prisma.repositoryMaterialGenerationPointer.findUniqueOrThrow({
            where: {
              projectId_projectRepositoryLinkId: {
                projectId,
                projectRepositoryLinkId: linkA.id,
              },
            },
          });
          const run = await prisma.gitHubMaterialSyncRun.create({
            data: {
              projectId,
              projectRepositoryLinkId: linkA.id,
              linkConfigVersion: linkA.config.version,
              expectedEffectivePolicyVersion: linkA.effectivePolicyVersion,
              expectedActiveMaterialGenerationId: activePointer.repositoryMaterialGenerationId,
              operationKey: digest(`material-run-${label}`),
            },
          });
          await prisma.gitHubMaterialSyncRun.update({
            where: { id: run.id },
            data: { status: "running", stage: "freezing", startedAt: new Date() },
          });
          await prisma.gitHubMaterialSyncRun.update({
            where: { id: run.id },
            data: { stage: "publishing" },
          });
          await expectRejected(() =>
            prisma.gitHubMaterialSyncRun.update({
              where: { id: run.id },
              data: { stage: "fetching" },
            }),
          );
          const generation = await prisma.repositoryMaterialGeneration.create({
            data: {
              projectId,
              projectRepositoryLinkId: linkA.id,
              linkConfigVersion: linkA.config.version,
              githubMaterialSyncRunId: run.id,
              generationKey: digest(`material-generation-${label}`),
              capturedGitHubRepositoryId: BigInt(repositoryA.repositoryId),
              capturedFullName: repositoryA.fullName,
              observedHeadCommitSha,
              effectivePolicyVersion: linkA.effectivePolicyVersion,
              manifestFingerprint: digest(""),
              enabledClassManifest: { metadata: true },
              coverageManifest: { metadata: "empty" },
              scannerVersion,
              scannerFingerprint,
              sourceCount: 0,
              decodedTextBytes: 0,
            },
          });
          await prisma.repositoryMaterialGeneration.update({
            where: { id: generation.id },
            data: { status: "complete", completedAt: new Date() },
          });
          await prisma.gitHubMaterialSyncRun.update({
            where: { id: run.id },
            data: {
              status: "succeeded",
              stage: "terminal",
              observedHeadCommitSha,
              completedAt: new Date(),
            },
          });
          return generation;
        }

        const generationB = await createEmptyCompletedGeneration("b");
        const generationC = await createEmptyCompletedGeneration("c");
        await prisma.repositoryMaterialGenerationPointer.update({
          where: {
            projectId_projectRepositoryLinkId: {
              projectId,
              projectRepositoryLinkId: linkA.id,
            },
          },
          data: { repositoryMaterialGenerationId: generationB.id },
        });
        await expectRejected(() =>
          prisma.repositoryMaterialGenerationPointer.update({
            where: {
              projectId_projectRepositoryLinkId: {
                projectId,
                projectRepositoryLinkId: linkA.id,
              },
            },
            data: { repositoryMaterialGenerationId: generationC.id },
          }),
        );
        const pointer = await prisma.repositoryMaterialGenerationPointer.findUniqueOrThrow({
          where: {
            projectId_projectRepositoryLinkId: {
              projectId,
              projectRepositoryLinkId: linkA.id,
            },
          },
          include: { generation: true },
        });
        assert.equal(pointer.repositoryMaterialGenerationId, generationB.id);
        assert.equal(pointer.generation.status, "complete");
        assert.equal(
          (await prisma.repositoryMaterialGeneration.findUniqueOrThrow({
            where: { id: generationA.id },
          })).status,
          "superseded",
        );

        const failedRun = await prisma.gitHubMaterialSyncRun.create({
          data: {
            projectId,
            projectRepositoryLinkId: linkA.id,
            linkConfigVersion: linkA.config.version,
            expectedEffectivePolicyVersion: linkA.effectivePolicyVersion,
            expectedActiveMaterialGenerationId: generationB.id,
            operationKey: digest("material-run-failed"),
          },
        });
        await prisma.gitHubMaterialSyncRun.update({
          where: { id: failedRun.id },
          data: { status: "running", stage: "freezing", startedAt: new Date() },
        });
        await prisma.gitHubMaterialSyncRun.update({
          where: { id: failedRun.id },
          data: { stage: "scanning" },
        });
        const failedGeneration = await prisma.repositoryMaterialGeneration.create({
          data: {
            projectId,
            projectRepositoryLinkId: linkA.id,
            linkConfigVersion: linkA.config.version,
            githubMaterialSyncRunId: failedRun.id,
            generationKey: digest("material-generation-failed"),
            capturedGitHubRepositoryId: BigInt(repositoryA.repositoryId),
            capturedFullName: repositoryA.fullName,
            observedHeadCommitSha,
            effectivePolicyVersion: linkA.effectivePolicyVersion,
            manifestFingerprint: digest(""),
            enabledClassManifest: { metadata: true },
            coverageManifest: { metadata: "failed" },
            scannerVersion,
            scannerFingerprint,
            sourceCount: 0,
            decodedTextBytes: 0,
          },
        });
        await expectRejected(() =>
          prisma.repositoryMaterialGeneration.update({
            where: { id: failedGeneration.id },
            data: { status: "failed", completedAt: new Date() },
          }),
        );
        await prisma.repositoryMaterialGeneration.update({
          where: { id: failedGeneration.id },
          data: {
            status: "failed",
            failureCode: "MATERIAL_SCAN_FAILED",
            completedAt: new Date(),
          },
        });
        await prisma.gitHubMaterialSyncRun.update({
          where: { id: failedRun.id },
          data: {
            status: "failed",
            stage: "terminal",
            failureCode: "MATERIAL_SCAN_FAILED",
            completedAt: new Date(),
          },
        });
        await expectRejected(() =>
          prisma.repositoryMaterialGeneration.update({
            where: { id: failedGeneration.id },
            data: { failureCode: "MUTATED_FAILURE" },
          }),
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
