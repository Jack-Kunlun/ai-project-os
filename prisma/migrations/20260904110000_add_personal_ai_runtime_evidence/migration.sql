-- Add versioned runtime payer and route evidence for platform and personal
-- control-plane records. Personal evidence is validated but remains excluded
-- from provider transport until a later runtime admission change.

CREATE TYPE "AiRuntimePayerKind" AS ENUM (
  'platform_caller',
  'personal_connection_owner'
);

ALTER TABLE "WebAiGrant"
  ADD COLUMN "personalDelegationId" UUID,
  ADD COLUMN "personalDelegationVersion" INTEGER,
  ADD COLUMN "personalDelegationFingerprint" CHAR(64),
  ADD COLUMN "effectiveRouteSelectionId" UUID,
  ADD COLUMN "effectiveRouteSelectionVersion" INTEGER,
  ADD COLUMN "effectiveRouteSelectionUpdatedAt" TIMESTAMP(3),
  ADD COLUMN "payerKind" "AiRuntimePayerKind",
  ADD COLUMN "payerProviderConnectionId" UUID,
  ADD COLUMN "ownerProjectMembershipId" UUID,
  ADD COLUMN "ownerMembershipCreatedAt" TIMESTAMP(3),
  ADD COLUMN "ownerSubscriptionId" UUID,
  ADD COLUMN "ownerSubscriptionVersion" INTEGER,
  ADD COLUMN "ownerSubscriptionStartsAt" TIMESTAMP(3),
  ADD COLUMN "ownerSubscriptionExpiresAt" TIMESTAMP(3),
  ADD COLUMN "projectConfirmedById" UUID,
  ADD COLUMN "projectConfirmedProjectMembershipId" UUID,
  ADD COLUMN "projectConfirmedMembershipCreatedAt" TIMESTAMP(3),
  ADD COLUMN "selectedById" UUID,
  ADD COLUMN "selectedByProjectMembershipId" UUID,
  ADD COLUMN "selectedByMembershipCreatedAt" TIMESTAMP(3),
  ADD COLUMN "credentialSecretFingerprint" CHAR(64),
  ADD COLUMN "embeddingDimensions" INTEGER,
  ADD COLUMN "maxOutputTokens" INTEGER;

ALTER TABLE "ProviderCallAudit"
  ADD COLUMN "personalDelegationId" UUID,
  ADD COLUMN "personalDelegationVersion" INTEGER,
  ADD COLUMN "personalDelegationFingerprint" CHAR(64),
  ADD COLUMN "effectiveRouteSelectionId" UUID,
  ADD COLUMN "effectiveRouteSelectionVersion" INTEGER,
  ADD COLUMN "effectiveRouteSelectionUpdatedAt" TIMESTAMP(3),
  ADD COLUMN "payerKind" "AiRuntimePayerKind",
  ADD COLUMN "payerProviderConnectionId" UUID,
  ADD COLUMN "ownerProjectMembershipId" UUID,
  ADD COLUMN "ownerMembershipCreatedAt" TIMESTAMP(3),
  ADD COLUMN "ownerSubscriptionId" UUID,
  ADD COLUMN "ownerSubscriptionVersion" INTEGER,
  ADD COLUMN "ownerSubscriptionStartsAt" TIMESTAMP(3),
  ADD COLUMN "ownerSubscriptionExpiresAt" TIMESTAMP(3),
  ADD COLUMN "projectConfirmedById" UUID,
  ADD COLUMN "projectConfirmedProjectMembershipId" UUID,
  ADD COLUMN "projectConfirmedMembershipCreatedAt" TIMESTAMP(3),
  ADD COLUMN "selectedById" UUID,
  ADD COLUMN "selectedByProjectMembershipId" UUID,
  ADD COLUMN "selectedByMembershipCreatedAt" TIMESTAMP(3),
  ADD COLUMN "embeddingDimensions" INTEGER,
  ADD COLUMN "maxOutputTokens" INTEGER;

ALTER TABLE "MemoryIndexGeneration"
  ADD COLUMN "embeddingWebAiGrantId" UUID;

-- Do not backfill runtime payer, route-dimension, max-output, or credential
-- evidence introduced by this migration.  Historical rows keep their exact
-- pre-1100 shape; only new INSERTs are required to carry the complete shape
-- below.  In particular, no current provider/credential state is substituted
-- for historical evidence.

ALTER TABLE "WebAiGrant"
  DROP CONSTRAINT "WebAiGrant_route_snapshot_check",
  DROP CONSTRAINT "WebAiGrant_runtime_binding_check";

ALTER TABLE "ProviderCallAudit"
  DROP CONSTRAINT "ProviderCallAudit_runtime_binding_check";

ALTER TABLE "WebAiGrant"
  ADD CONSTRAINT "WebAiGrant_route_snapshot_check" CHECK (
    (
      "routeSource" IS NULL AND "routeId" IS NULL AND "routeVersion" IS NULL
      AND "routeUpdatedAt" IS NULL AND "providerConfigurationVersion" IS NULL
      AND "quotaMultiplierBps" IS NULL AND "routeFenceFingerprint" IS NULL
      AND "boundJobId" IS NULL
      AND "personalDelegationId" IS NULL AND "personalDelegationVersion" IS NULL
      AND "personalDelegationFingerprint" IS NULL
      AND "effectiveRouteSelectionId" IS NULL AND "effectiveRouteSelectionVersion" IS NULL
      AND "effectiveRouteSelectionUpdatedAt" IS NULL
      AND "payerKind" IS NULL AND "payerProviderConnectionId" IS NULL
      AND "ownerProjectMembershipId" IS NULL AND "ownerMembershipCreatedAt" IS NULL
      AND "ownerSubscriptionId" IS NULL AND "ownerSubscriptionVersion" IS NULL
      AND "ownerSubscriptionStartsAt" IS NULL AND "ownerSubscriptionExpiresAt" IS NULL
      AND "projectConfirmedById" IS NULL AND "projectConfirmedProjectMembershipId" IS NULL
      AND "projectConfirmedMembershipCreatedAt" IS NULL
      AND "selectedById" IS NULL AND "selectedByProjectMembershipId" IS NULL
      AND "selectedByMembershipCreatedAt" IS NULL
      AND "credentialSecretFingerprint" IS NULL
      AND "embeddingDimensions" IS NULL AND "maxOutputTokens" IS NULL
    )
    OR (
      -- Historical platform grants are kept byte-for-byte.  These rows were
      -- admitted before 1100 and therefore have no payer/fingerprint or
      -- operation-specific runtime scalar evidence to reconstruct.
      "routeSource" IN ('project_override', 'platform_default')
      AND "boundJobId" IS NOT NULL
      AND "billingMode" = 'platform'
      AND "payerKind" IS NULL AND "payerProviderConnectionId" IS NULL
      AND "personalDelegationId" IS NULL AND "personalDelegationVersion" IS NULL
      AND "personalDelegationFingerprint" IS NULL
      AND "effectiveRouteSelectionId" IS NULL AND "effectiveRouteSelectionVersion" IS NULL
      AND "effectiveRouteSelectionUpdatedAt" IS NULL
      AND "ownerProjectMembershipId" IS NULL AND "ownerMembershipCreatedAt" IS NULL
      AND "ownerSubscriptionId" IS NULL AND "ownerSubscriptionVersion" IS NULL
      AND "ownerSubscriptionStartsAt" IS NULL AND "ownerSubscriptionExpiresAt" IS NULL
      AND "projectConfirmedById" IS NULL AND "projectConfirmedProjectMembershipId" IS NULL
      AND "projectConfirmedMembershipCreatedAt" IS NULL
      AND "selectedById" IS NULL AND "selectedByProjectMembershipId" IS NULL
      AND "selectedByMembershipCreatedAt" IS NULL
      AND "credentialSecretFingerprint" IS NULL
      AND "embeddingDimensions" IS NULL AND "maxOutputTokens" IS NULL
      AND "routeUpdatedAt" IS NOT NULL
      AND "providerConfigurationVersion" IS NOT NULL
      AND "providerConfigurationVersion" > 0
      AND "quotaMultiplierBps" BETWEEN 1 AND 100000
      AND "routeFenceFingerprint" ~ '^[0-9a-f]{64}$'
      AND (
        ("routeSource" = 'platform_default' AND "routeId" IS NOT NULL AND "routeVersion" IS NOT NULL AND "routeVersion" > 0)
        OR ("routeSource" = 'project_override' AND "routeId" IS NULL AND "routeVersion" IS NULL)
      )
    )
    OR (
      "routeSource" IN ('project_override', 'platform_default')
      AND "boundJobId" IS NOT NULL
      AND "billingMode" = 'platform'
      AND "payerKind" = 'platform_caller'
      AND "payerProviderConnectionId" = "providerConnectionId"
      AND "personalDelegationId" IS NULL AND "personalDelegationVersion" IS NULL
      AND "personalDelegationFingerprint" IS NULL
      AND "effectiveRouteSelectionId" IS NULL AND "effectiveRouteSelectionVersion" IS NULL
      AND "effectiveRouteSelectionUpdatedAt" IS NULL
      AND "ownerProjectMembershipId" IS NULL AND "ownerMembershipCreatedAt" IS NULL
      AND "ownerSubscriptionId" IS NULL AND "ownerSubscriptionVersion" IS NULL
      AND "ownerSubscriptionStartsAt" IS NULL AND "ownerSubscriptionExpiresAt" IS NULL
      AND "projectConfirmedById" IS NULL AND "projectConfirmedProjectMembershipId" IS NULL
      AND "projectConfirmedMembershipCreatedAt" IS NULL
      AND "selectedById" IS NULL AND "selectedByProjectMembershipId" IS NULL
      AND "selectedByMembershipCreatedAt" IS NULL
      AND "credentialSecretFingerprint" ~ '^[0-9a-f]{64}$'
      AND (
        ("operation" = 'embedding' AND "embeddingDimensions" BETWEEN 8 AND 8192 AND "maxOutputTokens" BETWEEN 1 AND 65536)
        OR ("operation" <> 'embedding' AND "embeddingDimensions" IS NULL AND "maxOutputTokens" BETWEEN 1 AND 65536)
      )
      AND "routeUpdatedAt" IS NOT NULL
      AND "providerConfigurationVersion" IS NOT NULL
      AND "providerConfigurationVersion" > 0
      AND "quotaMultiplierBps" BETWEEN 1 AND 100000
      AND "routeFenceFingerprint" ~ '^[0-9a-f]{64}$'
      AND (
        ("routeSource" = 'platform_default' AND "routeId" IS NOT NULL AND "routeVersion" IS NOT NULL AND "routeVersion" > 0)
        OR ("routeSource" = 'project_override' AND "routeId" IS NULL AND "routeVersion" IS NULL)
      )
    )
    OR (
      "routeSource" = 'personal_delegation'
      AND "boundJobId" IS NOT NULL
      AND "billingMode" = 'byok'
      AND "routeId" IS NOT NULL AND "routeVersion" IS NOT NULL AND "routeVersion" > 0
      AND "routeUpdatedAt" IS NOT NULL
      AND "providerConfigurationVersion" > 0
      AND "quotaMultiplierBps" = 10000
      AND "routeFenceFingerprint" ~ '^[0-9a-f]{64}$'
      AND "personalDelegationId" IS NOT NULL AND "personalDelegationVersion" > 0
      AND "personalDelegationFingerprint" ~ '^[0-9a-f]{64}$'
      AND "effectiveRouteSelectionId" IS NOT NULL AND "effectiveRouteSelectionVersion" > 0
      AND "effectiveRouteSelectionUpdatedAt" IS NOT NULL
      AND "payerKind" = 'personal_connection_owner'
      AND "payerProviderConnectionId" = "providerConnectionId"
      AND "ownerProjectMembershipId" IS NOT NULL AND "ownerMembershipCreatedAt" IS NOT NULL
      AND "ownerSubscriptionId" IS NOT NULL AND "ownerSubscriptionVersion" > 0
      AND "ownerSubscriptionStartsAt" IS NOT NULL AND "ownerSubscriptionExpiresAt" IS NOT NULL
      AND "projectConfirmedById" IS NOT NULL AND "projectConfirmedProjectMembershipId" IS NOT NULL
      AND "projectConfirmedMembershipCreatedAt" IS NOT NULL
      AND "selectedById" IS NOT NULL AND "selectedByProjectMembershipId" IS NOT NULL
      AND "selectedByMembershipCreatedAt" IS NOT NULL
      AND "credentialSecretFingerprint" ~ '^[0-9a-f]{64}$'
      AND (
        ("operation" = 'embedding' AND "embeddingDimensions" BETWEEN 8 AND 8192 AND "maxOutputTokens" IS NULL)
        OR ("operation" <> 'embedding' AND "embeddingDimensions" IS NULL AND "maxOutputTokens" BETWEEN 1 AND 65536)
      )
    )
    OR (
      -- Pre-1100 route-bound grants may carry the old legacy/BYOK billing
      -- mode. Preserve them as read-only compatibility rows: the new payer,
      -- fingerprint and personal evidence columns must stay NULL, while the
      -- pre-existing route tuple remains exactly as it was.
      "routeSource" IN ('project_override', 'platform_default')
      AND "boundJobId" IS NOT NULL
      AND "billingMode" IN ('legacy', 'byok')
      AND "personalDelegationId" IS NULL AND "personalDelegationVersion" IS NULL
      AND "personalDelegationFingerprint" IS NULL
      AND "effectiveRouteSelectionId" IS NULL AND "effectiveRouteSelectionVersion" IS NULL
      AND "effectiveRouteSelectionUpdatedAt" IS NULL
      AND "payerKind" IS NULL AND "payerProviderConnectionId" IS NULL
      AND "ownerProjectMembershipId" IS NULL AND "ownerMembershipCreatedAt" IS NULL
      AND "ownerSubscriptionId" IS NULL AND "ownerSubscriptionVersion" IS NULL
      AND "ownerSubscriptionStartsAt" IS NULL AND "ownerSubscriptionExpiresAt" IS NULL
      AND "projectConfirmedById" IS NULL AND "projectConfirmedProjectMembershipId" IS NULL
      AND "projectConfirmedMembershipCreatedAt" IS NULL
      AND "selectedById" IS NULL AND "selectedByProjectMembershipId" IS NULL
      AND "selectedByMembershipCreatedAt" IS NULL
      AND "credentialSecretFingerprint" IS NULL
      AND "embeddingDimensions" IS NULL AND "maxOutputTokens" IS NULL
      AND "routeUpdatedAt" IS NOT NULL
      AND "providerConfigurationVersion" IS NOT NULL
      AND "providerConfigurationVersion" > 0
      AND "quotaMultiplierBps" BETWEEN 1 AND 100000
      AND "routeFenceFingerprint" ~ '^[0-9a-f]{64}$'
      AND (
        ("routeSource" = 'platform_default' AND "routeId" IS NOT NULL AND "routeVersion" IS NOT NULL AND "routeVersion" > 0)
        OR ("routeSource" = 'project_override' AND "routeId" IS NULL AND "routeVersion" IS NULL)
      )
    )
  );

