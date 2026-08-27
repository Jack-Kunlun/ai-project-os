-- Repository material model consent and semantic indexing are intentionally
-- isolated from the established manual-text and repository-code pipelines.

CREATE UNIQUE INDEX "RepositoryMaterialGenerationEntry_generation_id_key"
ON "RepositoryMaterialGenerationEntry"(
    "projectId", "projectRepositoryLinkId", "repositoryMaterialGenerationId", "id"
);

CREATE UNIQUE INDEX "RepositoryMaterialGenerationEntry_model_member_key"
ON "RepositoryMaterialGenerationEntry"(
    "projectId", "projectRepositoryLinkId", "repositoryMaterialGenerationId",
    "id", "githubSourceVersionId", "projectSourceId"
);

CREATE TABLE "RepositoryMaterialModelGrant" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "projectRepositoryLinkId" UUID NOT NULL,
    "repositoryMaterialGenerationId" UUID NOT NULL,
    "linkConfigVersion" INTEGER NOT NULL,
    "linkEffectivePolicyVersion" INTEGER NOT NULL,
    "policyRevisionId" UUID NOT NULL,
    "effectivePolicyVersion" INTEGER NOT NULL,
    "operation" "AiOperation" NOT NULL,
    "status" "ModelProcessingGrantStatus" NOT NULL DEFAULT 'draft',
    "profileFingerprint" VARCHAR(64) NOT NULL,
    "providerFingerprint" VARCHAR(64) NOT NULL,
    "modelFingerprint" VARCHAR(64) NOT NULL,
    "modelId" VARCHAR(128) NOT NULL,
    "processorFingerprint" VARCHAR(64) NOT NULL,
    "regionFingerprint" VARCHAR(64) NOT NULL,
    "retentionFingerprint" VARCHAR(64) NOT NULL,
    "endpointFingerprint" VARCHAR(64) NOT NULL,
    "grantFingerprint" VARCHAR(64) NOT NULL,
    "materialPolicyFingerprint" VARCHAR(64) NOT NULL,
    "sourceManifestFingerprint" VARCHAR(64) NOT NULL,
    "scannerFingerprint" VARCHAR(64) NOT NULL,
    "scannerVersion" VARCHAR(128) NOT NULL,
    "consentVersion" VARCHAR(64) NOT NULL,
    "sourceCount" INTEGER NOT NULL,
    "sourceBytes" INTEGER NOT NULL,
    "issuedBy" VARCHAR(128) NOT NULL,
    "purposeCode" VARCHAR(64) NOT NULL,
    "issuedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revocationReasonCode" "ModelProcessingGrantRevocationReasonCode",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RepositoryMaterialModelGrant_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RepositoryMaterialModelGrant_values_check" CHECK (
        "linkConfigVersion" > 0
        AND "linkEffectivePolicyVersion" > 0
        AND "effectivePolicyVersion" > 0
        AND "sourceCount" > 0
        AND "sourceBytes" > 0
        AND "operation" IN (
            'embedding', 'autoExtract', 'sourceSummary',
            'projectAnalysis', 'generateWithContext'
        )
        AND "profileFingerprint" ~ '^[0-9a-f]{64}$'
        AND "providerFingerprint" ~ '^[0-9a-f]{64}$'
        AND "modelFingerprint" ~ '^[0-9a-f]{64}$'
        AND "processorFingerprint" ~ '^[0-9a-f]{64}$'
        AND "regionFingerprint" ~ '^[0-9a-f]{64}$'
        AND "retentionFingerprint" ~ '^[0-9a-f]{64}$'
        AND "endpointFingerprint" ~ '^[0-9a-f]{64}$'
        AND "grantFingerprint" ~ '^[0-9a-f]{64}$'
        AND "materialPolicyFingerprint" ~ '^[0-9a-f]{64}$'
        AND "sourceManifestFingerprint" ~ '^[0-9a-f]{64}$'
        AND "scannerFingerprint" ~ '^[0-9a-f]{64}$'
        AND "scannerVersion" ~ '^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$'
        AND "consentVersion" = 'repository-material-to-openai:v1'
    ),
    CONSTRAINT "RepositoryMaterialModelGrant_state_check" CHECK (
        (
            "status" = 'draft'
            AND "issuedAt" IS NULL AND "expiresAt" IS NULL
            AND "revokedAt" IS NULL AND "revocationReasonCode" IS NULL
        )
        OR (
            "status" = 'issued'
            AND "issuedAt" IS NOT NULL AND "expiresAt" > "issuedAt"
            AND "revokedAt" IS NULL AND "revocationReasonCode" IS NULL
        )
        OR (
            "status" = 'revoked'
            AND "issuedAt" IS NOT NULL AND "expiresAt" > "issuedAt"
            AND "revokedAt" >= "issuedAt" AND "revocationReasonCode" IS NOT NULL
        )
    )
);

CREATE INDEX "RepositoryMaterialModelGrant_status_idx"
ON "RepositoryMaterialModelGrant"(
    "projectId", "projectRepositoryLinkId", "status", "expiresAt"
);
CREATE UNIQUE INDEX "RepositoryMaterialModelGrant_projectId_id_key"
ON "RepositoryMaterialModelGrant"("projectId", "id");
CREATE UNIQUE INDEX "RepositoryMaterialModelGrant_project_link_id_key"
ON "RepositoryMaterialModelGrant"("projectId", "projectRepositoryLinkId", "id");
CREATE UNIQUE INDEX "RepositoryMaterialModelGrant_subject_key"
ON "RepositoryMaterialModelGrant"(
    "projectId", "projectRepositoryLinkId", "repositoryMaterialGenerationId", "id"
);
CREATE UNIQUE INDEX "RepositoryMaterialModelGrant_fingerprint_key"
ON "RepositoryMaterialModelGrant"("projectId", "grantFingerprint");

CREATE TABLE "RepositoryMaterialModelGrantSource" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "projectRepositoryLinkId" UUID NOT NULL,
    "grantId" UUID NOT NULL,
    "repositoryMaterialGenerationId" UUID NOT NULL,
    "materialGenerationEntryId" UUID NOT NULL,
    "githubSourceVersionId" UUID NOT NULL,
    "projectSourceId" UUID NOT NULL,
    "originScope" "ContentOriginScope" NOT NULL DEFAULT 'repository_link',
    "sourceRevisionKey" UUID NOT NULL,
    "sourceContentHash" VARCHAR(64) NOT NULL,
    "contentBytes" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RepositoryMaterialModelGrantSource_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RepositoryMaterialGrantSource_values_check" CHECK (
        "originScope" = 'repository_link'
        AND "sourceContentHash" ~ '^[0-9a-f]{64}$'
        AND "contentBytes" > 0
    )
);

CREATE INDEX "RepositoryMaterialGrantSource_source_idx"
ON "RepositoryMaterialModelGrantSource"(
    "projectId", "projectRepositoryLinkId", "projectSourceId"
);
CREATE UNIQUE INDEX "RepositoryMaterialModelGrantSource_projectId_id_key"
ON "RepositoryMaterialModelGrantSource"("projectId", "id");
CREATE UNIQUE INDEX "RepositoryMaterialGrantSource_grant_id_key"
ON "RepositoryMaterialModelGrantSource"(
    "projectId", "projectRepositoryLinkId", "grantId", "id"
);
CREATE UNIQUE INDEX "RepositoryMaterialGrantSource_grant_source_key"
ON "RepositoryMaterialModelGrantSource"(
    "projectId", "projectRepositoryLinkId", "grantId", "projectSourceId"
);
CREATE UNIQUE INDEX "RepositoryMaterialGrantSource_index_key"
ON "RepositoryMaterialModelGrantSource"(
    "projectId", "projectRepositoryLinkId", "grantId", "id",
    "repositoryMaterialGenerationId", "materialGenerationEntryId", "projectSourceId"
);

CREATE TABLE "RepositoryMaterialChunk" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "projectRepositoryLinkId" UUID NOT NULL,
    "repositoryMaterialGenerationId" UUID NOT NULL,
    "materialGenerationEntryId" UUID NOT NULL,
    "githubSourceVersionId" UUID NOT NULL,
    "projectSourceId" UUID NOT NULL,
    "originScope" "ContentOriginScope" NOT NULL DEFAULT 'repository_link',
    "sourceRevisionKey" UUID NOT NULL,
    "sourceContentHash" VARCHAR(64) NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "rangeStart" INTEGER NOT NULL,
    "rangeEnd" INTEGER NOT NULL,
    "chunkerVersion" VARCHAR(128) NOT NULL,
    "contentText" TEXT NOT NULL,
    "contentHash" VARCHAR(64) NOT NULL,
    "contentBytes" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RepositoryMaterialChunk_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RepositoryMaterialChunk_values_check" CHECK (
        "originScope" = 'repository_link'
        AND "sourceContentHash" ~ '^[0-9a-f]{64}$'
        AND "ordinal" >= 0
        AND "rangeStart" >= 0
        AND "rangeEnd" > "rangeStart"
        AND "rangeEnd" - "rangeStart" = "contentBytes"
        AND "contentBytes" = octet_length("contentText")
        AND "contentBytes" > 0
        AND "contentHash" ~ '^[0-9a-f]{64}$'
        AND "chunkerVersion" ~ '^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$'
    )
);

