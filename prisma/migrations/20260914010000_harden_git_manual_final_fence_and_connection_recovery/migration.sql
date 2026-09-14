-- R-10: make the final Git dispatch fence outcome explicit and keep a
-- no-dispatch safety terminal attributable to the system rather than to a
-- requester whose access may have changed during the admission race.
--
-- This is a forward-only function replacement.  It intentionally does not
-- rewrite historical audit rows, credentials, delegation evidence, or
-- connection ownership epochs.

CREATE UNIQUE INDEX "ProjectGitRepositoryManualRunAudit_system_final_fence_key"
  ON "ProjectGitRepositoryManualRunAudit" ("runId")
  WHERE "action" = 'failed'
    AND "actorId" IS NULL
    AND "reason" = 'manual_sync_final_admission_rejected';

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
      SELECT 1
        FROM "ProjectGitRepositoryManualRunAudit" audit
       WHERE audit."runId" = NEW."id"
         AND audit."statusBefore" IS NULL
         AND audit."statusAfter" = NEW."status"
         AND audit."action" = 'requested'
    ) INTO transition_audited;
  ELSIF OLD."status" IS DISTINCT FROM NEW."status" THEN
    IF NEW."failureCode" = 'PROJECT_GIT_MANUAL_FINAL_ADMISSION_REJECTED'
       AND (OLD."status" <> 'running'
         OR OLD."stage" <> 'admitted'
         OR OLD."dispatchState" <> 'pending'
         OR NEW."status" <> 'failed'
         OR NEW."stage" <> 'terminal'
         OR NEW."dispatchState" <> 'acknowledged') THEN
      RAISE EXCEPTION 'PROJECT_GIT_MANUAL_FINAL_FENCE_PRE_DISPATCH_REQUIRED' USING ERRCODE = 'check_violation';
    END IF;

    SELECT EXISTS (
      SELECT 1
        FROM "ProjectGitRepositoryManualRunAudit" audit
       WHERE audit."runId" = NEW."id"
         AND audit."statusBefore" = OLD."status"
         AND audit."statusAfter" = NEW."status"
         AND (
           (OLD."status" = 'queued' AND NEW."status" = 'running' AND audit."action" IN ('admitted', 'dispatched'))
           OR (OLD."status" = 'queued' AND NEW."status" = 'failed' AND audit."action" = 'failed')
           OR (OLD."status" = 'running' AND NEW."status" = 'succeeded' AND audit."action" = 'succeeded')
           OR (OLD."status" = 'running' AND NEW."status" = 'failed' AND audit."action" = 'failed')
           OR (OLD."status" = 'running' AND NEW."status" = 'unknown' AND audit."action" = 'unknown')
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

CREATE OR REPLACE FUNCTION "project_git_manual_runtime_audit_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  run_row RECORD;
  system_final_fence BOOLEAN := false;
  legacy_system_terminal BOOLEAN := false;
  final_admission_valid BOOLEAN := false;
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
     OR run_row."projectId" <> NEW."projectId"
     OR run_row."delegationId" <> NEW."delegationId"
     OR run_row."status" <> NEW."statusAfter"
     OR run_row."dispatchState" <> NEW."dispatchState"
     OR run_row."requestedById" <> NEW."requestedById"
     OR run_row."requestedByAccountAccessVersion" IS DISTINCT FROM NEW."requestedByAccountAccessVersion"
     OR run_row."requestedByProjectMembershipId" <> NEW."requestedByProjectMembershipId"
     OR run_row."requestedByMembershipCreatedAt" <> NEW."requestedByMembershipCreatedAt"
     OR run_row."connectionOwnerId" <> NEW."connectionOwnerId"
     OR run_row."connectionOwnerAccountAccessVersion" IS DISTINCT FROM NEW."connectionOwnerAccountAccessVersion"
     OR run_row."ownerProjectMembershipId" <> NEW."ownerProjectMembershipId"
     OR run_row."ownerMembershipCreatedAt" <> NEW."ownerMembershipCreatedAt"
     OR run_row."projectConfirmedById" <> NEW."projectConfirmedById"
     OR run_row."projectConfirmedProjectMembershipId" <> NEW."projectConfirmedProjectMembershipId"
     OR run_row."projectConfirmedMembershipCreatedAt" <> NEW."projectConfirmedMembershipCreatedAt"
     OR run_row."delegationVersion" <> NEW."delegationVersion"
     OR run_row."delegationFingerprint" <> NEW."delegationFingerprint"
     OR run_row."connectionConfigurationVersion" <> NEW."connectionConfigurationVersion"
     OR run_row."resolvedAddressFingerprint" <> NEW."resolvedAddressFingerprint"
     OR run_row."credentialFingerprint" <> NEW."credentialFingerprint"
     OR run_row."role" <> NEW."role"
     OR run_row."requiredForProjectSnapshot" <> NEW."requiredForProjectSnapshot"
     OR run_row."codeEnabled" <> NEW."codeEnabled"
     OR run_row."metadataEnabled" <> NEW."metadataEnabled"
     OR run_row."manualSyncAllowed" <> NEW."manualSyncAllowed"
     OR run_row."automationAllowed" <> NEW."automationAllowed" THEN
    RAISE EXCEPTION 'PROJECT_GIT_MANUAL_AUDIT_EVIDENCE_MISMATCH' USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."action" = 'requested' THEN
    IF NEW."statusBefore" IS NOT NULL OR NEW."statusAfter" <> 'queued' OR NEW."dispatchState" <> 'pending' THEN
      RAISE EXCEPTION 'PROJECT_GIT_MANUAL_AUDIT_SHAPE_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."action" = 'admitted' THEN
    IF NEW."statusBefore" IS DISTINCT FROM 'queued' OR NEW."statusAfter" <> 'running' OR NEW."dispatchState" <> 'pending' THEN
      RAISE EXCEPTION 'PROJECT_GIT_MANUAL_AUDIT_SHAPE_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."action" = 'dispatched' THEN
    IF (NEW."statusBefore" IS DISTINCT FROM 'queued' AND NEW."statusBefore" IS DISTINCT FROM 'running')
       OR NEW."statusAfter" <> 'running'
       OR NEW."dispatchState" <> 'dispatched' THEN
      RAISE EXCEPTION 'PROJECT_GIT_MANUAL_AUDIT_SHAPE_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."action" = 'succeeded' THEN
    IF NEW."statusBefore" IS DISTINCT FROM 'running' OR NEW."statusAfter" <> 'succeeded' OR NEW."dispatchState" <> 'acknowledged' THEN
      RAISE EXCEPTION 'PROJECT_GIT_MANUAL_AUDIT_SHAPE_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."action" = 'failed' THEN
    IF NEW."statusAfter" <> 'failed'
       OR (NEW."statusBefore" IS DISTINCT FROM 'queued' AND NEW."statusBefore" IS DISTINCT FROM 'running')
       OR NEW."dispatchState" <> 'acknowledged' THEN
      RAISE EXCEPTION 'PROJECT_GIT_MANUAL_AUDIT_SHAPE_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."action" = 'unknown' THEN
    IF NEW."statusBefore" IS DISTINCT FROM 'running' OR NEW."statusAfter" <> 'unknown' OR NEW."dispatchState" <> 'dispatched' THEN
      RAISE EXCEPTION 'PROJECT_GIT_MANUAL_AUDIT_SHAPE_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    RAISE EXCEPTION 'PROJECT_GIT_MANUAL_AUDIT_SHAPE_INVALID' USING ERRCODE = 'check_violation';
  END IF;

  -- Preserve the pre-epoch invalidation path for already durable legacy rows.
  -- It is deliberately unavailable to current-epoch rows; current rows may
  -- use NULL actorId only for the exact final-fence rejection below.
  legacy_system_terminal := NEW."action" = 'failed'
    AND NEW."actorId" IS NULL
    AND run_row."connectionOwnerAccountAccessVersion" IS NULL
    AND NEW."statusBefore" IN ('queued', 'running')
    AND NEW."statusAfter" = 'failed'
    AND NEW."dispatchState" = 'acknowledged'
    AND run_row."failureCode" = 'PROJECT_GIT_MANUAL_LEGACY_EPOCH_INVALIDATED';

  system_final_fence := NEW."action" = 'failed'
    AND NEW."actorId" IS NULL
    AND run_row."failureCode" = 'PROJECT_GIT_MANUAL_FINAL_ADMISSION_REJECTED'
    AND NEW."reason" = 'manual_sync_final_admission_rejected';

  IF NEW."action" IN ('requested', 'admitted', 'dispatched', 'succeeded')
     AND NEW."actorId" IS DISTINCT FROM run_row."requestedById" THEN
    RAISE EXCEPTION 'PROJECT_GIT_MANUAL_AUDIT_ACTOR_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."action" = 'failed'
     AND NEW."actorId" IS DISTINCT FROM run_row."requestedById"
     AND NOT legacy_system_terminal
     AND NOT system_final_fence THEN
    RAISE EXCEPTION 'PROJECT_GIT_MANUAL_AUDIT_ACTOR_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."action" = 'unknown' AND NEW."actorId" IS NOT NULL THEN
    RAISE EXCEPTION 'PROJECT_GIT_MANUAL_AUDIT_SYSTEM_ACTOR_REQUIRED' USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."statusAfter" = 'succeeded' THEN
    IF NEW."commitSha" IS NULL OR NEW."manifestFingerprint" IS NULL
       OR NEW."commitSha" IS DISTINCT FROM run_row."frozenCommitSha"
       OR NEW."manifestFingerprint" IS DISTINCT FROM run_row."manifestFingerprint" THEN
      RAISE EXCEPTION 'PROJECT_GIT_MANUAL_AUDIT_RESULT_MISMATCH' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."commitSha" IS DISTINCT FROM run_row."frozenCommitSha"
     OR NEW."manifestFingerprint" IS DISTINCT FROM run_row."manifestFingerprint" THEN
    RAISE EXCEPTION 'PROJECT_GIT_MANUAL_AUDIT_RESULT_UNEXPECTED' USING ERRCODE = 'check_violation';
  END IF;

  IF system_final_fence THEN
    -- Independently repeat the current admission predicate in PostgreSQL.
    -- A caller cannot obtain a system-attributed terminal while the frozen
    -- run is still dispatchable, even if it fabricates the fixed code/reason.
    SELECT EXISTS (
      SELECT 1
        FROM "ProjectGitRepositoryDelegation" delegation
        JOIN "Project" project_row
          ON project_row."id" = delegation."projectId"
        JOIN "GitConnection" connection_row
          ON connection_row."id" = delegation."gitConnectionId"
        JOIN "ExternalCredential" credential
          ON credential."id" = connection_row."credentialId"
        JOIN "AppUser" requester
          ON requester."id" = run_row."requestedById"
        JOIN "ProjectMembership" requester_membership
          ON requester_membership."id" = run_row."requestedByProjectMembershipId"
        JOIN "AppUser" connection_owner
          ON connection_owner."id" = run_row."connectionOwnerId"
        JOIN "ProjectMembership" owner_membership
          ON owner_membership."id" = run_row."ownerProjectMembershipId"
        JOIN "AppUser" project_confirmer
          ON project_confirmer."id" = run_row."projectConfirmedById"
        JOIN "ProjectMembership" confirmer_membership
          ON confirmer_membership."id" = run_row."projectConfirmedProjectMembershipId"
       WHERE delegation."id" = run_row."delegationId"
         AND delegation."projectId" = run_row."projectId"
         AND project_row."archivedAt" IS NULL
         AND requester."disabledAt" IS NULL
         AND run_row."requestedByAccountAccessVersion" IS NOT NULL
         AND requester."accountAccessVersion" = run_row."requestedByAccountAccessVersion"
         AND requester_membership."projectId" = run_row."projectId"
         AND requester_membership."userId" = run_row."requestedById"
         AND requester_membership."role" IN ('owner', 'editor')
         AND requester_membership."accessState" = 'confirmed'
         AND requester_membership."createdAt" = run_row."requestedByMembershipCreatedAt"
         AND connection_owner."disabledAt" IS NULL
         AND run_row."connectionOwnerAccountAccessVersion" IS NOT NULL
         AND connection_owner."accountAccessVersion" = run_row."connectionOwnerAccountAccessVersion"
         AND owner_membership."projectId" = run_row."projectId"
         AND owner_membership."userId" = run_row."connectionOwnerId"
         AND owner_membership."role" IN ('owner', 'editor')
         AND owner_membership."accessState" = 'confirmed'
         AND owner_membership."createdAt" = run_row."ownerMembershipCreatedAt"
         AND project_confirmer."disabledAt" IS NULL
         AND confirmer_membership."projectId" = run_row."projectId"
         AND confirmer_membership."userId" = run_row."projectConfirmedById"
         AND confirmer_membership."role" = 'owner'
         AND confirmer_membership."accessState" = 'confirmed'
         AND confirmer_membership."createdAt" = run_row."projectConfirmedMembershipCreatedAt"
         AND delegation."status" = 'active'
         AND delegation."expiresAt" > clock_timestamp()
         AND delegation."version" = run_row."delegationVersion"
         AND delegation."delegationFingerprint" = run_row."delegationFingerprint"
         AND delegation."connectionOwnerId" = run_row."connectionOwnerId"
         AND delegation."connectionOwnerAccountAccessVersion" = run_row."connectionOwnerAccountAccessVersion"
         AND delegation."ownerProjectMembershipId" = run_row."ownerProjectMembershipId"
         AND delegation."ownerMembershipCreatedAt" = run_row."ownerMembershipCreatedAt"
         AND delegation."projectConfirmedById" = run_row."projectConfirmedById"
         AND delegation."projectConfirmedProjectMembershipId" = run_row."projectConfirmedProjectMembershipId"
         AND delegation."projectConfirmedMembershipCreatedAt" = run_row."projectConfirmedMembershipCreatedAt"
         AND delegation."connectionConfigurationVersion" = run_row."connectionConfigurationVersion"
         AND delegation."resolvedAddressFingerprint" = run_row."resolvedAddressFingerprint"
         AND delegation."credentialFingerprint" = run_row."credentialFingerprint"
         AND delegation."role" = run_row."role"
         AND delegation."requiredForProjectSnapshot" = run_row."requiredForProjectSnapshot"
         AND delegation."codeEnabled" = run_row."codeEnabled"
         AND delegation."metadataEnabled" = run_row."metadataEnabled"
         AND delegation."manualSyncAllowed" = run_row."manualSyncAllowed"
         AND delegation."automationAllowed" = run_row."automationAllowed"
         AND connection_row."ownerUserId" = run_row."connectionOwnerId"
         AND connection_row."ownerAccountAccessVersion" = run_row."connectionOwnerAccountAccessVersion"
         AND connection_row."ownershipState" = 'confirmed'
         AND connection_row."status" = 'verified'
         AND connection_row."configurationVersion" = run_row."connectionConfigurationVersion"
         AND connection_row."resolvedAddressFingerprint" = run_row."resolvedAddressFingerprint"
         AND credential."kind" = 'git'
         AND credential."secretFingerprint" = run_row."credentialFingerprint"
    ) INTO final_admission_valid;

    IF final_admission_valid THEN
      RAISE EXCEPTION 'PROJECT_GIT_MANUAL_FINAL_FENCE_EVIDENCE_STILL_VALID' USING ERRCODE = 'check_violation';
    END IF;

    -- The run must already be a terminal failed row and the immutable
    -- snapshot/evidence must be identical.  The application supplies the
    -- same completedAt for the audit timestamps; defaults are not accepted.
    IF run_row."status" <> 'failed'
       OR run_row."stage" <> 'terminal'
       OR run_row."dispatchState" <> 'acknowledged'
       OR NEW."statusBefore" IS DISTINCT FROM 'running'
       OR NEW."statusAfter" <> 'failed'
       OR NEW."dispatchState" <> 'acknowledged'
       OR NEW."commitSha" IS DISTINCT FROM run_row."frozenCommitSha"
       OR NEW."manifestFingerprint" IS DISTINCT FROM run_row."manifestFingerprint"
       OR run_row."completedAt" IS NULL
       OR NEW."transactionId" IS DISTINCT FROM txid_current()
       OR NEW."transitionAt" IS DISTINCT FROM run_row."completedAt"
       OR NEW."createdAt" IS DISTINCT FROM NEW."transitionAt"
       OR run_row."connectionOwnerAccountAccessVersion" IS NULL THEN
      RAISE EXCEPTION 'PROJECT_GIT_MANUAL_FINAL_FENCE_AUDIT_INVALID' USING ERRCODE = 'check_violation';
    END IF;

    -- The run's non-NULL owner epoch is the frozen admission epoch.  It is
    -- intentionally not compared to the live account/root here: a disable or
    -- rotation is exactly the race that the final fence must close, and the
    -- stale snapshot remains immutable historical evidence.
  END IF;

  RETURN NEW;
END;
$$;

-- Trigger functions are owned by the migrator and invoked by PostgreSQL only.
-- Revoke the default PUBLIC EXECUTE grant explicitly; the principal catalog
-- and reconciliation gate keep runtime/writer principals denied as well.
REVOKE ALL ON FUNCTION "project_git_manual_runtime_audit_guard"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "project_git_manual_runtime_transition_audit_guard"() FROM PUBLIC;
