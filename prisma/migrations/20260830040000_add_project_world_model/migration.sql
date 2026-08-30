ALTER TYPE "ProjectItemRevisionAction" ADD VALUE 'superseded';
ALTER TYPE "ProjectItemRevisionAction" ADD VALUE 'supersession_linked';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "ProjectItemRevision"
    WHERE "reviewStatus" = 'superseded' AND "confirmedAt" IS NULL
  ) THEN
    RAISE EXCEPTION 'PROJECT_ITEM_SUPERSEDED_REVISION_CONFIRMATION_REQUIRED';
  END IF;
END;
$$;

ALTER TABLE "ProjectItemRevision"
  DROP CONSTRAINT "ProjectItemRevision_review_state_check";
ALTER TABLE "ProjectItemRevision"
  ADD CONSTRAINT "ProjectItemRevision_review_state_check" CHECK (
    ("reviewStatus" IN ('confirmed', 'superseded') AND "confirmedAt" IS NOT NULL)
    OR ("reviewStatus" NOT IN ('confirmed', 'superseded') AND "confirmedAt" IS NULL)
  );

-- An accepted AI candidate remains provenance-bound after a human explicitly
-- supersedes it. Supersession changes temporal validity, not source lineage.
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
          NEW."reviewStatus" NOT IN ('confirmed', 'superseded') OR NEW."confirmedAt" IS NULL
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
            item_row."reviewStatus" NOT IN ('confirmed', 'superseded')
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

CREATE TYPE "ProjectFactRelationKind" AS ENUM (
  'supports',
  'contradicts',
  'depends_on',
  'blocks',
  'caused_by',
  'resolves',
  'relates_to'
);

CREATE TYPE "ProjectWorldAuditEvent" AS ENUM (
  'relation_created',
  'relation_retired',
  'fact_superseded',
  'state_captured'
);

CREATE TABLE "ProjectFactRelation" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "sourceItemId" UUID NOT NULL,
  "targetItemId" UUID NOT NULL,
  "sourceRevisionId" UUID NOT NULL,
  "targetRevisionId" UUID NOT NULL,
  "kind" "ProjectFactRelationKind" NOT NULL,
  "rationale" TEXT NOT NULL,
  "fingerprint" CHAR(64) NOT NULL,
  "createdById" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "retiredAt" TIMESTAMP(3),
  "retiredById" UUID,
  "retirementReason" TEXT,

  CONSTRAINT "ProjectFactRelation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProjectFactRelation_distinct_items_check" CHECK ("sourceItemId" <> "targetItemId"),
  CONSTRAINT "ProjectFactRelation_rationale_check" CHECK (char_length(btrim("rationale")) BETWEEN 1 AND 2000),
  CONSTRAINT "ProjectFactRelation_fingerprint_check" CHECK ("fingerprint" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "ProjectFactRelation_symmetric_order_check" CHECK (
    "kind" NOT IN ('contradicts', 'relates_to')
    OR "sourceItemId"::text < "targetItemId"::text
  ),
  CONSTRAINT "ProjectFactRelation_retirement_check" CHECK (
    ("retiredAt" IS NULL AND "retiredById" IS NULL AND "retirementReason" IS NULL)
    OR (
      "retiredAt" IS NOT NULL
      AND "retiredById" IS NOT NULL
      AND char_length(btrim("retirementReason")) BETWEEN 1 AND 1000
    )
  )
);

