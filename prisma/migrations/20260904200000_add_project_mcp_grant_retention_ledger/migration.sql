-- Durable, scalar lifecycle evidence for V2 project MCP grants.
--
-- The ledger deliberately has no foreign keys.  A project, connection, user,
-- or grant may be deleted only after its V2 grant evidence is complete, while
-- the scalar lifecycle record itself remains queryable after that deletion.

LOCK TABLE "Project", "ProjectMcpToolGrant", "ProjectMcpToolGrantAudit"
  IN SHARE ROW EXCLUSIVE MODE;

-- Existing V2 rows cannot be assigned a truthful creation transition after the
-- fact.  Refuse the upgrade rather than fabricating history or silently
-- backfilling a ledger entry.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "ProjectMcpToolGrant"
    WHERE "controlPlaneVersion" = 2
  ) THEN
    RAISE EXCEPTION 'PROJECT_MCP_GRANT_LEDGER_UPGRADE_PREFLIGHT_FAILED'
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

ALTER TABLE "ProjectMcpToolGrant"
  ADD COLUMN "creationTransactionId" BIGINT;

CREATE TYPE "ProjectMcpToolGrantLedgerEvent" AS ENUM ('granted', 'revoked');

CREATE TABLE "ProjectMcpToolGrantLedger" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "projectId" UUID NOT NULL,
  "grantId" UUID NOT NULL,
  "connectionId" UUID NOT NULL,
  "delegationId" UUID NOT NULL,
  "toolDefinitionId" UUID NOT NULL,
  "attestationId" UUID NOT NULL,
  "toolName" VARCHAR(128) NOT NULL,
  "controlPlaneVersion" INTEGER NOT NULL,
  "grantVersion" INTEGER NOT NULL,
  "event" "ProjectMcpToolGrantLedgerEvent" NOT NULL,
  "statusBefore" "ProjectMcpToolGrantStatus",
  "statusAfter" "ProjectMcpToolGrantStatus" NOT NULL,
  "actorId" UUID NOT NULL,
  "actorProjectMembershipId" UUID NOT NULL,
  "actorMembershipCreatedAt" TIMESTAMP(3) NOT NULL,
  "delegationVersion" INTEGER NOT NULL,
  "delegationFingerprint" CHAR(64) NOT NULL,
  "connectionConfigurationRevision" INTEGER NOT NULL,
  "grantorProjectMembershipId" UUID NOT NULL,
  "grantorMembershipCreatedAt" TIMESTAMP(3) NOT NULL,
  "revokerProjectMembershipId" UUID,
  "revokerMembershipCreatedAt" TIMESTAMP(3),
  "definitionFingerprint" CHAR(64) NOT NULL,
  "networkFingerprint" CHAR(64) NOT NULL,
  "credentialFingerprint" CHAR(64) NOT NULL,
  "acknowledgedAt" TIMESTAMP(3) NOT NULL,
  "transactionId" BIGINT NOT NULL DEFAULT txid_current(),
  "transitionAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ProjectMcpToolGrantLedger_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProjectMcpToolGrantLedger_shape_check" CHECK (
    "controlPlaneVersion" = 2
    AND "grantVersion" > 0
    AND "toolName" <> ''
    AND "delegationFingerprint" ~ '^[0-9a-f]{64}$'
    AND "connectionConfigurationRevision" > 0
    AND "definitionFingerprint" ~ '^[0-9a-f]{64}$'
    AND "networkFingerprint" ~ '^[0-9a-f]{64}$'
    AND "credentialFingerprint" ~ '^[0-9a-f]{64}$'
    AND (
      (
        "event" = 'granted'
        AND "grantVersion" = 1
        AND "statusBefore" IS NULL
        AND "statusAfter" = 'active'
        AND "revokerProjectMembershipId" IS NULL
        AND "revokerMembershipCreatedAt" IS NULL
      )
      OR (
        "event" = 'revoked'
        AND "grantVersion" = 2
        AND "statusBefore" = 'active'
        AND "statusAfter" = 'revoked'
        AND "revokerProjectMembershipId" IS NOT NULL
        AND "revokerMembershipCreatedAt" IS NOT NULL
      )
    )
  )
);

CREATE UNIQUE INDEX "ProjectMcpToolGrantLedger_grantId_grantVersion_key"
  ON "ProjectMcpToolGrantLedger"("grantId", "grantVersion");
CREATE INDEX "ProjectMcpToolGrantLedger_projectId_createdAt_idx"
  ON "ProjectMcpToolGrantLedger"("projectId", "createdAt");
CREATE INDEX "ProjectMcpToolGrantLedger_grantId_createdAt_idx"
  ON "ProjectMcpToolGrantLedger"("grantId", "createdAt");
