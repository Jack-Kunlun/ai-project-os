-- Single-use Streamable HTTP MCP dispatch runtime.
--
-- The approval control plane remains the source of truth for the action
-- snapshot.  This migration adds one runtime reservation, append-only scalar
-- transition evidence, and a bounded result owned by the action.  Attempts
-- and runtime evidence intentionally have no foreign keys so project deletion
-- cannot erase the fact that a remote request may have been sent.

CREATE TYPE "ProjectMcpActionDispatchAttemptStatus" AS ENUM (
  'reserved',
  'succeeded',
  'failed',
  'unknown',
  'expired',
  'invalidated'
);

CREATE TYPE "ProjectMcpActionRuntimeLedgerEvent" AS ENUM (
  'reserved',
  'succeeded',
  'failed',
  'unknown',
  'expired',
  'invalidated'
);

CREATE TYPE "ProjectMcpActionRuntimeActorKind" AS ENUM (
  'owner',
  'system_recovery'
);

-- The delegation tables predate this runtime and store UTC civil
-- TIMESTAMP(3) values. Pin their trigger functions to UTC so the original
-- clock_timestamp() assignments and comparisons cannot inherit a caller's
-- session TimeZone while preserving the already-deployed function bodies.
ALTER FUNCTION "project_mcp_connection_delegation_shape_guard"() SET TimeZone TO 'UTC';
ALTER FUNCTION "project_mcp_connection_delegation_live_integrity_guard"() SET TimeZone TO 'UTC';
ALTER FUNCTION "project_mcp_connection_delegation_audit_insert_guard"() SET TimeZone TO 'UTC';
ALTER FUNCTION "mcp_tool_attestation_guard"() SET TimeZone TO 'UTC';
ALTER FUNCTION "project_mcp_tool_grant_guard"() SET TimeZone TO 'UTC';
ALTER FUNCTION "project_mcp_tool_grant_ledger_guard"() SET TimeZone TO 'UTC';
ALTER FUNCTION "project_mcp_tool_grant_audit_guard"() SET TimeZone TO 'UTC';

-- All persisted DateTime values in this control plane are UTC civil
-- TIMESTAMP(3). Reinstall the V2 source predicate with the same representation
-- on both sides of the delegation expiry comparison so session TimeZone can
-- never admit an expired source or reject a live one.
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
      AND delegation."expiresAt" > (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3)
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

CREATE TABLE "ProjectMcpActionDispatchAttempt" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "projectId" UUID NOT NULL,
  "actionId" UUID NOT NULL,
  "actorKind" "ProjectMcpActionRuntimeActorKind" NOT NULL DEFAULT 'owner',
  "actorId" UUID NOT NULL,
  "actorProjectMembershipId" UUID NOT NULL,
  "actorMembershipCreatedAt" TIMESTAMP(3) NOT NULL,
  "rpcRequestId" UUID NOT NULL,
  "reservationTokenHash" CHAR(64) NOT NULL,
  "status" "ProjectMcpActionDispatchAttemptStatus" NOT NULL DEFAULT 'reserved',
  "actionFingerprint" CHAR(64) NOT NULL,
  "definitionFingerprint" CHAR(64) NOT NULL,
  "networkFingerprint" CHAR(64) NOT NULL,
  "credentialFingerprint" CHAR(64) NOT NULL,
  "connectionConfigurationRevision" INTEGER NOT NULL,
  "reservationTransactionId" BIGINT NOT NULL,
  "reservationExpiresAt" TIMESTAMP(3) NOT NULL,
  "reservedAt" TIMESTAMP(3) NOT NULL,
  "boundaryReachedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "safeErrorCode" VARCHAR(64),
  "httpStatus" INTEGER,
  "resultFingerprint" CHAR(64),
  "resultBytes" INTEGER,
  "resultNodes" INTEGER,
  "resultDepth" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProjectMcpActionDispatchAttempt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProjectMcpActionDispatchAttempt_shape_check" CHECK (
    "reservationTokenHash" ~ '^[0-9a-f]{64}$'
    AND "actionFingerprint" ~ '^[0-9a-f]{64}$'
    AND "definitionFingerprint" ~ '^[0-9a-f]{64}$'
    AND "networkFingerprint" ~ '^[0-9a-f]{64}$'
    AND "credentialFingerprint" ~ '^[0-9a-f]{64}$'
    AND "connectionConfigurationRevision" > 0
    AND "reservationExpiresAt" > "reservedAt"
    AND ("safeErrorCode" IS NULL OR "safeErrorCode" <> '')
    AND ("resultFingerprint" IS NULL OR "resultFingerprint" ~ '^[0-9a-f]{64}$')
    AND ("resultBytes" IS NULL OR "resultBytes" >= 0)
    AND ("resultNodes" IS NULL OR "resultNodes" >= 0)
    AND ("resultDepth" IS NULL OR "resultDepth" >= 0)
  )
);

CREATE UNIQUE INDEX "ProjectMcpActionDispatchAttempt_actionId_key"
  ON "ProjectMcpActionDispatchAttempt"("actionId");
CREATE UNIQUE INDEX "ProjectMcpActionDispatchAttempt_projectId_actionId_key"
  ON "ProjectMcpActionDispatchAttempt"("projectId", "actionId");
CREATE UNIQUE INDEX "ProjectMcpActionDispatchAttempt_rpcRequestId_key"
  ON "ProjectMcpActionDispatchAttempt"("rpcRequestId");
CREATE INDEX "ProjectMcpActionDispatchAttempt_status_reservationExpiresAt_idx"
  ON "ProjectMcpActionDispatchAttempt"("status", "reservationExpiresAt");
CREATE INDEX "ProjectMcpActionDispatchAttempt_projectId_createdAt_idx"
  ON "ProjectMcpActionDispatchAttempt"("projectId", "createdAt");

CREATE TABLE "ProjectMcpActionRuntimeLedger" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "projectId" UUID NOT NULL,
  "actionId" UUID NOT NULL,
  "attemptId" UUID,
  "rpcRequestId" UUID,
  "actorKind" "ProjectMcpActionRuntimeActorKind" NOT NULL DEFAULT 'owner',
  "actorId" UUID NOT NULL,
  "actorProjectMembershipId" UUID NOT NULL,
  "actorMembershipCreatedAt" TIMESTAMP(3) NOT NULL,
  "event" "ProjectMcpActionRuntimeLedgerEvent" NOT NULL,
  "statusBefore" "ProjectMcpActionStatus",
  "statusAfter" "ProjectMcpActionStatus" NOT NULL,
  "stateVersion" INTEGER NOT NULL,
  "actionFingerprint" CHAR(64) NOT NULL,
  "definitionFingerprint" CHAR(64) NOT NULL,
  "networkFingerprint" CHAR(64) NOT NULL,
  "credentialFingerprint" CHAR(64) NOT NULL,
  "connectionConfigurationRevision" INTEGER NOT NULL,
  "safeErrorCode" VARCHAR(64),
  "resultFingerprint" CHAR(64),
  "resultBytes" INTEGER,
  "resultNodes" INTEGER,
  "resultDepth" INTEGER,
  "transactionId" BIGINT NOT NULL DEFAULT txid_current(),
  "transitionAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProjectMcpActionRuntimeLedger_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProjectMcpActionRuntimeLedger_shape_check" CHECK (
    "stateVersion" > 0
    AND "actionFingerprint" ~ '^[0-9a-f]{64}$'
    AND "definitionFingerprint" ~ '^[0-9a-f]{64}$'
    AND "networkFingerprint" ~ '^[0-9a-f]{64}$'
    AND "credentialFingerprint" ~ '^[0-9a-f]{64}$'
    AND "connectionConfigurationRevision" > 0
    AND ("safeErrorCode" IS NULL OR "safeErrorCode" <> '')
    AND ("resultFingerprint" IS NULL OR "resultFingerprint" ~ '^[0-9a-f]{64}$')
    AND ("resultBytes" IS NULL OR "resultBytes" >= 0)
    AND ("resultNodes" IS NULL OR "resultNodes" >= 0)
    AND ("resultDepth" IS NULL OR "resultDepth" >= 0)
  )
);

CREATE UNIQUE INDEX "ProjectMcpActionRuntimeLedger_actionId_stateVersion_key"
  ON "ProjectMcpActionRuntimeLedger"("actionId", "stateVersion");
