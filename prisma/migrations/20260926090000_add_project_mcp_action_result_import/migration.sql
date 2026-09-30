CREATE TABLE "ProjectMcpActionResultImport" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "actionId" UUID NOT NULL,
    "dispatchResultId" UUID NOT NULL,
    "projectSourceId" UUID NOT NULL,
    "actionFingerprint" CHAR(64) NOT NULL,
    "actionRevision" CHAR(64) NOT NULL,
    "actionInputFingerprint" CHAR(64) NOT NULL,
    "resultFingerprint" CHAR(64) NOT NULL,
    "contentFingerprint" CHAR(64) NOT NULL,
    "importedById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProjectMcpActionResultImport_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ProjectMcpActionResultImport_fingerprint_check" CHECK (
        "actionFingerprint" ~ '^[0-9a-f]{64}$'
        AND "actionRevision" ~ '^[0-9a-f]{64}$'
        AND "actionInputFingerprint" ~ '^[0-9a-f]{64}$'
        AND "resultFingerprint" ~ '^[0-9a-f]{64}$'
        AND "contentFingerprint" ~ '^[0-9a-f]{64}$'
    )
);

CREATE UNIQUE INDEX "ProjectMcpActionResultImport_actionId_key"
    ON "ProjectMcpActionResultImport"("actionId");
CREATE UNIQUE INDEX "ProjectMcpActionResultImport_dispatchResultId_key"
    ON "ProjectMcpActionResultImport"("dispatchResultId");
CREATE UNIQUE INDEX "ProjectMcpActionResultImport_projectSourceId_key"
    ON "ProjectMcpActionResultImport"("projectSourceId");
CREATE UNIQUE INDEX "ProjectMcpActionResultImport_projectId_id_key"
    ON "ProjectMcpActionResultImport"("projectId", "id");
CREATE UNIQUE INDEX "ProjectMcpActionResultImport_projectId_actionId_key"
    ON "ProjectMcpActionResultImport"("projectId", "actionId");
CREATE UNIQUE INDEX "ProjectMcpActionResultImport_projectId_projectSourceId_key"
    ON "ProjectMcpActionResultImport"("projectId", "projectSourceId");
CREATE INDEX "ProjectMcpActionResultImport_projectId_createdAt_idx"
    ON "ProjectMcpActionResultImport"("projectId", "createdAt");
CREATE INDEX "ProjectMcpActionResultImport_importedById_createdAt_idx"
    ON "ProjectMcpActionResultImport"("importedById", "createdAt");

