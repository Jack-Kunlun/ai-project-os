-- MCP Package A: typed personal-connection delegation control plane.
--
-- This migration deliberately does not enable a project MCP runtime.  The
-- existing project-facing service remains fail-closed until a later package
-- installs a live action snapshot and invocation path.

-- Freeze the tables used by the historical preflight before any DDL or
-- backfill.  Prisma runs this migration in one transaction, so a failure
-- leaves no finished migration record and does not commit business DDL/data.
LOCK TABLE "McpConnection", "ProjectMcpToolGrant", "ProjectMcpToolGrantAudit", "ProjectAction", "ExternalCredential"
  IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  invalid_connection_count BIGINT;
  nonterminal_mcp_action_count BIGINT;
BEGIN
  SELECT COUNT(*)
    INTO invalid_connection_count
  FROM "McpConnection" AS connection
  LEFT JOIN "ExternalCredential" AS credential
    ON credential."id" = connection."credentialId"
  WHERE
    (connection."authKind" = 'none' AND connection."credentialId" IS NOT NULL)
    OR (connection."authKind" = 'bearer' AND (
      connection."credentialId" IS NULL
      OR credential."id" IS NULL
      OR credential."kind" <> 'mcp'
      OR credential."secretFingerprint" !~ '^[0-9a-f]{64}$'
    ))
    OR (connection."resolvedAddressFingerprint" IS NOT NULL
        AND connection."resolvedAddressFingerprint" !~ '^[0-9a-f]{64}$')
    OR (connection."catalogFingerprint" IS NOT NULL
        AND connection."catalogFingerprint" !~ '^[0-9a-f]{64}$')
    OR (connection."ownershipState" = 'confirmed' AND connection."ownerUserId" IS NULL)
    OR (connection."status" = 'disabled' AND connection."disabledAt" IS NULL)
    OR (connection."status" <> 'disabled' AND connection."disabledAt" IS NOT NULL);

  IF invalid_connection_count > 0 THEN
    RAISE EXCEPTION
      'PMCD_CONNECTION_EVIDENCE_PREFLIGHT_FAILED: % invalid MCP connection rows require remediation',
      invalid_connection_count
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT COUNT(*)
    INTO nonterminal_mcp_action_count
  FROM "ProjectAction"
  WHERE "capability" = 'project.mcp.read-tool.invoke'
    AND "status" IN ('waiting_approval', 'queued', 'running');

  IF nonterminal_mcp_action_count > 0 THEN
    RAISE EXCEPTION
      'PMCD_NONTERMINAL_MCP_ACTION_PREFLIGHT_FAILED: % non-terminal MCP actions require remediation',
      nonterminal_mcp_action_count
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

