CREATE TYPE "ProjectCorpusGenerationStatus" AS ENUM (
    'staging', 'complete', 'failed', 'ineligible', 'superseded'
);

CREATE TYPE "IndexGenerationKind" AS ENUM (
    'project_corpus', 'repository_material', 'repository_code'
);

CREATE TYPE "IndexGenerationStatus" AS ENUM (
    'staging', 'building', 'rag_ready', 'rag_ready_empty',
    'semantic_disabled_by_policy', 'failed', 'unknown', 'cancelled',
    'ineligible', 'superseded'
);

CREATE TYPE "IndexInputEntryKind" AS ENUM (
    'project_corpus', 'repository_material', 'repository_code'
);

CREATE TYPE "IndexBuildAttemptStatus" AS ENUM (
    'queued', 'running', 'succeeded', 'failed', 'unknown', 'cancelled'
);

CREATE TYPE "IndexWorkItemStatus" AS ENUM (
    'queued', 'running', 'succeeded', 'failed', 'unknown', 'cancelled'
);

CREATE UNIQUE INDEX "ModelProcessingGrantSource_projectId_id_grantId_sourceId_key"
ON "ModelProcessingGrantSource"("projectId", "id", "grantId", "sourceId");

CREATE UNIQUE INDEX "SourceChunk_exact_revision_content_key"
ON "SourceChunk"(
    "projectId", "id", "projectSourceId", "originScope",
    "sourceRevisionKey", "sourceContentHash", "contentHash"
);

CREATE TABLE "ProjectCorpusGeneration" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "grantId" UUID NOT NULL,
    "policyRevisionId" UUID NOT NULL,
    "status" "ProjectCorpusGenerationStatus" NOT NULL DEFAULT 'staging',
    "generationKey" VARCHAR(64) NOT NULL,
    "sourceManifestFingerprint" VARCHAR(64) NOT NULL,
    "chunkManifestFingerprint" VARCHAR(64) NOT NULL,
    "sourceCount" INTEGER NOT NULL,
    "expectedChunkCount" INTEGER NOT NULL,
    "chunkerVersion" VARCHAR(128) NOT NULL,
    "failureCode" VARCHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "supersededAt" TIMESTAMP(3),

    CONSTRAINT "ProjectCorpusGeneration_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ProjectCorpusGeneration_fingerprint_check" CHECK (
        "generationKey" ~ '^[0-9a-f]{64}$'
        AND "sourceManifestFingerprint" ~ '^[0-9a-f]{64}$'
        AND "chunkManifestFingerprint" ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT "ProjectCorpusGeneration_count_check" CHECK (
        "sourceCount" > 0 AND "expectedChunkCount" > 0
    ),
    CONSTRAINT "ProjectCorpusGeneration_chunker_check" CHECK (
        "chunkerVersion" ~ '^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$'
    ),
    CONSTRAINT "ProjectCorpusGeneration_lifecycle_check" CHECK (
        ("status" = 'staging' AND "completedAt" IS NULL
            AND "supersededAt" IS NULL AND "failureCode" IS NULL)
        OR ("status" = 'complete' AND "completedAt" IS NOT NULL
            AND "supersededAt" IS NULL AND "failureCode" IS NULL)
        OR ("status" IN ('failed', 'ineligible') AND "completedAt" IS NOT NULL
            AND "supersededAt" IS NULL
            AND "failureCode" ~ '^[A-Z][A-Z0-9_]{0,63}$')
        OR ("status" = 'superseded' AND "completedAt" IS NOT NULL
            AND "supersededAt" IS NOT NULL AND "failureCode" IS NULL)
    )
);

CREATE UNIQUE INDEX "ProjectCorpusGeneration_projectId_id_key"
ON "ProjectCorpusGeneration"("projectId", "id");
CREATE UNIQUE INDEX "ProjectCorpusGeneration_projectId_id_grantId_key"
ON "ProjectCorpusGeneration"("projectId", "id", "grantId");
CREATE UNIQUE INDEX "ProjectCorpusGeneration_index_grant_policy_key"
ON "ProjectCorpusGeneration"("projectId", "id", "grantId", "policyRevisionId");
CREATE UNIQUE INDEX "ProjectCorpusGeneration_projectId_generationKey_key"
ON "ProjectCorpusGeneration"("projectId", "generationKey");
CREATE INDEX "ProjectCorpusGeneration_projectId_status_createdAt_idx"
ON "ProjectCorpusGeneration"("projectId", "status", "createdAt");
CREATE INDEX "ProjectCorpusGeneration_projectId_grantId_idx"
ON "ProjectCorpusGeneration"("projectId", "grantId");

CREATE TABLE "ProjectCorpusGenerationEntry" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "corpusGenerationId" UUID NOT NULL,
    "grantId" UUID NOT NULL,
    "grantSourceId" UUID NOT NULL,
    "projectSourceId" UUID NOT NULL,
    "originScope" "ContentOriginScope" NOT NULL,
    "sourceRevisionKey" UUID NOT NULL,
    "sourceContentHash" VARCHAR(64) NOT NULL,
    "sourceChunkId" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "chunkContentHash" VARCHAR(64) NOT NULL,
    "chunkContentBytes" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectCorpusGenerationEntry_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ProjectCorpusGenerationEntry_scope_check" CHECK (
        "originScope" = 'project'
    ),
    CONSTRAINT "ProjectCorpusGenerationEntry_content_check" CHECK (
        "ordinal" >= 0
        AND "sourceContentHash" ~ '^[0-9a-f]{64}$'
        AND "chunkContentHash" ~ '^[0-9a-f]{64}$'
        AND "chunkContentBytes" > 0
    )
);

CREATE UNIQUE INDEX "ProjectCorpusGenerationEntry_projectId_id_key"
ON "ProjectCorpusGenerationEntry"("projectId", "id");
CREATE UNIQUE INDEX "CorpusEntry_generation_id_key"
ON "ProjectCorpusGenerationEntry"("projectId", "corpusGenerationId", "id");
CREATE UNIQUE INDEX "CorpusEntry_generation_chunk_key"
ON "ProjectCorpusGenerationEntry"(
    "projectId", "corpusGenerationId", "id", "sourceChunkId"
);
CREATE UNIQUE INDEX "ProjectCorpusGenerationEntry_generation_sourceChunk_key"
ON "ProjectCorpusGenerationEntry"(
    "projectId", "corpusGenerationId", "sourceChunkId"
);
CREATE UNIQUE INDEX "ProjectCorpusGenerationEntry_generation_ordinal_key"
ON "ProjectCorpusGenerationEntry"(
    "projectId", "corpusGenerationId", "ordinal"
);
CREATE INDEX "ProjectCorpusGenerationEntry_project_source_ordinal_idx"
ON "ProjectCorpusGenerationEntry"("projectId", "projectSourceId", "ordinal");

