-- Bind every private MCP control-plane snapshot to the connection owner's
-- account access epoch.  A disable/restore transition changes that epoch;
-- historical rows remain durable evidence but cannot become executable again.

LOCK TABLE "McpConnection", "ProjectMcpConnectionDelegation",
  "ProjectMcpConnectionDelegationAudit", "McpToolAttestation",
  "McpToolAttestationAudit", "ProjectMcpToolGrant", "ProjectMcpToolGrantLedger",
  "ProjectMcpToolGrantAudit", "ProjectMcpAction", "ProjectMcpActionLedger",
  "ProjectMcpActionDispatchAttempt", "ProjectMcpActionRuntimeLedger", "AppUser"
  IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE "McpConnection"
  ADD COLUMN "ownerAccountAccessVersion" INTEGER;

ALTER TABLE "ProjectMcpConnectionDelegation"
  ADD COLUMN "connectionOwnerAccountAccessVersion" INTEGER;

ALTER TABLE "ProjectMcpConnectionDelegationAudit"
  ADD COLUMN "connectionOwnerAccountAccessVersion" INTEGER;

ALTER TABLE "McpToolAttestation"
  ADD COLUMN "connectionOwnerAccountAccessVersion" INTEGER;

ALTER TABLE "McpToolAttestationAudit"
  ADD COLUMN "connectionOwnerAccountAccessVersion" INTEGER;

ALTER TABLE "ProjectMcpToolGrant"
  ADD COLUMN "connectionOwnerAccountAccessVersion" INTEGER;

ALTER TABLE "ProjectMcpToolGrantLedger"
  ADD COLUMN "connectionOwnerId" UUID,
  ADD COLUMN "connectionOwnerAccountAccessVersion" INTEGER;

ALTER TABLE "ProjectMcpToolGrantAudit"
  ADD COLUMN "connectionOwnerAccountAccessVersion" INTEGER;

ALTER TABLE "ProjectMcpAction"
  ADD COLUMN "connectionOwnerAccountAccessVersion" INTEGER;

ALTER TABLE "ProjectMcpActionLedger"
  ADD COLUMN "connectionOwnerId" UUID,
  ADD COLUMN "connectionOwnerAccountAccessVersion" INTEGER;

ALTER TABLE "ProjectMcpActionDispatchAttempt"
  ADD COLUMN "connectionOwnerId" UUID,
  ADD COLUMN "connectionOwnerAccountAccessVersion" INTEGER;

ALTER TABLE "ProjectMcpActionRuntimeLedger"
  ADD COLUMN "connectionOwnerId" UUID,
  ADD COLUMN "connectionOwnerAccountAccessVersion" INTEGER;

ALTER TABLE "McpConnection"
  ADD CONSTRAINT "McpConnection_owner_account_access_version_check"
    CHECK ("ownerAccountAccessVersion" IS NULL OR "ownerAccountAccessVersion" > 0);

ALTER TABLE "ProjectMcpConnectionDelegation"
  ADD CONSTRAINT "PMCD_connection_owner_account_access_version_check"
    CHECK ("connectionOwnerAccountAccessVersion" IS NULL OR "connectionOwnerAccountAccessVersion" > 0);

ALTER TABLE "ProjectMcpConnectionDelegationAudit"
  ADD CONSTRAINT "PMCD_A_connection_owner_account_access_version_check"
    CHECK ("connectionOwnerAccountAccessVersion" IS NULL OR "connectionOwnerAccountAccessVersion" > 0);

ALTER TABLE "McpToolAttestation"
  ADD CONSTRAINT "McpToolAttestation_connection_owner_account_access_version_check"
    CHECK ("connectionOwnerAccountAccessVersion" IS NULL OR "connectionOwnerAccountAccessVersion" > 0);

ALTER TABLE "McpToolAttestationAudit"
  ADD CONSTRAINT "McpToolAttestationAudit_connection_owner_account_access_version_check"
    CHECK ("connectionOwnerAccountAccessVersion" IS NULL OR "connectionOwnerAccountAccessVersion" > 0);

ALTER TABLE "ProjectMcpToolGrant"
  ADD CONSTRAINT "ProjectMcpToolGrant_connection_owner_account_access_version_check"
    CHECK ("connectionOwnerAccountAccessVersion" IS NULL OR "connectionOwnerAccountAccessVersion" > 0);

ALTER TABLE "ProjectMcpToolGrantLedger"
  ADD CONSTRAINT "ProjectMcpToolGrantLedger_connection_owner_account_access_version_check"
    CHECK ("connectionOwnerAccountAccessVersion" IS NULL OR "connectionOwnerAccountAccessVersion" > 0);

ALTER TABLE "ProjectMcpToolGrantAudit"
  ADD CONSTRAINT "ProjectMcpToolGrantAudit_connection_owner_account_access_version_check"
    CHECK ("connectionOwnerAccountAccessVersion" IS NULL OR "connectionOwnerAccountAccessVersion" > 0);

ALTER TABLE "ProjectMcpAction"
  ADD CONSTRAINT "ProjectMcpAction_connection_owner_account_access_version_check"
    CHECK ("connectionOwnerAccountAccessVersion" IS NULL OR "connectionOwnerAccountAccessVersion" > 0);

