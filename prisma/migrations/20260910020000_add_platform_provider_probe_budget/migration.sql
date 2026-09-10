-- ENT-002: isolated, bounded platform-provider probe budget and evidence.
-- No user token, runtime billing, project, workspace, or provider-call audit
-- relation is introduced by this migration.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE "PlatformProviderProbeBudgetStatus" AS ENUM ('draft', 'active', 'retired');
CREATE TYPE "PlatformProviderProbeAttemptStatus" AS ENUM ('rejected', 'reserved', 'running', 'settled', 'released', 'held');
CREATE TYPE "PlatformProviderProbeLedgerEvent" AS ENUM ('rejected', 'reserved', 'dispatched', 'settled', 'released', 'held');
CREATE TYPE "PlatformProviderProbeCapability" AS ENUM ('generation', 'embedding', 'vision');

CREATE TABLE "PlatformProviderProbeBudget" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "version" INTEGER NOT NULL,
  "status" "PlatformProviderProbeBudgetStatus" NOT NULL DEFAULT 'draft',
  "unitLimit" INTEGER NOT NULL,
  "alertThresholdUnits" INTEGER NOT NULL,
  "reservedUnits" INTEGER NOT NULL DEFAULT 0,
  "settledUnits" INTEGER NOT NULL DEFAULT 0,
  "heldUnits" INTEGER NOT NULL DEFAULT 0,
  "startsAt" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdById" UUID NOT NULL,
  "activatedById" UUID,
  "retiredById" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "activatedAt" TIMESTAMP(3),
  "retiredAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PlatformProviderProbeBudget_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PlatformProviderProbeBudget_shape_check" CHECK (
    "version" > 0
    AND "unitLimit" > 0
    AND "unitLimit" <= 10000
    AND "alertThresholdUnits" >= 0
    AND "alertThresholdUnits" <= "unitLimit"
    AND "reservedUnits" >= 0
    AND "settledUnits" >= 0
    AND "heldUnits" >= 0
    AND "reservedUnits" + "settledUnits" + "heldUnits" <= "unitLimit"
    AND "startsAt" < "expiresAt"
    AND (("status" = 'draft'
      AND "activatedAt" IS NULL AND "activatedById" IS NULL
      AND "retiredAt" IS NULL AND "retiredById" IS NULL)
      OR ("status" = 'active'
        AND "activatedAt" IS NOT NULL AND "activatedById" IS NOT NULL
        AND "retiredAt" IS NULL AND "retiredById" IS NULL)
      OR ("status" = 'retired'
        AND "activatedAt" IS NOT NULL AND "activatedById" IS NOT NULL
        AND "retiredAt" IS NOT NULL AND "retiredById" IS NOT NULL))
  ),
  CONSTRAINT "PlatformProviderProbeBudget_createdBy_fkey" FOREIGN KEY ("createdById") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "PlatformProviderProbeBudget_activatedBy_fkey" FOREIGN KEY ("activatedById") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "PlatformProviderProbeBudget_retiredBy_fkey" FOREIGN KEY ("retiredById") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "PlatformProviderProbeBudget_version_key" ON "PlatformProviderProbeBudget" ("version");
CREATE UNIQUE INDEX "PlatformProviderProbeBudget_active_key" ON "PlatformProviderProbeBudget" ("status") WHERE "status" = 'active';
CREATE INDEX "PlatformProviderProbeBudget_status_startsAt_expiresAt_idx" ON "PlatformProviderProbeBudget" ("status", "startsAt", "expiresAt");

