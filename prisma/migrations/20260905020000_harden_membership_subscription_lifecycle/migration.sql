-- Membership subscription lifecycle v2.
--
-- Existing audit rows are retained as contractVersion 1 history.  They are
-- never backfilled or rewritten. New API mutations set a transaction-local
-- lifecycle context, update the subscription, and append one v2 ledger row;
-- the deferred trigger checks the two writes as one atomic transition. New
-- subscription rows are also lifecycle-context-only; rows that predate this
-- migration remain untouched.

CREATE TABLE "MembershipMutationPreview" (
  "id" UUID NOT NULL,
  "actorId" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "action" "MembershipAuditEventKind" NOT NULL,
  "expectedVersion" INTEGER NOT NULL,
  "impactFingerprint" CHAR(64) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "issuedAt" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MembershipMutationPreview_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MembershipMutationPreview_version_check" CHECK ("expectedVersion" >= 0),
  CONSTRAINT "MembershipMutationPreview_fingerprint_check" CHECK (
    "impactFingerprint" ~ '^[0-9a-f]{64}$' AND "requestFingerprint" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "MembershipMutationPreview_window_check" CHECK ("expiresAt" > "issuedAt")
);

CREATE INDEX "MembershipMutationPreview_actorId_userId_createdAt_idx"
  ON "MembershipMutationPreview"("actorId", "userId", "createdAt");
CREATE INDEX "MembershipMutationPreview_expiresAt_consumedAt_idx"
  ON "MembershipMutationPreview"("expiresAt", "consumedAt");
ALTER TABLE "MembershipMutationPreview"
  ADD CONSTRAINT "MembershipMutationPreview_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "MembershipMutationPreview_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "MembershipSubscriptionAudit"
  ADD COLUMN "versionBefore" INTEGER,
  ADD COLUMN "versionAfter" INTEGER,
  ADD COLUMN "statusBefore" "MembershipSubscriptionStatus",
  ADD COLUMN "statusAfter" "MembershipSubscriptionStatus",
  ADD COLUMN "startsAtBefore" TIMESTAMP(3),
  ADD COLUMN "startsAtAfter" TIMESTAMP(3),
  ADD COLUMN "expiresAtBefore" TIMESTAMP(3),
  ADD COLUMN "expiresAtAfter" TIMESTAMP(3),
  ADD COLUMN "revokedAtBefore" TIMESTAMP(3),
  ADD COLUMN "revokedAtAfter" TIMESTAMP(3),
  ADD COLUMN "revocationReasonBefore" VARCHAR(500),
  ADD COLUMN "revocationReasonAfter" VARCHAR(500),
  ADD COLUMN "noteBefore" VARCHAR(500),
  ADD COLUMN "noteAfter" VARCHAR(500),
  ADD COLUMN "grantedByIdBefore" UUID,
  ADD COLUMN "grantedByIdAfter" UUID,
  ADD COLUMN "revokedByIdBefore" UUID,
  ADD COLUMN "revokedByIdAfter" UUID,
  ADD COLUMN "previewId" UUID,
  ADD COLUMN "reason" VARCHAR(500),
  ADD COLUMN "requestKey" VARCHAR(180),
  ADD COLUMN "requestFingerprint" CHAR(64),
  ADD COLUMN "impactFingerprint" CHAR(64),
  ADD COLUMN "transactionId" BIGINT NOT NULL DEFAULT txid_current(),
  ADD COLUMN "transitionAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "contractVersion" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "MembershipSubscriptionAudit"
  ADD CONSTRAINT "MembershipSubscriptionAudit_v2_shape_check"
  CHECK (
    "contractVersion" = 1
    OR (
      "contractVersion" = 2
      AND "versionAfter" > 0
      AND "statusAfter" IS NOT NULL
      AND "startsAtAfter" IS NOT NULL
      AND "expiresAtAfter" IS NOT NULL
      AND "reason" IS NOT NULL
      AND btrim("reason") <> ''
      AND "requestKey" IS NOT NULL
      AND btrim("requestKey") <> ''
      AND "requestFingerprint" IS NOT NULL
      AND btrim("requestFingerprint") ~ '^[0-9a-f]{64}$'
      AND "impactFingerprint" IS NOT NULL
      AND btrim("impactFingerprint") ~ '^[0-9a-f]{64}$'
      AND "previewId" IS NOT NULL
    )
  ),
  ADD CONSTRAINT "MembershipSubscriptionAudit_text_check"
  CHECK (
    ("reason" IS NULL OR (btrim("reason") <> '' AND "reason" !~ '[[:cntrl:]]' AND "reason" !~ '[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\\.[A-Za-z0-9-]+)+' AND "reason" !~ '[A-Za-z0-9_-]{40,128}' AND "reason" !~ '^[0-9a-fA-F]{64}$'))
    AND ("requestKey" IS NULL OR (btrim("requestKey") <> '' AND "requestKey" !~ '[[:cntrl:]]' AND "requestKey" !~ '[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\\.[A-Za-z0-9-]+)+' AND "requestKey" !~ '[A-Za-z0-9_-]{40,128}' AND "requestKey" !~ '^[0-9a-fA-F]{64}$'))
    AND ("requestFingerprint" IS NULL OR btrim("requestFingerprint") ~ '^[0-9a-f]{64}$')
    AND ("impactFingerprint" IS NULL OR btrim("impactFingerprint") ~ '^[0-9a-f]{64}$')
  );

CREATE UNIQUE INDEX "MembershipSubscriptionAudit_actorId_requestKey_key"
  ON "MembershipSubscriptionAudit"("actorId", "requestKey");
CREATE INDEX "MembershipSubscriptionAudit_requestKey_idx"
  ON "MembershipSubscriptionAudit"("requestKey");
CREATE INDEX "MembershipSubscriptionAudit_transactionId_idx"
  ON "MembershipSubscriptionAudit"("transactionId");
CREATE INDEX "MembershipSubscriptionAudit_previewId_idx"
  ON "MembershipSubscriptionAudit"("previewId");
ALTER TABLE "MembershipSubscriptionAudit"
  ADD CONSTRAINT "MembershipSubscriptionAudit_previewId_fkey"
  FOREIGN KEY ("previewId") REFERENCES "MembershipMutationPreview"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION "membership_mutation_preview_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  preview_context TEXT := current_setting('app.membership_preview_context', true);
  lifecycle_context TEXT := current_setting('app.membership_lifecycle_context', true);
  context_id TEXT := COALESCE(
    NULLIF(current_setting('app.membership_preview_id', true), ''),
    NULLIF(current_setting('app.membership_lifecycle_preview_id', true), '')
  );
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF preview_context IS DISTINCT FROM '1'
       OR NEW."id"::text IS DISTINCT FROM current_setting('app.membership_preview_id', true)
       OR NEW."actorId"::text IS DISTINCT FROM current_setting('app.membership_preview_actor_id', true)
       OR NEW."userId"::text IS DISTINCT FROM current_setting('app.membership_preview_user_id', true)
    THEN
      RAISE EXCEPTION 'membership mutation preview requires server context'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'membership mutation preview is append-only'
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
    RAISE EXCEPTION 'membership mutation preview can only be consumed once'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "MembershipMutationPreview_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "MembershipMutationPreview"
FOR EACH ROW EXECUTE FUNCTION "membership_mutation_preview_guard"();

CREATE OR REPLACE FUNCTION "membership_subscription_audit_insert_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  context_value TEXT := current_setting('app.membership_lifecycle_context', true);
BEGIN
  IF NEW."contractVersion" <> 2
     OR context_value IS DISTINCT FROM '1'
     OR NEW."actorId"::text IS DISTINCT FROM current_setting('app.membership_lifecycle_actor_id', true)
     OR NEW."userId"::text IS DISTINCT FROM current_setting('app.membership_lifecycle_user_id', true)
     OR NEW."subscriptionId"::text IS DISTINCT FROM current_setting('app.membership_lifecycle_subscription_id', true)
     OR NEW."versionAfter"::text IS DISTINCT FROM current_setting('app.membership_lifecycle_subscription_version', true)
     OR NEW."eventKind"::text IS DISTINCT FROM current_setting('app.membership_lifecycle_action', true)
     OR NEW."previewId"::text IS DISTINCT FROM current_setting('app.membership_lifecycle_preview_id', true)
     OR NEW."requestKey" IS DISTINCT FROM current_setting('app.membership_lifecycle_request_key', true)
     OR NEW."requestFingerprint" IS DISTINCT FROM current_setting('app.membership_lifecycle_request_fingerprint', true)
     OR NEW."impactFingerprint" IS DISTINCT FROM current_setting('app.membership_lifecycle_impact_fingerprint', true)
     OR NEW."transactionId" <> txid_current()
  THEN
    RAISE EXCEPTION 'membership subscription v2 audit requires lifecycle context'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "MembershipSubscriptionAudit_insert_guard"
BEFORE INSERT ON "MembershipSubscriptionAudit"
FOR EACH ROW EXECUTE FUNCTION "membership_subscription_audit_insert_guard"();

CREATE OR REPLACE FUNCTION "membership_subscription_audit_immutable_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'membership subscription audit is append-only'
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER "MembershipSubscriptionAudit_immutable_guard"
BEFORE UPDATE OR DELETE ON "MembershipSubscriptionAudit"
FOR EACH ROW EXECUTE FUNCTION "membership_subscription_audit_immutable_guard"();

CREATE OR REPLACE FUNCTION "membership_subscription_lifecycle_context_marker"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  context_value TEXT := current_setting('app.membership_lifecycle_context', true);
BEGIN
  IF context_value = '1' AND TG_OP = 'INSERT' THEN
    PERFORM set_config('app.membership_lifecycle_subscription_id', NEW."id"::text, true);
    PERFORM set_config('app.membership_lifecycle_subscription_version', NEW."version"::text, true);
  ELSIF context_value = '1'
     AND (OLD."id" IS DISTINCT FROM NEW."id"
       OR OLD."userId" IS DISTINCT FROM NEW."userId"
       OR OLD."status" IS DISTINCT FROM NEW."status"
       OR OLD."startsAt" IS DISTINCT FROM NEW."startsAt"
       OR OLD."expiresAt" IS DISTINCT FROM NEW."expiresAt"
       OR OLD."grantedById" IS DISTINCT FROM NEW."grantedById"
       OR OLD."revokedById" IS DISTINCT FROM NEW."revokedById"
       OR OLD."revokedAt" IS DISTINCT FROM NEW."revokedAt"
       OR OLD."revocationReason" IS DISTINCT FROM NEW."revocationReason"
       OR OLD."note" IS DISTINCT FROM NEW."note"
       OR OLD."version" IS DISTINCT FROM NEW."version")
  THEN
    PERFORM set_config('app.membership_lifecycle_subscription_id', NEW."id"::text, true);
    PERFORM set_config('app.membership_lifecycle_subscription_version', NEW."version"::text, true);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "MembershipSubscription_lifecycle_context_marker"
BEFORE INSERT OR UPDATE ON "MembershipSubscription"
FOR EACH ROW EXECUTE FUNCTION "membership_subscription_lifecycle_context_marker"();

CREATE OR REPLACE FUNCTION "membership_subscription_lifecycle_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  context_value TEXT := current_setting('app.membership_lifecycle_context', true);
  action_value TEXT := current_setting('app.membership_lifecycle_action', true);
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF context_value IS DISTINCT FROM '1'
       OR NEW."userId"::text IS DISTINCT FROM current_setting('app.membership_lifecycle_user_id', true)
       OR action_value IS DISTINCT FROM 'grant'
       OR NEW."version" <> 1
       OR NEW."status" <> 'active'
       OR NEW."revokedAt" IS NOT NULL
       OR NEW."revokedById" IS NOT NULL
       OR NEW."revocationReason" IS NOT NULL
    THEN
      RAISE EXCEPTION 'membership subscription grant transition is invalid'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'membership subscription delete is forbidden'
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD."userId" IS DISTINCT FROM NEW."userId" THEN
    RAISE EXCEPTION 'membership subscription user ownership is immutable'
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD."status" IS NOT DISTINCT FROM NEW."status"
     AND OLD."startsAt" IS NOT DISTINCT FROM NEW."startsAt"
     AND OLD."expiresAt" IS NOT DISTINCT FROM NEW."expiresAt"
     AND OLD."grantedById" IS NOT DISTINCT FROM NEW."grantedById"
     AND OLD."revokedById" IS NOT DISTINCT FROM NEW."revokedById"
     AND OLD."revokedAt" IS NOT DISTINCT FROM NEW."revokedAt"
     AND OLD."revocationReason" IS NOT DISTINCT FROM NEW."revocationReason"
     AND OLD."note" IS NOT DISTINCT FROM NEW."note"
     AND OLD."version" IS NOT DISTINCT FROM NEW."version"
     AND OLD."userId" IS NOT DISTINCT FROM NEW."userId"
  THEN RETURN NEW;
  END IF;

  IF context_value IS DISTINCT FROM '1'
     OR NEW."userId"::text IS DISTINCT FROM current_setting('app.membership_lifecycle_user_id', true)
  THEN
    RAISE EXCEPTION 'membership subscription lifecycle context is required'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'membership subscription version must increment exactly once'
      USING ERRCODE = 'check_violation';
  END IF;

  IF action_value = 'extend' THEN
    IF OLD."status" <> 'active'
       OR OLD."startsAt" > clock_timestamp()
       OR OLD."expiresAt" <= clock_timestamp()
       OR NEW."status" <> 'active'
       OR NEW."startsAt" IS DISTINCT FROM OLD."startsAt"
       OR NEW."expiresAt" <= OLD."expiresAt"
       OR NEW."revokedAt" IS NOT NULL
       OR NEW."revokedById" IS NOT NULL
       OR NEW."revocationReason" IS NOT NULL
    THEN
      RAISE EXCEPTION 'membership subscription extend transition is invalid'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF action_value = 'grant' THEN
    IF (OLD."status" = 'active' AND OLD."startsAt" <= clock_timestamp() AND OLD."expiresAt" > clock_timestamp())
       OR NEW."status" <> 'active'
       OR NEW."startsAt" > clock_timestamp()
       OR NEW."expiresAt" <= NEW."startsAt"
       OR NEW."revokedAt" IS NOT NULL
       OR NEW."revokedById" IS NOT NULL
       OR NEW."revocationReason" IS NOT NULL
    THEN
      RAISE EXCEPTION 'membership subscription grant transition is invalid'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF action_value = 'revoke' THEN
    IF OLD."status" <> 'active'
       OR OLD."startsAt" > clock_timestamp()
       OR OLD."expiresAt" <= clock_timestamp()
       OR NEW."status" <> 'revoked'
       OR NEW."revokedAt" IS NULL
       OR NEW."revokedById" IS NULL
       OR NEW."revocationReason" IS NULL
    THEN
      RAISE EXCEPTION 'membership subscription revoke transition is invalid'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    RAISE EXCEPTION 'membership subscription lifecycle action is invalid'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "MembershipSubscription_lifecycle_guard"
AFTER INSERT OR UPDATE ON "MembershipSubscription"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "membership_subscription_lifecycle_guard"();

CREATE OR REPLACE FUNCTION "membership_subscription_delete_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'membership subscription delete is forbidden'
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER "MembershipSubscription_delete_guard"
BEFORE DELETE ON "MembershipSubscription"
FOR EACH ROW EXECUTE FUNCTION "membership_subscription_delete_guard"();

CREATE OR REPLACE FUNCTION "membership_subscription_lifecycle_audit_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  context_value TEXT := current_setting('app.membership_lifecycle_context', true);
  action_value TEXT := current_setting('app.membership_lifecycle_action', true);
BEGIN
  IF context_value IS DISTINCT FROM '1' THEN
    -- Historical direct inserts are deliberately not backfilled. Any update
    -- of an existing row has already been rejected by the lifecycle guard.
    IF TG_OP = 'INSERT' THEN RETURN NEW; END IF;
    RETURN NEW;
  END IF;

  IF current_setting('app.membership_lifecycle_subscription_id', true) IS DISTINCT FROM NEW."id"::text
     OR current_setting('app.membership_lifecycle_subscription_version', true) IS DISTINCT FROM NEW."version"::text
  THEN
    RAISE EXCEPTION 'membership subscription lifecycle marker is required'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "MembershipSubscriptionAudit" audit
    WHERE audit."subscriptionId" = NEW."id"
      AND audit."userId" = NEW."userId"
      AND audit."actorId"::text = current_setting('app.membership_lifecycle_actor_id', true)
      AND audit."eventKind"::text = action_value
      AND audit."previewId"::text = current_setting('app.membership_lifecycle_preview_id', true)
      AND audit."requestKey" = current_setting('app.membership_lifecycle_request_key', true)
      AND audit."requestFingerprint" = current_setting('app.membership_lifecycle_request_fingerprint', true)
      AND audit."impactFingerprint" = current_setting('app.membership_lifecycle_impact_fingerprint', true)
      AND audit."transactionId" = txid_current()
      AND audit."versionAfter" = NEW."version"
      AND audit."statusAfter" = NEW."status"
      AND audit."startsAtAfter" IS NOT DISTINCT FROM NEW."startsAt"
      AND audit."expiresAtAfter" IS NOT DISTINCT FROM NEW."expiresAt"
      AND audit."revokedAtAfter" IS NOT DISTINCT FROM NEW."revokedAt"
      AND audit."revocationReasonAfter" IS NOT DISTINCT FROM NEW."revocationReason"
      AND audit."noteAfter" IS NOT DISTINCT FROM NEW."note"
      AND audit."grantedByIdAfter" IS NOT DISTINCT FROM NEW."grantedById"
      AND audit."revokedByIdAfter" IS NOT DISTINCT FROM NEW."revokedById"
  ) THEN
    RAISE EXCEPTION 'membership subscription lifecycle transition requires matching audit'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "MembershipSubscription_lifecycle_audit_guard"
