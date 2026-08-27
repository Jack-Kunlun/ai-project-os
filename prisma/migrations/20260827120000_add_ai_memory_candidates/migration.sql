-- CreateEnum
CREATE TYPE "AiCandidateReviewStatus" AS ENUM ('candidate', 'accepted', 'dismissed');

-- CreateTable
CREATE TABLE "AiCandidateBatch" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "aiRunId" UUID NOT NULL,
    "candidateSetFingerprint" VARCHAR(64) NOT NULL,
    "candidateCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiCandidateBatch_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AiCandidateBatch_candidateSetFingerprint_check" CHECK (
        "candidateSetFingerprint" ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT "AiCandidateBatch_candidateCount_check" CHECK (
        "candidateCount" BETWEEN 0 AND 100
    )
);

-- CreateTable
CREATE TABLE "AiCandidateClaim" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "batchId" UUID NOT NULL,
    "aiRunId" UUID NOT NULL,
    "sourceId" UUID NOT NULL,
    "statement" TEXT NOT NULL,
    "statementFingerprint" VARCHAR(64) NOT NULL,
    "sourceExcerpt" TEXT NOT NULL,
    "sourceExcerptFingerprint" VARCHAR(64) NOT NULL,
    "sourceStart" INTEGER NOT NULL,
    "sourceEnd" INTEGER NOT NULL,
    "reviewStatus" "AiCandidateReviewStatus" NOT NULL DEFAULT 'candidate',
    "reviewedAt" TIMESTAMP(3),
    "reviewedBy" VARCHAR(128),
    "acceptedItemId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiCandidateClaim_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AiCandidateClaim_statement_check" CHECK (
        length(btrim("statement")) > 0
        AND char_length("statement") <= 20000
        AND octet_length("statement") <= 80000
        AND "statement" !~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
    ),
    CONSTRAINT "AiCandidateClaim_sourceExcerpt_check" CHECK (
        length(btrim("sourceExcerpt")) > 0
        AND char_length("sourceExcerpt") <= 10000
        AND octet_length("sourceExcerpt") <= 40000
        AND "sourceExcerpt" !~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
    ),
    CONSTRAINT "AiCandidateClaim_fingerprints_check" CHECK (
        "statementFingerprint" ~ '^[0-9a-f]{64}$'
        AND "sourceExcerptFingerprint" ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT "AiCandidateClaim_offsets_check" CHECK (
        "sourceStart" >= 0 AND "sourceEnd" > "sourceStart"
    ),
    CONSTRAINT "AiCandidateClaim_reviewedBy_check" CHECK (
        "reviewedBy" IS NULL
        OR "reviewedBy" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$'
    ),
    CONSTRAINT "AiCandidateClaim_review_state_check" CHECK (
        (
            "reviewStatus" = 'candidate'
            AND "reviewedAt" IS NULL
            AND "reviewedBy" IS NULL
            AND "acceptedItemId" IS NULL
        )
        OR (
            "reviewStatus" = 'accepted'
            AND "reviewedAt" IS NOT NULL
            AND "reviewedBy" IS NOT NULL
            AND "acceptedItemId" IS NOT NULL
        )
        OR (
            "reviewStatus" = 'dismissed'
            AND "reviewedAt" IS NOT NULL
            AND "reviewedBy" IS NOT NULL
            AND "acceptedItemId" IS NULL
        )
    )
);

