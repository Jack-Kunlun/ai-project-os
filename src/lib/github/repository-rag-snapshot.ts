import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  EMBEDDING_STORAGE_PROFILE_FINGERPRINT,
  EMBEDDING_STORAGE_PROFILE_ID,
} from "@/lib/ai-memory/corpus-index";

export const REPOSITORY_RAG_SNAPSHOT_VERSION =
  "repository-rag-snapshot:v1" as const;
export const PROJECT_REPOSITORY_RAG_SNAPSHOT_VERSION =
  "project-repository-rag-snapshot:v1" as const;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const DEFAULT_RETRY_LIMIT = 3;

export type RepositoryRagSnapshotErrorCode =
  | "REPOSITORY_RAG_SNAPSHOT_INVALID_INPUT"
  | "REPOSITORY_RAG_SNAPSHOT_PROJECT_NOT_FOUND"
  | "REPOSITORY_RAG_SNAPSHOT_LINK_NOT_FOUND"
  | "REPOSITORY_RAG_SNAPSHOT_LINK_INELIGIBLE"
  | "REPOSITORY_RAG_SNAPSHOT_POLICY_INELIGIBLE"
  | "REPOSITORY_RAG_SNAPSHOT_INDEX_NOT_READY"
  | "REPOSITORY_RAG_SNAPSHOT_REQUIRED_REPOSITORIES_NOT_CONFIGURED"
  | "REPOSITORY_RAG_SNAPSHOT_NOT_FOUND"
  | "REPOSITORY_RAG_SNAPSHOT_BOUNDARY_CONFLICT"
  | "REPOSITORY_RAG_SNAPSHOT_WRITE_CONFLICT";

export class RepositoryRagSnapshotError extends Error {
  constructor(readonly code: RepositoryRagSnapshotErrorCode) {
    super(code);
    this.name = "RepositoryRagSnapshotError";
  }
}

export type RepositoryRagSnapshotView = Readonly<{
  id: string;
  projectId: string;
  projectRepositoryLinkId: string;
  linkConfigVersion: number;
  linkEffectivePolicyVersion: number;
  requiredForProjectSnapshot: boolean;
  policyRevisionId: string;
  aiEffectivePolicyVersion: number;
  embeddingProfileId: string;
  codeIndexGenerationId: string | null;
  repositoryCodeGenerationId: string | null;
  materialIndexGenerationId: string | null;
  repositoryMaterialGenerationId: string | null;
  capturedGitHubRepositoryId: string;
  capturedFullName: string;
  frozenCommitSha: string;
  manifestFingerprint: string;
  completedAt: Date;
  publishedAt: Date;
}>;

export type ProjectRepositoryRagSnapshotView = Readonly<{
  id: string;
  projectId: string;
  manualRagSnapshotId: string | null;
  manualManifestFingerprint: string | null;
  policyRevisionId: string;
  effectivePolicyVersion: number;
  manifestFingerprint: string;
  requiredRepositoryCount: number;
  completedAt: Date;
  publishedAt: Date;
  repositories: readonly Readonly<{
    ordinal: number;
    projectRepositoryLinkId: string;
    repositoryRagSnapshotId: string;
    repositoryManifestFingerprint: string;
  }>[];
}>;

export type RepositoryRagSnapshotService = Readonly<{
  publishRepository(input: Readonly<{
    projectId: string;
    projectRepositoryLinkId: string;
  }>): Promise<RepositoryRagSnapshotView>;
  publishProject(input: Readonly<{
    projectId: string;
  }>): Promise<ProjectRepositoryRagSnapshotView>;
  getRepositorySnapshot(input: Readonly<{
    projectId: string;
    projectRepositoryLinkId: string;
  }>): Promise<RepositoryRagSnapshotView>;
  getProjectSnapshot(input: Readonly<{
    projectId: string;
  }>): Promise<ProjectRepositoryRagSnapshotView>;
}>;

type RepositoryBoundary = Readonly<{
  projectId: string;
  projectRepositoryLinkId: string;
  linkConfigVersion: number;
  linkEffectivePolicyVersion: number;
  requiredForProjectSnapshot: boolean;
  policyRevisionId: string;
  aiEffectivePolicyVersion: number;
  embeddingProfileId: string;
  codeIndexGenerationId: string | null;
  repositoryCodeGenerationId: string | null;
  materialIndexGenerationId: string | null;
  repositoryMaterialGenerationId: string | null;
  capturedGitHubRepositoryId: bigint;
  capturedFullName: string;
  frozenCommitSha: string;
}>;

type ManualSnapshotRow = {
  id: string;
  manifestFingerprint: string;
};

function fail(code: RepositoryRagSnapshotErrorCode): never {
  throw new RepositoryRagSnapshotError(code);
}

function frozen<T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}

function canonicalUuid(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    return fail("REPOSITORY_RAG_SNAPSHOT_INVALID_INPUT");
  }
  return value;
}

