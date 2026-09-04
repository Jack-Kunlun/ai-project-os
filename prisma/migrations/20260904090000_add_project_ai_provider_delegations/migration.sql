-- WP05B1: store personal-model project delegation intent separately from the
-- legacy ProjectAiRoute/WebAiGrant runtime paths.  This migration creates an
-- empty, append-only control-plane foundation; no legacy route is promoted.

CREATE TYPE "ProjectAiProviderDelegationStatus" AS ENUM (
  'draft',
  'owner_confirmed',
  'active',
  'rejected',
  'revoked',
  'expired'
);

CREATE TYPE "ProjectAiEffectiveRouteSelectionSource" AS ENUM (
  'platform_default',
  'personal_delegation'
);

CREATE TYPE "ProjectAiProviderDelegationAuditEntity" AS ENUM (
  'delegation',
  'selection'
);

CREATE TYPE "ProjectAiProviderDelegationAuditAction" AS ENUM (
  'proposed',
  'owner_confirmed',
  'activated',
  'rejected',
  'revoked',
  'expired',
  'platform_selected',
  'personal_selected',
  'selection_updated'
);

CREATE TYPE "ProjectAiProviderDelegationActorKind" AS ENUM (
  'user',
  'system_expiry'
);

CREATE TABLE "ProjectAiProviderDelegation" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "operation" "AiOperation" NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "status" "ProjectAiProviderDelegationStatus" NOT NULL DEFAULT 'draft',
  "providerConnectionId" UUID NOT NULL,
  "connectionOwnerId" UUID NOT NULL,
  "ownerProjectMembershipId" UUID NOT NULL,
  "ownerMembershipCreatedAt" TIMESTAMP(3) NOT NULL,
  "projectConfirmedProjectMembershipId" UUID,
  "projectConfirmedMembershipCreatedAt" TIMESTAMP(3),
  "connectionOwnerSubscriptionId" UUID NOT NULL,
  "connectionOwnerSubscriptionVersion" INTEGER NOT NULL,
  "connectionOwnerSubscriptionStartsAt" TIMESTAMP(3) NOT NULL,
  "connectionOwnerSubscriptionExpiresAt" TIMESTAMP(3) NOT NULL,
  "modelId" VARCHAR(128) NOT NULL,
  "embeddingDimensions" INTEGER,
  "maxOutputTokens" INTEGER,
  "providerConfigurationVersion" INTEGER NOT NULL,
  "credentialFingerprint" CHAR(64) NOT NULL,
  "delegationFingerprint" CHAR(64) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "proposedById" UUID NOT NULL,
  "proposedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ownerConfirmedById" UUID,
  "ownerConfirmedAt" TIMESTAMP(3),
  "projectConfirmedById" UUID,
  "projectConfirmedAt" TIMESTAMP(3),
  "activatedAt" TIMESTAMP(3),
  "rejectedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "expiredAt" TIMESTAMP(3),
  "terminalActorKind" "ProjectAiProviderDelegationActorKind",
  "terminalActorId" UUID,
  "terminalActorProjectMembershipId" UUID,
  "terminalActorMembershipCreatedAt" TIMESTAMP(3),
  "terminalReason" VARCHAR(500),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProjectAiProviderDelegation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProjectAiProviderDelegation_version_check" CHECK ("version" > 0),
  CONSTRAINT "PAD_provider_config_version_check" CHECK ("providerConfigurationVersion" > 0),
  CONSTRAINT "ProjectAiProviderDelegation_fingerprint_check" CHECK (
    "credentialFingerprint" ~ '^[0-9a-f]{64}$'
    AND "delegationFingerprint" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "ProjectAiProviderDelegation_model_check" CHECK (length("modelId") > 0),
  CONSTRAINT "ProjectAiProviderDelegation_expiry_check" CHECK ("expiresAt" > "proposedAt"),
  CONSTRAINT "PAD_subscription_snapshot_check" CHECK (
    "connectionOwnerSubscriptionVersion" > 0
    AND "connectionOwnerSubscriptionExpiresAt" > "connectionOwnerSubscriptionStartsAt"
  ),
  CONSTRAINT "ProjectAiProviderDelegation_operation_payload_check" CHECK (
    ("operation" = 'embedding'
      AND "embeddingDimensions" BETWEEN 8 AND 8192
      AND "maxOutputTokens" IS NULL)
    OR ("operation" <> 'embedding'
      AND "embeddingDimensions" IS NULL
      AND "maxOutputTokens" BETWEEN 1 AND 65536)
  )
);

CREATE TABLE "ProjectAiEffectiveRouteSelection" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "operation" "AiOperation" NOT NULL,
  "source" "ProjectAiEffectiveRouteSelectionSource" NOT NULL,
  "delegationId" UUID,
  "selectedById" UUID NOT NULL,
  "selectedByProjectMembershipId" UUID NOT NULL,
  "selectedByMembershipCreatedAt" TIMESTAMP(3) NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProjectAiEffectiveRouteSelection_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProjectAiEffectiveRouteSelection_version_check" CHECK ("version" > 0),
  CONSTRAINT "ProjectAiEffectiveRouteSelection_source_check" CHECK (
    ("source" = 'platform_default' AND "delegationId" IS NULL)
    OR ("source" = 'personal_delegation' AND "delegationId" IS NOT NULL)
  )
);