ALTER TABLE "McpConnection"
  ADD COLUMN "credentialFingerprint" CHAR(64) NOT NULL
    DEFAULT 'd2ab012fb807b99b7d059aabe98a45dd6edf6941a5f22699f8d04b5906dc2c2b',
  ADD COLUMN "configurationRevision" INTEGER NOT NULL DEFAULT 1,
  ADD CONSTRAINT "McpConnection_credential_fingerprint_check"
    CHECK ("credentialFingerprint" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "McpConnection_configuration_revision_check"
    CHECK ("configurationRevision" > 0),
  ADD CONSTRAINT "McpConnection_disabled_state_check"
    CHECK (("status" = 'disabled') = ("disabledAt" IS NOT NULL));

-- Only the new connection evidence fields are backfilled.  No grant, action,
-- or audit row is rewritten, activated, revoked, or otherwise reconciled.
UPDATE "McpConnection" AS connection
SET "credentialFingerprint" = credential."secretFingerprint"
FROM "ExternalCredential" AS credential
WHERE credential."id" = connection."credentialId"
  AND credential."kind" = 'mcp';

ALTER TABLE "ProjectMcpToolGrantAudit"
  ADD COLUMN "transactionId" BIGINT;

CREATE INDEX "ProjectMcpToolGrantAudit_transactionId_createdAt_idx"
  ON "ProjectMcpToolGrantAudit"("transactionId", "createdAt");

CREATE TYPE "ProjectMcpConnectionDelegationStatus" AS ENUM (
  'draft',
  'owner_confirmed',
  'active',
  'rejected',
  'revoked',
  'expired'
);

CREATE TYPE "ProjectMcpConnectionDelegationActorKind" AS ENUM (
  'user',
  'system_expiry'
);

CREATE TYPE "ProjectMcpConnectionDelegationAuditAction" AS ENUM (
  'proposed',
  'owner_confirmed',
  'activated',
  'rejected',
  'revoked',
  'expired'
);

CREATE TABLE "ProjectMcpConnectionDelegation" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "mcpConnectionId" UUID NOT NULL,
  "connectionOwnerId" UUID NOT NULL,
  "connectionConfigurationRevision" INTEGER NOT NULL,
  "resolvedAddressFingerprint" CHAR(64) NOT NULL,
  "credentialFingerprint" CHAR(64) NOT NULL,
  "delegationFingerprint" CHAR(64) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "status" "ProjectMcpConnectionDelegationStatus" NOT NULL DEFAULT 'draft',
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
  "terminalActorKind" "ProjectMcpConnectionDelegationActorKind",
  "terminalActorId" UUID,
  "terminalActorProjectMembershipId" UUID,
  "terminalActorMembershipCreatedAt" TIMESTAMP(3),
  "terminalReason" VARCHAR(500),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PMCD_version_check" CHECK ("version" > 0),
  CONSTRAINT "PMCD_connection_revision_check" CHECK ("connectionConfigurationRevision" > 0),
  CONSTRAINT "PMCD_fingerprint_check" CHECK (
    "resolvedAddressFingerprint" ~ '^[0-9a-f]{64}$'
    AND "credentialFingerprint" ~ '^[0-9a-f]{64}$'
    AND "delegationFingerprint" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "PMCD_expiry_check" CHECK ("expiresAt" > "proposedAt"),
  CONSTRAINT "ProjectMcpConnectionDelegation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProjectMcpConnectionDelegationAudit" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "mcpConnectionId" UUID NOT NULL,
  "delegationId" UUID NOT NULL,
  "connectionOwnerId" UUID NOT NULL,
  "action" "ProjectMcpConnectionDelegationAuditAction" NOT NULL,
  "delegationVersion" INTEGER NOT NULL,
  "statusBefore" "ProjectMcpConnectionDelegationStatus",
  "statusAfter" "ProjectMcpConnectionDelegationStatus" NOT NULL,
  "actorKind" "ProjectMcpConnectionDelegationActorKind" NOT NULL DEFAULT 'user',
  "actorId" UUID,
  "actorProjectMembershipId" UUID,
  "actorMembershipCreatedAt" TIMESTAMP(3),
  "terminalActorKind" "ProjectMcpConnectionDelegationActorKind",
  "terminalActorId" UUID,
  "terminalActorProjectMembershipId" UUID,
  "terminalActorMembershipCreatedAt" TIMESTAMP(3),
  "terminalReason" VARCHAR(500),
  "ownerProjectMembershipId" UUID NOT NULL,
  "ownerMembershipCreatedAt" TIMESTAMP(3) NOT NULL,
  "projectConfirmedProjectMembershipId" UUID,
  "projectConfirmedMembershipCreatedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "connectionConfigurationRevision" INTEGER NOT NULL,
  "resolvedAddressFingerprint" CHAR(64) NOT NULL,
  "credentialFingerprint" CHAR(64) NOT NULL,
  "delegationFingerprint" CHAR(64) NOT NULL,
  "reason" VARCHAR(500) NOT NULL,
  "transitionAt" TIMESTAMP(3) NOT NULL,
  "transactionId" BIGINT NOT NULL DEFAULT txid_current(),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PMCD_A_version_check" CHECK ("delegationVersion" > 0),
  CONSTRAINT "PMCD_A_fingerprint_check" CHECK (
    "resolvedAddressFingerprint" ~ '^[0-9a-f]{64}$'
    AND "credentialFingerprint" ~ '^[0-9a-f]{64}$'
    AND "delegationFingerprint" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "PMCD_A_reason_check" CHECK (length(btrim("reason")) > 0),
  CONSTRAINT "ProjectMcpConnectionDelegationAudit_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PMCD_live_project_connection_key"
  ON "ProjectMcpConnectionDelegation" ("projectId", "mcpConnectionId")
  WHERE "status" IN ('draft', 'owner_confirmed', 'active');
CREATE UNIQUE INDEX "PMCD_delegation_identity_key"
  ON "ProjectMcpConnectionDelegation" ("id", "projectId", "mcpConnectionId");
CREATE INDEX "PMCD_project_status_expiry_idx"
  ON "ProjectMcpConnectionDelegation" ("projectId", "status", "expiresAt");
CREATE INDEX "PMCD_connection_status_idx"
  ON "ProjectMcpConnectionDelegation" ("mcpConnectionId", "status");
CREATE INDEX "PMCD_owner_status_idx"
  ON "ProjectMcpConnectionDelegation" ("connectionOwnerId", "status");
CREATE UNIQUE INDEX "PMCD_A_delegation_version_key"
  ON "ProjectMcpConnectionDelegationAudit" ("delegationId", "delegationVersion");
CREATE INDEX "PMCD_A_project_created_idx"
  ON "ProjectMcpConnectionDelegationAudit" ("projectId", "createdAt");
CREATE INDEX "PMCD_A_delegation_created_idx"
  ON "ProjectMcpConnectionDelegationAudit" ("delegationId", "createdAt");
CREATE INDEX "PMCD_A_transaction_created_idx"
  ON "ProjectMcpConnectionDelegationAudit" ("transactionId", "createdAt");

ALTER TABLE "ProjectMcpConnectionDelegation"
  ADD CONSTRAINT "PMCD_project_fkey"
    FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "PMCD_connection_fkey"
    FOREIGN KEY ("mcpConnectionId") REFERENCES "McpConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "PMCD_connection_owner_fkey"
    FOREIGN KEY ("connectionOwnerId") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PMCD_owner_membership_fkey"
    FOREIGN KEY ("ownerProjectMembershipId") REFERENCES "ProjectMembership"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PMCD_project_confirmed_membership_fkey"
    FOREIGN KEY ("projectConfirmedProjectMembershipId") REFERENCES "ProjectMembership"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PMCD_proposer_fkey"
    FOREIGN KEY ("proposedById") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PMCD_owner_confirmer_fkey"
    FOREIGN KEY ("ownerConfirmedById") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PMCD_project_confirmer_fkey"
    FOREIGN KEY ("projectConfirmedById") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PMCD_terminal_actor_fkey"
    FOREIGN KEY ("terminalActorId") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "ProjectMcpToolGrant"
  ADD COLUMN "delegationId" UUID,
  ADD CONSTRAINT "ProjectMcpToolGrant_delegation_fkey"
    FOREIGN KEY ("delegationId", "projectId", "connectionId")
    REFERENCES "ProjectMcpConnectionDelegation" ("id", "projectId", "mcpConnectionId")
    ON DELETE NO ACTION ON UPDATE NO ACTION;
CREATE INDEX "ProjectMcpToolGrant_delegationId_idx"
  ON "ProjectMcpToolGrant" ("delegationId");

-- Keep the legacy credential FK semantically NO ACTION while deferring its
-- final check so the mirror validator owns rotate/delete evidence at commit.
-- This permits an atomic credential replacement or connection removal without
-- allowing a committed dangling connection.
ALTER TABLE "McpConnection"
  ALTER CONSTRAINT "McpConnection_credentialId_fkey" DEFERRABLE INITIALLY DEFERRED;

CREATE OR REPLACE FUNCTION "mcp_connection_configuration_revision_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  sentinel CONSTANT CHAR(64) := 'd2ab012fb807b99b7d059aabe98a45dd6edf6941a5f22699f8d04b5906dc2c2b';
  calculated CHAR(64) := sentinel;
  credential_kind "ExternalCredentialKind";
  changed BOOLEAN;
BEGIN
  IF NEW."credentialId" IS NOT NULL THEN
    SELECT credential."kind", credential."secretFingerprint"
      INTO credential_kind, calculated
    FROM "ExternalCredential" AS credential
    WHERE credential."id" = NEW."credentialId";
    IF NOT FOUND OR credential_kind <> 'mcp' THEN
      RAISE EXCEPTION 'MCP_CONNECTION_CREDENTIAL_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."authKind" = 'none' AND NEW."credentialId" IS NOT NULL THEN
    RAISE EXCEPTION 'MCP_CONNECTION_AUTH_INVALID' USING ERRCODE = 'check_violation';
  ELSIF NEW."authKind" = 'bearer' AND NEW."credentialId" IS NULL THEN
    RAISE EXCEPTION 'MCP_CONNECTION_AUTH_INVALID' USING ERRCODE = 'check_violation';
  END IF;

  NEW."credentialFingerprint" := calculated;
  IF TG_OP = 'INSERT' THEN
    IF NEW."configurationRevision" IS NULL OR NEW."configurationRevision" <> 1 THEN
      RAISE EXCEPTION 'MCP_CONNECTION_CONFIGURATION_REVISION_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  changed := OLD."endpointUrl" IS DISTINCT FROM NEW."endpointUrl"
    OR OLD."authKind" IS DISTINCT FROM NEW."authKind"
    OR OLD."credentialId" IS DISTINCT FROM NEW."credentialId"
    OR OLD."credentialFingerprint" IS DISTINCT FROM NEW."credentialFingerprint"
    OR OLD."allowPrivateNetwork" IS DISTINCT FROM NEW."allowPrivateNetwork"
    OR OLD."resolvedAddressFingerprint" IS DISTINCT FROM NEW."resolvedAddressFingerprint"
    OR OLD."protocolVersion" IS DISTINCT FROM NEW."protocolVersion"
    OR OLD."ownerUserId" IS DISTINCT FROM NEW."ownerUserId"
    OR OLD."ownershipState" IS DISTINCT FROM NEW."ownershipState"
    OR ((OLD."status" = 'disabled') IS DISTINCT FROM (NEW."status" = 'disabled'))
    OR OLD."disabledAt" IS DISTINCT FROM NEW."disabledAt";

  IF changed THEN
    IF NEW."configurationRevision" = OLD."configurationRevision" THEN
      NEW."configurationRevision" := OLD."configurationRevision" + 1;
    ELSIF NEW."configurationRevision" <> OLD."configurationRevision" + 1 THEN
      RAISE EXCEPTION 'MCP_CONNECTION_CONFIGURATION_REVISION_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."configurationRevision" IS DISTINCT FROM OLD."configurationRevision" THEN
    RAISE EXCEPTION 'MCP_CONNECTION_CONFIGURATION_REVISION_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "McpConnection_configuration_revision_guard"
BEFORE INSERT OR UPDATE ON "McpConnection"
FOR EACH ROW EXECUTE FUNCTION "mcp_connection_configuration_revision_guard"();

CREATE OR REPLACE FUNCTION "mcp_connection_credential_mirror_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD."kind" IS NOT DISTINCT FROM NEW."kind"
     AND OLD."secretFingerprint" IS NOT DISTINCT FROM NEW."secretFingerprint" THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM "McpConnection" AS connection
    WHERE connection."credentialId" = OLD."id"
      AND (
        TG_OP = 'DELETE'
        OR NEW."kind" <> 'mcp'
        OR connection."credentialFingerprint" IS DISTINCT FROM NEW."secretFingerprint"
      )
  ) THEN
    RAISE EXCEPTION 'MCP_CONNECTION_CREDENTIAL_MIRROR_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE CONSTRAINT TRIGGER "McpConnection_credential_mirror_guard"
AFTER UPDATE OR DELETE ON "ExternalCredential"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "mcp_connection_credential_mirror_guard"();

CREATE OR REPLACE FUNCTION "project_mcp_connection_delegation_shape_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW."createdAt" := clock_timestamp();
    NEW."updatedAt" := NEW."createdAt";
    NEW."proposedAt" := NEW."createdAt";
    IF NEW."status" <> 'draft' OR NEW."version" <> 1 THEN
      RAISE EXCEPTION 'PROJECT_MCP_CONNECTION_DELEGATION_STATE_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    NEW."updatedAt" := clock_timestamp();
    IF OLD."id" IS DISTINCT FROM NEW."id"
       OR OLD."projectId" IS DISTINCT FROM NEW."projectId"
       OR OLD."mcpConnectionId" IS DISTINCT FROM NEW."mcpConnectionId"
       OR OLD."connectionOwnerId" IS DISTINCT FROM NEW."connectionOwnerId"
       OR OLD."connectionConfigurationRevision" IS DISTINCT FROM NEW."connectionConfigurationRevision"
       OR OLD."resolvedAddressFingerprint" IS DISTINCT FROM NEW."resolvedAddressFingerprint"
       OR OLD."credentialFingerprint" IS DISTINCT FROM NEW."credentialFingerprint"
       OR OLD."delegationFingerprint" IS DISTINCT FROM NEW."delegationFingerprint"
       OR OLD."expiresAt" IS DISTINCT FROM NEW."expiresAt"
       OR OLD."ownerProjectMembershipId" IS DISTINCT FROM NEW."ownerProjectMembershipId"
       OR OLD."ownerMembershipCreatedAt" IS DISTINCT FROM NEW."ownerMembershipCreatedAt"
       OR OLD."proposedById" IS DISTINCT FROM NEW."proposedById"
       OR OLD."proposedAt" IS DISTINCT FROM NEW."proposedAt" THEN
      RAISE EXCEPTION 'PROJECT_MCP_CONNECTION_DELEGATION_IMMUTABLE' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."version" <> OLD."version" + 1 THEN
      RAISE EXCEPTION 'PROJECT_MCP_CONNECTION_DELEGATION_VERSION_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT (
      (OLD."status" = 'draft' AND NEW."status" IN ('owner_confirmed', 'rejected', 'expired'))
      OR (OLD."status" = 'owner_confirmed' AND NEW."status" IN ('active', 'rejected', 'expired'))
      OR (OLD."status" = 'active' AND NEW."status" IN ('revoked', 'expired'))
    ) THEN
      RAISE EXCEPTION 'PROJECT_MCP_CONNECTION_DELEGATION_STATE_INVALID' USING ERRCODE = 'check_violation';
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
       OR OLD."expiredAt" IS NOT NULL AND OLD."expiredAt" IS DISTINCT FROM NEW."expiredAt" THEN
      RAISE EXCEPTION 'PROJECT_MCP_CONNECTION_DELEGATION_CONFIRMATION_IMMUTABLE' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" = 'owner_confirmed' THEN
      NEW."ownerConfirmedAt" := clock_timestamp();
    ELSIF NEW."status" = 'active' THEN
      NEW."projectConfirmedAt" := clock_timestamp();
      NEW."activatedAt" := NEW."projectConfirmedAt";
    ELSIF NEW."status" = 'rejected' THEN
      NEW."rejectedAt" := clock_timestamp();
      NEW."terminalActorKind" := 'user';
    ELSIF NEW."status" = 'revoked' THEN
      NEW."revokedAt" := clock_timestamp();
      NEW."terminalActorKind" := 'user';
    ELSIF NEW."status" = 'expired' THEN
      IF clock_timestamp() < NEW."expiresAt" THEN
        RAISE EXCEPTION 'PROJECT_MCP_CONNECTION_DELEGATION_NOT_EXPIRED' USING ERRCODE = 'check_violation';
      END IF;
      NEW."expiredAt" := clock_timestamp();
      NEW."terminalActorKind" := 'system_expiry';
      NEW."terminalActorId" := NULL;
      NEW."terminalActorProjectMembershipId" := NULL;
      NEW."terminalActorMembershipCreatedAt" := NULL;
      NEW."terminalReason" := 'system_expiry';
    END IF;
  END IF;

  IF NEW."proposedById" IS DISTINCT FROM NEW."connectionOwnerId" THEN
    RAISE EXCEPTION 'PROJECT_MCP_CONNECTION_DELEGATION_PROPOSER_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."expiresAt" <= NEW."proposedAt" THEN
    RAISE EXCEPTION 'PROJECT_MCP_CONNECTION_DELEGATION_EXPIRY_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'draft' THEN
    IF NEW."ownerConfirmedById" IS NOT NULL OR NEW."ownerConfirmedAt" IS NOT NULL
       OR NEW."projectConfirmedById" IS NOT NULL OR NEW."projectConfirmedAt" IS NOT NULL
       OR NEW."projectConfirmedProjectMembershipId" IS NOT NULL OR NEW."projectConfirmedMembershipCreatedAt" IS NOT NULL
       OR NEW."activatedAt" IS NOT NULL OR NEW."rejectedAt" IS NOT NULL OR NEW."revokedAt" IS NOT NULL OR NEW."expiredAt" IS NOT NULL
       OR NEW."terminalActorKind" IS NOT NULL OR NEW."terminalActorId" IS NOT NULL
       OR NEW."terminalActorProjectMembershipId" IS NOT NULL OR NEW."terminalActorMembershipCreatedAt" IS NOT NULL
       OR NEW."terminalReason" IS NOT NULL THEN
      RAISE EXCEPTION 'PROJECT_MCP_CONNECTION_DELEGATION_STATE_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."status" = 'owner_confirmed' THEN
    IF NEW."ownerConfirmedById" IS DISTINCT FROM NEW."connectionOwnerId" OR NEW."ownerConfirmedAt" IS NULL
       OR NEW."projectConfirmedById" IS NOT NULL OR NEW."projectConfirmedAt" IS NOT NULL
       OR NEW."projectConfirmedProjectMembershipId" IS NOT NULL OR NEW."projectConfirmedMembershipCreatedAt" IS NOT NULL
       OR NEW."activatedAt" IS NOT NULL OR NEW."rejectedAt" IS NOT NULL OR NEW."revokedAt" IS NOT NULL OR NEW."expiredAt" IS NOT NULL
       OR NEW."terminalActorKind" IS NOT NULL OR NEW."terminalActorId" IS NOT NULL
       OR NEW."terminalActorProjectMembershipId" IS NOT NULL OR NEW."terminalActorMembershipCreatedAt" IS NOT NULL
       OR NEW."terminalReason" IS NOT NULL THEN
      RAISE EXCEPTION 'PROJECT_MCP_CONNECTION_DELEGATION_STATE_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."status" = 'active' THEN
    IF NEW."ownerConfirmedById" IS DISTINCT FROM NEW."connectionOwnerId" OR NEW."ownerConfirmedAt" IS NULL
       OR NEW."projectConfirmedById" IS NULL OR NEW."projectConfirmedAt" IS NULL
       OR NEW."projectConfirmedProjectMembershipId" IS NULL OR NEW."projectConfirmedMembershipCreatedAt" IS NULL
       OR NEW."activatedAt" IS NULL OR NEW."rejectedAt" IS NOT NULL OR NEW."revokedAt" IS NOT NULL OR NEW."expiredAt" IS NOT NULL
       OR NEW."terminalActorKind" IS NOT NULL OR NEW."terminalActorId" IS NOT NULL
       OR NEW."terminalActorProjectMembershipId" IS NOT NULL OR NEW."terminalActorMembershipCreatedAt" IS NOT NULL
       OR NEW."terminalReason" IS NOT NULL THEN
      RAISE EXCEPTION 'PROJECT_MCP_CONNECTION_DELEGATION_STATE_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."status" IN ('rejected', 'revoked') THEN
    IF NEW."terminalActorKind" IS DISTINCT FROM 'user'
       OR NEW."terminalActorId" IS NULL
       OR NEW."terminalActorProjectMembershipId" IS NULL
       OR NEW."terminalActorMembershipCreatedAt" IS NULL
       OR NEW."terminalReason" IS NULL
       OR length(btrim(NEW."terminalReason")) = 0
       OR (NEW."status" = 'rejected' AND NEW."rejectedAt" IS NULL)
       OR (NEW."status" = 'revoked' AND NEW."revokedAt" IS NULL)
       OR (NEW."status" = 'rejected' AND OLD."status" = 'draft' AND NEW."ownerConfirmedById" IS NOT NULL)
       OR (NEW."status" = 'rejected' AND OLD."status" = 'owner_confirmed' AND NEW."ownerConfirmedById" IS NULL)
       OR (NEW."status" = 'revoked' AND OLD."status" = 'active' AND (NEW."ownerConfirmedById" IS NULL OR NEW."projectConfirmedById" IS NULL)) THEN
      RAISE EXCEPTION 'PROJECT_MCP_CONNECTION_DELEGATION_STATE_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."status" = 'expired' THEN
    IF NEW."terminalActorKind" IS DISTINCT FROM 'system_expiry'
       OR NEW."terminalActorId" IS NOT NULL
       OR NEW."terminalActorProjectMembershipId" IS NOT NULL
       OR NEW."terminalActorMembershipCreatedAt" IS NOT NULL
       OR NEW."terminalReason" IS DISTINCT FROM 'system_expiry'
       OR NEW."expiredAt" IS NULL THEN
      RAISE EXCEPTION 'PROJECT_MCP_CONNECTION_DELEGATION_STATE_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."status" IN ('rejected', 'revoked') THEN
    IF NOT EXISTS (
      SELECT 1
      FROM "AppUser" AS actor
      WHERE actor."id" = NEW."terminalActorId"
        AND actor."disabledAt" IS NULL
        AND (
          (
            actor."id" = NEW."connectionOwnerId"
            AND NEW."terminalActorProjectMembershipId" = NEW."ownerProjectMembershipId"
            AND NEW."terminalActorMembershipCreatedAt" = NEW."ownerMembershipCreatedAt"
          )
          OR EXISTS (
            SELECT 1
            FROM "ProjectMembership" AS membership
            WHERE membership."id" = NEW."terminalActorProjectMembershipId"
              AND NEW."terminalActorId" IS DISTINCT FROM NEW."connectionOwnerId"
              AND membership."projectId" = NEW."projectId"
              AND membership."userId" = NEW."terminalActorId"
              AND membership."role" = 'owner'
              AND membership."accessState" = 'confirmed'
              AND membership."createdAt" = NEW."terminalActorMembershipCreatedAt"
          )
        )
    ) THEN
      RAISE EXCEPTION 'PROJECT_MCP_CONNECTION_DELEGATION_AUDIT_ACTOR_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "PMCD_shape_guard"
BEFORE INSERT OR UPDATE ON "ProjectMcpConnectionDelegation"
FOR EACH ROW EXECUTE FUNCTION "project_mcp_connection_delegation_shape_guard"();

CREATE OR REPLACE FUNCTION "project_mcp_connection_delegation_delete_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."status" IN ('draft', 'owner_confirmed', 'active') THEN
    RAISE EXCEPTION 'PROJECT_MCP_CONNECTION_DELEGATION_LIVE_DELETE_FORBIDDEN' USING ERRCODE = 'check_violation';
  END IF;
  IF pg_trigger_depth() <= 1 THEN
    RAISE EXCEPTION 'PROJECT_MCP_CONNECTION_DELEGATION_DELETE_FORBIDDEN' USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER "PMCD_delete_guard"
BEFORE DELETE ON "ProjectMcpConnectionDelegation"
FOR EACH ROW EXECUTE FUNCTION "project_mcp_connection_delegation_delete_guard"();

CREATE OR REPLACE FUNCTION "mcp_connection_project_delegation_delete_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "ProjectMcpConnectionDelegation"
    WHERE "mcpConnectionId" = OLD."id"
      AND "status" IN ('draft', 'owner_confirmed', 'active')
  ) THEN
    RAISE EXCEPTION 'MCP_CONNECTION_LIVE_DELEGATION_DELETE_FORBIDDEN' USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER "McpConnection_project_delegation_delete_guard"
