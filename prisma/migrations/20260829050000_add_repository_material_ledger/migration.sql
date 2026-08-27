CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE "GitHubMaterialKind" AS ENUM (
    'repository_metadata', 'readme', 'markdown', 'issue', 'pull_request', 'release'
);
CREATE TYPE "GitHubMaterialSyncRunStatus" AS ENUM (
    'queued', 'running', 'succeeded', 'partial', 'failed',
    'rate_limited', 'unknown', 'cancelled'
);
CREATE TYPE "GitHubMaterialSyncStage" AS ENUM (
    'queued', 'freezing', 'fetching', 'scanning', 'publishing', 'terminal'
);
CREATE TYPE "RepositoryMaterialGenerationStatus" AS ENUM (
    'staging', 'complete', 'failed', 'ineligible', 'superseded'
);
CREATE TYPE "GitHubMaterialQuarantineReason" AS ENUM (
    'secret_detected', 'unsafe_content'
);

CREATE TABLE "GitHubMaterialSyncRun" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "projectRepositoryLinkId" UUID NOT NULL,
    "linkConfigVersion" INTEGER NOT NULL,
    "expectedEffectivePolicyVersion" INTEGER NOT NULL,
    "expectedActiveMaterialGenerationId" UUID,
    "operationKey" VARCHAR(64) NOT NULL,
    "status" "GitHubMaterialSyncRunStatus" NOT NULL DEFAULT 'queued',
    "stage" "GitHubMaterialSyncStage" NOT NULL DEFAULT 'queued',
    "observedHeadCommitSha" CHAR(40),
    "requestCount" INTEGER NOT NULL DEFAULT 0,
    "fetchedObjectCount" INTEGER NOT NULL DEFAULT 0,
    "publishedSourceCount" INTEGER NOT NULL DEFAULT 0,
    "quarantineCount" INTEGER NOT NULL DEFAULT 0,
    "failureCode" VARCHAR(64),
    "retryAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "GitHubMaterialSyncRun_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "GitHubMaterialSyncRun_values_check" CHECK (
        "linkConfigVersion" > 0
        AND "expectedEffectivePolicyVersion" > 0
        AND "operationKey" ~ '^[0-9a-f]{64}$'
        AND ("observedHeadCommitSha" IS NULL
            OR "observedHeadCommitSha" ~ '^[0-9a-f]{40}$')
        AND "requestCount" >= 0
        AND "fetchedObjectCount" >= 0
        AND "publishedSourceCount" >= 0
        AND "quarantineCount" >= 0
        AND ("failureCode" IS NULL
            OR "failureCode" ~ '^[A-Z][A-Z0-9_]{0,63}$')
    ),
    CONSTRAINT "GitHubMaterialSyncRun_lifecycle_check" CHECK (
        ("status" = 'queued' AND "stage" = 'queued'
            AND "startedAt" IS NULL AND "completedAt" IS NULL
            AND "failureCode" IS NULL AND "retryAt" IS NULL)
        OR ("status" = 'running'
            AND "stage" IN ('freezing', 'fetching', 'scanning', 'publishing')
            AND "startedAt" IS NOT NULL AND "completedAt" IS NULL
            AND "failureCode" IS NULL AND "retryAt" IS NULL)
        OR ("status" = 'succeeded' AND "stage" = 'terminal'
            AND "observedHeadCommitSha" IS NOT NULL
            AND "startedAt" IS NOT NULL AND "completedAt" IS NOT NULL
            AND "failureCode" IS NULL AND "retryAt" IS NULL)
        OR ("status" IN ('partial', 'failed', 'unknown') AND "stage" = 'terminal'
            AND "startedAt" IS NOT NULL AND "completedAt" IS NOT NULL
            AND "failureCode" IS NOT NULL AND "retryAt" IS NULL)
        OR ("status" = 'rate_limited' AND "stage" = 'terminal'
            AND "startedAt" IS NOT NULL AND "completedAt" IS NOT NULL
            AND "failureCode" = 'GITHUB_RATE_LIMITED' AND "retryAt" IS NOT NULL)
        OR ("status" = 'cancelled' AND "stage" = 'terminal'
            AND "completedAt" IS NOT NULL
            AND "failureCode" IS NULL AND "retryAt" IS NULL)
    )
);

