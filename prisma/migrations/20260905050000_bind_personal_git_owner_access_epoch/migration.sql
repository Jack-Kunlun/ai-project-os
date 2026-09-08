-- Bind private Git credentials and every delegated execution snapshot to the
-- connection owner's account access epoch.  A disable/restore transition
-- changes the epoch; old rows remain durable evidence but cannot be admitted
-- or dispatched again until the owner explicitly rotates the credential.

ALTER TABLE "GitConnection"
  ADD COLUMN "ownerAccountAccessVersion" INTEGER;

ALTER TABLE "ProjectGitRepositoryDelegation"
  ADD COLUMN "connectionOwnerAccountAccessVersion" INTEGER;

ALTER TABLE "ProjectGitRepositoryDelegationAudit"
  ADD COLUMN "connectionOwnerAccountAccessVersion" INTEGER;

ALTER TABLE "ProjectGitRepositoryManualRun"
  ADD COLUMN "connectionOwnerAccountAccessVersion" INTEGER;

ALTER TABLE "ProjectGitRepositoryManualRun"
  ADD COLUMN "requestedByAccountAccessVersion" INTEGER;

ALTER TABLE "ProjectGitRepositoryManualRunAudit"
  ADD COLUMN "connectionOwnerAccountAccessVersion" INTEGER;

ALTER TABLE "ProjectGitRepositoryManualRunAudit"
  ADD COLUMN "requestedByAccountAccessVersion" INTEGER;

ALTER TABLE "GitConnection"
  ADD CONSTRAINT "GitConnection_owner_account_access_version_check"
  CHECK ("ownerAccountAccessVersion" IS NULL OR "ownerAccountAccessVersion" > 0);

ALTER TABLE "ProjectGitRepositoryDelegation"
  ADD CONSTRAINT "PGRD_connection_owner_account_access_version_check"
  CHECK ("connectionOwnerAccountAccessVersion" IS NULL OR "connectionOwnerAccountAccessVersion" > 0);

ALTER TABLE "ProjectGitRepositoryDelegationAudit"
  ADD CONSTRAINT "PGRD_A_connection_owner_account_access_version_check"
  CHECK ("connectionOwnerAccountAccessVersion" IS NULL OR "connectionOwnerAccountAccessVersion" > 0);

ALTER TABLE "ProjectGitRepositoryManualRun"
  ADD CONSTRAINT "ProjectGitRepositoryManualRun_connection_owner_account_access_version_check"
  CHECK ("connectionOwnerAccountAccessVersion" IS NULL OR "connectionOwnerAccountAccessVersion" > 0);

ALTER TABLE "ProjectGitRepositoryManualRun"
  ADD CONSTRAINT "ProjectGitRepositoryManualRun_requested_by_account_access_version_check"
  CHECK ("requestedByAccountAccessVersion" IS NULL OR "requestedByAccountAccessVersion" > 0);

ALTER TABLE "ProjectGitRepositoryManualRunAudit"
  ADD CONSTRAINT "ProjectGitRepositoryManualRunAudit_connection_owner_account_access_version_check"
  CHECK ("connectionOwnerAccountAccessVersion" IS NULL OR "connectionOwnerAccountAccessVersion" > 0);

ALTER TABLE "ProjectGitRepositoryManualRunAudit"
  ADD CONSTRAINT "ProjectGitRepositoryManualRunAudit_requested_by_account_access_version_check"
  CHECK ("requestedByAccountAccessVersion" IS NULL OR "requestedByAccountAccessVersion" > 0);

-- Build lookup indexes before the root backfill.  The legacy Git tables have
-- deferred integrity events; PostgreSQL disallows creating an index after a
-- DML statement has queued such events in the same transaction.
CREATE INDEX "GitConnection_ownerAccountAccessVersion_idx"
  ON "GitConnection"("ownerUserId", "ownerAccountAccessVersion");
CREATE INDEX "ProjectGitRepositoryDelegation_connectionOwnerAccountAccessVersion_idx"
  ON "ProjectGitRepositoryDelegation"("connectionOwnerId", "connectionOwnerAccountAccessVersion");
CREATE INDEX "ProjectGitRepositoryManualRun_connectionOwnerAccountAccessVersion_idx"
  ON "ProjectGitRepositoryManualRun"("connectionOwnerId", "connectionOwnerAccountAccessVersion");

-- Only rows that were still live and provably owned by an enabled account are
-- backfilled.  Disabled, terminal, or otherwise unverifiable history remains
-- NULL and is intentionally fail-closed.
UPDATE "GitConnection" connection_row
   SET "ownerAccountAccessVersion" = owner_user."accountAccessVersion"
  FROM "AppUser" owner_user
 WHERE connection_row."ownerUserId" = owner_user."id"
   AND connection_row."ownershipState" = 'confirmed'
   AND connection_row."status" <> 'disabled'
   AND connection_row."disabledAt" IS NULL
   AND owner_user."disabledAt" IS NULL;

-- Do not rewrite legacy delegation, run, or audit rows.  Delegation updates
-- require a fresh versioned transition audit, and both audit tables are
-- append-only/immutable.  Historical runs similarly have no migration-owned
-- proof that their frozen chain is still bound to the current account epoch.
-- Keeping all downstream epochs NULL preserves the evidence and makes the old
-- chain fail closed; only an explicit owner credential rebind may create a
-- fresh executable chain.
SET CONSTRAINTS ALL IMMEDIATE;