BEFORE DELETE ON "McpConnection"
FOR EACH ROW EXECUTE FUNCTION "mcp_connection_project_delegation_delete_guard"();

CREATE OR REPLACE FUNCTION "project_mcp_connection_delegation_live_integrity_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  sentinel CONSTANT CHAR(64) := 'd2ab012fb807b99b7d059aabe98a45dd6edf6941a5f22699f8d04b5906dc2c2b';
  connection_valid BOOLEAN;
  owner_valid BOOLEAN;
  project_owner_valid BOOLEAN;
BEGIN
  IF NEW."status" NOT IN ('draft', 'owner_confirmed', 'active') THEN
    RETURN NEW;
  END IF;
  IF NEW."expiresAt" <= clock_timestamp() THEN
    RAISE EXCEPTION 'PROJECT_MCP_CONNECTION_DELEGATION_LIVE_EXPIRED' USING ERRCODE = 'check_violation';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM "McpConnection" AS connection
    LEFT JOIN "ExternalCredential" AS credential
      ON credential."id" = connection."credentialId"
    JOIN "Project" AS project_row
      ON project_row."id" = NEW."projectId"
    WHERE connection."id" = NEW."mcpConnectionId"
      AND connection."ownerUserId" = NEW."connectionOwnerId"
      AND connection."ownershipState" = 'confirmed'
      AND connection."status" = 'verified'
      AND connection."disabledAt" IS NULL
      AND connection."configurationRevision" = NEW."connectionConfigurationRevision"
      AND connection."resolvedAddressFingerprint" = NEW."resolvedAddressFingerprint"
      AND connection."credentialFingerprint" = NEW."credentialFingerprint"
      AND (
        (
          connection."authKind" = 'none'
          AND connection."credentialId" IS NULL
          AND connection."credentialFingerprint" = sentinel
        )
        OR (
          connection."authKind" = 'bearer'
          AND credential."kind" = 'mcp'
          AND credential."secretFingerprint" = connection."credentialFingerprint"
        )
      )
      AND project_row."archivedAt" IS NULL
  ) INTO connection_valid;
  IF NOT connection_valid THEN
    RAISE EXCEPTION 'PROJECT_MCP_CONNECTION_DELEGATION_LIVE_CONNECTION_INVALID' USING ERRCODE = 'check_violation';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM "AppUser" AS user_row
    JOIN "ProjectMembership" AS membership
      ON membership."id" = NEW."ownerProjectMembershipId"
    WHERE user_row."id" = NEW."connectionOwnerId"
      AND user_row."disabledAt" IS NULL
      AND membership."projectId" = NEW."projectId"
      AND membership."userId" = NEW."connectionOwnerId"
      AND membership."role" IN ('owner', 'editor')
      AND membership."accessState" = 'confirmed'
      AND membership."createdAt" = NEW."ownerMembershipCreatedAt"
  ) INTO owner_valid;
  IF NOT owner_valid THEN
    RAISE EXCEPTION 'PROJECT_MCP_CONNECTION_DELEGATION_LIVE_OWNER_INVALID' USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."status" = 'active' THEN
    SELECT EXISTS (
      SELECT 1
      FROM "AppUser" AS user_row
      JOIN "ProjectMembership" AS membership
        ON membership."id" = NEW."projectConfirmedProjectMembershipId"
      WHERE user_row."id" = NEW."projectConfirmedById"
        AND user_row."disabledAt" IS NULL
        AND membership."projectId" = NEW."projectId"
        AND membership."userId" = NEW."projectConfirmedById"
        AND membership."role" = 'owner'
        AND membership."accessState" = 'confirmed'
        AND membership."createdAt" = NEW."projectConfirmedMembershipCreatedAt"
    ) INTO project_owner_valid;
    IF NOT project_owner_valid THEN
      RAISE EXCEPTION 'PROJECT_MCP_CONNECTION_DELEGATION_ACTIVE_PROJECT_OWNER_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "PMCD_live_integrity_guard"
