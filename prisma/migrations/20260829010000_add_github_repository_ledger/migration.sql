-- CreateEnum
CREATE TYPE "GitHubConnectionStatus" AS ENUM ('configured', 'verified', 'disabled', 'access_unknown');

-- CreateEnum
CREATE TYPE "ProjectRepositoryLinkStatus" AS ENUM ('active', 'disabled', 'unlinked', 'access_unknown');

-- CreateEnum
CREATE TYPE "ProjectRepositoryRole" AS ENUM ('primary', 'application', 'infrastructure', 'library', 'documentation', 'other');

-- CreateEnum
CREATE TYPE "ProjectScanBatchStatus" AS ENUM ('queued', 'running', 'succeeded', 'partial', 'partial_optional', 'failed', 'unknown', 'cancelled');

-- CreateEnum
CREATE TYPE "RepoCodeScanRunStatus" AS ENUM ('queued', 'running', 'succeeded', 'failed', 'rate_limited', 'unknown', 'cancelled');

-- CreateEnum
CREATE TYPE "RepoCodeScanStage" AS ENUM ('queued', 'discovering', 'fetching', 'scanning', 'publishing', 'terminal');

-- CreateEnum
CREATE TYPE "RepositoryCodeGenerationStatus" AS ENUM ('staging', 'code_ready', 'failed', 'ineligible', 'superseded');

-- CreateEnum
CREATE TYPE "ProjectCodeSnapshotStatus" AS ENUM ('staging', 'complete', 'ineligible', 'superseded');

-- CreateTable
CREATE TABLE "GitHubConnection" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "authRef" VARCHAR(128) NOT NULL,
    "status" "GitHubConnectionStatus" NOT NULL DEFAULT 'configured',
    "connectionFingerprint" VARCHAR(64) NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "disabledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GitHubConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GitHubRepository" (
    "id" UUID NOT NULL,
    "githubRepositoryId" BIGINT NOT NULL,
    "nodeId" VARCHAR(512) NOT NULL,
    "currentOwner" VARCHAR(256) NOT NULL,
    "currentName" VARCHAR(256) NOT NULL,
    "currentFullName" VARCHAR(512) NOT NULL,
    "isPrivate" BOOLEAN NOT NULL,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "isDisabled" BOOLEAN NOT NULL DEFAULT false,
    "defaultBranch" VARCHAR(1024) NOT NULL,
    "lastVerifiedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GitHubRepository_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectRepositoryLink" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "githubConnectionId" UUID NOT NULL,
    "githubRepositoryId" UUID NOT NULL,
    "status" "ProjectRepositoryLinkStatus" NOT NULL DEFAULT 'active',
    "effectivePolicyVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "disabledAt" TIMESTAMP(3),
    "unlinkedAt" TIMESTAMP(3),

    CONSTRAINT "ProjectRepositoryLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectRepositoryLinkConfigVersion" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "projectRepositoryLinkId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "role" "ProjectRepositoryRole" NOT NULL,
    "requiredForProjectSnapshot" BOOLEAN NOT NULL DEFAULT true,
    "trackedRef" VARCHAR(255) NOT NULL,
    "codeEnabled" BOOLEAN NOT NULL DEFAULT true,
    "metadataEnabled" BOOLEAN NOT NULL DEFAULT true,
    "readmeEnabled" BOOLEAN NOT NULL DEFAULT true,
    "markdownEnabled" BOOLEAN NOT NULL DEFAULT false,
    "issuesEnabled" BOOLEAN NOT NULL DEFAULT false,
    "pullRequestsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "releasesEnabled" BOOLEAN NOT NULL DEFAULT false,
    "includeRoots" JSONB NOT NULL,
    "softExcludePatterns" JSONB NOT NULL,
    "scanScopeFingerprint" VARCHAR(64) NOT NULL,
    "policyFingerprint" VARCHAR(64) NOT NULL,
    "effectivePolicyVersion" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectRepositoryLinkConfigVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectRepositoryLinkConfigPointer" (
    "projectId" UUID NOT NULL,
    "projectRepositoryLinkId" UUID NOT NULL,
    "configVersion" INTEGER NOT NULL,
    "effectivePolicyVersion" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectRepositoryLinkConfigPointer_pkey" PRIMARY KEY ("projectId","projectRepositoryLinkId")
);

-- CreateTable
CREATE TABLE "ProjectScanBatch" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "status" "ProjectScanBatchStatus" NOT NULL DEFAULT 'queued',
    "requiredManifestFingerprint" VARCHAR(64) NOT NULL,
    "expectedRequiredLinkCount" INTEGER NOT NULL,
    "expectedOptionalLinkCount" INTEGER NOT NULL,
    "completedRequiredLinkCount" INTEGER NOT NULL DEFAULT 0,
    "completedOptionalLinkCount" INTEGER NOT NULL DEFAULT 0,
    "failureCode" VARCHAR(64),
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ProjectScanBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectScanBatchEntry" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "projectScanBatchId" UUID NOT NULL,
    "projectRepositoryLinkId" UUID NOT NULL,
    "linkConfigVersion" INTEGER NOT NULL,
    "requiredForProjectSnapshot" BOOLEAN NOT NULL,
    "effectivePolicyVersion" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectScanBatchEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RepoCodeScanRun" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "projectRepositoryLinkId" UUID NOT NULL,
    "projectScanBatchId" UUID,
    "linkConfigVersion" INTEGER NOT NULL,
    "expectedEffectivePolicyVersion" INTEGER NOT NULL,
    "expectedActiveGenerationId" UUID,
    "operationKey" VARCHAR(64) NOT NULL,
    "status" "RepoCodeScanRunStatus" NOT NULL DEFAULT 'queued',
    "stage" "RepoCodeScanStage" NOT NULL DEFAULT 'queued',
    "frozenCommitSha" CHAR(40),
    "rootTreeSha" CHAR(40),
    "requestCount" INTEGER NOT NULL DEFAULT 0,
    "visitedTreeEntryCount" INTEGER NOT NULL DEFAULT 0,
    "discoveredFileCount" INTEGER NOT NULL DEFAULT 0,
    "decodedTextBytes" INTEGER NOT NULL DEFAULT 0,
    "failureCode" VARCHAR(64),
    "retryAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "RepoCodeScanRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RepositoryFile" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "projectRepositoryLinkId" UUID NOT NULL,
    "normalizedPath" VARCHAR(1024) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RepositoryFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RepositoryFileRevision" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "projectRepositoryLinkId" UUID NOT NULL,
    "repositoryFileId" UUID NOT NULL,
    "blobOid" CHAR(40) NOT NULL,
    "contentText" TEXT NOT NULL,
    "contentHash" CHAR(64) NOT NULL,
    "contentBytes" INTEGER NOT NULL,
    "lineCount" INTEGER NOT NULL,
    "scannerVersion" VARCHAR(128) NOT NULL,
    "scannerFingerprint" VARCHAR(64) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RepositoryFileRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RepositoryCodeGeneration" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "projectRepositoryLinkId" UUID NOT NULL,
    "linkConfigVersion" INTEGER NOT NULL,
    "repoCodeScanRunId" UUID NOT NULL,
    "status" "RepositoryCodeGenerationStatus" NOT NULL DEFAULT 'staging',
    "generationKey" VARCHAR(64) NOT NULL,
    "capturedGitHubRepositoryId" BIGINT NOT NULL,
    "capturedFullName" VARCHAR(512) NOT NULL,
    "frozenCommitSha" CHAR(40) NOT NULL,
    "rootTreeSha" CHAR(40) NOT NULL,
    "scanScopeFingerprint" VARCHAR(64) NOT NULL,
    "scannerVersion" VARCHAR(128) NOT NULL,
    "scannerFingerprint" VARCHAR(64) NOT NULL,
    "effectivePolicyVersion" INTEGER NOT NULL,
    "manifestFingerprint" VARCHAR(64) NOT NULL,
    "exclusionManifest" JSONB NOT NULL,
    "fileCount" INTEGER NOT NULL,
    "decodedTextBytes" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "supersededAt" TIMESTAMP(3),

    CONSTRAINT "RepositoryCodeGeneration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RepositoryCodeGenerationEntry" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "projectRepositoryLinkId" UUID NOT NULL,
    "repositoryCodeGenerationId" UUID NOT NULL,
    "repositoryFileRevisionId" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "normalizedPath" VARCHAR(1024) NOT NULL,
    "mode" CHAR(6) NOT NULL,
    "blobOid" CHAR(40) NOT NULL,
    "contentHash" CHAR(64) NOT NULL,
    "contentBytes" INTEGER NOT NULL,
    "lineCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RepositoryCodeGenerationEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RepositoryCodeGenerationPointer" (
    "projectId" UUID NOT NULL,
    "projectRepositoryLinkId" UUID NOT NULL,
    "repositoryCodeGenerationId" UUID NOT NULL,
    "linkConfigVersion" INTEGER NOT NULL,
    "effectivePolicyVersion" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RepositoryCodeGenerationPointer_pkey" PRIMARY KEY ("projectId","projectRepositoryLinkId")
);

