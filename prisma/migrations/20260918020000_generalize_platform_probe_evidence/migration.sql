-- v0.4: generalise the governed probe attempt into a proof record. Draft
-- attempts never reference a provider row and never persist a credential
-- fingerprint; route-operation attempts bind a saved provider and payload.

CREATE TYPE "PlatformProviderProbeSubject" AS ENUM ('savedConnection', 'draftConnection', 'routeOperation');

ALTER TABLE "PlatformProviderProbeAttempt"
  ADD COLUMN "subject" "PlatformProviderProbeSubject" NOT NULL DEFAULT 'savedConnection',
  ADD COLUMN "providerKind" "AiProviderKind",
  ADD COLUMN "targetOperation" "AiOperation",
  ADD COLUMN "targetModelId" VARCHAR(128),
  ADD COLUMN "targetPayload" JSONB,
  ADD COLUMN "configurationDigest" CHAR(64),
  ADD COLUMN "evidenceExpiresAt" TIMESTAMP(3),
  ADD COLUMN "consumedAt" TIMESTAMP(3),
  ADD COLUMN "consumedProviderConnectionId" UUID;

ALTER TABLE "PlatformProviderProbeAttempt"
  DROP CONSTRAINT "PlatformProviderProbeAttempt_shape_check",
  DROP CONSTRAINT "PlatformProviderProbeAttempt_provider_fkey";

ALTER TABLE "PlatformProviderProbeAttempt"
  ALTER COLUMN "providerConnectionId" DROP NOT NULL;

