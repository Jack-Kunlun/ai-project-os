-- P05 personal Git/MCP connection probes.
--
-- A probe is a short lived, owner-epoch-bound proof.  The application is the
-- only writer through the transaction-local context below; the connection
-- INSERT guards additionally require that the proof was atomically consumed
-- for the exact new connection id.

CREATE TYPE "PersonalConnectionProbeKind" AS ENUM ('git', 'mcp');
CREATE TYPE "PersonalConnectionProbeAction" AS ENUM ('create', 'update');
CREATE TYPE "PersonalConnectionProbeStatus" AS ENUM ('running', 'settled', 'rejected', 'held');

CREATE TABLE "PersonalConnectionProbeAttempt" (
  "id" UUID NOT NULL,
  "kind" "PersonalConnectionProbeKind" NOT NULL,
  "action" "PersonalConnectionProbeAction" NOT NULL,
  "connectionId" UUID,
  "actorId" UUID NOT NULL,
  "actorAccountAccessVersion" INTEGER NOT NULL,
  "clientRequestKeyHash" CHAR(64) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "configurationDigest" CHAR(64) NOT NULL,
  "credentialSecretFingerprint" CHAR(64),
  "targetRepositoryPath" VARCHAR(768),
  "targetTrackedRef" VARCHAR(255),
  "resolvedAddressFingerprint" CHAR(64),
  "resultCommitSha" VARCHAR(64),
  "protocolVersion" VARCHAR(32),
  "catalogFingerprint" CHAR(64),
  "resultCount" INTEGER,
  "resultSnapshot" JSONB,
  "status" "PersonalConnectionProbeStatus" NOT NULL,
  "safeErrorCode" VARCHAR(96),
  "evidenceExpiresAt" TIMESTAMP(3),
  "consumedAt" TIMESTAMP(3),
  "consumedConnectionId" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "terminalAt" TIMESTAMP(3),
  CONSTRAINT "PersonalConnectionProbeAttempt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PersonalConnectionProbeAttempt_fingerprint_check" CHECK (
    btrim("clientRequestKeyHash") ~ '^[0-9a-f]{64}$'
    AND btrim("requestFingerprint") ~ '^[0-9a-f]{64}$'
    AND btrim("configurationDigest") ~ '^[0-9a-f]{64}$'
    AND ("credentialSecretFingerprint" IS NULL OR btrim("credentialSecretFingerprint") ~ '^[0-9a-f]{64}$')
    AND ("resolvedAddressFingerprint" IS NULL OR btrim("resolvedAddressFingerprint") ~ '^[0-9a-f]{64}$')
    AND ("catalogFingerprint" IS NULL OR btrim("catalogFingerprint") ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT "PersonalConnectionProbeAttempt_count_check" CHECK ("resultCount" IS NULL OR "resultCount" >= 0),
  CONSTRAINT "PersonalConnectionProbeAttempt_snapshot_check" CHECK (
    "resultSnapshot" IS NULL OR jsonb_typeof("resultSnapshot") IN ('array', 'object')
  ),
  CONSTRAINT "PersonalConnectionProbeAttempt_window_check" CHECK (
    "evidenceExpiresAt" IS NULL OR "evidenceExpiresAt" <= "createdAt" + INTERVAL '5 minutes'
  )
);

CREATE UNIQUE INDEX "PersonalConnectionProbeAttempt_actorId_clientRequestKeyHash_key"
  ON "PersonalConnectionProbeAttempt"("actorId", "clientRequestKeyHash");
CREATE INDEX "PersonalConnectionProbeAttempt_kind_actorId_clientRequestKeyHash_idx"
  ON "PersonalConnectionProbeAttempt"("kind", "actorId", "clientRequestKeyHash");
CREATE INDEX "PersonalConnectionProbeAttempt_connectionId_status_updatedAt_idx"
  ON "PersonalConnectionProbeAttempt"("connectionId", "status", "updatedAt");
CREATE INDEX "PersonalConnectionProbeAttempt_evidenceExpiresAt_consumedAt_idx"
  ON "PersonalConnectionProbeAttempt"("evidenceExpiresAt", "consumedAt");

ALTER TABLE "PersonalConnectionProbeAttempt"
  ADD CONSTRAINT "PersonalConnectionProbeAttempt_actorId_fkey"
    FOREIGN KEY ("actorId") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION "personal_connection_probe_updated_at"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  NEW."updatedAt" := CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "personal_connection_probe_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF current_setting('app.personal_connection_probe_mutation_context', true) IS DISTINCT FROM 'service-v1' THEN
    RAISE EXCEPTION 'personal connection probe mutation requires service context' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'personal connection probe rows are append-only' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    OLD."id" IS DISTINCT FROM NEW."id"
    OR OLD."kind" IS DISTINCT FROM NEW."kind"
    OR OLD."action" IS DISTINCT FROM NEW."action"
    OR OLD."connectionId" IS DISTINCT FROM NEW."connectionId"
    OR OLD."actorId" IS DISTINCT FROM NEW."actorId"
    OR OLD."actorAccountAccessVersion" IS DISTINCT FROM NEW."actorAccountAccessVersion"
    OR OLD."clientRequestKeyHash" IS DISTINCT FROM NEW."clientRequestKeyHash"
    OR OLD."requestFingerprint" IS DISTINCT FROM NEW."requestFingerprint"
    OR OLD."configurationDigest" IS DISTINCT FROM NEW."configurationDigest"
    OR OLD."credentialSecretFingerprint" IS DISTINCT FROM NEW."credentialSecretFingerprint"
    OR OLD."targetRepositoryPath" IS DISTINCT FROM NEW."targetRepositoryPath"
    OR OLD."targetTrackedRef" IS DISTINCT FROM NEW."targetTrackedRef"
    OR OLD."createdAt" IS DISTINCT FROM NEW."createdAt"
  ) THEN
    RAISE EXCEPTION 'personal connection probe identity is immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "PersonalConnectionProbeAttempt_updated_at"
BEFORE UPDATE ON "PersonalConnectionProbeAttempt"
FOR EACH ROW EXECUTE FUNCTION "personal_connection_probe_updated_at"();
CREATE TRIGGER "PersonalConnectionProbeAttempt_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "PersonalConnectionProbeAttempt"
FOR EACH ROW EXECUTE FUNCTION "personal_connection_probe_guard"();

CREATE OR REPLACE FUNCTION "personal_connection_probe_create_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  proof_id UUID;
  proof_actor UUID;
  proof_connection UUID;
  proof_kind "PersonalConnectionProbeKind";
  proof_action "PersonalConnectionProbeAction";
  proof_status "PersonalConnectionProbeStatus";
  proof_consumed_at TIMESTAMP(3);
  proof_expires_at TIMESTAMP(3);
BEGIN
  IF current_setting('app.personal_connection_probe_mutation_context', true) IS DISTINCT FROM 'service-v1'
     OR current_setting('app.personal_connection_probe_id', true) IS NULL
     OR current_setting('app.personal_connection_probe_actor_id', true) IS NULL
     OR current_setting('app.personal_connection_probe_connection_id', true) IS NULL
     OR current_setting('app.personal_connection_probe_kind', true) IS NULL
     OR current_setting('app.personal_connection_probe_action', true) IS NULL THEN
    RAISE EXCEPTION 'personal connection create requires consumed probe' USING ERRCODE = 'check_violation';
  END IF;
  proof_id := current_setting('app.personal_connection_probe_id')::uuid;
  SELECT "actorId", "consumedConnectionId", "kind", "action", "status", "consumedAt", "evidenceExpiresAt"
    INTO proof_actor, proof_connection, proof_kind, proof_action, proof_status, proof_consumed_at, proof_expires_at
    FROM "PersonalConnectionProbeAttempt"
   WHERE "id" = proof_id
   FOR SHARE;
  IF NOT FOUND
     OR proof_status IS DISTINCT FROM 'settled'::"PersonalConnectionProbeStatus"
     OR proof_consumed_at IS NULL
     OR proof_expires_at IS NULL
     OR proof_expires_at <= CURRENT_TIMESTAMP
     OR proof_connection IS DISTINCT FROM NEW."id"
     OR proof_actor IS DISTINCT FROM NEW."ownerUserId"
     OR proof_kind IS DISTINCT FROM current_setting('app.personal_connection_probe_kind')::"PersonalConnectionProbeKind"
     OR proof_action IS DISTINCT FROM 'create'::"PersonalConnectionProbeAction"
     OR NEW."createdById" IS DISTINCT FROM NEW."ownerUserId" THEN
    RAISE EXCEPTION 'personal connection create proof mismatch' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "GitConnection_personal_probe_create_guard"
BEFORE INSERT ON "GitConnection"
FOR EACH ROW EXECUTE FUNCTION "personal_connection_probe_create_guard"();
CREATE TRIGGER "McpConnection_personal_probe_create_guard"
BEFORE INSERT ON "McpConnection"
FOR EACH ROW EXECUTE FUNCTION "personal_connection_probe_create_guard"();

-- Tested rediscovery/retest updates have the same proof boundary as create.
-- Existing non-network governance actions keep their own preview/execute
-- guard; this trigger only activates for the external action names that must
-- consume an owner-bound update proof first.
CREATE OR REPLACE FUNCTION "personal_connection_probe_update_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  action_context TEXT := COALESCE(
    NULLIF(current_setting('app.git_connection_governance_action', true), ''),
    NULLIF(current_setting('app.mcp_connection_governance_action', true), '')
  );
  expected_kind "PersonalConnectionProbeKind";
  proof_id UUID;
  proof_actor UUID;
  proof_connection UUID;
  proof_kind "PersonalConnectionProbeKind";
  proof_action "PersonalConnectionProbeAction";
  proof_status "PersonalConnectionProbeStatus";
  proof_consumed_at TIMESTAMP(3);
  proof_expires_at TIMESTAMP(3);