CREATE OR REPLACE FUNCTION "personal_git_owner_account_access_epoch_valid"(
  p_owner_id UUID,
  p_epoch INTEGER
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM "AppUser" owner_user
     WHERE owner_user."id" = p_owner_id
       AND owner_user."disabledAt" IS NULL
       AND owner_user."accountAccessVersion" = p_epoch
       AND p_epoch > 0
  );
$$;

-- The root epoch is only refreshed by the authenticated owner's explicit
-- credential rotation/rebind transaction.  Rename, test, enable/disable and
-- ordinary configuration edits keep the frozen epoch unchanged.
CREATE OR REPLACE FUNCTION "personal_git_connection_epoch_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  rotation_context TEXT := current_setting('app.personal_git_credential_rotation_context', true);
  rotation_owner TEXT := current_setting('app.personal_git_credential_rotation_owner_id', true);
  rotation_connection TEXT := current_setting('app.personal_git_credential_rotation_connection_id', true);
BEGIN
  IF NEW."ownerUserId" IS NULL THEN
    IF NEW."ownerAccountAccessVersion" IS NOT NULL THEN
      RAISE EXCEPTION 'PERSONAL_GIT_ACCOUNT_EPOCH_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."ownerAccountAccessVersion" IS NULL THEN
    RAISE EXCEPTION 'PERSONAL_GIT_ACCOUNT_EPOCH_INVALID' USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NOT "personal_git_owner_account_access_epoch_valid"(NEW."ownerUserId", NEW."ownerAccountAccessVersion") THEN
      RAISE EXCEPTION 'PERSONAL_GIT_ACCOUNT_EPOCH_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."ownerUserId" IS DISTINCT FROM NEW."ownerUserId"
     OR OLD."ownershipState" IS DISTINCT FROM NEW."ownershipState"
  THEN
    RAISE EXCEPTION 'PERSONAL_GIT_CONNECTION_OWNER_IMMUTABLE' USING ERRCODE = 'check_violation';
  END IF;

  IF OLD."ownerAccountAccessVersion" IS DISTINCT FROM NEW."ownerAccountAccessVersion" THEN
    IF rotation_context IS DISTINCT FROM '1'
       OR rotation_owner IS DISTINCT FROM NEW."ownerUserId"::text
       OR rotation_connection IS DISTINCT FROM NEW."id"::text
       OR NOT "personal_git_owner_account_access_epoch_valid"(NEW."ownerUserId", NEW."ownerAccountAccessVersion")
    THEN
      RAISE EXCEPTION 'PERSONAL_GIT_ACCOUNT_EPOCH_REFRESH_FORBIDDEN' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "GitConnection_personal_epoch_guard" ON "GitConnection";
CREATE TRIGGER "GitConnection_personal_epoch_guard"
BEFORE INSERT OR UPDATE ON "GitConnection"
FOR EACH ROW EXECUTE FUNCTION "personal_git_connection_epoch_guard"();

-- Delegation rows are immutable evidence of the exact root epoch.  Terminal
-- transitions may still be recorded after an account is disabled or a root is
-- explicitly rotated, but a new/live delegation must match the current root
-- and the currently enabled owner.
CREATE OR REPLACE FUNCTION "personal_git_delegation_epoch_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  root_epoch INTEGER;
  root_owner UUID;
  owner_epoch INTEGER;
  owner_disabled TIMESTAMP(3);
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."connectionOwnerAccountAccessVersion" IS DISTINCT FROM NEW."connectionOwnerAccountAccessVersion" THEN
    RAISE EXCEPTION 'PERSONAL_GIT_ACCOUNT_EPOCH_IMMUTABLE' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."connectionOwnerAccountAccessVersion" IS NULL THEN
    IF TG_OP = 'UPDATE'
       AND OLD."connectionOwnerAccountAccessVersion" IS NULL
       AND (
         (OLD."status" IN ('draft', 'owner_confirmed') AND NEW."status" = 'rejected')
         OR (OLD."status" = 'active' AND NEW."status" = 'revoked')
       ) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'PERSONAL_GIT_ACCOUNT_EPOCH_INVALID' USING ERRCODE = 'check_violation';
  END IF;

  SELECT connection_row."ownerAccountAccessVersion", connection_row."ownerUserId"
    INTO root_epoch, root_owner
    FROM "GitConnection" connection_row
   WHERE connection_row."id" = NEW."gitConnectionId";
  IF root_owner IS DISTINCT FROM NEW."connectionOwnerId"
     OR root_epoch IS DISTINCT FROM NEW."connectionOwnerAccountAccessVersion"
  THEN
    IF TG_OP = 'INSERT' OR NEW."status" IN ('draft', 'owner_confirmed', 'active') THEN
      RAISE EXCEPTION 'PERSONAL_GIT_ACCOUNT_EPOCH_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  SELECT owner_user."accountAccessVersion", owner_user."disabledAt"
    INTO owner_epoch, owner_disabled
    FROM "AppUser" owner_user
   WHERE owner_user."id" = NEW."connectionOwnerId";
  IF TG_OP = 'INSERT' OR NEW."status" IN ('draft', 'owner_confirmed', 'active') THEN
    IF owner_disabled IS NOT NULL
       OR owner_epoch IS DISTINCT FROM NEW."connectionOwnerAccountAccessVersion"
    THEN
      RAISE EXCEPTION 'PERSONAL_GIT_ACCOUNT_EPOCH_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "ProjectGitRepositoryDelegation_personal_epoch_guard" ON "ProjectGitRepositoryDelegation";
