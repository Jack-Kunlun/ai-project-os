-- Inert scheduler ledger for the separately consented Git automation grant.
-- This migration never changes manual-run/pointer semantics and performs no I/O.

CREATE TYPE "ProjectGitRepositoryAutomationCursorStatus" AS ENUM ('active', 'paused');
CREATE TYPE "ProjectGitRepositoryAutomationRunStatus" AS ENUM ('pending', 'dispatched', 'failed', 'unknown');
CREATE TYPE "ProjectGitRepositoryAutomationRunAuditAction" AS ENUM (
  'schedule_initialized', 'schedule_advanced', 'schedule_paused',
  'run_claimed', 'run_heartbeat', 'run_dispatched',
  'run_lease_expired_before_dispatch', 'run_lease_expired_after_dispatch',
  'run_fence_rejected_before_dispatch', 'run_fence_rejected_after_dispatch'
);

-- The cursor is keyed only by the grant. It has no relation to the manual run
-- tables or pointer and keeps just the due time and terminal pause evidence.
CREATE TABLE "ProjectGitRepositoryAutomationScheduleCursor" (
  "grantId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "connectionOwnerId" UUID NOT NULL,
  "nextRunAt" TIMESTAMP(3) NOT NULL,
  "lastScheduledFor" TIMESTAMP(3),
  "status" "ProjectGitRepositoryAutomationCursorStatus" NOT NULL DEFAULT 'active',
  "pauseReason" VARCHAR(64),
  "pausedAt" TIMESTAMP(3),
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PGARSC_pkey" PRIMARY KEY ("grantId"),
  CONSTRAINT "PGARSC_version_check" CHECK ("version" > 0),
  CONSTRAINT "PGARSC_pause_shape_check" CHECK (
    ("status" = 'active' AND "pauseReason" IS NULL AND "pausedAt" IS NULL)
    OR ("status" = 'paused' AND "pauseReason" IS NOT NULL AND "pausedAt" IS NOT NULL)
  )
);
CREATE INDEX "PGARSC_status_due_idx"
  ON "ProjectGitRepositoryAutomationScheduleCursor"("status", "nextRunAt");
CREATE INDEX "PGARSC_project_status_idx"
  ON "ProjectGitRepositoryAutomationScheduleCursor"("projectId", "status");