ALTER TABLE "WebAiGrant"
  ADD CONSTRAINT "WebAiGrant_runtime_binding_check" CHECK (
    ("routeSource" IS NULL AND "boundJobId" IS NULL)
    OR ("routeSource" IS NOT NULL AND "boundJobId" IS NOT NULL)
  );

ALTER TABLE "ProviderCallAudit"
  ADD CONSTRAINT "ProviderCallAudit_runtime_binding_check" CHECK (
    (
      "webAiGrantId" IS NULL AND "routeSource" IS NULL AND "routeId" IS NULL
      AND "routeVersion" IS NULL AND "routeUpdatedAt" IS NULL
      AND "providerConfigurationVersion" IS NULL AND "quotaMultiplierBps" IS NULL
      AND "routeFenceFingerprint" IS NULL AND "webAiGrantReferenceId" IS NULL
      AND "webAiGrantProjectId" IS NULL AND "credentialSecretFingerprint" IS NULL
      AND "personalDelegationId" IS NULL AND "personalDelegationVersion" IS NULL
      AND "personalDelegationFingerprint" IS NULL
      AND "effectiveRouteSelectionId" IS NULL AND "effectiveRouteSelectionVersion" IS NULL
      AND "effectiveRouteSelectionUpdatedAt" IS NULL
      AND "payerKind" IS NULL AND "payerProviderConnectionId" IS NULL
      AND "ownerProjectMembershipId" IS NULL AND "ownerMembershipCreatedAt" IS NULL
      AND "ownerSubscriptionId" IS NULL AND "ownerSubscriptionVersion" IS NULL
      AND "ownerSubscriptionStartsAt" IS NULL AND "ownerSubscriptionExpiresAt" IS NULL
      AND "projectConfirmedById" IS NULL AND "projectConfirmedProjectMembershipId" IS NULL
      AND "projectConfirmedMembershipCreatedAt" IS NULL
      AND "selectedById" IS NULL AND "selectedByProjectMembershipId" IS NULL
      AND "selectedByMembershipCreatedAt" IS NULL
      AND "embeddingDimensions" IS NULL AND "maxOutputTokens" IS NULL
    )
    OR (
      -- Historical platform audits were created before 1100.  Their
      -- credentialSecretFingerprint belongs to the 0700 snapshot, but all
      -- 1100-only payer/selection/dimension evidence is intentionally NULL.
      -- Keep that shape readable and terminalizable without reconstructing
      -- facts from today's provider configuration.
      "routeSource" IN ('project_override', 'platform_default')
      AND "webAiGrantReferenceId" IS NOT NULL AND "webAiGrantProjectId" IS NOT NULL
      AND "routeUpdatedAt" IS NOT NULL AND "providerConfigurationVersion" > 0
      AND "quotaMultiplierBps" BETWEEN 1 AND 100000
      AND "routeFenceFingerprint" ~ '^[0-9a-f]{64}$'
      AND "credentialSecretFingerprint" IS NOT NULL
      AND "credentialSecretFingerprint" ~ '^[0-9a-f]{64}$'
      AND "billingMode" = 'platform'
      AND "payerKind" IS NULL AND "payerProviderConnectionId" IS NULL
      AND "personalDelegationId" IS NULL AND "personalDelegationVersion" IS NULL
      AND "personalDelegationFingerprint" IS NULL
      AND "effectiveRouteSelectionId" IS NULL AND "effectiveRouteSelectionVersion" IS NULL
      AND "effectiveRouteSelectionUpdatedAt" IS NULL
      AND "ownerProjectMembershipId" IS NULL AND "ownerMembershipCreatedAt" IS NULL
      AND "ownerSubscriptionId" IS NULL AND "ownerSubscriptionVersion" IS NULL
      AND "ownerSubscriptionStartsAt" IS NULL AND "ownerSubscriptionExpiresAt" IS NULL
      AND "projectConfirmedById" IS NULL AND "projectConfirmedProjectMembershipId" IS NULL
      AND "projectConfirmedMembershipCreatedAt" IS NULL
      AND "selectedById" IS NULL AND "selectedByProjectMembershipId" IS NULL
      AND "selectedByMembershipCreatedAt" IS NULL
      AND "embeddingDimensions" IS NULL AND "maxOutputTokens" IS NULL
      AND (
        ("routeSource" = 'platform_default' AND "routeId" IS NOT NULL AND "routeVersion" IS NOT NULL AND "routeVersion" > 0)
        OR ("routeSource" = 'project_override' AND "routeId" IS NULL AND "routeVersion" IS NULL)
      )
    )
    OR (
      "routeSource" IN ('project_override', 'platform_default')
      AND "webAiGrantReferenceId" IS NOT NULL AND "webAiGrantProjectId" IS NOT NULL
      AND "routeUpdatedAt" IS NOT NULL AND "providerConfigurationVersion" > 0
      AND "quotaMultiplierBps" BETWEEN 1 AND 100000
      AND "routeFenceFingerprint" ~ '^[0-9a-f]{64}$'
      AND "credentialSecretFingerprint" ~ '^[0-9a-f]{64}$'
      AND "billingMode" = 'platform'
      AND "payerKind" = 'platform_caller'
      AND "payerProviderConnectionId" = "providerConnectionId"
      AND "personalDelegationId" IS NULL AND "personalDelegationVersion" IS NULL
      AND "personalDelegationFingerprint" IS NULL
      AND "effectiveRouteSelectionId" IS NULL AND "effectiveRouteSelectionVersion" IS NULL
      AND "effectiveRouteSelectionUpdatedAt" IS NULL
      AND "ownerProjectMembershipId" IS NULL AND "ownerMembershipCreatedAt" IS NULL
      AND "ownerSubscriptionId" IS NULL AND "ownerSubscriptionVersion" IS NULL
      AND "ownerSubscriptionStartsAt" IS NULL AND "ownerSubscriptionExpiresAt" IS NULL
      AND "projectConfirmedById" IS NULL AND "projectConfirmedProjectMembershipId" IS NULL
      AND "projectConfirmedMembershipCreatedAt" IS NULL
      AND "selectedById" IS NULL AND "selectedByProjectMembershipId" IS NULL
      AND "selectedByMembershipCreatedAt" IS NULL
      AND (
        ("operation" = 'embedding' AND "embeddingDimensions" BETWEEN 8 AND 8192 AND "maxOutputTokens" BETWEEN 1 AND 65536)
        OR ("operation" <> 'embedding' AND "embeddingDimensions" IS NULL AND "maxOutputTokens" BETWEEN 1 AND 65536)
      )
      AND (
        ("routeSource" = 'platform_default' AND "routeId" IS NOT NULL AND "routeVersion" IS NOT NULL AND "routeVersion" > 0)
        OR ("routeSource" = 'project_override' AND "routeId" IS NULL AND "routeVersion" IS NULL)
      )
    )
    OR (
      "routeSource" = 'personal_delegation'
      AND "webAiGrantReferenceId" IS NOT NULL AND "webAiGrantProjectId" IS NOT NULL
      AND "routeId" IS NOT NULL AND "routeVersion" > 0 AND "routeUpdatedAt" IS NOT NULL
      AND "providerConfigurationVersion" > 0 AND "quotaMultiplierBps" = 10000
      AND "routeFenceFingerprint" ~ '^[0-9a-f]{64}$'
      AND "credentialSecretFingerprint" ~ '^[0-9a-f]{64}$'
      AND "reservationId" IS NULL
      AND "billingMode" = 'byok'
      AND "personalDelegationId" IS NOT NULL AND "personalDelegationVersion" > 0
      AND "personalDelegationFingerprint" ~ '^[0-9a-f]{64}$'
      AND "effectiveRouteSelectionId" IS NOT NULL AND "effectiveRouteSelectionVersion" > 0
      AND "effectiveRouteSelectionUpdatedAt" IS NOT NULL
      AND "payerKind" = 'personal_connection_owner'
      AND "payerProviderConnectionId" = "providerConnectionId"
      AND "ownerProjectMembershipId" IS NOT NULL AND "ownerMembershipCreatedAt" IS NOT NULL
      AND "ownerSubscriptionId" IS NOT NULL AND "ownerSubscriptionVersion" > 0
      AND "ownerSubscriptionStartsAt" IS NOT NULL AND "ownerSubscriptionExpiresAt" IS NOT NULL
      AND "projectConfirmedById" IS NOT NULL AND "projectConfirmedProjectMembershipId" IS NOT NULL
      AND "projectConfirmedMembershipCreatedAt" IS NOT NULL
      AND "selectedById" IS NOT NULL AND "selectedByProjectMembershipId" IS NOT NULL
      AND "selectedByMembershipCreatedAt" IS NOT NULL
      AND (
        ("operation" = 'embedding' AND "embeddingDimensions" BETWEEN 8 AND 8192 AND "maxOutputTokens" IS NULL)
        OR ("operation" <> 'embedding' AND "embeddingDimensions" IS NULL AND "maxOutputTokens" BETWEEN 1 AND 65536)
      )
    )
  );

