-- Additive AI runtime governance schema.
-- This migration intentionally does not enable provider access or alter V0 tables.

-- CreateEnum
CREATE TYPE "ModelProcessingGrantSourceKind" AS ENUM ('manual_text');

-- CreateEnum
CREATE TYPE "ModelProcessingGrantStatus" AS ENUM ('draft', 'issued', 'revoked');

-- CreateEnum
CREATE TYPE "ModelProcessingGrantRevocationReasonCode" AS ENUM (
    'userRequested',
    'policyChanged',
    'expired',
    'scannerFinding',
    'budgetExceeded',
    'securityReview'
);

-- CreateEnum
CREATE TYPE "AiOperation" AS ENUM (
    'embedding',
    'autoExtract',
    'sourceSummary',
    'projectAnalysis',
    'generateWithContext'
);

-- CreateEnum
CREATE TYPE "AiRunStatus" AS ENUM ('queued', 'running', 'succeeded', 'failed', 'unknown', 'cancelled');

-- CreateEnum
CREATE TYPE "AiRunAttemptStatus" AS ENUM ('sent', 'succeeded', 'failed', 'unknown', 'cancelled');

-- CreateEnum
CREATE TYPE "AiBudgetProfile" AS ENUM ('standard');

-- CreateEnum
CREATE TYPE "AiBudgetStatus" AS ENUM ('pending', 'allowed', 'exhausted', 'exceeded', 'rejected');

-- CreateEnum
CREATE TYPE "AiSafeScanResult" AS ENUM ('passed', 'blocked', 'unavailable');

-- CreateEnum
CREATE TYPE "AiAuditEventType" AS ENUM (
    'policyCreated',
    'policyAdvanced',
    'grantIssued',
    'grantRevoked',
    'preflightRejected',
    'scannerRejected',
    'budgetRejected',
    'runCreated',
    'runClaimed',
    'dispatchSent',
    'runSucceeded',
    'runFailed',
    'runUnknown',
    'runCancelled',
    'attemptSucceeded',
    'attemptFailed',
    'attemptUnknown',
    'attemptCancelled'
);

-- CreateEnum
CREATE TYPE "AiSafeErrorCode" AS ENUM (
    'AI_DISABLED',
    'AI_PROVIDER_DISABLED',
    'AI_INVALID_OPERATION_KEY_INPUT',
    'AI_INVALID_STATE_TRANSITION',
    'AI_REDISPATCH_FORBIDDEN',
    'AI_PROVIDER_INCOMPLETE',
    'AI_PROVIDER_UNKNOWN',
    'AI_PROVIDER_FAILED',
    'AI_PROVIDER_CANCELLED',
    'AI_DISPATCH_NOT_SENT',
    'AI_POLICY_DENIED',
    'AI_GRANT_DENIED',
    'AI_SCANNER_DENIED',
    'AI_BUDGET_DENIED',
    'AI_INVALID_PROVIDER_RESPONSE',
    'SOURCE_IN_USE'
);

-- CreateTable
CREATE TABLE "ProjectAiPolicyRevision" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "policyFingerprint" VARCHAR(64) NOT NULL,
    "outboundEnabled" BOOLEAN NOT NULL DEFAULT false,
    "embeddingEnabled" BOOLEAN NOT NULL DEFAULT false,
    "autoExtractEnabled" BOOLEAN NOT NULL DEFAULT false,
    "sourceSummaryEnabled" BOOLEAN NOT NULL DEFAULT false,
    "projectAnalysisEnabled" BOOLEAN NOT NULL DEFAULT false,
    "generateWithContextEnabled" BOOLEAN NOT NULL DEFAULT false,
    "profileFingerprint" VARCHAR(64) NOT NULL,
    "processorFingerprint" VARCHAR(64) NOT NULL,
    "regionFingerprint" VARCHAR(64) NOT NULL,
    "retentionFingerprint" VARCHAR(64) NOT NULL,
    "endpointFingerprint" VARCHAR(64) NOT NULL,
    "budgetFingerprint" VARCHAR(64) NOT NULL,
    "scannerFingerprint" VARCHAR(64) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectAiPolicyRevision_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ProjectAiPolicyRevision_revision_check" CHECK ("revision" > 0),
    CONSTRAINT "ProjectAiPolicyRevision_fingerprints_check" CHECK (
        "policyFingerprint" ~ '^[0-9a-f]{64}$'
        AND "profileFingerprint" ~ '^[0-9a-f]{64}$'
        AND "processorFingerprint" ~ '^[0-9a-f]{64}$'
        AND "regionFingerprint" ~ '^[0-9a-f]{64}$'
        AND "retentionFingerprint" ~ '^[0-9a-f]{64}$'
        AND "endpointFingerprint" ~ '^[0-9a-f]{64}$'
        AND "budgetFingerprint" ~ '^[0-9a-f]{64}$'
        AND "scannerFingerprint" ~ '^[0-9a-f]{64}$'
    )
);

-- CreateTable
CREATE TABLE "ProjectAiPolicy" (
    "projectId" UUID NOT NULL,
    "currentRevisionId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectAiPolicy_pkey" PRIMARY KEY ("projectId")
);

-- CreateTable
CREATE TABLE "ModelProcessingGrant" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "sourceKind" "ModelProcessingGrantSourceKind" NOT NULL DEFAULT 'manual_text',
    "status" "ModelProcessingGrantStatus" NOT NULL DEFAULT 'draft',
    "policyRevisionId" UUID NOT NULL,
    "profileFingerprint" VARCHAR(64) NOT NULL,
    "providerFingerprint" VARCHAR(64) NOT NULL,
    "modelFingerprint" VARCHAR(64) NOT NULL,
    "modelId" VARCHAR(128) NOT NULL,
    "processorFingerprint" VARCHAR(64) NOT NULL,
    "regionFingerprint" VARCHAR(64) NOT NULL,
    "retentionFingerprint" VARCHAR(64) NOT NULL,
    "endpointFingerprint" VARCHAR(64) NOT NULL,
    "grantFingerprint" VARCHAR(64) NOT NULL,
    "effectivePolicyVersion" INTEGER NOT NULL,
    "budgetFingerprint" VARCHAR(64) NOT NULL,
    "scannerFingerprint" VARCHAR(64) NOT NULL,
    "scannerVersion" VARCHAR(64) NOT NULL,
    "budgetProfile" "AiBudgetProfile" NOT NULL,
    "issuedBy" VARCHAR(128) NOT NULL,
    "purposeCode" VARCHAR(64) NOT NULL,
    "issuedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revocationReasonCode" "ModelProcessingGrantRevocationReasonCode",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModelProcessingGrant_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ModelProcessingGrant_effectivePolicyVersion_check" CHECK ("effectivePolicyVersion" > 0),
    CONSTRAINT "ModelProcessingGrant_fingerprints_check" CHECK (
        "profileFingerprint" ~ '^[0-9a-f]{64}$'
        AND "providerFingerprint" ~ '^[0-9a-f]{64}$'
        AND "modelFingerprint" ~ '^[0-9a-f]{64}$'
        AND "processorFingerprint" ~ '^[0-9a-f]{64}$'
        AND "regionFingerprint" ~ '^[0-9a-f]{64}$'
        AND "retentionFingerprint" ~ '^[0-9a-f]{64}$'
        AND "endpointFingerprint" ~ '^[0-9a-f]{64}$'
        AND "grantFingerprint" ~ '^[0-9a-f]{64}$'
        AND "budgetFingerprint" ~ '^[0-9a-f]{64}$'
        AND "scannerFingerprint" ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT "ModelProcessingGrant_modelId_check" CHECK (
        "modelId" ~ '^[A-Za-z0-9._:/@-]{1,128}$'
        AND "modelId" !~* '(https?://|api[-_]?key|bearer|password|secret|token|sk-)'
        AND "modelId" !~* '(^|[/:@_-])latest($|[/:@_-])'
    ),
    CONSTRAINT "ModelProcessingGrant_scannerVersion_check" CHECK ("scannerVersion" ~ '^[A-Za-z0-9._:-]{1,64}$'),
    CONSTRAINT "ModelProcessingGrant_issuedBy_check" CHECK (
        "issuedBy" ~ '^[A-Za-z0-9._:-]{1,128}$'
        AND "issuedBy" !~* '(https?://|api[-_]?key|bearer|password|secret|token|sk-)'
    ),
    CONSTRAINT "ModelProcessingGrant_purposeCode_check" CHECK (
        "purposeCode" ~ '^[A-Za-z0-9._:-]{1,64}$'
        AND "purposeCode" !~* '(https?://|api[-_]?key|bearer|password|secret|token|sk-)'
    ),
    CONSTRAINT "ModelProcessingGrant_lifecycle_check" CHECK (
        ("status" = 'draft'
            AND "issuedAt" IS NULL
            AND "expiresAt" IS NULL
            AND "revokedAt" IS NULL
            AND "revocationReasonCode" IS NULL)
        OR ("status" = 'issued'
            AND "issuedAt" IS NOT NULL
            AND "expiresAt" IS NOT NULL
            AND "expiresAt" > "issuedAt"
            AND "revokedAt" IS NULL
            AND "revocationReasonCode" IS NULL)
        OR ("status" = 'revoked'
            AND "issuedAt" IS NOT NULL
            AND "expiresAt" IS NOT NULL
            AND "expiresAt" > "issuedAt"
            AND "revokedAt" IS NOT NULL
            AND "revokedAt" >= "issuedAt"
            AND "revocationReasonCode" IS NOT NULL)
    )
);

