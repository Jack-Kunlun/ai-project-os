-- R-14 connection governance.
--
-- Git/MCP connection mutation rows are a separate typed control plane. The
-- guards intentionally accept only the exact application
-- context tuple; direct table writes, broad trigger bypasses and public ACLs
-- remain denied.

CREATE TYPE "GitConnectionMutationAction" AS ENUM (
  'rotate_credential', 'retrust', 'retest', 'disable', 'enable', 'delete'
);
CREATE TYPE "McpConnectionMutationAction" AS ENUM (
  'rotate_credential', 'retrust', 'rediscover', 'disable', 'enable', 'delete'
);
CREATE TYPE "ConnectionMutationExecutionStatus" AS ENUM (
  'previewed', 'dispatched', 'completed', 'failed', 'unknown', 'held'
);

CREATE TABLE "GitConnectionMutationPreview" (
  "id" UUID NOT NULL,
  "connectionId" UUID NOT NULL,
  "actorId" UUID NOT NULL,
  "ownerUserId" UUID NOT NULL,
  "action" "GitConnectionMutationAction" NOT NULL,
  "actorAccountAccessVersion" INTEGER NOT NULL,
  "connectionConfigurationVersion" INTEGER NOT NULL,
  "connectionUpdatedAt" TIMESTAMP(3) NOT NULL,
  "connectionStatus" "GitConnectionStatus" NOT NULL,
  "candidateSecretFingerprint" CHAR(64),
  "confirmationName" VARCHAR(80),
  "reason" VARCHAR(500) NOT NULL,
  "requestKey" VARCHAR(180) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "impactFingerprint" CHAR(64) NOT NULL,
  "impactSnapshot" JSONB NOT NULL,
  "impactCount" INTEGER NOT NULL,
  "blockers" JSONB NOT NULL,
  "canExecute" BOOLEAN NOT NULL,
  "issuedAt" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "executionStatus" "ConnectionMutationExecutionStatus" NOT NULL DEFAULT 'previewed',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GitConnectionMutationPreview_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "GitConnectionMutationPreview_count_check" CHECK ("impactCount" >= 0),
  CONSTRAINT "GitConnectionMutationPreview_json_check" CHECK (
    jsonb_typeof("impactSnapshot") = 'object' AND jsonb_typeof("blockers") = 'array'
  ),
  CONSTRAINT "GitConnectionMutationPreview_fingerprint_check" CHECK (
    btrim("requestFingerprint") ~ '^[0-9a-f]{64}$'
    AND btrim("impactFingerprint") ~ '^[0-9a-f]{64}$'
    AND ("candidateSecretFingerprint" IS NULL OR btrim("candidateSecretFingerprint") ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT "GitConnectionMutationPreview_reason_check" CHECK (
    btrim("reason") <> '' AND "reason" !~ '[[:cntrl:]]'
    AND "reason" !~ '[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\\.[A-Za-z0-9-]+)+'
    AND "reason" !~ '[A-Za-z0-9_-]{40,128}' AND "reason" !~ '^[0-9a-fA-F]{64}$'
  ),
  CONSTRAINT "GitConnectionMutationPreview_request_key_check" CHECK (
    btrim("requestKey") <> '' AND "requestKey" !~ '[[:cntrl:]]'
    AND "requestKey" !~ '[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\\.[A-Za-z0-9-]+)+'
    AND "requestKey" !~ '[A-Za-z0-9_-]{40,128}' AND "requestKey" !~ '^[0-9a-fA-F]{64}$'
  ),
  CONSTRAINT "GitConnectionMutationPreview_window_check" CHECK (
    "expiresAt" > "issuedAt" AND "expiresAt" <= "issuedAt" + INTERVAL '5 minutes'
  )
);

CREATE TABLE "GitConnectionMutationAudit" (
  "id" UUID NOT NULL,
  "connectionId" UUID NOT NULL,
  "actorId" UUID NOT NULL,
  "ownerUserId" UUID NOT NULL,
  "previewId" UUID NOT NULL,
  "action" "GitConnectionMutationAction" NOT NULL,
  "statusBefore" "GitConnectionStatus",
  "statusAfter" "GitConnectionStatus",
  "connectionConfigurationVersion" INTEGER NOT NULL,
  "impactCount" INTEGER NOT NULL,
  "requestKey" VARCHAR(180) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "impactFingerprint" CHAR(64) NOT NULL,
  "executionStatus" "ConnectionMutationExecutionStatus" NOT NULL,
  "safeErrorCode" VARCHAR(64),
  "resultId" UUID,
  "transitionAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "transactionId" BIGINT NOT NULL DEFAULT txid_current(),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GitConnectionMutationAudit_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "GitConnectionMutationAudit_count_check" CHECK ("impactCount" >= 0),
  CONSTRAINT "GitConnectionMutationAudit_fingerprint_check" CHECK (
    btrim("requestFingerprint") ~ '^[0-9a-f]{64}$' AND btrim("impactFingerprint") ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "GitConnectionMutationAudit_reason_key_check" CHECK (
    btrim("requestKey") <> '' AND "requestKey" !~ '[[:cntrl:]]'
  )
);

CREATE UNIQUE INDEX "GitConnectionMutationPreview_actorId_requestKey_key"
  ON "GitConnectionMutationPreview"("actorId", "requestKey");
CREATE INDEX "GitConnectionMutationPreview_connectionId_createdAt_idx"
  ON "GitConnectionMutationPreview"("connectionId", "createdAt");
CREATE INDEX "GitConnectionMutationPreview_actorId_createdAt_idx"
  ON "GitConnectionMutationPreview"("actorId", "createdAt");
CREATE INDEX "GitConnectionMutationPreview_expiresAt_consumedAt_idx"
  ON "GitConnectionMutationPreview"("expiresAt", "consumedAt");
CREATE INDEX "GitConnectionMutationAudit_connectionId_createdAt_idx"
  ON "GitConnectionMutationAudit"("connectionId", "createdAt");
CREATE INDEX "GitConnectionMutationAudit_actorId_requestKey_createdAt_idx"
  ON "GitConnectionMutationAudit"("actorId", "requestKey", "createdAt");
CREATE INDEX "GitConnectionMutationAudit_previewId_createdAt_idx"
  ON "GitConnectionMutationAudit"("previewId", "createdAt");

ALTER TABLE "GitConnectionMutationPreview"
  ADD CONSTRAINT "GitConnectionMutationPreview_actorId_fkey"
    FOREIGN KEY ("actorId") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "GitConnectionMutationAudit"
  ADD CONSTRAINT "GitConnectionMutationAudit_actorId_fkey"
    FOREIGN KEY ("actorId") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "GitConnectionMutationAudit_previewId_fkey"
    FOREIGN KEY ("previewId") REFERENCES "GitConnectionMutationPreview"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

CREATE TABLE "McpConnectionMutationPreview" (
  "id" UUID NOT NULL,
  "connectionId" UUID NOT NULL,
  "actorId" UUID NOT NULL,
  "ownerUserId" UUID NOT NULL,
  "action" "McpConnectionMutationAction" NOT NULL,
  "actorAccountAccessVersion" INTEGER NOT NULL,
  "configurationRevision" INTEGER NOT NULL,
  "connectionUpdatedAt" TIMESTAMP(3) NOT NULL,
  "connectionStatus" "McpConnectionStatus" NOT NULL,
  "candidateSecretFingerprint" CHAR(64),
  "confirmationName" VARCHAR(80),
  "reason" VARCHAR(500) NOT NULL,
  "requestKey" VARCHAR(180) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "impactFingerprint" CHAR(64) NOT NULL,
  "impactSnapshot" JSONB NOT NULL,
  "impactCount" INTEGER NOT NULL,
  "blockers" JSONB NOT NULL,
  "canExecute" BOOLEAN NOT NULL,
  "issuedAt" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "executionStatus" "ConnectionMutationExecutionStatus" NOT NULL DEFAULT 'previewed',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "McpConnectionMutationPreview_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "McpConnectionMutationPreview_count_check" CHECK ("impactCount" >= 0),
  CONSTRAINT "McpConnectionMutationPreview_json_check" CHECK (
    jsonb_typeof("impactSnapshot") = 'object' AND jsonb_typeof("blockers") = 'array'
  ),
  CONSTRAINT "McpConnectionMutationPreview_fingerprint_check" CHECK (
    btrim("requestFingerprint") ~ '^[0-9a-f]{64}$'
    AND btrim("impactFingerprint") ~ '^[0-9a-f]{64}$'
    AND ("candidateSecretFingerprint" IS NULL OR btrim("candidateSecretFingerprint") ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT "McpConnectionMutationPreview_reason_check" CHECK (
    btrim("reason") <> '' AND "reason" !~ '[[:cntrl:]]'
    AND "reason" !~ '[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\\.[A-Za-z0-9-]+)+'
    AND "reason" !~ '[A-Za-z0-9_-]{40,128}' AND "reason" !~ '^[0-9a-fA-F]{64}$'
  ),
  CONSTRAINT "McpConnectionMutationPreview_request_key_check" CHECK (
    btrim("requestKey") <> '' AND "requestKey" !~ '[[:cntrl:]]'
    AND "requestKey" !~ '[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\\.[A-Za-z0-9-]+)+'
    AND "requestKey" !~ '[A-Za-z0-9_-]{40,128}' AND "requestKey" !~ '^[0-9a-fA-F]{64}$'
  ),
  CONSTRAINT "McpConnectionMutationPreview_window_check" CHECK (
    "expiresAt" > "issuedAt" AND "expiresAt" <= "issuedAt" + INTERVAL '5 minutes'
  )
);

CREATE TABLE "McpConnectionMutationAudit" (
  "id" UUID NOT NULL,
  "connectionId" UUID NOT NULL,
  "actorId" UUID NOT NULL,
  "ownerUserId" UUID NOT NULL,
  "previewId" UUID NOT NULL,
  "action" "McpConnectionMutationAction" NOT NULL,
  "statusBefore" "McpConnectionStatus",
  "statusAfter" "McpConnectionStatus",
  "configurationRevision" INTEGER NOT NULL,
  "impactCount" INTEGER NOT NULL,
  "requestKey" VARCHAR(180) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "impactFingerprint" CHAR(64) NOT NULL,
  "executionStatus" "ConnectionMutationExecutionStatus" NOT NULL,
  "safeErrorCode" VARCHAR(64),
  "resultId" UUID,
  "transitionAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "transactionId" BIGINT NOT NULL DEFAULT txid_current(),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "McpConnectionMutationAudit_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "McpConnectionMutationAudit_count_check" CHECK ("impactCount" >= 0),
  CONSTRAINT "McpConnectionMutationAudit_fingerprint_check" CHECK (
    btrim("requestFingerprint") ~ '^[0-9a-f]{64}$' AND btrim("impactFingerprint") ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "McpConnectionMutationAudit_request_key_check" CHECK (
    btrim("requestKey") <> '' AND "requestKey" !~ '[[:cntrl:]]'
  )
);

CREATE UNIQUE INDEX "McpConnectionMutationPreview_actorId_requestKey_key"
  ON "McpConnectionMutationPreview"("actorId", "requestKey");
CREATE INDEX "McpConnectionMutationPreview_connectionId_createdAt_idx"
  ON "McpConnectionMutationPreview"("connectionId", "createdAt");
CREATE INDEX "McpConnectionMutationPreview_actorId_createdAt_idx"
  ON "McpConnectionMutationPreview"("actorId", "createdAt");
CREATE INDEX "McpConnectionMutationPreview_expiresAt_consumedAt_idx"
  ON "McpConnectionMutationPreview"("expiresAt", "consumedAt");
CREATE INDEX "McpConnectionMutationAudit_connectionId_createdAt_idx"
  ON "McpConnectionMutationAudit"("connectionId", "createdAt");
CREATE INDEX "McpConnectionMutationAudit_actorId_requestKey_createdAt_idx"
  ON "McpConnectionMutationAudit"("actorId", "requestKey", "createdAt");
CREATE INDEX "McpConnectionMutationAudit_previewId_createdAt_idx"
  ON "McpConnectionMutationAudit"("previewId", "createdAt");

ALTER TABLE "McpConnectionMutationPreview"
  ADD CONSTRAINT "McpConnectionMutationPreview_actorId_fkey"
    FOREIGN KEY ("actorId") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "McpConnectionMutationAudit"
  ADD CONSTRAINT "McpConnectionMutationAudit_actorId_fkey"
    FOREIGN KEY ("actorId") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "McpConnectionMutationAudit_previewId_fkey"
    FOREIGN KEY ("previewId") REFERENCES "McpConnectionMutationPreview"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION "git_connection_governance_security_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  context TEXT := current_setting('app.git_connection_governance_context', true);
  context_id TEXT := current_setting('app.git_connection_governance_connection_id', true);
  context_actor TEXT := current_setting('app.git_connection_governance_actor_id', true);
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF context IS DISTINCT FROM '1' OR OLD."id"::text IS DISTINCT FROM context_id
       OR OLD."ownerUserId"::text IS DISTINCT FROM context_actor THEN
      RAISE EXCEPTION 'git connection delete requires governance context' USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND (
    OLD."providerKind" IS DISTINCT FROM NEW."providerKind"
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
    OR OLD."configurationVersion" IS DISTINCT FROM NEW."configurationVersion"
    OR OLD."lastTestedAt" IS DISTINCT FROM NEW."lastTestedAt"
    OR OLD."lastErrorCode" IS DISTINCT FROM NEW."lastErrorCode"
    OR OLD."disabledAt" IS DISTINCT FROM NEW."disabledAt"
    OR OLD."createdById" IS DISTINCT FROM NEW."createdById"
    OR OLD."ownerUserId" IS DISTINCT FROM NEW."ownerUserId"
    OR OLD."ownerAccountAccessVersion" IS DISTINCT FROM NEW."ownerAccountAccessVersion"
    OR OLD."ownershipState" IS DISTINCT FROM NEW."ownershipState"
  ) THEN
    IF context IS DISTINCT FROM '1' OR NEW."id"::text IS DISTINCT FROM context_id
       OR NEW."ownerUserId"::text IS DISTINCT FROM context_actor THEN
      RAISE EXCEPTION 'git connection security fields require governance context' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "GitConnection_governance_security_guard"
BEFORE UPDATE OR DELETE ON "GitConnection"
FOR EACH ROW EXECUTE FUNCTION "git_connection_governance_security_guard"();

-- Credential rotation changes the encrypted ExternalCredential row, while the
-- Git connection keeps the same credentialId.  Treat the exact governed
-- rotation tuple as a configuration change so the existing version guard
-- accepts one explicit increment even when the connection is already
-- configured with no network evidence to clear.
CREATE OR REPLACE FUNCTION "git_connection_configuration_version_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  changed BOOLEAN;
  execute_context TEXT := current_setting('app.git_connection_governance_execute_context', true);
  action_context TEXT := current_setting('app.git_connection_governance_action', true);
  connection_context TEXT := current_setting('app.git_connection_governance_connection_id', true);
  actor_context TEXT := current_setting('app.git_connection_governance_actor_id', true);
  preview_context TEXT := current_setting('app.git_connection_governance_execute_preview_id', true);
  request_key_context TEXT := current_setting('app.git_connection_governance_request_key', true);
  request_fingerprint_context TEXT := current_setting('app.git_connection_governance_request_fingerprint', true);
  impact_fingerprint_context TEXT := current_setting('app.git_connection_governance_impact_fingerprint', true);
  governed_rotation BOOLEAN;
BEGIN
  governed_rotation := execute_context = '1'
    AND action_context = 'rotate_credential'
    AND connection_context = NEW."id"::text
    AND actor_context = NEW."ownerUserId"::text
    AND EXISTS (
      SELECT 1
      FROM "GitConnectionMutationPreview" AS preview
      WHERE preview."id"::text = preview_context
        AND preview."connectionId" = NEW."id"
        AND preview."actorId" = NEW."ownerUserId"
        AND preview."action" = 'rotate_credential'
        AND preview."requestKey" = request_key_context
        AND preview."requestFingerprint" = request_fingerprint_context
        AND preview."impactFingerprint" = impact_fingerprint_context
        AND preview."consumedAt" IS NULL
    );
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
    OR OLD."disabledAt" IS DISTINCT FROM NEW."disabledAt"
    OR governed_rotation;
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

CREATE OR REPLACE FUNCTION "mcp_connection_configuration_revision_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  sentinel CONSTANT CHAR(64) := 'd2ab012fb807b99b7d059aabe98a45dd6edf6941a5f22699f8d04b5906dc2c2b';
  calculated CHAR(64) := sentinel;
  credential_kind "ExternalCredentialKind";
  changed BOOLEAN;
  execute_context TEXT := current_setting('app.mcp_connection_governance_execute_context', true);
  action_context TEXT := current_setting('app.mcp_connection_governance_action', true);
  connection_context TEXT := current_setting('app.mcp_connection_governance_connection_id', true);
  actor_context TEXT := current_setting('app.mcp_connection_governance_actor_id', true);
  preview_context TEXT := current_setting('app.mcp_connection_governance_execute_preview_id', true);
  request_key_context TEXT := current_setting('app.mcp_connection_governance_request_key', true);
  request_fingerprint_context TEXT := current_setting('app.mcp_connection_governance_request_fingerprint', true);
  impact_fingerprint_context TEXT := current_setting('app.mcp_connection_governance_impact_fingerprint', true);
  governed_rotation BOOLEAN;
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

  governed_rotation := execute_context = '1'
    AND action_context = 'rotate_credential'
    AND connection_context = NEW."id"::text
    AND actor_context = NEW."ownerUserId"::text
    AND EXISTS (
      SELECT 1
      FROM "McpConnectionMutationPreview" AS preview
      WHERE preview."id"::text = preview_context
        AND preview."connectionId" = NEW."id"
        AND preview."actorId" = NEW."ownerUserId"
        AND preview."action" = 'rotate_credential'
        AND preview."requestKey" = request_key_context
        AND preview."requestFingerprint" = request_fingerprint_context
        AND preview."impactFingerprint" = impact_fingerprint_context
        AND preview."consumedAt" IS NULL
    );
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
    OR OLD."disabledAt" IS DISTINCT FROM NEW."disabledAt"
    OR governed_rotation;

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

CREATE OR REPLACE FUNCTION "mcp_connection_governance_security_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  context TEXT := current_setting('app.mcp_connection_governance_context', true);
  context_id TEXT := current_setting('app.mcp_connection_governance_connection_id', true);
  context_actor TEXT := current_setting('app.mcp_connection_governance_actor_id', true);
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF context IS DISTINCT FROM '1' OR OLD."id"::text IS DISTINCT FROM context_id
       OR OLD."ownerUserId"::text IS DISTINCT FROM context_actor THEN
      RAISE EXCEPTION 'mcp connection delete requires governance context' USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND (
    OLD."endpointUrl" IS DISTINCT FROM NEW."endpointUrl"
    OR OLD."authKind" IS DISTINCT FROM NEW."authKind"
    OR OLD."credentialFingerprint" IS DISTINCT FROM NEW."credentialFingerprint"
    OR OLD."credentialId" IS DISTINCT FROM NEW."credentialId"
    OR OLD."allowPrivateNetwork" IS DISTINCT FROM NEW."allowPrivateNetwork"
    OR OLD."resolvedAddressFingerprint" IS DISTINCT FROM NEW."resolvedAddressFingerprint"
    OR OLD."protocolVersion" IS DISTINCT FROM NEW."protocolVersion"
    OR OLD."catalogFingerprint" IS DISTINCT FROM NEW."catalogFingerprint"
    OR OLD."configurationRevision" IS DISTINCT FROM NEW."configurationRevision"
    OR OLD."status" IS DISTINCT FROM NEW."status"
    OR OLD."lastDiscoveredAt" IS DISTINCT FROM NEW."lastDiscoveredAt"
    OR OLD."lastErrorCode" IS DISTINCT FROM NEW."lastErrorCode"
    OR OLD."disabledAt" IS DISTINCT FROM NEW."disabledAt"
    OR OLD."createdById" IS DISTINCT FROM NEW."createdById"
    OR OLD."ownerUserId" IS DISTINCT FROM NEW."ownerUserId"
    OR OLD."ownerAccountAccessVersion" IS DISTINCT FROM NEW."ownerAccountAccessVersion"
    OR OLD."ownershipState" IS DISTINCT FROM NEW."ownershipState"
  ) THEN
    IF context IS DISTINCT FROM '1' OR NEW."id"::text IS DISTINCT FROM context_id
       OR NEW."ownerUserId"::text IS DISTINCT FROM context_actor THEN
      RAISE EXCEPTION 'mcp connection security fields require governance context' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "McpConnection_governance_security_guard"
BEFORE UPDATE OR DELETE ON "McpConnection"
FOR EACH ROW EXECUTE FUNCTION "mcp_connection_governance_security_guard"();

CREATE OR REPLACE FUNCTION "git_connection_mutation_preview_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  now_utc TIMESTAMP(3) := (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3);
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF current_setting('app.git_connection_governance_preview_context', true) IS DISTINCT FROM '1'
       OR NEW."id"::text IS DISTINCT FROM current_setting('app.git_connection_governance_preview_id', true)
       OR NEW."connectionId"::text IS DISTINCT FROM current_setting('app.git_connection_governance_connection_id', true)
       OR NEW."actorId"::text IS DISTINCT FROM current_setting('app.git_connection_governance_actor_id', true)
       OR NEW."ownerUserId"::text IS DISTINCT FROM current_setting('app.git_connection_governance_owner_id', true)
       OR NEW."action"::text IS DISTINCT FROM current_setting('app.git_connection_governance_action', true)
       OR NEW."requestKey" IS DISTINCT FROM current_setting('app.git_connection_governance_request_key', true)
       OR NEW."requestFingerprint"::text IS DISTINCT FROM current_setting('app.git_connection_governance_request_fingerprint', true)
       OR NEW."impactFingerprint"::text IS DISTINCT FROM current_setting('app.git_connection_governance_impact_fingerprint', true)
       OR NEW."issuedAt" > now_utc + INTERVAL '5 seconds'
       OR NEW."expiresAt" <= now_utc
       OR NEW."expiresAt" > NEW."issuedAt" + INTERVAL '5 minutes' THEN
      RAISE EXCEPTION 'git connection mutation preview requires exact server context' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'git connection mutation preview is append-only' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."id" IS DISTINCT FROM NEW."id"
     OR OLD."connectionId" IS DISTINCT FROM NEW."connectionId"
     OR OLD."actorId" IS DISTINCT FROM NEW."actorId"
     OR OLD."ownerUserId" IS DISTINCT FROM NEW."ownerUserId"
     OR OLD."action" IS DISTINCT FROM NEW."action"
     OR OLD."requestKey" IS DISTINCT FROM NEW."requestKey"
     OR OLD."requestFingerprint" IS DISTINCT FROM NEW."requestFingerprint"
     OR OLD."impactFingerprint" IS DISTINCT FROM NEW."impactFingerprint"
     OR OLD."issuedAt" IS DISTINCT FROM NEW."issuedAt"
     OR OLD."expiresAt" IS DISTINCT FROM NEW."expiresAt"
     OR OLD."consumedAt" IS NOT NULL OR NEW."consumedAt" IS NULL
     OR NEW."consumedAt" > now_utc + INTERVAL '5 seconds'
     OR current_setting('app.git_connection_governance_execute_context', true) IS DISTINCT FROM '1'
     OR NEW."id"::text IS DISTINCT FROM current_setting('app.git_connection_governance_execute_preview_id', true) THEN
    RAISE EXCEPTION 'git connection mutation preview can only be consumed once' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "GitConnectionMutationPreview_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "GitConnectionMutationPreview"
FOR EACH ROW EXECUTE FUNCTION "git_connection_mutation_preview_guard"();

CREATE OR REPLACE FUNCTION "mcp_connection_mutation_preview_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  now_utc TIMESTAMP(3) := (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3);
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF current_setting('app.mcp_connection_governance_preview_context', true) IS DISTINCT FROM '1'
       OR NEW."id"::text IS DISTINCT FROM current_setting('app.mcp_connection_governance_preview_id', true)
       OR NEW."connectionId"::text IS DISTINCT FROM current_setting('app.mcp_connection_governance_connection_id', true)
       OR NEW."actorId"::text IS DISTINCT FROM current_setting('app.mcp_connection_governance_actor_id', true)
       OR NEW."ownerUserId"::text IS DISTINCT FROM current_setting('app.mcp_connection_governance_owner_id', true)
       OR NEW."action"::text IS DISTINCT FROM current_setting('app.mcp_connection_governance_action', true)
       OR NEW."requestKey" IS DISTINCT FROM current_setting('app.mcp_connection_governance_request_key', true)
       OR NEW."requestFingerprint"::text IS DISTINCT FROM current_setting('app.mcp_connection_governance_request_fingerprint', true)
       OR NEW."impactFingerprint"::text IS DISTINCT FROM current_setting('app.mcp_connection_governance_impact_fingerprint', true)
       OR NEW."issuedAt" > now_utc + INTERVAL '5 seconds'
       OR NEW."expiresAt" <= now_utc
       OR NEW."expiresAt" > NEW."issuedAt" + INTERVAL '5 minutes' THEN
      RAISE EXCEPTION 'mcp connection mutation preview requires exact server context' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'mcp connection mutation preview is append-only' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."id" IS DISTINCT FROM NEW."id"
     OR OLD."connectionId" IS DISTINCT FROM NEW."connectionId"
     OR OLD."actorId" IS DISTINCT FROM NEW."actorId"
     OR OLD."ownerUserId" IS DISTINCT FROM NEW."ownerUserId"
     OR OLD."action" IS DISTINCT FROM NEW."action"
     OR OLD."requestKey" IS DISTINCT FROM NEW."requestKey"
     OR OLD."requestFingerprint" IS DISTINCT FROM NEW."requestFingerprint"
     OR OLD."impactFingerprint" IS DISTINCT FROM NEW."impactFingerprint"
     OR OLD."issuedAt" IS DISTINCT FROM NEW."issuedAt"
     OR OLD."expiresAt" IS DISTINCT FROM NEW."expiresAt"
     OR OLD."consumedAt" IS NOT NULL OR NEW."consumedAt" IS NULL
     OR NEW."consumedAt" > now_utc + INTERVAL '5 seconds'
     OR current_setting('app.mcp_connection_governance_execute_context', true) IS DISTINCT FROM '1'
     OR NEW."id"::text IS DISTINCT FROM current_setting('app.mcp_connection_governance_execute_preview_id', true) THEN
    RAISE EXCEPTION 'mcp connection mutation preview can only be consumed once' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "McpConnectionMutationPreview_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "McpConnectionMutationPreview"
FOR EACH ROW EXECUTE FUNCTION "mcp_connection_mutation_preview_guard"();

CREATE OR REPLACE FUNCTION "connection_mutation_audit_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'connection mutation audit is append-only' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_TABLE_NAME = 'GitConnectionMutationAudit' THEN
    IF current_setting('app.git_connection_governance_execute_context', true) IS DISTINCT FROM '1'
       OR NEW."connectionId"::text IS DISTINCT FROM current_setting('app.git_connection_governance_connection_id', true)
       OR NEW."actorId"::text IS DISTINCT FROM current_setting('app.git_connection_governance_actor_id', true)
       OR NEW."previewId"::text IS DISTINCT FROM current_setting('app.git_connection_governance_execute_preview_id', true) THEN
      RAISE EXCEPTION 'git connection mutation audit requires execute context' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF TG_TABLE_NAME = 'McpConnectionMutationAudit' THEN
    IF current_setting('app.mcp_connection_governance_execute_context', true) IS DISTINCT FROM '1'
       OR NEW."connectionId"::text IS DISTINCT FROM current_setting('app.mcp_connection_governance_connection_id', true)
       OR NEW."actorId"::text IS DISTINCT FROM current_setting('app.mcp_connection_governance_actor_id', true)
       OR NEW."previewId"::text IS DISTINCT FROM current_setting('app.mcp_connection_governance_execute_preview_id', true) THEN
      RAISE EXCEPTION 'mcp connection mutation audit requires execute context' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "GitConnectionMutationAudit_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "GitConnectionMutationAudit"
FOR EACH ROW EXECUTE FUNCTION "connection_mutation_audit_guard"();
CREATE TRIGGER "McpConnectionMutationAudit_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "McpConnectionMutationAudit"
FOR EACH ROW EXECUTE FUNCTION "connection_mutation_audit_guard"();

REVOKE ALL ON TABLE "GitConnectionMutationPreview", "GitConnectionMutationAudit",
  "McpConnectionMutationPreview", "McpConnectionMutationAudit" FROM PUBLIC;
REVOKE ALL ON FUNCTION "git_connection_governance_security_guard"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "git_connection_configuration_version_guard"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "mcp_connection_configuration_revision_guard"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "mcp_connection_governance_security_guard"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "git_connection_mutation_preview_guard"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "mcp_connection_mutation_preview_guard"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "connection_mutation_audit_guard"() FROM PUBLIC;

-- B1 administrator MCP review control plane.  A review freezes the exact
-- candidate tuple and reviewer epoch.  Positive reviews are linked to the
-- immutable V2 attestation created in the same transaction; negative reviews
-- never create authorization evidence.
CREATE TYPE "McpToolReviewConclusion" AS ENUM (
  'read_only_verified', 'read_only_rejected', 'needs_research'
);
CREATE TYPE "McpToolReviewRiskLevel" AS ENUM ('low', 'medium', 'high');
CREATE TYPE "McpToolReviewRiskReasonCode" AS ENUM (
  'read_only_eligible', 'write_capability', 'destructive_capability',
  'untrusted_remote_text', 'schema_invalid', 'network_unverified',
  'credential_scope_unknown', 'insufficient_evidence'
);

CREATE TABLE "McpToolReview" (
  "id" UUID NOT NULL,
  "connectionId" UUID NOT NULL,
  "toolDefinitionId" UUID NOT NULL,
  "toolName" VARCHAR(128) NOT NULL,
  "definitionFingerprint" CHAR(64) NOT NULL,
  "networkFingerprint" CHAR(64) NOT NULL,
  "credentialFingerprint" CHAR(64) NOT NULL,
  "connectionConfigurationRevision" INTEGER NOT NULL,
  "connectionUpdatedAt" TIMESTAMP(3) NOT NULL,
  "connectionOwnerAccountAccessVersion" INTEGER NOT NULL,
  "reviewerId" UUID NOT NULL,
  "reviewerAccountAccessVersion" INTEGER NOT NULL,
  "conclusion" "McpToolReviewConclusion" NOT NULL,
  "riskLevel" "McpToolReviewRiskLevel" NOT NULL,
  "riskReasonCode" "McpToolReviewRiskReasonCode" NOT NULL,
  "evidenceNote" VARCHAR(240) NOT NULL,
  "noteFingerprint" CHAR(64) NOT NULL,
  "requestKey" VARCHAR(180) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "attestationId" UUID,
  "reviewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "transactionId" BIGINT NOT NULL DEFAULT txid_current(),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "McpToolReview_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "McpToolReview_fingerprint_check" CHECK (
    btrim("definitionFingerprint") ~ '^[0-9a-f]{64}$'
    AND btrim("networkFingerprint") ~ '^[0-9a-f]{64}$'
    AND btrim("credentialFingerprint") ~ '^[0-9a-f]{64}$'
    AND btrim("noteFingerprint") ~ '^[0-9a-f]{64}$'
    AND btrim("requestFingerprint") ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "McpToolReview_version_check" CHECK (
    "connectionConfigurationRevision" > 0 AND "connectionOwnerAccountAccessVersion" > 0 AND "reviewerAccountAccessVersion" > 0
  ),
  CONSTRAINT "McpToolReview_evidence_note_check" CHECK (
    char_length("evidenceNote") BETWEEN 1 AND 240
    AND "evidenceNote" !~ '[[:cntrl:]]'
    AND "evidenceNote" !~* '(?:https?://|ftp://|www\.|authorization|cookie|header|bearer[[:space:]]+|basic[[:space:]]+|token|secret|password|private[[:space:]_-]*key|ciphertext|nonce|authtag|endpoint|-----begin|[A-Za-z0-9+/=_-]{32,})'
  ),
  CONSTRAINT "McpToolReview_request_key_check" CHECK (
    btrim("requestKey") <> '' AND "requestKey" !~ '[[:cntrl:]]'
  ),
  CONSTRAINT "McpToolReview_attestation_shape_check" CHECK (
    ("conclusion" = 'read_only_verified' AND "attestationId" IS NOT NULL)
    OR ("conclusion" <> 'read_only_verified' AND "attestationId" IS NULL)
  )
);

CREATE TABLE "McpToolReviewAudit" (
  "id" UUID NOT NULL,
  "reviewId" UUID NOT NULL,
  "connectionId" UUID NOT NULL,
  "toolDefinitionId" UUID NOT NULL,
  "toolName" VARCHAR(128) NOT NULL,
  "definitionFingerprint" CHAR(64) NOT NULL,
  "networkFingerprint" CHAR(64) NOT NULL,
  "credentialFingerprint" CHAR(64) NOT NULL,
  "connectionConfigurationRevision" INTEGER NOT NULL,
  "connectionUpdatedAt" TIMESTAMP(3) NOT NULL,
  "connectionOwnerAccountAccessVersion" INTEGER NOT NULL,
  "reviewerId" UUID NOT NULL,
  "reviewerAccountAccessVersion" INTEGER NOT NULL,
  "conclusion" "McpToolReviewConclusion" NOT NULL,
  "riskLevel" "McpToolReviewRiskLevel" NOT NULL,
  "riskReasonCode" "McpToolReviewRiskReasonCode" NOT NULL,
  "evidenceNotePresent" BOOLEAN NOT NULL,
  "noteFingerprint" CHAR(64) NOT NULL,
  "requestKey" VARCHAR(180) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "attestationId" UUID,
  "reviewedAt" TIMESTAMP(3) NOT NULL,
  "transactionId" BIGINT NOT NULL DEFAULT txid_current(),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "McpToolReviewAudit_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "McpToolReviewAudit_fingerprint_check" CHECK (
    btrim("definitionFingerprint") ~ '^[0-9a-f]{64}$'
    AND btrim("networkFingerprint") ~ '^[0-9a-f]{64}$'
    AND btrim("credentialFingerprint") ~ '^[0-9a-f]{64}$'
    AND btrim("noteFingerprint") ~ '^[0-9a-f]{64}$'
    AND btrim("requestFingerprint") ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "McpToolReviewAudit_version_check" CHECK (
    "connectionConfigurationRevision" > 0 AND "connectionOwnerAccountAccessVersion" > 0 AND "reviewerAccountAccessVersion" > 0
  ),
  CONSTRAINT "McpToolReviewAudit_presence_check" CHECK ("evidenceNotePresent" = TRUE),
  CONSTRAINT "McpToolReviewAudit_request_key_check" CHECK (
    btrim("requestKey") <> '' AND "requestKey" !~ '[[:cntrl:]]'
  ),
  CONSTRAINT "McpToolReviewAudit_attestation_shape_check" CHECK (
    ("conclusion" = 'read_only_verified' AND "attestationId" IS NOT NULL)
    OR ("conclusion" <> 'read_only_verified' AND "attestationId" IS NULL)
  )
);

CREATE UNIQUE INDEX "McpToolReview_reviewerId_requestKey_key"
  ON "McpToolReview"("reviewerId", "requestKey");
CREATE INDEX "McpToolReview_connectionId_toolDefinitionId_createdAt_idx"
  ON "McpToolReview"("connectionId", "toolDefinitionId", "createdAt");
CREATE INDEX "McpToolReview_toolDefinitionId_createdAt_idx"
  ON "McpToolReview"("toolDefinitionId", "createdAt");
CREATE INDEX "McpToolReview_reviewerId_createdAt_idx"
  ON "McpToolReview"("reviewerId", "createdAt");
CREATE INDEX "McpToolReview_attestationId_idx"
  ON "McpToolReview"("attestationId");
CREATE INDEX "McpToolReviewAudit_reviewId_createdAt_idx"
  ON "McpToolReviewAudit"("reviewId", "createdAt");
CREATE INDEX "McpToolReviewAudit_connectionId_createdAt_idx"
  ON "McpToolReviewAudit"("connectionId", "createdAt");
CREATE INDEX "McpToolReviewAudit_toolDefinitionId_createdAt_idx"
  ON "McpToolReviewAudit"("toolDefinitionId", "createdAt");
CREATE INDEX "McpToolReviewAudit_reviewerId_createdAt_idx"
  ON "McpToolReviewAudit"("reviewerId", "createdAt");
CREATE INDEX "McpToolReviewAudit_transactionId_createdAt_idx"
  ON "McpToolReviewAudit"("transactionId", "createdAt");

ALTER TABLE "McpToolReview"
  ADD CONSTRAINT "McpToolReview_reviewerId_fkey"
    FOREIGN KEY ("reviewerId") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "McpToolReviewAudit"
  ADD CONSTRAINT "McpToolReviewAudit_reviewId_fkey"
    FOREIGN KEY ("reviewId") REFERENCES "McpToolReview"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "McpToolReviewAudit_reviewerId_fkey"
    FOREIGN KEY ("reviewerId") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- A V2 attestation is grant-eligible only when an immutable positive review
-- and its immutable audit carry the exact same candidate tuple.  This is
-- intentionally separate from the attestation shape predicate: the review
-- service must be able to create the fresh attestation before inserting the
-- review row in the same transaction.
CREATE OR REPLACE FUNCTION "mcp_tool_attestation_review_eligible"(attestation_row "McpToolAttestation")
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF attestation_row."controlPlaneVersion" IS DISTINCT FROM 2
     OR attestation_row."status" IS DISTINCT FROM 'active'
     OR attestation_row."version" IS DISTINCT FROM 1
     OR attestation_row."connectionConfigurationRevision" IS NULL
     OR attestation_row."connectionOwnerAccountAccessVersion" IS NULL
     OR NOT "mcp_tool_attestation_v2_tuple_valid"(attestation_row) THEN
    RETURN FALSE;
  END IF;
  RETURN EXISTS (
    SELECT 1
    FROM "McpToolReview" AS review
    JOIN "McpToolReviewAudit" AS audit
      ON audit."reviewId" = review."id"
     AND audit."attestationId" = review."attestationId"
    WHERE review."attestationId" = attestation_row."id"
      AND review."connectionId" = attestation_row."connectionId"
      AND review."toolDefinitionId" = attestation_row."toolDefinitionId"
      AND review."toolName" = attestation_row."toolName"
      AND review."definitionFingerprint" = attestation_row."definitionFingerprint"
      AND review."networkFingerprint" = attestation_row."networkFingerprint"
      AND review."credentialFingerprint" = attestation_row."credentialFingerprint"
      AND review."connectionConfigurationRevision" = attestation_row."connectionConfigurationRevision"
      AND review."connectionOwnerAccountAccessVersion" = attestation_row."connectionOwnerAccountAccessVersion"
      AND review."conclusion" = 'read_only_verified'
      AND audit."connectionId" = attestation_row."connectionId"
      AND audit."toolDefinitionId" = attestation_row."toolDefinitionId"
      AND audit."toolName" = attestation_row."toolName"
      AND audit."definitionFingerprint" = attestation_row."definitionFingerprint"
      AND audit."networkFingerprint" = attestation_row."networkFingerprint"
      AND audit."credentialFingerprint" = attestation_row."credentialFingerprint"
      AND audit."connectionConfigurationRevision" = attestation_row."connectionConfigurationRevision"
      AND audit."connectionOwnerAccountAccessVersion" = attestation_row."connectionOwnerAccountAccessVersion"
      AND audit."conclusion" = 'read_only_verified'
      AND audit."evidenceNotePresent" = TRUE
      AND audit."reviewedAt" = review."reviewedAt"
      AND audit."transactionId" = review."transactionId"
  );
END;
$$;

CREATE OR REPLACE FUNCTION "mcp_tool_review_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  note_digest TEXT;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'MCP_TOOL_REVIEW_IMMUTABLE' USING ERRCODE = 'check_violation';
  END IF;
  IF current_setting('app.mcp_tool_review_context', true) IS DISTINCT FROM '1'
     OR NEW."id"::text IS DISTINCT FROM current_setting('app.mcp_tool_review_id', true)
     OR NEW."connectionId"::text IS DISTINCT FROM current_setting('app.mcp_tool_review_connection_id', true)
     OR NEW."toolDefinitionId"::text IS DISTINCT FROM current_setting('app.mcp_tool_review_tool_definition_id', true)
     OR NEW."reviewerId"::text IS DISTINCT FROM current_setting('app.mcp_tool_review_reviewer_id', true)
     OR NEW."reviewerAccountAccessVersion"::text IS DISTINCT FROM current_setting('app.mcp_tool_review_reviewer_epoch', true)
     OR NEW."conclusion"::text IS DISTINCT FROM current_setting('app.mcp_tool_review_conclusion', true)
     OR NEW."riskLevel"::text IS DISTINCT FROM current_setting('app.mcp_tool_review_risk_level', true)
     OR NEW."riskReasonCode"::text IS DISTINCT FROM current_setting('app.mcp_tool_review_risk_reason_code', true)
     OR NEW."requestKey" IS DISTINCT FROM current_setting('app.mcp_tool_review_request_key', true)
     OR NEW."requestFingerprint"::text IS DISTINCT FROM current_setting('app.mcp_tool_review_request_fingerprint', true)
     OR NEW."noteFingerprint"::text IS DISTINCT FROM current_setting('app.mcp_tool_review_note_fingerprint', true)
     OR COALESCE(NEW."attestationId"::text, '') IS DISTINCT FROM current_setting('app.mcp_tool_review_attestation_id', true) THEN
    RAISE EXCEPTION 'MCP_TOOL_REVIEW_CONTEXT_INVALID' USING ERRCODE = 'check_violation';
  END IF;

  note_digest := encode(digest(NEW."evidenceNote", 'sha256'), 'hex');
  IF NEW."noteFingerprint"::text IS DISTINCT FROM note_digest THEN
    RAISE EXCEPTION 'MCP_TOOL_REVIEW_NOTE_FINGERPRINT_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM "AppUser" AS reviewer
    WHERE reviewer."id" = NEW."reviewerId"
      AND reviewer."role" = 'admin'
      AND reviewer."disabledAt" IS NULL
      AND reviewer."accountAccessVersion" = NEW."reviewerAccountAccessVersion"
  ) THEN
    RAISE EXCEPTION 'MCP_TOOL_REVIEW_REVIEWER_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM "McpConnection" AS connection_row
    JOIN "AppUser" AS owner_user
      ON owner_user."id" = connection_row."ownerUserId"
    JOIN "McpToolDefinition" AS definition
      ON definition."id" = NEW."toolDefinitionId"
     AND definition."connectionId" = NEW."connectionId"
     AND definition."name" = NEW."toolName"
    WHERE connection_row."id" = NEW."connectionId"
      AND connection_row."status" = 'verified'
      AND connection_row."disabledAt" IS NULL
      AND connection_row."ownershipState" = 'confirmed'
      AND connection_row."ownerUserId" IS NOT NULL
      AND connection_row."ownerAccountAccessVersion" IS NOT NULL
      AND connection_row."ownerAccountAccessVersion" = NEW."connectionOwnerAccountAccessVersion"
      AND owner_user."disabledAt" IS NULL
      AND owner_user."accountAccessVersion" = NEW."connectionOwnerAccountAccessVersion"
      AND connection_row."configurationRevision" = NEW."connectionConfigurationRevision"
      AND connection_row."updatedAt" = NEW."connectionUpdatedAt"
      AND connection_row."resolvedAddressFingerprint" = NEW."networkFingerprint"
      AND connection_row."credentialFingerprint" = NEW."credentialFingerprint"
      AND definition."current" = TRUE
      AND definition."definitionFingerprint" = NEW."definitionFingerprint"
  ) THEN
    RAISE EXCEPTION 'MCP_TOOL_REVIEW_CANDIDATE_DRIFT' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."conclusion" = 'read_only_verified' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM "McpToolAttestation" AS attestation
      WHERE attestation."id" = NEW."attestationId"
        AND "mcp_tool_attestation_v2_tuple_valid"(attestation)
        AND attestation."connectionId" = NEW."connectionId"
        AND attestation."toolDefinitionId" = NEW."toolDefinitionId"
        AND attestation."toolName" = NEW."toolName"
        AND attestation."definitionFingerprint" = NEW."definitionFingerprint"
        AND attestation."networkFingerprint" = NEW."networkFingerprint"
        AND attestation."credentialFingerprint" = NEW."credentialFingerprint"
        AND attestation."connectionConfigurationRevision" = NEW."connectionConfigurationRevision"
    ) THEN
      RAISE EXCEPTION 'MCP_TOOL_REVIEW_ATTESTATION_REQUIRED' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF EXISTS (
    SELECT 1
    FROM "McpToolAttestation" AS attestation
    WHERE attestation."connectionId" = NEW."connectionId"
      AND attestation."toolDefinitionId" = NEW."toolDefinitionId"
      AND attestation."toolName" = NEW."toolName"
      AND attestation."definitionFingerprint" = NEW."definitionFingerprint"
      AND attestation."networkFingerprint" = NEW."networkFingerprint"
      AND attestation."credentialFingerprint" = NEW."credentialFingerprint"
      AND attestation."connectionConfigurationRevision" = NEW."connectionConfigurationRevision"
      AND "mcp_tool_attestation_review_eligible"(attestation)
  ) THEN
    RAISE EXCEPTION 'MCP_TOOL_REVIEW_NEGATIVE_ATTESTATION_FORBIDDEN' USING ERRCODE = 'check_violation';
  END IF;
  NEW."transactionId" := txid_current();
  RETURN NEW;
END;
$$;

CREATE TRIGGER "McpToolReview_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "McpToolReview"
FOR EACH ROW EXECUTE FUNCTION "mcp_tool_review_guard"();

CREATE OR REPLACE FUNCTION "mcp_tool_review_audit_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  review_row RECORD;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'MCP_TOOL_REVIEW_AUDIT_IMMUTABLE' USING ERRCODE = 'check_violation';
  END IF;
  IF current_setting('app.mcp_tool_review_context', true) IS DISTINCT FROM '1'
     OR NEW."reviewId"::text IS DISTINCT FROM current_setting('app.mcp_tool_review_id', true)
     OR NEW."reviewerId"::text IS DISTINCT FROM current_setting('app.mcp_tool_review_reviewer_id', true) THEN
    RAISE EXCEPTION 'MCP_TOOL_REVIEW_AUDIT_CONTEXT_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO review_row FROM "McpToolReview" WHERE "id" = NEW."reviewId";
  IF NOT FOUND
     OR NEW."connectionId" IS DISTINCT FROM review_row."connectionId"
     OR NEW."toolDefinitionId" IS DISTINCT FROM review_row."toolDefinitionId"
     OR NEW."toolName" IS DISTINCT FROM review_row."toolName"
     OR NEW."definitionFingerprint" IS DISTINCT FROM review_row."definitionFingerprint"
     OR NEW."networkFingerprint" IS DISTINCT FROM review_row."networkFingerprint"
     OR NEW."credentialFingerprint" IS DISTINCT FROM review_row."credentialFingerprint"
     OR NEW."connectionConfigurationRevision" IS DISTINCT FROM review_row."connectionConfigurationRevision"
     OR NEW."connectionUpdatedAt" IS DISTINCT FROM review_row."connectionUpdatedAt"
     OR NEW."connectionOwnerAccountAccessVersion" IS DISTINCT FROM review_row."connectionOwnerAccountAccessVersion"
     OR NEW."reviewerId" IS DISTINCT FROM review_row."reviewerId"
     OR NEW."reviewerAccountAccessVersion" IS DISTINCT FROM review_row."reviewerAccountAccessVersion"
     OR NEW."conclusion" IS DISTINCT FROM review_row."conclusion"
     OR NEW."riskLevel" IS DISTINCT FROM review_row."riskLevel"
     OR NEW."riskReasonCode" IS DISTINCT FROM review_row."riskReasonCode"
     OR NEW."evidenceNotePresent" IS DISTINCT FROM TRUE
     OR NEW."noteFingerprint" IS DISTINCT FROM review_row."noteFingerprint"
     OR NEW."requestKey" IS DISTINCT FROM review_row."requestKey"
     OR NEW."requestFingerprint" IS DISTINCT FROM review_row."requestFingerprint"
     OR NEW."attestationId" IS DISTINCT FROM review_row."attestationId"
     OR NEW."reviewedAt" IS DISTINCT FROM review_row."reviewedAt"
     OR NEW."transactionId" IS DISTINCT FROM txid_current() THEN
    RAISE EXCEPTION 'MCP_TOOL_REVIEW_AUDIT_SNAPSHOT_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  NEW."transactionId" := txid_current();
  RETURN NEW;
END;
$$;

CREATE TRIGGER "McpToolReviewAudit_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "McpToolReviewAudit"
FOR EACH ROW EXECUTE FUNCTION "mcp_tool_review_audit_guard"();

CREATE OR REPLACE FUNCTION "mcp_tool_review_audit_required"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "McpToolReviewAudit"
    WHERE "reviewId" = NEW."id"
      AND "transactionId" = txid_current()
  ) THEN
    RAISE EXCEPTION 'MCP_TOOL_REVIEW_AUDIT_REQUIRED' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "McpToolReview_audit_required"
AFTER INSERT ON "McpToolReview"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "mcp_tool_review_audit_required"();

-- Keep the database boundary closed for direct grant DML as well as the
-- application service.  The historical grant tuple trigger validates the
-- connection/delegation/attestation shape; this companion trigger adds the
-- inverse immutable-review requirement after that shape has been normalized.
CREATE OR REPLACE FUNCTION "project_mcp_tool_grant_review_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP <> 'DELETE'
     AND NEW."controlPlaneVersion" = 2
     AND NEW."status" = 'active'
     AND (
       NEW."attestationId" IS NULL
       OR NOT EXISTS (
         SELECT 1
         FROM "McpToolAttestation" AS attestation
         WHERE attestation."id" = NEW."attestationId"
           AND attestation."connectionId" = NEW."connectionId"
           AND attestation."toolDefinitionId" = NEW."toolDefinitionId"
           AND attestation."toolName" = NEW."toolName"
           AND attestation."definitionFingerprint" = NEW."definitionFingerprint"
           AND attestation."networkFingerprint" = NEW."networkFingerprint"
           AND attestation."credentialFingerprint" = NEW."credentialFingerprint"
           AND "mcp_tool_attestation_review_eligible"(attestation)
       )
     ) THEN
    RAISE EXCEPTION 'PROJECT_MCP_TOOL_GRANT_REVIEW_REQUIRED' USING ERRCODE = 'check_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

DROP TRIGGER IF EXISTS "ProjectMcpToolGrant_review_guard" ON "ProjectMcpToolGrant";
CREATE TRIGGER "ProjectMcpToolGrant_review_guard"
BEFORE INSERT OR UPDATE ON "ProjectMcpToolGrant"
FOR EACH ROW EXECUTE FUNCTION "project_mcp_tool_grant_review_guard"();

REVOKE ALL ON TABLE "McpToolReview", "McpToolReviewAudit" FROM PUBLIC;
REVOKE ALL ON FUNCTION "mcp_tool_attestation_review_eligible"("McpToolAttestation") FROM PUBLIC;
REVOKE ALL ON FUNCTION "project_mcp_tool_grant_review_guard"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "mcp_tool_review_guard"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "mcp_tool_review_audit_guard"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "mcp_tool_review_audit_required"() FROM PUBLIC;
