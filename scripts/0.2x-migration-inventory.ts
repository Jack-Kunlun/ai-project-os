import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { Client } from "pg";
import {
  buildOwnershipInventoryFailure,
  buildOwnershipInventoryReport,
  INVENTORY_TABLES,
  REQUIRED_CONSTRAINTS,
  REQUIRED_ENUMS,
  REQUIRED_MIGRATIONS,
  OwnershipInventoryError,
  parseOwnershipInventoryArguments,
  readOwnershipInventoryDatabaseConfig,
  safeOwnershipInventoryErrorCode,
  type CountValue,
  type AccountAggregateRow,
  type ActiveVectorIndexAggregateRow,
  type LegacyGitHubAggregateRow,
  type McpAggregateRow,
  type OwnershipInventoryReport,
  type OwnershipInventoryRows,
  type OwnershipAggregateRow,
  type PlatformDefaultRouteAggregateRow,
  type PlatformTokenGrantAggregateRow,
  type ProviderAggregateRow,
} from "./0.2x-migration-inventory-contract";
import { readCliArguments } from "./cli-arguments";

export interface InventoryQueryClient {
  query<Row = unknown>(text: string, values?: readonly unknown[]): Promise<{ rows: readonly Row[] }>;
}

interface MigrationPreflightRow {
  migration_name: string;
  applied: boolean;
  applied_migration_count: CountValue;
}

interface ConstraintPreflightRow {
  constraint_name: string;
  relation_name: string;
  constraint_type: string;
  validated: boolean;
}

interface EnumPreflightRow {
  enum_name: string;
  enum_value: string;
  enum_sort_order: number | string;
}

interface RlsPreflightRow {
  relation_name: string;
  row_security: boolean;
  force_row_security: boolean;
}

interface RolePreflightRow {
  role_name: string;
  is_superuser: boolean;
  bypass_rls: boolean;
  can_replicate: boolean;
  owns_database: boolean;
  owns_schema: boolean;
  owns_target_table: boolean;
  can_create_database: boolean;
  can_create_database_role: boolean;
  can_create_role: boolean;
  can_create_schema: boolean;
  can_create_temporary: boolean;
  role_default_transaction_read_only: boolean;
  database_default_transaction_read_only: boolean;
  has_database_role_read_only_override: boolean;
  default_transaction_read_only: string;
  can_select_target: boolean;
  has_unapproved_select: boolean;
  can_insert_target: boolean;
  can_update_target: boolean;
  can_delete_target: boolean;
  can_truncate_target: boolean;
  can_references_target: boolean;
  can_trigger_target: boolean;
}

