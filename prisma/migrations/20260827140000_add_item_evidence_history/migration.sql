-- Source identity is opaque and versioned independently from content-derived
-- deduplication. Existing rows remain project-owned and retain every V0 field.
CREATE TYPE "ContentOriginScope" AS ENUM ('project', 'repository_link');
CREATE TYPE "ProjectItemEvidenceRole" AS ENUM ('primary', 'supporting');
CREATE TYPE "ProjectItemEvidenceState" AS ENUM ('active', 'purged');
CREATE TYPE "ProjectEvidenceRangeUnit" AS ENUM ('utf8_byte', 'line');
CREATE TYPE "ProjectItemRevisionAction" AS ENUM (
    'legacy_import',
    'manual_created',
    'ai_created',
    'edited',
    'confirmed',
    'dismissed',
    'reopened',
    'rebind_source',
    'repair_evidence'
);
CREATE TYPE "ProjectItemRevisionIntegrityState" AS ENUM ('active', 'purged_redacted');

ALTER TABLE "ProjectSource"
    ADD COLUMN "originScope" "ContentOriginScope" NOT NULL DEFAULT 'project',
    ADD COLUMN "projectRepositoryLinkId" UUID,
    ADD COLUMN "sourceIdentity" UUID,
    ADD COLUMN "revisionKey" UUID,
    ADD COLUMN "manualContentDedupeKey" VARCHAR(64);

UPDATE "ProjectSource"
SET "sourceIdentity" = gen_random_uuid(),
    "revisionKey" = gen_random_uuid(),
    "manualContentDedupeKey" = "contentHash";

ALTER TABLE "ProjectSource"
    ALTER COLUMN "sourceIdentity" SET NOT NULL,
    ALTER COLUMN "sourceIdentity" SET DEFAULT gen_random_uuid(),
    ALTER COLUMN "revisionKey" SET NOT NULL,
    ALTER COLUMN "revisionKey" SET DEFAULT gen_random_uuid();

ALTER TABLE "ProjectSource"
    ADD CONSTRAINT "ProjectSource_origin_scope_check" CHECK (
        (
            "originScope" = 'project'
            AND "projectRepositoryLinkId" IS NULL
            AND "manualContentDedupeKey" IS NOT NULL
            AND "manualContentDedupeKey" = "contentHash"
        )
        OR (
            "originScope" = 'repository_link'
            AND "projectRepositoryLinkId" IS NOT NULL
            AND "manualContentDedupeKey" IS NULL
        )
    );

CREATE UNIQUE INDEX "ProjectSource_projectId_id_originScope_key"
ON "ProjectSource"("projectId", "id", "originScope");

CREATE UNIQUE INDEX "ProjectSource_projectId_id_originScope_projectRepositoryLinkId_key"
ON "ProjectSource"("projectId", "id", "originScope", "projectRepositoryLinkId");

CREATE UNIQUE INDEX "ProjectSource_projectId_sourceIdentity_revisionKey_key"
ON "ProjectSource"("projectId", "sourceIdentity", "revisionKey");

CREATE UNIQUE INDEX "ProjectSource_projectId_manualContentDedupeKey_active_key"
ON "ProjectSource"("projectId", "manualContentDedupeKey")
WHERE "manualContentDedupeKey" IS NOT NULL;

DROP INDEX "ProjectSource_projectId_contentHash_key";

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
        NEW."id", NEW."projectId", NEW."originScope",
        NEW."projectRepositoryLinkId", NEW."sourceIdentity", NEW."revisionKey"
    ) IS DISTINCT FROM ROW(
        OLD."id", OLD."projectId", OLD."originScope",
        OLD."projectRepositoryLinkId", OLD."sourceIdentity", OLD."revisionKey"
    ) THEN
        RAISE EXCEPTION 'project source identity is immutable'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "ProjectSource_identity_trigger"
BEFORE INSERT OR UPDATE ON "ProjectSource"
FOR EACH ROW EXECUTE FUNCTION "project_source_identity_guard"();