CREATE INDEX "RepositoryMaterialChunk_source_idx"
ON "RepositoryMaterialChunk"(
    "projectId", "projectRepositoryLinkId", "projectSourceId", "ordinal"
);
CREATE UNIQUE INDEX "RepositoryMaterialChunk_projectId_id_key"
ON "RepositoryMaterialChunk"("projectId", "id");
CREATE UNIQUE INDEX "RepositoryMaterialChunk_project_link_id_key"
ON "RepositoryMaterialChunk"("projectId", "projectRepositoryLinkId", "id");
CREATE UNIQUE INDEX "RepositoryMaterialChunk_entry_id_key"
ON "RepositoryMaterialChunk"(
    "projectId", "projectRepositoryLinkId", "repositoryMaterialGenerationId",
    "materialGenerationEntryId", "id"
);
CREATE UNIQUE INDEX "RepositoryMaterialChunk_ordinal_key"
ON "RepositoryMaterialChunk"(
    "projectId", "projectRepositoryLinkId", "repositoryMaterialGenerationId",
    "materialGenerationEntryId", "chunkerVersion", "ordinal"
);
CREATE UNIQUE INDEX "RepositoryMaterialChunk_range_key"
ON "RepositoryMaterialChunk"(
    "projectId", "projectRepositoryLinkId", "repositoryMaterialGenerationId",
    "materialGenerationEntryId", "chunkerVersion", "rangeStart", "rangeEnd", "contentHash"
);

CREATE TABLE "RepositoryMaterialIndexGeneration" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "projectRepositoryLinkId" UUID NOT NULL,
    "repositoryMaterialGenerationId" UUID NOT NULL,
    "expectedActiveIndexGenerationId" UUID,
    "linkConfigVersion" INTEGER NOT NULL,
    "grantId" UUID NOT NULL,
    "policyRevisionId" UUID NOT NULL,
    "effectivePolicyVersion" INTEGER NOT NULL,
    "embeddingProfileId" UUID NOT NULL,
    "status" "IndexGenerationStatus" NOT NULL DEFAULT 'staging',
    "generationKey" VARCHAR(64) NOT NULL,
    "inputManifestFingerprint" VARCHAR(64) NOT NULL,
    "processingBoundaryFingerprint" VARCHAR(64) NOT NULL,
    "chunkerVersion" VARCHAR(128) NOT NULL,
    "expectedInputCount" INTEGER NOT NULL,
    "indexedInputCount" INTEGER NOT NULL DEFAULT 0,
    "failureCode" VARCHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "buildStartedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "supersededAt" TIMESTAMP(3),

    CONSTRAINT "RepositoryMaterialIndexGeneration_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RepositoryMaterialIndex_values_check" CHECK (
        "linkConfigVersion" > 0
        AND "effectivePolicyVersion" > 0
        AND "generationKey" ~ '^[0-9a-f]{64}$'
        AND "inputManifestFingerprint" ~ '^[0-9a-f]{64}$'
        AND "processingBoundaryFingerprint" ~ '^[0-9a-f]{64}$'
        AND "chunkerVersion" ~ '^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$'
        AND "expectedInputCount" > 0
        AND "indexedInputCount" >= 0
        AND "indexedInputCount" <= "expectedInputCount"
    )
);

CREATE INDEX "RepositoryMaterialIndex_status_idx"
ON "RepositoryMaterialIndexGeneration"(
    "projectId", "projectRepositoryLinkId", "status", "createdAt"
);
CREATE UNIQUE INDEX "RepositoryMaterialIndexGeneration_projectId_id_key"
ON "RepositoryMaterialIndexGeneration"("projectId", "id");
CREATE UNIQUE INDEX "RepositoryMaterialIndexGeneration_project_link_id_key"
ON "RepositoryMaterialIndexGeneration"("projectId", "projectRepositoryLinkId", "id");
CREATE UNIQUE INDEX "RepositoryMaterialIndex_generation_id_key"
ON "RepositoryMaterialIndexGeneration"(
    "projectId", "projectRepositoryLinkId", "repositoryMaterialGenerationId", "id"
);
CREATE UNIQUE INDEX "RepositoryMaterialIndex_grant_key"
ON "RepositoryMaterialIndexGeneration"(
    "projectId", "projectRepositoryLinkId", "id", "grantId"
);
CREATE UNIQUE INDEX "RepositoryMaterialIndex_profile_key"
ON "RepositoryMaterialIndexGeneration"(
    "projectId", "projectRepositoryLinkId", "id", "embeddingProfileId"
);
CREATE UNIQUE INDEX "RepositoryMaterialIndex_generation_key"
ON "RepositoryMaterialIndexGeneration"("projectId", "generationKey");

CREATE TABLE "RepositoryMaterialIndexInput" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "projectRepositoryLinkId" UUID NOT NULL,
    "indexGenerationId" UUID NOT NULL,
    "grantId" UUID NOT NULL,
    "grantSourceId" UUID NOT NULL,
    "repositoryMaterialGenerationId" UUID NOT NULL,
    "materialGenerationEntryId" UUID NOT NULL,
    "projectSourceId" UUID NOT NULL,
    "sourceChunkId" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "contentHash" VARCHAR(64) NOT NULL,
    "contentBytes" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RepositoryMaterialIndexInput_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RepositoryMaterialIndexInput_values_check" CHECK (
        "ordinal" >= 0
        AND "contentHash" ~ '^[0-9a-f]{64}$'
        AND "contentBytes" > 0
    )
);

CREATE INDEX "RepositoryMaterialIndexInput_source_idx"
ON "RepositoryMaterialIndexInput"(
    "projectId", "projectRepositoryLinkId", "projectSourceId"
);
CREATE UNIQUE INDEX "RepositoryMaterialIndexInput_projectId_id_key"
ON "RepositoryMaterialIndexInput"("projectId", "id");
CREATE UNIQUE INDEX "RepositoryMaterialIndexInput_index_id_key"
ON "RepositoryMaterialIndexInput"(
    "projectId", "projectRepositoryLinkId", "indexGenerationId", "id"
);
CREATE UNIQUE INDEX "RepositoryMaterialIndexInput_exact_id_key"
ON "RepositoryMaterialIndexInput"(
    "projectId", "projectRepositoryLinkId", "indexGenerationId", "id", "sourceChunkId"
);
CREATE UNIQUE INDEX "RepositoryMaterialIndexInput_ordinal_key"
ON "RepositoryMaterialIndexInput"(
    "projectId", "projectRepositoryLinkId", "indexGenerationId", "ordinal"
);
CREATE UNIQUE INDEX "RepositoryMaterialIndexInput_chunk_key"
ON "RepositoryMaterialIndexInput"(
    "projectId", "projectRepositoryLinkId", "indexGenerationId", "sourceChunkId"
);

CREATE TABLE "RepositoryMaterialIndexAttempt" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "projectRepositoryLinkId" UUID NOT NULL,
    "indexGenerationId" UUID NOT NULL,
    "grantId" UUID NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "operationKey" VARCHAR(64) NOT NULL,
    "status" "IndexBuildAttemptStatus" NOT NULL DEFAULT 'queued',
    "expectedInputCount" INTEGER NOT NULL,
    "requestCount" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "safeErrorCode" VARCHAR(64),
    "providerRequestId" VARCHAR(512),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "RepositoryMaterialIndexAttempt_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RepositoryMaterialIndexAttempt_values_check" CHECK (
        "attemptNumber" > 0
        AND "operationKey" ~ '^[0-9a-f]{64}$'
        AND "expectedInputCount" > 0
        AND "requestCount" >= 0
        AND "inputTokens" >= 0
    )
);

CREATE INDEX "RepositoryMaterialIndexAttempt_status_idx"
ON "RepositoryMaterialIndexAttempt"(
    "projectId", "projectRepositoryLinkId", "indexGenerationId", "status"
);
CREATE UNIQUE INDEX "RepositoryMaterialIndexAttempt_projectId_id_key"
ON "RepositoryMaterialIndexAttempt"("projectId", "id");
CREATE UNIQUE INDEX "RepositoryMaterialIndexAttempt_index_id_key"
ON "RepositoryMaterialIndexAttempt"(
    "projectId", "projectRepositoryLinkId", "indexGenerationId", "id"
);
CREATE UNIQUE INDEX "RepositoryMaterialIndexAttempt_number_key"
ON "RepositoryMaterialIndexAttempt"(
    "projectId", "projectRepositoryLinkId", "indexGenerationId", "attemptNumber"
);
CREATE UNIQUE INDEX "RepositoryMaterialIndexAttempt_operation_key"
ON "RepositoryMaterialIndexAttempt"("projectId", "operationKey");