BEGIN
  IF TG_OP = 'UPDATE'
     AND ((TG_TABLE_NAME = 'GitConnection' AND action_context = 'retest')
       OR (TG_TABLE_NAME = 'McpConnection' AND action_context = 'rediscover')) THEN
    expected_kind := CASE WHEN TG_TABLE_NAME = 'GitConnection' THEN 'git'::"PersonalConnectionProbeKind" ELSE 'mcp'::"PersonalConnectionProbeKind" END;
    IF current_setting('app.personal_connection_probe_mutation_context', true) IS DISTINCT FROM 'service-v1'
       OR current_setting('app.personal_connection_probe_id', true) IS NULL
       OR current_setting('app.personal_connection_probe_actor_id', true) IS NULL
       OR current_setting('app.personal_connection_probe_connection_id', true) IS NULL
       OR current_setting('app.personal_connection_probe_kind', true) IS DISTINCT FROM expected_kind::text
       OR current_setting('app.personal_connection_probe_action', true) IS DISTINCT FROM 'update' THEN
      RAISE EXCEPTION 'tested connection update requires consumed probe' USING ERRCODE = 'check_violation';
    END IF;
    proof_id := current_setting('app.personal_connection_probe_id')::uuid;
    SELECT "actorId", "consumedConnectionId", "kind", "action", "status", "consumedAt", "evidenceExpiresAt"
      INTO proof_actor, proof_connection, proof_kind, proof_action, proof_status, proof_consumed_at, proof_expires_at
      FROM "PersonalConnectionProbeAttempt"
     WHERE "id" = proof_id
     FOR SHARE;
    IF NOT FOUND
       OR proof_status IS DISTINCT FROM 'settled'::"PersonalConnectionProbeStatus"
       OR proof_consumed_at IS NULL
       OR proof_expires_at IS NULL
       OR proof_expires_at <= CURRENT_TIMESTAMP
       OR proof_connection IS DISTINCT FROM NEW."id"
       OR proof_actor IS DISTINCT FROM NEW."ownerUserId"
       OR proof_kind IS DISTINCT FROM expected_kind
       OR proof_action IS DISTINCT FROM 'update'::"PersonalConnectionProbeAction" THEN
      RAISE EXCEPTION 'tested connection update proof mismatch' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "GitConnection_personal_probe_update_guard"
BEFORE UPDATE ON "GitConnection"
FOR EACH ROW EXECUTE FUNCTION "personal_connection_probe_update_guard"();
CREATE TRIGGER "McpConnection_personal_probe_update_guard"
BEFORE UPDATE ON "McpConnection"
FOR EACH ROW EXECUTE FUNCTION "personal_connection_probe_update_guard"();

REVOKE ALL ON TABLE "PersonalConnectionProbeAttempt" FROM PUBLIC;
REVOKE ALL ON FUNCTION "personal_connection_probe_updated_at"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "personal_connection_probe_guard"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "personal_connection_probe_create_guard"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "personal_connection_probe_update_guard"() FROM PUBLIC;
