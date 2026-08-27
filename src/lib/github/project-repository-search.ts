import { Prisma, type PrismaClient } from "@prisma/client";
import {
  EMBEDDING_STORAGE_PROFILE_FINGERPRINT,
  EMBEDDING_STORAGE_PROFILE_ID,
} from "@/lib/ai-memory/corpus-index";
import {
  HYBRID_SEARCH_MAX_DOCUMENTS,
  HybridSearchError,
  rankHybridSearch,
  type HybridSearchDocument,
  type HybridSearchVectorRank,
} from "@/lib/ai-memory/hybrid-search";
import type { ProjectQueryEmbedding } from "@/lib/ai-memory/project-search";
import { hashSourceContent } from "@/lib/source";

export const PROJECT_REPOSITORY_SEARCH_VERSION =
  "project-repository-search:v1" as const;
export const PROJECT_REPOSITORY_SEARCH_VECTOR_DIMENSIONS = 1_536 as const;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

export type ProjectRepositorySearchErrorCode =
  | "PROJECT_REPOSITORY_SEARCH_INVALID_INPUT"
  | "PROJECT_REPOSITORY_SEARCH_PROJECT_NOT_FOUND"
  | "PROJECT_REPOSITORY_SEARCH_SNAPSHOT_NOT_READY"
  | "PROJECT_REPOSITORY_SEARCH_SNAPSHOT_INELIGIBLE"
  | "PROJECT_REPOSITORY_SEARCH_SCOPE_TOO_LARGE"
  | "PROJECT_REPOSITORY_SEARCH_SNAPSHOT_CONFLICT";

export class ProjectRepositorySearchError extends Error {
  constructor(readonly code: ProjectRepositorySearchErrorCode) {
    super(code);
    this.name = "ProjectRepositorySearchError";
  }
}

type SearchComponentRanks = Readonly<{
  vector: number | null;
  cjk: number | null;
  identifier: number | null;
  substring: number | null;
  token: number | null;
}>;

type CommonCitation = Readonly<{
  projectId: string;
  sourceId: string;
  chunkId: string;
  externalRef: string | null;
  rangeUnit: "utf8_byte" | "line";
  rangeStart: number;
  rangeEnd: number;
  contentHash: string;
  excerpt: string;
}>;

export type ProjectRepositorySearchCitation =
  | (CommonCitation & Readonly<{
      origin: "project";
      sourceKind: "document" | "screenshot" | "github" | "manual";
      projectRepositoryLinkId: null;
      repositoryRagSnapshotId: null;
      immutableRef: null;
    }>)
  | (CommonCitation & Readonly<{
      origin: "repositoryCode";
      sourceKind: "github";
      projectRepositoryLinkId: string;
      repositoryRagSnapshotId: string;
      githubRepositoryId: string;
      capturedFullName: string;
      frozenCommitSha: string;
      normalizedPath: string;
      repositoryFileRevisionId: string;
      immutableRef: string;
    }>)
  | (CommonCitation & Readonly<{
      origin: "repositoryMaterial";
      sourceKind: "github";
      projectRepositoryLinkId: string;
      repositoryRagSnapshotId: string;
      githubRepositoryId: string;
      capturedFullName: string;
      frozenCommitSha: string;
      materialKind:
        | "repositoryMetadata"
        | "readme"
        | "markdown"
        | "issue"
        | "pullRequest"
        | "release";
      remoteIdentity: string;
      remoteRevisionFingerprint: string;
      normalizedPath: string | null;
      immutableRef: string;
    }>);

export type ProjectRepositorySearchResponse = Readonly<{
  searchVersion: typeof PROJECT_REPOSITORY_SEARCH_VERSION;
  mode: "lexical" | "hybrid";
  snapshot: Readonly<{
    id: string;
    manifestFingerprint: string;
    policyRevisionId: string;
    effectivePolicyVersion: number;
    manualRagSnapshotId: string | null;
    requiredRepositoryCount: number;
    publishedAt: Date;
  }>;
  results: readonly Readonly<{
    rank: number;
    score: number;
    matchedFeatures: readonly string[];
    componentRanks: SearchComponentRanks;
    citation: ProjectRepositorySearchCitation;
  }>[];
}>;

type ManualEligibilityRow = {
  manualRagSnapshotId: string;
  manualIndexGenerationId: string;
  manualCorpusGenerationId: string;
  expectedInputCount: number;
};

type ManualDocumentRow = {
  inputEntryId: string;
  sourceId: string;
  sourceKind: string;
  externalRef: string | null;
  chunkId: string;
  rangeUnit: string;
  rangeStart: number;
  rangeEnd: number;
  contentText: string;
  contentHash: string;
  contentBytes: number;
  inputOrdinal: number;
};

type CodeDocumentRow = {
  repositoryOrdinal: number;
  repositoryRagSnapshotId: string;
  projectRepositoryLinkId: string;
  codeIndexGenerationId: string;
  inputEntryId: string;
  inputOrdinal: number;
  sourceChunkId: string;
  repositoryFileRevisionId: string;
  normalizedPath: string;
  rangeStart: number;
  rangeEnd: number;
  contentText: string;
  contentHash: string;
  contentBytes: number;
  githubRepositoryId: bigint;
  capturedFullName: string;
  frozenCommitSha: string;
};

type MaterialDocumentRow = {
  repositoryOrdinal: number;
  repositoryRagSnapshotId: string;
  projectRepositoryLinkId: string;
  materialIndexGenerationId: string;
  inputEntryId: string;
  inputOrdinal: number;
  sourceChunkId: string;
  projectSourceId: string;
  sourceKind: string;
  externalRef: string | null;
  sourceRevisionKey: string;
  rangeStart: number;
  rangeEnd: number;
  contentText: string;
  contentHash: string;
  contentBytes: number;
  sourceContentHash: string;
  materialKind: string;
  remoteIdentity: string;
  remoteRevisionFingerprint: string;
  normalizedPath: string | null;
  githubRepositoryId: bigint;
  capturedFullName: string;
  frozenCommitSha: string;
};

type VectorRow = {
  inputEntryId: string;
  distance: number;
};