-- Audit rows deliberately contain only scalar snapshots.  They survive a
-- project/provider/user deletion and can be correlated using projectId and
-- ProjectDeletionReceipt.deletedProjectId; PostgreSQL does not validate any
-- business fingerprint calculation here.
CREATE TABLE "ProjectAiProviderDelegationAudit" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "operation" "AiOperation" NOT NULL,
  "entity" "ProjectAiProviderDelegationAuditEntity" NOT NULL,
  "action" "ProjectAiProviderDelegationAuditAction" NOT NULL,
  "delegationId" UUID,
  "selectionId" UUID,
  "delegationVersion" INTEGER,
  "selectionVersion" INTEGER,
  "statusBefore" "ProjectAiProviderDelegationStatus",
  "statusAfter" "ProjectAiProviderDelegationStatus",
  "selectionSource" "ProjectAiEffectiveRouteSelectionSource",
  "selectedDelegationId" UUID,
  "selectedByProjectMembershipId" UUID,
  "selectedByMembershipCreatedAt" TIMESTAMP(3),
  "providerConnectionId" UUID,
  "connectionOwnerId" UUID,
  "ownerProjectMembershipId" UUID,
  "projectConfirmedProjectMembershipId" UUID,
  "projectConfirmedMembershipCreatedAt" TIMESTAMP(3),
  "connectionOwnerSubscriptionId" UUID,
  "connectionOwnerSubscriptionVersion" INTEGER,
  "connectionOwnerSubscriptionStartsAt" TIMESTAMP(3),
  "connectionOwnerSubscriptionExpiresAt" TIMESTAMP(3),
  "modelId" VARCHAR(128),
  "embeddingDimensions" INTEGER,
  "maxOutputTokens" INTEGER,
  "providerConfigurationVersion" INTEGER,
  "credentialFingerprint" CHAR(64),
  "delegationFingerprint" CHAR(64),
  "terminalActorKind" "ProjectAiProviderDelegationActorKind",
  "terminalActorId" UUID,
  "terminalActorProjectMembershipId" UUID,
  "terminalActorMembershipCreatedAt" TIMESTAMP(3),
  "terminalReason" VARCHAR(500),
  "actorKind" "ProjectAiProviderDelegationActorKind" NOT NULL DEFAULT 'user',
  "actorId" UUID,
  "actorProjectMembershipId" UUID,
  "actorMembershipCreatedAt" TIMESTAMP(3),
  "reason" VARCHAR(500) NOT NULL,
  "transitionAt" TIMESTAMP(3) NOT NULL,
  "transactionId" BIGINT NOT NULL DEFAULT txid_current(),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProjectAiProviderDelegationAudit_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProjectAiProviderDelegationAudit_entity_check" CHECK (
    ("entity" = 'delegation'
      AND "delegationId" IS NOT NULL
      AND "selectionId" IS NULL
      AND "delegationVersion" IS NOT NULL
      AND "statusAfter" IS NOT NULL
      AND "selectionVersion" IS NULL
      AND "selectionSource" IS NULL
      AND "selectedDelegationId" IS NULL
      AND "action" IN ('proposed', 'owner_confirmed', 'activated', 'rejected', 'revoked', 'expired'))
    OR ("entity" = 'selection'
      AND "selectionId" IS NOT NULL
      AND "delegationId" IS NULL
      AND "selectionVersion" IS NOT NULL
      AND "selectionSource" IS NOT NULL
      AND "statusBefore" IS NULL
      AND "statusAfter" IS NULL
      AND "action" IN ('platform_selected', 'personal_selected', 'selection_updated'))
  ),
  CONSTRAINT "PAD_A_actor_kind_check" CHECK (
    ("actorKind" = 'user'
      AND "actorId" IS NOT NULL
      AND "actorProjectMembershipId" IS NOT NULL
      AND "actorMembershipCreatedAt" IS NOT NULL)
    OR ("actorKind" = 'system_expiry'
      AND "entity" = 'delegation'
      AND "action" = 'expired'
      AND "actorId" IS NULL
      AND "actorProjectMembershipId" IS NULL
      AND "actorMembershipCreatedAt" IS NULL)
  ),
  CONSTRAINT "ProjectAiProviderDelegationAudit_fingerprint_check" CHECK (
    ("credentialFingerprint" IS NULL OR "credentialFingerprint" ~ '^[0-9a-f]{64}$')
    AND ("delegationFingerprint" IS NULL OR "delegationFingerprint" ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT "ProjectAiProviderDelegationAudit_payload_check" CHECK (
    ("embeddingDimensions" IS NULL OR "embeddingDimensions" BETWEEN 8 AND 8192)
    AND ("maxOutputTokens" IS NULL OR "maxOutputTokens" BETWEEN 1 AND 65536)
    AND ("providerConfigurationVersion" IS NULL OR "providerConfigurationVersion" > 0)
  )
);

CREATE UNIQUE INDEX "ProjectAiProviderDelegation_live_project_operation_key"
  ON "ProjectAiProviderDelegation"("projectId", "operation")
  WHERE "status" IN ('draft', 'owner_confirmed', 'active');
CREATE INDEX "PAD_project_operation_status_exp_idx"
  ON "ProjectAiProviderDelegation"("projectId", "operation", "status", "expiresAt");
CREATE INDEX "PAD_provider_status_idx"
  ON "ProjectAiProviderDelegation"("providerConnectionId", "status");
CREATE INDEX "PAD_connection_owner_status_idx"
  ON "ProjectAiProviderDelegation"("connectionOwnerId", "status");

CREATE UNIQUE INDEX "ProjectAiEffectiveRouteSelection_project_operation_key"
  ON "ProjectAiEffectiveRouteSelection"("projectId", "operation");
CREATE INDEX "ProjectAiEffectiveRouteSelection_delegationId_source_idx"
  ON "ProjectAiEffectiveRouteSelection"("delegationId", "source");
CREATE INDEX "PAERS_selected_by_updated_at_idx"
  ON "ProjectAiEffectiveRouteSelection"("selectedById", "updatedAt");

CREATE INDEX "PAD_A_project_operation_created_idx"
  ON "ProjectAiProviderDelegationAudit"("projectId", "operation", "createdAt");
CREATE INDEX "PAD_A_delegation_version_created_idx"
  ON "ProjectAiProviderDelegationAudit"("delegationId", "delegationVersion", "createdAt");
CREATE INDEX "PAD_A_selection_version_created_idx"
  ON "ProjectAiProviderDelegationAudit"("selectionId", "selectionVersion", "createdAt");
CREATE INDEX "PAD_A_transaction_created_idx"
  ON "ProjectAiProviderDelegationAudit"("transactionId", "createdAt");

-- Each entity version has one causal audit row.  The entity-side deferred
-- guards below still require the row to be in the same transaction; these
-- partial unique indexes close duplicate-version evidence and timing bypasses.
CREATE UNIQUE INDEX "PAD_A_delegation_version_unique"
  ON "ProjectAiProviderDelegationAudit"("delegationId", "delegationVersion")
  WHERE "entity" = 'delegation' AND "delegationId" IS NOT NULL AND "delegationVersion" IS NOT NULL;
CREATE UNIQUE INDEX "PAD_A_selection_version_unique"
  ON "ProjectAiProviderDelegationAudit"("selectionId", "selectionVersion")
  WHERE "entity" = 'selection' AND "selectionId" IS NOT NULL AND "selectionVersion" IS NOT NULL;

ALTER TABLE "ProjectAiProviderDelegation"
  ADD CONSTRAINT "ProjectAiProviderDelegation_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "ProjectAiProviderDelegation_providerConnectionId_fkey"
    FOREIGN KEY ("providerConnectionId") REFERENCES "AiProviderConnection"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "ProjectAiProviderDelegation_connectionOwnerId_fkey"
    FOREIGN KEY ("connectionOwnerId") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "ProjectAiProviderDelegation_proposedById_fkey"
    FOREIGN KEY ("proposedById") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "ProjectAiProviderDelegation_ownerConfirmedById_fkey"
    FOREIGN KEY ("ownerConfirmedById") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "ProjectAiProviderDelegation_projectConfirmedById_fkey"
    FOREIGN KEY ("projectConfirmedById") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "ProjectAiEffectiveRouteSelection"
  ADD CONSTRAINT "ProjectAiEffectiveRouteSelection_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "ProjectAiEffectiveRouteSelection_delegationId_fkey"
    FOREIGN KEY ("delegationId") REFERENCES "ProjectAiProviderDelegation"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "ProjectAiEffectiveRouteSelection_selectedById_fkey"
    FOREIGN KEY ("selectedById") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- All control-plane and dependent identity mutations enter one transaction
-- advisory-lock domain before the statement acquires target-row locks.  The
-- statement-level trigger is deliberately fail-fast: callers may retry a
-- serialization failure, but the database must never wait on a lock while
-- holding a tuple lock from another table.
CREATE OR REPLACE FUNCTION "project_ai_provider_delegation_global_lock"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtextextended('ai-project-provider-delegation-global', 0)) THEN
    RAISE EXCEPTION 'PROJECT_AI_PROVIDER_DELEGATION_LOCK_BUSY'
      USING ERRCODE = 'serialization_failure';
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER "PAD_delegation_global_lock"
BEFORE INSERT OR UPDATE OR DELETE ON "ProjectAiProviderDelegation"
FOR EACH STATEMENT EXECUTE FUNCTION "project_ai_provider_delegation_global_lock"();

CREATE TRIGGER "PAERS_global_lock"
BEFORE INSERT OR UPDATE OR DELETE ON "ProjectAiEffectiveRouteSelection"
FOR EACH STATEMENT EXECUTE FUNCTION "project_ai_provider_delegation_global_lock"();

