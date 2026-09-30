-- Record a manual delegated Git read that found the advertised branch at the
-- already-published frozen commit. The outcome keeps a frozen pointer
-- snapshot and is separately guarded from successful publication.

ALTER TYPE "ProjectGitRepositoryManualRunStatus" ADD VALUE 'unchanged';
ALTER TYPE "ProjectGitRepositoryManualRunAuditAction" ADD VALUE 'unchanged';

ALTER TABLE "ProjectGitRepositoryManualRun"
  ADD COLUMN "baselineRunId" UUID,
  ADD COLUMN "baselineFrozenCommitSha" CHAR(64),
  ADD COLUMN "baselineManifestFingerprint" CHAR(64),
  ADD COLUMN "baselinePublishedAt" TIMESTAMPTZ(3),
  ADD CONSTRAINT "ProjectGitRepositoryManualRun_baseline_shape_check" CHECK (
    (
      "baselineRunId" IS NULL
      AND "baselineFrozenCommitSha" IS NULL
      AND "baselineManifestFingerprint" IS NULL
      AND "baselinePublishedAt" IS NULL
    ) OR (
      "baselineRunId" IS NOT NULL
      AND "baselineFrozenCommitSha" IS NOT NULL
      AND length(btrim("baselineFrozenCommitSha")) IN (40, 64)
      AND btrim("baselineFrozenCommitSha") ~ '^[0-9a-f]+$'
      AND "baselineManifestFingerprint" IS NOT NULL
      AND "baselineManifestFingerprint" ~ '^[0-9a-f]{64}$'
      AND "baselinePublishedAt" IS NOT NULL
    )
  );

-- Keep the existing general run guard on every state except the new terminal
-- state. Its focused sibling validates the only permitted transition into
-- unchanged and makes the terminal immutable.
DROP TRIGGER "ProjectGitRepositoryManualRun_shape_guard" ON "ProjectGitRepositoryManualRun";
CREATE TRIGGER "ProjectGitRepositoryManualRun_shape_guard"
BEFORE INSERT OR UPDATE ON "ProjectGitRepositoryManualRun"
FOR EACH ROW
WHEN (NEW."status"::text <> 'unchanged')
EXECUTE FUNCTION "project_git_manual_runtime_shape_guard"();

