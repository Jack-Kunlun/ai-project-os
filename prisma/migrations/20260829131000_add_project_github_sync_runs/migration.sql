-- Persist the scope, per-target outcome and safe change manifest for the
-- explicit project-wide GitHub synchronization workflow. The workflow is
-- request-bound; no historical rows are backfilled by this migration.
CREATE TYPE "ProjectGitHubSyncRunStatus" AS ENUM (
    'queued',
    'running',
    'succeeded',
    'partial',
    'failed',
    'rate_limited',
    'unknown',
    'cancelled'
);

CREATE TYPE "ProjectGitHubSyncStage" AS ENUM (
    'queued',
    'freezing',
    'code',
    'material',
    'finalizing',
    'terminal'
);

CREATE TYPE "ProjectGitHubSyncEntryKind" AS ENUM (
    'code',
    'material'
);

CREATE TYPE "ProjectGitHubSyncEntryStatus" AS ENUM (
    'pending',
    'running',
    'succeeded',
    'partial',
    'failed',
    'rate_limited',
    'unknown',
    'skipped'
);

CREATE TYPE "ProjectGitHubSyncChangeType" AS ENUM (
    'added',
    'updated',
    'deleted',
    'unchanged',
    'withheld'
);

CREATE TYPE "ProjectGitHubSyncReconciliationResolution" AS ENUM (
    'observed_terminal',
    'explicit_abandon'
);

CREATE UNIQUE INDEX "BackgroundJob_project_id_key"
ON "BackgroundJob"("projectId", "id");

CREATE TABLE "ProjectGitHubSyncRun" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "parentJobId" UUID NOT NULL,
    "status" "ProjectGitHubSyncRunStatus" NOT NULL DEFAULT 'queued',
    "stage" "ProjectGitHubSyncStage" NOT NULL DEFAULT 'queued',
    "scopeFingerprint" CHAR(64) NOT NULL,
    "manifestFingerprint" CHAR(64),
    "deadlineAt" TIMESTAMP(3) NOT NULL,
    "codeTargetCount" INTEGER NOT NULL DEFAULT 0,
    "materialTargetCount" INTEGER NOT NULL DEFAULT 0,
    "completedCodeTargetCount" INTEGER NOT NULL DEFAULT 0,
    "completedMaterialTargetCount" INTEGER NOT NULL DEFAULT 0,
    "addedCount" INTEGER NOT NULL DEFAULT 0,
    "updatedCount" INTEGER NOT NULL DEFAULT 0,
    "deletedCount" INTEGER NOT NULL DEFAULT 0,
    "unchangedCount" INTEGER NOT NULL DEFAULT 0,
    "withheldCount" INTEGER NOT NULL DEFAULT 0,
    "warnings" JSONB NOT NULL DEFAULT '[]',
    "failureCode" VARCHAR(64),
    "reconciliationRequired" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ProjectGitHubSyncRun_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ProjectGitHubSyncRun_values_check" CHECK (
        "scopeFingerprint" ~ '^[0-9a-f]{64}$'
        AND ("manifestFingerprint" IS NULL OR "manifestFingerprint" ~ '^[0-9a-f]{64}$')
        AND "codeTargetCount" >= 0
        AND "materialTargetCount" >= 0
        AND "completedCodeTargetCount" BETWEEN 0 AND "codeTargetCount"
        AND "completedMaterialTargetCount" BETWEEN 0 AND "materialTargetCount"
        AND "addedCount" >= 0
        AND "updatedCount" >= 0
        AND "deletedCount" >= 0
        AND "unchangedCount" >= 0
        AND "withheldCount" >= 0
        AND jsonb_typeof("warnings") = 'array'
    ),
    CONSTRAINT "ProjectGitHubSyncRun_lifecycle_check" CHECK (
        ("status" = 'queued' AND "startedAt" IS NULL AND "completedAt" IS NULL)
        OR ("status" = 'running' AND "startedAt" IS NOT NULL AND "completedAt" IS NULL)
        OR ("status" IN ('succeeded', 'partial', 'failed', 'rate_limited', 'unknown', 'cancelled')
            AND "completedAt" IS NOT NULL
            AND "completedCodeTargetCount" = "codeTargetCount"
            AND "completedMaterialTargetCount" = "materialTargetCount"
            AND ("status" <> 'unknown' OR "manifestFingerprint" IS NULL))
    )
);

