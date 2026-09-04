CREATE TYPE "ResourceOwnershipState" AS ENUM ('legacy_pending', 'ambiguous', 'confirmed');
CREATE TYPE "PlatformGrantOfferPolicyStatus" AS ENUM ('draft', 'active', 'retired');
CREATE TYPE "PlatformDefaultAiRouteStatus" AS ENUM ('draft', 'verified', 'active', 'retired');

ALTER TABLE "AppUser"
  ADD COLUMN "disabledReason" VARCHAR(500),
  ADD COLUMN "disabledById" UUID,
  ADD CONSTRAINT "AppUser_disabled_metadata_check"
    CHECK ("disabledAt" IS NOT NULL OR ("disabledReason" IS NULL AND "disabledById" IS NULL));

ALTER TABLE "MembershipSubscription"
  ADD COLUMN "revocationReason" VARCHAR(500),
  ADD CONSTRAINT "MembershipSubscription_revocation_check"
    CHECK ("revocationReason" IS NULL OR ("status" = 'revoked' AND "revokedAt" IS NOT NULL));

ALTER TABLE "WorkspaceInvitation"
  ADD COLUMN "revokedById" UUID,
  ADD COLUMN "revocationReason" VARCHAR(500),
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD CONSTRAINT "WorkspaceInvitation_revocation_check"
    CHECK (("revokedById" IS NULL AND "revocationReason" IS NULL) OR "revokedAt" IS NOT NULL);

ALTER TABLE "WorkspaceInvitation"
  ALTER COLUMN "updatedAt" DROP DEFAULT;

ALTER TABLE "GitConnection"
  ADD COLUMN "ownerUserId" UUID,
  ADD COLUMN "ownershipState" "ResourceOwnershipState" NOT NULL DEFAULT 'legacy_pending',
  ADD CONSTRAINT "GitConnection_ownership_check"
    CHECK (("ownershipState" = 'confirmed' AND "ownerUserId" IS NOT NULL)
        OR ("ownershipState" IN ('legacy_pending', 'ambiguous') AND "ownerUserId" IS NULL));

ALTER TABLE "McpConnection"
  ADD COLUMN "ownerUserId" UUID,
  ADD COLUMN "ownershipState" "ResourceOwnershipState" NOT NULL DEFAULT 'legacy_pending',
  ADD CONSTRAINT "McpConnection_ownership_check"
    CHECK (("ownershipState" = 'confirmed' AND "ownerUserId" IS NOT NULL)
        OR ("ownershipState" IN ('legacy_pending', 'ambiguous') AND "ownerUserId" IS NULL));

ALTER TABLE "AiProviderConnection"
  ADD COLUMN "ownershipState" "ResourceOwnershipState" NOT NULL DEFAULT 'legacy_pending';

ALTER TABLE "AiProviderConnection"
  DROP CONSTRAINT "AiProviderConnection_scope_check";

ALTER TABLE "AiProviderConnection"
  ADD CONSTRAINT "AiProviderConnection_scope_check"
    CHECK (("scope" = 'platform'
            AND "workspaceId" IS NULL
            AND "ownerUserId" IS NULL
            AND "ownershipState" = 'legacy_pending')
        OR ("scope" = 'workspace'
            AND "workspaceId" IS NOT NULL
            AND "ownerUserId" IS NOT NULL
            AND "ownershipState" IN ('legacy_pending', 'ambiguous'))
        OR ("scope" = 'user'
            AND "workspaceId" IS NULL
            AND "ownerUserId" IS NOT NULL
            AND "ownershipState" = 'confirmed'));

CREATE INDEX "GitConnection_ownerUserId_ownershipState_updatedAt_idx"
  ON "GitConnection"("ownerUserId", "ownershipState", "updatedAt");
CREATE INDEX "McpConnection_ownerUserId_ownershipState_updatedAt_idx"
  ON "McpConnection"("ownerUserId", "ownershipState", "updatedAt");
CREATE INDEX "AiProviderConnection_ownerUserId_ownershipState_updatedAt_idx"
  ON "AiProviderConnection"("ownerUserId", "ownershipState", "updatedAt");

