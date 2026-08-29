CREATE TYPE "GitProviderKind" AS ENUM ('github', 'gitee', 'gitlab', 'gitea', 'forgejo', 'generic');
CREATE TYPE "GitTransport" AS ENUM ('https', 'ssh');
CREATE TYPE "GitAuthKind" AS ENUM ('none', 'token', 'basic', 'ssh_key');
CREATE TYPE "GitConnectionStatus" AS ENUM ('configured', 'verified', 'error', 'disabled');
CREATE TYPE "GitRepositorySnapshotStatus" AS ENUM ('staging', 'complete', 'failed', 'superseded');

ALTER TYPE "BackgroundJobKind" ADD VALUE 'git_repository_sync';
ALTER TYPE "ExternalCredentialKind" ADD VALUE 'git';
ALTER TYPE "ProjectSourceKind" ADD VALUE 'git';

CREATE TABLE "GitConnection" (
    "id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "providerKind" "GitProviderKind" NOT NULL,
    "transport" "GitTransport" NOT NULL,
    "baseUrl" VARCHAR(1024) NOT NULL,
    "authKind" "GitAuthKind" NOT NULL,
    "username" VARCHAR(128),
    "credentialId" UUID,
    "allowPrivateNetwork" BOOLEAN NOT NULL DEFAULT false,
    "tlsCaCertificate" TEXT,
    "sshKnownHost" TEXT,
    "resolvedAddressFingerprint" CHAR(64),
    "status" "GitConnectionStatus" NOT NULL DEFAULT 'configured',
    "lastTestedAt" TIMESTAMP(3),
    "lastErrorCode" VARCHAR(64),
    "disabledAt" TIMESTAMP(3),
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "GitConnection_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "GitConnection_auth_check" CHECK (
        ("authKind" = 'none' AND "credentialId" IS NULL)
        OR ("authKind" <> 'none' AND "credentialId" IS NOT NULL)
    ),
    CONSTRAINT "GitConnection_transport_auth_check" CHECK (
        ("transport" = 'ssh' AND "authKind" = 'ssh_key' AND "sshKnownHost" IS NOT NULL)
        OR ("transport" = 'https' AND "authKind" <> 'ssh_key' AND "sshKnownHost" IS NULL)
    ),
    CONSTRAINT "GitConnection_tls_check" CHECK (
        "transport" = 'https' OR "tlsCaCertificate" IS NULL
    )
);

CREATE TABLE "GitRepository" (
    "id" UUID NOT NULL,
    "gitConnectionId" UUID NOT NULL,
    "repositoryPath" VARCHAR(768) NOT NULL,
    "displayName" VARCHAR(256) NOT NULL,
    "webUrl" VARCHAR(1024),
    "defaultBranch" VARCHAR(255) NOT NULL,
    "remoteIdentifier" VARCHAR(512),
    "isPrivate" BOOLEAN NOT NULL DEFAULT true,
    "lastVerifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "GitRepository_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProjectGitRepositoryLink" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "gitRepositoryId" UUID NOT NULL,
    "role" "ProjectRepositoryRole" NOT NULL,
    "trackedRef" VARCHAR(255) NOT NULL,
    "requiredForProjectSnapshot" BOOLEAN NOT NULL DEFAULT true,
    "codeEnabled" BOOLEAN NOT NULL DEFAULT true,
    "metadataEnabled" BOOLEAN NOT NULL DEFAULT true,
    "includeRoots" JSONB NOT NULL DEFAULT '["."]',
    "softExcludePatterns" JSONB NOT NULL DEFAULT '[]',
    "status" "ProjectRepositoryLinkStatus" NOT NULL DEFAULT 'active',
    "createdById" UUID NOT NULL,
    "disabledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ProjectGitRepositoryLink_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ProjectGitRepositoryLink_roots_check" CHECK (
        jsonb_typeof("includeRoots") = 'array'
        AND jsonb_typeof("softExcludePatterns") = 'array'
    )
);

