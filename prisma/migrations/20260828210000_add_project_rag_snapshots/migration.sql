CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE "ProjectRagSnapshotStatus" AS ENUM (
    'staging', 'complete', 'ineligible', 'superseded'
);

CREATE UNIQUE INDEX "ProjectCorpusIndexGeneration_exact_boundary_key"
ON "ProjectCorpusIndexGeneration"(
    "projectId", "indexGenerationId", "corpusGenerationId",
    "grantId", "policyRevisionId"
);

CREATE TABLE "ProjectRagSnapshot" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "manualIndexGenerationId" UUID NOT NULL,
    "manualCorpusGenerationId" UUID NOT NULL,
    "grantId" UUID NOT NULL,
    "policyRevisionId" UUID NOT NULL,
    "effectivePolicyVersion" INTEGER NOT NULL,
    "status" "ProjectRagSnapshotStatus" NOT NULL DEFAULT 'staging',
    "manifestFingerprint" VARCHAR(64) NOT NULL,
    "requiredRepositoryCount" INTEGER NOT NULL DEFAULT 0,
    "failureCode" VARCHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "supersededAt" TIMESTAMP(3),

    CONSTRAINT "ProjectRagSnapshot_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ProjectRagSnapshot_values_check" CHECK (
        "effectivePolicyVersion" > 0
        AND "requiredRepositoryCount" >= 0
        AND "manifestFingerprint" ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT "ProjectRagSnapshot_lifecycle_check" CHECK (
        ("status" = 'staging' AND "completedAt" IS NULL
            AND "supersededAt" IS NULL AND "failureCode" IS NULL)
        OR ("status" = 'complete' AND "completedAt" IS NOT NULL
            AND "supersededAt" IS NULL AND "failureCode" IS NULL)
        OR ("status" = 'ineligible' AND "completedAt" IS NOT NULL
            AND "supersededAt" IS NULL
            AND "failureCode" ~ '^[A-Z][A-Z0-9_]{0,63}$')
        OR ("status" = 'superseded' AND "completedAt" IS NOT NULL
            AND "supersededAt" IS NOT NULL AND "failureCode" IS NULL)
    )
);

CREATE UNIQUE INDEX "ProjectRagSnapshot_projectId_id_key"
ON "ProjectRagSnapshot"("projectId", "id");
CREATE UNIQUE INDEX "ProjectRagSnapshot_project_manifest_key"
ON "ProjectRagSnapshot"("projectId", "manifestFingerprint");
CREATE INDEX "ProjectRagSnapshot_projectId_status_createdAt_idx"
ON "ProjectRagSnapshot"("projectId", "status", "createdAt");

CREATE TABLE "ProjectRagSnapshotPointer" (
    "projectId" UUID NOT NULL,
    "ragSnapshotId" UUID NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectRagSnapshotPointer_pkey" PRIMARY KEY ("projectId")
);

CREATE UNIQUE INDEX "ProjectRagSnapshotPointer_project_snapshot_key"
ON "ProjectRagSnapshotPointer"("projectId", "ragSnapshotId");

ALTER TABLE "ProjectRagSnapshot"
ADD CONSTRAINT "ProjectRagSnapshot_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "Project"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProjectRagSnapshot"
ADD CONSTRAINT "ProjectRagSnapshot_manual_index_fkey"
FOREIGN KEY (
    "projectId", "manualIndexGenerationId", "manualCorpusGenerationId",
    "grantId", "policyRevisionId"
)
REFERENCES "ProjectCorpusIndexGeneration"(
    "projectId", "indexGenerationId", "corpusGenerationId",
    "grantId", "policyRevisionId"
)
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "ProjectRagSnapshotPointer"
ADD CONSTRAINT "ProjectRagSnapshotPointer_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "Project"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProjectRagSnapshotPointer"
ADD CONSTRAINT "ProjectRagSnapshotPointer_snapshot_fkey"
FOREIGN KEY ("projectId", "ragSnapshotId")
REFERENCES "ProjectRagSnapshot"("projectId", "id")
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

INSERT INTO "ProjectRagSnapshot" (
    "id", "projectId", "manualIndexGenerationId",
    "manualCorpusGenerationId", "grantId", "policyRevisionId",
    "effectivePolicyVersion", "status", "manifestFingerprint",
    "requiredRepositoryCount", "createdAt", "completedAt"
)
SELECT
    gen_random_uuid(),
    pointer."projectId",
    pointer."indexGenerationId",
    pointer."corpusGenerationId",
    project_index."grantId",
    project_index."policyRevisionId",
    grant_row."effectivePolicyVersion",
    'complete'::"ProjectRagSnapshotStatus",
    encode(digest(
        concat_ws(
            E'\x1f',
            'project-rag-snapshot:v1',
            pointer."projectId"::text,
            pointer."indexGenerationId"::text,
            pointer."corpusGenerationId"::text,
            project_index."grantId"::text,
            project_index."policyRevisionId"::text,
            grant_row."effectivePolicyVersion"::text,
            'required-repositories:0'
        ),
        'sha256'
    ), 'hex'),
    0,
    pointer."publishedAt",
    pointer."publishedAt"
FROM "ProjectCorpusIndexPointer" AS pointer
JOIN "ProjectCorpusIndexGeneration" AS project_index
  ON project_index."projectId" = pointer."projectId"
 AND project_index."indexGenerationId" = pointer."indexGenerationId"
 AND project_index."corpusGenerationId" = pointer."corpusGenerationId"
JOIN "ModelProcessingGrant" AS grant_row
  ON grant_row."projectId" = project_index."projectId"
 AND grant_row."id" = project_index."grantId";

INSERT INTO "ProjectRagSnapshotPointer" (
    "projectId", "ragSnapshotId", "publishedAt"
)
SELECT "projectId", "id", "completedAt"
FROM "ProjectRagSnapshot"
WHERE "status" = 'complete';
