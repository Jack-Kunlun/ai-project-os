-- Typed, two-party Git repository delegation control plane.
-- This migration does not create or backfill ProjectGitRepositoryLink rows and
-- does not enable any Git runtime.  It only records explicit consent and
-- frozen connection evidence for a later, independently gated consumer.

ALTER TABLE "GitConnection"
  ADD COLUMN "configurationVersion" INTEGER NOT NULL DEFAULT 1,
  ADD CONSTRAINT "GitConnection_configuration_version_check" CHECK ("configurationVersion" > 0);

CREATE TYPE "ProjectGitRepositoryDelegationStatus" AS ENUM (
  'draft',
  'owner_confirmed',
  'active',
  'rejected',
  'revoked',
  'expired'
);

CREATE TYPE "ProjectGitRepositoryDelegationActorKind" AS ENUM (
  'user',
  'system_expiry'
);

CREATE TYPE "ProjectGitRepositoryDelegationAuditAction" AS ENUM (
  'proposed',
  'owner_confirmed',
  'activated',
  'rejected',
  'revoked',
  'expired'
);

CREATE TABLE "ProjectGitRepositoryDelegation" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "gitConnectionId" UUID NOT NULL,
  "connectionOwnerId" UUID NOT NULL,
  "repositoryPath" VARCHAR(768) NOT NULL,
  "trackedRef" VARCHAR(255) NOT NULL,
  "includeRoots" JSONB NOT NULL,
  "softExcludePatterns" JSONB NOT NULL,
  "role" "ProjectRepositoryRole" NOT NULL,
  "requiredForProjectSnapshot" BOOLEAN NOT NULL DEFAULT true,
  "codeEnabled" BOOLEAN NOT NULL DEFAULT true,
  "metadataEnabled" BOOLEAN NOT NULL DEFAULT true,
  "manualSyncAllowed" BOOLEAN NOT NULL DEFAULT true,
  "automationAllowed" BOOLEAN NOT NULL DEFAULT false,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "connectionConfigurationVersion" INTEGER NOT NULL,
  "resolvedAddressFingerprint" CHAR(64) NOT NULL,
  "credentialFingerprint" CHAR(64) NOT NULL,
  "delegationFingerprint" CHAR(64) NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "status" "ProjectGitRepositoryDelegationStatus" NOT NULL DEFAULT 'draft',
  "ownerProjectMembershipId" UUID NOT NULL,
  "ownerMembershipCreatedAt" TIMESTAMP(3) NOT NULL,
  "projectConfirmedProjectMembershipId" UUID,
  "projectConfirmedMembershipCreatedAt" TIMESTAMP(3),
  "proposedById" UUID NOT NULL,
  "proposedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ownerConfirmedById" UUID,
  "ownerConfirmedAt" TIMESTAMP(3),
  "projectConfirmedById" UUID,
  "projectConfirmedAt" TIMESTAMP(3),
  "activatedAt" TIMESTAMP(3),
  "rejectedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "expiredAt" TIMESTAMP(3),
  "terminalActorKind" "ProjectGitRepositoryDelegationActorKind",
  "terminalActorId" UUID,
  "terminalActorProjectMembershipId" UUID,
  "terminalActorMembershipCreatedAt" TIMESTAMP(3),
  "terminalReason" VARCHAR(500),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProjectGitRepositoryDelegation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PGRD_version_check" CHECK ("version" > 0),
  CONSTRAINT "PGRD_connection_version_check" CHECK ("connectionConfigurationVersion" > 0),
  CONSTRAINT "PGRD_fingerprint_check" CHECK (
    "resolvedAddressFingerprint" ~ '^[0-9a-f]{64}$'
    AND "credentialFingerprint" ~ '^[0-9a-f]{64}$'
    AND "delegationFingerprint" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "PGRD_scope_json_check" CHECK (
    jsonb_typeof("includeRoots") = 'array'
    AND jsonb_typeof("softExcludePatterns") = 'array'
  ),
  CONSTRAINT "PGRD_expiry_check" CHECK ("expiresAt" > "proposedAt")
);

CREATE TABLE "ProjectGitRepositoryDelegationAudit" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "gitConnectionId" UUID NOT NULL,
  "delegationId" UUID NOT NULL,
  "connectionOwnerId" UUID NOT NULL,
  "action" "ProjectGitRepositoryDelegationAuditAction" NOT NULL,
  "delegationVersion" INTEGER NOT NULL,
  "statusBefore" "ProjectGitRepositoryDelegationStatus",
  "statusAfter" "ProjectGitRepositoryDelegationStatus" NOT NULL,
  "actorKind" "ProjectGitRepositoryDelegationActorKind" NOT NULL DEFAULT 'user',
  "actorId" UUID,
  "actorProjectMembershipId" UUID,
  "actorMembershipCreatedAt" TIMESTAMP(3),
  "terminalActorKind" "ProjectGitRepositoryDelegationActorKind",
  "terminalActorId" UUID,
  "terminalActorProjectMembershipId" UUID,
  "terminalActorMembershipCreatedAt" TIMESTAMP(3),
  "terminalReason" VARCHAR(500),
  "ownerProjectMembershipId" UUID NOT NULL,
  "ownerMembershipCreatedAt" TIMESTAMP(3) NOT NULL,
  "projectConfirmedProjectMembershipId" UUID,
  "projectConfirmedMembershipCreatedAt" TIMESTAMP(3),
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
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "connectionConfigurationVersion" INTEGER NOT NULL,
  "resolvedAddressFingerprint" CHAR(64) NOT NULL,
  "credentialFingerprint" CHAR(64) NOT NULL,
  "delegationFingerprint" CHAR(64) NOT NULL,
  "reason" VARCHAR(500) NOT NULL,
  "transitionAt" TIMESTAMP(3) NOT NULL,
  "transactionId" BIGINT NOT NULL DEFAULT txid_current(),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProjectGitRepositoryDelegationAudit_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PGRD_A_version_check" CHECK ("delegationVersion" > 0),
  CONSTRAINT "PGRD_A_actor_kind_check" CHECK (
    ("actorKind" = 'user' AND "actorId" IS NOT NULL)
    OR ("actorKind" = 'system_expiry' AND "action" = 'expired' AND "actorId" IS NULL)
  ),
  CONSTRAINT "PGRD_A_fingerprint_check" CHECK (
    "resolvedAddressFingerprint" ~ '^[0-9a-f]{64}$'
    AND "credentialFingerprint" ~ '^[0-9a-f]{64}$'
    AND "delegationFingerprint" ~ '^[0-9a-f]{64}$'
  )
);

