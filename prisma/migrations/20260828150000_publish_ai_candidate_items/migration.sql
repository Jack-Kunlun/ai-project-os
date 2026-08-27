-- AI extraction publishes a visible ProjectItem candidate together with its
-- evidence and ai_created revision. Human review changes that same item; it
-- never creates a hidden claim first or auto-confirms model output.

DROP TRIGGER "AiCandidateClaim_lifecycle_trigger" ON "AiCandidateClaim";
DROP TRIGGER "ProjectItem_ai_candidate_provenance_trigger" ON "ProjectItem";
DROP FUNCTION "ai_candidate_claim_lifecycle_guard"();
DROP FUNCTION "ai_accepted_item_provenance_guard"();

ALTER TABLE "AiCandidateClaim"
    DROP CONSTRAINT "AiCandidateClaim_projectId_acceptedItemId_fkey",
    DROP CONSTRAINT "AiCandidateClaim_review_state_check";
DROP INDEX "AiCandidateClaim_projectId_acceptedItemId_key";

ALTER INDEX "AiCandidateClaim_projectId_batchId_sourceId_statementFingerprin"
RENAME TO "AiCandidateClaim_batch_source_statement_excerpt_key";

ALTER TABLE "AiCandidateClaim"
    RENAME COLUMN "acceptedItemId" TO "projectItemId";
ALTER TABLE "AiCandidateClaim"
    ADD COLUMN "itemType" "ProjectItemType";

-- Claims created before this invariant had no visible item until acceptance.
-- Publish those pending/dismissed claims as conservative Progress candidates
-- while retaining the original model statement and exact evidence.
CREATE TEMP TABLE "_AiCandidateItemBackfill" (
    "claimId" UUID PRIMARY KEY,
    "projectId" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "evidenceId" UUID NOT NULL,
    "createdRevisionId" UUID NOT NULL,
    "reviewRevisionId" UUID
) ON COMMIT DROP;

INSERT INTO "_AiCandidateItemBackfill" (
    "claimId", "projectId", "itemId", "evidenceId",
    "createdRevisionId", "reviewRevisionId"
)
SELECT
    c."id",
    c."projectId",
    gen_random_uuid(),
    gen_random_uuid(),
    gen_random_uuid(),
    CASE WHEN c."reviewStatus" = 'dismissed' THEN gen_random_uuid() END
FROM "AiCandidateClaim" AS c
WHERE c."projectItemId" IS NULL;

INSERT INTO "ProjectItem" (
    "id", "projectId", "type", "reviewStatus", "sourceId", "title",
    "content", "sourceExcerpt", "occurredAt", "confirmedAt",
    "supersedesItemId", "metadata", "createdAt", "updatedAt"
)
SELECT
    m."itemId",
    c."projectId",
    'progress',
    CASE
      WHEN c."reviewStatus" = 'dismissed' THEN 'dismissed'::"ProjectItemReviewStatus"
      ELSE 'candidate'::"ProjectItemReviewStatus"
    END,
    c."sourceId",
    left(c."statement", 160),
    c."statement",
    c."sourceExcerpt",
    NULL,
    NULL,
    NULL,
    jsonb_build_object(
      'origin', 'ai_candidate',
      'aiRunId', c."aiRunId",
      'candidateClaimId', c."id",
      'statementFingerprint', c."statementFingerprint",
      'candidateSetFingerprint', b."candidateSetFingerprint"
    ),
    c."createdAt",
    COALESCE(c."reviewedAt", c."createdAt")
FROM "_AiCandidateItemBackfill" AS m
JOIN "AiCandidateClaim" AS c ON c."id" = m."claimId"
JOIN "AiCandidateBatch" AS b
  ON b."projectId" = c."projectId" AND b."id" = c."batchId";

UPDATE "AiCandidateClaim" AS c
SET "projectItemId" = m."itemId",
    "itemType" = 'progress'
FROM "_AiCandidateItemBackfill" AS m
WHERE c."id" = m."claimId";

