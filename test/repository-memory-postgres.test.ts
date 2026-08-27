import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  AiOperation,
  PrismaClient,
  ProjectRepositoryRole,
} from "@prisma/client";
import { Client } from "pg";
import {
  MODEL_TRANSFER_CONSENT_VERSION,
  createProjectAiConfigService,
} from "@/lib/ai-memory";
import {
  GITHUB_READ_ONLY_CLIENT_VERSION,
  GITHUB_SOFT_EXCLUDE_CLASSES,
  REPOSITORY_MODEL_TRANSFER_CONSENT_VERSION,
  RepositoryCodeSearchError,
  RepositoryModelGrantError,
  createGitHubCodeScanService,
  createGitHubRepositoryLedgerService,
  createRepositoryCodeSearchService,
  createRepositoryModelGrantService,
  type GitHubReadOnlyClient,
  type VerifiedGitHubRepository,
} from "@/lib/github";
import { hashSourceContent } from "@/lib/source";

const execFile = promisify(execFileCallback);
const repositoryRoot = process.cwd();
const databaseName = "ai_project_os_repository_memory_test";
const databasePort = "56432";
const configuredUrl = process.env.REPOSITORY_MEMORY_TEST_DATABASE_URL;
const gate = process.env.REPOSITORY_MEMORY_POSTGRES_GATE;
const hasUrl = typeof configuredUrl === "string" && configuredUrl.length > 0;
const shouldRun = hasUrl && gate === "1";

const projectAId = "11111111-1111-4111-8111-111111111111";
const projectBId = "22222222-2222-4222-8222-222222222222";
const sourceId = "33333333-3333-4333-8333-333333333333";
const safeRepository: VerifiedGitHubRepository = Object.freeze({
  repositoryId: 3_000_001,
  nodeId: "R_MEMORY_SAFE",
  owner: "acme",
  name: "memory-core",
  fullName: "acme/memory-core",
  private: true,
  archived: false,
  disabled: false,
  defaultBranch: "main",
});
const piiRepository: VerifiedGitHubRepository = Object.freeze({
  repositoryId: 3_000_002,
  nodeId: "R_MEMORY_PII",
  owner: "acme",
  name: "memory-infra",
  fullName: "acme/memory-infra",
  private: true,
  archived: false,
  disabled: false,
  defaultBranch: "main",
});

type RepositoryFixture = Readonly<{
  repository: VerifiedGitHubRepository;
  commitSha: string;
  rootTreeSha: string;
  directoryTreeSha: string;
  blobSha: string;
  includeRoot: string;
  fileName: string;
  content: string;
}>;

const fixtures: readonly RepositoryFixture[] = Object.freeze([
  Object.freeze({
    repository: safeRepository,
    commitSha: "a".repeat(40),
    rootTreeSha: "b".repeat(40),
    directoryTreeSha: "c".repeat(40),
    blobSha: "d".repeat(40),
    includeRoot: "src",
    fileName: "checksum.ts",
    content: [
      "export function calculateMemoryChecksum(input: string): string {",
      '  return `atlas_memory_${input}`;',
      "}",
      "",
    ].join("\n"),
  }),
  Object.freeze({
    repository: piiRepository,
    commitSha: "1".repeat(40),
    rootTreeSha: "2".repeat(40),
    directoryTreeSha: "3".repeat(40),
    blobSha: "4".repeat(40),
    includeRoot: "infra",
    fileName: "alerts.ts",
    content: [
      'export const OptionalInfraBeacon = "nebula_guardrail";',
      'export const supportContact = "release.owner@example.com";',
      "",
    ].join("\n"),
  }),
]);

function validateDisposableUrl(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("REPOSITORY_MEMORY_TEST_DATABASE_URL_INVALID");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("REPOSITORY_MEMORY_TEST_DATABASE_URL_INVALID");
  }
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname.toLowerCase()) ||
    parsed.port !== databasePort ||
    parsed.pathname !== `/${databaseName}` ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error("REPOSITORY_MEMORY_TEST_DATABASE_URL_INVALID");
  }
  return value;
}