AFTER INSERT OR UPDATE ON "ProjectMcpConnectionDelegation"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "project_mcp_connection_delegation_live_integrity_guard"();

CREATE OR REPLACE FUNCTION "project_mcp_connection_delegation_validate_evidence"(delegation_id UUID)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  row_data RECORD;
  previous_status "ProjectMcpConnectionDelegationStatus";
  expected_action "ProjectMcpConnectionDelegationAuditAction";
  expected_actor UUID;
  expected_actor_kind "ProjectMcpConnectionDelegationActorKind";
  expected_actor_membership UUID;
  expected_actor_membership_created_at TIMESTAMP(3);
  expected_transition_at TIMESTAMP(3);
  audit_count INTEGER;
  audit_matches BOOLEAN;
BEGIN
  SELECT * INTO row_data
  FROM "ProjectMcpConnectionDelegation"
  WHERE "id" = delegation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROJECT_MCP_CONNECTION_DELEGATION_AUDIT_ENTITY_INVALID' USING ERRCODE = 'check_violation';
  END IF;

  SELECT COUNT(*) INTO audit_count
  FROM "ProjectMcpConnectionDelegationAudit" AS audit
  WHERE audit."delegationId" = row_data."id"
    AND audit."delegationVersion" = row_data."version";
  IF audit_count = 0 THEN
    RAISE EXCEPTION 'PROJECT_MCP_CONNECTION_DELEGATION_AUDIT_REQUIRED' USING ERRCODE = 'check_violation';
  ELSIF audit_count <> 1 THEN
    RAISE EXCEPTION 'PROJECT_MCP_CONNECTION_DELEGATION_AUDIT_INVALID' USING ERRCODE = 'check_violation';
  END IF;

  IF row_data."version" = 1 THEN
    previous_status := NULL;
    expected_action := 'proposed';
  ELSE
    SELECT audit."statusAfter" INTO previous_status
    FROM "ProjectMcpConnectionDelegationAudit" AS audit
    WHERE audit."delegationId" = row_data."id"
      AND audit."delegationVersion" = row_data."version" - 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'PROJECT_MCP_CONNECTION_DELEGATION_AUDIT_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    expected_action := CASE row_data."status"
      WHEN 'owner_confirmed' THEN 'owner_confirmed'
      WHEN 'active' THEN 'activated'
      WHEN 'rejected' THEN 'rejected'
      WHEN 'revoked' THEN 'revoked'
      WHEN 'expired' THEN 'expired'
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
    WHEN 'expired' THEN 'system_expiry'
    ELSE 'user'
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
    FROM "ProjectMcpConnectionDelegationAudit" AS audit
    WHERE audit."delegationId" = row_data."id"
      AND audit."action" = expected_action
      AND audit."delegationVersion" = row_data."version"
      AND audit."statusBefore" IS NOT DISTINCT FROM previous_status
      AND audit."statusAfter" = row_data."status"
      AND audit."projectId" = row_data."projectId"
      AND audit."mcpConnectionId" = row_data."mcpConnectionId"
      AND audit."connectionOwnerId" = row_data."connectionOwnerId"
      AND audit."ownerProjectMembershipId" = row_data."ownerProjectMembershipId"
      AND audit."ownerMembershipCreatedAt" = row_data."ownerMembershipCreatedAt"
      AND audit."projectConfirmedProjectMembershipId" IS NOT DISTINCT FROM row_data."projectConfirmedProjectMembershipId"
      AND audit."projectConfirmedMembershipCreatedAt" IS NOT DISTINCT FROM row_data."projectConfirmedMembershipCreatedAt"
      AND audit."expiresAt" = row_data."expiresAt"
      AND audit."connectionConfigurationRevision" = row_data."connectionConfigurationRevision"
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
    RAISE EXCEPTION 'PROJECT_MCP_CONNECTION_DELEGATION_AUDIT_INVALID' USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION "project_mcp_connection_delegation_transition_audit_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM "project_mcp_connection_delegation_validate_evidence"(NEW."id");
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "PMCD_transition_audit_guard"
AFTER INSERT OR UPDATE ON "ProjectMcpConnectionDelegation"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "project_mcp_connection_delegation_transition_audit_guard"();