UPDATE "AiCandidateClaim" AS c
SET "itemType" = i."type"
FROM "ProjectItem" AS i
WHERE c."projectId" = i."projectId"
  AND c."projectItemId" = i."id"
  AND c."itemType" IS NULL;

INSERT INTO "ProjectItemEvidence" (
    "id", "projectId", "projectItemId", "role", "evidenceState",
    "originScope", "projectRepositoryLinkId", "projectSourceId",
    "sourceExcerpt", "sourceExcerptFingerprint", "rangeUnit",
    "rangeStart", "rangeEnd", "isActive", "createdAt"
)
SELECT
    m."evidenceId",
    c."projectId",
    m."itemId",
    'primary',
    'active',
    'project',
    NULL,
    c."sourceId",
    c."sourceExcerpt",
    encode(sha256(convert_to(c."sourceExcerpt", 'UTF8')), 'hex'),
    'utf8_byte',
    c."sourceStart",
    c."sourceEnd",
    true,
    c."createdAt"
FROM "_AiCandidateItemBackfill" AS m
JOIN "AiCandidateClaim" AS c ON c."id" = m."claimId";

INSERT INTO "ProjectItemRevision" (
    "id", "projectId", "projectItemId", "revisionNumber", "action",
    "actorId", "reason", "itemType", "reviewStatus", "title", "content",
    "sourceId", "sourceExcerpt", "occurredAt", "confirmedAt",
    "supersedesItemId", "metadata", "evidenceManifestFingerprint",
    "integrityState", "deletionReceipt", "createdAt"
)
SELECT
    m."createdRevisionId",
    c."projectId",
    m."itemId",
    1,
    'ai_created',
    'ai:model',
    NULL,
    'progress',
    'candidate',
    left(c."statement", 160),
    c."statement",
    c."sourceId",
    c."sourceExcerpt",
    NULL,
    NULL,
    NULL,
    i."metadata",
    encode(
      sha256(convert_to(
        c."sourceId"::text || ':'
        || encode(sha256(convert_to(c."sourceExcerpt", 'UTF8')), 'hex') || ':'
        || c."sourceStart"::text || ':' || c."sourceEnd"::text,
        'UTF8'
      )),
      'hex'
    ),
    'active',
    NULL,
    c."createdAt"
FROM "_AiCandidateItemBackfill" AS m
JOIN "AiCandidateClaim" AS c ON c."id" = m."claimId"
JOIN "ProjectItem" AS i
  ON i."projectId" = c."projectId" AND i."id" = m."itemId";

INSERT INTO "ProjectItemRevisionEvidence" (
    "id", "projectId", "projectItemId", "revisionId", "evidenceId",
    "role", "createdAt"
)
SELECT
    gen_random_uuid(), c."projectId", m."itemId", m."createdRevisionId",
    m."evidenceId", 'primary', c."createdAt"
FROM "_AiCandidateItemBackfill" AS m
JOIN "AiCandidateClaim" AS c ON c."id" = m."claimId";

INSERT INTO "ProjectItemRevision" (
    "id", "projectId", "projectItemId", "revisionNumber", "action",
    "actorId", "reason", "itemType", "reviewStatus", "title", "content",
    "sourceId", "sourceExcerpt", "occurredAt", "confirmedAt",
    "supersedesItemId", "metadata", "evidenceManifestFingerprint",
    "integrityState", "deletionReceipt", "createdAt"
)
SELECT
    m."reviewRevisionId",
    c."projectId",
    m."itemId",
    2,
    'dismissed',
    c."reviewedBy",
    NULL,
    'progress',
    'dismissed',
    left(c."statement", 160),
    c."statement",
    c."sourceId",
    c."sourceExcerpt",
    NULL,
    NULL,
    NULL,
    i."metadata",
    r."evidenceManifestFingerprint",
    'active',
    NULL,
    c."reviewedAt"
FROM "_AiCandidateItemBackfill" AS m
JOIN "AiCandidateClaim" AS c ON c."id" = m."claimId"
JOIN "ProjectItem" AS i
  ON i."projectId" = c."projectId" AND i."id" = m."itemId"
