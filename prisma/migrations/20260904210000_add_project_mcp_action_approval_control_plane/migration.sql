-- Isolated project MCP single-use action proposal and approval control plane.
-- This migration intentionally does not alter ProjectAction or any legacy MCP
-- runtime table.  It records only durable control-plane evidence.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE "ProjectMcpActionStatus" AS ENUM (
  'waiting_approval',
  'approved',
  'rejected',
  'cancelled',
  'dispatch_reserved',
  'succeeded',
  'failed',
  'unknown',
  'expired',
  'invalidated'
);

CREATE TYPE "ProjectMcpActionDecisionKind" AS ENUM ('approved', 'rejected');
CREATE TYPE "ProjectMcpActionLedgerEvent" AS ENUM ('proposed', 'approved', 'rejected', 'cancelled');
CREATE TYPE "ProjectMcpActionRejectReason" AS ENUM (
  'unsafe_arguments',
  'stale_snapshot',
  'not_needed',
  'policy_denied'
);

CREATE TABLE "ProjectMcpAction" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "projectId" UUID NOT NULL,
  "clientRequestId" UUID NOT NULL,
  "grantId" UUID NOT NULL,
  "delegationId" UUID NOT NULL,
  "toolDefinitionId" UUID NOT NULL,
  "attestationId" UUID NOT NULL,
  "connectionId" UUID NOT NULL,
  "toolName" VARCHAR(128) NOT NULL,
  "inputSchema" JSONB NOT NULL,
  "canonicalArguments" JSONB NOT NULL,
  "canonicalArgumentsHash" CHAR(64) NOT NULL,
  "actionFingerprint" CHAR(64) NOT NULL,
  "status" "ProjectMcpActionStatus" NOT NULL DEFAULT 'waiting_approval',
  "stateVersion" INTEGER NOT NULL DEFAULT 1,
  "proposerProjectMembershipId" UUID NOT NULL,
  "proposerMembershipCreatedAt" TIMESTAMP(3) NOT NULL,
  "lastActorId" UUID NOT NULL,
  "lastActorProjectMembershipId" UUID NOT NULL,
  "lastActorMembershipCreatedAt" TIMESTAMP(3) NOT NULL,
  "grantVersion" INTEGER NOT NULL,
  "delegationVersion" INTEGER NOT NULL,
  "attestationVersion" INTEGER NOT NULL,
  "delegationFingerprint" CHAR(64) NOT NULL,
  "definitionFingerprint" CHAR(64) NOT NULL,
  "networkFingerprint" CHAR(64) NOT NULL,
  "credentialFingerprint" CHAR(64) NOT NULL,
  "connectionConfigurationRevision" INTEGER NOT NULL,
  "connectionOwnerId" UUID NOT NULL,
  "connectionOwnershipState" "ResourceOwnershipState" NOT NULL,
  "connectionAllowPrivateNetwork" BOOLEAN NOT NULL,
  "connectionUpdatedAt" TIMESTAMP(3) NOT NULL,
  "credentialUpdatedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "transitionAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "approvedAt" TIMESTAMP(3),
  "approvalExpiresAt" TIMESTAMP(3),
  "rejectedAt" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),
  "creationTransactionId" BIGINT NOT NULL DEFAULT txid_current(),
  "transitionTransactionId" BIGINT NOT NULL DEFAULT txid_current(),
  CONSTRAINT "ProjectMcpAction_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProjectMcpAction_project_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ProjectMcpAction_shape_check" CHECK (
    "stateVersion" > 0
    AND "grantVersion" > 0
    AND "delegationVersion" > 0
    AND "attestationVersion" > 0
    AND "connectionConfigurationRevision" > 0
    AND "toolName" <> ''
    AND "canonicalArgumentsHash" ~ '^[0-9a-f]{64}$'
    AND "actionFingerprint" ~ '^[0-9a-f]{64}$'
    AND "delegationFingerprint" ~ '^[0-9a-f]{64}$'
    AND "definitionFingerprint" ~ '^[0-9a-f]{64}$'
    AND "networkFingerprint" ~ '^[0-9a-f]{64}$'
    AND "credentialFingerprint" ~ '^[0-9a-f]{64}$'
    AND (
      ("status" = 'waiting_approval' AND "stateVersion" = 1 AND "approvedAt" IS NULL AND "approvalExpiresAt" IS NULL AND "rejectedAt" IS NULL AND "cancelledAt" IS NULL)
      OR ("status" = 'approved' AND "stateVersion" >= 2 AND "approvedAt" IS NOT NULL AND "approvalExpiresAt" IS NOT NULL AND "rejectedAt" IS NULL AND "cancelledAt" IS NULL)
      OR ("status" = 'rejected' AND "stateVersion" >= 2 AND "approvedAt" IS NULL AND "approvalExpiresAt" IS NULL AND "rejectedAt" IS NOT NULL AND "cancelledAt" IS NULL)
      OR ("status" = 'cancelled' AND "stateVersion" = 2 AND "cancelledAt" IS NOT NULL AND "approvedAt" IS NULL AND "approvalExpiresAt" IS NULL AND "rejectedAt" IS NULL)
      OR ("status" = 'cancelled' AND "stateVersion" = 3 AND "cancelledAt" IS NOT NULL AND "approvedAt" IS NOT NULL AND "approvalExpiresAt" IS NOT NULL AND "rejectedAt" IS NULL)
      OR ("status" IN ('dispatch_reserved', 'succeeded', 'failed', 'unknown', 'expired', 'invalidated') AND "stateVersion" >= 2)
    )
  )
);

