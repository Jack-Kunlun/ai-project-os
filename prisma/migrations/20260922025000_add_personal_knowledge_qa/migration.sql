-- P03b.1 personal knowledge page Q&A.
--
-- A challenge is a short-lived one-use proof. It stores only hashes and
-- bounded evidence metadata. The audit is append-only body-free provider
-- outcome evidence. BYOK calls do not create jobs, grants or reservations.

CREATE TYPE "PersonalKnowledgeQaChallengeStatus" AS ENUM ('issued', 'consumed');
CREATE TYPE "PersonalKnowledgeQaAuditStatus" AS ENUM ('running', 'succeeded', 'failed', 'unknown');

CREATE TABLE "PersonalKnowledgeQaChallenge" (
  "id" UUID NOT NULL,
  "ownerUserId" UUID NOT NULL,
  "documentId" UUID NOT NULL,
  "revisionId" UUID NOT NULL,
  "documentVersion" INTEGER NOT NULL,
  "contentHash" CHAR(64) NOT NULL,
  "questionHash" CHAR(64) NOT NULL,
  "evidenceManifest" JSONB NOT NULL,
  "providerConnectionId" UUID NOT NULL,
  "providerConfigurationVersion" INTEGER NOT NULL,
  "modelId" VARCHAR(128) NOT NULL,
  "credentialSecretFingerprint" CHAR(64) NOT NULL,
  "actorAccountAccessVersion" INTEGER NOT NULL,
  "clientKeyHash" CHAR(64) NOT NULL,
  "inputFingerprint" CHAR(64) NOT NULL,
  "status" "PersonalKnowledgeQaChallengeStatus" NOT NULL DEFAULT 'issued',
  "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT clock_timestamp(),
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  CONSTRAINT "PersonalKnowledgeQaChallenge_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PersonalKnowledgeQaChallenge_fingerprint_check" CHECK (
    btrim("contentHash") ~ '^[0-9a-f]{64}$'
    AND btrim("questionHash") ~ '^[0-9a-f]{64}$'
    AND btrim("credentialSecretFingerprint") ~ '^[0-9a-f]{64}$'
    AND btrim("clientKeyHash") ~ '^[0-9a-f]{64}$'
    AND btrim("inputFingerprint") ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "PersonalKnowledgeQaChallenge_version_check" CHECK (
    "documentVersion" >= 1 AND "providerConfigurationVersion" >= 1 AND "actorAccountAccessVersion" >= 1
  ),
  CONSTRAINT "PersonalKnowledgeQaChallenge_manifest_check" CHECK (
    jsonb_typeof("evidenceManifest") = 'array'
  ),
  CONSTRAINT "PersonalKnowledgeQaChallenge_expiry_check" CHECK (
    "expiresAt" > "issuedAt" AND "expiresAt" <= "issuedAt" + INTERVAL '15 minutes'
  )
);

CREATE UNIQUE INDEX "PersonalKnowledgeQaChallenge_ownerUserId_id_key"
  ON "PersonalKnowledgeQaChallenge" ("ownerUserId", "id");
CREATE UNIQUE INDEX "PersonalKnowledgeQaChallenge_ownerUserId_clientKeyHash_key"
  ON "PersonalKnowledgeQaChallenge" ("ownerUserId", "clientKeyHash");
CREATE INDEX "PersonalKnowledgeQaChallenge_ownerUserId_documentId_issuedAt_idx"
  ON "PersonalKnowledgeQaChallenge" ("ownerUserId", "documentId", "issuedAt");
CREATE INDEX "PersonalKnowledgeQaChallenge_expiresAt_consumedAt_idx"
  ON "PersonalKnowledgeQaChallenge" ("expiresAt", "consumedAt");
CREATE INDEX "PersonalKnowledgeQaChallenge_providerConnectionId_status_issuedAt_idx"
  ON "PersonalKnowledgeQaChallenge" ("providerConnectionId", "status", "issuedAt");
CREATE INDEX "PersonalKnowledgeQaChallenge_inputFingerprint_idx"
  ON "PersonalKnowledgeQaChallenge" ("inputFingerprint");

CREATE TABLE "PersonalKnowledgeQaAudit" (
  "id" UUID NOT NULL,
  "ownerUserId" UUID NOT NULL,
  "challengeId" UUID NOT NULL,
  "documentId" UUID NOT NULL,
  "revisionId" UUID NOT NULL,
  "documentVersion" INTEGER NOT NULL,
  "contentHash" CHAR(64) NOT NULL,
  "questionHash" CHAR(64) NOT NULL,
  "evidenceManifest" JSONB NOT NULL,
  "providerConnectionId" UUID NOT NULL,
  "providerConfigurationVersion" INTEGER NOT NULL,
  "modelId" VARCHAR(128) NOT NULL,
  "credentialSecretFingerprint" CHAR(64) NOT NULL,
  "actorAccountAccessVersion" INTEGER NOT NULL,
  "status" "PersonalKnowledgeQaAuditStatus" NOT NULL DEFAULT 'running',
  "safeErrorCode" VARCHAR(96),
  "providerRequestId" VARCHAR(256),
  "inputTokens" INTEGER NOT NULL DEFAULT 0,
  "outputTokens" INTEGER NOT NULL DEFAULT 0,
  "usageKnown" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT clock_timestamp(),
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "PersonalKnowledgeQaAudit_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PersonalKnowledgeQaAudit_fingerprint_check" CHECK (
    btrim("contentHash") ~ '^[0-9a-f]{64}$'
    AND btrim("questionHash") ~ '^[0-9a-f]{64}$'
    AND btrim("credentialSecretFingerprint") ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "PersonalKnowledgeQaAudit_version_check" CHECK (
    "documentVersion" >= 1 AND "providerConfigurationVersion" >= 1 AND "actorAccountAccessVersion" >= 1
  ),
  CONSTRAINT "PersonalKnowledgeQaAudit_manifest_check" CHECK (jsonb_typeof("evidenceManifest") = 'array'),
  CONSTRAINT "PersonalKnowledgeQaAudit_usage_check" CHECK ("inputTokens" >= 0 AND "outputTokens" >= 0)
);

CREATE UNIQUE INDEX "PersonalKnowledgeQaAudit_ownerUserId_id_key"
  ON "PersonalKnowledgeQaAudit" ("ownerUserId", "id");
CREATE UNIQUE INDEX "PersonalKnowledgeQaAudit_challengeId_key"
  ON "PersonalKnowledgeQaAudit" ("challengeId");
CREATE INDEX "PersonalKnowledgeQaAudit_ownerUserId_createdAt_idx"
  ON "PersonalKnowledgeQaAudit" ("ownerUserId", "createdAt");
CREATE INDEX "PersonalKnowledgeQaAudit_ownerUserId_documentId_createdAt_idx"
  ON "PersonalKnowledgeQaAudit" ("ownerUserId", "documentId", "createdAt");
CREATE INDEX "PersonalKnowledgeQaAudit_providerConnectionId_createdAt_idx"
  ON "PersonalKnowledgeQaAudit" ("providerConnectionId", "createdAt");

ALTER TABLE "PersonalKnowledgeQaChallenge"
  ADD CONSTRAINT "PersonalKnowledgeQaChallenge_ownerUserId_fkey"
    FOREIGN KEY ("ownerUserId") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PersonalKnowledgeQaChallenge_document_fkey"
    FOREIGN KEY ("documentId", "ownerUserId") REFERENCES "PersonalKnowledgeDocument"("id", "ownerUserId") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PersonalKnowledgeQaChallenge_revision_fkey"
    FOREIGN KEY ("documentId", "ownerUserId", "revisionId") REFERENCES "PersonalKnowledgeRevision"("documentId", "ownerUserId", "id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PersonalKnowledgeQaChallenge_provider_fkey"
    FOREIGN KEY ("providerConnectionId") REFERENCES "AiProviderConnection"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "PersonalKnowledgeQaAudit"
  ADD CONSTRAINT "PersonalKnowledgeQaAudit_ownerUserId_fkey"
    FOREIGN KEY ("ownerUserId") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PersonalKnowledgeQaAudit_challengeId_fkey"
    FOREIGN KEY ("challengeId") REFERENCES "PersonalKnowledgeQaChallenge"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PersonalKnowledgeQaAudit_document_fkey"
    FOREIGN KEY ("documentId", "ownerUserId") REFERENCES "PersonalKnowledgeDocument"("id", "ownerUserId") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PersonalKnowledgeQaAudit_revision_fkey"
    FOREIGN KEY ("documentId", "ownerUserId", "revisionId") REFERENCES "PersonalKnowledgeRevision"("documentId", "ownerUserId", "id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PersonalKnowledgeQaAudit_provider_fkey"
    FOREIGN KEY ("providerConnectionId") REFERENCES "AiProviderConnection"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION "personal_knowledge_qa_challenge_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF current_setting('app.personal_knowledge_qa_mutation_context', true) IS DISTINCT FROM 'service-v1' THEN
    RAISE EXCEPTION 'personal knowledge QA challenge mutation requires service context' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'personal knowledge QA challenges are append-only' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    OLD."id" IS DISTINCT FROM NEW."id"
    OR OLD."ownerUserId" IS DISTINCT FROM NEW."ownerUserId"
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
    OR OLD."clientKeyHash" IS DISTINCT FROM NEW."clientKeyHash"
    OR OLD."inputFingerprint" IS DISTINCT FROM NEW."inputFingerprint"
    OR OLD."issuedAt" IS DISTINCT FROM NEW."issuedAt"
    OR OLD."expiresAt" IS DISTINCT FROM NEW."expiresAt"
  ) THEN
    RAISE EXCEPTION 'personal knowledge QA challenge identity is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."status" = 'consumed' AND (
    NEW."status" IS DISTINCT FROM OLD."status" OR NEW."consumedAt" IS DISTINCT FROM OLD."consumedAt"
  ) THEN
    RAISE EXCEPTION 'personal knowledge QA challenge cannot be changed after consumption' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."status" = 'issued' AND (
    NEW."status" IS DISTINCT FROM 'consumed'::"PersonalKnowledgeQaChallengeStatus"
    OR NEW."consumedAt" IS NULL
  ) THEN
    RAISE EXCEPTION 'personal knowledge QA challenge must be consumed once' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

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
  RETURN NEW;
END;
$$;

CREATE TRIGGER "PersonalKnowledgeQaChallenge_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "PersonalKnowledgeQaChallenge"
FOR EACH ROW EXECUTE FUNCTION "personal_knowledge_qa_challenge_guard"();
CREATE TRIGGER "PersonalKnowledgeQaAudit_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "PersonalKnowledgeQaAudit"
FOR EACH ROW EXECUTE FUNCTION "personal_knowledge_qa_audit_guard"();

REVOKE ALL ON TABLE "PersonalKnowledgeQaChallenge" FROM PUBLIC;
REVOKE ALL ON TABLE "PersonalKnowledgeQaAudit" FROM PUBLIC;
REVOKE ALL ON FUNCTION "personal_knowledge_qa_challenge_guard"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "personal_knowledge_qa_audit_guard"() FROM PUBLIC;