CREATE TABLE "RepositoryMaterialEmbedding" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "projectRepositoryLinkId" UUID NOT NULL,
    "indexGenerationId" UUID NOT NULL,
    "inputEntryId" UUID NOT NULL,
    "sourceChunkId" UUID NOT NULL,
    "embeddingProfileId" UUID NOT NULL,
    "attemptId" UUID NOT NULL,
    "vector" vector(1536) NOT NULL,
    "vectorFingerprint" VARCHAR(64) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RepositoryMaterialEmbedding_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RepositoryMaterialEmbedding_values_check" CHECK (
        "vectorFingerprint" ~ '^[0-9a-f]{64}$'
        AND vector_dims("vector") = 1536
        AND vector_norm("vector") BETWEEN 0.99 AND 1.01
    )
);

CREATE INDEX "RepositoryMaterialEmbedding_chunk_idx"
ON "RepositoryMaterialEmbedding"(
    "projectId", "projectRepositoryLinkId", "sourceChunkId", "embeddingProfileId"
);
CREATE UNIQUE INDEX "RepositoryMaterialEmbedding_projectId_id_key"
ON "RepositoryMaterialEmbedding"("projectId", "id");
CREATE UNIQUE INDEX "RepositoryMaterialEmbedding_input_key"
ON "RepositoryMaterialEmbedding"(
    "projectId", "projectRepositoryLinkId", "indexGenerationId", "inputEntryId"
);
CREATE UNIQUE INDEX "RepositoryMaterialEmbedding_exact_input_key"
ON "RepositoryMaterialEmbedding"(
    "projectId", "projectRepositoryLinkId", "indexGenerationId",
    "inputEntryId", "sourceChunkId"
);

CREATE TABLE "RepositoryMaterialIndexPointer" (
    "projectId" UUID NOT NULL,
    "projectRepositoryLinkId" UUID NOT NULL,
    "indexGenerationId" UUID NOT NULL,
    "repositoryMaterialGenerationId" UUID NOT NULL,
    "linkConfigVersion" INTEGER NOT NULL,
    "effectivePolicyVersion" INTEGER NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RepositoryMaterialIndexPointer_pkey"
        PRIMARY KEY ("projectId", "projectRepositoryLinkId")
);

CREATE UNIQUE INDEX "RepositoryMaterialIndexPointer_project_index_key"
ON "RepositoryMaterialIndexPointer"("projectId", "indexGenerationId");
CREATE UNIQUE INDEX "RepositoryMaterialIndexPointer_index_target_key"
ON "RepositoryMaterialIndexPointer"(
    "projectId", "projectRepositoryLinkId",
    "repositoryMaterialGenerationId", "indexGenerationId"
);
CREATE UNIQUE INDEX "RepositoryMaterialIndexPointer_exact_target_key"
ON "RepositoryMaterialIndexPointer"(
    "projectId", "projectRepositoryLinkId", "indexGenerationId",
    "repositoryMaterialGenerationId", "linkConfigVersion", "effectivePolicyVersion"
);