CREATE TABLE "ProjectWorldSnapshot" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "schemaVersion" INTEGER NOT NULL DEFAULT 1,
  "asOf" TIMESTAMP(3) NOT NULL,
  "status" VARCHAR(32) NOT NULL,
  "inputManifestFingerprint" CHAR(64) NOT NULL,
  "snapshotFingerprint" CHAR(64) NOT NULL,
  "payload" JSONB NOT NULL,
  "capturedById" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ProjectWorldSnapshot_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProjectWorldSnapshot_schema_version_check" CHECK ("schemaVersion" = 1),
  CONSTRAINT "ProjectWorldSnapshot_status_check" CHECK ("status" IN ('on_track', 'needs_attention', 'at_risk', 'insufficient_data')),
  CONSTRAINT "ProjectWorldSnapshot_input_fingerprint_check" CHECK ("inputManifestFingerprint" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "ProjectWorldSnapshot_snapshot_fingerprint_check" CHECK ("snapshotFingerprint" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "ProjectWorldSnapshot_payload_check" CHECK (jsonb_typeof("payload") = 'object')
);

CREATE TABLE "ProjectWorldAudit" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "event" "ProjectWorldAuditEvent" NOT NULL,
  "actorId" UUID NOT NULL,
  "relationId" UUID,
  "snapshotId" UUID,
  "sourceItemId" UUID,
  "targetItemId" UUID,
  "details" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ProjectWorldAudit_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProjectWorldAudit_details_check" CHECK (jsonb_typeof("details") = 'object'),
  CONSTRAINT "ProjectWorldAudit_subject_check" CHECK (
    (
      "event" IN ('relation_created', 'relation_retired')
      AND "relationId" IS NOT NULL
      AND "snapshotId" IS NULL
      AND "sourceItemId" IS NOT NULL
      AND "targetItemId" IS NOT NULL
    )
    OR (
      "event" = 'fact_superseded'
      AND "relationId" IS NULL
      AND "snapshotId" IS NULL
      AND "sourceItemId" IS NOT NULL
      AND "targetItemId" IS NOT NULL
    )
    OR (
      "event" = 'state_captured'
      AND "relationId" IS NULL
      AND "snapshotId" IS NOT NULL
      AND "sourceItemId" IS NULL
      AND "targetItemId" IS NULL
    )
  )
);

CREATE UNIQUE INDEX "ProjectFactRelation_projectId_id_key" ON "ProjectFactRelation"("projectId", "id");
CREATE INDEX "ProjectFactRelation_projectId_fingerprint_idx" ON "ProjectFactRelation"("projectId", "fingerprint");
CREATE INDEX "ProjectFactRelation_projectId_sourceItemId_retiredAt_idx" ON "ProjectFactRelation"("projectId", "sourceItemId", "retiredAt");
CREATE INDEX "ProjectFactRelation_projectId_targetItemId_retiredAt_idx" ON "ProjectFactRelation"("projectId", "targetItemId", "retiredAt");
CREATE INDEX "ProjectFactRelation_projectId_sourceItemId_sourceRevisionId_idx" ON "ProjectFactRelation"("projectId", "sourceItemId", "sourceRevisionId");
CREATE INDEX "ProjectFactRelation_projectId_targetItemId_targetRevisionId_idx" ON "ProjectFactRelation"("projectId", "targetItemId", "targetRevisionId");
CREATE INDEX "ProjectFactRelation_createdById_createdAt_idx" ON "ProjectFactRelation"("createdById", "createdAt");
CREATE INDEX "ProjectFactRelation_retiredById_retiredAt_idx" ON "ProjectFactRelation"("retiredById", "retiredAt");
CREATE UNIQUE INDEX "ProjectFactRelation_active_pair_kind_key"
  ON "ProjectFactRelation"("projectId", "sourceItemId", "targetItemId", "kind")
  WHERE "retiredAt" IS NULL;

CREATE UNIQUE INDEX "ProjectWorldSnapshot_projectId_id_key" ON "ProjectWorldSnapshot"("projectId", "id");
CREATE UNIQUE INDEX "ProjectWorldSnapshot_projectId_snapshotFingerprint_key" ON "ProjectWorldSnapshot"("projectId", "snapshotFingerprint");
CREATE INDEX "ProjectWorldSnapshot_projectId_createdAt_idx" ON "ProjectWorldSnapshot"("projectId", "createdAt");
CREATE INDEX "ProjectWorldSnapshot_capturedById_createdAt_idx" ON "ProjectWorldSnapshot"("capturedById", "createdAt");