CREATE INDEX "ProjectMcpActionRuntimeLedger_projectId_createdAt_idx"
  ON "ProjectMcpActionRuntimeLedger"("projectId", "createdAt");
CREATE INDEX "ProjectMcpActionRuntimeLedger_actionId_createdAt_idx"
  ON "ProjectMcpActionRuntimeLedger"("actionId", "createdAt");
CREATE INDEX "ProjectMcpActionRuntimeLedger_transactionId_createdAt_idx"
  ON "ProjectMcpActionRuntimeLedger"("transactionId", "createdAt");

CREATE TABLE "ProjectMcpActionDispatchResult" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "projectId" UUID NOT NULL,
  "actionId" UUID NOT NULL,
  "sanitizedPayload" JSONB NOT NULL,
  "resultFingerprint" CHAR(64) NOT NULL,
  "resultBytes" INTEGER NOT NULL,
  "resultNodes" INTEGER NOT NULL,
  "resultDepth" INTEGER NOT NULL,
  "omittedContentCount" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProjectMcpActionDispatchResult_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProjectMcpActionDispatchResult_project_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ProjectMcpActionDispatchResult_action_fkey" FOREIGN KEY ("projectId", "actionId") REFERENCES "ProjectMcpAction"("projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ProjectMcpActionDispatchResult_shape_check" CHECK (
    "resultFingerprint" ~ '^[0-9a-f]{64}$'
    AND "resultBytes" >= 0
    AND "resultNodes" > 0
    AND "resultDepth" >= 0
    AND "omittedContentCount" >= 0
  )
);

CREATE UNIQUE INDEX "ProjectMcpActionDispatchResult_actionId_key"
  ON "ProjectMcpActionDispatchResult"("actionId");
CREATE UNIQUE INDEX "ProjectMcpActionDispatchResult_projectId_actionId_key"
  ON "ProjectMcpActionDispatchResult"("projectId", "actionId");
CREATE UNIQUE INDEX "ProjectMcpActionDispatchResult_projectId_id_key"
  ON "ProjectMcpActionDispatchResult"("projectId", "id");
CREATE INDEX "ProjectMcpActionDispatchResult_projectId_createdAt_idx"
  ON "ProjectMcpActionDispatchResult"("projectId", "createdAt");

-- Extend the action transition guard.  All state changes still use a
-- stateVersion CAS and DB-owned transaction/time; dispatch transitions are
-- intentionally separate from the approval Decision/Ledger evidence.
CREATE OR REPLACE FUNCTION "project_mcp_action_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  transition_time TIMESTAMP(3);
  actor_valid BOOLEAN;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" IN ('waiting_approval', 'approved', 'dispatch_reserved') THEN
      RAISE EXCEPTION 'PROJECT_MCP_ACTION_PENDING_DELETE_FORBIDDEN' USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    transition_time := (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3);
    IF NEW."status" IS DISTINCT FROM 'waiting_approval'
       OR NEW."stateVersion" IS DISTINCT FROM 1
       OR NEW."approvedAt" IS NOT NULL
       OR NEW."approvalExpiresAt" IS NOT NULL
       OR NEW."rejectedAt" IS NOT NULL
       OR NEW."cancelledAt" IS NOT NULL
       OR NOT "project_mcp_action_actor_valid"(NEW."projectId", NEW."lastActorId", NEW."lastActorProjectMembershipId", NEW."lastActorMembershipCreatedAt") THEN
      RAISE EXCEPTION 'PROJECT_MCP_ACTION_PROPOSAL_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM "Project" WHERE "id" = NEW."projectId" AND "archivedAt" IS NOT NULL) THEN
      RAISE EXCEPTION 'PROJECT_MCP_ACTION_PROJECT_ARCHIVED' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."proposerProjectMembershipId" IS DISTINCT FROM NEW."lastActorProjectMembershipId"
       OR NEW."proposerMembershipCreatedAt" IS DISTINCT FROM NEW."lastActorMembershipCreatedAt"
       OR NOT "project_mcp_action_source_tuple_valid"(NEW) THEN
      RAISE EXCEPTION 'PROJECT_MCP_ACTION_SOURCE_TUPLE_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    NEW."canonicalArgumentsHash" := encode(digest(convert_to(NEW."canonicalArguments"::text, 'UTF8'), 'sha256'), 'hex');
    NEW."actionFingerprint" := "project_mcp_action_snapshot_fingerprint"(NEW);
    NEW."creationTransactionId" := txid_current();
    NEW."transitionTransactionId" := txid_current();
    NEW."createdAt" := transition_time;
    NEW."transitionAt" := NEW."createdAt";
    RETURN NEW;
  END IF;

  IF OLD."id" IS DISTINCT FROM NEW."id"
     OR OLD."projectId" IS DISTINCT FROM NEW."projectId"
     OR OLD."clientRequestId" IS DISTINCT FROM NEW."clientRequestId"
     OR OLD."grantId" IS DISTINCT FROM NEW."grantId"
     OR OLD."delegationId" IS DISTINCT FROM NEW."delegationId"
     OR OLD."toolDefinitionId" IS DISTINCT FROM NEW."toolDefinitionId"
     OR OLD."attestationId" IS DISTINCT FROM NEW."attestationId"
     OR OLD."connectionId" IS DISTINCT FROM NEW."connectionId"
     OR OLD."toolName" IS DISTINCT FROM NEW."toolName"
     OR OLD."inputSchema" IS DISTINCT FROM NEW."inputSchema"
     OR OLD."canonicalArguments" IS DISTINCT FROM NEW."canonicalArguments"
     OR OLD."canonicalArgumentsHash" IS DISTINCT FROM NEW."canonicalArgumentsHash"
     OR OLD."actionFingerprint" IS DISTINCT FROM NEW."actionFingerprint"
     OR OLD."proposerProjectMembershipId" IS DISTINCT FROM NEW."proposerProjectMembershipId"
     OR OLD."proposerMembershipCreatedAt" IS DISTINCT FROM NEW."proposerMembershipCreatedAt"
     OR OLD."grantVersion" IS DISTINCT FROM NEW."grantVersion"
     OR OLD."delegationVersion" IS DISTINCT FROM NEW."delegationVersion"
     OR OLD."attestationVersion" IS DISTINCT FROM NEW."attestationVersion"
     OR OLD."delegationFingerprint" IS DISTINCT FROM NEW."delegationFingerprint"
     OR OLD."definitionFingerprint" IS DISTINCT FROM NEW."definitionFingerprint"
     OR OLD."networkFingerprint" IS DISTINCT FROM NEW."networkFingerprint"
     OR OLD."credentialFingerprint" IS DISTINCT FROM NEW."credentialFingerprint"
     OR OLD."connectionConfigurationRevision" IS DISTINCT FROM NEW."connectionConfigurationRevision"
     OR OLD."connectionOwnerId" IS DISTINCT FROM NEW."connectionOwnerId"
     OR OLD."connectionOwnershipState" IS DISTINCT FROM NEW."connectionOwnershipState"
     OR OLD."connectionAllowPrivateNetwork" IS DISTINCT FROM NEW."connectionAllowPrivateNetwork"
     OR OLD."connectionUpdatedAt" IS DISTINCT FROM NEW."connectionUpdatedAt"
     OR OLD."credentialUpdatedAt" IS DISTINCT FROM NEW."credentialUpdatedAt"
     OR OLD."createdAt" IS DISTINCT FROM NEW."createdAt"
     OR OLD."creationTransactionId" IS DISTINCT FROM NEW."creationTransactionId" THEN
    RAISE EXCEPTION 'PROJECT_MCP_ACTION_IDENTITY_IMMUTABLE' USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."stateVersion" IS DISTINCT FROM OLD."stateVersion" + 1 THEN
    RAISE EXCEPTION 'PROJECT_MCP_ACTION_TRANSITION_INVALID' USING ERRCODE = 'check_violation';
  END IF;

  IF NOT ((OLD."status" = 'waiting_approval' AND NEW."status" IN ('approved', 'rejected', 'cancelled'))
       OR (OLD."status" = 'approved' AND NEW."status" IN ('cancelled', 'dispatch_reserved', 'expired', 'invalidated'))
       OR (OLD."status" = 'dispatch_reserved' AND NEW."status" IN ('succeeded', 'failed', 'unknown', 'expired', 'invalidated'))) THEN
    RAISE EXCEPTION 'PROJECT_MCP_ACTION_STATE_INVALID' USING ERRCODE = 'check_violation';
  END IF;

  actor_valid := "project_mcp_action_actor_valid"(NEW."projectId", NEW."lastActorId", NEW."lastActorProjectMembershipId", NEW."lastActorMembershipCreatedAt");
  IF OLD."status" <> 'dispatch_reserved' AND NOT actor_valid THEN
    RAISE EXCEPTION 'PROJECT_MCP_ACTION_TRANSITION_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" = 'dispatch_reserved'
     AND (NEW."lastActorId" IS DISTINCT FROM OLD."lastActorId"
       OR NEW."lastActorProjectMembershipId" IS DISTINCT FROM OLD."lastActorProjectMembershipId"
       OR NEW."lastActorMembershipCreatedAt" IS DISTINCT FROM OLD."lastActorMembershipCreatedAt")
     AND NOT actor_valid THEN
    RAISE EXCEPTION 'PROJECT_MCP_ACTION_TRANSITION_INVALID' USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."status" IN ('approved', 'dispatch_reserved') AND NOT "project_mcp_action_source_tuple_valid"(NEW) THEN
    RAISE EXCEPTION 'PROJECT_MCP_ACTION_SOURCE_TUPLE_INVALID' USING ERRCODE = 'check_violation';
  END IF;

  transition_time := (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3);
  IF NEW."status" = 'approved' THEN
    NEW."approvedAt" := transition_time;
    NEW."approvalExpiresAt" := transition_time + INTERVAL '15 minutes';
    NEW."rejectedAt" := NULL;
    NEW."cancelledAt" := NULL;
  ELSIF NEW."status" = 'rejected' THEN
    NEW."rejectedAt" := transition_time;
    NEW."approvedAt" := NULL;
    NEW."approvalExpiresAt" := NULL;
    NEW."cancelledAt" := NULL;
  ELSIF NEW."status" = 'cancelled' THEN
    IF OLD."status" = 'waiting_approval' THEN
      NEW."approvedAt" := NULL;
      NEW."approvalExpiresAt" := NULL;
      NEW."rejectedAt" := NULL;
    ELSE
      NEW."approvedAt" := OLD."approvedAt";
      NEW."approvalExpiresAt" := OLD."approvalExpiresAt";
      NEW."rejectedAt" := NULL;
    END IF;
    NEW."cancelledAt" := transition_time;
  ELSE
    NEW."approvedAt" := OLD."approvedAt";
    NEW."approvalExpiresAt" := OLD."approvalExpiresAt";
    NEW."rejectedAt" := NULL;
    NEW."cancelledAt" := NULL;
  END IF;
  NEW."transitionTransactionId" := txid_current();
  NEW."transitionAt" := transition_time;
  RETURN NEW;