AFTER INSERT OR UPDATE ON "MembershipSubscription"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "membership_subscription_lifecycle_audit_guard"();

CREATE OR REPLACE FUNCTION "membership_subscription_audit_transition_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  context_value TEXT := current_setting('app.membership_lifecycle_context', true);
BEGIN
  IF NEW."contractVersion" <> 2
     OR context_value IS DISTINCT FROM '1'
     OR current_setting('app.membership_lifecycle_subscription_id', true) IS DISTINCT FROM NEW."subscriptionId"::text
     OR current_setting('app.membership_lifecycle_subscription_version', true) IS DISTINCT FROM NEW."versionAfter"::text
     OR current_setting('app.membership_lifecycle_preview_id', true) IS DISTINCT FROM NEW."previewId"::text
  THEN
    RAISE EXCEPTION 'membership subscription v2 audit requires a real lifecycle transition'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."versionBefore" IS DISTINCT FROM (CASE WHEN NEW."versionAfter" = 1 THEN NULL ELSE NEW."versionAfter" - 1 END)
     OR NOT EXISTS (
       SELECT 1
       FROM "MembershipMutationPreview" preview
       WHERE preview."id" = NEW."previewId"
         AND preview."actorId" = NEW."actorId"
         AND preview."userId" = NEW."userId"
         AND preview."action"::text = NEW."eventKind"::text
         AND preview."expectedVersion" = COALESCE(NEW."versionBefore", 0)
         AND preview."requestFingerprint" = NEW."requestFingerprint"
         AND preview."impactFingerprint" = NEW."impactFingerprint"
         AND preview."consumedAt" IS NOT NULL
     )
     OR NOT EXISTS (
       SELECT 1
       FROM "MembershipSubscription" subscription
       WHERE subscription."id" = NEW."subscriptionId"
         AND subscription."userId" = NEW."userId"
         AND subscription."version" = NEW."versionAfter"
         AND subscription."status" = NEW."statusAfter"
         AND subscription."startsAt" IS NOT DISTINCT FROM NEW."startsAtAfter"
         AND subscription."expiresAt" IS NOT DISTINCT FROM NEW."expiresAtAfter"
         AND subscription."revokedAt" IS NOT DISTINCT FROM NEW."revokedAtAfter"
         AND subscription."revocationReason" IS NOT DISTINCT FROM NEW."revocationReasonAfter"
         AND subscription."note" IS NOT DISTINCT FROM NEW."noteAfter"
         AND subscription."grantedById" IS NOT DISTINCT FROM NEW."grantedByIdAfter"
         AND subscription."revokedById" IS NOT DISTINCT FROM NEW."revokedByIdAfter"
     )
  THEN
    RAISE EXCEPTION 'membership subscription v2 audit does not match current transition'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "MembershipSubscriptionAudit_lifecycle_transition_guard"
AFTER INSERT ON "MembershipSubscriptionAudit"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "membership_subscription_audit_transition_guard"();