-- A legacy item without exact source evidence cannot be migrated safely.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM "ProjectItem" AS i
        LEFT JOIN "ProjectSource" AS s
          ON s."projectId" = i."projectId" AND s."id" = i."sourceId"
        WHERE s."id" IS NULL
           OR i."sourceExcerpt" IS NULL
           OR length(btrim(i."sourceExcerpt")) = 0
           OR position(
                convert_to(i."sourceExcerpt", 'UTF8')
                IN convert_to(s."contentText", 'UTF8')
              ) = 0
    ) THEN
        RAISE EXCEPTION 'legacy project item evidence is not exact'
            USING ERRCODE = 'check_violation';
    END IF;
END;
$$;

CREATE TABLE "ProjectItemEvidence" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "projectItemId" UUID NOT NULL,
    "role" "ProjectItemEvidenceRole" NOT NULL,
    "evidenceState" "ProjectItemEvidenceState" NOT NULL DEFAULT 'active',
    "originScope" "ContentOriginScope" NOT NULL DEFAULT 'project',
    "projectRepositoryLinkId" UUID,
    "projectSourceId" UUID,
    "sourceExcerpt" TEXT,
    "sourceExcerptFingerprint" VARCHAR(64),
    "rangeUnit" "ProjectEvidenceRangeUnit",
    "rangeStart" INTEGER,
    "rangeEnd" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supersededAt" TIMESTAMP(3),
    "purgedAt" TIMESTAMP(3),
    "deletionReceipt" UUID,

    CONSTRAINT "ProjectItemEvidence_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ProjectItemEvidence_origin_check" CHECK (
        "originScope" = 'project'
        AND "projectRepositoryLinkId" IS NULL
        AND "projectSourceId" IS NOT NULL
    ),
    CONSTRAINT "ProjectItemEvidence_active_payload_check" CHECK (
        (
            "evidenceState" = 'active'
            AND "sourceExcerpt" IS NOT NULL
            AND length(btrim("sourceExcerpt")) > 0
            AND char_length("sourceExcerpt") <= 10000
            AND octet_length("sourceExcerpt") <= 40000
            AND "sourceExcerpt" !~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
            AND "sourceExcerptFingerprint" ~ '^[0-9a-f]{64}$'
            AND "rangeUnit" = 'utf8_byte'
            AND "rangeStart" >= 0
            AND "rangeEnd" > "rangeStart"
            AND "rangeEnd" - "rangeStart" = octet_length("sourceExcerpt")
            AND "purgedAt" IS NULL
            AND "deletionReceipt" IS NULL
            AND (
                ("isActive" = true AND "supersededAt" IS NULL)
                OR ("isActive" = false AND "supersededAt" IS NOT NULL)
            )
        )
        OR (
            "evidenceState" = 'purged'
            AND "sourceExcerpt" IS NULL
            AND "sourceExcerptFingerprint" IS NULL
            AND "rangeUnit" IS NULL
            AND "rangeStart" IS NULL
            AND "rangeEnd" IS NULL
            AND "isActive" = false
            AND "purgedAt" IS NOT NULL
            AND "deletionReceipt" IS NOT NULL
        )
    )
);

