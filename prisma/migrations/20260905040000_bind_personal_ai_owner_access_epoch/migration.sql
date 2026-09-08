-- Bind every personal AI runtime snapshot to the connection owner's account
-- access epoch.  Account disable/restore increments the epoch, so an old
-- provider chain remains durable evidence but can never be executed again.

ALTER TABLE "AiProviderConnection"
  ADD COLUMN "ownerAccountAccessVersion" INTEGER;

ALTER TABLE "ProjectAiProviderDelegation"
  ADD COLUMN "connectionOwnerAccountAccessVersion" INTEGER;

ALTER TABLE "ProjectAiEffectiveRouteSelection"
  ADD COLUMN "connectionOwnerAccountAccessVersion" INTEGER;

ALTER TABLE "ProjectAiProviderDelegationAudit"
  ADD COLUMN "connectionOwnerAccountAccessVersion" INTEGER;

ALTER TABLE "WebAiGrant"
  ADD COLUMN "connectionOwnerAccountAccessVersion" INTEGER;

ALTER TABLE "ProviderCallAudit"
  ADD COLUMN "connectionOwnerAccountAccessVersion" INTEGER;

ALTER TABLE "MemoryIndexGeneration"
  ADD COLUMN "expectedEmbeddingConnectionOwnerAccountAccessVersion" INTEGER;

ALTER TABLE "AiProviderConnection"
  ADD CONSTRAINT "AiProviderConnection_owner_account_access_version_check"
  CHECK ("ownerAccountAccessVersion" IS NULL OR "ownerAccountAccessVersion" > 0);

ALTER TABLE "ProjectAiProviderDelegation"
  ADD CONSTRAINT "ProjectAiProviderDelegation_connection_owner_account_access_version_check"
  CHECK ("connectionOwnerAccountAccessVersion" IS NULL OR "connectionOwnerAccountAccessVersion" > 0);

ALTER TABLE "ProjectAiEffectiveRouteSelection"
  ADD CONSTRAINT "ProjectAiEffectiveRouteSelection_connection_owner_account_access_version_check"
  CHECK ("connectionOwnerAccountAccessVersion" IS NULL OR "connectionOwnerAccountAccessVersion" > 0);

ALTER TABLE "ProjectAiProviderDelegationAudit"
  ADD CONSTRAINT "ProjectAiProviderDelegationAudit_connection_owner_account_access_version_check"
  CHECK ("connectionOwnerAccountAccessVersion" IS NULL OR "connectionOwnerAccountAccessVersion" > 0);

ALTER TABLE "WebAiGrant"
  ADD CONSTRAINT "WebAiGrant_connection_owner_account_access_version_check"
  CHECK ("connectionOwnerAccountAccessVersion" IS NULL OR "connectionOwnerAccountAccessVersion" > 0);

ALTER TABLE "ProviderCallAudit"
  ADD CONSTRAINT "ProviderCallAudit_connection_owner_account_access_version_check"
  CHECK ("connectionOwnerAccountAccessVersion" IS NULL OR "connectionOwnerAccountAccessVersion" > 0);

ALTER TABLE "MemoryIndexGeneration"
  ADD CONSTRAINT "MemoryIndexGeneration_expected_embedding_owner_account_access_version_check"
  CHECK ("expectedEmbeddingConnectionOwnerAccountAccessVersion" IS NULL OR "expectedEmbeddingConnectionOwnerAccountAccessVersion" > 0);

-- Build the nullable lookup indexes before the legacy-row backfill.  The
-- backfill updates tables with deferred constraint triggers; keeping DDL ahead
-- of those queued events avoids PostgreSQL's pending-trigger restriction while
-- retaining NULL for rows that cannot be proven executable.
CREATE INDEX "AiProviderConnection_ownerAccountAccessVersion_idx"
  ON "AiProviderConnection"("ownerUserId", "ownerAccountAccessVersion");