CREATE TABLE "GitHubSourceVersion" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "projectRepositoryLinkId" UUID NOT NULL,
    "projectSourceId" UUID NOT NULL,
    "originScope" "ContentOriginScope" NOT NULL DEFAULT 'repository_link',
    "sourceRevisionKey" UUID NOT NULL,
    "materialKind" "GitHubMaterialKind" NOT NULL,
    "remoteIdentity" VARCHAR(512) NOT NULL,
    "remoteRevisionFingerprint" VARCHAR(64) NOT NULL,
    "remoteNumber" INTEGER,
    "normalizedPath" VARCHAR(1024),
    "capturedGitHubRepositoryId" BIGINT NOT NULL,
    "capturedFullName" VARCHAR(512) NOT NULL,
    "observedHeadCommitSha" CHAR(40) NOT NULL,
    "sourceContentHash" VARCHAR(64) NOT NULL,
    "sourceContentBytes" INTEGER NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GitHubSourceVersion_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "GitHubSourceVersion_values_check" CHECK (
        "originScope" = 'repository_link'
        AND "remoteIdentity" <> ''
        AND "remoteRevisionFingerprint" ~ '^[0-9a-f]{64}$'
        AND "capturedGitHubRepositoryId" > 0
        AND "capturedFullName" <> ''
        AND "observedHeadCommitSha" ~ '^[0-9a-f]{40}$'
        AND "sourceContentHash" ~ '^[0-9a-f]{64}$'
        AND "sourceContentBytes" > 0
        AND (
            ("materialKind" = 'repository_metadata'
                AND "remoteNumber" IS NULL AND "normalizedPath" IS NULL)
            OR ("materialKind" IN ('readme', 'markdown')
                AND "remoteNumber" IS NULL AND "normalizedPath" IS NOT NULL)
            OR ("materialKind" IN ('issue', 'pull_request', 'release')
                AND "remoteNumber" > 0 AND "normalizedPath" IS NULL)
        )
    )
);

CREATE TABLE "RepositoryMaterialGeneration" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "projectRepositoryLinkId" UUID NOT NULL,
    "linkConfigVersion" INTEGER NOT NULL,
    "githubMaterialSyncRunId" UUID NOT NULL,
    "status" "RepositoryMaterialGenerationStatus" NOT NULL DEFAULT 'staging',
    "generationKey" VARCHAR(64) NOT NULL,
    "capturedGitHubRepositoryId" BIGINT NOT NULL,
    "capturedFullName" VARCHAR(512) NOT NULL,
    "observedHeadCommitSha" CHAR(40) NOT NULL,
    "effectivePolicyVersion" INTEGER NOT NULL,
    "manifestFingerprint" VARCHAR(64) NOT NULL,
    "enabledClassManifest" JSONB NOT NULL,
    "coverageManifest" JSONB NOT NULL,
    "scannerVersion" VARCHAR(128) NOT NULL,
    "scannerFingerprint" VARCHAR(64) NOT NULL,
    "sourceCount" INTEGER NOT NULL,
    "decodedTextBytes" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "supersededAt" TIMESTAMP(3),
    CONSTRAINT "RepositoryMaterialGeneration_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RepositoryMaterialGeneration_values_check" CHECK (
        "linkConfigVersion" > 0
        AND "generationKey" ~ '^[0-9a-f]{64}$'
        AND "capturedGitHubRepositoryId" > 0
        AND "capturedFullName" <> ''
        AND "observedHeadCommitSha" ~ '^[0-9a-f]{40}$'
        AND "effectivePolicyVersion" > 0
        AND "manifestFingerprint" ~ '^[0-9a-f]{64}$'
        AND jsonb_typeof("enabledClassManifest") = 'object'
        AND jsonb_typeof("coverageManifest") = 'object'
        AND "scannerVersion" <> ''
        AND "scannerFingerprint" ~ '^[0-9a-f]{64}$'
        AND "sourceCount" >= 0
        AND "decodedTextBytes" >= 0
        AND (("sourceCount" = 0 AND "decodedTextBytes" = 0)
            OR ("sourceCount" > 0 AND "decodedTextBytes" > 0))
    ),
    CONSTRAINT "RepositoryMaterialGeneration_lifecycle_check" CHECK (
        ("status" = 'staging' AND "completedAt" IS NULL AND "supersededAt" IS NULL)
        OR ("status" = 'complete' AND "completedAt" IS NOT NULL AND "supersededAt" IS NULL)
        OR ("status" IN ('failed', 'ineligible')
            AND "completedAt" IS NOT NULL AND "supersededAt" IS NULL)
        OR ("status" = 'superseded'
            AND "completedAt" IS NOT NULL AND "supersededAt" IS NOT NULL)
    )
);

CREATE TABLE "RepositoryMaterialGenerationEntry" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "projectRepositoryLinkId" UUID NOT NULL,
    "repositoryMaterialGenerationId" UUID NOT NULL,
    "githubSourceVersionId" UUID NOT NULL,
    "projectSourceId" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "materialKind" "GitHubMaterialKind" NOT NULL,
    "sourceContentHash" VARCHAR(64) NOT NULL,
    "sourceContentBytes" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RepositoryMaterialGenerationEntry_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RepositoryMaterialGenerationEntry_values_check" CHECK (
        "ordinal" >= 0
        AND "sourceContentHash" ~ '^[0-9a-f]{64}$'
        AND "sourceContentBytes" > 0
    )
);

