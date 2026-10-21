-- Display-only lifecycle. Immutable Q&A, citations, heads and audit records remain intact.
ALTER TABLE "UnifiedQuestionPresentationRevision"
  ADD COLUMN "archived" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "deleted" BOOLEAN NOT NULL DEFAULT false;
