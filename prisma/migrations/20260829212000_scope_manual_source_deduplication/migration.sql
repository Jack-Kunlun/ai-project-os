-- Content-level duplicate rejection is a manual-entry rule. Imported files,
-- web revisions and Git paths may legitimately contain identical text while
-- retaining different provenance identities.
DROP INDEX IF EXISTS "ProjectSource_projectId_manualContentDedupeKey_active_key";

UPDATE "ProjectSource"
SET "manualContentDedupeKey" = NULL
WHERE "originScope" = 'project'
  AND "kind" <> 'manual';

ALTER TABLE "ProjectSource"
  DROP CONSTRAINT "ProjectSource_origin_scope_check",
  ADD CONSTRAINT "ProjectSource_origin_scope_check" CHECK (
    (
      "originScope" = 'project'
      AND "projectRepositoryLinkId" IS NULL
      AND (
        (
          "kind" = 'manual'
          AND "manualContentDedupeKey" IS NOT NULL
          AND "manualContentDedupeKey" = "contentHash"
        )
        OR (
          "kind" <> 'manual'
          AND "manualContentDedupeKey" IS NULL
        )
      )
    )
    OR (
      "originScope" = 'repository_link'
      AND "projectRepositoryLinkId" IS NOT NULL
      AND "manualContentDedupeKey" IS NULL
    )
  );

CREATE UNIQUE INDEX "ProjectSource_projectId_manualContentDedupeKey_active_key"
ON "ProjectSource"("projectId", "manualContentDedupeKey")
WHERE "manualContentDedupeKey" IS NOT NULL;

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
        IF NEW."originScope" = 'project' AND NEW."kind" = 'manual' AND NEW."manualContentDedupeKey" IS NULL THEN
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