END;
$$;

-- Replace the action evidence function so approval/cancel evidence remains
-- unchanged while dispatch states are checked against the new runtime ledger.
CREATE OR REPLACE FUNCTION "project_mcp_action_evidence_valid"(action_row "ProjectMcpAction")
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  legacy_count BIGINT;
  runtime_count BIGINT;
  approved_count BIGINT;
  expected_legacy_count INTEGER;
  expected_runtime_count INTEGER;
  reserved_runtime RECORD;
  attempt_row RECORD;
  latest_runtime RECORD;
BEGIN
  expected_legacy_count := CASE WHEN action_row."status" = 'waiting_approval' THEN 1 ELSE CASE WHEN action_row."status" = 'cancelled' AND action_row."stateVersion" = 3 THEN 3 ELSE 2 END END;
  SELECT COUNT(*) INTO legacy_count
  FROM "ProjectMcpActionLedger" AS ledger
  WHERE ledger."projectId" = action_row."projectId" AND ledger."actionId" = action_row."id";
  IF legacy_count <> expected_legacy_count THEN RETURN FALSE; END IF;
  IF EXISTS (
    SELECT 1 FROM generate_series(1, expected_legacy_count) AS version
    WHERE NOT EXISTS (
      SELECT 1 FROM "ProjectMcpActionLedger" AS ledger
      WHERE ledger."projectId" = action_row."projectId" AND ledger."actionId" = action_row."id" AND ledger."stateVersion" = version
    )
  ) THEN RETURN FALSE; END IF;

  IF action_row."status" IN ('waiting_approval', 'approved', 'rejected', 'cancelled') THEN
    SELECT COUNT(*) INTO legacy_count
    FROM "ProjectMcpActionLedger" AS ledger
    WHERE ledger."projectId" = action_row."projectId"
      AND ledger."actionId" = action_row."id"
      AND ledger."stateVersion" = action_row."stateVersion"
      AND ledger."statusAfter" = action_row."status"
      AND ledger."actionFingerprint" = action_row."actionFingerprint"
      AND ledger."canonicalArgumentsHash" = action_row."canonicalArgumentsHash"
      AND ledger."actorId" = action_row."lastActorId"
      AND ledger."actorProjectMembershipId" = action_row."lastActorProjectMembershipId"
      AND ledger."actorMembershipCreatedAt" = action_row."lastActorMembershipCreatedAt"
      AND ledger."transactionId" = action_row."transitionTransactionId"
      AND ledger."transitionAt" = action_row."transitionAt"
      AND ledger."createdAt" = action_row."transitionAt";
    IF legacy_count <> 1 THEN RETURN FALSE; END IF;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "ProjectMcpActionLedger" AS ledger
    WHERE ledger."projectId" = action_row."projectId"
      AND ledger."actionId" = action_row."id"
      AND (
        ledger."clientRequestId" IS DISTINCT FROM action_row."clientRequestId"
        OR ledger."grantId" IS DISTINCT FROM action_row."grantId"
        OR ledger."delegationId" IS DISTINCT FROM action_row."delegationId"
        OR ledger."toolDefinitionId" IS DISTINCT FROM action_row."toolDefinitionId"
        OR ledger."attestationId" IS DISTINCT FROM action_row."attestationId"
        OR ledger."connectionId" IS DISTINCT FROM action_row."connectionId"
        OR ledger."toolName" IS DISTINCT FROM action_row."toolName"
        OR ledger."grantVersion" IS DISTINCT FROM action_row."grantVersion"
        OR ledger."delegationVersion" IS DISTINCT FROM action_row."delegationVersion"
        OR ledger."attestationVersion" IS DISTINCT FROM action_row."attestationVersion"
        OR ledger."delegationFingerprint" IS DISTINCT FROM action_row."delegationFingerprint"
        OR ledger."definitionFingerprint" IS DISTINCT FROM action_row."definitionFingerprint"
        OR ledger."networkFingerprint" IS DISTINCT FROM action_row."networkFingerprint"
        OR ledger."credentialFingerprint" IS DISTINCT FROM action_row."credentialFingerprint"
        OR ledger."connectionConfigurationRevision" IS DISTINCT FROM action_row."connectionConfigurationRevision"
        OR ledger."canonicalArgumentsHash" IS DISTINCT FROM action_row."canonicalArgumentsHash"
        OR ledger."actionFingerprint" IS DISTINCT FROM action_row."actionFingerprint"
      )
  ) THEN RETURN FALSE; END IF;

  IF action_row."status" IN ('waiting_approval', 'approved', 'rejected', 'cancelled') THEN
    IF action_row."status" = 'waiting_approval' THEN
      RETURN NOT EXISTS (SELECT 1 FROM "ProjectMcpActionDecision" WHERE "projectId" = action_row."projectId" AND "actionId" = action_row."id")
        AND NOT EXISTS (SELECT 1 FROM "ProjectMcpActionRuntimeLedger" WHERE "actionId" = action_row."id");
    END IF;
    IF action_row."status" IN ('approved', 'rejected') THEN
      RETURN EXISTS (
        SELECT 1 FROM "ProjectMcpActionDecision" AS decision
        JOIN "ProjectMcpActionLedger" AS decision_ledger
          ON decision_ledger."projectId" = decision."projectId" AND decision_ledger."actionId" = decision."actionId" AND decision_ledger."stateVersion" = action_row."stateVersion" AND decision_ledger."statusAfter" = action_row."status"
          AND decision_ledger."event" = CASE WHEN action_row."status" = 'approved' THEN 'approved'::"ProjectMcpActionLedgerEvent" ELSE 'rejected'::"ProjectMcpActionLedgerEvent" END
        WHERE decision."projectId" = action_row."projectId" AND decision."actionId" = action_row."id"
          AND decision."decision" = CASE WHEN action_row."status" = 'approved' THEN 'approved'::"ProjectMcpActionDecisionKind" ELSE 'rejected'::"ProjectMcpActionDecisionKind" END
          AND decision."expectedStateVersion" = action_row."stateVersion" - 1
          AND decision."expectedActionFingerprint" = action_row."actionFingerprint"
          AND decision."actorId" = action_row."lastActorId"
          AND decision."actorProjectMembershipId" = action_row."lastActorProjectMembershipId"
          AND decision."actorMembershipCreatedAt" = action_row."lastActorMembershipCreatedAt"
          AND decision."transactionId" = action_row."transitionTransactionId"
          AND decision."decidedAt" = decision_ledger."transitionAt"
          AND decision."createdAt" = decision_ledger."createdAt"
      ) AND (
        SELECT COUNT(*)
        FROM "ProjectMcpActionDecision" AS decision_count_row
        JOIN "ProjectMcpActionLedger" AS decision_count_ledger
          ON decision_count_ledger."projectId" = decision_count_row."projectId"
         AND decision_count_ledger."actionId" = decision_count_row."actionId"
         AND decision_count_ledger."stateVersion" = action_row."stateVersion"
         AND decision_count_ledger."statusAfter" = action_row."status"
         AND decision_count_ledger."event" = CASE WHEN action_row."status" = 'approved' THEN 'approved'::"ProjectMcpActionLedgerEvent" ELSE 'rejected'::"ProjectMcpActionLedgerEvent" END
        WHERE decision_count_row."projectId" = action_row."projectId"
          AND decision_count_row."actionId" = action_row."id"
          AND decision_count_row."decision" = CASE WHEN action_row."status" = 'approved' THEN 'approved'::"ProjectMcpActionDecisionKind" ELSE 'rejected'::"ProjectMcpActionDecisionKind" END
          AND decision_count_row."expectedStateVersion" = action_row."stateVersion" - 1
          AND decision_count_row."expectedActionFingerprint" = action_row."actionFingerprint"
          AND decision_count_row."actorId" = action_row."lastActorId"
          AND decision_count_row."actorProjectMembershipId" = action_row."lastActorProjectMembershipId"
          AND decision_count_row."actorMembershipCreatedAt" = action_row."lastActorMembershipCreatedAt"
          AND decision_count_row."transactionId" = action_row."transitionTransactionId"
          AND decision_count_row."decidedAt" = decision_count_ledger."transitionAt"
          AND decision_count_row."createdAt" = decision_count_ledger."createdAt"
      ) = 1;
    END IF;
    IF action_row."status" = 'cancelled' AND action_row."stateVersion" = 2 THEN
      RETURN NOT EXISTS (SELECT 1 FROM "ProjectMcpActionDecision" WHERE "projectId" = action_row."projectId" AND "actionId" = action_row."id")
        AND NOT EXISTS (SELECT 1 FROM "ProjectMcpActionRuntimeLedger" WHERE "actionId" = action_row."id");
    END IF;
    IF action_row."status" = 'cancelled' AND action_row."stateVersion" = 3 THEN
      RETURN EXISTS (
        SELECT 1 FROM "ProjectMcpActionDecision" AS decision
        JOIN "ProjectMcpActionLedger" AS approved_ledger
          ON approved_ledger."projectId" = decision."projectId" AND approved_ledger."actionId" = decision."actionId" AND approved_ledger."event" = 'approved' AND approved_ledger."stateVersion" = action_row."stateVersion" - 1
        WHERE decision."projectId" = action_row."projectId" AND decision."actionId" = action_row."id" AND decision."decision" = 'approved'
          AND decision."expectedStateVersion" = approved_ledger."stateVersion" - 1 AND decision."expectedActionFingerprint" = approved_ledger."actionFingerprint"
          AND decision."actorId" = approved_ledger."actorId"
          AND decision."actorProjectMembershipId" = approved_ledger."actorProjectMembershipId"
          AND decision."actorMembershipCreatedAt" = approved_ledger."actorMembershipCreatedAt"
          AND decision."transactionId" = approved_ledger."transactionId"
          AND decision."decidedAt" = approved_ledger."transitionAt"
          AND decision."createdAt" = approved_ledger."createdAt"
      ) AND (
        SELECT COUNT(*)
        FROM "ProjectMcpActionDecision" AS decision_count_row
        JOIN "ProjectMcpActionLedger" AS approved_count_ledger
          ON approved_count_ledger."projectId" = decision_count_row."projectId"
         AND approved_count_ledger."actionId" = decision_count_row."actionId"
         AND approved_count_ledger."event" = 'approved'
         AND approved_count_ledger."stateVersion" = action_row."stateVersion" - 1
        WHERE decision_count_row."projectId" = action_row."projectId"
          AND decision_count_row."actionId" = action_row."id"
          AND decision_count_row."decision" = 'approved'
          AND decision_count_row."expectedStateVersion" = approved_count_ledger."stateVersion" - 1
          AND decision_count_row."expectedActionFingerprint" = approved_count_ledger."actionFingerprint"
          AND decision_count_row."actorId" = approved_count_ledger."actorId"
          AND decision_count_row."actorProjectMembershipId" = approved_count_ledger."actorProjectMembershipId"
          AND decision_count_row."actorMembershipCreatedAt" = approved_count_ledger."actorMembershipCreatedAt"
          AND decision_count_row."transactionId" = approved_count_ledger."transactionId"
          AND decision_count_row."decidedAt" = approved_count_ledger."transitionAt"
          AND decision_count_row."createdAt" = approved_count_ledger."createdAt"
      ) = 1;
    END IF;
    RETURN FALSE;
  END IF;

  -- Every runtime transition is still rooted in exactly one approved
  -- decision and its approved ledger row. Runtime evidence cannot replace
  -- or bypass the approval proof.
  SELECT COUNT(*) INTO approved_count
  FROM "ProjectMcpActionDecision" AS decision
  JOIN "ProjectMcpActionLedger" AS approved_ledger
    ON approved_ledger."projectId" = decision."projectId"
   AND approved_ledger."actionId" = decision."actionId"
   AND approved_ledger."stateVersion" = 2
   AND approved_ledger."statusAfter" = 'approved'
   AND approved_ledger."event" = 'approved'
  WHERE decision."projectId" = action_row."projectId"
    AND decision."actionId" = action_row."id"
    AND decision."decision" = 'approved'
    AND decision."expectedStateVersion" = 1
    AND decision."expectedActionFingerprint" = approved_ledger."actionFingerprint"
    AND decision."actorId" = approved_ledger."actorId"
    AND decision."actorProjectMembershipId" = approved_ledger."actorProjectMembershipId"
    AND decision."actorMembershipCreatedAt" = approved_ledger."actorMembershipCreatedAt"
    AND decision."transactionId" = approved_ledger."transactionId"
    AND decision."decidedAt" = approved_ledger."transitionAt"
    AND decision."createdAt" = approved_ledger."createdAt"
    AND approved_ledger."actionFingerprint" = action_row."actionFingerprint";
  IF approved_count <> 1 THEN RETURN FALSE; END IF;

  SELECT COUNT(*) INTO runtime_count
  FROM "ProjectMcpActionRuntimeLedger" AS runtime
  WHERE runtime."projectId" = action_row."projectId" AND runtime."actionId" = action_row."id";
  expected_runtime_count := CASE WHEN action_row."stateVersion" = 3 THEN 1 ELSE 2 END;
  IF runtime_count <> expected_runtime_count THEN RETURN FALSE; END IF;

  -- A pre-reservation expiry/invalidation is a terminal stateVersion 3
  -- transition and has no attempt. Its runtime row records that transition
  -- directly; it must not be confused with the reservation row below.
  IF action_row."stateVersion" = 3 AND action_row."status" <> 'dispatch_reserved' THEN
    RETURN EXISTS (
      SELECT 1 FROM "ProjectMcpActionRuntimeLedger" AS runtime
      WHERE runtime."projectId" = action_row."projectId"
        AND runtime."actionId" = action_row."id"
        AND runtime."stateVersion" = 3
        AND runtime."event" = action_row."status"::text::"ProjectMcpActionRuntimeLedgerEvent"
        AND runtime."statusBefore" = 'approved'
        AND runtime."statusAfter" = action_row."status"
        AND runtime."actorKind" = 'owner'
        AND runtime."actionFingerprint" = action_row."actionFingerprint"
        AND runtime."definitionFingerprint" = action_row."definitionFingerprint"
        AND runtime."networkFingerprint" = action_row."networkFingerprint"
        AND runtime."credentialFingerprint" = action_row."credentialFingerprint"
        AND runtime."connectionConfigurationRevision" = action_row."connectionConfigurationRevision"
        AND runtime."actorId" = action_row."lastActorId"
        AND runtime."actorProjectMembershipId" = action_row."lastActorProjectMembershipId"
        AND runtime."actorMembershipCreatedAt" = action_row."lastActorMembershipCreatedAt"
        AND runtime."transactionId" = action_row."transitionTransactionId"
        AND runtime."transitionAt" = action_row."transitionAt"
        AND runtime."createdAt" = action_row."transitionAt"
    ) AND NOT EXISTS (
      SELECT 1 FROM "ProjectMcpActionDispatchAttempt"
      WHERE "projectId" = action_row."projectId" AND "actionId" = action_row."id"
    );
  END IF;

  SELECT runtime.* INTO reserved_runtime
  FROM "ProjectMcpActionRuntimeLedger" AS runtime
  WHERE runtime."projectId" = action_row."projectId"
    AND runtime."actionId" = action_row."id"
    AND runtime."stateVersion" = 3;
  IF NOT FOUND
     OR reserved_runtime."event" IS DISTINCT FROM 'reserved'
     OR reserved_runtime."statusBefore" IS DISTINCT FROM 'approved'
     OR reserved_runtime."statusAfter" IS DISTINCT FROM 'dispatch_reserved'
     OR reserved_runtime."actorKind" IS DISTINCT FROM 'owner' THEN RETURN FALSE; END IF;

  SELECT attempt.* INTO attempt_row
  FROM "ProjectMcpActionDispatchAttempt" AS attempt
  WHERE attempt."projectId" = action_row."projectId" AND attempt."actionId" = action_row."id";
  IF NOT FOUND
     OR reserved_runtime."attemptId" IS DISTINCT FROM attempt_row."id"
     OR reserved_runtime."rpcRequestId" IS DISTINCT FROM attempt_row."rpcRequestId"
     OR reserved_runtime."actorId" IS DISTINCT FROM attempt_row."actorId"
     OR reserved_runtime."actorProjectMembershipId" IS DISTINCT FROM attempt_row."actorProjectMembershipId"
     OR reserved_runtime."actorMembershipCreatedAt" IS DISTINCT FROM attempt_row."actorMembershipCreatedAt"
     OR reserved_runtime."actionFingerprint" IS DISTINCT FROM attempt_row."actionFingerprint"
     OR reserved_runtime."definitionFingerprint" IS DISTINCT FROM attempt_row."definitionFingerprint"
     OR reserved_runtime."networkFingerprint" IS DISTINCT FROM attempt_row."networkFingerprint"
     OR reserved_runtime."credentialFingerprint" IS DISTINCT FROM attempt_row."credentialFingerprint"
     OR reserved_runtime."connectionConfigurationRevision" IS DISTINCT FROM attempt_row."connectionConfigurationRevision"
     OR reserved_runtime."transactionId" IS DISTINCT FROM attempt_row."reservationTransactionId"
     OR reserved_runtime."transitionAt" IS DISTINCT FROM attempt_row."reservedAt"
     OR reserved_runtime."createdAt" IS DISTINCT FROM attempt_row."reservedAt" THEN RETURN FALSE; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "ProjectMcpActionRuntimeLedger" AS runtime
    WHERE runtime."projectId" = action_row."projectId" AND runtime."actionId" = action_row."id"
      AND runtime."stateVersion" = 3
      AND runtime."actionFingerprint" = action_row."actionFingerprint"
      AND runtime."definitionFingerprint" = action_row."definitionFingerprint"
      AND runtime."networkFingerprint" = action_row."networkFingerprint"
      AND runtime."credentialFingerprint" = action_row."credentialFingerprint"
      AND runtime."connectionConfigurationRevision" = action_row."connectionConfigurationRevision"
      AND runtime."actorId" = action_row."lastActorId"
      AND runtime."actorProjectMembershipId" = action_row."lastActorProjectMembershipId"
      AND runtime."actorMembershipCreatedAt" = action_row."lastActorMembershipCreatedAt"
      AND runtime."statusAfter" = 'dispatch_reserved'::"ProjectMcpActionStatus"
  ) THEN RETURN FALSE; END IF;
  IF action_row."status" = 'dispatch_reserved' THEN
    RETURN attempt_row."status" = 'reserved';
  END IF;
  IF action_row."stateVersion" <> 4 THEN RETURN FALSE; END IF;
  SELECT runtime.* INTO latest_runtime
  FROM "ProjectMcpActionRuntimeLedger" AS runtime
  WHERE runtime."projectId" = action_row."projectId" AND runtime."actionId" = action_row."id" AND runtime."stateVersion" = 4;
  IF NOT FOUND OR latest_runtime."event" IS DISTINCT FROM action_row."status"::text::"ProjectMcpActionRuntimeLedgerEvent"
     OR latest_runtime."statusBefore" IS DISTINCT FROM 'dispatch_reserved'
     OR latest_runtime."statusAfter" IS DISTINCT FROM action_row."status"
     OR latest_runtime."actionFingerprint" IS DISTINCT FROM action_row."actionFingerprint"
     OR latest_runtime."transitionAt" IS DISTINCT FROM action_row."transitionAt"
     OR latest_runtime."createdAt" IS DISTINCT FROM action_row."transitionAt"
     OR latest_runtime."transactionId" IS DISTINCT FROM action_row."transitionTransactionId"
     OR latest_runtime."attemptId" IS DISTINCT FROM attempt_row."id"
     OR latest_runtime."rpcRequestId" IS DISTINCT FROM attempt_row."rpcRequestId"
     OR latest_runtime."actorId" IS DISTINCT FROM action_row."lastActorId"
     OR latest_runtime."actorProjectMembershipId" IS DISTINCT FROM action_row."lastActorProjectMembershipId"
     OR latest_runtime."actorMembershipCreatedAt" IS DISTINCT FROM action_row."lastActorMembershipCreatedAt"
     OR latest_runtime."actorKind" NOT IN ('owner', 'system_recovery')
     OR attempt_row."status" IS DISTINCT FROM action_row."status"::text::"ProjectMcpActionDispatchAttemptStatus" THEN RETURN FALSE; END IF;
  IF action_row."status" = 'succeeded' THEN
    RETURN EXISTS (
      SELECT 1
      FROM "ProjectMcpActionDispatchAttempt" AS attempt
      JOIN "ProjectMcpActionDispatchResult" AS result
        ON result."projectId" = attempt."projectId" AND result."actionId" = attempt."actionId"
      WHERE attempt."projectId" = action_row."projectId"
        AND attempt."actionId" = action_row."id"
        AND attempt."status" = 'succeeded'
        AND attempt."resultFingerprint" = result."resultFingerprint"
        AND attempt."resultBytes" = result."resultBytes"
        AND attempt."resultNodes" = result."resultNodes"
        AND attempt."resultDepth" = result."resultDepth"
        AND latest_runtime."resultFingerprint" = result."resultFingerprint"
        AND latest_runtime."resultBytes" = result."resultBytes"
        AND latest_runtime."resultNodes" = result."resultNodes"
        AND latest_runtime."resultDepth" = result."resultDepth"
    );
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM "ProjectMcpActionDispatchAttempt" AS attempt
    WHERE attempt."projectId" = action_row."projectId"
      AND attempt."actionId" = action_row."id"
      AND attempt."status" = action_row."status"::text::"ProjectMcpActionDispatchAttemptStatus"
      AND attempt."safeErrorCode" IS NOT DISTINCT FROM latest_runtime."safeErrorCode"
      AND attempt."resultFingerprint" IS NOT DISTINCT FROM latest_runtime."resultFingerprint"
      AND attempt."resultBytes" IS NOT DISTINCT FROM latest_runtime."resultBytes"
      AND attempt."resultNodes" IS NOT DISTINCT FROM latest_runtime."resultNodes"
      AND attempt."resultDepth" IS NOT DISTINCT FROM latest_runtime."resultDepth"
  );
