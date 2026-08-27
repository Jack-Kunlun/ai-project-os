CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE UNIQUE INDEX "ProjectRagSnapshot_exact_manifest_key"
ON "ProjectRagSnapshot"("projectId", "id", "manifestFingerprint");

CREATE TABLE "RepositoryRagSnapshot" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "projectRepositoryLinkId" UUID NOT NULL,
    "expectedActiveSnapshotId" UUID,
    "linkConfigVersion" INTEGER NOT NULL,
    "effectivePolicyVersion" INTEGER NOT NULL,
    "requiredForProjectSnapshot" BOOLEAN NOT NULL,
    "policyRevisionId" UUID NOT NULL,
    "embeddingProfileId" UUID NOT NULL,
    "codeIndexGenerationId" UUID,
    "repositoryCodeGenerationId" UUID,
    "materialIndexGenerationId" UUID,
    "repositoryMaterialGenerationId" UUID,
    "capturedGitHubRepositoryId" BIGINT NOT NULL,
    "capturedFullName" VARCHAR(512) NOT NULL,
    "frozenCommitSha" CHAR(40) NOT NULL,
    "status" "ProjectRagSnapshotStatus" NOT NULL DEFAULT 'staging',
    "manifestFingerprint" VARCHAR(64) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "supersededAt" TIMESTAMP(3),

    CONSTRAINT "RepositoryRagSnapshot_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RepositoryRagSnapshot_values_check" CHECK (
        "linkConfigVersion" > 0
        AND "effectivePolicyVersion" > 0
        AND "capturedGitHubRepositoryId" > 0
        AND length("capturedFullName") > 0
        AND "frozenCommitSha" ~ '^[0-9a-f]{40}$'
        AND "manifestFingerprint" ~ '^[0-9a-f]{64}$'
        AND (("codeIndexGenerationId" IS NULL) =
             ("repositoryCodeGenerationId" IS NULL))
        AND (("materialIndexGenerationId" IS NULL) =
             ("repositoryMaterialGenerationId" IS NULL))
        AND (
            "codeIndexGenerationId" IS NOT NULL
            OR "materialIndexGenerationId" IS NOT NULL
        )
    ),
    CONSTRAINT "RepositoryRagSnapshot_lifecycle_check" CHECK (
        (
            "status" = 'staging'
            AND "completedAt" IS NULL
            AND "supersededAt" IS NULL
        )
        OR (
            "status" = 'complete'
            AND "completedAt" IS NOT NULL
            AND "supersededAt" IS NULL
        )
        OR (
            "status" = 'superseded'
            AND "completedAt" IS NOT NULL
            AND "supersededAt" IS NOT NULL
        )
    )
);

CREATE INDEX "RepositoryRagSnapshot_status_idx"
ON "RepositoryRagSnapshot"(
    "projectId", "projectRepositoryLinkId", "status", "createdAt"
);
CREATE UNIQUE INDEX "RepositoryRagSnapshot_projectId_id_key"
ON "RepositoryRagSnapshot"("projectId", "id");
CREATE UNIQUE INDEX "RepositoryRagSnapshot_project_link_id_key"
ON "RepositoryRagSnapshot"("projectId", "projectRepositoryLinkId", "id");
CREATE UNIQUE INDEX "RepositoryRagSnapshot_exact_manifest_key"
ON "RepositoryRagSnapshot"(
    "projectId", "projectRepositoryLinkId", "id", "manifestFingerprint"
);
CREATE UNIQUE INDEX "RepositoryRagSnapshot_link_manifest_key"
ON "RepositoryRagSnapshot"(
    "projectId", "projectRepositoryLinkId", "manifestFingerprint"
);

CREATE TABLE "RepositoryRagSnapshotPointer" (
    "projectId" UUID NOT NULL,
    "projectRepositoryLinkId" UUID NOT NULL,
    "repositoryRagSnapshotId" UUID NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RepositoryRagSnapshotPointer_pkey"
        PRIMARY KEY ("projectId", "projectRepositoryLinkId")
);

CREATE UNIQUE INDEX "RepositoryRagSnapshotPointer_project_snapshot_key"
ON "RepositoryRagSnapshotPointer"("projectId", "repositoryRagSnapshotId");
CREATE UNIQUE INDEX "RepositoryRagSnapshotPointer_exact_target_key"
ON "RepositoryRagSnapshotPointer"(
    "projectId", "projectRepositoryLinkId", "repositoryRagSnapshotId"
);

CREATE TABLE "ProjectRepositoryRagSnapshot" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "expectedActiveSnapshotId" UUID,
    "manualRagSnapshotId" UUID,
    "manualManifestFingerprint" VARCHAR(64),
    "policyRevisionId" UUID NOT NULL,
    "effectivePolicyVersion" INTEGER NOT NULL,
    "status" "ProjectRagSnapshotStatus" NOT NULL DEFAULT 'staging',
    "manifestFingerprint" VARCHAR(64) NOT NULL,
    "requiredRepositoryCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "supersededAt" TIMESTAMP(3),

    CONSTRAINT "ProjectRepositoryRagSnapshot_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ProjectRepositoryRagSnapshot_values_check" CHECK (
        "effectivePolicyVersion" > 0
        AND "requiredRepositoryCount" > 0
        AND "manifestFingerprint" ~ '^[0-9a-f]{64}$'
        AND (("manualRagSnapshotId" IS NULL) =
             ("manualManifestFingerprint" IS NULL))
        AND (
            "manualManifestFingerprint" IS NULL
            OR "manualManifestFingerprint" ~ '^[0-9a-f]{64}$'
        )
    ),
    CONSTRAINT "ProjectRepositoryRagSnapshot_lifecycle_check" CHECK (
        (
            "status" = 'staging'
            AND "completedAt" IS NULL
            AND "supersededAt" IS NULL
        )
        OR (
            "status" = 'complete'
            AND "completedAt" IS NOT NULL
            AND "supersededAt" IS NULL
        )
        OR (
            "status" = 'superseded'
            AND "completedAt" IS NOT NULL
            AND "supersededAt" IS NOT NULL
        )
    )
);