-- CreateIndex
CREATE UNIQUE INDEX "AiCandidateBatch_projectId_id_key"
ON "AiCandidateBatch"("projectId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "AiCandidateBatch_projectId_id_aiRunId_key"
ON "AiCandidateBatch"("projectId", "id", "aiRunId");

-- CreateIndex
CREATE UNIQUE INDEX "AiCandidateBatch_projectId_aiRunId_key"
ON "AiCandidateBatch"("projectId", "aiRunId");

-- CreateIndex
CREATE INDEX "AiCandidateBatch_projectId_createdAt_idx"
ON "AiCandidateBatch"("projectId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AiCandidateClaim_projectId_id_key"
ON "AiCandidateClaim"("projectId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "AiCandidateClaim_projectId_batchId_sourceId_statementFingerprint_sourceExcerptFingerprint_key"
ON "AiCandidateClaim"(
    "projectId",
    "batchId",
    "sourceId",
    "statementFingerprint",
    "sourceExcerptFingerprint"
);

-- CreateIndex
CREATE UNIQUE INDEX "AiCandidateClaim_projectId_acceptedItemId_key"
ON "AiCandidateClaim"("projectId", "acceptedItemId");

-- CreateIndex
CREATE INDEX "AiCandidateClaim_projectId_reviewStatus_createdAt_idx"
ON "AiCandidateClaim"("projectId", "reviewStatus", "createdAt");

-- CreateIndex
CREATE INDEX "AiCandidateClaim_projectId_sourceId_idx"
ON "AiCandidateClaim"("projectId", "sourceId");

-- AddForeignKey
ALTER TABLE "AiCandidateBatch"
ADD CONSTRAINT "AiCandidateBatch_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "Project"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiCandidateBatch"
ADD CONSTRAINT "AiCandidateBatch_projectId_aiRunId_fkey"
FOREIGN KEY ("projectId", "aiRunId") REFERENCES "AiRun"("projectId", "id")
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "AiCandidateClaim"
ADD CONSTRAINT "AiCandidateClaim_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "Project"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiCandidateClaim"
ADD CONSTRAINT "AiCandidateClaim_projectId_batchId_aiRunId_fkey"
FOREIGN KEY ("projectId", "batchId", "aiRunId")
REFERENCES "AiCandidateBatch"("projectId", "id", "aiRunId")
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "AiCandidateClaim"
ADD CONSTRAINT "AiCandidateClaim_projectId_aiRunId_sourceId_fkey"
FOREIGN KEY ("projectId", "aiRunId", "sourceId")
REFERENCES "AiRunInputSource"("projectId", "aiRunId", "sourceId")
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "AiCandidateClaim"
ADD CONSTRAINT "AiCandidateClaim_projectId_sourceId_fkey"
FOREIGN KEY ("projectId", "sourceId")
REFERENCES "ProjectSource"("projectId", "id")
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "AiCandidateClaim"
ADD CONSTRAINT "AiCandidateClaim_projectId_acceptedItemId_fkey"
FOREIGN KEY ("projectId", "acceptedItemId")
REFERENCES "ProjectItem"("projectId", "id")
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- A candidate batch can only be published for one completed extraction run.
CREATE OR REPLACE FUNCTION "ai_candidate_batch_lifecycle_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    run_status "AiRunStatus";
    run_operation "AiOperation";
BEGIN
    IF TG_OP = 'INSERT' THEN
        SELECT r."status", r."operation"
        INTO run_status, run_operation
        FROM "AiRun" AS r
        WHERE r."projectId" = NEW."projectId" AND r."id" = NEW."aiRunId"
        FOR KEY SHARE;

        IF NOT FOUND
            OR run_status IS DISTINCT FROM 'succeeded'
            OR run_operation IS DISTINCT FROM 'autoExtract' THEN
            RAISE EXCEPTION 'candidate batch requires succeeded extraction run'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;

    IF EXISTS (
        SELECT 1 FROM "Project" WHERE "id" = OLD."projectId"
    ) THEN
        RAISE EXCEPTION 'candidate batch is append-only'
            USING ERRCODE = 'check_violation';
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "AiCandidateBatch_lifecycle_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "AiCandidateBatch"
FOR EACH ROW EXECUTE FUNCTION "ai_candidate_batch_lifecycle_guard"();

-- Candidate evidence is sealed on insert. Human review is the only allowed
-- update, and acceptance must point to one confirmed item with the same exact
-- source excerpt.
CREATE OR REPLACE FUNCTION "ai_candidate_claim_lifecycle_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    source_content TEXT;
    item_source_id UUID;
    item_status "ProjectItemReviewStatus";
    item_excerpt TEXT;
    item_confirmed_at TIMESTAMP(3);
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."reviewStatus" <> 'candidate'
            OR NEW."reviewedAt" IS NOT NULL
            OR NEW."reviewedBy" IS NOT NULL
            OR NEW."acceptedItemId" IS NOT NULL THEN
            RAISE EXCEPTION 'candidate claim must start unreviewed'
                USING ERRCODE = 'check_violation';
        END IF;

        SELECT s."contentText"
        INTO source_content
        FROM "ProjectSource" AS s
        JOIN "AiRunInputSource" AS i
          ON i."projectId" = s."projectId"
         AND i."sourceId" = s."id"
         AND i."aiRunId" = NEW."aiRunId"
        JOIN "AiCandidateBatch" AS b
          ON b."projectId" = NEW."projectId"
         AND b."id" = NEW."batchId"
         AND b."aiRunId" = NEW."aiRunId"
        WHERE s."projectId" = NEW."projectId" AND s."id" = NEW."sourceId"
        FOR KEY SHARE OF s;

        IF NOT FOUND
            OR NEW."sourceStart" <> position(
                convert_to(NEW."sourceExcerpt", 'UTF8')
                IN convert_to(source_content, 'UTF8')
            ) - 1
            OR NEW."sourceEnd" <> NEW."sourceStart" + octet_length(NEW."sourceExcerpt") THEN
            RAISE EXCEPTION 'candidate claim source evidence mismatch'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;

    IF TG_OP = 'DELETE' THEN
        IF EXISTS (
            SELECT 1 FROM "Project" WHERE "id" = OLD."projectId"
        ) THEN
            RAISE EXCEPTION 'candidate claim deletion is forbidden'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN OLD;
    END IF;

    IF ROW(
        NEW."id", NEW."projectId", NEW."batchId", NEW."aiRunId", NEW."sourceId",
        NEW."statement", NEW."statementFingerprint", NEW."sourceExcerpt",
        NEW."sourceExcerptFingerprint", NEW."sourceStart", NEW."sourceEnd", NEW."createdAt"
    ) IS DISTINCT FROM ROW(
        OLD."id", OLD."projectId", OLD."batchId", OLD."aiRunId", OLD."sourceId",
        OLD."statement", OLD."statementFingerprint", OLD."sourceExcerpt",
        OLD."sourceExcerptFingerprint", OLD."sourceStart", OLD."sourceEnd", OLD."createdAt"
    ) THEN
        RAISE EXCEPTION 'candidate claim evidence is sealed'
            USING ERRCODE = 'check_violation';
    END IF;

    IF OLD."reviewStatus" <> 'candidate'
        OR NEW."reviewStatus" NOT IN ('accepted', 'dismissed')
        OR NEW."reviewedAt" IS NULL
        OR NEW."reviewedAt" < OLD."createdAt"
        OR NEW."reviewedBy" IS NULL THEN
        RAISE EXCEPTION 'invalid candidate review transition'
            USING ERRCODE = 'check_violation';
    END IF;

    IF NEW."reviewStatus" = 'accepted' THEN
        SELECT i."sourceId", i."reviewStatus", i."sourceExcerpt", i."confirmedAt"
        INTO item_source_id, item_status, item_excerpt, item_confirmed_at
        FROM "ProjectItem" AS i
        WHERE i."projectId" = NEW."projectId" AND i."id" = NEW."acceptedItemId"
        FOR KEY SHARE;

        IF NOT FOUND
            OR item_source_id IS DISTINCT FROM NEW."sourceId"
            OR item_status IS DISTINCT FROM 'confirmed'
            OR item_excerpt IS DISTINCT FROM NEW."sourceExcerpt"
            OR item_confirmed_at IS NULL THEN
            RAISE EXCEPTION 'accepted candidate item provenance mismatch'
                USING ERRCODE = 'check_violation';
        END IF;
    ELSIF NEW."acceptedItemId" IS NOT NULL THEN
        RAISE EXCEPTION 'dismissed candidate cannot reference an item'
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "AiCandidateClaim_lifecycle_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "AiCandidateClaim"
FOR EACH ROW EXECUTE FUNCTION "ai_candidate_claim_lifecycle_guard"();

-- Once an item is accepted from AI evidence, its source and confirmation
-- provenance cannot be detached. Its user-facing title/content may still be
-- edited without changing the original accepted evidence.
CREATE OR REPLACE FUNCTION "ai_accepted_item_provenance_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    claim_source_id UUID;
    claim_excerpt TEXT;
BEGIN
    SELECT c."sourceId", c."sourceExcerpt"
    INTO claim_source_id, claim_excerpt
    FROM "AiCandidateClaim" AS c
    WHERE c."projectId" = OLD."projectId"
      AND c."acceptedItemId" = OLD."id"
      AND c."reviewStatus" = 'accepted';

    IF NOT FOUND THEN
        IF TG_OP = 'DELETE' THEN
            RETURN OLD;
        END IF;
        RETURN NEW;
    END IF;

    IF TG_OP = 'DELETE' THEN
        IF EXISTS (
            SELECT 1 FROM "Project" WHERE "id" = OLD."projectId"
        ) THEN
            RAISE EXCEPTION 'accepted candidate item deletion is forbidden'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN OLD;
    END IF;

    IF NEW."id" IS DISTINCT FROM OLD."id"
        OR NEW."projectId" IS DISTINCT FROM OLD."projectId"
        OR NEW."sourceId" IS DISTINCT FROM claim_source_id
        OR NEW."sourceExcerpt" IS DISTINCT FROM claim_excerpt
        OR NEW."reviewStatus" IS DISTINCT FROM 'confirmed'
        OR NEW."confirmedAt" IS NULL THEN
        RAISE EXCEPTION 'accepted candidate item provenance is sealed'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "ProjectItem_ai_candidate_provenance_trigger"
BEFORE UPDATE OR DELETE ON "ProjectItem"
FOR EACH ROW EXECUTE FUNCTION "ai_accepted_item_provenance_guard"();

-- Candidate count is checked at commit so a batch and all of its claims can be
-- created atomically in either statement order.
CREATE OR REPLACE FUNCTION "ai_candidate_count_consistency_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_project_id UUID;
    target_batch_id UUID;
    expected_count INTEGER;
    actual_count BIGINT;
BEGIN
    IF TG_TABLE_NAME = 'AiCandidateBatch' THEN
        IF TG_OP = 'DELETE' THEN
            target_project_id := OLD."projectId";
            target_batch_id := OLD."id";
        ELSE
            target_project_id := NEW."projectId";
            target_batch_id := NEW."id";
        END IF;
    ELSE
        IF TG_OP = 'DELETE' THEN
            target_project_id := OLD."projectId";
            target_batch_id := OLD."batchId";
        ELSE
            target_project_id := NEW."projectId";
            target_batch_id := NEW."batchId";
        END IF;
    END IF;

    SELECT b."candidateCount"
    INTO expected_count
    FROM "AiCandidateBatch" AS b
    WHERE b."projectId" = target_project_id AND b."id" = target_batch_id;

    IF NOT FOUND THEN
        IF TG_OP = 'DELETE' THEN
            RETURN OLD;
        END IF;
        RETURN NEW;
    END IF;

    SELECT COUNT(*)
    INTO actual_count
    FROM "AiCandidateClaim" AS c
    WHERE c."projectId" = target_project_id AND c."batchId" = target_batch_id;

    IF actual_count <> expected_count THEN
        RAISE EXCEPTION 'candidate batch count mismatch'
            USING ERRCODE = 'check_violation';
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "AiCandidateBatch_count_consistency_constraint_trigger"
AFTER INSERT OR UPDATE OR DELETE ON "AiCandidateBatch"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "ai_candidate_count_consistency_guard"();

CREATE CONSTRAINT TRIGGER "AiCandidateClaim_count_consistency_constraint_trigger"
AFTER INSERT OR UPDATE OR DELETE ON "AiCandidateClaim"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "ai_candidate_count_consistency_guard"();
