-- ProjectSource provenance is a versioned evidence record.  Only the lifecycle
-- marker may change after insertion; a new capture must create a new row.
CREATE OR REPLACE FUNCTION "project_source_provenance_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW."contentHash" <> encode(digest(convert_to(NEW."contentText", 'UTF8'), 'sha256'), 'hex') THEN
        RAISE EXCEPTION 'project source content hash does not match content'
            USING ERRCODE = 'check_violation';
    END IF;

    IF TG_OP = 'UPDATE' AND ROW(
        NEW."id", NEW."projectId", NEW."kind", NEW."originScope",
        NEW."projectRepositoryLinkId", NEW."externalRef", NEW."sourceIdentity",
        NEW."revisionKey", NEW."contentText", NEW."contentHash",
        NEW."manualContentDedupeKey", NEW."storageKey", NEW."capturedAt",
        NEW."ingestedAt"
    ) IS DISTINCT FROM ROW(
        OLD."id", OLD."projectId", OLD."kind", OLD."originScope",
        OLD."projectRepositoryLinkId", OLD."externalRef", OLD."sourceIdentity",
        OLD."revisionKey", OLD."contentText", OLD."contentHash",
        OLD."manualContentDedupeKey", OLD."storageKey", OLD."capturedAt",
        OLD."ingestedAt"
    ) THEN
        RAISE EXCEPTION 'project source provenance is immutable'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "ProjectSource_provenance_guard"
BEFORE INSERT OR UPDATE ON "ProjectSource"
FOR EACH ROW EXECUTE FUNCTION "project_source_provenance_guard"();

CREATE TYPE "McpToolAttestationAuditEvent" AS ENUM ('attested', 'revoked');

ALTER TABLE "ProjectMcpToolGrant"
    ADD COLUMN "attestationId" UUID,
    ADD COLUMN "definitionFingerprint" CHAR(64),
    ADD COLUMN "networkFingerprint" CHAR(64),
    ADD COLUMN "credentialFingerprint" CHAR(64),
    ADD CONSTRAINT "ProjectMcpToolGrant_attestation_fingerprint_check" CHECK (
        (
            "attestationId" IS NULL
            AND "definitionFingerprint" IS NULL
            AND "networkFingerprint" IS NULL
            AND "credentialFingerprint" IS NULL
        )
        OR (
            "attestationId" IS NOT NULL
            AND "definitionFingerprint" ~ '^[0-9a-f]{64}$'
            AND "networkFingerprint" ~ '^[0-9a-f]{64}$'
            AND "credentialFingerprint" ~ '^[0-9a-f]{64}$'
        )
    );

