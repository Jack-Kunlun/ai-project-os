-- ENT-009: immutable account entitlement activation and governed historical
-- backfill.  This migration never infers a historical identity source and
-- never creates a default offer for an initialized database.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM "PlatformTokenGrant"
     WHERE "kind" = 'signup'
     GROUP BY "userId", "offerVersion"
    HAVING COUNT(*) > 1
  ) OR EXISTS (
    SELECT 1
      FROM "PlatformTokenGrant" grant_row
     WHERE grant_row."kind" = 'signup'
       AND (
         (SELECT COUNT(*) FROM "PlatformTokenLedgerEntry" ledger_row
           WHERE ledger_row."grantId" = grant_row."id" AND ledger_row."entryKind" = 'grant') <> 1
         OR (SELECT COUNT(*) FROM "PlatformTokenLedgerEntry" ledger_row
           WHERE ledger_row."grantId" = grant_row."id"
             AND ledger_row."userId" = grant_row."userId"
             AND ledger_row."entryKind" = 'grant'
             AND ledger_row."amount" = grant_row."amount"
             AND ledger_row."reasonCode" = 'AI_SIGNUP_GRANT'
             AND ledger_row."idempotencyKey" IN (
               'grant:signup:' || grant_row."userId",
               'grant:signup:' || grant_row."userId" || ':' || grant_row."offerVersion"
             )) <> 1
       )
  ) THEN
    RAISE EXCEPTION 'ACCOUNT_ENTITLEMENT_LEGACY_RECONCILIATION_REQUIRED'
      USING ERRCODE = 'check_violation';
  END IF;
END
$$;

DROP INDEX "PlatformTokenGrant_userId_kind_key";
CREATE UNIQUE INDEX "PlatformTokenGrant_userId_offerVersion_signup_key"
  ON "PlatformTokenGrant" ("userId", "offerVersion")
  WHERE "kind" = 'signup';
CREATE INDEX "PlatformTokenGrant_userId_kind_offerVersion_idx"
  ON "PlatformTokenGrant" ("userId", "kind", "offerVersion");

ALTER TABLE "PlatformTokenGrant"
  DROP CONSTRAINT "PlatformTokenGrant_offer_snapshot_check",
  ADD CONSTRAINT "PlatformTokenGrant_offer_snapshot_check" CHECK (
    ("offerAmount" IS NULL AND "offerValidForDays" IS NULL AND "eligibilityKey" IS NULL AND "eligibilitySource" IS NULL)
    OR (
      "offerAmount" = "amount"
      AND "offerAmount" BETWEEN 1 AND 10000000
      AND "offerValidForDays" BETWEEN 1 AND 3650
      AND "eligibilityKey" = 'verified_identity_v1'
      AND "eligibilitySource" IN (
        'bootstrap', 'localProvisioning', 'githubRegistration',
        'oidcRegistration', 'oidcInvitationRegistration',
        'historicalBackfill', 'verifiedGithub', 'verifiedOidc'
      )
    )
  );

CREATE TYPE "AccountEntitlementActivationSource" AS ENUM (
  'bootstrap', 'localProvisioning', 'githubRegistration',
  'oidcRegistration', 'oidcInvitationRegistration', 'historicalBackfill'
);
CREATE TYPE "AccountEntitlementActivationActorKind" AS ENUM ('user', 'system');
CREATE TYPE "AccountEntitlementActivationDecision" AS ENUM ('granted', 'no_active_offer', 'already_issued');
CREATE TYPE "AccountEntitlementActivationStatus" AS ENUM ('granted', 'no_active_offer', 'already_issued');
CREATE TYPE "AccountEntitlementActivationAuditAction" AS ENUM ('created', 'linked');
CREATE TYPE "AccountEntitlementBackfillRunStatus" AS ENUM ('previewed', 'executing', 'completed', 'stale', 'expired', 'failed');
CREATE TYPE "AccountEntitlementBackfillItemClassification" AS ENUM ('already_issued', 'eligible_missing', 'legacy_ambiguous', 'granted', 'skipped');
CREATE TYPE "AccountEntitlementBackfillItemStatus" AS ENUM ('pending', 'applied', 'skipped');
CREATE TYPE "AccountEntitlementBackfillAuditAction" AS ENUM ('previewed', 'confirmed', 'executed', 'stale', 'expired', 'failed');

CREATE TABLE "AccountEntitlementActivation" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "userId" UUID NOT NULL,
  "lifecycleKey" VARCHAR(64) NOT NULL,
  "source" "AccountEntitlementActivationSource" NOT NULL,
  "actorKind" "AccountEntitlementActivationActorKind" NOT NULL,
  "actorId" UUID,
  "actorAccountAccessVersion" INTEGER,
  "accountAccessVersion" INTEGER NOT NULL,
  "evidenceKind" VARCHAR(32),
  "evidenceRefDigest" CHAR(64),
  "policyId" UUID,
  "policyRevision" INTEGER,
  "policyFingerprint" CHAR(64),
  "offerVersion" VARCHAR(64),
  "offerAmount" INTEGER,
  "offerValidForDays" INTEGER,
  "eligibilityKey" VARCHAR(64),
  "grantId" UUID,
  "decision" "AccountEntitlementActivationDecision" NOT NULL,
  "status" "AccountEntitlementActivationStatus" NOT NULL,
  "mutationTransactionId" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AccountEntitlementActivation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AccountEntitlementActivation_shape_check" CHECK (
    "lifecycleKey" = 'initial_account_v1'
    AND "accountAccessVersion" > 0
    AND ("evidenceRefDigest" IS NULL OR "evidenceRefDigest" ~ '^[0-9a-f]{64}$')
    AND (("actorKind" = 'system' AND "actorId" IS NULL AND "actorAccountAccessVersion" IS NULL) OR ("actorKind" = 'user' AND "actorId" IS NOT NULL AND "actorAccountAccessVersion" > 0))
    AND "decision"::text = "status"::text
    AND (
      ("decision" = 'granted'
       AND "policyId" IS NOT NULL AND "policyRevision" > 0 AND "policyFingerprint" ~ '^[0-9a-f]{64}$'
       AND "offerVersion" ~ '^[a-z0-9][a-z0-9._-]{2,63}$'
       AND "offerAmount" BETWEEN 1 AND 10000000
       AND "offerValidForDays" BETWEEN 1 AND 3650
       AND "eligibilityKey" = 'verified_identity_v1'
       AND "grantId" IS NOT NULL)
      OR ("decision" = 'already_issued'
       AND "grantId" IS NOT NULL
       AND "offerVersion" IS NOT NULL
       AND "offerAmount" IS NOT NULL
       AND "offerValidForDays" IS NOT NULL)
      OR ("decision" = 'no_active_offer'
       AND "policyId" IS NULL AND "policyRevision" IS NULL AND "policyFingerprint" IS NULL
       AND "offerVersion" IS NULL AND "offerAmount" IS NULL AND "offerValidForDays" IS NULL
       AND "eligibilityKey" IS NULL AND "grantId" IS NULL)
    )
  ),
  CONSTRAINT "AccountEntitlementActivation_user_fkey"
    FOREIGN KEY ("userId") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "AccountEntitlementActivation_actor_fkey"
    FOREIGN KEY ("actorId") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "AccountEntitlementActivation_policy_fkey"
    FOREIGN KEY ("policyId") REFERENCES "PlatformGrantOfferPolicy"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "AccountEntitlementActivation_grant_fkey"
    FOREIGN KEY ("grantId") REFERENCES "PlatformTokenGrant"("id") ON DELETE NO ACTION ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "AccountEntitlementActivation_userId_lifecycleKey_key"
  ON "AccountEntitlementActivation" ("userId", "lifecycleKey");
