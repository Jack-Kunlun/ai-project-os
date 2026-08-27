ALTER TABLE "ProjectRepositoryLinkConfigVersion"
ADD COLUMN "markdownPaths" JSONB NOT NULL DEFAULT '[]'::jsonb,
ADD CONSTRAINT "RepositoryLinkConfig_markdown_paths_check" CHECK (
    jsonb_typeof("markdownPaths") = 'array'
    AND jsonb_array_length("markdownPaths") <= 100
    AND NOT jsonb_path_exists("markdownPaths", '$[*] ? (@.type() != "string")')
);

ALTER TABLE "RepositoryMaterialGeneration"
ADD COLUMN "failureCode" VARCHAR(64),
DROP CONSTRAINT "RepositoryMaterialGeneration_lifecycle_check",
ADD CONSTRAINT "RepositoryMaterialGeneration_failure_code_check" CHECK (
    "failureCode" IS NULL
    OR "failureCode" ~ '^[A-Z][A-Z0-9_]{0,63}$'
),
ADD CONSTRAINT "RepositoryMaterialGeneration_lifecycle_check" CHECK (
    ("status" = 'staging' AND "failureCode" IS NULL
        AND "completedAt" IS NULL AND "supersededAt" IS NULL)
    OR ("status" = 'complete' AND "failureCode" IS NULL
        AND "completedAt" IS NOT NULL AND "supersededAt" IS NULL)
    OR ("status" IN ('failed', 'ineligible')
        AND "failureCode" IS NOT NULL
        AND "completedAt" IS NOT NULL AND "supersededAt" IS NULL)
    OR ("status" = 'superseded' AND "failureCode" IS NULL
        AND "completedAt" IS NOT NULL AND "supersededAt" IS NOT NULL)
);

CREATE OR REPLACE FUNCTION "repository_material_generation_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    actual_count BIGINT;
    actual_bytes BIGINT;
    actual_manifest TEXT;
    link_eligible BOOLEAN;
BEGIN
    IF TG_OP = 'INSERT' THEN
        SELECT EXISTS (
            SELECT 1
            FROM "ProjectRepositoryLink" AS link
            JOIN "ProjectRepositoryLinkConfigPointer" AS pointer
              ON pointer."projectId" = link."projectId"
             AND pointer."projectRepositoryLinkId" = link."id"
            WHERE link."projectId" = NEW."projectId"
              AND link."id" = NEW."projectRepositoryLinkId"
              AND link."status" = 'active'
              AND link."effectivePolicyVersion" = NEW."effectivePolicyVersion"
              AND pointer."configVersion" = NEW."linkConfigVersion"
              AND pointer."effectivePolicyVersion" = NEW."effectivePolicyVersion"
        ) INTO link_eligible;
        IF NEW."status" <> 'staging' OR link_eligible IS NOT TRUE THEN
            RAISE EXCEPTION 'material generation is not eligible for staging'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;
    IF TG_OP = 'DELETE' THEN
        IF EXISTS (SELECT 1 FROM "Project" WHERE "id" = OLD."projectId") THEN
            RAISE EXCEPTION 'material generation is immutable'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN OLD;
    END IF;
    IF ROW(
        NEW."id", NEW."projectId", NEW."projectRepositoryLinkId",
        NEW."linkConfigVersion", NEW."githubMaterialSyncRunId",
        NEW."generationKey", NEW."capturedGitHubRepositoryId",
        NEW."capturedFullName", NEW."observedHeadCommitSha",
        NEW."effectivePolicyVersion", NEW."manifestFingerprint",
        NEW."enabledClassManifest", NEW."coverageManifest",
        NEW."scannerVersion", NEW."scannerFingerprint",
        NEW."sourceCount", NEW."decodedTextBytes", NEW."createdAt"
    ) IS DISTINCT FROM ROW(
        OLD."id", OLD."projectId", OLD."projectRepositoryLinkId",
        OLD."linkConfigVersion", OLD."githubMaterialSyncRunId",
        OLD."generationKey", OLD."capturedGitHubRepositoryId",
        OLD."capturedFullName", OLD."observedHeadCommitSha",
        OLD."effectivePolicyVersion", OLD."manifestFingerprint",
        OLD."enabledClassManifest", OLD."coverageManifest",
        OLD."scannerVersion", OLD."scannerFingerprint",
        OLD."sourceCount", OLD."decodedTextBytes", OLD."createdAt"
    ) THEN
        RAISE EXCEPTION 'material generation structure is immutable'
            USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'staging'
        AND NEW."status" NOT IN ('staging', 'complete', 'failed', 'ineligible') THEN
        RAISE EXCEPTION 'invalid material generation transition'
            USING ERRCODE = 'check_violation';
    ELSIF OLD."status" IN ('complete', 'failed', 'ineligible', 'superseded')
        AND NOT (
            NEW."status" = OLD."status"
            OR (OLD."status" = 'complete' AND NEW."status" = 'superseded')
        ) THEN
        RAISE EXCEPTION 'terminal material generation cannot be reopened'
            USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" <> 'staging'
        AND NEW."failureCode" IS DISTINCT FROM OLD."failureCode" THEN
        RAISE EXCEPTION 'terminal material generation failure is immutable'
            USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" = 'complete' THEN
        SELECT COUNT(*), COALESCE(SUM(entry."sourceContentBytes"), 0),
               encode(sha256(convert_to(COALESCE(string_agg(concat_ws(E'\x1f',
                   entry."ordinal"::text,
                   entry."id"::text,
                   entry."githubSourceVersionId"::text,
                   entry."projectSourceId"::text,
                   entry."materialKind"::text,
                   entry."sourceContentHash",
                   entry."sourceContentBytes"::text
               ), E'\x1e' ORDER BY entry."ordinal"), ''), 'UTF8')), 'hex')
        INTO actual_count, actual_bytes, actual_manifest
        FROM "RepositoryMaterialGenerationEntry" AS entry
        WHERE entry."projectId" = NEW."projectId"
          AND entry."projectRepositoryLinkId" = NEW."projectRepositoryLinkId"
          AND entry."repositoryMaterialGenerationId" = NEW."id";
        IF actual_count <> NEW."sourceCount"
            OR actual_bytes <> NEW."decodedTextBytes"
            OR actual_manifest IS DISTINCT FROM NEW."manifestFingerprint" THEN
            RAISE EXCEPTION 'material generation manifest is incomplete'
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