END;
$$;

CREATE OR REPLACE FUNCTION "project_mcp_action_dispatch_attempt_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  action_row RECORD;
BEGIN
  SELECT source.* INTO action_row FROM "ProjectMcpAction" AS source WHERE source."projectId" = NEW."projectId" AND source."id" = NEW."actionId";
  IF NOT FOUND THEN RAISE EXCEPTION 'PROJECT_MCP_ACTION_DISPATCH_ATTEMPT_ACTION_INVALID' USING ERRCODE = 'check_violation'; END IF;
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'PROJECT_MCP_ACTION_DISPATCH_ATTEMPT_IMMUTABLE' USING ERRCODE = 'check_violation'; END IF;
  IF TG_OP = 'INSERT' THEN
    -- The reservation xid/timestamps and owner epoch are database-owned. The
    -- caller may pass placeholders, but it can never select evidence values.
    NEW."reservationTransactionId" := action_row."transitionTransactionId";
    NEW."reservedAt" := action_row."transitionAt";
    NEW."createdAt" := action_row."transitionAt";
    IF action_row."status" IS DISTINCT FROM 'dispatch_reserved' OR action_row."stateVersion" IS DISTINCT FROM 3
       OR NEW."status" IS DISTINCT FROM 'reserved'
       OR NEW."actorKind" IS DISTINCT FROM 'owner'
       OR NEW."actorId" IS DISTINCT FROM action_row."lastActorId"
       OR NEW."actorProjectMembershipId" IS DISTINCT FROM action_row."lastActorProjectMembershipId"
       OR NEW."actorMembershipCreatedAt" IS DISTINCT FROM action_row."lastActorMembershipCreatedAt"
       OR NEW."actionFingerprint" IS DISTINCT FROM action_row."actionFingerprint"
       OR NEW."definitionFingerprint" IS DISTINCT FROM action_row."definitionFingerprint"
       OR NEW."networkFingerprint" IS DISTINCT FROM action_row."networkFingerprint"
       OR NEW."credentialFingerprint" IS DISTINCT FROM action_row."credentialFingerprint"
       OR NEW."connectionConfigurationRevision" IS DISTINCT FROM action_row."connectionConfigurationRevision"
       OR NEW."reservationTransactionId" IS DISTINCT FROM action_row."transitionTransactionId"
       OR NEW."reservationExpiresAt" <= action_row."transitionAt"
       OR NEW."reservationTokenHash" !~ '^[0-9a-f]{64}$'
       OR NEW."safeErrorCode" IS NOT NULL
       OR NEW."resultFingerprint" IS NOT NULL
       OR NEW."resultBytes" IS NOT NULL
       OR NEW."resultNodes" IS NOT NULL
       OR NEW."resultDepth" IS NOT NULL THEN
      RAISE EXCEPTION 'PROJECT_MCP_ACTION_DISPATCH_ATTEMPT_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."id" IS DISTINCT FROM NEW."id"
     OR OLD."projectId" IS DISTINCT FROM NEW."projectId"
     OR OLD."actionId" IS DISTINCT FROM NEW."actionId"
     OR OLD."actorKind" IS DISTINCT FROM NEW."actorKind"
     OR OLD."actorId" IS DISTINCT FROM NEW."actorId"
     OR OLD."actorProjectMembershipId" IS DISTINCT FROM NEW."actorProjectMembershipId"
     OR OLD."actorMembershipCreatedAt" IS DISTINCT FROM NEW."actorMembershipCreatedAt"
     OR OLD."rpcRequestId" IS DISTINCT FROM NEW."rpcRequestId"
     OR OLD."reservationTokenHash" IS DISTINCT FROM NEW."reservationTokenHash"
     OR OLD."actionFingerprint" IS DISTINCT FROM NEW."actionFingerprint"
     OR OLD."definitionFingerprint" IS DISTINCT FROM NEW."definitionFingerprint"
     OR OLD."networkFingerprint" IS DISTINCT FROM NEW."networkFingerprint"
     OR OLD."credentialFingerprint" IS DISTINCT FROM NEW."credentialFingerprint"
     OR OLD."connectionConfigurationRevision" IS DISTINCT FROM NEW."connectionConfigurationRevision"
     OR OLD."reservationTransactionId" IS DISTINCT FROM NEW."reservationTransactionId"
     OR OLD."reservationExpiresAt" IS DISTINCT FROM NEW."reservationExpiresAt"
     OR OLD."reservedAt" IS DISTINCT FROM NEW."reservedAt"
     OR OLD."createdAt" IS DISTINCT FROM NEW."createdAt" THEN
    RAISE EXCEPTION 'PROJECT_MCP_ACTION_DISPATCH_ATTEMPT_IMMUTABLE' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" = 'reserved' AND NEW."status" = 'reserved' THEN
    IF action_row."status" IS DISTINCT FROM 'dispatch_reserved' OR action_row."stateVersion" IS DISTINCT FROM 3 THEN
      RAISE EXCEPTION 'PROJECT_MCP_ACTION_DISPATCH_ATTEMPT_STATE_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."safeErrorCode" IS NOT NULL
       OR NEW."httpStatus" IS NOT NULL
       OR NEW."resultFingerprint" IS NOT NULL
       OR NEW."resultBytes" IS NOT NULL
       OR NEW."resultNodes" IS NOT NULL
       OR NEW."resultDepth" IS NOT NULL
       OR NEW."completedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'PROJECT_MCP_ACTION_DISPATCH_ATTEMPT_STATE_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."boundaryReachedAt" IS NOT NULL AND NEW."boundaryReachedAt" IS DISTINCT FROM OLD."boundaryReachedAt" THEN
      RAISE EXCEPTION 'PROJECT_MCP_ACTION_DISPATCH_ATTEMPT_IMMUTABLE' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."boundaryReachedAt" IS NULL AND NEW."boundaryReachedAt" IS NOT NULL THEN
      NEW."boundaryReachedAt" := (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3);
    END IF;
    RETURN NEW;
  END IF;
  -- A successful result row is inserted first, then an AFTER INSERT trigger
  -- copies its database-derived metrics into the already-terminal attempt.
  -- Permit that one DB-owned synchronization while rejecting arbitrary
  -- same-status metric edits (the result row must already contain exactly
  -- the proposed values).
  IF OLD."status" = 'succeeded' AND NEW."status" = 'succeeded' THEN
    IF action_row."status" IS DISTINCT FROM 'succeeded'
       OR action_row."stateVersion" IS DISTINCT FROM 4
       OR NEW."safeErrorCode" IS DISTINCT FROM OLD."safeErrorCode"
       OR NEW."httpStatus" IS DISTINCT FROM OLD."httpStatus"
       OR NEW."boundaryReachedAt" IS DISTINCT FROM OLD."boundaryReachedAt"
       OR NOT EXISTS (
         SELECT 1
         FROM "ProjectMcpActionDispatchResult" AS result
         WHERE result."projectId" = OLD."projectId"
           AND result."actionId" = OLD."actionId"
           AND result."resultFingerprint" IS NOT DISTINCT FROM NEW."resultFingerprint"
           AND result."resultBytes" IS NOT DISTINCT FROM NEW."resultBytes"
           AND result."resultNodes" IS NOT DISTINCT FROM NEW."resultNodes"
           AND result."resultDepth" IS NOT DISTINCT FROM NEW."resultDepth"
       ) THEN
      RAISE EXCEPTION 'PROJECT_MCP_ACTION_DISPATCH_ATTEMPT_STATE_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    NEW."completedAt" := action_row."transitionAt";
    RETURN NEW;
  END IF;
  IF OLD."status" <> 'reserved'
     OR NEW."status" NOT IN ('succeeded', 'failed', 'unknown', 'expired', 'invalidated')
     OR action_row."stateVersion" IS DISTINCT FROM 4
     OR action_row."status"::text IS DISTINCT FROM NEW."status"::text
     OR (NEW."status" = 'succeeded' AND OLD."boundaryReachedAt" IS NULL) THEN
    RAISE EXCEPTION 'PROJECT_MCP_ACTION_DISPATCH_ATTEMPT_STATE_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'succeeded' AND NEW."safeErrorCode" IS NOT NULL)
     OR (NEW."status" <> 'succeeded' AND NEW."safeErrorCode" IS NULL)
     OR (NEW."status" <> 'succeeded' AND (
       NEW."resultFingerprint" IS NOT NULL
       OR NEW."resultBytes" IS NOT NULL
       OR NEW."resultNodes" IS NOT NULL
       OR NEW."resultDepth" IS NOT NULL
     )) THEN
    RAISE EXCEPTION 'PROJECT_MCP_ACTION_DISPATCH_ATTEMPT_EVIDENCE_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."boundaryReachedAt" IS DISTINCT FROM OLD."boundaryReachedAt" THEN
    RAISE EXCEPTION 'PROJECT_MCP_ACTION_DISPATCH_ATTEMPT_IMMUTABLE' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" = NEW."status" THEN
    IF action_row."status" = 'succeeded'
       AND NOT EXISTS (
         SELECT 1 FROM "ProjectMcpActionDispatchResult"
         WHERE "projectId" = OLD."projectId" AND "actionId" = OLD."actionId"
       )
       AND (NEW."safeErrorCode" IS DISTINCT FROM OLD."safeErrorCode"
         OR NEW."httpStatus" IS DISTINCT FROM OLD."httpStatus") THEN
      RAISE EXCEPTION 'PROJECT_MCP_ACTION_DISPATCH_ATTEMPT_IMMUTABLE' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT (action_row."status" = 'succeeded'
      AND NOT EXISTS (
        SELECT 1 FROM "ProjectMcpActionDispatchResult"
        WHERE "projectId" = OLD."projectId" AND "actionId" = OLD."actionId"
      ))
      AND (NEW."safeErrorCode" IS DISTINCT FROM OLD."safeErrorCode"
        OR NEW."httpStatus" IS DISTINCT FROM OLD."httpStatus"
        OR NEW."resultFingerprint" IS DISTINCT FROM OLD."resultFingerprint"
        OR NEW."resultBytes" IS DISTINCT FROM OLD."resultBytes"
        OR NEW."resultNodes" IS DISTINCT FROM OLD."resultNodes"
        OR NEW."resultDepth" IS DISTINCT FROM OLD."resultDepth") THEN
      RAISE EXCEPTION 'PROJECT_MCP_ACTION_DISPATCH_ATTEMPT_IMMUTABLE' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  NEW."completedAt" := action_row."transitionAt";
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ProjectMcpActionDispatchAttempt_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "ProjectMcpActionDispatchAttempt"
FOR EACH ROW EXECUTE FUNCTION "project_mcp_action_dispatch_attempt_guard"();

