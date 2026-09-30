-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "ProjectGitRepositoryMaterialKind" AS ENUM ('issue', 'pull_request', 'release');

-- CreateEnum
CREATE TYPE "ProjectGitRepositoryMaterialCursorStatus" AS ENUM ('active', 'paused');

-- CreateEnum
CREATE TYPE "ProjectGitRepositoryMaterialRunStatus" AS ENUM ('pending', 'dispatched', 'succeeded', 'unchanged', 'failed', 'unknown');

-- CreateEnum
CREATE TYPE "ProjectGitRepositoryMaterialRunAuditAction" AS ENUM ('schedule_initialized', 'schedule_advanced', 'schedule_paused', 'run_claimed', 'run_heartbeat', 'run_dispatched', 'run_succeeded', 'run_unchanged', 'run_lease_expired_before_dispatch', 'run_lease_expired_after_dispatch', 'run_fence_rejected_before_dispatch', 'run_fence_rejected_after_dispatch');

-- Existing enums are reused by the immutable per-kind consent ledger.

ALTER TABLE public."ProjectGitRepositoryAutomationGrant"
  ADD COLUMN "issuesEnabled" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN "pullRequestsEnabled" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN "releasesEnabled" BOOLEAN NOT NULL DEFAULT FALSE;

-- CreateTable
CREATE TABLE "ProjectGitRepositoryMaterialCursor" (
    "grantId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "materialKind" "ProjectGitRepositoryMaterialKind" NOT NULL,
    "nextRunAt" TIMESTAMP(3) NOT NULL,
    "lastScheduledFor" TIMESTAMP(3),
    "status" "ProjectGitRepositoryMaterialCursorStatus" NOT NULL DEFAULT 'active',
    "pauseReason" VARCHAR(64),
    "pausedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectGitRepositoryMaterialCursor_pkey" PRIMARY KEY ("grantId","materialKind")
);

-- CreateTable
CREATE TABLE "ProjectGitRepositoryMaterialRun" (
    "id" UUID NOT NULL,
    "grantId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "gitConnectionId" UUID NOT NULL,
    "baseDelegationId" UUID NOT NULL,
    "connectionOwnerId" UUID NOT NULL,
    "materialKind" "ProjectGitRepositoryMaterialKind" NOT NULL,
    "grantVersion" INTEGER NOT NULL,
    "grantFingerprint" CHAR(64) NOT NULL,
    "baseDelegationVersion" INTEGER NOT NULL,
    "baseDelegationFingerprint" CHAR(64) NOT NULL,
    "repositoryPath" VARCHAR(768) NOT NULL,
    "trackedRef" VARCHAR(255) NOT NULL,
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "status" "ProjectGitRepositoryMaterialRunStatus" NOT NULL DEFAULT 'pending',
    "version" INTEGER NOT NULL DEFAULT 1,
    "leaseWorkerId" VARCHAR(128),
    "leaseToken" UUID,
    "leaseExpiresAt" TIMESTAMP(3),
    "dispatchedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "safeErrorCode" VARCHAR(64),
    "expectedPublicationVersionId" UUID,
    "expectedPublicationGeneration" INTEGER NOT NULL DEFAULT 0,
    "resultPublicationVersionId" UUID,
    "resultPublicationGeneration" INTEGER,
    "observedHeadCommitSha" CHAR(40),
    "manifestFingerprint" CHAR(64),
    "sourceCount" INTEGER,
    "decodedTextBytes" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectGitRepositoryMaterialRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectGitRepositoryMaterialRunAudit" (
    "id" UUID NOT NULL,
    "grantId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "runId" UUID,
    "materialKind" "ProjectGitRepositoryMaterialKind",
    "action" "ProjectGitRepositoryMaterialRunAuditAction" NOT NULL,
    "cursorVersion" INTEGER,
    "cursorStatusAfter" "ProjectGitRepositoryMaterialCursorStatus",
    "nextRunAt" TIMESTAMP(3),
    "lastScheduledFor" TIMESTAMP(3),
    "runVersion" INTEGER,
    "runStatusBefore" "ProjectGitRepositoryMaterialRunStatus",
    "runStatusAfter" "ProjectGitRepositoryMaterialRunStatus",
    "scheduledFor" TIMESTAMP(3),
    "workerId" VARCHAR(128),
    "leaseExpiresAt" TIMESTAMP(3),
    "grantVersion" INTEGER NOT NULL,
    "grantFingerprint" CHAR(64) NOT NULL,
    "reason" VARCHAR(64),
    "expectedPublicationVersionId" UUID,
    "expectedPublicationGeneration" INTEGER,
    "publicationVersionId" UUID,
    "publicationGeneration" INTEGER,
    "manifestFingerprint" CHAR(64),
    "sourceCount" INTEGER,
    "decodedTextBytes" INTEGER,
    "transactionId" BIGINT NOT NULL DEFAULT txid_current(),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectGitRepositoryMaterialRunAudit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectGitRepositoryMaterialConsentAudit" (
    "id" UUID NOT NULL,
    "grantId" UUID NOT NULL,
    "grantVersion" INTEGER NOT NULL,
    "action" "ProjectGitRepositoryAutomationGrantAuditAction" NOT NULL,
    "statusBefore" "ProjectGitRepositoryAutomationGrantStatus",
    "statusAfter" "ProjectGitRepositoryAutomationGrantStatus" NOT NULL,
    "issuesEnabled" BOOLEAN NOT NULL,
    "pullRequestsEnabled" BOOLEAN NOT NULL,
    "releasesEnabled" BOOLEAN NOT NULL,
    "transitionAt" TIMESTAMP(3) NOT NULL,
    "transactionId" BIGINT NOT NULL DEFAULT txid_current(),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectGitRepositoryMaterialConsentAudit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectGitRepositoryMaterialPublicationVersion" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "grantId" UUID NOT NULL,
    "materialKind" "ProjectGitRepositoryMaterialKind" NOT NULL,
    "runId" UUID NOT NULL,
    "previousVersionId" UUID,
    "previousGeneration" INTEGER NOT NULL DEFAULT 0,
    "grantVersion" INTEGER NOT NULL,
    "grantFingerprint" CHAR(64) NOT NULL,
    "baseDelegationId" UUID NOT NULL,
    "baseDelegationVersion" INTEGER NOT NULL,
    "baseDelegationFingerprint" CHAR(64) NOT NULL,
    "repositoryPath" VARCHAR(768) NOT NULL,
    "trackedRef" VARCHAR(255) NOT NULL,
    "githubRepositoryId" BIGINT NOT NULL,
    "githubRepositoryNodeId" VARCHAR(512) NOT NULL,
    "observedHeadCommitSha" CHAR(40) NOT NULL,
    "manifestFingerprint" CHAR(64) NOT NULL,
    "sourceCount" INTEGER NOT NULL,
    "decodedTextBytes" INTEGER NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectGitRepositoryMaterialPublicationVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectGitRepositoryMaterialPublicationHead" (
    "projectId" UUID NOT NULL,
    "grantId" UUID NOT NULL,
    "materialKind" "ProjectGitRepositoryMaterialKind" NOT NULL,
    "currentVersionId" UUID NOT NULL,
    "generation" INTEGER NOT NULL DEFAULT 1,
    "publishedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectGitRepositoryMaterialPublicationHead_pkey" PRIMARY KEY ("projectId","grantId","materialKind")
);

-- CreateTable
CREATE TABLE "ProjectGitRepositoryMaterialPublicationEntry" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "grantId" UUID NOT NULL,
    "materialKind" "ProjectGitRepositoryMaterialKind" NOT NULL,
    "publicationVersionId" UUID NOT NULL,
    "sourceVersionId" UUID NOT NULL,
    "projectSourceId" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "remoteIdentity" VARCHAR(512) NOT NULL,
    "remoteRevisionFingerprint" CHAR(64) NOT NULL,
    "externalRef" VARCHAR(1024) NOT NULL,
    "contentHash" CHAR(64) NOT NULL,
    "contentBytes" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectGitRepositoryMaterialPublicationEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectGitRepositoryMaterialSourceVersion" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "grantId" UUID NOT NULL,
    "materialKind" "ProjectGitRepositoryMaterialKind" NOT NULL,
    "publicationVersionId" UUID NOT NULL,
    "projectSourceId" UUID NOT NULL,
    "sourceIdentity" UUID NOT NULL,
    "revisionKey" UUID NOT NULL,
    "originScope" "ContentOriginScope" NOT NULL DEFAULT 'project',
    "remoteIdentity" VARCHAR(512) NOT NULL,
    "remoteRevisionFingerprint" CHAR(64) NOT NULL,
    "remoteNumber" INTEGER,
    "externalRef" VARCHAR(1024) NOT NULL,
    "contentHash" CHAR(64) NOT NULL,
    "contentBytes" INTEGER NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectGitRepositoryMaterialSourceVersion_pkey" PRIMARY KEY ("id")
);

-- Every new ProjectSource foreign-key consumer rejects references to legacy
-- quarantined MCP material. The code publication entry table predates this
-- migration and receives the missing guard here without rewriting history.
-- The original trigger function resolves ProjectSource against the caller's
-- search_path. These SECURITY DEFINER publishers run with pg_catalog only, so
-- replace the implementation with the same invoker policy and an explicit
-- schema-qualified lookup before installing the new ledger triggers.
CREATE OR REPLACE FUNCTION public."legacy_mcp_source_reference_guard"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  referenced_source_id UUID;
BEGIN
  referenced_source_id := NULLIF(pg_catalog.to_jsonb(NEW) ->> TG_ARGV[0], '')::uuid;
  IF referenced_source_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public."ProjectSource" AS source
     WHERE source."projectId" = NEW."projectId"
       AND source."id" = referenced_source_id
       AND source."kind"::text = 'mcp'
  ) THEN
    RAISE EXCEPTION 'LEGACY_MCP_SOURCE_REFERENCE_FORBIDDEN' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ProjectGitPublicationEntry_LegacyMcpSourceReference_guard"
BEFORE INSERT OR UPDATE ON public."ProjectGitRepositoryPublicationEntry"
FOR EACH ROW EXECUTE FUNCTION public."legacy_mcp_source_reference_guard"('projectSourceId');
CREATE TRIGGER "ProjectGitMaterialPublicationEntry_LegacyMcpSourceReference_guard"
BEFORE INSERT OR UPDATE ON public."ProjectGitRepositoryMaterialPublicationEntry"
FOR EACH ROW EXECUTE FUNCTION public."legacy_mcp_source_reference_guard"('projectSourceId');
CREATE TRIGGER "ProjectGitMaterialSourceVersion_LegacyMcpSourceReference_guard"
BEFORE INSERT OR UPDATE ON public."ProjectGitRepositoryMaterialSourceVersion"
FOR EACH ROW EXECUTE FUNCTION public."legacy_mcp_source_reference_guard"('projectSourceId');

-- CreateIndex
CREATE INDEX "ProjectGitRepositoryMaterialCursor_status_nextRunAt_idx" ON "ProjectGitRepositoryMaterialCursor"("status", "nextRunAt");

-- CreateIndex
CREATE INDEX "ProjectGitRepositoryMaterialCursor_projectId_status_idx" ON "ProjectGitRepositoryMaterialCursor"("projectId", "status");

-- CreateIndex
CREATE INDEX "ProjectGitRepositoryMaterialRun_status_leaseExpiresAt_idx" ON "ProjectGitRepositoryMaterialRun"("status", "leaseExpiresAt");

