ALTER TYPE "ModelProcessingGrantSourceKind" ADD VALUE 'repository_code';

ALTER TABLE "SourceChunk"
ADD COLUMN "repositoryFileRevisionId" UUID;

ALTER TABLE "IndexGeneration"
ADD COLUMN "originScope" "ContentOriginScope" NOT NULL DEFAULT 'project',
ADD COLUMN "projectRepositoryLinkId" UUID;

ALTER TABLE "IndexGenerationInputEntry"
ADD COLUMN "originScope" "ContentOriginScope";

UPDATE "IndexGenerationInputEntry"
SET "originScope" = 'project'
WHERE "originScope" IS NULL;

ALTER TABLE "IndexGenerationInputEntry"
ALTER COLUMN "originScope" SET NOT NULL,
ADD COLUMN "projectRepositoryLinkId" UUID;

ALTER TABLE "ModelProcessingGrant"
ADD COLUMN "projectRepositoryLinkId" UUID,
ADD COLUMN "repositoryCodeGenerationId" UUID,
ADD COLUMN "linkConfigVersion" INTEGER,
ADD COLUMN "linkEffectivePolicyVersion" INTEGER,
ADD COLUMN "scanScopeFingerprint" VARCHAR(64),
ADD COLUMN "sourceManifestFingerprint" VARCHAR(64);

ALTER TABLE "SourceChunk"
DROP CONSTRAINT "SourceChunk_origin_check",
DROP CONSTRAINT "SourceChunk_state_check";

ALTER TABLE "SourceChunk"
ADD CONSTRAINT "SourceChunk_origin_check" CHECK (
    (
        "originScope" = 'project'
        AND "projectRepositoryLinkId" IS NULL
        AND "projectSourceId" IS NOT NULL
        AND "sourceRevisionKey" IS NOT NULL
        AND "repositoryFileRevisionId" IS NULL
    )
    OR (
        "originScope" = 'repository_link'
        AND "projectRepositoryLinkId" IS NOT NULL
        AND "projectSourceId" IS NULL
        AND "sourceRevisionKey" IS NULL
        AND "repositoryFileRevisionId" IS NOT NULL
    )
),
ADD CONSTRAINT "SourceChunk_state_check" CHECK (
    (
        "state" = 'active'
        AND "sourceContentHash" ~ '^[0-9a-f]{64}$'
        AND (
            (
                "originScope" = 'project'
                AND "rangeUnit" = 'utf8_byte'
                AND "rangeStart" >= 0
                AND "rangeEnd" > "rangeStart"
                AND "rangeEnd" - "rangeStart" = "contentBytes"
            )
            OR (
                "originScope" = 'repository_link'
                AND "rangeUnit" = 'line'
                AND "rangeStart" >= 1
                AND "rangeEnd" > "rangeStart"
            )
        )
        AND "contentText" IS NOT NULL
        AND octet_length("contentText") > 0
        AND "contentHash" ~ '^[0-9a-f]{64}$'
        AND "contentBytes" = octet_length("contentText")
        AND "purgedAt" IS NULL
        AND "deletionReceipt" IS NULL
    )
    OR (
        "state" = 'purged'
        AND "sourceContentHash" IS NULL
        AND "contentText" IS NULL
        AND "contentHash" IS NULL
        AND "contentBytes" IS NULL
        AND "purgedAt" IS NOT NULL
        AND "deletionReceipt" IS NOT NULL
    )
);

ALTER TABLE "IndexGeneration"
ADD CONSTRAINT "IndexGeneration_scope_check" CHECK (
    (
        "kind" = 'project_corpus'
        AND "originScope" = 'project'
        AND "projectRepositoryLinkId" IS NULL
    )
    OR (
        "kind" IN ('repository_material', 'repository_code')
        AND "originScope" = 'repository_link'
        AND "projectRepositoryLinkId" IS NOT NULL
    )
);

ALTER TABLE "IndexGenerationInputEntry"
ADD CONSTRAINT "IndexGenerationInputEntry_scope_check" CHECK (
    (
        "entryKind" = 'project_corpus'
        AND "originScope" = 'project'
        AND "projectRepositoryLinkId" IS NULL
    )
    OR (
        "entryKind" IN ('repository_material', 'repository_code')
        AND "originScope" = 'repository_link'
        AND "projectRepositoryLinkId" IS NOT NULL
    )
);

ALTER TABLE "ModelProcessingGrant"
ADD CONSTRAINT "ModelProcessingGrant_subject_check" CHECK (
    (
        "sourceKind" = 'manual_text'
        AND "projectRepositoryLinkId" IS NULL
        AND "repositoryCodeGenerationId" IS NULL
        AND "linkConfigVersion" IS NULL
        AND "linkEffectivePolicyVersion" IS NULL
        AND "scanScopeFingerprint" IS NULL
        AND "sourceManifestFingerprint" IS NULL
    )
    OR (
        "sourceKind" = 'repository_code'
        AND "projectRepositoryLinkId" IS NOT NULL
        AND "repositoryCodeGenerationId" IS NOT NULL
        AND "linkConfigVersion" > 0
        AND "linkEffectivePolicyVersion" > 0
        AND "scanScopeFingerprint" ~ '^[0-9a-f]{64}$'
        AND "sourceManifestFingerprint" ~ '^[0-9a-f]{64}$'
    )
);

CREATE UNIQUE INDEX "SourceChunk_repository_revision_id_key"
ON "SourceChunk"(
    "projectId", "projectRepositoryLinkId", "repositoryFileRevisionId", "id"
);

CREATE UNIQUE INDEX "SourceChunk_repository_active_range_key"
ON "SourceChunk"(
    "projectId", "projectRepositoryLinkId", "repositoryFileRevisionId",
    "rangeUnit", "rangeStart", "rangeEnd", "chunkerVersion", "contentHash"
)
WHERE "state" = 'active' AND "originScope" = 'repository_link';

CREATE UNIQUE INDEX "SourceChunk_repository_active_ordinal_key"
ON "SourceChunk"(
    "projectId", "projectRepositoryLinkId", "repositoryFileRevisionId",
    "chunkerVersion", "ordinal"
)
WHERE "state" = 'active' AND "originScope" = 'repository_link';

CREATE UNIQUE INDEX "IndexGeneration_projectId_id_originScope_key"
ON "IndexGeneration"("projectId", "id", "originScope");

CREATE UNIQUE INDEX "IndexGeneration_scope_link_key"
ON "IndexGeneration"(
    "projectId", "id", "originScope", "projectRepositoryLinkId"
);

CREATE UNIQUE INDEX "IndexGeneration_repository_link_id_key"
ON "IndexGeneration"("projectId", "projectRepositoryLinkId", "id");

CREATE UNIQUE INDEX "IndexGeneration_repository_grant_policy_key"
ON "IndexGeneration"(
    "projectId", "projectRepositoryLinkId", "id", "grantId", "policyRevisionId"
);

CREATE UNIQUE INDEX "IndexGenerationInputEntry_scope_link_key"
ON "IndexGenerationInputEntry"(
    "projectId", "indexGenerationId", "id", "sourceChunkId",
    "originScope", "projectRepositoryLinkId"
);

CREATE UNIQUE INDEX "ModelProcessingGrant_repository_subject_key"
ON "ModelProcessingGrant"(
    "projectId", "id", "projectRepositoryLinkId", "repositoryCodeGenerationId"
);

