-- The previous forward repair accepted only the grant-FK SET NULL event.
-- Project deletion can queue the job-FK and grant-FK updates in either order.
-- Keep this repair forward-only and admit the cascade only after the deferred
-- trigger can observe the final audit row with both live FKs cleared.
CREATE OR REPLACE FUNCTION "personal_ai_provider_call_audit_epoch_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  audit_final "ProviderCallAudit"%ROWTYPE;
BEGIN
  IF NEW."routeSource" IS DISTINCT FROM 'personal_delegation' THEN
    IF NEW."connectionOwnerAccountAccessVersion" IS NOT NULL THEN
      RAISE EXCEPTION 'PERSONAL_AI_ACCOUNT_EPOCH_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- A project delete can enqueue either live-FK update first.  The deferred
  -- trigger must validate the row currently stored, not only the queued NEW
  -- image: by commit both SET NULL actions must have completed.
  IF TG_OP = 'UPDATE'
     AND (
       (OLD."jobId" IS NOT NULL AND NEW."jobId" IS NULL)
       OR (OLD."webAiGrantId" IS NOT NULL AND NEW."webAiGrantId" IS NULL)
     )
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
  THEN
    -- OLD/NEW equality covers the queued FK event; comparing the final row to
    -- OLD below also rejects a second mutation of any frozen evidence field.
    SELECT * INTO audit_final
      FROM "ProviderCallAudit"
     WHERE "id" = NEW."id";
    IF FOUND
       AND audit_final."jobId" IS NULL
       AND audit_final."webAiGrantId" IS NULL
       AND audit_final."webAiGrantReferenceId" IS NOT NULL
       AND audit_final."webAiGrantProjectId" IS NOT NULL
       AND audit_final."personalDelegationId" IS NOT NULL
       AND audit_final."providerConnectionId" IS NOT DISTINCT FROM OLD."providerConnectionId"
       AND audit_final."operation" IS NOT DISTINCT FROM OLD."operation"
       AND audit_final."modelId" IS NOT DISTINCT FROM OLD."modelId"
       AND audit_final."billingMode" IS NOT DISTINCT FROM OLD."billingMode"
       AND audit_final."billingUserId" IS NOT DISTINCT FROM OLD."billingUserId"
       AND audit_final."callKey" IS NOT DISTINCT FROM OLD."callKey"
       AND audit_final."reservationId" IS NOT DISTINCT FROM OLD."reservationId"
       AND audit_final."routeSource" IS NOT DISTINCT FROM OLD."routeSource"
       AND audit_final."routeId" IS NOT DISTINCT FROM OLD."routeId"
       AND audit_final."routeVersion" IS NOT DISTINCT FROM OLD."routeVersion"
       AND audit_final."routeUpdatedAt" IS NOT DISTINCT FROM OLD."routeUpdatedAt"
       AND audit_final."providerConfigurationVersion" IS NOT DISTINCT FROM OLD."providerConfigurationVersion"
       AND audit_final."quotaMultiplierBps" IS NOT DISTINCT FROM OLD."quotaMultiplierBps"
       AND audit_final."routeFenceFingerprint" IS NOT DISTINCT FROM OLD."routeFenceFingerprint"
       AND audit_final."credentialSecretFingerprint" IS NOT DISTINCT FROM OLD."credentialSecretFingerprint"
       AND audit_final."personalDelegationId" IS NOT DISTINCT FROM OLD."personalDelegationId"
       AND audit_final."personalDelegationVersion" IS NOT DISTINCT FROM OLD."personalDelegationVersion"
       AND audit_final."personalDelegationFingerprint" IS NOT DISTINCT FROM OLD."personalDelegationFingerprint"
       AND audit_final."effectiveRouteSelectionId" IS NOT DISTINCT FROM OLD."effectiveRouteSelectionId"
       AND audit_final."effectiveRouteSelectionVersion" IS NOT DISTINCT FROM OLD."effectiveRouteSelectionVersion"
       AND audit_final."effectiveRouteSelectionUpdatedAt" IS NOT DISTINCT FROM OLD."effectiveRouteSelectionUpdatedAt"
       AND audit_final."payerKind" IS NOT DISTINCT FROM OLD."payerKind"
       AND audit_final."payerProviderConnectionId" IS NOT DISTINCT FROM OLD."payerProviderConnectionId"
       AND audit_final."ownerProjectMembershipId" IS NOT DISTINCT FROM OLD."ownerProjectMembershipId"
       AND audit_final."ownerMembershipCreatedAt" IS NOT DISTINCT FROM OLD."ownerMembershipCreatedAt"
       AND audit_final."ownerSubscriptionId" IS NOT DISTINCT FROM OLD."ownerSubscriptionId"
       AND audit_final."ownerSubscriptionVersion" IS NOT DISTINCT FROM OLD."ownerSubscriptionVersion"
       AND audit_final."ownerSubscriptionStartsAt" IS NOT DISTINCT FROM OLD."ownerSubscriptionStartsAt"
       AND audit_final."ownerSubscriptionExpiresAt" IS NOT DISTINCT FROM OLD."ownerSubscriptionExpiresAt"
       AND audit_final."connectionOwnerAccountAccessVersion" IS NOT DISTINCT FROM OLD."connectionOwnerAccountAccessVersion"
       AND audit_final."projectConfirmedById" IS NOT DISTINCT FROM OLD."projectConfirmedById"
       AND audit_final."projectConfirmedProjectMembershipId" IS NOT DISTINCT FROM OLD."projectConfirmedProjectMembershipId"
       AND audit_final."projectConfirmedMembershipCreatedAt" IS NOT DISTINCT FROM OLD."projectConfirmedMembershipCreatedAt"
       AND audit_final."selectedById" IS NOT DISTINCT FROM OLD."selectedById"
       AND audit_final."selectedByProjectMembershipId" IS NOT DISTINCT FROM OLD."selectedByProjectMembershipId"
       AND audit_final."selectedByMembershipCreatedAt" IS NOT DISTINCT FROM OLD."selectedByMembershipCreatedAt"
       AND audit_final."embeddingDimensions" IS NOT DISTINCT FROM OLD."embeddingDimensions"
       AND audit_final."maxOutputTokens" IS NOT DISTINCT FROM OLD."maxOutputTokens"
       AND audit_final."webAiGrantReferenceId" IS NOT DISTINCT FROM OLD."webAiGrantReferenceId"
       AND audit_final."webAiGrantProjectId" IS NOT DISTINCT FROM OLD."webAiGrantProjectId"
       AND NOT EXISTS (SELECT 1 FROM "WebAiGrant" WHERE "id" = audit_final."webAiGrantReferenceId")
       AND NOT EXISTS (SELECT 1 FROM "Project" WHERE "id" = audit_final."webAiGrantProjectId")
       AND NOT EXISTS (SELECT 1 FROM "ProjectAiProviderDelegation" WHERE "id" = audit_final."personalDelegationId")
       AND EXISTS (
         SELECT 1 FROM "ProjectDeletionReceipt" receipt
          WHERE receipt."deletedProjectId" = audit_final."webAiGrantProjectId"
            AND receipt."status" IN ('database_deleted', 'completed', 'cleanup_failed')
       )
    THEN
      RETURN NEW;
    END IF;
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