CREATE TABLE "McpToolAttestation" (
    "id" UUID NOT NULL,
    "connectionId" UUID NOT NULL,
    "toolDefinitionId" UUID NOT NULL,
    "toolName" VARCHAR(128) NOT NULL,
    "definitionFingerprint" CHAR(64) NOT NULL,
    "networkFingerprint" CHAR(64) NOT NULL,
    "credentialFingerprint" CHAR(64) NOT NULL,
    "verifiedById" UUID NOT NULL,
    "note" TEXT,
    "evidence" JSONB NOT NULL DEFAULT '{}',
    "attestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "McpToolAttestation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "McpToolAttestation_name_check" CHECK ("toolName" ~ '^[A-Za-z0-9_.-]{1,128}$'),
    CONSTRAINT "McpToolAttestation_fingerprint_check" CHECK (
        "definitionFingerprint" ~ '^[0-9a-f]{64}$'
        AND "networkFingerprint" ~ '^[0-9a-f]{64}$'
        AND "credentialFingerprint" ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT "McpToolAttestation_evidence_check" CHECK (jsonb_typeof("evidence") = 'object')
);

CREATE TABLE "McpToolAttestationAudit" (
    "id" UUID NOT NULL,
    "attestationId" UUID NOT NULL,
    "connectionId" UUID NOT NULL,
    "toolDefinitionId" UUID NOT NULL,
    "event" "McpToolAttestationAuditEvent" NOT NULL,
    "actorId" UUID NOT NULL,
    "definitionFingerprint" CHAR(64) NOT NULL,
    "networkFingerprint" CHAR(64) NOT NULL,
    "credentialFingerprint" CHAR(64) NOT NULL,
    "details" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "McpToolAttestationAudit_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "McpToolAttestationAudit_fingerprint_check" CHECK (
        "definitionFingerprint" ~ '^[0-9a-f]{64}$'
        AND "networkFingerprint" ~ '^[0-9a-f]{64}$'
        AND "credentialFingerprint" ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT "McpToolAttestationAudit_details_check" CHECK (jsonb_typeof("details") = 'object')
);

CREATE INDEX "McpToolAttestation_connectionId_toolDefinitionId_createdAt_idx"
    ON "McpToolAttestation"("connectionId", "toolDefinitionId", "createdAt", "id");
CREATE INDEX "McpToolAttestation_verifiedById_createdAt_idx"
    ON "McpToolAttestation"("verifiedById", "createdAt");
CREATE INDEX "McpToolAttestationAudit_attestationId_createdAt_idx"
    ON "McpToolAttestationAudit"("attestationId", "createdAt", "id");
CREATE INDEX "McpToolAttestationAudit_connectionId_toolDefinitionId_createdAt_idx"
    ON "McpToolAttestationAudit"("connectionId", "toolDefinitionId", "createdAt");
CREATE INDEX "McpToolAttestationAudit_actorId_createdAt_idx"
    ON "McpToolAttestationAudit"("actorId", "createdAt");
CREATE INDEX "ProjectMcpToolGrant_attestationId_idx"
    ON "ProjectMcpToolGrant"("attestationId");

ALTER TABLE "McpToolAttestation"
    ADD CONSTRAINT "McpToolAttestation_connectionId_fkey"
        FOREIGN KEY ("connectionId") REFERENCES "McpConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "McpToolAttestation_definition_fkey"
        FOREIGN KEY ("toolDefinitionId", "connectionId", "toolName")
        REFERENCES "McpToolDefinition"("id", "connectionId", "name") ON DELETE NO ACTION ON UPDATE CASCADE,
    ADD CONSTRAINT "McpToolAttestation_verifiedById_fkey"
        FOREIGN KEY ("verifiedById") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "McpToolAttestationAudit"
    ADD CONSTRAINT "McpToolAttestationAudit_attestation_fkey"
        FOREIGN KEY ("attestationId") REFERENCES "McpToolAttestation"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "McpToolAttestationAudit_actorId_fkey"
        FOREIGN KEY ("actorId") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "ProjectMcpToolGrant"
    ADD CONSTRAINT "ProjectMcpToolGrant_attestationId_fkey"
        FOREIGN KEY ("attestationId") REFERENCES "McpToolAttestation"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION "mcp_tool_attestation_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF NOT EXISTS (SELECT 1 FROM "McpConnection" WHERE "id" = OLD."connectionId") THEN
            RETURN OLD;
        END IF;
        RAISE EXCEPTION 'MCP tool attestations are append-only'
            USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'MCP tool attestations are append-only'
            USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM "McpToolDefinition" AS definition
        JOIN "McpConnection" AS connection
          ON connection."id" = definition."connectionId"
        WHERE definition."id" = NEW."toolDefinitionId"
          AND definition."connectionId" = NEW."connectionId"
          AND definition."name" = NEW."toolName"
    ) THEN
        RAISE EXCEPTION 'MCP tool attestation must bind to the exact tool definition'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "McpToolAttestation_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "McpToolAttestation"
FOR EACH ROW EXECUTE FUNCTION "mcp_tool_attestation_guard"();

