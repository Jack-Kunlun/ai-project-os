CREATE TYPE "WebSourceAuthenticationMode" AS ENUM ('none', 'bearer');
CREATE TYPE "WebSourceRevisionReviewStatus" AS ENUM ('notRequired', 'pending', 'accepted', 'rejected');
CREATE TYPE "WebSourceReviewDecision" AS ENUM ('accepted', 'rejected');

ALTER TABLE "WebSource"
  ADD COLUMN "authenticationMode" "WebSourceAuthenticationMode" NOT NULL DEFAULT 'none',
  ADD COLUMN "authCredentialId" UUID,
  ADD COLUMN "authCredentialFingerprint" CHAR(64),
  ADD COLUMN "authCredentialUrlFingerprint" CHAR(64),
  ADD COLUMN "configurationVersion" INTEGER NOT NULL DEFAULT 1,
  ADD CONSTRAINT "WebSource_configurationVersion_check" CHECK ("configurationVersion" > 0),
  ADD CONSTRAINT "WebSource_authentication_binding_check" CHECK (
    (
      "authenticationMode" = 'none'
      AND "authCredentialId" IS NULL
      AND "authCredentialFingerprint" IS NULL
      AND "authCredentialUrlFingerprint" IS NULL
    )
    OR
    (
      "authenticationMode" = 'bearer'
      AND "allowPrivateNetwork" = false
      AND "url" ~ '^https://[^[:space:]]+$'
      AND (
        ("authCredentialId" IS NULL AND "authCredentialFingerprint" IS NULL AND "authCredentialUrlFingerprint" IS NULL)
        OR
        ("authCredentialId" IS NOT NULL AND "authCredentialFingerprint" IS NOT NULL AND "authCredentialFingerprint" ~ '^[0-9a-f]{64}$' AND "authCredentialUrlFingerprint" IS NOT NULL AND "authCredentialUrlFingerprint" ~ '^[0-9a-f]{64}$')
      )
    )
  );

CREATE UNIQUE INDEX "WebSource_authCredentialId_key" ON "WebSource"("authCredentialId");
ALTER TABLE "WebSource"
  ADD CONSTRAINT "WebSource_authCredentialId_fkey" FOREIGN KEY ("authCredentialId") REFERENCES "ExternalCredential"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "WebSourceRevision"
  ADD COLUMN "reviewStatus" "WebSourceRevisionReviewStatus" NOT NULL DEFAULT 'notRequired',
  ADD COLUMN "configurationVersion" INTEGER,
  ADD COLUMN "credentialFingerprint" CHAR(64),
  ADD COLUMN "configuredUrlFingerprint" CHAR(64),
  ADD COLUMN "networkFingerprint" CHAR(64),
  ADD COLUMN "contentText" TEXT;