CREATE OR REPLACE FUNCTION "project_ai_provider_delegation_shape_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  terminal_actor_valid boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- The database is the source of truth for proposal time.  A caller may
    -- provide a value for shape compatibility, but it is never trusted.
    NEW."proposedAt" := clock_timestamp();
  ELSIF OLD."status" = 'draft' AND NEW."status" = 'owner_confirmed' THEN
    NEW."ownerConfirmedAt" := clock_timestamp();
  ELSIF OLD."status" = 'owner_confirmed' AND NEW."status" = 'active' THEN
    NEW."projectConfirmedAt" := clock_timestamp();
    NEW."activatedAt" := NEW."projectConfirmedAt";
  ELSIF NEW."status" = 'rejected'
    AND OLD."status" IN ('draft', 'owner_confirmed') THEN
    NEW."rejectedAt" := clock_timestamp();
    NEW."terminalActorKind" := 'user'::"ProjectAiProviderDelegationActorKind";
  ELSIF NEW."status" = 'revoked' AND OLD."status" = 'active' THEN
    NEW."revokedAt" := clock_timestamp();
    NEW."terminalActorKind" := 'user'::"ProjectAiProviderDelegationActorKind";
  ELSIF NEW."status" = 'expired'
    AND OLD."status" IN ('draft', 'owner_confirmed', 'active') THEN
    -- Expiry is system reconciliation, never a user-authored terminal action.
    NEW."expiredAt" := clock_timestamp();
    NEW."terminalActorKind" := 'system_expiry'::"ProjectAiProviderDelegationActorKind";
    NEW."terminalActorId" := NULL;
    NEW."terminalActorProjectMembershipId" := NULL;
    NEW."terminalActorMembershipCreatedAt" := NULL;
    NEW."terminalReason" := 'system_expiry';
  END IF;
  IF NEW."proposedById" IS DISTINCT FROM NEW."connectionOwnerId" THEN
    RAISE EXCEPTION 'PROJECT_AI_PROVIDER_DELEGATION_PROPOSER_INVALID'
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'draft' OR NEW."version" <> 1 THEN
      RAISE EXCEPTION 'PROJECT_AI_PROVIDER_DELEGATION_STATE_INVALID'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF OLD."id" IS DISTINCT FROM NEW."id"
       OR OLD."createdAt" IS DISTINCT FROM NEW."createdAt"
       OR OLD."projectId" IS DISTINCT FROM NEW."projectId"
       OR OLD."operation" IS DISTINCT FROM NEW."operation"
       OR OLD."providerConnectionId" IS DISTINCT FROM NEW."providerConnectionId"
       OR OLD."connectionOwnerId" IS DISTINCT FROM NEW."connectionOwnerId"
       OR OLD."ownerProjectMembershipId" IS DISTINCT FROM NEW."ownerProjectMembershipId"
       OR OLD."ownerMembershipCreatedAt" IS DISTINCT FROM NEW."ownerMembershipCreatedAt"
       OR OLD."connectionOwnerSubscriptionId" IS DISTINCT FROM NEW."connectionOwnerSubscriptionId"
       OR OLD."connectionOwnerSubscriptionVersion" IS DISTINCT FROM NEW."connectionOwnerSubscriptionVersion"
       OR OLD."connectionOwnerSubscriptionStartsAt" IS DISTINCT FROM NEW."connectionOwnerSubscriptionStartsAt"
       OR OLD."connectionOwnerSubscriptionExpiresAt" IS DISTINCT FROM NEW."connectionOwnerSubscriptionExpiresAt"
       OR OLD."modelId" IS DISTINCT FROM NEW."modelId"
       OR OLD."embeddingDimensions" IS DISTINCT FROM NEW."embeddingDimensions"
       OR OLD."maxOutputTokens" IS DISTINCT FROM NEW."maxOutputTokens"
       OR OLD."providerConfigurationVersion" IS DISTINCT FROM NEW."providerConfigurationVersion"
       OR OLD."credentialFingerprint" IS DISTINCT FROM NEW."credentialFingerprint"
       OR OLD."delegationFingerprint" IS DISTINCT FROM NEW."delegationFingerprint"
       OR OLD."expiresAt" IS DISTINCT FROM NEW."expiresAt"
       OR OLD."proposedById" IS DISTINCT FROM NEW."proposedById"
       OR OLD."proposedAt" IS DISTINCT FROM NEW."proposedAt"
    THEN
      RAISE EXCEPTION 'PROJECT_AI_PROVIDER_DELEGATION_IMMUTABLE'
        USING ERRCODE = 'check_violation';
    END IF;
    IF (OLD."ownerConfirmedById" IS NOT NULL AND OLD."ownerConfirmedById" IS DISTINCT FROM NEW."ownerConfirmedById")
       OR (OLD."ownerConfirmedAt" IS NOT NULL AND OLD."ownerConfirmedAt" IS DISTINCT FROM NEW."ownerConfirmedAt")
       OR (OLD."projectConfirmedById" IS NOT NULL AND OLD."projectConfirmedById" IS DISTINCT FROM NEW."projectConfirmedById")
       OR (OLD."projectConfirmedAt" IS NOT NULL AND OLD."projectConfirmedAt" IS DISTINCT FROM NEW."projectConfirmedAt")
       OR (OLD."projectConfirmedProjectMembershipId" IS NOT NULL AND OLD."projectConfirmedProjectMembershipId" IS DISTINCT FROM NEW."projectConfirmedProjectMembershipId")
       OR (OLD."projectConfirmedMembershipCreatedAt" IS NOT NULL AND OLD."projectConfirmedMembershipCreatedAt" IS DISTINCT FROM NEW."projectConfirmedMembershipCreatedAt")
       OR (OLD."activatedAt" IS NOT NULL AND OLD."activatedAt" IS DISTINCT FROM NEW."activatedAt")
       OR (OLD."rejectedAt" IS NOT NULL AND OLD."rejectedAt" IS DISTINCT FROM NEW."rejectedAt")
       OR (OLD."revokedAt" IS NOT NULL AND OLD."revokedAt" IS DISTINCT FROM NEW."revokedAt")
       OR (OLD."expiredAt" IS NOT NULL AND OLD."expiredAt" IS DISTINCT FROM NEW."expiredAt")
       OR (OLD."terminalActorKind" IS NOT NULL AND OLD."terminalActorKind" IS DISTINCT FROM NEW."terminalActorKind")
       OR (OLD."terminalActorId" IS NOT NULL AND OLD."terminalActorId" IS DISTINCT FROM NEW."terminalActorId")
       OR (OLD."terminalActorProjectMembershipId" IS NOT NULL AND OLD."terminalActorProjectMembershipId" IS DISTINCT FROM NEW."terminalActorProjectMembershipId")
       OR (OLD."terminalActorMembershipCreatedAt" IS NOT NULL AND OLD."terminalActorMembershipCreatedAt" IS DISTINCT FROM NEW."terminalActorMembershipCreatedAt")
       OR (OLD."terminalReason" IS NOT NULL AND OLD."terminalReason" IS DISTINCT FROM NEW."terminalReason")
    THEN
      RAISE EXCEPTION 'PROJECT_AI_PROVIDER_DELEGATION_CONFIRMATION_IMMUTABLE'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."version" <> OLD."version" + 1 THEN
      RAISE EXCEPTION 'PROJECT_AI_PROVIDER_DELEGATION_VERSION_INVALID'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT (
      (OLD."status" = 'draft' AND NEW."status" IN ('owner_confirmed', 'rejected'))
      OR (OLD."status" = 'draft' AND NEW."status" = 'expired')
      OR (OLD."status" = 'owner_confirmed' AND NEW."status" IN ('active', 'rejected', 'expired'))
      OR (OLD."status" = 'active' AND NEW."status" IN ('revoked', 'expired'))
    ) THEN
      RAISE EXCEPTION 'PROJECT_AI_PROVIDER_DELEGATION_STATE_INVALID'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."status" = 'draft' THEN
    IF NEW."ownerConfirmedById" IS NOT NULL OR NEW."ownerConfirmedAt" IS NOT NULL
       OR NEW."projectConfirmedById" IS NOT NULL OR NEW."projectConfirmedAt" IS NOT NULL
       OR NEW."projectConfirmedProjectMembershipId" IS NOT NULL OR NEW."projectConfirmedMembershipCreatedAt" IS NOT NULL
       OR NEW."activatedAt" IS NOT NULL OR NEW."rejectedAt" IS NOT NULL
       OR NEW."revokedAt" IS NOT NULL OR NEW."expiredAt" IS NOT NULL
       OR NEW."terminalActorKind" IS NOT NULL
       OR NEW."terminalActorId" IS NOT NULL OR NEW."terminalActorProjectMembershipId" IS NOT NULL
       OR NEW."terminalActorMembershipCreatedAt" IS NOT NULL OR NEW."terminalReason" IS NOT NULL
    THEN
      RAISE EXCEPTION 'PROJECT_AI_PROVIDER_DELEGATION_STATE_INVALID'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."status" = 'owner_confirmed' THEN
    IF NEW."ownerConfirmedById" IS DISTINCT FROM NEW."connectionOwnerId"
       OR NEW."ownerConfirmedAt" IS NULL
       OR NEW."ownerConfirmedAt" < NEW."proposedAt"
       OR NEW."projectConfirmedById" IS NOT NULL OR NEW."projectConfirmedAt" IS NOT NULL
       OR NEW."projectConfirmedProjectMembershipId" IS NOT NULL OR NEW."projectConfirmedMembershipCreatedAt" IS NOT NULL
       OR NEW."activatedAt" IS NOT NULL OR NEW."rejectedAt" IS NOT NULL
       OR NEW."revokedAt" IS NOT NULL OR NEW."expiredAt" IS NOT NULL
       OR NEW."terminalActorKind" IS NOT NULL
       OR NEW."terminalActorId" IS NOT NULL OR NEW."terminalActorProjectMembershipId" IS NOT NULL
       OR NEW."terminalActorMembershipCreatedAt" IS NOT NULL OR NEW."terminalReason" IS NOT NULL
    THEN
      RAISE EXCEPTION 'PROJECT_AI_PROVIDER_DELEGATION_STATE_INVALID'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."status" = 'active' THEN
    IF NEW."ownerConfirmedById" IS DISTINCT FROM NEW."connectionOwnerId"
       OR NEW."ownerConfirmedAt" IS NULL
       OR NEW."projectConfirmedById" IS NULL OR NEW."projectConfirmedAt" IS NULL
       OR NEW."projectConfirmedProjectMembershipId" IS NULL OR NEW."projectConfirmedMembershipCreatedAt" IS NULL
       OR NEW."activatedAt" IS NULL
       OR NEW."ownerConfirmedAt" < NEW."proposedAt"
       OR NEW."ownerConfirmedAt" > NEW."projectConfirmedAt"
       OR NEW."projectConfirmedAt" > NEW."activatedAt"
       OR NEW."rejectedAt" IS NOT NULL OR NEW."revokedAt" IS NOT NULL OR NEW."expiredAt" IS NOT NULL
       OR NEW."terminalActorKind" IS NOT NULL
       OR NEW."terminalActorId" IS NOT NULL OR NEW."terminalActorProjectMembershipId" IS NOT NULL
       OR NEW."terminalActorMembershipCreatedAt" IS NOT NULL OR NEW."terminalReason" IS NOT NULL
    THEN
      RAISE EXCEPTION 'PROJECT_AI_PROVIDER_DELEGATION_STATE_INVALID'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."status" = 'rejected' THEN
    IF NEW."rejectedAt" IS NULL OR NEW."revokedAt" IS NOT NULL OR NEW."expiredAt" IS NOT NULL
       OR NEW."activatedAt" IS NOT NULL
       OR NEW."terminalActorKind" IS DISTINCT FROM 'user'
       OR NEW."terminalActorId" IS NULL OR NEW."terminalActorProjectMembershipId" IS NULL
       OR NEW."terminalActorMembershipCreatedAt" IS NULL OR NEW."terminalReason" IS NULL
       OR length(btrim(NEW."terminalReason")) = 0
       OR (TG_OP = 'INSERT' AND (NEW."ownerConfirmedById" IS NOT NULL OR NEW."ownerConfirmedAt" IS NOT NULL
         OR NEW."projectConfirmedById" IS NOT NULL OR NEW."projectConfirmedAt" IS NOT NULL
         OR NEW."projectConfirmedProjectMembershipId" IS NOT NULL OR NEW."projectConfirmedMembershipCreatedAt" IS NOT NULL))
       OR (TG_OP = 'UPDATE' AND OLD."status" = 'draft'
         AND (NEW."ownerConfirmedById" IS NOT NULL OR NEW."ownerConfirmedAt" IS NOT NULL
           OR NEW."projectConfirmedById" IS NOT NULL OR NEW."projectConfirmedAt" IS NOT NULL
           OR NEW."projectConfirmedProjectMembershipId" IS NOT NULL OR NEW."projectConfirmedMembershipCreatedAt" IS NOT NULL))
       OR NEW."rejectedAt" < COALESCE(NEW."projectConfirmedAt", NEW."ownerConfirmedAt", NEW."proposedAt")
    THEN
      RAISE EXCEPTION 'PROJECT_AI_PROVIDER_DELEGATION_STATE_INVALID'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."status" = 'revoked' THEN
    IF NEW."revokedAt" IS NULL OR NEW."activatedAt" IS NULL
       OR NEW."ownerConfirmedById" IS DISTINCT FROM NEW."connectionOwnerId"
       OR NEW."ownerConfirmedAt" IS NULL
       OR NEW."projectConfirmedById" IS NULL OR NEW."projectConfirmedAt" IS NULL
       OR NEW."projectConfirmedProjectMembershipId" IS NULL OR NEW."projectConfirmedMembershipCreatedAt" IS NULL
       OR NEW."ownerConfirmedAt" > NEW."projectConfirmedAt"
       OR NEW."projectConfirmedAt" > NEW."activatedAt"
       OR NEW."revokedAt" < NEW."activatedAt"
       OR NEW."terminalActorKind" IS DISTINCT FROM 'user'
       OR NEW."terminalActorId" IS NULL OR NEW."terminalActorProjectMembershipId" IS NULL
       OR NEW."terminalActorMembershipCreatedAt" IS NULL OR NEW."terminalReason" IS NULL
       OR length(btrim(NEW."terminalReason")) = 0
       OR NEW."rejectedAt" IS NOT NULL OR NEW."expiredAt" IS NOT NULL
    THEN
      RAISE EXCEPTION 'PROJECT_AI_PROVIDER_DELEGATION_STATE_INVALID'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."status" = 'expired' THEN
    IF NEW."expiredAt" IS NULL
       OR NEW."expiredAt" < NEW."expiresAt"
       OR clock_timestamp() < NEW."expiresAt"
       OR NEW."terminalActorKind" IS DISTINCT FROM 'system_expiry'
       OR NEW."terminalActorId" IS NOT NULL OR NEW."terminalActorProjectMembershipId" IS NOT NULL
       OR NEW."terminalActorMembershipCreatedAt" IS NOT NULL
       OR NEW."terminalReason" IS DISTINCT FROM 'system_expiry'
       OR NEW."rejectedAt" IS NOT NULL OR NEW."revokedAt" IS NOT NULL
       OR (TG_OP = 'UPDATE' AND OLD."status" = 'draft'
         AND (NEW."ownerConfirmedById" IS NOT NULL OR NEW."ownerConfirmedAt" IS NOT NULL
           OR NEW."projectConfirmedById" IS NOT NULL OR NEW."projectConfirmedAt" IS NOT NULL
           OR NEW."projectConfirmedProjectMembershipId" IS NOT NULL
           OR NEW."projectConfirmedMembershipCreatedAt" IS NOT NULL
           OR NEW."activatedAt" IS NOT NULL))
       OR (TG_OP = 'UPDATE' AND OLD."status" = 'owner_confirmed'
         AND (NEW."ownerConfirmedById" IS DISTINCT FROM NEW."connectionOwnerId"
           OR NEW."ownerConfirmedAt" IS NULL
           OR NEW."projectConfirmedById" IS NOT NULL
           OR NEW."projectConfirmedAt" IS NOT NULL
           OR NEW."projectConfirmedProjectMembershipId" IS NOT NULL
           OR NEW."projectConfirmedMembershipCreatedAt" IS NOT NULL
           OR NEW."activatedAt" IS NOT NULL))
       OR (TG_OP = 'UPDATE' AND OLD."status" = 'active'
         AND (NEW."ownerConfirmedById" IS DISTINCT FROM NEW."connectionOwnerId"
           OR NEW."ownerConfirmedAt" IS NULL
           OR NEW."projectConfirmedById" IS NULL
           OR NEW."projectConfirmedAt" IS NULL
           OR NEW."projectConfirmedProjectMembershipId" IS NULL
           OR NEW."projectConfirmedMembershipCreatedAt" IS NULL
           OR NEW."activatedAt" IS NULL
           OR NEW."ownerConfirmedAt" > NEW."projectConfirmedAt"
           OR NEW."projectConfirmedAt" > NEW."activatedAt"))
    THEN
      RAISE EXCEPTION 'PROJECT_AI_PROVIDER_DELEGATION_STATE_INVALID'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."status" IN ('rejected', 'revoked') THEN
    SELECT EXISTS (
      SELECT 1
      FROM "AppUser" actor
      WHERE actor."id" = NEW."terminalActorId"
        AND actor."disabledAt" IS NULL
        AND (
          (
            actor."id" = NEW."connectionOwnerId"
            AND EXISTS (
              SELECT 1
              FROM "ProjectMembership" membership
              WHERE membership."id" = NEW."ownerProjectMembershipId"
                AND membership."projectId" = NEW."projectId"
                AND membership."userId" = NEW."connectionOwnerId"
                AND membership."role" IN ('owner', 'editor')
                AND membership."accessState" = 'confirmed'
                AND membership."createdAt" = NEW."ownerMembershipCreatedAt"
            )
            AND NEW."terminalActorProjectMembershipId" = NEW."ownerProjectMembershipId"
            AND NEW."terminalActorMembershipCreatedAt" = NEW."ownerMembershipCreatedAt"
          )
          OR EXISTS (
            SELECT 1
            FROM "ProjectMembership" membership
            WHERE membership."id" = NEW."terminalActorProjectMembershipId"
              AND membership."projectId" = NEW."projectId"
              AND membership."userId" = NEW."terminalActorId"
              AND membership."role" = 'owner'
              AND membership."accessState" = 'confirmed'
              AND membership."createdAt" = NEW."terminalActorMembershipCreatedAt"
          )
        )
    ) INTO terminal_actor_valid;
    IF NOT terminal_actor_valid THEN
      RAISE EXCEPTION 'PROJECT_AI_PROVIDER_DELEGATION_TERMINAL_ACTOR_INVALID'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "ProjectAiProviderDelegation_shape_guard"