CREATE TABLE "ProjectItemRevision" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "projectItemId" UUID NOT NULL,
    "revisionNumber" INTEGER NOT NULL,
    "action" "ProjectItemRevisionAction" NOT NULL,
    "actorId" VARCHAR(128) NOT NULL,
    "reason" TEXT,
    "itemType" "ProjectItemType" NOT NULL,
    "reviewStatus" "ProjectItemReviewStatus" NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "sourceId" UUID,
    "sourceExcerpt" TEXT,
    "occurredAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "supersedesItemId" UUID,
    "metadata" JSONB NOT NULL,
    "evidenceManifestFingerprint" VARCHAR(64),
    "integrityState" "ProjectItemRevisionIntegrityState" NOT NULL DEFAULT 'active',
    "deletionReceipt" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectItemRevision_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ProjectItemRevision_revision_number_check" CHECK ("revisionNumber" > 0),
    CONSTRAINT "ProjectItemRevision_actor_check" CHECK (
        "actorId" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$'
    ),
    CONSTRAINT "ProjectItemRevision_reason_check" CHECK (
        "reason" IS NULL
        OR (
            char_length("reason") <= 2000
            AND "reason" !~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
        )
    ),
    CONSTRAINT "ProjectItemRevision_review_state_check" CHECK (
        ("reviewStatus" = 'confirmed' AND "confirmedAt" IS NOT NULL)
        OR ("reviewStatus" <> 'confirmed' AND "confirmedAt" IS NULL)
    ),
    CONSTRAINT "ProjectItemRevision_integrity_check" CHECK (
        (
            "integrityState" = 'active'
            AND "sourceId" IS NOT NULL
            AND "sourceExcerpt" IS NOT NULL
            AND length(btrim("sourceExcerpt")) > 0
            AND "evidenceManifestFingerprint" ~ '^[0-9a-f]{64}$'
            AND "deletionReceipt" IS NULL
        )
        OR (
            "integrityState" = 'purged_redacted'
            AND "sourceId" IS NULL
            AND "sourceExcerpt" IS NULL
            AND "evidenceManifestFingerprint" IS NULL
            AND "deletionReceipt" IS NOT NULL
        )
    )
);

CREATE TABLE "ProjectItemRevisionEvidence" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "projectItemId" UUID NOT NULL,
    "revisionId" UUID NOT NULL,
    "evidenceId" UUID NOT NULL,
    "role" "ProjectItemEvidenceRole" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectItemRevisionEvidence_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProjectItemEvidence_projectId_id_key"
ON "ProjectItemEvidence"("projectId", "id");
CREATE UNIQUE INDEX "ProjectItemEvidence_projectId_projectItemId_id_key"
ON "ProjectItemEvidence"("projectId", "projectItemId", "id");
CREATE INDEX "ProjectItemEvidence_projectId_projectItemId_isActive_idx"
ON "ProjectItemEvidence"("projectId", "projectItemId", "isActive");
CREATE INDEX "ProjectItemEvidence_projectId_projectSourceId_idx"
ON "ProjectItemEvidence"("projectId", "projectSourceId");
CREATE UNIQUE INDEX "ProjectItemEvidence_one_active_primary_key"
ON "ProjectItemEvidence"("projectId", "projectItemId")
WHERE "role" = 'primary' AND "evidenceState" = 'active' AND "isActive" = true;

CREATE UNIQUE INDEX "ProjectItemRevision_projectId_id_key"
ON "ProjectItemRevision"("projectId", "id");
CREATE UNIQUE INDEX "ProjectItemRevision_projectId_projectItemId_id_key"
ON "ProjectItemRevision"("projectId", "projectItemId", "id");
CREATE UNIQUE INDEX "ProjectItemRevision_projectId_projectItemId_revisionNumber_key"
ON "ProjectItemRevision"("projectId", "projectItemId", "revisionNumber");
CREATE INDEX "ProjectItemRevision_projectId_projectItemId_createdAt_idx"
ON "ProjectItemRevision"("projectId", "projectItemId", "createdAt");

CREATE UNIQUE INDEX "ProjectItemRevisionEvidence_projectId_id_key"
ON "ProjectItemRevisionEvidence"("projectId", "id");
CREATE UNIQUE INDEX "ProjectItemRevisionEvidence_projectId_revisionId_evidenceId_key"
ON "ProjectItemRevisionEvidence"("projectId", "revisionId", "evidenceId");
CREATE INDEX "ProjectItemRevisionEvidence_projectId_projectItemId_revisionId_idx"
ON "ProjectItemRevisionEvidence"("projectId", "projectItemId", "revisionId");
CREATE INDEX "ProjectItemRevisionEvidence_projectId_projectItemId_evidenceId_idx"
ON "ProjectItemRevisionEvidence"("projectId", "projectItemId", "evidenceId");
CREATE UNIQUE INDEX "ProjectItemRevisionEvidence_one_primary_key"
ON "ProjectItemRevisionEvidence"("projectId", "revisionId")
WHERE "role" = 'primary';