-- Run rows are scalar-only evidence. No credential, endpoint, content, or
-- manual pointer identifier can enter this model.
CREATE TABLE "ProjectGitRepositoryAutomationRun" (
  "id" UUID NOT NULL,
  "grantId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "gitConnectionId" UUID NOT NULL,
  "baseDelegationId" UUID NOT NULL,
  "connectionOwnerId" UUID NOT NULL,
  "grantVersion" INTEGER NOT NULL,
  "grantFingerprint" CHAR(64) NOT NULL,
  "baseDelegationVersion" INTEGER NOT NULL,
  "baseDelegationFingerprint" CHAR(64) NOT NULL,
  "repositoryPath" VARCHAR(768) NOT NULL,
  "trackedRef" VARCHAR(255) NOT NULL,
  "includeRoots" JSONB NOT NULL,
  "softExcludePatterns" JSONB NOT NULL,
  "runIntervalMinutes" INTEGER NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "scheduledFor" TIMESTAMP(3) NOT NULL,
  "status" "ProjectGitRepositoryAutomationRunStatus" NOT NULL DEFAULT 'pending',
  "version" INTEGER NOT NULL DEFAULT 1,
  "leaseWorkerId" VARCHAR(128),
  "leaseToken" UUID,
  "leaseExpiresAt" TIMESTAMP(3),
  "lastHeartbeatAt" TIMESTAMP(3),
  "claimedAt" TIMESTAMP(3) NOT NULL,
  "dispatchedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "safeErrorCode" VARCHAR(64),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PGAR_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PGAR_version_check" CHECK ("version" > 0),
  CONSTRAINT "PGAR_grant_version_check" CHECK ("grantVersion" > 0 AND "baseDelegationVersion" > 0),
  CONSTRAINT "PGAR_interval_check" CHECK ("runIntervalMinutes" BETWEEN 60 AND 43200),
  CONSTRAINT "PGAR_fingerprint_check" CHECK (
    "grantFingerprint" ~ '^[0-9a-f]{64}$'
    AND "baseDelegationFingerprint" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "PGAR_scope_json_check" CHECK (
    jsonb_typeof("includeRoots") = 'array'
    AND jsonb_typeof("softExcludePatterns") = 'array'
  ),
  CONSTRAINT "PGAR_lease_shape_check" CHECK (
    "leaseWorkerId" IS NOT NULL AND "leaseToken" IS NOT NULL AND "claimedAt" IS NOT NULL
    AND (
      ("status" = 'pending' AND "leaseExpiresAt" IS NOT NULL AND "leaseExpiresAt" > "claimedAt" AND "dispatchedAt" IS NULL AND "completedAt" IS NULL AND "safeErrorCode" IS NULL)
      OR ("status" = 'dispatched' AND "leaseExpiresAt" IS NOT NULL AND "leaseExpiresAt" > "claimedAt" AND "dispatchedAt" IS NOT NULL AND "completedAt" IS NULL AND "safeErrorCode" IS NULL)
      OR ("status" = 'failed' AND "leaseExpiresAt" IS NULL AND "dispatchedAt" IS NULL AND "completedAt" IS NOT NULL AND "safeErrorCode" IS NOT NULL)
      OR ("status" = 'unknown' AND "leaseExpiresAt" IS NULL AND "dispatchedAt" IS NOT NULL AND "completedAt" IS NOT NULL AND "safeErrorCode" IS NOT NULL)
    )
  ),
  CONSTRAINT "PGAR_grant_scheduled_key" UNIQUE ("grantId", "scheduledFor")
);
CREATE INDEX "PGAR_status_lease_idx"
  ON "ProjectGitRepositoryAutomationRun"("status", "leaseExpiresAt");
CREATE INDEX "PGAR_project_created_idx"
  ON "ProjectGitRepositoryAutomationRun"("projectId", "createdAt");
-- A live dispatched/pending run fences new intervals until it is terminal.
CREATE UNIQUE INDEX "PGAR_one_live_run_per_grant_key"
  ON "ProjectGitRepositoryAutomationRun"("grantId")
  WHERE "status" IN ('pending', 'dispatched');

-- One shared append-only table records cursor and run events. It has no foreign
-- keys so deletion of live project configuration cannot erase evidence.
CREATE TABLE "ProjectGitRepositoryAutomationRunAudit" (
  "id" UUID NOT NULL,
  "grantId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "runId" UUID,
  "action" "ProjectGitRepositoryAutomationRunAuditAction" NOT NULL,
  "cursorVersion" INTEGER,
  "cursorStatusAfter" "ProjectGitRepositoryAutomationCursorStatus",
  "nextRunAt" TIMESTAMP(3),
  "lastScheduledFor" TIMESTAMP(3),
  "runVersion" INTEGER,
  "runStatusBefore" "ProjectGitRepositoryAutomationRunStatus",
  "runStatusAfter" "ProjectGitRepositoryAutomationRunStatus",
  "scheduledFor" TIMESTAMP(3),
  "workerId" VARCHAR(128),
  "leaseExpiresAt" TIMESTAMP(3),
  "grantVersion" INTEGER NOT NULL,
  "grantFingerprint" CHAR(64) NOT NULL,
  "reason" VARCHAR(64),
  "transactionId" BIGINT NOT NULL DEFAULT txid_current(),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PGARA_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PGARA_grant_version_check" CHECK ("grantVersion" > 0),
  CONSTRAINT "PGARA_fingerprint_check" CHECK ("grantFingerprint" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "PGARA_version_shape_check" CHECK (
    ("cursorVersion" IS NOT NULL AND "cursorVersion" > 0 AND "runId" IS NULL AND "runVersion" IS NULL
      AND "cursorStatusAfter" IS NOT NULL AND "nextRunAt" IS NOT NULL
      AND "runStatusBefore" IS NULL AND "runStatusAfter" IS NULL AND "scheduledFor" IS NULL)
    OR ("cursorVersion" IS NULL AND "runId" IS NOT NULL AND "runVersion" IS NOT NULL AND "runVersion" > 0
      AND "cursorStatusAfter" IS NULL AND "nextRunAt" IS NULL AND "lastScheduledFor" IS NULL
      AND "runStatusAfter" IS NOT NULL AND "scheduledFor" IS NOT NULL)
  )
);
CREATE UNIQUE INDEX "PGARA_grant_cursor_version_key"
  ON "ProjectGitRepositoryAutomationRunAudit"("grantId", "cursorVersion");
CREATE UNIQUE INDEX "PGARA_run_version_key"
  ON "ProjectGitRepositoryAutomationRunAudit"("runId", "runVersion");
CREATE INDEX "PGARA_project_created_idx"
  ON "ProjectGitRepositoryAutomationRunAudit"("projectId", "createdAt");
CREATE INDEX "PGARA_grant_created_idx"
  ON "ProjectGitRepositoryAutomationRunAudit"("grantId", "createdAt");
CREATE INDEX "PGARA_transaction_created_idx"
  ON "ProjectGitRepositoryAutomationRunAudit"("transactionId", "createdAt");

CREATE OR REPLACE FUNCTION "project_git_automation_cursor_shape_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  expected_next TIMESTAMP(3);
  expected_workspace UUID;
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW."createdAt" := clock_timestamp();
    NEW."updatedAt" := NEW."createdAt";
    IF NEW."version" <> 1 OR NEW."status" <> 'active' OR NEW."pauseReason" IS NOT NULL OR NEW."pausedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_CURSOR_STATE_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    SELECT project."workspaceId", grant_row."activatedAt" + grant_row."runIntervalMinutes" * interval '1 minute'
      INTO expected_workspace, expected_next
      FROM "ProjectGitRepositoryAutomationGrant" grant_row
      JOIN "Project" project ON project."id" = grant_row."projectId"
     WHERE grant_row."id" = NEW."grantId"
       AND grant_row."projectId" = NEW."projectId"
       AND grant_row."connectionOwnerId" = NEW."connectionOwnerId"
       AND project."workspaceId" = NEW."workspaceId"
       AND grant_row."status" = 'active'
       AND grant_row."activatedAt" IS NOT NULL;
    IF expected_workspace IS NULL OR NEW."nextRunAt" IS DISTINCT FROM expected_next THEN
      RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_CURSOR_INITIAL_SCHEDULE_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  NEW."updatedAt" := clock_timestamp();
  IF OLD."grantId" IS DISTINCT FROM NEW."grantId"
     OR OLD."projectId" IS DISTINCT FROM NEW."projectId"
     OR OLD."workspaceId" IS DISTINCT FROM NEW."workspaceId"
     OR OLD."connectionOwnerId" IS DISTINCT FROM NEW."connectionOwnerId"
     OR OLD."createdAt" IS DISTINCT FROM NEW."createdAt" THEN
    RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_CURSOR_IMMUTABLE' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_CURSOR_VERSION_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" = 'paused' THEN
    RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_CURSOR_TERMINAL' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'active' THEN
    IF NEW."nextRunAt" <= OLD."nextRunAt"
       OR NEW."lastScheduledFor" IS DISTINCT FROM OLD."nextRunAt"
       OR NEW."pauseReason" IS NOT NULL OR NEW."pausedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_CURSOR_STATE_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."status" = 'paused' THEN
    IF NEW."nextRunAt" IS DISTINCT FROM OLD."nextRunAt"
       OR NEW."lastScheduledFor" IS DISTINCT FROM OLD."lastScheduledFor"
       OR NEW."pauseReason" IS NULL OR NEW."pausedAt" IS NULL THEN
      RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_CURSOR_STATE_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_CURSOR_STATE_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "PGARSC_shape_guard"
BEFORE INSERT OR UPDATE ON "ProjectGitRepositoryAutomationScheduleCursor"
FOR EACH ROW EXECUTE FUNCTION "project_git_automation_cursor_shape_guard"();

CREATE OR REPLACE FUNCTION "project_git_automation_run_shape_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW."createdAt" := clock_timestamp();
    NEW."updatedAt" := NEW."createdAt";
    NEW."claimedAt" := NEW."createdAt";
    IF NEW."status" <> 'pending' OR NEW."version" <> 1 OR NEW."leaseWorkerId" IS NULL
       OR NEW."leaseToken" IS NULL OR NEW."leaseExpiresAt" <= NEW."createdAt"
       OR NEW."lastHeartbeatAt" IS NOT NULL OR NEW."dispatchedAt" IS NOT NULL
       OR NEW."completedAt" IS NOT NULL OR NEW."safeErrorCode" IS NOT NULL THEN
      RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_RUN_STATE_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (
      SELECT 1
        FROM "ProjectGitRepositoryAutomationGrant" grant_row
        JOIN "Project" project ON project."id" = grant_row."projectId"
        JOIN "ProjectGitRepositoryAutomationScheduleCursor" cursor_row ON cursor_row."grantId" = grant_row."id"
       WHERE grant_row."id" = NEW."grantId"
         AND grant_row."projectId" = NEW."projectId"
         AND project."workspaceId" = NEW."workspaceId"
         AND grant_row."gitConnectionId" = NEW."gitConnectionId"
         AND grant_row."baseDelegationId" = NEW."baseDelegationId"
         AND grant_row."connectionOwnerId" = NEW."connectionOwnerId"
         AND grant_row."status" = 'active'
         AND grant_row."version" = NEW."grantVersion"
         AND grant_row."grantFingerprint" = NEW."grantFingerprint"
         AND grant_row."baseDelegationVersion" = NEW."baseDelegationVersion"
         AND grant_row."baseDelegationFingerprint" = NEW."baseDelegationFingerprint"
         AND grant_row."repositoryPath" = NEW."repositoryPath"
         AND grant_row."trackedRef" = NEW."trackedRef"
         AND grant_row."includeRoots" = NEW."includeRoots"
         AND grant_row."softExcludePatterns" = NEW."softExcludePatterns"
         AND grant_row."runIntervalMinutes" = NEW."runIntervalMinutes"
         AND grant_row."expiresAt" = NEW."expiresAt"
         AND cursor_row."status" = 'active'
         AND cursor_row."lastScheduledFor" = NEW."scheduledFor"
    ) THEN
      RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_RUN_SNAPSHOT_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  NEW."updatedAt" := clock_timestamp();
  IF OLD."id" IS DISTINCT FROM NEW."id"
     OR OLD."grantId" IS DISTINCT FROM NEW."grantId"
     OR OLD."projectId" IS DISTINCT FROM NEW."projectId"
     OR OLD."workspaceId" IS DISTINCT FROM NEW."workspaceId"
     OR OLD."gitConnectionId" IS DISTINCT FROM NEW."gitConnectionId"
     OR OLD."baseDelegationId" IS DISTINCT FROM NEW."baseDelegationId"
     OR OLD."connectionOwnerId" IS DISTINCT FROM NEW."connectionOwnerId"
     OR OLD."grantVersion" IS DISTINCT FROM NEW."grantVersion"
     OR OLD."grantFingerprint" IS DISTINCT FROM NEW."grantFingerprint"
     OR OLD."baseDelegationVersion" IS DISTINCT FROM NEW."baseDelegationVersion"
     OR OLD."baseDelegationFingerprint" IS DISTINCT FROM NEW."baseDelegationFingerprint"
     OR OLD."repositoryPath" IS DISTINCT FROM NEW."repositoryPath"
     OR OLD."trackedRef" IS DISTINCT FROM NEW."trackedRef"
     OR OLD."includeRoots" IS DISTINCT FROM NEW."includeRoots"
     OR OLD."softExcludePatterns" IS DISTINCT FROM NEW."softExcludePatterns"
     OR OLD."runIntervalMinutes" IS DISTINCT FROM NEW."runIntervalMinutes"
     OR OLD."expiresAt" IS DISTINCT FROM NEW."expiresAt"
     OR OLD."scheduledFor" IS DISTINCT FROM NEW."scheduledFor"
     OR OLD."claimedAt" IS DISTINCT FROM NEW."claimedAt"
     OR OLD."createdAt" IS DISTINCT FROM NEW."createdAt" THEN
    RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_RUN_IMMUTABLE' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_RUN_VERSION_INVALID' USING ERRCODE = 'check_violation';
  END IF;

  IF OLD."status" = 'pending' AND NEW."status" = 'pending' THEN
    IF OLD."leaseWorkerId" IS DISTINCT FROM NEW."leaseWorkerId"
       OR OLD."leaseToken" IS DISTINCT FROM NEW."leaseToken"
       OR OLD."leaseExpiresAt" IS NULL OR NEW."leaseExpiresAt" <= OLD."leaseExpiresAt"
       OR NEW."lastHeartbeatAt" IS NULL OR NEW."lastHeartbeatAt" <= COALESCE(OLD."lastHeartbeatAt", OLD."claimedAt")
       OR NEW."dispatchedAt" IS NOT NULL OR NEW."completedAt" IS NOT NULL OR NEW."safeErrorCode" IS NOT NULL THEN
      RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_RUN_STATE_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF OLD."status" = 'dispatched' AND NEW."status" = 'dispatched' THEN
    IF OLD."leaseWorkerId" IS DISTINCT FROM NEW."leaseWorkerId"
       OR OLD."leaseToken" IS DISTINCT FROM NEW."leaseToken"
       OR OLD."leaseExpiresAt" IS NULL OR NEW."leaseExpiresAt" <= OLD."leaseExpiresAt"
       OR NEW."lastHeartbeatAt" IS NULL OR NEW."lastHeartbeatAt" <= COALESCE(OLD."lastHeartbeatAt", OLD."dispatchedAt")
       OR NEW."dispatchedAt" IS DISTINCT FROM OLD."dispatchedAt"
       OR NEW."completedAt" IS NOT NULL OR NEW."safeErrorCode" IS NOT NULL THEN
      RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_RUN_STATE_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF OLD."status" = 'pending' AND NEW."status" = 'dispatched' THEN
    IF OLD."leaseWorkerId" IS DISTINCT FROM NEW."leaseWorkerId"
       OR OLD."leaseToken" IS DISTINCT FROM NEW."leaseToken"
       OR OLD."leaseExpiresAt" IS DISTINCT FROM NEW."leaseExpiresAt"
       OR OLD."leaseExpiresAt" <= clock_timestamp()
       OR NEW."dispatchedAt" IS NULL OR NEW."dispatchedAt" < OLD."claimedAt"
       OR NEW."lastHeartbeatAt" IS DISTINCT FROM OLD."lastHeartbeatAt"
       OR NEW."completedAt" IS NOT NULL OR NEW."safeErrorCode" IS NOT NULL THEN
      RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_RUN_DISPATCH_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF OLD."status" = 'pending' AND NEW."status" = 'failed' THEN
    IF OLD."leaseWorkerId" IS DISTINCT FROM NEW."leaseWorkerId"
       OR OLD."leaseToken" IS DISTINCT FROM NEW."leaseToken"
       OR NEW."leaseExpiresAt" IS NOT NULL OR NEW."dispatchedAt" IS NOT NULL
       OR NEW."completedAt" IS NULL
       OR NEW."safeErrorCode" NOT IN ('LEASE_EXPIRED_BEFORE_DISPATCH', 'GRANT_INELIGIBLE_BEFORE_DISPATCH') THEN
      RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_RUN_STATE_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF OLD."status" = 'dispatched' AND NEW."status" = 'unknown' THEN
    IF OLD."leaseWorkerId" IS DISTINCT FROM NEW."leaseWorkerId"
       OR OLD."leaseToken" IS DISTINCT FROM NEW."leaseToken"
       OR NEW."leaseExpiresAt" IS NOT NULL OR NEW."dispatchedAt" IS DISTINCT FROM OLD."dispatchedAt"
       OR NEW."completedAt" IS NULL
       OR NEW."safeErrorCode" NOT IN ('LEASE_EXPIRED_AFTER_DISPATCH', 'GRANT_INELIGIBLE_AFTER_DISPATCH') THEN
      RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_RUN_STATE_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_RUN_STATE_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "PGAR_shape_guard"
BEFORE INSERT OR UPDATE ON "ProjectGitRepositoryAutomationRun"
FOR EACH ROW EXECUTE FUNCTION "project_git_automation_run_shape_guard"();

CREATE OR REPLACE FUNCTION "project_git_automation_run_audit_append_only"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_RUN_AUDIT_IMMUTABLE' USING ERRCODE = 'check_violation';
END;
$$;
CREATE TRIGGER "PGARA_no_update_delete"
BEFORE UPDATE OR DELETE ON "ProjectGitRepositoryAutomationRunAudit"
FOR EACH ROW EXECUTE FUNCTION "project_git_automation_run_audit_append_only"();
CREATE TRIGGER "PGARA_no_truncate"
BEFORE TRUNCATE ON "ProjectGitRepositoryAutomationRunAudit"
FOR EACH STATEMENT EXECUTE FUNCTION "project_git_automation_run_audit_append_only"();

CREATE OR REPLACE FUNCTION "project_git_automation_run_audit_insert_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW."createdAt" := clock_timestamp();
  NEW."transactionId" := txid_current();
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_RUN_AUDIT_IMMUTABLE' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "PGARA_insert_guard"
BEFORE INSERT ON "ProjectGitRepositoryAutomationRunAudit"
FOR EACH ROW EXECUTE FUNCTION "project_git_automation_run_audit_insert_guard"();

CREATE OR REPLACE FUNCTION "project_git_automation_cursor_audit_required"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "ProjectGitRepositoryAutomationRunAudit" audit
     WHERE audit."grantId" = NEW."grantId"
       AND audit."cursorVersion" = NEW."version"
       AND audit."cursorStatusAfter" = NEW."status"
       AND audit."nextRunAt" = NEW."nextRunAt"
       AND audit."lastScheduledFor" IS NOT DISTINCT FROM NEW."lastScheduledFor"
  ) THEN
    RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_CURSOR_AUDIT_REQUIRED' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER "PGARSC_audit_required"
AFTER INSERT OR UPDATE ON "ProjectGitRepositoryAutomationScheduleCursor"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "project_git_automation_cursor_audit_required"();

CREATE OR REPLACE FUNCTION "project_git_automation_run_audit_required"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "ProjectGitRepositoryAutomationRunAudit" audit
     WHERE audit."runId" = NEW."id"
       AND audit."runVersion" = NEW."version"
       AND audit."runStatusAfter" = NEW."status"
  ) THEN
    RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_RUN_AUDIT_REQUIRED' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER "PGAR_audit_required"
