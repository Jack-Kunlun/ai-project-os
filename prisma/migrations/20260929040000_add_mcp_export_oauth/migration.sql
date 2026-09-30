-- Server-side OAuth for the project-scoped read-only MCP export. OAuth
-- credentials are stored as SHA-256 digests; the existing MCP approval and
-- dispatch-audit tables remain the authority for every content read.

CREATE TYPE "McpExportGrantType" AS ENUM ('legacyBearer', 'oauth');

ALTER TABLE "McpExportGrant"
  ADD COLUMN "grantType" "McpExportGrantType" NOT NULL DEFAULT 'legacyBearer',
  ADD COLUMN "oauthClientId" TEXT,
  ADD COLUMN "oauthClientName" VARCHAR(160),
  ADD COLUMN "oauthRedirectUri" TEXT,
  ADD COLUMN "oauthScopes" VARCHAR(128);

ALTER TABLE "McpExportGrant"
  ADD CONSTRAINT "McpExportGrant_oauth_shape_check" CHECK (
    ("grantType" = 'legacyBearer'
      AND "oauthClientId" IS NULL AND "oauthClientName" IS NULL
      AND "oauthRedirectUri" IS NULL AND "oauthScopes" IS NULL)
    OR
    ("grantType" = 'oauth'
      AND "oauthClientId" IS NOT NULL AND length("oauthClientId") BETWEEN 1 AND 2048
      AND "oauthClientName" IS NOT NULL AND length("oauthClientName") BETWEEN 1 AND 160
      AND "oauthRedirectUri" IS NOT NULL AND length("oauthRedirectUri") BETWEEN 1 AND 2048
      AND "oauthScopes" = 'project:read')
  );

CREATE TABLE "McpExportOAuthAuthorizationRequest" (
  "id" UUID NOT NULL,
  "clientId" TEXT NOT NULL,
  "clientName" VARCHAR(160) NOT NULL,
  "clientMetadataFingerprint" CHAR(64) NOT NULL,
  "redirectUri" TEXT NOT NULL,
  "state" TEXT NOT NULL,
  "codeChallenge" CHAR(43) NOT NULL,
  "resource" TEXT NOT NULL,
  "scopes" VARCHAR(128) NOT NULL,
  "csrfHash" CHAR(64) NOT NULL,
  "presentedToUserId" UUID,
  "presentedToAccessVersion" INTEGER,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "resolvedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "McpExportOAuthAuthorizationRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "McpExportOAuthAuthorizationRequest_shape_check" CHECK (
    length("clientId") BETWEEN 1 AND 2048
    AND length("clientName") BETWEEN 1 AND 160
    AND "clientMetadataFingerprint" ~ '^[0-9a-f]{64}$'
    AND length("redirectUri") BETWEEN 1 AND 2048
    AND length("state") BETWEEN 1 AND 512
    AND "codeChallenge" ~ '^[A-Za-z0-9_-]{43}$'
    AND length("resource") BETWEEN 1 AND 2048
    AND "scopes" = 'project:read'
    AND "csrfHash" ~ '^[0-9a-f]{64}$'
    AND (("presentedToUserId" IS NULL AND "presentedToAccessVersion" IS NULL)
      OR ("presentedToUserId" IS NOT NULL AND "presentedToAccessVersion" IS NOT NULL AND "presentedToAccessVersion" >= 1))
    AND "expiresAt" > "createdAt"
    AND ("resolvedAt" IS NULL OR "resolvedAt" >= "createdAt")
  ),
  CONSTRAINT "McpExportOAuthAuthorizationRequest_presentedToUserId_fkey"
    FOREIGN KEY ("presentedToUserId") REFERENCES "AppUser"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "McpExportOAuthAuthorizationRequest_expiresAt_resolvedAt_idx"
  ON "McpExportOAuthAuthorizationRequest"("expiresAt", "resolvedAt");
CREATE INDEX "McpExportOAuthAuthorizationRequest_presentedToUserId_expiresAt_resolvedAt_idx"
  ON "McpExportOAuthAuthorizationRequest"("presentedToUserId", "expiresAt", "resolvedAt");

CREATE TABLE "McpExportOAuthCode" (
  "id" UUID NOT NULL,
  "codeHash" CHAR(64) NOT NULL,
  "grantId" UUID NOT NULL,
  "clientId" TEXT NOT NULL,
  "redirectUri" TEXT NOT NULL,
  "resource" TEXT NOT NULL,
  "scopes" VARCHAR(128) NOT NULL,
  "codeChallenge" CHAR(43) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "McpExportOAuthCode_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "McpExportOAuthCode_codeHash_key" UNIQUE ("codeHash"),
  CONSTRAINT "McpExportOAuthCode_shape_check" CHECK (
    "codeHash" ~ '^[0-9a-f]{64}$'
    AND length("clientId") BETWEEN 1 AND 2048
    AND length("redirectUri") BETWEEN 1 AND 2048
    AND length("resource") BETWEEN 1 AND 2048
    AND "scopes" = 'project:read'
    AND "codeChallenge" ~ '^[A-Za-z0-9_-]{43}$'
    AND "expiresAt" > "createdAt"
    AND ("consumedAt" IS NULL OR "consumedAt" >= "createdAt")
  ),
  CONSTRAINT "McpExportOAuthCode_grantId_fkey"
    FOREIGN KEY ("grantId") REFERENCES "McpExportGrant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "McpExportOAuthCode_grantId_expiresAt_consumedAt_idx"
  ON "McpExportOAuthCode"("grantId", "expiresAt", "consumedAt");

CREATE TABLE "McpExportOAuthAccessToken" (
  "id" UUID NOT NULL,
  "tokenHash" CHAR(64) NOT NULL,
  "grantId" UUID NOT NULL,
  "clientId" TEXT NOT NULL,
  "resource" TEXT NOT NULL,
  "scopes" VARCHAR(128) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "McpExportOAuthAccessToken_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "McpExportOAuthAccessToken_tokenHash_key" UNIQUE ("tokenHash"),
  CONSTRAINT "McpExportOAuthAccessToken_shape_check" CHECK (
    "tokenHash" ~ '^[0-9a-f]{64}$'
    AND length("clientId") BETWEEN 1 AND 2048
    AND length("resource") BETWEEN 1 AND 2048
    AND "scopes" = 'project:read'
    AND "expiresAt" > "createdAt"
    AND ("revokedAt" IS NULL OR "revokedAt" >= "createdAt")
  ),
  CONSTRAINT "McpExportOAuthAccessToken_grantId_fkey"
    FOREIGN KEY ("grantId") REFERENCES "McpExportGrant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "McpExportOAuthAccessToken_grantId_expiresAt_revokedAt_idx"
  ON "McpExportOAuthAccessToken"("grantId", "expiresAt", "revokedAt");
