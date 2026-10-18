-- Persist owner-bound cross-scope Q&A conversations and bind each platform
-- token reservation to its one-use confirmation without weakening the
-- existing personal-QA reservation guard.

CREATE TYPE "UnifiedQuestionConfirmationStatus" AS ENUM ('issued', 'consumed', 'expired');
CREATE TYPE "UnifiedQuestionAuditStatus" AS ENUM ('running', 'succeeded', 'failed', 'unknown');

CREATE TABLE "UnifiedQuestionConversation" (
  "id" UUID NOT NULL,
  "ownerUserId" UUID NOT NULL,
  "title" TEXT,
  "headTurnId" UUID,
  "headSequence" INTEGER NOT NULL DEFAULT 0,
  "version" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UnifiedQuestionConversation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "UnifiedQuestionConversation_owner_fkey" FOREIGN KEY ("ownerUserId")
    REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "UnifiedQuestionConversation_head_check" CHECK (
    ("headSequence" = 0 AND "version" = 0 AND "headTurnId" IS NULL)
    OR ("headSequence" > 0 AND "version" = "headSequence" AND "headTurnId" IS NOT NULL)
  )
);
CREATE UNIQUE INDEX "UnifiedQuestionConversation_owner_id_key" ON "UnifiedQuestionConversation"("ownerUserId", "id");
CREATE INDEX "UnifiedQuestionConversation_owner_updated_idx" ON "UnifiedQuestionConversation"("ownerUserId", "updatedAt", "id");

CREATE TABLE "UnifiedQuestionTurn" (
  "id" UUID NOT NULL,
  "ownerUserId" UUID NOT NULL,
  "conversationId" UUID NOT NULL,
  "sequence" INTEGER NOT NULL,
  "scope" VARCHAR(16) NOT NULL,
  "projectId" UUID,
  "focusDocumentId" UUID,
  "contextName" VARCHAR(240) NOT NULL,
  "question" TEXT NOT NULL,
  "answer" TEXT NOT NULL,
  "modelId" VARCHAR(128) NOT NULL,
  "providerName" VARCHAR(80) NOT NULL,
  "providerConnectionId" UUID NOT NULL,
  "citations" JSONB NOT NULL,
  "projectIds" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UnifiedQuestionTurn_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "UnifiedQuestionTurn_owner_fkey" FOREIGN KEY ("ownerUserId")
    REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "UnifiedQuestionTurn_conversation_fkey" FOREIGN KEY ("ownerUserId", "conversationId")
    REFERENCES "UnifiedQuestionConversation"("ownerUserId", "id") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "UnifiedQuestionTurn_shape_check" CHECK (
    "sequence" > 0 AND "scope" IN ('all', 'personal', 'project')
    AND length("contextName") BETWEEN 1 AND 240
    AND length("question") BETWEEN 2 AND 2000
    AND length("answer") BETWEEN 1 AND 50000
    AND jsonb_typeof("citations") = 'array'
    AND cardinality("projectIds") <= 100
  )
);
CREATE UNIQUE INDEX "UnifiedQuestionTurn_conversation_sequence_key" ON "UnifiedQuestionTurn"("conversationId", "sequence");
CREATE UNIQUE INDEX "UnifiedQuestionTurn_owner_id_key" ON "UnifiedQuestionTurn"("ownerUserId", "id");
CREATE INDEX "UnifiedQuestionTurn_owner_created_idx" ON "UnifiedQuestionTurn"("ownerUserId", "createdAt", "id");
CREATE INDEX "UnifiedQuestionTurn_conversation_created_idx" ON "UnifiedQuestionTurn"("conversationId", "createdAt", "id");