CREATE INDEX "ProjectAiProviderDelegation_connectionOwnerAccountAccessVersion_idx"
  ON "ProjectAiProviderDelegation"("connectionOwnerId", "connectionOwnerAccountAccessVersion");
CREATE INDEX "WebAiGrant_connectionOwnerAccountAccessVersion_idx"
  ON "WebAiGrant"("billingUserId", "connectionOwnerAccountAccessVersion");
CREATE INDEX "ProviderCallAudit_connectionOwnerAccountAccessVersion_idx"
  ON "ProviderCallAudit"("billingUserId", "connectionOwnerAccountAccessVersion");

-- Only currently executable rows receive a trustworthy baseline.  Disabled,
-- historical, or otherwise unverifiable rows intentionally remain nullable
-- and are rejected by the runtime predicates.
UPDATE "AiProviderConnection" provider
   SET "ownerAccountAccessVersion" = owner_user."accountAccessVersion"
  FROM "AppUser" owner_user
 WHERE provider."scope" = 'user'
   AND provider."ownerUserId" = owner_user."id"
   AND provider."status" <> 'disabled'
   AND provider."disabledAt" IS NULL
   AND owner_user."disabledAt" IS NULL;

-- Do not rewrite downstream history during the upgrade.  Delegation and
-- selection updates would violate their versioned transition evidence, while
-- delegation audits and runtime evidence are immutable.  Without a
-- migration-owned proof transaction, their epoch cannot be established
-- without forging history, so the new runtime guards intentionally keep these
-- pre-epoch rows NULL and fail closed.  A later explicit owner rebind creates a
-- fresh, fully-bound chain.

-- Flush any deferred legacy root checks before installing the new guards.  A
-- root epoch-only update does not change legacy provider identity, but making
-- the check explicit prevents a pending event from leaking past the migration
-- boundary.
SET CONSTRAINTS ALL IMMEDIATE;

