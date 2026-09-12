-- Trackable membership applications.
--
-- An application is a request for an administrator decision, not a
-- subscription.  All state changes are short-lived preview -> execute
-- transitions.  The trigger guards are application consistency guards; ACLs
-- and the service remain the authority boundary for who may set the context.

CREATE TYPE "MembershipApplicationStatus" AS ENUM ('pending', 'fulfilled', 'rejected', 'withdrawn');
CREATE TYPE "MembershipApplicationAction" AS ENUM ('submit', 'withdraw', 'reject');
CREATE TYPE "MembershipApplicationAuditEvent" AS ENUM ('submitted', 'fulfilled', 'rejected', 'withdrawn');

ALTER TABLE "MembershipMutationPreview"
  ADD COLUMN "applicationId" UUID;

ALTER TABLE "MembershipSubscriptionAudit"
  ADD COLUMN "applicationId" UUID;

CREATE TABLE "MembershipApplication" (
  "id" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "status" "MembershipApplicationStatus" NOT NULL DEFAULT 'pending',
  "statusVersion" INTEGER NOT NULL DEFAULT 1,
  "requestKey" VARCHAR(180) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "impactFingerprint" CHAR(64) NOT NULL,
  "requestReason" VARCHAR(500) NOT NULL,
  "rejectionReason" VARCHAR(500),
  "accountAccessVersion" INTEGER NOT NULL,
  "membershipVersion" INTEGER NOT NULL,
  "membershipState" VARCHAR(16) NOT NULL,
  "submittedAt" TIMESTAMP(3) NOT NULL,
  "fulfilledAt" TIMESTAMP(3),
  "rejectedAt" TIMESTAMP(3),
  "withdrawnAt" TIMESTAMP(3),
  "fulfilledSubscriptionId" UUID,
  "fulfilledSubscriptionVersion" INTEGER,
  "fulfilledSubscriptionAuditId" UUID,
  "fulfilledMembershipPreviewId" UUID,
  "submitPreviewId" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MembershipApplication_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MembershipApplication_status_version_check" CHECK ("statusVersion" > 0),
  CONSTRAINT "MembershipApplication_version_snapshot_check" CHECK ("accountAccessVersion" > 0 AND "membershipVersion" >= 0),
  CONSTRAINT "MembershipApplication_fingerprint_check" CHECK ("requestFingerprint" ~ '^[0-9a-f]{64}$' AND "impactFingerprint" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "MembershipApplication_state_check" CHECK (btrim("membershipState") IN ('none', 'active', 'expired', 'revoked')),
  CONSTRAINT "MembershipApplication_request_reason_check" CHECK (btrim("requestReason") <> ''),
  CONSTRAINT "MembershipApplication_text_check" CHECK (
    ("requestReason" IS NULL OR (btrim("requestReason") <> '' AND "requestReason" !~ '[[:cntrl:]]' AND "requestReason" !~ '[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\\.[A-Za-z0-9-]+)+' AND "requestReason" !~ '[A-Za-z0-9_-]{40,128}' AND "requestReason" !~ '^[0-9a-fA-F]{64}$'))
    AND ("rejectionReason" IS NULL OR (btrim("rejectionReason") <> '' AND "rejectionReason" !~ '[[:cntrl:]]' AND "rejectionReason" !~ '[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\\.[A-Za-z0-9-]+)+' AND "rejectionReason" !~ '[A-Za-z0-9_-]{40,128}' AND "rejectionReason" !~ '^[0-9a-fA-F]{64}$'))
  ),
  CONSTRAINT "MembershipApplication_terminal_shape_check" CHECK (
    ("status" = 'pending' AND "fulfilledAt" IS NULL AND "rejectedAt" IS NULL AND "withdrawnAt" IS NULL AND "rejectionReason" IS NULL AND "fulfilledSubscriptionId" IS NULL AND "fulfilledSubscriptionVersion" IS NULL AND "fulfilledSubscriptionAuditId" IS NULL AND "fulfilledMembershipPreviewId" IS NULL)
    OR ("status" = 'fulfilled' AND "fulfilledAt" IS NOT NULL AND "rejectedAt" IS NULL AND "withdrawnAt" IS NULL AND "rejectionReason" IS NULL AND "fulfilledSubscriptionId" IS NOT NULL AND "fulfilledSubscriptionVersion" IS NOT NULL AND "fulfilledSubscriptionAuditId" IS NOT NULL AND "fulfilledMembershipPreviewId" IS NOT NULL)
    OR ("status" = 'rejected' AND "fulfilledAt" IS NULL AND "rejectedAt" IS NOT NULL AND "withdrawnAt" IS NULL AND "rejectionReason" IS NOT NULL AND "fulfilledSubscriptionId" IS NULL AND "fulfilledSubscriptionVersion" IS NULL AND "fulfilledSubscriptionAuditId" IS NULL AND "fulfilledMembershipPreviewId" IS NULL)
    OR ("status" = 'withdrawn' AND "fulfilledAt" IS NULL AND "rejectedAt" IS NULL AND "withdrawnAt" IS NOT NULL AND "rejectionReason" IS NULL AND "fulfilledSubscriptionId" IS NULL AND "fulfilledSubscriptionVersion" IS NULL AND "fulfilledSubscriptionAuditId" IS NULL AND "fulfilledMembershipPreviewId" IS NULL)
  )
);

CREATE TABLE "MembershipApplicationPreview" (
  "id" UUID NOT NULL,
  "actorId" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "applicationId" UUID,
  "action" "MembershipApplicationAction" NOT NULL,
  "expectedApplicationVersion" INTEGER NOT NULL,
  "expectedAccountAccessVersion" INTEGER NOT NULL,
  "expectedMembershipVersion" INTEGER NOT NULL,
  "expectedMembershipState" VARCHAR(16) NOT NULL,
  "requestKey" VARCHAR(180) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "impactFingerprint" CHAR(64) NOT NULL,
  "reason" VARCHAR(500),
  "issuedAt" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MembershipApplicationPreview_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MembershipApplicationPreview_version_check" CHECK ("expectedApplicationVersion" >= 0 AND "expectedAccountAccessVersion" > 0 AND "expectedMembershipVersion" >= 0),
  CONSTRAINT "MembershipApplicationPreview_fingerprint_check" CHECK ("requestFingerprint" ~ '^[0-9a-f]{64}$' AND "impactFingerprint" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "MembershipApplicationPreview_state_check" CHECK (btrim("expectedMembershipState") IN ('none', 'active', 'expired', 'revoked')),
  CONSTRAINT "MembershipApplicationPreview_window_check" CHECK ("expiresAt" > "issuedAt" AND "expiresAt" <= "issuedAt" + INTERVAL '5 minutes'),
  CONSTRAINT "MembershipApplicationPreview_text_check" CHECK (
    "reason" IS NULL OR (btrim("reason") <> '' AND "reason" !~ '[[:cntrl:]]' AND "reason" !~ '[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\\.[A-Za-z0-9-]+)+' AND "reason" !~ '[A-Za-z0-9_-]{40,128}' AND "reason" !~ '^[0-9a-fA-F]{64}$')
  )
);

CREATE TABLE "MembershipApplicationAudit" (
  "id" UUID NOT NULL,
  "applicationId" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "actorId" UUID NOT NULL,
  "event" "MembershipApplicationAuditEvent" NOT NULL,
  "statusBefore" "MembershipApplicationStatus",
  "statusAfter" "MembershipApplicationStatus" NOT NULL,
  "statusVersionBefore" INTEGER,
  "statusVersionAfter" INTEGER NOT NULL,
  "applicationPreviewId" UUID,
  "membershipPreviewId" UUID,
  "subscriptionId" UUID,
  "subscriptionVersion" INTEGER,
  "subscriptionAuditId" UUID,
  "reason" VARCHAR(500),
  "requestKey" VARCHAR(180) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "impactFingerprint" CHAR(64) NOT NULL,
  "transactionId" BIGINT NOT NULL DEFAULT txid_current(),
  "transitionAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MembershipApplicationAudit_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MembershipApplicationAudit_version_check" CHECK ("statusVersionAfter" > 0 AND ("statusVersionBefore" IS NULL OR "statusVersionBefore" >= 1)),
  CONSTRAINT "MembershipApplicationAudit_fingerprint_check" CHECK ("requestFingerprint" ~ '^[0-9a-f]{64}$' AND "impactFingerprint" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "MembershipApplicationAudit_binding_check" CHECK (
    ("event" = 'submitted' AND "statusBefore" IS NULL AND "statusAfter" = 'pending' AND "applicationPreviewId" IS NOT NULL AND "membershipPreviewId" IS NULL AND "subscriptionAuditId" IS NULL)
    OR ("event" = 'withdrawn' AND "statusBefore" = 'pending' AND "statusAfter" = 'withdrawn' AND "applicationPreviewId" IS NOT NULL AND "membershipPreviewId" IS NULL AND "subscriptionAuditId" IS NULL)
    OR ("event" = 'rejected' AND "statusBefore" = 'pending' AND "statusAfter" = 'rejected' AND "applicationPreviewId" IS NOT NULL AND "membershipPreviewId" IS NULL AND "subscriptionAuditId" IS NULL)
    OR ("event" = 'fulfilled' AND "statusBefore" = 'pending' AND "statusAfter" = 'fulfilled' AND "applicationPreviewId" IS NULL AND "membershipPreviewId" IS NOT NULL AND "subscriptionId" IS NOT NULL AND "subscriptionVersion" IS NOT NULL AND "subscriptionAuditId" IS NOT NULL)
  ),
  CONSTRAINT "MembershipApplicationAudit_text_check" CHECK (
    "reason" IS NULL OR (btrim("reason") <> '' AND "reason" !~ '[[:cntrl:]]' AND "reason" !~ '[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\\.[A-Za-z0-9-]+)+' AND "reason" !~ '[A-Za-z0-9_-]{40,128}' AND "reason" !~ '^[0-9a-fA-F]{64}$')
  )
);

CREATE UNIQUE INDEX "MembershipApplication_userId_requestKey_key"
  ON "MembershipApplication"("userId", "requestKey");
CREATE UNIQUE INDEX "MembershipApplication_one_pending_user_key"
  ON "MembershipApplication"("userId") WHERE "status" = 'pending';
CREATE INDEX "MembershipApplication_userId_createdAt_idx"
  ON "MembershipApplication"("userId", "createdAt");
CREATE INDEX "MembershipApplication_status_createdAt_idx"
  ON "MembershipApplication"("status", "createdAt");

CREATE UNIQUE INDEX "MembershipApplicationPreview_actorId_requestKey_key"
  ON "MembershipApplicationPreview"("actorId", "requestKey");
CREATE INDEX "MembershipApplicationPreview_userId_createdAt_idx"
  ON "MembershipApplicationPreview"("userId", "createdAt");
CREATE INDEX "MembershipApplicationPreview_applicationId_createdAt_idx"
  ON "MembershipApplicationPreview"("applicationId", "createdAt");
CREATE INDEX "MembershipApplicationPreview_expiresAt_consumedAt_idx"
  ON "MembershipApplicationPreview"("expiresAt", "consumedAt");

CREATE INDEX "MembershipApplicationAudit_applicationId_createdAt_idx"
  ON "MembershipApplicationAudit"("applicationId", "createdAt");
CREATE INDEX "MembershipApplicationAudit_userId_createdAt_idx"
  ON "MembershipApplicationAudit"("userId", "createdAt");
CREATE INDEX "MembershipApplicationAudit_actorId_createdAt_idx"
  ON "MembershipApplicationAudit"("actorId", "createdAt");
CREATE UNIQUE INDEX "MembershipApplicationAudit_actorId_requestKey_key"
  ON "MembershipApplicationAudit"("actorId", "requestKey");
CREATE UNIQUE INDEX "MembershipApplicationAudit_applicationId_statusVersionAfter_key"
  ON "MembershipApplicationAudit"("applicationId", "statusVersionAfter");
CREATE UNIQUE INDEX "MembershipSubscriptionAudit_applicationId_key"
  ON "MembershipSubscriptionAudit"("applicationId")
  WHERE "applicationId" IS NOT NULL;

ALTER TABLE "MembershipApplication"
  ADD CONSTRAINT "MembershipApplication_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "MembershipApplication_submitPreviewId_fkey"
    FOREIGN KEY ("submitPreviewId") REFERENCES "MembershipApplicationPreview"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "MembershipApplication_fulfilledSubscriptionId_fkey"
    FOREIGN KEY ("fulfilledSubscriptionId") REFERENCES "MembershipSubscription"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "MembershipApplication_fulfilledSubscriptionAuditId_fkey"
    FOREIGN KEY ("fulfilledSubscriptionAuditId") REFERENCES "MembershipSubscriptionAudit"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "MembershipApplication_fulfilledMembershipPreviewId_fkey"
    FOREIGN KEY ("fulfilledMembershipPreviewId") REFERENCES "MembershipMutationPreview"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "MembershipApplicationPreview"
  ADD CONSTRAINT "MembershipApplicationPreview_actorId_fkey"
    FOREIGN KEY ("actorId") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "MembershipApplicationPreview_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "MembershipApplicationPreview_applicationId_fkey"
    FOREIGN KEY ("applicationId") REFERENCES "MembershipApplication"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "MembershipApplicationAudit"
  ADD CONSTRAINT "MembershipApplicationAudit_applicationId_fkey"
    FOREIGN KEY ("applicationId") REFERENCES "MembershipApplication"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "MembershipApplicationAudit_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "MembershipApplicationAudit_actorId_fkey"
    FOREIGN KEY ("actorId") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "MembershipApplicationAudit_applicationPreviewId_fkey"
    FOREIGN KEY ("applicationPreviewId") REFERENCES "MembershipApplicationPreview"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "MembershipApplicationAudit_membershipPreviewId_fkey"
    FOREIGN KEY ("membershipPreviewId") REFERENCES "MembershipMutationPreview"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "MembershipApplicationAudit_subscriptionId_fkey"
    FOREIGN KEY ("subscriptionId") REFERENCES "MembershipSubscription"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "MembershipApplicationAudit_subscriptionAuditId_fkey"
    FOREIGN KEY ("subscriptionAuditId") REFERENCES "MembershipSubscriptionAudit"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "MembershipMutationPreview"
  ADD CONSTRAINT "MembershipMutationPreview_applicationId_fkey"
    FOREIGN KEY ("applicationId") REFERENCES "MembershipApplication"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "MembershipSubscriptionAudit"
  ADD CONSTRAINT "MembershipSubscriptionAudit_applicationId_fkey"
    FOREIGN KEY ("applicationId") REFERENCES "MembershipApplication"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION "membership_application_preview_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  context_value TEXT := current_setting('app.membership_application_preview_context', true);
  execute_context TEXT := current_setting('app.membership_application_execute_context', true);
  context_id TEXT := COALESCE(NULLIF(current_setting('app.membership_application_preview_id', true), ''), NULLIF(current_setting('app.membership_application_execute_preview_id', true), ''));
  current_time_utc TIMESTAMP := clock_timestamp() AT TIME ZONE 'UTC';
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF context_value IS DISTINCT FROM '1'
       OR NEW."id"::text IS DISTINCT FROM current_setting('app.membership_application_preview_id', true)
       OR NEW."actorId"::text IS DISTINCT FROM current_setting('app.membership_application_preview_actor_id', true)
       OR NEW."userId"::text IS DISTINCT FROM current_setting('app.membership_application_preview_user_id', true)
       OR NEW."issuedAt" > current_time_utc + INTERVAL '5 seconds'
       OR NEW."expiresAt" <= current_time_utc
       OR (NEW."action" = 'submit' AND (NEW."applicationId" IS NOT NULL OR NEW."actorId" IS DISTINCT FROM NEW."userId"))
       OR (NEW."action" = 'withdraw' AND (NEW."applicationId" IS NULL OR NEW."actorId" IS DISTINCT FROM NEW."userId"))
       OR (NEW."action" = 'reject' AND (NEW."applicationId" IS NULL OR NOT EXISTS (
         SELECT 1 FROM "AppUser" actor
          WHERE actor."id" = NEW."actorId" AND actor."role" = 'admin' AND actor."disabledAt" IS NULL
       )))
       OR (NEW."applicationId" IS NOT NULL AND NOT EXISTS (
         SELECT 1
           FROM "MembershipApplication" application
          WHERE application."id" = NEW."applicationId"
            AND application."userId" = NEW."userId"
            AND application."status" = 'pending'
            AND NEW."expectedApplicationVersion" = application."statusVersion"
       ))
    THEN
      RAISE EXCEPTION 'membership application preview requires server context' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'membership application preview is append-only' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."id" IS DISTINCT FROM NEW."id"
     OR OLD."actorId" IS DISTINCT FROM NEW."actorId"
     OR OLD."userId" IS DISTINCT FROM NEW."userId"
     OR OLD."applicationId" IS DISTINCT FROM NEW."applicationId"
     OR OLD."action" IS DISTINCT FROM NEW."action"
     OR OLD."expectedApplicationVersion" IS DISTINCT FROM NEW."expectedApplicationVersion"
     OR OLD."expectedAccountAccessVersion" IS DISTINCT FROM NEW."expectedAccountAccessVersion"
     OR OLD."expectedMembershipVersion" IS DISTINCT FROM NEW."expectedMembershipVersion"
     OR OLD."expectedMembershipState" IS DISTINCT FROM NEW."expectedMembershipState"
     OR OLD."requestKey" IS DISTINCT FROM NEW."requestKey"
     OR OLD."requestFingerprint" IS DISTINCT FROM NEW."requestFingerprint"
     OR OLD."impactFingerprint" IS DISTINCT FROM NEW."impactFingerprint"
     OR OLD."reason" IS DISTINCT FROM NEW."reason"
     OR OLD."issuedAt" IS DISTINCT FROM NEW."issuedAt"
     OR OLD."expiresAt" IS DISTINCT FROM NEW."expiresAt"
     OR OLD."createdAt" IS DISTINCT FROM NEW."createdAt"
     OR OLD."consumedAt" IS NOT NULL
     OR NEW."consumedAt" IS NULL
     OR (OLD."consumedAt" IS NOT NULL AND NEW."consumedAt" <= OLD."consumedAt")
     OR NEW."expiresAt" <= current_time_utc
     OR (context_value IS DISTINCT FROM '1' AND execute_context IS DISTINCT FROM '1')
     OR NEW."id"::text IS DISTINCT FROM context_id
  THEN
    RAISE EXCEPTION 'membership application preview can only be consumed once' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "MembershipApplicationPreview_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "MembershipApplicationPreview"
FOR EACH ROW EXECUTE FUNCTION "membership_application_preview_guard"();

CREATE OR REPLACE FUNCTION "membership_application_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  execute_context TEXT := current_setting('app.membership_application_execute_context', true);
  transition_context TEXT := current_setting('app.membership_application_transition_context', true);
  current_time_utc TIMESTAMP := clock_timestamp() AT TIME ZONE 'UTC';
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'membership application delete is forbidden' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF execute_context IS DISTINCT FROM '1'
       OR NEW."status" <> 'pending'
       OR NEW."statusVersion" <> 1
       OR NEW."userId"::text IS DISTINCT FROM current_setting('app.membership_application_user_id', true)
       OR NEW."submitPreviewId"::text IS DISTINCT FROM current_setting('app.membership_application_preview_id', true)
       OR NOT EXISTS (
         SELECT 1
           FROM "MembershipApplicationPreview" preview
          WHERE preview."id" = NEW."submitPreviewId"
            AND preview."actorId"::text = current_setting('app.membership_application_actor_id', true)
            AND preview."userId" = NEW."userId"
            AND preview."applicationId" IS NULL
            AND preview."action" = 'submit'
            AND preview."expectedApplicationVersion" = 0
            AND preview."expectedAccountAccessVersion" = NEW."accountAccessVersion"
            AND preview."expectedMembershipVersion" = NEW."membershipVersion"
            AND preview."expectedMembershipState" = NEW."membershipState"
            AND preview."consumedAt" IS NULL
            AND preview."issuedAt" <= current_time_utc
            AND preview."expiresAt" > current_time_utc
       )
       OR EXISTS (
         SELECT 1
           FROM "MembershipSubscription" subscription
          WHERE subscription."userId" = NEW."userId"
            AND subscription."status" = 'active'
            AND subscription."startsAt" <= current_time_utc
            AND subscription."expiresAt" > current_time_utc
       )
       OR NOT EXISTS (
         SELECT 1
           FROM "AppUser" user_row
          WHERE user_row."id" = NEW."userId"
            AND user_row."accountAccessVersion" = NEW."accountAccessVersion"
       )
       OR NEW."membershipVersion" IS DISTINCT FROM COALESCE((
         SELECT subscription."version"
           FROM "MembershipSubscription" subscription
          WHERE subscription."userId" = NEW."userId"
       ), 0)
       OR NEW."membershipState" IS DISTINCT FROM COALESCE((
         SELECT CASE
                  WHEN subscription."status" = 'revoked' THEN 'revoked'
                  WHEN subscription."startsAt" <= current_time_utc AND subscription."expiresAt" > current_time_utc THEN 'active'
                  ELSE 'expired'
                END
           FROM "MembershipSubscription" subscription
          WHERE subscription."userId" = NEW."userId"
       ), 'none')
    THEN
      RAISE EXCEPTION 'membership application submit requires server context' USING ERRCODE = 'check_violation';
    END IF;
    PERFORM set_config('app.membership_application_transition_seen', '1', true);
    RETURN NEW;
  END IF;
  IF OLD."id" IS DISTINCT FROM NEW."id"
     OR OLD."userId" IS DISTINCT FROM NEW."userId"
     OR OLD."status" <> 'pending'
     OR NEW."status" = 'pending'
     OR NEW."statusVersion" <> OLD."statusVersion" + 1
     OR OLD."statusVersion" IS DISTINCT FROM current_setting('app.membership_application_expected_version', true)::integer
     OR OLD."requestKey" IS DISTINCT FROM NEW."requestKey"
     OR OLD."requestFingerprint" IS DISTINCT FROM NEW."requestFingerprint"
     OR OLD."impactFingerprint" IS DISTINCT FROM NEW."impactFingerprint"
     OR OLD."requestReason" IS DISTINCT FROM NEW."requestReason"
     OR OLD."accountAccessVersion" IS DISTINCT FROM NEW."accountAccessVersion"
     OR OLD."membershipVersion" IS DISTINCT FROM NEW."membershipVersion"
     OR OLD."membershipState" IS DISTINCT FROM NEW."membershipState"
     OR OLD."submittedAt" IS DISTINCT FROM NEW."submittedAt"
     OR OLD."submitPreviewId" IS DISTINCT FROM NEW."submitPreviewId"
     OR OLD."createdAt" IS DISTINCT FROM NEW."createdAt"
     OR transition_context IS DISTINCT FROM '1'
     OR NEW."id"::text IS DISTINCT FROM current_setting('app.membership_application_id', true)
     OR NEW."userId"::text IS DISTINCT FROM current_setting('app.membership_application_user_id', true)
    THEN
      RAISE EXCEPTION 'membership application transition is invalid' USING ERRCODE = 'check_violation';
    END IF;
  PERFORM set_config('app.membership_application_transition_seen', '1', true);
  RETURN NEW;
END;
$$;

CREATE TRIGGER "MembershipApplication_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "MembershipApplication"
FOR EACH ROW EXECUTE FUNCTION "membership_application_guard"();

CREATE OR REPLACE FUNCTION "membership_application_audit_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  context_value TEXT := current_setting('app.membership_application_execute_context', true);
  transition_context TEXT := current_setting('app.membership_application_transition_context', true);
  lifecycle_context TEXT := current_setting('app.membership_lifecycle_context', true);
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'membership application audit is append-only' USING ERRCODE = 'check_violation';
  END IF;
  IF context_value IS DISTINCT FROM '1'
     AND NOT (transition_context = '1' AND lifecycle_context = '1')
  THEN
    RAISE EXCEPTION 'membership application audit requires server context' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."transactionId" <> txid_current()
     OR NEW."applicationId"::text IS DISTINCT FROM current_setting('app.membership_application_id', true)
     OR NEW."userId"::text IS DISTINCT FROM current_setting('app.membership_application_user_id', true)
     OR NEW."actorId"::text IS DISTINCT FROM current_setting('app.membership_application_actor_id', true)
  THEN
    RAISE EXCEPTION 'membership application audit identity is invalid' USING ERRCODE = 'check_violation';
  END IF;
  IF current_setting('app.membership_application_transition_seen', true) IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'membership application audit requires a matching state transition' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM "MembershipApplication" application
     WHERE application."id" = NEW."applicationId"
       AND application."userId" = NEW."userId"
       AND application."status" = NEW."statusAfter"
       AND application."statusVersion" = NEW."statusVersionAfter"
       AND (
         (NEW."event" = 'submitted'
          AND application."submitPreviewId" = NEW."applicationPreviewId"
          AND application."requestReason" IS NOT DISTINCT FROM NEW."reason")
         OR (NEW."event" = 'withdrawn'
             AND application."withdrawnAt" IS NOT NULL
             AND application."submitPreviewId" IS NOT NULL
             AND NEW."applicationPreviewId" IS NOT NULL)
         OR (NEW."event" = 'rejected'
             AND application."rejectedAt" IS NOT NULL
             AND application."rejectionReason" IS NOT DISTINCT FROM NEW."reason"
             AND NEW."applicationPreviewId" IS NOT NULL)
         OR (NEW."event" = 'fulfilled'
             AND application."fulfilledSubscriptionId" = NEW."subscriptionId"
             AND application."fulfilledSubscriptionVersion" = NEW."subscriptionVersion"
             AND application."fulfilledSubscriptionAuditId" = NEW."subscriptionAuditId"
             AND application."fulfilledMembershipPreviewId" = NEW."membershipPreviewId")
       )
  ) THEN
    RAISE EXCEPTION 'membership application audit does not match current application state' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."event" = 'fulfilled' AND NOT EXISTS (
    SELECT 1
      FROM "MembershipSubscriptionAudit" subscription_audit
     WHERE subscription_audit."id" = NEW."subscriptionAuditId"
       AND subscription_audit."eventKind" = 'grant'
       AND subscription_audit."applicationId" = NEW."applicationId"
       AND subscription_audit."userId" = NEW."userId"
       AND subscription_audit."subscriptionId" = NEW."subscriptionId"
       AND subscription_audit."versionAfter" = NEW."subscriptionVersion"
       AND subscription_audit."previewId" = NEW."membershipPreviewId"
       AND subscription_audit."requestKey" = NEW."requestKey"
       AND subscription_audit."requestFingerprint" = NEW."requestFingerprint"
       AND subscription_audit."impactFingerprint" = NEW."impactFingerprint"
       AND subscription_audit."transactionId" = txid_current()
  ) THEN
    RAISE EXCEPTION 'fulfilled membership application audit must match the grant audit evidence' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "MembershipApplicationAudit_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "MembershipApplicationAudit"
FOR EACH ROW EXECUTE FUNCTION "membership_application_audit_guard"();

CREATE OR REPLACE FUNCTION "membership_application_transition_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  audit_count INTEGER;
BEGIN
  SELECT COUNT(*)::integer INTO audit_count
    FROM "MembershipApplicationAudit" audit
   WHERE audit."applicationId" = NEW."id"
     AND audit."userId" = NEW."userId"
     AND audit."transactionId" = txid_current()
     AND audit."statusAfter" = NEW."status"
     AND audit."statusVersionAfter" = NEW."statusVersion";
  IF audit_count <> 1 THEN
    RAISE EXCEPTION 'membership application transition requires one matching audit' USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."status" = 'fulfilled' THEN
    IF NEW."fulfilledSubscriptionId" IS NULL OR NEW."fulfilledSubscriptionVersion" IS NULL
       OR NEW."fulfilledSubscriptionAuditId" IS NULL OR NEW."fulfilledMembershipPreviewId" IS NULL
       OR NOT EXISTS (
         SELECT 1
           FROM "MembershipSubscriptionAudit" subscription_audit
          WHERE subscription_audit."id" = NEW."fulfilledSubscriptionAuditId"
            AND subscription_audit."eventKind" = 'grant'
            AND subscription_audit."applicationId" = NEW."id"
            AND subscription_audit."userId" = NEW."userId"
            AND subscription_audit."subscriptionId" = NEW."fulfilledSubscriptionId"
            AND subscription_audit."versionAfter" = NEW."fulfilledSubscriptionVersion"
            AND subscription_audit."previewId" = NEW."fulfilledMembershipPreviewId"
            AND subscription_audit."transactionId" = txid_current()
       )
       OR NOT EXISTS (
         SELECT 1
           FROM "MembershipMutationPreview" membership_preview
          WHERE membership_preview."id" = NEW."fulfilledMembershipPreviewId"
            AND membership_preview."applicationId" = NEW."id"
            AND membership_preview."userId" = NEW."userId"
            AND membership_preview."action" = 'grant'
            AND membership_preview."consumedAt" IS NOT NULL
       )
       OR NOT EXISTS (
         SELECT 1
           FROM "MembershipApplicationAudit" application_audit
           JOIN "MembershipSubscriptionAudit" subscription_audit
             ON subscription_audit."id" = NEW."fulfilledSubscriptionAuditId"
          WHERE application_audit."applicationId" = NEW."id"
            AND application_audit."userId" = NEW."userId"
            AND application_audit."event" = 'fulfilled'
            AND application_audit."statusBefore" = 'pending'
            AND application_audit."statusAfter" = 'fulfilled'
            AND application_audit."statusVersionBefore" = NEW."statusVersion" - 1
            AND application_audit."statusVersionAfter" = NEW."statusVersion"
            AND application_audit."applicationPreviewId" IS NULL
            AND application_audit."membershipPreviewId" = NEW."fulfilledMembershipPreviewId"
            AND application_audit."subscriptionId" = NEW."fulfilledSubscriptionId"
            AND application_audit."subscriptionVersion" = NEW."fulfilledSubscriptionVersion"
            AND application_audit."subscriptionAuditId" = NEW."fulfilledSubscriptionAuditId"
            AND application_audit."transactionId" = txid_current()
            AND application_audit."actorId" = subscription_audit."actorId"
            AND application_audit."requestKey" = subscription_audit."requestKey"
            AND application_audit."requestFingerprint" = subscription_audit."requestFingerprint"
            AND application_audit."impactFingerprint" = subscription_audit."impactFingerprint"
            AND subscription_audit."eventKind" = 'grant'
            AND subscription_audit."applicationId" = NEW."id"
            AND subscription_audit."userId" = NEW."userId"
            AND subscription_audit."subscriptionId" = NEW."fulfilledSubscriptionId"
            AND subscription_audit."versionAfter" = NEW."fulfilledSubscriptionVersion"
            AND subscription_audit."previewId" = NEW."fulfilledMembershipPreviewId"
            AND subscription_audit."transactionId" = txid_current()
       )
    THEN
      RAISE EXCEPTION 'fulfilled membership application must bind exact grant audit, preview, and fingerprints' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "MembershipApplication_transition_guard"
AFTER INSERT OR UPDATE ON "MembershipApplication"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "membership_application_transition_guard"();

CREATE OR REPLACE FUNCTION "membership_subscription_audit_application_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW."applicationId" IS NOT NULL THEN
    IF current_setting('app.membership_lifecycle_context', true) IS DISTINCT FROM '1'
       OR NEW."applicationId"::text IS DISTINCT FROM current_setting('app.membership_application_id', true)
       OR NOT EXISTS (
         SELECT 1
           FROM "MembershipApplication" application
          WHERE application."id" = NEW."applicationId"
            AND application."userId" = NEW."userId"
            AND application."status" = 'pending'
       )
    THEN
      RAISE EXCEPTION 'membership subscription audit application binding requires lifecycle context' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "MembershipSubscriptionAudit_application_guard"
BEFORE INSERT ON "MembershipSubscriptionAudit"
FOR EACH ROW EXECUTE FUNCTION "membership_subscription_audit_application_guard"();

CREATE OR REPLACE FUNCTION "membership_subscription_audit_application_transition_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW."applicationId" IS NULL THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM "MembershipApplication" application
      JOIN "MembershipApplicationAudit" application_audit
        ON application_audit."subscriptionAuditId" = application."fulfilledSubscriptionAuditId"
     WHERE application."id" = NEW."applicationId"
       AND application."status" = 'fulfilled'
       AND application."userId" = NEW."userId"
       AND application."fulfilledSubscriptionId" = NEW."subscriptionId"
       AND application."fulfilledSubscriptionVersion" = NEW."versionAfter"
       AND application."fulfilledSubscriptionAuditId" = NEW."id"
       AND application."fulfilledMembershipPreviewId" = NEW."previewId"
       AND application_audit."applicationId" = application."id"
       AND application_audit."userId" = NEW."userId"
       AND application_audit."actorId" = NEW."actorId"
       AND application_audit."event" = 'fulfilled'
       AND application_audit."statusBefore" = 'pending'
       AND application_audit."statusAfter" = 'fulfilled'
       AND application_audit."statusVersionBefore" = application."statusVersion" - 1
       AND application_audit."statusVersionAfter" = application."statusVersion"
       AND application_audit."applicationPreviewId" IS NULL
       AND application_audit."membershipPreviewId" = NEW."previewId"
       AND application_audit."subscriptionId" = NEW."subscriptionId"
       AND application_audit."subscriptionVersion" = NEW."versionAfter"
       AND application_audit."subscriptionAuditId" = NEW."id"
       AND application_audit."requestKey" = NEW."requestKey"
       AND application_audit."requestFingerprint" = NEW."requestFingerprint"
       AND application_audit."impactFingerprint" = NEW."impactFingerprint"
       AND application_audit."transactionId" = txid_current()
  ) THEN
    RAISE EXCEPTION 'membership subscription audit requires fulfilled application closure' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "MembershipSubscriptionAudit_application_transition_guard"
AFTER INSERT ON "MembershipSubscriptionAudit"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "membership_subscription_audit_application_transition_guard"();

CREATE OR REPLACE FUNCTION "membership_subscription_pending_application_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  pending_application_id UUID;
BEGIN
  IF current_setting('app.membership_lifecycle_action', true) = 'grant' THEN
    SELECT application."id"
      INTO pending_application_id
      FROM "MembershipApplication" application
     WHERE application."userId" = NEW."userId"
       AND application."status" = 'pending';
    IF pending_application_id IS NOT NULL
       AND current_setting('app.membership_application_id', true) IS DISTINCT FROM pending_application_id::text
    THEN
      RAISE EXCEPTION 'membership grant must bind the pending membership application' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "MembershipSubscription_pending_application_guard"
BEFORE INSERT OR UPDATE ON "MembershipSubscription"
FOR EACH ROW EXECUTE FUNCTION "membership_subscription_pending_application_guard"();

CREATE OR REPLACE FUNCTION "membership_mutation_preview_application_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."applicationId" IS DISTINCT FROM NEW."applicationId" THEN
    RAISE EXCEPTION 'membership mutation preview application binding is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."applicationId" IS NOT NULL
     AND (NEW."action" <> 'grant'
       OR NOT EXISTS (
         SELECT 1
           FROM "MembershipApplication" application
          WHERE application."id" = NEW."applicationId"
            AND application."userId" = NEW."userId"
            AND application."status" = 'pending'
       ))
  THEN
    RAISE EXCEPTION 'membership mutation preview application binding is invalid' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "MembershipMutationPreview_application_guard"
BEFORE INSERT OR UPDATE ON "MembershipMutationPreview"
FOR EACH ROW EXECUTE FUNCTION "membership_mutation_preview_application_guard"();