function fail(code: ProjectRepositorySearchErrorCode): never {
  throw new ProjectRepositorySearchError(code);
}

function canonicalUuid(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    return fail("PROJECT_REPOSITORY_SEARCH_INVALID_INPUT");
  }
  return value;
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return keys.length === sortedExpected.length &&
    keys.every((key, index) => key === sortedExpected[index]);
}

function canonicalTake(value: unknown): number {
  if (value === undefined) return 10;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 20) {
    return fail("PROJECT_REPOSITORY_SEARCH_INVALID_INPUT");
  }
  return value as number;
}

function canonicalQueryEmbedding(value: unknown): ProjectQueryEmbedding | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !exactKeys(value, ["profileFingerprint", "vector"])
  ) {
    return fail("PROJECT_REPOSITORY_SEARCH_INVALID_INPUT");
  }
  const record = value as Record<string, unknown>;
  if (
    record.profileFingerprint !== EMBEDDING_STORAGE_PROFILE_FINGERPRINT ||
    !Array.isArray(record.vector) ||
    record.vector.length !== PROJECT_REPOSITORY_SEARCH_VECTOR_DIMENSIONS
  ) {
    return fail("PROJECT_REPOSITORY_SEARCH_INVALID_INPUT");
  }
  const vector = record.vector.map((component) => {
    if (typeof component !== "number" || !Number.isFinite(component)) {
      return fail("PROJECT_REPOSITORY_SEARCH_INVALID_INPUT");
    }
    return Math.fround(component);
  });
  const norm = Math.sqrt(vector.reduce(
    (sum, component) => sum + component * component,
    0,
  ));
  if (norm < 0.99 || norm > 1.01) {
    return fail("PROJECT_REPOSITORY_SEARCH_INVALID_INPUT");
  }
  return Object.freeze({
    profileFingerprint: EMBEDDING_STORAGE_PROFILE_FINGERPRINT,
    vector: Object.freeze(vector),
  });
}

function vectorLiteral(vector: readonly number[]): string {
  return `[${vector.map((component) => component.toString()).join(",")}]`;
}

function sourceKind(value: string): "document" | "screenshot" | "github" | "manual" {
  if (!["document", "screenshot", "github", "manual"].includes(value)) {
    return fail("PROJECT_REPOSITORY_SEARCH_SNAPSHOT_CONFLICT");
  }
  return value as "document" | "screenshot" | "github" | "manual";
}

function materialKind(value: string): Extract<
  ProjectRepositorySearchCitation,
  { origin: "repositoryMaterial" }
>["materialKind"] {
  if (value === "repository_metadata") return "repositoryMetadata";
  if (value === "pull_request") return "pullRequest";
  if (![
    "repositoryMetadata",
    "readme",
    "markdown",
    "issue",
    "pullRequest",
    "release",
  ].includes(value)) {
    return fail("PROJECT_REPOSITORY_SEARCH_SNAPSHOT_CONFLICT");
  }
  return value as Extract<
    ProjectRepositorySearchCitation,
    { origin: "repositoryMaterial" }
  >["materialKind"];
}

function rangeUnit(value: string): "utf8_byte" | "line" {
  if (value !== "utf8_byte" && value !== "line") {
    return fail("PROJECT_REPOSITORY_SEARCH_SNAPSHOT_CONFLICT");
  }
  return value;
}

function validContent(row: Readonly<{
  contentText: string;
  contentHash: string;
  contentBytes: number;
  rangeStart: number;
  rangeEnd: number;
}>): boolean {
  return typeof row.contentText === "string" &&
    row.contentText.length > 0 &&
    FINGERPRINT_PATTERN.test(row.contentHash) &&
    row.contentHash === hashSourceContent(row.contentText) &&
    row.contentBytes === Buffer.byteLength(row.contentText, "utf8") &&
    Number.isSafeInteger(row.rangeStart) &&
    Number.isSafeInteger(row.rangeEnd) &&
    row.rangeStart >= 0 &&
    row.rangeEnd > row.rangeStart;
}

function documentId(origin: "manual" | "code" | "material", inputEntryId: string): string {
  if (!UUID_PATTERN.test(inputEntryId)) {
    return fail("PROJECT_REPOSITORY_SEARCH_SNAPSHOT_CONFLICT");
  }
  return `${origin}:${inputEntryId}`;
}

function immutableMaterialRef(row: MaterialDocumentRow): string {
  return [
    `${row.capturedFullName}@${row.frozenCommitSha}`,
    row.materialKind,
    row.remoteIdentity,
    row.remoteRevisionFingerprint,
  ].join(":");
}

async function readManualEligibility(
  tx: Prisma.TransactionClient,
  projectId: string,
  manualRagSnapshotId: string,
): Promise<ManualEligibilityRow> {
  const rows = await tx.$queryRaw<ManualEligibilityRow[]>(Prisma.sql`
    SELECT
      snapshot."id"::text AS "manualRagSnapshotId",
      snapshot."manualIndexGenerationId"::text AS "manualIndexGenerationId",
      snapshot."manualCorpusGenerationId"::text AS "manualCorpusGenerationId",
      index_generation."expectedInputCount"
    FROM "ProjectRagSnapshot" AS snapshot
    JOIN "ProjectRagSnapshotPointer" AS pointer
      ON pointer."projectId" = snapshot."projectId"
     AND pointer."ragSnapshotId" = snapshot."id"
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
     AND index_generation."grantId" = project_index."grantId"
     AND index_generation."policyRevisionId" = project_index."policyRevisionId"
    JOIN "ProjectCorpusGeneration" AS corpus_generation
      ON corpus_generation."projectId" = project_index."projectId"
     AND corpus_generation."id" = project_index."corpusGenerationId"
     AND corpus_generation."grantId" = project_index."grantId"
     AND corpus_generation."policyRevisionId" = project_index."policyRevisionId"
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
    JOIN "ProjectAiPolicy" AS policy
      ON policy."projectId" = snapshot."projectId"
     AND policy."currentRevisionId" = snapshot."policyRevisionId"
    JOIN "EmbeddingProfile" AS profile
      ON profile."id" = index_generation."embeddingProfileId"
    WHERE snapshot."projectId" = ${projectId}::uuid
      AND snapshot."id" = ${manualRagSnapshotId}::uuid
      AND snapshot."status" = 'complete'
      AND snapshot."requiredRepositoryCount" = 0
      AND snapshot."completedAt" IS NOT NULL
      AND snapshot."supersededAt" IS NULL
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
      AND grant_row."effectivePolicyVersion" =
          snapshot."effectivePolicyVersion"
      AND profile."id" = ${EMBEDDING_STORAGE_PROFILE_ID}::uuid
      AND profile."profileFingerprint" =
          ${EMBEDDING_STORAGE_PROFILE_FINGERPRINT}
    FOR SHARE OF snapshot, pointer, project_index, index_generation,
      corpus_generation, corpus_pointer, grant_row, grant_operation,
      policy, profile
  `);
  if (rows.length !== 1) {
    return fail("PROJECT_REPOSITORY_SEARCH_SNAPSHOT_INELIGIBLE");
  }
  return rows[0]!;
}

