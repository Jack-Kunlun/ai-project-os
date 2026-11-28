-- Recovery state is mutable and owner-bound; existing successful turn,
-- confirmation and provider-audit evidence remain immutable as before.
CREATE TYPE "UnifiedQuestionProgressStatus" AS ENUM (
  'running', 'stopping', 'stopped', 'succeeded', 'failed', 'unknown'
);

ALTER TABLE "UnifiedQuestionConfirmation"
  ADD COLUMN "resumeFromConfirmationId" UUID,
  ADD CONSTRAINT "UnifiedQuestionConfirmation_resume_from_fkey"
    FOREIGN KEY ("resumeFromConfirmationId")
    REFERENCES "UnifiedQuestionConfirmation"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
CREATE UNIQUE INDEX "UnifiedQuestionConfirmation_resume_active_key"
  ON "UnifiedQuestionConfirmation"("resumeFromConfirmationId")
  WHERE "resumeFromConfirmationId" IS NOT NULL AND "status" IN ('issued', 'consumed');

CREATE TABLE "UnifiedQuestionProgress" (
  "confirmationId" UUID NOT NULL,
  "ownerUserId" UUID NOT NULL,
  "conversationId" UUID NOT NULL,
  "status" "UnifiedQuestionProgressStatus" NOT NULL,
  "partialAnswer" VARCHAR(50000) NOT NULL DEFAULT '',
  "stopRequestedAt" TIMESTAMP(3),
  "heartbeatAt" TIMESTAMP(3) NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UnifiedQuestionProgress_pkey" PRIMARY KEY ("confirmationId"),
  CONSTRAINT "UnifiedQuestionProgress_owner_fkey" FOREIGN KEY ("ownerUserId")
    REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "UnifiedQuestionProgress_conversation_fkey" FOREIGN KEY ("ownerUserId", "conversationId")
    REFERENCES "UnifiedQuestionConversation"("ownerUserId", "id") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "UnifiedQuestionProgress_confirmation_fkey" FOREIGN KEY ("confirmationId")
    REFERENCES "UnifiedQuestionConfirmation"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "UnifiedQuestionProgress_shape_check" CHECK (
    length("partialAnswer") <= 50000
    AND ("status" <> 'stopping' OR "stopRequestedAt" IS NOT NULL)
    AND ("status" <> 'stopped' OR "stopRequestedAt" IS NOT NULL)
  )
);
CREATE INDEX "UnifiedQuestionProgress_owner_conversation_updated_idx"
  ON "UnifiedQuestionProgress"("ownerUserId", "conversationId", "updatedAt");
CREATE INDEX "UnifiedQuestionProgress_status_heartbeat_idx"
  ON "UnifiedQuestionProgress"("status", "heartbeatAt");

CREATE FUNCTION "unified_question_resume_binding_guard"()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE source "UnifiedQuestionConfirmation"%ROWTYPE;
        source_audit "UnifiedQuestionAudit"%ROWTYPE;
        source_progress "UnifiedQuestionProgress"%ROWTYPE;
BEGIN
  IF NEW."resumeFromConfirmationId" IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO source FROM "UnifiedQuestionConfirmation"
    WHERE "id" = NEW."resumeFromConfirmationId"
      AND "ownerUserId" = NEW."ownerUserId"
      AND "conversationId" = NEW."conversationId";
  IF NOT FOUND OR source."status" <> 'consumed'
    OR source."expectedLastTurnId" IS DISTINCT FROM NEW."expectedLastTurnId"
    OR source."expectedSequence" <> NEW."expectedSequence"
    OR source."expectedVersion" <> NEW."expectedVersion"
    OR source."scope" <> NEW."scope"
    OR source."projectId" IS DISTINCT FROM NEW."projectId"
    OR source."focusDocumentId" IS DISTINCT FROM NEW."focusDocumentId"
    OR source."questionHash" <> NEW."questionHash"
    OR source."historyFingerprint" <> NEW."historyFingerprint"
    OR source."scopeProjectIds" IS DISTINCT FROM NEW."scopeProjectIds"
    OR source."evidenceManifest" IS DISTINCT FROM NEW."evidenceManifest"
    OR source."sourceSnapshots" IS DISTINCT FROM NEW."sourceSnapshots" THEN
    RAISE EXCEPTION 'unified question recovery binding is stale' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO source_audit FROM "UnifiedQuestionAudit"
    WHERE "ownerUserId" = source."ownerUserId" AND "confirmationId" = source."id";
  SELECT * INTO source_progress FROM "UnifiedQuestionProgress"
    WHERE "ownerUserId" = source."ownerUserId" AND "confirmationId" = source."id";
  IF source_audit."id" IS NULL OR source_progress."confirmationId" IS NULL
    OR source_audit."status" NOT IN ('failed', 'unknown')
    OR NOT (
      source_progress."status" IN ('stopped', 'unknown')
      OR (source_progress."status" = 'failed' AND (
        (source_audit."safeErrorCode" IN ('AI_PLATFORM_TOKEN_EXHAUSTED', 'AI_PLATFORM_TOKEN_EXPIRED')
          AND NOT EXISTS (SELECT 1 FROM "PlatformTokenReservation" reservation
            WHERE reservation."userId" = source."ownerUserId"
              AND reservation."unifiedQuestionConfirmationId" = source."id"))
        OR (source_audit."safeErrorCode" IN ('AI_PROVIDER_QUOTA_EXHAUSTED', 'AI_PROVIDER_RATE_LIMITED',
            'AI_PROVIDER_REJECTED', 'AI_PROVIDER_AUTH_FAILED')
          AND EXISTS (SELECT 1 FROM "PlatformTokenReservation" reservation
            WHERE reservation."userId" = source."ownerUserId"
              AND reservation."unifiedQuestionConfirmationId" = source."id"
              AND reservation."status" = 'released'::"PlatformTokenReservationStatus"))
      ))
    )
    OR length(btrim(source_progress."partialAnswer")) = 0 THEN
    RAISE EXCEPTION 'unified question recovery source is not resumable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "UnifiedQuestionConfirmation_resume_binding_guard"
  BEFORE INSERT ON "UnifiedQuestionConfirmation"
  FOR EACH ROW EXECUTE FUNCTION "unified_question_resume_binding_guard"();

