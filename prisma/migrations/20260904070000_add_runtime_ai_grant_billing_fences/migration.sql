-- Complete the runtime admission evidence for platform AI calls. Nullable
-- route/grant columns preserve historical rows, while every newly admitted
-- runtime reservation and audit carries the full immutable route fence and
-- non-secret credential evidence. The grant reference is deliberately
-- retained without a foreign key at retention time: project deletion may
-- cascade the WebAiGrant while billing and provider-call evidence remains
-- self-contained in its route snapshot.

ALTER TABLE "WebAiGrant"
  ADD COLUMN "boundJobId" UUID;

ALTER TABLE "PlatformTokenReservation"
  ADD COLUMN "webAiGrantId" UUID,
  ADD COLUMN "webAiGrantReferenceId" UUID,
  ADD COLUMN "webAiGrantProjectId" UUID,
  ADD COLUMN "rawEstimatedTokens" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "quotaMultiplierBps" INTEGER NOT NULL DEFAULT 10000,
  ADD COLUMN "routeSource" VARCHAR(32),
  ADD COLUMN "routeId" UUID,
  ADD COLUMN "routeVersion" INTEGER,
  ADD COLUMN "routeUpdatedAt" TIMESTAMP(3),
  ADD COLUMN "providerConfigurationVersion" INTEGER,
  ADD COLUMN "routeFenceFingerprint" CHAR(64),
  ADD COLUMN "rawSettledTokens" INTEGER;

UPDATE "PlatformTokenReservation"
SET "rawEstimatedTokens" = "reservedTokens"
WHERE "rawEstimatedTokens" = 0;

UPDATE "PlatformTokenReservation"
SET "rawSettledTokens" = "settledTokens"
WHERE "settledTokens" IS NOT NULL;

ALTER TABLE "PlatformTokenReservation"
  ALTER COLUMN "rawEstimatedTokens" DROP DEFAULT;

ALTER TABLE "ProviderCallAudit"
  ADD COLUMN "webAiGrantId" UUID,
  ADD COLUMN "webAiGrantReferenceId" UUID,
  ADD COLUMN "webAiGrantProjectId" UUID,
  ADD COLUMN "routeSource" VARCHAR(32),
  ADD COLUMN "routeId" UUID,
  ADD COLUMN "routeVersion" INTEGER,
  ADD COLUMN "routeUpdatedAt" TIMESTAMP(3),
  ADD COLUMN "providerConfigurationVersion" INTEGER,
  ADD COLUMN "quotaMultiplierBps" INTEGER,
  ADD COLUMN "routeFenceFingerprint" CHAR(64),
  ADD COLUMN "credentialSecretFingerprint" CHAR(64);

ALTER TABLE "WebAiGrant"
  ADD CONSTRAINT "WebAiGrant_runtime_binding_check" CHECK (
    ("routeSource" IS NULL AND "routeId" IS NULL AND "routeVersion" IS NULL
      AND "routeUpdatedAt" IS NULL AND "providerConfigurationVersion" IS NULL
      AND "quotaMultiplierBps" IS NULL AND "routeFenceFingerprint" IS NULL
      AND "boundJobId" IS NULL)
    OR ("routeSource" IS NOT NULL AND "boundJobId" IS NOT NULL)
  );

