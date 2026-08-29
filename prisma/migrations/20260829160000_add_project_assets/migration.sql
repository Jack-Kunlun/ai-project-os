-- CreateEnum
CREATE TYPE "ProjectAssetKind" AS ENUM ('text', 'document', 'spreadsheet', 'presentation', 'image');

-- CreateEnum
CREATE TYPE "ProjectAssetStatus" AS ENUM ('uploaded', 'parsing', 'waiting_vision', 'awaiting_review', 'ready', 'failed', 'deleted');

-- CreateEnum
CREATE TYPE "ProjectAssetVersionStatus" AS ENUM ('staged', 'processing', 'waiting_vision', 'awaiting_review', 'ready', 'failed', 'superseded');

-- CreateEnum
CREATE TYPE "ProjectAssetSegmentLocatorKind" AS ENUM ('document', 'page', 'paragraph', 'slide', 'sheet', 'image');

-- CreateEnum
CREATE TYPE "ProjectAssetExtractionMethod" AS ENUM ('local_text', 'local_document', 'vision');

-- CreateEnum
CREATE TYPE "ProjectAssetSegmentReviewStatus" AS ENUM ('pending', 'accepted', 'dismissed');

-- CreateEnum
CREATE TYPE "ProjectAssetExtractionRunStatus" AS ENUM ('queued', 'running', 'waiting_review', 'succeeded', 'failed', 'unknown', 'cancelled');

-- AlterEnum
ALTER TYPE "AiOperation" ADD VALUE 'visionExtract';

-- AlterEnum
ALTER TYPE "BackgroundJobKind" ADD VALUE 'asset_extract';

-- AlterEnum
ALTER TYPE "WebAiScopeKind" ADD VALUE 'project_assets';

-- AlterTable
ALTER TABLE "AiProviderConnection" ADD COLUMN     "defaultVisionModelId" VARCHAR(128);

-- AlterTable
ALTER TABLE "ProjectSource" ADD COLUMN     "retiredAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ProjectAsset" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "displayName" VARCHAR(255) NOT NULL,
    "kind" "ProjectAssetKind" NOT NULL,
    "status" "ProjectAssetStatus" NOT NULL DEFAULT 'uploaded',
    "uploadedById" UUID NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectAssetVersion" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "projectAssetId" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "originalFileName" VARCHAR(255) NOT NULL,
    "mimeType" VARCHAR(128) NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "contentHash" CHAR(64) NOT NULL,
    "storageKey" VARCHAR(1024) NOT NULL,
    "status" "ProjectAssetVersionStatus" NOT NULL DEFAULT 'staged',
    "parserVersion" VARCHAR(64),
    "failureCode" VARCHAR(64),
    "processingStartedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectAssetVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectAssetSegment" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "projectAssetId" UUID NOT NULL,
    "projectAssetVersionId" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "locatorKind" "ProjectAssetSegmentLocatorKind" NOT NULL,
    "locatorLabel" VARCHAR(512) NOT NULL,
    "pageNumber" INTEGER,
    "slideNumber" INTEGER,
    "sheetName" VARCHAR(255),
    "cellRange" VARCHAR(128),
    "requiresVision" BOOLEAN NOT NULL DEFAULT false,
    "extractionMethod" "ProjectAssetExtractionMethod" NOT NULL,
    "contentText" TEXT NOT NULL DEFAULT '',
    "contentHash" CHAR(64) NOT NULL,
    "reviewedText" TEXT,
    "reviewStatus" "ProjectAssetSegmentReviewStatus" NOT NULL DEFAULT 'pending',
    "reviewedById" UUID,
    "reviewedAt" TIMESTAMP(3),
    "providerConnectionId" UUID,
    "modelId" VARCHAR(128),
    "projectSourceId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectAssetSegment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectAssetExtractionRun" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "projectAssetId" UUID NOT NULL,
    "projectAssetVersionId" UUID NOT NULL,
    "jobId" UUID,
    "status" "ProjectAssetExtractionRunStatus" NOT NULL DEFAULT 'queued',
    "providerConnectionId" UUID,
    "modelId" VARCHAR(128),
    "inputManifestFingerprint" CHAR(64) NOT NULL,
    "localSegmentCount" INTEGER NOT NULL DEFAULT 0,
    "visionSegmentCount" INTEGER NOT NULL DEFAULT 0,
    "failureCode" VARCHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ProjectAssetExtractionRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProjectAsset_projectId_status_createdAt_idx" ON "ProjectAsset"("projectId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "ProjectAsset_uploadedById_idx" ON "ProjectAsset"("uploadedById");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectAsset_projectId_id_key" ON "ProjectAsset"("projectId", "id");

