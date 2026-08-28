CREATE OR REPLACE FUNCTION "archived_project_job_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW."projectId" IS NOT NULL
       AND NEW."status" IN ('queued', 'waitingConsent', 'running')
       AND EXISTS (
           SELECT 1
           FROM "Project" AS project
           WHERE project."id" = NEW."projectId"
             AND project."archivedAt" IS NOT NULL
       ) THEN
        RAISE EXCEPTION 'archived project cannot accept active jobs'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "BackgroundJob_archived_project_guard"
BEFORE INSERT OR UPDATE OF "projectId", "status" ON "BackgroundJob"
FOR EACH ROW EXECUTE FUNCTION "archived_project_job_guard"();
