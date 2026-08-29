CREATE TYPE "AutomationRuleKind" AS ENUM ('repository_sync', 'memory_quality', 'memory_index', 'project_brief', 'web_source_sync');
CREATE TYPE "AutomationRuleStatus" AS ENUM ('active', 'paused');
CREATE TYPE "AutomationRunStatus" AS ENUM ('queued', 'running', 'waiting_consent', 'succeeded', 'failed', 'skipped');
CREATE TYPE "NotificationKind" AS ENUM ('automation_succeeded', 'automation_failed', 'consent_required', 'memory_quality', 'system');
CREATE TYPE "NotificationSeverity" AS ENUM ('info', 'success', 'warning', 'error');

CREATE TABLE "AutomationRule" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "kind" "AutomationRuleKind" NOT NULL,
    "status" "AutomationRuleStatus" NOT NULL DEFAULT 'active',
    "intervalMinutes" INTEGER NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "nextRunAt" TIMESTAMP(3) NOT NULL,
    "lastRunAt" TIMESTAMP(3),
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AutomationRule_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AutomationRule_interval_check" CHECK ("intervalMinutes" BETWEEN 5 AND 43200),
    CONSTRAINT "AutomationRule_failures_check" CHECK ("consecutiveFailures" >= 0),
    CONSTRAINT "AutomationRule_config_check" CHECK (jsonb_typeof("config") = 'object')
);

CREATE TABLE "AutomationRun" (
    "id" UUID NOT NULL,
    "automationRuleId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "status" "AutomationRunStatus" NOT NULL DEFAULT 'queued',
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "workerId" VARCHAR(128),
    "leaseExpiresAt" TIMESTAMP(3),
    "jobIds" JSONB NOT NULL DEFAULT '[]',
    "result" JSONB,
    "failureCode" VARCHAR(64),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AutomationRun_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AutomationRun_job_ids_check" CHECK (jsonb_typeof("jobIds") = 'array'),
    CONSTRAINT "AutomationRun_state_check" CHECK (
        ("status" = 'queued' AND "workerId" IS NULL AND "leaseExpiresAt" IS NULL AND "startedAt" IS NULL AND "completedAt" IS NULL)
        OR ("status" = 'running' AND "workerId" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL AND "startedAt" IS NOT NULL AND "completedAt" IS NULL)
        OR ("status" IN ('waiting_consent', 'succeeded', 'failed', 'skipped') AND "completedAt" IS NOT NULL)
    )
);

CREATE TABLE "Notification" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "projectId" UUID,
    "kind" "NotificationKind" NOT NULL,
    "severity" "NotificationSeverity" NOT NULL DEFAULT 'info',
    "title" VARCHAR(160) NOT NULL,
    "body" TEXT NOT NULL,
    "actionHref" VARCHAR(1024),
    "dedupeKey" CHAR(64) NOT NULL,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Notification_action_href_check" CHECK ("actionHref" IS NULL OR "actionHref" ~ '^/[A-Za-z0-9/_?=&.-]{1,1023}$')
);

CREATE UNIQUE INDEX "AutomationRule_projectId_id_key" ON "AutomationRule"("projectId", "id");
CREATE UNIQUE INDEX "AutomationRule_projectId_name_key" ON "AutomationRule"("projectId", "name");
CREATE INDEX "AutomationRule_status_nextRunAt_idx" ON "AutomationRule"("status", "nextRunAt");
CREATE INDEX "AutomationRule_projectId_kind_status_idx" ON "AutomationRule"("projectId", "kind", "status");
CREATE UNIQUE INDEX "AutomationRun_automationRuleId_scheduledFor_key" ON "AutomationRun"("automationRuleId", "scheduledFor");
CREATE INDEX "AutomationRun_status_leaseExpiresAt_idx" ON "AutomationRun"("status", "leaseExpiresAt");
CREATE INDEX "AutomationRun_projectId_createdAt_idx" ON "AutomationRun"("projectId", "createdAt");
CREATE UNIQUE INDEX "Notification_userId_dedupeKey_key" ON "Notification"("userId", "dedupeKey");
CREATE INDEX "Notification_userId_readAt_createdAt_idx" ON "Notification"("userId", "readAt", "createdAt");
CREATE INDEX "Notification_projectId_createdAt_idx" ON "Notification"("projectId", "createdAt");

ALTER TABLE "AutomationRule" ADD CONSTRAINT "AutomationRule_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AutomationRule" ADD CONSTRAINT "AutomationRule_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "AutomationRun" ADD CONSTRAINT "AutomationRun_rule_fkey" FOREIGN KEY ("projectId", "automationRuleId") REFERENCES "AutomationRule"("projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AutomationRun" ADD CONSTRAINT "AutomationRun_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AppUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