ALTER TABLE "RepositoryMaterialModelGrant"
ADD CONSTRAINT "RepositoryMaterialModelGrant_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "Project"("id")
ON DELETE CASCADE ON UPDATE CASCADE,
ADD CONSTRAINT "RepositoryMaterialModelGrant_link_fkey"
FOREIGN KEY ("projectId", "projectRepositoryLinkId")
REFERENCES "ProjectRepositoryLink"("projectId", "id")
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
ADD CONSTRAINT "RepositoryMaterialModelGrant_config_fkey"
FOREIGN KEY (
    "projectId", "projectRepositoryLinkId",
    "linkConfigVersion", "linkEffectivePolicyVersion"
)
REFERENCES "ProjectRepositoryLinkConfigVersion"(
    "projectId", "projectRepositoryLinkId", "version", "effectivePolicyVersion"
)
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
ADD CONSTRAINT "RepositoryMaterialModelGrant_generation_fkey"
FOREIGN KEY (
    "projectId", "projectRepositoryLinkId", "repositoryMaterialGenerationId"
)
REFERENCES "RepositoryMaterialGeneration"(
    "projectId", "projectRepositoryLinkId", "id"
)
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
ADD CONSTRAINT "RepositoryMaterialModelGrant_policy_fkey"
FOREIGN KEY ("projectId", "policyRevisionId")
REFERENCES "ProjectAiPolicyRevision"("projectId", "id")
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "RepositoryMaterialModelGrantSource"
ADD CONSTRAINT "RepositoryMaterialModelGrantSource_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "Project"("id")
ON DELETE CASCADE ON UPDATE CASCADE,
ADD CONSTRAINT "RepositoryMaterialGrantSource_link_fkey"
FOREIGN KEY ("projectId", "projectRepositoryLinkId")
REFERENCES "ProjectRepositoryLink"("projectId", "id")
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
ADD CONSTRAINT "RepositoryMaterialGrantSource_grant_fkey"
FOREIGN KEY (
    "projectId", "projectRepositoryLinkId", "repositoryMaterialGenerationId", "grantId"
)
REFERENCES "RepositoryMaterialModelGrant"(
    "projectId", "projectRepositoryLinkId", "repositoryMaterialGenerationId", "id"
)
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
ADD CONSTRAINT "RepositoryMaterialGrantSource_generation_fkey"
FOREIGN KEY (
    "projectId", "projectRepositoryLinkId", "repositoryMaterialGenerationId"
)
REFERENCES "RepositoryMaterialGeneration"(
    "projectId", "projectRepositoryLinkId", "id"
)
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
ADD CONSTRAINT "RepositoryMaterialGrantSource_entry_fkey"
FOREIGN KEY (
    "projectId", "projectRepositoryLinkId", "repositoryMaterialGenerationId",
    "materialGenerationEntryId", "githubSourceVersionId", "projectSourceId"
)
REFERENCES "RepositoryMaterialGenerationEntry"(
    "projectId", "projectRepositoryLinkId", "repositoryMaterialGenerationId",
    "id", "githubSourceVersionId", "projectSourceId"
)
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
ADD CONSTRAINT "RepositoryMaterialGrantSource_source_fkey"
FOREIGN KEY (
    "projectId", "projectSourceId", "originScope", "projectRepositoryLinkId",
    "sourceRevisionKey", "sourceContentHash"
)
REFERENCES "ProjectSource"(
    "projectId", "id", "originScope", "projectRepositoryLinkId",
    "revisionKey", "contentHash"
)
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "RepositoryMaterialChunk"
ADD CONSTRAINT "RepositoryMaterialChunk_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "Project"("id")
ON DELETE CASCADE ON UPDATE CASCADE,
ADD CONSTRAINT "RepositoryMaterialChunk_link_fkey"
FOREIGN KEY ("projectId", "projectRepositoryLinkId")
REFERENCES "ProjectRepositoryLink"("projectId", "id")
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
ADD CONSTRAINT "RepositoryMaterialChunk_generation_fkey"
FOREIGN KEY (
    "projectId", "projectRepositoryLinkId", "repositoryMaterialGenerationId"
)
REFERENCES "RepositoryMaterialGeneration"(
    "projectId", "projectRepositoryLinkId", "id"
)
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
ADD CONSTRAINT "RepositoryMaterialChunk_entry_fkey"
FOREIGN KEY (
    "projectId", "projectRepositoryLinkId", "repositoryMaterialGenerationId",
    "materialGenerationEntryId", "githubSourceVersionId", "projectSourceId"
)
REFERENCES "RepositoryMaterialGenerationEntry"(
    "projectId", "projectRepositoryLinkId", "repositoryMaterialGenerationId",
    "id", "githubSourceVersionId", "projectSourceId"
)
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
ADD CONSTRAINT "RepositoryMaterialChunk_source_fkey"
FOREIGN KEY (
    "projectId", "projectSourceId", "originScope", "projectRepositoryLinkId",
    "sourceRevisionKey", "sourceContentHash"
)
REFERENCES "ProjectSource"(
    "projectId", "id", "originScope", "projectRepositoryLinkId",
    "revisionKey", "contentHash"
)
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "RepositoryMaterialIndexGeneration"
ADD CONSTRAINT "RepositoryMaterialIndexGeneration_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "Project"("id")
ON DELETE CASCADE ON UPDATE CASCADE,
ADD CONSTRAINT "RepositoryMaterialIndex_link_fkey"
FOREIGN KEY ("projectId", "projectRepositoryLinkId")
REFERENCES "ProjectRepositoryLink"("projectId", "id")
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
ADD CONSTRAINT "RepositoryMaterialIndex_config_fkey"
FOREIGN KEY (
    "projectId", "projectRepositoryLinkId", "linkConfigVersion", "effectivePolicyVersion"
)
REFERENCES "ProjectRepositoryLinkConfigVersion"(
    "projectId", "projectRepositoryLinkId", "version", "effectivePolicyVersion"
)
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
ADD CONSTRAINT "RepositoryMaterialIndex_generation_fkey"
FOREIGN KEY (
    "projectId", "projectRepositoryLinkId", "repositoryMaterialGenerationId"
)
REFERENCES "RepositoryMaterialGeneration"(
    "projectId", "projectRepositoryLinkId", "id"
)
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
ADD CONSTRAINT "RepositoryMaterialIndex_expected_fkey"
FOREIGN KEY (
    "projectId", "projectRepositoryLinkId", "expectedActiveIndexGenerationId"
)
REFERENCES "RepositoryMaterialIndexGeneration"(
    "projectId", "projectRepositoryLinkId", "id"
)
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
ADD CONSTRAINT "RepositoryMaterialIndex_grant_fkey"
FOREIGN KEY (
    "projectId", "projectRepositoryLinkId", "repositoryMaterialGenerationId", "grantId"
)
REFERENCES "RepositoryMaterialModelGrant"(
    "projectId", "projectRepositoryLinkId", "repositoryMaterialGenerationId", "id"
)
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
ADD CONSTRAINT "RepositoryMaterialIndex_policy_fkey"
FOREIGN KEY ("projectId", "policyRevisionId")
REFERENCES "ProjectAiPolicyRevision"("projectId", "id")
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
ADD CONSTRAINT "RepositoryMaterialIndex_profile_fkey"
FOREIGN KEY ("embeddingProfileId") REFERENCES "EmbeddingProfile"("id")
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "RepositoryMaterialIndexInput"
ADD CONSTRAINT "RepositoryMaterialIndexInput_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "Project"("id")
ON DELETE CASCADE ON UPDATE CASCADE,
ADD CONSTRAINT "RepositoryMaterialIndexInput_link_fkey"
FOREIGN KEY ("projectId", "projectRepositoryLinkId")
REFERENCES "ProjectRepositoryLink"("projectId", "id")
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
ADD CONSTRAINT "RepositoryMaterialIndexInput_index_fkey"
FOREIGN KEY (
    "projectId", "projectRepositoryLinkId",
    "repositoryMaterialGenerationId", "indexGenerationId"
)
REFERENCES "RepositoryMaterialIndexGeneration"(
    "projectId", "projectRepositoryLinkId",
    "repositoryMaterialGenerationId", "id"
)
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
ADD CONSTRAINT "RepositoryMaterialIndexInput_grant_source_fkey"
FOREIGN KEY (
    "projectId", "projectRepositoryLinkId", "grantId", "grantSourceId",
    "repositoryMaterialGenerationId", "materialGenerationEntryId", "projectSourceId"
)
REFERENCES "RepositoryMaterialModelGrantSource"(
    "projectId", "projectRepositoryLinkId", "grantId", "id",
    "repositoryMaterialGenerationId", "materialGenerationEntryId", "projectSourceId"
)
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
ADD CONSTRAINT "RepositoryMaterialIndexInput_generation_fkey"
FOREIGN KEY (
    "projectId", "projectRepositoryLinkId", "repositoryMaterialGenerationId"
)
REFERENCES "RepositoryMaterialGeneration"(
    "projectId", "projectRepositoryLinkId", "id"
)
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
ADD CONSTRAINT "RepositoryMaterialIndexInput_entry_fkey"
FOREIGN KEY (
    "projectId", "projectRepositoryLinkId",
    "repositoryMaterialGenerationId", "materialGenerationEntryId"
)
REFERENCES "RepositoryMaterialGenerationEntry"(
    "projectId", "projectRepositoryLinkId", "repositoryMaterialGenerationId", "id"
)
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
ADD CONSTRAINT "RepositoryMaterialIndexInput_chunk_fkey"
FOREIGN KEY (
    "projectId", "projectRepositoryLinkId", "repositoryMaterialGenerationId",
    "materialGenerationEntryId", "sourceChunkId"
)
REFERENCES "RepositoryMaterialChunk"(
    "projectId", "projectRepositoryLinkId", "repositoryMaterialGenerationId",
    "materialGenerationEntryId", "id"
)
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "RepositoryMaterialIndexAttempt"
ADD CONSTRAINT "RepositoryMaterialIndexAttempt_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "Project"("id")
ON DELETE CASCADE ON UPDATE CASCADE,
ADD CONSTRAINT "RepositoryMaterialIndexAttempt_link_fkey"
FOREIGN KEY ("projectId", "projectRepositoryLinkId")
REFERENCES "ProjectRepositoryLink"("projectId", "id")
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
ADD CONSTRAINT "RepositoryMaterialIndexAttempt_index_fkey"
FOREIGN KEY (
    "projectId", "projectRepositoryLinkId", "indexGenerationId", "grantId"
)
REFERENCES "RepositoryMaterialIndexGeneration"(
    "projectId", "projectRepositoryLinkId", "id", "grantId"
)
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "RepositoryMaterialEmbedding"
ADD CONSTRAINT "RepositoryMaterialEmbedding_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "Project"("id")
ON DELETE CASCADE ON UPDATE CASCADE,
ADD CONSTRAINT "RepositoryMaterialEmbedding_link_fkey"
FOREIGN KEY ("projectId", "projectRepositoryLinkId")
REFERENCES "ProjectRepositoryLink"("projectId", "id")
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
ADD CONSTRAINT "RepositoryMaterialEmbedding_index_fkey"
FOREIGN KEY (
    "projectId", "projectRepositoryLinkId", "indexGenerationId", "embeddingProfileId"
)
REFERENCES "RepositoryMaterialIndexGeneration"(
    "projectId", "projectRepositoryLinkId", "id", "embeddingProfileId"
)
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
ADD CONSTRAINT "RepositoryMaterialEmbedding_input_fkey"
FOREIGN KEY (
    "projectId", "projectRepositoryLinkId", "indexGenerationId",
    "inputEntryId", "sourceChunkId"
)
REFERENCES "RepositoryMaterialIndexInput"(
    "projectId", "projectRepositoryLinkId", "indexGenerationId",
    "id", "sourceChunkId"
)
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
ADD CONSTRAINT "RepositoryMaterialEmbedding_profile_fkey"
FOREIGN KEY ("embeddingProfileId") REFERENCES "EmbeddingProfile"("id")
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
ADD CONSTRAINT "RepositoryMaterialEmbedding_attempt_fkey"
FOREIGN KEY (
    "projectId", "projectRepositoryLinkId", "indexGenerationId", "attemptId"
)
REFERENCES "RepositoryMaterialIndexAttempt"(
    "projectId", "projectRepositoryLinkId", "indexGenerationId", "id"
)
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "RepositoryMaterialIndexPointer"
ADD CONSTRAINT "RepositoryMaterialIndexPointer_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "Project"("id")
ON DELETE CASCADE ON UPDATE CASCADE,
ADD CONSTRAINT "RepositoryMaterialIndexPointer_link_fkey"
FOREIGN KEY ("projectId", "projectRepositoryLinkId")
REFERENCES "ProjectRepositoryLink"("projectId", "id")
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
ADD CONSTRAINT "RepositoryMaterialIndexPointer_config_fkey"
FOREIGN KEY (
    "projectId", "projectRepositoryLinkId", "linkConfigVersion", "effectivePolicyVersion"
)
REFERENCES "ProjectRepositoryLinkConfigVersion"(
    "projectId", "projectRepositoryLinkId", "version", "effectivePolicyVersion"
)
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
ADD CONSTRAINT "RepositoryMaterialIndexPointer_index_fkey"
FOREIGN KEY (
    "projectId", "projectRepositoryLinkId",
    "repositoryMaterialGenerationId", "indexGenerationId"
)
REFERENCES "RepositoryMaterialIndexGeneration"(
    "projectId", "projectRepositoryLinkId",
    "repositoryMaterialGenerationId", "id"
)
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