ALTER TABLE "WebSourceRevision" DROP CONSTRAINT "WebSourceRevision_state_check";
ALTER TABLE "WebSourceRevision" ADD CONSTRAINT "WebSourceRevision_state_check" CHECK (
  (
    "status" = 'staging'
    AND "failureCode" IS NULL
    AND "projectSourceId" IS NULL
    AND "reviewStatus" = 'notRequired'
    AND "completedAt" IS NULL
    AND "contentText" IS NULL
  )
  OR
  (
    "status" = 'staging'
    AND "reviewStatus" = 'pending'
    AND "completedAt" IS NOT NULL
    AND "failureCode" IS NULL
    AND "projectSourceId" IS NULL
    AND "contentHash" IS NOT NULL
    AND "contentHash" ~ '^[0-9a-f]{64}$'
    AND "contentText" IS NOT NULL
    AND "configurationVersion" IS NOT NULL
    AND "configurationVersion" > 0
    AND "credentialFingerprint" IS NOT NULL
    AND "credentialFingerprint" ~ '^[0-9a-f]{64}$'
    AND "configuredUrlFingerprint" IS NOT NULL
    AND "configuredUrlFingerprint" ~ '^[0-9a-f]{64}$'
    AND "networkFingerprint" IS NOT NULL
    AND "networkFingerprint" ~ '^[0-9a-f]{64}$'
  )
  OR
  (
    "status" = 'complete'
    AND "completedAt" IS NOT NULL
    AND "projectSourceId" IS NOT NULL
    AND "contentHash" IS NOT NULL
    AND "contentHash" ~ '^[0-9a-f]{64}$'
    AND "failureCode" IS NULL
    AND "contentText" IS NULL
    AND "reviewStatus" IN ('notRequired', 'accepted')
    AND ("reviewStatus" = 'notRequired' OR (
      "configurationVersion" IS NOT NULL
      AND "configurationVersion" > 0
      AND "credentialFingerprint" IS NOT NULL
      AND "credentialFingerprint" ~ '^[0-9a-f]{64}$'
      AND "configuredUrlFingerprint" IS NOT NULL
      AND "configuredUrlFingerprint" ~ '^[0-9a-f]{64}$'
      AND "networkFingerprint" IS NOT NULL
      AND "networkFingerprint" ~ '^[0-9a-f]{64}$'
    ))
  )
  OR
  (
    "status" = 'failed'
    AND "completedAt" IS NOT NULL
    AND "failureCode" IS NOT NULL
    AND "contentText" IS NULL
    AND "reviewStatus" IN ('notRequired', 'rejected')
    AND ("reviewStatus" = 'notRequired' OR (
      "projectSourceId" IS NULL
      AND "contentHash" IS NOT NULL
      AND "contentHash" ~ '^[0-9a-f]{64}$'
      AND "configurationVersion" IS NOT NULL
      AND "configurationVersion" > 0
      AND "credentialFingerprint" IS NOT NULL
      AND "credentialFingerprint" ~ '^[0-9a-f]{64}$'
      AND "configuredUrlFingerprint" IS NOT NULL
      AND "configuredUrlFingerprint" ~ '^[0-9a-f]{64}$'
      AND "networkFingerprint" IS NOT NULL
      AND "networkFingerprint" ~ '^[0-9a-f]{64}$'
    ))
  )
  OR
  (
    "status" = 'superseded'
    AND "completedAt" IS NOT NULL
    AND "supersededAt" IS NOT NULL
    AND "projectSourceId" IS NOT NULL
    AND "contentHash" IS NOT NULL
    AND "contentHash" ~ '^[0-9a-f]{64}$'
    AND "failureCode" IS NULL
    AND "contentText" IS NULL
    AND "reviewStatus" IN ('notRequired', 'accepted')
  )
);

CREATE FUNCTION web_source_reviewed_revision_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."reviewStatus" IN ('accepted', 'rejected')
       AND EXISTS (SELECT 1 FROM "Project" WHERE "id" = OLD."projectId") THEN
      RAISE EXCEPTION 'reviewed web source revisions are immutable' USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD."reviewStatus" IN ('accepted', 'rejected') THEN
    IF OLD."reviewStatus" = 'accepted'
       AND OLD."status" = 'complete'
       AND OLD."supersededAt" IS NULL
       AND NEW."status" = 'superseded'
       AND NEW."supersededAt" IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM "WebSourcePointer" AS pointer
         WHERE pointer."projectId" = OLD."projectId"
           AND pointer."webSourceId" = OLD."webSourceId"
           AND pointer."webSourceRevisionId" = OLD."id"
       )
       AND (to_jsonb(NEW) - 'status' - 'supersededAt')
           IS NOT DISTINCT FROM (to_jsonb(OLD) - 'status' - 'supersededAt') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'reviewed web source revisions are immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION web_source_reviewed_revision_guard() FROM PUBLIC;
CREATE TRIGGER "WebSourceRevision_reviewed_guard"
  BEFORE UPDATE OR DELETE ON "WebSourceRevision"
  FOR EACH ROW EXECUTE FUNCTION web_source_reviewed_revision_guard();

CREATE TABLE "WebSourceReviewAudit" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "webSourceId" UUID NOT NULL,
  "webSourceRevisionId" UUID NOT NULL,
  "reviewerId" UUID NOT NULL,
  "decision" "WebSourceReviewDecision" NOT NULL,
  "configurationVersion" INTEGER NOT NULL,
  "credentialFingerprint" CHAR(64) NOT NULL,
  "configuredUrlFingerprint" CHAR(64) NOT NULL,
  "networkFingerprint" CHAR(64) NOT NULL,
  "contentHash" CHAR(64) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WebSourceReviewAudit_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WebSourceReviewAudit_configurationVersion_check" CHECK ("configurationVersion" > 0),
  CONSTRAINT "WebSourceReviewAudit_hashes_check" CHECK (
    "credentialFingerprint" ~ '^[0-9a-f]{64}$'
    AND "configuredUrlFingerprint" ~ '^[0-9a-f]{64}$'
    AND "networkFingerprint" ~ '^[0-9a-f]{64}$'
    AND "contentHash" ~ '^[0-9a-f]{64}$'
  )
);

