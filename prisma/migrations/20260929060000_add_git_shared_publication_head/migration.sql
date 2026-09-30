-- One canonical, compare-and-swap publication head per delegated repository.
-- The automatic run ledger remains inert; this migration only makes its future
-- publication identity share the same immutable version and source entries.

CREATE OR REPLACE FUNCTION pg_temp.project_git_publication_uuid(input_text TEXT)
RETURNS UUID
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
DECLARE
  digest_bytes BYTEA;
  digest_hex TEXT;
BEGIN
  digest_bytes := substring(public.digest(convert_to(input_text, 'UTF8'), 'sha256') FROM 1 FOR 16);
  digest_bytes := set_byte(digest_bytes, 6, (get_byte(digest_bytes, 6) & 15) | 80);
  digest_bytes := set_byte(digest_bytes, 8, (get_byte(digest_bytes, 8) & 63) | 128);
  digest_hex := encode(digest_bytes, 'hex');
  RETURN (
    substring(digest_hex, 1, 8) || '-' || substring(digest_hex, 9, 4) || '-'
    || substring(digest_hex, 13, 4) || '-' || substring(digest_hex, 17, 4) || '-'
    || substring(digest_hex, 21, 12)
  )::UUID;
END;
$$;

-- Never silently select or skip a legacy manual pointer during backfill. The
-- preflight mirrors the runtime baseline integrity contract before any public
-- schema change is made.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM "ProjectGitRepositoryManualPointer" pointer_row
      LEFT JOIN "ProjectGitRepositoryManualRun" run_row
        ON run_row."id" = pointer_row."runId"
       AND run_row."projectId" = pointer_row."projectId"
       AND run_row."delegationId" = pointer_row."delegationId"
     WHERE run_row."id" IS NULL
        OR run_row."status" <> 'succeeded'
        OR run_row."stage" <> 'terminal'
        OR run_row."dispatchState" <> 'acknowledged'
        OR run_row."failureCode" IS NOT NULL
        OR run_row."delegationVersion" <> pointer_row."delegationVersion"
        OR run_row."delegationFingerprint" <> pointer_row."delegationFingerprint"
        OR run_row."frozenCommitSha" IS DISTINCT FROM pointer_row."frozenCommitSha"
        OR run_row."manifestFingerprint" IS DISTINCT FROM pointer_row."manifestFingerprint"
        OR run_row."completedAt" IS DISTINCT FROM pointer_row."publishedAt"
        OR run_row."fileCount" <= 0
        OR run_row."decodedTextBytes" < 0
        OR btrim(pointer_row."frozenCommitSha") !~ '^([0-9a-f]{40}|[0-9a-f]{64})$'
        OR pointer_row."manifestFingerprint" !~ '^[0-9a-f]{64}$'
        OR "project_git_manual_runtime_manifest"(pointer_row."runId") IS DISTINCT FROM pointer_row."manifestFingerprint"
        OR (
          SELECT count(*)
            FROM "ProjectGitRepositoryManualRunEntry" entry
           WHERE entry."projectId" = pointer_row."projectId"
             AND entry."runId" = pointer_row."runId"
        ) <> run_row."fileCount"
        OR (
          SELECT COALESCE(sum(entry."contentBytes"), 0)
            FROM "ProjectGitRepositoryManualRunEntry" entry
           WHERE entry."projectId" = pointer_row."projectId"
             AND entry."runId" = pointer_row."runId"
        ) <> run_row."decodedTextBytes"
        OR EXISTS (
          SELECT 1
            FROM (
              SELECT entry.*,
                     row_number() OVER (ORDER BY entry."ordinal") - 1 AS expected_ordinal
                FROM "ProjectGitRepositoryManualRunEntry" entry
               WHERE entry."projectId" = pointer_row."projectId"
                 AND entry."runId" = pointer_row."runId"
            ) ordered_entry
           WHERE ordered_entry."ordinal" <> ordered_entry.expected_ordinal
              OR ordered_entry."delegationId" <> pointer_row."delegationId"
              OR ordered_entry."delegationVersion" <> pointer_row."delegationVersion"
              OR ordered_entry."delegationFingerprint" <> pointer_row."delegationFingerprint"
              OR ordered_entry."contentBytes" < 0
              OR ordered_entry."lineCount" < 0
              OR ordered_entry."contentHash" !~ '^[0-9a-f]{64}$'
              OR ordered_entry."blobOid" !~ '^[0-9a-f]{40,64}$'
              OR NOT EXISTS (
                SELECT 1
                  FROM "ProjectSource" source_row
                 WHERE source_row."projectId" = ordered_entry."projectId"
                   AND source_row."id" = ordered_entry."projectSourceId"
                   AND source_row."kind" = 'git'
                   AND source_row."originScope" = 'project'
                   AND source_row."projectRepositoryLinkId" IS NULL
                   AND source_row."retiredAt" IS NULL
                   AND source_row."externalRef" IS NULL
                   AND source_row."contentHash" = ordered_entry."contentHash"
                   AND source_row."contentHash" = encode(public.digest(convert_to(source_row."contentText", 'UTF8'), 'sha256'), 'hex')
                   AND ordered_entry."contentBytes" = octet_length(source_row."contentText")
                   AND ordered_entry."lineCount" = CASE
                     WHEN source_row."contentText" = '' THEN 0
                     ELSE length(source_row."contentText") - length(replace(source_row."contentText", E'\n', '')) + 1
                   END
                   AND source_row."sourceIdentity" = pg_temp.project_git_publication_uuid(
                     'git-delegated-source:' || pointer_row."delegationId"::text || ':'
                     || pointer_row."delegationVersion"::text || ':'
                     || pointer_row."delegationFingerprint"::text || ':' || ordered_entry."normalizedPath"
                   )
                   AND source_row."revisionKey" = pg_temp.project_git_publication_uuid(
                     'git-delegated-revision:' || pointer_row."delegationId"::text || ':'
                     || pointer_row."delegationVersion"::text || ':'
                     || pointer_row."delegationFingerprint"::text || ':'
                     || btrim(pointer_row."frozenCommitSha") || ':' || ordered_entry."normalizedPath" || ':'
                     || ordered_entry."contentHash"
                   )
                   AND left(source_row."contentText", length(
                     'Repository: ' || run_row."repositoryPath" || E'\nRevision: '
                     || btrim(pointer_row."frozenCommitSha") || E'\nPath: '
                     || ordered_entry."normalizedPath" || E'\n\n'
                   )) = ('Repository: ' || run_row."repositoryPath" || E'\nRevision: '
                     || btrim(pointer_row."frozenCommitSha") || E'\nPath: '
                     || ordered_entry."normalizedPath" || E'\n\n')
              )
        )
        OR (
          SELECT count(*)
            FROM "ProjectGitRepositoryManualRunAudit" audit_row
           WHERE audit_row."runId" = pointer_row."runId"
             AND audit_row."action" = 'succeeded'
             AND audit_row."statusBefore" = 'running'
             AND audit_row."statusAfter" = 'succeeded'
             AND audit_row."dispatchState" = 'acknowledged'
             AND audit_row."commitSha" = pointer_row."frozenCommitSha"
             AND audit_row."manifestFingerprint" = pointer_row."manifestFingerprint"
        ) <> 1
  ) THEN
    RAISE EXCEPTION 'PROJECT_GIT_PUBLICATION_BACKFILL_INCONSISTENT_MANUAL_POINTER' USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