CREATE INDEX "ProjectRepositoryRagSnapshot_status_idx"
ON "ProjectRepositoryRagSnapshot"("projectId", "status", "createdAt");
CREATE UNIQUE INDEX "ProjectRepositoryRagSnapshot_projectId_id_key"
ON "ProjectRepositoryRagSnapshot"("projectId", "id");
CREATE UNIQUE INDEX "ProjectRepositoryRagSnapshot_exact_manifest_key"
ON "ProjectRepositoryRagSnapshot"(
    "projectId", "id", "manifestFingerprint"
);
CREATE UNIQUE INDEX "ProjectRepositoryRagSnapshot_project_manifest_key"
ON "ProjectRepositoryRagSnapshot"("projectId", "manifestFingerprint");

CREATE TABLE "ProjectRepositoryRagSnapshotEntry" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "projectRepositoryRagSnapshotId" UUID NOT NULL,
    "projectRepositoryLinkId" UUID NOT NULL,
    "repositoryRagSnapshotId" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "repositoryManifestFingerprint" VARCHAR(64) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectRepositoryRagSnapshotEntry_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ProjectRepositoryRagSnapshotEntry_values_check" CHECK (
        "ordinal" >= 0
        AND "repositoryManifestFingerprint" ~ '^[0-9a-f]{64}$'
    )
);

CREATE INDEX "ProjectRepositoryRagSnapshotEntry_repository_idx"
ON "ProjectRepositoryRagSnapshotEntry"(
    "projectId", "projectRepositoryLinkId", "repositoryRagSnapshotId"
);
CREATE UNIQUE INDEX "ProjectRepositoryRagSnapshotEntry_projectId_id_key"
ON "ProjectRepositoryRagSnapshotEntry"("projectId", "id");
CREATE UNIQUE INDEX "ProjectRepositoryRagSnapshotEntry_project_id_key"
ON "ProjectRepositoryRagSnapshotEntry"(
    "projectId", "projectRepositoryRagSnapshotId", "id"
);
CREATE UNIQUE INDEX "ProjectRepositoryRagSnapshotEntry_ordinal_key"
ON "ProjectRepositoryRagSnapshotEntry"(
    "projectId", "projectRepositoryRagSnapshotId", "ordinal"
);
CREATE UNIQUE INDEX "ProjectRepositoryRagSnapshotEntry_link_key"
ON "ProjectRepositoryRagSnapshotEntry"(
    "projectId", "projectRepositoryRagSnapshotId", "projectRepositoryLinkId"
);
CREATE UNIQUE INDEX "ProjectRepositoryRagSnapshotEntry_snapshot_key"
ON "ProjectRepositoryRagSnapshotEntry"(
    "projectId", "projectRepositoryRagSnapshotId", "repositoryRagSnapshotId"
);

CREATE TABLE "ProjectRepositoryRagSnapshotPointer" (
    "projectId" UUID NOT NULL,
    "projectRepositoryRagSnapshotId" UUID NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectRepositoryRagSnapshotPointer_pkey"
        PRIMARY KEY ("projectId")
);

CREATE UNIQUE INDEX "ProjectRepositoryRagSnapshotPointer_project_snapshot_key"
ON "ProjectRepositoryRagSnapshotPointer"(
    "projectId", "projectRepositoryRagSnapshotId"
);

ALTER TABLE "RepositoryRagSnapshot"
ADD CONSTRAINT "RepositoryRagSnapshot_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "Project"("id")
ON DELETE CASCADE ON UPDATE CASCADE,
ADD CONSTRAINT "RepositoryRagSnapshot_link_fkey"
FOREIGN KEY ("projectId", "projectRepositoryLinkId")
REFERENCES "ProjectRepositoryLink"("projectId", "id")
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
ADD CONSTRAINT "RepositoryRagSnapshot_config_fkey"
FOREIGN KEY (
    "projectId", "projectRepositoryLinkId", "linkConfigVersion",
    "requiredForProjectSnapshot", "effectivePolicyVersion"
)
REFERENCES "ProjectRepositoryLinkConfigVersion"(
    "projectId", "projectRepositoryLinkId", "version",
    "requiredForProjectSnapshot", "effectivePolicyVersion"
)
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
ADD CONSTRAINT "RepositoryRagSnapshot_policy_fkey"
FOREIGN KEY ("projectId", "policyRevisionId")
REFERENCES "ProjectAiPolicyRevision"("projectId", "id")
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
ADD CONSTRAINT "RepositoryRagSnapshot_profile_fkey"
FOREIGN KEY ("embeddingProfileId") REFERENCES "EmbeddingProfile"("id")
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
ADD CONSTRAINT "RepositoryRagSnapshot_code_index_fkey"
FOREIGN KEY (
    "projectId", "projectRepositoryLinkId", "codeIndexGenerationId",
    "repositoryCodeGenerationId", "linkConfigVersion", "effectivePolicyVersion"
)
REFERENCES "RepositoryCodeIndexGeneration"(
    "projectId", "projectRepositoryLinkId", "indexGenerationId",
    "repositoryCodeGenerationId", "linkConfigVersion", "effectivePolicyVersion"
)
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
ADD CONSTRAINT "RepositoryRagSnapshot_material_index_fkey"
FOREIGN KEY (
    "projectId", "projectRepositoryLinkId",
    "repositoryMaterialGenerationId", "materialIndexGenerationId"
)
REFERENCES "RepositoryMaterialIndexGeneration"(
    "projectId", "projectRepositoryLinkId",
    "repositoryMaterialGenerationId", "id"
)
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
ADD CONSTRAINT "RepositoryRagSnapshot_expected_fkey"
FOREIGN KEY (
    "projectId", "projectRepositoryLinkId", "expectedActiveSnapshotId"
)
REFERENCES "RepositoryRagSnapshot"(
    "projectId", "projectRepositoryLinkId", "id"
)
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "RepositoryRagSnapshotPointer"
ADD CONSTRAINT "RepositoryRagSnapshotPointer_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "Project"("id")
ON DELETE CASCADE ON UPDATE CASCADE,
ADD CONSTRAINT "RepositoryRagSnapshotPointer_link_fkey"
FOREIGN KEY ("projectId", "projectRepositoryLinkId")
REFERENCES "ProjectRepositoryLink"("projectId", "id")
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
ADD CONSTRAINT "RepositoryRagSnapshotPointer_snapshot_fkey"
FOREIGN KEY (
    "projectId", "projectRepositoryLinkId", "repositoryRagSnapshotId"
)
REFERENCES "RepositoryRagSnapshot"(
    "projectId", "projectRepositoryLinkId", "id"
)
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "ProjectRepositoryRagSnapshot"
ADD CONSTRAINT "ProjectRepositoryRagSnapshot_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "Project"("id")
ON DELETE CASCADE ON UPDATE CASCADE,
ADD CONSTRAINT "ProjectRepositoryRagSnapshot_manual_fkey"
FOREIGN KEY (
    "projectId", "manualRagSnapshotId", "manualManifestFingerprint"
)
REFERENCES "ProjectRagSnapshot"(
    "projectId", "id", "manifestFingerprint"
)
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
ADD CONSTRAINT "ProjectRepositoryRagSnapshot_policy_fkey"
FOREIGN KEY ("projectId", "policyRevisionId")
REFERENCES "ProjectAiPolicyRevision"("projectId", "id")
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
ADD CONSTRAINT "ProjectRepositoryRagSnapshot_expected_fkey"
FOREIGN KEY ("projectId", "expectedActiveSnapshotId")
REFERENCES "ProjectRepositoryRagSnapshot"("projectId", "id")
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "ProjectRepositoryRagSnapshotEntry"
ADD CONSTRAINT "ProjectRepositoryRagSnapshotEntry_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "Project"("id")
ON DELETE CASCADE ON UPDATE CASCADE,
ADD CONSTRAINT "ProjectRepositoryRagSnapshotEntry_project_fkey"
FOREIGN KEY ("projectId", "projectRepositoryRagSnapshotId")
REFERENCES "ProjectRepositoryRagSnapshot"("projectId", "id")
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
ADD CONSTRAINT "ProjectRepositoryRagSnapshotEntry_link_fkey"
FOREIGN KEY ("projectId", "projectRepositoryLinkId")
REFERENCES "ProjectRepositoryLink"("projectId", "id")
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
ADD CONSTRAINT "ProjectRepositoryRagSnapshotEntry_repository_fkey"
FOREIGN KEY (
    "projectId", "projectRepositoryLinkId", "repositoryRagSnapshotId",
    "repositoryManifestFingerprint"
)
REFERENCES "RepositoryRagSnapshot"(
    "projectId", "projectRepositoryLinkId", "id", "manifestFingerprint"
)
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "ProjectRepositoryRagSnapshotPointer"
ADD CONSTRAINT "ProjectRepositoryRagSnapshotPointer_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "Project"("id")
ON DELETE CASCADE ON UPDATE CASCADE,
ADD CONSTRAINT "ProjectRepositoryRagSnapshotPointer_snapshot_fkey"
FOREIGN KEY ("projectId", "projectRepositoryRagSnapshotId")
REFERENCES "ProjectRepositoryRagSnapshot"("projectId", "id")
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