BEFORE INSERT OR UPDATE ON "ProjectAiProviderDelegation"
FOR EACH ROW EXECUTE FUNCTION "project_ai_provider_delegation_shape_guard"();

CREATE OR REPLACE FUNCTION "project_ai_provider_delegation_delete_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- A delegation may disappear only as part of the owning project cascade.
  -- PostgreSQL FK cascade triggers execute at a deeper trigger depth than a
  -- direct application DELETE.
  IF pg_trigger_depth() <= 1 THEN
    RAISE EXCEPTION 'PROJECT_AI_PROVIDER_DELEGATION_DELETE_FORBIDDEN'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER "ProjectAiProviderDelegation_delete_guard"
BEFORE DELETE ON "ProjectAiProviderDelegation"
FOR EACH ROW EXECUTE FUNCTION "project_ai_provider_delegation_delete_guard"();

CREATE OR REPLACE FUNCTION "project_ai_provider_delegation_active_integrity_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  provider_valid boolean;
  owner_valid boolean;
  project_owner_valid boolean;
BEGIN
  IF NEW."status" NOT IN ('draft', 'owner_confirmed', 'active') THEN RETURN NEW; END IF;

  SELECT EXISTS (
    SELECT 1
    FROM "AiProviderConnection" provider
    JOIN "ExternalCredential" credential ON credential."id" = provider."credentialId"
    JOIN "Project" project_row ON project_row."id" = NEW."projectId"
    WHERE provider."id" = NEW."providerConnectionId"
      AND provider."scope" = 'user'
      AND provider."ownerUserId" = NEW."connectionOwnerId"
      AND provider."ownershipState" = 'confirmed'
      AND provider."status" = 'verified'
      AND provider."disabledAt" IS NULL
      AND provider."configurationVersion" = NEW."providerConfigurationVersion"
      AND provider."protocol" = 'chat_completions'
      AND provider."baseUrl" = CASE provider."kind"::text
        WHEN 'openai' THEN 'https://api.openai.com/v1'
        WHEN 'deepseek' THEN 'https://api.deepseek.com'
        WHEN 'qwen' THEN 'https://dashscope.aliyuncs.com/compatible-mode/v1'
        WHEN 'glm' THEN 'https://open.bigmodel.cn/api/paas/v4'
        ELSE NULL
      END
      AND project_row."archivedAt" IS NULL
      AND credential."kind" = 'ai_provider'
      AND credential."secretFingerprint" = NEW."credentialFingerprint"
      AND CASE NEW."operation"
        WHEN 'embedding' THEN provider."defaultEmbeddingModelId" = NEW."modelId"
          AND provider."embeddingDimensions" = NEW."embeddingDimensions"
          AND provider."kind" <> 'deepseek'
        WHEN 'visionExtract' THEN provider."defaultVisionModelId" = NEW."modelId"
        ELSE provider."defaultGenerationModelId" = NEW."modelId"
      END
  ) INTO provider_valid;
  IF NOT provider_valid THEN
    IF NEW."status" = 'active' THEN
      RAISE EXCEPTION 'PROJECT_AI_PROVIDER_DELEGATION_ACTIVE_PROVIDER_INVALID'
        USING ERRCODE = 'check_violation';
    END IF;
    RAISE EXCEPTION 'PROJECT_AI_PROVIDER_DELEGATION_LIVE_PROVIDER_INVALID'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM "AppUser" user_row
    JOIN "MembershipSubscription" subscription
      ON subscription."id" = NEW."connectionOwnerSubscriptionId"
     AND subscription."userId" = user_row."id"
    JOIN "ProjectMembership" membership ON membership."id" = NEW."ownerProjectMembershipId"
    WHERE user_row."id" = NEW."connectionOwnerId"
      AND user_row."disabledAt" IS NULL
      AND subscription."status" = 'active'
      AND subscription."version" = NEW."connectionOwnerSubscriptionVersion"
      AND subscription."startsAt" = NEW."connectionOwnerSubscriptionStartsAt"
      AND subscription."expiresAt" = NEW."connectionOwnerSubscriptionExpiresAt"
      AND subscription."startsAt" <= clock_timestamp()
      AND subscription."expiresAt" > clock_timestamp()
      AND membership."projectId" = NEW."projectId"
      AND membership."userId" = NEW."connectionOwnerId"
      AND membership."role" IN ('owner', 'editor')
      AND membership."accessState" = 'confirmed'
      AND membership."createdAt" = NEW."ownerMembershipCreatedAt"
  ) INTO owner_valid;
  IF NOT owner_valid THEN
    IF NEW."status" = 'active' THEN
      RAISE EXCEPTION 'PROJECT_AI_PROVIDER_DELEGATION_ACTIVE_OWNER_INVALID'
        USING ERRCODE = 'check_violation';
    END IF;
    RAISE EXCEPTION 'PROJECT_AI_PROVIDER_DELEGATION_LIVE_OWNER_INVALID'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."status" = 'active' THEN
    SELECT EXISTS (
      SELECT 1
      FROM "ProjectMembership" membership
      JOIN "AppUser" user_row ON user_row."id" = membership."userId"
      JOIN "Project" project_row ON project_row."id" = membership."projectId"
      WHERE membership."id" = NEW."projectConfirmedProjectMembershipId"
        AND membership."projectId" = NEW."projectId"
        AND membership."userId" = NEW."projectConfirmedById"
        AND membership."role" = 'owner'
        AND membership."accessState" = 'confirmed'
        AND membership."createdAt" = NEW."projectConfirmedMembershipCreatedAt"
        AND user_row."disabledAt" IS NULL
        AND project_row."archivedAt" IS NULL
    ) INTO project_owner_valid;
    IF NOT project_owner_valid THEN
      RAISE EXCEPTION 'PROJECT_AI_PROVIDER_DELEGATION_ACTIVE_PROJECT_OWNER_INVALID'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."expiresAt" <= clock_timestamp() THEN
    RAISE EXCEPTION 'PROJECT_AI_PROVIDER_DELEGATION_LIVE_EXPIRED'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "ProjectAiProviderDelegation_active_integrity_guard"
