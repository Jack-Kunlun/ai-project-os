import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, ProjectRepositoryRole } from "@prisma/client";
import { Client } from "pg";
import {
  GITHUB_READ_ONLY_CLIENT_VERSION,
  GITHUB_SOFT_EXCLUDE_CLASSES,
  GitHubCodeScanServiceError,
  createGitHubCodeScanService,
  createGitHubRepositoryLedgerService,
  type GitHubReadOnlyClient,
  type VerifiedGitHubRepository,
} from "@/lib/github";

const execFile = promisify(execFileCallback);
const repositoryRoot = process.cwd();
const databaseName = "ai_project_os_github_scan_test";
const databasePort = "56432";
const configuredUrl = process.env.GITHUB_SCAN_TEST_DATABASE_URL;
const gate = process.env.GITHUB_SCAN_POSTGRES_GATE;
const hasUrl = typeof configuredUrl === "string" && configuredUrl.length > 0;
const shouldRun = hasUrl && gate === "1";

const projectId = "11111111-1111-4111-8111-111111111111";
const repositoryA: VerifiedGitHubRepository = Object.freeze({
  repositoryId: 2_000_001,
  nodeId: "R_SCAN_A",
  owner: "acme",
  name: "application",
  fullName: "acme/application",
  private: true,
  archived: false,
  disabled: false,
  defaultBranch: "main",
});
const repositoryB: VerifiedGitHubRepository = Object.freeze({
  repositoryId: 2_000_002,
  nodeId: "R_SCAN_B",
  owner: "acme",
  name: "infrastructure",
  fullName: "acme/infrastructure",
  private: true,
  archived: false,
  disabled: false,
  defaultBranch: "main",
});

const commitA = "a".repeat(40);
const rootA = "b".repeat(40);
const treeASrc = "c".repeat(40);
const treeASrc2 = "d".repeat(40);
const blobA = "e".repeat(40);
const blobA2 = "f".repeat(40);
const commitBSecret = "1".repeat(40);
const rootBSecret = "2".repeat(40);
const treeBSecret = "3".repeat(40);
const blobBSecret = "4".repeat(40);
const commitBSafe = "5".repeat(40);
const rootBSafe = "6".repeat(40);
const treeBSafe = "7".repeat(40);
const blobBSafe = "8".repeat(40);

function validateDisposableUrl(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("GITHUB_SCAN_TEST_DATABASE_URL_INVALID");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("GITHUB_SCAN_TEST_DATABASE_URL_INVALID");
  }
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname.toLowerCase()) ||
    parsed.port !== databasePort ||
    parsed.pathname !== `/${databaseName}` ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error("GITHUB_SCAN_TEST_DATABASE_URL_INVALID");
  }
  return value;
}

function encoded(text: string) {
  const bytes = Buffer.from(text, "utf8");
  return { size: bytes.byteLength, content: bytes.toString("base64") };
}

function repositoryConfig(required: boolean, includeRoots: readonly string[]) {
  return {
    role: required ? ProjectRepositoryRole.application : ProjectRepositoryRole.infrastructure,
    requiredForProjectSnapshot: required,
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
  };
}

