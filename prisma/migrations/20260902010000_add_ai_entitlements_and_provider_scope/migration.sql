-- Provider scope and independent AI entitlement ledger.
-- Historical records are deliberately retained as legacy/platform records;
-- this migration never creates or deducts a grant for an existing account.

CREATE TYPE "AiProviderScope" AS ENUM ('platform', 'workspace');
CREATE TYPE "AiBillingMode" AS ENUM ('platform', 'byok', 'legacy');
CREATE TYPE "MembershipSubscriptionStatus" AS ENUM ('active', 'revoked');
CREATE TYPE "PlatformTokenGrantKind" AS ENUM ('signup', 'manual');
CREATE TYPE "PlatformTokenReservationStatus" AS ENUM ('reserved', 'settled', 'released', 'held');
CREATE TYPE "PlatformTokenLedgerEntryKind" AS ENUM ('grant', 'reserve', 'settle', 'release', 'hold', 'adjustment');
CREATE TYPE "MembershipAuditEventKind" AS ENUM ('grant', 'extend', 'revoke');

ALTER TABLE "AiProviderConnection"
  ADD COLUMN "scope" "AiProviderScope" NOT NULL DEFAULT 'platform',
  ADD COLUMN "workspaceId" UUID,
  ADD COLUMN "ownerUserId" UUID,
  ALTER COLUMN "defaultGenerationModelId" DROP NOT NULL;

-- Provider call history must survive project/job cleanup. The old schema used
-- CASCADE here, so replace it before making the audit job reference nullable.
ALTER TABLE "ProviderCallAudit" DROP CONSTRAINT "ProviderCallAudit_jobId_fkey";
ALTER TABLE "ProviderCallAudit" ALTER COLUMN "jobId" DROP NOT NULL;

ALTER TABLE "WebAiGrant"
  ADD COLUMN "billingMode" "AiBillingMode" NOT NULL DEFAULT 'legacy',
  ADD COLUMN "billingUserId" UUID,
  ADD COLUMN "callKey" VARCHAR(128);

ALTER TABLE "ProviderCallAudit"
  ADD COLUMN "billingMode" "AiBillingMode" NOT NULL DEFAULT 'legacy',
  ADD COLUMN "billingUserId" UUID,
  ADD COLUMN "callKey" VARCHAR(128),
  ADD COLUMN "reservationId" UUID,
  ADD COLUMN "usageKnown" BOOLEAN NOT NULL DEFAULT false;

-- Existing grants/calls are auditable history. They are not retroactively
-- charged, but retain the original actor as the billing/requesting context.
UPDATE "WebAiGrant"
SET "billingUserId" = "issuedById"
WHERE "billingUserId" IS NULL;

UPDATE "ProviderCallAudit" AS audit
SET "billingUserId" = job."requestedById"
FROM "BackgroundJob" AS job
WHERE audit."jobId" = job."id" AND audit."billingUserId" IS NULL;

UPDATE "ProviderCallAudit"
SET "callKey" = 'legacy:' || "id"::text
WHERE "callKey" IS NULL;

ALTER TABLE "WebAiGrant" ALTER COLUMN "billingUserId" SET NOT NULL;
ALTER TABLE "ProviderCallAudit" ALTER COLUMN "billingUserId" SET NOT NULL;
ALTER TABLE "ProviderCallAudit" ALTER COLUMN "callKey" SET NOT NULL;

ALTER TABLE "AiProviderConnection"
  ADD CONSTRAINT "AiProviderConnection_scope_check"
  CHECK (("scope" = 'platform' AND "workspaceId" IS NULL AND "ownerUserId" IS NULL)
      OR ("scope" = 'workspace' AND "workspaceId" IS NOT NULL AND "ownerUserId" IS NOT NULL));

-- CHECK constraints cannot contain a subquery in PostgreSQL. A deferred
-- constraint trigger closes that gap while still allowing a membership and
-- its provider connection to be created in the same transaction.
CREATE OR REPLACE FUNCTION "ai_provider_workspace_membership_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_TABLE_NAME = 'AiProviderConnection' THEN
    IF NEW."scope" = 'workspace'
       AND NOT EXISTS (
         SELECT 1 FROM "WorkspaceMembership"
         WHERE "workspaceId" = NEW."workspaceId" AND "userId" = NEW."ownerUserId"
       ) THEN
      RAISE EXCEPTION 'AI_PROVIDER_OWNER_REQUIRED';
    END IF;
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1 FROM "AiProviderConnection" AS connection
    WHERE connection."scope" = 'workspace'
      AND connection."workspaceId" = OLD."workspaceId"
      AND connection."ownerUserId" = OLD."userId"
      AND NOT EXISTS (
        SELECT 1 FROM "WorkspaceMembership" AS membership
        WHERE membership."workspaceId" = connection."workspaceId"
          AND membership."userId" = connection."ownerUserId"
      )
  ) THEN
    RAISE EXCEPTION 'AI_PROVIDER_OWNER_REQUIRED';
  END IF;
  RETURN OLD;
END;
$$;

