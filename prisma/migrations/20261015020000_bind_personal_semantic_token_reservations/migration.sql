-- Credits remain owned by AppUser. A personal semantic confirmation supplies
-- consumption evidence without inventing a Project or a project AI grant.
ALTER TABLE "PlatformTokenReservation"
  ADD COLUMN "personalKnowledgeSemanticChallengeId" UUID,
  ADD CONSTRAINT "PlatformTokenReservation_personal_semantic_challenge_fkey"
    FOREIGN KEY ("userId", "personalKnowledgeSemanticChallengeId")
    REFERENCES "PersonalKnowledgeSemanticChallenge" ("ownerUserId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;
CREATE UNIQUE INDEX "PlatformTokenReservation_personal_semantic_challenge_key"
  ON "PlatformTokenReservation" ("userId", "personalKnowledgeSemanticChallengeId");

CREATE FUNCTION "personal_semantic_token_reservation_guard"()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE proof "PersonalKnowledgeSemanticChallenge"%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD."personalKnowledgeSemanticChallengeId" IS DISTINCT FROM NEW."personalKnowledgeSemanticChallengeId" THEN
      RAISE EXCEPTION 'personal semantic reservation binding is immutable' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."callKey" NOT LIKE 'personal-semantic:%' THEN
    IF NEW."personalKnowledgeSemanticChallengeId" IS NOT NULL THEN
      RAISE EXCEPTION 'personal semantic reservation key mismatch' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."callKey" !~ '^personal-semantic:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'invalid personal semantic reservation key' USING ERRCODE = 'check_violation';
  END IF;
  -- The existing runtime accounting API inserts a stable, namespaced callKey.
  -- Bind its new FK here so all accounting entry points share this invariant.
  NEW."personalKnowledgeSemanticChallengeId" := substring(NEW."callKey" from 19)::uuid;
  SELECT * INTO proof FROM "PersonalKnowledgeSemanticChallenge"
    WHERE "id" = NEW."personalKnowledgeSemanticChallengeId" AND "ownerUserId" = NEW."userId";
  IF NOT FOUND OR proof."status" <> 'consumed' OR proof."consumedAt" IS NULL
    OR proof."providerConnectionId" IS DISTINCT FROM NEW."providerConnectionId"
    OR proof."providerConfigurationVersion" IS DISTINCT FROM NEW."providerConfigurationVersion"
    OR proof."modelId" IS DISTINCT FROM NEW."modelId"
    OR NEW."operation" <> 'embedding' OR NEW."routeSource" IS DISTINCT FROM 'platform_default'
    OR NOT EXISTS (SELECT 1 FROM "PersonalKnowledgeSemanticAudit" a
      WHERE a."challengeId" = proof."id" AND a."ownerUserId" = NEW."userId" AND a."status" = 'running')
    OR NOT EXISTS (SELECT 1 FROM "PlatformDefaultAiRoute" r JOIN "AiProviderConnection" p ON p."id" = r."providerConnectionId"
      WHERE r."id" = NEW."routeId" AND r."status" = 'active' AND r."operation" = 'embedding'
        AND r."version" = NEW."routeVersion" AND r."quotaMultiplierBps" = NEW."quotaMultiplierBps"
        AND r."updatedAt" = NEW."routeUpdatedAt" AND r."providerConnectionId" = proof."providerConnectionId"
        AND r."validatedProviderConfigurationVersion" = proof."providerConfigurationVersion"
        AND r."modelId" = proof."modelId" AND r."embeddingDimensions" = proof."dimensions"
        AND p."scope" = 'platform' AND p."ownerUserId" IS NULL AND p."status" = 'verified' AND p."disabledAt" IS NULL)
  THEN
    RAISE EXCEPTION 'personal semantic reservation requires matching consumed consent' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "PlatformTokenReservation_personal_semantic_guard"
  BEFORE INSERT OR UPDATE ON "PlatformTokenReservation"
  FOR EACH ROW EXECUTE FUNCTION "personal_semantic_token_reservation_guard"();
REVOKE ALL ON FUNCTION "personal_semantic_token_reservation_guard"() FROM PUBLIC;
-- Disposable migration gates do not always bootstrap production principals.
-- PUBLIC is always revoked; existing application principals are also sealed.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_project_os_runtime') THEN
    REVOKE ALL ON FUNCTION "personal_semantic_token_reservation_guard"() FROM ai_project_os_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_project_os_entitlement_writer') THEN
    REVOKE ALL ON FUNCTION "personal_semantic_token_reservation_guard"() FROM ai_project_os_entitlement_writer;
  END IF;
END $$;

ALTER TABLE "PlatformTokenReservation" DROP CONSTRAINT "PlatformTokenReservation_raw_billing_check",
  ADD CONSTRAINT "PlatformTokenReservation_raw_billing_check" CHECK (
    (
      -- Rows created before the runtime fence keep the old integer domain;
      -- the new raw columns are a lossless backfill, not a new historical cap.
      "routeSource" IS NULL AND "routeId" IS NULL AND "routeVersion" IS NULL
      AND "routeUpdatedAt" IS NULL AND "providerConfigurationVersion" IS NULL
      AND "routeFenceFingerprint" IS NULL AND "webAiGrantId" IS NULL
      AND "webAiGrantReferenceId" IS NULL AND "webAiGrantProjectId" IS NULL
      AND "personalKnowledgeSemanticChallengeId" IS NULL
      AND "quotaMultiplierBps" = 10000
      AND "rawEstimatedTokens" = "reservedTokens" AND "reservedTokens" > 0
      AND ("rawSettledTokens" IS NULL OR ("settledTokens" IS NOT NULL AND "rawSettledTokens" = "settledTokens" AND "rawSettledTokens" >= 0))
    )
    OR (
      "rawEstimatedTokens" > 0
      AND "rawEstimatedTokens" <= 10000000
      AND "reservedTokens" > 0
      AND "reservedTokens" <= 1000000000
      AND "quotaMultiplierBps" BETWEEN 1 AND 100000
      AND "reservedTokens"::bigint = (("rawEstimatedTokens"::bigint * "quotaMultiplierBps"::bigint + 9999) / 10000)
      AND "routeSource" IN ('project_override', 'platform_default')
      AND "routeSource" IS NOT NULL
      AND (
        ("webAiGrantReferenceId" IS NOT NULL AND "webAiGrantProjectId" IS NOT NULL AND "personalKnowledgeSemanticChallengeId" IS NULL)
        OR ("personalKnowledgeSemanticChallengeId" IS NOT NULL AND "webAiGrantId" IS NULL
          AND "webAiGrantReferenceId" IS NULL AND "webAiGrantProjectId" IS NULL AND "jobId" IS NULL
          AND "operation" = 'embedding' AND "routeSource" = 'platform_default'
          AND "callKey" = 'personal-semantic:' || "personalKnowledgeSemanticChallengeId"::text)
      )
      AND "providerConnectionId" IS NOT NULL
      AND "routeUpdatedAt" IS NOT NULL
      AND "providerConfigurationVersion" IS NOT NULL
      AND "providerConfigurationVersion" > 0
      AND "routeFenceFingerprint" IS NOT NULL
      AND "routeFenceFingerprint" ~ '^[0-9a-f]{64}$'
      AND (
        ("routeSource" = 'platform_default' AND "routeId" IS NOT NULL AND "routeVersion" IS NOT NULL AND "routeVersion" > 0)
        OR ("routeSource" = 'project_override' AND "routeId" IS NULL AND "routeVersion" IS NULL)
      )
      AND (
        "rawSettledTokens" IS NULL
        OR (
          "rawSettledTokens" BETWEEN 0 AND 10000000
          AND "settledTokens" IS NOT NULL
          AND "settledTokens"::bigint = (("rawSettledTokens"::bigint * "quotaMultiplierBps"::bigint + 9999) / 10000)
        )
      )
    )
  );

-- Preserve every existing project/BYOK evidence branch while adding the
-- separate personal-consent branch to the current deferred consistency guard.
-- Include the 20260910010000 clean-slate rewrite: provider ownershipState
-- was removed there and must not be reintroduced into the audit branch.
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
    -- Personal knowledge spends the caller's credits without a project grant.
    -- The immediate guard binds INSERT to live consumed consent; settlement
    -- and crash recovery retain that immutable identity after the audit ends.
    IF reservation_final."personalKnowledgeSemanticChallengeId" IS NOT NULL THEN
      IF reservation_final."webAiGrantId" IS NOT NULL OR reservation_final."webAiGrantReferenceId" IS NOT NULL
        OR reservation_final."webAiGrantProjectId" IS NOT NULL OR reservation_final."jobId" IS NOT NULL
        OR reservation_final."routeSource" IS DISTINCT FROM 'platform_default'
        OR reservation_final."operation" <> 'embedding'
        OR NOT EXISTS (SELECT 1 FROM "PersonalKnowledgeSemanticChallenge" c
          WHERE c."id" = reservation_final."personalKnowledgeSemanticChallengeId"
            AND c."ownerUserId" = reservation_final."userId" AND c."status" = 'consumed' AND c."consumedAt" IS NOT NULL
            AND c."providerConnectionId" = reservation_final."providerConnectionId"
            AND c."providerConfigurationVersion" = reservation_final."providerConfigurationVersion"
            AND c."modelId" = reservation_final."modelId") THEN
        RAISE EXCEPTION 'personal semantic reservation evidence mismatch' USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END IF;

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
      "scope" AS scope, "status" AS status, "disabledAt" AS disabled_at
      INTO provider_row FROM "AiProviderConnection" WHERE "id" = audit_final."providerConnectionId";
    IF NOT FOUND OR provider_row.scope IS DISTINCT FROM 'platform'
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
