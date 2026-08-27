-- Bind every enabled AI operation to its own immutable provider/model profile.
-- Existing revisions are upgraded only when their operation grants provide one
-- unambiguous profile; otherwise deployment stops instead of guessing.

CREATE TABLE "ProjectAiPolicyOperationProfile" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "policyRevisionId" UUID NOT NULL,
    "operation" "AiOperation" NOT NULL,
    "profileFingerprint" VARCHAR(64) NOT NULL,
    "providerFingerprint" VARCHAR(64) NOT NULL,
    "modelFingerprint" VARCHAR(64) NOT NULL,
    "modelId" VARCHAR(128) NOT NULL,
    "processorFingerprint" VARCHAR(64) NOT NULL,
    "regionFingerprint" VARCHAR(64) NOT NULL,
    "retentionFingerprint" VARCHAR(64) NOT NULL,
    "endpointFingerprint" VARCHAR(64) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectAiPolicyOperationProfile_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ProjectAiPolicyOperationProfile_fingerprints_check" CHECK (
        "profileFingerprint" ~ '^[0-9a-f]{64}$'
        AND "providerFingerprint" ~ '^[0-9a-f]{64}$'
        AND "modelFingerprint" ~ '^[0-9a-f]{64}$'
        AND "processorFingerprint" ~ '^[0-9a-f]{64}$'
        AND "regionFingerprint" ~ '^[0-9a-f]{64}$'
        AND "retentionFingerprint" ~ '^[0-9a-f]{64}$'
        AND "endpointFingerprint" ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT "ProjectAiPolicyOperationProfile_modelId_check" CHECK (
        "modelId" ~ '^[A-Za-z0-9._:/@-]{1,128}$'
        AND "modelId" !~* '(https?://|api[-_]?key|bearer|password|secret|token|sk-)'
        AND "modelId" !~* '(^|[/:@_-])latest($|[/:@_-])'
    )
);

CREATE UNIQUE INDEX "ProjectAiPolicyOperationProfile_projectId_id_key"
ON "ProjectAiPolicyOperationProfile"("projectId", "id");

CREATE UNIQUE INDEX "ProjectAiPolicyOperationProfile_projectId_policyRevisionId__key"
ON "ProjectAiPolicyOperationProfile"("projectId", "policyRevisionId", "operation");

CREATE INDEX "ProjectAiPolicyOperationProfile_projectId_policyRevisionId_idx"
ON "ProjectAiPolicyOperationProfile"("projectId", "policyRevisionId");

ALTER TABLE "ProjectAiPolicyOperationProfile"
ADD CONSTRAINT "ProjectAiPolicyOperationProfile_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "Project"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProjectAiPolicyOperationProfile"
ADD CONSTRAINT "ProjectAiPolicyOperationProfile_projectId_policyRevisionId_fkey"
FOREIGN KEY ("projectId", "policyRevisionId")
REFERENCES "ProjectAiPolicyRevision"("projectId", "id")
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM "ModelProcessingGrant" AS g
        LEFT JOIN "ModelProcessingGrantOperation" AS op
          ON op."projectId" = g."projectId"
         AND op."grantId" = g."id"
        GROUP BY g."projectId", g."id"
        HAVING COUNT(op."id") <> 1
    ) THEN
        RAISE EXCEPTION 'cannot infer operation profile: every existing grant must have exactly one operation';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM "ProjectAiPolicyRevision" AS r
        CROSS JOIN LATERAL (
            VALUES
                ('embedding'::"AiOperation", r."embeddingEnabled"),
                ('autoExtract'::"AiOperation", r."autoExtractEnabled"),
                ('sourceSummary'::"AiOperation", r."sourceSummaryEnabled"),
                ('projectAnalysis'::"AiOperation", r."projectAnalysisEnabled"),
                ('generateWithContext'::"AiOperation", r."generateWithContextEnabled")
        ) AS expected("operation", "enabled")
        WHERE expected."enabled"
          AND NOT EXISTS (
              SELECT 1
              FROM "ModelProcessingGrant" AS g
              JOIN "ModelProcessingGrantOperation" AS op
                ON op."projectId" = g."projectId"
               AND op."grantId" = g."id"
               AND op."operation" = expected."operation"
              WHERE g."projectId" = r."projectId"
                AND g."policyRevisionId" = r."id"
          )
    ) THEN
        RAISE EXCEPTION 'cannot infer enabled operation profile from existing grants';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM "ModelProcessingGrant" AS g
        JOIN "ModelProcessingGrantOperation" AS op
          ON op."projectId" = g."projectId"
         AND op."grantId" = g."id"
        GROUP BY g."projectId", g."policyRevisionId", op."operation"
        HAVING COUNT(DISTINCT ROW(
            g."profileFingerprint",
            g."providerFingerprint",
            g."modelFingerprint",
            g."modelId",
            g."processorFingerprint",
            g."regionFingerprint",
            g."retentionFingerprint",
            g."endpointFingerprint"
        )) > 1
    ) THEN
        RAISE EXCEPTION 'cannot infer operation profile: existing grants disagree';
    END IF;
