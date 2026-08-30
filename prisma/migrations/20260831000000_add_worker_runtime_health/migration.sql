CREATE TYPE "WorkerRuntimeStatus" AS ENUM ('starting', 'running', 'degraded', 'stopping');

CREATE TABLE "WorkerRuntime" (
    "name" VARCHAR(64) NOT NULL,
    "instanceIdHash" CHAR(64) NOT NULL,
    "status" "WorkerRuntimeStatus" NOT NULL DEFAULT 'starting',
    "startedAt" TIMESTAMP(3) NOT NULL,
    "heartbeatAt" TIMESTAMP(3) NOT NULL,
    "lastActionCycleAt" TIMESTAMP(3),
    "lastAutomationCycleAt" TIMESTAMP(3),
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WorkerRuntime_pkey" PRIMARY KEY ("name"),
    CONSTRAINT "WorkerRuntime_name_check" CHECK ("name" ~ '^[a-z0-9][a-z0-9._-]{2,63}$'),
    CONSTRAINT "WorkerRuntime_instance_hash_check" CHECK ("instanceIdHash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "WorkerRuntime_failures_check" CHECK ("consecutiveFailures" BETWEEN 0 AND 1000000)
);

CREATE INDEX "WorkerRuntime_status_heartbeatAt_idx" ON "WorkerRuntime"("status", "heartbeatAt");
