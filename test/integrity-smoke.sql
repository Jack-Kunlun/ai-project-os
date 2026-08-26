\set ON_ERROR_STOP on

DROP TABLE IF EXISTS pg_temp.integrity_smoke_baseline;

CREATE TEMP TABLE integrity_smoke_baseline (
  table_name text PRIMARY KEY,
  row_count bigint NOT NULL
) ON COMMIT PRESERVE ROWS;

INSERT INTO integrity_smoke_baseline (table_name, row_count)
SELECT 'Project', count(*)::bigint FROM "Project"
UNION ALL
SELECT 'ProjectSource', count(*)::bigint FROM "ProjectSource"
UNION ALL
SELECT 'ProjectItem', count(*)::bigint FROM "ProjectItem"
UNION ALL
SELECT 'ProjectScan', count(*)::bigint FROM "ProjectScan"
UNION ALL
SELECT 'ProjectSnapshot', count(*)::bigint FROM "ProjectSnapshot";

BEGIN;

-- These fixed IDs are used only inside this transaction. The final ROLLBACK
-- ensures that this smoke test never changes the local database.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Project" WHERE "id" IN ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'))
     OR EXISTS (SELECT 1 FROM "ProjectSource" WHERE "id" IN ('11111111-1111-4111-8111-111111111112', '22222222-2222-4222-8222-222222222223'))
     OR EXISTS (SELECT 1 FROM "ProjectItem" WHERE "id" IN ('11111111-1111-4111-8111-111111111114', '11111111-1111-4111-8111-111111111115', '22222222-2222-4222-8222-222222222225'))
     OR EXISTS (SELECT 1 FROM "ProjectScan" WHERE "id" IN ('11111111-1111-4111-8111-111111111113', '22222222-2222-4222-8222-222222222224'))
     OR EXISTS (SELECT 1 FROM "ProjectSnapshot" WHERE "id" = '11111111-1111-4111-8111-111111111116') THEN
    RAISE EXCEPTION 'fixed integrity smoke IDs already exist';
  END IF;
  RAISE NOTICE 'fixed integrity smoke IDs absent before writes: PASS';
END
$$;

INSERT INTO "Project" ("id", "name", "slug", "updatedAt")
VALUES
  ('11111111-1111-4111-8111-111111111111', 'Integrity Smoke A', 'integrity-smoke-a', CURRENT_TIMESTAMP),
  ('22222222-2222-4222-8222-222222222222', 'Integrity Smoke B', 'integrity-smoke-b', CURRENT_TIMESTAMP);

INSERT INTO "ProjectSource" ("id", "projectId", "kind", "contentText", "contentHash")
VALUES
  ('11111111-1111-4111-8111-111111111112', '11111111-1111-4111-8111-111111111111', 'manual', 'source A', 'integrity-smoke-source-a'),
  ('22222222-2222-4222-8222-222222222223', '22222222-2222-4222-8222-222222222222', 'manual', 'source B', 'integrity-smoke-source-b');

INSERT INTO "ProjectScan" ("id", "projectId", "trigger", "status")
VALUES
  ('11111111-1111-4111-8111-111111111113', '11111111-1111-4111-8111-111111111111', 'manual', 'completed'),
  ('22222222-2222-4222-8222-222222222224', '22222222-2222-4222-8222-222222222222', 'manual', 'completed');

-- Same-project source, supersession, and scan relationships must succeed.
INSERT INTO "ProjectItem" ("id", "projectId", "type", "sourceId", "title", "content", "updatedAt")
VALUES
  ('11111111-1111-4111-8111-111111111114', '11111111-1111-4111-8111-111111111111', 'decision', '11111111-1111-4111-8111-111111111112', 'Item A1', 'same-project source', CURRENT_TIMESTAMP);

INSERT INTO "ProjectItem" ("id", "projectId", "type", "sourceId", "supersedesItemId", "title", "content", "updatedAt")
VALUES
  ('11111111-1111-4111-8111-111111111115', '11111111-1111-4111-8111-111111111111', 'progress', '11111111-1111-4111-8111-111111111112', '11111111-1111-4111-8111-111111111114', 'Item A2', 'same-project supersession', CURRENT_TIMESTAMP),
  ('22222222-2222-4222-8222-222222222225', '22222222-2222-4222-8222-222222222222', 'progress', '22222222-2222-4222-8222-222222222223', NULL, 'Item B1', 'same-project source', CURRENT_TIMESTAMP);

INSERT INTO "ProjectSnapshot" ("id", "projectId", "scanId", "payload")
VALUES ('11111111-1111-4111-8111-111111111116', '11111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111113', '{}'::jsonb);

SET CONSTRAINTS ALL IMMEDIATE;
\echo 'same-project relationships: PASS'

-- A ProjectItem in A must not point to B's source. The deferred constraint is
-- intentionally forced to immediate so PostgreSQL returns SQLSTATE 23503.
SET CONSTRAINTS "ProjectItem_projectId_sourceId_fkey" DEFERRED;
DO $$
DECLARE
  actual_state text;
