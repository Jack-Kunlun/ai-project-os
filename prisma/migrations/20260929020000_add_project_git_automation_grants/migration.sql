-- Durable two-party consent for a future scheduled read-only Git consumer.
-- This does not alter ProjectGitRepositoryDelegation.automationAllowed and
-- does not create a Worker or perform Git I/O.

CREATE TYPE "ProjectGitRepositoryAutomationGrantStatus" AS ENUM (
  'draft', 'owner_confirmed', 'active', 'rejected', 'revoked', 'expired', 'invalidated'
);

CREATE TYPE "ProjectGitRepositoryAutomationGrantActorKind" AS ENUM ('user', 'system');

CREATE TYPE "ProjectGitRepositoryAutomationGrantAuditAction" AS ENUM (
  'proposed', 'owner_confirmed', 'activated', 'rejected', 'revoked', 'expired', 'invalidated'
);

CREATE TABLE "ProjectGitRepositoryAutomationGrant" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "gitConnectionId" UUID NOT NULL,
  "baseDelegationId" UUID NOT NULL,
  "connectionOwnerId" UUID NOT NULL,
  "connectionOwnerAccountAccessVersion" INTEGER NOT NULL,
  "baseDelegationVersion" INTEGER NOT NULL,
  "baseDelegationFingerprint" CHAR(64) NOT NULL,
  "repositoryPath" VARCHAR(768) NOT NULL,
  "trackedRef" VARCHAR(255) NOT NULL,
  "includeRoots" JSONB NOT NULL,
  "softExcludePatterns" JSONB NOT NULL,
  "runIntervalMinutes" INTEGER NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "grantFingerprint" CHAR(64) NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "status" "ProjectGitRepositoryAutomationGrantStatus" NOT NULL DEFAULT 'draft',
  "proposedById" UUID NOT NULL,
  "proposedProjectMembershipId" UUID NOT NULL,
  "proposedMembershipCreatedAt" TIMESTAMP(3) NOT NULL,
  "proposedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ownerConfirmedById" UUID,
  "ownerConfirmedProjectMembershipId" UUID,
  "ownerConfirmedMembershipCreatedAt" TIMESTAMP(3),
  "ownerConfirmedAt" TIMESTAMP(3),
  "projectActivatedById" UUID,
  "projectActivatedMembershipId" UUID,
  "projectActivatedMembershipCreatedAt" TIMESTAMP(3),
  "activatedAt" TIMESTAMP(3),
  "terminalActorKind" "ProjectGitRepositoryAutomationGrantActorKind",
  "terminalActorId" UUID,
  "terminalActorProjectMembershipId" UUID,
  "terminalActorMembershipCreatedAt" TIMESTAMP(3),
  "terminalReason" VARCHAR(500),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProjectGitRepositoryAutomationGrant_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PGAG_version_check" CHECK ("version" > 0),
  CONSTRAINT "PGAG_base_version_check" CHECK ("baseDelegationVersion" > 0),
  CONSTRAINT "PGAG_owner_epoch_check" CHECK ("connectionOwnerAccountAccessVersion" > 0),
  CONSTRAINT "PGAG_interval_check" CHECK ("runIntervalMinutes" BETWEEN 60 AND 43200),
  CONSTRAINT "PGAG_fingerprint_check" CHECK (
    "baseDelegationFingerprint" ~ '^[0-9a-f]{64}$'
    AND "grantFingerprint" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "PGAG_scope_json_check" CHECK (
    jsonb_typeof("includeRoots") = 'array'
    AND jsonb_typeof("softExcludePatterns") = 'array'
  ),
  CONSTRAINT "PGAG_expiry_check" CHECK ("expiresAt" > "proposedAt")
);

CREATE UNIQUE INDEX "PGAG_base_delegation_version_key"
  ON "ProjectGitRepositoryAutomationGrant"("baseDelegationId", "baseDelegationVersion")
  WHERE "status" IN ('draft', 'owner_confirmed', 'active');
CREATE INDEX "PGAG_project_status_expiry_idx"
  ON "ProjectGitRepositoryAutomationGrant"("projectId", "status", "expiresAt");