CREATE UNIQUE INDEX "AccountEntitlementActivation_grantId_key"
  ON "AccountEntitlementActivation" ("grantId");
CREATE INDEX "AccountEntitlementActivation_source_createdAt_idx"
  ON "AccountEntitlementActivation" ("source", "createdAt");
CREATE INDEX "AccountEntitlementActivation_decision_createdAt_idx"
  ON "AccountEntitlementActivation" ("decision", "createdAt");
CREATE INDEX "AccountEntitlementActivation_actorId_createdAt_idx"
  ON "AccountEntitlementActivation" ("actorId", "createdAt");

CREATE TABLE "AccountEntitlementActivationAudit" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "activationId" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "source" "AccountEntitlementActivationSource" NOT NULL,
  "action" "AccountEntitlementActivationAuditAction" NOT NULL,
  "decision" "AccountEntitlementActivationDecision" NOT NULL,
  "statusAfter" "AccountEntitlementActivationStatus" NOT NULL,
  "actorKind" "AccountEntitlementActivationActorKind" NOT NULL,
  "actorId" UUID,
  "actorAccountAccessVersion" INTEGER,
  "offerVersion" VARCHAR(64),
  "offerAmount" INTEGER,
  "offerValidForDays" INTEGER,
  "eligibilityKey" VARCHAR(64),
  "policyRevision" INTEGER,
  "mutationTransactionId" UUID NOT NULL,
  "transactionId" BIGINT NOT NULL DEFAULT txid_current(),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AccountEntitlementActivationAudit_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AccountEntitlementActivationAudit_shape_check" CHECK (
    "decision"::text = "statusAfter"::text
    AND (("actorKind" = 'system' AND "actorId" IS NULL AND "actorAccountAccessVersion" IS NULL) OR ("actorKind" = 'user' AND "actorId" IS NOT NULL AND "actorAccountAccessVersion" > 0))
    AND (("decision" = 'no_active_offer' AND "offerVersion" IS NULL AND "offerAmount" IS NULL AND "offerValidForDays" IS NULL AND "eligibilityKey" IS NULL)
      OR ("decision" <> 'no_active_offer' AND "offerVersion" IS NOT NULL AND "offerAmount" BETWEEN 1 AND 10000000 AND "offerValidForDays" BETWEEN 1 AND 3650 AND "eligibilityKey" = 'verified_identity_v1'))
  ),
  CONSTRAINT "AccountEntitlementActivationAudit_activation_fkey"
    FOREIGN KEY ("activationId") REFERENCES "AccountEntitlementActivation"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "AccountEntitlementActivationAudit_user_fkey"
    FOREIGN KEY ("userId") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "AccountEntitlementActivationAudit_actor_fkey"
    FOREIGN KEY ("actorId") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE
);
CREATE INDEX "AccountEntitlementActivationAudit_userId_createdAt_idx"
  ON "AccountEntitlementActivationAudit" ("userId", "createdAt");
CREATE INDEX "AccountEntitlementActivationAudit_source_createdAt_idx"
  ON "AccountEntitlementActivationAudit" ("source", "createdAt");
CREATE INDEX "AccountEntitlementActivationAudit_actorId_createdAt_idx"
  ON "AccountEntitlementActivationAudit" ("actorId", "createdAt");
CREATE UNIQUE INDEX "AccountEntitlementActivationAudit_activationId_key"
  ON "AccountEntitlementActivationAudit" ("activationId");

CREATE UNIQUE INDEX "PlatformTokenLedgerEntry_signup_grant_key"
  ON "PlatformTokenLedgerEntry" ("grantId")
  WHERE "grantId" IS NOT NULL
    AND "entryKind" = 'grant'
    AND "reasonCode" = 'AI_SIGNUP_GRANT';

CREATE TABLE "AccountEntitlementBackfillRun" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "actorId" UUID NOT NULL,
  "actorAccountAccessVersion" INTEGER NOT NULL,
  "status" "AccountEntitlementBackfillRunStatus" NOT NULL,
  "snapshotAt" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "candidateCount" INTEGER NOT NULL,
  "alreadyIssuedCount" INTEGER NOT NULL,
  "eligibleMissingCount" INTEGER NOT NULL,
  "legacyAmbiguousCount" INTEGER NOT NULL,
  "grantedCount" INTEGER NOT NULL DEFAULT 0,
  "skippedCount" INTEGER NOT NULL DEFAULT 0,
  "activePolicyId" UUID,
  "activePolicyRevision" INTEGER,
  "activePolicyFingerprint" CHAR(64),
  "activeOfferVersion" VARCHAR(64),
  "activeOfferAmount" INTEGER,
  "activeOfferValidForDays" INTEGER,
  "impactFingerprint" CHAR(64) NOT NULL,
  "requestKey" CHAR(36),
  "reason" VARCHAR(500),
  "confirmedAt" TIMESTAMP(3),
  "consumedAt" TIMESTAMP(3),
  "executedAt" TIMESTAMP(3),
  "mutationTransactionId" UUID,
  "transitionAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AccountEntitlementBackfillRun_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AccountEntitlementBackfillRun_shape_check" CHECK (
    "actorAccountAccessVersion" > 0
    AND "expiresAt" > "snapshotAt"
    AND "candidateCount" >= 0 AND "alreadyIssuedCount" >= 0
    AND "eligibleMissingCount" >= 0 AND "legacyAmbiguousCount" >= 0
    AND "grantedCount" >= 0 AND "skippedCount" >= 0
    AND "candidateCount" = "alreadyIssuedCount" + "eligibleMissingCount" + "legacyAmbiguousCount"
    AND "impactFingerprint" ~ '^[0-9a-f]{64}$'
    AND ("requestKey" IS NULL OR "requestKey" ~ '^[0-9a-fA-F-]{36}$')
    AND (
      ("activePolicyId" IS NULL AND "activePolicyRevision" IS NULL AND "activePolicyFingerprint" IS NULL
       AND "activeOfferVersion" IS NULL AND "activeOfferAmount" IS NULL AND "activeOfferValidForDays" IS NULL)
      OR ("activePolicyId" IS NOT NULL AND "activePolicyRevision" > 0 AND "activePolicyFingerprint" ~ '^[0-9a-f]{64}$'
       AND "activeOfferVersion" ~ '^[a-z0-9][a-z0-9._-]{2,63}$'
       AND "activeOfferAmount" BETWEEN 1 AND 10000000 AND "activeOfferValidForDays" BETWEEN 1 AND 3650)
    )
    AND (
      ("status" = 'previewed' AND "requestKey" IS NULL AND "reason" IS NULL AND "confirmedAt" IS NULL AND "consumedAt" IS NULL AND "executedAt" IS NULL)
      OR ("status" = 'executing' AND "requestKey" IS NOT NULL AND "reason" IS NOT NULL AND length(btrim("reason")) > 0 AND "confirmedAt" IS NOT NULL AND "consumedAt" IS NOT NULL AND "executedAt" IS NULL)
      OR ("status" = 'completed' AND "requestKey" IS NOT NULL AND "reason" IS NOT NULL AND length(btrim("reason")) > 0 AND "confirmedAt" IS NOT NULL AND "consumedAt" IS NOT NULL AND "executedAt" IS NOT NULL)
      OR ("status" IN ('stale', 'expired', 'failed'))
    )
  ),
  CONSTRAINT "AccountEntitlementBackfillRun_actor_fkey"
    FOREIGN KEY ("actorId") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "AccountEntitlementBackfillRun_policy_fkey"
    FOREIGN KEY ("activePolicyId") REFERENCES "PlatformGrantOfferPolicy"("id") ON DELETE NO ACTION ON UPDATE CASCADE
);
CREATE INDEX "AccountEntitlementBackfillRun_actorId_createdAt_idx"
  ON "AccountEntitlementBackfillRun" ("actorId", "createdAt");