CREATE TABLE "UnifiedQuestionConfirmation" (
  "id" UUID NOT NULL,
  "ownerUserId" UUID NOT NULL,
  "conversationId" UUID NOT NULL,
  "expectedLastTurnId" UUID,
  "expectedSequence" INTEGER NOT NULL,
  "expectedVersion" INTEGER NOT NULL,
  "scope" VARCHAR(16) NOT NULL,
  "projectId" UUID,
  "focusDocumentId" UUID,
  "question" TEXT NOT NULL,
  "questionHash" CHAR(64) NOT NULL,
  "historyFingerprint" CHAR(64) NOT NULL,
  "scopeProjectIds" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
  "evidenceManifest" JSONB NOT NULL,
  "sourceSnapshots" JSONB NOT NULL,
  "contextName" VARCHAR(240) NOT NULL,
  "providerConnectionId" UUID NOT NULL,
  "providerConfigurationVersion" INTEGER NOT NULL,
  "modelId" VARCHAR(128) NOT NULL,
  "providerName" VARCHAR(80) NOT NULL,
  "credentialSecretFingerprint" CHAR(64) NOT NULL,
  "routeId" UUID NOT NULL,
  "routeVersion" INTEGER NOT NULL,
  "routeUpdatedAt" TIMESTAMP(3) NOT NULL,
  "quotaMultiplierBps" INTEGER NOT NULL,
  "maxOutputTokens" INTEGER NOT NULL,
  "routeFenceFingerprint" CHAR(64) NOT NULL,
  "actorAccountAccessVersion" INTEGER NOT NULL,
  "clientKeyHash" CHAR(64) NOT NULL,
  "inputFingerprint" CHAR(64) NOT NULL,
  "status" "UnifiedQuestionConfirmationStatus" NOT NULL DEFAULT 'issued',
  "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  CONSTRAINT "UnifiedQuestionConfirmation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "UnifiedQuestionConfirmation_owner_fkey" FOREIGN KEY ("ownerUserId")
    REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "UnifiedQuestionConfirmation_conversation_fkey" FOREIGN KEY ("ownerUserId", "conversationId")
    REFERENCES "UnifiedQuestionConversation"("ownerUserId", "id") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "UnifiedQuestionConfirmation_provider_fkey" FOREIGN KEY ("providerConnectionId")
    REFERENCES "AiProviderConnection"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "UnifiedQuestionConfirmation_shape_check" CHECK (
    "expectedSequence" >= 0 AND "expectedVersion" = "expectedSequence"
    AND "scope" IN ('all', 'personal', 'project')
    AND length("question") BETWEEN 2 AND 2000
    AND "actorAccountAccessVersion" > 0 AND "providerConfigurationVersion" > 0
    AND "routeVersion" > 0 AND "maxOutputTokens" BETWEEN 1 AND 4096
    AND "quotaMultiplierBps" BETWEEN 1 AND 100000
    AND "questionHash" ~ '^[0-9a-f]{64}$'
    AND "historyFingerprint" ~ '^[0-9a-f]{64}$'
    AND "credentialSecretFingerprint" ~ '^[0-9a-f]{64}$'
    AND "routeFenceFingerprint" ~ '^[0-9a-f]{64}$'
    AND "clientKeyHash" ~ '^[0-9a-f]{64}$'
    AND "inputFingerprint" ~ '^[0-9a-f]{64}$'
    AND jsonb_typeof("evidenceManifest") = 'array'
    AND jsonb_typeof("sourceSnapshots") = 'array'
    AND cardinality("scopeProjectIds") <= 100
    AND "expiresAt" > "issuedAt"
    AND (("status" = 'issued' AND "consumedAt" IS NULL)
      OR ("status" = 'consumed' AND "consumedAt" IS NOT NULL)
      OR ("status" = 'expired' AND "consumedAt" IS NULL))
  )
);
CREATE UNIQUE INDEX "UnifiedQuestionConfirmation_owner_id_key" ON "UnifiedQuestionConfirmation"("ownerUserId", "id");
CREATE UNIQUE INDEX "UnifiedQuestionConfirmation_owner_client_key" ON "UnifiedQuestionConfirmation"("ownerUserId", "clientKeyHash");
CREATE INDEX "UnifiedQuestionConfirmation_owner_conversation_issued_idx" ON "UnifiedQuestionConfirmation"("ownerUserId", "conversationId", "issuedAt");
CREATE INDEX "UnifiedQuestionConfirmation_expiry_idx" ON "UnifiedQuestionConfirmation"("expiresAt", "consumedAt");
CREATE INDEX "UnifiedQuestionConfirmation_provider_status_idx" ON "UnifiedQuestionConfirmation"("providerConnectionId", "status", "issuedAt");
CREATE INDEX "UnifiedQuestionConfirmation_fingerprint_idx" ON "UnifiedQuestionConfirmation"("inputFingerprint");