CREATE INDEX "ProjectMcpToolGrantLedger_transactionId_createdAt_idx"
  ON "ProjectMcpToolGrantLedger"("transactionId", "createdAt");

ALTER TABLE "ProjectMcpToolGrant"
  ADD CONSTRAINT "ProjectMcpToolGrant_v2_creation_transaction_check" CHECK (
    "controlPlaneVersion" IS NULL
    OR (
      "controlPlaneVersion" = 2
      AND "creationTransactionId" IS NOT NULL
    )
  );

CREATE UNIQUE INDEX "ProjectMcpToolGrantAudit_v2_event_key"
  ON "ProjectMcpToolGrantAudit"("grantId", "event")
  WHERE "controlPlaneVersion" = 2;

CREATE OR REPLACE FUNCTION "project_mcp_tool_grant_v2_history_valid"(grant_row "ProjectMcpToolGrant")
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN COALESCE(
    grant_row."controlPlaneVersion" IS NOT NULL
    AND grant_row."controlPlaneVersion" = 2
    AND grant_row."status" IS NOT NULL
    AND grant_row."status" = 'active'
    AND grant_row."grantVersion" IS NOT NULL
    AND grant_row."grantVersion" > 0
    AND grant_row."creationTransactionId" IS NOT NULL
    AND grant_row."delegationId" IS NOT NULL
    AND grant_row."delegationVersion" IS NOT NULL
    AND grant_row."delegationVersion" > 0
    AND grant_row."delegationFingerprint" IS NOT NULL
    AND grant_row."delegationFingerprint" ~ '^[0-9a-f]{64}$'
    AND grant_row."connectionConfigurationRevision" IS NOT NULL
    AND grant_row."connectionConfigurationRevision" > 0
    AND grant_row."grantorProjectMembershipId" IS NOT NULL
    AND grant_row."grantorMembershipCreatedAt" IS NOT NULL
    AND grant_row."attestationId" IS NOT NULL
    AND grant_row."definitionFingerprint" IS NOT NULL
    AND grant_row."definitionFingerprint" ~ '^[0-9a-f]{64}$'
    AND grant_row."networkFingerprint" IS NOT NULL
    AND grant_row."networkFingerprint" ~ '^[0-9a-f]{64}$'
    AND grant_row."credentialFingerprint" IS NOT NULL
    AND grant_row."credentialFingerprint" ~ '^[0-9a-f]{64}$'
    AND grant_row."revokedById" IS NULL
    AND grant_row."revokedAt" IS NULL
    AND grant_row."revokerProjectMembershipId" IS NULL
    AND grant_row."revokerMembershipCreatedAt" IS NULL
    AND grant_row."revocationTransactionId" IS NULL,
    false
  );
END;
$$;

CREATE OR REPLACE FUNCTION "project_mcp_tool_grant_v2_create_evidence_valid"(grant_row "ProjectMcpToolGrant")
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN COALESCE(
    grant_row."controlPlaneVersion" = 2
    AND grant_row."creationTransactionId" IS NOT NULL
    AND (
      SELECT COUNT(*) = 1
      FROM "ProjectMcpToolGrantAudit" AS audit
      WHERE audit."projectId" = grant_row."projectId"
        AND audit."grantId" = grant_row."id"
        AND audit."event" = 'granted'
        AND audit."controlPlaneVersion" = 2
        AND audit."grantVersion" = 1
        AND audit."statusBefore" IS NULL
        AND audit."statusAfter" = 'active'
        AND audit."actorId" = grant_row."managedById"
        AND audit."grantorProjectMembershipId" = grant_row."grantorProjectMembershipId"
        AND audit."grantorMembershipCreatedAt" = grant_row."grantorMembershipCreatedAt"
        AND audit."revokerProjectMembershipId" IS NULL
        AND audit."revokerMembershipCreatedAt" IS NULL
        AND audit."delegationVersion" = grant_row."delegationVersion"
        AND audit."delegationFingerprint" = grant_row."delegationFingerprint"
        AND audit."connectionConfigurationRevision" = grant_row."connectionConfigurationRevision"
        AND audit."definitionFingerprint" = grant_row."definitionFingerprint"
        AND audit."details" = '{}'::jsonb
        AND audit."transactionId" = grant_row."creationTransactionId"
    )
    AND (
      SELECT COUNT(*) = 1
      FROM "ProjectMcpToolGrantLedger" AS ledger
      WHERE ledger."projectId" = grant_row."projectId"
        AND ledger."grantId" = grant_row."id"
        AND ledger."connectionId" = grant_row."connectionId"
        AND ledger."delegationId" = grant_row."delegationId"
        AND ledger."toolDefinitionId" = grant_row."toolDefinitionId"
        AND ledger."attestationId" = grant_row."attestationId"
        AND ledger."toolName" = grant_row."toolName"
        AND ledger."controlPlaneVersion" = 2
        AND ledger."grantVersion" = 1
        AND ledger."event" = 'granted'
        AND ledger."statusBefore" IS NULL
        AND ledger."statusAfter" = 'active'
        AND ledger."actorId" = grant_row."managedById"
        AND ledger."actorProjectMembershipId" = grant_row."grantorProjectMembershipId"
        AND ledger."actorMembershipCreatedAt" = grant_row."grantorMembershipCreatedAt"
        AND ledger."delegationVersion" = grant_row."delegationVersion"
        AND ledger."delegationFingerprint" = grant_row."delegationFingerprint"
        AND ledger."connectionConfigurationRevision" = grant_row."connectionConfigurationRevision"
        AND ledger."grantorProjectMembershipId" = grant_row."grantorProjectMembershipId"
        AND ledger."grantorMembershipCreatedAt" = grant_row."grantorMembershipCreatedAt"
        AND ledger."revokerProjectMembershipId" IS NULL
        AND ledger."revokerMembershipCreatedAt" IS NULL
        AND ledger."definitionFingerprint" = grant_row."definitionFingerprint"
        AND ledger."networkFingerprint" = grant_row."networkFingerprint"
        AND ledger."credentialFingerprint" = grant_row."credentialFingerprint"
        AND ledger."acknowledgedAt" = grant_row."acknowledgedAt"
        AND ledger."transactionId" = grant_row."creationTransactionId"
        AND ledger."transitionAt" IS NOT NULL
        AND ledger."createdAt" IS NOT NULL
    ),
    false
  );