CREATE OR REPLACE FUNCTION "repository_rag_snapshot_boundary_is_current"(
    p_project_id UUID,
    p_link_id UUID,
    p_config_version INTEGER,
    p_effective_policy_version INTEGER,
    p_required BOOLEAN,
    p_policy_revision_id UUID,
    p_embedding_profile_id UUID,
    p_code_index_id UUID,
    p_code_generation_id UUID,
    p_material_index_id UUID,
    p_material_generation_id UUID,
    p_repository_id BIGINT,
    p_captured_full_name TEXT,
    p_commit_sha TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM "ProjectRepositoryLink" AS link
        JOIN "GitHubRepository" AS repository
          ON repository."id" = link."githubRepositoryId"
        JOIN "ProjectRepositoryLinkConfigPointer" AS config_pointer
          ON config_pointer."projectId" = link."projectId"
         AND config_pointer."projectRepositoryLinkId" = link."id"
        JOIN "ProjectRepositoryLinkConfigVersion" AS config
          ON config."projectId" = config_pointer."projectId"
         AND config."projectRepositoryLinkId" =
             config_pointer."projectRepositoryLinkId"
         AND config."version" = config_pointer."configVersion"
         AND config."effectivePolicyVersion" =
             config_pointer."effectivePolicyVersion"
        JOIN "ProjectAiPolicy" AS policy
          ON policy."projectId" = link."projectId"
         AND policy."currentRevisionId" = p_policy_revision_id
        JOIN "ProjectAiPolicyRevision" AS revision
          ON revision."projectId" = policy."projectId"
         AND revision."id" = policy."currentRevisionId"
        JOIN "EmbeddingProfile" AS profile
          ON profile."id" = p_embedding_profile_id
        LEFT JOIN "RepositoryCodeIndexPointer" AS code_pointer
          ON code_pointer."projectId" = link."projectId"
         AND code_pointer."projectRepositoryLinkId" = link."id"
        LEFT JOIN "IndexGeneration" AS code_index
          ON code_index."projectId" = code_pointer."projectId"
         AND code_index."id" = code_pointer."indexGenerationId"
        LEFT JOIN "RepositoryCodeGeneration" AS code_generation
          ON code_generation."projectId" = code_pointer."projectId"
         AND code_generation."projectRepositoryLinkId" =
             code_pointer."projectRepositoryLinkId"
         AND code_generation."id" =
             code_pointer."repositoryCodeGenerationId"
        LEFT JOIN "RepositoryMaterialIndexPointer" AS material_pointer
          ON material_pointer."projectId" = link."projectId"
         AND material_pointer."projectRepositoryLinkId" = link."id"
        LEFT JOIN "RepositoryMaterialIndexGeneration" AS material_index
          ON material_index."projectId" = material_pointer."projectId"
         AND material_index."projectRepositoryLinkId" =
             material_pointer."projectRepositoryLinkId"
         AND material_index."id" =
             material_pointer."indexGenerationId"
        LEFT JOIN "RepositoryMaterialGeneration" AS material_generation
          ON material_generation."projectId" = material_pointer."projectId"
         AND material_generation."projectRepositoryLinkId" =
             material_pointer."projectRepositoryLinkId"
         AND material_generation."id" =
             material_pointer."repositoryMaterialGenerationId"
        WHERE link."projectId" = p_project_id
          AND link."id" = p_link_id
          AND link."status" = 'active'
          AND link."effectivePolicyVersion" = p_effective_policy_version
          AND repository."githubRepositoryId" = p_repository_id
          AND config_pointer."configVersion" = p_config_version
          AND config_pointer."effectivePolicyVersion" =
              p_effective_policy_version
          AND config."requiredForProjectSnapshot" = p_required
          AND revision."embeddingEnabled" = TRUE
          AND profile."id" =
              '00000000-0000-4000-8000-000000001536'::uuid
          AND profile."profileFingerprint" =
              'b6ea9b216ae969788bdf629f9cb31be5fd4d4e221fc87d433303bc3c363ee8d6'
          AND (
              config."codeEnabled"
              OR config."metadataEnabled"
              OR config."readmeEnabled"
              OR config."markdownEnabled"
              OR config."issuesEnabled"
              OR config."pullRequestsEnabled"
              OR config."releasesEnabled"
          )
          AND (
              (
                  config."codeEnabled"
                  AND p_code_index_id = code_pointer."indexGenerationId"
                  AND p_code_generation_id =
                      code_pointer."repositoryCodeGenerationId"
                  AND code_pointer."linkConfigVersion" = p_config_version
                  AND code_pointer."effectivePolicyVersion" =
                      p_effective_policy_version
                  AND code_index."kind" = 'repository_code'
                  AND code_index."originScope" = 'repository_link'
                  AND code_index."status" = 'rag_ready'
                  AND code_index."policyRevisionId" = p_policy_revision_id
                  AND code_index."embeddingProfileId" =
                      p_embedding_profile_id
                  AND code_index."expectedInputCount" > 0
                  AND code_index."indexedInputCount" =
                      code_index."expectedInputCount"
                  AND code_generation."status" = 'code_ready'
                  AND code_generation."linkConfigVersion" =
                      p_config_version
                  AND code_generation."effectivePolicyVersion" =
                      p_effective_policy_version
                  AND code_generation."capturedGitHubRepositoryId" =
                      p_repository_id
                  AND code_generation."capturedFullName" =
                      p_captured_full_name
                  AND code_generation."frozenCommitSha" = p_commit_sha
              )
              OR (
                  NOT config."codeEnabled"
                  AND p_code_index_id IS NULL
                  AND p_code_generation_id IS NULL
              )
          )
          AND (
              (
                  (
                      config."metadataEnabled"
                      OR config."readmeEnabled"
                      OR config."markdownEnabled"
                      OR config."issuesEnabled"
                      OR config."pullRequestsEnabled"
                      OR config."releasesEnabled"
                  )
                  AND p_material_index_id =
                      material_pointer."indexGenerationId"
                  AND p_material_generation_id =
                      material_pointer."repositoryMaterialGenerationId"
                  AND material_pointer."linkConfigVersion" =
                      p_config_version
                  AND material_pointer."effectivePolicyVersion" =
                      p_effective_policy_version
                  AND material_index."status" = 'rag_ready'
                  AND material_index."policyRevisionId" =
                      p_policy_revision_id
                  AND material_index."embeddingProfileId" =
                      p_embedding_profile_id
                  AND material_index."expectedInputCount" > 0
                  AND material_index."indexedInputCount" =
                      material_index."expectedInputCount"
                  AND material_generation."status" = 'complete'
                  AND material_generation."linkConfigVersion" =
                      p_config_version
                  AND material_generation."effectivePolicyVersion" =
                      p_effective_policy_version
                  AND material_generation."capturedGitHubRepositoryId" =
                      p_repository_id
                  AND material_generation."capturedFullName" =
                      p_captured_full_name
                  AND material_generation."observedHeadCommitSha" =
                      p_commit_sha
              )
              OR (
                  NOT (
                      config."metadataEnabled"
                      OR config."readmeEnabled"
                      OR config."markdownEnabled"
                      OR config."issuesEnabled"
                      OR config."pullRequestsEnabled"
                      OR config."releasesEnabled"
                  )
                  AND p_material_index_id IS NULL
                  AND p_material_generation_id IS NULL
              )
          )
    );