CREATE INDEX "WebAiGrant_personal_runtime_evidence_idx"
  ON "WebAiGrant"("projectId", "operation", "personalDelegationId", "effectiveRouteSelectionId");
CREATE INDEX "ProviderCallAudit_personal_runtime_evidence_idx"
  ON "ProviderCallAudit"("webAiGrantReferenceId", "personalDelegationId", "effectiveRouteSelectionId");
CREATE INDEX "MemoryIndexGeneration_embeddingWebAiGrantId_idx"
  ON "MemoryIndexGeneration"("embeddingWebAiGrantId");

-- Runtime grant and audit identity is immutable after issuance.  The only
-- nullable identity transitions retained from 0700 are FK SET NULL updates
-- caused by project deletion; all personal evidence remains in the row.
CREATE OR REPLACE FUNCTION "runtime_ai_grant_identity_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."id" IS DISTINCT FROM NEW."id"
     OR OLD."projectId" IS DISTINCT FROM NEW."projectId"
     OR OLD."operation" IS DISTINCT FROM NEW."operation"
     OR OLD."scopeKind" IS DISTINCT FROM NEW."scopeKind"
     OR OLD."scopeIds" IS DISTINCT FROM NEW."scopeIds"
     OR OLD."manifestFingerprint" IS DISTINCT FROM NEW."manifestFingerprint"
     OR OLD."providerConnectionId" IS DISTINCT FROM NEW."providerConnectionId"
     OR OLD."modelId" IS DISTINCT FROM NEW."modelId"
     OR OLD."consentVersion" IS DISTINCT FROM NEW."consentVersion"
     OR OLD."issuedById" IS DISTINCT FROM NEW."issuedById"
     OR OLD."billingMode" IS DISTINCT FROM NEW."billingMode"
     OR OLD."billingUserId" IS DISTINCT FROM NEW."billingUserId"
     OR OLD."callKey" IS DISTINCT FROM NEW."callKey"
     OR OLD."boundJobId" IS DISTINCT FROM NEW."boundJobId"
     OR OLD."routeSource" IS DISTINCT FROM NEW."routeSource"
     OR OLD."routeId" IS DISTINCT FROM NEW."routeId"
     OR OLD."routeVersion" IS DISTINCT FROM NEW."routeVersion"
     OR OLD."routeUpdatedAt" IS DISTINCT FROM NEW."routeUpdatedAt"
     OR OLD."providerConfigurationVersion" IS DISTINCT FROM NEW."providerConfigurationVersion"
     OR OLD."quotaMultiplierBps" IS DISTINCT FROM NEW."quotaMultiplierBps"
     OR OLD."routeFenceFingerprint" IS DISTINCT FROM NEW."routeFenceFingerprint"
     OR OLD."personalDelegationId" IS DISTINCT FROM NEW."personalDelegationId"
     OR OLD."personalDelegationVersion" IS DISTINCT FROM NEW."personalDelegationVersion"
     OR OLD."personalDelegationFingerprint" IS DISTINCT FROM NEW."personalDelegationFingerprint"
     OR OLD."effectiveRouteSelectionId" IS DISTINCT FROM NEW."effectiveRouteSelectionId"
     OR OLD."effectiveRouteSelectionVersion" IS DISTINCT FROM NEW."effectiveRouteSelectionVersion"
     OR OLD."effectiveRouteSelectionUpdatedAt" IS DISTINCT FROM NEW."effectiveRouteSelectionUpdatedAt"
     OR OLD."payerKind" IS DISTINCT FROM NEW."payerKind"
     OR OLD."payerProviderConnectionId" IS DISTINCT FROM NEW."payerProviderConnectionId"
     OR OLD."ownerProjectMembershipId" IS DISTINCT FROM NEW."ownerProjectMembershipId"
     OR OLD."ownerMembershipCreatedAt" IS DISTINCT FROM NEW."ownerMembershipCreatedAt"
     OR OLD."ownerSubscriptionId" IS DISTINCT FROM NEW."ownerSubscriptionId"
     OR OLD."ownerSubscriptionVersion" IS DISTINCT FROM NEW."ownerSubscriptionVersion"
     OR OLD."ownerSubscriptionStartsAt" IS DISTINCT FROM NEW."ownerSubscriptionStartsAt"
     OR OLD."ownerSubscriptionExpiresAt" IS DISTINCT FROM NEW."ownerSubscriptionExpiresAt"
     OR OLD."projectConfirmedById" IS DISTINCT FROM NEW."projectConfirmedById"
     OR OLD."projectConfirmedProjectMembershipId" IS DISTINCT FROM NEW."projectConfirmedProjectMembershipId"
     OR OLD."projectConfirmedMembershipCreatedAt" IS DISTINCT FROM NEW."projectConfirmedMembershipCreatedAt"
     OR OLD."selectedById" IS DISTINCT FROM NEW."selectedById"
     OR OLD."selectedByProjectMembershipId" IS DISTINCT FROM NEW."selectedByProjectMembershipId"
     OR OLD."selectedByMembershipCreatedAt" IS DISTINCT FROM NEW."selectedByMembershipCreatedAt"
     OR OLD."credentialSecretFingerprint" IS DISTINCT FROM NEW."credentialSecretFingerprint"
     OR OLD."embeddingDimensions" IS DISTINCT FROM NEW."embeddingDimensions"
     OR OLD."maxOutputTokens" IS DISTINCT FROM NEW."maxOutputTokens"
     OR OLD."issuedAt" IS DISTINCT FROM NEW."issuedAt"
     OR OLD."expiresAt" IS DISTINCT FROM NEW."expiresAt"
  THEN
    RAISE EXCEPTION 'runtime AI grant identity is immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "runtime_ai_evidence_identity_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_TABLE_NAME = 'PlatformTokenReservation' THEN
    IF OLD."id" IS DISTINCT FROM NEW."id"
       OR OLD."userId" IS DISTINCT FROM NEW."userId"
       OR OLD."grantId" IS DISTINCT FROM NEW."grantId"
       OR OLD."jobId" IS DISTINCT FROM NEW."jobId"
       OR OLD."providerConnectionId" IS DISTINCT FROM NEW."providerConnectionId"
       OR OLD."callKey" IS DISTINCT FROM NEW."callKey"
       OR OLD."operation" IS DISTINCT FROM NEW."operation"
       OR OLD."modelId" IS DISTINCT FROM NEW."modelId"
       OR OLD."reservedTokens" IS DISTINCT FROM NEW."reservedTokens"
       OR OLD."rawEstimatedTokens" IS DISTINCT FROM NEW."rawEstimatedTokens"
       OR OLD."quotaMultiplierBps" IS DISTINCT FROM NEW."quotaMultiplierBps"
       OR OLD."webAiGrantReferenceId" IS DISTINCT FROM NEW."webAiGrantReferenceId"
       OR OLD."webAiGrantProjectId" IS DISTINCT FROM NEW."webAiGrantProjectId"
       OR OLD."routeSource" IS DISTINCT FROM NEW."routeSource"
       OR OLD."routeId" IS DISTINCT FROM NEW."routeId"
       OR OLD."routeVersion" IS DISTINCT FROM NEW."routeVersion"
       OR OLD."routeUpdatedAt" IS DISTINCT FROM NEW."routeUpdatedAt"
       OR OLD."providerConfigurationVersion" IS DISTINCT FROM NEW."providerConfigurationVersion"
       OR OLD."routeFenceFingerprint" IS DISTINCT FROM NEW."routeFenceFingerprint"
       OR (OLD."webAiGrantId" IS DISTINCT FROM NEW."webAiGrantId"
           AND NOT (OLD."webAiGrantId" IS NOT NULL AND NEW."webAiGrantId" IS NULL))
    THEN
      RAISE EXCEPTION 'runtime reservation identity is immutable'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."id" IS DISTINCT FROM NEW."id"
     OR OLD."providerConnectionId" IS DISTINCT FROM NEW."providerConnectionId"
     OR OLD."operation" IS DISTINCT FROM NEW."operation"
     OR OLD."modelId" IS DISTINCT FROM NEW."modelId"
     OR OLD."billingMode" IS DISTINCT FROM NEW."billingMode"
     OR OLD."billingUserId" IS DISTINCT FROM NEW."billingUserId"
     OR OLD."callKey" IS DISTINCT FROM NEW."callKey"
     OR OLD."reservationId" IS DISTINCT FROM NEW."reservationId"
     OR OLD."webAiGrantReferenceId" IS DISTINCT FROM NEW."webAiGrantReferenceId"
     OR OLD."webAiGrantProjectId" IS DISTINCT FROM NEW."webAiGrantProjectId"
     OR OLD."routeSource" IS DISTINCT FROM NEW."routeSource"
     OR OLD."routeId" IS DISTINCT FROM NEW."routeId"
     OR OLD."routeVersion" IS DISTINCT FROM NEW."routeVersion"
     OR OLD."routeUpdatedAt" IS DISTINCT FROM NEW."routeUpdatedAt"
     OR OLD."providerConfigurationVersion" IS DISTINCT FROM NEW."providerConfigurationVersion"
     OR OLD."quotaMultiplierBps" IS DISTINCT FROM NEW."quotaMultiplierBps"
     OR OLD."routeFenceFingerprint" IS DISTINCT FROM NEW."routeFenceFingerprint"
     OR OLD."credentialSecretFingerprint" IS DISTINCT FROM NEW."credentialSecretFingerprint"
     OR OLD."personalDelegationId" IS DISTINCT FROM NEW."personalDelegationId"
     OR OLD."personalDelegationVersion" IS DISTINCT FROM NEW."personalDelegationVersion"
     OR OLD."personalDelegationFingerprint" IS DISTINCT FROM NEW."personalDelegationFingerprint"
     OR OLD."effectiveRouteSelectionId" IS DISTINCT FROM NEW."effectiveRouteSelectionId"
     OR OLD."effectiveRouteSelectionVersion" IS DISTINCT FROM NEW."effectiveRouteSelectionVersion"
     OR OLD."effectiveRouteSelectionUpdatedAt" IS DISTINCT FROM NEW."effectiveRouteSelectionUpdatedAt"
     OR OLD."payerKind" IS DISTINCT FROM NEW."payerKind"
     OR OLD."payerProviderConnectionId" IS DISTINCT FROM NEW."payerProviderConnectionId"
     OR OLD."ownerProjectMembershipId" IS DISTINCT FROM NEW."ownerProjectMembershipId"
     OR OLD."ownerMembershipCreatedAt" IS DISTINCT FROM NEW."ownerMembershipCreatedAt"
     OR OLD."ownerSubscriptionId" IS DISTINCT FROM NEW."ownerSubscriptionId"
     OR OLD."ownerSubscriptionVersion" IS DISTINCT FROM NEW."ownerSubscriptionVersion"
     OR OLD."ownerSubscriptionStartsAt" IS DISTINCT FROM NEW."ownerSubscriptionStartsAt"
     OR OLD."ownerSubscriptionExpiresAt" IS DISTINCT FROM NEW."ownerSubscriptionExpiresAt"
     OR OLD."projectConfirmedById" IS DISTINCT FROM NEW."projectConfirmedById"
     OR OLD."projectConfirmedProjectMembershipId" IS DISTINCT FROM NEW."projectConfirmedProjectMembershipId"
     OR OLD."projectConfirmedMembershipCreatedAt" IS DISTINCT FROM NEW."projectConfirmedMembershipCreatedAt"
     OR OLD."selectedById" IS DISTINCT FROM NEW."selectedById"
     OR OLD."selectedByProjectMembershipId" IS DISTINCT FROM NEW."selectedByProjectMembershipId"
     OR OLD."selectedByMembershipCreatedAt" IS DISTINCT FROM NEW."selectedByMembershipCreatedAt"
     OR OLD."embeddingDimensions" IS DISTINCT FROM NEW."embeddingDimensions"
     OR OLD."maxOutputTokens" IS DISTINCT FROM NEW."maxOutputTokens"
     OR (OLD."webAiGrantId" IS DISTINCT FROM NEW."webAiGrantId"
         AND NOT (OLD."webAiGrantId" IS NOT NULL AND NEW."webAiGrantId" IS NULL))
     OR (OLD."jobId" IS DISTINCT FROM NEW."jobId"
         AND NOT (OLD."jobId" IS NOT NULL AND NEW."jobId" IS NULL))
  THEN
    RAISE EXCEPTION 'provider-call audit identity is immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- Historical route-bound grants/audits may predate the non-secret credential