CREATE TABLE "IndexGeneration" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "kind" "IndexGenerationKind" NOT NULL,
    "grantId" UUID NOT NULL,
    "policyRevisionId" UUID NOT NULL,
    "embeddingProfileId" UUID NOT NULL,
    "status" "IndexGenerationStatus" NOT NULL DEFAULT 'staging',
    "generationKey" VARCHAR(64) NOT NULL,
    "inputManifestFingerprint" VARCHAR(64) NOT NULL,
    "processingBoundaryFingerprint" VARCHAR(64) NOT NULL,
    "expectedInputCount" INTEGER NOT NULL,
    "indexedInputCount" INTEGER NOT NULL DEFAULT 0,
    "failureCode" VARCHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "buildStartedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "supersededAt" TIMESTAMP(3),

    CONSTRAINT "IndexGeneration_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "IndexGeneration_fingerprint_check" CHECK (
        "generationKey" ~ '^[0-9a-f]{64}$'
        AND "inputManifestFingerprint" ~ '^[0-9a-f]{64}$'
        AND "processingBoundaryFingerprint" ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT "IndexGeneration_count_check" CHECK (
        "expectedInputCount" >= 0
        AND "indexedInputCount" >= 0
        AND "indexedInputCount" <= "expectedInputCount"
    ),
    CONSTRAINT "IndexGeneration_lifecycle_check" CHECK (
        ("status" = 'staging' AND "buildStartedAt" IS NULL
            AND "completedAt" IS NULL AND "publishedAt" IS NULL
            AND "supersededAt" IS NULL AND "failureCode" IS NULL)
        OR ("status" = 'building' AND "buildStartedAt" IS NOT NULL
            AND "completedAt" IS NULL AND "publishedAt" IS NULL
            AND "supersededAt" IS NULL AND "failureCode" IS NULL)
        OR ("status" IN ('rag_ready', 'rag_ready_empty')
            AND "buildStartedAt" IS NOT NULL AND "completedAt" IS NOT NULL
            AND "supersededAt" IS NULL AND "failureCode" IS NULL)
        OR ("status" = 'semantic_disabled_by_policy'
            AND "completedAt" IS NOT NULL AND "publishedAt" IS NULL
            AND "supersededAt" IS NULL AND "failureCode" IS NULL)
        OR ("status" IN ('failed', 'ineligible')
            AND "completedAt" IS NOT NULL AND "publishedAt" IS NULL
            AND "supersededAt" IS NULL
            AND "failureCode" ~ '^[A-Z][A-Z0-9_]{0,63}$')
        OR ("status" IN ('unknown', 'cancelled')
            AND "buildStartedAt" IS NOT NULL AND "completedAt" IS NOT NULL
            AND "publishedAt" IS NULL AND "supersededAt" IS NULL
            AND "failureCode" ~ '^[A-Z][A-Z0-9_]{0,63}$')
        OR ("status" = 'superseded' AND "completedAt" IS NOT NULL
            AND "supersededAt" IS NOT NULL AND "failureCode" IS NULL)
    )
);

CREATE UNIQUE INDEX "IndexGeneration_projectId_id_key"
ON "IndexGeneration"("projectId", "id");
CREATE UNIQUE INDEX "IndexGeneration_projectId_id_embeddingProfileId_key"
ON "IndexGeneration"("projectId", "id", "embeddingProfileId");
CREATE UNIQUE INDEX "IndexGeneration_projectId_id_grantId_policyRevisionId_key"
ON "IndexGeneration"("projectId", "id", "grantId", "policyRevisionId");
CREATE UNIQUE INDEX "IndexGeneration_projectId_generationKey_key"
ON "IndexGeneration"("projectId", "generationKey");
CREATE INDEX "IndexGeneration_projectId_status_createdAt_idx"
ON "IndexGeneration"("projectId", "status", "createdAt");
CREATE INDEX "IndexGeneration_projectId_kind_createdAt_idx"
ON "IndexGeneration"("projectId", "kind", "createdAt");

CREATE TABLE "ProjectCorpusIndexGeneration" (
    "projectId" UUID NOT NULL,
    "indexGenerationId" UUID NOT NULL,
    "corpusGenerationId" UUID NOT NULL,
    "grantId" UUID NOT NULL,
    "policyRevisionId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectCorpusIndexGeneration_pkey"
        PRIMARY KEY ("projectId", "indexGenerationId")
);

CREATE UNIQUE INDEX "ProjectCorpusIndexGeneration_index_grant_policy_key"
ON "ProjectCorpusIndexGeneration"(
    "projectId", "indexGenerationId", "grantId", "policyRevisionId"
);
CREATE UNIQUE INDEX "ProjectCorpusIndexGeneration_index_corpus_key"
ON "ProjectCorpusIndexGeneration"(
    "projectId", "indexGenerationId", "corpusGenerationId"
);
CREATE INDEX "ProjectCorpusIndexGeneration_project_corpus_idx"
ON "ProjectCorpusIndexGeneration"("projectId", "corpusGenerationId");

CREATE TABLE "IndexGenerationInputEntry" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "indexGenerationId" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "entryKind" "IndexInputEntryKind" NOT NULL,
    "sourceChunkId" UUID NOT NULL,
    "contentHash" VARCHAR(64) NOT NULL,
    "contentBytes" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IndexGenerationInputEntry_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "IndexGenerationInputEntry_content_check" CHECK (
        "ordinal" >= 0
        AND "contentHash" ~ '^[0-9a-f]{64}$'
        AND "contentBytes" > 0
    )
);

CREATE UNIQUE INDEX "IndexGenerationInputEntry_project_index_id_key"
ON "IndexGenerationInputEntry"("projectId", "indexGenerationId", "id");
CREATE UNIQUE INDEX "IndexGenerationInputEntry_project_index_id_chunk_key"
ON "IndexGenerationInputEntry"(
    "projectId", "indexGenerationId", "id", "sourceChunkId"
);
CREATE UNIQUE INDEX "IndexGenerationInputEntry_project_index_ordinal_key"
ON "IndexGenerationInputEntry"("projectId", "indexGenerationId", "ordinal");
CREATE UNIQUE INDEX "IndexGenerationInputEntry_project_index_chunk_key"
ON "IndexGenerationInputEntry"("projectId", "indexGenerationId", "sourceChunkId");
CREATE INDEX "IndexGenerationInputEntry_project_chunk_idx"
ON "IndexGenerationInputEntry"("projectId", "sourceChunkId");

CREATE TABLE "ProjectCorpusIndexInput" (
    "projectId" UUID NOT NULL,
    "indexGenerationId" UUID NOT NULL,
    "inputEntryId" UUID NOT NULL,
    "corpusGenerationId" UUID NOT NULL,
    "corpusEntryId" UUID NOT NULL,
    "sourceChunkId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectCorpusIndexInput_pkey"
        PRIMARY KEY ("projectId", "indexGenerationId", "inputEntryId")
);

CREATE UNIQUE INDEX "ProjectCorpusIndexInput_exact_input_key"
ON "ProjectCorpusIndexInput"(
    "projectId", "indexGenerationId", "inputEntryId", "sourceChunkId"
);
CREATE UNIQUE INDEX "ProjectCorpusIndexInput_corpus_entry_key"
ON "ProjectCorpusIndexInput"(
    "projectId", "indexGenerationId", "corpusEntryId"
);
CREATE INDEX "ProjectCorpusIndexInput_corpus_entry_idx"
ON "ProjectCorpusIndexInput"(
    "projectId", "corpusGenerationId", "corpusEntryId"
);

