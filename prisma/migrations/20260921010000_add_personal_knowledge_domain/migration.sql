-- T01 personal knowledge is an additive, owner-scoped domain. It does not
-- reuse Workspace or Project ownership and does not migrate existing sources.
CREATE TYPE "PersonalKnowledgeDocumentState" AS ENUM ('active', 'deleted');
CREATE TYPE "PersonalKnowledgeAuditEvent" AS ENUM ('created', 'revised', 'deleted', 'exported');

CREATE TABLE "PersonalKnowledgeDocument" (
  "id" UUID NOT NULL,
  "ownerUserId" UUID NOT NULL,
  "state" "PersonalKnowledgeDocumentState" NOT NULL DEFAULT 'active',
  "version" INTEGER NOT NULL DEFAULT 1,
  "currentRevisionId" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "deletedAt" TIMESTAMP(3),
  CONSTRAINT "PersonalKnowledgeDocument_pkey" PRIMARY KEY ("id")
);

COMMENT ON TABLE "PersonalKnowledgeDocument" IS 'Owner-scoped personal text knowledge documents; no workspace or project ownership.';
COMMENT ON COLUMN "PersonalKnowledgeDocument"."ownerUserId" IS 'AppUser owner and visibility root. Every read and mutation must predicate by this ID.';
COMMENT ON COLUMN "PersonalKnowledgeDocument"."version" IS 'Optimistic compare-and-swap version; increments exactly once per accepted revision.';
COMMENT ON COLUMN "PersonalKnowledgeDocument"."currentRevisionId" IS 'Current immutable revision ID; nullable only before the deferred commit-time integrity trigger runs inside the atomic create transaction.';
COMMENT ON COLUMN "PersonalKnowledgeDocument"."deletedAt" IS 'Soft-delete tombstone. Deleted documents are excluded from all active list, read, search and export paths.';

CREATE TABLE "PersonalKnowledgeRevision" (
  "id" UUID NOT NULL,
  "documentId" UUID NOT NULL,
  "ownerUserId" UUID NOT NULL,
  "version" INTEGER NOT NULL,
  "title" VARCHAR(240) NOT NULL,
  "content" TEXT NOT NULL,
  "contentHash" CHAR(64) NOT NULL,
  "byteCount" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PersonalKnowledgeRevision_pkey" PRIMARY KEY ("id")
);

COMMENT ON TABLE "PersonalKnowledgeRevision" IS 'Immutable owner-only title and body snapshots. Historical revisions are never project-visible.';
COMMENT ON COLUMN "PersonalKnowledgeRevision"."version" IS 'One-based monotonic revision number within a document.';
COMMENT ON COLUMN "PersonalKnowledgeRevision"."contentHash" IS 'SHA-256 hex digest of UTF-8 content, used for audit evidence and export headers.';
COMMENT ON COLUMN "PersonalKnowledgeRevision"."byteCount" IS 'UTF-8 byte length of content, not a token count.';

CREATE TABLE "PersonalKnowledgeAudit" (
  "id" UUID NOT NULL,
  "ownerUserId" UUID NOT NULL,
  "documentId" UUID NOT NULL,
  "revisionId" UUID NOT NULL,
  "event" "PersonalKnowledgeAuditEvent" NOT NULL,
  "schemaVersion" VARCHAR(32) NOT NULL,
  "contentHash" CHAR(64) NOT NULL,
  "byteCount" INTEGER NOT NULL,
  "references" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PersonalKnowledgeAudit_pkey" PRIMARY KEY ("id")
);

COMMENT ON TABLE "PersonalKnowledgeAudit" IS 'Append-only body-free evidence for personal knowledge create, revise, delete and export events.';
COMMENT ON COLUMN "PersonalKnowledgeAudit"."references" IS 'IDs and non-sensitive format metadata only; title and body are forbidden.';

CREATE TABLE "PersonalKnowledgeIndexPointer" (
  "documentId" UUID NOT NULL,
  "ownerUserId" UUID NOT NULL,
  "documentVersion" INTEGER NOT NULL,
  "invalidatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PersonalKnowledgeIndexPointer_pkey" PRIMARY KEY ("documentId")
);