CREATE INDEX "AccountEntitlementBackfillRun_status_expiresAt_idx"
  ON "AccountEntitlementBackfillRun" ("status", "expiresAt");
CREATE UNIQUE INDEX "AccountEntitlementBackfillRun_actorId_requestKey_key"
  ON "AccountEntitlementBackfillRun" ("actorId", "requestKey");

CREATE TABLE "AccountEntitlementBackfillItem" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "runId" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "accountAccessVersion" INTEGER NOT NULL,
  "classification" "AccountEntitlementBackfillItemClassification" NOT NULL,
  "status" "AccountEntitlementBackfillItemStatus" NOT NULL DEFAULT 'pending',
  "evidenceKind" VARCHAR(32),
  "evidenceRefDigest" CHAR(64),
  "existingGrantId" UUID,
  "resultGrantId" UUID,
  "activationId" UUID,
  "skipCode" VARCHAR(64),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AccountEntitlementBackfillItem_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AccountEntitlementBackfillItem_shape_check" CHECK (
    "accountAccessVersion" > 0
    AND ("evidenceRefDigest" IS NULL OR "evidenceRefDigest" ~ '^[0-9a-f]{64}$')
    AND (
      ("status" = 'pending' AND (
        ("classification" = 'already_issued')
        OR ("classification" = 'eligible_missing' AND "activationId" IS NOT NULL)
        OR ("classification" = 'legacy_ambiguous' AND "activationId" IS NULL)
      ))
      OR ("status" = 'applied' AND "activationId" IS NOT NULL AND "resultGrantId" IS NOT NULL AND "skipCode" IS NULL)
      OR ("status" = 'skipped' AND "resultGrantId" IS NULL AND "skipCode" IS NOT NULL AND length(btrim("skipCode")) > 0)
    )
  ),
  CONSTRAINT "AccountEntitlementBackfillItem_run_fkey"
    FOREIGN KEY ("runId") REFERENCES "AccountEntitlementBackfillRun"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AccountEntitlementBackfillItem_user_fkey"
    FOREIGN KEY ("userId") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "AccountEntitlementBackfillItem_grant_fkey"
    FOREIGN KEY ("existingGrantId") REFERENCES "PlatformTokenGrant"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "AccountEntitlementBackfillItem_result_grant_fkey"
    FOREIGN KEY ("resultGrantId") REFERENCES "PlatformTokenGrant"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "AccountEntitlementBackfillItem_activation_fkey"
    FOREIGN KEY ("activationId") REFERENCES "AccountEntitlementActivation"("id") ON DELETE NO ACTION ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "AccountEntitlementBackfillItem_runId_userId_key"
  ON "AccountEntitlementBackfillItem" ("runId", "userId");
CREATE INDEX "AccountEntitlementBackfillItem_runId_classification_status_idx"
  ON "AccountEntitlementBackfillItem" ("runId", "classification", "status");
CREATE INDEX "AccountEntitlementBackfillItem_userId_createdAt_idx"
  ON "AccountEntitlementBackfillItem" ("userId", "createdAt");

CREATE TABLE "AccountEntitlementBackfillAudit" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "runId" UUID NOT NULL,
  "action" "AccountEntitlementBackfillAuditAction" NOT NULL,
  "statusBefore" "AccountEntitlementBackfillRunStatus",
  "statusAfter" "AccountEntitlementBackfillRunStatus" NOT NULL,
  "actorId" UUID NOT NULL,
  "reasonRecorded" BOOLEAN NOT NULL DEFAULT FALSE,
  "transactionId" BIGINT NOT NULL DEFAULT txid_current(),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AccountEntitlementBackfillAudit_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AccountEntitlementBackfillAudit_shape_check" CHECK (
    "reasonRecorded" = FALSE OR "reasonRecorded" = TRUE
  ),
  CONSTRAINT "AccountEntitlementBackfillAudit_run_fkey"
    FOREIGN KEY ("runId") REFERENCES "AccountEntitlementBackfillRun"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AccountEntitlementBackfillAudit_actor_fkey"
    FOREIGN KEY ("actorId") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "AccountEntitlementBackfillAudit_runId_action_transactionId_key"
  ON "AccountEntitlementBackfillAudit" ("runId", "action", "transactionId");
CREATE INDEX "AccountEntitlementBackfillAudit_actorId_createdAt_idx"
  ON "AccountEntitlementBackfillAudit" ("actorId", "createdAt");
CREATE INDEX "AccountEntitlementBackfillAudit_runId_createdAt_idx"
  ON "AccountEntitlementBackfillAudit" ("runId", "createdAt");

