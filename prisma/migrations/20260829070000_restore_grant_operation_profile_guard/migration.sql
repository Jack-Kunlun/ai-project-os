CREATE OR REPLACE FUNCTION "ai_grant_operation_profile_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    operation_profile_matches BOOLEAN;
BEGIN
    SELECT EXISTS (
        SELECT 1
        FROM "ModelProcessingGrant" AS grant_row
        JOIN "ProjectAiPolicyOperationProfile" AS profile
          ON profile."projectId" = grant_row."projectId"
         AND profile."policyRevisionId" = grant_row."policyRevisionId"
         AND profile."operation" = NEW."operation"
        WHERE grant_row."projectId" = NEW."projectId"
          AND grant_row."id" = NEW."grantId"
          AND grant_row."profileFingerprint" = profile."profileFingerprint"
          AND grant_row."providerFingerprint" = profile."providerFingerprint"
          AND grant_row."modelFingerprint" = profile."modelFingerprint"
          AND grant_row."modelId" = profile."modelId"
          AND grant_row."processorFingerprint" = profile."processorFingerprint"
          AND grant_row."regionFingerprint" = profile."regionFingerprint"
          AND grant_row."retentionFingerprint" = profile."retentionFingerprint"
          AND grant_row."endpointFingerprint" = profile."endpointFingerprint"
    ) INTO operation_profile_matches;

    IF operation_profile_matches IS NOT TRUE THEN
        RAISE EXCEPTION 'grant operation profile mismatch'
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "ai_grant_operation_profile_guard_trigger"
ON "ModelProcessingGrantOperation";

CREATE TRIGGER "ai_grant_operation_profile_guard_trigger"
BEFORE INSERT OR UPDATE ON "ModelProcessingGrantOperation"
FOR EACH ROW
EXECUTE FUNCTION "ai_grant_operation_profile_guard"();
