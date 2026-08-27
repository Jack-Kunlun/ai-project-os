-- The image is pinned to pgvector 0.8.6 on PostgreSQL 18. Extension creation
-- stays in the migration ledger so restored and fresh databases converge.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TYPE "EmbeddingProvider" AS ENUM ('openai');
CREATE TYPE "EmbeddingNormalization" AS ENUM ('unit_length');
CREATE TYPE "SourceChunkState" AS ENUM ('active', 'purged');

CREATE TABLE "EmbeddingProfile" (
    "id" UUID NOT NULL,
    "provider" "EmbeddingProvider" NOT NULL,
    "modelId" VARCHAR(128) NOT NULL,
    "dimensions" INTEGER NOT NULL,
    "normalization" "EmbeddingNormalization" NOT NULL,
    "profileVersion" VARCHAR(128) NOT NULL,
    "profileFingerprint" VARCHAR(64) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmbeddingProfile_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "EmbeddingProfile_dimensions_check" CHECK (
        "dimensions" BETWEEN 1 AND 4096
    ),
    CONSTRAINT "EmbeddingProfile_model_check" CHECK (
        "modelId" ~ '^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$'
        AND "modelId" !~* '(api[-_]?key|bearer|password|secret|token|sk-|latest)'
    ),
    CONSTRAINT "EmbeddingProfile_version_check" CHECK (
        "profileVersion" ~ '^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$'
    ),
    CONSTRAINT "EmbeddingProfile_fingerprint_check" CHECK (
        "profileFingerprint" ~ '^[0-9a-f]{64}$'
    )
);

CREATE UNIQUE INDEX "EmbeddingProfile_profileFingerprint_key"
ON "EmbeddingProfile"("profileFingerprint");

CREATE UNIQUE INDEX "EmbeddingProfile_provider_modelId_dimensions_normalization_profileVersion_key"
ON "EmbeddingProfile"(
    "provider", "modelId", "dimensions", "normalization", "profileVersion"
);

INSERT INTO "EmbeddingProfile" (
    "id", "provider", "modelId", "dimensions", "normalization",
    "profileVersion", "profileFingerprint"
) VALUES (
    '00000000-0000-4000-8000-000000001536',
    'openai',
    'text-embedding-3-small',
    1536,
    'unit_length',
    'openai-embedding-profile:v1',
    'b6ea9b216ae969788bdf629f9cb31be5fd4d4e221fc87d433303bc3c363ee8d6'
);

CREATE OR REPLACE FUNCTION "embedding_profile_immutable_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'embedding profile is immutable'
        USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER "EmbeddingProfile_immutable_trigger"
BEFORE UPDATE OR DELETE ON "EmbeddingProfile"
FOR EACH ROW EXECUTE FUNCTION "embedding_profile_immutable_guard"();

CREATE UNIQUE INDEX "ProjectSource_projectId_id_originScope_revisionKey_contentHash_key"
ON "ProjectSource"(
    "projectId", "id", "originScope", "revisionKey", "contentHash"
);

CREATE TABLE "SourceChunk" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "originScope" "ContentOriginScope" NOT NULL DEFAULT 'project',
    "projectRepositoryLinkId" UUID,
    "projectSourceId" UUID,
    "sourceRevisionKey" UUID,
    "sourceContentHash" VARCHAR(64),
    "ordinal" INTEGER NOT NULL,
    "rangeUnit" "ProjectEvidenceRangeUnit" NOT NULL,
    "rangeStart" INTEGER NOT NULL,
    "rangeEnd" INTEGER NOT NULL,
    "chunkerVersion" VARCHAR(128) NOT NULL,
    "contentText" TEXT,
    "contentHash" VARCHAR(64),
    "contentBytes" INTEGER,
    "state" "SourceChunkState" NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "purgedAt" TIMESTAMP(3),
    "deletionReceipt" UUID,

    CONSTRAINT "SourceChunk_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SourceChunk_origin_check" CHECK (
        "originScope" = 'project'
        AND "projectRepositoryLinkId" IS NULL
        AND "projectSourceId" IS NOT NULL
        AND "sourceRevisionKey" IS NOT NULL
    ),
    CONSTRAINT "SourceChunk_ordinal_check" CHECK ("ordinal" >= 0),
    CONSTRAINT "SourceChunk_chunker_check" CHECK (
        "chunkerVersion" ~ '^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$'
    ),
    CONSTRAINT "SourceChunk_state_check" CHECK (
        (
            "state" = 'active'
            AND "sourceContentHash" ~ '^[0-9a-f]{64}$'
            AND "rangeUnit" = 'utf8_byte'
            AND "rangeStart" >= 0
            AND "rangeEnd" > "rangeStart"
            AND "contentText" IS NOT NULL
            AND octet_length("contentText") > 0
            AND "contentHash" ~ '^[0-9a-f]{64}$'
            AND "contentBytes" = octet_length("contentText")
            AND "rangeEnd" - "rangeStart" = "contentBytes"
            AND "purgedAt" IS NULL
            AND "deletionReceipt" IS NULL
        )
        OR (
            "state" = 'purged'
            AND "sourceContentHash" IS NULL
            AND "contentText" IS NULL
            AND "contentHash" IS NULL
            AND "contentBytes" IS NULL
            AND "purgedAt" IS NOT NULL
            AND "deletionReceipt" IS NOT NULL
        )
    )
);

