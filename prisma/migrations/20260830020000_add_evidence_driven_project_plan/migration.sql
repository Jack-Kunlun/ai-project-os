CREATE TYPE "ProjectObjectiveStatus" AS ENUM ('draft', 'active', 'completed', 'cancelled');
CREATE TYPE "ProjectWorkItemStatus" AS ENUM ('proposed', 'planned', 'in_progress', 'blocked', 'completed', 'cancelled');
CREATE TYPE "ProjectWorkItemPriority" AS ENUM ('low', 'medium', 'high', 'urgent');
CREATE TYPE "ProjectWorkItemOrigin" AS ENUM ('manual', 'agent_recommendation');
CREATE TYPE "ProjectPlanEntityType" AS ENUM ('objective', 'work_item', 'dependency');
CREATE TYPE "ProjectPlanAuditEvent" AS ENUM ('created', 'updated', 'status_changed', 'recommendation_promoted', 'dependency_added', 'dependency_removed');

CREATE UNIQUE INDEX "ProjectAgentRun_projectId_id_key" ON "ProjectAgentRun"("projectId", "id");

CREATE TABLE "ProjectObjective" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "title" VARCHAR(160) NOT NULL,
    "description" TEXT,
    "status" "ProjectObjectiveStatus" NOT NULL DEFAULT 'draft',
    "targetDate" DATE,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "ProjectObjective_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ProjectObjective_completion_check" CHECK (
        ("status" = 'completed' AND "completedAt" IS NOT NULL)
        OR ("status" <> 'completed' AND "completedAt" IS NULL)
    )
);

CREATE TABLE "ProjectWorkItem" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "objectiveId" UUID,
    "title" VARCHAR(160) NOT NULL,
    "description" TEXT,
    "status" "ProjectWorkItemStatus" NOT NULL DEFAULT 'planned',
    "priority" "ProjectWorkItemPriority" NOT NULL DEFAULT 'medium',
    "targetDate" DATE,
    "origin" "ProjectWorkItemOrigin" NOT NULL DEFAULT 'manual',
    "agentRunId" UUID,
    "recommendationIndex" INTEGER,
    "evidenceSnapshot" JSONB,
    "evidenceFingerprint" CHAR(64),
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "ProjectWorkItem_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ProjectWorkItem_completion_check" CHECK (
        ("status" = 'completed' AND "completedAt" IS NOT NULL)
        OR ("status" <> 'completed' AND "completedAt" IS NULL)
    ),
    CONSTRAINT "ProjectWorkItem_origin_check" CHECK (
        ("origin" = 'manual' AND "agentRunId" IS NULL AND "recommendationIndex" IS NULL AND "evidenceSnapshot" IS NULL AND "evidenceFingerprint" IS NULL)
        OR
        ("origin" = 'agent_recommendation' AND "agentRunId" IS NOT NULL AND "recommendationIndex" >= 0
          AND jsonb_typeof("evidenceSnapshot") = 'object' AND "evidenceFingerprint" ~ '^[0-9a-f]{64}$')
    )
);

CREATE TABLE "ProjectWorkItemDependency" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "workItemId" UUID NOT NULL,
    "dependsOnId" UUID NOT NULL,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMP(3),
    "removedById" UUID,
    CONSTRAINT "ProjectWorkItemDependency_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ProjectWorkItemDependency_self_check" CHECK ("workItemId" <> "dependsOnId"),
    CONSTRAINT "ProjectWorkItemDependency_removal_check" CHECK (
        ("removedAt" IS NULL AND "removedById" IS NULL)
        OR ("removedAt" IS NOT NULL AND "removedById" IS NOT NULL)
    )
);

CREATE TABLE "ProjectPlanAudit" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "entityType" "ProjectPlanEntityType" NOT NULL,
    "entityId" UUID NOT NULL,
    "event" "ProjectPlanAuditEvent" NOT NULL,
    "details" JSONB NOT NULL DEFAULT '{}',
    "actorId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProjectPlanAudit_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ProjectPlanAudit_details_check" CHECK (jsonb_typeof("details") = 'object')
);

