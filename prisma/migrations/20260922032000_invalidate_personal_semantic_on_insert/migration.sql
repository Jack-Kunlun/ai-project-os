-- A document added after a semantic generation was published changes the
-- corpus even though its first revision is created through INSERT plus a
-- current-pointer update. Keep the owner fence stale from that first insert.
CREATE TRIGGER "PersonalKnowledgeSemanticDocument_invalidate_insert"
AFTER INSERT ON "PersonalKnowledgeDocument"
FOR EACH ROW EXECUTE FUNCTION "personal_knowledge_semantic_invalidate_owner"();
