-- ENT-010: allocation-aware platform credit accounting and governed manual
-- grant/revoke.  This is a forward-only migration.  Existing reservation and
-- ledger rows are retained verbatim; one allocation is backfilled as a
-- proof-preserving projection of each existing reservation.

CREATE TYPE "PlatformTokenGrantMutationAction" AS ENUM ('grant', 'revoke');
CREATE TYPE "PlatformTokenGrantAuditEvent" AS ENUM ('grant', 'revoke');

ALTER TABLE "PlatformTokenGrant"
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

-- Preserve the exact set of pre-ENT-010 manual grants that had no issuer.
-- This is a migration snapshot, not an application capability: the guard
-- below never permits a newly generated id to enter this relation.
CREATE TABLE "PlatformTokenGrantLegacyNullIssuerSnapshot" (
  "grantId" UUID NOT NULL,
  "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PlatformTokenGrantLegacyNullIssuerSnapshot_pkey" PRIMARY KEY ("grantId")
);
INSERT INTO "PlatformTokenGrantLegacyNullIssuerSnapshot" ("grantId")
SELECT "id"
  FROM "PlatformTokenGrant"
 WHERE "kind" = 'manual' AND "issuedById" IS NULL;
ALTER TABLE "PlatformTokenGrantLegacyNullIssuerSnapshot"
  ADD CONSTRAINT "PlatformTokenGrantLegacyNullIssuerSnapshot_grantId_fkey"
  FOREIGN KEY ("grantId") REFERENCES "PlatformTokenGrant"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

CREATE TABLE "PlatformTokenReservationAllocation" (
  "id" UUID NOT NULL,
  "reservationId" UUID NOT NULL,
  "grantId" UUID NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "reservedTokens" INTEGER NOT NULL,
  "settledTokens" INTEGER NOT NULL DEFAULT 0,
  "releasedTokens" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PlatformTokenReservationAllocation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PlatformTokenReservationAllocation_reserved_check" CHECK ("reservedTokens" > 0),
  CONSTRAINT "PlatformTokenReservationAllocation_settlement_check" CHECK (
    "settledTokens" >= 0 AND "releasedTokens" >= 0
    AND "settledTokens" + "releasedTokens" <= "reservedTokens"
  ),
  CONSTRAINT "PlatformTokenReservationAllocation_ordinal_check" CHECK ("ordinal" > 0)
);

CREATE TABLE "PlatformTokenGrantMutationPreview" (
  "id" UUID NOT NULL,
  "actorId" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "grantId" UUID,
  "action" "PlatformTokenGrantMutationAction" NOT NULL,
  "amount" INTEGER,
  "expiresAt" TIMESTAMP(3),
  "reclaimableTokens" INTEGER,
  "expectedVersion" INTEGER NOT NULL,
  "expectedRemainingTokens" INTEGER,
  "requestKey" VARCHAR(180) NOT NULL,
  "reason" VARCHAR(500) NOT NULL,
  "impactFingerprint" CHAR(64) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "issuedAt" TIMESTAMP(3) NOT NULL,
  "previewExpiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PlatformTokenGrantMutationPreview_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PlatformTokenGrantMutationPreview_amount_check" CHECK ("amount" IS NULL OR "amount" > 0),
  CONSTRAINT "PlatformTokenGrantMutationPreview_reclaimable_check" CHECK ("reclaimableTokens" IS NULL OR "reclaimableTokens" >= 0),
  CONSTRAINT "PlatformTokenGrantMutationPreview_window_check" CHECK ("previewExpiresAt" > "issuedAt"),
  CONSTRAINT "PlatformTokenGrantMutationPreview_action_snapshot_check" CHECK (
    ("action" = 'grant' AND "grantId" IS NULL AND "amount" IS NOT NULL AND "expiresAt" IS NOT NULL AND "expectedRemainingTokens" IS NULL)
    OR ("action" = 'revoke' AND "grantId" IS NOT NULL AND "amount" IS NULL AND "expiresAt" IS NULL AND "expectedRemainingTokens" IS NOT NULL)
  )
);

CREATE TABLE "PlatformTokenGrantAudit" (
  "id" UUID NOT NULL,
  "grantId" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "actorId" UUID NOT NULL,
  "event" "PlatformTokenGrantAuditEvent" NOT NULL,
  "versionBefore" INTEGER NOT NULL,
  "versionAfter" INTEGER NOT NULL,
  "statusBefore" VARCHAR(16) NOT NULL,
  "statusAfter" VARCHAR(16) NOT NULL,
  "amount" INTEGER NOT NULL,
  "remainingBefore" INTEGER NOT NULL,
  "remainingAfter" INTEGER NOT NULL,
  "previewId" UUID NOT NULL,
  "reason" VARCHAR(500) NOT NULL,
  "requestKey" VARCHAR(180) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "impactFingerprint" CHAR(64) NOT NULL,
  "transactionId" BIGINT NOT NULL DEFAULT txid_current(),
  "transitionAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PlatformTokenGrantAudit_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PlatformTokenGrantAudit_amount_check" CHECK ("amount" >= 0),
  CONSTRAINT "PlatformTokenGrantAudit_remaining_check" CHECK ("remainingBefore" >= 0 AND "remainingAfter" >= 0),
  CONSTRAINT "PlatformTokenGrantAudit_version_check" CHECK ("versionBefore" >= 0 AND "versionAfter" = "versionBefore" + 1)
);

CREATE UNIQUE INDEX "PlatformTokenReservationAllocation_reservationId_ordinal_key"
  ON "PlatformTokenReservationAllocation" ("reservationId", "ordinal");
CREATE UNIQUE INDEX "PlatformTokenReservationAllocation_reservationId_grantId_key"
  ON "PlatformTokenReservationAllocation" ("reservationId", "grantId");
CREATE INDEX "PlatformTokenReservationAllocation_grantId_createdAt_idx"
  ON "PlatformTokenReservationAllocation" ("grantId", "createdAt");
CREATE INDEX "PlatformTokenReservationAllocation_reservationId_createdAt_idx"
  ON "PlatformTokenReservationAllocation" ("reservationId", "createdAt");
CREATE UNIQUE INDEX "PlatformTokenGrantMutationPreview_actorId_requestKey_key"
  ON "PlatformTokenGrantMutationPreview" ("actorId", "requestKey");
CREATE INDEX "PlatformTokenGrantMutationPreview_userId_createdAt_idx"
  ON "PlatformTokenGrantMutationPreview" ("userId", "createdAt");
CREATE INDEX "PlatformTokenGrantMutationPreview_grantId_createdAt_idx"
  ON "PlatformTokenGrantMutationPreview" ("grantId", "createdAt");
CREATE INDEX "PlatformTokenGrantMutationPreview_previewExpiresAt_consumedAt_idx"
  ON "PlatformTokenGrantMutationPreview" ("previewExpiresAt", "consumedAt");
CREATE UNIQUE INDEX "PlatformTokenGrantAudit_actorId_requestKey_key"
  ON "PlatformTokenGrantAudit" ("actorId", "requestKey");
CREATE INDEX "PlatformTokenGrantAudit_userId_createdAt_idx"
  ON "PlatformTokenGrantAudit" ("userId", "createdAt");
CREATE INDEX "PlatformTokenGrantAudit_grantId_createdAt_idx"
  ON "PlatformTokenGrantAudit" ("grantId", "createdAt");
CREATE INDEX "PlatformTokenGrantAudit_previewId_createdAt_idx"
  ON "PlatformTokenGrantAudit" ("previewId", "createdAt");

-- Verify before projection.  The migration must never invent ownership or
-- terminal accounting for an old reservation.
DO $$
DECLARE
  bad_count BIGINT;
BEGIN
  SELECT count(*) INTO bad_count
    FROM "PlatformTokenReservation" reservation
    LEFT JOIN "PlatformTokenGrant" grant_row ON grant_row."id" = reservation."grantId"
   WHERE grant_row."id" IS NULL
      OR grant_row."userId" IS DISTINCT FROM reservation."userId"
      OR reservation."reservedTokens" <= 0
      OR reservation."status" = 'settled' AND (
           reservation."settledTokens" IS NULL
        OR reservation."settledTokens" < 0
        OR reservation."settledTokens" > reservation."reservedTokens"
      )
      OR reservation."status" <> 'settled' AND reservation."settledTokens" IS NOT NULL
      OR reservation."status" = 'settled' AND reservation."settledAt" IS NULL
      OR reservation."status" = 'released' AND reservation."releasedAt" IS NULL;
  IF bad_count <> 0 THEN
    RAISE EXCEPTION 'ENT010 reservation allocation backfill is not provable: % rows', bad_count USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO "PlatformTokenReservationAllocation" (
    "id", "reservationId", "grantId", "ordinal", "reservedTokens", "settledTokens", "releasedTokens", "createdAt"
  )
  SELECT
    gen_random_uuid(),
    reservation."id",
    reservation."grantId",
    1,
    reservation."reservedTokens",
    CASE WHEN reservation."status" = 'settled' THEN reservation."settledTokens" ELSE 0 END,
    CASE
      WHEN reservation."status" = 'released' THEN reservation."reservedTokens"
      WHEN reservation."status" = 'settled' THEN reservation."reservedTokens" - reservation."settledTokens"
      ELSE 0
    END,
    reservation."createdAt"
  FROM "PlatformTokenReservation" reservation;
END;
$$;

ALTER TABLE "PlatformTokenReservationAllocation"
  ADD CONSTRAINT "PlatformTokenReservationAllocation_reservationId_fkey"
  FOREIGN KEY ("reservationId") REFERENCES "PlatformTokenReservation"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PlatformTokenReservationAllocation_grantId_fkey"
  FOREIGN KEY ("grantId") REFERENCES "PlatformTokenGrant"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "PlatformTokenGrantMutationPreview"
  ADD CONSTRAINT "PlatformTokenGrantMutationPreview_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PlatformTokenGrantMutationPreview_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PlatformTokenGrantMutationPreview_grantId_fkey"
  FOREIGN KEY ("grantId") REFERENCES "PlatformTokenGrant"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "PlatformTokenGrantAudit"
  ADD CONSTRAINT "PlatformTokenGrantAudit_grantId_fkey"
  FOREIGN KEY ("grantId") REFERENCES "PlatformTokenGrant"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PlatformTokenGrantAudit_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PlatformTokenGrantAudit_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PlatformTokenGrantAudit_previewId_fkey"
  FOREIGN KEY ("previewId") REFERENCES "PlatformTokenGrantMutationPreview"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION "platform_token_grant_legacy_snapshot_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  owner_name TEXT;
  is_superuser BOOLEAN;
