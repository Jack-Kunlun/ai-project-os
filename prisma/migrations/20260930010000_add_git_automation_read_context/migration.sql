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
