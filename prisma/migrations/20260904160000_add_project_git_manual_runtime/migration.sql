-- Independent, one-shot manual read-only Git runtime.
-- This migration deliberately does not add a BackgroundJob kind and does not
-- touch ProjectGitRepositoryLink or any legacy Git/MCP runtime table.

CREATE TYPE "ProjectGitRepositoryManualRunStatus" AS ENUM (
  'queued', 'running', 'succeeded', 'failed', 'unknown'
);

CREATE TYPE "ProjectGitRepositoryManualRunStage" AS ENUM (
  'queued', 'admitted', 'fetching', 'validating', 'publishing', 'terminal'
);

CREATE TYPE "ProjectGitRepositoryManualRunDispatchState" AS ENUM (
  'pending', 'dispatched', 'acknowledged'
);

CREATE TYPE "ProjectGitRepositoryManualRunAuditAction" AS ENUM (
  'requested', 'admitted', 'dispatched', 'succeeded', 'failed', 'unknown', 'conflict'
);

CREATE TABLE "ProjectGitRepositoryManualRun" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "delegationId" UUID NOT NULL,
  "requestedById" UUID NOT NULL,
  "requestedByProjectMembershipId" UUID NOT NULL,
  "requestedByMembershipCreatedAt" TIMESTAMP(3) NOT NULL,
  "clientRequestKey" UUID NOT NULL,
  "status" "ProjectGitRepositoryManualRunStatus" NOT NULL DEFAULT 'queued',
  "stage" "ProjectGitRepositoryManualRunStage" NOT NULL DEFAULT 'queued',
  "dispatchState" "ProjectGitRepositoryManualRunDispatchState" NOT NULL DEFAULT 'pending',
  "failureCode" VARCHAR(64),
  "result" JSONB,
  "delegationVersion" INTEGER NOT NULL,
  "delegationFingerprint" CHAR(64) NOT NULL,
  "connectionOwnerId" UUID NOT NULL,
  "ownerProjectMembershipId" UUID NOT NULL,
  "ownerMembershipCreatedAt" TIMESTAMP(3) NOT NULL,
  "projectConfirmedById" UUID NOT NULL,
  "projectConfirmedProjectMembershipId" UUID NOT NULL,
  "projectConfirmedMembershipCreatedAt" TIMESTAMP(3) NOT NULL,
  "connectionConfigurationVersion" INTEGER NOT NULL,
  "resolvedAddressFingerprint" CHAR(64) NOT NULL,
  "credentialFingerprint" CHAR(64) NOT NULL,
  "repositoryPath" VARCHAR(768) NOT NULL,
  "trackedRef" VARCHAR(255) NOT NULL,
  "includeRoots" JSONB NOT NULL,
  "softExcludePatterns" JSONB NOT NULL,
  "role" "ProjectRepositoryRole" NOT NULL,
  "requiredForProjectSnapshot" BOOLEAN NOT NULL,
  "codeEnabled" BOOLEAN NOT NULL,
  "metadataEnabled" BOOLEAN NOT NULL,
  "manualSyncAllowed" BOOLEAN NOT NULL,
  "automationAllowed" BOOLEAN NOT NULL,
  "frozenCommitSha" CHAR(64),
  "manifestFingerprint" CHAR(64),
  "fileCount" INTEGER NOT NULL DEFAULT 0,
  "decodedTextBytes" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMPTZ(3),
  "completedAt" TIMESTAMPTZ(3),
  CONSTRAINT "ProjectGitRepositoryManualRun_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProjectGitRepositoryManualRun_client_key" UNIQUE ("delegationId", "clientRequestKey"),
  CONSTRAINT "ProjectGitRepositoryManualRun_project_id_key" UNIQUE ("projectId", "id"),
  CONSTRAINT "ProjectGitRepositoryManualRun_count_check" CHECK ("fileCount" >= 0 AND "decodedTextBytes" >= 0),
  CONSTRAINT "ProjectGitRepositoryManualRun_uuid_key_check" CHECK ("clientRequestKey" <> '00000000-0000-0000-0000-000000000000'::uuid),
  CONSTRAINT "ProjectGitRepositoryManualRun_manual_only_check" CHECK ("manualSyncAllowed" = true)
);

CREATE TABLE "ProjectGitRepositoryManualRunEntry" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "runId" UUID NOT NULL,
  "delegationId" UUID NOT NULL,
  "delegationVersion" INTEGER NOT NULL,
  "delegationFingerprint" CHAR(64) NOT NULL,
  "projectSourceId" UUID NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "normalizedPath" VARCHAR(1024) NOT NULL,
  "blobOid" VARCHAR(128) NOT NULL,
  "contentHash" CHAR(64) NOT NULL,
  "contentBytes" INTEGER NOT NULL,
  "lineCount" INTEGER NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProjectGitRepositoryManualRunEntry_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProjectGitRepositoryManualRunEntry_project_id_key" UNIQUE ("projectId", "id"),
  CONSTRAINT "ProjectGitRepositoryManualRunEntry_run_path_key" UNIQUE ("runId", "normalizedPath"),
  CONSTRAINT "ProjectGitRepositoryManualRunEntry_run_ordinal_key" UNIQUE ("runId", "ordinal"),
  CONSTRAINT "ProjectGitRepositoryManualRunEntry_shape_check" CHECK ("ordinal" >= 0 AND "contentBytes" >= 0 AND "lineCount" >= 0)
);

CREATE TABLE "ProjectGitRepositoryManualPointer" (
  "projectId" UUID NOT NULL,
  "delegationId" UUID NOT NULL,
  "runId" UUID NOT NULL,
  "delegationVersion" INTEGER NOT NULL,
  "delegationFingerprint" CHAR(64) NOT NULL,
  "frozenCommitSha" CHAR(64) NOT NULL,
  "manifestFingerprint" CHAR(64) NOT NULL,
  "publishedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProjectGitRepositoryManualPointer_pkey" PRIMARY KEY ("projectId", "delegationId"),
  CONSTRAINT "ProjectGitRepositoryManualPointer_run_key" UNIQUE ("projectId", "runId")
);

