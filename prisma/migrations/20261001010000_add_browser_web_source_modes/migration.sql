BEGIN;

LOCK TABLE public."ProjectSource",
           public."WebSource",
           public."ExternalCredential",
           public."WebSourceRevision",
           public."WebSourceReviewAudit",
           public."WebSourcePointer"
  IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE public."WebSource"
  ADD COLUMN "siteFormLoginUrl" VARCHAR(2048),
  ADD COLUMN "siteFormSubmitUrl" VARCHAR(2048),
  ADD COLUMN "siteFormUsernameSelector" VARCHAR(160),
  ADD COLUMN "siteFormPasswordSelector" VARCHAR(160),
  ADD COLUMN "siteFormSubmitSelector" VARCHAR(160),
  ADD COLUMN "siteFormSuccessSelector" VARCHAR(160),
  ADD COLUMN "manualConfigurationFingerprint" CHAR(64),
  ADD COLUMN "browserExecutionProfileFingerprint" CHAR(64);

ALTER TABLE public."WebSource"
  DROP CONSTRAINT "WebSource_authentication_binding_check",
  ADD CONSTRAINT "WebSource_authentication_binding_check" CHECK (
    (
      "authenticationMode" = 'none'
      AND "authCredentialId" IS NULL
      AND "authCredentialFingerprint" IS NULL
      AND "authCredentialUrlFingerprint" IS NULL
      AND "siteFormLoginUrl" IS NULL
      AND "siteFormSubmitUrl" IS NULL
      AND "siteFormUsernameSelector" IS NULL
      AND "siteFormPasswordSelector" IS NULL
      AND "siteFormSubmitSelector" IS NULL
      AND "siteFormSuccessSelector" IS NULL
      AND "manualConfigurationFingerprint" IS NULL
      AND "browserExecutionProfileFingerprint" IS NULL
    )
    OR
    (
      "authenticationMode" = 'bearer'
      AND "allowPrivateNetwork" = false
      AND "url" ~ '^https://[^[:space:]]+$'
      AND "siteFormLoginUrl" IS NULL
      AND "siteFormSubmitUrl" IS NULL
      AND "siteFormUsernameSelector" IS NULL
      AND "siteFormPasswordSelector" IS NULL
      AND "siteFormSubmitSelector" IS NULL
      AND "siteFormSuccessSelector" IS NULL
      AND "manualConfigurationFingerprint" IS NULL
      AND "browserExecutionProfileFingerprint" IS NULL
      AND (
        ("authCredentialId" IS NULL AND "authCredentialFingerprint" IS NULL AND "authCredentialUrlFingerprint" IS NULL)
        OR
        ("authCredentialId" IS NOT NULL
          AND "authCredentialFingerprint" IS NOT NULL
          AND "authCredentialFingerprint" ~ '^[0-9a-f]{64}$'
          AND "authCredentialUrlFingerprint" IS NOT NULL
          AND "authCredentialUrlFingerprint" = pg_catalog.encode(public.digest("url", 'sha256'), 'hex'))
      )
    )
    OR
    (
      "authenticationMode" = 'rendered'
      AND "allowPrivateNetwork" = false
      AND "url" ~ '^https://[^[:space:]]+$'
      AND "authCredentialId" IS NULL
      AND "authCredentialFingerprint" IS NULL
      AND "authCredentialUrlFingerprint" IS NOT NULL
      AND "authCredentialUrlFingerprint" = pg_catalog.encode(public.digest("url", 'sha256'), 'hex')
      AND "resolvedAddressFingerprint" IS NOT NULL
      AND "resolvedAddressFingerprint" ~ '^[0-9a-f]{64}$'
      AND substring("url" FROM '^(https://[^/?#]+)') IS NOT NULL
      AND substring("url" FROM '^(https://[^/?#]+)') !~ '@'
      AND "siteFormLoginUrl" IS NULL
      AND "siteFormSubmitUrl" IS NULL
      AND "siteFormUsernameSelector" IS NULL
      AND "siteFormPasswordSelector" IS NULL
      AND "siteFormSubmitSelector" IS NULL
      AND "siteFormSuccessSelector" IS NULL
      AND "manualConfigurationFingerprint" IS NOT NULL
      AND "manualConfigurationFingerprint" ~ '^[0-9a-f]{64}$'
      AND "browserExecutionProfileFingerprint" IS NOT NULL
      AND "browserExecutionProfileFingerprint" ~ '^[0-9a-f]{64}$'
    )
    OR
    (
      "authenticationMode" = 'site_form'
      AND "allowPrivateNetwork" = false
      AND "url" ~ '^https://[^[:space:]]+$'
      AND (
        (
          "status" = 'disabled'
          AND "disabledAt" IS NOT NULL
          AND "authCredentialId" IS NULL
          AND "authCredentialFingerprint" IS NULL
          AND "authCredentialUrlFingerprint" IS NULL
        )
        OR
        (
          "authCredentialId" IS NOT NULL
          AND "authCredentialFingerprint" IS NOT NULL
          AND "authCredentialFingerprint" ~ '^[0-9a-f]{64}$'
          AND "authCredentialUrlFingerprint" IS NOT NULL
          AND "authCredentialUrlFingerprint" = pg_catalog.encode(public.digest("url", 'sha256'), 'hex')
        )
      )
      AND "resolvedAddressFingerprint" IS NOT NULL
      AND "resolvedAddressFingerprint" ~ '^[0-9a-f]{64}$'
      AND "siteFormLoginUrl" IS NOT NULL
      AND "siteFormLoginUrl" ~ '^https://[^[:space:]#]+$'
      AND substring("siteFormLoginUrl" FROM '^(https://[^/?#]+)') IS NOT NULL
      AND substring("siteFormLoginUrl" FROM '^(https://[^/?#]+)') !~ '@'
      AND "siteFormSubmitUrl" IS NOT NULL
      AND "siteFormSubmitUrl" ~ '^https://[^[:space:]?#]+$'
      AND substring("siteFormSubmitUrl" FROM '^(https://[^/?#]+)') IS NOT NULL
      AND substring("siteFormSubmitUrl" FROM '^(https://[^/?#]+)') !~ '@'
      AND substring("url" FROM '^(https://[^/?#]+)') IS NOT NULL
      AND substring("url" FROM '^(https://[^/?#]+)') !~ '@'
      AND substring("siteFormLoginUrl" FROM '^(https://[^/?#]+)') = substring("url" FROM '^(https://[^/?#]+)')
      AND substring("siteFormSubmitUrl" FROM '^(https://[^/?#]+)') = substring("url" FROM '^(https://[^/?#]+)')
      AND "siteFormUsernameSelector" IS NOT NULL
      AND "siteFormUsernameSelector" ~ '^(input\[(name|id)="[A-Za-z][A-Za-z0-9_-]{0,127}"\]|#[A-Za-z][A-Za-z0-9_-]{0,127})$'
      AND "siteFormPasswordSelector" IS NOT NULL
      AND "siteFormPasswordSelector" ~ '^(input\[(name|id)="[A-Za-z][A-Za-z0-9_-]{0,127}"\]|#[A-Za-z][A-Za-z0-9_-]{0,127})$'
      AND "siteFormUsernameSelector" <> "siteFormPasswordSelector"
      AND "siteFormSubmitSelector" IS NOT NULL
      AND "siteFormSubmitSelector" ~ '^((button|input)\[(name|id)="[A-Za-z][A-Za-z0-9_-]{0,127}"\]|#[A-Za-z][A-Za-z0-9_-]{0,127}|button\[type="submit"\]|input\[type="submit"\])$'
      AND "siteFormSuccessSelector" IS NOT NULL
      AND "siteFormSuccessSelector" ~ '^#[A-Za-z][A-Za-z0-9_-]{0,127}$'
      AND "manualConfigurationFingerprint" IS NOT NULL
      AND "manualConfigurationFingerprint" ~ '^[0-9a-f]{64}$'
      AND "browserExecutionProfileFingerprint" IS NOT NULL
      AND "browserExecutionProfileFingerprint" ~ '^[0-9a-f]{64}$'
    )
  );

