-- CreateEnum
CREATE TYPE "AppUserRole" AS ENUM ('admin');

-- CreateEnum
CREATE TYPE "ExternalCredentialKind" AS ENUM ('ai_provider', 'github');

-- CreateEnum
CREATE TYPE "AiProviderKind" AS ENUM ('openai', 'deepseek', 'qwen', 'glm');

-- CreateEnum
CREATE TYPE "AiProviderProtocol" AS ENUM ('chat_completions');

-- CreateEnum
CREATE TYPE "AiProviderConnectionStatus" AS ENUM ('configured', 'verified', 'error', 'disabled');

-- CreateEnum
CREATE TYPE "WebAiScopeKind" AS ENUM ('project_sources', 'repository_code', 'repository_material', 'query');

-- CreateEnum
CREATE TYPE "BackgroundJobKind" AS ENUM ('github_scan', 'github_material_sync', 'memory_index', 'auto_extract', 'rag_answer');

-- CreateEnum
CREATE TYPE "BackgroundJobStatus" AS ENUM ('queued', 'running', 'succeeded', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "MemoryIndexStatus" AS ENUM ('staging', 'complete', 'failed', 'superseded');

-- CreateEnum
CREATE TYPE "MemoryRecordScope" AS ENUM ('project_source', 'repository_code', 'repository_material');

-- CreateEnum
CREATE TYPE "WebAiCandidateStatus" AS ENUM ('candidate', 'accepted', 'dismissed');

-- AlterTable
ALTER TABLE "GitHubConnection" ADD COLUMN     "credentialId" UUID;

-- CreateTable
CREATE TABLE "AppUser" (
    "id" UUID NOT NULL,
    "username" VARCHAR(64) NOT NULL,
    "passwordHash" VARCHAR(128) NOT NULL,
    "passwordSalt" VARCHAR(128) NOT NULL,
    "passwordVersion" INTEGER NOT NULL DEFAULT 1,
    "role" "AppUserRole" NOT NULL DEFAULT 'admin',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppSession" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" CHAR(64) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "AppSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExternalCredential" (
    "id" UUID NOT NULL,
    "kind" "ExternalCredentialKind" NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "nonce" BYTEA NOT NULL,
    "authTag" BYTEA NOT NULL,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "maskedSuffix" VARCHAR(12) NOT NULL,
    "secretFingerprint" CHAR(64) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "rotatedAt" TIMESTAMP(3),

    CONSTRAINT "ExternalCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiProviderConnection" (
    "id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "kind" "AiProviderKind" NOT NULL,
    "protocol" "AiProviderProtocol" NOT NULL DEFAULT 'chat_completions',
    "baseUrl" VARCHAR(512) NOT NULL,
    "credentialId" UUID NOT NULL,
    "defaultGenerationModelId" VARCHAR(128) NOT NULL,
    "defaultEmbeddingModelId" VARCHAR(128),
    "embeddingDimensions" INTEGER,
    "status" "AiProviderConnectionStatus" NOT NULL DEFAULT 'configured',
    "lastTestedAt" TIMESTAMP(3),
    "lastErrorCode" VARCHAR(64),
    "disabledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiProviderConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectAiRoute" (
    "projectId" UUID NOT NULL,
    "operation" "AiOperation" NOT NULL,
    "providerConnectionId" UUID NOT NULL,
    "modelId" VARCHAR(128) NOT NULL,
    "embeddingDimensions" INTEGER,
    "maxOutputTokens" INTEGER NOT NULL DEFAULT 2048,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectAiRoute_pkey" PRIMARY KEY ("projectId","operation")
);

-- CreateTable
CREATE TABLE "WebAiGrant" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "operation" "AiOperation" NOT NULL,
    "scopeKind" "WebAiScopeKind" NOT NULL,
    "scopeIds" JSONB NOT NULL,
    "manifestFingerprint" CHAR(64) NOT NULL,
    "providerConnectionId" UUID NOT NULL,
    "modelId" VARCHAR(128) NOT NULL,
    "consentVersion" VARCHAR(128) NOT NULL,
    "issuedById" UUID NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "WebAiGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BackgroundJob" (
    "id" UUID NOT NULL,
    "projectId" UUID,
    "kind" "BackgroundJobKind" NOT NULL,
    "status" "BackgroundJobStatus" NOT NULL DEFAULT 'queued',
    "stage" VARCHAR(64) NOT NULL DEFAULT 'queued',
    "payload" JSONB NOT NULL DEFAULT '{}',
    "result" JSONB,
    "progressCurrent" INTEGER NOT NULL DEFAULT 0,
    "progressTotal" INTEGER NOT NULL DEFAULT 0,
    "failureCode" VARCHAR(64),
    "idempotencyKey" CHAR(64) NOT NULL,
    "requestedById" UUID NOT NULL,
    "webAiGrantId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "BackgroundJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemoryIndexGeneration" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "providerConnectionId" UUID NOT NULL,
    "modelId" VARCHAR(128) NOT NULL,
    "dimensions" INTEGER NOT NULL,
    "status" "MemoryIndexStatus" NOT NULL DEFAULT 'staging',
    "inputManifestFingerprint" CHAR(64) NOT NULL,
    "recordCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "supersededAt" TIMESTAMP(3),

    CONSTRAINT "MemoryIndexGeneration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemoryIndexPointer" (
    "projectId" UUID NOT NULL,
    "indexGenerationId" UUID NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemoryIndexPointer_pkey" PRIMARY KEY ("projectId")
);

-- CreateTable
CREATE TABLE "MemoryRecord" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "indexGenerationId" UUID NOT NULL,
    "scope" "MemoryRecordScope" NOT NULL,
    "projectSourceId" UUID,
    "projectRepositoryLinkId" UUID,
    "frozenCommitSha" CHAR(40),
    "path" VARCHAR(1024),
    "externalRef" TEXT,
    "rangeStart" INTEGER NOT NULL,
    "rangeEnd" INTEGER NOT NULL,
    "contentText" TEXT NOT NULL,
    "contentHash" CHAR(64) NOT NULL,
    "embedding" DOUBLE PRECISION[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemoryRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RagAnswer" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "jobId" UUID NOT NULL,
    "indexGenerationId" UUID NOT NULL,
    "providerConnectionId" UUID NOT NULL,
    "modelId" VARCHAR(128) NOT NULL,
    "question" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "citations" JSONB NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RagAnswer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebAiCandidate" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "jobId" UUID NOT NULL,
    "sourceId" UUID NOT NULL,
    "projectItemId" UUID NOT NULL,
    "providerConnectionId" UUID NOT NULL,
    "modelId" VARCHAR(128) NOT NULL,
    "candidateFingerprint" CHAR(64) NOT NULL,
    "reviewStatus" "WebAiCandidateStatus" NOT NULL DEFAULT 'candidate',
    "reviewedAt" TIMESTAMP(3),
    "reviewedBy" VARCHAR(128),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebAiCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderCallAudit" (
    "id" UUID NOT NULL,
    "jobId" UUID NOT NULL,
    "providerConnectionId" UUID NOT NULL,
    "operation" "AiOperation" NOT NULL,
    "modelId" VARCHAR(128) NOT NULL,
    "status" VARCHAR(32) NOT NULL,
    "safeErrorCode" VARCHAR(64),
    "providerRequestId" VARCHAR(256),
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ProviderCallAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AppUser_username_key" ON "AppUser"("username");

-- CreateIndex
CREATE UNIQUE INDEX "AppUser_role_key" ON "AppUser"("role");

-- CreateIndex
CREATE UNIQUE INDEX "AppSession_tokenHash_key" ON "AppSession"("tokenHash");

-- CreateIndex
CREATE INDEX "AppSession_userId_expiresAt_idx" ON "AppSession"("userId", "expiresAt");

-- CreateIndex
CREATE INDEX "AppSession_expiresAt_revokedAt_idx" ON "AppSession"("expiresAt", "revokedAt");

-- CreateIndex
CREATE INDEX "ExternalCredential_kind_updatedAt_idx" ON "ExternalCredential"("kind", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AiProviderConnection_name_key" ON "AiProviderConnection"("name");

-- CreateIndex
CREATE UNIQUE INDEX "AiProviderConnection_credentialId_key" ON "AiProviderConnection"("credentialId");

-- CreateIndex
CREATE INDEX "AiProviderConnection_kind_status_idx" ON "AiProviderConnection"("kind", "status");

-- CreateIndex
CREATE INDEX "ProjectAiRoute_providerConnectionId_idx" ON "ProjectAiRoute"("providerConnectionId");

-- CreateIndex
CREATE INDEX "WebAiGrant_projectId_operation_expiresAt_idx" ON "WebAiGrant"("projectId", "operation", "expiresAt");

-- CreateIndex
CREATE INDEX "WebAiGrant_providerConnectionId_idx" ON "WebAiGrant"("providerConnectionId");

-- CreateIndex
CREATE INDEX "BackgroundJob_projectId_status_createdAt_idx" ON "BackgroundJob"("projectId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "BackgroundJob_status_createdAt_idx" ON "BackgroundJob"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "BackgroundJob_requestedById_idempotencyKey_key" ON "BackgroundJob"("requestedById", "idempotencyKey");

-- CreateIndex
CREATE INDEX "MemoryIndexGeneration_projectId_status_createdAt_idx" ON "MemoryIndexGeneration"("projectId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MemoryIndexGeneration_projectId_id_key" ON "MemoryIndexGeneration"("projectId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "MemoryIndexPointer_indexGenerationId_key" ON "MemoryIndexPointer"("indexGenerationId");

-- CreateIndex
CREATE UNIQUE INDEX "MemoryIndexPointer_projectId_indexGenerationId_key" ON "MemoryIndexPointer"("projectId", "indexGenerationId");

-- CreateIndex
CREATE INDEX "MemoryRecord_projectId_indexGenerationId_scope_idx" ON "MemoryRecord"("projectId", "indexGenerationId", "scope");

-- CreateIndex
CREATE INDEX "MemoryRecord_projectId_projectSourceId_idx" ON "MemoryRecord"("projectId", "projectSourceId");

-- CreateIndex
CREATE INDEX "MemoryRecord_projectId_projectRepositoryLinkId_idx" ON "MemoryRecord"("projectId", "projectRepositoryLinkId");

-- CreateIndex
CREATE UNIQUE INDEX "MemoryRecord_projectId_indexGenerationId_id_key" ON "MemoryRecord"("projectId", "indexGenerationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "RagAnswer_jobId_key" ON "RagAnswer"("jobId");

-- CreateIndex
CREATE INDEX "RagAnswer_projectId_createdAt_idx" ON "RagAnswer"("projectId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebAiCandidate_projectItemId_key" ON "WebAiCandidate"("projectItemId");

-- CreateIndex
CREATE INDEX "WebAiCandidate_projectId_reviewStatus_createdAt_idx" ON "WebAiCandidate"("projectId", "reviewStatus", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebAiCandidate_projectId_sourceId_candidateFingerprint_key" ON "WebAiCandidate"("projectId", "sourceId", "candidateFingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "WebAiCandidate_projectId_projectItemId_key" ON "WebAiCandidate"("projectId", "projectItemId");

-- CreateIndex
CREATE INDEX "ProviderCallAudit_jobId_createdAt_idx" ON "ProviderCallAudit"("jobId", "createdAt");

-- CreateIndex
CREATE INDEX "ProviderCallAudit_providerConnectionId_createdAt_idx" ON "ProviderCallAudit"("providerConnectionId", "createdAt");

-- AddForeignKey
ALTER TABLE "GitHubConnection" ADD CONSTRAINT "GitHubConnection_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "ExternalCredential"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppSession" ADD CONSTRAINT "AppSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AppUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiProviderConnection" ADD CONSTRAINT "AiProviderConnection_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "ExternalCredential"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectAiRoute" ADD CONSTRAINT "ProjectAiRoute_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectAiRoute" ADD CONSTRAINT "ProjectAiRoute_providerConnectionId_fkey" FOREIGN KEY ("providerConnectionId") REFERENCES "AiProviderConnection"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebAiGrant" ADD CONSTRAINT "WebAiGrant_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebAiGrant" ADD CONSTRAINT "WebAiGrant_providerConnectionId_fkey" FOREIGN KEY ("providerConnectionId") REFERENCES "AiProviderConnection"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebAiGrant" ADD CONSTRAINT "WebAiGrant_issuedById_fkey" FOREIGN KEY ("issuedById") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackgroundJob" ADD CONSTRAINT "BackgroundJob_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackgroundJob" ADD CONSTRAINT "BackgroundJob_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackgroundJob" ADD CONSTRAINT "BackgroundJob_webAiGrantId_fkey" FOREIGN KEY ("webAiGrantId") REFERENCES "WebAiGrant"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoryIndexGeneration" ADD CONSTRAINT "MemoryIndexGeneration_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoryIndexGeneration" ADD CONSTRAINT "MemoryIndexGeneration_providerConnectionId_fkey" FOREIGN KEY ("providerConnectionId") REFERENCES "AiProviderConnection"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoryIndexPointer" ADD CONSTRAINT "MemoryIndexPointer_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoryIndexPointer" ADD CONSTRAINT "MemoryIndexPointer_projectId_indexGenerationId_fkey" FOREIGN KEY ("projectId", "indexGenerationId") REFERENCES "MemoryIndexGeneration"("projectId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoryRecord" ADD CONSTRAINT "MemoryRecord_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoryRecord" ADD CONSTRAINT "MemoryRecord_projectId_indexGenerationId_fkey" FOREIGN KEY ("projectId", "indexGenerationId") REFERENCES "MemoryIndexGeneration"("projectId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoryRecord" ADD CONSTRAINT "MemoryRecord_projectId_projectSourceId_fkey" FOREIGN KEY ("projectId", "projectSourceId") REFERENCES "ProjectSource"("projectId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoryRecord" ADD CONSTRAINT "MemoryRecord_projectId_projectRepositoryLinkId_fkey" FOREIGN KEY ("projectId", "projectRepositoryLinkId") REFERENCES "ProjectRepositoryLink"("projectId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RagAnswer" ADD CONSTRAINT "RagAnswer_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RagAnswer" ADD CONSTRAINT "RagAnswer_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "BackgroundJob"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RagAnswer" ADD CONSTRAINT "RagAnswer_projectId_indexGenerationId_fkey" FOREIGN KEY ("projectId", "indexGenerationId") REFERENCES "MemoryIndexGeneration"("projectId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RagAnswer" ADD CONSTRAINT "RagAnswer_providerConnectionId_fkey" FOREIGN KEY ("providerConnectionId") REFERENCES "AiProviderConnection"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebAiCandidate" ADD CONSTRAINT "WebAiCandidate_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebAiCandidate" ADD CONSTRAINT "WebAiCandidate_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "BackgroundJob"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebAiCandidate" ADD CONSTRAINT "WebAiCandidate_projectId_sourceId_fkey" FOREIGN KEY ("projectId", "sourceId") REFERENCES "ProjectSource"("projectId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebAiCandidate" ADD CONSTRAINT "WebAiCandidate_projectId_projectItemId_fkey" FOREIGN KEY ("projectId", "projectItemId") REFERENCES "ProjectItem"("projectId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebAiCandidate" ADD CONSTRAINT "WebAiCandidate_providerConnectionId_fkey" FOREIGN KEY ("providerConnectionId") REFERENCES "AiProviderConnection"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderCallAudit" ADD CONSTRAINT "ProviderCallAudit_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "BackgroundJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderCallAudit" ADD CONSTRAINT "ProviderCallAudit_providerConnectionId_fkey" FOREIGN KEY ("providerConnectionId") REFERENCES "AiProviderConnection"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