CREATE OR REPLACE FUNCTION "project_git_manual_runtime_unchanged_shape_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP <> 'UPDATE' OR OLD."status"::text = 'unchanged' THEN
    RAISE EXCEPTION 'PROJECT_GIT_MANUAL_RUN_TERMINAL_IMMUTABLE' USING ERRCODE = 'check_violation';
  END IF;

  IF OLD."status" <> 'running'
     OR OLD."stage" <> 'publishing'
     OR OLD."dispatchState" <> 'dispatched'
     OR OLD."startedAt" IS NULL
     OR OLD."failureCode" IS NOT NULL
     OR OLD."result" IS NOT NULL
     OR OLD."frozenCommitSha" IS NOT NULL
     OR OLD."manifestFingerprint" IS NOT NULL
     OR OLD."fileCount" <> 0
     OR OLD."decodedTextBytes" <> 0
     OR ROW(
       OLD."id", OLD."projectId", OLD."delegationId", OLD."requestedById", OLD."requestedByAccountAccessVersion",
       OLD."requestedByProjectMembershipId", OLD."requestedByMembershipCreatedAt", OLD."clientRequestKey",
       OLD."delegationVersion", OLD."delegationFingerprint", OLD."connectionOwnerId", OLD."connectionOwnerAccountAccessVersion",
       OLD."ownerProjectMembershipId", OLD."ownerMembershipCreatedAt", OLD."projectConfirmedById",
       OLD."projectConfirmedProjectMembershipId", OLD."projectConfirmedMembershipCreatedAt",
       OLD."connectionConfigurationVersion", OLD."resolvedAddressFingerprint", OLD."credentialFingerprint",
       OLD."repositoryPath", OLD."trackedRef", OLD."includeRoots", OLD."softExcludePatterns", OLD."role",
       OLD."requiredForProjectSnapshot", OLD."codeEnabled", OLD."metadataEnabled", OLD."manualSyncAllowed",
       OLD."automationAllowed", OLD."baselineRunId", OLD."baselineFrozenCommitSha",
       OLD."baselineManifestFingerprint", OLD."baselinePublishedAt", OLD."createdAt", OLD."startedAt"
     ) IS DISTINCT FROM ROW(
       NEW."id", NEW."projectId", NEW."delegationId", NEW."requestedById", NEW."requestedByAccountAccessVersion",
       NEW."requestedByProjectMembershipId", NEW."requestedByMembershipCreatedAt", NEW."clientRequestKey",
       NEW."delegationVersion", NEW."delegationFingerprint", NEW."connectionOwnerId", NEW."connectionOwnerAccountAccessVersion",
       NEW."ownerProjectMembershipId", NEW."ownerMembershipCreatedAt", NEW."projectConfirmedById",
       NEW."projectConfirmedProjectMembershipId", NEW."projectConfirmedMembershipCreatedAt",
       NEW."connectionConfigurationVersion", NEW."resolvedAddressFingerprint", NEW."credentialFingerprint",
       NEW."repositoryPath", NEW."trackedRef", NEW."includeRoots", NEW."softExcludePatterns", NEW."role",
       NEW."requiredForProjectSnapshot", NEW."codeEnabled", NEW."metadataEnabled", NEW."manualSyncAllowed",
       NEW."automationAllowed", NEW."baselineRunId", NEW."baselineFrozenCommitSha",
       NEW."baselineManifestFingerprint", NEW."baselinePublishedAt", NEW."createdAt", NEW."startedAt"
     ) THEN
    RAISE EXCEPTION 'PROJECT_GIT_MANUAL_RUN_EVIDENCE_IMMUTABLE' USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."stage" <> 'terminal'
     OR NEW."dispatchState" <> 'acknowledged'
     OR NEW."completedAt" IS NULL
     OR NEW."completedAt" < NEW."startedAt"
     OR NEW."failureCode" IS NOT NULL
     OR NEW."result" IS DISTINCT FROM jsonb_build_object('outcome', 'unchanged')
     OR NEW."baselineRunId" IS NULL
     OR NEW."baselinePublishedAt" IS NULL
     OR NEW."frozenCommitSha" IS DISTINCT FROM NEW."baselineFrozenCommitSha"
     OR NEW."manifestFingerprint" IS DISTINCT FROM NEW."baselineManifestFingerprint"
     OR length(btrim(NEW."frozenCommitSha")) NOT IN (40, 64)
     OR btrim(NEW."frozenCommitSha") !~ '^[0-9a-f]+$'
     OR NEW."manifestFingerprint" !~ '^[0-9a-f]{64}$'
     OR NEW."fileCount" <> 0
     OR NEW."decodedTextBytes" <> 0 THEN
    RAISE EXCEPTION 'PROJECT_GIT_MANUAL_UNCHANGED_SHAPE_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ProjectGitRepositoryManualRun_unchanged_shape_guard"
BEFORE INSERT OR UPDATE ON "ProjectGitRepositoryManualRun"
FOR EACH ROW
WHEN (NEW."status"::text = 'unchanged')
EXECUTE FUNCTION "project_git_manual_runtime_unchanged_shape_guard"();

-- Split inserts so the established append-only guard remains authoritative
-- for every old audit action while the new action receives its own exact
-- status, actor, and result checks. Updates/deletes still always use the
-- established rejection path.
DROP TRIGGER "ProjectGitRepositoryManualRunAudit_append_only" ON "ProjectGitRepositoryManualRunAudit";
CREATE TRIGGER "ProjectGitRepositoryManualRunAudit_append_only"
BEFORE UPDATE OR DELETE ON "ProjectGitRepositoryManualRunAudit"
FOR EACH ROW EXECUTE FUNCTION "project_git_manual_runtime_audit_guard"();
CREATE TRIGGER "ProjectGitRepositoryManualRunAudit_existing_insert_guard"
BEFORE INSERT ON "ProjectGitRepositoryManualRunAudit"
FOR EACH ROW
WHEN (NEW."action"::text <> 'unchanged')
EXECUTE FUNCTION "project_git_manual_runtime_audit_guard"();