const SQL = Object.freeze({
  begin: "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
  searchPath: "SET LOCAL search_path = pg_catalog, public",
  rollback: "ROLLBACK",
  transactionReadOnly: `
    SELECT current_setting('transaction_read_only') AS transaction_read_only
  `,
  migrations: `
    SELECT expected."migration_name" AS migration_name,
           EXISTS (
             SELECT 1
             FROM "_prisma_migrations" AS migration
             WHERE migration."migration_name" = expected."migration_name"
               AND migration."finished_at" IS NOT NULL
               AND migration."rolled_back_at" IS NULL
           ) AS applied,
           (
             SELECT COUNT(*)::bigint
             FROM "_prisma_migrations" AS applied_migration
             WHERE applied_migration."finished_at" IS NOT NULL
               AND applied_migration."rolled_back_at" IS NULL
           ) AS applied_migration_count
      FROM unnest($1::text[]) WITH ORDINALITY
        AS expected("migration_name", ordinal)
     ORDER BY expected.ordinal
  `,
  constraints: `
    SELECT constraint_meta.conname AS constraint_name,
           relation_meta.relname AS relation_name,
           constraint_meta.contype::text AS constraint_type,
           constraint_meta.convalidated AS validated
      FROM pg_constraint AS constraint_meta
      JOIN pg_class AS relation_meta
        ON relation_meta.oid = constraint_meta.conrelid
      JOIN pg_namespace AS namespace_meta
        ON namespace_meta.oid = relation_meta.relnamespace
     WHERE namespace_meta.nspname = 'public'
       AND constraint_meta.conname = ANY($1::text[])
       AND relation_meta.relname = ANY($2::text[])
       AND constraint_meta.contype = 'c'
     ORDER BY array_position($1::text[], constraint_meta.conname)
  `,
  enums: `
    SELECT type_meta.typname AS enum_name,
           enum_meta.enumlabel AS enum_value,
           enum_meta.enumsortorder AS enum_sort_order
      FROM pg_type AS type_meta
      JOIN pg_enum AS enum_meta
        ON enum_meta.enumtypid = type_meta.oid
      JOIN pg_namespace AS namespace_meta
        ON namespace_meta.oid = type_meta.typnamespace
     WHERE namespace_meta.nspname = 'public'
       AND type_meta.typname = ANY($1::text[])
     ORDER BY array_position($1::text[], type_meta.typname), enum_meta.enumsortorder
  `,
  rls: `
    SELECT relation_meta.relname AS relation_name,
           relation_meta.relrowsecurity AS row_security,
           relation_meta.relforcerowsecurity AS force_row_security
      FROM pg_class AS relation_meta
      JOIN pg_namespace AS namespace_meta
        ON namespace_meta.oid = relation_meta.relnamespace
     WHERE namespace_meta.nspname = 'public'
       AND relation_meta.relkind IN ('r', 'p')
       AND relation_meta.relname = ANY($1::text[])
     ORDER BY array_position($1::text[], relation_meta.relname)
  `,
  role: `
    SELECT role_meta.rolname AS role_name,
           role_meta.rolsuper AS is_superuser,
           role_meta.rolbypassrls AS bypass_rls,
           role_meta.rolreplication AS can_replicate,
           database_meta.datdba = role_meta.oid AS owns_database,
           namespace_meta.nspowner = role_meta.oid AS owns_schema,
           EXISTS (
             SELECT 1
               FROM pg_class AS target_meta
              WHERE target_meta.relnamespace = namespace_meta.oid
                AND target_meta.relkind IN ('r', 'p')
                AND target_meta.relname = ANY($1::text[])
                AND target_meta.relowner = role_meta.oid
           ) AS owns_target_table,
           has_database_privilege(current_user, current_database(), 'CREATE') AS can_create_database,
           role_meta.rolcreatedb AS can_create_database_role,
           role_meta.rolcreaterole AS can_create_role,
           has_database_privilege(current_user, current_database(), 'TEMPORARY') AS can_create_temporary,
           EXISTS (
             SELECT 1
               FROM unnest(COALESCE(role_meta.rolconfig, ARRAY[]::text[])) AS role_setting(setting)
              WHERE split_part(role_setting.setting, '=', 1) = 'default_transaction_read_only'
                AND lower(split_part(role_setting.setting, '=', 2)) IN ('on', 'true', '1')
           ) AS role_default_transaction_read_only,
           EXISTS (
             SELECT 1
               FROM pg_db_role_setting AS database_setting
              WHERE database_setting.setdatabase = database_meta.oid
                AND database_setting.setrole = 0
                AND EXISTS (
                  SELECT 1
                    FROM unnest(COALESCE(database_setting.setconfig, ARRAY[]::text[])) AS setting(value)
                   WHERE split_part(setting.value, '=', 1) = 'default_transaction_read_only'
                     AND lower(split_part(setting.value, '=', 2)) IN ('on', 'true', '1')
                )
           ) AS database_default_transaction_read_only,
           EXISTS (
             SELECT 1
               FROM pg_db_role_setting AS database_role_setting
              WHERE database_role_setting.setdatabase IN (0, database_meta.oid)
                AND database_role_setting.setrole IN (0, role_meta.oid)
                AND NOT (
                  database_role_setting.setdatabase = 0
                  AND database_role_setting.setrole = role_meta.oid
                )
                AND EXISTS (
                  SELECT 1
                    FROM unnest(COALESCE(database_role_setting.setconfig, ARRAY[]::text[])) AS override_setting(setting)
                   WHERE split_part(override_setting.setting, '=', 1) = 'default_transaction_read_only'
                )
           ) AS has_database_role_read_only_override,
           current_setting('default_transaction_read_only') AS default_transaction_read_only,
           has_schema_privilege(current_user, 'public', 'CREATE') AS can_create_schema,
           NOT EXISTS (
             SELECT 1
               FROM unnest($1::text[]) AS expected_table(table_name)
              WHERE NOT EXISTS (
                SELECT 1
                  FROM pg_class AS target_meta
                 WHERE target_meta.relnamespace = namespace_meta.oid
                   AND target_meta.relkind IN ('r', 'p')
                   AND target_meta.relname = expected_table.table_name
                   AND has_table_privilege(current_user, target_meta.oid, 'SELECT')
              )
           ) AS can_select_target,
           EXISTS (
             SELECT 1
               FROM pg_class AS visible_table
              WHERE visible_table.relnamespace = namespace_meta.oid
                AND visible_table.relkind IN ('r', 'p')
                AND has_table_privilege(current_user, visible_table.oid, 'SELECT')
                AND NOT (visible_table.relname = ANY($1::text[]))
           ) AS has_unapproved_select,
           EXISTS (
             SELECT 1
               FROM pg_class AS target_meta
              WHERE target_meta.relnamespace = namespace_meta.oid
                AND target_meta.relkind IN ('r', 'p')
                AND target_meta.relname = ANY($1::text[])
                AND has_table_privilege(current_user, target_meta.oid, 'INSERT')
           ) AS can_insert_target,
           EXISTS (
             SELECT 1
               FROM pg_class AS target_meta
              WHERE target_meta.relnamespace = namespace_meta.oid
                AND target_meta.relkind IN ('r', 'p')
                AND target_meta.relname = ANY($1::text[])
                AND has_table_privilege(current_user, target_meta.oid, 'UPDATE')
           ) AS can_update_target,
           EXISTS (
             SELECT 1
               FROM pg_class AS target_meta
              WHERE target_meta.relnamespace = namespace_meta.oid
                AND target_meta.relkind IN ('r', 'p')
                AND target_meta.relname = ANY($1::text[])
                AND has_table_privilege(current_user, target_meta.oid, 'DELETE')
           ) AS can_delete_target,
           EXISTS (
             SELECT 1
               FROM pg_class AS target_meta
              WHERE target_meta.relnamespace = namespace_meta.oid
                AND target_meta.relkind IN ('r', 'p')
                AND target_meta.relname = ANY($1::text[])
                AND has_table_privilege(current_user, target_meta.oid, 'TRUNCATE')
           ) AS can_truncate_target,
           EXISTS (
             SELECT 1
               FROM pg_class AS target_meta
              WHERE target_meta.relnamespace = namespace_meta.oid
                AND target_meta.relkind IN ('r', 'p')
                AND target_meta.relname = ANY($1::text[])
                AND has_table_privilege(current_user, target_meta.oid, 'REFERENCES')
           ) AS can_references_target,
           EXISTS (
             SELECT 1
               FROM pg_class AS target_meta
              WHERE target_meta.relnamespace = namespace_meta.oid
                AND target_meta.relkind IN ('r', 'p')
                AND target_meta.relname = ANY($1::text[])
                AND has_table_privilege(current_user, target_meta.oid, 'TRIGGER')
           ) AS can_trigger_target
      FROM pg_roles AS role_meta
      JOIN pg_database AS database_meta
        ON database_meta.datname = current_database()
      JOIN pg_namespace AS namespace_meta
        ON namespace_meta.nspname = 'public'
     WHERE role_meta.rolname = current_user
  `,
  accounts: `
    SELECT COUNT(*)::bigint AS total,
           COUNT(*) FILTER (WHERE "role" = 'admin')::bigint AS admin,
           COUNT(*) FILTER (WHERE "role" = 'member')::bigint AS legacy_member,
           COUNT(*) FILTER (WHERE "role" = 'user')::bigint AS "user",
           COUNT(*) FILTER (WHERE "role" NOT IN ('admin', 'member', 'user'))::bigint AS invalid,
           COUNT(*) FILTER (WHERE "disabledAt" IS NULL)::bigint AS enabled,
           COUNT(*) FILTER (WHERE "disabledAt" IS NOT NULL)::bigint AS disabled,
           (SELECT COUNT(*)::bigint
              FROM "PlatformGrantOfferPolicy"
             WHERE "status" = 'active') AS active_offer_policies,
           (SELECT COUNT(*)::bigint
              FROM "AppUser" AS enabled_user
             WHERE enabled_user."disabledAt" IS NULL
               AND NOT EXISTS (
                 SELECT 1 FROM "PlatformTokenGrant" AS token_grant
                  WHERE token_grant."userId" = enabled_user."id"
               )) AS enabled_without_any_grant,
           (SELECT COUNT(*)::bigint
              FROM "AppUser" AS enabled_user
             WHERE enabled_user."disabledAt" IS NULL
               AND NOT EXISTS (
                 SELECT 1 FROM "PlatformTokenGrant" AS token_grant
                  WHERE token_grant."userId" = enabled_user."id"
                    AND token_grant."kind" = 'signup'
               )) AS enabled_without_signup_grant,
           (SELECT COUNT(*)::bigint
              FROM "AppUser" AS enabled_user
             WHERE enabled_user."disabledAt" IS NULL
               AND NOT EXISTS (
                 SELECT 1 FROM "PlatformTokenGrant" AS token_grant
                  WHERE token_grant."userId" = enabled_user."id"
                    AND token_grant."revokedAt" IS NULL
                    AND token_grant."expiresAt" > (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3)
                    AND token_grant."remainingTokens" > 0
               )) AS enabled_without_available_grant
      FROM "AppUser"
  `,
  git: `
    SELECT COUNT(*)::bigint AS total,
           COUNT(*) FILTER (
             WHERE "ownershipState" = 'confirmed' AND "ownerUserId" IS NOT NULL
           )::bigint AS confirmed,
           COUNT(*) FILTER (
             WHERE "ownershipState" = 'legacy_pending' AND "ownerUserId" IS NULL
           )::bigint AS legacy_pending,
           COUNT(*) FILTER (
             WHERE "ownershipState" = 'ambiguous' AND "ownerUserId" IS NULL
           )::bigint AS ambiguous,
           COUNT(*) FILTER (
             WHERE NOT (
               ("ownershipState" = 'confirmed' AND "ownerUserId" IS NOT NULL)
               OR ("ownershipState" = 'legacy_pending' AND "ownerUserId" IS NULL)
               OR ("ownershipState" = 'ambiguous' AND "ownerUserId" IS NULL)
             )
           )::bigint AS invalid,
           COUNT(*) FILTER (
             WHERE "ownerUserId" IS NULL AND "createdById" IS NOT NULL
           )::bigint AS candidate_only,
           (SELECT COUNT(*)::bigint FROM "GitRepository") AS repositories,
           (SELECT COUNT(*)::bigint FROM "ProjectGitRepositoryLink") AS project_repository_links,
           (SELECT COUNT(*)::bigint
              FROM "ProjectGitRepositoryLink"
             WHERE "status" = 'active' AND "disabledAt" IS NULL
           ) AS active_project_repository_links,
           (SELECT COUNT(*)::bigint
              FROM "ProjectGitRepositoryLink" AS reference
              JOIN "GitRepository" AS repository
                ON repository."id" = reference."gitRepositoryId"
              JOIN "GitConnection" AS git_connection
                ON git_connection."id" = repository."gitConnectionId"
             WHERE git_connection."createdById" <> reference."createdById"
           ) AS references_with_different_actor,
           (SELECT COUNT(*)::bigint
              FROM "ProjectGitRepositoryLink" AS reference
              JOIN "GitRepository" AS repository
                ON repository."id" = reference."gitRepositoryId"
              JOIN "GitConnection" AS git_connection
                ON git_connection."id" = repository."gitConnectionId"
             WHERE reference."status" = 'active'
               AND reference."disabledAt" IS NULL
               AND git_connection."createdById" <> reference."createdById"
           ) AS active_references_with_different_actor,
           (SELECT COUNT(DISTINCT git_connection."id")::bigint
              FROM "ProjectGitRepositoryLink" AS reference
              JOIN "GitRepository" AS repository
                ON repository."id" = reference."gitRepositoryId"
              JOIN "GitConnection" AS git_connection
                ON git_connection."id" = repository."gitConnectionId"
             WHERE git_connection."createdById" <> reference."createdById"
           ) AS connections_with_different_reference_actor,
           (SELECT COUNT(DISTINCT git_connection."id")::bigint
              FROM "ProjectGitRepositoryLink" AS reference
              JOIN "GitRepository" AS repository
                ON repository."id" = reference."gitRepositoryId"
              JOIN "GitConnection" AS git_connection
                ON git_connection."id" = repository."gitConnectionId"
              JOIN "Project" AS project
                ON project."id" = reference."projectId"
             WHERE NOT EXISTS (
                 SELECT 1 FROM "ProjectMembership" AS project_membership
                  WHERE project_membership."projectId" = reference."projectId"
                    AND project_membership."userId" = git_connection."createdById"
                    AND project_membership."accessState" = 'confirmed'
               )
               AND NOT EXISTS (
                 SELECT 1 FROM "WorkspaceMembership" AS workspace_membership
                  WHERE workspace_membership."workspaceId" = project."workspaceId"
                    AND workspace_membership."userId" = git_connection."createdById"
                    AND workspace_membership."accessState" = 'confirmed'
               )
           ) AS connections_with_creator_outside_project_access,
           (SELECT COUNT(DISTINCT git_connection."id")::bigint
              FROM "ProjectGitRepositoryLink" AS reference
              JOIN "GitRepository" AS repository
                ON repository."id" = reference."gitRepositoryId"
              JOIN "GitConnection" AS git_connection
                ON git_connection."id" = repository."gitConnectionId"
              JOIN "Project" AS project
                ON project."id" = reference."projectId"
             WHERE reference."status" = 'active'
               AND reference."disabledAt" IS NULL
               AND NOT EXISTS (
                 SELECT 1 FROM "ProjectMembership" AS project_membership
                  WHERE project_membership."projectId" = reference."projectId"
                    AND project_membership."userId" = git_connection."createdById"
                    AND project_membership."accessState" = 'confirmed'
               )
               AND NOT EXISTS (
                 SELECT 1 FROM "WorkspaceMembership" AS workspace_membership
                  WHERE workspace_membership."workspaceId" = project."workspaceId"
                    AND workspace_membership."userId" = git_connection."createdById"
                    AND workspace_membership."accessState" = 'confirmed'
               )
           ) AS active_connections_with_creator_outside_project_access,
           (SELECT COUNT(*)::bigint
              FROM (
                SELECT candidate."candidate_user_id", candidate."name"
                  FROM (
                    SELECT CASE
                             WHEN "ownershipState" = 'confirmed' AND "ownerUserId" IS NOT NULL THEN "ownerUserId"
                             WHEN "ownershipState" IN ('legacy_pending', 'ambiguous') AND "createdById" IS NOT NULL THEN "createdById"
                           END AS "candidate_user_id",
                           "name"
                      FROM "GitConnection"
                  ) AS candidate
                 WHERE candidate."candidate_user_id" IS NOT NULL
                 GROUP BY candidate."candidate_user_id", candidate."name"
                HAVING COUNT(*) > 1
              ) AS conflict_group
           ) AS owner_candidate_exact_name_conflict_groups,
           (SELECT COUNT(*)::bigint
              FROM (
                WITH candidates AS (
                  SELECT "id", "name",
                         CASE
                           WHEN "ownershipState" = 'confirmed' AND "ownerUserId" IS NOT NULL THEN "ownerUserId"
                           WHEN "ownershipState" IN ('legacy_pending', 'ambiguous') AND "createdById" IS NOT NULL THEN "createdById"
                         END AS "candidate_user_id"
                    FROM "GitConnection"
                ), conflicts AS (
                  SELECT "candidate_user_id", "name"
                    FROM candidates
                   WHERE "candidate_user_id" IS NOT NULL
                   GROUP BY "candidate_user_id", "name"
                  HAVING COUNT(*) > 1
                )
                SELECT candidates."id"
                  FROM candidates
                  JOIN conflicts
                    ON conflicts."candidate_user_id" = candidates."candidate_user_id"
                   AND conflicts."name" = candidates."name"
              ) AS conflicting_connections
           ) AS connections_in_owner_candidate_exact_name_conflicts,
           (SELECT COUNT(*)::bigint
              FROM "ProjectGitRepositoryLink" AS reference
              JOIN "GitRepository" AS repository
                ON repository."id" = reference."gitRepositoryId"
              JOIN "GitConnection" AS git_connection
                ON git_connection."id" = repository."gitConnectionId"
             WHERE git_connection."ownershipState" = 'confirmed'
               AND git_connection."ownerUserId" IS NOT NULL
           ) AS personal_direct_references,
           (SELECT COUNT(*)::bigint
              FROM "ProjectGitRepositoryLink" AS reference
              JOIN "GitRepository" AS repository
                ON repository."id" = reference."gitRepositoryId"
              JOIN "GitConnection" AS git_connection
                ON git_connection."id" = repository."gitConnectionId"
             WHERE reference."status" = 'active'
               AND reference."disabledAt" IS NULL
               AND git_connection."ownershipState" = 'confirmed'
               AND git_connection."ownerUserId" IS NOT NULL
           ) AS personal_active_direct_references,
           (SELECT COUNT(DISTINCT reference."projectId")::bigint
              FROM "ProjectGitRepositoryLink" AS reference
              JOIN "GitRepository" AS repository
                ON repository."id" = reference."gitRepositoryId"
              JOIN "GitConnection" AS git_connection
                ON git_connection."id" = repository."gitConnectionId"
             WHERE git_connection."ownershipState" = 'confirmed'
               AND git_connection."ownerUserId" IS NOT NULL
           ) AS personal_distinct_projects,
           (SELECT COUNT(DISTINCT job."id")::bigint
              FROM "BackgroundJob" AS job
             WHERE job."status" IN ('queued', 'waitingConsent', 'running', 'unknown')
               AND EXISTS (
                 SELECT 1
                   FROM "ProjectGitRepositoryLink" AS reference
                   JOIN "GitRepository" AS repository
                     ON repository."id" = reference."gitRepositoryId"
                   JOIN "GitConnection" AS git_connection
                     ON git_connection."id" = repository."gitConnectionId"
                  WHERE reference."projectId" = job."projectId"
                    AND git_connection."ownershipState" = 'confirmed'
                    AND git_connection."ownerUserId" IS NOT NULL
               )
           ) AS personal_potential_non_terminal_jobs,
           (SELECT COUNT(DISTINCT rule."id")::bigint
              FROM "AutomationRule" AS rule
             WHERE rule."status" = 'active'
               AND EXISTS (
                 SELECT 1
                   FROM "ProjectGitRepositoryLink" AS reference
                   JOIN "GitRepository" AS repository
                     ON repository."id" = reference."gitRepositoryId"
                   JOIN "GitConnection" AS git_connection
                     ON git_connection."id" = repository."gitConnectionId"
                  WHERE reference."projectId" = rule."projectId"
                    AND git_connection."ownershipState" = 'confirmed'
                    AND git_connection."ownerUserId" IS NOT NULL
               )
           ) AS personal_potential_active_automations
      FROM "GitConnection"
  `,
  mcp: `
    SELECT COUNT(*)::bigint AS total,
           COUNT(*) FILTER (
             WHERE "ownershipState" = 'confirmed' AND "ownerUserId" IS NOT NULL
           )::bigint AS confirmed,
           COUNT(*) FILTER (
             WHERE "ownershipState" = 'legacy_pending' AND "ownerUserId" IS NULL
           )::bigint AS legacy_pending,
           COUNT(*) FILTER (
             WHERE "ownershipState" = 'ambiguous' AND "ownerUserId" IS NULL
           )::bigint AS ambiguous,
           COUNT(*) FILTER (
             WHERE NOT (
               ("ownershipState" = 'confirmed' AND "ownerUserId" IS NOT NULL)
               OR ("ownershipState" = 'legacy_pending' AND "ownerUserId" IS NULL)
               OR ("ownershipState" = 'ambiguous' AND "ownerUserId" IS NULL)
             )
           )::bigint AS invalid,
           COUNT(*) FILTER (
             WHERE "ownerUserId" IS NULL AND "createdById" IS NOT NULL
           )::bigint AS candidate_only,
           (SELECT COUNT(*)::bigint FROM "McpToolDefinition") AS tool_definitions,
           (SELECT COUNT(*)::bigint
              FROM "McpToolDefinition"
             WHERE "current" = true
           ) AS current_tool_definitions,
           (SELECT COUNT(*)::bigint FROM "ProjectMcpToolGrant") AS project_tool_grants,
           (SELECT COUNT(*)::bigint
              FROM "ProjectMcpToolGrant"
             WHERE "status" = 'active'
           ) AS active_project_tool_grants,
           (SELECT COUNT(*)::bigint
              FROM "ProjectMcpToolGrant" AS reference
              JOIN "McpConnection" AS mcp_connection
                ON mcp_connection."id" = reference."connectionId"
             WHERE mcp_connection."createdById" <> reference."managedById"
           ) AS references_with_different_actor,
           (SELECT COUNT(*)::bigint
              FROM "ProjectMcpToolGrant" AS reference
              JOIN "McpConnection" AS mcp_connection
                ON mcp_connection."id" = reference."connectionId"
             WHERE reference."status" = 'active'
               AND reference."revokedAt" IS NULL
               AND mcp_connection."createdById" <> reference."managedById"
           ) AS active_references_with_different_actor,
           (SELECT COUNT(DISTINCT mcp_connection."id")::bigint
              FROM "ProjectMcpToolGrant" AS reference
              JOIN "McpConnection" AS mcp_connection
                ON mcp_connection."id" = reference."connectionId"
             WHERE mcp_connection."createdById" <> reference."managedById"
           ) AS connections_with_different_reference_actor,
           (SELECT COUNT(DISTINCT mcp_connection."id")::bigint
              FROM "ProjectMcpToolGrant" AS reference
              JOIN "McpConnection" AS mcp_connection
                ON mcp_connection."id" = reference."connectionId"
              JOIN "Project" AS project
                ON project."id" = reference."projectId"
             WHERE NOT EXISTS (
                 SELECT 1 FROM "ProjectMembership" AS project_membership
                  WHERE project_membership."projectId" = reference."projectId"
                    AND project_membership."userId" = mcp_connection."createdById"
                    AND project_membership."accessState" = 'confirmed'
               )
               AND NOT EXISTS (
                 SELECT 1 FROM "WorkspaceMembership" AS workspace_membership
                  WHERE workspace_membership."workspaceId" = project."workspaceId"
                    AND workspace_membership."userId" = mcp_connection."createdById"
                    AND workspace_membership."accessState" = 'confirmed'
               )
           ) AS connections_with_creator_outside_project_access,
           (SELECT COUNT(DISTINCT mcp_connection."id")::bigint
              FROM "ProjectMcpToolGrant" AS reference
              JOIN "McpConnection" AS mcp_connection
                ON mcp_connection."id" = reference."connectionId"
              JOIN "Project" AS project
                ON project."id" = reference."projectId"
             WHERE reference."status" = 'active'
               AND reference."revokedAt" IS NULL
               AND NOT EXISTS (
                 SELECT 1 FROM "ProjectMembership" AS project_membership
                  WHERE project_membership."projectId" = reference."projectId"
                    AND project_membership."userId" = mcp_connection."createdById"
                    AND project_membership."accessState" = 'confirmed'
               )
               AND NOT EXISTS (
                 SELECT 1 FROM "WorkspaceMembership" AS workspace_membership
                  WHERE workspace_membership."workspaceId" = project."workspaceId"
                    AND workspace_membership."userId" = mcp_connection."createdById"
                    AND workspace_membership."accessState" = 'confirmed'
               )
           ) AS active_connections_with_creator_outside_project_access,
           (SELECT COUNT(*)::bigint
              FROM (
                SELECT candidate."candidate_user_id", candidate."name"
                  FROM (
                    SELECT CASE
                             WHEN "ownershipState" = 'confirmed' AND "ownerUserId" IS NOT NULL THEN "ownerUserId"
                             WHEN "ownershipState" IN ('legacy_pending', 'ambiguous') AND "createdById" IS NOT NULL THEN "createdById"
                           END AS "candidate_user_id",
                           "name"
                      FROM "McpConnection"
                  ) AS candidate
                 WHERE candidate."candidate_user_id" IS NOT NULL
                 GROUP BY candidate."candidate_user_id", candidate."name"
                HAVING COUNT(*) > 1
              ) AS conflict_group
           ) AS owner_candidate_exact_name_conflict_groups,
           (SELECT COUNT(*)::bigint
              FROM (
                WITH candidates AS (
                  SELECT "id", "name",
                         CASE
                           WHEN "ownershipState" = 'confirmed' AND "ownerUserId" IS NOT NULL THEN "ownerUserId"
                           WHEN "ownershipState" IN ('legacy_pending', 'ambiguous') AND "createdById" IS NOT NULL THEN "createdById"
                         END AS "candidate_user_id"
                    FROM "McpConnection"
                ), conflicts AS (
                  SELECT "candidate_user_id", "name"
                    FROM candidates
                   WHERE "candidate_user_id" IS NOT NULL
                   GROUP BY "candidate_user_id", "name"
                  HAVING COUNT(*) > 1
                )
                SELECT candidates."id"
                  FROM candidates
                  JOIN conflicts
                    ON conflicts."candidate_user_id" = candidates."candidate_user_id"
                   AND conflicts."name" = candidates."name"
              ) AS conflicting_connections
           ) AS connections_in_owner_candidate_exact_name_conflicts,
           (SELECT COUNT(*)::bigint
              FROM "ProjectMcpToolGrant" AS reference
              JOIN "McpConnection" AS mcp_connection
                ON mcp_connection."id" = reference."connectionId"
             WHERE mcp_connection."ownershipState" = 'confirmed'
               AND mcp_connection."ownerUserId" IS NOT NULL
           ) AS personal_direct_references,
           (SELECT COUNT(*)::bigint
              FROM "ProjectMcpToolGrant" AS reference
              JOIN "McpConnection" AS mcp_connection
                ON mcp_connection."id" = reference."connectionId"
             WHERE reference."status" = 'active'
               AND reference."revokedAt" IS NULL
               AND mcp_connection."ownershipState" = 'confirmed'
               AND mcp_connection."ownerUserId" IS NOT NULL
           ) AS personal_active_direct_references,
           (SELECT COUNT(DISTINCT reference."projectId")::bigint
              FROM "ProjectMcpToolGrant" AS reference
              JOIN "McpConnection" AS mcp_connection
                ON mcp_connection."id" = reference."connectionId"
             WHERE mcp_connection."ownershipState" = 'confirmed'
               AND mcp_connection."ownerUserId" IS NOT NULL
           ) AS personal_distinct_projects,
           (SELECT COUNT(DISTINCT job."id")::bigint
              FROM "BackgroundJob" AS job
             WHERE job."status" IN ('queued', 'waitingConsent', 'running', 'unknown')
               AND EXISTS (
                 SELECT 1
                   FROM "ProjectMcpToolGrant" AS reference
                   JOIN "McpConnection" AS mcp_connection
                     ON mcp_connection."id" = reference."connectionId"
                  WHERE reference."projectId" = job."projectId"
                    AND mcp_connection."ownershipState" = 'confirmed'
                    AND mcp_connection."ownerUserId" IS NOT NULL
               )
           ) AS personal_potential_non_terminal_jobs,
           (SELECT COUNT(DISTINCT rule."id")::bigint
              FROM "AutomationRule" AS rule
             WHERE rule."status" = 'active'
               AND EXISTS (
                 SELECT 1
                   FROM "ProjectMcpToolGrant" AS reference
                   JOIN "McpConnection" AS mcp_connection
                     ON mcp_connection."id" = reference."connectionId"
                  WHERE reference."projectId" = rule."projectId"
                    AND mcp_connection."ownershipState" = 'confirmed'
                    AND mcp_connection."ownerUserId" IS NOT NULL
               )
           ) AS personal_potential_active_automations
      FROM "McpConnection"
  `,
  aiProvider: `
    SELECT COUNT(*)::bigint AS total,
           COUNT(*) FILTER (WHERE "scope" = 'platform')::bigint AS platform,
           COUNT(*) FILTER (WHERE "scope" = 'workspace')::bigint AS workspace,
           COUNT(*) FILTER (WHERE "scope" = 'user')::bigint AS "user",
           COUNT(*) FILTER (
             WHERE ("scope" = 'workspace'
                    AND "workspaceId" IS NOT NULL
                    AND "ownerUserId" IS NOT NULL
                    AND "ownershipState" = 'confirmed')
                OR ("scope" = 'user'
                    AND "workspaceId" IS NULL
                    AND "ownerUserId" IS NOT NULL
                    AND "ownershipState" = 'confirmed')
           )::bigint AS confirmed,
           COUNT(*) FILTER (
             WHERE ("scope" = 'platform'
                    AND "workspaceId" IS NULL
                    AND "ownerUserId" IS NULL
                    AND "ownershipState" = 'legacy_pending')
                OR ("scope" = 'workspace'
                    AND "workspaceId" IS NOT NULL
                    AND "ownerUserId" IS NOT NULL
                    AND "ownershipState" = 'legacy_pending')
           )::bigint AS legacy_pending,
           COUNT(*) FILTER (
             WHERE "scope" = 'workspace'
               AND "workspaceId" IS NOT NULL
               AND "ownerUserId" IS NOT NULL
               AND "ownershipState" = 'ambiguous'
           )::bigint AS ambiguous,
           COUNT(*) FILTER (
             WHERE NOT (
               ("scope" = 'platform'
                AND "workspaceId" IS NULL
                AND "ownerUserId" IS NULL
                AND "ownershipState" = 'legacy_pending')
               OR ("scope" = 'workspace'
                   AND "workspaceId" IS NOT NULL
                   AND "ownerUserId" IS NOT NULL
                   AND "ownershipState" = 'legacy_pending')
               OR ("scope" = 'workspace'
                   AND "workspaceId" IS NOT NULL
                   AND "ownerUserId" IS NOT NULL
                   AND "ownershipState" = 'ambiguous')
               OR ("scope" = 'workspace'
                   AND "workspaceId" IS NOT NULL
                   AND "ownerUserId" IS NOT NULL
                   AND "ownershipState" = 'confirmed')
               OR ("scope" = 'user'
                   AND "workspaceId" IS NULL
                   AND "ownerUserId" IS NOT NULL
                   AND "ownershipState" = 'confirmed')
             )
           )::bigint AS invalid,
           COUNT(*) FILTER (
             WHERE "scope" = 'workspace'
               AND "workspaceId" IS NOT NULL
               AND "ownerUserId" IS NOT NULL
               AND EXISTS (
                 SELECT 1 FROM "WorkspaceMembership" AS membership
                  WHERE membership."workspaceId" = "AiProviderConnection"."workspaceId"
                    AND membership."userId" = "AiProviderConnection"."ownerUserId"
                    AND membership."accessState" = 'confirmed'
                    AND membership."role" = 'owner'
               )
           )::bigint AS workspace_owner,
           COUNT(*) FILTER (
             WHERE "scope" = 'workspace'
               AND "workspaceId" IS NOT NULL
               AND "ownerUserId" IS NOT NULL
               AND EXISTS (
                 SELECT 1 FROM "WorkspaceMembership" AS membership
                  WHERE membership."workspaceId" = "AiProviderConnection"."workspaceId"
                    AND membership."userId" = "AiProviderConnection"."ownerUserId"
                    AND membership."accessState" = 'confirmed'
                    AND membership."role" = 'admin'
               )
           )::bigint AS workspace_admin,
           COUNT(*) FILTER (
             WHERE "scope" = 'workspace'
               AND "workspaceId" IS NOT NULL
               AND "ownerUserId" IS NOT NULL
               AND EXISTS (
                 SELECT 1 FROM "WorkspaceMembership" AS membership
                  WHERE membership."workspaceId" = "AiProviderConnection"."workspaceId"
                    AND membership."userId" = "AiProviderConnection"."ownerUserId"
                    AND membership."accessState" = 'confirmed'
                    AND membership."role" = 'member'
               )
           )::bigint AS workspace_member,
           COUNT(*) FILTER (
             WHERE "scope" = 'workspace'
               AND "workspaceId" IS NOT NULL
               AND "ownerUserId" IS NOT NULL
               AND EXISTS (
                 SELECT 1 FROM "WorkspaceMembership" AS membership
                  WHERE membership."workspaceId" = "AiProviderConnection"."workspaceId"
                    AND membership."userId" = "AiProviderConnection"."ownerUserId"
                    AND membership."accessState" = 'confirmed'
                    AND membership."role" = 'viewer'
               )
           )::bigint AS workspace_viewer,
           COUNT(*) FILTER (
             WHERE "scope" = 'workspace'
               AND "workspaceId" IS NOT NULL
               AND "ownerUserId" IS NOT NULL
               AND NOT EXISTS (
                 SELECT 1 FROM "WorkspaceMembership" AS membership
                  WHERE membership."workspaceId" = "AiProviderConnection"."workspaceId"
                    AND membership."userId" = "AiProviderConnection"."ownerUserId"
                    AND membership."accessState" = 'confirmed'
               )
           )::bigint AS workspace_missing,
           COUNT(*) FILTER (
             WHERE NOT ("scope" = 'workspace'
                        AND "workspaceId" IS NOT NULL
                        AND "ownerUserId" IS NOT NULL)
           )::bigint AS workspace_not_evaluable,
           (SELECT COUNT(*)::bigint FROM "ProjectAiRoute") AS project_ai_routes,
           (SELECT COUNT(*)::bigint FROM "ProjectAiRouteRevision"
             WHERE "oldProviderConnectionId" IS NOT NULL
           ) AS route_revisions_old,
           (SELECT COUNT(*)::bigint FROM "ProjectAiRouteRevision") AS route_revisions_new,
           (SELECT COUNT(*)::bigint FROM "WebAiGrant") AS web_ai_grants,
           (SELECT COUNT(*)::bigint FROM "WebAiGrant"
             WHERE "revokedAt" IS NULL AND "expiresAt" > (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3)
           ) AS open_web_ai_grants,
           (SELECT COUNT(*)::bigint FROM "PlatformTokenReservation"
             WHERE "providerConnectionId" IS NOT NULL
           ) AS platform_token_reservations,
           (SELECT COUNT(*)::bigint FROM "PlatformTokenReservation"
             WHERE "providerConnectionId" IS NOT NULL
               AND "status" IN ('reserved', 'held')
           ) AS open_token_reservations,
           (SELECT COUNT(*)::bigint FROM "ProviderCallAudit") AS provider_call_audits,
           (SELECT COUNT(*)::bigint FROM "MemoryIndexGeneration") AS memory_index_generations,
           (
             (SELECT COUNT(*) FROM "RagAnswer")
             + (SELECT COUNT(*) FROM "WebAiCandidate")
             + (SELECT COUNT(*) FROM "ProjectIntelligenceReport")
             + (SELECT COUNT(*) FROM "ProjectAgentRun")
             + (SELECT COUNT(*) FROM "ProjectAssetExtractionRun" WHERE "providerConnectionId" IS NOT NULL)
             + (SELECT COUNT(*) FROM "ProjectAssetSegment" WHERE "providerConnectionId" IS NOT NULL)
           )::bigint AS derived_ai_artifacts,
           (SELECT COUNT(*)::bigint FROM "PlatformDefaultAiRoute") AS platform_default_routes,
           COUNT(*) FILTER (
             WHERE ("scope" = 'platform'
                    AND "workspaceId" IS NULL
                    AND "ownerUserId" IS NULL
                    AND "ownershipState" = 'legacy_pending')
                OR ("scope" = 'workspace'
                    AND "workspaceId" IS NOT NULL
                    AND "ownerUserId" IS NOT NULL
                    AND "ownershipState" IN ('legacy_pending', 'ambiguous', 'confirmed'))
                OR ("scope" = 'user'
                    AND "workspaceId" IS NULL
                    AND "ownerUserId" IS NOT NULL
                    AND "ownershipState" = 'confirmed')
           )::bigint AS structurally_valid,
           COUNT(*) FILTER (
             WHERE NOT (
               ("scope" = 'platform'
                AND "workspaceId" IS NULL
                AND "ownerUserId" IS NULL
                AND "ownershipState" = 'legacy_pending')
                OR ("scope" = 'workspace'
                    AND "workspaceId" IS NOT NULL
                    AND "ownerUserId" IS NOT NULL
                    AND "ownershipState" IN ('legacy_pending', 'ambiguous', 'confirmed'))
                OR ("scope" = 'user'
                    AND "workspaceId" IS NULL
                    AND "ownerUserId" IS NOT NULL
                    AND "ownershipState" = 'confirmed')
             )
           )::bigint AS structurally_invalid,
           COUNT(*) FILTER (
             WHERE "scope" = 'workspace'
               AND "workspaceId" IS NOT NULL
               AND "ownerUserId" IS NOT NULL
               AND EXISTS (
                 SELECT 1 FROM "WorkspaceMembership" AS membership
                  WHERE membership."workspaceId" = "AiProviderConnection"."workspaceId"
                    AND membership."userId" = "AiProviderConnection"."ownerUserId"
                    AND membership."accessState" = 'confirmed'
               )
           )::bigint AS workspace_with_membership,
           COUNT(*) FILTER (
             WHERE "scope" = 'workspace'
               AND "workspaceId" IS NOT NULL
               AND "ownerUserId" IS NOT NULL
               AND NOT EXISTS (
                 SELECT 1 FROM "WorkspaceMembership" AS membership
                  WHERE membership."workspaceId" = "AiProviderConnection"."workspaceId"
                    AND membership."userId" = "AiProviderConnection"."ownerUserId"
                    AND membership."accessState" = 'confirmed'
               )
           )::bigint AS workspace_without_membership,
           (SELECT COUNT(*)::bigint
              FROM "ProjectAiRoute" AS route
              JOIN "AiProviderConnection" AS personal_provider
                ON personal_provider."id" = route."providerConnectionId"
             WHERE personal_provider."scope" = 'user'
               AND personal_provider."ownershipState" = 'confirmed'
               AND personal_provider."ownerUserId" IS NOT NULL
               AND personal_provider."workspaceId" IS NULL
           ) AS personal_direct_project_routes,
           (SELECT COUNT(DISTINCT route."projectId")::bigint
              FROM "ProjectAiRoute" AS route
              JOIN "AiProviderConnection" AS personal_provider
                ON personal_provider."id" = route."providerConnectionId"
             WHERE personal_provider."scope" = 'user'
               AND personal_provider."ownershipState" = 'confirmed'
               AND personal_provider."ownerUserId" IS NOT NULL
               AND personal_provider."workspaceId" IS NULL
           ) AS personal_distinct_projects,
           (SELECT COUNT(*)::bigint
              FROM "WebAiGrant" AS web_grant
              JOIN "AiProviderConnection" AS personal_provider
                ON personal_provider."id" = web_grant."providerConnectionId"
             WHERE web_grant."revokedAt" IS NULL
               AND web_grant."expiresAt" > (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3)
               AND personal_provider."scope" = 'user'
               AND personal_provider."ownershipState" = 'confirmed'
               AND personal_provider."ownerUserId" IS NOT NULL
               AND personal_provider."workspaceId" IS NULL
           ) AS personal_open_web_ai_grants,
           (SELECT COUNT(DISTINCT job."id")::bigint
              FROM "BackgroundJob" AS job
              JOIN "WebAiGrant" AS web_grant
                ON web_grant."id" = job."webAiGrantId"
              JOIN "AiProviderConnection" AS personal_provider
                ON personal_provider."id" = web_grant."providerConnectionId"
             WHERE job."status" IN ('queued', 'waitingConsent', 'running', 'unknown')
               AND personal_provider."scope" = 'user'
               AND personal_provider."ownershipState" = 'confirmed'
               AND personal_provider."ownerUserId" IS NOT NULL
               AND personal_provider."workspaceId" IS NULL
           ) AS personal_direct_non_terminal_jobs,
           (SELECT COUNT(DISTINCT rule."id")::bigint
              FROM "AutomationRule" AS rule
             WHERE rule."status" = 'active'
               AND (
                 EXISTS (
                   SELECT 1
                     FROM "ProjectAiRoute" AS route
                     JOIN "AiProviderConnection" AS personal_provider
                       ON personal_provider."id" = route."providerConnectionId"
                    WHERE route."projectId" = rule."projectId"
                      AND personal_provider."scope" = 'user'
                      AND personal_provider."ownershipState" = 'confirmed'
                      AND personal_provider."ownerUserId" IS NOT NULL
                      AND personal_provider."workspaceId" IS NULL
                 )
                 OR EXISTS (
                   SELECT 1
                     FROM "WebAiGrant" AS web_grant
                     JOIN "AiProviderConnection" AS personal_provider
                       ON personal_provider."id" = web_grant."providerConnectionId"
                    WHERE web_grant."projectId" = rule."projectId"
                      AND web_grant."revokedAt" IS NULL
                      AND web_grant."expiresAt" > (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3)
                      AND personal_provider."scope" = 'user'
                      AND personal_provider."ownershipState" = 'confirmed'
                      AND personal_provider."ownerUserId" IS NOT NULL
                      AND personal_provider."workspaceId" IS NULL
                 )
               )
           ) AS personal_potential_active_automations
      FROM "AiProviderConnection"
  `,
  platformDefaultRoutes: `
    SELECT (
             SELECT COUNT(*)::bigint
               FROM "AiProviderConnection" AS provider
              WHERE provider."scope" = 'platform'
                AND provider."workspaceId" IS NULL
                AND provider."ownerUserId" IS NULL
                AND provider."ownershipState" = 'legacy_pending'
           ) AS provider_total,
           COUNT(*)::bigint AS total,
           COUNT(*) FILTER (WHERE "status" = 'draft')::bigint AS draft,
           COUNT(*) FILTER (WHERE "status" = 'verified')::bigint AS verified,
           COUNT(*) FILTER (WHERE "status" = 'active')::bigint AS active,
           COUNT(*) FILTER (WHERE "status" = 'retired')::bigint AS retired,
           COUNT(*) FILTER (WHERE "status" NOT IN ('draft', 'verified', 'active', 'retired'))::bigint AS invalid,
           COUNT(*) FILTER (WHERE "status" IN ('draft', 'verified'))::bigint AS candidate_total,
           COUNT(*) FILTER (
             WHERE "status" IN ('draft', 'verified')
               AND EXISTS (
                 SELECT 1
                   FROM "AiProviderConnection" AS provider
                  WHERE provider."id" = "PlatformDefaultAiRoute"."providerConnectionId"
                    AND provider."scope" = 'platform'
                    AND provider."workspaceId" IS NULL
                    AND provider."ownerUserId" IS NULL
                    AND provider."ownershipState" = 'legacy_pending'
                    AND provider."status" = 'verified'
                    AND provider."disabledAt" IS NULL
                    AND (
                      ("PlatformDefaultAiRoute"."operation" = 'embedding'
                       AND "PlatformDefaultAiRoute"."modelId" = provider."defaultEmbeddingModelId"
                       AND "PlatformDefaultAiRoute"."embeddingDimensions" = provider."embeddingDimensions")
                      OR ("PlatformDefaultAiRoute"."operation" = 'visionExtract'
                          AND "PlatformDefaultAiRoute"."modelId" = provider."defaultVisionModelId")
                      OR ("PlatformDefaultAiRoute"."operation" NOT IN ('embedding', 'visionExtract')
                          AND "PlatformDefaultAiRoute"."modelId" = provider."defaultGenerationModelId")
                    )
               )
           )::bigint AS candidate_usable,
           COUNT(*) FILTER (WHERE "status" IN ('draft', 'verified'))::bigint
           - COUNT(*) FILTER (
             WHERE "status" IN ('draft', 'verified')
               AND EXISTS (
                 SELECT 1
                   FROM "AiProviderConnection" AS provider
                  WHERE provider."id" = "PlatformDefaultAiRoute"."providerConnectionId"
                    AND provider."scope" = 'platform'
                    AND provider."workspaceId" IS NULL
                    AND provider."ownerUserId" IS NULL
                    AND provider."ownershipState" = 'legacy_pending'
                    AND provider."status" = 'verified'
                    AND provider."disabledAt" IS NULL
                    AND (
                      ("PlatformDefaultAiRoute"."operation" = 'embedding'
                       AND "PlatformDefaultAiRoute"."modelId" = provider."defaultEmbeddingModelId"
                       AND "PlatformDefaultAiRoute"."embeddingDimensions" = provider."embeddingDimensions")
                      OR ("PlatformDefaultAiRoute"."operation" = 'visionExtract'
                          AND "PlatformDefaultAiRoute"."modelId" = provider."defaultVisionModelId")
                      OR ("PlatformDefaultAiRoute"."operation" NOT IN ('embedding', 'visionExtract')
                          AND "PlatformDefaultAiRoute"."modelId" = provider."defaultGenerationModelId")
                    )
               )
           )::bigint AS candidate_unusable,
           COUNT(*) FILTER (WHERE "status" = 'active')::bigint AS active_total,
           COUNT(*) FILTER (
             WHERE "status" = 'active'
               AND EXISTS (
                 SELECT 1
                   FROM "AiProviderConnection" AS provider
                  WHERE provider."id" = "PlatformDefaultAiRoute"."providerConnectionId"
                    AND provider."scope" = 'platform'
                    AND provider."workspaceId" IS NULL
                    AND provider."ownerUserId" IS NULL
                    AND provider."ownershipState" = 'legacy_pending'
                    AND provider."status" = 'verified'
                    AND provider."disabledAt" IS NULL
                    AND (
                      ("PlatformDefaultAiRoute"."operation" = 'embedding'
                       AND "PlatformDefaultAiRoute"."modelId" = provider."defaultEmbeddingModelId"
                       AND "PlatformDefaultAiRoute"."embeddingDimensions" = provider."embeddingDimensions")
                      OR ("PlatformDefaultAiRoute"."operation" = 'visionExtract'
                          AND "PlatformDefaultAiRoute"."modelId" = provider."defaultVisionModelId")
                      OR ("PlatformDefaultAiRoute"."operation" NOT IN ('embedding', 'visionExtract')
                          AND "PlatformDefaultAiRoute"."modelId" = provider."defaultGenerationModelId")
                    )
               )
           )::bigint AS active_usable,
           COUNT(*) FILTER (WHERE "status" = 'active')::bigint
           - COUNT(*) FILTER (
             WHERE "status" = 'active'
               AND EXISTS (
                 SELECT 1
                   FROM "AiProviderConnection" AS provider
                  WHERE provider."id" = "PlatformDefaultAiRoute"."providerConnectionId"
                    AND provider."scope" = 'platform'
                    AND provider."workspaceId" IS NULL
                    AND provider."ownerUserId" IS NULL
                    AND provider."ownershipState" = 'legacy_pending'
                    AND provider."status" = 'verified'
                    AND provider."disabledAt" IS NULL
                    AND (
                      ("PlatformDefaultAiRoute"."operation" = 'embedding'
                       AND "PlatformDefaultAiRoute"."modelId" = provider."defaultEmbeddingModelId"
                       AND "PlatformDefaultAiRoute"."embeddingDimensions" = provider."embeddingDimensions")
                      OR ("PlatformDefaultAiRoute"."operation" = 'visionExtract'
                          AND "PlatformDefaultAiRoute"."modelId" = provider."defaultVisionModelId")
                      OR ("PlatformDefaultAiRoute"."operation" NOT IN ('embedding', 'visionExtract')
                          AND "PlatformDefaultAiRoute"."modelId" = provider."defaultGenerationModelId")
                    )
               )
           )::bigint AS active_unusable,
           (SELECT COUNT(*)::bigint
              FROM "AiProviderConnection" AS provider
             WHERE provider."scope" = 'platform'
               AND provider."workspaceId" IS NULL
               AND provider."ownerUserId" IS NULL
               AND provider."ownershipState" = 'legacy_pending'
               AND provider."defaultGenerationModelId" IS NOT NULL
           ) AS provider_capabilities_generation,
           (SELECT COUNT(*)::bigint
              FROM "AiProviderConnection" AS provider
             WHERE provider."scope" = 'platform'
               AND provider."workspaceId" IS NULL
               AND provider."ownerUserId" IS NULL
               AND provider."ownershipState" = 'legacy_pending'
               AND provider."defaultVisionModelId" IS NOT NULL
           ) AS provider_capabilities_vision,
           (SELECT COUNT(*)::bigint
              FROM "AiProviderConnection" AS provider
             WHERE provider."scope" = 'platform'
               AND provider."workspaceId" IS NULL
               AND provider."ownerUserId" IS NULL
               AND provider."ownershipState" = 'legacy_pending'
               AND provider."defaultEmbeddingModelId" IS NOT NULL
               AND provider."embeddingDimensions" IS NOT NULL
           ) AS provider_capabilities_embedding
      FROM "PlatformDefaultAiRoute"
  `,
  activeVectorIndex: `
    SELECT COUNT(*)::bigint AS total,
           COUNT(*) FILTER (
             WHERE EXISTS (
               SELECT 1
                 FROM "PlatformDefaultAiRoute" AS route
                WHERE route."operation" = 'embedding'
                  AND route."status" = 'active'
                  AND route."providerConnectionId" = generation."providerConnectionId"
                  AND route."modelId" = generation."modelId"
                  AND route."embeddingDimensions" = generation."dimensions"
             )
           )::bigint AS matches_active_default_embedding_route,
           COUNT(*) FILTER (
             WHERE EXISTS (
               SELECT 1
                 FROM "PlatformDefaultAiRoute" AS route
                WHERE route."operation" = 'embedding'
                  AND route."status" = 'active'
             )
               AND NOT EXISTS (
                 SELECT 1
                   FROM "PlatformDefaultAiRoute" AS route
                  WHERE route."operation" = 'embedding'
                    AND route."status" = 'active'
                    AND route."providerConnectionId" = generation."providerConnectionId"
                    AND route."modelId" = generation."modelId"
                    AND route."embeddingDimensions" = generation."dimensions"
               )
           )::bigint AS differs_from_active_default_embedding_route,
           COUNT(*) FILTER (
             WHERE NOT EXISTS (
               SELECT 1
                 FROM "PlatformDefaultAiRoute" AS route
                WHERE route."operation" = 'embedding'
                  AND route."status" = 'active'
             )
           )::bigint AS no_active_default_embedding_route,
           COUNT(*) FILTER (
             WHERE EXISTS (
               SELECT 1
                 FROM "PlatformDefaultAiRoute" AS route
                WHERE route."operation" = 'embedding'
                  AND route."status" IN ('draft', 'verified')
                  AND route."providerConnectionId" = generation."providerConnectionId"
                  AND route."modelId" = generation."modelId"
                  AND route."embeddingDimensions" = generation."dimensions"
             )
           )::bigint AS matches_draft_or_verified_candidate_tuple
      FROM "MemoryIndexPointer" AS pointer
      JOIN "MemoryIndexGeneration" AS generation
        ON generation."projectId" = pointer."projectId"
       AND generation."id" = pointer."indexGenerationId"
  `,
  githubConnectionLegacy: `
    SELECT COUNT(*)::bigint AS project_scoped_total,
           COUNT(*) FILTER (WHERE "status" = 'configured')::bigint AS configured,
           COUNT(*) FILTER (WHERE "status" = 'verified')::bigint AS verified,
           COUNT(*) FILTER (WHERE "status" = 'disabled')::bigint AS disabled,
           COUNT(*) FILTER (WHERE "status" = 'access_unknown')::bigint AS access_unknown,
           COUNT(*) FILTER (
             WHERE "status" NOT IN ('configured', 'verified', 'disabled', 'access_unknown')
           )::bigint AS invalid_status,
           COUNT(*) FILTER (WHERE "credentialId" IS NOT NULL)::bigint AS credential_attached,
           (SELECT COUNT(*)::bigint FROM "ProjectRepositoryLink") AS project_repository_links,
           (SELECT COUNT(*)::bigint FROM "ProjectGitHubSyncEntry") AS github_sync_entries
      FROM "GitHubConnection"
  `,
  platformTokenGrants: `
    SELECT COUNT(*)::bigint AS total,
           COUNT(*) FILTER (
             WHERE "revokedAt" IS NULL
               AND "expiresAt" > (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3)
               AND "remainingTokens" > 0
           )::bigint AS available,
           COUNT(*) FILTER (
             WHERE "revokedAt" IS NULL
               AND "expiresAt" <= (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3)
           )::bigint AS expired,
           COUNT(*) FILTER (WHERE "revokedAt" IS NOT NULL)::bigint AS revoked
      FROM "PlatformTokenGrant"
  `,
});