CREATE UNIQUE INDEX "ProjectGitHubSyncRun_project_id_key"
ON "ProjectGitHubSyncRun"("projectId", "id");
CREATE UNIQUE INDEX "ProjectGitHubSyncRun_parentJobId_key"
ON "ProjectGitHubSyncRun"("parentJobId");
CREATE UNIQUE INDEX "ProjectGitHubSyncRun_project_job_key"
ON "ProjectGitHubSyncRun"("projectId", "parentJobId");
CREATE UNIQUE INDEX "ProjectGitHubSyncRun_active_project_key"
ON "ProjectGitHubSyncRun"("projectId")
WHERE "status" IN ('queued', 'running');
CREATE INDEX "ProjectGitHubSyncRun_project_status_createdAt_idx"
ON "ProjectGitHubSyncRun"("projectId", "status", "createdAt");
CREATE INDEX "ProjectGitHubSyncRun_project_deadline_status_idx"
ON "ProjectGitHubSyncRun"("projectId", "deadlineAt", "status");

CREATE TABLE "ProjectGitHubSyncEntry" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "syncRunId" UUID NOT NULL,
    "projectRepositoryLinkId" UUID NOT NULL,
    "githubConnectionId" UUID NOT NULL,
    "credentialId" UUID NOT NULL,
    "credentialSecretFingerprint" CHAR(64) NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "targetKind" "ProjectGitHubSyncEntryKind" NOT NULL,
    "targetKey" VARCHAR(1024) NOT NULL,
    "status" "ProjectGitHubSyncEntryStatus" NOT NULL DEFAULT 'pending',
    "githubRepositoryId" BIGINT NOT NULL,
    "repositoryNodeId" VARCHAR(512) NOT NULL,
    "repositoryOwner" VARCHAR(256) NOT NULL,
    "repositoryName" VARCHAR(256) NOT NULL,
    "repositoryFullName" VARCHAR(512) NOT NULL,
    "configVersion" INTEGER NOT NULL,
    "effectivePolicyVersion" INTEGER NOT NULL,
    "requiredForProjectSnapshot" BOOLEAN NOT NULL,
    "trackedRef" VARCHAR(255) NOT NULL,
    "scanScopeFingerprint" CHAR(64) NOT NULL,
    "policyFingerprint" CHAR(64) NOT NULL,
    "configSnapshot" JSONB NOT NULL,
    "beforeCodeGenerationId" UUID,
    "beforeMaterialGenerationId" UUID,
    "childCodeBatchId" UUID,
    "childMaterialSyncRunId" UUID,
    "warning" VARCHAR(128),
    "failureCode" VARCHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ProjectGitHubSyncEntry_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ProjectGitHubSyncEntry_values_check" CHECK (
        "ordinal" >= 0
        AND "githubRepositoryId" > 0
        AND "configVersion" > 0
        AND "effectivePolicyVersion" > 0
        AND "trackedRef" LIKE 'refs/heads/%'
        AND "scanScopeFingerprint" ~ '^[0-9a-f]{64}$'
        AND "policyFingerprint" ~ '^[0-9a-f]{64}$'
        AND "credentialSecretFingerprint" ~ '^[0-9a-f]{64}$'
        AND jsonb_typeof("configSnapshot") = 'object'
        AND (
            ("status" = 'pending' AND "startedAt" IS NULL AND "completedAt" IS NULL)
            OR ("status" = 'running' AND "startedAt" IS NOT NULL AND "completedAt" IS NULL)
            OR ("status" IN ('succeeded', 'partial', 'failed', 'rate_limited', 'unknown', 'skipped')
                AND "completedAt" IS NOT NULL)
        )
        AND (
            ("targetKind" = 'code' AND ("status" <> 'succeeded' OR "childCodeBatchId" IS NOT NULL))
            OR ("targetKind" = 'material' AND ("status" <> 'succeeded' OR "childMaterialSyncRunId" IS NOT NULL))
        )
        AND (
            ("targetKind" = 'code' AND "beforeMaterialGenerationId" IS NULL AND "childMaterialSyncRunId" IS NULL)
            OR ("targetKind" = 'material' AND "beforeCodeGenerationId" IS NULL AND "childCodeBatchId" IS NULL)
        )
    )
);