CREATE TYPE "ProjectGitRepositoryPublicationRunKind" AS ENUM ('manual', 'automatic');

ALTER TABLE "ProjectGitRepositoryManualRun"
  ADD COLUMN "expectedPublicationVersionId" UUID,
  ADD COLUMN "expectedPublicationGeneration" INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT "ProjectGitRepositoryManualRun_expected_publication_check" CHECK (
    "expectedPublicationGeneration" >= 0
    AND (("expectedPublicationGeneration" = 0 AND "expectedPublicationVersionId" IS NULL)
      OR ("expectedPublicationGeneration" > 0 AND "expectedPublicationVersionId" IS NOT NULL))
  );

CREATE TABLE "ProjectGitRepositoryPublicationVersion" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "projectId" UUID NOT NULL,
  "delegationId" UUID NOT NULL,
  "runKind" "ProjectGitRepositoryPublicationRunKind" NOT NULL,
  "runId" UUID NOT NULL,
  "previousPublicationVersionId" UUID,
  "previousGeneration" INTEGER NOT NULL DEFAULT 0,
  "delegationVersion" INTEGER NOT NULL,
  "delegationFingerprint" CHAR(64) NOT NULL,
  "repositoryPath" VARCHAR(768) NOT NULL,
  "trackedRef" VARCHAR(255) NOT NULL,
  "frozenCommitSha" CHAR(64) NOT NULL,
  "manifestFingerprint" CHAR(64) NOT NULL,
  "fileCount" INTEGER NOT NULL,
  "decodedTextBytes" INTEGER NOT NULL,
  "publishedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "ProjectGitRepositoryPublicationVersion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PGRPV_file_count_check" CHECK ("fileCount" > 0 AND "decodedTextBytes" >= 0),
  CONSTRAINT "PGRPV_generation_check" CHECK (
    "previousGeneration" >= 0
    AND (("previousGeneration" = 0 AND "previousPublicationVersionId" IS NULL)
      OR ("previousGeneration" > 0 AND "previousPublicationVersionId" IS NOT NULL))
  ),
  CONSTRAINT "PGRPV_fingerprint_check" CHECK (
    "delegationFingerprint" ~ '^[0-9a-f]{64}$'
    AND "manifestFingerprint" ~ '^[0-9a-f]{64}$'
    AND btrim("frozenCommitSha") ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'
  ),
  CONSTRAINT "PGRPV_project_delegation_id_key" UNIQUE ("projectId", "delegationId", "id"),
  CONSTRAINT "PGRPV_project_delegation_run_key" UNIQUE ("projectId", "delegationId", "runKind", "runId"),
  CONSTRAINT "ProjectGitRepositoryPublicationVersion_project_fkey" FOREIGN KEY ("projectId")
    REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ProjectGitRepositoryPublicationVersion_delegation_fkey" FOREIGN KEY ("delegationId")
    REFERENCES "ProjectGitRepositoryDelegation"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "PGRPV_project_delegation_published_idx"
  ON "ProjectGitRepositoryPublicationVersion"("projectId", "delegationId", "publishedAt");
CREATE INDEX "PGRPV_project_delegation_previous_idx"
  ON "ProjectGitRepositoryPublicationVersion"("projectId", "delegationId", "previousPublicationVersionId");

CREATE TABLE "ProjectGitRepositoryPublicationEntry" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "projectId" UUID NOT NULL,
  "delegationId" UUID NOT NULL,
  "publicationVersionId" UUID NOT NULL,
  "projectSourceId" UUID NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "normalizedPath" VARCHAR(1024) NOT NULL,
  "blobOid" VARCHAR(128) NOT NULL,
  "contentHash" CHAR(64) NOT NULL,
  "contentBytes" INTEGER NOT NULL,
  "lineCount" INTEGER NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProjectGitRepositoryPublicationEntry_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PGRPE_shape_check" CHECK (
    "ordinal" >= 0 AND "contentBytes" >= 0 AND "lineCount" >= 0
    AND "normalizedPath" <> ''
    AND "blobOid" ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'
    AND "contentHash" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "PGRPE_project_version_path_key" UNIQUE ("projectId", "publicationVersionId", "normalizedPath"),
  CONSTRAINT "PGRPE_project_version_ordinal_key" UNIQUE ("projectId", "publicationVersionId", "ordinal"),
  CONSTRAINT "ProjectGitRepositoryPublicationEntry_project_fkey" FOREIGN KEY ("projectId")
    REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ProjectGitRepositoryPublicationEntry_version_fkey" FOREIGN KEY ("projectId", "delegationId", "publicationVersionId")
    REFERENCES "ProjectGitRepositoryPublicationVersion"("projectId", "delegationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "ProjectGitRepositoryPublicationEntry_source_fkey" FOREIGN KEY ("projectId", "projectSourceId")
    REFERENCES "ProjectSource"("projectId", "id") ON DELETE NO ACTION ON UPDATE CASCADE
);
CREATE INDEX "PGRPE_project_source_idx"
  ON "ProjectGitRepositoryPublicationEntry"("projectId", "projectSourceId");
CREATE INDEX "PGRPE_delegation_created_idx"
  ON "ProjectGitRepositoryPublicationEntry"("delegationId", "createdAt");

