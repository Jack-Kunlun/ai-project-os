import { Prisma, type PrismaClient } from "@prisma/client";
import { hashSourceContent } from "@/lib/source";
import {
  EMBEDDING_STORAGE_PROFILE_ID,
  EMBEDDING_STORAGE_PROFILE_FINGERPRINT,
} from "./corpus-index";
import {
  HYBRID_SEARCH_MAX_DOCUMENTS,
  HybridSearchError,
  rankHybridSearch,
  type HybridSearchDocument,
  type HybridSearchVectorRank,
} from "./hybrid-search";

export const PROJECT_SEARCH_VERSION = "project-search:v1" as const;
export const PROJECT_SEARCH_VECTOR_DIMENSIONS = 1_536 as const;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

export type ProjectSearchErrorCode =
  | "PROJECT_SEARCH_INVALID_INPUT"
  | "PROJECT_SEARCH_PROJECT_NOT_FOUND"
  | "PROJECT_SEARCH_SNAPSHOT_NOT_READY"
  | "PROJECT_SEARCH_SNAPSHOT_INELIGIBLE"
  | "PROJECT_SEARCH_SNAPSHOT_TOO_LARGE"
  | "PROJECT_SEARCH_SNAPSHOT_CONFLICT";

export class ProjectSearchError extends Error {
  constructor(readonly code: ProjectSearchErrorCode) {
    super(code);
    this.name = "ProjectSearchError";
  }
}

export type ProjectQueryEmbedding = Readonly<{
  profileFingerprint: typeof EMBEDDING_STORAGE_PROFILE_FINGERPRINT;
  vector: readonly number[];
}>;

export type ProjectSearchCitation = Readonly<{
  projectId: string;
  sourceId: string;
  sourceKind: "document" | "screenshot" | "github" | "git" | "web" | "manual" | "mcp";
  externalRef: string | null;
  chunkId: string;
  rangeUnit: "utf8_byte" | "line";
  rangeStart: number;
  rangeEnd: number;
  contentHash: string;
  excerpt: string;
}>;

export type ProjectSearchResponse = Readonly<{
  searchVersion: typeof PROJECT_SEARCH_VERSION;
  mode: "lexical" | "hybrid";
  snapshot: Readonly<{
    id: string;
    manifestFingerprint: string;
    manualIndexGenerationId: string;
    manualCorpusGenerationId: string;
    effectivePolicyVersion: number;
    publishedAt: Date;
  }>;
  results: readonly Readonly<{
    rank: number;
    score: number;
    matchedFeatures: readonly string[];
    componentRanks: Readonly<{
      vector: number | null;
      cjk: number | null;
      identifier: number | null;
      substring: number | null;
      token: number | null;
    }>;
    citation: ProjectSearchCitation;
  }>[];
}>;

type SnapshotPointerRow = {
  ragSnapshotId: string;
  publishedAt: Date;
};

type EligibleSnapshotRow = {
  id: string;
  manifestFingerprint: string;
  manualIndexGenerationId: string;
  manualCorpusGenerationId: string;
  effectivePolicyVersion: number;
  expectedInputCount: number;
  publishedAt: Date;
};

type SearchDocumentRow = {
  documentId: string;
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
  ordinal: number;
};

type VectorRankRow = {
  documentId: string;
  distance: number;
};

function fail(code: ProjectSearchErrorCode): never {
  throw new ProjectSearchError(code);
}

function canonicalUuid(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    return fail("PROJECT_SEARCH_INVALID_INPUT");
  }
  return value;
}

function canonicalTake(value: unknown): number {
  if (value === undefined) return 10;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 20) {
    return fail("PROJECT_SEARCH_INVALID_INPUT");
  }
  return value as number;
}