CREATE TABLE "IndexBuildAttempt" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "indexGenerationId" UUID NOT NULL,
    "grantId" UUID NOT NULL,
    "policyRevisionId" UUID NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "operationKey" VARCHAR(64) NOT NULL,
    "status" "IndexBuildAttemptStatus" NOT NULL DEFAULT 'queued',
    "expectedInputCount" INTEGER NOT NULL,
    "requestCount" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "safeErrorCode" VARCHAR(64),
    "providerRequestId" VARCHAR(512),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "IndexBuildAttempt_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "IndexBuildAttempt_value_check" CHECK (
        "attemptNumber" > 0
        AND "operationKey" ~ '^[0-9a-f]{64}$'
        AND "expectedInputCount" > 0
        AND "requestCount" >= 0
        AND "inputTokens" >= 0
    ),
    CONSTRAINT "IndexBuildAttempt_lifecycle_check" CHECK (
        ("status" = 'queued' AND "startedAt" IS NULL
            AND "sentAt" IS NULL AND "completedAt" IS NULL
            AND "safeErrorCode" IS NULL AND "providerRequestId" IS NULL)
        OR ("status" = 'running' AND "startedAt" IS NOT NULL
            AND "completedAt" IS NULL AND "safeErrorCode" IS NULL)
        OR ("status" = 'succeeded' AND "startedAt" IS NOT NULL
            AND "sentAt" IS NOT NULL AND "completedAt" IS NOT NULL
            AND "safeErrorCode" IS NULL)
        OR ("status" IN ('failed', 'unknown', 'cancelled')
            AND "startedAt" IS NOT NULL AND "completedAt" IS NOT NULL
            AND "safeErrorCode" ~ '^[A-Z][A-Z0-9_]{0,63}$')
    )
);

CREATE UNIQUE INDEX "IndexBuildAttempt_projectId_id_key"
ON "IndexBuildAttempt"("projectId", "id");
CREATE UNIQUE INDEX "IndexBuildAttempt_project_index_id_key"
ON "IndexBuildAttempt"("projectId", "indexGenerationId", "id");
CREATE UNIQUE INDEX "IndexBuildAttempt_project_index_attempt_key"
ON "IndexBuildAttempt"("projectId", "indexGenerationId", "attemptNumber");
CREATE UNIQUE INDEX "IndexBuildAttempt_project_operation_key"
ON "IndexBuildAttempt"("projectId", "operationKey");
CREATE UNIQUE INDEX "IndexBuildAttempt_active_generation_key"
ON "IndexBuildAttempt"("projectId", "indexGenerationId")
WHERE "status" IN ('queued', 'running', 'unknown');
CREATE INDEX "IndexBuildAttempt_project_index_status_idx"
ON "IndexBuildAttempt"("projectId", "indexGenerationId", "status");

CREATE TABLE "IndexWorkItem" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "indexGenerationId" UUID NOT NULL,
    "inputEntryId" UUID NOT NULL,
    "sourceChunkId" UUID NOT NULL,
    "attemptId" UUID,
    "operationKey" VARCHAR(64) NOT NULL,
    "processingBoundaryFingerprint" VARCHAR(64) NOT NULL,
    "status" "IndexWorkItemStatus" NOT NULL DEFAULT 'queued',
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "safeErrorCode" VARCHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "IndexWorkItem_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "IndexWorkItem_value_check" CHECK (
        "operationKey" ~ '^[0-9a-f]{64}$'
        AND "processingBoundaryFingerprint" ~ '^[0-9a-f]{64}$'
        AND "retryCount" >= 0
    ),
    CONSTRAINT "IndexWorkItem_lifecycle_check" CHECK (
        ("status" = 'queued' AND "attemptId" IS NULL
            AND "claimedAt" IS NULL AND "completedAt" IS NULL
            AND "safeErrorCode" IS NULL)
        OR ("status" = 'running' AND "attemptId" IS NOT NULL
            AND "claimedAt" IS NOT NULL AND "completedAt" IS NULL
            AND "safeErrorCode" IS NULL)
        OR ("status" = 'succeeded' AND "attemptId" IS NOT NULL
            AND "claimedAt" IS NOT NULL AND "completedAt" IS NOT NULL
            AND "safeErrorCode" IS NULL)
        OR ("status" IN ('failed', 'unknown', 'cancelled')
            AND "attemptId" IS NOT NULL AND "claimedAt" IS NOT NULL
            AND "completedAt" IS NOT NULL
            AND "safeErrorCode" ~ '^[A-Z][A-Z0-9_]{0,63}$')
    )
);

CREATE UNIQUE INDEX "IndexWorkItem_project_index_input_key"
ON "IndexWorkItem"("projectId", "indexGenerationId", "inputEntryId");
CREATE UNIQUE INDEX "IndexWorkItem_exact_input_key"
ON "IndexWorkItem"(
    "projectId", "indexGenerationId", "inputEntryId", "sourceChunkId"
);
CREATE UNIQUE INDEX "IndexWorkItem_project_operation_key"
ON "IndexWorkItem"("projectId", "operationKey");
CREATE INDEX "IndexWorkItem_project_index_status_idx"
ON "IndexWorkItem"("projectId", "indexGenerationId", "status");

CREATE TABLE "ChunkEmbedding" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "indexGenerationId" UUID NOT NULL,
    "inputEntryId" UUID NOT NULL,
    "sourceChunkId" UUID NOT NULL,
    "embeddingProfileId" UUID NOT NULL,
    "attemptId" UUID NOT NULL,
    "vector" vector(1536) NOT NULL,
    "vectorFingerprint" VARCHAR(64) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChunkEmbedding_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ChunkEmbedding_fingerprint_check" CHECK (
        "vectorFingerprint" ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT "ChunkEmbedding_vector_check" CHECK (
        vector_dims("vector") = 1536
        AND vector_norm("vector") BETWEEN 0.99 AND 1.01
    )
);

CREATE UNIQUE INDEX "ChunkEmbedding_projectId_id_key"
ON "ChunkEmbedding"("projectId", "id");
CREATE UNIQUE INDEX "ChunkEmbedding_project_index_input_key"
ON "ChunkEmbedding"("projectId", "indexGenerationId", "inputEntryId");
CREATE UNIQUE INDEX "ChunkEmbedding_exact_input_key"
ON "ChunkEmbedding"(
    "projectId", "indexGenerationId", "inputEntryId", "sourceChunkId"
);
CREATE INDEX "ChunkEmbedding_project_chunk_profile_idx"
ON "ChunkEmbedding"("projectId", "sourceChunkId", "embeddingProfileId");

CREATE TABLE "ProjectCorpusIndexPointer" (
    "projectId" UUID NOT NULL,
    "indexGenerationId" UUID NOT NULL,
    "corpusGenerationId" UUID NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectCorpusIndexPointer_pkey" PRIMARY KEY ("projectId")
);

CREATE UNIQUE INDEX "ProjectCorpusIndexPointer_project_index_key"
ON "ProjectCorpusIndexPointer"("projectId", "indexGenerationId");
CREATE UNIQUE INDEX "ProjectCorpusIndexPointer_exact_target_key"
ON "ProjectCorpusIndexPointer"(
    "projectId", "indexGenerationId", "corpusGenerationId"
);

