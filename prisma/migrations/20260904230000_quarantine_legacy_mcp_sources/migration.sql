-- Historical generic Action Engine MCP result imports are forensic evidence,
-- not product sources. Retire them before installing the permanent guard.
-- Asset segments have their own user-visible content fields, so merely
-- retiring the linked source would not quarantine an unexpected historical
-- derivative. Standard legacy intake never created this relation: fail the
-- upgrade closed and require explicit forensic cleanup if one exists.
DO $legacy_mcp_asset_preflight$
BEGIN
    IF EXISTS (
        SELECT 1
          FROM "ProjectAssetSegment" AS segment
          JOIN "ProjectSource" AS source
            ON source."projectId" = segment."projectId"
           AND source."id" = segment."projectSourceId"
         WHERE source."kind"::text = 'mcp'
    ) THEN
        RAISE EXCEPTION 'LEGACY_MCP_PROJECT_ASSET_SEGMENT_PREFLIGHT_FAILED'
            USING ERRCODE = 'check_violation';
    END IF;
END;
$legacy_mcp_asset_preflight$;

-- Repository material carries independent source text, chunks, embeddings,
-- and published RAG pointers. Legacy MCP intake never produced a
-- GitHubSourceVersion, so any such lineage is anomalous and needs an explicit
-- forensic cleanup rather than an automatic destructive migration.
DO $legacy_mcp_repository_material_preflight$
BEGIN
    IF EXISTS (
        SELECT 1
          FROM "GitHubSourceVersion" AS source_version
          JOIN "ProjectSource" AS source
            ON source."projectId" = source_version."projectId"
           AND source."id" = source_version."projectSourceId"
         WHERE source."kind"::text = 'mcp'
    ) THEN
        RAISE EXCEPTION 'LEGACY_MCP_REPOSITORY_MATERIAL_PREFLIGHT_FAILED'
            USING ERRCODE = 'check_violation';
    END IF;
END;
$legacy_mcp_repository_material_preflight$;

UPDATE "ProjectSource"
   SET "retiredAt" = (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3)
 WHERE "kind"::text = 'mcp'
   AND "retiredAt" IS NULL;

ALTER TABLE "ProjectSource"
ADD CONSTRAINT "ProjectSource_legacy_mcp_retired_check"
CHECK ("kind"::text <> 'mcp' OR "retiredAt" IS NOT NULL);

-- No new legacy container may be created after the replacement runtime is
-- installed. Existing rows are immutable forensic evidence; normal sources
-- keep their existing retirement lifecycle.
CREATE OR REPLACE FUNCTION "project_source_identity_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."kind"::text = 'mcp' THEN
            RAISE EXCEPTION 'LEGACY_MCP_SOURCE_CREATION_FROZEN' USING ERRCODE = 'check_violation';
        END IF;
        IF NEW."sourceIdentity" IS NULL THEN
            NEW."sourceIdentity" := gen_random_uuid();
        END IF;
        IF NEW."revisionKey" IS NULL THEN
            NEW."revisionKey" := gen_random_uuid();
        END IF;
        IF NEW."originScope" = 'project' AND NEW."kind" = 'manual' AND NEW."manualContentDedupeKey" IS NULL THEN
            NEW."manualContentDedupeKey" := NEW."contentHash";
        END IF;
        RETURN NEW;
    END IF;

    IF OLD."kind"::text = 'mcp' THEN
        RAISE EXCEPTION 'legacy MCP sources are immutable' USING ERRCODE = 'check_violation';
    END IF;

    IF ROW(
        NEW."id", NEW."projectId", NEW."kind", NEW."originScope",
        NEW."projectRepositoryLinkId", NEW."sourceIdentity", NEW."revisionKey"
    ) IS DISTINCT FROM ROW(
        OLD."id", OLD."projectId", OLD."kind", OLD."originScope",
        OLD."projectRepositoryLinkId", OLD."sourceIdentity", OLD."revisionKey"
    ) THEN
        RAISE EXCEPTION 'project source identity is immutable'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

-- Historical grants that include a legacy result container cannot remain
-- eligible merely because their original expiry has not elapsed.
UPDATE "ModelProcessingGrant" AS target_grant
   SET "status" = 'revoked',
       "revokedAt" = (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3),
       "revocationReasonCode" = 'securityReview',
       "updatedAt" = (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3)
 WHERE target_grant."status"::text = 'issued'
   AND EXISTS (
     SELECT 1
       FROM "ModelProcessingGrantSource" AS grant_source
       JOIN "ProjectSource" AS source
         ON source."projectId" = grant_source."projectId"
        AND source."id" = grant_source."sourceId"
      WHERE grant_source."projectId" = target_grant."projectId"
        AND grant_source."grantId" = target_grant."id"
        AND source."kind"::text = 'mcp'
   );

