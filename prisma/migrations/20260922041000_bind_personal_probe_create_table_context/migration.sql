-- Complete the table and session binding for proof-gated connection creates.
-- Keep this additive because the original probe migration and 0400 guard are
-- already applied in shared isolated databases.
CREATE OR REPLACE FUNCTION "personal_connection_probe_create_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  expected_kind "PersonalConnectionProbeKind";
  expected_table TEXT := current_setting('app.personal_connection_probe_table', true);
  proof_id UUID;
  proof_actor UUID;
  proof_connection UUID;
  proof_kind "PersonalConnectionProbeKind";
  proof_action "PersonalConnectionProbeAction";
  proof_status "PersonalConnectionProbeStatus";
  proof_consumed_at TIMESTAMP(3);
  proof_expires_at TIMESTAMP(3);
BEGIN
  IF TG_TABLE_NAME = 'GitConnection' THEN
    expected_kind := 'git'::"PersonalConnectionProbeKind";
  ELSIF TG_TABLE_NAME = 'McpConnection' THEN
    expected_kind := 'mcp'::"PersonalConnectionProbeKind";
  ELSE
    RETURN NEW;
  END IF;

  IF expected_table IS DISTINCT FROM TG_TABLE_NAME
     OR current_setting('app.personal_connection_probe_mutation_context', true) IS DISTINCT FROM 'service-v1'
     OR current_setting('app.personal_connection_probe_id', true) IS NULL
     OR current_setting('app.personal_connection_probe_actor_id', true) IS NULL
     OR current_setting('app.personal_connection_probe_connection_id', true) IS NULL
     OR current_setting('app.personal_connection_probe_kind', true) IS DISTINCT FROM expected_kind::text
     OR current_setting('app.personal_connection_probe_action', true) IS DISTINCT FROM 'create' THEN
    RAISE EXCEPTION 'personal connection create requires table-bound consumed probe' USING ERRCODE = 'check_violation';
  END IF;
  proof_id := current_setting('app.personal_connection_probe_id', true)::uuid;
  SELECT "actorId", "consumedConnectionId", "kind", "action", "status", "consumedAt", "evidenceExpiresAt"
    INTO proof_actor, proof_connection, proof_kind, proof_action, proof_status, proof_consumed_at, proof_expires_at
    FROM "PersonalConnectionProbeAttempt"
   WHERE "id" = proof_id
   FOR SHARE;
  IF NOT FOUND
     OR current_setting('app.personal_connection_probe_actor_id', true)::uuid IS DISTINCT FROM NEW."ownerUserId"
     OR current_setting('app.personal_connection_probe_connection_id', true)::uuid IS DISTINCT FROM NEW."id"
     OR proof_status IS DISTINCT FROM 'settled'::"PersonalConnectionProbeStatus"
     OR proof_consumed_at IS NULL
     OR proof_expires_at IS NULL
     OR proof_expires_at <= CURRENT_TIMESTAMP
     OR proof_connection IS DISTINCT FROM NEW."id"
     OR proof_actor IS DISTINCT FROM NEW."ownerUserId"
     OR proof_kind IS DISTINCT FROM expected_kind
     OR proof_action IS DISTINCT FROM 'create'::"PersonalConnectionProbeAction"
     OR NEW."createdById" IS DISTINCT FROM NEW."ownerUserId" THEN
    RAISE EXCEPTION 'personal connection create table or proof mismatch' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION "personal_connection_probe_create_guard"() FROM PUBLIC;

-- Also bind the session actor and connection settings on tested updates. The
-- 0400 function already bound the table/kind; this replacement closes the
-- remaining context identity gap without editing that applied migration.
CREATE OR REPLACE FUNCTION "personal_connection_probe_update_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  action_context TEXT;
  expected_table TEXT := current_setting('app.personal_connection_probe_table', true);
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
  IF TG_OP = 'UPDATE' THEN
    IF TG_TABLE_NAME = 'GitConnection' THEN
      action_context := NULLIF(current_setting('app.git_connection_governance_action', true), '');
      expected_kind := 'git'::"PersonalConnectionProbeKind";
    ELSIF TG_TABLE_NAME = 'McpConnection' THEN
      action_context := NULLIF(current_setting('app.mcp_connection_governance_action', true), '');
      expected_kind := 'mcp'::"PersonalConnectionProbeKind";
    ELSE
      RETURN NEW;
    END IF;
    IF action_context IN ('retest', 'rediscover') THEN
      IF expected_table IS DISTINCT FROM TG_TABLE_NAME
         OR current_setting('app.personal_connection_probe_mutation_context', true) IS DISTINCT FROM 'service-v1'
         OR current_setting('app.personal_connection_probe_id', true) IS NULL
         OR current_setting('app.personal_connection_probe_actor_id', true) IS NULL
         OR current_setting('app.personal_connection_probe_connection_id', true) IS NULL
         OR current_setting('app.personal_connection_probe_actor_id')::uuid IS DISTINCT FROM NEW."ownerUserId"
         OR current_setting('app.personal_connection_probe_connection_id')::uuid IS DISTINCT FROM NEW."id"
         OR current_setting('app.personal_connection_probe_kind', true) IS DISTINCT FROM expected_kind::text
         OR current_setting('app.personal_connection_probe_action', true) IS DISTINCT FROM 'update' THEN
        RAISE EXCEPTION 'tested connection update requires table-bound consumed probe' USING ERRCODE = 'check_violation';
      END IF;
      proof_id := current_setting('app.personal_connection_probe_id', true)::uuid;
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
        RAISE EXCEPTION 'tested connection update table or proof mismatch' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION "personal_connection_probe_update_guard"() FROM PUBLIC;
