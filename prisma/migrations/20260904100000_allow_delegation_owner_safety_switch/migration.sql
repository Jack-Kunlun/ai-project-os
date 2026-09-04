-- WP05B2 safety switch: an explicit connection owner may revoke their own
-- selected personal delegation and move that operation to the platform
-- default in the same transaction.  The 0900 guard remains the authority for
-- ordinary selection writes; this forward replacement adds only the narrow,
-- auditable editor-owner exception.
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
          AND project_row."archivedAt" IS NULL
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