CREATE UNIQUE INDEX "ProjectGitHubSyncEntry_project_id_key"
ON "ProjectGitHubSyncEntry"("projectId", "id");
CREATE UNIQUE INDEX "ProjectGitHubSyncEntry_run_target_key"
ON "ProjectGitHubSyncEntry"("projectId", "syncRunId", "targetKind", "projectRepositoryLinkId");
CREATE UNIQUE INDEX "ProjectGitHubSyncEntry_run_ordinal_key"
ON "ProjectGitHubSyncEntry"("projectId", "syncRunId", "ordinal");
CREATE INDEX "ProjectGitHubSyncEntry_run_status_ordinal_idx"
ON "ProjectGitHubSyncEntry"("projectId", "syncRunId", "status", "ordinal");
CREATE INDEX "ProjectGitHubSyncEntry_link_kind_createdAt_idx"
ON "ProjectGitHubSyncEntry"("projectId", "projectRepositoryLinkId", "targetKind", "createdAt");

CREATE TABLE "ProjectGitHubSyncChange" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "syncRunId" UUID NOT NULL,
    "entryId" UUID NOT NULL,
    "targetKind" "ProjectGitHubSyncEntryKind" NOT NULL,
    "targetKey" VARCHAR(1024) NOT NULL,
    "identity" VARCHAR(2048) NOT NULL,
    "changeType" "ProjectGitHubSyncChangeType" NOT NULL,
    "normalizedPath" VARCHAR(1024),
    "materialKind" "GitHubMaterialKind",
    "remoteIdentity" VARCHAR(512),
    "beforeContentHash" CHAR(64),
    "afterContentHash" CHAR(64),
    "beforeRevisionFingerprint" CHAR(64),
    "afterRevisionFingerprint" CHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectGitHubSyncChange_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ProjectGitHubSyncChange_values_check" CHECK (
        length("identity") > 0
        AND length("targetKey") > 0
        AND ("beforeContentHash" IS NULL OR "beforeContentHash" ~ '^[0-9a-f]{64}$')
        AND ("afterContentHash" IS NULL OR "afterContentHash" ~ '^[0-9a-f]{64}$')
        AND ("beforeRevisionFingerprint" IS NULL OR "beforeRevisionFingerprint" ~ '^[0-9a-f]{64}$')
        AND ("afterRevisionFingerprint" IS NULL OR "afterRevisionFingerprint" ~ '^[0-9a-f]{64}$')
        AND (
            ("targetKind" = 'code' AND "normalizedPath" IS NOT NULL AND "materialKind" IS NULL AND "remoteIdentity" IS NULL)
            OR ("targetKind" = 'material' AND "normalizedPath" IS NULL AND "materialKind" IS NOT NULL AND "remoteIdentity" IS NOT NULL)
        )
    )
);

CREATE UNIQUE INDEX "ProjectGitHubSyncChange_project_id_key"
ON "ProjectGitHubSyncChange"("projectId", "id");
CREATE UNIQUE INDEX "ProjectGitHubSyncChange_run_identity_key"
ON "ProjectGitHubSyncChange"("projectId", "syncRunId", "entryId", "identity");
CREATE INDEX "ProjectGitHubSyncChange_run_type_kind_idx"
ON "ProjectGitHubSyncChange"("projectId", "syncRunId", "changeType", "targetKind");
CREATE INDEX "ProjectGitHubSyncChange_entry_identity_idx"
ON "ProjectGitHubSyncChange"("projectId", "entryId", "identity");

