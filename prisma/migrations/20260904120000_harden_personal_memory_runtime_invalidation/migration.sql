-- Runtime evidence hardening for personal memory invalidation and historical
-- platform audit compatibility.  This migration does not enable personal
-- provider transport; it only closes database evidence and lifecycle gaps.

-- A historical platform grant is a nullable legacy snapshot.  It may be
-- terminalized by updating an existing audit, but it must never be used as the
-- parent of a newly inserted complete audit.  The 1100 relation guard used the
-- grant shape alone, which made that carve-out applicable to INSERT as well.
CREATE OR REPLACE FUNCTION "runtime_ai_historical_audit_shape_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  grant_row RECORD;
  historical_grant BOOLEAN;
  historical_audit BOOLEAN;
BEGIN
  IF NEW."routeSource" NOT IN ('project_override', 'platform_default')
     OR NEW."webAiGrantId" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT
    "routeSource" AS route_source,
    "payerKind" AS payer_kind,
    "credentialSecretFingerprint" AS credential_secret_fingerprint,
    "embeddingDimensions" AS embedding_dimensions,
    "maxOutputTokens" AS max_output_tokens,
    "personalDelegationId" AS personal_delegation_id,
    "effectiveRouteSelectionId" AS effective_route_selection_id,
    "ownerProjectMembershipId" AS owner_project_membership_id,
    "ownerSubscriptionId" AS owner_subscription_id,
    "projectConfirmedById" AS project_confirmed_by_id,
    "selectedById" AS selected_by_id
    INTO grant_row
    FROM "WebAiGrant"
   WHERE "id" = NEW."webAiGrantId";

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  historical_grant := grant_row.route_source IN ('project_override', 'platform_default')
    AND grant_row.payer_kind IS NULL
    AND grant_row.credential_secret_fingerprint IS NULL
    AND grant_row.embedding_dimensions IS NULL
    AND grant_row.max_output_tokens IS NULL
    AND grant_row.personal_delegation_id IS NULL
    AND grant_row.effective_route_selection_id IS NULL
    AND grant_row.owner_project_membership_id IS NULL
    AND grant_row.owner_subscription_id IS NULL
    AND grant_row.project_confirmed_by_id IS NULL
    AND grant_row.selected_by_id IS NULL;

  IF NOT historical_grant THEN
    RETURN NEW;
  END IF;

  -- No INSERT can claim a historical row.  Historical terminalization is
  -- accepted only when the audit itself has the old nullable payer/dimension/
  -- max shape and retains its original credential fingerprint.
  IF TG_OP = 'INSERT' THEN
    RAISE EXCEPTION 'provider-call audit grant tuple mismatch'
      USING ERRCODE = 'check_violation';
  END IF;

  historical_audit := NEW."payerKind" IS NULL
    AND NEW."embeddingDimensions" IS NULL
    AND NEW."maxOutputTokens" IS NULL
    AND NEW."personalDelegationId" IS NULL
    AND NEW."effectiveRouteSelectionId" IS NULL
    AND NEW."ownerProjectMembershipId" IS NULL
    AND NEW."ownerSubscriptionId" IS NULL
    AND NEW."projectConfirmedById" IS NULL
    AND NEW."selectedById" IS NULL
    AND NEW."credentialSecretFingerprint" IS NOT NULL
    AND NEW."credentialSecretFingerprint" ~ '^[0-9a-f]{64}$';

  IF NOT historical_audit THEN
    RAISE EXCEPTION 'provider-call audit grant tuple mismatch'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ProviderCallAudit_historical_shape_guard"
BEFORE INSERT OR UPDATE ON "ProviderCallAudit"
FOR EACH ROW EXECUTE FUNCTION "runtime_ai_historical_audit_shape_guard"();

-- The pre-existing lifecycle trigger treats every terminal generation as
-- immutable. Personal runtime evidence needs one narrow, auditable escape:
-- after a personal pointer has been removed, a complete generation may be
-- terminalized as failed/unknown/superseded before an upstream invalidation
-- is committed. The deferred personal final-state guard below still rejects
-- the transition when a pointer remains, and all non-personal lifecycle
-- transitions continue through the original guard unchanged.
DROP TRIGGER IF EXISTS "MemoryIndexGeneration_guard" ON "MemoryIndexGeneration";
CREATE TRIGGER "MemoryIndexGeneration_guard_ins"
BEFORE INSERT ON "MemoryIndexGeneration"
FOR EACH ROW EXECUTE FUNCTION "memory_index_generation_guard"();

CREATE TRIGGER "MemoryIndexGeneration_guard_del"
BEFORE DELETE ON "MemoryIndexGeneration"
FOR EACH ROW EXECUTE FUNCTION "memory_index_generation_guard"();

CREATE TRIGGER "MemoryIndexGeneration_guard_upd"
BEFORE UPDATE ON "MemoryIndexGeneration"
FOR EACH ROW
WHEN (
  OLD."jobId" IS NULL
  OR OLD."status" IS DISTINCT FROM 'complete'
  OR NEW."status" NOT IN ('failed', 'unknown', 'superseded')
  OR OLD."expectedEmbeddingRouteSource" IS DISTINCT FROM 'personal_delegation'
)
EXECUTE FUNCTION "memory_index_generation_guard"();