-- fence. They remain readable, but every new route-bound platform evidence row
-- must carry the platform payer shape and a current credential fingerprint.
CREATE OR REPLACE FUNCTION "runtime_ai_new_platform_fingerprint_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_TABLE_NAME = 'WebAiGrant' THEN
    IF NEW."routeSource" IN ('project_override', 'platform_default')
       AND (
         NEW."billingMode" IS DISTINCT FROM 'platform'
         OR NEW."payerKind" IS DISTINCT FROM 'platform_caller'
         OR NEW."payerProviderConnectionId" IS DISTINCT FROM NEW."providerConnectionId"
         OR NEW."credentialSecretFingerprint" IS NULL
         OR NEW."credentialSecretFingerprint" !~ '^[0-9a-f]{64}$'
         OR NEW."personalDelegationId" IS NOT NULL
         OR NEW."effectiveRouteSelectionId" IS NOT NULL
         OR NEW."ownerProjectMembershipId" IS NOT NULL
         OR NEW."ownerSubscriptionId" IS NOT NULL
         OR NEW."projectConfirmedById" IS NOT NULL
         OR NEW."selectedById" IS NOT NULL
         OR (NEW."operation" = 'embedding' AND (NEW."embeddingDimensions" IS NULL OR NEW."embeddingDimensions" < 8 OR NEW."embeddingDimensions" > 8192 OR NEW."maxOutputTokens" IS NULL OR NEW."maxOutputTokens" < 1 OR NEW."maxOutputTokens" > 65536))
         OR (NEW."operation" <> 'embedding' AND (NEW."embeddingDimensions" IS NOT NULL OR NEW."maxOutputTokens" IS NULL OR NEW."maxOutputTokens" < 1 OR NEW."maxOutputTokens" > 65536))
       )
    THEN
      RAISE EXCEPTION 'new platform grant requires credential fingerprint evidence'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."routeSource" IN ('project_override', 'platform_default')
     AND (
       NEW."billingMode" IS DISTINCT FROM 'platform'
       OR NEW."payerKind" IS DISTINCT FROM 'platform_caller'
       OR NEW."payerProviderConnectionId" IS DISTINCT FROM NEW."providerConnectionId"
       OR NEW."credentialSecretFingerprint" IS NULL
       OR NEW."credentialSecretFingerprint" !~ '^[0-9a-f]{64}$'
       OR NEW."personalDelegationId" IS NOT NULL
       OR NEW."effectiveRouteSelectionId" IS NOT NULL
       OR NEW."ownerProjectMembershipId" IS NOT NULL
       OR NEW."ownerSubscriptionId" IS NOT NULL
       OR NEW."projectConfirmedById" IS NOT NULL
       OR NEW."selectedById" IS NOT NULL
       OR (NEW."operation" = 'embedding' AND (NEW."embeddingDimensions" IS NULL OR NEW."embeddingDimensions" < 8 OR NEW."embeddingDimensions" > 8192 OR NEW."maxOutputTokens" IS NULL OR NEW."maxOutputTokens" < 1 OR NEW."maxOutputTokens" > 65536))
       OR (NEW."operation" <> 'embedding' AND (NEW."embeddingDimensions" IS NOT NULL OR NEW."maxOutputTokens" IS NULL OR NEW."maxOutputTokens" < 1 OR NEW."maxOutputTokens" > 65536))
     )
  THEN
    RAISE EXCEPTION 'new platform audit requires credential fingerprint evidence'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- Keep the 0700 platform relation guard intact, but make the personal route a