$$;

CREATE OR REPLACE FUNCTION "repository_rag_snapshot_is_current"(
    p_project_id UUID,
    p_link_id UUID,
    p_snapshot_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM "RepositoryRagSnapshot" AS snapshot
        WHERE snapshot."projectId" = p_project_id
          AND snapshot."projectRepositoryLinkId" = p_link_id
          AND snapshot."id" = p_snapshot_id
          AND snapshot."status" = 'complete'
          AND snapshot."completedAt" IS NOT NULL
          AND snapshot."supersededAt" IS NULL
          AND "repository_rag_snapshot_boundary_is_current"(
              snapshot."projectId",
              snapshot."projectRepositoryLinkId",
              snapshot."linkConfigVersion",
              snapshot."effectivePolicyVersion",
              snapshot."requiredForProjectSnapshot",
              snapshot."policyRevisionId",
              snapshot."embeddingProfileId",
              snapshot."codeIndexGenerationId",
              snapshot."repositoryCodeGenerationId",
              snapshot."materialIndexGenerationId",
              snapshot."repositoryMaterialGenerationId",
              snapshot."capturedGitHubRepositoryId",
              snapshot."capturedFullName",
              snapshot."frozenCommitSha"
          )
    );
$$;

CREATE OR REPLACE FUNCTION "repository_rag_snapshot_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    current_snapshot_id UUID;
    expected_manifest TEXT;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."status" <> 'staging' THEN
            RAISE EXCEPTION 'repository RAG snapshot must start staging'
                USING ERRCODE = 'check_violation';
        END IF;
        SELECT pointer."repositoryRagSnapshotId"
        INTO current_snapshot_id
        FROM "RepositoryRagSnapshotPointer" AS pointer
        WHERE pointer."projectId" = NEW."projectId"
          AND pointer."projectRepositoryLinkId" =
              NEW."projectRepositoryLinkId";
        IF NEW."expectedActiveSnapshotId" IS DISTINCT FROM current_snapshot_id THEN
            RAISE EXCEPTION 'repository RAG snapshot expected pointer is stale'
                USING ERRCODE = 'serialization_failure';
        END IF;
        RETURN NEW;
    END IF;
    IF TG_OP = 'DELETE' THEN
        IF EXISTS (SELECT 1 FROM "Project" WHERE "id" = OLD."projectId") THEN
            RAISE EXCEPTION 'repository RAG snapshot is append-only'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN OLD;
    END IF;
    IF ROW(
        NEW."id", NEW."projectId", NEW."projectRepositoryLinkId",
        NEW."expectedActiveSnapshotId", NEW."linkConfigVersion",
        NEW."effectivePolicyVersion", NEW."requiredForProjectSnapshot",
        NEW."policyRevisionId", NEW."embeddingProfileId",
        NEW."codeIndexGenerationId", NEW."repositoryCodeGenerationId",
        NEW."materialIndexGenerationId",
        NEW."repositoryMaterialGenerationId",
        NEW."capturedGitHubRepositoryId", NEW."capturedFullName",
        NEW."frozenCommitSha", NEW."manifestFingerprint", NEW."createdAt"
    ) IS DISTINCT FROM ROW(
        OLD."id", OLD."projectId", OLD."projectRepositoryLinkId",
        OLD."expectedActiveSnapshotId", OLD."linkConfigVersion",
        OLD."effectivePolicyVersion", OLD."requiredForProjectSnapshot",
        OLD."policyRevisionId", OLD."embeddingProfileId",
        OLD."codeIndexGenerationId", OLD."repositoryCodeGenerationId",
        OLD."materialIndexGenerationId",
        OLD."repositoryMaterialGenerationId",
        OLD."capturedGitHubRepositoryId", OLD."capturedFullName",
        OLD."frozenCommitSha", OLD."manifestFingerprint", OLD."createdAt"
    ) THEN
        RAISE EXCEPTION 'repository RAG snapshot boundary is immutable'
            USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'staging' AND NEW."status" = 'complete' THEN
        SELECT pointer."repositoryRagSnapshotId"
        INTO current_snapshot_id
        FROM "RepositoryRagSnapshotPointer" AS pointer
        WHERE pointer."projectId" = NEW."projectId"
          AND pointer."projectRepositoryLinkId" =
              NEW."projectRepositoryLinkId";
        expected_manifest := encode(sha256(convert_to(concat_ws(E'\x1f',
            'repository-rag-snapshot:v1',
            NEW."projectId"::text,
            NEW."projectRepositoryLinkId"::text,
            NEW."linkConfigVersion"::text,
            NEW."effectivePolicyVersion"::text,
            NEW."requiredForProjectSnapshot"::text,
            NEW."policyRevisionId"::text,
            NEW."embeddingProfileId"::text,
            COALESCE(NEW."codeIndexGenerationId"::text, 'none'),
            COALESCE(NEW."repositoryCodeGenerationId"::text, 'none'),
            COALESCE(NEW."materialIndexGenerationId"::text, 'none'),
            COALESCE(NEW."repositoryMaterialGenerationId"::text, 'none'),
            NEW."capturedGitHubRepositoryId"::text,
            NEW."capturedFullName",
            NEW."frozenCommitSha"
        ), 'UTF8')), 'hex');
        IF NEW."expectedActiveSnapshotId" IS DISTINCT FROM current_snapshot_id
            OR NEW."completedAt" IS NULL
            OR NEW."supersededAt" IS NOT NULL
            OR NEW."manifestFingerprint" IS DISTINCT FROM expected_manifest
            OR NOT "repository_rag_snapshot_boundary_is_current"(
                NEW."projectId",
                NEW."projectRepositoryLinkId",
                NEW."linkConfigVersion",
                NEW."effectivePolicyVersion",
                NEW."requiredForProjectSnapshot",
                NEW."policyRevisionId",
                NEW."embeddingProfileId",
                NEW."codeIndexGenerationId",
                NEW."repositoryCodeGenerationId",
                NEW."materialIndexGenerationId",
                NEW."repositoryMaterialGenerationId",
                NEW."capturedGitHubRepositoryId",
                NEW."capturedFullName",
                NEW."frozenCommitSha"
            ) THEN
            RAISE EXCEPTION 'repository RAG snapshot is not completable'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;
    IF OLD."status" = 'complete' AND NEW."status" = 'superseded'
        AND NEW."completedAt" IS NOT DISTINCT FROM OLD."completedAt"
        AND NEW."supersededAt" IS NOT NULL THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'invalid repository RAG snapshot transition'
        USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER "RepositoryRagSnapshot_lifecycle_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "RepositoryRagSnapshot"
