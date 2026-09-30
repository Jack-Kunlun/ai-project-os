BEGIN;

LOCK TABLE public."Project",
           public."ProjectSource",
           public."WebSource",
           public."WebSourcePointer",
           public."WebSourceRevision",
           public."WebSourceReviewAudit"
  IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE public."WebSourceIdentityFence" (
  "projectId" UUID NOT NULL,
  "sourceIdentity" UUID NOT NULL,
  "lockVersion" BOOLEAN NOT NULL DEFAULT FALSE,
  CONSTRAINT "WebSourceIdentityFence_pkey" PRIMARY KEY ("projectId", "sourceIdentity"),
  CONSTRAINT "WebSourceIdentityFence_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES public."Project"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE FUNCTION public.web_source_identity_fence_touch() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  pair_project_ids UUID[] := ARRAY[]::UUID[];
  pair_source_ids UUID[] := ARRAY[]::UUID[];
  identity_pair RECORD;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    IF TG_TABLE_NAME = 'ProjectSource' THEN
      pair_project_ids := pg_catalog.array_append(pair_project_ids, OLD."projectId");
      pair_source_ids := pg_catalog.array_append(pair_source_ids, OLD."sourceIdentity");
    ELSIF TG_TABLE_NAME = 'WebSource' THEN
      pair_project_ids := pg_catalog.array_append(pair_project_ids, OLD."projectId");
      pair_source_ids := pg_catalog.array_append(pair_source_ids, OLD."id");
    ELSE
      pair_project_ids := pg_catalog.array_append(pair_project_ids, OLD."projectId");
      pair_source_ids := pg_catalog.array_append(pair_source_ids, OLD."webSourceId");
    END IF;
  END IF;

  IF TG_OP <> 'DELETE' THEN
    IF TG_TABLE_NAME = 'ProjectSource' THEN
      pair_project_ids := pg_catalog.array_append(pair_project_ids, NEW."projectId");
      pair_source_ids := pg_catalog.array_append(pair_source_ids, NEW."sourceIdentity");
    ELSIF TG_TABLE_NAME = 'WebSource' THEN
      pair_project_ids := pg_catalog.array_append(pair_project_ids, NEW."projectId");
      pair_source_ids := pg_catalog.array_append(pair_source_ids, NEW."id");
    ELSE
      pair_project_ids := pg_catalog.array_append(pair_project_ids, NEW."projectId");
      pair_source_ids := pg_catalog.array_append(pair_source_ids, NEW."webSourceId");
    END IF;
  END IF;

  FOR identity_pair IN
    SELECT DISTINCT pair_keys."projectId", pair_keys."sourceIdentity"
      FROM unnest(pair_project_ids, pair_source_ids) AS pair_keys("projectId", "sourceIdentity")
     WHERE pair_keys."projectId" IS NOT NULL
       AND pair_keys."sourceIdentity" IS NOT NULL
     ORDER BY pair_keys."projectId", pair_keys."sourceIdentity"
  LOOP
    IF EXISTS (
      SELECT 1 FROM public."Project" AS project_row WHERE project_row."id" = identity_pair."projectId"
    ) THEN
      INSERT INTO public."WebSourceIdentityFence" AS current_fence ("projectId", "sourceIdentity")
      VALUES (identity_pair."projectId", identity_pair."sourceIdentity")
      ON CONFLICT ("projectId", "sourceIdentity") DO UPDATE
        SET "lockVersion" = NOT current_fence."lockVersion";
    END IF;
  END LOOP;

  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.web_source_identity_fence_touch() FROM PUBLIC;
DO $$
DECLARE
  role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['ai_project_os_runtime', 'ai_project_os_entitlement_writer'] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = role_name) THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL ON FUNCTION public.web_source_identity_fence_touch() FROM %I',
        role_name
      );
    END IF;
  END LOOP;
END;
$$;

CREATE TRIGGER "ProjectSource_identity_fence_touch"
  AFTER INSERT OR UPDATE OR DELETE ON public."ProjectSource"
  FOR EACH ROW EXECUTE FUNCTION public.web_source_identity_fence_touch();
CREATE TRIGGER "WebSource_identity_fence_touch"
  AFTER INSERT OR UPDATE OR DELETE ON public."WebSource"
  FOR EACH ROW EXECUTE FUNCTION public.web_source_identity_fence_touch();
CREATE TRIGGER "WebSourcePointer_identity_fence_touch"
  AFTER INSERT OR UPDATE OR DELETE ON public."WebSourcePointer"
  FOR EACH ROW EXECUTE FUNCTION public.web_source_identity_fence_touch();