ALTER TABLE "ProjectItemEvidence"
ADD CONSTRAINT "ProjectItemEvidence_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "Project"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProjectItemEvidence"
ADD CONSTRAINT "ProjectItemEvidence_projectId_projectItemId_fkey"
FOREIGN KEY ("projectId", "projectItemId")
REFERENCES "ProjectItem"("projectId", "id")
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "ProjectItemEvidence"
ADD CONSTRAINT "ProjectItemEvidence_projectId_projectSourceId_originScope_fkey"
FOREIGN KEY ("projectId", "projectSourceId", "originScope")
REFERENCES "ProjectSource"("projectId", "id", "originScope")
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "ProjectItemRevision"
ADD CONSTRAINT "ProjectItemRevision_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "Project"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProjectItemRevision"
ADD CONSTRAINT "ProjectItemRevision_projectId_projectItemId_fkey"
FOREIGN KEY ("projectId", "projectItemId")
REFERENCES "ProjectItem"("projectId", "id")
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "ProjectItemRevisionEvidence"
ADD CONSTRAINT "ProjectItemRevisionEvidence_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "Project"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProjectItemRevisionEvidence"
ADD CONSTRAINT "ProjectItemRevisionEvidence_projectId_projectItemId_revisionId_fkey"
FOREIGN KEY ("projectId", "projectItemId", "revisionId")
REFERENCES "ProjectItemRevision"("projectId", "projectItemId", "id")
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "ProjectItemRevisionEvidence"
ADD CONSTRAINT "ProjectItemRevisionEvidence_projectId_projectItemId_evidenceId_fkey"
FOREIGN KEY ("projectId", "projectItemId", "evidenceId")
REFERENCES "ProjectItemEvidence"("projectId", "projectItemId", "id")
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

INSERT INTO "ProjectItemEvidence" (
    "id", "projectId", "projectItemId", "role", "evidenceState",
    "originScope", "projectSourceId", "sourceExcerpt",
    "sourceExcerptFingerprint", "rangeUnit", "rangeStart", "rangeEnd",
    "isActive", "createdAt"
)
SELECT
    gen_random_uuid(),
    i."projectId",
    i."id",
    'primary',
    'active',
    'project',
    i."sourceId",
    i."sourceExcerpt",
    encode(sha256(convert_to(i."sourceExcerpt", 'UTF8')), 'hex'),
    'utf8_byte',
    position(convert_to(i."sourceExcerpt", 'UTF8') IN convert_to(s."contentText", 'UTF8')) - 1,
    position(convert_to(i."sourceExcerpt", 'UTF8') IN convert_to(s."contentText", 'UTF8')) - 1
        + octet_length(i."sourceExcerpt"),
    true,
    i."createdAt"
FROM "ProjectItem" AS i
JOIN "ProjectSource" AS s
  ON s."projectId" = i."projectId" AND s."id" = i."sourceId";

INSERT INTO "ProjectItemRevision" (
    "id", "projectId", "projectItemId", "revisionNumber", "action",
    "actorId", "itemType", "reviewStatus", "title", "content",
    "sourceId", "sourceExcerpt", "occurredAt", "confirmedAt",
    "supersedesItemId", "metadata", "evidenceManifestFingerprint",
    "integrityState", "createdAt"
)
SELECT
    gen_random_uuid(),
    i."projectId",
    i."id",
    1,
    'legacy_import',
    'system:migration',
    i."type",
    i."reviewStatus",
    i."title",
    i."content",
    i."sourceId",
    i."sourceExcerpt",
    i."occurredAt",
    i."confirmedAt",
    i."supersedesItemId",
    i."metadata",
    encode(
        sha256(
            convert_to(
                e."projectSourceId"::text || ':'
                || e."sourceExcerptFingerprint" || ':'
                || e."rangeStart"::text || ':'
                || e."rangeEnd"::text,
                'UTF8'
            )
        ),
        'hex'
    ),
    'active',
    i."createdAt"
FROM "ProjectItem" AS i
JOIN "ProjectItemEvidence" AS e
  ON e."projectId" = i."projectId"
 AND e."projectItemId" = i."id"
 AND e."role" = 'primary'
 AND e."isActive" = true;