UPDATE "WebAiGrant" AS target_grant
   SET "revokedAt" = COALESCE(
     target_grant."revokedAt",
     (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3)
   )
 WHERE target_grant."scopeKind"::text = 'project_sources'
   AND EXISTS (
     SELECT 1
       FROM "ProjectSource" AS source
      WHERE source."projectId" = target_grant."projectId"
        AND source."kind"::text = 'mcp'
        AND target_grant."scopeIds" ? source."id"::text
   );

-- The replacement single-use dispatch path retains a sanitized result on the
-- MCP action itself. The old source-import bridge stays permanently frozen.
CREATE OR REPLACE FUNCTION "project_action_result_import_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF EXISTS (SELECT 1 FROM "Project" WHERE "id" = OLD."projectId") THEN
            RAISE EXCEPTION 'project action result imports are append-only' USING ERRCODE = 'check_violation';
        END IF;
        RETURN OLD;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'project action result imports are immutable' USING ERRCODE = 'check_violation';
    END IF;

    RAISE EXCEPTION 'LEGACY_MCP_RESULT_INTAKE_FROZEN' USING ERRCODE = 'check_violation';
END;
$$;

-- Remove every active pointer whose published lineage contains a retired
-- generic MCP result. The underlying immutable rows remain available for
-- database-level forensic inspection, but no active read path can reach them.
DELETE FROM "MemoryIndexPointer" AS pointer
USING "MemoryRecord" AS record, "ProjectSource" AS source
WHERE record."projectId" = pointer."projectId"
  AND record."indexGenerationId" = pointer."indexGenerationId"
  AND source."projectId" = record."projectId"
  AND source."id" = record."projectSourceId"
  AND source."kind"::text = 'mcp';

DELETE FROM "ProjectCorpusIndexPointer" AS pointer
USING "ProjectCorpusGenerationEntry" AS entry, "ProjectSource" AS source
WHERE entry."projectId" = pointer."projectId"
  AND entry."corpusGenerationId" = pointer."corpusGenerationId"
  AND source."projectId" = entry."projectId"
  AND source."id" = entry."projectSourceId"
  AND source."kind"::text = 'mcp';

DELETE FROM "ProjectRagSnapshotPointer" AS pointer
USING "ProjectRagSnapshot" AS snapshot,
      "ProjectCorpusGenerationEntry" AS entry,
      "ProjectSource" AS source
WHERE snapshot."projectId" = pointer."projectId"
  AND snapshot."id" = pointer."ragSnapshotId"
  AND entry."projectId" = snapshot."projectId"
  AND entry."corpusGenerationId" = snapshot."manualCorpusGenerationId"
  AND source."projectId" = entry."projectId"
  AND source."id" = entry."projectSourceId"
  AND source."kind"::text = 'mcp';

DELETE FROM "ProjectRepositoryRagSnapshotPointer" AS pointer
USING "ProjectRepositoryRagSnapshot" AS aggregate_snapshot,
      "ProjectRagSnapshot" AS manual_snapshot,
      "ProjectCorpusGenerationEntry" AS entry,
      "ProjectSource" AS source
WHERE aggregate_snapshot."projectId" = pointer."projectId"
  AND aggregate_snapshot."id" = pointer."projectRepositoryRagSnapshotId"
  AND manual_snapshot."projectId" = aggregate_snapshot."projectId"
  AND manual_snapshot."id" = aggregate_snapshot."manualRagSnapshotId"
  AND entry."projectId" = manual_snapshot."projectId"
  AND entry."corpusGenerationId" = manual_snapshot."manualCorpusGenerationId"
  AND source."projectId" = entry."projectId"
  AND source."id" = entry."projectSourceId"
  AND source."kind"::text = 'mcp';

UPDATE "AiDerivedArtifact" AS artifact
   SET "state" = 'restricted',
       "staleAt" = COALESCE(
         artifact."staleAt",
         (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3)
       ),
       "restrictedAt" = COALESCE(
         artifact."restrictedAt",
         (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3)
       ),
       "restrictionReasonCode" = 'DEPENDENCY_MISMATCH'
 WHERE EXISTS (
   SELECT 1
     FROM "ArtifactDependency" AS dependency
     JOIN "ProjectSource" AS source
       ON source."projectId" = dependency."projectId"
      AND source."id" = dependency."projectSourceId"
    WHERE dependency."projectId" = artifact."projectId"
      AND dependency."artifactId" = artifact."id"
      AND source."kind"::text = 'mcp'
 )
   AND artifact."state"::text <> 'restricted';

