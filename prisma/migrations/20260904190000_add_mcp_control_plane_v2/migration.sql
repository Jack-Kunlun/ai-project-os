-- MCP control-plane V2 durability upgrade.
--
-- This migration replaces the legacy grant revoke proof that depended on a
-- physical row-version marker with a database-owned durable transaction marker.  V1 rows
-- remain nullable, frozen historical data; no business row is backfilled or
-- rewritten.  V2 attestation/grant fields are control-plane-only and do not
-- enable the project MCP action or runtime.

LOCK TABLE "ProjectMcpToolGrant", "ProjectMcpToolGrantAudit", "McpToolAttestation", "McpToolAttestationAudit",
  "ProjectMcpConnectionDelegation", "ProjectMembership", "McpConnection", "McpToolDefinition", "AppUser"
  IN SHARE ROW EXCLUSIVE MODE;

CREATE TYPE "McpToolAttestationStatus" AS ENUM ('active', 'revoked');

ALTER TABLE "ProjectMcpToolGrant"
  ADD COLUMN "controlPlaneVersion" INTEGER,
  ADD COLUMN "grantVersion" INTEGER,
  ADD COLUMN "delegationVersion" INTEGER,
  ADD COLUMN "delegationFingerprint" CHAR(64),
  ADD COLUMN "connectionConfigurationRevision" INTEGER,
  ADD COLUMN "grantorProjectMembershipId" UUID,
  ADD COLUMN "grantorMembershipCreatedAt" TIMESTAMP(3),
  ADD COLUMN "revokedById" UUID,
  ADD COLUMN "revokerProjectMembershipId" UUID,
  ADD COLUMN "revokerMembershipCreatedAt" TIMESTAMP(3),
  ADD COLUMN "revocationTransactionId" BIGINT;

ALTER TABLE "McpToolAttestation"
  ADD COLUMN "controlPlaneVersion" INTEGER,
  ADD COLUMN "status" "McpToolAttestationStatus",
  ADD COLUMN "version" INTEGER,
  ADD COLUMN "conclusion" VARCHAR(32),
  ADD COLUMN "riskLevel" VARCHAR(16),
  ADD COLUMN "evidenceNote" VARCHAR(500),
  ADD COLUMN "connectionConfigurationRevision" INTEGER,
  ADD COLUMN "revokedById" UUID,
  ADD COLUMN "revokedAt" TIMESTAMP(3),
  ADD COLUMN "revocationTransactionId" BIGINT;

ALTER TABLE "McpToolAttestationAudit"
  ADD COLUMN "controlPlaneVersion" INTEGER,
  ADD COLUMN "attestationVersion" INTEGER,
  ADD COLUMN "statusBefore" "McpToolAttestationStatus",
  ADD COLUMN "statusAfter" "McpToolAttestationStatus",
  ADD COLUMN "connectionConfigurationRevision" INTEGER,
  ADD COLUMN "transactionId" BIGINT;

ALTER TABLE "ProjectMcpToolGrantAudit"
  ADD COLUMN "controlPlaneVersion" INTEGER,
  ADD COLUMN "grantVersion" INTEGER,
  ADD COLUMN "statusBefore" "ProjectMcpToolGrantStatus",
  ADD COLUMN "statusAfter" "ProjectMcpToolGrantStatus",
  ADD COLUMN "delegationVersion" INTEGER,
  ADD COLUMN "delegationFingerprint" CHAR(64),
  ADD COLUMN "connectionConfigurationRevision" INTEGER,
  ADD COLUMN "grantorProjectMembershipId" UUID,
  ADD COLUMN "grantorMembershipCreatedAt" TIMESTAMP(3),
  ADD COLUMN "revokerProjectMembershipId" UUID,
  ADD COLUMN "revokerMembershipCreatedAt" TIMESTAMP(3);