-- distinct branch.  The old guard must not reject a personal audit merely
-- because personal evidence intentionally has no platform reservation.
CREATE OR REPLACE FUNCTION "runtime_ai_evidence_consistency_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  grant_row RECORD;
  token_grant_row RECORD;
  job_row RECORD;
  reservation_row RECORD;
  provider_row RECORD;
  credential_row RECORD;
  historical_platform boolean;
  reservation_final "PlatformTokenReservation"%ROWTYPE;
  audit_final "ProviderCallAudit"%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME = 'PlatformTokenReservation' THEN
    SELECT * INTO reservation_final FROM "PlatformTokenReservation" WHERE "id" = NEW."id";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'runtime reservation evidence row is missing' USING ERRCODE = 'check_violation';
    END IF;
    IF reservation_final."routeSource" IS NULL THEN RETURN NEW; END IF;
    IF reservation_final."webAiGrantId" IS NULL THEN
      IF TG_OP <> 'UPDATE'
         OR reservation_final."webAiGrantReferenceId" IS NULL
         OR reservation_final."webAiGrantProjectId" IS NULL
         OR EXISTS (SELECT 1 FROM "WebAiGrant" WHERE "id" = reservation_final."webAiGrantReferenceId")
         OR EXISTS (SELECT 1 FROM "Project" WHERE "id" = reservation_final."webAiGrantProjectId")
         OR NOT EXISTS (
           SELECT 1 FROM "ProjectDeletionReceipt" receipt
            WHERE receipt."deletedProjectId" = reservation_final."webAiGrantProjectId"
              AND receipt."status" IN ('database_deleted', 'completed', 'cleanup_failed')
         )
      THEN
        RAISE EXCEPTION 'runtime reservation requires a grant evidence reference' USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END IF;
    IF reservation_final."webAiGrantReferenceId" IS NULL THEN
      RAISE EXCEPTION 'runtime reservation requires a grant evidence reference' USING ERRCODE = 'check_violation';
    END IF;
    SELECT
      "id" AS id, "projectId" AS project_id, "operation" AS operation,
      "providerConnectionId" AS provider_connection_id, "modelId" AS model_id,
      "embeddingDimensions" AS embedding_dimensions, "maxOutputTokens" AS max_output_tokens,
      "billingMode" AS billing_mode, "billingUserId" AS billing_user_id,
      "boundJobId" AS bound_job_id, "routeSource" AS route_source,
      "routeId" AS route_id, "routeVersion" AS route_version,
      "routeUpdatedAt" AS route_updated_at,
      "providerConfigurationVersion" AS provider_configuration_version,
      "quotaMultiplierBps" AS quota_multiplier_bps,
      "routeFenceFingerprint" AS route_fence_fingerprint
    INTO grant_row FROM "WebAiGrant" WHERE "id" = reservation_final."webAiGrantId";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'runtime reservation grant evidence is missing' USING ERRCODE = 'check_violation';
    END IF;
    IF reservation_final."webAiGrantReferenceId" IS DISTINCT FROM grant_row.id
       OR reservation_final."webAiGrantProjectId" IS DISTINCT FROM grant_row.project_id
       OR grant_row.billing_mode IS DISTINCT FROM 'platform'
       OR reservation_final."userId" IS DISTINCT FROM grant_row.billing_user_id
       OR reservation_final."jobId" IS DISTINCT FROM grant_row.bound_job_id
       OR reservation_final."providerConnectionId" IS DISTINCT FROM grant_row.provider_connection_id
       OR reservation_final."operation" IS DISTINCT FROM grant_row.operation
       OR reservation_final."modelId" IS DISTINCT FROM grant_row.model_id
       OR reservation_final."routeSource" IS DISTINCT FROM grant_row.route_source
       OR reservation_final."routeId" IS DISTINCT FROM grant_row.route_id
       OR reservation_final."routeVersion" IS DISTINCT FROM grant_row.route_version
       OR reservation_final."routeUpdatedAt" IS DISTINCT FROM grant_row.route_updated_at
       OR reservation_final."providerConfigurationVersion" IS DISTINCT FROM grant_row.provider_configuration_version
       OR reservation_final."quotaMultiplierBps" IS DISTINCT FROM grant_row.quota_multiplier_bps
       OR reservation_final."routeFenceFingerprint" IS DISTINCT FROM grant_row.route_fence_fingerprint
    THEN
      RAISE EXCEPTION 'runtime reservation grant tuple mismatch' USING ERRCODE = 'check_violation';
    END IF;
    SELECT "userId" AS user_id INTO token_grant_row FROM "PlatformTokenGrant" WHERE "id" = reservation_final."grantId";
    IF NOT FOUND OR token_grant_row.user_id IS DISTINCT FROM reservation_final."userId" THEN
      RAISE EXCEPTION 'runtime reservation token grant owner mismatch' USING ERRCODE = 'check_violation';
    END IF;
    SELECT "projectId" AS project_id, "requestedById" AS requested_by_id INTO job_row
      FROM "BackgroundJob" WHERE "id" = grant_row.bound_job_id;
    IF NOT FOUND OR job_row.project_id IS DISTINCT FROM grant_row.project_id OR job_row.requested_by_id IS DISTINCT FROM grant_row.billing_user_id THEN
      RAISE EXCEPTION 'runtime reservation bound job mismatch' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  SELECT * INTO audit_final FROM "ProviderCallAudit" WHERE "id" = NEW."id";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'runtime provider-call audit evidence row is missing' USING ERRCODE = 'check_violation';
  END IF;
  IF audit_final."routeSource" IS NULL OR audit_final."routeSource" = 'personal_delegation' THEN RETURN NEW; END IF;
  IF audit_final."webAiGrantId" IS NULL THEN
    IF TG_OP <> 'UPDATE'
       OR audit_final."webAiGrantReferenceId" IS NULL
       OR audit_final."webAiGrantProjectId" IS NULL
       OR EXISTS (SELECT 1 FROM "WebAiGrant" WHERE "id" = audit_final."webAiGrantReferenceId")
       OR EXISTS (SELECT 1 FROM "Project" WHERE "id" = audit_final."webAiGrantProjectId")
       OR NOT EXISTS (
         SELECT 1 FROM "ProjectDeletionReceipt" receipt
          WHERE receipt."deletedProjectId" = audit_final."webAiGrantProjectId"
            AND receipt."status" IN ('database_deleted', 'completed', 'cleanup_failed')
       )
    THEN
      RAISE EXCEPTION 'runtime provider-call audit requires a grant evidence reference' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  SELECT
    "id" AS id, "projectId" AS project_id, "operation" AS operation,
    "providerConnectionId" AS provider_connection_id, "modelId" AS model_id,
    "embeddingDimensions" AS embedding_dimensions, "maxOutputTokens" AS max_output_tokens,
    "billingMode" AS billing_mode, "billingUserId" AS billing_user_id,
    "boundJobId" AS bound_job_id, "routeSource" AS route_source,
    "routeId" AS route_id, "routeVersion" AS route_version,
    "routeUpdatedAt" AS route_updated_at,
    "providerConfigurationVersion" AS provider_configuration_version,
    "quotaMultiplierBps" AS quota_multiplier_bps,
    "routeFenceFingerprint" AS route_fence_fingerprint,
    "credentialSecretFingerprint" AS credential_secret_fingerprint,
    "payerKind" AS payer_kind
  INTO grant_row FROM "WebAiGrant" WHERE "id" = audit_final."webAiGrantId";
  IF NOT FOUND THEN
      RAISE EXCEPTION 'runtime provider-call audit grant evidence is missing' USING ERRCODE = 'check_violation';
  END IF;
  historical_platform := audit_final."routeSource" IN ('project_override', 'platform_default')
    AND grant_row.payer_kind IS NULL;
  IF audit_final."webAiGrantReferenceId" IS DISTINCT FROM grant_row.id
     OR audit_final."webAiGrantProjectId" IS DISTINCT FROM grant_row.project_id
     OR grant_row.billing_mode IS DISTINCT FROM 'platform'
     OR audit_final."jobId" IS DISTINCT FROM grant_row.bound_job_id
     OR audit_final."providerConnectionId" IS DISTINCT FROM grant_row.provider_connection_id
     OR audit_final."operation" IS DISTINCT FROM grant_row.operation
     OR audit_final."modelId" IS DISTINCT FROM grant_row.model_id
     OR (NOT historical_platform AND audit_final."embeddingDimensions" IS DISTINCT FROM grant_row.embedding_dimensions)
     OR (NOT historical_platform AND audit_final."maxOutputTokens" IS DISTINCT FROM grant_row.max_output_tokens)
     OR audit_final."billingMode" IS DISTINCT FROM grant_row.billing_mode
     OR audit_final."billingUserId" IS DISTINCT FROM grant_row.billing_user_id
     OR audit_final."routeSource" IS DISTINCT FROM grant_row.route_source
     OR audit_final."routeId" IS DISTINCT FROM grant_row.route_id
     OR audit_final."routeVersion" IS DISTINCT FROM grant_row.route_version
     OR audit_final."routeUpdatedAt" IS DISTINCT FROM grant_row.route_updated_at
     OR audit_final."providerConfigurationVersion" IS DISTINCT FROM grant_row.provider_configuration_version
     OR audit_final."quotaMultiplierBps" IS DISTINCT FROM grant_row.quota_multiplier_bps
     OR audit_final."routeFenceFingerprint" IS DISTINCT FROM grant_row.route_fence_fingerprint
     OR (NOT historical_platform AND audit_final."credentialSecretFingerprint" IS DISTINCT FROM grant_row.credential_secret_fingerprint)
  THEN
    RAISE EXCEPTION 'provider-call audit grant tuple mismatch' USING ERRCODE = 'check_violation';
  END IF;
  SELECT "projectId" AS project_id, "requestedById" AS requested_by_id INTO job_row
    FROM "BackgroundJob" WHERE "id" = grant_row.bound_job_id;
  IF NOT FOUND OR job_row.project_id IS DISTINCT FROM grant_row.project_id OR job_row.requested_by_id IS DISTINCT FROM grant_row.billing_user_id THEN
    RAISE EXCEPTION 'provider-call audit bound job mismatch' USING ERRCODE = 'check_violation';
  END IF;
  IF audit_final."reservationId" IS NULL THEN
    RAISE EXCEPTION 'platform provider-call audit requires a reservation' USING ERRCODE = 'check_violation';
  END IF;
  SELECT
    "webAiGrantId" AS web_ai_grant_id, "webAiGrantReferenceId" AS web_ai_grant_reference_id,
    "userId" AS user_id, "jobId" AS job_id, "providerConnectionId" AS provider_connection_id,
    "operation" AS operation, "modelId" AS model_id, "routeSource" AS route_source,
    "routeId" AS route_id, "routeVersion" AS route_version, "routeUpdatedAt" AS route_updated_at,
    "providerConfigurationVersion" AS provider_configuration_version,
    "quotaMultiplierBps" AS quota_multiplier_bps, "routeFenceFingerprint" AS route_fence_fingerprint
  INTO reservation_row FROM "PlatformTokenReservation" WHERE "id" = audit_final."reservationId";
  IF NOT FOUND OR reservation_row.web_ai_grant_id IS DISTINCT FROM grant_row.id
     OR reservation_row.web_ai_grant_reference_id IS DISTINCT FROM grant_row.id
     OR reservation_row.user_id IS DISTINCT FROM grant_row.billing_user_id
     OR reservation_row.job_id IS DISTINCT FROM grant_row.bound_job_id
     OR reservation_row.provider_connection_id IS DISTINCT FROM grant_row.provider_connection_id
     OR reservation_row.operation IS DISTINCT FROM grant_row.operation
     OR reservation_row.model_id IS DISTINCT FROM grant_row.model_id
     OR reservation_row.route_source IS DISTINCT FROM grant_row.route_source
     OR reservation_row.route_id IS DISTINCT FROM grant_row.route_id
     OR reservation_row.route_version IS DISTINCT FROM grant_row.route_version
     OR reservation_row.route_updated_at IS DISTINCT FROM grant_row.route_updated_at
     OR reservation_row.provider_configuration_version IS DISTINCT FROM grant_row.provider_configuration_version
     OR reservation_row.quota_multiplier_bps IS DISTINCT FROM grant_row.quota_multiplier_bps
     OR reservation_row.route_fence_fingerprint IS DISTINCT FROM grant_row.route_fence_fingerprint
  THEN
    RAISE EXCEPTION 'provider-call audit reservation tuple mismatch' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT "credentialId" AS credential_id, "configurationVersion" AS configuration_version,
      "scope" AS scope, "ownershipState" AS ownership_state, "status" AS status, "disabledAt" AS disabled_at
      INTO provider_row FROM "AiProviderConnection" WHERE "id" = audit_final."providerConnectionId";
    IF NOT FOUND OR provider_row.scope IS DISTINCT FROM 'platform' OR provider_row.ownership_state IS DISTINCT FROM 'confirmed'
       OR provider_row.status IS DISTINCT FROM 'verified' OR provider_row.disabled_at IS NOT NULL
       OR provider_row.configuration_version IS DISTINCT FROM audit_final."providerConfigurationVersion"
    THEN
      RAISE EXCEPTION 'provider-call audit provider fence mismatch' USING ERRCODE = 'check_violation';
    END IF;
    SELECT "kind" AS kind, "secretFingerprint" AS secret_fingerprint INTO credential_row
      FROM "ExternalCredential" WHERE "id" = provider_row.credential_id;
    IF NOT FOUND OR credential_row.kind IS DISTINCT FROM 'ai_provider' OR credential_row.secret_fingerprint IS DISTINCT FROM audit_final."credentialSecretFingerprint" THEN
      RAISE EXCEPTION 'provider-call audit credential fence mismatch' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "personal_ai_grant_consistency_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  grant_final "WebAiGrant"%ROWTYPE;
  valid boolean;