export const INVENTORY_SQL = SQL;

async function queryRows<Row>(client: InventoryQueryClient, text: string, values: readonly unknown[] = []): Promise<readonly Row[]> {
  try {
    const result = await client.query<Row>(text, values);
    return result.rows;
  } catch {
    throw new OwnershipInventoryError("OWNERSHIP_INVENTORY_QUERY_FAILED");
  }
}

function requireSingleRow<Row>(rows: readonly Row[]): Row {
  if (rows.length !== 1 || rows[0] === undefined) {
    throw new OwnershipInventoryError("OWNERSHIP_INVENTORY_RESULT_INVALID");
  }
  return rows[0];
}

async function validateReadOnlyTransaction(client: InventoryQueryClient): Promise<void> {
  const row = requireSingleRow(await queryRows<{ transaction_read_only: string }>(client, SQL.transactionReadOnly));
  if (row.transaction_read_only !== "on") {
    throw new OwnershipInventoryError("OWNERSHIP_INVENTORY_PREFLIGHT_FAILED");
  }
}

function sameCount(left: CountValue, right: CountValue): boolean {
  if (typeof left === "bigint" || typeof right === "bigint") return left === right;
  return String(left) === String(right);
}

export async function validateOwnershipInventoryPreflight(client: InventoryQueryClient): Promise<CountValue> {
  try {
    const migrationRows = await queryRows<MigrationPreflightRow>(client, SQL.migrations, [REQUIRED_MIGRATIONS]);
    if (
      migrationRows.length !== REQUIRED_MIGRATIONS.length
      || migrationRows.some((row, index) => row.migration_name !== REQUIRED_MIGRATIONS[index] || row.applied !== true)
    ) {
      throw new OwnershipInventoryError("OWNERSHIP_INVENTORY_PREFLIGHT_FAILED");
    }
    const appliedMigrationCount = migrationRows[0]?.applied_migration_count;
    if (appliedMigrationCount === undefined || migrationRows.some((row) => !sameCount(row.applied_migration_count, appliedMigrationCount))) {
      throw new OwnershipInventoryError("OWNERSHIP_INVENTORY_RESULT_INVALID");
    }

    const constraintRows = await queryRows<ConstraintPreflightRow>(
      client,
      SQL.constraints,
      [REQUIRED_CONSTRAINTS.map((constraint) => constraint.name), REQUIRED_CONSTRAINTS.map((constraint) => constraint.table)],
    );
    if (
      constraintRows.length !== REQUIRED_CONSTRAINTS.length
      || REQUIRED_CONSTRAINTS.some((expected) => {
        const matches = constraintRows.filter((row) => row.constraint_name === expected.name && row.relation_name === expected.table);
        return matches.length !== 1 || matches[0]!.constraint_type !== "c" || matches[0]!.validated !== true;
      })
    ) {
      throw new OwnershipInventoryError("OWNERSHIP_INVENTORY_PREFLIGHT_FAILED");
    }

    const enumNames = Object.keys(REQUIRED_ENUMS) as Array<keyof typeof REQUIRED_ENUMS>;
    const enumRows = await queryRows<EnumPreflightRow>(client, SQL.enums, [enumNames]);
    const expectedEnumRowCount = enumNames.reduce((sum, enumName) => sum + REQUIRED_ENUMS[enumName].length, 0);
    if (enumRows.length !== expectedEnumRowCount) {
      throw new OwnershipInventoryError("OWNERSHIP_INVENTORY_PREFLIGHT_FAILED");
    }
    for (const enumName of enumNames) {
      const actualValues = enumRows
        .filter((row) => row.enum_name === enumName)
        .map((row) => row.enum_value);
      if (JSON.stringify(actualValues) !== JSON.stringify(REQUIRED_ENUMS[enumName])) {
        throw new OwnershipInventoryError("OWNERSHIP_INVENTORY_PREFLIGHT_FAILED");
      }
    }

    const rlsRows = await queryRows<RlsPreflightRow>(client, SQL.rls, [INVENTORY_TABLES]);
    if (
      rlsRows.length !== INVENTORY_TABLES.length
      || INVENTORY_TABLES.some((table) => {
        const matches = rlsRows.filter((row) => row.relation_name === table);
        return matches.length !== 1 || matches[0]!.row_security !== false || matches[0]!.force_row_security !== false;
      })
    ) {
      throw new OwnershipInventoryError("OWNERSHIP_INVENTORY_PREFLIGHT_FAILED");
    }

    const roleRows = await queryRows<RolePreflightRow>(client, SQL.role, [INVENTORY_TABLES]);
    const role = requireSingleRow(roleRows);
    if (
      typeof role.role_name !== "string"
      || role.is_superuser !== false
      || role.bypass_rls !== false
      || role.can_replicate !== false
      || role.owns_database !== false
      || role.owns_schema !== false
      || role.owns_target_table !== false
      || role.can_create_database !== false
      || role.can_create_database_role !== false
      || role.can_create_role !== false
      || role.can_create_temporary !== false
      // Require the role itself to carry the read-only default. The database
      // setting is observed above, but cannot substitute for the role-level
      // default because role settings take precedence over database settings.
      || role.role_default_transaction_read_only !== true
      || typeof role.database_default_transaction_read_only !== "boolean"
      || role.has_database_role_read_only_override !== false
      || role.default_transaction_read_only !== "on"
      || role.can_create_schema !== false
      || role.can_select_target !== true
      || role.has_unapproved_select !== false
      || role.can_insert_target !== false
      || role.can_update_target !== false
      || role.can_delete_target !== false
      || role.can_truncate_target !== false
      || role.can_references_target !== false
      || role.can_trigger_target !== false
    ) {
      throw new OwnershipInventoryError("OWNERSHIP_INVENTORY_PREFLIGHT_FAILED");
    }
    return appliedMigrationCount;
  } catch (error) {
    if (error instanceof OwnershipInventoryError && (error.code === "OWNERSHIP_INVENTORY_QUERY_FAILED" || error.code === "OWNERSHIP_INVENTORY_RESULT_INVALID")) {
      throw error;
    }
    throw new OwnershipInventoryError("OWNERSHIP_INVENTORY_PREFLIGHT_FAILED");
  }
}