async function readManualDocuments(
  tx: Prisma.TransactionClient,
  projectId: string,
  eligibility: ManualEligibilityRow,
): Promise<readonly ManualDocumentRow[]> {
  const rows = await tx.$queryRaw<ManualDocumentRow[]>(Prisma.sql`
    SELECT
      input_entry."id"::text AS "inputEntryId",
      source."id"::text AS "sourceId",
      source."kind"::text AS "sourceKind",
      source."externalRef",
      chunk."id"::text AS "chunkId",
      chunk."rangeUnit"::text AS "rangeUnit",
      chunk."rangeStart",
      chunk."rangeEnd",
      chunk."contentText",
      chunk."contentHash",
      chunk."contentBytes",
      input_entry."ordinal" AS "inputOrdinal"
    FROM "ProjectCorpusIndexInput" AS membership
    JOIN "IndexGenerationInputEntry" AS input_entry
      ON input_entry."projectId" = membership."projectId"
     AND input_entry."indexGenerationId" = membership."indexGenerationId"
     AND input_entry."id" = membership."inputEntryId"
     AND input_entry."sourceChunkId" = membership."sourceChunkId"
    JOIN "ProjectCorpusGenerationEntry" AS corpus_entry
      ON corpus_entry."projectId" = membership."projectId"
     AND corpus_entry."corpusGenerationId" = membership."corpusGenerationId"
     AND corpus_entry."id" = membership."corpusEntryId"
     AND corpus_entry."sourceChunkId" = membership."sourceChunkId"
    JOIN "SourceChunk" AS chunk
      ON chunk."projectId" = input_entry."projectId"
     AND chunk."id" = input_entry."sourceChunkId"
     AND chunk."projectSourceId" = corpus_entry."projectSourceId"
     AND chunk."originScope" = corpus_entry."originScope"
     AND chunk."sourceRevisionKey" = corpus_entry."sourceRevisionKey"
     AND chunk."sourceContentHash" = corpus_entry."sourceContentHash"
     AND chunk."contentHash" = corpus_entry."chunkContentHash"
    JOIN "ProjectSource" AS source
      ON source."projectId" = chunk."projectId"
     AND source."id" = chunk."projectSourceId"
     AND source."originScope" = chunk."originScope"
     AND source."revisionKey" = chunk."sourceRevisionKey"
     AND source."contentHash" = chunk."sourceContentHash"
    JOIN "ChunkEmbedding" AS embedding
      ON embedding."projectId" = input_entry."projectId"
     AND embedding."indexGenerationId" = input_entry."indexGenerationId"
     AND embedding."inputEntryId" = input_entry."id"
     AND embedding."sourceChunkId" = input_entry."sourceChunkId"
     AND embedding."embeddingProfileId" =
         ${EMBEDDING_STORAGE_PROFILE_ID}::uuid
    WHERE membership."projectId" = ${projectId}::uuid
      AND membership."indexGenerationId" =
          ${eligibility.manualIndexGenerationId}::uuid
      AND membership."corpusGenerationId" =
          ${eligibility.manualCorpusGenerationId}::uuid
      AND input_entry."entryKind" = 'project_corpus'
      AND chunk."originScope" = 'project'
      AND chunk."state" = 'active'
      AND chunk."contentText" IS NOT NULL
      AND chunk."contentHash" IS NOT NULL
      AND chunk."contentBytes" IS NOT NULL
    ORDER BY input_entry."ordinal", input_entry."id"
    FOR SHARE OF membership, input_entry, corpus_entry, chunk, source, embedding
  `);
  if (
    rows.length !== eligibility.expectedInputCount ||
    rows.some((row, ordinal) =>
      row.inputOrdinal !== ordinal ||
      !UUID_PATTERN.test(row.sourceId) ||
      !UUID_PATTERN.test(row.chunkId) ||
      !validContent(row))
  ) {
    return fail("PROJECT_REPOSITORY_SEARCH_SNAPSHOT_CONFLICT");
  }
  return Object.freeze(rows);
}