BEGIN
  SELECT * INTO grant_final FROM "WebAiGrant" WHERE "id" = NEW."id";
  IF NOT FOUND OR grant_final."routeSource" IS DISTINCT FROM 'personal_delegation' THEN RETURN NEW; END IF;
  SELECT EXISTS (
    SELECT 1
    FROM "ProjectAiEffectiveRouteSelection" selection
    JOIN "ProjectAiProviderDelegation" delegation
      ON delegation."id" = selection."delegationId"
     AND delegation."projectId" = selection."projectId"
     AND delegation."operation" = selection."operation"
    JOIN "AiProviderConnection" provider ON provider."id" = delegation."providerConnectionId"
    JOIN "ExternalCredential" credential ON credential."id" = provider."credentialId"
    JOIN "Project" project_row ON project_row."id" = delegation."projectId"
    JOIN "AppUser" owner_user ON owner_user."id" = delegation."connectionOwnerId"
    JOIN "ProjectMembership" owner_membership ON owner_membership."id" = delegation."ownerProjectMembershipId"
    JOIN "MembershipSubscription" subscription
      ON subscription."id" = delegation."connectionOwnerSubscriptionId"
     AND subscription."userId" = delegation."connectionOwnerId"
    JOIN "ProjectMembership" project_owner_membership
      ON project_owner_membership."id" = delegation."projectConfirmedProjectMembershipId"
    JOIN "AppUser" project_owner ON project_owner."id" = delegation."projectConfirmedById"
    JOIN "ProjectMembership" selected_membership
      ON selected_membership."id" = selection."selectedByProjectMembershipId"
    JOIN "AppUser" selected_owner ON selected_owner."id" = selection."selectedById"
    JOIN "BackgroundJob" job ON job."id" = grant_final."boundJobId"
    WHERE selection."id" = grant_final."effectiveRouteSelectionId"
      AND selection."projectId" = grant_final."projectId"
      AND selection."operation" = grant_final."operation"
      AND selection."source" = 'personal_delegation'
      AND selection."delegationId" = grant_final."personalDelegationId"
      AND selection."version" = grant_final."effectiveRouteSelectionVersion"
      AND selection."updatedAt" = grant_final."effectiveRouteSelectionUpdatedAt"
      AND delegation."id" = grant_final."personalDelegationId"
      AND delegation."version" = grant_final."personalDelegationVersion"
      AND delegation."delegationFingerprint" = grant_final."personalDelegationFingerprint"
      AND grant_final."modelId" = delegation."modelId"
      AND grant_final."embeddingDimensions" IS NOT DISTINCT FROM delegation."embeddingDimensions"
      AND grant_final."maxOutputTokens" IS NOT DISTINCT FROM delegation."maxOutputTokens"
      AND grant_final."ownerProjectMembershipId" = delegation."ownerProjectMembershipId"
      AND grant_final."ownerMembershipCreatedAt" = delegation."ownerMembershipCreatedAt"
      AND grant_final."ownerSubscriptionId" = delegation."connectionOwnerSubscriptionId"
      AND grant_final."ownerSubscriptionVersion" = delegation."connectionOwnerSubscriptionVersion"
      AND grant_final."ownerSubscriptionStartsAt" = delegation."connectionOwnerSubscriptionStartsAt"
      AND grant_final."ownerSubscriptionExpiresAt" = delegation."connectionOwnerSubscriptionExpiresAt"
      AND grant_final."projectConfirmedById" = delegation."projectConfirmedById"
      AND grant_final."projectConfirmedProjectMembershipId" = delegation."projectConfirmedProjectMembershipId"
      AND grant_final."projectConfirmedMembershipCreatedAt" = delegation."projectConfirmedMembershipCreatedAt"
      AND grant_final."selectedById" = selection."selectedById"
      AND grant_final."selectedByProjectMembershipId" = selection."selectedByProjectMembershipId"
      AND grant_final."selectedByMembershipCreatedAt" = selection."selectedByMembershipCreatedAt"
      AND delegation."status" = 'active'
      AND delegation."expiresAt" > clock_timestamp()
      AND grant_final."expiresAt" > clock_timestamp()
      AND grant_final."expiresAt" <= delegation."expiresAt"
      AND project_row."archivedAt" IS NULL
      AND grant_final."projectId" = job."projectId"
      AND job."requestedById" = grant_final."issuedById"
      AND grant_final."billingUserId" = delegation."connectionOwnerId"
      AND grant_final."providerConnectionId" = provider."id"
      AND grant_final."payerProviderConnectionId" = provider."id"
      AND grant_final."payerKind" = 'personal_connection_owner'
      AND grant_final."providerConfigurationVersion" = delegation."providerConfigurationVersion"
      AND grant_final."credentialSecretFingerprint" = delegation."credentialFingerprint"
      AND grant_final."routeId" = selection."id"
      AND grant_final."routeVersion" = selection."version"
      AND grant_final."routeUpdatedAt" = selection."updatedAt"
      AND grant_final."routeFenceFingerprint" ~ '^[0-9a-f]{64}$'
      AND owner_user."disabledAt" IS NULL
      AND owner_membership."projectId" = delegation."projectId"
      AND owner_membership."userId" = delegation."connectionOwnerId"
      AND owner_membership."role" IN ('owner', 'editor')
      AND owner_membership."accessState" = 'confirmed'
      AND owner_membership."createdAt" = delegation."ownerMembershipCreatedAt"
      AND subscription."status" = 'active'
      AND subscription."version" = delegation."connectionOwnerSubscriptionVersion"
      AND subscription."startsAt" = delegation."connectionOwnerSubscriptionStartsAt"
      AND subscription."expiresAt" = delegation."connectionOwnerSubscriptionExpiresAt"
      AND subscription."startsAt" <= clock_timestamp()
      AND subscription."expiresAt" > clock_timestamp()
      AND project_owner_membership."projectId" = delegation."projectId"
      AND project_owner_membership."userId" = delegation."projectConfirmedById"
      AND project_owner_membership."role" = 'owner'
      AND project_owner_membership."accessState" = 'confirmed'
      AND project_owner_membership."createdAt" = delegation."projectConfirmedMembershipCreatedAt"
      AND project_owner."disabledAt" IS NULL
      AND selected_membership."projectId" = selection."projectId"
      AND selected_membership."userId" = selection."selectedById"
      AND selected_membership."role" = 'owner'
      AND selected_membership."accessState" = 'confirmed'
      AND selected_membership."createdAt" = selection."selectedByMembershipCreatedAt"
      AND selected_owner."disabledAt" IS NULL
      AND provider."scope" = 'user'
      AND provider."ownerUserId" = delegation."connectionOwnerId"
      AND provider."ownershipState" = 'confirmed'
      AND provider."status" = 'verified'
      AND provider."disabledAt" IS NULL
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
          AND grant_final."embeddingDimensions" = delegation."embeddingDimensions"
          AND grant_final."maxOutputTokens" IS NULL
        WHEN 'visionExtract' THEN provider."defaultVisionModelId" = delegation."modelId"
          AND grant_final."embeddingDimensions" IS NULL
          AND grant_final."maxOutputTokens" BETWEEN 1 AND 65536
        ELSE provider."defaultGenerationModelId" = delegation."modelId"
          AND grant_final."embeddingDimensions" IS NULL
          AND grant_final."maxOutputTokens" BETWEEN 1 AND 65536
      END
  ) INTO valid;
  IF NOT valid THEN
    RAISE EXCEPTION 'PERSONAL_RUNTIME_EVIDENCE_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "personal_ai_provider_call_consistency_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  audit_final "ProviderCallAudit"%ROWTYPE;
  grant_final "WebAiGrant"%ROWTYPE;
BEGIN
  SELECT * INTO audit_final FROM "ProviderCallAudit" WHERE "id" = NEW."id";
  IF NOT FOUND OR audit_final."routeSource" IS DISTINCT FROM 'personal_delegation' THEN RETURN NEW; END IF;
  -- Project deletion intentionally SET NULLs the live grant FK while retaining
  -- the scalar grant/project reference and the immutable deletion receipt.
  -- Accept only that final cascade shape; ordinary null/partial evidence is
  -- still rejected by this guard and the runtime CHECK constraint.
  IF audit_final."webAiGrantId" IS NULL THEN
    IF TG_OP <> 'UPDATE'
       OR audit_final."webAiGrantReferenceId" IS NULL
       OR audit_final."webAiGrantProjectId" IS NULL
       OR EXISTS (SELECT 1 FROM "WebAiGrant" WHERE "id" = audit_final."webAiGrantReferenceId")
       OR EXISTS (SELECT 1 FROM "Project" WHERE "id" = audit_final."webAiGrantProjectId")
       OR NOT EXISTS (
         SELECT 1 FROM "ProjectDeletionReceipt" receipt
          WHERE receipt."deletedProjectId" = audit_final."webAiGrantProjectId"
            AND receipt."status" IN ('database_deleted', 'completed', 'cleanup_failed')
       )
    THEN
      RAISE EXCEPTION 'PERSONAL_RUNTIME_EVIDENCE_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF audit_final."reservationId" IS NOT NULL THEN
    RAISE EXCEPTION 'PERSONAL_RUNTIME_EVIDENCE_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO grant_final FROM "WebAiGrant" WHERE "id" = audit_final."webAiGrantId";
  IF NOT FOUND
     OR audit_final."webAiGrantReferenceId" IS DISTINCT FROM grant_final."id"
     OR audit_final."webAiGrantProjectId" IS DISTINCT FROM grant_final."projectId"
     OR audit_final."jobId" IS DISTINCT FROM grant_final."boundJobId"
     OR audit_final."providerConnectionId" IS DISTINCT FROM grant_final."providerConnectionId"
     OR audit_final."operation" IS DISTINCT FROM grant_final."operation"
     OR audit_final."modelId" IS DISTINCT FROM grant_final."modelId"
     OR audit_final."billingMode" IS DISTINCT FROM grant_final."billingMode"
     OR audit_final."billingUserId" IS DISTINCT FROM grant_final."billingUserId"
     OR audit_final."routeSource" IS DISTINCT FROM grant_final."routeSource"
     OR audit_final."routeId" IS DISTINCT FROM grant_final."routeId"
     OR audit_final."routeVersion" IS DISTINCT FROM grant_final."routeVersion"
     OR audit_final."routeUpdatedAt" IS DISTINCT FROM grant_final."routeUpdatedAt"
     OR audit_final."providerConfigurationVersion" IS DISTINCT FROM grant_final."providerConfigurationVersion"
     OR audit_final."quotaMultiplierBps" IS DISTINCT FROM grant_final."quotaMultiplierBps"
     OR audit_final."routeFenceFingerprint" IS DISTINCT FROM grant_final."routeFenceFingerprint"
     OR audit_final."credentialSecretFingerprint" IS DISTINCT FROM grant_final."credentialSecretFingerprint"
     OR audit_final."personalDelegationId" IS DISTINCT FROM grant_final."personalDelegationId"
     OR audit_final."personalDelegationVersion" IS DISTINCT FROM grant_final."personalDelegationVersion"
     OR audit_final."personalDelegationFingerprint" IS DISTINCT FROM grant_final."personalDelegationFingerprint"
     OR audit_final."effectiveRouteSelectionId" IS DISTINCT FROM grant_final."effectiveRouteSelectionId"
     OR audit_final."effectiveRouteSelectionVersion" IS DISTINCT FROM grant_final."effectiveRouteSelectionVersion"
     OR audit_final."effectiveRouteSelectionUpdatedAt" IS DISTINCT FROM grant_final."effectiveRouteSelectionUpdatedAt"
     OR audit_final."payerKind" IS DISTINCT FROM grant_final."payerKind"
     OR audit_final."payerProviderConnectionId" IS DISTINCT FROM grant_final."payerProviderConnectionId"
     OR audit_final."ownerProjectMembershipId" IS DISTINCT FROM grant_final."ownerProjectMembershipId"
     OR audit_final."ownerMembershipCreatedAt" IS DISTINCT FROM grant_final."ownerMembershipCreatedAt"
     OR audit_final."ownerSubscriptionId" IS DISTINCT FROM grant_final."ownerSubscriptionId"
     OR audit_final."ownerSubscriptionVersion" IS DISTINCT FROM grant_final."ownerSubscriptionVersion"
     OR audit_final."ownerSubscriptionStartsAt" IS DISTINCT FROM grant_final."ownerSubscriptionStartsAt"
     OR audit_final."ownerSubscriptionExpiresAt" IS DISTINCT FROM grant_final."ownerSubscriptionExpiresAt"
     OR audit_final."projectConfirmedById" IS DISTINCT FROM grant_final."projectConfirmedById"
     OR audit_final."projectConfirmedProjectMembershipId" IS DISTINCT FROM grant_final."projectConfirmedProjectMembershipId"
     OR audit_final."projectConfirmedMembershipCreatedAt" IS DISTINCT FROM grant_final."projectConfirmedMembershipCreatedAt"
     OR audit_final."selectedById" IS DISTINCT FROM grant_final."selectedById"
     OR audit_final."selectedByProjectMembershipId" IS DISTINCT FROM grant_final."selectedByProjectMembershipId"
     OR audit_final."selectedByMembershipCreatedAt" IS DISTINCT FROM grant_final."selectedByMembershipCreatedAt"
     OR audit_final."embeddingDimensions" IS DISTINCT FROM grant_final."embeddingDimensions"
     OR audit_final."maxOutputTokens" IS DISTINCT FROM grant_final."maxOutputTokens"
  THEN
    RAISE EXCEPTION 'PERSONAL_RUNTIME_EVIDENCE_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE "MemoryIndexGeneration"
  DROP CONSTRAINT "MemoryIndexGeneration_embedding_route_snapshot_check",
  ADD CONSTRAINT "MemoryIndexGeneration_embedding_route_snapshot_check" CHECK (
    (
      "expectedEmbeddingRouteSource" IS NULL
      AND "expectedEmbeddingRouteId" IS NULL
      AND "expectedEmbeddingRouteVersion" IS NULL
      AND "expectedEmbeddingProviderConfigurationVersion" IS NULL
      AND "expectedEmbeddingRouteFenceFingerprint" IS NULL
      AND "embeddingWebAiGrantId" IS NULL
    )
    OR (
      "jobId" IS NOT NULL
      AND "expectedEmbeddingRouteSource" IN ('project_override', 'platform_default')
      AND "expectedEmbeddingRouteUpdatedAt" IS NOT NULL
      AND "expectedEmbeddingProviderConfigurationVersion" > 0
      AND "expectedEmbeddingRouteFenceFingerprint" ~ '^[0-9a-f]{64}$'
      AND "embeddingWebAiGrantId" IS NULL
      AND (
        ("expectedEmbeddingRouteSource" = 'platform_default' AND "expectedEmbeddingRouteId" IS NOT NULL AND "expectedEmbeddingRouteVersion" > 0)
        OR ("expectedEmbeddingRouteSource" = 'project_override' AND "expectedEmbeddingRouteId" IS NULL AND "expectedEmbeddingRouteVersion" IS NULL)
      )
    )
    OR (
      "jobId" IS NOT NULL
      AND "expectedEmbeddingRouteSource" = 'personal_delegation'
      AND "expectedEmbeddingRouteId" IS NOT NULL
      AND "expectedEmbeddingRouteVersion" > 0
      AND "expectedEmbeddingRouteUpdatedAt" IS NOT NULL
      AND "expectedEmbeddingProviderConfigurationVersion" > 0
      AND "expectedEmbeddingRouteFenceFingerprint" ~ '^[0-9a-f]{64}$'
      AND "embeddingWebAiGrantId" IS NOT NULL
    )
  );