BEGIN
  SELECT pg_get_userbyid(c.relowner)
    INTO owner_name
    FROM pg_catalog.pg_class c
   WHERE c.oid = 'public."PlatformTokenGrantLegacyNullIssuerSnapshot"'::regclass;
  SELECT rolsuper INTO is_superuser FROM pg_catalog.pg_roles WHERE rolname = current_user;
  IF current_user IS DISTINCT FROM owner_name AND COALESCE(is_superuser, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'platform token legacy snapshot is migration-owned' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'platform token legacy snapshot is append-only' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "PlatformTokenGrantLegacyNullIssuerSnapshot_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "PlatformTokenGrantLegacyNullIssuerSnapshot"
FOR EACH ROW EXECUTE FUNCTION "platform_token_grant_legacy_snapshot_guard"();

-- Runtime allocation updates are deliberately narrow.  The database trigger
-- is an application-consistency boundary; role ACLs remain the principal
-- boundary and are updated by the principal reconciler.
CREATE OR REPLACE FUNCTION "platform_token_reservation_allocation_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  reservation_row RECORD;
  grant_row RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'platform token reservation allocations are append-only' USING ERRCODE = 'restrict_violation';
  END IF;
  IF current_user IS DISTINCT FROM (
       SELECT pg_get_userbyid(c.relowner)
         FROM pg_catalog.pg_class c
        WHERE c.oid = 'public."PlatformTokenReservationAllocation"'::regclass
     )
     AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = current_user AND rolsuper) THEN
    RAISE EXCEPTION 'platform token reservation allocation mutation requires the database owner capability' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT "id", "userId", "grantId", "reservedTokens", "status", "settledTokens"
    INTO reservation_row
    FROM "PlatformTokenReservation" WHERE "id" = NEW."reservationId";
  SELECT "id", "userId" INTO grant_row FROM "PlatformTokenGrant" WHERE "id" = NEW."grantId";
  IF NOT FOUND OR reservation_row."id" IS NULL
     OR reservation_row."userId" IS DISTINCT FROM grant_row."userId"
     OR NEW."settledTokens" < 0 OR NEW."releasedTokens" < 0
     OR NEW."reservedTokens" <= 0
     OR NEW."settledTokens" + NEW."releasedTokens" > NEW."reservedTokens"
     OR NEW."reservedTokens" > reservation_row."reservedTokens" THEN
    RAISE EXCEPTION 'platform token reservation allocation ownership or bounds mismatch' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND (
       OLD."reservationId" IS DISTINCT FROM NEW."reservationId"
    OR OLD."grantId" IS DISTINCT FROM NEW."grantId"
    OR OLD."ordinal" IS DISTINCT FROM NEW."ordinal"
    OR OLD."reservedTokens" IS DISTINCT FROM NEW."reservedTokens"
    OR NEW."settledTokens" < OLD."settledTokens"
    OR NEW."releasedTokens" < OLD."releasedTokens"
  ) THEN
    RAISE EXCEPTION 'platform token reservation allocation facts are immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "PlatformTokenReservationAllocation_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "PlatformTokenReservationAllocation"
FOR EACH ROW EXECUTE FUNCTION "platform_token_reservation_allocation_guard"();

CREATE OR REPLACE FUNCTION "platform_token_reservation_mutation_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  owner_name TEXT;
  is_superuser BOOLEAN;
BEGIN
  SELECT pg_get_userbyid(c.relowner)
    INTO owner_name
    FROM pg_catalog.pg_class c
   WHERE c.oid = 'public."PlatformTokenReservation"'::regclass;
  SELECT rolsuper INTO is_superuser FROM pg_catalog.pg_roles WHERE rolname = current_user;
  IF current_user IS DISTINCT FROM owner_name AND COALESCE(is_superuser, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'platform token reservation mutation requires the database owner capability' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
CREATE TRIGGER "PlatformTokenReservation_mutation_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "PlatformTokenReservation"
FOR EACH ROW EXECUTE FUNCTION "platform_token_reservation_mutation_guard"();

CREATE OR REPLACE FUNCTION "platform_token_grant_mutation_preview_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  owner_name TEXT;
BEGIN
  SELECT pg_get_userbyid(c.relowner) INTO owner_name FROM pg_catalog.pg_class c
   WHERE c.oid = 'public."PlatformTokenGrantMutationPreview"'::regclass;
  IF current_user IS DISTINCT FROM owner_name AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=current_user AND rolsuper) THEN
    RAISE EXCEPTION 'platform token grant preview requires the database governance function' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'platform token grant mutation previews are append-only' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;
  IF OLD."consumedAt" IS NOT NULL
     OR NEW."actorId" IS DISTINCT FROM OLD."actorId"
     OR NEW."userId" IS DISTINCT FROM OLD."userId"
     OR NEW."grantId" IS DISTINCT FROM OLD."grantId"
     OR NEW."action" IS DISTINCT FROM OLD."action"
     OR NEW."amount" IS DISTINCT FROM OLD."amount"
     OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
     OR NEW."reclaimableTokens" IS DISTINCT FROM OLD."reclaimableTokens"
     OR NEW."expectedVersion" IS DISTINCT FROM OLD."expectedVersion"
     OR NEW."expectedRemainingTokens" IS DISTINCT FROM OLD."expectedRemainingTokens"
     OR NEW."requestKey" IS DISTINCT FROM OLD."requestKey"
     OR NEW."reason" IS DISTINCT FROM OLD."reason"
     OR NEW."impactFingerprint" IS DISTINCT FROM OLD."impactFingerprint"
     OR NEW."requestFingerprint" IS DISTINCT FROM OLD."requestFingerprint"
     OR NEW."issuedAt" IS DISTINCT FROM OLD."issuedAt"
     OR NEW."previewExpiresAt" IS DISTINCT FROM OLD."previewExpiresAt"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     OR NEW."consumedAt" IS NULL THEN
    RAISE EXCEPTION 'platform token grant mutation preview is immutable or stale' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "PlatformTokenGrantMutationPreview_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "PlatformTokenGrantMutationPreview"
FOR EACH ROW EXECUTE FUNCTION "platform_token_grant_mutation_preview_guard"();

CREATE OR REPLACE FUNCTION "platform_token_grant_governance_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  owner_name TEXT;
  is_superuser BOOLEAN;
  owner_capability BOOLEAN;
BEGIN
  SELECT pg_get_userbyid(c.relowner)
    INTO owner_name
    FROM pg_catalog.pg_class c
   WHERE c.oid = 'public."PlatformTokenGrant"'::regclass;
  SELECT rolsuper INTO is_superuser FROM pg_catalog.pg_roles WHERE rolname = current_user;
  owner_capability := current_user IS NOT DISTINCT FROM owner_name OR COALESCE(is_superuser, false);
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'manual' AND NEW."issuedById" IS NULL THEN
      IF NOT EXISTS (
        SELECT 1 FROM "PlatformTokenGrantLegacyNullIssuerSnapshot" snapshot
         WHERE snapshot."grantId" = NEW."id"
      ) THEN
        RAISE EXCEPTION 'new manual platform token grants require an issuer' USING ERRCODE = 'check_violation';
      END IF;
      RAISE EXCEPTION 'legacy null-issuer platform token grants cannot be inserted' USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW."kind" = 'manual' AND NOT owner_capability THEN
      RAISE EXCEPTION 'manual platform token grants require the database governance function' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW."kind" = 'manual' AND (NEW."version" <> 1 OR NEW."revokedAt" IS NOT NULL) THEN
      RAISE EXCEPTION 'manual platform token grant creation evidence mismatch' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'signup' THEN RETURN OLD; END IF;
    IF OLD."kind" = 'manual'
       AND OLD."issuedById" IS NULL
       AND EXISTS (SELECT 1 FROM "PlatformTokenGrantLegacyNullIssuerSnapshot" snapshot WHERE snapshot."grantId" = OLD."id")
       AND owner_capability
       AND NOT EXISTS (SELECT 1 FROM "PlatformTokenReservation" WHERE "grantId" = OLD."id") THEN
      RETURN OLD; -- compatibility for isolated legacy retention fixtures
    END IF;
    RAISE EXCEPTION 'manual platform token grants cannot be deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."kind" = 'signup' OR NEW."kind" = 'signup' THEN
    IF owner_capability
       OR (session_user = 'ai_project_os_entitlement_writer'
           AND current_setting('app.account_entitlement_activation_context', true) = 'service-v1') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'signup platform token grant mutation requires the writer capability' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT owner_capability AND session_user <> 'ai_project_os_entitlement_writer' THEN
    RAISE EXCEPTION 'platform token grant mutation requires the database owner capability' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."userId" IS DISTINCT FROM NEW."userId"
     OR OLD."kind" IS DISTINCT FROM NEW."kind"
     OR OLD."amount" IS DISTINCT FROM NEW."amount"
     OR OLD."offerVersion" IS DISTINCT FROM NEW."offerVersion"
     OR OLD."offerAmount" IS DISTINCT FROM NEW."offerAmount"
     OR OLD."offerValidForDays" IS DISTINCT FROM NEW."offerValidForDays"
     OR OLD."eligibilityKey" IS DISTINCT FROM NEW."eligibilityKey"
     OR OLD."eligibilitySource" IS DISTINCT FROM NEW."eligibilitySource"
     OR OLD."issuedById" IS DISTINCT FROM NEW."issuedById"
     OR OLD."issuedAt" IS DISTINCT FROM NEW."issuedAt"
     OR OLD."expiresAt" IS DISTINCT FROM NEW."expiresAt"
     OR OLD."createdAt" IS DISTINCT FROM NEW."createdAt" THEN
    RAISE EXCEPTION 'manual platform token grant facts are immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."remainingTokens" < 0 OR NEW."remainingTokens" > NEW."amount" THEN
    RAISE EXCEPTION 'manual platform token grant remaining amount is out of bounds' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."revokedAt" IS DISTINCT FROM OLD."revokedAt"
     OR NEW."version" IS DISTINCT FROM OLD."version" THEN
    IF NOT owner_capability OR NEW."version" <> OLD."version" + 1 OR NEW."remainingTokens" <> 0
       OR NEW."revokedAt" IS NULL OR NOT EXISTS (
         SELECT 1
           FROM "PlatformTokenGrantMutationPreview" preview
          WHERE preview."grantId" = OLD."id"
            AND preview."action" = 'revoke'
            AND preview."consumedAt" IS NOT NULL
            AND preview."expectedVersion" = OLD."version"
            AND preview."expectedRemainingTokens" = OLD."remainingTokens"
            AND preview."consumedAt" = NEW."revokedAt"
       ) THEN
      RAISE EXCEPTION 'manual platform token grant revocation requires governed context' USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF NEW."remainingTokens" IS DISTINCT FROM OLD."remainingTokens" AND NOT owner_capability THEN
    RAISE EXCEPTION 'manual platform token grant balance update requires the database governance function' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "PlatformTokenGrant_governance_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "PlatformTokenGrant"