CREATE OR REPLACE FUNCTION "project_mcp_connection_delegation_audit_insert_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  delegation_row RECORD;
  expected_transition TIMESTAMP(3);
  previous_status "ProjectMcpConnectionDelegationStatus";
BEGIN
  NEW."createdAt" := clock_timestamp();
  NEW."transactionId" := txid_current();
  IF length(btrim(NEW."reason")) = 0 THEN
    RAISE EXCEPTION 'PROJECT_MCP_CONNECTION_DELEGATION_AUDIT_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO delegation_row
  FROM "ProjectMcpConnectionDelegation"
  WHERE "id" = NEW."delegationId";
  IF NOT FOUND OR delegation_row."status" <> NEW."statusAfter" OR delegation_row."version" <> NEW."delegationVersion" THEN
    RAISE EXCEPTION 'PROJECT_MCP_CONNECTION_DELEGATION_AUDIT_ENTITY_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  expected_transition := CASE delegation_row."status"
    WHEN 'draft' THEN delegation_row."proposedAt"
    WHEN 'owner_confirmed' THEN delegation_row."ownerConfirmedAt"
    WHEN 'active' THEN delegation_row."activatedAt"
    WHEN 'rejected' THEN delegation_row."rejectedAt"
    WHEN 'revoked' THEN delegation_row."revokedAt"
    WHEN 'expired' THEN delegation_row."expiredAt"
  END;
  NEW."transitionAt" := expected_transition;
  IF delegation_row."version" = 1 THEN
    previous_status := NULL;
  ELSE
    SELECT audit."statusAfter" INTO previous_status
    FROM "ProjectMcpConnectionDelegationAudit" AS audit
    WHERE audit."delegationId" = delegation_row."id"
      AND audit."delegationVersion" = delegation_row."version" - 1;
  END IF;
  IF NEW."projectId" IS DISTINCT FROM delegation_row."projectId"
     OR NEW."mcpConnectionId" IS DISTINCT FROM delegation_row."mcpConnectionId"
     OR NEW."connectionOwnerId" IS DISTINCT FROM delegation_row."connectionOwnerId"
     OR NEW."statusBefore" IS DISTINCT FROM previous_status
     OR NEW."actorKind" IS DISTINCT FROM (CASE WHEN NEW."action" = 'expired'
       THEN 'system_expiry'::"ProjectMcpConnectionDelegationActorKind"
       ELSE 'user'::"ProjectMcpConnectionDelegationActorKind" END)
     OR NEW."ownerProjectMembershipId" IS DISTINCT FROM delegation_row."ownerProjectMembershipId"
     OR NEW."ownerMembershipCreatedAt" IS DISTINCT FROM delegation_row."ownerMembershipCreatedAt"
     OR NEW."projectConfirmedProjectMembershipId" IS DISTINCT FROM delegation_row."projectConfirmedProjectMembershipId"
     OR NEW."projectConfirmedMembershipCreatedAt" IS DISTINCT FROM delegation_row."projectConfirmedMembershipCreatedAt"
     OR NEW."expiresAt" IS DISTINCT FROM delegation_row."expiresAt"
     OR NEW."connectionConfigurationRevision" IS DISTINCT FROM delegation_row."connectionConfigurationRevision"
     OR NEW."resolvedAddressFingerprint" IS DISTINCT FROM delegation_row."resolvedAddressFingerprint"
     OR NEW."credentialFingerprint" IS DISTINCT FROM delegation_row."credentialFingerprint"
     OR NEW."delegationFingerprint" IS DISTINCT FROM delegation_row."delegationFingerprint"
     OR NEW."terminalActorKind" IS DISTINCT FROM delegation_row."terminalActorKind"
     OR NEW."terminalActorId" IS DISTINCT FROM delegation_row."terminalActorId"
     OR NEW."terminalActorProjectMembershipId" IS DISTINCT FROM delegation_row."terminalActorProjectMembershipId"
     OR NEW."terminalActorMembershipCreatedAt" IS DISTINCT FROM delegation_row."terminalActorMembershipCreatedAt"
     OR NEW."terminalReason" IS DISTINCT FROM delegation_row."terminalReason" THEN
    RAISE EXCEPTION 'PROJECT_MCP_CONNECTION_DELEGATION_AUDIT_INVALID' USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."action" IN ('proposed', 'owner_confirmed') THEN
    IF NEW."actorId" IS DISTINCT FROM delegation_row."connectionOwnerId"
       OR NEW."actorProjectMembershipId" IS DISTINCT FROM delegation_row."ownerProjectMembershipId"
       OR NEW."actorMembershipCreatedAt" IS DISTINCT FROM delegation_row."ownerMembershipCreatedAt" THEN
      RAISE EXCEPTION 'PROJECT_MCP_CONNECTION_DELEGATION_AUDIT_ACTOR_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."action" = 'activated' THEN
    IF NEW."actorId" IS DISTINCT FROM delegation_row."projectConfirmedById"
       OR NEW."actorProjectMembershipId" IS DISTINCT FROM delegation_row."projectConfirmedProjectMembershipId"
       OR NEW."actorMembershipCreatedAt" IS DISTINCT FROM delegation_row."projectConfirmedMembershipCreatedAt" THEN
      RAISE EXCEPTION 'PROJECT_MCP_CONNECTION_DELEGATION_AUDIT_ACTOR_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."action" IN ('rejected', 'revoked') THEN
    IF NEW."actorId" IS DISTINCT FROM delegation_row."terminalActorId"
       OR NEW."actorProjectMembershipId" IS DISTINCT FROM delegation_row."terminalActorProjectMembershipId"
       OR NEW."actorMembershipCreatedAt" IS DISTINCT FROM delegation_row."terminalActorMembershipCreatedAt" THEN
      RAISE EXCEPTION 'PROJECT_MCP_CONNECTION_DELEGATION_AUDIT_ACTOR_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."actorId" IS NOT NULL OR NEW."actorProjectMembershipId" IS NOT NULL OR NEW."actorMembershipCreatedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'PROJECT_MCP_CONNECTION_DELEGATION_AUDIT_ACTOR_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "PMCD_audit_insert_guard"