function canonicalDate(value: unknown): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    return fail("REPOSITORY_RAG_SNAPSHOT_INVALID_INPUT");
  }
  return new Date(value.getTime());
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalRow(fields: readonly (string | number | boolean)[]): string {
  return fields.map(String).join("\x1f");
}

function repositoryManifest(boundary: RepositoryBoundary): string {
  return sha256(canonicalRow([
    REPOSITORY_RAG_SNAPSHOT_VERSION,
    boundary.projectId,
    boundary.projectRepositoryLinkId,
    boundary.linkConfigVersion,
    boundary.linkEffectivePolicyVersion,
    boundary.requiredForProjectSnapshot,
    boundary.policyRevisionId,
    boundary.embeddingProfileId,
    boundary.codeIndexGenerationId ?? "none",
    boundary.repositoryCodeGenerationId ?? "none",
    boundary.materialIndexGenerationId ?? "none",
    boundary.repositoryMaterialGenerationId ?? "none",
    boundary.capturedGitHubRepositoryId.toString(),
    boundary.capturedFullName,
    boundary.frozenCommitSha,
  ]));
}

function projectManifest(input: Readonly<{
  projectId: string;
  policyRevisionId: string;
  effectivePolicyVersion: number;
  manualRagSnapshotId: string | null;
  manualManifestFingerprint: string | null;
  repositories: readonly Readonly<{
    ordinal: number;
    projectRepositoryLinkId: string;
    repositoryRagSnapshotId: string;
    repositoryManifestFingerprint: string;
  }>[];
}>): string {
  const repositoryRows = input.repositories.map((entry) => canonicalRow([
    entry.ordinal,
    entry.projectRepositoryLinkId,
    entry.repositoryRagSnapshotId,
    entry.repositoryManifestFingerprint,
  ])).join("\x1e");
  return sha256(canonicalRow([
    PROJECT_REPOSITORY_RAG_SNAPSHOT_VERSION,
    input.projectId,
    input.policyRevisionId,
    input.effectivePolicyVersion,
    input.manualRagSnapshotId ?? "none",
    input.manualManifestFingerprint ?? "none",
    `required-repositories:${input.repositories.length}`,
    repositoryRows,
  ]));
}

function isPrismaCode(error: unknown, code: string): boolean {
  if (typeof error !== "object" || error === null) return false;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, "code");
    return descriptor !== undefined &&
      "value" in descriptor &&
      descriptor.value === code;
  } catch {
    return false;
  }
}

function containsSqlState(value: unknown, sqlState: string): boolean {
  if (value === sqlState) return true;
  if (typeof value !== "object" || value === null) return false;
  try {
    return Object.values(value).some((entry) => containsSqlState(entry, sqlState));
  } catch {
    return false;
  }
}

function isSerializationFailure(error: unknown): boolean {
  return isPrismaCode(error, "P2034") ||
    (isPrismaCode(error, "P2010") && containsSqlState(error, "40001"));
}

function isBoundaryFailure(error: unknown): boolean {
  return isPrismaCode(error, "P2003") ||
    isPrismaCode(error, "P2004") ||
    (isPrismaCode(error, "P2010") && !isSerializationFailure(error));
}

function repositoryView(row: Readonly<{
  id: string;
  projectId: string;
  projectRepositoryLinkId: string;
  linkConfigVersion: number;
  effectivePolicyVersion: number;
  requiredForProjectSnapshot: boolean;
  policyRevisionId: string;
  embeddingProfileId: string;
  codeIndexGenerationId: string | null;
  repositoryCodeGenerationId: string | null;
  materialIndexGenerationId: string | null;
  repositoryMaterialGenerationId: string | null;
  capturedGitHubRepositoryId: bigint;
  capturedFullName: string;
  frozenCommitSha: string;
  manifestFingerprint: string;
  completedAt: Date | null;
}>, aiEffectivePolicyVersion: number, publishedAt: Date): RepositoryRagSnapshotView {
  if (
    row.completedAt === null ||
    !FINGERPRINT_PATTERN.test(row.manifestFingerprint) ||
    !COMMIT_SHA_PATTERN.test(row.frozenCommitSha)
  ) {
    return fail("REPOSITORY_RAG_SNAPSHOT_BOUNDARY_CONFLICT");
  }
  return frozen({
    id: row.id,
    projectId: row.projectId,
    projectRepositoryLinkId: row.projectRepositoryLinkId,
    linkConfigVersion: row.linkConfigVersion,
    linkEffectivePolicyVersion: row.effectivePolicyVersion,
    requiredForProjectSnapshot: row.requiredForProjectSnapshot,
    policyRevisionId: row.policyRevisionId,
    aiEffectivePolicyVersion,
    embeddingProfileId: row.embeddingProfileId,
    codeIndexGenerationId: row.codeIndexGenerationId,
    repositoryCodeGenerationId: row.repositoryCodeGenerationId,
    materialIndexGenerationId: row.materialIndexGenerationId,
    repositoryMaterialGenerationId: row.repositoryMaterialGenerationId,
    capturedGitHubRepositoryId: row.capturedGitHubRepositoryId.toString(),
    capturedFullName: row.capturedFullName,
    frozenCommitSha: row.frozenCommitSha,
    manifestFingerprint: row.manifestFingerprint,
    completedAt: canonicalDate(row.completedAt),
    publishedAt: canonicalDate(publishedAt),
  });
}