ALTER TABLE "ProjectCorpusGeneration"
ADD CONSTRAINT "ProjectCorpusGeneration_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "Project"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectCorpusGeneration"
ADD CONSTRAINT "ProjectCorpusGeneration_grant_fkey"
FOREIGN KEY ("projectId", "grantId", "policyRevisionId")
REFERENCES "ModelProcessingGrant"("projectId", "id", "policyRevisionId")
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "ProjectCorpusGenerationEntry"
ADD CONSTRAINT "ProjectCorpusGenerationEntry_generation_fkey"
FOREIGN KEY ("projectId", "corpusGenerationId", "grantId")
REFERENCES "ProjectCorpusGeneration"("projectId", "id", "grantId")
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "ProjectCorpusGenerationEntry"
ADD CONSTRAINT "ProjectCorpusGenerationEntry_grant_source_fkey"
FOREIGN KEY ("projectId", "grantSourceId", "grantId", "projectSourceId")
REFERENCES "ModelProcessingGrantSource"("projectId", "id", "grantId", "sourceId")
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "ProjectCorpusGenerationEntry"
ADD CONSTRAINT "ProjectCorpusGenerationEntry_source_revision_fkey"
FOREIGN KEY (
    "projectId", "projectSourceId", "originScope", "sourceRevisionKey",
    "sourceContentHash"
)
REFERENCES "ProjectSource"(
    "projectId", "id", "originScope", "revisionKey", "contentHash"
)
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "ProjectCorpusGenerationEntry"
ADD CONSTRAINT "ProjectCorpusGenerationEntry_source_chunk_fkey"
FOREIGN KEY (
    "projectId", "sourceChunkId", "projectSourceId", "originScope",
    "sourceRevisionKey", "sourceContentHash", "chunkContentHash"
)
REFERENCES "SourceChunk"(
    "projectId", "id", "projectSourceId", "originScope",
    "sourceRevisionKey", "sourceContentHash", "contentHash"
)
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "IndexGeneration"
ADD CONSTRAINT "IndexGeneration_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "Project"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IndexGeneration"
ADD CONSTRAINT "IndexGeneration_grant_fkey"
FOREIGN KEY ("projectId", "grantId", "policyRevisionId")
REFERENCES "ModelProcessingGrant"("projectId", "id", "policyRevisionId")
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "IndexGeneration"
ADD CONSTRAINT "IndexGeneration_embeddingProfileId_fkey"
FOREIGN KEY ("embeddingProfileId") REFERENCES "EmbeddingProfile"("id")
ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "ProjectCorpusIndexGeneration"
ADD CONSTRAINT "ProjectCorpusIndexGeneration_index_fkey"
FOREIGN KEY (
    "projectId", "indexGenerationId", "grantId", "policyRevisionId"
)
REFERENCES "IndexGeneration"(
    "projectId", "id", "grantId", "policyRevisionId"
)
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "ProjectCorpusIndexGeneration"
ADD CONSTRAINT "ProjectCorpusIndexGeneration_corpus_fkey"
FOREIGN KEY (
    "projectId", "corpusGenerationId", "grantId", "policyRevisionId"
)
REFERENCES "ProjectCorpusGeneration"(
    "projectId", "id", "grantId", "policyRevisionId"
)
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "IndexGenerationInputEntry"
ADD CONSTRAINT "IndexGenerationInputEntry_index_fkey"
FOREIGN KEY ("projectId", "indexGenerationId")
REFERENCES "IndexGeneration"("projectId", "id")
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "IndexGenerationInputEntry"
ADD CONSTRAINT "IndexGenerationInputEntry_source_chunk_fkey"
FOREIGN KEY ("projectId", "sourceChunkId")
REFERENCES "SourceChunk"("projectId", "id")
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "ProjectCorpusIndexInput"
ADD CONSTRAINT "ProjectCorpusIndexInput_index_generation_fkey"
FOREIGN KEY ("projectId", "indexGenerationId", "corpusGenerationId")
REFERENCES "ProjectCorpusIndexGeneration"(
    "projectId", "indexGenerationId", "corpusGenerationId"
)
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "ProjectCorpusIndexInput"
ADD CONSTRAINT "ProjectCorpusIndexInput_input_entry_fkey"
FOREIGN KEY (
    "projectId", "indexGenerationId", "inputEntryId", "sourceChunkId"
)
REFERENCES "IndexGenerationInputEntry"(
    "projectId", "indexGenerationId", "id", "sourceChunkId"
)
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "ProjectCorpusIndexInput"
ADD CONSTRAINT "ProjectCorpusIndexInput_corpus_entry_fkey"
FOREIGN KEY (
    "projectId", "corpusGenerationId", "corpusEntryId", "sourceChunkId"
)
REFERENCES "ProjectCorpusGenerationEntry"(
    "projectId", "corpusGenerationId", "id", "sourceChunkId"
)
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "IndexBuildAttempt"
ADD CONSTRAINT "IndexBuildAttempt_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "Project"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IndexBuildAttempt"
ADD CONSTRAINT "IndexBuildAttempt_index_fkey"
FOREIGN KEY (
    "projectId", "indexGenerationId", "grantId", "policyRevisionId"
)
REFERENCES "IndexGeneration"(
    "projectId", "id", "grantId", "policyRevisionId"
)
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "IndexWorkItem"
ADD CONSTRAINT "IndexWorkItem_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "Project"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IndexWorkItem"
ADD CONSTRAINT "IndexWorkItem_index_fkey"
FOREIGN KEY ("projectId", "indexGenerationId")
REFERENCES "IndexGeneration"("projectId", "id")
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "IndexWorkItem"
ADD CONSTRAINT "IndexWorkItem_input_entry_fkey"
FOREIGN KEY (
    "projectId", "indexGenerationId", "inputEntryId", "sourceChunkId"
)
REFERENCES "IndexGenerationInputEntry"(
    "projectId", "indexGenerationId", "id", "sourceChunkId"
)
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "IndexWorkItem"
ADD CONSTRAINT "IndexWorkItem_attempt_fkey"
FOREIGN KEY ("projectId", "indexGenerationId", "attemptId")
REFERENCES "IndexBuildAttempt"("projectId", "indexGenerationId", "id")
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "ChunkEmbedding"
ADD CONSTRAINT "ChunkEmbedding_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "Project"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChunkEmbedding"
ADD CONSTRAINT "ChunkEmbedding_index_profile_fkey"
FOREIGN KEY ("projectId", "indexGenerationId", "embeddingProfileId")
REFERENCES "IndexGeneration"("projectId", "id", "embeddingProfileId")
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "ChunkEmbedding"
ADD CONSTRAINT "ChunkEmbedding_embeddingProfileId_fkey"
FOREIGN KEY ("embeddingProfileId") REFERENCES "EmbeddingProfile"("id")
ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "ChunkEmbedding"
ADD CONSTRAINT "ChunkEmbedding_input_entry_fkey"
FOREIGN KEY (
    "projectId", "indexGenerationId", "inputEntryId", "sourceChunkId"
)
REFERENCES "IndexGenerationInputEntry"(
    "projectId", "indexGenerationId", "id", "sourceChunkId"
)
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "ChunkEmbedding"
ADD CONSTRAINT "ChunkEmbedding_source_chunk_fkey"
FOREIGN KEY ("projectId", "sourceChunkId")
REFERENCES "SourceChunk"("projectId", "id")
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "ChunkEmbedding"
ADD CONSTRAINT "ChunkEmbedding_attempt_fkey"
FOREIGN KEY ("projectId", "indexGenerationId", "attemptId")
REFERENCES "IndexBuildAttempt"("projectId", "indexGenerationId", "id")
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "ProjectCorpusIndexPointer"
ADD CONSTRAINT "ProjectCorpusIndexPointer_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "Project"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectCorpusIndexPointer"
ADD CONSTRAINT "ProjectCorpusIndexPointer_index_fkey"
FOREIGN KEY ("projectId", "indexGenerationId")
REFERENCES "IndexGeneration"("projectId", "id")
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "ProjectCorpusIndexPointer"
ADD CONSTRAINT "ProjectCorpusIndexPointer_project_corpus_fkey"
FOREIGN KEY ("projectId", "indexGenerationId", "corpusGenerationId")
REFERENCES "ProjectCorpusIndexGeneration"(
    "projectId", "indexGenerationId", "corpusGenerationId"
)
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