CREATE OR REPLACE FUNCTION "personal_memory_complete_terminalization_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."jobId" IS NULL
     OR OLD."status" IS DISTINCT FROM 'complete'
     OR NEW."status" NOT IN ('failed', 'unknown', 'superseded')
     OR OLD."expectedEmbeddingRouteSource" IS DISTINCT FROM 'personal_delegation'
  THEN
    RETURN NEW;
  END IF;

  IF OLD."id" IS DISTINCT FROM NEW."id"
     OR OLD."projectId" IS DISTINCT FROM NEW."projectId"
     OR OLD."jobId" IS DISTINCT FROM NEW."jobId"
     OR OLD."providerConnectionId" IS DISTINCT FROM NEW."providerConnectionId"
     OR OLD."modelId" IS DISTINCT FROM NEW."modelId"
     OR OLD."dimensions" IS DISTINCT FROM NEW."dimensions"
     OR OLD."buildMode" IS DISTINCT FROM NEW."buildMode"
     OR OLD."inputManifestFingerprint" IS DISTINCT FROM NEW."inputManifestFingerprint"
     OR OLD."expectedActiveIndexGenerationId" IS DISTINCT FROM NEW."expectedActiveIndexGenerationId"
     OR OLD."expectedEmbeddingRouteSource" IS DISTINCT FROM NEW."expectedEmbeddingRouteSource"
     OR OLD."expectedEmbeddingRouteId" IS DISTINCT FROM NEW."expectedEmbeddingRouteId"
     OR OLD."expectedEmbeddingRouteVersion" IS DISTINCT FROM NEW."expectedEmbeddingRouteVersion"
     OR OLD."expectedEmbeddingRouteUpdatedAt" IS DISTINCT FROM NEW."expectedEmbeddingRouteUpdatedAt"
     OR OLD."expectedEmbeddingProviderConfigurationVersion" IS DISTINCT FROM NEW."expectedEmbeddingProviderConfigurationVersion"
     OR OLD."expectedEmbeddingRouteFenceFingerprint" IS DISTINCT FROM NEW."expectedEmbeddingRouteFenceFingerprint"
     OR OLD."embeddingWebAiGrantId" IS DISTINCT FROM NEW."embeddingWebAiGrantId"
     OR OLD."expectedInputCount" IS DISTINCT FROM NEW."expectedInputCount"
     OR OLD."generatedRecordCount" IS DISTINCT FROM NEW."generatedRecordCount"
     OR OLD."reusedRecordCount" IS DISTINCT FROM NEW."reusedRecordCount"
     OR OLD."deadlineAt" IS DISTINCT FROM NEW."deadlineAt"
     OR OLD."recordCount" IS DISTINCT FROM NEW."recordCount"
     OR OLD."createdAt" IS DISTINCT FROM NEW."createdAt"
     OR OLD."completedAt" IS DISTINCT FROM NEW."completedAt"
  THEN
    RAISE EXCEPTION 'PERSONAL_MEMORY_INDEX_TERMINALIZATION_INVALID'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."status" = 'failed'
     AND (NEW."failureCode" IS NULL OR NEW."reconciliationRequired" OR NEW."supersededAt" IS NOT NULL)
  THEN
    RAISE EXCEPTION 'PERSONAL_MEMORY_INDEX_TERMINALIZATION_INVALID'
      USING ERRCODE = 'check_violation';
  ELSIF NEW."status" = 'unknown'
     AND (NEW."failureCode" IS NULL OR NOT NEW."reconciliationRequired" OR NEW."supersededAt" IS NOT NULL)
  THEN
    RAISE EXCEPTION 'PERSONAL_MEMORY_INDEX_TERMINALIZATION_INVALID'
      USING ERRCODE = 'check_violation';
  ELSIF NEW."status" = 'superseded'
     AND (NEW."supersededAt" IS NULL OR NEW."failureCode" IS NOT NULL OR NEW."reconciliationRequired")
  THEN
    RAISE EXCEPTION 'PERSONAL_MEMORY_INDEX_TERMINALIZATION_INVALID'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "MemoryPersonalCompleteTerminalizationGuard"
BEFORE UPDATE ON "MemoryIndexGeneration"
FOR EACH ROW
WHEN (
  OLD."jobId" IS NOT NULL
  AND OLD."status" = 'complete'
  AND NEW."status" IN ('failed', 'unknown', 'superseded')
  AND OLD."expectedEmbeddingRouteSource" = 'personal_delegation'
)
EXECUTE FUNCTION "personal_memory_complete_terminalization_guard"();

