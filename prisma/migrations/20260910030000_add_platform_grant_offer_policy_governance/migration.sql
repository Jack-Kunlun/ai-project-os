-- ENT-005: versioned, audited platform signup-offer governance.
-- Valid legacy drafts are preserved. Existing active/retired rows, or drafts
-- with terms outside the governed shape, must be reconciled before upgrade;
-- this migration never invents historical actors/timestamps or a default offer.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "PlatformGrantOfferPolicy"
    WHERE "status" IN ('active', 'retired')
       OR "offerVersion" !~ '^[a-z0-9][a-z0-9._-]{2,63}$'
       OR "amount" NOT BETWEEN 1 AND 10000000
       OR "validForDays" NOT BETWEEN 1 AND 3650
       OR "eligibilityKey" <> 'verified_identity_v1'
  ) THEN
    RAISE EXCEPTION 'PLATFORM_GRANT_OFFER_POLICY_LEGACY_RECONCILIATION_REQUIRED'
      USING ERRCODE = 'check_violation';
  END IF;
END
$$;

CREATE TYPE "PlatformGrantOfferPolicyAuditAction" AS ENUM ('created', 'activated', 'retired');

ALTER TABLE "PlatformGrantOfferPolicy"
  ADD COLUMN "activatedById" UUID,
  ADD COLUMN "retiredById" UUID,
  ADD COLUMN "activatedAt" TIMESTAMP(3),
  ADD COLUMN "retiredAt" TIMESTAMP(3),
  ADD COLUMN "mutationTransactionId" UUID;

ALTER TABLE "PlatformGrantOfferPolicy"
  DROP CONSTRAINT "PlatformGrantOfferPolicy_amount_check",
  ADD CONSTRAINT "PlatformGrantOfferPolicy_shape_check" CHECK (
    "offerVersion" ~ '^[a-z0-9][a-z0-9._-]{2,63}$'
    AND "amount" BETWEEN 1 AND 10000000
    AND "validForDays" BETWEEN 1 AND 3650
    AND "eligibilityKey" = 'verified_identity_v1'
    AND (
      ("status" = 'draft'
        AND "activatedAt" IS NULL AND "activatedById" IS NULL
        AND "retiredAt" IS NULL AND "retiredById" IS NULL)
      OR ("status" = 'active'
        AND "activatedAt" IS NOT NULL AND "activatedById" IS NOT NULL
        AND "retiredAt" IS NULL AND "retiredById" IS NULL
        AND "mutationTransactionId" IS NOT NULL)
      OR ("status" = 'retired'
        AND "activatedAt" IS NOT NULL AND "activatedById" IS NOT NULL
        AND "retiredAt" IS NOT NULL AND "retiredById" IS NOT NULL
        AND "mutationTransactionId" IS NOT NULL)
    )
  );

ALTER TABLE "PlatformTokenGrant"
  ADD COLUMN "offerAmount" INTEGER,
  ADD COLUMN "offerValidForDays" INTEGER,
  ADD COLUMN "eligibilityKey" VARCHAR(64),
  ADD COLUMN "eligibilitySource" VARCHAR(32),
  ADD CONSTRAINT "PlatformTokenGrant_offer_snapshot_check" CHECK (
    ("offerAmount" IS NULL AND "offerValidForDays" IS NULL AND "eligibilityKey" IS NULL AND "eligibilitySource" IS NULL)
    OR (
      "offerAmount" = "amount"
      AND "offerAmount" BETWEEN 1 AND 10000000
      AND "offerValidForDays" BETWEEN 1 AND 3650
      AND "eligibilityKey" = 'verified_identity_v1'
      AND "eligibilitySource" IN ('verifiedGithub', 'verifiedOidc')
    )
  );

CREATE TABLE "PlatformGrantOfferPolicyAudit" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "policyId" UUID NOT NULL,
  "action" "PlatformGrantOfferPolicyAuditAction" NOT NULL,
  "statusBefore" "PlatformGrantOfferPolicyStatus",
  "statusAfter" "PlatformGrantOfferPolicyStatus" NOT NULL,
  "offerVersion" VARCHAR(64) NOT NULL,
  "amount" INTEGER NOT NULL,
  "validForDays" INTEGER NOT NULL,
  "eligibilityKey" VARCHAR(64) NOT NULL,
  "reasonRecorded" BOOLEAN NOT NULL,
  "reason" VARCHAR(500),
  "actorId" UUID NOT NULL,
  "transactionId" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PlatformGrantOfferPolicyAudit_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PlatformGrantOfferPolicyAudit_shape_check" CHECK (
    "offerVersion" ~ '^[a-z0-9][a-z0-9._-]{2,63}$'
    AND "amount" BETWEEN 1 AND 10000000
    AND "validForDays" BETWEEN 1 AND 3650
    AND "eligibilityKey" = 'verified_identity_v1'
    AND "reasonRecorded" = ("reason" IS NOT NULL AND length(btrim("reason")) > 0)
    AND "reasonRecorded" = TRUE
    AND (
      ("action" = 'created' AND "statusBefore" IS NULL AND "statusAfter" IN ('draft', 'active'))
      OR ("action" = 'activated' AND "statusBefore" = 'draft' AND "statusAfter" = 'active')
      OR ("action" = 'retired' AND "statusBefore" = 'active' AND "statusAfter" = 'retired')
    )
  ),
  CONSTRAINT "PlatformGrantOfferPolicyAudit_policy_fkey"
    FOREIGN KEY ("policyId") REFERENCES "PlatformGrantOfferPolicy"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "PlatformGrantOfferPolicyAudit_actor_fkey"
    FOREIGN KEY ("actorId") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE
);