-- CreateTable
CREATE TABLE "ProjectCodeSnapshot" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "projectScanBatchId" UUID NOT NULL,
    "status" "ProjectCodeSnapshotStatus" NOT NULL DEFAULT 'staging',
    "manifestFingerprint" VARCHAR(64) NOT NULL,
    "requiredLinkCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "supersededAt" TIMESTAMP(3),

    CONSTRAINT "ProjectCodeSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectCodeSnapshotEntry" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "projectCodeSnapshotId" UUID NOT NULL,
    "projectRepositoryLinkId" UUID NOT NULL,
    "linkConfigVersion" INTEGER NOT NULL,
    "requiredForProjectSnapshot" BOOLEAN NOT NULL DEFAULT true,
    "effectivePolicyVersion" INTEGER NOT NULL,
    "repositoryCodeGenerationId" UUID NOT NULL,
    "frozenCommitSha" CHAR(40) NOT NULL,
    "generationManifestFingerprint" VARCHAR(64) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectCodeSnapshotEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectCodeSnapshotPointer" (
    "projectId" UUID NOT NULL,
    "projectCodeSnapshotId" UUID NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectCodeSnapshotPointer_pkey" PRIMARY KEY ("projectId")
);

-- CreateIndex
CREATE INDEX "GitHubConnection_projectId_status_idx" ON "GitHubConnection"("projectId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "GitHubConnection_projectId_id_key" ON "GitHubConnection"("projectId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "GitHubConnection_projectId_connectionFingerprint_key" ON "GitHubConnection"("projectId", "connectionFingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "GitHubRepository_githubRepositoryId_key" ON "GitHubRepository"("githubRepositoryId");

-- CreateIndex
CREATE INDEX "GitHubRepository_currentFullName_idx" ON "GitHubRepository"("currentFullName");

-- CreateIndex
CREATE UNIQUE INDEX "GitHubRepository_id_githubRepositoryId_key" ON "GitHubRepository"("id", "githubRepositoryId");

-- CreateIndex
CREATE INDEX "ProjectRepositoryLink_projectId_status_idx" ON "ProjectRepositoryLink"("projectId", "status");

-- CreateIndex
CREATE INDEX "ProjectRepositoryLink_githubConnectionId_idx" ON "ProjectRepositoryLink"("githubConnectionId");

-- CreateIndex
CREATE INDEX "ProjectRepositoryLink_githubRepositoryId_idx" ON "ProjectRepositoryLink"("githubRepositoryId");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectRepositoryLink_projectId_id_key" ON "ProjectRepositoryLink"("projectId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectRepositoryLink_projectId_githubRepositoryId_key" ON "ProjectRepositoryLink"("projectId", "githubRepositoryId");

-- CreateIndex
CREATE INDEX "ProjectRepositoryLinkConfigVersion_projectId_projectReposit_idx" ON "ProjectRepositoryLinkConfigVersion"("projectId", "projectRepositoryLinkId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectRepositoryLinkConfigVersion_projectId_id_key" ON "ProjectRepositoryLinkConfigVersion"("projectId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectRepositoryLinkConfigVersion_projectId_projectReposit_key" ON "ProjectRepositoryLinkConfigVersion"("projectId", "projectRepositoryLinkId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "RepositoryLinkConfig_required_candidate_key" ON "ProjectRepositoryLinkConfigVersion"("projectId", "projectRepositoryLinkId", "version", "requiredForProjectSnapshot");

-- CreateIndex
CREATE UNIQUE INDEX "RepositoryLinkConfig_policy_candidate_key" ON "ProjectRepositoryLinkConfigVersion"("projectId", "projectRepositoryLinkId", "version", "effectivePolicyVersion");

-- CreateIndex
CREATE UNIQUE INDEX "RepositoryLinkConfig_required_policy_key" ON "ProjectRepositoryLinkConfigVersion"("projectId", "projectRepositoryLinkId", "version", "requiredForProjectSnapshot", "effectivePolicyVersion");

-- CreateIndex
CREATE INDEX "ProjectRepositoryLinkConfigPointer_projectId_configVersion_idx" ON "ProjectRepositoryLinkConfigPointer"("projectId", "configVersion");

-- CreateIndex
CREATE UNIQUE INDEX "RepoLinkConfigPointer_config_key" ON "ProjectRepositoryLinkConfigPointer"("projectId", "projectRepositoryLinkId", "configVersion");

-- CreateIndex
CREATE UNIQUE INDEX "RepoLinkConfigPointer_policy_key" ON "ProjectRepositoryLinkConfigPointer"("projectId", "projectRepositoryLinkId", "configVersion", "effectivePolicyVersion");

-- CreateIndex
CREATE INDEX "ProjectScanBatch_projectId_status_startedAt_idx" ON "ProjectScanBatch"("projectId", "status", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectScanBatch_projectId_id_key" ON "ProjectScanBatch"("projectId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectScanBatch_projectId_requiredManifestFingerprint_star_key" ON "ProjectScanBatch"("projectId", "requiredManifestFingerprint", "startedAt");

-- CreateIndex
CREATE INDEX "ProjectScanBatchEntry_projectId_projectRepositoryLinkId_lin_idx" ON "ProjectScanBatchEntry"("projectId", "projectRepositoryLinkId", "linkConfigVersion");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectScanBatchEntry_projectId_id_key" ON "ProjectScanBatchEntry"("projectId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectScanBatchEntry_projectId_projectScanBatchId_projectR_key" ON "ProjectScanBatchEntry"("projectId", "projectScanBatchId", "projectRepositoryLinkId");

-- CreateIndex
CREATE INDEX "RepoCodeScanRun_projectId_projectRepositoryLinkId_status_st_idx" ON "RepoCodeScanRun"("projectId", "projectRepositoryLinkId", "status", "startedAt");

-- CreateIndex
CREATE INDEX "RepoCodeScanRun_projectId_projectScanBatchId_idx" ON "RepoCodeScanRun"("projectId", "projectScanBatchId");

-- CreateIndex
CREATE UNIQUE INDEX "RepoCodeScanRun_projectId_id_key" ON "RepoCodeScanRun"("projectId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "RepoCodeScanRun_projectId_projectRepositoryLinkId_id_key" ON "RepoCodeScanRun"("projectId", "projectRepositoryLinkId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "RepoCodeScanRun_projectId_operationKey_key" ON "RepoCodeScanRun"("projectId", "operationKey");

-- CreateIndex
CREATE INDEX "RepositoryFile_projectId_projectRepositoryLinkId_createdAt_idx" ON "RepositoryFile"("projectId", "projectRepositoryLinkId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "RepositoryFile_projectId_id_key" ON "RepositoryFile"("projectId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "RepositoryFile_projectId_projectRepositoryLinkId_id_key" ON "RepositoryFile"("projectId", "projectRepositoryLinkId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "RepositoryFile_projectId_projectRepositoryLinkId_normalized_key" ON "RepositoryFile"("projectId", "projectRepositoryLinkId", "normalizedPath");

-- CreateIndex
CREATE INDEX "RepositoryFileRevision_projectId_projectRepositoryLinkId_re_idx" ON "RepositoryFileRevision"("projectId", "projectRepositoryLinkId", "repositoryFileId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "RepositoryFileRevision_projectId_id_key" ON "RepositoryFileRevision"("projectId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "RepositoryFileRevision_projectId_projectRepositoryLinkId_id_key" ON "RepositoryFileRevision"("projectId", "projectRepositoryLinkId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "RepositoryFileRevision_projectId_projectRepositoryLinkId_re_key" ON "RepositoryFileRevision"("projectId", "projectRepositoryLinkId", "repositoryFileId", "blobOid");

-- CreateIndex
CREATE INDEX "RepositoryCodeGeneration_projectId_projectRepositoryLinkId__idx" ON "RepositoryCodeGeneration"("projectId", "projectRepositoryLinkId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "RepositoryCodeGeneration_projectId_id_key" ON "RepositoryCodeGeneration"("projectId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "RepositoryCodeGeneration_link_id_key" ON "RepositoryCodeGeneration"("projectId", "projectRepositoryLinkId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "RepositoryCodeGeneration_run_key" ON "RepositoryCodeGeneration"("projectId", "projectRepositoryLinkId", "repoCodeScanRunId");

-- CreateIndex
CREATE UNIQUE INDEX "RepositoryCodeGeneration_projectId_generationKey_key" ON "RepositoryCodeGeneration"("projectId", "generationKey");

-- CreateIndex
CREATE INDEX "RepositoryCodeGenerationEntry_projectId_projectRepositoryLi_idx" ON "RepositoryCodeGenerationEntry"("projectId", "projectRepositoryLinkId", "repositoryFileRevisionId");

-- CreateIndex
CREATE UNIQUE INDEX "RepositoryCodeGenerationEntry_projectId_id_key" ON "RepositoryCodeGenerationEntry"("projectId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "RepositoryCodeGenerationEntry_generation_path_key" ON "RepositoryCodeGenerationEntry"("projectId", "projectRepositoryLinkId", "repositoryCodeGenerationId", "normalizedPath");

-- CreateIndex
CREATE UNIQUE INDEX "RepositoryCodeGenerationEntry_generation_ordinal_key" ON "RepositoryCodeGenerationEntry"("projectId", "projectRepositoryLinkId", "repositoryCodeGenerationId", "ordinal");

-- CreateIndex
CREATE INDEX "RepositoryCodeGenerationPointer_projectId_repositoryCodeGen_idx" ON "RepositoryCodeGenerationPointer"("projectId", "repositoryCodeGenerationId");

-- CreateIndex
CREATE UNIQUE INDEX "RepositoryCodePointer_generation_key" ON "RepositoryCodeGenerationPointer"("projectId", "projectRepositoryLinkId", "repositoryCodeGenerationId");

-- CreateIndex
CREATE INDEX "ProjectCodeSnapshot_projectId_status_createdAt_idx" ON "ProjectCodeSnapshot"("projectId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectCodeSnapshot_projectId_id_key" ON "ProjectCodeSnapshot"("projectId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectCodeSnapshot_projectId_projectScanBatchId_key" ON "ProjectCodeSnapshot"("projectId", "projectScanBatchId");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectCodeSnapshot_projectId_manifestFingerprint_key" ON "ProjectCodeSnapshot"("projectId", "manifestFingerprint");

-- CreateIndex
CREATE INDEX "ProjectCodeSnapshotEntry_projectId_projectRepositoryLinkId__idx" ON "ProjectCodeSnapshotEntry"("projectId", "projectRepositoryLinkId", "repositoryCodeGenerationId");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectCodeSnapshotEntry_projectId_id_key" ON "ProjectCodeSnapshotEntry"("projectId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectCodeSnapshotEntry_projectId_projectCodeSnapshotId_pr_key" ON "ProjectCodeSnapshotEntry"("projectId", "projectCodeSnapshotId", "projectRepositoryLinkId");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectCodeSnapshotPointer_projectId_projectCodeSnapshotId_key" ON "ProjectCodeSnapshotPointer"("projectId", "projectCodeSnapshotId");

-- AddForeignKey
ALTER TABLE "GitHubConnection" ADD CONSTRAINT "GitHubConnection_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectRepositoryLink" ADD CONSTRAINT "ProjectRepositoryLink_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectRepositoryLink" ADD CONSTRAINT "ProjectRepositoryLink_projectId_githubConnectionId_fkey" FOREIGN KEY ("projectId", "githubConnectionId") REFERENCES "GitHubConnection"("projectId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectRepositoryLink" ADD CONSTRAINT "ProjectRepositoryLink_githubRepositoryId_fkey" FOREIGN KEY ("githubRepositoryId") REFERENCES "GitHubRepository"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectRepositoryLinkConfigVersion" ADD CONSTRAINT "ProjectRepositoryLinkConfigVersion_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectRepositoryLinkConfigVersion" ADD CONSTRAINT "RepoLinkConfigVersion_link_fkey" FOREIGN KEY ("projectId", "projectRepositoryLinkId") REFERENCES "ProjectRepositoryLink"("projectId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectRepositoryLinkConfigPointer" ADD CONSTRAINT "ProjectRepositoryLinkConfigPointer_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectRepositoryLinkConfigPointer" ADD CONSTRAINT "RepoLinkConfigPointer_link_fkey" FOREIGN KEY ("projectId", "projectRepositoryLinkId") REFERENCES "ProjectRepositoryLink"("projectId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectRepositoryLinkConfigPointer" ADD CONSTRAINT "RepoLinkConfigPointer_config_fkey" FOREIGN KEY ("projectId", "projectRepositoryLinkId", "configVersion", "effectivePolicyVersion") REFERENCES "ProjectRepositoryLinkConfigVersion"("projectId", "projectRepositoryLinkId", "version", "effectivePolicyVersion") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectScanBatch" ADD CONSTRAINT "ProjectScanBatch_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectScanBatchEntry" ADD CONSTRAINT "ProjectScanBatchEntry_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectScanBatchEntry" ADD CONSTRAINT "ProjectScanBatchEntry_batch_fkey" FOREIGN KEY ("projectId", "projectScanBatchId") REFERENCES "ProjectScanBatch"("projectId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectScanBatchEntry" ADD CONSTRAINT "ProjectScanBatchEntry_link_fkey" FOREIGN KEY ("projectId", "projectRepositoryLinkId") REFERENCES "ProjectRepositoryLink"("projectId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectScanBatchEntry" ADD CONSTRAINT "ProjectScanBatchEntry_config_fkey" FOREIGN KEY ("projectId", "projectRepositoryLinkId", "linkConfigVersion", "requiredForProjectSnapshot", "effectivePolicyVersion") REFERENCES "ProjectRepositoryLinkConfigVersion"("projectId", "projectRepositoryLinkId", "version", "requiredForProjectSnapshot", "effectivePolicyVersion") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepoCodeScanRun" ADD CONSTRAINT "RepoCodeScanRun_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepoCodeScanRun" ADD CONSTRAINT "RepoCodeScanRun_link_fkey" FOREIGN KEY ("projectId", "projectRepositoryLinkId") REFERENCES "ProjectRepositoryLink"("projectId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepoCodeScanRun" ADD CONSTRAINT "RepoCodeScanRun_config_fkey" FOREIGN KEY ("projectId", "projectRepositoryLinkId", "linkConfigVersion", "expectedEffectivePolicyVersion") REFERENCES "ProjectRepositoryLinkConfigVersion"("projectId", "projectRepositoryLinkId", "version", "effectivePolicyVersion") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepoCodeScanRun" ADD CONSTRAINT "RepoCodeScanRun_batch_fkey" FOREIGN KEY ("projectId", "projectScanBatchId") REFERENCES "ProjectScanBatch"("projectId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepositoryFile" ADD CONSTRAINT "RepositoryFile_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepositoryFile" ADD CONSTRAINT "RepositoryFile_link_fkey" FOREIGN KEY ("projectId", "projectRepositoryLinkId") REFERENCES "ProjectRepositoryLink"("projectId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepositoryFileRevision" ADD CONSTRAINT "RepositoryFileRevision_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepositoryFileRevision" ADD CONSTRAINT "RepositoryFileRevision_link_fkey" FOREIGN KEY ("projectId", "projectRepositoryLinkId") REFERENCES "ProjectRepositoryLink"("projectId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepositoryFileRevision" ADD CONSTRAINT "RepositoryFileRevision_file_fkey" FOREIGN KEY ("projectId", "projectRepositoryLinkId", "repositoryFileId") REFERENCES "RepositoryFile"("projectId", "projectRepositoryLinkId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepositoryCodeGeneration" ADD CONSTRAINT "RepositoryCodeGeneration_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepositoryCodeGeneration" ADD CONSTRAINT "RepositoryCodeGeneration_link_fkey" FOREIGN KEY ("projectId", "projectRepositoryLinkId") REFERENCES "ProjectRepositoryLink"("projectId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepositoryCodeGeneration" ADD CONSTRAINT "RepositoryCodeGeneration_config_fkey" FOREIGN KEY ("projectId", "projectRepositoryLinkId", "linkConfigVersion", "effectivePolicyVersion") REFERENCES "ProjectRepositoryLinkConfigVersion"("projectId", "projectRepositoryLinkId", "version", "effectivePolicyVersion") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepositoryCodeGeneration" ADD CONSTRAINT "RepositoryCodeGeneration_run_fkey" FOREIGN KEY ("projectId", "projectRepositoryLinkId", "repoCodeScanRunId") REFERENCES "RepoCodeScanRun"("projectId", "projectRepositoryLinkId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepositoryCodeGenerationEntry" ADD CONSTRAINT "RepositoryCodeGenerationEntry_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepositoryCodeGenerationEntry" ADD CONSTRAINT "RepositoryCodeGenerationEntry_link_fkey" FOREIGN KEY ("projectId", "projectRepositoryLinkId") REFERENCES "ProjectRepositoryLink"("projectId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepositoryCodeGenerationEntry" ADD CONSTRAINT "RepositoryCodeGenerationEntry_generation_fkey" FOREIGN KEY ("projectId", "projectRepositoryLinkId", "repositoryCodeGenerationId") REFERENCES "RepositoryCodeGeneration"("projectId", "projectRepositoryLinkId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepositoryCodeGenerationEntry" ADD CONSTRAINT "RepositoryCodeGenerationEntry_revision_fkey" FOREIGN KEY ("projectId", "projectRepositoryLinkId", "repositoryFileRevisionId") REFERENCES "RepositoryFileRevision"("projectId", "projectRepositoryLinkId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepositoryCodeGenerationPointer" ADD CONSTRAINT "RepositoryCodeGenerationPointer_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepositoryCodeGenerationPointer" ADD CONSTRAINT "RepositoryCodePointer_link_fkey" FOREIGN KEY ("projectId", "projectRepositoryLinkId") REFERENCES "ProjectRepositoryLink"("projectId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepositoryCodeGenerationPointer" ADD CONSTRAINT "RepositoryCodePointer_generation_fkey" FOREIGN KEY ("projectId", "projectRepositoryLinkId", "repositoryCodeGenerationId") REFERENCES "RepositoryCodeGeneration"("projectId", "projectRepositoryLinkId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepositoryCodeGenerationPointer" ADD CONSTRAINT "RepositoryCodePointer_config_fkey" FOREIGN KEY ("projectId", "projectRepositoryLinkId", "linkConfigVersion", "effectivePolicyVersion") REFERENCES "ProjectRepositoryLinkConfigVersion"("projectId", "projectRepositoryLinkId", "version", "effectivePolicyVersion") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectCodeSnapshot" ADD CONSTRAINT "ProjectCodeSnapshot_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectCodeSnapshot" ADD CONSTRAINT "ProjectCodeSnapshot_batch_fkey" FOREIGN KEY ("projectId", "projectScanBatchId") REFERENCES "ProjectScanBatch"("projectId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectCodeSnapshotEntry" ADD CONSTRAINT "ProjectCodeSnapshotEntry_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectCodeSnapshotEntry" ADD CONSTRAINT "ProjectCodeSnapshotEntry_snapshot_fkey" FOREIGN KEY ("projectId", "projectCodeSnapshotId") REFERENCES "ProjectCodeSnapshot"("projectId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectCodeSnapshotEntry" ADD CONSTRAINT "ProjectCodeSnapshotEntry_link_fkey" FOREIGN KEY ("projectId", "projectRepositoryLinkId") REFERENCES "ProjectRepositoryLink"("projectId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectCodeSnapshotEntry" ADD CONSTRAINT "ProjectCodeSnapshotEntry_config_fkey" FOREIGN KEY ("projectId", "projectRepositoryLinkId", "linkConfigVersion", "requiredForProjectSnapshot", "effectivePolicyVersion") REFERENCES "ProjectRepositoryLinkConfigVersion"("projectId", "projectRepositoryLinkId", "version", "requiredForProjectSnapshot", "effectivePolicyVersion") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectCodeSnapshotEntry" ADD CONSTRAINT "ProjectCodeSnapshotEntry_generation_fkey" FOREIGN KEY ("projectId", "projectRepositoryLinkId", "repositoryCodeGenerationId") REFERENCES "RepositoryCodeGeneration"("projectId", "projectRepositoryLinkId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectCodeSnapshotPointer" ADD CONSTRAINT "ProjectCodeSnapshotPointer_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectCodeSnapshotPointer" ADD CONSTRAINT "ProjectCodeSnapshotPointer_snapshot_fkey" FOREIGN KEY ("projectId", "projectCodeSnapshotId") REFERENCES "ProjectCodeSnapshot"("projectId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectSource" ADD CONSTRAINT "ProjectSource_projectId_projectRepositoryLinkId_fkey" FOREIGN KEY ("projectId", "projectRepositoryLinkId") REFERENCES "ProjectRepositoryLink"("projectId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectItemEvidence" ADD CONSTRAINT "ProjectItemEvidence_projectId_projectRepositoryLinkId_fkey" FOREIGN KEY ("projectId", "projectRepositoryLinkId") REFERENCES "ProjectRepositoryLink"("projectId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SourceChunk" ADD CONSTRAINT "SourceChunk_projectId_projectRepositoryLinkId_fkey" FOREIGN KEY ("projectId", "projectRepositoryLinkId") REFERENCES "ProjectRepositoryLink"("projectId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- Cross-link compare target for an optimistic publish CAS.
ALTER TABLE "RepoCodeScanRun"
ADD CONSTRAINT "RepoCodeScanRun_expected_generation_fkey"
FOREIGN KEY ("projectId", "projectRepositoryLinkId", "expectedActiveGenerationId")
REFERENCES "RepositoryCodeGeneration"("projectId", "projectRepositoryLinkId", "id")
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- Only one unresolved project batch and one unresolved scan per repository link
-- can pass admission. Unknown continues occupying its slot until reconciled.
CREATE UNIQUE INDEX "ProjectScanBatch_pending_project_key"
ON "ProjectScanBatch"("projectId")
WHERE "status" IN ('queued', 'running', 'unknown');

CREATE UNIQUE INDEX "RepoCodeScanRun_pending_link_key"
ON "RepoCodeScanRun"("projectId", "projectRepositoryLinkId")
WHERE "status" IN ('queued', 'running', 'unknown');

ALTER TABLE "GitHubConnection"
ADD CONSTRAINT "GitHubConnection_safe_auth_ref_check"
CHECK (
  "authRef" = 'github-token-file:v1'
  AND "connectionFingerprint" ~ '^[0-9a-f]{64}$'
  AND (
    ("status" = 'verified' AND "verifiedAt" IS NOT NULL AND "disabledAt" IS NULL)
    OR ("status" = 'disabled' AND "disabledAt" IS NOT NULL)
    OR ("status" IN ('configured', 'access_unknown') AND "disabledAt" IS NULL)
  )
);

ALTER TABLE "GitHubRepository"
ADD CONSTRAINT "GitHubRepository_verified_identity_check"
CHECK (
  "githubRepositoryId" > 0
  AND "currentFullName" = "currentOwner" || '/' || "currentName"
  AND octet_length("currentFullName") <= 512
);

ALTER TABLE "ProjectRepositoryLink"
ADD CONSTRAINT "ProjectRepositoryLink_state_check"
CHECK (
  "effectivePolicyVersion" >= 1
  AND (
    ("status" IN ('active', 'access_unknown') AND "disabledAt" IS NULL AND "unlinkedAt" IS NULL)
    OR ("status" = 'disabled' AND "disabledAt" IS NOT NULL AND "unlinkedAt" IS NULL)
    OR ("status" = 'unlinked' AND "unlinkedAt" IS NOT NULL)
  )
);

ALTER TABLE "ProjectRepositoryLinkConfigVersion"
ADD CONSTRAINT "ProjectRepositoryLinkConfigVersion_contract_check"
CHECK (
  "version" >= 1
  AND "effectivePolicyVersion" >= 1
  AND "trackedRef" ~ '^refs/heads/'
  AND "scanScopeFingerprint" ~ '^[0-9a-f]{64}$'
  AND "policyFingerprint" ~ '^[0-9a-f]{64}$'
  AND jsonb_typeof("includeRoots") = 'array'
  AND jsonb_array_length("includeRoots") BETWEEN 1 AND 32
  AND jsonb_typeof("softExcludePatterns") = 'array'
  AND jsonb_array_length("softExcludePatterns") <= 64
);

ALTER TABLE "ProjectRepositoryLinkConfigPointer"
ADD CONSTRAINT "ProjectRepositoryLinkConfigPointer_version_check"
CHECK ("configVersion" >= 1 AND "effectivePolicyVersion" >= 1);

ALTER TABLE "ProjectScanBatch"
ADD CONSTRAINT "ProjectScanBatch_counts_check"
CHECK (
  "expectedRequiredLinkCount" >= 0
  AND "expectedOptionalLinkCount" >= 0
  AND "completedRequiredLinkCount" BETWEEN 0 AND "expectedRequiredLinkCount"
  AND "completedOptionalLinkCount" BETWEEN 0 AND "expectedOptionalLinkCount"
  AND "requiredManifestFingerprint" ~ '^[0-9a-f]{64}$'
  AND (
    ("status" IN ('queued', 'running', 'unknown') AND "completedAt" IS NULL)
    OR ("status" IN ('succeeded', 'partial', 'partial_optional', 'failed', 'cancelled') AND "completedAt" IS NOT NULL)
  )
);

ALTER TABLE "ProjectScanBatchEntry"
ADD CONSTRAINT "ProjectScanBatchEntry_version_check"
CHECK ("linkConfigVersion" >= 1 AND "effectivePolicyVersion" >= 1);

ALTER TABLE "RepoCodeScanRun"
ADD CONSTRAINT "RepoCodeScanRun_contract_check"
CHECK (
  "linkConfigVersion" >= 1
  AND "expectedEffectivePolicyVersion" >= 1
  AND "operationKey" ~ '^[0-9a-f]{64}$'
  AND ("frozenCommitSha" IS NULL OR "frozenCommitSha" ~ '^[0-9a-f]{40}$')
  AND ("rootTreeSha" IS NULL OR "rootTreeSha" ~ '^[0-9a-f]{40}$')
  AND "requestCount" >= 0
  AND "visitedTreeEntryCount" >= 0
  AND "discoveredFileCount" >= 0
  AND "decodedTextBytes" >= 0
  AND (
    ("status" IN ('queued', 'running', 'unknown') AND "completedAt" IS NULL)
    OR ("status" IN ('succeeded', 'failed', 'rate_limited', 'cancelled') AND "completedAt" IS NOT NULL AND "stage" = 'terminal')
  )
  AND ("status" <> 'queued' OR "stage" = 'queued')
  AND ("status" <> 'succeeded' OR ("frozenCommitSha" IS NOT NULL AND "rootTreeSha" IS NOT NULL AND "failureCode" IS NULL))
  AND ("status" <> 'rate_limited' OR "retryAt" IS NOT NULL)
);

ALTER TABLE "RepositoryFile"
ADD CONSTRAINT "RepositoryFile_normalized_path_check"
CHECK (
  octet_length("normalizedPath") BETWEEN 1 AND 1024
  AND "normalizedPath" !~ '(^/|/$|//|(^|/)\.\.?(/|$))'
  AND strpos("normalizedPath", chr(92)) = 0
);

ALTER TABLE "RepositoryFileRevision"
ADD CONSTRAINT "RepositoryFileRevision_content_check"
CHECK (
  "blobOid" ~ '^[0-9a-f]{40}$'
  AND "contentHash" ~ '^[0-9a-f]{64}$'
  AND "scannerFingerprint" ~ '^[0-9a-f]{64}$'
  AND "contentBytes" >= 0
  AND "contentBytes" = octet_length("contentText")
  AND "lineCount" >= 0
);

ALTER TABLE "RepositoryCodeGeneration"
ADD CONSTRAINT "RepositoryCodeGeneration_contract_check"
CHECK (
  "linkConfigVersion" >= 1
  AND "effectivePolicyVersion" >= 1
  AND "generationKey" ~ '^[0-9a-f]{64}$'
  AND "frozenCommitSha" ~ '^[0-9a-f]{40}$'
  AND "rootTreeSha" ~ '^[0-9a-f]{40}$'
  AND "scanScopeFingerprint" ~ '^[0-9a-f]{64}$'
  AND "scannerFingerprint" ~ '^[0-9a-f]{64}$'
  AND "manifestFingerprint" ~ '^[0-9a-f]{64}$'
  AND jsonb_typeof("exclusionManifest") = 'array'
  AND "fileCount" >= 0
  AND "decodedTextBytes" >= 0
  AND (
    ("status" = 'staging' AND "completedAt" IS NULL AND "supersededAt" IS NULL)
    OR ("status" = 'code_ready' AND "completedAt" IS NOT NULL AND "supersededAt" IS NULL)
    OR ("status" IN ('failed', 'ineligible') AND "completedAt" IS NOT NULL)
    OR ("status" = 'superseded' AND "completedAt" IS NOT NULL AND "supersededAt" IS NOT NULL)
  )
);

ALTER TABLE "RepositoryCodeGenerationEntry"
ADD CONSTRAINT "RepositoryCodeGenerationEntry_contract_check"
CHECK (
  "ordinal" >= 0
  AND "mode" IN ('100644', '100755')
  AND "blobOid" ~ '^[0-9a-f]{40}$'
  AND "contentHash" ~ '^[0-9a-f]{64}$'
  AND "contentBytes" >= 0
  AND "lineCount" >= 0
  AND octet_length("normalizedPath") BETWEEN 1 AND 1024
);

ALTER TABLE "RepositoryCodeGenerationPointer"
ADD CONSTRAINT "RepositoryCodeGenerationPointer_version_check"
CHECK ("linkConfigVersion" >= 1 AND "effectivePolicyVersion" >= 1);

ALTER TABLE "ProjectCodeSnapshot"
ADD CONSTRAINT "ProjectCodeSnapshot_contract_check"
CHECK (
  "manifestFingerprint" ~ '^[0-9a-f]{64}$'
  AND "requiredLinkCount" >= 0
  AND (
    ("status" = 'staging' AND "completedAt" IS NULL AND "supersededAt" IS NULL)
    OR ("status" = 'complete' AND "completedAt" IS NOT NULL AND "supersededAt" IS NULL)
    OR ("status" = 'ineligible' AND "completedAt" IS NOT NULL)
    OR ("status" = 'superseded' AND "completedAt" IS NOT NULL AND "supersededAt" IS NOT NULL)
  )
);

ALTER TABLE "ProjectCodeSnapshotEntry"
ADD CONSTRAINT "ProjectCodeSnapshotEntry_required_check"
CHECK (
  "requiredForProjectSnapshot" = true
  AND "linkConfigVersion" >= 1
  AND "effectivePolicyVersion" >= 1
  AND "frozenCommitSha" ~ '^[0-9a-f]{40}$'
  AND "generationManifestFingerprint" ~ '^[0-9a-f]{64}$'
);

CREATE FUNCTION "reject_github_immutable_update"()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'GITHUB_LEDGER_IMMUTABLE' USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ProjectRepositoryLinkConfigVersion_immutable"
BEFORE UPDATE ON "ProjectRepositoryLinkConfigVersion"
FOR EACH ROW EXECUTE FUNCTION "reject_github_immutable_update"();

CREATE TRIGGER "ProjectScanBatchEntry_immutable"
BEFORE UPDATE ON "ProjectScanBatchEntry"
FOR EACH ROW EXECUTE FUNCTION "reject_github_immutable_update"();

CREATE TRIGGER "RepositoryFile_immutable"
BEFORE UPDATE ON "RepositoryFile"
FOR EACH ROW EXECUTE FUNCTION "reject_github_immutable_update"();

CREATE TRIGGER "RepositoryFileRevision_immutable"
BEFORE UPDATE ON "RepositoryFileRevision"
FOR EACH ROW EXECUTE FUNCTION "reject_github_immutable_update"();

CREATE TRIGGER "RepositoryCodeGenerationEntry_immutable"
BEFORE UPDATE ON "RepositoryCodeGenerationEntry"
FOR EACH ROW EXECUTE FUNCTION "reject_github_immutable_update"();

CREATE TRIGGER "ProjectCodeSnapshotEntry_immutable"
BEFORE UPDATE ON "ProjectCodeSnapshotEntry"
FOR EACH ROW EXECUTE FUNCTION "reject_github_immutable_update"();

CREATE FUNCTION "validate_repository_code_generation_entry"()
RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "RepositoryCodeGeneration" generation
    JOIN "RepositoryFileRevision" revision
      ON revision."projectId" = generation."projectId"
     AND revision."projectRepositoryLinkId" = generation."projectRepositoryLinkId"
     AND revision."id" = NEW."repositoryFileRevisionId"
    JOIN "RepositoryFile" file
      ON file."projectId" = revision."projectId"
     AND file."projectRepositoryLinkId" = revision."projectRepositoryLinkId"
     AND file."id" = revision."repositoryFileId"
    WHERE generation."projectId" = NEW."projectId"
      AND generation."projectRepositoryLinkId" = NEW."projectRepositoryLinkId"
      AND generation."id" = NEW."repositoryCodeGenerationId"
      AND generation."status" = 'staging'
      AND NEW."ordinal" < generation."fileCount"
      AND file."normalizedPath" = NEW."normalizedPath"
      AND revision."blobOid" = NEW."blobOid"
      AND revision."contentHash" = NEW."contentHash"
      AND revision."contentBytes" = NEW."contentBytes"
      AND revision."lineCount" = NEW."lineCount"
  ) THEN
    RAISE EXCEPTION 'GITHUB_CODE_ENTRY_INTEGRITY_ERROR' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "RepositoryCodeGenerationEntry_validate"
BEFORE INSERT ON "RepositoryCodeGenerationEntry"
FOR EACH ROW EXECUTE FUNCTION "validate_repository_code_generation_entry"();

CREATE FUNCTION "validate_project_code_snapshot_entry"()
RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "ProjectCodeSnapshot" snapshot
    JOIN "ProjectScanBatchEntry" batch_entry
      ON batch_entry."projectId" = snapshot."projectId"
     AND batch_entry."projectScanBatchId" = snapshot."projectScanBatchId"
    WHERE snapshot."projectId" = NEW."projectId"
      AND snapshot."id" = NEW."projectCodeSnapshotId"
      AND snapshot."status" = 'staging'
      AND batch_entry."projectRepositoryLinkId" = NEW."projectRepositoryLinkId"
      AND batch_entry."linkConfigVersion" = NEW."linkConfigVersion"
      AND batch_entry."effectivePolicyVersion" = NEW."effectivePolicyVersion"
      AND batch_entry."requiredForProjectSnapshot" = true
      AND NEW."requiredForProjectSnapshot" = true
  ) THEN
    RAISE EXCEPTION 'PROJECT_CODE_SNAPSHOT_ENTRY_INELIGIBLE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ProjectCodeSnapshotEntry_validate"
BEFORE INSERT ON "ProjectCodeSnapshotEntry"
FOR EACH ROW EXECUTE FUNCTION "validate_project_code_snapshot_entry"();

CREATE FUNCTION "validate_repository_config_pointer"()
RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "ProjectRepositoryLink" link
    WHERE link."projectId" = NEW."projectId"
      AND link."id" = NEW."projectRepositoryLinkId"
      AND link."status" = 'active'
      AND link."effectivePolicyVersion" = NEW."effectivePolicyVersion"
  ) THEN
    RAISE EXCEPTION 'GITHUB_CONFIG_POINTER_INELIGIBLE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ProjectRepositoryLinkConfigPointer_validate"
BEFORE INSERT OR UPDATE ON "ProjectRepositoryLinkConfigPointer"
FOR EACH ROW EXECUTE FUNCTION "validate_repository_config_pointer"();

CREATE FUNCTION "validate_repository_code_pointer"()
RETURNS TRIGGER AS $$
DECLARE
  expected_generation_id UUID;
BEGIN
  SELECT run."expectedActiveGenerationId"
  INTO expected_generation_id
  FROM "RepositoryCodeGeneration" generation
  JOIN "RepoCodeScanRun" run
    ON run."projectId" = generation."projectId"
   AND run."projectRepositoryLinkId" = generation."projectRepositoryLinkId"
   AND run."id" = generation."repoCodeScanRunId"
  WHERE generation."projectId" = NEW."projectId"
    AND generation."projectRepositoryLinkId" = NEW."projectRepositoryLinkId"
    AND generation."id" = NEW."repositoryCodeGenerationId";

  IF TG_OP = 'INSERT' THEN
    IF expected_generation_id IS NOT NULL THEN
      RAISE EXCEPTION 'GITHUB_CODE_POINTER_CAS_FAILED' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."projectId" IS DISTINCT FROM OLD."projectId"
     OR NEW."projectRepositoryLinkId" IS DISTINCT FROM OLD."projectRepositoryLinkId"
     OR expected_generation_id IS DISTINCT FROM OLD."repositoryCodeGenerationId" THEN
    RAISE EXCEPTION 'GITHUB_CODE_POINTER_CAS_FAILED' USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "RepositoryCodeGeneration" generation
    JOIN "RepoCodeScanRun" run
      ON run."projectId" = generation."projectId"
     AND run."projectRepositoryLinkId" = generation."projectRepositoryLinkId"
     AND run."id" = generation."repoCodeScanRunId"
    JOIN "ProjectRepositoryLink" link
      ON link."projectId" = generation."projectId"
     AND link."id" = generation."projectRepositoryLinkId"
    JOIN "ProjectRepositoryLinkConfigPointer" config_pointer
      ON config_pointer."projectId" = generation."projectId"
     AND config_pointer."projectRepositoryLinkId" = generation."projectRepositoryLinkId"
    WHERE generation."projectId" = NEW."projectId"
      AND generation."projectRepositoryLinkId" = NEW."projectRepositoryLinkId"
      AND generation."id" = NEW."repositoryCodeGenerationId"
      AND generation."status" = 'code_ready'
      AND generation."linkConfigVersion" = NEW."linkConfigVersion"
      AND generation."effectivePolicyVersion" = NEW."effectivePolicyVersion"
      AND run."status" = 'succeeded'
      AND run."stage" = 'terminal'
      AND run."frozenCommitSha" = generation."frozenCommitSha"
      AND run."rootTreeSha" = generation."rootTreeSha"
      AND link."status" = 'active'
      AND link."effectivePolicyVersion" = NEW."effectivePolicyVersion"
      AND config_pointer."configVersion" = NEW."linkConfigVersion"
      AND config_pointer."effectivePolicyVersion" = NEW."effectivePolicyVersion"
      AND generation."fileCount" = (
        SELECT count(*)
        FROM "RepositoryCodeGenerationEntry" entry
        WHERE entry."projectId" = generation."projectId"
          AND entry."projectRepositoryLinkId" = generation."projectRepositoryLinkId"
          AND entry."repositoryCodeGenerationId" = generation."id"
      )
      AND generation."decodedTextBytes" = COALESCE((
        SELECT sum(entry."contentBytes")
        FROM "RepositoryCodeGenerationEntry" entry
        WHERE entry."projectId" = generation."projectId"
          AND entry."projectRepositoryLinkId" = generation."projectRepositoryLinkId"
          AND entry."repositoryCodeGenerationId" = generation."id"
      ), 0)
  ) THEN
    RAISE EXCEPTION 'GITHUB_CODE_POINTER_INELIGIBLE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "RepositoryCodeGenerationPointer_validate"
BEFORE INSERT OR UPDATE ON "RepositoryCodeGenerationPointer"
FOR EACH ROW EXECUTE FUNCTION "validate_repository_code_pointer"();

CREATE FUNCTION "validate_project_code_snapshot_pointer"()
RETURNS TRIGGER AS $$
DECLARE
  expected_count INTEGER;
  actual_count INTEGER;
  invalid_count INTEGER;
  missing_count INTEGER;
BEGIN
  SELECT snapshot."requiredLinkCount"
  INTO expected_count
  FROM "ProjectCodeSnapshot" snapshot
  JOIN "ProjectScanBatch" batch
    ON batch."projectId" = snapshot."projectId"
   AND batch."id" = snapshot."projectScanBatchId"
  WHERE snapshot."projectId" = NEW."projectId"
    AND snapshot."id" = NEW."projectCodeSnapshotId"
    AND snapshot."status" = 'complete'
    AND batch."status" IN ('succeeded', 'partial_optional')
    AND batch."completedRequiredLinkCount" = batch."expectedRequiredLinkCount"
    AND snapshot."requiredLinkCount" = batch."expectedRequiredLinkCount";

  IF expected_count IS NULL THEN
    RAISE EXCEPTION 'PROJECT_CODE_SNAPSHOT_INELIGIBLE' USING ERRCODE = '23514';
  END IF;

  SELECT count(*)
  INTO actual_count
  FROM "ProjectCodeSnapshotEntry" entry
  WHERE entry."projectId" = NEW."projectId"
    AND entry."projectCodeSnapshotId" = NEW."projectCodeSnapshotId";

  SELECT count(*)
  INTO invalid_count
  FROM "ProjectCodeSnapshotEntry" entry
  JOIN "RepositoryCodeGeneration" generation
    ON generation."projectId" = entry."projectId"
   AND generation."projectRepositoryLinkId" = entry."projectRepositoryLinkId"
   AND generation."id" = entry."repositoryCodeGenerationId"
  JOIN "ProjectRepositoryLink" link
    ON link."projectId" = entry."projectId"
   AND link."id" = entry."projectRepositoryLinkId"
  JOIN "ProjectRepositoryLinkConfigPointer" config_pointer
    ON config_pointer."projectId" = entry."projectId"
   AND config_pointer."projectRepositoryLinkId" = entry."projectRepositoryLinkId"
  JOIN "RepositoryCodeGenerationPointer" code_pointer
    ON code_pointer."projectId" = entry."projectId"
   AND code_pointer."projectRepositoryLinkId" = entry."projectRepositoryLinkId"
  WHERE entry."projectId" = NEW."projectId"
    AND entry."projectCodeSnapshotId" = NEW."projectCodeSnapshotId"
    AND (
      entry."requiredForProjectSnapshot" <> true
      OR generation."status" <> 'code_ready'
      OR generation."linkConfigVersion" <> entry."linkConfigVersion"
      OR generation."effectivePolicyVersion" <> entry."effectivePolicyVersion"
      OR generation."frozenCommitSha" <> entry."frozenCommitSha"
      OR generation."manifestFingerprint" <> entry."generationManifestFingerprint"
      OR link."status" <> 'active'
      OR link."effectivePolicyVersion" <> entry."effectivePolicyVersion"
      OR config_pointer."configVersion" <> entry."linkConfigVersion"
      OR config_pointer."effectivePolicyVersion" <> entry."effectivePolicyVersion"
      OR code_pointer."repositoryCodeGenerationId" <> entry."repositoryCodeGenerationId"
      OR code_pointer."linkConfigVersion" <> entry."linkConfigVersion"
      OR code_pointer."effectivePolicyVersion" <> entry."effectivePolicyVersion"
    );

  SELECT count(*)
  INTO missing_count
  FROM "ProjectCodeSnapshot" snapshot
  JOIN "ProjectScanBatchEntry" batch_entry
    ON batch_entry."projectId" = snapshot."projectId"
   AND batch_entry."projectScanBatchId" = snapshot."projectScanBatchId"
   AND batch_entry."requiredForProjectSnapshot" = true
  WHERE snapshot."projectId" = NEW."projectId"
    AND snapshot."id" = NEW."projectCodeSnapshotId"
    AND NOT EXISTS (
      SELECT 1
      FROM "ProjectCodeSnapshotEntry" entry
      WHERE entry."projectId" = snapshot."projectId"
        AND entry."projectCodeSnapshotId" = snapshot."id"
        AND entry."projectRepositoryLinkId" = batch_entry."projectRepositoryLinkId"
        AND entry."linkConfigVersion" = batch_entry."linkConfigVersion"
        AND entry."effectivePolicyVersion" = batch_entry."effectivePolicyVersion"
        AND entry."requiredForProjectSnapshot" = true
    );

  IF actual_count <> expected_count OR invalid_count <> 0 OR missing_count <> 0 THEN
    RAISE EXCEPTION 'PROJECT_CODE_SNAPSHOT_INCOMPLETE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ProjectCodeSnapshotPointer_validate"
BEFORE INSERT OR UPDATE ON "ProjectCodeSnapshotPointer"
FOR EACH ROW EXECUTE FUNCTION "validate_project_code_snapshot_pointer"();
