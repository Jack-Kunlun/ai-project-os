-- CreateEnum
CREATE TYPE "ProjectSourceKind" AS ENUM ('document', 'screenshot', 'github', 'manual');

-- CreateEnum
CREATE TYPE "ProjectItemType" AS ENUM ('decision', 'progress', 'issue', 'risk');

-- CreateEnum
CREATE TYPE "ProjectItemReviewStatus" AS ENUM ('candidate', 'confirmed', 'dismissed', 'superseded');

-- CreateEnum
CREATE TYPE "ProjectScanTrigger" AS ENUM ('manual', 'system');

-- CreateEnum
CREATE TYPE "ProjectScanStatus" AS ENUM ('running', 'completed', 'failed');

-- CreateTable
CREATE TABLE "Project" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectSource" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "kind" "ProjectSourceKind" NOT NULL,
    "externalRef" TEXT,
    "contentText" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "storageKey" TEXT,
    "capturedAt" TIMESTAMP(3),
    "ingestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectItem" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "type" "ProjectItemType" NOT NULL,
    "reviewStatus" "ProjectItemReviewStatus" NOT NULL DEFAULT 'candidate',
    "sourceId" UUID,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "sourceExcerpt" TEXT,
    "occurredAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "supersedesItemId" UUID,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectScan" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "trigger" "ProjectScanTrigger" NOT NULL,
    "status" "ProjectScanStatus" NOT NULL DEFAULT 'running',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "ProjectScan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectSnapshot" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "scanId" UUID,
    "payload" JSONB NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Project_slug_key" ON "Project"("slug");

-- CreateIndex
CREATE INDEX "Project_updatedAt_idx" ON "Project"("updatedAt");

-- CreateIndex
CREATE INDEX "ProjectSource_projectId_capturedAt_idx" ON "ProjectSource"("projectId", "capturedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectSource_projectId_contentHash_key" ON "ProjectSource"("projectId", "contentHash");

-- CreateIndex
CREATE INDEX "ProjectItem_projectId_reviewStatus_idx" ON "ProjectItem"("projectId", "reviewStatus");

-- CreateIndex
CREATE INDEX "ProjectItem_projectId_type_idx" ON "ProjectItem"("projectId", "type");

-- CreateIndex
CREATE INDEX "ProjectItem_sourceId_idx" ON "ProjectItem"("sourceId");

-- CreateIndex
CREATE INDEX "ProjectItem_supersedesItemId_idx" ON "ProjectItem"("supersedesItemId");

-- CreateIndex
CREATE INDEX "ProjectScan_projectId_startedAt_idx" ON "ProjectScan"("projectId", "startedAt");

-- CreateIndex
CREATE INDEX "ProjectScan_projectId_status_idx" ON "ProjectScan"("projectId", "status");

-- CreateIndex
CREATE INDEX "ProjectSnapshot_projectId_generatedAt_idx" ON "ProjectSnapshot"("projectId", "generatedAt");

-- CreateIndex
CREATE INDEX "ProjectSnapshot_scanId_idx" ON "ProjectSnapshot"("scanId");

-- AddForeignKey
ALTER TABLE "ProjectSource" ADD CONSTRAINT "ProjectSource_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectItem" ADD CONSTRAINT "ProjectItem_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectItem" ADD CONSTRAINT "ProjectItem_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "ProjectSource"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectItem" ADD CONSTRAINT "ProjectItem_supersedesItemId_fkey" FOREIGN KEY ("supersedesItemId") REFERENCES "ProjectItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectScan" ADD CONSTRAINT "ProjectScan_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectSnapshot" ADD CONSTRAINT "ProjectSnapshot_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectSnapshot" ADD CONSTRAINT "ProjectSnapshot_scanId_fkey" FOREIGN KEY ("scanId") REFERENCES "ProjectScan"("id") ON DELETE SET NULL ON UPDATE CASCADE;