CREATE UNIQUE INDEX "SourceChunk_projectId_id_key"
ON "SourceChunk"("projectId", "id");

CREATE UNIQUE INDEX "SourceChunk_projectId_id_originScope_key"
ON "SourceChunk"("projectId", "id", "originScope");

CREATE UNIQUE INDEX "SourceChunk_projectId_id_originScope_projectRepositoryLinkId_key"
ON "SourceChunk"("projectId", "id", "originScope", "projectRepositoryLinkId");

CREATE UNIQUE INDEX "SourceChunk_projectId_id_projectSourceId_originScope_key"
ON "SourceChunk"("projectId", "id", "projectSourceId", "originScope");

CREATE INDEX "SourceChunk_projectId_projectSourceId_ordinal_idx"
ON "SourceChunk"("projectId", "projectSourceId", "ordinal");

CREATE INDEX "SourceChunk_projectId_state_createdAt_idx"
ON "SourceChunk"("projectId", "state", "createdAt");

CREATE UNIQUE INDEX "SourceChunk_active_range_key"
ON "SourceChunk"(
    "projectId", "projectSourceId", "sourceRevisionKey", "rangeUnit",
    "rangeStart", "rangeEnd", "chunkerVersion", "contentHash"
)
WHERE "state" = 'active';

CREATE UNIQUE INDEX "SourceChunk_active_ordinal_key"
ON "SourceChunk"(
    "projectId", "projectSourceId", "sourceRevisionKey", "chunkerVersion", "ordinal"
)
WHERE "state" = 'active';

ALTER TABLE "SourceChunk"
ADD CONSTRAINT "SourceChunk_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "Project"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SourceChunk"
ADD CONSTRAINT "SourceChunk_project_source_revision_fkey"
FOREIGN KEY (
    "projectId", "projectSourceId", "originScope", "sourceRevisionKey",
    "sourceContentHash"
)
REFERENCES "ProjectSource"(
    "projectId", "id", "originScope", "revisionKey", "contentHash"
)
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- Project source identity and content revision are sealed together. A later
-- explicit purge migration may replace this guard only for the reviewed
-- tombstone transition.
CREATE OR REPLACE FUNCTION "project_source_identity_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."sourceIdentity" IS NULL THEN
            NEW."sourceIdentity" := gen_random_uuid();
        END IF;
        IF NEW."revisionKey" IS NULL THEN
            NEW."revisionKey" := gen_random_uuid();
        END IF;
        IF NEW."originScope" = 'project' AND NEW."manualContentDedupeKey" IS NULL THEN
            NEW."manualContentDedupeKey" := NEW."contentHash";
        END IF;
        RETURN NEW;
    END IF;

    IF ROW(
        NEW."id", NEW."projectId", NEW."kind", NEW."originScope",
        NEW."projectRepositoryLinkId", NEW."sourceIdentity", NEW."revisionKey",
        NEW."externalRef", NEW."contentText", NEW."contentHash",
        NEW."manualContentDedupeKey", NEW."storageKey", NEW."capturedAt",
        NEW."ingestedAt"
    ) IS DISTINCT FROM ROW(
        OLD."id", OLD."projectId", OLD."kind", OLD."originScope",
        OLD."projectRepositoryLinkId", OLD."sourceIdentity", OLD."revisionKey",
        OLD."externalRef", OLD."contentText", OLD."contentHash",
        OLD."manualContentDedupeKey", OLD."storageKey", OLD."capturedAt",
        OLD."ingestedAt"
    ) THEN
        RAISE EXCEPTION 'project source revision is immutable'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "source_chunk_lifecycle_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    source_content TEXT;
    source_revision UUID;
    source_hash TEXT;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."state" <> 'active'
            OR NEW."originScope" <> 'project'
            OR NEW."rangeUnit" <> 'utf8_byte' THEN
            RAISE EXCEPTION 'new source chunk must be active project evidence'
                USING ERRCODE = 'check_violation';
        END IF;

        SELECT s."contentText", s."revisionKey", s."contentHash"
        INTO source_content, source_revision, source_hash
        FROM "ProjectSource" AS s
        WHERE s."projectId" = NEW."projectId"
          AND s."id" = NEW."projectSourceId"
          AND s."originScope" = NEW."originScope"
        FOR KEY SHARE;

        IF NOT FOUND
            OR NEW."sourceRevisionKey" IS DISTINCT FROM source_revision
            OR NEW."sourceContentHash" IS DISTINCT FROM source_hash
            OR NEW."contentHash" IS DISTINCT FROM
                encode(sha256(convert_to(NEW."contentText", 'UTF8')), 'hex')
            OR substring(
                convert_to(source_content, 'UTF8')
                FROM NEW."rangeStart" + 1
                FOR NEW."rangeEnd" - NEW."rangeStart"
            ) IS DISTINCT FROM convert_to(NEW."contentText", 'UTF8') THEN
            RAISE EXCEPTION 'source chunk does not match source revision bytes'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;

    IF EXISTS (SELECT 1 FROM "Project" WHERE "id" = OLD."projectId") THEN
        RAISE EXCEPTION 'source chunk is immutable'
            USING ERRCODE = 'check_violation';
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "SourceChunk_lifecycle_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "SourceChunk"
FOR EACH ROW EXECUTE FUNCTION "source_chunk_lifecycle_guard"();