ALTER TABLE "ProjectMcpActionLedger"
  ADD CONSTRAINT "ProjectMcpActionLedger_connection_owner_account_access_version_check"
    CHECK ("connectionOwnerAccountAccessVersion" IS NULL OR "connectionOwnerAccountAccessVersion" > 0);

ALTER TABLE "ProjectMcpActionDispatchAttempt"
  ADD CONSTRAINT "ProjectMcpActionDispatchAttempt_connection_owner_account_access_version_check"
    CHECK ("connectionOwnerAccountAccessVersion" IS NULL OR "connectionOwnerAccountAccessVersion" > 0);

ALTER TABLE "ProjectMcpActionRuntimeLedger"
  ADD CONSTRAINT "ProjectMcpActionRuntimeLedger_connection_owner_account_access_version_check"
    CHECK ("connectionOwnerAccountAccessVersion" IS NULL OR "connectionOwnerAccountAccessVersion" > 0);

-- Build lookup indexes before the root backfill.  Legacy MCP control-plane
-- tables enqueue deferred integrity events, and PostgreSQL rejects DDL that
-- touches an indexed table while those events are pending in this transaction.
CREATE INDEX "McpConnection_ownerAccountAccessVersion_idx"
  ON "McpConnection"("ownerUserId", "ownerAccountAccessVersion");
CREATE INDEX "ProjectMcpConnectionDelegation_connectionOwnerAccountAccessVersion_idx"
  ON "ProjectMcpConnectionDelegation"("connectionOwnerId", "connectionOwnerAccountAccessVersion");
CREATE INDEX "ProjectMcpToolGrant_connectionOwnerAccountAccessVersion_idx"
  ON "ProjectMcpToolGrant"("connectionOwnerAccountAccessVersion");
CREATE INDEX "ProjectMcpAction_connectionOwnerAccountAccessVersion_idx"
  ON "ProjectMcpAction"("connectionOwnerId", "connectionOwnerAccountAccessVersion");
CREATE INDEX "ProjectMcpActionDispatchAttempt_connectionOwnerAccountAccessVersion_idx"
  ON "ProjectMcpActionDispatchAttempt"("connectionOwnerId", "connectionOwnerAccountAccessVersion");

-- Backfill only rows whose current root and current enabled owner prove the
-- same epoch.  Rows that cannot be proved retain NULL and remain fail-closed.
UPDATE "McpConnection" connection_row
   SET "ownerAccountAccessVersion" = owner_user."accountAccessVersion"
  FROM "AppUser" owner_user
 WHERE connection_row."ownerUserId" = owner_user."id"
   AND connection_row."ownershipState" = 'confirmed'
   AND connection_row."status" <> 'disabled'
   AND connection_row."disabledAt" IS NULL
   AND owner_user."disabledAt" IS NULL;

-- Do not rewrite legacy delegations, attestations, grants, actions, audits, or
-- ledgers.  The downstream rows are immutable or require a new transition
-- audit in the same transaction; backfilling them would forge evidence and
-- could re-enable a stale chain.  Preserve every historical row with NULL
-- epoch and let the new guards fail closed.  Explicit owner rebind creates a
-- fresh, fully-bound chain instead.
SET CONSTRAINTS ALL IMMEDIATE;

CREATE OR REPLACE FUNCTION "personal_mcp_owner_account_access_epoch_valid"(
  p_owner_id UUID,
  p_epoch INTEGER
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM "AppUser" owner_user
     WHERE owner_user."id" = p_owner_id
       AND owner_user."disabledAt" IS NULL
       AND owner_user."accountAccessVersion" = p_epoch
       AND p_epoch > 0
  );
$$;

CREATE OR REPLACE FUNCTION "personal_mcp_connection_epoch_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  rotation_context TEXT := current_setting('app.personal_mcp_credential_rotation_context', true);
  rotation_owner TEXT := current_setting('app.personal_mcp_credential_rotation_owner_id', true);
  rotation_connection TEXT := current_setting('app.personal_mcp_credential_rotation_connection_id', true);
BEGIN
  IF NEW."ownerUserId" IS NULL THEN
    IF NEW."ownerAccountAccessVersion" IS NOT NULL THEN
      RAISE EXCEPTION 'PERSONAL_MCP_ACCOUNT_EPOCH_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."ownerAccountAccessVersion" IS NULL THEN
    RAISE EXCEPTION 'PERSONAL_MCP_ACCOUNT_EPOCH_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT "personal_mcp_owner_account_access_epoch_valid"(NEW."ownerUserId", NEW."ownerAccountAccessVersion") THEN
      RAISE EXCEPTION 'PERSONAL_MCP_ACCOUNT_EPOCH_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."ownerUserId" IS DISTINCT FROM NEW."ownerUserId"
     OR OLD."ownershipState" IS DISTINCT FROM NEW."ownershipState" THEN
    RAISE EXCEPTION 'PERSONAL_MCP_CONNECTION_OWNER_IMMUTABLE' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."ownerAccountAccessVersion" IS DISTINCT FROM NEW."ownerAccountAccessVersion" THEN
    IF rotation_context IS DISTINCT FROM '1'
       OR rotation_owner IS DISTINCT FROM NEW."ownerUserId"::text
       OR rotation_connection IS DISTINCT FROM NEW."id"::text
       OR NOT "personal_mcp_owner_account_access_epoch_valid"(NEW."ownerUserId", NEW."ownerAccountAccessVersion") THEN
      RAISE EXCEPTION 'PERSONAL_MCP_ACCOUNT_EPOCH_REFRESH_FORBIDDEN' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "McpConnection_personal_epoch_guard" ON "McpConnection";