FOR EACH ROW EXECUTE FUNCTION "platform_token_grant_governance_guard"();

CREATE OR REPLACE FUNCTION "platform_token_grant_audit_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  grant_row RECORD;
  preview_row RECORD;
  ledger_count BIGINT;
  expected_ledger_kind TEXT;
  expected_ledger_amount INTEGER;
  expected_ledger_key TEXT;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'platform token grant audit is append-only' USING ERRCODE = 'restrict_violation';
  END IF;
  IF current_user IS DISTINCT FROM (SELECT pg_get_userbyid(c.relowner) FROM pg_catalog.pg_class c WHERE c.oid='public."PlatformTokenGrantAudit"'::regclass)
     AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=current_user AND rolsuper) THEN
    RAISE EXCEPTION 'platform token grant audit requires the database governance function' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."transactionId" IS DISTINCT FROM txid_current() THEN
    RAISE EXCEPTION 'platform token grant audit transaction mismatch' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO grant_row FROM "PlatformTokenGrant" WHERE "id" = NEW."grantId";
  SELECT * INTO preview_row FROM "PlatformTokenGrantMutationPreview" WHERE "id" = NEW."previewId";
  IF grant_row."id" IS NULL OR preview_row."id" IS NULL
     OR grant_row."userId" IS DISTINCT FROM NEW."userId"
     OR preview_row."actorId" IS DISTINCT FROM NEW."actorId"
     OR preview_row."userId" IS DISTINCT FROM NEW."userId"
     OR preview_row."action"::text IS DISTINCT FROM NEW."event"::text
     OR preview_row."requestKey" IS DISTINCT FROM NEW."requestKey"
     OR preview_row."consumedAt" IS NULL THEN
    RAISE EXCEPTION 'platform token grant audit snapshot mismatch' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."event"::text = 'grant' THEN
    IF grant_row."kind"::text IS DISTINCT FROM 'manual'
       OR grant_row."issuedById" IS DISTINCT FROM NEW."actorId"
       OR grant_row."version" <> NEW."versionAfter"
       OR grant_row."revokedAt" IS NOT NULL
       OR NEW."versionBefore" <> 0
       OR NEW."versionAfter" <> 1
       OR NEW."statusBefore" IS DISTINCT FROM 'absent'
       OR NEW."statusAfter" IS DISTINCT FROM 'active'
       OR NEW."amount" <> grant_row."amount"
       OR NEW."remainingBefore" <> 0
       OR NEW."remainingAfter" <> grant_row."remainingTokens"
    THEN
      RAISE EXCEPTION 'platform token grant audit grant snapshot mismatch' USING ERRCODE = 'check_violation';
    END IF;
    expected_ledger_kind := 'grant';
    expected_ledger_amount := NEW."amount";
  ELSIF NEW."event"::text = 'revoke' THEN
    IF grant_row."kind"::text IS DISTINCT FROM 'manual'
       OR grant_row."version" <> NEW."versionAfter"
       OR grant_row."revokedAt" IS NULL
       OR grant_row."remainingTokens" <> 0
       OR NEW."statusBefore" NOT IN ('active', 'expired')
       OR NEW."statusAfter" IS DISTINCT FROM 'revoked'
       OR NEW."amount" <> NEW."remainingBefore"
       OR NEW."remainingAfter" <> 0
    THEN
      RAISE EXCEPTION 'platform token grant audit revoke snapshot mismatch' USING ERRCODE = 'check_violation';
    END IF;
    expected_ledger_kind := 'adjustment';
    expected_ledger_amount := -NEW."remainingBefore";
  ELSE
    RAISE EXCEPTION 'unknown platform token grant audit event' USING ERRCODE = 'check_violation';
  END IF;
  expected_ledger_key := NEW."event"::text || ':manual:'
    || encode(digest(convert_to(NEW."actorId"::text || ':' || NEW."requestKey", 'UTF8'), 'sha256'), 'hex');
  SELECT count(*) INTO ledger_count
    FROM "PlatformTokenLedgerEntry"
   WHERE "grantId" = NEW."grantId"
     AND "userId" = NEW."userId"
     AND "entryKind"::text = expected_ledger_kind
     AND "amount" = expected_ledger_amount
     AND "idempotencyKey" = expected_ledger_key;
  IF ledger_count <> 1 THEN
    RAISE EXCEPTION 'platform token grant audit ledger pairing mismatch' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "PlatformTokenGrantAudit_append_only_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "PlatformTokenGrantAudit"
FOR EACH ROW EXECUTE FUNCTION "platform_token_grant_audit_guard"();

CREATE OR REPLACE FUNCTION "platform_token_grant_audit_link_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "PlatformTokenGrantAudit" audit
     WHERE audit."grantId" = NEW."id"
       AND audit."userId" = NEW."userId"
       AND audit."event"::text = 'grant'
       AND audit."versionAfter" = NEW."version"
       AND audit."remainingAfter" = NEW."remainingTokens"
       AND audit."transactionId" = txid_current()
  ) AND NEW."kind" = 'manual' AND NEW."issuedById" IS NOT NULL THEN
    RAISE EXCEPTION 'manual platform token grant requires paired audit' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER "PlatformTokenGrant_audit_link_guard"
AFTER INSERT ON "PlatformTokenGrant"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "platform_token_grant_audit_link_guard"();

-- Keep the ledger append-only for manual governance rows.  Reserve/settle/
-- release/hold rows remain runtime lifecycle evidence and are governed by
-- their existing idempotency keys and allocation ownership checks.
CREATE OR REPLACE FUNCTION "platform_token_manual_ledger_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  grant_kind TEXT;
  owner_name TEXT;
  is_superuser BOOLEAN;
  owner_capability BOOLEAN;
BEGIN
  SELECT pg_get_userbyid(c.relowner)
    INTO owner_name
    FROM pg_catalog.pg_class c
   WHERE c.oid = 'public."PlatformTokenLedgerEntry"'::regclass;
  SELECT rolsuper INTO is_superuser FROM pg_catalog.pg_roles WHERE rolname = current_user;
  owner_capability := current_user IS NOT DISTINCT FROM owner_name OR COALESCE(is_superuser, false);
  IF NOT owner_capability THEN
    IF TG_OP <> 'INSERT'
       OR current_setting('app.account_entitlement_activation_context', true) IS DISTINCT FROM 'service-v1'
          AND current_setting('app.platform_credit_governance_context', true) IS DISTINCT FROM 'service-v1' THEN
      RAISE EXCEPTION 'platform token ledger mutation requires the database owner capability' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    IF TG_OP = 'DELETE' THEN
      IF OLD."entryKind" IN ('grant', 'adjustment') THEN
        RAISE EXCEPTION 'platform token manual ledger evidence is append-only' USING ERRCODE = 'restrict_violation';
      END IF;
      RETURN OLD;
    END IF;
    IF OLD."entryKind" IN ('grant', 'adjustment') OR NEW."entryKind" IN ('grant', 'adjustment') THEN
      RAISE EXCEPTION 'platform token manual ledger evidence is append-only' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;
  SELECT "kind"::text INTO grant_kind FROM "PlatformTokenGrant" WHERE "id" = NEW."grantId";
  IF NOT owner_capability THEN
    IF grant_kind = 'signup'
       AND NEW."entryKind" = 'grant'
       AND session_user = 'ai_project_os_entitlement_writer'
       AND current_setting('app.account_entitlement_activation_context', true) = 'service-v1' THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'platform token ledger mutation requires the governed capability' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "PlatformTokenManualLedger_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "PlatformTokenLedgerEntry"
FOR EACH ROW EXECUTE FUNCTION "platform_token_manual_ledger_guard"();

-- User ownership is checked in the trigger and in the service.  This second
-- deferred invariant catches a caller that attempts to attach allocations to
-- a reservation while changing one side of the relation in the same tx.
CREATE OR REPLACE FUNCTION "platform_token_reservation_allocation_deferred_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  reservation_id UUID;
  reservation_status TEXT;
  reservation_total INTEGER;
  reservation_settled INTEGER;
  allocation_count BIGINT;
  allocation_total BIGINT;
  allocation_settled BIGINT;
  allocation_released BIGINT;
BEGIN
  -- Re-read the parent and all child rows at constraint-trigger time.  A
  -- transaction can update the parent and children in either order; only the
  -- final tuple is meaningful for the invariant.
  IF TG_TABLE_NAME = 'PlatformTokenReservation' THEN
    reservation_id := NEW."id";
  ELSE
    reservation_id := NEW."reservationId";
  END IF;
  SELECT "status"::text, "reservedTokens", "settledTokens"
    INTO reservation_status, reservation_total, reservation_settled
    FROM "PlatformTokenReservation"
   WHERE "id" = reservation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'platform token reservation allocation parent is missing' USING ERRCODE = 'check_violation';
  END IF;

  SELECT count(*),
         COALESCE(sum("reservedTokens"), 0),
         COALESCE(sum("settledTokens"), 0),
         COALESCE(sum("releasedTokens"), 0)
    INTO allocation_count, allocation_total, allocation_settled, allocation_released
    FROM "PlatformTokenReservationAllocation"
   WHERE "reservationId" = reservation_id;

  -- Rows created before ENT-010 have no allocation projection only in
  -- compatibility fixtures.  The forward migration backfills every real
  -- reservation.  Application principals may never create a parent without
  -- an allocation; only an isolated superuser fixture or migration owner can
  -- retain the historical no-child shape.
  IF allocation_count = 0 THEN
    IF session_user IN ('ai_project_os_runtime', 'ai_project_os_entitlement_writer') THEN
      RAISE EXCEPTION 'new platform token reservations require allocation rows' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF allocation_total <> reservation_total THEN
    RAISE EXCEPTION 'platform token reservation allocation total mismatch' USING ERRCODE = 'check_violation';
  END IF;

  CASE reservation_status
    WHEN 'reserved', 'held' THEN
      IF reservation_settled IS NOT NULL OR allocation_settled <> 0 OR allocation_released <> 0 THEN
        RAISE EXCEPTION 'non-terminal platform token reservation has settled or released allocations' USING ERRCODE = 'check_violation';
      END IF;
    WHEN 'settled' THEN
      IF reservation_settled IS NULL
         OR reservation_settled < 0
         OR reservation_settled > reservation_total
         OR allocation_settled <> reservation_settled
         OR allocation_settled + allocation_released <> reservation_total
      THEN
        RAISE EXCEPTION 'settled platform token reservation allocation aggregate mismatch' USING ERRCODE = 'check_violation';
      END IF;
    WHEN 'released' THEN
      IF reservation_settled IS NOT NULL
         OR allocation_settled <> 0
         OR allocation_released <> reservation_total
      THEN
        RAISE EXCEPTION 'released platform token reservation allocation aggregate mismatch' USING ERRCODE = 'check_violation';
      END IF;
    ELSE
      RAISE EXCEPTION 'unknown platform token reservation status' USING ERRCODE = 'check_violation';
  END CASE;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER "PlatformTokenReservationAllocation_total_guard"