CREATE TABLE "UnifiedQuestionAudit" (
  "id" UUID NOT NULL,
  "ownerUserId" UUID NOT NULL,
  "confirmationId" UUID NOT NULL,
  "questionHash" CHAR(64) NOT NULL,
  "historyFingerprint" CHAR(64) NOT NULL,
  "evidenceManifest" JSONB NOT NULL,
  "scopeProjectIds" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
  "providerConnectionId" UUID NOT NULL,
  "providerConfigurationVersion" INTEGER NOT NULL,
  "modelId" VARCHAR(128) NOT NULL,
  "credentialSecretFingerprint" CHAR(64) NOT NULL,
  "actorAccountAccessVersion" INTEGER NOT NULL,
  "routeFenceFingerprint" CHAR(64) NOT NULL,
  "status" "UnifiedQuestionAuditStatus" NOT NULL DEFAULT 'running',
  "safeErrorCode" VARCHAR(96),
  "providerRequestId" VARCHAR(256),
  "inputTokens" INTEGER NOT NULL DEFAULT 0,
  "outputTokens" INTEGER NOT NULL DEFAULT 0,
  "usageKnown" BOOLEAN NOT NULL DEFAULT FALSE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "UnifiedQuestionAudit_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "UnifiedQuestionAudit_owner_fkey" FOREIGN KEY ("ownerUserId")
    REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "UnifiedQuestionAudit_confirmation_fkey" FOREIGN KEY ("ownerUserId", "confirmationId")
    REFERENCES "UnifiedQuestionConfirmation"("ownerUserId", "id") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "UnifiedQuestionAudit_provider_fkey" FOREIGN KEY ("providerConnectionId")
    REFERENCES "AiProviderConnection"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "UnifiedQuestionAudit_shape_check" CHECK (
    "questionHash" ~ '^[0-9a-f]{64}$'
    AND "historyFingerprint" ~ '^[0-9a-f]{64}$'
    AND "credentialSecretFingerprint" ~ '^[0-9a-f]{64}$'
    AND "routeFenceFingerprint" ~ '^[0-9a-f]{64}$'
    AND "providerConfigurationVersion" > 0 AND "actorAccountAccessVersion" > 0
    AND "inputTokens" BETWEEN 0 AND 10000000 AND "outputTokens" BETWEEN 0 AND 10000000
    AND ("safeErrorCode" IS NULL OR "safeErrorCode" ~ '^[A-Z0-9_]{1,96}$')
    AND cardinality("scopeProjectIds") <= 100
    AND (("status" = 'running' AND "completedAt" IS NULL)
      OR ("status" <> 'running' AND "completedAt" IS NOT NULL))
  )
);
CREATE UNIQUE INDEX "UnifiedQuestionAudit_owner_confirmation_key" ON "UnifiedQuestionAudit"("ownerUserId", "confirmationId");
CREATE UNIQUE INDEX "UnifiedQuestionAudit_owner_id_key" ON "UnifiedQuestionAudit"("ownerUserId", "id");
CREATE INDEX "UnifiedQuestionAudit_owner_created_idx" ON "UnifiedQuestionAudit"("ownerUserId", "createdAt");
CREATE INDEX "UnifiedQuestionAudit_owner_status_idx" ON "UnifiedQuestionAudit"("ownerUserId", "status", "completedAt");
CREATE INDEX "UnifiedQuestionAudit_provider_created_idx" ON "UnifiedQuestionAudit"("providerConnectionId", "createdAt");