JOIN "ProjectItemRevision" AS r
  ON r."projectId" = c."projectId"
 AND r."projectItemId" = m."itemId"
 AND r."id" = m."createdRevisionId"
WHERE c."reviewStatus" = 'dismissed';

INSERT INTO "ProjectItemRevisionEvidence" (
    "id", "projectId", "projectItemId", "revisionId", "evidenceId",
    "role", "createdAt"
)
SELECT
    gen_random_uuid(), c."projectId", m."itemId", m."reviewRevisionId",
    m."evidenceId", 'primary', c."reviewedAt"
FROM "_AiCandidateItemBackfill" AS m
JOIN "AiCandidateClaim" AS c ON c."id" = m."claimId"
WHERE c."reviewStatus" = 'dismissed';

-- Accepted candidates that predated the history ledger were imported as one
-- confirmed legacy revision. Recover the model-created candidate revision and
-- retain the imported state as the human confirmation revision.
DROP TRIGGER "ProjectItemRevision_lifecycle_trigger" ON "ProjectItemRevision";

CREATE TEMP TABLE "_AiAcceptedLegacyBackfill" (
    "claimId" UUID PRIMARY KEY,
    "projectId" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "evidenceId" UUID NOT NULL,
    "createdRevisionId" UUID NOT NULL
) ON COMMIT DROP;

INSERT INTO "_AiAcceptedLegacyBackfill" (
    "claimId", "projectId", "itemId", "evidenceId", "createdRevisionId"
)
SELECT c."id", c."projectId", c."projectItemId", e."id", gen_random_uuid()
FROM "AiCandidateClaim" AS c
JOIN "ProjectItemRevision" AS r
  ON r."projectId" = c."projectId"
 AND r."projectItemId" = c."projectItemId"
 AND r."revisionNumber" = 1
 AND r."action" = 'legacy_import'
JOIN "ProjectItemEvidence" AS e
  ON e."projectId" = c."projectId"
 AND e."projectItemId" = c."projectItemId"
 AND e."role" = 'primary'
 AND e."evidenceState" = 'active'
 AND e."isActive" = true
WHERE c."reviewStatus" = 'accepted'
  AND NOT EXISTS (
    SELECT 1 FROM "ProjectItemRevision" AS more
    WHERE more."projectId" = c."projectId"
      AND more."projectItemId" = c."projectItemId"
      AND more."revisionNumber" > 1
  );

UPDATE "ProjectItemRevision" AS r
SET "revisionNumber" = 2,
    "action" = 'confirmed',
    "actorId" = c."reviewedBy",
    "createdAt" = c."reviewedAt"
FROM "_AiAcceptedLegacyBackfill" AS m
JOIN "AiCandidateClaim" AS c ON c."id" = m."claimId"
WHERE r."projectId" = m."projectId"
  AND r."projectItemId" = m."itemId"
  AND r."revisionNumber" = 1;

INSERT INTO "ProjectItemRevision" (
    "id", "projectId", "projectItemId", "revisionNumber", "action",
    "actorId", "reason", "itemType", "reviewStatus", "title", "content",
    "sourceId", "sourceExcerpt", "occurredAt", "confirmedAt",
    "supersedesItemId", "metadata", "evidenceManifestFingerprint",
    "integrityState", "deletionReceipt", "createdAt"
)
SELECT
    m."createdRevisionId", c."projectId", c."projectItemId", 1,
    'ai_created', 'ai:model', NULL, i."type", 'candidate',
    left(c."statement", 160), c."statement", c."sourceId",
    c."sourceExcerpt", NULL, NULL, NULL, i."metadata",
    encode(
      sha256(convert_to(
        c."sourceId"::text || ':' || e."sourceExcerptFingerprint" || ':'
        || e."rangeStart"::text || ':' || e."rangeEnd"::text,
        'UTF8'
      )),
      'hex'
    ),
    'active', NULL, c."createdAt"
