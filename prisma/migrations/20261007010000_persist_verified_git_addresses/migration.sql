ALTER TABLE "GitConnection"
  ADD COLUMN "verifiedAddresses" JSONB,
  ADD CONSTRAINT "GitConnection_verifiedAddresses_shape_check"
    CHECK (
      "verifiedAddresses" IS NULL OR CASE
        WHEN jsonb_typeof("verifiedAddresses") = 'array'
          THEN jsonb_array_length("verifiedAddresses") BETWEEN 1 AND 256
            AND "resolvedAddressFingerprint" IS NOT NULL
        ELSE FALSE
      END
    );

ALTER TABLE "PersonalConnectionProbeAttempt"
  ADD COLUMN "verifiedAddresses" JSONB,
  ADD CONSTRAINT "PersonalConnectionProbeAttempt_verifiedAddresses_shape_check"
    CHECK (
      "verifiedAddresses" IS NULL OR CASE
        WHEN jsonb_typeof("verifiedAddresses") = 'array'
          THEN jsonb_array_length("verifiedAddresses") BETWEEN 1 AND 256
            AND "resolvedAddressFingerprint" IS NOT NULL
        ELSE FALSE
      END
    );

-- Expose one narrowly scoped, lease-bound read of the Git configuration and
-- current shared publication cursor. The worker receives no table SELECT on
-- credentials, connections, delegations, or publication state.

