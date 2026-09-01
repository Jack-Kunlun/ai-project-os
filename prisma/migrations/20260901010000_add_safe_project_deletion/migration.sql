CREATE TYPE "ProjectDeletionStatus" AS ENUM ('pending', 'database_deleted', 'completed', 'cleanup_failed');

CREATE TABLE "ProjectDeletionReceipt" (
    "id" UUID NOT NULL,
    "deletedProjectId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "requestedById" UUID,
    "projectFingerprint" CHAR(64) NOT NULL,
    "expectedUpdatedAt" TIMESTAMP(3) NOT NULL,
    "status" "ProjectDeletionStatus" NOT NULL DEFAULT 'pending',
    "storageStaged" BOOLEAN NOT NULL DEFAULT false,
    "storageFailureCode" VARCHAR(64),
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "databaseDeletedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectDeletionReceipt_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ProjectDeletionReceipt_projectFingerprint_check" CHECK ("projectFingerprint" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "ProjectDeletionReceipt_state_check" CHECK (
        ("status" = 'pending' AND "databaseDeletedAt" IS NULL AND "completedAt" IS NULL AND "storageFailureCode" IS NULL)
        OR ("status" = 'database_deleted' AND "databaseDeletedAt" IS NOT NULL AND "completedAt" IS NULL AND "storageFailureCode" IS NULL)
        OR ("status" = 'completed' AND "databaseDeletedAt" IS NOT NULL AND "completedAt" IS NOT NULL AND "storageFailureCode" IS NULL)
        OR ("status" = 'cleanup_failed' AND "databaseDeletedAt" IS NOT NULL AND "completedAt" IS NULL AND "storageFailureCode" IS NOT NULL)
    )
);

CREATE UNIQUE INDEX "ProjectDeletionReceipt_deletedProjectId_key"
ON "ProjectDeletionReceipt"("deletedProjectId");
CREATE INDEX "ProjectDeletionReceipt_status_requestedAt_idx"
ON "ProjectDeletionReceipt"("status", "requestedAt");
CREATE INDEX "ProjectDeletionReceipt_workspaceId_requestedAt_idx"
ON "ProjectDeletionReceipt"("workspaceId", "requestedAt");
CREATE INDEX "ProjectDeletionReceipt_requestedById_requestedAt_idx"
ON "ProjectDeletionReceipt"("requestedById", "requestedAt");

ALTER TABLE "ProjectDeletionReceipt"
ADD CONSTRAINT "ProjectDeletionReceipt_workspaceId_fkey"
FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectDeletionReceipt"
ADD CONSTRAINT "ProjectDeletionReceipt_requestedById_fkey"
FOREIGN KEY ("requestedById") REFERENCES "AppUser"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION "project_deletion_receipt_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF pg_trigger_depth() > 1 THEN
            RETURN OLD;
        END IF;
        RAISE EXCEPTION 'project deletion receipts are immutable'
            USING ERRCODE = 'check_violation';
    END IF;
    IF pg_trigger_depth() > 1
       AND OLD."requestedById" IS NOT NULL
       AND NEW."requestedById" IS NULL
       AND OLD."id" = NEW."id"
       AND OLD."deletedProjectId" = NEW."deletedProjectId"
       AND OLD."workspaceId" = NEW."workspaceId"
       AND OLD."projectFingerprint" = NEW."projectFingerprint"
       AND OLD."expectedUpdatedAt" = NEW."expectedUpdatedAt"
       AND OLD."status" = NEW."status"
       AND OLD."storageStaged" = NEW."storageStaged"
       AND OLD."storageFailureCode" IS NOT DISTINCT FROM NEW."storageFailureCode"
       AND OLD."requestedAt" = NEW."requestedAt"
       AND OLD."databaseDeletedAt" IS NOT DISTINCT FROM NEW."databaseDeletedAt"
       AND OLD."completedAt" IS NOT DISTINCT FROM NEW."completedAt"
       AND OLD."updatedAt" = NEW."updatedAt" THEN
        RETURN NEW;
    END IF;
    IF OLD."id" <> NEW."id"
       OR OLD."deletedProjectId" <> NEW."deletedProjectId"
       OR OLD."workspaceId" <> NEW."workspaceId"
       OR OLD."requestedById" IS DISTINCT FROM NEW."requestedById"
       OR OLD."projectFingerprint" <> NEW."projectFingerprint"
       OR OLD."expectedUpdatedAt" <> NEW."expectedUpdatedAt"
       OR OLD."requestedAt" <> NEW."requestedAt" THEN
        RAISE EXCEPTION 'project deletion receipt identity is immutable'
            USING ERRCODE = 'check_violation';
    END IF;
    IF NOT (
        (OLD."status" = 'pending' AND NEW."status" = 'database_deleted')
        OR (OLD."status" IN ('database_deleted', 'cleanup_failed') AND NEW."status" IN ('completed', 'cleanup_failed'))
    ) THEN
        RAISE EXCEPTION 'invalid project deletion receipt transition'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "ProjectDeletionReceipt_guard"
BEFORE UPDATE OR DELETE ON "ProjectDeletionReceipt"
FOR EACH ROW EXECUTE FUNCTION "project_deletion_receipt_guard"();