async function readAggregateRow<Row>(client: InventoryQueryClient, query: string): Promise<Row> {
  return requireSingleRow(await queryRows<Row>(client, query));
}

async function readInventoryRows(client: InventoryQueryClient, appliedMigrationCount: CountValue): Promise<OwnershipInventoryRows> {
  return {
    appliedMigrationCount,
    accounts: await readAggregateRow<AccountAggregateRow>(client, SQL.accounts),
    git: await readAggregateRow<OwnershipAggregateRow>(client, SQL.git),
    mcp: await readAggregateRow<McpAggregateRow>(client, SQL.mcp),
    aiProvider: await readAggregateRow<ProviderAggregateRow>(client, SQL.aiProvider),
    githubConnectionLegacy: await readAggregateRow<LegacyGitHubAggregateRow>(client, SQL.githubConnectionLegacy),
    platformTokenGrants: await readAggregateRow<PlatformTokenGrantAggregateRow>(client, SQL.platformTokenGrants),
    platformDefaultRoutes: await readAggregateRow<PlatformDefaultRouteAggregateRow>(client, SQL.platformDefaultRoutes),
    activeVectorIndex: await readAggregateRow<ActiveVectorIndexAggregateRow>(client, SQL.activeVectorIndex),
  };
}

export async function runOwnershipInventory(
  client: InventoryQueryClient,
  generatedAt: Date = new Date(),
): Promise<OwnershipInventoryReport> {
  let failure: OwnershipInventoryError | undefined;
  let report: OwnershipInventoryReport | undefined;

  try {
    try {
      await client.query(SQL.begin);
    } catch {
      throw new OwnershipInventoryError("OWNERSHIP_INVENTORY_QUERY_FAILED");
    }
    try {
      await client.query(SQL.searchPath);
    } catch {
      throw new OwnershipInventoryError("OWNERSHIP_INVENTORY_QUERY_FAILED");
    }
    await validateReadOnlyTransaction(client);
    const appliedMigrationCount = await validateOwnershipInventoryPreflight(client);
    const rows = await readInventoryRows(client, appliedMigrationCount);
    report = buildOwnershipInventoryReport(rows, generatedAt);
  } catch (error) {
    failure = error instanceof OwnershipInventoryError
      ? error
      : new OwnershipInventoryError("OWNERSHIP_INVENTORY_FAILED");
  } finally {
    try {
      await client.query(SQL.rollback);
    } catch {
      if (failure === undefined) failure = new OwnershipInventoryError("OWNERSHIP_INVENTORY_ROLLBACK_FAILED");
    }
  }

  if (failure !== undefined) throw failure;
  if (report === undefined) throw new OwnershipInventoryError("OWNERSHIP_INVENTORY_RESULT_INVALID");
  return report;
}