CREATE OR REPLACE FUNCTION "repository_material_grant_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    eligible BOOLEAN;
    actual_source_count BIGINT;
    actual_source_bytes BIGINT;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."status" <> 'draft' THEN
            RAISE EXCEPTION 'repository material grant must start draft'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;
    IF TG_OP = 'DELETE' THEN
        IF EXISTS (SELECT 1 FROM "Project" WHERE "id" = OLD."projectId") THEN
            RAISE EXCEPTION 'repository material grant is append-only'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN OLD;
    END IF;

    IF ROW(
        NEW."id", NEW."projectId", NEW."projectRepositoryLinkId",
        NEW."repositoryMaterialGenerationId", NEW."linkConfigVersion",
        NEW."linkEffectivePolicyVersion", NEW."policyRevisionId",
        NEW."effectivePolicyVersion", NEW."operation", NEW."profileFingerprint",
        NEW."providerFingerprint", NEW."modelFingerprint", NEW."modelId",
        NEW."processorFingerprint", NEW."regionFingerprint",
        NEW."retentionFingerprint", NEW."endpointFingerprint",
        NEW."grantFingerprint", NEW."materialPolicyFingerprint",
        NEW."sourceManifestFingerprint", NEW."scannerFingerprint",
        NEW."scannerVersion", NEW."consentVersion", NEW."sourceCount",
        NEW."sourceBytes", NEW."issuedBy", NEW."purposeCode", NEW."createdAt"
    ) IS DISTINCT FROM ROW(
        OLD."id", OLD."projectId", OLD."projectRepositoryLinkId",
        OLD."repositoryMaterialGenerationId", OLD."linkConfigVersion",
        OLD."linkEffectivePolicyVersion", OLD."policyRevisionId",
        OLD."effectivePolicyVersion", OLD."operation", OLD."profileFingerprint",
        OLD."providerFingerprint", OLD."modelFingerprint", OLD."modelId",
        OLD."processorFingerprint", OLD."regionFingerprint",
        OLD."retentionFingerprint", OLD."endpointFingerprint",
        OLD."grantFingerprint", OLD."materialPolicyFingerprint",
        OLD."sourceManifestFingerprint", OLD."scannerFingerprint",
        OLD."scannerVersion", OLD."consentVersion", OLD."sourceCount",
        OLD."sourceBytes", OLD."issuedBy", OLD."purposeCode", OLD."createdAt"
    ) THEN
        RAISE EXCEPTION 'repository material grant boundary is immutable'
            USING ERRCODE = 'check_violation';
    END IF;

    IF OLD."status" = 'draft' AND NEW."status" = 'issued' THEN
        SELECT EXISTS (
            SELECT 1
            FROM "ProjectRepositoryLink" AS link
            JOIN "ProjectRepositoryLinkConfigPointer" AS config_pointer
              ON config_pointer."projectId" = link."projectId"
             AND config_pointer."projectRepositoryLinkId" = link."id"
            JOIN "ProjectRepositoryLinkConfigVersion" AS config
              ON config."projectId" = config_pointer."projectId"
             AND config."projectRepositoryLinkId" = config_pointer."projectRepositoryLinkId"
             AND config."version" = config_pointer."configVersion"
             AND config."effectivePolicyVersion" = config_pointer."effectivePolicyVersion"
            JOIN "RepositoryMaterialGenerationPointer" AS material_pointer
              ON material_pointer."projectId" = link."projectId"
             AND material_pointer."projectRepositoryLinkId" = link."id"
            JOIN "RepositoryMaterialGeneration" AS generation
              ON generation."projectId" = material_pointer."projectId"
             AND generation."projectRepositoryLinkId" = material_pointer."projectRepositoryLinkId"
             AND generation."id" = material_pointer."repositoryMaterialGenerationId"
            JOIN "ProjectAiPolicy" AS policy
              ON policy."projectId" = link."projectId"
            JOIN "ProjectAiPolicyRevision" AS revision
              ON revision."projectId" = policy."projectId"
             AND revision."id" = policy."currentRevisionId"
            JOIN "ProjectAiPolicyOperationProfile" AS profile
              ON profile."projectId" = revision."projectId"
             AND profile."policyRevisionId" = revision."id"
             AND profile."operation" = NEW."operation"
            WHERE link."projectId" = NEW."projectId"
              AND link."id" = NEW."projectRepositoryLinkId"
              AND link."status" = 'active'
              AND link."effectivePolicyVersion" = NEW."linkEffectivePolicyVersion"
              AND config_pointer."configVersion" = NEW."linkConfigVersion"
              AND config_pointer."effectivePolicyVersion" = NEW."linkEffectivePolicyVersion"
              AND material_pointer."repositoryMaterialGenerationId" =
                  NEW."repositoryMaterialGenerationId"
              AND material_pointer."linkConfigVersion" = NEW."linkConfigVersion"
              AND material_pointer."effectivePolicyVersion" = NEW."linkEffectivePolicyVersion"
              AND generation."status" = 'complete'
              AND generation."manifestFingerprint" = NEW."sourceManifestFingerprint"
              AND generation."scannerFingerprint" = NEW."scannerFingerprint"
              AND generation."scannerVersion" = NEW."scannerVersion"
              AND generation."sourceCount" = NEW."sourceCount"
              AND generation."decodedTextBytes" = NEW."sourceBytes"
              AND config."policyFingerprint" = NEW."materialPolicyFingerprint"
              AND revision."id" = NEW."policyRevisionId"
              AND revision."revision" = NEW."effectivePolicyVersion"
              AND revision."outboundEnabled" = TRUE
              AND CASE NEW."operation"
                  WHEN 'embedding' THEN revision."embeddingEnabled"
                  WHEN 'autoExtract' THEN revision."autoExtractEnabled"
                  WHEN 'sourceSummary' THEN revision."sourceSummaryEnabled"
                  WHEN 'projectAnalysis' THEN revision."projectAnalysisEnabled"
                  WHEN 'generateWithContext' THEN revision."generateWithContextEnabled"
                  ELSE FALSE
              END
              AND profile."profileFingerprint" = NEW."profileFingerprint"
              AND profile."providerFingerprint" = NEW."providerFingerprint"
              AND profile."modelFingerprint" = NEW."modelFingerprint"
              AND profile."modelId" = NEW."modelId"
              AND profile."processorFingerprint" = NEW."processorFingerprint"
              AND profile."regionFingerprint" = NEW."regionFingerprint"
              AND profile."retentionFingerprint" = NEW."retentionFingerprint"
              AND profile."endpointFingerprint" = NEW."endpointFingerprint"
        ) INTO eligible;
        SELECT COUNT(*), COALESCE(SUM("contentBytes"), 0)
        INTO actual_source_count, actual_source_bytes
        FROM "RepositoryMaterialModelGrantSource"
        WHERE "projectId" = NEW."projectId"
          AND "projectRepositoryLinkId" = NEW."projectRepositoryLinkId"
          AND "grantId" = NEW."id";
        IF eligible IS NOT TRUE
            OR actual_source_count <> NEW."sourceCount"
            OR actual_source_bytes <> NEW."sourceBytes" THEN
            RAISE EXCEPTION 'repository material grant is not issuable'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;

    IF OLD."status" = 'issued' AND NEW."status" = 'revoked'
        AND NEW."issuedAt" IS NOT DISTINCT FROM OLD."issuedAt"
        AND NEW."expiresAt" IS NOT DISTINCT FROM OLD."expiresAt"
        AND NEW."revokedAt" IS NOT NULL
        AND NEW."revocationReasonCode" IS NOT NULL THEN
        RETURN NEW;
    END IF;
    IF NEW."status" IS NOT DISTINCT FROM OLD."status"
        AND NEW."issuedAt" IS NOT DISTINCT FROM OLD."issuedAt"
        AND NEW."expiresAt" IS NOT DISTINCT FROM OLD."expiresAt"
        AND NEW."revokedAt" IS NOT DISTINCT FROM OLD."revokedAt"
        AND NEW."revocationReasonCode" IS NOT DISTINCT FROM OLD."revocationReasonCode" THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'invalid repository material grant transition'
        USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER "RepositoryMaterialModelGrant_lifecycle_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "RepositoryMaterialModelGrant"
FOR EACH ROW EXECUTE FUNCTION "repository_material_grant_guard"();

CREATE OR REPLACE FUNCTION "repository_material_grant_source_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    grant_status "ModelProcessingGrantStatus";
    actual_hash TEXT;
    actual_bytes INTEGER;
