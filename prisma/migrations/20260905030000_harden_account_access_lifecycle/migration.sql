-- Account access lifecycle v1.
--
-- Account suspension is an epoch transition.  A session captures the epoch
-- at creation and authentication requires that snapshot to match the current
-- user row.  Lifecycle writes are preview-bound and are admitted only through
-- a transaction-local context; audit rows are append-only evidence for the
-- same transition.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE "AccountAccessAction" AS ENUM ('disable', 'restore');
CREATE TYPE "AccountAccessAuditEvent" AS ENUM ('disabled', 'restored');

ALTER TABLE "AppUser"
  ADD COLUMN "accountAccessVersion" INTEGER NOT NULL DEFAULT 1,
  ADD CONSTRAINT "AppUser_account_access_version_check" CHECK ("accountAccessVersion" > 0);

ALTER TABLE "AppSession"
  ADD COLUMN "accountAccessVersion" INTEGER NOT NULL DEFAULT 1,
  ADD CONSTRAINT "AppSession_account_access_version_check" CHECK ("accountAccessVersion" > 0);

CREATE TABLE "AccountAccessMutationPreview" (
  "id" UUID NOT NULL,
  "actorId" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "action" "AccountAccessAction" NOT NULL,
  "expectedVersion" INTEGER NOT NULL,
  "impactFingerprint" CHAR(64) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "issuedAt" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AccountAccessMutationPreview_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AccountAccessMutationPreview_version_check" CHECK ("expectedVersion" > 0),
  CONSTRAINT "AccountAccessMutationPreview_fingerprint_check" CHECK (
    btrim("impactFingerprint") ~ '^[0-9a-f]{64}$'
    AND btrim("requestFingerprint") ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "AccountAccessMutationPreview_window_check" CHECK ("expiresAt" > "issuedAt")
);

CREATE INDEX "AccountAccessMutationPreview_actorId_userId_createdAt_idx"
  ON "AccountAccessMutationPreview"("actorId", "userId", "createdAt");
CREATE INDEX "AccountAccessMutationPreview_expiresAt_consumedAt_idx"
  ON "AccountAccessMutationPreview"("expiresAt", "consumedAt");

CREATE TABLE "AccountAccessAudit" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "userId" UUID NOT NULL,
  "actorId" UUID NOT NULL,
  "event" "AccountAccessAuditEvent" NOT NULL,
  "versionBefore" INTEGER NOT NULL,
  "versionAfter" INTEGER NOT NULL,
  "disabledAtBefore" TIMESTAMP(3),
  "disabledAtAfter" TIMESTAMP(3),
  "disabledReasonBefore" VARCHAR(500),
  "disabledReasonAfter" VARCHAR(500),
  "disabledByIdBefore" UUID,
  "disabledByIdAfter" UUID,
  "previewId" UUID NOT NULL,
  "reason" VARCHAR(500) NOT NULL,
  "requestKey" VARCHAR(180) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "impactFingerprint" CHAR(64) NOT NULL,
  "transactionId" BIGINT NOT NULL DEFAULT txid_current(),
  "transitionAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "contractVersion" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AccountAccessAudit_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AccountAccessAudit_version_check" CHECK ("versionBefore" > 0 AND "versionAfter" = "versionBefore" + 1),
  CONSTRAINT "AccountAccessAudit_fingerprint_check" CHECK (
    btrim("requestFingerprint") ~ '^[0-9a-f]{64}$'
    AND btrim("impactFingerprint") ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "AccountAccessAudit_text_check" CHECK (
    btrim("reason") <> ''
    AND "reason" !~ '[[:cntrl:]]'
    AND "reason" !~ '[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+'
    AND "reason" !~ '[A-Za-z0-9_-]{40,128}'
    AND "reason" !~ '^[0-9a-fA-F]{64}$'
    AND btrim("requestKey") <> ''
    AND "requestKey" !~ '[[:cntrl:]]'
    AND "requestKey" !~ '[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+'
    AND "requestKey" !~ '[A-Za-z0-9_-]{40,128}'
    AND "requestKey" !~ '^[0-9a-fA-F]{64}$'
  )
);

CREATE UNIQUE INDEX "AccountAccessAudit_actorId_requestKey_key"
  ON "AccountAccessAudit"("actorId", "requestKey");
CREATE INDEX "AccountAccessAudit_userId_createdAt_idx"
  ON "AccountAccessAudit"("userId", "createdAt");
CREATE INDEX "AccountAccessAudit_actorId_createdAt_idx"
  ON "AccountAccessAudit"("actorId", "createdAt");
CREATE INDEX "AccountAccessAudit_previewId_createdAt_idx"
  ON "AccountAccessAudit"("previewId", "createdAt");

ALTER TABLE "AccountAccessMutationPreview"
  ADD CONSTRAINT "AccountAccessMutationPreview_actorId_fkey"
    FOREIGN KEY ("actorId") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "AccountAccessMutationPreview_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "AccountAccessAudit"
  ADD CONSTRAINT "AccountAccessAudit_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "AccountAccessAudit_actorId_fkey"
    FOREIGN KEY ("actorId") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "AccountAccessAudit_previewId_fkey"
    FOREIGN KEY ("previewId") REFERENCES "AccountAccessMutationPreview"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION "account_access_preview_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  preview_context TEXT := current_setting('app.account_access_preview_context', true);
  lifecycle_context TEXT := current_setting('app.account_access_lifecycle_context', true);
  context_id TEXT := COALESCE(
    NULLIF(current_setting('app.account_access_preview_id', true), ''),
    NULLIF(current_setting('app.account_access_lifecycle_preview_id', true), '')
  );
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF preview_context IS DISTINCT FROM '1'
       OR NEW."id"::text IS DISTINCT FROM context_id
       OR NEW."actorId"::text IS DISTINCT FROM current_setting('app.account_access_preview_actor_id', true)
       OR NEW."userId"::text IS DISTINCT FROM current_setting('app.account_access_preview_user_id', true)
       OR NEW."expectedVersion"::text IS DISTINCT FROM current_setting('app.account_access_preview_version', true)
       OR NEW."action"::text IS DISTINCT FROM current_setting('app.account_access_preview_action', true)
       OR NEW."impactFingerprint"::text IS DISTINCT FROM current_setting('app.account_access_preview_impact_fingerprint', true)
       OR NEW."requestFingerprint"::text IS DISTINCT FROM current_setting('app.account_access_preview_request_fingerprint', true)
    THEN
      RAISE EXCEPTION 'account access preview requires server context'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'account access preview is append-only'
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD."id" IS DISTINCT FROM NEW."id"
     OR OLD."actorId" IS DISTINCT FROM NEW."actorId"
     OR OLD."userId" IS DISTINCT FROM NEW."userId"
     OR OLD."action" IS DISTINCT FROM NEW."action"
     OR OLD."expectedVersion" IS DISTINCT FROM NEW."expectedVersion"
     OR OLD."impactFingerprint" IS DISTINCT FROM NEW."impactFingerprint"
     OR OLD."requestFingerprint" IS DISTINCT FROM NEW."requestFingerprint"
     OR OLD."issuedAt" IS DISTINCT FROM NEW."issuedAt"
     OR OLD."expiresAt" IS DISTINCT FROM NEW."expiresAt"
     OR OLD."createdAt" IS DISTINCT FROM NEW."createdAt"
     OR OLD."consumedAt" IS NOT NULL
     OR NEW."consumedAt" IS NULL
     OR (OLD."consumedAt" IS NOT NULL AND NEW."consumedAt" <= OLD."consumedAt")
     OR (preview_context IS DISTINCT FROM '1' AND lifecycle_context IS DISTINCT FROM '1')
     OR NEW."id"::text IS DISTINCT FROM context_id
  THEN
    RAISE EXCEPTION 'account access preview can only be consumed once'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "AccountAccessMutationPreview_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "AccountAccessMutationPreview"
FOR EACH ROW EXECUTE FUNCTION "account_access_preview_guard"();

CREATE OR REPLACE FUNCTION "account_access_audit_insert_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  context_value TEXT := current_setting('app.account_access_lifecycle_context', true);
BEGIN
  IF TG_OP <> 'INSERT'
     OR NEW."contractVersion" <> 1
     OR context_value IS DISTINCT FROM '1'
     OR NEW."actorId"::text IS DISTINCT FROM current_setting('app.account_access_lifecycle_actor_id', true)
     OR NEW."userId"::text IS DISTINCT FROM current_setting('app.account_access_lifecycle_user_id', true)
     OR NEW."event"::text IS DISTINCT FROM current_setting('app.account_access_lifecycle_event', true)
     OR NEW."versionAfter"::text IS DISTINCT FROM current_setting('app.account_access_lifecycle_version_after', true)
     OR NEW."previewId"::text IS DISTINCT FROM current_setting('app.account_access_lifecycle_preview_id', true)
     OR NEW."requestKey" IS DISTINCT FROM current_setting('app.account_access_lifecycle_request_key', true)
     OR NEW."requestFingerprint"::text IS DISTINCT FROM current_setting('app.account_access_lifecycle_request_fingerprint', true)
     OR NEW."impactFingerprint"::text IS DISTINCT FROM current_setting('app.account_access_lifecycle_impact_fingerprint', true)
     OR NEW."transactionId" <> txid_current()
  THEN
    RAISE EXCEPTION 'account access audit requires lifecycle context'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "AccountAccessAudit_insert_guard"
BEFORE INSERT ON "AccountAccessAudit"
FOR EACH ROW EXECUTE FUNCTION "account_access_audit_insert_guard"();

CREATE OR REPLACE FUNCTION "account_access_audit_immutable_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'account access audit is append-only'
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER "AccountAccessAudit_immutable_guard"
BEFORE UPDATE OR DELETE ON "AccountAccessAudit"
FOR EACH ROW EXECUTE FUNCTION "account_access_audit_immutable_guard"();

CREATE OR REPLACE FUNCTION "app_user_account_access_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  context_value TEXT := current_setting('app.account_access_lifecycle_context', true);
  event_value TEXT := current_setting('app.account_access_lifecycle_action', true);
  admin_count BIGINT;
BEGIN
  IF OLD."accountAccessVersion" IS NOT DISTINCT FROM NEW."accountAccessVersion"
     AND OLD."disabledAt" IS NOT DISTINCT FROM NEW."disabledAt"
     AND OLD."disabledReason" IS NOT DISTINCT FROM NEW."disabledReason"
     AND OLD."disabledById" IS NOT DISTINCT FROM NEW."disabledById"
  THEN
    RETURN NEW;
  END IF;

  IF context_value IS DISTINCT FROM '1'
     OR NEW."id"::text IS DISTINCT FROM current_setting('app.account_access_lifecycle_user_id', true)
     OR current_setting('app.account_access_lifecycle_actor_id', true) = NEW."id"::text
     OR NEW."accountAccessVersion" <> OLD."accountAccessVersion" + 1
  THEN
    RAISE EXCEPTION 'account access lifecycle context is required'
      USING ERRCODE = 'check_violation';
  END IF;

  IF event_value = 'disable' THEN
    IF OLD."disabledAt" IS NOT NULL
       OR NEW."disabledAt" IS NULL
       OR NEW."disabledReason" IS NULL
       OR btrim(NEW."disabledReason") = ''
       OR NEW."disabledById"::text IS DISTINCT FROM current_setting('app.account_access_lifecycle_actor_id', true)
    THEN
      RAISE EXCEPTION 'account access disable transition is invalid'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."role" = 'admin' THEN
      PERFORM pg_advisory_xact_lock(29082031);
      SELECT COUNT(*) INTO admin_count
        FROM "AppUser"
       WHERE "role" = 'admin' AND "disabledAt" IS NULL;
      IF admin_count <= 1 THEN
        RAISE EXCEPTION 'at least one enabled system admin is required'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  ELSIF event_value = 'restore' THEN
    IF OLD."disabledAt" IS NULL
       OR NEW."disabledAt" IS NOT NULL
       OR NEW."disabledReason" IS NOT NULL
       OR NEW."disabledById" IS NOT NULL
    THEN
      RAISE EXCEPTION 'account access restore transition is invalid'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    RAISE EXCEPTION 'account access lifecycle event is invalid'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "AppUser_account_access_guard"
BEFORE UPDATE ON "AppUser"
FOR EACH ROW EXECUTE FUNCTION "app_user_account_access_guard"();

CREATE OR REPLACE FUNCTION "app_user_account_access_audit_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."accountAccessVersion" IS NOT DISTINCT FROM NEW."accountAccessVersion"
     AND OLD."disabledAt" IS NOT DISTINCT FROM NEW."disabledAt"
     AND OLD."disabledReason" IS NOT DISTINCT FROM NEW."disabledReason"
     AND OLD."disabledById" IS NOT DISTINCT FROM NEW."disabledById"
  THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM "AccountAccessAudit" audit
     WHERE audit."userId" = NEW."id"
       AND audit."actorId"::text = current_setting('app.account_access_lifecycle_actor_id', true)
       AND audit."event"::text = current_setting('app.account_access_lifecycle_event', true)
       AND audit."versionBefore" = OLD."accountAccessVersion"
       AND audit."versionAfter" = NEW."accountAccessVersion"
       AND audit."disabledAtBefore" IS NOT DISTINCT FROM OLD."disabledAt"
       AND audit."disabledAtAfter" IS NOT DISTINCT FROM NEW."disabledAt"
       AND audit."disabledReasonBefore" IS NOT DISTINCT FROM OLD."disabledReason"
       AND audit."disabledReasonAfter" IS NOT DISTINCT FROM NEW."disabledReason"
       AND audit."disabledByIdBefore" IS NOT DISTINCT FROM OLD."disabledById"
       AND audit."disabledByIdAfter" IS NOT DISTINCT FROM NEW."disabledById"
       AND audit."previewId"::text = current_setting('app.account_access_lifecycle_preview_id', true)
       AND audit."transactionId" = txid_current()
  ) THEN
    RAISE EXCEPTION 'account access lifecycle transition requires matching audit'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "AppUser_account_access_audit_guard"