AFTER INSERT OR UPDATE ON "PlatformTokenReservationAllocation"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "platform_token_reservation_allocation_deferred_guard"();
CREATE CONSTRAINT TRIGGER "PlatformTokenReservation_allocation_total_guard"
AFTER INSERT OR UPDATE ON "PlatformTokenReservation"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "platform_token_reservation_allocation_deferred_guard"();

-- Application roles receive EXECUTE only.  The function validates a closed
-- vocabulary of lifecycle mutations and re-derives every balance transition
-- from locked database rows; callers cannot turn it into arbitrary DML.
CREATE OR REPLACE FUNCTION "platform_token_runtime_apply"(
  action_name TEXT,
  reservation_payload JSONB,
  allocation_payload JSONB,
  ledger_payload JSONB
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  reservation_row RECORD;
  allocation_row RECORD;
  grant_row RECORD;
  item JSONB;
  ledger_item JSONB;
  allocation_id UUID;
  allocation_grant_id UUID;
  reservation_id UUID := (reservation_payload->>'id')::uuid;
  user_id UUID := (reservation_payload->>'userId')::uuid;
  total_reserved INTEGER := (reservation_payload->>'reservedTokens')::integer;
  release_deltas JSONB := '{}'::jsonb;
  expected_ledger_count INTEGER;
  expected_amount INTEGER;
  remaining_to_allocate INTEGER;
  candidate_ordinal INTEGER;
BEGIN
  IF session_user <> 'ai_project_os_runtime' AND session_user <> current_user THEN
    RAISE EXCEPTION 'platform token runtime function requires runtime principal' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF action_name NOT IN ('reserve', 'settle', 'release', 'hold')
     OR jsonb_typeof(allocation_payload) <> 'array'
     OR jsonb_array_length(allocation_payload) = 0
     OR jsonb_typeof(ledger_payload) <> 'array'
     OR jsonb_array_length(ledger_payload) = 0 THEN
    RAISE EXCEPTION 'invalid platform token runtime mutation' USING ERRCODE = 'check_violation';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(user_id::text, 29082027));
  IF action_name = 'reserve' THEN
    IF (reservation_payload->>'status') IS DISTINCT FROM 'reserved'
       OR total_reserved <= 0
       OR (reservation_payload->>'rawEstimatedTokens')::integer <= 0
       OR (reservation_payload->>'quotaMultiplierBps')::integer <= 0
       OR (reservation_payload->>'expiresAt')::timestamp <= (reservation_payload->>'createdAt')::timestamp
       OR (SELECT COALESCE(sum((value->>'reservedTokens')::integer), 0) FROM jsonb_array_elements(allocation_payload)) <> total_reserved THEN
      RAISE EXCEPTION 'invalid platform token reservation request' USING ERRCODE = 'check_violation';
    END IF;
    IF (reservation_payload->>'grantId')::uuid IS DISTINCT FROM
         (SELECT (value->>'grantId')::uuid FROM jsonb_array_elements(allocation_payload) ORDER BY (value->>'ordinal')::integer LIMIT 1)
       OR (SELECT min((value->>'ordinal')::integer) FROM jsonb_array_elements(allocation_payload)) <> 1
       OR (SELECT max((value->>'ordinal')::integer) FROM jsonb_array_elements(allocation_payload)) <> jsonb_array_length(allocation_payload)
       OR (SELECT count(DISTINCT (value->>'ordinal')::integer) FROM jsonb_array_elements(allocation_payload)) <> jsonb_array_length(allocation_payload)
       OR (SELECT count(DISTINCT value->>'grantId') FROM jsonb_array_elements(allocation_payload)) <> jsonb_array_length(allocation_payload) THEN
      RAISE EXCEPTION 'invalid platform token reservation allocation order' USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM "PlatformTokenReservation" WHERE "id" = reservation_id OR ("userId" = user_id AND "callKey" = reservation_payload->>'callKey')) THEN
      RAISE EXCEPTION 'platform token reservation already exists' USING ERRCODE = 'unique_violation';
    END IF;
    FOR item IN SELECT value FROM jsonb_array_elements(allocation_payload) LOOP
      allocation_grant_id := (item->>'grantId')::uuid;
      SELECT * INTO grant_row FROM "PlatformTokenGrant" WHERE "id" = allocation_grant_id FOR UPDATE;
      IF grant_row."id" IS NULL OR grant_row."userId" <> user_id OR grant_row."revokedAt" IS NOT NULL
         OR grant_row."expiresAt" <= (reservation_payload->>'createdAt')::timestamp
         OR grant_row."expiresAt" < (reservation_payload->>'expiresAt')::timestamp
         OR (item->>'reservedTokens')::integer <= 0
         OR grant_row."remainingTokens" < (item->>'reservedTokens')::integer THEN
        RAISE EXCEPTION 'platform token grant is not reservable' USING ERRCODE = 'check_violation';
      END IF;
      UPDATE "PlatformTokenGrant" SET "remainingTokens" = "remainingTokens" - (item->>'reservedTokens')::integer, "updatedAt" = CURRENT_TIMESTAMP
       WHERE "id" = allocation_grant_id;
    END LOOP;
    INSERT INTO "PlatformTokenReservation" (
      "id", "userId", "grantId", "webAiGrantId", "webAiGrantReferenceId", "webAiGrantProjectId", "jobId", "providerConnectionId",
      "callKey", "operation", "modelId", "status", "reservedTokens", "rawEstimatedTokens", "quotaMultiplierBps", "routeSource",
      "routeId", "routeVersion", "routeUpdatedAt", "providerConfigurationVersion", "routeFenceFingerprint", "expiresAt", "createdAt"
    ) VALUES (
      reservation_id, user_id, (reservation_payload->>'grantId')::uuid, NULLIF(reservation_payload->>'webAiGrantId','')::uuid,
      NULLIF(reservation_payload->>'webAiGrantReferenceId','')::uuid, NULLIF(reservation_payload->>'webAiGrantProjectId','')::uuid,
      NULLIF(reservation_payload->>'jobId','')::uuid, NULLIF(reservation_payload->>'providerConnectionId','')::uuid,
      reservation_payload->>'callKey', (reservation_payload->>'operation')::"AiOperation", reservation_payload->>'modelId', 'reserved',
      total_reserved, (reservation_payload->>'rawEstimatedTokens')::integer, (reservation_payload->>'quotaMultiplierBps')::integer,
      NULLIF(reservation_payload->>'routeSource',''), NULLIF(reservation_payload->>'routeId','')::uuid,
      NULLIF(reservation_payload->>'routeVersion','')::integer, NULLIF(reservation_payload->>'routeUpdatedAt','')::timestamp,
      NULLIF(reservation_payload->>'providerConfigurationVersion','')::integer, NULLIF(reservation_payload->>'routeFenceFingerprint',''),
      (reservation_payload->>'expiresAt')::timestamp, (reservation_payload->>'createdAt')::timestamp
    );
    FOR item IN SELECT value FROM jsonb_array_elements(allocation_payload) LOOP
      INSERT INTO "PlatformTokenReservationAllocation" ("id", "reservationId", "grantId", "ordinal", "reservedTokens", "settledTokens", "releasedTokens", "createdAt")
      VALUES ((item->>'id')::uuid, reservation_id, (item->>'grantId')::uuid, (item->>'ordinal')::integer,
              (item->>'reservedTokens')::integer, 0, 0, (reservation_payload->>'createdAt')::timestamp);
    END LOOP;
  ELSE
    SELECT * INTO reservation_row FROM "PlatformTokenReservation" WHERE "id" = reservation_id AND "userId" = user_id FOR UPDATE;
    IF reservation_row."id" IS NULL OR reservation_row."status"::text <> 'reserved' THEN
      RAISE EXCEPTION 'platform token reservation is not mutable' USING ERRCODE = 'check_violation';
    END IF;
    FOR item IN SELECT value FROM jsonb_array_elements(allocation_payload) LOOP
      allocation_id := (item->>'id')::uuid;
      SELECT * INTO allocation_row FROM "PlatformTokenReservationAllocation" WHERE "id" = allocation_id AND "reservationId" = reservation_id FOR UPDATE;
      IF allocation_row."id" IS NULL OR allocation_row."grantId" <> (item->>'grantId')::uuid
         OR allocation_row."reservedTokens" <> (item->>'reservedTokens')::integer
         OR (item->>'settledTokens')::integer < allocation_row."settledTokens"
         OR (item->>'releasedTokens')::integer < allocation_row."releasedTokens"
         OR (item->>'settledTokens')::integer + (item->>'releasedTokens')::integer > allocation_row."reservedTokens" THEN
        RAISE EXCEPTION 'invalid platform token allocation transition' USING ERRCODE = 'check_violation';
      END IF;
      IF (item->>'releasedTokens')::integer > allocation_row."releasedTokens" THEN
        release_deltas := release_deltas || jsonb_build_object(allocation_row."grantId"::text, (item->>'releasedTokens')::integer - allocation_row."releasedTokens");
        UPDATE "PlatformTokenGrant" SET "remainingTokens" = "remainingTokens" + ((item->>'releasedTokens')::integer - allocation_row."releasedTokens"), "updatedAt" = CURRENT_TIMESTAMP
         WHERE "id" = allocation_row."grantId";
      END IF;
      UPDATE "PlatformTokenReservationAllocation" SET "settledTokens" = (item->>'settledTokens')::integer, "releasedTokens" = (item->>'releasedTokens')::integer
       WHERE "id" = allocation_id;
    END LOOP;
    IF action_name = 'settle' THEN
      UPDATE "PlatformTokenReservation" SET "status"='settled', "settledTokens"=(reservation_payload->>'settledTokens')::integer,
        "rawSettledTokens"=(reservation_payload->>'rawSettledTokens')::integer, "settledAt"=(reservation_payload->>'settledAt')::timestamp,
        "reconciliationRequired"=false, "safeErrorCode"=NULL WHERE "id"=reservation_id;
    ELSIF action_name = 'release' THEN
      UPDATE "PlatformTokenReservation" SET "status"='released', "releasedAt"=(reservation_payload->>'releasedAt')::timestamp,
        "reconciliationRequired"=false, "safeErrorCode"=NULL WHERE "id"=reservation_id;
    ELSE
      UPDATE "PlatformTokenReservation" SET "status"='held', "reconciliationRequired"=true,
        "safeErrorCode"=reservation_payload->>'safeErrorCode' WHERE "id"=reservation_id;
    END IF;
  END IF;

  expected_ledger_count := CASE
    WHEN action_name = 'reserve' THEN jsonb_array_length(allocation_payload)
    WHEN action_name = 'hold' THEN jsonb_array_length(allocation_payload)
    WHEN action_name = 'release' THEN (SELECT count(*) FROM jsonb_each_text(release_deltas) WHERE value::integer > 0)
    ELSE jsonb_array_length(allocation_payload) + (SELECT count(*) FROM jsonb_each_text(release_deltas) WHERE value::integer > 0)
  END;
  IF jsonb_array_length(ledger_payload) <> expected_ledger_count THEN
    RAISE EXCEPTION 'platform token ledger evidence count mismatch' USING ERRCODE = 'check_violation';
  END IF;

  FOR ledger_item IN SELECT value FROM jsonb_array_elements(ledger_payload) LOOP
    expected_amount := CASE
      WHEN ledger_item->>'entryKind' = 'reserve' THEN -COALESCE((SELECT (value->>'reservedTokens')::integer FROM jsonb_array_elements(allocation_payload) WHERE value->>'grantId'=ledger_item->>'grantId'), 0)
      WHEN ledger_item->>'entryKind' = 'release' THEN COALESCE((release_deltas->>(ledger_item->>'grantId'))::integer, 0)
      ELSE 0
    END;
    IF (ledger_item->>'userId')::uuid <> user_id OR (ledger_item->>'reservationId')::uuid <> reservation_id
       OR NOT EXISTS (SELECT 1 FROM "PlatformTokenReservationAllocation" a WHERE a."reservationId"=reservation_id AND a."grantId"=(ledger_item->>'grantId')::uuid)
       OR NOT (
         ledger_item->>'entryKind' = action_name
         OR action_name = 'settle' AND ledger_item->>'entryKind' = 'release'
       )
       OR (ledger_item->>'amount')::integer <> expected_amount
       OR (CASE action_name
         WHEN 'reserve' THEN ledger_item->>'reasonCode' IS DISTINCT FROM 'AI_PLATFORM_TOKEN_RESERVED'
         WHEN 'release' THEN ledger_item->>'reasonCode' NOT IN ('AI_PLATFORM_TOKEN_RELEASED','AI_PLATFORM_TOKEN_EXPIRED_RESERVATION_RELEASED')
         WHEN 'settle' THEN ledger_item->>'reasonCode' NOT IN ('AI_PLATFORM_TOKEN_SETTLED','AI_PLATFORM_TOKEN_SETTLE_RELEASE')
         ELSE ledger_item->>'reasonCode' NOT IN ('AI_PLATFORM_TOKEN_USAGE_UNVERIFIED','AI_PROVIDER_CALL_RECONCILIATION_REQUIRED')
       END) THEN
      RAISE EXCEPTION 'invalid platform token ledger evidence' USING ERRCODE = 'check_violation';
    END IF;
    INSERT INTO "PlatformTokenLedgerEntry" ("id","userId","grantId","reservationId","entryKind","amount","usageTokens","reasonCode","callKey","metadata","createdAt","idempotencyKey")
    VALUES ((ledger_item->>'id')::uuid,user_id,(ledger_item->>'grantId')::uuid,reservation_id,(ledger_item->>'entryKind')::"PlatformTokenLedgerEntryKind",
      (ledger_item->>'amount')::integer,NULLIF(ledger_item->>'usageTokens','')::integer,ledger_item->>'reasonCode',reservation_payload->>'callKey',
      COALESCE(ledger_item->'metadata','{}'::jsonb),(ledger_item->>'createdAt')::timestamp,ledger_item->>'idempotencyKey');
  END LOOP;