ALTER TABLE "PlatformTokenReservation"
  ADD COLUMN "unifiedQuestionConfirmationId" UUID,
  ADD CONSTRAINT "PlatformTokenReservation_unified_question_confirmation_fkey"
    FOREIGN KEY ("userId", "unifiedQuestionConfirmationId")
    REFERENCES "UnifiedQuestionConfirmation"("ownerUserId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;
CREATE UNIQUE INDEX "PlatformTokenReservation_unified_question_confirmation_key"
  ON "PlatformTokenReservation"("userId", "unifiedQuestionConfirmationId");

-- Rebuild the existing check with an additional, disjoint unified-Q&A branch.
-- Personal QA, semantic, vision, project and historical branches retain their
-- previous predicates and identities.
ALTER TABLE "PlatformTokenReservation" DROP CONSTRAINT "PlatformTokenReservation_raw_billing_check",
  ADD CONSTRAINT "PlatformTokenReservation_raw_billing_check" CHECK (
    (
      "routeSource" IS NULL AND "routeId" IS NULL AND "routeVersion" IS NULL
      AND "routeUpdatedAt" IS NULL AND "providerConfigurationVersion" IS NULL
      AND "routeFenceFingerprint" IS NULL AND "webAiGrantId" IS NULL
      AND "webAiGrantReferenceId" IS NULL AND "webAiGrantProjectId" IS NULL
      AND "personalKnowledgeQaChallengeId" IS NULL AND "unifiedQuestionConfirmationId" IS NULL
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
          AND "personalKnowledgeQaChallengeId" IS NULL AND "unifiedQuestionConfirmationId" IS NULL
          AND "personalKnowledgeSemanticChallengeId" IS NULL AND "personalKnowledgeExtractionAttemptId" IS NULL
          AND "personalKnowledgeExtractionPageIndex" IS NULL)
        OR ("personalKnowledgeSemanticChallengeId" IS NOT NULL AND "webAiGrantId" IS NULL
          AND "webAiGrantReferenceId" IS NULL AND "webAiGrantProjectId" IS NULL AND "jobId" IS NULL
          AND "personalKnowledgeQaChallengeId" IS NULL AND "unifiedQuestionConfirmationId" IS NULL
          AND "personalKnowledgeExtractionAttemptId" IS NULL AND "personalKnowledgeExtractionPageIndex" IS NULL
          AND "operation" = 'embedding' AND "routeSource" = 'platform_default'
          AND "callKey" = 'personal-semantic:' || "personalKnowledgeSemanticChallengeId"::text)
        OR ("personalKnowledgeExtractionAttemptId" IS NOT NULL AND "personalKnowledgeExtractionPageIndex" BETWEEN 1 AND 3
          AND "webAiGrantId" IS NULL AND "webAiGrantReferenceId" IS NULL AND "webAiGrantProjectId" IS NULL
          AND "personalKnowledgeQaChallengeId" IS NULL AND "unifiedQuestionConfirmationId" IS NULL
          AND "personalKnowledgeSemanticChallengeId" IS NULL AND "jobId" IS NULL
          AND "operation" = 'visionExtract' AND "routeSource" = 'platform_default'
          AND "callKey" = 'personal-vision:' || "personalKnowledgeExtractionAttemptId"::text || ':' || "personalKnowledgeExtractionPageIndex"::text)
        OR ("personalKnowledgeQaChallengeId" IS NOT NULL
          AND "webAiGrantId" IS NULL AND "webAiGrantReferenceId" IS NULL AND "webAiGrantProjectId" IS NULL
          AND "personalKnowledgeSemanticChallengeId" IS NULL AND "unifiedQuestionConfirmationId" IS NULL
          AND "personalKnowledgeExtractionAttemptId" IS NULL AND "personalKnowledgeExtractionPageIndex" IS NULL
          AND "jobId" IS NULL AND "operation" = 'generateWithContext' AND "routeSource" = 'platform_default'
          AND "callKey" = 'personal-qa:' || "personalKnowledgeQaChallengeId"::text)
        OR ("unifiedQuestionConfirmationId" IS NOT NULL
          AND "webAiGrantId" IS NULL AND "webAiGrantReferenceId" IS NULL AND "webAiGrantProjectId" IS NULL
          AND "personalKnowledgeQaChallengeId" IS NULL AND "personalKnowledgeSemanticChallengeId" IS NULL
          AND "personalKnowledgeExtractionAttemptId" IS NULL AND "personalKnowledgeExtractionPageIndex" IS NULL
          AND "jobId" IS NULL AND "operation" = 'generateWithContext' AND "routeSource" = 'platform_default'
          AND "callKey" = 'unified-question:' || "unifiedQuestionConfirmationId"::text)
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

-- Safe legacy import: only explicit user-created RagAnswer rows are retained,
-- as one independent conversation each. Old source revisions were not stored,
-- so citations are labeled legacy/unknown and carry only their old snapshots.

INSERT INTO "UnifiedQuestionConversation" (
  "id", "ownerUserId", "title", "headTurnId", "headSequence", "version", "createdAt", "updatedAt"
)
SELECT r."id", j."requestedById", r."question", r."id", 1, 1, r."createdAt", r."createdAt"
FROM "RagAnswer" r
JOIN "BackgroundJob" j ON j."id" = r."jobId"
JOIN "AppUser" u ON u."id" = j."requestedById" AND u."role" = 'user';

INSERT INTO "UnifiedQuestionTurn" (
  "id", "ownerUserId", "conversationId", "sequence", "scope", "projectId", "contextName",
  "question", "answer", "modelId", "providerName", "providerConnectionId", "citations", "projectIds", "createdAt"
)
SELECT r."id", j."requestedById", r."id", 1, 'project', r."projectId",
  left(p."name", 240), r."question", r."answer", r."modelId",
  left(provider."name", 80), r."providerConnectionId",
  COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', 's' || citation.ordinality::text,
      'scope', 'project',
      'projectId', r."projectId",
      'sourceId', COALESCE(citation.value->>'id', '00000000-0000-4000-8000-000000000000'),
      'revision', 'unknown/legacy',
      'contentHash', CASE WHEN citation.value->>'contentHash' ~ '^[0-9a-fA-F]{64}$'
        THEN lower(citation.value->>'contentHash') ELSE repeat('0', 64) END,
      'title', COALESCE(NULLIF(citation.value->>'path', ''), NULLIF(citation.value->>'externalRef', ''), '历史来源（版本未记录）'),
      'excerpt', left(COALESCE(citation.value->>'excerpt', ''), 4000),
      'content', left(COALESCE(citation.value->>'excerpt', ''), 4000),
      'sourceKind', 'legacy',
      'legacy', true
    ) ORDER BY citation.ordinality)
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r."citations") = 'array' THEN r."citations" ELSE '[]'::jsonb END)
      WITH ORDINALITY AS citation(value, ordinality)
    WHERE citation.ordinality <= 12
  ), '[]'::jsonb), ARRAY[r."projectId"]::UUID[], r."createdAt"
FROM "RagAnswer" r
JOIN "BackgroundJob" j ON j."id" = r."jobId"
JOIN "AppUser" u ON u."id" = j."requestedById" AND u."role" = 'user'
JOIN "Project" p ON p."id" = r."projectId"
JOIN "AiProviderConnection" provider ON provider."id" = r."providerConnectionId";