CREATE TABLE "RepositoryMaterialGenerationPointer" (
    "projectId" UUID NOT NULL,
    "projectRepositoryLinkId" UUID NOT NULL,
    "repositoryMaterialGenerationId" UUID NOT NULL,
    "linkConfigVersion" INTEGER NOT NULL,
    "effectivePolicyVersion" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RepositoryMaterialGenerationPointer_pkey"
        PRIMARY KEY ("projectId", "projectRepositoryLinkId"),
    CONSTRAINT "RepositoryMaterialGenerationPointer_values_check" CHECK (
        "linkConfigVersion" > 0 AND "effectivePolicyVersion" > 0
    )
);

CREATE TABLE "GitHubMaterialQuarantine" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "projectRepositoryLinkId" UUID NOT NULL,
    "githubMaterialSyncRunId" UUID NOT NULL,
    "materialKind" "GitHubMaterialKind" NOT NULL,
    "remoteIdentityFingerprint" VARCHAR(64) NOT NULL,
    "reasonCode" "GitHubMaterialQuarantineReason" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GitHubMaterialQuarantine_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "GitHubMaterialQuarantine_values_check" CHECK (
        "remoteIdentityFingerprint" ~ '^[0-9a-f]{64}$'
    )
);

CREATE UNIQUE INDEX "GitHubMaterialSyncRun_projectId_id_key"
ON "GitHubMaterialSyncRun"("projectId", "id");
CREATE UNIQUE INDEX "GitHubMaterialSyncRun_projectId_projectRepositoryLinkId_id_key"
ON "GitHubMaterialSyncRun"("projectId", "projectRepositoryLinkId", "id");
CREATE UNIQUE INDEX "GitHubMaterialSyncRun_projectId_operationKey_key"
ON "GitHubMaterialSyncRun"("projectId", "operationKey");
CREATE INDEX "GitHubMaterialSyncRun_projectId_projectRepositoryLinkId_sta_idx"
ON "GitHubMaterialSyncRun"("projectId", "projectRepositoryLinkId", "status", "createdAt");
CREATE UNIQUE INDEX "GitHubMaterialSyncRun_one_pending_per_link"
ON "GitHubMaterialSyncRun"("projectId", "projectRepositoryLinkId")
WHERE "status" IN ('queued', 'running', 'unknown');

CREATE UNIQUE INDEX "GitHubSourceVersion_projectId_id_key"
ON "GitHubSourceVersion"("projectId", "id");
CREATE UNIQUE INDEX "GitHubSourceVersion_projectId_projectRepositoryLinkId_id_key"
ON "GitHubSourceVersion"("projectId", "projectRepositoryLinkId", "id");
CREATE UNIQUE INDEX "GitHubSourceVersion_projectId_projectRepositoryLinkId_proje_key"
ON "GitHubSourceVersion"("projectId", "projectRepositoryLinkId", "projectSourceId");
CREATE UNIQUE INDEX "GitHubSourceVersion_exact_source_key"
ON "GitHubSourceVersion"(
    "projectId", "projectSourceId", "originScope", "projectRepositoryLinkId",
    "sourceRevisionKey", "sourceContentHash"
);
CREATE UNIQUE INDEX "GitHubSourceVersion_link_id_source_key"
ON "GitHubSourceVersion"(
    "projectId", "projectRepositoryLinkId", "id", "projectSourceId"
);
CREATE UNIQUE INDEX "GitHubSourceVersion_remote_revision_key"
ON "GitHubSourceVersion"(
    "projectId", "projectRepositoryLinkId", "remoteIdentity", "remoteRevisionFingerprint"
);
CREATE INDEX "GitHubSourceVersion_projectId_projectRepositoryLinkId_mater_idx"
ON "GitHubSourceVersion"(
    "projectId", "projectRepositoryLinkId", "materialKind", "capturedAt"
);

CREATE UNIQUE INDEX "RepositoryMaterialGeneration_projectId_id_key"
ON "RepositoryMaterialGeneration"("projectId", "id");
CREATE UNIQUE INDEX "RepositoryMaterialGeneration_projectId_projectRepositoryLin_key"
ON "RepositoryMaterialGeneration"("projectId", "projectRepositoryLinkId", "id");
CREATE UNIQUE INDEX "RepositoryMaterialGeneration_run_key"
ON "RepositoryMaterialGeneration"(
    "projectId", "projectRepositoryLinkId", "githubMaterialSyncRunId"
);
CREATE UNIQUE INDEX "RepositoryMaterialGeneration_projectId_generationKey_key"
ON "RepositoryMaterialGeneration"("projectId", "generationKey");
CREATE INDEX "RepositoryMaterialGeneration_projectId_projectRepositoryLin_idx"
ON "RepositoryMaterialGeneration"(
    "projectId", "projectRepositoryLinkId", "status", "createdAt"
);

