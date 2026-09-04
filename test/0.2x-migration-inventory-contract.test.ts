import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import {
  buildOwnershipInventoryFailure,
  buildOwnershipInventoryReport,
  classifyOwnedResource,
  classifyProviderResource,
  INVENTORY_TABLES,
  OWNERSHIP_INVENTORY_KIND,
  OWNERSHIP_INVENTORY_REPORT_VERSION,
  OWNERSHIP_INVENTORY_APPLICATION_NAME,
  OWNERSHIP_INVENTORY_CLIENT_ENCODING,
  OWNERSHIP_INVENTORY_CLIENT_OPTIONS,
  OWNERSHIP_INVENTORY_CONNECTION_TIMEOUT_MILLIS,
  OWNERSHIP_INVENTORY_REPLICATION,
  parseOwnershipInventoryArguments,
  parseOwnershipInventoryDatabaseUrl,
  readOwnershipInventoryDatabaseConfig,
  type LegacyGitHubAggregateRow,
  type McpAggregateRow,
  type OwnershipAggregateRow,
  type OwnershipInventoryRows,
  type AccountAggregateRow,
  type ActiveVectorIndexAggregateRow,
  type PlatformDefaultRouteAggregateRow,
  type PlatformTokenGrantAggregateRow,
  type ProviderAggregateRow,
} from "../scripts/0.2x-migration-inventory-contract";
import { INVENTORY_SQL, main, runOwnershipInventory } from "../scripts/0.2x-migration-inventory";

async function collectFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

const migrationNames = [
  "20260903010000_add_user_system_role_compatibility",
  "20260903020000_add_user_ai_provider_scope",
  "20260903030000_add_platform_policies_and_connection_ownership",
] as const;

function zeroOwnershipRow(): OwnershipAggregateRow {
  return {
    total: 0,
    confirmed: 0,
    legacy_pending: 0,
    ambiguous: 0,
    invalid: 0,
    candidate_only: 0,
    repositories: 0,
    project_repository_links: 0,
    active_project_repository_links: 0,
    references_with_different_actor: 0,
    active_references_with_different_actor: 0,
    connections_with_different_reference_actor: 0,
    connections_with_creator_outside_project_access: 0,
    active_connections_with_creator_outside_project_access: 0,
    owner_candidate_exact_name_conflict_groups: 0,
    connections_in_owner_candidate_exact_name_conflicts: 0,
    personal_direct_references: 0,
    personal_active_direct_references: 0,
    personal_distinct_projects: 0,
    personal_potential_non_terminal_jobs: 0,
    personal_potential_active_automations: 0,
  };
}

function zeroMcpRow(): McpAggregateRow {
  return {
    total: 0,
    confirmed: 0,
    legacy_pending: 0,
    ambiguous: 0,
    invalid: 0,
    candidate_only: 0,
    tool_definitions: 0,
    current_tool_definitions: 0,
    project_tool_grants: 0,
    active_project_tool_grants: 0,
    references_with_different_actor: 0,
    active_references_with_different_actor: 0,
    connections_with_different_reference_actor: 0,
    connections_with_creator_outside_project_access: 0,
    active_connections_with_creator_outside_project_access: 0,
    owner_candidate_exact_name_conflict_groups: 0,
    connections_in_owner_candidate_exact_name_conflicts: 0,
    personal_direct_references: 0,
    personal_active_direct_references: 0,
    personal_distinct_projects: 0,
    personal_potential_non_terminal_jobs: 0,
    personal_potential_active_automations: 0,
  };
}

function zeroProviderRow(): ProviderAggregateRow {
  return {
    total: 0,
    platform: 0,
    workspace: 0,
    user: 0,
    confirmed: 0,
    legacy_pending: 0,
    ambiguous: 0,
    invalid: 0,
    workspace_owner: 0,
    workspace_admin: 0,
    workspace_member: 0,
    workspace_viewer: 0,
    workspace_missing: 0,
    workspace_not_evaluable: 0,
    project_ai_routes: 0,
    route_revisions_old: 0,
    route_revisions_new: 0,
    web_ai_grants: 0,
    open_web_ai_grants: 0,
    platform_token_reservations: 0,
    open_token_reservations: 0,
    provider_call_audits: 0,
    memory_index_generations: 0,
    derived_ai_artifacts: 0,
    platform_default_routes: 0,
    structurally_valid: 0,
    structurally_invalid: 0,
    workspace_with_membership: 0,
    workspace_without_membership: 0,
    personal_direct_project_routes: 0,
    personal_distinct_projects: 0,
    personal_open_web_ai_grants: 0,
    personal_direct_non_terminal_jobs: 0,
    personal_potential_active_automations: 0,
  };
}

function zeroGithubRow(): LegacyGitHubAggregateRow {
  return {
    project_scoped_total: 0,
    configured: 0,
    verified: 0,
    disabled: 0,
    access_unknown: 0,
    invalid_status: 0,
    credential_attached: 0,
    project_repository_links: 0,
    github_sync_entries: 0,
  };
}

function zeroGrantRow(): PlatformTokenGrantAggregateRow {
  return { total: 0, available: 0, expired: 0, revoked: 0 };
}

function zeroAccountRow(): AccountAggregateRow {
  return {
    total: 0,
    admin: 0,
    legacy_member: 0,
    user: 0,
    invalid: 0,
    enabled: 0,
    disabled: 0,
    active_offer_policies: 0,
    enabled_without_any_grant: 0,
    enabled_without_signup_grant: 0,
    enabled_without_available_grant: 0,
  };
}