CREATE UNIQUE INDEX "PGRD_live_project_connection_repository_key"
  ON "ProjectGitRepositoryDelegation"("projectId", "gitConnectionId", "repositoryPath")
  WHERE "status" IN ('draft', 'owner_confirmed', 'active');
CREATE INDEX "PGRD_project_status_expiry_idx"
  ON "ProjectGitRepositoryDelegation"("projectId", "status", "expiresAt");
CREATE INDEX "PGRD_connection_status_idx"
  ON "ProjectGitRepositoryDelegation"("gitConnectionId", "status");
CREATE INDEX "PGRD_owner_status_idx"
  ON "ProjectGitRepositoryDelegation"("connectionOwnerId", "status");
CREATE UNIQUE INDEX "PGRD_A_delegation_version_unique"
  ON "ProjectGitRepositoryDelegationAudit"("delegationId", "delegationVersion");
CREATE INDEX "PGRD_A_project_created_idx"
  ON "ProjectGitRepositoryDelegationAudit"("projectId", "createdAt");
CREATE INDEX "PGRD_A_delegation_created_idx"
  ON "ProjectGitRepositoryDelegationAudit"("delegationId", "createdAt");
CREATE INDEX "PGRD_A_transaction_created_idx"
  ON "ProjectGitRepositoryDelegationAudit"("transactionId", "createdAt");

ALTER TABLE "ProjectGitRepositoryDelegation"
  ADD CONSTRAINT "PGRD_project_fkey"
    FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "PGRD_connection_fkey"
    FOREIGN KEY ("gitConnectionId") REFERENCES "GitConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "PGRD_connection_owner_fkey"
    FOREIGN KEY ("connectionOwnerId") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PGRD_owner_membership_fkey"
    FOREIGN KEY ("ownerProjectMembershipId") REFERENCES "ProjectMembership"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PGRD_project_confirmed_membership_fkey"
    FOREIGN KEY ("projectConfirmedProjectMembershipId") REFERENCES "ProjectMembership"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PGRD_proposer_fkey"
    FOREIGN KEY ("proposedById") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PGRD_owner_confirmer_fkey"
    FOREIGN KEY ("ownerConfirmedById") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PGRD_project_confirmer_fkey"
    FOREIGN KEY ("projectConfirmedById") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PGRD_terminal_actor_fkey"
    FOREIGN KEY ("terminalActorId") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION "git_connection_configuration_version_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  changed boolean;
BEGIN
  changed := OLD."providerKind" IS DISTINCT FROM NEW."providerKind"
    OR OLD."transport" IS DISTINCT FROM NEW."transport"
    OR OLD."baseUrl" IS DISTINCT FROM NEW."baseUrl"
    OR OLD."authKind" IS DISTINCT FROM NEW."authKind"
    OR OLD."username" IS DISTINCT FROM NEW."username"
    OR OLD."credentialId" IS DISTINCT FROM NEW."credentialId"
    OR OLD."allowPrivateNetwork" IS DISTINCT FROM NEW."allowPrivateNetwork"
    OR OLD."tlsCaCertificate" IS DISTINCT FROM NEW."tlsCaCertificate"
    OR OLD."sshKnownHost" IS DISTINCT FROM NEW."sshKnownHost"
    OR OLD."resolvedAddressFingerprint" IS DISTINCT FROM NEW."resolvedAddressFingerprint"
    OR OLD."status" IS DISTINCT FROM NEW."status"
    OR OLD."disabledAt" IS DISTINCT FROM NEW."disabledAt";
  IF changed THEN
    IF NEW."configurationVersion" = OLD."configurationVersion" THEN
      NEW."configurationVersion" := OLD."configurationVersion" + 1;
    ELSIF NEW."configurationVersion" <> OLD."configurationVersion" + 1 THEN
      RAISE EXCEPTION 'GIT_CONNECTION_CONFIGURATION_VERSION_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."configurationVersion" IS DISTINCT FROM OLD."configurationVersion" THEN
    RAISE EXCEPTION 'GIT_CONNECTION_CONFIGURATION_VERSION_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "GitConnection_configuration_version_guard"
BEFORE UPDATE ON "GitConnection"
FOR EACH ROW EXECUTE FUNCTION "git_connection_configuration_version_guard"();

CREATE OR REPLACE FUNCTION "project_git_repository_delegation_global_lock"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtextextended('ai-project-git-repository-delegation-global', 0)) THEN
    RAISE EXCEPTION 'PROJECT_GIT_REPOSITORY_DELEGATION_LOCK_BUSY' USING ERRCODE = 'serialization_failure';
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER "PGRD_global_lock"
BEFORE INSERT OR UPDATE OR DELETE ON "ProjectGitRepositoryDelegation"
FOR EACH STATEMENT EXECUTE FUNCTION "project_git_repository_delegation_global_lock"();