CREATE OR REPLACE FUNCTION "corpus_generation_lifecycle_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    actual_entry_count BIGINT;
    actual_source_count BIGINT;
    actual_source_manifest TEXT;
    actual_chunk_manifest TEXT;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."status" <> 'staging' THEN
            RAISE EXCEPTION 'new corpus generation must be staging'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;

    IF TG_OP = 'DELETE' THEN
        IF EXISTS (SELECT 1 FROM "Project" WHERE "id" = OLD."projectId") THEN
            RAISE EXCEPTION 'corpus generation is immutable'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN OLD;
    END IF;

    IF ROW(
        NEW."id", NEW."projectId", NEW."grantId", NEW."policyRevisionId",
        NEW."generationKey", NEW."sourceManifestFingerprint",
        NEW."chunkManifestFingerprint", NEW."sourceCount",
        NEW."expectedChunkCount", NEW."chunkerVersion", NEW."createdAt"
    ) IS DISTINCT FROM ROW(
        OLD."id", OLD."projectId", OLD."grantId", OLD."policyRevisionId",
        OLD."generationKey", OLD."sourceManifestFingerprint",
        OLD."chunkManifestFingerprint", OLD."sourceCount",
        OLD."expectedChunkCount", OLD."chunkerVersion", OLD."createdAt"
    ) THEN
        RAISE EXCEPTION 'corpus generation structure is immutable'
            USING ERRCODE = 'check_violation';
    END IF;

    IF OLD."status" = 'complete' AND NEW."status" NOT IN ('complete', 'superseded') THEN
        RAISE EXCEPTION 'complete corpus generation cannot be reopened'
            USING ERRCODE = 'check_violation';
    ELSIF OLD."status" IN ('failed', 'ineligible', 'superseded')
        AND NEW."status" <> OLD."status" THEN
        RAISE EXCEPTION 'terminal corpus generation is immutable'
            USING ERRCODE = 'check_violation';
    ELSIF OLD."status" = 'staging'
        AND NEW."status" NOT IN ('staging', 'complete', 'failed', 'ineligible') THEN
        RAISE EXCEPTION 'invalid corpus generation transition'
            USING ERRCODE = 'check_violation';
    END IF;

    IF NEW."status" = 'complete' AND OLD."status" <> 'complete' THEN
        SELECT COUNT(*), COUNT(DISTINCT e."projectSourceId")
        INTO actual_entry_count, actual_source_count
        FROM "ProjectCorpusGenerationEntry" AS e
        WHERE e."projectId" = NEW."projectId"
          AND e."corpusGenerationId" = NEW."id";

        SELECT encode(sha256(convert_to(string_agg(
            s.source_row, E'\x1e' ORDER BY s.source_row
        ), 'UTF8')), 'hex')
        INTO actual_source_manifest
        FROM (
            SELECT DISTINCT concat_ws(E'\x1f',
                e."projectSourceId"::text,
                e."sourceRevisionKey"::text,
                e."sourceContentHash"
            ) AS source_row
            FROM "ProjectCorpusGenerationEntry" AS e
            WHERE e."projectId" = NEW."projectId"
              AND e."corpusGenerationId" = NEW."id"
        ) AS s;

        SELECT encode(sha256(convert_to(string_agg(concat_ws(E'\x1f',
            e."ordinal"::text, e."sourceChunkId"::text,
            e."chunkContentHash", e."chunkContentBytes"::text
        ), E'\x1e' ORDER BY e."ordinal"), 'UTF8')), 'hex')
        INTO actual_chunk_manifest
        FROM "ProjectCorpusGenerationEntry" AS e
        WHERE e."projectId" = NEW."projectId"
          AND e."corpusGenerationId" = NEW."id";

        IF actual_entry_count <> NEW."expectedChunkCount"
            OR actual_source_count <> NEW."sourceCount"
            OR actual_source_manifest IS DISTINCT FROM NEW."sourceManifestFingerprint"
            OR actual_chunk_manifest IS DISTINCT FROM NEW."chunkManifestFingerprint" THEN
            RAISE EXCEPTION 'corpus generation manifest is incomplete'
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "ProjectCorpusGeneration_lifecycle_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "ProjectCorpusGeneration"
FOR EACH ROW EXECUTE FUNCTION "corpus_generation_lifecycle_guard"();

CREATE OR REPLACE FUNCTION "corpus_generation_entry_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    parent_status "ProjectCorpusGenerationStatus";
    chunk_state "SourceChunkState";
    actual_bytes INTEGER;
BEGIN
    IF TG_OP = 'INSERT' THEN
        SELECT g."status" INTO parent_status
        FROM "ProjectCorpusGeneration" AS g
        WHERE g."projectId" = NEW."projectId" AND g."id" = NEW."corpusGenerationId"
        FOR KEY SHARE;
        SELECT c."state", c."contentBytes" INTO chunk_state, actual_bytes
        FROM "SourceChunk" AS c
        WHERE c."projectId" = NEW."projectId" AND c."id" = NEW."sourceChunkId"
        FOR KEY SHARE;
        IF parent_status IS DISTINCT FROM 'staging'
            OR chunk_state IS DISTINCT FROM 'active'
            OR actual_bytes IS DISTINCT FROM NEW."chunkContentBytes" THEN
            RAISE EXCEPTION 'corpus entry parent or chunk is ineligible'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;
    IF EXISTS (SELECT 1 FROM "Project" WHERE "id" = OLD."projectId") THEN
        RAISE EXCEPTION 'corpus generation entry is immutable'
            USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "ProjectCorpusGenerationEntry_lifecycle_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "ProjectCorpusGenerationEntry"
FOR EACH ROW EXECUTE FUNCTION "corpus_generation_entry_guard"();

CREATE OR REPLACE FUNCTION "project_corpus_index_generation_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    index_kind "IndexGenerationKind";
    corpus_status "ProjectCorpusGenerationStatus";
    expected_inputs INTEGER;
    expected_chunks INTEGER;
BEGIN
    IF TG_OP = 'INSERT' THEN
        SELECT i."kind", i."expectedInputCount"
        INTO index_kind, expected_inputs
        FROM "IndexGeneration" AS i
        WHERE i."projectId" = NEW."projectId" AND i."id" = NEW."indexGenerationId"
        FOR KEY SHARE;
        SELECT c."status", c."expectedChunkCount"
        INTO corpus_status, expected_chunks
        FROM "ProjectCorpusGeneration" AS c
        WHERE c."projectId" = NEW."projectId" AND c."id" = NEW."corpusGenerationId"
        FOR KEY SHARE;
        IF index_kind IS DISTINCT FROM 'project_corpus'
            OR corpus_status IS DISTINCT FROM 'complete'
            OR expected_inputs IS DISTINCT FROM expected_chunks THEN
            RAISE EXCEPTION 'project corpus index parents do not match'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;
    IF EXISTS (SELECT 1 FROM "Project" WHERE "id" = OLD."projectId") THEN
        RAISE EXCEPTION 'project corpus index generation is immutable'
            USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "ProjectCorpusIndexGeneration_lifecycle_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "ProjectCorpusIndexGeneration"
