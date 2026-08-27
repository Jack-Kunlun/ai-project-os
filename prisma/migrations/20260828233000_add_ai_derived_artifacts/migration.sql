CREATE TYPE "AiDerivedArtifactKind" AS ENUM (
    'source_summary', 'project_brief', 'rag_answer', 'agent_report'
);

CREATE TYPE "AiDerivedArtifactState" AS ENUM (
    'active', 'stale', 'restricted'
);

CREATE TYPE "ArtifactDependencyKind" AS ENUM (
    'project_source', 'project_rag_snapshot'
);

CREATE TYPE "ArtifactRestrictionReasonCode" AS ENUM (
    'GRANT_INELIGIBLE', 'POLICY_INELIGIBLE',
    'SNAPSHOT_INELIGIBLE', 'DEPENDENCY_MISMATCH'
);

CREATE TABLE "AiDerivedArtifact" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "kind" "AiDerivedArtifactKind" NOT NULL,
    "state" "AiDerivedArtifactState" NOT NULL DEFAULT 'active',
    "operation" "AiOperation" NOT NULL,
    "artifactFingerprint" VARCHAR(64) NOT NULL,
    "inputFingerprint" VARCHAR(64) NOT NULL,
    "outputFingerprint" VARCHAR(64) NOT NULL,
    "payload" JSONB NOT NULL,
    "projectRagSnapshotId" UUID NOT NULL,
    "snapshotManifestFingerprint" VARCHAR(64) NOT NULL,
    "grantId" UUID NOT NULL,
    "policyRevisionId" UUID NOT NULL,
    "effectivePolicyVersion" INTEGER NOT NULL,
    "profileFingerprint" VARCHAR(64) NOT NULL,
    "providerFingerprint" VARCHAR(64) NOT NULL,
    "modelFingerprint" VARCHAR(64) NOT NULL,
    "modelId" VARCHAR(128) NOT NULL,
    "promptFingerprint" VARCHAR(64) NOT NULL,
    "promptVersion" VARCHAR(128) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "staleAt" TIMESTAMP(3),
    "restrictedAt" TIMESTAMP(3),
    "restrictionReasonCode" "ArtifactRestrictionReasonCode",

    CONSTRAINT "AiDerivedArtifact_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AiDerivedArtifact_values_check" CHECK (
        "effectivePolicyVersion" > 0
        AND "artifactFingerprint" ~ '^[0-9a-f]{64}$'
        AND "inputFingerprint" ~ '^[0-9a-f]{64}$'
        AND "outputFingerprint" ~ '^[0-9a-f]{64}$'
        AND "snapshotManifestFingerprint" ~ '^[0-9a-f]{64}$'
        AND "profileFingerprint" ~ '^[0-9a-f]{64}$'
        AND "providerFingerprint" ~ '^[0-9a-f]{64}$'
        AND "modelFingerprint" ~ '^[0-9a-f]{64}$'
        AND "promptFingerprint" ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT "AiDerivedArtifact_kind_operation_check" CHECK (
        ("kind" = 'source_summary' AND "operation" = 'sourceSummary')
        OR ("kind" = 'project_brief' AND "operation" = 'projectAnalysis')
        OR ("kind" = 'rag_answer' AND "operation" = 'generateWithContext')
        OR ("kind" = 'agent_report' AND "operation" = 'projectAnalysis')
    ),
    CONSTRAINT "AiDerivedArtifact_lifecycle_check" CHECK (
        ("state" = 'active' AND "staleAt" IS NULL
            AND "restrictedAt" IS NULL AND "restrictionReasonCode" IS NULL)
        OR ("state" = 'stale' AND "staleAt" IS NOT NULL
            AND "restrictedAt" IS NULL AND "restrictionReasonCode" IS NULL)
        OR ("state" = 'restricted' AND "restrictedAt" IS NOT NULL
            AND "restrictionReasonCode" IS NOT NULL)
    )
);

