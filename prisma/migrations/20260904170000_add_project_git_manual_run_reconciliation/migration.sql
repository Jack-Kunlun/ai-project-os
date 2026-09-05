-- Append-only manual review evidence for runs that ended in unknown.
-- This table intentionally has no foreign keys: deleting a project must not
-- erase the historical acknowledgement evidence.
DO $$
DECLARE
  invalid_count bigint;
BEGIN
  SELECT count(*)
    INTO invalid_count
  FROM "ProjectGitRepositoryDelegation"
  WHERE "manualSyncAllowed" IS DISTINCT FROM true
     OR "automationAllowed" IS DISTINCT FROM false;

  IF invalid_count > 0 THEN
    RAISE EXCEPTION 'PGRD_MANUAL_READ_ONLY_PREFLIGHT_FAILED: % existing delegation rows require manual remediation', invalid_count
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

ALTER TABLE "ProjectGitRepositoryDelegation"
  ADD CONSTRAINT "PGRD_manual_read_only_check"
  CHECK ("manualSyncAllowed" = true AND "automationAllowed" = false);

CREATE TABLE "ProjectGitRepositoryManualRunReconciliation" (
  "id" UUID NOT NULL,
  "runId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "delegationId" UUID NOT NULL,
  "actorId" UUID NOT NULL,
  "actorProjectMembershipId" UUID NOT NULL,
  "actorMembershipCreatedAt" TIMESTAMP(3) NOT NULL,
  "acknowledgedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "transactionId" BIGINT NOT NULL DEFAULT txid_current(),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProjectGitRepositoryManualRunReconciliation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProjectGitRepositoryManualRunReconciliation_run_key" UNIQUE ("runId")
);

CREATE INDEX "ProjectGitRepositoryManualRunReconciliation_project_ack_idx"
  ON "ProjectGitRepositoryManualRunReconciliation" ("projectId", "acknowledgedAt");
CREATE INDEX "ProjectGitRepositoryManualRunReconciliation_delegation_ack_idx"
  ON "ProjectGitRepositoryManualRunReconciliation" ("delegationId", "acknowledgedAt");

CREATE INDEX "ProjectGitRepositoryManualRun_projectId_delegationId_createdAt_id_idx"
  ON "ProjectGitRepositoryManualRun" ("projectId", "delegationId", "createdAt", "id");

CREATE OR REPLACE FUNCTION "project_git_manual_run_reconciliation_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  run_project_id UUID;
  run_delegation_id UUID;
  run_status "ProjectGitRepositoryManualRunStatus";
  project_archived_at TIMESTAMPTZ;
  actor_disabled_at TIMESTAMPTZ;
  membership_project_id UUID;
  membership_user_id UUID;
  membership_role "ProjectMembershipRole";
  membership_state "MembershipAccessState";
  membership_created_at TIMESTAMP(3);
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'PROJECT_GIT_MANUAL_RECONCILIATION_IMMUTABLE' USING ERRCODE = 'check_violation';
  END IF;
  IF current_setting('ai.project_git_manual_run_reconciliation', true) IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'PROJECT_GIT_MANUAL_RECONCILIATION_CONTEXT_REQUIRED' USING ERRCODE = 'check_violation';
  END IF;

  SELECT run."projectId", run."delegationId", run."status"
    INTO run_project_id, run_delegation_id, run_status
  FROM "ProjectGitRepositoryManualRun" run
  WHERE run."id" = NEW."runId"
  FOR SHARE;
  IF run_project_id IS NULL
     OR run_project_id IS DISTINCT FROM NEW."projectId"
     OR run_delegation_id IS DISTINCT FROM NEW."delegationId"
     OR run_status <> 'unknown' THEN
    RAISE EXCEPTION 'PROJECT_GIT_MANUAL_RECONCILIATION_RUN_INVALID' USING ERRCODE = 'check_violation';
  END IF;

  SELECT project."archivedAt"
    INTO project_archived_at
  FROM "Project" project
  WHERE project."id" = NEW."projectId"
  FOR SHARE;
  IF NOT FOUND OR project_archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'PROJECT_GIT_MANUAL_RECONCILIATION_PROJECT_INVALID' USING ERRCODE = 'check_violation';
  END IF;

  SELECT actor."disabledAt"
    INTO actor_disabled_at
  FROM "AppUser" actor
  WHERE actor."id" = NEW."actorId"
  FOR SHARE;
  IF NOT FOUND OR actor_disabled_at IS NOT NULL THEN
    RAISE EXCEPTION 'PROJECT_GIT_MANUAL_RECONCILIATION_ACTOR_INVALID' USING ERRCODE = 'check_violation';
  END IF;

  SELECT membership."projectId", membership."userId", membership."role", membership."accessState", membership."createdAt"
    INTO membership_project_id, membership_user_id, membership_role, membership_state, membership_created_at
  FROM "ProjectMembership" membership
  WHERE membership."id" = NEW."actorProjectMembershipId"
  FOR SHARE;
  IF NOT FOUND
     OR membership_project_id IS DISTINCT FROM NEW."projectId"
     OR membership_user_id IS DISTINCT FROM NEW."actorId"
     OR membership_role NOT IN ('owner', 'editor')
     OR membership_state <> 'confirmed'
     OR membership_created_at IS DISTINCT FROM NEW."actorMembershipCreatedAt" THEN
    RAISE EXCEPTION 'PROJECT_GIT_MANUAL_RECONCILIATION_MEMBERSHIP_INVALID' USING ERRCODE = 'check_violation';
  END IF;

  -- Timestamps and transaction evidence are always server-authored.
  NEW."acknowledgedAt" := clock_timestamp();
  NEW."createdAt" := clock_timestamp();
  NEW."transactionId" := txid_current();
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ProjectGitRepositoryManualRunReconciliation_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "ProjectGitRepositoryManualRunReconciliation"
FOR EACH ROW EXECUTE FUNCTION "project_git_manual_run_reconciliation_guard"();