AFTER UPDATE ON "AppUser"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "app_user_account_access_audit_guard"();

CREATE OR REPLACE FUNCTION "account_access_audit_transition_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  preview_row RECORD;
  user_row RECORD;
BEGIN
  SELECT * INTO preview_row
    FROM "AccountAccessMutationPreview"
   WHERE "id" = NEW."previewId"
     AND "actorId" = NEW."actorId"
     AND "userId" = NEW."userId"
     AND (("action"::text = 'disable' AND NEW."event"::text = 'disabled')
       OR ("action"::text = 'restore' AND NEW."event"::text = 'restored'))
     AND "expectedVersion" = NEW."versionBefore"
     AND "consumedAt" IS NOT NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'account access audit preview binding is invalid'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT "id", "accountAccessVersion", "disabledAt", "disabledReason", "disabledById"
    INTO user_row
    FROM "AppUser"
   WHERE "id" = NEW."userId";
  IF NOT FOUND
     OR user_row."accountAccessVersion" <> NEW."versionAfter"
     OR user_row."disabledAt" IS DISTINCT FROM NEW."disabledAtAfter"
     OR user_row."disabledReason" IS DISTINCT FROM NEW."disabledReasonAfter"
     OR user_row."disabledById" IS DISTINCT FROM NEW."disabledByIdAfter"
  THEN
    RAISE EXCEPTION 'account access audit does not match current transition'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "AccountAccessAudit_transition_guard"