ALTER TABLE "PlatformTokenReservation"
  ADD CONSTRAINT "PlatformTokenReservation_raw_billing_check" CHECK (
    (
      -- Rows created before the runtime fence keep the old integer domain;
      -- the new raw columns are a lossless backfill, not a new historical cap.
      "routeSource" IS NULL AND "routeId" IS NULL AND "routeVersion" IS NULL
      AND "routeUpdatedAt" IS NULL AND "providerConfigurationVersion" IS NULL
      AND "routeFenceFingerprint" IS NULL AND "webAiGrantId" IS NULL
      AND "webAiGrantReferenceId" IS NULL AND "webAiGrantProjectId" IS NULL
      AND "quotaMultiplierBps" = 10000
      AND "rawEstimatedTokens" = "reservedTokens" AND "reservedTokens" > 0
      AND ("rawSettledTokens" IS NULL OR ("settledTokens" IS NOT NULL AND "rawSettledTokens" = "settledTokens" AND "rawSettledTokens" >= 0))
    )
    OR (
      "rawEstimatedTokens" > 0
      AND "rawEstimatedTokens" <= 10000000
      AND "reservedTokens" > 0
      AND "reservedTokens" <= 1000000000
      AND "quotaMultiplierBps" BETWEEN 1 AND 100000
      AND "reservedTokens"::bigint = (("rawEstimatedTokens"::bigint * "quotaMultiplierBps"::bigint + 9999) / 10000)
      AND "routeSource" IN ('project_override', 'platform_default')
      AND "routeSource" IS NOT NULL
      AND "webAiGrantReferenceId" IS NOT NULL
      AND "webAiGrantProjectId" IS NOT NULL
      AND "providerConnectionId" IS NOT NULL
      AND "routeUpdatedAt" IS NOT NULL
      AND "providerConfigurationVersion" IS NOT NULL
      AND "providerConfigurationVersion" > 0
      AND "routeFenceFingerprint" IS NOT NULL
      AND "routeFenceFingerprint" ~ '^[0-9a-f]{64}$'
      AND (
        ("routeSource" = 'platform_default' AND "routeId" IS NOT NULL AND "routeVersion" IS NOT NULL AND "routeVersion" > 0)
        OR ("routeSource" = 'project_override' AND "routeId" IS NULL AND "routeVersion" IS NULL)
      )
      AND (
        "rawSettledTokens" IS NULL
        OR (
          "rawSettledTokens" BETWEEN 0 AND 10000000
          AND "settledTokens" IS NOT NULL
          AND "settledTokens"::bigint = (("rawSettledTokens"::bigint * "quotaMultiplierBps"::bigint + 9999) / 10000)
        )
      )
    )
  );

ALTER TABLE "ProviderCallAudit"
  ADD CONSTRAINT "ProviderCallAudit_runtime_binding_check" CHECK (
    ("webAiGrantId" IS NULL AND "routeSource" IS NULL AND "routeId" IS NULL
      AND "routeVersion" IS NULL AND "routeUpdatedAt" IS NULL
      AND "providerConfigurationVersion" IS NULL AND "quotaMultiplierBps" IS NULL
      AND "routeFenceFingerprint" IS NULL AND "webAiGrantReferenceId" IS NULL
      AND "webAiGrantProjectId" IS NULL
      AND "credentialSecretFingerprint" IS NULL)
    OR (
      "routeSource" IN ('project_override', 'platform_default')
      AND "routeSource" IS NOT NULL
      AND "webAiGrantReferenceId" IS NOT NULL
      AND "webAiGrantProjectId" IS NOT NULL
      AND "routeUpdatedAt" IS NOT NULL
      AND "providerConfigurationVersion" IS NOT NULL
      AND "providerConfigurationVersion" > 0
      AND "quotaMultiplierBps" BETWEEN 1 AND 100000
      AND "routeFenceFingerprint" IS NOT NULL
      AND "routeFenceFingerprint" ~ '^[0-9a-f]{64}$'
      AND "credentialSecretFingerprint" IS NOT NULL
      AND "credentialSecretFingerprint" ~ '^[0-9a-f]{64}$'
      AND (
        ("routeSource" = 'platform_default' AND "routeId" IS NOT NULL AND "routeVersion" IS NOT NULL AND "routeVersion" > 0)
        OR ("routeSource" = 'project_override' AND "routeId" IS NULL AND "routeVersion" IS NULL)
      )
    )
  );

ALTER TABLE "PlatformDefaultAiRoute"
  DROP CONSTRAINT "PlatformDefaultAiRoute_quota_multiplier_check",
  ADD CONSTRAINT "PlatformDefaultAiRoute_quota_multiplier_check" CHECK ("quotaMultiplierBps" > 0);

-- A multiplier is charged in platform-quota units, so the ledger bound must
-- cover the reservation bound rather than the raw provider-token bound.
ALTER TABLE "PlatformTokenLedgerEntry"
  DROP CONSTRAINT "PlatformTokenLedgerEntry_amount_check",
  ADD CONSTRAINT "PlatformTokenLedgerEntry_amount_check"
    CHECK ("amount" >= -1000000000 AND "amount" <= 1000000000),
  DROP CONSTRAINT "PlatformTokenLedgerEntry_usage_check",
  ADD CONSTRAINT "PlatformTokenLedgerEntry_usage_check"
    CHECK ("usageTokens" IS NULL OR "usageTokens" >= 0);

