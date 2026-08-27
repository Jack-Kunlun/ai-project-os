import { createHash, randomUUID } from "node:crypto";
import {
  Prisma,
  type PrismaClient,
} from "@prisma/client";
import {
  GITHUB_MATERIAL_SCANNER_FINGERPRINT,
  GITHUB_MATERIAL_SCANNER_VERSION,
  GitHubMaterialScanError,
  scanGitHubRepositoryMaterials,
  type GitHubMaterialKindValue,
  type GitHubMaterialScanPolicy,
  type GitHubMaterialScanResult,
  type ScannedGitHubMaterialSource,
} from "./material-scanner";
import {
  GITHUB_READ_ONLY_CLIENT_VERSION,
  GitHubReadError,
  type GitHubMaterialReadOnlyClient,
} from "./read-only-client";

export const GITHUB_MATERIAL_SYNC_SERVICE_VERSION =
  "github-material-sync-service:v1" as const;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const TRANSACTION_RETRY_LIMIT = 3;

export type GitHubMaterialSyncServiceErrorCode =
  | "GITHUB_MATERIAL_SYNC_INVALID_INPUT"
  | "GITHUB_MATERIAL_SYNC_PROJECT_NOT_FOUND"
  | "GITHUB_MATERIAL_SYNC_LINK_NOT_FOUND"
  | "GITHUB_MATERIAL_SYNC_RUN_NOT_FOUND"
  | "GITHUB_MATERIAL_SYNC_NO_MATERIAL_ENABLED"
  | "GITHUB_MATERIAL_SYNC_ALREADY_RUNNING"
  | "GITHUB_MATERIAL_SYNC_RECONCILIATION_REQUIRED"
  | "GITHUB_MATERIAL_SYNC_LINK_INELIGIBLE"
  | "GITHUB_MATERIAL_SYNC_PUBLISH_CONFLICT"
  | "GITHUB_MATERIAL_SYNC_INTEGRITY_ERROR"
  | "GITHUB_MATERIAL_SYNC_WRITE_CONFLICT";

export class GitHubMaterialSyncServiceError extends Error {
  constructor(readonly code: GitHubMaterialSyncServiceErrorCode) {
    super(code);
    this.name = "GitHubMaterialSyncServiceError";
  }
}

export type RepositoryMaterialSyncView = Readonly<{
  id: string;
  projectId: string;
  projectRepositoryLinkId: string;
  linkConfigVersion: number;
  expectedEffectivePolicyVersion: number;
  expectedActiveMaterialGenerationId: string | null;
  status: "queued" | "running" | "succeeded" | "partial" | "failed" | "rateLimited" | "unknown" | "cancelled";
  stage: "queued" | "freezing" | "fetching" | "scanning" | "publishing" | "terminal";
  observedHeadCommitSha: string | null;
  requestCount: number;
  fetchedObjectCount: number;
  publishedSourceCount: number;
  quarantineCount: number;
  failureCode: string | null;
  retryAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  repositoryMaterialGenerationId: string | null;
  activeMaterialGenerationId: string | null;
}>;

export interface GitHubMaterialSyncService {
  prepareRepositorySync(input: unknown): Promise<RepositoryMaterialSyncView>;
  executeRepositorySync(input: unknown): Promise<RepositoryMaterialSyncView>;
  syncRepository(input: unknown): Promise<RepositoryMaterialSyncView>;
  getRepositorySync(input: unknown): Promise<RepositoryMaterialSyncView>;
}

type TransactionRunner = <T>(
  callback: (tx: Prisma.TransactionClient) => Promise<T>,
  options: { isolationLevel: Prisma.TransactionIsolationLevel },
) => Promise<T>;

type EligibleLink = Readonly<{
  id: string;
  projectId: string;
  status: string;
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
      trackedRef: string;
      metadataEnabled: boolean;
      readmeEnabled: boolean;
      markdownEnabled: boolean;
      markdownPaths: unknown;
      issuesEnabled: boolean;
      pullRequestsEnabled: boolean;
      releasesEnabled: boolean;
      policyFingerprint: string;
      effectivePolicyVersion: number;
    }>;
  }> | null;
  materialGenerationPointer: Readonly<{
    repositoryMaterialGenerationId: string;
  }> | null;
}>;

type RunClaim = Readonly<{
  projectId: string;
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
  policy: GitHubMaterialScanPolicy;
}>;

type FailureDisposition = Readonly<{
  status: "failed" | "rateLimited";
  failureCode: string;
  retryAt: Date | null;
  invalidateLink: boolean;
}>;