CREATE TRIGGER "McpConnection_personal_epoch_guard"
BEFORE INSERT OR UPDATE ON "McpConnection"
FOR EACH ROW EXECUTE FUNCTION "personal_mcp_connection_epoch_guard"();

CREATE OR REPLACE FUNCTION "personal_mcp_delegation_epoch_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  root_owner UUID;
  root_epoch INTEGER;
  owner_epoch INTEGER;
  owner_disabled TIMESTAMP(3);
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."connectionOwnerAccountAccessVersion" IS DISTINCT FROM NEW."connectionOwnerAccountAccessVersion" THEN
    RAISE EXCEPTION 'PERSONAL_MCP_ACCOUNT_EPOCH_IMMUTABLE' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."connectionOwnerAccountAccessVersion" IS NULL THEN
    IF TG_OP = 'UPDATE'
       AND OLD."connectionOwnerAccountAccessVersion" IS NULL
       AND (
         (OLD."status" IN ('draft', 'owner_confirmed') AND NEW."status" = 'rejected')
         OR (OLD."status" = 'active' AND NEW."status" = 'revoked')
       ) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'PERSONAL_MCP_ACCOUNT_EPOCH_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  SELECT connection_row."ownerUserId", connection_row."ownerAccountAccessVersion"
    INTO root_owner, root_epoch
    FROM "McpConnection" connection_row
   WHERE connection_row."id" = NEW."mcpConnectionId";
  SELECT owner_user."accountAccessVersion", owner_user."disabledAt"
    INTO owner_epoch, owner_disabled
    FROM "AppUser" owner_user
   WHERE owner_user."id" = NEW."connectionOwnerId";
  IF TG_OP = 'INSERT' OR NEW."status" IN ('draft', 'owner_confirmed', 'active') THEN
    IF root_owner IS DISTINCT FROM NEW."connectionOwnerId"
       OR root_epoch IS DISTINCT FROM NEW."connectionOwnerAccountAccessVersion"
       OR owner_disabled IS NOT NULL
       OR owner_epoch IS DISTINCT FROM NEW."connectionOwnerAccountAccessVersion" THEN
      RAISE EXCEPTION 'PERSONAL_MCP_ACCOUNT_EPOCH_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "ProjectMcpConnectionDelegation_personal_epoch_guard" ON "ProjectMcpConnectionDelegation";
CREATE CONSTRAINT TRIGGER "ProjectMcpConnectionDelegation_personal_epoch_guard"
AFTER INSERT OR UPDATE ON "ProjectMcpConnectionDelegation"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "personal_mcp_delegation_epoch_guard"();

CREATE OR REPLACE FUNCTION "personal_mcp_delegation_audit_epoch_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  delegation_epoch INTEGER;
  delegation_status "ProjectMcpConnectionDelegationStatus";
BEGIN
  IF TG_OP <> 'INSERT' THEN RETURN NEW; END IF;
  SELECT delegation."connectionOwnerAccountAccessVersion", delegation."status"
    INTO delegation_epoch, delegation_status
    FROM "ProjectMcpConnectionDelegation" delegation
   WHERE delegation."id" = NEW."delegationId";
  IF delegation_epoch IS NULL THEN
    IF NEW."connectionOwnerAccountAccessVersion" IS NULL
       AND NEW."statusAfter" IS NOT DISTINCT FROM delegation_status
       AND (
         (NEW."action" = 'rejected' AND NEW."statusBefore" IN ('draft', 'owner_confirmed') AND delegation_status = 'rejected')
         OR (NEW."action" = 'revoked' AND NEW."statusBefore" = 'active' AND delegation_status = 'revoked')
       ) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'PERSONAL_MCP_ACCOUNT_EPOCH_INVALID' USING ERRCODE = 'check_violation';
  ELSIF NEW."connectionOwnerAccountAccessVersion" IS DISTINCT FROM delegation_epoch THEN
    RAISE EXCEPTION 'PERSONAL_MCP_ACCOUNT_EPOCH_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "ProjectMcpConnectionDelegationAudit_personal_epoch_guard" ON "ProjectMcpConnectionDelegationAudit";
CREATE CONSTRAINT TRIGGER "ProjectMcpConnectionDelegationAudit_personal_epoch_guard"
AFTER INSERT ON "ProjectMcpConnectionDelegationAudit"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "personal_mcp_delegation_audit_epoch_guard"();