-- The pre-0700 schema allowed route multipliers above the runtime cap. Keep
-- those historical values lossless, but treat the existing outlier value as
-- a non-expandable legacy marker: new rows cannot introduce an outlier and a
-- normal row cannot be changed into one. An existing outlier may only retain
-- its exact value (or be reduced into the bounded domain).
CREATE OR REPLACE FUNCTION "platform_default_ai_route_quota_multiplier_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."quotaMultiplierBps" > 100000 THEN
    IF TG_OP = 'INSERT' THEN
      RAISE EXCEPTION 'platform default AI route quota multiplier exceeds runtime limit'
        USING ERRCODE = 'check_violation';
    ELSIF OLD."quotaMultiplierBps" IS NULL
       OR OLD."quotaMultiplierBps" <= 100000
       OR OLD."quotaMultiplierBps" IS DISTINCT FROM NEW."quotaMultiplierBps"
    THEN
      RAISE EXCEPTION 'platform default AI route quota multiplier exceeds runtime limit'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "PlatformDefaultAiRoute_quota_multiplier_guard"
BEFORE INSERT OR UPDATE ON "PlatformDefaultAiRoute"
FOR EACH ROW EXECUTE FUNCTION "platform_default_ai_route_quota_multiplier_guard"();

-- The old ledger domain allowed any non-negative usageTokens value. Apply the
-- same transition-aware rule so pre-0700 settlement/hold evidence remains
-- readable without allowing post-migration runtime rows to create or expand
-- an oversized usage value.
CREATE OR REPLACE FUNCTION "platform_token_ledger_usage_tokens_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."usageTokens" > 10000000 THEN
    IF TG_OP = 'INSERT' THEN
      RAISE EXCEPTION 'platform token ledger usageTokens exceeds runtime limit'
        USING ERRCODE = 'check_violation';
    ELSIF OLD."usageTokens" IS NULL
       OR OLD."usageTokens" <= 10000000
       OR OLD."usageTokens" IS DISTINCT FROM NEW."usageTokens"
    THEN
      RAISE EXCEPTION 'platform token ledger usageTokens exceeds runtime limit'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "PlatformTokenLedgerEntry_usage_tokens_guard"
BEFORE INSERT OR UPDATE ON "PlatformTokenLedgerEntry"
FOR EACH ROW EXECUTE FUNCTION "platform_token_ledger_usage_tokens_guard"();

CREATE UNIQUE INDEX "WebAiGrant_boundJobId_operation_key"
  ON "WebAiGrant"("boundJobId", "operation");
CREATE INDEX "PlatformTokenReservation_webAiGrantId_createdAt_idx"
  ON "PlatformTokenReservation"("webAiGrantId", "createdAt");
CREATE INDEX "PlatformTokenReservation_webAiGrantReferenceId_createdAt_idx"
  ON "PlatformTokenReservation"("webAiGrantReferenceId", "createdAt");
CREATE INDEX "ProviderCallAudit_webAiGrantId_createdAt_idx"
  ON "ProviderCallAudit"("webAiGrantId", "createdAt");
CREATE INDEX "ProviderCallAudit_webAiGrantReferenceId_createdAt_idx"
  ON "ProviderCallAudit"("webAiGrantReferenceId", "createdAt");

ALTER TABLE "WebAiGrant"
  ADD CONSTRAINT "WebAiGrant_boundJobId_fkey"
  FOREIGN KEY ("boundJobId") REFERENCES "BackgroundJob"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "PlatformTokenReservation"
  ADD CONSTRAINT "PlatformTokenReservation_webAiGrantId_fkey"
  FOREIGN KEY ("webAiGrantId") REFERENCES "WebAiGrant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ProviderCallAudit"
  ADD CONSTRAINT "ProviderCallAudit_webAiGrantId_fkey"
  FOREIGN KEY ("webAiGrantId") REFERENCES "WebAiGrant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Runtime grants are admission evidence, not mutable configuration.  The