BEFORE INSERT ON "ProjectMcpConnectionDelegationAudit"
FOR EACH ROW EXECUTE FUNCTION "project_mcp_connection_delegation_audit_insert_guard"();

CREATE OR REPLACE FUNCTION "project_mcp_connection_delegation_audit_entity_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM "project_mcp_connection_delegation_validate_evidence"(NEW."delegationId");
  RETURN NEW;
END;
$$;

CREATE TRIGGER "PMCD_audit_entity_guard"
AFTER INSERT ON "ProjectMcpConnectionDelegationAudit"
FOR EACH ROW EXECUTE FUNCTION "project_mcp_connection_delegation_audit_entity_guard"();

CREATE OR REPLACE FUNCTION "project_mcp_connection_delegation_audit_immutable_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'PROJECT_MCP_CONNECTION_DELEGATION_AUDIT_IMMUTABLE' USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER "PMCD_audit_immutable_guard"
BEFORE UPDATE OR DELETE ON "ProjectMcpConnectionDelegationAudit"
FOR EACH ROW EXECUTE FUNCTION "project_mcp_connection_delegation_audit_immutable_guard"();

-- New grant audit rows carry a database-owned transaction snapshot. Historical
-- rows remain nullable and are never backfilled or rewritten.
CREATE OR REPLACE FUNCTION "project_mcp_tool_grant_audit_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  grant_row RECORD;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'project MCP tool grant audit is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1
       AND NOT EXISTS (
         SELECT 1 FROM "ProjectMcpToolGrant"
         WHERE "id" = OLD."grantId" AND "projectId" = OLD."projectId"
       ) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'project MCP tool grant audit is immutable' USING ERRCODE = 'check_violation';
  END IF;

  NEW."transactionId" := txid_current();
  SELECT grant_source.*, grant_source.xmin::text::bigint AS row_xmin
    INTO grant_row
  FROM "ProjectMcpToolGrant" AS grant_source
  WHERE grant_source."id" = NEW."grantId" AND grant_source."projectId" = NEW."projectId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'project MCP tool grant audit must match current grant' USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."event" = 'revoked' THEN
    IF grant_row."status" <> 'revoked' THEN
      RAISE EXCEPTION 'PROJECT_MCP_TOOL_GRANT_REVOKE_AUDIT_STATE_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    -- xmin stores the current transaction's low 32 bits; compare the same
    -- representation so transaction ID wrap/epoch does not cause a false
    -- mismatch with txid_current()'s full 64-bit value.
    IF grant_row.row_xmin <> mod(txid_current(), 4294967296::bigint) THEN
      RAISE EXCEPTION 'PROJECT_MCP_TOOL_GRANT_REVOKE_AUDIT_STATE_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."actorId" IS DISTINCT FROM grant_row."managedById" THEN
      RAISE EXCEPTION 'PROJECT_MCP_TOOL_GRANT_REVOKE_AUDIT_ACTOR_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM "ProjectMcpToolGrantAudit" AS existing
      WHERE existing."projectId" = NEW."projectId"
        AND existing."grantId" = NEW."grantId"
        AND existing."event" = 'revoked'
        AND existing."transactionId" = txid_current()
    ) THEN
      RAISE EXCEPTION 'PROJECT_MCP_TOOL_GRANT_REVOKE_AUDIT_DUPLICATE' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "McpToolDefinition" AS definition
    WHERE definition."id" = grant_row."toolDefinitionId"
      AND definition."connectionId" = grant_row."connectionId"
      AND definition."name" = grant_row."toolName"
      AND definition."definitionFingerprint" = NEW."definitionFingerprint"
  ) THEN
    RAISE EXCEPTION 'project MCP tool grant audit must match current grant' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "ProjectMcpToolGrantAudit_guard" ON "ProjectMcpToolGrantAudit";
