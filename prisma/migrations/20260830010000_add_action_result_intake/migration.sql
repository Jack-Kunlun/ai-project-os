ALTER TYPE "ProjectSourceKind" ADD VALUE 'mcp';

CREATE TABLE "ProjectActionResultImport" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "actionId" UUID NOT NULL,
    "projectSourceId" UUID NOT NULL,
    "actionInputFingerprint" CHAR(64) NOT NULL,
    "resultFingerprint" CHAR(64) NOT NULL,
    "contentFingerprint" CHAR(64) NOT NULL,
    "importedById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProjectActionResultImport_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ProjectActionResultImport_fingerprint_check" CHECK (
        "actionInputFingerprint" ~ '^[0-9a-f]{64}$'
        AND "resultFingerprint" ~ '^[0-9a-f]{64}$'
        AND "contentFingerprint" ~ '^[0-9a-f]{64}$'
    )
);

CREATE UNIQUE INDEX "ProjectActionResultImport_actionId_key" ON "ProjectActionResultImport"("actionId");
CREATE UNIQUE INDEX "ProjectActionResultImport_projectSourceId_key" ON "ProjectActionResultImport"("projectSourceId");
CREATE UNIQUE INDEX "ProjectActionResultImport_projectId_id_key" ON "ProjectActionResultImport"("projectId", "id");
CREATE UNIQUE INDEX "ProjectActionResultImport_projectId_actionId_key" ON "ProjectActionResultImport"("projectId", "actionId");
CREATE UNIQUE INDEX "ProjectActionResultImport_projectId_projectSourceId_key" ON "ProjectActionResultImport"("projectId", "projectSourceId");
CREATE INDEX "ProjectActionResultImport_projectId_createdAt_idx" ON "ProjectActionResultImport"("projectId", "createdAt");
CREATE INDEX "ProjectActionResultImport_importedById_createdAt_idx" ON "ProjectActionResultImport"("importedById", "createdAt");

ALTER TABLE "ProjectActionResultImport" ADD CONSTRAINT "ProjectActionResultImport_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectActionResultImport" ADD CONSTRAINT "ProjectActionResultImport_action_fkey"
    FOREIGN KEY ("projectId", "actionId") REFERENCES "ProjectAction"("projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectActionResultImport" ADD CONSTRAINT "ProjectActionResultImport_source_fkey"
    FOREIGN KEY ("projectId", "projectSourceId") REFERENCES "ProjectSource"("projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectActionResultImport" ADD CONSTRAINT "ProjectActionResultImport_importedById_fkey"
    FOREIGN KEY ("importedById") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION "project_action_result_import_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    action_record RECORD;
    source_record RECORD;
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF EXISTS (SELECT 1 FROM "Project" WHERE "id" = OLD."projectId") THEN
            RAISE EXCEPTION 'project action result imports are append-only' USING ERRCODE = 'check_violation';
        END IF;
        RETURN OLD;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'project action result imports are immutable' USING ERRCODE = 'check_violation';
    END IF;

    SELECT "capability", "status"::text AS status, "inputFingerprint", "result"
      INTO action_record
      FROM "ProjectAction"
     WHERE "projectId" = NEW."projectId" AND "id" = NEW."actionId";
    IF action_record IS NULL
       OR action_record."capability" <> 'project.mcp.read-tool.invoke'
       OR action_record.status <> 'succeeded'
       OR action_record."inputFingerprint" <> NEW."actionInputFingerprint"
       OR action_record."result" IS NULL
       OR action_record."result"->>'resultFingerprint' <> NEW."resultFingerprint" THEN
        RAISE EXCEPTION 'only the current successful MCP action result can be imported' USING ERRCODE = 'check_violation';
    END IF;

    SELECT "kind"::text AS kind, "sourceIdentity", "revisionKey", "contentHash", "retiredAt"
      INTO source_record
      FROM "ProjectSource"
     WHERE "projectId" = NEW."projectId" AND "id" = NEW."projectSourceId";
    IF source_record IS NULL
       OR source_record.kind <> 'mcp'
       OR source_record."sourceIdentity" <> NEW."actionId"
       OR source_record."revisionKey" <> NEW."actionId"
       OR source_record."contentHash" <> NEW."contentFingerprint"
       OR source_record."retiredAt" IS NOT NULL THEN
        RAISE EXCEPTION 'MCP action result source identity is invalid' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "ProjectActionResultImport_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "ProjectActionResultImport"
FOR EACH ROW EXECUTE FUNCTION "project_action_result_import_guard"();