CREATE UNIQUE INDEX "RepositoryCodeGenerationEntry_exact_member_key"
ON "RepositoryCodeGenerationEntry"(
    "projectId", "projectRepositoryLinkId", "repositoryCodeGenerationId",
    "id", "repositoryFileRevisionId"
);

ALTER TABLE "IndexGenerationInputEntry"
DROP CONSTRAINT "IndexGenerationInputEntry_index_fkey",
DROP CONSTRAINT "IndexGenerationInputEntry_source_chunk_fkey";

ALTER TABLE "SourceChunk"
ADD CONSTRAINT "SourceChunk_repository_revision_fkey"
FOREIGN KEY ("projectId", "projectRepositoryLinkId", "repositoryFileRevisionId")
REFERENCES "RepositoryFileRevision"("projectId", "projectRepositoryLinkId", "id")
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "IndexGeneration"
ADD CONSTRAINT "IndexGeneration_repository_link_fkey"
FOREIGN KEY ("projectId", "projectRepositoryLinkId")
REFERENCES "ProjectRepositoryLink"("projectId", "id")
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "IndexGenerationInputEntry"
ADD CONSTRAINT "IndexGenerationInputEntry_index_fkey"
FOREIGN KEY ("projectId", "indexGenerationId", "originScope")
REFERENCES "IndexGeneration"("projectId", "id", "originScope")
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
-- MATCH SIMPLE skips a composite foreign key when its nullable link is NULL.
-- Keep the three-column relation for project inputs and the four-column
-- relation for repository inputs so both scopes retain database enforcement.
ADD CONSTRAINT "IndexGenerationInputEntry_index_scope_link_fkey"
FOREIGN KEY (
    "projectId", "indexGenerationId", "originScope", "projectRepositoryLinkId"
)
REFERENCES "IndexGeneration"(
    "projectId", "id", "originScope", "projectRepositoryLinkId"
)
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
ADD CONSTRAINT "IndexGenerationInputEntry_source_chunk_fkey"
FOREIGN KEY ("projectId", "sourceChunkId", "originScope")
REFERENCES "SourceChunk"("projectId", "id", "originScope")
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
ADD CONSTRAINT "IndexGenerationInputEntry_chunk_scope_link_fkey"
FOREIGN KEY (
    "projectId", "sourceChunkId", "originScope", "projectRepositoryLinkId"
)
REFERENCES "SourceChunk"(
    "projectId", "id", "originScope", "projectRepositoryLinkId"
)
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "ModelProcessingGrant"
ADD CONSTRAINT "ModelProcessingGrant_repository_link_fkey"
FOREIGN KEY ("projectId", "projectRepositoryLinkId")
REFERENCES "ProjectRepositoryLink"("projectId", "id")
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
ADD CONSTRAINT "ModelProcessingGrant_repository_code_generation_fkey"
FOREIGN KEY (
    "projectId", "projectRepositoryLinkId", "repositoryCodeGenerationId"
)
REFERENCES "RepositoryCodeGeneration"(
    "projectId", "projectRepositoryLinkId", "id"
)
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE "RepositoryCodeIndexGeneration" (
    "projectId" UUID NOT NULL,
    "projectRepositoryLinkId" UUID NOT NULL,
    "indexGenerationId" UUID NOT NULL,
    "repositoryCodeGenerationId" UUID NOT NULL,
    "expectedActiveIndexGenerationId" UUID,
    "linkConfigVersion" INTEGER NOT NULL,
    "grantId" UUID NOT NULL,
    "policyRevisionId" UUID NOT NULL,
    "effectivePolicyVersion" INTEGER NOT NULL,
    "chunkerVersion" VARCHAR(128) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RepositoryCodeIndexGeneration_pkey"
        PRIMARY KEY ("projectId", "projectRepositoryLinkId", "indexGenerationId"),
    CONSTRAINT "RepositoryCodeIndexGeneration_chunker_check" CHECK (
        "chunkerVersion" ~ '^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$'
    )
);

CREATE UNIQUE INDEX "RepositoryCodeIndexGeneration_project_index_key"
ON "RepositoryCodeIndexGeneration"("projectId", "indexGenerationId");
CREATE UNIQUE INDEX "RepositoryCodeIndexGeneration_index_grant_policy_key"
ON "RepositoryCodeIndexGeneration"(
    "projectId", "projectRepositoryLinkId", "indexGenerationId",
    "grantId", "policyRevisionId"
);
CREATE UNIQUE INDEX "RepositoryCodeIndexGeneration_exact_input_key"
ON "RepositoryCodeIndexGeneration"(
    "projectId", "projectRepositoryLinkId", "indexGenerationId",
    "repositoryCodeGenerationId"
);
CREATE UNIQUE INDEX "RepositoryCodeIndexGeneration_exact_boundary_key"
ON "RepositoryCodeIndexGeneration"(
    "projectId", "projectRepositoryLinkId", "indexGenerationId",
    "repositoryCodeGenerationId", "linkConfigVersion", "effectivePolicyVersion"
);
CREATE INDEX "RepositoryCodeIndexGeneration_code_generation_idx"
ON "RepositoryCodeIndexGeneration"(
    "projectId", "projectRepositoryLinkId", "repositoryCodeGenerationId"
);

CREATE TABLE "RepositoryCodeIndexInput" (
    "projectId" UUID NOT NULL,
    "projectRepositoryLinkId" UUID NOT NULL,
    "indexGenerationId" UUID NOT NULL,
    "inputEntryId" UUID NOT NULL,
    "repositoryCodeGenerationId" UUID NOT NULL,
    "codeGenerationEntryId" UUID NOT NULL,
    "repositoryFileRevisionId" UUID NOT NULL,
    "sourceChunkId" UUID NOT NULL,
    "originScope" "ContentOriginScope" NOT NULL DEFAULT 'repository_link',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RepositoryCodeIndexInput_pkey"
        PRIMARY KEY (
            "projectId", "projectRepositoryLinkId", "indexGenerationId", "inputEntryId"
        ),
    CONSTRAINT "RepositoryCodeIndexInput_scope_check" CHECK (
        "originScope" = 'repository_link'
    )
);

CREATE UNIQUE INDEX "RepositoryCodeIndexInput_project_input_key"
ON "RepositoryCodeIndexInput"("projectId", "indexGenerationId", "inputEntryId");
CREATE UNIQUE INDEX "RepositoryCodeIndexInput_input_scope_key"
ON "RepositoryCodeIndexInput"(
    "projectId", "indexGenerationId", "inputEntryId", "sourceChunkId",
    "originScope", "projectRepositoryLinkId"
);
CREATE UNIQUE INDEX "RepositoryCodeIndexInput_exact_member_key"
ON "RepositoryCodeIndexInput"(
    "projectId", "projectRepositoryLinkId", "indexGenerationId",
    "codeGenerationEntryId", "sourceChunkId"
);
CREATE INDEX "RepositoryCodeIndexInput_revision_idx"
ON "RepositoryCodeIndexInput"(
    "projectId", "projectRepositoryLinkId", "repositoryFileRevisionId"
);

CREATE TABLE "RepositoryCodeIndexPointer" (
    "projectId" UUID NOT NULL,
    "projectRepositoryLinkId" UUID NOT NULL,
    "indexGenerationId" UUID NOT NULL,
    "repositoryCodeGenerationId" UUID NOT NULL,
    "linkConfigVersion" INTEGER NOT NULL,
    "effectivePolicyVersion" INTEGER NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RepositoryCodeIndexPointer_pkey"
        PRIMARY KEY ("projectId", "projectRepositoryLinkId")
);