END;
$$;

DROP FUNCTION "platform_token_runtime_apply"(TEXT, JSONB, JSONB, JSONB);

-- Define the runtime entry point with database-clock and evidence checks.
CREATE OR REPLACE FUNCTION "platform_token_runtime_apply"(
  action_name TEXT,
  reservation_payload JSONB,
  allocation_payload JSONB,
  ledger_payload JSONB
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  reservation_row RECORD;
  allocation_row RECORD;
  grant_row RECORD;
  item JSONB;
  ledger_item JSONB;
  reservation_id UUID;
  user_id UUID;
  allocation_id UUID;
  allocation_grant_id UUID;
  ledger_id UUID;
  clock_now TIMESTAMP(3) := (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3);
  requested_created TIMESTAMP(3);
  requested_expires TIMESTAMP(3);
  canonical_expires TIMESTAMP(3);
  total_reserved INTEGER;
  total_settled INTEGER;
  raw_estimated INTEGER;
  raw_settled INTEGER;
  quota_multiplier INTEGER;
  ordinal_value INTEGER;
  reserved_value INTEGER;
  settled_value INTEGER;
  released_value INTEGER;
  release_delta INTEGER;
  expected_amount INTEGER;
  expected_ledger_count INTEGER;
  ledger_count INTEGER;
  allocation_count BIGINT;
  allocation_total BIGINT;
  allocation_settled_total BIGINT;
  allocation_released_total BIGINT;
  expected_key TEXT;
  call_key TEXT;
  safe_error_code TEXT;
  remaining_to_allocate INTEGER;
  candidate_ordinal INTEGER;
  release_deltas JSONB := '{}'::jsonb;
BEGIN
  IF session_user <> 'ai_project_os_runtime' AND session_user <> current_user THEN
    RAISE EXCEPTION 'platform token runtime function requires runtime principal' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF action_name IS NULL OR action_name NOT IN ('reserve', 'settle', 'release', 'hold') THEN
    RAISE EXCEPTION 'invalid platform token runtime action' USING ERRCODE = 'check_violation';
  END IF;
  IF jsonb_typeof(allocation_payload) IS DISTINCT FROM 'array' OR jsonb_array_length(allocation_payload) = 0
     OR jsonb_typeof(ledger_payload) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'invalid platform token runtime evidence arrays' USING ERRCODE = 'check_violation';
  END IF;

  reservation_id := NULLIF(reservation_payload->>'id', '')::uuid;
  user_id := NULLIF(reservation_payload->>'userId', '')::uuid;
  call_key := reservation_payload->>'callKey';
  IF reservation_id IS NULL OR user_id IS NULL OR call_key IS NULL OR length(call_key) < 8 OR length(call_key) > 128
     OR call_key !~ '^[A-Za-z0-9._:-]+$' THEN
    RAISE EXCEPTION 'invalid platform token runtime reservation identity' USING ERRCODE = 'check_violation';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(user_id::text, 29082027));

  IF action_name = 'reserve' THEN
    total_reserved := NULLIF(reservation_payload->>'reservedTokens', '')::integer;
    raw_estimated := NULLIF(reservation_payload->>'rawEstimatedTokens', '')::integer;
    quota_multiplier := NULLIF(reservation_payload->>'quotaMultiplierBps', '')::integer;
    requested_created := NULLIF(reservation_payload->>'createdAt', '')::timestamp(3);
    requested_expires := NULLIF(reservation_payload->>'expiresAt', '')::timestamp(3);
    IF reservation_payload->>'status' IS DISTINCT FROM 'reserved'
       OR total_reserved IS NULL OR total_reserved <= 0 OR total_reserved > 1000000000
       OR raw_estimated IS NULL OR raw_estimated <= 0 OR raw_estimated > 10000000
       OR quota_multiplier IS NULL OR quota_multiplier < 1 OR quota_multiplier > 100000
       OR total_reserved::bigint <> ((raw_estimated::bigint * quota_multiplier::bigint + 9999) / 10000)
       OR requested_created IS NULL OR requested_expires IS NULL
       OR abs(EXTRACT(EPOCH FROM (requested_created - clock_now))) > 5
       OR requested_expires <= clock_now
       OR requested_expires <= requested_created
       OR requested_expires > clock_now + interval '1 hour'
       OR (SELECT COALESCE(sum((value->>'reservedTokens')::integer), 0) FROM jsonb_array_elements(allocation_payload)) <> total_reserved THEN
      RAISE EXCEPTION 'invalid platform token reservation request' USING ERRCODE = 'check_violation';
    END IF;
    canonical_expires := requested_expires;

    FOR item IN SELECT value FROM jsonb_array_elements(allocation_payload) LOOP
      allocation_id := NULLIF(item->>'id', '')::uuid;
      allocation_grant_id := NULLIF(item->>'grantId', '')::uuid;
      ordinal_value := NULLIF(item->>'ordinal', '')::integer;
      reserved_value := NULLIF(item->>'reservedTokens', '')::integer;
      settled_value := NULLIF(item->>'settledTokens', '')::integer;
      released_value := NULLIF(item->>'releasedTokens', '')::integer;
      IF allocation_id IS NULL OR allocation_grant_id IS NULL OR ordinal_value IS NULL OR ordinal_value <= 0
         OR reserved_value IS NULL OR reserved_value <= 0 OR settled_value IS DISTINCT FROM 0 OR released_value IS DISTINCT FROM 0 THEN
        RAISE EXCEPTION 'invalid platform token reservation allocation' USING ERRCODE = 'check_violation';
      END IF;
    END LOOP;
    IF (SELECT min((value->>'ordinal')::integer) FROM jsonb_array_elements(allocation_payload)) <> 1
       OR (SELECT max((value->>'ordinal')::integer) FROM jsonb_array_elements(allocation_payload)) <> jsonb_array_length(allocation_payload)
       OR (SELECT count(DISTINCT (value->>'ordinal')::integer) FROM jsonb_array_elements(allocation_payload)) <> jsonb_array_length(allocation_payload)
       OR (SELECT count(DISTINCT value->>'grantId') FROM jsonb_array_elements(allocation_payload)) <> jsonb_array_length(allocation_payload)
       OR (reservation_payload->>'grantId')::uuid IS DISTINCT FROM
          (SELECT (value->>'grantId')::uuid FROM jsonb_array_elements(allocation_payload) ORDER BY (value->>'ordinal')::integer LIMIT 1) THEN
      RAISE EXCEPTION 'invalid platform token reservation allocation order' USING ERRCODE = 'check_violation';
    END IF;

    -- Re-derive FIFO admission from the locked user's active grants.  The
    -- runtime caller may provide evidence, but it cannot choose a later grant
    -- while an earlier grant still has usable balance.
    remaining_to_allocate := total_reserved;
    candidate_ordinal := 1;
    FOR grant_row IN
      SELECT "id", "remainingTokens"
        FROM "PlatformTokenGrant"
       WHERE "userId" = user_id AND "revokedAt" IS NULL AND "expiresAt" > clock_now AND "remainingTokens" > 0
       ORDER BY "expiresAt" ASC, "issuedAt" ASC, "id" ASC
       FOR UPDATE
    LOOP
      EXIT WHEN remaining_to_allocate = 0;
      expected_amount := LEAST(grant_row."remainingTokens", remaining_to_allocate);
      IF NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(allocation_payload) AS candidate(value)
         WHERE (candidate.value->>'ordinal')::integer = candidate_ordinal
           AND (candidate.value->>'grantId')::uuid = grant_row."id"
           AND (candidate.value->>'reservedTokens')::integer = expected_amount
      ) THEN
        RAISE EXCEPTION 'platform token reservation allocation is not FIFO' USING ERRCODE = 'check_violation';
      END IF;
      remaining_to_allocate := remaining_to_allocate - expected_amount;
      candidate_ordinal := candidate_ordinal + 1;
    END LOOP;
    IF remaining_to_allocate <> 0 OR candidate_ordinal - 1 <> jsonb_array_length(allocation_payload) THEN
      RAISE EXCEPTION 'platform token reservation allocation is not fully admitted' USING ERRCODE = 'check_violation';
    END IF;

    IF (SELECT count(DISTINCT value->>'id') FROM jsonb_array_elements(ledger_payload)) <> jsonb_array_length(ledger_payload)
       OR (SELECT count(DISTINCT value->>'idempotencyKey') FROM jsonb_array_elements(ledger_payload)) <> jsonb_array_length(ledger_payload)
       OR jsonb_array_length(ledger_payload) <> jsonb_array_length(allocation_payload) THEN
      RAISE EXCEPTION 'platform token reserve ledger evidence is not bijective' USING ERRCODE = 'check_violation';
    END IF;
    FOR ledger_item IN SELECT value FROM jsonb_array_elements(ledger_payload) LOOP
      ledger_id := NULLIF(ledger_item->>'id', '')::uuid;
      IF ledger_id IS NULL THEN
        RAISE EXCEPTION 'platform token reserve ledger evidence id is invalid' USING ERRCODE = 'check_violation';
      END IF;
    END LOOP;
    FOR item IN SELECT value FROM jsonb_array_elements(allocation_payload) LOOP
      allocation_grant_id := (item->>'grantId')::uuid;
      ordinal_value := (item->>'ordinal')::integer;
      reserved_value := (item->>'reservedTokens')::integer;
      expected_key := 'reserve:' || user_id::text || ':' || call_key
        || CASE WHEN ordinal_value = 1 THEN '' ELSE ':allocation:' || ordinal_value::text END;
      SELECT count(*) INTO ledger_count
        FROM jsonb_array_elements(ledger_payload) AS evidence(value)
       WHERE evidence.value->>'userId' = user_id::text
         AND evidence.value->>'reservationId' = reservation_id::text
         AND evidence.value->>'grantId' = allocation_grant_id::text
         AND evidence.value->>'entryKind' = 'reserve'
         AND (evidence.value->>'amount')::integer = -reserved_value
         AND evidence.value->>'usageTokens' IS NULL
         AND evidence.value->>'reasonCode' = 'AI_PLATFORM_TOKEN_RESERVED'
         AND evidence.value->>'idempotencyKey' = expected_key
         AND (evidence.value->'metadata')->>'allocationOrdinal' = ordinal_value::text;
      IF ledger_count <> 1 THEN
        RAISE EXCEPTION 'platform token reserve ledger tuple mismatch' USING ERRCODE = 'check_violation';
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM "PlatformTokenReservation" WHERE "id" = reservation_id)
       OR EXISTS (SELECT 1 FROM "PlatformTokenReservation" WHERE "userId" = user_id AND "callKey" = call_key) THEN
      RAISE EXCEPTION 'platform token reservation already exists' USING ERRCODE = 'unique_violation';
    END IF;

    FOR item IN SELECT value FROM jsonb_array_elements(allocation_payload) ORDER BY (value->>'ordinal')::integer LOOP
      allocation_grant_id := (item->>'grantId')::uuid;
      reserved_value := (item->>'reservedTokens')::integer;
      SELECT * INTO grant_row FROM "PlatformTokenGrant" WHERE "id" = allocation_grant_id FOR UPDATE;
      IF grant_row."id" IS NULL OR grant_row."userId" <> user_id OR grant_row."revokedAt" IS NOT NULL
         OR grant_row."expiresAt" <= clock_now OR grant_row."expiresAt" < canonical_expires
         OR grant_row."remainingTokens" < reserved_value THEN
        RAISE EXCEPTION 'platform token grant is not reservable' USING ERRCODE = 'check_violation';
      END IF;
      UPDATE "PlatformTokenGrant" SET "remainingTokens" = "remainingTokens" - reserved_value, "updatedAt" = clock_now
       WHERE "id" = allocation_grant_id;
    END LOOP;
    INSERT INTO "PlatformTokenReservation" (
      "id", "userId", "grantId", "webAiGrantId", "webAiGrantReferenceId", "webAiGrantProjectId", "jobId", "providerConnectionId",
      "callKey", "operation", "modelId", "status", "reservedTokens", "rawEstimatedTokens", "quotaMultiplierBps", "routeSource",
      "routeId", "routeVersion", "routeUpdatedAt", "providerConfigurationVersion", "routeFenceFingerprint", "expiresAt", "createdAt"
    ) VALUES (
      reservation_id, user_id, (reservation_payload->>'grantId')::uuid, NULLIF(reservation_payload->>'webAiGrantId','')::uuid,
      NULLIF(reservation_payload->>'webAiGrantReferenceId','')::uuid, NULLIF(reservation_payload->>'webAiGrantProjectId','')::uuid,
      NULLIF(reservation_payload->>'jobId','')::uuid, NULLIF(reservation_payload->>'providerConnectionId','')::uuid,
      call_key, (reservation_payload->>'operation')::"AiOperation", reservation_payload->>'modelId', 'reserved',
      total_reserved, raw_estimated, quota_multiplier, NULLIF(reservation_payload->>'routeSource',''),
      NULLIF(reservation_payload->>'routeId','')::uuid, NULLIF(reservation_payload->>'routeVersion','')::integer,
      NULLIF(reservation_payload->>'routeUpdatedAt','')::timestamp, NULLIF(reservation_payload->>'providerConfigurationVersion','')::integer,
      NULLIF(reservation_payload->>'routeFenceFingerprint',''), canonical_expires, clock_now
    );
    FOR item IN SELECT value FROM jsonb_array_elements(allocation_payload) LOOP
      INSERT INTO "PlatformTokenReservationAllocation" ("id", "reservationId", "grantId", "ordinal", "reservedTokens", "settledTokens", "releasedTokens", "createdAt")
      VALUES ((item->>'id')::uuid, reservation_id, (item->>'grantId')::uuid, (item->>'ordinal')::integer,
              (item->>'reservedTokens')::integer, 0, 0, clock_now);
    END LOOP;
  ELSE
    SELECT * INTO reservation_row FROM "PlatformTokenReservation"
     WHERE "id" = reservation_id AND "userId" = user_id FOR UPDATE;
    IF reservation_row."id" IS NULL OR reservation_row."status"::text <> 'reserved'
       OR reservation_row."callKey" <> call_key THEN
      RAISE EXCEPTION 'platform token reservation is not mutable' USING ERRCODE = 'check_violation';
    END IF;
    SELECT count(*), COALESCE(sum("reservedTokens"), 0)
      INTO allocation_count, allocation_total
      FROM "PlatformTokenReservationAllocation" WHERE "reservationId" = reservation_id;
    IF allocation_count <> jsonb_array_length(allocation_payload) OR allocation_total <> reservation_row."reservedTokens"
       OR (SELECT count(DISTINCT value->>'id') FROM jsonb_array_elements(allocation_payload)) <> jsonb_array_length(allocation_payload) THEN
      RAISE EXCEPTION 'platform token runtime allocation evidence is not exact' USING ERRCODE = 'check_violation';
    END IF;

    IF action_name = 'settle' THEN
      total_settled := NULLIF(reservation_payload->>'settledTokens', '')::integer;
      raw_settled := NULLIF(reservation_payload->>'rawSettledTokens', '')::integer;
      quota_multiplier := COALESCE(reservation_row."quotaMultiplierBps", 10000);
      IF total_settled IS NULL OR total_settled < 0 OR total_settled > reservation_row."reservedTokens"
         OR raw_settled IS NULL OR raw_settled < 0 OR raw_settled > 10000000
         OR total_settled::bigint <> ((raw_settled::bigint * quota_multiplier::bigint + 9999) / 10000)
            THEN
        RAISE EXCEPTION 'invalid platform token settlement totals' USING ERRCODE = 'check_violation';
      END IF;
    ELSIF action_name = 'hold' THEN
      safe_error_code := reservation_payload->>'safeErrorCode';
      IF safe_error_code IS NULL OR safe_error_code NOT IN ('AI_PLATFORM_TOKEN_USAGE_UNVERIFIED', 'AI_PROVIDER_CALL_RECONCILIATION_REQUIRED') THEN
        RAISE EXCEPTION 'invalid platform token safe error code' USING ERRCODE = 'check_violation';
      END IF;
    END IF;

    FOR item IN SELECT value FROM jsonb_array_elements(allocation_payload) ORDER BY (value->>'ordinal')::integer LOOP
      allocation_id := NULLIF(item->>'id', '')::uuid;
      allocation_grant_id := NULLIF(item->>'grantId', '')::uuid;
      ordinal_value := NULLIF(item->>'ordinal', '')::integer;
      reserved_value := NULLIF(item->>'reservedTokens', '')::integer;
      settled_value := NULLIF(item->>'settledTokens', '')::integer;
      released_value := NULLIF(item->>'releasedTokens', '')::integer;
      SELECT * INTO allocation_row FROM "PlatformTokenReservationAllocation"
       WHERE "id" = allocation_id AND "reservationId" = reservation_id FOR UPDATE;
      IF allocation_row."id" IS NULL OR allocation_row."grantId" <> allocation_grant_id
         OR allocation_row."ordinal" <> ordinal_value OR allocation_row."reservedTokens" <> reserved_value
         OR settled_value IS NULL OR released_value IS NULL OR settled_value < allocation_row."settledTokens"
         OR released_value < allocation_row."releasedTokens" OR settled_value + released_value > reserved_value THEN
        RAISE EXCEPTION 'invalid platform token allocation transition' USING ERRCODE = 'check_violation';
      END IF;
      IF action_name = 'settle' THEN
        IF settled_value + released_value <> reserved_value THEN
          RAISE EXCEPTION 'settlement allocation must account for every reserved unit' USING ERRCODE = 'check_violation';
        END IF;
        release_delta := released_value - allocation_row."releasedTokens";
        release_deltas := release_deltas || jsonb_build_object(allocation_grant_id::text, release_delta);
      ELSIF action_name = 'release' THEN
        IF settled_value <> allocation_row."settledTokens" OR released_value <> reserved_value THEN
          RAISE EXCEPTION 'release allocation must preserve settled units' USING ERRCODE = 'check_violation';
        END IF;
        release_delta := released_value - allocation_row."releasedTokens";
        release_deltas := release_deltas || jsonb_build_object(allocation_grant_id::text, release_delta);
      ELSIF action_name = 'hold' THEN
        IF settled_value <> allocation_row."settledTokens" OR released_value <> allocation_row."releasedTokens" THEN
          RAISE EXCEPTION 'held allocation cannot transition accounting totals' USING ERRCODE = 'check_violation';
        END IF;
      END IF;
    END LOOP;
    SELECT COALESCE(sum((value->>'settledTokens')::integer), 0), COALESCE(sum((value->>'releasedTokens')::integer), 0)
      INTO allocation_settled_total, allocation_released_total
      FROM jsonb_array_elements(allocation_payload);
    IF action_name = 'settle' AND (allocation_settled_total <> total_settled OR allocation_settled_total + allocation_released_total <> reservation_row."reservedTokens") THEN
      RAISE EXCEPTION 'settlement allocation aggregate mismatch' USING ERRCODE = 'check_violation';
    END IF;

    expected_ledger_count := CASE
      WHEN action_name = 'hold' THEN jsonb_array_length(allocation_payload)
      WHEN action_name = 'release' THEN (SELECT count(*) FROM jsonb_array_elements(allocation_payload) value WHERE ((value->>'releasedTokens')::integer - (SELECT a."releasedTokens" FROM "PlatformTokenReservationAllocation" a WHERE a."id"=(value->>'id')::uuid)) > 0)
      ELSE jsonb_array_length(allocation_payload) + (SELECT count(*) FROM jsonb_array_elements(allocation_payload) value WHERE ((value->>'releasedTokens')::integer - (SELECT a."releasedTokens" FROM "PlatformTokenReservationAllocation" a WHERE a."id"=(value->>'id')::uuid)) > 0)
    END;
    IF (SELECT count(DISTINCT value->>'id') FROM jsonb_array_elements(ledger_payload)) <> jsonb_array_length(ledger_payload)
       OR (SELECT count(DISTINCT value->>'idempotencyKey') FROM jsonb_array_elements(ledger_payload)) <> jsonb_array_length(ledger_payload)
       OR jsonb_array_length(ledger_payload) <> expected_ledger_count THEN
      RAISE EXCEPTION 'platform token ledger evidence count or uniqueness mismatch' USING ERRCODE = 'check_violation';
    END IF;
    FOR ledger_item IN SELECT value FROM jsonb_array_elements(ledger_payload) LOOP
      ledger_id := NULLIF(ledger_item->>'id', '')::uuid;
      IF ledger_id IS NULL THEN
        RAISE EXCEPTION 'platform token ledger evidence id is invalid' USING ERRCODE = 'check_violation';
      END IF;
    END LOOP;
    FOR item IN SELECT value FROM jsonb_array_elements(allocation_payload) ORDER BY (value->>'ordinal')::integer LOOP
      allocation_grant_id := (item->>'grantId')::uuid;
      ordinal_value := (item->>'ordinal')::integer;
      reserved_value := (item->>'reservedTokens')::integer;
      settled_value := (item->>'settledTokens')::integer;
      released_value := (item->>'releasedTokens')::integer;
      release_delta := released_value - (SELECT a."releasedTokens" FROM "PlatformTokenReservationAllocation" a WHERE a."id"=(item->>'id')::uuid);
      IF action_name = 'hold' THEN
        expected_key := 'hold:' || user_id::text || ':' || call_key || CASE WHEN ordinal_value = 1 THEN '' ELSE ':allocation:' || ordinal_value::text END;
        SELECT count(*) INTO ledger_count FROM jsonb_array_elements(ledger_payload) AS evidence(value)
         WHERE evidence.value->>'userId'=user_id::text AND evidence.value->>'reservationId'=reservation_id::text
           AND evidence.value->>'grantId'=allocation_grant_id::text AND evidence.value->>'entryKind'='hold'
           AND (evidence.value->>'amount')::integer=0 AND evidence.value->>'reasonCode'=safe_error_code
           AND evidence.value->>'idempotencyKey'=expected_key AND (evidence.value->'metadata')->>'allocationOrdinal'=ordinal_value::text
           AND (ordinal_value <> 1 OR evidence.value->>'usageTokens' IS NULL OR (evidence.value->>'usageTokens') ~ '^[0-9]+$' AND (evidence.value->>'usageTokens')::integer BETWEEN 0 AND 10000000)
           AND (ordinal_value = 1 OR evidence.value->>'usageTokens' IS NULL);
        IF ledger_count <> 1 THEN RAISE EXCEPTION 'platform token hold ledger tuple mismatch' USING ERRCODE = 'check_violation'; END IF;
      ELSE
        IF action_name = 'settle' THEN
          expected_key := 'settle:' || user_id::text || ':' || call_key || CASE WHEN ordinal_value = 1 THEN '' ELSE ':allocation:' || ordinal_value::text END;
          SELECT count(*) INTO ledger_count FROM jsonb_array_elements(ledger_payload) AS evidence(value)
           WHERE evidence.value->>'userId'=user_id::text AND evidence.value->>'reservationId'=reservation_id::text
             AND evidence.value->>'grantId'=allocation_grant_id::text AND evidence.value->>'entryKind'='settle'
             AND (evidence.value->>'amount')::integer=0 AND evidence.value->>'reasonCode'='AI_PLATFORM_TOKEN_SETTLED'
             AND evidence.value->>'idempotencyKey'=expected_key AND (evidence.value->'metadata')->>'allocationOrdinal'=ordinal_value::text
             AND ((ordinal_value = 1 AND (evidence.value->>'usageTokens') ~ '^[0-9]+$' AND (evidence.value->>'usageTokens')::integer = raw_settled)
               OR (ordinal_value <> 1 AND evidence.value->>'usageTokens' IS NULL));
          IF ledger_count <> 1 THEN RAISE EXCEPTION 'platform token settle ledger tuple mismatch' USING ERRCODE = 'check_violation'; END IF;
        END IF;
        IF release_delta > 0 THEN
          expected_key := 'release:' || user_id::text || ':' || call_key || CASE WHEN ordinal_value = 1 THEN '' ELSE ':allocation:' || ordinal_value::text END;
          SELECT count(*) INTO ledger_count FROM jsonb_array_elements(ledger_payload) AS evidence(value)
           WHERE evidence.value->>'userId'=user_id::text AND evidence.value->>'reservationId'=reservation_id::text
             AND evidence.value->>'grantId'=allocation_grant_id::text AND evidence.value->>'entryKind'='release'
             AND (evidence.value->>'amount')::integer=release_delta AND evidence.value->>'usageTokens' IS NULL
             AND evidence.value->>'reasonCode'=CASE WHEN action_name='settle' THEN 'AI_PLATFORM_TOKEN_SETTLE_RELEASE' ELSE evidence.value->>'reasonCode' END
             AND (action_name='release' AND evidence.value->>'reasonCode' IN ('AI_PLATFORM_TOKEN_RELEASED','AI_PLATFORM_TOKEN_EXPIRED_RESERVATION_RELEASED') OR action_name='settle' AND evidence.value->>'reasonCode'='AI_PLATFORM_TOKEN_SETTLE_RELEASE')
             AND evidence.value->>'idempotencyKey'=expected_key AND (evidence.value->'metadata')->>'allocationOrdinal'=ordinal_value::text;
          IF ledger_count <> 1 THEN RAISE EXCEPTION 'platform token release ledger tuple mismatch' USING ERRCODE = 'check_violation'; END IF;
        END IF;
      END IF;
    END LOOP;

    FOR item IN SELECT value FROM jsonb_array_elements(allocation_payload) LOOP
      allocation_id := (item->>'id')::uuid;
      allocation_grant_id := (item->>'grantId')::uuid;
      settled_value := (item->>'settledTokens')::integer;
      released_value := (item->>'releasedTokens')::integer;
      release_delta := released_value - (SELECT a."releasedTokens" FROM "PlatformTokenReservationAllocation" a WHERE a."id"=allocation_id);
      IF release_delta > 0 THEN
        SELECT * INTO grant_row FROM "PlatformTokenGrant" WHERE "id"=allocation_grant_id FOR UPDATE;
        IF grant_row."id" IS NULL OR grant_row."userId" <> user_id OR grant_row."revokedAt" IS NOT NULL THEN
          RAISE EXCEPTION 'platform token release grant is invalid' USING ERRCODE = 'check_violation';
        END IF;
        UPDATE "PlatformTokenGrant" SET "remainingTokens"="remainingTokens"+release_delta, "updatedAt"=clock_now WHERE "id"=allocation_grant_id;
      END IF;
      UPDATE "PlatformTokenReservationAllocation" SET "settledTokens"=settled_value, "releasedTokens"=released_value WHERE "id"=allocation_id;
    END LOOP;
    IF action_name = 'settle' THEN
      UPDATE "PlatformTokenReservation" SET "status"='settled', "settledTokens"=total_settled, "rawSettledTokens"=raw_settled,
        "settledAt"=clock_now, "reconciliationRequired"=false, "safeErrorCode"=NULL WHERE "id"=reservation_id;
    ELSIF action_name = 'release' THEN
      UPDATE "PlatformTokenReservation" SET "status"='released', "releasedAt"=clock_now,
        "reconciliationRequired"=false, "safeErrorCode"=NULL WHERE "id"=reservation_id;
    ELSE
      UPDATE "PlatformTokenReservation" SET "status"='held', "reconciliationRequired"=true,
        "safeErrorCode"=safe_error_code WHERE "id"=reservation_id;
    END IF;
  END IF;

  FOR ledger_item IN SELECT value FROM jsonb_array_elements(ledger_payload) LOOP
    INSERT INTO "PlatformTokenLedgerEntry" ("id","userId","grantId","reservationId","entryKind","amount","usageTokens","reasonCode","callKey","metadata","createdAt","idempotencyKey")
    VALUES ((ledger_item->>'id')::uuid,user_id,(ledger_item->>'grantId')::uuid,reservation_id,(ledger_item->>'entryKind')::"PlatformTokenLedgerEntryKind",
      (ledger_item->>'amount')::integer,NULLIF(ledger_item->>'usageTokens','')::integer,ledger_item->>'reasonCode',call_key,
      COALESCE(ledger_item->'metadata','{}'::jsonb),clock_now,ledger_item->>'idempotencyKey');
  END LOOP;