FOR EACH ROW EXECUTE FUNCTION "project_corpus_index_generation_guard"();

CREATE OR REPLACE FUNCTION "index_input_entry_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    parent_status "IndexGenerationStatus";
    chunk_state "SourceChunkState";
    actual_hash TEXT;
    actual_bytes INTEGER;
BEGIN
    IF TG_OP = 'INSERT' THEN
        SELECT i."status" INTO parent_status
        FROM "IndexGeneration" AS i
        WHERE i."projectId" = NEW."projectId" AND i."id" = NEW."indexGenerationId"
        FOR KEY SHARE;
        SELECT c."state", c."contentHash", c."contentBytes"
        INTO chunk_state, actual_hash, actual_bytes
        FROM "SourceChunk" AS c
        WHERE c."projectId" = NEW."projectId" AND c."id" = NEW."sourceChunkId"
        FOR KEY SHARE;
        IF parent_status IS DISTINCT FROM 'staging'
            OR chunk_state IS DISTINCT FROM 'active'
            OR actual_hash IS DISTINCT FROM NEW."contentHash"
            OR actual_bytes IS DISTINCT FROM NEW."contentBytes" THEN
            RAISE EXCEPTION 'index input does not match active chunk'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;
    IF EXISTS (SELECT 1 FROM "Project" WHERE "id" = OLD."projectId") THEN
        RAISE EXCEPTION 'index input entry is immutable'
            USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "IndexGenerationInputEntry_lifecycle_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "IndexGenerationInputEntry"
FOR EACH ROW EXECUTE FUNCTION "index_input_entry_guard"();

CREATE OR REPLACE FUNCTION "project_corpus_index_input_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    input_kind "IndexInputEntryKind";
BEGIN
    IF TG_OP = 'INSERT' THEN
        SELECT e."entryKind" INTO input_kind
        FROM "IndexGenerationInputEntry" AS e
        WHERE e."projectId" = NEW."projectId"
          AND e."indexGenerationId" = NEW."indexGenerationId"
          AND e."id" = NEW."inputEntryId"
        FOR KEY SHARE;
        IF input_kind IS DISTINCT FROM 'project_corpus' THEN
            RAISE EXCEPTION 'project corpus subtype does not match input kind'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;
    IF EXISTS (SELECT 1 FROM "Project" WHERE "id" = OLD."projectId") THEN
        RAISE EXCEPTION 'project corpus index input is immutable'
            USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "ProjectCorpusIndexInput_lifecycle_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "ProjectCorpusIndexInput"
FOR EACH ROW EXECUTE FUNCTION "project_corpus_index_input_guard"();

CREATE OR REPLACE FUNCTION "validate_index_input_subtype"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    subtype_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO subtype_count
    FROM "ProjectCorpusIndexInput" AS p
    WHERE p."projectId" = NEW."projectId"
      AND p."indexGenerationId" = NEW."indexGenerationId"
      AND p."inputEntryId" = NEW."id";
    IF NEW."entryKind" = 'project_corpus' AND subtype_count <> 1 THEN
        RAISE EXCEPTION 'index input requires exactly one concrete subtype'
            USING ERRCODE = 'check_violation';
    ELSIF NEW."entryKind" <> 'project_corpus' AND subtype_count <> 0 THEN
        RAISE EXCEPTION 'index input subtype does not match entry kind'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "IndexGenerationInputEntry_subtype_constraint"
AFTER INSERT OR UPDATE ON "IndexGenerationInputEntry"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "validate_index_input_subtype"();

CREATE OR REPLACE FUNCTION "index_generation_lifecycle_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    actual_inputs BIGINT;
    actual_subtypes BIGINT;
    actual_work_items BIGINT;
    succeeded_work_items BIGINT;
    actual_embeddings BIGINT;
    actual_manifest TEXT;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."status" <> 'staging' THEN
            RAISE EXCEPTION 'new index generation must be staging'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;
    IF TG_OP = 'DELETE' THEN
        IF EXISTS (SELECT 1 FROM "Project" WHERE "id" = OLD."projectId") THEN
            RAISE EXCEPTION 'index generation is immutable'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN OLD;
    END IF;

    IF ROW(
        NEW."id", NEW."projectId", NEW."kind", NEW."grantId",
        NEW."policyRevisionId", NEW."embeddingProfileId", NEW."generationKey",
        NEW."inputManifestFingerprint", NEW."processingBoundaryFingerprint",
        NEW."expectedInputCount", NEW."createdAt"
    ) IS DISTINCT FROM ROW(
        OLD."id", OLD."projectId", OLD."kind", OLD."grantId",
        OLD."policyRevisionId", OLD."embeddingProfileId", OLD."generationKey",
        OLD."inputManifestFingerprint", OLD."processingBoundaryFingerprint",
        OLD."expectedInputCount", OLD."createdAt"
    ) THEN
        RAISE EXCEPTION 'index generation structure is immutable'
            USING ERRCODE = 'check_violation';
    END IF;

    IF OLD."status" IN (
        'rag_ready', 'rag_ready_empty', 'semantic_disabled_by_policy',
        'failed', 'cancelled', 'ineligible', 'superseded'
    ) AND NEW."status" NOT IN (OLD."status", 'superseded') THEN
        RAISE EXCEPTION 'terminal index generation cannot be reopened'
            USING ERRCODE = 'check_violation';
    ELSIF OLD."status" = 'staging'
        AND NEW."status" NOT IN (
            'staging', 'building', 'semantic_disabled_by_policy',
            'failed', 'cancelled', 'ineligible'
        ) THEN
        RAISE EXCEPTION 'invalid staging index transition'
            USING ERRCODE = 'check_violation';
    ELSIF OLD."status" IN ('building', 'unknown')
        AND NEW."status" NOT IN (
            'building', 'rag_ready', 'rag_ready_empty', 'failed',
            'unknown', 'cancelled'
        ) THEN
        RAISE EXCEPTION 'invalid active index transition'
            USING ERRCODE = 'check_violation';
    END IF;

    IF NEW."status" IN ('building', 'rag_ready', 'rag_ready_empty') THEN
        SELECT COUNT(*) INTO actual_inputs
        FROM "IndexGenerationInputEntry" AS e
        WHERE e."projectId" = NEW."projectId"
          AND e."indexGenerationId" = NEW."id";
        SELECT COUNT(*) INTO actual_subtypes
        FROM "ProjectCorpusIndexInput" AS p
        WHERE p."projectId" = NEW."projectId"
          AND p."indexGenerationId" = NEW."id";
        SELECT COUNT(*) INTO actual_work_items
        FROM "IndexWorkItem" AS w
        WHERE w."projectId" = NEW."projectId"
          AND w."indexGenerationId" = NEW."id";
        SELECT encode(sha256(convert_to(string_agg(concat_ws(E'\x1f',
            e."ordinal"::text, e."id"::text, e."sourceChunkId"::text,
            e."contentHash", e."contentBytes"::text
        ), E'\x1e' ORDER BY e."ordinal"), 'UTF8')), 'hex')
        INTO actual_manifest
        FROM "IndexGenerationInputEntry" AS e
        WHERE e."projectId" = NEW."projectId"
          AND e."indexGenerationId" = NEW."id";
        IF actual_inputs <> NEW."expectedInputCount"
            OR actual_subtypes <> NEW."expectedInputCount"
            OR actual_work_items <> NEW."expectedInputCount"
            OR actual_manifest IS DISTINCT FROM NEW."inputManifestFingerprint" THEN
            RAISE EXCEPTION 'index generation input manifest is incomplete'
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    IF NEW."status" IN ('rag_ready', 'rag_ready_empty') THEN
        SELECT COUNT(*) INTO succeeded_work_items
        FROM "IndexWorkItem" AS w
        WHERE w."projectId" = NEW."projectId"
          AND w."indexGenerationId" = NEW."id"
          AND w."status" = 'succeeded';
        SELECT COUNT(*) INTO actual_embeddings
        FROM "ChunkEmbedding" AS e
        WHERE e."projectId" = NEW."projectId"
          AND e."indexGenerationId" = NEW."id";
        IF (NEW."status" = 'rag_ready' AND NEW."expectedInputCount" = 0)
            OR (NEW."status" = 'rag_ready_empty' AND NEW."expectedInputCount" <> 0)
            OR succeeded_work_items <> NEW."expectedInputCount"
            OR actual_embeddings <> NEW."expectedInputCount"
            OR NEW."indexedInputCount" <> NEW."expectedInputCount" THEN
            RAISE EXCEPTION 'index generation is not publishable'
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "IndexGeneration_lifecycle_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "IndexGeneration"
FOR EACH ROW EXECUTE FUNCTION "index_generation_lifecycle_guard"();