ALTER TABLE "ProjectMcpToolGrant"
  ADD CONSTRAINT "ProjectMcpToolGrant_v2_shape_check" CHECK (
    (
      "controlPlaneVersion" IS NULL
      AND "grantVersion" IS NULL
      AND "delegationVersion" IS NULL
      AND "delegationFingerprint" IS NULL
      AND "connectionConfigurationRevision" IS NULL
      AND "grantorProjectMembershipId" IS NULL
      AND "grantorMembershipCreatedAt" IS NULL
      AND (
        ("status" = 'active' AND "revokedById" IS NULL AND "revokerProjectMembershipId" IS NULL AND "revokerMembershipCreatedAt" IS NULL AND "revocationTransactionId" IS NULL)
        OR ("status" = 'revoked' AND (
          ("revokedById" IS NULL AND "revokerProjectMembershipId" IS NULL AND "revokerMembershipCreatedAt" IS NULL AND "revocationTransactionId" IS NULL)
          OR ("revokedById" IS NOT NULL AND "revokerProjectMembershipId" IS NULL AND "revokerMembershipCreatedAt" IS NULL AND "revocationTransactionId" IS NOT NULL)
        ))
      )
    )
    OR (
      "controlPlaneVersion" IS NOT NULL
      AND "controlPlaneVersion" = 2
      AND "status" IS NOT NULL
      AND "delegationId" IS NOT NULL
      AND "attestationId" IS NOT NULL
      AND "definitionFingerprint" IS NOT NULL
      AND "networkFingerprint" IS NOT NULL
      AND "credentialFingerprint" IS NOT NULL
      AND "grantVersion" IS NOT NULL
      AND "grantVersion" > 0
      AND "delegationVersion" IS NOT NULL
      AND "delegationVersion" > 0
      AND "delegationFingerprint" IS NOT NULL
      AND "delegationFingerprint" ~ '^[0-9a-f]{64}$'
      AND "connectionConfigurationRevision" IS NOT NULL
      AND "connectionConfigurationRevision" > 0
      AND "grantorProjectMembershipId" IS NOT NULL
      AND "grantorMembershipCreatedAt" IS NOT NULL
      AND (
        ("status" = 'active' AND "revokedAt" IS NULL AND "revokedById" IS NULL AND "revokerProjectMembershipId" IS NULL AND "revokerMembershipCreatedAt" IS NULL AND "revocationTransactionId" IS NULL)
        OR ("status" = 'revoked' AND "revokedAt" IS NOT NULL AND "revokedById" IS NOT NULL AND "revokerProjectMembershipId" IS NOT NULL AND "revokerMembershipCreatedAt" IS NOT NULL AND "revocationTransactionId" IS NOT NULL)
      )
    )
  ),
  ADD CONSTRAINT "ProjectMcpToolGrant_v2_fingerprint_check" CHECK (
    "controlPlaneVersion" IS NULL
    OR (
      "controlPlaneVersion" IS NOT NULL
      AND "controlPlaneVersion" = 2
      AND "definitionFingerprint" IS NOT NULL
      AND "definitionFingerprint" ~ '^[0-9a-f]{64}$'
      AND "networkFingerprint" IS NOT NULL
      AND "networkFingerprint" ~ '^[0-9a-f]{64}$'
      AND "credentialFingerprint" IS NOT NULL
      AND "credentialFingerprint" ~ '^[0-9a-f]{64}$'
    )
  );

ALTER TABLE "McpToolAttestation"
  ADD CONSTRAINT "McpToolAttestation_v2_shape_check" CHECK (
    (
      "controlPlaneVersion" IS NULL
      AND "status" IS NULL
      AND "version" IS NULL
      AND "conclusion" IS NULL
      AND "riskLevel" IS NULL
      AND "evidenceNote" IS NULL
      AND "connectionConfigurationRevision" IS NULL
      AND "revokedById" IS NULL
      AND "revokedAt" IS NULL
      AND "revocationTransactionId" IS NULL
    )
    OR (
      "controlPlaneVersion" IS NOT NULL
      AND "controlPlaneVersion" = 2
      AND "status" IS NOT NULL
      AND "version" IS NOT NULL
      AND "version" > 0
      AND "conclusion" IS NOT NULL
      AND length(btrim("conclusion")) > 0
      AND "riskLevel" IS NOT NULL
      AND length(btrim("riskLevel")) > 0
      AND "evidenceNote" IS NOT NULL
      AND length(btrim("evidenceNote")) > 0
      AND "conclusion" = 'read_only_verified'
      AND "riskLevel" IN ('low', 'medium', 'high')
      AND "evidenceNote" = 'manual_read_only_review'
      AND "note" IS NULL
      AND "evidence" = '{}'::jsonb
      AND "connectionConfigurationRevision" IS NOT NULL
      AND "connectionConfigurationRevision" > 0
      AND (
        ("status" = 'active' AND "revokedById" IS NULL AND "revokedAt" IS NULL AND "revocationTransactionId" IS NULL)
        OR ("status" = 'revoked' AND "revokedById" IS NOT NULL AND "revokedAt" IS NOT NULL AND "revocationTransactionId" IS NOT NULL)
      )
    )
  );

