-- Record explicit administrator confirmation of legacy platform provider ownership.
-- The snapshot contains only safe state facts; no credential, name, or owner value
-- is copied into this append-only audit boundary.
CREATE TYPE "AiProviderOwnershipAuditAction" AS ENUM (
  'legacy_ownership_confirmed'
);

CREATE TABLE "AiProviderOwnershipAudit" (
  "id" UUID NOT NULL,
  "providerConnectionId" UUID NOT NULL,
  "actorId" UUID NOT NULL,
  "action" "AiProviderOwnershipAuditAction" NOT NULL,
  "reason" VARCHAR(500) NOT NULL,
  "oldScope" "AiProviderScope" NOT NULL,
  "newScope" "AiProviderScope" NOT NULL,
  "oldOwnershipState" "ResourceOwnershipState" NOT NULL,
  "newOwnershipState" "ResourceOwnershipState" NOT NULL,
  "oldWorkspacePresent" BOOLEAN NOT NULL,
  "newWorkspacePresent" BOOLEAN NOT NULL,
  "oldOwnerPresent" BOOLEAN NOT NULL,
  "newOwnerPresent" BOOLEAN NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AiProviderOwnershipAudit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AiProviderOwnershipAudit_providerConnectionId_createdAt_idx"
  ON "AiProviderOwnershipAudit"("providerConnectionId", "createdAt");
CREATE INDEX "AiProviderOwnershipAudit_actorId_createdAt_idx"
  ON "AiProviderOwnershipAudit"("actorId", "createdAt");
CREATE INDEX "AiProviderOwnershipAudit_action_createdAt_idx"
  ON "AiProviderOwnershipAudit"("action", "createdAt");

ALTER TABLE "AiProviderOwnershipAudit"
  ADD CONSTRAINT "AiProviderOwnershipAudit_providerConnectionId_fkey"
    FOREIGN KEY ("providerConnectionId") REFERENCES "AiProviderConnection"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "AiProviderOwnershipAudit_actorId_fkey"
    FOREIGN KEY ("actorId") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION "AiProviderOwnershipAudit_immutable_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'AI provider ownership audit is immutable'
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER "AiProviderOwnershipAudit_immutable_guard"
BEFORE UPDATE OR DELETE ON "AiProviderOwnershipAudit"
FOR EACH ROW EXECUTE FUNCTION "AiProviderOwnershipAudit_immutable_guard"();