function canonicalQueryEmbedding(value: unknown): ProjectQueryEmbedding | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail("PROJECT_SEARCH_INVALID_INPUT");
  }
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== "profileFingerprint" || keys[1] !== "vector") {
    return fail("PROJECT_SEARCH_INVALID_INPUT");
  }
  const record = value as Record<string, unknown>;
  if (
    record.profileFingerprint !== EMBEDDING_STORAGE_PROFILE_FINGERPRINT ||
    !FINGERPRINT_PATTERN.test(record.profileFingerprint)
  ) {
    return fail("PROJECT_SEARCH_INVALID_INPUT");
  }
  if (!Array.isArray(record.vector) || record.vector.length !== PROJECT_SEARCH_VECTOR_DIMENSIONS) {
    return fail("PROJECT_SEARCH_INVALID_INPUT");
  }
  const vector = record.vector.map((component) => {
    if (typeof component !== "number" || !Number.isFinite(component)) {
      return fail("PROJECT_SEARCH_INVALID_INPUT");
    }
    return Math.fround(component);
  });
  const norm = Math.sqrt(vector.reduce((sum, component) => sum + component * component, 0));
  if (norm < 0.99 || norm > 1.01) {
    return fail("PROJECT_SEARCH_INVALID_INPUT");
  }
  return Object.freeze({
    profileFingerprint: EMBEDDING_STORAGE_PROFILE_FINGERPRINT,
    vector: Object.freeze(vector),
  });
}

function vectorLiteral(vector: readonly number[]): string {
  return `[${vector.map((component) => component.toString()).join(",")}]`;
}

function sourceKind(value: string): ProjectSearchCitation["sourceKind"] {
  if (!["document", "screenshot", "github", "git", "web", "manual", "mcp"].includes(value)) {
    return fail("PROJECT_SEARCH_SNAPSHOT_CONFLICT");
  }
  return value as ProjectSearchCitation["sourceKind"];
}

function rangeUnit(value: string): ProjectSearchCitation["rangeUnit"] {
  if (value !== "utf8_byte" && value !== "line") {
    return fail("PROJECT_SEARCH_SNAPSHOT_CONFLICT");
  }
  return value;
}

function validateDocumentRows(
  projectId: string,
  expectedInputCount: number,
  rows: readonly SearchDocumentRow[],
): Readonly<{
  documents: readonly HybridSearchDocument[];
  citations: ReadonlyMap<string, ProjectSearchCitation>;
}> {
  if (
    !Number.isSafeInteger(expectedInputCount) ||
    expectedInputCount < 0 ||
    expectedInputCount > HYBRID_SEARCH_MAX_DOCUMENTS
  ) {
    return fail(expectedInputCount > HYBRID_SEARCH_MAX_DOCUMENTS
      ? "PROJECT_SEARCH_SNAPSHOT_TOO_LARGE"
      : "PROJECT_SEARCH_SNAPSHOT_CONFLICT");
  }
  if (rows.length !== expectedInputCount) {
    return fail("PROJECT_SEARCH_SNAPSHOT_CONFLICT");
  }
  const documents: HybridSearchDocument[] = [];
  const citations = new Map<string, ProjectSearchCitation>();
  const sourceChunks = new Set<string>();
  for (const [ordinal, row] of rows.entries()) {
    if (
      row.ordinal !== ordinal ||
      !UUID_PATTERN.test(row.documentId) ||
      !UUID_PATTERN.test(row.sourceId) ||
      !UUID_PATTERN.test(row.chunkId) ||
      sourceChunks.has(row.chunkId) ||
      typeof row.contentText !== "string" ||
      row.contentText.length === 0 ||
      !FINGERPRINT_PATTERN.test(row.contentHash) ||
      row.contentHash !== hashSourceContent(row.contentText) ||
      row.contentBytes !== Buffer.byteLength(row.contentText, "utf8") ||
      !Number.isSafeInteger(row.rangeStart) ||
      !Number.isSafeInteger(row.rangeEnd) ||
      row.rangeStart < 0 ||
      row.rangeEnd <= row.rangeStart
    ) {
      return fail("PROJECT_SEARCH_SNAPSHOT_CONFLICT");
    }
    sourceChunks.add(row.chunkId);
    documents.push(Object.freeze({
      id: row.documentId,
      projectId,
      sourceId: row.sourceId,
      contentText: row.contentText,
      ordinal: row.ordinal,
      externalRef: row.externalRef,
    }));
    citations.set(row.documentId, Object.freeze({
      projectId,
      sourceId: row.sourceId,
      sourceKind: sourceKind(row.sourceKind),
      externalRef: row.externalRef,
      chunkId: row.chunkId,
      rangeUnit: rangeUnit(row.rangeUnit),
      rangeStart: row.rangeStart,
      rangeEnd: row.rangeEnd,
      contentHash: row.contentHash,
      excerpt: row.contentText,
    }));
  }
  return Object.freeze({
    documents: Object.freeze(documents),
    citations,
  });
}