CREATE UNIQUE INDEX "RepositoryMaterialGenerationEntry_projectId_id_key"
ON "RepositoryMaterialGenerationEntry"("projectId", "id");
CREATE UNIQUE INDEX "RepositoryMaterialGenerationEntry_exact_member_key"
ON "RepositoryMaterialGenerationEntry"(
    "projectId", "projectRepositoryLinkId", "repositoryMaterialGenerationId",
    "id", "githubSourceVersionId"
);
CREATE UNIQUE INDEX "RepositoryMaterialGenerationEntry_generation_source_key"
ON "RepositoryMaterialGenerationEntry"(
    "projectId", "projectRepositoryLinkId", "repositoryMaterialGenerationId",
    "githubSourceVersionId"
);
CREATE UNIQUE INDEX "RepositoryMaterialGenerationEntry_generation_ordinal_key"
ON "RepositoryMaterialGenerationEntry"(
    "projectId", "projectRepositoryLinkId", "repositoryMaterialGenerationId", "ordinal"
);
CREATE INDEX "RepositoryMaterialGenerationEntry_projectId_projectReposito_idx"
ON "RepositoryMaterialGenerationEntry"(
    "projectId", "projectRepositoryLinkId", "projectSourceId"
);

CREATE UNIQUE INDEX "RepositoryMaterialPointer_generation_key"
ON "RepositoryMaterialGenerationPointer"(
    "projectId", "projectRepositoryLinkId", "repositoryMaterialGenerationId"
);
CREATE INDEX "RepositoryMaterialGenerationPointer_projectId_repositoryMat_idx"
ON "RepositoryMaterialGenerationPointer"("projectId", "repositoryMaterialGenerationId");

CREATE UNIQUE INDEX "GitHubMaterialQuarantine_projectId_id_key"
ON "GitHubMaterialQuarantine"("projectId", "id");
CREATE UNIQUE INDEX "GitHubMaterialQuarantine_run_identity_key"
ON "GitHubMaterialQuarantine"(
    "projectId", "projectRepositoryLinkId", "githubMaterialSyncRunId",
    "remoteIdentityFingerprint"
);
CREATE INDEX "GitHubMaterialQuarantine_projectId_projectRepositoryLinkId__idx"
ON "GitHubMaterialQuarantine"("projectId", "projectRepositoryLinkId", "createdAt");

CREATE UNIQUE INDEX "ProjectSource_repository_revision_key"
ON "ProjectSource"(
    "projectId", "id", "originScope", "projectRepositoryLinkId",
    "revisionKey", "contentHash"
);