CREATE OR REPLACE FUNCTION "mcp_tool_attestation_audit_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NOT EXISTS (
            SELECT 1
            FROM "McpToolAttestation" AS attestation
            WHERE attestation."id" = NEW."attestationId"
              AND attestation."connectionId" = NEW."connectionId"
              AND attestation."toolDefinitionId" = NEW."toolDefinitionId"
              AND attestation."definitionFingerprint" = NEW."definitionFingerprint"
              AND attestation."networkFingerprint" = NEW."networkFingerprint"
              AND attestation."credentialFingerprint" = NEW."credentialFingerprint"
        ) THEN
            RAISE EXCEPTION 'MCP attestation audit must match the attestation snapshot'
                USING ERRCODE = 'check_violation';
        END IF;
        IF NEW."event" = 'attested' AND EXISTS (
            SELECT 1 FROM "McpToolAttestationAudit"
            WHERE "attestationId" = NEW."attestationId" AND "event" = 'attested'
        ) THEN
            RAISE EXCEPTION 'MCP attestation can only be attested once'
                USING ERRCODE = 'check_violation';
        END IF;
        IF NEW."event" = 'revoked' AND NOT EXISTS (
            SELECT 1 FROM "McpToolAttestationAudit"
            WHERE "attestationId" = NEW."attestationId" AND "event" = 'attested'
        ) THEN
            RAISE EXCEPTION 'MCP attestation must be attested before revocation'
                USING ERRCODE = 'check_violation';
        END IF;
        IF NEW."event" = 'revoked' AND EXISTS (
            SELECT 1 FROM "McpToolAttestationAudit"
            WHERE "attestationId" = NEW."attestationId" AND "event" = 'revoked'
        ) THEN
            RAISE EXCEPTION 'MCP attestation is already revoked'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;
    IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM "McpToolAttestation" WHERE "id" = OLD."attestationId") THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'MCP attestation audits are immutable'
        USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER "McpToolAttestationAudit_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "McpToolAttestationAudit"
FOR EACH ROW EXECUTE FUNCTION "mcp_tool_attestation_audit_guard"();

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
    IF NEW."attestationId" IS NULL AND (
        NEW."definitionFingerprint" IS NOT NULL
        OR NEW."networkFingerprint" IS NOT NULL
        OR NEW."credentialFingerprint" IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'project MCP tool grant attestation snapshot is incomplete' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" = 'active' THEN
        IF NEW."attestationId" IS NULL OR NOT EXISTS (
            SELECT 1
            FROM "McpToolAttestation" AS attestation
            JOIN "McpToolDefinition" AS definition
              ON definition."id" = attestation."toolDefinitionId"
             AND definition."connectionId" = attestation."connectionId"
             AND definition."name" = attestation."toolName"
            JOIN "McpConnection" AS connection
              ON connection."id" = attestation."connectionId"
            WHERE attestation."id" = NEW."attestationId"
              AND attestation."connectionId" = NEW."connectionId"
              AND attestation."toolName" = NEW."toolName"
              AND attestation."definitionFingerprint" = NEW."definitionFingerprint"
              AND attestation."networkFingerprint" = NEW."networkFingerprint"
              AND attestation."credentialFingerprint" = NEW."credentialFingerprint"
              AND definition."id" = NEW."toolDefinitionId"
              AND definition."current" = true
              AND connection."status" = 'verified'
              AND connection."resolvedAddressFingerprint" = NEW."networkFingerprint"
              AND NOT EXISTS (
                  SELECT 1 FROM "McpToolAttestationAudit" AS revoked
                  WHERE revoked."attestationId" = attestation."id" AND revoked."event" = 'revoked'
              )
        ) THEN
            RAISE EXCEPTION 'active project MCP tool grants require a current admin attestation' USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "project_action_mcp_attestation_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW."capability" = 'project.mcp.read-tool.invoke' AND NOT EXISTS (
        SELECT 1
        FROM "ProjectMcpToolGrant" AS tool_grant
        JOIN "McpToolAttestation" AS attestation
          ON attestation."id" = tool_grant."attestationId"
        JOIN "McpToolDefinition" AS definition
          ON definition."id" = tool_grant."toolDefinitionId"
        WHERE tool_grant."projectId" = NEW."projectId"
          AND tool_grant."id"::text = NEW."input"->>'grantId'
          AND attestation."id"::text = NEW."input"->>'attestationId'
          AND tool_grant."status" = 'active'
          AND definition."current" = true
          AND tool_grant."attestationId" IS NOT NULL
          AND NOT EXISTS (
              SELECT 1 FROM "McpToolAttestationAudit" AS revoked
              WHERE revoked."attestationId" = attestation."id" AND revoked."event" = 'revoked'
          )
    ) THEN
        RAISE EXCEPTION 'MCP actions require a current admin attestation' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "ProjectAction_mcp_attestation_guard"
BEFORE INSERT ON "ProjectAction"
FOR EACH ROW EXECUTE FUNCTION "project_action_mcp_attestation_guard"();
