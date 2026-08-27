import { createHash, randomUUID } from "node:crypto";
import {
  Prisma,
  type PrismaClient,
} from "@prisma/client";
import {
  GITHUB_CODE_SCANNER_FINGERPRINT,
  GITHUB_CODE_SCANNER_VERSION,
  GitHubCodeScanError,
  scanGitHubRepositoryCode,
  type GitHubCodeScanResult,
} from "./code-scanner";
import {
  GITHUB_READ_ONLY_CLIENT_VERSION,
  GitHubReadError,
  type GitHubReadOnlyClient,
} from "./read-only-client";

export const GITHUB_CODE_SCAN_SERVICE_VERSION =
  "github-code-scan-service:v1" as const;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const TRANSACTION_RETRY_LIMIT = 3;

export type GitHubCodeScanServiceErrorCode =
  | "GITHUB_CODE_SCAN_INVALID_INPUT"
  | "GITHUB_CODE_SCAN_PROJECT_NOT_FOUND"
  | "GITHUB_CODE_SCAN_NO_ELIGIBLE_REPOSITORIES"
  | "GITHUB_CODE_SCAN_BATCH_NOT_FOUND"
  | "GITHUB_CODE_SCAN_RUN_NOT_FOUND"
  | "GITHUB_CODE_SCAN_ALREADY_RUNNING"
  | "GITHUB_CODE_SCAN_RECONCILIATION_REQUIRED"
  | "GITHUB_CODE_SCAN_LINK_INELIGIBLE"
  | "GITHUB_CODE_SCAN_PUBLISH_CONFLICT"
  | "GITHUB_CODE_SCAN_INTEGRITY_ERROR"
  | "GITHUB_CODE_SCAN_WRITE_CONFLICT";

export class GitHubCodeScanServiceError extends Error {
  constructor(readonly code: GitHubCodeScanServiceErrorCode) {
    super(code);
    this.name = "GitHubCodeScanServiceError";
  }
}

export type RepositoryScanRunView = Readonly<{
  id: string;
  projectRepositoryLinkId: string;
  requiredForProjectSnapshot: boolean;
  status: "queued" | "running" | "succeeded" | "failed" | "rateLimited" | "unknown" | "cancelled";
  stage: "queued" | "discovering" | "fetching" | "scanning" | "publishing" | "terminal";
  frozenCommitSha: string | null;
  rootTreeSha: string | null;
  requestCount: number;
  visitedTreeEntryCount: number;
  discoveredFileCount: number;
  decodedTextBytes: number;
  failureCode: string | null;
  retryAt: string | null;
}>;

export type ProjectCodeScanBatchView = Readonly<{
  id: string;
  projectId: string;
  status: "queued" | "running" | "succeeded" | "partial" | "partialOptional" | "failed" | "unknown" | "cancelled";
  requiredManifestFingerprint: string;
  expectedRequiredLinkCount: number;
  expectedOptionalLinkCount: number;
  completedRequiredLinkCount: number;
  completedOptionalLinkCount: number;
  failureCode: string | null;
  startedAt: string;
  completedAt: string | null;
  projectCodeSnapshotId: string | null;
  runs: readonly RepositoryScanRunView[];
}>;

export interface GitHubCodeScanService {
  prepareProjectScan(projectId: unknown): Promise<ProjectCodeScanBatchView>;
  executeProjectScan(input: unknown): Promise<ProjectCodeScanBatchView>;
  scanProject(projectId: unknown): Promise<ProjectCodeScanBatchView>;
  getProjectScan(input: unknown): Promise<ProjectCodeScanBatchView>;
}

type TransactionRunner = <T>(
  callback: (tx: Prisma.TransactionClient) => Promise<T>,
  options: { isolationLevel: Prisma.TransactionIsolationLevel },
) => Promise<T>;

type EligibleLink = Readonly<{
  id: string;
  projectId: string;
  effectivePolicyVersion: number;
  githubRepository: Readonly<{
    githubRepositoryId: bigint;
    nodeId: string;
    currentOwner: string;
    currentName: string;
    currentFullName: string;
  }>;
  configPointer: Readonly<{
    configVersion: number;
    effectivePolicyVersion: number;
    config: Readonly<{
      version: number;
      requiredForProjectSnapshot: boolean;
      trackedRef: string;
      codeEnabled: boolean;
      includeRoots: unknown;
      softExcludePatterns: unknown;
      scanScopeFingerprint: string;
      effectivePolicyVersion: number;
    }>;
  }> | null;
  codeGenerationPointer: Readonly<{
    repositoryCodeGenerationId: string;
  }> | null;
}>;

type RunClaim = Readonly<{
  projectId: string;
  batchId: string;
  runId: string;
  projectRepositoryLinkId: string;
  linkConfigVersion: number;
  expectedEffectivePolicyVersion: number;
  expectedActiveGenerationId: string | null;
  owner: string;
  repository: string;
  expectedRepositoryId: number;
  expectedNodeId: string;
  trackedRef: string;
  includeRoots: readonly string[];
  softExcludePatterns: readonly (
    | "vendor"
    | "node_modules"
    | "build"
    | "dist"
    | "coverage"
    | "generated"
    | "minified"
    | "source_map"
    | "lockfile"
  )[];
  scanScopeFingerprint: string;
}>;

type FailureDisposition = Readonly<{
  status: "failed" | "rateLimited";
  failureCode: string;
  retryAt: Date | null;
  invalidateLink: boolean;
}>;

function fail(code: GitHubCodeScanServiceErrorCode): never {
  throw new GitHubCodeScanServiceError(code);
}