function projectView(row: Readonly<{
  id: string;
  projectId: string;
  manualRagSnapshotId: string | null;
  manualManifestFingerprint: string | null;
  policyRevisionId: string;
  effectivePolicyVersion: number;
  manifestFingerprint: string;
  requiredRepositoryCount: number;
  completedAt: Date | null;
  entries: readonly Readonly<{
    ordinal: number;
    projectRepositoryLinkId: string;
    repositoryRagSnapshotId: string;
    repositoryManifestFingerprint: string;
  }>[];
}>, publishedAt: Date): ProjectRepositoryRagSnapshotView {
  if (
    row.completedAt === null ||
    !FINGERPRINT_PATTERN.test(row.manifestFingerprint) ||
    row.entries.length !== row.requiredRepositoryCount ||
    row.entries.some((entry, ordinal) =>
      entry.ordinal !== ordinal ||
      !FINGERPRINT_PATTERN.test(entry.repositoryManifestFingerprint))
  ) {
    return fail("REPOSITORY_RAG_SNAPSHOT_BOUNDARY_CONFLICT");
  }
  return frozen({
    id: row.id,
    projectId: row.projectId,
    manualRagSnapshotId: row.manualRagSnapshotId,
    manualManifestFingerprint: row.manualManifestFingerprint,
    policyRevisionId: row.policyRevisionId,
    effectivePolicyVersion: row.effectivePolicyVersion,
    manifestFingerprint: row.manifestFingerprint,
    requiredRepositoryCount: row.requiredRepositoryCount,
    completedAt: canonicalDate(row.completedAt),
    publishedAt: canonicalDate(publishedAt),
    repositories: Object.freeze(row.entries.map((entry) => frozen({ ...entry }))),
  });
}