CREATE OR REPLACE FUNCTION "project_mcp_action_runtime_ledger_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  action_row RECORD;
  expected_event "ProjectMcpActionRuntimeLedgerEvent";
  derived_actor_kind "ProjectMcpActionRuntimeActorKind";
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'PROJECT_MCP_ACTION_RUNTIME_LEDGER_IMMUTABLE' USING ERRCODE = 'check_violation'; END IF;
  SELECT source.* INTO action_row FROM "ProjectMcpAction" AS source WHERE source."projectId" = NEW."projectId" AND source."id" = NEW."actionId";
  IF NOT FOUND THEN RAISE EXCEPTION 'PROJECT_MCP_ACTION_RUNTIME_LEDGER_ACTION_INVALID' USING ERRCODE = 'check_violation'; END IF;
  -- Runtime xid/time and the actor epoch are copied from the action under the
  -- same DB transaction. Raw SQL cannot forge these scalar evidence fields.
  NEW."actorId" := action_row."lastActorId";
  NEW."actorProjectMembershipId" := action_row."lastActorProjectMembershipId";
  NEW."actorMembershipCreatedAt" := action_row."lastActorMembershipCreatedAt";
  NEW."transactionId" := action_row."transitionTransactionId";
  NEW."transitionAt" := action_row."transitionAt";
  NEW."createdAt" := action_row."transitionAt";
  -- The actor classification is derived from the committed transition facts,
  -- never from a session setting or a caller-supplied principal claim. A
  -- stale reservation is the sole system-owned transition; every other row
  -- is owner-attributed and retains the original owner epoch as subject data.
  derived_actor_kind := 'owner'::"ProjectMcpActionRuntimeActorKind";
  IF action_row."status" = 'unknown'
     AND action_row."stateVersion" = 4
     AND NEW."event" = 'unknown'
     AND NEW."statusBefore" = 'dispatch_reserved'
     AND NEW."statusAfter" = 'unknown'
     AND NEW."safeErrorCode" = 'MCP_DISPATCH_RESERVATION_STALE'
     AND EXISTS (
       SELECT 1
       FROM "ProjectMcpActionDispatchAttempt" AS stale_attempt
       WHERE stale_attempt."id" = NEW."attemptId"
         AND stale_attempt."projectId" = NEW."projectId"
         AND stale_attempt."actionId" = NEW."actionId"
         AND stale_attempt."actorKind" = 'owner'
         AND stale_attempt."status" = 'unknown'
         AND stale_attempt."reservationExpiresAt" <= (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3)
         AND stale_attempt."rpcRequestId" = NEW."rpcRequestId"
     ) THEN
    derived_actor_kind := 'system_recovery'::"ProjectMcpActionRuntimeActorKind";
  END IF;
  NEW."actorKind" := derived_actor_kind;
  IF NEW."stateVersion" IS DISTINCT FROM action_row."stateVersion"
     OR NEW."statusAfter" IS DISTINCT FROM action_row."status"
     OR NEW."actionFingerprint" IS DISTINCT FROM action_row."actionFingerprint"
     OR NEW."definitionFingerprint" IS DISTINCT FROM action_row."definitionFingerprint"
     OR NEW."networkFingerprint" IS DISTINCT FROM action_row."networkFingerprint"
     OR NEW."credentialFingerprint" IS DISTINCT FROM action_row."credentialFingerprint"
     OR NEW."connectionConfigurationRevision" IS DISTINCT FROM action_row."connectionConfigurationRevision"
     OR NEW."transactionId" <> action_row."transitionTransactionId"
     OR NEW."transitionAt" IS DISTINCT FROM action_row."transitionAt" THEN
    RAISE EXCEPTION 'PROJECT_MCP_ACTION_RUNTIME_LEDGER_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  expected_event := CASE action_row."status"::text
    WHEN 'dispatch_reserved' THEN 'reserved'
    WHEN 'succeeded' THEN 'succeeded'
    WHEN 'failed' THEN 'failed'
    WHEN 'unknown' THEN 'unknown'
    WHEN 'expired' THEN 'expired'
    WHEN 'invalidated' THEN 'invalidated'
  END::"ProjectMcpActionRuntimeLedgerEvent";
  IF NEW."event" IS DISTINCT FROM expected_event THEN RAISE EXCEPTION 'PROJECT_MCP_ACTION_RUNTIME_LEDGER_INVALID' USING ERRCODE = 'check_violation'; END IF;
  IF (action_row."stateVersion" = 3 AND NEW."statusBefore" IS DISTINCT FROM 'approved')
     OR (action_row."stateVersion" = 4 AND NEW."statusBefore" IS DISTINCT FROM 'dispatch_reserved') THEN
    RAISE EXCEPTION 'PROJECT_MCP_ACTION_RUNTIME_LEDGER_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  IF (action_row."status" IN ('dispatch_reserved', 'succeeded') AND NEW."safeErrorCode" IS NOT NULL)
     OR (action_row."status" NOT IN ('dispatch_reserved', 'succeeded') AND NEW."safeErrorCode" IS NULL)
     OR (action_row."status" = 'succeeded' AND (
       NEW."resultFingerprint" IS NULL OR NEW."resultBytes" IS NULL OR NEW."resultNodes" IS NULL OR NEW."resultDepth" IS NULL
     ))
     OR (action_row."status" <> 'succeeded' AND (
       NEW."resultFingerprint" IS NOT NULL OR NEW."resultBytes" IS NOT NULL OR NEW."resultNodes" IS NOT NULL OR NEW."resultDepth" IS NOT NULL
     )) THEN
    RAISE EXCEPTION 'PROJECT_MCP_ACTION_RUNTIME_LEDGER_EVIDENCE_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  IF action_row."status" = 'dispatch_reserved' AND (NEW."stateVersion" <> 3 OR NEW."attemptId" IS NULL OR NEW."rpcRequestId" IS NULL) THEN
    RAISE EXCEPTION 'PROJECT_MCP_ACTION_RUNTIME_LEDGER_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  IF action_row."stateVersion" = 4 AND (NEW."attemptId" IS NULL OR NEW."rpcRequestId" IS NULL) THEN
    RAISE EXCEPTION 'PROJECT_MCP_ACTION_RUNTIME_LEDGER_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ProjectMcpActionRuntimeLedger_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "ProjectMcpActionRuntimeLedger"
