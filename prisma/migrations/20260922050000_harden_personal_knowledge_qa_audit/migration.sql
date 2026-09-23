-- P03b.1 S4 repair: a QA audit starts as running and may settle exactly once.
-- The existing QA migration already protects identity fields and requires the
-- service mutation context. This additive replacement closes the terminal
-- rewrite path without changing the applied base migration.

CREATE OR REPLACE FUNCTION "personal_knowledge_qa_audit_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF current_setting('app.personal_knowledge_qa_mutation_context', true) IS DISTINCT FROM 'service-v1' THEN
    RAISE EXCEPTION 'personal knowledge QA audit mutation requires service context' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'personal knowledge QA audits are append-only' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' AND (
    NEW."status" IS DISTINCT FROM 'running'::"PersonalKnowledgeQaAuditStatus"
    OR NEW."completedAt" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'personal knowledge QA audits must start running' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    OLD."id" IS DISTINCT FROM NEW."id"
    OR OLD."ownerUserId" IS DISTINCT FROM NEW."ownerUserId"
    OR OLD."challengeId" IS DISTINCT FROM NEW."challengeId"
    OR OLD."documentId" IS DISTINCT FROM NEW."documentId"
    OR OLD."revisionId" IS DISTINCT FROM NEW."revisionId"
    OR OLD."documentVersion" IS DISTINCT FROM NEW."documentVersion"
    OR OLD."contentHash" IS DISTINCT FROM NEW."contentHash"
    OR OLD."questionHash" IS DISTINCT FROM NEW."questionHash"
    OR OLD."evidenceManifest" IS DISTINCT FROM NEW."evidenceManifest"
    OR OLD."providerConnectionId" IS DISTINCT FROM NEW."providerConnectionId"
    OR OLD."providerConfigurationVersion" IS DISTINCT FROM NEW."providerConfigurationVersion"
    OR OLD."modelId" IS DISTINCT FROM NEW."modelId"
    OR OLD."credentialSecretFingerprint" IS DISTINCT FROM NEW."credentialSecretFingerprint"
    OR OLD."actorAccountAccessVersion" IS DISTINCT FROM NEW."actorAccountAccessVersion"
    OR OLD."createdAt" IS DISTINCT FROM NEW."createdAt"
  ) THEN
    RAISE EXCEPTION 'personal knowledge QA audit identity is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    OLD."status" IS DISTINCT FROM 'running'::"PersonalKnowledgeQaAuditStatus"
    OR OLD."completedAt" IS NOT NULL
    OR NEW."status" IS DISTINCT FROM 'succeeded'::"PersonalKnowledgeQaAuditStatus"
      AND NEW."status" IS DISTINCT FROM 'failed'::"PersonalKnowledgeQaAuditStatus"
      AND NEW."status" IS DISTINCT FROM 'unknown'::"PersonalKnowledgeQaAuditStatus"
    OR NEW."completedAt" IS NULL
  ) THEN
    RAISE EXCEPTION 'personal knowledge QA audit may settle exactly once' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
