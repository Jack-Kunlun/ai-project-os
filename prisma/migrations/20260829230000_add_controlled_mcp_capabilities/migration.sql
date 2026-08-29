ALTER TYPE "ExternalCredentialKind" ADD VALUE 'mcp';

CREATE TYPE "McpAuthKind" AS ENUM ('none', 'bearer');
CREATE TYPE "McpConnectionStatus" AS ENUM ('configured', 'verified', 'error', 'disabled');
CREATE TYPE "ProjectMcpToolGrantStatus" AS ENUM ('active', 'revoked');
CREATE TYPE "ProjectMcpToolGrantAuditEvent" AS ENUM ('granted', 'refreshed', 'revoked');

CREATE TABLE "McpConnection" (
    "id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "endpointUrl" VARCHAR(1024) NOT NULL,
    "authKind" "McpAuthKind" NOT NULL,
    "credentialId" UUID,
    "allowPrivateNetwork" BOOLEAN NOT NULL DEFAULT false,
    "resolvedAddressFingerprint" CHAR(64),
    "protocolVersion" VARCHAR(16),
    "catalogFingerprint" CHAR(64),
    "status" "McpConnectionStatus" NOT NULL DEFAULT 'configured',
    "lastDiscoveredAt" TIMESTAMP(3),
    "lastErrorCode" VARCHAR(64),
    "disabledAt" TIMESTAMP(3),
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "McpConnection_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "McpConnection_auth_check" CHECK (
        ("authKind" = 'none' AND "credentialId" IS NULL)
        OR ("authKind" = 'bearer' AND "credentialId" IS NOT NULL)
    ),
    CONSTRAINT "McpConnection_fingerprint_check" CHECK (
        ("resolvedAddressFingerprint" IS NULL OR "resolvedAddressFingerprint" ~ '^[0-9a-f]{64}$')
        AND ("catalogFingerprint" IS NULL OR "catalogFingerprint" ~ '^[0-9a-f]{64}$')
    )
);

CREATE TABLE "McpToolDefinition" (
    "id" UUID NOT NULL,
    "connectionId" UUID NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "title" VARCHAR(200),
    "description" TEXT,
    "inputSchema" JSONB NOT NULL,
    "outputSchema" JSONB,
    "annotations" JSONB NOT NULL DEFAULT '{}',
    "readOnlyEligible" BOOLEAN NOT NULL,
    "definitionFingerprint" CHAR(64) NOT NULL,
    "current" BOOLEAN NOT NULL DEFAULT true,
    "discoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supersededAt" TIMESTAMP(3),
    CONSTRAINT "McpToolDefinition_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "McpToolDefinition_name_check" CHECK ("name" ~ '^[A-Za-z0-9_.-]{1,128}$'),
    CONSTRAINT "McpToolDefinition_json_check" CHECK (
        jsonb_typeof("inputSchema") = 'object'
        AND ("outputSchema" IS NULL OR jsonb_typeof("outputSchema") = 'object')
        AND jsonb_typeof("annotations") = 'object'
    ),
    CONSTRAINT "McpToolDefinition_fingerprint_check" CHECK ("definitionFingerprint" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "McpToolDefinition_current_check" CHECK (
        ("current" AND "supersededAt" IS NULL)
        OR (NOT "current" AND "supersededAt" IS NOT NULL)
    )
);

CREATE TABLE "ProjectMcpToolGrant" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "connectionId" UUID NOT NULL,
    "toolName" VARCHAR(128) NOT NULL,
    "toolDefinitionId" UUID NOT NULL,
    "status" "ProjectMcpToolGrantStatus" NOT NULL DEFAULT 'active',
    "managedById" UUID NOT NULL,
    "acknowledgedAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ProjectMcpToolGrant_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ProjectMcpToolGrant_state_check" CHECK (
        ("status" = 'active' AND "revokedAt" IS NULL)
        OR ("status" = 'revoked' AND "revokedAt" IS NOT NULL)
    )
);

CREATE TABLE "ProjectMcpToolGrantAudit" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "grantId" UUID NOT NULL,
    "event" "ProjectMcpToolGrantAuditEvent" NOT NULL,
    "actorId" UUID NOT NULL,
    "definitionFingerprint" CHAR(64) NOT NULL,
    "details" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProjectMcpToolGrantAudit_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ProjectMcpToolGrantAudit_fingerprint_check" CHECK ("definitionFingerprint" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "ProjectMcpToolGrantAudit_details_check" CHECK (jsonb_typeof("details") = 'object')
);

