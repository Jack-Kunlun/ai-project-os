CREATE TABLE "ProjectAssetUploadAdmission" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "windowStartedAt" TIMESTAMP(3) NOT NULL,
    "leaseExpiresAt" TIMESTAMP(3) NOT NULL,
    "releasedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProjectAssetUploadAdmission_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ProjectAssetUploadAdmission_lease_check" CHECK ("leaseExpiresAt" > "createdAt"),
    CONSTRAINT "ProjectAssetUploadAdmission_release_check" CHECK ("releasedAt" IS NULL OR "releasedAt" >= "createdAt")
);

CREATE INDEX "ProjectAssetUploadAdmission_userId_createdAt_idx"
    ON "ProjectAssetUploadAdmission"("userId", "createdAt");
CREATE INDEX "AssetUploadAdmission_user_active_idx"
    ON "ProjectAssetUploadAdmission"("userId", "releasedAt", "leaseExpiresAt");
CREATE INDEX "ProjectAssetUploadAdmission_releasedAt_leaseExpiresAt_idx"
    ON "ProjectAssetUploadAdmission"("releasedAt", "leaseExpiresAt");
CREATE INDEX "ProjectAssetUploadAdmission_createdAt_id_idx"
    ON "ProjectAssetUploadAdmission"("createdAt", "id");
CREATE INDEX "ProjectAssetUploadAdmission_leaseExpiresAt_createdAt_id_idx"
    ON "ProjectAssetUploadAdmission"("leaseExpiresAt", "createdAt", "id");
CREATE INDEX "ProjectAssetUploadAdmission_projectId_createdAt_idx"
    ON "ProjectAssetUploadAdmission"("projectId", "createdAt");
CREATE INDEX "ProjectAssetUploadAdmission_workspaceId_createdAt_idx"
    ON "ProjectAssetUploadAdmission"("workspaceId", "createdAt");

ALTER TABLE "ProjectAssetUploadAdmission"
    ADD CONSTRAINT "ProjectAssetUploadAdmission_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectAssetUploadAdmission"
    ADD CONSTRAINT "ProjectAssetUploadAdmission_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectAssetUploadAdmission"
    ADD CONSTRAINT "ProjectAssetUploadAdmission_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "AppUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ProjectAssetUploadReservation" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "storageKey" VARCHAR(1024) NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "leaseExpiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProjectAssetUploadReservation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ProjectAssetUploadReservation_storageKey_key" UNIQUE ("storageKey"),
    CONSTRAINT "ProjectAssetUploadReservation_size_check" CHECK ("sizeBytes" > 0),
    CONSTRAINT "ProjectAssetUploadReservation_lease_check" CHECK ("leaseExpiresAt" > "createdAt")
);

CREATE INDEX "ProjectAssetUploadReservation_leaseExpiresAt_createdAt_id_idx"
    ON "ProjectAssetUploadReservation"("leaseExpiresAt", "createdAt", "id");
CREATE INDEX "ProjectAssetUploadReservation_projectId_createdAt_id_idx"
    ON "ProjectAssetUploadReservation"("projectId", "createdAt", "id");
CREATE INDEX "ProjectAssetUploadReservation_workspaceId_createdAt_id_idx"
    ON "ProjectAssetUploadReservation"("workspaceId", "createdAt", "id");
CREATE INDEX "ProjectAssetUploadReservation_userId_createdAt_id_idx"
    ON "ProjectAssetUploadReservation"("userId", "createdAt", "id");

ALTER TABLE "ProjectAssetUploadReservation"
    ADD CONSTRAINT "ProjectAssetUploadReservation_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProjectAssetUploadReservation"
    ADD CONSTRAINT "ProjectAssetUploadReservation_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProjectAssetUploadReservation"
    ADD CONSTRAINT "ProjectAssetUploadReservation_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "AppUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ProjectAssetExtractionRun"
    ADD COLUMN "leaseToken" VARCHAR(64),
    ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 0,
    ADD CONSTRAINT "ProjectAssetExtractionRun_attemptCount_check" CHECK ("attemptCount" >= 0),
    ADD CONSTRAINT "ProjectAssetExtractionRun_local_lease_check" CHECK (
        "jobId" IS NOT NULL
        OR "providerConnectionId" IS NOT NULL
        OR "status" <> 'running'
        OR ("leaseToken" IS NOT NULL AND "attemptCount" > 0)
    );

CREATE INDEX "ProjectAssetExtractionRun_status_startedAt_createdAt_idx"
    ON "ProjectAssetExtractionRun"("status", "startedAt", "createdAt");

-- Any upload committed by an older process but not parsed yet becomes a
-- durable local extraction run. A formerly in-flight parse is reset because
-- the migration itself proves that its old process is no longer authoritative.
UPDATE "ProjectAsset"
SET "status" = 'uploaded'
WHERE "status" = 'parsing';

UPDATE "ProjectAssetVersion"
SET "status" = 'staged',
    "processingStartedAt" = NULL,
    "failureCode" = NULL,
    "completedAt" = NULL
WHERE "status" = 'processing';

INSERT INTO "ProjectAssetExtractionRun" (
    "id",
    "projectId",
    "projectAssetId",
    "projectAssetVersionId",
    "status",
    "inputManifestFingerprint",
    "createdAt"
)
SELECT
    gen_random_uuid(),
    asset."projectId",
    asset."id",
    version."id",
    'queued'::"ProjectAssetExtractionRunStatus",
    version."contentHash",
    CURRENT_TIMESTAMP
FROM "ProjectAsset" AS asset
JOIN LATERAL (
    SELECT candidate.*
    FROM "ProjectAssetVersion" AS candidate
    WHERE candidate."projectId" = asset."projectId"
      AND candidate."projectAssetId" = asset."id"
    ORDER BY candidate."version" DESC
    LIMIT 1
) AS version ON TRUE
WHERE asset."status" = 'uploaded'
  AND version."status" = 'staged'
  AND NOT EXISTS (
      SELECT 1
      FROM "ProjectAssetExtractionRun" AS run
      WHERE run."projectId" = asset."projectId"
        AND run."projectAssetVersionId" = version."id"
        AND run."jobId" IS NULL
        AND run."providerConnectionId" IS NULL
        AND run."status" IN ('queued', 'running')
  );