ALTER TABLE "GitHubMaterialSyncRun"
ADD CONSTRAINT "GitHubMaterialSyncRun_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "Project"("id")
ON DELETE CASCADE ON UPDATE CASCADE,
ADD CONSTRAINT "GitHubMaterialSyncRun_link_fkey"
FOREIGN KEY ("projectId", "projectRepositoryLinkId")
REFERENCES "ProjectRepositoryLink"("projectId", "id")
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
ADD CONSTRAINT "GitHubMaterialSyncRun_config_fkey"
FOREIGN KEY (
    "projectId", "projectRepositoryLinkId", "linkConfigVersion",
    "expectedEffectivePolicyVersion"
)
REFERENCES "ProjectRepositoryLinkConfigVersion"(
    "projectId", "projectRepositoryLinkId", "version", "effectivePolicyVersion"
)
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "GitHubSourceVersion"
ADD CONSTRAINT "GitHubSourceVersion_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "Project"("id")
ON DELETE CASCADE ON UPDATE CASCADE,
ADD CONSTRAINT "GitHubSourceVersion_link_fkey"
FOREIGN KEY ("projectId", "projectRepositoryLinkId")
REFERENCES "ProjectRepositoryLink"("projectId", "id")
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
ADD CONSTRAINT "GitHubSourceVersion_source_fkey"
FOREIGN KEY (
    "projectId", "projectSourceId", "originScope", "projectRepositoryLinkId",
    "sourceRevisionKey", "sourceContentHash"
)
REFERENCES "ProjectSource"(
    "projectId", "id", "originScope", "projectRepositoryLinkId",
    "revisionKey", "contentHash"
)
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "RepositoryMaterialGeneration"
ADD CONSTRAINT "RepositoryMaterialGeneration_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "Project"("id")
ON DELETE CASCADE ON UPDATE CASCADE,
ADD CONSTRAINT "RepositoryMaterialGeneration_link_fkey"
FOREIGN KEY ("projectId", "projectRepositoryLinkId")
REFERENCES "ProjectRepositoryLink"("projectId", "id")
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
ADD CONSTRAINT "RepositoryMaterialGeneration_config_fkey"
FOREIGN KEY (
    "projectId", "projectRepositoryLinkId", "linkConfigVersion", "effectivePolicyVersion"
)
REFERENCES "ProjectRepositoryLinkConfigVersion"(
    "projectId", "projectRepositoryLinkId", "version", "effectivePolicyVersion"
)
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
ADD CONSTRAINT "RepositoryMaterialGeneration_run_fkey"
FOREIGN KEY ("projectId", "projectRepositoryLinkId", "githubMaterialSyncRunId")
REFERENCES "GitHubMaterialSyncRun"("projectId", "projectRepositoryLinkId", "id")
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "GitHubMaterialSyncRun"
ADD CONSTRAINT "GitHubMaterialSyncRun_expected_generation_fkey"
FOREIGN KEY (
    "projectId", "projectRepositoryLinkId", "expectedActiveMaterialGenerationId"
)
REFERENCES "RepositoryMaterialGeneration"("projectId", "projectRepositoryLinkId", "id")
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "RepositoryMaterialGenerationEntry"
ADD CONSTRAINT "RepositoryMaterialGenerationEntry_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "Project"("id")
ON DELETE CASCADE ON UPDATE CASCADE,
ADD CONSTRAINT "RepositoryMaterialGenerationEntry_link_fkey"
FOREIGN KEY ("projectId", "projectRepositoryLinkId")
REFERENCES "ProjectRepositoryLink"("projectId", "id")
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
ADD CONSTRAINT "RepositoryMaterialGenerationEntry_generation_fkey"
FOREIGN KEY (
    "projectId", "projectRepositoryLinkId", "repositoryMaterialGenerationId"
)
REFERENCES "RepositoryMaterialGeneration"("projectId", "projectRepositoryLinkId", "id")
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
ADD CONSTRAINT "RepositoryMaterialGenerationEntry_source_version_fkey"
FOREIGN KEY (
    "projectId", "projectRepositoryLinkId", "githubSourceVersionId", "projectSourceId"
)
REFERENCES "GitHubSourceVersion"(
    "projectId", "projectRepositoryLinkId", "id", "projectSourceId"
)
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "RepositoryMaterialGenerationPointer"
ADD CONSTRAINT "RepositoryMaterialGenerationPointer_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "Project"("id")
ON DELETE CASCADE ON UPDATE CASCADE,
ADD CONSTRAINT "RepositoryMaterialPointer_link_fkey"
FOREIGN KEY ("projectId", "projectRepositoryLinkId")
REFERENCES "ProjectRepositoryLink"("projectId", "id")
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
ADD CONSTRAINT "RepositoryMaterialPointer_generation_fkey"
FOREIGN KEY (
    "projectId", "projectRepositoryLinkId", "repositoryMaterialGenerationId"
)
REFERENCES "RepositoryMaterialGeneration"("projectId", "projectRepositoryLinkId", "id")
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
ADD CONSTRAINT "RepositoryMaterialPointer_config_fkey"
FOREIGN KEY (
    "projectId", "projectRepositoryLinkId", "linkConfigVersion", "effectivePolicyVersion"
)
REFERENCES "ProjectRepositoryLinkConfigVersion"(
    "projectId", "projectRepositoryLinkId", "version", "effectivePolicyVersion"
)
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "GitHubMaterialQuarantine"
ADD CONSTRAINT "GitHubMaterialQuarantine_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "Project"("id")
ON DELETE CASCADE ON UPDATE CASCADE,
ADD CONSTRAINT "GitHubMaterialQuarantine_link_fkey"
FOREIGN KEY ("projectId", "projectRepositoryLinkId")
REFERENCES "ProjectRepositoryLink"("projectId", "id")
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
ADD CONSTRAINT "GitHubMaterialQuarantine_run_fkey"
FOREIGN KEY ("projectId", "projectRepositoryLinkId", "githubMaterialSyncRunId")
REFERENCES "GitHubMaterialSyncRun"("projectId", "projectRepositoryLinkId", "id")
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