AFTER INSERT OR UPDATE ON "ProjectAiProviderDelegation"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "project_ai_provider_delegation_active_integrity_guard"();

CREATE OR REPLACE FUNCTION "project_ai_validate_delegation_evidence"(delegation_id UUID)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  delegation_row RECORD;
  previous_status "ProjectAiProviderDelegationStatus";
  expected_action "ProjectAiProviderDelegationAuditAction";
  expected_actor UUID;
  expected_actor_kind "ProjectAiProviderDelegationActorKind";
  expected_actor_membership UUID;
  expected_actor_membership_created_at TIMESTAMP(3);
  expected_transition_at TIMESTAMP(3);
  audit_count INTEGER;
  audit_matches BOOLEAN;
BEGIN
  SELECT * INTO delegation_row
  FROM "ProjectAiProviderDelegation"
  WHERE "id" = delegation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROJECT_AI_PROVIDER_DELEGATION_AUDIT_ENTITY_INVALID'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT count(*) INTO audit_count
  FROM "ProjectAiProviderDelegationAudit" audit
  WHERE audit."entity" = 'delegation'
    AND audit."delegationId" = delegation_row."id"
    AND audit."delegationVersion" = delegation_row."version";
  IF audit_count = 0 THEN
    RAISE EXCEPTION 'PROJECT_AI_PROVIDER_DELEGATION_AUDIT_REQUIRED'
      USING ERRCODE = 'check_violation';
  ELSIF audit_count <> 1 THEN
    RAISE EXCEPTION 'PROJECT_AI_PROVIDER_DELEGATION_AUDIT_INVALID'
      USING ERRCODE = 'check_violation';
  END IF;

  IF delegation_row."version" = 1 THEN
    previous_status := NULL;
    expected_action := 'proposed'::"ProjectAiProviderDelegationAuditAction";
  ELSE
    SELECT audit."statusAfter" INTO previous_status
    FROM "ProjectAiProviderDelegationAudit" audit
    WHERE audit."entity" = 'delegation'
      AND audit."delegationId" = delegation_row."id"
      AND audit."delegationVersion" = delegation_row."version" - 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'PROJECT_AI_PROVIDER_DELEGATION_AUDIT_INVALID'
        USING ERRCODE = 'check_violation';
    END IF;
    expected_action := CASE delegation_row."status"
      WHEN 'owner_confirmed' THEN 'owner_confirmed'::"ProjectAiProviderDelegationAuditAction"
      WHEN 'active' THEN 'activated'::"ProjectAiProviderDelegationAuditAction"
      WHEN 'rejected' THEN 'rejected'::"ProjectAiProviderDelegationAuditAction"
      WHEN 'revoked' THEN 'revoked'::"ProjectAiProviderDelegationAuditAction"
      WHEN 'expired' THEN 'expired'::"ProjectAiProviderDelegationAuditAction"
      ELSE NULL
    END;
  END IF;

  expected_actor := CASE expected_action
    WHEN 'proposed' THEN delegation_row."proposedById"
    WHEN 'owner_confirmed' THEN delegation_row."connectionOwnerId"
    WHEN 'activated' THEN delegation_row."projectConfirmedById"
    ELSE delegation_row."terminalActorId"
  END;
  expected_actor_kind := CASE expected_action
    WHEN 'expired' THEN 'system_expiry'::"ProjectAiProviderDelegationActorKind"
    ELSE 'user'::"ProjectAiProviderDelegationActorKind"
  END;
  expected_actor_membership := CASE expected_action
    WHEN 'proposed' THEN delegation_row."ownerProjectMembershipId"
    WHEN 'owner_confirmed' THEN delegation_row."ownerProjectMembershipId"
    WHEN 'activated' THEN delegation_row."projectConfirmedProjectMembershipId"
    ELSE delegation_row."terminalActorProjectMembershipId"
  END;
  expected_actor_membership_created_at := CASE expected_action
    WHEN 'proposed' THEN delegation_row."ownerMembershipCreatedAt"
    WHEN 'owner_confirmed' THEN delegation_row."ownerMembershipCreatedAt"
    WHEN 'activated' THEN delegation_row."projectConfirmedMembershipCreatedAt"
    ELSE delegation_row."terminalActorMembershipCreatedAt"
  END;
  expected_transition_at := CASE expected_action
    WHEN 'proposed' THEN delegation_row."proposedAt"
    WHEN 'owner_confirmed' THEN delegation_row."ownerConfirmedAt"
    WHEN 'activated' THEN delegation_row."activatedAt"
    WHEN 'rejected' THEN delegation_row."rejectedAt"
    WHEN 'revoked' THEN delegation_row."revokedAt"
    WHEN 'expired' THEN delegation_row."expiredAt"
  END;

  SELECT EXISTS (
    SELECT 1
    FROM "ProjectAiProviderDelegationAudit" audit
    WHERE audit."entity" = 'delegation'
      AND audit."action" = expected_action
      AND audit."transactionId" = txid_current()
      AND audit."delegationId" = delegation_row."id"
      AND audit."projectId" = delegation_row."projectId"
      AND audit."operation" = delegation_row."operation"
      AND audit."delegationVersion" = delegation_row."version"
      AND audit."statusBefore" IS NOT DISTINCT FROM previous_status
      AND audit."statusAfter" = delegation_row."status"
      AND audit."selectionId" IS NULL
      AND audit."selectionVersion" IS NULL
      AND audit."selectionSource" IS NULL
      AND audit."selectedDelegationId" IS NULL
      AND audit."selectedByProjectMembershipId" IS NULL
      AND audit."selectedByMembershipCreatedAt" IS NULL
      AND audit."providerConnectionId" = delegation_row."providerConnectionId"
      AND audit."connectionOwnerId" = delegation_row."connectionOwnerId"
      AND audit."ownerProjectMembershipId" = delegation_row."ownerProjectMembershipId"
      AND audit."projectConfirmedProjectMembershipId" IS NOT DISTINCT FROM delegation_row."projectConfirmedProjectMembershipId"
      AND audit."projectConfirmedMembershipCreatedAt" IS NOT DISTINCT FROM delegation_row."projectConfirmedMembershipCreatedAt"
      AND audit."connectionOwnerSubscriptionId" = delegation_row."connectionOwnerSubscriptionId"
      AND audit."connectionOwnerSubscriptionVersion" = delegation_row."connectionOwnerSubscriptionVersion"
      AND audit."connectionOwnerSubscriptionStartsAt" = delegation_row."connectionOwnerSubscriptionStartsAt"
      AND audit."connectionOwnerSubscriptionExpiresAt" = delegation_row."connectionOwnerSubscriptionExpiresAt"
      AND audit."modelId" = delegation_row."modelId"
      AND audit."embeddingDimensions" IS NOT DISTINCT FROM delegation_row."embeddingDimensions"
      AND audit."maxOutputTokens" IS NOT DISTINCT FROM delegation_row."maxOutputTokens"
      AND audit."providerConfigurationVersion" = delegation_row."providerConfigurationVersion"
      AND audit."credentialFingerprint" = delegation_row."credentialFingerprint"
      AND audit."delegationFingerprint" = delegation_row."delegationFingerprint"
      AND audit."terminalActorKind" IS NOT DISTINCT FROM delegation_row."terminalActorKind"
      AND audit."terminalActorId" IS NOT DISTINCT FROM delegation_row."terminalActorId"
      AND audit."terminalActorProjectMembershipId" IS NOT DISTINCT FROM delegation_row."terminalActorProjectMembershipId"
      AND audit."terminalActorMembershipCreatedAt" IS NOT DISTINCT FROM delegation_row."terminalActorMembershipCreatedAt"
      AND audit."terminalReason" IS NOT DISTINCT FROM delegation_row."terminalReason"
      AND audit."actorKind" = expected_actor_kind
      AND audit."actorId" IS NOT DISTINCT FROM expected_actor
      AND audit."actorProjectMembershipId" IS NOT DISTINCT FROM expected_actor_membership
      AND audit."actorMembershipCreatedAt" IS NOT DISTINCT FROM expected_actor_membership_created_at
      AND length(btrim(audit."reason")) > 0
      AND (delegation_row."status" NOT IN ('rejected', 'revoked', 'expired')
        OR audit."reason" = delegation_row."terminalReason")
      AND audit."transitionAt" = expected_transition_at
  ) INTO audit_matches;
  IF NOT audit_matches THEN
    RAISE EXCEPTION 'PROJECT_AI_PROVIDER_DELEGATION_AUDIT_INVALID'
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION "project_ai_provider_delegation_transition_audit_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM "project_ai_validate_delegation_evidence"(NEW."id");
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "ProjectAiProviderDelegation_transition_audit_guard"
AFTER INSERT OR UPDATE ON "ProjectAiProviderDelegation"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "project_ai_provider_delegation_transition_audit_guard"();