CREATE UNIQUE INDEX "ProjectMcpAction_projectId_clientRequestId_key"
  ON "ProjectMcpAction"("projectId", "clientRequestId");
CREATE UNIQUE INDEX "ProjectMcpAction_projectId_id_key"
  ON "ProjectMcpAction"("projectId", "id");
CREATE INDEX "ProjectMcpAction_projectId_status_createdAt_idx"
  ON "ProjectMcpAction"("projectId", "status", "createdAt");
CREATE INDEX "ProjectMcpAction_projectId_createdAt_idx"
  ON "ProjectMcpAction"("projectId", "createdAt");
CREATE INDEX "ProjectMcpAction_grantId_status_idx"
  ON "ProjectMcpAction"("grantId", "status");

CREATE TABLE "ProjectMcpActionDecision" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "projectId" UUID NOT NULL,
  "actionId" UUID NOT NULL,
  "decision" "ProjectMcpActionDecisionKind" NOT NULL,
  "expectedStateVersion" INTEGER NOT NULL,
  "expectedActionFingerprint" CHAR(64) NOT NULL,
  "actorId" UUID NOT NULL,
  "actorProjectMembershipId" UUID NOT NULL,
  "actorMembershipCreatedAt" TIMESTAMP(3) NOT NULL,
  "reasonCode" "ProjectMcpActionRejectReason",
  "acknowledgedSingleUse" BOOLEAN NOT NULL,
  "transactionId" BIGINT NOT NULL DEFAULT txid_current(),
  "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProjectMcpActionDecision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProjectMcpActionDecision_shape_check" CHECK (
    "expectedStateVersion" > 0
    AND "expectedActionFingerprint" ~ '^[0-9a-f]{64}$'
    AND (("decision" = 'approved' AND "reasonCode" IS NULL AND "acknowledgedSingleUse" = true)
      OR ("decision" = 'rejected' AND "reasonCode" IS NOT NULL AND "acknowledgedSingleUse" = false))
  )
);

CREATE UNIQUE INDEX "ProjectMcpActionDecision_projectId_actionId_key"
  ON "ProjectMcpActionDecision"("projectId", "actionId");
CREATE INDEX "ProjectMcpActionDecision_actorId_createdAt_idx"
  ON "ProjectMcpActionDecision"("actorId", "createdAt");
CREATE INDEX "ProjectMcpActionDecision_projectId_createdAt_idx"
  ON "ProjectMcpActionDecision"("projectId", "createdAt");

