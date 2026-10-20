-- Display preferences are separate from immutable conversation evidence.
CREATE TABLE "UnifiedQuestionPresentationRevision" (
  "id" UUID NOT NULL,
  "ownerUserId" UUID NOT NULL,
  "conversationId" UUID NOT NULL,
  "revision" INTEGER NOT NULL,
  "title" VARCHAR(120),
  "pinned" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UnifiedQuestionPresentationRevision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "UnifiedQuestionPresentationRevision_conversation_fkey" FOREIGN KEY ("ownerUserId", "conversationId")
    REFERENCES "UnifiedQuestionConversation"("ownerUserId", "id") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "UnifiedQuestionPresentationRevision_shape_check" CHECK (
    "revision" > 0 AND ("title" IS NULL OR (length(btrim("title")) BETWEEN 1 AND 120 AND "title" !~ '[[:cntrl:]]'))
  )
);
CREATE UNIQUE INDEX "UnifiedQuestionPresentationRevision_conversation_revision_key"
  ON "UnifiedQuestionPresentationRevision"("conversationId", "revision");
CREATE INDEX "UnifiedQuestionPresentationRevision_owner_conv_rev_idx"
  ON "UnifiedQuestionPresentationRevision"("ownerUserId", "conversationId", "revision");

CREATE FUNCTION "unified_question_presentation_guard"()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE previous_revision INTEGER; completed_head UUID;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'unified question display revisions are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF current_setting('app.unified_question_mutation_context', true) IS DISTINCT FROM 'service-v1' THEN
    RAISE EXCEPTION 'unified question display revision requires service context' USING ERRCODE = 'check_violation';
  END IF;
  -- Serialize revisions even for callers outside the application lock protocol.
  SELECT "headTurnId" INTO completed_head FROM "UnifiedQuestionConversation"
    WHERE "ownerUserId" = NEW."ownerUserId" AND "id" = NEW."conversationId" FOR UPDATE;
  IF NOT FOUND OR completed_head IS NULL THEN
    RAISE EXCEPTION 'unified question display revision requires a completed conversation' USING ERRCODE = 'check_violation';
  END IF;
  SELECT COALESCE(MAX("revision"), 0) INTO previous_revision FROM "UnifiedQuestionPresentationRevision"
    WHERE "ownerUserId" = NEW."ownerUserId" AND "conversationId" = NEW."conversationId";
  IF NEW."revision" <> previous_revision + 1 THEN
    RAISE EXCEPTION 'unified question display revision must append' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "UnifiedQuestionPresentationRevision_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "UnifiedQuestionPresentationRevision"
  FOR EACH ROW EXECUTE FUNCTION "unified_question_presentation_guard"();