CREATE OR REPLACE FUNCTION "personal_mcp_attestation_epoch_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  root_epoch INTEGER;
  root_owner UUID;
  owner_epoch INTEGER;
  owner_disabled TIMESTAMP(3);
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."connectionOwnerAccountAccessVersion" IS DISTINCT FROM NEW."connectionOwnerAccountAccessVersion" THEN
    RAISE EXCEPTION 'PERSONAL_MCP_ACCOUNT_EPOCH_IMMUTABLE' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."controlPlaneVersion" IS NULL THEN
    IF TG_OP = 'UPDATE'
       AND OLD."connectionOwnerAccountAccessVersion" IS NULL
       AND NEW."connectionOwnerAccountAccessVersion" IS NULL
       AND OLD."status" = 'active'
       AND NEW."status" = 'revoked' THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'PERSONAL_MCP_ACCOUNT_EPOCH_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."connectionOwnerAccountAccessVersion" IS NULL THEN
    IF TG_OP = 'UPDATE'
       AND OLD."connectionOwnerAccountAccessVersion" IS NULL
       AND OLD."controlPlaneVersion" = 2
       AND NEW."controlPlaneVersion" = 2
       AND OLD."status" = 'active'
       AND NEW."status" = 'revoked' THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'PERSONAL_MCP_ACCOUNT_EPOCH_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  SELECT connection_row."ownerUserId", connection_row."ownerAccountAccessVersion"
    INTO root_owner, root_epoch
    FROM "McpConnection" connection_row
   WHERE connection_row."id" = NEW."connectionId";
  SELECT owner_user."accountAccessVersion", owner_user."disabledAt"
    INTO owner_epoch, owner_disabled
    FROM "AppUser" owner_user
   WHERE owner_user."id" = root_owner;
  IF TG_OP = 'INSERT' OR NEW."status" = 'active' THEN
    IF root_owner IS NULL
       OR root_epoch IS DISTINCT FROM NEW."connectionOwnerAccountAccessVersion"
       OR owner_disabled IS NOT NULL
       OR owner_epoch IS DISTINCT FROM NEW."connectionOwnerAccountAccessVersion" THEN
      RAISE EXCEPTION 'PERSONAL_MCP_ACCOUNT_EPOCH_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "McpToolAttestation_personal_epoch_guard" ON "McpToolAttestation";
CREATE CONSTRAINT TRIGGER "McpToolAttestation_personal_epoch_guard"
AFTER INSERT OR UPDATE ON "McpToolAttestation"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "personal_mcp_attestation_epoch_guard"();

CREATE OR REPLACE FUNCTION "personal_mcp_attestation_audit_epoch_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  attestation_epoch INTEGER;
  attestation_control_plane_version INTEGER;
  attestation_version INTEGER;
  attestation_status "McpToolAttestationStatus";
BEGIN
  IF TG_OP <> 'INSERT' THEN RETURN NEW; END IF;
  SELECT attestation."connectionOwnerAccountAccessVersion", attestation."controlPlaneVersion", attestation."version", attestation."status"
    INTO attestation_epoch, attestation_control_plane_version, attestation_version, attestation_status
    FROM "McpToolAttestation" attestation
   WHERE attestation."id" = NEW."attestationId";
  IF attestation_epoch IS NULL THEN
    IF NEW."connectionOwnerAccountAccessVersion" IS NULL
       AND attestation_control_plane_version = 2
       AND attestation_version = 2
       AND NEW."controlPlaneVersion" = 2
       AND NEW."event" = 'revoked'
       AND NEW."attestationVersion" = 2
       AND NEW."statusBefore" = 'active'
       AND NEW."statusAfter" = 'revoked'
       AND attestation_status = 'revoked' THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'PERSONAL_MCP_ACCOUNT_EPOCH_INVALID' USING ERRCODE = 'check_violation';
  ELSIF NEW."connectionOwnerAccountAccessVersion" IS DISTINCT FROM attestation_epoch THEN
    RAISE EXCEPTION 'PERSONAL_MCP_ACCOUNT_EPOCH_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "McpToolAttestationAudit_personal_epoch_guard" ON "McpToolAttestationAudit";
CREATE CONSTRAINT TRIGGER "McpToolAttestationAudit_personal_epoch_guard"
AFTER INSERT ON "McpToolAttestationAudit"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "personal_mcp_attestation_audit_epoch_guard"();