INSERT INTO "ProjectItemRevisionEvidence" (
    "id", "projectId", "projectItemId", "revisionId", "evidenceId",
    "role", "createdAt"
)
SELECT
    gen_random_uuid(),
    r."projectId",
    r."projectItemId",
    r."id",
    e."id",
    'primary',
    r."createdAt"
FROM "ProjectItemRevision" AS r
JOIN "ProjectItemEvidence" AS e
  ON e."projectId" = r."projectId"
 AND e."projectItemId" = r."projectItemId"
 AND e."role" = 'primary'
 AND e."isActive" = true
WHERE r."revisionNumber" = 1;

DO $$
DECLARE
    item_count BIGINT;
    evidence_count BIGINT;
    revision_count BIGINT;
    revision_link_count BIGINT;
BEGIN
    SELECT count(*) INTO item_count FROM "ProjectItem";
    SELECT count(*) INTO evidence_count
    FROM "ProjectItemEvidence"
    WHERE "role" = 'primary' AND "isActive" = true;
    SELECT count(*) INTO revision_count
    FROM "ProjectItemRevision"
    WHERE "revisionNumber" = 1 AND "action" = 'legacy_import';
    SELECT count(*) INTO revision_link_count
    FROM "ProjectItemRevisionEvidence"
    WHERE "role" = 'primary';

    IF item_count <> evidence_count
        OR item_count <> revision_count
        OR item_count <> revision_link_count THEN
        RAISE EXCEPTION 'legacy item evidence or revision backfill is incomplete'
            USING ERRCODE = 'check_violation';
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION "project_item_evidence_lifecycle_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    source_content TEXT;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."evidenceState" <> 'active'
            OR NEW."originScope" <> 'project'
            OR NEW."projectSourceId" IS NULL
            OR NEW."rangeUnit" <> 'utf8_byte' THEN
            RAISE EXCEPTION 'new project item evidence must be active project evidence'
                USING ERRCODE = 'check_violation';
        END IF;

        SELECT s."contentText"
        INTO source_content
        FROM "ProjectSource" AS s
        WHERE s."projectId" = NEW."projectId"
          AND s."id" = NEW."projectSourceId"
          AND s."originScope" = NEW."originScope"
        FOR KEY SHARE;

        IF NOT FOUND
            OR NEW."sourceExcerptFingerprint" IS DISTINCT FROM
                encode(sha256(convert_to(NEW."sourceExcerpt", 'UTF8')), 'hex')
            OR substring(
                convert_to(source_content, 'UTF8')
                FROM NEW."rangeStart" + 1
                FOR NEW."rangeEnd" - NEW."rangeStart"
            ) IS DISTINCT FROM convert_to(NEW."sourceExcerpt", 'UTF8') THEN
            RAISE EXCEPTION 'project item evidence does not match source bytes'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;

    IF TG_OP = 'DELETE' THEN
        IF EXISTS (SELECT 1 FROM "Project" WHERE "id" = OLD."projectId") THEN
            RAISE EXCEPTION 'project item evidence deletion is forbidden'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN OLD;
    END IF;

    IF ROW(
        NEW."id", NEW."projectId", NEW."projectItemId", NEW."role",
        NEW."evidenceState", NEW."originScope", NEW."projectRepositoryLinkId",
        NEW."projectSourceId", NEW."sourceExcerpt",
        NEW."sourceExcerptFingerprint", NEW."rangeUnit", NEW."rangeStart",
        NEW."rangeEnd", NEW."createdAt", NEW."purgedAt", NEW."deletionReceipt"
    ) IS DISTINCT FROM ROW(
        OLD."id", OLD."projectId", OLD."projectItemId", OLD."role",
        OLD."evidenceState", OLD."originScope", OLD."projectRepositoryLinkId",
        OLD."projectSourceId", OLD."sourceExcerpt",
        OLD."sourceExcerptFingerprint", OLD."rangeUnit", OLD."rangeStart",
        OLD."rangeEnd", OLD."createdAt", OLD."purgedAt", OLD."deletionReceipt"
    ) OR OLD."isActive" <> true
      OR OLD."supersededAt" IS NOT NULL
      OR NEW."isActive" <> false
      OR NEW."supersededAt" IS NULL
      OR NEW."supersededAt" < OLD."createdAt" THEN
        RAISE EXCEPTION 'invalid project item evidence lifecycle transition'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "ProjectItemEvidence_lifecycle_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "ProjectItemEvidence"