ALTER TABLE public."WebSourceRevision"
  ADD COLUMN "manualConfigurationFingerprint" CHAR(64),
  ADD COLUMN "browserExecutionProfileFingerprint" CHAR(64),
  DROP CONSTRAINT "WebSourceRevision_state_check";

ALTER TABLE public."WebSourceRevision"
  ADD CONSTRAINT "WebSourceRevision_state_check" CHECK (
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
      AND ("credentialFingerprint" IS NULL OR "credentialFingerprint" ~ '^[0-9a-f]{64}$')
      AND "configuredUrlFingerprint" IS NOT NULL
      AND "configuredUrlFingerprint" ~ '^[0-9a-f]{64}$'
      AND "networkFingerprint" IS NOT NULL
      AND "networkFingerprint" ~ '^[0-9a-f]{64}$'
      AND ("manualConfigurationFingerprint" IS NULL OR "manualConfigurationFingerprint" ~ '^[0-9a-f]{64}$')
      AND ("browserExecutionProfileFingerprint" IS NULL OR "browserExecutionProfileFingerprint" ~ '^[0-9a-f]{64}$')
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
      AND (
        "reviewStatus" = 'notRequired'
        OR (
          "configurationVersion" IS NOT NULL
          AND "configurationVersion" > 0
          AND ("credentialFingerprint" IS NULL OR "credentialFingerprint" ~ '^[0-9a-f]{64}$')
          AND "configuredUrlFingerprint" IS NOT NULL
          AND "configuredUrlFingerprint" ~ '^[0-9a-f]{64}$'
          AND "networkFingerprint" IS NOT NULL
          AND "networkFingerprint" ~ '^[0-9a-f]{64}$'
          AND ("manualConfigurationFingerprint" IS NULL OR "manualConfigurationFingerprint" ~ '^[0-9a-f]{64}$')
          AND ("browserExecutionProfileFingerprint" IS NULL OR "browserExecutionProfileFingerprint" ~ '^[0-9a-f]{64}$')
        )
      )
    )
    OR
    (
      "status" = 'failed'
      AND "completedAt" IS NOT NULL
      AND "failureCode" IS NOT NULL
      AND "contentText" IS NULL
      AND "reviewStatus" IN ('notRequired', 'rejected')
      AND (
        "reviewStatus" = 'notRequired'
        OR (
          "projectSourceId" IS NULL
          AND "contentHash" IS NOT NULL
          AND "contentHash" ~ '^[0-9a-f]{64}$'
          AND "configurationVersion" IS NOT NULL
          AND "configurationVersion" > 0
          AND ("credentialFingerprint" IS NULL OR "credentialFingerprint" ~ '^[0-9a-f]{64}$')
          AND "configuredUrlFingerprint" IS NOT NULL
          AND "configuredUrlFingerprint" ~ '^[0-9a-f]{64}$'
          AND "networkFingerprint" IS NOT NULL
          AND "networkFingerprint" ~ '^[0-9a-f]{64}$'
          AND ("manualConfigurationFingerprint" IS NULL OR "manualConfigurationFingerprint" ~ '^[0-9a-f]{64}$')
          AND ("browserExecutionProfileFingerprint" IS NULL OR "browserExecutionProfileFingerprint" ~ '^[0-9a-f]{64}$')
        )
      )
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

ALTER TABLE public."WebSourceReviewAudit"
  ADD COLUMN "manualConfigurationFingerprint" CHAR(64),
  ADD COLUMN "browserExecutionProfileFingerprint" CHAR(64),
  ALTER COLUMN "credentialFingerprint" DROP NOT NULL,
  DROP CONSTRAINT "WebSourceReviewAudit_hashes_check";

ALTER TABLE public."WebSourceReviewAudit"
  ADD CONSTRAINT "WebSourceReviewAudit_hashes_check" CHECK (
    ("credentialFingerprint" IS NULL OR "credentialFingerprint" ~ '^[0-9a-f]{64}$')
    AND "configuredUrlFingerprint" ~ '^[0-9a-f]{64}$'
    AND "networkFingerprint" ~ '^[0-9a-f]{64}$'
    AND "contentHash" ~ '^[0-9a-f]{64}$'
    AND ("manualConfigurationFingerprint" IS NULL OR "manualConfigurationFingerprint" ~ '^[0-9a-f]{64}$')
    AND ("browserExecutionProfileFingerprint" IS NULL OR "browserExecutionProfileFingerprint" ~ '^[0-9a-f]{64}$')
  );

CREATE FUNCTION public.web_source_authenticated_revision_transition_guard() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  source_row RECORD;
BEGIN
  SELECT ws."authenticationMode"::TEXT AS authentication_mode,
         ws."configurationVersion", ws."authCredentialFingerprint",
         ws."authCredentialUrlFingerprint", ws."manualConfigurationFingerprint",
         ws."browserExecutionProfileFingerprint", ws."resolvedAddressFingerprint"
    INTO source_row
    FROM public."WebSource" AS ws
   WHERE ws."projectId" = NEW."projectId"
     AND ws."id" = NEW."webSourceId";

  IF NOT FOUND OR source_row.authentication_mode NOT IN ('bearer', 'rendered', 'site_form') THEN
    RETURN NEW;
  END IF;

  IF source_row.authentication_mode = 'site_form'
     AND (NEW."reviewStatus"::TEXT = 'accepted' OR NEW."status"::TEXT IN ('complete', 'superseded')) THEN
    RAISE EXCEPTION 'site-form browser content is owner-preview only'
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status"::TEXT <> 'staging' OR NEW."reviewStatus"::TEXT <> 'notRequired' THEN
      RAISE EXCEPTION 'authenticated web source revisions must start in staging'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF OLD."reviewStatus"::TEXT = 'notRequired' THEN
    IF NEW."reviewStatus"::TEXT IN ('accepted', 'rejected')
       OR (NEW."status"::TEXT = 'complete' AND NEW."reviewStatus"::TEXT <> 'accepted') THEN
      RAISE EXCEPTION 'authenticated web source revisions must be staged before review'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF OLD."reviewStatus"::TEXT = 'pending' THEN
    IF NEW."reviewStatus"::TEXT = 'notRequired'
       AND NEW."status"::TEXT = 'failed'
       AND NEW."failureCode" = 'WEB_SOURCE_CONFIGURATION_CHANGED'
       AND NEW."contentText" IS NULL
       AND NEW."completedAt" IS NOT NULL
       AND (to_jsonb(NEW) - 'status' - 'reviewStatus' - 'contentText' - 'failureCode' - 'completedAt')
          IS NOT DISTINCT FROM
          (to_jsonb(OLD) - 'status' - 'reviewStatus' - 'contentText' - 'failureCode' - 'completedAt') THEN
      RETURN NEW;
    END IF;
    IF NEW."reviewStatus"::TEXT NOT IN ('accepted', 'rejected')
       OR (NEW."reviewStatus"::TEXT = 'accepted' AND NEW."status"::TEXT <> 'complete')
       OR (NEW."reviewStatus"::TEXT = 'rejected' AND NEW."status"::TEXT <> 'failed')
       OR (to_jsonb(NEW) - 'status' - 'reviewStatus' - 'projectSourceId' - 'contentText' - 'failureCode' - 'completedAt')
          IS DISTINCT FROM
          (to_jsonb(OLD) - 'status' - 'reviewStatus' - 'projectSourceId' - 'contentText' - 'failureCode' - 'completedAt') THEN
      RAISE EXCEPTION 'authenticated web source review must decide an unchanged pending revision'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."reviewStatus"::TEXT IN ('pending', 'accepted', 'rejected')
     OR (NEW."status"::TEXT = 'staging' AND NEW."reviewStatus"::TEXT = 'notRequired') THEN
    IF NEW."configurationVersion" IS DISTINCT FROM source_row."configurationVersion"
       OR NEW."credentialFingerprint" IS DISTINCT FROM source_row."authCredentialFingerprint"
       OR NEW."configuredUrlFingerprint" IS DISTINCT FROM source_row."authCredentialUrlFingerprint"
       OR NEW."manualConfigurationFingerprint" IS DISTINCT FROM source_row."manualConfigurationFingerprint"
       OR NEW."browserExecutionProfileFingerprint" IS DISTINCT FROM source_row."browserExecutionProfileFingerprint"
       OR NEW."networkFingerprint" IS DISTINCT FROM source_row."resolvedAddressFingerprint" THEN
      RAISE EXCEPTION 'authenticated web source revision configuration snapshot is stale'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.web_source_authenticated_revision_transition_guard() FROM PUBLIC;
CREATE TRIGGER "WebSourceRevision_authenticated_transition_guard"
  BEFORE INSERT OR UPDATE ON public."WebSourceRevision"
  FOR EACH ROW EXECUTE FUNCTION public.web_source_authenticated_revision_transition_guard();

CREATE OR REPLACE FUNCTION public.web_source_bearer_credential_guard() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  credential_kind TEXT;
  credential_fingerprint CHAR(64);
BEGIN
  IF NEW."authenticationMode"::TEXT NOT IN ('bearer', 'site_form') THEN
    RETURN NEW;
  END IF;

  IF NEW."authenticationMode"::TEXT = 'site_form'
     AND NEW."status"::TEXT = 'disabled'
     AND NEW."disabledAt" IS NOT NULL
     AND NEW."authCredentialId" IS NULL
     AND NEW."authCredentialFingerprint" IS NULL
     AND NEW."authCredentialUrlFingerprint" IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW."authenticationMode"::TEXT = 'bearer' AND NEW."authCredentialId" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT credential."kind"::TEXT, credential."secretFingerprint"
    INTO credential_kind, credential_fingerprint
    FROM public."ExternalCredential" AS credential
   WHERE credential."id" = NEW."authCredentialId";

  IF NOT FOUND
     OR credential_kind IS DISTINCT FROM (CASE NEW."authenticationMode"::TEXT
          WHEN 'bearer' THEN 'web_source'
          ELSE 'web_source_form'
        END)
     OR credential_fingerprint IS DISTINCT FROM NEW."authCredentialFingerprint"
     OR NEW."authCredentialUrlFingerprint" IS DISTINCT FROM pg_catalog.encode(public.digest(NEW."url", 'sha256'), 'hex')
     OR NEW."allowPrivateNetwork"
     OR NEW."url" !~ '^https://[^[:space:]]+$' THEN
    RAISE EXCEPTION 'authenticated web source credential binding is invalid'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.web_source_bearer_credential_guard() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.web_source_authenticated_lifecycle_guard() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."authenticationMode"::TEXT IN ('bearer', 'rendered', 'site_form')
       AND EXISTS (SELECT 1 FROM public."Project" AS project_row WHERE project_row."id" = OLD."projectId") THEN
      RAISE EXCEPTION 'authenticated web source identity cannot be deleted while its project exists'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD."authenticationMode"::TEXT IN ('bearer', 'rendered', 'site_form')
     AND (
       NEW."authenticationMode" IS DISTINCT FROM OLD."authenticationMode"
       OR NEW."projectId" IS DISTINCT FROM OLD."projectId"
       OR NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."url" IS DISTINCT FROM OLD."url"
     ) THEN
    RAISE EXCEPTION 'authenticated web source identity is immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.web_source_authenticated_lifecycle_guard() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.web_source_authenticated_configuration_guard() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  authenticated_source BOOLEAN;
  security_configuration_changed BOOLEAN;
BEGIN
  authenticated_source := OLD."authenticationMode"::TEXT IN ('bearer', 'rendered', 'site_form')
    OR NEW."authenticationMode"::TEXT IN ('bearer', 'rendered', 'site_form');

  IF authenticated_source AND NEW."name" IS DISTINCT FROM OLD."name" THEN
    RAISE EXCEPTION 'authenticated web source names cannot be changed'
      USING ERRCODE = 'check_violation';
  END IF;

  security_configuration_changed :=
       NEW."url" IS DISTINCT FROM OLD."url"
    OR NEW."allowPrivateNetwork" IS DISTINCT FROM OLD."allowPrivateNetwork"
    OR NEW."authenticationMode" IS DISTINCT FROM OLD."authenticationMode"
    OR NEW."authCredentialId" IS DISTINCT FROM OLD."authCredentialId"
    OR NEW."authCredentialFingerprint" IS DISTINCT FROM OLD."authCredentialFingerprint"
    OR NEW."authCredentialUrlFingerprint" IS DISTINCT FROM OLD."authCredentialUrlFingerprint"
    OR NEW."siteFormLoginUrl" IS DISTINCT FROM OLD."siteFormLoginUrl"
    OR NEW."siteFormSubmitUrl" IS DISTINCT FROM OLD."siteFormSubmitUrl"
    OR NEW."siteFormUsernameSelector" IS DISTINCT FROM OLD."siteFormUsernameSelector"
    OR NEW."siteFormPasswordSelector" IS DISTINCT FROM OLD."siteFormPasswordSelector"
    OR NEW."siteFormSubmitSelector" IS DISTINCT FROM OLD."siteFormSubmitSelector"
    OR NEW."siteFormSuccessSelector" IS DISTINCT FROM OLD."siteFormSuccessSelector"
    OR NEW."manualConfigurationFingerprint" IS DISTINCT FROM OLD."manualConfigurationFingerprint"
    OR NEW."browserExecutionProfileFingerprint" IS DISTINCT FROM OLD."browserExecutionProfileFingerprint"
    OR NEW."configurationVersion" IS DISTINCT FROM OLD."configurationVersion"
    OR NEW."resolvedAddressFingerprint" IS DISTINCT FROM OLD."resolvedAddressFingerprint"
    OR NEW."status" IS DISTINCT FROM OLD."status"
    OR NEW."disabledAt" IS DISTINCT FROM OLD."disabledAt";

  IF authenticated_source AND security_configuration_changed
     AND (
       EXISTS (
         SELECT 1 FROM public."WebSourcePointer" AS pointer
          WHERE pointer."projectId" = OLD."projectId" AND pointer."webSourceId" = OLD."id"
       )
       OR EXISTS (
         SELECT 1 FROM public."ProjectSource" AS project_source
          WHERE project_source."projectId" = OLD."projectId"
            AND project_source."sourceIdentity" = OLD."id"
            AND project_source."retiredAt" IS NULL
       )
     ) THEN
    RAISE EXCEPTION 'authenticated web source must be retired before configuration changes'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.web_source_authenticated_configuration_guard() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.external_credential_web_source_guard() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."kind"::TEXT IN ('web_source', 'web_source_form') AND EXISTS (
      SELECT 1 FROM public."WebSource" AS source WHERE source."authCredentialId" = OLD."id"
    ) THEN
      RAISE EXCEPTION 'bound authenticated web source credentials must be detached before mutation'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF (OLD."kind"::TEXT IN ('web_source', 'web_source_form')
      OR NEW."kind"::TEXT IN ('web_source', 'web_source_form'))
     AND EXISTS (
       SELECT 1 FROM public."WebSource" AS source
        WHERE source."authCredentialId" IN (OLD."id", NEW."id")
     ) THEN
    RAISE EXCEPTION 'bound authenticated web source credentials must be detached before mutation'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.external_credential_web_source_guard() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.web_source_review_audit_guard() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  audit_row RECORD;
BEGIN
  IF TG_OP = 'DELETE'
     AND NOT EXISTS (SELECT 1 FROM public."Project" WHERE "id" = OLD."projectId") THEN
    RETURN OLD;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'web source review audit is immutable' USING ERRCODE = 'check_violation';
  END IF;

  SELECT ws."authenticationMode"::TEXT AS authentication_mode,
         ws."configurationVersion" AS source_version,
         ws."authCredentialFingerprint" AS source_credential_fingerprint,
         ws."authCredentialUrlFingerprint" AS source_url_fingerprint,
         ws."manualConfigurationFingerprint" AS source_manual_fingerprint,
         ws."browserExecutionProfileFingerprint" AS source_profile_fingerprint,
         ws."resolvedAddressFingerprint" AS source_network_fingerprint,
         ws."url" AS source_url,
         wr."status"::TEXT AS revision_status,
         wr."reviewStatus"::TEXT AS revision_review_status,
         wr."configurationVersion" AS revision_version,
         wr."credentialFingerprint" AS revision_credential_fingerprint,
         wr."configuredUrlFingerprint" AS revision_url_fingerprint,
         wr."networkFingerprint" AS revision_network_fingerprint,
         wr."manualConfigurationFingerprint" AS revision_manual_fingerprint,
         wr."browserExecutionProfileFingerprint" AS revision_profile_fingerprint,
         wr."finalUrl" AS revision_final_url,
         wr."contentHash" AS revision_content_hash
    INTO audit_row
    FROM public."WebSource" AS ws
    JOIN public."WebSourceRevision" AS wr
      ON wr."projectId" = ws."projectId"
     AND wr."webSourceId" = ws."id"
   WHERE ws."projectId" = NEW."projectId"
     AND ws."id" = NEW."webSourceId"
     AND wr."id" = NEW."webSourceRevisionId";

  IF NOT FOUND
     OR audit_row.authentication_mode NOT IN ('bearer', 'rendered', 'site_form')
     OR audit_row.source_version IS DISTINCT FROM NEW."configurationVersion"
     OR audit_row.revision_version IS DISTINCT FROM NEW."configurationVersion"
     OR audit_row.source_credential_fingerprint IS DISTINCT FROM NEW."credentialFingerprint"
     OR audit_row.revision_credential_fingerprint IS DISTINCT FROM NEW."credentialFingerprint"
     OR audit_row.source_url_fingerprint IS DISTINCT FROM NEW."configuredUrlFingerprint"
     OR audit_row.revision_url_fingerprint IS DISTINCT FROM NEW."configuredUrlFingerprint"
     OR audit_row.revision_network_fingerprint IS DISTINCT FROM NEW."networkFingerprint"
     OR audit_row.source_manual_fingerprint IS DISTINCT FROM NEW."manualConfigurationFingerprint"
     OR audit_row.revision_manual_fingerprint IS DISTINCT FROM NEW."manualConfigurationFingerprint"
     OR audit_row.source_profile_fingerprint IS DISTINCT FROM NEW."browserExecutionProfileFingerprint"
     OR audit_row.revision_profile_fingerprint IS DISTINCT FROM NEW."browserExecutionProfileFingerprint"
     OR audit_row.revision_content_hash IS DISTINCT FROM NEW."contentHash"
     OR audit_row.revision_review_status IS DISTINCT FROM NEW."decision"::TEXT
     OR (NEW."decision" = 'accepted' AND audit_row.revision_status <> 'complete')
     OR (NEW."decision" = 'rejected' AND audit_row.revision_status <> 'failed')
     OR (audit_row.authentication_mode = 'bearer'
         AND (audit_row.revision_network_fingerprint IS DISTINCT FROM audit_row.source_network_fingerprint
              OR audit_row.source_manual_fingerprint IS NOT NULL
              OR audit_row.source_profile_fingerprint IS NOT NULL
              OR audit_row.revision_credential_fingerprint IS NULL))
     OR (audit_row.authentication_mode = 'rendered'
         AND (audit_row.source_network_fingerprint IS NULL
              OR audit_row.revision_network_fingerprint IS DISTINCT FROM audit_row.source_network_fingerprint
              OR audit_row.revision_credential_fingerprint IS NOT NULL
              OR audit_row.source_credential_fingerprint IS NOT NULL
              OR audit_row.source_manual_fingerprint IS NULL
              OR audit_row.source_profile_fingerprint IS NULL))
     OR (audit_row.authentication_mode = 'site_form'
         AND (audit_row.source_network_fingerprint IS NULL
              OR audit_row.revision_network_fingerprint IS DISTINCT FROM audit_row.source_network_fingerprint
              OR audit_row.revision_credential_fingerprint IS NULL
              OR audit_row.source_manual_fingerprint IS NULL
              OR audit_row.source_profile_fingerprint IS NULL))
     OR (NEW."decision" = 'accepted' AND audit_row.revision_final_url IS DISTINCT FROM audit_row.source_url) THEN
    RAISE EXCEPTION 'web source review audit does not match its revision' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.web_source_review_audit_guard() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.web_source_pointer_review_guard() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  source_row RECORD;
  revision_row RECORD;
BEGIN
  SELECT ws."authenticationMode"::TEXT AS authentication_mode,
         ws."configurationVersion", ws."authCredentialFingerprint",
         ws."authCredentialUrlFingerprint", ws."manualConfigurationFingerprint",
         ws."browserExecutionProfileFingerprint", ws."url", ws."resolvedAddressFingerprint"
    INTO source_row
    FROM public."WebSource" AS ws
   WHERE ws."projectId" = NEW."projectId" AND ws."id" = NEW."webSourceId"
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'web source pointer references a missing source' USING ERRCODE = 'check_violation';
  END IF;
  IF source_row.authentication_mode = 'site_form' THEN
    RAISE EXCEPTION 'site-form browser content cannot have a publication pointer'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT wr."status"::TEXT AS status, wr."reviewStatus"::TEXT AS review_status,
         wr."configurationVersion", wr."credentialFingerprint",
         wr."configuredUrlFingerprint", wr."networkFingerprint",
         wr."manualConfigurationFingerprint", wr."browserExecutionProfileFingerprint",
         wr."finalUrl", wr."contentHash", wr."projectSourceId"
    INTO revision_row
    FROM public."WebSourceRevision" AS wr
   WHERE wr."projectId" = NEW."projectId"
     AND wr."webSourceId" = NEW."webSourceId"
     AND wr."id" = NEW."webSourceRevisionId";
  IF NOT FOUND OR revision_row.status <> 'complete' THEN
    RAISE EXCEPTION 'web source pointer must reference a completed revision' USING ERRCODE = 'check_violation';
  END IF;

  IF source_row.authentication_mode IN ('bearer', 'rendered', 'site_form') AND (
       revision_row.review_status IS DISTINCT FROM 'accepted'
    OR revision_row."configurationVersion" IS DISTINCT FROM source_row."configurationVersion"
    OR revision_row."credentialFingerprint" IS DISTINCT FROM source_row."authCredentialFingerprint"
    OR revision_row."configuredUrlFingerprint" IS DISTINCT FROM source_row."authCredentialUrlFingerprint"
    OR revision_row."finalUrl" IS DISTINCT FROM source_row."url"
    OR revision_row."manualConfigurationFingerprint" IS DISTINCT FROM source_row."manualConfigurationFingerprint"
    OR revision_row."browserExecutionProfileFingerprint" IS DISTINCT FROM source_row."browserExecutionProfileFingerprint"
    OR revision_row."networkFingerprint" IS DISTINCT FROM source_row."resolvedAddressFingerprint"
  ) THEN
    RAISE EXCEPTION 'authenticated web source pointer requires a current accepted revision'
      USING ERRCODE = 'check_violation';
  END IF;

  IF source_row.authentication_mode IN ('bearer', 'rendered', 'site_form') AND NOT EXISTS (
    SELECT 1 FROM public."WebSourceReviewAudit" AS audit
     WHERE audit."projectId" = NEW."projectId"
       AND audit."webSourceId" = NEW."webSourceId"
       AND audit."webSourceRevisionId" = NEW."webSourceRevisionId"
       AND audit."decision" = 'accepted'
       AND audit."configurationVersion" = revision_row."configurationVersion"
       AND audit."credentialFingerprint" IS NOT DISTINCT FROM revision_row."credentialFingerprint"
       AND audit."configuredUrlFingerprint" = revision_row."configuredUrlFingerprint"
       AND audit."networkFingerprint" = revision_row."networkFingerprint"
       AND audit."manualConfigurationFingerprint" IS NOT DISTINCT FROM revision_row."manualConfigurationFingerprint"
       AND audit."browserExecutionProfileFingerprint" IS NOT DISTINCT FROM revision_row."browserExecutionProfileFingerprint"
       AND audit."contentHash" = revision_row."contentHash"
  ) THEN
    RAISE EXCEPTION 'authenticated web source pointer requires a matching accepted review audit'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.web_source_pointer_review_guard() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.web_source_bearer_project_source_review_chain_guard() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  pair_project_ids UUID[] := ARRAY[]::UUID[];
  pair_web_source_ids UUID[] := ARRAY[]::UUID[];
  identity_pair RECORD;
  relevant_identity BOOLEAN;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    IF TG_TABLE_NAME = 'ProjectSource' THEN
      pair_project_ids := pg_catalog.array_append(pair_project_ids, OLD."projectId");
      pair_web_source_ids := pg_catalog.array_append(pair_web_source_ids, OLD."sourceIdentity");
    ELSIF TG_TABLE_NAME = 'WebSource' THEN
      pair_project_ids := pg_catalog.array_append(pair_project_ids, OLD."projectId");
      pair_web_source_ids := pg_catalog.array_append(pair_web_source_ids, OLD."id");
    ELSE
      pair_project_ids := pg_catalog.array_append(pair_project_ids, OLD."projectId");
      pair_web_source_ids := pg_catalog.array_append(pair_web_source_ids, OLD."webSourceId");
    END IF;
  END IF;

  IF TG_OP <> 'DELETE' THEN
    IF TG_TABLE_NAME = 'ProjectSource' THEN
      pair_project_ids := pg_catalog.array_append(pair_project_ids, NEW."projectId");
      pair_web_source_ids := pg_catalog.array_append(pair_web_source_ids, NEW."sourceIdentity");
    ELSIF TG_TABLE_NAME = 'WebSource' THEN
      pair_project_ids := pg_catalog.array_append(pair_project_ids, NEW."projectId");
      pair_web_source_ids := pg_catalog.array_append(pair_web_source_ids, NEW."id");
    ELSE
      pair_project_ids := pg_catalog.array_append(pair_project_ids, NEW."projectId");
      pair_web_source_ids := pg_catalog.array_append(pair_web_source_ids, NEW."webSourceId");
    END IF;
  END IF;

  FOR identity_pair IN
    SELECT DISTINCT pair_keys."projectId", pair_keys."webSourceId"
      FROM unnest(pair_project_ids, pair_web_source_ids) AS pair_keys("projectId", "webSourceId")
     WHERE pair_keys."projectId" IS NOT NULL AND pair_keys."webSourceId" IS NOT NULL
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public."Project" AS project_row WHERE project_row."id" = identity_pair."projectId"
    ) THEN
      CONTINUE;
    END IF;

    SELECT EXISTS (
      SELECT 1 FROM public."WebSource" AS web_source
       WHERE web_source."projectId" = identity_pair."projectId"
         AND web_source."id" = identity_pair."webSourceId"
         AND web_source."authenticationMode"::TEXT IN ('bearer', 'rendered', 'site_form')
    ) INTO relevant_identity;
    IF NOT relevant_identity THEN
      CONTINUE;
    END IF;

    IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
      RAISE EXCEPTION 'authenticated project-source review-chain guard requires READ COMMITTED isolation'
        USING ERRCODE = 'serialization_failure';
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(identity_pair."projectId"::TEXT || ':' || identity_pair."webSourceId"::TEXT, 0)
    );
    IF NOT EXISTS (
      SELECT 1 FROM public."Project" AS project_row WHERE project_row."id" = identity_pair."projectId"
    ) THEN
      CONTINUE;
    END IF;

    IF EXISTS (
      SELECT 1
        FROM public."WebSource" AS web_source
        JOIN public."ProjectSource" AS project_source
          ON project_source."projectId" = web_source."projectId"
         AND project_source."sourceIdentity" = web_source."id"
       WHERE web_source."projectId" = identity_pair."projectId"
         AND web_source."id" = identity_pair."webSourceId"
         AND web_source."authenticationMode"::TEXT = 'site_form'
    ) THEN
      RAISE EXCEPTION 'site-form browser content cannot enter project sources'
        USING ERRCODE = 'check_violation';
    END IF;

    IF EXISTS (
      SELECT 1
        FROM public."WebSource" AS web_source
        JOIN public."ProjectSource" AS project_source
          ON project_source."projectId" = web_source."projectId"
         AND project_source."sourceIdentity" = web_source."id"
       WHERE web_source."projectId" = identity_pair."projectId"
         AND web_source."id" = identity_pair."webSourceId"
         AND web_source."authenticationMode"::TEXT IN ('bearer', 'rendered', 'site_form')
         AND project_source."originScope"::TEXT = 'project'
         AND project_source."kind"::TEXT <> 'mcp'
         AND project_source."retiredAt" IS NULL
         AND (
           project_source."kind"::TEXT <> 'web'
           OR NOT EXISTS (
             SELECT 1
               FROM public."WebSourcePointer" AS pointer
               JOIN public."WebSourceRevision" AS revision
                 ON revision."projectId" = pointer."projectId"
                AND revision."webSourceId" = pointer."webSourceId"
                AND revision."id" = pointer."webSourceRevisionId"
               JOIN public."WebSourceReviewAudit" AS audit
                 ON audit."projectId" = revision."projectId"
                AND audit."webSourceId" = revision."webSourceId"
                AND audit."webSourceRevisionId" = revision."id"
              WHERE pointer."projectId" = web_source."projectId"
                AND pointer."webSourceId" = web_source."id"
                AND revision."status"::TEXT = 'complete'
                AND revision."reviewStatus"::TEXT = 'accepted'
                AND revision."projectSourceId" = project_source."id"
                AND revision."configurationVersion" = web_source."configurationVersion"
                AND revision."credentialFingerprint" IS NOT DISTINCT FROM web_source."authCredentialFingerprint"
                AND revision."configuredUrlFingerprint" IS NOT DISTINCT FROM web_source."authCredentialUrlFingerprint"
                AND revision."finalUrl" IS NOT DISTINCT FROM web_source."url"
                AND revision."manualConfigurationFingerprint" IS NOT DISTINCT FROM web_source."manualConfigurationFingerprint"
                AND revision."browserExecutionProfileFingerprint" IS NOT DISTINCT FROM web_source."browserExecutionProfileFingerprint"
                AND revision."networkFingerprint" IS NOT DISTINCT FROM web_source."resolvedAddressFingerprint"
                AND audit."decision"::TEXT = 'accepted'
                AND audit."configurationVersion" = revision."configurationVersion"
                AND audit."credentialFingerprint" IS NOT DISTINCT FROM revision."credentialFingerprint"
                AND audit."configuredUrlFingerprint" = revision."configuredUrlFingerprint"
                AND audit."networkFingerprint" = revision."networkFingerprint"
                AND audit."manualConfigurationFingerprint" IS NOT DISTINCT FROM revision."manualConfigurationFingerprint"
                AND audit."browserExecutionProfileFingerprint" IS NOT DISTINCT FROM revision."browserExecutionProfileFingerprint"
                AND audit."contentHash" = revision."contentHash"
           )
         )
    ) THEN
      RAISE EXCEPTION 'active authenticated project source requires a current accepted review chain'
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;

  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.web_source_bearer_project_source_review_chain_guard() FROM PUBLIC;
DO $$
DECLARE
  role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['ai_project_os_runtime', 'ai_project_os_entitlement_writer'] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = role_name) THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL ON FUNCTION public.web_source_bearer_project_source_review_chain_guard() FROM %I',
        role_name
      );
    END IF;
  END LOOP;
END;
$$;

COMMIT;