-- Validate personal memory using the frozen evidence identifiers stored on the
-- grant and generation.  Current delegation/selection rows are still checked,
-- but they are reached through those frozen IDs rather than by asking which
-- delegation is currently selected.  That lets invalidation detect a deleted
-- or terminalized upstream row instead of accidentally treating a replacement
-- delegation as proof for the old generation.
CREATE OR REPLACE FUNCTION "personal_memory_frozen_evidence_valid"(
  p_generation_id UUID,
  p_require_complete BOOLEAN DEFAULT false
)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  valid BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1
      FROM "MemoryIndexGeneration" generation
      JOIN "WebAiGrant" grant_row
        ON grant_row."id" = generation."embeddingWebAiGrantId"
      JOIN "BackgroundJob" job
        ON job."id" = generation."jobId"
      JOIN "Project" project_row
        ON project_row."id" = generation."projectId"
      JOIN "ProjectAiEffectiveRouteSelection" selection
        ON selection."id" = grant_row."effectiveRouteSelectionId"
      JOIN "ProjectAiProviderDelegation" delegation
        ON delegation."id" = grant_row."personalDelegationId"
      JOIN "AiProviderConnection" provider
        ON provider."id" = grant_row."providerConnectionId"
      JOIN "ExternalCredential" credential
        ON credential."id" = provider."credentialId"
      JOIN "AppUser" owner_user
        ON owner_user."id" = grant_row."billingUserId"
      JOIN "ProjectMembership" owner_membership
        ON owner_membership."id" = grant_row."ownerProjectMembershipId"
      JOIN "MembershipSubscription" subscription
        ON subscription."id" = grant_row."ownerSubscriptionId"
      JOIN "ProjectMembership" project_owner_membership
        ON project_owner_membership."id" = grant_row."projectConfirmedProjectMembershipId"
      JOIN "AppUser" project_owner
        ON project_owner."id" = grant_row."projectConfirmedById"
      JOIN "ProjectMembership" selected_membership
        ON selected_membership."id" = grant_row."selectedByProjectMembershipId"
      JOIN "AppUser" selected_owner
        ON selected_owner."id" = grant_row."selectedById"
     WHERE generation."id" = p_generation_id
       AND generation."expectedEmbeddingRouteSource" = 'personal_delegation'
       AND generation."jobId" = grant_row."boundJobId"
       AND generation."expectedEmbeddingRouteId" = grant_row."effectiveRouteSelectionId"
       AND generation."expectedEmbeddingRouteVersion" = grant_row."effectiveRouteSelectionVersion"
       AND generation."expectedEmbeddingRouteUpdatedAt" = grant_row."effectiveRouteSelectionUpdatedAt"
       AND generation."expectedEmbeddingProviderConfigurationVersion" = grant_row."providerConfigurationVersion"
       AND generation."expectedEmbeddingRouteFenceFingerprint" = grant_row."routeFenceFingerprint"
       AND generation."projectId" = grant_row."projectId"
       AND generation."providerConnectionId" = grant_row."providerConnectionId"
       AND generation."modelId" = grant_row."modelId"
       AND generation."dimensions" = grant_row."embeddingDimensions"
       AND (NOT p_require_complete OR generation."status" = 'complete')
       AND grant_row."operation" = 'embedding'
       AND grant_row."billingMode" = 'byok'
       AND grant_row."payerKind" = 'personal_connection_owner'
       AND grant_row."payerProviderConnectionId" = grant_row."providerConnectionId"
       AND grant_row."personalDelegationId" = delegation."id"
       AND grant_row."personalDelegationVersion" = delegation."version"
       AND grant_row."personalDelegationFingerprint" = delegation."delegationFingerprint"
       AND grant_row."effectiveRouteSelectionId" = selection."id"
       AND grant_row."effectiveRouteSelectionVersion" = selection."version"
       AND grant_row."effectiveRouteSelectionUpdatedAt" = selection."updatedAt"
       AND grant_row."routeSource" = 'personal_delegation'
       AND grant_row."routeId" = selection."id"
       AND grant_row."routeVersion" = selection."version"
       AND grant_row."routeUpdatedAt" = selection."updatedAt"
       AND grant_row."credentialSecretFingerprint" = credential."secretFingerprint"
       AND grant_row."ownerProjectMembershipId" = owner_membership."id"
       AND grant_row."ownerMembershipCreatedAt" = owner_membership."createdAt"
       AND grant_row."ownerSubscriptionId" = subscription."id"
       AND grant_row."ownerSubscriptionVersion" = subscription."version"
       AND grant_row."ownerSubscriptionStartsAt" = subscription."startsAt"
       AND grant_row."ownerSubscriptionExpiresAt" = subscription."expiresAt"
       AND grant_row."projectConfirmedProjectMembershipId" = project_owner_membership."id"
       AND grant_row."projectConfirmedMembershipCreatedAt" = project_owner_membership."createdAt"
       AND grant_row."selectedByProjectMembershipId" = selected_membership."id"
       AND grant_row."selectedByMembershipCreatedAt" = selected_membership."createdAt"
       AND grant_row."revokedAt" IS NULL
       AND grant_row."expiresAt" > clock_timestamp()
       AND delegation."projectId" = grant_row."projectId"
       AND delegation."operation" = grant_row."operation"
       AND delegation."status" = 'active'
       AND delegation."expiresAt" > clock_timestamp()
       AND delegation."providerConnectionId" = grant_row."providerConnectionId"
       AND delegation."connectionOwnerId" = grant_row."billingUserId"
       AND delegation."providerConfigurationVersion" = grant_row."providerConfigurationVersion"
       AND delegation."credentialFingerprint" = grant_row."credentialSecretFingerprint"
       AND delegation."modelId" = grant_row."modelId"
       AND delegation."embeddingDimensions" = grant_row."embeddingDimensions"
       AND delegation."ownerProjectMembershipId" = grant_row."ownerProjectMembershipId"
       AND delegation."ownerMembershipCreatedAt" = grant_row."ownerMembershipCreatedAt"
       AND delegation."connectionOwnerSubscriptionId" = grant_row."ownerSubscriptionId"
       AND delegation."connectionOwnerSubscriptionVersion" = grant_row."ownerSubscriptionVersion"
       AND delegation."connectionOwnerSubscriptionStartsAt" = grant_row."ownerSubscriptionStartsAt"
       AND delegation."connectionOwnerSubscriptionExpiresAt" = grant_row."ownerSubscriptionExpiresAt"
       AND delegation."projectConfirmedById" = grant_row."projectConfirmedById"
       AND delegation."projectConfirmedProjectMembershipId" = grant_row."projectConfirmedProjectMembershipId"
       AND delegation."projectConfirmedMembershipCreatedAt" = grant_row."projectConfirmedMembershipCreatedAt"
       AND selection."projectId" = grant_row."projectId"
       AND selection."operation" = grant_row."operation"
       AND selection."source" = 'personal_delegation'
       AND selection."delegationId" = delegation."id"
       AND selection."version" = grant_row."effectiveRouteSelectionVersion"
       AND selection."updatedAt" = grant_row."effectiveRouteSelectionUpdatedAt"
       AND selection."selectedById" = grant_row."selectedById"
       AND selection."selectedByProjectMembershipId" = grant_row."selectedByProjectMembershipId"
       AND project_row."id" = grant_row."projectId"
       AND project_row."archivedAt" IS NULL
       AND job."projectId" = grant_row."projectId"
       AND job."requestedById" = grant_row."issuedById"
       AND owner_user."disabledAt" IS NULL
       AND owner_membership."projectId" = grant_row."projectId"
       AND owner_membership."userId" = grant_row."billingUserId"
       AND owner_membership."role" IN ('owner', 'editor')
       AND owner_membership."accessState" = 'confirmed'
       AND subscription."userId" = grant_row."billingUserId"
       AND subscription."status" = 'active'
       AND subscription."startsAt" <= clock_timestamp()
       AND subscription."expiresAt" > clock_timestamp()
       AND project_owner_membership."projectId" = grant_row."projectId"
       AND project_owner_membership."userId" = grant_row."projectConfirmedById"
       AND project_owner_membership."role" = 'owner'
       AND project_owner_membership."accessState" = 'confirmed'
       AND project_owner."disabledAt" IS NULL
       AND selected_membership."projectId" = grant_row."projectId"
       AND selected_membership."userId" = grant_row."selectedById"
       AND selected_membership."role" = 'owner'
       AND selected_membership."accessState" = 'confirmed'
       AND selected_owner."disabledAt" IS NULL
       AND provider."id" = grant_row."payerProviderConnectionId"
       AND provider."scope" = 'user'
       AND provider."ownerUserId" = grant_row."billingUserId"
       AND provider."workspaceId" IS NULL
       AND provider."ownershipState" = 'confirmed'
       AND provider."status" = 'verified'
       AND provider."disabledAt" IS NULL
       AND provider."configurationVersion" = grant_row."providerConfigurationVersion"
       AND provider."protocol" = 'chat_completions'
       AND provider."baseUrl" = CASE provider."kind"::text
         WHEN 'openai' THEN 'https://api.openai.com/v1'
         WHEN 'deepseek' THEN 'https://api.deepseek.com'
         WHEN 'qwen' THEN 'https://dashscope.aliyuncs.com/compatible-mode/v1'
         WHEN 'glm' THEN 'https://open.bigmodel.cn/api/paas/v4'
         ELSE NULL
       END
       AND provider."defaultEmbeddingModelId" = grant_row."modelId"
       AND provider."embeddingDimensions" = grant_row."embeddingDimensions"
       AND provider."kind" <> 'deepseek'
       AND credential."kind" = 'ai_provider'
  ) INTO valid;
  RETURN COALESCE(valid, false);