CREATE OR REPLACE FUNCTION "project_ai_effective_route_selection_shape_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Selection event timestamps are database-owned.  Take one clock sample
    -- so the immutable creation event has a single exact timestamp.
    NEW."createdAt" := clock_timestamp();
    NEW."updatedAt" := NEW."createdAt";
    IF NEW."version" <> 1 THEN
      RAISE EXCEPTION 'PROJECT_AI_EFFECTIVE_ROUTE_SELECTION_VERSION_INVALID'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    NEW."updatedAt" := clock_timestamp();
    IF OLD."id" IS DISTINCT FROM NEW."id"
       OR OLD."createdAt" IS DISTINCT FROM NEW."createdAt"
       OR OLD."projectId" IS DISTINCT FROM NEW."projectId"
       OR OLD."operation" IS DISTINCT FROM NEW."operation"
       OR NEW."version" <> OLD."version" + 1
    THEN
      RAISE EXCEPTION 'PROJECT_AI_EFFECTIVE_ROUTE_SELECTION_IMMUTABLE'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ProjectAiEffectiveRouteSelection_shape_guard"
BEFORE INSERT OR UPDATE ON "ProjectAiEffectiveRouteSelection"
FOR EACH ROW EXECUTE FUNCTION "project_ai_effective_route_selection_shape_guard"();

CREATE OR REPLACE FUNCTION "project_ai_effective_route_selection_delete_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- A selection is changed by an explicit control-plane action, not by a
  -- direct DELETE.  FK cascades from the owning project run at deeper trigger
  -- depth and remain the only physical deletion path.
  IF pg_trigger_depth() <= 1 THEN
    RAISE EXCEPTION 'PROJECT_AI_EFFECTIVE_ROUTE_SELECTION_DELETE_FORBIDDEN'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER "ProjectAiEffectiveRouteSelection_delete_guard"
BEFORE DELETE ON "ProjectAiEffectiveRouteSelection"
FOR EACH ROW EXECUTE FUNCTION "project_ai_effective_route_selection_delete_guard"();

CREATE OR REPLACE FUNCTION "project_ai_effective_route_selection_integrity_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  owner_valid boolean;
  delegation_valid boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM "ProjectMembership" membership
    JOIN "AppUser" user_row ON user_row."id" = membership."userId"
    WHERE membership."projectId" = NEW."projectId"
      AND membership."id" = NEW."selectedByProjectMembershipId"
      AND membership."userId" = NEW."selectedById"
      AND membership."role" = 'owner'
      AND membership."accessState" = 'confirmed'
      AND membership."createdAt" = NEW."selectedByMembershipCreatedAt"
      AND user_row."disabledAt" IS NULL
      AND EXISTS (
        SELECT 1
        FROM "Project" project_row
        WHERE project_row."id" = membership."projectId"
          AND project_row."archivedAt" IS NULL
      )
  ) INTO owner_valid;
  IF NOT owner_valid THEN
    RAISE EXCEPTION 'PROJECT_AI_EFFECTIVE_ROUTE_SELECTION_OWNER_INVALID'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."source" = 'personal_delegation' THEN
    SELECT EXISTS (
      SELECT 1
      FROM "ProjectAiProviderDelegation" delegation
      JOIN "AiProviderConnection" provider ON provider."id" = delegation."providerConnectionId"
      JOIN "ExternalCredential" credential ON credential."id" = provider."credentialId"
      JOIN "AppUser" owner_user ON owner_user."id" = delegation."connectionOwnerId"
      JOIN "MembershipSubscription" subscription
        ON subscription."id" = delegation."connectionOwnerSubscriptionId"
       AND subscription."userId" = delegation."connectionOwnerId"
      JOIN "ProjectMembership" owner_membership ON owner_membership."id" = delegation."ownerProjectMembershipId"
      JOIN "ProjectMembership" project_owner_membership
        ON project_owner_membership."id" = delegation."projectConfirmedProjectMembershipId"
      JOIN "AppUser" project_owner ON project_owner."id" = project_owner_membership."userId"
      JOIN "Project" project_row ON project_row."id" = delegation."projectId"
      WHERE delegation."id" = NEW."delegationId"
        AND delegation."projectId" = NEW."projectId"
        AND delegation."operation" = NEW."operation"
        AND delegation."status" = 'active'
        AND delegation."expiresAt" > clock_timestamp()
        AND project_row."archivedAt" IS NULL
        AND provider."scope" = 'user'
        AND provider."ownerUserId" = delegation."connectionOwnerId"
        AND provider."ownershipState" = 'confirmed'
        AND provider."status" = 'verified'
        AND provider."disabledAt" IS NULL
        AND provider."configurationVersion" = delegation."providerConfigurationVersion"
        AND provider."protocol" = 'chat_completions'
        AND provider."baseUrl" = CASE provider."kind"::text
          WHEN 'openai' THEN 'https://api.openai.com/v1'
          WHEN 'deepseek' THEN 'https://api.deepseek.com'
          WHEN 'qwen' THEN 'https://dashscope.aliyuncs.com/compatible-mode/v1'
          WHEN 'glm' THEN 'https://open.bigmodel.cn/api/paas/v4'
          ELSE NULL
        END
        AND credential."kind" = 'ai_provider'
        AND credential."secretFingerprint" = delegation."credentialFingerprint"
        AND CASE delegation."operation"
          WHEN 'embedding' THEN provider."defaultEmbeddingModelId" = delegation."modelId"
            AND provider."embeddingDimensions" = delegation."embeddingDimensions"
            AND provider."kind" <> 'deepseek'
          WHEN 'visionExtract' THEN provider."defaultVisionModelId" = delegation."modelId"
          ELSE provider."defaultGenerationModelId" = delegation."modelId"
        END
        AND owner_user."disabledAt" IS NULL
        AND subscription."status" = 'active'
        AND subscription."startsAt" <= clock_timestamp()
        AND subscription."expiresAt" > clock_timestamp()
        AND owner_membership."projectId" = delegation."projectId"
        AND owner_membership."userId" = delegation."connectionOwnerId"
        AND owner_membership."role" IN ('owner', 'editor')
        AND owner_membership."accessState" = 'confirmed'
        AND owner_membership."createdAt" = delegation."ownerMembershipCreatedAt"
        AND subscription."version" = delegation."connectionOwnerSubscriptionVersion"
        AND subscription."startsAt" = delegation."connectionOwnerSubscriptionStartsAt"
        AND subscription."expiresAt" = delegation."connectionOwnerSubscriptionExpiresAt"
        AND project_owner_membership."role" = 'owner'
        AND project_owner_membership."accessState" = 'confirmed'
        AND project_owner_membership."userId" = delegation."projectConfirmedById"
        AND project_owner_membership."createdAt" = delegation."projectConfirmedMembershipCreatedAt"
        AND project_owner."disabledAt" IS NULL
    ) INTO delegation_valid;
    IF NOT delegation_valid THEN
      RAISE EXCEPTION 'PROJECT_AI_EFFECTIVE_ROUTE_SELECTION_DELEGATION_INVALID'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "ProjectAiEffectiveRouteSelection_integrity_guard"