async function lockProject(
  tx: Prisma.TransactionClient,
  projectId: string,
): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT project."id"::text AS "id"
    FROM "Project" AS project
    WHERE project."id" = ${projectId}::uuid
    FOR UPDATE
  `);
  if (rows.length === 0) {
    return fail("REPOSITORY_RAG_SNAPSHOT_PROJECT_NOT_FOUND");
  }
}

async function currentPolicy(
  tx: Prisma.TransactionClient,
  projectId: string,
): Promise<Readonly<{ id: string; revision: number }>> {
  const policy = await tx.projectAiPolicy.findUnique({
    where: { projectId },
    include: { currentRevision: true },
  });
  if (
    policy === null ||
    policy.currentRevision.id !== policy.currentRevisionId ||
    !policy.currentRevision.embeddingEnabled
  ) {
    return fail("REPOSITORY_RAG_SNAPSHOT_POLICY_INELIGIBLE");
  }
  return frozen({
    id: policy.currentRevision.id,
    revision: policy.currentRevision.revision,
  });
}

async function readRepositoryBoundary(
  tx: Prisma.TransactionClient,
  projectId: string,
  projectRepositoryLinkId: string,
  policy: Readonly<{ id: string; revision: number }>,
): Promise<RepositoryBoundary> {
  const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT link."id"::text AS "id"
    FROM "ProjectRepositoryLink" AS link
    WHERE link."projectId" = ${projectId}::uuid
      AND link."id" = ${projectRepositoryLinkId}::uuid
    FOR UPDATE
  `);
  if (locked.length === 0) {
    return fail("REPOSITORY_RAG_SNAPSHOT_LINK_NOT_FOUND");
  }
  const link = await tx.projectRepositoryLink.findUnique({
    where: { projectId_id: { projectId, id: projectRepositoryLinkId } },
    include: {
      githubRepository: true,
      configPointer: { include: { config: true } },
      codeIndexPointer: {
        include: {
          indexGeneration: true,
          repositoryCodeIndex: { include: { codeGeneration: true } },
        },
      },
      materialIndexPointer: {
        include: {
          indexGeneration: { include: { materialGeneration: true } },
        },
      },
    },
  });
  if (link === null) return fail("REPOSITORY_RAG_SNAPSHOT_LINK_NOT_FOUND");
  const configPointer = link.configPointer;
  if (
    link.status !== "active" ||
    configPointer === null ||
    link.effectivePolicyVersion !== configPointer.effectivePolicyVersion ||
    configPointer.configVersion !== configPointer.config.version ||
    configPointer.effectivePolicyVersion !==
      configPointer.config.effectivePolicyVersion
  ) {
    return fail("REPOSITORY_RAG_SNAPSHOT_LINK_INELIGIBLE");
  }
  const config = configPointer.config;
  const materialEnabled = config.metadataEnabled ||
    config.readmeEnabled ||
    config.markdownEnabled ||
    config.issuesEnabled ||
    config.pullRequestsEnabled ||
    config.releasesEnabled;
  if (!config.codeEnabled && !materialEnabled) {
    return fail("REPOSITORY_RAG_SNAPSHOT_LINK_INELIGIBLE");
  }
  const profile = await tx.embeddingProfile.findUnique({
    where: { id: EMBEDDING_STORAGE_PROFILE_ID },
  });
  if (
    profile === null ||
    profile.profileFingerprint !== EMBEDDING_STORAGE_PROFILE_FINGERPRINT
  ) {
    return fail("REPOSITORY_RAG_SNAPSHOT_POLICY_INELIGIBLE");
  }

  const codePointer = link.codeIndexPointer;
  const codeIndex = codePointer?.indexGeneration;
  const repositoryCodeIndex = codePointer?.repositoryCodeIndex;
  const codeGeneration = repositoryCodeIndex?.codeGeneration;
  if (config.codeEnabled && (
    codePointer === null ||
    codeIndex === undefined ||
    repositoryCodeIndex === undefined ||
    codeGeneration === undefined ||
    codePointer.linkConfigVersion !== configPointer.configVersion ||
    codePointer.effectivePolicyVersion !== configPointer.effectivePolicyVersion ||
    codeIndex.kind !== "repositoryCode" ||
    codeIndex.originScope !== "repository_link" ||
    codeIndex.status !== "ragReady" ||
    codeIndex.policyRevisionId !== policy.id ||
    codeIndex.embeddingProfileId !== EMBEDDING_STORAGE_PROFILE_ID ||
    codeIndex.expectedInputCount < 1 ||
    codeIndex.indexedInputCount !== codeIndex.expectedInputCount ||
    repositoryCodeIndex.repositoryCodeGenerationId !==
      codePointer.repositoryCodeGenerationId ||
    repositoryCodeIndex.linkConfigVersion !== configPointer.configVersion ||
    repositoryCodeIndex.effectivePolicyVersion !==
      configPointer.effectivePolicyVersion ||
    codeGeneration.status !== "codeReady" ||
    codeGeneration.linkConfigVersion !== configPointer.configVersion ||
    codeGeneration.effectivePolicyVersion !==
      configPointer.effectivePolicyVersion ||
    codeGeneration.capturedGitHubRepositoryId !==
      link.githubRepository.githubRepositoryId ||
    !COMMIT_SHA_PATTERN.test(codeGeneration.frozenCommitSha)
  )) {
    return fail("REPOSITORY_RAG_SNAPSHOT_INDEX_NOT_READY");
  }

  const materialPointer = link.materialIndexPointer;
  const materialIndex = materialPointer?.indexGeneration;
  const materialGeneration = materialIndex?.materialGeneration;
  if (materialEnabled && (
    materialPointer === null ||
    materialIndex === undefined ||
    materialGeneration === undefined ||
    materialPointer.linkConfigVersion !== configPointer.configVersion ||
    materialPointer.effectivePolicyVersion !==
      configPointer.effectivePolicyVersion ||
    materialIndex.status !== "ragReady" ||
    materialIndex.policyRevisionId !== policy.id ||
    materialIndex.embeddingProfileId !== EMBEDDING_STORAGE_PROFILE_ID ||
    materialIndex.expectedInputCount < 1 ||
    materialIndex.indexedInputCount !== materialIndex.expectedInputCount ||
    materialIndex.repositoryMaterialGenerationId !==
      materialPointer.repositoryMaterialGenerationId ||
    materialGeneration.status !== "complete" ||
    materialGeneration.linkConfigVersion !== configPointer.configVersion ||
    materialGeneration.effectivePolicyVersion !==
      configPointer.effectivePolicyVersion ||
    materialGeneration.capturedGitHubRepositoryId !==
      link.githubRepository.githubRepositoryId ||
    !COMMIT_SHA_PATTERN.test(materialGeneration.observedHeadCommitSha)
  )) {
    return fail("REPOSITORY_RAG_SNAPSHOT_INDEX_NOT_READY");
  }

  const capturedGitHubRepositoryId = config.codeEnabled
    ? codeGeneration!.capturedGitHubRepositoryId
    : materialGeneration!.capturedGitHubRepositoryId;
  const capturedFullName = config.codeEnabled
    ? codeGeneration!.capturedFullName
    : materialGeneration!.capturedFullName;
  const frozenCommitSha = config.codeEnabled
    ? codeGeneration!.frozenCommitSha
    : materialGeneration!.observedHeadCommitSha;
  if (
    materialEnabled && config.codeEnabled && (
      materialGeneration!.capturedGitHubRepositoryId !==
        capturedGitHubRepositoryId ||
      materialGeneration!.capturedFullName !== capturedFullName ||
      materialGeneration!.observedHeadCommitSha !== frozenCommitSha
    )
  ) {
    return fail("REPOSITORY_RAG_SNAPSHOT_INDEX_NOT_READY");
  }
  if (
    capturedGitHubRepositoryId !== link.githubRepository.githubRepositoryId ||
    capturedFullName.length === 0 ||
    !COMMIT_SHA_PATTERN.test(frozenCommitSha)
  ) {
    return fail("REPOSITORY_RAG_SNAPSHOT_BOUNDARY_CONFLICT");
  }
  return frozen({
    projectId,
    projectRepositoryLinkId,
    linkConfigVersion: configPointer.configVersion,
    linkEffectivePolicyVersion: configPointer.effectivePolicyVersion,
    requiredForProjectSnapshot: config.requiredForProjectSnapshot,
    policyRevisionId: policy.id,
    aiEffectivePolicyVersion: policy.revision,
    embeddingProfileId: EMBEDDING_STORAGE_PROFILE_ID,
    codeIndexGenerationId: config.codeEnabled
      ? codePointer!.indexGenerationId
      : null,
    repositoryCodeGenerationId: config.codeEnabled
      ? codePointer!.repositoryCodeGenerationId
      : null,
    materialIndexGenerationId: materialEnabled
      ? materialPointer!.indexGenerationId
      : null,
    repositoryMaterialGenerationId: materialEnabled
      ? materialPointer!.repositoryMaterialGenerationId
      : null,
    capturedGitHubRepositoryId,
    capturedFullName,
    frozenCommitSha,
  });
}