END;
$$;

CREATE OR REPLACE FUNCTION "project_mcp_tool_grant_v2_revoke_evidence_valid"(grant_row "ProjectMcpToolGrant")
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN COALESCE(
    grant_row."controlPlaneVersion" = 2
    AND grant_row."status" = 'revoked'
    AND grant_row."grantVersion" = 2
    AND grant_row."creationTransactionId" IS NOT NULL
    AND grant_row."revocationTransactionId" IS NOT NULL
    AND (
      SELECT COUNT(*) = 1
      FROM "ProjectMcpToolGrantAudit" AS audit
      WHERE audit."projectId" = grant_row."projectId"
        AND audit."grantId" = grant_row."id"
        AND audit."event" = 'revoked'
        AND audit."controlPlaneVersion" = 2
        AND audit."grantVersion" = 2
        AND audit."statusBefore" = 'active'
        AND audit."statusAfter" = 'revoked'
        AND audit."actorId" = grant_row."revokedById"
        AND audit."grantorProjectMembershipId" = grant_row."grantorProjectMembershipId"
        AND audit."grantorMembershipCreatedAt" = grant_row."grantorMembershipCreatedAt"
        AND audit."revokerProjectMembershipId" = grant_row."revokerProjectMembershipId"
        AND audit."revokerMembershipCreatedAt" = grant_row."revokerMembershipCreatedAt"
        AND audit."delegationVersion" = grant_row."delegationVersion"
        AND audit."delegationFingerprint" = grant_row."delegationFingerprint"
        AND audit."connectionConfigurationRevision" = grant_row."connectionConfigurationRevision"
        AND audit."definitionFingerprint" = grant_row."definitionFingerprint"
        AND audit."details" = '{}'::jsonb
        AND audit."transactionId" = grant_row."revocationTransactionId"
    )
    AND (
      SELECT COUNT(*) = 1
      FROM "ProjectMcpToolGrantLedger" AS ledger
      WHERE ledger."projectId" = grant_row."projectId"
        AND ledger."grantId" = grant_row."id"
        AND ledger."connectionId" = grant_row."connectionId"
        AND ledger."delegationId" = grant_row."delegationId"
        AND ledger."toolDefinitionId" = grant_row."toolDefinitionId"
        AND ledger."attestationId" = grant_row."attestationId"
        AND ledger."toolName" = grant_row."toolName"
        AND ledger."controlPlaneVersion" = 2
        AND ledger."grantVersion" = 2
        AND ledger."event" = 'revoked'
        AND ledger."statusBefore" = 'active'
        AND ledger."statusAfter" = 'revoked'
        AND ledger."actorId" = grant_row."revokedById"
        AND ledger."actorProjectMembershipId" = grant_row."revokerProjectMembershipId"
        AND ledger."actorMembershipCreatedAt" = grant_row."revokerMembershipCreatedAt"
        AND ledger."delegationVersion" = grant_row."delegationVersion"
        AND ledger."delegationFingerprint" = grant_row."delegationFingerprint"
        AND ledger."connectionConfigurationRevision" = grant_row."connectionConfigurationRevision"
        AND ledger."grantorProjectMembershipId" = grant_row."grantorProjectMembershipId"
        AND ledger."grantorMembershipCreatedAt" = grant_row."grantorMembershipCreatedAt"
        AND ledger."revokerProjectMembershipId" = grant_row."revokerProjectMembershipId"
        AND ledger."revokerMembershipCreatedAt" = grant_row."revokerMembershipCreatedAt"
        AND ledger."definitionFingerprint" = grant_row."definitionFingerprint"
        AND ledger."networkFingerprint" = grant_row."networkFingerprint"
        AND ledger."credentialFingerprint" = grant_row."credentialFingerprint"
        AND ledger."acknowledgedAt" = grant_row."acknowledgedAt"
        AND ledger."transactionId" = grant_row."revocationTransactionId"
        AND ledger."transitionAt" IS NOT NULL
        AND ledger."createdAt" IS NOT NULL
    ),
    false
  );
