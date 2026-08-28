-- Record explicit, user-requested closure of an uncertain generic job.  This
-- migration intentionally does not backfill existing unknown jobs: they must
-- remain blocked until a user performs a fresh, auditable reconciliation.
CREATE TYPE "BackgroundJobReconciliationResolution" AS ENUM (
    'explicit_abandon'
);

CREATE TABLE "BackgroundJobReconciliation" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "jobId" UUID NOT NULL,
    "requestedById" UUID NOT NULL,
    "resolution" "BackgroundJobReconciliationResolution" NOT NULL,
    "evidenceFingerprint" CHAR(64) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BackgroundJobReconciliation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "BackgroundJobReconciliation_values_check" CHECK (
        "evidenceFingerprint" ~ '^[0-9a-f]{64}$'
    )
);

CREATE UNIQUE INDEX "BackgroundJobReconciliation_project_id_key"
ON "BackgroundJobReconciliation"("projectId", "id");
CREATE UNIQUE INDEX "BackgroundJobReconciliation_project_job_key"
ON "BackgroundJobReconciliation"("projectId", "jobId");
CREATE INDEX "BackgroundJobReconciliation_project_createdAt_idx"
ON "BackgroundJobReconciliation"("projectId", "createdAt");

ALTER TABLE "BackgroundJobReconciliation"
ADD CONSTRAINT "BackgroundJobReconciliation_project_fkey"
FOREIGN KEY ("projectId") REFERENCES "Project"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BackgroundJobReconciliation"
ADD CONSTRAINT "BackgroundJobReconciliation_job_fkey"
FOREIGN KEY ("projectId", "jobId") REFERENCES "BackgroundJob"("projectId", "id")
ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BackgroundJobReconciliation"
ADD CONSTRAINT "BackgroundJobReconciliation_requested_by_fkey"
FOREIGN KEY ("requestedById") REFERENCES "AppUser"("id")
ON DELETE NO ACTION ON UPDATE CASCADE;

-- A generic reconciliation can only be attached to a project-local unknown
-- job which still explicitly requires reconciliation. Specialized job kinds
-- must use their own reconciliation evidence and can never borrow this row.
CREATE OR REPLACE FUNCTION "background_job_reconciliation_insert_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NOT EXISTS (
            SELECT 1
            FROM "BackgroundJob" AS job
            WHERE job."projectId" = NEW."projectId"
              AND job."id" = NEW."jobId"
              AND job."status" = 'unknown'
              AND job."reconciliationRequired" = true
              AND job."kind" NOT IN ('memory_index', 'github_project_sync', 'github_scan', 'github_material_sync')
        ) THEN
            RAISE EXCEPTION 'generic reconciliation requires an unknown generic job'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;

    -- Direct audit mutation is forbidden.  Only a project cascade may delete
    -- the row after the parent project has disappeared.
    IF TG_OP = 'DELETE'
       AND NOT EXISTS (SELECT 1 FROM "Project" WHERE "id" = OLD."projectId") THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'background job reconciliation is immutable'
        USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER "BackgroundJobReconciliation_immutable_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "BackgroundJobReconciliation"
FOR EACH ROW EXECUTE FUNCTION "background_job_reconciliation_insert_guard"();

-- A job may only release its reconciliation admission after the immutable
-- evidence for that exact job exists in the same transaction. Generic jobs
-- require BackgroundJobReconciliation; specialized jobs require the matching
-- MemoryIndexReconciliation or ProjectGitHubSyncReconciliation row. Generic
-- jobs also remain unknown after explicit abandonment.
CREATE OR REPLACE FUNCTION "background_job_reconciliation_release_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'UPDATE'
       AND OLD."reconciliationRequired" = true
       AND NEW."reconciliationRequired" = false
       AND OLD."kind" <> NEW."kind" THEN
        RAISE EXCEPTION 'reconciliation job kind cannot change while releasing'
            USING ERRCODE = 'check_violation';
    ELSIF TG_OP = 'UPDATE'
       AND OLD."reconciliationRequired" = true
       AND NEW."reconciliationRequired" = false
       AND OLD."kind" NOT IN ('memory_index', 'github_project_sync', 'github_scan', 'github_material_sync') THEN
        IF NEW."status" <> 'unknown' THEN
            RAISE EXCEPTION 'generic reconciled job must remain unknown'
                USING ERRCODE = 'check_violation';
        END IF;
        IF NOT EXISTS (
            SELECT 1
            FROM "BackgroundJobReconciliation" AS reconciliation
            WHERE reconciliation."projectId" = OLD."projectId"
              AND reconciliation."jobId" = OLD."id"
        ) THEN
            RAISE EXCEPTION 'generic job reconciliation evidence is required'
                USING ERRCODE = 'check_violation';
        END IF;
    ELSIF TG_OP = 'UPDATE'
       AND OLD."reconciliationRequired" = true
       AND NEW."reconciliationRequired" = false
       AND OLD."kind" = 'memory_index'
       AND NOT EXISTS (
           SELECT 1
           FROM "MemoryIndexGeneration" AS generation
           JOIN "MemoryIndexReconciliation" AS reconciliation
             ON reconciliation."projectId" = generation."projectId"
            AND reconciliation."indexGenerationId" = generation."id"
           WHERE generation."projectId" = OLD."projectId"
             AND generation."jobId" = OLD."id"
       ) THEN
        RAISE EXCEPTION 'memory index job reconciliation evidence is required'
            USING ERRCODE = 'check_violation';
    ELSIF TG_OP = 'UPDATE'
       AND OLD."reconciliationRequired" = true
       AND NEW."reconciliationRequired" = false
       AND OLD."kind" = 'github_project_sync'
       AND NOT EXISTS (
           SELECT 1
           FROM "ProjectGitHubSyncRun" AS sync_run
           JOIN "ProjectGitHubSyncReconciliation" AS reconciliation
             ON reconciliation."projectId" = sync_run."projectId"
            AND reconciliation."syncRunId" = sync_run."id"
           WHERE sync_run."projectId" = OLD."projectId"
             AND sync_run."parentJobId" = OLD."id"
       ) THEN
        RAISE EXCEPTION 'GitHub project sync job reconciliation evidence is required'
            USING ERRCODE = 'check_violation';
    ELSIF TG_OP = 'UPDATE'
       AND OLD."reconciliationRequired" = true
       AND NEW."reconciliationRequired" = false
       AND OLD."kind" IN ('github_scan', 'github_material_sync') THEN
        RAISE EXCEPTION 'GitHub child job requires its specialized reconciliation'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "BackgroundJob_reconciliation_release_guard"
BEFORE UPDATE ON "BackgroundJob"
FOR EACH ROW EXECUTE FUNCTION "background_job_reconciliation_release_guard"();