CREATE OR REPLACE FUNCTION "personal_mcp_grant_epoch_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  delegation_epoch INTEGER;
  root_epoch INTEGER;
  owner_epoch INTEGER;
  owner_id UUID;
  owner_disabled TIMESTAMP(3);
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."connectionOwnerAccountAccessVersion" IS DISTINCT FROM NEW."connectionOwnerAccountAccessVersion" THEN
    RAISE EXCEPTION 'PERSONAL_MCP_ACCOUNT_EPOCH_IMMUTABLE' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."controlPlaneVersion" IS NULL THEN
    IF TG_OP = 'UPDATE'
       AND OLD."connectionOwnerAccountAccessVersion" IS NULL
       AND NEW."connectionOwnerAccountAccessVersion" IS NULL
       AND OLD."status" = 'active'
       AND NEW."status" = 'revoked' THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'PERSONAL_MCP_ACCOUNT_EPOCH_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."connectionOwnerAccountAccessVersion" IS NULL THEN
    IF TG_OP = 'UPDATE'
       AND OLD."connectionOwnerAccountAccessVersion" IS NULL
       AND NEW."connectionOwnerAccountAccessVersion" IS NULL
       AND OLD."status" = 'active'
       AND NEW."status" = 'revoked' THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'PERSONAL_MCP_ACCOUNT_EPOCH_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."delegationId" IS NULL THEN
    RAISE EXCEPTION 'PERSONAL_MCP_ACCOUNT_EPOCH_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  SELECT delegation."connectionOwnerAccountAccessVersion", delegation."connectionOwnerId"
    INTO delegation_epoch, owner_id
    FROM "ProjectMcpConnectionDelegation" delegation
   WHERE delegation."id" = NEW."delegationId";
  SELECT connection_row."ownerAccountAccessVersion"
    INTO root_epoch
    FROM "McpConnection" connection_row
   WHERE connection_row."id" = NEW."connectionId";
  SELECT owner_user."accountAccessVersion", owner_user."disabledAt"
    INTO owner_epoch, owner_disabled
    FROM "AppUser" owner_user
   WHERE owner_user."id" = owner_id;
  IF delegation_epoch IS DISTINCT FROM NEW."connectionOwnerAccountAccessVersion"
     OR root_epoch IS DISTINCT FROM NEW."connectionOwnerAccountAccessVersion"
     OR owner_disabled IS NOT NULL
     OR owner_epoch IS DISTINCT FROM NEW."connectionOwnerAccountAccessVersion" THEN
    IF TG_OP = 'INSERT' OR NEW."status" = 'active' THEN
      RAISE EXCEPTION 'PERSONAL_MCP_ACCOUNT_EPOCH_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "ProjectMcpToolGrant_personal_epoch_guard" ON "ProjectMcpToolGrant";
CREATE CONSTRAINT TRIGGER "ProjectMcpToolGrant_personal_epoch_guard"
AFTER INSERT OR UPDATE ON "ProjectMcpToolGrant"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "personal_mcp_grant_epoch_guard"();

CREATE OR REPLACE FUNCTION "personal_mcp_grant_audit_epoch_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  grant_epoch INTEGER;
  grant_control_plane_version INTEGER;
  grant_version INTEGER;
  grant_status "ProjectMcpToolGrantStatus";
BEGIN
  IF TG_OP <> 'INSERT' THEN RETURN NEW; END IF;
  SELECT grant_row."connectionOwnerAccountAccessVersion", grant_row."controlPlaneVersion", grant_row."grantVersion", grant_row."status"
    INTO grant_epoch, grant_control_plane_version, grant_version, grant_status
    FROM "ProjectMcpToolGrant" grant_row
   WHERE grant_row."id" = NEW."grantId"
     AND grant_row."projectId" = NEW."projectId";
  IF grant_epoch IS NULL THEN
    IF NEW."connectionOwnerAccountAccessVersion" IS NULL
       AND NEW."event" = 'revoked'
       AND NEW."controlPlaneVersion" IS NOT DISTINCT FROM grant_control_plane_version
       AND NEW."grantVersion" IS NOT DISTINCT FROM grant_version
       AND grant_status = 'revoked'
       AND (
         (
           grant_control_plane_version IS NULL
           AND NEW."statusBefore" IS NULL
           AND NEW."statusAfter" IS NULL
         )
         OR (
           grant_control_plane_version = 2
           AND NEW."statusBefore" = 'active'
           AND NEW."statusAfter" = 'revoked'
         )
       ) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'PERSONAL_MCP_ACCOUNT_EPOCH_INVALID' USING ERRCODE = 'check_violation';
  ELSIF NEW."connectionOwnerAccountAccessVersion" IS DISTINCT FROM grant_epoch THEN
    RAISE EXCEPTION 'PERSONAL_MCP_ACCOUNT_EPOCH_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "ProjectMcpToolGrantAudit_personal_epoch_guard" ON "ProjectMcpToolGrantAudit";
CREATE CONSTRAINT TRIGGER "ProjectMcpToolGrantAudit_personal_epoch_guard"
AFTER INSERT ON "ProjectMcpToolGrantAudit"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "personal_mcp_grant_audit_epoch_guard"();