END;
$function$;

REVOKE ALL ON FUNCTION "platform_token_runtime_apply"(TEXT, JSONB, JSONB, JSONB) FROM PUBLIC;

CREATE OR REPLACE FUNCTION "platform_token_governance_preview"(preview_payload JSONB)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_row RECORD;
  target_row RECORD;
  grant_row RECORD;
  action_name TEXT := preview_payload->>'action';
  clock_now TIMESTAMP(3) := (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3);
  supplied_issued_at TIMESTAMP(3);
  supplied_preview_expires_at TIMESTAMP(3);
  supplied_created_at TIMESTAMP(3);
BEGIN
  IF (session_user <> 'ai_project_os_entitlement_writer' AND session_user <> current_user)
     OR action_name IS NULL OR action_name NOT IN ('grant','revoke') THEN
    RAISE EXCEPTION 'platform token preview requires writer principal' USING ERRCODE = 'insufficient_privilege';
  END IF;
  supplied_issued_at := NULLIF(preview_payload->>'issuedAt', '')::timestamp(3);
  supplied_preview_expires_at := NULLIF(preview_payload->>'previewExpiresAt', '')::timestamp(3);
  supplied_created_at := NULLIF(preview_payload->>'createdAt', '')::timestamp(3);
  IF supplied_issued_at IS NULL OR supplied_preview_expires_at IS NULL OR supplied_created_at IS NULL
     OR abs(EXTRACT(EPOCH FROM (supplied_issued_at - clock_now))) > 5
     OR abs(EXTRACT(EPOCH FROM (supplied_created_at - clock_now))) > 5
     OR supplied_preview_expires_at IS DISTINCT FROM supplied_issued_at + interval '5 minutes' THEN
    RAISE EXCEPTION 'platform token preview timestamps must use the database clock' USING ERRCODE = 'check_violation';
  END IF;
  SELECT "id","role","disabledAt" INTO actor_row FROM "AppUser" WHERE "id"=(preview_payload->>'actorId')::uuid FOR UPDATE;
  SELECT "id","disabledAt" INTO target_row FROM "AppUser" WHERE "id"=(preview_payload->>'userId')::uuid FOR UPDATE;
  IF actor_row."id" IS NULL OR actor_row."role"::text <> 'admin' OR actor_row."disabledAt" IS NOT NULL OR target_row."id" IS NULL THEN
    RAISE EXCEPTION 'platform token preview actor or target is invalid' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF action_name='grant' AND target_row."disabledAt" IS NOT NULL THEN
    RAISE EXCEPTION 'platform token preview target is disabled' USING ERRCODE = 'check_violation';
  END IF;
  IF action_name='revoke' THEN
    SELECT * INTO grant_row FROM "PlatformTokenGrant" WHERE "id"=(preview_payload->>'grantId')::uuid;
    IF grant_row."id" IS NULL OR grant_row."userId" <> target_row."id" OR grant_row."kind"::text <> 'manual'
       OR grant_row."version" <> (preview_payload->>'expectedVersion')::integer
       OR grant_row."remainingTokens" <> (preview_payload->>'expectedRemainingTokens')::integer THEN
      RAISE EXCEPTION 'platform token preview grant mismatch' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  INSERT INTO "PlatformTokenGrantMutationPreview" (
    "id","actorId","userId","grantId","action","amount","expiresAt","reclaimableTokens","expectedVersion","expectedRemainingTokens",
    "requestKey","reason","impactFingerprint","requestFingerprint","issuedAt","previewExpiresAt","createdAt"
  ) VALUES (
    (preview_payload->>'id')::uuid,(preview_payload->>'actorId')::uuid,(preview_payload->>'userId')::uuid,NULLIF(preview_payload->>'grantId','')::uuid,
    action_name::"PlatformTokenGrantMutationAction",NULLIF(preview_payload->>'amount','')::integer,NULLIF(preview_payload->>'expiresAt','')::timestamp,
    (preview_payload->>'reclaimableTokens')::integer,(preview_payload->>'expectedVersion')::integer,NULLIF(preview_payload->>'expectedRemainingTokens','')::integer,
    preview_payload->>'requestKey',preview_payload->>'reason',preview_payload->>'impactFingerprint',preview_payload->>'requestFingerprint',
    supplied_issued_at,supplied_preview_expires_at,supplied_created_at
  );
