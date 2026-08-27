CREATE OR REPLACE FUNCTION "github_material_sync_terminal_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD."status" NOT IN ('queued', 'running') AND NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'terminal material sync run is immutable'
            USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'queued' AND NEW."status" = 'running'
        AND NEW."stage" <> 'freezing' THEN
        RAISE EXCEPTION 'material sync must enter freezing first'
            USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'running' AND NEW."status" = 'running'
        AND array_position(
            ARRAY['freezing', 'fetching', 'scanning', 'publishing']::"GitHubMaterialSyncStage"[],
            NEW."stage"
        ) < array_position(
            ARRAY['freezing', 'fetching', 'scanning', 'publishing']::"GitHubMaterialSyncStage"[],
            OLD."stage"
        ) THEN
        RAISE EXCEPTION 'material sync stage cannot move backward'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "GitHubMaterialSyncRun_terminal_immutable_trigger"
BEFORE UPDATE ON "GitHubMaterialSyncRun"
FOR EACH ROW EXECUTE FUNCTION "github_material_sync_terminal_guard"();

CREATE OR REPLACE FUNCTION "repository_material_generation_terminal_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD."status" = 'complete' AND NEW."status" = 'superseded' THEN
        IF (to_jsonb(NEW) - 'status' - 'supersededAt') IS DISTINCT FROM
           (to_jsonb(OLD) - 'status' - 'supersededAt') THEN
            RAISE EXCEPTION 'material generation supersession may only seal status'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;
    IF OLD."status" IN ('complete', 'failed', 'ineligible', 'superseded')
        AND NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'terminal material generation is immutable'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "RepositoryMaterialGeneration_terminal_immutable_trigger"
BEFORE UPDATE ON "RepositoryMaterialGeneration"
FOR EACH ROW EXECUTE FUNCTION "repository_material_generation_terminal_guard"();