END;
$$;

CREATE OR REPLACE FUNCTION "project_mcp_tool_grant_v2_retention_complete"(grant_row "ProjectMcpToolGrant")
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN COALESCE(
    grant_row."controlPlaneVersion" = 2
    AND grant_row."status" = 'revoked'
    AND "project_mcp_tool_grant_v2_create_evidence_valid"(grant_row)
    AND "project_mcp_tool_grant_v2_revoke_evidence_valid"(grant_row)
    AND (
      SELECT COUNT(*) = 2
      FROM "ProjectMcpToolGrantAudit" AS audit
      WHERE audit."projectId" = grant_row."projectId"
        AND audit."grantId" = grant_row."id"
        AND audit."controlPlaneVersion" = 2
    )
    AND (
      SELECT COUNT(*) = 2
      FROM "ProjectMcpToolGrantLedger" AS ledger
      WHERE ledger."projectId" = grant_row."projectId"
        AND ledger."grantId" = grant_row."id"
    ),
    false
  );
END;
$$;

CREATE OR REPLACE FUNCTION "project_mcp_tool_grant_ledger_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  grant_row RECORD;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'PROJECT_MCP_TOOL_GRANT_LEDGER_IMMUTABLE' USING ERRCODE = 'check_violation';
  END IF;

  SELECT source.* INTO grant_row
  FROM "ProjectMcpToolGrant" AS source
  WHERE source."id" = NEW."grantId"
    AND source."projectId" = NEW."projectId";
  IF NOT FOUND OR grant_row."controlPlaneVersion" IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'PROJECT_MCP_TOOL_GRANT_LEDGER_GRANT_INVALID' USING ERRCODE = 'check_violation';
  END IF;

  NEW."transactionId" := txid_current();
  NEW."transitionAt" := clock_timestamp();
  NEW."createdAt" := clock_timestamp();

  IF NEW."event" = 'granted' THEN
    IF grant_row."status" <> 'active'
       OR grant_row."grantVersion" <> 1
       OR grant_row."creationTransactionId" <> txid_current()
       OR NEW."actorId" IS DISTINCT FROM grant_row."managedById"
       OR NEW."actorProjectMembershipId" IS DISTINCT FROM grant_row."grantorProjectMembershipId"
       OR NEW."actorMembershipCreatedAt" IS DISTINCT FROM grant_row."grantorMembershipCreatedAt"
       OR NEW."statusBefore" IS NOT NULL
       OR NEW."statusAfter" IS DISTINCT FROM 'active'::"ProjectMcpToolGrantStatus" THEN
      RAISE EXCEPTION 'PROJECT_MCP_TOOL_GRANT_CREATE_LEDGER_STATE_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."event" = 'revoked' THEN
    IF grant_row."status" <> 'revoked'
       OR grant_row."grantVersion" <> 2
       OR grant_row."revocationTransactionId" <> txid_current()
       OR NEW."actorId" IS DISTINCT FROM grant_row."revokedById"
       OR NEW."actorProjectMembershipId" IS DISTINCT FROM grant_row."revokerProjectMembershipId"
       OR NEW."actorMembershipCreatedAt" IS DISTINCT FROM grant_row."revokerMembershipCreatedAt"
       OR NEW."statusBefore" IS DISTINCT FROM 'active'::"ProjectMcpToolGrantStatus"
       OR NEW."statusAfter" IS DISTINCT FROM 'revoked'::"ProjectMcpToolGrantStatus" THEN
      RAISE EXCEPTION 'PROJECT_MCP_TOOL_GRANT_REVOKE_LEDGER_STATE_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    RAISE EXCEPTION 'PROJECT_MCP_TOOL_GRANT_LEDGER_EVENT_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ProjectMcpToolGrantLedger_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "ProjectMcpToolGrantLedger"
FOR EACH ROW EXECUTE FUNCTION "project_mcp_tool_grant_ledger_guard"();

