CREATE TYPE "McpExportOAuthAdmissionScope" AS ENUM ('client_hour', 'global_hour');

CREATE TABLE "McpExportOAuthAdmissionBudget" (
  "scope" "McpExportOAuthAdmissionScope" NOT NULL,
  "keyFingerprint" CHAR(64) NOT NULL,
  "windowStartedAt" TIMESTAMP(3) NOT NULL,
  "attemptCount" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "McpExportOAuthAdmissionBudget_pkey" PRIMARY KEY ("scope", "keyFingerprint"),
  CONSTRAINT "McpExportOAuthAdmissionBudget_fingerprint_check"
    CHECK ("keyFingerprint" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "McpExportOAuthAdmissionBudget_attempt_check"
    CHECK (("scope" = 'client_hour' AND "attemptCount" BETWEEN 1 AND 20)
      OR ("scope" = 'global_hour' AND "keyFingerprint" = repeat('0', 64) AND "attemptCount" BETWEEN 1 AND 200)),
  CONSTRAINT "McpExportOAuthAdmissionBudget_times_check"
    CHECK ("updatedAt" >= "createdAt")
);
CREATE INDEX "McpExportOAuthAdmissionBudget_scope_windowStartedAt_idx"
  ON "McpExportOAuthAdmissionBudget"("scope", "windowStartedAt");
CREATE INDEX "McpExportOAuthAuthorizationRequest_clientId_expiresAt_resolvedAt_idx"
  ON "McpExportOAuthAuthorizationRequest"("clientId", "expiresAt", "resolvedAt");

ALTER TABLE "McpExportApproval"
  ADD COLUMN "oauthClientId" TEXT,
  ADD COLUMN "oauthClientName" VARCHAR(160),
  ADD CONSTRAINT "McpExportApproval_oauth_client_snapshot_check" CHECK (
    ("oauthClientId" IS NULL AND "oauthClientName" IS NULL)
    OR ("oauthClientId" IS NOT NULL AND length("oauthClientId") BETWEEN 1 AND 2048
      AND "oauthClientName" IS NOT NULL AND length("oauthClientName") BETWEEN 1 AND 160
      AND length(btrim("oauthClientName")) > 0)
  );

-- Pending OAuth approvals may still be consumed after this migration. Capture
-- their existing client identity from the owning grant before new writes use
-- the snapshot columns.
UPDATE "McpExportApproval" approval
   SET "oauthClientId" = owner_grant."oauthClientId",
       "oauthClientName" = owner_grant."oauthClientName"
  FROM "McpExportGrant" owner_grant
 WHERE approval."grantId" = owner_grant."id"
   AND owner_grant."grantType" = 'oauth'
   AND owner_grant."oauthClientId" IS NOT NULL
   AND owner_grant."oauthClientName" IS NOT NULL;

ALTER TABLE "McpExportDispatchAudit"
  ADD COLUMN "oauthClientId" TEXT,
  ADD COLUMN "oauthClientName" VARCHAR(160),
  ADD CONSTRAINT "McpExportDispatchAudit_oauth_client_snapshot_check" CHECK (
    ("oauthClientId" IS NULL AND "oauthClientName" IS NULL)
    OR ("oauthClientId" IS NOT NULL AND length("oauthClientId") BETWEEN 1 AND 2048
      AND "oauthClientName" IS NOT NULL AND length("oauthClientName") BETWEEN 1 AND 160
      AND length(btrim("oauthClientName")) > 0)
  );