CREATE OR REPLACE FUNCTION "project_git_repository_delegation_shape_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW."createdAt" := clock_timestamp();
    NEW."updatedAt" := NEW."createdAt";
    NEW."proposedAt" := NEW."createdAt";
    IF NEW."status" <> 'draft' OR NEW."version" <> 1 THEN
      RAISE EXCEPTION 'PROJECT_GIT_REPOSITORY_DELEGATION_STATE_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."expiresAt" < NEW."proposedAt" + interval '10 minutes'
       OR NEW."expiresAt" > NEW."proposedAt" + interval '30 days' THEN
      RAISE EXCEPTION 'PROJECT_GIT_REPOSITORY_DELEGATION_EXPIRY_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    NEW."updatedAt" := clock_timestamp();
    IF OLD."id" IS DISTINCT FROM NEW."id"
       OR OLD."projectId" IS DISTINCT FROM NEW."projectId"
       OR OLD."gitConnectionId" IS DISTINCT FROM NEW."gitConnectionId"
       OR OLD."connectionOwnerId" IS DISTINCT FROM NEW."connectionOwnerId"
       OR OLD."repositoryPath" IS DISTINCT FROM NEW."repositoryPath"
       OR OLD."trackedRef" IS DISTINCT FROM NEW."trackedRef"
       OR OLD."includeRoots" IS DISTINCT FROM NEW."includeRoots"
       OR OLD."softExcludePatterns" IS DISTINCT FROM NEW."softExcludePatterns"
       OR OLD."role" IS DISTINCT FROM NEW."role"
       OR OLD."requiredForProjectSnapshot" IS DISTINCT FROM NEW."requiredForProjectSnapshot"
       OR OLD."codeEnabled" IS DISTINCT FROM NEW."codeEnabled"
       OR OLD."metadataEnabled" IS DISTINCT FROM NEW."metadataEnabled"
       OR OLD."manualSyncAllowed" IS DISTINCT FROM NEW."manualSyncAllowed"
       OR OLD."automationAllowed" IS DISTINCT FROM NEW."automationAllowed"
       OR OLD."expiresAt" IS DISTINCT FROM NEW."expiresAt"
       OR OLD."connectionConfigurationVersion" IS DISTINCT FROM NEW."connectionConfigurationVersion"
       OR OLD."resolvedAddressFingerprint" IS DISTINCT FROM NEW."resolvedAddressFingerprint"
       OR OLD."credentialFingerprint" IS DISTINCT FROM NEW."credentialFingerprint"
       OR OLD."delegationFingerprint" IS DISTINCT FROM NEW."delegationFingerprint"
       OR OLD."ownerProjectMembershipId" IS DISTINCT FROM NEW."ownerProjectMembershipId"
       OR OLD."ownerMembershipCreatedAt" IS DISTINCT FROM NEW."ownerMembershipCreatedAt"
       OR OLD."proposedById" IS DISTINCT FROM NEW."proposedById"
       OR OLD."proposedAt" IS DISTINCT FROM NEW."proposedAt"
    THEN
      RAISE EXCEPTION 'PROJECT_GIT_REPOSITORY_DELEGATION_IMMUTABLE' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."version" <> OLD."version" + 1 THEN
      RAISE EXCEPTION 'PROJECT_GIT_REPOSITORY_DELEGATION_VERSION_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT (
      (OLD."status" = 'draft' AND NEW."status" IN ('owner_confirmed', 'rejected', 'expired'))
      OR (OLD."status" = 'owner_confirmed' AND NEW."status" IN ('active', 'rejected', 'expired'))
      OR (OLD."status" = 'active' AND NEW."status" IN ('revoked', 'expired'))
    ) THEN
      RAISE EXCEPTION 'PROJECT_GIT_REPOSITORY_DELEGATION_STATE_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."ownerConfirmedById" IS NOT NULL AND OLD."ownerConfirmedById" IS DISTINCT FROM NEW."ownerConfirmedById"
       OR OLD."ownerConfirmedAt" IS NOT NULL AND OLD."ownerConfirmedAt" IS DISTINCT FROM NEW."ownerConfirmedAt"
       OR OLD."projectConfirmedById" IS NOT NULL AND OLD."projectConfirmedById" IS DISTINCT FROM NEW."projectConfirmedById"
       OR OLD."projectConfirmedAt" IS NOT NULL AND OLD."projectConfirmedAt" IS DISTINCT FROM NEW."projectConfirmedAt"
       OR OLD."projectConfirmedProjectMembershipId" IS NOT NULL AND OLD."projectConfirmedProjectMembershipId" IS DISTINCT FROM NEW."projectConfirmedProjectMembershipId"
       OR OLD."projectConfirmedMembershipCreatedAt" IS NOT NULL AND OLD."projectConfirmedMembershipCreatedAt" IS DISTINCT FROM NEW."projectConfirmedMembershipCreatedAt"
       OR OLD."activatedAt" IS NOT NULL AND OLD."activatedAt" IS DISTINCT FROM NEW."activatedAt"
       OR OLD."rejectedAt" IS NOT NULL AND OLD."rejectedAt" IS DISTINCT FROM NEW."rejectedAt"
       OR OLD."revokedAt" IS NOT NULL AND OLD."revokedAt" IS DISTINCT FROM NEW."revokedAt"
       OR OLD."expiredAt" IS NOT NULL AND OLD."expiredAt" IS DISTINCT FROM NEW."expiredAt"
       OR OLD."terminalActorKind" IS NOT NULL AND OLD."terminalActorKind" IS DISTINCT FROM NEW."terminalActorKind"
       OR OLD."terminalActorId" IS NOT NULL AND OLD."terminalActorId" IS DISTINCT FROM NEW."terminalActorId"
       OR OLD."terminalActorProjectMembershipId" IS NOT NULL AND OLD."terminalActorProjectMembershipId" IS DISTINCT FROM NEW."terminalActorProjectMembershipId"
       OR OLD."terminalActorMembershipCreatedAt" IS NOT NULL AND OLD."terminalActorMembershipCreatedAt" IS DISTINCT FROM NEW."terminalActorMembershipCreatedAt"
       OR OLD."terminalReason" IS NOT NULL AND OLD."terminalReason" IS DISTINCT FROM NEW."terminalReason"
    THEN
      RAISE EXCEPTION 'PROJECT_GIT_REPOSITORY_DELEGATION_CONFIRMATION_IMMUTABLE' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" = 'owner_confirmed' THEN
      NEW."ownerConfirmedAt" := clock_timestamp();
    ELSIF NEW."status" = 'active' THEN
      NEW."projectConfirmedAt" := clock_timestamp();
      NEW."activatedAt" := NEW."projectConfirmedAt";
    ELSIF NEW."status" = 'rejected' AND OLD."status" IN ('draft', 'owner_confirmed') THEN
      NEW."rejectedAt" := clock_timestamp();
      NEW."terminalActorKind" := 'user';
    ELSIF NEW."status" = 'revoked' AND OLD."status" = 'active' THEN
      NEW."revokedAt" := clock_timestamp();
      NEW."terminalActorKind" := 'user';
    ELSIF NEW."status" = 'expired' THEN
      NEW."expiredAt" := clock_timestamp();
      NEW."terminalActorKind" := 'system_expiry';
      NEW."terminalActorId" := NULL;
      NEW."terminalActorProjectMembershipId" := NULL;
      NEW."terminalActorMembershipCreatedAt" := NULL;
      NEW."terminalReason" := 'system_expiry';
    END IF;
  END IF;

  IF NEW."proposedById" IS DISTINCT FROM NEW."connectionOwnerId" THEN
    RAISE EXCEPTION 'PROJECT_GIT_REPOSITORY_DELEGATION_PROPOSER_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'draft' THEN
    IF NEW."ownerConfirmedById" IS NOT NULL OR NEW."ownerConfirmedAt" IS NOT NULL
       OR NEW."projectConfirmedById" IS NOT NULL OR NEW."projectConfirmedAt" IS NOT NULL
       OR NEW."projectConfirmedProjectMembershipId" IS NOT NULL OR NEW."projectConfirmedMembershipCreatedAt" IS NOT NULL
       OR NEW."activatedAt" IS NOT NULL OR NEW."rejectedAt" IS NOT NULL OR NEW."revokedAt" IS NOT NULL OR NEW."expiredAt" IS NOT NULL
       OR NEW."terminalActorKind" IS NOT NULL OR NEW."terminalActorId" IS NOT NULL OR NEW."terminalActorProjectMembershipId" IS NOT NULL
       OR NEW."terminalActorMembershipCreatedAt" IS NOT NULL OR NEW."terminalReason" IS NOT NULL THEN
      RAISE EXCEPTION 'PROJECT_GIT_REPOSITORY_DELEGATION_STATE_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."status" = 'owner_confirmed' THEN
    IF NEW."ownerConfirmedById" IS DISTINCT FROM NEW."connectionOwnerId" OR NEW."ownerConfirmedAt" IS NULL
       OR NEW."projectConfirmedById" IS NOT NULL OR NEW."projectConfirmedAt" IS NOT NULL
       OR NEW."projectConfirmedProjectMembershipId" IS NOT NULL OR NEW."projectConfirmedMembershipCreatedAt" IS NOT NULL
       OR NEW."activatedAt" IS NOT NULL OR NEW."rejectedAt" IS NOT NULL OR NEW."revokedAt" IS NOT NULL OR NEW."expiredAt" IS NOT NULL
       OR NEW."terminalActorKind" IS NOT NULL OR NEW."terminalActorId" IS NOT NULL OR NEW."terminalActorProjectMembershipId" IS NOT NULL
       OR NEW."terminalActorMembershipCreatedAt" IS NOT NULL OR NEW."terminalReason" IS NOT NULL THEN
      RAISE EXCEPTION 'PROJECT_GIT_REPOSITORY_DELEGATION_STATE_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."status" = 'active' THEN
    IF NEW."ownerConfirmedById" IS DISTINCT FROM NEW."connectionOwnerId" OR NEW."ownerConfirmedAt" IS NULL
       OR NEW."projectConfirmedById" IS NULL OR NEW."projectConfirmedAt" IS NULL
       OR NEW."projectConfirmedProjectMembershipId" IS NULL OR NEW."projectConfirmedMembershipCreatedAt" IS NULL
       OR NEW."activatedAt" IS NULL OR NEW."rejectedAt" IS NOT NULL OR NEW."revokedAt" IS NOT NULL OR NEW."expiredAt" IS NOT NULL
       OR NEW."terminalActorKind" IS NOT NULL OR NEW."terminalActorId" IS NOT NULL OR NEW."terminalActorProjectMembershipId" IS NOT NULL
       OR NEW."terminalActorMembershipCreatedAt" IS NOT NULL OR NEW."terminalReason" IS NOT NULL THEN
      RAISE EXCEPTION 'PROJECT_GIT_REPOSITORY_DELEGATION_STATE_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."status" IN ('rejected', 'revoked') THEN
    IF NEW."terminalActorKind" IS DISTINCT FROM 'user' OR NEW."terminalActorId" IS NULL OR NEW."terminalReason" IS NULL
       OR length(btrim(NEW."terminalReason")) = 0 OR NEW."rejectedAt" IS NULL AND NEW."status" = 'rejected'
       OR NEW."revokedAt" IS NULL AND NEW."status" = 'revoked'
       OR (NEW."status" = 'rejected' AND OLD."status" = 'draft' AND (
         NEW."ownerConfirmedById" IS NOT NULL OR NEW."ownerConfirmedAt" IS NOT NULL
         OR NEW."projectConfirmedById" IS NOT NULL OR NEW."projectConfirmedAt" IS NOT NULL
         OR NEW."projectConfirmedProjectMembershipId" IS NOT NULL OR NEW."projectConfirmedMembershipCreatedAt" IS NOT NULL
         OR NEW."activatedAt" IS NOT NULL
       ))
       OR (NEW."status" = 'rejected' AND OLD."status" = 'owner_confirmed' AND (
         NEW."ownerConfirmedById" IS NULL OR NEW."ownerConfirmedAt" IS NULL
         OR NEW."projectConfirmedById" IS NOT NULL OR NEW."projectConfirmedAt" IS NOT NULL
         OR NEW."projectConfirmedProjectMembershipId" IS NOT NULL OR NEW."projectConfirmedMembershipCreatedAt" IS NOT NULL
         OR NEW."activatedAt" IS NOT NULL
       ))
       OR (NEW."status" = 'revoked' AND (
         NEW."ownerConfirmedById" IS NULL OR NEW."ownerConfirmedAt" IS NULL
         OR NEW."projectConfirmedById" IS NULL OR NEW."projectConfirmedAt" IS NULL
         OR NEW."projectConfirmedProjectMembershipId" IS NULL OR NEW."projectConfirmedMembershipCreatedAt" IS NULL
         OR NEW."activatedAt" IS NULL
       )) THEN
      RAISE EXCEPTION 'PROJECT_GIT_REPOSITORY_DELEGATION_STATE_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM "AppUser" actor
      WHERE actor."id" = NEW."terminalActorId"
        AND actor."disabledAt" IS NULL
        AND (
          (
            actor."id" = NEW."connectionOwnerId"
            AND NEW."terminalActorProjectMembershipId" = NEW."ownerProjectMembershipId"
            AND NEW."terminalActorMembershipCreatedAt" = NEW."ownerMembershipCreatedAt"
            AND EXISTS (
              SELECT 1
              FROM "ProjectMembership" membership
              WHERE membership."id" = NEW."ownerProjectMembershipId"
                AND membership."projectId" = NEW."projectId"
                AND membership."userId" = NEW."connectionOwnerId"
                AND membership."role" IN ('owner', 'editor')
                AND membership."createdAt" = NEW."ownerMembershipCreatedAt"
            )
          )
          OR EXISTS (
            SELECT 1
            FROM "ProjectMembership" membership
            WHERE membership."id" = NEW."terminalActorProjectMembershipId"
              AND membership."projectId" = NEW."projectId"
              AND membership."userId" = NEW."terminalActorId"
              AND membership."role" = 'owner'
              AND membership."accessState" = 'confirmed'
              AND membership."createdAt" = NEW."terminalActorMembershipCreatedAt"
          )
        )
    ) THEN
      RAISE EXCEPTION 'PROJECT_GIT_REPOSITORY_DELEGATION_AUDIT_ACTOR_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."status" = 'expired' THEN
    IF NEW."terminalActorKind" IS DISTINCT FROM 'system_expiry' OR NEW."terminalReason" IS DISTINCT FROM 'system_expiry'
       OR NEW."expiredAt" IS NULL OR clock_timestamp() < NEW."expiresAt"
       OR (OLD."status" = 'draft' AND (
         NEW."ownerConfirmedById" IS NOT NULL OR NEW."ownerConfirmedAt" IS NOT NULL
         OR NEW."projectConfirmedById" IS NOT NULL OR NEW."projectConfirmedAt" IS NOT NULL
         OR NEW."projectConfirmedProjectMembershipId" IS NOT NULL OR NEW."projectConfirmedMembershipCreatedAt" IS NOT NULL
         OR NEW."activatedAt" IS NOT NULL
       ))
       OR (OLD."status" = 'owner_confirmed' AND (
         NEW."ownerConfirmedById" IS NULL OR NEW."ownerConfirmedAt" IS NULL
         OR NEW."projectConfirmedById" IS NOT NULL OR NEW."projectConfirmedAt" IS NOT NULL
         OR NEW."projectConfirmedProjectMembershipId" IS NOT NULL OR NEW."projectConfirmedMembershipCreatedAt" IS NOT NULL
         OR NEW."activatedAt" IS NOT NULL
       ))
       OR (OLD."status" = 'active' AND (
         NEW."ownerConfirmedById" IS NULL OR NEW."ownerConfirmedAt" IS NULL
         OR NEW."projectConfirmedById" IS NULL OR NEW."projectConfirmedAt" IS NULL
         OR NEW."projectConfirmedProjectMembershipId" IS NULL OR NEW."projectConfirmedMembershipCreatedAt" IS NULL
         OR NEW."activatedAt" IS NULL
       )) THEN
      RAISE EXCEPTION 'PROJECT_GIT_REPOSITORY_DELEGATION_STATE_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "PGRD_shape_guard"