AFTER INSERT OR UPDATE ON "ProjectAiEffectiveRouteSelection"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "project_ai_effective_route_selection_integrity_guard"();

CREATE OR REPLACE FUNCTION "project_ai_validate_selection_evidence"(selection_id UUID)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  selection_row RECORD;
  expected_action "ProjectAiProviderDelegationAuditAction";
  audit_count INTEGER;
  audit_matches BOOLEAN;
BEGIN
  SELECT * INTO selection_row
  FROM "ProjectAiEffectiveRouteSelection"
  WHERE "id" = selection_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROJECT_AI_EFFECTIVE_ROUTE_SELECTION_AUDIT_ENTITY_INVALID'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT count(*) INTO audit_count
  FROM "ProjectAiProviderDelegationAudit" audit
  WHERE audit."entity" = 'selection'
    AND audit."selectionId" = selection_row."id"
    AND audit."selectionVersion" = selection_row."version";
  IF audit_count = 0 THEN
    RAISE EXCEPTION 'PROJECT_AI_EFFECTIVE_ROUTE_SELECTION_AUDIT_REQUIRED'
      USING ERRCODE = 'check_violation';
  ELSIF audit_count <> 1 THEN
    RAISE EXCEPTION 'PROJECT_AI_EFFECTIVE_ROUTE_SELECTION_AUDIT_INVALID'
      USING ERRCODE = 'check_violation';
  END IF;

  IF selection_row."version" = 1 THEN
    expected_action := CASE selection_row."source"
      WHEN 'platform_default' THEN 'platform_selected'::"ProjectAiProviderDelegationAuditAction"
      ELSE 'personal_selected'::"ProjectAiProviderDelegationAuditAction"
    END;
  ELSE
    expected_action := 'selection_updated'::"ProjectAiProviderDelegationAuditAction";
    IF NOT EXISTS (
      SELECT 1
      FROM "ProjectAiProviderDelegationAudit" audit
      WHERE audit."entity" = 'selection'
        AND audit."selectionId" = selection_row."id"
        AND audit."selectionVersion" = selection_row."version" - 1
    ) THEN
      RAISE EXCEPTION 'PROJECT_AI_EFFECTIVE_ROUTE_SELECTION_AUDIT_INVALID'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM "ProjectAiProviderDelegationAudit" audit
    WHERE audit."entity" = 'selection'
      AND audit."action" = expected_action
      AND audit."transactionId" = txid_current()
      AND audit."selectionId" = selection_row."id"
      AND audit."projectId" = selection_row."projectId"
      AND audit."operation" = selection_row."operation"
      AND audit."selectionVersion" = selection_row."version"
      AND audit."selectionSource" = selection_row."source"
      AND audit."selectedDelegationId" IS NOT DISTINCT FROM selection_row."delegationId"
      AND audit."selectedByProjectMembershipId" = selection_row."selectedByProjectMembershipId"
      AND audit."selectedByMembershipCreatedAt" = selection_row."selectedByMembershipCreatedAt"
      AND audit."providerConnectionId" IS NULL
      AND audit."connectionOwnerId" IS NULL
      AND audit."ownerProjectMembershipId" IS NULL
      AND audit."projectConfirmedProjectMembershipId" IS NULL
      AND audit."projectConfirmedMembershipCreatedAt" IS NULL
      AND audit."connectionOwnerSubscriptionId" IS NULL
      AND audit."connectionOwnerSubscriptionVersion" IS NULL
      AND audit."connectionOwnerSubscriptionStartsAt" IS NULL
      AND audit."connectionOwnerSubscriptionExpiresAt" IS NULL
      AND audit."modelId" IS NULL
      AND audit."embeddingDimensions" IS NULL
      AND audit."maxOutputTokens" IS NULL
      AND audit."providerConfigurationVersion" IS NULL
      AND audit."credentialFingerprint" IS NULL
      AND audit."delegationFingerprint" IS NULL
      AND audit."terminalActorKind" IS NULL
      AND audit."terminalActorId" IS NULL
      AND audit."terminalActorProjectMembershipId" IS NULL
      AND audit."terminalActorMembershipCreatedAt" IS NULL
      AND audit."terminalReason" IS NULL
      AND audit."actorKind" = 'user'
      AND audit."actorId" = selection_row."selectedById"
      AND audit."actorProjectMembershipId" = selection_row."selectedByProjectMembershipId"
      AND audit."actorMembershipCreatedAt" = selection_row."selectedByMembershipCreatedAt"
      AND length(btrim(audit."reason")) > 0
      AND audit."transitionAt" = CASE
        WHEN selection_row."version" = 1 THEN selection_row."createdAt"
        ELSE selection_row."updatedAt"
      END
  ) INTO audit_matches;
  IF NOT audit_matches THEN
    RAISE EXCEPTION 'PROJECT_AI_EFFECTIVE_ROUTE_SELECTION_AUDIT_INVALID'
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION "project_ai_effective_route_selection_audit_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM "project_ai_validate_selection_evidence"(NEW."id");
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "ProjectAiEffectiveRouteSelection_audit_guard"
AFTER INSERT OR UPDATE ON "ProjectAiEffectiveRouteSelection"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "project_ai_effective_route_selection_audit_guard"();

CREATE OR REPLACE FUNCTION "project_ai_provider_delegation_audit_insert_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  entity_transition_at TIMESTAMP(3);
  expected_actor_kind "ProjectAiProviderDelegationActorKind";
BEGIN
  -- Evidence timestamps and transaction identity are database facts, not
  -- caller input.  This also prevents a replay from carrying a forged time
  -- or transaction id into the append-only evidence stream.
  NEW."createdAt" := clock_timestamp();
  NEW."transactionId" := txid_current();
  IF length(btrim(NEW."reason")) = 0 THEN
    RAISE EXCEPTION 'PROJECT_AI_PROVIDER_DELEGATION_AUDIT_INVALID'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."entity" = 'delegation' THEN
    SELECT CASE NEW."action"
      WHEN 'proposed' THEN delegation."proposedAt"
      WHEN 'owner_confirmed' THEN delegation."ownerConfirmedAt"
      WHEN 'activated' THEN delegation."activatedAt"
      WHEN 'rejected' THEN delegation."rejectedAt"
      WHEN 'revoked' THEN delegation."revokedAt"
      WHEN 'expired' THEN delegation."expiredAt"
    END
    INTO entity_transition_at
    FROM "ProjectAiProviderDelegation" delegation
    WHERE delegation."id" = NEW."delegationId";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'PROJECT_AI_PROVIDER_DELEGATION_AUDIT_ENTITY_INVALID'
        USING ERRCODE = 'check_violation';
    END IF;
    expected_actor_kind := CASE NEW."action"
      WHEN 'expired' THEN 'system_expiry'::"ProjectAiProviderDelegationActorKind"
      ELSE 'user'::"ProjectAiProviderDelegationActorKind"
    END;
  ELSE
    SELECT CASE WHEN selection."version" = 1 THEN selection."createdAt" ELSE selection."updatedAt" END
    INTO entity_transition_at
    FROM "ProjectAiEffectiveRouteSelection" selection
    WHERE selection."id" = NEW."selectionId";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'PROJECT_AI_EFFECTIVE_ROUTE_SELECTION_AUDIT_ENTITY_INVALID'
        USING ERRCODE = 'check_violation';
    END IF;
    expected_actor_kind := 'user'::"ProjectAiProviderDelegationActorKind";
  END IF;
  IF NEW."actorKind" IS DISTINCT FROM expected_actor_kind
     OR NEW."transitionAt" IS DISTINCT FROM entity_transition_at
  THEN
    RAISE EXCEPTION 'PROJECT_AI_PROVIDER_DELEGATION_AUDIT_INVALID'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ProjectAiProviderDelegationAudit_transaction_guard"
BEFORE INSERT ON "ProjectAiProviderDelegationAudit"
FOR EACH ROW EXECUTE FUNCTION "project_ai_provider_delegation_audit_insert_guard"();

CREATE OR REPLACE FUNCTION "project_ai_provider_delegation_audit_entity_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."entity" = 'delegation' THEN
    PERFORM "project_ai_validate_delegation_evidence"(NEW."delegationId");
  ELSE
    PERFORM "project_ai_validate_selection_evidence"(NEW."selectionId");
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "PAD_A_entity_guard"
AFTER INSERT ON "ProjectAiProviderDelegationAudit"
FOR EACH ROW EXECUTE FUNCTION "project_ai_provider_delegation_audit_entity_guard"();

CREATE OR REPLACE FUNCTION "project_ai_provider_delegation_audit_immutable_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'PROJECT_AI_PROVIDER_DELEGATION_AUDIT_IMMUTABLE'
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER "ProjectAiProviderDelegationAudit_immutable_guard"
BEFORE UPDATE OR DELETE ON "ProjectAiProviderDelegationAudit"
FOR EACH ROW EXECUTE FUNCTION "project_ai_provider_delegation_audit_immutable_guard"();