COMMENT ON TABLE "PersonalKnowledgeIndexPointer" IS 'T03 reserved pointer. T01 only invalidates it; it stores no index body or embedding.';

CREATE UNIQUE INDEX "PersonalKnowledgeDocument_id_ownerUserId_key"
  ON "PersonalKnowledgeDocument" ("id", "ownerUserId");
CREATE UNIQUE INDEX "PersonalKnowledgeDocument_currentRevisionId_ownerUserId_key"
  ON "PersonalKnowledgeDocument" ("currentRevisionId", "ownerUserId");
CREATE INDEX "PersonalKnowledgeDocument_ownerUserId_state_updatedAt_id_idx"
  ON "PersonalKnowledgeDocument" ("ownerUserId", "state", "updatedAt", "id");
CREATE INDEX "PersonalKnowledgeDocument_ownerUserId_currentRevisionId_idx"
  ON "PersonalKnowledgeDocument" ("ownerUserId", "currentRevisionId");
CREATE UNIQUE INDEX "PersonalKnowledgeRevision_documentId_version_key"
  ON "PersonalKnowledgeRevision" ("documentId", "version");
CREATE UNIQUE INDEX "PersonalKnowledgeRevision_ownerUserId_id_key"
  ON "PersonalKnowledgeRevision" ("ownerUserId", "id");
CREATE INDEX "PersonalKnowledgeRevision_ownerUserId_documentId_version_idx"
  ON "PersonalKnowledgeRevision" ("ownerUserId", "documentId", "version");
CREATE UNIQUE INDEX "PersonalKnowledgeAudit_ownerUserId_id_key"
  ON "PersonalKnowledgeAudit" ("ownerUserId", "id");
CREATE INDEX "PersonalKnowledgeAudit_ownerUserId_documentId_createdAt_idx"
  ON "PersonalKnowledgeAudit" ("ownerUserId", "documentId", "createdAt");
CREATE INDEX "PersonalKnowledgeAudit_ownerUserId_event_createdAt_idx"
  ON "PersonalKnowledgeAudit" ("ownerUserId", "event", "createdAt");
CREATE UNIQUE INDEX "PersonalKnowledgeIndexPointer_ownerUserId_documentId_key"
  ON "PersonalKnowledgeIndexPointer" ("ownerUserId", "documentId");
CREATE UNIQUE INDEX "PersonalKnowledgeIndexPointer_documentId_ownerUserId_key"
  ON "PersonalKnowledgeIndexPointer" ("documentId", "ownerUserId");
CREATE INDEX "PersonalKnowledgeIndexPointer_ownerUserId_invalidatedAt_idx"
  ON "PersonalKnowledgeIndexPointer" ("ownerUserId", "invalidatedAt");