function zeroPlatformDefaultRouteRow(): PlatformDefaultRouteAggregateRow {
  return {
    provider_total: 0,
    total: 0,
    draft: 0,
    verified: 0,
    active: 0,
    retired: 0,
    invalid: 0,
    candidate_total: 0,
    candidate_usable: 0,
    candidate_unusable: 0,
    active_total: 0,
    active_usable: 0,
    active_unusable: 0,
    provider_capabilities_generation: 0,
    provider_capabilities_vision: 0,
    provider_capabilities_embedding: 0,
  };
}

function zeroActiveVectorIndexRow(): ActiveVectorIndexAggregateRow {
  return {
    total: 0,
    matches_active_default_embedding_route: 0,
    differs_from_active_default_embedding_route: 0,
    no_active_default_embedding_route: 0,
    matches_draft_or_verified_candidate_tuple: 0,
  };
}

function zeroRows(): OwnershipInventoryRows {
  return {
    appliedMigrationCount: 57,
    accounts: zeroAccountRow(),
    git: zeroOwnershipRow(),
    mcp: zeroMcpRow(),
    aiProvider: zeroProviderRow(),
    githubConnectionLegacy: zeroGithubRow(),
    platformTokenGrants: zeroGrantRow(),
    platformDefaultRoutes: zeroPlatformDefaultRouteRow(),
    activeVectorIndex: zeroActiveVectorIndexRow(),
  };
}

function preflightRows(): Readonly<Record<string, unknown>> {
  return {
    migrationRows: migrationNames.map((migration_name) => ({ migration_name, applied: true, applied_migration_count: "57" })),
    constraintRows: [
      { constraint_name: "GitConnection_ownership_check", relation_name: "GitConnection", constraint_type: "c", validated: true },
      { constraint_name: "McpConnection_ownership_check", relation_name: "McpConnection", constraint_type: "c", validated: true },
      { constraint_name: "AiProviderConnection_scope_check", relation_name: "AiProviderConnection", constraint_type: "c", validated: true },
    ],
    enumRows: [
      ...["legacy_pending", "ambiguous", "confirmed"].map((enum_value, index) => ({ enum_name: "ResourceOwnershipState", enum_value, enum_sort_order: index + 1 })),
      ...["platform", "workspace", "user"].map((enum_value, index) => ({ enum_name: "AiProviderScope", enum_value, enum_sort_order: index + 1 })),
    ],
    rlsRows: INVENTORY_TABLES.map((relation_name) => ({ relation_name, row_security: false, force_row_security: false })),
    roleRows: [{
      role_name: "inventory_reader",
      is_superuser: false,
      bypass_rls: false,
      can_replicate: false,
      owns_database: false,
      owns_schema: false,
      owns_target_table: false,
      can_create_database: false,
      can_create_database_role: false,
      can_create_role: false,
      can_create_schema: false,
      can_create_temporary: false,
      role_default_transaction_read_only: true,
      database_default_transaction_read_only: false,
      has_database_role_read_only_override: false,
      default_transaction_read_only: "on",
      can_select_target: true,
      has_unapproved_select: false,
      can_insert_target: false,
      can_update_target: false,
      can_delete_target: false,
      can_truncate_target: false,
      can_references_target: false,
      can_trigger_target: false,
    }],
  };
}

