-- Owner-reviewed entity relations are bound to immutable personal revisions.
-- AI candidates remain pending until the owner accepts or rejects each row.
ALTER TABLE "PersonalKnowledgeDocument"
  ADD COLUMN "isDefaultMemory" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "PersonalKnowledgeDocument_owner_default_idx"
  ON "PersonalKnowledgeDocument" ("ownerUserId", "state", "isDefaultMemory", "updatedAt", "id");

-- Extend the immutable audit's exact-key contract for default-memory flags.
CREATE OR REPLACE FUNCTION "personal_knowledge_audit_references_guard"()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  refs JSONB := NEW."references";
  revision_id_text TEXT;
  previous_revision_id_text TEXT;
  version_text TEXT;
  previous_version_text TEXT;
  format_text TEXT;
  reference_key_count INTEGER;
BEGIN
  IF jsonb_typeof(refs) <> 'object' THEN
    RAISE EXCEPTION 'PERSONAL_KNOWLEDGE_AUDIT_REFERENCES_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."event" NOT IN ('created', 'revised', 'deleted', 'exported') THEN
    RAISE EXCEPTION 'PERSONAL_KNOWLEDGE_AUDIT_EVENT_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*) INTO reference_key_count FROM jsonb_object_keys(refs);
  revision_id_text := refs ->> 'revisionId';
  IF NOT (CASE NEW."event"
      WHEN 'created' THEN reference_key_count IN (2, 3)
      WHEN 'revised' THEN reference_key_count IN (4, 6)
      WHEN 'exported' THEN reference_key_count = 3
      ELSE reference_key_count = 2 END)
    OR jsonb_typeof(refs -> 'revisionId') IS DISTINCT FROM 'string'
    OR revision_id_text IS NULL
    OR revision_id_text !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
    RAISE EXCEPTION 'PERSONAL_KNOWLEDGE_AUDIT_REFERENCES_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  version_text := refs ->> 'version';
  IF jsonb_typeof(refs -> 'version') IS DISTINCT FROM 'number'
     OR version_text IS NULL
     OR version_text !~ '^[1-9][0-9]*$'
     OR version_text::numeric > 2147483647 THEN
    RAISE EXCEPTION 'PERSONAL_KNOWLEDGE_AUDIT_REFERENCES_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."event" = 'created' AND reference_key_count = 3 THEN
    IF jsonb_typeof(refs -> 'isDefaultMemory') IS DISTINCT FROM 'boolean' THEN
      RAISE EXCEPTION 'PERSONAL_KNOWLEDGE_AUDIT_REFERENCES_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."event" = 'revised' THEN
    previous_revision_id_text := refs ->> 'previousRevisionId';
    previous_version_text := refs ->> 'previousVersion';
    IF jsonb_typeof(refs -> 'previousRevisionId') IS DISTINCT FROM 'string'
       OR previous_revision_id_text IS NULL
       OR previous_revision_id_text !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
       OR jsonb_typeof(refs -> 'previousVersion') IS DISTINCT FROM 'number'
       OR previous_version_text IS NULL
       OR previous_version_text !~ '^[1-9][0-9]*$'
       OR previous_version_text::numeric > 2147483647
       OR (reference_key_count = 6 AND (
         jsonb_typeof(refs -> 'isDefaultMemoryBefore') IS DISTINCT FROM 'boolean'
         OR jsonb_typeof(refs -> 'isDefaultMemoryAfter') IS DISTINCT FROM 'boolean'
       )) THEN
      RAISE EXCEPTION 'PERSONAL_KNOWLEDGE_AUDIT_REFERENCES_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."event" = 'exported' THEN
    format_text := refs ->> 'format';
    IF jsonb_typeof(refs -> 'format') IS DISTINCT FROM 'string'
       OR format_text IS NULL
       OR format_text NOT IN ('markdown', 'text') THEN
      RAISE EXCEPTION 'PERSONAL_KNOWLEDGE_AUDIT_REFERENCES_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE "PersonalKnowledgeGraphSuggestion" (
  "id" UUID NOT NULL,
  "ownerUserId" UUID NOT NULL,
  "documentId" UUID NOT NULL,
  "revisionId" UUID NOT NULL,
  "subject" VARCHAR(120) NOT NULL,
  "subjectKind" VARCHAR(24) NOT NULL,
  "predicate" VARCHAR(120) NOT NULL,
  "object" VARCHAR(120) NOT NULL,
  "objectKind" VARCHAR(24) NOT NULL,
  "evidence" VARCHAR(500) NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'pending',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reviewerUserId" UUID,
  "reviewedAt" TIMESTAMP(3),
  CONSTRAINT "PersonalKnowledgeGraphSuggestion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PersonalKnowledgeGraphSuggestion_text_check" CHECK (
    length(btrim("subject")) > 0 AND length(btrim("predicate")) > 0
    AND length(btrim("object")) > 0 AND length(btrim("evidence")) > 0
  ),
  CONSTRAINT "PersonalKnowledgeGraphSuggestion_kind_check" CHECK (
    "subjectKind" IN ('person', 'organization', 'concept', 'place', 'other')
    AND "objectKind" IN ('person', 'organization', 'concept', 'place', 'other')
  ),
  CONSTRAINT "PersonalKnowledgeGraphSuggestion_status_check" CHECK (
    ("status" = 'pending' AND "reviewedAt" IS NULL AND "reviewerUserId" IS NULL)
    OR ("status" IN ('accepted', 'rejected') AND "reviewedAt" IS NOT NULL AND "reviewerUserId" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "PersonalKnowledgeGraphSuggestion_source_triple_key"
  ON "PersonalKnowledgeGraphSuggestion" ("ownerUserId", "documentId", "revisionId", "subject", "predicate", "object");
CREATE INDEX "PersonalKnowledgeGraphSuggestion_owner_status_idx"
  ON "PersonalKnowledgeGraphSuggestion" ("ownerUserId", "status", "createdAt", "id");
CREATE INDEX "PersonalKnowledgeGraphSuggestion_owner_document_idx"
  ON "PersonalKnowledgeGraphSuggestion" ("ownerUserId", "documentId", "status");

ALTER TABLE "PersonalKnowledgeGraphSuggestion"
  ADD CONSTRAINT "PersonalKnowledgeGraphSuggestion_ownerUserId_fkey"
  FOREIGN KEY ("ownerUserId") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PersonalKnowledgeGraphSuggestion_document_fkey"
  FOREIGN KEY ("documentId", "ownerUserId") REFERENCES "PersonalKnowledgeDocument"("id", "ownerUserId") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PersonalKnowledgeGraphSuggestion_revision_fkey"
  FOREIGN KEY ("documentId", "ownerUserId", "revisionId") REFERENCES "PersonalKnowledgeRevision"("documentId", "ownerUserId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "PersonalKnowledgeGraphSuggestion"
  ADD CONSTRAINT "PersonalKnowledgeGraphSuggestion_reviewer_fkey"
  FOREIGN KEY ("reviewerUserId") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION "personal_knowledge_graph_suggestion_guard"()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'graph suggestion deletion is forbidden' USING ERRCODE = 'check_violation'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'pending' OR NEW."reviewedAt" IS NOT NULL OR NEW."reviewerUserId" IS NOT NULL THEN
      RAISE EXCEPTION 'graph suggestion must begin pending' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."status" <> 'pending' OR NEW."status" NOT IN ('accepted', 'rejected')
     OR NEW."reviewerUserId" IS DISTINCT FROM OLD."ownerUserId"
     OR NEW."reviewedAt" IS NULL
     OR (to_jsonb(NEW) - 'status' - 'reviewerUserId' - 'reviewedAt')
        IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'reviewerUserId' - 'reviewedAt') THEN
    RAISE EXCEPTION 'graph suggestion may only be reviewed once by its owner' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "PersonalKnowledgeGraphSuggestion_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "PersonalKnowledgeGraphSuggestion"
FOR EACH ROW EXECUTE FUNCTION "personal_knowledge_graph_suggestion_guard"();

CREATE TABLE "PersonalKnowledgeExtractionAttempt" (
  "id" UUID NOT NULL,
  "ownerUserId" UUID NOT NULL,
  "operation" VARCHAR(16) NOT NULL,
  "documentId" UUID,
  "revisionId" UUID,
  "inputHash" CHAR(64) NOT NULL,
  "inputBytes" INTEGER NOT NULL,
  "pageManifestHash" CHAR(64),
  "providerConnectionId" UUID NOT NULL,
  "providerConfigurationVersion" INTEGER NOT NULL,
  "modelId" VARCHAR(128) NOT NULL,
  "credentialSecretFingerprint" CHAR(64) NOT NULL,
  "actorAccountAccessVersion" INTEGER NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'issued',
  "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "finalizedAt" TIMESTAMP(3),
  "requestCount" INTEGER NOT NULL DEFAULT 0,
  "providerRequestIds" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "inputTokens" INTEGER NOT NULL DEFAULT 0,
  "outputTokens" INTEGER NOT NULL DEFAULT 0,
  "usageKnown" BOOLEAN NOT NULL DEFAULT false,
  "safeErrorCode" VARCHAR(100),
  CONSTRAINT "PersonalKnowledgeExtractionAttempt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PersonalKnowledgeExtractionAttempt_operation_check" CHECK (
    ("operation" = 'graph' AND "documentId" IS NOT NULL AND "revisionId" IS NOT NULL AND "pageManifestHash" IS NULL)
    OR ("operation" = 'vision' AND "documentId" IS NULL AND "revisionId" IS NULL AND "pageManifestHash" IS NOT NULL)
  ),
  CONSTRAINT "PersonalKnowledgeExtractionAttempt_fingerprint_check" CHECK (
    "inputHash" ~ '^[0-9a-f]{64}$' AND "credentialSecretFingerprint" ~ '^[0-9a-f]{64}$'
    AND ("pageManifestHash" IS NULL OR "pageManifestHash" ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT "PersonalKnowledgeExtractionAttempt_counts_check" CHECK (
    "inputBytes" > 0 AND "providerConfigurationVersion" > 0 AND "actorAccountAccessVersion" > 0
    AND "requestCount" >= 0 AND "inputTokens" >= 0 AND "outputTokens" >= 0
    AND jsonb_typeof("providerRequestIds") = 'array'
  ),
  CONSTRAINT "PersonalKnowledgeExtractionAttempt_status_check" CHECK (
    ("status" = 'issued' AND "consumedAt" IS NULL AND "finalizedAt" IS NULL)
    OR ("status" = 'running' AND "consumedAt" IS NOT NULL AND "finalizedAt" IS NULL)
    OR ("status" IN ('succeeded', 'failed', 'unknown') AND "consumedAt" IS NOT NULL AND "finalizedAt" IS NOT NULL)
  ),
  CONSTRAINT "PersonalKnowledgeExtractionAttempt_expiry_check" CHECK ("expiresAt" > "issuedAt")
);

CREATE UNIQUE INDEX "PersonalKnowledgeExtractionAttempt_ownerUserId_id_key"
  ON "PersonalKnowledgeExtractionAttempt" ("ownerUserId", "id");
CREATE INDEX "PersonalKnowledgeExtractionAttempt_ownerUserId_issuedAt_idx"
  ON "PersonalKnowledgeExtractionAttempt" ("ownerUserId", "issuedAt");
CREATE INDEX "PersonalKnowledgeExtractionAttempt_provider_status_issued_idx"
  ON "PersonalKnowledgeExtractionAttempt" ("providerConnectionId", "status", "issuedAt");
CREATE INDEX "PersonalKnowledgeExtractionAttempt_expiresAt_status_idx"
  ON "PersonalKnowledgeExtractionAttempt" ("expiresAt", "status");

ALTER TABLE "PersonalKnowledgeExtractionAttempt"
  ADD CONSTRAINT "PersonalKnowledgeExtractionAttempt_owner_fkey"
  FOREIGN KEY ("ownerUserId") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PersonalKnowledgeExtractionAttempt_document_fkey"
  FOREIGN KEY ("documentId", "ownerUserId") REFERENCES "PersonalKnowledgeDocument"("id", "ownerUserId") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PersonalKnowledgeExtractionAttempt_revision_fkey"
  FOREIGN KEY ("documentId", "ownerUserId", "revisionId") REFERENCES "PersonalKnowledgeRevision"("documentId", "ownerUserId", "id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PersonalKnowledgeExtractionAttempt_provider_fkey"
  FOREIGN KEY ("providerConnectionId") REFERENCES "AiProviderConnection"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION "personal_knowledge_extraction_attempt_guard"()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'extraction audit deletion is forbidden' USING ERRCODE = 'check_violation'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'issued' OR NEW."consumedAt" IS NOT NULL OR NEW."finalizedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'extraction attempt must begin issued' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - 'status' - 'consumedAt' - 'finalizedAt' - 'requestCount' - 'providerRequestIds' - 'inputTokens' - 'outputTokens' - 'usageKnown' - 'safeErrorCode')
     IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'consumedAt' - 'finalizedAt' - 'requestCount' - 'providerRequestIds' - 'inputTokens' - 'outputTokens' - 'usageKnown' - 'safeErrorCode') THEN
    RAISE EXCEPTION 'extraction attempt identity is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" = 'issued' THEN
    IF NEW."status" <> 'running' OR NEW."consumedAt" IS NULL OR NEW."finalizedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'extraction attempt requires one consumption' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF OLD."status" = 'running' THEN
    IF NEW."status" NOT IN ('succeeded', 'failed', 'unknown') OR NEW."consumedAt" IS DISTINCT FROM OLD."consumedAt" OR NEW."finalizedAt" IS NULL THEN
      RAISE EXCEPTION 'extraction attempt requires one terminal outcome' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    RAISE EXCEPTION 'extraction attempt terminal outcome is immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "PersonalKnowledgeExtractionAttempt_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "PersonalKnowledgeExtractionAttempt"
FOR EACH ROW EXECUTE FUNCTION "personal_knowledge_extraction_attempt_guard"();

REVOKE ALL ON TABLE "PersonalKnowledgeGraphSuggestion" FROM PUBLIC;
REVOKE ALL ON TABLE "PersonalKnowledgeExtractionAttempt" FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "personal_knowledge_graph_suggestion_guard"() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "personal_knowledge_extraction_attempt_guard"() FROM PUBLIC;
