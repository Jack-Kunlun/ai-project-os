ALTER TYPE "AutomationRuleKind" ADD VALUE IF NOT EXISTS 'project_plan_health';
ALTER TYPE "NotificationKind" ADD VALUE IF NOT EXISTS 'project_plan_health';
ALTER TYPE "ProjectPlanEntityType" ADD VALUE IF NOT EXISTS 'evidence_link';
ALTER TYPE "ProjectPlanEntityType" ADD VALUE IF NOT EXISTS 'impact_suggestion';
ALTER TYPE "ProjectPlanAuditEvent" ADD VALUE IF NOT EXISTS 'evidence_linked';
ALTER TYPE "ProjectPlanAuditEvent" ADD VALUE IF NOT EXISTS 'evidence_removed';
ALTER TYPE "ProjectPlanAuditEvent" ADD VALUE IF NOT EXISTS 'impact_detected';
ALTER TYPE "ProjectPlanAuditEvent" ADD VALUE IF NOT EXISTS 'impact_acknowledged';
ALTER TYPE "ProjectPlanAuditEvent" ADD VALUE IF NOT EXISTS 'impact_dismissed';

CREATE TYPE "ProjectPlanEvidenceKind" AS ENUM ('project_item', 'project_source', 'repository_sync');
CREATE TYPE "ProjectPlanImpactStatus" AS ENUM ('proposed', 'acknowledged', 'dismissed');

ALTER TABLE "ProjectWorkItem"
  ADD COLUMN "acceptanceCriteria" TEXT,
  ADD COLUMN "assigneeId" UUID;

CREATE TABLE "ProjectWorkItemEvidenceLink" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "workItemId" UUID NOT NULL,
    "kind" "ProjectPlanEvidenceKind" NOT NULL,
    "projectItemId" UUID,
    "projectSourceId" UUID,
    "repositorySyncRunId" UUID,
    "label" VARCHAR(200) NOT NULL,
    "evidenceSnapshot" JSONB NOT NULL,
    "evidenceFingerprint" CHAR(64) NOT NULL,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMP(3),
    "removedById" UUID,
    CONSTRAINT "ProjectWorkItemEvidenceLink_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ProjectWorkItemEvidenceLink_target_check" CHECK (
      ("kind" = 'project_item' AND "projectItemId" IS NOT NULL AND "projectSourceId" IS NULL AND "repositorySyncRunId" IS NULL)
      OR ("kind" = 'project_source' AND "projectItemId" IS NULL AND "projectSourceId" IS NOT NULL AND "repositorySyncRunId" IS NULL)
      OR ("kind" = 'repository_sync' AND "projectItemId" IS NULL AND "projectSourceId" IS NULL AND "repositorySyncRunId" IS NOT NULL)
    ),
    CONSTRAINT "ProjectWorkItemEvidenceLink_evidence_check" CHECK (
      jsonb_typeof("evidenceSnapshot") = 'object' AND "evidenceFingerprint" ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT "ProjectWorkItemEvidenceLink_removal_check" CHECK (
      ("removedAt" IS NULL AND "removedById" IS NULL)
      OR ("removedAt" IS NOT NULL AND "removedById" IS NOT NULL)
    )
);

CREATE TABLE "ProjectPlanImpactSuggestion" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "repositorySyncRunId" UUID NOT NULL,
    "status" "ProjectPlanImpactStatus" NOT NULL DEFAULT 'proposed',
    "title" VARCHAR(160) NOT NULL,
    "summary" TEXT NOT NULL,
    "evidenceSnapshot" JSONB NOT NULL,
    "evidenceFingerprint" CHAR(64) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "decidedById" UUID,
    CONSTRAINT "ProjectPlanImpactSuggestion_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ProjectPlanImpactSuggestion_evidence_check" CHECK (
      jsonb_typeof("evidenceSnapshot") = 'object' AND "evidenceFingerprint" ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT "ProjectPlanImpactSuggestion_decision_check" CHECK (
      ("status" = 'proposed' AND "decidedAt" IS NULL AND "decidedById" IS NULL)
      OR ("status" IN ('acknowledged', 'dismissed') AND "decidedAt" IS NOT NULL AND "decidedById" IS NOT NULL)
    )
);