FOR EACH ROW EXECUTE FUNCTION "project_item_evidence_lifecycle_guard"();

CREATE OR REPLACE FUNCTION "project_item_revision_lifecycle_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    expected_revision INTEGER;
BEGIN
    IF TG_OP = 'INSERT' THEN
        SELECT COALESCE(max(r."revisionNumber"), 0) + 1
        INTO expected_revision
        FROM "ProjectItemRevision" AS r
        WHERE r."projectId" = NEW."projectId"
          AND r."projectItemId" = NEW."projectItemId";

        IF NEW."revisionNumber" <> expected_revision
            OR NEW."integrityState" <> 'active' THEN
            RAISE EXCEPTION 'project item revision sequence is invalid'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;

    IF EXISTS (SELECT 1 FROM "Project" WHERE "id" = OLD."projectId") THEN
        RAISE EXCEPTION 'project item revision is append-only'
            USING ERRCODE = 'check_violation';
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "ProjectItemRevision_lifecycle_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "ProjectItemRevision"
FOR EACH ROW EXECUTE FUNCTION "project_item_revision_lifecycle_guard"();

CREATE OR REPLACE FUNCTION "project_item_revision_evidence_lifecycle_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        RETURN NEW;
    END IF;
    IF EXISTS (SELECT 1 FROM "Project" WHERE "id" = OLD."projectId") THEN
        RAISE EXCEPTION 'project item revision evidence is append-only'
            USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "ProjectItemRevisionEvidence_lifecycle_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "ProjectItemRevisionEvidence"
FOR EACH ROW EXECUTE FUNCTION "project_item_revision_evidence_lifecycle_guard"();