CREATE INDEX "PGAG_connection_status_idx"
  ON "ProjectGitRepositoryAutomationGrant"("gitConnectionId", "status");
CREATE INDEX "PGAG_owner_status_idx"
  ON "ProjectGitRepositoryAutomationGrant"("connectionOwnerId", "status");

ALTER TABLE "ProjectGitRepositoryAutomationGrant"
  ADD CONSTRAINT "PGAG_project_fkey"
    FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "PGAG_connection_fkey"
    FOREIGN KEY ("gitConnectionId") REFERENCES "GitConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "PGAG_base_delegation_fkey"
    FOREIGN KEY ("baseDelegationId") REFERENCES "ProjectGitRepositoryDelegation"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "PGAG_connection_owner_fkey"
    FOREIGN KEY ("connectionOwnerId") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PGAG_proposer_fkey"
    FOREIGN KEY ("proposedById") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PGAG_proposer_membership_fkey"
    FOREIGN KEY ("proposedProjectMembershipId") REFERENCES "ProjectMembership"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PGAG_owner_confirmer_fkey"
    FOREIGN KEY ("ownerConfirmedById") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PGAG_owner_membership_fkey"
    FOREIGN KEY ("ownerConfirmedProjectMembershipId") REFERENCES "ProjectMembership"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PGAG_project_activator_fkey"
    FOREIGN KEY ("projectActivatedById") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PGAG_project_membership_fkey"
    FOREIGN KEY ("projectActivatedMembershipId") REFERENCES "ProjectMembership"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PGAG_terminal_actor_fkey"
    FOREIGN KEY ("terminalActorId") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PGAG_terminal_membership_fkey"
    FOREIGN KEY ("terminalActorProjectMembershipId") REFERENCES "ProjectMembership"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- Intentionally scalar-only and FK-free so retained consent evidence survives
-- project/connection deletion and contains no endpoint or credential material.
CREATE TABLE "ProjectGitRepositoryAutomationGrantAudit" (
  "id" UUID NOT NULL,
  "grantId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "gitConnectionId" UUID NOT NULL,
  "baseDelegationId" UUID NOT NULL,
  "connectionOwnerId" UUID NOT NULL,
  "action" "ProjectGitRepositoryAutomationGrantAuditAction" NOT NULL,
  "grantVersion" INTEGER NOT NULL,
  "statusBefore" "ProjectGitRepositoryAutomationGrantStatus",
  "statusAfter" "ProjectGitRepositoryAutomationGrantStatus" NOT NULL,
  "actorKind" "ProjectGitRepositoryAutomationGrantActorKind" NOT NULL,
  "actorId" UUID,
  "actorProjectMembershipId" UUID,
  "actorMembershipCreatedAt" TIMESTAMP(3),
  "terminalActorKind" "ProjectGitRepositoryAutomationGrantActorKind",
  "terminalActorId" UUID,
  "terminalActorProjectMembershipId" UUID,
  "terminalActorMembershipCreatedAt" TIMESTAMP(3),
  "terminalReason" VARCHAR(500),
  "baseDelegationVersion" INTEGER NOT NULL,
  "baseDelegationFingerprint" CHAR(64) NOT NULL,
  "repositoryPath" VARCHAR(768) NOT NULL,
  "trackedRef" VARCHAR(255) NOT NULL,
  "includeRoots" JSONB NOT NULL,
  "softExcludePatterns" JSONB NOT NULL,
  "runIntervalMinutes" INTEGER NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "grantFingerprint" CHAR(64) NOT NULL,
  "reason" VARCHAR(500) NOT NULL,
  "transitionAt" TIMESTAMP(3) NOT NULL,
  "transactionId" BIGINT NOT NULL DEFAULT txid_current(),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProjectGitRepositoryAutomationGrantAudit_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PGAGA_version_check" CHECK ("grantVersion" > 0)
);
CREATE UNIQUE INDEX "PGAGA_grant_version_key"
  ON "ProjectGitRepositoryAutomationGrantAudit"("grantId", "grantVersion");