test("inventory contract fixes the redacted report identity and exact resource shape", () => {
  assert.equal(OWNERSHIP_INVENTORY_KIND, "ownership-migration-inventory");
  assert.equal(OWNERSHIP_INVENTORY_REPORT_VERSION, 1);
  assert.deepEqual(INVENTORY_TABLES, [
    "_prisma_migrations",
    "AppUser",
    "PlatformGrantOfferPolicy",
    "Project",
    "ProjectMembership",
    "GitConnection",
    "GitRepository",
    "ProjectGitRepositoryLink",
    "McpConnection",
    "McpToolDefinition",
    "ProjectMcpToolGrant",
    "AiProviderConnection",
    "WorkspaceMembership",
    "ProjectAiRoute",
    "ProjectAiRouteRevision",
    "WebAiGrant",
    "PlatformTokenReservation",
    "ProviderCallAudit",
    "MemoryIndexGeneration",
    "RagAnswer",
    "WebAiCandidate",
    "ProjectIntelligenceReport",
    "ProjectAgentRun",
    "ProjectAssetExtractionRun",
    "ProjectAssetSegment",
    "BackgroundJob",
    "AutomationRule",
    "PlatformDefaultAiRoute",
    "MemoryIndexPointer",
    "GitHubConnection",
    "ProjectRepositoryLink",
    "ProjectGitHubSyncEntry",
    "PlatformTokenGrant",
  ]);

  const report = buildOwnershipInventoryReport(zeroRows(), new Date("2026-09-04T00:00:00.000Z"));
  assert.deepEqual(Object.keys(report), ["ok", "kind", "reportVersion", "generatedAt", "snapshot", "resources"]);
  assert.deepEqual(Object.keys(report.snapshot), ["readOnly", "isolation", "migrations", "appliedMigrationCount"]);
  assert.deepEqual(Object.keys(report.resources), ["accounts", "git", "mcp", "aiProvider", "githubConnectionLegacy", "platformTokenGrants", "platformDefaultRoutes", "activeVectorIndex"]);
  assert.deepEqual(Object.keys(report.resources.accounts), ["total", "systemRole", "accountState", "grantCoverage"]);
  assert.deepEqual(Object.keys(report.resources.accounts.systemRole), ["admin", "legacyMember", "user", "invalid"]);
  assert.deepEqual(Object.keys(report.resources.accounts.accountState), ["enabled", "disabled"]);
  assert.deepEqual(Object.keys(report.resources.accounts.grantCoverage), [
    "activeOfferPolicies", "enabledWithoutAnyGrant", "enabledWithoutSignupGrant", "enabledWithoutAvailableGrant",
    "eligibleWithoutGrantKnown", "eligibilityNotEvaluable",
  ]);
  assert.deepEqual(Object.keys(report.resources.git), [
    "total", "ownership", "createdByCandidateOnly", "references", "referencesWithDifferentActor", "activeReferencesWithDifferentActor",
    "connectionsWithDifferentReferenceActor", "connectionsWithCreatorOutsideProjectAccess", "activeConnectionsWithCreatorOutsideProjectAccess",
    "ownerCandidateExactNameConflictGroups", "connectionsInOwnerCandidateExactNameConflicts", "personalReferences",
  ]);
  assert.deepEqual(Object.keys(report.resources.git.ownership), ["confirmed", "legacyPending", "ambiguous", "invalid"]);
  assert.deepEqual(Object.keys(report.resources.git.references), ["repositories", "projectRepositoryLinks", "activeProjectRepositoryLinks"]);
  assert.deepEqual(Object.keys(report.resources.git.personalReferences), [
    "directReferences", "activeDirectReferences", "distinctProjects", "potentialNonTerminalJobsInReferencedProjects",
    "potentialActiveAutomationsInReferencedProjects", "automationDirectBinding",
  ]);
  assert.deepEqual(Object.keys(report.resources.mcp), [
    "total", "ownership", "createdByCandidateOnly", "references", "referencesWithDifferentActor", "activeReferencesWithDifferentActor",
    "connectionsWithDifferentReferenceActor", "connectionsWithCreatorOutsideProjectAccess", "activeConnectionsWithCreatorOutsideProjectAccess",
    "ownerCandidateExactNameConflictGroups", "connectionsInOwnerCandidateExactNameConflicts", "personalReferences",
  ]);
  assert.deepEqual(Object.keys(report.resources.mcp.ownership), ["confirmed", "legacyPending", "ambiguous", "invalid"]);
  assert.deepEqual(Object.keys(report.resources.mcp.references), ["toolDefinitions", "currentToolDefinitions", "projectToolGrants", "activeProjectToolGrants"]);
  assert.deepEqual(Object.keys(report.resources.mcp.personalReferences), [
    "directReferences", "activeDirectReferences", "distinctProjects", "potentialNonTerminalJobsInReferencedProjects",
    "potentialActiveAutomationsInReferencedProjects", "automationDirectBinding",
  ]);
  assert.deepEqual(Object.keys(report.resources.aiProvider), ["total", "scope", "ownership", "workspaceOwnerMembership", "references", "consistency", "personalReferences"]);
  assert.deepEqual(Object.keys(report.resources.aiProvider.scope), ["platform", "workspace", "user"]);
  assert.deepEqual(Object.keys(report.resources.aiProvider.ownership), ["confirmed", "legacyPending", "ambiguous", "invalid"]);
  assert.deepEqual(Object.keys(report.resources.aiProvider.workspaceOwnerMembership), ["owner", "admin", "member", "viewer", "missing", "notEvaluable"]);
  assert.deepEqual(Object.keys(report.resources.aiProvider.references), [
    "projectAiRoutes", "routeRevisionsOld", "routeRevisionsNew", "webAiGrants", "openWebAiGrants",
    "platformTokenReservations", "openTokenReservations", "providerCallAudits", "memoryIndexGenerations", "derivedAiArtifacts", "platformDefaultRoutes",
  ]);
  assert.deepEqual(Object.keys(report.resources.aiProvider.consistency), [
    "structurallyValid", "structurallyInvalid", "workspaceWithMembership", "workspaceWithoutMembership", "workspaceNotEvaluable",
  ]);
  assert.deepEqual(Object.keys(report.resources.aiProvider.personalReferences), [
    "directProjectRoutes", "distinctProjects", "openWebAiGrants", "directNonTerminalJobs", "potentialActiveAutomationsInReferencedProjects",
    "automationDirectBinding",
  ]);
  assert.deepEqual(Object.keys(report.resources.githubConnectionLegacy), [
    "projectScopedTotal", "configured", "verified", "disabled", "accessUnknown", "invalidStatus", "credentialAttached", "projectRepositoryLinks", "githubSyncEntries",
  ]);
  assert.deepEqual(Object.keys(report.resources.platformTokenGrants), ["total", "available", "expired", "revoked"]);
  assert.deepEqual(Object.keys(report.resources.platformDefaultRoutes), ["total", "status", "candidate", "active", "providerCapabilities"]);
  assert.deepEqual(Object.keys(report.resources.platformDefaultRoutes.status), ["draft", "verified", "active", "retired", "invalid"]);
  assert.deepEqual(Object.keys(report.resources.platformDefaultRoutes.candidate), ["total", "usable", "unusable"]);
  assert.deepEqual(Object.keys(report.resources.platformDefaultRoutes.active), ["total", "usable", "unusable"]);
  assert.deepEqual(Object.keys(report.resources.platformDefaultRoutes.providerCapabilities), ["generation", "vision", "embedding"]);
  assert.deepEqual(Object.keys(report.resources.activeVectorIndex), [
    "total", "matchesActiveDefaultEmbeddingRoute", "differsFromActiveDefaultEmbeddingRoute", "noActiveDefaultEmbeddingRoute",
    "matchesDraftOrVerifiedCandidateTuple",
  ]);
  assert.deepEqual(report.snapshot, {
    readOnly: true,
    isolation: "repeatable_read",
    migrations: { m100: "applied", m200: "applied", m300: "applied" },
    appliedMigrationCount: 57,
  });
});