CREATE TABLE "ProjectMcpActionLedger" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "projectId" UUID NOT NULL,
  "actionId" UUID NOT NULL,
  "clientRequestId" UUID NOT NULL,
  "grantId" UUID NOT NULL,
  "delegationId" UUID NOT NULL,
  "toolDefinitionId" UUID NOT NULL,
  "attestationId" UUID NOT NULL,
  "connectionId" UUID NOT NULL,
  "toolName" VARCHAR(128) NOT NULL,
  "event" "ProjectMcpActionLedgerEvent" NOT NULL,
  "statusBefore" "ProjectMcpActionStatus",
  "statusAfter" "ProjectMcpActionStatus" NOT NULL,
  "stateVersion" INTEGER NOT NULL,
  "actorId" UUID NOT NULL,
  "actorProjectMembershipId" UUID NOT NULL,
  "actorMembershipCreatedAt" TIMESTAMP(3) NOT NULL,
  "grantVersion" INTEGER NOT NULL,
  "delegationVersion" INTEGER NOT NULL,
  "attestationVersion" INTEGER NOT NULL,
  "delegationFingerprint" CHAR(64) NOT NULL,
  "definitionFingerprint" CHAR(64) NOT NULL,
  "networkFingerprint" CHAR(64) NOT NULL,
  "credentialFingerprint" CHAR(64) NOT NULL,
  "connectionConfigurationRevision" INTEGER NOT NULL,
  "canonicalArgumentsHash" CHAR(64) NOT NULL,
  "actionFingerprint" CHAR(64) NOT NULL,
  "transactionId" BIGINT NOT NULL DEFAULT txid_current(),
  "transitionAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProjectMcpActionLedger_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProjectMcpActionLedger_shape_check" CHECK (
    "stateVersion" > 0
    AND "grantVersion" > 0
    AND "delegationVersion" > 0
    AND "attestationVersion" > 0
    AND "connectionConfigurationRevision" > 0
    AND "toolName" <> ''
    AND "canonicalArgumentsHash" ~ '^[0-9a-f]{64}$'
    AND "actionFingerprint" ~ '^[0-9a-f]{64}$'
    AND "delegationFingerprint" ~ '^[0-9a-f]{64}$'
    AND "definitionFingerprint" ~ '^[0-9a-f]{64}$'
    AND "networkFingerprint" ~ '^[0-9a-f]{64}$'
    AND "credentialFingerprint" ~ '^[0-9a-f]{64}$'
    AND (("event" = 'proposed' AND "stateVersion" = 1 AND "statusBefore" IS NULL AND "statusAfter" = 'waiting_approval')
      OR ("event" = 'approved' AND "stateVersion" >= 2 AND "statusBefore" = 'waiting_approval' AND "statusAfter" = 'approved')
      OR ("event" = 'rejected' AND "stateVersion" >= 2 AND "statusBefore" = 'waiting_approval' AND "statusAfter" = 'rejected')
      OR ("event" = 'cancelled' AND "stateVersion" >= 2 AND "statusBefore" IN ('waiting_approval', 'approved') AND "statusAfter" = 'cancelled'))
  )
);

CREATE UNIQUE INDEX "ProjectMcpActionLedger_actionId_stateVersion_key"
  ON "ProjectMcpActionLedger"("actionId", "stateVersion");
CREATE INDEX "ProjectMcpActionLedger_projectId_createdAt_idx"
  ON "ProjectMcpActionLedger"("projectId", "createdAt");
CREATE INDEX "ProjectMcpActionLedger_actionId_createdAt_idx"
  ON "ProjectMcpActionLedger"("actionId", "createdAt");
CREATE INDEX "ProjectMcpActionLedger_transactionId_createdAt_idx"
  ON "ProjectMcpActionLedger"("transactionId", "createdAt");

CREATE OR REPLACE FUNCTION "project_mcp_action_timestamp_token"(value TIMESTAMP(3))
RETURNS TEXT
LANGUAGE SQL
IMMUTABLE
STRICT
AS $$
  SELECT to_char(value, 'YYYY-MM-DD"T"HH24:MI:SS.MS') || 'Z'