CREATE INDEX "ProjectMcpToolGrant_controlPlaneVersion_status_idx"
  ON "ProjectMcpToolGrant"("controlPlaneVersion", "status", "updatedAt");
CREATE INDEX "ProjectMcpToolGrant_revocationTransactionId_idx"
  ON "ProjectMcpToolGrant"("revocationTransactionId");
CREATE INDEX "McpToolAttestation_controlPlaneVersion_status_idx"
  ON "McpToolAttestation"("controlPlaneVersion", "status", "createdAt");
CREATE INDEX "McpToolAttestation_revocationTransactionId_idx"
  ON "McpToolAttestation"("revocationTransactionId");
CREATE INDEX "McpToolAttestationAudit_transactionId_createdAt_idx"
  ON "McpToolAttestationAudit"("transactionId", "createdAt");
CREATE UNIQUE INDEX "McpToolAttestation_v2_active_tuple_key"
  ON "McpToolAttestation"(
    "connectionId",
    "toolDefinitionId",
    "toolName",
    "definitionFingerprint",
    "networkFingerprint",
    "credentialFingerprint",
    "connectionConfigurationRevision"
  )
  WHERE "controlPlaneVersion" = 2 AND "status" = 'active';
CREATE UNIQUE INDEX "McpToolAttestationAudit_v2_event_key"
  ON "McpToolAttestationAudit"("attestationId", "event")
  WHERE "controlPlaneVersion" = 2;
CREATE UNIQUE INDEX "ProjectMcpToolGrant_active_project_connection_tool_key"
  ON "ProjectMcpToolGrant"("projectId", "connectionId", "toolName")
  WHERE "status" = 'active';
DROP INDEX "ProjectMcpToolGrant_projectId_connectionId_toolName_key";

ALTER TABLE "ProjectMcpToolGrant"
  ADD CONSTRAINT "ProjectMcpToolGrant_revokedById_fkey"
    FOREIGN KEY ("revokedById") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "ProjectMcpToolGrant_grantorMembership_fkey"
    FOREIGN KEY ("grantorProjectMembershipId") REFERENCES "ProjectMembership"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "ProjectMcpToolGrant_revokerMembership_fkey"
    FOREIGN KEY ("revokerProjectMembershipId") REFERENCES "ProjectMembership"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "McpToolAttestation"
  ADD CONSTRAINT "McpToolAttestation_revokedById_fkey"
    FOREIGN KEY ("revokedById") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- The V2 validator is shared by the attestation and grant guards.  It checks
-- only scalar control-plane evidence and never reads credential material.
CREATE OR REPLACE FUNCTION "mcp_tool_attestation_v2_tuple_valid"(attestation_row "McpToolAttestation")
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1
    FROM "AppUser" AS verifier
    JOIN "McpConnection" AS connection
      ON connection."id" = attestation_row."connectionId"
    JOIN "McpToolDefinition" AS definition
      ON definition."id" = attestation_row."toolDefinitionId"
     AND definition."connectionId" = attestation_row."connectionId"
     AND definition."name" = attestation_row."toolName"
    WHERE verifier."id" = attestation_row."verifiedById"
      AND verifier."role" = 'admin'
      AND verifier."disabledAt" IS NULL
      AND connection."status" = 'verified'
      AND connection."disabledAt" IS NULL
      AND connection."configurationRevision" = attestation_row."connectionConfigurationRevision"
      AND connection."resolvedAddressFingerprint" = attestation_row."networkFingerprint"
      AND connection."credentialFingerprint" = attestation_row."credentialFingerprint"
      AND definition."current" = true
      AND definition."readOnlyEligible" = true
      AND definition."definitionFingerprint" = attestation_row."definitionFingerprint"
      AND attestation_row."controlPlaneVersion" = 2
      AND attestation_row."status" = 'active'
      AND attestation_row."conclusion" = 'read_only_verified'
      AND attestation_row."riskLevel" IN ('low', 'medium', 'high')
      AND attestation_row."evidenceNote" = 'manual_read_only_review'
      AND attestation_row."note" IS NULL
      AND attestation_row."evidence" = '{}'::jsonb
  );
END;
$$;