export function createProjectSearchService(options: { db: PrismaClient }): {
  search(input: Readonly<{
    projectId: string;
    query: string;
    take?: number;
    queryEmbedding?: ProjectQueryEmbedding;
  }>): Promise<ProjectSearchResponse>;
} {
  if (
    typeof options !== "object" ||
    options === null ||
    typeof options.db?.$transaction !== "function"
  ) {
    return fail("PROJECT_SEARCH_INVALID_INPUT");
  }

  return Object.freeze({
    async search(input): Promise<ProjectSearchResponse> {
      if (typeof input !== "object" || input === null) {
        return fail("PROJECT_SEARCH_INVALID_INPUT");
      }
      const projectId = canonicalUuid(input.projectId);
      const take = canonicalTake(input.take);
      const queryEmbedding = canonicalQueryEmbedding(input.queryEmbedding);
      try {
        rankHybridSearch({
          projectId,
          query: input.query,
          documents: [],
          take,
        });
      } catch (error) {
        if (error instanceof HybridSearchError) {
          return fail("PROJECT_SEARCH_INVALID_INPUT");
        }
        throw error;
      }

      return options.db.$transaction(async (tx) => {
        const pointers = await tx.$queryRaw<SnapshotPointerRow[]>(Prisma.sql`
          SELECT
            pointer."ragSnapshotId"::text AS "ragSnapshotId",
            pointer."publishedAt"
          FROM "ProjectRagSnapshotPointer" AS pointer
          WHERE pointer."projectId" = ${projectId}::uuid
          FOR SHARE OF pointer
        `);
        if (pointers.length === 0) {
          const project = await tx.project.findUnique({
            where: { id: projectId },
            select: { id: true },
          });
          return fail(project === null
            ? "PROJECT_SEARCH_PROJECT_NOT_FOUND"
            : "PROJECT_SEARCH_SNAPSHOT_NOT_READY");
        }
        if (pointers.length !== 1) return fail("PROJECT_SEARCH_SNAPSHOT_CONFLICT");
        const pointer = pointers[0]!;

        const snapshots = await tx.$queryRaw<EligibleSnapshotRow[]>(Prisma.sql`
          SELECT
            snapshot."id"::text AS "id",
            snapshot."manifestFingerprint",
            snapshot."manualIndexGenerationId"::text AS "manualIndexGenerationId",
            snapshot."manualCorpusGenerationId"::text AS "manualCorpusGenerationId",
            snapshot."effectivePolicyVersion",
            index_generation."expectedInputCount",
            ${pointer.publishedAt}::timestamp AS "publishedAt"
          FROM "ProjectRagSnapshot" AS snapshot
          JOIN "ProjectCorpusIndexGeneration" AS project_index
            ON project_index."projectId" = snapshot."projectId"
           AND project_index."indexGenerationId" = snapshot."manualIndexGenerationId"
           AND project_index."corpusGenerationId" = snapshot."manualCorpusGenerationId"
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
          JOIN "ProjectCorpusIndexPointer" AS manual_pointer
            ON manual_pointer."projectId" = project_index."projectId"
           AND manual_pointer."indexGenerationId" = project_index."indexGenerationId"
           AND manual_pointer."corpusGenerationId" = project_index."corpusGenerationId"
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
            AND snapshot."id" = ${pointer.ragSnapshotId}::uuid
            AND snapshot."status" = 'complete'
            AND snapshot."requiredRepositoryCount" = 0
            AND snapshot."completedAt" IS NOT NULL
            AND snapshot."supersededAt" IS NULL
            AND index_generation."kind" = 'project_corpus'
            AND index_generation."status" = 'rag_ready'
            AND index_generation."expectedInputCount" > 0
            AND index_generation."indexedInputCount" = index_generation."expectedInputCount"
            AND corpus_generation."status" = 'complete'
            AND grant_row."status" = 'issued'
            AND grant_row."issuedAt" IS NOT NULL
            AND grant_row."revokedAt" IS NULL
            AND grant_row."expiresAt" IS NOT NULL
            AND grant_row."expiresAt" > CURRENT_TIMESTAMP
            AND grant_row."effectivePolicyVersion" = snapshot."effectivePolicyVersion"
            AND profile."profileFingerprint" = ${EMBEDDING_STORAGE_PROFILE_FINGERPRINT}
          FOR SHARE OF snapshot, project_index, index_generation,
            corpus_generation, manual_pointer, grant_row, grant_operation,
            policy, profile
        `);
        if (snapshots.length !== 1) {
          return fail("PROJECT_SEARCH_SNAPSHOT_INELIGIBLE");
        }
        const snapshot = snapshots[0]!;
        if (snapshot.expectedInputCount > HYBRID_SEARCH_MAX_DOCUMENTS) {
          return fail("PROJECT_SEARCH_SNAPSHOT_TOO_LARGE");
        }

        const rows = await tx.$queryRaw<SearchDocumentRow[]>(Prisma.sql`
          SELECT
            input_entry."id"::text AS "documentId",
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
            input_entry."ordinal"
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
          WHERE membership."projectId" = ${projectId}::uuid
            AND membership."indexGenerationId" = ${snapshot.manualIndexGenerationId}::uuid
            AND membership."corpusGenerationId" = ${snapshot.manualCorpusGenerationId}::uuid
            AND input_entry."entryKind" = 'project_corpus'
            AND chunk."originScope" = 'project'
            AND chunk."state" = 'active'
            AND chunk."contentText" IS NOT NULL
            AND chunk."contentHash" IS NOT NULL
            AND chunk."contentBytes" IS NOT NULL
          ORDER BY input_entry."ordinal", input_entry."id"
          FOR SHARE OF membership, input_entry, corpus_entry, chunk, source, embedding
        `);
        const validated = validateDocumentRows(
          projectId,
          snapshot.expectedInputCount,
          rows,
        );

        let vectorRanks: readonly HybridSearchVectorRank[] | undefined;
        if (queryEmbedding !== undefined) {
          const literal = vectorLiteral(queryEmbedding.vector);
          const vectorRows = await tx.$queryRaw<VectorRankRow[]>(Prisma.sql`
            SELECT
              input_entry."id"::text AS "documentId",
              (embedding."vector" <=> CAST(${literal} AS vector(1536)))::double precision AS "distance"
            FROM "IndexGenerationInputEntry" AS input_entry
            JOIN "ChunkEmbedding" AS embedding
              ON embedding."projectId" = input_entry."projectId"
             AND embedding."indexGenerationId" = input_entry."indexGenerationId"
             AND embedding."inputEntryId" = input_entry."id"
             AND embedding."sourceChunkId" = input_entry."sourceChunkId"
            WHERE input_entry."projectId" = ${projectId}::uuid
              AND input_entry."indexGenerationId" = ${snapshot.manualIndexGenerationId}::uuid
              AND embedding."embeddingProfileId" = ${EMBEDDING_STORAGE_PROFILE_ID}::uuid
            ORDER BY "distance", input_entry."ordinal", input_entry."id"
            LIMIT ${Math.min(snapshot.expectedInputCount, 200)}
          `);
          vectorRanks = Object.freeze(vectorRows.map((row) => Object.freeze({
            documentId: row.documentId,
            distance: row.distance,
          })));
        }

        let ranked;
        try {
          ranked = rankHybridSearch({
            projectId,
            query: input.query,
            documents: validated.documents,
            vectorRanks,
            take,
          });
        } catch (error) {
          if (error instanceof HybridSearchError) {
            return fail("PROJECT_SEARCH_INVALID_INPUT");
          }
          throw error;
        }

        return Object.freeze({
          searchVersion: PROJECT_SEARCH_VERSION,
          mode: queryEmbedding === undefined ? "lexical" as const : "hybrid" as const,
          snapshot: Object.freeze({
            id: snapshot.id,
            manifestFingerprint: snapshot.manifestFingerprint,
            manualIndexGenerationId: snapshot.manualIndexGenerationId,
            manualCorpusGenerationId: snapshot.manualCorpusGenerationId,
            effectivePolicyVersion: snapshot.effectivePolicyVersion,
            publishedAt: snapshot.publishedAt,
          }),
          results: Object.freeze(ranked.map((result, index) => {
            const citation = validated.citations.get(result.document.id);
            if (citation === undefined) return fail("PROJECT_SEARCH_SNAPSHOT_CONFLICT");
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
