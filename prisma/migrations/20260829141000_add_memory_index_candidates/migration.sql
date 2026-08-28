-- Candidate generations are additive. Legacy generations have a NULL jobId
-- and remain readable/publishable; all new candidates carry a job and the
-- immutable fingerprints needed for incremental reuse.
ALTER TABLE "MemoryIndexGeneration"
    ADD COLUMN "jobId" UUID,
    ADD COLUMN "buildMode" "MemoryIndexBuildMode" NOT NULL DEFAULT 'full',
    ADD COLUMN "expectedEmbeddingRouteUpdatedAt" TIMESTAMP(3),
    ADD COLUMN "expectedInputCount" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "generatedRecordCount" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "reusedRecordCount" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "deadlineAt" TIMESTAMP(3),
    ADD COLUMN "failureCode" VARCHAR(64),
    ADD COLUMN "reconciliationRequired" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "MemoryRecord"
    ADD COLUMN "inputFingerprint" CHAR(64),
    ADD COLUMN "embeddingFingerprint" CHAR(64),
    ADD COLUMN "reusedFromMemoryRecordId" UUID;

CREATE TABLE "MemoryIndexReconciliation" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "indexGenerationId" UUID NOT NULL,
    "requestedById" UUID NOT NULL,
    "resolution" "MemoryIndexReconciliationResolution" NOT NULL,
    "evidenceFingerprint" CHAR(64) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemoryIndexReconciliation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MemoryIndexGeneration_projectId_jobId_key"
ON "MemoryIndexGeneration"("projectId", "jobId");
CREATE INDEX "MemoryIndexGeneration_projectId_jobId_idx"
ON "MemoryIndexGeneration"("projectId", "jobId");
CREATE UNIQUE INDEX "MemoryIndexGeneration_active_candidate_key"
ON "MemoryIndexGeneration"("projectId")
WHERE "jobId" IS NOT NULL
  AND ("status" IN ('staging', 'building')
       OR ("status" = 'unknown' AND "reconciliationRequired" = true));

CREATE UNIQUE INDEX "MemoryRecord_project_id_key"
ON "MemoryRecord"("projectId", "id");
CREATE INDEX "MemoryRecord_project_generation_input_fingerprint_idx"
ON "MemoryRecord"("projectId", "indexGenerationId", "inputFingerprint");
CREATE INDEX "MemoryRecord_project_embedding_fingerprint_idx"
ON "MemoryRecord"("projectId", "embeddingFingerprint");

CREATE UNIQUE INDEX "MemoryIndexReconciliation_project_id_key"
ON "MemoryIndexReconciliation"("projectId", "id");
CREATE UNIQUE INDEX "MemoryIndexReconciliation_project_generation_key"
ON "MemoryIndexReconciliation"("projectId", "indexGenerationId");
CREATE INDEX "MemoryIndexReconciliation_project_createdAt_idx"
ON "MemoryIndexReconciliation"("projectId", "createdAt");

ALTER TABLE "MemoryIndexGeneration"
ADD CONSTRAINT "MemoryIndexGeneration_job_fkey"
FOREIGN KEY ("projectId", "jobId") REFERENCES "BackgroundJob"("projectId", "id")
ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "MemoryRecord"
ADD CONSTRAINT "MemoryRecord_reused_from_fkey"
FOREIGN KEY ("projectId", "reusedFromMemoryRecordId") REFERENCES "MemoryRecord"("projectId", "id")
ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "MemoryIndexReconciliation"
ADD CONSTRAINT "MemoryIndexReconciliation_project_fkey"
FOREIGN KEY ("projectId") REFERENCES "Project"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MemoryIndexReconciliation"
ADD CONSTRAINT "MemoryIndexReconciliation_generation_fkey"
FOREIGN KEY ("projectId", "indexGenerationId") REFERENCES "MemoryIndexGeneration"("projectId", "id")
ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MemoryIndexReconciliation"
ADD CONSTRAINT "MemoryIndexReconciliation_requestedBy_fkey"
FOREIGN KEY ("requestedById") REFERENCES "AppUser"("id")
ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "MemoryIndexGeneration"
ADD CONSTRAINT "MemoryIndexGeneration_candidate_values_check"
CHECK (
    "expectedInputCount" >= 0
    AND "generatedRecordCount" >= 0
    AND "reusedRecordCount" >= 0
    AND "recordCount" >= 0
    AND "inputManifestFingerprint" ~ '^[0-9a-f]{64}$'
    AND ("failureCode" IS NULL OR "failureCode" ~ '^[A-Z0-9_]{3,64}$')
);