BEGIN
    IF TG_OP = 'INSERT' THEN
        SELECT g."status" INTO grant_status
        FROM "RepositoryMaterialModelGrant" AS g
        WHERE g."projectId" = NEW."projectId"
          AND g."projectRepositoryLinkId" = NEW."projectRepositoryLinkId"
          AND g."id" = NEW."grantId"
        FOR KEY SHARE;
        SELECT s."contentHash", octet_length(s."contentText")
        INTO actual_hash, actual_bytes
        FROM "ProjectSource" AS s
        WHERE s."projectId" = NEW."projectId"
          AND s."id" = NEW."projectSourceId"
          AND s."originScope" = NEW."originScope"
          AND s."projectRepositoryLinkId" = NEW."projectRepositoryLinkId"
          AND s."revisionKey" = NEW."sourceRevisionKey";
        IF grant_status IS DISTINCT FROM 'draft'
            OR actual_hash IS DISTINCT FROM NEW."sourceContentHash"
            OR actual_bytes IS DISTINCT FROM NEW."contentBytes" THEN
            RAISE EXCEPTION 'repository material grant source is not exact'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;
    IF EXISTS (SELECT 1 FROM "Project" WHERE "id" = OLD."projectId") THEN
        RAISE EXCEPTION 'repository material grant source is immutable'
            USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "RepositoryMaterialGrantSource_lifecycle_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "RepositoryMaterialModelGrantSource"
FOR EACH ROW EXECUTE FUNCTION "repository_material_grant_source_guard"();

CREATE OR REPLACE FUNCTION "repository_material_chunk_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    source_content TEXT;
    source_hash TEXT;
    active_generation_id UUID;
BEGIN
    IF TG_OP = 'INSERT' THEN
        SELECT s."contentText", s."contentHash"
        INTO source_content, source_hash
        FROM "ProjectSource" AS s
        WHERE s."projectId" = NEW."projectId"
          AND s."id" = NEW."projectSourceId"
          AND s."originScope" = NEW."originScope"
          AND s."projectRepositoryLinkId" = NEW."projectRepositoryLinkId"
          AND s."revisionKey" = NEW."sourceRevisionKey"
        FOR KEY SHARE;
        SELECT p."repositoryMaterialGenerationId"
        INTO active_generation_id
        FROM "RepositoryMaterialGenerationPointer" AS p
        WHERE p."projectId" = NEW."projectId"
          AND p."projectRepositoryLinkId" = NEW."projectRepositoryLinkId";
        IF active_generation_id IS DISTINCT FROM NEW."repositoryMaterialGenerationId"
            OR source_hash IS DISTINCT FROM NEW."sourceContentHash"
            OR NEW."contentHash" IS DISTINCT FROM
                encode(sha256(convert_to(NEW."contentText", 'UTF8')), 'hex')
            OR substring(
                convert_to(source_content, 'UTF8')
                FROM NEW."rangeStart" + 1
                FOR NEW."rangeEnd" - NEW."rangeStart"
            ) IS DISTINCT FROM convert_to(NEW."contentText", 'UTF8') THEN
            RAISE EXCEPTION 'repository material chunk does not match active source bytes'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;
    IF EXISTS (SELECT 1 FROM "Project" WHERE "id" = OLD."projectId") THEN
        RAISE EXCEPTION 'repository material chunk is immutable'
            USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "RepositoryMaterialChunk_lifecycle_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "RepositoryMaterialChunk"
FOR EACH ROW EXECUTE FUNCTION "repository_material_chunk_guard"();

CREATE OR REPLACE FUNCTION "repository_material_index_input_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    parent_status "IndexGenerationStatus";
    parent_grant UUID;
    chunk_hash TEXT;
    chunk_bytes INTEGER;
BEGIN
    IF TG_OP = 'INSERT' THEN
        SELECT i."status", i."grantId"
        INTO parent_status, parent_grant
        FROM "RepositoryMaterialIndexGeneration" AS i
        WHERE i."projectId" = NEW."projectId"
          AND i."projectRepositoryLinkId" = NEW."projectRepositoryLinkId"
          AND i."id" = NEW."indexGenerationId"
        FOR KEY SHARE;
        SELECT c."contentHash", c."contentBytes"
        INTO chunk_hash, chunk_bytes
        FROM "RepositoryMaterialChunk" AS c
        WHERE c."projectId" = NEW."projectId"
          AND c."projectRepositoryLinkId" = NEW."projectRepositoryLinkId"
          AND c."id" = NEW."sourceChunkId"
        FOR KEY SHARE;
        IF parent_status IS DISTINCT FROM 'staging'
            OR parent_grant IS DISTINCT FROM NEW."grantId"
            OR chunk_hash IS DISTINCT FROM NEW."contentHash"
            OR chunk_bytes IS DISTINCT FROM NEW."contentBytes" THEN
            RAISE EXCEPTION 'repository material index input is not exact'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;
    IF EXISTS (SELECT 1 FROM "Project" WHERE "id" = OLD."projectId") THEN
        RAISE EXCEPTION 'repository material index input is immutable'
            USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "RepositoryMaterialIndexInput_lifecycle_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "RepositoryMaterialIndexInput"
FOR EACH ROW EXECUTE FUNCTION "repository_material_index_input_guard"();

CREATE OR REPLACE FUNCTION "repository_material_index_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    current_index_id UUID;
    eligible BOOLEAN;
    actual_inputs BIGINT;
    actual_embeddings BIGINT;
    succeeded_attempts BIGINT;
    actual_manifest TEXT;