async function readCodeDocuments(
  tx: Prisma.TransactionClient,
  projectId: string,
  projectSnapshotId: string,
): Promise<readonly CodeDocumentRow[]> {
  return Object.freeze(await tx.$queryRaw<CodeDocumentRow[]>(Prisma.sql`
    SELECT
      aggregate_entry."ordinal" AS "repositoryOrdinal",
      repository_snapshot."id"::text AS "repositoryRagSnapshotId",
      repository_snapshot."projectRepositoryLinkId"::text AS
          "projectRepositoryLinkId",
      repository_snapshot."codeIndexGenerationId"::text AS
          "codeIndexGenerationId",
      input_entry."id"::text AS "inputEntryId",
      input_entry."ordinal" AS "inputOrdinal",
      chunk."id"::text AS "sourceChunkId",
      membership."repositoryFileRevisionId"::text AS
          "repositoryFileRevisionId",
      code_entry."normalizedPath",
      chunk."rangeStart",
      chunk."rangeEnd",
      chunk."contentText",
      chunk."contentHash",
      chunk."contentBytes",
      repository_snapshot."capturedGitHubRepositoryId" AS
          "githubRepositoryId",
      repository_snapshot."capturedFullName",
      repository_snapshot."frozenCommitSha"
    FROM "ProjectRepositoryRagSnapshotEntry" AS aggregate_entry
    JOIN "RepositoryRagSnapshot" AS repository_snapshot
      ON repository_snapshot."projectId" = aggregate_entry."projectId"
     AND repository_snapshot."projectRepositoryLinkId" =
         aggregate_entry."projectRepositoryLinkId"
     AND repository_snapshot."id" =
         aggregate_entry."repositoryRagSnapshotId"
     AND repository_snapshot."manifestFingerprint" =
         aggregate_entry."repositoryManifestFingerprint"
    JOIN "RepositoryCodeIndexInput" AS membership
      ON membership."projectId" = repository_snapshot."projectId"
     AND membership."projectRepositoryLinkId" =
         repository_snapshot."projectRepositoryLinkId"
     AND membership."indexGenerationId" =
         repository_snapshot."codeIndexGenerationId"
     AND membership."repositoryCodeGenerationId" =
         repository_snapshot."repositoryCodeGenerationId"
    JOIN "IndexGenerationInputEntry" AS input_entry
      ON input_entry."projectId" = membership."projectId"
     AND input_entry."indexGenerationId" = membership."indexGenerationId"
     AND input_entry."id" = membership."inputEntryId"
     AND input_entry."sourceChunkId" = membership."sourceChunkId"
     AND input_entry."originScope" = membership."originScope"
     AND input_entry."projectRepositoryLinkId" =
         membership."projectRepositoryLinkId"
    JOIN "SourceChunk" AS chunk
      ON chunk."projectId" = membership."projectId"
     AND chunk."projectRepositoryLinkId" =
         membership."projectRepositoryLinkId"
     AND chunk."repositoryFileRevisionId" =
         membership."repositoryFileRevisionId"
     AND chunk."id" = membership."sourceChunkId"
    JOIN "RepositoryCodeGenerationEntry" AS code_entry
      ON code_entry."projectId" = membership."projectId"
     AND code_entry."projectRepositoryLinkId" =
         membership."projectRepositoryLinkId"
     AND code_entry."repositoryCodeGenerationId" =
         membership."repositoryCodeGenerationId"
     AND code_entry."id" = membership."codeGenerationEntryId"
     AND code_entry."repositoryFileRevisionId" =
         membership."repositoryFileRevisionId"
    JOIN "ChunkEmbedding" AS embedding
      ON embedding."projectId" = input_entry."projectId"
     AND embedding."indexGenerationId" = input_entry."indexGenerationId"
     AND embedding."inputEntryId" = input_entry."id"
     AND embedding."sourceChunkId" = input_entry."sourceChunkId"
     AND embedding."embeddingProfileId" =
         ${EMBEDDING_STORAGE_PROFILE_ID}::uuid
    WHERE aggregate_entry."projectId" = ${projectId}::uuid
      AND aggregate_entry."projectRepositoryRagSnapshotId" =
          ${projectSnapshotId}::uuid
      AND repository_snapshot."codeIndexGenerationId" IS NOT NULL
      AND input_entry."entryKind" = 'repository_code'
      AND chunk."originScope" = 'repository_link'
      AND chunk."state" = 'active'
      AND chunk."contentText" IS NOT NULL
      AND chunk."contentHash" IS NOT NULL
      AND chunk."contentBytes" IS NOT NULL
    ORDER BY aggregate_entry."ordinal", input_entry."ordinal", input_entry."id"
    FOR SHARE OF aggregate_entry, repository_snapshot, membership,
      input_entry, chunk, code_entry, embedding
  `));
}