CREATE UNIQUE INDEX "AiDerivedArtifact_projectId_id_key"
ON "AiDerivedArtifact"("projectId", "id");
CREATE UNIQUE INDEX "AiDerivedArtifact_project_fingerprint_key"
ON "AiDerivedArtifact"("projectId", "artifactFingerprint");
CREATE INDEX "AiDerivedArtifact_projectId_kind_createdAt_idx"
ON "AiDerivedArtifact"("projectId", "kind", "createdAt");
CREATE INDEX "AiDerivedArtifact_projectId_state_createdAt_idx"
ON "AiDerivedArtifact"("projectId", "state", "createdAt");
CREATE INDEX "AiDerivedArtifact_projectId_projectRagSnapshotId_idx"
ON "AiDerivedArtifact"("projectId", "projectRagSnapshotId");
CREATE INDEX "AiDerivedArtifact_projectId_grantId_idx"
ON "AiDerivedArtifact"("projectId", "grantId");

CREATE TABLE "ArtifactDependency" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "artifactId" UUID NOT NULL,
    "dependencyKind" "ArtifactDependencyKind" NOT NULL,
    "originScope" "ContentOriginScope",
    "projectSourceId" UUID,
    "sourceRevisionKey" UUID,
    "sourceContentHash" VARCHAR(64),
    "projectRagSnapshotId" UUID,
    "snapshotManifestFingerprint" VARCHAR(64),
    "grantId" UUID NOT NULL,
    "policyRevisionId" UUID NOT NULL,
    "effectivePolicyVersion" INTEGER NOT NULL,
    "dependencyFingerprint" VARCHAR(64) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ArtifactDependency_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ArtifactDependency_values_check" CHECK (
        "effectivePolicyVersion" > 0
        AND "dependencyFingerprint" ~ '^[0-9a-f]{64}$'
        AND ("sourceContentHash" IS NULL
            OR "sourceContentHash" ~ '^[0-9a-f]{64}$')
        AND ("snapshotManifestFingerprint" IS NULL
            OR "snapshotManifestFingerprint" ~ '^[0-9a-f]{64}$')
    ),
    CONSTRAINT "ArtifactDependency_shape_check" CHECK (
        ("dependencyKind" = 'project_source'
            AND "originScope" IS NOT NULL
            AND "projectSourceId" IS NOT NULL
            AND "sourceRevisionKey" IS NOT NULL
            AND "sourceContentHash" IS NOT NULL
            AND "projectRagSnapshotId" IS NULL
            AND "snapshotManifestFingerprint" IS NULL)
        OR ("dependencyKind" = 'project_rag_snapshot'
            AND "originScope" IS NULL
            AND "projectSourceId" IS NULL
            AND "sourceRevisionKey" IS NULL
            AND "sourceContentHash" IS NULL
            AND "projectRagSnapshotId" IS NOT NULL
            AND "snapshotManifestFingerprint" IS NOT NULL)
    )
);

CREATE UNIQUE INDEX "ArtifactDependency_projectId_id_key"
ON "ArtifactDependency"("projectId", "id");
CREATE UNIQUE INDEX "ArtifactDependency_artifact_fingerprint_key"
ON "ArtifactDependency"("projectId", "artifactId", "dependencyFingerprint");
CREATE INDEX "ArtifactDependency_projectId_projectSourceId_idx"
ON "ArtifactDependency"("projectId", "projectSourceId");
CREATE INDEX "ArtifactDependency_projectId_projectRagSnapshotId_idx"
ON "ArtifactDependency"("projectId", "projectRagSnapshotId");

ALTER TABLE "AiDerivedArtifact"
ADD CONSTRAINT "AiDerivedArtifact_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "Project"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AiDerivedArtifact"
ADD CONSTRAINT "AiDerivedArtifact_grant_fkey"
FOREIGN KEY ("projectId", "grantId", "policyRevisionId")
REFERENCES "ModelProcessingGrant"("projectId", "id", "policyRevisionId")
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "AiDerivedArtifact"
ADD CONSTRAINT "AiDerivedArtifact_policy_fkey"
FOREIGN KEY ("projectId", "policyRevisionId")
REFERENCES "ProjectAiPolicyRevision"("projectId", "id")
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "AiDerivedArtifact"
ADD CONSTRAINT "AiDerivedArtifact_rag_snapshot_fkey"
FOREIGN KEY ("projectId", "projectRagSnapshotId")
REFERENCES "ProjectRagSnapshot"("projectId", "id")
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "ArtifactDependency"
ADD CONSTRAINT "ArtifactDependency_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "Project"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ArtifactDependency"
ADD CONSTRAINT "ArtifactDependency_artifact_fkey"
FOREIGN KEY ("projectId", "artifactId")
REFERENCES "AiDerivedArtifact"("projectId", "id")
ON DELETE CASCADE ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "ArtifactDependency"
ADD CONSTRAINT "ArtifactDependency_project_source_fkey"
FOREIGN KEY ("projectId", "projectSourceId")
REFERENCES "ProjectSource"("projectId", "id")
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "ArtifactDependency"
ADD CONSTRAINT "ArtifactDependency_rag_snapshot_fkey"
FOREIGN KEY ("projectId", "projectRagSnapshotId")
REFERENCES "ProjectRagSnapshot"("projectId", "id")
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