-- lifecycle fields (revokedAt) may change, but the identity used by a
-- reservation or provider-call audit must not drift after issuance.
CREATE OR REPLACE FUNCTION "runtime_ai_grant_identity_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."id" IS DISTINCT FROM NEW."id"
     OR OLD."projectId" IS DISTINCT FROM NEW."projectId"
     OR OLD."operation" IS DISTINCT FROM NEW."operation"
     OR OLD."scopeKind" IS DISTINCT FROM NEW."scopeKind"
     OR OLD."scopeIds" IS DISTINCT FROM NEW."scopeIds"
     OR OLD."manifestFingerprint" IS DISTINCT FROM NEW."manifestFingerprint"
     OR OLD."providerConnectionId" IS DISTINCT FROM NEW."providerConnectionId"
     OR OLD."modelId" IS DISTINCT FROM NEW."modelId"
     OR OLD."consentVersion" IS DISTINCT FROM NEW."consentVersion"
     OR OLD."issuedById" IS DISTINCT FROM NEW."issuedById"
     OR OLD."billingMode" IS DISTINCT FROM NEW."billingMode"
     OR OLD."billingUserId" IS DISTINCT FROM NEW."billingUserId"
     OR OLD."callKey" IS DISTINCT FROM NEW."callKey"
     OR OLD."boundJobId" IS DISTINCT FROM NEW."boundJobId"
     OR OLD."routeSource" IS DISTINCT FROM NEW."routeSource"
     OR OLD."routeId" IS DISTINCT FROM NEW."routeId"
     OR OLD."routeVersion" IS DISTINCT FROM NEW."routeVersion"
     OR OLD."routeUpdatedAt" IS DISTINCT FROM NEW."routeUpdatedAt"
     OR OLD."providerConfigurationVersion" IS DISTINCT FROM NEW."providerConfigurationVersion"
     OR OLD."quotaMultiplierBps" IS DISTINCT FROM NEW."quotaMultiplierBps"
     OR OLD."routeFenceFingerprint" IS DISTINCT FROM NEW."routeFenceFingerprint"
     OR OLD."issuedAt" IS DISTINCT FROM NEW."issuedAt"
     OR OLD."expiresAt" IS DISTINCT FROM NEW."expiresAt"
  THEN
    RAISE EXCEPTION 'runtime AI grant identity is immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "WebAiGrant_runtime_identity_guard"
BEFORE UPDATE ON "WebAiGrant"
FOR EACH ROW EXECUTE FUNCTION "runtime_ai_grant_identity_guard"();