-- Defense in depth for every direct ProjectSource foreign-key consumer. The
-- legacy rows stay queryable only as database-level forensic evidence and can
-- no longer seed a new grant, item, index, candidate, artifact, or plan link.
CREATE OR REPLACE FUNCTION "legacy_mcp_source_reference_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    referenced_source_id UUID;
BEGIN
    referenced_source_id := NULLIF(to_jsonb(NEW) ->> TG_ARGV[0], '')::uuid;
    IF referenced_source_id IS NULL THEN
        RETURN NEW;
    END IF;
    IF EXISTS (
        SELECT 1
          FROM "ProjectSource" AS source
         WHERE source."projectId" = NEW."projectId"
           AND source."id" = referenced_source_id
           AND source."kind"::text = 'mcp'
    ) THEN
        RAISE EXCEPTION 'LEGACY_MCP_SOURCE_REFERENCE_FORBIDDEN' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "LegacyMcpSourceReference_guard"
BEFORE INSERT OR UPDATE ON "GitRepositorySnapshotEntry"
FOR EACH ROW EXECUTE FUNCTION "legacy_mcp_source_reference_guard"('projectSourceId');
CREATE TRIGGER "LegacyMcpSourceReference_guard"
BEFORE INSERT OR UPDATE ON "ProjectGitRepositoryManualRunEntry"
FOR EACH ROW EXECUTE FUNCTION "legacy_mcp_source_reference_guard"('projectSourceId');
CREATE TRIGGER "LegacyMcpSourceReference_guard"
BEFORE INSERT OR UPDATE ON "GitHubSourceVersion"
FOR EACH ROW EXECUTE FUNCTION "legacy_mcp_source_reference_guard"('projectSourceId');
CREATE TRIGGER "LegacyMcpSourceReference_guard"
BEFORE INSERT OR UPDATE ON "RepositoryMaterialGenerationEntry"
FOR EACH ROW EXECUTE FUNCTION "legacy_mcp_source_reference_guard"('projectSourceId');
CREATE TRIGGER "LegacyMcpSourceReference_guard"
BEFORE INSERT OR UPDATE ON "RepositoryMaterialModelGrantSource"
FOR EACH ROW EXECUTE FUNCTION "legacy_mcp_source_reference_guard"('projectSourceId');
CREATE TRIGGER "LegacyMcpSourceReference_guard"
BEFORE INSERT OR UPDATE ON "RepositoryMaterialChunk"
FOR EACH ROW EXECUTE FUNCTION "legacy_mcp_source_reference_guard"('projectSourceId');
CREATE TRIGGER "LegacyMcpSourceReference_guard"
BEFORE INSERT OR UPDATE ON "RepositoryMaterialIndexInput"
FOR EACH ROW EXECUTE FUNCTION "legacy_mcp_source_reference_guard"('projectSourceId');
CREATE TRIGGER "LegacyMcpSourceReference_guard"
BEFORE INSERT OR UPDATE ON "ProjectAssetSegment"
FOR EACH ROW EXECUTE FUNCTION "legacy_mcp_source_reference_guard"('projectSourceId');
CREATE TRIGGER "LegacyMcpSourceReference_guard"
BEFORE INSERT OR UPDATE ON "ProjectItem"
FOR EACH ROW EXECUTE FUNCTION "legacy_mcp_source_reference_guard"('sourceId');
CREATE TRIGGER "LegacyMcpSourceReference_guard"
BEFORE INSERT OR UPDATE ON "ProjectItemEvidence"
FOR EACH ROW EXECUTE FUNCTION "legacy_mcp_source_reference_guard"('projectSourceId');
CREATE TRIGGER "LegacyMcpSourceReference_guard"
BEFORE INSERT OR UPDATE ON "SourceChunk"
FOR EACH ROW EXECUTE FUNCTION "legacy_mcp_source_reference_guard"('projectSourceId');
CREATE TRIGGER "LegacyMcpSourceReference_guard"
BEFORE INSERT OR UPDATE ON "ProjectCorpusGenerationEntry"
FOR EACH ROW EXECUTE FUNCTION "legacy_mcp_source_reference_guard"('projectSourceId');
CREATE TRIGGER "LegacyMcpSourceReference_guard"
BEFORE INSERT OR UPDATE ON "ArtifactDependency"
FOR EACH ROW EXECUTE FUNCTION "legacy_mcp_source_reference_guard"('projectSourceId');
CREATE TRIGGER "LegacyMcpSourceReference_guard"
BEFORE INSERT OR UPDATE ON "ModelProcessingGrantSource"
FOR EACH ROW EXECUTE FUNCTION "legacy_mcp_source_reference_guard"('sourceId');
CREATE TRIGGER "LegacyMcpSourceReference_guard"
BEFORE INSERT OR UPDATE ON "AiRunInputSource"
FOR EACH ROW EXECUTE FUNCTION "legacy_mcp_source_reference_guard"('sourceId');
CREATE TRIGGER "LegacyMcpSourceReference_guard"
BEFORE INSERT OR UPDATE ON "AiCandidateClaim"
FOR EACH ROW EXECUTE FUNCTION "legacy_mcp_source_reference_guard"('sourceId');
CREATE TRIGGER "LegacyMcpSourceReference_guard"
BEFORE INSERT OR UPDATE ON "WebSourceRevision"
FOR EACH ROW EXECUTE FUNCTION "legacy_mcp_source_reference_guard"('projectSourceId');
CREATE TRIGGER "LegacyMcpSourceReference_guard"
BEFORE INSERT OR UPDATE ON "MemoryRecord"
FOR EACH ROW EXECUTE FUNCTION "legacy_mcp_source_reference_guard"('projectSourceId');
CREATE TRIGGER "LegacyMcpSourceReference_guard"
BEFORE INSERT OR UPDATE ON "ProjectWorkItemEvidenceLink"
FOR EACH ROW EXECUTE FUNCTION "legacy_mcp_source_reference_guard"('projectSourceId');
CREATE TRIGGER "LegacyMcpSourceReference_guard"
BEFORE INSERT OR UPDATE ON "WebAiCandidate"
FOR EACH ROW EXECUTE FUNCTION "legacy_mcp_source_reference_guard"('sourceId');