CREATE OR REPLACE FUNCTION public."project_git_automation_read_context"(
  run_id UUID,
  worker_id VARCHAR(128),
  lease_token UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  grant_id UUID;
  database_now TIMESTAMP(3);
  grant_row public."ProjectGitRepositoryAutomationGrant"%ROWTYPE;
  cursor_row public."ProjectGitRepositoryAutomationScheduleCursor"%ROWTYPE;
  run_row public."ProjectGitRepositoryAutomationRun"%ROWTYPE;
  base_row public."ProjectGitRepositoryDelegation"%ROWTYPE;
  connection_row public."GitConnection"%ROWTYPE;
  credential_row public."ExternalCredential"%ROWTYPE;
  head_row public."ProjectGitRepositoryPublicationHead"%ROWTYPE;
  baseline_frozen_commit_sha TEXT;
  baseline_repository_path TEXT;
  baseline_tracked_ref TEXT;
  baseline_published_at TIMESTAMPTZ(3);
  baseline_file_count INTEGER;
  baseline_value JSONB;
  eligibility_reason TEXT;
BEGIN
  IF SESSION_USER IS DISTINCT FROM 'ai_project_os_git_automation_worker' THEN
    RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_WORKER_SESSION_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF pg_catalog.current_setting('transaction_isolation') <> 'serializable' THEN
    RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_SERIALIZABLE_REQUIRED' USING ERRCODE = '25001';
  END IF;
  IF run_id IS NULL OR worker_id IS NULL
     OR worker_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
     OR lease_token IS NULL THEN
    RAISE EXCEPTION 'PROJECT_GIT_AUTOMATION_READ_CONTEXT_INVALID' USING ERRCODE = 'check_violation';
  END IF;

  -- The run's immutable grant id is the only lookup before the canonical
  -- actor/workspace/project/Git advisory locks. Row locks then follow the
  -- grant -> cursor -> run -> publication-head order used by transitions.
  SELECT "grantId" INTO grant_id
    FROM public."ProjectGitRepositoryAutomationRun"
   WHERE "id" = run_id;
  IF NOT FOUND OR NOT public."project_git_automation_lock_grant"(grant_id) THEN
    RETURN NULL;
  END IF;

  database_now := pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp() AT TIME ZONE 'UTC');
  SELECT * INTO grant_row
    FROM public."ProjectGitRepositoryAutomationGrant"
   WHERE "id" = grant_id
   FOR SHARE;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT * INTO cursor_row
    FROM public."ProjectGitRepositoryAutomationScheduleCursor"
   WHERE "grantId" = grant_id
   FOR SHARE;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT * INTO run_row
    FROM public."ProjectGitRepositoryAutomationRun"
   WHERE "id" = run_id
   FOR SHARE;
  IF NOT FOUND
     OR run_row."grantId" IS DISTINCT FROM grant_id
     OR run_row."status" <> 'dispatched'
     OR run_row."leaseWorkerId" IS DISTINCT FROM worker_id
     OR run_row."leaseToken" IS DISTINCT FROM lease_token
     OR run_row."leaseExpiresAt" IS NULL
     OR run_row."leaseExpiresAt" <= database_now
     OR run_row."dispatchedAt" IS NULL
     OR run_row."dispatchedAt" > database_now
     OR run_row."completedAt" IS NOT NULL
     OR run_row."safeErrorCode" IS NOT NULL
     OR grant_row."status" <> 'active'
     OR grant_row."expiresAt" <= database_now
     OR cursor_row."status" <> 'active'
     OR cursor_row."projectId" IS DISTINCT FROM run_row."projectId"
     OR cursor_row."workspaceId" IS DISTINCT FROM run_row."workspaceId"
     OR cursor_row."connectionOwnerId" IS DISTINCT FROM run_row."connectionOwnerId" THEN
    RETURN NULL;
  END IF;

  eligibility_reason := public."project_git_automation_grant_eligibility"(grant_id, run_row."projectId", database_now);
  IF eligibility_reason IS NOT NULL
     OR NOT public."project_git_automation_run_snapshot_matches"(run_id) THEN
    RETURN NULL;
  END IF;

  SELECT * INTO base_row
    FROM public."ProjectGitRepositoryDelegation"
   WHERE "id" = run_row."baseDelegationId"
     AND "projectId" = run_row."projectId"
   FOR SHARE;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT * INTO connection_row
    FROM public."GitConnection"
   WHERE "id" = run_row."gitConnectionId"
   FOR SHARE;
  IF NOT FOUND
     OR connection_row."status" <> 'verified'
     OR connection_row."ownershipState" <> 'confirmed'
     OR connection_row."ownerUserId" IS DISTINCT FROM run_row."connectionOwnerId"
     OR connection_row."ownerAccountAccessVersion" IS DISTINCT FROM grant_row."connectionOwnerAccountAccessVersion"
     OR connection_row."configurationVersion" IS DISTINCT FROM base_row."connectionConfigurationVersion"
     OR connection_row."resolvedAddressFingerprint" IS DISTINCT FROM base_row."resolvedAddressFingerprint"
     OR connection_row."authKind" = 'none'
     OR (connection_row."transport" = 'ssh') IS DISTINCT FROM (connection_row."authKind" = 'ssh_key')
     OR connection_row."credentialId" IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT * INTO credential_row
    FROM public."ExternalCredential"
   WHERE "id" = connection_row."credentialId"
   FOR SHARE;
  IF NOT FOUND
     OR credential_row."kind" <> 'git'
     OR credential_row."keyVersion" <> 1
     OR credential_row."secretFingerprint" IS DISTINCT FROM base_row."credentialFingerprint" THEN
    RETURN NULL;
  END IF;

  SELECT * INTO head_row
    FROM public."ProjectGitRepositoryPublicationHead"
   WHERE "projectId" = run_row."projectId"
     AND "delegationId" = run_row."baseDelegationId"
   FOR SHARE;
  IF run_row."expectedPublicationVersionId" IS NULL THEN
    IF run_row."expectedPublicationGeneration" <> 0 OR FOUND THEN RETURN NULL; END IF;
    baseline_value := NULL;
  ELSE
    IF NOT FOUND
       OR head_row."currentPublicationVersionId" IS DISTINCT FROM run_row."expectedPublicationVersionId"
       OR head_row."generation" IS DISTINCT FROM run_row."expectedPublicationGeneration" THEN
      RETURN NULL;
    END IF;
    SELECT pg_catalog.btrim(version_row."frozenCommitSha"), version_row."repositoryPath",
           version_row."trackedRef", version_row."publishedAt", version_row."fileCount"
      INTO baseline_frozen_commit_sha, baseline_repository_path, baseline_tracked_ref,
           baseline_published_at, baseline_file_count
      FROM public."ProjectGitRepositoryPublicationVersion" version_row
     WHERE version_row."id" = run_row."expectedPublicationVersionId"
       AND version_row."projectId" = run_row."projectId"
       AND version_row."delegationId" = run_row."baseDelegationId"
       AND version_row."delegationVersion" = run_row."baseDelegationVersion"
       AND version_row."delegationFingerprint" = run_row."baseDelegationFingerprint";
    IF NOT FOUND
       OR baseline_frozen_commit_sha !~ '^([0-9a-f]{40}|[0-9a-f]{64})$'
       OR baseline_repository_path IS DISTINCT FROM run_row."repositoryPath"
       OR baseline_tracked_ref IS DISTINCT FROM run_row."trackedRef"
       OR baseline_published_at IS DISTINCT FROM head_row."publishedAt"
       OR baseline_file_count <= 0 THEN
      RETURN NULL;
    END IF;
    baseline_value := pg_catalog.jsonb_build_object('frozenCommitSha', baseline_frozen_commit_sha);
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'connection', pg_catalog.jsonb_build_object(
      'id', connection_row."id"::TEXT,
      'providerKind', connection_row."providerKind"::TEXT,
      'transport', connection_row."transport"::TEXT,
      'baseUrl', connection_row."baseUrl",
      'authKind', CASE connection_row."authKind"::TEXT
        WHEN 'ssh_key' THEN 'sshKey'
        ELSE connection_row."authKind"::TEXT
      END,
      'username', connection_row."username",
      'allowPrivateNetwork', connection_row."allowPrivateNetwork",
      'tlsCaCertificate', connection_row."tlsCaCertificate",
      'sshKnownHost', connection_row."sshKnownHost",
      'resolvedAddressFingerprint', connection_row."resolvedAddressFingerprint",
      'verifiedAddresses', connection_row."verifiedAddresses",
      'credentialId', connection_row."credentialId"::TEXT
    ),
    'credential', pg_catalog.jsonb_build_object(
      'kind', credential_row."kind"::TEXT,
      'ciphertext', pg_catalog.replace(pg_catalog.encode(credential_row."ciphertext", 'base64'), E'\n', ''),
      'nonce', pg_catalog.replace(pg_catalog.encode(credential_row."nonce", 'base64'), E'\n', ''),
      'authTag', pg_catalog.replace(pg_catalog.encode(credential_row."authTag", 'base64'), E'\n', ''),
      'keyVersion', credential_row."keyVersion",
      'secretFingerprint', credential_row."secretFingerprint"
    ),
    'baseline', baseline_value
  );
