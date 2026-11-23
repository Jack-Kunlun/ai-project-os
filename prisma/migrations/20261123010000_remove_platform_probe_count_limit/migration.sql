-- New probes have no budget. Historical attempts keep their original ledger and foreign keys.
BEGIN;

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

ALTER TABLE "PlatformProviderProbeLedger"
  DROP CONSTRAINT "PlatformProviderProbeLedger_shape_check",
  ADD CONSTRAINT "PlatformProviderProbeLedger_shape_check" CHECK (
    "ordinal" >= 0
    AND "units" >= 0
    AND (("event" = 'rejected' AND "ordinal" = 0 AND "capability" IS NULL AND "units" = 0)
      OR ("event" = 'reserved' AND "ordinal" > 0 AND "capability" IS NOT NULL AND "units" = 1)
      OR ("event" IN ('dispatched', 'settled', 'released', 'held') AND "ordinal" > 0 AND "capability" IS NOT NULL AND "units" = 1))
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
    AND ("dimensions" IS NULL OR "dimensions" BETWEEN 1 AND 8192)
  );

COMMIT;
