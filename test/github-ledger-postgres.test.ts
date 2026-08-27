import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, ProjectRepositoryRole } from "@prisma/client";
import { Client } from "pg";
import {
  GITHUB_SOFT_EXCLUDE_CLASSES,
  GitHubLedgerError,
  createGitHubRepositoryLedgerService,
} from "@/lib/github";

const execFile = promisify(execFileCallback);
const repositoryRoot = process.cwd();
const databaseName = "ai_project_os_github_ledger_test";
const databasePort = "56432";
const configuredUrl = process.env.GITHUB_LEDGER_TEST_DATABASE_URL;
const gate = process.env.GITHUB_LEDGER_POSTGRES_GATE;
const hasUrl = typeof configuredUrl === "string" && configuredUrl.length > 0;
const shouldRun = hasUrl && gate === "1";

const projectId = "11111111-1111-4111-8111-111111111111";
const otherProjectId = "22222222-2222-4222-8222-222222222222";
const concurrentProjectId = "33333333-3333-4333-8333-333333333333";

const repositoryA = Object.freeze({
  repositoryId: 1_000_001,
  nodeId: "R_SAFE_A",
  owner: "acme",
  name: "application",
  fullName: "acme/application",
  private: true,
  archived: false,
  disabled: false,
  defaultBranch: "main",
});

const repositoryB = Object.freeze({
  repositoryId: 1_000_002,
  nodeId: "R_SAFE_B",
  owner: "acme",
  name: "infrastructure",
  fullName: "acme/infrastructure",
  private: true,
  archived: false,
  disabled: false,
  defaultBranch: "main",
});

function repositoryConfig(
  requiredForProjectSnapshot: boolean,
  includeRoots: readonly string[],
) {
  return Object.freeze({
    role: requiredForProjectSnapshot
      ? ProjectRepositoryRole.application
      : ProjectRepositoryRole.infrastructure,
    requiredForProjectSnapshot,
    trackedRef: "refs/heads/main",
    codeEnabled: true,
    metadataEnabled: true,
    readmeEnabled: true,
    markdownEnabled: false,
    issuesEnabled: false,
    pullRequestsEnabled: false,
    releasesEnabled: false,
    includeRoots,
    softExcludePatterns: [...GITHUB_SOFT_EXCLUDE_CLASSES],
  });
}

function validateDisposableUrl(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("GITHUB_LEDGER_TEST_DATABASE_URL_INVALID");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("GITHUB_LEDGER_TEST_DATABASE_URL_INVALID");
  }
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname.toLowerCase()) ||
    parsed.port !== databasePort ||
    parsed.pathname !== `/${databaseName}` ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error("GITHUB_LEDGER_TEST_DATABASE_URL_INVALID");
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
  "GitHub ledger PostgreSQL gate requires an explicit disposable target",
  { skip: !hasUrl || gate === "1" },
  () => {
    throw new Error("GITHUB_LEDGER_POSTGRES_GATE must equal 1");
  },
);

