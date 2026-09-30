-- Enable only database-verified automatic outcomes. The Worker remains inert;
-- all run transitions continue through migrator-owned SECURITY DEFINER APIs.

-- ProjectSource inserts/retirements can run from the SECURITY DEFINER
-- finalizer below, whose search_path is intentionally restricted to
-- pg_catalog. Pin this existing invoker trigger to the same safe path and
-- qualify pgcrypto explicitly so it does not depend on the caller's path.
CREATE OR REPLACE FUNCTION public."project_source_provenance_guard"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW."contentHash" <> pg_catalog.encode(
    public.digest(pg_catalog.convert_to(NEW."contentText", 'UTF8'), 'sha256'), 'hex'
  ) THEN
    RAISE EXCEPTION 'project source content hash does not match content'
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'UPDATE' AND ROW(
    NEW."id", NEW."projectId", NEW."kind", NEW."originScope",
    NEW."projectRepositoryLinkId", NEW."externalRef", NEW."sourceIdentity",
    NEW."revisionKey", NEW."contentText", NEW."contentHash",
    NEW."manualContentDedupeKey", NEW."storageKey", NEW."capturedAt",
    NEW."ingestedAt"
  ) IS DISTINCT FROM ROW(
    OLD."id", OLD."projectId", OLD."kind", OLD."originScope",
    OLD."projectRepositoryLinkId", OLD."externalRef", OLD."sourceIdentity",
    OLD."revisionKey", OLD."contentText", OLD."contentHash",
    OLD."manualContentDedupeKey", OLD."storageKey", OLD."capturedAt",
    OLD."ingestedAt"
  ) THEN
    RAISE EXCEPTION 'project source provenance is immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

ALTER TYPE "ProjectGitRepositoryAutomationRunStatus" ADD VALUE 'succeeded';
ALTER TYPE "ProjectGitRepositoryAutomationRunStatus" ADD VALUE 'unchanged';
ALTER TYPE "ProjectGitRepositoryAutomationRunAuditAction" ADD VALUE 'run_succeeded';
ALTER TYPE "ProjectGitRepositoryAutomationRunAuditAction" ADD VALUE 'run_unchanged';

ALTER TABLE public."ProjectGitRepositoryAutomationRun"
  ADD COLUMN "expectedPublicationVersionId" UUID,
  ADD COLUMN "expectedPublicationGeneration" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "resultPublicationVersionId" UUID,
  ADD COLUMN "resultPublicationGeneration" INTEGER,
  ADD COLUMN "observedCommitSha" CHAR(64),
  ADD COLUMN "manifestFingerprint" CHAR(64),
  ADD COLUMN "fileCount" INTEGER,
  ADD COLUMN "decodedTextBytes" INTEGER,
  DROP CONSTRAINT "PGAR_lease_shape_check",
  ADD CONSTRAINT "PGAR_expected_publication_cursor_check" CHECK (
    "expectedPublicationGeneration" >= 0
    AND (("expectedPublicationGeneration" = 0 AND "expectedPublicationVersionId" IS NULL)
      OR ("expectedPublicationGeneration" > 0 AND "expectedPublicationVersionId" IS NOT NULL))
  ),
  ADD CONSTRAINT "PGAR_result_publication_shape_check" CHECK (
    ("status" IN ('pending', 'dispatched', 'failed', 'unknown')
      AND "resultPublicationVersionId" IS NULL AND "resultPublicationGeneration" IS NULL
      AND "observedCommitSha" IS NULL AND "manifestFingerprint" IS NULL
      AND "fileCount" IS NULL AND "decodedTextBytes" IS NULL)
    OR ("status" = 'succeeded' AND "resultPublicationVersionId" IS NOT NULL
      AND "resultPublicationGeneration" = "expectedPublicationGeneration" + 1
      AND btrim("observedCommitSha") ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'
      AND "manifestFingerprint" ~ '^[0-9a-f]{64}$' AND "fileCount" > 0 AND "decodedTextBytes" >= 0)
    OR ("status" = 'unchanged' AND "expectedPublicationVersionId" IS NOT NULL
      AND "resultPublicationVersionId" = "expectedPublicationVersionId"
      AND "resultPublicationGeneration" = "expectedPublicationGeneration"
      AND btrim("observedCommitSha") ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'
      AND "manifestFingerprint" ~ '^[0-9a-f]{64}$' AND "fileCount" > 0 AND "decodedTextBytes" >= 0)
  ),
  ADD CONSTRAINT "PGAR_lease_shape_check" CHECK (
    "leaseWorkerId" IS NOT NULL AND "leaseToken" IS NOT NULL AND "claimedAt" IS NOT NULL
    AND (
      ("status" = 'pending' AND "leaseExpiresAt" IS NOT NULL AND "leaseExpiresAt" > "claimedAt"
        AND "dispatchedAt" IS NULL AND "completedAt" IS NULL AND "safeErrorCode" IS NULL)
      OR ("status" = 'dispatched' AND "leaseExpiresAt" IS NOT NULL AND "leaseExpiresAt" > "claimedAt"
        AND "dispatchedAt" IS NOT NULL AND "completedAt" IS NULL AND "safeErrorCode" IS NULL)
      OR ("status" = 'failed' AND "leaseExpiresAt" IS NULL AND "completedAt" IS NOT NULL AND "safeErrorCode" IS NOT NULL
        AND (("dispatchedAt" IS NULL AND "safeErrorCode" <> 'PUBLICATION_HEAD_STALE')
          OR ("dispatchedAt" IS NOT NULL AND "safeErrorCode" = 'PUBLICATION_HEAD_STALE')))
      OR ("status" = 'unknown' AND "leaseExpiresAt" IS NULL AND "dispatchedAt" IS NOT NULL
        AND "completedAt" IS NOT NULL AND "safeErrorCode" IS NOT NULL)
      OR ("status" IN ('succeeded', 'unchanged') AND "leaseExpiresAt" IS NULL AND "dispatchedAt" IS NOT NULL
        AND "completedAt" IS NOT NULL AND "safeErrorCode" IS NULL)
    )
  );

ALTER TABLE public."ProjectGitRepositoryAutomationRunAudit"
  ADD COLUMN "expectedPublicationVersionId" UUID,
  ADD COLUMN "expectedPublicationGeneration" INTEGER,
  ADD COLUMN "publicationVersionId" UUID,
  ADD COLUMN "publicationGeneration" INTEGER,
  ADD COLUMN "observedCommitSha" CHAR(64),
  ADD COLUMN "manifestFingerprint" CHAR(64),
  ADD COLUMN "fileCount" INTEGER,
  ADD COLUMN "decodedTextBytes" INTEGER,
  DROP CONSTRAINT "PGARA_version_shape_check",
  ADD CONSTRAINT "PGARA_version_shape_check" CHECK (
    ("cursorVersion" IS NOT NULL AND "cursorVersion" > 0 AND "runId" IS NULL AND "runVersion" IS NULL
      AND "cursorStatusAfter" IS NOT NULL AND "nextRunAt" IS NOT NULL
      AND "runStatusBefore" IS NULL AND "runStatusAfter" IS NULL
      AND "expectedPublicationVersionId" IS NULL AND "expectedPublicationGeneration" IS NULL
      AND "publicationVersionId" IS NULL AND "publicationGeneration" IS NULL
      AND "observedCommitSha" IS NULL AND "manifestFingerprint" IS NULL
      AND "fileCount" IS NULL AND "decodedTextBytes" IS NULL)
    OR ("cursorVersion" IS NULL AND "runId" IS NOT NULL AND "runVersion" IS NOT NULL AND "runVersion" > 0
      AND "cursorStatusAfter" IS NULL AND "nextRunAt" IS NULL AND "lastScheduledFor" IS NULL
      AND "runStatusAfter" IS NOT NULL
      AND "expectedPublicationGeneration" >= 0
      AND (("expectedPublicationGeneration" = 0 AND "expectedPublicationVersionId" IS NULL)
        OR ("expectedPublicationGeneration" > 0 AND "expectedPublicationVersionId" IS NOT NULL))
      AND (("runStatusAfter" IN ('succeeded', 'unchanged')
          AND "publicationVersionId" IS NOT NULL AND "publicationGeneration" > 0
          AND btrim("observedCommitSha") ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'
          AND "manifestFingerprint" ~ '^[0-9a-f]{64}$' AND "fileCount" > 0 AND "decodedTextBytes" >= 0)
        OR ("runStatusAfter" NOT IN ('succeeded', 'unchanged')
          AND "publicationVersionId" IS NULL AND "publicationGeneration" IS NULL
          AND "observedCommitSha" IS NULL AND "manifestFingerprint" IS NULL
          AND "fileCount" IS NULL AND "decodedTextBytes" IS NULL))
      AND ("runStatusAfter" <> 'unchanged'
        OR ("publicationVersionId" = "expectedPublicationVersionId"
          AND "publicationGeneration" = "expectedPublicationGeneration")))
    -- Immutable audit rows written before this migration have no publication
    -- cursor. Preserve their NULL metadata and original event fields; every
    -- new event is captured with a non-NULL generation by the replacement
    -- audit trigger below.
    OR ("cursorVersion" IS NULL AND "runId" IS NOT NULL AND "runVersion" > 0
      AND "cursorStatusAfter" IS NULL AND "nextRunAt" IS NULL AND "lastScheduledFor" IS NULL
      AND "runStatusAfter" IN ('pending', 'dispatched', 'failed', 'unknown')
      AND "expectedPublicationVersionId" IS NULL AND "expectedPublicationGeneration" IS NULL
      AND "publicationVersionId" IS NULL AND "publicationGeneration" IS NULL
      AND "observedCommitSha" IS NULL AND "manifestFingerprint" IS NULL
      AND "fileCount" IS NULL AND "decodedTextBytes" IS NULL)
  );