BEFORE INSERT OR UPDATE ON "ProjectGitRepositoryDelegation"
FOR EACH ROW EXECUTE FUNCTION "project_git_repository_delegation_shape_guard"();

CREATE OR REPLACE FUNCTION "project_git_repository_delegation_delete_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF pg_trigger_depth() <= 1 THEN
    RAISE EXCEPTION 'PROJECT_GIT_REPOSITORY_DELEGATION_DELETE_FORBIDDEN' USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER "PGRD_delete_guard"
BEFORE DELETE ON "ProjectGitRepositoryDelegation"
FOR EACH ROW EXECUTE FUNCTION "project_git_repository_delegation_delete_guard"();

CREATE OR REPLACE FUNCTION "project_git_repository_delegation_live_integrity_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  connection_valid boolean;
  owner_valid boolean;
  project_owner_valid boolean;
BEGIN
  IF NEW."status" NOT IN ('draft', 'owner_confirmed', 'active') THEN RETURN NEW; END IF;
  IF NEW."expiresAt" <= clock_timestamp() THEN
    RAISE EXCEPTION 'PROJECT_GIT_REPOSITORY_DELEGATION_LIVE_EXPIRED' USING ERRCODE = 'check_violation';
  END IF;
  SELECT EXISTS (
    SELECT 1
    FROM "GitConnection" connection
    JOIN "ExternalCredential" credential ON credential."id" = connection."credentialId"
    JOIN "Project" project_row ON project_row."id" = NEW."projectId"
    WHERE connection."id" = NEW."gitConnectionId"
      AND connection."ownerUserId" = NEW."connectionOwnerId"
      AND connection."ownershipState" = 'confirmed'
      AND connection."status" = 'verified'
      AND connection."configurationVersion" = NEW."connectionConfigurationVersion"
      AND connection."resolvedAddressFingerprint" = NEW."resolvedAddressFingerprint"
      AND credential."kind" = 'git'
      AND credential."secretFingerprint" = NEW."credentialFingerprint"
      AND project_row."archivedAt" IS NULL
  ) INTO connection_valid;
  IF NOT connection_valid THEN
    IF NEW."status" = 'active' THEN
      RAISE EXCEPTION 'PROJECT_GIT_REPOSITORY_DELEGATION_ACTIVE_CONNECTION_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    RAISE EXCEPTION 'PROJECT_GIT_REPOSITORY_DELEGATION_LIVE_CONNECTION_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  SELECT EXISTS (
    SELECT 1
    FROM "AppUser" user_row
    JOIN "ProjectMembership" membership ON membership."id" = NEW."ownerProjectMembershipId"
    WHERE user_row."id" = NEW."connectionOwnerId"
      AND user_row."disabledAt" IS NULL
      AND membership."projectId" = NEW."projectId"
      AND membership."userId" = NEW."connectionOwnerId"
      AND membership."role" IN ('owner', 'editor')
      AND membership."accessState" = 'confirmed'
      AND membership."createdAt" = NEW."ownerMembershipCreatedAt"
  ) INTO owner_valid;
  IF NOT owner_valid THEN
    IF NEW."status" = 'active' THEN
      RAISE EXCEPTION 'PROJECT_GIT_REPOSITORY_DELEGATION_ACTIVE_OWNER_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    RAISE EXCEPTION 'PROJECT_GIT_REPOSITORY_DELEGATION_LIVE_OWNER_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'active' THEN
    SELECT EXISTS (
      SELECT 1
      FROM "AppUser" user_row
      JOIN "ProjectMembership" membership ON membership."id" = NEW."projectConfirmedProjectMembershipId"
      WHERE user_row."id" = NEW."projectConfirmedById"
        AND user_row."disabledAt" IS NULL
        AND membership."projectId" = NEW."projectId"
        AND membership."userId" = NEW."projectConfirmedById"
        AND membership."role" = 'owner'
        AND membership."accessState" = 'confirmed'
        AND membership."createdAt" = NEW."projectConfirmedMembershipCreatedAt"
    ) INTO project_owner_valid;
    IF NOT project_owner_valid THEN
      RAISE EXCEPTION 'PROJECT_GIT_REPOSITORY_DELEGATION_ACTIVE_PROJECT_OWNER_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "PGRD_live_integrity_guard"
