-- The epoch guard is deferred so it observes the final project-deletion
-- cascade.  A retained personal provider-call audit is the one permitted
-- exception: PostgreSQL SET NULLs only the live grant FK while the immutable
-- scalar evidence remains available for retention.
CREATE OR REPLACE FUNCTION "personal_ai_provider_call_audit_epoch_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."routeSource" IS DISTINCT FROM 'personal_delegation' THEN
    IF NEW."connectionOwnerAccountAccessVersion" IS NOT NULL THEN
      RAISE EXCEPTION 'PERSONAL_AI_ACCOUNT_EPOCH_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- A project delete cascades the WebAiGrant and changes only the audit's
  -- live grant FK.  Reuse the exact retention predicate from the personal
  -- runtime evidence guard, then require the delegation and every frozen
  -- personal snapshot to remain intact.  This prevents a caller from
  -- manufacturing a NULL grant link or changing the owner epoch as part of
  -- an ordinary UPDATE.
  IF TG_OP = 'UPDATE'
     AND OLD."webAiGrantId" IS NOT NULL
     AND NEW."webAiGrantId" IS NULL
     AND NEW."webAiGrantReferenceId" IS NOT NULL
     AND OLD."webAiGrantReferenceId" IS NOT DISTINCT FROM NEW."webAiGrantReferenceId"
     AND NEW."webAiGrantProjectId" IS NOT NULL
     AND OLD."webAiGrantProjectId" IS NOT DISTINCT FROM NEW."webAiGrantProjectId"
     AND NEW."personalDelegationId" IS NOT NULL
     AND OLD."providerConnectionId" IS NOT DISTINCT FROM NEW."providerConnectionId"
     AND OLD."operation" IS NOT DISTINCT FROM NEW."operation"
     AND OLD."modelId" IS NOT DISTINCT FROM NEW."modelId"
     AND OLD."billingMode" IS NOT DISTINCT FROM NEW."billingMode"
     AND OLD."billingUserId" IS NOT DISTINCT FROM NEW."billingUserId"
     AND OLD."callKey" IS NOT DISTINCT FROM NEW."callKey"
     AND OLD."reservationId" IS NOT DISTINCT FROM NEW."reservationId"
     AND OLD."routeSource" IS NOT DISTINCT FROM NEW."routeSource"
     AND OLD."routeId" IS NOT DISTINCT FROM NEW."routeId"
     AND OLD."routeVersion" IS NOT DISTINCT FROM NEW."routeVersion"
     AND OLD."routeUpdatedAt" IS NOT DISTINCT FROM NEW."routeUpdatedAt"
     AND OLD."providerConfigurationVersion" IS NOT DISTINCT FROM NEW."providerConfigurationVersion"
     AND OLD."quotaMultiplierBps" IS NOT DISTINCT FROM NEW."quotaMultiplierBps"
     AND OLD."routeFenceFingerprint" IS NOT DISTINCT FROM NEW."routeFenceFingerprint"
     AND OLD."credentialSecretFingerprint" IS NOT DISTINCT FROM NEW."credentialSecretFingerprint"
     AND OLD."personalDelegationId" IS NOT DISTINCT FROM NEW."personalDelegationId"
     AND OLD."personalDelegationVersion" IS NOT DISTINCT FROM NEW."personalDelegationVersion"
     AND OLD."personalDelegationFingerprint" IS NOT DISTINCT FROM NEW."personalDelegationFingerprint"
     AND OLD."effectiveRouteSelectionId" IS NOT DISTINCT FROM NEW."effectiveRouteSelectionId"
     AND OLD."effectiveRouteSelectionVersion" IS NOT DISTINCT FROM NEW."effectiveRouteSelectionVersion"
     AND OLD."effectiveRouteSelectionUpdatedAt" IS NOT DISTINCT FROM NEW."effectiveRouteSelectionUpdatedAt"
     AND OLD."payerKind" IS NOT DISTINCT FROM NEW."payerKind"
     AND OLD."payerProviderConnectionId" IS NOT DISTINCT FROM NEW."payerProviderConnectionId"
     AND OLD."ownerProjectMembershipId" IS NOT DISTINCT FROM NEW."ownerProjectMembershipId"
     AND OLD."ownerMembershipCreatedAt" IS NOT DISTINCT FROM NEW."ownerMembershipCreatedAt"
     AND OLD."ownerSubscriptionId" IS NOT DISTINCT FROM NEW."ownerSubscriptionId"
     AND OLD."ownerSubscriptionVersion" IS NOT DISTINCT FROM NEW."ownerSubscriptionVersion"
     AND OLD."ownerSubscriptionStartsAt" IS NOT DISTINCT FROM NEW."ownerSubscriptionStartsAt"
     AND OLD."ownerSubscriptionExpiresAt" IS NOT DISTINCT FROM NEW."ownerSubscriptionExpiresAt"
     AND OLD."connectionOwnerAccountAccessVersion" IS NOT DISTINCT FROM NEW."connectionOwnerAccountAccessVersion"
     AND OLD."projectConfirmedById" IS NOT DISTINCT FROM NEW."projectConfirmedById"
     AND OLD."projectConfirmedProjectMembershipId" IS NOT DISTINCT FROM NEW."projectConfirmedProjectMembershipId"
     AND OLD."projectConfirmedMembershipCreatedAt" IS NOT DISTINCT FROM NEW."projectConfirmedMembershipCreatedAt"
     AND OLD."selectedById" IS NOT DISTINCT FROM NEW."selectedById"
     AND OLD."selectedByProjectMembershipId" IS NOT DISTINCT FROM NEW."selectedByProjectMembershipId"
     AND OLD."selectedByMembershipCreatedAt" IS NOT DISTINCT FROM NEW."selectedByMembershipCreatedAt"
     AND OLD."embeddingDimensions" IS NOT DISTINCT FROM NEW."embeddingDimensions"
     AND OLD."maxOutputTokens" IS NOT DISTINCT FROM NEW."maxOutputTokens"
     AND NOT EXISTS (SELECT 1 FROM "WebAiGrant" WHERE "id" = NEW."webAiGrantReferenceId")
     AND NOT EXISTS (SELECT 1 FROM "Project" WHERE "id" = NEW."webAiGrantProjectId")
     AND NOT EXISTS (SELECT 1 FROM "ProjectAiProviderDelegation" WHERE "id" = NEW."personalDelegationId")
     AND EXISTS (
       SELECT 1 FROM "ProjectDeletionReceipt" receipt
        WHERE receipt."deletedProjectId" = NEW."webAiGrantProjectId"
          AND receipt."status" IN ('database_deleted', 'completed', 'cleanup_failed')
     )
  THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD."connectionOwnerAccountAccessVersion" IS NULL AND NEW."connectionOwnerAccountAccessVersion" IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."connectionOwnerAccountAccessVersion" IS DISTINCT FROM NEW."connectionOwnerAccountAccessVersion" THEN
    RAISE EXCEPTION 'PERSONAL_AI_ACCOUNT_EPOCH_IMMUTABLE' USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."connectionOwnerAccountAccessVersion" IS NULL THEN
    RAISE EXCEPTION 'PERSONAL_AI_ACCOUNT_EPOCH_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM "ProjectAiProviderDelegation" delegation
     WHERE delegation."id" = NEW."personalDelegationId"
       AND delegation."connectionOwnerId" = NEW."billingUserId"
       AND delegation."connectionOwnerAccountAccessVersion" = NEW."connectionOwnerAccountAccessVersion"
  ) THEN
    RAISE EXCEPTION 'PERSONAL_AI_ACCOUNT_EPOCH_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' AND NOT "personal_ai_owner_account_access_epoch_valid"(NEW."billingUserId", NEW."connectionOwnerAccountAccessVersion") THEN
    RAISE EXCEPTION 'PERSONAL_AI_ACCOUNT_EPOCH_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