CREATE CONSTRAINT TRIGGER "ProjectGitRepositoryDelegation_personal_epoch_guard"
AFTER INSERT OR UPDATE ON "ProjectGitRepositoryDelegation"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "personal_git_delegation_epoch_guard"();

CREATE OR REPLACE FUNCTION "personal_git_delegation_audit_epoch_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  delegation_epoch INTEGER;
  delegation_status "ProjectGitRepositoryDelegationStatus";
BEGIN
  IF TG_OP <> 'INSERT' THEN RETURN NEW; END IF;
  SELECT delegation."connectionOwnerAccountAccessVersion", delegation."status"
    INTO delegation_epoch, delegation_status
    FROM "ProjectGitRepositoryDelegation" delegation
   WHERE delegation."id" = NEW."delegationId";
  IF delegation_epoch IS NULL THEN
    IF NEW."connectionOwnerAccountAccessVersion" IS NULL
       AND NEW."statusAfter" IS NOT DISTINCT FROM delegation_status
       AND (
         (NEW."action" = 'rejected' AND NEW."statusBefore" IN ('draft', 'owner_confirmed') AND delegation_status = 'rejected')
         OR (NEW."action" = 'revoked' AND NEW."statusBefore" = 'active' AND delegation_status = 'revoked')
       ) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'PERSONAL_GIT_ACCOUNT_EPOCH_INVALID' USING ERRCODE = 'check_violation';
  ELSIF NEW."connectionOwnerAccountAccessVersion" IS DISTINCT FROM delegation_epoch THEN
    RAISE EXCEPTION 'PERSONAL_GIT_ACCOUNT_EPOCH_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "ProjectGitRepositoryDelegationAudit_personal_epoch_guard" ON "ProjectGitRepositoryDelegationAudit";
CREATE CONSTRAINT TRIGGER "ProjectGitRepositoryDelegationAudit_personal_epoch_guard"
AFTER INSERT ON "ProjectGitRepositoryDelegationAudit"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "personal_git_delegation_audit_epoch_guard"();