function mutableFixtureClient(): Readonly<{
  client: GitHubReadOnlyClient;
  useSafeRepositoryB(): void;
}> {
  let safeB = false;
  const contentA = 'export const ownerEmail = "owner@example.com";\n';
  const contentA2 = "export const restored = true;\n";
  const contentBSecret = 'password = "CorrectHorseBatteryStaple"\n';
  const contentBSafe = "terraform {}\n";
  const client: GitHubReadOnlyClient = Object.freeze({
    version: GITHUB_READ_ONLY_CLIENT_VERSION,
    async getRepository(input: Readonly<{ repository: string }>) {
      if (input.repository === repositoryA.name) return repositoryA;
      if (input.repository === repositoryB.name) return repositoryB;
      throw new Error("unexpected repository");
    },
    async getReference(input: Readonly<{ repository: string; trackedRef: string }>) {
      return Object.freeze({
        ref: input.trackedRef,
        commitSha: input.repository === repositoryA.name
          ? commitA
          : safeB
            ? commitBSafe
            : commitBSecret,
      });
    },
    async getCommit(input: Readonly<{ repository: string; commitSha: string }>) {
      const treeSha = input.repository === repositoryA.name
        ? rootA
        : input.commitSha === commitBSafe
          ? rootBSafe
          : rootBSecret;
      return Object.freeze({ commitSha: input.commitSha, treeSha });
    },
    async getTree(input: Readonly<{ repository: string; treeSha: string }>) {
      if (input.repository === repositoryA.name && input.treeSha === rootA) {
        return Object.freeze({
          treeSha: rootA,
          truncated: false,
          entries: Object.freeze([
            { path: "src", mode: "040000" as const, type: "tree" as const, sha: treeASrc, size: null },
            { path: "src2", mode: "040000" as const, type: "tree" as const, sha: treeASrc2, size: null },
          ]),
        });
      }
      if (input.repository === repositoryA.name && input.treeSha === treeASrc) {
        return Object.freeze({
          treeSha: treeASrc,
          truncated: false,
          entries: Object.freeze([
            { path: "index.ts", mode: "100644" as const, type: "blob" as const, sha: blobA, size: Buffer.byteLength(contentA) },
          ]),
        });
      }
      if (input.repository === repositoryA.name && input.treeSha === treeASrc2) {
        return Object.freeze({
          treeSha: treeASrc2,
          truncated: false,
          entries: Object.freeze([
            { path: "restored.ts", mode: "100644" as const, type: "blob" as const, sha: blobA2, size: Buffer.byteLength(contentA2) },
          ]),
        });
      }
      const root = safeB ? rootBSafe : rootBSecret;
      const child = safeB ? treeBSafe : treeBSecret;
      if (input.repository === repositoryB.name && input.treeSha === root) {
        return Object.freeze({
          treeSha: root,
          truncated: false,
          entries: Object.freeze([
            { path: "infra", mode: "040000" as const, type: "tree" as const, sha: child, size: null },
          ]),
        });
      }
      if (input.repository === repositoryB.name && input.treeSha === child) {
        const body = safeB ? contentBSafe : contentBSecret;
        return Object.freeze({
          treeSha: child,
          truncated: false,
          entries: Object.freeze([
            {
              path: "main.tf",
              mode: "100644" as const,
              type: "blob" as const,
              sha: safeB ? blobBSafe : blobBSecret,
              size: Buffer.byteLength(body),
            },
          ]),
        });
      }
      throw new Error("unexpected tree");
    },
    async getBlob(input: Readonly<{ blobSha: string }>) {
      let text: string;
      if (input.blobSha === blobA) text = contentA;
      else if (input.blobSha === blobA2) text = contentA2;
      else if (input.blobSha === blobBSecret) text = contentBSecret;
      else if (input.blobSha === blobBSafe) text = contentBSafe;
      else throw new Error("unexpected blob");
      const blob = encoded(text);
      return Object.freeze({
        blobSha: input.blobSha,
        size: blob.size,
        encoding: "base64" as const,
        content: blob.content,
      });
    },
  });
  return Object.freeze({
    client,
    useSafeRepositoryB() {
      safeB = true;
    },
  });
}

test(
  "GitHub code scan PostgreSQL gate requires an explicit disposable target",
  { skip: !hasUrl || gate === "1" },
  () => {
    throw new Error("GITHUB_SCAN_POSTGRES_GATE must equal 1");
  },
);

