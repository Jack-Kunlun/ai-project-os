\set ON_ERROR_STOP on

DO $$
DECLARE
  actual_count bigint;
BEGIN
  SELECT count(*) INTO actual_count
  FROM pg_constraint c
  WHERE c.contype = 'f'
    AND c.confdeltype = 'c'
    AND (c.conname, c.conrelid::regclass::text, c.confrelid::regclass::text) IN (
      ('ProjectSource_projectId_fkey', '"ProjectSource"', '"Project"'),
      ('ProjectItem_projectId_fkey', '"ProjectItem"', '"Project"'),
      ('ProjectScan_projectId_fkey', '"ProjectScan"', '"Project"'),
      ('ProjectSnapshot_projectId_fkey', '"ProjectSnapshot"', '"Project"')
    );

  IF actual_count <> 4 THEN
    RAISE EXCEPTION 'expected four Project-root Cascade FKs, found %', actual_count;
  END IF;
  RAISE NOTICE 'root Cascade foreign keys: PASS (4)';

  SELECT count(*) INTO actual_count
  FROM pg_constraint c
  WHERE c.contype = 'f'
    AND c.confdeltype = 'a'
    AND c.condeferrable
    AND c.condeferred
    AND (c.conname, c.conrelid::regclass::text, c.confrelid::regclass::text) IN (
      ('ProjectItem_projectId_sourceId_fkey', '"ProjectItem"', '"ProjectSource"'),
      ('ProjectItem_projectId_supersedesItemId_fkey', '"ProjectItem"', '"ProjectItem"'),
      ('ProjectSnapshot_projectId_scanId_fkey', '"ProjectSnapshot"', '"ProjectScan"')
    );

  IF actual_count <> 3 THEN
    RAISE EXCEPTION 'expected three deferred NoAction FKs, found %', actual_count;
  END IF;
  RAISE NOTICE 'deferred NoAction foreign keys: PASS (3)';

  SELECT count(*) INTO actual_count
  FROM pg_attribute a
  WHERE a.attrelid = '"ProjectItem"'::regclass
    AND a.attname = 'sourceId'
    AND a.attnotnull;

  IF actual_count <> 1 THEN
    RAISE EXCEPTION 'ProjectItem.sourceId is not NOT NULL';
  END IF;
  RAISE NOTICE 'ProjectItem.sourceId NOT NULL: PASS';

  SELECT count(*) INTO actual_count
  FROM pg_index i
  JOIN pg_class idx ON idx.oid = i.indexrelid
  JOIN pg_class tbl ON tbl.oid = i.indrelid
  WHERE i.indisunique
    AND i.indnkeyatts = 2
    AND pg_get_indexdef(i.indexrelid) LIKE '%("projectId", id)%'
    AND (tbl.relname, idx.relname) IN (
      ('ProjectSource', 'ProjectSource_projectId_id_key'),
      ('ProjectItem', 'ProjectItem_projectId_id_key'),
      ('ProjectScan', 'ProjectScan_projectId_id_key')
    );

  IF actual_count <> 3 THEN
    RAISE EXCEPTION 'expected three project/id unique indexes, found %', actual_count;
  END IF;
  RAISE NOTICE 'project/id unique indexes: PASS (3)';
END
$$;

WITH relationship_violations AS (
  SELECT count(*)::bigint AS count
  FROM "ProjectItem" i
  JOIN "ProjectSource" s ON s."id" = i."sourceId"
  WHERE i."projectId" <> s."projectId"
  UNION ALL
  SELECT count(*)::bigint
  FROM "ProjectItem" i
  JOIN "ProjectItem" prior ON prior."id" = i."supersedesItemId"
  WHERE i."projectId" <> prior."projectId"
  UNION ALL
  SELECT count(*)::bigint
  FROM "ProjectSnapshot" snapshot
  JOIN "ProjectScan" scan ON scan."id" = snapshot."scanId"
  WHERE snapshot."projectId" <> scan."projectId"
)
SELECT count AS relationship_violation_count
FROM relationship_violations;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "ProjectItem" i
    JOIN "ProjectSource" s ON s."id" = i."sourceId"
    WHERE i."projectId" <> s."projectId"
  ) OR EXISTS (
    SELECT 1
    FROM "ProjectItem" i
    JOIN "ProjectItem" prior ON prior."id" = i."supersedesItemId"
    WHERE i."projectId" <> prior."projectId"
  ) OR EXISTS (
    SELECT 1
    FROM "ProjectSnapshot" snapshot
    JOIN "ProjectScan" scan ON scan."id" = snapshot."scanId"
    WHERE snapshot."projectId" <> scan."projectId"
  ) THEN
    RAISE EXCEPTION 'relationship violation count is non-zero';
  END IF;
  RAISE NOTICE 'relationship violation count: PASS (0)';
END
$$;