test("inventory classification keeps owner inference and provider scope fail-closed", () => {
  assert.deepEqual(classifyOwnedResource({ ownershipState: "confirmed", ownerUserId: "u", createdById: "c" }), { bucket: "confirmed", candidateOnly: false });
  assert.deepEqual(classifyOwnedResource({ ownershipState: "legacy_pending", ownerUserId: null, createdById: "c" }), { bucket: "legacyPending", candidateOnly: true });
  assert.deepEqual(classifyOwnedResource({ ownershipState: "confirmed", ownerUserId: null, createdById: "c" }), { bucket: "invalid", candidateOnly: true });
  assert.equal(classifyProviderResource({ scope: "platform", workspaceId: null, ownerUserId: null, ownershipState: "legacy_pending" }), "platformLegacyPending");
  assert.equal(classifyProviderResource({ scope: "workspace", workspaceId: "w", ownerUserId: "u", ownershipState: "ambiguous" }), "workspaceAmbiguous");
  assert.equal(classifyProviderResource({ scope: "user", workspaceId: null, ownerUserId: "u", ownershipState: "confirmed" }), "userConfirmed");
  assert.equal(classifyProviderResource({ scope: "future", workspaceId: null, ownerUserId: "u", ownershipState: "confirmed" }), "invalid");
});

test("inventory aggregates all Phase-B dimensions without inferring ownership", () => {
  const rows = zeroRows();
  rows.accounts.total = 3;
  rows.accounts.admin = 1;
  rows.accounts.legacy_member = 1;
  rows.accounts.user = 1;
  rows.accounts.enabled = 2;
  rows.accounts.disabled = 1;
  rows.accounts.active_offer_policies = 1;
  rows.accounts.enabled_without_any_grant = 1;
  rows.accounts.enabled_without_signup_grant = 1;
  rows.accounts.enabled_without_available_grant = 1;

  rows.git.total = 1;
  rows.git.confirmed = 1;
  rows.git.project_repository_links = 1;
  rows.git.active_project_repository_links = 1;
  rows.git.references_with_different_actor = 1;
  rows.git.active_references_with_different_actor = 1;
  rows.git.connections_with_different_reference_actor = 1;
  rows.git.connections_with_creator_outside_project_access = 1;
  rows.git.active_connections_with_creator_outside_project_access = 1;
  rows.git.personal_direct_references = 1;
  rows.git.personal_active_direct_references = 1;
  rows.git.personal_distinct_projects = 1;
  rows.git.personal_potential_non_terminal_jobs = 2;
  rows.git.personal_potential_active_automations = 1;

  rows.mcp.total = 1;
  rows.mcp.confirmed = 1;
  rows.mcp.project_tool_grants = 1;
  rows.mcp.active_project_tool_grants = 1;
  rows.mcp.references_with_different_actor = 1;
  rows.mcp.active_references_with_different_actor = 1;
  rows.mcp.connections_with_different_reference_actor = 1;
  rows.mcp.connections_with_creator_outside_project_access = 1;
  rows.mcp.active_connections_with_creator_outside_project_access = 1;
  rows.mcp.personal_direct_references = 1;
  rows.mcp.personal_active_direct_references = 1;
  rows.mcp.personal_distinct_projects = 1;
  rows.mcp.personal_potential_non_terminal_jobs = 2;
  rows.mcp.personal_potential_active_automations = 1;

  rows.aiProvider.total = 3;
  rows.aiProvider.platform = 1;
  rows.aiProvider.workspace = 1;
  rows.aiProvider.user = 1;
  rows.aiProvider.confirmed = 1;
  rows.aiProvider.legacy_pending = 1;
  rows.aiProvider.ambiguous = 1;
  rows.aiProvider.workspace_owner = 1;
  rows.aiProvider.workspace_not_evaluable = 2;
  rows.aiProvider.structurally_valid = 3;
  rows.aiProvider.workspace_with_membership = 1;
  rows.aiProvider.workspace_without_membership = 0;
  rows.aiProvider.personal_direct_project_routes = 1;
  rows.aiProvider.personal_distinct_projects = 1;
  rows.aiProvider.project_ai_routes = 1;
  rows.aiProvider.personal_open_web_ai_grants = 1;
  rows.aiProvider.web_ai_grants = 1;
  rows.aiProvider.open_web_ai_grants = 1;
  rows.aiProvider.personal_direct_non_terminal_jobs = 2;
  rows.aiProvider.personal_potential_active_automations = 1;

  rows.githubConnectionLegacy.project_scoped_total = 1;
  rows.githubConnectionLegacy.configured = 1;
  rows.githubConnectionLegacy.credential_attached = 1;
  rows.platformDefaultRoutes.provider_total = 1;
  rows.platformDefaultRoutes.total = 2;
  rows.platformDefaultRoutes.draft = 1;
  rows.platformDefaultRoutes.active = 1;
  rows.platformDefaultRoutes.candidate_total = 1;
  rows.platformDefaultRoutes.candidate_usable = 1;
  rows.platformDefaultRoutes.active_total = 1;
  rows.platformDefaultRoutes.active_usable = 1;
  rows.platformDefaultRoutes.provider_capabilities_generation = 1;
  rows.platformDefaultRoutes.provider_capabilities_vision = 1;
  rows.platformDefaultRoutes.provider_capabilities_embedding = 1;
  rows.activeVectorIndex.total = 2;
  rows.activeVectorIndex.matches_active_default_embedding_route = 1;
  rows.activeVectorIndex.differs_from_active_default_embedding_route = 1;
  rows.activeVectorIndex.matches_draft_or_verified_candidate_tuple = 1;

  const report = buildOwnershipInventoryReport(rows, new Date("2026-09-04T00:00:00.000Z"));
  assert.deepEqual(report.resources.accounts.grantCoverage, {
    activeOfferPolicies: 1,
    enabledWithoutAnyGrant: 1,
    enabledWithoutSignupGrant: 1,
    enabledWithoutAvailableGrant: 1,
    eligibleWithoutGrantKnown: 0,
    eligibilityNotEvaluable: 1,
  });
  assert.equal(report.resources.git.personalReferences.potentialNonTerminalJobsInReferencedProjects, 2);
  assert.equal(report.resources.git.personalReferences.automationDirectBinding, "not_evaluable_without_typed_delegation");
  assert.equal(report.resources.mcp.personalReferences.automationDirectBinding, "not_evaluable_without_typed_delegation");
  assert.equal(report.resources.mcp.personalReferences.potentialActiveAutomationsInReferencedProjects, 1);
  assert.deepEqual(report.resources.aiProvider.consistency, {
    structurallyValid: 3,
    structurallyInvalid: 0,
    workspaceWithMembership: 1,
    workspaceWithoutMembership: 0,
    workspaceNotEvaluable: 2,
  });
  assert.equal(report.resources.aiProvider.personalReferences.directNonTerminalJobs, 2);
  assert.equal(report.resources.aiProvider.personalReferences.automationDirectBinding, "not_evaluable_without_typed_delegation");
  assert.equal(report.resources.githubConnectionLegacy.invalidStatus, 0);
  assert.deepEqual(report.resources.platformDefaultRoutes.candidate, { total: 1, usable: 1, unusable: 0 });
  assert.deepEqual(report.resources.activeVectorIndex, {
    total: 2,
    matchesActiveDefaultEmbeddingRoute: 1,
    differsFromActiveDefaultEmbeddingRoute: 1,
    noActiveDefaultEmbeddingRoute: 0,
    matchesDraftOrVerifiedCandidateTuple: 1,
  });
});