FOR EACH ROW EXECUTE FUNCTION "project_mcp_action_runtime_ledger_guard"();

CREATE OR REPLACE FUNCTION "project_mcp_action_result_nodes"(payload JSONB)
RETURNS INTEGER
LANGUAGE sql
IMMUTABLE
AS $$
  WITH RECURSIVE walk(value, depth) AS (
    SELECT payload, 0
    UNION ALL
    SELECT child.value, walk.depth + 1
    FROM walk
    CROSS JOIN LATERAL (
      SELECT entry.value
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(walk.value) = 'array' THEN walk.value ELSE '[]'::jsonb END) AS entry(value)
      UNION ALL
      SELECT entry.value
      FROM jsonb_each(CASE WHEN jsonb_typeof(walk.value) = 'object' THEN walk.value ELSE '{}'::jsonb END) AS entry(key, value)
    ) AS child
  )
  SELECT COUNT(*)::integer FROM walk;
$$;

CREATE OR REPLACE FUNCTION "project_mcp_action_result_depth"(payload JSONB)
RETURNS INTEGER
LANGUAGE sql
IMMUTABLE
AS $$
  WITH RECURSIVE walk(value, depth) AS (
    SELECT payload, 0
    UNION ALL
    SELECT child.value, walk.depth + 1
    FROM walk
    CROSS JOIN LATERAL (
      SELECT entry.value
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(walk.value) = 'array' THEN walk.value ELSE '[]'::jsonb END) AS entry(value)
      UNION ALL
      SELECT entry.value
      FROM jsonb_each(CASE WHEN jsonb_typeof(walk.value) = 'object' THEN walk.value ELSE '{}'::jsonb END) AS entry(key, value)
    ) AS child
  )
  SELECT COALESCE(MAX(depth), 0)::integer FROM walk;