CREATE UNIQUE INDEX "McpConnection_name_key" ON "McpConnection"("name");
CREATE UNIQUE INDEX "McpConnection_credentialId_key" ON "McpConnection"("credentialId");
CREATE INDEX "McpConnection_status_updatedAt_idx" ON "McpConnection"("status", "updatedAt");
CREATE INDEX "McpConnection_createdById_createdAt_idx" ON "McpConnection"("createdById", "createdAt");
CREATE UNIQUE INDEX "McpToolDefinition_connectionId_name_definitionFingerprint_key" ON "McpToolDefinition"("connectionId", "name", "definitionFingerprint");
CREATE UNIQUE INDEX "McpToolDefinition_id_connectionId_name_key" ON "McpToolDefinition"("id", "connectionId", "name");
CREATE UNIQUE INDEX "McpToolDefinition_current_key" ON "McpToolDefinition"("connectionId", "name") WHERE "current";
CREATE INDEX "McpToolDefinition_connectionId_current_name_idx" ON "McpToolDefinition"("connectionId", "current", "name");
CREATE UNIQUE INDEX "ProjectMcpToolGrant_projectId_connectionId_toolName_key" ON "ProjectMcpToolGrant"("projectId", "connectionId", "toolName");
CREATE UNIQUE INDEX "ProjectMcpToolGrant_projectId_id_key" ON "ProjectMcpToolGrant"("projectId", "id");
CREATE INDEX "ProjectMcpToolGrant_projectId_status_updatedAt_idx" ON "ProjectMcpToolGrant"("projectId", "status", "updatedAt");
CREATE INDEX "ProjectMcpToolGrant_toolDefinitionId_idx" ON "ProjectMcpToolGrant"("toolDefinitionId");
CREATE INDEX "ProjectMcpToolGrant_managedById_updatedAt_idx" ON "ProjectMcpToolGrant"("managedById", "updatedAt");
CREATE INDEX "ProjectMcpToolGrantAudit_projectId_grantId_createdAt_idx" ON "ProjectMcpToolGrantAudit"("projectId", "grantId", "createdAt");
CREATE INDEX "ProjectMcpToolGrantAudit_actorId_createdAt_idx" ON "ProjectMcpToolGrantAudit"("actorId", "createdAt");

ALTER TABLE "McpConnection" ADD CONSTRAINT "McpConnection_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "ExternalCredential"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "McpConnection" ADD CONSTRAINT "McpConnection_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "McpToolDefinition" ADD CONSTRAINT "McpToolDefinition_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "McpConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectMcpToolGrant" ADD CONSTRAINT "ProjectMcpToolGrant_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectMcpToolGrant" ADD CONSTRAINT "ProjectMcpToolGrant_definition_fkey" FOREIGN KEY ("toolDefinitionId", "connectionId", "toolName") REFERENCES "McpToolDefinition"("id", "connectionId", "name") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "ProjectMcpToolGrant" ADD CONSTRAINT "ProjectMcpToolGrant_managedById_fkey" FOREIGN KEY ("managedById") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "ProjectMcpToolGrantAudit" ADD CONSTRAINT "ProjectMcpToolGrantAudit_grant_fkey" FOREIGN KEY ("projectId", "grantId") REFERENCES "ProjectMcpToolGrant"("projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectMcpToolGrantAudit" ADD CONSTRAINT "ProjectMcpToolGrantAudit_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "ProjectActionPolicy" DROP CONSTRAINT "ProjectActionPolicy_capability_check";
ALTER TABLE "ProjectActionPolicy" ADD CONSTRAINT "ProjectActionPolicy_capability_check" CHECK (
    "capability" IN ('project.repository.sync', 'project.web-source.sync', 'project.memory-quality.scan', 'project.mcp.read-tool.invoke')
);
ALTER TABLE "ProjectActionPolicy" ADD CONSTRAINT "ProjectActionPolicy_mcp_mode_check" CHECK (
    "capability" <> 'project.mcp.read-tool.invoke' OR "mode" <> 'automatic'
);