CREATE UNIQUE INDEX "ProjectWorkItemEvidenceLink_projectId_id_key" ON "ProjectWorkItemEvidenceLink"("projectId", "id");
CREATE UNIQUE INDEX "ProjectWorkItemEvidenceLink_active_item_key" ON "ProjectWorkItemEvidenceLink"("projectId", "workItemId", "projectItemId") WHERE "removedAt" IS NULL AND "kind" = 'project_item';
CREATE UNIQUE INDEX "ProjectWorkItemEvidenceLink_active_source_key" ON "ProjectWorkItemEvidenceLink"("projectId", "workItemId", "projectSourceId") WHERE "removedAt" IS NULL AND "kind" = 'project_source';
CREATE UNIQUE INDEX "ProjectWorkItemEvidenceLink_active_sync_key" ON "ProjectWorkItemEvidenceLink"("projectId", "workItemId", "repositorySyncRunId") WHERE "removedAt" IS NULL AND "kind" = 'repository_sync';
CREATE INDEX "ProjectWorkItemEvidenceLink_projectId_workItemId_removedAt_idx" ON "ProjectWorkItemEvidenceLink"("projectId", "workItemId", "removedAt");
CREATE INDEX "ProjectWorkItemEvidenceLink_projectId_projectItemId_idx" ON "ProjectWorkItemEvidenceLink"("projectId", "projectItemId");
CREATE INDEX "ProjectWorkItemEvidenceLink_projectId_projectSourceId_idx" ON "ProjectWorkItemEvidenceLink"("projectId", "projectSourceId");
CREATE INDEX "ProjectWorkItemEvidenceLink_projectId_repositorySyncRunId_idx" ON "ProjectWorkItemEvidenceLink"("projectId", "repositorySyncRunId");
CREATE INDEX "ProjectWorkItemEvidenceLink_createdById_createdAt_idx" ON "ProjectWorkItemEvidenceLink"("createdById", "createdAt");
CREATE INDEX "ProjectWorkItemEvidenceLink_removedById_removedAt_idx" ON "ProjectWorkItemEvidenceLink"("removedById", "removedAt");

CREATE UNIQUE INDEX "ProjectPlanImpactSuggestion_projectId_id_key" ON "ProjectPlanImpactSuggestion"("projectId", "id");
CREATE UNIQUE INDEX "ProjectPlanImpactSuggestion_projectId_repositorySyncRunId_key" ON "ProjectPlanImpactSuggestion"("projectId", "repositorySyncRunId");
CREATE INDEX "ProjectPlanImpactSuggestion_projectId_status_createdAt_idx" ON "ProjectPlanImpactSuggestion"("projectId", "status", "createdAt");
CREATE INDEX "ProjectPlanImpactSuggestion_decidedById_decidedAt_idx" ON "ProjectPlanImpactSuggestion"("decidedById", "decidedAt");
CREATE INDEX "ProjectWorkItem_projectId_assigneeId_status_idx" ON "ProjectWorkItem"("projectId", "assigneeId", "status");
CREATE INDEX "ProjectWorkItem_projectId_targetDate_status_idx" ON "ProjectWorkItem"("projectId", "targetDate", "status");