ALTER TABLE "MemoryRecord"
ADD CONSTRAINT "MemoryRecord_fingerprint_values_check"
CHECK (
    ("inputFingerprint" IS NULL OR "inputFingerprint" ~ '^[0-9a-f]{64}$')
    AND ("embeddingFingerprint" IS NULL OR "embeddingFingerprint" ~ '^[0-9a-f]{64}$')
    AND ("reusedFromMemoryRecordId" IS NULL OR "reusedFromMemoryRecordId" <> "id")
);

ALTER TABLE "MemoryIndexReconciliation"
ADD CONSTRAINT "MemoryIndexReconciliation_values_check"
CHECK ("evidenceFingerprint" ~ '^[0-9a-f]{64}$');

CREATE OR REPLACE FUNCTION "memory_index_generation_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    job_kind "BackgroundJobKind";
BEGIN
    IF TG_OP = 'DELETE' THEN
        -- Project deletion cascades through this table. A direct delete while
        -- the project still exists would bypass the candidate audit trail.
        IF pg_trigger_depth() <= 1
           AND OLD."jobId" IS NOT NULL
           AND EXISTS (SELECT 1 FROM "Project" WHERE "id" = OLD."projectId") THEN
            RAISE EXCEPTION 'memory index generation is immutable'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN OLD;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        IF OLD."projectId" <> NEW."projectId" OR OLD."id" <> NEW."id" THEN
            RAISE EXCEPTION 'memory index generation identity is immutable'
                USING ERRCODE = 'check_violation';
        END IF;

        IF OLD."status" = 'complete'
           AND NEW."status" = 'superseded'
           AND EXISTS (
               SELECT 1 FROM "MemoryIndexPointer"
               WHERE "projectId" = OLD."projectId"
                 AND "indexGenerationId" = OLD."id"
           ) THEN
            RAISE EXCEPTION 'active memory index generation cannot be superseded'
                USING ERRCODE = 'check_violation';
        END IF;

        IF OLD."jobId" IS NOT NULL AND OLD."status" IN ('complete', 'failed', 'unknown', 'superseded') THEN
            IF OLD."status" = 'complete'
               AND NEW."status" = 'superseded'
               AND NEW."projectId" = OLD."projectId"
               AND NEW."id" = OLD."id"
               AND NEW."jobId" IS NOT DISTINCT FROM OLD."jobId"
               AND NEW."providerConnectionId" = OLD."providerConnectionId"
               AND NEW."modelId" = OLD."modelId"
               AND NEW."dimensions" = OLD."dimensions"
               AND NEW."buildMode" = OLD."buildMode"
               AND NEW."inputManifestFingerprint" = OLD."inputManifestFingerprint"
               AND NEW."expectedActiveIndexGenerationId" IS NOT DISTINCT FROM OLD."expectedActiveIndexGenerationId"
               AND NEW."expectedEmbeddingRouteUpdatedAt" IS NOT DISTINCT FROM OLD."expectedEmbeddingRouteUpdatedAt"
               AND NEW."expectedInputCount" = OLD."expectedInputCount"
               AND NEW."generatedRecordCount" = OLD."generatedRecordCount"
               AND NEW."reusedRecordCount" = OLD."reusedRecordCount"
               AND NEW."deadlineAt" IS NOT DISTINCT FROM OLD."deadlineAt"
               AND NEW."recordCount" = OLD."recordCount"
               AND NEW."failureCode" IS NULL
               AND NEW."reconciliationRequired" = false
               AND NEW."createdAt" = OLD."createdAt"
               AND NEW."completedAt" = OLD."completedAt"
               AND NEW."supersededAt" IS NOT NULL
               AND NOT EXISTS (
                   SELECT 1 FROM "MemoryIndexPointer"
                   WHERE "projectId" = OLD."projectId"
                     AND "indexGenerationId" = OLD."id"
               ) THEN
                RETURN NEW;
            END IF;
            IF OLD."status" = 'unknown'
               AND NEW."status" = 'unknown'
               AND OLD."reconciliationRequired" = true
               AND NEW."reconciliationRequired" = false
               AND NEW."projectId" = OLD."projectId"
               AND NEW."id" = OLD."id"
               AND NEW."jobId" = OLD."jobId"
               AND NEW."providerConnectionId" = OLD."providerConnectionId"
               AND NEW."modelId" = OLD."modelId"
               AND NEW."dimensions" = OLD."dimensions"
               AND NEW."buildMode" = OLD."buildMode"
               AND NEW."inputManifestFingerprint" = OLD."inputManifestFingerprint"
               AND NEW."expectedActiveIndexGenerationId" IS NOT DISTINCT FROM OLD."expectedActiveIndexGenerationId"
               AND NEW."expectedEmbeddingRouteUpdatedAt" IS NOT DISTINCT FROM OLD."expectedEmbeddingRouteUpdatedAt"
               AND NEW."expectedInputCount" = OLD."expectedInputCount"
               AND NEW."generatedRecordCount" = OLD."generatedRecordCount"
               AND NEW."reusedRecordCount" = OLD."reusedRecordCount"
               AND NEW."deadlineAt" IS NOT DISTINCT FROM OLD."deadlineAt"
               AND NEW."recordCount" = OLD."recordCount"
               AND NEW."failureCode" = OLD."failureCode"
               AND NEW."createdAt" = OLD."createdAt"
               AND NEW."completedAt" = OLD."completedAt"
               AND NEW."supersededAt" IS NOT DISTINCT FROM OLD."supersededAt"
               AND EXISTS (
                   SELECT 1 FROM "MemoryIndexReconciliation"
                   WHERE "projectId" = OLD."projectId"
                     AND "indexGenerationId" = OLD."id"
               ) THEN
                RETURN NEW;
            END IF;
            RAISE EXCEPTION 'terminal memory index generation is immutable'
                USING ERRCODE = 'check_violation';
        END IF;

        IF OLD."jobId" IS NOT NULL AND OLD."status" = 'staging'
           AND NEW."status" NOT IN ('staging', 'building', 'failed', 'unknown') THEN
            RAISE EXCEPTION 'invalid staging memory index transition'
                USING ERRCODE = 'check_violation';
        END IF;
        IF OLD."jobId" IS NOT NULL AND OLD."status" = 'building'
           AND NEW."status" NOT IN ('building', 'complete', 'failed', 'unknown') THEN
            RAISE EXCEPTION 'invalid building memory index transition'
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    IF NEW."jobId" IS NOT NULL THEN
        SELECT "kind" INTO job_kind FROM "BackgroundJob"
        WHERE "projectId" = NEW."projectId" AND "id" = NEW."jobId";
        IF job_kind IS DISTINCT FROM 'memory_index' THEN
            RAISE EXCEPTION 'memory index generation must reference a memory_index job'
                USING ERRCODE = 'check_violation';
        END IF;
        IF NEW."status" IN ('staging', 'building')
           AND (NEW."completedAt" IS NOT NULL OR NEW."supersededAt" IS NOT NULL
                OR NEW."failureCode" IS NOT NULL OR NEW."reconciliationRequired") THEN
            RAISE EXCEPTION 'active memory index candidate has terminal fields'
                USING ERRCODE = 'check_violation';
        END IF;
        IF NEW."status" = 'complete'
           AND (NEW."completedAt" IS NULL OR NEW."supersededAt" IS NOT NULL
                OR NEW."failureCode" IS NOT NULL OR NEW."reconciliationRequired") THEN
            RAISE EXCEPTION 'complete memory index candidate has invalid lifecycle fields'
                USING ERRCODE = 'check_violation';
        END IF;
        IF NEW."status" = 'failed'
           AND (NEW."completedAt" IS NULL OR NEW."failureCode" IS NULL OR NEW."reconciliationRequired") THEN
            RAISE EXCEPTION 'failed memory index candidate has invalid lifecycle fields'
                USING ERRCODE = 'check_violation';
        END IF;
        IF NEW."status" = 'unknown'
           AND (NEW."completedAt" IS NULL OR NEW."failureCode" IS NULL OR NOT NEW."reconciliationRequired") THEN
            RAISE EXCEPTION 'unknown memory index candidate has invalid lifecycle fields'
                USING ERRCODE = 'check_violation';
        END IF;
        IF NEW."status" = 'superseded' AND NEW."supersededAt" IS NULL THEN
            RAISE EXCEPTION 'superseded memory index candidate needs supersededAt'
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "MemoryIndexGeneration_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "MemoryIndexGeneration"
FOR EACH ROW EXECUTE FUNCTION "memory_index_generation_guard"();