function canonicalUuid(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    return fail("GITHUB_CODE_SCAN_INVALID_INPUT");
  }
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return keys.length === wanted.length && keys.every((key, index) => key === wanted[index]);
}

function parseBatchInput(value: unknown): Readonly<{ projectId: string; batchId: string }> {
  if (!isPlainRecord(value) || !exactKeys(value, ["batchId", "projectId"])) {
    return fail("GITHUB_CODE_SCAN_INVALID_INPUT");
  }
  return Object.freeze({
    projectId: canonicalUuid(value.projectId),
    batchId: canonicalUuid(value.batchId),
  });
}

function generatedUuid(factory: () => string): string {
  return canonicalUuid(factory());
}

function fingerprint(label: string, value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify({ version: GITHUB_CODE_SCAN_SERVICE_VERSION, label, value }), "utf8")
    .digest("hex");
}

function isPrismaCode(error: unknown, code: string): boolean {
  if (typeof error !== "object" || error === null) return false;
  try {
    return (error as { code?: unknown }).code === code;
  } catch {
    return false;
  }
}

function safeDate(factory: () => Date): Date {
  const value = factory();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    return fail("GITHUB_CODE_SCAN_INVALID_INPUT");
  }
  return new Date(value.getTime());
}

function safeStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return fail("GITHUB_CODE_SCAN_INTEGRITY_ERROR");
  const values = value.map((entry) => {
    if (typeof entry !== "string") return fail("GITHUB_CODE_SCAN_INTEGRITY_ERROR");
    return entry;
  });
  return Object.freeze(values);
}

function safeSoftExcludes(value: unknown): RunClaim["softExcludePatterns"] {
  const allowed = new Set([
    "vendor",
    "node_modules",
    "build",
    "dist",
    "coverage",
    "generated",
    "minified",
    "source_map",
    "lockfile",
  ] as const);
  const values = safeStringArray(value);
  if (values.some((entry) => !allowed.has(entry as never))) {
    return fail("GITHUB_CODE_SCAN_INTEGRITY_ERROR");
  }
  return values as RunClaim["softExcludePatterns"];
}

function safeRepositoryId(value: bigint): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || BigInt(number) !== value) {
    return fail("GITHUB_CODE_SCAN_INTEGRITY_ERROR");
  }
  return number;
}

function failureDisposition(error: unknown, now: Date): FailureDisposition {
  if (error instanceof GitHubReadError) {
    if (error.code === "GITHUB_RATE_LIMITED") {
      const headerTime = error.retryAtEpochSeconds === null
        ? now.getTime() + 60_000
        : error.retryAtEpochSeconds * 1_000;
      const retryAt = new Date(Math.max(headerTime, now.getTime() + 1_000));
      return Object.freeze({
        status: "rateLimited",
        failureCode: "GITHUB_RATE_LIMITED",
        retryAt,
        invalidateLink: false,
      });
    }
    return Object.freeze({
      status: "failed",
      failureCode: error.code,
      retryAt: null,
      invalidateLink: error.code === "GITHUB_ACCESS_UNKNOWN",
    });
  }
  if (error instanceof GitHubCodeScanError) {
    return Object.freeze({
      status: "failed",
      failureCode: error.code,
      retryAt: null,
      invalidateLink: error.code === "GITHUB_SCAN_IDENTITY_MISMATCH",
    });
  }
  return Object.freeze({
    status: "failed",
    failureCode: "GITHUB_SCAN_SCANNER_UNAVAILABLE",
    retryAt: null,
    invalidateLink: false,
  });
}

function batchFailureCode(
  status: ProjectCodeScanBatchView["status"],
): string | null {
  if (status === "partialOptional") return "OPTIONAL_REPOSITORY_INCOMPLETE";
  if (status === "partial") return "REQUIRED_REPOSITORY_PARTIAL";
  if (status === "failed") return "REQUIRED_REPOSITORY_FAILED";
  return null;
}

function batchView(row: {
  id: string;
  projectId: string;
  status: ProjectCodeScanBatchView["status"];
  requiredManifestFingerprint: string;
  expectedRequiredLinkCount: number;
  expectedOptionalLinkCount: number;
  completedRequiredLinkCount: number;
  completedOptionalLinkCount: number;
  failureCode: string | null;
  startedAt: Date;
  completedAt: Date | null;
  codeSnapshot: { id: string } | null;
  entries: readonly { projectRepositoryLinkId: string; requiredForProjectSnapshot: boolean }[];
  codeScanRuns: readonly {
    id: string;
    projectRepositoryLinkId: string;
    status: RepositoryScanRunView["status"];
    stage: RepositoryScanRunView["stage"];
    frozenCommitSha: string | null;
    rootTreeSha: string | null;
    requestCount: number;
    visitedTreeEntryCount: number;
    discoveredFileCount: number;
    decodedTextBytes: number;
    failureCode: string | null;
    retryAt: Date | null;
  }[];
}): ProjectCodeScanBatchView {
  const requiredByLink = new Map(
    row.entries.map((entry) => [entry.projectRepositoryLinkId, entry.requiredForProjectSnapshot]),
  );
  return Object.freeze({
    id: row.id,
    projectId: row.projectId,
    status: row.status,
    requiredManifestFingerprint: row.requiredManifestFingerprint,
    expectedRequiredLinkCount: row.expectedRequiredLinkCount,
    expectedOptionalLinkCount: row.expectedOptionalLinkCount,
    completedRequiredLinkCount: row.completedRequiredLinkCount,
    completedOptionalLinkCount: row.completedOptionalLinkCount,
    failureCode: row.failureCode,
    startedAt: row.startedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    projectCodeSnapshotId: row.codeSnapshot?.id ?? null,
    runs: Object.freeze(row.codeScanRuns.map((run) => Object.freeze({
      id: run.id,
      projectRepositoryLinkId: run.projectRepositoryLinkId,
      requiredForProjectSnapshot: requiredByLink.get(run.projectRepositoryLinkId) ?? false,
      status: run.status,
      stage: run.stage,
      frozenCommitSha: run.frozenCommitSha,
      rootTreeSha: run.rootTreeSha,
      requestCount: run.requestCount,
      visitedTreeEntryCount: run.visitedTreeEntryCount,
      discoveredFileCount: run.discoveredFileCount,
      decodedTextBytes: run.decodedTextBytes,
      failureCode: run.failureCode,
      retryAt: run.retryAt?.toISOString() ?? null,
    }))),
  });
}