END;
$$;

INSERT INTO "ProjectAiPolicyOperationProfile" (
    "id",
    "projectId",
    "policyRevisionId",
    "operation",
    "profileFingerprint",
    "providerFingerprint",
    "modelFingerprint",
    "modelId",
    "processorFingerprint",
    "regionFingerprint",
    "retentionFingerprint",
    "endpointFingerprint"
)
SELECT DISTINCT ON (g."projectId", g."policyRevisionId", op."operation")
    gen_random_uuid(),
    g."projectId",
    g."policyRevisionId",
    op."operation",
    g."profileFingerprint",
    g."providerFingerprint",
    g."modelFingerprint",
    g."modelId",
    g."processorFingerprint",
    g."regionFingerprint",
    g."retentionFingerprint",
    g."endpointFingerprint"
FROM "ModelProcessingGrant" AS g
JOIN "ModelProcessingGrantOperation" AS op
  ON op."projectId" = g."projectId"
 AND op."grantId" = g."id"
ORDER BY g."projectId", g."policyRevisionId", op."operation", g."id";

CREATE UNIQUE INDEX "ModelProcessingGrantOperation_projectId_grantId_key"
ON "ModelProcessingGrantOperation"("projectId", "grantId");

CREATE OR REPLACE FUNCTION "ai_policy_operation_profile_immutable_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    operation_allowed BOOLEAN;
    revision_is_current BOOLEAN;
BEGIN
    IF TG_OP = 'INSERT' THEN
        SELECT
            CASE NEW."operation"
                WHEN 'embedding' THEN r."embeddingEnabled"
                WHEN 'autoExtract' THEN r."autoExtractEnabled"
                WHEN 'sourceSummary' THEN r."sourceSummaryEnabled"
                WHEN 'projectAnalysis' THEN r."projectAnalysisEnabled"
                WHEN 'generateWithContext' THEN r."generateWithContextEnabled"
                ELSE FALSE
            END,
            EXISTS (
                SELECT 1
                FROM "ProjectAiPolicy" AS p
                WHERE p."projectId" = NEW."projectId"
                  AND p."currentRevisionId" = NEW."policyRevisionId"
            )
        INTO operation_allowed, revision_is_current
        FROM "ProjectAiPolicyRevision" AS r
        WHERE r."projectId" = NEW."projectId"
          AND r."id" = NEW."policyRevisionId";

        IF operation_allowed IS NOT TRUE THEN
            RAISE EXCEPTION 'operation profile is not enabled by policy revision'
                USING ERRCODE = 'check_violation';
        END IF;
        IF revision_is_current IS TRUE THEN
            RAISE EXCEPTION 'current policy operation profiles are sealed'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;

    IF EXISTS (
        SELECT 1 FROM "Project"
        WHERE "id" = OLD."projectId"
    ) THEN
        RAISE EXCEPTION 'operation profile is immutable'
            USING ERRCODE = 'check_violation';
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "ProjectAiPolicyOperationProfile_immutable_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "ProjectAiPolicyOperationProfile"
FOR EACH ROW EXECUTE FUNCTION "ai_policy_operation_profile_immutable_guard"();

CREATE OR REPLACE FUNCTION "ai_policy_current_revision_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    old_revision INTEGER;
    new_revision INTEGER;
    expected_profile_count INTEGER;
    actual_profile_count INTEGER;