CREATE UNIQUE INDEX "RepositoryCodeIndexPointer_project_index_key"
ON "RepositoryCodeIndexPointer"("projectId", "indexGenerationId");
CREATE UNIQUE INDEX "RepositoryCodeIndexPointer_exact_generation_key"
ON "RepositoryCodeIndexPointer"(
    "projectId", "projectRepositoryLinkId", "indexGenerationId",
    "repositoryCodeGenerationId", "linkConfigVersion", "effectivePolicyVersion"
);

ALTER TABLE "RepositoryCodeIndexGeneration"
ADD CONSTRAINT "RepositoryCodeIndexGeneration_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "Project"("id")
ON DELETE CASCADE ON UPDATE CASCADE,
ADD CONSTRAINT "RepositoryCodeIndexGeneration_link_fkey"
FOREIGN KEY ("projectId", "projectRepositoryLinkId")
REFERENCES "ProjectRepositoryLink"("projectId", "id")
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
ADD CONSTRAINT "RepositoryCodeIndexGeneration_config_fkey"
FOREIGN KEY (
    "projectId", "projectRepositoryLinkId", "linkConfigVersion", "effectivePolicyVersion"
)
REFERENCES "ProjectRepositoryLinkConfigVersion"(
    "projectId", "projectRepositoryLinkId", "version", "effectivePolicyVersion"
)
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
ADD CONSTRAINT "RepositoryCodeIndexGeneration_index_fkey"
FOREIGN KEY (
    "projectId", "projectRepositoryLinkId", "indexGenerationId",
    "grantId", "policyRevisionId"
)
REFERENCES "IndexGeneration"(
    "projectId", "projectRepositoryLinkId", "id", "grantId", "policyRevisionId"
)
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
ADD CONSTRAINT "RepositoryCodeIndexGeneration_code_generation_fkey"
FOREIGN KEY (
    "projectId", "projectRepositoryLinkId", "repositoryCodeGenerationId"
)
REFERENCES "RepositoryCodeGeneration"(
    "projectId", "projectRepositoryLinkId", "id"
)
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
ADD CONSTRAINT "RepositoryCodeIndexGeneration_expected_index_fkey"
FOREIGN KEY (
    "projectId", "projectRepositoryLinkId", "expectedActiveIndexGenerationId"
)
REFERENCES "IndexGeneration"(
    "projectId", "projectRepositoryLinkId", "id"
)
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
ADD CONSTRAINT "RepositoryCodeIndexGeneration_grant_fkey"
FOREIGN KEY (
    "projectId", "grantId", "projectRepositoryLinkId", "repositoryCodeGenerationId"
)
REFERENCES "ModelProcessingGrant"(
    "projectId", "id", "projectRepositoryLinkId", "repositoryCodeGenerationId"
)
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "RepositoryCodeIndexInput"
ADD CONSTRAINT "RepositoryCodeIndexInput_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "Project"("id")
ON DELETE CASCADE ON UPDATE CASCADE,
ADD CONSTRAINT "RepositoryCodeIndexInput_link_fkey"
FOREIGN KEY ("projectId", "projectRepositoryLinkId")
REFERENCES "ProjectRepositoryLink"("projectId", "id")
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
ADD CONSTRAINT "RepositoryCodeIndexInput_index_fkey"
FOREIGN KEY (
    "projectId", "projectRepositoryLinkId", "indexGenerationId",
    "repositoryCodeGenerationId"
)
REFERENCES "RepositoryCodeIndexGeneration"(
    "projectId", "projectRepositoryLinkId", "indexGenerationId",
    "repositoryCodeGenerationId"
)
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
ADD CONSTRAINT "RepositoryCodeIndexInput_input_entry_fkey"
FOREIGN KEY (
    "projectId", "indexGenerationId", "inputEntryId", "sourceChunkId",
    "originScope", "projectRepositoryLinkId"
)
REFERENCES "IndexGenerationInputEntry"(
    "projectId", "indexGenerationId", "id", "sourceChunkId",
    "originScope", "projectRepositoryLinkId"
)
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
ADD CONSTRAINT "RepositoryCodeIndexInput_code_entry_fkey"
FOREIGN KEY (
    "projectId", "projectRepositoryLinkId", "repositoryCodeGenerationId",
    "codeGenerationEntryId", "repositoryFileRevisionId"
)
REFERENCES "RepositoryCodeGenerationEntry"(
    "projectId", "projectRepositoryLinkId", "repositoryCodeGenerationId",
    "id", "repositoryFileRevisionId"
)
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
ADD CONSTRAINT "RepositoryCodeIndexInput_revision_fkey"
FOREIGN KEY (
    "projectId", "projectRepositoryLinkId", "repositoryFileRevisionId"
)
REFERENCES "RepositoryFileRevision"(
    "projectId", "projectRepositoryLinkId", "id"
)
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
ADD CONSTRAINT "RepositoryCodeIndexInput_chunk_fkey"
FOREIGN KEY (
    "projectId", "projectRepositoryLinkId", "repositoryFileRevisionId", "sourceChunkId"
)
REFERENCES "SourceChunk"(
    "projectId", "projectRepositoryLinkId", "repositoryFileRevisionId", "id"
)
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "RepositoryCodeIndexPointer"
ADD CONSTRAINT "RepositoryCodeIndexPointer_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "Project"("id")
ON DELETE CASCADE ON UPDATE CASCADE,
ADD CONSTRAINT "RepositoryCodeIndexPointer_link_fkey"
FOREIGN KEY ("projectId", "projectRepositoryLinkId")
REFERENCES "ProjectRepositoryLink"("projectId", "id")
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
ADD CONSTRAINT "RepositoryCodeIndexPointer_config_fkey"
FOREIGN KEY (
    "projectId", "projectRepositoryLinkId", "linkConfigVersion", "effectivePolicyVersion"
)
REFERENCES "ProjectRepositoryLinkConfigVersion"(
    "projectId", "projectRepositoryLinkId", "version", "effectivePolicyVersion"
)
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
ADD CONSTRAINT "RepositoryCodeIndexPointer_index_fkey"
FOREIGN KEY ("projectId", "indexGenerationId")
REFERENCES "IndexGeneration"("projectId", "id")
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
ADD CONSTRAINT "RepositoryCodeIndexPointer_generation_fkey"
FOREIGN KEY (
    "projectId", "projectRepositoryLinkId", "indexGenerationId",
    "repositoryCodeGenerationId", "linkConfigVersion", "effectivePolicyVersion"
)
REFERENCES "RepositoryCodeIndexGeneration"(
    "projectId", "projectRepositoryLinkId", "indexGenerationId",
    "repositoryCodeGenerationId", "linkConfigVersion", "effectivePolicyVersion"
)
ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