CREATE TRIGGER "ProjectMcpToolGrantAudit_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "ProjectMcpToolGrantAudit"
FOR EACH ROW EXECUTE FUNCTION "project_mcp_tool_grant_audit_guard"();

CREATE OR REPLACE FUNCTION "project_mcp_tool_grant_revoke_audit_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  audit_count BIGINT;
BEGIN
  SELECT COUNT(*)
    INTO audit_count
  FROM "ProjectMcpToolGrantAudit" AS audit
  JOIN "McpToolDefinition" AS definition
    ON definition."id" = NEW."toolDefinitionId"
   AND definition."connectionId" = NEW."connectionId"
   AND definition."name" = NEW."toolName"
  WHERE audit."projectId" = NEW."projectId"
    AND audit."grantId" = NEW."id"
    AND audit."event" = 'revoked'
    AND audit."actorId" = NEW."managedById"
    AND audit."transactionId" = txid_current()
    AND audit."definitionFingerprint" = definition."definitionFingerprint";

  IF audit_count <> 1 THEN
    RAISE EXCEPTION 'PROJECT_MCP_TOOL_GRANT_REVOKE_AUDIT_REQUIRED' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "ProjectMcpToolGrant_revoke_audit_guard"
AFTER UPDATE OF "status" ON "ProjectMcpToolGrant"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (OLD."status" = 'active' AND NEW."status" = 'revoked')
EXECUTE FUNCTION "project_mcp_tool_grant_revoke_audit_guard"();

