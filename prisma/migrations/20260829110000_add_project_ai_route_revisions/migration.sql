-- Preserve every project AI route change as an immutable, secret-free audit row.
CREATE TABLE "ProjectAiRouteRevision" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "operation" "AiOperation" NOT NULL,
    "oldProviderConnectionId" UUID,
    "oldModelId" VARCHAR(128),
    "oldEmbeddingDimensions" INTEGER,
    "oldMaxOutputTokens" INTEGER,
    "newProviderConnectionId" UUID NOT NULL,
    "newModelId" VARCHAR(128) NOT NULL,
    "newEmbeddingDimensions" INTEGER,
    "newMaxOutputTokens" INTEGER NOT NULL,
    "onlyFutureRuns" BOOLEAN NOT NULL DEFAULT false,
    "indexInvalidated" BOOLEAN NOT NULL DEFAULT false,
    "activeIndexGenerationId" UUID,
    "actorId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectAiRouteRevision_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ProjectAiRouteRevision_model_check" CHECK (
        "newModelId" ~ '^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$'
        AND "newModelId" !~ '://'
        AND "newModelId" !~ '\.\.'
        AND ("oldModelId" IS NULL OR (
            "oldModelId" ~ '^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$'
            AND "oldModelId" !~ '://'
            AND "oldModelId" !~ '\.\.'
        ))
    ),
    CONSTRAINT "ProjectAiRouteRevision_output_tokens_check" CHECK (
        "newMaxOutputTokens" BETWEEN 128 AND 16384
        AND ("oldMaxOutputTokens" IS NULL OR "oldMaxOutputTokens" BETWEEN 128 AND 16384)
    ),
    CONSTRAINT "ProjectAiRouteRevision_dimensions_check" CHECK (
        ("newEmbeddingDimensions" IS NULL OR "newEmbeddingDimensions" BETWEEN 8 AND 8192)
        AND ("oldEmbeddingDimensions" IS NULL OR "oldEmbeddingDimensions" BETWEEN 8 AND 8192)
    )
);

CREATE INDEX "ProjectAiRouteRevision_projectId_operation_createdAt_idx"
ON "ProjectAiRouteRevision"("projectId", "operation", "createdAt");
CREATE INDEX "ProjectAiRouteRevision_projectId_createdAt_idx"
ON "ProjectAiRouteRevision"("projectId", "createdAt");
CREATE INDEX "ProjectAiRouteRevision_newProviderConnectionId_idx"
ON "ProjectAiRouteRevision"("newProviderConnectionId");
CREATE INDEX "ProjectAiRouteRevision_oldProviderConnectionId_idx"
ON "ProjectAiRouteRevision"("oldProviderConnectionId");
CREATE INDEX "ProjectAiRouteRevision_activeIndexGenerationId_idx"
ON "ProjectAiRouteRevision"("activeIndexGenerationId");
CREATE INDEX "ProjectAiRouteRevision_projectId_activeIndexGenerationId_idx"
ON "ProjectAiRouteRevision"("projectId", "activeIndexGenerationId");

ALTER TABLE "ProjectAiRouteRevision"
ADD CONSTRAINT "ProjectAiRouteRevision_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "Project"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProjectAiRouteRevision"
ADD CONSTRAINT "ProjectAiRouteRevision_oldProviderConnectionId_fkey"
FOREIGN KEY ("oldProviderConnectionId") REFERENCES "AiProviderConnection"("id")
ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "ProjectAiRouteRevision"
ADD CONSTRAINT "ProjectAiRouteRevision_newProviderConnectionId_fkey"
FOREIGN KEY ("newProviderConnectionId") REFERENCES "AiProviderConnection"("id")
ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "ProjectAiRouteRevision"
ADD CONSTRAINT "ProjectAiRouteRevision_projectId_activeIndexGenerationId_fkey"
FOREIGN KEY ("projectId", "activeIndexGenerationId") REFERENCES "MemoryIndexGeneration"("projectId", "id")
ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "ProjectAiRouteRevision"
ADD CONSTRAINT "ProjectAiRouteRevision_actorId_fkey"
FOREIGN KEY ("actorId") REFERENCES "AppUser"("id")
ON DELETE NO ACTION ON UPDATE CASCADE;

-- An index build must retain the pointer observed when its input snapshot was
-- frozen. This is deliberately an audit value rather than a mutable pointer.
ALTER TABLE "MemoryIndexGeneration"
ADD COLUMN "expectedActiveIndexGenerationId" UUID;

CREATE INDEX "MemoryIndexGeneration_projectId_expectedActiveIndexGenerationId_idx"
ON "MemoryIndexGeneration"("projectId", "expectedActiveIndexGenerationId");

ALTER TABLE "MemoryIndexGeneration"
ADD CONSTRAINT "MemoryIndexGeneration_projectId_expectedActiveIndexGenerationId_fkey"
FOREIGN KEY ("projectId", "expectedActiveIndexGenerationId") REFERENCES "MemoryIndexGeneration"("projectId", "id")
ON DELETE NO ACTION ON UPDATE CASCADE;