CREATE TABLE "ProjectGitRepositoryManualRunAudit" (
  "id" UUID NOT NULL,
  "runId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "delegationId" UUID NOT NULL,
  "action" "ProjectGitRepositoryManualRunAuditAction" NOT NULL,
  "statusBefore" "ProjectGitRepositoryManualRunStatus",
  "statusAfter" "ProjectGitRepositoryManualRunStatus" NOT NULL,
  "dispatchState" "ProjectGitRepositoryManualRunDispatchState" NOT NULL,
  "actorId" UUID,
  "requestedById" UUID NOT NULL,
  "requestedByProjectMembershipId" UUID NOT NULL,
  "requestedByMembershipCreatedAt" TIMESTAMP(3) NOT NULL,
  "connectionOwnerId" UUID NOT NULL,
  "ownerProjectMembershipId" UUID NOT NULL,
  "ownerMembershipCreatedAt" TIMESTAMP(3) NOT NULL,
  "projectConfirmedById" UUID NOT NULL,
  "projectConfirmedProjectMembershipId" UUID NOT NULL,
  "projectConfirmedMembershipCreatedAt" TIMESTAMP(3) NOT NULL,
  "reason" VARCHAR(500) NOT NULL,
  "delegationVersion" INTEGER NOT NULL,
  "delegationFingerprint" CHAR(64) NOT NULL,
  "connectionConfigurationVersion" INTEGER NOT NULL,
  "resolvedAddressFingerprint" CHAR(64) NOT NULL,
  "credentialFingerprint" CHAR(64) NOT NULL,
  "role" "ProjectRepositoryRole" NOT NULL,
  "requiredForProjectSnapshot" BOOLEAN NOT NULL,
  "codeEnabled" BOOLEAN NOT NULL,
  "metadataEnabled" BOOLEAN NOT NULL,
  "manualSyncAllowed" BOOLEAN NOT NULL,
  "automationAllowed" BOOLEAN NOT NULL,
  "commitSha" CHAR(64),
  "manifestFingerprint" CHAR(64),
  "transitionAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "transactionId" BIGINT NOT NULL DEFAULT txid_current(),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProjectGitRepositoryManualRunAudit_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ProjectGitRepositoryManualRun"
  ADD CONSTRAINT "ProjectGitRepositoryManualRun_project_fkey"
    FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProjectGitRepositoryManualRunEntry"
  ADD CONSTRAINT "ProjectGitRepositoryManualRunEntry_project_fkey"
    FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "ProjectGitRepositoryManualRunEntry_run_fkey"
    FOREIGN KEY ("projectId", "runId") REFERENCES "ProjectGitRepositoryManualRun"("projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "ProjectGitRepositoryManualRunEntry_source_fkey"
    FOREIGN KEY ("projectId", "projectSourceId") REFERENCES "ProjectSource"("projectId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "ProjectGitRepositoryManualPointer"
  ADD CONSTRAINT "ProjectGitRepositoryManualPointer_project_fkey"
    FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "ProjectGitRepositoryManualPointer_run_fkey"
    FOREIGN KEY ("projectId", "runId") REFERENCES "ProjectGitRepositoryManualRun"("projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "ProjectGitRepositoryManualRun_delegation_status_created_idx"
  ON "ProjectGitRepositoryManualRun" ("delegationId", "status", "createdAt");
CREATE INDEX "ProjectGitRepositoryManualRun_project_created_idx"
  ON "ProjectGitRepositoryManualRun" ("projectId", "createdAt");
CREATE INDEX "ProjectGitRepositoryManualRun_requested_created_idx"
  ON "ProjectGitRepositoryManualRun" ("requestedById", "createdAt");
CREATE UNIQUE INDEX "ProjectGitRepositoryManualRun_live_delegation_key"
  ON "ProjectGitRepositoryManualRun" ("delegationId")
  WHERE "status" IN ('queued', 'running');
CREATE INDEX "ProjectGitRepositoryManualRunEntry_project_source_idx"
  ON "ProjectGitRepositoryManualRunEntry" ("projectId", "projectSourceId");
CREATE INDEX "ProjectGitRepositoryManualRunEntry_delegation_created_idx"
  ON "ProjectGitRepositoryManualRunEntry" ("delegationId", "createdAt");
CREATE INDEX "ProjectGitRepositoryManualPointer_delegation_published_idx"
  ON "ProjectGitRepositoryManualPointer" ("delegationId", "publishedAt");
CREATE INDEX "ProjectGitRepositoryManualRunAudit_run_created_idx"
  ON "ProjectGitRepositoryManualRunAudit" ("runId", "createdAt");
CREATE INDEX "ProjectGitRepositoryManualRunAudit_delegation_created_idx"
  ON "ProjectGitRepositoryManualRunAudit" ("delegationId", "createdAt");
CREATE INDEX "ProjectGitRepositoryManualRunAudit_project_created_idx"
  ON "ProjectGitRepositoryManualRunAudit" ("projectId", "createdAt");

-- The manifest is deliberately canonicalized in the database.  Each field is
-- length-prefixed so paths and other text values cannot create an ambiguous
-- concatenation, and the version prefix leaves room for future encodings.
CREATE OR REPLACE FUNCTION "project_git_manual_runtime_manifest"(run_uuid UUID)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  payload TEXT := 'project-git-manual-runtime:v1';
  entry_row RECORD;
BEGIN
  FOR entry_row IN
    SELECT "ordinal", "normalizedPath", "blobOid", "contentHash", "contentBytes", "lineCount"
    FROM "ProjectGitRepositoryManualRunEntry"
    WHERE "runId" = run_uuid
    ORDER BY "ordinal" ASC
  LOOP
    payload := payload || E'\n'
      || octet_length(entry_row."ordinal"::text)::text || ':' || entry_row."ordinal"::text
      || octet_length(entry_row."normalizedPath")::text || ':' || entry_row."normalizedPath"
      || octet_length(entry_row."blobOid")::text || ':' || entry_row."blobOid"
      || octet_length(entry_row."contentHash")::text || ':' || entry_row."contentHash"
      || octet_length(entry_row."contentBytes"::text)::text || ':' || entry_row."contentBytes"::text
      || octet_length(entry_row."lineCount"::text)::text || ':' || entry_row."lineCount"::text;
  END LOOP;
  RETURN encode(digest(convert_to(payload, 'UTF8'), 'sha256'), 'hex');
END;
$$;

CREATE OR REPLACE FUNCTION "project_git_manual_runtime_live_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  delegation_row RECORD;
  connection_valid BOOLEAN;
  owner_membership_valid BOOLEAN;
  project_membership_valid BOOLEAN;
  actor_valid BOOLEAN;
BEGIN
  IF NEW."status" NOT IN ('queued', 'running') THEN
    RETURN NEW;
  END IF;

  SELECT delegation.* INTO delegation_row
  FROM "ProjectGitRepositoryDelegation" delegation
  WHERE delegation."id" = NEW."delegationId"
    AND delegation."projectId" = NEW."projectId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROJECT_GIT_MANUAL_DELEGATION_NOT_FOUND' USING ERRCODE = 'check_violation';
  END IF;
  IF delegation_row."status" <> 'active'
     OR delegation_row."manualSyncAllowed" IS NOT TRUE
     OR delegation_row."expiresAt" <= clock_timestamp()
     OR delegation_row."version" <> NEW."delegationVersion"
     OR delegation_row."delegationFingerprint" <> NEW."delegationFingerprint"
     OR delegation_row."connectionOwnerId" <> NEW."connectionOwnerId"
     OR delegation_row."ownerProjectMembershipId" <> NEW."ownerProjectMembershipId"
     OR delegation_row."ownerMembershipCreatedAt" <> NEW."ownerMembershipCreatedAt"
     OR delegation_row."projectConfirmedById" <> NEW."projectConfirmedById"
     OR delegation_row."projectConfirmedProjectMembershipId" <> NEW."projectConfirmedProjectMembershipId"
     OR delegation_row."projectConfirmedMembershipCreatedAt" <> NEW."projectConfirmedMembershipCreatedAt"
     OR delegation_row."connectionConfigurationVersion" <> NEW."connectionConfigurationVersion"
     OR delegation_row."resolvedAddressFingerprint" <> NEW."resolvedAddressFingerprint"
     OR delegation_row."credentialFingerprint" <> NEW."credentialFingerprint"
     OR delegation_row."repositoryPath" <> NEW."repositoryPath"
     OR delegation_row."trackedRef" <> NEW."trackedRef"
     OR delegation_row."includeRoots" <> NEW."includeRoots"
     OR delegation_row."softExcludePatterns" <> NEW."softExcludePatterns"
     OR delegation_row."role" <> NEW."role"
     OR delegation_row."requiredForProjectSnapshot" <> NEW."requiredForProjectSnapshot"
     OR delegation_row."codeEnabled" <> NEW."codeEnabled"
     OR delegation_row."metadataEnabled" <> NEW."metadataEnabled"
     OR delegation_row."manualSyncAllowed" <> NEW."manualSyncAllowed"
     OR delegation_row."automationAllowed" <> NEW."automationAllowed" THEN
    RAISE EXCEPTION 'PROJECT_GIT_MANUAL_DELEGATION_EVIDENCE_STALE' USING ERRCODE = 'check_violation';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM "GitConnection" connection
    JOIN "ExternalCredential" credential ON credential."id" = connection."credentialId"
    WHERE connection."id" = delegation_row."gitConnectionId"
      AND connection."ownerUserId" = delegation_row."connectionOwnerId"
      AND connection."ownershipState" = 'confirmed'
      AND connection."status" = 'verified'
      AND connection."configurationVersion" = delegation_row."connectionConfigurationVersion"
      AND connection."resolvedAddressFingerprint" = delegation_row."resolvedAddressFingerprint"
      AND credential."kind" = 'git'
      AND credential."secretFingerprint" = delegation_row."credentialFingerprint"
  ) INTO connection_valid;
  IF NOT connection_valid THEN
    RAISE EXCEPTION 'PROJECT_GIT_MANUAL_CONNECTION_EVIDENCE_STALE' USING ERRCODE = 'check_violation';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM "AppUser" user_row
    JOIN "ProjectMembership" membership ON membership."id" = delegation_row."ownerProjectMembershipId"
    WHERE user_row."id" = delegation_row."connectionOwnerId"
      AND user_row."disabledAt" IS NULL
      AND membership."projectId" = delegation_row."projectId"
      AND membership."userId" = delegation_row."connectionOwnerId"
      AND membership."role" IN ('owner', 'editor')
      AND membership."accessState" = 'confirmed'
      AND membership."createdAt" = delegation_row."ownerMembershipCreatedAt"
  ) INTO owner_membership_valid;
  SELECT EXISTS (
    SELECT 1 FROM "AppUser" user_row
    JOIN "ProjectMembership" membership ON membership."id" = delegation_row."projectConfirmedProjectMembershipId"
    WHERE user_row."id" = delegation_row."projectConfirmedById"
      AND user_row."disabledAt" IS NULL
      AND membership."id" = delegation_row."projectConfirmedProjectMembershipId"
      AND membership."projectId" = delegation_row."projectId"
      AND membership."userId" = delegation_row."projectConfirmedById"
      AND membership."role" = 'owner'
      AND membership."accessState" = 'confirmed'
      AND membership."createdAt" = delegation_row."projectConfirmedMembershipCreatedAt"
  ) INTO project_membership_valid;
  SELECT EXISTS (
    SELECT 1 FROM "AppUser" user_row
    JOIN "ProjectMembership" membership ON membership."id" = NEW."requestedByProjectMembershipId"
    JOIN "Project" project_row ON project_row."id" = NEW."projectId"
    WHERE user_row."id" = NEW."requestedById"
      AND user_row."disabledAt" IS NULL
      AND project_row."archivedAt" IS NULL
      AND membership."projectId" = NEW."projectId"
      AND membership."userId" = NEW."requestedById"
      AND membership."role" IN ('owner', 'editor')
      AND membership."accessState" = 'confirmed'
      AND membership."createdAt" = NEW."requestedByMembershipCreatedAt"
  ) INTO actor_valid;
  IF NOT owner_membership_valid OR NOT project_membership_valid OR NOT actor_valid THEN
    RAISE EXCEPTION 'PROJECT_GIT_MANUAL_MEMBERSHIP_EVIDENCE_STALE' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ProjectGitRepositoryManualRun_live_guard"
BEFORE INSERT OR UPDATE ON "ProjectGitRepositoryManualRun"
FOR EACH ROW EXECUTE FUNCTION "project_git_manual_runtime_live_guard"();

CREATE OR REPLACE FUNCTION "project_git_manual_runtime_shape_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'queued' OR NEW."stage" <> 'queued' OR NEW."dispatchState" <> 'pending'
       OR NEW."manualSyncAllowed" IS NOT TRUE OR NEW."startedAt" IS NOT NULL
       OR NEW."completedAt" IS NOT NULL OR NEW."failureCode" IS NOT NULL
       OR NEW."result" IS NOT NULL OR NEW."frozenCommitSha" IS NOT NULL
       OR NEW."manifestFingerprint" IS NOT NULL OR NEW."fileCount" <> 0
       OR NEW."decodedTextBytes" <> 0 THEN
      RAISE EXCEPTION 'PROJECT_GIT_MANUAL_RUN_INITIAL_STATE_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF OLD."projectId" IS DISTINCT FROM NEW."projectId"
       OR OLD."delegationId" IS DISTINCT FROM NEW."delegationId"
       OR OLD."requestedById" IS DISTINCT FROM NEW."requestedById"
       OR OLD."requestedByProjectMembershipId" IS DISTINCT FROM NEW."requestedByProjectMembershipId"
       OR OLD."requestedByMembershipCreatedAt" IS DISTINCT FROM NEW."requestedByMembershipCreatedAt"
       OR OLD."clientRequestKey" IS DISTINCT FROM NEW."clientRequestKey"
       OR OLD."delegationVersion" IS DISTINCT FROM NEW."delegationVersion"
       OR OLD."delegationFingerprint" IS DISTINCT FROM NEW."delegationFingerprint"
       OR OLD."connectionOwnerId" IS DISTINCT FROM NEW."connectionOwnerId"
       OR OLD."ownerProjectMembershipId" IS DISTINCT FROM NEW."ownerProjectMembershipId"
       OR OLD."ownerMembershipCreatedAt" IS DISTINCT FROM NEW."ownerMembershipCreatedAt"
       OR OLD."projectConfirmedById" IS DISTINCT FROM NEW."projectConfirmedById"
       OR OLD."projectConfirmedProjectMembershipId" IS DISTINCT FROM NEW."projectConfirmedProjectMembershipId"
       OR OLD."projectConfirmedMembershipCreatedAt" IS DISTINCT FROM NEW."projectConfirmedMembershipCreatedAt"
       OR OLD."connectionConfigurationVersion" IS DISTINCT FROM NEW."connectionConfigurationVersion"
       OR OLD."resolvedAddressFingerprint" IS DISTINCT FROM NEW."resolvedAddressFingerprint"
       OR OLD."credentialFingerprint" IS DISTINCT FROM NEW."credentialFingerprint"
       OR OLD."repositoryPath" IS DISTINCT FROM NEW."repositoryPath"
       OR OLD."trackedRef" IS DISTINCT FROM NEW."trackedRef"
       OR OLD."includeRoots" IS DISTINCT FROM NEW."includeRoots"
       OR OLD."softExcludePatterns" IS DISTINCT FROM NEW."softExcludePatterns"
       OR OLD."role" IS DISTINCT FROM NEW."role"
       OR OLD."requiredForProjectSnapshot" IS DISTINCT FROM NEW."requiredForProjectSnapshot"
       OR OLD."codeEnabled" IS DISTINCT FROM NEW."codeEnabled"
       OR OLD."metadataEnabled" IS DISTINCT FROM NEW."metadataEnabled"
       OR OLD."manualSyncAllowed" IS DISTINCT FROM NEW."manualSyncAllowed"
       OR OLD."automationAllowed" IS DISTINCT FROM NEW."automationAllowed" THEN
      RAISE EXCEPTION 'PROJECT_GIT_MANUAL_RUN_EVIDENCE_IMMUTABLE' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."createdAt" IS DISTINCT FROM NEW."createdAt" THEN
      RAISE EXCEPTION 'PROJECT_GIT_MANUAL_RUN_CREATED_AT_IMMUTABLE' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" IN ('succeeded', 'failed', 'unknown') THEN
      RAISE EXCEPTION 'PROJECT_GIT_MANUAL_RUN_TERMINAL_IMMUTABLE' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT (
      (OLD."status" = 'queued' AND NEW."status" = 'running' AND NEW."stage" IN ('admitted', 'fetching'))
      OR (OLD."status" = 'running' AND NEW."status" = 'running'
        AND (
          (OLD."stage" = 'fetching' AND NEW."stage" IN ('fetching', 'validating'))
          OR (OLD."stage" = 'validating' AND NEW."stage" IN ('validating', 'publishing'))
          OR (OLD."stage" = 'publishing' AND NEW."stage" = 'publishing')
        ))
      OR (OLD."status" = 'running' AND NEW."status" IN ('succeeded', 'failed', 'unknown') AND NEW."stage" = 'terminal')
    ) THEN
      RAISE EXCEPTION 'PROJECT_GIT_MANUAL_RUN_STATE_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'queued' AND NEW."status" = 'running' THEN
      IF NEW."dispatchState" <> 'dispatched'
         OR NEW."startedAt" IS NULL
         OR NEW."failureCode" IS NOT NULL
         OR NEW."result" IS NOT NULL
         OR NEW."completedAt" IS NOT NULL
         OR NEW."frozenCommitSha" IS DISTINCT FROM OLD."frozenCommitSha"
         OR NEW."manifestFingerprint" IS DISTINCT FROM OLD."manifestFingerprint"
         OR NEW."fileCount" <> OLD."fileCount"
         OR NEW."decodedTextBytes" <> OLD."decodedTextBytes" THEN
        RAISE EXCEPTION 'PROJECT_GIT_MANUAL_RUN_DISPATCH_INVALID' USING ERRCODE = 'check_violation';
      END IF;
    ELSIF OLD."status" = 'running' AND NEW."status" = 'running' THEN
      IF NEW."dispatchState" <> 'dispatched'
         OR NEW."startedAt" IS DISTINCT FROM OLD."startedAt"
         OR NEW."failureCode" IS DISTINCT FROM OLD."failureCode"
         OR NEW."result" IS DISTINCT FROM OLD."result"
         OR NEW."completedAt" IS DISTINCT FROM OLD."completedAt"
         OR NEW."frozenCommitSha" IS DISTINCT FROM OLD."frozenCommitSha"
         OR NEW."manifestFingerprint" IS DISTINCT FROM OLD."manifestFingerprint"
         OR NEW."fileCount" <> OLD."fileCount"
         OR NEW."decodedTextBytes" <> OLD."decodedTextBytes" THEN
        RAISE EXCEPTION 'PROJECT_GIT_MANUAL_RUN_RUNNING_EVIDENCE_IMMUTABLE' USING ERRCODE = 'check_violation';
      END IF;
    ELSIF OLD."status" = 'running' AND NEW."status" IN ('failed', 'unknown') THEN
      IF NEW."dispatchState" <> 'acknowledged' AND NEW."dispatchState" <> 'dispatched'
         OR NEW."completedAt" IS NULL
         OR NEW."failureCode" IS NULL
         OR NEW."result" IS DISTINCT FROM OLD."result"
         OR NEW."startedAt" IS DISTINCT FROM OLD."startedAt"
         OR NEW."frozenCommitSha" IS DISTINCT FROM OLD."frozenCommitSha"
         OR NEW."manifestFingerprint" IS DISTINCT FROM OLD."manifestFingerprint"
         OR NEW."fileCount" <> OLD."fileCount"
         OR NEW."decodedTextBytes" <> OLD."decodedTextBytes" THEN
        RAISE EXCEPTION 'PROJECT_GIT_MANUAL_RUN_TERMINAL_EVIDENCE_INVALID' USING ERRCODE = 'check_violation';
      END IF;
    ELSIF OLD."status" = 'running' AND NEW."status" = 'succeeded' THEN
      IF NEW."dispatchState" <> 'acknowledged'
         OR NEW."completedAt" IS NULL
         OR NEW."failureCode" IS NOT NULL
         OR NEW."result" IS NULL
         OR NEW."startedAt" IS DISTINCT FROM OLD."startedAt"
         OR NEW."frozenCommitSha" IS NULL
         OR NEW."manifestFingerprint" IS NULL THEN
        RAISE EXCEPTION 'PROJECT_GIT_MANUAL_RUN_RESULT_REQUIRED' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ProjectGitRepositoryManualRun_shape_guard"
BEFORE INSERT OR UPDATE ON "ProjectGitRepositoryManualRun"
FOR EACH ROW EXECUTE FUNCTION "project_git_manual_runtime_shape_guard"();

CREATE OR REPLACE FUNCTION "project_git_manual_runtime_run_delete_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF pg_trigger_depth() <= 1 THEN
    RAISE EXCEPTION 'PROJECT_GIT_MANUAL_RUN_DELETE_FORBIDDEN' USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER "ProjectGitRepositoryManualRun_delete_guard"
BEFORE DELETE ON "ProjectGitRepositoryManualRun"
FOR EACH ROW EXECUTE FUNCTION "project_git_manual_runtime_run_delete_guard"();

CREATE OR REPLACE FUNCTION "project_git_manual_runtime_entry_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  run_row RECORD;
  source_row RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() <= 1 THEN
      RAISE EXCEPTION 'PROJECT_GIT_MANUAL_RUN_ENTRY_DELETE_FORBIDDEN' USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  SELECT run.* INTO run_row
  FROM "ProjectGitRepositoryManualRun" run
  WHERE run."id" = NEW."runId" AND run."projectId" = NEW."projectId";
  IF NOT FOUND OR run_row."delegationId" <> NEW."delegationId"
     OR run_row."delegationVersion" <> NEW."delegationVersion"
     OR run_row."delegationFingerprint" <> NEW."delegationFingerprint"
     OR run_row."status" <> 'running' OR run_row."stage" <> 'publishing' THEN
    RAISE EXCEPTION 'PROJECT_GIT_MANUAL_RUN_ENTRY_ADMISSION_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  SELECT source.* INTO source_row
  FROM "ProjectSource" source
  WHERE source."id" = NEW."projectSourceId" AND source."projectId" = NEW."projectId";
  IF NOT FOUND OR source_row."kind" <> 'git' OR source_row."projectRepositoryLinkId" IS NOT NULL
     OR source_row."contentHash" IS DISTINCT FROM NEW."contentHash" THEN
    RAISE EXCEPTION 'PROJECT_GIT_MANUAL_SOURCE_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND run_row."status" <> 'running' THEN
    RAISE EXCEPTION 'PROJECT_GIT_MANUAL_RUN_ENTRY_IMMUTABLE' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ProjectGitRepositoryManualRunEntry_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "ProjectGitRepositoryManualRunEntry"
FOR EACH ROW EXECUTE FUNCTION "project_git_manual_runtime_entry_guard"();

CREATE OR REPLACE FUNCTION "project_git_manual_runtime_pointer_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  run_row RECORD;
  old_run_row RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() <= 1 THEN
      RAISE EXCEPTION 'PROJECT_GIT_MANUAL_POINTER_DELETE_FORBIDDEN' USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  SELECT run.* INTO run_row
  FROM "ProjectGitRepositoryManualRun" run
  WHERE run."id" = NEW."runId" AND run."projectId" = NEW."projectId";
  IF NOT FOUND OR run_row."status" <> 'succeeded'
     OR run_row."completedAt" IS NULL
     OR run_row."delegationId" <> NEW."delegationId"
     OR run_row."delegationVersion" <> NEW."delegationVersion"
     OR run_row."delegationFingerprint" <> NEW."delegationFingerprint"
     OR run_row."frozenCommitSha" <> NEW."frozenCommitSha"
     OR run_row."manifestFingerprint" <> NEW."manifestFingerprint" THEN
    RAISE EXCEPTION 'PROJECT_GIT_MANUAL_POINTER_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."publishedAt" IS DISTINCT FROM run_row."completedAt" THEN
    RAISE EXCEPTION 'PROJECT_GIT_MANUAL_POINTER_TIME_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."runId" IS DISTINCT FROM NEW."runId" THEN
    SELECT run.* INTO old_run_row
    FROM "ProjectGitRepositoryManualRun" run
    WHERE run."id" = OLD."runId" AND run."projectId" = OLD."projectId";
    IF NOT FOUND OR old_run_row."completedAt" IS NULL
       OR run_row."completedAt" <= old_run_row."completedAt" THEN
      RAISE EXCEPTION 'PROJECT_GIT_MANUAL_POINTER_ROLLBACK' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ProjectGitRepositoryManualPointer_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "ProjectGitRepositoryManualPointer"
FOR EACH ROW EXECUTE FUNCTION "project_git_manual_runtime_pointer_guard"();

CREATE OR REPLACE FUNCTION "project_git_manual_runtime_audit_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  run_row RECORD;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'PROJECT_GIT_MANUAL_AUDIT_APPEND_ONLY' USING ERRCODE = 'check_violation';
  END IF;
  IF current_setting('ai.project_git_manual_runtime_audit', true) <> '1' THEN
    RAISE EXCEPTION 'PROJECT_GIT_MANUAL_AUDIT_CONTEXT_REQUIRED' USING ERRCODE = 'check_violation';
  END IF;
  SELECT run.* INTO run_row
  FROM "ProjectGitRepositoryManualRun" run
  WHERE run."id" = NEW."runId";
  IF NOT FOUND
     OR run_row."projectId" <> NEW."projectId"
     OR run_row."delegationId" <> NEW."delegationId"
     OR run_row."status" <> NEW."statusAfter"
     OR run_row."dispatchState" <> NEW."dispatchState"
     OR run_row."requestedById" <> NEW."requestedById"
     OR run_row."requestedByProjectMembershipId" <> NEW."requestedByProjectMembershipId"
     OR run_row."requestedByMembershipCreatedAt" <> NEW."requestedByMembershipCreatedAt"
     OR run_row."connectionOwnerId" <> NEW."connectionOwnerId"
     OR run_row."ownerProjectMembershipId" <> NEW."ownerProjectMembershipId"
     OR run_row."ownerMembershipCreatedAt" <> NEW."ownerMembershipCreatedAt"
     OR run_row."projectConfirmedById" <> NEW."projectConfirmedById"
     OR run_row."projectConfirmedProjectMembershipId" <> NEW."projectConfirmedProjectMembershipId"
     OR run_row."projectConfirmedMembershipCreatedAt" <> NEW."projectConfirmedMembershipCreatedAt"
     OR run_row."delegationVersion" <> NEW."delegationVersion"
     OR run_row."delegationFingerprint" <> NEW."delegationFingerprint"
     OR run_row."connectionConfigurationVersion" <> NEW."connectionConfigurationVersion"
     OR run_row."resolvedAddressFingerprint" <> NEW."resolvedAddressFingerprint"
     OR run_row."credentialFingerprint" <> NEW."credentialFingerprint"
     OR run_row."role" <> NEW."role"
     OR run_row."requiredForProjectSnapshot" <> NEW."requiredForProjectSnapshot"
     OR run_row."codeEnabled" <> NEW."codeEnabled"
     OR run_row."metadataEnabled" <> NEW."metadataEnabled"
     OR run_row."manualSyncAllowed" <> NEW."manualSyncAllowed"
     OR run_row."automationAllowed" <> NEW."automationAllowed" THEN
    RAISE EXCEPTION 'PROJECT_GIT_MANUAL_AUDIT_EVIDENCE_MISMATCH' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."action" = 'requested' THEN
    IF NEW."statusBefore" IS NOT NULL OR NEW."statusAfter" <> 'queued' OR NEW."dispatchState" <> 'pending' THEN
      RAISE EXCEPTION 'PROJECT_GIT_MANUAL_AUDIT_SHAPE_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."action" IN ('admitted', 'dispatched') THEN
    IF NEW."statusBefore" IS DISTINCT FROM 'queued' OR NEW."statusAfter" <> 'running' OR NEW."dispatchState" <> 'dispatched' THEN
      RAISE EXCEPTION 'PROJECT_GIT_MANUAL_AUDIT_SHAPE_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."action" = 'succeeded' THEN
    IF NEW."statusBefore" IS DISTINCT FROM 'running' OR NEW."statusAfter" <> 'succeeded' OR NEW."dispatchState" <> 'acknowledged' THEN
      RAISE EXCEPTION 'PROJECT_GIT_MANUAL_AUDIT_SHAPE_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."action" = 'failed' THEN
    IF NEW."statusBefore" IS DISTINCT FROM 'running' OR NEW."statusAfter" <> 'failed' OR NEW."dispatchState" <> 'acknowledged' THEN
      RAISE EXCEPTION 'PROJECT_GIT_MANUAL_AUDIT_SHAPE_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."action" = 'unknown' THEN
    IF NEW."statusBefore" IS DISTINCT FROM 'running' OR NEW."statusAfter" <> 'unknown' OR NEW."dispatchState" <> 'dispatched' THEN
      RAISE EXCEPTION 'PROJECT_GIT_MANUAL_AUDIT_SHAPE_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    RAISE EXCEPTION 'PROJECT_GIT_MANUAL_AUDIT_SHAPE_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."action" IN ('requested', 'admitted', 'dispatched', 'succeeded', 'failed')
     AND NEW."actorId" IS DISTINCT FROM run_row."requestedById" THEN
    RAISE EXCEPTION 'PROJECT_GIT_MANUAL_AUDIT_ACTOR_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."action" = 'unknown' AND NEW."actorId" IS NOT NULL THEN
    RAISE EXCEPTION 'PROJECT_GIT_MANUAL_AUDIT_SYSTEM_ACTOR_REQUIRED' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."statusAfter" = 'succeeded' THEN
    IF NEW."commitSha" IS NULL OR NEW."manifestFingerprint" IS NULL
       OR NEW."commitSha" IS DISTINCT FROM run_row."frozenCommitSha"
       OR NEW."manifestFingerprint" IS DISTINCT FROM run_row."manifestFingerprint" THEN
      RAISE EXCEPTION 'PROJECT_GIT_MANUAL_AUDIT_RESULT_MISMATCH' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."commitSha" IS DISTINCT FROM run_row."frozenCommitSha"
     OR NEW."manifestFingerprint" IS DISTINCT FROM run_row."manifestFingerprint" THEN
    RAISE EXCEPTION 'PROJECT_GIT_MANUAL_AUDIT_RESULT_UNEXPECTED' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ProjectGitRepositoryManualRunAudit_append_only"
BEFORE INSERT OR UPDATE OR DELETE ON "ProjectGitRepositoryManualRunAudit"
FOR EACH ROW EXECUTE FUNCTION "project_git_manual_runtime_audit_guard"();

-- A succeeded row is only valid when the complete publication and the live
-- authorization evidence are present in the same transaction.  The trigger
-- is deferred so the service can stage entries, source rows, the pointer, and
-- the succeeded audit before this final check runs at commit.
CREATE OR REPLACE FUNCTION "project_git_manual_runtime_success_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  evidence_valid BOOLEAN;
  entry_count INTEGER;
  entry_bytes BIGINT;
  entry_ordinals_valid BOOLEAN;
  source_count INTEGER;
  source_values_valid BOOLEAN;
  pointer_count INTEGER;
  pointer_values_valid BOOLEAN;
  success_audit_count INTEGER;
  success_audit_valid BOOLEAN;
  canonical_manifest TEXT;
BEGIN
  IF NEW."status" <> 'succeeded' THEN
    RETURN NEW;
  END IF;
  -- Serialize final publication validation with the PGRD mutation fence. The
  -- runtime already owns this transaction lock; raw SQL success transitions
  -- acquire it here before any live-evidence check can observe a moving
  -- delegation or connection snapshot.
  PERFORM pg_advisory_xact_lock(hashtextextended('ai-project-git-repository-delegation-global', 0));
  IF NEW."stage" <> 'terminal'
     OR NEW."dispatchState" <> 'acknowledged'
     OR NEW."completedAt" IS NULL
     OR NEW."failureCode" IS NOT NULL
     OR NEW."fileCount" <= 0
     OR btrim(NEW."frozenCommitSha") !~ '^[0-9a-f]{40}([0-9a-f]{24})?$'
     OR length(btrim(NEW."frozenCommitSha")) NOT IN (40, 64)
     OR NEW."manifestFingerprint" !~ '^[0-9a-f]{64}$'
     OR NEW."result" IS DISTINCT FROM jsonb_build_object('fileCount', NEW."fileCount", 'decodedTextBytes', NEW."decodedTextBytes") THEN
    RAISE EXCEPTION 'PROJECT_GIT_MANUAL_SUCCESS_INTEGRITY_INVALID' USING ERRCODE = 'check_violation';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM "Project" project_row
    JOIN "ProjectGitRepositoryDelegation" delegation
      ON delegation."id" = NEW."delegationId" AND delegation."projectId" = project_row."id"
    JOIN "GitConnection" connection_row ON connection_row."id" = delegation."gitConnectionId"
    JOIN "ExternalCredential" credential_row ON credential_row."id" = connection_row."credentialId"
    JOIN "AppUser" requester ON requester."id" = NEW."requestedById"
    JOIN "AppUser" owner_user ON owner_user."id" = delegation."connectionOwnerId"
    JOIN "AppUser" confirmer ON confirmer."id" = delegation."projectConfirmedById"
    JOIN "ProjectMembership" requester_membership
      ON requester_membership."id" = NEW."requestedByProjectMembershipId"
    JOIN "ProjectMembership" owner_membership
      ON owner_membership."id" = delegation."ownerProjectMembershipId"
    JOIN "ProjectMembership" confirmer_membership
      ON confirmer_membership."id" = delegation."projectConfirmedProjectMembershipId"
    WHERE project_row."id" = NEW."projectId"
      AND project_row."archivedAt" IS NULL
      AND delegation."status" = 'active'
      AND delegation."manualSyncAllowed" IS TRUE
      AND delegation."expiresAt" > clock_timestamp()
      AND delegation."version" = NEW."delegationVersion"
      AND delegation."delegationFingerprint" = NEW."delegationFingerprint"
      AND delegation."connectionOwnerId" = NEW."connectionOwnerId"
      AND delegation."ownerProjectMembershipId" = NEW."ownerProjectMembershipId"
      AND delegation."ownerMembershipCreatedAt" = NEW."ownerMembershipCreatedAt"
      AND delegation."projectConfirmedById" = NEW."projectConfirmedById"
      AND delegation."projectConfirmedProjectMembershipId" = NEW."projectConfirmedProjectMembershipId"
      AND delegation."projectConfirmedMembershipCreatedAt" = NEW."projectConfirmedMembershipCreatedAt"
      AND delegation."connectionConfigurationVersion" = NEW."connectionConfigurationVersion"
      AND delegation."resolvedAddressFingerprint" = NEW."resolvedAddressFingerprint"
      AND delegation."credentialFingerprint" = NEW."credentialFingerprint"
      AND delegation."repositoryPath" = NEW."repositoryPath"
      AND delegation."trackedRef" = NEW."trackedRef"
      AND delegation."includeRoots" = NEW."includeRoots"
      AND delegation."softExcludePatterns" = NEW."softExcludePatterns"
      AND delegation."role" = NEW."role"
      AND delegation."requiredForProjectSnapshot" = NEW."requiredForProjectSnapshot"
      AND delegation."codeEnabled" = NEW."codeEnabled"
      AND delegation."metadataEnabled" = NEW."metadataEnabled"
      AND delegation."manualSyncAllowed" = NEW."manualSyncAllowed"
      AND delegation."automationAllowed" = NEW."automationAllowed"
      AND connection_row."ownerUserId" = delegation."connectionOwnerId"
      AND connection_row."ownershipState" = 'confirmed'
      AND connection_row."status" = 'verified'
      AND connection_row."configurationVersion" = NEW."connectionConfigurationVersion"
      AND connection_row."resolvedAddressFingerprint" = NEW."resolvedAddressFingerprint"
      AND credential_row."kind" = 'git'
      AND credential_row."secretFingerprint" = NEW."credentialFingerprint"
      AND requester."disabledAt" IS NULL
      AND owner_user."disabledAt" IS NULL
      AND confirmer."disabledAt" IS NULL
      AND requester_membership."projectId" = NEW."projectId"
      AND requester_membership."userId" = NEW."requestedById"
      AND requester_membership."role" IN ('owner', 'editor')
      AND requester_membership."accessState" = 'confirmed'
      AND requester_membership."createdAt" = NEW."requestedByMembershipCreatedAt"
      AND owner_membership."projectId" = NEW."projectId"
      AND owner_membership."userId" = NEW."connectionOwnerId"
      AND owner_membership."role" IN ('owner', 'editor')
      AND owner_membership."accessState" = 'confirmed'
      AND owner_membership."createdAt" = NEW."ownerMembershipCreatedAt"
      AND confirmer_membership."projectId" = NEW."projectId"
      AND confirmer_membership."userId" = NEW."projectConfirmedById"
      AND confirmer_membership."role" = 'owner'
      AND confirmer_membership."accessState" = 'confirmed'
      AND confirmer_membership."createdAt" = NEW."projectConfirmedMembershipCreatedAt"
  ) INTO evidence_valid;
  IF NOT evidence_valid THEN
    RAISE EXCEPTION 'PROJECT_GIT_MANUAL_SUCCESS_EVIDENCE_STALE' USING ERRCODE = 'check_violation';
  END IF;

  WITH ordered_entries AS (
    SELECT entry.*, row_number() OVER (ORDER BY entry."ordinal") - 1 AS expected_ordinal
    FROM "ProjectGitRepositoryManualRunEntry" entry
    WHERE entry."runId" = NEW."id" AND entry."projectId" = NEW."projectId"
  )
  SELECT count(*)::INTEGER,
         COALESCE(sum("contentBytes"), 0)::BIGINT,
         COALESCE(bool_and("ordinal" = expected_ordinal), false)
    INTO entry_count, entry_bytes, entry_ordinals_valid
  FROM ordered_entries;
  IF entry_count <> NEW."fileCount"
     OR entry_count <= 0
     OR entry_bytes <> NEW."decodedTextBytes"
     OR NOT entry_ordinals_valid THEN
    RAISE EXCEPTION 'PROJECT_GIT_MANUAL_SUCCESS_ENTRIES_INVALID' USING ERRCODE = 'check_violation';
  END IF;

  SELECT count(*)::INTEGER,
         COALESCE(bool_and(
           source_row."contentHash" = entry."contentHash"
           AND source_row."contentHash" = encode(digest(convert_to(source_row."contentText", 'UTF8'), 'sha256'), 'hex')
           AND source_row."externalRef" IS NULL
           AND entry."contentBytes" = octet_length(source_row."contentText")
           AND entry."lineCount" = CASE
             WHEN source_row."contentText" = '' THEN 0
             ELSE length(source_row."contentText") - length(replace(source_row."contentText", E'\n', '')) + 1
           END
         ), false)
    INTO source_count, source_values_valid
  FROM "ProjectGitRepositoryManualRunEntry" entry
  JOIN "ProjectSource" source_row
    ON source_row."projectId" = entry."projectId" AND source_row."id" = entry."projectSourceId"
  WHERE entry."runId" = NEW."id" AND entry."projectId" = NEW."projectId";
  IF source_count <> entry_count OR NOT source_values_valid THEN
    RAISE EXCEPTION 'PROJECT_GIT_MANUAL_SUCCESS_SOURCES_INVALID' USING ERRCODE = 'check_violation';
  END IF;

  SELECT "project_git_manual_runtime_manifest"(NEW."id") INTO canonical_manifest;
  IF NEW."manifestFingerprint" IS DISTINCT FROM canonical_manifest THEN
    RAISE EXCEPTION 'PROJECT_GIT_MANUAL_SUCCESS_MANIFEST_INVALID' USING ERRCODE = 'check_violation';
  END IF;

  SELECT count(*)::INTEGER,
         COALESCE(bool_and(
           pointer_row."runId" = NEW."id"
           AND pointer_row."delegationVersion" = NEW."delegationVersion"
           AND pointer_row."delegationFingerprint" = NEW."delegationFingerprint"
           AND pointer_row."frozenCommitSha" = NEW."frozenCommitSha"
           AND pointer_row."manifestFingerprint" = NEW."manifestFingerprint"
           AND pointer_row."publishedAt" IS NOT DISTINCT FROM NEW."completedAt"
         ), false)
    INTO pointer_count, pointer_values_valid
  FROM "ProjectGitRepositoryManualPointer" pointer_row
  WHERE pointer_row."projectId" = NEW."projectId" AND pointer_row."delegationId" = NEW."delegationId";
  IF pointer_count <> 1 OR NOT pointer_values_valid THEN
    RAISE EXCEPTION 'PROJECT_GIT_MANUAL_SUCCESS_POINTER_INVALID' USING ERRCODE = 'check_violation';
  END IF;

  SELECT count(*)::INTEGER,
         COALESCE(bool_and(
           audit_row."statusBefore" = 'running'
           AND audit_row."statusAfter" = 'succeeded'
           AND audit_row."dispatchState" = 'acknowledged'
           AND audit_row."actorId" = NEW."requestedById"
           AND audit_row."commitSha" = NEW."frozenCommitSha"
           AND audit_row."manifestFingerprint" = NEW."manifestFingerprint"
           AND audit_row."transactionId" = txid_current()
         ), false)
    INTO success_audit_count, success_audit_valid
  FROM "ProjectGitRepositoryManualRunAudit" audit_row
  WHERE audit_row."runId" = NEW."id" AND audit_row."action" = 'succeeded';
  IF success_audit_count <> 1 OR NOT success_audit_valid THEN
    RAISE EXCEPTION 'PROJECT_GIT_MANUAL_SUCCESS_AUDIT_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "ProjectGitRepositoryManualRun_success_guard"
AFTER UPDATE OF "status" ON "ProjectGitRepositoryManualRun"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW WHEN (NEW."status" = 'succeeded')
EXECUTE FUNCTION "project_git_manual_runtime_success_guard"();

CREATE OR REPLACE FUNCTION "project_git_manual_runtime_transition_audit_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  transition_audited BOOLEAN;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT EXISTS (
      SELECT 1
      FROM "ProjectGitRepositoryManualRunAudit" audit
      WHERE audit."runId" = NEW."id"
        AND audit."statusBefore" IS NULL
        AND audit."statusAfter" = NEW."status"
        AND audit."action" = 'requested'
    ) INTO transition_audited;
  ELSIF OLD."status" IS DISTINCT FROM NEW."status" THEN
    SELECT EXISTS (
      SELECT 1
      FROM "ProjectGitRepositoryManualRunAudit" audit
      WHERE audit."runId" = NEW."id"
        AND audit."statusBefore" = OLD."status"
        AND audit."statusAfter" = NEW."status"
        AND (
          (OLD."status" = 'queued' AND NEW."status" = 'running' AND audit."action" IN ('admitted', 'dispatched'))
          OR (OLD."status" = 'running' AND NEW."status" = 'succeeded' AND audit."action" = 'succeeded')
          OR (OLD."status" = 'running' AND NEW."status" = 'failed' AND audit."action" = 'failed')
          OR (OLD."status" = 'running' AND NEW."status" = 'unknown' AND audit."action" = 'unknown')
        )
    ) INTO transition_audited;
  ELSE
    RETURN NEW;
  END IF;

  IF NOT transition_audited THEN
    RAISE EXCEPTION 'PROJECT_GIT_MANUAL_RUN_TRANSITION_AUDIT_REQUIRED' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "ProjectGitRepositoryManualRun_transition_audit_guard"
AFTER INSERT OR UPDATE OF "status" ON "ProjectGitRepositoryManualRun"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "project_git_manual_runtime_transition_audit_guard"();