CREATE TABLE "ProjectGitRepositoryPublicationHead" (
  "projectId" UUID NOT NULL,
  "delegationId" UUID NOT NULL,
  "currentPublicationVersionId" UUID NOT NULL,
  "generation" INTEGER NOT NULL DEFAULT 1,
  "publishedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "ProjectGitRepositoryPublicationHead_pkey" PRIMARY KEY ("projectId", "delegationId"),
  CONSTRAINT "PGRPH_generation_check" CHECK ("generation" > 0),
  CONSTRAINT "PGRPH_project_delegation_version_key" UNIQUE ("projectId", "delegationId", "currentPublicationVersionId"),
  CONSTRAINT "ProjectGitRepositoryPublicationHead_project_fkey" FOREIGN KEY ("projectId")
    REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ProjectGitRepositoryPublicationHead_delegation_fkey" FOREIGN KEY ("delegationId")
    REFERENCES "ProjectGitRepositoryDelegation"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ProjectGitRepositoryPublicationHead_version_fkey" FOREIGN KEY ("projectId", "delegationId", "currentPublicationVersionId")
    REFERENCES "ProjectGitRepositoryPublicationVersion"("projectId", "delegationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE
);
CREATE INDEX "PGRPH_delegation_published_idx"
  ON "ProjectGitRepositoryPublicationHead"("delegationId", "publishedAt");

CREATE TEMP TABLE publication_backfill_map AS
SELECT gen_random_uuid() AS "publicationVersionId",
       pointer_row."projectId",
       pointer_row."delegationId",
       pointer_row."runId"
  FROM "ProjectGitRepositoryManualPointer" pointer_row;

INSERT INTO "ProjectGitRepositoryPublicationVersion" (
  "id", "projectId", "delegationId", "runKind", "runId",
  "previousPublicationVersionId", "previousGeneration", "delegationVersion",
  "delegationFingerprint", "repositoryPath", "trackedRef", "frozenCommitSha",
  "manifestFingerprint", "fileCount", "decodedTextBytes", "publishedAt"
)
SELECT backfill."publicationVersionId", pointer_row."projectId", pointer_row."delegationId", 'manual',
       pointer_row."runId", NULL, 0, pointer_row."delegationVersion", pointer_row."delegationFingerprint",
       run_row."repositoryPath", run_row."trackedRef", pointer_row."frozenCommitSha",
       pointer_row."manifestFingerprint", run_row."fileCount", run_row."decodedTextBytes", pointer_row."publishedAt"
  FROM publication_backfill_map backfill
  JOIN "ProjectGitRepositoryManualPointer" pointer_row
    ON pointer_row."projectId" = backfill."projectId"
   AND pointer_row."delegationId" = backfill."delegationId"
   AND pointer_row."runId" = backfill."runId"
  JOIN "ProjectGitRepositoryManualRun" run_row ON run_row."id" = pointer_row."runId";

INSERT INTO "ProjectGitRepositoryPublicationEntry" (
  "projectId", "delegationId", "publicationVersionId", "projectSourceId",
  "ordinal", "normalizedPath", "blobOid", "contentHash", "contentBytes", "lineCount"
)
SELECT entry."projectId", entry."delegationId", backfill."publicationVersionId", entry."projectSourceId",
       entry."ordinal", entry."normalizedPath", entry."blobOid", entry."contentHash", entry."contentBytes", entry."lineCount"
  FROM publication_backfill_map backfill
  JOIN "ProjectGitRepositoryManualRunEntry" entry
    ON entry."projectId" = backfill."projectId" AND entry."runId" = backfill."runId";

INSERT INTO "ProjectGitRepositoryPublicationHead" (
  "projectId", "delegationId", "currentPublicationVersionId", "generation", "publishedAt"
)
SELECT pointer_row."projectId", pointer_row."delegationId", backfill."publicationVersionId", 1, pointer_row."publishedAt"
  FROM publication_backfill_map backfill
  JOIN "ProjectGitRepositoryManualPointer" pointer_row
    ON pointer_row."projectId" = backfill."projectId"
   AND pointer_row."delegationId" = backfill."delegationId"
   AND pointer_row."runId" = backfill."runId";

DROP TABLE publication_backfill_map;

CREATE OR REPLACE FUNCTION "project_git_repository_publication_manifest"(publication_version_uuid UUID)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  payload TEXT := 'project-git-manual-runtime:v1';
  entry_row RECORD;
BEGIN
  FOR entry_row IN
    SELECT "ordinal", "normalizedPath", "blobOid", "contentHash", "contentBytes", "lineCount"
      FROM "ProjectGitRepositoryPublicationEntry"
     WHERE "publicationVersionId" = publication_version_uuid
     ORDER BY "ordinal" ASC
  LOOP
    payload := payload || E'\n'
      || octet_length(entry_row."ordinal"::text)::text || ':' || entry_row."ordinal"::text
      || octet_length(entry_row."normalizedPath")::text || ':' || entry_row."normalizedPath"
      || octet_length(entry_row."blobOid")::text || ':' || entry_row."blobOid"
      || octet_length(entry_row."contentHash")::text || ':' || entry_row."contentHash"
      || octet_length(entry_row."contentBytes"::text)::text || ':' || entry_row."contentBytes"::text
      || octet_length(entry_row."lineCount"::text)::text || ':' || entry_row."lineCount"::text;
  END LOOP;
  RETURN encode(public.digest(convert_to(payload, 'UTF8'), 'sha256'), 'hex');
END;
$$;

CREATE OR REPLACE FUNCTION "project_git_publication_row_immutable"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'PROJECT_GIT_PUBLICATION_EVIDENCE_IMMUTABLE' USING ERRCODE = 'check_violation';
END;
$$;
CREATE TRIGGER "PGRPV_no_update_delete"
BEFORE UPDATE OR DELETE ON "ProjectGitRepositoryPublicationVersion"
FOR EACH ROW EXECUTE FUNCTION "project_git_publication_row_immutable"();
CREATE TRIGGER "PGRPV_no_truncate"
BEFORE TRUNCATE ON "ProjectGitRepositoryPublicationVersion"
FOR EACH STATEMENT EXECUTE FUNCTION "project_git_publication_row_immutable"();
CREATE TRIGGER "PGRPE_no_update_delete"
BEFORE UPDATE OR DELETE ON "ProjectGitRepositoryPublicationEntry"
FOR EACH ROW EXECUTE FUNCTION "project_git_publication_row_immutable"();
CREATE TRIGGER "PGRPE_no_truncate"
BEFORE TRUNCATE ON "ProjectGitRepositoryPublicationEntry"
FOR EACH STATEMENT EXECUTE FUNCTION "project_git_publication_row_immutable"();

CREATE OR REPLACE FUNCTION "project_git_manual_expected_publication_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW."expectedPublicationGeneration" < 0
     OR ((NEW."expectedPublicationGeneration" = 0) <> (NEW."expectedPublicationVersionId" IS NULL)) THEN
    RAISE EXCEPTION 'PROJECT_GIT_MANUAL_EXPECTED_PUBLICATION_SHAPE_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE'
     AND (OLD."expectedPublicationGeneration" IS DISTINCT FROM NEW."expectedPublicationGeneration"
       OR OLD."expectedPublicationVersionId" IS DISTINCT FROM NEW."expectedPublicationVersionId") THEN
    RAISE EXCEPTION 'PROJECT_GIT_MANUAL_EXPECTED_PUBLICATION_IMMUTABLE' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "ProjectGitRepositoryManualRun_expected_publication_guard"
BEFORE INSERT OR UPDATE ON "ProjectGitRepositoryManualRun"
FOR EACH ROW EXECUTE FUNCTION "project_git_manual_expected_publication_guard"();

CREATE OR REPLACE FUNCTION "project_git_publication_version_insert_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  head_row RECORD;
  manual_run RECORD;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('ai-project-git-repository-delegation-global', 0));
  SELECT "currentPublicationVersionId", "generation"
    INTO head_row
    FROM "ProjectGitRepositoryPublicationHead"
   WHERE "projectId" = NEW."projectId" AND "delegationId" = NEW."delegationId"
   FOR UPDATE;
  IF FOUND THEN
    IF head_row."currentPublicationVersionId" IS DISTINCT FROM NEW."previousPublicationVersionId"
       OR head_row."generation" IS DISTINCT FROM NEW."previousGeneration" THEN
      RAISE EXCEPTION 'PROJECT_GIT_PUBLICATION_HEAD_CAS_MISMATCH' USING ERRCODE = 'serialization_failure';
    END IF;
  ELSIF NEW."previousPublicationVersionId" IS NOT NULL OR NEW."previousGeneration" <> 0 THEN
    RAISE EXCEPTION 'PROJECT_GIT_PUBLICATION_HEAD_CAS_MISMATCH' USING ERRCODE = 'serialization_failure';
  END IF;
  IF NEW."runKind" = 'automatic' THEN
    RAISE EXCEPTION 'PROJECT_GIT_AUTOMATIC_PUBLICATION_NOT_ENABLED' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO manual_run
    FROM "ProjectGitRepositoryManualRun"
   WHERE "id" = NEW."runId"
     AND "projectId" = NEW."projectId"
     AND "delegationId" = NEW."delegationId";
  IF NOT FOUND
     OR manual_run."status" <> 'succeeded'
     OR manual_run."stage" <> 'terminal'
     OR manual_run."dispatchState" <> 'acknowledged'
     OR manual_run."failureCode" IS NOT NULL
     OR manual_run."delegationVersion" <> NEW."delegationVersion"
     OR manual_run."delegationFingerprint" <> NEW."delegationFingerprint"
     OR manual_run."repositoryPath" <> NEW."repositoryPath"
     OR manual_run."trackedRef" <> NEW."trackedRef"
     OR manual_run."frozenCommitSha" IS DISTINCT FROM NEW."frozenCommitSha"
     OR manual_run."manifestFingerprint" IS DISTINCT FROM NEW."manifestFingerprint"
     OR manual_run."fileCount" <> NEW."fileCount"
     OR manual_run."decodedTextBytes" <> NEW."decodedTextBytes"
     OR manual_run."completedAt" IS DISTINCT FROM NEW."publishedAt"
     OR manual_run."expectedPublicationVersionId" IS DISTINCT FROM NEW."previousPublicationVersionId"
     OR manual_run."expectedPublicationGeneration" IS DISTINCT FROM NEW."previousGeneration" THEN
    RAISE EXCEPTION 'PROJECT_GIT_PUBLICATION_MANUAL_RUN_SNAPSHOT_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "PGRPV_insert_guard"