CREATE UNIQUE INDEX "WebSourceReviewAudit_webSourceRevisionId_key" ON "WebSourceReviewAudit"("webSourceRevisionId");
CREATE UNIQUE INDEX "WebSourceReviewAudit_projectId_id_key" ON "WebSourceReviewAudit"("projectId", "id");
CREATE INDEX "WebSourceReviewAudit_projectId_webSourceId_createdAt_idx" ON "WebSourceReviewAudit"("projectId", "webSourceId", "createdAt");
CREATE INDEX "WebSourceReviewAudit_reviewerId_createdAt_idx" ON "WebSourceReviewAudit"("reviewerId", "createdAt");

ALTER TABLE "WebSourceReviewAudit"
  ADD CONSTRAINT "WebSourceReviewAudit_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "WebSourceReviewAudit_webSource_fkey" FOREIGN KEY ("projectId", "webSourceId") REFERENCES "WebSource"("projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "WebSourceReviewAudit_revision_fkey" FOREIGN KEY ("projectId", "webSourceId", "webSourceRevisionId") REFERENCES "WebSourceRevision"("projectId", "webSourceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "WebSourceReviewAudit_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

CREATE FUNCTION web_source_bearer_credential_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  credential_kind TEXT;
  credential_fingerprint CHAR(64);
BEGIN
  IF NEW."authCredentialId" IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT credential."kind"::text, credential."secretFingerprint"
    INTO credential_kind, credential_fingerprint
    FROM "ExternalCredential" AS credential
    WHERE credential."id" = NEW."authCredentialId";
  IF NOT FOUND
     OR credential_kind <> 'web_source'
     OR credential_fingerprint IS DISTINCT FROM NEW."authCredentialFingerprint"
     OR NEW."authCredentialUrlFingerprint" IS DISTINCT FROM encode(digest(NEW."url", 'sha256'), 'hex')
     OR NEW."authenticationMode" <> 'bearer'
     OR NEW."allowPrivateNetwork"
     OR NEW."url" !~ '^https://[^[:space:]]+$' THEN
    RAISE EXCEPTION 'authenticated web source credential binding is invalid' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION web_source_bearer_credential_guard() FROM PUBLIC;
CREATE TRIGGER "WebSource_bearer_credential_guard"
  BEFORE INSERT OR UPDATE ON "WebSource"
  FOR EACH ROW EXECUTE FUNCTION web_source_bearer_credential_guard();

CREATE FUNCTION web_source_authenticated_configuration_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD."authenticationMode" = 'bearer' OR NEW."authenticationMode" = 'bearer')
     AND NEW."name" IS DISTINCT FROM OLD."name" THEN
    RAISE EXCEPTION 'authenticated web source names cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  IF (OLD."authenticationMode" = 'bearer' OR NEW."authenticationMode" = 'bearer')
     AND (
       NEW."url" IS DISTINCT FROM OLD."url"
       OR NEW."allowPrivateNetwork" IS DISTINCT FROM OLD."allowPrivateNetwork"
       OR NEW."authenticationMode" IS DISTINCT FROM OLD."authenticationMode"
       OR NEW."authCredentialId" IS DISTINCT FROM OLD."authCredentialId"
       OR NEW."authCredentialFingerprint" IS DISTINCT FROM OLD."authCredentialFingerprint"
       OR NEW."authCredentialUrlFingerprint" IS DISTINCT FROM OLD."authCredentialUrlFingerprint"
       OR NEW."configurationVersion" IS DISTINCT FROM OLD."configurationVersion"
       OR NEW."resolvedAddressFingerprint" IS DISTINCT FROM OLD."resolvedAddressFingerprint"
       OR NEW."status" IS DISTINCT FROM OLD."status"
       OR NEW."disabledAt" IS DISTINCT FROM OLD."disabledAt"
     )
     AND (
       EXISTS (
         SELECT 1 FROM "WebSourcePointer" AS pointer
         WHERE pointer."projectId" = OLD."projectId" AND pointer."webSourceId" = OLD."id"
       )
       OR EXISTS (
         SELECT 1 FROM "ProjectSource" AS project_source
         WHERE project_source."projectId" = OLD."projectId"
           AND project_source."sourceIdentity" = OLD."id"
           AND project_source."retiredAt" IS NULL
       )
     ) THEN
    RAISE EXCEPTION 'authenticated web source must be retired before configuration changes' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION web_source_authenticated_configuration_guard() FROM PUBLIC;