ALTER TABLE "PlatformProviderProbeAttempt"
  ADD CONSTRAINT "PlatformProviderProbeAttempt_provider_fkey"
    FOREIGN KEY ("providerConnectionId") REFERENCES "AiProviderConnection"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PlatformProviderProbeAttempt_shape_check" CHECK (
    "actorAccountAccessVersion" > 0
    AND "providerConfigurationVersion" > 0
    AND "clientRequestKeyHash" ~ '^[0-9a-f]{64}$'
    AND "requestFingerprint" ~ '^[0-9a-f]{64}$'
    AND ("credentialSecretFingerprint" IS NULL OR "credentialSecretFingerprint" ~ '^[0-9a-f]{64}$')
    AND ("configurationDigest" IS NULL OR "configurationDigest" ~ '^[0-9a-f]{64}$')
    AND "plannedUnits" BETWEEN 0 AND 3
    AND "dispatchedUnits" >= 0
    AND "settledUnits" >= 0
    AND "releasedUnits" >= 0
    AND "heldUnits" >= 0
    AND "dispatchedUnits" + "releasedUnits" <= "plannedUnits"
    AND "settledUnits" + "releasedUnits" + "heldUnits" <= "plannedUnits"
    AND ("plannedUnits" = 0 OR "budgetId" IS NOT NULL)
    AND ("status" = 'rejected' OR "budgetId" IS NOT NULL)
    AND ("status" = 'rejected' OR "credentialSecretFingerprint" IS NOT NULL OR "subject" = 'draftConnection')
    AND (
      ("subject" = 'savedConnection' AND "providerConnectionId" IS NOT NULL)
      OR ("subject" = 'draftConnection' AND "providerConnectionId" IS NULL AND "providerKind" IS NOT NULL AND "configurationDigest" IS NOT NULL AND "credentialSecretFingerprint" IS NULL)
      OR ("subject" = 'routeOperation' AND "providerConnectionId" IS NOT NULL AND "providerKind" IS NOT NULL AND "targetOperation" IS NOT NULL AND "targetModelId" IS NOT NULL AND "targetPayload" IS NOT NULL AND "configurationDigest" IS NOT NULL)
    )
    AND ("consumedAt" IS NULL OR "consumedProviderConnectionId" IS NOT NULL)
    AND ("consumedProviderConnectionId" IS NULL OR "consumedAt" IS NOT NULL)
    AND ("subject" = 'savedConnection' OR "status" = 'rejected' OR "evidenceExpiresAt" IS NOT NULL)
    AND ("safeErrorCode" IS NULL OR "safeErrorCode" IN (
      'PLATFORM_PROVIDER_PROBE_BUDGET_REQUIRED', 'PLATFORM_PROVIDER_PROBE_BUDGET_EXHAUSTED',
      'PLATFORM_PROVIDER_PROBE_CONFIGURATION_CONFLICT', 'PLATFORM_PROVIDER_PROBE_CANONICAL_ENDPOINT_REQUIRED',
      'PLATFORM_PROVIDER_PROBE_PROVIDER_UNAVAILABLE', 'PLATFORM_PROVIDER_PROBE_PROVIDER_AUTH_FAILED',
      'PLATFORM_PROVIDER_PROBE_PROVIDER_RATE_LIMITED', 'PLATFORM_PROVIDER_PROBE_PROVIDER_REJECTED',
      'PLATFORM_PROVIDER_PROBE_PROVIDER_INVALID_RESPONSE', 'PLATFORM_PROVIDER_PROBE_PROVIDER_RESPONSE_TOO_LARGE',
      'PLATFORM_PROVIDER_PROBE_PROVIDER_TIMEOUT', 'PLATFORM_PROVIDER_PROBE_PROVIDER_EMBEDDING_UNSUPPORTED',
      'PLATFORM_PROVIDER_PROBE_PROVIDER_VISION_UNSUPPORTED', 'PLATFORM_PROVIDER_PROBE_RECONCILIATION_HOLD',
      'PLATFORM_PROVIDER_PROBE_RECONCILED_NO_DISPATCH'
    ))
    AND (("status" = 'rejected'
        AND "plannedUnits" = 0
        AND "credentialSecretFingerprint" IS NULL
        AND "dispatchedUnits" = 0 AND "settledUnits" = 0
        AND "releasedUnits" = 0 AND "heldUnits" = 0
        AND "startedAt" IS NULL AND "terminalAt" IS NOT NULL)
      OR ("status" = 'reserved'
        AND "plannedUnits" > 0
        AND "dispatchedUnits" = 0
        AND "startedAt" IS NULL AND "terminalAt" IS NULL)
      OR ("status" = 'running'
        AND "plannedUnits" > 0
        AND "dispatchedUnits" > 0
        AND "startedAt" IS NOT NULL AND "terminalAt" IS NULL)
      OR ("status" = 'settled'
        AND "plannedUnits" > 0
        AND "settledUnits" > 0
        AND "terminalAt" IS NOT NULL)
      OR ("status" = 'released'
        AND "plannedUnits" > 0
        AND "releasedUnits" > 0
        AND "terminalAt" IS NOT NULL)
      OR ("status" = 'held'
        AND "plannedUnits" > 0
        AND "heldUnits" > 0
        AND "terminalAt" IS NOT NULL))
  );

DROP INDEX "PlatformProviderProbeAttempt_providerConnectionId_actorId_clientRequestKeyHash_key";
CREATE UNIQUE INDEX "PlatformProviderProbeAttempt_providerConnectionId_actorId_clientRequestKeyHash_key"
  ON "PlatformProviderProbeAttempt" ("providerConnectionId", "actorId", "clientRequestKeyHash")
  WHERE "providerConnectionId" IS NOT NULL;
CREATE UNIQUE INDEX "PlatformProviderProbeAttempt_subject_actorId_clientRequestKeyHash_key"
  ON "PlatformProviderProbeAttempt" ("subject", "actorId", "clientRequestKeyHash")
  WHERE "subject" IN ('draftConnection', 'routeOperation');
CREATE INDEX "PlatformProviderProbeAttempt_subject_targetOperation_idx"
  ON "PlatformProviderProbeAttempt" ("subject", "targetOperation", "status", "updatedAt");
CREATE INDEX "PlatformProviderProbeAttempt_evidenceExpiresAt_consumedAt_idx"
  ON "PlatformProviderProbeAttempt" ("evidenceExpiresAt", "consumedAt");
CREATE INDEX "PlatformProviderProbeAttempt_consumedProviderConnectionId_idx"
  ON "PlatformProviderProbeAttempt" ("consumedProviderConnectionId");