-- FK SET NULL is intentional when a project is deleted.  All other evidence
-- identity fields remain immutable; the deferred consistency guard below
-- distinguishes this retention update from a fabricated NULL reference.
CREATE OR REPLACE FUNCTION "runtime_ai_evidence_identity_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_TABLE_NAME = 'PlatformTokenReservation' THEN
    IF OLD."id" IS DISTINCT FROM NEW."id"
       OR OLD."userId" IS DISTINCT FROM NEW."userId"
       OR OLD."grantId" IS DISTINCT FROM NEW."grantId"
       OR OLD."jobId" IS DISTINCT FROM NEW."jobId"
       OR OLD."providerConnectionId" IS DISTINCT FROM NEW."providerConnectionId"
       OR OLD."callKey" IS DISTINCT FROM NEW."callKey"
       OR OLD."operation" IS DISTINCT FROM NEW."operation"
       OR OLD."modelId" IS DISTINCT FROM NEW."modelId"
       OR OLD."reservedTokens" IS DISTINCT FROM NEW."reservedTokens"
       OR OLD."rawEstimatedTokens" IS DISTINCT FROM NEW."rawEstimatedTokens"
       OR OLD."quotaMultiplierBps" IS DISTINCT FROM NEW."quotaMultiplierBps"
       OR OLD."webAiGrantReferenceId" IS DISTINCT FROM NEW."webAiGrantReferenceId"
       OR OLD."webAiGrantProjectId" IS DISTINCT FROM NEW."webAiGrantProjectId"
       OR OLD."routeSource" IS DISTINCT FROM NEW."routeSource"
       OR OLD."routeId" IS DISTINCT FROM NEW."routeId"
       OR OLD."routeVersion" IS DISTINCT FROM NEW."routeVersion"
       OR OLD."routeUpdatedAt" IS DISTINCT FROM NEW."routeUpdatedAt"
       OR OLD."providerConfigurationVersion" IS DISTINCT FROM NEW."providerConfigurationVersion"
       OR OLD."routeFenceFingerprint" IS DISTINCT FROM NEW."routeFenceFingerprint"
       OR (
         OLD."webAiGrantId" IS DISTINCT FROM NEW."webAiGrantId"
         AND NOT (OLD."webAiGrantId" IS NOT NULL AND NEW."webAiGrantId" IS NULL)
       )
    THEN
      RAISE EXCEPTION 'runtime reservation identity is immutable'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."id" IS DISTINCT FROM NEW."id"
     OR OLD."providerConnectionId" IS DISTINCT FROM NEW."providerConnectionId"
     OR OLD."operation" IS DISTINCT FROM NEW."operation"
     OR OLD."modelId" IS DISTINCT FROM NEW."modelId"
     OR OLD."billingMode" IS DISTINCT FROM NEW."billingMode"
     OR OLD."billingUserId" IS DISTINCT FROM NEW."billingUserId"
     OR OLD."callKey" IS DISTINCT FROM NEW."callKey"
     OR OLD."reservationId" IS DISTINCT FROM NEW."reservationId"
     OR OLD."webAiGrantReferenceId" IS DISTINCT FROM NEW."webAiGrantReferenceId"
     OR OLD."webAiGrantProjectId" IS DISTINCT FROM NEW."webAiGrantProjectId"
     OR OLD."routeSource" IS DISTINCT FROM NEW."routeSource"
     OR OLD."routeId" IS DISTINCT FROM NEW."routeId"
     OR OLD."routeVersion" IS DISTINCT FROM NEW."routeVersion"
     OR OLD."routeUpdatedAt" IS DISTINCT FROM NEW."routeUpdatedAt"
     OR OLD."providerConfigurationVersion" IS DISTINCT FROM NEW."providerConfigurationVersion"
     OR OLD."quotaMultiplierBps" IS DISTINCT FROM NEW."quotaMultiplierBps"
     OR OLD."routeFenceFingerprint" IS DISTINCT FROM NEW."routeFenceFingerprint"
     OR OLD."credentialSecretFingerprint" IS DISTINCT FROM NEW."credentialSecretFingerprint"
     OR (
       OLD."webAiGrantId" IS DISTINCT FROM NEW."webAiGrantId"
       AND NOT (OLD."webAiGrantId" IS NOT NULL AND NEW."webAiGrantId" IS NULL)
     )
     OR (
       OLD."jobId" IS DISTINCT FROM NEW."jobId"
       AND NOT (OLD."jobId" IS NOT NULL AND NEW."jobId" IS NULL)
     )
  THEN
    RAISE EXCEPTION 'provider-call audit identity is immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "PlatformTokenReservation_runtime_identity_guard"
BEFORE UPDATE ON "PlatformTokenReservation"
FOR EACH ROW EXECUTE FUNCTION "runtime_ai_evidence_identity_guard"();

CREATE TRIGGER "ProviderCallAudit_runtime_identity_guard"
BEFORE UPDATE ON "ProviderCallAudit"
FOR EACH ROW EXECUTE FUNCTION "runtime_ai_evidence_identity_guard"();