CREATE OR REPLACE FUNCTION "github_material_sync_run_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    generation_ready BOOLEAN;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."status" <> 'queued' OR NEW."stage" <> 'queued' THEN
            RAISE EXCEPTION 'material sync run must start queued'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;
    IF TG_OP = 'DELETE' THEN
        IF EXISTS (SELECT 1 FROM "Project" WHERE "id" = OLD."projectId") THEN
            RAISE EXCEPTION 'material sync run is immutable'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN OLD;
    END IF;
    IF ROW(
        NEW."id", NEW."projectId", NEW."projectRepositoryLinkId",
        NEW."linkConfigVersion", NEW."expectedEffectivePolicyVersion",
        NEW."expectedActiveMaterialGenerationId", NEW."operationKey", NEW."createdAt"
    ) IS DISTINCT FROM ROW(
        OLD."id", OLD."projectId", OLD."projectRepositoryLinkId",
        OLD."linkConfigVersion", OLD."expectedEffectivePolicyVersion",
        OLD."expectedActiveMaterialGenerationId", OLD."operationKey", OLD."createdAt"
    ) THEN
        RAISE EXCEPTION 'material sync run structure is immutable'
            USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'queued' AND NEW."status" NOT IN ('queued', 'running', 'cancelled') THEN
        RAISE EXCEPTION 'invalid queued material run transition'
            USING ERRCODE = 'check_violation';
    ELSIF OLD."status" = 'running'
        AND NEW."status" NOT IN (
            'running', 'succeeded', 'partial', 'failed',
            'rate_limited', 'unknown', 'cancelled'
        ) THEN
        RAISE EXCEPTION 'invalid running material run transition'
            USING ERRCODE = 'check_violation';
    ELSIF OLD."status" NOT IN ('queued', 'running') AND NEW."status" <> OLD."status" THEN
        RAISE EXCEPTION 'terminal material run cannot be reopened'
            USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."requestCount" < OLD."requestCount"
        OR NEW."fetchedObjectCount" < OLD."fetchedObjectCount"
        OR NEW."publishedSourceCount" < OLD."publishedSourceCount"
        OR NEW."quarantineCount" < OLD."quarantineCount" THEN
        RAISE EXCEPTION 'material sync counters cannot decrease'
            USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" = 'succeeded' AND OLD."status" <> 'succeeded' THEN
        SELECT EXISTS (
            SELECT 1
            FROM "RepositoryMaterialGeneration" AS generation
            WHERE generation."projectId" = NEW."projectId"
              AND generation."projectRepositoryLinkId" = NEW."projectRepositoryLinkId"
              AND generation."githubMaterialSyncRunId" = NEW."id"
              AND generation."status" = 'complete'
              AND generation."sourceCount" = NEW."publishedSourceCount"
        ) INTO generation_ready;
        IF generation_ready IS NOT TRUE THEN
            RAISE EXCEPTION 'succeeded material run requires complete generation'
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "GitHubMaterialSyncRun_lifecycle_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "GitHubMaterialSyncRun"
FOR EACH ROW EXECUTE FUNCTION "github_material_sync_run_guard"();

CREATE OR REPLACE FUNCTION "github_source_version_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    source_scope "ContentOriginScope";
    source_link UUID;
    source_revision UUID;
    source_hash TEXT;
    source_bytes INTEGER;
BEGIN
    IF TG_OP = 'INSERT' THEN
        SELECT source."originScope", source."projectRepositoryLinkId",
               source."revisionKey", source."contentHash", octet_length(source."contentText")
        INTO source_scope, source_link, source_revision, source_hash, source_bytes
        FROM "ProjectSource" AS source
        WHERE source."projectId" = NEW."projectId"
          AND source."id" = NEW."projectSourceId"
        FOR KEY SHARE;
        IF source_scope IS DISTINCT FROM 'repository_link'
            OR source_link IS DISTINCT FROM NEW."projectRepositoryLinkId"
            OR source_revision IS DISTINCT FROM NEW."sourceRevisionKey"
            OR source_hash IS DISTINCT FROM NEW."sourceContentHash"
            OR source_bytes IS DISTINCT FROM NEW."sourceContentBytes" THEN
            RAISE EXCEPTION 'GitHub source version does not match project source'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;
    IF EXISTS (SELECT 1 FROM "Project" WHERE "id" = OLD."projectId") THEN
        RAISE EXCEPTION 'GitHub source version is immutable'
            USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "GitHubSourceVersion_lifecycle_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "GitHubSourceVersion"
FOR EACH ROW EXECUTE FUNCTION "github_source_version_guard"();

CREATE OR REPLACE FUNCTION "repository_material_generation_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    actual_count BIGINT;
    actual_bytes BIGINT;
    actual_manifest TEXT;
    link_eligible BOOLEAN;
