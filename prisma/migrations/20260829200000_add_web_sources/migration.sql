ALTER TYPE "ProjectSourceKind" ADD VALUE 'web';
CREATE TYPE "WebSourceStatus" AS ENUM ('active', 'disabled', 'error');
CREATE TYPE "WebSourceRevisionStatus" AS ENUM ('staging', 'complete', 'failed', 'superseded');

CREATE TABLE "WebSource" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "name" VARCHAR(160) NOT NULL,
  "url" VARCHAR(2048) NOT NULL,
  "allowPrivateNetwork" BOOLEAN NOT NULL DEFAULT false,
  "resolvedAddressFingerprint" CHAR(64),
  "status" "WebSourceStatus" NOT NULL DEFAULT 'active',
  "lastFetchedAt" TIMESTAMP(3),
  "lastErrorCode" VARCHAR(64),
  "createdById" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "disabledAt" TIMESTAMP(3),
  CONSTRAINT "WebSource_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WebSource_state_check" CHECK (
    ("status" = 'disabled' AND "disabledAt" IS NOT NULL)
    OR ("status" <> 'disabled' AND "disabledAt" IS NULL)
  )
);

CREATE TABLE "WebSourceRevision" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "webSourceId" UUID NOT NULL,
  "status" "WebSourceRevisionStatus" NOT NULL DEFAULT 'staging',
  "finalUrl" VARCHAR(2048),
  "httpStatus" INTEGER,
  "contentType" VARCHAR(255),
  "title" VARCHAR(512),
  "contentHash" CHAR(64),
  "contentBytes" INTEGER NOT NULL DEFAULT 0,
  "projectSourceId" UUID,
  "failureCode" VARCHAR(64),
  "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "supersededAt" TIMESTAMP(3),
  CONSTRAINT "WebSourceRevision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WebSourceRevision_bytes_check" CHECK ("contentBytes" >= 0 AND "contentBytes" <= 5242880),
  CONSTRAINT "WebSourceRevision_http_check" CHECK ("httpStatus" IS NULL OR "httpStatus" BETWEEN 100 AND 599),
  CONSTRAINT "WebSourceRevision_state_check" CHECK (
    ("status" = 'staging' AND "completedAt" IS NULL AND "failureCode" IS NULL)
    OR ("status" = 'complete' AND "completedAt" IS NOT NULL AND "projectSourceId" IS NOT NULL AND "contentHash" IS NOT NULL AND "failureCode" IS NULL)
    OR ("status" = 'failed' AND "completedAt" IS NOT NULL AND "failureCode" IS NOT NULL)
    OR ("status" = 'superseded' AND "completedAt" IS NOT NULL AND "supersededAt" IS NOT NULL AND "projectSourceId" IS NOT NULL)
  )
);

CREATE TABLE "WebSourcePointer" (
  "projectId" UUID NOT NULL,
  "webSourceId" UUID NOT NULL,
  "webSourceRevisionId" UUID NOT NULL,
  "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WebSourcePointer_pkey" PRIMARY KEY ("projectId", "webSourceId")
);

CREATE UNIQUE INDEX "WebSource_projectId_id_key" ON "WebSource"("projectId", "id");
CREATE UNIQUE INDEX "WebSource_projectId_url_key" ON "WebSource"("projectId", "url");
CREATE INDEX "WebSource_projectId_status_updatedAt_idx" ON "WebSource"("projectId", "status", "updatedAt");
CREATE INDEX "WebSource_createdById_createdAt_idx" ON "WebSource"("createdById", "createdAt");
CREATE UNIQUE INDEX "WebSourceRevision_projectId_id_key" ON "WebSourceRevision"("projectId", "id");
CREATE UNIQUE INDEX "WebSourceRevision_projectId_webSourceId_id_key" ON "WebSourceRevision"("projectId", "webSourceId", "id");
CREATE INDEX "WebSourceRevision_projectId_webSourceId_status_fetchedAt_idx" ON "WebSourceRevision"("projectId", "webSourceId", "status", "fetchedAt");
CREATE INDEX "WebSourceRevision_projectId_projectSourceId_idx" ON "WebSourceRevision"("projectId", "projectSourceId");
CREATE UNIQUE INDEX "WebSourcePointer_webSourceRevisionId_key" ON "WebSourcePointer"("webSourceRevisionId");
CREATE UNIQUE INDEX "WebSourcePointer_projectId_webSourceId_webSourceRevisionId_key" ON "WebSourcePointer"("projectId", "webSourceId", "webSourceRevisionId");
CREATE INDEX "WebSourcePointer_projectId_publishedAt_idx" ON "WebSourcePointer"("projectId", "publishedAt");

ALTER TABLE "WebSource" ADD CONSTRAINT "WebSource_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WebSource" ADD CONSTRAINT "WebSource_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "WebSourceRevision" ADD CONSTRAINT "WebSourceRevision_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WebSourceRevision" ADD CONSTRAINT "WebSourceRevision_webSource_fkey" FOREIGN KEY ("projectId", "webSourceId") REFERENCES "WebSource"("projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WebSourceRevision" ADD CONSTRAINT "WebSourceRevision_projectSource_fkey" FOREIGN KEY ("projectId", "projectSourceId") REFERENCES "ProjectSource"("projectId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "WebSourcePointer" ADD CONSTRAINT "WebSourcePointer_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WebSourcePointer" ADD CONSTRAINT "WebSourcePointer_webSource_fkey" FOREIGN KEY ("projectId", "webSourceId") REFERENCES "WebSource"("projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WebSourcePointer" ADD CONSTRAINT "WebSourcePointer_revision_fkey" FOREIGN KEY ("projectId", "webSourceId", "webSourceRevisionId") REFERENCES "WebSourceRevision"("projectId", "webSourceId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;