CREATE OR REPLACE FUNCTION "index_attempt_lifecycle_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    parent_status "IndexGenerationStatus";
BEGIN
    IF TG_OP = 'INSERT' THEN
        SELECT i."status" INTO parent_status
        FROM "IndexGeneration" AS i
        WHERE i."projectId" = NEW."projectId" AND i."id" = NEW."indexGenerationId"
        FOR UPDATE;
        IF parent_status IS DISTINCT FROM 'building' THEN
            RAISE EXCEPTION 'index attempt requires a building generation'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;
    IF TG_OP = 'DELETE' THEN
        IF EXISTS (SELECT 1 FROM "Project" WHERE "id" = OLD."projectId") THEN
            RAISE EXCEPTION 'index attempt is append-only'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN OLD;
    END IF;
    IF ROW(
        NEW."id", NEW."projectId", NEW."indexGenerationId", NEW."grantId",
        NEW."policyRevisionId", NEW."attemptNumber", NEW."operationKey",
        NEW."expectedInputCount", NEW."createdAt"
    ) IS DISTINCT FROM ROW(
        OLD."id", OLD."projectId", OLD."indexGenerationId", OLD."grantId",
        OLD."policyRevisionId", OLD."attemptNumber", OLD."operationKey",
        OLD."expectedInputCount", OLD."createdAt"
    ) THEN
        RAISE EXCEPTION 'index attempt identity is immutable'
            USING ERRCODE = 'check_violation';
    END IF;
    IF (OLD."status" = 'queued' AND NEW."status" NOT IN ('queued', 'running', 'cancelled'))
        OR (OLD."status" = 'running' AND NEW."status" NOT IN (
            'running', 'succeeded', 'failed', 'unknown', 'cancelled'
        ))
        OR (OLD."status" = 'unknown' AND NEW."status" NOT IN (
            'unknown', 'succeeded', 'failed', 'cancelled'
        ))
        OR (OLD."status" IN ('succeeded', 'failed', 'cancelled')
            AND NEW."status" <> OLD."status") THEN
        RAISE EXCEPTION 'invalid index attempt transition'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "IndexBuildAttempt_lifecycle_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "IndexBuildAttempt"
FOR EACH ROW EXECUTE FUNCTION "index_attempt_lifecycle_guard"();

CREATE OR REPLACE FUNCTION "index_work_item_lifecycle_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    parent_status "IndexGenerationStatus";
    parent_boundary TEXT;
BEGIN
    SELECT i."status", i."processingBoundaryFingerprint"
    INTO parent_status, parent_boundary
    FROM "IndexGeneration" AS i
    WHERE i."projectId" = COALESCE(NEW."projectId", OLD."projectId")
      AND i."id" = COALESCE(NEW."indexGenerationId", OLD."indexGenerationId")
    FOR KEY SHARE;

    IF TG_OP = 'INSERT' THEN
        IF parent_status IS DISTINCT FROM 'staging'
            OR parent_boundary IS DISTINCT FROM NEW."processingBoundaryFingerprint" THEN
            RAISE EXCEPTION 'work item does not match staging generation'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;
    IF TG_OP = 'DELETE' THEN
        IF EXISTS (SELECT 1 FROM "Project" WHERE "id" = OLD."projectId") THEN
            RAISE EXCEPTION 'index work item is immutable'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN OLD;
    END IF;
    IF ROW(
        NEW."id", NEW."projectId", NEW."indexGenerationId", NEW."inputEntryId",
        NEW."sourceChunkId", NEW."operationKey",
        NEW."processingBoundaryFingerprint", NEW."createdAt"
    ) IS DISTINCT FROM ROW(
        OLD."id", OLD."projectId", OLD."indexGenerationId", OLD."inputEntryId",
        OLD."sourceChunkId", OLD."operationKey",
        OLD."processingBoundaryFingerprint", OLD."createdAt"
    ) THEN
        RAISE EXCEPTION 'index work item identity is immutable'
            USING ERRCODE = 'check_violation';
    END IF;
    IF (OLD."status" = 'queued' AND NEW."status" NOT IN ('queued', 'running', 'cancelled'))
        OR (OLD."status" = 'running' AND NEW."status" NOT IN (
            'running', 'succeeded', 'failed', 'unknown', 'cancelled'
        ))
        OR (OLD."status" = 'unknown' AND NEW."status" NOT IN (
            'unknown', 'succeeded', 'failed', 'cancelled'
        ))
        OR (OLD."status" IN ('succeeded', 'failed', 'cancelled')
            AND NEW."status" <> OLD."status") THEN
        RAISE EXCEPTION 'invalid index work item transition'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "IndexWorkItem_lifecycle_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "IndexWorkItem"
FOR EACH ROW EXECUTE FUNCTION "index_work_item_lifecycle_guard"();

CREATE OR REPLACE FUNCTION "validate_index_build_parity"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_project_id UUID;
    target_index_id UUID;
    index_status "IndexGenerationStatus";
    expected_count INTEGER;
    latest_attempt_status "IndexBuildAttemptStatus";
    attempt_count BIGINT;
    work_count BIGINT;
    queued_work BIGINT;
    running_work BIGINT;
    succeeded_work BIGINT;
    failed_work BIGINT;
    unknown_work BIGINT;
    cancelled_work BIGINT;
    embedding_count BIGINT;
