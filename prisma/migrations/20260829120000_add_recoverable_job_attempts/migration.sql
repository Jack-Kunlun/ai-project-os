-- Add recoverable, auditable execution attempts. Requests that were running
-- before this schema existed have no claim token or attempt to reconcile, so
-- they must be made explicitly unknown rather than being resumed or retried.
ALTER TYPE "BackgroundJobStatus" ADD VALUE IF NOT EXISTS 'waitingConsent';
ALTER TYPE "BackgroundJobStatus" ADD VALUE IF NOT EXISTS 'unknown';

CREATE TYPE "BackgroundJobAttemptStatus" AS ENUM (
    'running',
    'succeeded',
    'failed',
    'unknown',
    'cancelled'
);

CREATE TYPE "BackgroundJobAttemptDispatchState" AS ENUM (
    'pending',
    'dispatched',
    'acknowledged'
);

ALTER TABLE "BackgroundJob"
ADD COLUMN "reconciliationRequired" BOOLEAN NOT NULL DEFAULT false;

-- Close provider audits belonging to requests that will be quarantined below;
-- an old running request has no safe claim token and must not remain active.
UPDATE "ProviderCallAudit" AS audit
SET
    "status" = 'unknown',
    "safeErrorCode" = 'RECONCILIATION_REQUIRED',
    "completedAt" = COALESCE("completedAt", CURRENT_TIMESTAMP)
WHERE audit."status" = 'running'
  AND EXISTS (
    SELECT 1
    FROM "BackgroundJob" AS job
    WHERE job."id" = audit."jobId"
      AND job."status" = 'running'
);

UPDATE "BackgroundJob"
SET
    "status" = 'unknown',
    "stage" = 'reconciliation_required',
    "failureCode" = 'RECONCILIATION_REQUIRED',
    "reconciliationRequired" = true,
    "completedAt" = COALESCE("completedAt", CURRENT_TIMESTAMP)
WHERE "status" = 'running';

CREATE TABLE "BackgroundJobAttempt" (
    "id" UUID NOT NULL,
    "jobId" UUID NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "status" "BackgroundJobAttemptStatus" NOT NULL DEFAULT 'running',
    "leaseTokenHash" CHAR(64) NOT NULL,
    "leasedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseExpiresAt" TIMESTAMP(3) NOT NULL,
    "heartbeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatchState" "BackgroundJobAttemptDispatchState" NOT NULL DEFAULT 'pending',
    "safeFailureCode" VARCHAR(64),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "BackgroundJobAttempt_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "BackgroundJobAttempt_lease_token_hash_check" CHECK ("leaseTokenHash" ~ '^[a-f0-9]{64}$'),
    CONSTRAINT "BackgroundJobAttempt_number_check" CHECK ("attemptNumber" > 0),
    CONSTRAINT "BackgroundJobAttempt_lease_window_check" CHECK ("leaseExpiresAt" >= "leasedAt")
);

CREATE UNIQUE INDEX "BackgroundJobAttempt_jobId_attemptNumber_key"
ON "BackgroundJobAttempt"("jobId", "attemptNumber");
CREATE INDEX "BackgroundJobAttempt_jobId_status_leaseExpiresAt_idx"
ON "BackgroundJobAttempt"("jobId", "status", "leaseExpiresAt");
CREATE INDEX "BackgroundJobAttempt_leaseExpiresAt_status_idx"
ON "BackgroundJobAttempt"("leaseExpiresAt", "status");

ALTER TABLE "BackgroundJobAttempt"
ADD CONSTRAINT "BackgroundJobAttempt_jobId_fkey"
FOREIGN KEY ("jobId") REFERENCES "BackgroundJob"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