AFTER INSERT OR UPDATE ON "ProjectGitRepositoryAutomationRun"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "project_git_automation_run_audit_required"();

CREATE OR REPLACE FUNCTION "project_git_automation_pause_cursor_on_grant_terminal"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  cursor_row "ProjectGitRepositoryAutomationScheduleCursor"%ROWTYPE;
  safe_reason VARCHAR(64);
BEGIN
  IF OLD."status" IS NOT DISTINCT FROM NEW."status" OR NEW."status" = 'active' THEN
    RETURN NULL;
  END IF;
  SELECT * INTO cursor_row
    FROM "ProjectGitRepositoryAutomationScheduleCursor"
   WHERE "grantId" = NEW."id"
   FOR UPDATE;
  IF NOT FOUND OR cursor_row."status" = 'paused' THEN
    RETURN NULL;
  END IF;
  safe_reason := CASE
    WHEN NEW."terminalReason" = 'project_archived' THEN 'project_archived'
    WHEN NEW."terminalReason" = 'base_delegation_ended' THEN 'base_delegation_ended'
    WHEN NEW."terminalReason" = 'git_connection_changed' THEN 'connection_changed'
    WHEN NEW."status" = 'revoked' THEN 'grant_revoked'
    WHEN NEW."status" = 'expired' THEN 'grant_expired'
    ELSE 'grant_invalidated'
  END;
  UPDATE "ProjectGitRepositoryAutomationScheduleCursor"
     SET "status" = 'paused',
         "pauseReason" = safe_reason,
         "pausedAt" = clock_timestamp(),
         "version" = cursor_row."version" + 1
   WHERE "grantId" = NEW."id";
  INSERT INTO "ProjectGitRepositoryAutomationRunAudit" (
    "id", "grantId", "projectId", "action", "cursorVersion", "cursorStatusAfter",
    "nextRunAt", "lastScheduledFor", "grantVersion", "grantFingerprint", "reason"
  ) VALUES (
    gen_random_uuid(), NEW."id", NEW."projectId", 'schedule_paused', cursor_row."version" + 1, 'paused',
    cursor_row."nextRunAt", cursor_row."lastScheduledFor", NEW."version", NEW."grantFingerprint", safe_reason
  );
  RETURN NULL;
END;
$$;
CREATE TRIGGER "PGARSC_pause_on_grant_terminal"
AFTER UPDATE OF "status" ON "ProjectGitRepositoryAutomationGrant"
FOR EACH ROW EXECUTE FUNCTION "project_git_automation_pause_cursor_on_grant_terminal"();

-- The three ledger relations are read-only to application principals. All
-- mutation is performed by the narrow SECURITY DEFINER transition API below.
REVOKE ALL ON TABLE public."ProjectGitRepositoryAutomationScheduleCursor",
                    public."ProjectGitRepositoryAutomationRun",
                    public."ProjectGitRepositoryAutomationRunAudit"
  FROM PUBLIC;

CREATE OR REPLACE FUNCTION public."project_git_automation_grant_eligibility"(
  target_grant UUID,
  target_project UUID,
  database_now TIMESTAMP(3)
)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog
AS $$
DECLARE
  grant_row public."ProjectGitRepositoryAutomationGrant"%ROWTYPE;
  base_row public."ProjectGitRepositoryDelegation"%ROWTYPE;
  connection_row public."GitConnection"%ROWTYPE;
  credential_kind TEXT;
  credential_fingerprint CHAR(64);
  connection_owner public."AppUser"%ROWTYPE;
  project_archived_at TIMESTAMP(3);
