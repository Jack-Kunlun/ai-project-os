-- R-07 / UX-005: give activity records a durable, typed subject and an
-- explicit attention intent.  The stored actionHref remains historical
-- presentation data; runtime destinations are projected from these fields.
CREATE TYPE "NotificationSubjectKind" AS ENUM (
  'legacy',
  'project_action',
  'background_job',
  'automation_run'
);

CREATE TYPE "NotificationAttentionIntent" AS ENUM (
  'informational',
  'requires_attention'
);

ALTER TABLE "Notification"
  ADD COLUMN "subjectKind" "NotificationSubjectKind" NOT NULL DEFAULT 'legacy',
  ADD COLUMN "subjectId" UUID,
  ADD COLUMN "attentionIntent" "NotificationAttentionIntent" NOT NULL DEFAULT 'informational';

-- Backfill only exact, same-project, existing subjects.  A path, title,
-- body, dedupe key, or timestamp is never treated as proof on its own.
UPDATE "Notification" AS n
   SET "subjectKind" = 'project_action',
       "subjectId" = (substring(n."actionHref" FROM '^/projects/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}/actions\?action=([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$'))::uuid,
       "attentionIntent" = CASE
         WHEN n."kind" IN ('action_approval_required', 'action_failed') THEN 'requires_attention'::"NotificationAttentionIntent"
         ELSE 'informational'::"NotificationAttentionIntent"
       END
  FROM "ProjectAction" AS a
 WHERE n."projectId" IS NOT NULL
   AND n."kind" IN ('action_approval_required', 'action_completed', 'action_failed')
   AND n."actionHref" ~ '^/projects/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}/actions\?action=[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
   AND n."projectId" = (substring(n."actionHref" FROM '^/projects/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})/actions\?action=[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'))::uuid
   AND a."id" = (substring(n."actionHref" FROM '^/projects/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}/actions\?action=([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$'))::uuid
   AND a."projectId" = n."projectId";

UPDATE "Notification" AS n
   SET "subjectKind" = 'background_job',
       "subjectId" = (substring(n."actionHref" FROM '^/projects/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}/jobs/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$'))::uuid,
       "attentionIntent" = CASE
         WHEN j."status" = 'failed' OR (j."status" = 'unknown' AND j."reconciliationRequired") THEN 'requires_attention'::"NotificationAttentionIntent"
         ELSE 'informational'::"NotificationAttentionIntent"
       END
  FROM "BackgroundJob" AS j
 WHERE n."projectId" IS NOT NULL
   AND n."kind" = 'system'
   AND n."actionHref" ~ '^/projects/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}/jobs/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
   AND n."projectId" = (substring(n."actionHref" FROM '^/projects/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})/jobs/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'))::uuid
   AND j."id" = (substring(n."actionHref" FROM '^/projects/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}/jobs/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$'))::uuid
   AND j."projectId" = n."projectId";

UPDATE "Notification" AS n
   SET "subjectKind" = 'automation_run',
       "subjectId" = (substring(n."actionHref" FROM '^/projects/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}/automations\?run=([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$'))::uuid,
       "attentionIntent" = CASE
         WHEN n."kind" = 'automation_failed' THEN 'requires_attention'::"NotificationAttentionIntent"
         ELSE 'informational'::"NotificationAttentionIntent"
       END
  FROM "AutomationRun" AS r
 WHERE n."projectId" IS NOT NULL
   AND n."actionHref" ~ '^/projects/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}/automations\?run=[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
   AND n."projectId" = (substring(n."actionHref" FROM '^/projects/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})/automations\?run=[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'))::uuid
   AND r."id" = (substring(n."actionHref" FROM '^/projects/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}/automations\?run=([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$'))::uuid
   AND r."projectId" = n."projectId";

ALTER TABLE "Notification"
  ADD CONSTRAINT "Notification_subject_context_check"
  CHECK (
    ("subjectKind" = 'legacy' AND "subjectId" IS NULL AND "attentionIntent" = 'informational')
    OR
    ("subjectKind" <> 'legacy' AND "subjectId" IS NOT NULL AND "projectId" IS NOT NULL)
  );

CREATE INDEX "Notification_userId_attentionIntent_createdAt_id_idx"
  ON "Notification"("userId", "attentionIntent", "createdAt", "id");

CREATE INDEX "Notification_subjectKind_subjectId_idx"
  ON "Notification"("subjectKind", "subjectId");

CREATE OR REPLACE FUNCTION "notification_subject_context_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD."subjectKind" IS DISTINCT FROM NEW."subjectKind"
     OR OLD."subjectId" IS DISTINCT FROM NEW."subjectId"
     OR OLD."projectId" IS DISTINCT FROM NEW."projectId"
     OR OLD."attentionIntent" IS DISTINCT FROM NEW."attentionIntent"
  THEN
    RAISE EXCEPTION 'notification subject context is immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Notification_subject_context_guard"
BEFORE UPDATE OF "subjectKind", "subjectId", "projectId", "attentionIntent" ON "Notification"
FOR EACH ROW EXECUTE FUNCTION "notification_subject_context_guard"();

-- Trigger functions are invoked by PostgreSQL's trigger manager, never by an
-- application principal.
REVOKE ALL ON FUNCTION "notification_subject_context_guard"() FROM PUBLIC;