CREATE OR REPLACE FUNCTION "personal_ai_owner_account_access_epoch_valid"(
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

CREATE OR REPLACE FUNCTION "personal_ai_provider_connection_epoch_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  rotation_context TEXT := current_setting('app.personal_ai_credential_rotation_context', true);
  rotation_owner TEXT := current_setting('app.personal_ai_credential_rotation_owner_id', true);
  rotation_provider TEXT := current_setting('app.personal_ai_credential_rotation_provider_id', true);
BEGIN
  IF NEW."scope" <> 'user' THEN
    IF NEW."ownerAccountAccessVersion" IS NOT NULL THEN
      RAISE EXCEPTION 'PERSONAL_AI_ACCOUNT_EPOCH_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."ownerUserId" IS NULL OR NEW."ownerAccountAccessVersion" IS NULL THEN
    RAISE EXCEPTION 'PERSONAL_AI_ACCOUNT_EPOCH_INVALID' USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'UPDATE' AND OLD."ownerAccountAccessVersion" IS DISTINCT FROM NEW."ownerAccountAccessVersion" THEN
    IF rotation_context IS DISTINCT FROM '1'
       OR rotation_owner IS DISTINCT FROM NEW."ownerUserId"::text
       OR rotation_provider IS DISTINCT FROM NEW."id"::text
       OR NOT "personal_ai_owner_account_access_epoch_valid"(NEW."ownerUserId", NEW."ownerAccountAccessVersion")
    THEN
      RAISE EXCEPTION 'PERSONAL_AI_ACCOUNT_EPOCH_REFRESH_FORBIDDEN' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF (TG_OP = 'INSERT' OR NEW."status" <> 'disabled' OR NEW."disabledAt" IS NULL)
     AND NOT "personal_ai_owner_account_access_epoch_valid"(NEW."ownerUserId", NEW."ownerAccountAccessVersion")
  THEN
    RAISE EXCEPTION 'PERSONAL_AI_ACCOUNT_EPOCH_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "AiProviderConnection_personal_epoch_guard" ON "AiProviderConnection";
CREATE TRIGGER "AiProviderConnection_personal_epoch_guard"
BEFORE INSERT OR UPDATE ON "AiProviderConnection"
FOR EACH ROW EXECUTE FUNCTION "personal_ai_provider_connection_epoch_guard"();

CREATE OR REPLACE FUNCTION "personal_ai_delegation_epoch_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  provider_epoch INTEGER;
  owner_epoch INTEGER;
  provider_owner UUID;
  owner_disabled TIMESTAMP(3);
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."connectionOwnerAccountAccessVersion" IS DISTINCT FROM NEW."connectionOwnerAccountAccessVersion" THEN
    RAISE EXCEPTION 'PERSONAL_AI_ACCOUNT_EPOCH_IMMUTABLE' USING ERRCODE = 'check_violation';
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
    RAISE EXCEPTION 'PERSONAL_AI_ACCOUNT_EPOCH_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  SELECT provider."ownerAccountAccessVersion", provider."ownerUserId"
    INTO provider_epoch, provider_owner
    FROM "AiProviderConnection" provider
   WHERE provider."id" = NEW."providerConnectionId"
     AND provider."scope" = 'user';
  SELECT owner_user."accountAccessVersion", owner_user."disabledAt"
    INTO owner_epoch, owner_disabled
    FROM "AppUser" owner_user
   WHERE owner_user."id" = NEW."connectionOwnerId";
  IF provider_owner IS DISTINCT FROM NEW."connectionOwnerId"
     OR provider_epoch IS DISTINCT FROM NEW."connectionOwnerAccountAccessVersion"
  THEN
    RAISE EXCEPTION 'PERSONAL_AI_ACCOUNT_EPOCH_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' OR NEW."status" IN ('draft', 'owner_confirmed', 'active') THEN
    IF owner_disabled IS NOT NULL OR owner_epoch IS DISTINCT FROM NEW."connectionOwnerAccountAccessVersion" THEN
      RAISE EXCEPTION 'PERSONAL_AI_ACCOUNT_EPOCH_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "ProjectAiProviderDelegation_personal_epoch_guard" ON "ProjectAiProviderDelegation";
CREATE CONSTRAINT TRIGGER "ProjectAiProviderDelegation_personal_epoch_guard"
AFTER INSERT OR UPDATE ON "ProjectAiProviderDelegation"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "personal_ai_delegation_epoch_guard"();

CREATE OR REPLACE FUNCTION "personal_ai_selection_epoch_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  delegation_epoch INTEGER;
  provider_epoch INTEGER;
  owner_epoch INTEGER;
  owner_disabled TIMESTAMP(3);
BEGIN
  IF NEW."source" IS DISTINCT FROM 'personal_delegation' THEN
    IF NEW."connectionOwnerAccountAccessVersion" IS NOT NULL THEN
      RAISE EXCEPTION 'PERSONAL_AI_ACCOUNT_EPOCH_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."delegationId" IS NULL OR NEW."connectionOwnerAccountAccessVersion" IS NULL THEN
    RAISE EXCEPTION 'PERSONAL_AI_ACCOUNT_EPOCH_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  SELECT delegation."connectionOwnerAccountAccessVersion", provider."ownerAccountAccessVersion", owner_user."accountAccessVersion", owner_user."disabledAt"
    INTO delegation_epoch, provider_epoch, owner_epoch, owner_disabled
    FROM "ProjectAiProviderDelegation" delegation
    JOIN "AiProviderConnection" provider ON provider."id" = delegation."providerConnectionId"
    JOIN "AppUser" owner_user ON owner_user."id" = delegation."connectionOwnerId"
   WHERE delegation."id" = NEW."delegationId"
     AND delegation."projectId" = NEW."projectId"
     AND delegation."operation" = NEW."operation"
     AND delegation."status" = 'active';
  IF delegation_epoch IS DISTINCT FROM NEW."connectionOwnerAccountAccessVersion"
     OR provider_epoch IS DISTINCT FROM NEW."connectionOwnerAccountAccessVersion"
     OR owner_epoch IS DISTINCT FROM NEW."connectionOwnerAccountAccessVersion"
     OR owner_disabled IS NOT NULL
  THEN
    RAISE EXCEPTION 'PERSONAL_AI_ACCOUNT_EPOCH_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "ProjectAiEffectiveRouteSelection_personal_epoch_guard" ON "ProjectAiEffectiveRouteSelection";
CREATE CONSTRAINT TRIGGER "ProjectAiEffectiveRouteSelection_personal_epoch_guard"
AFTER INSERT OR UPDATE ON "ProjectAiEffectiveRouteSelection"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "personal_ai_selection_epoch_guard"();

CREATE OR REPLACE FUNCTION "personal_ai_delegation_audit_epoch_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  delegation_id UUID := CASE WHEN NEW."entity" = 'delegation' THEN NEW."delegationId" ELSE NEW."selectedDelegationId" END;
  expected_epoch INTEGER;
  delegation_status "ProjectAiProviderDelegationStatus";
BEGIN
  IF delegation_id IS NULL THEN
    IF NEW."entity" = 'delegation' THEN
      RAISE EXCEPTION 'PERSONAL_AI_ACCOUNT_EPOCH_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."connectionOwnerAccountAccessVersion" IS NOT NULL THEN
      RAISE EXCEPTION 'PERSONAL_AI_ACCOUNT_EPOCH_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  SELECT delegation."connectionOwnerAccountAccessVersion"
    INTO expected_epoch
    FROM "ProjectAiProviderDelegation" delegation
   WHERE delegation."id" = delegation_id;
  IF expected_epoch IS NULL THEN
    SELECT delegation."status"
      INTO delegation_status
      FROM "ProjectAiProviderDelegation" delegation
     WHERE delegation."id" = delegation_id;
    IF NEW."entity" <> 'delegation'
       OR NEW."connectionOwnerAccountAccessVersion" IS NOT NULL
       OR NEW."statusAfter" IS DISTINCT FROM delegation_status
       OR NOT (
         (NEW."action" = 'rejected' AND NEW."statusBefore" IN ('draft', 'owner_confirmed') AND delegation_status = 'rejected')
         OR (NEW."action" = 'revoked' AND NEW."statusBefore" = 'active' AND delegation_status = 'revoked')
       ) THEN
      RAISE EXCEPTION 'PERSONAL_AI_ACCOUNT_EPOCH_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."connectionOwnerAccountAccessVersion" IS DISTINCT FROM expected_epoch THEN
    RAISE EXCEPTION 'PERSONAL_AI_ACCOUNT_EPOCH_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "ProjectAiProviderDelegationAudit_personal_epoch_guard" ON "ProjectAiProviderDelegationAudit";
CREATE CONSTRAINT TRIGGER "ProjectAiProviderDelegationAudit_personal_epoch_guard"
AFTER INSERT ON "ProjectAiProviderDelegationAudit"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "personal_ai_delegation_audit_epoch_guard"();

CREATE OR REPLACE FUNCTION "personal_ai_grant_epoch_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  expected_epoch INTEGER;
BEGIN
  IF NEW."routeSource" IS DISTINCT FROM 'personal_delegation' THEN
    IF NEW."connectionOwnerAccountAccessVersion" IS NOT NULL THEN
      RAISE EXCEPTION 'PERSONAL_AI_ACCOUNT_EPOCH_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  SELECT delegation."connectionOwnerAccountAccessVersion"
    INTO expected_epoch
    FROM "ProjectAiProviderDelegation" delegation
   WHERE delegation."id" = NEW."personalDelegationId"
     AND delegation."connectionOwnerId" = NEW."billingUserId";
  IF expected_epoch IS NULL OR NEW."connectionOwnerAccountAccessVersion" IS DISTINCT FROM expected_epoch THEN
    RAISE EXCEPTION 'PERSONAL_AI_ACCOUNT_EPOCH_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' AND NOT "personal_ai_owner_account_access_epoch_valid"(NEW."billingUserId", NEW."connectionOwnerAccountAccessVersion") THEN
    RAISE EXCEPTION 'PERSONAL_AI_ACCOUNT_EPOCH_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "WebAiGrant_personal_epoch_guard" ON "WebAiGrant";
CREATE CONSTRAINT TRIGGER "WebAiGrant_personal_epoch_guard"
AFTER INSERT OR UPDATE ON "WebAiGrant"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "personal_ai_grant_epoch_guard"();

CREATE OR REPLACE FUNCTION "personal_ai_provider_call_audit_epoch_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  expected_epoch INTEGER;
BEGIN
  IF NEW."routeSource" IS DISTINCT FROM 'personal_delegation' THEN
    IF NEW."connectionOwnerAccountAccessVersion" IS NOT NULL THEN
      RAISE EXCEPTION 'PERSONAL_AI_ACCOUNT_EPOCH_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND OLD."connectionOwnerAccountAccessVersion" IS NULL
     AND NEW."connectionOwnerAccountAccessVersion" IS NULL
     AND OLD."status" = 'running'
     AND NEW."status" IN ('succeeded', 'failed', 'unknown')
     AND NEW."completedAt" IS NOT NULL THEN
    RETURN NEW;
  END IF;
  SELECT delegation."connectionOwnerAccountAccessVersion"
    INTO expected_epoch
    FROM "ProjectAiProviderDelegation" delegation
   WHERE delegation."id" = NEW."personalDelegationId";
  IF expected_epoch IS NULL OR NEW."connectionOwnerAccountAccessVersion" IS DISTINCT FROM expected_epoch THEN
    RAISE EXCEPTION 'PERSONAL_AI_ACCOUNT_EPOCH_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' AND NOT "personal_ai_owner_account_access_epoch_valid"(NEW."billingUserId", NEW."connectionOwnerAccountAccessVersion") THEN
    RAISE EXCEPTION 'PERSONAL_AI_ACCOUNT_EPOCH_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "ProviderCallAudit_personal_epoch_guard" ON "ProviderCallAudit";
CREATE CONSTRAINT TRIGGER "ProviderCallAudit_personal_epoch_guard"
AFTER INSERT OR UPDATE ON "ProviderCallAudit"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "personal_ai_provider_call_audit_epoch_guard"();

CREATE OR REPLACE FUNCTION "personal_ai_memory_generation_epoch_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  expected_epoch INTEGER;
BEGIN
  IF NEW."expectedEmbeddingRouteSource" IS DISTINCT FROM 'personal_delegation' THEN
    IF NEW."expectedEmbeddingConnectionOwnerAccountAccessVersion" IS NOT NULL THEN
      RAISE EXCEPTION 'PERSONAL_AI_ACCOUNT_EPOCH_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."expectedEmbeddingConnectionOwnerAccountAccessVersion" IS DISTINCT FROM NEW."expectedEmbeddingConnectionOwnerAccountAccessVersion" THEN
    RAISE EXCEPTION 'PERSONAL_AI_ACCOUNT_EPOCH_IMMUTABLE' USING ERRCODE = 'check_violation';
  END IF;
  SELECT grant_row."connectionOwnerAccountAccessVersion"
    INTO expected_epoch
    FROM "WebAiGrant" grant_row
   WHERE grant_row."id" = NEW."embeddingWebAiGrantId";
  IF expected_epoch IS NULL OR NEW."expectedEmbeddingConnectionOwnerAccountAccessVersion" IS DISTINCT FROM expected_epoch THEN
    RAISE EXCEPTION 'PERSONAL_AI_ACCOUNT_EPOCH_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' AND NOT "personal_ai_owner_account_access_epoch_valid"(
    (SELECT "billingUserId" FROM "WebAiGrant" WHERE "id" = NEW."embeddingWebAiGrantId"),
    NEW."expectedEmbeddingConnectionOwnerAccountAccessVersion"
  ) THEN
    RAISE EXCEPTION 'PERSONAL_AI_ACCOUNT_EPOCH_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "MemoryIndexGeneration_personal_epoch_guard" ON "MemoryIndexGeneration";
CREATE CONSTRAINT TRIGGER "MemoryIndexGeneration_personal_epoch_guard"
AFTER INSERT OR UPDATE ON "MemoryIndexGeneration"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "personal_ai_memory_generation_epoch_guard"();

-- Keep the existing, broader evidence predicates and add the account epoch as
-- one more mandatory live condition. Renaming first preserves the predicates
-- already installed by the prior migrations without changing those files.
ALTER FUNCTION "personal_memory_frozen_evidence_valid"(UUID, BOOLEAN)
  RENAME TO "personal_memory_frozen_evidence_valid_without_epoch";

CREATE OR REPLACE FUNCTION "personal_ai_memory_generation_epoch_valid"(p_generation_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM "MemoryIndexGeneration" generation
      JOIN "WebAiGrant" grant_row ON grant_row."id" = generation."embeddingWebAiGrantId"
      JOIN "ProjectAiEffectiveRouteSelection" selection
        ON selection."id" = grant_row."effectiveRouteSelectionId"
       AND selection."projectId" = grant_row."projectId"
       AND selection."operation" = 'embedding'
      JOIN "ProjectAiProviderDelegation" delegation ON delegation."id" = grant_row."personalDelegationId"
      JOIN "AiProviderConnection" provider ON provider."id" = grant_row."providerConnectionId"
      JOIN "AppUser" owner_user ON owner_user."id" = grant_row."billingUserId"
     WHERE generation."id" = p_generation_id
       AND generation."expectedEmbeddingRouteSource" = 'personal_delegation'
       AND generation."expectedEmbeddingConnectionOwnerAccountAccessVersion" IS NOT NULL
       AND grant_row."connectionOwnerAccountAccessVersion" = generation."expectedEmbeddingConnectionOwnerAccountAccessVersion"
       AND selection."connectionOwnerAccountAccessVersion" = grant_row."connectionOwnerAccountAccessVersion"
       AND delegation."connectionOwnerAccountAccessVersion" = grant_row."connectionOwnerAccountAccessVersion"
       AND provider."ownerAccountAccessVersion" = grant_row."connectionOwnerAccountAccessVersion"
       AND owner_user."accountAccessVersion" = grant_row."connectionOwnerAccountAccessVersion"
       AND owner_user."disabledAt" IS NULL
  );
$$;

CREATE OR REPLACE FUNCTION "personal_memory_frozen_evidence_valid"(
  p_generation_id UUID,
  p_require_complete BOOLEAN DEFAULT false
)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN "personal_memory_frozen_evidence_valid_without_epoch"(p_generation_id, p_require_complete)
    AND "personal_ai_memory_generation_epoch_valid"(p_generation_id);
END;
$$;

ALTER FUNCTION "personal_memory_index_live_evidence_valid"(UUID, BOOLEAN)
  RENAME TO "personal_memory_index_live_evidence_valid_without_epoch";

CREATE OR REPLACE FUNCTION "personal_memory_index_live_evidence_valid"(
  p_generation_id UUID,
  p_require_complete BOOLEAN DEFAULT false
)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN "personal_memory_index_live_evidence_valid_without_epoch"(p_generation_id, p_require_complete)
    AND "personal_ai_memory_generation_epoch_valid"(p_generation_id);
END;
$$;

-- Account lifecycle transitions intentionally invalidate prior personal memory
-- evidence by epoch. They must not be forced to perform a separate generation
-- cleanup transaction. Every other AppUser mutation retains the original
-- final-evidence requirement.
CREATE OR REPLACE FUNCTION "personal_memory_upstream_invalidation_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  lifecycle_context TEXT := current_setting('app.account_access_lifecycle_context', true);
  lifecycle_action TEXT := current_setting('app.account_access_lifecycle_action', true);
  lifecycle_target TEXT := current_setting('app.account_access_lifecycle_user_id', true);
  lifecycle_actor TEXT := current_setting('app.account_access_lifecycle_actor_id', true);
  lifecycle_version_after TEXT := current_setting('app.account_access_lifecycle_version_after', true);
  lifecycle_skip BOOLEAN := FALSE;
BEGIN
  IF TG_TABLE_NAME = 'AiProviderConnection' THEN
    IF TG_OP = 'DELETE'
       OR OLD."kind" IS DISTINCT FROM NEW."kind"
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
    THEN PERFORM "personal_memory_require_final_evidence"(p_provider_id => OLD."id"); END IF;
  ELSIF TG_TABLE_NAME = 'ExternalCredential' THEN
    IF TG_OP = 'DELETE' OR OLD."kind" IS DISTINCT FROM NEW."kind" OR OLD."secretFingerprint" IS DISTINCT FROM NEW."secretFingerprint"
    THEN PERFORM "personal_memory_require_final_evidence"(p_credential_id => OLD."id"); END IF;
  ELSIF TG_TABLE_NAME = 'MembershipSubscription' THEN
    IF TG_OP = 'DELETE' OR OLD."status" IS DISTINCT FROM NEW."status" OR OLD."version" IS DISTINCT FROM NEW."version"
       OR OLD."startsAt" IS DISTINCT FROM NEW."startsAt" OR OLD."expiresAt" IS DISTINCT FROM NEW."expiresAt"
       OR OLD."revokedAt" IS DISTINCT FROM NEW."revokedAt" OR OLD."revokedById" IS DISTINCT FROM NEW."revokedById"
       OR OLD."revocationReason" IS DISTINCT FROM NEW."revocationReason"
    THEN PERFORM "personal_memory_require_final_evidence"(p_subscription_user_id => OLD."userId"); END IF;
  ELSIF TG_TABLE_NAME = 'ProjectMembership' THEN
    IF TG_OP = 'DELETE' OR OLD."projectId" IS DISTINCT FROM NEW."projectId" OR OLD."userId" IS DISTINCT FROM NEW."userId"
       OR OLD."role" IS DISTINCT FROM NEW."role" OR OLD."accessState" IS DISTINCT FROM NEW."accessState"
       OR OLD."createdAt" IS DISTINCT FROM NEW."createdAt"
    THEN PERFORM "personal_memory_require_final_evidence"(p_membership_id => OLD."id"); END IF;
  ELSIF TG_TABLE_NAME = 'AppUser' THEN
    lifecycle_skip := TG_OP = 'UPDATE'
      AND lifecycle_context = '1'
      AND lifecycle_target = OLD."id"::text
      AND lifecycle_actor IS NOT NULL
      AND lifecycle_actor <> OLD."id"::text
      AND lifecycle_action IN ('disable', 'restore')
      AND lifecycle_version_after = NEW."accountAccessVersion"::text
      AND NEW."accountAccessVersion" = OLD."accountAccessVersion" + 1
      AND (
        (lifecycle_action = 'disable' AND OLD."disabledAt" IS NULL AND NEW."disabledAt" IS NOT NULL)
        OR (lifecycle_action = 'restore' AND OLD."disabledAt" IS NOT NULL AND NEW."disabledAt" IS NULL)
      );
    IF TG_OP = 'DELETE' THEN
      PERFORM "personal_memory_require_final_evidence"(p_user_id => OLD."id");
    ELSIF (OLD."disabledAt" IS DISTINCT FROM NEW."disabledAt" OR OLD."accountAccessVersion" IS DISTINCT FROM NEW."accountAccessVersion")
      AND NOT lifecycle_skip
    THEN
      PERFORM "personal_memory_require_final_evidence"(p_user_id => OLD."id");
    END IF;
  ELSIF TG_TABLE_NAME = 'Project' AND OLD."archivedAt" IS DISTINCT FROM NEW."archivedAt" THEN
    PERFORM "personal_memory_require_final_evidence"(p_project_id => OLD."id");
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