ALTER TABLE "ProjectGitHubSyncRun"
ADD CONSTRAINT "ProjectGitHubSyncRun_project_fkey"
FOREIGN KEY ("projectId") REFERENCES "Project"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectGitHubSyncRun"
ADD CONSTRAINT "ProjectGitHubSyncRun_parent_job_fkey"
FOREIGN KEY ("projectId", "parentJobId") REFERENCES "BackgroundJob"("projectId", "id")
ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "ProjectGitHubSyncEntry"
ADD CONSTRAINT "ProjectGitHubSyncEntry_project_fkey"
FOREIGN KEY ("projectId") REFERENCES "Project"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectGitHubSyncEntry"
ADD CONSTRAINT "ProjectGitHubSyncEntry_run_fkey"
FOREIGN KEY ("projectId", "syncRunId") REFERENCES "ProjectGitHubSyncRun"("projectId", "id")
ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectGitHubSyncEntry"
ADD CONSTRAINT "ProjectGitHubSyncEntry_link_fkey"
FOREIGN KEY ("projectId", "projectRepositoryLinkId") REFERENCES "ProjectRepositoryLink"("projectId", "id")
ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "ProjectGitHubSyncEntry"
ADD CONSTRAINT "ProjectGitHubSyncEntry_connection_fkey"
FOREIGN KEY ("projectId", "githubConnectionId") REFERENCES "GitHubConnection"("projectId", "id")
ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "ProjectGitHubSyncEntry"
ADD CONSTRAINT "ProjectGitHubSyncEntry_credential_fkey"
FOREIGN KEY ("credentialId") REFERENCES "ExternalCredential"("id")
ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "ProjectGitHubSyncEntry"
ADD CONSTRAINT "ProjectGitHubSyncEntry_config_fkey"
FOREIGN KEY ("projectId", "projectRepositoryLinkId", "configVersion", "effectivePolicyVersion")
REFERENCES "ProjectRepositoryLinkConfigVersion"("projectId", "projectRepositoryLinkId", "version", "effectivePolicyVersion")
ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "ProjectGitHubSyncEntry"
ADD CONSTRAINT "ProjectGitHubSyncEntry_before_code_fkey"
FOREIGN KEY ("projectId", "projectRepositoryLinkId", "beforeCodeGenerationId")
REFERENCES "RepositoryCodeGeneration"("projectId", "projectRepositoryLinkId", "id")
ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "ProjectGitHubSyncEntry"
ADD CONSTRAINT "ProjectGitHubSyncEntry_before_material_fkey"
FOREIGN KEY ("projectId", "projectRepositoryLinkId", "beforeMaterialGenerationId")
REFERENCES "RepositoryMaterialGeneration"("projectId", "projectRepositoryLinkId", "id")
ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "ProjectGitHubSyncEntry"
ADD CONSTRAINT "ProjectGitHubSyncEntry_code_batch_fkey"
FOREIGN KEY ("projectId", "childCodeBatchId") REFERENCES "ProjectScanBatch"("projectId", "id")
ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "ProjectGitHubSyncEntry"
ADD CONSTRAINT "ProjectGitHubSyncEntry_material_run_fkey"
FOREIGN KEY ("projectId", "childMaterialSyncRunId") REFERENCES "GitHubMaterialSyncRun"("projectId", "id")
ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "ProjectGitHubSyncChange"
ADD CONSTRAINT "ProjectGitHubSyncChange_project_fkey"
FOREIGN KEY ("projectId") REFERENCES "Project"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectGitHubSyncChange"
ADD CONSTRAINT "ProjectGitHubSyncChange_run_fkey"
FOREIGN KEY ("projectId", "syncRunId") REFERENCES "ProjectGitHubSyncRun"("projectId", "id")
ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectGitHubSyncChange"
ADD CONSTRAINT "ProjectGitHubSyncChange_entry_fkey"
FOREIGN KEY ("projectId", "entryId") REFERENCES "ProjectGitHubSyncEntry"("projectId", "id")
ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ProjectGitHubSyncReconciliation" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "syncRunId" UUID NOT NULL,
    "requestedById" UUID NOT NULL,
    "resolution" "ProjectGitHubSyncReconciliationResolution" NOT NULL,
    "childClassifications" JSONB NOT NULL,
    "evidenceFingerprint" CHAR(64) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectGitHubSyncReconciliation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ProjectGitHubSyncReconciliation_values_check" CHECK (
        jsonb_typeof("childClassifications") = 'array'
        AND "evidenceFingerprint" ~ '^[0-9a-f]{64}$'
    )
);

CREATE UNIQUE INDEX "ProjectGitHubSyncReconciliation_project_id_key"
ON "ProjectGitHubSyncReconciliation"("projectId", "id");
CREATE UNIQUE INDEX "ProjectGitHubSyncReconciliation_sync_run_key"
ON "ProjectGitHubSyncReconciliation"("syncRunId");
CREATE UNIQUE INDEX "ProjectGitHubSyncReconciliation_project_run_key"
ON "ProjectGitHubSyncReconciliation"("projectId", "syncRunId");
CREATE INDEX "ProjectGitHubSyncReconciliation_project_createdAt_idx"
ON "ProjectGitHubSyncReconciliation"("projectId", "createdAt");