BEFORE INSERT ON "ProjectGitRepositoryPublicationVersion"
FOR EACH ROW EXECUTE FUNCTION "project_git_publication_version_insert_guard"();

CREATE OR REPLACE FUNCTION "project_git_publication_head_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  version_row RECORD;
  previous_entry_count INTEGER;
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'TRUNCATE' OR TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'PROJECT_GIT_PUBLICATION_HEAD_IMMUTABLE' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO version_row
    FROM "ProjectGitRepositoryPublicationVersion"
   WHERE "id" = NEW."currentPublicationVersionId"
     AND "projectId" = NEW."projectId"
     AND "delegationId" = NEW."delegationId";
  IF NOT FOUND OR version_row."publishedAt" IS DISTINCT FROM NEW."publishedAt" THEN
    RAISE EXCEPTION 'PROJECT_GIT_PUBLICATION_HEAD_VERSION_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."generation" <> 1
       OR version_row."previousPublicationVersionId" IS NOT NULL
       OR version_row."previousGeneration" <> 0 THEN
      RAISE EXCEPTION 'PROJECT_GIT_PUBLICATION_HEAD_INITIAL_CURSOR_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."projectId" IS DISTINCT FROM OLD."projectId"
     OR NEW."delegationId" IS DISTINCT FROM OLD."delegationId"
     OR NEW."generation" <> OLD."generation" + 1
     OR NEW."currentPublicationVersionId" IS NOT DISTINCT FROM OLD."currentPublicationVersionId"
     OR version_row."previousPublicationVersionId" IS DISTINCT FROM OLD."currentPublicationVersionId"
     OR version_row."previousGeneration" <> OLD."generation" THEN
    RAISE EXCEPTION 'PROJECT_GIT_PUBLICATION_HEAD_CAS_MISMATCH' USING ERRCODE = 'serialization_failure';
  END IF;
  SELECT count(*)::INTEGER INTO previous_entry_count
    FROM "ProjectGitRepositoryPublicationEntry" entry
   WHERE entry."projectId" = OLD."projectId"
     AND entry."delegationId" = OLD."delegationId"
     AND entry."publicationVersionId" = OLD."currentPublicationVersionId";
  IF previous_entry_count <= 0
     OR EXISTS (
       SELECT 1
         FROM "ProjectGitRepositoryPublicationEntry" entry
         JOIN "ProjectSource" source_row
           ON source_row."projectId" = entry."projectId" AND source_row."id" = entry."projectSourceId"
        WHERE entry."projectId" = OLD."projectId"
          AND entry."delegationId" = OLD."delegationId"
          AND entry."publicationVersionId" = OLD."currentPublicationVersionId"
          AND source_row."retiredAt" IS DISTINCT FROM NEW."publishedAt"
     ) THEN
    RAISE EXCEPTION 'PROJECT_GIT_PUBLICATION_PREVIOUS_SOURCES_NOT_RETIRED' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM "ProjectGitRepositoryPublicationEntry" entry
      JOIN "ProjectSource" source_row
        ON source_row."projectId" = entry."projectId" AND source_row."id" = entry."projectSourceId"
     WHERE entry."projectId" = NEW."projectId"
       AND entry."delegationId" = NEW."delegationId"
       AND entry."publicationVersionId" = NEW."currentPublicationVersionId"
       AND source_row."retiredAt" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'PROJECT_GIT_PUBLICATION_NEW_SOURCES_NOT_ACTIVE' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "ProjectGitRepositoryPublicationHead_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "ProjectGitRepositoryPublicationHead"