BEGIN
  BEGIN
    INSERT INTO "ProjectItem" ("id", "projectId", "type", "sourceId", "title", "content", "updatedAt")
    VALUES ('11111111-1111-4111-8111-111111111117', '11111111-1111-4111-8111-111111111111', 'issue', '22222222-2222-4222-8222-222222222223', 'Cross-source', 'must fail', CURRENT_TIMESTAMP);
    SET CONSTRAINTS "ProjectItem_projectId_sourceId_fkey" IMMEDIATE;
    RAISE EXCEPTION 'cross-project source relationship unexpectedly succeeded';
  EXCEPTION
    WHEN foreign_key_violation THEN
      GET STACKED DIAGNOSTICS actual_state = RETURNED_SQLSTATE;
      IF actual_state <> '23503' THEN
        RAISE EXCEPTION 'cross-project source returned SQLSTATE %', actual_state;
      END IF;
      RAISE NOTICE 'cross-project source: PASS (23503)';
  END;
END
$$;

-- A ProjectItem in A must not supersede an item in B.
SET CONSTRAINTS "ProjectItem_projectId_supersedesItemId_fkey" DEFERRED;
DO $$
DECLARE
  actual_state text;
BEGIN
  BEGIN
    INSERT INTO "ProjectItem" ("id", "projectId", "type", "sourceId", "supersedesItemId", "title", "content", "updatedAt")
    VALUES ('11111111-1111-4111-8111-111111111118', '11111111-1111-4111-8111-111111111111', 'risk', '11111111-1111-4111-8111-111111111112', '22222222-2222-4222-8222-222222222225', 'Cross-supersession', 'must fail', CURRENT_TIMESTAMP);
    SET CONSTRAINTS "ProjectItem_projectId_supersedesItemId_fkey" IMMEDIATE;
    RAISE EXCEPTION 'cross-project supersession unexpectedly succeeded';
  EXCEPTION
    WHEN foreign_key_violation THEN
      GET STACKED DIAGNOSTICS actual_state = RETURNED_SQLSTATE;
      IF actual_state <> '23503' THEN
        RAISE EXCEPTION 'cross-project supersession returned SQLSTATE %', actual_state;
      END IF;
      RAISE NOTICE 'cross-project supersession: PASS (23503)';
  END;
END
$$;

-- A ProjectSnapshot in A must not point to B's scan.
SET CONSTRAINTS "ProjectSnapshot_projectId_scanId_fkey" DEFERRED;
DO $$
DECLARE
  actual_state text;