type PersistedSource = Readonly<{
  source: ScannedGitHubMaterialSource;
  projectSourceId: string;
  githubSourceVersionId: string;
}>;

function fail(code: GitHubMaterialSyncServiceErrorCode): never {
  throw new GitHubMaterialSyncServiceError(code);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index]);
}

function canonicalUuid(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    return fail("GITHUB_MATERIAL_SYNC_INVALID_INPUT");
  }
  return value;
}

function parseLinkInput(value: unknown): Readonly<{ projectId: string; linkId: string }> {
  if (!isPlainRecord(value) || !exactKeys(value, ["linkId", "projectId"])) {
    return fail("GITHUB_MATERIAL_SYNC_INVALID_INPUT");
  }
  return Object.freeze({
    projectId: canonicalUuid(value.projectId),
    linkId: canonicalUuid(value.linkId),
  });
}

function parseRunInput(value: unknown): Readonly<{ projectId: string; runId: string }> {
  if (!isPlainRecord(value) || !exactKeys(value, ["projectId", "runId"])) {
    return fail("GITHUB_MATERIAL_SYNC_INVALID_INPUT");
  }
  return Object.freeze({
    projectId: canonicalUuid(value.projectId),
    runId: canonicalUuid(value.runId),
  });
}

function generatedUuid(factory: () => string): string {
  return canonicalUuid(factory());
}

function safeDate(factory: () => Date): Date {
  const value = factory();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    return fail("GITHUB_MATERIAL_SYNC_INVALID_INPUT");
  }
  return new Date(value.getTime());
}

function fingerprint(label: string, value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify({
      version: GITHUB_MATERIAL_SYNC_SERVICE_VERSION,
      label,
      value,
    }), "utf8")
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

function safeRepositoryId(value: bigint): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || BigInt(parsed) !== value) {
    return fail("GITHUB_MATERIAL_SYNC_INTEGRITY_ERROR");
  }
  return parsed;
}

function materialPolicy(config: EligibleLink["configPointer"] extends infer T
  ? T extends { config: infer C } ? C : never
  : never): GitHubMaterialScanPolicy {
  if (!Array.isArray(config.markdownPaths)) {
    return fail("GITHUB_MATERIAL_SYNC_INTEGRITY_ERROR");
  }
  const paths = config.markdownPaths.map((entry) => {
    if (typeof entry !== "string") return fail("GITHUB_MATERIAL_SYNC_INTEGRITY_ERROR");
    return entry;
  });
  if (
    Object.keys(config.markdownPaths).length !== config.markdownPaths.length ||
    new Set(paths).size !== paths.length ||
    config.markdownEnabled !== (paths.length > 0) ||
    !FINGERPRINT_PATTERN.test(config.policyFingerprint)
  ) {
    return fail("GITHUB_MATERIAL_SYNC_INTEGRITY_ERROR");
  }
  if (
    config.metadataEnabled !== true &&
    config.readmeEnabled !== true &&
    config.markdownEnabled !== true &&
    config.issuesEnabled !== true &&
    config.pullRequestsEnabled !== true &&
    config.releasesEnabled !== true
  ) {
    return fail("GITHUB_MATERIAL_SYNC_NO_MATERIAL_ENABLED");
  }
  return Object.freeze({
    metadataEnabled: config.metadataEnabled,
    readmeEnabled: config.readmeEnabled,
    markdownEnabled: config.markdownEnabled,
    markdownPaths: Object.freeze([...paths].sort()),
    issuesEnabled: config.issuesEnabled,
    pullRequestsEnabled: config.pullRequestsEnabled,
    releasesEnabled: config.releasesEnabled,
    policyFingerprint: config.policyFingerprint,
  });
}