CREATE INDEX "PGAGA_project_created_idx"
  ON "ProjectGitRepositoryAutomationGrantAudit"("projectId", "createdAt");
CREATE INDEX "PGAGA_base_created_idx"
  ON "ProjectGitRepositoryAutomationGrantAudit"("baseDelegationId", "createdAt");
CREATE INDEX "PGAGA_transaction_created_idx"
  ON "ProjectGitRepositoryAutomationGrantAudit"("transactionId", "createdAt");

CREATE OR REPLACE FUNCTION "project_git_automation_grant_global_lock"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtextextended('ai-project-git-repository-delegation-global', 0)) THEN
    RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_GRANT_LOCK_BUSY' USING ERRCODE = 'serialization_failure';
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER "PGAG_global_lock"
BEFORE INSERT OR UPDATE OR DELETE ON "ProjectGitRepositoryAutomationGrant"
FOR EACH STATEMENT EXECUTE FUNCTION "project_git_automation_grant_global_lock"();

CREATE OR REPLACE FUNCTION "project_git_automation_grant_shape_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW."createdAt" := clock_timestamp();
    NEW."updatedAt" := NEW."createdAt";
    NEW."proposedAt" := NEW."createdAt";
    IF NEW."status" <> 'draft' OR NEW."version" <> 1
       OR NEW."ownerConfirmedById" IS NOT NULL
       OR NEW."ownerConfirmedProjectMembershipId" IS NOT NULL
       OR NEW."ownerConfirmedMembershipCreatedAt" IS NOT NULL
       OR NEW."ownerConfirmedAt" IS NOT NULL
       OR NEW."projectActivatedById" IS NOT NULL
       OR NEW."projectActivatedMembershipId" IS NOT NULL
       OR NEW."projectActivatedMembershipCreatedAt" IS NOT NULL
       OR NEW."activatedAt" IS NOT NULL
       OR NEW."terminalActorKind" IS NOT NULL
       OR NEW."terminalActorId" IS NOT NULL
       OR NEW."terminalActorProjectMembershipId" IS NOT NULL
       OR NEW."terminalActorMembershipCreatedAt" IS NOT NULL
       OR NEW."terminalReason" IS NOT NULL THEN
      RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_GRANT_STATE_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  NEW."updatedAt" := clock_timestamp();
  IF OLD."id" IS DISTINCT FROM NEW."id"
     OR OLD."projectId" IS DISTINCT FROM NEW."projectId"
     OR OLD."gitConnectionId" IS DISTINCT FROM NEW."gitConnectionId"
     OR OLD."baseDelegationId" IS DISTINCT FROM NEW."baseDelegationId"
     OR OLD."connectionOwnerId" IS DISTINCT FROM NEW."connectionOwnerId"
     OR OLD."connectionOwnerAccountAccessVersion" IS DISTINCT FROM NEW."connectionOwnerAccountAccessVersion"
     OR OLD."baseDelegationVersion" IS DISTINCT FROM NEW."baseDelegationVersion"
     OR OLD."baseDelegationFingerprint" IS DISTINCT FROM NEW."baseDelegationFingerprint"
     OR OLD."repositoryPath" IS DISTINCT FROM NEW."repositoryPath"
     OR OLD."trackedRef" IS DISTINCT FROM NEW."trackedRef"
     OR OLD."includeRoots" IS DISTINCT FROM NEW."includeRoots"
     OR OLD."softExcludePatterns" IS DISTINCT FROM NEW."softExcludePatterns"
     OR OLD."runIntervalMinutes" IS DISTINCT FROM NEW."runIntervalMinutes"
     OR OLD."expiresAt" IS DISTINCT FROM NEW."expiresAt"
     OR OLD."grantFingerprint" IS DISTINCT FROM NEW."grantFingerprint"
     OR OLD."proposedById" IS DISTINCT FROM NEW."proposedById"
     OR OLD."proposedProjectMembershipId" IS DISTINCT FROM NEW."proposedProjectMembershipId"
     OR OLD."proposedMembershipCreatedAt" IS DISTINCT FROM NEW."proposedMembershipCreatedAt"
     OR OLD."proposedAt" IS DISTINCT FROM NEW."proposedAt" THEN
    RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_GRANT_IMMUTABLE' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_GRANT_VERSION_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT (
    (OLD."status" = 'draft' AND NEW."status" IN ('owner_confirmed', 'rejected', 'revoked', 'invalidated'))
    OR (OLD."status" = 'owner_confirmed' AND NEW."status" IN ('active', 'rejected', 'revoked', 'invalidated'))
    OR (OLD."status" = 'active' AND NEW."status" IN ('revoked', 'expired', 'invalidated'))
  ) THEN
    RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_GRANT_STATE_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."ownerConfirmedById" IS NOT NULL AND (
       OLD."ownerConfirmedById" IS DISTINCT FROM NEW."ownerConfirmedById"
       OR OLD."ownerConfirmedProjectMembershipId" IS DISTINCT FROM NEW."ownerConfirmedProjectMembershipId"
       OR OLD."ownerConfirmedMembershipCreatedAt" IS DISTINCT FROM NEW."ownerConfirmedMembershipCreatedAt"
       OR OLD."ownerConfirmedAt" IS DISTINCT FROM NEW."ownerConfirmedAt"
     ) THEN
    RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_GRANT_STATE_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."projectActivatedById" IS NOT NULL AND (
       OLD."projectActivatedById" IS DISTINCT FROM NEW."projectActivatedById"
       OR OLD."projectActivatedMembershipId" IS DISTINCT FROM NEW."projectActivatedMembershipId"
       OR OLD."projectActivatedMembershipCreatedAt" IS DISTINCT FROM NEW."projectActivatedMembershipCreatedAt"
       OR OLD."activatedAt" IS DISTINCT FROM NEW."activatedAt"
     ) THEN
    RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_GRANT_STATE_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" IN ('owner_confirmed', 'active', 'rejected', 'revoked', 'expired', 'invalidated')
     AND NEW."ownerConfirmedById" IS NULL THEN
    -- A proposal may be rejected, revoked or invalidated before connection
    -- owner confirmation; those terminal states need no confirmer.
    IF NEW."status" NOT IN ('rejected', 'revoked', 'invalidated') THEN
      RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_GRANT_STATE_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."status" = 'active' AND (
       NEW."ownerConfirmedById" IS NULL OR NEW."ownerConfirmedProjectMembershipId" IS NULL
       OR NEW."ownerConfirmedMembershipCreatedAt" IS NULL OR NEW."ownerConfirmedAt" IS NULL
       OR NEW."projectActivatedById" IS NULL OR NEW."projectActivatedMembershipId" IS NULL
       OR NEW."projectActivatedMembershipCreatedAt" IS NULL OR NEW."activatedAt" IS NULL
     ) THEN
    RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_GRANT_STATE_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" IN ('rejected', 'revoked', 'expired', 'invalidated')
     AND (NEW."terminalActorKind" IS NULL OR NEW."terminalReason" IS NULL) THEN
    RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_GRANT_TERMINAL_EVIDENCE_REQUIRED' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "PGAG_shape_guard"
