ALTER TYPE "AccountEntitlementActivationSource" ADD VALUE 'localRegistration';

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
        'bootstrap', 'localProvisioning', 'localRegistration', 'githubRegistration',
        'oidcRegistration', 'oidcInvitationRegistration', 'historicalBackfill',
        'verifiedGithub', 'verifiedOidc'
      )
    )
  );
