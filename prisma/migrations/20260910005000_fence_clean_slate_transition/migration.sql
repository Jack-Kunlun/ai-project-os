-- Fence legacy writes before the clean-slate AI provider migration.
--
-- The deployment preflight proves that no legacy rows exist before migration,
-- but another database client could otherwise write between that check and the
-- later destructive DDL. These triggers close that interval at the database
-- boundary. They intentionally use JSONB inspection so the two surviving
-- triggers remain valid after the legacy enum values and columns are removed.

CREATE OR REPLACE FUNCTION "clean_slate_transition_write_fence"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  row_data JSONB := to_jsonb(NEW);
BEGIN
  IF TG_TABLE_NAME = 'AppUser'
     AND row_data ->> 'role' = 'member' THEN
    RAISE EXCEPTION 'CLEAN_SLATE_TRANSITION_WRITE_FENCED'
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_TABLE_NAME = 'AiProviderConnection'
     AND (
       row_data ->> 'scope' = 'workspace'
       OR (row_data ? 'workspaceId' AND row_data ->> 'workspaceId' IS NOT NULL)
     ) THEN
    RAISE EXCEPTION 'CLEAN_SLATE_TRANSITION_WRITE_FENCED'
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_TABLE_NAME IN (
    'ProjectAiRoute',
    'ProjectAiRouteRevision',
    'AiProviderOwnershipAudit'
  ) THEN
    RAISE EXCEPTION 'CLEAN_SLATE_TRANSITION_WRITE_FENCED'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "AppUser_clean_slate_transition_write_fence"
BEFORE INSERT OR UPDATE ON "AppUser"
FOR EACH ROW
EXECUTE FUNCTION "clean_slate_transition_write_fence"();

CREATE TRIGGER "AiProviderConnection_clean_slate_transition_write_fence"
BEFORE INSERT OR UPDATE ON "AiProviderConnection"
FOR EACH ROW
EXECUTE FUNCTION "clean_slate_transition_write_fence"();

-- A database that already applied the original clean-slate migration can see
-- this newly inserted migration as pending. In that legitimate 101 -> 102
-- path the removed relations are absent, so each legacy-only trigger is a
-- safe no-op. The supported 50 -> 102 production path still has all three
-- relations and installs every fence before destructive DDL begins.
DO $$
BEGIN
  IF to_regclass('public."ProjectAiRoute"') IS NOT NULL THEN
    EXECUTE $trigger$
      CREATE TRIGGER "ProjectAiRoute_clean_slate_transition_write_fence"
      BEFORE INSERT OR UPDATE ON "ProjectAiRoute"
      FOR EACH ROW
      EXECUTE FUNCTION "clean_slate_transition_write_fence"()
    $trigger$;
  END IF;

  IF to_regclass('public."ProjectAiRouteRevision"') IS NOT NULL THEN
    EXECUTE $trigger$
      CREATE TRIGGER "ProjectAiRouteRevision_clean_slate_transition_write_fence"
      BEFORE INSERT OR UPDATE ON "ProjectAiRouteRevision"
      FOR EACH ROW
      EXECUTE FUNCTION "clean_slate_transition_write_fence"()
    $trigger$;
  END IF;

  IF to_regclass('public."AiProviderOwnershipAudit"') IS NOT NULL THEN
    EXECUTE $trigger$
      CREATE TRIGGER "AiProviderOwnershipAudit_clean_slate_transition_write_fence"
      BEFORE INSERT OR UPDATE ON "AiProviderOwnershipAudit"
      FOR EACH ROW
      EXECUTE FUNCTION "clean_slate_transition_write_fence"()
    $trigger$;
  END IF;
END;
$$;