async function isCurrentRepositorySnapshot(
  tx: Prisma.TransactionClient,
  projectId: string,
  projectRepositoryLinkId: string,
  snapshotId: string,
): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ current: boolean }>>(Prisma.sql`
    SELECT "repository_rag_snapshot_is_current"(
      ${projectId}::uuid,
      ${projectRepositoryLinkId}::uuid,
      ${snapshotId}::uuid
    ) AS "current"
  `);
  return rows.length === 1 && rows[0]!.current === true;
}

async function isCurrentProjectSnapshot(
  tx: Prisma.TransactionClient,
  projectId: string,
  snapshotId: string,
): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ current: boolean }>>(Prisma.sql`
    SELECT "project_repository_rag_snapshot_is_current"(
      ${projectId}::uuid,
      ${snapshotId}::uuid
    ) AS "current"
  `);
  return rows.length === 1 && rows[0]!.current === true;
}

async function publishRepositoryInTransaction(
  tx: Prisma.TransactionClient,
  input: Readonly<{
    projectId: string;
    projectRepositoryLinkId: string;
    policy: Readonly<{ id: string; revision: number }>;
    idFactory: () => string;
    completedAt: Date;
  }>,
): Promise<RepositoryRagSnapshotView> {
  const boundary = await readRepositoryBoundary(
    tx,
    input.projectId,
    input.projectRepositoryLinkId,
    input.policy,
  );
  const manifestFingerprint = repositoryManifest(boundary);
  const pointer = await tx.repositoryRagSnapshotPointer.findUnique({
    where: {
      projectId_projectRepositoryLinkId: {
        projectId: input.projectId,
        projectRepositoryLinkId: input.projectRepositoryLinkId,
      },
    },
  });
  const existing = await tx.repositoryRagSnapshot.findUnique({
    where: {
      projectId_projectRepositoryLinkId_manifestFingerprint: {
        projectId: input.projectId,
        projectRepositoryLinkId: input.projectRepositoryLinkId,
        manifestFingerprint,
      },
    },
  });
  if (existing !== null) {
    if (
      existing.status !== "complete" ||
      pointer?.repositoryRagSnapshotId !== existing.id ||
      !(await isCurrentRepositorySnapshot(
        tx,
        input.projectId,
        input.projectRepositoryLinkId,
        existing.id,
      ))
    ) {
      return fail("REPOSITORY_RAG_SNAPSHOT_BOUNDARY_CONFLICT");
    }
    return repositoryView(
      existing,
      boundary.aiEffectivePolicyVersion,
      pointer.publishedAt,
    );
  }

  const snapshotId = canonicalUuid(input.idFactory());
  await tx.repositoryRagSnapshot.create({
    data: {
      id: snapshotId,
      projectId: input.projectId,
      projectRepositoryLinkId: input.projectRepositoryLinkId,
      expectedActiveSnapshotId: pointer?.repositoryRagSnapshotId ?? null,
      linkConfigVersion: boundary.linkConfigVersion,
      effectivePolicyVersion: boundary.linkEffectivePolicyVersion,
      requiredForProjectSnapshot: boundary.requiredForProjectSnapshot,
      policyRevisionId: boundary.policyRevisionId,
      embeddingProfileId: boundary.embeddingProfileId,
      codeIndexGenerationId: boundary.codeIndexGenerationId,
      repositoryCodeGenerationId: boundary.repositoryCodeGenerationId,
      materialIndexGenerationId: boundary.materialIndexGenerationId,
      repositoryMaterialGenerationId: boundary.repositoryMaterialGenerationId,
      capturedGitHubRepositoryId: boundary.capturedGitHubRepositoryId,
      capturedFullName: boundary.capturedFullName,
      frozenCommitSha: boundary.frozenCommitSha,
      manifestFingerprint,
    },
  });
  const completed = await tx.repositoryRagSnapshot.update({
    where: { projectId_id: { projectId: input.projectId, id: snapshotId } },
    data: { status: "complete", completedAt: input.completedAt },
  });
  const published = await tx.repositoryRagSnapshotPointer.upsert({
    where: {
      projectId_projectRepositoryLinkId: {
        projectId: input.projectId,
        projectRepositoryLinkId: input.projectRepositoryLinkId,
      },
    },
    create: {
      projectId: input.projectId,
      projectRepositoryLinkId: input.projectRepositoryLinkId,
      repositoryRagSnapshotId: snapshotId,
      publishedAt: input.completedAt,
    },
    update: {
      repositoryRagSnapshotId: snapshotId,
      publishedAt: input.completedAt,
    },
  });
  return repositoryView(
    completed,
    boundary.aiEffectivePolicyVersion,
    published.publishedAt,
  );
}