BEGIN
  SELECT * INTO grant_row
    FROM public."ProjectGitRepositoryAutomationGrant"
   WHERE "id" = target_grant AND "projectId" = target_project;
  IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
  IF grant_row."status" <> 'active' THEN RETURN 'NOT_ACTIVE'; END IF;
  IF grant_row."expiresAt" <= database_now THEN RETURN 'EXPIRED'; END IF;

  SELECT "archivedAt" INTO project_archived_at
    FROM public."Project" WHERE "id" = grant_row."projectId";
  IF NOT FOUND OR project_archived_at IS NOT NULL THEN RETURN 'PROJECT_ARCHIVED'; END IF;

  SELECT * INTO base_row
    FROM public."ProjectGitRepositoryDelegation"
   WHERE "id" = grant_row."baseDelegationId";
  IF NOT FOUND
     OR base_row."status" <> 'active'
     OR base_row."projectId" IS DISTINCT FROM grant_row."projectId"
     OR base_row."gitConnectionId" IS DISTINCT FROM grant_row."gitConnectionId"
     OR base_row."connectionOwnerId" IS DISTINCT FROM grant_row."connectionOwnerId"
     OR base_row."connectionOwnerAccountAccessVersion" IS DISTINCT FROM grant_row."connectionOwnerAccountAccessVersion"
     OR base_row."version" IS DISTINCT FROM grant_row."baseDelegationVersion"
     OR base_row."delegationFingerprint" IS DISTINCT FROM grant_row."baseDelegationFingerprint"
     OR base_row."manualSyncAllowed" IS DISTINCT FROM TRUE
     OR base_row."automationAllowed" IS DISTINCT FROM FALSE
     OR base_row."expiresAt" < grant_row."expiresAt"
     OR base_row."repositoryPath" IS DISTINCT FROM grant_row."repositoryPath"
     OR base_row."trackedRef" IS DISTINCT FROM grant_row."trackedRef"
     OR base_row."includeRoots" IS DISTINCT FROM grant_row."includeRoots"
     OR base_row."softExcludePatterns" IS DISTINCT FROM grant_row."softExcludePatterns" THEN
    RETURN 'BASE_DELEGATION_DRIFT';
  END IF;

  SELECT * INTO connection_row
    FROM public."GitConnection"
   WHERE "id" = grant_row."gitConnectionId";
  IF NOT FOUND
     OR connection_row."ownerUserId" IS DISTINCT FROM grant_row."connectionOwnerId"
     OR connection_row."ownerAccountAccessVersion" IS DISTINCT FROM grant_row."connectionOwnerAccountAccessVersion"
     OR connection_row."ownerAccountAccessVersion" IS DISTINCT FROM base_row."connectionOwnerAccountAccessVersion"
     OR connection_row."ownershipState" <> 'confirmed'
     OR connection_row."status" <> 'verified'
     OR connection_row."configurationVersion" IS DISTINCT FROM base_row."connectionConfigurationVersion"
     OR connection_row."resolvedAddressFingerprint" IS DISTINCT FROM base_row."resolvedAddressFingerprint" THEN
    RETURN 'CONNECTION_DRIFT';
  END IF;

  SELECT "kind", "secretFingerprint"
    INTO credential_kind, credential_fingerprint
    FROM public."ExternalCredential"
   WHERE "id" = connection_row."credentialId";
  IF NOT FOUND OR credential_kind IS DISTINCT FROM 'git'
     OR credential_fingerprint IS DISTINCT FROM base_row."credentialFingerprint" THEN
    RETURN 'CONNECTION_DRIFT';
  END IF;

  SELECT * INTO connection_owner
    FROM public."AppUser"
   WHERE "id" = grant_row."connectionOwnerId";
  IF NOT FOUND OR connection_owner."disabledAt" IS NOT NULL
     OR connection_owner."accountAccessVersion" IS DISTINCT FROM grant_row."connectionOwnerAccountAccessVersion" THEN
    RETURN 'CONNECTION_DRIFT';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public."ProjectMembership" membership
      JOIN public."AppUser" proposer ON proposer."id" = membership."userId"
     WHERE membership."id" = grant_row."proposedProjectMembershipId"
       AND membership."projectId" = grant_row."projectId"
       AND membership."userId" = grant_row."proposedById"
       AND membership."createdAt" = grant_row."proposedMembershipCreatedAt"
       AND membership."role" IN ('owner', 'editor')
       AND membership."accessState" = 'confirmed'
       AND proposer."disabledAt" IS NULL
  ) OR NOT EXISTS (
    SELECT 1
      FROM public."ProjectMembership" membership
      JOIN public."AppUser" confirmer ON confirmer."id" = membership."userId"
     WHERE membership."id" = grant_row."ownerConfirmedProjectMembershipId"
       AND membership."projectId" = grant_row."projectId"
       AND membership."userId" = grant_row."ownerConfirmedById"
       AND membership."userId" = grant_row."connectionOwnerId"
       AND membership."createdAt" = grant_row."ownerConfirmedMembershipCreatedAt"
       AND membership."role" IN ('owner', 'editor')
       AND membership."accessState" = 'confirmed'
       AND confirmer."disabledAt" IS NULL
       AND confirmer."accountAccessVersion" = grant_row."connectionOwnerAccountAccessVersion"
  ) THEN
    RETURN 'OWNER_MEMBERSHIP_DRIFT';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public."ProjectMembership" membership
      JOIN public."AppUser" project_owner ON project_owner."id" = membership."userId"
     WHERE membership."id" = grant_row."projectActivatedMembershipId"
       AND membership."projectId" = grant_row."projectId"
       AND membership."userId" = grant_row."projectActivatedById"
       AND membership."createdAt" = grant_row."projectActivatedMembershipCreatedAt"
       AND membership."role" = 'owner'
       AND membership."accessState" = 'confirmed'
       AND project_owner."disabledAt" IS NULL
  ) THEN
    RETURN 'PROJECT_OWNER_MEMBERSHIP_DRIFT';
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public."project_git_automation_lock_grant"(target_grant UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog
AS $$
DECLARE
  project_id UUID;
  workspace_id UUID;
  actor_id UUID;
BEGIN
  SELECT grant_row."projectId", project."workspaceId"
    INTO project_id, workspace_id
    FROM public."ProjectGitRepositoryAutomationGrant" grant_row
    JOIN public."Project" project ON project."id" = grant_row."projectId"
   WHERE grant_row."id" = target_grant;
  IF NOT FOUND THEN RETURN FALSE; END IF;

  -- Match access-linearization.ts: sorted actors, then workspace, project,
  -- project Git, global Git, followed by cursor/run row locks in the callers.
  FOR actor_id IN
    SELECT distinct_actor.actor_id
      FROM (
        SELECT DISTINCT actor_values.actor_id
          FROM public."ProjectGitRepositoryAutomationGrant" grant_row
          CROSS JOIN LATERAL unnest(ARRAY[
            grant_row."connectionOwnerId", grant_row."proposedById",
            grant_row."ownerConfirmedById", grant_row."projectActivatedById"
          ]) AS actor_values(actor_id)
         WHERE grant_row."id" = target_grant AND actor_values.actor_id IS NOT NULL
      ) distinct_actor
     ORDER BY distinct_actor.actor_id::text
  LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(actor_id::text, 29082027));
  END LOOP;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(workspace_id::text, 29082028));
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(project_id::text, 29082029));
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(project_id::text, 23082915));
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('ai-project-git-repository-delegation-global', 0));
  RETURN TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION public."project_git_automation_run_snapshot_matches"(target_run UUID)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SET search_path = pg_catalog
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public."ProjectGitRepositoryAutomationRun" run_row
      JOIN public."ProjectGitRepositoryAutomationGrant" grant_row ON grant_row."id" = run_row."grantId"
      JOIN public."Project" project ON project."id" = run_row."projectId"
     WHERE run_row."id" = target_run
       AND run_row."projectId" = grant_row."projectId"
       AND run_row."workspaceId" = project."workspaceId"
       AND run_row."gitConnectionId" = grant_row."gitConnectionId"
       AND run_row."baseDelegationId" = grant_row."baseDelegationId"
       AND run_row."connectionOwnerId" = grant_row."connectionOwnerId"
       AND run_row."grantVersion" = grant_row."version"
       AND run_row."grantFingerprint" = grant_row."grantFingerprint"
       AND run_row."baseDelegationVersion" = grant_row."baseDelegationVersion"
       AND run_row."baseDelegationFingerprint" = grant_row."baseDelegationFingerprint"
       AND run_row."repositoryPath" = grant_row."repositoryPath"
       AND run_row."trackedRef" = grant_row."trackedRef"
       AND run_row."includeRoots" = grant_row."includeRoots"
       AND run_row."softExcludePatterns" = grant_row."softExcludePatterns"
       AND run_row."runIntervalMinutes" = grant_row."runIntervalMinutes"
       AND run_row."expiresAt" = grant_row."expiresAt"
  )
$$;

CREATE OR REPLACE FUNCTION public."project_git_automation_cursor_shape_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  grant_row public."ProjectGitRepositoryAutomationGrant"%ROWTYPE;
  workspace_id UUID;
  database_now TIMESTAMP(3);
  transition_action TEXT := pg_catalog.current_setting('ai_project_os.git_automation_transition', TRUE);
  eligible_reason TEXT;
BEGIN
  database_now := COALESCE(NULLIF(pg_catalog.current_setting('ai_project_os.git_automation_now', TRUE), '')::TIMESTAMP(3),
    pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp() AT TIME ZONE 'UTC'));
  IF TG_OP = 'INSERT' THEN
    NEW."createdAt" := database_now;
    NEW."updatedAt" := database_now;
    SELECT automation_grant.* INTO grant_row
      FROM public."ProjectGitRepositoryAutomationGrant" automation_grant
     WHERE automation_grant."id" = NEW."grantId";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_CURSOR_GRANT_MISSING' USING ERRCODE = 'check_violation';
    END IF;
    SELECT project."workspaceId" INTO workspace_id
      FROM public."Project" project WHERE project."id" = grant_row."projectId";
    IF NOT FOUND OR transition_action <> 'claim'
       OR NEW."projectId" IS DISTINCT FROM grant_row."projectId"
       OR NEW."workspaceId" IS DISTINCT FROM workspace_id
       OR NEW."connectionOwnerId" IS DISTINCT FROM grant_row."connectionOwnerId"
       OR grant_row."activatedAt" IS NULL
       OR NEW."nextRunAt" IS DISTINCT FROM grant_row."activatedAt" + grant_row."runIntervalMinutes" * INTERVAL '1 minute'
       OR NEW."version" <> 1 OR NEW."status" <> 'active'
       OR NEW."pauseReason" IS NOT NULL OR NEW."pausedAt" IS NOT NULL
       OR NEW."lastScheduledFor" IS NOT NULL THEN
      RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_CURSOR_INITIAL_SCHEDULE_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    eligible_reason := public."project_git_automation_grant_eligibility"(grant_row."id", grant_row."projectId", database_now);
    IF eligible_reason IS NULL AND NEW."nextRunAt" > database_now THEN
      RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_CURSOR_NOT_DUE' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  NEW."updatedAt" := database_now;
  IF OLD."grantId" IS DISTINCT FROM NEW."grantId"
     OR OLD."projectId" IS DISTINCT FROM NEW."projectId"
     OR OLD."workspaceId" IS DISTINCT FROM NEW."workspaceId"
     OR OLD."connectionOwnerId" IS DISTINCT FROM NEW."connectionOwnerId"
     OR OLD."createdAt" IS DISTINCT FROM NEW."createdAt"
     OR NEW."version" <> OLD."version" + 1
     OR OLD."status" = 'paused' THEN
    RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_CURSOR_TRANSITION_INVALID' USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO grant_row
    FROM public."ProjectGitRepositoryAutomationGrant"
   WHERE "id" = NEW."grantId";
  IF NOT FOUND THEN RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_CURSOR_GRANT_MISSING' USING ERRCODE = 'check_violation'; END IF;
  eligible_reason := public."project_git_automation_grant_eligibility"(grant_row."id", grant_row."projectId", database_now);
  IF NEW."status" = 'paused' THEN
    IF transition_action NOT IN ('claim', 'grant_terminal')
       OR NEW."nextRunAt" IS DISTINCT FROM OLD."nextRunAt"
       OR NEW."lastScheduledFor" IS DISTINCT FROM OLD."lastScheduledFor"
       OR NEW."pauseReason" IS NULL OR NEW."pausedAt" IS NULL
       OR (eligible_reason IS NULL AND NEW."pauseReason" <> 'schedule_snapshot_drift')
       OR (transition_action = 'grant_terminal' AND grant_row."status" = 'active') THEN
      RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_CURSOR_PAUSE_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."status" = 'active' THEN
    IF transition_action <> 'claim' OR eligible_reason IS NOT NULL
       OR NEW."lastScheduledFor" IS DISTINCT FROM OLD."nextRunAt"
       OR NEW."nextRunAt" IS DISTINCT FROM database_now + grant_row."runIntervalMinutes" * INTERVAL '1 minute'
       OR NEW."pauseReason" IS NOT NULL OR NEW."pausedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_CURSOR_ADVANCE_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_CURSOR_STATE_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public."project_git_automation_run_shape_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  grant_row public."ProjectGitRepositoryAutomationGrant"%ROWTYPE;
  cursor_row public."ProjectGitRepositoryAutomationScheduleCursor"%ROWTYPE;
  database_now TIMESTAMP(3);
  transition_action TEXT := pg_catalog.current_setting('ai_project_os.git_automation_transition', TRUE);
  eligible_reason TEXT;
  expected_status public."ProjectGitRepositoryAutomationRunStatus";