-- The legacy project MCP grant path remains closed.  Existing grants retain
-- their nullable future binding and may only be revoked; no legacy row is
-- backfilled or reactivated.
CREATE OR REPLACE FUNCTION "project_mcp_tool_grant_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() <= 1 THEN
      RAISE EXCEPTION 'PROJECT_MCP_TOOL_GRANT_DELETE_FORBIDDEN' USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    RAISE EXCEPTION 'PROJECT_MCP_TOOL_GRANT_INSERT_FROZEN' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" = 'revoked' THEN
    RAISE EXCEPTION 'PROJECT_MCP_TOOL_GRANT_REVOKED_IMMUTABLE' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."id" IS DISTINCT FROM NEW."id"
     OR OLD."projectId" IS DISTINCT FROM NEW."projectId"
     OR OLD."connectionId" IS DISTINCT FROM NEW."connectionId"
     OR OLD."toolName" IS DISTINCT FROM NEW."toolName"
     OR OLD."toolDefinitionId" IS DISTINCT FROM NEW."toolDefinitionId"
     OR OLD."attestationId" IS DISTINCT FROM NEW."attestationId"
     OR OLD."definitionFingerprint" IS DISTINCT FROM NEW."definitionFingerprint"
     OR OLD."networkFingerprint" IS DISTINCT FROM NEW."networkFingerprint"
     OR OLD."credentialFingerprint" IS DISTINCT FROM NEW."credentialFingerprint"
     OR OLD."acknowledgedAt" IS DISTINCT FROM NEW."acknowledgedAt"
     OR OLD."delegationId" IS DISTINCT FROM NEW."delegationId"
     OR OLD."createdAt" IS DISTINCT FROM NEW."createdAt" THEN
    RAISE EXCEPTION 'PROJECT_MCP_TOOL_GRANT_IDENTITY_IMMUTABLE' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."delegationId" IS NOT NULL OR OLD."delegationId" IS DISTINCT FROM NEW."delegationId" THEN
    RAISE EXCEPTION 'PROJECT_MCP_TOOL_GRANT_DELEGATION_FROZEN' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" = 'revoked' AND NEW."status" <> 'revoked' THEN
    RAISE EXCEPTION 'PROJECT_MCP_TOOL_GRANT_REACTIVATION_FORBIDDEN' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" = 'active' AND NEW."status" NOT IN ('active', 'revoked') THEN
    RAISE EXCEPTION 'PROJECT_MCP_TOOL_GRANT_STATE_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" = 'active' AND NEW."status" = 'active' THEN
    RAISE EXCEPTION 'PROJECT_MCP_TOOL_GRANT_ACTIVE_MUTATION_FORBIDDEN' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."attestationId" IS NULL AND (
      NEW."definitionFingerprint" IS NOT NULL
      OR NEW."networkFingerprint" IS NOT NULL
      OR NEW."credentialFingerprint" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'project MCP tool grant attestation snapshot is incomplete' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'active' THEN
    IF NEW."attestationId" IS NULL OR NOT EXISTS (
      SELECT 1
      FROM "McpToolAttestation" AS attestation
      JOIN "McpToolDefinition" AS definition
        ON definition."id" = attestation."toolDefinitionId"
       AND definition."connectionId" = attestation."connectionId"
       AND definition."name" = attestation."toolName"
      JOIN "McpConnection" AS connection
        ON connection."id" = attestation."connectionId"
      WHERE attestation."id" = NEW."attestationId"
        AND attestation."connectionId" = NEW."connectionId"
        AND attestation."toolName" = NEW."toolName"
        AND attestation."definitionFingerprint" = NEW."definitionFingerprint"
        AND attestation."networkFingerprint" = NEW."networkFingerprint"
        AND attestation."credentialFingerprint" = NEW."credentialFingerprint"
        AND definition."id" = NEW."toolDefinitionId"
        AND definition."current" = true
        AND connection."status" = 'verified'
        AND connection."resolvedAddressFingerprint" = NEW."networkFingerprint"
        AND NOT EXISTS (
          SELECT 1 FROM "McpToolAttestationAudit" AS revoked
          WHERE revoked."attestationId" = attestation."id" AND revoked."event" = 'revoked'
        )
    ) THEN
      RAISE EXCEPTION 'active project MCP tool grants require a current admin attestation' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "ProjectMcpToolGrant_guard" ON "ProjectMcpToolGrant";
CREATE TRIGGER "ProjectMcpToolGrant_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "ProjectMcpToolGrant"
FOR EACH ROW EXECUTE FUNCTION "project_mcp_tool_grant_guard"();

-- Trigger names are ordered so this exact capability is rejected before the
-- historical attestation guard.  Other ProjectAction capabilities retain the
-- existing behavior and UPDATE/DELETE remain untouched.
CREATE OR REPLACE FUNCTION "project_action_mcp_legacy_freeze_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."capability" = 'project.mcp.read-tool.invoke' THEN
    RAISE EXCEPTION 'PROJECT_MCP_ACTION_INSERT_FROZEN' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ProjectAction_mcp_00_legacy_freeze_guard"
BEFORE INSERT ON "ProjectAction"
FOR EACH ROW EXECUTE FUNCTION "project_action_mcp_legacy_freeze_guard"();