async function eligibleManualSnapshot(
  tx: Prisma.TransactionClient,
  projectId: string,
  policy: Readonly<{ id: string; revision: number }>,
): Promise<Readonly<ManualSnapshotRow> | null> {
  const rows = await tx.$queryRaw<ManualSnapshotRow[]>(Prisma.sql`
    SELECT
      snapshot."id"::text AS "id",
      snapshot."manifestFingerprint"
    FROM "ProjectRagSnapshotPointer" AS pointer
    JOIN "ProjectRagSnapshot" AS snapshot
      ON snapshot."projectId" = pointer."projectId"
     AND snapshot."id" = pointer."ragSnapshotId"
    JOIN "ProjectCorpusIndexGeneration" AS project_index
      ON project_index."projectId" = snapshot."projectId"
     AND project_index."indexGenerationId" =
         snapshot."manualIndexGenerationId"
     AND project_index."corpusGenerationId" =
         snapshot."manualCorpusGenerationId"
     AND project_index."grantId" = snapshot."grantId"
     AND project_index."policyRevisionId" = snapshot."policyRevisionId"
    JOIN "IndexGeneration" AS index_generation
      ON index_generation."projectId" = project_index."projectId"
     AND index_generation."id" = project_index."indexGenerationId"
    JOIN "ProjectCorpusGeneration" AS corpus_generation
      ON corpus_generation."projectId" = project_index."projectId"
     AND corpus_generation."id" = project_index."corpusGenerationId"
    JOIN "ProjectCorpusIndexPointer" AS corpus_pointer
      ON corpus_pointer."projectId" = project_index."projectId"
     AND corpus_pointer."indexGenerationId" =
         project_index."indexGenerationId"
     AND corpus_pointer."corpusGenerationId" =
         project_index."corpusGenerationId"
    JOIN "ModelProcessingGrant" AS grant_row
      ON grant_row."projectId" = snapshot."projectId"
     AND grant_row."id" = snapshot."grantId"
     AND grant_row."policyRevisionId" = snapshot."policyRevisionId"
    JOIN "ModelProcessingGrantOperation" AS grant_operation
      ON grant_operation."projectId" = grant_row."projectId"
     AND grant_operation."grantId" = grant_row."id"
     AND grant_operation."operation" = 'embedding'
    JOIN "EmbeddingProfile" AS profile
      ON profile."id" = index_generation."embeddingProfileId"
    WHERE snapshot."projectId" = ${projectId}::uuid
      AND snapshot."status" = 'complete'
      AND snapshot."requiredRepositoryCount" = 0
      AND snapshot."completedAt" IS NOT NULL
      AND snapshot."supersededAt" IS NULL
      AND snapshot."policyRevisionId" = ${policy.id}::uuid
      AND snapshot."effectivePolicyVersion" = ${policy.revision}
      AND index_generation."kind" = 'project_corpus'
      AND index_generation."status" = 'rag_ready'
      AND index_generation."expectedInputCount" > 0
      AND index_generation."indexedInputCount" =
          index_generation."expectedInputCount"
      AND corpus_generation."status" = 'complete'
      AND grant_row."status" = 'issued'
      AND grant_row."issuedAt" IS NOT NULL
      AND grant_row."issuedAt" <= CURRENT_TIMESTAMP
      AND grant_row."revokedAt" IS NULL
      AND grant_row."expiresAt" IS NOT NULL
      AND grant_row."expiresAt" > CURRENT_TIMESTAMP
      AND grant_row."effectivePolicyVersion" = ${policy.revision}
      AND profile."id" = ${EMBEDDING_STORAGE_PROFILE_ID}::uuid
      AND profile."profileFingerprint" =
          ${EMBEDDING_STORAGE_PROFILE_FINGERPRINT}
    FOR SHARE OF pointer, snapshot, project_index, index_generation,
      corpus_generation, corpus_pointer, grant_row, grant_operation, profile
  `);
  if (rows.length === 0) return null;
  if (
    rows.length !== 1 ||
    !FINGERPRINT_PATTERN.test(rows[0]!.manifestFingerprint)
  ) {
    return fail("REPOSITORY_RAG_SNAPSHOT_BOUNDARY_CONFLICT");
  }
  return frozen(rows[0]!);
}