BEFORE INSERT OR UPDATE ON "ProjectGitRepositoryAutomationGrant"
FOR EACH ROW EXECUTE FUNCTION "project_git_automation_grant_shape_guard"();

CREATE OR REPLACE FUNCTION "project_git_automation_grant_delete_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF pg_trigger_depth() <= 1 THEN
    RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_GRANT_DELETE_FORBIDDEN' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" IN ('draft', 'owner_confirmed', 'active') THEN
    RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_GRANT_LIVE_DELETE_FORBIDDEN' USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER "PGAG_delete_guard"
BEFORE DELETE ON "ProjectGitRepositoryAutomationGrant"
FOR EACH ROW EXECUTE FUNCTION "project_git_automation_grant_delete_guard"();

CREATE OR REPLACE FUNCTION "project_git_automation_grant_audit_entity_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  grant_row "ProjectGitRepositoryAutomationGrant"%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_GRANT_AUDIT_IMMUTABLE' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO grant_row FROM "ProjectGitRepositoryAutomationGrant" WHERE "id" = NEW."grantId";
  IF grant_row."id" IS NULL
     OR NEW."projectId" IS DISTINCT FROM grant_row."projectId"
     OR NEW."gitConnectionId" IS DISTINCT FROM grant_row."gitConnectionId"
     OR NEW."baseDelegationId" IS DISTINCT FROM grant_row."baseDelegationId"
     OR NEW."connectionOwnerId" IS DISTINCT FROM grant_row."connectionOwnerId"
     OR NEW."grantVersion" IS DISTINCT FROM grant_row."version"
     OR NEW."statusAfter" IS DISTINCT FROM grant_row."status"
     OR NEW."baseDelegationVersion" IS DISTINCT FROM grant_row."baseDelegationVersion"
     OR NEW."baseDelegationFingerprint" IS DISTINCT FROM grant_row."baseDelegationFingerprint"
     OR NEW."repositoryPath" IS DISTINCT FROM grant_row."repositoryPath"
     OR NEW."trackedRef" IS DISTINCT FROM grant_row."trackedRef"
     OR NEW."includeRoots" IS DISTINCT FROM grant_row."includeRoots"
     OR NEW."softExcludePatterns" IS DISTINCT FROM grant_row."softExcludePatterns"
     OR NEW."runIntervalMinutes" IS DISTINCT FROM grant_row."runIntervalMinutes"
     OR NEW."expiresAt" IS DISTINCT FROM grant_row."expiresAt"
     OR NEW."grantFingerprint" IS DISTINCT FROM grant_row."grantFingerprint" THEN
    RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_GRANT_AUDIT_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "PGAGA_entity_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "ProjectGitRepositoryAutomationGrantAudit"