BEGIN
    IF TG_OP = 'UPDATE' AND NEW."projectId" IS DISTINCT FROM OLD."projectId" THEN
        RAISE EXCEPTION 'policy project is immutable' USING ERRCODE = 'check_violation';
    END IF;

    SELECT
        r."revision",
        r."embeddingEnabled"::INTEGER
            + r."autoExtractEnabled"::INTEGER
            + r."sourceSummaryEnabled"::INTEGER
            + r."projectAnalysisEnabled"::INTEGER
            + r."generateWithContextEnabled"::INTEGER
    INTO new_revision, expected_profile_count
    FROM "ProjectAiPolicyRevision" AS r
    WHERE r."projectId" = NEW."projectId"
      AND r."id" = NEW."currentRevisionId";

    IF new_revision IS NULL OR new_revision <= 0 THEN
        RAISE EXCEPTION 'invalid current policy revision' USING ERRCODE = 'check_violation';
    END IF;

    SELECT COUNT(*) INTO actual_profile_count
    FROM "ProjectAiPolicyOperationProfile" AS op
    WHERE op."projectId" = NEW."projectId"
      AND op."policyRevisionId" = NEW."currentRevisionId";

    IF actual_profile_count IS DISTINCT FROM expected_profile_count
        OR EXISTS (
            SELECT 1
            FROM "ProjectAiPolicyOperationProfile" AS op
            JOIN "ProjectAiPolicyRevision" AS r
              ON r."projectId" = op."projectId"
             AND r."id" = op."policyRevisionId"
            WHERE op."projectId" = NEW."projectId"
              AND op."policyRevisionId" = NEW."currentRevisionId"
              AND NOT CASE op."operation"
                  WHEN 'embedding' THEN r."embeddingEnabled"
                  WHEN 'autoExtract' THEN r."autoExtractEnabled"
                  WHEN 'sourceSummary' THEN r."sourceSummaryEnabled"
                  WHEN 'projectAnalysis' THEN r."projectAnalysisEnabled"
                  WHEN 'generateWithContext' THEN r."generateWithContextEnabled"
                  ELSE FALSE
              END
        ) THEN
        RAISE EXCEPTION 'policy operation profiles are incomplete'
            USING ERRCODE = 'check_violation';
    END IF;

    IF TG_OP = 'UPDATE' AND NEW."currentRevisionId" <> OLD."currentRevisionId" THEN
        SELECT "revision" INTO old_revision
        FROM "ProjectAiPolicyRevision"
        WHERE "projectId" = OLD."projectId" AND "id" = OLD."currentRevisionId";
        IF old_revision IS NULL OR new_revision <= old_revision THEN
            RAISE EXCEPTION 'policy revision must advance' USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "ai_grant_revision_snapshot_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    bound_revision INTEGER;
    bound_budget VARCHAR(64);
    bound_scanner VARCHAR(64);
    bound_operation "AiOperation";
    bound_profile VARCHAR(64);
    bound_provider VARCHAR(64);
    bound_model VARCHAR(64);
    bound_model_id VARCHAR(128);
    bound_processor VARCHAR(64);
    bound_region VARCHAR(64);
    bound_retention VARCHAR(64);
    bound_endpoint VARCHAR(64);
BEGIN
    SELECT r."revision", r."budgetFingerprint", r."scannerFingerprint"
    INTO bound_revision, bound_budget, bound_scanner
    FROM "ProjectAiPolicyRevision" AS r
    WHERE r."projectId" = NEW."projectId"
      AND r."id" = NEW."policyRevisionId";

    IF bound_revision IS NULL
        OR NEW."effectivePolicyVersion" IS DISTINCT FROM bound_revision
        OR NEW."budgetFingerprint" IS DISTINCT FROM bound_budget
        OR NEW."scannerFingerprint" IS DISTINCT FROM bound_scanner THEN
        RAISE EXCEPTION 'grant policy revision mismatch' USING ERRCODE = 'check_violation';
    END IF;

    SELECT op."operation" INTO bound_operation
    FROM "ModelProcessingGrantOperation" AS op
    WHERE op."projectId" = NEW."projectId"
      AND op."grantId" = NEW."id";

    IF FOUND THEN
        SELECT
            p."profileFingerprint",
            p."providerFingerprint",
            p."modelFingerprint",
            p."modelId",
            p."processorFingerprint",
            p."regionFingerprint",
            p."retentionFingerprint",
            p."endpointFingerprint"
        INTO
            bound_profile,
            bound_provider,
            bound_model,
            bound_model_id,
            bound_processor,
            bound_region,
            bound_retention,
            bound_endpoint
        FROM "ProjectAiPolicyOperationProfile" AS p
        WHERE p."projectId" = NEW."projectId"
          AND p."policyRevisionId" = NEW."policyRevisionId"
          AND p."operation" = bound_operation;

        IF bound_profile IS NULL
            OR NEW."profileFingerprint" IS DISTINCT FROM bound_profile
            OR NEW."providerFingerprint" IS DISTINCT FROM bound_provider
            OR NEW."modelFingerprint" IS DISTINCT FROM bound_model
            OR NEW."modelId" IS DISTINCT FROM bound_model_id
            OR NEW."processorFingerprint" IS DISTINCT FROM bound_processor
            OR NEW."regionFingerprint" IS DISTINCT FROM bound_region
            OR NEW."retentionFingerprint" IS DISTINCT FROM bound_retention
            OR NEW."endpointFingerprint" IS DISTINCT FROM bound_endpoint THEN
            RAISE EXCEPTION 'grant operation profile mismatch' USING ERRCODE = 'check_violation';
        END IF;
    ELSIF NEW."status" <> 'draft' THEN
        RAISE EXCEPTION 'grant operation profile is missing' USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "ai_grant_scope_draft_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_project_id UUID;
    target_grant_id UUID;
    previous_project_id UUID;
    previous_grant_id UUID;
    grant_status "ModelProcessingGrantStatus";
    previous_grant_status "ModelProcessingGrantStatus";
    operation_allowed BOOLEAN;