ALTER TABLE "ProjectWorkItem" ADD CONSTRAINT "ProjectWorkItem_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "ProjectWorkItemEvidenceLink" ADD CONSTRAINT "ProjectWorkItemEvidenceLink_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectWorkItemEvidenceLink" ADD CONSTRAINT "ProjectWorkItemEvidenceLink_workItem_fkey" FOREIGN KEY ("projectId", "workItemId") REFERENCES "ProjectWorkItem"("projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectWorkItemEvidenceLink" ADD CONSTRAINT "ProjectWorkItemEvidenceLink_projectItem_fkey" FOREIGN KEY ("projectId", "projectItemId") REFERENCES "ProjectItem"("projectId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "ProjectWorkItemEvidenceLink" ADD CONSTRAINT "ProjectWorkItemEvidenceLink_projectSource_fkey" FOREIGN KEY ("projectId", "projectSourceId") REFERENCES "ProjectSource"("projectId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "ProjectWorkItemEvidenceLink" ADD CONSTRAINT "ProjectWorkItemEvidenceLink_repositorySyncRun_fkey" FOREIGN KEY ("projectId", "repositorySyncRunId") REFERENCES "ProjectGitHubSyncRun"("projectId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "ProjectWorkItemEvidenceLink" ADD CONSTRAINT "ProjectWorkItemEvidenceLink_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "ProjectWorkItemEvidenceLink" ADD CONSTRAINT "ProjectWorkItemEvidenceLink_removedById_fkey" FOREIGN KEY ("removedById") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "ProjectPlanImpactSuggestion" ADD CONSTRAINT "ProjectPlanImpactSuggestion_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectPlanImpactSuggestion" ADD CONSTRAINT "ProjectPlanImpactSuggestion_repositorySyncRun_fkey" FOREIGN KEY ("projectId", "repositorySyncRunId") REFERENCES "ProjectGitHubSyncRun"("projectId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "ProjectPlanImpactSuggestion" ADD CONSTRAINT "ProjectPlanImpactSuggestion_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

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
    IF OLD."status" IN ('completed', 'cancelled') THEN
        RAISE EXCEPTION 'terminal project work items are immutable' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" <> NEW."status" AND NOT (
        (OLD."status" = 'proposed' AND NEW."status" IN ('planned', 'cancelled'))
        OR (OLD."status" = 'planned' AND NEW."status" IN ('in_progress', 'blocked', 'cancelled'))
        OR (OLD."status" = 'in_progress' AND NEW."status" IN ('blocked', 'completed', 'cancelled'))
        OR (OLD."status" = 'blocked' AND NEW."status" IN ('planned', 'in_progress', 'cancelled'))
    ) THEN
        RAISE EXCEPTION 'invalid project work item status transition' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" IN ('in_progress', 'completed') AND (NEW."assigneeId" IS NULL OR NULLIF(BTRIM(NEW."acceptanceCriteria"), '') IS NULL) THEN
        RAISE EXCEPTION 'project work item readiness is required' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" = 'completed' AND NOT EXISTS (
        SELECT 1 FROM "ProjectWorkItemEvidenceLink"
        WHERE "projectId" = NEW."projectId" AND "workItemId" = NEW."id" AND "removedAt" IS NULL
    ) THEN
        RAISE EXCEPTION 'project work item completion evidence is required' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "project_work_item_evidence_link_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF EXISTS (SELECT 1 FROM "Project" WHERE "id" = OLD."projectId") THEN
            RAISE EXCEPTION 'project work item evidence links are append-only' USING ERRCODE = 'check_violation';
        END IF;
        RETURN OLD;
    END IF;
    IF OLD."id" <> NEW."id" OR OLD."projectId" <> NEW."projectId" OR OLD."workItemId" <> NEW."workItemId"
       OR OLD."kind" <> NEW."kind" OR OLD."projectItemId" IS DISTINCT FROM NEW."projectItemId"
       OR OLD."projectSourceId" IS DISTINCT FROM NEW."projectSourceId" OR OLD."repositorySyncRunId" IS DISTINCT FROM NEW."repositorySyncRunId"
       OR OLD."label" <> NEW."label" OR OLD."evidenceSnapshot" IS DISTINCT FROM NEW."evidenceSnapshot"
       OR OLD."evidenceFingerprint" <> NEW."evidenceFingerprint" OR OLD."createdById" <> NEW."createdById"
       OR OLD."createdAt" <> NEW."createdAt" OR OLD."removedAt" IS NOT NULL OR NEW."removedAt" IS NULL OR NEW."removedById" IS NULL THEN
        RAISE EXCEPTION 'project work item evidence link identity is immutable' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER "ProjectWorkItemEvidenceLink_guard" BEFORE UPDATE OR DELETE ON "ProjectWorkItemEvidenceLink" FOR EACH ROW EXECUTE FUNCTION "project_work_item_evidence_link_guard"();

CREATE OR REPLACE FUNCTION "project_plan_impact_suggestion_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF EXISTS (SELECT 1 FROM "Project" WHERE "id" = OLD."projectId") THEN
            RAISE EXCEPTION 'project plan impact suggestions are append-only' USING ERRCODE = 'check_violation';
        END IF;
        RETURN OLD;
    END IF;
    IF OLD."id" <> NEW."id" OR OLD."projectId" <> NEW."projectId" OR OLD."repositorySyncRunId" <> NEW."repositorySyncRunId"
       OR OLD."title" <> NEW."title" OR OLD."summary" <> NEW."summary" OR OLD."evidenceSnapshot" IS DISTINCT FROM NEW."evidenceSnapshot"
       OR OLD."evidenceFingerprint" <> NEW."evidenceFingerprint" OR OLD."createdAt" <> NEW."createdAt"
       OR OLD."status" <> 'proposed' OR NEW."status" NOT IN ('acknowledged', 'dismissed')
       OR OLD."decidedAt" IS NOT NULL OR OLD."decidedById" IS NOT NULL OR NEW."decidedAt" IS NULL OR NEW."decidedById" IS NULL THEN
        RAISE EXCEPTION 'invalid project plan impact transition' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER "ProjectPlanImpactSuggestion_guard" BEFORE UPDATE OR DELETE ON "ProjectPlanImpactSuggestion" FOR EACH ROW EXECUTE FUNCTION "project_plan_impact_suggestion_guard"();