-- CreateIndex
CREATE INDEX "ProjectGitRepositoryMaterialRun_projectId_createdAt_idx" ON "ProjectGitRepositoryMaterialRun"("projectId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectGitRepositoryMaterialRun_grantId_materialKind_schedu_key" ON "ProjectGitRepositoryMaterialRun"("grantId", "materialKind", "scheduledFor");

-- CreateIndex
CREATE INDEX "ProjectGitRepositoryMaterialRunAudit_projectId_createdAt_idx" ON "ProjectGitRepositoryMaterialRunAudit"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "ProjectGitRepositoryMaterialRunAudit_grantId_createdAt_idx" ON "ProjectGitRepositoryMaterialRunAudit"("grantId", "createdAt");

-- CreateIndex
CREATE INDEX "ProjectGitRepositoryMaterialRunAudit_transactionId_createdA_idx" ON "ProjectGitRepositoryMaterialRunAudit"("transactionId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectGitRepositoryMaterialRunAudit_grantId_materialKind_c_key" ON "ProjectGitRepositoryMaterialRunAudit"("grantId", "materialKind", "cursorVersion");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectGitRepositoryMaterialRunAudit_runId_runVersion_key" ON "ProjectGitRepositoryMaterialRunAudit"("runId", "runVersion");

-- CreateIndex
CREATE INDEX "ProjectGitRepositoryMaterialConsentAudit_grantId_createdAt_idx" ON "ProjectGitRepositoryMaterialConsentAudit"("grantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectGitRepositoryMaterialConsentAudit_grantId_grantVersi_key" ON "ProjectGitRepositoryMaterialConsentAudit"("grantId", "grantVersion");

-- CreateIndex
CREATE INDEX "ProjectGitRepositoryMaterialPublicationVersion_projectId_gr_idx" ON "ProjectGitRepositoryMaterialPublicationVersion"("projectId", "grantId", "materialKind", "publishedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectGitRepositoryMaterialPublicationVersion_projectId_gr_key" ON "ProjectGitRepositoryMaterialPublicationVersion"("projectId", "grantId", "materialKind", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectGitRepositoryMaterialPublicationVersion_grantId_mate_key" ON "ProjectGitRepositoryMaterialPublicationVersion"("grantId", "materialKind", "runId");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectGitRepositoryMaterialPublicationHead_projectId_grant_key" ON "ProjectGitRepositoryMaterialPublicationHead"("projectId", "grantId", "materialKind", "currentVersionId");

-- CreateIndex
CREATE INDEX "ProjectGitRepositoryMaterialPublicationEntry_projectId_proj_idx" ON "ProjectGitRepositoryMaterialPublicationEntry"("projectId", "projectSourceId");

-- CreateIndex
CREATE INDEX "ProjectGitRepositoryMaterialPublicationEntry_grantId_materi_idx" ON "ProjectGitRepositoryMaterialPublicationEntry"("grantId", "materialKind", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PGMRPE_project_version_identity_key" ON "ProjectGitRepositoryMaterialPublicationEntry"("projectId", "publicationVersionId", "remoteIdentity");

-- CreateIndex
CREATE UNIQUE INDEX "PGMRPE_project_version_ordinal_key" ON "ProjectGitRepositoryMaterialPublicationEntry"("projectId", "publicationVersionId", "ordinal");

-- CreateIndex
CREATE INDEX "ProjectGitRepositoryMaterialSourceVersion_projectId_grantId_idx" ON "ProjectGitRepositoryMaterialSourceVersion"("projectId", "grantId", "materialKind", "capturedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectGitRepositoryMaterialSourceVersion_projectId_grantId_key" ON "ProjectGitRepositoryMaterialSourceVersion"("projectId", "grantId", "materialKind", "remoteIdentity", "remoteRevisionFingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectGitRepositoryMaterialSourceVersion_projectId_sourceI_key" ON "ProjectGitRepositoryMaterialSourceVersion"("projectId", "sourceIdentity", "revisionKey");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectGitRepositoryMaterialSourceVersion_projectId_publica_key" ON "ProjectGitRepositoryMaterialSourceVersion"("projectId", "publicationVersionId", "projectSourceId");

ALTER TABLE public."ProjectGitRepositoryMaterialCursor"
  ADD CONSTRAINT "PGMRMC_grant_fkey" FOREIGN KEY ("grantId") REFERENCES public."ProjectGitRepositoryAutomationGrant"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PGMRMC_project_fkey" FOREIGN KEY ("projectId") REFERENCES public."Project"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PGMRMC_workspace_fkey" FOREIGN KEY ("workspaceId") REFERENCES public."Workspace"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PGMRMC_version_check" CHECK ("version" > 0);

ALTER TABLE public."ProjectGitRepositoryMaterialRun"
  ADD CONSTRAINT "PGMRMR_grant_fkey" FOREIGN KEY ("grantId") REFERENCES public."ProjectGitRepositoryAutomationGrant"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PGMRMR_project_fkey" FOREIGN KEY ("projectId") REFERENCES public."Project"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PGMRMR_workspace_fkey" FOREIGN KEY ("workspaceId") REFERENCES public."Workspace"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PGMRMR_connection_fkey" FOREIGN KEY ("gitConnectionId") REFERENCES public."GitConnection"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PGMRMR_delegation_fkey" FOREIGN KEY ("baseDelegationId") REFERENCES public."ProjectGitRepositoryDelegation"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PGMRMR_owner_fkey" FOREIGN KEY ("connectionOwnerId") REFERENCES public."AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PGMRMR_version_check" CHECK ("version" > 0),
  ADD CONSTRAINT "PGMRMR_snapshot_check" CHECK ("grantVersion" > 0 AND "baseDelegationVersion" > 0
    AND "grantFingerprint" ~ '^[0-9a-f]{64}$' AND "baseDelegationFingerprint" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "PGMRMR_repository_identity_check" CHECK (
    "repositoryPath" ~ '^[A-Za-z0-9-]+/[A-Za-z0-9_.-]+$'
    AND char_length("trackedRef") BETWEEN 1 AND 255
    AND "trackedRef" !~ '[[:cntrl:]]');

ALTER TABLE public."ProjectGitRepositoryMaterialPublicationVersion"
  ADD CONSTRAINT "PGMRMPV_project_fkey" FOREIGN KEY ("projectId") REFERENCES public."Project"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PGMRMPV_grant_fkey" FOREIGN KEY ("grantId") REFERENCES public."ProjectGitRepositoryAutomationGrant"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PGMRMPV_run_fkey" FOREIGN KEY ("runId") REFERENCES public."ProjectGitRepositoryMaterialRun"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PGMRMPV_previous_fkey" FOREIGN KEY ("previousVersionId") REFERENCES public."ProjectGitRepositoryMaterialPublicationVersion"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PGMRMPV_identity_check" CHECK ("githubRepositoryId" > 0 AND char_length("githubRepositoryNodeId") BETWEEN 1 AND 512),
  ADD CONSTRAINT "PGMRMPV_generation_check" CHECK ("previousGeneration" >= 0 AND "sourceCount" >= 0 AND "decodedTextBytes" >= 0
    AND "manifestFingerprint" ~ '^[0-9a-f]{64}$' AND "grantFingerprint" ~ '^[0-9a-f]{64}$'
    AND "baseDelegationFingerprint" ~ '^[0-9a-f]{64}$');

ALTER TABLE public."ProjectGitRepositoryMaterialPublicationHead"
  ADD CONSTRAINT "PGMRMPH_project_fkey" FOREIGN KEY ("projectId") REFERENCES public."Project"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PGMRMPH_grant_fkey" FOREIGN KEY ("grantId") REFERENCES public."ProjectGitRepositoryAutomationGrant"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PGMRMPH_version_fkey" FOREIGN KEY ("currentVersionId") REFERENCES public."ProjectGitRepositoryMaterialPublicationVersion"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PGMRMPH_generation_check" CHECK ("generation" > 0);

ALTER TABLE public."ProjectGitRepositoryMaterialPublicationEntry"
  ADD CONSTRAINT "PGMRMPE_project_fkey" FOREIGN KEY ("projectId") REFERENCES public."Project"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PGMRMPE_grant_fkey" FOREIGN KEY ("grantId") REFERENCES public."ProjectGitRepositoryAutomationGrant"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PGMRMPE_version_fkey" FOREIGN KEY ("publicationVersionId") REFERENCES public."ProjectGitRepositoryMaterialPublicationVersion"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PGMRMPE_source_version_fkey" FOREIGN KEY ("sourceVersionId") REFERENCES public."ProjectGitRepositoryMaterialSourceVersion"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PGMRMPE_project_source_fkey" FOREIGN KEY ("projectId", "projectSourceId") REFERENCES public."ProjectSource"("projectId", "id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PGMRMPE_fingerprint_check" CHECK ("remoteRevisionFingerprint" ~ '^[0-9a-f]{64}$' AND "contentHash" ~ '^[0-9a-f]{64}$' AND "contentBytes" >= 0);

ALTER TABLE public."ProjectGitRepositoryMaterialSourceVersion"
  ADD CONSTRAINT "PGMRMSV_project_fkey" FOREIGN KEY ("projectId") REFERENCES public."Project"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PGMRMSV_grant_fkey" FOREIGN KEY ("grantId") REFERENCES public."ProjectGitRepositoryAutomationGrant"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PGMRMSV_version_fkey" FOREIGN KEY ("publicationVersionId") REFERENCES public."ProjectGitRepositoryMaterialPublicationVersion"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PGMRMSV_project_source_fkey" FOREIGN KEY ("projectId", "projectSourceId") REFERENCES public."ProjectSource"("projectId", "id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PGMRMSV_fingerprint_check" CHECK ("remoteRevisionFingerprint" ~ '^[0-9a-f]{64}$' AND "contentHash" ~ '^[0-9a-f]{64}$' AND "contentBytes" >= 0);

-- New kinds are explicit consent fields. Upgrades backfill all three to false
-- and no subsequent status transition may silently broaden the granted scope.
CREATE OR REPLACE FUNCTION public."project_git_material_guard_grant_scope"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (
    OLD."issuesEnabled" IS DISTINCT FROM NEW."issuesEnabled"
    OR OLD."pullRequestsEnabled" IS DISTINCT FROM NEW."pullRequestsEnabled"
    OR OLD."releasesEnabled" IS DISTINCT FROM NEW."releasesEnabled"
  ) THEN
    RAISE EXCEPTION 'PROJECT_GIT_MATERIAL_CONSENT_IMMUTABLE' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."issuesEnabled" OR NEW."pullRequestsEnabled" OR NEW."releasesEnabled" THEN
    IF NOT EXISTS (
      SELECT 1 FROM public."GitConnection" connection_row
       WHERE connection_row."id" = NEW."gitConnectionId"
         AND connection_row."providerKind" = 'github'
         AND connection_row."transport" = 'https'
         AND connection_row."authKind" = 'token'
         AND connection_row."baseUrl" IN ('https://github.com', 'https://github.com/')
    ) OR NEW."repositoryPath" !~ '^[A-Za-z0-9-]+/[A-Za-z0-9_.-]+$' THEN
      RAISE EXCEPTION 'PROJECT_GIT_MATERIAL_GITHUB_TOKEN_CONNECTION_REQUIRED' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "PGMRM_consent_scope_guard"
BEFORE INSERT OR UPDATE ON public."ProjectGitRepositoryAutomationGrant"
FOR EACH ROW EXECUTE FUNCTION public."project_git_material_guard_grant_scope"();

CREATE OR REPLACE FUNCTION public."project_git_material_consent_audit_capture"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  transition_action public."ProjectGitRepositoryAutomationGrantAuditAction";
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."status" IS NOT DISTINCT FROM NEW."status" THEN RETURN NULL; END IF;
  transition_action := CASE
    WHEN TG_OP = 'INSERT' THEN 'proposed'::public."ProjectGitRepositoryAutomationGrantAuditAction"
    ELSE CASE NEW."status"
      WHEN 'owner_confirmed' THEN 'owner_confirmed'::public."ProjectGitRepositoryAutomationGrantAuditAction"
      WHEN 'active' THEN 'activated'::public."ProjectGitRepositoryAutomationGrantAuditAction"
      WHEN 'rejected' THEN 'rejected'::public."ProjectGitRepositoryAutomationGrantAuditAction"
      WHEN 'revoked' THEN 'revoked'::public."ProjectGitRepositoryAutomationGrantAuditAction"
      WHEN 'expired' THEN 'expired'::public."ProjectGitRepositoryAutomationGrantAuditAction"
      ELSE 'invalidated'::public."ProjectGitRepositoryAutomationGrantAuditAction"
    END
  END;
  INSERT INTO public."ProjectGitRepositoryMaterialConsentAudit" (
    "id", "grantId", "grantVersion", "action", "statusBefore", "statusAfter",
    "issuesEnabled", "pullRequestsEnabled", "releasesEnabled", "transitionAt"
  ) VALUES (
    pg_catalog.gen_random_uuid(), NEW."id", NEW."version", transition_action,
    CASE WHEN TG_OP = 'UPDATE' THEN OLD."status" ELSE NULL END, NEW."status",
    NEW."issuesEnabled", NEW."pullRequestsEnabled", NEW."releasesEnabled",
    pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp() AT TIME ZONE 'UTC')
  );
  RETURN NULL;
END;
$$;
CREATE TRIGGER "PGMRM_consent_audit_capture"
AFTER INSERT OR UPDATE ON public."ProjectGitRepositoryAutomationGrant"
FOR EACH ROW EXECUTE FUNCTION public."project_git_material_consent_audit_capture"();

CREATE OR REPLACE FUNCTION public."project_git_material_append_only_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'PROJECT_GIT_MATERIAL_LEDGER_IMMUTABLE' USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER "PGMRM_consent_audit_immutable"
BEFORE UPDATE OR DELETE ON public."ProjectGitRepositoryMaterialConsentAudit"
FOR EACH ROW EXECUTE FUNCTION public."project_git_material_append_only_guard"();
CREATE TRIGGER "PGMRM_consent_audit_no_truncate"
BEFORE TRUNCATE ON public."ProjectGitRepositoryMaterialConsentAudit"
FOR EACH STATEMENT EXECUTE FUNCTION public."project_git_material_append_only_guard"();
CREATE TRIGGER "PGMRM_run_audit_immutable"
BEFORE UPDATE OR DELETE ON public."ProjectGitRepositoryMaterialRunAudit"
FOR EACH ROW EXECUTE FUNCTION public."project_git_material_append_only_guard"();
CREATE TRIGGER "PGMRM_run_audit_no_truncate"
BEFORE TRUNCATE ON public."ProjectGitRepositoryMaterialRunAudit"
FOR EACH STATEMENT EXECUTE FUNCTION public."project_git_material_append_only_guard"();
CREATE TRIGGER "PGMRM_publication_version_immutable"
BEFORE UPDATE OR DELETE ON public."ProjectGitRepositoryMaterialPublicationVersion"
FOR EACH ROW EXECUTE FUNCTION public."project_git_material_append_only_guard"();
CREATE TRIGGER "PGMRM_publication_version_no_truncate"
BEFORE TRUNCATE ON public."ProjectGitRepositoryMaterialPublicationVersion"
FOR EACH STATEMENT EXECUTE FUNCTION public."project_git_material_append_only_guard"();
CREATE TRIGGER "PGMRM_publication_entry_immutable"
BEFORE UPDATE OR DELETE ON public."ProjectGitRepositoryMaterialPublicationEntry"
FOR EACH ROW EXECUTE FUNCTION public."project_git_material_append_only_guard"();
CREATE TRIGGER "PGMRM_publication_entry_no_truncate"
BEFORE TRUNCATE ON public."ProjectGitRepositoryMaterialPublicationEntry"
FOR EACH STATEMENT EXECUTE FUNCTION public."project_git_material_append_only_guard"();
CREATE TRIGGER "PGMRM_source_version_immutable"
BEFORE UPDATE OR DELETE ON public."ProjectGitRepositoryMaterialSourceVersion"
FOR EACH ROW EXECUTE FUNCTION public."project_git_material_append_only_guard"();
CREATE TRIGGER "PGMRM_source_version_no_truncate"
BEFORE TRUNCATE ON public."ProjectGitRepositoryMaterialSourceVersion"
FOR EACH STATEMENT EXECUTE FUNCTION public."project_git_material_append_only_guard"();

CREATE OR REPLACE FUNCTION public."project_git_material_cursor_shape_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  transition_action TEXT := pg_catalog.current_setting('ai_project_os.git_material_transition', TRUE);
  grant_row public."ProjectGitRepositoryAutomationGrant"%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF transition_action IS DISTINCT FROM 'initialize' OR NEW."version" <> 1 OR NEW."status" <> 'active'
       OR NEW."pauseReason" IS NOT NULL OR NEW."pausedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'PROJECT_GIT_MATERIAL_CURSOR_CREATE_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    SELECT * INTO grant_row FROM public."ProjectGitRepositoryAutomationGrant" WHERE "id" = NEW."grantId";
    IF NOT FOUND OR grant_row."status" <> 'active' OR grant_row."projectId" IS DISTINCT FROM NEW."projectId"
       OR NOT (CASE NEW."materialKind" WHEN 'issue' THEN grant_row."issuesEnabled"
          WHEN 'pull_request' THEN grant_row."pullRequestsEnabled" ELSE grant_row."releasesEnabled" END)
       OR NEW."nextRunAt" IS DISTINCT FROM grant_row."activatedAt" + grant_row."runIntervalMinutes" * INTERVAL '1 minute' THEN
      RAISE EXCEPTION 'PROJECT_GIT_MATERIAL_CURSOR_GRANT_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."grantId" IS DISTINCT FROM NEW."grantId" OR OLD."projectId" IS DISTINCT FROM NEW."projectId"
     OR OLD."workspaceId" IS DISTINCT FROM NEW."workspaceId" OR OLD."materialKind" IS DISTINCT FROM NEW."materialKind"
     OR NEW."version" <> OLD."version" + 1
     OR transition_action IS NULL OR transition_action NOT IN ('claim', 'grant_terminal', 'run_unknown', 'reconcile') THEN
    RAISE EXCEPTION 'PROJECT_GIT_MATERIAL_CURSOR_TRANSITION_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'paused' THEN
    IF NEW."pauseReason" IS NULL OR NEW."pausedAt" IS NULL THEN
      RAISE EXCEPTION 'PROJECT_GIT_MATERIAL_CURSOR_PAUSE_EVIDENCE_REQUIRED' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."status" <> 'active' OR NEW."pauseReason" IS NOT NULL OR NEW."pausedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'PROJECT_GIT_MATERIAL_CURSOR_STATE_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "PGMRM_cursor_shape_guard"
BEFORE INSERT OR UPDATE ON public."ProjectGitRepositoryMaterialCursor"
FOR EACH ROW EXECUTE FUNCTION public."project_git_material_cursor_shape_guard"();

CREATE OR REPLACE FUNCTION public."project_git_material_run_shape_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  transition_action TEXT := pg_catalog.current_setting('ai_project_os.git_material_transition', TRUE);
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF transition_action IS DISTINCT FROM 'claim' OR SESSION_USER IS DISTINCT FROM 'ai_project_os_git_automation_worker'
       OR NEW."status" <> 'pending' OR NEW."version" <> 1
       OR NEW."leaseWorkerId" IS NULL OR NEW."leaseToken" IS NULL OR NEW."leaseExpiresAt" IS NULL
       OR NEW."completedAt" IS NOT NULL OR NEW."dispatchedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'PROJECT_GIT_MATERIAL_RUN_CREATE_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."grantId" IS DISTINCT FROM OLD."grantId"
     OR NEW."projectId" IS DISTINCT FROM OLD."projectId" OR NEW."workspaceId" IS DISTINCT FROM OLD."workspaceId"
     OR NEW."gitConnectionId" IS DISTINCT FROM OLD."gitConnectionId" OR NEW."baseDelegationId" IS DISTINCT FROM OLD."baseDelegationId"
     OR NEW."connectionOwnerId" IS DISTINCT FROM OLD."connectionOwnerId" OR NEW."materialKind" IS DISTINCT FROM OLD."materialKind"
     OR NEW."grantVersion" IS DISTINCT FROM OLD."grantVersion" OR NEW."grantFingerprint" IS DISTINCT FROM OLD."grantFingerprint"
     OR NEW."baseDelegationVersion" IS DISTINCT FROM OLD."baseDelegationVersion"
     OR NEW."baseDelegationFingerprint" IS DISTINCT FROM OLD."baseDelegationFingerprint"
     OR NEW."repositoryPath" IS DISTINCT FROM OLD."repositoryPath" OR NEW."trackedRef" IS DISTINCT FROM OLD."trackedRef"
     OR NEW."scheduledFor" IS DISTINCT FROM OLD."scheduledFor" OR NEW."expectedPublicationVersionId" IS DISTINCT FROM OLD."expectedPublicationVersionId"
     OR NEW."expectedPublicationGeneration" IS DISTINCT FROM OLD."expectedPublicationGeneration"
     OR NEW."leaseWorkerId" IS DISTINCT FROM OLD."leaseWorkerId" OR NEW."leaseToken" IS DISTINCT FROM OLD."leaseToken"
     OR NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'PROJECT_GIT_MATERIAL_RUN_SNAPSHOT_IMMUTABLE' USING ERRCODE = 'check_violation';
  END IF;
  IF transition_action = 'dispatch' THEN
    IF OLD."status" <> 'pending' OR NEW."status" <> 'dispatched' OR NEW."dispatchedAt" IS NULL THEN
      RAISE EXCEPTION 'PROJECT_GIT_MATERIAL_RUN_DISPATCH_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF transition_action = 'heartbeat' THEN
    IF OLD."status" <> 'dispatched' OR NEW."status" <> 'dispatched'
       OR NEW."leaseExpiresAt" <= OLD."leaseExpiresAt" THEN
      RAISE EXCEPTION 'PROJECT_GIT_MATERIAL_RUN_HEARTBEAT_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF transition_action = 'finalize' THEN
    IF OLD."status" <> 'dispatched' OR NEW."status" NOT IN ('succeeded', 'unchanged', 'failed')
       OR NEW."completedAt" IS NULL THEN
      RAISE EXCEPTION 'PROJECT_GIT_MATERIAL_RUN_FINALIZE_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF transition_action IN ('reconcile', 'grant_terminal') THEN
    IF NOT ((OLD."status" = 'pending' AND NEW."status" = 'failed')
      OR (OLD."status" = 'dispatched' AND NEW."status" = 'unknown'))
       OR NEW."completedAt" IS NULL THEN
      RAISE EXCEPTION 'PROJECT_GIT_MATERIAL_RUN_RECONCILE_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    RAISE EXCEPTION 'PROJECT_GIT_MATERIAL_RUN_TRANSITION_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "PGMRM_run_shape_guard"
BEFORE INSERT OR UPDATE ON public."ProjectGitRepositoryMaterialRun"
FOR EACH ROW EXECUTE FUNCTION public."project_git_material_run_shape_guard"();

CREATE OR REPLACE FUNCTION public."project_git_material_cursor_audit_capture"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  grant_row public."ProjectGitRepositoryAutomationGrant"%ROWTYPE;
  action_value public."ProjectGitRepositoryMaterialRunAuditAction";
BEGIN
  SELECT * INTO grant_row FROM public."ProjectGitRepositoryAutomationGrant" WHERE "id" = NEW."grantId";
  IF NOT FOUND THEN RAISE EXCEPTION 'PROJECT_GIT_MATERIAL_GRANT_NOT_FOUND' USING ERRCODE = 'foreign_key_violation'; END IF;
  action_value := CASE WHEN TG_OP = 'INSERT' THEN 'schedule_initialized'::public."ProjectGitRepositoryMaterialRunAuditAction"
    WHEN NEW."status" = 'paused' THEN 'schedule_paused'::public."ProjectGitRepositoryMaterialRunAuditAction"
    ELSE 'schedule_advanced'::public."ProjectGitRepositoryMaterialRunAuditAction" END;
  INSERT INTO public."ProjectGitRepositoryMaterialRunAudit" (
    "id", "grantId", "projectId", "materialKind", "action", "cursorVersion", "cursorStatusAfter",
    "nextRunAt", "lastScheduledFor", "grantVersion", "grantFingerprint", "reason"
  ) VALUES (
    pg_catalog.gen_random_uuid(), NEW."grantId", NEW."projectId", NEW."materialKind", action_value,
    NEW."version", NEW."status", NEW."nextRunAt", NEW."lastScheduledFor",
    grant_row."version", grant_row."grantFingerprint", NEW."pauseReason"
  );
  RETURN NULL;
END;
$$;
CREATE TRIGGER "PGMRM_cursor_audit_capture"
AFTER INSERT OR UPDATE ON public."ProjectGitRepositoryMaterialCursor"
FOR EACH ROW EXECUTE FUNCTION public."project_git_material_cursor_audit_capture"();

CREATE OR REPLACE FUNCTION public."project_git_material_run_audit_capture"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  action_value public."ProjectGitRepositoryMaterialRunAuditAction";
BEGIN
  action_value := CASE
    WHEN TG_OP = 'INSERT' THEN 'run_claimed'::public."ProjectGitRepositoryMaterialRunAuditAction"
    WHEN NEW."status" = 'dispatched' AND OLD."status" = 'pending' THEN 'run_dispatched'::public."ProjectGitRepositoryMaterialRunAuditAction"
    WHEN NEW."status" = 'dispatched' THEN 'run_heartbeat'::public."ProjectGitRepositoryMaterialRunAuditAction"
    WHEN NEW."status" = 'succeeded' THEN 'run_succeeded'::public."ProjectGitRepositoryMaterialRunAuditAction"
    WHEN NEW."status" = 'unchanged' THEN 'run_unchanged'::public."ProjectGitRepositoryMaterialRunAuditAction"
    WHEN NEW."status" = 'unknown' AND OLD."status" = 'dispatched' THEN 'run_lease_expired_after_dispatch'::public."ProjectGitRepositoryMaterialRunAuditAction"
    WHEN NEW."status" = 'failed' AND OLD."status" = 'pending' THEN 'run_lease_expired_before_dispatch'::public."ProjectGitRepositoryMaterialRunAuditAction"
    WHEN NEW."status" = 'failed' THEN 'run_fence_rejected_after_dispatch'::public."ProjectGitRepositoryMaterialRunAuditAction"
    ELSE 'run_fence_rejected_before_dispatch'::public."ProjectGitRepositoryMaterialRunAuditAction"
  END;
  INSERT INTO public."ProjectGitRepositoryMaterialRunAudit" (
    "id", "grantId", "projectId", "runId", "materialKind", "action", "runVersion",
    "runStatusBefore", "runStatusAfter", "scheduledFor", "workerId", "leaseExpiresAt",
    "grantVersion", "grantFingerprint", "reason", "expectedPublicationVersionId",
    "expectedPublicationGeneration", "publicationVersionId", "publicationGeneration",
    "manifestFingerprint", "sourceCount", "decodedTextBytes"
  ) VALUES (
    pg_catalog.gen_random_uuid(), NEW."grantId", NEW."projectId", NEW."id", NEW."materialKind", action_value,
    NEW."version", CASE WHEN TG_OP = 'UPDATE' THEN OLD."status" ELSE NULL END,
    NEW."status", NEW."scheduledFor", NEW."leaseWorkerId", NEW."leaseExpiresAt",
    NEW."grantVersion", NEW."grantFingerprint", NEW."safeErrorCode", NEW."expectedPublicationVersionId",
    NEW."expectedPublicationGeneration", NEW."resultPublicationVersionId", NEW."resultPublicationGeneration",
    NEW."manifestFingerprint", NEW."sourceCount", NEW."decodedTextBytes"
  );
  RETURN NULL;
END;
$$;
CREATE TRIGGER "PGMRM_run_audit_capture"
AFTER INSERT OR UPDATE ON public."ProjectGitRepositoryMaterialRun"
FOR EACH ROW EXECUTE FUNCTION public."project_git_material_run_audit_capture"();

CREATE OR REPLACE FUNCTION public."project_git_material_initialize_cursors"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  project_workspace UUID;
  initial_due TIMESTAMP(3);
BEGIN
  IF TG_OP = 'UPDATE' AND (OLD."status" IS NOT DISTINCT FROM NEW."status" OR NEW."status" <> 'active') THEN RETURN NULL; END IF;
  IF TG_OP = 'INSERT' AND NEW."status" <> 'active' THEN RETURN NULL; END IF;
  SELECT "workspaceId" INTO project_workspace FROM public."Project" WHERE "id" = NEW."projectId";
  IF NOT FOUND THEN RAISE EXCEPTION 'PROJECT_GIT_MATERIAL_PROJECT_NOT_FOUND' USING ERRCODE = 'foreign_key_violation'; END IF;
  initial_due := NEW."activatedAt" + NEW."runIntervalMinutes" * INTERVAL '1 minute';
  PERFORM pg_catalog.set_config('ai_project_os.git_material_transition', 'initialize', TRUE);
  IF NEW."issuesEnabled" THEN
    INSERT INTO public."ProjectGitRepositoryMaterialCursor" ("grantId", "projectId", "workspaceId", "materialKind", "nextRunAt")
    VALUES (NEW."id", NEW."projectId", project_workspace, 'issue', initial_due);
  END IF;
  IF NEW."pullRequestsEnabled" THEN
    INSERT INTO public."ProjectGitRepositoryMaterialCursor" ("grantId", "projectId", "workspaceId", "materialKind", "nextRunAt")
    VALUES (NEW."id", NEW."projectId", project_workspace, 'pull_request', initial_due);
  END IF;
  IF NEW."releasesEnabled" THEN
    INSERT INTO public."ProjectGitRepositoryMaterialCursor" ("grantId", "projectId", "workspaceId", "materialKind", "nextRunAt")
    VALUES (NEW."id", NEW."projectId", project_workspace, 'release', initial_due);
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER "PGMRM_initialize_cursors"
AFTER INSERT OR UPDATE OF "status" ON public."ProjectGitRepositoryAutomationGrant"
FOR EACH ROW EXECUTE FUNCTION public."project_git_material_initialize_cursors"();

CREATE OR REPLACE FUNCTION public."project_git_material_pause_on_grant_terminal"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  database_now TIMESTAMP(3);
  safe_reason VARCHAR(64);
BEGIN
  IF OLD."status" IS NOT DISTINCT FROM NEW."status" OR NEW."status" = 'active' THEN RETURN NULL; END IF;
  database_now := pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp() AT TIME ZONE 'UTC');
  safe_reason := CASE
    WHEN NEW."terminalReason" = 'project_archived' THEN 'project_archived'
    WHEN NEW."terminalReason" = 'base_delegation_ended' THEN 'base_delegation_ended'
    WHEN NEW."terminalReason" = 'git_connection_changed' THEN 'connection_changed'
    WHEN NEW."status" = 'revoked' THEN 'grant_revoked'
    WHEN NEW."status" = 'expired' THEN 'grant_expired'
    ELSE 'grant_invalidated'
  END;
  PERFORM pg_catalog.set_config('ai_project_os.git_material_transition', 'grant_terminal', TRUE);
  UPDATE public."ProjectGitRepositoryMaterialCursor"
     SET "status" = 'paused', "pauseReason" = safe_reason, "pausedAt" = database_now, "version" = "version" + 1
   WHERE "grantId" = NEW."id" AND "status" = 'active';
  UPDATE public."ProjectGitRepositoryMaterialRun"
     SET "status" = CASE WHEN "status" = 'pending' THEN 'failed'::public."ProjectGitRepositoryMaterialRunStatus"
                         ELSE 'unknown'::public."ProjectGitRepositoryMaterialRunStatus" END,
         "leaseExpiresAt" = NULL, "completedAt" = database_now,
         "safeErrorCode" = CASE WHEN "status" = 'pending' THEN 'GRANT_INELIGIBLE_BEFORE_DISPATCH' ELSE 'GRANT_INELIGIBLE_AFTER_DISPATCH' END,
         "version" = "version" + 1, "updatedAt" = database_now
   WHERE "grantId" = NEW."id" AND "status" IN ('pending', 'dispatched');
  RETURN NULL;
END;
$$;
CREATE TRIGGER "PGMRM_pause_on_grant_terminal"
AFTER UPDATE OF "status" ON public."ProjectGitRepositoryAutomationGrant"
FOR EACH ROW EXECUTE FUNCTION public."project_git_material_pause_on_grant_terminal"();

CREATE OR REPLACE FUNCTION public."project_git_material_pause_cursor_after_unknown"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF OLD."status" <> 'dispatched' OR NEW."status" <> 'unknown' THEN RETURN NULL; END IF;
  PERFORM pg_catalog.set_config('ai_project_os.git_material_transition', 'run_unknown', TRUE);
  UPDATE public."ProjectGitRepositoryMaterialCursor"
     SET "status" = 'paused', "pauseReason" = 'run_outcome_unknown',
         "pausedAt" = NEW."completedAt", "version" = "version" + 1
   WHERE "grantId" = NEW."grantId" AND "materialKind" = NEW."materialKind" AND "status" = 'active';
  RETURN NULL;
END;
$$;
CREATE TRIGGER "PGMRM_pause_cursor_after_unknown"
AFTER UPDATE OF "status" ON public."ProjectGitRepositoryMaterialRun"
FOR EACH ROW EXECUTE FUNCTION public."project_git_material_pause_cursor_after_unknown"();

CREATE TRIGGER "PGMRM_cursor_no_delete"
BEFORE DELETE ON public."ProjectGitRepositoryMaterialCursor"
FOR EACH ROW EXECUTE FUNCTION public."project_git_material_append_only_guard"();
CREATE TRIGGER "PGMRM_cursor_no_truncate"
BEFORE TRUNCATE ON public."ProjectGitRepositoryMaterialCursor"
FOR EACH STATEMENT EXECUTE FUNCTION public."project_git_material_append_only_guard"();
CREATE TRIGGER "PGMRM_run_no_delete"
BEFORE DELETE ON public."ProjectGitRepositoryMaterialRun"
FOR EACH ROW EXECUTE FUNCTION public."project_git_material_append_only_guard"();
CREATE TRIGGER "PGMRM_run_no_truncate"
BEFORE TRUNCATE ON public."ProjectGitRepositoryMaterialRun"
FOR EACH STATEMENT EXECUTE FUNCTION public."project_git_material_append_only_guard"();

CREATE OR REPLACE FUNCTION public."project_git_material_run_snapshot_matches"(target_run UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  run_row public."ProjectGitRepositoryMaterialRun"%ROWTYPE;
  grant_row public."ProjectGitRepositoryAutomationGrant"%ROWTYPE;
BEGIN
  SELECT * INTO run_row FROM public."ProjectGitRepositoryMaterialRun" WHERE "id" = target_run;
  IF NOT FOUND THEN RETURN FALSE; END IF;
  SELECT * INTO grant_row FROM public."ProjectGitRepositoryAutomationGrant" WHERE "id" = run_row."grantId";
  IF NOT FOUND THEN RETURN FALSE; END IF;
  RETURN run_row."projectId" = grant_row."projectId"
     AND run_row."workspaceId" = (SELECT project_row."workspaceId" FROM public."Project" project_row WHERE project_row."id" = grant_row."projectId")
     AND run_row."gitConnectionId" = grant_row."gitConnectionId"
     AND run_row."baseDelegationId" = grant_row."baseDelegationId"
     AND run_row."connectionOwnerId" = grant_row."connectionOwnerId"
     AND run_row."grantVersion" = grant_row."version"
     AND run_row."grantFingerprint" = grant_row."grantFingerprint"
     AND run_row."baseDelegationVersion" = grant_row."baseDelegationVersion"
     AND run_row."baseDelegationFingerprint" = grant_row."baseDelegationFingerprint"
     AND run_row."repositoryPath" = grant_row."repositoryPath"
     AND run_row."trackedRef" = grant_row."trackedRef"
     AND CASE run_row."materialKind"
       WHEN 'issue' THEN grant_row."issuesEnabled"
       WHEN 'pull_request' THEN grant_row."pullRequestsEnabled"
       ELSE grant_row."releasesEnabled"
     END;
END;
$$;

CREATE OR REPLACE FUNCTION public."project_git_material_claim_due"(
  target_grant UUID,
  target_kind public."ProjectGitRepositoryMaterialKind",
  target_worker VARCHAR(128)
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  grant_row public."ProjectGitRepositoryAutomationGrant"%ROWTYPE;
  cursor_row public."ProjectGitRepositoryMaterialCursor"%ROWTYPE;
  project_workspace UUID;
  database_now TIMESTAMP(3);
  scheduled_for TIMESTAMP(3);
  new_run_id UUID := pg_catalog.gen_random_uuid();
  lease_token UUID := pg_catalog.gen_random_uuid();
  lease_expires TIMESTAMP(3);
  expected_version UUID;
  expected_generation INTEGER := 0;
  eligibility_reason TEXT;
BEGIN
  IF SESSION_USER IS DISTINCT FROM 'ai_project_os_git_automation_worker' THEN
    RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_WORKER_SESSION_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF pg_catalog.current_setting('transaction_isolation') <> 'serializable' THEN
    RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_SERIALIZABLE_REQUIRED' USING ERRCODE = '25001';
  END IF;
  IF target_grant IS NULL OR target_kind IS NULL OR target_worker IS NULL
     OR target_worker !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' THEN
    RAISE EXCEPTION 'PROJECT_GIT_MATERIAL_CLAIM_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT public."project_git_automation_lock_grant"(target_grant) THEN RETURN NULL; END IF;
  database_now := pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp() AT TIME ZONE 'UTC');
  PERFORM pg_catalog.set_config('ai_project_os.git_material_now', database_now::text, TRUE);
  SELECT * INTO grant_row FROM public."ProjectGitRepositoryAutomationGrant" WHERE "id" = target_grant FOR SHARE;
  IF NOT FOUND OR grant_row."status" <> 'active' THEN RETURN NULL; END IF;
  IF NOT (CASE target_kind WHEN 'issue' THEN grant_row."issuesEnabled"
    WHEN 'pull_request' THEN grant_row."pullRequestsEnabled" ELSE grant_row."releasesEnabled" END) THEN RETURN NULL; END IF;
  SELECT "workspaceId" INTO project_workspace FROM public."Project" WHERE "id" = grant_row."projectId" AND "archivedAt" IS NULL;
  IF NOT FOUND THEN RETURN NULL; END IF;
  eligibility_reason := public."project_git_automation_grant_eligibility"(grant_row."id", grant_row."projectId", database_now);
  SELECT * INTO cursor_row FROM public."ProjectGitRepositoryMaterialCursor"
   WHERE "grantId" = target_grant AND "materialKind" = target_kind FOR UPDATE;
  IF NOT FOUND OR cursor_row."status" <> 'active' THEN RETURN NULL; END IF;
  IF cursor_row."projectId" IS DISTINCT FROM grant_row."projectId"
     OR cursor_row."workspaceId" IS DISTINCT FROM project_workspace THEN
    PERFORM pg_catalog.set_config('ai_project_os.git_material_transition', 'claim', TRUE);
    UPDATE public."ProjectGitRepositoryMaterialCursor"
       SET "status" = 'paused', "pauseReason" = 'schedule_snapshot_drift', "pausedAt" = database_now,
           "version" = "version" + 1, "updatedAt" = database_now
     WHERE "grantId" = target_grant AND "materialKind" = target_kind;
    RETURN NULL;
  END IF;
  IF eligibility_reason IS NOT NULL THEN
    PERFORM pg_catalog.set_config('ai_project_os.git_material_transition', 'claim', TRUE);
    UPDATE public."ProjectGitRepositoryMaterialCursor"
       SET "status" = 'paused', "pauseReason" = CASE eligibility_reason
         WHEN 'EXPIRED' THEN 'grant_expired' WHEN 'PROJECT_ARCHIVED' THEN 'project_archived'
         WHEN 'BASE_DELEGATION_DRIFT' THEN 'base_delegation_drift' WHEN 'CONNECTION_DRIFT' THEN 'connection_drift'
         WHEN 'OWNER_MEMBERSHIP_DRIFT' THEN 'owner_membership_drift' WHEN 'PROJECT_OWNER_MEMBERSHIP_DRIFT' THEN 'project_owner_membership_drift'
         ELSE 'grant_ineligible' END,
         "pausedAt" = database_now, "version" = "version" + 1, "updatedAt" = database_now
     WHERE "grantId" = target_grant AND "materialKind" = target_kind;
    RETURN NULL;
  END IF;
  IF cursor_row."nextRunAt" > database_now OR EXISTS (
    SELECT 1 FROM public."ProjectGitRepositoryMaterialRun" run_row
     WHERE run_row."grantId" = target_grant AND run_row."materialKind" = target_kind
       AND run_row."status" IN ('pending', 'dispatched')
  ) THEN RETURN NULL; END IF;

  scheduled_for := cursor_row."nextRunAt";
  lease_expires := database_now + INTERVAL '90 seconds';
  SELECT "currentVersionId", "generation" INTO expected_version, expected_generation
    FROM public."ProjectGitRepositoryMaterialPublicationHead"
   WHERE "projectId" = grant_row."projectId" AND "grantId" = target_grant AND "materialKind" = target_kind
   FOR SHARE;
  IF NOT FOUND THEN expected_version := NULL; expected_generation := 0; END IF;

  PERFORM pg_catalog.set_config('ai_project_os.git_material_transition', 'claim', TRUE);
  UPDATE public."ProjectGitRepositoryMaterialCursor"
     SET "lastScheduledFor" = scheduled_for,
         "nextRunAt" = database_now + grant_row."runIntervalMinutes" * INTERVAL '1 minute',
         "version" = "version" + 1, "updatedAt" = database_now
   WHERE "grantId" = target_grant AND "materialKind" = target_kind;
  INSERT INTO public."ProjectGitRepositoryMaterialRun" (
    "id", "grantId", "projectId", "workspaceId", "gitConnectionId", "baseDelegationId", "connectionOwnerId",
    "materialKind", "grantVersion", "grantFingerprint", "baseDelegationVersion", "baseDelegationFingerprint",
    "repositoryPath", "trackedRef", "scheduledFor", "status", "version", "leaseWorkerId", "leaseToken",
    "leaseExpiresAt", "expectedPublicationVersionId", "expectedPublicationGeneration", "createdAt", "updatedAt"
  ) VALUES (
    new_run_id, grant_row."id", grant_row."projectId", project_workspace, grant_row."gitConnectionId", grant_row."baseDelegationId",
    grant_row."connectionOwnerId", target_kind, grant_row."version", grant_row."grantFingerprint", grant_row."baseDelegationVersion",
    grant_row."baseDelegationFingerprint", grant_row."repositoryPath", grant_row."trackedRef", scheduled_for,
    'pending', 1, target_worker, lease_token, lease_expires, expected_version, expected_generation, database_now, database_now
  );
  RETURN pg_catalog.jsonb_build_object(
    'id', new_run_id::text, 'grantId', grant_row."id"::text, 'materialKind', target_kind::text,
    'workerId', target_worker, 'leaseToken', lease_token::text,
    'scheduledFor', pg_catalog.to_char(scheduled_for, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'leaseExpiresAt', pg_catalog.to_char(lease_expires, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'grantVersion', grant_row."version", 'grantFingerprint', grant_row."grantFingerprint",
    'baseDelegationId', grant_row."baseDelegationId"::text,
    'baseDelegationVersion', grant_row."baseDelegationVersion", 'baseDelegationFingerprint', grant_row."baseDelegationFingerprint",
    'repositoryPath', grant_row."repositoryPath", 'trackedRef', grant_row."trackedRef",
    'expectedPublicationVersionId', expected_version::text, 'expectedPublicationGeneration', expected_generation
  );
END;
$$;

CREATE OR REPLACE FUNCTION public."project_git_material_mutate_lease"(
  target_run UUID, target_worker VARCHAR(128), target_lease_token UUID, requested_action VARCHAR(16)
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  grant_id UUID;
  kind_value public."ProjectGitRepositoryMaterialKind";
  grant_row public."ProjectGitRepositoryAutomationGrant"%ROWTYPE;
  run_row public."ProjectGitRepositoryMaterialRun"%ROWTYPE;
  cursor_row public."ProjectGitRepositoryMaterialCursor"%ROWTYPE;
  database_now TIMESTAMP(3);
  eligibility_reason TEXT;
  terminal_status public."ProjectGitRepositoryMaterialRunStatus";
BEGIN
  IF SESSION_USER IS DISTINCT FROM 'ai_project_os_git_automation_worker' THEN
    RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_WORKER_SESSION_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF pg_catalog.current_setting('transaction_isolation') <> 'serializable' THEN
    RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_SERIALIZABLE_REQUIRED' USING ERRCODE = '25001';
  END IF;
  IF target_run IS NULL OR target_worker IS NULL OR target_lease_token IS NULL
     OR requested_action NOT IN ('heartbeat', 'dispatch') THEN
    RAISE EXCEPTION 'PROJECT_GIT_MATERIAL_LEASE_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  SELECT "grantId", "materialKind" INTO grant_id, kind_value
    FROM public."ProjectGitRepositoryMaterialRun" WHERE "id" = target_run;
  IF NOT FOUND OR NOT public."project_git_automation_lock_grant"(grant_id) THEN RETURN NULL; END IF;
  database_now := pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp() AT TIME ZONE 'UTC');
  PERFORM pg_catalog.set_config('ai_project_os.git_material_now', database_now::text, TRUE);
  SELECT * INTO grant_row FROM public."ProjectGitRepositoryAutomationGrant" WHERE "id" = grant_id FOR SHARE;
  SELECT * INTO cursor_row FROM public."ProjectGitRepositoryMaterialCursor" WHERE "grantId" = grant_id AND "materialKind" = kind_value FOR UPDATE;
  SELECT * INTO run_row FROM public."ProjectGitRepositoryMaterialRun" WHERE "id" = target_run FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF run_row."status" NOT IN ('pending', 'dispatched') OR run_row."leaseWorkerId" IS DISTINCT FROM target_worker
     OR run_row."leaseToken" IS DISTINCT FROM target_lease_token THEN
    RETURN pg_catalog.jsonb_build_object('accepted', FALSE, 'status', run_row."status"::text);
  END IF;
  eligibility_reason := public."project_git_automation_grant_eligibility"(grant_id, run_row."projectId", database_now);
  IF eligibility_reason IS NULL AND NOT public."project_git_material_run_snapshot_matches"(target_run) THEN
    eligibility_reason := 'BASE_DELEGATION_DRIFT';
  END IF;
  IF eligibility_reason IS NOT NULL OR cursor_row."status" <> 'active' OR run_row."leaseExpiresAt" IS NULL
     OR run_row."leaseExpiresAt" <= database_now THEN
    terminal_status := CASE WHEN run_row."status" = 'dispatched' THEN 'unknown'::public."ProjectGitRepositoryMaterialRunStatus"
      ELSE 'failed'::public."ProjectGitRepositoryMaterialRunStatus" END;
    IF cursor_row."status" = 'active' THEN
      PERFORM pg_catalog.set_config('ai_project_os.git_material_transition', 'reconcile', TRUE);
      UPDATE public."ProjectGitRepositoryMaterialCursor"
         SET "status" = 'paused', "pauseReason" = CASE WHEN terminal_status = 'unknown' THEN 'run_outcome_unknown' ELSE 'grant_ineligible' END,
             "pausedAt" = database_now, "version" = "version" + 1, "updatedAt" = database_now
       WHERE "grantId" = grant_id AND "materialKind" = kind_value;
    END IF;
    PERFORM pg_catalog.set_config('ai_project_os.git_material_transition', 'reconcile', TRUE);
    UPDATE public."ProjectGitRepositoryMaterialRun"
       SET "status" = terminal_status, "leaseExpiresAt" = NULL, "completedAt" = database_now,
           "safeErrorCode" = CASE WHEN eligibility_reason IS NOT NULL THEN 'GRANT_INELIGIBLE'
             WHEN terminal_status = 'unknown' THEN 'LEASE_EXPIRED_AFTER_DISPATCH' ELSE 'LEASE_EXPIRED_BEFORE_DISPATCH' END,
           "version" = "version" + 1, "updatedAt" = database_now
     WHERE "id" = target_run;
    RETURN pg_catalog.jsonb_build_object('accepted', FALSE, 'status', terminal_status::text);
  END IF;
  IF requested_action = 'dispatch' THEN
    IF run_row."status" <> 'pending' THEN
      RETURN pg_catalog.jsonb_build_object('accepted', FALSE, 'status', run_row."status"::text);
    END IF;
    PERFORM pg_catalog.set_config('ai_project_os.git_material_transition', 'dispatch', TRUE);
    UPDATE public."ProjectGitRepositoryMaterialRun"
       SET "status" = 'dispatched', "dispatchedAt" = database_now, "version" = "version" + 1, "updatedAt" = database_now
     WHERE "id" = target_run;
  ELSE
    IF run_row."status" <> 'dispatched' THEN
      RETURN pg_catalog.jsonb_build_object('accepted', FALSE, 'status', run_row."status"::text);
    END IF;
    PERFORM pg_catalog.set_config('ai_project_os.git_material_transition', 'heartbeat', TRUE);
    UPDATE public."ProjectGitRepositoryMaterialRun"
       SET "leaseExpiresAt" = database_now + INTERVAL '90 seconds', "version" = "version" + 1, "updatedAt" = database_now
     WHERE "id" = target_run;
  END IF;
  SELECT * INTO run_row FROM public."ProjectGitRepositoryMaterialRun" WHERE "id" = target_run;
  RETURN pg_catalog.jsonb_build_object('accepted', TRUE, 'status', run_row."status"::text,
    'leaseExpiresAt', pg_catalog.to_char(run_row."leaseExpiresAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
END;
$$;

CREATE OR REPLACE FUNCTION public."project_git_material_reconcile_expired"(target_run UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  grant_id UUID;
  kind_value public."ProjectGitRepositoryMaterialKind";
  run_row public."ProjectGitRepositoryMaterialRun"%ROWTYPE;
  cursor_row public."ProjectGitRepositoryMaterialCursor"%ROWTYPE;
  database_now TIMESTAMP(3);
  eligibility_reason TEXT;
  terminal_status public."ProjectGitRepositoryMaterialRunStatus";
BEGIN
  IF SESSION_USER IS DISTINCT FROM 'ai_project_os_git_automation_worker' THEN
    RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_WORKER_SESSION_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF pg_catalog.current_setting('transaction_isolation') <> 'serializable' THEN
    RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_SERIALIZABLE_REQUIRED' USING ERRCODE = '25001';
  END IF;
  SELECT "grantId", "materialKind" INTO grant_id, kind_value FROM public."ProjectGitRepositoryMaterialRun" WHERE "id" = target_run;
  IF NOT FOUND OR NOT public."project_git_automation_lock_grant"(grant_id) THEN RETURN FALSE; END IF;
  database_now := pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp() AT TIME ZONE 'UTC');
  SELECT * INTO cursor_row FROM public."ProjectGitRepositoryMaterialCursor" WHERE "grantId" = grant_id AND "materialKind" = kind_value FOR UPDATE;
  SELECT * INTO run_row FROM public."ProjectGitRepositoryMaterialRun" WHERE "id" = target_run FOR UPDATE;
  IF NOT FOUND OR run_row."status" NOT IN ('pending', 'dispatched') OR run_row."leaseExpiresAt" IS NULL
     OR run_row."leaseExpiresAt" > database_now THEN RETURN FALSE; END IF;
  eligibility_reason := public."project_git_automation_grant_eligibility"(grant_id, run_row."projectId", database_now);
  IF eligibility_reason IS NULL AND NOT public."project_git_material_run_snapshot_matches"(target_run) THEN eligibility_reason := 'BASE_DELEGATION_DRIFT'; END IF;
  terminal_status := CASE WHEN run_row."status" = 'dispatched' THEN 'unknown'::public."ProjectGitRepositoryMaterialRunStatus"
    ELSE 'failed'::public."ProjectGitRepositoryMaterialRunStatus" END;
  IF cursor_row."status" = 'active' AND (eligibility_reason IS NOT NULL OR terminal_status = 'unknown') THEN
    PERFORM pg_catalog.set_config('ai_project_os.git_material_transition', 'reconcile', TRUE);
    UPDATE public."ProjectGitRepositoryMaterialCursor"
       SET "status" = 'paused', "pauseReason" = CASE WHEN terminal_status = 'unknown' THEN 'run_outcome_unknown' ELSE 'grant_ineligible' END,
           "pausedAt" = database_now, "version" = "version" + 1, "updatedAt" = database_now
     WHERE "grantId" = grant_id AND "materialKind" = kind_value;
  END IF;
  PERFORM pg_catalog.set_config('ai_project_os.git_material_transition', 'reconcile', TRUE);
  UPDATE public."ProjectGitRepositoryMaterialRun"
     SET "status" = terminal_status, "leaseExpiresAt" = NULL, "completedAt" = database_now,
         "safeErrorCode" = CASE WHEN eligibility_reason IS NOT NULL THEN 'GRANT_INELIGIBLE'
           WHEN terminal_status = 'unknown' THEN 'LEASE_EXPIRED_AFTER_DISPATCH' ELSE 'LEASE_EXPIRED_BEFORE_DISPATCH' END,
         "version" = "version" + 1, "updatedAt" = database_now
   WHERE "id" = target_run;
  RETURN TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION public."project_git_material_read_context"(
  target_run UUID, target_worker VARCHAR(128), target_lease_token UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  grant_id UUID;
  kind_value public."ProjectGitRepositoryMaterialKind";
  grant_row public."ProjectGitRepositoryAutomationGrant"%ROWTYPE;
  cursor_row public."ProjectGitRepositoryMaterialCursor"%ROWTYPE;
  run_row public."ProjectGitRepositoryMaterialRun"%ROWTYPE;
  base_row public."ProjectGitRepositoryDelegation"%ROWTYPE;
  connection_row public."GitConnection"%ROWTYPE;
  credential_row public."ExternalCredential"%ROWTYPE;
  head_row public."ProjectGitRepositoryMaterialPublicationHead"%ROWTYPE;
  version_row public."ProjectGitRepositoryMaterialPublicationVersion"%ROWTYPE;
  baseline_value JSONB;
  eligibility_reason TEXT;
  database_now TIMESTAMP(3);
BEGIN
  IF SESSION_USER IS DISTINCT FROM 'ai_project_os_git_automation_worker' THEN
    RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_WORKER_SESSION_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF pg_catalog.current_setting('transaction_isolation') <> 'serializable' THEN
    RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_SERIALIZABLE_REQUIRED' USING ERRCODE = '25001';
  END IF;
  IF target_run IS NULL OR target_worker IS NULL OR target_lease_token IS NULL
     OR target_worker !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' THEN
    RAISE EXCEPTION 'PROJECT_GIT_MATERIAL_READ_CONTEXT_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  SELECT "grantId", "materialKind" INTO grant_id, kind_value
    FROM public."ProjectGitRepositoryMaterialRun" WHERE "id" = target_run;
  IF NOT FOUND OR NOT public."project_git_automation_lock_grant"(grant_id) THEN RETURN NULL; END IF;
  database_now := pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp() AT TIME ZONE 'UTC');
  SELECT * INTO grant_row FROM public."ProjectGitRepositoryAutomationGrant" WHERE "id" = grant_id FOR SHARE;
  SELECT * INTO cursor_row FROM public."ProjectGitRepositoryMaterialCursor"
   WHERE "grantId" = grant_id AND "materialKind" = kind_value FOR SHARE;
  SELECT * INTO run_row FROM public."ProjectGitRepositoryMaterialRun" WHERE "id" = target_run FOR SHARE;
  IF NOT FOUND OR run_row."status" <> 'dispatched' OR run_row."leaseWorkerId" IS DISTINCT FROM target_worker
     OR run_row."leaseToken" IS DISTINCT FROM target_lease_token OR run_row."leaseExpiresAt" IS NULL
     OR run_row."leaseExpiresAt" <= database_now OR run_row."dispatchedAt" IS NULL
     OR run_row."completedAt" IS NOT NULL OR run_row."safeErrorCode" IS NOT NULL
     OR grant_row."status" <> 'active' OR grant_row."expiresAt" <= database_now
     OR cursor_row."status" <> 'active' OR cursor_row."projectId" IS DISTINCT FROM run_row."projectId"
     OR cursor_row."workspaceId" IS DISTINCT FROM run_row."workspaceId" THEN RETURN NULL; END IF;
  IF NOT (CASE kind_value WHEN 'issue' THEN grant_row."issuesEnabled"
    WHEN 'pull_request' THEN grant_row."pullRequestsEnabled" ELSE grant_row."releasesEnabled" END) THEN RETURN NULL; END IF;
  eligibility_reason := public."project_git_automation_grant_eligibility"(grant_id, run_row."projectId", database_now);
  IF eligibility_reason IS NOT NULL OR NOT public."project_git_material_run_snapshot_matches"(target_run) THEN RETURN NULL; END IF;

  SELECT * INTO base_row FROM public."ProjectGitRepositoryDelegation"
   WHERE "id" = run_row."baseDelegationId" AND "projectId" = run_row."projectId" FOR SHARE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO connection_row FROM public."GitConnection" WHERE "id" = run_row."gitConnectionId" FOR SHARE;
  IF NOT FOUND OR connection_row."providerKind" <> 'github' OR connection_row."transport" <> 'https'
     OR connection_row."authKind" <> 'token' OR connection_row."baseUrl" NOT IN ('https://github.com', 'https://github.com/')
     OR connection_row."status" <> 'verified' OR connection_row."ownershipState" <> 'confirmed'
     OR connection_row."ownerUserId" IS DISTINCT FROM run_row."connectionOwnerId"
     OR connection_row."ownerAccountAccessVersion" IS DISTINCT FROM grant_row."connectionOwnerAccountAccessVersion"
     OR connection_row."configurationVersion" IS DISTINCT FROM base_row."connectionConfigurationVersion"
     OR connection_row."resolvedAddressFingerprint" IS DISTINCT FROM base_row."resolvedAddressFingerprint"
     OR connection_row."credentialId" IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO credential_row FROM public."ExternalCredential" WHERE "id" = connection_row."credentialId" FOR SHARE;
  IF NOT FOUND OR credential_row."kind" <> 'git' OR credential_row."keyVersion" <> 1
     OR credential_row."secretFingerprint" IS DISTINCT FROM base_row."credentialFingerprint" THEN RETURN NULL; END IF;

  SELECT * INTO head_row FROM public."ProjectGitRepositoryMaterialPublicationHead"
   WHERE "projectId" = run_row."projectId" AND "grantId" = grant_id AND "materialKind" = kind_value FOR SHARE;
  IF run_row."expectedPublicationVersionId" IS NULL THEN
    IF run_row."expectedPublicationGeneration" <> 0 OR FOUND THEN RETURN NULL; END IF;
    baseline_value := NULL;
  ELSE
    IF NOT FOUND OR head_row."currentVersionId" IS DISTINCT FROM run_row."expectedPublicationVersionId"
       OR head_row."generation" IS DISTINCT FROM run_row."expectedPublicationGeneration" THEN RETURN NULL; END IF;
    SELECT * INTO version_row FROM public."ProjectGitRepositoryMaterialPublicationVersion"
     WHERE "id" = run_row."expectedPublicationVersionId" AND "projectId" = run_row."projectId"
       AND "grantId" = grant_id AND "materialKind" = kind_value FOR SHARE;
    IF NOT FOUND OR version_row."repositoryPath" IS DISTINCT FROM run_row."repositoryPath"
       OR version_row."trackedRef" IS DISTINCT FROM run_row."trackedRef"
       OR version_row."publishedAt" IS DISTINCT FROM head_row."publishedAt" THEN RETURN NULL; END IF;
    baseline_value := pg_catalog.jsonb_build_object(
      'publicationVersionId', version_row."id"::text, 'generation', head_row."generation",
      'repositoryId', version_row."githubRepositoryId", 'nodeId', version_row."githubRepositoryNodeId"
    );
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'scope', pg_catalog.jsonb_build_object(
      'repositoryPath', run_row."repositoryPath", 'trackedRef', run_row."trackedRef", 'materialKind', kind_value::text
    ),
    'connection', pg_catalog.jsonb_build_object(
      'id', connection_row."id"::text, 'baseUrl', connection_row."baseUrl",
      'providerKind', connection_row."providerKind"::text,
      'transport', connection_row."transport"::text, 'authKind', connection_row."authKind"::text
    ),
    'credential', pg_catalog.jsonb_build_object(
      'kind', credential_row."kind"::text,
      'ciphertext', pg_catalog.replace(pg_catalog.encode(credential_row."ciphertext", 'base64'), E'\n', ''),
      'nonce', pg_catalog.replace(pg_catalog.encode(credential_row."nonce", 'base64'), E'\n', ''),
      'authTag', pg_catalog.replace(pg_catalog.encode(credential_row."authTag", 'base64'), E'\n', ''),
      'keyVersion', credential_row."keyVersion", 'secretFingerprint', credential_row."secretFingerprint"
    ),
    'baseline', baseline_value
  );
END;
$$;

CREATE OR REPLACE FUNCTION public."project_git_material_insert_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF pg_catalog.current_setting('ai_project_os.git_material_transition', TRUE) IS DISTINCT FROM 'automatic_finalize' THEN
    RAISE EXCEPTION 'PROJECT_GIT_MATERIAL_PUBLICATION_INSERT_FORBIDDEN' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public."project_git_material_head_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF pg_catalog.current_setting('ai_project_os.git_material_transition', TRUE) IS DISTINCT FROM 'automatic_finalize' THEN
    RAISE EXCEPTION 'PROJECT_GIT_MATERIAL_HEAD_MUTATION_FORBIDDEN' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' AND NEW."generation" <> 1 THEN
    RAISE EXCEPTION 'PROJECT_GIT_MATERIAL_HEAD_GENERATION_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW."projectId" IS DISTINCT FROM OLD."projectId"
      OR NEW."grantId" IS DISTINCT FROM OLD."grantId" OR NEW."materialKind" IS DISTINCT FROM OLD."materialKind"
      OR NEW."generation" <> OLD."generation" + 1) THEN
    RAISE EXCEPTION 'PROJECT_GIT_MATERIAL_HEAD_TRANSITION_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'PROJECT_GIT_MATERIAL_HEAD_DELETE_FORBIDDEN' USING ERRCODE = 'check_violation'; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "PGMRM_publication_version_insert_guard"
BEFORE INSERT ON public."ProjectGitRepositoryMaterialPublicationVersion"
FOR EACH ROW EXECUTE FUNCTION public."project_git_material_insert_guard"();
CREATE TRIGGER "PGMRM_publication_entry_insert_guard"
BEFORE INSERT ON public."ProjectGitRepositoryMaterialPublicationEntry"
FOR EACH ROW EXECUTE FUNCTION public."project_git_material_insert_guard"();
CREATE TRIGGER "PGMRM_source_version_insert_guard"
BEFORE INSERT ON public."ProjectGitRepositoryMaterialSourceVersion"
FOR EACH ROW EXECUTE FUNCTION public."project_git_material_insert_guard"();
CREATE TRIGGER "PGMRM_head_transition_guard"
BEFORE INSERT OR UPDATE OR DELETE ON public."ProjectGitRepositoryMaterialPublicationHead"
FOR EACH ROW EXECUTE FUNCTION public."project_git_material_head_guard"();
CREATE TRIGGER "PGMRM_head_no_truncate"
BEFORE TRUNCATE ON public."ProjectGitRepositoryMaterialPublicationHead"
FOR EACH STATEMENT EXECUTE FUNCTION public."project_git_material_append_only_guard"();

CREATE OR REPLACE FUNCTION public."project_git_material_finalize_result"(
  target_run UUID,
  target_worker VARCHAR(128),
  target_lease_token UUID,
  result_repository_id BIGINT,
  result_repository_node_id VARCHAR(512),
  result_head_commit_sha VARCHAR(40),
  result_sources JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  grant_id UUID;
  kind_value public."ProjectGitRepositoryMaterialKind";
  expected_source_kind TEXT;
  kind_path TEXT;
  grant_row public."ProjectGitRepositoryAutomationGrant"%ROWTYPE;
  cursor_row public."ProjectGitRepositoryMaterialCursor"%ROWTYPE;
  run_row public."ProjectGitRepositoryMaterialRun"%ROWTYPE;
  head_row public."ProjectGitRepositoryMaterialPublicationHead"%ROWTYPE;
  baseline_row public."ProjectGitRepositoryMaterialPublicationVersion"%ROWTYPE;
  source_item JSONB;
  source_key_count INTEGER;
  source_kind TEXT;
  remote_identity TEXT;
  remote_revision_fingerprint TEXT;
  remote_number INTEGER;
  external_ref TEXT;
  captured_at_text TEXT;
  captured_at_value TIMESTAMP(3);
  content_text TEXT;
  content_hash TEXT;
  content_bytes INTEGER;
  source_identity UUID;
  revision_key UUID;
  project_source_id UUID;
  source_version_id UUID;
  new_version_id UUID;
  manifest_payload TEXT := 'project-git-material:v1';
  manifest_fingerprint TEXT;
  source_count INTEGER := 0;
  decoded_text_bytes BIGINT := 0;
  total_json_bytes BIGINT;
  source_ordinal INTEGER := 0;
  previous_entry_count INTEGER;
  retired_count INTEGER;
  stale_head BOOLEAN := FALSE;
  database_now TIMESTAMP(3);
  published_at TIMESTAMP(3);
  eligibility_reason TEXT;
  seen_identities TEXT[] := ARRAY[]::TEXT[];
  repository_prefix TEXT;
  expected_ref_prefix TEXT;
BEGIN
  IF SESSION_USER IS DISTINCT FROM 'ai_project_os_git_automation_worker' THEN
    RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_WORKER_SESSION_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF pg_catalog.current_setting('transaction_isolation') <> 'serializable' THEN
    RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_SERIALIZABLE_REQUIRED' USING ERRCODE = '25001';
  END IF;
  IF target_run IS NULL OR target_worker IS NULL OR target_worker !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
     OR target_lease_token IS NULL OR result_repository_id IS NULL OR result_repository_id <= 0
     OR result_repository_node_id IS NULL OR pg_catalog.char_length(result_repository_node_id) NOT BETWEEN 1 AND 512
     OR result_repository_node_id ~ '[[:cntrl:]]'
     OR result_head_commit_sha IS NULL OR result_head_commit_sha !~ '^[0-9a-f]{40}$'
     OR result_sources IS NULL OR pg_catalog.jsonb_typeof(result_sources) <> 'array'
     OR pg_catalog.jsonb_array_length(result_sources) > 20000 THEN
    RAISE EXCEPTION 'PROJECT_GIT_MATERIAL_RESULT_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  total_json_bytes := pg_catalog.octet_length(pg_catalog.convert_to(result_sources::text, 'UTF8'));
  IF total_json_bytes > 83886080 THEN
    RAISE EXCEPTION 'PROJECT_GIT_MATERIAL_RESULT_TOO_LARGE' USING ERRCODE = 'check_violation';
  END IF;
  SELECT "grantId", "materialKind" INTO grant_id, kind_value
    FROM public."ProjectGitRepositoryMaterialRun" WHERE "id" = target_run;
  IF NOT FOUND OR NOT public."project_git_automation_lock_grant"(grant_id) THEN
    RETURN pg_catalog.jsonb_build_object('accepted', FALSE, 'status', 'unknown');
  END IF;
  database_now := pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp() AT TIME ZONE 'UTC');
  PERFORM pg_catalog.set_config('ai_project_os.git_material_now', database_now::text, TRUE);
  SELECT * INTO grant_row FROM public."ProjectGitRepositoryAutomationGrant" WHERE "id" = grant_id FOR SHARE;
  SELECT * INTO cursor_row FROM public."ProjectGitRepositoryMaterialCursor"
   WHERE "grantId" = grant_id AND "materialKind" = kind_value FOR UPDATE;
  SELECT * INTO run_row FROM public."ProjectGitRepositoryMaterialRun" WHERE "id" = target_run FOR UPDATE;
  IF NOT FOUND THEN RETURN pg_catalog.jsonb_build_object('accepted', FALSE, 'status', 'unknown'); END IF;
  IF run_row."status" <> 'dispatched' OR run_row."leaseWorkerId" IS DISTINCT FROM target_worker
     OR run_row."leaseToken" IS DISTINCT FROM target_lease_token OR run_row."leaseExpiresAt" IS NULL
     OR run_row."leaseExpiresAt" <= database_now THEN
    RETURN pg_catalog.jsonb_build_object('accepted', FALSE, 'status', run_row."status"::text);
  END IF;
  eligibility_reason := public."project_git_automation_grant_eligibility"(grant_id, run_row."projectId", database_now);
  IF eligibility_reason IS NOT NULL OR cursor_row."status" <> 'active'
     OR NOT public."project_git_material_run_snapshot_matches"(target_run) THEN
    RETURN pg_catalog.jsonb_build_object('accepted', FALSE, 'status', run_row."status"::text);
  END IF;

  SELECT * INTO head_row FROM public."ProjectGitRepositoryMaterialPublicationHead"
   WHERE "projectId" = run_row."projectId" AND "grantId" = grant_id AND "materialKind" = kind_value FOR UPDATE;
  IF FOUND THEN
    stale_head := head_row."currentVersionId" IS DISTINCT FROM run_row."expectedPublicationVersionId"
      OR head_row."generation" IS DISTINCT FROM run_row."expectedPublicationGeneration";
  ELSE
    stale_head := run_row."expectedPublicationVersionId" IS NOT NULL OR run_row."expectedPublicationGeneration" <> 0;
  END IF;
  IF stale_head THEN
    PERFORM pg_catalog.set_config('ai_project_os.git_material_transition', 'finalize', TRUE);
    UPDATE public."ProjectGitRepositoryMaterialRun"
       SET "status" = 'failed', "leaseExpiresAt" = NULL, "completedAt" = database_now,
           "safeErrorCode" = 'PUBLICATION_HEAD_STALE', "version" = "version" + 1, "updatedAt" = database_now
     WHERE "id" = target_run;
    RETURN pg_catalog.jsonb_build_object('accepted', FALSE, 'status', 'failed', 'reason', 'PUBLICATION_HEAD_STALE');
  END IF;
  IF run_row."expectedPublicationVersionId" IS NOT NULL THEN
    SELECT * INTO baseline_row FROM public."ProjectGitRepositoryMaterialPublicationVersion"
     WHERE "id" = run_row."expectedPublicationVersionId" AND "projectId" = run_row."projectId"
       AND "grantId" = grant_id AND "materialKind" = kind_value FOR SHARE;
    IF NOT FOUND OR baseline_row."githubRepositoryId" IS DISTINCT FROM result_repository_id
       OR baseline_row."githubRepositoryNodeId" IS DISTINCT FROM result_repository_node_id
       OR baseline_row."repositoryPath" IS DISTINCT FROM run_row."repositoryPath"
       OR baseline_row."trackedRef" IS DISTINCT FROM run_row."trackedRef" THEN
      PERFORM pg_catalog.set_config('ai_project_os.git_material_transition', 'finalize', TRUE);
      UPDATE public."ProjectGitRepositoryMaterialRun"
         SET "status" = 'failed', "leaseExpiresAt" = NULL, "completedAt" = database_now,
             "safeErrorCode" = 'REPOSITORY_IDENTITY_CHANGED', "version" = "version" + 1, "updatedAt" = database_now
       WHERE "id" = target_run;
      RETURN pg_catalog.jsonb_build_object('accepted', FALSE, 'status', 'failed', 'reason', 'REPOSITORY_IDENTITY_CHANGED');
    END IF;
  END IF;

  expected_source_kind := CASE kind_value WHEN 'issue' THEN 'issue' WHEN 'pull_request' THEN 'pullRequest' ELSE 'release' END;
  kind_path := CASE kind_value WHEN 'issue' THEN 'issues/' WHEN 'pull_request' THEN 'pull/' ELSE 'releases/' END;
  repository_prefix := 'https://github.com/' || run_row."repositoryPath" || '/';
  expected_ref_prefix := repository_prefix || kind_path;
  FOR source_item IN
    SELECT rows.item FROM pg_catalog.jsonb_array_elements(result_sources) AS rows(item)
    ORDER BY rows.item ->> 'remoteIdentity', rows.item ->> 'remoteRevisionFingerprint'
  LOOP
    IF pg_catalog.jsonb_typeof(source_item) <> 'object' THEN
      RAISE EXCEPTION 'PROJECT_GIT_MATERIAL_SOURCE_SHAPE_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    SELECT pg_catalog.count(*)::INTEGER INTO source_key_count FROM pg_catalog.jsonb_object_keys(source_item);
    IF source_key_count <> 10 OR NOT source_item ?& ARRAY[
        'materialKind', 'remoteIdentity', 'remoteRevisionFingerprint', 'remoteNumber', 'normalizedPath',
        'externalRef', 'capturedAt', 'contentText', 'contentHash', 'contentBytes'
      ] THEN
      -- The source has ten scalar fields; the exact-key count is part of the
      -- SQL boundary because this function is the only publication writer.
      RAISE EXCEPTION 'PROJECT_GIT_MATERIAL_SOURCE_SHAPE_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    source_key_count := (SELECT pg_catalog.count(*)::INTEGER FROM pg_catalog.jsonb_object_keys(source_item));
    IF source_key_count <> 10
       OR pg_catalog.jsonb_typeof(source_item -> 'materialKind') <> 'string'
       OR pg_catalog.jsonb_typeof(source_item -> 'remoteIdentity') <> 'string'
       OR pg_catalog.jsonb_typeof(source_item -> 'remoteRevisionFingerprint') <> 'string'
       OR pg_catalog.jsonb_typeof(source_item -> 'remoteNumber') <> 'number'
       OR source_item -> 'normalizedPath' <> 'null'::jsonb
       OR pg_catalog.jsonb_typeof(source_item -> 'externalRef') <> 'string'
       OR pg_catalog.jsonb_typeof(source_item -> 'capturedAt') <> 'string'
       OR pg_catalog.jsonb_typeof(source_item -> 'contentText') <> 'string'
       OR pg_catalog.jsonb_typeof(source_item -> 'contentHash') <> 'string'
       OR pg_catalog.jsonb_typeof(source_item -> 'contentBytes') <> 'number' THEN
      RAISE EXCEPTION 'PROJECT_GIT_MATERIAL_SOURCE_SHAPE_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    source_kind := source_item ->> 'materialKind';
    remote_identity := source_item ->> 'remoteIdentity';
    remote_revision_fingerprint := source_item ->> 'remoteRevisionFingerprint';
    remote_number := (source_item ->> 'remoteNumber')::INTEGER;
    external_ref := source_item ->> 'externalRef';
    captured_at_text := source_item ->> 'capturedAt';
    content_text := source_item ->> 'contentText';
    content_hash := source_item ->> 'contentHash';
    content_bytes := (source_item ->> 'contentBytes')::INTEGER;
    IF source_kind IS DISTINCT FROM expected_source_kind
       OR remote_identity !~ ('^' || CASE kind_value WHEN 'issue' THEN 'issue' WHEN 'pull_request' THEN 'pull_request' ELSE 'release' END || ':[1-9][0-9]{0,9}$')
       OR remote_identity IS DISTINCT FROM (CASE kind_value WHEN 'issue' THEN 'issue' WHEN 'pull_request' THEN 'pull_request' ELSE 'release' END || ':' || remote_number::text)
       OR remote_identity = ANY(seen_identities) OR remote_number <= 0 OR remote_number > 2147483647
       OR remote_revision_fingerprint !~ '^[0-9a-f]{64}$'
       OR pg_catalog.left(external_ref, pg_catalog.char_length(expected_ref_prefix)) IS DISTINCT FROM expected_ref_prefix
       OR external_ref ~ '[[:cntrl:]?#[:space:]]'
       OR captured_at_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$'
       OR pg_catalog.char_length(remote_identity) > 512 OR pg_catalog.char_length(external_ref) > 1024
       OR pg_catalog.octet_length(pg_catalog.convert_to(content_text, 'UTF8')) <> content_bytes
       OR content_bytes <= 0 OR content_hash !~ '^[0-9a-f]{64}$'
       OR pg_catalog.encode(public.digest(pg_catalog.convert_to(content_text, 'UTF8'), 'sha256'), 'hex') <> content_hash
       OR pg_catalog.strpos(content_text, E'\r') > 0 OR pg_catalog.char_length(content_text) > 8388608 THEN
      RAISE EXCEPTION 'PROJECT_GIT_MATERIAL_SOURCE_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    captured_at_value := (captured_at_text::TIMESTAMPTZ AT TIME ZONE 'UTC')::TIMESTAMP(3);
    decoded_text_bytes := decoded_text_bytes + content_bytes;
    IF decoded_text_bytes > 33554432 THEN
      RAISE EXCEPTION 'PROJECT_GIT_MATERIAL_DECODED_BYTES_LIMIT' USING ERRCODE = 'check_violation';
    END IF;
    manifest_payload := manifest_payload || E'\n'
      || pg_catalog.octet_length(source_kind)::text || ':' || source_kind
      || pg_catalog.octet_length(remote_identity)::text || ':' || remote_identity
      || pg_catalog.octet_length(remote_revision_fingerprint)::text || ':' || remote_revision_fingerprint
      || pg_catalog.octet_length(remote_number::text)::text || ':' || remote_number::text
      || pg_catalog.octet_length(external_ref)::text || ':' || external_ref
      || pg_catalog.octet_length(content_hash)::text || ':' || content_hash
      || pg_catalog.octet_length(content_bytes::text)::text || ':' || content_bytes::text
      || pg_catalog.octet_length(captured_at_text)::text || ':' || captured_at_text;
    seen_identities := pg_catalog.array_append(seen_identities, remote_identity);
    source_count := source_count + 1;
  END LOOP;
  manifest_fingerprint := pg_catalog.encode(public.digest(pg_catalog.convert_to(manifest_payload, 'UTF8'), 'sha256'), 'hex');
  published_at := database_now;
  IF run_row."expectedPublicationVersionId" IS NOT NULL
     AND baseline_row."manifestFingerprint" = manifest_fingerprint THEN
    PERFORM pg_catalog.set_config('ai_project_os.git_material_transition', 'finalize', TRUE);
    UPDATE public."ProjectGitRepositoryMaterialRun"
       SET "status" = 'unchanged', "leaseExpiresAt" = NULL, "completedAt" = database_now,
           "safeErrorCode" = NULL, "resultPublicationVersionId" = baseline_row."id",
           "resultPublicationGeneration" = run_row."expectedPublicationGeneration",
           "observedHeadCommitSha" = result_head_commit_sha, "manifestFingerprint" = manifest_fingerprint,
           "sourceCount" = source_count, "decodedTextBytes" = decoded_text_bytes::INTEGER,
           "version" = "version" + 1, "updatedAt" = database_now
     WHERE "id" = target_run;
    RETURN pg_catalog.jsonb_build_object('accepted', TRUE, 'status', 'unchanged',
      'publicationVersionId', baseline_row."id"::text, 'publicationGeneration', run_row."expectedPublicationGeneration",
      'manifestFingerprint', manifest_fingerprint, 'sourceCount', source_count, 'decodedTextBytes', decoded_text_bytes::INTEGER);
  END IF;

  new_version_id := pg_catalog.gen_random_uuid();
  IF run_row."expectedPublicationVersionId" IS NOT NULL THEN
    SELECT pg_catalog.count(*)::INTEGER INTO previous_entry_count
      FROM public."ProjectGitRepositoryMaterialPublicationEntry" entry
     WHERE entry."projectId" = run_row."projectId" AND entry."grantId" = grant_id
       AND entry."materialKind" = kind_value AND entry."publicationVersionId" = run_row."expectedPublicationVersionId";
    IF previous_entry_count <> baseline_row."sourceCount" THEN
      RAISE EXCEPTION 'PROJECT_GIT_MATERIAL_PREVIOUS_ENTRIES_MISSING' USING ERRCODE = 'check_violation';
    END IF;
    UPDATE public."ProjectSource" source_row
       SET "retiredAt" = published_at
      FROM public."ProjectGitRepositoryMaterialPublicationEntry" entry
     WHERE entry."projectId" = run_row."projectId" AND entry."grantId" = grant_id
       AND entry."materialKind" = kind_value AND entry."publicationVersionId" = run_row."expectedPublicationVersionId"
       AND source_row."projectId" = entry."projectId" AND source_row."id" = entry."projectSourceId"
       AND source_row."retiredAt" IS NULL;
    GET DIAGNOSTICS retired_count = ROW_COUNT;
    IF retired_count <> previous_entry_count THEN
      RAISE EXCEPTION 'PROJECT_GIT_MATERIAL_PREVIOUS_SOURCES_NOT_RETIRED' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  FOR source_item IN
    SELECT rows.item FROM pg_catalog.jsonb_array_elements(result_sources) AS rows(item)
    ORDER BY rows.item ->> 'remoteIdentity', rows.item ->> 'remoteRevisionFingerprint'
  LOOP
    remote_identity := source_item ->> 'remoteIdentity';
    remote_revision_fingerprint := source_item ->> 'remoteRevisionFingerprint';
    external_ref := source_item ->> 'externalRef';
    content_text := source_item ->> 'contentText';
    content_hash := source_item ->> 'contentHash';
    content_bytes := (source_item ->> 'contentBytes')::INTEGER;
    remote_number := (source_item ->> 'remoteNumber')::INTEGER;
    captured_at_text := source_item ->> 'capturedAt';
    captured_at_value := (captured_at_text::TIMESTAMPTZ AT TIME ZONE 'UTC')::TIMESTAMP(3);
    source_identity := public."project_git_automation_deterministic_uuid"(
      'project-git-material-source:v1:' || grant_id::text || ':' || kind_value::text || ':' || remote_identity);
    revision_key := public."project_git_automation_deterministic_uuid"(
      'project-git-material-revision:v1:' || grant_id::text || ':' || kind_value::text || ':'
      || remote_identity || ':' || remote_revision_fingerprint || ':' || content_hash || ':' || external_ref);
    INSERT INTO public."ProjectSource" (
      "id", "projectId", "kind", "originScope", "projectRepositoryLinkId", "sourceIdentity", "revisionKey",
      "externalRef", "contentText", "contentHash", "capturedAt"
    ) VALUES (
      pg_catalog.gen_random_uuid(), run_row."projectId", 'github', 'project', NULL, source_identity, revision_key,
      external_ref, content_text, content_hash, captured_at_value
    ) ON CONFLICT ("projectId", "sourceIdentity", "revisionKey") DO UPDATE
      SET "retiredAt" = NULL
    RETURNING "id" INTO project_source_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'PROJECT_GIT_MATERIAL_SOURCE_UPSERT_FAILED' USING ERRCODE = 'check_violation'; END IF;
  END LOOP;

  PERFORM pg_catalog.set_config('ai_project_os.git_material_transition', 'finalize', TRUE);
  UPDATE public."ProjectGitRepositoryMaterialRun"
     SET "status" = 'succeeded', "leaseExpiresAt" = NULL, "completedAt" = database_now,
         "safeErrorCode" = NULL, "resultPublicationVersionId" = new_version_id,
         "resultPublicationGeneration" = run_row."expectedPublicationGeneration" + 1,
         "observedHeadCommitSha" = result_head_commit_sha, "manifestFingerprint" = manifest_fingerprint,
         "sourceCount" = source_count, "decodedTextBytes" = decoded_text_bytes::INTEGER,
         "version" = "version" + 1, "updatedAt" = database_now
   WHERE "id" = target_run;

  PERFORM pg_catalog.set_config('ai_project_os.git_material_transition', 'automatic_finalize', TRUE);
  INSERT INTO public."ProjectGitRepositoryMaterialPublicationVersion" (
    "id", "projectId", "grantId", "materialKind", "runId", "previousVersionId", "previousGeneration",
    "grantVersion", "grantFingerprint", "baseDelegationId", "baseDelegationVersion", "baseDelegationFingerprint",
    "repositoryPath", "trackedRef", "githubRepositoryId", "githubRepositoryNodeId", "observedHeadCommitSha",
    "manifestFingerprint", "sourceCount", "decodedTextBytes", "publishedAt"
  ) VALUES (
    new_version_id, run_row."projectId", grant_id, kind_value, target_run, run_row."expectedPublicationVersionId",
    run_row."expectedPublicationGeneration", run_row."grantVersion", run_row."grantFingerprint", run_row."baseDelegationId",
    run_row."baseDelegationVersion", run_row."baseDelegationFingerprint", run_row."repositoryPath", run_row."trackedRef",
    result_repository_id, result_repository_node_id, result_head_commit_sha, manifest_fingerprint, source_count,
    decoded_text_bytes::INTEGER, published_at
  );
  source_ordinal := 0;
  FOR source_item IN
    SELECT rows.item FROM pg_catalog.jsonb_array_elements(result_sources) AS rows(item)
    ORDER BY rows.item ->> 'remoteIdentity', rows.item ->> 'remoteRevisionFingerprint'
  LOOP
    source_kind := source_item ->> 'materialKind';
    remote_identity := source_item ->> 'remoteIdentity';
    remote_revision_fingerprint := source_item ->> 'remoteRevisionFingerprint';
    remote_number := (source_item ->> 'remoteNumber')::INTEGER;
    external_ref := source_item ->> 'externalRef';
    content_text := source_item ->> 'contentText';
    content_hash := source_item ->> 'contentHash';
    content_bytes := (source_item ->> 'contentBytes')::INTEGER;
    captured_at_text := source_item ->> 'capturedAt';
    captured_at_value := (captured_at_text::TIMESTAMPTZ AT TIME ZONE 'UTC')::TIMESTAMP(3);
    source_identity := public."project_git_automation_deterministic_uuid"(
      'project-git-material-source:v1:' || grant_id::text || ':' || kind_value::text || ':' || remote_identity);
    revision_key := public."project_git_automation_deterministic_uuid"(
      'project-git-material-revision:v1:' || grant_id::text || ':' || kind_value::text || ':'
      || remote_identity || ':' || remote_revision_fingerprint || ':' || content_hash || ':' || external_ref);
    SELECT "id" INTO project_source_id FROM public."ProjectSource"
     WHERE "projectId" = run_row."projectId" AND "sourceIdentity" = source_identity AND "revisionKey" = revision_key;
    IF project_source_id IS NULL THEN RAISE EXCEPTION 'PROJECT_GIT_MATERIAL_SOURCE_MISSING' USING ERRCODE = 'check_violation'; END IF;

    INSERT INTO public."ProjectGitRepositoryMaterialSourceVersion" (
      "id", "projectId", "grantId", "materialKind", "publicationVersionId", "projectSourceId",
      "sourceIdentity", "revisionKey", "originScope", "remoteIdentity", "remoteRevisionFingerprint",
      "remoteNumber", "externalRef", "contentHash", "contentBytes", "capturedAt"
    ) VALUES (
      pg_catalog.gen_random_uuid(), run_row."projectId", grant_id, kind_value, new_version_id, project_source_id,
      source_identity, revision_key, 'project', remote_identity, remote_revision_fingerprint,
      remote_number, external_ref, content_hash, content_bytes, captured_at_value
    ) ON CONFLICT ("projectId", "grantId", "materialKind", "remoteIdentity", "remoteRevisionFingerprint") DO NOTHING;
    SELECT "id", "contentHash", "externalRef" INTO source_version_id, content_hash, external_ref
      FROM public."ProjectGitRepositoryMaterialSourceVersion"
     WHERE "projectId" = run_row."projectId" AND "grantId" = grant_id AND "materialKind" = kind_value
       AND "remoteIdentity" = source_item ->> 'remoteIdentity'
       AND "remoteRevisionFingerprint" = source_item ->> 'remoteRevisionFingerprint';
    IF NOT FOUND OR content_hash IS DISTINCT FROM source_item ->> 'contentHash'
       OR external_ref IS DISTINCT FROM source_item ->> 'externalRef' THEN
      RAISE EXCEPTION 'PROJECT_GIT_MATERIAL_SOURCE_VERSION_CONFLICT' USING ERRCODE = 'check_violation';
    END IF;
    INSERT INTO public."ProjectGitRepositoryMaterialPublicationEntry" (
      "id", "projectId", "grantId", "materialKind", "publicationVersionId", "sourceVersionId",
      "projectSourceId", "ordinal", "remoteIdentity", "remoteRevisionFingerprint", "externalRef",
      "contentHash", "contentBytes"
    ) VALUES (
      pg_catalog.gen_random_uuid(), run_row."projectId", grant_id, kind_value, new_version_id, source_version_id,
      project_source_id, source_ordinal, remote_identity, remote_revision_fingerprint, external_ref,
      content_hash, content_bytes
    );
    source_ordinal := source_ordinal + 1;
  END LOOP;

  IF run_row."expectedPublicationGeneration" = 0 THEN
    INSERT INTO public."ProjectGitRepositoryMaterialPublicationHead" (
      "projectId", "grantId", "materialKind", "currentVersionId", "generation", "publishedAt"
    ) VALUES (run_row."projectId", grant_id, kind_value, new_version_id, 1, published_at);
  ELSE
    UPDATE public."ProjectGitRepositoryMaterialPublicationHead"
       SET "currentVersionId" = new_version_id, "generation" = run_row."expectedPublicationGeneration" + 1,
           "publishedAt" = published_at
     WHERE "projectId" = run_row."projectId" AND "grantId" = grant_id AND "materialKind" = kind_value
       AND "currentVersionId" = run_row."expectedPublicationVersionId"
       AND "generation" = run_row."expectedPublicationGeneration";
    IF NOT FOUND THEN RAISE EXCEPTION 'PROJECT_GIT_MATERIAL_HEAD_CAS_MISMATCH' USING ERRCODE = 'serialization_failure'; END IF;
  END IF;
  RETURN pg_catalog.jsonb_build_object('accepted', TRUE, 'status', 'succeeded', 'publicationVersionId', new_version_id::text,
    'publicationGeneration', run_row."expectedPublicationGeneration" + 1, 'manifestFingerprint', manifest_fingerprint,
    'sourceCount', source_count, 'decodedTextBytes', decoded_text_bytes::INTEGER);
END;
$$;

REVOKE ALL ON FUNCTION public."project_git_material_guard_grant_scope"() FROM PUBLIC;
REVOKE ALL ON FUNCTION public."project_git_material_consent_audit_capture"() FROM PUBLIC;
REVOKE ALL ON FUNCTION public."project_git_material_append_only_guard"() FROM PUBLIC;
REVOKE ALL ON FUNCTION public."project_git_material_cursor_shape_guard"() FROM PUBLIC;
REVOKE ALL ON FUNCTION public."project_git_material_run_shape_guard"() FROM PUBLIC;
REVOKE ALL ON FUNCTION public."project_git_material_cursor_audit_capture"() FROM PUBLIC;
REVOKE ALL ON FUNCTION public."project_git_material_run_audit_capture"() FROM PUBLIC;
REVOKE ALL ON FUNCTION public."project_git_material_initialize_cursors"() FROM PUBLIC;
REVOKE ALL ON FUNCTION public."project_git_material_pause_on_grant_terminal"() FROM PUBLIC;
REVOKE ALL ON FUNCTION public."project_git_material_pause_cursor_after_unknown"() FROM PUBLIC;
REVOKE ALL ON FUNCTION public."project_git_material_run_snapshot_matches"(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public."project_git_material_claim_due"(UUID, public."ProjectGitRepositoryMaterialKind", VARCHAR) FROM PUBLIC;
REVOKE ALL ON FUNCTION public."project_git_material_mutate_lease"(UUID, VARCHAR, UUID, VARCHAR) FROM PUBLIC;
REVOKE ALL ON FUNCTION public."project_git_material_reconcile_expired"(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public."project_git_material_read_context"(UUID, VARCHAR, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public."project_git_material_insert_guard"() FROM PUBLIC;
REVOKE ALL ON FUNCTION public."project_git_material_head_guard"() FROM PUBLIC;
REVOKE ALL ON FUNCTION public."project_git_material_finalize_result"(UUID, VARCHAR, UUID, BIGINT, VARCHAR, VARCHAR, JSONB) FROM PUBLIC;
