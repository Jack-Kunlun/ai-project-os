-- Bind runtime grants and memory-index generations to the exact effective
-- route that was admitted.  Legacy rows remain readable for migration
-- compatibility, but new runtime writes populate every snapshot field.
ALTER TABLE "WebAiGrant"
  ADD COLUMN "routeSource" VARCHAR(32),
  ADD COLUMN "routeId" UUID,
  ADD COLUMN "routeVersion" INTEGER,
  ADD COLUMN "routeUpdatedAt" TIMESTAMP(3),
  ADD COLUMN "providerConfigurationVersion" INTEGER,
  ADD COLUMN "quotaMultiplierBps" INTEGER,
  ADD COLUMN "routeFenceFingerprint" CHAR(64);

ALTER TABLE "WebAiGrant"
  ADD CONSTRAINT "WebAiGrant_route_snapshot_check" CHECK (
    ("routeSource" IS NULL AND "routeId" IS NULL AND "routeVersion" IS NULL
      AND "routeUpdatedAt" IS NULL AND "providerConfigurationVersion" IS NULL
      AND "quotaMultiplierBps" IS NULL
      AND "routeFenceFingerprint" IS NULL)
    OR (
      "routeSource" IS NOT NULL
      AND "routeSource" IN ('project_override', 'platform_default')
      AND "routeUpdatedAt" IS NOT NULL
      AND "providerConfigurationVersion" IS NOT NULL
      AND "providerConfigurationVersion" > 0
      AND "quotaMultiplierBps" IS NOT NULL
      AND "quotaMultiplierBps" BETWEEN 1 AND 100000
      AND "routeFenceFingerprint" IS NOT NULL
      AND "routeFenceFingerprint" ~ '^[0-9a-f]{64}$'
      AND (("routeSource" = 'platform_default' AND "routeId" IS NOT NULL AND "routeVersion" IS NOT NULL AND "routeVersion" > 0)
        OR ("routeSource" = 'project_override' AND "routeId" IS NULL AND "routeVersion" IS NULL))
    )
  );

CREATE INDEX "WebAiGrant_route_snapshot_idx"
  ON "WebAiGrant"("projectId", "operation", "routeSource", "routeVersion", "routeUpdatedAt");

ALTER TABLE "MemoryIndexGeneration"
  ADD COLUMN "expectedEmbeddingRouteSource" VARCHAR(32),
  ADD COLUMN "expectedEmbeddingRouteId" UUID,
  ADD COLUMN "expectedEmbeddingRouteVersion" INTEGER,
  ADD COLUMN "expectedEmbeddingProviderConfigurationVersion" INTEGER,
  ADD COLUMN "expectedEmbeddingRouteFenceFingerprint" CHAR(64);

ALTER TABLE "MemoryIndexGeneration"
  ADD CONSTRAINT "MemoryIndexGeneration_embedding_route_snapshot_check" CHECK (
    -- The five columns introduced by this migration were absent from the
    -- pre-0600 schema. Preserve every historical combination of the older
    -- jobId/timestamp fields while keeping such rows legacy-only at runtime.
    ("expectedEmbeddingRouteSource" IS NULL
      AND "expectedEmbeddingRouteId" IS NULL
      AND "expectedEmbeddingRouteVersion" IS NULL
      AND "expectedEmbeddingProviderConfigurationVersion" IS NULL
      AND "expectedEmbeddingRouteFenceFingerprint" IS NULL)
    OR (
      "jobId" IS NOT NULL
      AND "expectedEmbeddingRouteSource" IS NOT NULL
      AND "expectedEmbeddingRouteSource" IN ('project_override', 'platform_default')
      AND "expectedEmbeddingRouteUpdatedAt" IS NOT NULL
      AND "expectedEmbeddingProviderConfigurationVersion" IS NOT NULL
      AND "expectedEmbeddingProviderConfigurationVersion" > 0
      AND "expectedEmbeddingRouteFenceFingerprint" IS NOT NULL
      AND "expectedEmbeddingRouteFenceFingerprint" ~ '^[0-9a-f]{64}$'
      AND (("expectedEmbeddingRouteSource" = 'platform_default'
          AND "expectedEmbeddingRouteId" IS NOT NULL
          AND "expectedEmbeddingRouteVersion" IS NOT NULL
          AND "expectedEmbeddingRouteVersion" > 0)
        OR ("expectedEmbeddingRouteSource" = 'project_override'
          AND "expectedEmbeddingRouteId" IS NULL
          AND "expectedEmbeddingRouteVersion" IS NULL))
    )
  );

CREATE INDEX "MemoryIndexGeneration_embedding_route_snapshot_idx"
  ON "MemoryIndexGeneration"("projectId", "expectedEmbeddingRouteSource", "expectedEmbeddingRouteVersion");