FOR EACH ROW EXECUTE FUNCTION "project_git_automation_grant_audit_entity_guard"();

CREATE OR REPLACE FUNCTION "project_git_automation_grant_append_audit"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  event_action "ProjectGitRepositoryAutomationGrantAuditAction";
  actor_kind "ProjectGitRepositoryAutomationGrantActorKind";
  actor_id UUID;
  actor_membership_id UUID;
  actor_membership_created_at TIMESTAMP(3);
  transition_reason VARCHAR(500);
BEGIN
  IF TG_OP = 'INSERT' THEN
    event_action := 'proposed';
    actor_kind := 'user';
    actor_id := NEW."proposedById";
    actor_membership_id := NEW."proposedProjectMembershipId";
    actor_membership_created_at := NEW."proposedMembershipCreatedAt";
    transition_reason := 'grant_proposed';
  ELSE
    event_action := CASE NEW."status"
      WHEN 'owner_confirmed' THEN 'owner_confirmed'::"ProjectGitRepositoryAutomationGrantAuditAction"
      WHEN 'active' THEN 'activated'::"ProjectGitRepositoryAutomationGrantAuditAction"
      WHEN 'rejected' THEN 'rejected'::"ProjectGitRepositoryAutomationGrantAuditAction"
      WHEN 'revoked' THEN 'revoked'::"ProjectGitRepositoryAutomationGrantAuditAction"
      WHEN 'expired' THEN 'expired'::"ProjectGitRepositoryAutomationGrantAuditAction"
      WHEN 'invalidated' THEN 'invalidated'::"ProjectGitRepositoryAutomationGrantAuditAction"
      ELSE NULL
    END;
    IF event_action IS NULL THEN RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_GRANT_AUDIT_REQUIRED' USING ERRCODE = 'check_violation'; END IF;
    IF NEW."status" = 'owner_confirmed' THEN
      actor_kind := 'user'; actor_id := NEW."ownerConfirmedById";
      actor_membership_id := NEW."ownerConfirmedProjectMembershipId";
      actor_membership_created_at := NEW."ownerConfirmedMembershipCreatedAt";
      transition_reason := 'connection_owner_confirmed_read_only_scope';
    ELSIF NEW."status" = 'active' THEN
      actor_kind := 'user'; actor_id := NEW."projectActivatedById";
      actor_membership_id := NEW."projectActivatedMembershipId";
      actor_membership_created_at := NEW."projectActivatedMembershipCreatedAt";
      transition_reason := 'project_owner_activated_automation_grant';
    ELSE
      actor_kind := COALESCE(NEW."terminalActorKind", 'system'::"ProjectGitRepositoryAutomationGrantActorKind");
      actor_id := NEW."terminalActorId";
      actor_membership_id := NEW."terminalActorProjectMembershipId";
      actor_membership_created_at := NEW."terminalActorMembershipCreatedAt";
      transition_reason := COALESCE(NEW."terminalReason", 'grant_invalidated');
    END IF;
  END IF;

  INSERT INTO "ProjectGitRepositoryAutomationGrantAudit" (
    "id", "grantId", "projectId", "gitConnectionId", "baseDelegationId", "connectionOwnerId",
    "action", "grantVersion", "statusBefore", "statusAfter", "actorKind", "actorId",
    "actorProjectMembershipId", "actorMembershipCreatedAt", "terminalActorKind", "terminalActorId",
    "terminalActorProjectMembershipId", "terminalActorMembershipCreatedAt", "terminalReason",
    "baseDelegationVersion", "baseDelegationFingerprint", "repositoryPath", "trackedRef", "includeRoots",
    "softExcludePatterns", "runIntervalMinutes", "expiresAt", "grantFingerprint", "reason", "transitionAt"
  ) VALUES (
    gen_random_uuid(), NEW."id", NEW."projectId", NEW."gitConnectionId", NEW."baseDelegationId", NEW."connectionOwnerId",
    event_action, NEW."version", CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD."status" END, NEW."status",
    actor_kind, actor_id, actor_membership_id, actor_membership_created_at,
    NEW."terminalActorKind", NEW."terminalActorId", NEW."terminalActorProjectMembershipId",
    NEW."terminalActorMembershipCreatedAt", NEW."terminalReason", NEW."baseDelegationVersion",
    NEW."baseDelegationFingerprint", NEW."repositoryPath", NEW."trackedRef", NEW."includeRoots",
    NEW."softExcludePatterns", NEW."runIntervalMinutes", NEW."expiresAt", NEW."grantFingerprint",
    transition_reason, CASE WHEN TG_OP = 'INSERT' THEN NEW."proposedAt" ELSE NEW."updatedAt" END
  );
  RETURN NULL;