test("inventory arguments and database URL are strict and independent of ambient configuration", () => {
  assert.doesNotThrow(() => parseOwnershipInventoryArguments([]));
  for (const argument of ["--write", "--apply", "--fix", "--output=report.json", "--project-id=abc", "--unknown"]) {
    assert.throws(() => parseOwnershipInventoryArguments([argument]), /OWNERSHIP_INVENTORY_ARGUMENTS_INVALID/);
  }
  assert.throws(() => readOwnershipInventoryDatabaseConfig({ DATABASE_URL: "postgresql://fallback/db" }), /OWNERSHIP_INVENTORY_DATABASE_URL_REQUIRED/);

  const loopbackConfig = readOwnershipInventoryDatabaseConfig({
    OWNERSHIP_INVENTORY_DATABASE_URL: "postgresql://reader:secret%40value@127.0.0.1:56432/inventory?sslmode=disable",
    PGHOST: "evil.example",
    PGPORT: "1",
    PGUSER: "evil-user",
    PGPASSWORD: "evil-password",
    PGSSLMODE: "require",
    PGSSLROOTCERT: "/tmp/evil-ca.pem",
  });
  assert.deepEqual(loopbackConfig, {
    host: "127.0.0.1",
    port: 56432,
    user: "reader",
    password: "secret@value",
    database: "inventory",
    binary: false,
    client_encoding: OWNERSHIP_INVENTORY_CLIENT_ENCODING,
    replication: OWNERSHIP_INVENTORY_REPLICATION,
    ssl: false,
    connectionTimeoutMillis: OWNERSHIP_INVENTORY_CONNECTION_TIMEOUT_MILLIS,
    application_name: OWNERSHIP_INVENTORY_APPLICATION_NAME,
    options: OWNERSHIP_INVENTORY_CLIENT_OPTIONS,
  });

  const ipv6Config = parseOwnershipInventoryDatabaseUrl("postgresql://reader:secret@[::1]:56432/inventory?sslmode=disable");
  assert.equal(ipv6Config.host, "::1");
  assert.equal(ipv6Config.ssl, false);

  const localhostTlsConfig = parseOwnershipInventoryDatabaseUrl("postgresql://reader:secret@localhost:56432/inventory?sslmode=verify-full");
  assert.equal(localhostTlsConfig.host, "localhost");
  assert.deepEqual(localhostTlsConfig.ssl, { rejectUnauthorized: true });

  const remoteConfig = parseOwnershipInventoryDatabaseUrl("postgresql://reader:secret@db.internal:5432/inventory?sslmode=verify-full");
  assert.deepEqual(remoteConfig, {
    host: "db.internal",
    port: 5432,
    user: "reader",
    password: "secret",
    database: "inventory",
    binary: false,
    client_encoding: OWNERSHIP_INVENTORY_CLIENT_ENCODING,
    replication: OWNERSHIP_INVENTORY_REPLICATION,
    ssl: { rejectUnauthorized: true },
    connectionTimeoutMillis: OWNERSHIP_INVENTORY_CONNECTION_TIMEOUT_MILLIS,
    application_name: OWNERSHIP_INVENTORY_APPLICATION_NAME,
    options: OWNERSHIP_INVENTORY_CLIENT_OPTIONS,
  });

  for (const value of [
    "https://example.test/inventory?sslmode=verify-full",
    "postgresql://reader:secret@127.0.0.1/inventory?sslmode=disable",
    "postgresql://reader:secret@127.0.0.1:56432/inventory",
    "postgresql://reader:secret@127.0.0.1:56432/inventory?sslmode=disable&sslmode=disable",
    "postgresql://reader:secret@127.0.0.1:56432/inventory?sslmode=disable&",
    "postgresql://reader:secret@127.0.0.1:56432/inventory?sslmode=require",
    "postgresql://reader:secret@127.0.0.1:56432/inventory?sslmode=prefer",
    "postgresql://reader:secret@127.0.0.1:56432/inventory?sslmode=no-verify",
    "postgresql://reader:secret@127.0.0.1:56432/inventory?sslmode=disable&host=evil.example",
    "postgresql://reader:secret@127.0.0.1:56432/inventory?sslmode=disable&port=1",
    "postgresql://reader:secret@127.0.0.1:56432/inventory?sslmode=disable&sslcert=/tmp/cert.pem",
    "postgresql://reader:secret@127.0.0.1:56432/inventory?sslmode=disable&sslkey=/tmp/key.pem",
    "postgresql://reader:secret@127.0.0.1:56432/inventory?sslmode=disable&sslrootcert=/tmp/ca.pem",
    "postgresql://reader:secret@localhost:56432/inventory?sslmode=disable",
    "postgresql://reader:secret@db.internal:56432/inventory?sslmode=disable",
    "postgresql://reader:secret@127.0.0.1:56432/inventory/extra?sslmode=disable",
    "postgresql://reader@127.0.0.1:56432/inventory?sslmode=disable",
    "postgresql://:secret@127.0.0.1:56432/inventory?sslmode=disable",
    "postgresql://reader:secret@127.0.0.1:0/inventory?sslmode=disable",
    "postgresql://reader:secret@127.0.0.1:65536/inventory?sslmode=disable",
    "postgresql://reader:secret@127.0.0.1:56432/inventory?sslmode=disable#fragment",
    "postgresql://reader:secret@127.0.0.1:56432/inventory?sslmode=disable#",
    "postgresql://reader:secret@127.000.000.001:56432/inventory?sslmode=disable",
    "postgresql://reader:secret@[0:0:0:0:0:0:0:1]:56432/inventory?sslmode=disable",
    "postgresql://reader%ZZ:secret@127.0.0.1:56432/inventory?sslmode=disable",
    "postgresql://reader:secret@127.0.0.1:56432/inventory%2Fextra?sslmode=disable",
  ]) {
    assert.throws(() => parseOwnershipInventoryDatabaseUrl(value), /OWNERSHIP_INVENTORY_DATABASE_URL_INVALID/);
  }
});