CREATE OR REPLACE FUNCTION "memory_index_generation_route_snapshot_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  complete_snapshot boolean;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."jobId" IS DISTINCT FROM NEW."jobId" THEN
    RAISE EXCEPTION 'memory index generation job binding is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."embeddingWebAiGrantId" IS DISTINCT FROM NEW."embeddingWebAiGrantId" THEN
    RAISE EXCEPTION 'memory index personal grant binding is immutable' USING ERRCODE = 'check_violation';
  END IF;
  complete_snapshot := COALESCE(NEW."expectedEmbeddingRouteSource" IN ('project_override', 'platform_default', 'personal_delegation')
    AND NEW."expectedEmbeddingRouteUpdatedAt" IS NOT NULL
    AND NEW."expectedEmbeddingProviderConfigurationVersion" IS NOT NULL
    AND NEW."expectedEmbeddingProviderConfigurationVersion" > 0
    AND NEW."expectedEmbeddingRouteFenceFingerprint" ~ '^[0-9a-f]{64}$'
    AND (
      (NEW."expectedEmbeddingRouteSource" = 'platform_default' AND NEW."expectedEmbeddingRouteId" IS NOT NULL AND NEW."expectedEmbeddingRouteVersion" IS NOT NULL AND NEW."expectedEmbeddingRouteVersion" > 0 AND NEW."embeddingWebAiGrantId" IS NULL)
      OR (NEW."expectedEmbeddingRouteSource" = 'project_override' AND NEW."expectedEmbeddingRouteId" IS NULL AND NEW."expectedEmbeddingRouteVersion" IS NULL AND NEW."embeddingWebAiGrantId" IS NULL)
      OR (NEW."expectedEmbeddingRouteSource" = 'personal_delegation' AND NEW."expectedEmbeddingRouteId" IS NOT NULL AND NEW."expectedEmbeddingRouteVersion" IS NOT NULL AND NEW."expectedEmbeddingRouteVersion" > 0 AND NEW."embeddingWebAiGrantId" IS NOT NULL)
    ), false);
  IF TG_OP = 'INSERT' AND NEW."jobId" IS NOT NULL AND complete_snapshot IS NOT TRUE THEN
    RAISE EXCEPTION 'new job-backed memory index generation requires a complete route snapshot' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."jobId" IS NOT NULL
     AND NEW."status" IN ('complete', 'failed', 'unknown', 'superseded')
     AND NOT complete_snapshot
     AND NOT (
       NEW."expectedEmbeddingRouteSource" IS NULL
       AND NEW."expectedEmbeddingRouteId" IS NULL
       AND NEW."expectedEmbeddingRouteVersion" IS NULL
       AND NEW."expectedEmbeddingProviderConfigurationVersion" IS NULL
       AND NEW."expectedEmbeddingRouteFenceFingerprint" IS NULL
       AND NEW."embeddingWebAiGrantId" IS NULL
     )
  THEN
    RAISE EXCEPTION 'terminal memory index generation requires a complete route snapshot' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."jobId" IS NOT NULL AND (
    OLD."expectedEmbeddingRouteSource" IS DISTINCT FROM NEW."expectedEmbeddingRouteSource"
    OR OLD."expectedEmbeddingRouteId" IS DISTINCT FROM NEW."expectedEmbeddingRouteId"
    OR OLD."expectedEmbeddingRouteVersion" IS DISTINCT FROM NEW."expectedEmbeddingRouteVersion"
    OR OLD."expectedEmbeddingRouteUpdatedAt" IS DISTINCT FROM NEW."expectedEmbeddingRouteUpdatedAt"
    OR OLD."expectedEmbeddingProviderConfigurationVersion" IS DISTINCT FROM NEW."expectedEmbeddingProviderConfigurationVersion"
    OR OLD."expectedEmbeddingRouteFenceFingerprint" IS DISTINCT FROM NEW."expectedEmbeddingRouteFenceFingerprint"
  ) THEN
    RAISE EXCEPTION 'memory index route snapshot is immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- Re-evaluate the complete personal evidence chain at the point a generation