AFTER INSERT OR UPDATE ON "ProjectGitRepositoryDelegation"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "project_git_repository_delegation_live_integrity_guard"();

CREATE OR REPLACE FUNCTION "project_git_repository_delegation_validate_evidence"(delegation_id UUID)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  row_data RECORD;
  previous_status "ProjectGitRepositoryDelegationStatus";
  expected_action "ProjectGitRepositoryDelegationAuditAction";
  expected_actor UUID;
  expected_actor_kind "ProjectGitRepositoryDelegationActorKind";
  expected_actor_membership UUID;
  expected_actor_membership_created_at TIMESTAMP(3);
  expected_transition_at TIMESTAMP(3);
  audit_count INTEGER;
  audit_matches boolean;
BEGIN
  SELECT * INTO row_data FROM "ProjectGitRepositoryDelegation" WHERE "id" = delegation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'PROJECT_GIT_REPOSITORY_DELEGATION_AUDIT_ENTITY_INVALID' USING ERRCODE = 'check_violation'; END IF;

  SELECT count(*) INTO audit_count
  FROM "ProjectGitRepositoryDelegationAudit" audit
  WHERE audit."delegationId" = row_data."id"
    AND audit."delegationVersion" = row_data."version";
  IF audit_count = 0 THEN
    RAISE EXCEPTION 'PROJECT_GIT_REPOSITORY_DELEGATION_AUDIT_REQUIRED' USING ERRCODE = 'check_violation';
  ELSIF audit_count <> 1 THEN
    RAISE EXCEPTION 'PROJECT_GIT_REPOSITORY_DELEGATION_AUDIT_INVALID' USING ERRCODE = 'check_violation';
  END IF;

  IF row_data."version" = 1 THEN
    previous_status := NULL;
    expected_action := 'proposed'::"ProjectGitRepositoryDelegationAuditAction";
  ELSE
    SELECT audit."statusAfter" INTO previous_status
    FROM "ProjectGitRepositoryDelegationAudit" audit
    WHERE audit."delegationId" = row_data."id"
      AND audit."delegationVersion" = row_data."version" - 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'PROJECT_GIT_REPOSITORY_DELEGATION_AUDIT_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    expected_action := CASE row_data."status"
      WHEN 'owner_confirmed' THEN 'owner_confirmed'::"ProjectGitRepositoryDelegationAuditAction"
      WHEN 'active' THEN 'activated'::"ProjectGitRepositoryDelegationAuditAction"
      WHEN 'rejected' THEN 'rejected'::"ProjectGitRepositoryDelegationAuditAction"
      WHEN 'revoked' THEN 'revoked'::"ProjectGitRepositoryDelegationAuditAction"
      WHEN 'expired' THEN 'expired'::"ProjectGitRepositoryDelegationAuditAction"
      ELSE NULL
    END;
  END IF;

  expected_actor := CASE expected_action
    WHEN 'proposed' THEN row_data."proposedById"
    WHEN 'owner_confirmed' THEN row_data."connectionOwnerId"
    WHEN 'activated' THEN row_data."projectConfirmedById"
    ELSE row_data."terminalActorId"
  END;
  expected_actor_kind := CASE expected_action
    WHEN 'expired' THEN 'system_expiry'::"ProjectGitRepositoryDelegationActorKind"
    ELSE 'user'::"ProjectGitRepositoryDelegationActorKind"
  END;
  expected_actor_membership := CASE expected_action
    WHEN 'proposed' THEN row_data."ownerProjectMembershipId"
    WHEN 'owner_confirmed' THEN row_data."ownerProjectMembershipId"
    WHEN 'activated' THEN row_data."projectConfirmedProjectMembershipId"
    ELSE row_data."terminalActorProjectMembershipId"
  END;
  expected_actor_membership_created_at := CASE expected_action
    WHEN 'proposed' THEN row_data."ownerMembershipCreatedAt"
    WHEN 'owner_confirmed' THEN row_data."ownerMembershipCreatedAt"
    WHEN 'activated' THEN row_data."projectConfirmedMembershipCreatedAt"
    ELSE row_data."terminalActorMembershipCreatedAt"
  END;
  expected_transition_at := CASE expected_action
    WHEN 'proposed' THEN row_data."proposedAt"
    WHEN 'owner_confirmed' THEN row_data."ownerConfirmedAt"
    WHEN 'activated' THEN row_data."activatedAt"
    WHEN 'rejected' THEN row_data."rejectedAt"
    WHEN 'revoked' THEN row_data."revokedAt"
    WHEN 'expired' THEN row_data."expiredAt"
  END;

  SELECT EXISTS (
    SELECT 1
    FROM "ProjectGitRepositoryDelegationAudit" audit
    WHERE audit."delegationId" = row_data."id"
      AND audit."action" = expected_action
      AND audit."delegationVersion" = row_data."version"
      AND audit."statusBefore" IS NOT DISTINCT FROM previous_status
      AND audit."statusAfter" = row_data."status"
      AND audit."projectId" = row_data."projectId"
      AND audit."gitConnectionId" = row_data."gitConnectionId"
      AND audit."connectionOwnerId" = row_data."connectionOwnerId"
      AND audit."repositoryPath" = row_data."repositoryPath"
      AND audit."trackedRef" = row_data."trackedRef"
      AND audit."includeRoots" = row_data."includeRoots"
      AND audit."softExcludePatterns" = row_data."softExcludePatterns"
      AND audit."role" = row_data."role"
      AND audit."requiredForProjectSnapshot" = row_data."requiredForProjectSnapshot"
      AND audit."codeEnabled" = row_data."codeEnabled"
      AND audit."metadataEnabled" = row_data."metadataEnabled"
      AND audit."manualSyncAllowed" = row_data."manualSyncAllowed"
      AND audit."automationAllowed" = row_data."automationAllowed"
      AND audit."expiresAt" = row_data."expiresAt"
      AND audit."ownerProjectMembershipId" = row_data."ownerProjectMembershipId"
      AND audit."ownerMembershipCreatedAt" = row_data."ownerMembershipCreatedAt"
      AND audit."projectConfirmedProjectMembershipId" IS NOT DISTINCT FROM row_data."projectConfirmedProjectMembershipId"
      AND audit."projectConfirmedMembershipCreatedAt" IS NOT DISTINCT FROM row_data."projectConfirmedMembershipCreatedAt"
      AND audit."connectionConfigurationVersion" = row_data."connectionConfigurationVersion"
      AND audit."resolvedAddressFingerprint" = row_data."resolvedAddressFingerprint"
      AND audit."credentialFingerprint" = row_data."credentialFingerprint"
      AND audit."delegationFingerprint" = row_data."delegationFingerprint"
      AND audit."terminalActorKind" IS NOT DISTINCT FROM row_data."terminalActorKind"
      AND audit."terminalActorId" IS NOT DISTINCT FROM row_data."terminalActorId"
      AND audit."terminalActorProjectMembershipId" IS NOT DISTINCT FROM row_data."terminalActorProjectMembershipId"
      AND audit."terminalActorMembershipCreatedAt" IS NOT DISTINCT FROM row_data."terminalActorMembershipCreatedAt"
      AND audit."terminalReason" IS NOT DISTINCT FROM row_data."terminalReason"
      AND audit."actorKind" = expected_actor_kind
      AND audit."actorId" IS NOT DISTINCT FROM expected_actor
      AND audit."actorProjectMembershipId" IS NOT DISTINCT FROM expected_actor_membership
      AND audit."actorMembershipCreatedAt" IS NOT DISTINCT FROM expected_actor_membership_created_at
      AND length(btrim(audit."reason")) > 0
      AND (row_data."status" NOT IN ('rejected', 'revoked', 'expired') OR audit."reason" = row_data."terminalReason")
      AND audit."transactionId" = txid_current()
      AND audit."transitionAt" = expected_transition_at
      AND (
        (row_data."version" = 1 AND row_data."status" = 'draft' AND previous_status IS NULL)
        OR (row_data."status" = 'owner_confirmed' AND previous_status = 'draft')
        OR (row_data."status" = 'active' AND previous_status = 'owner_confirmed')
        OR (row_data."status" = 'rejected' AND previous_status IN ('draft', 'owner_confirmed'))
        OR (row_data."status" = 'revoked' AND previous_status = 'active')
        OR (row_data."status" = 'expired' AND previous_status IN ('draft', 'owner_confirmed', 'active'))
      )
  ) INTO audit_matches;
  IF NOT audit_matches THEN
    RAISE EXCEPTION 'PROJECT_GIT_REPOSITORY_DELEGATION_AUDIT_INVALID' USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION "project_git_repository_delegation_transition_audit_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM "project_git_repository_delegation_validate_evidence"(NEW."id");
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "PGRD_transition_audit_guard"
AFTER INSERT OR UPDATE ON "ProjectGitRepositoryDelegation"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "project_git_repository_delegation_transition_audit_guard"();