CREATE OR REPLACE FUNCTION "personal_mcp_grant_ledger_epoch_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  grant_epoch INTEGER;
  owner_id UUID;
  grant_version INTEGER;
  grant_status "ProjectMcpToolGrantStatus";
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'PERSONAL_MCP_LEDGER_APPEND_ONLY' USING ERRCODE = 'check_violation';
  END IF;
  SELECT grant_row."connectionOwnerAccountAccessVersion", delegation."connectionOwnerId", grant_row."grantVersion", grant_row."status"
    INTO grant_epoch, owner_id, grant_version, grant_status
    FROM "ProjectMcpToolGrant" grant_row
    JOIN "ProjectMcpConnectionDelegation" delegation ON delegation."id" = grant_row."delegationId"
   WHERE grant_row."id" = NEW."grantId"
     AND grant_row."projectId" = NEW."projectId";
  IF grant_epoch IS NULL THEN
    IF NEW."event" = 'revoked'
       AND NEW."statusBefore" = 'active'
       AND NEW."statusAfter" = 'revoked'
       AND grant_status = 'revoked'
       AND NEW."grantVersion" IS NOT DISTINCT FROM grant_version
       AND NEW."connectionOwnerAccountAccessVersion" IS NULL
       AND owner_id IS NOT NULL
       AND NEW."connectionOwnerId" IS NOT DISTINCT FROM owner_id THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'PERSONAL_MCP_ACCOUNT_EPOCH_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  IF owner_id IS NULL
     OR NEW."connectionOwnerId" IS DISTINCT FROM owner_id
     OR NEW."connectionOwnerAccountAccessVersion" IS DISTINCT FROM grant_epoch THEN
    RAISE EXCEPTION 'PERSONAL_MCP_ACCOUNT_EPOCH_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "ProjectMcpToolGrantLedger_personal_epoch_guard" ON "ProjectMcpToolGrantLedger";
CREATE TRIGGER "ProjectMcpToolGrantLedger_personal_epoch_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "ProjectMcpToolGrantLedger"
FOR EACH ROW EXECUTE FUNCTION "personal_mcp_grant_ledger_epoch_guard"();

-- A legacy action can only be terminalized when its complete source chain is
-- still present and every downstream epoch is NULL.  The root is allowed to
-- carry the epoch proven by this migration's confirmed-owner backfill; that
-- does not make the legacy snapshot eligible for approval or dispatch again.
CREATE OR REPLACE FUNCTION "personal_mcp_action_legacy_chain_valid"(action_row "ProjectMcpAction")
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT action_row."connectionOwnerId" IS NOT NULL
     AND action_row."connectionOwnerAccountAccessVersion" IS NULL
     AND grant_row."connectionOwnerAccountAccessVersion" IS NULL
     AND delegation."connectionOwnerAccountAccessVersion" IS NULL
     AND attestation."connectionOwnerAccountAccessVersion" IS NULL
     AND connection_row."ownerUserId" = action_row."connectionOwnerId"
     AND (
       connection_row."ownerAccountAccessVersion" IS NULL
       OR (
         connection_row."ownershipState" = 'confirmed'
         AND connection_row."status" <> 'disabled'
         AND connection_row."disabledAt" IS NULL
         AND owner_user."disabledAt" IS NULL
         AND owner_user."accountAccessVersion" = connection_row."ownerAccountAccessVersion"
       )
     )
     AND delegation."connectionOwnerId" = action_row."connectionOwnerId"
  FROM "ProjectMcpToolGrant" grant_row
  JOIN "ProjectMcpConnectionDelegation" delegation
    ON delegation."id" = grant_row."delegationId"
   AND delegation."projectId" = grant_row."projectId"
   AND delegation."mcpConnectionId" = grant_row."connectionId"
  JOIN "McpToolAttestation" attestation
    ON attestation."id" = grant_row."attestationId"
   AND attestation."connectionId" = grant_row."connectionId"
  JOIN "McpConnection" connection_row
    ON connection_row."id" = grant_row."connectionId"
  JOIN "AppUser" owner_user
    ON owner_user."id" = action_row."connectionOwnerId"
 WHERE grant_row."id" = action_row."grantId"
   AND grant_row."projectId" = action_row."projectId"
   AND grant_row."connectionId" = action_row."connectionId"
   AND grant_row."delegationId" = action_row."delegationId"
   AND grant_row."attestationId" = action_row."attestationId"
   AND delegation."id" = action_row."delegationId"
   AND attestation."id" = action_row."attestationId"
   AND attestation."toolDefinitionId" = action_row."toolDefinitionId"
   AND attestation."toolName" = action_row."toolName";
$$;

CREATE OR REPLACE FUNCTION "personal_mcp_action_epoch_valid"(action_row "ProjectMcpAction")
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT action_row."connectionOwnerAccountAccessVersion" IS NOT NULL
     AND action_row."connectionOwnerId" IS NOT NULL
     AND grant_row."connectionOwnerAccountAccessVersion" = action_row."connectionOwnerAccountAccessVersion"
     AND delegation."connectionOwnerAccountAccessVersion" = action_row."connectionOwnerAccountAccessVersion"
     AND attestation."connectionOwnerAccountAccessVersion" = action_row."connectionOwnerAccountAccessVersion"
     AND connection_row."ownerUserId" = action_row."connectionOwnerId"
     AND connection_row."ownerAccountAccessVersion" = action_row."connectionOwnerAccountAccessVersion"
     AND owner_user."id" = action_row."connectionOwnerId"
     AND owner_user."disabledAt" IS NULL
     AND owner_user."accountAccessVersion" = action_row."connectionOwnerAccountAccessVersion"
  FROM "ProjectMcpToolGrant" grant_row
  JOIN "ProjectMcpConnectionDelegation" delegation ON delegation."id" = grant_row."delegationId"
  JOIN "McpToolAttestation" attestation ON attestation."id" = grant_row."attestationId"
  JOIN "McpConnection" connection_row ON connection_row."id" = action_row."connectionId"
  JOIN "AppUser" owner_user ON owner_user."id" = action_row."connectionOwnerId"
 WHERE grant_row."id" = action_row."grantId"
   AND grant_row."projectId" = action_row."projectId"
   AND delegation."projectId" = action_row."projectId"
   AND attestation."connectionId" = action_row."connectionId";
