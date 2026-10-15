-- Personal visual extraction can spend the AppUser's platform token grant.
-- Page consent and route evidence remain bound to the user's one-use attempt;
-- no project grant or project identifier is introduced.
ALTER TABLE "PersonalKnowledgeExtractionAttempt"
  ADD COLUMN "visionPageCount" INTEGER,
  ADD COLUMN "visionPageManifest" JSONB,
  ADD COLUMN "billingMode" VARCHAR(16) NOT NULL DEFAULT 'byok',
  ADD COLUMN "platformRouteId" UUID,
  ADD COLUMN "platformRouteVersion" INTEGER,
  ADD COLUMN "platformRouteUpdatedAt" TIMESTAMP(3),
  ADD COLUMN "platformQuotaMultiplierBps" INTEGER,
  ADD COLUMN "platformMaxOutputTokens" INTEGER,
  ADD COLUMN "visionMaxOutputTokens" INTEGER,
  ADD COLUMN "platformRouteFenceFingerprint" CHAR(64),
  ADD CONSTRAINT "PersonalKnowledgeExtractionAttempt_vision_billing_check" CHECK (
    "billingMode" IN ('byok', 'platform')
    AND (
      ("operation" = 'graph' AND "billingMode" = 'byok'
        AND "visionPageCount" IS NULL AND "visionPageManifest" IS NULL
        AND "platformMaxOutputTokens" IS NULL AND "visionMaxOutputTokens" IS NULL
        AND "platformRouteId" IS NULL AND "platformRouteVersion" IS NULL
        AND "platformRouteUpdatedAt" IS NULL AND "platformQuotaMultiplierBps" IS NULL
        AND "platformRouteFenceFingerprint" IS NULL)
      OR ("operation" = 'vision' AND (
        ("visionPageCount" IS NULL AND "visionPageManifest" IS NULL AND "billingMode" = 'byok'
          AND "platformMaxOutputTokens" IS NULL AND "visionMaxOutputTokens" IS NULL
          AND "platformRouteId" IS NULL AND "platformRouteVersion" IS NULL
          AND "platformRouteUpdatedAt" IS NULL AND "platformQuotaMultiplierBps" IS NULL
          AND "platformRouteFenceFingerprint" IS NULL)
        OR ("visionPageCount" IS NOT NULL AND "visionPageManifest" IS NOT NULL
          AND "visionPageCount" BETWEEN 1 AND 3
          AND jsonb_typeof("visionPageManifest") = 'array'
          AND jsonb_array_length("visionPageManifest") = "visionPageCount"
          AND "billingMode" = 'byok'
          AND "platformMaxOutputTokens" IS NULL
          AND "visionMaxOutputTokens" IS NOT NULL AND "visionMaxOutputTokens" = 2048
          AND "platformRouteId" IS NULL AND "platformRouteVersion" IS NULL
          AND "platformRouteUpdatedAt" IS NULL AND "platformQuotaMultiplierBps" IS NULL
          AND "platformRouteFenceFingerprint" IS NULL)
        OR ("visionPageCount" IS NOT NULL AND "visionPageManifest" IS NOT NULL
          AND "visionPageCount" BETWEEN 1 AND 3
          AND jsonb_typeof("visionPageManifest") = 'array'
          AND jsonb_array_length("visionPageManifest") = "visionPageCount"
          AND "billingMode" = 'platform'
          AND "platformRouteId" IS NOT NULL
          AND "platformRouteVersion" IS NOT NULL
          AND "platformRouteVersion" > 0
          AND "platformRouteUpdatedAt" IS NOT NULL
          AND "platformQuotaMultiplierBps" IS NOT NULL
          AND "platformQuotaMultiplierBps" BETWEEN 1 AND 100000
          AND "platformMaxOutputTokens" IS NOT NULL AND "platformMaxOutputTokens" BETWEEN 1 AND 4096
          AND "visionMaxOutputTokens" IS NOT NULL AND "visionMaxOutputTokens" = LEAST("platformMaxOutputTokens", 2048)
          AND "platformRouteFenceFingerprint" IS NOT NULL
          AND "platformRouteFenceFingerprint" ~ '^[0-9a-f]{64}$')
      ))
    )
  );