BEGIN
  database_now := COALESCE(NULLIF(pg_catalog.current_setting('ai_project_os.git_automation_now', TRUE), '')::TIMESTAMP(3),
    pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp() AT TIME ZONE 'UTC'));
  IF TG_OP = 'INSERT' THEN
    IF transition_action <> 'claim' OR NEW."status" <> 'pending' OR NEW."version" <> 1
       OR NEW."leaseWorkerId" IS NULL OR NEW."leaseWorkerId" !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
       OR NEW."leaseToken" IS NULL OR NEW."lastHeartbeatAt" IS NOT NULL
       OR NEW."dispatchedAt" IS NOT NULL OR NEW."completedAt" IS NOT NULL OR NEW."safeErrorCode" IS NOT NULL
       OR NEW."claimedAt" > database_now + INTERVAL '1 second'
       OR NEW."leaseExpiresAt" IS DISTINCT FROM NEW."claimedAt" + INTERVAL '90 seconds'
       OR NEW."scheduledFor" > NEW."claimedAt" THEN
      RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_RUN_CLAIM_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    SELECT * INTO grant_row FROM public."ProjectGitRepositoryAutomationGrant" WHERE "id" = NEW."grantId";
    eligible_reason := public."project_git_automation_grant_eligibility"(NEW."grantId", NEW."projectId", database_now);
    SELECT * INTO cursor_row FROM public."ProjectGitRepositoryAutomationScheduleCursor" WHERE "grantId" = NEW."grantId";
    IF NOT FOUND OR eligible_reason IS NOT NULL
       OR NEW."projectId" IS DISTINCT FROM grant_row."projectId"
       OR NEW."gitConnectionId" IS DISTINCT FROM grant_row."gitConnectionId"
       OR NEW."baseDelegationId" IS DISTINCT FROM grant_row."baseDelegationId"
       OR NEW."connectionOwnerId" IS DISTINCT FROM grant_row."connectionOwnerId"
       OR NEW."grantVersion" IS DISTINCT FROM grant_row."version"
       OR NEW."grantFingerprint" IS DISTINCT FROM grant_row."grantFingerprint"
       OR NEW."baseDelegationVersion" IS DISTINCT FROM grant_row."baseDelegationVersion"
       OR NEW."baseDelegationFingerprint" IS DISTINCT FROM grant_row."baseDelegationFingerprint"
       OR NEW."repositoryPath" IS DISTINCT FROM grant_row."repositoryPath"
       OR NEW."trackedRef" IS DISTINCT FROM grant_row."trackedRef"
       OR NEW."includeRoots" IS DISTINCT FROM grant_row."includeRoots"
       OR NEW."softExcludePatterns" IS DISTINCT FROM grant_row."softExcludePatterns"
       OR NEW."runIntervalMinutes" IS DISTINCT FROM grant_row."runIntervalMinutes"
       OR NEW."expiresAt" IS DISTINCT FROM grant_row."expiresAt"
       OR cursor_row."status" <> 'active'
       OR cursor_row."lastScheduledFor" IS DISTINCT FROM NEW."scheduledFor"
       OR cursor_row."nextRunAt" IS DISTINCT FROM NEW."claimedAt" + grant_row."runIntervalMinutes" * INTERVAL '1 minute'
       OR EXISTS (SELECT 1 FROM public."ProjectGitRepositoryAutomationRun" live_run
                   WHERE live_run."grantId" = NEW."grantId" AND live_run."status" IN ('pending', 'dispatched')) THEN
      RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_RUN_SNAPSHOT_OR_DUE_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    NEW."createdAt" := NEW."claimedAt";
    NEW."updatedAt" := NEW."claimedAt";
    RETURN NEW;
  END IF;

  NEW."updatedAt" := database_now;
  IF OLD."id" IS DISTINCT FROM NEW."id"
     OR OLD."grantId" IS DISTINCT FROM NEW."grantId"
     OR OLD."projectId" IS DISTINCT FROM NEW."projectId"
     OR OLD."workspaceId" IS DISTINCT FROM NEW."workspaceId"
     OR OLD."gitConnectionId" IS DISTINCT FROM NEW."gitConnectionId"
     OR OLD."baseDelegationId" IS DISTINCT FROM NEW."baseDelegationId"
     OR OLD."connectionOwnerId" IS DISTINCT FROM NEW."connectionOwnerId"
     OR OLD."grantVersion" IS DISTINCT FROM NEW."grantVersion"
     OR OLD."grantFingerprint" IS DISTINCT FROM NEW."grantFingerprint"
     OR OLD."baseDelegationVersion" IS DISTINCT FROM NEW."baseDelegationVersion"
     OR OLD."baseDelegationFingerprint" IS DISTINCT FROM NEW."baseDelegationFingerprint"
     OR OLD."repositoryPath" IS DISTINCT FROM NEW."repositoryPath"
     OR OLD."trackedRef" IS DISTINCT FROM NEW."trackedRef"
     OR OLD."includeRoots" IS DISTINCT FROM NEW."includeRoots"
     OR OLD."softExcludePatterns" IS DISTINCT FROM NEW."softExcludePatterns"
     OR OLD."runIntervalMinutes" IS DISTINCT FROM NEW."runIntervalMinutes"
     OR OLD."expiresAt" IS DISTINCT FROM NEW."expiresAt"
     OR OLD."scheduledFor" IS DISTINCT FROM NEW."scheduledFor"
     OR OLD."claimedAt" IS DISTINCT FROM NEW."claimedAt"
     OR OLD."createdAt" IS DISTINCT FROM NEW."createdAt"
     OR NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_RUN_IMMUTABLE_OR_VERSION_INVALID' USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO grant_row FROM public."ProjectGitRepositoryAutomationGrant" WHERE "id" = NEW."grantId";
  eligible_reason := public."project_git_automation_grant_eligibility"(NEW."grantId", NEW."projectId", database_now);
  IF OLD."status" = NEW."status" AND OLD."status" IN ('pending', 'dispatched') THEN
    IF transition_action <> 'heartbeat' OR OLD."leaseExpiresAt" IS NULL OR OLD."leaseExpiresAt" <= database_now
       OR eligible_reason IS NOT NULL OR NOT public."project_git_automation_run_snapshot_matches"(OLD."id")
       OR OLD."leaseWorkerId" IS DISTINCT FROM NEW."leaseWorkerId"
       OR OLD."leaseToken" IS DISTINCT FROM NEW."leaseToken"
       OR NEW."lastHeartbeatAt" IS NULL
       OR NEW."lastHeartbeatAt" < COALESCE(OLD."lastHeartbeatAt", OLD."claimedAt")
       OR NEW."leaseExpiresAt" IS DISTINCT FROM NEW."lastHeartbeatAt" + INTERVAL '90 seconds'
       OR NEW."dispatchedAt" IS DISTINCT FROM OLD."dispatchedAt"
       OR NEW."completedAt" IS NOT NULL OR NEW."safeErrorCode" IS NOT NULL THEN
      RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_RUN_HEARTBEAT_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF OLD."status" = 'pending' AND NEW."status" = 'dispatched' THEN
    IF transition_action <> 'dispatch' OR OLD."leaseExpiresAt" IS NULL OR OLD."leaseExpiresAt" <= database_now
       OR eligible_reason IS NOT NULL OR NOT public."project_git_automation_run_snapshot_matches"(OLD."id")
       OR OLD."leaseWorkerId" IS DISTINCT FROM NEW."leaseWorkerId"
       OR OLD."leaseToken" IS DISTINCT FROM NEW."leaseToken"
       OR OLD."leaseExpiresAt" IS DISTINCT FROM NEW."leaseExpiresAt"
       OR NEW."dispatchedAt" IS NULL OR NEW."dispatchedAt" < OLD."claimedAt"
       OR NEW."dispatchedAt" > database_now + INTERVAL '1 second'
       OR NEW."lastHeartbeatAt" IS DISTINCT FROM OLD."lastHeartbeatAt"
       OR NEW."completedAt" IS NOT NULL OR NEW."safeErrorCode" IS NOT NULL THEN
      RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_RUN_DISPATCH_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF OLD."status" IN ('pending', 'dispatched') AND NEW."status" IN ('failed', 'unknown') THEN
    expected_status := CASE WHEN OLD."status" = 'pending' THEN 'failed'::public."ProjectGitRepositoryAutomationRunStatus"
                            ELSE 'unknown'::public."ProjectGitRepositoryAutomationRunStatus" END;
    IF NEW."status" <> expected_status OR NEW."leaseWorkerId" IS DISTINCT FROM OLD."leaseWorkerId"
       OR NEW."leaseToken" IS DISTINCT FROM OLD."leaseToken" OR NEW."leaseExpiresAt" IS NOT NULL
       OR NEW."dispatchedAt" IS DISTINCT FROM OLD."dispatchedAt"
       OR NEW."completedAt" IS NULL OR NEW."completedAt" < OLD."claimedAt"
       OR NEW."completedAt" > database_now + INTERVAL '1 second'
       OR NOT (
         (transition_action IN ('reconcile', 'claim')
           AND ((NEW."safeErrorCode" = CASE WHEN OLD."status" = 'pending' THEN 'LEASE_EXPIRED_BEFORE_DISPATCH' ELSE 'LEASE_EXPIRED_AFTER_DISPATCH' END
                 AND OLD."leaseExpiresAt" <= database_now)
             OR (NEW."safeErrorCode" = CASE WHEN OLD."status" = 'pending' THEN 'GRANT_INELIGIBLE_BEFORE_DISPATCH' ELSE 'GRANT_INELIGIBLE_AFTER_DISPATCH' END
                 AND eligible_reason IS NOT NULL)))
         OR (transition_action = 'grant_terminal' AND eligible_reason IS NOT NULL
             AND NEW."safeErrorCode" = CASE WHEN OLD."status" = 'pending' THEN 'GRANT_INELIGIBLE_BEFORE_DISPATCH' ELSE 'GRANT_INELIGIBLE_AFTER_DISPATCH' END)
       ) THEN
      RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_RUN_TERMINAL_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_RUN_STATE_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public."project_git_automation_run_audit_insert_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP <> 'INSERT' OR pg_catalog.pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_RUN_AUDIT_INSERT_REQUIRES_ENTITY_TRIGGER' USING ERRCODE = 'check_violation';
  END IF;
  NEW."createdAt" := pg_catalog.clock_timestamp() AT TIME ZONE 'UTC';
  NEW."transactionId" := pg_catalog.txid_current();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public."project_git_automation_cursor_audit_capture"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  grant_row public."ProjectGitRepositoryAutomationGrant"%ROWTYPE;
  event_action public."ProjectGitRepositoryAutomationRunAuditAction";