CREATE UNIQUE INDEX "ProjectObjective_projectId_id_key" ON "ProjectObjective"("projectId", "id");
CREATE INDEX "ProjectObjective_projectId_status_updatedAt_idx" ON "ProjectObjective"("projectId", "status", "updatedAt");
CREATE INDEX "ProjectObjective_createdById_createdAt_idx" ON "ProjectObjective"("createdById", "createdAt");
CREATE UNIQUE INDEX "ProjectWorkItem_projectId_id_key" ON "ProjectWorkItem"("projectId", "id");
CREATE UNIQUE INDEX "ProjectWorkItem_projectId_agentRunId_recommendationIndex_key" ON "ProjectWorkItem"("projectId", "agentRunId", "recommendationIndex");
CREATE INDEX "ProjectWorkItem_projectId_status_priority_updatedAt_idx" ON "ProjectWorkItem"("projectId", "status", "priority", "updatedAt");
CREATE INDEX "ProjectWorkItem_projectId_objectiveId_status_idx" ON "ProjectWorkItem"("projectId", "objectiveId", "status");
CREATE INDEX "ProjectWorkItem_createdById_createdAt_idx" ON "ProjectWorkItem"("createdById", "createdAt");
CREATE UNIQUE INDEX "ProjectWorkItemDependency_projectId_id_key" ON "ProjectWorkItemDependency"("projectId", "id");
CREATE UNIQUE INDEX "ProjectWorkItemDependency_active_key" ON "ProjectWorkItemDependency"("projectId", "workItemId", "dependsOnId") WHERE "removedAt" IS NULL;
CREATE INDEX "ProjectWorkItemDependency_projectId_workItemId_removedAt_idx" ON "ProjectWorkItemDependency"("projectId", "workItemId", "removedAt");
CREATE INDEX "ProjectWorkItemDependency_projectId_dependsOnId_removedAt_idx" ON "ProjectWorkItemDependency"("projectId", "dependsOnId", "removedAt");
CREATE INDEX "ProjectWorkItemDependency_createdById_createdAt_idx" ON "ProjectWorkItemDependency"("createdById", "createdAt");
CREATE INDEX "ProjectWorkItemDependency_removedById_removedAt_idx" ON "ProjectWorkItemDependency"("removedById", "removedAt");
CREATE INDEX "ProjectPlanAudit_projectId_entityType_entityId_createdAt_idx" ON "ProjectPlanAudit"("projectId", "entityType", "entityId", "createdAt");
CREATE INDEX "ProjectPlanAudit_projectId_createdAt_idx" ON "ProjectPlanAudit"("projectId", "createdAt");
CREATE INDEX "ProjectPlanAudit_actorId_createdAt_idx" ON "ProjectPlanAudit"("actorId", "createdAt");