CREATE OR REPLACE FUNCTION "project_git_manual_runtime_unchanged_audit_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  run_row RECORD;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'PROJECT_GIT_MANUAL_AUDIT_APPEND_ONLY' USING ERRCODE = 'check_violation';
  END IF;
  IF current_setting('ai.project_git_manual_runtime_audit', true) <> '1' THEN
    RAISE EXCEPTION 'PROJECT_GIT_MANUAL_AUDIT_CONTEXT_REQUIRED' USING ERRCODE = 'check_violation';
  END IF;
  SELECT run.* INTO run_row
    FROM "ProjectGitRepositoryManualRun" run
   WHERE run."id" = NEW."runId";
  IF NOT FOUND
     OR NEW."action"::text <> 'unchanged'
     OR NEW."statusBefore" IS DISTINCT FROM 'running'
     OR NEW."statusAfter"::text <> 'unchanged'
     OR NEW."dispatchState" <> 'acknowledged'
     OR NEW."actorId" IS DISTINCT FROM run_row."requestedById"
     OR NEW."reason" <> 'manual_sync_remote_head_unchanged'
     OR run_row."projectId" IS DISTINCT FROM NEW."projectId"
     OR run_row."delegationId" IS DISTINCT FROM NEW."delegationId"
     OR run_row."status"::text <> 'unchanged'
     OR run_row."dispatchState" IS DISTINCT FROM NEW."dispatchState"
     OR run_row."requestedById" IS DISTINCT FROM NEW."requestedById"
     OR run_row."requestedByAccountAccessVersion" IS DISTINCT FROM NEW."requestedByAccountAccessVersion"
     OR run_row."requestedByProjectMembershipId" IS DISTINCT FROM NEW."requestedByProjectMembershipId"
     OR run_row."requestedByMembershipCreatedAt" IS DISTINCT FROM NEW."requestedByMembershipCreatedAt"
     OR run_row."connectionOwnerId" IS DISTINCT FROM NEW."connectionOwnerId"
     OR run_row."connectionOwnerAccountAccessVersion" IS DISTINCT FROM NEW."connectionOwnerAccountAccessVersion"
     OR run_row."ownerProjectMembershipId" IS DISTINCT FROM NEW."ownerProjectMembershipId"
     OR run_row."ownerMembershipCreatedAt" IS DISTINCT FROM NEW."ownerMembershipCreatedAt"
     OR run_row."projectConfirmedById" IS DISTINCT FROM NEW."projectConfirmedById"
     OR run_row."projectConfirmedProjectMembershipId" IS DISTINCT FROM NEW."projectConfirmedProjectMembershipId"
     OR run_row."projectConfirmedMembershipCreatedAt" IS DISTINCT FROM NEW."projectConfirmedMembershipCreatedAt"
     OR run_row."delegationVersion" IS DISTINCT FROM NEW."delegationVersion"
     OR run_row."delegationFingerprint" IS DISTINCT FROM NEW."delegationFingerprint"
     OR run_row."connectionConfigurationVersion" IS DISTINCT FROM NEW."connectionConfigurationVersion"
     OR run_row."resolvedAddressFingerprint" IS DISTINCT FROM NEW."resolvedAddressFingerprint"
     OR run_row."credentialFingerprint" IS DISTINCT FROM NEW."credentialFingerprint"
     OR run_row."role" IS DISTINCT FROM NEW."role"
     OR run_row."requiredForProjectSnapshot" IS DISTINCT FROM NEW."requiredForProjectSnapshot"
     OR run_row."codeEnabled" IS DISTINCT FROM NEW."codeEnabled"
     OR run_row."metadataEnabled" IS DISTINCT FROM NEW."metadataEnabled"
     OR run_row."manualSyncAllowed" IS DISTINCT FROM NEW."manualSyncAllowed"
     OR run_row."automationAllowed" IS DISTINCT FROM NEW."automationAllowed"
     OR run_row."frozenCommitSha" IS DISTINCT FROM NEW."commitSha"
     OR run_row."manifestFingerprint" IS DISTINCT FROM NEW."manifestFingerprint"
     OR NEW."commitSha" IS DISTINCT FROM run_row."baselineFrozenCommitSha"
     OR NEW."manifestFingerprint" IS DISTINCT FROM run_row."baselineManifestFingerprint" THEN
    RAISE EXCEPTION 'PROJECT_GIT_MANUAL_UNCHANGED_AUDIT_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ProjectGitRepositoryManualRunAudit_unchanged_insert_guard"