BEGIN
    IF TG_TABLE_NAME = 'IndexGeneration' AND TG_OP = 'DELETE' THEN
        target_project_id := OLD."projectId";
        target_index_id := OLD."id";
    ELSIF TG_TABLE_NAME = 'IndexGeneration' THEN
        target_project_id := NEW."projectId";
        target_index_id := NEW."id";
    ELSIF TG_OP = 'DELETE' THEN
        target_project_id := OLD."projectId";
        target_index_id := OLD."indexGenerationId";
    ELSE
        target_project_id := NEW."projectId";
        target_index_id := NEW."indexGenerationId";
    END IF;

    SELECT i."status", i."expectedInputCount"
    INTO index_status, expected_count
    FROM "IndexGeneration" AS i
    WHERE i."projectId" = target_project_id
      AND i."id" = target_index_id;
    IF NOT FOUND THEN
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
    END IF;

    SELECT COUNT(*) INTO attempt_count
    FROM "IndexBuildAttempt" AS a
    WHERE a."projectId" = target_project_id
      AND a."indexGenerationId" = target_index_id;
    SELECT a."status" INTO latest_attempt_status
    FROM "IndexBuildAttempt" AS a
    WHERE a."projectId" = target_project_id
      AND a."indexGenerationId" = target_index_id
    ORDER BY a."attemptNumber" DESC
    LIMIT 1;
    SELECT
        COUNT(*),
        COUNT(*) FILTER (WHERE w."status" = 'queued'),
        COUNT(*) FILTER (WHERE w."status" = 'running'),
        COUNT(*) FILTER (WHERE w."status" = 'succeeded'),
        COUNT(*) FILTER (WHERE w."status" = 'failed'),
        COUNT(*) FILTER (WHERE w."status" = 'unknown'),
        COUNT(*) FILTER (WHERE w."status" = 'cancelled')
    INTO work_count, queued_work, running_work, succeeded_work,
         failed_work, unknown_work, cancelled_work
    FROM "IndexWorkItem" AS w
    WHERE w."projectId" = target_project_id
      AND w."indexGenerationId" = target_index_id;
    SELECT COUNT(*) INTO embedding_count
    FROM "ChunkEmbedding" AS e
    WHERE e."projectId" = target_project_id
      AND e."indexGenerationId" = target_index_id;

    IF index_status = 'staging' THEN
        IF attempt_count <> 0 OR work_count <> 0 OR embedding_count <> 0 THEN
            RAISE EXCEPTION 'staging index has build children'
                USING ERRCODE = 'check_violation';
        END IF;
    ELSIF index_status = 'building' THEN
        IF attempt_count < 1 OR work_count <> expected_count
            OR embedding_count <> 0
            OR NOT (
                (latest_attempt_status = 'queued' AND queued_work = expected_count)
                OR (latest_attempt_status = 'running' AND running_work = expected_count)
            ) THEN
            RAISE EXCEPTION 'building index parity mismatch'
                USING ERRCODE = 'check_violation';
        END IF;
    ELSIF index_status = 'rag_ready' OR index_status = 'rag_ready_empty' THEN
        IF latest_attempt_status IS DISTINCT FROM 'succeeded'
            OR work_count <> expected_count
            OR succeeded_work <> expected_count
            OR embedding_count <> expected_count THEN
            RAISE EXCEPTION 'ready index parity mismatch'
                USING ERRCODE = 'check_violation';
        END IF;
    ELSIF index_status = 'failed' THEN
        IF latest_attempt_status IS DISTINCT FROM 'failed'
            OR work_count <> expected_count
            OR failed_work <> expected_count
            OR embedding_count <> 0 THEN
            RAISE EXCEPTION 'failed index parity mismatch'
                USING ERRCODE = 'check_violation';
        END IF;
    ELSIF index_status = 'unknown' THEN
        IF latest_attempt_status IS DISTINCT FROM 'unknown'
            OR work_count <> expected_count
            OR unknown_work <> expected_count
            OR embedding_count <> 0 THEN
            RAISE EXCEPTION 'unknown index parity mismatch'
                USING ERRCODE = 'check_violation';
        END IF;
    ELSIF index_status = 'cancelled' THEN
        IF latest_attempt_status IS DISTINCT FROM 'cancelled'
            OR work_count <> expected_count
            OR cancelled_work <> expected_count
            OR embedding_count <> 0 THEN
            RAISE EXCEPTION 'cancelled index parity mismatch'
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "IndexGeneration_build_parity_constraint"
AFTER INSERT OR UPDATE OR DELETE ON "IndexGeneration"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "validate_index_build_parity"();

CREATE CONSTRAINT TRIGGER "IndexBuildAttempt_build_parity_constraint"
AFTER INSERT OR UPDATE OR DELETE ON "IndexBuildAttempt"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "validate_index_build_parity"();

CREATE CONSTRAINT TRIGGER "IndexWorkItem_build_parity_constraint"
AFTER INSERT OR UPDATE OR DELETE ON "IndexWorkItem"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "validate_index_build_parity"();

CREATE OR REPLACE FUNCTION "chunk_embedding_immutable_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    attempt_status "IndexBuildAttemptStatus";
    work_status "IndexWorkItemStatus";
BEGIN
    IF TG_OP = 'INSERT' THEN
        SELECT a."status" INTO attempt_status
        FROM "IndexBuildAttempt" AS a
        WHERE a."projectId" = NEW."projectId"
          AND a."indexGenerationId" = NEW."indexGenerationId"
          AND a."id" = NEW."attemptId"
        FOR KEY SHARE;
        SELECT w."status" INTO work_status
        FROM "IndexWorkItem" AS w
        WHERE w."projectId" = NEW."projectId"
          AND w."indexGenerationId" = NEW."indexGenerationId"
          AND w."inputEntryId" = NEW."inputEntryId"
        FOR KEY SHARE;
        IF attempt_status IS DISTINCT FROM 'running'
            OR work_status IS DISTINCT FROM 'running' THEN
            RAISE EXCEPTION 'embedding requires running attempt and work item'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;
    IF EXISTS (SELECT 1 FROM "Project" WHERE "id" = OLD."projectId") THEN
        RAISE EXCEPTION 'chunk embedding is immutable'
            USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "ChunkEmbedding_immutable_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "ChunkEmbedding"
FOR EACH ROW EXECUTE FUNCTION "chunk_embedding_immutable_guard"();

CREATE OR REPLACE FUNCTION "project_corpus_index_pointer_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_status "IndexGenerationStatus";
    expected_count INTEGER;
    indexed_count INTEGER;
    embedding_count BIGINT;
BEGIN
    SELECT i."status", i."expectedInputCount", i."indexedInputCount"
    INTO target_status, expected_count, indexed_count
    FROM "IndexGeneration" AS i
    WHERE i."projectId" = NEW."projectId" AND i."id" = NEW."indexGenerationId"
    FOR UPDATE;
    SELECT COUNT(*) INTO embedding_count
    FROM "ChunkEmbedding" AS e
    WHERE e."projectId" = NEW."projectId"
      AND e."indexGenerationId" = NEW."indexGenerationId";
    IF target_status NOT IN ('rag_ready', 'rag_ready_empty')
        OR indexed_count <> expected_count
        OR embedding_count <> expected_count THEN
        RAISE EXCEPTION 'index generation is not publishable'
            USING ERRCODE = 'check_violation';
    END IF;
    UPDATE "IndexGeneration"
    SET "publishedAt" = COALESCE("publishedAt", NEW."publishedAt")
    WHERE "projectId" = NEW."projectId" AND "id" = NEW."indexGenerationId";
    RETURN NEW;
END;
$$;

CREATE TRIGGER "ProjectCorpusIndexPointer_publish_trigger"
BEFORE INSERT OR UPDATE ON "ProjectCorpusIndexPointer"
FOR EACH ROW EXECUTE FUNCTION "project_corpus_index_pointer_guard"();
