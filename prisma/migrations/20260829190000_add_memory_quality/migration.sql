CREATE TYPE "MemoryQualityIssueKind" AS ENUM ('duplicate', 'conflict', 'stale', 'missing_evidence', 'low_confidence');
CREATE TYPE "MemoryQualityIssueStatus" AS ENUM ('open', 'resolved', 'dismissed');
ALTER TYPE "ProjectItemRevisionAction" ADD VALUE 'metadata_updated';

ALTER TABLE "ProjectItem"
  ADD COLUMN "confidence" DOUBLE PRECISION,
  ADD COLUMN "importance" INTEGER NOT NULL DEFAULT 50,
  ADD COLUMN "validFrom" TIMESTAMP(3),
  ADD COLUMN "validUntil" TIMESTAMP(3),
  ADD COLUMN "pinned" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "lastVerifiedAt" TIMESTAMP(3);

ALTER TABLE "ProjectItemRevision"
  ADD COLUMN "confidence" DOUBLE PRECISION,
  ADD COLUMN "importance" INTEGER NOT NULL DEFAULT 50,
  ADD COLUMN "validFrom" TIMESTAMP(3),
  ADD COLUMN "validUntil" TIMESTAMP(3),
  ADD COLUMN "pinned" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "lastVerifiedAt" TIMESTAMP(3);

ALTER TABLE "ProjectItem"
  ADD CONSTRAINT "ProjectItem_confidence_check" CHECK ("confidence" IS NULL OR "confidence" BETWEEN 0 AND 1),
  ADD CONSTRAINT "ProjectItem_importance_check" CHECK ("importance" BETWEEN 0 AND 100),
  ADD CONSTRAINT "ProjectItem_validity_check" CHECK ("validFrom" IS NULL OR "validUntil" IS NULL OR "validUntil" > "validFrom");

ALTER TABLE "ProjectItemRevision"
  ADD CONSTRAINT "ProjectItemRevision_confidence_check" CHECK ("confidence" IS NULL OR "confidence" BETWEEN 0 AND 1),
  ADD CONSTRAINT "ProjectItemRevision_importance_check" CHECK ("importance" BETWEEN 0 AND 100),
  ADD CONSTRAINT "ProjectItemRevision_validity_check" CHECK ("validFrom" IS NULL OR "validUntil" IS NULL OR "validUntil" > "validFrom");

CREATE TABLE "MemoryQualityIssue" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "kind" "MemoryQualityIssueKind" NOT NULL,
  "status" "MemoryQualityIssueStatus" NOT NULL DEFAULT 'open',
  "primaryItemId" UUID NOT NULL,
  "relatedItemId" UUID,
  "score" DOUBLE PRECISION NOT NULL,
  "fingerprint" CHAR(64) NOT NULL,
  "explanation" TEXT NOT NULL,
  "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMP(3),
  "resolvedById" UUID,
  "resolutionNote" TEXT,
  CONSTRAINT "MemoryQualityIssue_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MemoryQualityIssue_score_check" CHECK ("score" BETWEEN 0 AND 1),
  CONSTRAINT "MemoryQualityIssue_related_check" CHECK ("relatedItemId" IS NULL OR "relatedItemId" <> "primaryItemId"),
  CONSTRAINT "MemoryQualityIssue_status_check" CHECK (
    ("status" = 'open' AND "resolvedAt" IS NULL AND "resolvedById" IS NULL)
    OR ("status" = 'resolved' AND "resolvedAt" IS NOT NULL)
    OR ("status" = 'dismissed' AND "resolvedAt" IS NOT NULL AND "resolvedById" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "MemoryQualityIssue_projectId_fingerprint_key" ON "MemoryQualityIssue"("projectId", "fingerprint");
CREATE INDEX "MemoryQualityIssue_projectId_status_kind_idx" ON "MemoryQualityIssue"("projectId", "status", "kind");
CREATE INDEX "MemoryQualityIssue_projectId_primaryItemId_idx" ON "MemoryQualityIssue"("projectId", "primaryItemId");
CREATE INDEX "MemoryQualityIssue_projectId_relatedItemId_idx" ON "MemoryQualityIssue"("projectId", "relatedItemId");
CREATE INDEX "MemoryQualityIssue_resolvedById_resolvedAt_idx" ON "MemoryQualityIssue"("resolvedById", "resolvedAt");

ALTER TABLE "MemoryQualityIssue" ADD CONSTRAINT "MemoryQualityIssue_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MemoryQualityIssue" ADD CONSTRAINT "MemoryQualityIssue_primaryItem_fkey" FOREIGN KEY ("projectId", "primaryItemId") REFERENCES "ProjectItem"("projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MemoryQualityIssue" ADD CONSTRAINT "MemoryQualityIssue_relatedItem_fkey" FOREIGN KEY ("projectId", "relatedItemId") REFERENCES "ProjectItem"("projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MemoryQualityIssue" ADD CONSTRAINT "MemoryQualityIssue_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