CREATE TABLE "GitRepositorySnapshot" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "projectGitRepositoryLinkId" UUID NOT NULL,
    "jobId" UUID,
    "status" "GitRepositorySnapshotStatus" NOT NULL DEFAULT 'staging',
    "frozenCommitSha" VARCHAR(64),
    "manifestFingerprint" CHAR(64),
    "fileCount" INTEGER NOT NULL DEFAULT 0,
    "decodedTextBytes" INTEGER NOT NULL DEFAULT 0,
    "failureCode" VARCHAR(64),
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "supersededAt" TIMESTAMP(3),
    CONSTRAINT "GitRepositorySnapshot_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "GitRepositorySnapshot_counts_check" CHECK (
        "fileCount" >= 0 AND "decodedTextBytes" >= 0
    ),
    CONSTRAINT "GitRepositorySnapshot_terminal_check" CHECK (
        ("status" = 'staging' AND "completedAt" IS NULL)
        OR ("status" = 'complete' AND "completedAt" IS NOT NULL AND "frozenCommitSha" IS NOT NULL AND "manifestFingerprint" IS NOT NULL AND "failureCode" IS NULL)
        OR ("status" = 'failed' AND "completedAt" IS NOT NULL AND "failureCode" IS NOT NULL)
        OR ("status" = 'superseded' AND "completedAt" IS NOT NULL AND "supersededAt" IS NOT NULL)
    )
);

CREATE TABLE "GitRepositorySnapshotEntry" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "projectGitRepositoryLinkId" UUID NOT NULL,
    "gitRepositorySnapshotId" UUID NOT NULL,
    "projectSourceId" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "normalizedPath" VARCHAR(1024) NOT NULL,
    "blobOid" VARCHAR(64) NOT NULL,
    "contentHash" CHAR(64) NOT NULL,
    "contentBytes" INTEGER NOT NULL,
    "lineCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GitRepositorySnapshotEntry_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "GitRepositorySnapshotEntry_bounds_check" CHECK (
        "ordinal" >= 0 AND "contentBytes" >= 0 AND "lineCount" >= 0
    )
);

CREATE TABLE "GitRepositorySnapshotPointer" (
    "projectId" UUID NOT NULL,
    "projectGitRepositoryLinkId" UUID NOT NULL,
    "gitRepositorySnapshotId" UUID NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GitRepositorySnapshotPointer_pkey" PRIMARY KEY ("projectId", "projectGitRepositoryLinkId")
);

CREATE UNIQUE INDEX "GitConnection_name_key" ON "GitConnection"("name");
CREATE INDEX "GitConnection_providerKind_status_idx" ON "GitConnection"("providerKind", "status");
CREATE INDEX "GitConnection_createdById_createdAt_idx" ON "GitConnection"("createdById", "createdAt");
CREATE INDEX "GitRepository_gitConnectionId_updatedAt_idx" ON "GitRepository"("gitConnectionId", "updatedAt");
CREATE UNIQUE INDEX "GitRepository_gitConnectionId_repositoryPath_key" ON "GitRepository"("gitConnectionId", "repositoryPath");
CREATE INDEX "ProjectGitRepositoryLink_projectId_status_updatedAt_idx" ON "ProjectGitRepositoryLink"("projectId", "status", "updatedAt");
CREATE INDEX "ProjectGitRepositoryLink_gitRepositoryId_idx" ON "ProjectGitRepositoryLink"("gitRepositoryId");
CREATE UNIQUE INDEX "ProjectGitRepositoryLink_projectId_id_key" ON "ProjectGitRepositoryLink"("projectId", "id");
CREATE UNIQUE INDEX "ProjectGitRepositoryLink_projectId_gitRepositoryId_key" ON "ProjectGitRepositoryLink"("projectId", "gitRepositoryId");
CREATE UNIQUE INDEX "GitRepositorySnapshot_jobId_key" ON "GitRepositorySnapshot"("jobId");
CREATE INDEX "GitRepositorySnapshot_project_link_status_started_idx" ON "GitRepositorySnapshot"("projectId", "projectGitRepositoryLinkId", "status", "startedAt");
CREATE UNIQUE INDEX "GitRepositorySnapshot_projectId_id_key" ON "GitRepositorySnapshot"("projectId", "id");
CREATE UNIQUE INDEX "GitRepositorySnapshot_project_link_id_key" ON "GitRepositorySnapshot"("projectId", "projectGitRepositoryLinkId", "id");
CREATE INDEX "GitRepositorySnapshotEntry_project_source_idx" ON "GitRepositorySnapshotEntry"("projectId", "projectSourceId");
CREATE UNIQUE INDEX "GitRepositorySnapshotEntry_projectId_id_key" ON "GitRepositorySnapshotEntry"("projectId", "id");
CREATE UNIQUE INDEX "GitRepositorySnapshotEntry_snapshot_path_key" ON "GitRepositorySnapshotEntry"("projectId", "projectGitRepositoryLinkId", "gitRepositorySnapshotId", "normalizedPath");
CREATE UNIQUE INDEX "GitRepositorySnapshotPointer_snapshot_id_key" ON "GitRepositorySnapshotPointer"("gitRepositorySnapshotId");
CREATE UNIQUE INDEX "GitSnapshotPointer_snapshot_key" ON "GitRepositorySnapshotPointer"("projectId", "projectGitRepositoryLinkId", "gitRepositorySnapshotId");
CREATE INDEX "GitRepositorySnapshotPointer_project_published_idx" ON "GitRepositorySnapshotPointer"("projectId", "publishedAt");