CREATE OR REPLACE FUNCTION public."project_git_automation_deterministic_uuid"(input_text TEXT)
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
  RETURN (substring(digest_hex, 1, 8) || '-' || substring(digest_hex, 9, 4) || '-'
    || substring(digest_hex, 13, 4) || '-' || substring(digest_hex, 17, 4) || '-'
    || substring(digest_hex, 21, 12))::UUID;
END;
$$;

CREATE OR REPLACE FUNCTION public."project_git_automation_glob_matches"(pattern TEXT, candidate TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
DECLARE
  expression TEXT := '^';
  character TEXT;
  index_value INTEGER := 1;
BEGIN
  IF char_length(pattern) NOT BETWEEN 1 AND 256
     OR pattern !~ '^[A-Za-z0-9._*?/-]+$'
     OR position('..' IN pattern) > 0 THEN
    RETURN FALSE;
  END IF;
  WHILE index_value <= char_length(pattern) LOOP
    character := substring(pattern FROM index_value FOR 1);
    IF character = '*' AND substring(pattern FROM index_value + 1 FOR 1) = '*' THEN
      expression := expression || '.*';
      index_value := index_value + 2;
    ELSIF character = '*' THEN
      expression := expression || '[^/]*';
      index_value := index_value + 1;
    ELSIF character = '?' THEN
      expression := expression || '[^/]';
      index_value := index_value + 1;
    ELSIF character = '.' THEN
      expression := expression || E'\\.';
      index_value := index_value + 1;
    ELSE
      expression := expression || character;
      index_value := index_value + 1;
    END IF;
  END LOOP;
  RETURN candidate ~ (expression || '$');
END;
$$;

CREATE OR REPLACE FUNCTION public."project_git_automation_path_allowed"(candidate TEXT, roots JSONB, excludes JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
DECLARE
  candidate_bytes INTEGER;
  segment TEXT;
  pattern_value JSONB;
  file_name TEXT;
  extension_value TEXT;
BEGIN
  candidate_bytes := octet_length(convert_to(candidate, 'UTF8'));
  IF candidate = '' OR candidate_bytes > 1024 OR char_length(candidate) > 1024
     OR candidate <> normalize(candidate, NFC)
     OR candidate ~ '(^/|/$|//|[[:cntrl:]])'
     OR position(E'\\' IN candidate) > 0
     OR jsonb_typeof(roots) <> 'array' OR jsonb_array_length(roots) NOT BETWEEN 1 AND 32
     OR jsonb_typeof(excludes) <> 'array' OR jsonb_array_length(excludes) > 64 THEN
    RETURN FALSE;
  END IF;
  FOREACH segment IN ARRAY string_to_array(candidate, '/') LOOP
    IF segment IN ('.', '..') OR lower(segment) = ANY(ARRAY['.git', '.next', '.nuxt', 'coverage', 'dist', 'node_modules', 'target', 'vendor']) THEN
      RETURN FALSE;
    END IF;
  END LOOP;
  file_name := lower(split_part(candidate, '/', array_length(string_to_array(candidate, '/'), 1)));
  extension_value := CASE
    WHEN file_name IN ('dockerfile', 'makefile', 'license', 'readme', '.gitignore', '.dockerignore') THEN ''
    WHEN right(file_name, 12) = '.env.example' THEN '.env.example'
    ELSE COALESCE(substring(file_name FROM E'\\.[^.]*$'), '')
  END;
  IF extension_value <> ALL(ARRAY[
    '', '.c', '.cc', '.conf', '.cpp', '.cs', '.css', '.csv', '.env.example', '.go', '.graphql', '.h', '.hpp',
    '.html', '.ini', '.java', '.js', '.json', '.jsx', '.kt', '.kts', '.md', '.mdx', '.mjs', '.php', '.properties',
    '.proto', '.py', '.rb', '.rs', '.scala', '.sh', '.sql', '.svelte', '.swift', '.toml', '.ts', '.tsx', '.txt',
    '.vue', '.xml', '.yaml', '.yml', '.zsh'
  ]) THEN
    RETURN FALSE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(roots) AS root_row(item)
     WHERE jsonb_typeof(root_row.item) = 'string'
       AND ((root_row.item #>> '{}') = '.'
         OR candidate = (root_row.item #>> '{}')
         OR left(candidate, char_length(root_row.item #>> '{}') + 1) = (root_row.item #>> '{}') || '/')
  ) THEN
    RETURN FALSE;
  END IF;
  FOR pattern_value IN SELECT exclude_row.item FROM jsonb_array_elements(excludes) AS exclude_row(item) LOOP
    IF jsonb_typeof(pattern_value) <> 'string'
       OR public."project_git_automation_glob_matches"(pattern_value #>> '{}', candidate) THEN
      RETURN FALSE;
    END IF;
  END LOOP;
  RETURN TRUE;
END;
$$;

-- Expired dispatched work has an unknown external result, so its schedule
-- cursor becomes terminal until a project Owner explicitly intervenes.
CREATE OR REPLACE FUNCTION public."project_git_automation_cursor_shape_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  grant_row public."ProjectGitRepositoryAutomationGrant"%ROWTYPE;
  workspace_id UUID;
  database_now TIMESTAMP(3);
  transition_action TEXT := pg_catalog.current_setting('ai_project_os.git_automation_transition', TRUE);
  eligible_reason TEXT;
BEGIN
  database_now := COALESCE(NULLIF(pg_catalog.current_setting('ai_project_os.git_automation_now', TRUE), '')::TIMESTAMP(3),
    pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp() AT TIME ZONE 'UTC'));
  IF TG_OP = 'INSERT' THEN
    NEW."createdAt" := database_now;
    NEW."updatedAt" := database_now;
    SELECT automation_grant.* INTO grant_row
      FROM public."ProjectGitRepositoryAutomationGrant" automation_grant WHERE automation_grant."id" = NEW."grantId";
    IF NOT FOUND THEN RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_CURSOR_GRANT_MISSING' USING ERRCODE = 'check_violation'; END IF;
    SELECT project."workspaceId" INTO workspace_id FROM public."Project" project WHERE project."id" = grant_row."projectId";
    IF NOT FOUND OR transition_action <> 'claim'
       OR NEW."projectId" IS DISTINCT FROM grant_row."projectId" OR NEW."workspaceId" IS DISTINCT FROM workspace_id
       OR NEW."connectionOwnerId" IS DISTINCT FROM grant_row."connectionOwnerId"
       OR grant_row."activatedAt" IS NULL
       OR NEW."nextRunAt" IS DISTINCT FROM grant_row."activatedAt" + grant_row."runIntervalMinutes" * INTERVAL '1 minute'
       OR NEW."version" <> 1 OR NEW."status" <> 'active' OR NEW."pauseReason" IS NOT NULL
       OR NEW."pausedAt" IS NOT NULL OR NEW."lastScheduledFor" IS NOT NULL THEN
      RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_CURSOR_INITIAL_SCHEDULE_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    eligible_reason := public."project_git_automation_grant_eligibility"(grant_row."id", grant_row."projectId", database_now);
    IF eligible_reason IS NULL AND NEW."nextRunAt" > database_now THEN
      RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_CURSOR_NOT_DUE' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  NEW."updatedAt" := database_now;
  IF OLD."grantId" IS DISTINCT FROM NEW."grantId" OR OLD."projectId" IS DISTINCT FROM NEW."projectId"
     OR OLD."workspaceId" IS DISTINCT FROM NEW."workspaceId" OR OLD."connectionOwnerId" IS DISTINCT FROM NEW."connectionOwnerId"
     OR OLD."createdAt" IS DISTINCT FROM NEW."createdAt" OR NEW."version" <> OLD."version" + 1
     OR OLD."status" = 'paused' THEN
    RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_CURSOR_TRANSITION_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO grant_row FROM public."ProjectGitRepositoryAutomationGrant" WHERE "id" = NEW."grantId";
  IF NOT FOUND THEN RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_CURSOR_GRANT_MISSING' USING ERRCODE = 'check_violation'; END IF;
  eligible_reason := public."project_git_automation_grant_eligibility"(grant_row."id", grant_row."projectId", database_now);
  IF NEW."status" = 'paused' THEN
    IF transition_action NOT IN ('claim', 'grant_terminal', 'run_unknown')
       OR NEW."nextRunAt" IS DISTINCT FROM OLD."nextRunAt"
       OR NEW."lastScheduledFor" IS DISTINCT FROM OLD."lastScheduledFor"
       OR NEW."pauseReason" IS NULL OR NEW."pausedAt" IS NULL
       OR (eligible_reason IS NULL AND NOT (
         (transition_action = 'claim' AND NEW."pauseReason" = 'schedule_snapshot_drift')
         OR (transition_action = 'run_unknown' AND NEW."pauseReason" = 'run_outcome_unknown')
       ))
       OR (transition_action = 'grant_terminal' AND grant_row."status" = 'active')
       OR (transition_action = 'run_unknown' AND eligible_reason IS NOT NULL) THEN
      RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_CURSOR_PAUSE_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."status" = 'active' THEN
    IF transition_action <> 'claim' OR eligible_reason IS NOT NULL
       OR NEW."lastScheduledFor" IS DISTINCT FROM OLD."nextRunAt"
       OR NEW."nextRunAt" IS DISTINCT FROM database_now + grant_row."runIntervalMinutes" * INTERVAL '1 minute'
       OR NEW."pauseReason" IS NOT NULL OR NEW."pausedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_CURSOR_ADVANCE_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_CURSOR_STATE_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public."project_git_automation_run_shape_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  grant_row public."ProjectGitRepositoryAutomationGrant"%ROWTYPE;
  cursor_row public."ProjectGitRepositoryAutomationScheduleCursor"%ROWTYPE;
  head_row RECORD;
  database_now TIMESTAMP(3);
  transition_action TEXT := pg_catalog.current_setting('ai_project_os.git_automation_transition', TRUE);
  eligible_reason TEXT;
  expected_status public."ProjectGitRepositoryAutomationRunStatus";
BEGIN
  database_now := COALESCE(NULLIF(pg_catalog.current_setting('ai_project_os.git_automation_now', TRUE), '')::TIMESTAMP(3),
    pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp() AT TIME ZONE 'UTC'));
  IF TG_OP = 'INSERT' THEN
    IF transition_action <> 'claim' OR NEW."status" <> 'pending' OR NEW."version" <> 1
       OR NEW."leaseWorkerId" IS NULL OR NEW."leaseWorkerId" !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
       OR NEW."leaseToken" IS NULL OR NEW."lastHeartbeatAt" IS NOT NULL
       OR NEW."dispatchedAt" IS NOT NULL OR NEW."completedAt" IS NOT NULL OR NEW."safeErrorCode" IS NOT NULL
       OR NEW."claimedAt" > database_now + INTERVAL '1 second'
       OR NEW."leaseExpiresAt" IS DISTINCT FROM NEW."claimedAt" + INTERVAL '90 seconds'
       OR NEW."scheduledFor" > NEW."claimedAt"
       OR NEW."resultPublicationVersionId" IS NOT NULL OR NEW."resultPublicationGeneration" IS NOT NULL
       OR NEW."observedCommitSha" IS NOT NULL OR NEW."manifestFingerprint" IS NOT NULL
       OR NEW."fileCount" IS NOT NULL OR NEW."decodedTextBytes" IS NOT NULL THEN
      RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_RUN_CLAIM_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    SELECT * INTO grant_row FROM public."ProjectGitRepositoryAutomationGrant" WHERE "id" = NEW."grantId";
    eligible_reason := public."project_git_automation_grant_eligibility"(NEW."grantId", NEW."projectId", database_now);
    SELECT * INTO cursor_row FROM public."ProjectGitRepositoryAutomationScheduleCursor" WHERE "grantId" = NEW."grantId";
    IF NOT FOUND OR eligible_reason IS NOT NULL
       OR NEW."projectId" IS DISTINCT FROM grant_row."projectId"
       OR NEW."gitConnectionId" IS DISTINCT FROM grant_row."gitConnectionId"
       OR NEW."baseDelegationId" IS DISTINCT FROM grant_row."baseDelegationId"
       OR NEW."connectionOwnerId" IS DISTINCT FROM grant_row."connectionOwnerId"
       OR NEW."grantVersion" IS DISTINCT FROM grant_row."version"
       OR NEW."grantFingerprint" IS DISTINCT FROM grant_row."grantFingerprint"
       OR NEW."baseDelegationVersion" IS DISTINCT FROM grant_row."baseDelegationVersion"
       OR NEW."baseDelegationFingerprint" IS DISTINCT FROM grant_row."baseDelegationFingerprint"
       OR NEW."repositoryPath" IS DISTINCT FROM grant_row."repositoryPath"
       OR NEW."trackedRef" IS DISTINCT FROM grant_row."trackedRef"
       OR NEW."includeRoots" IS DISTINCT FROM grant_row."includeRoots"
       OR NEW."softExcludePatterns" IS DISTINCT FROM grant_row."softExcludePatterns"
       OR NEW."runIntervalMinutes" IS DISTINCT FROM grant_row."runIntervalMinutes"
       OR NEW."expiresAt" IS DISTINCT FROM grant_row."expiresAt"
       OR cursor_row."status" <> 'active'
       OR cursor_row."lastScheduledFor" IS DISTINCT FROM NEW."scheduledFor"
       OR cursor_row."nextRunAt" IS DISTINCT FROM NEW."claimedAt" + grant_row."runIntervalMinutes" * INTERVAL '1 minute'
       OR EXISTS (SELECT 1 FROM public."ProjectGitRepositoryAutomationRun" live_run
                   WHERE live_run."grantId" = NEW."grantId" AND live_run."status" IN ('pending', 'dispatched')) THEN
      RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_RUN_SNAPSHOT_OR_DUE_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    SELECT head."currentPublicationVersionId", head."generation"
      INTO head_row
      FROM public."ProjectGitRepositoryPublicationHead" head
     WHERE head."projectId" = NEW."projectId" AND head."delegationId" = NEW."baseDelegationId";
    IF FOUND THEN
      NEW."expectedPublicationVersionId" := head_row."currentPublicationVersionId";
      NEW."expectedPublicationGeneration" := head_row."generation";
    ELSE
      NEW."expectedPublicationVersionId" := NULL;
      NEW."expectedPublicationGeneration" := 0;
    END IF;
    NEW."createdAt" := NEW."claimedAt";
    NEW."updatedAt" := NEW."claimedAt";
    RETURN NEW;
  END IF;

  NEW."updatedAt" := database_now;
  IF OLD."id" IS DISTINCT FROM NEW."id"
     OR OLD."grantId" IS DISTINCT FROM NEW."grantId"
     OR OLD."projectId" IS DISTINCT FROM NEW."projectId"
     OR OLD."workspaceId" IS DISTINCT FROM NEW."workspaceId"
     OR OLD."gitConnectionId" IS DISTINCT FROM NEW."gitConnectionId"
     OR OLD."baseDelegationId" IS DISTINCT FROM NEW."baseDelegationId"
     OR OLD."connectionOwnerId" IS DISTINCT FROM NEW."connectionOwnerId"
     OR OLD."grantVersion" IS DISTINCT FROM NEW."grantVersion"
     OR OLD."grantFingerprint" IS DISTINCT FROM NEW."grantFingerprint"
     OR OLD."baseDelegationVersion" IS DISTINCT FROM NEW."baseDelegationVersion"
     OR OLD."baseDelegationFingerprint" IS DISTINCT FROM NEW."baseDelegationFingerprint"
     OR OLD."repositoryPath" IS DISTINCT FROM NEW."repositoryPath"
     OR OLD."trackedRef" IS DISTINCT FROM NEW."trackedRef"
     OR OLD."includeRoots" IS DISTINCT FROM NEW."includeRoots"
     OR OLD."softExcludePatterns" IS DISTINCT FROM NEW."softExcludePatterns"
     OR OLD."runIntervalMinutes" IS DISTINCT FROM NEW."runIntervalMinutes"
     OR OLD."expiresAt" IS DISTINCT FROM NEW."expiresAt"
     OR OLD."scheduledFor" IS DISTINCT FROM NEW."scheduledFor"
     OR OLD."claimedAt" IS DISTINCT FROM NEW."claimedAt"
     OR OLD."createdAt" IS DISTINCT FROM NEW."createdAt"
     OR OLD."expectedPublicationVersionId" IS DISTINCT FROM NEW."expectedPublicationVersionId"
     OR OLD."expectedPublicationGeneration" IS DISTINCT FROM NEW."expectedPublicationGeneration"
     OR NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_RUN_IMMUTABLE_OR_VERSION_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO grant_row FROM public."ProjectGitRepositoryAutomationGrant" WHERE "id" = NEW."grantId";
  eligible_reason := public."project_git_automation_grant_eligibility"(NEW."grantId", NEW."projectId", database_now);
  IF OLD."status" = NEW."status" AND OLD."status" IN ('pending', 'dispatched') THEN
    IF transition_action <> 'heartbeat' OR OLD."leaseExpiresAt" IS NULL OR OLD."leaseExpiresAt" <= database_now
       OR eligible_reason IS NOT NULL OR NOT public."project_git_automation_run_snapshot_matches"(OLD."id")
       OR OLD."leaseWorkerId" IS DISTINCT FROM NEW."leaseWorkerId"
       OR OLD."leaseToken" IS DISTINCT FROM NEW."leaseToken"
       OR NEW."lastHeartbeatAt" IS NULL
       OR NEW."lastHeartbeatAt" < COALESCE(OLD."lastHeartbeatAt", OLD."claimedAt")
       OR NEW."leaseExpiresAt" IS DISTINCT FROM NEW."lastHeartbeatAt" + INTERVAL '90 seconds'
       OR NEW."dispatchedAt" IS DISTINCT FROM OLD."dispatchedAt"
       OR NEW."completedAt" IS NOT NULL OR NEW."safeErrorCode" IS NOT NULL
       OR NEW."resultPublicationVersionId" IS NOT NULL OR NEW."resultPublicationGeneration" IS NOT NULL
       OR NEW."observedCommitSha" IS NOT NULL OR NEW."manifestFingerprint" IS NOT NULL
       OR NEW."fileCount" IS NOT NULL OR NEW."decodedTextBytes" IS NOT NULL THEN
      RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_RUN_HEARTBEAT_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF OLD."status" = 'pending' AND NEW."status" = 'dispatched' THEN
    IF transition_action <> 'dispatch' OR OLD."leaseExpiresAt" IS NULL OR OLD."leaseExpiresAt" <= database_now
       OR eligible_reason IS NOT NULL OR NOT public."project_git_automation_run_snapshot_matches"(OLD."id")
       OR OLD."leaseWorkerId" IS DISTINCT FROM NEW."leaseWorkerId"
       OR OLD."leaseToken" IS DISTINCT FROM NEW."leaseToken"
       OR OLD."leaseExpiresAt" IS DISTINCT FROM NEW."leaseExpiresAt"
       OR NEW."dispatchedAt" IS NULL OR NEW."dispatchedAt" < OLD."claimedAt"
       OR NEW."dispatchedAt" > database_now + INTERVAL '1 second'
       OR NEW."lastHeartbeatAt" IS DISTINCT FROM OLD."lastHeartbeatAt"
       OR NEW."completedAt" IS NOT NULL OR NEW."safeErrorCode" IS NOT NULL THEN
      RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_RUN_DISPATCH_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF OLD."status" = 'dispatched' AND NEW."status" IN ('succeeded', 'unchanged') THEN
    IF transition_action <> 'automatic_finalize' OR OLD."leaseExpiresAt" IS NULL OR OLD."leaseExpiresAt" <= database_now
       OR eligible_reason IS NOT NULL OR NOT public."project_git_automation_run_snapshot_matches"(OLD."id")
       OR OLD."leaseWorkerId" IS DISTINCT FROM NEW."leaseWorkerId"
       OR OLD."leaseToken" IS DISTINCT FROM NEW."leaseToken"
       OR NEW."leaseExpiresAt" IS NOT NULL OR NEW."dispatchedAt" IS DISTINCT FROM OLD."dispatchedAt"
       OR NEW."lastHeartbeatAt" IS DISTINCT FROM OLD."lastHeartbeatAt"
       OR NEW."completedAt" IS NULL OR NEW."completedAt" < OLD."claimedAt"
       OR NEW."completedAt" > database_now + INTERVAL '1 second'
       OR NEW."safeErrorCode" IS NOT NULL
       OR btrim(NEW."observedCommitSha") !~ '^([0-9a-f]{40}|[0-9a-f]{64})$'
       OR NEW."manifestFingerprint" !~ '^[0-9a-f]{64}$'
       OR NEW."fileCount" <= 0 OR NEW."decodedTextBytes" < 0
       OR (NEW."status" = 'succeeded' AND (NEW."resultPublicationVersionId" IS NULL
          OR NEW."resultPublicationGeneration" <> OLD."expectedPublicationGeneration" + 1))
       OR (NEW."status" = 'unchanged' AND (OLD."expectedPublicationVersionId" IS NULL
          OR NEW."resultPublicationVersionId" IS DISTINCT FROM OLD."expectedPublicationVersionId"
          OR NEW."resultPublicationGeneration" <> OLD."expectedPublicationGeneration")) THEN
      RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_RUN_FINALIZE_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF OLD."status" = 'dispatched' AND NEW."status" = 'failed' THEN
    IF transition_action <> 'automatic_finalize' OR OLD."leaseExpiresAt" IS NULL OR OLD."leaseExpiresAt" <= database_now
       OR eligible_reason IS NOT NULL OR NOT public."project_git_automation_run_snapshot_matches"(OLD."id")
       OR NEW."safeErrorCode" <> 'PUBLICATION_HEAD_STALE'
       OR NEW."leaseWorkerId" IS DISTINCT FROM OLD."leaseWorkerId"
       OR NEW."leaseToken" IS DISTINCT FROM OLD."leaseToken"
       OR NEW."leaseExpiresAt" IS NOT NULL OR NEW."dispatchedAt" IS DISTINCT FROM OLD."dispatchedAt"
       OR NEW."lastHeartbeatAt" IS DISTINCT FROM OLD."lastHeartbeatAt"
       OR NEW."completedAt" IS NULL OR NEW."completedAt" < OLD."claimedAt"
       OR NEW."completedAt" > database_now + INTERVAL '1 second'
       OR NEW."resultPublicationVersionId" IS NOT NULL OR NEW."resultPublicationGeneration" IS NOT NULL
       OR NEW."observedCommitSha" IS NOT NULL OR NEW."manifestFingerprint" IS NOT NULL
       OR NEW."fileCount" IS NOT NULL OR NEW."decodedTextBytes" IS NOT NULL THEN
      RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_RUN_FINALIZE_STALE_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF OLD."status" IN ('pending', 'dispatched') AND NEW."status" IN ('failed', 'unknown') THEN
    expected_status := CASE WHEN OLD."status" = 'pending' THEN 'failed'::public."ProjectGitRepositoryAutomationRunStatus"
                            ELSE 'unknown'::public."ProjectGitRepositoryAutomationRunStatus" END;
    IF NEW."status" <> expected_status OR NEW."leaseWorkerId" IS DISTINCT FROM OLD."leaseWorkerId"
       OR NEW."leaseToken" IS DISTINCT FROM OLD."leaseToken" OR NEW."leaseExpiresAt" IS NOT NULL
       OR NEW."dispatchedAt" IS DISTINCT FROM OLD."dispatchedAt"
       OR NEW."completedAt" IS NULL OR NEW."completedAt" < OLD."claimedAt"
       OR NEW."completedAt" > database_now + INTERVAL '1 second'
       OR NEW."resultPublicationVersionId" IS NOT NULL OR NEW."resultPublicationGeneration" IS NOT NULL
       OR NEW."observedCommitSha" IS NOT NULL OR NEW."manifestFingerprint" IS NOT NULL
       OR NEW."fileCount" IS NOT NULL OR NEW."decodedTextBytes" IS NOT NULL
       OR NOT (
         (transition_action IN ('reconcile', 'claim')
           AND ((NEW."safeErrorCode" = CASE WHEN OLD."status" = 'pending' THEN 'LEASE_EXPIRED_BEFORE_DISPATCH' ELSE 'LEASE_EXPIRED_AFTER_DISPATCH' END
                 AND OLD."leaseExpiresAt" <= database_now)
             OR (NEW."safeErrorCode" = CASE WHEN OLD."status" = 'pending' THEN 'GRANT_INELIGIBLE_BEFORE_DISPATCH' ELSE 'GRANT_INELIGIBLE_AFTER_DISPATCH' END
                 AND eligible_reason IS NOT NULL)))
         OR (transition_action = 'grant_terminal' AND eligible_reason IS NOT NULL
             AND NEW."safeErrorCode" = CASE WHEN OLD."status" = 'pending' THEN 'GRANT_INELIGIBLE_BEFORE_DISPATCH' ELSE 'GRANT_INELIGIBLE_AFTER_DISPATCH' END)
       ) THEN
      RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_RUN_TERMINAL_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_RUN_STATE_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public."project_git_automation_run_audit_capture"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  event_action public."ProjectGitRepositoryAutomationRunAuditAction";
BEGIN
  event_action := CASE
    WHEN TG_OP = 'INSERT' THEN 'run_claimed'::public."ProjectGitRepositoryAutomationRunAuditAction"
    WHEN OLD."status" = NEW."status" THEN 'run_heartbeat'::public."ProjectGitRepositoryAutomationRunAuditAction"
    WHEN NEW."status" = 'dispatched' THEN 'run_dispatched'::public."ProjectGitRepositoryAutomationRunAuditAction"
    WHEN NEW."status" = 'succeeded' THEN 'run_succeeded'::public."ProjectGitRepositoryAutomationRunAuditAction"
    WHEN NEW."status" = 'unchanged' THEN 'run_unchanged'::public."ProjectGitRepositoryAutomationRunAuditAction"
    WHEN NEW."safeErrorCode" = 'LEASE_EXPIRED_BEFORE_DISPATCH' THEN 'run_lease_expired_before_dispatch'::public."ProjectGitRepositoryAutomationRunAuditAction"
    WHEN NEW."safeErrorCode" = 'LEASE_EXPIRED_AFTER_DISPATCH' THEN 'run_lease_expired_after_dispatch'::public."ProjectGitRepositoryAutomationRunAuditAction"
    WHEN NEW."status" = 'failed' AND OLD."status" = 'dispatched' THEN 'run_fence_rejected_after_dispatch'::public."ProjectGitRepositoryAutomationRunAuditAction"
    WHEN NEW."status" = 'failed' THEN 'run_fence_rejected_before_dispatch'::public."ProjectGitRepositoryAutomationRunAuditAction"
    ELSE 'run_fence_rejected_after_dispatch'::public."ProjectGitRepositoryAutomationRunAuditAction"
  END;
  INSERT INTO public."ProjectGitRepositoryAutomationRunAudit" (
    "id", "grantId", "projectId", "runId", "action", "runVersion", "runStatusBefore", "runStatusAfter",
    "scheduledFor", "workerId", "leaseExpiresAt", "grantVersion", "grantFingerprint", "reason",
    "expectedPublicationVersionId", "expectedPublicationGeneration", "publicationVersionId", "publicationGeneration",
    "observedCommitSha", "manifestFingerprint", "fileCount", "decodedTextBytes"
  ) VALUES (
    pg_catalog.gen_random_uuid(), NEW."grantId", NEW."projectId", NEW."id", event_action, NEW."version",
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD."status" END, NEW."status", NEW."scheduledFor",
    NEW."leaseWorkerId", NEW."leaseExpiresAt", NEW."grantVersion", NEW."grantFingerprint", NEW."safeErrorCode",
    NEW."expectedPublicationVersionId", NEW."expectedPublicationGeneration", NEW."resultPublicationVersionId",
    NEW."resultPublicationGeneration", NEW."observedCommitSha", NEW."manifestFingerprint", NEW."fileCount", NEW."decodedTextBytes"
  );
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public."project_git_automation_pause_cursor_after_unknown"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  database_now TIMESTAMP(3);
BEGIN
  IF OLD."status" IS DISTINCT FROM 'dispatched' OR NEW."status" IS DISTINCT FROM 'unknown'
     OR NEW."safeErrorCode" <> 'LEASE_EXPIRED_AFTER_DISPATCH' THEN
    RETURN NULL;
  END IF;
  database_now := pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp() AT TIME ZONE 'UTC');
  PERFORM pg_catalog.set_config('ai_project_os.git_automation_now', database_now::text, TRUE);
  PERFORM pg_catalog.set_config('ai_project_os.git_automation_transition', 'run_unknown', TRUE);
  UPDATE public."ProjectGitRepositoryAutomationScheduleCursor"
     SET "status" = 'paused', "pauseReason" = 'run_outcome_unknown',
         "pausedAt" = database_now, "version" = "version" + 1
   WHERE "grantId" = NEW."grantId" AND "status" = 'active';
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS "PGAR_unknown_cursor_pause" ON public."ProjectGitRepositoryAutomationRun";
CREATE TRIGGER "PGAR_unknown_cursor_pause"
AFTER UPDATE ON public."ProjectGitRepositoryAutomationRun"
FOR EACH ROW EXECUTE FUNCTION public."project_git_automation_pause_cursor_after_unknown"();

CREATE OR REPLACE FUNCTION public."project_git_automation_publication_version_insert_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  run_row public."ProjectGitRepositoryAutomationRun"%ROWTYPE;
  head_row RECORD;
BEGIN
  IF TG_OP <> 'INSERT' OR NEW."runKind" <> 'automatic' THEN RETURN NEW; END IF;
  IF pg_catalog.current_setting('ai_project_os.git_automation_transition', TRUE) <> 'automatic_finalize' THEN
    RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_PUBLICATION_REQUIRES_FINALIZER' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO run_row FROM public."ProjectGitRepositoryAutomationRun" WHERE "id" = NEW."runId";
  IF NOT FOUND OR run_row."status" <> 'succeeded'
     OR run_row."projectId" IS DISTINCT FROM NEW."projectId"
     OR run_row."baseDelegationId" IS DISTINCT FROM NEW."delegationId"
     OR run_row."baseDelegationVersion" IS DISTINCT FROM NEW."delegationVersion"
     OR run_row."baseDelegationFingerprint" IS DISTINCT FROM NEW."delegationFingerprint"
     OR run_row."repositoryPath" IS DISTINCT FROM NEW."repositoryPath"
     OR run_row."trackedRef" IS DISTINCT FROM NEW."trackedRef"
     OR run_row."observedCommitSha" IS DISTINCT FROM NEW."frozenCommitSha"
     OR run_row."manifestFingerprint" IS DISTINCT FROM NEW."manifestFingerprint"
     OR run_row."fileCount" IS DISTINCT FROM NEW."fileCount"
     OR run_row."decodedTextBytes" IS DISTINCT FROM NEW."decodedTextBytes"
     OR run_row."resultPublicationVersionId" IS DISTINCT FROM NEW."id"
     OR run_row."resultPublicationGeneration" <> run_row."expectedPublicationGeneration" + 1
     OR run_row."expectedPublicationVersionId" IS DISTINCT FROM NEW."previousPublicationVersionId"
     OR run_row."expectedPublicationGeneration" <> NEW."previousGeneration"
     OR run_row."completedAt" IS DISTINCT FROM NEW."publishedAt" THEN
    RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_PUBLICATION_RUN_SNAPSHOT_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(hashtextextended('ai-project-git-repository-delegation-global', 0));
  SELECT "currentPublicationVersionId", "generation" INTO head_row
    FROM public."ProjectGitRepositoryPublicationHead"
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
  RETURN NEW;
END;
$$;

-- Keep the 130 manual guard and completeness check byte-for-byte in force for
-- manual runs; automatic rows use the separate checks below.
DROP TRIGGER IF EXISTS "PGRPV_insert_guard" ON public."ProjectGitRepositoryPublicationVersion";
CREATE TRIGGER "PGRPV_insert_guard"
BEFORE INSERT ON public."ProjectGitRepositoryPublicationVersion"
FOR EACH ROW WHEN (NEW."runKind" = 'manual')
EXECUTE FUNCTION public."project_git_publication_version_insert_guard"();
CREATE TRIGGER "PGRPV_automatic_insert_guard"
BEFORE INSERT ON public."ProjectGitRepositoryPublicationVersion"
FOR EACH ROW WHEN (NEW."runKind" = 'automatic')
EXECUTE FUNCTION public."project_git_automation_publication_version_insert_guard"();

DROP TRIGGER IF EXISTS "ProjectGitRepositoryPublicationVersion_required" ON public."ProjectGitRepositoryPublicationVersion";
CREATE CONSTRAINT TRIGGER "ProjectGitRepositoryPublicationVersion_required"
AFTER INSERT ON public."ProjectGitRepositoryPublicationVersion"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW WHEN (NEW."runKind" = 'manual')
EXECUTE FUNCTION public."project_git_publication_version_required"();

CREATE OR REPLACE FUNCTION public."project_git_automation_publication_version_required"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  version_row public."ProjectGitRepositoryPublicationVersion"%ROWTYPE;
  run_row public."ProjectGitRepositoryAutomationRun"%ROWTYPE;
  entry_count INTEGER;
  entry_bytes BIGINT;
  entry_ordinals_valid BOOLEAN;
  source_count INTEGER;
  source_values_valid BOOLEAN;
  head_count INTEGER;
  head_valid BOOLEAN;
  audit_count INTEGER;
  audit_valid BOOLEAN;
BEGIN
  SELECT * INTO version_row
    FROM public."ProjectGitRepositoryPublicationVersion"
   WHERE "id" = NEW."id" AND "projectId" = NEW."projectId" AND "delegationId" = NEW."delegationId";
  SELECT * INTO run_row
    FROM public."ProjectGitRepositoryAutomationRun"
   WHERE "id" = version_row."runId";
  IF NOT FOUND OR NEW."runKind" <> 'automatic' OR run_row."status" <> 'succeeded'
     OR run_row."projectId" <> NEW."projectId" OR run_row."baseDelegationId" <> NEW."delegationId"
     OR run_row."resultPublicationVersionId" <> NEW."id"
     OR run_row."resultPublicationGeneration" <> NEW."previousGeneration" + 1
     OR run_row."expectedPublicationVersionId" IS DISTINCT FROM NEW."previousPublicationVersionId"
     OR run_row."expectedPublicationGeneration" <> NEW."previousGeneration"
     OR run_row."completedAt" IS DISTINCT FROM NEW."publishedAt"
     OR run_row."observedCommitSha" IS DISTINCT FROM NEW."frozenCommitSha"
     OR run_row."manifestFingerprint" IS DISTINCT FROM NEW."manifestFingerprint"
     OR run_row."fileCount" <> NEW."fileCount"
     OR run_row."decodedTextBytes" <> NEW."decodedTextBytes" THEN
    RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_PUBLICATION_RUN_REQUIRED' USING ERRCODE = 'check_violation';
  END IF;
  WITH ordered_entries AS (
    SELECT entry.*, row_number() OVER (ORDER BY entry."ordinal") - 1 AS expected_ordinal
      FROM public."ProjectGitRepositoryPublicationEntry" entry
     WHERE entry."projectId" = NEW."projectId" AND entry."delegationId" = NEW."delegationId"
       AND entry."publicationVersionId" = NEW."id"
  )
  SELECT count(*)::INTEGER, COALESCE(sum("contentBytes"), 0)::BIGINT,
         COALESCE(bool_and("ordinal" = expected_ordinal), false)
    INTO entry_count, entry_bytes, entry_ordinals_valid
    FROM ordered_entries;
  IF entry_count <> version_row."fileCount" OR entry_count <= 0
     OR entry_bytes <> version_row."decodedTextBytes" OR NOT entry_ordinals_valid
     OR public."project_git_repository_publication_manifest"(NEW."id") IS DISTINCT FROM version_row."manifestFingerprint" THEN
    RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_PUBLICATION_ENTRIES_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*)::INTEGER,
         COALESCE(bool_and(
           source_row."kind" = 'git' AND source_row."originScope" = 'project'
           AND source_row."projectRepositoryLinkId" IS NULL AND source_row."retiredAt" IS NULL
           AND source_row."externalRef" IS NULL
           AND source_row."contentHash" = entry."contentHash"
           AND source_row."contentHash" = encode(public.digest(convert_to(source_row."contentText", 'UTF8'), 'sha256'), 'hex')
           AND entry."contentBytes" = octet_length(source_row."contentText")
           AND entry."lineCount" = length(source_row."contentText") - length(replace(source_row."contentText", E'\n', '')) + 1
           AND source_row."sourceIdentity" = public."project_git_automation_deterministic_uuid"(
             'git-delegated-source:' || version_row."delegationId"::text || ':'
             || version_row."delegationVersion"::text || ':' || version_row."delegationFingerprint"::text || ':' || entry."normalizedPath")
           AND source_row."revisionKey" = public."project_git_automation_deterministic_uuid"(
             'git-delegated-revision:' || version_row."delegationId"::text || ':'
             || version_row."delegationVersion"::text || ':' || version_row."delegationFingerprint"::text || ':'
             || btrim(version_row."frozenCommitSha") || ':' || entry."normalizedPath" || ':' || entry."contentHash")
           AND left(source_row."contentText", length(
             'Repository: ' || version_row."repositoryPath" || E'\nRevision: '
             || btrim(version_row."frozenCommitSha") || E'\nPath: ' || entry."normalizedPath" || E'\n\n'))
             = ('Repository: ' || version_row."repositoryPath" || E'\nRevision: '
             || btrim(version_row."frozenCommitSha") || E'\nPath: ' || entry."normalizedPath" || E'\n\n')
         ), false)
    INTO source_count, source_values_valid
    FROM public."ProjectGitRepositoryPublicationEntry" entry
    JOIN public."ProjectSource" source_row
      ON source_row."projectId" = entry."projectId" AND source_row."id" = entry."projectSourceId"
   WHERE entry."projectId" = NEW."projectId" AND entry."delegationId" = NEW."delegationId"
     AND entry."publicationVersionId" = NEW."id";
  IF source_count <> entry_count OR NOT source_values_valid THEN
    RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_PUBLICATION_SOURCES_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*)::INTEGER,
         COALESCE(bool_and(head."currentPublicationVersionId" = NEW."id"
           AND head."generation" = version_row."previousGeneration" + 1
           AND head."publishedAt" = version_row."publishedAt"), false)
    INTO head_count, head_valid
    FROM public."ProjectGitRepositoryPublicationHead" head
   WHERE head."projectId" = NEW."projectId" AND head."delegationId" = NEW."delegationId";
  IF head_count <> 1 OR NOT head_valid THEN
    RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_PUBLICATION_HEAD_REQUIRED' USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*)::INTEGER,
         COALESCE(bool_and(audit_row."runVersion" = run_row."version"
           AND audit_row."runStatusBefore" = 'dispatched' AND audit_row."runStatusAfter" = 'succeeded'
           AND audit_row."expectedPublicationVersionId" IS NOT DISTINCT FROM run_row."expectedPublicationVersionId"
           AND audit_row."expectedPublicationGeneration" = run_row."expectedPublicationGeneration"
           AND audit_row."publicationVersionId" = NEW."id"
           AND audit_row."publicationGeneration" = run_row."resultPublicationGeneration"
           AND audit_row."observedCommitSha" = run_row."observedCommitSha"
           AND audit_row."manifestFingerprint" = run_row."manifestFingerprint"
           AND audit_row."fileCount" = run_row."fileCount"
           AND audit_row."decodedTextBytes" = run_row."decodedTextBytes"
           AND audit_row."transactionId" = pg_catalog.txid_current()), false)
    INTO audit_count, audit_valid
    FROM public."ProjectGitRepositoryAutomationRunAudit" audit_row
   WHERE audit_row."runId" = run_row."id" AND audit_row."action" = 'run_succeeded';
  IF audit_count <> 1 OR NOT audit_valid THEN
    RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_PUBLICATION_AUDIT_REQUIRED' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "ProjectGitRepositoryAutomationPublicationVersion_required"
AFTER INSERT ON public."ProjectGitRepositoryPublicationVersion"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW WHEN (NEW."runKind" = 'automatic')
EXECUTE FUNCTION public."project_git_automation_publication_version_required"();

CREATE OR REPLACE FUNCTION public."project_git_automation_publication_result_required"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  current_version public."ProjectGitRepositoryPublicationVersion"%ROWTYPE;
  head_row public."ProjectGitRepositoryPublicationHead"%ROWTYPE;
  audit_count INTEGER;
  audit_valid BOOLEAN;
BEGIN
  IF NEW."status" NOT IN ('succeeded', 'unchanged') THEN RETURN NEW; END IF;
  IF NEW."leaseExpiresAt" IS NOT NULL OR NEW."dispatchedAt" IS NULL OR NEW."completedAt" IS NULL
     OR NEW."safeErrorCode" IS NOT NULL OR btrim(NEW."observedCommitSha") !~ '^([0-9a-f]{40}|[0-9a-f]{64})$'
     OR NEW."manifestFingerprint" !~ '^[0-9a-f]{64}$' OR NEW."fileCount" <= 0 OR NEW."decodedTextBytes" < 0 THEN
    RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_TERMINAL_RESULT_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO head_row FROM public."ProjectGitRepositoryPublicationHead"
   WHERE "projectId" = NEW."projectId" AND "delegationId" = NEW."baseDelegationId";
  IF NOT FOUND OR head_row."currentPublicationVersionId" IS DISTINCT FROM NEW."resultPublicationVersionId"
     OR head_row."generation" IS DISTINCT FROM NEW."resultPublicationGeneration" THEN
    RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_TERMINAL_HEAD_REQUIRED' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO current_version FROM public."ProjectGitRepositoryPublicationVersion"
   WHERE "id" = NEW."resultPublicationVersionId" AND "projectId" = NEW."projectId"
     AND "delegationId" = NEW."baseDelegationId";
  IF NOT FOUND THEN RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_TERMINAL_VERSION_REQUIRED' USING ERRCODE = 'check_violation'; END IF;
  IF NEW."status" = 'succeeded' THEN
    IF current_version."runKind" <> 'automatic' OR current_version."runId" <> NEW."id"
       OR current_version."previousPublicationVersionId" IS DISTINCT FROM NEW."expectedPublicationVersionId"
       OR current_version."previousGeneration" <> NEW."expectedPublicationGeneration"
       OR current_version."publishedAt" IS DISTINCT FROM NEW."completedAt"
       OR current_version."frozenCommitSha" IS DISTINCT FROM NEW."observedCommitSha"
       OR current_version."manifestFingerprint" IS DISTINCT FROM NEW."manifestFingerprint"
       OR current_version."fileCount" <> NEW."fileCount"
       OR current_version."decodedTextBytes" <> NEW."decodedTextBytes"
       OR NEW."resultPublicationGeneration" <> NEW."expectedPublicationGeneration" + 1 THEN
      RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_SUCCESS_VERSION_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW."expectedPublicationVersionId" IS NULL
       OR NEW."resultPublicationVersionId" IS DISTINCT FROM NEW."expectedPublicationVersionId"
       OR NEW."resultPublicationGeneration" <> NEW."expectedPublicationGeneration"
       OR current_version."frozenCommitSha" IS DISTINCT FROM NEW."observedCommitSha"
       OR current_version."manifestFingerprint" IS DISTINCT FROM NEW."manifestFingerprint"
       OR current_version."fileCount" <> NEW."fileCount"
       OR current_version."decodedTextBytes" <> NEW."decodedTextBytes"
       OR EXISTS (SELECT 1 FROM public."ProjectGitRepositoryPublicationVersion" version_row
                   WHERE version_row."runKind" = 'automatic' AND version_row."runId" = NEW."id") THEN
      RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_UNCHANGED_VERSION_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  SELECT count(*)::INTEGER,
         COALESCE(bool_and(audit_row."runVersion" = NEW."version"
           AND audit_row."runStatusBefore" = 'dispatched' AND audit_row."runStatusAfter" = NEW."status"
           AND audit_row."expectedPublicationVersionId" IS NOT DISTINCT FROM NEW."expectedPublicationVersionId"
           AND audit_row."expectedPublicationGeneration" = NEW."expectedPublicationGeneration"
           AND audit_row."publicationVersionId" = NEW."resultPublicationVersionId"
           AND audit_row."publicationGeneration" = NEW."resultPublicationGeneration"
           AND audit_row."observedCommitSha" = NEW."observedCommitSha"
           AND audit_row."manifestFingerprint" = NEW."manifestFingerprint"
           AND audit_row."fileCount" = NEW."fileCount"
           AND audit_row."decodedTextBytes" = NEW."decodedTextBytes"
           AND audit_row."transactionId" = pg_catalog.txid_current()), false)
    INTO audit_count, audit_valid
    FROM public."ProjectGitRepositoryAutomationRunAudit" audit_row
   WHERE audit_row."runId" = NEW."id"
     AND audit_row."action"::TEXT = CASE WHEN NEW."status" = 'succeeded' THEN 'run_succeeded' ELSE 'run_unchanged' END;
  IF audit_count <> 1 OR NOT audit_valid THEN
    RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_RESULT_AUDIT_REQUIRED' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "ProjectGitRepositoryAutomationRun_publication_result_required"
AFTER UPDATE OF "status" ON public."ProjectGitRepositoryAutomationRun"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW WHEN (NEW."status" IN ('succeeded', 'unchanged'))
EXECUTE FUNCTION public."project_git_automation_publication_result_required"();

CREATE OR REPLACE FUNCTION public."project_git_automation_finalize_result"(
  target_run UUID,
  target_worker VARCHAR(128),
  target_lease_token UUID,
  result_commit_sha VARCHAR(64),
  result_outcome VARCHAR(16),
  result_files JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  grant_id UUID;
  run_row public."ProjectGitRepositoryAutomationRun"%ROWTYPE;
  cursor_row public."ProjectGitRepositoryAutomationScheduleCursor"%ROWTYPE;
  head_row public."ProjectGitRepositoryPublicationHead"%ROWTYPE;
  baseline_version public."ProjectGitRepositoryPublicationVersion"%ROWTYPE;
  file_value JSONB;
  path_value TEXT;
  blob_oid_value TEXT;
  body_value TEXT;
  file_key_count INTEGER;
  content_text TEXT;
  content_hash_value TEXT;
  source_identity_value UUID;
  revision_key_value UUID;
  source_id UUID;
  files_count INTEGER := 0;
  file_ordinal INTEGER;
  body_bytes INTEGER;
  content_bytes INTEGER;
  line_count_value INTEGER;
  total_body_bytes BIGINT := 0;
  decoded_text_bytes BIGINT := 0;
  previous_entry_count INTEGER;
  retired_count INTEGER;
  database_now TIMESTAMP(3);
  published_at TIMESTAMPTZ(3);
  eligibility_reason TEXT;
  seen_paths TEXT[] := ARRAY[]::TEXT[];
  path_values TEXT[] := ARRAY[]::TEXT[];
  oid_values TEXT[] := ARRAY[]::TEXT[];
  body_values TEXT[] := ARRAY[]::TEXT[];
  hash_values TEXT[] := ARRAY[]::TEXT[];
  bytes_values INTEGER[] := ARRAY[]::INTEGER[];
  line_values INTEGER[] := ARRAY[]::INTEGER[];
  source_identity_values UUID[] := ARRAY[]::UUID[];
  revision_key_values UUID[] := ARRAY[]::UUID[];
  source_id_values UUID[] := ARRAY[]::UUID[];
  manifest_payload TEXT := 'project-git-manual-runtime:v1';
  manifest_fingerprint TEXT;
  new_version_id UUID;
  stale_head BOOLEAN := FALSE;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') <> 'serializable' THEN
    RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_SERIALIZABLE_REQUIRED' USING ERRCODE = '25001';
  END IF;
  IF target_run IS NULL OR target_worker IS NULL OR target_worker !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
     OR target_lease_token IS NULL OR result_outcome NOT IN ('changed', 'unchanged')
     OR result_commit_sha IS NULL OR result_commit_sha !~ '^([0-9a-f]{40}|[0-9a-f]{64})$'
     OR result_files IS NULL OR pg_catalog.jsonb_typeof(result_files) <> 'array'
     OR pg_catalog.octet_length(pg_catalog.convert_to(result_files::text, 'UTF8')) > 83886080
     OR pg_catalog.jsonb_array_length(result_files) > 2000 THEN
    RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_RESULT_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  IF result_outcome = 'unchanged' AND pg_catalog.jsonb_array_length(result_files) <> 0 THEN
    RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_UNCHANGED_FILES_INVALID' USING ERRCODE = 'check_violation';
  END IF;

  SELECT "grantId" INTO grant_id FROM public."ProjectGitRepositoryAutomationRun" WHERE "id" = target_run;
  IF NOT FOUND OR NOT public."project_git_automation_lock_grant"(grant_id) THEN
    RETURN pg_catalog.jsonb_build_object('accepted', FALSE, 'status', 'unknown');
  END IF;
  database_now := pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp() AT TIME ZONE 'UTC');
  PERFORM pg_catalog.set_config('ai_project_os.git_automation_now', database_now::text, TRUE);
  SELECT * INTO cursor_row FROM public."ProjectGitRepositoryAutomationScheduleCursor" WHERE "grantId" = grant_id FOR UPDATE;
  SELECT * INTO run_row FROM public."ProjectGitRepositoryAutomationRun" WHERE "id" = target_run FOR UPDATE;
  IF NOT FOUND THEN RETURN pg_catalog.jsonb_build_object('accepted', FALSE, 'status', 'unknown'); END IF;
  IF run_row."status" <> 'dispatched' OR run_row."leaseWorkerId" IS DISTINCT FROM target_worker
     OR run_row."leaseToken" IS DISTINCT FROM target_lease_token OR run_row."leaseExpiresAt" IS NULL
     OR run_row."leaseExpiresAt" <= database_now THEN
    RETURN pg_catalog.jsonb_build_object('accepted', FALSE, 'status', run_row."status"::text);
  END IF;
  eligibility_reason := public."project_git_automation_grant_eligibility"(run_row."grantId", run_row."projectId", database_now);
  IF eligibility_reason IS NOT NULL OR NOT public."project_git_automation_run_snapshot_matches"(run_row."id") THEN
    RETURN pg_catalog.jsonb_build_object('accepted', FALSE, 'status', run_row."status"::text);
  END IF;

  SELECT * INTO head_row
    FROM public."ProjectGitRepositoryPublicationHead"
   WHERE "projectId" = run_row."projectId" AND "delegationId" = run_row."baseDelegationId"
   FOR UPDATE;
  IF FOUND THEN
    stale_head := head_row."currentPublicationVersionId" IS DISTINCT FROM run_row."expectedPublicationVersionId"
      OR head_row."generation" IS DISTINCT FROM run_row."expectedPublicationGeneration";
  ELSE
    stale_head := run_row."expectedPublicationVersionId" IS NOT NULL OR run_row."expectedPublicationGeneration" <> 0;
  END IF;
  IF stale_head THEN
    PERFORM pg_catalog.set_config('ai_project_os.git_automation_transition', 'automatic_finalize', TRUE);
    UPDATE public."ProjectGitRepositoryAutomationRun"
       SET "status" = 'failed', "leaseExpiresAt" = NULL, "completedAt" = database_now,
           "safeErrorCode" = 'PUBLICATION_HEAD_STALE', "version" = "version" + 1
     WHERE "id" = target_run;
    RETURN pg_catalog.jsonb_build_object('accepted', FALSE, 'status', 'failed', 'reason', 'PUBLICATION_HEAD_STALE');
  END IF;
  published_at := database_now AT TIME ZONE 'UTC';

  IF result_outcome = 'unchanged' THEN
    IF run_row."expectedPublicationVersionId" IS NULL THEN
      RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_UNCHANGED_BASELINE_REQUIRED' USING ERRCODE = 'check_violation';
    END IF;
    SELECT * INTO baseline_version
      FROM public."ProjectGitRepositoryPublicationVersion"
     WHERE "id" = run_row."expectedPublicationVersionId"
       AND "projectId" = run_row."projectId" AND "delegationId" = run_row."baseDelegationId";
    IF NOT FOUND OR btrim(baseline_version."frozenCommitSha") IS DISTINCT FROM result_commit_sha THEN
      RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_UNCHANGED_BASELINE_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    PERFORM pg_catalog.set_config('ai_project_os.git_automation_transition', 'automatic_finalize', TRUE);
    UPDATE public."ProjectGitRepositoryAutomationRun"
       SET "status" = 'unchanged', "leaseExpiresAt" = NULL, "completedAt" = database_now,
           "safeErrorCode" = NULL, "resultPublicationVersionId" = baseline_version."id",
           "resultPublicationGeneration" = run_row."expectedPublicationGeneration",
           "observedCommitSha" = result_commit_sha, "manifestFingerprint" = btrim(baseline_version."manifestFingerprint"),
           "fileCount" = baseline_version."fileCount", "decodedTextBytes" = baseline_version."decodedTextBytes",
           "version" = "version" + 1
     WHERE "id" = target_run;
    RETURN pg_catalog.jsonb_build_object('accepted', TRUE, 'status', 'unchanged',
      'publicationVersionId', baseline_version."id"::text, 'publicationGeneration', run_row."expectedPublicationGeneration");
  END IF;

  files_count := pg_catalog.jsonb_array_length(result_files);
  IF files_count <= 0 THEN
    RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_CHANGED_FILES_REQUIRED' USING ERRCODE = 'check_violation';
  END IF;
  IF run_row."expectedPublicationVersionId" IS NOT NULL THEN
    SELECT * INTO baseline_version
      FROM public."ProjectGitRepositoryPublicationVersion"
     WHERE "id" = run_row."expectedPublicationVersionId"
       AND "projectId" = run_row."projectId" AND "delegationId" = run_row."baseDelegationId";
    IF NOT FOUND OR btrim(baseline_version."frozenCommitSha") = result_commit_sha THEN
      RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_CHANGED_COMMIT_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public."ProjectGitRepositoryPublicationHead" head
                  WHERE head."projectId" = run_row."projectId" AND head."delegationId" = run_row."baseDelegationId"
                    AND head."currentPublicationVersionId" IS NOT DISTINCT FROM run_row."expectedPublicationVersionId"
                    AND head."generation" = run_row."expectedPublicationGeneration")
     AND run_row."expectedPublicationGeneration" <> 0 THEN
    RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_EXPECTED_HEAD_INVALID' USING ERRCODE = 'serialization_failure';
  END IF;

  file_ordinal := 0;
  FOR file_value IN SELECT item FROM pg_catalog.jsonb_array_elements(result_files) AS rows(item) LOOP
    IF pg_catalog.jsonb_typeof(file_value) <> 'object' THEN
      RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_FILE_SHAPE_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    SELECT count(*)::INTEGER INTO file_key_count FROM pg_catalog.jsonb_object_keys(file_value);
    IF file_key_count <> 3 OR NOT file_value ?& ARRAY['path', 'blobOid', 'body']
       OR pg_catalog.jsonb_typeof(file_value -> 'path') <> 'string'
       OR pg_catalog.jsonb_typeof(file_value -> 'blobOid') <> 'string'
       OR pg_catalog.jsonb_typeof(file_value -> 'body') <> 'string' THEN
      RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_FILE_SHAPE_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    path_value := file_value ->> 'path';
    blob_oid_value := file_value ->> 'blobOid';
    body_value := file_value ->> 'body';
    body_bytes := pg_catalog.octet_length(pg_catalog.convert_to(body_value, 'UTF8'));
    IF body_bytes > 98304 OR total_body_bytes + body_bytes > 12582912
       OR blob_oid_value !~ '^([0-9a-f]{40}|[0-9a-f]{64})$'
       OR NOT public."project_git_automation_path_allowed"(path_value, run_row."includeRoots", run_row."softExcludePatterns")
       OR path_value = ANY(seen_paths)
       OR pg_catalog.strpos(body_value, E'\r') > 0 THEN
      RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_FILE_CONTENT_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    content_text := 'Repository: ' || run_row."repositoryPath" || E'\nRevision: '
      || result_commit_sha || E'\nPath: ' || path_value || E'\n\n' || body_value;
    IF pg_catalog.char_length(content_text) > 100000 THEN
      RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_SOURCE_CONTENT_TOO_LARGE' USING ERRCODE = 'check_violation';
    END IF;
    content_hash_value := pg_catalog.encode(public.digest(pg_catalog.convert_to(content_text, 'UTF8'), 'sha256'), 'hex');
    content_bytes := pg_catalog.octet_length(pg_catalog.convert_to(content_text, 'UTF8'));
    line_count_value := pg_catalog.char_length(content_text) - pg_catalog.char_length(pg_catalog.replace(content_text, E'\n', '')) + 1;
    source_identity_value := public."project_git_automation_deterministic_uuid"(
      'git-delegated-source:' || run_row."baseDelegationId"::text || ':'
      || run_row."baseDelegationVersion"::text || ':' || run_row."baseDelegationFingerprint"::text || ':' || path_value);
    revision_key_value := public."project_git_automation_deterministic_uuid"(
      'git-delegated-revision:' || run_row."baseDelegationId"::text || ':'
      || run_row."baseDelegationVersion"::text || ':' || run_row."baseDelegationFingerprint"::text || ':'
      || result_commit_sha || ':' || path_value || ':' || content_hash_value);
    manifest_payload := manifest_payload || E'\n'
      || pg_catalog.octet_length(file_ordinal::text)::text || ':' || file_ordinal::text
      || pg_catalog.octet_length(path_value)::text || ':' || path_value
      || pg_catalog.octet_length(blob_oid_value)::text || ':' || blob_oid_value
      || pg_catalog.octet_length(content_hash_value)::text || ':' || content_hash_value
      || pg_catalog.octet_length(content_bytes::text)::text || ':' || content_bytes::text
      || pg_catalog.octet_length(line_count_value::text)::text || ':' || line_count_value::text;
    total_body_bytes := total_body_bytes + body_bytes;
    decoded_text_bytes := decoded_text_bytes + content_bytes;
    IF decoded_text_bytes > 2147483647 THEN
      RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_DECODED_BYTES_OVERFLOW' USING ERRCODE = 'check_violation';
    END IF;
    seen_paths := pg_catalog.array_append(seen_paths, path_value);
    path_values := pg_catalog.array_append(path_values, path_value);
    oid_values := pg_catalog.array_append(oid_values, blob_oid_value);
    body_values := pg_catalog.array_append(body_values, content_text);
    hash_values := pg_catalog.array_append(hash_values, content_hash_value);
    bytes_values := pg_catalog.array_append(bytes_values, content_bytes);
    line_values := pg_catalog.array_append(line_values, line_count_value);
    source_identity_values := pg_catalog.array_append(source_identity_values, source_identity_value);
    revision_key_values := pg_catalog.array_append(revision_key_values, revision_key_value);
    file_ordinal := file_ordinal + 1;
  END LOOP;
  manifest_fingerprint := pg_catalog.encode(public.digest(pg_catalog.convert_to(manifest_payload, 'UTF8'), 'sha256'), 'hex');
  new_version_id := pg_catalog.gen_random_uuid();

  IF run_row."expectedPublicationVersionId" IS NOT NULL THEN
    SELECT count(*)::INTEGER INTO previous_entry_count
      FROM public."ProjectGitRepositoryPublicationEntry" entry
     WHERE entry."projectId" = run_row."projectId" AND entry."delegationId" = run_row."baseDelegationId"
       AND entry."publicationVersionId" = run_row."expectedPublicationVersionId";
    IF previous_entry_count <= 0 THEN
      RAISE EXCEPTION 'PROJECT_GIT_PUBLICATION_PREVIOUS_ENTRIES_MISSING' USING ERRCODE = 'check_violation';
    END IF;
    UPDATE public."ProjectSource" source_row
       SET "retiredAt" = published_at
      FROM public."ProjectGitRepositoryPublicationEntry" entry
     WHERE entry."projectId" = run_row."projectId" AND entry."delegationId" = run_row."baseDelegationId"
       AND entry."publicationVersionId" = run_row."expectedPublicationVersionId"
       AND source_row."projectId" = entry."projectId" AND source_row."id" = entry."projectSourceId"
       AND source_row."retiredAt" IS NULL;
    GET DIAGNOSTICS retired_count = ROW_COUNT;
    IF retired_count <> previous_entry_count THEN
      RAISE EXCEPTION 'PROJECT_GIT_PUBLICATION_PREVIOUS_SOURCES_NOT_RETIRED' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  FOR file_ordinal IN 0..files_count - 1 LOOP
    INSERT INTO public."ProjectSource" (
      "id", "projectId", "kind", "originScope", "projectRepositoryLinkId", "sourceIdentity", "revisionKey",
      "externalRef", "contentText", "contentHash", "capturedAt"
    ) VALUES (
      pg_catalog.gen_random_uuid(), run_row."projectId", 'git', 'project', NULL,
      source_identity_values[file_ordinal + 1], revision_key_values[file_ordinal + 1], NULL,
      body_values[file_ordinal + 1], hash_values[file_ordinal + 1], published_at
    ) ON CONFLICT ("projectId", "sourceIdentity", "revisionKey") DO UPDATE
      SET "retiredAt" = NULL
    RETURNING "id" INTO source_id;
    source_id_values := pg_catalog.array_append(source_id_values, source_id);
  END LOOP;

  PERFORM pg_catalog.set_config('ai_project_os.git_automation_transition', 'automatic_finalize', TRUE);
  UPDATE public."ProjectGitRepositoryAutomationRun"
     SET "status" = 'succeeded', "leaseExpiresAt" = NULL, "completedAt" = database_now,
         "safeErrorCode" = NULL, "resultPublicationVersionId" = new_version_id,
         "resultPublicationGeneration" = run_row."expectedPublicationGeneration" + 1,
         "observedCommitSha" = result_commit_sha, "manifestFingerprint" = manifest_fingerprint,
         "fileCount" = files_count, "decodedTextBytes" = decoded_text_bytes::INTEGER,
         "version" = "version" + 1
   WHERE "id" = target_run;
  INSERT INTO public."ProjectGitRepositoryPublicationVersion" (
    "id", "projectId", "delegationId", "runKind", "runId", "previousPublicationVersionId", "previousGeneration",
    "delegationVersion", "delegationFingerprint", "repositoryPath", "trackedRef", "frozenCommitSha",
    "manifestFingerprint", "fileCount", "decodedTextBytes", "publishedAt"
  ) VALUES (
    new_version_id, run_row."projectId", run_row."baseDelegationId", 'automatic', target_run,
    run_row."expectedPublicationVersionId", run_row."expectedPublicationGeneration", run_row."baseDelegationVersion",
    run_row."baseDelegationFingerprint", run_row."repositoryPath", run_row."trackedRef", result_commit_sha,
    manifest_fingerprint, files_count, decoded_text_bytes::INTEGER, published_at
  );
  FOR file_ordinal IN 0..files_count - 1 LOOP
    INSERT INTO public."ProjectGitRepositoryPublicationEntry" (
      "id", "projectId", "delegationId", "publicationVersionId", "projectSourceId", "ordinal",
      "normalizedPath", "blobOid", "contentHash", "contentBytes", "lineCount"
    ) VALUES (
      pg_catalog.gen_random_uuid(), run_row."projectId", run_row."baseDelegationId", new_version_id,
      source_id_values[file_ordinal + 1], file_ordinal, path_values[file_ordinal + 1], oid_values[file_ordinal + 1],
      hash_values[file_ordinal + 1], bytes_values[file_ordinal + 1], line_values[file_ordinal + 1]
    );
  END LOOP;
  IF run_row."expectedPublicationGeneration" = 0 THEN
    INSERT INTO public."ProjectGitRepositoryPublicationHead" (
      "projectId", "delegationId", "currentPublicationVersionId", "generation", "publishedAt"
    ) VALUES (run_row."projectId", run_row."baseDelegationId", new_version_id, 1, published_at);
  ELSE
    UPDATE public."ProjectGitRepositoryPublicationHead"
       SET "currentPublicationVersionId" = new_version_id,
           "generation" = run_row."expectedPublicationGeneration" + 1,
           "publishedAt" = published_at
     WHERE "projectId" = run_row."projectId" AND "delegationId" = run_row."baseDelegationId"
       AND "currentPublicationVersionId" = run_row."expectedPublicationVersionId"
       AND "generation" = run_row."expectedPublicationGeneration";
    IF NOT FOUND THEN RAISE EXCEPTION 'PROJECT_GIT_PUBLICATION_HEAD_CAS_MISMATCH' USING ERRCODE = 'serialization_failure'; END IF;
  END IF;
  RETURN pg_catalog.jsonb_build_object('accepted', TRUE, 'status', 'succeeded',
    'publicationVersionId', new_version_id::text,
    'publicationGeneration', run_row."expectedPublicationGeneration" + 1,
    'manifestFingerprint', manifest_fingerprint, 'fileCount', files_count,
    'decodedTextBytes', decoded_text_bytes::INTEGER);
END;
$$;

-- Project deletion must still be fenced by the automation ledger after the
-- Web runtime loses direct SELECT on cursor/run state. The trigger owner is
-- the migrator in production; the runtime can only reach this function via
-- the trigger attached to Project DELETE.
CREATE OR REPLACE FUNCTION public."project_git_automation_guard_project_delete"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF OLD."archivedAt" IS NULL
     OR EXISTS (SELECT 1 FROM public."ProjectGitRepositoryAutomationGrant" grant_row
                 WHERE grant_row."projectId" = OLD."id" AND grant_row."status" = 'active')
     OR EXISTS (SELECT 1 FROM public."ProjectGitRepositoryAutomationScheduleCursor" cursor_row
                 WHERE cursor_row."projectId" = OLD."id" AND cursor_row."status" = 'active')
     OR EXISTS (SELECT 1 FROM public."ProjectGitRepositoryAutomationRun" run_row
                 WHERE run_row."projectId" = OLD."id" AND run_row."status" IN ('pending', 'dispatched')) THEN
    RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_PROJECT_DELETE_BLOCKED' USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION public."project_git_automation_guard_project_delete"() FROM PUBLIC;

REVOKE ALL ON FUNCTION public."project_git_automation_deterministic_uuid"(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public."project_git_automation_glob_matches"(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public."project_git_automation_path_allowed"(TEXT, JSONB, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public."project_git_automation_pause_cursor_after_unknown"() FROM PUBLIC;
REVOKE ALL ON FUNCTION public."project_git_automation_publication_version_insert_guard"() FROM PUBLIC;
REVOKE ALL ON FUNCTION public."project_git_automation_publication_version_required"() FROM PUBLIC;
REVOKE ALL ON FUNCTION public."project_git_automation_publication_result_required"() FROM PUBLIC;
REVOKE ALL ON FUNCTION public."project_git_automation_finalize_result"(UUID, VARCHAR, UUID, VARCHAR, VARCHAR, JSONB) FROM PUBLIC;