END;
$$;

-- A frozen personal generation or pointer is stale when any relevant upstream
-- object changes and the generation has not first been terminalized and the
-- pointer removed.  The project deletion path is intentionally excluded by
-- callers because its cascade is covered by ProjectDeletionReceipt retention.
CREATE OR REPLACE FUNCTION "personal_memory_scope_has_stale_evidence"(
  p_provider_id UUID DEFAULT NULL,
  p_credential_id UUID DEFAULT NULL,
  p_subscription_user_id UUID DEFAULT NULL,
  p_membership_id UUID DEFAULT NULL,
  p_user_id UUID DEFAULT NULL,
  p_project_id UUID DEFAULT NULL,
  p_delegation_id UUID DEFAULT NULL,
  p_selection_id UUID DEFAULT NULL,
  p_grant_id UUID DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  stale BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1
      FROM "MemoryIndexGeneration" generation
      JOIN "WebAiGrant" grant_row
        ON grant_row."id" = generation."embeddingWebAiGrantId"
      LEFT JOIN "AiProviderConnection" provider
        ON provider."id" = grant_row."providerConnectionId"
     WHERE generation."expectedEmbeddingRouteSource" = 'personal_delegation'
       AND (
         generation."status" IN ('staging', 'building', 'complete')
         OR EXISTS (
           SELECT 1
             FROM "MemoryIndexPointer" pointer
            WHERE pointer."projectId" = generation."projectId"
              AND pointer."indexGenerationId" = generation."id"
         )
       )
       AND (
         (p_provider_id IS NOT NULL AND (grant_row."providerConnectionId" = p_provider_id OR grant_row."payerProviderConnectionId" = p_provider_id))
         OR (p_credential_id IS NOT NULL AND provider."credentialId" = p_credential_id)
         OR (p_subscription_user_id IS NOT NULL AND grant_row."billingUserId" = p_subscription_user_id)
         OR (p_membership_id IS NOT NULL AND (
           grant_row."ownerProjectMembershipId" = p_membership_id
           OR grant_row."projectConfirmedProjectMembershipId" = p_membership_id
           OR grant_row."selectedByProjectMembershipId" = p_membership_id
         ))
         OR (p_user_id IS NOT NULL AND (
           grant_row."billingUserId" = p_user_id
           OR grant_row."projectConfirmedById" = p_user_id
           OR grant_row."selectedById" = p_user_id
         ))
         OR (p_project_id IS NOT NULL AND generation."projectId" = p_project_id)
         OR (p_delegation_id IS NOT NULL AND grant_row."personalDelegationId" = p_delegation_id)
         OR (p_selection_id IS NOT NULL AND grant_row."effectiveRouteSelectionId" = p_selection_id)
         OR (p_grant_id IS NOT NULL AND grant_row."id" = p_grant_id)
       )
       AND (
         NOT "personal_memory_frozen_evidence_valid"(generation."id", false)
         OR EXISTS (
           SELECT 1
             FROM "MemoryIndexPointer" pointer
            WHERE pointer."projectId" = generation."projectId"
              AND pointer."indexGenerationId" = generation."id"
         )
       )
  ) INTO stale;
  RETURN COALESCE(stale, false);
