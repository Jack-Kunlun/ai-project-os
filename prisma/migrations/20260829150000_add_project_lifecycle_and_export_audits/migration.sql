CREATE TYPE "ProjectLifecycleAction" AS ENUM ('archived', 'restored');

ALTER TABLE "Project"
ADD COLUMN "archivedAt" TIMESTAMP(3);

CREATE INDEX "Project_archivedAt_updatedAt_idx"
ON "Project"("archivedAt", "updatedAt");

CREATE TABLE "ProjectLifecycleRevision" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "action" "ProjectLifecycleAction" NOT NULL,
    "actorId" UUID NOT NULL,
    "previousArchivedAt" TIMESTAMP(3),
    "currentArchivedAt" TIMESTAMP(3),
    "projectUpdatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectLifecycleRevision_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ProjectLifecycleRevision_state_check" CHECK (
        ("action" = 'archived' AND "previousArchivedAt" IS NULL AND "currentArchivedAt" IS NOT NULL)
        OR ("action" = 'restored' AND "previousArchivedAt" IS NOT NULL AND "currentArchivedAt" IS NULL)
    )
);

CREATE UNIQUE INDEX "ProjectLifecycleRevision_project_id_key"
ON "ProjectLifecycleRevision"("projectId", "id");
CREATE INDEX "ProjectLifecycleRevision_project_createdAt_idx"
ON "ProjectLifecycleRevision"("projectId", "createdAt");
CREATE INDEX "ProjectLifecycleRevision_actor_createdAt_idx"
ON "ProjectLifecycleRevision"("actorId", "createdAt");

ALTER TABLE "ProjectLifecycleRevision"
ADD CONSTRAINT "ProjectLifecycleRevision_project_fkey"
FOREIGN KEY ("projectId") REFERENCES "Project"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectLifecycleRevision"
ADD CONSTRAINT "ProjectLifecycleRevision_actor_fkey"
FOREIGN KEY ("actorId") REFERENCES "AppUser"("id")
ON DELETE NO ACTION ON UPDATE CASCADE;

CREATE TABLE "ProjectDataExportAudit" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "requestedById" UUID NOT NULL,
    "schemaVersion" VARCHAR(32) NOT NULL,
    "contentHash" CHAR(64) NOT NULL,
    "byteCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectDataExportAudit_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ProjectDataExportAudit_values_check" CHECK (
        "schemaVersion" ~ '^[a-z0-9][a-z0-9._-]{0,31}$'
        AND "contentHash" ~ '^[0-9a-f]{64}$'
        AND "byteCount" > 0
        AND "byteCount" <= 20971520
    )
);

CREATE UNIQUE INDEX "ProjectDataExportAudit_project_id_key"
ON "ProjectDataExportAudit"("projectId", "id");
CREATE INDEX "ProjectDataExportAudit_project_createdAt_idx"
ON "ProjectDataExportAudit"("projectId", "createdAt");
CREATE INDEX "ProjectDataExportAudit_requestedBy_createdAt_idx"
ON "ProjectDataExportAudit"("requestedById", "createdAt");

ALTER TABLE "ProjectDataExportAudit"
ADD CONSTRAINT "ProjectDataExportAudit_project_fkey"
FOREIGN KEY ("projectId") REFERENCES "Project"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectDataExportAudit"
ADD CONSTRAINT "ProjectDataExportAudit_requested_by_fkey"
FOREIGN KEY ("requestedById") REFERENCES "AppUser"("id")
ON DELETE NO ACTION ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION "project_lifecycle_revision_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NOT EXISTS (
            SELECT 1
            FROM "Project" AS project
            WHERE project."id" = NEW."projectId"
              AND project."updatedAt" = NEW."projectUpdatedAt"
              AND project."archivedAt" IS NOT DISTINCT FROM NEW."currentArchivedAt"
        ) THEN
            RAISE EXCEPTION 'project lifecycle revision must match current project state'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;

    IF TG_OP = 'DELETE'
       AND NOT EXISTS (SELECT 1 FROM "Project" WHERE "id" = OLD."projectId") THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'project lifecycle revision is immutable'
        USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER "ProjectLifecycleRevision_immutable_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "ProjectLifecycleRevision"
FOR EACH ROW EXECUTE FUNCTION "project_lifecycle_revision_guard"();

CREATE OR REPLACE FUNCTION "project_data_export_audit_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        RETURN NEW;
    END IF;

    IF TG_OP = 'DELETE'
       AND NOT EXISTS (SELECT 1 FROM "Project" WHERE "id" = OLD."projectId") THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'project data export audit is immutable'
        USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER "ProjectDataExportAudit_immutable_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "ProjectDataExportAudit"
FOR EACH ROW EXECUTE FUNCTION "project_data_export_audit_guard"();
