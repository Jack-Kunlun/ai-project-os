CREATE TYPE "OidcTokenAuthMethod" AS ENUM ('client_secret_post', 'client_secret_basic');

ALTER TABLE "OidcProvider"
  ADD COLUMN "tokenAuthMethod" "OidcTokenAuthMethod" NOT NULL DEFAULT 'client_secret_post',
  ADD COLUMN "tokenAddressFingerprint" CHAR(64),
  ADD COLUMN "jwksAddressFingerprint" CHAR(64);

-- Providers created before this migration were required to keep every endpoint
-- on the Issuer origin, so the verified Discovery fingerprint is a valid
-- backfill for both server-side endpoints.
UPDATE "OidcProvider"
SET "tokenAddressFingerprint" = "resolvedAddressFingerprint",
    "jwksAddressFingerprint" = "resolvedAddressFingerprint"
WHERE "resolvedAddressFingerprint" IS NOT NULL;

ALTER TABLE "OidcProvider"
  ADD CONSTRAINT "OidcProvider_endpoint_fingerprints_check" CHECK (
    (
      "status" = 'verified'
      AND "resolvedAddressFingerprint" IS NOT NULL
      AND "tokenAddressFingerprint" IS NOT NULL
      AND "jwksAddressFingerprint" IS NOT NULL
    )
    OR "status" <> 'verified'
  );