CREATE OR REPLACE FUNCTION "project_mcp_tool_grant_v2_history_valid"(grant_row "ProjectMcpToolGrant")
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN COALESCE((
    grant_row."controlPlaneVersion" IS NOT NULL
    AND grant_row."controlPlaneVersion" = 2
    AND grant_row."status" IS NOT NULL
    AND grant_row."status" = 'active'
    AND grant_row."grantVersion" IS NOT NULL
    AND grant_row."grantVersion" > 0
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
    AND grant_row."revocationTransactionId" IS NULL
  ), false);
END;
$$;

DROP TRIGGER IF EXISTS "McpToolAttestation_guard" ON "McpToolAttestation";

CREATE OR REPLACE FUNCTION "mcp_tool_attestation_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."controlPlaneVersion" = 2 THEN
      RAISE EXCEPTION 'MCP_TOOL_ATTESTATION_V2_DELETE_FORBIDDEN' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "McpConnection" WHERE "id" = OLD."connectionId") THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'MCP tool attestations are append-only' USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD."controlPlaneVersion" IS DISTINCT FROM 2 OR NEW."controlPlaneVersion" IS DISTINCT FROM 2 THEN
      RAISE EXCEPTION 'MCP tool attestations are append-only' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."id" IS DISTINCT FROM NEW."id"
       OR OLD."connectionId" IS DISTINCT FROM NEW."connectionId"
       OR OLD."toolDefinitionId" IS DISTINCT FROM NEW."toolDefinitionId"
       OR OLD."toolName" IS DISTINCT FROM NEW."toolName"
       OR OLD."definitionFingerprint" IS DISTINCT FROM NEW."definitionFingerprint"
       OR OLD."networkFingerprint" IS DISTINCT FROM NEW."networkFingerprint"
       OR OLD."credentialFingerprint" IS DISTINCT FROM NEW."credentialFingerprint"
       OR OLD."conclusion" IS DISTINCT FROM NEW."conclusion"
       OR OLD."riskLevel" IS DISTINCT FROM NEW."riskLevel"
       OR OLD."evidenceNote" IS DISTINCT FROM NEW."evidenceNote"
       OR OLD."connectionConfigurationRevision" IS DISTINCT FROM NEW."connectionConfigurationRevision"
       OR OLD."verifiedById" IS DISTINCT FROM NEW."verifiedById"
       OR OLD."note" IS DISTINCT FROM NEW."note"
       OR OLD."evidence" IS DISTINCT FROM NEW."evidence"
       OR OLD."attestedAt" IS DISTINCT FROM NEW."attestedAt"
       OR OLD."createdAt" IS DISTINCT FROM NEW."createdAt" THEN
      RAISE EXCEPTION 'MCP_TOOL_ATTESTATION_IDENTITY_IMMUTABLE' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" <> 'active' OR NEW."status" <> 'revoked' OR NEW."version" <> OLD."version" + 1 THEN
      RAISE EXCEPTION 'MCP_TOOL_ATTESTATION_STATE_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."conclusion" <> 'read_only_verified'
       OR OLD."riskLevel" NOT IN ('low', 'medium', 'high')
       OR OLD."evidenceNote" <> 'manual_read_only_review'
       OR OLD."note" IS NOT NULL
       OR OLD."evidence" IS DISTINCT FROM '{}'::jsonb
       OR OLD."connectionConfigurationRevision" IS NULL
       OR OLD."connectionConfigurationRevision" <= 0
       OR OLD."definitionFingerprint" !~ '^[0-9a-f]{64}$'
       OR OLD."networkFingerprint" !~ '^[0-9a-f]{64}$'
       OR OLD."credentialFingerprint" !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'MCP_TOOL_ATTESTATION_HISTORY_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM "AppUser" AS actor
      WHERE actor."id" = NEW."revokedById"
        AND actor."role" = 'admin'
        AND actor."disabledAt" IS NULL
    ) THEN
      RAISE EXCEPTION 'MCP_TOOL_ATTESTATION_REVOKER_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    NEW."revokedAt" := clock_timestamp();
    NEW."revocationTransactionId" := txid_current();
    RETURN NEW;
  END IF;

  IF NEW."controlPlaneVersion" IS DISTINCT FROM 2 THEN
    IF NOT EXISTS (
      SELECT 1
      FROM "McpToolDefinition" AS definition
      WHERE definition."id" = NEW."toolDefinitionId"
        AND definition."connectionId" = NEW."connectionId"
        AND definition."name" = NEW."toolName"
    ) THEN
      RAISE EXCEPTION 'MCP tool attestation must bind to the exact tool definition' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."status" <> 'active' OR NEW."version" <> 1
     OR NEW."revokedById" IS NOT NULL OR NEW."revokedAt" IS NOT NULL
     OR NEW."revocationTransactionId" IS NOT NULL
     OR NOT "mcp_tool_attestation_v2_tuple_valid"(NEW) THEN
    RAISE EXCEPTION 'MCP_TOOL_ATTESTATION_TUPLE_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "McpToolAttestation_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "McpToolAttestation"