CREATE OR REPLACE FUNCTION "unified_question_confirmation_transition_guard"()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'unified question confirmations cannot be deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF (to_jsonb(OLD) - 'status' - 'consumedAt') IS DISTINCT FROM (to_jsonb(NEW) - 'status' - 'consumedAt') THEN
    RAISE EXCEPTION 'unified question confirmation binding is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" <> 'issued' OR NOT (
    (NEW."status" = 'consumed' AND NEW."consumedAt" IS NOT NULL)
    OR (NEW."status" = 'expired' AND NEW."consumedAt" IS NULL)
  ) THEN
    RAISE EXCEPTION 'unified question confirmation transition is invalid' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION "unified_question_conversation_head_guard"()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE expected_question TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'unified question conversations cannot be deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."ownerUserId" IS DISTINCT FROM NEW."ownerUserId" OR OLD."createdAt" IS DISTINCT FROM NEW."createdAt"
    OR NEW."headSequence" <> OLD."headSequence" + 1 OR NEW."version" <> OLD."version" + 1
    OR NEW."headTurnId" IS NULL OR (OLD."headTurnId" IS NOT NULL AND OLD."headTurnId" = NEW."headTurnId") THEN
    RAISE EXCEPTION 'unified question conversation head must append one turn' USING ERRCODE = 'check_violation';
  END IF;
  SELECT "question" INTO expected_question FROM "UnifiedQuestionTurn"
    WHERE "id" = NEW."headTurnId" AND "ownerUserId" = NEW."ownerUserId"
      AND "conversationId" = NEW."id" AND "sequence" = NEW."headSequence";
  IF NOT FOUND THEN RAISE EXCEPTION 'unified question head turn evidence is missing' USING ERRCODE = 'check_violation'; END IF;
  IF OLD."headSequence" = 0 THEN
    IF NEW."title" IS DISTINCT FROM expected_question THEN RAISE EXCEPTION 'unified question title must match first turn' USING ERRCODE = 'check_violation'; END IF;
  ELSIF NEW."title" IS DISTINCT FROM OLD."title" THEN
    RAISE EXCEPTION 'unified question conversation title is immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION "unified_question_turn_insert_guard"()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE head_sequence INTEGER; owner_role "AppUserRole"; citation_project_ids UUID[]; canonical_project_ids UUID[];
BEGIN
  SELECT c."headSequence", u."role" INTO head_sequence, owner_role FROM "UnifiedQuestionConversation" c
    JOIN "AppUser" u ON u."id" = c."ownerUserId"
    WHERE c."id" = NEW."conversationId" AND c."ownerUserId" = NEW."ownerUserId";
  IF NOT FOUND OR owner_role <> 'user' OR NEW."sequence" <> head_sequence + 1 THEN
    RAISE EXCEPTION 'unified question turn owner or sequence is invalid' USING ERRCODE = 'check_violation';
  END IF;
  SELECT COALESCE(array_agg(project_id ORDER BY project_id), ARRAY[]::UUID[]) INTO citation_project_ids
  FROM (
    SELECT DISTINCT (cited.citation->>'projectId')::UUID AS project_id
    FROM jsonb_array_elements(NEW."citations") AS cited(citation)
    WHERE jsonb_typeof(cited.citation) = 'object' AND cited.citation ? 'projectId'
  ) AS cited_projects;
  SELECT COALESCE(array_agg(project_id ORDER BY project_id), ARRAY[]::UUID[]) INTO canonical_project_ids
  FROM (SELECT DISTINCT project_id FROM unnest(NEW."projectIds") AS stored_projects(project_id)) AS stored_project_ids;
  IF NEW."projectIds" IS DISTINCT FROM canonical_project_ids
    OR NOT (citation_project_ids <@ NEW."projectIds")
    OR (NEW."scope" = 'personal' AND (NEW."projectId" IS NOT NULL OR cardinality(NEW."projectIds") <> 0))
    OR (NEW."scope" = 'project' AND (NEW."projectId" IS NULL OR NOT (NEW."projectId" = ANY(NEW."projectIds"))))
    OR (NEW."scope" = 'all' AND NEW."projectId" IS NOT NULL) THEN
    RAISE EXCEPTION 'unified question turn citation scope is invalid' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION "unified_question_turn_head_evidence_guard"()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE head_turn_id UUID; head_sequence INTEGER;
BEGIN
  SELECT c."headTurnId", c."headSequence" INTO head_turn_id, head_sequence
  FROM "UnifiedQuestionConversation" c
  WHERE c."id" = NEW."conversationId" AND c."ownerUserId" = NEW."ownerUserId";
  IF NOT FOUND OR head_turn_id IS DISTINCT FROM NEW."id" OR head_sequence IS DISTINCT FROM NEW."sequence" THEN
    RAISE EXCEPTION 'unified question turn must advance the conversation head' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION "unified_question_turn_immutable_guard"()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN RAISE EXCEPTION 'unified question turns are immutable' USING ERRCODE = 'check_violation'; END;
$$;

