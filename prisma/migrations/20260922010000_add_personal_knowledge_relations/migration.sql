-- P03a adds explicit, owner-scoped personal knowledge relations.  Relations
-- capture both endpoint revisions so an edit makes an edge stale instead of
-- silently changing its meaning.
CREATE TYPE "PersonalKnowledgeRelationState" AS ENUM ('active', 'revoked');

CREATE TABLE "PersonalKnowledgeRelation" (
  "id" UUID NOT NULL,
  "ownerUserId" UUID NOT NULL,
  "fromDocumentId" UUID NOT NULL,
  "fromRevisionId" UUID NOT NULL,
  "toDocumentId" UUID NOT NULL,
  "toRevisionId" UUID NOT NULL,
  "state" "PersonalKnowledgeRelationState" NOT NULL DEFAULT 'active',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt" TIMESTAMP(3),
  CONSTRAINT "PersonalKnowledgeRelation_pkey" PRIMARY KEY ("id")
);

COMMENT ON TABLE "PersonalKnowledgeRelation" IS 'Owner-scoped explicit associations between personal knowledge documents; no AI-inferred edges.';
COMMENT ON COLUMN "PersonalKnowledgeRelation"."fromRevisionId" IS 'Revision captured when the relation was created; a later document edit marks the edge stale.';
COMMENT ON COLUMN "PersonalKnowledgeRelation"."toRevisionId" IS 'Revision captured when the relation was created; a later document edit marks the edge stale.';
COMMENT ON COLUMN "PersonalKnowledgeRelation"."revokedAt" IS 'Soft-revocation time; revoked edges remain as history and are never returned as active graph edges.';

CREATE UNIQUE INDEX "PersonalKnowledgeRevision_documentId_ownerUserId_id_key"
  ON "PersonalKnowledgeRevision" ("documentId", "ownerUserId", "id");
CREATE UNIQUE INDEX "PersonalKnowledgeRelation_ownerUserId_fromDocumentId_toDocumentId_active_key"
  ON "PersonalKnowledgeRelation" ("ownerUserId", "fromDocumentId", "toDocumentId")
  WHERE "state" = 'active';
CREATE UNIQUE INDEX "PersonalKnowledgeRelation_ownerUserId_id_key"
  ON "PersonalKnowledgeRelation" ("ownerUserId", "id");
CREATE INDEX "PersonalKnowledgeRelation_ownerUserId_state_fromDocumentId_toDocumentId_id_idx"
  ON "PersonalKnowledgeRelation" ("ownerUserId", "state", "fromDocumentId", "toDocumentId", "id");
CREATE INDEX "PersonalKnowledgeRelation_ownerUserId_state_toDocumentId_fromDocumentId_id_idx"
  ON "PersonalKnowledgeRelation" ("ownerUserId", "state", "toDocumentId", "fromDocumentId", "id");

ALTER TABLE "PersonalKnowledgeRelation"
  ADD CONSTRAINT "PersonalKnowledgeRelation_ownerUserId_fkey"
  FOREIGN KEY ("ownerUserId") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PersonalKnowledgeRelation_fromDocument_owner_fkey"
  FOREIGN KEY ("fromDocumentId", "ownerUserId") REFERENCES "PersonalKnowledgeDocument"("id", "ownerUserId") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PersonalKnowledgeRelation_fromRevision_owner_document_fkey"
  FOREIGN KEY ("fromDocumentId", "ownerUserId", "fromRevisionId") REFERENCES "PersonalKnowledgeRevision"("documentId", "ownerUserId", "id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PersonalKnowledgeRelation_toDocument_owner_fkey"
  FOREIGN KEY ("toDocumentId", "ownerUserId") REFERENCES "PersonalKnowledgeDocument"("id", "ownerUserId") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "PersonalKnowledgeRelation_toRevision_owner_document_fkey"
  FOREIGN KEY ("toDocumentId", "ownerUserId", "toRevisionId") REFERENCES "PersonalKnowledgeRevision"("documentId", "ownerUserId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "PersonalKnowledgeRelation"
  ADD CONSTRAINT "PersonalKnowledgeRelation_endpoint_order_check" CHECK ("fromDocumentId" < "toDocumentId"),
  ADD CONSTRAINT "PersonalKnowledgeRelation_state_revokedAt_check" CHECK (
    ("state" = 'active' AND "revokedAt" IS NULL)
    OR ("state" = 'revoked' AND "revokedAt" IS NOT NULL)
  );

-- A soft-deleted document cannot leave an active edge pointing at its
-- tombstone.  This database guard keeps the invariant for callers outside the
-- application service while remaining in the same transaction as the delete.
CREATE OR REPLACE FUNCTION "personal_knowledge_relation_revoke_on_document_delete"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."state" = 'deleted' AND OLD."state" = 'active' THEN
    UPDATE "PersonalKnowledgeRelation"
       SET "state" = 'revoked', "revokedAt" = COALESCE(NEW."deletedAt", CURRENT_TIMESTAMP)
     WHERE "ownerUserId" = NEW."ownerUserId"
       AND "state" = 'active'
       AND ("fromDocumentId" = NEW."id" OR "toDocumentId" = NEW."id");
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "PersonalKnowledgeRelation_document_delete_guard"
AFTER UPDATE OF "state", "deletedAt" ON "PersonalKnowledgeDocument"
FOR EACH ROW EXECUTE FUNCTION "personal_knowledge_relation_revoke_on_document_delete"();