FOR EACH ROW EXECUTE FUNCTION "mcp_tool_attestation_guard"();

CREATE OR REPLACE FUNCTION "project_mcp_tool_grant_v2_tuple_valid"(grant_row "ProjectMcpToolGrant")
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1
    FROM "ProjectMcpConnectionDelegation" AS delegation
    JOIN "Project" AS project_row
      ON project_row."id" = grant_row."projectId"
    JOIN "ProjectMembership" AS owner_membership
      ON owner_membership."id" = delegation."ownerProjectMembershipId"
    JOIN "AppUser" AS connection_owner
      ON connection_owner."id" = delegation."connectionOwnerId"
    JOIN "ProjectMembership" AS project_owner_membership
      ON project_owner_membership."id" = delegation."projectConfirmedProjectMembershipId"
    JOIN "AppUser" AS project_owner
      ON project_owner."id" = delegation."projectConfirmedById"
    JOIN "ProjectMembership" AS grantor_membership
      ON grantor_membership."id" = grant_row."grantorProjectMembershipId"
    JOIN "McpConnection" AS connection
      ON connection."id" = grant_row."connectionId"
    LEFT JOIN "ExternalCredential" AS credential
      ON credential."id" = connection."credentialId"
    JOIN "McpToolDefinition" AS definition
      ON definition."id" = grant_row."toolDefinitionId"
     AND definition."connectionId" = grant_row."connectionId"
     AND definition."name" = grant_row."toolName"
    JOIN "McpToolAttestation" AS attestation
      ON attestation."id" = grant_row."attestationId"
     AND attestation."connectionId" = grant_row."connectionId"
     AND attestation."toolDefinitionId" = grant_row."toolDefinitionId"
     AND attestation."toolName" = grant_row."toolName"
    JOIN "AppUser" AS verifier
      ON verifier."id" = attestation."verifiedById"
    JOIN "AppUser" AS grantor
      ON grantor."id" = grantor_membership."userId"
    WHERE grant_row."controlPlaneVersion" IS NOT NULL
      AND grant_row."controlPlaneVersion" = 2
      AND grant_row."status" IS NOT NULL
      AND grant_row."status" = 'active'
      AND grant_row."grantVersion" IS NOT NULL
      AND grant_row."grantVersion" > 0
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
      AND delegation."id" = grant_row."delegationId"
      AND delegation."projectId" = grant_row."projectId"
      AND delegation."mcpConnectionId" = grant_row."connectionId"
      AND delegation."status" = 'active'
      AND delegation."expiresAt" > clock_timestamp()
      AND delegation."version" = grant_row."delegationVersion"
      AND delegation."delegationFingerprint" = grant_row."delegationFingerprint"
      AND delegation."connectionConfigurationRevision" = grant_row."connectionConfigurationRevision"
      AND delegation."resolvedAddressFingerprint" = grant_row."networkFingerprint"
      AND delegation."credentialFingerprint" = grant_row."credentialFingerprint"
      AND project_row."archivedAt" IS NULL
      AND owner_membership."projectId" = grant_row."projectId"
      AND owner_membership."userId" = delegation."connectionOwnerId"
      AND owner_membership."role" IN ('owner', 'editor')
      AND owner_membership."accessState" = 'confirmed'
      AND owner_membership."createdAt" = delegation."ownerMembershipCreatedAt"
      AND connection_owner."disabledAt" IS NULL
      AND delegation."projectConfirmedProjectMembershipId" IS NOT NULL
      AND delegation."projectConfirmedMembershipCreatedAt" IS NOT NULL
      AND delegation."projectConfirmedById" IS NOT NULL
      AND project_owner_membership."projectId" = grant_row."projectId"
      AND project_owner_membership."userId" = delegation."projectConfirmedById"
      AND project_owner_membership."role" = 'owner'
      AND project_owner_membership."accessState" = 'confirmed'
      AND project_owner_membership."createdAt" = delegation."projectConfirmedMembershipCreatedAt"
      AND project_owner."disabledAt" IS NULL
      AND grantor_membership."projectId" = grant_row."projectId"
      AND grantor_membership."role" = 'owner'
      AND grantor_membership."accessState" = 'confirmed'
      AND grantor_membership."createdAt" = grant_row."grantorMembershipCreatedAt"
      AND grantor."id" = grant_row."managedById"
      AND grantor."disabledAt" IS NULL
      AND connection."ownerUserId" = delegation."connectionOwnerId"
      AND connection."ownershipState" = 'confirmed'
      AND connection."status" = 'verified'
      AND connection."disabledAt" IS NULL
      AND connection."configurationRevision" = grant_row."connectionConfigurationRevision"
      AND connection."resolvedAddressFingerprint" = grant_row."networkFingerprint"
      AND connection."credentialFingerprint" = grant_row."credentialFingerprint"
      AND (
        (
          connection."authKind" = 'none'
          AND connection."credentialId" IS NULL
          AND connection."credentialFingerprint" = 'd2ab012fb807b99b7d059aabe98a45dd6edf6941a5f22699f8d04b5906dc2c2b'
        )
        OR (
          connection."authKind" = 'bearer'
          AND credential."kind" = 'mcp'
          AND credential."secretFingerprint" = connection."credentialFingerprint"
        )
      )
      AND definition."current" = true
      AND definition."readOnlyEligible" = true
      AND definition."definitionFingerprint" = grant_row."definitionFingerprint"
      AND attestation."controlPlaneVersion" IS NOT NULL
      AND attestation."controlPlaneVersion" = 2
      AND attestation."status" IS NOT NULL
      AND attestation."status" = 'active'
      AND attestation."version" IS NOT NULL
      AND attestation."version" > 0
      AND attestation."conclusion" IS NOT NULL
      AND attestation."conclusion" = 'read_only_verified'
      AND attestation."riskLevel" IS NOT NULL
      AND attestation."riskLevel" IN ('low', 'medium', 'high')
      AND attestation."evidenceNote" IS NOT NULL
      AND attestation."evidenceNote" = 'manual_read_only_review'
      AND attestation."note" IS NULL
      AND attestation."evidence" = '{}'::jsonb
      AND verifier."role" = 'admin'
      AND verifier."disabledAt" IS NULL
      AND attestation."connectionConfigurationRevision" = grant_row."connectionConfigurationRevision"
      AND attestation."definitionFingerprint" = grant_row."definitionFingerprint"
      AND attestation."networkFingerprint" = grant_row."networkFingerprint"
      AND attestation."credentialFingerprint" = grant_row."credentialFingerprint"
      AND "mcp_tool_attestation_v2_tuple_valid"(attestation)
      AND NOT EXISTS (
        SELECT 1
        FROM "McpToolAttestationAudit" AS revoked_attestation
        WHERE revoked_attestation."attestationId" = attestation."id"
          AND revoked_attestation."event" = 'revoked'
      )
  );