CREATE FUNCTION "unified_question_progress_guard"()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE confirmation "UnifiedQuestionConfirmation"%ROWTYPE;
        source_progress "UnifiedQuestionProgress"%ROWTYPE;
        audit_status "UnifiedQuestionAuditStatus";
BEGIN
  IF current_setting('app.unified_question_mutation_context', true) IS DISTINCT FROM 'service-v1' THEN
    RAISE EXCEPTION 'unified question progress requires service context' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'unified question progress cannot be deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO confirmation FROM "UnifiedQuestionConfirmation"
      WHERE "id" = NEW."confirmationId" AND "ownerUserId" = NEW."ownerUserId";
    SELECT "status" INTO audit_status FROM "UnifiedQuestionAudit"
      WHERE "confirmationId" = NEW."confirmationId" AND "ownerUserId" = NEW."ownerUserId";
    IF NOT FOUND OR confirmation."conversationId" <> NEW."conversationId"
      OR confirmation."status" <> 'consumed' OR audit_status <> 'running'
      OR NEW."status" <> 'running' OR NEW."stopRequestedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'unified question progress insert does not match a running request' USING ERRCODE = 'check_violation';
    END IF;
    IF confirmation."resumeFromConfirmationId" IS NOT NULL THEN
      SELECT * INTO source_progress FROM "UnifiedQuestionProgress"
        WHERE "confirmationId" = confirmation."resumeFromConfirmationId"
          AND "ownerUserId" = NEW."ownerUserId";
      IF NOT FOUND OR NEW."partialAnswer" IS DISTINCT FROM (source_progress."partialAnswer" || E'\n\n') THEN
        RAISE EXCEPTION 'unified question recovery prefix does not match its source' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(OLD) - ARRAY['status', 'partialAnswer', 'stopRequestedAt', 'heartbeatAt', 'updatedAt'])
    IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['status', 'partialAnswer', 'stopRequestedAt', 'heartbeatAt', 'updatedAt'])
    OR OLD."status" NOT IN ('running', 'stopping')
    OR NEW."status" NOT IN ('running', 'stopping', 'stopped', 'succeeded', 'failed', 'unknown')
    OR (OLD."status" = 'stopping' AND NEW."status" = 'running')
    OR (NEW."status" IN ('stopping', 'stopped') AND NEW."stopRequestedAt" IS NULL)
    OR (NEW."stopRequestedAt" IS NOT NULL AND OLD."stopRequestedAt" IS NULL AND NEW."status" NOT IN ('stopping', 'stopped'))
    OR left(NEW."partialAnswer", length(OLD."partialAnswer")) <> OLD."partialAnswer" THEN
    RAISE EXCEPTION 'unified question progress transition is invalid' USING ERRCODE = 'check_violation';
  END IF;
  SELECT "status" INTO audit_status FROM "UnifiedQuestionAudit"
    WHERE "confirmationId" = NEW."confirmationId" AND "ownerUserId" = NEW."ownerUserId";
  IF (NEW."status" IN ('running', 'stopping') AND audit_status <> 'running')
    OR (NEW."status" = 'succeeded' AND audit_status <> 'succeeded')
    OR (NEW."status" IN ('failed', 'stopped') AND audit_status <> 'failed')
    OR (NEW."status" = 'unknown' AND audit_status <> 'unknown') THEN
    RAISE EXCEPTION 'unified question progress and audit states do not match' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "UnifiedQuestionProgress_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "UnifiedQuestionProgress"
  FOR EACH ROW EXECUTE FUNCTION "unified_question_progress_guard"();

REVOKE ALL ON FUNCTION "unified_question_resume_binding_guard"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "unified_question_progress_guard"() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_project_os_runtime') THEN
    REVOKE ALL ON FUNCTION "unified_question_resume_binding_guard"() FROM ai_project_os_runtime;
    REVOKE ALL ON FUNCTION "unified_question_progress_guard"() FROM ai_project_os_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_project_os_entitlement_writer') THEN
    REVOKE ALL ON FUNCTION "unified_question_resume_binding_guard"() FROM ai_project_os_entitlement_writer;
    REVOKE ALL ON FUNCTION "unified_question_progress_guard"() FROM ai_project_os_entitlement_writer;
  END IF;
END $$;
