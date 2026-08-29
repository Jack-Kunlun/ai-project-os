CREATE TYPE "ProjectActionPolicyMode" AS ENUM ('automatic', 'approval_required', 'denied');
CREATE TYPE "ProjectActionRiskLevel" AS ENUM ('low', 'medium', 'high');
CREATE TYPE "ProjectActionStatus" AS ENUM ('waiting_approval', 'queued', 'running', 'succeeded', 'failed', 'rejected', 'cancelled', 'expired');
CREATE TYPE "ProjectActionApprovalDecision" AS ENUM ('approved', 'rejected');
CREATE TYPE "ProjectActionAuditEvent" AS ENUM ('requested', 'queued', 'approval_requested', 'approved', 'rejected', 'cancelled', 'claimed', 'succeeded', 'failed', 'expired');
ALTER TYPE "NotificationKind" ADD VALUE 'action_approval_required';
ALTER TYPE "NotificationKind" ADD VALUE 'action_completed';
ALTER TYPE "NotificationKind" ADD VALUE 'action_failed';

CREATE TABLE "ProjectActionPolicy" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "capability" VARCHAR(96) NOT NULL,
    "mode" "ProjectActionPolicyMode" NOT NULL,
    "updatedById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ProjectActionPolicy_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ProjectActionPolicy_capability_check" CHECK (
        "capability" IN ('project.repository.sync', 'project.web-source.sync', 'project.memory-quality.scan')
    )
);

CREATE TABLE "ProjectAction" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "capability" VARCHAR(96) NOT NULL,
    "riskLevel" "ProjectActionRiskLevel" NOT NULL,
    "status" "ProjectActionStatus" NOT NULL,
    "input" JSONB NOT NULL DEFAULT '{}',
    "inputFingerprint" CHAR(64) NOT NULL,
    "policyModeSnapshot" "ProjectActionPolicyMode" NOT NULL,
    "idempotencyKey" CHAR(64) NOT NULL,
    "requestedById" UUID NOT NULL,
    "approvalExpiresAt" TIMESTAMP(3),
    "workerId" VARCHAR(128),
    "leaseExpiresAt" TIMESTAMP(3),
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "result" JSONB,
    "failureCode" VARCHAR(64),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ProjectAction_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ProjectAction_capability_check" CHECK (
        "capability" IN ('project.repository.sync', 'project.web-source.sync', 'project.memory-quality.scan')
    ),
    CONSTRAINT "ProjectAction_input_check" CHECK (jsonb_typeof("input") = 'object'),
    CONSTRAINT "ProjectAction_result_check" CHECK ("result" IS NULL OR jsonb_typeof("result") = 'object'),
    CONSTRAINT "ProjectAction_fingerprint_check" CHECK (
        "inputFingerprint" ~ '^[0-9a-f]{64}$' AND "idempotencyKey" ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT "ProjectAction_attempt_check" CHECK ("attemptCount" >= 0 AND "attemptCount" <= 100),
    CONSTRAINT "ProjectAction_worker_check" CHECK (
        "workerId" IS NULL OR "workerId" ~ '^[A-Za-z0-9._:-]{8,128}$'
    ),
    CONSTRAINT "ProjectAction_failure_check" CHECK (
        ("status" = 'failed' AND "failureCode" IS NOT NULL)
        OR ("status" <> 'failed' AND "failureCode" IS NULL)
    ),
    CONSTRAINT "ProjectAction_state_check" CHECK (
        ("status" = 'waiting_approval' AND "approvalExpiresAt" IS NOT NULL AND "workerId" IS NULL AND "leaseExpiresAt" IS NULL AND "startedAt" IS NULL AND "completedAt" IS NULL)
        OR ("status" = 'queued' AND "workerId" IS NULL AND "leaseExpiresAt" IS NULL AND "startedAt" IS NULL AND "completedAt" IS NULL)
        OR ("status" = 'running' AND "workerId" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL AND "startedAt" IS NOT NULL AND "completedAt" IS NULL)
        OR ("status" IN ('succeeded', 'failed', 'rejected', 'cancelled', 'expired') AND "leaseExpiresAt" IS NULL AND "completedAt" IS NOT NULL)
    )
);