DROP TRIGGER IF EXISTS "ProjectMcpToolGrant_guard" ON "ProjectMcpToolGrant";

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
    IF NEW."controlPlaneVersion" IS DISTINCT FROM 2 THEN
      RAISE EXCEPTION 'PROJECT_MCP_TOOL_GRANT_INSERT_FROZEN' USING ERRCODE = 'check_violation';
    END IF;
    NEW."creationTransactionId" := txid_current();
    NEW."acknowledgedAt" := clock_timestamp();
    NEW."createdAt" := clock_timestamp();
    NEW."updatedAt" := clock_timestamp();
    IF NEW."status" IS DISTINCT FROM 'active'
       OR NEW."grantVersion" IS DISTINCT FROM 1
       OR NOT "project_mcp_tool_grant_v2_tuple_valid"(NEW) THEN
      RAISE EXCEPTION 'PROJECT_MCP_TOOL_GRANT_TUPLE_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."controlPlaneVersion" = 2 OR NEW."controlPlaneVersion" = 2 THEN
    IF OLD."controlPlaneVersion" IS DISTINCT FROM 2 OR NEW."controlPlaneVersion" IS DISTINCT FROM 2 THEN
      RAISE EXCEPTION 'PROJECT_MCP_TOOL_GRANT_V2_VERSION_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'revoked' THEN
      RAISE EXCEPTION 'PROJECT_MCP_TOOL_GRANT_REVOKED_IMMUTABLE' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."id" IS DISTINCT FROM NEW."id"
       OR OLD."projectId" IS DISTINCT FROM NEW."projectId"
       OR OLD."connectionId" IS DISTINCT FROM NEW."connectionId"
       OR OLD."delegationId" IS DISTINCT FROM NEW."delegationId"
       OR OLD."toolName" IS DISTINCT FROM NEW."toolName"
       OR OLD."toolDefinitionId" IS DISTINCT FROM NEW."toolDefinitionId"
       OR OLD."attestationId" IS DISTINCT FROM NEW."attestationId"
       OR OLD."definitionFingerprint" IS DISTINCT FROM NEW."definitionFingerprint"
       OR OLD."networkFingerprint" IS DISTINCT FROM NEW."networkFingerprint"
       OR OLD."credentialFingerprint" IS DISTINCT FROM NEW."credentialFingerprint"
       OR OLD."delegationVersion" IS DISTINCT FROM NEW."delegationVersion"
       OR OLD."delegationFingerprint" IS DISTINCT FROM NEW."delegationFingerprint"
       OR OLD."connectionConfigurationRevision" IS DISTINCT FROM NEW."connectionConfigurationRevision"
       OR OLD."grantorProjectMembershipId" IS DISTINCT FROM NEW."grantorProjectMembershipId"
       OR OLD."grantorMembershipCreatedAt" IS DISTINCT FROM NEW."grantorMembershipCreatedAt"
       OR OLD."managedById" IS DISTINCT FROM NEW."managedById"
       OR OLD."acknowledgedAt" IS DISTINCT FROM NEW."acknowledgedAt"
       OR OLD."creationTransactionId" IS DISTINCT FROM NEW."creationTransactionId"
       OR OLD."createdAt" IS DISTINCT FROM NEW."createdAt" THEN
      RAISE EXCEPTION 'PROJECT_MCP_TOOL_GRANT_V2_IDENTITY_IMMUTABLE' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" <> 'active' OR NEW."status" <> 'revoked'
       OR NEW."grantVersion" <> OLD."grantVersion" + 1 THEN
      RAISE EXCEPTION 'PROJECT_MCP_TOOL_GRANT_V2_STATE_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT "project_mcp_tool_grant_v2_history_valid"(OLD) THEN
      RAISE EXCEPTION 'PROJECT_MCP_TOOL_GRANT_V2_TUPLE_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."revokedById" IS NULL OR NEW."revokerProjectMembershipId" IS NULL OR NEW."revokerMembershipCreatedAt" IS NULL THEN
      RAISE EXCEPTION 'PROJECT_MCP_TOOL_GRANT_V2_REVOKER_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM "ProjectMembership" AS membership
      JOIN "AppUser" AS actor ON actor."id" = membership."userId"
      WHERE membership."id" = NEW."revokerProjectMembershipId"
        AND membership."projectId" = NEW."projectId"
        AND membership."role" = 'owner'
        AND membership."accessState" = 'confirmed'
        AND membership."createdAt" = NEW."revokerMembershipCreatedAt"
        AND actor."id" = NEW."revokedById"
        AND actor."disabledAt" IS NULL
    ) THEN
      RAISE EXCEPTION 'PROJECT_MCP_TOOL_GRANT_V2_REVOKER_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    NEW."revokedAt" := clock_timestamp();
    NEW."revocationTransactionId" := txid_current();
    NEW."updatedAt" := clock_timestamp();
    RETURN NEW;
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
     OR OLD."createdAt" IS DISTINCT FROM NEW."createdAt"
     OR OLD."controlPlaneVersion" IS DISTINCT FROM NEW."controlPlaneVersion"
     OR OLD."grantVersion" IS DISTINCT FROM NEW."grantVersion"
     OR OLD."delegationVersion" IS DISTINCT FROM NEW."delegationVersion"
     OR OLD."delegationFingerprint" IS DISTINCT FROM NEW."delegationFingerprint"
     OR OLD."connectionConfigurationRevision" IS DISTINCT FROM NEW."connectionConfigurationRevision"
     OR OLD."grantorProjectMembershipId" IS DISTINCT FROM NEW."grantorProjectMembershipId"
     OR OLD."grantorMembershipCreatedAt" IS DISTINCT FROM NEW."grantorMembershipCreatedAt"
     OR OLD."creationTransactionId" IS DISTINCT FROM NEW."creationTransactionId" THEN
    RAISE EXCEPTION 'PROJECT_MCP_TOOL_GRANT_IDENTITY_IMMUTABLE' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."delegationId" IS NOT NULL OR OLD."delegationId" IS DISTINCT FROM NEW."delegationId" THEN
    RAISE EXCEPTION 'PROJECT_MCP_TOOL_GRANT_DELEGATION_FROZEN' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" = 'active' AND NEW."status" = 'active' THEN
    RAISE EXCEPTION 'PROJECT_MCP_TOOL_GRANT_ACTIVE_MUTATION_FORBIDDEN' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" = 'active' AND NEW."status" <> 'revoked' THEN
    RAISE EXCEPTION 'PROJECT_MCP_TOOL_GRANT_STATE_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."attestationId" IS NULL AND (
      NEW."definitionFingerprint" IS NOT NULL
      OR NEW."networkFingerprint" IS NOT NULL
      OR NEW."credentialFingerprint" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'project MCP tool grant attestation snapshot is incomplete' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" = 'active' AND NEW."status" = 'revoked' THEN
    IF OLD."revocationTransactionId" IS NOT NULL THEN
      RAISE EXCEPTION 'PROJECT_MCP_TOOL_GRANT_STATE_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    NEW."revokedById" := NEW."managedById";
    NEW."revokedAt" := clock_timestamp();
    NEW."revocationTransactionId" := txid_current();
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

