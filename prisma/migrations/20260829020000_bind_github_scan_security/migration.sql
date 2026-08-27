-- AlterTable
ALTER TABLE "ProjectScanBatch"
ADD COLUMN "expectedActiveCodeSnapshotId" UUID;

-- AlterTable
ALTER TABLE "RepositoryCodeGeneration"
ADD COLUMN "modelTransferScanResult" "AiSafeScanResult" NOT NULL DEFAULT 'unavailable',
ADD COLUMN "securityFindingManifest" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN "securityFindingCount" INTEGER NOT NULL DEFAULT 0;

-- Scanner policy is part of immutable revision identity. The same Git blob can
-- be revalidated by a newer scanner without mutating prior evidence.
DROP INDEX "RepositoryFileRevision_projectId_projectRepositoryLinkId_re_key";

CREATE UNIQUE INDEX "RepositoryFileRevision_blob_scanner_key"
ON "RepositoryFileRevision"(
  "projectId",
  "projectRepositoryLinkId",
  "repositoryFileId",
  "blobOid",
  "scannerFingerprint"
);

CREATE INDEX "ProjectScanBatch_projectId_expectedActiveCodeSnapshotId_idx"
ON "ProjectScanBatch"("projectId", "expectedActiveCodeSnapshotId");

CREATE UNIQUE INDEX "RepoCodeScanRun_batch_link_key"
ON "RepoCodeScanRun"("projectId", "projectScanBatchId", "projectRepositoryLinkId");

ALTER TABLE "ProjectScanBatch"
ADD CONSTRAINT "ProjectScanBatch_expected_snapshot_fkey"
FOREIGN KEY ("projectId", "expectedActiveCodeSnapshotId")
REFERENCES "ProjectCodeSnapshot"("projectId", "id")
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "RepositoryCodeGeneration"
ADD CONSTRAINT "RepositoryCodeGeneration_security_scan_check"
CHECK (
  "securityFindingCount" >= 0
  AND jsonb_typeof("securityFindingManifest") = 'array'
  AND jsonb_array_length("securityFindingManifest") = "securityFindingCount"
  AND (
    ("modelTransferScanResult" = 'passed' AND "securityFindingCount" = 0)
    OR ("modelTransferScanResult" = 'blocked' AND "securityFindingCount" > 0)
    OR ("modelTransferScanResult" = 'unavailable' AND "securityFindingCount" = 0)
  )
);