CREATE TABLE "PlatformProviderProbeAttempt" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "budgetId" UUID,
  "providerConnectionId" UUID NOT NULL,
  "actorId" UUID NOT NULL,
  "actorAccountAccessVersion" INTEGER NOT NULL,
  "providerConfigurationVersion" INTEGER NOT NULL,
  "credentialSecretFingerprint" CHAR(64),
  "clientRequestKeyHash" CHAR(64) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "status" "PlatformProviderProbeAttemptStatus" NOT NULL,
  "safeErrorCode" VARCHAR(64),
  "plannedUnits" INTEGER NOT NULL,
  "dispatchedUnits" INTEGER NOT NULL DEFAULT 0,
  "settledUnits" INTEGER NOT NULL DEFAULT 0,
  "releasedUnits" INTEGER NOT NULL DEFAULT 0,
  "heldUnits" INTEGER NOT NULL DEFAULT 0,
  "leaseExpiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMP(3),
  "terminalAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PlatformProviderProbeAttempt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PlatformProviderProbeAttempt_shape_check" CHECK (
    "actorAccountAccessVersion" > 0
    AND "providerConfigurationVersion" > 0
    AND "clientRequestKeyHash" ~ '^[0-9a-f]{64}$'
    AND "requestFingerprint" ~ '^[0-9a-f]{64}$'
    AND ("credentialSecretFingerprint" IS NULL OR "credentialSecretFingerprint" ~ '^[0-9a-f]{64}$')
    AND "plannedUnits" BETWEEN 0 AND 3
    AND "dispatchedUnits" >= 0
    AND "settledUnits" >= 0
    AND "releasedUnits" >= 0
    AND "heldUnits" >= 0
    AND "dispatchedUnits" + "releasedUnits" <= "plannedUnits"
    AND "settledUnits" + "releasedUnits" + "heldUnits" <= "plannedUnits"
    AND ("plannedUnits" = 0 OR "budgetId" IS NOT NULL)
    AND ("status" = 'rejected' OR "budgetId" IS NOT NULL)
    AND ("status" = 'rejected' OR "credentialSecretFingerprint" IS NOT NULL)
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
  ),
  CONSTRAINT "PlatformProviderProbeAttempt_budget_fkey" FOREIGN KEY ("budgetId") REFERENCES "PlatformProviderProbeBudget"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "PlatformProviderProbeAttempt_provider_fkey" FOREIGN KEY ("providerConnectionId") REFERENCES "AiProviderConnection"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "PlatformProviderProbeAttempt_actor_fkey" FOREIGN KEY ("actorId") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "PlatformProviderProbeAttempt_providerConnectionId_actorId_clientRequestKeyHash_key"
  ON "PlatformProviderProbeAttempt" ("providerConnectionId", "actorId", "clientRequestKeyHash");
CREATE UNIQUE INDEX "PlatformProviderProbeAttempt_provider_active_key"
  ON "PlatformProviderProbeAttempt" ("providerConnectionId")
  WHERE "status" IN ('reserved', 'running');
CREATE INDEX "PlatformProviderProbeAttempt_providerConnectionId_status_updatedAt_idx"
  ON "PlatformProviderProbeAttempt" ("providerConnectionId", "status", "updatedAt");
CREATE INDEX "PlatformProviderProbeAttempt_actorId_createdAt_idx"
  ON "PlatformProviderProbeAttempt" ("actorId", "createdAt");
CREATE INDEX "PlatformProviderProbeAttempt_leaseExpiresAt_status_idx"
  ON "PlatformProviderProbeAttempt" ("leaseExpiresAt", "status");

CREATE TABLE "PlatformProviderProbeLedger" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "budgetId" UUID,
  "attemptId" UUID NOT NULL,
  "actorId" UUID NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "event" "PlatformProviderProbeLedgerEvent" NOT NULL,
  "capability" "PlatformProviderProbeCapability",
  "units" INTEGER NOT NULL,
  "safeErrorCode" VARCHAR(64),
  "dimensions" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PlatformProviderProbeLedger_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PlatformProviderProbeLedger_shape_check" CHECK (
    "ordinal" >= 0
    AND "units" >= 0
    AND ("event" = 'rejected' OR "budgetId" IS NOT NULL)
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
  ),
  CONSTRAINT "PlatformProviderProbeLedger_budget_fkey" FOREIGN KEY ("budgetId") REFERENCES "PlatformProviderProbeBudget"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "PlatformProviderProbeLedger_attempt_fkey" FOREIGN KEY ("attemptId") REFERENCES "PlatformProviderProbeAttempt"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "PlatformProviderProbeLedger_actor_fkey" FOREIGN KEY ("actorId") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "PlatformProviderProbeLedger_attemptId_ordinal_event_key"
  ON "PlatformProviderProbeLedger" ("attemptId", "ordinal", "event");
CREATE INDEX "PlatformProviderProbeLedger_actorId_createdAt_idx"
  ON "PlatformProviderProbeLedger" ("actorId", "createdAt");
CREATE INDEX "PlatformProviderProbeLedger_budgetId_createdAt_idx"
  ON "PlatformProviderProbeLedger" ("budgetId", "createdAt");
CREATE INDEX "PlatformProviderProbeLedger_attemptId_ordinal_idx"
  ON "PlatformProviderProbeLedger" ("attemptId", "ordinal");

CREATE OR REPLACE FUNCTION "platform_provider_probe_mutation_context_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_setting('ai_project_os.platform_provider_probe_mutation', true) IS DISTINCT FROM 'service-v1' THEN
    RAISE EXCEPTION 'platform provider probe mutation requires the governed service context' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "PlatformProviderProbeBudget_mutation_context_guard"
BEFORE INSERT OR UPDATE ON "PlatformProviderProbeBudget"
FOR EACH ROW EXECUTE FUNCTION "platform_provider_probe_mutation_context_guard"();

