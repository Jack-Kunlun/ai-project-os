-- AddEnumValue
ALTER TYPE "WebAiScopeKind" ADD VALUE 'project_intelligence';

-- AddEnumValue
ALTER TYPE "BackgroundJobKind" ADD VALUE 'project_brief';

-- AddEnumValue
ALTER TYPE "BackgroundJobKind" ADD VALUE 'project_agent';

-- CreateTable
CREATE TABLE "ProjectIntelligenceReport" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "jobId" UUID NOT NULL,
    "indexGenerationId" UUID NOT NULL,
    "providerConnectionId" UUID NOT NULL,
    "modelId" VARCHAR(128) NOT NULL,
    "report" JSONB NOT NULL,
    "citations" JSONB NOT NULL,
    "inputManifestFingerprint" CHAR(64) NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectIntelligenceReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectAgentRun" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "jobId" UUID NOT NULL,
    "indexGenerationId" UUID NOT NULL,
    "providerConnectionId" UUID NOT NULL,
    "modelId" VARCHAR(128) NOT NULL,
    "question" TEXT NOT NULL,
    "plan" JSONB NOT NULL,
    "trace" JSONB NOT NULL,
    "answer" TEXT NOT NULL,
    "recommendations" JSONB NOT NULL,
    "uncertainties" JSONB NOT NULL,
    "citations" JSONB NOT NULL,
    "inputManifestFingerprint" CHAR(64) NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectAgentRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProjectIntelligenceReport_jobId_key" ON "ProjectIntelligenceReport"("jobId");

-- CreateIndex
CREATE INDEX "ProjectIntelligenceReport_projectId_createdAt_idx" ON "ProjectIntelligenceReport"("projectId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectAgentRun_jobId_key" ON "ProjectAgentRun"("jobId");

-- CreateIndex
CREATE INDEX "ProjectAgentRun_projectId_createdAt_idx" ON "ProjectAgentRun"("projectId", "createdAt");

-- AddForeignKey
ALTER TABLE "ProjectIntelligenceReport" ADD CONSTRAINT "ProjectIntelligenceReport_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectIntelligenceReport" ADD CONSTRAINT "ProjectIntelligenceReport_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "BackgroundJob"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectIntelligenceReport" ADD CONSTRAINT "ProjectIntelligenceReport_projectId_indexGenerationId_fkey" FOREIGN KEY ("projectId", "indexGenerationId") REFERENCES "MemoryIndexGeneration"("projectId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectIntelligenceReport" ADD CONSTRAINT "ProjectIntelligenceReport_providerConnectionId_fkey" FOREIGN KEY ("providerConnectionId") REFERENCES "AiProviderConnection"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectAgentRun" ADD CONSTRAINT "ProjectAgentRun_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectAgentRun" ADD CONSTRAINT "ProjectAgentRun_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "BackgroundJob"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectAgentRun" ADD CONSTRAINT "ProjectAgentRun_projectId_indexGenerationId_fkey" FOREIGN KEY ("projectId", "indexGenerationId") REFERENCES "MemoryIndexGeneration"("projectId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectAgentRun" ADD CONSTRAINT "ProjectAgentRun_providerConnectionId_fkey" FOREIGN KEY ("providerConnectionId") REFERENCES "AiProviderConnection"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