ALTER TABLE "PlatformTokenReservation"
  ADD COLUMN "personalKnowledgeExtractionAttemptId" UUID,
  ADD COLUMN "personalKnowledgeExtractionPageIndex" INTEGER,
  ADD CONSTRAINT "PlatformTokenReservation_personal_extraction_attempt_fkey"
    FOREIGN KEY ("userId", "personalKnowledgeExtractionAttemptId")
    REFERENCES "PersonalKnowledgeExtractionAttempt" ("ownerUserId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;
CREATE UNIQUE INDEX "PlatformTokenReservation_personal_extraction_page_key"
  ON "PlatformTokenReservation" ("userId", "personalKnowledgeExtractionAttemptId", "personalKnowledgeExtractionPageIndex");

CREATE FUNCTION "personal_vision_token_reservation_guard"()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  expected_attempt_id UUID;
  expected_page_index INTEGER;
  proof "PersonalKnowledgeExtractionAttempt"%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD."personalKnowledgeExtractionAttemptId" IS DISTINCT FROM NEW."personalKnowledgeExtractionAttemptId"
      OR OLD."personalKnowledgeExtractionPageIndex" IS DISTINCT FROM NEW."personalKnowledgeExtractionPageIndex" THEN
      RAISE EXCEPTION 'personal vision reservation binding is immutable' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."callKey" NOT LIKE 'personal-vision:%' THEN
    IF NEW."personalKnowledgeExtractionAttemptId" IS NOT NULL OR NEW."personalKnowledgeExtractionPageIndex" IS NOT NULL THEN
      RAISE EXCEPTION 'personal vision reservation key mismatch' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."callKey" !~ '^personal-vision:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[1-3]$' THEN
    RAISE EXCEPTION 'invalid personal vision reservation key' USING ERRCODE = 'check_violation';
  END IF;
  expected_attempt_id := substring(NEW."callKey" from 17 for 36)::uuid;
  expected_page_index := substring(NEW."callKey" from 54)::integer;
  IF (NEW."personalKnowledgeExtractionAttemptId" IS NOT NULL AND NEW."personalKnowledgeExtractionAttemptId" IS DISTINCT FROM expected_attempt_id)
    OR (NEW."personalKnowledgeExtractionPageIndex" IS NOT NULL AND NEW."personalKnowledgeExtractionPageIndex" IS DISTINCT FROM expected_page_index) THEN
    RAISE EXCEPTION 'personal vision reservation key binding mismatch' USING ERRCODE = 'check_violation';
  END IF;
  NEW."personalKnowledgeExtractionAttemptId" := expected_attempt_id;
  NEW."personalKnowledgeExtractionPageIndex" := expected_page_index;
  SELECT * INTO proof FROM "PersonalKnowledgeExtractionAttempt"
    WHERE "id" = expected_attempt_id AND "ownerUserId" = NEW."userId";
  IF NOT FOUND OR proof."operation" <> 'vision' OR proof."billingMode" <> 'platform'
    OR proof."status" <> 'running' OR proof."consumedAt" IS NULL
    OR proof."visionPageCount" IS NULL OR expected_page_index > proof."visionPageCount"
    OR proof."visionPageManifest" IS NULL
    OR proof."platformMaxOutputTokens" IS NULL OR proof."platformMaxOutputTokens" NOT BETWEEN 1 AND 4096
    OR proof."visionMaxOutputTokens" IS DISTINCT FROM LEAST(proof."platformMaxOutputTokens", 2048)
    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(proof."visionPageManifest") page
      WHERE page->>'pageIndex' = expected_page_index::text
        AND jsonb_typeof(page->'ordinal') = 'number'
        AND (page->>'ordinal')::integer >= 0
        AND (page->'pageNumber' = 'null'::jsonb
          OR (jsonb_typeof(page->'pageNumber') = 'number' AND (page->>'pageNumber')::integer >= 1))
        AND jsonb_typeof(page->'locatorLabel') = 'string'
        AND length(page->>'locatorLabel') BETWEEN 1 AND 200)
    OR NEW."providerConnectionId" IS DISTINCT FROM proof."providerConnectionId"
    OR NEW."providerConfigurationVersion" IS DISTINCT FROM proof."providerConfigurationVersion"
    OR NEW."modelId" IS DISTINCT FROM proof."modelId"
    OR NEW."operation" <> 'visionExtract'
    OR NEW."routeSource" IS DISTINCT FROM 'platform_default'
    OR NEW."routeId" IS DISTINCT FROM proof."platformRouteId"
    OR NEW."routeVersion" IS DISTINCT FROM proof."platformRouteVersion"
    OR NEW."routeUpdatedAt" IS DISTINCT FROM proof."platformRouteUpdatedAt"
    OR NEW."quotaMultiplierBps" IS DISTINCT FROM proof."platformQuotaMultiplierBps"
    OR NEW."routeFenceFingerprint" IS DISTINCT FROM proof."platformRouteFenceFingerprint"
    OR NOT EXISTS (
      SELECT 1 FROM "PlatformDefaultAiRoute" r JOIN "AiProviderConnection" p ON p."id" = r."providerConnectionId"
        JOIN "ExternalCredential" c ON c."id" = p."credentialId"
      WHERE r."id" = proof."platformRouteId" AND r."operation" = 'visionExtract'
        AND r."status" = 'active' AND r."version" = proof."platformRouteVersion"
        AND r."version" = (SELECT max(active."version") FROM "PlatformDefaultAiRoute" active
          WHERE active."operation" = 'visionExtract' AND active."status" = 'active')
        AND r."updatedAt" = proof."platformRouteUpdatedAt"
        AND r."quotaMultiplierBps" = proof."platformQuotaMultiplierBps"
        AND r."maxOutputTokens" = proof."platformMaxOutputTokens"
        AND r."validatedAt" IS NOT NULL
        AND r."validatedProviderConfigurationVersion" = proof."providerConfigurationVersion"
        AND r."modelId" = proof."modelId" AND r."embeddingDimensions" IS NULL
        AND p."id" = proof."providerConnectionId" AND p."scope" = 'platform' AND p."ownerUserId" IS NULL
        AND p."protocol" = 'chat_completions' AND p."status" = 'verified' AND p."disabledAt" IS NULL
        AND p."configurationVersion" = proof."providerConfigurationVersion"
        AND p."defaultVisionModelId" = proof."modelId"
        AND p."baseUrl" = CASE p."kind"
          WHEN 'openai' THEN 'https://api.openai.com/v1'
          WHEN 'deepseek' THEN 'https://api.deepseek.com'
          WHEN 'qwen' THEN 'https://dashscope.aliyuncs.com/compatible-mode/v1'
          WHEN 'glm' THEN 'https://open.bigmodel.cn/api/paas/v4'
          ELSE NULL END
        AND (p."kind" <> 'deepseek' OR proof."modelId" IN ('deepseek-flash', 'deepseek-v4-flash-vision-exp'))
        AND c."kind" = 'ai_provider' AND c."secretFingerprint" = proof."credentialSecretFingerprint"
    )
  THEN
    RAISE EXCEPTION 'personal vision reservation requires matching consumed consent and route' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "PlatformTokenReservation_personal_vision_guard"
  BEFORE INSERT OR UPDATE ON "PlatformTokenReservation"
  FOR EACH ROW EXECUTE FUNCTION "personal_vision_token_reservation_guard"();