CREATE OR REPLACE FUNCTION "assert_project_item_revision_evidence"(
    target_project_id UUID,
    target_item_id UUID,
    target_revision_id UUID
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    primary_count INTEGER;
    revision_source_id UUID;
    revision_excerpt TEXT;
    evidence_source_id UUID;
    evidence_excerpt TEXT;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM "ProjectItemRevision"
        WHERE "projectId" = target_project_id
          AND "projectItemId" = target_item_id
          AND "id" = target_revision_id
    ) THEN
        RETURN;
    END IF;

    SELECT count(*)
    INTO primary_count
    FROM "ProjectItemRevisionEvidence" AS re
    JOIN "ProjectItemEvidence" AS e
      ON e."projectId" = re."projectId"
     AND e."projectItemId" = re."projectItemId"
     AND e."id" = re."evidenceId"
    WHERE re."projectId" = target_project_id
      AND re."projectItemId" = target_item_id
      AND re."revisionId" = target_revision_id
      AND re."role" = 'primary'
      AND e."role" = 'primary';

    SELECT e."projectSourceId", e."sourceExcerpt"
    INTO evidence_source_id, evidence_excerpt
    FROM "ProjectItemRevisionEvidence" AS re
    JOIN "ProjectItemEvidence" AS e
      ON e."projectId" = re."projectId"
     AND e."projectItemId" = re."projectItemId"
     AND e."id" = re."evidenceId"
    WHERE re."projectId" = target_project_id
      AND re."projectItemId" = target_item_id
      AND re."revisionId" = target_revision_id
      AND re."role" = 'primary'
      AND e."role" = 'primary'
    LIMIT 1;

    SELECT r."sourceId", r."sourceExcerpt"
    INTO revision_source_id, revision_excerpt
    FROM "ProjectItemRevision" AS r
    WHERE r."projectId" = target_project_id
      AND r."projectItemId" = target_item_id
      AND r."id" = target_revision_id;

    IF primary_count <> 1
        OR revision_source_id IS DISTINCT FROM evidence_source_id
        OR revision_excerpt IS DISTINCT FROM evidence_excerpt THEN
        RAISE EXCEPTION 'project item revision primary evidence is inconsistent'
            USING ERRCODE = 'check_violation';
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION "assert_project_item_history_consistency"(
    target_project_id UUID,
    target_item_id UUID
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    active_primary_count INTEGER;
    item_row "ProjectItem"%ROWTYPE;
    revision_row "ProjectItemRevision"%ROWTYPE;
BEGIN
    SELECT * INTO item_row
    FROM "ProjectItem"
    WHERE "projectId" = target_project_id AND "id" = target_item_id;

    IF NOT FOUND THEN
        RETURN;
    END IF;

    SELECT count(*) INTO active_primary_count
    FROM "ProjectItemEvidence"
    WHERE "projectId" = target_project_id
      AND "projectItemId" = target_item_id
      AND "role" = 'primary'
      AND "evidenceState" = 'active'
      AND "isActive" = true;

    SELECT * INTO revision_row
    FROM "ProjectItemRevision"
    WHERE "projectId" = target_project_id
      AND "projectItemId" = target_item_id
    ORDER BY "revisionNumber" DESC
    LIMIT 1;

    IF active_primary_count <> 1
        OR NOT FOUND
        OR ROW(
            item_row."type", item_row."reviewStatus", item_row."title",
            item_row."content", item_row."sourceId", item_row."sourceExcerpt",
            item_row."occurredAt", item_row."confirmedAt",
            item_row."supersedesItemId", item_row."metadata"
        ) IS DISTINCT FROM ROW(
            revision_row."itemType", revision_row."reviewStatus",
            revision_row."title", revision_row."content",
            revision_row."sourceId", revision_row."sourceExcerpt",
            revision_row."occurredAt", revision_row."confirmedAt",
            revision_row."supersedesItemId", revision_row."metadata"
        ) THEN
        RAISE EXCEPTION 'project item current state is not represented by history'
            USING ERRCODE = 'check_violation';
    END IF;

    PERFORM "assert_project_item_revision_evidence"(
        target_project_id,
        target_item_id,
        revision_row."id"
    );
END;
$$;

CREATE OR REPLACE FUNCTION "project_item_history_from_item_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM "assert_project_item_history_consistency"(
        COALESCE(NEW."projectId", OLD."projectId"),
        COALESCE(NEW."id", OLD."id")
    );
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION "project_item_history_from_child_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM "assert_project_item_history_consistency"(
        COALESCE(NEW."projectId", OLD."projectId"),
        COALESCE(NEW."projectItemId", OLD."projectItemId")
    );
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION "project_item_revision_evidence_consistency_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM "assert_project_item_revision_evidence"(
        COALESCE(NEW."projectId", OLD."projectId"),
        COALESCE(NEW."projectItemId", OLD."projectItemId"),
        COALESCE(NEW."revisionId", OLD."revisionId")
    );
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "ProjectItem_history_consistency_constraint_trigger"
AFTER INSERT OR UPDATE OR DELETE ON "ProjectItem"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "project_item_history_from_item_guard"();

CREATE CONSTRAINT TRIGGER "ProjectItemEvidence_history_consistency_constraint_trigger"
AFTER INSERT OR UPDATE OR DELETE ON "ProjectItemEvidence"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "project_item_history_from_child_guard"();

CREATE CONSTRAINT TRIGGER "ProjectItemRevision_history_consistency_constraint_trigger"
AFTER INSERT OR UPDATE OR DELETE ON "ProjectItemRevision"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "project_item_history_from_child_guard"();

CREATE CONSTRAINT TRIGGER "ProjectItemRevisionEvidence_history_consistency_constraint_trigger"
AFTER INSERT OR UPDATE OR DELETE ON "ProjectItemRevisionEvidence"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "project_item_history_from_child_guard"();

CREATE CONSTRAINT TRIGGER "ProjectItemRevisionEvidence_revision_consistency_constraint_trigger"
AFTER INSERT OR UPDATE OR DELETE ON "ProjectItemRevisionEvidence"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "project_item_revision_evidence_consistency_guard"();