BEGIN
    IF TG_OP = 'DELETE' THEN
        target_project_id := OLD."projectId";
        target_grant_id := OLD."grantId";
    ELSIF TG_OP = 'UPDATE' THEN
        target_project_id := NEW."projectId";
        target_grant_id := NEW."grantId";
        previous_project_id := OLD."projectId";
        previous_grant_id := OLD."grantId";
    ELSE
        target_project_id := NEW."projectId";
        target_grant_id := NEW."grantId";
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM "Project"
        WHERE "id" = target_project_id
    ) THEN
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
    END IF;

    IF TG_OP = 'UPDATE'
        AND (NEW."projectId" IS DISTINCT FROM OLD."projectId"
            OR NEW."grantId" IS DISTINCT FROM OLD."grantId") THEN
        RAISE EXCEPTION 'grant scope identity is immutable' USING ERRCODE = 'check_violation';
    END IF;

    IF TG_OP = 'UPDATE' AND EXISTS (
        SELECT 1 FROM "Project"
        WHERE "id" = previous_project_id
    ) THEN
        SELECT "status" INTO previous_grant_status
        FROM "ModelProcessingGrant"
        WHERE "projectId" = previous_project_id AND "id" = previous_grant_id;
        IF previous_grant_status IS DISTINCT FROM 'draft' THEN
            RAISE EXCEPTION 'grant scope is sealed' USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    SELECT "status" INTO grant_status
    FROM "ModelProcessingGrant"
    WHERE "projectId" = target_project_id AND "id" = target_grant_id;

    IF grant_status IS DISTINCT FROM 'draft' THEN
        RAISE EXCEPTION 'grant scope is sealed' USING ERRCODE = 'check_violation';
    END IF;

    IF TG_TABLE_NAME = 'ModelProcessingGrantOperation' AND TG_OP <> 'DELETE' THEN
        SELECT EXISTS (
            SELECT 1
            FROM "ModelProcessingGrant" AS g
            JOIN "ProjectAiPolicyOperationProfile" AS p
              ON p."projectId" = g."projectId"
             AND p."policyRevisionId" = g."policyRevisionId"
             AND p."operation" = NEW."operation"
            WHERE g."projectId" = NEW."projectId"
              AND g."id" = NEW."grantId"
              AND g."profileFingerprint" = p."profileFingerprint"
              AND g."providerFingerprint" = p."providerFingerprint"
              AND g."modelFingerprint" = p."modelFingerprint"
              AND g."modelId" = p."modelId"
              AND g."processorFingerprint" = p."processorFingerprint"
              AND g."regionFingerprint" = p."regionFingerprint"
              AND g."retentionFingerprint" = p."retentionFingerprint"
              AND g."endpointFingerprint" = p."endpointFingerprint"
        ) INTO operation_allowed;

        IF operation_allowed IS NOT TRUE THEN
            RAISE EXCEPTION 'grant operation profile mismatch' USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "ai_grant_issuance_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    current_revision_id UUID;
    current_outbound_enabled BOOLEAN;
    operation_count INTEGER;