CREATE OR REPLACE FUNCTION "source_chunk_lifecycle_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    source_content TEXT;
    source_revision UUID;
    source_hash TEXT;
    source_line_count INTEGER;
    expected_code_text TEXT;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."state" <> 'active' THEN
            RAISE EXCEPTION 'new source chunk must be active'
                USING ERRCODE = 'check_violation';
        END IF;

        IF NEW."originScope" = 'project' THEN
            IF NEW."rangeUnit" <> 'utf8_byte' THEN
                RAISE EXCEPTION 'project source chunk must use byte ranges'
                    USING ERRCODE = 'check_violation';
            END IF;
            SELECT s."contentText", s."revisionKey", s."contentHash"
            INTO source_content, source_revision, source_hash
            FROM "ProjectSource" AS s
            WHERE s."projectId" = NEW."projectId"
              AND s."id" = NEW."projectSourceId"
              AND s."originScope" = NEW."originScope"
            FOR KEY SHARE;

            IF NOT FOUND
                OR NEW."sourceRevisionKey" IS DISTINCT FROM source_revision
                OR NEW."sourceContentHash" IS DISTINCT FROM source_hash
                OR NEW."contentHash" IS DISTINCT FROM
                    encode(sha256(convert_to(NEW."contentText", 'UTF8')), 'hex')
                OR substring(
                    convert_to(source_content, 'UTF8')
                    FROM NEW."rangeStart" + 1
                    FOR NEW."rangeEnd" - NEW."rangeStart"
                ) IS DISTINCT FROM convert_to(NEW."contentText", 'UTF8') THEN
                RAISE EXCEPTION 'source chunk does not match source revision bytes'
                    USING ERRCODE = 'check_violation';
            END IF;
            RETURN NEW;
        END IF;

        IF NEW."originScope" <> 'repository_link' OR NEW."rangeUnit" <> 'line' THEN
            RAISE EXCEPTION 'repository code chunk must use line ranges'
                USING ERRCODE = 'check_violation';
        END IF;

        SELECT r."contentText", r."contentHash", r."lineCount"
        INTO source_content, source_hash, source_line_count
        FROM "RepositoryFileRevision" AS r
        WHERE r."projectId" = NEW."projectId"
          AND r."projectRepositoryLinkId" = NEW."projectRepositoryLinkId"
          AND r."id" = NEW."repositoryFileRevisionId"
        FOR KEY SHARE;

        SELECT string_agg((match)[1], '' ORDER BY ordinal)
        INTO expected_code_text
        FROM regexp_matches(source_content, E'([^\\n]*\\n|[^\\n]+$)', 'g')
            WITH ORDINALITY AS lines(match, ordinal)
        WHERE ordinal >= NEW."rangeStart" AND ordinal < NEW."rangeEnd";

        IF source_hash IS NULL
            OR NEW."sourceContentHash" IS DISTINCT FROM source_hash
            OR NEW."rangeEnd" > source_line_count + 1
            OR expected_code_text IS DISTINCT FROM NEW."contentText"
            OR NEW."contentHash" IS DISTINCT FROM
                encode(sha256(convert_to(NEW."contentText", 'UTF8')), 'hex') THEN
            RAISE EXCEPTION 'repository chunk does not match file revision lines'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;

    IF EXISTS (SELECT 1 FROM "Project" WHERE "id" = OLD."projectId") THEN
        RAISE EXCEPTION 'source chunk is immutable'
            USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "ai_grant_lifecycle_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."status" <> 'draft'
            OR NEW."issuedAt" IS NOT NULL
            OR NEW."expiresAt" IS NOT NULL
            OR NEW."revokedAt" IS NOT NULL
            OR NEW."revocationReasonCode" IS NOT NULL THEN
            RAISE EXCEPTION 'grant must start in draft' USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;

    IF NEW."id" IS DISTINCT FROM OLD."id"
        OR NEW."projectId" IS DISTINCT FROM OLD."projectId" THEN
        RAISE EXCEPTION 'grant identity is immutable' USING ERRCODE = 'check_violation';
    END IF;

    IF OLD."status" = 'draft' THEN
        IF NEW."status" = 'draft' THEN
            IF NEW."issuedAt" IS NOT NULL OR NEW."expiresAt" IS NOT NULL
                OR NEW."revokedAt" IS NOT NULL
                OR NEW."revocationReasonCode" IS NOT NULL THEN
                RAISE EXCEPTION 'draft grant has lifecycle fields' USING ERRCODE = 'check_violation';
            END IF;
            RETURN NEW;
        END IF;
        IF NEW."status" <> 'issued' OR NEW."issuedAt" IS NULL
            OR NEW."expiresAt" IS NULL OR NEW."revokedAt" IS NOT NULL
            OR NEW."revocationReasonCode" IS NOT NULL THEN
            RAISE EXCEPTION 'invalid grant lifecycle transition' USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;

    IF OLD."status" = 'issued' THEN
        IF ROW(
            NEW."id", NEW."projectId", NEW."sourceKind",
            NEW."projectRepositoryLinkId", NEW."repositoryCodeGenerationId",
            NEW."linkConfigVersion", NEW."linkEffectivePolicyVersion",
            NEW."scanScopeFingerprint",
            NEW."sourceManifestFingerprint", NEW."policyRevisionId",
            NEW."profileFingerprint", NEW."providerFingerprint", NEW."modelFingerprint",
            NEW."modelId", NEW."processorFingerprint", NEW."regionFingerprint",
            NEW."retentionFingerprint", NEW."endpointFingerprint", NEW."grantFingerprint",
            NEW."effectivePolicyVersion", NEW."budgetFingerprint", NEW."scannerFingerprint",
            NEW."scannerVersion", NEW."budgetProfile", NEW."issuedBy", NEW."purposeCode",
            NEW."issuedAt", NEW."expiresAt", NEW."createdAt"
        ) IS DISTINCT FROM ROW(
            OLD."id", OLD."projectId", OLD."sourceKind",
            OLD."projectRepositoryLinkId", OLD."repositoryCodeGenerationId",
            OLD."linkConfigVersion", OLD."linkEffectivePolicyVersion",
            OLD."scanScopeFingerprint",
            OLD."sourceManifestFingerprint", OLD."policyRevisionId",
            OLD."profileFingerprint", OLD."providerFingerprint", OLD."modelFingerprint",
            OLD."modelId", OLD."processorFingerprint", OLD."regionFingerprint",
            OLD."retentionFingerprint", OLD."endpointFingerprint", OLD."grantFingerprint",
            OLD."effectivePolicyVersion", OLD."budgetFingerprint", OLD."scannerFingerprint",
            OLD."scannerVersion", OLD."budgetProfile", OLD."issuedBy", OLD."purposeCode",
            OLD."issuedAt", OLD."expiresAt", OLD."createdAt"
        ) THEN
            RAISE EXCEPTION 'issued grant is sealed' USING ERRCODE = 'check_violation';
        END IF;
        IF NEW."status" = 'issued' THEN
            IF NEW."revokedAt" IS NOT NULL OR NEW."revocationReasonCode" IS NOT NULL THEN
                RAISE EXCEPTION 'issued grant has revocation fields' USING ERRCODE = 'check_violation';
            END IF;
            RETURN NEW;
        END IF;
        IF NEW."status" = 'revoked'
            AND NEW."revokedAt" IS NOT NULL
            AND NEW."revokedAt" >= NEW."issuedAt"
            AND NEW."revocationReasonCode" IS NOT NULL THEN
            RETURN NEW;
        END IF;
        RAISE EXCEPTION 'invalid grant lifecycle transition' USING ERRCODE = 'check_violation';
    END IF;

    RAISE EXCEPTION 'revoked grant is immutable' USING ERRCODE = 'check_violation';
END;
$$;