-- is published.  The INSERT admission above is not sufficient: a delegation,
-- provider, credential, membership, or subscription may be revoked while a
-- job is building.  This predicate deliberately reads the current rows and
-- the database clock; it is also reused by the deferred pointer guard.
CREATE OR REPLACE FUNCTION "personal_memory_index_live_evidence_valid"(
  p_generation_id UUID,
  p_require_complete BOOLEAN DEFAULT false
)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  valid boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1
      FROM "MemoryIndexGeneration" generation
      JOIN "WebAiGrant" grant_row
        ON grant_row."id" = generation."embeddingWebAiGrantId"
      JOIN "ProjectAiEffectiveRouteSelection" selection
        ON selection."id" = grant_row."effectiveRouteSelectionId"
       AND selection."projectId" = grant_row."projectId"
       AND selection."operation" = 'embedding'
      JOIN "ProjectAiProviderDelegation" delegation
        ON delegation."id" = selection."delegationId"
       AND delegation."projectId" = selection."projectId"
       AND delegation."operation" = 'embedding'
      JOIN "AiProviderConnection" provider
        ON provider."id" = delegation."providerConnectionId"
      JOIN "ExternalCredential" credential
        ON credential."id" = provider."credentialId"
      JOIN "Project" project_row
        ON project_row."id" = generation."projectId"
      JOIN "AppUser" owner_user
        ON owner_user."id" = delegation."connectionOwnerId"
      JOIN "ProjectMembership" owner_membership
        ON owner_membership."id" = delegation."ownerProjectMembershipId"
      JOIN "MembershipSubscription" subscription
        ON subscription."id" = delegation."connectionOwnerSubscriptionId"
       AND subscription."userId" = delegation."connectionOwnerId"
      JOIN "ProjectMembership" project_owner_membership
        ON project_owner_membership."id" = delegation."projectConfirmedProjectMembershipId"
      JOIN "AppUser" project_owner
        ON project_owner."id" = delegation."projectConfirmedById"
      JOIN "ProjectMembership" selected_membership
        ON selected_membership."id" = selection."selectedByProjectMembershipId"
      JOIN "AppUser" selected_owner
        ON selected_owner."id" = selection."selectedById"
      JOIN "BackgroundJob" job
        ON job."id" = generation."jobId"
     WHERE generation."id" = p_generation_id
       AND (NOT p_require_complete OR generation."status" = 'complete')
       AND generation."expectedEmbeddingRouteSource" = 'personal_delegation'
       AND generation."expectedEmbeddingRouteId" = selection."id"
       AND generation."expectedEmbeddingRouteVersion" = selection."version"
       AND generation."expectedEmbeddingRouteUpdatedAt" = selection."updatedAt"
       AND generation."expectedEmbeddingProviderConfigurationVersion" = delegation."providerConfigurationVersion"
       AND generation."expectedEmbeddingRouteFenceFingerprint" = grant_row."routeFenceFingerprint"
       AND generation."projectId" = grant_row."projectId"
       AND generation."jobId" = grant_row."boundJobId"
       AND generation."providerConnectionId" = grant_row."providerConnectionId"
       AND generation."modelId" = grant_row."modelId"
       AND generation."dimensions" = grant_row."embeddingDimensions"
       AND grant_row."operation" = 'embedding'
       AND grant_row."billingMode" = 'byok'
       AND grant_row."billingUserId" = delegation."connectionOwnerId"
       AND grant_row."routeSource" = 'personal_delegation'
       AND grant_row."routeId" = selection."id"
       AND grant_row."routeVersion" = selection."version"
       AND grant_row."routeUpdatedAt" = selection."updatedAt"
       AND grant_row."providerConfigurationVersion" = delegation."providerConfigurationVersion"
       AND grant_row."credentialSecretFingerprint" = delegation."credentialFingerprint"
       AND grant_row."embeddingDimensions" = delegation."embeddingDimensions"
       AND grant_row."maxOutputTokens" IS NULL
       AND grant_row."personalDelegationId" = delegation."id"
       AND grant_row."personalDelegationVersion" = delegation."version"
       AND grant_row."personalDelegationFingerprint" = delegation."delegationFingerprint"
       AND grant_row."effectiveRouteSelectionId" = selection."id"
       AND grant_row."effectiveRouteSelectionVersion" = selection."version"
       AND grant_row."effectiveRouteSelectionUpdatedAt" = selection."updatedAt"
       AND grant_row."payerKind" = 'personal_connection_owner'
       AND grant_row."payerProviderConnectionId" = provider."id"
       AND grant_row."ownerProjectMembershipId" = delegation."ownerProjectMembershipId"
       AND grant_row."ownerMembershipCreatedAt" = delegation."ownerMembershipCreatedAt"
       AND grant_row."ownerSubscriptionId" = delegation."connectionOwnerSubscriptionId"
       AND grant_row."ownerSubscriptionVersion" = delegation."connectionOwnerSubscriptionVersion"
       AND grant_row."ownerSubscriptionStartsAt" = delegation."connectionOwnerSubscriptionStartsAt"
       AND grant_row."ownerSubscriptionExpiresAt" = delegation."connectionOwnerSubscriptionExpiresAt"
       AND grant_row."projectConfirmedById" = delegation."projectConfirmedById"
       AND grant_row."projectConfirmedProjectMembershipId" = delegation."projectConfirmedProjectMembershipId"
       AND grant_row."projectConfirmedMembershipCreatedAt" = delegation."projectConfirmedMembershipCreatedAt"
       AND grant_row."selectedById" = selection."selectedById"
       AND grant_row."selectedByProjectMembershipId" = selection."selectedByProjectMembershipId"
       AND grant_row."selectedByMembershipCreatedAt" = selection."selectedByMembershipCreatedAt"
       AND grant_row."revokedAt" IS NULL
       AND grant_row."expiresAt" > clock_timestamp()
       AND delegation."status" = 'active'
       AND delegation."expiresAt" > clock_timestamp()
       AND selection."source" = 'personal_delegation'
       AND project_row."archivedAt" IS NULL
       AND job."projectId" = grant_row."projectId"
       AND job."requestedById" = grant_row."issuedById"
       AND owner_user."disabledAt" IS NULL
       AND owner_membership."projectId" = delegation."projectId"
       AND owner_membership."userId" = delegation."connectionOwnerId"
       AND owner_membership."role" IN ('owner', 'editor')
       AND owner_membership."accessState" = 'confirmed'
       AND owner_membership."createdAt" = delegation."ownerMembershipCreatedAt"
       AND subscription."status" = 'active'
       AND subscription."version" = delegation."connectionOwnerSubscriptionVersion"
       AND subscription."startsAt" = delegation."connectionOwnerSubscriptionStartsAt"
       AND subscription."expiresAt" = delegation."connectionOwnerSubscriptionExpiresAt"
       AND subscription."startsAt" <= clock_timestamp()
       AND subscription."expiresAt" > clock_timestamp()
       AND project_owner_membership."projectId" = delegation."projectId"
       AND project_owner_membership."userId" = delegation."projectConfirmedById"
       AND project_owner_membership."role" = 'owner'
       AND project_owner_membership."accessState" = 'confirmed'
       AND project_owner_membership."createdAt" = delegation."projectConfirmedMembershipCreatedAt"
       AND project_owner."disabledAt" IS NULL
       AND selected_membership."projectId" = selection."projectId"
       AND selected_membership."userId" = selection."selectedById"
       AND selected_membership."role" = 'owner'
       AND selected_membership."accessState" = 'confirmed'
       AND selected_membership."createdAt" = selection."selectedByMembershipCreatedAt"
       AND selected_owner."disabledAt" IS NULL
       AND provider."scope" = 'user'
       AND provider."ownerUserId" = delegation."connectionOwnerId"
       AND provider."workspaceId" IS NULL
       AND provider."ownershipState" = 'confirmed'
       AND provider."status" = 'verified'
       AND provider."disabledAt" IS NULL
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
       AND provider."configurationVersion" = delegation."providerConfigurationVersion"
       AND provider."defaultEmbeddingModelId" = delegation."modelId"
       AND provider."embeddingDimensions" = delegation."embeddingDimensions"
       AND provider."kind" <> 'deepseek'
  ) INTO valid;
  RETURN COALESCE(valid, false);
END;
$$;

CREATE OR REPLACE FUNCTION "personal_memory_index_evidence_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."expectedEmbeddingRouteSource" IS DISTINCT FROM 'personal_delegation' THEN RETURN OLD; END IF;
    IF pg_trigger_depth() > 1
       AND EXISTS (
         SELECT 1 FROM "ProjectDeletionReceipt" receipt
          WHERE receipt."deletedProjectId" = OLD."projectId"
            AND receipt."status" IN ('pending', 'database_deleted', 'completed', 'cleanup_failed')
       ) THEN
      RETURN OLD;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "Project" WHERE "id" = OLD."projectId")
       AND EXISTS (
         SELECT 1 FROM "ProjectDeletionReceipt" receipt
          WHERE receipt."deletedProjectId" = OLD."projectId"
            AND receipt."status" IN ('database_deleted', 'completed', 'cleanup_failed')
       ) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'PERSONAL_MEMORY_INDEX_EVIDENCE_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."expectedEmbeddingRouteSource" IS DISTINCT FROM 'personal_delegation' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD."projectId" IS DISTINCT FROM NEW."projectId"
       OR OLD."jobId" IS DISTINCT FROM NEW."jobId"
       OR OLD."providerConnectionId" IS DISTINCT FROM NEW."providerConnectionId"
       OR OLD."modelId" IS DISTINCT FROM NEW."modelId"
       OR OLD."dimensions" IS DISTINCT FROM NEW."dimensions"
       OR OLD."embeddingWebAiGrantId" IS DISTINCT FROM NEW."embeddingWebAiGrantId"
       OR OLD."expectedEmbeddingRouteSource" IS DISTINCT FROM NEW."expectedEmbeddingRouteSource"
       OR OLD."expectedEmbeddingRouteId" IS DISTINCT FROM NEW."expectedEmbeddingRouteId"
       OR OLD."expectedEmbeddingRouteVersion" IS DISTINCT FROM NEW."expectedEmbeddingRouteVersion"
       OR OLD."expectedEmbeddingRouteUpdatedAt" IS DISTINCT FROM NEW."expectedEmbeddingRouteUpdatedAt"
       OR OLD."expectedEmbeddingProviderConfigurationVersion" IS DISTINCT FROM NEW."expectedEmbeddingProviderConfigurationVersion"
       OR OLD."expectedEmbeddingRouteFenceFingerprint" IS DISTINCT FROM NEW."expectedEmbeddingRouteFenceFingerprint"
    THEN
      RAISE EXCEPTION 'PERSONAL_MEMORY_INDEX_EVIDENCE_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" = 'complete'
       AND NOT "personal_memory_index_live_evidence_valid"(NEW."id", true)
    THEN
      RAISE EXCEPTION 'PERSONAL_MEMORY_INDEX_EVIDENCE_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT "personal_memory_index_live_evidence_valid"(NEW."id", false) THEN
      RAISE EXCEPTION 'PERSONAL_MEMORY_INDEX_EVIDENCE_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "personal_memory_grant_delete_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "MemoryIndexGeneration" generation
     WHERE generation."embeddingWebAiGrantId" = OLD."id"
       AND generation."projectId" = OLD."projectId"
  )
  AND NOT (
    (
      pg_trigger_depth() > 1
      AND EXISTS (
        SELECT 1 FROM "ProjectDeletionReceipt" receipt
         WHERE receipt."deletedProjectId" = OLD."projectId"
           AND receipt."status" IN ('pending', 'database_deleted', 'completed', 'cleanup_failed')
      )
    )
    OR
    NOT EXISTS (SELECT 1 FROM "Project" WHERE "id" = OLD."projectId")
    AND EXISTS (
      SELECT 1 FROM "ProjectDeletionReceipt" receipt
       WHERE receipt."deletedProjectId" = OLD."projectId"
         AND receipt."status" IN ('database_deleted', 'completed', 'cleanup_failed')
    )
  ) THEN
    RAISE EXCEPTION 'PERSONAL_MEMORY_INDEX_EVIDENCE_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END;
$$;

CREATE OR REPLACE FUNCTION "personal_memory_index_pointer_evidence_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  generation_source VARCHAR(32);
BEGIN
  SELECT "expectedEmbeddingRouteSource"
    INTO generation_source
    FROM "MemoryIndexGeneration"
   WHERE "projectId" = NEW."projectId"
     AND "id" = NEW."indexGenerationId";
  IF generation_source = 'personal_delegation'
     AND NOT "personal_memory_index_live_evidence_valid"(NEW."indexGenerationId", true)
  THEN
    RAISE EXCEPTION 'PERSONAL_MEMORY_INDEX_EVIDENCE_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "WebAiGrant_personal_runtime_evidence_guard"
AFTER INSERT OR UPDATE ON "WebAiGrant"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "personal_ai_grant_consistency_guard"();

CREATE CONSTRAINT TRIGGER "ProviderCallAudit_personal_runtime_evidence_guard"
AFTER INSERT OR UPDATE ON "ProviderCallAudit"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "personal_ai_provider_call_consistency_guard"();

CREATE CONSTRAINT TRIGGER "MemoryIndexGeneration_personal_evidence_guard"
AFTER INSERT OR UPDATE OR DELETE ON "MemoryIndexGeneration"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "personal_memory_index_evidence_guard"();

CREATE CONSTRAINT TRIGGER "MemoryIndexPointer_personal_evidence_guard"
AFTER INSERT OR UPDATE ON "MemoryIndexPointer"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "personal_memory_index_pointer_evidence_guard"();

CREATE CONSTRAINT TRIGGER "WebAiGrant_personal_memory_delete_guard"
AFTER DELETE ON "WebAiGrant"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "personal_memory_grant_delete_guard"();

CREATE TRIGGER "WebAiGrant_new_platform_fingerprint_guard"
BEFORE INSERT ON "WebAiGrant"
FOR EACH ROW EXECUTE FUNCTION "runtime_ai_new_platform_fingerprint_guard"();

CREATE TRIGGER "ProviderCallAudit_new_platform_fingerprint_guard"
BEFORE INSERT ON "ProviderCallAudit"
FOR EACH ROW EXECUTE FUNCTION "runtime_ai_new_platform_fingerprint_guard"();