CREATE CONSTRAINT TRIGGER "AiProviderConnection_workspace_membership_guard"
AFTER INSERT OR UPDATE OF "scope", "workspaceId", "ownerUserId"
ON "AiProviderConnection"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "ai_provider_workspace_membership_guard"();

CREATE CONSTRAINT TRIGGER "WorkspaceMembership_ai_provider_membership_guard"
AFTER DELETE OR UPDATE OF "workspaceId", "userId"
ON "WorkspaceMembership"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "ai_provider_workspace_membership_guard"();

CREATE TABLE "MembershipSubscription" (
  "id" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "status" "MembershipSubscriptionStatus" NOT NULL DEFAULT 'active',
  "startsAt" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "grantedById" UUID,
  "revokedById" UUID,
  "revokedAt" TIMESTAMP(3),
  "note" VARCHAR(500),
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MembershipSubscription_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MembershipSubscription_window_check" CHECK ("expiresAt" > "startsAt"),
  CONSTRAINT "MembershipSubscription_version_check" CHECK ("version" > 0)
);

CREATE TABLE "MembershipSubscriptionAudit" (
  "id" UUID NOT NULL,
  "subscriptionId" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "actorId" UUID NOT NULL,
  "eventKind" "MembershipAuditEventKind" NOT NULL,
  "startsAt" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "note" VARCHAR(500),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MembershipSubscriptionAudit_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MembershipSubscriptionAudit_window_check" CHECK ("expiresAt" > "startsAt")
);

CREATE TABLE "PlatformTokenGrant" (
  "id" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "kind" "PlatformTokenGrantKind" NOT NULL,
  "amount" INTEGER NOT NULL,
  "remainingTokens" INTEGER NOT NULL,
  "offerVersion" VARCHAR(64) NOT NULL,
  "issuedById" UUID,
  "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PlatformTokenGrant_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PlatformTokenGrant_amount_check" CHECK ("amount" > 0 AND "remainingTokens" >= 0 AND "remainingTokens" <= "amount"),
  CONSTRAINT "PlatformTokenGrant_expiry_check" CHECK ("expiresAt" > "issuedAt")
);

CREATE TABLE "PlatformTokenReservation" (
  "id" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "grantId" UUID NOT NULL,
  "jobId" UUID,
  "providerConnectionId" UUID,
  "callKey" VARCHAR(128) NOT NULL,
  "operation" "AiOperation" NOT NULL,
  "modelId" VARCHAR(128) NOT NULL,
  "status" "PlatformTokenReservationStatus" NOT NULL DEFAULT 'reserved',
  "reservedTokens" INTEGER NOT NULL,
  "settledTokens" INTEGER,
  "reconciliationRequired" BOOLEAN NOT NULL DEFAULT false,
  "safeErrorCode" VARCHAR(64),
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "settledAt" TIMESTAMP(3),
  "releasedAt" TIMESTAMP(3),
  CONSTRAINT "PlatformTokenReservation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PlatformTokenReservation_reserved_check" CHECK ("reservedTokens" > 0),
  CONSTRAINT "PlatformTokenReservation_settled_check" CHECK ("settledTokens" IS NULL OR "settledTokens" >= 0)
);

CREATE TABLE "PlatformTokenLedgerEntry" (
  "id" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "grantId" UUID,
  "reservationId" UUID,
  "entryKind" "PlatformTokenLedgerEntryKind" NOT NULL,
  "amount" INTEGER NOT NULL,
  "usageTokens" INTEGER,
  "reasonCode" VARCHAR(64) NOT NULL,
  "callKey" VARCHAR(128),
  "idempotencyKey" VARCHAR(180) NOT NULL,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PlatformTokenLedgerEntry_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PlatformTokenLedgerEntry_amount_check" CHECK ("amount" >= -10000000 AND "amount" <= 10000000),
  CONSTRAINT "PlatformTokenLedgerEntry_usage_check" CHECK ("usageTokens" IS NULL OR "usageTokens" >= 0)
);

CREATE UNIQUE INDEX "MembershipSubscription_userId_key" ON "MembershipSubscription"("userId");
CREATE INDEX "MembershipSubscription_status_expiresAt_idx" ON "MembershipSubscription"("status", "expiresAt");
CREATE INDEX "MembershipSubscription_grantedById_updatedAt_idx" ON "MembershipSubscription"("grantedById", "updatedAt");
CREATE INDEX "MembershipSubscriptionAudit_userId_createdAt_idx" ON "MembershipSubscriptionAudit"("userId", "createdAt");
CREATE INDEX "MembershipSubscriptionAudit_subscriptionId_createdAt_idx" ON "MembershipSubscriptionAudit"("subscriptionId", "createdAt");
CREATE INDEX "MembershipSubscriptionAudit_actorId_createdAt_idx" ON "MembershipSubscriptionAudit"("actorId", "createdAt");

CREATE UNIQUE INDEX "PlatformTokenGrant_userId_kind_key" ON "PlatformTokenGrant"("userId", "kind");
CREATE INDEX "PlatformTokenGrant_userId_expiresAt_revokedAt_idx" ON "PlatformTokenGrant"("userId", "expiresAt", "revokedAt");