BEGIN
    IF TG_OP <> 'UPDATE' OR OLD."status" <> 'draft' OR NEW."status" <> 'issued' THEN
        RETURN NEW;
    END IF;

    SELECT p."currentRevisionId", r."outboundEnabled"
    INTO current_revision_id, current_outbound_enabled
    FROM "ProjectAiPolicy" AS p
    JOIN "ProjectAiPolicyRevision" AS r
      ON r."projectId" = p."projectId"
     AND r."id" = p."currentRevisionId"
    WHERE p."projectId" = NEW."projectId";

    IF current_revision_id IS NULL
        OR NEW."policyRevisionId" IS DISTINCT FROM current_revision_id
        OR current_outbound_enabled IS NOT TRUE THEN
        RAISE EXCEPTION 'grant policy is not issuable' USING ERRCODE = 'check_violation';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM "ModelProcessingGrantSource"
        WHERE "projectId" = NEW."projectId" AND "grantId" = NEW."id"
    ) THEN
        RAISE EXCEPTION 'grant scope is incomplete' USING ERRCODE = 'check_violation';
    END IF;

    SELECT COUNT(*) INTO operation_count
    FROM "ModelProcessingGrantOperation"
    WHERE "projectId" = NEW."projectId" AND "grantId" = NEW."id";

    IF operation_count <> 1 OR NOT EXISTS (
        SELECT 1
        FROM "ModelProcessingGrantOperation" AS op
        JOIN "ProjectAiPolicyOperationProfile" AS p
          ON p."projectId" = NEW."projectId"
         AND p."policyRevisionId" = NEW."policyRevisionId"
         AND p."operation" = op."operation"
        WHERE op."projectId" = NEW."projectId"
          AND op."grantId" = NEW."id"
          AND NEW."profileFingerprint" = p."profileFingerprint"
          AND NEW."providerFingerprint" = p."providerFingerprint"
          AND NEW."modelFingerprint" = p."modelFingerprint"
          AND NEW."modelId" = p."modelId"
          AND NEW."processorFingerprint" = p."processorFingerprint"
          AND NEW."regionFingerprint" = p."regionFingerprint"
          AND NEW."retentionFingerprint" = p."retentionFingerprint"
          AND NEW."endpointFingerprint" = p."endpointFingerprint"
    ) THEN
        RAISE EXCEPTION 'grant operation profile mismatch' USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "ai_run_revision_snapshot_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    bound_revision INTEGER;
    bound_provider VARCHAR(64);
    bound_model VARCHAR(64);
    bound_model_id VARCHAR(128);
    bound_profile VARCHAR(64);
    bound_grant VARCHAR(64);
    bound_processor VARCHAR(64);
    bound_endpoint VARCHAR(64);
    bound_region VARCHAR(64);
    bound_retention VARCHAR(64);
BEGIN
    SELECT
        r."revision",
        g."providerFingerprint",
        g."modelFingerprint",
        g."modelId",
        g."profileFingerprint",
        g."grantFingerprint",
        g."processorFingerprint",
        g."endpointFingerprint",
        g."regionFingerprint",
        g."retentionFingerprint"
    INTO
        bound_revision,
        bound_provider,
        bound_model,
        bound_model_id,
        bound_profile,
        bound_grant,
        bound_processor,
        bound_endpoint,
        bound_region,
        bound_retention
    FROM "ProjectAiPolicyRevision" AS r
    JOIN "ModelProcessingGrant" AS g
      ON g."projectId" = r."projectId"
     AND g."policyRevisionId" = r."id"
     AND g."id" = NEW."grantId"
    JOIN "ModelProcessingGrantOperation" AS op
      ON op."projectId" = g."projectId"
     AND op."grantId" = g."id"
     AND op."operation" = NEW."operation"
    JOIN "ProjectAiPolicyOperationProfile" AS p
      ON p."projectId" = r."projectId"
     AND p."policyRevisionId" = r."id"
     AND p."operation" = op."operation"
     AND p."profileFingerprint" = g."profileFingerprint"
     AND p."providerFingerprint" = g."providerFingerprint"
     AND p."modelFingerprint" = g."modelFingerprint"
     AND p."modelId" = g."modelId"
     AND p."processorFingerprint" = g."processorFingerprint"
     AND p."regionFingerprint" = g."regionFingerprint"
     AND p."retentionFingerprint" = g."retentionFingerprint"
     AND p."endpointFingerprint" = g."endpointFingerprint"
    WHERE r."projectId" = NEW."projectId"
      AND r."id" = NEW."policyRevisionId";

    IF bound_revision IS NULL
        OR NEW."effectivePolicyVersion" IS DISTINCT FROM bound_revision
        OR NEW."providerFingerprint" IS DISTINCT FROM bound_provider
        OR NEW."modelFingerprint" IS DISTINCT FROM bound_model
        OR NEW."modelId" IS DISTINCT FROM bound_model_id
        OR NEW."profileFingerprint" IS DISTINCT FROM bound_profile
        OR NEW."grantFingerprint" IS DISTINCT FROM bound_grant
        OR NEW."processorFingerprint" IS DISTINCT FROM bound_processor
        OR NEW."processorEndpointFingerprint" IS DISTINCT FROM bound_endpoint
        OR NEW."processorRegionFingerprint" IS DISTINCT FROM bound_region
        OR NEW."processorRetentionFingerprint" IS DISTINCT FROM bound_retention THEN
        RAISE EXCEPTION 'run policy revision mismatch' USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$;