CREATE FUNCTION "unified_question_audit_transition_guard"()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'unified question audit rows cannot be deleted' USING ERRCODE = 'check_violation'; END IF;
  IF (to_jsonb(OLD) - ARRAY['status', 'safeErrorCode', 'providerRequestId', 'inputTokens', 'outputTokens', 'usageKnown', 'completedAt'])
    IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['status', 'safeErrorCode', 'providerRequestId', 'inputTokens', 'outputTokens', 'usageKnown', 'completedAt'])
    OR OLD."status" <> 'running' OR NEW."status" NOT IN ('succeeded', 'failed', 'unknown') OR NEW."completedAt" IS NULL THEN
    RAISE EXCEPTION 'unified question audit transition is invalid' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION "unified_question_token_reservation_guard"()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE expected_confirmation_id UUID; proof "UnifiedQuestionConfirmation"%ROWTYPE; audit_proof "UnifiedQuestionAudit"%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD."unifiedQuestionConfirmationId" IS DISTINCT FROM NEW."unifiedQuestionConfirmationId"
      OR (OLD."unifiedQuestionConfirmationId" IS NULL AND NEW."callKey" LIKE 'unified-question:%')
      OR (OLD."unifiedQuestionConfirmationId" IS NOT NULL AND ROW(
        OLD."userId", OLD."callKey", OLD."providerConnectionId", OLD."operation", OLD."modelId",
        OLD."routeSource", OLD."routeId", OLD."routeVersion", OLD."routeUpdatedAt",
        OLD."providerConfigurationVersion", OLD."quotaMultiplierBps", OLD."routeFenceFingerprint",
        OLD."jobId", OLD."webAiGrantId", OLD."webAiGrantReferenceId", OLD."webAiGrantProjectId",
        OLD."personalKnowledgeQaChallengeId", OLD."personalKnowledgeSemanticChallengeId",
        OLD."personalKnowledgeExtractionAttemptId", OLD."personalKnowledgeExtractionPageIndex"
      ) IS DISTINCT FROM ROW(
        NEW."userId", NEW."callKey", NEW."providerConnectionId", NEW."operation", NEW."modelId",
        NEW."routeSource", NEW."routeId", NEW."routeVersion", NEW."routeUpdatedAt",
        NEW."providerConfigurationVersion", NEW."quotaMultiplierBps", NEW."routeFenceFingerprint",
        NEW."jobId", NEW."webAiGrantId", NEW."webAiGrantReferenceId", NEW."webAiGrantProjectId",
        NEW."personalKnowledgeQaChallengeId", NEW."personalKnowledgeSemanticChallengeId",
        NEW."personalKnowledgeExtractionAttemptId", NEW."personalKnowledgeExtractionPageIndex"
      )) THEN
      RAISE EXCEPTION 'unified question reservation binding is immutable' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."callKey" NOT LIKE 'unified-question:%' THEN
    IF NEW."unifiedQuestionConfirmationId" IS NOT NULL THEN RAISE EXCEPTION 'unified question reservation key mismatch' USING ERRCODE = 'check_violation'; END IF;
    RETURN NEW;
  END IF;
  IF NEW."callKey" !~ '^unified-question:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'invalid unified question reservation key' USING ERRCODE = 'check_violation';
  END IF;
  expected_confirmation_id := substring(NEW."callKey" from 18 for 36)::uuid;
  IF NEW."unifiedQuestionConfirmationId" IS NOT NULL AND NEW."unifiedQuestionConfirmationId" IS DISTINCT FROM expected_confirmation_id THEN
    RAISE EXCEPTION 'unified question reservation key binding mismatch' USING ERRCODE = 'check_violation';
  END IF;
  NEW."unifiedQuestionConfirmationId" := expected_confirmation_id;
  SELECT * INTO proof FROM "UnifiedQuestionConfirmation" WHERE "id" = expected_confirmation_id AND "ownerUserId" = NEW."userId";
  IF NOT FOUND THEN RAISE EXCEPTION 'unified question confirmation evidence is missing' USING ERRCODE = 'check_violation'; END IF;
  SELECT * INTO audit_proof FROM "UnifiedQuestionAudit" WHERE "confirmationId" = expected_confirmation_id AND "ownerUserId" = NEW."userId";
  IF NOT FOUND OR proof."status" <> 'consumed' OR proof."consumedAt" IS NULL OR audit_proof."status" <> 'running'
    OR audit_proof."questionHash" IS DISTINCT FROM proof."questionHash"
    OR audit_proof."historyFingerprint" IS DISTINCT FROM proof."historyFingerprint"
    OR audit_proof."evidenceManifest" IS DISTINCT FROM proof."evidenceManifest"
    OR audit_proof."scopeProjectIds" IS DISTINCT FROM proof."scopeProjectIds"
    OR audit_proof."providerConnectionId" IS DISTINCT FROM proof."providerConnectionId"
    OR audit_proof."providerConfigurationVersion" IS DISTINCT FROM proof."providerConfigurationVersion"
    OR audit_proof."modelId" IS DISTINCT FROM proof."modelId"
    OR audit_proof."credentialSecretFingerprint" IS DISTINCT FROM proof."credentialSecretFingerprint"
    OR audit_proof."actorAccountAccessVersion" IS DISTINCT FROM proof."actorAccountAccessVersion"
    OR audit_proof."routeFenceFingerprint" IS DISTINCT FROM proof."routeFenceFingerprint"
    OR NEW."webAiGrantId" IS NOT NULL OR NEW."webAiGrantReferenceId" IS NOT NULL OR NEW."webAiGrantProjectId" IS NOT NULL
    OR NEW."personalKnowledgeQaChallengeId" IS NOT NULL OR NEW."personalKnowledgeSemanticChallengeId" IS NOT NULL
    OR NEW."personalKnowledgeExtractionAttemptId" IS NOT NULL OR NEW."personalKnowledgeExtractionPageIndex" IS NOT NULL
    OR NEW."jobId" IS NOT NULL OR NEW."providerConnectionId" IS DISTINCT FROM proof."providerConnectionId"
    OR NEW."providerConfigurationVersion" IS DISTINCT FROM proof."providerConfigurationVersion"
    OR NEW."modelId" IS DISTINCT FROM proof."modelId" OR NEW."operation" <> 'generateWithContext'
    OR NEW."routeSource" IS DISTINCT FROM 'platform_default' OR NEW."routeId" IS DISTINCT FROM proof."routeId"
    OR NEW."routeVersion" IS DISTINCT FROM proof."routeVersion" OR NEW."routeUpdatedAt" IS DISTINCT FROM proof."routeUpdatedAt"
    OR NEW."quotaMultiplierBps" IS DISTINCT FROM proof."quotaMultiplierBps"
    OR NEW."routeFenceFingerprint" IS DISTINCT FROM proof."routeFenceFingerprint"
    OR NOT EXISTS (
      SELECT 1 FROM "PlatformDefaultAiRoute" r
        JOIN "AiProviderConnection" p ON p."id" = r."providerConnectionId"
        JOIN "ExternalCredential" c ON c."id" = p."credentialId"
      WHERE r."id" = proof."routeId" AND r."operation" = 'generateWithContext'
        AND r."status" = 'active' AND r."version" = proof."routeVersion"
        AND r."version" = (SELECT max(active."version") FROM "PlatformDefaultAiRoute" active
          WHERE active."operation" = 'generateWithContext' AND active."status" = 'active')
        AND r."updatedAt" = proof."routeUpdatedAt" AND r."quotaMultiplierBps" = proof."quotaMultiplierBps"
        AND r."maxOutputTokens" = proof."maxOutputTokens" AND r."maxOutputTokens" BETWEEN 1 AND 4096
        AND r."validatedAt" IS NOT NULL AND r."validatedProviderConfigurationVersion" = proof."providerConfigurationVersion"
        AND r."modelId" = proof."modelId" AND r."embeddingDimensions" IS NULL
        AND p."id" = proof."providerConnectionId" AND p."scope" = 'platform' AND p."ownerUserId" IS NULL
        AND p."protocol" = 'chat_completions' AND p."status" = 'verified' AND p."disabledAt" IS NULL
        AND p."configurationVersion" = proof."providerConfigurationVersion" AND p."defaultGenerationModelId" = proof."modelId"
        AND p."baseUrl" = CASE p."kind"
          WHEN 'openai' THEN 'https://api.openai.com/v1' WHEN 'deepseek' THEN 'https://api.deepseek.com'
          WHEN 'qwen' THEN 'https://dashscope.aliyuncs.com/compatible-mode/v1'
          WHEN 'glm' THEN 'https://open.bigmodel.cn/api/paas/v4' ELSE NULL END
        AND c."kind" = 'ai_provider' AND c."secretFingerprint" = proof."credentialSecretFingerprint"
    ) THEN
    RAISE EXCEPTION 'unified question reservation requires matching consumed confirmation and route' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION "unified_question_runtime_evidence_guard"()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE reservation_final "PlatformTokenReservation"%ROWTYPE;