FROM "_AiAcceptedLegacyBackfill" AS m
JOIN "AiCandidateClaim" AS c ON c."id" = m."claimId"
JOIN "ProjectItem" AS i
  ON i."projectId" = c."projectId" AND i."id" = c."projectItemId"
JOIN "ProjectItemEvidence" AS e
  ON e."projectId" = c."projectId" AND e."id" = m."evidenceId";

INSERT INTO "ProjectItemRevisionEvidence" (
    "id", "projectId", "projectItemId", "revisionId", "evidenceId",
    "role", "createdAt"
)
SELECT gen_random_uuid(), c."projectId", c."projectItemId",
       m."createdRevisionId", m."evidenceId", 'primary', c."createdAt"
FROM "_AiAcceptedLegacyBackfill" AS m
JOIN "AiCandidateClaim" AS c ON c."id" = m."claimId";

CREATE TRIGGER "ProjectItemRevision_lifecycle_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "ProjectItemRevision"
FOR EACH ROW EXECUTE FUNCTION "project_item_revision_lifecycle_guard"();

-- Drain deferred count/history events before changing the claim table shape.
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;

ALTER TABLE "AiCandidateClaim"
    ALTER COLUMN "itemType" SET NOT NULL,
    ALTER COLUMN "projectItemId" SET NOT NULL,
    ADD CONSTRAINT "AiCandidateClaim_review_state_check" CHECK (
      (
        "reviewStatus" = 'candidate'
        AND "reviewedAt" IS NULL
        AND "reviewedBy" IS NULL
      )
      OR (
        "reviewStatus" IN ('accepted', 'dismissed')
        AND "reviewedAt" IS NOT NULL
        AND "reviewedBy" IS NOT NULL
      )
    );

CREATE UNIQUE INDEX "AiCandidateClaim_projectId_projectItemId_key"
ON "AiCandidateClaim"("projectId", "projectItemId");

ALTER TABLE "AiCandidateClaim"
ADD CONSTRAINT "AiCandidateClaim_projectId_projectItemId_fkey"
FOREIGN KEY ("projectId", "projectItemId")
REFERENCES "ProjectItem"("projectId", "id")
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