function repositoryConfig(
  role: ProjectRepositoryRole,
  requiredForProjectSnapshot: boolean,
  includeRoot: string,
) {
  return {
    role,
    requiredForProjectSnapshot,
    trackedRef: "refs/heads/main",
    codeEnabled: true,
    metadataEnabled: true,
    readmeEnabled: true,
    markdownEnabled: false,
    issuesEnabled: false,
    pullRequestsEnabled: false,
    releasesEnabled: false,
    includeRoots: [includeRoot],
    softExcludePatterns: [...GITHUB_SOFT_EXCLUDE_CLASSES],
  };
}

function fixtureByRepository(name: string): RepositoryFixture {
  const fixture = fixtures.find((candidate) => candidate.repository.name === name);
  if (fixture === undefined) throw new Error("UNEXPECTED_REPOSITORY");
  return fixture;
}

function fixtureClient(): GitHubReadOnlyClient {
  return Object.freeze({
    version: GITHUB_READ_ONLY_CLIENT_VERSION,
    async getRepository(input: Readonly<{ owner: string; repository: string }>) {
      return fixtureByRepository(input.repository).repository;
    },
    async getReference(input: Readonly<{
      owner: string;
      repository: string;
      trackedRef: string;
    }>) {
      const fixture = fixtureByRepository(input.repository);
      return Object.freeze({ ref: input.trackedRef, commitSha: fixture.commitSha });
    },
    async getCommit(input: Readonly<{
      owner: string;
      repository: string;
      commitSha: string;
    }>) {
      const fixture = fixtureByRepository(input.repository);
      if (input.commitSha !== fixture.commitSha) throw new Error("UNEXPECTED_COMMIT");
      return Object.freeze({ commitSha: input.commitSha, treeSha: fixture.rootTreeSha });
    },
    async getTree(input: Readonly<{
      owner: string;
      repository: string;
      treeSha: string;
    }>) {
      const fixture = fixtureByRepository(input.repository);
      if (input.treeSha === fixture.rootTreeSha) {
        return Object.freeze({
          treeSha: fixture.rootTreeSha,
          truncated: false,
          entries: Object.freeze([{
            path: fixture.includeRoot,
            mode: "040000" as const,
            type: "tree" as const,
            sha: fixture.directoryTreeSha,
            size: null,
          }]),
        });
      }
      if (input.treeSha === fixture.directoryTreeSha) {
        return Object.freeze({
          treeSha: fixture.directoryTreeSha,
          truncated: false,
          entries: Object.freeze([{
            path: fixture.fileName,
            mode: "100644" as const,
            type: "blob" as const,
            sha: fixture.blobSha,
            size: Buffer.byteLength(fixture.content, "utf8"),
          }]),
        });
      }
      throw new Error("UNEXPECTED_TREE");
    },
    async getBlob(input: Readonly<{
      owner: string;
      repository: string;
      blobSha: string;
    }>) {
      const fixture = fixtures.find((candidate) => candidate.blobSha === input.blobSha);
      if (fixture === undefined) throw new Error("UNEXPECTED_BLOB");
      const bytes = Buffer.from(fixture.content, "utf8");
      return Object.freeze({
        blobSha: fixture.blobSha,
        size: bytes.byteLength,
        encoding: "base64" as const,
        content: bytes.toString("base64"),
      });
    },
  });
}

async function expectGrantError(
  action: () => Promise<unknown>,
  code: RepositoryModelGrantError["code"],
): Promise<void> {
  await assert.rejects(
    action,
    (error: unknown) => error instanceof RepositoryModelGrantError && error.code === code,
  );
}

async function expectSearchError(
  action: () => Promise<unknown>,
  code: RepositoryCodeSearchError["code"],
): Promise<void> {
  await assert.rejects(
    action,
    (error: unknown) => error instanceof RepositoryCodeSearchError && error.code === code,
  );
}

test(
  "repository memory PostgreSQL gate requires an explicit disposable target",
  { skip: !hasUrl || gate === "1" },
  () => {
    throw new Error("REPOSITORY_MEMORY_POSTGRES_GATE must equal 1");
  },
);