async function readMaterialDocuments(
  tx: Prisma.TransactionClient,
  projectId: string,
  projectSnapshotId: string,
): Promise<readonly MaterialDocumentRow[]> {
  return Object.freeze(await tx.$queryRaw<MaterialDocumentRow[]>(Prisma.sql`
    SELECT
      aggregate_entry."ordinal" AS "repositoryOrdinal",
      repository_snapshot."id"::text AS "repositoryRagSnapshotId",
      repository_snapshot."projectRepositoryLinkId"::text AS
          "projectRepositoryLinkId",
      repository_snapshot."materialIndexGenerationId"::text AS
          "materialIndexGenerationId",
      input_entry."id"::text AS "inputEntryId",
      input_entry."ordinal" AS "inputOrdinal",
      chunk."id"::text AS "sourceChunkId",
      source."id"::text AS "projectSourceId",
      source."kind"::text AS "sourceKind",
      source."externalRef",
      source."revisionKey"::text AS "sourceRevisionKey",
      chunk."rangeStart",
      chunk."rangeEnd",
      chunk."contentText",
      chunk."contentHash",
      chunk."contentBytes",
      chunk."sourceContentHash",
      source_version."materialKind"::text AS "materialKind",
      source_version."remoteIdentity",
      source_version."remoteRevisionFingerprint",
      source_version."normalizedPath",
      repository_snapshot."capturedGitHubRepositoryId" AS
          "githubRepositoryId",
      repository_snapshot."capturedFullName",
      repository_snapshot."frozenCommitSha"
    FROM "ProjectRepositoryRagSnapshotEntry" AS aggregate_entry
    JOIN "RepositoryRagSnapshot" AS repository_snapshot
      ON repository_snapshot."projectId" = aggregate_entry."projectId"
     AND repository_snapshot."projectRepositoryLinkId" =
         aggregate_entry."projectRepositoryLinkId"
     AND repository_snapshot."id" =
         aggregate_entry."repositoryRagSnapshotId"
     AND repository_snapshot."manifestFingerprint" =
         aggregate_entry."repositoryManifestFingerprint"
    JOIN "RepositoryMaterialIndexInput" AS input_entry
      ON input_entry."projectId" = repository_snapshot."projectId"
     AND input_entry."projectRepositoryLinkId" =
         repository_snapshot."projectRepositoryLinkId"
     AND input_entry."indexGenerationId" =
         repository_snapshot."materialIndexGenerationId"
     AND input_entry."repositoryMaterialGenerationId" =
         repository_snapshot."repositoryMaterialGenerationId"
    JOIN "RepositoryMaterialChunk" AS chunk
      ON chunk."projectId" = input_entry."projectId"
     AND chunk."projectRepositoryLinkId" =
         input_entry."projectRepositoryLinkId"
     AND chunk."repositoryMaterialGenerationId" =
         input_entry."repositoryMaterialGenerationId"
     AND chunk."materialGenerationEntryId" =
         input_entry."materialGenerationEntryId"
     AND chunk."id" = input_entry."sourceChunkId"
    JOIN "RepositoryMaterialGenerationEntry" AS material_entry
      ON material_entry."projectId" = input_entry."projectId"
     AND material_entry."projectRepositoryLinkId" =
         input_entry."projectRepositoryLinkId"
     AND material_entry."repositoryMaterialGenerationId" =
         input_entry."repositoryMaterialGenerationId"
     AND material_entry."id" = input_entry."materialGenerationEntryId"
    JOIN "GitHubSourceVersion" AS source_version
      ON source_version."projectId" = material_entry."projectId"
     AND source_version."projectRepositoryLinkId" =
         material_entry."projectRepositoryLinkId"
     AND source_version."id" = material_entry."githubSourceVersionId"
     AND source_version."projectSourceId" = material_entry."projectSourceId"
    JOIN "ProjectSource" AS source
      ON source."projectId" = source_version."projectId"
     AND source."id" = source_version."projectSourceId"
     AND source."originScope" = source_version."originScope"
     AND source."projectRepositoryLinkId" =
         source_version."projectRepositoryLinkId"
     AND source."revisionKey" = source_version."sourceRevisionKey"
     AND source."contentHash" = source_version."sourceContentHash"
    JOIN "RepositoryMaterialEmbedding" AS embedding
      ON embedding."projectId" = input_entry."projectId"
     AND embedding."projectRepositoryLinkId" =
         input_entry."projectRepositoryLinkId"
     AND embedding."indexGenerationId" = input_entry."indexGenerationId"
     AND embedding."inputEntryId" = input_entry."id"
     AND embedding."sourceChunkId" = input_entry."sourceChunkId"
     AND embedding."embeddingProfileId" =
         ${EMBEDDING_STORAGE_PROFILE_ID}::uuid
    WHERE aggregate_entry."projectId" = ${projectId}::uuid
      AND aggregate_entry."projectRepositoryRagSnapshotId" =
          ${projectSnapshotId}::uuid
      AND repository_snapshot."materialIndexGenerationId" IS NOT NULL
      AND chunk."originScope" = 'repository_link'
      AND source."originScope" = 'repository_link'
    ORDER BY aggregate_entry."ordinal", input_entry."ordinal", input_entry."id"
    FOR SHARE OF aggregate_entry, repository_snapshot, input_entry, chunk,
      material_entry, source_version, source, embedding
  `));
}

async function readVectorRanks(
  tx: Prisma.TransactionClient,
  input: Readonly<{
    projectId: string;
    projectSnapshotId: string;
    manualEligibility: ManualEligibilityRow | null;
    queryEmbedding: ProjectQueryEmbedding;
  }>,
): Promise<readonly HybridSearchVectorRank[]> {
  const literal = vectorLiteral(input.queryEmbedding.vector);
  const ranks: HybridSearchVectorRank[] = [];
  if (input.manualEligibility !== null) {
    const manualRows = await tx.$queryRaw<VectorRow[]>(Prisma.sql`
      SELECT
        input_entry."id"::text AS "inputEntryId",
        (embedding."vector" <=> CAST(${literal} AS vector(1536)))::double precision
          AS "distance"
      FROM "IndexGenerationInputEntry" AS input_entry
      JOIN "ChunkEmbedding" AS embedding
        ON embedding."projectId" = input_entry."projectId"
       AND embedding."indexGenerationId" = input_entry."indexGenerationId"
       AND embedding."inputEntryId" = input_entry."id"
       AND embedding."sourceChunkId" = input_entry."sourceChunkId"
      WHERE input_entry."projectId" = ${input.projectId}::uuid
        AND input_entry."indexGenerationId" =
            ${input.manualEligibility.manualIndexGenerationId}::uuid
        AND embedding."embeddingProfileId" =
            ${EMBEDDING_STORAGE_PROFILE_ID}::uuid
      ORDER BY "distance", input_entry."ordinal", input_entry."id"
    `);
    ranks.push(...manualRows.map((row) => Object.freeze({
      documentId: documentId("manual", row.inputEntryId),
      distance: row.distance,
    })));
  }
  const codeRows = await tx.$queryRaw<VectorRow[]>(Prisma.sql`
    SELECT
      input_entry."id"::text AS "inputEntryId",
      (embedding."vector" <=> CAST(${literal} AS vector(1536)))::double precision
        AS "distance"
    FROM "ProjectRepositoryRagSnapshotEntry" AS aggregate_entry
    JOIN "RepositoryRagSnapshot" AS repository_snapshot
      ON repository_snapshot."projectId" = aggregate_entry."projectId"
     AND repository_snapshot."projectRepositoryLinkId" =
         aggregate_entry."projectRepositoryLinkId"
     AND repository_snapshot."id" =
         aggregate_entry."repositoryRagSnapshotId"
    JOIN "IndexGenerationInputEntry" AS input_entry
      ON input_entry."projectId" = repository_snapshot."projectId"
     AND input_entry."indexGenerationId" =
         repository_snapshot."codeIndexGenerationId"
    JOIN "ChunkEmbedding" AS embedding
      ON embedding."projectId" = input_entry."projectId"
     AND embedding."indexGenerationId" = input_entry."indexGenerationId"
     AND embedding."inputEntryId" = input_entry."id"
     AND embedding."sourceChunkId" = input_entry."sourceChunkId"
    WHERE aggregate_entry."projectId" = ${input.projectId}::uuid
      AND aggregate_entry."projectRepositoryRagSnapshotId" =
          ${input.projectSnapshotId}::uuid
      AND repository_snapshot."codeIndexGenerationId" IS NOT NULL
      AND embedding."embeddingProfileId" =
          ${EMBEDDING_STORAGE_PROFILE_ID}::uuid
    ORDER BY "distance", aggregate_entry."ordinal", input_entry."ordinal",
      input_entry."id"
  `);
  ranks.push(...codeRows.map((row) => Object.freeze({
    documentId: documentId("code", row.inputEntryId),
    distance: row.distance,
  })));
  const materialRows = await tx.$queryRaw<VectorRow[]>(Prisma.sql`
    SELECT
      input_entry."id"::text AS "inputEntryId",
      (embedding."vector" <=> CAST(${literal} AS vector(1536)))::double precision
        AS "distance"
    FROM "ProjectRepositoryRagSnapshotEntry" AS aggregate_entry
    JOIN "RepositoryRagSnapshot" AS repository_snapshot
      ON repository_snapshot."projectId" = aggregate_entry."projectId"
     AND repository_snapshot."projectRepositoryLinkId" =
         aggregate_entry."projectRepositoryLinkId"
     AND repository_snapshot."id" =
         aggregate_entry."repositoryRagSnapshotId"
    JOIN "RepositoryMaterialIndexInput" AS input_entry
      ON input_entry."projectId" = repository_snapshot."projectId"
     AND input_entry."projectRepositoryLinkId" =
         repository_snapshot."projectRepositoryLinkId"
     AND input_entry."indexGenerationId" =
         repository_snapshot."materialIndexGenerationId"
    JOIN "RepositoryMaterialEmbedding" AS embedding
      ON embedding."projectId" = input_entry."projectId"
     AND embedding."projectRepositoryLinkId" =
         input_entry."projectRepositoryLinkId"
     AND embedding."indexGenerationId" = input_entry."indexGenerationId"
     AND embedding."inputEntryId" = input_entry."id"
     AND embedding."sourceChunkId" = input_entry."sourceChunkId"
    WHERE aggregate_entry."projectId" = ${input.projectId}::uuid
      AND aggregate_entry."projectRepositoryRagSnapshotId" =
          ${input.projectSnapshotId}::uuid
      AND repository_snapshot."materialIndexGenerationId" IS NOT NULL
      AND embedding."embeddingProfileId" =
          ${EMBEDDING_STORAGE_PROFILE_ID}::uuid
    ORDER BY "distance", aggregate_entry."ordinal", input_entry."ordinal",
      input_entry."id"
  `);
  ranks.push(...materialRows.map((row) => Object.freeze({
    documentId: documentId("material", row.inputEntryId),
    distance: row.distance,
  })));
  return Object.freeze(ranks);
}

