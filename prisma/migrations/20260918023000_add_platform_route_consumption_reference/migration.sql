-- Preserve the first activated route for safe retries when an apply response
-- is lost after the transaction commits. The reference is immutable after
-- consumption and is only valid for route-operation evidence.

ALTER TABLE "PlatformProviderProbeAttempt"
  ADD COLUMN "consumedRouteId" UUID;

ALTER TABLE "PlatformProviderProbeAttempt"
  ADD CONSTRAINT "PlatformProviderProbeAttempt_consumed_route_fkey"
    FOREIGN KEY ("consumedRouteId") REFERENCES "PlatformDefaultAiRoute"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "PlatformProviderProbeAttempt"
  DROP CONSTRAINT "PlatformProviderProbeAttempt_shape_check";

ALTER TABLE "PlatformProviderProbeAttempt"
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
    AND ("consumedRouteId" IS NULL OR ("subject" = 'routeOperation' AND "consumedAt" IS NOT NULL))
    AND ("subject" <> 'routeOperation' OR "consumedAt" IS NULL OR "consumedRouteId" IS NOT NULL)
    AND ("subject" = 'savedConnection' OR "status" <> 'settled' OR "evidenceExpiresAt" IS NOT NULL)
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

CREATE INDEX "PlatformProviderProbeAttempt_consumedRouteId_idx"
  ON "PlatformProviderProbeAttempt" ("consumedRouteId");

CREATE OR REPLACE FUNCTION "platform_provider_probe_consumed_route_immutable_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (OLD."consumedRouteId" IS NOT NULL OR OLD."consumedAt" IS NOT NULL)
     AND NEW."consumedRouteId" IS DISTINCT FROM OLD."consumedRouteId" THEN
    RAISE EXCEPTION 'platform provider consumed route reference is immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "PlatformProviderProbeAttempt_consumed_route_immutable_guard"
BEFORE UPDATE ON "PlatformProviderProbeAttempt"
FOR EACH ROW EXECUTE FUNCTION "platform_provider_probe_consumed_route_immutable_guard"();