CREATE TABLE "PlatformGrantOfferPolicy" (
  "id" UUID NOT NULL,
  "offerVersion" VARCHAR(64) NOT NULL,
  "status" "PlatformGrantOfferPolicyStatus" NOT NULL DEFAULT 'draft',
  "amount" INTEGER NOT NULL,
  "validForDays" INTEGER NOT NULL,
  "eligibilityKey" VARCHAR(64) NOT NULL,
  "createdById" UUID NOT NULL,
  "updatedById" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PlatformGrantOfferPolicy_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PlatformGrantOfferPolicy_amount_check" CHECK ("amount" > 0 AND "validForDays" > 0)
);

CREATE TABLE "PlatformDefaultAiRoute" (
  "id" UUID NOT NULL,
  "operation" "AiOperation" NOT NULL,
  "version" INTEGER NOT NULL,
  "status" "PlatformDefaultAiRouteStatus" NOT NULL DEFAULT 'draft',
  "providerConnectionId" UUID NOT NULL,
  "modelId" VARCHAR(128) NOT NULL,
  "embeddingDimensions" INTEGER,
  "maxOutputTokens" INTEGER,
  "quotaMultiplierBps" INTEGER NOT NULL DEFAULT 10000,
  "createdById" UUID NOT NULL,
  "updatedById" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PlatformDefaultAiRoute_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PlatformDefaultAiRoute_version_check" CHECK ("version" > 0),
  CONSTRAINT "PlatformDefaultAiRoute_quota_multiplier_check" CHECK ("quotaMultiplierBps" > 0),
  CONSTRAINT "PlatformDefaultAiRoute_operation_payload_check" CHECK (
    ("operation" = 'embedding' AND "embeddingDimensions" IS NOT NULL AND "embeddingDimensions" > 0 AND "maxOutputTokens" IS NULL)
    OR ("operation" <> 'embedding' AND "embeddingDimensions" IS NULL AND "maxOutputTokens" IS NOT NULL AND "maxOutputTokens" > 0)
  )
);

CREATE UNIQUE INDEX "PlatformGrantOfferPolicy_offerVersion_key"
  ON "PlatformGrantOfferPolicy"("offerVersion");
CREATE INDEX "PlatformGrantOfferPolicy_status_updatedAt_idx"
  ON "PlatformGrantOfferPolicy"("status", "updatedAt");
CREATE UNIQUE INDEX "PlatformGrantOfferPolicy_active_key"
  ON "PlatformGrantOfferPolicy"("status")
  WHERE "status" = 'active';

CREATE UNIQUE INDEX "PlatformDefaultAiRoute_operation_version_key"
  ON "PlatformDefaultAiRoute"("operation", "version");
CREATE INDEX "PlatformDefaultAiRoute_operation_status_updatedAt_idx"
  ON "PlatformDefaultAiRoute"("operation", "status", "updatedAt");
CREATE INDEX "PlatformDefaultAiRoute_providerConnectionId_status_idx"
  ON "PlatformDefaultAiRoute"("providerConnectionId", "status");
CREATE UNIQUE INDEX "PlatformDefaultAiRoute_operation_active_key"
  ON "PlatformDefaultAiRoute"("operation")
  WHERE "status" = 'active';

ALTER TABLE "AppUser"
  ADD CONSTRAINT "AppUser_disabledById_fkey"
    FOREIGN KEY ("disabledById") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "WorkspaceInvitation"
  ADD CONSTRAINT "WorkspaceInvitation_revokedById_fkey"
    FOREIGN KEY ("revokedById") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "GitConnection"
  ADD CONSTRAINT "GitConnection_ownerUserId_fkey"
    FOREIGN KEY ("ownerUserId") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "McpConnection"
  ADD CONSTRAINT "McpConnection_ownerUserId_fkey"
    FOREIGN KEY ("ownerUserId") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "PlatformGrantOfferPolicy"
  ADD CONSTRAINT "PlatformGrantOfferPolicy_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PlatformGrantOfferPolicy_updatedById_fkey"
    FOREIGN KEY ("updatedById") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "PlatformDefaultAiRoute"
  ADD CONSTRAINT "PlatformDefaultAiRoute_providerConnectionId_fkey"
    FOREIGN KEY ("providerConnectionId") REFERENCES "AiProviderConnection"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PlatformDefaultAiRoute_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PlatformDefaultAiRoute_updatedById_fkey"
    FOREIGN KEY ("updatedById") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