-- CreateTable
CREATE TABLE "ModelProcessingGrantSource" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "grantId" UUID NOT NULL,
    "sourceId" UUID NOT NULL,
    "contentFingerprint" VARCHAR(64) NOT NULL,
    "contentBytes" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModelProcessingGrantSource_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ModelProcessingGrantSource_contentFingerprint_check" CHECK ("contentFingerprint" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "ModelProcessingGrantSource_contentBytes_check" CHECK ("contentBytes" >= 0)
);

-- CreateTable
CREATE TABLE "ModelProcessingGrantOperation" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "grantId" UUID NOT NULL,
    "operation" "AiOperation" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModelProcessingGrantOperation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiRun" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "grantId" UUID NOT NULL,
    "policyRevisionId" UUID NOT NULL,
    "operation" "AiOperation" NOT NULL,
    "operationKey" VARCHAR(64) NOT NULL,
    "operationKeySchemaVersion" VARCHAR(32) NOT NULL,
    "inputManifestFingerprint" VARCHAR(64) NOT NULL,
    "promptFingerprint" VARCHAR(64) NOT NULL,
    "promptVersion" VARCHAR(128) NOT NULL,
    "providerFingerprint" VARCHAR(64) NOT NULL,
    "modelId" VARCHAR(128) NOT NULL,
    "modelFingerprint" VARCHAR(64) NOT NULL,
    "profileFingerprint" VARCHAR(64) NOT NULL,
    "grantFingerprint" VARCHAR(64) NOT NULL,
    "effectivePolicyVersion" INTEGER NOT NULL,
    "processorFingerprint" VARCHAR(64) NOT NULL,
    "processorEndpointFingerprint" VARCHAR(64) NOT NULL,
    "processorRegionFingerprint" VARCHAR(64) NOT NULL,
    "processorRetentionFingerprint" VARCHAR(64) NOT NULL,
    "noRagSnapshotMarker" VARCHAR(32) NOT NULL,
    "status" "AiRunStatus" NOT NULL DEFAULT 'queued',
    "inputBytes" INTEGER NOT NULL DEFAULT 0,
    "outputBytes" INTEGER NOT NULL DEFAULT 0,
    "maxInputTokens" INTEGER NOT NULL DEFAULT 0,
    "maxOutputTokens" INTEGER NOT NULL DEFAULT 0,
    "maxRequests" INTEGER NOT NULL DEFAULT 1,
    "maxBudgetMicros" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "requestCount" INTEGER NOT NULL DEFAULT 0,
    "budgetUsedMicros" INTEGER NOT NULL DEFAULT 0,
    "pricingSnapshotId" VARCHAR(128),
    "budgetStatus" "AiBudgetStatus" NOT NULL,
    "safeErrorCode" "AiSafeErrorCode",
    "httpStatus" INTEGER,
    "providerRequestId" VARCHAR(512),
    "providerResponseId" VARCHAR(512),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "AiRun_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AiRun_operationKey_check" CHECK ("operationKey" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "AiRun_operationKeySchemaVersion_check" CHECK ("operationKeySchemaVersion" = 'ai-operation-key:v1'),
    CONSTRAINT "AiRun_fingerprints_check" CHECK (
        "inputManifestFingerprint" ~ '^[0-9a-f]{64}$'
        AND "promptFingerprint" ~ '^[0-9a-f]{64}$'
        AND "providerFingerprint" ~ '^[0-9a-f]{64}$'
        AND "modelFingerprint" ~ '^[0-9a-f]{64}$'
        AND "profileFingerprint" ~ '^[0-9a-f]{64}$'
        AND "grantFingerprint" ~ '^[0-9a-f]{64}$'
        AND "processorFingerprint" ~ '^[0-9a-f]{64}$'
        AND "processorEndpointFingerprint" ~ '^[0-9a-f]{64}$'
        AND "processorRegionFingerprint" ~ '^[0-9a-f]{64}$'
        AND "processorRetentionFingerprint" ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT "AiRun_promptVersion_check" CHECK ("promptVersion" ~ '^[A-Za-z0-9._:-]{1,128}$'),
    CONSTRAINT "AiRun_noRagSnapshotMarker_check" CHECK ("noRagSnapshotMarker" = 'no-rag-snapshot:v1'),
    CONSTRAINT "AiRun_modelId_check" CHECK (
        "modelId" ~ '^[A-Za-z0-9._:/@-]{1,128}$'
        AND "modelId" !~* '(https?://|api[-_]?key|bearer|password|secret|token|sk-)'
        AND "modelId" !~* '(^|[/:@_-])latest($|[/:@_-])'
    ),
    CONSTRAINT "AiRun_effectivePolicyVersion_check" CHECK ("effectivePolicyVersion" > 0),
    CONSTRAINT "AiRun_inputBytes_check" CHECK ("inputBytes" >= 0),
    CONSTRAINT "AiRun_outputBytes_check" CHECK ("outputBytes" >= 0),
    CONSTRAINT "AiRun_maxInputTokens_check" CHECK ("maxInputTokens" >= 0),
    CONSTRAINT "AiRun_maxOutputTokens_check" CHECK ("maxOutputTokens" >= 0),
    CONSTRAINT "AiRun_maxRequests_check" CHECK ("maxRequests" > 0),
    CONSTRAINT "AiRun_maxBudgetMicros_check" CHECK ("maxBudgetMicros" >= 0),
    CONSTRAINT "AiRun_inputTokens_check" CHECK ("inputTokens" >= 0 AND "inputTokens" <= "maxInputTokens"),
    CONSTRAINT "AiRun_outputTokens_check" CHECK ("outputTokens" >= 0 AND "outputTokens" <= "maxOutputTokens"),
    CONSTRAINT "AiRun_requestCount_check" CHECK ("requestCount" >= 0 AND "requestCount" <= "maxRequests"),
    CONSTRAINT "AiRun_budgetUsedMicros_check" CHECK ("budgetUsedMicros" >= 0 AND "budgetUsedMicros" <= "maxBudgetMicros"),
    CONSTRAINT "AiRun_pricingSnapshotId_check" CHECK (
        "pricingSnapshotId" IS NULL
        OR ("pricingSnapshotId" ~ '^[A-Za-z0-9._:-]{1,128}$' AND "pricingSnapshotId" !~* '(https?://|secret|token|api[-_]?key)')
    ),
    CONSTRAINT "AiRun_providerRequestId_check" CHECK (
        "providerRequestId" IS NULL
        OR (char_length("providerRequestId") BETWEEN 1 AND 512
            AND "providerRequestId" ~ '^[A-Za-z0-9._:-]+$'
            AND "providerRequestId" !~* '(https?://|secret|token|api[-_]?key|sk-)')
    ),
    CONSTRAINT "AiRun_providerResponseId_check" CHECK (
        "providerResponseId" IS NULL
        OR (char_length("providerResponseId") BETWEEN 1 AND 512
            AND "providerResponseId" ~ '^[A-Za-z0-9._:-]+$'
            AND "providerResponseId" !~* '(https?://|secret|token|api[-_]?key|sk-)')
    ),
    CONSTRAINT "AiRun_httpStatus_check" CHECK ("httpStatus" IS NULL OR "httpStatus" BETWEEN 100 AND 599),
    CONSTRAINT "AiRun_claimedAt_check" CHECK ("claimedAt" IS NULL OR "claimedAt" >= "createdAt"),
    CONSTRAINT "AiRun_sentAt_check" CHECK ("sentAt" IS NULL OR ("claimedAt" IS NOT NULL AND "sentAt" >= "claimedAt")),
    CONSTRAINT "AiRun_completedAt_check" CHECK (
        "completedAt" IS NULL
        OR ("completedAt" >= "createdAt" AND ("sentAt" IS NULL OR "completedAt" >= "sentAt"))
    ),
    CONSTRAINT "AiRun_status_timestamps_check" CHECK (
        ("status" = 'queued'
            AND "claimedAt" IS NULL
            AND "sentAt" IS NULL
            AND "completedAt" IS NULL
            AND "requestCount" = 0)
        OR ("status" = 'running'
            AND "claimedAt" IS NOT NULL
            AND "sentAt" IS NOT NULL
            AND "completedAt" IS NULL
            AND "requestCount" >= 1)
        OR ("status" IN ('succeeded', 'unknown')
            AND "claimedAt" IS NOT NULL
            AND "sentAt" IS NOT NULL
            AND "completedAt" IS NOT NULL
            AND "requestCount" >= 1)
        OR ("status" IN ('failed', 'cancelled')
            AND "completedAt" IS NOT NULL
            AND (("claimedAt" IS NULL AND "sentAt" IS NULL AND "requestCount" = 0)
                OR ("claimedAt" IS NOT NULL AND "sentAt" IS NOT NULL AND "requestCount" >= 1)))
    )
);

-- CreateTable
CREATE TABLE "AiRunAttempt" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "aiRunId" UUID NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "dispatchToken" VARCHAR(128) NOT NULL,
    "status" "AiRunAttemptStatus" NOT NULL DEFAULT 'sent',
    "providerRequestId" VARCHAR(512),
    "providerResponseId" VARCHAR(512),
    "httpStatus" INTEGER,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "requestCount" INTEGER NOT NULL DEFAULT 1,
    "safeErrorCode" "AiSafeErrorCode",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "AiRunAttempt_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AiRunAttempt_attemptNumber_check" CHECK ("attemptNumber" > 0),
    CONSTRAINT "AiRunAttempt_dispatchToken_check" CHECK (
        "dispatchToken" ~ '^[A-Za-z0-9._:-]{16,128}$'
        AND "dispatchToken" !~* '(https?://|secret|token|api[-_]?key|sk-)'
    ),
    CONSTRAINT "AiRunAttempt_providerRequestId_check" CHECK (
        "providerRequestId" IS NULL
        OR (char_length("providerRequestId") BETWEEN 1 AND 512
            AND "providerRequestId" ~ '^[A-Za-z0-9._:-]+$'
            AND "providerRequestId" !~* '(https?://|secret|token|api[-_]?key|sk-)')
    ),
    CONSTRAINT "AiRunAttempt_providerResponseId_check" CHECK (
        "providerResponseId" IS NULL
        OR (char_length("providerResponseId") BETWEEN 1 AND 512
            AND "providerResponseId" ~ '^[A-Za-z0-9._:-]+$'
            AND "providerResponseId" !~* '(https?://|secret|token|api[-_]?key|sk-)')
    ),
    CONSTRAINT "AiRunAttempt_httpStatus_check" CHECK ("httpStatus" IS NULL OR "httpStatus" BETWEEN 100 AND 599),
    CONSTRAINT "AiRunAttempt_inputTokens_check" CHECK ("inputTokens" >= 0),
    CONSTRAINT "AiRunAttempt_outputTokens_check" CHECK ("outputTokens" >= 0),
    CONSTRAINT "AiRunAttempt_requestCount_check" CHECK ("requestCount" = 1),
    CONSTRAINT "AiRunAttempt_sentAt_check" CHECK ("sentAt" >= "createdAt"),
    CONSTRAINT "AiRunAttempt_completedAt_check" CHECK ("completedAt" IS NULL OR "completedAt" >= "sentAt"),
    CONSTRAINT "AiRunAttempt_status_timestamps_check" CHECK (
        ("status" = 'sent' AND "completedAt" IS NULL)
        OR ("status" IN ('succeeded', 'failed', 'unknown', 'cancelled') AND "completedAt" IS NOT NULL)
    )
);