-- The older generation lifecycle trigger predates the route snapshot columns.
-- Keep its approved complete->superseded and unknown-reconciliation transitions,
-- but make the full route fence immutable as soon as a job-backed generation is
-- inserted.  This prevents a direct SQL caller from changing the route during
-- staging/building and publishing a different provider snapshot.  Legacy
-- generations (jobId IS NULL), plus pre-0600 partial job-backed rows,
-- remain readable for upgrade compatibility.
CREATE OR REPLACE FUNCTION "memory_index_generation_route_snapshot_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  requires_complete_snapshot BOOLEAN := false;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD."jobId" IS DISTINCT FROM NEW."jobId" THEN
      RAISE EXCEPTION 'memory index generation job binding is immutable'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF TG_OP = 'INSERT' AND NEW."jobId" IS NOT NULL THEN
    requires_complete_snapshot := true;
  END IF;

  IF requires_complete_snapshot
     AND NOT (
       NEW."expectedEmbeddingRouteSource" IS NOT NULL
       AND NEW."expectedEmbeddingRouteSource" IN ('project_override', 'platform_default')
       AND NEW."expectedEmbeddingRouteUpdatedAt" IS NOT NULL
       AND NEW."expectedEmbeddingProviderConfigurationVersion" IS NOT NULL
       AND NEW."expectedEmbeddingProviderConfigurationVersion" > 0
       AND NEW."expectedEmbeddingRouteFenceFingerprint" IS NOT NULL
       AND NEW."expectedEmbeddingRouteFenceFingerprint" ~ '^[0-9a-f]{64}$'
       AND (
         (NEW."expectedEmbeddingRouteSource" = 'platform_default'
          AND NEW."expectedEmbeddingRouteId" IS NOT NULL
          AND NEW."expectedEmbeddingRouteVersion" IS NOT NULL
          AND NEW."expectedEmbeddingRouteVersion" > 0)
         OR (NEW."expectedEmbeddingRouteSource" = 'project_override'
          AND NEW."expectedEmbeddingRouteId" IS NULL
          AND NEW."expectedEmbeddingRouteVersion" IS NULL)
       )
     )
  THEN
    RAISE EXCEPTION 'new job-backed memory index generation requires a complete route snapshot'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."jobId" IS NOT NULL
     AND NEW."status" IN ('complete', 'failed', 'unknown', 'superseded')
     AND NOT (
       NEW."expectedEmbeddingRouteSource" IS NOT NULL
       AND NEW."expectedEmbeddingRouteSource" IN ('project_override', 'platform_default')
       AND NEW."expectedEmbeddingRouteUpdatedAt" IS NOT NULL
       AND NEW."expectedEmbeddingProviderConfigurationVersion" IS NOT NULL
       AND NEW."expectedEmbeddingProviderConfigurationVersion" > 0
       AND NEW."expectedEmbeddingRouteFenceFingerprint" IS NOT NULL
       AND NEW."expectedEmbeddingRouteFenceFingerprint" ~ '^[0-9a-f]{64}$'
       AND (
         (NEW."expectedEmbeddingRouteSource" = 'platform_default'
          AND NEW."expectedEmbeddingRouteId" IS NOT NULL
          AND NEW."expectedEmbeddingRouteVersion" IS NOT NULL
          AND NEW."expectedEmbeddingRouteVersion" > 0)
         OR (NEW."expectedEmbeddingRouteSource" = 'project_override'
          AND NEW."expectedEmbeddingRouteId" IS NULL
          AND NEW."expectedEmbeddingRouteVersion" IS NULL)
       )
     )
     AND NOT (
       -- Pre-0600 job-backed rows may retain their original partial snapshot,
       -- including a NULL route-updated timestamp. They are intentionally not
       -- runtime-compatible, but their historical terminal lifecycle must
       -- remain readable and updatable.
       NEW."expectedEmbeddingRouteSource" IS NULL
       AND NEW."expectedEmbeddingRouteId" IS NULL
       AND NEW."expectedEmbeddingRouteVersion" IS NULL
       AND NEW."expectedEmbeddingProviderConfigurationVersion" IS NULL
       AND NEW."expectedEmbeddingRouteFenceFingerprint" IS NULL
     )
  THEN
    RAISE EXCEPTION 'terminal memory index generation requires a complete route snapshot'
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD."jobId" IS NOT NULL
     AND (
       OLD."expectedEmbeddingRouteSource" IS DISTINCT FROM NEW."expectedEmbeddingRouteSource"
       OR OLD."expectedEmbeddingRouteId" IS DISTINCT FROM NEW."expectedEmbeddingRouteId"
       OR OLD."expectedEmbeddingRouteVersion" IS DISTINCT FROM NEW."expectedEmbeddingRouteVersion"
       OR OLD."expectedEmbeddingRouteUpdatedAt" IS DISTINCT FROM NEW."expectedEmbeddingRouteUpdatedAt"
       OR OLD."expectedEmbeddingProviderConfigurationVersion" IS DISTINCT FROM NEW."expectedEmbeddingProviderConfigurationVersion"
       OR OLD."expectedEmbeddingRouteFenceFingerprint" IS DISTINCT FROM NEW."expectedEmbeddingRouteFenceFingerprint"
     )
  THEN
    RAISE EXCEPTION 'memory index route snapshot is immutable'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "MemoryIndexGeneration_route_snapshot_guard"
BEFORE INSERT OR UPDATE ON "MemoryIndexGeneration"
FOR EACH ROW EXECUTE FUNCTION "memory_index_generation_route_snapshot_guard"();