CREATE INDEX "PlatformGrantOfferPolicyAudit_policyId_createdAt_idx"
  ON "PlatformGrantOfferPolicyAudit" ("policyId", "createdAt");
CREATE INDEX "PlatformGrantOfferPolicyAudit_actorId_createdAt_idx"
  ON "PlatformGrantOfferPolicyAudit" ("actorId", "createdAt");
CREATE UNIQUE INDEX "PlatformGrantOfferPolicyAudit_policyId_transactionId_key"
  ON "PlatformGrantOfferPolicyAudit" ("policyId", "transactionId");

ALTER TABLE "PlatformGrantOfferPolicy"
  ADD CONSTRAINT "PlatformGrantOfferPolicy_activatedById_fkey"
    FOREIGN KEY ("activatedById") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PlatformGrantOfferPolicy_retiredById_fkey"
    FOREIGN KEY ("retiredById") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION "platform_grant_offer_policy_mutation_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  transaction_id UUID;
  expected_action TEXT;
  expected_before "PlatformGrantOfferPolicyStatus";
  expected_actor_id UUID;
  expected_transition_at TIMESTAMP(3);
BEGIN
  IF current_setting('app.platform_grant_offer_policy_context', true) IS DISTINCT FROM 'service-v1'
     OR COALESCE(current_setting('app.platform_grant_offer_policy_transaction_id', true), '') !~ '^[0-9a-fA-F-]{36}$' THEN
    RAISE EXCEPTION 'platform grant offer policy mutation requires the governed service context'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  transaction_id := current_setting('app.platform_grant_offer_policy_transaction_id', true)::uuid;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" NOT IN ('draft', 'active') THEN
      RAISE EXCEPTION 'invalid platform grant offer policy transition' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."updatedById" IS DISTINCT FROM NEW."createdById"
       OR NEW."createdAt" IS DISTINCT FROM NEW."updatedAt"
       OR (NEW."status" = 'draft' AND (NEW."activatedById" IS NOT NULL OR NEW."activatedAt" IS NOT NULL))
       OR (NEW."status" = 'active' AND (
         NEW."activatedById" IS DISTINCT FROM NEW."createdById"
         OR NEW."activatedAt" IS DISTINCT FROM NEW."createdAt"
       ))
       OR NEW."retiredById" IS NOT NULL
       OR NEW."retiredAt" IS NOT NULL THEN
      RAISE EXCEPTION 'platform grant offer policy creation metadata does not match its lifecycle' USING ERRCODE = 'check_violation';
    END IF;
    expected_action := 'created';
    expected_before := NULL;
    expected_actor_id := NEW."createdById";
    expected_transition_at := NEW."updatedAt";
    NEW."mutationTransactionId" := transaction_id;
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD."id" IS DISTINCT FROM NEW."id"
       OR OLD."offerVersion" IS DISTINCT FROM NEW."offerVersion"
       OR OLD."amount" IS DISTINCT FROM NEW."amount"
       OR OLD."validForDays" IS DISTINCT FROM NEW."validForDays"
       OR OLD."eligibilityKey" IS DISTINCT FROM NEW."eligibilityKey"
       OR OLD."createdById" IS DISTINCT FROM NEW."createdById"
       OR OLD."createdAt" IS DISTINCT FROM NEW."createdAt" THEN
      RAISE EXCEPTION 'platform grant offer policy identity and terms are immutable' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'draft' AND NEW."status" = 'active' THEN
      expected_action := 'activated';
      expected_before := 'draft';
      expected_actor_id := NEW."activatedById";
      IF OLD."activatedById" IS NOT NULL
         OR OLD."activatedAt" IS NOT NULL
         OR OLD."retiredById" IS NOT NULL
         OR OLD."retiredAt" IS NOT NULL
         OR NEW."activatedById" IS NULL
         OR NEW."updatedById" IS DISTINCT FROM NEW."activatedById"
         OR NEW."activatedAt" IS NULL
         OR NEW."activatedAt" IS DISTINCT FROM NEW."updatedAt"
         OR NEW."retiredById" IS NOT NULL
         OR NEW."retiredAt" IS NOT NULL THEN
        RAISE EXCEPTION 'platform grant offer policy activation metadata does not match its lifecycle' USING ERRCODE = 'check_violation';
      END IF;
    ELSIF OLD."status" = 'active' AND NEW."status" = 'retired' THEN
      expected_action := 'retired';
      expected_before := 'active';
      expected_actor_id := NEW."retiredById";
      IF OLD."activatedById" IS NULL
         OR OLD."activatedAt" IS NULL
         OR OLD."retiredById" IS NOT NULL
         OR OLD."retiredAt" IS NOT NULL
         OR NEW."activatedById" IS DISTINCT FROM OLD."activatedById"
         OR NEW."activatedAt" IS DISTINCT FROM OLD."activatedAt"
         OR NEW."retiredById" IS NULL
         OR NEW."updatedById" IS DISTINCT FROM NEW."retiredById"
         OR NEW."retiredAt" IS NULL
         OR NEW."retiredAt" IS DISTINCT FROM NEW."updatedAt" THEN
        RAISE EXCEPTION 'platform grant offer policy retirement metadata does not match its lifecycle' USING ERRCODE = 'check_violation';
      END IF;
    ELSE
      RAISE EXCEPTION 'invalid platform grant offer policy transition' USING ERRCODE = 'check_violation';
    END IF;
    expected_transition_at := NEW."updatedAt";
    NEW."mutationTransactionId" := transaction_id;
  ELSE
    RAISE EXCEPTION 'unsupported platform grant offer policy mutation' USING ERRCODE = 'check_violation';
  END IF;
  IF expected_actor_id IS NULL OR expected_transition_at IS NULL THEN
    RAISE EXCEPTION 'platform grant offer policy transition metadata is required' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM set_config('app.platform_grant_offer_policy_expected_action', expected_action, true);
  PERFORM set_config('app.platform_grant_offer_policy_expected_status_before', COALESCE(expected_before::text, ''), true);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "platform_grant_offer_policy_delete_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'platform grant offer policies cannot be deleted' USING ERRCODE = 'restrict_violation';
  RETURN OLD;