FOR EACH ROW EXECUTE FUNCTION "project_git_publication_head_guard"();
CREATE TRIGGER "ProjectGitRepositoryPublicationHead_no_truncate"
BEFORE TRUNCATE ON "ProjectGitRepositoryPublicationHead"
FOR EACH STATEMENT EXECUTE FUNCTION "project_git_publication_head_guard"();

CREATE OR REPLACE FUNCTION "project_git_publication_version_required"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  version_row RECORD;
  entry_count INTEGER;
  entry_bytes BIGINT;
  entry_ordinals_valid BOOLEAN;
  source_count INTEGER;
  source_values_valid BOOLEAN;
  head_count INTEGER;
  head_valid BOOLEAN;
  manual_entry_count INTEGER;
  manual_entry_values_valid BOOLEAN;
  manual_audit_count INTEGER;
  manual_audit_valid BOOLEAN;
  manual_pointer_count INTEGER;
  manual_pointer_valid BOOLEAN;
BEGIN
  SELECT * INTO version_row
    FROM "ProjectGitRepositoryPublicationVersion"
   WHERE "id" = NEW."id"
     AND "projectId" = NEW."projectId"
     AND "delegationId" = NEW."delegationId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROJECT_GIT_PUBLICATION_VERSION_MISSING' USING ERRCODE = 'check_violation';
  END IF;
  WITH ordered_entries AS (
    SELECT entry.*, row_number() OVER (ORDER BY entry."ordinal") - 1 AS expected_ordinal
      FROM "ProjectGitRepositoryPublicationEntry" entry
     WHERE entry."projectId" = NEW."projectId"
       AND entry."delegationId" = NEW."delegationId"
       AND entry."publicationVersionId" = NEW."id"
  )
  SELECT count(*)::INTEGER,
         COALESCE(sum("contentBytes"), 0)::BIGINT,
         COALESCE(bool_and("ordinal" = expected_ordinal), false)
    INTO entry_count, entry_bytes, entry_ordinals_valid
    FROM ordered_entries;
  IF entry_count <> version_row."fileCount"
     OR entry_count <= 0
     OR entry_bytes <> version_row."decodedTextBytes"
     OR NOT entry_ordinals_valid
     OR "project_git_repository_publication_manifest"(NEW."id") IS DISTINCT FROM version_row."manifestFingerprint" THEN
    RAISE EXCEPTION 'PROJECT_GIT_PUBLICATION_VERSION_ENTRIES_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*)::INTEGER,
         COALESCE(bool_and(
           source_row."kind" = 'git'
           AND source_row."originScope" = 'project'
           AND source_row."projectRepositoryLinkId" IS NULL
           AND source_row."retiredAt" IS NULL
           AND source_row."externalRef" IS NULL
           AND source_row."contentHash" = entry."contentHash"
           AND source_row."contentHash" = encode(public.digest(convert_to(source_row."contentText", 'UTF8'), 'sha256'), 'hex')
           AND entry."contentBytes" = octet_length(source_row."contentText")
           AND entry."lineCount" = CASE
             WHEN source_row."contentText" = '' THEN 0
             ELSE length(source_row."contentText") - length(replace(source_row."contentText", E'\n', '')) + 1
           END
           AND left(source_row."contentText", length(
             'Repository: ' || version_row."repositoryPath" || E'\nRevision: '
             || btrim(version_row."frozenCommitSha") || E'\nPath: '
             || entry."normalizedPath" || E'\n\n'
           )) = ('Repository: ' || version_row."repositoryPath" || E'\nRevision: '
             || btrim(version_row."frozenCommitSha") || E'\nPath: '
             || entry."normalizedPath" || E'\n\n')
         ), false)
    INTO source_count, source_values_valid
    FROM "ProjectGitRepositoryPublicationEntry" entry
    JOIN "ProjectSource" source_row
      ON source_row."projectId" = entry."projectId" AND source_row."id" = entry."projectSourceId"
   WHERE entry."projectId" = NEW."projectId"
     AND entry."delegationId" = NEW."delegationId"
     AND entry."publicationVersionId" = NEW."id";
  IF source_count <> entry_count OR NOT source_values_valid THEN
    RAISE EXCEPTION 'PROJECT_GIT_PUBLICATION_VERSION_SOURCES_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*)::INTEGER,
         COALESCE(bool_and(
           head."currentPublicationVersionId" = NEW."id"
           AND head."generation" = version_row."previousGeneration" + 1
           AND head."publishedAt" = version_row."publishedAt"
         ), false)
    INTO head_count, head_valid
    FROM "ProjectGitRepositoryPublicationHead" head
   WHERE head."projectId" = NEW."projectId" AND head."delegationId" = NEW."delegationId";
  IF head_count <> 1 OR NOT head_valid THEN
    RAISE EXCEPTION 'PROJECT_GIT_PUBLICATION_VERSION_HEAD_REQUIRED' USING ERRCODE = 'check_violation';
  END IF;
  IF version_row."runKind" = 'automatic' THEN
    RAISE EXCEPTION 'PROJECT_GIT_AUTOMATIC_PUBLICATION_NOT_ENABLED' USING ERRCODE = 'check_violation';
  END IF;

  SELECT count(*)::INTEGER,
         COALESCE(bool_and(
           manual_entry."delegationVersion" = version_row."delegationVersion"
           AND manual_entry."delegationFingerprint" = version_row."delegationFingerprint"
           AND manual_entry."projectSourceId" = publication_entry."projectSourceId"
           AND manual_entry."ordinal" = publication_entry."ordinal"
           AND manual_entry."normalizedPath" = publication_entry."normalizedPath"
           AND manual_entry."blobOid" = publication_entry."blobOid"
           AND manual_entry."contentHash" = publication_entry."contentHash"
           AND manual_entry."contentBytes" = publication_entry."contentBytes"
           AND manual_entry."lineCount" = publication_entry."lineCount"
         ), false)
    INTO manual_entry_count, manual_entry_values_valid
    FROM "ProjectGitRepositoryManualRunEntry" manual_entry
    JOIN "ProjectGitRepositoryPublicationEntry" publication_entry
      ON publication_entry."projectId" = manual_entry."projectId"
     AND publication_entry."projectSourceId" = manual_entry."projectSourceId"
     AND publication_entry."publicationVersionId" = NEW."id"
   WHERE manual_entry."projectId" = NEW."projectId"
     AND manual_entry."runId" = version_row."runId";
  IF manual_entry_count <> entry_count OR NOT manual_entry_values_valid THEN
    RAISE EXCEPTION 'PROJECT_GIT_PUBLICATION_MANUAL_ENTRIES_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*)::INTEGER,
         COALESCE(bool_and(
           audit_row."statusBefore" = 'running'
           AND audit_row."statusAfter" = 'succeeded'
           AND audit_row."dispatchState" = 'acknowledged'
           AND audit_row."commitSha" = version_row."frozenCommitSha"
           AND audit_row."manifestFingerprint" = version_row."manifestFingerprint"
         ), false)
    INTO manual_audit_count, manual_audit_valid
    FROM "ProjectGitRepositoryManualRunAudit" audit_row
   WHERE audit_row."runId" = version_row."runId" AND audit_row."action" = 'succeeded';
  IF manual_audit_count <> 1 OR NOT manual_audit_valid THEN
    RAISE EXCEPTION 'PROJECT_GIT_PUBLICATION_MANUAL_AUDIT_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*)::INTEGER,
         COALESCE(bool_and(
           pointer_row."runId" = version_row."runId"
           AND pointer_row."delegationVersion" = version_row."delegationVersion"
           AND pointer_row."delegationFingerprint" = version_row."delegationFingerprint"
           AND pointer_row."frozenCommitSha" = version_row."frozenCommitSha"
           AND pointer_row."manifestFingerprint" = version_row."manifestFingerprint"
           AND pointer_row."publishedAt" = version_row."publishedAt"
         ), false)
    INTO manual_pointer_count, manual_pointer_valid
    FROM "ProjectGitRepositoryManualPointer" pointer_row
   WHERE pointer_row."projectId" = version_row."projectId"
     AND pointer_row."delegationId" = version_row."delegationId";
  IF manual_pointer_count <> 1 OR NOT manual_pointer_valid THEN
    RAISE EXCEPTION 'PROJECT_GIT_PUBLICATION_MANUAL_POINTER_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER "ProjectGitRepositoryPublicationVersion_required"