test(
  "multi-repository ledger is isolated, versioned and atomically publishable",
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

      const adapter = new PrismaPg({ connectionString: url });
      const prisma = new PrismaClient({ adapter });
      try {
        await prisma.project.createMany({
          data: [
            { id: projectId, name: "GitHub ledger project", slug: "github-ledger-project" },
            {
              id: otherProjectId,
              name: "Other GitHub ledger project",
              slug: "other-github-ledger-project",
            },
            {
              id: concurrentProjectId,
              name: "Concurrent GitHub ledger project",
              slug: "concurrent-github-ledger-project",
            },
          ],
        });

        const service = createGitHubRepositoryLedgerService({ db: prisma });
        const requiredConfigV1 = repositoryConfig(true, ["README.md", "src"]);
        const optionalConfig = repositoryConfig(false, ["infra"]);

        const linkAInitial = await service.connect({
          projectId,
          repository: repositoryA,
          config: requiredConfigV1,
        });
        const linkB = await service.connect({
          projectId,
          repository: repositoryB,
          config: optionalConfig,
        });
        const otherProjectLink = await service.connect({
          projectId: otherProjectId,
          repository: repositoryA,
          config: requiredConfigV1,
        });

        assert.notEqual(linkAInitial.id, linkB.id);
        assert.notEqual(linkAInitial.id, otherProjectLink.id);
        assert.equal(await prisma.gitHubRepository.count(), 2);
        assert.equal(await prisma.gitHubConnection.count(), 2);
        assert.equal(await prisma.projectRepositoryLink.count({ where: { projectId } }), 2);
        assert.equal(await prisma.projectRepositoryLink.count({ where: { projectId: otherProjectId } }), 1);

        const concurrentLinks = await Promise.all([
          service.connect({
            projectId: concurrentProjectId,
            repository: repositoryB,
            config: requiredConfigV1,
          }),
          service.connect({
            projectId: concurrentProjectId,
            repository: repositoryB,
            config: requiredConfigV1,
          }),
        ]);
        assert.equal(concurrentLinks[0]?.id, concurrentLinks[1]?.id);
        assert.equal(
          await prisma.projectRepositoryLink.count({ where: { projectId: concurrentProjectId } }),
          1,
        );
        assert.equal(
          await prisma.projectRepositoryLinkConfigVersion.count({
            where: { projectId: concurrentProjectId },
          }),
          1,
        );

        const replayed = await service.connect({
          projectId,
          repository: repositoryA,
          config: requiredConfigV1,
        });
        assert.equal(replayed.id, linkAInitial.id);
        assert.equal(replayed.config.version, 1);
        assert.equal(
          await prisma.projectRepositoryLinkConfigVersion.count({ where: { projectId } }),
          2,
        );

        const requiredConfigV2 = repositoryConfig(true, ["docs", "src"]);
        const reconfigured = await service.connect({
          projectId,
          repository: repositoryA,
          config: requiredConfigV2,
        });
        assert.equal(reconfigured.id, linkAInitial.id);
        assert.equal(reconfigured.config.version, 2);
        assert.equal(reconfigured.effectivePolicyVersion, 2);

        const disabled = await service.disable({ projectId, linkId: reconfigured.id });
        assert.equal(disabled.status, "disabled");
        assert.equal(disabled.eligible, false);
        assert.equal(disabled.effectivePolicyVersion, 3);

        const reenabled = await service.connect({
          projectId,
          repository: repositoryA,
          config: requiredConfigV2,
        });
        assert.equal(reenabled.status, "active");
        assert.equal(reenabled.config.version, 3);
        assert.equal(reenabled.effectivePolicyVersion, 4);
        assert.equal(reenabled.config.effectivePolicyVersion, 4);
        assert.equal((await service.list(projectId)).length, 2);

        await expectRejected(() =>
          prisma.projectRepositoryLinkConfigVersion.update({
            where: {
              projectId_projectRepositoryLinkId_version: {
                projectId,
                projectRepositoryLinkId: reenabled.id,
                version: 1,
              },
            },
            data: { trackedRef: "refs/heads/forged" },
          }),
        );

        const fileA = await prisma.repositoryFile.create({
          data: {
            projectId,
            projectRepositoryLinkId: reenabled.id,
            normalizedPath: "src/index.ts",
          },
        });
        const contentA = "hello\n";
        const revisionA = await prisma.repositoryFileRevision.create({
          data: {
            projectId,
            projectRepositoryLinkId: reenabled.id,
            repositoryFileId: fileA.id,
            blobOid: "1".repeat(40),
            contentText: contentA,
            contentHash: "2".repeat(64),
            contentBytes: Buffer.byteLength(contentA, "utf8"),
            lineCount: 2,
            scannerVersion: "github-code-scanner:v1",
            scannerFingerprint: "3".repeat(64),
          },
        });
        await expectRejected(() =>
          prisma.repositoryFileRevision.create({
            data: {
              projectId,
              projectRepositoryLinkId: linkB.id,
              repositoryFileId: fileA.id,
              blobOid: "4".repeat(40),
              contentText: contentA,
              contentHash: "5".repeat(64),
              contentBytes: Buffer.byteLength(contentA, "utf8"),
              lineCount: 2,
              scannerVersion: "github-code-scanner:v1",
              scannerFingerprint: "3".repeat(64),
            },
          }),
        );

        const batch = await prisma.projectScanBatch.create({
          data: {
            projectId,
            requiredManifestFingerprint: "6".repeat(64),
            expectedRequiredLinkCount: 1,
            expectedOptionalLinkCount: 1,
          },
        });
        await prisma.projectScanBatchEntry.createMany({
          data: [
            {
              projectId,
              projectScanBatchId: batch.id,
              projectRepositoryLinkId: reenabled.id,
              linkConfigVersion: 3,
              requiredForProjectSnapshot: true,
              effectivePolicyVersion: 4,
            },
            {
              projectId,
              projectScanBatchId: batch.id,
              projectRepositoryLinkId: linkB.id,
              linkConfigVersion: 1,
              requiredForProjectSnapshot: false,
              effectivePolicyVersion: 1,
            },
          ],
        });
        await expectRejected(() =>
          prisma.projectScanBatch.create({
            data: {
              projectId,
              requiredManifestFingerprint: "7".repeat(64),
              expectedRequiredLinkCount: 1,
              expectedOptionalLinkCount: 1,
            },
          }),
        );
        await prisma.projectScanBatch.update({
          where: { id: batch.id },
          data: {
            status: "partialOptional",
            completedRequiredLinkCount: 1,
            completedOptionalLinkCount: 0,
            completedAt: new Date(),
          },
        });
        const releasedBatch = await prisma.projectScanBatch.create({
          data: {
            projectId,
            requiredManifestFingerprint: "7".repeat(64),
            expectedRequiredLinkCount: 1,
            expectedOptionalLinkCount: 1,
          },
        });
        await prisma.projectScanBatch.update({
          where: { id: releasedBatch.id },
          data: { status: "cancelled", completedAt: new Date() },
        });

        const failedRun = await prisma.repoCodeScanRun.create({
          data: {
            projectId,
            projectRepositoryLinkId: reenabled.id,
            linkConfigVersion: 3,
            expectedEffectivePolicyVersion: 4,
            operationKey: "8".repeat(64),
          },
        });
        await expectRejected(() =>
          prisma.repoCodeScanRun.create({
            data: {
              projectId,
              projectRepositoryLinkId: reenabled.id,
              projectScanBatchId: batch.id,
              linkConfigVersion: 3,
              expectedEffectivePolicyVersion: 4,
              operationKey: "9".repeat(64),
            },
          }),
        );
        await prisma.repoCodeScanRun.update({
          where: { id: failedRun.id },
          data: {
            status: "failed",
            stage: "terminal",
            failureCode: "TEST_FAILURE",
            completedAt: new Date(),
          },
        });

        const successfulRunA = await prisma.repoCodeScanRun.create({
          data: {
            projectId,
            projectRepositoryLinkId: reenabled.id,
            projectScanBatchId: batch.id,
            linkConfigVersion: 3,
            expectedEffectivePolicyVersion: 4,
            operationKey: "9".repeat(64),
          },
        });
        await prisma.repoCodeScanRun.update({
          where: { id: successfulRunA.id },
          data: { status: "running", stage: "discovering" },
        });
        await prisma.repoCodeScanRun.update({
          where: { id: successfulRunA.id },
          data: {
            status: "succeeded",
            stage: "terminal",
            frozenCommitSha: "a".repeat(40),
            rootTreeSha: "b".repeat(40),
            requestCount: 4,
            visitedTreeEntryCount: 2,
            discoveredFileCount: 1,
            decodedTextBytes: Buffer.byteLength(contentA, "utf8"),
            completedAt: new Date(),
          },
        });

        const generationA = await prisma.repositoryCodeGeneration.create({
          data: {
            projectId,
            projectRepositoryLinkId: reenabled.id,
            linkConfigVersion: 3,
            repoCodeScanRunId: successfulRunA.id,
            generationKey: "c".repeat(64),
            capturedGitHubRepositoryId: BigInt(repositoryA.repositoryId),
            capturedFullName: repositoryA.fullName,
            frozenCommitSha: "a".repeat(40),
            rootTreeSha: "b".repeat(40),
            scanScopeFingerprint: reenabled.config.scanScopeFingerprint,
            scannerVersion: "github-code-scanner:v1",
            scannerFingerprint: "3".repeat(64),
            effectivePolicyVersion: 4,
            manifestFingerprint: "d".repeat(64),
            exclusionManifest: [],
            modelTransferScanResult: "passed",
            securityFindingManifest: [],
            securityFindingCount: 0,
            fileCount: 1,
            decodedTextBytes: Buffer.byteLength(contentA, "utf8"),
          },
        });
        await expectRejected(() =>
          prisma.repositoryCodeGenerationPointer.create({
            data: {
              projectId,
              projectRepositoryLinkId: reenabled.id,
              repositoryCodeGenerationId: generationA.id,
              linkConfigVersion: 3,
              effectivePolicyVersion: 4,
            },
          }),
        );
        await expectRejected(() =>
          prisma.repositoryCodeGenerationEntry.create({
            data: {
              projectId,
              projectRepositoryLinkId: reenabled.id,
              repositoryCodeGenerationId: generationA.id,
              repositoryFileRevisionId: revisionA.id,
              ordinal: 0,
              normalizedPath: "src/forged.ts",
              mode: "100644",
              blobOid: revisionA.blobOid,
              contentHash: revisionA.contentHash,
              contentBytes: revisionA.contentBytes,
              lineCount: revisionA.lineCount,
            },
          }),
        );
        await prisma.repositoryCodeGenerationEntry.create({
          data: {
            projectId,
            projectRepositoryLinkId: reenabled.id,
            repositoryCodeGenerationId: generationA.id,
            repositoryFileRevisionId: revisionA.id,
            ordinal: 0,
            normalizedPath: fileA.normalizedPath,
            mode: "100644",
            blobOid: revisionA.blobOid,
            contentHash: revisionA.contentHash,
            contentBytes: revisionA.contentBytes,
            lineCount: revisionA.lineCount,
          },
        });
        await expectRejected(() =>
          prisma.repositoryCodeGenerationEntry.create({
            data: {
              projectId,
              projectRepositoryLinkId: linkB.id,
              repositoryCodeGenerationId: generationA.id,
              repositoryFileRevisionId: revisionA.id,
              ordinal: 0,
              normalizedPath: fileA.normalizedPath,
              mode: "100644",
              blobOid: revisionA.blobOid,
              contentHash: revisionA.contentHash,
              contentBytes: revisionA.contentBytes,
              lineCount: revisionA.lineCount,
            },
          }),
        );
        await prisma.repositoryCodeGeneration.update({
          where: { id: generationA.id },
          data: { status: "codeReady", completedAt: new Date() },
        });
        await prisma.repositoryCodeGenerationPointer.create({
          data: {
            projectId,
            projectRepositoryLinkId: reenabled.id,
            repositoryCodeGenerationId: generationA.id,
            linkConfigVersion: 3,
            effectivePolicyVersion: 4,
          },
        });

        const fileB = await prisma.repositoryFile.create({
          data: {
            projectId,
            projectRepositoryLinkId: linkB.id,
            normalizedPath: "infra/main.tf",
          },
        });
        const contentB = "terraform {}\n";
        const revisionB = await prisma.repositoryFileRevision.create({
          data: {
            projectId,
            projectRepositoryLinkId: linkB.id,
            repositoryFileId: fileB.id,
            blobOid: "e".repeat(40),
            contentText: contentB,
            contentHash: "f".repeat(64),
            contentBytes: Buffer.byteLength(contentB, "utf8"),
            lineCount: 2,
            scannerVersion: "github-code-scanner:v1",
            scannerFingerprint: "3".repeat(64),
          },
        });
        const successfulRunB = await prisma.repoCodeScanRun.create({
          data: {
            projectId,
            projectRepositoryLinkId: linkB.id,
            projectScanBatchId: batch.id,
            linkConfigVersion: 1,
            expectedEffectivePolicyVersion: 1,
            operationKey: "1".repeat(64),
          },
        });
        await prisma.repoCodeScanRun.update({
          where: { id: successfulRunB.id },
          data: { status: "running", stage: "discovering" },
        });
        await prisma.repoCodeScanRun.update({
          where: { id: successfulRunB.id },
          data: {
            status: "succeeded",
            stage: "terminal",
            frozenCommitSha: "2".repeat(40),
            rootTreeSha: "3".repeat(40),
            requestCount: 4,
            visitedTreeEntryCount: 2,
            discoveredFileCount: 1,
            decodedTextBytes: Buffer.byteLength(contentB, "utf8"),
            completedAt: new Date(),
          },
        });
        const generationB = await prisma.repositoryCodeGeneration.create({
          data: {
            projectId,
            projectRepositoryLinkId: linkB.id,
            linkConfigVersion: 1,
            repoCodeScanRunId: successfulRunB.id,
            generationKey: "4".repeat(64),
            capturedGitHubRepositoryId: BigInt(repositoryB.repositoryId),
            capturedFullName: repositoryB.fullName,
            frozenCommitSha: "2".repeat(40),
            rootTreeSha: "3".repeat(40),
            scanScopeFingerprint: linkB.config.scanScopeFingerprint,
            scannerVersion: "github-code-scanner:v1",
            scannerFingerprint: "3".repeat(64),
            effectivePolicyVersion: 1,
            manifestFingerprint: "5".repeat(64),
            exclusionManifest: [],
            modelTransferScanResult: "passed",
            securityFindingManifest: [],
            securityFindingCount: 0,
            fileCount: 1,
            decodedTextBytes: Buffer.byteLength(contentB, "utf8"),
          },
        });
        await prisma.repositoryCodeGenerationEntry.create({
          data: {
            projectId,
            projectRepositoryLinkId: linkB.id,
            repositoryCodeGenerationId: generationB.id,
            repositoryFileRevisionId: revisionB.id,
            ordinal: 0,
            normalizedPath: fileB.normalizedPath,
            mode: "100644",
            blobOid: revisionB.blobOid,
            contentHash: revisionB.contentHash,
            contentBytes: revisionB.contentBytes,
            lineCount: revisionB.lineCount,
          },
        });
        await prisma.repositoryCodeGeneration.update({
          where: { id: generationB.id },
          data: { status: "codeReady", completedAt: new Date() },
        });
        await prisma.repositoryCodeGenerationPointer.create({
          data: {
            projectId,
            projectRepositoryLinkId: linkB.id,
            repositoryCodeGenerationId: generationB.id,
            linkConfigVersion: 1,
            effectivePolicyVersion: 1,
          },
        });

        const snapshot = await prisma.projectCodeSnapshot.create({
          data: {
            projectId,
            projectScanBatchId: batch.id,
            manifestFingerprint: "6".repeat(64),
            requiredLinkCount: 1,
          },
        });
        await expectRejected(() =>
          prisma.projectCodeSnapshotEntry.create({
            data: {
              projectId,
              projectCodeSnapshotId: snapshot.id,
              projectRepositoryLinkId: linkB.id,
              linkConfigVersion: 1,
              requiredForProjectSnapshot: false,
              effectivePolicyVersion: 1,
              repositoryCodeGenerationId: generationB.id,
              frozenCommitSha: generationB.frozenCommitSha,
              generationManifestFingerprint: generationB.manifestFingerprint,
            },
          }),
        );
        await prisma.projectCodeSnapshotEntry.create({
          data: {
            projectId,
            projectCodeSnapshotId: snapshot.id,
            projectRepositoryLinkId: reenabled.id,
            linkConfigVersion: 3,
            requiredForProjectSnapshot: true,
            effectivePolicyVersion: 4,
            repositoryCodeGenerationId: generationA.id,
            frozenCommitSha: generationA.frozenCommitSha,
            generationManifestFingerprint: generationA.manifestFingerprint,
          },
        });
        await prisma.projectCodeSnapshot.update({
          where: { id: snapshot.id },
          data: { status: "complete", completedAt: new Date() },
        });
        await prisma.projectCodeSnapshotPointer.create({
          data: { projectId, projectCodeSnapshotId: snapshot.id },
        });

        const published = await prisma.projectCodeSnapshotPointer.findUnique({
          where: { projectId },
          include: { snapshot: { include: { entries: true } } },
        });
        assert.equal(published?.snapshot.status, "complete");
        assert.equal(published?.snapshot.entries.length, 1);
        assert.equal(published?.snapshot.entries[0]?.projectRepositoryLinkId, reenabled.id);
        assert.equal(published?.snapshot.entries[0]?.repositoryCodeGenerationId, generationA.id);

        const unlinked = await service.unlink({ projectId, linkId: linkB.id });
        assert.equal(unlinked.status, "unlinked");
        assert.equal(unlinked.eligible, false);
        await assert.rejects(
          () => service.connect({ projectId, repository: repositoryB, config: optionalConfig }),
          (error: unknown) =>
            error instanceof GitHubLedgerError && error.code === "GITHUB_LINK_UNLINKED",
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