CREATE OR REPLACE FUNCTION "memory_record_candidate_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    candidate_job UUID;
    candidate_status "MemoryIndexStatus";
    candidate_dimensions INTEGER;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        IF pg_trigger_depth() <= 1
           AND EXISTS (SELECT 1 FROM "Project" WHERE "id" = OLD."projectId")
           AND EXISTS (
               SELECT 1 FROM "MemoryIndexGeneration"
               WHERE "projectId" = OLD."projectId" AND "id" = OLD."indexGenerationId" AND "jobId" IS NOT NULL
           ) THEN
            RAISE EXCEPTION 'candidate memory records are append-only'
                USING ERRCODE = 'check_violation';
        END IF;
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
    END IF;

    SELECT "jobId", "status", "dimensions"
    INTO candidate_job, candidate_status, candidate_dimensions
    FROM "MemoryIndexGeneration"
    WHERE "projectId" = NEW."projectId" AND "id" = NEW."indexGenerationId";
    IF candidate_job IS NOT NULL THEN
        IF candidate_status NOT IN ('staging', 'building') THEN
            RAISE EXCEPTION 'candidate records require an active generation'
                USING ERRCODE = 'check_violation';
        END IF;
        IF NEW."inputFingerprint" IS NULL OR NEW."embeddingFingerprint" IS NULL THEN
            RAISE EXCEPTION 'candidate records require fingerprints'
                USING ERRCODE = 'check_violation';
        END IF;
        IF NEW."embedding" IS NULL OR COALESCE(array_length(NEW."embedding", 1), 0) <> candidate_dimensions THEN
            RAISE EXCEPTION 'candidate record has invalid embedding dimensions'
                USING ERRCODE = 'check_violation';
        END IF;
        IF EXISTS (SELECT 1 FROM unnest(NEW."embedding") AS value WHERE value IS NULL OR value::text IN ('NaN', 'Infinity', '-Infinity')) THEN
            RAISE EXCEPTION 'candidate record has non-finite embedding values'
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "MemoryRecord_candidate_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "MemoryRecord"
FOR EACH ROW EXECUTE FUNCTION "memory_record_candidate_guard"();