CREATE FUNCTION public.web_source_authenticated_lifecycle_guard() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."authenticationMode" = 'bearer'
       AND EXISTS (SELECT 1 FROM public."Project" AS project_row WHERE project_row."id" = OLD."projectId") THEN
      RAISE EXCEPTION 'authenticated web source identity cannot be deleted while its project exists'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD."authenticationMode" = 'bearer'
     AND (
       NEW."authenticationMode" IS DISTINCT FROM 'bearer'
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
DO $$
DECLARE
  role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['ai_project_os_runtime', 'ai_project_os_entitlement_writer'] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = role_name) THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL ON FUNCTION public.web_source_authenticated_lifecycle_guard() FROM %I',
        role_name
      );
    END IF;
  END LOOP;
END;
$$;
CREATE TRIGGER "WebSource_authenticated_lifecycle_guard"
  BEFORE UPDATE OR DELETE ON public."WebSource"
  FOR EACH ROW EXECUTE FUNCTION public.web_source_authenticated_lifecycle_guard();

DO $$
DECLARE
  source_identity RECORD;
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public."ProjectSource" AS project_source
      JOIN public."WebSource" AS web_source
        ON web_source."projectId" = project_source."projectId"
       AND web_source."id" = project_source."sourceIdentity"
     WHERE web_source."authenticationMode"::TEXT = 'bearer'
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
              AND revision."networkFingerprint" IS NOT DISTINCT FROM web_source."resolvedAddressFingerprint"
              AND revision."finalUrl" IS NOT DISTINCT FROM web_source."url"
              AND audit."decision"::TEXT = 'accepted'
              AND audit."configurationVersion" = revision."configurationVersion"
              AND audit."credentialFingerprint" = revision."credentialFingerprint"
              AND audit."configuredUrlFingerprint" = revision."configuredUrlFingerprint"
              AND audit."networkFingerprint" = revision."networkFingerprint"
              AND audit."contentHash" = revision."contentHash"
         )
       )
  ) THEN
    RAISE EXCEPTION 'existing active bearer project source lacks a current accepted review chain'
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

CREATE FUNCTION public.web_source_bearer_project_source_review_chain_guard() RETURNS trigger
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
    SELECT pair_keys."projectId", pair_keys."webSourceId"
      FROM unnest(pair_project_ids, pair_web_source_ids) AS pair_keys("projectId", "webSourceId")
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public."Project" AS project_row WHERE project_row."id" = identity_pair."projectId"
    ) THEN
      CONTINUE;
    END IF;

    IF TG_TABLE_NAME = 'ProjectSource' THEN
      SELECT EXISTS (
               SELECT 1 FROM public."WebSource" AS web_source
                WHERE web_source."projectId" = identity_pair."projectId"
                  AND web_source."id" = identity_pair."webSourceId"
                  AND web_source."authenticationMode"::TEXT = 'bearer'
             )
        INTO relevant_identity;
    ELSE
      SELECT EXISTS (
               SELECT 1 FROM public."WebSource" AS web_source
                WHERE web_source."projectId" = identity_pair."projectId"
                  AND web_source."id" = identity_pair."webSourceId"
                  AND web_source."authenticationMode"::TEXT = 'bearer'
             )
        INTO relevant_identity;
    END IF;

    -- With no bearer visible, unrelated source transactions may use their
    -- existing isolation level; the immediate identity fence arbitrates a
    -- concurrent bearer creation against that source identity.
    IF NOT relevant_identity THEN
      CONTINUE;
    END IF;

    IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
      RAISE EXCEPTION 'bearer project-source review-chain guard requires READ COMMITTED isolation'
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
         AND web_source."authenticationMode"::TEXT = 'bearer'
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
                AND revision."networkFingerprint" IS NOT DISTINCT FROM web_source."resolvedAddressFingerprint"
                AND revision."finalUrl" IS NOT DISTINCT FROM web_source."url"
                AND audit."decision"::TEXT = 'accepted'
                AND audit."configurationVersion" = revision."configurationVersion"
                AND audit."credentialFingerprint" = revision."credentialFingerprint"
                AND audit."configuredUrlFingerprint" = revision."configuredUrlFingerprint"
                AND audit."networkFingerprint" = revision."networkFingerprint"
                AND audit."contentHash" = revision."contentHash"
           )
         )
    ) THEN
      RAISE EXCEPTION 'active bearer project source requires a current accepted review chain'
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

CREATE CONSTRAINT TRIGGER "ProjectSource_bearer_review_chain_guard"
  AFTER INSERT OR UPDATE OR DELETE ON public."ProjectSource"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.web_source_bearer_project_source_review_chain_guard();

CREATE CONSTRAINT TRIGGER "WebSource_bearer_review_chain_guard"
  AFTER INSERT OR UPDATE OR DELETE ON public."WebSource"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.web_source_bearer_project_source_review_chain_guard();

CREATE CONSTRAINT TRIGGER "WebSourcePointer_bearer_review_chain_guard"
  AFTER INSERT OR UPDATE OR DELETE ON public."WebSourcePointer"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.web_source_bearer_project_source_review_chain_guard();

COMMIT;