test(
  "repository grants and lexical search preserve scan, scope, and project boundaries",
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
            { id: projectAId, name: "Repository memory A", slug: "repository-memory-a" },
            { id: projectBId, name: "Repository memory B", slug: "repository-memory-b" },
          ],
        });
        const sourceContent = "Approved local project charter for repository memory.";
        const sourceHash = hashSourceContent(sourceContent);
        await prisma.projectSource.create({
          data: {
            id: sourceId,
            projectId: projectAId,
            kind: "manual",
            contentText: sourceContent,
            contentHash: sourceHash,
            manualContentDedupeKey: sourceHash,
          },
        });
        const aiConfig = createProjectAiConfigService({ db: prisma, environment: {} });
        const configured = await aiConfig.configure({
          projectId: projectAId,
          sourceIds: [sourceId],
          consentVersion: MODEL_TRANSFER_CONSENT_VERSION,
          acknowledgeExternalModelTransfer: true,
        });
        assert.equal(configured.configured, true);
        assert.equal(configured.operations.length, 5);

        const ledger = createGitHubRepositoryLedgerService({ db: prisma });
        const requiredLink = await ledger.connect({
          projectId: projectAId,
          repository: safeRepository,
          config: repositoryConfig(ProjectRepositoryRole.application, true, "src"),
        });
        const optionalLink = await ledger.connect({
          projectId: projectAId,
          repository: piiRepository,
          config: repositoryConfig(ProjectRepositoryRole.infrastructure, false, "infra"),
        });
        const scanner = createGitHubCodeScanService({ db: prisma, client: fixtureClient() });
        const scanned = await scanner.scanProject(projectAId);
        assert.equal(scanned.status, "succeeded");
        assert.equal(scanned.completedRequiredLinkCount, 1);
        assert.equal(scanned.completedOptionalLinkCount, 1);

        const safeGeneration = await prisma.repositoryCodeGeneration.findFirstOrThrow({
          where: { projectId: projectAId, projectRepositoryLinkId: requiredLink.id },
        });
        const piiGeneration = await prisma.repositoryCodeGeneration.findFirstOrThrow({
          where: { projectId: projectAId, projectRepositoryLinkId: optionalLink.id },
        });
        assert.equal(safeGeneration.modelTransferScanResult, "passed");
        assert.equal(piiGeneration.modelTransferScanResult, "blocked");
        assert.deepEqual(piiGeneration.securityFindingManifest, [
          { normalizedPath: "infra/alerts.ts", categories: ["EMAIL_ADDRESS"] },
        ]);
        const projectSnapshot = await prisma.projectCodeSnapshotPointer.findUniqueOrThrow({
          where: { projectId: projectAId },
          include: { snapshot: { include: { entries: true } } },
        });
        assert.deepEqual(
          projectSnapshot.snapshot.entries.map((entry) => entry.projectRepositoryLinkId),
          [requiredLink.id],
        );

        const grantService = createRepositoryModelGrantService({ db: prisma });
        const issued = await grantService.issue({
          projectId: projectAId,
          projectRepositoryLinkId: requiredLink.id,
          operations: [AiOperation.embedding],
          consentVersion: REPOSITORY_MODEL_TRANSFER_CONSENT_VERSION,
          acknowledgeExternalModelTransfer: true,
          acknowledgeProcessingRights: true,
        });
        assert.equal(issued.eligibleCodeGeneration?.id, safeGeneration.id);
        assert.equal(issued.grants.length, 1);
        assert.equal(issued.grants[0]?.operation, AiOperation.embedding);
        const idempotent = await grantService.issue({
          projectId: projectAId,
          projectRepositoryLinkId: requiredLink.id,
          operations: [AiOperation.embedding],
          consentVersion: REPOSITORY_MODEL_TRANSFER_CONSENT_VERSION,
          acknowledgeExternalModelTransfer: true,
          acknowledgeProcessingRights: true,
        });
        assert.equal(idempotent.grants[0]?.id, issued.grants[0]?.id);
        await expectGrantError(
          () => grantService.issue({
            projectId: projectAId,
            projectRepositoryLinkId: optionalLink.id,
            operations: [AiOperation.embedding],
            consentVersion: REPOSITORY_MODEL_TRANSFER_CONSENT_VERSION,
            acknowledgeExternalModelTransfer: true,
            acknowledgeProcessingRights: true,
          }),
          "REPOSITORY_MODEL_GRANT_SCAN_BLOCKED",
        );

        const search = createRepositoryCodeSearchService({ db: prisma });
        const requiredResults = await search.search({
          projectId: projectAId,
          query: "calculateMemoryChecksum",
          scope: { kind: "project" },
        });
        assert.equal(requiredResults.mode, "lexical");
        assert.equal(requiredResults.scope.repositoryCount, 1);
        assert.equal(requiredResults.results.length, 1);
        assert.equal(
          requiredResults.results[0]?.citation.projectRepositoryLinkId,
          requiredLink.id,
        );
        assert.equal(
          requiredResults.results[0]?.citation.immutableRef,
          `acme/memory-core@${"a".repeat(40)}:src/checksum.ts#L1-L3`,
        );
        assert.match(requiredResults.results[0]?.citation.excerpt ?? "", /atlas_memory/);
        assert.deepEqual(
          await search.search({
            projectId: projectAId,
            query: "calculateMemoryChecksum",
            scope: { kind: "project" },
          }),
          requiredResults,
        );

        const optionalFromProject = await search.search({
          projectId: projectAId,
          query: "OptionalInfraBeacon",
          scope: { kind: "project" },
        });
        assert.equal(optionalFromProject.results.length, 0);
        const optionalExplicit = await search.search({
          projectId: projectAId,
          query: "OptionalInfraBeacon",
          scope: { kind: "repository", projectRepositoryLinkId: optionalLink.id },
        });
        assert.equal(optionalExplicit.results.length, 1);
        assert.equal(
          optionalExplicit.results[0]?.citation.projectRepositoryLinkId,
          optionalLink.id,
        );
        await prisma.projectRepositoryLink.update({
          where: { projectId_id: { projectId: projectAId, id: optionalLink.id } },
          data: { effectivePolicyVersion: { increment: 1 } },
        });
        await expectSearchError(
          () => search.search({
            projectId: projectAId,
            query: "OptionalInfraBeacon",
            scope: { kind: "repository", projectRepositoryLinkId: optionalLink.id },
          }),
          "REPOSITORY_CODE_SEARCH_SNAPSHOT_INELIGIBLE",
        );
        await expectSearchError(
          () => search.search({
            projectId: projectBId,
            query: "calculateMemoryChecksum",
            scope: { kind: "repository", projectRepositoryLinkId: requiredLink.id },
          }),
          "REPOSITORY_CODE_SEARCH_LINK_NOT_FOUND",
        );

        const unchangedConfig = await aiConfig.configure({
          projectId: projectAId,
          sourceIds: [sourceId],
          consentVersion: MODEL_TRANSFER_CONSENT_VERSION,
          acknowledgeExternalModelTransfer: true,
        });
        assert.equal(unchangedConfig.operations.length, 5);
        assert.equal((await grantService.getStatus({
          projectId: projectAId,
          projectRepositoryLinkId: requiredLink.id,
        })).grants.length, 1);

        await ledger.disable({ projectId: projectAId, linkId: requiredLink.id });
        await expectSearchError(
          () => search.search({
            projectId: projectAId,
            query: "calculateMemoryChecksum",
            scope: { kind: "project" },
          }),
          "REPOSITORY_CODE_SEARCH_SNAPSHOT_INELIGIBLE",
        );
        const ineligibleStatus = await grantService.getStatus({
          projectId: projectAId,
          projectRepositoryLinkId: requiredLink.id,
        });
        assert.equal(ineligibleStatus.eligibleCodeGeneration, null);
        assert.equal(ineligibleStatus.grants.length, 0);
        await grantService.revoke({
          projectId: projectAId,
          projectRepositoryLinkId: requiredLink.id,
        });
        assert.equal(
          await prisma.modelProcessingGrant.count({
            where: {
              projectId: projectAId,
              projectRepositoryLinkId: requiredLink.id,
              sourceKind: "repository_code",
              status: "revoked",
            },
          }),
          1,
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