$$;

CREATE OR REPLACE FUNCTION "project_mcp_action_snapshot_fingerprint"(action_row "ProjectMcpAction")
RETURNS TEXT
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN encode(digest(convert_to(concat_ws(E'\x1f',
    'project-mcp-action-fingerprint-v1',
    action_row."projectId"::text,
    action_row."clientRequestId"::text,
    action_row."grantId"::text,
    action_row."delegationId"::text,
    action_row."toolDefinitionId"::text,
    action_row."attestationId"::text,
    action_row."connectionId"::text,
    action_row."toolName",
    action_row."inputSchema"::text,
    action_row."canonicalArgumentsHash",
    action_row."proposerProjectMembershipId"::text,
    "project_mcp_action_timestamp_token"(action_row."proposerMembershipCreatedAt"),
    action_row."grantVersion"::text,
    action_row."delegationVersion"::text,
    action_row."attestationVersion"::text,
    action_row."delegationFingerprint",
    action_row."definitionFingerprint",
    action_row."networkFingerprint",
    action_row."credentialFingerprint",
    action_row."connectionConfigurationRevision"::text,
    action_row."connectionOwnerId"::text,
    action_row."connectionOwnershipState"::text,
    action_row."connectionAllowPrivateNetwork"::text,
    "project_mcp_action_timestamp_token"(action_row."connectionUpdatedAt"),
    COALESCE("project_mcp_action_timestamp_token"(action_row."credentialUpdatedAt"), '')
  ), 'UTF8'), 'sha256'), 'hex');
END;
$$;

CREATE OR REPLACE FUNCTION "project_mcp_action_source_tuple_valid"(action_row "ProjectMcpAction")
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  grant_row "ProjectMcpToolGrant"%ROWTYPE;
BEGIN
  SELECT source.* INTO grant_row
  FROM "ProjectMcpToolGrant" AS source
  WHERE source."id" = action_row."grantId"
    AND source."projectId" = action_row."projectId"
    AND source."controlPlaneVersion" = 2;
  IF NOT FOUND OR NOT "project_mcp_tool_grant_v2_tuple_valid"(grant_row) THEN
    RETURN FALSE;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM "ProjectMcpConnectionDelegation" AS delegation
    JOIN "McpConnection" AS connection
      ON connection."id" = grant_row."connectionId"
    JOIN "McpToolDefinition" AS definition
      ON definition."id" = grant_row."toolDefinitionId"
     AND definition."connectionId" = grant_row."connectionId"
     AND definition."name" = grant_row."toolName"
    JOIN "McpToolAttestation" AS attestation
      ON attestation."id" = grant_row."attestationId"
    LEFT JOIN "ExternalCredential" AS credential
      ON credential."id" = connection."credentialId"
    JOIN "ProjectMembership" AS proposer_membership
      ON proposer_membership."id" = action_row."proposerProjectMembershipId"
    JOIN "AppUser" AS proposer
      ON proposer."id" = proposer_membership."userId"
    JOIN "ProjectMembership" AS last_actor_membership
      ON last_actor_membership."id" = action_row."lastActorProjectMembershipId"
    JOIN "AppUser" AS last_actor
      ON last_actor."id" = action_row."lastActorId"
    WHERE delegation."id" = grant_row."delegationId"
      AND delegation."projectId" = action_row."projectId"
      AND action_row."projectId" = grant_row."projectId"
      AND action_row."grantId" = grant_row."id"
      AND action_row."delegationId" = grant_row."delegationId"
      AND action_row."toolDefinitionId" = grant_row."toolDefinitionId"
      AND action_row."attestationId" = grant_row."attestationId"
      AND action_row."connectionId" = grant_row."connectionId"
      AND action_row."toolName" = grant_row."toolName"
      AND action_row."inputSchema" IS NOT DISTINCT FROM definition."inputSchema"
      AND action_row."grantVersion" = grant_row."grantVersion"
      AND action_row."delegationVersion" = grant_row."delegationVersion"
      AND action_row."attestationVersion" = attestation."version"
      AND action_row."delegationFingerprint" = grant_row."delegationFingerprint"
      AND action_row."definitionFingerprint" = grant_row."definitionFingerprint"
      AND action_row."networkFingerprint" = grant_row."networkFingerprint"
      AND action_row."credentialFingerprint" = grant_row."credentialFingerprint"
      AND action_row."connectionConfigurationRevision" = grant_row."connectionConfigurationRevision"
      AND action_row."connectionOwnerId" = connection."ownerUserId"
      AND action_row."connectionOwnershipState" = connection."ownershipState"
      AND action_row."connectionAllowPrivateNetwork" = connection."allowPrivateNetwork"
      AND action_row."connectionUpdatedAt" = connection."updatedAt"
      AND action_row."credentialUpdatedAt" IS NOT DISTINCT FROM credential."updatedAt"
      AND proposer_membership."projectId" = action_row."projectId"
      AND proposer_membership."role" = 'owner'
      AND proposer_membership."accessState" = 'confirmed'
      AND proposer_membership."createdAt" = action_row."proposerMembershipCreatedAt"
      AND proposer."id" = proposer_membership."userId"
      AND last_actor_membership."projectId" = action_row."projectId"
      AND last_actor_membership."userId" = action_row."lastActorId"
      AND last_actor_membership."role" = 'owner'
      AND last_actor_membership."accessState" = 'confirmed'
      AND last_actor_membership."createdAt" = action_row."lastActorMembershipCreatedAt"
      AND last_actor."id" = action_row."lastActorId"
      AND proposer."disabledAt" IS NULL
      AND last_actor."disabledAt" IS NULL
  );