test("inventory report rejects unsafe or inconsistent aggregate rows", () => {
  const invalidStatus = zeroGithubRow();
  invalidStatus.project_scoped_total = 1;
  invalidStatus.configured = 1;
  invalidStatus.invalid_status = 1;
  assert.throws(
    () => buildOwnershipInventoryReport({ ...zeroRows(), githubConnectionLegacy: invalidStatus }, new Date("2026-09-04T00:00:00.000Z")),
    /OWNERSHIP_INVENTORY_RESULT_INVALID/,
  );

  const invalidCount = zeroRows();
  invalidCount.appliedMigrationCount = "9007199254740992";
  assert.throws(() => buildOwnershipInventoryReport(invalidCount), /OWNERSHIP_INVENTORY_RESULT_INVALID/);
  for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const invalidValue = zeroRows();
    invalidValue.git.total = value;
    assert.throws(() => buildOwnershipInventoryReport(invalidValue), /OWNERSHIP_INVENTORY_RESULT_INVALID/);
  }
  const missingMigrationCount = { ...zeroRows() } as Partial<OwnershipInventoryRows>;
  delete missingMigrationCount.appliedMigrationCount;
  assert.throws(
    () => buildOwnershipInventoryReport(missingMigrationCount as OwnershipInventoryRows),
    /OWNERSHIP_INVENTORY_RESULT_INVALID/,
  );
  assert.deepEqual(buildOwnershipInventoryFailure(new Error("sensitive database detail")), { ok: false, error: { code: "OWNERSHIP_INVENTORY_FAILED" } });

  const invalidAccountPolicy = zeroRows();
  invalidAccountPolicy.accounts.active_offer_policies = 2;
  assert.throws(() => buildOwnershipInventoryReport(invalidAccountPolicy), /OWNERSHIP_INVENTORY_RESULT_INVALID/);

  const invalidGitSubset = zeroRows();
  invalidGitSubset.git.total = 1;
  invalidGitSubset.git.confirmed = 1;
  invalidGitSubset.git.project_repository_links = 1;
  invalidGitSubset.git.active_project_repository_links = 1;
  invalidGitSubset.git.personal_direct_references = 2;
  assert.throws(() => buildOwnershipInventoryReport(invalidGitSubset), /OWNERSHIP_INVENTORY_RESULT_INVALID/);

  const invalidGitActiveLinks = zeroRows();
  invalidGitActiveLinks.git.total = 1;
  invalidGitActiveLinks.git.confirmed = 1;
  invalidGitActiveLinks.git.project_repository_links = 1;
  invalidGitActiveLinks.git.active_project_repository_links = 2;
  assert.throws(() => buildOwnershipInventoryReport(invalidGitActiveLinks), /OWNERSHIP_INVENTORY_RESULT_INVALID/);

  const invalidMcpSubset = zeroRows();
  invalidMcpSubset.mcp.total = 1;
  invalidMcpSubset.mcp.confirmed = 1;
  invalidMcpSubset.mcp.project_tool_grants = 1;
  invalidMcpSubset.mcp.active_project_tool_grants = 1;
  invalidMcpSubset.mcp.active_references_with_different_actor = 1;
  invalidMcpSubset.mcp.references_with_different_actor = 0;
  assert.throws(() => buildOwnershipInventoryReport(invalidMcpSubset), /OWNERSHIP_INVENTORY_RESULT_INVALID/);

  const invalidProviderConsistency = zeroRows();
  invalidProviderConsistency.aiProvider.total = 1;
  invalidProviderConsistency.aiProvider.platform = 1;
  invalidProviderConsistency.aiProvider.structurally_valid = 2;
  assert.throws(() => buildOwnershipInventoryReport(invalidProviderConsistency), /OWNERSHIP_INVENTORY_RESULT_INVALID/);

  const invalidPlatformRoutePartition = zeroRows();
  invalidPlatformRoutePartition.platformDefaultRoutes.provider_total = 1;
  invalidPlatformRoutePartition.platformDefaultRoutes.total = 1;
  invalidPlatformRoutePartition.platformDefaultRoutes.draft = 1;
  invalidPlatformRoutePartition.platformDefaultRoutes.candidate_total = 1;
  invalidPlatformRoutePartition.platformDefaultRoutes.candidate_usable = 2;
  assert.throws(() => buildOwnershipInventoryReport(invalidPlatformRoutePartition), /OWNERSHIP_INVENTORY_RESULT_INVALID/);

  const invalidVectorPartition = zeroRows();
  invalidVectorPartition.activeVectorIndex.total = 1;
  invalidVectorPartition.activeVectorIndex.matches_active_default_embedding_route = 1;
  invalidVectorPartition.activeVectorIndex.no_active_default_embedding_route = 1;
  assert.throws(() => buildOwnershipInventoryReport(invalidVectorPartition), /OWNERSHIP_INVENTORY_RESULT_INVALID/);
});