END;
$$;

DROP TRIGGER IF EXISTS "McpToolAttestationAudit_guard" ON "McpToolAttestationAudit";

CREATE OR REPLACE FUNCTION "mcp_tool_attestation_audit_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  attestation_row RECORD;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'MCP attestation audits are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM "McpToolAttestation" WHERE "id" = OLD."attestationId") THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'MCP attestation audits are immutable' USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO attestation_row
  FROM "McpToolAttestation"
  WHERE "id" = NEW."attestationId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MCP_TOOL_ATTESTATION_AUDIT_ENTITY_INVALID' USING ERRCODE = 'check_violation';
  END IF;

  IF attestation_row."controlPlaneVersion" = 2 THEN
    IF NEW."details" <> '{}'::jsonb THEN
      RAISE EXCEPTION 'MCP_TOOL_ATTESTATION_AUDIT_DETAILS_FORBIDDEN' USING ERRCODE = 'check_violation';
    END IF;
    NEW."transactionId" := txid_current();
    IF NEW."event" = 'attested' THEN
      IF attestation_row."status" <> 'active'
         OR attestation_row."version" <> 1
         OR attestation_row."conclusion" IS DISTINCT FROM 'read_only_verified'
         OR attestation_row."riskLevel" NOT IN ('low', 'medium', 'high')
         OR attestation_row."evidenceNote" IS DISTINCT FROM 'manual_read_only_review'
         OR attestation_row."note" IS NOT NULL
         OR attestation_row."evidence" IS DISTINCT FROM '{}'::jsonb THEN
        RAISE EXCEPTION 'MCP_TOOL_ATTESTATION_AUDIT_STATE_INVALID' USING ERRCODE = 'check_violation';
      END IF;
      IF NEW."actorId" IS DISTINCT FROM attestation_row."verifiedById"
         OR NEW."controlPlaneVersion" IS DISTINCT FROM 2
         OR NEW."attestationVersion" IS DISTINCT FROM attestation_row."version"
         OR NEW."statusBefore" IS NOT NULL
         OR NEW."statusAfter" IS DISTINCT FROM 'active'::"McpToolAttestationStatus"
         OR NEW."connectionConfigurationRevision" IS DISTINCT FROM attestation_row."connectionConfigurationRevision" THEN
        RAISE EXCEPTION 'MCP_TOOL_ATTESTATION_AUDIT_SNAPSHOT_INVALID' USING ERRCODE = 'check_violation';
      END IF;
    ELSIF NEW."event" = 'revoked' THEN
      IF attestation_row."status" <> 'revoked'
         OR attestation_row."revocationTransactionId" <> txid_current()
         OR attestation_row."revokedAt" IS NULL
         OR attestation_row."conclusion" IS DISTINCT FROM 'read_only_verified'
         OR attestation_row."riskLevel" NOT IN ('low', 'medium', 'high')
         OR attestation_row."evidenceNote" IS DISTINCT FROM 'manual_read_only_review'
         OR attestation_row."note" IS NOT NULL
         OR attestation_row."evidence" IS DISTINCT FROM '{}'::jsonb THEN
        RAISE EXCEPTION 'MCP_TOOL_ATTESTATION_AUDIT_STATE_INVALID' USING ERRCODE = 'check_violation';
      END IF;
      IF NEW."actorId" IS DISTINCT FROM attestation_row."revokedById"
         OR NEW."controlPlaneVersion" IS DISTINCT FROM 2
         OR NEW."attestationVersion" IS DISTINCT FROM attestation_row."version"
         OR NEW."statusBefore" IS DISTINCT FROM 'active'::"McpToolAttestationStatus"
         OR NEW."statusAfter" IS DISTINCT FROM 'revoked'::"McpToolAttestationStatus"
         OR NEW."connectionConfigurationRevision" IS DISTINCT FROM attestation_row."connectionConfigurationRevision" THEN
        RAISE EXCEPTION 'MCP_TOOL_ATTESTATION_AUDIT_SNAPSHOT_INVALID' USING ERRCODE = 'check_violation';
      END IF;
    ELSE
      RAISE EXCEPTION 'MCP_TOOL_ATTESTATION_AUDIT_EVENT_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."connectionId" IS DISTINCT FROM attestation_row."connectionId"
       OR NEW."toolDefinitionId" IS DISTINCT FROM attestation_row."toolDefinitionId"
       OR NEW."definitionFingerprint" IS DISTINCT FROM attestation_row."definitionFingerprint"
       OR NEW."networkFingerprint" IS DISTINCT FROM attestation_row."networkFingerprint"
       OR NEW."credentialFingerprint" IS DISTINCT FROM attestation_row."credentialFingerprint" THEN
      RAISE EXCEPTION 'MCP_TOOL_ATTESTATION_AUDIT_SNAPSHOT_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM "McpToolAttestationAudit" AS existing
      WHERE existing."attestationId" = NEW."attestationId"
        AND existing."event" = NEW."event"
    ) THEN
      RAISE EXCEPTION 'MCP_TOOL_ATTESTATION_AUDIT_DUPLICATE' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  NEW."transactionId" := txid_current();
  IF NOT EXISTS (
    SELECT 1
    FROM "McpToolAttestation" AS attestation
    WHERE attestation."id" = NEW."attestationId"
      AND attestation."connectionId" = NEW."connectionId"
      AND attestation."toolDefinitionId" = NEW."toolDefinitionId"
      AND attestation."definitionFingerprint" = NEW."definitionFingerprint"
      AND attestation."networkFingerprint" = NEW."networkFingerprint"
      AND attestation."credentialFingerprint" = NEW."credentialFingerprint"
  ) THEN
    RAISE EXCEPTION 'MCP attestation audit must match the attestation snapshot' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."event" = 'attested' AND EXISTS (
    SELECT 1 FROM "McpToolAttestationAudit"
    WHERE "attestationId" = NEW."attestationId" AND "event" = 'attested'
  ) THEN
    RAISE EXCEPTION 'MCP attestation can only be attested once' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."event" = 'revoked' AND NOT EXISTS (
    SELECT 1 FROM "McpToolAttestationAudit"
    WHERE "attestationId" = NEW."attestationId" AND "event" = 'attested'
  ) THEN
    RAISE EXCEPTION 'MCP attestation must be attested before revocation' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."event" = 'revoked' AND EXISTS (
    SELECT 1 FROM "McpToolAttestationAudit"
    WHERE "attestationId" = NEW."attestationId" AND "event" = 'revoked'
  ) THEN
    RAISE EXCEPTION 'MCP attestation is already revoked' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "McpToolAttestationAudit_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "McpToolAttestationAudit"