CREATE OR REPLACE FUNCTION "ai_derived_artifact_guard"()
RETURNS TRIGGER AS $$
DECLARE
    boundary_ok BOOLEAN;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF ROW(
            NEW."id", NEW."projectId", NEW."kind", NEW."operation",
            NEW."artifactFingerprint", NEW."inputFingerprint",
            NEW."outputFingerprint", NEW."payload",
            NEW."projectRagSnapshotId", NEW."snapshotManifestFingerprint",
            NEW."grantId", NEW."policyRevisionId",
            NEW."effectivePolicyVersion", NEW."profileFingerprint",
            NEW."providerFingerprint", NEW."modelFingerprint", NEW."modelId",
            NEW."promptFingerprint", NEW."promptVersion", NEW."createdAt"
        ) IS DISTINCT FROM ROW(
            OLD."id", OLD."projectId", OLD."kind", OLD."operation",
            OLD."artifactFingerprint", OLD."inputFingerprint",
            OLD."outputFingerprint", OLD."payload",
            OLD."projectRagSnapshotId", OLD."snapshotManifestFingerprint",
            OLD."grantId", OLD."policyRevisionId",
            OLD."effectivePolicyVersion", OLD."profileFingerprint",
            OLD."providerFingerprint", OLD."modelFingerprint", OLD."modelId",
            OLD."promptFingerprint", OLD."promptVersion", OLD."createdAt"
        ) THEN
            RAISE EXCEPTION 'AI_DERIVED_ARTIFACT_IMMUTABLE';
        END IF;
        IF OLD."state" = 'restricted'
            OR (OLD."state" = 'stale' AND NEW."state" <> 'restricted')
            OR (OLD."state" = 'active' AND NEW."state" = 'active'
                AND ROW(NEW."staleAt", NEW."restrictedAt", NEW."restrictionReasonCode")
                    IS DISTINCT FROM ROW(OLD."staleAt", OLD."restrictedAt", OLD."restrictionReasonCode"))
        THEN
            RAISE EXCEPTION 'AI_DERIVED_ARTIFACT_INVALID_TRANSITION';
        END IF;
    END IF;

    SELECT EXISTS (
        SELECT 1
          FROM "ModelProcessingGrant" AS grant_row
          JOIN "ModelProcessingGrantOperation" AS operation_row
            ON operation_row."projectId" = grant_row."projectId"
           AND operation_row."grantId" = grant_row."id"
           AND operation_row."operation" = NEW."operation"
          JOIN "ProjectAiPolicyRevision" AS revision
            ON revision."projectId" = grant_row."projectId"
           AND revision."id" = grant_row."policyRevisionId"
          JOIN "ProjectRagSnapshot" AS snapshot
            ON snapshot."projectId" = grant_row."projectId"
           AND snapshot."id" = NEW."projectRagSnapshotId"
         WHERE grant_row."projectId" = NEW."projectId"
           AND grant_row."id" = NEW."grantId"
           AND grant_row."policyRevisionId" = NEW."policyRevisionId"
           AND grant_row."effectivePolicyVersion" = NEW."effectivePolicyVersion"
           AND grant_row."profileFingerprint" = NEW."profileFingerprint"
           AND grant_row."providerFingerprint" = NEW."providerFingerprint"
           AND grant_row."modelFingerprint" = NEW."modelFingerprint"
           AND grant_row."modelId" = NEW."modelId"
           AND revision."revision" = NEW."effectivePolicyVersion"
           AND snapshot."manifestFingerprint" = NEW."snapshotManifestFingerprint"
    ) INTO boundary_ok;
    IF NOT boundary_ok THEN
        RAISE EXCEPTION 'AI_DERIVED_ARTIFACT_BOUNDARY_MISMATCH';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AiDerivedArtifact_guard_trigger"
BEFORE INSERT OR UPDATE ON "AiDerivedArtifact"
FOR EACH ROW EXECUTE FUNCTION "ai_derived_artifact_guard"();