function asInventoryQueryClient(client: Client): InventoryQueryClient {
  return {
    query: async <Row = unknown>(text: string, values?: readonly unknown[]) => {
      const result = await client.query(text, values === undefined ? undefined : [...values]);
      return { rows: result.rows as readonly Row[] };
    },
  };
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value));
}

function validatePgDriverEnvironment(env: Readonly<Record<string, string | undefined>>): void {
  // pg@8.16.3 reads PGBINARY through its generic PG* fallback. There is no
  // truthy config value that means "binary false", so reject it before the
  // Client constructor rather than allowing ambient process state to win.
  if ([env.PGBINARY, process.env.PGBINARY].some((value) => typeof value === "string" && value !== "")) {
    throw new OwnershipInventoryError("OWNERSHIP_INVENTORY_DATABASE_URL_INVALID");
  }
}

export async function main(
  args: readonly string[] = readCliArguments(),
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<number> {
  try {
    parseOwnershipInventoryArguments(args);
    const clientConfig = readOwnershipInventoryDatabaseConfig(env);
    validatePgDriverEnvironment(env);
    const client = new Client(clientConfig);
    try {
      await client.connect();
    } catch {
      printJson(buildOwnershipInventoryFailure(new OwnershipInventoryError("OWNERSHIP_INVENTORY_DATABASE_CONNECT_FAILED")));
      return 1;
    }

    try {
      const report = await runOwnershipInventory(asInventoryQueryClient(client));
      printJson(report);
      return 0;
    } catch (error) {
      printJson(buildOwnershipInventoryFailure(error));
      return 1;
    } finally {
      try {
        await client.end();
      } catch {
        // The report is already safe and independent from close details.
      }
    }
  } catch (error) {
    printJson(buildOwnershipInventoryFailure(error));
    return 1;
  }
}

const isDirectExecution = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  void main().then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error) => {
    printJson({ ok: false, error: { code: safeOwnershipInventoryErrorCode(error) } });
    process.exitCode = 1;
  });
}

export type InventoryCountValue = CountValue;