REVOKE ALL ON FUNCTION "personal_vision_token_reservation_guard"() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_project_os_runtime') THEN
    REVOKE ALL ON FUNCTION "personal_vision_token_reservation_guard"() FROM ai_project_os_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_project_os_entitlement_writer') THEN
    REVOKE ALL ON FUNCTION "personal_vision_token_reservation_guard"() FROM ai_project_os_entitlement_writer;
  END IF;
END $$;

ALTER TABLE "PlatformTokenReservation" DROP CONSTRAINT "PlatformTokenReservation_raw_billing_check",
  ADD CONSTRAINT "PlatformTokenReservation_raw_billing_check" CHECK (
    (
      "routeSource" IS NULL AND "routeId" IS NULL AND "routeVersion" IS NULL
      AND "routeUpdatedAt" IS NULL AND "providerConfigurationVersion" IS NULL
      AND "routeFenceFingerprint" IS NULL AND "webAiGrantId" IS NULL
      AND "webAiGrantReferenceId" IS NULL AND "webAiGrantProjectId" IS NULL
      AND "personalKnowledgeSemanticChallengeId" IS NULL
      AND "personalKnowledgeExtractionAttemptId" IS NULL AND "personalKnowledgeExtractionPageIndex" IS NULL
      AND "quotaMultiplierBps" = 10000
      AND "rawEstimatedTokens" = "reservedTokens" AND "reservedTokens" > 0
      AND ("rawSettledTokens" IS NULL OR ("settledTokens" IS NOT NULL AND "rawSettledTokens" = "settledTokens" AND "rawSettledTokens" >= 0))
    )
    OR (
      "rawEstimatedTokens" > 0 AND "rawEstimatedTokens" <= 10000000
      AND "reservedTokens" > 0 AND "reservedTokens" <= 1000000000
      AND "quotaMultiplierBps" BETWEEN 1 AND 100000
      AND "reservedTokens"::bigint = (("rawEstimatedTokens"::bigint * "quotaMultiplierBps"::bigint + 9999) / 10000)
      AND "routeSource" IN ('project_override', 'platform_default') AND "routeSource" IS NOT NULL
      AND (
        ("webAiGrantReferenceId" IS NOT NULL AND "webAiGrantProjectId" IS NOT NULL
          AND "personalKnowledgeSemanticChallengeId" IS NULL AND "personalKnowledgeExtractionAttemptId" IS NULL
          AND "personalKnowledgeExtractionPageIndex" IS NULL)
        OR ("personalKnowledgeSemanticChallengeId" IS NOT NULL AND "webAiGrantId" IS NULL
          AND "webAiGrantReferenceId" IS NULL AND "webAiGrantProjectId" IS NULL AND "jobId" IS NULL
          AND "personalKnowledgeExtractionAttemptId" IS NULL AND "personalKnowledgeExtractionPageIndex" IS NULL
          AND "operation" = 'embedding' AND "routeSource" = 'platform_default'
          AND "callKey" = 'personal-semantic:' || "personalKnowledgeSemanticChallengeId"::text)
        OR ("personalKnowledgeExtractionAttemptId" IS NOT NULL AND "personalKnowledgeExtractionPageIndex" BETWEEN 1 AND 3
          AND "webAiGrantId" IS NULL AND "webAiGrantReferenceId" IS NULL AND "webAiGrantProjectId" IS NULL
          AND "personalKnowledgeSemanticChallengeId" IS NULL AND "jobId" IS NULL
          AND "operation" = 'visionExtract' AND "routeSource" = 'platform_default'
          AND "callKey" = 'personal-vision:' || "personalKnowledgeExtractionAttemptId"::text || ':' || "personalKnowledgeExtractionPageIndex"::text)
      )
      AND "providerConnectionId" IS NOT NULL AND "routeUpdatedAt" IS NOT NULL
      AND "providerConfigurationVersion" IS NOT NULL AND "providerConfigurationVersion" > 0
      AND "routeFenceFingerprint" IS NOT NULL AND "routeFenceFingerprint" ~ '^[0-9a-f]{64}$'
      AND (("routeSource" = 'platform_default' AND "routeId" IS NOT NULL AND "routeVersion" IS NOT NULL AND "routeVersion" > 0)
        OR ("routeSource" = 'project_override' AND "routeId" IS NULL AND "routeVersion" IS NULL))
      AND ("rawSettledTokens" IS NULL OR ("rawSettledTokens" BETWEEN 0 AND 10000000 AND "settledTokens" IS NOT NULL
        AND "settledTokens"::bigint = (("rawSettledTokens"::bigint * "quotaMultiplierBps"::bigint + 9999) / 10000)))
    )
  );


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
    -- Personal visual pages retain the consumed attempt identity through settlement and recovery.
    IF reservation_final."personalKnowledgeExtractionAttemptId" IS NOT NULL THEN
      IF reservation_final."webAiGrantId" IS NOT NULL OR reservation_final."webAiGrantReferenceId" IS NOT NULL
        OR reservation_final."webAiGrantProjectId" IS NOT NULL OR reservation_final."personalKnowledgeSemanticChallengeId" IS NOT NULL
        OR reservation_final."jobId" IS NOT NULL
        OR reservation_final."personalKnowledgeExtractionPageIndex" NOT BETWEEN 1 AND 3
        OR reservation_final."routeSource" IS DISTINCT FROM 'platform_default'
        OR reservation_final."operation" <> 'visionExtract'
        OR reservation_final."callKey" IS DISTINCT FROM 'personal-vision:' || reservation_final."personalKnowledgeExtractionAttemptId"::text || ':' || reservation_final."personalKnowledgeExtractionPageIndex"::text
        OR NOT EXISTS (SELECT 1 FROM "PersonalKnowledgeExtractionAttempt" a
          WHERE a."id" = reservation_final."personalKnowledgeExtractionAttemptId"
            AND a."ownerUserId" = reservation_final."userId"
            AND a."operation" = 'vision' AND a."billingMode" = 'platform'
            AND a."status" IN ('running', 'succeeded', 'failed', 'unknown') AND a."consumedAt" IS NOT NULL
            AND reservation_final."personalKnowledgeExtractionPageIndex" <= a."visionPageCount"
            AND a."providerConnectionId" = reservation_final."providerConnectionId"
            AND a."providerConfigurationVersion" = reservation_final."providerConfigurationVersion"
            AND a."modelId" = reservation_final."modelId"
            AND a."platformRouteId" = reservation_final."routeId"
            AND a."platformRouteVersion" = reservation_final."routeVersion"
            AND a."platformRouteUpdatedAt" = reservation_final."routeUpdatedAt"
            AND a."platformQuotaMultiplierBps" = reservation_final."quotaMultiplierBps"
            AND a."platformMaxOutputTokens" BETWEEN 1 AND 4096
            AND a."visionMaxOutputTokens" = LEAST(a."platformMaxOutputTokens", 2048)
            AND a."platformRouteFenceFingerprint" = reservation_final."routeFenceFingerprint"
            AND EXISTS (SELECT 1 FROM jsonb_array_elements(a."visionPageManifest") page
              WHERE page->>'pageIndex' = reservation_final."personalKnowledgeExtractionPageIndex"::text)) THEN
        RAISE EXCEPTION 'personal vision reservation evidence mismatch' USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END IF;
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