-- CreateTable
CREATE TABLE "AiRunInputSource" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "aiRunId" UUID NOT NULL,
    "grantId" UUID NOT NULL,
    "sourceId" UUID NOT NULL,
    "contentFingerprint" VARCHAR(64) NOT NULL,
    "contentBytes" INTEGER NOT NULL,
    "scannerVersion" VARCHAR(64) NOT NULL,
    "safeScanResult" "AiSafeScanResult" NOT NULL,
    "evidenceManifestFingerprint" VARCHAR(64) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiRunInputSource_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AiRunInputSource_contentFingerprint_check" CHECK ("contentFingerprint" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "AiRunInputSource_contentBytes_check" CHECK ("contentBytes" >= 0),
    CONSTRAINT "AiRunInputSource_scannerVersion_check" CHECK ("scannerVersion" ~ '^[A-Za-z0-9._:-]{1,64}$'),
    CONSTRAINT "AiRunInputSource_evidenceManifestFingerprint_check" CHECK ("evidenceManifestFingerprint" ~ '^[0-9a-f]{64}$')
);

-- CreateTable
CREATE TABLE "AiAuditEvent" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "policyRevisionId" UUID NOT NULL,
    "eventType" "AiAuditEventType" NOT NULL,
    "safeCode" "AiSafeErrorCode",
    "eventFingerprint" VARCHAR(64),
    "fingerprintCount" INTEGER,
    "byteCount" INTEGER,
    "tokenCount" INTEGER,
    "requestCount" INTEGER,
    "httpStatus" INTEGER,
    "grantId" UUID,
    "aiRunId" UUID,
    "attemptId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiAuditEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AiAuditEvent_eventFingerprint_check" CHECK ("eventFingerprint" IS NULL OR "eventFingerprint" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "AiAuditEvent_counts_check" CHECK (
        ("fingerprintCount" IS NULL OR "fingerprintCount" >= 0)
        AND ("byteCount" IS NULL OR "byteCount" >= 0)
        AND ("tokenCount" IS NULL OR "tokenCount" >= 0)
        AND ("requestCount" IS NULL OR "requestCount" >= 0)
    ),
    CONSTRAINT "AiAuditEvent_httpStatus_check" CHECK ("httpStatus" IS NULL OR "httpStatus" BETWEEN 100 AND 599),
    CONSTRAINT "AiAuditEvent_subjects_check" CHECK (
        "policyRevisionId" IS NOT NULL
        AND CASE
            WHEN "eventType" IN ('policyCreated', 'policyAdvanced')
                THEN "grantId" IS NULL AND "aiRunId" IS NULL AND "attemptId" IS NULL
            WHEN "eventType" IN ('preflightRejected', 'scannerRejected', 'budgetRejected')
                THEN "aiRunId" IS NULL AND "attemptId" IS NULL
            WHEN "eventType" IN ('grantIssued', 'grantRevoked')
                THEN "grantId" IS NOT NULL AND "aiRunId" IS NULL AND "attemptId" IS NULL
            WHEN "eventType" IN ('runCreated', 'runClaimed', 'runSucceeded', 'runFailed', 'runUnknown', 'runCancelled')
                THEN "grantId" IS NOT NULL AND "aiRunId" IS NOT NULL AND "attemptId" IS NULL
            WHEN "eventType" IN ('dispatchSent', 'attemptSucceeded', 'attemptFailed', 'attemptUnknown', 'attemptCancelled')
                THEN "grantId" IS NOT NULL AND "aiRunId" IS NOT NULL AND "attemptId" IS NOT NULL
            ELSE FALSE
        END
    )
);