BEGIN
  SELECT * INTO grant_row FROM public."ProjectGitRepositoryAutomationGrant" WHERE "id" = NEW."grantId";
  IF NOT FOUND THEN RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_AUDIT_GRANT_MISSING' USING ERRCODE = 'check_violation'; END IF;
  event_action := CASE
    WHEN TG_OP = 'INSERT' THEN 'schedule_initialized'::public."ProjectGitRepositoryAutomationRunAuditAction"
    WHEN NEW."status" = 'paused' THEN 'schedule_paused'::public."ProjectGitRepositoryAutomationRunAuditAction"
    ELSE 'schedule_advanced'::public."ProjectGitRepositoryAutomationRunAuditAction"
  END;
  INSERT INTO public."ProjectGitRepositoryAutomationRunAudit" (
    "id", "grantId", "projectId", "action", "cursorVersion", "cursorStatusAfter",
    "nextRunAt", "lastScheduledFor", "grantVersion", "grantFingerprint", "reason"
  ) VALUES (
    pg_catalog.gen_random_uuid(), NEW."grantId", NEW."projectId", event_action, NEW."version", NEW."status",
    NEW."nextRunAt", NEW."lastScheduledFor", grant_row."version", grant_row."grantFingerprint", NEW."pauseReason"
  );
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public."project_git_automation_run_audit_capture"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  event_action public."ProjectGitRepositoryAutomationRunAuditAction";
BEGIN
  event_action := CASE
    WHEN TG_OP = 'INSERT' THEN 'run_claimed'::public."ProjectGitRepositoryAutomationRunAuditAction"
    WHEN OLD."status" = NEW."status" THEN 'run_heartbeat'::public."ProjectGitRepositoryAutomationRunAuditAction"
    WHEN NEW."status" = 'dispatched' THEN 'run_dispatched'::public."ProjectGitRepositoryAutomationRunAuditAction"
    WHEN NEW."safeErrorCode" = 'LEASE_EXPIRED_BEFORE_DISPATCH' THEN 'run_lease_expired_before_dispatch'::public."ProjectGitRepositoryAutomationRunAuditAction"
    WHEN NEW."safeErrorCode" = 'LEASE_EXPIRED_AFTER_DISPATCH' THEN 'run_lease_expired_after_dispatch'::public."ProjectGitRepositoryAutomationRunAuditAction"
    WHEN NEW."status" = 'failed' THEN 'run_fence_rejected_before_dispatch'::public."ProjectGitRepositoryAutomationRunAuditAction"
    ELSE 'run_fence_rejected_after_dispatch'::public."ProjectGitRepositoryAutomationRunAuditAction"
  END;
  INSERT INTO public."ProjectGitRepositoryAutomationRunAudit" (
    "id", "grantId", "projectId", "runId", "action", "runVersion", "runStatusBefore", "runStatusAfter",
    "scheduledFor", "workerId", "leaseExpiresAt", "grantVersion", "grantFingerprint", "reason"
  ) VALUES (
    pg_catalog.gen_random_uuid(), NEW."grantId", NEW."projectId", NEW."id", event_action, NEW."version",
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD."status" END, NEW."status", NEW."scheduledFor",
    NEW."leaseWorkerId", NEW."leaseExpiresAt", NEW."grantVersion", NEW."grantFingerprint", NEW."safeErrorCode"
  );
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public."project_git_automation_ledger_delete_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_LEDGER_IMMUTABLE' USING ERRCODE = 'check_violation';
END;
$$;

CREATE OR REPLACE FUNCTION public."project_git_automation_guard_project_delete"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF OLD."archivedAt" IS NULL
     OR EXISTS (SELECT 1 FROM public."ProjectGitRepositoryAutomationGrant" grant_row
                 WHERE grant_row."projectId" = OLD."id" AND grant_row."status" = 'active')
     OR EXISTS (SELECT 1 FROM public."ProjectGitRepositoryAutomationScheduleCursor" cursor_row
                 WHERE cursor_row."projectId" = OLD."id" AND cursor_row."status" = 'active')
     OR EXISTS (SELECT 1 FROM public."ProjectGitRepositoryAutomationRun" run_row
                 WHERE run_row."projectId" = OLD."id" AND run_row."status" IN ('pending', 'dispatched')) THEN
    RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_PROJECT_DELETE_BLOCKED' USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END;
$$;

-- Automatic state-derived audit replaces caller-supplied audit rows. The
-- deferred completeness triggers remain in force and now observe these rows.
DROP TRIGGER IF EXISTS "PGARSC_audit_required" ON public."ProjectGitRepositoryAutomationScheduleCursor";
DROP TRIGGER IF EXISTS "PGAR_audit_required" ON public."ProjectGitRepositoryAutomationRun";
CREATE TRIGGER "PGARSC_audit_capture"
AFTER INSERT OR UPDATE ON public."ProjectGitRepositoryAutomationScheduleCursor"
FOR EACH ROW EXECUTE FUNCTION public."project_git_automation_cursor_audit_capture"();
CREATE TRIGGER "PGAR_audit_capture"
AFTER INSERT OR UPDATE ON public."ProjectGitRepositoryAutomationRun"
FOR EACH ROW EXECUTE FUNCTION public."project_git_automation_run_audit_capture"();

CREATE TRIGGER "PGARSC_no_delete"
BEFORE DELETE ON public."ProjectGitRepositoryAutomationScheduleCursor"
FOR EACH ROW EXECUTE FUNCTION public."project_git_automation_ledger_delete_guard"();
CREATE TRIGGER "PGARSC_no_truncate"
BEFORE TRUNCATE ON public."ProjectGitRepositoryAutomationScheduleCursor"
FOR EACH STATEMENT EXECUTE FUNCTION public."project_git_automation_ledger_delete_guard"();
CREATE TRIGGER "PGAR_no_delete"
BEFORE DELETE ON public."ProjectGitRepositoryAutomationRun"
FOR EACH ROW EXECUTE FUNCTION public."project_git_automation_ledger_delete_guard"();
CREATE TRIGGER "PGAR_no_truncate"
BEFORE TRUNCATE ON public."ProjectGitRepositoryAutomationRun"
FOR EACH STATEMENT EXECUTE FUNCTION public."project_git_automation_ledger_delete_guard"();

CREATE OR REPLACE FUNCTION public."project_git_automation_pause_cursor_on_grant_terminal"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  database_now TIMESTAMP(3);
  safe_reason VARCHAR(64);