AFTER INSERT ON "ProjectGitRepositoryPublicationVersion"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "project_git_publication_version_required"();

CREATE OR REPLACE FUNCTION "project_git_manual_publication_success_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  publication_count INTEGER;
  publication_valid BOOLEAN;
BEGIN
  IF NEW."status" <> 'succeeded' THEN
    RETURN NEW;
  END IF;
  SELECT count(*)::INTEGER,
         COALESCE(bool_and(
           version_row."runKind" = 'manual'
           AND version_row."runId" = NEW."id"
           AND version_row."projectId" = NEW."projectId"
           AND version_row."delegationId" = NEW."delegationId"
           AND version_row."delegationVersion" = NEW."delegationVersion"
           AND version_row."delegationFingerprint" = NEW."delegationFingerprint"
           AND version_row."repositoryPath" = NEW."repositoryPath"
           AND version_row."trackedRef" = NEW."trackedRef"
           AND version_row."frozenCommitSha" = NEW."frozenCommitSha"
           AND version_row."manifestFingerprint" = NEW."manifestFingerprint"
           AND version_row."fileCount" = NEW."fileCount"
           AND version_row."decodedTextBytes" = NEW."decodedTextBytes"
           AND version_row."publishedAt" = NEW."completedAt"
           AND version_row."previousPublicationVersionId" IS NOT DISTINCT FROM NEW."expectedPublicationVersionId"
           AND version_row."previousGeneration" = NEW."expectedPublicationGeneration"
           AND head."currentPublicationVersionId" = version_row."id"
           AND head."generation" = NEW."expectedPublicationGeneration" + 1
           AND head."publishedAt" = version_row."publishedAt"
         ), false)
    INTO publication_count, publication_valid
    FROM "ProjectGitRepositoryPublicationVersion" version_row
    JOIN "ProjectGitRepositoryPublicationHead" head
      ON head."projectId" = version_row."projectId"
     AND head."delegationId" = version_row."delegationId"
     AND head."currentPublicationVersionId" = version_row."id"
   WHERE version_row."runKind" = 'manual'
     AND version_row."runId" = NEW."id"
     AND version_row."projectId" = NEW."projectId"
     AND version_row."delegationId" = NEW."delegationId";
  IF publication_count <> 1 OR NOT publication_valid THEN
    RAISE EXCEPTION 'PROJECT_GIT_MANUAL_PUBLICATION_HEAD_REQUIRED' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER "ProjectGitRepositoryManualRun_publication_success_guard"
AFTER UPDATE OF "status" ON "ProjectGitRepositoryManualRun"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW WHEN (NEW."status" = 'succeeded')
EXECUTE FUNCTION "project_git_manual_publication_success_guard"();

-- The unchanged outcome still enforces the original account, connection,
-- membership, source and audit fences. Only its baseline source changes from
-- the manual-only pointer/entry tables to the shared publication head.
CREATE OR REPLACE FUNCTION "project_git_manual_runtime_unchanged_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  publication_row RECORD;
  head_count INTEGER;
  head_valid BOOLEAN;
  entry_count INTEGER;
  entry_bytes BIGINT;
  entry_ordinals_valid BOOLEAN;
  source_count INTEGER;
  source_values_valid BOOLEAN;
  evidence_valid BOOLEAN;
  audit_count INTEGER;
  audit_valid BOOLEAN;