ALTER TABLE "GitConnection" ADD CONSTRAINT "GitConnection_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "ExternalCredential"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "GitConnection" ADD CONSTRAINT "GitConnection_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "GitRepository" ADD CONSTRAINT "GitRepository_gitConnectionId_fkey" FOREIGN KEY ("gitConnectionId") REFERENCES "GitConnection"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "ProjectGitRepositoryLink" ADD CONSTRAINT "ProjectGitRepositoryLink_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectGitRepositoryLink" ADD CONSTRAINT "ProjectGitRepositoryLink_gitRepositoryId_fkey" FOREIGN KEY ("gitRepositoryId") REFERENCES "GitRepository"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "ProjectGitRepositoryLink" ADD CONSTRAINT "ProjectGitRepositoryLink_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "GitRepositorySnapshot" ADD CONSTRAINT "GitRepositorySnapshot_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GitRepositorySnapshot" ADD CONSTRAINT "GitRepositorySnapshot_link_fkey" FOREIGN KEY ("projectId", "projectGitRepositoryLinkId") REFERENCES "ProjectGitRepositoryLink"("projectId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "GitRepositorySnapshot" ADD CONSTRAINT "GitRepositorySnapshot_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "BackgroundJob"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "GitRepositorySnapshotEntry" ADD CONSTRAINT "GitRepositorySnapshotEntry_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GitRepositorySnapshotEntry" ADD CONSTRAINT "GitSnapshotEntry_link_fkey" FOREIGN KEY ("projectId", "projectGitRepositoryLinkId") REFERENCES "ProjectGitRepositoryLink"("projectId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "GitRepositorySnapshotEntry" ADD CONSTRAINT "GitSnapshotEntry_snapshot_fkey" FOREIGN KEY ("projectId", "projectGitRepositoryLinkId", "gitRepositorySnapshotId") REFERENCES "GitRepositorySnapshot"("projectId", "projectGitRepositoryLinkId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GitRepositorySnapshotEntry" ADD CONSTRAINT "GitRepositorySnapshotEntry_source_fkey" FOREIGN KEY ("projectId", "projectSourceId") REFERENCES "ProjectSource"("projectId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "GitRepositorySnapshotPointer" ADD CONSTRAINT "GitRepositorySnapshotPointer_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GitRepositorySnapshotPointer" ADD CONSTRAINT "GitSnapshotPointer_link_fkey" FOREIGN KEY ("projectId", "projectGitRepositoryLinkId") REFERENCES "ProjectGitRepositoryLink"("projectId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "GitRepositorySnapshotPointer" ADD CONSTRAINT "GitSnapshotPointer_snapshot_fkey" FOREIGN KEY ("projectId", "projectGitRepositoryLinkId", "gitRepositorySnapshotId") REFERENCES "GitRepositorySnapshot"("projectId", "projectGitRepositoryLinkId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;