CREATE TRIGGER "WebSource_authenticated_configuration_guard"
  BEFORE UPDATE ON "WebSource"
  FOR EACH ROW EXECUTE FUNCTION web_source_authenticated_configuration_guard();

CREATE FUNCTION external_credential_web_source_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'web_source' AND EXISTS (
      SELECT 1 FROM "WebSource" AS source WHERE source."authCredentialId" = OLD."id"
    ) THEN
      RAISE EXCEPTION 'bound authenticated web source credentials must be detached before mutation' USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF (OLD."kind" = 'web_source' OR NEW."kind" = 'web_source') AND EXISTS (
    SELECT 1 FROM "WebSource" AS source WHERE source."authCredentialId" IN (OLD."id", NEW."id")
  ) THEN
    RAISE EXCEPTION 'bound authenticated web source credentials must be detached before mutation' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION external_credential_web_source_guard() FROM PUBLIC;
CREATE TRIGGER "ExternalCredential_web_source_guard"
  BEFORE UPDATE OR DELETE ON "ExternalCredential"
  FOR EACH ROW EXECUTE FUNCTION external_credential_web_source_guard();

CREATE FUNCTION web_source_review_audit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  audit_row RECORD;
BEGIN
  IF TG_OP = 'DELETE'
     AND NOT EXISTS (SELECT 1 FROM "Project" WHERE "id" = OLD."projectId") THEN
    RETURN OLD;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'web source review audit is immutable' USING ERRCODE = 'check_violation';
  END IF;
  SELECT ws."authenticationMode", ws."configurationVersion" AS source_version,
         ws."authCredentialFingerprint", ws."authCredentialUrlFingerprint",
         ws."url", wr."status", wr."reviewStatus", wr."configurationVersion",
         wr."credentialFingerprint", wr."configuredUrlFingerprint", wr."networkFingerprint",
         wr."finalUrl", wr."contentHash"
    INTO audit_row
    FROM "WebSource" AS ws
    JOIN "WebSourceRevision" AS wr
      ON wr."projectId" = ws."projectId"
     AND wr."webSourceId" = ws."id"
    WHERE ws."projectId" = NEW."projectId"
      AND ws."id" = NEW."webSourceId"
      AND wr."id" = NEW."webSourceRevisionId";
  IF NOT FOUND
     OR audit_row."authenticationMode" <> 'bearer'
     OR audit_row."source_version" <> NEW."configurationVersion"
     OR audit_row."configurationVersion" <> NEW."configurationVersion"
     OR audit_row."authCredentialFingerprint" IS DISTINCT FROM NEW."credentialFingerprint"
     OR audit_row."credentialFingerprint" IS DISTINCT FROM NEW."credentialFingerprint"
     OR audit_row."authCredentialUrlFingerprint" IS DISTINCT FROM NEW."configuredUrlFingerprint"
     OR audit_row."configuredUrlFingerprint" IS DISTINCT FROM NEW."configuredUrlFingerprint"
     OR audit_row."networkFingerprint" IS DISTINCT FROM NEW."networkFingerprint"
     OR audit_row."contentHash" IS DISTINCT FROM NEW."contentHash"
     OR audit_row."finalUrl" IS DISTINCT FROM audit_row."url"
     OR audit_row."reviewStatus"::text IS DISTINCT FROM NEW."decision"::text
     OR (NEW."decision" = 'accepted' AND audit_row."status" <> 'complete')
     OR (NEW."decision" = 'rejected' AND audit_row."status" <> 'failed') THEN
    RAISE EXCEPTION 'web source review audit does not match its revision' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION web_source_review_audit_guard() FROM PUBLIC;
CREATE TRIGGER "WebSourceReviewAudit_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "WebSourceReviewAudit"
  FOR EACH ROW EXECUTE FUNCTION web_source_review_audit_guard();

CREATE FUNCTION web_source_pointer_review_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_row RECORD;
  revision_row RECORD;
