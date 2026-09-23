-- P03b personal semantic search.  This is a separate owner-scoped index
-- domain.  It never reuses project generations, project grants or project
-- credits.  Entries keep immutable revision/range evidence and vectors only;
-- document bodies remain in PersonalKnowledgeRevision and are read back after
-- current-revision validation.

CREATE TYPE "PersonalKnowledgeSemanticIndexStatus" AS ENUM ('not_built', 'building', 'ready', 'stale', 'failed');
CREATE TYPE "PersonalKnowledgeSemanticGenerationStatus" AS ENUM ('building', 'ready', 'failed', 'superseded');
CREATE TYPE "PersonalKnowledgeSemanticChallengeKind" AS ENUM ('build', 'search');
CREATE TYPE "PersonalKnowledgeSemanticChallengeStatus" AS ENUM ('issued', 'consumed');
CREATE TYPE "PersonalKnowledgeSemanticAuditStatus" AS ENUM ('running', 'succeeded', 'failed', 'unknown');

CREATE TABLE "PersonalKnowledgeSemanticIndexState" (
  "ownerUserId" UUID NOT NULL,
  "corpusEpoch" INTEGER NOT NULL DEFAULT 1,
  "status" "PersonalKnowledgeSemanticIndexStatus" NOT NULL DEFAULT 'not_built',
  "activeGenerationId" UUID,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PersonalKnowledgeSemanticIndexState_pkey" PRIMARY KEY ("ownerUserId"),
  CONSTRAINT "PersonalKnowledgeSemanticIndexState_epoch_check" CHECK ("corpusEpoch" > 0)
);

CREATE TABLE "PersonalKnowledgeSemanticGeneration" (
  "id" UUID NOT NULL,
  "ownerUserId" UUID NOT NULL,
  "corpusEpoch" INTEGER NOT NULL,
  "providerConnectionId" UUID NOT NULL,
  "providerConfigurationVersion" INTEGER NOT NULL,
  "credentialSecretFingerprint" CHAR(64) NOT NULL,
  "modelId" VARCHAR(128) NOT NULL,
  "dimensions" INTEGER NOT NULL,
  "status" "PersonalKnowledgeSemanticGenerationStatus" NOT NULL DEFAULT 'building',
  "expectedEntryCount" INTEGER NOT NULL,
  "indexedEntryCount" INTEGER NOT NULL DEFAULT 0,
  "sourceManifestFingerprint" CHAR(64) NOT NULL,
  "chunkerVersion" VARCHAR(64) NOT NULL,
  "safeErrorCode" VARCHAR(96),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT clock_timestamp(),
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "PersonalKnowledgeSemanticGeneration_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PersonalKnowledgeSemanticGeneration_epoch_check" CHECK ("corpusEpoch" > 0),
  CONSTRAINT "PersonalKnowledgeSemanticGeneration_provider_version_check" CHECK ("providerConfigurationVersion" > 0),
  CONSTRAINT "PersonalKnowledgeSemanticGeneration_dimensions_check" CHECK ("dimensions" BETWEEN 8 AND 8192),
  CONSTRAINT "PersonalKnowledgeSemanticGeneration_count_check" CHECK ("expectedEntryCount" > 0 AND "indexedEntryCount" >= 0 AND "indexedEntryCount" <= "expectedEntryCount"),
  CONSTRAINT "PersonalKnowledgeSemanticGeneration_fingerprint_check" CHECK (
    btrim("credentialSecretFingerprint") ~ '^[0-9a-f]{64}$'
    AND btrim("sourceManifestFingerprint") ~ '^[0-9a-f]{64}$'
  )
);

CREATE TABLE "PersonalKnowledgeSemanticEntry" (
  "id" UUID NOT NULL,
  "ownerUserId" UUID NOT NULL,
  "generationId" UUID NOT NULL,
  "documentId" UUID NOT NULL,
  "revisionId" UUID NOT NULL,
  "documentVersion" INTEGER NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "rangeStart" INTEGER NOT NULL,
  "rangeEnd" INTEGER NOT NULL,
  "contentHash" CHAR(64) NOT NULL,
  "vector" vector NOT NULL,
  "vectorFingerprint" CHAR(64) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "PersonalKnowledgeSemanticEntry_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PersonalKnowledgeSemanticEntry_range_check" CHECK ("documentVersion" > 0 AND "ordinal" >= 0 AND "rangeStart" >= 0 AND "rangeEnd" > "rangeStart"),
  CONSTRAINT "PersonalKnowledgeSemanticEntry_fingerprint_check" CHECK (btrim("contentHash") ~ '^[0-9a-f]{64}$' AND btrim("vectorFingerprint") ~ '^[0-9a-f]{64}$')
);