CREATE TRIGGER "ProjectMcpToolGrant_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "ProjectMcpToolGrant"
FOR EACH ROW EXECUTE FUNCTION "project_mcp_tool_grant_guard"();

DROP TRIGGER IF EXISTS "ProjectMcpToolGrantAudit_guard" ON "ProjectMcpToolGrantAudit";

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

  SELECT grant_source.* INTO grant_row
  FROM "ProjectMcpToolGrant" AS grant_source
  WHERE grant_source."id" = NEW."grantId" AND grant_source."projectId" = NEW."projectId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'project MCP tool grant audit must match current grant' USING ERRCODE = 'check_violation';
  END IF;

  NEW."transactionId" := txid_current();
  IF grant_row."controlPlaneVersion" = 2 THEN
    NEW."createdAt" := clock_timestamp();
    IF NEW."details" <> '{}'::jsonb OR NEW."controlPlaneVersion" IS DISTINCT FROM 2 THEN
      RAISE EXCEPTION 'PROJECT_MCP_TOOL_GRANT_AUDIT_DETAILS_FORBIDDEN' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."event" = 'granted' THEN
      IF grant_row."status" <> 'active'
         OR grant_row."grantVersion" <> 1
         OR grant_row."creationTransactionId" <> txid_current()
         OR NEW."actorId" IS DISTINCT FROM grant_row."managedById"
         OR NEW."grantVersion" IS DISTINCT FROM 1
         OR NEW."statusBefore" IS NOT NULL
         OR NEW."statusAfter" IS DISTINCT FROM 'active'::"ProjectMcpToolGrantStatus"
         OR NEW."definitionFingerprint" IS DISTINCT FROM grant_row."definitionFingerprint"
         OR NEW."delegationVersion" IS DISTINCT FROM grant_row."delegationVersion"
         OR NEW."delegationFingerprint" IS DISTINCT FROM grant_row."delegationFingerprint"
         OR NEW."connectionConfigurationRevision" IS DISTINCT FROM grant_row."connectionConfigurationRevision"
         OR NEW."grantorProjectMembershipId" IS DISTINCT FROM grant_row."grantorProjectMembershipId"
         OR NEW."grantorMembershipCreatedAt" IS DISTINCT FROM grant_row."grantorMembershipCreatedAt"
         OR NEW."revokerProjectMembershipId" IS NOT NULL
         OR NEW."revokerMembershipCreatedAt" IS NOT NULL THEN
        RAISE EXCEPTION 'PROJECT_MCP_TOOL_GRANT_CREATE_AUDIT_STATE_INVALID' USING ERRCODE = 'check_violation';
      END IF;
    ELSIF NEW."event" = 'revoked' THEN
      IF grant_row."status" <> 'revoked'
         OR grant_row."grantVersion" <> 2
         OR grant_row."revocationTransactionId" <> txid_current()
         OR NEW."actorId" IS DISTINCT FROM grant_row."revokedById"
         OR NEW."grantVersion" IS DISTINCT FROM grant_row."grantVersion"
         OR NEW."statusBefore" IS DISTINCT FROM 'active'::"ProjectMcpToolGrantStatus"
         OR NEW."statusAfter" IS DISTINCT FROM 'revoked'::"ProjectMcpToolGrantStatus"
         OR NEW."definitionFingerprint" IS DISTINCT FROM grant_row."definitionFingerprint"
         OR NEW."delegationVersion" IS DISTINCT FROM grant_row."delegationVersion"
         OR NEW."delegationFingerprint" IS DISTINCT FROM grant_row."delegationFingerprint"
         OR NEW."connectionConfigurationRevision" IS DISTINCT FROM grant_row."connectionConfigurationRevision"
         OR NEW."grantorProjectMembershipId" IS DISTINCT FROM grant_row."grantorProjectMembershipId"
         OR NEW."grantorMembershipCreatedAt" IS DISTINCT FROM grant_row."grantorMembershipCreatedAt"
         OR NEW."revokerProjectMembershipId" IS DISTINCT FROM grant_row."revokerProjectMembershipId"
         OR NEW."revokerMembershipCreatedAt" IS DISTINCT FROM grant_row."revokerMembershipCreatedAt" THEN
        RAISE EXCEPTION 'PROJECT_MCP_TOOL_GRANT_REVOKE_AUDIT_STATE_INVALID' USING ERRCODE = 'check_violation';
      END IF;
    ELSE
      RAISE EXCEPTION 'PROJECT_MCP_TOOL_GRANT_AUDIT_EVENT_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW."controlPlaneVersion" IS NOT NULL THEN
      RAISE EXCEPTION 'PROJECT_MCP_TOOL_GRANT_AUDIT_VERSION_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    IF grant_row."status" <> 'revoked' OR grant_row."revocationTransactionId" <> txid_current() THEN
      IF NEW."event" = 'revoked' THEN
        RAISE EXCEPTION 'PROJECT_MCP_TOOL_GRANT_REVOKE_AUDIT_STATE_INVALID' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF NEW."event" = 'revoked' THEN
      IF NEW."actorId" IS DISTINCT FROM grant_row."managedById"
         OR grant_row."revokedById" IS DISTINCT FROM grant_row."managedById" THEN
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
  END IF;

  IF grant_row."controlPlaneVersion" IS DISTINCT FROM 2 AND NOT EXISTS (
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

CREATE TRIGGER "ProjectMcpToolGrantAudit_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "ProjectMcpToolGrantAudit"
FOR EACH ROW EXECUTE FUNCTION "project_mcp_tool_grant_audit_guard"();

CREATE OR REPLACE FUNCTION "project_mcp_tool_grant_create_evidence_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."status" IS DISTINCT FROM 'active'
     OR NEW."grantVersion" IS DISTINCT FROM 1
     OR NOT "project_mcp_tool_grant_v2_create_evidence_valid"(NEW) THEN
    RAISE EXCEPTION 'PROJECT_MCP_TOOL_GRANT_CREATE_EVIDENCE_REQUIRED' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "ProjectMcpToolGrant_create_evidence_guard"
AFTER INSERT ON "ProjectMcpToolGrant"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (NEW."controlPlaneVersion" = 2)
EXECUTE FUNCTION "project_mcp_tool_grant_create_evidence_guard"();

CREATE OR REPLACE FUNCTION "project_mcp_tool_grant_revoke_audit_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  audit_count BIGINT;
BEGIN
  IF NEW."controlPlaneVersion" = 2 THEN
    SELECT COUNT(*) INTO audit_count
    FROM "ProjectMcpToolGrantAudit" AS audit
    WHERE audit."projectId" = NEW."projectId"
      AND audit."grantId" = NEW."id"
      AND audit."event" = 'revoked'
      AND audit."actorId" IS NOT DISTINCT FROM NEW."revokedById"
      AND audit."transactionId" = txid_current()
      AND audit."definitionFingerprint" = NEW."definitionFingerprint"
      AND audit."controlPlaneVersion" = 2
      AND audit."grantVersion" = NEW."grantVersion"
      AND audit."statusBefore" = 'active'
      AND audit."statusAfter" = 'revoked'
      AND audit."delegationVersion" = NEW."delegationVersion"
      AND audit."delegationFingerprint" = NEW."delegationFingerprint"
      AND audit."connectionConfigurationRevision" = NEW."connectionConfigurationRevision"
      AND audit."grantorProjectMembershipId" = NEW."grantorProjectMembershipId"
      AND audit."grantorMembershipCreatedAt" = NEW."grantorMembershipCreatedAt"
      AND audit."revokerProjectMembershipId" = NEW."revokerProjectMembershipId"
      AND audit."revokerMembershipCreatedAt" = NEW."revokerMembershipCreatedAt";
    IF audit_count <> 1 THEN
      RAISE EXCEPTION 'PROJECT_MCP_TOOL_GRANT_REVOKE_AUDIT_REQUIRED' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT "project_mcp_tool_grant_v2_revoke_evidence_valid"(NEW) THEN
      RAISE EXCEPTION 'PROJECT_MCP_TOOL_GRANT_REVOKE_EVIDENCE_REQUIRED' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  SELECT COUNT(*) INTO audit_count
  FROM "ProjectMcpToolGrantAudit" AS audit
  JOIN "McpToolDefinition" AS definition
    ON definition."id" = NEW."toolDefinitionId"
   AND definition."connectionId" = NEW."connectionId"
   AND definition."name" = NEW."toolName"
  WHERE audit."projectId" = NEW."projectId"
    AND audit."grantId" = NEW."id"
    AND audit."event" = 'revoked'
    AND audit."actorId" IS NOT DISTINCT FROM NEW."revokedById"
    AND audit."transactionId" = txid_current()
    AND audit."definitionFingerprint" = definition."definitionFingerprint";
  IF audit_count <> 1 THEN
    RAISE EXCEPTION 'PROJECT_MCP_TOOL_GRANT_REVOKE_AUDIT_REQUIRED' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "ProjectMcpToolGrant_revoke_audit_guard" ON "ProjectMcpToolGrant";
CREATE CONSTRAINT TRIGGER "ProjectMcpToolGrant_revoke_audit_guard"
AFTER UPDATE OF "status" ON "ProjectMcpToolGrant"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (OLD."status" = 'active' AND NEW."status" = 'revoked')
EXECUTE FUNCTION "project_mcp_tool_grant_revoke_audit_guard"();

CREATE OR REPLACE FUNCTION "project_mcp_tool_grant_project_delete_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "ProjectMcpToolGrant" AS grant_row
    WHERE grant_row."projectId" = OLD."id"
      AND grant_row."controlPlaneVersion" = 2
      AND grant_row."status" = 'active'
  ) THEN
    RAISE EXCEPTION 'PROJECT_MCP_GRANT_RETENTION_REQUIRED' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM "ProjectMcpToolGrant" AS grant_row
    WHERE grant_row."projectId" = OLD."id"
      AND grant_row."controlPlaneVersion" = 2
      AND NOT "project_mcp_tool_grant_v2_retention_complete"(grant_row)
  ) THEN
    RAISE EXCEPTION 'PROJECT_MCP_GRANT_RETENTION_REQUIRED' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM "ProjectMcpToolGrantLedger" AS ledger
    WHERE ledger."projectId" = OLD."id"
      AND NOT EXISTS (
        SELECT 1
        FROM "ProjectMcpToolGrant" AS grant_row
        WHERE grant_row."id" = ledger."grantId"
          AND grant_row."projectId" = ledger."projectId"
          AND grant_row."controlPlaneVersion" = 2
          AND "project_mcp_tool_grant_v2_retention_complete"(grant_row)
      )
  ) THEN
    RAISE EXCEPTION 'PROJECT_MCP_GRANT_RETENTION_REQUIRED' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM "ProjectMcpToolGrantAudit" AS audit
    WHERE audit."projectId" = OLD."id"
      AND audit."controlPlaneVersion" = 2
      AND NOT EXISTS (
        SELECT 1
        FROM "ProjectMcpToolGrant" AS grant_row
        WHERE grant_row."id" = audit."grantId"
          AND grant_row."projectId" = audit."projectId"
          AND grant_row."controlPlaneVersion" = 2
          AND "project_mcp_tool_grant_v2_retention_complete"(grant_row)
      )
  ) THEN
    RAISE EXCEPTION 'PROJECT_MCP_GRANT_RETENTION_REQUIRED' USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS "Project_mcp_grant_project_delete_guard" ON "Project";
CREATE TRIGGER "Project_mcp_grant_project_delete_guard"
BEFORE DELETE ON "Project"
FOR EACH ROW EXECUTE FUNCTION "project_mcp_tool_grant_project_delete_guard"();