CREATE FUNCTION "guard_repo_code_scan_run_update"()
RETURNS TRIGGER AS $$
BEGIN
  IF ROW(
    NEW."id", NEW."projectId", NEW."projectRepositoryLinkId",
    NEW."projectScanBatchId", NEW."linkConfigVersion",
    NEW."expectedEffectivePolicyVersion", NEW."expectedActiveGenerationId",
    NEW."operationKey", NEW."startedAt"
  ) IS DISTINCT FROM ROW(
    OLD."id", OLD."projectId", OLD."projectRepositoryLinkId",
    OLD."projectScanBatchId", OLD."linkConfigVersion",
    OLD."expectedEffectivePolicyVersion", OLD."expectedActiveGenerationId",
    OLD."operationKey", OLD."startedAt"
  ) THEN
    RAISE EXCEPTION 'GITHUB_SCAN_RUN_IMMUTABLE_FIELD' USING ERRCODE = '23514';
  END IF;

  IF NEW."requestCount" < OLD."requestCount"
     OR NEW."visitedTreeEntryCount" < OLD."visitedTreeEntryCount"
     OR NEW."discoveredFileCount" < OLD."discoveredFileCount"
     OR NEW."decodedTextBytes" < OLD."decodedTextBytes"
     OR (OLD."frozenCommitSha" IS NOT NULL AND NEW."frozenCommitSha" IS DISTINCT FROM OLD."frozenCommitSha")
     OR (OLD."rootTreeSha" IS NOT NULL AND NEW."rootTreeSha" IS DISTINCT FROM OLD."rootTreeSha") THEN
    RAISE EXCEPTION 'GITHUB_SCAN_RUN_PROGRESS_REGRESSION' USING ERRCODE = '23514';
  END IF;

  IF OLD."status" = 'queued' AND NEW."status" NOT IN ('running', 'failed', 'cancelled') THEN
    RAISE EXCEPTION 'GITHUB_SCAN_RUN_INVALID_TRANSITION' USING ERRCODE = '23514';
  ELSIF OLD."status" = 'running' AND NEW."status" NOT IN (
    'running', 'succeeded', 'failed', 'rate_limited', 'unknown', 'cancelled'
  ) THEN
    RAISE EXCEPTION 'GITHUB_SCAN_RUN_INVALID_TRANSITION' USING ERRCODE = '23514';
  ELSIF OLD."status" = 'unknown' AND NEW."status" NOT IN (
    'succeeded', 'failed', 'cancelled'
  ) THEN
    RAISE EXCEPTION 'GITHUB_SCAN_RUN_INVALID_TRANSITION' USING ERRCODE = '23514';
  ELSIF OLD."status" IN ('succeeded', 'failed', 'rate_limited', 'cancelled') THEN
    RAISE EXCEPTION 'GITHUB_SCAN_RUN_TERMINAL' USING ERRCODE = '23514';
  END IF;

  IF (NEW."status" = 'queued' AND NEW."stage" <> 'queued')
     OR (NEW."status" = 'running' AND NEW."stage" NOT IN (
       'discovering', 'fetching', 'scanning', 'publishing'
     ))
     OR (NEW."status" IN ('succeeded', 'failed', 'rate_limited', 'unknown', 'cancelled')
       AND NEW."stage" <> 'terminal')
     OR (NEW."status" = 'rate_limited' AND NEW."retryAt" IS NULL)
     OR (NEW."status" <> 'rate_limited' AND NEW."retryAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'GITHUB_SCAN_RUN_STATE_INTEGRITY' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "RepoCodeScanRun_guard_update"
BEFORE UPDATE ON "RepoCodeScanRun"
FOR EACH ROW EXECUTE FUNCTION "guard_repo_code_scan_run_update"();

CREATE FUNCTION "guard_repository_code_generation_update"()
RETURNS TRIGGER AS $$
BEGIN
  IF ROW(
    NEW."id", NEW."projectId", NEW."projectRepositoryLinkId",
    NEW."linkConfigVersion", NEW."repoCodeScanRunId", NEW."generationKey",
    NEW."capturedGitHubRepositoryId", NEW."capturedFullName",
    NEW."frozenCommitSha", NEW."rootTreeSha", NEW."scanScopeFingerprint",
    NEW."scannerVersion", NEW."scannerFingerprint", NEW."effectivePolicyVersion",
    NEW."manifestFingerprint", NEW."exclusionManifest",
    NEW."modelTransferScanResult", NEW."securityFindingManifest",
    NEW."securityFindingCount", NEW."fileCount", NEW."decodedTextBytes",
    NEW."createdAt"
  ) IS DISTINCT FROM ROW(
    OLD."id", OLD."projectId", OLD."projectRepositoryLinkId",
    OLD."linkConfigVersion", OLD."repoCodeScanRunId", OLD."generationKey",
    OLD."capturedGitHubRepositoryId", OLD."capturedFullName",
    OLD."frozenCommitSha", OLD."rootTreeSha", OLD."scanScopeFingerprint",
    OLD."scannerVersion", OLD."scannerFingerprint", OLD."effectivePolicyVersion",
    OLD."manifestFingerprint", OLD."exclusionManifest",
    OLD."modelTransferScanResult", OLD."securityFindingManifest",
    OLD."securityFindingCount", OLD."fileCount", OLD."decodedTextBytes",
    OLD."createdAt"
  ) THEN
    RAISE EXCEPTION 'GITHUB_CODE_GENERATION_IMMUTABLE_FIELD' USING ERRCODE = '23514';
  END IF;

  IF OLD."status" = 'staging' AND NEW."status" NOT IN (
    'code_ready', 'failed', 'ineligible'
  ) THEN
    RAISE EXCEPTION 'GITHUB_CODE_GENERATION_INVALID_TRANSITION' USING ERRCODE = '23514';
  ELSIF OLD."status" = 'code_ready' AND NEW."status" NOT IN (
    'superseded', 'ineligible'
  ) THEN
    RAISE EXCEPTION 'GITHUB_CODE_GENERATION_INVALID_TRANSITION' USING ERRCODE = '23514';
  ELSIF OLD."status" IN ('failed', 'ineligible', 'superseded') THEN
    RAISE EXCEPTION 'GITHUB_CODE_GENERATION_TERMINAL' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "RepositoryCodeGeneration_guard_update"
BEFORE UPDATE ON "RepositoryCodeGeneration"
FOR EACH ROW EXECUTE FUNCTION "guard_repository_code_generation_update"();

CREATE FUNCTION "guard_project_scan_batch_update"()
RETURNS TRIGGER AS $$
BEGIN
  IF ROW(
    NEW."id", NEW."projectId", NEW."expectedActiveCodeSnapshotId",
    NEW."requiredManifestFingerprint", NEW."expectedRequiredLinkCount",
    NEW."expectedOptionalLinkCount", NEW."startedAt"
  ) IS DISTINCT FROM ROW(
    OLD."id", OLD."projectId", OLD."expectedActiveCodeSnapshotId",
    OLD."requiredManifestFingerprint", OLD."expectedRequiredLinkCount",
    OLD."expectedOptionalLinkCount", OLD."startedAt"
  ) OR NEW."completedRequiredLinkCount" < OLD."completedRequiredLinkCount"
     OR NEW."completedOptionalLinkCount" < OLD."completedOptionalLinkCount" THEN
    RAISE EXCEPTION 'PROJECT_SCAN_BATCH_IMMUTABLE_FIELD' USING ERRCODE = '23514';
  END IF;

  IF OLD."status" = 'queued' AND NEW."status" NOT IN (
    'running', 'succeeded', 'partial', 'partial_optional', 'failed', 'unknown', 'cancelled'
  ) THEN
    RAISE EXCEPTION 'PROJECT_SCAN_BATCH_INVALID_TRANSITION' USING ERRCODE = '23514';
  ELSIF OLD."status" = 'running' AND NEW."status" NOT IN (
    'running', 'succeeded', 'partial', 'partial_optional', 'failed', 'unknown', 'cancelled'
  ) THEN
    RAISE EXCEPTION 'PROJECT_SCAN_BATCH_INVALID_TRANSITION' USING ERRCODE = '23514';
  ELSIF OLD."status" = 'unknown' AND NEW."status" NOT IN (
    'succeeded', 'partial', 'partial_optional', 'failed', 'cancelled'
  ) THEN
    RAISE EXCEPTION 'PROJECT_SCAN_BATCH_INVALID_TRANSITION' USING ERRCODE = '23514';
  ELSIF OLD."status" IN ('succeeded', 'partial', 'partial_optional', 'failed', 'cancelled') THEN
    RAISE EXCEPTION 'PROJECT_SCAN_BATCH_TERMINAL' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ProjectScanBatch_guard_update"
BEFORE UPDATE ON "ProjectScanBatch"
FOR EACH ROW EXECUTE FUNCTION "guard_project_scan_batch_update"();

CREATE FUNCTION "guard_project_code_snapshot_update"()
RETURNS TRIGGER AS $$
BEGIN
  IF ROW(
    NEW."id", NEW."projectId", NEW."projectScanBatchId",
    NEW."manifestFingerprint", NEW."requiredLinkCount", NEW."createdAt"
  ) IS DISTINCT FROM ROW(
    OLD."id", OLD."projectId", OLD."projectScanBatchId",
    OLD."manifestFingerprint", OLD."requiredLinkCount", OLD."createdAt"
  ) THEN
    RAISE EXCEPTION 'PROJECT_CODE_SNAPSHOT_IMMUTABLE_FIELD' USING ERRCODE = '23514';
  END IF;

  IF OLD."status" = 'staging' AND NEW."status" NOT IN ('complete', 'ineligible') THEN
    RAISE EXCEPTION 'PROJECT_CODE_SNAPSHOT_INVALID_TRANSITION' USING ERRCODE = '23514';
  ELSIF OLD."status" = 'complete' AND NEW."status" NOT IN ('superseded', 'ineligible') THEN
    RAISE EXCEPTION 'PROJECT_CODE_SNAPSHOT_INVALID_TRANSITION' USING ERRCODE = '23514';
  ELSIF OLD."status" IN ('ineligible', 'superseded') THEN
    RAISE EXCEPTION 'PROJECT_CODE_SNAPSHOT_TERMINAL' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ProjectCodeSnapshot_guard_update"
BEFORE UPDATE ON "ProjectCodeSnapshot"
FOR EACH ROW EXECUTE FUNCTION "guard_project_code_snapshot_update"();

-- Replace the project pointer validator with an exact required-set check plus
-- compare-and-swap against the pointer captured when the batch was admitted.
CREATE OR REPLACE FUNCTION "validate_project_code_snapshot_pointer"()
RETURNS TRIGGER AS $$
DECLARE
  expected_count INTEGER;
  actual_count INTEGER;
  invalid_count INTEGER;
  missing_count INTEGER;
  expected_active_snapshot_id UUID;
BEGIN
  SELECT snapshot."requiredLinkCount", batch."expectedActiveCodeSnapshotId"
  INTO expected_count, expected_active_snapshot_id
  FROM "ProjectCodeSnapshot" snapshot
  JOIN "ProjectScanBatch" batch
    ON batch."projectId" = snapshot."projectId"
   AND batch."id" = snapshot."projectScanBatchId"
  WHERE snapshot."projectId" = NEW."projectId"
    AND snapshot."id" = NEW."projectCodeSnapshotId"
    AND snapshot."status" = 'complete'
    AND batch."status" IN ('succeeded', 'partial_optional')
    AND batch."completedRequiredLinkCount" = batch."expectedRequiredLinkCount"
    AND snapshot."requiredLinkCount" = batch."expectedRequiredLinkCount";

  IF expected_count IS NULL THEN
    RAISE EXCEPTION 'PROJECT_CODE_SNAPSHOT_INELIGIBLE' USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF expected_active_snapshot_id IS NOT NULL THEN
      RAISE EXCEPTION 'PROJECT_CODE_SNAPSHOT_CAS_FAILED' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."projectId" IS DISTINCT FROM OLD."projectId"
     OR expected_active_snapshot_id IS DISTINCT FROM OLD."projectCodeSnapshotId" THEN
    RAISE EXCEPTION 'PROJECT_CODE_SNAPSHOT_CAS_FAILED' USING ERRCODE = '23514';
  END IF;

  SELECT count(*)
  INTO actual_count
  FROM "ProjectCodeSnapshotEntry" entry
  WHERE entry."projectId" = NEW."projectId"
    AND entry."projectCodeSnapshotId" = NEW."projectCodeSnapshotId";

  SELECT count(*)
  INTO invalid_count
  FROM "ProjectCodeSnapshotEntry" entry
  JOIN "RepositoryCodeGeneration" generation
    ON generation."projectId" = entry."projectId"
   AND generation."projectRepositoryLinkId" = entry."projectRepositoryLinkId"
   AND generation."id" = entry."repositoryCodeGenerationId"
  JOIN "ProjectRepositoryLink" link
    ON link."projectId" = entry."projectId"
   AND link."id" = entry."projectRepositoryLinkId"
  JOIN "ProjectRepositoryLinkConfigPointer" config_pointer
    ON config_pointer."projectId" = entry."projectId"
   AND config_pointer."projectRepositoryLinkId" = entry."projectRepositoryLinkId"
  JOIN "RepositoryCodeGenerationPointer" code_pointer
    ON code_pointer."projectId" = entry."projectId"
   AND code_pointer."projectRepositoryLinkId" = entry."projectRepositoryLinkId"
  WHERE entry."projectId" = NEW."projectId"
    AND entry."projectCodeSnapshotId" = NEW."projectCodeSnapshotId"
    AND (
      entry."requiredForProjectSnapshot" <> true
      OR generation."status" <> 'code_ready'
      OR generation."linkConfigVersion" <> entry."linkConfigVersion"
      OR generation."effectivePolicyVersion" <> entry."effectivePolicyVersion"
      OR generation."frozenCommitSha" <> entry."frozenCommitSha"
      OR generation."manifestFingerprint" <> entry."generationManifestFingerprint"
      OR link."status" <> 'active'
      OR link."effectivePolicyVersion" <> entry."effectivePolicyVersion"
      OR config_pointer."configVersion" <> entry."linkConfigVersion"
      OR config_pointer."effectivePolicyVersion" <> entry."effectivePolicyVersion"
      OR code_pointer."repositoryCodeGenerationId" <> entry."repositoryCodeGenerationId"
      OR code_pointer."linkConfigVersion" <> entry."linkConfigVersion"
      OR code_pointer."effectivePolicyVersion" <> entry."effectivePolicyVersion"
    );

  SELECT count(*)
  INTO missing_count
  FROM "ProjectCodeSnapshot" snapshot
  JOIN "ProjectScanBatchEntry" batch_entry
    ON batch_entry."projectId" = snapshot."projectId"
   AND batch_entry."projectScanBatchId" = snapshot."projectScanBatchId"
   AND batch_entry."requiredForProjectSnapshot" = true
  WHERE snapshot."projectId" = NEW."projectId"
    AND snapshot."id" = NEW."projectCodeSnapshotId"
    AND NOT EXISTS (
      SELECT 1
      FROM "ProjectCodeSnapshotEntry" entry
      WHERE entry."projectId" = snapshot."projectId"
        AND entry."projectCodeSnapshotId" = snapshot."id"
        AND entry."projectRepositoryLinkId" = batch_entry."projectRepositoryLinkId"
        AND entry."linkConfigVersion" = batch_entry."linkConfigVersion"
        AND entry."effectivePolicyVersion" = batch_entry."effectivePolicyVersion"
        AND entry."requiredForProjectSnapshot" = true
    );

  IF actual_count <> expected_count OR invalid_count <> 0 OR missing_count <> 0 THEN
    RAISE EXCEPTION 'PROJECT_CODE_SNAPSHOT_INCOMPLETE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