CREATE OR REPLACE FUNCTION "artifact_dependency_guard"()
RETURNS TRIGGER AS $$
DECLARE
    dependency_ok BOOLEAN;
BEGIN
    IF TG_OP = 'UPDATE' AND NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'ARTIFACT_DEPENDENCY_IMMUTABLE';
    END IF;

    SELECT EXISTS (
        SELECT 1
          FROM "AiDerivedArtifact" AS artifact
         WHERE artifact."projectId" = NEW."projectId"
           AND artifact."id" = NEW."artifactId"
           AND artifact."grantId" = NEW."grantId"
           AND artifact."policyRevisionId" = NEW."policyRevisionId"
           AND artifact."effectivePolicyVersion" = NEW."effectivePolicyVersion"
           AND (
                (NEW."dependencyKind" = 'project_source'
                    AND EXISTS (
                        SELECT 1 FROM "ProjectSource" AS source
                         WHERE source."projectId" = NEW."projectId"
                           AND source."id" = NEW."projectSourceId"
                           AND source."originScope" = NEW."originScope"
                           AND source."revisionKey" = NEW."sourceRevisionKey"
                           AND source."contentHash" = NEW."sourceContentHash"
                    ))
                OR (NEW."dependencyKind" = 'project_rag_snapshot'
                    AND artifact."projectRagSnapshotId" = NEW."projectRagSnapshotId"
                    AND artifact."snapshotManifestFingerprint" = NEW."snapshotManifestFingerprint")
           )
    ) INTO dependency_ok;
    IF NOT dependency_ok THEN
        RAISE EXCEPTION 'ARTIFACT_DEPENDENCY_BOUNDARY_MISMATCH';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ArtifactDependency_guard_trigger"
BEFORE INSERT OR UPDATE ON "ArtifactDependency"
FOR EACH ROW EXECUTE FUNCTION "artifact_dependency_guard"();

CREATE OR REPLACE FUNCTION "assert_artifact_dependency_manifest"()
RETURNS TRIGGER AS $$
DECLARE
    target_project_id UUID;
    target_artifact_id UUID;
    artifact_exists BOOLEAN;
    source_count INTEGER;
    snapshot_count INTEGER;
BEGIN
    target_project_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."projectId" ELSE NEW."projectId" END;
    target_artifact_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."artifactId" ELSE NEW."artifactId" END;

    SELECT EXISTS (
        SELECT 1 FROM "AiDerivedArtifact"
         WHERE "projectId" = target_project_id AND "id" = target_artifact_id
    ) INTO artifact_exists;
    IF NOT artifact_exists THEN
        RETURN NULL;
    END IF;

    SELECT
        COUNT(*) FILTER (WHERE "dependencyKind" = 'project_source'),
        COUNT(*) FILTER (WHERE "dependencyKind" = 'project_rag_snapshot')
      INTO source_count, snapshot_count
      FROM "ArtifactDependency"
     WHERE "projectId" = target_project_id AND "artifactId" = target_artifact_id;

    IF source_count < 1 OR snapshot_count <> 1 THEN
        RAISE EXCEPTION 'ARTIFACT_DEPENDENCY_MANIFEST_INCOMPLETE';
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "assert_new_artifact_dependency_manifest"()
RETURNS TRIGGER AS $$
DECLARE
    source_count INTEGER;
    snapshot_count INTEGER;
BEGIN
    SELECT
        COUNT(*) FILTER (WHERE "dependencyKind" = 'project_source'),
        COUNT(*) FILTER (WHERE "dependencyKind" = 'project_rag_snapshot')
      INTO source_count, snapshot_count
      FROM "ArtifactDependency"
     WHERE "projectId" = NEW."projectId" AND "artifactId" = NEW."id";
    IF source_count < 1 OR snapshot_count <> 1 THEN
        RAISE EXCEPTION 'ARTIFACT_DEPENDENCY_MANIFEST_INCOMPLETE';
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "AiDerivedArtifact_dependency_manifest_constraint"
AFTER INSERT OR UPDATE ON "AiDerivedArtifact"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "assert_new_artifact_dependency_manifest"();

CREATE CONSTRAINT TRIGGER "ArtifactDependency_manifest_constraint"
AFTER INSERT OR UPDATE OR DELETE ON "ArtifactDependency"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "assert_artifact_dependency_manifest"();