END;
$$;

CREATE OR REPLACE FUNCTION "personal_memory_require_final_evidence"(
  p_provider_id UUID DEFAULT NULL,
  p_credential_id UUID DEFAULT NULL,
  p_subscription_user_id UUID DEFAULT NULL,
  p_membership_id UUID DEFAULT NULL,
  p_user_id UUID DEFAULT NULL,
  p_project_id UUID DEFAULT NULL,
  p_delegation_id UUID DEFAULT NULL,
  p_selection_id UUID DEFAULT NULL,
  p_grant_id UUID DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF "personal_memory_scope_has_stale_evidence"(
    p_provider_id,
    p_credential_id,
    p_subscription_user_id,
    p_membership_id,
    p_user_id,
    p_project_id,
    p_delegation_id,
    p_selection_id,
    p_grant_id
  ) THEN
    RAISE EXCEPTION 'PERSONAL_MEMORY_INDEX_EVIDENCE_INVALIDATION_REQUIRED'
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION "personal_memory_generation_final_state_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."expectedEmbeddingRouteSource" <> 'personal_delegation' THEN RETURN OLD; END IF;
    IF NOT EXISTS (SELECT 1 FROM "Project" WHERE "id" = OLD."projectId")
       AND EXISTS (
         SELECT 1 FROM "ProjectDeletionReceipt" receipt
          WHERE receipt."deletedProjectId" = OLD."projectId"
            AND receipt."status" IN ('pending', 'database_deleted', 'completed', 'cleanup_failed')
       ) THEN
      RETURN OLD;
    END IF;
    RETURN OLD;
  END IF;
  IF NEW."expectedEmbeddingRouteSource" IS DISTINCT FROM 'personal_delegation' THEN RETURN NEW; END IF;
  IF NEW."status" IN ('staging', 'building', 'complete')
     AND NOT "personal_memory_frozen_evidence_valid"(NEW."id", NEW."status" = 'complete')
  THEN
    RAISE EXCEPTION 'PERSONAL_MEMORY_INDEX_EVIDENCE_INVALIDATION_REQUIRED'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" IN ('failed', 'unknown', 'superseded')
     AND EXISTS (
       SELECT 1 FROM "MemoryIndexPointer" pointer
        WHERE pointer."projectId" = NEW."projectId"
          AND pointer."indexGenerationId" = NEW."id"
     )
  THEN
    RAISE EXCEPTION 'PERSONAL_MEMORY_INDEX_EVIDENCE_INVALIDATION_REQUIRED'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "personal_memory_pointer_final_state_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  generation_row RECORD;
BEGIN
  SELECT "id", "expectedEmbeddingRouteSource", "status"
    INTO generation_row
    FROM "MemoryIndexGeneration"
   WHERE "projectId" = NEW."projectId"
     AND "id" = NEW."indexGenerationId";
  IF FOUND
     AND generation_row."expectedEmbeddingRouteSource" = 'personal_delegation'
     AND generation_row.status = 'complete'
     AND NOT "personal_memory_frozen_evidence_valid"(generation_row.id, true)
  THEN
    RAISE EXCEPTION 'PERSONAL_MEMORY_INDEX_EVIDENCE_INVALIDATION_REQUIRED'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "personal_memory_grant_invalidation_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD."routeSource" = 'personal_delegation'
     AND (
       OLD."revokedAt" IS DISTINCT FROM NEW."revokedAt"
       OR OLD."expiresAt" IS DISTINCT FROM NEW."expiresAt"
     )
  THEN
    PERFORM "personal_memory_require_final_evidence"(p_grant_id => OLD."id");
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "personal_memory_delegation_invalidation_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM "Project" WHERE "id" = OLD."projectId")
       AND EXISTS (
         SELECT 1 FROM "ProjectDeletionReceipt" receipt
          WHERE receipt."deletedProjectId" = OLD."projectId"
            AND receipt."status" IN ('pending', 'database_deleted', 'completed', 'cleanup_failed')
       ) THEN
      RETURN OLD;
    END IF;
    PERFORM "personal_memory_require_final_evidence"(p_delegation_id => OLD."id");
    RETURN OLD;
  END IF;
  IF OLD."status" IS DISTINCT FROM NEW."status"
     OR OLD."version" IS DISTINCT FROM NEW."version"
     OR OLD."expiresAt" IS DISTINCT FROM NEW."expiresAt"
     OR OLD."providerConnectionId" IS DISTINCT FROM NEW."providerConnectionId"
     OR OLD."credentialFingerprint" IS DISTINCT FROM NEW."credentialFingerprint"
     OR OLD."delegationFingerprint" IS DISTINCT FROM NEW."delegationFingerprint"
  THEN
    PERFORM "personal_memory_require_final_evidence"(p_delegation_id => OLD."id");
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "personal_memory_selection_invalidation_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM "Project" WHERE "id" = OLD."projectId")
       AND EXISTS (
         SELECT 1 FROM "ProjectDeletionReceipt" receipt
          WHERE receipt."deletedProjectId" = OLD."projectId"
            AND receipt."status" IN ('pending', 'database_deleted', 'completed', 'cleanup_failed')
       ) THEN
      RETURN OLD;
    END IF;
    PERFORM "personal_memory_require_final_evidence"(p_selection_id => OLD."id");
    RETURN OLD;
  END IF;
  IF OLD."source" IS DISTINCT FROM NEW."source"
     OR OLD."delegationId" IS DISTINCT FROM NEW."delegationId"
     OR OLD."version" IS DISTINCT FROM NEW."version"
     OR OLD."updatedAt" IS DISTINCT FROM NEW."updatedAt"
  THEN
    PERFORM "personal_memory_require_final_evidence"(p_selection_id => OLD."id");
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "personal_memory_upstream_invalidation_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
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
    THEN
      PERFORM "personal_memory_require_final_evidence"(p_provider_id => OLD."id");
    END IF;
  ELSIF TG_TABLE_NAME = 'ExternalCredential' THEN
    IF TG_OP = 'DELETE'
       OR OLD."kind" IS DISTINCT FROM NEW."kind"
       OR OLD."secretFingerprint" IS DISTINCT FROM NEW."secretFingerprint"
    THEN
      PERFORM "personal_memory_require_final_evidence"(p_credential_id => OLD."id");
    END IF;
  ELSIF TG_TABLE_NAME = 'MembershipSubscription' THEN
    IF TG_OP = 'DELETE'
       OR OLD."status" IS DISTINCT FROM NEW."status"
       OR OLD."version" IS DISTINCT FROM NEW."version"
       OR OLD."startsAt" IS DISTINCT FROM NEW."startsAt"
       OR OLD."expiresAt" IS DISTINCT FROM NEW."expiresAt"
       OR OLD."revokedAt" IS DISTINCT FROM NEW."revokedAt"
       OR OLD."revokedById" IS DISTINCT FROM NEW."revokedById"
       OR OLD."revocationReason" IS DISTINCT FROM NEW."revocationReason"
    THEN
      PERFORM "personal_memory_require_final_evidence"(p_subscription_user_id => OLD."userId");
    END IF;
  ELSIF TG_TABLE_NAME = 'ProjectMembership' THEN
    IF TG_OP = 'DELETE'
       OR OLD."projectId" IS DISTINCT FROM NEW."projectId"
       OR OLD."userId" IS DISTINCT FROM NEW."userId"
       OR OLD."role" IS DISTINCT FROM NEW."role"
       OR OLD."accessState" IS DISTINCT FROM NEW."accessState"
       OR OLD."createdAt" IS DISTINCT FROM NEW."createdAt"
    THEN
      PERFORM "personal_memory_require_final_evidence"(p_membership_id => OLD."id");
    END IF;
  ELSIF TG_TABLE_NAME = 'AppUser' THEN
    IF TG_OP = 'DELETE' OR OLD."disabledAt" IS DISTINCT FROM NEW."disabledAt" THEN
      PERFORM "personal_memory_require_final_evidence"(p_user_id => OLD."id");
    END IF;
  ELSIF TG_TABLE_NAME = 'Project' AND OLD."archivedAt" IS DISTINCT FROM NEW."archivedAt" THEN
    PERFORM "personal_memory_require_final_evidence"(p_project_id => OLD."id");
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

-- Statement locks are deliberately the existing 0900 fail-fast advisory
-- domain.  Re-entrant acquisition makes project cascades safe while avoiding
-- a second serialization namespace for runtime evidence.
CREATE TRIGGER "MemoryPersonalWebAiGrantGlobalLock"
BEFORE INSERT OR UPDATE OR DELETE ON "WebAiGrant"
FOR EACH STATEMENT EXECUTE FUNCTION "project_ai_provider_delegation_global_lock"();

CREATE TRIGGER "MemoryPersonalGenerationGlobalLock"
BEFORE INSERT OR UPDATE OR DELETE ON "MemoryIndexGeneration"
FOR EACH STATEMENT EXECUTE FUNCTION "project_ai_provider_delegation_global_lock"();

CREATE TRIGGER "MemoryPersonalPointerGlobalLock"
BEFORE INSERT OR UPDATE OR DELETE ON "MemoryIndexPointer"
FOR EACH STATEMENT EXECUTE FUNCTION "project_ai_provider_delegation_global_lock"();

CREATE CONSTRAINT TRIGGER "MemoryPersonalGrantInvalidationGuard"
AFTER UPDATE ON "WebAiGrant"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "personal_memory_grant_invalidation_guard"();

CREATE CONSTRAINT TRIGGER "MemoryPersonalDelegationInvalidationGuard"
AFTER UPDATE OR DELETE ON "ProjectAiProviderDelegation"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "personal_memory_delegation_invalidation_guard"();

CREATE CONSTRAINT TRIGGER "MemoryPersonalSelectionInvalidationGuard"
AFTER UPDATE OR DELETE ON "ProjectAiEffectiveRouteSelection"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "personal_memory_selection_invalidation_guard"();

CREATE CONSTRAINT TRIGGER "MemoryPersonalGenerationFinalGuard"
AFTER INSERT OR UPDATE OR DELETE ON "MemoryIndexGeneration"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "personal_memory_generation_final_state_guard"();

CREATE CONSTRAINT TRIGGER "MemoryPersonalPointerFinalGuard"
AFTER INSERT OR UPDATE ON "MemoryIndexPointer"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "personal_memory_pointer_final_state_guard"();

CREATE CONSTRAINT TRIGGER "MemoryPersonalProviderInvalidationGuard"
AFTER UPDATE OR DELETE ON "AiProviderConnection"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "personal_memory_upstream_invalidation_guard"();

CREATE CONSTRAINT TRIGGER "MemoryPersonalCredentialInvalidationGuard"
AFTER UPDATE OR DELETE ON "ExternalCredential"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "personal_memory_upstream_invalidation_guard"();

CREATE CONSTRAINT TRIGGER "MemoryPersonalSubscriptionInvalidationGuard"
AFTER UPDATE OR DELETE ON "MembershipSubscription"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "personal_memory_upstream_invalidation_guard"();

CREATE CONSTRAINT TRIGGER "MemoryPersonalMembershipInvalidationGuard"
AFTER UPDATE OR DELETE ON "ProjectMembership"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "personal_memory_upstream_invalidation_guard"();

CREATE CONSTRAINT TRIGGER "MemoryPersonalUserInvalidationGuard"
AFTER UPDATE OR DELETE ON "AppUser"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "personal_memory_upstream_invalidation_guard"();

CREATE CONSTRAINT TRIGGER "MemoryPersonalProjectInvalidationGuard"
AFTER UPDATE ON "Project"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "personal_memory_upstream_invalidation_guard"();

-- An archived project cannot retain a personal selection.  The ordinary
-- lifecycle service does not switch routes: callers must explicitly revoke or
-- switch personal selections before archiving.  A composed transaction may
-- record that audited platform switch together with the archive revision, so
-- preserve only that narrow evidence shape while continuing to reject personal
-- selections and unaudited selection writes on archived projects.
CREATE OR REPLACE FUNCTION "project_ai_effective_route_selection_integrity_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  owner_valid boolean;
  delegation_valid boolean;
  owner_switch_valid boolean := FALSE;
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
          AND (
            project_row."archivedAt" IS NULL
            OR (
              NEW."source" = 'platform_default'
              AND EXISTS (
                SELECT 1
                FROM "ProjectAiProviderDelegationAudit" switch_audit
                WHERE switch_audit."entity" = 'selection'
                  AND switch_audit."action" = 'selection_updated'
                  AND switch_audit."selectionId" = NEW."id"
                  AND switch_audit."selectionVersion" = NEW."version"
                  AND switch_audit."transactionId" = txid_current()
                  AND switch_audit."selectedDelegationId" IS NULL
                  AND switch_audit."reason" IN (
                    'selection_switched_to_platform_before_revocation',
                    'delegation_owner_revocation_explicit_platform_switch'
                  )
              )
              AND EXISTS (
                SELECT 1
                FROM "ProjectLifecycleRevision" lifecycle_revision
                WHERE lifecycle_revision."projectId" = project_row."id"
                  AND lifecycle_revision."action" = 'archived'
                  AND lifecycle_revision."currentArchivedAt" IS NOT NULL
                  AND lifecycle_revision."projectUpdatedAt" = project_row."updatedAt"
              )
            )
          )
      )
  ) INTO owner_valid;
  IF NOT owner_valid
     AND TG_OP = 'UPDATE'
     AND OLD."source" = 'personal_delegation'
     AND OLD."delegationId" IS NOT NULL
     AND NEW."source" = 'platform_default'
     AND NEW."delegationId" IS NULL
  THEN
    SELECT EXISTS (
      SELECT 1
      FROM "ProjectAiProviderDelegation" delegation
      JOIN "ProjectMembership" owner_membership
        ON owner_membership."id" = delegation."ownerProjectMembershipId"
      JOIN "AppUser" owner_user
        ON owner_user."id" = delegation."connectionOwnerId"
      JOIN "Project" project_row
        ON project_row."id" = delegation."projectId"
      WHERE delegation."id" = OLD."delegationId"
        AND delegation."projectId" = NEW."projectId"
        AND delegation."operation" = NEW."operation"
        AND delegation."connectionOwnerId" = NEW."selectedById"
        AND delegation."ownerProjectMembershipId" = NEW."selectedByProjectMembershipId"
        AND delegation."ownerMembershipCreatedAt" = NEW."selectedByMembershipCreatedAt"
        AND delegation."status" = 'revoked'
        AND delegation."terminalActorKind" = 'user'
        AND delegation."terminalActorId" = NEW."selectedById"
        AND delegation."terminalActorProjectMembershipId" = NEW."selectedByProjectMembershipId"
        AND delegation."terminalActorMembershipCreatedAt" = NEW."selectedByMembershipCreatedAt"
        AND length(btrim(delegation."terminalReason")) > 0
        AND owner_membership."projectId" = delegation."projectId"
        AND owner_membership."userId" = delegation."connectionOwnerId"
        AND owner_membership."role" IN ('owner', 'editor')
        AND owner_membership."accessState" = 'confirmed'
        AND owner_membership."createdAt" = delegation."ownerMembershipCreatedAt"
        AND owner_user."disabledAt" IS NULL
        AND project_row."archivedAt" IS NULL
        AND EXISTS (
          SELECT 1
          FROM "ProjectAiProviderDelegationAudit" selection_audit
          WHERE selection_audit."entity" = 'selection'
            AND selection_audit."action" = 'selection_updated'
            AND selection_audit."selectionId" = NEW."id"
            AND selection_audit."selectionVersion" = NEW."version"
            AND selection_audit."selectionSource" = 'platform_default'
            AND selection_audit."selectedDelegationId" IS NULL
            AND selection_audit."selectedByProjectMembershipId" = NEW."selectedByProjectMembershipId"
            AND selection_audit."selectedByMembershipCreatedAt" = NEW."selectedByMembershipCreatedAt"
            AND selection_audit."actorKind" = 'user'
            AND selection_audit."actorId" = NEW."selectedById"
            AND selection_audit."actorProjectMembershipId" = NEW."selectedByProjectMembershipId"
            AND selection_audit."actorMembershipCreatedAt" = NEW."selectedByMembershipCreatedAt"
            AND selection_audit."reason" = 'delegation_owner_revocation_explicit_platform_switch'
            AND selection_audit."transitionAt" = NEW."updatedAt"
            AND selection_audit."transactionId" = txid_current()
        )
        AND EXISTS (
          SELECT 1
          FROM "ProjectAiProviderDelegationAudit" delegation_audit
          WHERE delegation_audit."entity" = 'delegation'
            AND delegation_audit."action" = 'revoked'
            AND delegation_audit."delegationId" = delegation."id"
            AND delegation_audit."delegationVersion" = delegation."version"
            AND delegation_audit."statusBefore" = 'active'
            AND delegation_audit."statusAfter" = 'revoked'
            AND delegation_audit."actorKind" = 'user'
            AND delegation_audit."actorId" = NEW."selectedById"
            AND delegation_audit."actorProjectMembershipId" = NEW."selectedByProjectMembershipId"
            AND delegation_audit."actorMembershipCreatedAt" = NEW."selectedByMembershipCreatedAt"
            AND delegation_audit."terminalActorKind" = 'user'
            AND delegation_audit."terminalActorId" = NEW."selectedById"
            AND delegation_audit."terminalActorProjectMembershipId" = NEW."selectedByProjectMembershipId"
            AND delegation_audit."terminalActorMembershipCreatedAt" = NEW."selectedByMembershipCreatedAt"
            AND delegation_audit."terminalReason" = delegation."terminalReason"
            AND delegation_audit."reason" = delegation."terminalReason"
            AND delegation_audit."transitionAt" = delegation."revokedAt"
            AND delegation_audit."transactionId" = txid_current()
        )
    ) INTO owner_switch_valid;
  END IF;

  IF NOT owner_valid AND NOT owner_switch_valid THEN
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