AFTER INSERT ON "AccountAccessAudit"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "account_access_audit_transition_guard"();

CREATE OR REPLACE FUNCTION "app_session_account_access_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  user_version INTEGER;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF current_setting('app.account_session_context', true) IS DISTINCT FROM '1'
       OR NEW."userId"::text IS DISTINCT FROM current_setting('app.account_session_user_id', true)
       OR NEW."accountAccessVersion"::text IS DISTINCT FROM current_setting('app.account_session_version', true)
    THEN
      RAISE EXCEPTION 'app session requires current account access context'
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT "accountAccessVersion" INTO user_version
      FROM "AppUser"
     WHERE "id" = NEW."userId" AND "disabledAt" IS NULL;
    IF NOT FOUND OR user_version <> NEW."accountAccessVersion" THEN
      RAISE EXCEPTION 'app session account access version is stale'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."userId" IS DISTINCT FROM OLD."userId"
     OR NEW."accountAccessVersion" IS DISTINCT FROM OLD."accountAccessVersion"
     OR NEW."tokenHash" IS DISTINCT FROM OLD."tokenHash"
     OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION 'app session immutable fields cannot change'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."revokedAt" IS DISTINCT FROM OLD."revokedAt" THEN
    IF OLD."revokedAt" IS NOT NULL
       OR NEW."revokedAt" IS NULL
       OR NEW."revokedAt" <= COALESCE(OLD."revokedAt", '-infinity'::timestamp)
    THEN
      RAISE EXCEPTION 'app session can only be revoked once'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."lastSeenAt" IS DISTINCT FROM OLD."lastSeenAt" AND OLD."revokedAt" IS NOT NULL
  THEN
    RAISE EXCEPTION 'revoked app session cannot be observed'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "AppSession_account_access_guard"
BEFORE INSERT OR UPDATE ON "AppSession"
FOR EACH ROW EXECUTE FUNCTION "app_session_account_access_guard"();

CREATE OR REPLACE FUNCTION "app_session_delete_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'app session deletion is forbidden'
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER "AppSession_delete_guard"
BEFORE DELETE ON "AppSession"
FOR EACH ROW EXECUTE FUNCTION "app_session_delete_guard"();