BEGIN
    IF TG_OP = 'INSERT' THEN
        PERFORM 1
        FROM "ProjectRepositoryLink" AS link
        WHERE link."projectId" = NEW."projectId"
          AND link."id" = NEW."projectRepositoryLinkId"
        FOR UPDATE;
        IF NOT FOUND OR NEW."status" <> 'staging' THEN
            RAISE EXCEPTION 'repository material index must start staging'
                USING ERRCODE = 'check_violation';
        END IF;
        SELECT pointer."indexGenerationId"
        INTO current_index_id
        FROM "RepositoryMaterialIndexPointer" AS pointer
        WHERE pointer."projectId" = NEW."projectId"
          AND pointer."projectRepositoryLinkId" = NEW."projectRepositoryLinkId";
        IF NEW."expectedActiveIndexGenerationId" IS DISTINCT FROM current_index_id THEN
            RAISE EXCEPTION 'repository material index expected pointer is stale'
                USING ERRCODE = 'serialization_failure';
        END IF;
        SELECT EXISTS (
            SELECT 1
            FROM "RepositoryMaterialModelGrant" AS grant_row
            JOIN "ProjectAiPolicy" AS policy
              ON policy."projectId" = grant_row."projectId"
             AND policy."currentRevisionId" = grant_row."policyRevisionId"
            JOIN "RepositoryMaterialGenerationPointer" AS material_pointer
              ON material_pointer."projectId" = grant_row."projectId"
             AND material_pointer."projectRepositoryLinkId" =
                 grant_row."projectRepositoryLinkId"
            JOIN "ProjectRepositoryLinkConfigPointer" AS config_pointer
              ON config_pointer."projectId" = grant_row."projectId"
             AND config_pointer."projectRepositoryLinkId" =
                 grant_row."projectRepositoryLinkId"
            WHERE grant_row."projectId" = NEW."projectId"
              AND grant_row."projectRepositoryLinkId" = NEW."projectRepositoryLinkId"
              AND grant_row."id" = NEW."grantId"
              AND grant_row."repositoryMaterialGenerationId" =
                  NEW."repositoryMaterialGenerationId"
              AND grant_row."policyRevisionId" = NEW."policyRevisionId"
              AND grant_row."effectivePolicyVersion" = NEW."effectivePolicyVersion"
              AND grant_row."linkConfigVersion" = NEW."linkConfigVersion"
              AND grant_row."operation" = 'embedding'
              AND grant_row."status" = 'issued'
              AND grant_row."revokedAt" IS NULL
              AND grant_row."expiresAt" > CURRENT_TIMESTAMP
              AND material_pointer."repositoryMaterialGenerationId" =
                  NEW."repositoryMaterialGenerationId"
              AND material_pointer."linkConfigVersion" = NEW."linkConfigVersion"
              AND material_pointer."effectivePolicyVersion" = NEW."effectivePolicyVersion"
              AND config_pointer."configVersion" = NEW."linkConfigVersion"
              AND config_pointer."effectivePolicyVersion" = NEW."effectivePolicyVersion"
        ) INTO eligible;
        IF eligible IS NOT TRUE THEN
            RAISE EXCEPTION 'repository material index boundary is ineligible'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;
    IF TG_OP = 'DELETE' THEN
        IF EXISTS (SELECT 1 FROM "Project" WHERE "id" = OLD."projectId") THEN
            RAISE EXCEPTION 'repository material index is immutable'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN OLD;
    END IF;

    IF ROW(
        NEW."id", NEW."projectId", NEW."projectRepositoryLinkId",
        NEW."repositoryMaterialGenerationId", NEW."expectedActiveIndexGenerationId",
        NEW."linkConfigVersion", NEW."grantId", NEW."policyRevisionId",
        NEW."effectivePolicyVersion", NEW."embeddingProfileId",
        NEW."generationKey", NEW."inputManifestFingerprint",
        NEW."processingBoundaryFingerprint", NEW."chunkerVersion",
        NEW."expectedInputCount", NEW."createdAt"
    ) IS DISTINCT FROM ROW(
        OLD."id", OLD."projectId", OLD."projectRepositoryLinkId",
        OLD."repositoryMaterialGenerationId", OLD."expectedActiveIndexGenerationId",
        OLD."linkConfigVersion", OLD."grantId", OLD."policyRevisionId",
        OLD."effectivePolicyVersion", OLD."embeddingProfileId",
        OLD."generationKey", OLD."inputManifestFingerprint",
        OLD."processingBoundaryFingerprint", OLD."chunkerVersion",
        OLD."expectedInputCount", OLD."createdAt"
    ) THEN
        RAISE EXCEPTION 'repository material index boundary is immutable'
            USING ERRCODE = 'check_violation';
    END IF;

    IF OLD."status" = 'staging' AND NEW."status" = 'building' THEN
        SELECT COUNT(*) INTO actual_inputs
        FROM "RepositoryMaterialIndexInput" AS input_row
        WHERE input_row."projectId" = NEW."projectId"
          AND input_row."projectRepositoryLinkId" = NEW."projectRepositoryLinkId"
          AND input_row."indexGenerationId" = NEW."id";
        SELECT encode(sha256(convert_to(string_agg(concat_ws(E'\x1f',
            input_row."ordinal"::text, input_row."id"::text,
            input_row."sourceChunkId"::text, input_row."contentHash",
            input_row."contentBytes"::text
        ), E'\x1e' ORDER BY input_row."ordinal"), 'UTF8')), 'hex')
        INTO actual_manifest
        FROM "RepositoryMaterialIndexInput" AS input_row
        WHERE input_row."projectId" = NEW."projectId"
          AND input_row."projectRepositoryLinkId" = NEW."projectRepositoryLinkId"
          AND input_row."indexGenerationId" = NEW."id";
        IF actual_inputs <> NEW."expectedInputCount"
            OR actual_manifest IS DISTINCT FROM NEW."inputManifestFingerprint"
            OR NEW."buildStartedAt" IS NULL THEN
            RAISE EXCEPTION 'repository material index manifest is incomplete'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;

    IF OLD."status" IN ('building', 'unknown')
        AND NEW."status" = 'rag_ready' THEN
        SELECT COUNT(*) INTO actual_embeddings
        FROM "RepositoryMaterialEmbedding" AS embedding
        WHERE embedding."projectId" = NEW."projectId"
          AND embedding."projectRepositoryLinkId" = NEW."projectRepositoryLinkId"
          AND embedding."indexGenerationId" = NEW."id";
        SELECT COUNT(*) INTO succeeded_attempts
        FROM "RepositoryMaterialIndexAttempt" AS attempt
        WHERE attempt."projectId" = NEW."projectId"
          AND attempt."projectRepositoryLinkId" = NEW."projectRepositoryLinkId"
          AND attempt."indexGenerationId" = NEW."id"
          AND attempt."status" = 'succeeded';
        IF actual_embeddings <> NEW."expectedInputCount"
            OR NEW."indexedInputCount" <> NEW."expectedInputCount"
            OR succeeded_attempts <> 1
            OR NEW."completedAt" IS NULL THEN
            RAISE EXCEPTION 'repository material index is incomplete'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;

    IF NEW."status" IN ('failed', 'unknown', 'cancelled', 'ineligible')
        AND OLD."status" IN ('staging', 'building', 'unknown')
        AND NEW."failureCode" IS NOT NULL THEN
        RETURN NEW;
    END IF;
    IF OLD."status" IN ('rag_ready', 'failed', 'cancelled', 'ineligible')
        AND NEW."status" = 'superseded' AND NEW."supersededAt" IS NOT NULL THEN
        RETURN NEW;
    END IF;
    IF OLD."status" = 'rag_ready' AND NEW."status" = 'rag_ready'
        AND OLD."publishedAt" IS NULL AND NEW."publishedAt" IS NOT NULL
        AND NEW."indexedInputCount" = OLD."indexedInputCount"
        AND NEW."failureCode" IS NOT DISTINCT FROM OLD."failureCode"
        AND NEW."buildStartedAt" IS NOT DISTINCT FROM OLD."buildStartedAt"
        AND NEW."completedAt" IS NOT DISTINCT FROM OLD."completedAt"
        AND NEW."supersededAt" IS NOT DISTINCT FROM OLD."supersededAt" THEN
        RETURN NEW;
    END IF;
    IF NEW."status" IS NOT DISTINCT FROM OLD."status"
        AND NEW."indexedInputCount" IS NOT DISTINCT FROM OLD."indexedInputCount"
        AND NEW."failureCode" IS NOT DISTINCT FROM OLD."failureCode"
        AND NEW."buildStartedAt" IS NOT DISTINCT FROM OLD."buildStartedAt"
        AND NEW."completedAt" IS NOT DISTINCT FROM OLD."completedAt"
        AND NEW."publishedAt" IS NOT DISTINCT FROM OLD."publishedAt"
        AND NEW."supersededAt" IS NOT DISTINCT FROM OLD."supersededAt" THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'invalid repository material index transition'
        USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER "RepositoryMaterialIndex_lifecycle_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "RepositoryMaterialIndexGeneration"
FOR EACH ROW EXECUTE FUNCTION "repository_material_index_guard"();

CREATE OR REPLACE FUNCTION "repository_material_index_attempt_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    parent_status "IndexGenerationStatus";
    parent_expected INTEGER;
    embedding_count BIGINT;
BEGIN
    IF TG_OP = 'INSERT' THEN
        SELECT i."status", i."expectedInputCount"
        INTO parent_status, parent_expected
        FROM "RepositoryMaterialIndexGeneration" AS i
        WHERE i."projectId" = NEW."projectId"
          AND i."projectRepositoryLinkId" = NEW."projectRepositoryLinkId"
          AND i."id" = NEW."indexGenerationId"
        FOR KEY SHARE;
        IF NEW."status" <> 'queued'
            OR parent_status IS DISTINCT FROM 'building'
            OR NEW."expectedInputCount" IS DISTINCT FROM parent_expected
            OR NEW."requestCount" <> 0 OR NEW."inputTokens" <> 0
            OR NEW."startedAt" IS NOT NULL OR NEW."sentAt" IS NOT NULL
            OR NEW."completedAt" IS NOT NULL OR NEW."safeErrorCode" IS NOT NULL
            OR NEW."providerRequestId" IS NOT NULL THEN
            RAISE EXCEPTION 'repository material attempt must start queued'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;
    IF TG_OP = 'DELETE' THEN
        IF EXISTS (SELECT 1 FROM "Project" WHERE "id" = OLD."projectId") THEN
            RAISE EXCEPTION 'repository material attempt is append-only'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN OLD;
    END IF;
    IF ROW(
        NEW."id", NEW."projectId", NEW."projectRepositoryLinkId",
        NEW."indexGenerationId", NEW."grantId", NEW."attemptNumber",
        NEW."operationKey", NEW."expectedInputCount", NEW."createdAt"
    ) IS DISTINCT FROM ROW(
        OLD."id", OLD."projectId", OLD."projectRepositoryLinkId",
        OLD."indexGenerationId", OLD."grantId", OLD."attemptNumber",
        OLD."operationKey", OLD."expectedInputCount", OLD."createdAt"
    ) THEN
        RAISE EXCEPTION 'repository material attempt identity is immutable'
            USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'queued' AND NEW."status" = 'running'
        AND NEW."startedAt" IS NOT NULL
        AND NEW."completedAt" IS NULL
        AND NEW."safeErrorCode" IS NULL THEN
        RETURN NEW;
    END IF;
    IF OLD."status" = 'running' AND NEW."status" = 'succeeded'
        AND NEW."completedAt" IS NOT NULL
        AND NEW."requestCount" > 0
        AND NEW."safeErrorCode" IS NULL THEN
        SELECT COUNT(*) INTO embedding_count
        FROM "RepositoryMaterialEmbedding" AS embedding
        WHERE embedding."projectId" = NEW."projectId"
          AND embedding."projectRepositoryLinkId" = NEW."projectRepositoryLinkId"
          AND embedding."indexGenerationId" = NEW."indexGenerationId"
          AND embedding."attemptId" = NEW."id";
        IF embedding_count <> NEW."expectedInputCount" THEN
            RAISE EXCEPTION 'repository material attempt embeddings are incomplete'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;
    IF OLD."status" IN ('queued', 'running')
        AND NEW."status" IN ('failed', 'unknown', 'cancelled')
        AND NEW."completedAt" IS NOT NULL
        AND NEW."safeErrorCode" IS NOT NULL THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'invalid repository material attempt transition'
        USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER "RepositoryMaterialIndexAttempt_lifecycle_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "RepositoryMaterialIndexAttempt"