-- CreateIndex
CREATE INDEX "ProjectAssetVersion_projectId_status_createdAt_idx" ON "ProjectAssetVersion"("projectId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "ProjectAssetVersion_projectAssetId_idx" ON "ProjectAssetVersion"("projectAssetId");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectAssetVersion_projectId_id_key" ON "ProjectAssetVersion"("projectId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectAssetVersion_projectId_projectAssetId_version_key" ON "ProjectAssetVersion"("projectId", "projectAssetId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectAssetVersion_projectId_contentHash_key" ON "ProjectAssetVersion"("projectId", "contentHash");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectAssetSegment_projectSourceId_key" ON "ProjectAssetSegment"("projectSourceId");

-- CreateIndex
CREATE INDEX "ProjectAssetSegment_projectId_reviewStatus_createdAt_idx" ON "ProjectAssetSegment"("projectId", "reviewStatus", "createdAt");

-- CreateIndex
CREATE INDEX "ProjectAssetSegment_projectAssetId_idx" ON "ProjectAssetSegment"("projectAssetId");

-- CreateIndex
CREATE INDEX "ProjectAssetSegment_projectAssetVersionId_idx" ON "ProjectAssetSegment"("projectAssetVersionId");

-- CreateIndex
CREATE INDEX "ProjectAssetSegment_reviewedById_idx" ON "ProjectAssetSegment"("reviewedById");

-- CreateIndex
CREATE INDEX "ProjectAssetSegment_providerConnectionId_idx" ON "ProjectAssetSegment"("providerConnectionId");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectAssetSegment_projectId_id_key" ON "ProjectAssetSegment"("projectId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectAssetSegment_projectId_projectAssetVersionId_ordinal_key" ON "ProjectAssetSegment"("projectId", "projectAssetVersionId", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectAssetSegment_projectId_projectSourceId_key" ON "ProjectAssetSegment"("projectId", "projectSourceId");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectAssetExtractionRun_jobId_key" ON "ProjectAssetExtractionRun"("jobId");

-- CreateIndex
CREATE INDEX "ProjectAssetExtractionRun_projectId_status_createdAt_idx" ON "ProjectAssetExtractionRun"("projectId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "ProjectAssetExtractionRun_projectAssetVersionId_idx" ON "ProjectAssetExtractionRun"("projectAssetVersionId");

-- CreateIndex
CREATE INDEX "ProjectAssetExtractionRun_providerConnectionId_idx" ON "ProjectAssetExtractionRun"("providerConnectionId");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectAssetExtractionRun_projectId_id_key" ON "ProjectAssetExtractionRun"("projectId", "id");

-- CreateIndex
CREATE INDEX "ProjectSource_projectId_retiredAt_idx" ON "ProjectSource"("projectId", "retiredAt");


-- AddForeignKey
ALTER TABLE "ProjectAsset" ADD CONSTRAINT "ProjectAsset_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectAsset" ADD CONSTRAINT "ProjectAsset_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectAssetVersion" ADD CONSTRAINT "ProjectAssetVersion_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectAssetVersion" ADD CONSTRAINT "ProjectAssetVersion_projectId_projectAssetId_fkey" FOREIGN KEY ("projectId", "projectAssetId") REFERENCES "ProjectAsset"("projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectAssetSegment" ADD CONSTRAINT "ProjectAssetSegment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectAssetSegment" ADD CONSTRAINT "ProjectAssetSegment_projectId_projectAssetId_fkey" FOREIGN KEY ("projectId", "projectAssetId") REFERENCES "ProjectAsset"("projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectAssetSegment" ADD CONSTRAINT "ProjectAssetSegment_projectId_projectAssetVersionId_fkey" FOREIGN KEY ("projectId", "projectAssetVersionId") REFERENCES "ProjectAssetVersion"("projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectAssetSegment" ADD CONSTRAINT "ProjectAssetSegment_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectAssetSegment" ADD CONSTRAINT "ProjectAssetSegment_providerConnectionId_fkey" FOREIGN KEY ("providerConnectionId") REFERENCES "AiProviderConnection"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectAssetSegment" ADD CONSTRAINT "ProjectAssetSegment_projectId_projectSourceId_fkey" FOREIGN KEY ("projectId", "projectSourceId") REFERENCES "ProjectSource"("projectId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectAssetExtractionRun" ADD CONSTRAINT "ProjectAssetExtractionRun_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectAssetExtractionRun" ADD CONSTRAINT "ProjectAssetExtractionRun_projectId_projectAssetId_fkey" FOREIGN KEY ("projectId", "projectAssetId") REFERENCES "ProjectAsset"("projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectAssetExtractionRun" ADD CONSTRAINT "ProjectAssetExtractionRun_projectId_projectAssetVersionId_fkey" FOREIGN KEY ("projectId", "projectAssetVersionId") REFERENCES "ProjectAssetVersion"("projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectAssetExtractionRun" ADD CONSTRAINT "ProjectAssetExtractionRun_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "BackgroundJob"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectAssetExtractionRun" ADD CONSTRAINT "ProjectAssetExtractionRun_providerConnectionId_fkey" FOREIGN KEY ("providerConnectionId") REFERENCES "AiProviderConnection"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