CREATE UNIQUE INDEX "ProjectWorldAudit_projectId_id_key" ON "ProjectWorldAudit"("projectId", "id");
CREATE INDEX "ProjectWorldAudit_projectId_createdAt_idx" ON "ProjectWorldAudit"("projectId", "createdAt");
CREATE INDEX "ProjectWorldAudit_actorId_createdAt_idx" ON "ProjectWorldAudit"("actorId", "createdAt");
CREATE INDEX "ProjectWorldAudit_projectId_relationId_idx" ON "ProjectWorldAudit"("projectId", "relationId");
CREATE INDEX "ProjectWorldAudit_projectId_snapshotId_idx" ON "ProjectWorldAudit"("projectId", "snapshotId");

CREATE UNIQUE INDEX "ProjectItem_projectId_supersedesItemId_key"
  ON "ProjectItem"("projectId", "supersedesItemId");

ALTER TABLE "ProjectFactRelation"
  ADD CONSTRAINT "ProjectFactRelation_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectFactRelation"
  ADD CONSTRAINT "ProjectFactRelation_sourceItem_fkey"
  FOREIGN KEY ("projectId", "sourceItemId") REFERENCES "ProjectItem"("projectId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "ProjectFactRelation"
  ADD CONSTRAINT "ProjectFactRelation_targetItem_fkey"
  FOREIGN KEY ("projectId", "targetItemId") REFERENCES "ProjectItem"("projectId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "ProjectFactRelation"
  ADD CONSTRAINT "ProjectFactRelation_sourceRevision_fkey"
  FOREIGN KEY ("projectId", "sourceItemId", "sourceRevisionId") REFERENCES "ProjectItemRevision"("projectId", "projectItemId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "ProjectFactRelation"
  ADD CONSTRAINT "ProjectFactRelation_targetRevision_fkey"
  FOREIGN KEY ("projectId", "targetItemId", "targetRevisionId") REFERENCES "ProjectItemRevision"("projectId", "projectItemId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "ProjectFactRelation"
  ADD CONSTRAINT "ProjectFactRelation_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "ProjectFactRelation"
  ADD CONSTRAINT "ProjectFactRelation_retiredById_fkey"
  FOREIGN KEY ("retiredById") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "ProjectWorldSnapshot"
  ADD CONSTRAINT "ProjectWorldSnapshot_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectWorldSnapshot"
  ADD CONSTRAINT "ProjectWorldSnapshot_capturedById_fkey"
  FOREIGN KEY ("capturedById") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "ProjectWorldAudit"
  ADD CONSTRAINT "ProjectWorldAudit_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectWorldAudit"
  ADD CONSTRAINT "ProjectWorldAudit_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "ProjectWorldAudit"
  ADD CONSTRAINT "ProjectWorldAudit_relation_fkey"
  FOREIGN KEY ("projectId", "relationId") REFERENCES "ProjectFactRelation"("projectId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "ProjectWorldAudit"
  ADD CONSTRAINT "ProjectWorldAudit_snapshot_fkey"
  FOREIGN KEY ("projectId", "snapshotId") REFERENCES "ProjectWorldSnapshot"("projectId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "ProjectWorldAudit"
  ADD CONSTRAINT "ProjectWorldAudit_sourceItem_fkey"
  FOREIGN KEY ("projectId", "sourceItemId") REFERENCES "ProjectItem"("projectId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "ProjectWorldAudit"
  ADD CONSTRAINT "ProjectWorldAudit_targetItem_fkey"
  FOREIGN KEY ("projectId", "targetItemId") REFERENCES "ProjectItem"("projectId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION "project_fact_relation_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  source_status "ProjectItemReviewStatus";
  target_status "ProjectItemReviewStatus";
  current_source_revision UUID;
  current_target_revision UUID;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'PROJECT_FACT_RELATION_APPEND_ONLY';
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT "reviewStatus" INTO source_status
    FROM "ProjectItem"
    WHERE "projectId" = NEW."projectId" AND "id" = NEW."sourceItemId";
    SELECT "reviewStatus" INTO target_status
    FROM "ProjectItem"
    WHERE "projectId" = NEW."projectId" AND "id" = NEW."targetItemId";
    IF source_status IS DISTINCT FROM 'confirmed' OR target_status IS DISTINCT FROM 'confirmed' THEN
      RAISE EXCEPTION 'PROJECT_FACT_RELATION_CONFIRMED_ITEMS_REQUIRED';
    END IF;
    SELECT "id" INTO current_source_revision
    FROM "ProjectItemRevision"
    WHERE "projectId" = NEW."projectId" AND "projectItemId" = NEW."sourceItemId"
    ORDER BY "revisionNumber" DESC
    LIMIT 1;
    SELECT "id" INTO current_target_revision
    FROM "ProjectItemRevision"
    WHERE "projectId" = NEW."projectId" AND "projectItemId" = NEW."targetItemId"
    ORDER BY "revisionNumber" DESC
    LIMIT 1;
    IF current_source_revision IS DISTINCT FROM NEW."sourceRevisionId"
       OR current_target_revision IS DISTINCT FROM NEW."targetRevisionId"
    THEN
      RAISE EXCEPTION 'PROJECT_FACT_RELATION_CURRENT_REVISIONS_REQUIRED';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."retiredAt" IS NOT NULL THEN
    RAISE EXCEPTION 'PROJECT_FACT_RELATION_RETIRED';
  END IF;
  IF NEW."retiredAt" IS NULL OR NEW."retiredById" IS NULL OR nullif(btrim(NEW."retirementReason"), '') IS NULL THEN
    RAISE EXCEPTION 'PROJECT_FACT_RELATION_RETIREMENT_REQUIRED';
  END IF;
  IF
    NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."projectId" IS DISTINCT FROM OLD."projectId"
    OR NEW."sourceItemId" IS DISTINCT FROM OLD."sourceItemId"
    OR NEW."targetItemId" IS DISTINCT FROM OLD."targetItemId"
    OR NEW."sourceRevisionId" IS DISTINCT FROM OLD."sourceRevisionId"
    OR NEW."targetRevisionId" IS DISTINCT FROM OLD."targetRevisionId"
    OR NEW."kind" IS DISTINCT FROM OLD."kind"
    OR NEW."rationale" IS DISTINCT FROM OLD."rationale"
    OR NEW."fingerprint" IS DISTINCT FROM OLD."fingerprint"
    OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION 'PROJECT_FACT_RELATION_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ProjectFactRelation_lifecycle_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "ProjectFactRelation"
FOR EACH ROW EXECUTE FUNCTION "project_fact_relation_guard"();

CREATE OR REPLACE FUNCTION "project_world_append_only_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'PROJECT_WORLD_APPEND_ONLY';
END;
$$;

CREATE TRIGGER "ProjectWorldSnapshot_append_only_trigger"
BEFORE UPDATE OR DELETE ON "ProjectWorldSnapshot"
FOR EACH ROW EXECUTE FUNCTION "project_world_append_only_guard"();

CREATE TRIGGER "ProjectWorldAudit_append_only_trigger"
BEFORE UPDATE OR DELETE ON "ProjectWorldAudit"
FOR EACH ROW EXECUTE FUNCTION "project_world_append_only_guard"();

CREATE OR REPLACE FUNCTION "assert_project_item_supersession_consistency"(
  checked_project_id UUID,
  checked_item_id UUID
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  item_row "ProjectItem"%ROWTYPE;
  predecessor_row "ProjectItem"%ROWTYPE;
  successor_count INTEGER;
  cycle_found BOOLEAN;
BEGIN
  SELECT * INTO item_row
  FROM "ProjectItem"
  WHERE "projectId" = checked_project_id AND "id" = checked_item_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT count(*) INTO successor_count
  FROM "ProjectItem"
  WHERE "projectId" = checked_project_id AND "supersedesItemId" = checked_item_id;

  IF item_row."reviewStatus" = 'superseded' THEN
    IF successor_count <> 1 THEN
      RAISE EXCEPTION 'PROJECT_ITEM_SUPERSESSION_SUCCESSOR_REQUIRED';
    END IF;
  ELSIF successor_count <> 0 THEN
    RAISE EXCEPTION 'PROJECT_ITEM_SUPERSESSION_STATUS_INVALID';
  END IF;

  IF item_row."supersedesItemId" IS NULL THEN
    RETURN;
  END IF;
  IF item_row."reviewStatus" <> 'confirmed' THEN
    RAISE EXCEPTION 'PROJECT_ITEM_SUPERSESSION_SUCCESSOR_NOT_CONFIRMED';
  END IF;

  SELECT * INTO predecessor_row
  FROM "ProjectItem"
  WHERE "projectId" = checked_project_id AND "id" = item_row."supersedesItemId";
  IF NOT FOUND
     OR predecessor_row."reviewStatus" <> 'superseded'
     OR predecessor_row."type" <> item_row."type"
  THEN
    RAISE EXCEPTION 'PROJECT_ITEM_SUPERSESSION_PREDECESSOR_INVALID';
  END IF;

  WITH RECURSIVE predecessors AS (
    SELECT p."id", p."supersedesItemId"
    FROM "ProjectItem" AS p
    WHERE p."projectId" = checked_project_id AND p."id" = item_row."supersedesItemId"
    UNION
    SELECT p."id", p."supersedesItemId"
    FROM "ProjectItem" AS p
    JOIN predecessors AS previous ON p."id" = previous."supersedesItemId"
    WHERE p."projectId" = checked_project_id
  )
  SELECT EXISTS(SELECT 1 FROM predecessors WHERE "id" = checked_item_id)
  INTO cycle_found;
  IF cycle_found THEN
    RAISE EXCEPTION 'PROJECT_ITEM_SUPERSESSION_CYCLE';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION "project_item_supersession_consistency_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM "assert_project_item_supersession_consistency"(OLD."projectId", OLD."id");
    RETURN OLD;
  END IF;
  PERFORM "assert_project_item_supersession_consistency"(NEW."projectId", NEW."id");
  IF NEW."supersedesItemId" IS NOT NULL THEN
    PERFORM "assert_project_item_supersession_consistency"(NEW."projectId", NEW."supersedesItemId");
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."supersedesItemId" IS NOT NULL AND OLD."supersedesItemId" IS DISTINCT FROM NEW."supersedesItemId" THEN
    PERFORM "assert_project_item_supersession_consistency"(OLD."projectId", OLD."supersedesItemId");
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "ProjectItem_supersession_consistency_constraint_trigger"
AFTER INSERT OR UPDATE OR DELETE ON "ProjectItem"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "project_item_supersession_consistency_guard"();

DO $$
DECLARE
  invalid_count INTEGER;
BEGIN
  SELECT count(*) INTO invalid_count
  FROM "ProjectItem" AS item
  WHERE
    (
      item."reviewStatus" = 'superseded'
      AND NOT EXISTS (
        SELECT 1 FROM "ProjectItem" AS successor
        WHERE successor."projectId" = item."projectId"
          AND successor."supersedesItemId" = item."id"
          AND successor."reviewStatus" = 'confirmed'
      )
    )
    OR (
      item."supersedesItemId" IS NOT NULL
      AND item."reviewStatus" <> 'confirmed'
    );
  IF invalid_count <> 0 THEN
    RAISE EXCEPTION 'PROJECT_ITEM_EXISTING_SUPERSESSION_INVALID';
  END IF;
END;
$$;