$$;

CREATE OR REPLACE FUNCTION "personal_mcp_action_epoch_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."connectionOwnerAccountAccessVersion" IS DISTINCT FROM NEW."connectionOwnerAccountAccessVersion" THEN
    RAISE EXCEPTION 'PERSONAL_MCP_ACCOUNT_EPOCH_IMMUTABLE' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."connectionOwnerId" IS NULL THEN
    RAISE EXCEPTION 'PERSONAL_MCP_ACCOUNT_EPOCH_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."connectionOwnerAccountAccessVersion" IS NULL THEN
    IF TG_OP = 'UPDATE'
       AND OLD."connectionOwnerAccountAccessVersion" IS NULL
       AND "personal_mcp_action_legacy_chain_valid"(NEW)
       AND (
         (OLD."status" = 'waiting_approval' AND NEW."status" = 'cancelled')
         OR (OLD."status" = 'approved' AND NEW."status" IN ('cancelled', 'invalidated'))
         OR (
           OLD."status" = 'dispatch_reserved'
           AND NEW."status" = 'unknown'
           AND EXISTS (
             SELECT 1
             FROM "ProjectMcpActionDispatchAttempt" attempt
             WHERE attempt."projectId" = NEW."projectId"
               AND attempt."actionId" = NEW."id"
               AND attempt."connectionOwnerAccountAccessVersion" IS NULL
               AND attempt."status" IN ('reserved', 'unknown')
           )
         )
       ) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'PERSONAL_MCP_ACCOUNT_EPOCH_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' OR NEW."status" IN ('waiting_approval', 'approved', 'dispatch_reserved') THEN
    IF NOT "personal_mcp_action_epoch_valid"(NEW) THEN
      RAISE EXCEPTION 'PERSONAL_MCP_ACCOUNT_EPOCH_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "ProjectMcpAction_personal_epoch_guard" ON "ProjectMcpAction";
CREATE CONSTRAINT TRIGGER "ProjectMcpAction_personal_epoch_guard"
AFTER INSERT OR UPDATE ON "ProjectMcpAction"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "personal_mcp_action_epoch_guard"();

CREATE OR REPLACE FUNCTION "personal_mcp_action_ledger_epoch_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  action_owner UUID;
  action_epoch INTEGER;
  action_status "ProjectMcpActionStatus";
  action_state_version INTEGER;
  action_row "ProjectMcpAction";
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'PERSONAL_MCP_LEDGER_APPEND_ONLY' USING ERRCODE = 'check_violation';
  END IF;
  SELECT source.*
    INTO action_row
    FROM "ProjectMcpAction" AS source
   WHERE source."id" = NEW."actionId"
     AND source."projectId" = NEW."projectId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PERSONAL_MCP_ACCOUNT_EPOCH_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  action_owner := action_row."connectionOwnerId";
  action_epoch := action_row."connectionOwnerAccountAccessVersion";
  action_status := action_row."status";
  action_state_version := action_row."stateVersion";
  IF action_owner IS NULL OR NEW."connectionOwnerId" IS DISTINCT FROM action_owner THEN
    RAISE EXCEPTION 'PERSONAL_MCP_ACCOUNT_EPOCH_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  IF action_epoch IS NULL THEN
    IF NEW."connectionOwnerAccountAccessVersion" IS NULL
       AND "personal_mcp_action_legacy_chain_valid"(action_row)
       AND action_status = 'cancelled'
       AND NEW."event" = 'cancelled'
       AND NEW."statusBefore" IN ('waiting_approval', 'approved')
       AND NEW."statusAfter" = 'cancelled'
       AND NEW."stateVersion" = action_state_version THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'PERSONAL_MCP_ACCOUNT_EPOCH_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."connectionOwnerAccountAccessVersion" IS DISTINCT FROM action_epoch THEN
    RAISE EXCEPTION 'PERSONAL_MCP_ACCOUNT_EPOCH_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "ProjectMcpActionLedger_personal_epoch_guard" ON "ProjectMcpActionLedger";
CREATE TRIGGER "ProjectMcpActionLedger_personal_epoch_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "ProjectMcpActionLedger"
FOR EACH ROW EXECUTE FUNCTION "personal_mcp_action_ledger_epoch_guard"();