CREATE OR REPLACE FUNCTION "ai_grant_scope_draft_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_project_id UUID;
    target_grant_id UUID;
    grant_status "ModelProcessingGrantStatus";
    grant_source_kind "ModelProcessingGrantSourceKind";
    operation_allowed BOOLEAN;
BEGIN
    IF TG_OP = 'DELETE' THEN
        target_project_id := OLD."projectId";
        target_grant_id := OLD."grantId";
    ELSE
        target_project_id := NEW."projectId";
        target_grant_id := NEW."grantId";
    END IF;

    IF TG_OP = 'UPDATE'
        AND (NEW."projectId" IS DISTINCT FROM OLD."projectId"
            OR NEW."grantId" IS DISTINCT FROM OLD."grantId") THEN
        RAISE EXCEPTION 'grant scope identity is immutable' USING ERRCODE = 'check_violation';
    END IF;

    SELECT "status", "sourceKind" INTO grant_status, grant_source_kind
    FROM "ModelProcessingGrant"
    WHERE "projectId" = target_project_id AND "id" = target_grant_id;

    IF grant_status IS NULL THEN
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
    END IF;
    IF grant_status IS DISTINCT FROM 'draft' THEN
        RAISE EXCEPTION 'grant scope is sealed' USING ERRCODE = 'check_violation';
    END IF;

    IF TG_TABLE_NAME = 'ModelProcessingGrantSource'
        AND TG_OP <> 'DELETE'
        AND grant_source_kind IS DISTINCT FROM 'manual_text' THEN
        RAISE EXCEPTION 'repository grant cannot contain manual sources'
            USING ERRCODE = 'check_violation';
    END IF;

    IF TG_TABLE_NAME = 'ModelProcessingGrantOperation' AND TG_OP <> 'DELETE' THEN
        IF grant_source_kind = 'repository_code' AND NEW."operation" = 'autoExtract' THEN
            RAISE EXCEPTION 'raw repository code cannot be auto extracted'
                USING ERRCODE = 'check_violation';
        END IF;
        SELECT CASE NEW."operation"
            WHEN 'embedding' THEN r."embeddingEnabled"
            WHEN 'autoExtract' THEN r."autoExtractEnabled"
            WHEN 'sourceSummary' THEN r."sourceSummaryEnabled"
            WHEN 'projectAnalysis' THEN r."projectAnalysisEnabled"
            WHEN 'generateWithContext' THEN r."generateWithContextEnabled"
            ELSE FALSE
        END
        INTO operation_allowed
        FROM "ModelProcessingGrant" AS g
        JOIN "ProjectAiPolicyRevision" AS r
          ON r."projectId" = g."projectId" AND r."id" = g."policyRevisionId"
        WHERE g."projectId" = NEW."projectId" AND g."id" = NEW."grantId";
        IF operation_allowed IS NOT TRUE THEN
            RAISE EXCEPTION 'grant operation is not allowed by policy'
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "ai_grant_issuance_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    current_revision_id UUID;
    current_outbound_enabled BOOLEAN;
    repository_scope_valid BOOLEAN;
BEGIN
    IF TG_OP <> 'UPDATE' OR OLD."status" <> 'draft' OR NEW."status" <> 'issued' THEN
        RETURN NEW;
    END IF;

    SELECT p."currentRevisionId", r."outboundEnabled"
    INTO current_revision_id, current_outbound_enabled
    FROM "ProjectAiPolicy" AS p
    JOIN "ProjectAiPolicyRevision" AS r
      ON r."projectId" = p."projectId" AND r."id" = p."currentRevisionId"
    WHERE p."projectId" = NEW."projectId";

    IF current_revision_id IS NULL
        OR NEW."policyRevisionId" IS DISTINCT FROM current_revision_id
        OR current_outbound_enabled IS NOT TRUE THEN
        RAISE EXCEPTION 'grant policy is not issuable' USING ERRCODE = 'check_violation';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM "ModelProcessingGrantOperation"
        WHERE "projectId" = NEW."projectId" AND "grantId" = NEW."id"
    ) THEN
        RAISE EXCEPTION 'grant operation scope is incomplete' USING ERRCODE = 'check_violation';
    END IF;

    IF NEW."sourceKind" = 'manual_text' THEN
        IF NOT EXISTS (
            SELECT 1 FROM "ModelProcessingGrantSource"
            WHERE "projectId" = NEW."projectId" AND "grantId" = NEW."id"
        ) THEN
            RAISE EXCEPTION 'manual grant source scope is incomplete'
                USING ERRCODE = 'check_violation';
        END IF;
    ELSE
        IF EXISTS (
            SELECT 1 FROM "ModelProcessingGrantSource"
            WHERE "projectId" = NEW."projectId" AND "grantId" = NEW."id"
        ) OR EXISTS (
            SELECT 1 FROM "ModelProcessingGrantOperation"
            WHERE "projectId" = NEW."projectId" AND "grantId" = NEW."id"
              AND "operation" = 'autoExtract'
        ) THEN
            RAISE EXCEPTION 'repository grant scope is invalid'
                USING ERRCODE = 'check_violation';
        END IF;

        SELECT EXISTS (
            SELECT 1
            FROM "ProjectRepositoryLink" AS link
            JOIN "ProjectRepositoryLinkConfigPointer" AS config_pointer
              ON config_pointer."projectId" = link."projectId"
             AND config_pointer."projectRepositoryLinkId" = link."id"
            JOIN "RepositoryCodeGenerationPointer" AS code_pointer
              ON code_pointer."projectId" = link."projectId"
             AND code_pointer."projectRepositoryLinkId" = link."id"
            JOIN "RepositoryCodeGeneration" AS generation
              ON generation."projectId" = code_pointer."projectId"
             AND generation."projectRepositoryLinkId" = code_pointer."projectRepositoryLinkId"
             AND generation."id" = code_pointer."repositoryCodeGenerationId"
            JOIN "ProjectRepositoryLinkConfigVersion" AS config
              ON config."projectId" = config_pointer."projectId"
             AND config."projectRepositoryLinkId" = config_pointer."projectRepositoryLinkId"
             AND config."version" = config_pointer."configVersion"
             AND config."effectivePolicyVersion" = config_pointer."effectivePolicyVersion"
            WHERE link."projectId" = NEW."projectId"
              AND link."id" = NEW."projectRepositoryLinkId"
              AND link."status" = 'active'
              AND link."effectivePolicyVersion" = NEW."linkEffectivePolicyVersion"
              AND config_pointer."configVersion" = NEW."linkConfigVersion"
              AND config_pointer."effectivePolicyVersion" = NEW."linkEffectivePolicyVersion"
              AND code_pointer."repositoryCodeGenerationId" = NEW."repositoryCodeGenerationId"
              AND code_pointer."linkConfigVersion" = NEW."linkConfigVersion"
              AND code_pointer."effectivePolicyVersion" = NEW."linkEffectivePolicyVersion"
              AND generation."status" = 'code_ready'
              AND generation."modelTransferScanResult" = 'passed'
              AND config."codeEnabled" = TRUE
              AND config."scanScopeFingerprint" = generation."scanScopeFingerprint"
              AND generation."scanScopeFingerprint" = NEW."scanScopeFingerprint"
              AND generation."manifestFingerprint" = NEW."sourceManifestFingerprint"
        ) INTO repository_scope_valid;
        IF repository_scope_valid IS NOT TRUE THEN
            RAISE EXCEPTION 'repository grant scope is not eligible'
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM "ModelProcessingGrantOperation" AS op
        JOIN "ProjectAiPolicyRevision" AS r
          ON r."projectId" = NEW."projectId" AND r."id" = NEW."policyRevisionId"
        WHERE op."projectId" = NEW."projectId" AND op."grantId" = NEW."id"
          AND NOT CASE op."operation"
              WHEN 'embedding' THEN r."embeddingEnabled"
              WHEN 'autoExtract' THEN r."autoExtractEnabled"
              WHEN 'sourceSummary' THEN r."sourceSummaryEnabled"
              WHEN 'projectAnalysis' THEN r."projectAnalysisEnabled"
              WHEN 'generateWithContext' THEN r."generateWithContextEnabled"
              ELSE FALSE
          END
    ) THEN
        RAISE EXCEPTION 'grant operation is not allowed by policy'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "index_input_entry_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    parent_status "IndexGenerationStatus";
    parent_kind "IndexGenerationKind";
    parent_scope "ContentOriginScope";
    parent_link UUID;
    chunk_state "SourceChunkState";
    chunk_scope "ContentOriginScope";
    chunk_link UUID;
    actual_hash TEXT;
    actual_bytes INTEGER;