export function createProjectRepositorySearchService(options: {
  db: PrismaClient;
}): Readonly<{
  search(input: Readonly<{
    projectId: string;
    query: string;
    take?: number;
    queryEmbedding?: ProjectQueryEmbedding;
  }>): Promise<ProjectRepositorySearchResponse>;
}> {
  if (
    typeof options !== "object" ||
    options === null ||
    typeof options.db?.$transaction !== "function"
  ) {
    return fail("PROJECT_REPOSITORY_SEARCH_INVALID_INPUT");
  }
  return Object.freeze({
    async search(input) {
      if (typeof input !== "object" || input === null) {
        return fail("PROJECT_REPOSITORY_SEARCH_INVALID_INPUT");
      }
      const expectedKeys = ["projectId", "query"];
      if (input.take !== undefined) expectedKeys.push("take");
      if (input.queryEmbedding !== undefined) expectedKeys.push("queryEmbedding");
      if (!exactKeys(input, expectedKeys)) {
        return fail("PROJECT_REPOSITORY_SEARCH_INVALID_INPUT");
      }
      const projectId = canonicalUuid(input.projectId);
      const take = canonicalTake(input.take);
      const queryEmbedding = canonicalQueryEmbedding(input.queryEmbedding);
      try {
        rankHybridSearch({ projectId, query: input.query, documents: [], take });
      } catch (error) {
        if (error instanceof HybridSearchError) {
          return fail("PROJECT_REPOSITORY_SEARCH_INVALID_INPUT");
        }
        throw error;
      }

      return options.db.$transaction(async (tx) => {
        const pointer = await tx.projectRepositoryRagSnapshotPointer.findUnique({
          where: { projectId },
          include: {
            snapshot: {
              include: {
                manualSnapshot: true,
                entries: {
                  orderBy: { ordinal: "asc" },
                  include: {
                    repositorySnapshot: {
                      include: {
                        codeIndex: { include: { indexGeneration: true } },
                        materialIndex: true,
                      },
                    },
                  },
                },
              },
            },
          },
        });
        if (pointer === null) {
          const project = await tx.project.findUnique({
            where: { id: projectId },
            select: { id: true },
          });
          return fail(project === null
            ? "PROJECT_REPOSITORY_SEARCH_PROJECT_NOT_FOUND"
            : "PROJECT_REPOSITORY_SEARCH_SNAPSHOT_NOT_READY");
        }
        const currentRows = await tx.$queryRaw<Array<{ current: boolean }>>(Prisma.sql`
          SELECT "project_repository_rag_snapshot_is_current"(
            ${projectId}::uuid,
            ${pointer.projectRepositoryRagSnapshotId}::uuid
          ) AS "current"
        `);
        const snapshot = pointer.snapshot;
        if (
          currentRows.length !== 1 ||
          currentRows[0]!.current !== true ||
          snapshot.status !== "complete" ||
          snapshot.completedAt === null ||
          snapshot.supersededAt !== null ||
          !FINGERPRINT_PATTERN.test(snapshot.manifestFingerprint) ||
          snapshot.entries.length !== snapshot.requiredRepositoryCount ||
          snapshot.entries.some((entry, ordinal) =>
            entry.ordinal !== ordinal ||
            entry.repositoryManifestFingerprint !==
              entry.repositorySnapshot.manifestFingerprint ||
            entry.repositorySnapshot.id !== entry.repositoryRagSnapshotId ||
            entry.repositorySnapshot.projectRepositoryLinkId !==
              entry.projectRepositoryLinkId)
        ) {
          return fail("PROJECT_REPOSITORY_SEARCH_SNAPSHOT_INELIGIBLE");
        }

        let expectedDocumentCount = 0;
        for (const entry of snapshot.entries) {
          const repositorySnapshot = entry.repositorySnapshot;
          const codeExpected = repositorySnapshot.codeIndex?.indexGeneration
            .expectedInputCount ?? 0;
          const materialExpected = repositorySnapshot.materialIndex
            ?.expectedInputCount ?? 0;
          if (
            (repositorySnapshot.codeIndexGenerationId === null) !==
              (repositorySnapshot.repositoryCodeGenerationId === null) ||
            (repositorySnapshot.materialIndexGenerationId === null) !==
              (repositorySnapshot.repositoryMaterialGenerationId === null) ||
            codeExpected < 0 ||
            materialExpected < 0
          ) {
            return fail("PROJECT_REPOSITORY_SEARCH_SNAPSHOT_CONFLICT");
          }
          expectedDocumentCount += codeExpected + materialExpected;
        }

        let manualEligibility: ManualEligibilityRow | null = null;
        let manualRows: readonly ManualDocumentRow[] = Object.freeze([]);
        if (snapshot.manualRagSnapshotId !== null) {
          if (
            snapshot.manualSnapshot === null ||
            snapshot.manualManifestFingerprint !==
              snapshot.manualSnapshot.manifestFingerprint
          ) {
            return fail("PROJECT_REPOSITORY_SEARCH_SNAPSHOT_CONFLICT");
          }
          manualEligibility = await readManualEligibility(
            tx,
            projectId,
            snapshot.manualRagSnapshotId,
          );
          expectedDocumentCount += manualEligibility.expectedInputCount;
          manualRows = await readManualDocuments(tx, projectId, manualEligibility);
        } else if (
          snapshot.manualManifestFingerprint !== null ||
          snapshot.manualSnapshot !== null
        ) {
          return fail("PROJECT_REPOSITORY_SEARCH_SNAPSHOT_CONFLICT");
        }
        if (expectedDocumentCount > HYBRID_SEARCH_MAX_DOCUMENTS) {
          return fail("PROJECT_REPOSITORY_SEARCH_SCOPE_TOO_LARGE");
        }

        const [codeRows, materialRows] = await Promise.all([
          readCodeDocuments(tx, projectId, snapshot.id),
          readMaterialDocuments(tx, projectId, snapshot.id),
        ]);
        if (
          manualRows.length + codeRows.length + materialRows.length !==
            expectedDocumentCount
        ) {
          return fail("PROJECT_REPOSITORY_SEARCH_SNAPSHOT_CONFLICT");
        }

        const documents: HybridSearchDocument[] = [];
        const citations = new Map<string, ProjectRepositorySearchCitation>();
        const seenDocuments = new Set<string>();
        const seenChunks = new Set<string>();
        const append = (
          document: HybridSearchDocument,
          citation: ProjectRepositorySearchCitation,
        ): void => {
          if (
            seenDocuments.has(document.id) ||
            seenChunks.has(citation.chunkId)
          ) {
            return fail("PROJECT_REPOSITORY_SEARCH_SNAPSHOT_CONFLICT");
          }
          seenDocuments.add(document.id);
          seenChunks.add(citation.chunkId);
          documents.push(Object.freeze({ ...document, ordinal: documents.length }));
          citations.set(document.id, Object.freeze(citation));
        };

        for (const row of manualRows) {
          if (
            !UUID_PATTERN.test(row.inputEntryId) ||
            !UUID_PATTERN.test(row.sourceId) ||
            !UUID_PATTERN.test(row.chunkId) ||
            !validContent(row)
          ) {
            return fail("PROJECT_REPOSITORY_SEARCH_SNAPSHOT_CONFLICT");
          }
          const id = documentId("manual", row.inputEntryId);
          append({
            id,
            projectId,
            sourceId: row.sourceId,
            contentText: row.contentText,
            ordinal: 0,
            externalRef: row.externalRef,
          }, {
            origin: "project",
            projectId,
            projectRepositoryLinkId: null,
            repositoryRagSnapshotId: null,
            sourceId: row.sourceId,
            sourceKind: sourceKind(row.sourceKind),
            externalRef: row.externalRef,
            chunkId: row.chunkId,
            rangeUnit: rangeUnit(row.rangeUnit),
            rangeStart: row.rangeStart,
            rangeEnd: row.rangeEnd,
            contentHash: row.contentHash,
            excerpt: row.contentText,
            immutableRef: null,
          });
        }

        const codeCounts = new Map<string, number>();
        for (const row of codeRows) {
          if (
            !UUID_PATTERN.test(row.inputEntryId) ||
            !UUID_PATTERN.test(row.repositoryRagSnapshotId) ||
            !UUID_PATTERN.test(row.projectRepositoryLinkId) ||
            !UUID_PATTERN.test(row.repositoryFileRevisionId) ||
            !UUID_PATTERN.test(row.sourceChunkId) ||
            !COMMIT_SHA_PATTERN.test(row.frozenCommitSha) ||
            row.normalizedPath.length === 0 ||
            !validContent(row) ||
            row.rangeStart < 1
          ) {
            return fail("PROJECT_REPOSITORY_SEARCH_SNAPSHOT_CONFLICT");
          }
          const key = `${row.projectRepositoryLinkId}:${row.codeIndexGenerationId}`;
          codeCounts.set(key, (codeCounts.get(key) ?? 0) + 1);
          const id = documentId("code", row.inputEntryId);
          const lineEnd = row.rangeEnd - 1;
          const immutableRef =
            `${row.capturedFullName}@${row.frozenCommitSha}:` +
            `${row.normalizedPath}#L${row.rangeStart}-L${lineEnd}`;
          append({
            id,
            projectId,
            sourceId: row.repositoryFileRevisionId,
            contentText: `${row.normalizedPath}\n${row.contentText}`,
            ordinal: 0,
            externalRef: row.normalizedPath,
          }, {
            origin: "repositoryCode",
            projectId,
            projectRepositoryLinkId: row.projectRepositoryLinkId,
            repositoryRagSnapshotId: row.repositoryRagSnapshotId,
            sourceId: row.repositoryFileRevisionId,
            sourceKind: "github",
            externalRef: row.normalizedPath,
            chunkId: row.sourceChunkId,
            rangeUnit: "line",
            rangeStart: row.rangeStart,
            rangeEnd: lineEnd,
            contentHash: row.contentHash,
            excerpt: row.contentText,
            githubRepositoryId: row.githubRepositoryId.toString(),
            capturedFullName: row.capturedFullName,
            frozenCommitSha: row.frozenCommitSha,
            normalizedPath: row.normalizedPath,
            repositoryFileRevisionId: row.repositoryFileRevisionId,
            immutableRef,
          });
        }

        const materialCounts = new Map<string, number>();
        for (const row of materialRows) {
          if (
            !UUID_PATTERN.test(row.inputEntryId) ||
            !UUID_PATTERN.test(row.repositoryRagSnapshotId) ||
            !UUID_PATTERN.test(row.projectRepositoryLinkId) ||
            !UUID_PATTERN.test(row.projectSourceId) ||
            !UUID_PATTERN.test(row.sourceChunkId) ||
            !UUID_PATTERN.test(row.sourceRevisionKey) ||
            !COMMIT_SHA_PATTERN.test(row.frozenCommitSha) ||
            row.sourceKind !== "github" ||
            !FINGERPRINT_PATTERN.test(row.sourceContentHash) ||
            !FINGERPRINT_PATTERN.test(row.remoteRevisionFingerprint) ||
            !validContent(row)
          ) {
            return fail("PROJECT_REPOSITORY_SEARCH_SNAPSHOT_CONFLICT");
          }
          const key =
            `${row.projectRepositoryLinkId}:${row.materialIndexGenerationId}`;
          materialCounts.set(key, (materialCounts.get(key) ?? 0) + 1);
          const kind = materialKind(row.materialKind);
          const id = documentId("material", row.inputEntryId);
          append({
            id,
            projectId,
            sourceId: row.projectSourceId,
            contentText: [
              kind,
              row.normalizedPath ?? row.remoteIdentity,
              row.contentText,
            ].join("\n"),
            ordinal: 0,
            externalRef: row.externalRef,
          }, {
            origin: "repositoryMaterial",
            projectId,
            projectRepositoryLinkId: row.projectRepositoryLinkId,
            repositoryRagSnapshotId: row.repositoryRagSnapshotId,
            sourceId: row.projectSourceId,
            sourceKind: "github",
            externalRef: row.externalRef,
            chunkId: row.sourceChunkId,
            rangeUnit: "utf8_byte",
            rangeStart: row.rangeStart,
            rangeEnd: row.rangeEnd,
            contentHash: row.contentHash,
            excerpt: row.contentText,
            githubRepositoryId: row.githubRepositoryId.toString(),
            capturedFullName: row.capturedFullName,
            frozenCommitSha: row.frozenCommitSha,
            materialKind: kind,
            remoteIdentity: row.remoteIdentity,
            remoteRevisionFingerprint: row.remoteRevisionFingerprint,
            normalizedPath: row.normalizedPath,
            immutableRef: immutableMaterialRef(row),
          });
        }

        for (const entry of snapshot.entries) {
          const repositorySnapshot = entry.repositorySnapshot;
          if (repositorySnapshot.codeIndexGenerationId !== null) {
            const key = `${entry.projectRepositoryLinkId}:` +
              repositorySnapshot.codeIndexGenerationId;
            if (
              codeCounts.get(key) !==
                repositorySnapshot.codeIndex!.indexGeneration.expectedInputCount
            ) {
              return fail("PROJECT_REPOSITORY_SEARCH_SNAPSHOT_CONFLICT");
            }
          }
          if (repositorySnapshot.materialIndexGenerationId !== null) {
            const key = `${entry.projectRepositoryLinkId}:` +
              repositorySnapshot.materialIndexGenerationId;
            if (
              materialCounts.get(key) !==
                repositorySnapshot.materialIndex!.expectedInputCount
            ) {
              return fail("PROJECT_REPOSITORY_SEARCH_SNAPSHOT_CONFLICT");
            }
          }
        }

        const vectorRanks = queryEmbedding === undefined
          ? undefined
          : await readVectorRanks(tx, {
              projectId,
              projectSnapshotId: snapshot.id,
              manualEligibility,
              queryEmbedding,
            });
        if (
          vectorRanks !== undefined &&
          vectorRanks.length !== expectedDocumentCount
        ) {
          return fail("PROJECT_REPOSITORY_SEARCH_SNAPSHOT_CONFLICT");
        }
        let ranked;
        try {
          ranked = rankHybridSearch({
            projectId,
            query: input.query,
            documents,
            vectorRanks,
            take,
          });
        } catch (error) {
          if (error instanceof HybridSearchError) {
            return fail(error.code === "HYBRID_SEARCH_DOCUMENT_LIMIT"
              ? "PROJECT_REPOSITORY_SEARCH_SCOPE_TOO_LARGE"
              : "PROJECT_REPOSITORY_SEARCH_INVALID_INPUT");
          }
          throw error;
        }
        return Object.freeze({
          searchVersion: PROJECT_REPOSITORY_SEARCH_VERSION,
          mode: queryEmbedding === undefined ? "lexical" as const : "hybrid" as const,
          snapshot: Object.freeze({
            id: snapshot.id,
            manifestFingerprint: snapshot.manifestFingerprint,
            policyRevisionId: snapshot.policyRevisionId,
            effectivePolicyVersion: snapshot.effectivePolicyVersion,
            manualRagSnapshotId: snapshot.manualRagSnapshotId,
            requiredRepositoryCount: snapshot.requiredRepositoryCount,
            publishedAt: new Date(pointer.publishedAt.getTime()),
          }),
          results: Object.freeze(ranked.map((result, index) => {
            const citation = citations.get(result.document.id);
            if (citation === undefined) {
              return fail("PROJECT_REPOSITORY_SEARCH_SNAPSHOT_CONFLICT");
            }
            return Object.freeze({
              rank: index + 1,
              score: result.score,
              matchedFeatures: result.matchedFeatures,
              componentRanks: result.ranks,
              citation,
            });
          })),
        });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    },
  });
}