BEFORE INSERT ON "ProjectGitRepositoryManualRunAudit"
FOR EACH ROW
WHEN (NEW."action"::text = 'unchanged')
EXECUTE FUNCTION "project_git_manual_runtime_unchanged_audit_guard"();

CREATE OR REPLACE FUNCTION "project_git_manual_runtime_transition_audit_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  transition_audited BOOLEAN;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT EXISTS (
      SELECT 1 FROM "ProjectGitRepositoryManualRunAudit" audit
       WHERE audit."runId" = NEW."id"
         AND audit."statusBefore" IS NULL
         AND audit."statusAfter" = NEW."status"
         AND audit."action" = 'requested'
    ) INTO transition_audited;
  ELSIF OLD."status" IS DISTINCT FROM NEW."status" THEN
    IF NEW."failureCode" = 'PROJECT_GIT_MANUAL_FINAL_ADMISSION_REJECTED'
       AND (OLD."status" <> 'running' OR OLD."stage" <> 'admitted' OR OLD."dispatchState" <> 'pending'
         OR NEW."status" <> 'failed' OR NEW."stage" <> 'terminal' OR NEW."dispatchState" <> 'acknowledged') THEN
      RAISE EXCEPTION 'PROJECT_GIT_MANUAL_FINAL_FENCE_PRE_DISPATCH_REQUIRED' USING ERRCODE = 'check_violation';
    END IF;
    SELECT EXISTS (
      SELECT 1 FROM "ProjectGitRepositoryManualRunAudit" audit
       WHERE audit."runId" = NEW."id"
         AND audit."statusBefore" = OLD."status"
         AND audit."statusAfter" = NEW."status"
         AND (
           (OLD."status" = 'queued' AND NEW."status" = 'running' AND audit."action" IN ('admitted', 'dispatched'))
           OR (OLD."status" = 'queued' AND NEW."status" = 'failed' AND audit."action" = 'failed')
           OR (OLD."status" = 'running' AND NEW."status" = 'succeeded' AND audit."action" = 'succeeded')
           OR (OLD."status" = 'running' AND NEW."status" = 'failed' AND audit."action" = 'failed')
           OR (OLD."status" = 'running' AND NEW."status" = 'unknown' AND audit."action" = 'unknown')
           OR (OLD."status" = 'running' AND NEW."status"::text = 'unchanged' AND audit."action"::text = 'unchanged')
         )
    ) INTO transition_audited;
  ELSE
    RETURN NEW;
  END IF;

  IF NOT transition_audited THEN
    RAISE EXCEPTION 'PROJECT_GIT_MANUAL_RUN_TRANSITION_AUDIT_REQUIRED' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "project_git_manual_runtime_unchanged_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  pointer_count INTEGER;
  pointer_valid BOOLEAN;
  baseline_run RECORD;
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
     OR NEW."frozenCommitSha" IS DISTINCT FROM NEW."baselineFrozenCommitSha"
     OR NEW."manifestFingerprint" IS DISTINCT FROM NEW."baselineManifestFingerprint"
     OR NEW."fileCount" <> 0
     OR NEW."decodedTextBytes" <> 0 THEN
    RAISE EXCEPTION 'PROJECT_GIT_MANUAL_UNCHANGED_INTEGRITY_INVALID' USING ERRCODE = 'check_violation';
  END IF;

  SELECT run.* INTO baseline_run
    FROM "ProjectGitRepositoryManualRun" run
   WHERE run."id" = NEW."baselineRunId"
     AND run."projectId" = NEW."projectId"
     AND run."delegationId" = NEW."delegationId"
     AND run."status" = 'succeeded'
     AND run."stage" = 'terminal'
     AND run."dispatchState" = 'acknowledged'
     AND run."failureCode" IS NULL
     AND run."delegationVersion" = NEW."delegationVersion"
     AND run."delegationFingerprint" = NEW."delegationFingerprint"
     AND run."frozenCommitSha" = NEW."baselineFrozenCommitSha"
     AND run."manifestFingerprint" = NEW."baselineManifestFingerprint"
     AND run."completedAt" = NEW."baselinePublishedAt"
     AND run."fileCount" > 0;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROJECT_GIT_MANUAL_UNCHANGED_BASELINE_INVALID' USING ERRCODE = 'check_violation';
  END IF;

  SELECT count(*)::INTEGER,
         COALESCE(bool_and(
           pointer_row."runId" = NEW."baselineRunId"
           AND pointer_row."delegationVersion" = NEW."delegationVersion"
           AND pointer_row."delegationFingerprint" = NEW."delegationFingerprint"
           AND pointer_row."frozenCommitSha" = NEW."baselineFrozenCommitSha"
           AND pointer_row."manifestFingerprint" = NEW."baselineManifestFingerprint"
           AND pointer_row."publishedAt" = NEW."baselinePublishedAt"
         ), false)
    INTO pointer_count, pointer_valid
    FROM "ProjectGitRepositoryManualPointer" pointer_row
   WHERE pointer_row."projectId" = NEW."projectId"
     AND pointer_row."delegationId" = NEW."delegationId";
  IF pointer_count <> 1 OR NOT pointer_valid THEN
    RAISE EXCEPTION 'PROJECT_GIT_MANUAL_UNCHANGED_POINTER_DRIFTED' USING ERRCODE = 'check_violation';
  END IF;

  WITH ordered_entries AS (
    SELECT entry.*, row_number() OVER (ORDER BY entry."ordinal") - 1 AS expected_ordinal
      FROM "ProjectGitRepositoryManualRunEntry" entry
     WHERE entry."runId" = NEW."baselineRunId" AND entry."projectId" = NEW."projectId"
  )
  SELECT count(*)::INTEGER,
         COALESCE(sum("contentBytes"), 0)::BIGINT,
         COALESCE(bool_and("ordinal" = expected_ordinal), false)
    INTO entry_count, entry_bytes, entry_ordinals_valid
    FROM ordered_entries;
  IF entry_count <> baseline_run."fileCount"
     OR entry_count <= 0
     OR entry_bytes <> baseline_run."decodedTextBytes"
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
           AND source_row."contentHash" = encode(digest(convert_to(source_row."contentText", 'UTF8'), 'sha256'), 'hex')
           AND source_row."externalRef" IS NULL
           AND entry."contentBytes" = octet_length(source_row."contentText")
           AND entry."lineCount" = CASE
             WHEN source_row."contentText" = '' THEN 0
             ELSE length(source_row."contentText") - length(replace(source_row."contentText", E'\n', '')) + 1
           END
         ), false)
    INTO source_count, source_values_valid
    FROM "ProjectGitRepositoryManualRunEntry" entry
    JOIN "ProjectSource" source_row
      ON source_row."projectId" = entry."projectId" AND source_row."id" = entry."projectSourceId"
   WHERE entry."runId" = NEW."baselineRunId" AND entry."projectId" = NEW."projectId";
  IF source_count <> entry_count OR NOT source_values_valid
     OR "project_git_manual_runtime_manifest"(NEW."baselineRunId") IS DISTINCT FROM NEW."baselineManifestFingerprint" THEN
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

CREATE CONSTRAINT TRIGGER "ProjectGitRepositoryManualRun_unchanged_guard"
AFTER UPDATE OF "status" ON "ProjectGitRepositoryManualRun"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW WHEN (NEW."status"::text = 'unchanged')
EXECUTE FUNCTION "project_git_manual_runtime_unchanged_guard"();

REVOKE ALL ON FUNCTION "project_git_manual_runtime_unchanged_shape_guard"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "project_git_manual_runtime_unchanged_audit_guard"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "project_git_manual_runtime_unchanged_guard"() FROM PUBLIC;