-- Published repository RAG status is also a read boundary. A retired source
-- (including every legacy MCP source) makes the material snapshot non-current
-- even if an older index pointer still exists.
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
          AND NOT EXISTS (
              SELECT 1
              FROM "RepositoryMaterialGenerationEntry" AS material_entry
              JOIN "GitHubSourceVersion" AS source_version
                ON source_version."projectId" = material_entry."projectId"
               AND source_version."projectRepositoryLinkId" =
                   material_entry."projectRepositoryLinkId"
               AND source_version."id" =
                   material_entry."githubSourceVersionId"
               AND source_version."projectSourceId" =
                   material_entry."projectSourceId"
              JOIN "ProjectSource" AS source
                ON source."projectId" = source_version."projectId"
               AND source."id" = source_version."projectSourceId"
              WHERE material_entry."projectId" = snapshot."projectId"
                AND material_entry."projectRepositoryLinkId" =
                    snapshot."projectRepositoryLinkId"
                AND material_entry."repositoryMaterialGenerationId" =
                    snapshot."repositoryMaterialGenerationId"
                AND (
                    source."kind"::text = 'mcp'
                    OR source."retiredAt" IS NOT NULL
                )
          )
    );
$$;

-- Model grant timestamps are stored as UTC civil TIMESTAMP(3) values. Patch
-- the still-active historical trigger functions in place so their liveness
-- checks never coerce those values through the session TimeZone.
DO $timezone_hardening$
DECLARE
    target_name TEXT;
    definition TEXT;
BEGIN
    FOREACH target_name IN ARRAY ARRAY[
        'ai_run_lifecycle_guard',
        'ai_input_source_lifecycle_guard',
        'repository_code_index_generation_guard',
        'repository_code_index_pointer_guard',
        'repository_material_index_guard',
        'repository_material_index_pointer_guard'
    ] LOOP
        SELECT pg_get_functiondef(procedure.oid)
          INTO definition
          FROM pg_proc AS procedure
          JOIN pg_namespace AS namespace
            ON namespace.oid = procedure.pronamespace
         WHERE namespace.nspname = current_schema()
           AND procedure.proname = target_name
           AND procedure.pronargs = 0;
        IF definition IS NULL OR POSITION('CURRENT_TIMESTAMP' IN definition) = 0 THEN
            RAISE EXCEPTION 'UTC grant liveness function is missing: %', target_name;
        END IF;
        EXECUTE replace(
            definition,
            'CURRENT_TIMESTAMP',
            '(clock_timestamp() AT TIME ZONE ''UTC'')::timestamp(3)'
        );
    END LOOP;
END;
$timezone_hardening$;