BEGIN
    IF TG_OP = 'INSERT' THEN
        SELECT i."status", i."kind", i."originScope", i."projectRepositoryLinkId"
        INTO parent_status, parent_kind, parent_scope, parent_link
        FROM "IndexGeneration" AS i
        WHERE i."projectId" = NEW."projectId" AND i."id" = NEW."indexGenerationId"
        FOR KEY SHARE;
        SELECT c."state", c."originScope", c."projectRepositoryLinkId",
               c."contentHash", c."contentBytes"
        INTO chunk_state, chunk_scope, chunk_link, actual_hash, actual_bytes
        FROM "SourceChunk" AS c
        WHERE c."projectId" = NEW."projectId" AND c."id" = NEW."sourceChunkId"
        FOR KEY SHARE;
        IF parent_status IS DISTINCT FROM 'staging'
            OR parent_scope IS DISTINCT FROM NEW."originScope"
            OR parent_link IS DISTINCT FROM NEW."projectRepositoryLinkId"
            OR chunk_state IS DISTINCT FROM 'active'
            OR chunk_scope IS DISTINCT FROM NEW."originScope"
            OR chunk_link IS DISTINCT FROM NEW."projectRepositoryLinkId"
            OR (
                (parent_kind = 'project_corpus' AND NEW."entryKind" <> 'project_corpus')
                OR (parent_kind = 'repository_code' AND NEW."entryKind" <> 'repository_code')
                OR (parent_kind = 'repository_material' AND NEW."entryKind" <> 'repository_material')
            )
            OR actual_hash IS DISTINCT FROM NEW."contentHash"
            OR actual_bytes IS DISTINCT FROM NEW."contentBytes" THEN
            RAISE EXCEPTION 'index input does not match scoped active chunk'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;
    IF EXISTS (SELECT 1 FROM "Project" WHERE "id" = OLD."projectId") THEN
        RAISE EXCEPTION 'index input entry is immutable'
            USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "repository_code_index_generation_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    index_kind "IndexGenerationKind";
    index_scope "ContentOriginScope";
    index_link UUID;
    expected_inputs INTEGER;
    code_status "RepositoryCodeGenerationStatus";
    code_file_count INTEGER;
    scan_result "AiSafeScanResult";
    grant_status "ModelProcessingGrantStatus";
    grant_kind "ModelProcessingGrantSourceKind";
    grant_expires_at TIMESTAMP(3);
    current_index_generation_id UUID;
BEGIN
    IF TG_OP = 'INSERT' THEN
        PERFORM 1
        FROM "ProjectRepositoryLink" AS link
        WHERE link."projectId" = NEW."projectId"
          AND link."id" = NEW."projectRepositoryLinkId"
        FOR UPDATE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'repository code index link does not exist'
                USING ERRCODE = 'check_violation';
        END IF;
        SELECT pointer."indexGenerationId"
        INTO current_index_generation_id
        FROM "RepositoryCodeIndexPointer" AS pointer
        WHERE pointer."projectId" = NEW."projectId"
          AND pointer."projectRepositoryLinkId" = NEW."projectRepositoryLinkId";
        IF NEW."expectedActiveIndexGenerationId" IS DISTINCT FROM current_index_generation_id THEN
            RAISE EXCEPTION 'repository code index expected pointer is stale'
                USING ERRCODE = 'serialization_failure';
        END IF;
        SELECT i."kind", i."originScope", i."projectRepositoryLinkId", i."expectedInputCount"
        INTO index_kind, index_scope, index_link, expected_inputs
        FROM "IndexGeneration" AS i
        WHERE i."projectId" = NEW."projectId" AND i."id" = NEW."indexGenerationId"
        FOR KEY SHARE;
        SELECT g."status", g."fileCount", g."modelTransferScanResult"
        INTO code_status, code_file_count, scan_result
        FROM "RepositoryCodeGeneration" AS g
        WHERE g."projectId" = NEW."projectId"
          AND g."projectRepositoryLinkId" = NEW."projectRepositoryLinkId"
          AND g."id" = NEW."repositoryCodeGenerationId"
        FOR KEY SHARE;
        SELECT grant_row."status", grant_row."sourceKind", grant_row."expiresAt"
        INTO grant_status, grant_kind, grant_expires_at
        FROM "ModelProcessingGrant" AS grant_row
        WHERE grant_row."projectId" = NEW."projectId" AND grant_row."id" = NEW."grantId"
        FOR KEY SHARE;
        IF index_kind IS DISTINCT FROM 'repository_code'
            OR index_scope IS DISTINCT FROM 'repository_link'
            OR index_link IS DISTINCT FROM NEW."projectRepositoryLinkId"
            OR code_status IS DISTINCT FROM 'code_ready'
            OR scan_result IS DISTINCT FROM 'passed'
            OR code_file_count < 1
            OR expected_inputs < code_file_count
            OR grant_status IS DISTINCT FROM 'issued'
            OR grant_kind IS DISTINCT FROM 'repository_code'
            OR grant_expires_at <= CURRENT_TIMESTAMP THEN
            RAISE EXCEPTION 'repository code index parents are ineligible'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;
    IF EXISTS (SELECT 1 FROM "Project" WHERE "id" = OLD."projectId") THEN
        RAISE EXCEPTION 'repository code index generation is immutable'
            USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "RepositoryCodeIndexGeneration_lifecycle_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "RepositoryCodeIndexGeneration"
FOR EACH ROW EXECUTE FUNCTION "repository_code_index_generation_guard"();

CREATE OR REPLACE FUNCTION "repository_code_index_input_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    input_kind "IndexInputEntryKind";
    input_scope "ContentOriginScope";
    input_link UUID;
    chunk_revision UUID;