END;
$$;

CREATE OR REPLACE FUNCTION "project_mcp_action_actor_valid"(project_id UUID, actor_id UUID, membership_id UUID, membership_created_at TIMESTAMP(3))
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1
    FROM "ProjectMembership" AS membership
    JOIN "AppUser" AS actor ON actor."id" = membership."userId"
    WHERE membership."id" = membership_id
      AND membership."projectId" = project_id
      AND membership."role" = 'owner'
      AND membership."accessState" = 'confirmed'
      AND membership."createdAt" = membership_created_at
      AND actor."id" = actor_id
      AND actor."disabledAt" IS NULL
  );
END;
$$;

CREATE OR REPLACE FUNCTION "project_mcp_action_ledger_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  action_row RECORD;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'PROJECT_MCP_ACTION_LEDGER_IMMUTABLE' USING ERRCODE = 'check_violation';
  END IF;

  SELECT source.* INTO action_row
  FROM "ProjectMcpAction" AS source
  WHERE source."id" = NEW."actionId" AND source."projectId" = NEW."projectId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROJECT_MCP_ACTION_LEDGER_ACTION_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."clientRequestId" IS DISTINCT FROM action_row."clientRequestId"
     OR NEW."grantId" IS DISTINCT FROM action_row."grantId"
     OR NEW."delegationId" IS DISTINCT FROM action_row."delegationId"
     OR NEW."toolDefinitionId" IS DISTINCT FROM action_row."toolDefinitionId"
     OR NEW."attestationId" IS DISTINCT FROM action_row."attestationId"
     OR NEW."connectionId" IS DISTINCT FROM action_row."connectionId"
     OR NEW."toolName" IS DISTINCT FROM action_row."toolName"
     OR NEW."grantVersion" IS DISTINCT FROM action_row."grantVersion"
     OR NEW."delegationVersion" IS DISTINCT FROM action_row."delegationVersion"
     OR NEW."attestationVersion" IS DISTINCT FROM action_row."attestationVersion"
     OR NEW."delegationFingerprint" IS DISTINCT FROM action_row."delegationFingerprint"
     OR NEW."definitionFingerprint" IS DISTINCT FROM action_row."definitionFingerprint"
     OR NEW."networkFingerprint" IS DISTINCT FROM action_row."networkFingerprint"
     OR NEW."credentialFingerprint" IS DISTINCT FROM action_row."credentialFingerprint"
     OR NEW."connectionConfigurationRevision" IS DISTINCT FROM action_row."connectionConfigurationRevision"
     OR NEW."canonicalArgumentsHash" IS DISTINCT FROM action_row."canonicalArgumentsHash"
     OR NEW."actionFingerprint" IS DISTINCT FROM action_row."actionFingerprint"
     OR NEW."stateVersion" IS DISTINCT FROM action_row."stateVersion"
     OR NEW."statusAfter" IS DISTINCT FROM action_row."status"
     OR NEW."actorId" IS DISTINCT FROM action_row."lastActorId"
     OR NEW."actorProjectMembershipId" IS DISTINCT FROM action_row."lastActorProjectMembershipId"
     OR NEW."actorMembershipCreatedAt" IS DISTINCT FROM action_row."lastActorMembershipCreatedAt" THEN
    RAISE EXCEPTION 'PROJECT_MCP_ACTION_LEDGER_STATE_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."event" = 'proposed' THEN
    IF action_row."stateVersion" <> 1 OR action_row."creationTransactionId" <> txid_current() THEN
      RAISE EXCEPTION 'PROJECT_MCP_ACTION_PROPOSAL_LEDGER_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF action_row."transitionTransactionId" <> txid_current() THEN
    RAISE EXCEPTION 'PROJECT_MCP_ACTION_TRANSITION_LEDGER_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  IF action_row."transitionTransactionId" <> txid_current() THEN
    RAISE EXCEPTION 'PROJECT_MCP_ACTION_LEDGER_TRANSACTION_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  NEW."transactionId" := txid_current();
  NEW."transitionAt" := action_row."transitionAt";
  NEW."createdAt" := action_row."transitionAt";
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ProjectMcpActionLedger_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "ProjectMcpActionLedger"
FOR EACH ROW EXECUTE FUNCTION "project_mcp_action_ledger_guard"();