CREATE OR REPLACE FUNCTION "account_entitlement_activation_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  mutation_id UUID;
  grant_row RECORD;
  ledger_row RECORD;
  user_row RECORD;
  actor_row RECORD;
  policy_row RECORD;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'account entitlement activations are immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF current_setting('app.account_entitlement_activation_context', true) IS DISTINCT FROM 'service-v1'
     OR COALESCE(current_setting('app.account_entitlement_activation_transaction_id', true), '') !~ '^[0-9a-fA-F-]{36}$' THEN
    RAISE EXCEPTION 'account entitlement activation requires governed service context' USING ERRCODE = 'insufficient_privilege';
  END IF;
  mutation_id := current_setting('app.account_entitlement_activation_transaction_id', true)::uuid;
  SELECT "id", "disabledAt", "accountAccessVersion" INTO user_row
    FROM "AppUser" WHERE "id" = NEW."userId" FOR KEY SHARE;
  IF NOT FOUND OR user_row."disabledAt" IS NOT NULL
     OR user_row."accountAccessVersion" IS DISTINCT FROM NEW."accountAccessVersion" THEN
    RAISE EXCEPTION 'account entitlement activation user epoch mismatch' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."actorKind" = 'user' THEN
    SELECT "id", "disabledAt", "accountAccessVersion" INTO actor_row
      FROM "AppUser" WHERE "id" = NEW."actorId" FOR KEY SHARE;
    IF NOT FOUND OR actor_row."disabledAt" IS NOT NULL
       OR actor_row."accountAccessVersion" IS DISTINCT FROM NEW."actorAccountAccessVersion" THEN
      RAISE EXCEPTION 'account entitlement activation actor is invalid' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."actorAccountAccessVersion" IS NOT NULL THEN
    RAISE EXCEPTION 'system entitlement activation cannot carry actor epoch' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."decision"::text <> NEW."status"::text THEN
    RAISE EXCEPTION 'account entitlement activation status does not match decision' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."decision" <> 'no_active_offer' THEN
    SELECT * INTO grant_row FROM "PlatformTokenGrant" WHERE "id" = NEW."grantId" AND "userId" = NEW."userId" AND "kind" = 'signup';
    IF NOT FOUND
       OR grant_row."offerVersion" IS DISTINCT FROM NEW."offerVersion"
       OR (
         grant_row."offerAmount" IS NOT NULL
         AND (
           grant_row."amount" IS DISTINCT FROM NEW."offerAmount"
           OR grant_row."offerAmount" IS DISTINCT FROM NEW."offerAmount"
           OR grant_row."offerValidForDays" IS DISTINCT FROM NEW."offerValidForDays"
           OR grant_row."eligibilityKey" IS DISTINCT FROM NEW."eligibilityKey"
         )
       )
       OR (
         grant_row."offerAmount" IS NULL
         AND (
           grant_row."amount" IS DISTINCT FROM NEW."offerAmount"
           OR NEW."eligibilityKey" IS DISTINCT FROM 'verified_identity_v1'
           OR NEW."offerValidForDays" IS DISTINCT FROM FLOOR(EXTRACT(EPOCH FROM (grant_row."expiresAt" - grant_row."issuedAt")) / 86400)::integer
         )
       ) THEN
      RAISE EXCEPTION 'account entitlement activation grant snapshot mismatch' USING ERRCODE = 'check_violation';
    END IF;
    SELECT * INTO ledger_row
      FROM "PlatformTokenLedgerEntry"
     WHERE "grantId" = NEW."grantId"
       AND "userId" = NEW."userId"
       AND "entryKind" = 'grant'
       AND "amount" = grant_row."amount"
       AND "reasonCode" = 'AI_SIGNUP_GRANT'
       AND "reservationId" IS NULL
       AND "idempotencyKey" IN (
         'grant:signup:' || NEW."userId",
         'grant:signup:' || NEW."userId" || ':' || grant_row."offerVersion"
       )
     LIMIT 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'account entitlement activation grant ledger mismatch' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."decision" = 'granted'
       AND (grant_row."issuedAt" IS DISTINCT FROM NEW."createdAt"
         OR grant_row."expiresAt" IS DISTINCT FROM grant_row."issuedAt" + (NEW."offerValidForDays" * INTERVAL '1 day')) THEN
      RAISE EXCEPTION 'account entitlement activation grant time mismatch' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."policyId" IS NOT NULL THEN
    SELECT * INTO policy_row FROM "PlatformGrantOfferPolicy" WHERE "id" = NEW."policyId";
    IF NOT FOUND
       OR policy_row."offerVersion" IS DISTINCT FROM NEW."offerVersion"
       OR policy_row."amount" IS DISTINCT FROM NEW."offerAmount"
       OR policy_row."validForDays" IS DISTINCT FROM NEW."offerValidForDays"
       OR policy_row."eligibilityKey" IS DISTINCT FROM NEW."eligibilityKey"
       OR (NEW."decision" = 'granted' AND policy_row."status" IS DISTINCT FROM 'active') THEN
      RAISE EXCEPTION 'account entitlement activation policy snapshot mismatch' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  NEW."mutationTransactionId" := mutation_id;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "account_entitlement_activation_delete_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'account entitlement activations cannot be deleted' USING ERRCODE = 'restrict_violation';
  RETURN OLD;
END;
$$;

CREATE TRIGGER "AccountEntitlementActivation_mutation_guard"
BEFORE INSERT OR UPDATE ON "AccountEntitlementActivation"
FOR EACH ROW EXECUTE FUNCTION "account_entitlement_activation_guard"();
CREATE TRIGGER "AccountEntitlementActivation_delete_guard"
BEFORE DELETE ON "AccountEntitlementActivation"
FOR EACH ROW EXECUTE FUNCTION "account_entitlement_activation_delete_guard"();

CREATE OR REPLACE FUNCTION "account_entitlement_signup_grant_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD."kind" = 'signup' THEN
    RAISE EXCEPTION 'account entitlement signup grants cannot be deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND (OLD."kind" = 'signup' OR NEW."kind" = 'signup')
     AND (
       OLD."userId" IS DISTINCT FROM NEW."userId"
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
     ) THEN
    RAISE EXCEPTION 'account entitlement signup grant snapshot is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "AccountEntitlementSignupGrant_immutable_guard"
BEFORE UPDATE OR DELETE ON "PlatformTokenGrant"
FOR EACH ROW EXECUTE FUNCTION "account_entitlement_signup_grant_guard"();

CREATE OR REPLACE FUNCTION "account_entitlement_signup_ledger_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (TG_OP = 'UPDATE' OR TG_OP = 'DELETE')
     AND ((OLD."entryKind" = 'grant' AND OLD."reasonCode" = 'AI_SIGNUP_GRANT')
       OR (TG_OP = 'UPDATE' AND NEW."entryKind" = 'grant' AND NEW."reasonCode" = 'AI_SIGNUP_GRANT')) THEN
    RAISE EXCEPTION 'account entitlement signup ledger entries are append-only' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "AccountEntitlementSignupLedger_append_only_guard"
BEFORE UPDATE OR DELETE ON "PlatformTokenLedgerEntry"
FOR EACH ROW EXECUTE FUNCTION "account_entitlement_signup_ledger_guard"();