BEGIN
  BEGIN
    INSERT INTO "ProjectSnapshot" ("id", "projectId", "scanId", "payload")
    VALUES ('11111111-1111-4111-8111-111111111119', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222224', '{}'::jsonb);
    SET CONSTRAINTS "ProjectSnapshot_projectId_scanId_fkey" IMMEDIATE;
    RAISE EXCEPTION 'cross-project scan relationship unexpectedly succeeded';
  EXCEPTION
    WHEN foreign_key_violation THEN
      GET STACKED DIAGNOSTICS actual_state = RETURNED_SQLSTATE;
      IF actual_state <> '23503' THEN
        RAISE EXCEPTION 'cross-project scan returned SQLSTATE %', actual_state;
      END IF;
      RAISE NOTICE 'cross-project scan: PASS (23503)';
  END;
END
$$;

-- Referenced rows cannot be deleted while deferred NoAction constraints are
-- forced to immediate inside the same transaction.
SET CONSTRAINTS "ProjectItem_projectId_sourceId_fkey" DEFERRED;
DO $$
DECLARE
  actual_state text;
BEGIN
  BEGIN
    DELETE FROM "ProjectSource" WHERE "id" = '11111111-1111-4111-8111-111111111112';
    SET CONSTRAINTS "ProjectItem_projectId_sourceId_fkey" IMMEDIATE;
    RAISE EXCEPTION 'referenced source delete unexpectedly succeeded';
  EXCEPTION
    WHEN foreign_key_violation THEN
      GET STACKED DIAGNOSTICS actual_state = RETURNED_SQLSTATE;
      IF actual_state <> '23503' THEN
        RAISE EXCEPTION 'referenced source delete returned SQLSTATE %', actual_state;
      END IF;
      RAISE NOTICE 'referenced source delete: PASS (23503)';
  END;
END
$$;

SET CONSTRAINTS "ProjectItem_projectId_supersedesItemId_fkey" DEFERRED;
DO $$
DECLARE
  actual_state text;
BEGIN
  BEGIN
    DELETE FROM "ProjectItem" WHERE "id" = '11111111-1111-4111-8111-111111111114';
    SET CONSTRAINTS "ProjectItem_projectId_supersedesItemId_fkey" IMMEDIATE;
    RAISE EXCEPTION 'referenced prior item delete unexpectedly succeeded';
  EXCEPTION
    WHEN foreign_key_violation THEN
      GET STACKED DIAGNOSTICS actual_state = RETURNED_SQLSTATE;
      IF actual_state <> '23503' THEN
        RAISE EXCEPTION 'referenced prior item delete returned SQLSTATE %', actual_state;
      END IF;
      RAISE NOTICE 'referenced prior item delete: PASS (23503)';
  END;
END
$$;

SET CONSTRAINTS "ProjectSnapshot_projectId_scanId_fkey" DEFERRED;
DO $$
DECLARE
  actual_state text;
BEGIN
  BEGIN
    DELETE FROM "ProjectScan" WHERE "id" = '11111111-1111-4111-8111-111111111113';
    SET CONSTRAINTS "ProjectSnapshot_projectId_scanId_fkey" IMMEDIATE;
    RAISE EXCEPTION 'referenced scan delete unexpectedly succeeded';
  EXCEPTION
    WHEN foreign_key_violation THEN
      GET STACKED DIAGNOSTICS actual_state = RETURNED_SQLSTATE;
      IF actual_state <> '23503' THEN
        RAISE EXCEPTION 'referenced scan delete returned SQLSTATE %', actual_state;
      END IF;
      RAISE NOTICE 'referenced scan delete: PASS (23503)';
  END;
END
$$;

-- Project-root Cascade must remove its full same-project graph even though
-- the cross-table links are deferred NoAction.
DELETE FROM "Project" WHERE "id" IN ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222');
SET CONSTRAINTS ALL IMMEDIATE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Project" WHERE "id" IN ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'))
     OR EXISTS (SELECT 1 FROM "ProjectSource" WHERE "id" IN ('11111111-1111-4111-8111-111111111112', '22222222-2222-4222-8222-222222222223'))
     OR EXISTS (SELECT 1 FROM "ProjectItem" WHERE "id" IN ('11111111-1111-4111-8111-111111111114', '11111111-1111-4111-8111-111111111115', '22222222-2222-4222-8222-222222222225'))
     OR EXISTS (SELECT 1 FROM "ProjectScan" WHERE "id" IN ('11111111-1111-4111-8111-111111111113', '22222222-2222-4222-8222-222222222224'))
     OR EXISTS (SELECT 1 FROM "ProjectSnapshot" WHERE "id" IN ('11111111-1111-4111-8111-111111111116')) THEN
    RAISE EXCEPTION 'project-root cascade left smoke rows behind';
  END IF;
  RAISE NOTICE 'project-root cascade: PASS';
END
$$;

ROLLBACK;

DO $$
DECLARE
  mismatch_details text;
BEGIN
  SELECT string_agg(
           format('%s before=%s after=%s', baseline.table_name, baseline.row_count, current_counts.row_count),
           ', '
           ORDER BY baseline.table_name
         )
    INTO mismatch_details
  FROM integrity_smoke_baseline AS baseline
  JOIN (
    SELECT 'Project'::text AS table_name, count(*)::bigint AS row_count FROM "Project"
    UNION ALL
    SELECT 'ProjectSource', count(*)::bigint FROM "ProjectSource"
    UNION ALL
    SELECT 'ProjectItem', count(*)::bigint FROM "ProjectItem"
    UNION ALL
    SELECT 'ProjectScan', count(*)::bigint FROM "ProjectScan"
    UNION ALL
    SELECT 'ProjectSnapshot', count(*)::bigint FROM "ProjectSnapshot"
  ) AS current_counts USING (table_name)
  WHERE baseline.row_count <> current_counts.row_count;

  IF mismatch_details IS NOT NULL THEN
    RAISE EXCEPTION 'integrity smoke changed persistent row counts: %', mismatch_details;
  END IF;

  IF EXISTS (SELECT 1 FROM "Project" WHERE "id" IN ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'))
     OR EXISTS (SELECT 1 FROM "ProjectSource" WHERE "id" IN ('11111111-1111-4111-8111-111111111112', '22222222-2222-4222-8222-222222222223'))
     OR EXISTS (SELECT 1 FROM "ProjectItem" WHERE "id" IN ('11111111-1111-4111-8111-111111111114', '11111111-1111-4111-8111-111111111115', '22222222-2222-4222-8222-222222222225'))
     OR EXISTS (SELECT 1 FROM "ProjectScan" WHERE "id" IN ('11111111-1111-4111-8111-111111111113', '22222222-2222-4222-8222-222222222224'))
     OR EXISTS (SELECT 1 FROM "ProjectSnapshot" WHERE "id" = '11111111-1111-4111-8111-111111111116') THEN
    RAISE EXCEPTION 'integrity smoke fixed IDs survived ROLLBACK';
  END IF;
  RAISE NOTICE 'post-ROLLBACK persistent data: PASS (five table counts unchanged; fixed IDs absent)';
END
$$;

DROP TABLE integrity_smoke_baseline;