END;
$$;
CREATE TRIGGER "PGAG_append_audit"
AFTER INSERT OR UPDATE ON "ProjectGitRepositoryAutomationGrant"
FOR EACH ROW EXECUTE FUNCTION "project_git_automation_grant_append_audit"();

CREATE OR REPLACE FUNCTION "project_git_automation_grant_validate_live"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  base_valid BOOLEAN;
  proposer_valid BOOLEAN;
  owner_confirmer_valid BOOLEAN;
  project_activator_valid BOOLEAN;
BEGIN
  IF NEW."status" NOT IN ('draft', 'owner_confirmed', 'active') THEN RETURN NEW; END IF;
  IF NEW."expiresAt" <= clock_timestamp() THEN
    RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_GRANT_EXPIRED' USING ERRCODE = 'check_violation';
  END IF;
  SELECT EXISTS (
    SELECT 1
    FROM "ProjectGitRepositoryDelegation" base
    JOIN "Project" project_row ON project_row."id" = NEW."projectId"
    JOIN "GitConnection" connection ON connection."id" = NEW."gitConnectionId"
    JOIN "ExternalCredential" credential ON credential."id" = connection."credentialId"
    WHERE base."id" = NEW."baseDelegationId"
      AND base."projectId" = NEW."projectId"
      AND base."gitConnectionId" = NEW."gitConnectionId"
      AND base."connectionOwnerId" = NEW."connectionOwnerId"
      AND base."version" = NEW."baseDelegationVersion"
      AND base."delegationFingerprint" = NEW."baseDelegationFingerprint"
      AND base."status" = 'active'
      AND base."automationAllowed" = false
      AND base."manualSyncAllowed" = true
      AND base."expiresAt" >= NEW."expiresAt"
      AND base."repositoryPath" = NEW."repositoryPath"
      AND base."trackedRef" = NEW."trackedRef"
      AND base."includeRoots" = NEW."includeRoots"
      AND base."softExcludePatterns" = NEW."softExcludePatterns"
      AND project_row."archivedAt" IS NULL
      AND connection."ownerUserId" = NEW."connectionOwnerId"
      AND connection."ownerAccountAccessVersion" = NEW."connectionOwnerAccountAccessVersion"
      AND connection."ownershipState" = 'confirmed'
      AND connection."status" = 'verified'
      AND connection."configurationVersion" = base."connectionConfigurationVersion"
      AND connection."resolvedAddressFingerprint" = base."resolvedAddressFingerprint"
      AND credential."kind" = 'git'
      AND credential."secretFingerprint" = base."credentialFingerprint"
      AND EXISTS (
        SELECT 1 FROM "AppUser" owner_user
        WHERE owner_user."id" = NEW."connectionOwnerId"
          AND owner_user."disabledAt" IS NULL
          AND owner_user."accountAccessVersion" = NEW."connectionOwnerAccountAccessVersion"
      )
  ) INTO base_valid;
  IF NOT base_valid THEN RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_GRANT_BASE_DRIFT' USING ERRCODE = 'check_violation'; END IF;

  SELECT EXISTS (
    SELECT 1 FROM "AppUser" proposer
    JOIN "ProjectMembership" membership ON membership."id" = NEW."proposedProjectMembershipId"
    WHERE proposer."id" = NEW."proposedById" AND proposer."disabledAt" IS NULL
      AND membership."projectId" = NEW."projectId" AND membership."userId" = NEW."proposedById"
      AND membership."createdAt" = NEW."proposedMembershipCreatedAt"
      AND membership."role" IN ('owner', 'editor') AND membership."accessState" = 'confirmed'
  ) INTO proposer_valid;
  IF NOT proposer_valid THEN RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_GRANT_PROPOSER_INVALID' USING ERRCODE = 'check_violation'; END IF;

  IF NEW."status" IN ('owner_confirmed', 'active') THEN
    SELECT EXISTS (
      SELECT 1 FROM "AppUser" owner_user
      JOIN "ProjectMembership" membership ON membership."id" = NEW."ownerConfirmedProjectMembershipId"
      WHERE owner_user."id" = NEW."ownerConfirmedById"
        AND owner_user."id" = NEW."connectionOwnerId"
        AND owner_user."disabledAt" IS NULL
        AND owner_user."accountAccessVersion" = NEW."connectionOwnerAccountAccessVersion"
        AND membership."projectId" = NEW."projectId"
        AND membership."userId" = NEW."ownerConfirmedById"
        AND membership."createdAt" = NEW."ownerConfirmedMembershipCreatedAt"
        AND membership."role" IN ('owner', 'editor') AND membership."accessState" = 'confirmed'
    ) INTO owner_confirmer_valid;
    IF NOT owner_confirmer_valid THEN RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_GRANT_OWNER_CONFIRMATION_INVALID' USING ERRCODE = 'check_violation'; END IF;
  END IF;

  IF NEW."status" = 'active' THEN
    SELECT EXISTS (
      SELECT 1 FROM "AppUser" project_owner
      JOIN "ProjectMembership" membership ON membership."id" = NEW."projectActivatedMembershipId"
      WHERE project_owner."id" = NEW."projectActivatedById"
        AND project_owner."disabledAt" IS NULL
        AND membership."projectId" = NEW."projectId"
        AND membership."userId" = NEW."projectActivatedById"
        AND membership."createdAt" = NEW."projectActivatedMembershipCreatedAt"
        AND membership."role" = 'owner' AND membership."accessState" = 'confirmed'
    ) INTO project_activator_valid;
    IF NOT project_activator_valid THEN RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_GRANT_PROJECT_OWNER_INVALID' USING ERRCODE = 'check_violation'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER "PGAG_live_integrity_guard"