CREATE TABLE "ProjectActionPolicyRevision" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "capability" VARCHAR(96) NOT NULL,
    "previousMode" "ProjectActionPolicyMode",
    "currentMode" "ProjectActionPolicyMode" NOT NULL,
    "changedById" UUID NOT NULL,
    "policyUpdatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProjectActionPolicyRevision_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ProjectActionPolicyRevision_capability_check" CHECK (
        "capability" IN ('project.repository.sync', 'project.web-source.sync', 'project.memory-quality.scan')
    )
);

CREATE TABLE "ProjectActionApproval" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "actionId" UUID NOT NULL,
    "decision" "ProjectActionApprovalDecision" NOT NULL,
    "actionFingerprint" CHAR(64) NOT NULL,
    "decidedById" UUID NOT NULL,
    "note" VARCHAR(500),
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProjectActionApproval_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ProjectActionApproval_fingerprint_check" CHECK ("actionFingerprint" ~ '^[0-9a-f]{64}$')
);

CREATE TABLE "ProjectActionAudit" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "actionId" UUID NOT NULL,
    "event" "ProjectActionAuditEvent" NOT NULL,
    "actorId" UUID,
    "details" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProjectActionAudit_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ProjectActionAudit_details_check" CHECK (jsonb_typeof("details") = 'object')
);

CREATE UNIQUE INDEX "ProjectActionPolicy_projectId_capability_key" ON "ProjectActionPolicy"("projectId", "capability");
CREATE INDEX "ProjectActionPolicy_projectId_mode_idx" ON "ProjectActionPolicy"("projectId", "mode");
CREATE INDEX "ProjectActionPolicy_updatedById_updatedAt_idx" ON "ProjectActionPolicy"("updatedById", "updatedAt");
CREATE INDEX "ProjectActionPolicyRevision_projectId_capability_createdAt_idx" ON "ProjectActionPolicyRevision"("projectId", "capability", "createdAt");
CREATE INDEX "ProjectActionPolicyRevision_changedById_createdAt_idx" ON "ProjectActionPolicyRevision"("changedById", "createdAt");
CREATE UNIQUE INDEX "ProjectAction_projectId_id_key" ON "ProjectAction"("projectId", "id");
CREATE UNIQUE INDEX "ProjectAction_projectId_requestedById_idempotencyKey_key" ON "ProjectAction"("projectId", "requestedById", "idempotencyKey");
CREATE INDEX "ProjectAction_projectId_status_createdAt_idx" ON "ProjectAction"("projectId", "status", "createdAt");
CREATE INDEX "ProjectAction_status_leaseExpiresAt_createdAt_idx" ON "ProjectAction"("status", "leaseExpiresAt", "createdAt");
CREATE INDEX "ProjectAction_requestedById_createdAt_idx" ON "ProjectAction"("requestedById", "createdAt");
CREATE UNIQUE INDEX "ProjectActionApproval_actionId_key" ON "ProjectActionApproval"("actionId");
CREATE UNIQUE INDEX "ProjectActionApproval_projectId_actionId_key" ON "ProjectActionApproval"("projectId", "actionId");
CREATE INDEX "ProjectActionApproval_decidedById_decidedAt_idx" ON "ProjectActionApproval"("decidedById", "decidedAt");
CREATE INDEX "ProjectActionAudit_projectId_actionId_createdAt_idx" ON "ProjectActionAudit"("projectId", "actionId", "createdAt");
CREATE INDEX "ProjectActionAudit_actorId_createdAt_idx" ON "ProjectActionAudit"("actorId", "createdAt");