CREATE OR REPLACE FUNCTION "project_mcp_action_decision_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  action_row RECORD;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'PROJECT_MCP_ACTION_DECISION_IMMUTABLE' USING ERRCODE = 'check_violation';
  END IF;
  SELECT source.* INTO action_row
  FROM "ProjectMcpAction" AS source
  WHERE source."id" = NEW."actionId" AND source."projectId" = NEW."projectId";
  IF NOT FOUND
     OR NEW."expectedActionFingerprint" IS DISTINCT FROM action_row."actionFingerprint"
     OR NEW."expectedStateVersion" + 1 IS DISTINCT FROM action_row."stateVersion"
     OR (NEW."decision" = 'approved' AND action_row."status" IS DISTINCT FROM 'approved')
     OR (NEW."decision" = 'rejected' AND action_row."status" IS DISTINCT FROM 'rejected')
     OR action_row."transitionTransactionId" <> txid_current()
     OR action_row."lastActorId" IS DISTINCT FROM NEW."actorId"
     OR action_row."lastActorProjectMembershipId" IS DISTINCT FROM NEW."actorProjectMembershipId"
     OR action_row."lastActorMembershipCreatedAt" IS DISTINCT FROM NEW."actorMembershipCreatedAt"
     OR NOT "project_mcp_action_actor_valid"(NEW."projectId", NEW."actorId", NEW."actorProjectMembershipId", NEW."actorMembershipCreatedAt") THEN
    RAISE EXCEPTION 'PROJECT_MCP_ACTION_DECISION_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  NEW."transactionId" := txid_current();
  NEW."decidedAt" := action_row."transitionAt";
  NEW."createdAt" := action_row."transitionAt";
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ProjectMcpActionDecision_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "ProjectMcpActionDecision"
FOR EACH ROW EXECUTE FUNCTION "project_mcp_action_decision_guard"();