END;
$$;

CREATE TRIGGER "PlatformGrantOfferPolicy_mutation_context_guard"
BEFORE INSERT OR UPDATE ON "PlatformGrantOfferPolicy"
FOR EACH ROW EXECUTE FUNCTION "platform_grant_offer_policy_mutation_guard"();
CREATE TRIGGER "PlatformGrantOfferPolicy_delete_guard"
BEFORE DELETE ON "PlatformGrantOfferPolicy"
FOR EACH ROW EXECUTE FUNCTION "platform_grant_offer_policy_delete_guard"();

CREATE OR REPLACE FUNCTION "platform_grant_offer_policy_audit_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  policy_status "PlatformGrantOfferPolicyStatus";
  policy_offer_version VARCHAR(64);
  policy_amount INTEGER;
  policy_valid_for_days INTEGER;
  policy_eligibility_key VARCHAR(64);
  policy_mutation_transaction_id UUID;
  policy_created_by_id UUID;
  policy_activated_by_id UUID;
  policy_retired_by_id UUID;
  policy_updated_at TIMESTAMP(3);
  transaction_id UUID;
  expected_action TEXT;
  expected_before "PlatformGrantOfferPolicyStatus";
  expected_actor_id UUID;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'platform grant offer policy audits are append-only' USING ERRCODE = 'restrict_violation';
  END IF;
  IF current_setting('app.platform_grant_offer_policy_context', true) IS DISTINCT FROM 'service-v1'
     OR COALESCE(current_setting('app.platform_grant_offer_policy_transaction_id', true), '') !~ '^[0-9a-fA-F-]{36}$' THEN
    RAISE EXCEPTION 'platform grant offer policy audit requires the governed service context'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  transaction_id := current_setting('app.platform_grant_offer_policy_transaction_id', true)::uuid;
  SELECT policy."status", policy."offerVersion", policy."amount", policy."validForDays", policy."eligibilityKey",
         policy."mutationTransactionId", policy."createdById", policy."activatedById", policy."retiredById", policy."updatedAt"
    INTO policy_status, policy_offer_version, policy_amount, policy_valid_for_days, policy_eligibility_key,
         policy_mutation_transaction_id, policy_created_by_id, policy_activated_by_id, policy_retired_by_id, policy_updated_at
    FROM "PlatformGrantOfferPolicy" policy
   WHERE policy."id" = NEW."policyId";
  IF NOT FOUND OR policy_mutation_transaction_id IS DISTINCT FROM transaction_id THEN
    RAISE EXCEPTION 'platform grant offer policy audit is not bound to the current mutation'
      USING ERRCODE = 'check_violation';
  END IF;
  expected_action := current_setting('app.platform_grant_offer_policy_expected_action', true);
  expected_before := NULLIF(current_setting('app.platform_grant_offer_policy_expected_status_before', true), '')::"PlatformGrantOfferPolicyStatus";
  expected_actor_id := CASE expected_action
    WHEN 'created' THEN policy_created_by_id
    WHEN 'activated' THEN policy_activated_by_id
    WHEN 'retired' THEN policy_retired_by_id
    ELSE NULL
  END;
  IF expected_action IS NULL
     OR expected_actor_id IS NULL
     OR NEW."action"::text IS DISTINCT FROM expected_action
     OR NEW."statusBefore" IS DISTINCT FROM expected_before
     OR NEW."statusAfter" IS DISTINCT FROM policy_status
     OR NEW."offerVersion" IS DISTINCT FROM policy_offer_version
     OR NEW."amount" IS DISTINCT FROM policy_amount
     OR NEW."validForDays" IS DISTINCT FROM policy_valid_for_days
     OR NEW."eligibilityKey" IS DISTINCT FROM policy_eligibility_key
     OR NEW."actorId" IS DISTINCT FROM expected_actor_id
     OR NEW."transactionId" IS DISTINCT FROM transaction_id
     OR NEW."createdAt" IS DISTINCT FROM policy_updated_at
     OR NEW."reasonRecorded" IS DISTINCT FROM TRUE
     OR NEW."reason" IS NULL
     OR length(btrim(NEW."reason")) = 0
     OR NEW."reasonRecorded" IS DISTINCT FROM (NEW."reason" IS NOT NULL AND length(btrim(NEW."reason")) > 0) THEN
    RAISE EXCEPTION 'platform grant offer policy audit snapshot does not match the governed mutation'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "PlatformGrantOfferPolicyAudit_append_only_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "PlatformGrantOfferPolicyAudit"