CREATE OR REPLACE FUNCTION "account_entitlement_signup_grant_has_closure"(p_grant_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  grant_row RECORD;
  ledger_row RECORD;
BEGIN
  SELECT * INTO grant_row
    FROM "PlatformTokenGrant"
   WHERE "id" = p_grant_id
     AND "kind" = 'signup';
  IF NOT FOUND
     OR grant_row."offerAmount" IS DISTINCT FROM grant_row."amount"
     OR grant_row."createdAt" IS DISTINCT FROM grant_row."issuedAt"
     OR grant_row."offerValidForDays" IS NULL
     OR grant_row."eligibilityKey" IS DISTINCT FROM 'verified_identity_v1'
     OR grant_row."eligibilitySource" IS NULL THEN
    RETURN FALSE;
  END IF;

  SELECT * INTO ledger_row
    FROM "PlatformTokenLedgerEntry"
   WHERE "grantId" = grant_row."id"
     AND "userId" = grant_row."userId"
     AND "entryKind" = 'grant'
     AND "amount" = grant_row."amount"
     AND "reasonCode" = 'AI_SIGNUP_GRANT'
     AND "reservationId" IS NULL
     AND "callKey" IS NULL
     AND "idempotencyKey" = 'grant:signup:' || grant_row."userId" || ':' || grant_row."offerVersion"
     AND "metadata" ->> 'offerVersion' = grant_row."offerVersion"
     AND "metadata" ->> 'eligibilityKey' = grant_row."eligibilityKey"
     AND "metadata" ->> 'eligibilitySource' = grant_row."eligibilitySource"
     AND "createdAt" = grant_row."issuedAt";
  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM "AccountEntitlementActivation" activation
      JOIN "AccountEntitlementActivationAudit" audit ON audit."activationId" = activation."id"
     WHERE activation."grantId" = grant_row."id"
       AND activation."userId" = grant_row."userId"
       AND activation."decision" = 'granted'
       AND activation."status" = 'granted'
       AND grant_row."createdAt" = grant_row."issuedAt"
       AND grant_row."issuedById" IS NOT DISTINCT FROM activation."actorId"
       AND grant_row."eligibilitySource" = activation."source"::text
       AND activation."offerVersion" = grant_row."offerVersion"
       AND activation."offerAmount" = grant_row."amount"
       AND activation."offerValidForDays" = grant_row."offerValidForDays"
       AND activation."eligibilityKey" = grant_row."eligibilityKey"
       AND activation."createdAt" = grant_row."issuedAt"
       AND audit."userId" = activation."userId"
       AND audit."source" = activation."source"
       AND audit."action" = 'created'
       AND audit."decision" = 'granted'
       AND audit."statusAfter" = 'granted'
       AND audit."actorKind" = activation."actorKind"
       AND audit."actorId" IS NOT DISTINCT FROM activation."actorId"
       AND audit."actorAccountAccessVersion" IS NOT DISTINCT FROM activation."actorAccountAccessVersion"
       AND audit."offerVersion" IS NOT DISTINCT FROM activation."offerVersion"
       AND audit."offerAmount" IS NOT DISTINCT FROM activation."offerAmount"
       AND audit."offerValidForDays" IS NOT DISTINCT FROM activation."offerValidForDays"
       AND audit."eligibilityKey" IS NOT DISTINCT FROM activation."eligibilityKey"
       AND audit."policyRevision" IS NOT DISTINCT FROM activation."policyRevision"
       AND audit."mutationTransactionId" = activation."mutationTransactionId"
       AND audit."createdAt" = activation."createdAt"
       AND audit."transactionId" = txid_current()
  ) THEN
    RETURN TRUE;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM "AccountEntitlementBackfillItem" item
      JOIN "AccountEntitlementBackfillRun" run ON run."id" = item."runId"
      JOIN "AccountEntitlementActivation" activation ON activation."id" = item."activationId"
      JOIN "AccountEntitlementActivationAudit" activation_audit ON activation_audit."activationId" = activation."id"
      JOIN "PlatformGrantOfferPolicy" policy ON policy."id" = run."activePolicyId"
      JOIN "AppUser" actor ON actor."id" = run."actorId"
     WHERE item."resultGrantId" = grant_row."id"
       AND item."userId" = grant_row."userId"
       AND item."classification" = 'eligible_missing'
       AND item."status" = 'applied'
       AND activation."userId" = item."userId"
       AND activation."accountAccessVersion" = item."accountAccessVersion"
       AND activation."decision" = 'no_active_offer'
       AND activation."status" = 'no_active_offer'
       AND activation_audit."userId" = activation."userId"
       AND activation_audit."source" = activation."source"
       AND activation_audit."action" = 'created'
       AND activation_audit."decision" = 'no_active_offer'
       AND activation_audit."statusAfter" = 'no_active_offer'
       AND activation_audit."actorKind" = activation."actorKind"
       AND activation_audit."actorId" IS NOT DISTINCT FROM activation."actorId"
       AND activation_audit."actorAccountAccessVersion" IS NOT DISTINCT FROM activation."actorAccountAccessVersion"
       AND activation_audit."offerVersion" IS NULL
       AND activation_audit."offerAmount" IS NULL
       AND activation_audit."offerValidForDays" IS NULL
       AND activation_audit."eligibilityKey" IS NULL
       AND activation_audit."policyRevision" IS NULL
       AND activation_audit."mutationTransactionId" = activation."mutationTransactionId"
       AND activation_audit."createdAt" = activation."createdAt"
       AND run."status" IN ('executing', 'completed')
       AND run."requestKey" IS NOT NULL
       AND run."reason" IS NOT NULL
       AND length(btrim(run."reason")) > 0
       AND run."confirmedAt" IS NOT NULL
       AND run."consumedAt" = run."confirmedAt"
       AND run."confirmedAt" < run."expiresAt"
       AND (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) < run."expiresAt"
       AND run."actorAccountAccessVersion" > 0
       AND actor."role" = 'admin'
       AND actor."disabledAt" IS NULL
       AND actor."accountAccessVersion" = run."actorAccountAccessVersion"
       AND grant_row."eligibilitySource" = 'historicalBackfill'
       AND grant_row."issuedById" = run."actorId"
       AND grant_row."issuedAt" = run."confirmedAt"
       AND grant_row."offerVersion" = run."activeOfferVersion"
       AND grant_row."amount" = run."activeOfferAmount"
       AND grant_row."offerValidForDays" = run."activeOfferValidForDays"
       AND policy."offerVersion" = run."activeOfferVersion"
       AND policy."amount" = run."activeOfferAmount"
       AND policy."validForDays" = run."activeOfferValidForDays"
       AND policy."eligibilityKey" = grant_row."eligibilityKey"
       AND grant_row."expiresAt" = run."confirmedAt" + (run."activeOfferValidForDays" * INTERVAL '1 day')
  ) THEN
    RETURN TRUE;
  END IF;
  RETURN FALSE;
END;
$$;

CREATE OR REPLACE FUNCTION "account_entitlement_signup_grant_insert_link_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."kind" = 'signup' AND NOT "account_entitlement_signup_grant_has_closure"(NEW."id") THEN
    RAISE EXCEPTION 'account entitlement signup grant requires canonical activation or backfill closure' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "AccountEntitlementSignupGrant_insert_link_guard"