BEGIN
  SELECT ws."authenticationMode", ws."configurationVersion", ws."authCredentialFingerprint",
         ws."authCredentialUrlFingerprint", ws."url", ws."resolvedAddressFingerprint"
    INTO source_row
    FROM "WebSource" AS ws
    WHERE ws."projectId" = NEW."projectId" AND ws."id" = NEW."webSourceId"
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'web source pointer references a missing source' USING ERRCODE = 'check_violation';
  END IF;
  SELECT wr."status", wr."reviewStatus", wr."configurationVersion",
         wr."credentialFingerprint", wr."configuredUrlFingerprint", wr."networkFingerprint",
         wr."finalUrl", wr."contentHash", wr."projectSourceId"
    INTO revision_row
    FROM "WebSourceRevision" AS wr
    WHERE wr."projectId" = NEW."projectId"
      AND wr."webSourceId" = NEW."webSourceId"
      AND wr."id" = NEW."webSourceRevisionId";
  IF NOT FOUND OR revision_row."status" <> 'complete' THEN
    RAISE EXCEPTION 'web source pointer must reference a completed revision' USING ERRCODE = 'check_violation';
  END IF;
  IF source_row."authenticationMode" = 'bearer' AND (
    revision_row."reviewStatus" <> 'accepted'
    OR revision_row."configurationVersion" IS DISTINCT FROM source_row."configurationVersion"
    OR revision_row."credentialFingerprint" IS DISTINCT FROM source_row."authCredentialFingerprint"
    OR revision_row."configuredUrlFingerprint" IS DISTINCT FROM source_row."authCredentialUrlFingerprint"
    OR revision_row."networkFingerprint" IS DISTINCT FROM source_row."resolvedAddressFingerprint"
    OR revision_row."finalUrl" IS DISTINCT FROM source_row."url"
  ) THEN
    RAISE EXCEPTION 'authenticated web source pointer requires a current accepted revision' USING ERRCODE = 'check_violation';
  END IF;
  IF source_row."authenticationMode" = 'bearer' AND NOT EXISTS (
    SELECT 1 FROM "WebSourceReviewAudit" AS audit
    WHERE audit."projectId" = NEW."projectId"
      AND audit."webSourceId" = NEW."webSourceId"
      AND audit."webSourceRevisionId" = NEW."webSourceRevisionId"
      AND audit."decision" = 'accepted'
      AND audit."configurationVersion" = revision_row."configurationVersion"
      AND audit."credentialFingerprint" = revision_row."credentialFingerprint"
      AND audit."configuredUrlFingerprint" = revision_row."configuredUrlFingerprint"
      AND audit."networkFingerprint" = revision_row."networkFingerprint"
      AND audit."contentHash" = revision_row."contentHash"
  ) THEN
    RAISE EXCEPTION 'authenticated web source pointer requires a matching accepted review audit' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION web_source_pointer_review_guard() FROM PUBLIC;
CREATE TRIGGER "WebSourcePointer_review_guard"
  BEFORE INSERT OR UPDATE ON "WebSourcePointer"
  FOR EACH ROW EXECUTE FUNCTION web_source_pointer_review_guard();

CREATE FUNCTION web_source_pointer_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  project_source_id UUID;
BEGIN
  -- A project hard-delete is the only path that may cascade an active pointer;
  -- the parent row is already absent while its FK cascades are processed.
  IF NOT EXISTS (SELECT 1 FROM "Project" WHERE "id" = OLD."projectId") THEN
    RETURN OLD;
  END IF;
  SELECT revision."projectSourceId"
    INTO project_source_id
    FROM "WebSourceRevision" AS revision
    WHERE revision."projectId" = OLD."projectId"
      AND revision."webSourceId" = OLD."webSourceId"
      AND revision."id" = OLD."webSourceRevisionId";
  IF project_source_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM "ProjectSource" AS project_source
    WHERE project_source."projectId" = OLD."projectId"
      AND project_source."id" = project_source_id
      AND project_source."retiredAt" IS NULL
  ) THEN
    RAISE EXCEPTION 'active web source content must be retired before deleting its pointer' USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION web_source_pointer_delete_guard() FROM PUBLIC;
CREATE TRIGGER "WebSourcePointer_delete_guard"
  BEFORE DELETE ON "WebSourcePointer"
  FOR EACH ROW EXECUTE FUNCTION web_source_pointer_delete_guard();