test("inventory output never carries row-level identifiers or content", () => {
  const rows = zeroRows() as OwnershipInventoryRows & Record<string, unknown>;
  rows.sentinel = {
    id: "00000000-0000-4000-8000-000000000099",
    email: "sentinel@example.invalid",
    name: "sentinel-name",
    url: "https://sentinel.invalid/private",
    authRef: "sentinel-auth-ref",
    fingerprint: "sentinel-fingerprint",
    modelId: "sentinel-model-id",
    projectContent: "sentinel-project-content",
  };
  for (const row of [rows.accounts, rows.git, rows.mcp, rows.aiProvider, rows.githubConnectionLegacy, rows.platformTokenGrants, rows.platformDefaultRoutes, rows.activeVectorIndex]) {
    (row as unknown as Record<string, unknown>).sentinel = rows.sentinel;
  }
  const report = buildOwnershipInventoryReport(rows, new Date("2026-09-04T00:00:00.000Z"));
  const serialized = JSON.stringify(report);
  for (const sentinel of [
    "00000000-0000-4000-8000-000000000099", "sentinel@example.invalid", "sentinel-name", "https://sentinel.invalid/private",
    "sentinel-auth-ref", "sentinel-fingerprint", "sentinel-model-id", "sentinel-project-content",
  ]) {
    assert.equal(serialized.includes(sentinel), false);
  }
});

test("inventory rejects real arguments before constructing or connecting a client", async () => {
  const output: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => output.push(values.map(String).join(" "));
  try {
    const exitCode = await main(["--write"], {
      OWNERSHIP_INVENTORY_DATABASE_URL: "postgresql://invalid:invalid@127.0.0.1:56432/does_not_exist",
    });
    assert.equal(exitCode, 1);
  } finally {
    console.log = originalLog;
  }
  assert.equal(output.length, 1);
  const parsed = JSON.parse(output[0] ?? "{}");
  assert.deepEqual(parsed, { ok: false, error: { code: "OWNERSHIP_INVENTORY_ARGUMENTS_INVALID" } });
  assert.equal(JSON.stringify(parsed).includes("CONNECT_FAILED"), false);

  const unsafeDriverOutput: string[] = [];
  console.log = (...values: unknown[]) => unsafeDriverOutput.push(values.map(String).join(" "));
  try {
    const exitCode = await main([], {
      OWNERSHIP_INVENTORY_DATABASE_URL: "postgresql://invalid:invalid@127.0.0.1:56432/does_not_exist?sslmode=disable",
      PGBINARY: "true",
    });
    assert.equal(exitCode, 1);
  } finally {
    console.log = originalLog;
  }
  assert.deepEqual(unsafeDriverOutput, [JSON.stringify({ ok: false, error: { code: "OWNERSHIP_INVENTORY_DATABASE_URL_INVALID" } })]);
});

test("inventory execution is fixed-query, read-only and rollback-only", async () => {
  const fixtures = preflightRows();
  const calls: string[] = [];
  const client = {
    async query<Row = unknown>(text: string): Promise<{ rows: readonly Row[] }> {
      calls.push(text);
      if (text === INVENTORY_SQL.begin || text === INVENTORY_SQL.searchPath || text === INVENTORY_SQL.rollback) return { rows: [] as readonly Row[] };
      if (text === INVENTORY_SQL.transactionReadOnly) return { rows: [{ transaction_read_only: "on" }] as unknown as readonly Row[] };
      if (text === INVENTORY_SQL.migrations) return { rows: fixtures.migrationRows as unknown as readonly Row[] };
      if (text === INVENTORY_SQL.constraints) return { rows: fixtures.constraintRows as unknown as readonly Row[] };
      if (text === INVENTORY_SQL.enums) return { rows: fixtures.enumRows as unknown as readonly Row[] };
      if (text === INVENTORY_SQL.rls) return { rows: fixtures.rlsRows as unknown as readonly Row[] };
      if (text === INVENTORY_SQL.role) return { rows: fixtures.roleRows as unknown as readonly Row[] };
      if (text === INVENTORY_SQL.accounts) return { rows: [zeroAccountRow()] as unknown as readonly Row[] };
      if (text === INVENTORY_SQL.git) return { rows: [zeroOwnershipRow()] as unknown as readonly Row[] };
      if (text === INVENTORY_SQL.mcp) return { rows: [zeroMcpRow()] as unknown as readonly Row[] };
      if (text === INVENTORY_SQL.aiProvider) return { rows: [zeroProviderRow()] as unknown as readonly Row[] };
      if (text === INVENTORY_SQL.githubConnectionLegacy) return { rows: [zeroGithubRow()] as unknown as readonly Row[] };
      if (text === INVENTORY_SQL.platformTokenGrants) return { rows: [zeroGrantRow()] as unknown as readonly Row[] };
      if (text === INVENTORY_SQL.platformDefaultRoutes) return { rows: [zeroPlatformDefaultRouteRow()] as unknown as readonly Row[] };
      if (text === INVENTORY_SQL.activeVectorIndex) return { rows: [zeroActiveVectorIndexRow()] as unknown as readonly Row[] };
      throw new Error("unexpected query");
    },
  };

  const report = await runOwnershipInventory(client, new Date("2026-09-04T00:00:00.000Z"));
  assert.equal(report.ok, true);
  assert.equal(calls[0], INVENTORY_SQL.begin);
  assert.equal(calls[1], INVENTORY_SQL.searchPath);
  assert.equal(calls.at(-1), INVENTORY_SQL.rollback);
  assert.equal(calls.filter((call) => call === INVENTORY_SQL.rollback).length, 1);
  assert.ok(!calls.some((call) => /(?:^|\n)\s*(?:INSERT|UPDATE|DELETE|TRUNCATE|CREATE|ALTER|DROP|COMMIT)\b/iu.test(call)));

  const failedCalls: string[] = [];
  const failingClient = {
    async query<Row = unknown>(text: string): Promise<{ rows: readonly Row[] }> {
      failedCalls.push(text);
      if (text === INVENTORY_SQL.begin || text === INVENTORY_SQL.searchPath || text === INVENTORY_SQL.rollback) return { rows: [] as readonly Row[] };
      if (text === INVENTORY_SQL.transactionReadOnly) return { rows: [{ transaction_read_only: "on" }] as unknown as readonly Row[] };
      if (text === INVENTORY_SQL.migrations) throw new Error("private failure detail");
      throw new Error("unexpected query");
    },
  };
  await assert.rejects(() => runOwnershipInventory(failingClient), /OWNERSHIP_INVENTORY_QUERY_FAILED/);
  assert.equal(failedCalls.at(-1), INVENTORY_SQL.rollback);
});