-- CreateIndex
CREATE UNIQUE INDEX "ProjectAiPolicyRevision_projectId_id_key" ON "ProjectAiPolicyRevision"("projectId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectAiPolicyRevision_projectId_revision_key" ON "ProjectAiPolicyRevision"("projectId", "revision");

-- CreateIndex
CREATE INDEX "ProjectAiPolicyRevision_projectId_revision_idx" ON "ProjectAiPolicyRevision"("projectId", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectAiPolicy_projectId_currentRevisionId_key" ON "ProjectAiPolicy"("projectId", "currentRevisionId");

-- CreateIndex
CREATE UNIQUE INDEX "ModelProcessingGrant_projectId_id_key" ON "ModelProcessingGrant"("projectId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ModelProcessingGrant_projectId_id_policyRevisionId_key" ON "ModelProcessingGrant"("projectId", "id", "policyRevisionId");

-- CreateIndex
CREATE INDEX "ModelProcessingGrant_projectId_expiresAt_idx" ON "ModelProcessingGrant"("projectId", "expiresAt");

-- CreateIndex
CREATE INDEX "ModelProcessingGrant_projectId_revokedAt_idx" ON "ModelProcessingGrant"("projectId", "revokedAt");

CREATE INDEX "ModelProcessingGrant_projectId_status_idx" ON "ModelProcessingGrant"("projectId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ModelProcessingGrantSource_projectId_id_key" ON "ModelProcessingGrantSource"("projectId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ModelProcessingGrantSource_projectId_grantId_sourceId_key" ON "ModelProcessingGrantSource"("projectId", "grantId", "sourceId");

-- CreateIndex
CREATE INDEX "ModelProcessingGrantSource_projectId_sourceId_idx" ON "ModelProcessingGrantSource"("projectId", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "ModelProcessingGrantOperation_projectId_id_key" ON "ModelProcessingGrantOperation"("projectId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ModelProcessingGrantOperation_projectId_grantId_operation_key" ON "ModelProcessingGrantOperation"("projectId", "grantId", "operation");

-- CreateIndex
CREATE INDEX "ModelProcessingGrantOperation_projectId_operation_idx" ON "ModelProcessingGrantOperation"("projectId", "operation");

-- CreateIndex
CREATE UNIQUE INDEX "AiRun_projectId_id_key" ON "AiRun"("projectId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "AiRun_projectId_id_grantId_key" ON "AiRun"("projectId", "id", "grantId");

CREATE UNIQUE INDEX "AiRun_projectId_id_grantId_policyRevisionId_key" ON "AiRun"("projectId", "id", "grantId", "policyRevisionId");

-- CreateIndex
CREATE UNIQUE INDEX "AiRun_projectId_operationKey_key" ON "AiRun"("projectId", "operationKey");

-- CreateIndex
CREATE INDEX "AiRun_projectId_status_idx" ON "AiRun"("projectId", "status");

-- CreateIndex
CREATE INDEX "AiRun_projectId_createdAt_idx" ON "AiRun"("projectId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AiRunAttempt_dispatchToken_key" ON "AiRunAttempt"("dispatchToken");

-- CreateIndex
CREATE UNIQUE INDEX "AiRunAttempt_projectId_id_key" ON "AiRunAttempt"("projectId", "id");

CREATE UNIQUE INDEX "AiRunAttempt_projectId_id_aiRunId_key" ON "AiRunAttempt"("projectId", "id", "aiRunId");

-- CreateIndex
CREATE UNIQUE INDEX "AiRunAttempt_projectId_aiRunId_attemptNumber_key" ON "AiRunAttempt"("projectId", "aiRunId", "attemptNumber");

-- CreateIndex
CREATE INDEX "AiRunAttempt_projectId_aiRunId_status_idx" ON "AiRunAttempt"("projectId", "aiRunId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AiRunInputSource_projectId_id_key" ON "AiRunInputSource"("projectId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "AiRunInputSource_projectId_aiRunId_sourceId_key" ON "AiRunInputSource"("projectId", "aiRunId", "sourceId");

-- CreateIndex
CREATE INDEX "AiRunInputSource_projectId_sourceId_idx" ON "AiRunInputSource"("projectId", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "AiAuditEvent_projectId_id_key" ON "AiAuditEvent"("projectId", "id");

CREATE INDEX "AiAuditEvent_projectId_policyRevisionId_idx" ON "AiAuditEvent"("projectId", "policyRevisionId");

-- CreateIndex
CREATE INDEX "AiAuditEvent_projectId_eventType_createdAt_idx" ON "AiAuditEvent"("projectId", "eventType", "createdAt");

-- CreateIndex
CREATE INDEX "AiAuditEvent_projectId_grantId_idx" ON "AiAuditEvent"("projectId", "grantId");

-- CreateIndex
CREATE INDEX "AiAuditEvent_projectId_aiRunId_idx" ON "AiAuditEvent"("projectId", "aiRunId");

-- CreateIndex
CREATE INDEX "AiAuditEvent_projectId_attemptId_idx" ON "AiAuditEvent"("projectId", "attemptId");

-- AddForeignKey
ALTER TABLE "ProjectAiPolicyRevision" ADD CONSTRAINT "ProjectAiPolicyRevision_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectAiPolicy" ADD CONSTRAINT "ProjectAiPolicy_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectAiPolicy" ADD CONSTRAINT "ProjectAiPolicy_projectId_currentRevisionId_fkey" FOREIGN KEY ("projectId", "currentRevisionId") REFERENCES "ProjectAiPolicyRevision"("projectId", "id") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "ModelProcessingGrant" ADD CONSTRAINT "ModelProcessingGrant_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModelProcessingGrant" ADD CONSTRAINT "ModelProcessingGrant_projectId_policyRevisionId_fkey" FOREIGN KEY ("projectId", "policyRevisionId") REFERENCES "ProjectAiPolicyRevision"("projectId", "id") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "ModelProcessingGrantSource" ADD CONSTRAINT "ModelProcessingGrantSource_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModelProcessingGrantSource" ADD CONSTRAINT "ModelProcessingGrantSource_projectId_grantId_fkey" FOREIGN KEY ("projectId", "grantId") REFERENCES "ModelProcessingGrant"("projectId", "id") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "ModelProcessingGrantSource" ADD CONSTRAINT "ModelProcessingGrantSource_projectId_sourceId_fkey" FOREIGN KEY ("projectId", "sourceId") REFERENCES "ProjectSource"("projectId", "id") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "ModelProcessingGrantOperation" ADD CONSTRAINT "ModelProcessingGrantOperation_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModelProcessingGrantOperation" ADD CONSTRAINT "ModelProcessingGrantOperation_projectId_grantId_fkey" FOREIGN KEY ("projectId", "grantId") REFERENCES "ModelProcessingGrant"("projectId", "id") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "AiRun" ADD CONSTRAINT "AiRun_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiRun" ADD CONSTRAINT "AiRun_projectId_grantId_policyRevisionId_fkey" FOREIGN KEY ("projectId", "grantId", "policyRevisionId") REFERENCES "ModelProcessingGrant"("projectId", "id", "policyRevisionId") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "AiRun" ADD CONSTRAINT "AiRun_projectId_policyRevisionId_fkey" FOREIGN KEY ("projectId", "policyRevisionId") REFERENCES "ProjectAiPolicyRevision"("projectId", "id") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "AiRun" ADD CONSTRAINT "AiRun_projectId_grantId_operation_fkey" FOREIGN KEY ("projectId", "grantId", "operation") REFERENCES "ModelProcessingGrantOperation"("projectId", "grantId", "operation") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "AiRunAttempt" ADD CONSTRAINT "AiRunAttempt_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiRunAttempt" ADD CONSTRAINT "AiRunAttempt_projectId_aiRunId_fkey" FOREIGN KEY ("projectId", "aiRunId") REFERENCES "AiRun"("projectId", "id") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "AiRunInputSource" ADD CONSTRAINT "AiRunInputSource_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiRunInputSource" ADD CONSTRAINT "AiRunInputSource_projectId_aiRunId_grantId_fkey" FOREIGN KEY ("projectId", "aiRunId", "grantId") REFERENCES "AiRun"("projectId", "id", "grantId") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "AiRunInputSource" ADD CONSTRAINT "AiRunInputSource_projectId_grantId_sourceId_fkey" FOREIGN KEY ("projectId", "grantId", "sourceId") REFERENCES "ModelProcessingGrantSource"("projectId", "grantId", "sourceId") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "AiRunInputSource" ADD CONSTRAINT "AiRunInputSource_projectId_sourceId_fkey" FOREIGN KEY ("projectId", "sourceId") REFERENCES "ProjectSource"("projectId", "id") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "AiAuditEvent" ADD CONSTRAINT "AiAuditEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiAuditEvent" ADD CONSTRAINT "AiAuditEvent_projectId_policyRevisionId_fkey" FOREIGN KEY ("projectId", "policyRevisionId") REFERENCES "ProjectAiPolicyRevision"("projectId", "id") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "AiAuditEvent" ADD CONSTRAINT "AiAuditEvent_projectId_grantId_policyRevisionId_fkey" FOREIGN KEY ("projectId", "grantId", "policyRevisionId") REFERENCES "ModelProcessingGrant"("projectId", "id", "policyRevisionId") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "AiAuditEvent" ADD CONSTRAINT "AiAuditEvent_projectId_aiRunId_grantId_policyRevisionId_fkey" FOREIGN KEY ("projectId", "aiRunId", "grantId", "policyRevisionId") REFERENCES "AiRun"("projectId", "id", "grantId", "policyRevisionId") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "AiAuditEvent" ADD CONSTRAINT "AiAuditEvent_projectId_attemptId_aiRunId_fkey" FOREIGN KEY ("projectId", "attemptId", "aiRunId") REFERENCES "AiRunAttempt"("projectId", "id", "aiRunId") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- Policy revisions are append-only. Direct deletion is rejected while the
-- parent Project exists; Project-root CASCADE is intentionally left for a
-- real PostgreSQL deletion-order test in the next gate.
CREATE OR REPLACE FUNCTION "ai_policy_revision_immutable_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF EXISTS (
            SELECT 1 FROM "ProjectAiPolicyRevision"
            WHERE "projectId" = NEW."projectId" AND "revision" >= NEW."revision"
        ) THEN
            RAISE EXCEPTION 'policy revision must advance' USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'policy revision is immutable' USING ERRCODE = 'check_violation';
    END IF;

    IF TG_OP = 'DELETE' THEN
        IF EXISTS (
            SELECT 1 FROM "Project"
            WHERE "id" = OLD."projectId"
        ) THEN
            RAISE EXCEPTION 'policy revision is append-only' USING ERRCODE = 'check_violation';
        END IF;
        RETURN OLD;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "ProjectAiPolicyRevision_immutable_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "ProjectAiPolicyRevision"
FOR EACH ROW EXECUTE FUNCTION "ai_policy_revision_immutable_guard"();

-- The current policy pointer may advance only to a strictly newer revision.
CREATE OR REPLACE FUNCTION "ai_policy_current_revision_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    old_revision INTEGER;
    new_revision INTEGER;
BEGIN
    IF TG_OP = 'UPDATE' AND NEW."projectId" IS DISTINCT FROM OLD."projectId" THEN
        RAISE EXCEPTION 'policy project is immutable' USING ERRCODE = 'check_violation';
    END IF;

    SELECT "revision" INTO new_revision
    FROM "ProjectAiPolicyRevision"
    WHERE "projectId" = NEW."projectId" AND "id" = NEW."currentRevisionId";

    IF new_revision IS NULL OR new_revision <= 0 THEN
        RAISE EXCEPTION 'invalid current policy revision' USING ERRCODE = 'check_violation';
    END IF;

    IF TG_OP = 'UPDATE' AND NEW."currentRevisionId" <> OLD."currentRevisionId" THEN
        SELECT "revision" INTO old_revision
        FROM "ProjectAiPolicyRevision"
        WHERE "projectId" = OLD."projectId" AND "id" = OLD."currentRevisionId";
        IF old_revision IS NULL OR new_revision <= old_revision THEN
            RAISE EXCEPTION 'policy revision must advance' USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "ProjectAiPolicy_current_revision_trigger"
BEFORE INSERT OR UPDATE ON "ProjectAiPolicy"
FOR EACH ROW EXECUTE FUNCTION "ai_policy_current_revision_guard"();

-- The current policy pointer is append-only while its Project exists. A
-- Project-root CASCADE is intentionally allowed to proceed through the
-- parent-visibility escape hatch and remains pending the PostgreSQL gate.
CREATE OR REPLACE FUNCTION "ai_policy_delete_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM "Project"
        WHERE "id" = OLD."projectId"
    ) THEN
        RAISE EXCEPTION 'policy deletion is append-only' USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
END;
$$;

CREATE TRIGGER "ProjectAiPolicy_delete_guard_trigger"
BEFORE DELETE ON "ProjectAiPolicy"
FOR EACH ROW EXECUTE FUNCTION "ai_policy_delete_guard"();

-- Keep denormalized effectivePolicyVersion snapshots tied to the immutable
-- revision they reference. This does not replace a future service CAS.
CREATE OR REPLACE FUNCTION "ai_grant_revision_snapshot_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    bound_revision INTEGER;
    bound_profile VARCHAR(64);
    bound_processor VARCHAR(64);
    bound_region VARCHAR(64);
    bound_retention VARCHAR(64);
    bound_endpoint VARCHAR(64);
    bound_budget VARCHAR(64);
    bound_scanner VARCHAR(64);
BEGIN
    SELECT
        "revision",
        "profileFingerprint",
        "processorFingerprint",
        "regionFingerprint",
        "retentionFingerprint",
        "endpointFingerprint",
        "budgetFingerprint",
        "scannerFingerprint"
    INTO
        bound_revision,
        bound_profile,
        bound_processor,
        bound_region,
        bound_retention,
        bound_endpoint,
        bound_budget,
        bound_scanner
    FROM "ProjectAiPolicyRevision"
    WHERE "projectId" = NEW."projectId" AND "id" = NEW."policyRevisionId";
    IF bound_revision IS NULL
        OR NEW."effectivePolicyVersion" IS DISTINCT FROM bound_revision
        OR NEW."profileFingerprint" IS DISTINCT FROM bound_profile
        OR NEW."processorFingerprint" IS DISTINCT FROM bound_processor
        OR NEW."regionFingerprint" IS DISTINCT FROM bound_region
        OR NEW."retentionFingerprint" IS DISTINCT FROM bound_retention
        OR NEW."endpointFingerprint" IS DISTINCT FROM bound_endpoint
        OR NEW."budgetFingerprint" IS DISTINCT FROM bound_budget
        OR NEW."scannerFingerprint" IS DISTINCT FROM bound_scanner THEN
        RAISE EXCEPTION 'grant policy revision mismatch' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "ModelProcessingGrant_revision_snapshot_trigger"
BEFORE INSERT OR UPDATE ON "ModelProcessingGrant"
FOR EACH ROW EXECUTE FUNCTION "ai_grant_revision_snapshot_guard"();

CREATE OR REPLACE FUNCTION "ai_run_revision_snapshot_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    bound_revision INTEGER;
    bound_provider VARCHAR(64);
    bound_model VARCHAR(64);
    bound_model_id VARCHAR(128);
    bound_profile VARCHAR(64);
    bound_grant VARCHAR(64);
    bound_processor VARCHAR(64);
    bound_endpoint VARCHAR(64);
    bound_region VARCHAR(64);
    bound_retention VARCHAR(64);
BEGIN
    SELECT
        r."revision",
        g."providerFingerprint",
        g."modelFingerprint",
        g."modelId",
        g."profileFingerprint",
        g."grantFingerprint",
        g."processorFingerprint",
        g."endpointFingerprint",
        g."regionFingerprint",
        g."retentionFingerprint"
    INTO
        bound_revision,
        bound_provider,
        bound_model,
        bound_model_id,
        bound_profile,
        bound_grant,
        bound_processor,
        bound_endpoint,
        bound_region,
        bound_retention
    FROM "ProjectAiPolicyRevision" AS r
    JOIN "ModelProcessingGrant" AS g
      ON g."projectId" = r."projectId"
     AND g."policyRevisionId" = r."id"
     AND g."id" = NEW."grantId"
    WHERE r."projectId" = NEW."projectId"
      AND r."id" = NEW."policyRevisionId";
    IF bound_revision IS NULL
        OR NEW."effectivePolicyVersion" IS DISTINCT FROM bound_revision
        OR NEW."providerFingerprint" IS DISTINCT FROM bound_provider
        OR NEW."modelFingerprint" IS DISTINCT FROM bound_model
        OR NEW."modelId" IS DISTINCT FROM bound_model_id
        OR NEW."profileFingerprint" IS DISTINCT FROM bound_profile
        OR NEW."grantFingerprint" IS DISTINCT FROM bound_grant
        OR NEW."processorFingerprint" IS DISTINCT FROM bound_processor
        OR NEW."processorEndpointFingerprint" IS DISTINCT FROM bound_endpoint
        OR NEW."processorRegionFingerprint" IS DISTINCT FROM bound_region
        OR NEW."processorRetentionFingerprint" IS DISTINCT FROM bound_retention THEN
        RAISE EXCEPTION 'run policy revision mismatch' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "AiRun_revision_snapshot_trigger"
BEFORE INSERT OR UPDATE ON "AiRun"
FOR EACH ROW EXECUTE FUNCTION "ai_run_revision_snapshot_guard"();

-- Grants are sealed after issuance. The Project-root cascade exception is
-- intentionally based on the parent Project visibility and awaits a real
-- PostgreSQL deletion-order test.
CREATE OR REPLACE FUNCTION "ai_grant_lifecycle_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."status" <> 'draft'
            OR NEW."issuedAt" IS NOT NULL
            OR NEW."expiresAt" IS NOT NULL
            OR NEW."revokedAt" IS NOT NULL
            OR NEW."revocationReasonCode" IS NOT NULL THEN
            RAISE EXCEPTION 'grant must start in draft' USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;

    IF NEW."id" IS DISTINCT FROM OLD."id"
        OR NEW."projectId" IS DISTINCT FROM OLD."projectId" THEN
        RAISE EXCEPTION 'grant identity is immutable' USING ERRCODE = 'check_violation';
    END IF;

    IF OLD."status" = 'draft' THEN
        IF NEW."status" = 'draft' THEN
            IF NEW."issuedAt" IS NOT NULL
                OR NEW."expiresAt" IS NOT NULL
                OR NEW."revokedAt" IS NOT NULL
                OR NEW."revocationReasonCode" IS NOT NULL THEN
                RAISE EXCEPTION 'draft grant has lifecycle fields' USING ERRCODE = 'check_violation';
            END IF;
            RETURN NEW;
        END IF;

        IF NEW."status" <> 'issued'
            OR NEW."issuedAt" IS NULL
            OR NEW."expiresAt" IS NULL
            OR NEW."revokedAt" IS NOT NULL
            OR NEW."revocationReasonCode" IS NOT NULL THEN
            RAISE EXCEPTION 'invalid grant lifecycle transition' USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;

    IF OLD."status" = 'issued' THEN
        IF ROW(
            NEW."id", NEW."projectId", NEW."sourceKind", NEW."policyRevisionId",
            NEW."profileFingerprint", NEW."providerFingerprint", NEW."modelFingerprint",
            NEW."modelId", NEW."processorFingerprint", NEW."regionFingerprint",
            NEW."retentionFingerprint", NEW."endpointFingerprint", NEW."grantFingerprint",
            NEW."effectivePolicyVersion", NEW."budgetFingerprint", NEW."scannerFingerprint",
            NEW."scannerVersion", NEW."budgetProfile", NEW."issuedBy", NEW."purposeCode",
            NEW."issuedAt", NEW."expiresAt", NEW."createdAt"
        ) IS DISTINCT FROM ROW(
            OLD."id", OLD."projectId", OLD."sourceKind", OLD."policyRevisionId",
            OLD."profileFingerprint", OLD."providerFingerprint", OLD."modelFingerprint",
            OLD."modelId", OLD."processorFingerprint", OLD."regionFingerprint",
            OLD."retentionFingerprint", OLD."endpointFingerprint", OLD."grantFingerprint",
            OLD."effectivePolicyVersion", OLD."budgetFingerprint", OLD."scannerFingerprint",
            OLD."scannerVersion", OLD."budgetProfile", OLD."issuedBy", OLD."purposeCode",
            OLD."issuedAt", OLD."expiresAt", OLD."createdAt"
        ) THEN
            RAISE EXCEPTION 'issued grant is sealed' USING ERRCODE = 'check_violation';
        END IF;

        IF NEW."status" = 'issued' THEN
            IF NEW."revokedAt" IS NOT NULL OR NEW."revocationReasonCode" IS NOT NULL THEN
                RAISE EXCEPTION 'issued grant has revocation fields' USING ERRCODE = 'check_violation';
            END IF;
            RETURN NEW;
        END IF;

        IF NEW."status" = 'revoked'
            AND NEW."revokedAt" IS NOT NULL
            AND NEW."revokedAt" >= NEW."issuedAt"
            AND NEW."revocationReasonCode" IS NOT NULL THEN
            RETURN NEW;
        END IF;

        RAISE EXCEPTION 'invalid grant lifecycle transition' USING ERRCODE = 'check_violation';
    END IF;

    RAISE EXCEPTION 'revoked grant is immutable' USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER "ModelProcessingGrant_lifecycle_trigger"
BEFORE INSERT OR UPDATE ON "ModelProcessingGrant"
FOR EACH ROW EXECUTE FUNCTION "ai_grant_lifecycle_guard"();

CREATE OR REPLACE FUNCTION "ai_grant_delete_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM "Project"
        WHERE "id" = OLD."projectId"
    ) THEN
        RAISE EXCEPTION 'grant deletion is append-only' USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
END;
$$;

CREATE TRIGGER "ModelProcessingGrant_delete_guard_trigger"
BEFORE DELETE ON "ModelProcessingGrant"
FOR EACH ROW EXECUTE FUNCTION "ai_grant_delete_guard"();

-- A grant's source and operation scope may be edited only while the grant is
-- draft. Once issued, the explicit scope is sealed for provenance safety.
CREATE OR REPLACE FUNCTION "ai_grant_scope_draft_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_project_id UUID;
    target_grant_id UUID;
    previous_project_id UUID;
    previous_grant_id UUID;
    grant_status "ModelProcessingGrantStatus";
    previous_grant_status "ModelProcessingGrantStatus";
    operation_allowed BOOLEAN;
BEGIN
    IF TG_OP = 'DELETE' THEN
        target_project_id := OLD."projectId";
        target_grant_id := OLD."grantId";
    ELSIF TG_OP = 'UPDATE' THEN
        target_project_id := NEW."projectId";
        target_grant_id := NEW."grantId";
        previous_project_id := OLD."projectId";
        previous_grant_id := OLD."grantId";
    ELSE
        target_project_id := NEW."projectId";
        target_grant_id := NEW."grantId";
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM "Project"
        WHERE "id" = target_project_id
    ) THEN
        IF TG_OP = 'DELETE' THEN
            RETURN OLD;
        END IF;
        RETURN NEW;
    END IF;

    IF TG_OP = 'UPDATE'
        AND (NEW."projectId" IS DISTINCT FROM OLD."projectId"
            OR NEW."grantId" IS DISTINCT FROM OLD."grantId") THEN
        RAISE EXCEPTION 'grant scope identity is immutable' USING ERRCODE = 'check_violation';
    END IF;

    IF TG_OP = 'UPDATE' AND EXISTS (
        SELECT 1 FROM "Project"
        WHERE "id" = previous_project_id
    ) THEN
        SELECT "status" INTO previous_grant_status
        FROM "ModelProcessingGrant"
        WHERE "projectId" = previous_project_id AND "id" = previous_grant_id;

        IF previous_grant_status IS DISTINCT FROM 'draft' THEN
            RAISE EXCEPTION 'grant scope is sealed' USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    SELECT "status" INTO grant_status
    FROM "ModelProcessingGrant"
    WHERE "projectId" = target_project_id AND "id" = target_grant_id;

    IF grant_status IS DISTINCT FROM 'draft' THEN
        RAISE EXCEPTION 'grant scope is sealed' USING ERRCODE = 'check_violation';
    END IF;

    IF TG_TABLE_NAME = 'ModelProcessingGrantOperation' AND TG_OP <> 'DELETE' THEN
        SELECT CASE NEW."operation"
            WHEN 'embedding' THEN r."embeddingEnabled"
            WHEN 'autoExtract' THEN r."autoExtractEnabled"
            WHEN 'sourceSummary' THEN r."sourceSummaryEnabled"
            WHEN 'projectAnalysis' THEN r."projectAnalysisEnabled"
            WHEN 'generateWithContext' THEN r."generateWithContextEnabled"
            ELSE FALSE
        END
        INTO operation_allowed
        FROM "ModelProcessingGrant" AS g
        JOIN "ProjectAiPolicyRevision" AS r
          ON r."projectId" = g."projectId"
         AND r."id" = g."policyRevisionId"
        WHERE g."projectId" = NEW."projectId" AND g."id" = NEW."grantId";

        IF operation_allowed IS NOT TRUE THEN
            RAISE EXCEPTION 'grant operation is not allowed by policy' USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "ModelProcessingGrantSource_draft_only_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "ModelProcessingGrantSource"
FOR EACH ROW EXECUTE FUNCTION "ai_grant_scope_draft_guard"();

CREATE TRIGGER "ModelProcessingGrantOperation_draft_only_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "ModelProcessingGrantOperation"
FOR EACH ROW EXECUTE FUNCTION "ai_grant_scope_draft_guard"();

-- Issuance is the only transition that can make a grant usable. It requires
-- explicit source and operation scope and binds the grant to the current,
-- outbound-enabled policy revision and its operation allowlist.
CREATE OR REPLACE FUNCTION "ai_grant_issuance_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    current_revision_id UUID;
    current_outbound_enabled BOOLEAN;
BEGIN
    IF TG_OP <> 'UPDATE' OR OLD."status" <> 'draft' OR NEW."status" <> 'issued' THEN
        RETURN NEW;
    END IF;

    SELECT p."currentRevisionId", r."outboundEnabled"
    INTO current_revision_id, current_outbound_enabled
    FROM "ProjectAiPolicy" AS p
    JOIN "ProjectAiPolicyRevision" AS r
      ON r."projectId" = p."projectId"
     AND r."id" = p."currentRevisionId"
    WHERE p."projectId" = NEW."projectId";

    IF current_revision_id IS NULL
        OR NEW."policyRevisionId" IS DISTINCT FROM current_revision_id
        OR current_outbound_enabled IS NOT TRUE THEN
        RAISE EXCEPTION 'grant policy is not issuable' USING ERRCODE = 'check_violation';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM "ModelProcessingGrantSource"
        WHERE "projectId" = NEW."projectId" AND "grantId" = NEW."id"
    ) OR NOT EXISTS (
        SELECT 1 FROM "ModelProcessingGrantOperation"
        WHERE "projectId" = NEW."projectId" AND "grantId" = NEW."id"
    ) THEN
        RAISE EXCEPTION 'grant scope is incomplete' USING ERRCODE = 'check_violation';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM "ModelProcessingGrantOperation" AS op
        JOIN "ProjectAiPolicyRevision" AS r
          ON r."projectId" = NEW."projectId"
         AND r."id" = NEW."policyRevisionId"
        WHERE op."projectId" = NEW."projectId"
          AND op."grantId" = NEW."id"
          AND NOT CASE op."operation"
              WHEN 'embedding' THEN r."embeddingEnabled"
              WHEN 'autoExtract' THEN r."autoExtractEnabled"
              WHEN 'sourceSummary' THEN r."sourceSummaryEnabled"
              WHEN 'projectAnalysis' THEN r."projectAnalysisEnabled"
              WHEN 'generateWithContext' THEN r."generateWithContextEnabled"
              ELSE FALSE
          END
    ) THEN
        RAISE EXCEPTION 'grant operation is not allowed by policy' USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "ModelProcessingGrant_issuance_trigger"
BEFORE UPDATE OF "status" ON "ModelProcessingGrant"
FOR EACH ROW EXECUTE FUNCTION "ai_grant_issuance_guard"();

-- Run creation is governed by the current outbound-enabled revision and an
-- issued, live grant. Existing runs may later close against their original
-- revision, but a new run cannot be created after policy advancement.
CREATE OR REPLACE FUNCTION "ai_run_lifecycle_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    current_revision_id UUID;
    current_outbound_enabled BOOLEAN;
    grant_status "ModelProcessingGrantStatus";
    grant_expires_at TIMESTAMP(3);
    grant_revoked_at TIMESTAMP(3);
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."status" <> 'queued'
            OR NEW."requestCount" <> 0
            OR NEW."inputTokens" <> 0
            OR NEW."outputTokens" <> 0
            OR NEW."budgetUsedMicros" <> 0
            OR NEW."outputBytes" <> 0
            OR NEW."claimedAt" IS NOT NULL
            OR NEW."sentAt" IS NOT NULL
            OR NEW."completedAt" IS NOT NULL
            OR NEW."providerRequestId" IS NOT NULL
            OR NEW."providerResponseId" IS NOT NULL
            OR NEW."httpStatus" IS NOT NULL
            OR NEW."safeErrorCode" IS NOT NULL
            OR NEW."budgetStatus" <> 'pending' THEN
            RAISE EXCEPTION 'run must start queued and unclaimed' USING ERRCODE = 'check_violation';
        END IF;

        SELECT p."currentRevisionId", r."outboundEnabled", g."status", g."expiresAt", g."revokedAt"
        INTO current_revision_id, current_outbound_enabled, grant_status, grant_expires_at, grant_revoked_at
        FROM "ProjectAiPolicy" AS p
        JOIN "ProjectAiPolicyRevision" AS r
          ON r."projectId" = p."projectId"
         AND r."id" = p."currentRevisionId"
        JOIN "ModelProcessingGrant" AS g
          ON g."projectId" = NEW."projectId"
         AND g."id" = NEW."grantId"
         AND g."policyRevisionId" = NEW."policyRevisionId"
        WHERE p."projectId" = NEW."projectId";

        IF current_revision_id IS NULL
            OR NEW."policyRevisionId" IS DISTINCT FROM current_revision_id
            OR current_outbound_enabled IS NOT TRUE
            OR grant_status IS DISTINCT FROM 'issued'
            OR grant_expires_at IS NULL
            OR grant_expires_at <= CURRENT_TIMESTAMP
            OR grant_revoked_at IS NOT NULL THEN
            RAISE EXCEPTION 'run grant is not issuable' USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;

    IF TG_OP = 'DELETE' THEN
        IF EXISTS (
            SELECT 1 FROM "Project"
            WHERE "id" = OLD."projectId"
        ) THEN
            RAISE EXCEPTION 'run deletion is append-only' USING ERRCODE = 'check_violation';
        END IF;
        RETURN OLD;
    END IF;

    IF ROW(
        NEW."id", NEW."projectId", NEW."grantId", NEW."policyRevisionId", NEW."operation",
        NEW."operationKey", NEW."operationKeySchemaVersion", NEW."inputManifestFingerprint",
        NEW."promptFingerprint", NEW."promptVersion", NEW."providerFingerprint", NEW."modelId",
        NEW."modelFingerprint", NEW."profileFingerprint", NEW."grantFingerprint",
        NEW."effectivePolicyVersion", NEW."processorFingerprint", NEW."processorEndpointFingerprint",
        NEW."processorRegionFingerprint", NEW."processorRetentionFingerprint",
        NEW."noRagSnapshotMarker", NEW."inputBytes", NEW."maxInputTokens", NEW."maxOutputTokens",
        NEW."maxRequests", NEW."maxBudgetMicros", NEW."pricingSnapshotId", NEW."createdAt"
    ) IS DISTINCT FROM ROW(
        OLD."id", OLD."projectId", OLD."grantId", OLD."policyRevisionId", OLD."operation",
        OLD."operationKey", OLD."operationKeySchemaVersion", OLD."inputManifestFingerprint",
        OLD."promptFingerprint", OLD."promptVersion", OLD."providerFingerprint", OLD."modelId",
        OLD."modelFingerprint", OLD."profileFingerprint", OLD."grantFingerprint",
        OLD."effectivePolicyVersion", OLD."processorFingerprint", OLD."processorEndpointFingerprint",
        OLD."processorRegionFingerprint", OLD."processorRetentionFingerprint",
        OLD."noRagSnapshotMarker", OLD."inputBytes", OLD."maxInputTokens", OLD."maxOutputTokens",
        OLD."maxRequests", OLD."maxBudgetMicros", OLD."pricingSnapshotId", OLD."createdAt"
    ) THEN
        RAISE EXCEPTION 'run identity is sealed' USING ERRCODE = 'check_violation';
    END IF;

    IF OLD."status" = 'queued' THEN
        IF NEW."status" = 'running' THEN
            SELECT p."currentRevisionId", r."outboundEnabled", g."status", g."expiresAt", g."revokedAt"
            INTO current_revision_id, current_outbound_enabled, grant_status, grant_expires_at, grant_revoked_at
            FROM "ProjectAiPolicy" AS p
            JOIN "ProjectAiPolicyRevision" AS r
              ON r."projectId" = p."projectId"
             AND r."id" = p."currentRevisionId"
            JOIN "ModelProcessingGrant" AS g
              ON g."projectId" = NEW."projectId"
             AND g."id" = NEW."grantId"
             AND g."policyRevisionId" = NEW."policyRevisionId"
            WHERE p."projectId" = NEW."projectId";

            IF current_revision_id IS NULL
                OR NEW."policyRevisionId" IS DISTINCT FROM current_revision_id
                OR current_outbound_enabled IS NOT TRUE
                OR grant_status IS DISTINCT FROM 'issued'
                OR grant_expires_at IS NULL
                OR grant_expires_at <= CURRENT_TIMESTAMP
                OR grant_revoked_at IS NOT NULL THEN
                RAISE EXCEPTION 'run claim is no longer issuable' USING ERRCODE = 'check_violation';
            END IF;

            IF NEW."claimedAt" IS NULL
                OR NEW."sentAt" IS NULL
                OR NEW."completedAt" IS NOT NULL
                OR OLD."requestCount" <> 0
                OR NEW."requestCount" <> 1
                OR NEW."inputTokens" <> 0
                OR NEW."outputTokens" <> 0
                OR NEW."budgetUsedMicros" <> 0
                OR NEW."outputBytes" <> 0
                OR NEW."providerRequestId" IS NOT NULL
                OR NEW."providerResponseId" IS NOT NULL
                OR NEW."httpStatus" IS NOT NULL
                OR NEW."safeErrorCode" IS NOT NULL THEN
                RAISE EXCEPTION 'run claim timestamps are invalid' USING ERRCODE = 'check_violation';
            END IF;
        ELSIF NEW."status" IN ('failed', 'cancelled') THEN
            IF NEW."claimedAt" IS NOT NULL
                OR NEW."sentAt" IS NOT NULL
                OR NEW."completedAt" IS NULL
                OR NEW."requestCount" <> 0
                OR NEW."inputTokens" <> 0
                OR NEW."outputTokens" <> 0
                OR NEW."budgetUsedMicros" <> 0
                OR NEW."outputBytes" <> 0
                OR NEW."providerRequestId" IS NOT NULL
                OR NEW."providerResponseId" IS NOT NULL
                OR NEW."httpStatus" IS NOT NULL THEN
                RAISE EXCEPTION 'preflight terminal run is invalid' USING ERRCODE = 'check_violation';
            END IF;
        ELSIF NEW."status" = 'queued' THEN
            IF ROW(
                NEW."status", NEW."outputBytes", NEW."inputTokens", NEW."outputTokens",
                NEW."requestCount", NEW."budgetUsedMicros", NEW."budgetStatus",
                NEW."safeErrorCode", NEW."httpStatus", NEW."providerRequestId",
                NEW."providerResponseId", NEW."claimedAt", NEW."sentAt", NEW."completedAt"
            ) IS DISTINCT FROM ROW(
                OLD."status", OLD."outputBytes", OLD."inputTokens", OLD."outputTokens",
                OLD."requestCount", OLD."budgetUsedMicros", OLD."budgetStatus",
                OLD."safeErrorCode", OLD."httpStatus", OLD."providerRequestId",
                OLD."providerResponseId", OLD."claimedAt", OLD."sentAt", OLD."completedAt"
            ) THEN
                RAISE EXCEPTION 'queued run is immutable' USING ERRCODE = 'check_violation';
            END IF;
        ELSE
            RAISE EXCEPTION 'invalid run lifecycle transition' USING ERRCODE = 'check_violation';
        END IF;
    ELSIF OLD."status" = 'running' THEN
        IF NEW."status" IN ('succeeded', 'failed', 'unknown', 'cancelled') THEN
            IF NEW."claimedAt" IS NULL
                OR NEW."sentAt" IS NULL
                OR NEW."completedAt" IS NULL
                OR NEW."requestCount" < 1 THEN
                RAISE EXCEPTION 'running terminal timestamps are invalid' USING ERRCODE = 'check_violation';
            END IF;
        ELSIF NEW."status" = 'running' THEN
            IF ROW(
                NEW."status", NEW."outputBytes", NEW."inputTokens", NEW."outputTokens",
                NEW."requestCount", NEW."budgetUsedMicros", NEW."budgetStatus",
                NEW."safeErrorCode", NEW."httpStatus", NEW."providerRequestId",
                NEW."providerResponseId", NEW."claimedAt", NEW."sentAt", NEW."completedAt"
            ) IS DISTINCT FROM ROW(
                OLD."status", OLD."outputBytes", OLD."inputTokens", OLD."outputTokens",
                OLD."requestCount", OLD."budgetUsedMicros", OLD."budgetStatus",
                OLD."safeErrorCode", OLD."httpStatus", OLD."providerRequestId",
                OLD."providerResponseId", OLD."claimedAt", OLD."sentAt", OLD."completedAt"
            ) THEN
                RAISE EXCEPTION 'running run is immutable' USING ERRCODE = 'check_violation';
            END IF;
        ELSE
            RAISE EXCEPTION 'invalid run lifecycle transition' USING ERRCODE = 'check_violation';
        END IF;
    ELSIF OLD."status" = 'failed' THEN
        IF ROW(
            NEW."status", NEW."outputBytes", NEW."inputTokens", NEW."outputTokens",
            NEW."requestCount", NEW."budgetUsedMicros", NEW."budgetStatus",
            NEW."safeErrorCode", NEW."httpStatus", NEW."providerRequestId",
            NEW."providerResponseId", NEW."claimedAt", NEW."sentAt", NEW."completedAt"
        ) IS DISTINCT FROM ROW(
            OLD."status", OLD."outputBytes", OLD."inputTokens", OLD."outputTokens",
            OLD."requestCount", OLD."budgetUsedMicros", OLD."budgetStatus",
            OLD."safeErrorCode", OLD."httpStatus", OLD."providerRequestId",
            OLD."providerResponseId", OLD."claimedAt", OLD."sentAt", OLD."completedAt"
        ) THEN
            RAISE EXCEPTION 'failed run retry is service-only' USING ERRCODE = 'check_violation';
        END IF;
    ELSE
        IF ROW(
            NEW."status", NEW."outputBytes", NEW."inputTokens", NEW."outputTokens",
            NEW."requestCount", NEW."budgetUsedMicros", NEW."budgetStatus",
            NEW."safeErrorCode", NEW."httpStatus", NEW."providerRequestId",
            NEW."providerResponseId", NEW."claimedAt", NEW."sentAt", NEW."completedAt"
        ) IS DISTINCT FROM ROW(
            OLD."status", OLD."outputBytes", OLD."inputTokens", OLD."outputTokens",
            OLD."requestCount", OLD."budgetUsedMicros", OLD."budgetStatus",
            OLD."safeErrorCode", OLD."httpStatus", OLD."providerRequestId",
            OLD."providerResponseId", OLD."claimedAt", OLD."sentAt", OLD."completedAt"
        ) THEN
            RAISE EXCEPTION 'terminal run is immutable' USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "AiRun_lifecycle_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "AiRun"
FOR EACH ROW EXECUTE FUNCTION "ai_run_lifecycle_guard"();

-- An Attempt is a real dispatch claim, never a speculative or preflight row.
CREATE OR REPLACE FUNCTION "ai_attempt_lifecycle_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    run_status "AiRunStatus";
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."status" <> 'sent'
            OR NEW."requestCount" <> 1
            OR NEW."inputTokens" <> 0
            OR NEW."outputTokens" <> 0
            OR NEW."providerRequestId" IS NOT NULL
            OR NEW."providerResponseId" IS NOT NULL
            OR NEW."httpStatus" IS NOT NULL
            OR NEW."safeErrorCode" IS NOT NULL
            OR NEW."completedAt" IS NOT NULL THEN
            RAISE EXCEPTION 'attempt must start sent' USING ERRCODE = 'check_violation';
        END IF;
        SELECT "status" INTO run_status
        FROM "AiRun"
        WHERE "projectId" = NEW."projectId" AND "id" = NEW."aiRunId";
        IF run_status IS DISTINCT FROM 'running' THEN
            RAISE EXCEPTION 'attempt requires running run' USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;

    IF TG_OP = 'DELETE' THEN
        IF EXISTS (
            SELECT 1 FROM "Project"
            WHERE "id" = OLD."projectId"
        ) THEN
            RAISE EXCEPTION 'attempt deletion is append-only' USING ERRCODE = 'check_violation';
        END IF;
        RETURN OLD;
    END IF;

    IF ROW(
        NEW."id", NEW."projectId", NEW."aiRunId", NEW."attemptNumber",
        NEW."dispatchToken", NEW."sentAt", NEW."requestCount", NEW."createdAt"
    ) IS DISTINCT FROM ROW(
        OLD."id", OLD."projectId", OLD."aiRunId", OLD."attemptNumber",
        OLD."dispatchToken", OLD."sentAt", OLD."requestCount", OLD."createdAt"
    ) THEN
        RAISE EXCEPTION 'attempt identity is sealed' USING ERRCODE = 'check_violation';
    END IF;

    IF OLD."status" = 'sent' THEN
        IF NEW."status" NOT IN ('succeeded', 'failed', 'unknown', 'cancelled')
            OR NEW."completedAt" IS NULL THEN
            RAISE EXCEPTION 'invalid attempt lifecycle transition' USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'terminal attempt is immutable' USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER "AiRunAttempt_lifecycle_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "AiRunAttempt"
FOR EACH ROW EXECUTE FUNCTION "ai_attempt_lifecycle_guard"();

-- Input provenance is append-only and must match the frozen grant source
-- snapshot and scanner version before it can join a queued/running Run.
CREATE OR REPLACE FUNCTION "ai_input_source_lifecycle_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    run_status "AiRunStatus";
    grant_status "ModelProcessingGrantStatus";
    grant_expires_at TIMESTAMP(3);
    grant_revoked_at TIMESTAMP(3);
    grant_scanner_version VARCHAR(64);
    source_fingerprint VARCHAR(64);
    source_bytes INTEGER;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."safeScanResult" <> 'passed' THEN
            RAISE EXCEPTION 'input scanner result is not safe' USING ERRCODE = 'check_violation';
        END IF;

        SELECT r."status", g."status", g."expiresAt", g."revokedAt", g."scannerVersion",
               gs."contentFingerprint", gs."contentBytes"
        INTO run_status, grant_status, grant_expires_at, grant_revoked_at, grant_scanner_version,
             source_fingerprint, source_bytes
        FROM "AiRun" AS r
        JOIN "ModelProcessingGrant" AS g
          ON g."projectId" = r."projectId"
         AND g."id" = NEW."grantId"
        JOIN "ModelProcessingGrantSource" AS gs
          ON gs."projectId" = NEW."projectId"
         AND gs."grantId" = NEW."grantId"
         AND gs."sourceId" = NEW."sourceId"
        WHERE r."projectId" = NEW."projectId" AND r."id" = NEW."aiRunId";

        IF run_status IS DISTINCT FROM 'queued'
            OR grant_status IS DISTINCT FROM 'issued'
            OR grant_expires_at IS NULL
            OR grant_expires_at <= CURRENT_TIMESTAMP
            OR grant_revoked_at IS NOT NULL
            OR source_fingerprint IS DISTINCT FROM NEW."contentFingerprint"
            OR source_bytes IS DISTINCT FROM NEW."contentBytes"
            OR grant_scanner_version IS DISTINCT FROM NEW."scannerVersion" THEN
            RAISE EXCEPTION 'input provenance is not admissible' USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;

    IF EXISTS (
        SELECT 1 FROM "Project"
        WHERE "id" = OLD."projectId"
    ) THEN
        RAISE EXCEPTION 'input provenance is append-only' USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "AiRunInputSource_lifecycle_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "AiRunInputSource"
FOR EACH ROW EXECUTE FUNCTION "ai_input_source_lifecycle_guard"();

-- Audit provenance is append-only. The parent Project visibility check gives
-- the Project-root cascade a controlled escape hatch for the next PostgreSQL
-- gate without permitting direct mutation while the project exists.
CREATE OR REPLACE FUNCTION "ai_audit_append_only_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        RETURN NEW;
    END IF;

    IF EXISTS (
        SELECT 1 FROM "Project"
        WHERE "id" = OLD."projectId"
    ) THEN
        RAISE EXCEPTION 'audit event is append-only' USING ERRCODE = 'check_violation';
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "AiAuditEvent_append_only_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "AiAuditEvent"
FOR EACH ROW EXECUTE FUNCTION "ai_audit_append_only_guard"();

-- Run and Attempt are checked together at transaction commit. This deferred
-- constraint trigger permits a claim transaction to update either row first,
-- while preventing a terminal Run or a sent claim from being fabricated by
-- timestamps alone.
CREATE OR REPLACE FUNCTION "ai_run_attempt_consistency_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_project_id UUID;
    target_run_id UUID;
    run_status "AiRunStatus";
    run_request_count INTEGER;
    attempt_count BIGINT;
    latest_attempt_status "AiRunAttemptStatus";
    expected_attempt_status "AiRunAttemptStatus";
BEGIN
    IF TG_TABLE_NAME = 'AiRun' THEN
        IF TG_OP = 'DELETE' THEN
            target_project_id := OLD."projectId";
            target_run_id := OLD."id";
        ELSE
            target_project_id := NEW."projectId";
            target_run_id := NEW."id";
        END IF;
    ELSE
        IF TG_OP = 'DELETE' THEN
            target_project_id := OLD."projectId";
            target_run_id := OLD."aiRunId";
        ELSE
            target_project_id := NEW."projectId";
            target_run_id := NEW."aiRunId";
        END IF;
    END IF;

    SELECT r."status", r."requestCount"
    INTO run_status, run_request_count
    FROM "AiRun" AS r
    WHERE r."projectId" = target_project_id AND r."id" = target_run_id;

    IF NOT FOUND THEN
        IF TG_OP = 'DELETE' THEN
            RETURN OLD;
        END IF;
        RETURN NEW;
    END IF;

    SELECT COUNT(*)
    INTO attempt_count
    FROM "AiRunAttempt" AS a
    WHERE a."projectId" = target_project_id AND a."aiRunId" = target_run_id;

    SELECT a."status"
    INTO latest_attempt_status
    FROM "AiRunAttempt" AS a
    WHERE a."projectId" = target_project_id AND a."aiRunId" = target_run_id
    ORDER BY a."attemptNumber" DESC
    LIMIT 1;

    IF run_status = 'queued' THEN
        IF attempt_count <> 0 OR run_request_count <> 0 THEN
            RAISE EXCEPTION 'queued run has dispatch evidence' USING ERRCODE = 'check_violation';
        END IF;
    ELSIF run_status = 'running' THEN
        IF attempt_count < 1
            OR run_request_count <> attempt_count
            OR latest_attempt_status IS DISTINCT FROM 'sent' THEN
            RAISE EXCEPTION 'running run and attempt mismatch' USING ERRCODE = 'check_violation';
        END IF;
    ELSIF run_status IN ('succeeded', 'failed', 'unknown', 'cancelled') THEN
        IF attempt_count = 0 THEN
            IF run_status IN ('failed', 'cancelled') AND run_request_count = 0 THEN
                IF TG_OP = 'DELETE' THEN
                    RETURN OLD;
                END IF;
                RETURN NEW;
            END IF;
            RAISE EXCEPTION 'terminal run lacks dispatch evidence' USING ERRCODE = 'check_violation';
        END IF;

        expected_attempt_status := CASE run_status
            WHEN 'succeeded' THEN 'succeeded'::"AiRunAttemptStatus"
            WHEN 'failed' THEN 'failed'::"AiRunAttemptStatus"
            WHEN 'unknown' THEN 'unknown'::"AiRunAttemptStatus"
            WHEN 'cancelled' THEN 'cancelled'::"AiRunAttemptStatus"
        END;

        IF run_request_count <> attempt_count
            OR latest_attempt_status IS DISTINCT FROM expected_attempt_status THEN
            RAISE EXCEPTION 'terminal run and attempt mismatch' USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "AiRun_attempt_consistency_constraint_trigger"
AFTER INSERT OR UPDATE OR DELETE ON "AiRun"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "ai_run_attempt_consistency_guard"();

CREATE CONSTRAINT TRIGGER "AiRunAttempt_run_consistency_constraint_trigger"
AFTER INSERT OR UPDATE OR DELETE ON "AiRunAttempt"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "ai_run_attempt_consistency_guard"();