END;
$$;

REVOKE ALL ON FUNCTION public."project_git_automation_read_context"(UUID, VARCHAR, UUID) FROM PUBLIC;

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
    OR OLD."verifiedAddresses" IS DISTINCT FROM NEW."verifiedAddresses"
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

REVOKE ALL ON FUNCTION "git_connection_governance_security_guard"() FROM PUBLIC;

CREATE OR REPLACE FUNCTION "personal_connection_probe_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  address_value JSONB;
  address_text TEXT;
  previous_address TEXT;
  parsed_address INET;
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
  IF NEW."verifiedAddresses" IS NOT NULL THEN
    IF NEW."kind" <> 'git'::"PersonalConnectionProbeKind"
       OR NEW."resolvedAddressFingerprint" IS NULL THEN
      RAISE EXCEPTION 'personal connection probe verified endpoint shape invalid' USING ERRCODE = 'check_violation';
    END IF;
    IF jsonb_typeof(NEW."verifiedAddresses") <> 'array' THEN
      RAISE EXCEPTION 'personal connection probe verified endpoint shape invalid' USING ERRCODE = 'check_violation';
    END IF;
    IF jsonb_array_length(NEW."verifiedAddresses") NOT BETWEEN 1 AND 256 THEN
      RAISE EXCEPTION 'personal connection probe verified endpoint shape invalid' USING ERRCODE = 'check_violation';
    END IF;
    FOR address_value IN
      SELECT value
        FROM jsonb_array_elements(NEW."verifiedAddresses") WITH ORDINALITY AS entries(value, ordinal)
       ORDER BY ordinal
    LOOP
      IF jsonb_typeof(address_value) <> 'string' OR address_value #>> '{}' = '' THEN
        RAISE EXCEPTION 'personal connection probe verified endpoint item invalid' USING ERRCODE = 'check_violation';
      END IF;
      address_text := address_value #>> '{}';
      IF address_text ~ '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' THEN
        BEGIN
          parsed_address := address_text::inet;
        EXCEPTION WHEN invalid_text_representation THEN
          RAISE EXCEPTION 'personal connection probe verified endpoint item invalid' USING ERRCODE = 'check_violation';
        END;
        IF family(parsed_address) <> 4 OR host(parsed_address) IS DISTINCT FROM address_text THEN
          RAISE EXCEPTION 'personal connection probe verified endpoint item invalid' USING ERRCODE = 'check_violation';
        END IF;
      ELSIF address_text ~ '^[0-9A-Fa-f:.]+$' AND position(':' IN address_text) > 0 THEN
        BEGIN
          parsed_address := address_text::inet;
        EXCEPTION WHEN invalid_text_representation THEN
          RAISE EXCEPTION 'personal connection probe verified endpoint item invalid' USING ERRCODE = 'check_violation';
        END;
        IF family(parsed_address) <> 6 OR address_text <> lower(address_text) THEN
          RAISE EXCEPTION 'personal connection probe verified endpoint item invalid' USING ERRCODE = 'check_violation';
        END IF;
      ELSE
        RAISE EXCEPTION 'personal connection probe verified endpoint item invalid' USING ERRCODE = 'check_violation';
      END IF;
      IF previous_address IS NOT NULL
         AND previous_address COLLATE "C" >= address_text COLLATE "C" THEN
        RAISE EXCEPTION 'personal connection probe verified endpoint order invalid' USING ERRCODE = 'check_violation';
      END IF;
      previous_address := address_text;
    END LOOP;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."status" <> 'running'::"PersonalConnectionProbeStatus"
     AND (OLD."resolvedAddressFingerprint" IS DISTINCT FROM NEW."resolvedAddressFingerprint"
       OR OLD."verifiedAddresses" IS DISTINCT FROM NEW."verifiedAddresses") THEN
    RAISE EXCEPTION 'personal connection probe endpoint evidence is immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION "personal_connection_probe_guard"() FROM PUBLIC;

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
  proof_address_fingerprint TEXT;
  proof_verified_addresses JSONB;
  endpoint_parts TEXT[];
  endpoint_addresses TEXT;
  endpoint_port TEXT;
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
  SELECT "actorId", "consumedConnectionId", "kind", "action", "status", "consumedAt", "evidenceExpiresAt",
         "resolvedAddressFingerprint", "verifiedAddresses"
    INTO proof_actor, proof_connection, proof_kind, proof_action, proof_status, proof_consumed_at, proof_expires_at,
         proof_address_fingerprint, proof_verified_addresses
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
  IF expected_kind = 'git'::"PersonalConnectionProbeKind" THEN
    IF proof_address_fingerprint IS DISTINCT FROM NEW."resolvedAddressFingerprint"
       OR proof_verified_addresses IS DISTINCT FROM NEW."verifiedAddresses" THEN
      RAISE EXCEPTION 'personal connection create table or proof mismatch' USING ERRCODE = 'check_violation';
    END IF;
    IF proof_verified_addresses IS NOT NULL THEN
      endpoint_parts := pg_catalog.regexp_match(
        NEW."baseUrl",
        '^(https|ssh)://(?:([A-Za-z0-9._-]+)@)?(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(?::([0-9]{1,5}))?(?:/[A-Za-z0-9._/-]+)?$'
      );
      IF endpoint_parts IS NULL OR (endpoint_parts[1] = 'https' AND endpoint_parts[2] IS NOT NULL) THEN
        RAISE EXCEPTION 'personal connection create endpoint fingerprint mismatch' USING ERRCODE = 'check_violation';
      END IF;
      endpoint_port := COALESCE(NULLIF(endpoint_parts[4], ''), CASE endpoint_parts[1] WHEN 'ssh' THEN '22' ELSE '443' END);
      SELECT pg_catalog.string_agg(entry.value #>> '{}', ',' ORDER BY entry.ordinality)
        INTO endpoint_addresses
        FROM pg_catalog.jsonb_array_elements(NEW."verifiedAddresses") WITH ORDINALITY AS entry(value, ordinality);
      IF proof_address_fingerprint IS DISTINCT FROM pg_catalog.encode(
        public.digest(pg_catalog.convert_to(
          pg_catalog.lower(endpoint_parts[3]) || ':' || endpoint_port || ':' || endpoint_addresses,
          'UTF8'
        ), 'sha256'),
        'hex'
      ) THEN
        RAISE EXCEPTION 'personal connection create endpoint fingerprint mismatch' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  ELSIF proof_verified_addresses IS NOT NULL THEN
    RAISE EXCEPTION 'personal connection create table or proof mismatch' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION "personal_connection_probe_create_guard"() FROM PUBLIC;

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
  proof_address_fingerprint TEXT;
  proof_verified_addresses JSONB;
  endpoint_parts TEXT[];
  endpoint_addresses TEXT;
  endpoint_port TEXT;
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
      SELECT "actorId", "consumedConnectionId", "kind", "action", "status", "consumedAt", "evidenceExpiresAt",
             "resolvedAddressFingerprint", "verifiedAddresses"
        INTO proof_actor, proof_connection, proof_kind, proof_action, proof_status, proof_consumed_at, proof_expires_at,
             proof_address_fingerprint, proof_verified_addresses
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
      IF expected_kind = 'git'::"PersonalConnectionProbeKind" THEN
        IF proof_address_fingerprint IS DISTINCT FROM NEW."resolvedAddressFingerprint"
           OR proof_verified_addresses IS DISTINCT FROM NEW."verifiedAddresses" THEN
          RAISE EXCEPTION 'tested connection update table or proof mismatch' USING ERRCODE = 'check_violation';
        END IF;
        IF proof_verified_addresses IS NOT NULL THEN
          endpoint_parts := pg_catalog.regexp_match(
            NEW."baseUrl",
            '^(https|ssh)://(?:([A-Za-z0-9._-]+)@)?(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(?::([0-9]{1,5}))?(?:/[A-Za-z0-9._/-]+)?$'
          );
          IF endpoint_parts IS NULL OR (endpoint_parts[1] = 'https' AND endpoint_parts[2] IS NOT NULL) THEN
            RAISE EXCEPTION 'tested connection update endpoint fingerprint mismatch' USING ERRCODE = 'check_violation';
          END IF;
          endpoint_port := COALESCE(NULLIF(endpoint_parts[4], ''), CASE endpoint_parts[1] WHEN 'ssh' THEN '22' ELSE '443' END);
          SELECT pg_catalog.string_agg(entry.value #>> '{}', ',' ORDER BY entry.ordinality)
            INTO endpoint_addresses
            FROM pg_catalog.jsonb_array_elements(NEW."verifiedAddresses") WITH ORDINALITY AS entry(value, ordinality);
          IF proof_address_fingerprint IS DISTINCT FROM pg_catalog.encode(
            public.digest(pg_catalog.convert_to(
              pg_catalog.lower(endpoint_parts[3]) || ':' || endpoint_port || ':' || endpoint_addresses,
              'UTF8'
            ), 'sha256'),
            'hex'
          ) THEN
            RAISE EXCEPTION 'tested connection update endpoint fingerprint mismatch' USING ERRCODE = 'check_violation';
          END IF;
        END IF;
      ELSIF proof_verified_addresses IS NOT NULL THEN
        RAISE EXCEPTION 'tested connection update table or proof mismatch' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION "personal_connection_probe_update_guard"() FROM PUBLIC;