test("inventory implementation avoids broad row output and secret-bearing dependencies", async () => {
  const source = await readFile(resolve(process.cwd(), "scripts/0.2x-migration-inventory.ts"), "utf8");
  assert.doesNotMatch(source, /SELECT\s+\*/iu);
  assert.doesNotMatch(source, /\bCOMMIT\b/iu);
  assert.doesNotMatch(source, /(?:^|\n)\s*(?:INSERT|UPDATE|DELETE|TRUNCATE|CREATE|ALTER|DROP)\b/iu);
  assert.doesNotMatch(source, /from ["']\.\.\/src\/(?:lib\/)?(?:db|getDb|vault|services)/iu);
  assert.doesNotMatch(source, /process\.env\.DATABASE_URL/u);
  assert.match(source, /readOwnershipInventoryDatabaseConfig\(env\)/u);
  assert.match(source, /validatePgDriverEnvironment\(env\)/u);
  assert.match(source, /new Client\(clientConfig\)/u);
  assert.doesNotMatch(source, /connectionString/u);
  assert.doesNotMatch(source, /\bPG(?:HOST|PORT|USER|PASSWORD|SSLMODE|SSLROOTCERT|OPTIONS)\b/u);
  assert.match(source, /INVENTORY_TABLES/u);
  assert.match(INVENTORY_SQL.role, /role_meta\.rolcreatedb\s+AS\s+can_create_database_role/u);
  assert.equal((source.match(/role\.can_references_target !== false/gu) ?? []).length, 1);
  assert.match(INVENTORY_SQL.searchPath, /SET LOCAL search_path\s*=\s*pg_catalog,\s*public/iu);
  assert.match(INVENTORY_SQL.role, /role_meta\.rolreplication\s+AS\s+can_replicate/u);
  assert.match(INVENTORY_SQL.role, /has_unapproved_select/u);
  assert.match(INVENTORY_SQL.role, /role_meta\.rolconfig/u);
  assert.match(INVENTORY_SQL.role, /pg_db_role_setting/u);
  assert.match(INVENTORY_SQL.role, /database_setting\.setconfig/u);
  assert.match(INVENTORY_SQL.role, /NOT\s*\(\s*database_role_setting\.setdatabase\s*=\s*0\s+AND\s+database_role_setting\.setrole\s*=\s*role_meta\.oid/iu);
  assert.doesNotMatch(INVENTORY_SQL.role, /database_meta\.datconfig/u);
  assert.match(source, /PGBINARY/u);
  for (const query of [INVENTORY_SQL.git, INVENTORY_SQL.mcp, INVENTORY_SQL.aiProvider]) {
    assert.match(query, /'waitingConsent'/u);
    assert.match(query, /'unknown'/u);
  }
  assert.match(INVENTORY_SQL.activeVectorIndex, /MemoryIndexPointer/u);
  assert.match(INVENTORY_SQL.activeVectorIndex, /MemoryIndexGeneration/u);
  assert.doesNotMatch(source, /AutomationRun|jobIds/u);
  const fixedAggregateSql = Object.values(INVENTORY_SQL).join("\n");
  assert.doesNotMatch(fixedAggregateSql, /\bAS\s+grant\b/iu);
  for (const table of INVENTORY_TABLES) {
    assert.match(fixedAggregateSql, new RegExp(`"${table}"`, "u"), `read-set table ${table} is not used by fixed SQL`);
  }
  assert.doesNotMatch(fixedAggregateSql, /ExternalCredential/u);

  const consumerRoots = [resolve(process.cwd(), "src"), resolve(process.cwd(), "scripts"), resolve(process.cwd(), "prisma/migrations")];
  const consumerExemptions = new Set([
    resolve(process.cwd(), "scripts/0.2x-migration-inventory.ts"),
    resolve(process.cwd(), "scripts/0.2x-migration-inventory-contract.ts"),
  ]);
  for (const root of consumerRoots) {
    for (const path of await collectFiles(root)) {
      if (consumerExemptions.has(path)) continue;
      const candidate = await readFile(path, "utf8");
      assert.doesNotMatch(candidate, /buildOwnershipInventoryReport|runOwnershipInventory|OwnershipInventoryReport/u, path);
    }
  }
});