CREATE OR REPLACE FUNCTION "memory_index_pointer_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    generation_job UUID;
    generation_status "MemoryIndexStatus";
    generation_dimensions INTEGER;
    generation_expected INTEGER;
    generation_generated INTEGER;
    generation_reused INTEGER;
    generation_record_count INTEGER;
    actual_count INTEGER;
    distinct_count INTEGER;
BEGIN
    SELECT "jobId", "status", "dimensions", "expectedInputCount", "generatedRecordCount",
           "reusedRecordCount", "recordCount"
    INTO generation_job, generation_status, generation_dimensions,
         generation_expected, generation_generated, generation_reused,
         generation_record_count
    FROM "MemoryIndexGeneration"
    WHERE "projectId" = NEW."projectId" AND "id" = NEW."indexGenerationId";
    IF generation_status IS DISTINCT FROM 'complete' THEN
        RAISE EXCEPTION 'memory index pointer must target a complete generation'
            USING ERRCODE = 'check_violation';
    END IF;
    IF generation_job IS NOT NULL THEN
        SELECT count(*), count(DISTINCT "inputFingerprint")
        INTO actual_count, distinct_count
        FROM "MemoryRecord"
        WHERE "projectId" = NEW."projectId" AND "indexGenerationId" = NEW."indexGenerationId";
        IF generation_record_count <> generation_expected
           OR generation_generated + generation_reused <> generation_expected
           OR actual_count <> generation_expected
           OR distinct_count <> actual_count THEN
            RAISE EXCEPTION 'memory index pointer record counts are incomplete'
                USING ERRCODE = 'check_violation';
        END IF;
        IF EXISTS (
            SELECT 1 FROM "MemoryRecord"
            WHERE "projectId" = NEW."projectId" AND "indexGenerationId" = NEW."indexGenerationId"
              AND ("inputFingerprint" IS NULL OR "embeddingFingerprint" IS NULL
                   OR "embedding" IS NULL OR COALESCE(array_length("embedding", 1), 0) <> generation_dimensions)
        ) THEN
            RAISE EXCEPTION 'memory index pointer has incomplete candidate records'
                USING ERRCODE = 'check_violation';
        END IF;
        IF EXISTS (
            SELECT 1 FROM "MemoryRecord" record, unnest(record."embedding") AS value
            WHERE record."projectId" = NEW."projectId" AND record."indexGenerationId" = NEW."indexGenerationId"
              AND (value IS NULL OR value::text IN ('NaN', 'Infinity', '-Infinity'))
        ) THEN
            RAISE EXCEPTION 'memory index pointer has non-finite vectors'
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "MemoryIndexPointer_guard"
BEFORE INSERT OR UPDATE ON "MemoryIndexPointer"
FOR EACH ROW EXECUTE FUNCTION "memory_index_pointer_guard"();

CREATE OR REPLACE FUNCTION "memory_index_reconciliation_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP <> 'INSERT' AND pg_trigger_depth() <= 1
       AND EXISTS (SELECT 1 FROM "Project" WHERE "id" = OLD."projectId") THEN
        RAISE EXCEPTION 'memory index reconciliation is immutable'
            USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'INSERT' AND NOT EXISTS (
        SELECT 1 FROM "MemoryIndexGeneration"
        WHERE "projectId" = NEW."projectId" AND "id" = NEW."indexGenerationId"
          AND "status" IN ('unknown', 'complete')
    ) THEN
        RAISE EXCEPTION 'memory index reconciliation requires a known generation'
            USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "MemoryIndexReconciliation_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "MemoryIndexReconciliation"
FOR EACH ROW EXECUTE FUNCTION "memory_index_reconciliation_guard"();