$$;

CREATE OR REPLACE FUNCTION "project_mcp_action_dispatch_result_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  action_row RECORD;
  attempt_row RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Direct result deletion would leave a succeeded action without its
    -- payload.  The only permitted deletion path is the FK cascade from a
    -- missing action or project parent; the parent-existence check is the
    -- authorization boundary rather than trigger depth (which a caller may
    -- influence with an unrelated trigger).
    IF NOT EXISTS (SELECT 1 FROM "Project" WHERE "id" = OLD."projectId")
       OR NOT EXISTS (
         SELECT 1 FROM "ProjectMcpAction"
         WHERE "projectId" = OLD."projectId" AND "id" = OLD."actionId"
       ) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'PROJECT_MCP_ACTION_DISPATCH_RESULT_IMMUTABLE' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'PROJECT_MCP_ACTION_DISPATCH_RESULT_IMMUTABLE' USING ERRCODE = 'check_violation'; END IF;
  SELECT source.* INTO action_row FROM "ProjectMcpAction" AS source WHERE source."projectId" = NEW."projectId" AND source."id" = NEW."actionId";
  IF NOT FOUND THEN RAISE EXCEPTION 'PROJECT_MCP_ACTION_DISPATCH_RESULT_INVALID' USING ERRCODE = 'check_violation'; END IF;
  SELECT attempt.* INTO attempt_row FROM "ProjectMcpActionDispatchAttempt" AS attempt WHERE attempt."projectId" = NEW."projectId" AND attempt."actionId" = NEW."actionId";
  IF NOT FOUND OR action_row."status" IS DISTINCT FROM 'succeeded' OR action_row."stateVersion" IS DISTINCT FROM 4
     OR attempt_row."status" IS DISTINCT FROM 'succeeded'
     OR jsonb_typeof(NEW."sanitizedPayload") IS DISTINCT FROM 'object'
     OR NOT (NEW."sanitizedPayload" ? 'text')
     OR NOT (NEW."sanitizedPayload" ? 'structuredContent')
     OR NOT (NEW."sanitizedPayload" ? 'omittedContentCount')
     OR jsonb_typeof(NEW."sanitizedPayload"->'text') NOT IN ('string', 'null')
     OR jsonb_typeof(NEW."sanitizedPayload"->'omittedContentCount') IS DISTINCT FROM 'number'
     OR (NEW."sanitizedPayload"->>'omittedContentCount') !~ '^[0-9]{1,9}$' THEN
    RAISE EXCEPTION 'PROJECT_MCP_ACTION_DISPATCH_RESULT_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  NEW."resultFingerprint" := encode(digest(convert_to(NEW."sanitizedPayload"::text, 'UTF8'), 'sha256'), 'hex');
  NEW."resultBytes" := octet_length(convert_to(NEW."sanitizedPayload"::text, 'UTF8'));
  -- The client accepts a compact 64 KiB payload. JSONB canonicalization may
  -- reorder/expand representation, so storage has bounded headroom while
  -- remaining finite and protected by the same node/depth limits.
  IF NEW."resultBytes" > 262144 THEN
    RAISE EXCEPTION 'PROJECT_MCP_ACTION_DISPATCH_RESULT_TOO_LARGE' USING ERRCODE = 'check_violation';
  END IF;
  NEW."resultNodes" := "project_mcp_action_result_nodes"(NEW."sanitizedPayload");
  NEW."resultDepth" := "project_mcp_action_result_depth"(NEW."sanitizedPayload");
  NEW."omittedContentCount" := (NEW."sanitizedPayload"->>'omittedContentCount')::integer;
  IF NEW."resultNodes" > 256 OR NEW."resultDepth" > 8 THEN
    RAISE EXCEPTION 'PROJECT_MCP_ACTION_DISPATCH_RESULT_TOO_LARGE' USING ERRCODE = 'check_violation';
  END IF;
  NEW."createdAt" := action_row."transitionAt";
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ProjectMcpActionDispatchResult_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "ProjectMcpActionDispatchResult"
FOR EACH ROW EXECUTE FUNCTION "project_mcp_action_dispatch_result_guard"();