CREATE TRIGGER "PlatformProviderProbeAttempt_mutation_context_guard"
BEFORE INSERT OR UPDATE ON "PlatformProviderProbeAttempt"
FOR EACH ROW EXECUTE FUNCTION "platform_provider_probe_mutation_context_guard"();

CREATE TRIGGER "PlatformProviderProbeLedger_mutation_context_guard"
BEFORE INSERT ON "PlatformProviderProbeLedger"
FOR EACH ROW EXECUTE FUNCTION "platform_provider_probe_mutation_context_guard"();

CREATE OR REPLACE FUNCTION "platform_provider_probe_delete_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'platform provider probe safety records cannot be deleted' USING ERRCODE = 'restrict_violation';
  RETURN OLD;
END;
$$;

CREATE TRIGGER "PlatformProviderProbeBudget_delete_guard"
BEFORE DELETE ON "PlatformProviderProbeBudget"
FOR EACH ROW EXECUTE FUNCTION "platform_provider_probe_delete_guard"();

CREATE TRIGGER "PlatformProviderProbeAttempt_delete_guard"
BEFORE DELETE ON "PlatformProviderProbeAttempt"
FOR EACH ROW EXECUTE FUNCTION "platform_provider_probe_delete_guard"();

CREATE OR REPLACE FUNCTION "platform_provider_probe_ledger_immutable_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'platform provider probe ledger is append-only' USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER "PlatformProviderProbeLedger_immutable_guard"
BEFORE UPDATE OR DELETE ON "PlatformProviderProbeLedger"
FOR EACH ROW EXECUTE FUNCTION "platform_provider_probe_ledger_immutable_guard"();

CREATE OR REPLACE FUNCTION "platform_provider_probe_parity_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  affected_attempt_id UUID;
  affected_budget_id UUID;
  attempt_row RECORD;
  budget_row RECORD;
  reserved_total INTEGER;
  settled_total INTEGER;
  released_total INTEGER;
  held_total INTEGER;