AFTER INSERT ON "PlatformTokenGrant"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "account_entitlement_signup_grant_insert_link_guard"();

CREATE OR REPLACE FUNCTION "account_entitlement_signup_ledger_insert_link_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."entryKind" = 'grant'
     AND NEW."reasonCode" = 'AI_SIGNUP_GRANT'
     AND NOT "account_entitlement_signup_grant_has_closure"(NEW."grantId") THEN
    RAISE EXCEPTION 'account entitlement signup ledger requires canonical grant closure' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "AccountEntitlementSignupLedger_insert_link_guard"
AFTER INSERT ON "PlatformTokenLedgerEntry"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "account_entitlement_signup_ledger_insert_link_guard"();

CREATE OR REPLACE FUNCTION "account_entitlement_activation_audit_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  activation_row RECORD;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'account entitlement activation audits are append-only' USING ERRCODE = 'restrict_violation';
  END IF;
  IF current_setting('app.account_entitlement_activation_context', true) IS DISTINCT FROM 'service-v1' THEN
    RAISE EXCEPTION 'account entitlement activation audit requires governed service context' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO activation_row FROM "AccountEntitlementActivation" WHERE "id" = NEW."activationId";
  IF NOT FOUND
     OR activation_row."mutationTransactionId" IS DISTINCT FROM current_setting('app.account_entitlement_activation_transaction_id', true)::uuid
     OR NEW."userId" IS DISTINCT FROM activation_row."userId"
     OR NEW."source" IS DISTINCT FROM activation_row."source"
     OR NEW."decision" IS DISTINCT FROM activation_row."decision"
     OR NEW."statusAfter" IS DISTINCT FROM activation_row."status"
     OR NEW."actorKind" IS DISTINCT FROM activation_row."actorKind"
     OR NEW."actorId" IS DISTINCT FROM activation_row."actorId"
     OR NEW."actorAccountAccessVersion" IS DISTINCT FROM activation_row."actorAccountAccessVersion"
     OR NEW."offerVersion" IS DISTINCT FROM activation_row."offerVersion"
     OR NEW."offerAmount" IS DISTINCT FROM activation_row."offerAmount"
     OR NEW."offerValidForDays" IS DISTINCT FROM activation_row."offerValidForDays"
     OR NEW."eligibilityKey" IS DISTINCT FROM activation_row."eligibilityKey"
     OR NEW."policyRevision" IS DISTINCT FROM activation_row."policyRevision"
     OR NEW."mutationTransactionId" IS DISTINCT FROM activation_row."mutationTransactionId"
     OR NEW."transactionId" IS DISTINCT FROM txid_current()
     OR NEW."createdAt" IS DISTINCT FROM activation_row."createdAt"
     OR NEW."action" IS DISTINCT FROM (
       CASE
         WHEN activation_row."decision" = 'already_issued' THEN 'linked'::"AccountEntitlementActivationAuditAction"
         ELSE 'created'::"AccountEntitlementActivationAuditAction"
       END
     ) THEN
    RAISE EXCEPTION 'account entitlement activation audit snapshot mismatch' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "AccountEntitlementActivationAudit_append_only_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "AccountEntitlementActivationAudit"
FOR EACH ROW EXECUTE FUNCTION "account_entitlement_activation_audit_guard"();

CREATE OR REPLACE FUNCTION "account_entitlement_activation_audit_link_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."mutationTransactionId" IS NULL OR NOT EXISTS (
    SELECT 1 FROM "AccountEntitlementActivationAudit" audit
     WHERE audit."activationId" = NEW."id"
       AND audit."userId" = NEW."userId"
       AND audit."action" = (
         CASE
           WHEN NEW."decision" = 'already_issued' THEN 'linked'::"AccountEntitlementActivationAuditAction"
           ELSE 'created'::"AccountEntitlementActivationAuditAction"
         END
       )
       AND audit."mutationTransactionId" = NEW."mutationTransactionId"
       AND audit."transactionId" = txid_current()
       AND audit."createdAt" = NEW."createdAt"
  ) THEN
    RAISE EXCEPTION 'account entitlement activation requires paired audit' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER "AccountEntitlementActivation_audit_link_guard"
AFTER INSERT ON "AccountEntitlementActivation"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "account_entitlement_activation_audit_link_guard"();

CREATE OR REPLACE FUNCTION "account_entitlement_backfill_run_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  transaction_id UUID;
BEGIN
  IF current_setting('app.account_entitlement_backfill_context', true) IS DISTINCT FROM 'service-v1'
     OR COALESCE(current_setting('app.account_entitlement_backfill_transaction_id', true), '') !~ '^[0-9a-fA-F-]{36}$' THEN
    RAISE EXCEPTION 'account entitlement backfill requires governed service context' USING ERRCODE = 'insufficient_privilege';
  END IF;
  transaction_id := current_setting('app.account_entitlement_backfill_transaction_id', true)::uuid;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'account entitlement backfill records cannot be deleted' USING ERRCODE = 'restrict_violation';
  ELSIF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'previewed'
       OR NEW."transitionAt" IS NULL
       OR NEW."requestKey" IS NOT NULL
       OR NEW."reason" IS NOT NULL
       OR NEW."confirmedAt" IS NOT NULL
       OR NEW."consumedAt" IS NOT NULL
       OR NEW."executedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'account entitlement backfill preview shape is invalid' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD."id" IS DISTINCT FROM NEW."id"
       OR OLD."actorId" IS DISTINCT FROM NEW."actorId"
       OR OLD."actorAccountAccessVersion" IS DISTINCT FROM NEW."actorAccountAccessVersion"
       OR OLD."snapshotAt" IS DISTINCT FROM NEW."snapshotAt"
       OR OLD."expiresAt" IS DISTINCT FROM NEW."expiresAt"
       OR OLD."candidateCount" IS DISTINCT FROM NEW."candidateCount"
       OR OLD."alreadyIssuedCount" IS DISTINCT FROM NEW."alreadyIssuedCount"
       OR OLD."eligibleMissingCount" IS DISTINCT FROM NEW."eligibleMissingCount"
       OR OLD."legacyAmbiguousCount" IS DISTINCT FROM NEW."legacyAmbiguousCount"
       OR OLD."activePolicyId" IS DISTINCT FROM NEW."activePolicyId"
       OR OLD."activePolicyRevision" IS DISTINCT FROM NEW."activePolicyRevision"
       OR OLD."activePolicyFingerprint" IS DISTINCT FROM NEW."activePolicyFingerprint"
       OR OLD."activeOfferVersion" IS DISTINCT FROM NEW."activeOfferVersion"
       OR OLD."activeOfferAmount" IS DISTINCT FROM NEW."activeOfferAmount"
       OR OLD."activeOfferValidForDays" IS DISTINCT FROM NEW."activeOfferValidForDays"
       OR OLD."impactFingerprint" IS DISTINCT FROM NEW."impactFingerprint"
       OR OLD."createdAt" IS DISTINCT FROM NEW."createdAt"
       OR NEW."transitionAt" < OLD."transitionAt" THEN
      RAISE EXCEPTION 'account entitlement backfill snapshot is immutable' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'previewed' AND NEW."status" = 'executing' THEN
      IF NEW."requestKey" IS NULL OR NEW."reason" IS NULL OR length(btrim(NEW."reason")) = 0
         OR NEW."confirmedAt" IS NULL OR NEW."consumedAt" IS NULL OR NEW."executedAt" IS NOT NULL THEN
        RAISE EXCEPTION 'account entitlement backfill confirmation shape is invalid' USING ERRCODE = 'check_violation';
      END IF;
    ELSIF OLD."status" = 'executing' AND NEW."status" = 'completed' THEN
      IF NEW."requestKey" IS NULL OR NEW."reason" IS NULL OR length(btrim(NEW."reason")) = 0
         OR NEW."confirmedAt" IS NULL OR NEW."consumedAt" IS NULL OR NEW."executedAt" IS NULL THEN
        RAISE EXCEPTION 'account entitlement backfill completion shape is invalid' USING ERRCODE = 'check_violation';
      END IF;
    ELSIF OLD."status" IN ('previewed', 'executing') AND NEW."status" IN ('stale', 'expired', 'failed') THEN
      NULL;
    ELSE
      RAISE EXCEPTION 'invalid account entitlement backfill transition' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    RAISE EXCEPTION 'unsupported account entitlement backfill mutation' USING ERRCODE = 'check_violation';
  END IF;
  NEW."mutationTransactionId" := transaction_id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "AccountEntitlementBackfillRun_mutation_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "AccountEntitlementBackfillRun"