FOR EACH ROW EXECUTE FUNCTION "repository_rag_snapshot_guard"();

CREATE OR REPLACE FUNCTION "repository_rag_snapshot_pointer_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    current_snapshot_id UUID;
    expected_snapshot_id UUID;
BEGIN
    IF TG_OP = 'UPDATE' AND (
        NEW."projectId" IS DISTINCT FROM OLD."projectId"
        OR NEW."projectRepositoryLinkId" IS DISTINCT FROM
            OLD."projectRepositoryLinkId"
    ) THEN
        RAISE EXCEPTION 'repository RAG pointer identity is immutable'
            USING ERRCODE = 'check_violation';
    END IF;
    PERFORM 1
    FROM "ProjectRepositoryLink" AS link
    WHERE link."projectId" = NEW."projectId"
      AND link."id" = NEW."projectRepositoryLinkId"
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'repository RAG pointer link does not exist'
            USING ERRCODE = 'check_violation';
    END IF;
    SELECT pointer."repositoryRagSnapshotId"
    INTO current_snapshot_id
    FROM "RepositoryRagSnapshotPointer" AS pointer
    WHERE pointer."projectId" = NEW."projectId"
      AND pointer."projectRepositoryLinkId" =
          NEW."projectRepositoryLinkId";
    SELECT snapshot."expectedActiveSnapshotId"
    INTO expected_snapshot_id
    FROM "RepositoryRagSnapshot" AS snapshot
    WHERE snapshot."projectId" = NEW."projectId"
      AND snapshot."projectRepositoryLinkId" =
          NEW."projectRepositoryLinkId"
      AND snapshot."id" = NEW."repositoryRagSnapshotId"
    FOR UPDATE;
    IF NOT FOUND
        OR expected_snapshot_id IS DISTINCT FROM current_snapshot_id
        OR NOT "repository_rag_snapshot_is_current"(
            NEW."projectId",
            NEW."projectRepositoryLinkId",
            NEW."repositoryRagSnapshotId"
        ) THEN
        RAISE EXCEPTION 'repository RAG pointer target is not publishable'
            USING ERRCODE = 'serialization_failure';
    END IF;
    IF TG_OP = 'UPDATE'
        AND OLD."repositoryRagSnapshotId" <>
            NEW."repositoryRagSnapshotId" THEN
        UPDATE "RepositoryRagSnapshot"
        SET "status" = 'superseded',
            "supersededAt" = NEW."publishedAt"
        WHERE "projectId" = OLD."projectId"
          AND "projectRepositoryLinkId" =
              OLD."projectRepositoryLinkId"
          AND "id" = OLD."repositoryRagSnapshotId"
          AND "status" = 'complete';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "RepositoryRagSnapshotPointer_publish_trigger"