ALTER TABLE "ProjectActionPolicyRevision" DROP CONSTRAINT "ProjectActionPolicyRevision_capability_check";
ALTER TABLE "ProjectActionPolicyRevision" ADD CONSTRAINT "ProjectActionPolicyRevision_capability_check" CHECK (
    "capability" IN ('project.repository.sync', 'project.web-source.sync', 'project.memory-quality.scan', 'project.mcp.read-tool.invoke')
);
ALTER TABLE "ProjectActionPolicyRevision" ADD CONSTRAINT "ProjectActionPolicyRevision_mcp_mode_check" CHECK (
    "capability" <> 'project.mcp.read-tool.invoke' OR "currentMode" <> 'automatic'
);

ALTER TABLE "ProjectAction" DROP CONSTRAINT "ProjectAction_capability_check";
ALTER TABLE "ProjectAction" ADD CONSTRAINT "ProjectAction_capability_check" CHECK (
    "capability" IN ('project.repository.sync', 'project.web-source.sync', 'project.memory-quality.scan', 'project.mcp.read-tool.invoke')
);
ALTER TABLE "ProjectAction" ADD CONSTRAINT "ProjectAction_mcp_approval_check" CHECK (
    "capability" <> 'project.mcp.read-tool.invoke' OR "policyModeSnapshot" = 'approval_required'
);

CREATE OR REPLACE FUNCTION "mcp_tool_definition_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF NOT EXISTS (SELECT 1 FROM "McpConnection" WHERE "id" = OLD."connectionId") THEN
            RETURN OLD;
        END IF;
        RAISE EXCEPTION 'MCP tool definitions are append-only' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."id" <> NEW."id"
       OR OLD."connectionId" <> NEW."connectionId"
       OR OLD."name" <> NEW."name"
       OR OLD."title" IS DISTINCT FROM NEW."title"
       OR OLD."description" IS DISTINCT FROM NEW."description"
       OR OLD."inputSchema" <> NEW."inputSchema"
       OR OLD."outputSchema" IS DISTINCT FROM NEW."outputSchema"
       OR OLD."annotations" <> NEW."annotations"
       OR OLD."readOnlyEligible" <> NEW."readOnlyEligible"
       OR OLD."definitionFingerprint" <> NEW."definitionFingerprint"
       OR OLD."discoveredAt" <> NEW."discoveredAt" THEN
        RAISE EXCEPTION 'MCP tool definition identity is immutable' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "McpToolDefinition_guard"
BEFORE UPDATE OR DELETE ON "McpToolDefinition"
FOR EACH ROW EXECUTE FUNCTION "mcp_tool_definition_guard"();

CREATE OR REPLACE FUNCTION "project_mcp_tool_grant_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD."id" <> NEW."id"
       OR OLD."projectId" <> NEW."projectId"
       OR OLD."connectionId" <> NEW."connectionId"
       OR OLD."toolName" <> NEW."toolName"
       OR OLD."createdAt" <> NEW."createdAt" THEN
        RAISE EXCEPTION 'project MCP tool grant identity is immutable' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "ProjectMcpToolGrant_guard"
BEFORE UPDATE ON "ProjectMcpToolGrant"
FOR EACH ROW EXECUTE FUNCTION "project_mcp_tool_grant_guard"();

CREATE OR REPLACE FUNCTION "project_mcp_tool_grant_audit_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF EXISTS (
            SELECT 1
            FROM "ProjectMcpToolGrant" AS tool_grant
            JOIN "McpToolDefinition" AS definition ON definition."id" = tool_grant."toolDefinitionId"
            WHERE tool_grant."id" = NEW."grantId"
              AND tool_grant."projectId" = NEW."projectId"
              AND definition."definitionFingerprint" = NEW."definitionFingerprint"
        ) THEN
            RETURN NEW;
        END IF;
        RAISE EXCEPTION 'project MCP tool grant audit must match current grant' USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM "ProjectMcpToolGrant" WHERE "id" = OLD."grantId") THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'project MCP tool grant audit is immutable' USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER "ProjectMcpToolGrantAudit_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "ProjectMcpToolGrantAudit"
FOR EACH ROW EXECUTE FUNCTION "project_mcp_tool_grant_audit_guard"();