CREATE OR REPLACE FUNCTION "ai_candidate_claim_lifecycle_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    source_content TEXT;
    item_source_id UUID;
    item_type "ProjectItemType";
    item_status "ProjectItemReviewStatus";
    item_excerpt TEXT;
    item_content TEXT;
    item_confirmed_at TIMESTAMP(3);
    initial_revision_count BIGINT;
    publication_found BOOLEAN;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."reviewStatus" <> 'candidate'
            OR NEW."reviewedAt" IS NOT NULL
            OR NEW."reviewedBy" IS NOT NULL THEN
            RAISE EXCEPTION 'candidate claim must start unreviewed'
                USING ERRCODE = 'check_violation';
        END IF;

        SELECT s."contentText", i."sourceId", i."type", i."reviewStatus",
               i."sourceExcerpt", i."content", i."confirmedAt"
        INTO source_content, item_source_id, item_type, item_status,
             item_excerpt, item_content, item_confirmed_at
        FROM "ProjectSource" AS s
        JOIN "AiRunInputSource" AS input
          ON input."projectId" = s."projectId"
         AND input."sourceId" = s."id"
         AND input."aiRunId" = NEW."aiRunId"
        JOIN "AiCandidateBatch" AS b
          ON b."projectId" = NEW."projectId"
         AND b."id" = NEW."batchId"
         AND b."aiRunId" = NEW."aiRunId"
        JOIN "ProjectItem" AS i
          ON i."projectId" = NEW."projectId"
         AND i."id" = NEW."projectItemId"
        WHERE s."projectId" = NEW."projectId" AND s."id" = NEW."sourceId"
        FOR KEY SHARE OF s, i;
        publication_found := FOUND;

        SELECT count(*) INTO initial_revision_count
        FROM "ProjectItemRevision" AS r
        WHERE r."projectId" = NEW."projectId"
          AND r."projectItemId" = NEW."projectItemId"
          AND r."revisionNumber" = 1
          AND r."action" = 'ai_created'
          AND r."reviewStatus" = 'candidate';

        IF publication_found IS NOT TRUE
            OR NEW."sourceStart" <> position(
                convert_to(NEW."sourceExcerpt", 'UTF8')
                IN convert_to(source_content, 'UTF8')
            ) - 1
            OR NEW."sourceEnd" <> NEW."sourceStart" + octet_length(NEW."sourceExcerpt")
            OR item_source_id IS DISTINCT FROM NEW."sourceId"
            OR item_type IS DISTINCT FROM NEW."itemType"
            OR item_status IS DISTINCT FROM 'candidate'
            OR item_excerpt IS DISTINCT FROM NEW."sourceExcerpt"
            OR item_content IS DISTINCT FROM NEW."statement"
            OR item_confirmed_at IS NOT NULL
            OR initial_revision_count <> 1 THEN
            RAISE EXCEPTION 'candidate claim publication mismatch'
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
        NEW."itemType", NEW."statement", NEW."statementFingerprint",
        NEW."sourceExcerpt", NEW."sourceExcerptFingerprint", NEW."sourceStart",
        NEW."sourceEnd", NEW."projectItemId", NEW."createdAt"
    ) IS DISTINCT FROM ROW(
        OLD."id", OLD."projectId", OLD."batchId", OLD."aiRunId", OLD."sourceId",
        OLD."itemType", OLD."statement", OLD."statementFingerprint",
        OLD."sourceExcerpt", OLD."sourceExcerptFingerprint", OLD."sourceStart",
        OLD."sourceEnd", OLD."projectItemId", OLD."createdAt"
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

    SELECT i."sourceId", i."reviewStatus", i."sourceExcerpt", i."confirmedAt"
    INTO item_source_id, item_status, item_excerpt, item_confirmed_at
    FROM "ProjectItem" AS i
    WHERE i."projectId" = NEW."projectId" AND i."id" = NEW."projectItemId"
    FOR KEY SHARE;

    IF NOT FOUND
        OR item_source_id IS DISTINCT FROM NEW."sourceId"
        OR item_excerpt IS DISTINCT FROM NEW."sourceExcerpt"
        OR (NEW."reviewStatus" = 'accepted' AND (
          item_status IS DISTINCT FROM 'confirmed' OR item_confirmed_at IS NULL
        ))
        OR (NEW."reviewStatus" = 'dismissed' AND (
          item_status IS DISTINCT FROM 'dismissed' OR item_confirmed_at IS NOT NULL
        )) THEN
        RAISE EXCEPTION 'reviewed candidate item provenance mismatch'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "AiCandidateClaim_lifecycle_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "AiCandidateClaim"
FOR EACH ROW EXECUTE FUNCTION "ai_candidate_claim_lifecycle_guard"();

CREATE OR REPLACE FUNCTION "ai_candidate_item_provenance_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    claim_source_id UUID;
    claim_excerpt TEXT;
    claim_status "AiCandidateReviewStatus";
BEGIN
    SELECT c."sourceId", c."sourceExcerpt", c."reviewStatus"
    INTO claim_source_id, claim_excerpt, claim_status
    FROM "AiCandidateClaim" AS c
    WHERE c."projectId" = OLD."projectId"
      AND c."projectItemId" = OLD."id";

    IF NOT FOUND THEN
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
    END IF;
    IF TG_OP = 'DELETE' THEN
        IF EXISTS (SELECT 1 FROM "Project" WHERE "id" = OLD."projectId") THEN
            RAISE EXCEPTION 'AI candidate item deletion is forbidden'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN OLD;
    END IF;
    IF NEW."id" IS DISTINCT FROM OLD."id"
        OR NEW."projectId" IS DISTINCT FROM OLD."projectId"
        OR NEW."sourceId" IS DISTINCT FROM claim_source_id
        OR NEW."sourceExcerpt" IS DISTINCT FROM claim_excerpt
        OR (claim_status = 'accepted' AND (
          NEW."reviewStatus" IS DISTINCT FROM 'confirmed' OR NEW."confirmedAt" IS NULL
        ))
        OR (claim_status = 'dismissed' AND (
          NEW."reviewStatus" IS DISTINCT FROM 'dismissed' OR NEW."confirmedAt" IS NOT NULL
        )) THEN
        RAISE EXCEPTION 'AI candidate item provenance is sealed'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "ProjectItem_ai_candidate_provenance_trigger"
BEFORE UPDATE OR DELETE ON "ProjectItem"
FOR EACH ROW EXECUTE FUNCTION "ai_candidate_item_provenance_guard"();

CREATE OR REPLACE FUNCTION "assert_ai_candidate_item_consistency"(
    target_project_id UUID,
    target_item_id UUID
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    claim_row "AiCandidateClaim"%ROWTYPE;
    item_row "ProjectItem"%ROWTYPE;
BEGIN
    SELECT * INTO claim_row
    FROM "AiCandidateClaim"
    WHERE "projectId" = target_project_id AND "projectItemId" = target_item_id;
    IF NOT FOUND THEN RETURN; END IF;

    SELECT * INTO item_row
    FROM "ProjectItem"
    WHERE "projectId" = target_project_id AND "id" = target_item_id;

    IF NOT FOUND
        OR item_row."sourceId" IS DISTINCT FROM claim_row."sourceId"
        OR item_row."sourceExcerpt" IS DISTINCT FROM claim_row."sourceExcerpt"
        OR (claim_row."reviewStatus" = 'candidate' AND
            item_row."reviewStatus" IS DISTINCT FROM 'candidate')
        OR (claim_row."reviewStatus" = 'accepted' AND (
            item_row."reviewStatus" IS DISTINCT FROM 'confirmed'
            OR item_row."confirmedAt" IS NULL
        ))
        OR (claim_row."reviewStatus" = 'dismissed' AND (
            item_row."reviewStatus" IS DISTINCT FROM 'dismissed'
            OR item_row."confirmedAt" IS NOT NULL
        )) THEN
        RAISE EXCEPTION 'AI candidate claim and item are inconsistent'
            USING ERRCODE = 'check_violation';
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION "ai_candidate_item_consistency_from_claim"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM "assert_ai_candidate_item_consistency"(
      COALESCE(NEW."projectId", OLD."projectId"),
      COALESCE(NEW."projectItemId", OLD."projectItemId")
    );
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION "ai_candidate_item_consistency_from_item"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM "assert_ai_candidate_item_consistency"(
      COALESCE(NEW."projectId", OLD."projectId"),
      COALESCE(NEW."id", OLD."id")
    );
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "AiCandidateClaim_item_consistency_constraint_trigger"
AFTER INSERT OR UPDATE OR DELETE ON "AiCandidateClaim"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "ai_candidate_item_consistency_from_claim"();

CREATE CONSTRAINT TRIGGER "ProjectItem_ai_candidate_consistency_constraint_trigger"
AFTER INSERT OR UPDATE OR DELETE ON "ProjectItem"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "ai_candidate_item_consistency_from_item"();

DO $$
BEGIN
    IF EXISTS (
      SELECT 1
      FROM "AiCandidateClaim" AS c
      LEFT JOIN "ProjectItem" AS i
        ON i."projectId" = c."projectId" AND i."id" = c."projectItemId"
      LEFT JOIN "ProjectItemRevision" AS r
        ON r."projectId" = c."projectId"
       AND r."projectItemId" = c."projectItemId"
       AND r."revisionNumber" = 1
       AND r."action" = 'ai_created'
      WHERE i."id" IS NULL OR r."id" IS NULL
    ) THEN
      RAISE EXCEPTION 'AI candidate visible item backfill is incomplete'
        USING ERRCODE = 'check_violation';
    END IF;
END;
$$;