END;
$$;
REVOKE ALL ON FUNCTION "platform_token_governance_preview"(JSONB) FROM PUBLIC;

CREATE OR REPLACE FUNCTION "platform_token_governance_apply"(mutation_payload JSONB)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  preview_row RECORD;
  actor_row RECORD;
  target_row RECORD;
  grant_row RECORD;
  action_name TEXT := mutation_payload->>'action';
  grant_id UUID := NULLIF(mutation_payload->>'grantId','')::uuid;
  -- Never trust a caller-supplied transition timestamp.  The preview and
  -- mutation share this transaction-local PostgreSQL clock.
  now_value TIMESTAMP(3) := (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3);
  blocker_count BIGINT;
  before_version INTEGER := 0;
  before_remaining INTEGER := 0;
  before_status TEXT := 'absent';
BEGIN
  IF (session_user <> 'ai_project_os_entitlement_writer' AND session_user <> current_user)
     OR action_name IS NULL OR action_name NOT IN ('grant','revoke') THEN
    RAISE EXCEPTION 'platform token governance requires writer principal' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO preview_row FROM "PlatformTokenGrantMutationPreview" WHERE "id"=(mutation_payload->>'previewId')::uuid FOR UPDATE;
  SELECT "id","role","disabledAt" INTO actor_row FROM "AppUser" WHERE "id"=(mutation_payload->>'actorId')::uuid FOR UPDATE;
  SELECT "id","disabledAt" INTO target_row FROM "AppUser" WHERE "id"=(mutation_payload->>'userId')::uuid FOR UPDATE;
  IF preview_row."id" IS NULL OR preview_row."consumedAt" IS NOT NULL OR preview_row."issuedAt" > now_value OR preview_row."previewExpiresAt" <= now_value
     OR preview_row."actorId" <> actor_row."id" OR preview_row."userId" <> target_row."id" OR preview_row."action"::text <> action_name
     OR preview_row."requestKey" <> mutation_payload->>'requestKey' OR preview_row."requestFingerprint" <> mutation_payload->>'requestFingerprint'
     OR preview_row."impactFingerprint" <> mutation_payload->>'impactFingerprint'
     OR actor_row."role"::text <> 'admin' OR actor_row."disabledAt" IS NOT NULL OR target_row."id" IS NULL THEN
    RAISE EXCEPTION 'platform token governance preview is stale' USING ERRCODE = 'check_violation';
  END IF;
  IF action_name='grant' THEN
    IF target_row."disabledAt" IS NOT NULL OR preview_row."grantId" IS NOT NULL OR preview_row."amount" IS NULL OR preview_row."expiresAt" <= now_value THEN
      RAISE EXCEPTION 'platform token grant preview is invalid' USING ERRCODE = 'check_violation';
    END IF;
    grant_id := (mutation_payload->>'newGrantId')::uuid;
    INSERT INTO "PlatformTokenGrant" ("id","userId","kind","amount","remainingTokens","offerVersion","issuedById","issuedAt","expiresAt","version","createdAt","updatedAt")
    VALUES (grant_id,target_row."id",'manual',preview_row."amount",preview_row."amount",'manual-governance-v1',actor_row."id",now_value,preview_row."expiresAt",1,now_value,now_value);
  ELSE
    SELECT * INTO grant_row FROM "PlatformTokenGrant" WHERE "id"=grant_id FOR UPDATE;
    SELECT count(*) INTO blocker_count FROM "PlatformTokenReservationAllocation" a JOIN "PlatformTokenReservation" r ON r."id"=a."reservationId"
      WHERE a."grantId"=grant_id AND r."status" IN ('reserved','held');
    IF grant_row."id" IS NULL OR grant_row."userId" <> target_row."id" OR grant_row."kind"::text <> 'manual' OR grant_row."revokedAt" IS NOT NULL
       OR grant_row."version" <> preview_row."expectedVersion" OR grant_row."remainingTokens" <> preview_row."expectedRemainingTokens" OR blocker_count <> 0 THEN
      RAISE EXCEPTION 'platform token revoke preview is stale or blocked' USING ERRCODE = 'check_violation';
    END IF;
    before_version := grant_row."version";
    before_remaining := grant_row."remainingTokens";
    before_status := CASE WHEN grant_row."expiresAt" <= now_value THEN 'expired' ELSE 'active' END;
    UPDATE "PlatformTokenGrantMutationPreview" SET "consumedAt"=now_value WHERE "id"=preview_row."id";
    UPDATE "PlatformTokenGrant" SET "remainingTokens"=0,"revokedAt"=now_value,"version"="version"+1,"updatedAt"=now_value WHERE "id"=grant_id;
  END IF;
  IF action_name='grant' THEN
    UPDATE "PlatformTokenGrantMutationPreview" SET "consumedAt"=now_value WHERE "id"=preview_row."id";
  END IF;
  INSERT INTO "PlatformTokenLedgerEntry" ("id","userId","grantId","entryKind","amount","reasonCode","metadata","createdAt","idempotencyKey")
  VALUES ((mutation_payload->>'ledgerId')::uuid,target_row."id",grant_id,
    CASE WHEN action_name='grant' THEN 'grant' ELSE 'adjustment' END::"PlatformTokenLedgerEntryKind",
    CASE WHEN action_name='grant' THEN preview_row."amount" ELSE -before_remaining END,
    CASE WHEN action_name='grant' THEN 'AI_MANUAL_GRANT' ELSE 'AI_MANUAL_GRANT_REVOKED' END,
    '{"governance":"platform-credit-v1"}'::jsonb,now_value,mutation_payload->>'ledgerKey');
  INSERT INTO "PlatformTokenGrantAudit" ("id","grantId","userId","actorId","event","versionBefore","versionAfter","statusBefore","statusAfter","amount","remainingBefore","remainingAfter","previewId","reason","requestKey","requestFingerprint","impactFingerprint","transitionAt","createdAt")
  VALUES ((mutation_payload->>'auditId')::uuid,grant_id,target_row."id",actor_row."id",action_name::"PlatformTokenGrantAuditEvent",
    before_version,before_version+1,before_status,
    CASE WHEN action_name='grant' THEN 'active' ELSE 'revoked' END,
    CASE WHEN action_name='grant' THEN preview_row."amount" ELSE before_remaining END,
    before_remaining,CASE WHEN action_name='grant' THEN preview_row."amount" ELSE 0 END,
    preview_row."id",preview_row."reason",preview_row."requestKey",preview_row."requestFingerprint",preview_row."impactFingerprint",now_value,now_value);
  RETURN grant_id;
END;
$$;
REVOKE ALL ON FUNCTION "platform_token_governance_apply"(JSONB) FROM PUBLIC;