ALTER TABLE "ProjectObjective" ADD CONSTRAINT "ProjectObjective_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectObjective" ADD CONSTRAINT "ProjectObjective_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "ProjectWorkItem" ADD CONSTRAINT "ProjectWorkItem_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectWorkItem" ADD CONSTRAINT "ProjectWorkItem_objective_fkey" FOREIGN KEY ("projectId", "objectiveId") REFERENCES "ProjectObjective"("projectId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "ProjectWorkItem" ADD CONSTRAINT "ProjectWorkItem_agentRun_fkey" FOREIGN KEY ("projectId", "agentRunId") REFERENCES "ProjectAgentRun"("projectId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "ProjectWorkItem" ADD CONSTRAINT "ProjectWorkItem_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "ProjectWorkItemDependency" ADD CONSTRAINT "ProjectWorkItemDependency_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectWorkItemDependency" ADD CONSTRAINT "ProjectWorkItemDependency_workItem_fkey" FOREIGN KEY ("projectId", "workItemId") REFERENCES "ProjectWorkItem"("projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectWorkItemDependency" ADD CONSTRAINT "ProjectWorkItemDependency_dependsOn_fkey" FOREIGN KEY ("projectId", "dependsOnId") REFERENCES "ProjectWorkItem"("projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectWorkItemDependency" ADD CONSTRAINT "ProjectWorkItemDependency_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "ProjectWorkItemDependency" ADD CONSTRAINT "ProjectWorkItemDependency_removedById_fkey" FOREIGN KEY ("removedById") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "ProjectPlanAudit" ADD CONSTRAINT "ProjectPlanAudit_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectPlanAudit" ADD CONSTRAINT "ProjectPlanAudit_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION "project_objective_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD."id" <> NEW."id" OR OLD."projectId" <> NEW."projectId" OR OLD."createdById" <> NEW."createdById" OR OLD."createdAt" <> NEW."createdAt" THEN
        RAISE EXCEPTION 'project objective identity is immutable' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" <> NEW."status" AND NOT (
        (OLD."status" = 'draft' AND NEW."status" IN ('active', 'cancelled'))
        OR (OLD."status" = 'active' AND NEW."status" IN ('completed', 'cancelled'))
    ) THEN
        RAISE EXCEPTION 'invalid project objective status transition' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER "ProjectObjective_guard" BEFORE UPDATE ON "ProjectObjective" FOR EACH ROW EXECUTE FUNCTION "project_objective_guard"();

CREATE OR REPLACE FUNCTION "project_work_item_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD."id" <> NEW."id" OR OLD."projectId" <> NEW."projectId" OR OLD."origin" <> NEW."origin"
       OR OLD."agentRunId" IS DISTINCT FROM NEW."agentRunId" OR OLD."recommendationIndex" IS DISTINCT FROM NEW."recommendationIndex"
       OR OLD."evidenceSnapshot" IS DISTINCT FROM NEW."evidenceSnapshot" OR OLD."evidenceFingerprint" IS DISTINCT FROM NEW."evidenceFingerprint"
       OR OLD."createdById" <> NEW."createdById" OR OLD."createdAt" <> NEW."createdAt" THEN
        RAISE EXCEPTION 'project work item provenance is immutable' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" <> NEW."status" AND NOT (
        (OLD."status" = 'proposed' AND NEW."status" IN ('planned', 'cancelled'))
        OR (OLD."status" = 'planned' AND NEW."status" IN ('in_progress', 'blocked', 'cancelled'))
        OR (OLD."status" = 'in_progress' AND NEW."status" IN ('blocked', 'completed', 'cancelled'))
        OR (OLD."status" = 'blocked' AND NEW."status" IN ('planned', 'in_progress', 'cancelled'))
    ) THEN
        RAISE EXCEPTION 'invalid project work item status transition' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER "ProjectWorkItem_guard" BEFORE UPDATE ON "ProjectWorkItem" FOR EACH ROW EXECUTE FUNCTION "project_work_item_guard"();

CREATE OR REPLACE FUNCTION "project_work_item_dependency_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF EXISTS (SELECT 1 FROM "Project" WHERE "id" = OLD."projectId") THEN
            RAISE EXCEPTION 'project work item dependencies are append-only' USING ERRCODE = 'check_violation';
        END IF;
        RETURN OLD;
    END IF;
    IF OLD."id" <> NEW."id" OR OLD."projectId" <> NEW."projectId" OR OLD."workItemId" <> NEW."workItemId"
       OR OLD."dependsOnId" <> NEW."dependsOnId" OR OLD."createdById" <> NEW."createdById" OR OLD."createdAt" <> NEW."createdAt"
       OR OLD."removedAt" IS NOT NULL OR NEW."removedAt" IS NULL OR NEW."removedById" IS NULL THEN
        RAISE EXCEPTION 'project work item dependency identity is immutable' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER "ProjectWorkItemDependency_guard" BEFORE UPDATE OR DELETE ON "ProjectWorkItemDependency" FOR EACH ROW EXECUTE FUNCTION "project_work_item_dependency_guard"();

CREATE OR REPLACE FUNCTION "project_plan_audit_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM "Project" WHERE "id" = OLD."projectId") THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'project plan audit is immutable' USING ERRCODE = 'check_violation';
END;
$$;
CREATE TRIGGER "ProjectPlanAudit_guard" BEFORE UPDATE OR DELETE ON "ProjectPlanAudit" FOR EACH ROW EXECUTE FUNCTION "project_plan_audit_guard"();