test(
  "frozen scans publish repository generations and only complete required project snapshots",
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
        await prisma.project.create({
          data: { id: projectId, name: "GitHub scan project", slug: "github-scan-project" },
        });
        const ledger = createGitHubRepositoryLedgerService({ db: prisma });
        const linkA = await ledger.connect({
          projectId,
          repository: repositoryA,
          config: repositoryConfig(true, ["src"]),
        });
        const linkB = await ledger.connect({
          projectId,
          repository: repositoryB,
          config: repositoryConfig(false, ["infra"]),
        });
        const fixture = mutableFixtureClient();
        const service = createGitHubCodeScanService({ db: prisma, client: fixture.client });

        const first = await service.scanProject(projectId);
        assert.equal(first.status, "partialOptional");
        assert.equal(first.completedRequiredLinkCount, 1);
        assert.equal(first.completedOptionalLinkCount, 0);
        assert.notEqual(first.projectCodeSnapshotId, null);
        assert.equal(first.runs.find((run) => run.projectRepositoryLinkId === linkA.id)?.status, "succeeded");
        assert.equal(
          first.runs.find((run) => run.projectRepositoryLinkId === linkB.id)?.failureCode,
          "GITHUB_SCAN_SECRET_DETECTED",
        );
        assert.equal(await prisma.repositoryCodeGeneration.count(), 1);
        assert.equal(
          await prisma.repositoryFileRevision.count({
            where: { projectId, projectRepositoryLinkId: linkB.id },
          }),
          0,
        );
        const generationA = await prisma.repositoryCodeGeneration.findFirstOrThrow({
          where: { projectId, projectRepositoryLinkId: linkA.id },
        });
        assert.equal(generationA.modelTransferScanResult, "blocked");
        assert.equal(generationA.securityFindingCount, 1);
        assert.deepEqual(generationA.securityFindingManifest, [
          { normalizedPath: "src/index.ts", categories: ["EMAIL_ADDRESS"] },
        ]);
        const firstSnapshot = await prisma.projectCodeSnapshotPointer.findUniqueOrThrow({
          where: { projectId },
          include: { snapshot: { include: { entries: true } } },
        });
        assert.equal(firstSnapshot.snapshot.entries.length, 1);
        assert.equal(firstSnapshot.snapshot.entries[0]?.projectRepositoryLinkId, linkA.id);

        fixture.useSafeRepositoryB();
        const second = await service.scanProject(projectId);
        assert.equal(second.status, "succeeded");
        assert.equal(second.completedRequiredLinkCount, 1);
        assert.equal(second.completedOptionalLinkCount, 1);
        assert.notEqual(second.projectCodeSnapshotId, first.projectCodeSnapshotId);
        assert.equal(await prisma.repositoryCodeGeneration.count(), 2);
        assert.equal(
          await prisma.repositoryCodeGeneration.count({
            where: { projectId, projectRepositoryLinkId: linkA.id },
          }),
          1,
        );
        assert.equal(
          await prisma.repositoryFileRevision.count({
            where: { projectId, projectRepositoryLinkId: linkA.id },
          }),
          1,
        );
        const generationB = await prisma.repositoryCodeGeneration.findFirstOrThrow({
          where: { projectId, projectRepositoryLinkId: linkB.id },
        });
        assert.equal(generationB.modelTransferScanResult, "passed");
        assert.equal(generationB.securityFindingCount, 0);
        const secondSnapshot = await prisma.projectCodeSnapshotPointer.findUniqueOrThrow({
          where: { projectId },
          include: { snapshot: { include: { entries: true } } },
        });
        assert.equal(secondSnapshot.snapshot.entries.length, 1);
        assert.equal(secondSnapshot.snapshot.entries[0]?.projectRepositoryLinkId, linkA.id);

        const prepared = await service.prepareProjectScan(projectId);
        const reconfiguredA = await ledger.connect({
          projectId,
          repository: repositoryA,
          config: repositoryConfig(true, ["src2"]),
        });
        assert.equal(reconfiguredA.config.version, 2);
        const stale = await service.executeProjectScan({ projectId, batchId: prepared.id });
        assert.equal(stale.status, "partial");
        assert.equal(stale.completedRequiredLinkCount, 0);
        assert.equal(stale.completedOptionalLinkCount, 1);
        assert.equal(stale.projectCodeSnapshotId, null);
        assert.equal(
          stale.runs.find((run) => run.projectRepositoryLinkId === linkA.id)?.failureCode,
          "GITHUB_CODE_SCAN_LINK_INELIGIBLE",
        );
        const unchangedPointer = await prisma.projectCodeSnapshotPointer.findUniqueOrThrow({
          where: { projectId },
        });
        assert.equal(unchangedPointer.projectCodeSnapshotId, second.projectCodeSnapshotId);

        const restored = await service.scanProject(projectId);
        assert.equal(restored.status, "succeeded");
        assert.notEqual(restored.projectCodeSnapshotId, second.projectCodeSnapshotId);
        assert.equal(
          await prisma.repositoryCodeGeneration.count({
            where: { projectId, projectRepositoryLinkId: linkA.id },
          }),
          2,
        );
        const restoredPointer = await prisma.projectCodeSnapshotPointer.findUniqueOrThrow({
          where: { projectId },
          include: { snapshot: { include: { entries: true } } },
        });
        assert.equal(restoredPointer.snapshot.entries[0]?.linkConfigVersion, 2);
        assert.equal(restoredPointer.snapshot.entries[0]?.projectRepositoryLinkId, linkA.id);

        const allRevisionText = await prisma.repositoryFileRevision.findMany({
          select: { contentText: true },
        });
        assert.equal(
          JSON.stringify(allRevisionText).includes("CorrectHorseBatteryStaple"),
          false,
        );
        await assert.rejects(() =>
          prisma.repoCodeScanRun.update({
            where: { id: first.runs[0]!.id },
            data: { status: "running", stage: "discovering", completedAt: null },
          }),
        );
        await assert.rejects(() =>
          prisma.repositoryCodeGeneration.update({
            where: { id: generationA.id },
            data: { manifestFingerprint: "0".repeat(64) },
          }),
        );
        await assert.rejects(() =>
          prisma.projectScanBatch.update({
            where: { id: second.id },
            data: { status: "running", completedAt: null },
          }),
        );
        await assert.rejects(() =>
          prisma.projectCodeSnapshot.update({
            where: { id: restoredPointer.projectCodeSnapshotId },
            data: { requiredLinkCount: 0 },
          }),
        );

        const admissions = await Promise.allSettled([
          service.prepareProjectScan(projectId),
          service.prepareProjectScan(projectId),
        ]);
        assert.equal(admissions.filter((result) => result.status === "fulfilled").length, 1);
        const rejected = admissions.find((result) => result.status === "rejected");
        assert.equal(
          rejected?.status === "rejected" &&
            rejected.reason instanceof GitHubCodeScanServiceError &&
            rejected.reason.code === "GITHUB_CODE_SCAN_ALREADY_RUNNING",
          true,
        );
        assert.equal(
          await prisma.projectScanBatch.count({
            where: { projectId, status: { in: ["queued", "running", "unknown"] } },
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