ALTER TABLE "ProjectMcpActionResultImport"
    ADD CONSTRAINT "ProjectMcpActionResultImport_projectId_fkey"
        FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "ProjectMcpActionResultImport_action_fkey"
        FOREIGN KEY ("actionId") REFERENCES "ProjectMcpAction"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "ProjectMcpActionResultImport_dispatchResult_fkey"
        FOREIGN KEY ("dispatchResultId") REFERENCES "ProjectMcpActionDispatchResult"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "ProjectMcpActionResultImport_projectSource_fkey"
        FOREIGN KEY ("projectSourceId") REFERENCES "ProjectSource"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "ProjectMcpActionResultImport_importedById_fkey"
        FOREIGN KEY ("importedById") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION "project_mcp_action_result_import_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    action_record RECORD;
    result_record RECORD;
    source_record RECORD;
    source_content JSONB;
    expected_content JSONB;
    expected_revision TEXT;
    expected_external_ref TEXT;
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF EXISTS (SELECT 1 FROM "Project" WHERE "id" = OLD."projectId") THEN
            RAISE EXCEPTION 'project MCP action result imports are append-only'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN OLD;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'project MCP action result imports are immutable'
            USING ERRCODE = 'check_violation';
    END IF;

    SELECT source.*
      INTO action_record
      FROM "ProjectMcpAction" AS source
     WHERE source."id" = NEW."actionId";
    IF NOT FOUND
       OR action_record."projectId" <> NEW."projectId"
       OR action_record."status"::text <> 'succeeded'
       OR action_record."stateVersion" <> 4
       OR action_record."actionFingerprint" <> NEW."actionFingerprint"
       OR action_record."canonicalArgumentsHash" <> NEW."actionInputFingerprint" THEN
        RAISE EXCEPTION 'only the current successful MCP action can be imported'
            USING ERRCODE = 'check_violation';
    END IF;

    expected_revision := encode(
        digest(convert_to('project-mcp-action-revision:v1:' || action_record."actionFingerprint", 'UTF8'), 'sha256'),
        'hex'
    );
    IF expected_revision <> NEW."actionRevision" THEN
        RAISE EXCEPTION 'project MCP action result import revision is invalid'
            USING ERRCODE = 'check_violation';
    END IF;

    SELECT source.*
      INTO result_record
      FROM "ProjectMcpActionDispatchResult" AS source
     WHERE source."id" = NEW."dispatchResultId";
    IF NOT FOUND
       OR result_record."projectId" <> NEW."projectId"
       OR result_record."actionId" <> NEW."actionId"
       OR result_record."resultFingerprint" <> NEW."resultFingerprint"
       OR result_record."createdAt" <> action_record."transitionAt" THEN
        RAISE EXCEPTION 'project MCP action result import payload is stale'
            USING ERRCODE = 'check_violation';
    END IF;

    expected_external_ref := 'https://ai-project-os.invalid/projects/' || NEW."projectId"::text || '/mcp-actions/' || NEW."actionId"::text;
    SELECT source.*
      INTO source_record
      FROM "ProjectSource" AS source
     WHERE source."id" = NEW."projectSourceId";
    IF NOT FOUND
       OR source_record."projectId" <> NEW."projectId"
       OR source_record."kind"::text <> 'manual'
       OR source_record."originScope"::text <> 'project'
       OR source_record."projectRepositoryLinkId" IS NOT NULL
       OR source_record."sourceIdentity" <> NEW."actionId"
       OR source_record."revisionKey" <> NEW."actionId"
       OR source_record."externalRef" IS DISTINCT FROM expected_external_ref
       OR source_record."contentHash" <> NEW."contentFingerprint"
       OR source_record."contentHash" <> encode(digest(convert_to(source_record."contentText", 'UTF8'), 'sha256'), 'hex')
       OR source_record."capturedAt" IS DISTINCT FROM action_record."transitionAt"
       OR source_record."retiredAt" IS NOT NULL
       OR char_length(source_record."contentText") > 100000
       OR octet_length(convert_to(source_record."contentText", 'UTF8')) > 400000 THEN
        RAISE EXCEPTION 'project MCP action result source provenance is invalid'
            USING ERRCODE = 'check_violation';
    END IF;

    BEGIN
        source_content := source_record."contentText"::jsonb;
    EXCEPTION WHEN invalid_text_representation THEN
        RAISE EXCEPTION 'project MCP action result source content is invalid'
            USING ERRCODE = 'check_violation';
    END;

    expected_content := jsonb_build_object(
        'schemaVersion', 'ai-project-os/project-mcp-action-result/v1',
        'action', jsonb_build_object(
            'id', action_record."id"::text,
            'revision', NEW."actionRevision",
            'fingerprint', action_record."actionFingerprint",
            'stateVersion', action_record."stateVersion",
            'completedAt', to_char(action_record."transitionAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        ),
        'input', jsonb_build_object('fingerprint', action_record."canonicalArgumentsHash"),
        'tool', jsonb_build_object('name', action_record."toolName"),
        'result', jsonb_build_object(
            'fingerprint', result_record."resultFingerprint",
            'payload', result_record."sanitizedPayload"
        )
    );
    IF source_content IS DISTINCT FROM expected_content THEN
        RAISE EXCEPTION 'project MCP action result source content does not match its provenance'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "ProjectMcpActionResultImport_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "ProjectMcpActionResultImport"
FOR EACH ROW EXECUTE FUNCTION "project_mcp_action_result_import_guard"();

REVOKE ALL ON FUNCTION "project_mcp_action_result_import_guard"() FROM PUBLIC;