BEGIN
  SELECT * INTO reservation_final FROM "PlatformTokenReservation" WHERE "id" = NEW."id";
  IF NOT FOUND THEN RAISE EXCEPTION 'unified question reservation evidence row is missing' USING ERRCODE = 'check_violation'; END IF;
  IF reservation_final."unifiedQuestionConfirmationId" IS NULL THEN RETURN NEW; END IF;
  IF reservation_final."callKey" IS DISTINCT FROM 'unified-question:' || reservation_final."unifiedQuestionConfirmationId"::text
    OR reservation_final."routeSource" IS DISTINCT FROM 'platform_default' OR reservation_final."operation" <> 'generateWithContext'
    OR NOT EXISTS (
      SELECT 1 FROM "UnifiedQuestionConfirmation" c
        JOIN "UnifiedQuestionAudit" a ON a."ownerUserId" = c."ownerUserId" AND a."confirmationId" = c."id"
        JOIN "PlatformTokenGrant" g ON g."id" = reservation_final."grantId" AND g."userId" = reservation_final."userId"
      WHERE c."id" = reservation_final."unifiedQuestionConfirmationId"
        AND c."ownerUserId" = reservation_final."userId" AND c."status" = 'consumed' AND c."consumedAt" IS NOT NULL
        AND a."status" IN ('running', 'succeeded', 'failed', 'unknown')
        AND a."questionHash" = c."questionHash" AND a."historyFingerprint" = c."historyFingerprint"
        AND a."evidenceManifest" = c."evidenceManifest" AND a."scopeProjectIds" = c."scopeProjectIds"
        AND a."providerConnectionId" = reservation_final."providerConnectionId"
        AND a."providerConfigurationVersion" = reservation_final."providerConfigurationVersion"
        AND a."modelId" = reservation_final."modelId" AND a."routeFenceFingerprint" = reservation_final."routeFenceFingerprint"
    ) THEN
    RAISE EXCEPTION 'unified question reservation evidence mismatch' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "UnifiedQuestionConversation_head_guard" BEFORE UPDATE OR DELETE ON "UnifiedQuestionConversation"
  FOR EACH ROW EXECUTE FUNCTION "unified_question_conversation_head_guard"();