AFTER INSERT OR UPDATE ON "ProjectGitRepositoryAutomationGrant"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "project_git_automation_grant_validate_live"();

CREATE OR REPLACE FUNCTION "project_git_automation_grant_audit_required"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "ProjectGitRepositoryAutomationGrantAudit" audit
    WHERE audit."grantId" = NEW."id"
      AND audit."grantVersion" = NEW."version"
      AND audit."statusAfter" = NEW."status"
      AND audit."baseDelegationVersion" = NEW."baseDelegationVersion"
      AND audit."baseDelegationFingerprint" = NEW."baseDelegationFingerprint"
      AND audit."grantFingerprint" = NEW."grantFingerprint"
  ) THEN
    RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_GRANT_AUDIT_REQUIRED' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER "PGAG_audit_required"
AFTER INSERT OR UPDATE ON "ProjectGitRepositoryAutomationGrant"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "project_git_automation_grant_audit_required"();

CREATE OR REPLACE FUNCTION "project_git_automation_grant_invalidate"(target_project UUID, target_connection UUID, target_base UUID, invalidation_reason VARCHAR)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF pg_trigger_depth() = 0 THEN
    RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_INVALIDATION_REQUIRES_TRIGGER' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE "ProjectGitRepositoryAutomationGrant" grant_row
  SET "version" = grant_row."version" + 1,
      "status" = 'invalidated',
      "terminalActorKind" = 'system',
      "terminalActorId" = NULL,
      "terminalActorProjectMembershipId" = NULL,
      "terminalActorMembershipCreatedAt" = NULL,
      "terminalReason" = invalidation_reason
  WHERE grant_row."status" IN ('draft', 'owner_confirmed', 'active')
    AND (target_project IS NULL OR grant_row."projectId" = target_project)
    AND (target_connection IS NULL OR grant_row."gitConnectionId" = target_connection)
    AND (target_base IS NULL OR grant_row."baseDelegationId" = target_base);