CREATE TABLE "PersonalKnowledgeSemanticChallenge" (
  "id" UUID NOT NULL,
  "ownerUserId" UUID NOT NULL,
  "kind" "PersonalKnowledgeSemanticChallengeKind" NOT NULL,
  "generationId" UUID NOT NULL,
  "providerConnectionId" UUID NOT NULL,
  "providerConfigurationVersion" INTEGER NOT NULL,
  "credentialSecretFingerprint" CHAR(64) NOT NULL,
  "modelId" VARCHAR(128) NOT NULL,
  "dimensions" INTEGER NOT NULL,
  "corpusEpoch" INTEGER NOT NULL,
  "sourceManifest" JSONB NOT NULL,
  "expectedEntryCount" INTEGER NOT NULL,
  "queryHash" CHAR(64),
  "actorAccountAccessVersion" INTEGER NOT NULL,
  "clientKeyHash" CHAR(64) NOT NULL,
  "inputFingerprint" CHAR(64) NOT NULL,
  "status" "PersonalKnowledgeSemanticChallengeStatus" NOT NULL DEFAULT 'issued',
  "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT clock_timestamp(),
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  CONSTRAINT "PersonalKnowledgeSemanticChallenge_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PersonalKnowledgeSemanticChallenge_version_check" CHECK ("providerConfigurationVersion" > 0 AND "dimensions" BETWEEN 8 AND 8192 AND "corpusEpoch" > 0 AND "expectedEntryCount" > 0 AND "actorAccountAccessVersion" > 0),
  CONSTRAINT "PersonalKnowledgeSemanticChallenge_manifest_check" CHECK (jsonb_typeof("sourceManifest") = 'array'),
  CONSTRAINT "PersonalKnowledgeSemanticChallenge_fingerprint_check" CHECK (
    btrim("credentialSecretFingerprint") ~ '^[0-9a-f]{64}$'
    AND btrim("clientKeyHash") ~ '^[0-9a-f]{64}$'
    AND btrim("inputFingerprint") ~ '^[0-9a-f]{64}$'
    AND ("queryHash" IS NULL OR btrim("queryHash") ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT "PersonalKnowledgeSemanticChallenge_expiry_check" CHECK ("expiresAt" > "issuedAt" AND "expiresAt" <= "issuedAt" + INTERVAL '15 minutes')
);

CREATE TABLE "PersonalKnowledgeSemanticAudit" (
  "id" UUID NOT NULL,
  "ownerUserId" UUID NOT NULL,
  "challengeId" UUID NOT NULL,
  "generationId" UUID NOT NULL,
  "kind" "PersonalKnowledgeSemanticChallengeKind" NOT NULL,
  "providerConnectionId" UUID NOT NULL,
  "providerConfigurationVersion" INTEGER NOT NULL,
  "credentialSecretFingerprint" CHAR(64) NOT NULL,
  "modelId" VARCHAR(128) NOT NULL,
  "dimensions" INTEGER NOT NULL,
  "corpusEpoch" INTEGER NOT NULL,
  "expectedEntryCount" INTEGER NOT NULL,
  "status" "PersonalKnowledgeSemanticAuditStatus" NOT NULL DEFAULT 'running',
  "safeErrorCode" VARCHAR(96),
  "providerRequestId" VARCHAR(256),
  "requestCount" INTEGER NOT NULL DEFAULT 0,
  "inputTokens" INTEGER NOT NULL DEFAULT 0,
  "usageKnown" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT clock_timestamp(),
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "PersonalKnowledgeSemanticAudit_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PersonalKnowledgeSemanticAudit_version_check" CHECK ("providerConfigurationVersion" > 0 AND "dimensions" BETWEEN 8 AND 8192 AND "corpusEpoch" > 0 AND "expectedEntryCount" > 0),
  CONSTRAINT "PersonalKnowledgeSemanticAudit_usage_check" CHECK ("requestCount" >= 0 AND "inputTokens" >= 0),
  CONSTRAINT "PersonalKnowledgeSemanticAudit_fingerprint_check" CHECK (btrim("credentialSecretFingerprint") ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX "PersonalKnowledgeSemanticGeneration_ownerUserId_id_key"
  ON "PersonalKnowledgeSemanticGeneration" ("ownerUserId", "id");
CREATE INDEX "PersonalKnowledgeSemanticGeneration_ownerUserId_status_createdAt_idx"
  ON "PersonalKnowledgeSemanticGeneration" ("ownerUserId", "status", "createdAt");
CREATE INDEX "PersonalKnowledgeSemanticGeneration_providerConnectionId_status_createdAt_idx"
  ON "PersonalKnowledgeSemanticGeneration" ("providerConnectionId", "status", "createdAt");
CREATE UNIQUE INDEX "PersonalKnowledgeSemanticEntry_ownerUserId_id_key"
  ON "PersonalKnowledgeSemanticEntry" ("ownerUserId", "id");
CREATE UNIQUE INDEX "PersonalKnowledgeSemanticEntry_owner_gen_doc_rev_ord_key"
  ON "PersonalKnowledgeSemanticEntry" ("ownerUserId", "generationId", "documentId", "revisionId", "ordinal");
CREATE INDEX "PersonalKnowledgeSemanticEntry_owner_gen_doc_rev_idx"
  ON "PersonalKnowledgeSemanticEntry" ("ownerUserId", "generationId", "documentId", "revisionId");
CREATE INDEX "PersonalKnowledgeSemanticEntry_owner_contentHash_idx"
  ON "PersonalKnowledgeSemanticEntry" ("ownerUserId", "contentHash");
CREATE UNIQUE INDEX "PersonalKnowledgeSemanticChallenge_ownerUserId_id_key"
  ON "PersonalKnowledgeSemanticChallenge" ("ownerUserId", "id");
CREATE UNIQUE INDEX "PersonalKnowledgeSemanticChallenge_ownerUserId_clientKeyHash_key"
  ON "PersonalKnowledgeSemanticChallenge" ("ownerUserId", "clientKeyHash");
CREATE INDEX "PersonalKnowledgeSemanticChallenge_owner_kind_status_issuedAt_idx"
  ON "PersonalKnowledgeSemanticChallenge" ("ownerUserId", "kind", "status", "issuedAt");
CREATE INDEX "PersonalKnowledgeSemanticChallenge_generation_status_issuedAt_idx"
  ON "PersonalKnowledgeSemanticChallenge" ("generationId", "status", "issuedAt");
CREATE INDEX "PersonalKnowledgeSemanticChallenge_expiresAt_consumedAt_idx"
  ON "PersonalKnowledgeSemanticChallenge" ("expiresAt", "consumedAt");
CREATE UNIQUE INDEX "PersonalKnowledgeSemanticAudit_ownerUserId_id_key"
  ON "PersonalKnowledgeSemanticAudit" ("ownerUserId", "id");
CREATE UNIQUE INDEX "PersonalKnowledgeSemanticAudit_challengeId_key"
  ON "PersonalKnowledgeSemanticAudit" ("challengeId");
CREATE INDEX "PersonalKnowledgeSemanticAudit_owner_kind_createdAt_idx"
  ON "PersonalKnowledgeSemanticAudit" ("ownerUserId", "kind", "createdAt");
CREATE INDEX "PersonalKnowledgeSemanticAudit_owner_generation_createdAt_idx"
  ON "PersonalKnowledgeSemanticAudit" ("ownerUserId", "generationId", "createdAt");

ALTER TABLE "PersonalKnowledgeSemanticIndexState"
  ADD CONSTRAINT "PersonalKnowledgeSemanticIndexState_ownerUserId_fkey"
  FOREIGN KEY ("ownerUserId") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "PersonalKnowledgeSemanticGeneration"
  ADD CONSTRAINT "PersonalKnowledgeSemanticGeneration_ownerUserId_fkey"
  FOREIGN KEY ("ownerUserId") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PersonalKnowledgeSemanticGeneration_providerConnectionId_fkey"
  FOREIGN KEY ("providerConnectionId") REFERENCES "AiProviderConnection"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "PersonalKnowledgeSemanticEntry"
  ADD CONSTRAINT "PersonalKnowledgeSemanticEntry_ownerUserId_fkey"
  FOREIGN KEY ("ownerUserId") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PersonalKnowledgeSemanticEntry_generation_fkey"
  FOREIGN KEY ("ownerUserId", "generationId") REFERENCES "PersonalKnowledgeSemanticGeneration"("ownerUserId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "PersonalKnowledgeSemanticEntry_document_fkey"
  FOREIGN KEY ("documentId", "ownerUserId") REFERENCES "PersonalKnowledgeDocument"("id", "ownerUserId") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PersonalKnowledgeSemanticEntry_revision_fkey"
  FOREIGN KEY ("documentId", "ownerUserId", "revisionId") REFERENCES "PersonalKnowledgeRevision"("documentId", "ownerUserId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "PersonalKnowledgeSemanticChallenge"
  ADD CONSTRAINT "PersonalKnowledgeSemanticChallenge_ownerUserId_fkey"
  FOREIGN KEY ("ownerUserId") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PersonalKnowledgeSemanticChallenge_generation_fkey"
  FOREIGN KEY ("ownerUserId", "generationId") REFERENCES "PersonalKnowledgeSemanticGeneration"("ownerUserId", "id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PersonalKnowledgeSemanticChallenge_providerConnectionId_fkey"
  FOREIGN KEY ("providerConnectionId") REFERENCES "AiProviderConnection"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "PersonalKnowledgeSemanticAudit"
  ADD CONSTRAINT "PersonalKnowledgeSemanticAudit_ownerUserId_fkey"
  FOREIGN KEY ("ownerUserId") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PersonalKnowledgeSemanticAudit_challengeId_fkey"
  FOREIGN KEY ("challengeId") REFERENCES "PersonalKnowledgeSemanticChallenge"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PersonalKnowledgeSemanticAudit_generation_fkey"
  FOREIGN KEY ("ownerUserId", "generationId") REFERENCES "PersonalKnowledgeSemanticGeneration"("ownerUserId", "id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PersonalKnowledgeSemanticAudit_providerConnectionId_fkey"
  FOREIGN KEY ("providerConnectionId") REFERENCES "AiProviderConnection"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- Source and provider mutations advance the owner fence. The service can use
-- the context value while publishing a freshly built generation, but it can
-- never suppress invalidation of a document or provider row update.
CREATE OR REPLACE FUNCTION "personal_knowledge_semantic_invalidate_owner"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  INSERT INTO "PersonalKnowledgeSemanticIndexState" ("ownerUserId", "corpusEpoch", "status", "activeGenerationId", "updatedAt")
  VALUES (NEW."ownerUserId", 1, 'stale', NULL, clock_timestamp())
  ON CONFLICT ("ownerUserId") DO UPDATE
    SET "corpusEpoch" = "PersonalKnowledgeSemanticIndexState"."corpusEpoch" + 1,
        "status" = 'stale',
        "activeGenerationId" = NULL,
        "updatedAt" = clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER "PersonalKnowledgeSemanticDocument_invalidate"
AFTER UPDATE OF "version", "state" ON "PersonalKnowledgeDocument"
FOR EACH ROW WHEN (OLD."version" IS DISTINCT FROM NEW."version" OR OLD."state" IS DISTINCT FROM NEW."state")
EXECUTE FUNCTION "personal_knowledge_semantic_invalidate_owner"();

CREATE OR REPLACE FUNCTION "personal_knowledge_semantic_provider_invalidate"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW."scope" = 'user' AND NEW."ownerUserId" IS NOT NULL THEN
    UPDATE "PersonalKnowledgeSemanticIndexState"
       SET "corpusEpoch" = "PersonalKnowledgeSemanticIndexState"."corpusEpoch" + 1,
           "status" = 'stale',
           "activeGenerationId" = NULL,
           "updatedAt" = clock_timestamp()
     WHERE "ownerUserId" = NEW."ownerUserId";
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "PersonalKnowledgeSemanticProvider_invalidate"
AFTER UPDATE OF "configurationVersion", "credentialId", "defaultEmbeddingModelId", "embeddingDimensions", "status", "disabledAt" ON "AiProviderConnection"
FOR EACH ROW WHEN (
  OLD."configurationVersion" IS DISTINCT FROM NEW."configurationVersion"
  OR OLD."credentialId" IS DISTINCT FROM NEW."credentialId"
  OR OLD."defaultEmbeddingModelId" IS DISTINCT FROM NEW."defaultEmbeddingModelId"
  OR OLD."embeddingDimensions" IS DISTINCT FROM NEW."embeddingDimensions"
  OR OLD."status" IS DISTINCT FROM NEW."status"
  OR OLD."disabledAt" IS DISTINCT FROM NEW."disabledAt"
)
EXECUTE FUNCTION "personal_knowledge_semantic_provider_invalidate"();

-- These rows are control-plane evidence and must not be rewritten through a
-- direct SQL client. Service transactions set the local mutation context.
CREATE OR REPLACE FUNCTION "personal_knowledge_semantic_mutation_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF current_setting('app.personal_knowledge_semantic_mutation_context', true) IS DISTINCT FROM 'service-v1' THEN
    RAISE EXCEPTION 'personal knowledge semantic mutation requires service context' USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER "PersonalKnowledgeSemanticEntry_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "PersonalKnowledgeSemanticEntry"
FOR EACH ROW EXECUTE FUNCTION "personal_knowledge_semantic_mutation_guard"();
CREATE TRIGGER "PersonalKnowledgeSemanticChallenge_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "PersonalKnowledgeSemanticChallenge"
FOR EACH ROW EXECUTE FUNCTION "personal_knowledge_semantic_mutation_guard"();
CREATE TRIGGER "PersonalKnowledgeSemanticAudit_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "PersonalKnowledgeSemanticAudit"
FOR EACH ROW EXECUTE FUNCTION "personal_knowledge_semantic_mutation_guard"();

CREATE OR REPLACE FUNCTION "personal_knowledge_semantic_challenge_immutable_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'personal knowledge semantic challenges are append-only' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    OLD."id" IS DISTINCT FROM NEW."id"
    OR OLD."ownerUserId" IS DISTINCT FROM NEW."ownerUserId"
    OR OLD."kind" IS DISTINCT FROM NEW."kind"
    OR OLD."generationId" IS DISTINCT FROM NEW."generationId"
    OR OLD."providerConnectionId" IS DISTINCT FROM NEW."providerConnectionId"
    OR OLD."providerConfigurationVersion" IS DISTINCT FROM NEW."providerConfigurationVersion"
    OR OLD."credentialSecretFingerprint" IS DISTINCT FROM NEW."credentialSecretFingerprint"
    OR OLD."modelId" IS DISTINCT FROM NEW."modelId"
    OR OLD."dimensions" IS DISTINCT FROM NEW."dimensions"
    OR OLD."corpusEpoch" IS DISTINCT FROM NEW."corpusEpoch"
    OR OLD."sourceManifest" IS DISTINCT FROM NEW."sourceManifest"
    OR OLD."expectedEntryCount" IS DISTINCT FROM NEW."expectedEntryCount"
    OR OLD."queryHash" IS DISTINCT FROM NEW."queryHash"
    OR OLD."actorAccountAccessVersion" IS DISTINCT FROM NEW."actorAccountAccessVersion"
    OR OLD."clientKeyHash" IS DISTINCT FROM NEW."clientKeyHash"
    OR OLD."inputFingerprint" IS DISTINCT FROM NEW."inputFingerprint"
    OR OLD."issuedAt" IS DISTINCT FROM NEW."issuedAt"
    OR OLD."expiresAt" IS DISTINCT FROM NEW."expiresAt"
  ) THEN
    RAISE EXCEPTION 'personal knowledge semantic challenge identity is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."status" = 'consumed' THEN
    RAISE EXCEPTION 'personal knowledge semantic challenge cannot be changed after consumption' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."status" = 'issued' AND (
    NEW."status" IS DISTINCT FROM 'consumed'::"PersonalKnowledgeSemanticChallengeStatus"
    OR NEW."consumedAt" IS NULL
  ) THEN
    RAISE EXCEPTION 'personal knowledge semantic challenge must be consumed once' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "PersonalKnowledgeSemanticChallenge_immutable_guard"
BEFORE UPDATE OR DELETE ON "PersonalKnowledgeSemanticChallenge"
FOR EACH ROW EXECUTE FUNCTION "personal_knowledge_semantic_challenge_immutable_guard"();

CREATE OR REPLACE FUNCTION "personal_knowledge_semantic_audit_immutable_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    RAISE EXCEPTION 'personal knowledge semantic audits are append-only' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "PersonalKnowledgeSemanticAudit_immutable_guard"
BEFORE UPDATE OR DELETE ON "PersonalKnowledgeSemanticAudit"
FOR EACH ROW EXECUTE FUNCTION "personal_knowledge_semantic_audit_immutable_guard"();

REVOKE ALL ON TABLE "PersonalKnowledgeSemanticIndexState" FROM PUBLIC;
REVOKE ALL ON TABLE "PersonalKnowledgeSemanticGeneration" FROM PUBLIC;
REVOKE ALL ON TABLE "PersonalKnowledgeSemanticEntry" FROM PUBLIC;
REVOKE ALL ON TABLE "PersonalKnowledgeSemanticChallenge" FROM PUBLIC;
REVOKE ALL ON TABLE "PersonalKnowledgeSemanticAudit" FROM PUBLIC;
REVOKE ALL ON FUNCTION "personal_knowledge_semantic_invalidate_owner"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "personal_knowledge_semantic_provider_invalidate"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "personal_knowledge_semantic_mutation_guard"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "personal_knowledge_semantic_challenge_immutable_guard"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "personal_knowledge_semantic_audit_immutable_guard"() FROM PUBLIC;