BEGIN
  IF TG_TABLE_NAME = 'PlatformProviderProbeAttempt' THEN
    affected_attempt_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."id" ELSE NEW."id" END;
    affected_budget_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."budgetId" ELSE NEW."budgetId" END;
  ELSIF TG_TABLE_NAME = 'PlatformProviderProbeBudget' THEN
    affected_budget_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."id" ELSE NEW."id" END;
  ELSIF TG_TABLE_NAME = 'PlatformProviderProbeLedger' THEN
    affected_attempt_id := NEW."attemptId";
    affected_budget_id := NEW."budgetId";
  END IF;

  IF affected_attempt_id IS NOT NULL THEN
    SELECT * INTO attempt_row FROM "PlatformProviderProbeAttempt" WHERE "id" = affected_attempt_id;
    IF NOT FOUND THEN
      RETURN NULL;
    END IF;
    IF EXISTS (
      SELECT 1
        FROM "PlatformProviderProbeLedger" AS l
       WHERE l."attemptId" = attempt_row."id"
         AND (
           l."actorId" IS DISTINCT FROM attempt_row."actorId"
           OR (l."event" <> 'rejected'
             AND l."budgetId" IS DISTINCT FROM attempt_row."budgetId")
           OR (l."event" = 'rejected'
             AND attempt_row."status" <> 'rejected')
           OR (l."event" <> 'rejected'
             AND attempt_row."status" = 'rejected')
           OR (l."event" = 'rejected'
             AND l."budgetId" IS NOT NULL
             AND l."budgetId" IS DISTINCT FROM attempt_row."budgetId")
           OR (l."event" <> 'rejected' AND l."ordinal" > attempt_row."plannedUnits")
           OR (l."event" <> 'rejected' AND NOT EXISTS (
             SELECT 1
               FROM "PlatformProviderProbeLedger" AS reserved
              WHERE reserved."attemptId" = l."attemptId"
                AND reserved."event" = 'reserved'
                AND reserved."ordinal" = l."ordinal"
                AND reserved."capability" IS NOT DISTINCT FROM l."capability"
           ))
         )
    ) THEN
      RAISE EXCEPTION 'platform provider probe ledger binding failed' USING ERRCODE = 'check_violation';
    END IF;
    IF attempt_row."status" <> 'rejected' AND (
      SELECT count(*) FROM "PlatformProviderProbeLedger" AS l
       WHERE l."attemptId" = attempt_row."id" AND l."event" = 'reserved'
    ) <> attempt_row."plannedUnits" THEN
      RAISE EXCEPTION 'platform provider probe reservation parity failed' USING ERRCODE = 'check_violation';
    END IF;
    IF attempt_row."status" IN ('rejected', 'released', 'settled', 'held')
       AND attempt_row."plannedUnits" <> attempt_row."settledUnits" + attempt_row."releasedUnits" + attempt_row."heldUnits" THEN
      RAISE EXCEPTION 'platform provider probe attempt terminal parity failed' USING ERRCODE = 'check_violation';
    END IF;
    IF attempt_row."dispatchedUnits" <> (
      SELECT count(*) FROM "PlatformProviderProbeLedger" AS l
       WHERE l."attemptId" = attempt_row."id" AND l."event" = 'dispatched'
    ) THEN
      RAISE EXCEPTION 'platform provider probe dispatch parity failed' USING ERRCODE = 'check_violation';
    END IF;
    IF attempt_row."settledUnits" <> (
      SELECT count(*) FROM "PlatformProviderProbeLedger" AS l
       WHERE l."attemptId" = attempt_row."id" AND l."event" = 'settled'
    ) THEN
      RAISE EXCEPTION 'platform provider probe settle parity failed' USING ERRCODE = 'check_violation';
    END IF;
    IF attempt_row."releasedUnits" <> (
      SELECT count(*) FROM "PlatformProviderProbeLedger" AS l
       WHERE l."attemptId" = attempt_row."id" AND l."event" = 'released'
    ) THEN
      RAISE EXCEPTION 'platform provider probe release parity failed' USING ERRCODE = 'check_violation';
    END IF;
    IF attempt_row."heldUnits" <> (
      SELECT count(*) FROM "PlatformProviderProbeLedger" AS l
       WHERE l."attemptId" = attempt_row."id" AND l."event" = 'held'
    ) THEN
      RAISE EXCEPTION 'platform provider probe hold parity failed' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF affected_budget_id IS NOT NULL THEN
    SELECT * INTO budget_row FROM "PlatformProviderProbeBudget" WHERE "id" = affected_budget_id;
    IF NOT FOUND THEN
      RETURN NULL;
    END IF;
    SELECT
      COALESCE(sum(CASE WHEN l.event = 'reserved' THEN l.units ELSE 0 END), 0),
      COALESCE(sum(CASE WHEN l.event = 'settled' THEN l.units ELSE 0 END), 0),
      COALESCE(sum(CASE WHEN l.event = 'released' THEN l.units ELSE 0 END), 0),
      COALESCE(sum(CASE WHEN l.event = 'held' THEN l.units ELSE 0 END), 0)
      INTO reserved_total, settled_total, released_total, held_total
      FROM "PlatformProviderProbeLedger" AS l
     WHERE l."budgetId" = budget_row."id";
    IF budget_row."settledUnits" <> settled_total
       OR budget_row."heldUnits" <> held_total
       OR budget_row."reservedUnits" <> reserved_total - settled_total - released_total - held_total THEN
      RAISE EXCEPTION 'platform provider probe budget parity failed' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "PlatformProviderProbeBudget_parity_guard"
AFTER INSERT OR UPDATE ON "PlatformProviderProbeBudget"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION "platform_provider_probe_parity_guard"();

CREATE CONSTRAINT TRIGGER "PlatformProviderProbeAttempt_parity_guard"
AFTER INSERT OR UPDATE ON "PlatformProviderProbeAttempt"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION "platform_provider_probe_parity_guard"();

CREATE CONSTRAINT TRIGGER "PlatformProviderProbeLedger_parity_guard"
AFTER INSERT ON "PlatformProviderProbeLedger"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION "platform_provider_probe_parity_guard"();

CREATE OR REPLACE FUNCTION "platform_provider_probe_transition_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."event" IN ('settled', 'held') AND NOT EXISTS (
    SELECT 1 FROM "PlatformProviderProbeLedger" AS dispatched
     WHERE dispatched."attemptId" = NEW."attemptId"
       AND dispatched."ordinal" = NEW."ordinal"
       AND dispatched."event" = 'dispatched'
  ) THEN
    RAISE EXCEPTION 'platform provider probe terminal event requires dispatch marker' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."event" = 'released' AND EXISTS (
    SELECT 1 FROM "PlatformProviderProbeLedger" AS dispatched
     WHERE dispatched."attemptId" = NEW."attemptId"
       AND dispatched."ordinal" = NEW."ordinal"
       AND dispatched."event" = 'dispatched'
  ) THEN
    RAISE EXCEPTION 'platform provider probe release cannot follow dispatch' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "PlatformProviderProbeLedger_transition_guard"
AFTER INSERT ON "PlatformProviderProbeLedger"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION "platform_provider_probe_transition_guard"();