BEGIN
    IF TG_OP = 'INSERT' THEN
        SELECT EXISTS (
            SELECT 1
            FROM "ProjectRepositoryLink" AS link
            JOIN "ProjectRepositoryLinkConfigPointer" AS pointer
              ON pointer."projectId" = link."projectId"
             AND pointer."projectRepositoryLinkId" = link."id"
            WHERE link."projectId" = NEW."projectId"
              AND link."id" = NEW."projectRepositoryLinkId"
              AND link."status" = 'active'
              AND link."effectivePolicyVersion" = NEW."effectivePolicyVersion"
              AND pointer."configVersion" = NEW."linkConfigVersion"
              AND pointer."effectivePolicyVersion" = NEW."effectivePolicyVersion"
        ) INTO link_eligible;
        IF NEW."status" <> 'staging' OR link_eligible IS NOT TRUE THEN
            RAISE EXCEPTION 'material generation is not eligible for staging'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;
    IF TG_OP = 'DELETE' THEN
        IF EXISTS (SELECT 1 FROM "Project" WHERE "id" = OLD."projectId") THEN
            RAISE EXCEPTION 'material generation is immutable'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN OLD;
    END IF;
    IF ROW(
        NEW."id", NEW."projectId", NEW."projectRepositoryLinkId",
        NEW."linkConfigVersion", NEW."githubMaterialSyncRunId",
        NEW."generationKey", NEW."capturedGitHubRepositoryId",
        NEW."capturedFullName", NEW."observedHeadCommitSha",
        NEW."effectivePolicyVersion", NEW."manifestFingerprint",
        NEW."enabledClassManifest", NEW."coverageManifest",
        NEW."scannerVersion", NEW."scannerFingerprint",
        NEW."sourceCount", NEW."decodedTextBytes", NEW."createdAt"
    ) IS DISTINCT FROM ROW(
        OLD."id", OLD."projectId", OLD."projectRepositoryLinkId",
        OLD."linkConfigVersion", OLD."githubMaterialSyncRunId",
        OLD."generationKey", OLD."capturedGitHubRepositoryId",
        OLD."capturedFullName", OLD."observedHeadCommitSha",
        OLD."effectivePolicyVersion", OLD."manifestFingerprint",
        OLD."enabledClassManifest", OLD."coverageManifest",
        OLD."scannerVersion", OLD."scannerFingerprint",
        OLD."sourceCount", OLD."decodedTextBytes", OLD."createdAt"
    ) THEN
        RAISE EXCEPTION 'material generation structure is immutable'
            USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'staging'
        AND NEW."status" NOT IN ('staging', 'complete', 'failed', 'ineligible') THEN
        RAISE EXCEPTION 'invalid material generation transition'
            USING ERRCODE = 'check_violation';
    ELSIF OLD."status" IN ('complete', 'failed', 'ineligible', 'superseded')
        AND NEW."status" NOT IN (OLD."status", 'superseded') THEN
        RAISE EXCEPTION 'terminal material generation cannot be reopened'
            USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" = 'complete' THEN
        SELECT COUNT(*), COALESCE(SUM(entry."sourceContentBytes"), 0),
               encode(sha256(convert_to(COALESCE(string_agg(concat_ws(E'\x1f',
                   entry."ordinal"::text,
                   entry."id"::text,
                   entry."githubSourceVersionId"::text,
                   entry."projectSourceId"::text,
                   entry."materialKind"::text,
                   entry."sourceContentHash",
                   entry."sourceContentBytes"::text
               ), E'\x1e' ORDER BY entry."ordinal"), ''), 'UTF8')), 'hex')
        INTO actual_count, actual_bytes, actual_manifest
        FROM "RepositoryMaterialGenerationEntry" AS entry
        WHERE entry."projectId" = NEW."projectId"
          AND entry."projectRepositoryLinkId" = NEW."projectRepositoryLinkId"
          AND entry."repositoryMaterialGenerationId" = NEW."id";
        IF actual_count <> NEW."sourceCount"
            OR actual_bytes <> NEW."decodedTextBytes"
            OR actual_manifest IS DISTINCT FROM NEW."manifestFingerprint" THEN
            RAISE EXCEPTION 'material generation manifest is incomplete'
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "RepositoryMaterialGeneration_lifecycle_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "RepositoryMaterialGeneration"
FOR EACH ROW EXECUTE FUNCTION "repository_material_generation_guard"();

CREATE OR REPLACE FUNCTION "repository_material_entry_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    generation_status "RepositoryMaterialGenerationStatus";
    source_kind "GitHubMaterialKind";
    source_hash TEXT;
    source_bytes INTEGER;
BEGIN
    IF TG_OP = 'INSERT' THEN
        SELECT generation."status" INTO generation_status
        FROM "RepositoryMaterialGeneration" AS generation
        WHERE generation."projectId" = NEW."projectId"
          AND generation."projectRepositoryLinkId" = NEW."projectRepositoryLinkId"
          AND generation."id" = NEW."repositoryMaterialGenerationId"
        FOR KEY SHARE;
        SELECT source."materialKind", source."sourceContentHash", source."sourceContentBytes"
        INTO source_kind, source_hash, source_bytes
        FROM "GitHubSourceVersion" AS source
        WHERE source."projectId" = NEW."projectId"
          AND source."projectRepositoryLinkId" = NEW."projectRepositoryLinkId"
          AND source."id" = NEW."githubSourceVersionId"
          AND source."projectSourceId" = NEW."projectSourceId"
        FOR KEY SHARE;
        IF generation_status IS DISTINCT FROM 'staging'
            OR source_kind IS DISTINCT FROM NEW."materialKind"
            OR source_hash IS DISTINCT FROM NEW."sourceContentHash"
            OR source_bytes IS DISTINCT FROM NEW."sourceContentBytes" THEN
            RAISE EXCEPTION 'material generation entry does not match source version'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;
    IF EXISTS (SELECT 1 FROM "Project" WHERE "id" = OLD."projectId") THEN
        RAISE EXCEPTION 'material generation entry is immutable'
            USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "RepositoryMaterialGenerationEntry_lifecycle_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "RepositoryMaterialGenerationEntry"
FOR EACH ROW EXECUTE FUNCTION "repository_material_entry_guard"();

CREATE OR REPLACE FUNCTION "repository_material_pointer_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    current_generation_id UUID;
    expected_generation_id UUID;
    publishable BOOLEAN;