CREATE OR REPLACE FUNCTION "project_mcp_action_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  transition_time TIMESTAMP(3);
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" IN ('waiting_approval', 'approved') THEN
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
  IF NEW."stateVersion" IS DISTINCT FROM OLD."stateVersion" + 1
     OR NOT "project_mcp_action_actor_valid"(NEW."projectId", NEW."lastActorId", NEW."lastActorProjectMembershipId", NEW."lastActorMembershipCreatedAt") THEN
    RAISE EXCEPTION 'PROJECT_MCP_ACTION_TRANSITION_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT ((OLD."status" = 'waiting_approval' AND NEW."status" IN ('approved', 'rejected', 'cancelled'))
       OR (OLD."status" = 'approved' AND NEW."status" = 'cancelled')) THEN
    RAISE EXCEPTION 'PROJECT_MCP_ACTION_STATE_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'approved' AND NOT "project_mcp_action_source_tuple_valid"(NEW) THEN
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
  END IF;
  NEW."transitionTransactionId" := txid_current();
  NEW."transitionAt" := transition_time;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ProjectMcpAction_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "ProjectMcpAction"
FOR EACH ROW EXECUTE FUNCTION "project_mcp_action_guard"();

CREATE OR REPLACE FUNCTION "project_mcp_action_evidence_valid"(action_row "ProjectMcpAction")
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  ledger_count BIGINT;
  decision_count BIGINT;
BEGIN
  SELECT COUNT(*) INTO ledger_count
  FROM "ProjectMcpActionLedger" AS ledger
  WHERE ledger."projectId" = action_row."projectId" AND ledger."actionId" = action_row."id";
  IF ledger_count <> action_row."stateVersion" THEN
    RETURN FALSE;
  END IF;
  IF EXISTS (
    SELECT version
    FROM generate_series(1, action_row."stateVersion") AS version
    WHERE NOT EXISTS (
      SELECT 1 FROM "ProjectMcpActionLedger" AS ledger
      WHERE ledger."projectId" = action_row."projectId"
        AND ledger."actionId" = action_row."id"
        AND ledger."stateVersion" = version
    )
  ) THEN
    RETURN FALSE;
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
  ) THEN
    RETURN FALSE;
  END IF;

  SELECT COUNT(*) INTO ledger_count
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
  IF ledger_count <> 1 THEN
    RETURN FALSE;
  END IF;

  IF action_row."status" = 'waiting_approval' THEN
    SELECT COUNT(*) INTO decision_count
    FROM "ProjectMcpActionDecision" AS decision
    WHERE decision."projectId" = action_row."projectId" AND decision."actionId" = action_row."id";
    RETURN decision_count = 0;
  END IF;

  IF action_row."status" IN ('approved', 'rejected') THEN
    SELECT COUNT(*) INTO decision_count
    FROM "ProjectMcpActionDecision" AS decision
    JOIN "ProjectMcpActionLedger" AS decision_ledger
      ON decision_ledger."projectId" = decision."projectId"
     AND decision_ledger."actionId" = decision."actionId"
     AND decision_ledger."stateVersion" = action_row."stateVersion"
     AND decision_ledger."statusAfter" = action_row."status"
     AND decision_ledger."event" = CASE WHEN action_row."status" = 'approved' THEN 'approved'::"ProjectMcpActionLedgerEvent" ELSE 'rejected'::"ProjectMcpActionLedgerEvent" END
    WHERE decision."projectId" = action_row."projectId"
      AND decision."actionId" = action_row."id"
      AND decision."decision" = CASE WHEN action_row."status" = 'approved' THEN 'approved'::"ProjectMcpActionDecisionKind" ELSE 'rejected'::"ProjectMcpActionDecisionKind" END
      AND decision."expectedStateVersion" = action_row."stateVersion" - 1
      AND decision."expectedActionFingerprint" = action_row."actionFingerprint"
      AND decision."actorId" = action_row."lastActorId"
      AND decision."actorProjectMembershipId" = action_row."lastActorProjectMembershipId"
      AND decision."actorMembershipCreatedAt" = action_row."lastActorMembershipCreatedAt"
      AND decision."transactionId" = action_row."transitionTransactionId"
      AND decision."decidedAt" = decision_ledger."transitionAt"
      AND decision."createdAt" = decision_ledger."createdAt";
    RETURN decision_count = 1;
  END IF;

  IF action_row."status" = 'cancelled' THEN
    IF action_row."stateVersion" = 2 THEN
      SELECT COUNT(*) INTO decision_count
      FROM "ProjectMcpActionDecision" AS decision
      WHERE decision."projectId" = action_row."projectId" AND decision."actionId" = action_row."id";
      RETURN decision_count = 0;
    END IF;
    SELECT COUNT(*) INTO decision_count
    FROM "ProjectMcpActionDecision" AS decision
    JOIN "ProjectMcpActionLedger" AS approved_ledger
      ON approved_ledger."projectId" = decision."projectId"
     AND approved_ledger."actionId" = decision."actionId"
     AND approved_ledger."event" = 'approved'
     AND approved_ledger."stateVersion" = action_row."stateVersion" - 1
    WHERE decision."projectId" = action_row."projectId"
      AND decision."actionId" = action_row."id"
      AND decision."decision" = 'approved'
      AND decision."expectedStateVersion" = approved_ledger."stateVersion" - 1
      AND decision."expectedActionFingerprint" = approved_ledger."actionFingerprint"
      AND decision."actorId" = approved_ledger."actorId"
      AND decision."actorProjectMembershipId" = approved_ledger."actorProjectMembershipId"
      AND decision."actorMembershipCreatedAt" = approved_ledger."actorMembershipCreatedAt"
      AND decision."transactionId" = approved_ledger."transactionId"
      AND decision."decidedAt" = approved_ledger."transitionAt"
      AND decision."createdAt" = approved_ledger."createdAt";
    RETURN decision_count = 1;
  END IF;

  RETURN FALSE;