const BATCH_INCLUDE = Prisma.validator<Prisma.ProjectScanBatchInclude>()({
  entries: { orderBy: [{ projectRepositoryLinkId: "asc" }] },
  codeScanRuns: { orderBy: [{ projectRepositoryLinkId: "asc" }, { id: "asc" }] },
  codeSnapshot: { select: { id: true } },
});

export function createGitHubCodeScanService(options: Readonly<{
  db: PrismaClient;
  client: GitHubReadOnlyClient;
  idFactory?: () => string;
  now?: () => Date;
}>): GitHubCodeScanService {
  if (
    typeof options !== "object" ||
    options === null ||
    typeof options.db?.$transaction !== "function" ||
    options.client?.version !== GITHUB_READ_ONLY_CLIENT_VERSION ||
    (options.idFactory !== undefined && typeof options.idFactory !== "function") ||
    (options.now !== undefined && typeof options.now !== "function")
  ) {
    return fail("GITHUB_CODE_SCAN_INVALID_INPUT");
  }
  const transaction = options.db.$transaction.bind(options.db) as TransactionRunner;
  const idFactory = options.idFactory ?? randomUUID;
  const nowFactory = options.now ?? (() => new Date());

  const serializable = async <T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> => {
    for (let attempt = 0; attempt < TRANSACTION_RETRY_LIMIT; attempt += 1) {
      try {
        return await transaction(work, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        if (error instanceof GitHubCodeScanServiceError) throw error;
        if (
          (isPrismaCode(error, "P2002") || isPrismaCode(error, "P2034")) &&
          attempt + 1 < TRANSACTION_RETRY_LIMIT
        ) {
          continue;
        }
        if (isPrismaCode(error, "P2002") || isPrismaCode(error, "P2034")) {
          return fail("GITHUB_CODE_SCAN_WRITE_CONFLICT");
        }
        if (isPrismaCode(error, "P2003") || isPrismaCode(error, "P2010")) {
          return fail("GITHUB_CODE_SCAN_INTEGRITY_ERROR");
        }
        throw error;
      }
    }
    return fail("GITHUB_CODE_SCAN_WRITE_CONFLICT");
  };

  const readBatch = async (
    db: Prisma.TransactionClient | PrismaClient,
    projectId: string,
    batchId: string,
  ): Promise<ProjectCodeScanBatchView> => {
    const row = await db.projectScanBatch.findUnique({
      where: { projectId_id: { projectId, id: batchId } },
      include: BATCH_INCLUDE,
    });
    if (row === null) return fail("GITHUB_CODE_SCAN_BATCH_NOT_FOUND");
    return batchView(row as Parameters<typeof batchView>[0]);
  };

  const settleFailure = async (
    claim: RunClaim,
    disposition: FailureDisposition,
  ): Promise<void> => {
    const now = safeDate(nowFactory);
    await serializable(async (tx) => {
      const run = await tx.repoCodeScanRun.findUnique({
        where: { projectId_id: { projectId: claim.projectId, id: claim.runId } },
      });
      if (run === null) return fail("GITHUB_CODE_SCAN_RUN_NOT_FOUND");
      if (run.status !== "running") return;
      if (disposition.invalidateLink) {
        await tx.projectRepositoryLink.updateMany({
          where: {
            projectId: claim.projectId,
            id: claim.projectRepositoryLinkId,
            status: "active",
            effectivePolicyVersion: claim.expectedEffectivePolicyVersion,
          },
          data: {
            status: "accessUnknown",
            effectivePolicyVersion: { increment: 1 },
            disabledAt: null,
            updatedAt: now,
          },
        });
      }
      await tx.repoCodeScanRun.update({
        where: { projectId_id: { projectId: claim.projectId, id: claim.runId } },
        data: {
          status: disposition.status,
          stage: "terminal",
          failureCode: disposition.failureCode,
          retryAt: disposition.retryAt,
          completedAt: now,
        },
      });
    });
  };

  const settleQueuedIneligibleRun = async (
    projectId: string,
    runId: string,
  ): Promise<void> => {
    const now = safeDate(nowFactory);
    await serializable(async (tx) => {
      const run = await tx.repoCodeScanRun.findUnique({
        where: { projectId_id: { projectId, id: runId } },
      });
      if (run === null) return fail("GITHUB_CODE_SCAN_RUN_NOT_FOUND");
      if (run.status !== "queued") return;
      await tx.repoCodeScanRun.update({
        where: { projectId_id: { projectId, id: runId } },
        data: {
          status: "failed",
          stage: "terminal",
          failureCode: "GITHUB_CODE_SCAN_LINK_INELIGIBLE",
          completedAt: now,
        },
      });
    });
  };

  const claimRun = async (projectId: string, runId: string): Promise<RunClaim> => {
    return serializable(async (tx) => {
      const run = await tx.repoCodeScanRun.findUnique({
        where: { projectId_id: { projectId, id: runId } },
        include: {
          batch: true,
          repositoryLink: {
            include: {
              githubRepository: true,
              configPointer: { include: { config: true } },
              codeGenerationPointer: true,
            },
          },
        },
      });
      if (run === null) return fail("GITHUB_CODE_SCAN_RUN_NOT_FOUND");
      if (run.status === "running") return fail("GITHUB_CODE_SCAN_ALREADY_RUNNING");
      if (run.status === "unknown") return fail("GITHUB_CODE_SCAN_RECONCILIATION_REQUIRED");
      if (run.status !== "queued" || run.batch === null) {
        return fail("GITHUB_CODE_SCAN_LINK_INELIGIBLE");
      }
      if (run.batch.status !== "queued" && run.batch.status !== "running") {
        return fail("GITHUB_CODE_SCAN_LINK_INELIGIBLE");
      }
      const link = run.repositoryLink as EligibleLink;
      const pointer = link.configPointer;
      if (
        link.projectId !== projectId ||
        pointer === null ||
        link.effectivePolicyVersion !== run.expectedEffectivePolicyVersion ||
        pointer.configVersion !== run.linkConfigVersion ||
        pointer.effectivePolicyVersion !== run.expectedEffectivePolicyVersion ||
        pointer.config.effectivePolicyVersion !== run.expectedEffectivePolicyVersion ||
        pointer.config.codeEnabled !== true ||
        !FINGERPRINT_PATTERN.test(pointer.config.scanScopeFingerprint) ||
        (link.codeGenerationPointer?.repositoryCodeGenerationId ?? null) !==
          run.expectedActiveGenerationId
      ) {
        return fail("GITHUB_CODE_SCAN_LINK_INELIGIBLE");
      }
      if (run.batch.status === "queued") {
        await tx.projectScanBatch.update({
          where: { projectId_id: { projectId, id: run.batch.id } },
          data: { status: "running" },
        });
      }
      await tx.repoCodeScanRun.update({
        where: { projectId_id: { projectId, id: runId } },
        data: { status: "running", stage: "discovering" },
      });
      return Object.freeze({
        projectId,
        batchId: run.batch.id,
        runId,
        projectRepositoryLinkId: run.projectRepositoryLinkId,
        linkConfigVersion: run.linkConfigVersion,
        expectedEffectivePolicyVersion: run.expectedEffectivePolicyVersion,
        expectedActiveGenerationId: run.expectedActiveGenerationId,
        owner: link.githubRepository.currentOwner,
        repository: link.githubRepository.currentName,
        expectedRepositoryId: safeRepositoryId(link.githubRepository.githubRepositoryId),
        expectedNodeId: link.githubRepository.nodeId,
        trackedRef: pointer.config.trackedRef,
        includeRoots: safeStringArray(pointer.config.includeRoots),
        softExcludePatterns: safeSoftExcludes(pointer.config.softExcludePatterns),
        scanScopeFingerprint: pointer.config.scanScopeFingerprint,
      });
    });
  };

  const publishResult = async (
    claim: RunClaim,
    result: GitHubCodeScanResult,
  ): Promise<void> => {
    const now = safeDate(nowFactory);
    await serializable(async (tx) => {
      const run = await tx.repoCodeScanRun.findUnique({
        where: { projectId_id: { projectId: claim.projectId, id: claim.runId } },
        include: {
          repositoryLink: {
            include: {
              githubRepository: true,
              configPointer: { include: { config: true } },
              codeGenerationPointer: true,
            },
          },
        },
      });
      if (run === null) return fail("GITHUB_CODE_SCAN_RUN_NOT_FOUND");
      const link = run.repositoryLink as EligibleLink;
      const pointer = link.configPointer;
      if (
        run.status !== "running" ||
        pointer === null ||
        link.effectivePolicyVersion !== claim.expectedEffectivePolicyVersion ||
        pointer.configVersion !== claim.linkConfigVersion ||
        pointer.effectivePolicyVersion !== claim.expectedEffectivePolicyVersion ||
        (link.codeGenerationPointer?.repositoryCodeGenerationId ?? null) !==
          claim.expectedActiveGenerationId ||
        result.contractVersion !== GITHUB_CODE_SCANNER_VERSION ||
        result.scannerFingerprint !== GITHUB_CODE_SCANNER_FINGERPRINT ||
        result.scanScopeFingerprint !== claim.scanScopeFingerprint ||
        result.repository.repositoryId !== claim.expectedRepositoryId ||
        result.repository.nodeId !== claim.expectedNodeId ||
        result.repository.capturedFullName !==
          `${result.repository.owner}/${result.repository.name}` ||
        result.trackedRef !== claim.trackedRef ||
        !FINGERPRINT_PATTERN.test(result.manifestFingerprint)
      ) {
        return fail("GITHUB_CODE_SCAN_PUBLISH_CONFLICT");
      }

      const generationKey = fingerprint("repository-code-generation", {
        projectId: claim.projectId,
        projectRepositoryLinkId: claim.projectRepositoryLinkId,
        linkConfigVersion: claim.linkConfigVersion,
        effectivePolicyVersion: claim.expectedEffectivePolicyVersion,
        frozenCommitSha: result.frozenCommitSha,
        rootTreeSha: result.rootTreeSha,
        scanScopeFingerprint: result.scanScopeFingerprint,
        scannerFingerprint: result.scannerFingerprint,
        manifestFingerprint: result.manifestFingerprint,
      });
      const existing = await tx.repositoryCodeGeneration.findUnique({
        where: { projectId_generationKey: { projectId: claim.projectId, generationKey } },
      });
      if (existing !== null) {
        if (
          existing.projectRepositoryLinkId !== claim.projectRepositoryLinkId ||
          existing.linkConfigVersion !== claim.linkConfigVersion ||
          existing.effectivePolicyVersion !== claim.expectedEffectivePolicyVersion ||
          existing.frozenCommitSha !== result.frozenCommitSha ||
          existing.rootTreeSha !== result.rootTreeSha ||
          existing.manifestFingerprint !== result.manifestFingerprint ||
          existing.status !== "codeReady" ||
          link.codeGenerationPointer?.repositoryCodeGenerationId !== existing.id
        ) {
          return fail("GITHUB_CODE_SCAN_PUBLISH_CONFLICT");
        }
        await tx.repoCodeScanRun.update({
          where: { projectId_id: { projectId: claim.projectId, id: claim.runId } },
          data: {
            status: "succeeded",
            stage: "terminal",
            frozenCommitSha: result.frozenCommitSha,
            rootTreeSha: result.rootTreeSha,
            requestCount: result.requestCount,
            visitedTreeEntryCount: result.visitedTreeEntryCount,
            discoveredFileCount: result.discoveredFileCount,
            decodedTextBytes: result.decodedTextBytes,
            failureCode: null,
            retryAt: null,
            completedAt: now,
          },
        });
        return;
      }

      const revisionByPath = new Map<string, {
        id: string;
        blobOid: string;
        contentHash: string;
        contentBytes: number;
        lineCount: number;
      }>();
      for (const file of result.files) {
        let repositoryFile = await tx.repositoryFile.findUnique({
          where: {
            projectId_projectRepositoryLinkId_normalizedPath: {
              projectId: claim.projectId,
              projectRepositoryLinkId: claim.projectRepositoryLinkId,
              normalizedPath: file.normalizedPath,
            },
          },
        });
        if (repositoryFile === null) {
          repositoryFile = await tx.repositoryFile.create({
            data: {
              id: generatedUuid(idFactory),
              projectId: claim.projectId,
              projectRepositoryLinkId: claim.projectRepositoryLinkId,
              normalizedPath: file.normalizedPath,
            },
          });
        }
        let revision = await tx.repositoryFileRevision.findFirst({
          where: {
            projectId: claim.projectId,
            projectRepositoryLinkId: claim.projectRepositoryLinkId,
            repositoryFileId: repositoryFile.id,
            blobOid: file.blobOid,
            scannerFingerprint: result.scannerFingerprint,
          },
        });
        if (revision === null) {
          revision = await tx.repositoryFileRevision.create({
            data: {
              id: generatedUuid(idFactory),
              projectId: claim.projectId,
              projectRepositoryLinkId: claim.projectRepositoryLinkId,
              repositoryFileId: repositoryFile.id,
              blobOid: file.blobOid,
              contentText: file.contentText,
              contentHash: file.contentHash,
              contentBytes: file.contentBytes,
              lineCount: file.lineCount,
              scannerVersion: result.contractVersion,
              scannerFingerprint: result.scannerFingerprint,
            },
          });
        } else if (
          revision.contentHash !== file.contentHash ||
          revision.contentBytes !== file.contentBytes ||
          revision.lineCount !== file.lineCount ||
          revision.contentText !== file.contentText ||
          repositoryFile.normalizedPath !== file.normalizedPath
        ) {
          return fail("GITHUB_CODE_SCAN_INTEGRITY_ERROR");
        }
        revisionByPath.set(file.normalizedPath, revision);
      }

      const generationId = generatedUuid(idFactory);
      await tx.repositoryCodeGeneration.create({
        data: {
          id: generationId,
          projectId: claim.projectId,
          projectRepositoryLinkId: claim.projectRepositoryLinkId,
          linkConfigVersion: claim.linkConfigVersion,
          repoCodeScanRunId: claim.runId,
          status: "staging",
          generationKey,
          capturedGitHubRepositoryId: BigInt(result.repository.repositoryId),
          capturedFullName: result.repository.capturedFullName,
          frozenCommitSha: result.frozenCommitSha,
          rootTreeSha: result.rootTreeSha,
          scanScopeFingerprint: result.scanScopeFingerprint,
          scannerVersion: result.contractVersion,
          scannerFingerprint: result.scannerFingerprint,
          effectivePolicyVersion: claim.expectedEffectivePolicyVersion,
          manifestFingerprint: result.manifestFingerprint,
          exclusionManifest: result.exclusions as unknown as Prisma.InputJsonValue,
          modelTransferScanResult: result.modelTransferScanResult,
          securityFindingManifest: result.securityFindings as unknown as Prisma.InputJsonValue,
          securityFindingCount: result.securityFindings.length,
          fileCount: result.files.length,
          decodedTextBytes: result.decodedTextBytes,
        },
      });
      if (result.files.length > 0) {
        await tx.repositoryCodeGenerationEntry.createMany({
          data: result.files.map((file, ordinal) => {
            const revision = revisionByPath.get(file.normalizedPath);
            if (revision === undefined) return fail("GITHUB_CODE_SCAN_INTEGRITY_ERROR");
            return {
              id: generatedUuid(idFactory),
              projectId: claim.projectId,
              projectRepositoryLinkId: claim.projectRepositoryLinkId,
              repositoryCodeGenerationId: generationId,
              repositoryFileRevisionId: revision.id,
              ordinal,
              normalizedPath: file.normalizedPath,
              mode: file.mode,
              blobOid: file.blobOid,
              contentHash: file.contentHash,
              contentBytes: file.contentBytes,
              lineCount: file.lineCount,
            };
          }),
        });
      }
      await tx.repositoryCodeGeneration.update({
        where: { id: generationId },
        data: { status: "codeReady", completedAt: now },
      });
      await tx.repoCodeScanRun.update({
        where: { projectId_id: { projectId: claim.projectId, id: claim.runId } },
        data: {
          status: "succeeded",
          stage: "terminal",
          frozenCommitSha: result.frozenCommitSha,
          rootTreeSha: result.rootTreeSha,
          requestCount: result.requestCount,
          visitedTreeEntryCount: result.visitedTreeEntryCount,
          discoveredFileCount: result.discoveredFileCount,
          decodedTextBytes: result.decodedTextBytes,
          failureCode: null,
          retryAt: null,
          completedAt: now,
        },
      });
      if (claim.expectedActiveGenerationId === null) {
        await tx.repositoryCodeGenerationPointer.create({
          data: {
            projectId: claim.projectId,
            projectRepositoryLinkId: claim.projectRepositoryLinkId,
            repositoryCodeGenerationId: generationId,
            linkConfigVersion: claim.linkConfigVersion,
            effectivePolicyVersion: claim.expectedEffectivePolicyVersion,
            updatedAt: now,
          },
        });
      } else {
        await tx.repositoryCodeGenerationPointer.update({
          where: {
            projectId_projectRepositoryLinkId: {
              projectId: claim.projectId,
              projectRepositoryLinkId: claim.projectRepositoryLinkId,
            },
          },
          data: {
            repositoryCodeGenerationId: generationId,
            linkConfigVersion: claim.linkConfigVersion,
            effectivePolicyVersion: claim.expectedEffectivePolicyVersion,
            updatedAt: now,
          },
        });
      }
    });
  };

  const executeRun = async (projectId: string, runId: string): Promise<void> => {
    let claim: RunClaim;
    try {
      claim = await claimRun(projectId, runId);
    } catch (error) {
      if (
        error instanceof GitHubCodeScanServiceError &&
        error.code === "GITHUB_CODE_SCAN_LINK_INELIGIBLE"
      ) {
        await settleQueuedIneligibleRun(projectId, runId);
        return;
      }
      throw error;
    }
    let result: GitHubCodeScanResult;
    try {
      result = await scanGitHubRepositoryCode({
        client: options.client,
        owner: claim.owner,
        repository: claim.repository,
        expectedRepositoryId: claim.expectedRepositoryId,
        expectedNodeId: claim.expectedNodeId,
        trackedRef: claim.trackedRef,
        includeRoots: claim.includeRoots,
        softExcludePatterns: claim.softExcludePatterns,
        scanScopeFingerprint: claim.scanScopeFingerprint,
      });
    } catch (error) {
      await settleFailure(claim, failureDisposition(error, safeDate(nowFactory)));
      return;
    }
    try {
      await publishResult(claim, result);
    } catch (error) {
      if (
        error instanceof GitHubCodeScanServiceError &&
        (error.code === "GITHUB_CODE_SCAN_PUBLISH_CONFLICT" ||
          error.code === "GITHUB_CODE_SCAN_INTEGRITY_ERROR")
      ) {
        await settleFailure(claim, Object.freeze({
          status: "failed",
          failureCode: error.code,
          retryAt: null,
          invalidateLink: false,
        }));
        return;
      }
      throw error;
    }
  };

  const finalizeBatch = async (
    projectId: string,
    batchId: string,
  ): Promise<ProjectCodeScanBatchView> => {
    const now = safeDate(nowFactory);
    return serializable(async (tx) => {
      const batch = await tx.projectScanBatch.findUnique({
        where: { projectId_id: { projectId, id: batchId } },
        include: {
          entries: { orderBy: [{ projectRepositoryLinkId: "asc" }] },
          codeScanRuns: { orderBy: [{ projectRepositoryLinkId: "asc" }, { id: "asc" }] },
          codeSnapshot: true,
        },
      });
      if (batch === null) return fail("GITHUB_CODE_SCAN_BATCH_NOT_FOUND");
      if (["succeeded", "partial", "partialOptional", "failed", "cancelled"].includes(batch.status)) {
        return readBatch(tx, projectId, batchId);
      }
      if (batch.codeScanRuns.some((run) => run.status === "running" || run.status === "queued")) {
        return fail("GITHUB_CODE_SCAN_ALREADY_RUNNING");
      }
      if (batch.codeScanRuns.some((run) => run.status === "unknown")) {
        await tx.projectScanBatch.update({
          where: { projectId_id: { projectId, id: batchId } },
          data: { status: "unknown", failureCode: "SCAN_RECONCILIATION_REQUIRED" },
        });
        return readBatch(tx, projectId, batchId);
      }
      if (batch.codeScanRuns.length !== batch.entries.length) {
        return fail("GITHUB_CODE_SCAN_INTEGRITY_ERROR");
      }
      const runByLink = new Map(
        batch.codeScanRuns.map((run) => [run.projectRepositoryLinkId, run]),
      );
      let completedRequired = 0;
      let completedOptional = 0;
      for (const entry of batch.entries) {
        const run = runByLink.get(entry.projectRepositoryLinkId);
        if (run === undefined) return fail("GITHUB_CODE_SCAN_INTEGRITY_ERROR");
        if (run.status === "succeeded") {
          if (entry.requiredForProjectSnapshot) completedRequired += 1;
          else completedOptional += 1;
        }
      }
      const status: ProjectCodeScanBatchView["status"] =
        completedRequired === batch.expectedRequiredLinkCount
          ? completedOptional === batch.expectedOptionalLinkCount
            ? "succeeded"
            : "partialOptional"
          : completedRequired > 0 || completedOptional > 0
            ? "partial"
            : "failed";

      let snapshotId = batch.codeSnapshot?.id ?? null;
      if (completedRequired === batch.expectedRequiredLinkCount && snapshotId === null) {
        const snapshotEntries: Array<{
          projectRepositoryLinkId: string;
          linkConfigVersion: number;
          effectivePolicyVersion: number;
          repositoryCodeGenerationId: string;
          frozenCommitSha: string;
          generationManifestFingerprint: string;
        }> = [];
        for (const entry of batch.entries.filter((value) => value.requiredForProjectSnapshot)) {
          const pointer = await tx.repositoryCodeGenerationPointer.findUnique({
            where: {
              projectId_projectRepositoryLinkId: {
                projectId,
                projectRepositoryLinkId: entry.projectRepositoryLinkId,
              },
            },
            include: { generation: true },
          });
          if (
            pointer === null ||
            pointer.linkConfigVersion !== entry.linkConfigVersion ||
            pointer.effectivePolicyVersion !== entry.effectivePolicyVersion ||
            pointer.generation.status !== "codeReady" ||
            pointer.generation.linkConfigVersion !== entry.linkConfigVersion ||
            pointer.generation.effectivePolicyVersion !== entry.effectivePolicyVersion
          ) {
            return fail("GITHUB_CODE_SCAN_PUBLISH_CONFLICT");
          }
          snapshotEntries.push({
            projectRepositoryLinkId: entry.projectRepositoryLinkId,
            linkConfigVersion: entry.linkConfigVersion,
            effectivePolicyVersion: entry.effectivePolicyVersion,
            repositoryCodeGenerationId: pointer.repositoryCodeGenerationId,
            frozenCommitSha: pointer.generation.frozenCommitSha,
            generationManifestFingerprint: pointer.generation.manifestFingerprint,
          });
        }
        const manifestFingerprint = fingerprint("project-code-snapshot", {
          projectId,
          batchId,
          requiredManifestFingerprint: batch.requiredManifestFingerprint,
          entries: snapshotEntries,
        });
        const existingSnapshot = await tx.projectCodeSnapshot.findUnique({
          where: { projectId_manifestFingerprint: { projectId, manifestFingerprint } },
        });
        if (existingSnapshot !== null) {
          if (existingSnapshot.projectScanBatchId !== batchId || existingSnapshot.status !== "complete") {
            return fail("GITHUB_CODE_SCAN_INTEGRITY_ERROR");
          }
          snapshotId = existingSnapshot.id;
        } else {
          snapshotId = generatedUuid(idFactory);
          await tx.projectCodeSnapshot.create({
            data: {
              id: snapshotId,
              projectId,
              projectScanBatchId: batchId,
              status: "staging",
              manifestFingerprint,
              requiredLinkCount: snapshotEntries.length,
            },
          });
          if (snapshotEntries.length > 0) {
            await tx.projectCodeSnapshotEntry.createMany({
              data: snapshotEntries.map((entry) => ({
                id: generatedUuid(idFactory),
                projectId,
                projectCodeSnapshotId: snapshotId!,
                projectRepositoryLinkId: entry.projectRepositoryLinkId,
                linkConfigVersion: entry.linkConfigVersion,
                requiredForProjectSnapshot: true,
                effectivePolicyVersion: entry.effectivePolicyVersion,
                repositoryCodeGenerationId: entry.repositoryCodeGenerationId,
                frozenCommitSha: entry.frozenCommitSha,
                generationManifestFingerprint: entry.generationManifestFingerprint,
              })),
            });
          }
          await tx.projectCodeSnapshot.update({
            where: { id: snapshotId },
            data: { status: "complete", completedAt: now },
          });
        }
      }

      await tx.projectScanBatch.update({
        where: { projectId_id: { projectId, id: batchId } },
        data: {
          status,
          completedRequiredLinkCount: completedRequired,
          completedOptionalLinkCount: completedOptional,
          failureCode: batchFailureCode(status),
          completedAt: now,
        },
      });

      if (snapshotId !== null) {
        const currentPointer = await tx.projectCodeSnapshotPointer.findUnique({
          where: { projectId },
        });
        if ((currentPointer?.projectCodeSnapshotId ?? null) !== batch.expectedActiveCodeSnapshotId) {
          return fail("GITHUB_CODE_SCAN_PUBLISH_CONFLICT");
        }
        if (currentPointer === null) {
          await tx.projectCodeSnapshotPointer.create({
            data: { projectId, projectCodeSnapshotId: snapshotId, updatedAt: now },
          });
        } else if (currentPointer.projectCodeSnapshotId !== snapshotId) {
          await tx.projectCodeSnapshotPointer.update({
            where: { projectId },
            data: { projectCodeSnapshotId: snapshotId, updatedAt: now },
          });
        }
      }
      return readBatch(tx, projectId, batchId);
    });
  };

  const service: GitHubCodeScanService = {
    async prepareProjectScan(projectIdValue): Promise<ProjectCodeScanBatchView> {
      const projectId = canonicalUuid(projectIdValue);
      const batchId = generatedUuid(idFactory);
      const startedAt = safeDate(nowFactory);
      try {
        return await serializable(async (tx) => {
          const project = await tx.project.findUnique({
            where: { id: projectId },
            select: { id: true },
          });
          if (project === null) return fail("GITHUB_CODE_SCAN_PROJECT_NOT_FOUND");
          const pending = await tx.projectScanBatch.findFirst({
            where: { projectId, status: { in: ["queued", "running", "unknown"] } },
            select: { status: true },
          });
          if (pending?.status === "unknown") {
            return fail("GITHUB_CODE_SCAN_RECONCILIATION_REQUIRED");
          }
          if (pending !== null) return fail("GITHUB_CODE_SCAN_ALREADY_RUNNING");
          const rows = await tx.projectRepositoryLink.findMany({
            where: { projectId, status: "active" },
            orderBy: [{ id: "asc" }],
            include: {
              githubRepository: true,
              configPointer: { include: { config: true } },
              codeGenerationPointer: true,
            },
          });
          const links = (rows as EligibleLink[]).filter((row) => row.configPointer?.config.codeEnabled === true);
          if (links.length === 0) return fail("GITHUB_CODE_SCAN_NO_ELIGIBLE_REPOSITORIES");
          for (const link of links) {
            if (
              link.configPointer === null ||
              link.effectivePolicyVersion !== link.configPointer.effectivePolicyVersion ||
              link.configPointer.config.effectivePolicyVersion !== link.effectivePolicyVersion ||
              !FINGERPRINT_PATTERN.test(link.configPointer.config.scanScopeFingerprint)
            ) {
              return fail("GITHUB_CODE_SCAN_LINK_INELIGIBLE");
            }
          }
          const currentSnapshot = await tx.projectCodeSnapshotPointer.findUnique({
            where: { projectId },
            select: { projectCodeSnapshotId: true },
          });
          const requiredEntries = links
            .filter((link) => link.configPointer!.config.requiredForProjectSnapshot)
            .map((link) => ({
              linkId: link.id,
              configVersion: link.configPointer!.configVersion,
              effectivePolicyVersion: link.effectivePolicyVersion,
              trackedRef: link.configPointer!.config.trackedRef,
              scanScopeFingerprint: link.configPointer!.config.scanScopeFingerprint,
              githubRepositoryId: link.githubRepository.githubRepositoryId.toString(),
            }));
          const requiredManifestFingerprint = fingerprint(
            "required-repository-manifest",
            requiredEntries,
          );
          await tx.projectScanBatch.create({
            data: {
              id: batchId,
              projectId,
              expectedActiveCodeSnapshotId: currentSnapshot?.projectCodeSnapshotId ?? null,
              status: "queued",
              requiredManifestFingerprint,
              expectedRequiredLinkCount: requiredEntries.length,
              expectedOptionalLinkCount: links.length - requiredEntries.length,
              startedAt,
            },
          });
          await tx.projectScanBatchEntry.createMany({
            data: links.map((link) => ({
              id: generatedUuid(idFactory),
              projectId,
              projectScanBatchId: batchId,
              projectRepositoryLinkId: link.id,
              linkConfigVersion: link.configPointer!.configVersion,
              requiredForProjectSnapshot:
                link.configPointer!.config.requiredForProjectSnapshot,
              effectivePolicyVersion: link.effectivePolicyVersion,
            })),
          });
          await tx.repoCodeScanRun.createMany({
            data: links.map((link) => ({
              id: generatedUuid(idFactory),
              projectId,
              projectRepositoryLinkId: link.id,
              projectScanBatchId: batchId,
              linkConfigVersion: link.configPointer!.configVersion,
              expectedEffectivePolicyVersion: link.effectivePolicyVersion,
              expectedActiveGenerationId:
                link.codeGenerationPointer?.repositoryCodeGenerationId ?? null,
              operationKey: fingerprint("repository-code-scan-run", {
                projectId,
                batchId,
                projectRepositoryLinkId: link.id,
                configVersion: link.configPointer!.configVersion,
                effectivePolicyVersion: link.effectivePolicyVersion,
                expectedActiveGenerationId:
                  link.codeGenerationPointer?.repositoryCodeGenerationId ?? null,
                scanScopeFingerprint: link.configPointer!.config.scanScopeFingerprint,
              }),
              status: "queued",
              stage: "queued",
              startedAt,
            })),
          });
          return readBatch(tx, projectId, batchId);
        });
      } catch (error) {
        if (
          error instanceof GitHubCodeScanServiceError &&
          error.code === "GITHUB_CODE_SCAN_WRITE_CONFLICT"
        ) {
          const pending = await options.db.projectScanBatch.findFirst({
            where: { projectId, status: { in: ["queued", "running", "unknown"] } },
            select: { status: true },
          });
          if (pending?.status === "unknown") {
            return fail("GITHUB_CODE_SCAN_RECONCILIATION_REQUIRED");
          }
          if (pending !== null) return fail("GITHUB_CODE_SCAN_ALREADY_RUNNING");
        }
        throw error;
      }
    },

    async executeProjectScan(value): Promise<ProjectCodeScanBatchView> {
      const input = parseBatchInput(value);
      const current = await readBatch(options.db, input.projectId, input.batchId);
      if (current.status === "unknown") {
        return fail("GITHUB_CODE_SCAN_RECONCILIATION_REQUIRED");
      }
      if (current.runs.some((run) => run.status === "running" || run.status === "unknown")) {
        return fail("GITHUB_CODE_SCAN_ALREADY_RUNNING");
      }
      for (const run of current.runs) {
        if (run.status === "queued") await executeRun(input.projectId, run.id);
      }
      return finalizeBatch(input.projectId, input.batchId);
    },

    async scanProject(projectIdValue): Promise<ProjectCodeScanBatchView> {
      const prepared = await service.prepareProjectScan(projectIdValue);
      return service.executeProjectScan({ projectId: prepared.projectId, batchId: prepared.id });
    },

    async getProjectScan(value): Promise<ProjectCodeScanBatchView> {
      const input = parseBatchInput(value);
      return readBatch(options.db, input.projectId, input.batchId);
    },
  };
  return Object.freeze(service);
}