-- A manual run carries the same owner epoch as its delegation.  Once a run is
-- terminal, its row is historical evidence and is never rebound; only queued
-- or running rows are required to match the currently enabled root.
--
-- A pre-epoch run can only be terminalized when its complete immutable chain is
-- still present.  This predicate deliberately does not require the root epoch
-- to be NULL: the migration refreshes live roots, while downstream legacy
-- rows remain NULL and must never be rebound to that refreshed value.
CREATE OR REPLACE FUNCTION "personal_git_manual_run_legacy_chain_valid"(
  run_row "ProjectGitRepositoryManualRun"
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT
    run_row."requestedByAccountAccessVersion" IS NULL
    AND
    run_row."connectionOwnerAccountAccessVersion" IS NULL
    AND delegation."connectionOwnerAccountAccessVersion" IS NULL
    AND delegation."id" = run_row."delegationId"
    AND delegation."projectId" = run_row."projectId"
    AND delegation."version" = run_row."delegationVersion"
    AND delegation."delegationFingerprint" = run_row."delegationFingerprint"
    AND delegation."connectionOwnerId" = run_row."connectionOwnerId"
    AND delegation."ownerProjectMembershipId" = run_row."ownerProjectMembershipId"
    AND delegation."ownerMembershipCreatedAt" = run_row."ownerMembershipCreatedAt"
    AND delegation."projectConfirmedById" IS NOT DISTINCT FROM run_row."projectConfirmedById"
    AND delegation."projectConfirmedProjectMembershipId" IS NOT DISTINCT FROM run_row."projectConfirmedProjectMembershipId"
    AND delegation."projectConfirmedMembershipCreatedAt" IS NOT DISTINCT FROM run_row."projectConfirmedMembershipCreatedAt"
    AND delegation."connectionConfigurationVersion" = run_row."connectionConfigurationVersion"
    AND delegation."resolvedAddressFingerprint" = run_row."resolvedAddressFingerprint"
    AND delegation."credentialFingerprint" = run_row."credentialFingerprint"
    AND delegation."repositoryPath" = run_row."repositoryPath"
    AND delegation."trackedRef" = run_row."trackedRef"
    AND delegation."includeRoots" IS NOT DISTINCT FROM run_row."includeRoots"
    AND delegation."softExcludePatterns" IS NOT DISTINCT FROM run_row."softExcludePatterns"
    AND delegation."role" = run_row."role"
    AND delegation."requiredForProjectSnapshot" = run_row."requiredForProjectSnapshot"
    AND delegation."codeEnabled" = run_row."codeEnabled"
    AND delegation."metadataEnabled" = run_row."metadataEnabled"
    AND delegation."manualSyncAllowed" = run_row."manualSyncAllowed"
    AND delegation."automationAllowed" = run_row."automationAllowed"
    AND connection_row."ownerUserId" = run_row."connectionOwnerId"
    AND connection_row."configurationVersion" = run_row."connectionConfigurationVersion"
    AND connection_row."resolvedAddressFingerprint" = run_row."resolvedAddressFingerprint"
    AND (
      (connection_row."authKind" = 'none' AND connection_row."credentialId" IS NULL)
      OR (
        credential_row."kind" = 'git'
        AND credential_row."secretFingerprint" = run_row."credentialFingerprint"
      )
    )
  FROM "ProjectGitRepositoryDelegation" delegation
  JOIN "GitConnection" connection_row
    ON connection_row."id" = delegation."gitConnectionId"
  LEFT JOIN "ExternalCredential" credential_row
    ON credential_row."id" = connection_row."credentialId"
  JOIN "AppUser" requester_user
    ON requester_user."id" = run_row."requestedById"
  JOIN "AppUser" owner_user
    ON owner_user."id" = run_row."connectionOwnerId"
  JOIN "AppUser" confirmer_user
    ON confirmer_user."id" = run_row."projectConfirmedById"
  JOIN "ProjectMembership" requester_membership
    ON requester_membership."id" = run_row."requestedByProjectMembershipId"
  JOIN "ProjectMembership" owner_membership
    ON owner_membership."id" = delegation."ownerProjectMembershipId"
  JOIN "ProjectMembership" confirmer_membership
    ON confirmer_membership."id" = delegation."projectConfirmedProjectMembershipId"
  WHERE delegation."id" = run_row."delegationId"
    AND delegation."projectId" = run_row."projectId"
    AND requester_membership."projectId" = run_row."projectId"
    AND requester_membership."userId" = run_row."requestedById"
    AND requester_membership."createdAt" = run_row."requestedByMembershipCreatedAt"
    AND owner_membership."projectId" = run_row."projectId"
    AND owner_membership."userId" = run_row."connectionOwnerId"
    AND owner_membership."createdAt" = run_row."ownerMembershipCreatedAt"
    AND confirmer_membership."projectId" = run_row."projectId"
    AND confirmer_membership."userId" = run_row."projectConfirmedById"
    AND confirmer_membership."createdAt" = run_row."projectConfirmedMembershipCreatedAt";
$$;

CREATE OR REPLACE FUNCTION "personal_git_manual_run_epoch_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  delegation_epoch INTEGER;
  root_epoch INTEGER;
  owner_epoch INTEGER;
  owner_disabled TIMESTAMP(3);
  requester_epoch INTEGER;
  requester_disabled TIMESTAMP(3);
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."requestedByAccountAccessVersion" IS DISTINCT FROM NEW."requestedByAccountAccessVersion" THEN
    RAISE EXCEPTION 'PERSONAL_GIT_REQUESTER_ACCOUNT_EPOCH_IMMUTABLE' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' AND NEW."requestedByAccountAccessVersion" IS NULL THEN
    RAISE EXCEPTION 'PERSONAL_GIT_REQUESTER_ACCOUNT_EPOCH_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."connectionOwnerAccountAccessVersion" IS DISTINCT FROM NEW."connectionOwnerAccountAccessVersion" THEN
    RAISE EXCEPTION 'PERSONAL_GIT_ACCOUNT_EPOCH_IMMUTABLE' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."connectionOwnerAccountAccessVersion" IS NULL THEN
    IF TG_OP = 'UPDATE'
       AND OLD."connectionOwnerAccountAccessVersion" IS NULL
       AND NEW."requestedByAccountAccessVersion" IS NULL
       AND NEW."failureCode" = 'PROJECT_GIT_MANUAL_LEGACY_EPOCH_INVALIDATED'
       AND "personal_git_manual_run_legacy_chain_valid"(NEW)
       AND (
         (OLD."status" = 'queued'
           AND NEW."status" = 'failed'
           AND OLD."stage" = 'queued'
           AND OLD."dispatchState" = 'pending'
           AND NEW."stage" = 'terminal'
           AND NEW."dispatchState" = 'acknowledged')
         OR (OLD."status" = 'running'
           AND NEW."status" = 'failed'
           AND OLD."stage" = 'admitted'
           AND OLD."dispatchState" = 'pending'
           AND NEW."stage" = 'terminal'
           AND NEW."dispatchState" = 'acknowledged')
         OR (OLD."status" = 'running'
           AND NEW."status" = 'unknown'
           AND OLD."stage" IN ('fetching', 'validating', 'publishing')
           AND OLD."dispatchState" IN ('dispatched', 'acknowledged')
           AND NEW."stage" = 'terminal'
           AND NEW."dispatchState" = 'dispatched')
       ) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'PERSONAL_GIT_ACCOUNT_EPOCH_INVALID' USING ERRCODE = 'check_violation';
  END IF;

  SELECT delegation."connectionOwnerAccountAccessVersion", connection_row."ownerAccountAccessVersion"
    INTO delegation_epoch, root_epoch
    FROM "ProjectGitRepositoryDelegation" delegation
    JOIN "GitConnection" connection_row ON connection_row."id" = delegation."gitConnectionId"
   WHERE delegation."id" = NEW."delegationId"
     AND delegation."projectId" = NEW."projectId";
  IF delegation_epoch IS DISTINCT FROM NEW."connectionOwnerAccountAccessVersion" THEN
    RAISE EXCEPTION 'PERSONAL_GIT_ACCOUNT_EPOCH_INVALID' USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."status" IN ('queued', 'running') THEN
    SELECT owner_user."accountAccessVersion", owner_user."disabledAt"
      INTO owner_epoch, owner_disabled
      FROM "AppUser" owner_user
     WHERE owner_user."id" = NEW."connectionOwnerId";
    IF root_epoch IS DISTINCT FROM NEW."connectionOwnerAccountAccessVersion"
       OR owner_disabled IS NOT NULL
       OR owner_epoch IS DISTINCT FROM NEW."connectionOwnerAccountAccessVersion"
    THEN
      RAISE EXCEPTION 'PERSONAL_GIT_ACCOUNT_EPOCH_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    SELECT requester_user."accountAccessVersion", requester_user."disabledAt"
      INTO requester_epoch, requester_disabled
      FROM "AppUser" requester_user
     WHERE requester_user."id" = NEW."requestedById";
    IF requester_disabled IS NOT NULL
       OR requester_epoch IS DISTINCT FROM NEW."requestedByAccountAccessVersion"
    THEN
      RAISE EXCEPTION 'PERSONAL_GIT_REQUESTER_ACCOUNT_EPOCH_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "ProjectGitRepositoryManualRun_personal_epoch_guard" ON "ProjectGitRepositoryManualRun";
CREATE CONSTRAINT TRIGGER "ProjectGitRepositoryManualRun_personal_epoch_guard"
AFTER INSERT OR UPDATE ON "ProjectGitRepositoryManualRun"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "personal_git_manual_run_epoch_guard"();

CREATE OR REPLACE FUNCTION "personal_git_manual_run_audit_epoch_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  run_epoch INTEGER;
  run_requester_epoch INTEGER;
  run_status "ProjectGitRepositoryManualRunStatus";
  run_stage "ProjectGitRepositoryManualRunStage";
  run_dispatch_state "ProjectGitRepositoryManualRunDispatchState";
  legacy_chain_valid BOOLEAN;
BEGIN
  IF TG_OP <> 'INSERT' THEN RETURN NEW; END IF;
  SELECT run_row."connectionOwnerAccountAccessVersion", run_row."requestedByAccountAccessVersion", run_row."status", run_row."stage", run_row."dispatchState",
         "personal_git_manual_run_legacy_chain_valid"(run_row)
    INTO run_epoch, run_requester_epoch, run_status, run_stage, run_dispatch_state, legacy_chain_valid
    FROM "ProjectGitRepositoryManualRun" run_row
   WHERE run_row."id" = NEW."runId";
  IF run_epoch IS NULL THEN
    IF NEW."connectionOwnerAccountAccessVersion" IS NULL
       AND NEW."requestedByAccountAccessVersion" IS NULL
       AND legacy_chain_valid
       AND NEW."statusAfter" IS NOT DISTINCT FROM run_status
       AND run_stage = 'terminal'
       AND (
         (NEW."action" = 'failed'
           AND NEW."statusAfter" = 'failed'
           AND NEW."statusBefore" IN ('queued', 'running')
           AND NEW."dispatchState" = 'acknowledged'
           AND run_dispatch_state = 'acknowledged'
           AND NEW."actorId" IS NULL
           AND NEW."reason" = 'PROJECT_GIT_MANUAL_LEGACY_EPOCH_INVALIDATED')
         OR (NEW."action" = 'unknown'
           AND NEW."statusBefore" = 'running'
           AND NEW."statusAfter" = 'unknown'
           AND NEW."dispatchState" = 'dispatched'
           AND run_dispatch_state = 'dispatched')
       ) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'PERSONAL_GIT_ACCOUNT_EPOCH_INVALID' USING ERRCODE = 'check_violation';
  ELSIF run_requester_epoch IS NULL
     OR NEW."connectionOwnerAccountAccessVersion" IS DISTINCT FROM run_epoch
     OR NEW."requestedByAccountAccessVersion" IS DISTINCT FROM run_requester_epoch THEN
    RAISE EXCEPTION 'PERSONAL_GIT_ACCOUNT_EPOCH_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "ProjectGitRepositoryManualRunAudit_personal_epoch_guard" ON "ProjectGitRepositoryManualRunAudit";
CREATE CONSTRAINT TRIGGER "ProjectGitRepositoryManualRunAudit_personal_epoch_guard"
AFTER INSERT ON "ProjectGitRepositoryManualRunAudit"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "personal_git_manual_run_audit_epoch_guard"();

-- The original runtime shape guard marked a run as dispatched in the same
-- transaction as admission.  Keep all of its evidence checks, but introduce
-- an admitted/pending state so the final dispatch boundary can be committed
-- immediately before the first network-capable Git command.
CREATE OR REPLACE FUNCTION "project_git_manual_runtime_shape_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'queued' OR NEW."stage" <> 'queued' OR NEW."dispatchState" <> 'pending'
       OR NEW."requestedByAccountAccessVersion" IS NULL
       OR NEW."manualSyncAllowed" IS NOT TRUE OR NEW."startedAt" IS NOT NULL
       OR NEW."completedAt" IS NOT NULL OR NEW."failureCode" IS NOT NULL
       OR NEW."result" IS NOT NULL OR NEW."frozenCommitSha" IS NOT NULL
       OR NEW."manifestFingerprint" IS NOT NULL OR NEW."fileCount" <> 0
       OR NEW."decodedTextBytes" <> 0 THEN
      RAISE EXCEPTION 'PROJECT_GIT_MANUAL_RUN_INITIAL_STATE_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF OLD."projectId" IS DISTINCT FROM NEW."projectId"
       OR OLD."delegationId" IS DISTINCT FROM NEW."delegationId"
       OR OLD."requestedById" IS DISTINCT FROM NEW."requestedById"
       OR OLD."requestedByAccountAccessVersion" IS DISTINCT FROM NEW."requestedByAccountAccessVersion"
       OR OLD."requestedByProjectMembershipId" IS DISTINCT FROM NEW."requestedByProjectMembershipId"
       OR OLD."requestedByMembershipCreatedAt" IS DISTINCT FROM NEW."requestedByMembershipCreatedAt"
       OR OLD."clientRequestKey" IS DISTINCT FROM NEW."clientRequestKey"
       OR OLD."delegationVersion" IS DISTINCT FROM NEW."delegationVersion"
       OR OLD."delegationFingerprint" IS DISTINCT FROM NEW."delegationFingerprint"
       OR OLD."connectionOwnerId" IS DISTINCT FROM NEW."connectionOwnerId"
       OR OLD."connectionOwnerAccountAccessVersion" IS DISTINCT FROM NEW."connectionOwnerAccountAccessVersion"
       OR OLD."ownerProjectMembershipId" IS DISTINCT FROM NEW."ownerProjectMembershipId"
       OR OLD."ownerMembershipCreatedAt" IS DISTINCT FROM NEW."ownerMembershipCreatedAt"
       OR OLD."projectConfirmedById" IS DISTINCT FROM NEW."projectConfirmedById"
       OR OLD."projectConfirmedProjectMembershipId" IS DISTINCT FROM NEW."projectConfirmedProjectMembershipId"
       OR OLD."projectConfirmedMembershipCreatedAt" IS DISTINCT FROM NEW."projectConfirmedMembershipCreatedAt"
       OR OLD."connectionConfigurationVersion" IS DISTINCT FROM NEW."connectionConfigurationVersion"
       OR OLD."resolvedAddressFingerprint" IS DISTINCT FROM NEW."resolvedAddressFingerprint"
       OR OLD."credentialFingerprint" IS DISTINCT FROM NEW."credentialFingerprint"
       OR OLD."repositoryPath" IS DISTINCT FROM NEW."repositoryPath"
       OR OLD."trackedRef" IS DISTINCT FROM NEW."trackedRef"
       OR OLD."includeRoots" IS DISTINCT FROM NEW."includeRoots"
       OR OLD."softExcludePatterns" IS DISTINCT FROM NEW."softExcludePatterns"
       OR OLD."role" IS DISTINCT FROM NEW."role"
       OR OLD."requiredForProjectSnapshot" IS DISTINCT FROM NEW."requiredForProjectSnapshot"
       OR OLD."codeEnabled" IS DISTINCT FROM NEW."codeEnabled"
       OR OLD."metadataEnabled" IS DISTINCT FROM NEW."metadataEnabled"
       OR OLD."manualSyncAllowed" IS DISTINCT FROM NEW."manualSyncAllowed"
       OR OLD."automationAllowed" IS DISTINCT FROM NEW."automationAllowed" THEN
      RAISE EXCEPTION 'PROJECT_GIT_MANUAL_RUN_EVIDENCE_IMMUTABLE' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."createdAt" IS DISTINCT FROM NEW."createdAt" THEN
      RAISE EXCEPTION 'PROJECT_GIT_MANUAL_RUN_CREATED_AT_IMMUTABLE' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" IN ('succeeded', 'failed', 'unknown') THEN
      RAISE EXCEPTION 'PROJECT_GIT_MANUAL_RUN_TERMINAL_IMMUTABLE' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT (
      (OLD."status" = 'queued' AND NEW."status" = 'running' AND NEW."stage" IN ('admitted', 'fetching'))
      OR (OLD."status" = 'queued' AND NEW."status" = 'failed'
        AND OLD."stage" = 'queued' AND OLD."dispatchState" = 'pending'
        AND NEW."stage" = 'terminal' AND NEW."dispatchState" = 'acknowledged')
      OR (OLD."status" = 'running' AND NEW."status" = 'running'
        AND (
          (OLD."stage" = 'admitted' AND NEW."stage" = 'fetching')
          OR (OLD."stage" = 'fetching' AND NEW."stage" IN ('fetching', 'validating'))
          OR (OLD."stage" = 'validating' AND NEW."stage" IN ('validating', 'publishing'))
          OR (OLD."stage" = 'publishing' AND NEW."stage" = 'publishing')
        ))
      OR (OLD."status" = 'running' AND NEW."status" = 'failed'
        AND OLD."stage" = 'admitted' AND OLD."dispatchState" = 'pending'
        AND NEW."stage" = 'terminal' AND NEW."dispatchState" = 'acknowledged')
      OR (OLD."status" = 'running' AND NEW."status" IN ('succeeded', 'failed', 'unknown') AND NEW."stage" = 'terminal')
    ) THEN
      RAISE EXCEPTION 'PROJECT_GIT_MANUAL_RUN_STATE_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'queued' AND NEW."status" = 'running' THEN
      IF NEW."stage" = 'admitted' THEN
        IF NEW."dispatchState" <> 'pending'
           OR NEW."startedAt" IS NULL
           OR NEW."failureCode" IS NOT NULL
           OR NEW."result" IS NOT NULL
           OR NEW."completedAt" IS NOT NULL
           OR NEW."frozenCommitSha" IS DISTINCT FROM OLD."frozenCommitSha"
           OR NEW."manifestFingerprint" IS DISTINCT FROM OLD."manifestFingerprint"
           OR NEW."fileCount" <> OLD."fileCount"
           OR NEW."decodedTextBytes" <> OLD."decodedTextBytes" THEN
          RAISE EXCEPTION 'PROJECT_GIT_MANUAL_RUN_ADMISSION_INVALID' USING ERRCODE = 'check_violation';
        END IF;
      ELSE
        IF NEW."dispatchState" <> 'dispatched'
           OR NEW."startedAt" IS NULL
           OR NEW."failureCode" IS NOT NULL
           OR NEW."result" IS NOT NULL
           OR NEW."completedAt" IS NOT NULL
           OR NEW."frozenCommitSha" IS DISTINCT FROM OLD."frozenCommitSha"
           OR NEW."manifestFingerprint" IS DISTINCT FROM OLD."manifestFingerprint"
           OR NEW."fileCount" <> OLD."fileCount"
           OR NEW."decodedTextBytes" <> OLD."decodedTextBytes" THEN
          RAISE EXCEPTION 'PROJECT_GIT_MANUAL_RUN_DISPATCH_INVALID' USING ERRCODE = 'check_violation';
        END IF;
      END IF;
    ELSIF OLD."status" = 'queued' AND NEW."status" = 'failed' THEN
      IF OLD."stage" <> 'queued'
         OR OLD."dispatchState" <> 'pending'
         OR NEW."stage" <> 'terminal'
         OR NEW."dispatchState" <> 'acknowledged'
         OR NEW."startedAt" IS NOT NULL
         OR NEW."completedAt" IS NULL
         OR NEW."failureCode" IS NULL
         OR NEW."result" IS NOT NULL
         OR NEW."frozenCommitSha" IS DISTINCT FROM OLD."frozenCommitSha"
         OR NEW."manifestFingerprint" IS DISTINCT FROM OLD."manifestFingerprint"
         OR NEW."fileCount" <> OLD."fileCount"
         OR NEW."decodedTextBytes" <> OLD."decodedTextBytes" THEN
        RAISE EXCEPTION 'PROJECT_GIT_MANUAL_RUN_TERMINAL_EVIDENCE_INVALID' USING ERRCODE = 'check_violation';
      END IF;
    ELSIF OLD."status" = 'running' AND NEW."status" = 'running' THEN
      IF OLD."stage" = 'admitted' THEN
        IF NEW."stage" <> 'fetching'
           OR NEW."dispatchState" <> 'dispatched'
           OR NEW."startedAt" IS DISTINCT FROM OLD."startedAt"
           OR NEW."failureCode" IS DISTINCT FROM OLD."failureCode"
           OR NEW."result" IS DISTINCT FROM OLD."result"
           OR NEW."completedAt" IS DISTINCT FROM OLD."completedAt"
           OR NEW."frozenCommitSha" IS DISTINCT FROM OLD."frozenCommitSha"
           OR NEW."manifestFingerprint" IS DISTINCT FROM OLD."manifestFingerprint"
           OR NEW."fileCount" <> OLD."fileCount"
           OR NEW."decodedTextBytes" <> OLD."decodedTextBytes" THEN
          RAISE EXCEPTION 'PROJECT_GIT_MANUAL_RUN_DISPATCH_INVALID' USING ERRCODE = 'check_violation';
        END IF;
      ELSIF NEW."dispatchState" <> 'dispatched'
         OR NEW."startedAt" IS DISTINCT FROM OLD."startedAt"
         OR NEW."failureCode" IS DISTINCT FROM OLD."failureCode"
         OR NEW."result" IS DISTINCT FROM OLD."result"
         OR NEW."completedAt" IS DISTINCT FROM OLD."completedAt"
         OR NEW."frozenCommitSha" IS DISTINCT FROM OLD."frozenCommitSha"
         OR NEW."manifestFingerprint" IS DISTINCT FROM OLD."manifestFingerprint"
         OR NEW."fileCount" <> OLD."fileCount"
         OR NEW."decodedTextBytes" <> OLD."decodedTextBytes" THEN
        RAISE EXCEPTION 'PROJECT_GIT_MANUAL_RUN_RUNNING_EVIDENCE_IMMUTABLE' USING ERRCODE = 'check_violation';
      END IF;
    ELSIF OLD."status" = 'running' AND NEW."status" = 'failed'
      AND OLD."stage" = 'admitted' AND OLD."dispatchState" = 'pending'
      AND NEW."dispatchState" = 'acknowledged' THEN
      IF NEW."stage" <> 'terminal'
         OR NEW."completedAt" IS NULL
         OR NEW."failureCode" IS NULL
         OR NEW."result" IS DISTINCT FROM OLD."result"
         OR NEW."startedAt" IS DISTINCT FROM OLD."startedAt"
         OR NEW."frozenCommitSha" IS DISTINCT FROM OLD."frozenCommitSha"
         OR NEW."manifestFingerprint" IS DISTINCT FROM OLD."manifestFingerprint"
         OR NEW."fileCount" <> OLD."fileCount"
         OR NEW."decodedTextBytes" <> OLD."decodedTextBytes" THEN
        RAISE EXCEPTION 'PROJECT_GIT_MANUAL_RUN_TERMINAL_EVIDENCE_INVALID' USING ERRCODE = 'check_violation';
      END IF;
    ELSIF OLD."status" = 'running' AND NEW."status" IN ('failed', 'unknown') THEN
      IF NEW."dispatchState" <> 'acknowledged' AND NEW."dispatchState" <> 'dispatched'
         OR NEW."completedAt" IS NULL
         OR NEW."failureCode" IS NULL
         OR NEW."result" IS DISTINCT FROM OLD."result"
         OR NEW."startedAt" IS DISTINCT FROM OLD."startedAt"
         OR NEW."frozenCommitSha" IS DISTINCT FROM OLD."frozenCommitSha"
         OR NEW."manifestFingerprint" IS DISTINCT FROM OLD."manifestFingerprint"
         OR NEW."fileCount" <> OLD."fileCount"
         OR NEW."decodedTextBytes" <> OLD."decodedTextBytes" THEN
        RAISE EXCEPTION 'PROJECT_GIT_MANUAL_RUN_TERMINAL_EVIDENCE_INVALID' USING ERRCODE = 'check_violation';
      END IF;
    ELSIF OLD."status" = 'running' AND NEW."status" = 'succeeded' THEN
      IF NEW."dispatchState" <> 'acknowledged'
         OR NEW."completedAt" IS NULL
         OR NEW."failureCode" IS NOT NULL
         OR NEW."result" IS NULL
         OR NEW."startedAt" IS DISTINCT FROM OLD."startedAt"
         OR NEW."frozenCommitSha" IS NULL
         OR NEW."manifestFingerprint" IS NULL THEN
        RAISE EXCEPTION 'PROJECT_GIT_MANUAL_RUN_RESULT_REQUIRED' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "project_git_manual_runtime_audit_guard"()
RETURNS trigger
LANGUAGE plpgsql
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
       OR NOT (
         (NEW."statusBefore" IS NOT DISTINCT FROM 'running' AND NEW."dispatchState" = 'acknowledged')
         OR (NEW."statusBefore" IN ('queued', 'running') AND NEW."dispatchState" = 'acknowledged')
       ) THEN
      RAISE EXCEPTION 'PROJECT_GIT_MANUAL_AUDIT_SHAPE_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."action" = 'unknown' THEN
    IF NEW."statusBefore" IS DISTINCT FROM 'running' OR NEW."statusAfter" <> 'unknown' OR NEW."dispatchState" <> 'dispatched' THEN
      RAISE EXCEPTION 'PROJECT_GIT_MANUAL_AUDIT_SHAPE_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    RAISE EXCEPTION 'PROJECT_GIT_MANUAL_AUDIT_SHAPE_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."action" IN ('requested', 'admitted', 'dispatched', 'succeeded')
     AND NEW."actorId" IS DISTINCT FROM run_row."requestedById" THEN
    RAISE EXCEPTION 'PROJECT_GIT_MANUAL_AUDIT_ACTOR_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."action" = 'failed'
     AND NEW."actorId" IS DISTINCT FROM run_row."requestedById"
     AND NOT (
       NEW."actorId" IS NULL
       AND run_row."connectionOwnerAccountAccessVersion" IS NULL
       AND NEW."statusBefore" IN ('queued', 'running')
       AND NEW."statusAfter" = 'failed'
       AND NEW."dispatchState" = 'acknowledged'
     ) THEN
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
  RETURN NEW;
END;
$$;

-- The existing publication guard validates Git configuration and membership
-- fingerprints.  This extra deferred check makes the account epoch part of
-- that same final publication predicate without rewriting the older guard.
CREATE OR REPLACE FUNCTION "personal_git_manual_success_epoch_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  evidence_valid BOOLEAN;
BEGIN
  IF NEW."status" <> 'succeeded' THEN RETURN NEW; END IF;
  SELECT EXISTS (
    SELECT 1
      FROM "ProjectGitRepositoryDelegation" delegation
      JOIN "GitConnection" connection_row ON connection_row."id" = delegation."gitConnectionId"
      JOIN "AppUser" owner_user ON owner_user."id" = delegation."connectionOwnerId"
      JOIN "AppUser" requester_user ON requester_user."id" = NEW."requestedById"
     WHERE delegation."id" = NEW."delegationId"
       AND delegation."projectId" = NEW."projectId"
       AND delegation."connectionOwnerAccountAccessVersion" = NEW."connectionOwnerAccountAccessVersion"
       AND connection_row."ownerUserId" = delegation."connectionOwnerId"
       AND connection_row."ownerAccountAccessVersion" = NEW."connectionOwnerAccountAccessVersion"
       AND owner_user."disabledAt" IS NULL
       AND owner_user."accountAccessVersion" = NEW."connectionOwnerAccountAccessVersion"
       AND NEW."requestedByAccountAccessVersion" IS NOT NULL
       AND requester_user."disabledAt" IS NULL
       AND requester_user."accountAccessVersion" = NEW."requestedByAccountAccessVersion"
  ) INTO evidence_valid;
  IF NOT evidence_valid THEN
    RAISE EXCEPTION 'PERSONAL_GIT_ACCOUNT_EPOCH_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "ProjectGitRepositoryManualRun_personal_success_epoch_guard"
AFTER UPDATE OF "status" ON "ProjectGitRepositoryManualRun"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW WHEN (NEW."status" = 'succeeded')
EXECUTE FUNCTION "personal_git_manual_success_epoch_guard"();

-- Legacy queued runs can be invalidated before they ever enter running.  The
-- original transition guard only knew about running terminal transitions;
-- retain its audit requirement while adding this one explicit, no-dispatch
-- queued -> failed path.
CREATE OR REPLACE FUNCTION "project_git_manual_runtime_transition_audit_guard"()
RETURNS trigger
LANGUAGE plpgsql
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