BEFORE INSERT OR UPDATE ON "RepositoryRagSnapshotPointer"
FOR EACH ROW EXECUTE FUNCTION "repository_rag_snapshot_pointer_guard"();

CREATE OR REPLACE FUNCTION "project_repository_rag_snapshot_is_current"(
    p_project_id UUID,
    p_snapshot_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM "ProjectRepositoryRagSnapshot" AS snapshot
        JOIN "ProjectAiPolicy" AS policy
          ON policy."projectId" = snapshot."projectId"
         AND policy."currentRevisionId" = snapshot."policyRevisionId"
        JOIN "ProjectAiPolicyRevision" AS revision
          ON revision."projectId" = policy."projectId"
         AND revision."id" = policy."currentRevisionId"
         AND revision."revision" = snapshot."effectivePolicyVersion"
        WHERE snapshot."projectId" = p_project_id
          AND snapshot."id" = p_snapshot_id
          AND snapshot."status" = 'complete'
          AND snapshot."completedAt" IS NOT NULL
          AND snapshot."supersededAt" IS NULL
          AND snapshot."requiredRepositoryCount" = (
              SELECT COUNT(*)
              FROM "ProjectRepositoryLink" AS link
              JOIN "ProjectRepositoryLinkConfigPointer" AS config_pointer
                ON config_pointer."projectId" = link."projectId"
               AND config_pointer."projectRepositoryLinkId" = link."id"
              JOIN "ProjectRepositoryLinkConfigVersion" AS config
                ON config."projectId" = config_pointer."projectId"
               AND config."projectRepositoryLinkId" =
                   config_pointer."projectRepositoryLinkId"
               AND config."version" = config_pointer."configVersion"
               AND config."effectivePolicyVersion" =
                   config_pointer."effectivePolicyVersion"
              WHERE link."projectId" = snapshot."projectId"
                AND link."status" = 'active'
                AND link."effectivePolicyVersion" =
                    config_pointer."effectivePolicyVersion"
                AND config."requiredForProjectSnapshot" = TRUE
          )
          AND snapshot."requiredRepositoryCount" = (
              SELECT COUNT(*)
              FROM "ProjectRepositoryRagSnapshotEntry" AS entry
              WHERE entry."projectId" = snapshot."projectId"
                AND entry."projectRepositoryRagSnapshotId" = snapshot."id"
          )
          AND NOT EXISTS (
              SELECT 1
              FROM "ProjectRepositoryRagSnapshotEntry" AS entry
              JOIN "RepositoryRagSnapshot" AS repository_snapshot
                ON repository_snapshot."projectId" = entry."projectId"
               AND repository_snapshot."projectRepositoryLinkId" =
                   entry."projectRepositoryLinkId"
               AND repository_snapshot."id" =
                   entry."repositoryRagSnapshotId"
              LEFT JOIN "RepositoryRagSnapshotPointer" AS repository_pointer
                ON repository_pointer."projectId" = entry."projectId"
               AND repository_pointer."projectRepositoryLinkId" =
                   entry."projectRepositoryLinkId"
              WHERE entry."projectId" = snapshot."projectId"
                AND entry."projectRepositoryRagSnapshotId" = snapshot."id"
                AND (
                    entry."repositoryManifestFingerprint" <>
                        repository_snapshot."manifestFingerprint"
                    OR repository_snapshot."requiredForProjectSnapshot" IS NOT TRUE
                    OR repository_snapshot."policyRevisionId" <>
                        snapshot."policyRevisionId"
                    OR repository_pointer."repositoryRagSnapshotId"
                        IS DISTINCT FROM repository_snapshot."id"
                    OR NOT "repository_rag_snapshot_is_current"(
                        repository_snapshot."projectId",
                        repository_snapshot."projectRepositoryLinkId",
                        repository_snapshot."id"
                    )
                )
          )
          AND (
              (
                  snapshot."manualRagSnapshotId" IS NULL
                  AND snapshot."manualManifestFingerprint" IS NULL
              )
              OR EXISTS (
                  SELECT 1
                  FROM "ProjectRagSnapshot" AS manual_snapshot
                  JOIN "ProjectRagSnapshotPointer" AS manual_pointer
                    ON manual_pointer."projectId" =
                        manual_snapshot."projectId"
                   AND manual_pointer."ragSnapshotId" =
                        manual_snapshot."id"
                  WHERE manual_snapshot."projectId" =
                      snapshot."projectId"
                    AND manual_snapshot."id" =
                        snapshot."manualRagSnapshotId"
                    AND manual_snapshot."manifestFingerprint" =
                        snapshot."manualManifestFingerprint"
                    AND manual_snapshot."status" = 'complete'
                    AND manual_snapshot."supersededAt" IS NULL
                    AND manual_snapshot."policyRevisionId" =
                        snapshot."policyRevisionId"
                    AND manual_snapshot."effectivePolicyVersion" =
                        snapshot."effectivePolicyVersion"
              )
          )
    );
$$;

CREATE OR REPLACE FUNCTION "project_repository_rag_entry_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    parent_status "ProjectRagSnapshotStatus";
    parent_policy_revision_id UUID;
    repository_required BOOLEAN;
    repository_manifest TEXT;
    pointer_snapshot_id UUID;