-- CHECK constraints enforce shape and arithmetic.  This deferred guard adds
-- the relational part: a runtime evidence row must point at the exact grant,
-- bound job, platform provider, reservation, and credential fingerprint that
-- were admitted together.  PostgreSQL does not validate Ed25519 or provider
-- credentials here; it only closes structural evidence races.
CREATE OR REPLACE FUNCTION "runtime_ai_evidence_consistency_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  grant_row RECORD;
  token_grant_row RECORD;
  job_row RECORD;
  reservation_row RECORD;
  provider_row RECORD;
  credential_row RECORD;
  reservation_final "PlatformTokenReservation"%ROWTYPE;
  audit_final "ProviderCallAudit"%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME = 'PlatformTokenReservation' THEN
    -- Deferred FK actions can queue more than one UPDATE for the same row
    -- (for example job/grant cleanup during project deletion). Re-read the
    -- row so validation observes the final committed tuple rather than an
    -- intermediate NEW image supplied by the deferred trigger event.
    SELECT *
      INTO reservation_final
      FROM "PlatformTokenReservation"
     WHERE "id" = NEW."id";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'runtime reservation evidence row is missing'
        USING ERRCODE = 'check_violation';
    END IF;
    IF reservation_final."routeSource" IS NULL THEN RETURN NEW; END IF;

    IF reservation_final."webAiGrantId" IS NULL THEN
      -- Project deletion may SET NULL the parent grant FK while retaining
      -- the non-FK evidence reference and route snapshot. The project
      -- evidence id plus its immutable deletion receipt distinguishes that
      -- referential action from a caller fabricating a NULL grant link.
      IF TG_OP <> 'UPDATE'
         OR reservation_final."webAiGrantReferenceId" IS NULL
         OR reservation_final."webAiGrantProjectId" IS NULL
         OR EXISTS (SELECT 1 FROM "WebAiGrant" WHERE "id" = reservation_final."webAiGrantReferenceId")
         OR EXISTS (SELECT 1 FROM "Project" WHERE "id" = reservation_final."webAiGrantProjectId")
         OR NOT EXISTS (
           SELECT 1 FROM "ProjectDeletionReceipt" AS receipt
            WHERE receipt."deletedProjectId" = reservation_final."webAiGrantProjectId"
              AND receipt."status" IN ('database_deleted', 'completed', 'cleanup_failed')
         )
      THEN
        RAISE EXCEPTION 'runtime reservation requires a grant evidence reference'
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END IF;
    IF reservation_final."webAiGrantReferenceId" IS NULL THEN
      RAISE EXCEPTION 'runtime reservation requires a grant evidence reference'
        USING ERRCODE = 'check_violation';
    END IF;

    SELECT
      "id" AS id,
      "projectId" AS project_id,
      "operation" AS operation,
      "providerConnectionId" AS provider_connection_id,
      "modelId" AS model_id,
      "billingMode" AS billing_mode,
      "billingUserId" AS billing_user_id,
      "boundJobId" AS bound_job_id,
      "routeSource" AS route_source,
      "routeId" AS route_id,
      "routeVersion" AS route_version,
      "routeUpdatedAt" AS route_updated_at,
      "providerConfigurationVersion" AS provider_configuration_version,
      "quotaMultiplierBps" AS quota_multiplier_bps,
      "routeFenceFingerprint" AS route_fence_fingerprint
    INTO grant_row
    FROM "WebAiGrant"
    WHERE "id" = reservation_final."webAiGrantId";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'runtime reservation grant evidence is missing'
        USING ERRCODE = 'check_violation';
    END IF;

    IF reservation_final."webAiGrantReferenceId" IS DISTINCT FROM grant_row.id
       OR reservation_final."webAiGrantProjectId" IS DISTINCT FROM grant_row.project_id
       OR grant_row.billing_mode IS DISTINCT FROM 'platform'
       OR reservation_final."userId" IS DISTINCT FROM grant_row.billing_user_id
       OR reservation_final."jobId" IS DISTINCT FROM grant_row.bound_job_id
       OR reservation_final."providerConnectionId" IS DISTINCT FROM grant_row.provider_connection_id
       OR reservation_final."operation" IS DISTINCT FROM grant_row.operation
       OR reservation_final."modelId" IS DISTINCT FROM grant_row.model_id
       OR reservation_final."routeSource" IS DISTINCT FROM grant_row.route_source
       OR reservation_final."routeId" IS DISTINCT FROM grant_row.route_id
       OR reservation_final."routeVersion" IS DISTINCT FROM grant_row.route_version
       OR reservation_final."routeUpdatedAt" IS DISTINCT FROM grant_row.route_updated_at
       OR reservation_final."providerConfigurationVersion" IS DISTINCT FROM grant_row.provider_configuration_version
       OR reservation_final."quotaMultiplierBps" IS DISTINCT FROM grant_row.quota_multiplier_bps
       OR reservation_final."routeFenceFingerprint" IS DISTINCT FROM grant_row.route_fence_fingerprint
    THEN
      RAISE EXCEPTION 'runtime reservation grant tuple mismatch'
        USING ERRCODE = 'check_violation';
    END IF;

    SELECT "userId" AS user_id
    INTO token_grant_row
    FROM "PlatformTokenGrant"
    WHERE "id" = reservation_final."grantId";
    IF NOT FOUND OR token_grant_row.user_id IS DISTINCT FROM reservation_final."userId" THEN
      RAISE EXCEPTION 'runtime reservation token grant owner mismatch'
        USING ERRCODE = 'check_violation';
    END IF;

    SELECT "projectId" AS project_id, "requestedById" AS requested_by_id
    INTO job_row
    FROM "BackgroundJob"
    WHERE "id" = grant_row.bound_job_id;
    IF NOT FOUND
       OR job_row.project_id IS DISTINCT FROM grant_row.project_id
       OR job_row.requested_by_id IS DISTINCT FROM grant_row.billing_user_id
    THEN
      RAISE EXCEPTION 'runtime reservation bound job mismatch'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  SELECT *
    INTO audit_final
    FROM "ProviderCallAudit"
   WHERE "id" = NEW."id";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'runtime provider-call audit evidence row is missing'
      USING ERRCODE = 'check_violation';
  END IF;
  IF audit_final."routeSource" IS NULL THEN RETURN NEW; END IF;

  IF audit_final."webAiGrantId" IS NULL THEN
    -- A runtime audit may become a retained record only through the FK
    -- SET NULL performed while its parent grant is deleted.  INSERTs and
    -- updates while that parent still exists are not allowed to fabricate it.
    IF TG_OP <> 'UPDATE'
       OR audit_final."webAiGrantReferenceId" IS NULL
       OR audit_final."webAiGrantProjectId" IS NULL
       OR EXISTS (SELECT 1 FROM "WebAiGrant" WHERE "id" = audit_final."webAiGrantReferenceId")
       OR EXISTS (SELECT 1 FROM "Project" WHERE "id" = audit_final."webAiGrantProjectId")
       OR NOT EXISTS (
         SELECT 1 FROM "ProjectDeletionReceipt" AS receipt
          WHERE receipt."deletedProjectId" = audit_final."webAiGrantProjectId"
            AND receipt."status" IN ('database_deleted', 'completed', 'cleanup_failed')
       )
    THEN
      RAISE EXCEPTION 'runtime provider-call audit requires a grant evidence reference'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  SELECT
    "id" AS id,
    "projectId" AS project_id,
    "operation" AS operation,
    "providerConnectionId" AS provider_connection_id,
    "modelId" AS model_id,
    "billingMode" AS billing_mode,
    "billingUserId" AS billing_user_id,
    "boundJobId" AS bound_job_id,
    "routeSource" AS route_source,
    "routeId" AS route_id,
    "routeVersion" AS route_version,
    "routeUpdatedAt" AS route_updated_at,
    "providerConfigurationVersion" AS provider_configuration_version,
    "quotaMultiplierBps" AS quota_multiplier_bps,
    "routeFenceFingerprint" AS route_fence_fingerprint
  INTO grant_row
  FROM "WebAiGrant"
  WHERE "id" = audit_final."webAiGrantId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'runtime provider-call audit grant evidence is missing'
      USING ERRCODE = 'check_violation';
  END IF;

  IF audit_final."webAiGrantReferenceId" IS DISTINCT FROM grant_row.id
     OR audit_final."webAiGrantProjectId" IS DISTINCT FROM grant_row.project_id
     OR grant_row.billing_mode IS DISTINCT FROM 'platform'
     OR audit_final."jobId" IS DISTINCT FROM grant_row.bound_job_id
     OR audit_final."providerConnectionId" IS DISTINCT FROM grant_row.provider_connection_id
     OR audit_final."operation" IS DISTINCT FROM grant_row.operation
     OR audit_final."modelId" IS DISTINCT FROM grant_row.model_id
     OR audit_final."billingMode" IS DISTINCT FROM grant_row.billing_mode
     OR audit_final."billingUserId" IS DISTINCT FROM grant_row.billing_user_id
     OR audit_final."routeSource" IS DISTINCT FROM grant_row.route_source
     OR audit_final."routeId" IS DISTINCT FROM grant_row.route_id
     OR audit_final."routeVersion" IS DISTINCT FROM grant_row.route_version
     OR audit_final."routeUpdatedAt" IS DISTINCT FROM grant_row.route_updated_at
     OR audit_final."providerConfigurationVersion" IS DISTINCT FROM grant_row.provider_configuration_version
     OR audit_final."quotaMultiplierBps" IS DISTINCT FROM grant_row.quota_multiplier_bps
     OR audit_final."routeFenceFingerprint" IS DISTINCT FROM grant_row.route_fence_fingerprint
  THEN
    RAISE EXCEPTION 'provider-call audit grant tuple mismatch'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT "projectId" AS project_id, "requestedById" AS requested_by_id
  INTO job_row
  FROM "BackgroundJob"
  WHERE "id" = grant_row.bound_job_id;
  IF NOT FOUND
     OR job_row.project_id IS DISTINCT FROM grant_row.project_id
     OR job_row.requested_by_id IS DISTINCT FROM grant_row.billing_user_id
  THEN
    RAISE EXCEPTION 'provider-call audit bound job mismatch'
      USING ERRCODE = 'check_violation';
  END IF;

  IF audit_final."reservationId" IS NULL THEN
    RAISE EXCEPTION 'platform provider-call audit requires a reservation'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT
    "webAiGrantId" AS web_ai_grant_id,
    "webAiGrantReferenceId" AS web_ai_grant_reference_id,
    "userId" AS user_id,
    "jobId" AS job_id,
    "providerConnectionId" AS provider_connection_id,
    "operation" AS operation,
    "modelId" AS model_id,
    "routeSource" AS route_source,
    "routeId" AS route_id,
    "routeVersion" AS route_version,
    "routeUpdatedAt" AS route_updated_at,
    "providerConfigurationVersion" AS provider_configuration_version,
    "quotaMultiplierBps" AS quota_multiplier_bps,
    "routeFenceFingerprint" AS route_fence_fingerprint
  INTO reservation_row
  FROM "PlatformTokenReservation"
    WHERE "id" = audit_final."reservationId";
  IF NOT FOUND
     OR reservation_row.web_ai_grant_id IS DISTINCT FROM grant_row.id
     OR reservation_row.web_ai_grant_reference_id IS DISTINCT FROM grant_row.id
     OR reservation_row.user_id IS DISTINCT FROM grant_row.billing_user_id
     OR reservation_row.job_id IS DISTINCT FROM grant_row.bound_job_id
     OR reservation_row.provider_connection_id IS DISTINCT FROM grant_row.provider_connection_id
     OR reservation_row.operation IS DISTINCT FROM grant_row.operation
     OR reservation_row.model_id IS DISTINCT FROM grant_row.model_id
     OR reservation_row.route_source IS DISTINCT FROM grant_row.route_source
     OR reservation_row.route_id IS DISTINCT FROM grant_row.route_id
     OR reservation_row.route_version IS DISTINCT FROM grant_row.route_version
     OR reservation_row.route_updated_at IS DISTINCT FROM grant_row.route_updated_at
     OR reservation_row.provider_configuration_version IS DISTINCT FROM grant_row.provider_configuration_version
     OR reservation_row.quota_multiplier_bps IS DISTINCT FROM grant_row.quota_multiplier_bps
     OR reservation_row.route_fence_fingerprint IS DISTINCT FROM grant_row.route_fence_fingerprint
  THEN
    RAISE EXCEPTION 'provider-call audit reservation tuple mismatch'
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT
      "credentialId" AS credential_id,
      "configurationVersion" AS configuration_version,
      "scope" AS scope,
      "ownershipState" AS ownership_state,
      "status" AS status,
      "disabledAt" AS disabled_at
    INTO provider_row
    FROM "AiProviderConnection"
    WHERE "id" = audit_final."providerConnectionId";
    IF NOT FOUND
       OR provider_row.scope IS DISTINCT FROM 'platform'
       OR provider_row.ownership_state IS DISTINCT FROM 'confirmed'
       OR provider_row.status IS DISTINCT FROM 'verified'
       OR provider_row.disabled_at IS NOT NULL
       OR provider_row.configuration_version IS DISTINCT FROM audit_final."providerConfigurationVersion"
    THEN
      RAISE EXCEPTION 'provider-call audit provider fence mismatch'
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT "kind" AS kind, "secretFingerprint" AS secret_fingerprint
    INTO credential_row
    FROM "ExternalCredential"
    WHERE "id" = provider_row.credential_id;
    IF NOT FOUND
       OR credential_row.kind IS DISTINCT FROM 'ai_provider'
       OR credential_row.secret_fingerprint IS DISTINCT FROM audit_final."credentialSecretFingerprint"
    THEN
      RAISE EXCEPTION 'provider-call audit credential fence mismatch'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "PlatformTokenReservation_runtime_evidence_guard"
AFTER INSERT OR UPDATE ON "PlatformTokenReservation"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "runtime_ai_evidence_consistency_guard"();

CREATE CONSTRAINT TRIGGER "ProviderCallAudit_runtime_evidence_guard"
AFTER INSERT OR UPDATE ON "ProviderCallAudit"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "runtime_ai_evidence_consistency_guard"();