BEGIN
    IF TG_OP = 'INSERT' THEN
        SELECT e."entryKind", e."originScope", e."projectRepositoryLinkId"
        INTO input_kind, input_scope, input_link
        FROM "IndexGenerationInputEntry" AS e
        WHERE e."projectId" = NEW."projectId"
          AND e."indexGenerationId" = NEW."indexGenerationId"
          AND e."id" = NEW."inputEntryId"
        FOR KEY SHARE;
        SELECT c."repositoryFileRevisionId" INTO chunk_revision
        FROM "SourceChunk" AS c
        WHERE c."projectId" = NEW."projectId"
          AND c."id" = NEW."sourceChunkId"
        FOR KEY SHARE;
        IF input_kind IS DISTINCT FROM 'repository_code'
            OR input_scope IS DISTINCT FROM 'repository_link'
            OR input_link IS DISTINCT FROM NEW."projectRepositoryLinkId"
            OR chunk_revision IS DISTINCT FROM NEW."repositoryFileRevisionId"
            OR NEW."originScope" <> 'repository_link' THEN
            RAISE EXCEPTION 'repository code subtype does not match input'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;
    IF EXISTS (SELECT 1 FROM "Project" WHERE "id" = OLD."projectId") THEN
        RAISE EXCEPTION 'repository code index input is immutable'
            USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "RepositoryCodeIndexInput_lifecycle_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "RepositoryCodeIndexInput"
FOR EACH ROW EXECUTE FUNCTION "repository_code_index_input_guard"();

CREATE OR REPLACE FUNCTION "validate_index_input_subtype"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    project_count INTEGER;
    repository_code_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO project_count
    FROM "ProjectCorpusIndexInput" AS p
    WHERE p."projectId" = NEW."projectId"
      AND p."indexGenerationId" = NEW."indexGenerationId"
      AND p."inputEntryId" = NEW."id";
    SELECT COUNT(*) INTO repository_code_count
    FROM "RepositoryCodeIndexInput" AS r
    WHERE r."projectId" = NEW."projectId"
      AND r."indexGenerationId" = NEW."indexGenerationId"
      AND r."inputEntryId" = NEW."id";
    IF project_count + repository_code_count <> 1
        OR (NEW."entryKind" = 'project_corpus' AND project_count <> 1)
        OR (NEW."entryKind" = 'repository_code' AND repository_code_count <> 1)
        OR NEW."entryKind" = 'repository_material' THEN
        RAISE EXCEPTION 'index input requires exactly one matching concrete subtype'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "index_generation_lifecycle_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    actual_inputs BIGINT;
    actual_subtypes BIGINT;
    actual_work_items BIGINT;
    succeeded_work_items BIGINT;
    actual_embeddings BIGINT;
    actual_manifest TEXT;
    grant_kind "ModelProcessingGrantSourceKind";
    grant_link UUID;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."status" <> 'staging' THEN
            RAISE EXCEPTION 'new index generation must be staging'
                USING ERRCODE = 'check_violation';
        END IF;
        SELECT g."sourceKind", g."projectRepositoryLinkId"
        INTO grant_kind, grant_link
        FROM "ModelProcessingGrant" AS g
        WHERE g."projectId" = NEW."projectId" AND g."id" = NEW."grantId"
        FOR KEY SHARE;
        IF (NEW."kind" = 'project_corpus' AND grant_kind IS DISTINCT FROM 'manual_text')
            OR (NEW."kind" = 'repository_code'
                AND (grant_kind IS DISTINCT FROM 'repository_code'
                    OR grant_link IS DISTINCT FROM NEW."projectRepositoryLinkId")) THEN
            RAISE EXCEPTION 'index grant subject does not match generation scope'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;
    IF TG_OP = 'DELETE' THEN
        IF EXISTS (SELECT 1 FROM "Project" WHERE "id" = OLD."projectId") THEN
            RAISE EXCEPTION 'index generation is immutable'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN OLD;
    END IF;

    IF ROW(
        NEW."id", NEW."projectId", NEW."kind", NEW."originScope",
        NEW."projectRepositoryLinkId", NEW."grantId", NEW."policyRevisionId",
        NEW."embeddingProfileId", NEW."generationKey", NEW."inputManifestFingerprint",
        NEW."processingBoundaryFingerprint", NEW."expectedInputCount", NEW."createdAt"
    ) IS DISTINCT FROM ROW(
        OLD."id", OLD."projectId", OLD."kind", OLD."originScope",
        OLD."projectRepositoryLinkId", OLD."grantId", OLD."policyRevisionId",
        OLD."embeddingProfileId", OLD."generationKey", OLD."inputManifestFingerprint",
        OLD."processingBoundaryFingerprint", OLD."expectedInputCount", OLD."createdAt"
    ) THEN
        RAISE EXCEPTION 'index generation structure is immutable'
            USING ERRCODE = 'check_violation';
    END IF;

    IF OLD."status" IN (
        'rag_ready', 'rag_ready_empty', 'semantic_disabled_by_policy',
        'failed', 'cancelled', 'ineligible', 'superseded'
    ) AND NEW."status" NOT IN (OLD."status", 'superseded') THEN
        RAISE EXCEPTION 'terminal index generation cannot be reopened'
            USING ERRCODE = 'check_violation';
    ELSIF OLD."status" = 'staging'
        AND NEW."status" NOT IN (
            'staging', 'building', 'semantic_disabled_by_policy',
            'failed', 'cancelled', 'ineligible'
        ) THEN
        RAISE EXCEPTION 'invalid staging index transition'
            USING ERRCODE = 'check_violation';
    ELSIF OLD."status" IN ('building', 'unknown')
        AND NEW."status" NOT IN (
            'building', 'rag_ready', 'rag_ready_empty', 'failed',
            'unknown', 'cancelled'
        ) THEN
        RAISE EXCEPTION 'invalid active index transition'
            USING ERRCODE = 'check_violation';
    END IF;

    IF NEW."status" IN ('building', 'rag_ready', 'rag_ready_empty') THEN
        SELECT COUNT(*) INTO actual_inputs
        FROM "IndexGenerationInputEntry" AS e
        WHERE e."projectId" = NEW."projectId" AND e."indexGenerationId" = NEW."id";
        SELECT
            (SELECT COUNT(*) FROM "ProjectCorpusIndexInput" AS p
             WHERE p."projectId" = NEW."projectId" AND p."indexGenerationId" = NEW."id")
            +
            (SELECT COUNT(*) FROM "RepositoryCodeIndexInput" AS r
             WHERE r."projectId" = NEW."projectId" AND r."indexGenerationId" = NEW."id")
        INTO actual_subtypes;
        SELECT COUNT(*) INTO actual_work_items
        FROM "IndexWorkItem" AS w
        WHERE w."projectId" = NEW."projectId" AND w."indexGenerationId" = NEW."id";
        SELECT encode(sha256(convert_to(string_agg(concat_ws(E'\x1f',
            e."ordinal"::text, e."id"::text, e."sourceChunkId"::text,
            e."contentHash", e."contentBytes"::text
        ), E'\x1e' ORDER BY e."ordinal"), 'UTF8')), 'hex')
        INTO actual_manifest
        FROM "IndexGenerationInputEntry" AS e
        WHERE e."projectId" = NEW."projectId" AND e."indexGenerationId" = NEW."id";
        IF actual_inputs <> NEW."expectedInputCount"
            OR actual_subtypes <> NEW."expectedInputCount"
            OR actual_work_items <> NEW."expectedInputCount"
            OR actual_manifest IS DISTINCT FROM NEW."inputManifestFingerprint" THEN
            RAISE EXCEPTION 'index generation input manifest is incomplete'
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    IF NEW."status" IN ('rag_ready', 'rag_ready_empty') THEN
        SELECT COUNT(*) INTO succeeded_work_items
        FROM "IndexWorkItem" AS w
        WHERE w."projectId" = NEW."projectId" AND w."indexGenerationId" = NEW."id"
          AND w."status" = 'succeeded';
        SELECT COUNT(*) INTO actual_embeddings
        FROM "ChunkEmbedding" AS e
        WHERE e."projectId" = NEW."projectId" AND e."indexGenerationId" = NEW."id";
        IF (NEW."status" = 'rag_ready' AND NEW."expectedInputCount" = 0)
            OR (NEW."status" = 'rag_ready_empty' AND NEW."expectedInputCount" <> 0)
            OR succeeded_work_items <> NEW."expectedInputCount"
            OR actual_embeddings <> NEW."expectedInputCount"
            OR NEW."indexedInputCount" <> NEW."expectedInputCount" THEN
            RAISE EXCEPTION 'index generation is not publishable'
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "repository_code_index_pointer_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_status "IndexGenerationStatus";
    expected_count INTEGER;
    indexed_count INTEGER;
    embedding_count BIGINT;
    eligible BOOLEAN;
    expected_active_index_id UUID;
    current_active_index_id UUID;