END;
$$;

CREATE OR REPLACE FUNCTION "project_mcp_action_evidence_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT "project_mcp_action_evidence_valid"(NEW) THEN
    RAISE EXCEPTION 'PROJECT_MCP_ACTION_EVIDENCE_REQUIRED' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "ProjectMcpAction_evidence_guard"
AFTER INSERT OR UPDATE ON "ProjectMcpAction"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "project_mcp_action_evidence_guard"();

CREATE OR REPLACE FUNCTION "project_mcp_action_related_evidence_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  action_row "ProjectMcpAction";
BEGIN
  SELECT source.* INTO action_row
  FROM "ProjectMcpAction" AS source
  WHERE source."projectId" = NEW."projectId" AND source."id" = NEW."actionId";
  IF NOT FOUND THEN
    -- Terminal action/project deletion intentionally retains scalar evidence.
    RETURN NEW;
  END IF;
  IF NOT "project_mcp_action_evidence_valid"(action_row) THEN
    RAISE EXCEPTION 'PROJECT_MCP_ACTION_RELATED_EVIDENCE_REQUIRED' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "ProjectMcpActionDecision_evidence_guard"
AFTER INSERT ON "ProjectMcpActionDecision"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "project_mcp_action_related_evidence_guard"();

CREATE CONSTRAINT TRIGGER "ProjectMcpActionLedger_evidence_guard"
AFTER INSERT ON "ProjectMcpActionLedger"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "project_mcp_action_related_evidence_guard"();

CREATE OR REPLACE FUNCTION "project_mcp_action_project_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD."archivedAt" IS NULL
     AND NEW."archivedAt" IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM "ProjectMcpAction"
       WHERE "projectId" = OLD."id" AND "status" IN ('waiting_approval', 'approved')
     ) THEN
    RAISE EXCEPTION 'PROJECT_MCP_ACTION_PENDING_ARCHIVE_FORBIDDEN' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE'
     AND EXISTS (
       SELECT 1 FROM "ProjectMcpAction"
       WHERE "projectId" = OLD."id" AND "status" IN ('waiting_approval', 'approved')
     ) THEN
    RAISE EXCEPTION 'PROJECT_MCP_ACTION_PENDING_DELETE_FORBIDDEN' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Project_mcp_action_project_guard"
BEFORE UPDATE OR DELETE ON "Project"
FOR EACH ROW EXECUTE FUNCTION "project_mcp_action_project_guard"();