export function createRepositoryRagSnapshotService(options: {
  db: PrismaClient;
  idFactory?: () => string;
  now?: () => Date;
  transactionRetryLimit?: number;
}): RepositoryRagSnapshotService {
  if (
    typeof options !== "object" ||
    options === null ||
    typeof options.db?.$transaction !== "function" ||
    (options.idFactory !== undefined && typeof options.idFactory !== "function") ||
    (options.now !== undefined && typeof options.now !== "function")
  ) {
    return fail("REPOSITORY_RAG_SNAPSHOT_INVALID_INPUT");
  }
  const idFactory = options.idFactory ?? randomUUID;
  const now = options.now ?? (() => new Date());
  const retryLimit = options.transactionRetryLimit ?? DEFAULT_RETRY_LIMIT;
  if (!Number.isSafeInteger(retryLimit) || retryLimit < 1 || retryLimit > 5) {
    return fail("REPOSITORY_RAG_SNAPSHOT_INVALID_INPUT");
  }

  const currentTime = (): Date => canonicalDate(now());
  const serializable = async <T>(
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> => {
    for (let attempt = 0; attempt < retryLimit; attempt += 1) {
      try {
        return await options.db.$transaction(work, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        if (
          (isSerializationFailure(error) || isPrismaCode(error, "P2002")) &&
          attempt + 1 < retryLimit
        ) {
          continue;
        }
        if (error instanceof RepositoryRagSnapshotError) throw error;
        if (isSerializationFailure(error) || isPrismaCode(error, "P2002")) {
          return fail("REPOSITORY_RAG_SNAPSHOT_WRITE_CONFLICT");
        }
        if (isBoundaryFailure(error)) {
          return fail("REPOSITORY_RAG_SNAPSHOT_BOUNDARY_CONFLICT");
        }
        throw error;
      }
    }
    return fail("REPOSITORY_RAG_SNAPSHOT_WRITE_CONFLICT");
  };

  return frozen({
    async publishRepository(input) {
      const projectId = canonicalUuid(input?.projectId);
      const projectRepositoryLinkId = canonicalUuid(
        input?.projectRepositoryLinkId,
      );
      const completedAt = currentTime();
      return serializable(async (tx) => {
        await lockProject(tx, projectId);
        const policy = await currentPolicy(tx, projectId);
        return publishRepositoryInTransaction(tx, {
          projectId,
          projectRepositoryLinkId,
          policy,
          idFactory,
          completedAt,
        });
      });
    },

    async publishProject(input) {
      const projectId = canonicalUuid(input?.projectId);
      const completedAt = currentTime();
      return serializable(async (tx) => {
        await lockProject(tx, projectId);
        const policy = await currentPolicy(tx, projectId);
        const links = await tx.projectRepositoryLink.findMany({
          where: { projectId, status: "active" },
          include: { configPointer: { include: { config: true } } },
          orderBy: { id: "asc" },
        });
        const requiredLinkIds = links.flatMap((link) => {
          const pointer = link.configPointer;
          if (
            pointer === null ||
            link.effectivePolicyVersion !== pointer.effectivePolicyVersion ||
            pointer.configVersion !== pointer.config.version ||
            pointer.effectivePolicyVersion !==
              pointer.config.effectivePolicyVersion ||
            !pointer.config.requiredForProjectSnapshot
          ) {
            return [];
          }
          return [link.id];
        });
        if (requiredLinkIds.length === 0) {
          return fail(
            "REPOSITORY_RAG_SNAPSHOT_REQUIRED_REPOSITORIES_NOT_CONFIGURED",
          );
        }
        const repositorySnapshots: RepositoryRagSnapshotView[] = [];
        for (const projectRepositoryLinkId of requiredLinkIds) {
          repositorySnapshots.push(await publishRepositoryInTransaction(tx, {
            projectId,
            projectRepositoryLinkId,
            policy,
            idFactory,
            completedAt,
          }));
        }
        const repositories = Object.freeze(repositorySnapshots.map(
          (snapshot, ordinal) => frozen({
            ordinal,
            projectRepositoryLinkId: snapshot.projectRepositoryLinkId,
            repositoryRagSnapshotId: snapshot.id,
            repositoryManifestFingerprint: snapshot.manifestFingerprint,
          }),
        ));
        const manualSnapshot = await eligibleManualSnapshot(tx, projectId, policy);
        const manifestFingerprint = projectManifest({
          projectId,
          policyRevisionId: policy.id,
          effectivePolicyVersion: policy.revision,
          manualRagSnapshotId: manualSnapshot?.id ?? null,
          manualManifestFingerprint:
            manualSnapshot?.manifestFingerprint ?? null,
          repositories,
        });
        const pointer = await tx.projectRepositoryRagSnapshotPointer.findUnique({
          where: { projectId },
        });
        const existing = await tx.projectRepositoryRagSnapshot.findUnique({
          where: {
            projectId_manifestFingerprint: { projectId, manifestFingerprint },
          },
          include: { entries: { orderBy: { ordinal: "asc" } } },
        });
        if (existing !== null) {
          if (
            existing.status !== "complete" ||
            pointer?.projectRepositoryRagSnapshotId !== existing.id ||
            !(await isCurrentProjectSnapshot(tx, projectId, existing.id))
          ) {
            return fail("REPOSITORY_RAG_SNAPSHOT_BOUNDARY_CONFLICT");
          }
          return projectView(existing, pointer.publishedAt);
        }

        const snapshotId = canonicalUuid(idFactory());
        await tx.projectRepositoryRagSnapshot.create({
          data: {
            id: snapshotId,
            projectId,
            expectedActiveSnapshotId:
              pointer?.projectRepositoryRagSnapshotId ?? null,
            manualRagSnapshotId: manualSnapshot?.id ?? null,
            manualManifestFingerprint:
              manualSnapshot?.manifestFingerprint ?? null,
            policyRevisionId: policy.id,
            effectivePolicyVersion: policy.revision,
            manifestFingerprint,
            requiredRepositoryCount: repositories.length,
          },
        });
        await tx.projectRepositoryRagSnapshotEntry.createMany({
          data: repositories.map((entry) => ({
            id: canonicalUuid(idFactory()),
            projectId,
            projectRepositoryRagSnapshotId: snapshotId,
            projectRepositoryLinkId: entry.projectRepositoryLinkId,
            repositoryRagSnapshotId: entry.repositoryRagSnapshotId,
            ordinal: entry.ordinal,
            repositoryManifestFingerprint:
              entry.repositoryManifestFingerprint,
          })),
        });
        const completed = await tx.projectRepositoryRagSnapshot.update({
          where: { projectId_id: { projectId, id: snapshotId } },
          data: { status: "complete", completedAt },
          include: { entries: { orderBy: { ordinal: "asc" } } },
        });
        const published = await tx.projectRepositoryRagSnapshotPointer.upsert({
          where: { projectId },
          create: {
            projectId,
            projectRepositoryRagSnapshotId: snapshotId,
            publishedAt: completedAt,
          },
          update: {
            projectRepositoryRagSnapshotId: snapshotId,
            publishedAt: completedAt,
          },
        });
        return projectView(completed, published.publishedAt);
      });
    },

    async getRepositorySnapshot(input) {
      const projectId = canonicalUuid(input?.projectId);
      const projectRepositoryLinkId = canonicalUuid(
        input?.projectRepositoryLinkId,
      );
      return options.db.$transaction(async (tx) => {
        const pointer = await tx.repositoryRagSnapshotPointer.findUnique({
          where: {
            projectId_projectRepositoryLinkId: {
              projectId,
              projectRepositoryLinkId,
            },
          },
          include: { snapshot: true },
        });
        if (pointer === null) {
          const project = await tx.project.findUnique({
            where: { id: projectId },
            select: { id: true },
          });
          if (project === null) {
            return fail("REPOSITORY_RAG_SNAPSHOT_PROJECT_NOT_FOUND");
          }
          const link = await tx.projectRepositoryLink.findUnique({
            where: { projectId_id: { projectId, id: projectRepositoryLinkId } },
            select: { id: true },
          });
          return fail(link === null
            ? "REPOSITORY_RAG_SNAPSHOT_LINK_NOT_FOUND"
            : "REPOSITORY_RAG_SNAPSHOT_NOT_FOUND");
        }
        if (!(await isCurrentRepositorySnapshot(
          tx,
          projectId,
          projectRepositoryLinkId,
          pointer.repositoryRagSnapshotId,
        ))) {
          return fail("REPOSITORY_RAG_SNAPSHOT_BOUNDARY_CONFLICT");
        }
        const policy = await currentPolicy(tx, projectId);
        return repositoryView(pointer.snapshot, policy.revision, pointer.publishedAt);
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    },

    async getProjectSnapshot(input) {
      const projectId = canonicalUuid(input?.projectId);
      return options.db.$transaction(async (tx) => {
        const pointer = await tx.projectRepositoryRagSnapshotPointer.findUnique({
          where: { projectId },
          include: {
            snapshot: { include: { entries: { orderBy: { ordinal: "asc" } } } },
          },
        });
        if (pointer === null) {
          const project = await tx.project.findUnique({
            where: { id: projectId },
            select: { id: true },
          });
          return fail(project === null
            ? "REPOSITORY_RAG_SNAPSHOT_PROJECT_NOT_FOUND"
            : "REPOSITORY_RAG_SNAPSHOT_NOT_FOUND");
        }
        if (!(await isCurrentProjectSnapshot(
          tx,
          projectId,
          pointer.projectRepositoryRagSnapshotId,
        ))) {
          return fail("REPOSITORY_RAG_SNAPSHOT_BOUNDARY_CONFLICT");
        }
        return projectView(pointer.snapshot, pointer.publishedAt);
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    },
  });
}