BEGIN
  IF NEW."status"::text <> 'unchanged' THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('ai-project-git-repository-delegation-global', 0));

  IF NEW."stage" <> 'terminal'
     OR NEW."dispatchState" <> 'acknowledged'
     OR NEW."completedAt" IS NULL
     OR NEW."failureCode" IS NOT NULL
     OR NEW."result" IS DISTINCT FROM jsonb_build_object('outcome', 'unchanged')
     OR NEW."baselineRunId" IS NULL
     OR NEW."baselinePublishedAt" IS NULL
     OR NEW."expectedPublicationVersionId" IS NULL
     OR NEW."expectedPublicationGeneration" <= 0
     OR NEW."frozenCommitSha" IS DISTINCT FROM NEW."baselineFrozenCommitSha"
     OR NEW."manifestFingerprint" IS DISTINCT FROM NEW."baselineManifestFingerprint"
     OR NEW."fileCount" <> 0
     OR NEW."decodedTextBytes" <> 0 THEN
    RAISE EXCEPTION 'PROJECT_GIT_MANUAL_UNCHANGED_INTEGRITY_INVALID' USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO publication_row
    FROM "ProjectGitRepositoryPublicationVersion" version_row
   WHERE version_row."id" = NEW."expectedPublicationVersionId"
     AND version_row."projectId" = NEW."projectId"
     AND version_row."delegationId" = NEW."delegationId"
     AND version_row."runId" = NEW."baselineRunId"
     AND version_row."delegationVersion" = NEW."delegationVersion"
     AND version_row."delegationFingerprint" = NEW."delegationFingerprint"
     AND version_row."repositoryPath" = NEW."repositoryPath"
     AND version_row."trackedRef" = NEW."trackedRef"
     AND version_row."frozenCommitSha" = NEW."baselineFrozenCommitSha"
     AND version_row."manifestFingerprint" = NEW."baselineManifestFingerprint"
     AND version_row."publishedAt" = NEW."baselinePublishedAt"
     AND version_row."fileCount" > 0;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROJECT_GIT_MANUAL_UNCHANGED_BASELINE_INVALID' USING ERRCODE = 'check_violation';
  END IF;

  SELECT count(*)::INTEGER,
         COALESCE(bool_and(
           head."currentPublicationVersionId" = NEW."expectedPublicationVersionId"
           AND head."generation" = NEW."expectedPublicationGeneration"
           AND head."publishedAt" = publication_row."publishedAt"
         ), false)
    INTO head_count, head_valid
    FROM "ProjectGitRepositoryPublicationHead" head
   WHERE head."projectId" = NEW."projectId" AND head."delegationId" = NEW."delegationId";
  IF head_count <> 1 OR NOT head_valid THEN
    RAISE EXCEPTION 'PROJECT_GIT_MANUAL_UNCHANGED_PUBLICATION_HEAD_DRIFTED' USING ERRCODE = 'check_violation';
  END IF;

  WITH ordered_entries AS (
    SELECT entry.*, row_number() OVER (ORDER BY entry."ordinal") - 1 AS expected_ordinal
      FROM "ProjectGitRepositoryPublicationEntry" entry
     WHERE entry."projectId" = NEW."projectId"
       AND entry."delegationId" = NEW."delegationId"
       AND entry."publicationVersionId" = NEW."expectedPublicationVersionId"
  )
  SELECT count(*)::INTEGER,
         COALESCE(sum("contentBytes"), 0)::BIGINT,
         COALESCE(bool_and("ordinal" = expected_ordinal), false)
    INTO entry_count, entry_bytes, entry_ordinals_valid
    FROM ordered_entries;
  IF entry_count <> publication_row."fileCount"
     OR entry_count <= 0
     OR entry_bytes <> publication_row."decodedTextBytes"
     OR NOT entry_ordinals_valid THEN
    RAISE EXCEPTION 'PROJECT_GIT_MANUAL_UNCHANGED_BASELINE_ENTRIES_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*)::INTEGER,
         COALESCE(bool_and(
           source_row."kind" = 'git'
           AND source_row."originScope" = 'project'
           AND source_row."projectRepositoryLinkId" IS NULL
           AND source_row."retiredAt" IS NULL
           AND source_row."contentHash" = entry."contentHash"
           AND source_row."contentHash" = encode(public.digest(convert_to(source_row."contentText", 'UTF8'), 'sha256'), 'hex')
           AND source_row."externalRef" IS NULL
           AND entry."contentBytes" = octet_length(source_row."contentText")
           AND entry."lineCount" = CASE
             WHEN source_row."contentText" = '' THEN 0
             ELSE length(source_row."contentText") - length(replace(source_row."contentText", E'\n', '')) + 1
           END
           AND left(source_row."contentText", length(
             'Repository: ' || publication_row."repositoryPath" || E'\nRevision: '
             || btrim(publication_row."frozenCommitSha") || E'\nPath: '
             || entry."normalizedPath" || E'\n\n'
           )) = ('Repository: ' || publication_row."repositoryPath" || E'\nRevision: '
             || btrim(publication_row."frozenCommitSha") || E'\nPath: '
             || entry."normalizedPath" || E'\n\n')
         ), false)
    INTO source_count, source_values_valid
    FROM "ProjectGitRepositoryPublicationEntry" entry
    JOIN "ProjectSource" source_row
      ON source_row."projectId" = entry."projectId" AND source_row."id" = entry."projectSourceId"
   WHERE entry."projectId" = NEW."projectId"
     AND entry."delegationId" = NEW."delegationId"
     AND entry."publicationVersionId" = NEW."expectedPublicationVersionId";
  IF source_count <> entry_count OR NOT source_values_valid
     OR "project_git_repository_publication_manifest"(NEW."expectedPublicationVersionId") IS DISTINCT FROM NEW."baselineManifestFingerprint" THEN
    RAISE EXCEPTION 'PROJECT_GIT_MANUAL_UNCHANGED_BASELINE_SOURCES_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "ProjectGitRepositoryManualRunEntry" entry WHERE entry."runId" = NEW."id"
  ) THEN
    RAISE EXCEPTION 'PROJECT_GIT_MANUAL_UNCHANGED_RUN_HAS_ENTRIES' USING ERRCODE = 'check_violation';
  END IF;

  SELECT EXISTS (
    SELECT 1
      FROM "Project" project_row
      JOIN "ProjectGitRepositoryDelegation" delegation
        ON delegation."id" = NEW."delegationId" AND delegation."projectId" = project_row."id"
      JOIN "GitConnection" connection_row ON connection_row."id" = delegation."gitConnectionId"
      JOIN "ExternalCredential" credential_row ON credential_row."id" = connection_row."credentialId"
      JOIN "AppUser" requester ON requester."id" = NEW."requestedById"
      JOIN "AppUser" owner_user ON owner_user."id" = delegation."connectionOwnerId"
      JOIN "AppUser" confirmer ON confirmer."id" = delegation."projectConfirmedById"
      JOIN "ProjectMembership" requester_membership ON requester_membership."id" = NEW."requestedByProjectMembershipId"
      JOIN "ProjectMembership" owner_membership ON owner_membership."id" = delegation."ownerProjectMembershipId"
      JOIN "ProjectMembership" confirmer_membership ON confirmer_membership."id" = delegation."projectConfirmedProjectMembershipId"
     WHERE project_row."id" = NEW."projectId"
       AND project_row."archivedAt" IS NULL
       AND delegation."status" = 'active'
       AND delegation."manualSyncAllowed" IS TRUE
       AND delegation."expiresAt" > clock_timestamp()
       AND delegation."version" = NEW."delegationVersion"
       AND delegation."delegationFingerprint" = NEW."delegationFingerprint"
       AND delegation."connectionOwnerId" = NEW."connectionOwnerId"
       AND delegation."ownerProjectMembershipId" = NEW."ownerProjectMembershipId"
       AND delegation."ownerMembershipCreatedAt" = NEW."ownerMembershipCreatedAt"
       AND delegation."projectConfirmedById" = NEW."projectConfirmedById"
       AND delegation."projectConfirmedProjectMembershipId" = NEW."projectConfirmedProjectMembershipId"
       AND delegation."projectConfirmedMembershipCreatedAt" = NEW."projectConfirmedMembershipCreatedAt"
       AND delegation."connectionConfigurationVersion" = NEW."connectionConfigurationVersion"
       AND delegation."resolvedAddressFingerprint" = NEW."resolvedAddressFingerprint"
       AND delegation."credentialFingerprint" = NEW."credentialFingerprint"
       AND delegation."repositoryPath" = NEW."repositoryPath"
       AND delegation."trackedRef" = NEW."trackedRef"
       AND delegation."includeRoots" = NEW."includeRoots"
       AND delegation."softExcludePatterns" = NEW."softExcludePatterns"
       AND delegation."role" = NEW."role"
       AND delegation."requiredForProjectSnapshot" = NEW."requiredForProjectSnapshot"
       AND delegation."codeEnabled" = NEW."codeEnabled"
       AND delegation."metadataEnabled" = NEW."metadataEnabled"
       AND delegation."manualSyncAllowed" = NEW."manualSyncAllowed"
       AND delegation."automationAllowed" = NEW."automationAllowed"
       AND connection_row."ownerUserId" = delegation."connectionOwnerId"
       AND connection_row."ownerAccountAccessVersion" = NEW."connectionOwnerAccountAccessVersion"
       AND connection_row."ownershipState" = 'confirmed'
       AND connection_row."status" = 'verified'
       AND connection_row."configurationVersion" = NEW."connectionConfigurationVersion"
       AND connection_row."resolvedAddressFingerprint" = NEW."resolvedAddressFingerprint"
       AND credential_row."kind" = 'git'
       AND credential_row."secretFingerprint" = NEW."credentialFingerprint"
       AND requester."disabledAt" IS NULL
       AND requester."accountAccessVersion" = NEW."requestedByAccountAccessVersion"
       AND owner_user."disabledAt" IS NULL
       AND owner_user."accountAccessVersion" = NEW."connectionOwnerAccountAccessVersion"
       AND confirmer."disabledAt" IS NULL
       AND requester_membership."projectId" = NEW."projectId"
       AND requester_membership."userId" = NEW."requestedById"
       AND requester_membership."role" IN ('owner', 'editor')
       AND requester_membership."accessState" = 'confirmed'
       AND requester_membership."createdAt" = NEW."requestedByMembershipCreatedAt"
       AND owner_membership."projectId" = NEW."projectId"
       AND owner_membership."userId" = NEW."connectionOwnerId"
       AND owner_membership."role" IN ('owner', 'editor')
       AND owner_membership."accessState" = 'confirmed'
       AND owner_membership."createdAt" = NEW."ownerMembershipCreatedAt"
       AND confirmer_membership."projectId" = NEW."projectId"
       AND confirmer_membership."userId" = NEW."projectConfirmedById"
       AND confirmer_membership."role" = 'owner'
       AND confirmer_membership."accessState" = 'confirmed'
       AND confirmer_membership."createdAt" = NEW."projectConfirmedMembershipCreatedAt"
  ) INTO evidence_valid;
  IF NOT evidence_valid THEN
    RAISE EXCEPTION 'PROJECT_GIT_MANUAL_UNCHANGED_EVIDENCE_STALE' USING ERRCODE = 'check_violation';
  END IF;

  SELECT count(*)::INTEGER,
         COALESCE(bool_and(
           audit_row."statusBefore" = 'running'
           AND audit_row."statusAfter"::text = 'unchanged'
           AND audit_row."dispatchState" = 'acknowledged'
           AND audit_row."actorId" = NEW."requestedById"
           AND audit_row."reason" = 'manual_sync_remote_head_unchanged'
           AND audit_row."commitSha" = NEW."frozenCommitSha"
           AND audit_row."manifestFingerprint" = NEW."manifestFingerprint"
           AND audit_row."transactionId" = txid_current()
         ), false)
    INTO audit_count, audit_valid
    FROM "ProjectGitRepositoryManualRunAudit" audit_row
   WHERE audit_row."runId" = NEW."id" AND audit_row."action"::text = 'unchanged';
  IF audit_count <> 1 OR NOT audit_valid THEN
    RAISE EXCEPTION 'PROJECT_GIT_MANUAL_UNCHANGED_AUDIT_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON TABLE public."ProjectGitRepositoryPublicationVersion",
                    public."ProjectGitRepositoryPublicationEntry",
                    public."ProjectGitRepositoryPublicationHead"
  FROM PUBLIC;

REVOKE ALL ON FUNCTION public."project_git_repository_publication_manifest"(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public."project_git_publication_row_immutable"() FROM PUBLIC;
REVOKE ALL ON FUNCTION public."project_git_manual_expected_publication_guard"() FROM PUBLIC;
REVOKE ALL ON FUNCTION public."project_git_publication_version_insert_guard"() FROM PUBLIC;
REVOKE ALL ON FUNCTION public."project_git_publication_head_guard"() FROM PUBLIC;
REVOKE ALL ON FUNCTION public."project_git_publication_version_required"() FROM PUBLIC;
REVOKE ALL ON FUNCTION public."project_git_manual_publication_success_guard"() FROM PUBLIC;
REVOKE ALL ON FUNCTION public."project_git_manual_runtime_unchanged_guard"() FROM PUBLIC;