ALTER TABLE "PersonalKnowledgeDocument"
  ADD CONSTRAINT "PersonalKnowledgeDocument_ownerUserId_fkey"
  FOREIGN KEY ("ownerUserId") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "PersonalKnowledgeRevision"
  ADD CONSTRAINT "PersonalKnowledgeRevision_document_owner_fkey"
  FOREIGN KEY ("documentId", "ownerUserId") REFERENCES "PersonalKnowledgeDocument"("id", "ownerUserId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PersonalKnowledgeRevision"
  ADD CONSTRAINT "PersonalKnowledgeRevision_ownerUserId_fkey"
  FOREIGN KEY ("ownerUserId") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "PersonalKnowledgeDocument"
  ADD CONSTRAINT "PersonalKnowledgeDocument_currentRevision_owner_fkey"
  FOREIGN KEY ("currentRevisionId", "ownerUserId") REFERENCES "PersonalKnowledgeRevision"("id", "ownerUserId") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "PersonalKnowledgeAudit"
  ADD CONSTRAINT "PersonalKnowledgeAudit_document_owner_fkey"
  FOREIGN KEY ("documentId", "ownerUserId") REFERENCES "PersonalKnowledgeDocument"("id", "ownerUserId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PersonalKnowledgeAudit"
  ADD CONSTRAINT "PersonalKnowledgeAudit_revision_owner_fkey"
  FOREIGN KEY ("revisionId", "ownerUserId") REFERENCES "PersonalKnowledgeRevision"("id", "ownerUserId") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "PersonalKnowledgeAudit"
  ADD CONSTRAINT "PersonalKnowledgeAudit_ownerUserId_fkey"
  FOREIGN KEY ("ownerUserId") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "PersonalKnowledgeIndexPointer"
  ADD CONSTRAINT "PersonalKnowledgeIndexPointer_document_owner_fkey"
  FOREIGN KEY ("documentId", "ownerUserId") REFERENCES "PersonalKnowledgeDocument"("id", "ownerUserId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PersonalKnowledgeIndexPointer"
  ADD CONSTRAINT "PersonalKnowledgeIndexPointer_ownerUserId_fkey"
  FOREIGN KEY ("ownerUserId") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "PersonalKnowledgeDocument"
  ADD CONSTRAINT "PersonalKnowledgeDocument_version_check" CHECK ("version" > 0),
  ADD CONSTRAINT "PersonalKnowledgeDocument_state_delete_check" CHECK (
    ("state" = 'active' AND "deletedAt" IS NULL)
    OR ("state" = 'deleted' AND "deletedAt" IS NOT NULL)
  );
ALTER TABLE "PersonalKnowledgeRevision"
  ADD CONSTRAINT "PersonalKnowledgeRevision_version_check" CHECK ("version" > 0),
  ADD CONSTRAINT "PersonalKnowledgeRevision_content_size_check" CHECK (char_length("content") <= 100000),
  ADD CONSTRAINT "PersonalKnowledgeRevision_byte_count_check" CHECK ("byteCount" = octet_length("content") AND "byteCount" >= 0),
  ADD CONSTRAINT "PersonalKnowledgeRevision_hash_check" CHECK ("contentHash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "PersonalKnowledgeAudit"
  ADD CONSTRAINT "PersonalKnowledgeAudit_version_data_check" CHECK ("byteCount" >= 0 AND "contentHash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "PersonalKnowledgeIndexPointer"
  ADD CONSTRAINT "PersonalKnowledgeIndexPointer_version_check" CHECK ("documentVersion" > 0);

-- The constraint trigger validates the final persisted document and revision
-- rows at transaction commit. A create transaction may insert the document
-- with a null pointer and fill it after inserting revision 1, but an active
-- row cannot commit with a null or mismatched current revision.
CREATE OR REPLACE FUNCTION "personal_knowledge_document_current_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  document_owner UUID;
  document_state "PersonalKnowledgeDocumentState";
  document_version INTEGER;
  document_current_revision UUID;
  revision_owner UUID;
  revision_version INTEGER;
  revision_document UUID;
BEGIN
  SELECT document."ownerUserId", document."state", document."version", document."currentRevisionId"
    INTO document_owner, document_state, document_version, document_current_revision
    FROM "PersonalKnowledgeDocument" document
   WHERE document."id" = NEW."id";
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF document_state = 'active' AND document_current_revision IS NULL THEN
    RAISE EXCEPTION 'PERSONAL_KNOWLEDGE_CURRENT_REVISION_REQUIRED' USING ERRCODE = 'check_violation';
  END IF;
  IF document_current_revision IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT revision."ownerUserId", revision."version", revision."documentId"
    INTO revision_owner, revision_version, revision_document
    FROM "PersonalKnowledgeRevision" revision
   WHERE revision."id" = document_current_revision;
  IF revision_owner IS NULL
     OR revision_owner IS DISTINCT FROM document_owner
     OR revision_document IS DISTINCT FROM NEW."id"
     OR revision_version IS DISTINCT FROM document_version THEN
    RAISE EXCEPTION 'PERSONAL_KNOWLEDGE_CURRENT_REVISION_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER "PersonalKnowledgeDocument_current_guard"
AFTER INSERT OR UPDATE OF "ownerUserId", "state", "version", "currentRevisionId" ON "PersonalKnowledgeDocument"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "personal_knowledge_document_current_guard"();

-- Revision rows are append-only. A document soft delete does not touch them,
-- so this guard does not interfere with the supported delete path.
CREATE OR REPLACE FUNCTION "personal_knowledge_revision_immutable_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'PERSONAL_KNOWLEDGE_REVISION_IMMUTABLE' USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER "PersonalKnowledgeRevision_immutable_guard"
BEFORE UPDATE ON "PersonalKnowledgeRevision"
FOR EACH ROW EXECUTE FUNCTION "personal_knowledge_revision_immutable_guard"();

-- Audit rows are evidence and must be append-only. This is enforced in the
-- database so a caller that bypasses the application service cannot rewrite
-- or erase the event trail.
CREATE OR REPLACE FUNCTION "personal_knowledge_audit_immutable_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'PERSONAL_KNOWLEDGE_AUDIT_IMMUTABLE' USING ERRCODE = 'check_violation';
END;
$$;
CREATE TRIGGER "PersonalKnowledgeAudit_immutable_guard"
BEFORE UPDATE OR DELETE ON "PersonalKnowledgeAudit"
FOR EACH ROW EXECUTE FUNCTION "personal_knowledge_audit_immutable_guard"();

-- Audit references are deliberately a closed JSON shape. Values are checked
-- as JSON strings/numbers before the trigger accepts the row, which prevents
-- title/body fields or arbitrary metadata from being smuggled into evidence.
CREATE OR REPLACE FUNCTION "personal_knowledge_audit_references_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  refs JSONB := NEW."references";
  revision_id_text TEXT;
  previous_revision_id_text TEXT;
  version_text TEXT;
  previous_version_text TEXT;
  format_text TEXT;
  reference_key_count INTEGER;
BEGIN
  IF jsonb_typeof(refs) <> 'object' THEN
    RAISE EXCEPTION 'PERSONAL_KNOWLEDGE_AUDIT_REFERENCES_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."event" NOT IN ('created', 'revised', 'deleted', 'exported') THEN
    RAISE EXCEPTION 'PERSONAL_KNOWLEDGE_AUDIT_EVENT_INVALID' USING ERRCODE = 'check_violation';
  END IF;

  SELECT count(*) INTO reference_key_count FROM jsonb_object_keys(refs);
  revision_id_text := refs ->> 'revisionId';
  IF reference_key_count <> (CASE NEW."event"
      WHEN 'revised' THEN 4
      WHEN 'exported' THEN 3
      ELSE 2
    END)
    OR jsonb_typeof(refs -> 'revisionId') IS DISTINCT FROM 'string'
    OR revision_id_text IS NULL
    OR revision_id_text !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
    RAISE EXCEPTION 'PERSONAL_KNOWLEDGE_AUDIT_REFERENCES_INVALID' USING ERRCODE = 'check_violation';
  END IF;

  version_text := refs ->> 'version';
  IF jsonb_typeof(refs -> 'version') IS DISTINCT FROM 'number'
     OR version_text IS NULL
     OR version_text !~ '^[1-9][0-9]*$'
     OR version_text::numeric > 2147483647 THEN
    RAISE EXCEPTION 'PERSONAL_KNOWLEDGE_AUDIT_REFERENCES_INVALID' USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."event" = 'revised' THEN
    previous_revision_id_text := refs ->> 'previousRevisionId';
    previous_version_text := refs ->> 'previousVersion';
    IF jsonb_typeof(refs -> 'previousRevisionId') IS DISTINCT FROM 'string'
       OR previous_revision_id_text IS NULL
       OR previous_revision_id_text !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
       OR jsonb_typeof(refs -> 'previousVersion') IS DISTINCT FROM 'number'
       OR previous_version_text IS NULL
       OR previous_version_text !~ '^[1-9][0-9]*$'
       OR previous_version_text::numeric > 2147483647 THEN
      RAISE EXCEPTION 'PERSONAL_KNOWLEDGE_AUDIT_REFERENCES_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."event" = 'exported' THEN
    format_text := refs ->> 'format';
    IF jsonb_typeof(refs -> 'format') IS DISTINCT FROM 'string'
       OR format_text IS NULL
       OR format_text NOT IN ('markdown', 'text') THEN
      RAISE EXCEPTION 'PERSONAL_KNOWLEDGE_AUDIT_REFERENCES_INVALID' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
CREATE TRIGGER "PersonalKnowledgeAudit_references_guard"
BEFORE INSERT ON "PersonalKnowledgeAudit"
FOR EACH ROW EXECUTE FUNCTION "personal_knowledge_audit_references_guard"();