END;
$$;

CREATE OR REPLACE FUNCTION "project_git_automation_grant_invalidate_base"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."status" = 'active' AND NEW."status" IN ('revoked', 'expired', 'rejected') THEN
    PERFORM "project_git_automation_grant_invalidate"(NULL, NULL, NEW."id", 'base_delegation_ended');
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER "PGAG_invalidate_on_base_delegation_end"
AFTER UPDATE OF "status" ON "ProjectGitRepositoryDelegation"
FOR EACH ROW EXECUTE FUNCTION "project_git_automation_grant_invalidate_base"();

CREATE OR REPLACE FUNCTION "project_git_automation_grant_invalidate_connection"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."configurationVersion" IS DISTINCT FROM NEW."configurationVersion"
     OR OLD."ownerUserId" IS DISTINCT FROM NEW."ownerUserId"
     OR OLD."ownerAccountAccessVersion" IS DISTINCT FROM NEW."ownerAccountAccessVersion"
     OR OLD."ownershipState" IS DISTINCT FROM NEW."ownershipState" THEN
    PERFORM "project_git_automation_grant_invalidate"(NULL, NEW."id", NULL, 'git_connection_changed');
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER "PGAG_invalidate_on_connection_change"
AFTER UPDATE ON "GitConnection"
FOR EACH ROW EXECUTE FUNCTION "project_git_automation_grant_invalidate_connection"();

CREATE OR REPLACE FUNCTION "project_git_automation_grant_invalidate_archived_project"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."archivedAt" IS NULL AND NEW."archivedAt" IS NOT NULL THEN
    PERFORM "project_git_automation_grant_invalidate"(NEW."id", NULL, NULL, 'project_archived');
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER "PGAG_invalidate_on_project_archive"
AFTER UPDATE OF "archivedAt" ON "Project"
FOR EACH ROW EXECUTE FUNCTION "project_git_automation_grant_invalidate_archived_project"();