FOR EACH ROW EXECUTE FUNCTION "account_entitlement_backfill_run_guard"();

CREATE OR REPLACE FUNCTION "account_entitlement_backfill_item_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  run_row RECORD;
  activation_row RECORD;
  grant_row RECORD;
BEGIN
  IF current_setting('app.account_entitlement_backfill_context', true) IS DISTINCT FROM 'service-v1'
     OR COALESCE(current_setting('app.account_entitlement_backfill_transaction_id', true), '') !~ '^[0-9a-fA-F-]{36}$' THEN
    RAISE EXCEPTION 'account entitlement backfill requires governed service context' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'account entitlement backfill records cannot be deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  SELECT * INTO run_row FROM "AccountEntitlementBackfillRun" WHERE "id" = NEW."runId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'account entitlement backfill run is missing' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF run_row."status" <> 'previewed' OR NEW."status" <> 'pending' OR NEW."activationId" IS NULL AND NEW."classification" = 'eligible_missing' THEN
      RAISE EXCEPTION 'account entitlement backfill item preview shape is invalid' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."classification" = 'legacy_ambiguous' AND NEW."activationId" IS NOT NULL THEN
      RAISE EXCEPTION 'ambiguous backfill item cannot carry activation evidence' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."existingGrantId" IS NOT NULL THEN
      SELECT * INTO grant_row FROM "PlatformTokenGrant" WHERE "id" = NEW."existingGrantId";
      IF NOT FOUND OR grant_row."userId" IS DISTINCT FROM NEW."userId" OR grant_row."kind" <> 'signup' THEN
        RAISE EXCEPTION 'account entitlement backfill grant evidence mismatch' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD."id" IS DISTINCT FROM NEW."id"
       OR OLD."runId" IS DISTINCT FROM NEW."runId"
       OR OLD."userId" IS DISTINCT FROM NEW."userId"
       OR OLD."accountAccessVersion" IS DISTINCT FROM NEW."accountAccessVersion"
       OR OLD."classification" IS DISTINCT FROM NEW."classification"
       OR OLD."evidenceKind" IS DISTINCT FROM NEW."evidenceKind"
       OR OLD."evidenceRefDigest" IS DISTINCT FROM NEW."evidenceRefDigest"
       OR OLD."existingGrantId" IS DISTINCT FROM NEW."existingGrantId"
       OR OLD."createdAt" IS DISTINCT FROM NEW."createdAt"
       OR (OLD."activationId" IS NOT NULL AND NEW."activationId" IS DISTINCT FROM OLD."activationId")
       OR OLD."resultGrantId" IS DISTINCT FROM NEW."resultGrantId" AND OLD."resultGrantId" IS NOT NULL THEN
      RAISE EXCEPTION 'account entitlement backfill item snapshot is immutable' USING ERRCODE = 'check_violation';
    END IF;
    IF run_row."status" <> 'executing' OR OLD."status" <> 'pending' OR NEW."status" NOT IN ('applied', 'skipped') THEN
      RAISE EXCEPTION 'invalid account entitlement backfill item transition' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" = 'applied' THEN
      IF NEW."activationId" IS NULL OR NEW."resultGrantId" IS NULL OR NEW."skipCode" IS NOT NULL THEN
        RAISE EXCEPTION 'applied account entitlement backfill item shape is invalid' USING ERRCODE = 'check_violation';
      END IF;
    ELSIF NEW."activationId" IS NULL AND NEW."resultGrantId" IS NOT NULL THEN
      RAISE EXCEPTION 'skipped account entitlement backfill item grant mismatch' USING ERRCODE = 'check_violation';
    ELSIF NEW."skipCode" IS NULL OR length(btrim(NEW."skipCode")) = 0 THEN
      RAISE EXCEPTION 'skipped account entitlement backfill item requires a code' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."activationId" IS NOT NULL THEN
      SELECT * INTO activation_row FROM "AccountEntitlementActivation" WHERE "id" = NEW."activationId";
      IF NOT FOUND OR activation_row."userId" IS DISTINCT FROM NEW."userId"
         OR (NEW."classification" = 'eligible_missing' AND activation_row."decision" <> 'no_active_offer')
         OR (NEW."classification" = 'already_issued' AND activation_row."decision" NOT IN ('granted', 'already_issued', 'no_active_offer'))
         OR (
           NEW."classification" = 'already_issued'
           AND activation_row."decision" = 'no_active_offer'
           AND (
             activation_row."status" IS DISTINCT FROM 'no_active_offer'
             OR activation_row."accountAccessVersion" IS DISTINCT FROM NEW."accountAccessVersion"
             OR NEW."existingGrantId" IS NULL
             OR NEW."status" IS DISTINCT FROM 'skipped'
             OR NEW."resultGrantId" IS NOT NULL
             OR NEW."skipCode" IS DISTINCT FROM 'ACCOUNT_STATE_CHANGED'
           )
         ) THEN
        RAISE EXCEPTION 'account entitlement backfill activation evidence mismatch' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF NEW."resultGrantId" IS NOT NULL THEN
      SELECT * INTO grant_row FROM "PlatformTokenGrant" WHERE "id" = NEW."resultGrantId";
      IF NOT FOUND OR grant_row."userId" IS DISTINCT FROM NEW."userId" OR grant_row."kind" <> 'signup' THEN
        RAISE EXCEPTION 'account entitlement backfill result grant mismatch' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  ELSE
    RAISE EXCEPTION 'unsupported account entitlement backfill item mutation' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "AccountEntitlementBackfillItem_mutation_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "AccountEntitlementBackfillItem"