ALTER TABLE "ProjectGitHubSyncReconciliation"
ADD CONSTRAINT "ProjectGitHubSyncReconciliation_project_fkey"
FOREIGN KEY ("projectId") REFERENCES "Project"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectGitHubSyncReconciliation"
ADD CONSTRAINT "ProjectGitHubSyncReconciliation_run_fkey"
FOREIGN KEY ("projectId", "syncRunId") REFERENCES "ProjectGitHubSyncRun"("projectId", "id")
ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectGitHubSyncReconciliation"
ADD CONSTRAINT "ProjectGitHubSyncReconciliation_requested_by_fkey"
FOREIGN KEY ("requestedById") REFERENCES "AppUser"("id")
ON DELETE NO ACTION ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION "project_github_sync_run_terminal_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF pg_trigger_depth() > 1
           OR NOT EXISTS (SELECT 1 FROM "Project" WHERE "id" = OLD."projectId") THEN
            RETURN OLD;
        END IF;
        IF OLD."status" IN ('succeeded', 'partial', 'failed', 'rate_limited', 'unknown', 'cancelled') THEN
            RAISE EXCEPTION 'terminal project GitHub sync run is immutable'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN OLD;
    END IF;
    IF pg_trigger_depth() <= 1
       AND EXISTS (SELECT 1 FROM "Project" WHERE "id" = OLD."projectId")
       AND OLD."status" IN ('succeeded', 'partial', 'failed', 'rate_limited', 'unknown', 'cancelled') THEN
        RAISE EXCEPTION 'terminal project GitHub sync run is immutable'
            USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" IN ('succeeded', 'partial', 'failed', 'rate_limited', 'unknown', 'cancelled') THEN
        IF NEW."completedAt" IS NULL
           OR NEW."completedCodeTargetCount" <> NEW."codeTargetCount"
           OR NEW."completedMaterialTargetCount" <> NEW."materialTargetCount"
           OR EXISTS (
               SELECT 1
               FROM "ProjectGitHubSyncEntry" entry
               WHERE entry."projectId" = NEW."projectId"
                 AND entry."syncRunId" = NEW."id"
                 AND entry."status" NOT IN ('succeeded', 'partial', 'failed', 'rate_limited', 'unknown', 'skipped')
           ) THEN
            RAISE EXCEPTION 'terminal project GitHub sync run requires terminal entries and complete counts'
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "project_github_sync_run_terminal_guard_trigger"
BEFORE UPDATE OR DELETE ON "ProjectGitHubSyncRun"
FOR EACH ROW
EXECUTE FUNCTION "project_github_sync_run_terminal_guard"();

CREATE OR REPLACE FUNCTION "project_github_sync_child_terminal_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    run_status "ProjectGitHubSyncRunStatus";
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF pg_trigger_depth() > 1
           OR NOT EXISTS (SELECT 1 FROM "Project" WHERE "id" = NEW."projectId") THEN
            RETURN NEW;
        END IF;
        SELECT "status" INTO run_status
        FROM "ProjectGitHubSyncRun"
        WHERE "projectId" = NEW."projectId" AND "id" = NEW."syncRunId";
    ELSE
        IF pg_trigger_depth() > 1
           OR NOT EXISTS (SELECT 1 FROM "Project" WHERE "id" = OLD."projectId") THEN
            RETURN OLD;
        END IF;
        SELECT "status" INTO run_status
        FROM "ProjectGitHubSyncRun"
        WHERE "projectId" = OLD."projectId" AND "id" = OLD."syncRunId";
    END IF;
    IF run_status IN ('succeeded', 'partial', 'failed', 'rate_limited', 'unknown', 'cancelled') THEN
        RAISE EXCEPTION 'terminal project GitHub sync detail is immutable'
            USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "project_github_sync_entry_terminal_guard_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "ProjectGitHubSyncEntry"
FOR EACH ROW
EXECUTE FUNCTION "project_github_sync_child_terminal_guard"();

CREATE TRIGGER "project_github_sync_change_terminal_guard_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "ProjectGitHubSyncChange"
FOR EACH ROW
EXECUTE FUNCTION "project_github_sync_child_terminal_guard"();

CREATE OR REPLACE FUNCTION "project_github_sync_reconciliation_immutable_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM "Project" WHERE "id" = OLD."projectId") THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'project GitHub sync reconciliation is immutable'
        USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER "project_github_sync_reconciliation_immutable_guard_trigger"
BEFORE UPDATE OR DELETE ON "ProjectGitHubSyncReconciliation"
FOR EACH ROW
EXECUTE FUNCTION "project_github_sync_reconciliation_immutable_guard"();