CREATE OR REPLACE FUNCTION "personal_mcp_attempt_epoch_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  action_owner UUID;
  action_epoch INTEGER;
  action_status "ProjectMcpActionStatus";
  action_state_version INTEGER;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."connectionOwnerAccountAccessVersion" IS DISTINCT FROM NEW."connectionOwnerAccountAccessVersion" THEN
    RAISE EXCEPTION 'PERSONAL_MCP_ACCOUNT_EPOCH_IMMUTABLE' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."connectionOwnerId" IS NULL THEN
    RAISE EXCEPTION 'PERSONAL_MCP_ACCOUNT_EPOCH_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  SELECT action_row."connectionOwnerId", action_row."connectionOwnerAccountAccessVersion", action_row."status", action_row."stateVersion"
    INTO action_owner, action_epoch, action_status, action_state_version
    FROM "ProjectMcpAction" action_row
   WHERE action_row."id" = NEW."actionId"
     AND action_row."projectId" = NEW."projectId";
  IF action_owner IS NULL OR NEW."connectionOwnerId" IS DISTINCT FROM action_owner THEN
    RAISE EXCEPTION 'PERSONAL_MCP_ACCOUNT_EPOCH_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  IF action_epoch IS NULL THEN
    IF TG_OP = 'UPDATE'
       AND OLD."connectionOwnerAccountAccessVersion" IS NULL
       AND NEW."connectionOwnerAccountAccessVersion" IS NULL
       AND OLD."status" = 'reserved'
       AND NEW."status" = 'unknown'
       AND action_status = 'unknown'
       AND action_state_version = 4 THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'PERSONAL_MCP_ACCOUNT_EPOCH_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."connectionOwnerAccountAccessVersion" IS DISTINCT FROM action_epoch THEN
    RAISE EXCEPTION 'PERSONAL_MCP_ACCOUNT_EPOCH_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "ProjectMcpActionDispatchAttempt_personal_epoch_guard" ON "ProjectMcpActionDispatchAttempt";
CREATE CONSTRAINT TRIGGER "ProjectMcpActionDispatchAttempt_personal_epoch_guard"
AFTER INSERT OR UPDATE ON "ProjectMcpActionDispatchAttempt"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "personal_mcp_attempt_epoch_guard"();

CREATE OR REPLACE FUNCTION "personal_mcp_runtime_ledger_epoch_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  action_owner UUID;
  action_epoch INTEGER;
  action_status "ProjectMcpActionStatus";
  action_state_version INTEGER;
  action_row "ProjectMcpAction";
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'PERSONAL_MCP_LEDGER_APPEND_ONLY' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."connectionOwnerId" IS NULL THEN
    RAISE EXCEPTION 'PERSONAL_MCP_ACCOUNT_EPOCH_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  SELECT source.*
    INTO action_row
    FROM "ProjectMcpAction" AS source
   WHERE source."id" = NEW."actionId"
     AND source."projectId" = NEW."projectId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PERSONAL_MCP_ACCOUNT_EPOCH_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  action_owner := action_row."connectionOwnerId";
  action_epoch := action_row."connectionOwnerAccountAccessVersion";
  action_status := action_row."status";
  action_state_version := action_row."stateVersion";
  IF action_owner IS NULL OR NEW."connectionOwnerId" IS DISTINCT FROM action_owner THEN
    RAISE EXCEPTION 'PERSONAL_MCP_ACCOUNT_EPOCH_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  IF action_epoch IS NULL THEN
    IF NEW."connectionOwnerAccountAccessVersion" IS NULL
       AND "personal_mcp_action_legacy_chain_valid"(action_row)
       AND (
         (action_status = 'invalidated'
           AND action_state_version = 3
           AND NEW."event" = 'invalidated'
           AND NEW."statusBefore" = 'approved'
           AND NEW."statusAfter" = 'invalidated'
           AND NEW."stateVersion" = 3
           AND NEW."attemptId" IS NULL
           AND NEW."rpcRequestId" IS NULL)
         OR (action_status = 'unknown'
           AND action_state_version = 4
           AND NEW."event" = 'unknown'
           AND NEW."statusBefore" = 'dispatch_reserved'
           AND NEW."statusAfter" = 'unknown'
           AND NEW."stateVersion" = 4
           AND NEW."attemptId" IS NOT NULL
           AND NEW."rpcRequestId" IS NOT NULL
           AND EXISTS (
             SELECT 1
             FROM "ProjectMcpActionDispatchAttempt" attempt
             WHERE attempt."id" = NEW."attemptId"
               AND attempt."projectId" = NEW."projectId"
               AND attempt."actionId" = NEW."actionId"
               AND attempt."status" = 'unknown'
               AND attempt."connectionOwnerAccountAccessVersion" IS NULL
               AND attempt."rpcRequestId" = NEW."rpcRequestId"
           ))
       ) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'PERSONAL_MCP_ACCOUNT_EPOCH_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."connectionOwnerAccountAccessVersion" IS DISTINCT FROM action_epoch THEN
    RAISE EXCEPTION 'PERSONAL_MCP_ACCOUNT_EPOCH_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "ProjectMcpActionRuntimeLedger_personal_epoch_guard" ON "ProjectMcpActionRuntimeLedger";
CREATE TRIGGER "ProjectMcpActionRuntimeLedger_personal_epoch_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "ProjectMcpActionRuntimeLedger"
FOR EACH ROW EXECUTE FUNCTION "personal_mcp_runtime_ledger_epoch_guard"();