CREATE TRIGGER "UnifiedQuestionTurn_insert_guard" BEFORE INSERT ON "UnifiedQuestionTurn"
  FOR EACH ROW EXECUTE FUNCTION "unified_question_turn_insert_guard"();
CREATE CONSTRAINT TRIGGER "UnifiedQuestionTurn_head_evidence_guard"
  AFTER INSERT ON "UnifiedQuestionTurn" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "unified_question_turn_head_evidence_guard"();
CREATE TRIGGER "UnifiedQuestionTurn_immutable_guard" BEFORE UPDATE OR DELETE ON "UnifiedQuestionTurn"
  FOR EACH ROW EXECUTE FUNCTION "unified_question_turn_immutable_guard"();
CREATE TRIGGER "UnifiedQuestionConfirmation_transition_guard" BEFORE UPDATE OR DELETE ON "UnifiedQuestionConfirmation"
  FOR EACH ROW EXECUTE FUNCTION "unified_question_confirmation_transition_guard"();
CREATE TRIGGER "UnifiedQuestionAudit_transition_guard" BEFORE UPDATE OR DELETE ON "UnifiedQuestionAudit"
  FOR EACH ROW EXECUTE FUNCTION "unified_question_audit_transition_guard"();

CREATE TRIGGER "PlatformTokenReservation_unified_question_guard"
  BEFORE INSERT OR UPDATE ON "PlatformTokenReservation"
  FOR EACH ROW EXECUTE FUNCTION "unified_question_token_reservation_guard"();
DROP TRIGGER "PlatformTokenReservation_runtime_evidence_guard" ON "PlatformTokenReservation";
CREATE CONSTRAINT TRIGGER "PlatformTokenReservation_runtime_evidence_guard"
AFTER INSERT OR UPDATE ON "PlatformTokenReservation"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW WHEN (NEW."unifiedQuestionConfirmationId" IS NULL)
EXECUTE FUNCTION "runtime_ai_evidence_consistency_guard"();
CREATE CONSTRAINT TRIGGER "PlatformTokenReservation_unified_runtime_evidence_guard"
AFTER INSERT OR UPDATE ON "PlatformTokenReservation"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW WHEN (NEW."unifiedQuestionConfirmationId" IS NOT NULL)
EXECUTE FUNCTION "unified_question_runtime_evidence_guard"();


REVOKE ALL ON FUNCTION "unified_question_conversation_head_guard"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "unified_question_turn_insert_guard"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "unified_question_turn_head_evidence_guard"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "unified_question_turn_immutable_guard"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "unified_question_confirmation_transition_guard"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "unified_question_audit_transition_guard"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "unified_question_token_reservation_guard"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "unified_question_runtime_evidence_guard"() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_project_os_runtime') THEN
    REVOKE ALL ON FUNCTION "unified_question_conversation_head_guard"() FROM ai_project_os_runtime;
    REVOKE ALL ON FUNCTION "unified_question_turn_insert_guard"() FROM ai_project_os_runtime;
    REVOKE ALL ON FUNCTION "unified_question_turn_head_evidence_guard"() FROM ai_project_os_runtime;
    REVOKE ALL ON FUNCTION "unified_question_turn_immutable_guard"() FROM ai_project_os_runtime;
    REVOKE ALL ON FUNCTION "unified_question_confirmation_transition_guard"() FROM ai_project_os_runtime;
    REVOKE ALL ON FUNCTION "unified_question_audit_transition_guard"() FROM ai_project_os_runtime;
    REVOKE ALL ON FUNCTION "unified_question_token_reservation_guard"() FROM ai_project_os_runtime;
    REVOKE ALL ON FUNCTION "unified_question_runtime_evidence_guard"() FROM ai_project_os_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_project_os_entitlement_writer') THEN
    REVOKE ALL ON FUNCTION "unified_question_conversation_head_guard"() FROM ai_project_os_entitlement_writer;
    REVOKE ALL ON FUNCTION "unified_question_turn_insert_guard"() FROM ai_project_os_entitlement_writer;
    REVOKE ALL ON FUNCTION "unified_question_turn_head_evidence_guard"() FROM ai_project_os_entitlement_writer;
    REVOKE ALL ON FUNCTION "unified_question_turn_immutable_guard"() FROM ai_project_os_entitlement_writer;
    REVOKE ALL ON FUNCTION "unified_question_confirmation_transition_guard"() FROM ai_project_os_entitlement_writer;
    REVOKE ALL ON FUNCTION "unified_question_audit_transition_guard"() FROM ai_project_os_entitlement_writer;
    REVOKE ALL ON FUNCTION "unified_question_token_reservation_guard"() FROM ai_project_os_entitlement_writer;
    REVOKE ALL ON FUNCTION "unified_question_runtime_evidence_guard"() FROM ai_project_os_entitlement_writer;
  END IF;
END $$;