FOR EACH ROW EXECUTE FUNCTION "account_entitlement_backfill_item_guard"();

CREATE OR REPLACE FUNCTION "account_entitlement_backfill_audit_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  run_row RECORD;
  expected_action "AccountEntitlementBackfillAuditAction";
  expected_reason BOOLEAN;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'account entitlement backfill audits are append-only' USING ERRCODE = 'restrict_violation';
  END IF;
  IF current_setting('app.account_entitlement_backfill_context', true) IS DISTINCT FROM 'service-v1'
     OR COALESCE(current_setting('app.account_entitlement_backfill_transaction_id', true), '') !~ '^[0-9a-fA-F-]{36}$' THEN
    RAISE EXCEPTION 'account entitlement backfill audit requires governed service context' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO run_row FROM "AccountEntitlementBackfillRun" WHERE "id" = NEW."runId";
  IF NOT FOUND OR run_row."mutationTransactionId" IS DISTINCT FROM current_setting('app.account_entitlement_backfill_transaction_id', true)::uuid
     OR NEW."actorId" IS DISTINCT FROM run_row."actorId"
     OR NEW."transactionId" IS DISTINCT FROM txid_current()
     OR NEW."statusAfter" IS DISTINCT FROM run_row."status"
     OR NEW."createdAt" IS DISTINCT FROM run_row."transitionAt" THEN
    RAISE EXCEPTION 'account entitlement backfill audit is not bound to the current transition' USING ERRCODE = 'check_violation';
  END IF;
  expected_action := CASE
    WHEN NEW."statusBefore" IS NULL AND NEW."statusAfter" = 'previewed' THEN 'previewed'
    WHEN NEW."statusBefore" = 'previewed' AND NEW."statusAfter" = 'executing' THEN 'confirmed'
    WHEN NEW."statusBefore" = 'executing' AND NEW."statusAfter" = 'completed' THEN 'executed'
    WHEN NEW."statusAfter" IN ('stale', 'expired', 'failed') THEN NEW."statusAfter"::text::"AccountEntitlementBackfillAuditAction"
    ELSE NULL
  END;
  expected_reason := NEW."action" IN ('confirmed', 'executed');
  IF expected_action IS NULL
     OR NEW."action" IS DISTINCT FROM expected_action
     OR NEW."reasonRecorded" IS DISTINCT FROM expected_reason THEN
    RAISE EXCEPTION 'account entitlement backfill audit action or reason mismatch' USING ERRCODE = 'check_violation';
  END IF;
  IF expected_reason AND (run_row."reason" IS NULL OR length(btrim(run_row."reason")) = 0) THEN
    RAISE EXCEPTION 'account entitlement backfill confirmation requires a reason' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "AccountEntitlementBackfillAudit_append_only_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "AccountEntitlementBackfillAudit"
FOR EACH ROW EXECUTE FUNCTION "account_entitlement_backfill_audit_guard"();

CREATE OR REPLACE FUNCTION "account_entitlement_backfill_audit_link_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  expected_action "AccountEntitlementBackfillAuditAction";
BEGIN
  IF TG_OP = 'INSERT' THEN
    expected_action := 'previewed';
  ELSIF OLD."status" = 'previewed' AND NEW."status" = 'executing' THEN
    expected_action := 'confirmed';
  ELSIF OLD."status" = 'executing' AND NEW."status" = 'completed' THEN
    expected_action := 'executed';
  ELSIF OLD."status" IN ('previewed', 'executing') AND NEW."status" IN ('stale', 'expired', 'failed') THEN
    expected_action := NEW."status"::text::"AccountEntitlementBackfillAuditAction";
  ELSE
    RAISE EXCEPTION 'invalid account entitlement backfill lifecycle' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."mutationTransactionId" IS NULL OR NOT EXISTS (
    SELECT 1
      FROM "AccountEntitlementBackfillAudit" audit
     WHERE audit."runId" = NEW."id"
       AND audit."action" = expected_action
       AND audit."statusBefore" IS NOT DISTINCT FROM (
         CASE
           WHEN TG_OP = 'INSERT' THEN NULL::"AccountEntitlementBackfillRunStatus"
           ELSE OLD."status"
         END
       )
       AND audit."statusAfter" = NEW."status"
       AND audit."actorId" = NEW."actorId"
       AND audit."transactionId" = txid_current()
       AND audit."createdAt" = NEW."transitionAt"
  ) THEN
    RAISE EXCEPTION 'account entitlement backfill lifecycle requires a paired audit' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER "AccountEntitlementBackfillRun_audit_link_guard"
AFTER INSERT OR UPDATE ON "AccountEntitlementBackfillRun"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "account_entitlement_backfill_audit_link_guard"();

-- Application-side clocks are useful for deterministic previews, but they do
-- not protect the interval between the last service check and COMMIT.  These
-- deferred guards use PostgreSQL's authoritative wall clock at the lifecycle
-- closure point, so a transaction that crosses expiresAt cannot leave behind
-- a historical grant/item or mark the run completed.
CREATE OR REPLACE FUNCTION "account_entitlement_backfill_expiry_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  run_expires_at TIMESTAMP(3);
  run_status "AccountEntitlementBackfillRunStatus";
BEGIN
  IF TG_TABLE_NAME = 'AccountEntitlementBackfillRun' THEN
    IF (
      (OLD."status" = 'previewed' AND NEW."status" = 'executing')
      OR (OLD."status" = 'executing' AND NEW."status" = 'completed')
    )
       AND (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) >= NEW."expiresAt" THEN
      RAISE EXCEPTION 'account entitlement backfill run expired before lifecycle transition' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."status" = 'pending' AND NEW."status" IN ('applied', 'skipped') THEN
    SELECT "expiresAt", "status" INTO run_expires_at, run_status
      FROM "AccountEntitlementBackfillRun"
     WHERE "id" = NEW."runId";
    IF run_status IS DISTINCT FROM 'executing'
       OR run_expires_at IS NULL
       OR (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) >= run_expires_at THEN
      RAISE EXCEPTION 'account entitlement backfill item expired before closure' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "AccountEntitlementBackfillRun_expiry_guard"
AFTER UPDATE ON "AccountEntitlementBackfillRun"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "account_entitlement_backfill_expiry_guard"();

CREATE CONSTRAINT TRIGGER "AccountEntitlementBackfillItem_expiry_guard"
AFTER UPDATE ON "AccountEntitlementBackfillItem"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "account_entitlement_backfill_expiry_guard"();