CREATE OR REPLACE FUNCTION "project_git_repository_delegation_audit_insert_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  delegation_row RECORD;
  expected_transition TIMESTAMP(3);
BEGIN
  NEW."createdAt" := clock_timestamp();
  NEW."transactionId" := txid_current();
  IF length(btrim(NEW."reason")) = 0 THEN
    RAISE EXCEPTION 'PROJECT_GIT_REPOSITORY_DELEGATION_AUDIT_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO delegation_row FROM "ProjectGitRepositoryDelegation" WHERE "id" = NEW."delegationId";
  IF NOT FOUND OR delegation_row."status" <> NEW."statusAfter" OR delegation_row."version" <> NEW."delegationVersion" THEN
    RAISE EXCEPTION 'PROJECT_GIT_REPOSITORY_DELEGATION_AUDIT_ENTITY_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  expected_transition := CASE delegation_row."status"
    WHEN 'draft' THEN delegation_row."proposedAt"
    WHEN 'owner_confirmed' THEN delegation_row."ownerConfirmedAt"
    WHEN 'active' THEN delegation_row."activatedAt"
    WHEN 'rejected' THEN delegation_row."rejectedAt"
    WHEN 'revoked' THEN delegation_row."revokedAt"
    WHEN 'expired' THEN delegation_row."expiredAt"
  END;
  IF NEW."transitionAt" IS DISTINCT FROM expected_transition
     OR NEW."projectId" IS DISTINCT FROM delegation_row."projectId"
     OR NEW."gitConnectionId" IS DISTINCT FROM delegation_row."gitConnectionId"
     OR NEW."connectionOwnerId" IS DISTINCT FROM delegation_row."connectionOwnerId"
     OR NEW."actorKind" IS DISTINCT FROM (CASE WHEN NEW."action" = 'expired' THEN 'system_expiry'::"ProjectGitRepositoryDelegationActorKind" ELSE 'user'::"ProjectGitRepositoryDelegationActorKind" END) THEN
    RAISE EXCEPTION 'PROJECT_GIT_REPOSITORY_DELEGATION_AUDIT_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."action" = 'proposed' OR NEW."action" = 'owner_confirmed' THEN
    IF NEW."actorId" IS DISTINCT FROM delegation_row."connectionOwnerId"
       OR NEW."actorProjectMembershipId" IS DISTINCT FROM delegation_row."ownerProjectMembershipId"
       OR NEW."actorMembershipCreatedAt" IS DISTINCT FROM delegation_row."ownerMembershipCreatedAt" THEN
      RAISE EXCEPTION 'PROJECT_GIT_REPOSITORY_DELEGATION_AUDIT_ACTOR_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."action" = 'activated' THEN
    IF NEW."actorId" IS DISTINCT FROM delegation_row."projectConfirmedById"
       OR NEW."actorProjectMembershipId" IS DISTINCT FROM delegation_row."projectConfirmedProjectMembershipId"
       OR NEW."actorMembershipCreatedAt" IS DISTINCT FROM delegation_row."projectConfirmedMembershipCreatedAt" THEN
      RAISE EXCEPTION 'PROJECT_GIT_REPOSITORY_DELEGATION_AUDIT_ACTOR_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."action" IN ('rejected', 'revoked') THEN
    IF NEW."actorId" IS DISTINCT FROM delegation_row."terminalActorId"
       OR NEW."actorProjectMembershipId" IS DISTINCT FROM delegation_row."terminalActorProjectMembershipId"
       OR NEW."actorMembershipCreatedAt" IS DISTINCT FROM delegation_row."terminalActorMembershipCreatedAt" THEN
      RAISE EXCEPTION 'PROJECT_GIT_REPOSITORY_DELEGATION_AUDIT_ACTOR_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW."actorId" IS NOT NULL OR NEW."actorProjectMembershipId" IS NOT NULL OR NEW."actorMembershipCreatedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'PROJECT_GIT_REPOSITORY_DELEGATION_AUDIT_ACTOR_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "PGRD_audit_insert_guard"
BEFORE INSERT ON "ProjectGitRepositoryDelegationAudit"
FOR EACH ROW EXECUTE FUNCTION "project_git_repository_delegation_audit_insert_guard"();

CREATE OR REPLACE FUNCTION "project_git_repository_delegation_audit_entity_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM "project_git_repository_delegation_validate_evidence"(NEW."delegationId");
  RETURN NEW;
END;
$$;

CREATE TRIGGER "PGRD_audit_entity_guard"
AFTER INSERT ON "ProjectGitRepositoryDelegationAudit"
FOR EACH ROW EXECUTE FUNCTION "project_git_repository_delegation_audit_entity_guard"();

CREATE OR REPLACE FUNCTION "project_git_repository_delegation_audit_immutable_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'PROJECT_GIT_REPOSITORY_DELEGATION_AUDIT_IMMUTABLE' USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER "PGRD_audit_immutable_guard"
BEFORE UPDATE OR DELETE ON "ProjectGitRepositoryDelegationAudit"
FOR EACH ROW EXECUTE FUNCTION "project_git_repository_delegation_audit_immutable_guard"();