ALTER TABLE "ProjectActionPolicy" ADD CONSTRAINT "ProjectActionPolicy_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectActionPolicy" ADD CONSTRAINT "ProjectActionPolicy_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "ProjectActionPolicyRevision" ADD CONSTRAINT "ProjectActionPolicyRevision_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectActionPolicyRevision" ADD CONSTRAINT "ProjectActionPolicyRevision_changedById_fkey" FOREIGN KEY ("changedById") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "ProjectAction" ADD CONSTRAINT "ProjectAction_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectAction" ADD CONSTRAINT "ProjectAction_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "ProjectActionApproval" ADD CONSTRAINT "ProjectActionApproval_action_fkey" FOREIGN KEY ("projectId", "actionId") REFERENCES "ProjectAction"("projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectActionApproval" ADD CONSTRAINT "ProjectActionApproval_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "ProjectActionAudit" ADD CONSTRAINT "ProjectActionAudit_action_fkey" FOREIGN KEY ("projectId", "actionId") REFERENCES "ProjectAction"("projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectActionAudit" ADD CONSTRAINT "ProjectActionAudit_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION "project_action_state_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD."projectId" <> NEW."projectId"
       OR OLD."capability" <> NEW."capability"
       OR OLD."riskLevel" <> NEW."riskLevel"
       OR OLD."input" <> NEW."input"
       OR OLD."inputFingerprint" <> NEW."inputFingerprint"
       OR OLD."policyModeSnapshot" <> NEW."policyModeSnapshot"
       OR OLD."idempotencyKey" <> NEW."idempotencyKey"
       OR OLD."requestedById" <> NEW."requestedById"
       OR OLD."createdAt" <> NEW."createdAt" THEN
        RAISE EXCEPTION 'project action identity is immutable' USING ERRCODE = 'check_violation';
    END IF;

    IF OLD."status" = NEW."status" THEN
        RETURN NEW;
    END IF;

    IF NEW."status" = 'running' AND NOT EXISTS (
        SELECT 1 FROM "Project" AS project
        WHERE project."id" = NEW."projectId" AND project."archivedAt" IS NULL
    ) THEN
        RAISE EXCEPTION 'archived project action cannot start' USING ERRCODE = 'check_violation';
    END IF;

    IF OLD."status" = 'waiting_approval' AND NEW."status" IN ('queued', 'rejected', 'cancelled', 'expired') THEN
        IF NEW."status" IN ('queued', 'rejected') AND NOT EXISTS (
            SELECT 1 FROM "ProjectActionApproval" AS approval
            WHERE approval."actionId" = OLD."id"
              AND approval."actionFingerprint" = OLD."inputFingerprint"
              AND approval."decision"::text = CASE WHEN NEW."status" = 'queued' THEN 'approved' ELSE 'rejected' END
        ) THEN
            RAISE EXCEPTION 'project action decision is not bound to the action fingerprint' USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;

    IF OLD."status" = 'queued' AND NEW."status" IN ('running', 'cancelled') THEN
        RETURN NEW;
    END IF;

    IF OLD."status" = 'running' AND NEW."status" IN ('succeeded', 'failed') THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'invalid project action state transition' USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER "ProjectAction_state_guard"
BEFORE UPDATE ON "ProjectAction"
FOR EACH ROW EXECUTE FUNCTION "project_action_state_guard"();

CREATE OR REPLACE FUNCTION "project_action_approval_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NOT EXISTS (
            SELECT 1 FROM "ProjectAction" AS action
            WHERE action."id" = NEW."actionId"
              AND action."projectId" = NEW."projectId"
              AND action."status" = 'waiting_approval'
              AND action."policyModeSnapshot" = 'approval_required'
              AND action."inputFingerprint" = NEW."actionFingerprint"
        ) THEN
            RAISE EXCEPTION 'project action approval does not match an active request' USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;

    IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM "ProjectAction" WHERE "id" = OLD."actionId") THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'project action approval is immutable' USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER "ProjectActionApproval_immutable_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "ProjectActionApproval"
FOR EACH ROW EXECUTE FUNCTION "project_action_approval_guard"();

CREATE OR REPLACE FUNCTION "project_action_audit_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        RETURN NEW;
    END IF;

    IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM "ProjectAction" WHERE "id" = OLD."actionId") THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'project action audit is immutable' USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER "ProjectActionAudit_immutable_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "ProjectActionAudit"
FOR EACH ROW EXECUTE FUNCTION "project_action_audit_guard"();

CREATE OR REPLACE FUNCTION "project_action_policy_revision_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NOT EXISTS (
            SELECT 1 FROM "ProjectActionPolicy" AS policy
            WHERE policy."projectId" = NEW."projectId"
              AND policy."capability" = NEW."capability"
              AND policy."mode" = NEW."currentMode"
              AND policy."updatedAt" = NEW."policyUpdatedAt"
        ) THEN
            RAISE EXCEPTION 'project action policy revision must match current policy' USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;

    IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM "Project" WHERE "id" = OLD."projectId") THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'project action policy revision is immutable' USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER "ProjectActionPolicyRevision_immutable_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "ProjectActionPolicyRevision"
FOR EACH ROW EXECUTE FUNCTION "project_action_policy_revision_guard"();