CREATE UNIQUE INDEX "PlatformTokenReservation_userId_callKey_key" ON "PlatformTokenReservation"("userId", "callKey");
CREATE INDEX "PlatformTokenReservation_userId_status_expiresAt_idx" ON "PlatformTokenReservation"("userId", "status", "expiresAt");
CREATE INDEX "PlatformTokenReservation_jobId_createdAt_idx" ON "PlatformTokenReservation"("jobId", "createdAt");
CREATE INDEX "PlatformTokenReservation_providerConnectionId_createdAt_idx" ON "PlatformTokenReservation"("providerConnectionId", "createdAt");

CREATE INDEX "PlatformTokenLedgerEntry_userId_createdAt_idx" ON "PlatformTokenLedgerEntry"("userId", "createdAt");
CREATE INDEX "PlatformTokenLedgerEntry_grantId_createdAt_idx" ON "PlatformTokenLedgerEntry"("grantId", "createdAt");
CREATE INDEX "PlatformTokenLedgerEntry_reservationId_createdAt_idx" ON "PlatformTokenLedgerEntry"("reservationId", "createdAt");
CREATE INDEX "PlatformTokenLedgerEntry_userId_callKey_idx" ON "PlatformTokenLedgerEntry"("userId", "callKey");
CREATE UNIQUE INDEX "PlatformTokenLedgerEntry_idempotencyKey_key" ON "PlatformTokenLedgerEntry"("idempotencyKey");

CREATE INDEX "AiProviderConnection_scope_workspaceId_status_idx" ON "AiProviderConnection"("scope", "workspaceId", "status");
CREATE INDEX "AiProviderConnection_ownerUserId_updatedAt_idx" ON "AiProviderConnection"("ownerUserId", "updatedAt");
CREATE INDEX "WebAiGrant_billingUserId_issuedAt_idx" ON "WebAiGrant"("billingUserId", "issuedAt");
CREATE INDEX "WebAiGrant_callKey_idx" ON "WebAiGrant"("callKey");
CREATE INDEX "ProviderCallAudit_billingUserId_createdAt_idx" ON "ProviderCallAudit"("billingUserId", "createdAt");
CREATE INDEX "ProviderCallAudit_callKey_idx" ON "ProviderCallAudit"("callKey");
CREATE INDEX "ProviderCallAudit_reservationId_idx" ON "ProviderCallAudit"("reservationId");
CREATE UNIQUE INDEX "ProviderCallAudit_reservationId_key" ON "ProviderCallAudit"("reservationId");
CREATE UNIQUE INDEX "ProviderCallAudit_jobId_callKey_key" ON "ProviderCallAudit"("jobId", "callKey");

ALTER TABLE "AiProviderConnection" ADD CONSTRAINT "AiProviderConnection_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "AiProviderConnection" ADD CONSTRAINT "AiProviderConnection_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "WebAiGrant" ADD CONSTRAINT "WebAiGrant_billingUserId_fkey" FOREIGN KEY ("billingUserId") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "MembershipSubscription" ADD CONSTRAINT "MembershipSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "MembershipSubscription" ADD CONSTRAINT "MembershipSubscription_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "MembershipSubscription" ADD CONSTRAINT "MembershipSubscription_revokedById_fkey" FOREIGN KEY ("revokedById") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "MembershipSubscriptionAudit" ADD CONSTRAINT "MembershipSubscriptionAudit_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "MembershipSubscription"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "MembershipSubscriptionAudit" ADD CONSTRAINT "MembershipSubscriptionAudit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "MembershipSubscriptionAudit" ADD CONSTRAINT "MembershipSubscriptionAudit_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "PlatformTokenGrant" ADD CONSTRAINT "PlatformTokenGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "PlatformTokenGrant" ADD CONSTRAINT "PlatformTokenGrant_issuedById_fkey" FOREIGN KEY ("issuedById") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "PlatformTokenReservation" ADD CONSTRAINT "PlatformTokenReservation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "PlatformTokenReservation" ADD CONSTRAINT "PlatformTokenReservation_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "PlatformTokenGrant"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "PlatformTokenReservation" ADD CONSTRAINT "PlatformTokenReservation_providerConnectionId_fkey" FOREIGN KEY ("providerConnectionId") REFERENCES "AiProviderConnection"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "PlatformTokenLedgerEntry" ADD CONSTRAINT "PlatformTokenLedgerEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "PlatformTokenLedgerEntry" ADD CONSTRAINT "PlatformTokenLedgerEntry_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "PlatformTokenGrant"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "PlatformTokenLedgerEntry" ADD CONSTRAINT "PlatformTokenLedgerEntry_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "PlatformTokenReservation"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "ProviderCallAudit" ADD CONSTRAINT "ProviderCallAudit_billingUserId_fkey" FOREIGN KEY ("billingUserId") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "ProviderCallAudit" ADD CONSTRAINT "ProviderCallAudit_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "BackgroundJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ProviderCallAudit" ADD CONSTRAINT "ProviderCallAudit_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "PlatformTokenReservation"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