BEGIN
  IF OLD."status" IS NOT DISTINCT FROM NEW."status" OR NEW."status" = 'active' THEN RETURN NULL; END IF;
  database_now := pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp() AT TIME ZONE 'UTC');
  PERFORM pg_catalog.set_config('ai_project_os.git_automation_now', database_now::text, TRUE);
  PERFORM pg_catalog.set_config('ai_project_os.git_automation_transition', 'grant_terminal', TRUE);
  safe_reason := CASE
    WHEN NEW."terminalReason" = 'project_archived' THEN 'project_archived'
    WHEN NEW."terminalReason" = 'base_delegation_ended' THEN 'base_delegation_ended'
    WHEN NEW."terminalReason" = 'git_connection_changed' THEN 'connection_changed'
    WHEN NEW."status" = 'revoked' THEN 'grant_revoked'
    WHEN NEW."status" = 'expired' THEN 'grant_expired'
    ELSE 'grant_invalidated'
  END;
  UPDATE public."ProjectGitRepositoryAutomationScheduleCursor"
     SET "status" = 'paused', "pauseReason" = safe_reason,
         "pausedAt" = database_now, "version" = "version" + 1
   WHERE "grantId" = NEW."id" AND "status" = 'active';
  UPDATE public."ProjectGitRepositoryAutomationRun"
     SET "status" = CASE WHEN "status" = 'pending' THEN 'failed'::public."ProjectGitRepositoryAutomationRunStatus"
                         ELSE 'unknown'::public."ProjectGitRepositoryAutomationRunStatus" END,
         "leaseExpiresAt" = NULL, "completedAt" = database_now,
         "safeErrorCode" = CASE WHEN "status" = 'pending' THEN 'GRANT_INELIGIBLE_BEFORE_DISPATCH' ELSE 'GRANT_INELIGIBLE_AFTER_DISPATCH' END,
         "version" = "version" + 1
   WHERE "grantId" = NEW."id" AND "status" IN ('pending', 'dispatched');
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public."project_git_automation_claim_due"(target_grant UUID, target_worker VARCHAR(128))
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  grant_row public."ProjectGitRepositoryAutomationGrant"%ROWTYPE;
  cursor_row public."ProjectGitRepositoryAutomationScheduleCursor"%ROWTYPE;
  project_workspace UUID;
  database_now TIMESTAMP(3);
  due_at TIMESTAMP(3);
  next_at TIMESTAMP(3);
  eligibility_reason TEXT;
  pause_reason VARCHAR(64);
  new_run_id UUID := pg_catalog.gen_random_uuid();
  lease_token UUID := pg_catalog.gen_random_uuid();
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') <> 'serializable' THEN
    RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_SERIALIZABLE_REQUIRED' USING ERRCODE = '25001';
  END IF;
  IF target_worker IS NULL OR target_worker !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' THEN
    RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_WORKER_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT public."project_git_automation_lock_grant"(target_grant) THEN RETURN NULL; END IF;
  database_now := pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp() AT TIME ZONE 'UTC');
  PERFORM pg_catalog.set_config('ai_project_os.git_automation_now', database_now::text, TRUE);
  SELECT * INTO grant_row FROM public."ProjectGitRepositoryAutomationGrant" WHERE "id" = target_grant;
  IF NOT FOUND OR grant_row."activatedAt" IS NULL THEN RETURN NULL; END IF;
  SELECT "workspaceId" INTO project_workspace FROM public."Project" WHERE "id" = grant_row."projectId";
  IF NOT FOUND THEN RETURN NULL; END IF;
  due_at := grant_row."activatedAt" + grant_row."runIntervalMinutes" * INTERVAL '1 minute';
  eligibility_reason := public."project_git_automation_grant_eligibility"(grant_row."id", grant_row."projectId", database_now);
  SELECT * INTO cursor_row FROM public."ProjectGitRepositoryAutomationScheduleCursor" WHERE "grantId" = target_grant FOR UPDATE;
  IF NOT FOUND THEN
    IF eligibility_reason IS NULL AND due_at > database_now THEN RETURN NULL; END IF;
    BEGIN
      PERFORM pg_catalog.set_config('ai_project_os.git_automation_transition', 'claim', TRUE);
      INSERT INTO public."ProjectGitRepositoryAutomationScheduleCursor" (
        "grantId", "projectId", "workspaceId", "connectionOwnerId", "nextRunAt", "status", "version", "createdAt", "updatedAt"
      ) VALUES (
        grant_row."id", grant_row."projectId", project_workspace, grant_row."connectionOwnerId", due_at,
        'active', 1, database_now, database_now
      );
    EXCEPTION WHEN unique_violation THEN
      RETURN NULL;
    END;
    SELECT * INTO cursor_row FROM public."ProjectGitRepositoryAutomationScheduleCursor" WHERE "grantId" = target_grant FOR UPDATE;
  END IF;
  IF cursor_row."status" = 'paused' THEN RETURN NULL; END IF;
  IF cursor_row."projectId" IS DISTINCT FROM grant_row."projectId"
     OR cursor_row."workspaceId" IS DISTINCT FROM project_workspace
     OR cursor_row."connectionOwnerId" IS DISTINCT FROM grant_row."connectionOwnerId" THEN
    PERFORM pg_catalog.set_config('ai_project_os.git_automation_transition', 'claim', TRUE);
    UPDATE public."ProjectGitRepositoryAutomationScheduleCursor"
       SET "status" = 'paused', "pauseReason" = 'schedule_snapshot_drift',
           "pausedAt" = database_now, "version" = "version" + 1
     WHERE "grantId" = target_grant;
    RETURN NULL;
  END IF;
  IF eligibility_reason IS NOT NULL THEN
    pause_reason := CASE eligibility_reason
      WHEN 'NOT_FOUND' THEN 'grant_missing'
      WHEN 'NOT_ACTIVE' THEN 'grant_not_active'
      WHEN 'EXPIRED' THEN 'grant_expired'
      WHEN 'PROJECT_ARCHIVED' THEN 'project_archived'
      WHEN 'BASE_DELEGATION_DRIFT' THEN 'base_delegation_drift'
      WHEN 'CONNECTION_DRIFT' THEN 'connection_drift'
      WHEN 'OWNER_MEMBERSHIP_DRIFT' THEN 'owner_membership_drift'
      WHEN 'PROJECT_OWNER_MEMBERSHIP_DRIFT' THEN 'project_owner_membership_drift'
      ELSE 'grant_ineligible'
    END;
    PERFORM pg_catalog.set_config('ai_project_os.git_automation_transition', 'claim', TRUE);
    UPDATE public."ProjectGitRepositoryAutomationScheduleCursor"
       SET "status" = 'paused', "pauseReason" = pause_reason,
           "pausedAt" = database_now, "version" = "version" + 1
     WHERE "grantId" = target_grant AND "status" = 'active';
    UPDATE public."ProjectGitRepositoryAutomationRun"
       SET "status" = CASE WHEN "status" = 'pending' THEN 'failed'::public."ProjectGitRepositoryAutomationRunStatus"
                           ELSE 'unknown'::public."ProjectGitRepositoryAutomationRunStatus" END,
           "leaseExpiresAt" = NULL, "completedAt" = database_now,
           "safeErrorCode" = CASE WHEN "status" = 'pending' THEN 'GRANT_INELIGIBLE_BEFORE_DISPATCH' ELSE 'GRANT_INELIGIBLE_AFTER_DISPATCH' END,
           "version" = "version" + 1
     WHERE "grantId" = target_grant AND "status" IN ('pending', 'dispatched');
    RETURN NULL;
  END IF;
  IF cursor_row."nextRunAt" > database_now THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM public."ProjectGitRepositoryAutomationRun"
              WHERE "grantId" = target_grant AND "status" IN ('pending', 'dispatched')) THEN RETURN NULL; END IF;

  due_at := cursor_row."nextRunAt";
  next_at := database_now + grant_row."runIntervalMinutes" * INTERVAL '1 minute';
  PERFORM pg_catalog.set_config('ai_project_os.git_automation_transition', 'claim', TRUE);
  UPDATE public."ProjectGitRepositoryAutomationScheduleCursor"
     SET "lastScheduledFor" = due_at, "nextRunAt" = next_at,
         "version" = "version" + 1
   WHERE "grantId" = target_grant;
  INSERT INTO public."ProjectGitRepositoryAutomationRun" (
    "id", "grantId", "projectId", "workspaceId", "gitConnectionId", "baseDelegationId", "connectionOwnerId",
    "grantVersion", "grantFingerprint", "baseDelegationVersion", "baseDelegationFingerprint", "repositoryPath",
    "trackedRef", "includeRoots", "softExcludePatterns", "runIntervalMinutes", "expiresAt", "scheduledFor",
    "status", "version", "leaseWorkerId", "leaseToken", "leaseExpiresAt", "claimedAt", "createdAt", "updatedAt"
  ) VALUES (
    new_run_id, grant_row."id", grant_row."projectId", project_workspace, grant_row."gitConnectionId",
    grant_row."baseDelegationId", grant_row."connectionOwnerId", grant_row."version", grant_row."grantFingerprint",
    grant_row."baseDelegationVersion", grant_row."baseDelegationFingerprint", grant_row."repositoryPath",
    grant_row."trackedRef", grant_row."includeRoots", grant_row."softExcludePatterns",
    grant_row."runIntervalMinutes", grant_row."expiresAt", due_at, 'pending', 1, target_worker, lease_token,
    database_now + INTERVAL '90 seconds', database_now, database_now, database_now
  );
  RETURN (
    SELECT pg_catalog.jsonb_build_object(
      'id', run_row."id"::text, 'grantId', run_row."grantId"::text, 'workerId', run_row."leaseWorkerId",
      'leaseToken', run_row."leaseToken"::text,
      'scheduledFor', pg_catalog.to_char(run_row."scheduledFor", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'leaseExpiresAt', pg_catalog.to_char(run_row."leaseExpiresAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'grantVersion', run_row."grantVersion", 'grantFingerprint', run_row."grantFingerprint",
      'baseDelegationId', run_row."baseDelegationId"::text, 'baseDelegationVersion', run_row."baseDelegationVersion",
      'baseDelegationFingerprint', run_row."baseDelegationFingerprint",
      'scope', pg_catalog.jsonb_build_object('repositoryPath', run_row."repositoryPath", 'trackedRef', run_row."trackedRef",
        'includeRoots', run_row."includeRoots", 'softExcludePatterns', run_row."softExcludePatterns")
    ) FROM public."ProjectGitRepositoryAutomationRun" run_row WHERE run_row."id" = new_run_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public."project_git_automation_mutate_lease"(
  target_run UUID, target_worker VARCHAR(128), target_lease_token UUID, requested_action VARCHAR(16)
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  grant_id UUID;
  run_row public."ProjectGitRepositoryAutomationRun"%ROWTYPE;
  cursor_row public."ProjectGitRepositoryAutomationScheduleCursor"%ROWTYPE;
  database_now TIMESTAMP(3);
  eligibility_reason TEXT;
  terminal_code VARCHAR(64);
  terminal_status public."ProjectGitRepositoryAutomationRunStatus";
  is_dispatched BOOLEAN;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') <> 'serializable' THEN
    RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_SERIALIZABLE_REQUIRED' USING ERRCODE = '25001';
  END IF;
  IF requested_action NOT IN ('heartbeat', 'dispatch') OR target_worker IS NULL
     OR target_worker !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' THEN
    RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_LEASE_ACTION_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  SELECT "grantId" INTO grant_id FROM public."ProjectGitRepositoryAutomationRun" WHERE "id" = target_run;
  IF NOT FOUND OR NOT public."project_git_automation_lock_grant"(grant_id) THEN RETURN NULL; END IF;
  database_now := pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp() AT TIME ZONE 'UTC');
  PERFORM pg_catalog.set_config('ai_project_os.git_automation_now', database_now::text, TRUE);
  SELECT * INTO cursor_row FROM public."ProjectGitRepositoryAutomationScheduleCursor" WHERE "grantId" = grant_id FOR UPDATE;
  SELECT * INTO run_row FROM public."ProjectGitRepositoryAutomationRun" WHERE "id" = target_run FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF run_row."status" NOT IN ('pending', 'dispatched')
     OR run_row."leaseWorkerId" IS DISTINCT FROM target_worker
     OR run_row."leaseToken" IS DISTINCT FROM target_lease_token THEN
    RETURN pg_catalog.jsonb_build_object('accepted', FALSE, 'status', run_row."status"::text);
  END IF;
  eligibility_reason := public."project_git_automation_grant_eligibility"(run_row."grantId", run_row."projectId", database_now);
  IF eligibility_reason IS NULL AND NOT public."project_git_automation_run_snapshot_matches"(run_row."id") THEN
    eligibility_reason := 'BASE_DELEGATION_DRIFT';
  END IF;
  is_dispatched := run_row."status" = 'dispatched';
  IF eligibility_reason IS NOT NULL OR run_row."leaseExpiresAt" IS NULL OR run_row."leaseExpiresAt" <= database_now THEN
    IF eligibility_reason IS NOT NULL AND cursor_row."status" = 'active' THEN
      PERFORM pg_catalog.set_config('ai_project_os.git_automation_transition', 'claim', TRUE);
      UPDATE public."ProjectGitRepositoryAutomationScheduleCursor"
         SET "status" = 'paused', "pauseReason" = CASE eligibility_reason
           WHEN 'NOT_FOUND' THEN 'grant_missing' WHEN 'NOT_ACTIVE' THEN 'grant_not_active'
           WHEN 'EXPIRED' THEN 'grant_expired' WHEN 'PROJECT_ARCHIVED' THEN 'project_archived'
           WHEN 'BASE_DELEGATION_DRIFT' THEN 'base_delegation_drift' WHEN 'CONNECTION_DRIFT' THEN 'connection_drift'
           WHEN 'OWNER_MEMBERSHIP_DRIFT' THEN 'owner_membership_drift' WHEN 'PROJECT_OWNER_MEMBERSHIP_DRIFT' THEN 'project_owner_membership_drift'
           ELSE 'grant_ineligible' END,
           "pausedAt" = database_now, "version" = "version" + 1
       WHERE "grantId" = grant_id AND "status" = 'active';
    END IF;
    terminal_code := CASE
      WHEN eligibility_reason IS NOT NULL THEN CASE WHEN is_dispatched THEN 'GRANT_INELIGIBLE_AFTER_DISPATCH' ELSE 'GRANT_INELIGIBLE_BEFORE_DISPATCH' END
      WHEN is_dispatched THEN 'LEASE_EXPIRED_AFTER_DISPATCH' ELSE 'LEASE_EXPIRED_BEFORE_DISPATCH'
    END;
    terminal_status := CASE WHEN is_dispatched THEN 'unknown'::public."ProjectGitRepositoryAutomationRunStatus"
                            ELSE 'failed'::public."ProjectGitRepositoryAutomationRunStatus" END;
    PERFORM pg_catalog.set_config('ai_project_os.git_automation_transition', 'reconcile', TRUE);
    UPDATE public."ProjectGitRepositoryAutomationRun"
       SET "status" = terminal_status, "leaseExpiresAt" = NULL, "completedAt" = database_now,
           "safeErrorCode" = terminal_code, "version" = "version" + 1
     WHERE "id" = target_run;
    RETURN pg_catalog.jsonb_build_object('accepted', FALSE, 'status', terminal_status::text);
  END IF;
  IF requested_action = 'dispatch' THEN
    IF run_row."status" <> 'pending' THEN
      RETURN pg_catalog.jsonb_build_object('accepted', FALSE, 'status', run_row."status"::text);
    END IF;
    PERFORM pg_catalog.set_config('ai_project_os.git_automation_transition', 'dispatch', TRUE);
    UPDATE public."ProjectGitRepositoryAutomationRun"
       SET "status" = 'dispatched', "dispatchedAt" = database_now, "version" = "version" + 1
     WHERE "id" = target_run;
  ELSE
    PERFORM pg_catalog.set_config('ai_project_os.git_automation_transition', 'heartbeat', TRUE);
    UPDATE public."ProjectGitRepositoryAutomationRun"
       SET "lastHeartbeatAt" = database_now,
           "leaseExpiresAt" = database_now + INTERVAL '90 seconds',
           "version" = "version" + 1
     WHERE "id" = target_run;
  END IF;
  SELECT * INTO run_row FROM public."ProjectGitRepositoryAutomationRun" WHERE "id" = target_run;
  IF requested_action = 'heartbeat' THEN
    RETURN pg_catalog.jsonb_build_object('accepted', TRUE, 'status', run_row."status"::text,
      'leaseExpiresAt', pg_catalog.to_char(run_row."leaseExpiresAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  END IF;
  RETURN pg_catalog.jsonb_build_object('accepted', TRUE, 'status', run_row."status"::text,
    'claim', pg_catalog.jsonb_build_object(
      'id', run_row."id"::text, 'grantId', run_row."grantId"::text, 'workerId', run_row."leaseWorkerId",
      'leaseToken', run_row."leaseToken"::text,
      'scheduledFor', pg_catalog.to_char(run_row."scheduledFor", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'leaseExpiresAt', pg_catalog.to_char(run_row."leaseExpiresAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'grantVersion', run_row."grantVersion", 'grantFingerprint', run_row."grantFingerprint",
      'baseDelegationId', run_row."baseDelegationId"::text, 'baseDelegationVersion', run_row."baseDelegationVersion",
      'baseDelegationFingerprint', run_row."baseDelegationFingerprint",
      'scope', pg_catalog.jsonb_build_object('repositoryPath', run_row."repositoryPath", 'trackedRef', run_row."trackedRef",
        'includeRoots', run_row."includeRoots", 'softExcludePatterns', run_row."softExcludePatterns")
    ));
END;
$$;

CREATE OR REPLACE FUNCTION public."project_git_automation_reconcile_expired"(target_run UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  grant_id UUID;
  run_row public."ProjectGitRepositoryAutomationRun"%ROWTYPE;
  cursor_row public."ProjectGitRepositoryAutomationScheduleCursor"%ROWTYPE;
  database_now TIMESTAMP(3);
  eligibility_reason TEXT;
  is_dispatched BOOLEAN;
  final_code VARCHAR(64);
  final_status public."ProjectGitRepositoryAutomationRunStatus";
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') <> 'serializable' THEN
    RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_SERIALIZABLE_REQUIRED' USING ERRCODE = '25001';
  END IF;
  SELECT "grantId" INTO grant_id FROM public."ProjectGitRepositoryAutomationRun" WHERE "id" = target_run;
  IF NOT FOUND OR NOT public."project_git_automation_lock_grant"(grant_id) THEN RETURN FALSE; END IF;
  database_now := pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp() AT TIME ZONE 'UTC');
  PERFORM pg_catalog.set_config('ai_project_os.git_automation_now', database_now::text, TRUE);
  SELECT * INTO cursor_row FROM public."ProjectGitRepositoryAutomationScheduleCursor" WHERE "grantId" = grant_id FOR UPDATE;
  SELECT * INTO run_row FROM public."ProjectGitRepositoryAutomationRun" WHERE "id" = target_run FOR UPDATE;
  IF NOT FOUND OR run_row."status" NOT IN ('pending', 'dispatched') OR run_row."leaseExpiresAt" IS NULL
     OR run_row."leaseExpiresAt" > database_now THEN RETURN FALSE; END IF;
  eligibility_reason := public."project_git_automation_grant_eligibility"(run_row."grantId", run_row."projectId", database_now);
  IF eligibility_reason IS NULL AND NOT public."project_git_automation_run_snapshot_matches"(run_row."id") THEN
    eligibility_reason := 'BASE_DELEGATION_DRIFT';
  END IF;
  is_dispatched := run_row."status" = 'dispatched';
  final_code := CASE
    WHEN eligibility_reason IS NOT NULL THEN CASE WHEN is_dispatched THEN 'GRANT_INELIGIBLE_AFTER_DISPATCH' ELSE 'GRANT_INELIGIBLE_BEFORE_DISPATCH' END
    WHEN is_dispatched THEN 'LEASE_EXPIRED_AFTER_DISPATCH' ELSE 'LEASE_EXPIRED_BEFORE_DISPATCH'
  END;
  final_status := CASE WHEN is_dispatched THEN 'unknown'::public."ProjectGitRepositoryAutomationRunStatus"
                       ELSE 'failed'::public."ProjectGitRepositoryAutomationRunStatus" END;
  IF eligibility_reason IS NOT NULL AND cursor_row."status" = 'active' THEN
    PERFORM pg_catalog.set_config('ai_project_os.git_automation_transition', 'claim', TRUE);
    UPDATE public."ProjectGitRepositoryAutomationScheduleCursor"
       SET "status" = 'paused', "pauseReason" = CASE eligibility_reason
         WHEN 'NOT_FOUND' THEN 'grant_missing' WHEN 'NOT_ACTIVE' THEN 'grant_not_active'
         WHEN 'EXPIRED' THEN 'grant_expired' WHEN 'PROJECT_ARCHIVED' THEN 'project_archived'
         WHEN 'BASE_DELEGATION_DRIFT' THEN 'base_delegation_drift' WHEN 'CONNECTION_DRIFT' THEN 'connection_drift'
         WHEN 'OWNER_MEMBERSHIP_DRIFT' THEN 'owner_membership_drift' WHEN 'PROJECT_OWNER_MEMBERSHIP_DRIFT' THEN 'project_owner_membership_drift'
         ELSE 'grant_ineligible' END,
         "pausedAt" = database_now, "version" = "version" + 1
     WHERE "grantId" = grant_id AND "status" = 'active';
  END IF;
  PERFORM pg_catalog.set_config('ai_project_os.git_automation_transition', 'reconcile', TRUE);
  UPDATE public."ProjectGitRepositoryAutomationRun"
     SET "status" = final_status, "leaseExpiresAt" = NULL, "completedAt" = database_now,
         "safeErrorCode" = final_code, "version" = "version" + 1
   WHERE "id" = target_run;
  RETURN TRUE;
END;
$$;

DROP TRIGGER IF EXISTS "Project_git_automation_delete_guard" ON public."Project";
CREATE TRIGGER "Project_git_automation_delete_guard"
BEFORE DELETE ON public."Project"
FOR EACH ROW EXECUTE FUNCTION public."project_git_automation_guard_project_delete"();

REVOKE ALL ON FUNCTION public."project_git_automation_grant_eligibility"(UUID, UUID, TIMESTAMP WITHOUT TIME ZONE) FROM PUBLIC;
REVOKE ALL ON FUNCTION public."project_git_automation_lock_grant"(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public."project_git_automation_run_snapshot_matches"(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public."project_git_automation_claim_due"(UUID, VARCHAR) FROM PUBLIC;
REVOKE ALL ON FUNCTION public."project_git_automation_mutate_lease"(UUID, VARCHAR, UUID, VARCHAR) FROM PUBLIC;
REVOKE ALL ON FUNCTION public."project_git_automation_reconcile_expired"(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public."project_git_automation_pause_cursor_on_grant_terminal"() FROM PUBLIC;
REVOKE ALL ON FUNCTION public."project_git_automation_cursor_shape_guard"() FROM PUBLIC;
REVOKE ALL ON FUNCTION public."project_git_automation_run_shape_guard"() FROM PUBLIC;
REVOKE ALL ON FUNCTION public."project_git_automation_run_audit_insert_guard"() FROM PUBLIC;
REVOKE ALL ON FUNCTION public."project_git_automation_cursor_audit_capture"() FROM PUBLIC;
REVOKE ALL ON FUNCTION public."project_git_automation_run_audit_capture"() FROM PUBLIC;
REVOKE ALL ON FUNCTION public."project_git_automation_ledger_delete_guard"() FROM PUBLIC;
REVOKE ALL ON FUNCTION public."project_git_automation_guard_project_delete"() FROM PUBLIC;