BEGIN
    IF TG_OP = 'UPDATE' AND (
        NEW."projectId" IS DISTINCT FROM OLD."projectId"
        OR NEW."projectRepositoryLinkId" IS DISTINCT FROM OLD."projectRepositoryLinkId"
    ) THEN
        RAISE EXCEPTION 'material pointer identity is immutable'
            USING ERRCODE = 'check_violation';
    END IF;
    PERFORM 1
    FROM "ProjectRepositoryLink" AS link
    WHERE link."projectId" = NEW."projectId"
      AND link."id" = NEW."projectRepositoryLinkId"
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'material pointer link does not exist'
            USING ERRCODE = 'check_violation';
    END IF;
    SELECT pointer."repositoryMaterialGenerationId"
    INTO current_generation_id
    FROM "RepositoryMaterialGenerationPointer" AS pointer
    WHERE pointer."projectId" = NEW."projectId"
      AND pointer."projectRepositoryLinkId" = NEW."projectRepositoryLinkId";
    SELECT run."expectedActiveMaterialGenerationId"
    INTO expected_generation_id
    FROM "RepositoryMaterialGeneration" AS generation
    JOIN "GitHubMaterialSyncRun" AS run
      ON run."projectId" = generation."projectId"
     AND run."projectRepositoryLinkId" = generation."projectRepositoryLinkId"
     AND run."id" = generation."githubMaterialSyncRunId"
    WHERE generation."projectId" = NEW."projectId"
      AND generation."projectRepositoryLinkId" = NEW."projectRepositoryLinkId"
      AND generation."id" = NEW."repositoryMaterialGenerationId";
    IF NOT FOUND OR expected_generation_id IS DISTINCT FROM current_generation_id THEN
        RAISE EXCEPTION 'material publication lost compare-and-swap'
            USING ERRCODE = 'serialization_failure';
    END IF;
    SELECT EXISTS (
        SELECT 1
        FROM "RepositoryMaterialGeneration" AS generation
        JOIN "GitHubMaterialSyncRun" AS run
          ON run."projectId" = generation."projectId"
         AND run."projectRepositoryLinkId" = generation."projectRepositoryLinkId"
         AND run."id" = generation."githubMaterialSyncRunId"
        JOIN "ProjectRepositoryLink" AS link
          ON link."projectId" = generation."projectId"
         AND link."id" = generation."projectRepositoryLinkId"
        JOIN "ProjectRepositoryLinkConfigPointer" AS config_pointer
          ON config_pointer."projectId" = generation."projectId"
         AND config_pointer."projectRepositoryLinkId" = generation."projectRepositoryLinkId"
        WHERE generation."projectId" = NEW."projectId"
          AND generation."projectRepositoryLinkId" = NEW."projectRepositoryLinkId"
          AND generation."id" = NEW."repositoryMaterialGenerationId"
          AND generation."status" = 'complete'
          AND generation."linkConfigVersion" = NEW."linkConfigVersion"
          AND generation."effectivePolicyVersion" = NEW."effectivePolicyVersion"
          AND run."status" = 'succeeded'
          AND link."status" = 'active'
          AND link."effectivePolicyVersion" = NEW."effectivePolicyVersion"
          AND config_pointer."configVersion" = NEW."linkConfigVersion"
          AND config_pointer."effectivePolicyVersion" = NEW."effectivePolicyVersion"
    ) INTO publishable;
    IF publishable IS NOT TRUE THEN
        RAISE EXCEPTION 'material generation is not publishable'
            USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'UPDATE'
        AND OLD."repositoryMaterialGenerationId" <> NEW."repositoryMaterialGenerationId" THEN
        UPDATE "RepositoryMaterialGeneration"
        SET "status" = 'superseded', "supersededAt" = NEW."updatedAt"
        WHERE "projectId" = OLD."projectId"
          AND "id" = OLD."repositoryMaterialGenerationId"
          AND "status" = 'complete';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "RepositoryMaterialGenerationPointer_publish_trigger"
BEFORE INSERT OR UPDATE ON "RepositoryMaterialGenerationPointer"
FOR EACH ROW EXECUTE FUNCTION "repository_material_pointer_guard"();

CREATE OR REPLACE FUNCTION "github_material_quarantine_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    run_status "GitHubMaterialSyncRunStatus";
BEGIN
    IF TG_OP = 'INSERT' THEN
        SELECT run."status" INTO run_status
        FROM "GitHubMaterialSyncRun" AS run
        WHERE run."projectId" = NEW."projectId"
          AND run."projectRepositoryLinkId" = NEW."projectRepositoryLinkId"
          AND run."id" = NEW."githubMaterialSyncRunId"
        FOR KEY SHARE;
        IF run_status IS DISTINCT FROM 'running' THEN
            RAISE EXCEPTION 'quarantine requires running material sync'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;
    IF EXISTS (SELECT 1 FROM "Project" WHERE "id" = OLD."projectId") THEN
        RAISE EXCEPTION 'material quarantine is immutable'
            USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "GitHubMaterialQuarantine_lifecycle_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "GitHubMaterialQuarantine"
FOR EACH ROW EXECUTE FUNCTION "github_material_quarantine_guard"();