CREATE OR REPLACE FUNCTION "project_mcp_action_dispatch_result_attempt_sync"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE "ProjectMcpActionDispatchAttempt"
  SET "resultFingerprint" = NEW."resultFingerprint",
      "resultBytes" = NEW."resultBytes",
      "resultNodes" = NEW."resultNodes",
      "resultDepth" = NEW."resultDepth"
  WHERE "projectId" = NEW."projectId" AND "actionId" = NEW."actionId";
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ProjectMcpActionDispatchResult_attempt_sync"
AFTER INSERT ON "ProjectMcpActionDispatchResult"
FOR EACH ROW EXECUTE FUNCTION "project_mcp_action_dispatch_result_attempt_sync"();

-- Direct raw action terminalization must have a reserved attempt/runtime
-- record.  The deferred action evidence trigger then verifies the full tuple.
CREATE OR REPLACE FUNCTION "project_mcp_action_dispatch_transition_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD."status" = 'dispatch_reserved'
     AND NEW."status" IN ('succeeded', 'failed', 'unknown', 'expired', 'invalidated')
     AND NOT EXISTS (
       SELECT 1 FROM "ProjectMcpActionDispatchAttempt"
       WHERE "projectId" = OLD."projectId" AND "actionId" = OLD."id"
         AND ("status" = 'reserved' OR "status"::text = NEW."status"::text)
     ) THEN
    RAISE EXCEPTION 'PROJECT_MCP_ACTION_DISPATCH_ATTEMPT_REQUIRED' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "ProjectMcpAction_dispatch_transition_guard"
AFTER UPDATE OF "status" ON "ProjectMcpAction"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "project_mcp_action_dispatch_transition_guard"();

CREATE OR REPLACE FUNCTION "project_mcp_action_project_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD."archivedAt" IS NULL
     AND NEW."archivedAt" IS NOT NULL
     AND EXISTS (SELECT 1 FROM "ProjectMcpAction" WHERE "projectId" = OLD."id" AND "status" IN ('waiting_approval', 'approved', 'dispatch_reserved')) THEN
    RAISE EXCEPTION 'PROJECT_MCP_ACTION_PENDING_ARCHIVE_FORBIDDEN' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE'
     AND EXISTS (SELECT 1 FROM "ProjectMcpAction" WHERE "projectId" = OLD."id" AND "status" IN ('waiting_approval', 'approved', 'dispatch_reserved')) THEN
    RAISE EXCEPTION 'PROJECT_MCP_ACTION_PENDING_DELETE_FORBIDDEN' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