FOR EACH ROW EXECUTE FUNCTION "mcp_tool_attestation_audit_guard"();

CREATE OR REPLACE FUNCTION "mcp_tool_attestation_v2_audit_required"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  audit_count BIGINT;
  expected_event "McpToolAttestationAuditEvent";
BEGIN
  IF NEW."controlPlaneVersion" IS DISTINCT FROM 2 THEN
    RETURN NEW;
  END IF;
  expected_event := CASE WHEN TG_OP = 'INSERT' THEN 'attested' ELSE 'revoked' END;
  SELECT COUNT(*) INTO audit_count
  FROM "McpToolAttestationAudit" AS audit
  WHERE audit."attestationId" = NEW."id"
    AND audit."event" = expected_event
    AND audit."controlPlaneVersion" = 2
    AND audit."attestationVersion" = NEW."version"
    AND audit."transactionId" = txid_current()
    AND audit."actorId" IS NOT DISTINCT FROM CASE WHEN expected_event = 'attested' THEN NEW."verifiedById" ELSE NEW."revokedById" END;
  IF audit_count <> 1 THEN
    RAISE EXCEPTION 'MCP_TOOL_ATTESTATION_AUDIT_REQUIRED' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "McpToolAttestation_v2_audit_required"
AFTER INSERT OR UPDATE OF "status" ON "McpToolAttestation"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (NEW."controlPlaneVersion" = 2)
EXECUTE FUNCTION "mcp_tool_attestation_v2_audit_required"();