BEGIN
    IF TG_OP = 'INSERT' THEN
        SELECT snapshot."status", snapshot."policyRevisionId"
        INTO parent_status, parent_policy_revision_id
        FROM "ProjectRepositoryRagSnapshot" AS snapshot
        WHERE snapshot."projectId" = NEW."projectId"
          AND snapshot."id" = NEW."projectRepositoryRagSnapshotId"
        FOR KEY SHARE;
        SELECT snapshot."requiredForProjectSnapshot",
               snapshot."manifestFingerprint"
        INTO repository_required, repository_manifest
        FROM "RepositoryRagSnapshot" AS snapshot
        WHERE snapshot."projectId" = NEW."projectId"
          AND snapshot."projectRepositoryLinkId" =
              NEW."projectRepositoryLinkId"
          AND snapshot."id" = NEW."repositoryRagSnapshotId"
          AND snapshot."policyRevisionId" =
              parent_policy_revision_id
        FOR KEY SHARE;
        SELECT pointer."repositoryRagSnapshotId"
        INTO pointer_snapshot_id
        FROM "RepositoryRagSnapshotPointer" AS pointer
        WHERE pointer."projectId" = NEW."projectId"
          AND pointer."projectRepositoryLinkId" =
              NEW."projectRepositoryLinkId";
        IF parent_status IS DISTINCT FROM 'staging'
            OR repository_required IS NOT TRUE
            OR repository_manifest IS DISTINCT FROM
                NEW."repositoryManifestFingerprint"
            OR pointer_snapshot_id IS DISTINCT FROM
                NEW."repositoryRagSnapshotId"
            OR NOT "repository_rag_snapshot_is_current"(
                NEW."projectId",
                NEW."projectRepositoryLinkId",
                NEW."repositoryRagSnapshotId"
            ) THEN
            RAISE EXCEPTION 'project repository RAG entry is not admissible'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;
    IF EXISTS (SELECT 1 FROM "Project" WHERE "id" = OLD."projectId") THEN
        RAISE EXCEPTION 'project repository RAG entry is immutable'
            USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "ProjectRepositoryRagSnapshotEntry_lifecycle_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "ProjectRepositoryRagSnapshotEntry"
FOR EACH ROW EXECUTE FUNCTION "project_repository_rag_entry_guard"();

CREATE OR REPLACE FUNCTION "project_repository_rag_snapshot_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    current_snapshot_id UUID;
    entry_count BIGINT;
    required_count BIGINT;
    invalid_entries BIGINT;
    policy_eligible BOOLEAN;
    manual_eligible BOOLEAN;
    repository_rows TEXT;
    expected_manifest TEXT;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."status" <> 'staging' THEN
            RAISE EXCEPTION 'project repository RAG snapshot must start staging'
                USING ERRCODE = 'check_violation';
        END IF;
        SELECT pointer."projectRepositoryRagSnapshotId"
        INTO current_snapshot_id
        FROM "ProjectRepositoryRagSnapshotPointer" AS pointer
        WHERE pointer."projectId" = NEW."projectId";
        IF NEW."expectedActiveSnapshotId" IS DISTINCT FROM current_snapshot_id THEN
            RAISE EXCEPTION 'project repository RAG expected pointer is stale'
                USING ERRCODE = 'serialization_failure';
        END IF;
        RETURN NEW;
    END IF;
    IF TG_OP = 'DELETE' THEN
        IF EXISTS (SELECT 1 FROM "Project" WHERE "id" = OLD."projectId") THEN
            RAISE EXCEPTION 'project repository RAG snapshot is append-only'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN OLD;
    END IF;
    IF ROW(
        NEW."id", NEW."projectId", NEW."expectedActiveSnapshotId",
        NEW."manualRagSnapshotId", NEW."manualManifestFingerprint",
        NEW."policyRevisionId", NEW."effectivePolicyVersion",
        NEW."manifestFingerprint", NEW."requiredRepositoryCount",
        NEW."createdAt"
    ) IS DISTINCT FROM ROW(
        OLD."id", OLD."projectId", OLD."expectedActiveSnapshotId",
        OLD."manualRagSnapshotId", OLD."manualManifestFingerprint",
        OLD."policyRevisionId", OLD."effectivePolicyVersion",
        OLD."manifestFingerprint", OLD."requiredRepositoryCount",
        OLD."createdAt"
    ) THEN
        RAISE EXCEPTION 'project repository RAG boundary is immutable'
            USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'staging' AND NEW."status" = 'complete' THEN
        SELECT pointer."projectRepositoryRagSnapshotId"
        INTO current_snapshot_id
        FROM "ProjectRepositoryRagSnapshotPointer" AS pointer
        WHERE pointer."projectId" = NEW."projectId";
        SELECT COUNT(*), string_agg(concat_ws(E'\x1f',
            entry."ordinal"::text,
            entry."projectRepositoryLinkId"::text,
            entry."repositoryRagSnapshotId"::text,
            entry."repositoryManifestFingerprint"
        ), E'\x1e' ORDER BY entry."ordinal")
        INTO entry_count, repository_rows
        FROM "ProjectRepositoryRagSnapshotEntry" AS entry
        WHERE entry."projectId" = NEW."projectId"
          AND entry."projectRepositoryRagSnapshotId" = NEW."id";
        SELECT COUNT(*)
        INTO required_count
        FROM "ProjectRepositoryLink" AS link
        JOIN "ProjectRepositoryLinkConfigPointer" AS config_pointer
          ON config_pointer."projectId" = link."projectId"
         AND config_pointer."projectRepositoryLinkId" = link."id"
        JOIN "ProjectRepositoryLinkConfigVersion" AS config
          ON config."projectId" = config_pointer."projectId"
         AND config."projectRepositoryLinkId" =
             config_pointer."projectRepositoryLinkId"
         AND config."version" = config_pointer."configVersion"
         AND config."effectivePolicyVersion" =
             config_pointer."effectivePolicyVersion"
        WHERE link."projectId" = NEW."projectId"
          AND link."status" = 'active'
          AND link."effectivePolicyVersion" =
              config_pointer."effectivePolicyVersion"
          AND config."requiredForProjectSnapshot" = TRUE;
        SELECT COUNT(*)
        INTO invalid_entries
        FROM "ProjectRepositoryRagSnapshotEntry" AS entry
        JOIN "RepositoryRagSnapshot" AS repository_snapshot
          ON repository_snapshot."projectId" = entry."projectId"
         AND repository_snapshot."projectRepositoryLinkId" =
             entry."projectRepositoryLinkId"
         AND repository_snapshot."id" =
             entry."repositoryRagSnapshotId"
        LEFT JOIN "RepositoryRagSnapshotPointer" AS repository_pointer
          ON repository_pointer."projectId" = entry."projectId"
         AND repository_pointer."projectRepositoryLinkId" =
             entry."projectRepositoryLinkId"
        WHERE entry."projectId" = NEW."projectId"
          AND entry."projectRepositoryRagSnapshotId" = NEW."id"
          AND (
              repository_snapshot."requiredForProjectSnapshot" IS NOT TRUE
              OR repository_snapshot."policyRevisionId" <>
                  NEW."policyRevisionId"
              OR repository_snapshot."manifestFingerprint" <>
                  entry."repositoryManifestFingerprint"
              OR repository_pointer."repositoryRagSnapshotId"
                  IS DISTINCT FROM repository_snapshot."id"
              OR NOT "repository_rag_snapshot_is_current"(
                  repository_snapshot."projectId",
                  repository_snapshot."projectRepositoryLinkId",
                  repository_snapshot."id"
              )
          );
        SELECT EXISTS (
            SELECT 1
            FROM "ProjectAiPolicy" AS policy
            JOIN "ProjectAiPolicyRevision" AS revision
              ON revision."projectId" = policy."projectId"
             AND revision."id" = policy."currentRevisionId"
            WHERE policy."projectId" = NEW."projectId"
              AND policy."currentRevisionId" =
                  NEW."policyRevisionId"
              AND revision."revision" =
                  NEW."effectivePolicyVersion"
              AND revision."embeddingEnabled" = TRUE
        ) INTO policy_eligible;
        manual_eligible := (
            NEW."manualRagSnapshotId" IS NULL
            AND NEW."manualManifestFingerprint" IS NULL
        ) OR EXISTS (
            SELECT 1
            FROM "ProjectRagSnapshot" AS manual_snapshot
            JOIN "ProjectRagSnapshotPointer" AS manual_pointer
              ON manual_pointer."projectId" =
                  manual_snapshot."projectId"
             AND manual_pointer."ragSnapshotId" =
                  manual_snapshot."id"
            WHERE manual_snapshot."projectId" = NEW."projectId"
              AND manual_snapshot."id" =
                  NEW."manualRagSnapshotId"
              AND manual_snapshot."manifestFingerprint" =
                  NEW."manualManifestFingerprint"
              AND manual_snapshot."status" = 'complete'
              AND manual_snapshot."supersededAt" IS NULL
              AND manual_snapshot."policyRevisionId" =
                  NEW."policyRevisionId"
              AND manual_snapshot."effectivePolicyVersion" =
                  NEW."effectivePolicyVersion"
        );
        expected_manifest := encode(sha256(convert_to(concat_ws(E'\x1f',
            'project-repository-rag-snapshot:v1',
            NEW."projectId"::text,
            NEW."policyRevisionId"::text,
            NEW."effectivePolicyVersion"::text,
            COALESCE(NEW."manualRagSnapshotId"::text, 'none'),
            COALESCE(NEW."manualManifestFingerprint", 'none'),
            'required-repositories:' ||
                NEW."requiredRepositoryCount"::text,
            repository_rows
        ), 'UTF8')), 'hex');
        IF NEW."expectedActiveSnapshotId" IS DISTINCT FROM current_snapshot_id
            OR NEW."completedAt" IS NULL
            OR NEW."supersededAt" IS NOT NULL
            OR entry_count <> NEW."requiredRepositoryCount"
            OR required_count <> NEW."requiredRepositoryCount"
            OR invalid_entries <> 0
            OR policy_eligible IS NOT TRUE
            OR manual_eligible IS NOT TRUE
            OR NEW."manifestFingerprint" IS DISTINCT FROM
                expected_manifest THEN
            RAISE EXCEPTION 'project repository RAG snapshot is incomplete'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;
    IF OLD."status" = 'complete' AND NEW."status" = 'superseded'
        AND NEW."completedAt" IS NOT DISTINCT FROM OLD."completedAt"
        AND NEW."supersededAt" IS NOT NULL THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'invalid project repository RAG transition'
        USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER "ProjectRepositoryRagSnapshot_lifecycle_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "ProjectRepositoryRagSnapshot"
