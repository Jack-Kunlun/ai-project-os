-- External clients receive only a project-scoped, expiring read capability.
-- Raw bearer values are returned once and never stored in the database.
CREATE TABLE "McpExportGrant" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "ownerUserId" UUID NOT NULL,
  "ownerAccessVersion" INTEGER NOT NULL,
  "label" VARCHAR(80) NOT NULL,
  "tokenHash" CHAR(64) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "McpExportGrant_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "McpExportGrant_ownerAccessVersion_check" CHECK ("ownerAccessVersion" >= 1),
  CONSTRAINT "McpExportGrant_label_check" CHECK (length(btrim("label")) > 0),
  CONSTRAINT "McpExportGrant_tokenHash_check" CHECK ("tokenHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "McpExportGrant_lifetime_check" CHECK ("expiresAt" > "createdAt"),
  CONSTRAINT "McpExportGrant_revoke_check" CHECK ("revokedAt" IS NULL OR "revokedAt" >= "createdAt")
);

CREATE UNIQUE INDEX "McpExportGrant_tokenHash_key" ON "McpExportGrant"("tokenHash");
CREATE INDEX "McpExportGrant_ownerUserId_createdAt_idx" ON "McpExportGrant"("ownerUserId", "createdAt");
CREATE INDEX "McpExportGrant_projectId_expiresAt_idx" ON "McpExportGrant"("projectId", "expiresAt");
ALTER TABLE "McpExportGrant"
  ADD CONSTRAINT "McpExportGrant_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "McpExportGrant"
  ADD CONSTRAINT "McpExportGrant_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "AppUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A short-lived, single-use Owner approval binds the recipient declaration,
-- fixed operation and exact content version before a tool call can disclose it.
CREATE TABLE "McpExportApproval" (
  "id" UUID NOT NULL,
  "grantId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "ownerUserId" UUID NOT NULL,
  "ownerAccessVersion" INTEGER NOT NULL,
  "recipientLabel" VARCHAR(80) NOT NULL,
  "provider" VARCHAR(80) NOT NULL,
  "model" VARCHAR(80) NOT NULL,
  "operation" VARCHAR(64) NOT NULL,
  "inputFingerprint" CHAR(64) NOT NULL,
  "contentFingerprint" CHAR(64) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "approvedAt" TIMESTAMP(3),
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "McpExportApproval_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "McpExportApproval_epoch_check" CHECK ("ownerAccessVersion" >= 1),
  CONSTRAINT "McpExportApproval_operation_check" CHECK ("operation" IN ('project_summary', 'project_evidence', 'project_plan')),
  CONSTRAINT "McpExportApproval_labels_check" CHECK (length(btrim("recipientLabel")) > 0 AND length(btrim("provider")) > 0 AND length(btrim("model")) > 0),
  CONSTRAINT "McpExportApproval_inputFingerprint_check" CHECK ("inputFingerprint" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "McpExportApproval_contentFingerprint_check" CHECK ("contentFingerprint" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "McpExportApproval_lifetime_check" CHECK ("expiresAt" > "createdAt" AND "expiresAt" <= "createdAt" + INTERVAL '5 minutes'),
  CONSTRAINT "McpExportApproval_approval_check" CHECK ("approvedAt" IS NULL OR ("approvedAt" >= "createdAt" AND "approvedAt" < "expiresAt")),
  CONSTRAINT "McpExportApproval_consume_check" CHECK ("consumedAt" IS NULL OR ("approvedAt" IS NOT NULL AND "consumedAt" >= "approvedAt" AND "consumedAt" < "expiresAt"))
);
CREATE INDEX "McpExportApproval_grantId_expiresAt_approvedAt_consumedAt_idx" ON "McpExportApproval"("grantId", "expiresAt", "approvedAt", "consumedAt");
CREATE INDEX "McpExportApproval_projectId_createdAt_idx" ON "McpExportApproval"("projectId", "createdAt");
ALTER TABLE "McpExportApproval" ADD CONSTRAINT "McpExportApproval_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "McpExportGrant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "McpExportApproval" ADD CONSTRAINT "McpExportApproval_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "McpExportApproval" ADD CONSTRAINT "McpExportApproval_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "AppUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The audit records that the server prepared a response for dispatch. It
-- intentionally does not claim that the remote client received the bytes.
CREATE TABLE "McpExportDispatchAudit" (
  "id" UUID NOT NULL,
  "approvalId" UUID NOT NULL,
  "grantId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "ownerUserId" UUID NOT NULL,
  "recipientLabel" VARCHAR(80) NOT NULL,
  "provider" VARCHAR(80) NOT NULL,
  "model" VARCHAR(80) NOT NULL,
  "operation" VARCHAR(64) NOT NULL,
  "inputFingerprint" CHAR(64) NOT NULL,
  "contentFingerprint" CHAR(64) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "McpExportDispatchAudit_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "McpExportDispatchAudit_operation_check" CHECK ("operation" IN ('project_summary', 'project_evidence', 'project_plan')),
  CONSTRAINT "McpExportDispatchAudit_inputFingerprint_check" CHECK ("inputFingerprint" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "McpExportDispatchAudit_contentFingerprint_check" CHECK ("contentFingerprint" ~ '^[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX "McpExportDispatchAudit_approvalId_key" ON "McpExportDispatchAudit"("approvalId");
CREATE INDEX "McpExportDispatchAudit_projectId_createdAt_idx" ON "McpExportDispatchAudit"("projectId", "createdAt");
CREATE INDEX "McpExportDispatchAudit_ownerUserId_createdAt_idx" ON "McpExportDispatchAudit"("ownerUserId", "createdAt");

CREATE FUNCTION reject_mcp_export_dispatch_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'MCP export dispatch audit is immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER "McpExportDispatchAudit_immutable"
  BEFORE UPDATE OR DELETE ON "McpExportDispatchAudit"
  FOR EACH ROW EXECUTE FUNCTION reject_mcp_export_dispatch_audit_mutation();