-- V2 attestation evidence must survive connection cleanup.  The historical
-- cascade FKs remain for V1 compatibility, but the V2 guard blocks both a
-- direct connection delete and a cascade through the attestation row.
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
  IF EXISTS (
    SELECT 1 FROM "McpToolAttestation"
    WHERE "connectionId" = OLD."id"
      AND "controlPlaneVersion" = 2
  ) THEN
    RAISE EXCEPTION 'MCP_CONNECTION_V2_ATTESTATION_DELETE_FORBIDDEN' USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS "ProjectMcpToolGrant_guard" ON "ProjectMcpToolGrant";
DROP TRIGGER IF EXISTS "ProjectMcpToolGrantAudit_guard" ON "ProjectMcpToolGrantAudit";
DROP TRIGGER IF EXISTS "ProjectMcpToolGrant_revoke_audit_guard" ON "ProjectMcpToolGrant";

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
     OR OLD."grantorMembershipCreatedAt" IS DISTINCT FROM NEW."grantorMembershipCreatedAt" THEN
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
  SELECT grant_source.* INTO grant_row
  FROM "ProjectMcpToolGrant" AS grant_source
  WHERE grant_source."id" = NEW."grantId" AND grant_source."projectId" = NEW."projectId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'project MCP tool grant audit must match current grant' USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."controlPlaneVersion" IS DISTINCT FROM grant_row."controlPlaneVersion" THEN
    IF NEW."controlPlaneVersion" IS NOT NULL OR grant_row."controlPlaneVersion" IS NOT NULL THEN
      RAISE EXCEPTION 'PROJECT_MCP_TOOL_GRANT_AUDIT_VERSION_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF grant_row."controlPlaneVersion" = 2 THEN
    IF NEW."details" <> '{}'::jsonb THEN
      RAISE EXCEPTION 'PROJECT_MCP_TOOL_GRANT_AUDIT_DETAILS_FORBIDDEN' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."event" <> 'revoked'
       OR grant_row."status" <> 'revoked'
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
  ELSE
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
  END IF;
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