BEGIN
    IF TG_OP = 'UPDATE' AND (
        NEW."projectId" IS DISTINCT FROM OLD."projectId"
        OR NEW."projectRepositoryLinkId" IS DISTINCT FROM OLD."projectRepositoryLinkId"
    ) THEN
        RAISE EXCEPTION 'repository code index pointer identity is immutable'
            USING ERRCODE = 'check_violation';
    END IF;
    PERFORM 1
    FROM "ProjectRepositoryLink" AS link
    WHERE link."projectId" = NEW."projectId"
      AND link."id" = NEW."projectRepositoryLinkId"
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'repository code index pointer link does not exist'
            USING ERRCODE = 'check_violation';
    END IF;
    SELECT code_index."expectedActiveIndexGenerationId"
    INTO expected_active_index_id
    FROM "RepositoryCodeIndexGeneration" AS code_index
    WHERE code_index."projectId" = NEW."projectId"
      AND code_index."projectRepositoryLinkId" = NEW."projectRepositoryLinkId"
      AND code_index."indexGenerationId" = NEW."indexGenerationId";
    IF NOT FOUND THEN
        RAISE EXCEPTION 'repository code index target does not exist'
            USING ERRCODE = 'check_violation';
    END IF;
    SELECT pointer."indexGenerationId"
    INTO current_active_index_id
    FROM "RepositoryCodeIndexPointer" AS pointer
    WHERE pointer."projectId" = NEW."projectId"
      AND pointer."projectRepositoryLinkId" = NEW."projectRepositoryLinkId";
    IF expected_active_index_id IS DISTINCT FROM current_active_index_id THEN
        RAISE EXCEPTION 'repository code index publication lost compare-and-swap'
            USING ERRCODE = 'serialization_failure';
    END IF;
    SELECT i."status", i."expectedInputCount", i."indexedInputCount"
    INTO target_status, expected_count, indexed_count
    FROM "IndexGeneration" AS i
    WHERE i."projectId" = NEW."projectId" AND i."id" = NEW."indexGenerationId"
    FOR UPDATE;
    SELECT COUNT(*) INTO embedding_count
    FROM "ChunkEmbedding" AS e
    WHERE e."projectId" = NEW."projectId" AND e."indexGenerationId" = NEW."indexGenerationId";
    SELECT EXISTS (
        SELECT 1
        FROM "RepositoryCodeIndexGeneration" AS code_index
        JOIN "ModelProcessingGrant" AS grant_row
          ON grant_row."projectId" = code_index."projectId"
         AND grant_row."id" = code_index."grantId"
        JOIN "ProjectRepositoryLink" AS link
          ON link."projectId" = code_index."projectId"
         AND link."id" = code_index."projectRepositoryLinkId"
        JOIN "ProjectRepositoryLinkConfigPointer" AS config_pointer
          ON config_pointer."projectId" = code_index."projectId"
         AND config_pointer."projectRepositoryLinkId" = code_index."projectRepositoryLinkId"
        JOIN "RepositoryCodeGenerationPointer" AS code_pointer
          ON code_pointer."projectId" = code_index."projectId"
         AND code_pointer."projectRepositoryLinkId" = code_index."projectRepositoryLinkId"
        JOIN "ProjectRepositoryLinkConfigVersion" AS config
          ON config."projectId" = config_pointer."projectId"
         AND config."projectRepositoryLinkId" = config_pointer."projectRepositoryLinkId"
         AND config."version" = config_pointer."configVersion"
         AND config."effectivePolicyVersion" = config_pointer."effectivePolicyVersion"
        JOIN "RepositoryCodeGeneration" AS code_generation
          ON code_generation."projectId" = code_pointer."projectId"
         AND code_generation."projectRepositoryLinkId" = code_pointer."projectRepositoryLinkId"
         AND code_generation."id" = code_pointer."repositoryCodeGenerationId"
        WHERE code_index."projectId" = NEW."projectId"
          AND code_index."projectRepositoryLinkId" = NEW."projectRepositoryLinkId"
          AND code_index."indexGenerationId" = NEW."indexGenerationId"
          AND code_index."repositoryCodeGenerationId" = NEW."repositoryCodeGenerationId"
          AND code_index."linkConfigVersion" = NEW."linkConfigVersion"
          AND code_index."effectivePolicyVersion" = NEW."effectivePolicyVersion"
          AND grant_row."status" = 'issued' AND grant_row."revokedAt" IS NULL
          AND grant_row."expiresAt" > CURRENT_TIMESTAMP
          AND link."status" = 'active'
          AND link."effectivePolicyVersion" = NEW."effectivePolicyVersion"
          AND config_pointer."configVersion" = NEW."linkConfigVersion"
          AND config_pointer."effectivePolicyVersion" = NEW."effectivePolicyVersion"
          AND code_pointer."repositoryCodeGenerationId" = NEW."repositoryCodeGenerationId"
          AND code_pointer."linkConfigVersion" = NEW."linkConfigVersion"
          AND code_pointer."effectivePolicyVersion" = NEW."effectivePolicyVersion"
          AND config."codeEnabled" = TRUE
          AND config."scanScopeFingerprint" = code_generation."scanScopeFingerprint"
          AND code_generation."status" = 'code_ready'
          AND code_generation."modelTransferScanResult" = 'passed'
    ) INTO eligible;
    IF target_status NOT IN ('rag_ready', 'rag_ready_empty')
        OR indexed_count <> expected_count
        OR embedding_count <> expected_count
        OR eligible IS NOT TRUE THEN
        RAISE EXCEPTION 'repository code index is not publishable'
            USING ERRCODE = 'check_violation';
    END IF;
    UPDATE "IndexGeneration"
    SET "publishedAt" = COALESCE("publishedAt", NEW."publishedAt")
    WHERE "projectId" = NEW."projectId" AND "id" = NEW."indexGenerationId";
    IF TG_OP = 'UPDATE' AND OLD."indexGenerationId" <> NEW."indexGenerationId" THEN
        UPDATE "IndexGeneration"
        SET "status" = 'superseded', "supersededAt" = NEW."publishedAt"
        WHERE "projectId" = OLD."projectId"
          AND "id" = OLD."indexGenerationId"
          AND "status" IN ('rag_ready', 'rag_ready_empty');
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "RepositoryCodeIndexPointer_publish_trigger"
BEFORE INSERT OR UPDATE ON "RepositoryCodeIndexPointer"
FOR EACH ROW EXECUTE FUNCTION "repository_code_index_pointer_guard"();
