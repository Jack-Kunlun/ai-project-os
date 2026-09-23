-- Semantic dispatch audits are append-only in identity, while their bounded
-- status and provider outcome fields are settled exactly once by the service.
CREATE OR REPLACE FUNCTION "personal_knowledge_semantic_audit_immutable_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'personal knowledge semantic audits are append-only' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    OLD."id" IS DISTINCT FROM NEW."id"
    OR OLD."ownerUserId" IS DISTINCT FROM NEW."ownerUserId"
    OR OLD."challengeId" IS DISTINCT FROM NEW."challengeId"
    OR OLD."generationId" IS DISTINCT FROM NEW."generationId"
    OR OLD."kind" IS DISTINCT FROM NEW."kind"
    OR OLD."providerConnectionId" IS DISTINCT FROM NEW."providerConnectionId"
    OR OLD."providerConfigurationVersion" IS DISTINCT FROM NEW."providerConfigurationVersion"
    OR OLD."credentialSecretFingerprint" IS DISTINCT FROM NEW."credentialSecretFingerprint"
    OR OLD."modelId" IS DISTINCT FROM NEW."modelId"
    OR OLD."dimensions" IS DISTINCT FROM NEW."dimensions"
    OR OLD."corpusEpoch" IS DISTINCT FROM NEW."corpusEpoch"
    OR OLD."expectedEntryCount" IS DISTINCT FROM NEW."expectedEntryCount"
    OR OLD."createdAt" IS DISTINCT FROM NEW."createdAt"
  ) THEN
    RAISE EXCEPTION 'personal knowledge semantic audit identity is immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
