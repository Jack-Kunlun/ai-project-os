-- R-06 / ADM-003: persist the explicit first-admin readiness acknowledgement.
--
-- NULL means that the first administrator still needs to review the existing
-- readiness checklist.  Existing initialized deployments are treated as
-- already acknowledged so this feature does not retroactively interrupt them;
-- a fresh default workspace remains NULL until setup is completed.
ALTER TABLE "Workspace"
  ADD COLUMN "initialAdminOnboardingCompletedAt" TIMESTAMP(3);

UPDATE "Workspace"
   SET "initialAdminOnboardingCompletedAt" = "updatedAt"
 WHERE "id" = '00000000-0000-4000-8000-000000000001'
   AND EXISTS (
     SELECT 1
       FROM "AppUser"
      WHERE "role" = 'admin'
   );

-- Completion is a one-way state transition.  The service performs the
-- authenticated actor/version checks and sets the transaction-local context;
-- under the trusted runtime-principal model this trigger rejects writes that
-- omit that context and prevents non-default workspaces from carrying markers.
CREATE OR REPLACE FUNCTION "first_admin_onboarding_completion_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_row RECORD;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."initialAdminOnboardingCompletedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'first-admin onboarding completion must start NULL'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."initialAdminOnboardingCompletedAt" IS NOT DISTINCT FROM NEW."initialAdminOnboardingCompletedAt" THEN
    RETURN NEW;
  END IF;

  IF OLD."initialAdminOnboardingCompletedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'first-admin onboarding completion is immutable'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."initialAdminOnboardingCompletedAt" IS NULL
     OR NEW."id" <> '00000000-0000-4000-8000-000000000001'::uuid
     OR current_setting('app.first_admin_onboarding_context', true) IS DISTINCT FROM '1'
     OR NEW."createdById"::text IS DISTINCT FROM current_setting('app.first_admin_onboarding_actor_id', true)
  THEN
    RAISE EXCEPTION 'first-admin onboarding completion requires the authenticated default owner'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT user_row."role", user_row."disabledAt"
    INTO actor_row
    FROM "AppUser" user_row
   WHERE user_row."id" = current_setting('app.first_admin_onboarding_actor_id', true)::uuid;
  IF NOT FOUND OR actor_row."role" <> 'admin' OR actor_row."disabledAt" IS NOT NULL THEN
    RAISE EXCEPTION 'first-admin onboarding actor is not an enabled administrator'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Workspace_first_admin_onboarding_completion_guard"
BEFORE INSERT OR UPDATE OF "initialAdminOnboardingCompletedAt" ON "Workspace"
FOR EACH ROW EXECUTE FUNCTION "first_admin_onboarding_completion_guard"();

-- Trigger functions are not an application API.
REVOKE ALL ON FUNCTION "first_admin_onboarding_completion_guard"() FROM PUBLIC;