function failureDisposition(error: unknown, now: Date): FailureDisposition {
  if (error instanceof GitHubReadError) {
    if (error.code === "GITHUB_RATE_LIMITED") {
      const headerTime = error.retryAtEpochSeconds === null
        ? now.getTime() + 60_000
        : error.retryAtEpochSeconds * 1_000;
      return Object.freeze({
        status: "rateLimited",
        failureCode: "GITHUB_RATE_LIMITED",
        retryAt: new Date(Math.max(headerTime, now.getTime() + 1_000)),
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
  if (error instanceof GitHubMaterialScanError) {
    return Object.freeze({
      status: "failed",
      failureCode: error.code,
      retryAt: null,
      invalidateLink: error.code === "GITHUB_MATERIAL_SCAN_IDENTITY_MISMATCH",
    });
  }
  return Object.freeze({
    status: "failed",
    failureCode: "GITHUB_MATERIAL_SCAN_SCANNER_UNAVAILABLE",
    retryAt: null,
    invalidateLink: false,
  });
}

function databaseMaterialKind(kind: GitHubMaterialKindValue): string {
  if (kind === "repositoryMetadata") return "repository_metadata";
  if (kind === "pullRequest") return "pull_request";
  return kind;
}

function entryManifest(entries: readonly Readonly<{
  id: string;
  githubSourceVersionId: string;
  projectSourceId: string;
  ordinal: number;
  materialKind: GitHubMaterialKindValue;
  sourceContentHash: string;
  sourceContentBytes: number;
}>[]): string {
  const text = entries.map((entry) => [
    entry.ordinal.toString(),
    entry.id,
    entry.githubSourceVersionId,
    entry.projectSourceId,
    databaseMaterialKind(entry.materialKind),
    entry.sourceContentHash,
    entry.sourceContentBytes.toString(),
  ].join("\u001f")).join("\u001e");
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const RUN_INCLUDE = Prisma.validator<Prisma.GitHubMaterialSyncRunInclude>()({
  producedGeneration: { select: { id: true } },
  repositoryLink: {
    include: {
      materialGenerationPointer: { select: { repositoryMaterialGenerationId: true } },
    },
  },
});

function runView(row: Readonly<{
  id: string;
  projectId: string;
  projectRepositoryLinkId: string;
  linkConfigVersion: number;
  expectedEffectivePolicyVersion: number;
  expectedActiveMaterialGenerationId: string | null;
  status: RepositoryMaterialSyncView["status"];
  stage: RepositoryMaterialSyncView["stage"];
  observedHeadCommitSha: string | null;
  requestCount: number;
  fetchedObjectCount: number;
  publishedSourceCount: number;
  quarantineCount: number;
  failureCode: string | null;
  retryAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  producedGeneration: { id: string } | null;
  repositoryLink: {
    materialGenerationPointer: { repositoryMaterialGenerationId: string } | null;
  };
}>): RepositoryMaterialSyncView {
  return Object.freeze({
    id: row.id,
    projectId: row.projectId,
    projectRepositoryLinkId: row.projectRepositoryLinkId,
    linkConfigVersion: row.linkConfigVersion,
    expectedEffectivePolicyVersion: row.expectedEffectivePolicyVersion,
    expectedActiveMaterialGenerationId: row.expectedActiveMaterialGenerationId,
    status: row.status,
    stage: row.stage,
    observedHeadCommitSha: row.observedHeadCommitSha,
    requestCount: row.requestCount,
    fetchedObjectCount: row.fetchedObjectCount,
    publishedSourceCount: row.publishedSourceCount,
    quarantineCount: row.quarantineCount,
    failureCode: row.failureCode,
    retryAt: row.retryAt?.toISOString() ?? null,
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    repositoryMaterialGenerationId: row.producedGeneration?.id ?? null,
    activeMaterialGenerationId:
      row.repositoryLink.materialGenerationPointer?.repositoryMaterialGenerationId ?? null,
  });
}

export function createGitHubMaterialSyncService(options: Readonly<{
  db: PrismaClient;
  client: GitHubMaterialReadOnlyClient;
  idFactory?: () => string;
  now?: () => Date;
}>): GitHubMaterialSyncService {
  if (
    typeof options !== "object" ||
    options === null ||
    typeof options.db?.$transaction !== "function" ||
    options.client?.version !== GITHUB_READ_ONLY_CLIENT_VERSION ||
    (options.idFactory !== undefined && typeof options.idFactory !== "function") ||
    (options.now !== undefined && typeof options.now !== "function")
  ) {
    return fail("GITHUB_MATERIAL_SYNC_INVALID_INPUT");
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
        if (error instanceof GitHubMaterialSyncServiceError) throw error;
        if (
          (isPrismaCode(error, "P2002") || isPrismaCode(error, "P2034")) &&
          attempt + 1 < TRANSACTION_RETRY_LIMIT
        ) {
          continue;
        }
        if (isPrismaCode(error, "P2002") || isPrismaCode(error, "P2034")) {
          return fail("GITHUB_MATERIAL_SYNC_WRITE_CONFLICT");
        }
        if (isPrismaCode(error, "P2003") || isPrismaCode(error, "P2010")) {
          return fail("GITHUB_MATERIAL_SYNC_INTEGRITY_ERROR");
        }
        throw error;
      }
    }
    return fail("GITHUB_MATERIAL_SYNC_WRITE_CONFLICT");
  };

  const readRun = async (
    db: Prisma.TransactionClient | PrismaClient,
    projectId: string,
    runId: string,
  ): Promise<RepositoryMaterialSyncView> => {
    const row = await db.gitHubMaterialSyncRun.findUnique({
      where: { projectId_id: { projectId, id: runId } },
      include: RUN_INCLUDE,
    });
    if (row === null) return fail("GITHUB_MATERIAL_SYNC_RUN_NOT_FOUND");
    return runView(row as Parameters<typeof runView>[0]);
  };

  const settleQueuedIneligible = async (projectId: string, runId: string): Promise<void> => {
    const now = safeDate(nowFactory);
    await serializable(async (tx) => {
      const run = await tx.gitHubMaterialSyncRun.findUnique({
        where: { projectId_id: { projectId, id: runId } },
      });
      if (run === null) return fail("GITHUB_MATERIAL_SYNC_RUN_NOT_FOUND");
      if (run.status !== "queued") return;
      await tx.gitHubMaterialSyncRun.update({
        where: { id: run.id },
        data: { status: "running", stage: "freezing", startedAt: now },
      });
      await tx.gitHubMaterialSyncRun.update({
        where: { id: run.id },
        data: {
          status: "failed",
          stage: "terminal",
          failureCode: "GITHUB_MATERIAL_SYNC_LINK_INELIGIBLE",
          completedAt: now,
        },
      });
    });
  };

  const settleFailure = async (
    claim: RunClaim,
    disposition: FailureDisposition,
  ): Promise<void> => {
    const now = safeDate(nowFactory);
    await serializable(async (tx) => {
      const run = await tx.gitHubMaterialSyncRun.findUnique({
        where: { projectId_id: { projectId: claim.projectId, id: claim.runId } },
      });
      if (run === null) return fail("GITHUB_MATERIAL_SYNC_RUN_NOT_FOUND");
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
      await tx.gitHubMaterialSyncRun.update({
        where: { id: run.id },
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

  const setRunStage = async (
    claim: RunClaim,
    stage: "fetching" | "scanning",
  ): Promise<void> => {
    await serializable(async (tx) => {
      const updated = await tx.gitHubMaterialSyncRun.updateMany({
        where: {
          projectId: claim.projectId,
          id: claim.runId,
          status: "running",
        },
        data: { stage },
      });
      if (updated.count !== 1) return fail("GITHUB_MATERIAL_SYNC_PUBLISH_CONFLICT");
    });
  };

  const claimRun = async (projectId: string, runId: string): Promise<RunClaim> => {
    return serializable(async (tx) => {
      const run = await tx.gitHubMaterialSyncRun.findUnique({
        where: { projectId_id: { projectId, id: runId } },
        include: {
          repositoryLink: {
            include: {
              githubRepository: true,
              configPointer: { include: { config: true } },
              materialGenerationPointer: true,
            },
          },
        },
      });
      if (run === null) return fail("GITHUB_MATERIAL_SYNC_RUN_NOT_FOUND");
      if (run.status === "running") return fail("GITHUB_MATERIAL_SYNC_ALREADY_RUNNING");
      if (run.status === "unknown") {
        return fail("GITHUB_MATERIAL_SYNC_RECONCILIATION_REQUIRED");
      }
      if (run.status !== "queued") return fail("GITHUB_MATERIAL_SYNC_PUBLISH_CONFLICT");
      const link = run.repositoryLink as EligibleLink;
      const pointer = link.configPointer;
      if (
        link.status !== "active" ||
        pointer === null ||
        link.effectivePolicyVersion !== run.expectedEffectivePolicyVersion ||
        pointer.configVersion !== run.linkConfigVersion ||
        pointer.effectivePolicyVersion !== run.expectedEffectivePolicyVersion ||
        pointer.config.effectivePolicyVersion !== run.expectedEffectivePolicyVersion ||
        (link.materialGenerationPointer?.repositoryMaterialGenerationId ?? null) !==
          run.expectedActiveMaterialGenerationId
      ) {
        return fail("GITHUB_MATERIAL_SYNC_LINK_INELIGIBLE");
      }
      const claim = Object.freeze({
        projectId,
        runId,
        projectRepositoryLinkId: link.id,
        linkConfigVersion: run.linkConfigVersion,
        expectedEffectivePolicyVersion: run.expectedEffectivePolicyVersion,
        expectedActiveGenerationId: run.expectedActiveMaterialGenerationId,
        owner: link.githubRepository.currentOwner,
        repository: link.githubRepository.currentName,
        expectedRepositoryId: safeRepositoryId(link.githubRepository.githubRepositoryId),
        expectedNodeId: link.githubRepository.nodeId,
        trackedRef: pointer.config.trackedRef,
        policy: materialPolicy(pointer.config),
      });
      await tx.gitHubMaterialSyncRun.update({
        where: { id: run.id },
        data: {
          status: "running",
          stage: "freezing",
          startedAt: safeDate(nowFactory),
        },
      });
      return claim;
    });
  };

  const publishResult = async (
    claim: RunClaim,
    result: GitHubMaterialScanResult,
  ): Promise<void> => {
    const now = safeDate(nowFactory);
    await serializable(async (tx) => {
      const run = await tx.gitHubMaterialSyncRun.findUnique({
        where: { projectId_id: { projectId: claim.projectId, id: claim.runId } },
        include: {
          repositoryLink: {
            include: {
              githubRepository: true,
              configPointer: { include: { config: true } },
              materialGenerationPointer: true,
            },
          },
        },
      });
      if (run === null) return fail("GITHUB_MATERIAL_SYNC_RUN_NOT_FOUND");
      const link = run.repositoryLink as EligibleLink;
      const configPointer = link.configPointer;
      if (
        run.status !== "running" ||
        configPointer === null ||
        link.status !== "active" ||
        link.effectivePolicyVersion !== claim.expectedEffectivePolicyVersion ||
        configPointer.configVersion !== claim.linkConfigVersion ||
        configPointer.effectivePolicyVersion !== claim.expectedEffectivePolicyVersion ||
        configPointer.config.effectivePolicyVersion !== claim.expectedEffectivePolicyVersion ||
        (link.materialGenerationPointer?.repositoryMaterialGenerationId ?? null) !==
          claim.expectedActiveGenerationId ||
        result.contractVersion !== GITHUB_MATERIAL_SCANNER_VERSION ||
        result.scannerFingerprint !== GITHUB_MATERIAL_SCANNER_FINGERPRINT ||
        result.policyFingerprint !== claim.policy.policyFingerprint ||
        result.repository.repositoryId !== claim.expectedRepositoryId ||
        result.repository.nodeId !== claim.expectedNodeId ||
        result.repository.owner.toLowerCase() !== claim.owner.toLowerCase() ||
        result.repository.name.toLowerCase() !== claim.repository.toLowerCase() ||
        result.repository.capturedFullName.toLowerCase() !==
          `${claim.owner}/${claim.repository}`.toLowerCase() ||
        result.trackedRef !== claim.trackedRef ||
        !SHA_PATTERN.test(result.observedHeadCommitSha) ||
        !FINGERPRINT_PATTERN.test(result.sourceSetFingerprint)
      ) {
        return fail("GITHUB_MATERIAL_SYNC_PUBLISH_CONFLICT");
      }
      const decodedTextBytes = result.sources.reduce((total, source) => {
        if (
          !FINGERPRINT_PATTERN.test(source.remoteRevisionFingerprint) ||
          !FINGERPRINT_PATTERN.test(source.contentHash) ||
          Buffer.byteLength(source.contentText, "utf8") !== source.contentBytes ||
          createHash("sha256").update(source.contentText, "utf8").digest("hex") !== source.contentHash ||
          !Number.isSafeInteger(source.contentBytes) ||
          source.contentBytes < 1
        ) {
          return fail("GITHUB_MATERIAL_SYNC_INTEGRITY_ERROR");
        }
        return total + source.contentBytes;
      }, 0);
      if (
        decodedTextBytes !== result.decodedTextBytes ||
        result.quarantines.some((entry) =>
          !FINGERPRINT_PATTERN.test(entry.remoteIdentityFingerprint))
      ) {
        return fail("GITHUB_MATERIAL_SYNC_INTEGRITY_ERROR");
      }

      await tx.gitHubMaterialSyncRun.update({
        where: { id: run.id },
        data: { stage: "publishing" },
      });
      const persisted: PersistedSource[] = [];
      for (const source of result.sources) {
        const existing = await tx.gitHubSourceVersion.findFirst({
          where: {
            projectId: claim.projectId,
            projectRepositoryLinkId: claim.projectRepositoryLinkId,
            remoteIdentity: source.remoteIdentity,
            remoteRevisionFingerprint: source.remoteRevisionFingerprint,
          },
          include: { projectSource: true },
        });
        if (existing !== null) {
          if (
            existing.materialKind !== source.materialKind ||
            existing.remoteNumber !== source.remoteNumber ||
            existing.normalizedPath !== source.normalizedPath ||
            existing.capturedGitHubRepositoryId !== BigInt(claim.expectedRepositoryId) ||
            existing.sourceContentHash !== source.contentHash ||
            existing.sourceContentBytes !== source.contentBytes ||
            existing.projectSource.contentText !== source.contentText
          ) {
            return fail("GITHUB_MATERIAL_SYNC_INTEGRITY_ERROR");
          }
          persisted.push(Object.freeze({
            source,
            projectSourceId: existing.projectSourceId,
            githubSourceVersionId: existing.id,
          }));
          continue;
        }
        const previous = await tx.gitHubSourceVersion.findFirst({
          where: {
            projectId: claim.projectId,
            projectRepositoryLinkId: claim.projectRepositoryLinkId,
            remoteIdentity: source.remoteIdentity,
          },
          orderBy: [{ capturedAt: "desc" }, { id: "desc" }],
          include: { projectSource: { select: { sourceIdentity: true } } },
        });
        const projectSourceId = generatedUuid(idFactory);
        const sourceRevisionKey = generatedUuid(idFactory);
        const sourceIdentity = previous?.projectSource.sourceIdentity ?? generatedUuid(idFactory);
        const capturedAt = new Date(source.capturedAt);
        if (!Number.isFinite(capturedAt.getTime())) {
          return fail("GITHUB_MATERIAL_SYNC_INTEGRITY_ERROR");
        }
        await tx.projectSource.create({
          data: {
            id: projectSourceId,
            projectId: claim.projectId,
            kind: "github",
            originScope: "repository_link",
            projectRepositoryLinkId: claim.projectRepositoryLinkId,
            sourceIdentity,
            revisionKey: sourceRevisionKey,
            externalRef: source.externalRef,
            contentText: source.contentText,
            contentHash: source.contentHash,
            capturedAt,
            ingestedAt: now,
          },
        });
        const sourceVersionId = generatedUuid(idFactory);
        await tx.gitHubSourceVersion.create({
          data: {
            id: sourceVersionId,
            projectId: claim.projectId,
            projectRepositoryLinkId: claim.projectRepositoryLinkId,
            projectSourceId,
            sourceRevisionKey,
            materialKind: source.materialKind,
            remoteIdentity: source.remoteIdentity,
            remoteRevisionFingerprint: source.remoteRevisionFingerprint,
            remoteNumber: source.remoteNumber,
            normalizedPath: source.normalizedPath,
            capturedGitHubRepositoryId: BigInt(claim.expectedRepositoryId),
            capturedFullName: result.repository.capturedFullName,
            observedHeadCommitSha: result.observedHeadCommitSha,
            sourceContentHash: source.contentHash,
            sourceContentBytes: source.contentBytes,
            capturedAt,
          },
        });
        persisted.push(Object.freeze({ source, projectSourceId, githubSourceVersionId: sourceVersionId }));
      }

      if (result.quarantines.length > 0) {
        await tx.gitHubMaterialQuarantine.createMany({
          data: result.quarantines.map((entry) => ({
            id: generatedUuid(idFactory),
            projectId: claim.projectId,
            projectRepositoryLinkId: claim.projectRepositoryLinkId,
            githubMaterialSyncRunId: claim.runId,
            materialKind: entry.materialKind,
            remoteIdentityFingerprint: entry.remoteIdentityFingerprint,
            reasonCode: entry.reasonCode,
          })),
        });
      }

      const generationId = generatedUuid(idFactory);
      const entries = persisted.map((entry, ordinal) => Object.freeze({
        id: generatedUuid(idFactory),
        githubSourceVersionId: entry.githubSourceVersionId,
        projectSourceId: entry.projectSourceId,
        ordinal,
        materialKind: entry.source.materialKind,
        sourceContentHash: entry.source.contentHash,
        sourceContentBytes: entry.source.contentBytes,
      }));
      const manifestFingerprint = entryManifest(entries);
      const generationKey = fingerprint("repository-material-generation", {
        projectId: claim.projectId,
        projectRepositoryLinkId: claim.projectRepositoryLinkId,
        runId: claim.runId,
        linkConfigVersion: claim.linkConfigVersion,
        effectivePolicyVersion: claim.expectedEffectivePolicyVersion,
        observedHeadCommitSha: result.observedHeadCommitSha,
        scannerFingerprint: result.scannerFingerprint,
        policyFingerprint: result.policyFingerprint,
        sourceSetFingerprint: result.sourceSetFingerprint,
      });
      await tx.repositoryMaterialGeneration.create({
        data: {
          id: generationId,
          projectId: claim.projectId,
          projectRepositoryLinkId: claim.projectRepositoryLinkId,
          linkConfigVersion: claim.linkConfigVersion,
          githubMaterialSyncRunId: claim.runId,
          status: "staging",
          generationKey,
          capturedGitHubRepositoryId: BigInt(claim.expectedRepositoryId),
          capturedFullName: result.repository.capturedFullName,
          observedHeadCommitSha: result.observedHeadCommitSha,
          effectivePolicyVersion: claim.expectedEffectivePolicyVersion,
          manifestFingerprint,
          enabledClassManifest: result.enabledClassManifest as Prisma.InputJsonValue,
          coverageManifest: result.coverageManifest as Prisma.InputJsonValue,
          scannerVersion: result.contractVersion,
          scannerFingerprint: result.scannerFingerprint,
          sourceCount: entries.length,
          decodedTextBytes,
        },
      });
      if (entries.length > 0) {
        await tx.repositoryMaterialGenerationEntry.createMany({
          data: entries.map((entry) => ({
            ...entry,
            projectId: claim.projectId,
            projectRepositoryLinkId: claim.projectRepositoryLinkId,
            repositoryMaterialGenerationId: generationId,
          })),
        });
      }
      await tx.repositoryMaterialGeneration.update({
        where: { id: generationId },
        data: { status: "complete", completedAt: now },
      });
      await tx.gitHubMaterialSyncRun.update({
        where: { id: run.id },
        data: {
          status: "succeeded",
          stage: "terminal",
          observedHeadCommitSha: result.observedHeadCommitSha,
          requestCount: result.requestCount,
          fetchedObjectCount: result.fetchedObjectCount,
          publishedSourceCount: entries.length,
          quarantineCount: result.quarantines.length,
          failureCode: null,
          retryAt: null,
          completedAt: now,
        },
      });
      if (claim.expectedActiveGenerationId === null) {
        await tx.repositoryMaterialGenerationPointer.create({
          data: {
            projectId: claim.projectId,
            projectRepositoryLinkId: claim.projectRepositoryLinkId,
            repositoryMaterialGenerationId: generationId,
            linkConfigVersion: claim.linkConfigVersion,
            effectivePolicyVersion: claim.expectedEffectivePolicyVersion,
            updatedAt: now,
          },
        });
      } else {
        await tx.repositoryMaterialGenerationPointer.update({
          where: {
            projectId_projectRepositoryLinkId: {
              projectId: claim.projectId,
              projectRepositoryLinkId: claim.projectRepositoryLinkId,
            },
          },
          data: {
            repositoryMaterialGenerationId: generationId,
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
        error instanceof GitHubMaterialSyncServiceError &&
        error.code === "GITHUB_MATERIAL_SYNC_LINK_INELIGIBLE"
      ) {
        await settleQueuedIneligible(projectId, runId);
        return;
      }
      throw error;
    }
    let result: GitHubMaterialScanResult;
    try {
      await setRunStage(claim, "fetching");
      result = await scanGitHubRepositoryMaterials({
        client: options.client,
        owner: claim.owner,
        repository: claim.repository,
        expectedRepositoryId: claim.expectedRepositoryId,
        expectedNodeId: claim.expectedNodeId,
        trackedRef: claim.trackedRef,
        policy: claim.policy,
      });
      await setRunStage(claim, "scanning");
    } catch (error) {
      await settleFailure(claim, failureDisposition(error, safeDate(nowFactory)));
      return;
    }
    try {
      await publishResult(claim, result);
    } catch (error) {
      if (
        error instanceof GitHubMaterialSyncServiceError &&
        [
          "GITHUB_MATERIAL_SYNC_PUBLISH_CONFLICT",
          "GITHUB_MATERIAL_SYNC_INTEGRITY_ERROR",
          "GITHUB_MATERIAL_SYNC_WRITE_CONFLICT",
        ].includes(error.code)
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

  const service: GitHubMaterialSyncService = {
    async prepareRepositorySync(value): Promise<RepositoryMaterialSyncView> {
      const input = parseLinkInput(value);
      const runId = generatedUuid(idFactory);
      const operationKey = fingerprint("repository-material-sync-run", {
        runId,
        projectId: input.projectId,
        projectRepositoryLinkId: input.linkId,
      });
      try {
        return await serializable(async (tx) => {
          const project = await tx.project.findUnique({
            where: { id: input.projectId },
            select: { id: true },
          });
          if (project === null) return fail("GITHUB_MATERIAL_SYNC_PROJECT_NOT_FOUND");
          const pending = await tx.gitHubMaterialSyncRun.findFirst({
            where: {
              projectId: input.projectId,
              projectRepositoryLinkId: input.linkId,
              status: { in: ["queued", "running", "unknown"] },
            },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          });
          if (pending?.status === "unknown") {
            return fail("GITHUB_MATERIAL_SYNC_RECONCILIATION_REQUIRED");
          }
          if (pending?.status === "running") {
            return fail("GITHUB_MATERIAL_SYNC_ALREADY_RUNNING");
          }
          if (pending !== null) return readRun(tx, input.projectId, pending.id);
          const row = await tx.projectRepositoryLink.findUnique({
            where: { projectId_id: { projectId: input.projectId, id: input.linkId } },
            include: {
              githubRepository: true,
              configPointer: { include: { config: true } },
              materialGenerationPointer: true,
            },
          });
          if (row === null) return fail("GITHUB_MATERIAL_SYNC_LINK_NOT_FOUND");
          const link = row as EligibleLink;
          const pointer = link.configPointer;
          if (
            link.status !== "active" ||
            pointer === null ||
            link.effectivePolicyVersion !== pointer.effectivePolicyVersion ||
            pointer.config.effectivePolicyVersion !== link.effectivePolicyVersion
          ) {
            return fail("GITHUB_MATERIAL_SYNC_LINK_INELIGIBLE");
          }
          materialPolicy(pointer.config);
          await tx.gitHubMaterialSyncRun.create({
            data: {
              id: runId,
              projectId: input.projectId,
              projectRepositoryLinkId: input.linkId,
              linkConfigVersion: pointer.configVersion,
              expectedEffectivePolicyVersion: link.effectivePolicyVersion,
              expectedActiveMaterialGenerationId:
                link.materialGenerationPointer?.repositoryMaterialGenerationId ?? null,
              operationKey,
              status: "queued",
              stage: "queued",
            },
          });
          return readRun(tx, input.projectId, runId);
        });
      } catch (error) {
        if (
          error instanceof GitHubMaterialSyncServiceError &&
          error.code === "GITHUB_MATERIAL_SYNC_WRITE_CONFLICT"
        ) {
          const pending = await options.db.gitHubMaterialSyncRun.findFirst({
            where: {
              projectId: input.projectId,
              projectRepositoryLinkId: input.linkId,
              status: { in: ["queued", "running", "unknown"] },
            },
            select: { id: true, status: true },
          });
          if (pending?.status === "unknown") {
            return fail("GITHUB_MATERIAL_SYNC_RECONCILIATION_REQUIRED");
          }
          if (pending?.status === "running") {
            return fail("GITHUB_MATERIAL_SYNC_ALREADY_RUNNING");
          }
          if (pending !== null) return readRun(options.db, input.projectId, pending.id);
        }
        throw error;
      }
    },

    async executeRepositorySync(value): Promise<RepositoryMaterialSyncView> {
      const input = parseRunInput(value);
      const current = await readRun(options.db, input.projectId, input.runId);
      if (current.status === "unknown") {
        return fail("GITHUB_MATERIAL_SYNC_RECONCILIATION_REQUIRED");
      }
      if (current.status === "running") {
        return fail("GITHUB_MATERIAL_SYNC_ALREADY_RUNNING");
      }
      if (current.status !== "queued") return current;
      await executeRun(input.projectId, input.runId);
      return readRun(options.db, input.projectId, input.runId);
    },

    async syncRepository(value): Promise<RepositoryMaterialSyncView> {
      const input = parseLinkInput(value);
      const prepared = await service.prepareRepositorySync(input);
      return service.executeRepositorySync({
        projectId: prepared.projectId,
        runId: prepared.id,
      });
    },

    async getRepositorySync(value): Promise<RepositoryMaterialSyncView> {
      const input = parseRunInput(value);
      return readRun(options.db, input.projectId, input.runId);
    },
  };
  return Object.freeze(service);
}