FOR EACH ROW EXECUTE FUNCTION "project_repository_rag_snapshot_guard"();

CREATE OR REPLACE FUNCTION "project_repository_rag_pointer_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    current_snapshot_id UUID;
    expected_snapshot_id UUID;
BEGIN
    PERFORM 1
    FROM "Project"
    WHERE "id" = NEW."projectId"
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'project repository RAG project does not exist'
            USING ERRCODE = 'check_violation';
    END IF;
    SELECT pointer."projectRepositoryRagSnapshotId"
    INTO current_snapshot_id
    FROM "ProjectRepositoryRagSnapshotPointer" AS pointer
    WHERE pointer."projectId" = NEW."projectId";
    SELECT snapshot."expectedActiveSnapshotId"
    INTO expected_snapshot_id
    FROM "ProjectRepositoryRagSnapshot" AS snapshot
    WHERE snapshot."projectId" = NEW."projectId"
      AND snapshot."id" = NEW."projectRepositoryRagSnapshotId"
    FOR UPDATE;
    IF NOT FOUND
        OR expected_snapshot_id IS DISTINCT FROM current_snapshot_id
        OR NOT "project_repository_rag_snapshot_is_current"(
            NEW."projectId",
            NEW."projectRepositoryRagSnapshotId"
        ) THEN
        RAISE EXCEPTION 'project repository RAG target is not publishable'
            USING ERRCODE = 'serialization_failure';
    END IF;
    IF TG_OP = 'UPDATE'
        AND OLD."projectRepositoryRagSnapshotId" <>
            NEW."projectRepositoryRagSnapshotId" THEN
        UPDATE "ProjectRepositoryRagSnapshot"
        SET "status" = 'superseded',
            "supersededAt" = NEW."publishedAt"
        WHERE "projectId" = OLD."projectId"
          AND "id" = OLD."projectRepositoryRagSnapshotId"
          AND "status" = 'complete';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "ProjectRepositoryRagSnapshotPointer_publish_trigger"
BEFORE INSERT OR UPDATE ON "ProjectRepositoryRagSnapshotPointer"
FOR EACH ROW EXECUTE FUNCTION "project_repository_rag_pointer_guard"();