-- Any live delegation/selection that points at an identity or authorization
-- epoch being changed must be explicitly closed in the same transaction.  The
-- helper is deliberately conservative: callers rotate/disable an upstream
-- object in one transaction only after terminalizing all its live delegates
-- and explicitly selecting another route.  It never silently repairs or
-- falls back a selection.
CREATE OR REPLACE FUNCTION "project_ai_require_dependent_invalidation"(
  provider_id UUID DEFAULT NULL,
  credential_id UUID DEFAULT NULL,
  subscription_user_id UUID DEFAULT NULL,
  membership_id UUID DEFAULT NULL,
  user_id UUID DEFAULT NULL,
  project_id UUID DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  stale_found BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM "ProjectAiProviderDelegation" delegation
    LEFT JOIN "AiProviderConnection" provider ON provider."id" = delegation."providerConnectionId"
    WHERE delegation."status" IN ('draft', 'owner_confirmed', 'active')
      AND (
        (provider_id IS NOT NULL AND delegation."providerConnectionId" = provider_id)
        OR (credential_id IS NOT NULL AND provider."credentialId" = credential_id)
        OR (subscription_user_id IS NOT NULL AND delegation."connectionOwnerId" = subscription_user_id)
        OR (membership_id IS NOT NULL AND (
          delegation."ownerProjectMembershipId" = membership_id
          OR delegation."projectConfirmedProjectMembershipId" = membership_id
        ))
        OR (user_id IS NOT NULL AND (
          delegation."connectionOwnerId" = user_id
          OR delegation."projectConfirmedById" = user_id
        ))
        OR (project_id IS NOT NULL AND delegation."projectId" = project_id)
      )
  ) INTO stale_found;
  IF stale_found THEN
    RAISE EXCEPTION 'PROJECT_AI_PROVIDER_DELEGATION_UPSTREAM_INVALIDATION_REQUIRED'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM "ProjectAiEffectiveRouteSelection" selection
    LEFT JOIN "ProjectAiProviderDelegation" delegation ON delegation."id" = selection."delegationId"
    WHERE (
        (provider_id IS NOT NULL AND delegation."providerConnectionId" = provider_id)
        OR (credential_id IS NOT NULL AND delegation."providerConnectionId" IN (
          SELECT provider."id"
          FROM "AiProviderConnection" provider
          WHERE provider."credentialId" = credential_id
        ))
        OR (membership_id IS NOT NULL AND selection."selectedByProjectMembershipId" = membership_id)
        OR (user_id IS NOT NULL AND selection."selectedById" = user_id)
        OR (project_id IS NOT NULL AND selection."source" = 'personal_delegation'
          AND selection."projectId" = project_id)
      )
  ) INTO stale_found;
  IF stale_found THEN
    RAISE EXCEPTION 'PROJECT_AI_PROVIDER_DELEGATION_UPSTREAM_INVALIDATION_REQUIRED'
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION "project_ai_provider_connection_dependent_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD."kind" IS DISTINCT FROM NEW."kind"
       OR OLD."scope" IS DISTINCT FROM NEW."scope"
       OR OLD."ownerUserId" IS DISTINCT FROM NEW."ownerUserId"
       OR OLD."ownershipState" IS DISTINCT FROM NEW."ownershipState"
       OR OLD."protocol" IS DISTINCT FROM NEW."protocol"
       OR OLD."baseUrl" IS DISTINCT FROM NEW."baseUrl"
       OR OLD."credentialId" IS DISTINCT FROM NEW."credentialId"
       OR OLD."defaultGenerationModelId" IS DISTINCT FROM NEW."defaultGenerationModelId"
       OR OLD."defaultEmbeddingModelId" IS DISTINCT FROM NEW."defaultEmbeddingModelId"
       OR OLD."defaultVisionModelId" IS DISTINCT FROM NEW."defaultVisionModelId"
       OR OLD."embeddingDimensions" IS DISTINCT FROM NEW."embeddingDimensions"
       OR OLD."configurationVersion" IS DISTINCT FROM NEW."configurationVersion"
       OR OLD."status" IS DISTINCT FROM NEW."status"
       OR OLD."disabledAt" IS DISTINCT FROM NEW."disabledAt"
    THEN
      PERFORM "project_ai_require_dependent_invalidation"(provider_id => OLD."id");
    END IF;
  ELSE
    PERFORM "project_ai_require_dependent_invalidation"(provider_id => OLD."id");
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "project_ai_credential_dependent_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD."kind" IS DISTINCT FROM NEW."kind"
     OR OLD."secretFingerprint" IS DISTINCT FROM NEW."secretFingerprint"
  THEN
    PERFORM "project_ai_require_dependent_invalidation"(credential_id => OLD."id");
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "project_ai_subscription_dependent_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE'
     OR OLD."status" IS DISTINCT FROM NEW."status"
     OR OLD."version" IS DISTINCT FROM NEW."version"
     OR OLD."startsAt" IS DISTINCT FROM NEW."startsAt"
     OR OLD."expiresAt" IS DISTINCT FROM NEW."expiresAt"
     OR OLD."revokedAt" IS DISTINCT FROM NEW."revokedAt"
     OR OLD."revokedById" IS DISTINCT FROM NEW."revokedById"
     OR OLD."revocationReason" IS DISTINCT FROM NEW."revocationReason"
  THEN
    PERFORM "project_ai_require_dependent_invalidation"(subscription_user_id => OLD."userId");
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "project_ai_membership_dependent_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE'
     OR OLD."projectId" IS DISTINCT FROM NEW."projectId"
     OR OLD."userId" IS DISTINCT FROM NEW."userId"
     OR OLD."role" IS DISTINCT FROM NEW."role"
     OR OLD."accessState" IS DISTINCT FROM NEW."accessState"
     OR OLD."createdAt" IS DISTINCT FROM NEW."createdAt"
  THEN
    PERFORM "project_ai_require_dependent_invalidation"(membership_id => OLD."id");
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "project_ai_user_dependent_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD."disabledAt" IS DISTINCT FROM NEW."disabledAt" THEN
    PERFORM "project_ai_require_dependent_invalidation"(user_id => OLD."id");
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "project_ai_project_dependent_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."archivedAt" IS DISTINCT FROM NEW."archivedAt" THEN
    PERFORM "project_ai_require_dependent_invalidation"(project_id => OLD."id");
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "project_ai_delegation_selection_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."status" <> 'active'
     AND EXISTS (
       SELECT 1
       FROM "ProjectAiEffectiveRouteSelection" selection
       WHERE selection."source" = 'personal_delegation'
         AND selection."delegationId" = NEW."id"
     )
  THEN
    RAISE EXCEPTION 'PROJECT_AI_PROVIDER_DELEGATION_SELECTION_INVALIDATION_REQUIRED'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- Every related write enters the same serialization domain as delegation and
-- selection writes.  The deferred guards then inspect the final rows after
-- the caller has completed the explicit terminalization/switch.
CREATE TRIGGER "PAD_provider_global_lock"
BEFORE INSERT OR UPDATE OR DELETE ON "AiProviderConnection"
FOR EACH STATEMENT EXECUTE FUNCTION "project_ai_provider_delegation_global_lock"();
CREATE TRIGGER "PAD_credential_global_lock"
BEFORE INSERT OR UPDATE OR DELETE ON "ExternalCredential"
FOR EACH STATEMENT EXECUTE FUNCTION "project_ai_provider_delegation_global_lock"();
CREATE TRIGGER "PAD_subscription_global_lock"
BEFORE INSERT OR UPDATE OR DELETE ON "MembershipSubscription"
FOR EACH STATEMENT EXECUTE FUNCTION "project_ai_provider_delegation_global_lock"();
CREATE TRIGGER "PAD_membership_global_lock"
BEFORE INSERT OR UPDATE OR DELETE ON "ProjectMembership"
FOR EACH STATEMENT EXECUTE FUNCTION "project_ai_provider_delegation_global_lock"();
CREATE TRIGGER "PAD_user_global_lock"
BEFORE UPDATE OR DELETE ON "AppUser"
FOR EACH STATEMENT EXECUTE FUNCTION "project_ai_provider_delegation_global_lock"();
CREATE TRIGGER "PAD_project_global_lock"
BEFORE UPDATE OR DELETE ON "Project"
FOR EACH STATEMENT EXECUTE FUNCTION "project_ai_provider_delegation_global_lock"();

CREATE CONSTRAINT TRIGGER "PAD_provider_dependent_guard"
AFTER UPDATE OR DELETE ON "AiProviderConnection"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "project_ai_provider_connection_dependent_guard"();
CREATE CONSTRAINT TRIGGER "PAD_credential_dependent_guard"
AFTER UPDATE OR DELETE ON "ExternalCredential"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "project_ai_credential_dependent_guard"();
CREATE CONSTRAINT TRIGGER "PAD_subscription_dependent_guard"
AFTER UPDATE OR DELETE ON "MembershipSubscription"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "project_ai_subscription_dependent_guard"();
CREATE CONSTRAINT TRIGGER "PAD_membership_dependent_guard"
AFTER UPDATE OR DELETE ON "ProjectMembership"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "project_ai_membership_dependent_guard"();
CREATE CONSTRAINT TRIGGER "PAD_user_dependent_guard"
AFTER UPDATE OR DELETE ON "AppUser"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "project_ai_user_dependent_guard"();
CREATE CONSTRAINT TRIGGER "PAD_project_dependent_guard"
AFTER UPDATE ON "Project"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "project_ai_project_dependent_guard"();
CREATE CONSTRAINT TRIGGER "PAD_selection_dependent_guard"
AFTER UPDATE ON "ProjectAiProviderDelegation"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "project_ai_delegation_selection_guard"();
