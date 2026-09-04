-- Add the control-plane version fence without changing existing provider rows.
ALTER TABLE "AiProviderConnection"
  ADD COLUMN "configurationVersion" INTEGER NOT NULL DEFAULT 1,
  ADD CONSTRAINT "AiProviderConnection_configuration_version_check"
    CHECK ("configurationVersion" > 0);

ALTER TABLE "PlatformDefaultAiRoute"
  ADD COLUMN "validatedProviderConfigurationVersion" INTEGER,
  ADD COLUMN "validatedAt" TIMESTAMP(3);

-- M300 kept legacy platform rows pending.  A newly confirmed platform-owned
-- provider is now also a valid control-plane target; no existing row is
-- rewritten by this migration.
ALTER TABLE "AiProviderConnection"
  DROP CONSTRAINT "AiProviderConnection_scope_check";

ALTER TABLE "AiProviderConnection"
  ADD CONSTRAINT "AiProviderConnection_scope_check"
    CHECK (("scope" = 'platform'
            AND "workspaceId" IS NULL
            AND "ownerUserId" IS NULL
            AND "ownershipState" IN ('legacy_pending', 'confirmed'))
        OR ("scope" = 'workspace'
            AND "workspaceId" IS NOT NULL
            AND "ownerUserId" IS NOT NULL
            AND "ownershipState" IN ('legacy_pending', 'ambiguous'))
        OR ("scope" = 'user'
            AND "workspaceId" IS NULL
            AND "ownerUserId" IS NOT NULL
            AND "ownershipState" = 'confirmed'));

CREATE TYPE "PlatformDefaultAiRouteAuditAction" AS ENUM (
  'draft_created',
  'draft_updated',
  'validated',
  'activated',
  'retired'
);

CREATE TABLE "PlatformDefaultAiRouteAudit" (
  "id" UUID NOT NULL,
  "action" "PlatformDefaultAiRouteAuditAction" NOT NULL,
  "routeId" UUID NOT NULL,
  "operation" "AiOperation" NOT NULL,
  "routeVersion" INTEGER NOT NULL,
  "providerConnectionId" UUID NOT NULL,
  "providerConfigurationVersion" INTEGER NOT NULL,
  "actorId" UUID NOT NULL,
  "reason" VARCHAR(500),
  "safeSnapshot" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PlatformDefaultAiRouteAudit_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PlatformDefaultAiRouteAudit_route_version_check" CHECK ("routeVersion" > 0),
  CONSTRAINT "PlatformDefaultAiRouteAudit_provider_configuration_version_check" CHECK ("providerConfigurationVersion" > 0)
);

CREATE INDEX "PlatformDefaultAiRouteAudit_routeId_createdAt_idx"
  ON "PlatformDefaultAiRouteAudit"("routeId", "createdAt");
CREATE INDEX "PlatformDefaultAiRouteAudit_operation_createdAt_idx"
  ON "PlatformDefaultAiRouteAudit"("operation", "createdAt");
CREATE INDEX "PlatformDefaultAiRouteAudit_providerConnectionId_createdAt_idx"
  ON "PlatformDefaultAiRouteAudit"("providerConnectionId", "createdAt");
CREATE INDEX "PlatformDefaultAiRouteAudit_actorId_createdAt_idx"
  ON "PlatformDefaultAiRouteAudit"("actorId", "createdAt");

ALTER TABLE "PlatformDefaultAiRouteAudit"
  ADD CONSTRAINT "PlatformDefaultAiRouteAudit_routeId_fkey"
    FOREIGN KEY ("routeId") REFERENCES "PlatformDefaultAiRoute"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PlatformDefaultAiRouteAudit_providerConnectionId_fkey"
    FOREIGN KEY ("providerConnectionId") REFERENCES "AiProviderConnection"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PlatformDefaultAiRouteAudit_actorId_fkey"
    FOREIGN KEY ("actorId") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION "PlatformDefaultAiRouteAudit_immutable_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'platform default AI route audit is immutable'
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER "PlatformDefaultAiRouteAudit_immutable_guard"
BEFORE UPDATE OR DELETE ON "PlatformDefaultAiRouteAudit"
FOR EACH ROW EXECUTE FUNCTION "PlatformDefaultAiRouteAudit_immutable_guard"();