FOR EACH ROW EXECUTE FUNCTION "platform_grant_offer_policy_audit_guard"();

CREATE OR REPLACE FUNCTION "platform_grant_offer_policy_audit_link_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  expected_action "PlatformGrantOfferPolicyAuditAction";
  expected_before "PlatformGrantOfferPolicyStatus";
  expected_actor_id UUID;
  expected_transition_at TIMESTAMP(3);
BEGIN
  IF TG_OP = 'INSERT' THEN
    expected_action := 'created';
    expected_before := NULL;
    expected_actor_id := NEW."createdById";
  ELSIF TG_OP = 'UPDATE' AND OLD."status" = 'draft' AND NEW."status" = 'active' THEN
    expected_action := 'activated';
    expected_before := 'draft';
    expected_actor_id := NEW."activatedById";
  ELSIF TG_OP = 'UPDATE' AND OLD."status" = 'active' AND NEW."status" = 'retired' THEN
    expected_action := 'retired';
    expected_before := 'active';
    expected_actor_id := NEW."retiredById";
  ELSE
    RAISE EXCEPTION 'invalid platform grant offer policy lifecycle' USING ERRCODE = 'check_violation';
  END IF;
  expected_transition_at := NEW."updatedAt";
  IF NEW."mutationTransactionId" IS NULL
     OR NOT EXISTS (
       SELECT 1
       FROM "PlatformGrantOfferPolicyAudit" audit
       WHERE audit."policyId" = NEW."id"
         AND audit."transactionId" = NEW."mutationTransactionId"
         AND audit."action" = expected_action
         AND audit."statusBefore" IS NOT DISTINCT FROM expected_before
         AND audit."statusAfter" = NEW."status"
         AND audit."offerVersion" = NEW."offerVersion"
         AND audit."amount" = NEW."amount"
         AND audit."validForDays" = NEW."validForDays"
         AND audit."eligibilityKey" = NEW."eligibilityKey"
         AND audit."actorId" = expected_actor_id
         AND audit."createdAt" = expected_transition_at
         AND audit."reasonRecorded" IS TRUE
         AND audit."reason" IS NOT NULL
         AND length(btrim(audit."reason")) > 0
     ) THEN
    RAISE EXCEPTION 'platform grant offer policy lifecycle requires a paired audit'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "PlatformGrantOfferPolicy_audit_link_guard"
AFTER INSERT OR UPDATE ON "PlatformGrantOfferPolicy"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "platform_grant_offer_policy_audit_link_guard"();