FOR EACH ROW EXECUTE FUNCTION "repository_material_index_attempt_guard"();

CREATE OR REPLACE FUNCTION "repository_material_embedding_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    attempt_status "IndexBuildAttemptStatus";
    index_status "IndexGenerationStatus";
    expected_profile UUID;
    input_hash TEXT;
    chunk_hash TEXT;
BEGIN
    IF TG_OP = 'INSERT' THEN
        SELECT attempt."status", index_row."status", index_row."embeddingProfileId",
               input_row."contentHash", chunk."contentHash"
        INTO attempt_status, index_status, expected_profile, input_hash, chunk_hash
        FROM "RepositoryMaterialIndexAttempt" AS attempt
        JOIN "RepositoryMaterialIndexGeneration" AS index_row
          ON index_row."projectId" = attempt."projectId"
         AND index_row."projectRepositoryLinkId" = attempt."projectRepositoryLinkId"
         AND index_row."id" = attempt."indexGenerationId"
        JOIN "RepositoryMaterialIndexInput" AS input_row
          ON input_row."projectId" = index_row."projectId"
         AND input_row."projectRepositoryLinkId" = index_row."projectRepositoryLinkId"
         AND input_row."indexGenerationId" = index_row."id"
         AND input_row."id" = NEW."inputEntryId"
        JOIN "RepositoryMaterialChunk" AS chunk
          ON chunk."projectId" = input_row."projectId"
         AND chunk."projectRepositoryLinkId" = input_row."projectRepositoryLinkId"
         AND chunk."id" = input_row."sourceChunkId"
        WHERE attempt."projectId" = NEW."projectId"
          AND attempt."projectRepositoryLinkId" = NEW."projectRepositoryLinkId"
          AND attempt."indexGenerationId" = NEW."indexGenerationId"
          AND attempt."id" = NEW."attemptId"
        FOR KEY SHARE OF attempt, index_row, input_row, chunk;
        IF attempt_status IS DISTINCT FROM 'running'
            OR index_status IS DISTINCT FROM 'building'
            OR expected_profile IS DISTINCT FROM NEW."embeddingProfileId"
            OR input_hash IS DISTINCT FROM chunk_hash THEN
            RAISE EXCEPTION 'repository material embedding is not admissible'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;
    IF EXISTS (SELECT 1 FROM "Project" WHERE "id" = OLD."projectId") THEN
        RAISE EXCEPTION 'repository material embedding is immutable'
            USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "RepositoryMaterialEmbedding_lifecycle_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "RepositoryMaterialEmbedding"
FOR EACH ROW EXECUTE FUNCTION "repository_material_embedding_guard"();

CREATE OR REPLACE FUNCTION "repository_material_index_pointer_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    expected_index_id UUID;
    current_index_id UUID;
    expected_count INTEGER;
    indexed_count INTEGER;
    target_status "IndexGenerationStatus";
    embedding_count BIGINT;
    eligible BOOLEAN;
BEGIN
    IF TG_OP = 'UPDATE' AND (
        NEW."projectId" IS DISTINCT FROM OLD."projectId"
        OR NEW."projectRepositoryLinkId" IS DISTINCT FROM OLD."projectRepositoryLinkId"
    ) THEN
        RAISE EXCEPTION 'repository material index pointer identity is immutable'
            USING ERRCODE = 'check_violation';
    END IF;
    PERFORM 1
    FROM "ProjectRepositoryLink" AS link
    WHERE link."projectId" = NEW."projectId"
      AND link."id" = NEW."projectRepositoryLinkId"
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'repository material index link does not exist'
            USING ERRCODE = 'check_violation';
    END IF;
    SELECT index_row."expectedActiveIndexGenerationId",
           index_row."status", index_row."expectedInputCount", index_row."indexedInputCount"
    INTO expected_index_id, target_status, expected_count, indexed_count
    FROM "RepositoryMaterialIndexGeneration" AS index_row
    WHERE index_row."projectId" = NEW."projectId"
      AND index_row."projectRepositoryLinkId" = NEW."projectRepositoryLinkId"
      AND index_row."id" = NEW."indexGenerationId"
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'repository material index target does not exist'
            USING ERRCODE = 'check_violation';
    END IF;
    SELECT pointer."indexGenerationId" INTO current_index_id
    FROM "RepositoryMaterialIndexPointer" AS pointer
    WHERE pointer."projectId" = NEW."projectId"
      AND pointer."projectRepositoryLinkId" = NEW."projectRepositoryLinkId";
    IF expected_index_id IS DISTINCT FROM current_index_id THEN
        RAISE EXCEPTION 'repository material index publication lost compare-and-swap'
            USING ERRCODE = 'serialization_failure';
    END IF;
    SELECT COUNT(*) INTO embedding_count
    FROM "RepositoryMaterialEmbedding" AS embedding
    WHERE embedding."projectId" = NEW."projectId"
      AND embedding."projectRepositoryLinkId" = NEW."projectRepositoryLinkId"
      AND embedding."indexGenerationId" = NEW."indexGenerationId";
    SELECT EXISTS (
        SELECT 1
        FROM "RepositoryMaterialIndexGeneration" AS index_row
        JOIN "RepositoryMaterialModelGrant" AS grant_row
          ON grant_row."projectId" = index_row."projectId"
         AND grant_row."projectRepositoryLinkId" = index_row."projectRepositoryLinkId"
         AND grant_row."id" = index_row."grantId"
        JOIN "ProjectRepositoryLink" AS link
          ON link."projectId" = index_row."projectId"
         AND link."id" = index_row."projectRepositoryLinkId"
        JOIN "ProjectRepositoryLinkConfigPointer" AS config_pointer
          ON config_pointer."projectId" = link."projectId"
         AND config_pointer."projectRepositoryLinkId" = link."id"
        JOIN "RepositoryMaterialGenerationPointer" AS material_pointer
          ON material_pointer."projectId" = link."projectId"
         AND material_pointer."projectRepositoryLinkId" = link."id"
        JOIN "ProjectAiPolicy" AS policy
          ON policy."projectId" = index_row."projectId"
         AND policy."currentRevisionId" = index_row."policyRevisionId"
        WHERE index_row."projectId" = NEW."projectId"
          AND index_row."projectRepositoryLinkId" = NEW."projectRepositoryLinkId"
          AND index_row."id" = NEW."indexGenerationId"
          AND index_row."repositoryMaterialGenerationId" =
              NEW."repositoryMaterialGenerationId"
          AND index_row."linkConfigVersion" = NEW."linkConfigVersion"
          AND index_row."effectivePolicyVersion" = NEW."effectivePolicyVersion"
          AND grant_row."status" = 'issued'
          AND grant_row."revokedAt" IS NULL
          AND grant_row."expiresAt" > CURRENT_TIMESTAMP
          AND link."status" = 'active'
          AND link."effectivePolicyVersion" = NEW."effectivePolicyVersion"
          AND config_pointer."configVersion" = NEW."linkConfigVersion"
          AND config_pointer."effectivePolicyVersion" = NEW."effectivePolicyVersion"
          AND material_pointer."repositoryMaterialGenerationId" =
              NEW."repositoryMaterialGenerationId"
          AND material_pointer."linkConfigVersion" = NEW."linkConfigVersion"
          AND material_pointer."effectivePolicyVersion" = NEW."effectivePolicyVersion"
    ) INTO eligible;
    IF target_status IS DISTINCT FROM 'rag_ready'
        OR indexed_count <> expected_count
        OR embedding_count <> expected_count
        OR eligible IS NOT TRUE THEN
        RAISE EXCEPTION 'repository material index is not publishable'
            USING ERRCODE = 'check_violation';
    END IF;
    UPDATE "RepositoryMaterialIndexGeneration"
    SET "publishedAt" = COALESCE("publishedAt", NEW."publishedAt")
    WHERE "projectId" = NEW."projectId"
      AND "projectRepositoryLinkId" = NEW."projectRepositoryLinkId"
      AND "id" = NEW."indexGenerationId";
    IF TG_OP = 'UPDATE' AND OLD."indexGenerationId" <> NEW."indexGenerationId" THEN
        UPDATE "RepositoryMaterialIndexGeneration"
        SET "status" = 'superseded', "supersededAt" = NEW."publishedAt"
        WHERE "projectId" = OLD."projectId"
          AND "projectRepositoryLinkId" = OLD."projectRepositoryLinkId"
          AND "id" = OLD."indexGenerationId"
          AND "status" = 'rag_ready';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "RepositoryMaterialIndexPointer_publish_trigger"
BEFORE INSERT OR UPDATE ON "RepositoryMaterialIndexPointer"
FOR EACH ROW EXECUTE FUNCTION "repository_material_index_pointer_guard"();
