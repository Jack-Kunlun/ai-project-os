export const OWNERSHIP_INVENTORY_DATABASE_URL_ENV = "OWNERSHIP_INVENTORY_DATABASE_URL" as const;
export const OWNERSHIP_INVENTORY_COMMAND = "db:ownership-inventory" as const;
export const OWNERSHIP_INVENTORY_KIND = "ownership-migration-inventory" as const;
export const OWNERSHIP_INVENTORY_REPORT_VERSION = 1 as const;
export const OWNERSHIP_INVENTORY_CONNECTION_TIMEOUT_MILLIS = 5_000 as const;
export const OWNERSHIP_INVENTORY_APPLICATION_NAME = "ai-project-os-ownership-inventory" as const;
export const OWNERSHIP_INVENTORY_CLIENT_OPTIONS = "-c default_transaction_read_only=on" as const;
export const OWNERSHIP_INVENTORY_CLIENT_ENCODING = "UTF8" as const;
export const OWNERSHIP_INVENTORY_REPLICATION = "false" as const;
export const OWNERSHIP_INVENTORY_AUTOMATION_DIRECT_BINDING = "not_evaluable_without_typed_delegation" as const;

export const REQUIRED_MIGRATIONS = Object.freeze([
  "20260903010000_add_user_system_role_compatibility",
  "20260903020000_add_user_ai_provider_scope",
  "20260903030000_add_platform_policies_and_connection_ownership",
] as const);

export const REQUIRED_CONSTRAINTS = Object.freeze([
  Object.freeze({ name: "GitConnection_ownership_check", table: "GitConnection" }),
  Object.freeze({ name: "McpConnection_ownership_check", table: "McpConnection" }),
  Object.freeze({ name: "AiProviderConnection_scope_check", table: "AiProviderConnection" }),
] as const);

export const REQUIRED_ENUMS = Object.freeze({
  ResourceOwnershipState: Object.freeze(["legacy_pending", "ambiguous", "confirmed"] as const),
  AiProviderScope: Object.freeze(["platform", "workspace", "user"] as const),
});

// This is the complete read-set of the fixed aggregate queries below. Keep this
// list explicit: the preflight must cover every table the inventory can read.
export const INVENTORY_TABLES = Object.freeze([
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
] as const);

export type InventoryErrorCode =
  | "OWNERSHIP_INVENTORY_ARGUMENTS_INVALID"
  | "OWNERSHIP_INVENTORY_DATABASE_URL_REQUIRED"
  | "OWNERSHIP_INVENTORY_DATABASE_URL_INVALID"
  | "OWNERSHIP_INVENTORY_DATABASE_CONNECT_FAILED"
  | "OWNERSHIP_INVENTORY_PREFLIGHT_FAILED"
  | "OWNERSHIP_INVENTORY_QUERY_FAILED"
  | "OWNERSHIP_INVENTORY_RESULT_INVALID"
  | "OWNERSHIP_INVENTORY_ROLLBACK_FAILED"
  | "OWNERSHIP_INVENTORY_FAILED";

export class OwnershipInventoryError extends Error {
  readonly code: InventoryErrorCode;

  constructor(code: InventoryErrorCode) {
    super(code);
    this.name = "OwnershipInventoryError";
    this.code = code;
  }
}

export function parseOwnershipInventoryArguments(args: readonly string[]): void {
  if (args.length !== 0) {
    throw new OwnershipInventoryError("OWNERSHIP_INVENTORY_ARGUMENTS_INVALID");
  }
}

export type OwnershipInventorySslConfig = false | Readonly<{ rejectUnauthorized: true }>;

export interface OwnershipInventoryClientConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
  readonly binary: false;
  readonly client_encoding: typeof OWNERSHIP_INVENTORY_CLIENT_ENCODING;
  readonly replication: typeof OWNERSHIP_INVENTORY_REPLICATION;
  readonly ssl: OwnershipInventorySslConfig;
  readonly connectionTimeoutMillis: typeof OWNERSHIP_INVENTORY_CONNECTION_TIMEOUT_MILLIS;
  readonly application_name: typeof OWNERSHIP_INVENTORY_APPLICATION_NAME;
  readonly options: typeof OWNERSHIP_INVENTORY_CLIENT_OPTIONS;
}

function invalidDatabaseUrl(): never {
  throw new OwnershipInventoryError("OWNERSHIP_INVENTORY_DATABASE_URL_INVALID");
}

function decodeDatabaseUrlComponent(value: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return invalidDatabaseUrl();
  }
  if (decoded.length === 0 || /[\u0000-\u001f\u007f]/u.test(decoded)) {
    return invalidDatabaseUrl();
  }
  return decoded;
}

function parseDatabaseName(pathname: string): string {
  if (!pathname.startsWith("/") || pathname.length <= 1) return invalidDatabaseUrl();
  const rawDatabase = pathname.slice(1);
  if (rawDatabase.includes("/")) return invalidDatabaseUrl();
  const database = decodeDatabaseUrlComponent(rawDatabase);
  if (database.includes("/")) return invalidDatabaseUrl();
  return database;
}

function parseSslMode(parsed: URL): "disable" | "verify-full" {
  if (parsed.search.length <= 1) return invalidDatabaseUrl();
  const rawQueryParts = parsed.search.slice(1).split("&");
  if (rawQueryParts.length !== 1 || rawQueryParts[0] === "") return invalidDatabaseUrl();
  const entries = [...parsed.searchParams.entries()];
  if (entries.length !== 1 || entries[0]?.[0] !== "sslmode") return invalidDatabaseUrl();
  const sslMode = entries[0][1];
  if (sslMode !== "disable" && sslMode !== "verify-full") return invalidDatabaseUrl();
  return sslMode;
}

function normalizeHost(hostname: string): string {
  if (hostname.startsWith("[") && hostname.endsWith("]")) return hostname.slice(1, -1);
  return hostname;
}

function readRawAuthorityHost(value: string): string {
  const authorityStart = value.indexOf("://") + 3;
  const authorityRemainder = value.slice(authorityStart);
  const relativeAuthorityEnd = authorityRemainder.search(/[\/?#]/u);
  const authorityEnd = relativeAuthorityEnd === -1 ? -1 : authorityStart + relativeAuthorityEnd;
  const authority = value.slice(authorityStart, authorityEnd === -1 ? value.length : authorityEnd);
  const hostPort = authority.slice(authority.lastIndexOf("@") + 1);
  if (hostPort.startsWith("[")) {
    const closingBracket = hostPort.indexOf("]");
    return closingBracket === -1 ? "" : hostPort.slice(1, closingBracket);
  }
  const portSeparator = hostPort.lastIndexOf(":");
  return portSeparator === -1 ? hostPort : hostPort.slice(0, portSeparator);
}

export function parseOwnershipInventoryDatabaseUrl(value: string): OwnershipInventoryClientConfig {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.trim() !== value
    || value.includes("#")
    || /[\u0000-\u0020\u007f]/u.test(value)
  ) {
    return invalidDatabaseUrl();
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return invalidDatabaseUrl();
  }

  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") return invalidDatabaseUrl();
  if (parsed.hash !== "" || parsed.hostname === "" || parsed.username === "" || parsed.password === "") {
    return invalidDatabaseUrl();
  }
  if (parsed.port === "") return invalidDatabaseUrl();

  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return invalidDatabaseUrl();

  const host = normalizeHost(parsed.hostname.toLowerCase());
  const user = decodeDatabaseUrlComponent(parsed.username);
  const password = decodeDatabaseUrlComponent(parsed.password);
  const database = parseDatabaseName(parsed.pathname);
  const sslMode = parseSslMode(parsed);
  const isLoopback = host === "127.0.0.1" || host === "::1";
  if (sslMode === "disable" && (!isLoopback || !["127.0.0.1", "::1"].includes(readRawAuthorityHost(value)))) {
    return invalidDatabaseUrl();
  }

  return Object.freeze({
    host,
    port,
    user,
    password,
    database,
    binary: false,
    client_encoding: OWNERSHIP_INVENTORY_CLIENT_ENCODING,
    replication: OWNERSHIP_INVENTORY_REPLICATION,
    ssl: sslMode === "disable" ? false : Object.freeze({ rejectUnauthorized: true as const }),
    connectionTimeoutMillis: OWNERSHIP_INVENTORY_CONNECTION_TIMEOUT_MILLIS,
    application_name: OWNERSHIP_INVENTORY_APPLICATION_NAME,
    options: OWNERSHIP_INVENTORY_CLIENT_OPTIONS,
  });
}

export function readOwnershipInventoryDatabaseConfig(
  env: Readonly<Record<string, string | undefined>>,
): OwnershipInventoryClientConfig {
  const value = env[OWNERSHIP_INVENTORY_DATABASE_URL_ENV];
  if (typeof value !== "string" || value.length === 0) {
    throw new OwnershipInventoryError("OWNERSHIP_INVENTORY_DATABASE_URL_REQUIRED");
  }
  return parseOwnershipInventoryDatabaseUrl(value);
}

export function safeOwnershipInventoryErrorCode(error: unknown): InventoryErrorCode {
  return error instanceof OwnershipInventoryError ? error.code : "OWNERSHIP_INVENTORY_FAILED";
}

export function buildOwnershipInventoryFailure(error: unknown): OwnershipInventoryFailure {
  return { ok: false, error: { code: safeOwnershipInventoryErrorCode(error) } };
}

export type OwnershipBucket = "confirmed" | "legacyPending" | "ambiguous" | "invalid";

export interface OwnershipClassification {
  bucket: OwnershipBucket;
  candidateOnly: boolean;
}

function hasValue(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function classifyOwnedResource(row: Readonly<{
  ownershipState: unknown;
  ownerUserId: unknown;
  createdById: unknown;
}>): OwnershipClassification {
  const owner = hasValue(row.ownerUserId);
  let bucket: OwnershipBucket = "invalid";
  if (row.ownershipState === "confirmed" && owner) bucket = "confirmed";
  if (row.ownershipState === "legacy_pending" && !owner) bucket = "legacyPending";
  if (row.ownershipState === "ambiguous" && !owner) bucket = "ambiguous";
  return { bucket, candidateOnly: !owner && hasValue(row.createdById) };
}

export type ProviderOwnershipBucket =
  | "platformLegacyPending"
  | "workspaceLegacyPending"
  | "workspaceAmbiguous"
  | "workspaceConfirmed"
  | "userConfirmed"
  | "invalid";

export function classifyProviderResource(row: Readonly<{
  scope: unknown;
  workspaceId: unknown;
  ownerUserId: unknown;
  ownershipState: unknown;
}>): ProviderOwnershipBucket {
  const hasWorkspace = hasValue(row.workspaceId);
  const hasOwner = hasValue(row.ownerUserId);
  if (row.scope === "platform" && !hasWorkspace && !hasOwner && row.ownershipState === "legacy_pending") {
    return "platformLegacyPending";
  }
  if (row.scope === "workspace" && hasWorkspace && hasOwner && row.ownershipState === "legacy_pending") {
    return "workspaceLegacyPending";
  }
  if (row.scope === "workspace" && hasWorkspace && hasOwner && row.ownershipState === "ambiguous") {
    return "workspaceAmbiguous";
  }
  if (row.scope === "workspace" && hasWorkspace && hasOwner && row.ownershipState === "confirmed") {
    return "workspaceConfirmed";
  }
  if (row.scope === "user" && !hasWorkspace && hasOwner && row.ownershipState === "confirmed") {
    return "userConfirmed";
  }
  return "invalid";
}

export type CountValue = string | number | bigint;

export interface OwnershipAggregateRow {
  total: CountValue;
  confirmed: CountValue;
  legacy_pending: CountValue;
  ambiguous: CountValue;
  invalid: CountValue;
  candidate_only: CountValue;
  repositories: CountValue;
  project_repository_links: CountValue;
  active_project_repository_links: CountValue;
  references_with_different_actor: CountValue;
  active_references_with_different_actor: CountValue;
  connections_with_different_reference_actor: CountValue;
  connections_with_creator_outside_project_access: CountValue;
  active_connections_with_creator_outside_project_access: CountValue;
  owner_candidate_exact_name_conflict_groups: CountValue;
  connections_in_owner_candidate_exact_name_conflicts: CountValue;
  personal_direct_references: CountValue;
  personal_active_direct_references: CountValue;
  personal_distinct_projects: CountValue;
  personal_potential_non_terminal_jobs: CountValue;
  personal_potential_active_automations: CountValue;
}

export interface McpAggregateRow {
  total: CountValue;
  confirmed: CountValue;
  legacy_pending: CountValue;
  ambiguous: CountValue;
  invalid: CountValue;
  candidate_only: CountValue;
  tool_definitions: CountValue;
  current_tool_definitions: CountValue;
  project_tool_grants: CountValue;
  active_project_tool_grants: CountValue;
  references_with_different_actor: CountValue;
  active_references_with_different_actor: CountValue;
  connections_with_different_reference_actor: CountValue;
  connections_with_creator_outside_project_access: CountValue;
  active_connections_with_creator_outside_project_access: CountValue;
  owner_candidate_exact_name_conflict_groups: CountValue;
  connections_in_owner_candidate_exact_name_conflicts: CountValue;
  personal_direct_references: CountValue;
  personal_active_direct_references: CountValue;
  personal_distinct_projects: CountValue;
  personal_potential_non_terminal_jobs: CountValue;
  personal_potential_active_automations: CountValue;
}

export interface ProviderAggregateRow {
  total: CountValue;
  platform: CountValue;
  workspace: CountValue;
  user: CountValue;
  confirmed: CountValue;
  legacy_pending: CountValue;
  ambiguous: CountValue;
  invalid: CountValue;
  workspace_owner: CountValue;
  workspace_admin: CountValue;
  workspace_member: CountValue;
  workspace_viewer: CountValue;
  workspace_missing: CountValue;
  workspace_not_evaluable: CountValue;
  project_ai_routes: CountValue;
  route_revisions_old: CountValue;
  route_revisions_new: CountValue;
  web_ai_grants: CountValue;
  open_web_ai_grants: CountValue;
  platform_token_reservations: CountValue;
  open_token_reservations: CountValue;
  provider_call_audits: CountValue;
  memory_index_generations: CountValue;
  derived_ai_artifacts: CountValue;
  platform_default_routes: CountValue;
  structurally_valid: CountValue;
  structurally_invalid: CountValue;
  workspace_with_membership: CountValue;
  workspace_without_membership: CountValue;
  personal_direct_project_routes: CountValue;
  personal_distinct_projects: CountValue;
  personal_open_web_ai_grants: CountValue;
  personal_direct_non_terminal_jobs: CountValue;
  personal_potential_active_automations: CountValue;
}

export interface LegacyGitHubAggregateRow {
  project_scoped_total: CountValue;
  configured: CountValue;
  verified: CountValue;
  disabled: CountValue;
  access_unknown: CountValue;
  invalid_status: CountValue;
  credential_attached: CountValue;
  project_repository_links: CountValue;
  github_sync_entries: CountValue;
}

export interface AccountAggregateRow {
  total: CountValue;
  admin: CountValue;
  legacy_member: CountValue;
  user: CountValue;
  invalid: CountValue;
  enabled: CountValue;
  disabled: CountValue;
  active_offer_policies: CountValue;
  enabled_without_any_grant: CountValue;
  enabled_without_signup_grant: CountValue;
  enabled_without_available_grant: CountValue;
}

export interface PlatformDefaultRouteAggregateRow {
  provider_total: CountValue;
  total: CountValue;
  draft: CountValue;
  verified: CountValue;
  active: CountValue;
  retired: CountValue;
  invalid: CountValue;
  candidate_total: CountValue;
  candidate_usable: CountValue;
  candidate_unusable: CountValue;
  active_total: CountValue;
  active_usable: CountValue;
  active_unusable: CountValue;
  provider_capabilities_generation: CountValue;
  provider_capabilities_vision: CountValue;
  provider_capabilities_embedding: CountValue;
}

export interface ActiveVectorIndexAggregateRow {
  total: CountValue;
  matches_active_default_embedding_route: CountValue;
  differs_from_active_default_embedding_route: CountValue;
  no_active_default_embedding_route: CountValue;
  matches_draft_or_verified_candidate_tuple: CountValue;
}

export interface PlatformTokenGrantAggregateRow {
  total: CountValue;
  available: CountValue;
  expired: CountValue;
  revoked: CountValue;
}

export interface OwnershipInventoryRows {
  appliedMigrationCount: CountValue;
  accounts: AccountAggregateRow;
  git: OwnershipAggregateRow;
  mcp: McpAggregateRow;
  aiProvider: ProviderAggregateRow;
  githubConnectionLegacy: LegacyGitHubAggregateRow;
  platformTokenGrants: PlatformTokenGrantAggregateRow;
  platformDefaultRoutes: PlatformDefaultRouteAggregateRow;
  activeVectorIndex: ActiveVectorIndexAggregateRow;
}

export interface OwnershipSummary {
  confirmed: number;
  legacyPending: number;
  ambiguous: number;
  invalid: number;
}

export interface OwnershipInventoryReport {
  ok: true;
  kind: typeof OWNERSHIP_INVENTORY_KIND;
  reportVersion: typeof OWNERSHIP_INVENTORY_REPORT_VERSION;
  generatedAt: string;
  snapshot: {
    readOnly: true;
    isolation: "repeatable_read";
    migrations: {
      m100: "applied";
      m200: "applied";
      m300: "applied";
    };
    appliedMigrationCount: number;
  };
  resources: {
    accounts: {
      total: number;
      systemRole: { admin: number; legacyMember: number; user: number; invalid: number };
      accountState: { enabled: number; disabled: number };
      grantCoverage: {
        activeOfferPolicies: number;
        enabledWithoutAnyGrant: number;
        enabledWithoutSignupGrant: number;
        enabledWithoutAvailableGrant: number;
        eligibleWithoutGrantKnown: number;
        eligibilityNotEvaluable: number;
      };
    };
    git: {
      total: number;
      ownership: OwnershipSummary;
      createdByCandidateOnly: number;
      references: {
        repositories: number;
        projectRepositoryLinks: number;
        activeProjectRepositoryLinks: number;
      };
      referencesWithDifferentActor: number;
      activeReferencesWithDifferentActor: number;
      connectionsWithDifferentReferenceActor: number;
      connectionsWithCreatorOutsideProjectAccess: number;
      activeConnectionsWithCreatorOutsideProjectAccess: number;
      ownerCandidateExactNameConflictGroups: number;
      connectionsInOwnerCandidateExactNameConflicts: number;
      personalReferences: {
        directReferences: number;
        activeDirectReferences: number;
        distinctProjects: number;
        potentialNonTerminalJobsInReferencedProjects: number;
        potentialActiveAutomationsInReferencedProjects: number;
        automationDirectBinding: typeof OWNERSHIP_INVENTORY_AUTOMATION_DIRECT_BINDING;
      };
    };
    mcp: {
      total: number;
      ownership: OwnershipSummary;
      createdByCandidateOnly: number;
      references: {
        toolDefinitions: number;
        currentToolDefinitions: number;
        projectToolGrants: number;
        activeProjectToolGrants: number;
      };
      referencesWithDifferentActor: number;
      activeReferencesWithDifferentActor: number;
      connectionsWithDifferentReferenceActor: number;
      connectionsWithCreatorOutsideProjectAccess: number;
      activeConnectionsWithCreatorOutsideProjectAccess: number;
      ownerCandidateExactNameConflictGroups: number;
      connectionsInOwnerCandidateExactNameConflicts: number;
      personalReferences: {
        directReferences: number;
        activeDirectReferences: number;
        distinctProjects: number;
        potentialNonTerminalJobsInReferencedProjects: number;
        potentialActiveAutomationsInReferencedProjects: number;
        automationDirectBinding: typeof OWNERSHIP_INVENTORY_AUTOMATION_DIRECT_BINDING;
      };
    };
    aiProvider: {
      total: number;
      scope: { platform: number; workspace: number; user: number };
      ownership: OwnershipSummary;
      workspaceOwnerMembership: {
        owner: number;
        admin: number;
        member: number;
        viewer: number;
        missing: number;
        notEvaluable: number;
      };
      references: {
        projectAiRoutes: number;
        routeRevisionsOld: number;
        routeRevisionsNew: number;
        webAiGrants: number;
        openWebAiGrants: number;
        platformTokenReservations: number;
        openTokenReservations: number;
        providerCallAudits: number;
        memoryIndexGenerations: number;
        derivedAiArtifacts: number;
        platformDefaultRoutes: number;
      };
      consistency: {
        structurallyValid: number;
        structurallyInvalid: number;
        workspaceWithMembership: number;
        workspaceWithoutMembership: number;
        workspaceNotEvaluable: number;
      };
      personalReferences: {
        directProjectRoutes: number;
        distinctProjects: number;
        openWebAiGrants: number;
        directNonTerminalJobs: number;
        potentialActiveAutomationsInReferencedProjects: number;
        automationDirectBinding: typeof OWNERSHIP_INVENTORY_AUTOMATION_DIRECT_BINDING;
      };
    };
    githubConnectionLegacy: {
      projectScopedTotal: number;
      configured: number;
      verified: number;
      disabled: number;
      accessUnknown: number;
      invalidStatus: number;
      credentialAttached: number;
      projectRepositoryLinks: number;
      githubSyncEntries: number;
    };
    platformTokenGrants: {
      total: number;
      available: number;
      expired: number;
      revoked: number;
    };
    platformDefaultRoutes: {
      total: number;
      status: { draft: number; verified: number; active: number; retired: number; invalid: number };
      candidate: { total: number; usable: number; unusable: number };
      active: { total: number; usable: number; unusable: number };
      providerCapabilities: { generation: number; vision: number; embedding: number };
    };
    activeVectorIndex: {
      total: number;
      matchesActiveDefaultEmbeddingRoute: number;
      differsFromActiveDefaultEmbeddingRoute: number;
      noActiveDefaultEmbeddingRoute: number;
      matchesDraftOrVerifiedCandidateTuple: number;
    };
  };
}

export interface OwnershipInventoryFailure {
  ok: false;
  error: { code: InventoryErrorCode };
}

function safeCount(value: CountValue): number {
  if (typeof value === "bigint") {
    if (value < BigInt(0) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new OwnershipInventoryError("OWNERSHIP_INVENTORY_RESULT_INVALID");
    }
    return Number(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new OwnershipInventoryError("OWNERSHIP_INVENTORY_RESULT_INVALID");
    }
    return value;
  }
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw new OwnershipInventoryError("OWNERSHIP_INVENTORY_RESULT_INVALID");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new OwnershipInventoryError("OWNERSHIP_INVENTORY_RESULT_INVALID");
  }
  return parsed;
}

function countRowValue(row: object, key: string): number {
  const value = (row as Record<string, unknown>)[key];
  if (value === undefined) throw new OwnershipInventoryError("OWNERSHIP_INVENTORY_RESULT_INVALID");
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") {
    throw new OwnershipInventoryError("OWNERSHIP_INVENTORY_RESULT_INVALID");
  }
  return safeCount(value);
}

function assertPartition(total: number, values: readonly number[]): void {
  if (values.reduce((sum, value) => sum + value, 0) !== total) {
    throw new OwnershipInventoryError("OWNERSHIP_INVENTORY_RESULT_INVALID");
  }
}

function buildPersonalReferences(row: Readonly<{
  personal_direct_references: CountValue;
  personal_active_direct_references: CountValue;
  personal_distinct_projects: CountValue;
  personal_potential_non_terminal_jobs: CountValue;
  personal_potential_active_automations: CountValue;
}>, totalReferences: number, totalActiveReferences: number) {
  const directReferences = countRowValue(row, "personal_direct_references");
  const activeDirectReferences = countRowValue(row, "personal_active_direct_references");
  const distinctProjects = countRowValue(row, "personal_distinct_projects");
  const potentialNonTerminalJobsInReferencedProjects = countRowValue(row, "personal_potential_non_terminal_jobs");
  const potentialActiveAutomationsInReferencedProjects = countRowValue(row, "personal_potential_active_automations");
  if (
    directReferences > totalReferences
    || activeDirectReferences > directReferences
    || activeDirectReferences > totalActiveReferences
    || distinctProjects > directReferences
  ) {
    throw new OwnershipInventoryError("OWNERSHIP_INVENTORY_RESULT_INVALID");
  }
  return {
    directReferences,
    activeDirectReferences,
    distinctProjects,
    potentialNonTerminalJobsInReferencedProjects,
    potentialActiveAutomationsInReferencedProjects,
    automationDirectBinding: OWNERSHIP_INVENTORY_AUTOMATION_DIRECT_BINDING,
  };
}

function buildOwnershipAggregate(row: OwnershipAggregateRow) {
  const total = countRowValue(row, "total");
  const confirmed = countRowValue(row, "confirmed");
  const legacyPending = countRowValue(row, "legacy_pending");
  const ambiguous = countRowValue(row, "ambiguous");
  const invalid = countRowValue(row, "invalid");
  const candidateOnly = countRowValue(row, "candidate_only");
  assertPartition(total, [confirmed, legacyPending, ambiguous, invalid]);
  if (candidateOnly > total) throw new OwnershipInventoryError("OWNERSHIP_INVENTORY_RESULT_INVALID");
  const referencesWithDifferentActor = countRowValue(row, "references_with_different_actor");
  const activeReferencesWithDifferentActor = countRowValue(row, "active_references_with_different_actor");
  const connectionsWithDifferentReferenceActor = countRowValue(row, "connections_with_different_reference_actor");
  const connectionsWithCreatorOutsideProjectAccess = countRowValue(row, "connections_with_creator_outside_project_access");
  const activeConnectionsWithCreatorOutsideProjectAccess = countRowValue(row, "active_connections_with_creator_outside_project_access");
  const ownerCandidateExactNameConflictGroups = countRowValue(row, "owner_candidate_exact_name_conflict_groups");
  const connectionsInOwnerCandidateExactNameConflicts = countRowValue(row, "connections_in_owner_candidate_exact_name_conflicts");
  const projectRepositoryLinks = countRowValue(row, "project_repository_links");
  const activeProjectRepositoryLinks = countRowValue(row, "active_project_repository_links");
  if (
    activeReferencesWithDifferentActor > referencesWithDifferentActor
    || referencesWithDifferentActor > projectRepositoryLinks
    || activeProjectRepositoryLinks > projectRepositoryLinks
    || activeReferencesWithDifferentActor > activeProjectRepositoryLinks
    || connectionsWithDifferentReferenceActor > total
    || connectionsWithCreatorOutsideProjectAccess > total
    || activeConnectionsWithCreatorOutsideProjectAccess > connectionsWithCreatorOutsideProjectAccess
    || connectionsInOwnerCandidateExactNameConflicts > total
  ) {
    throw new OwnershipInventoryError("OWNERSHIP_INVENTORY_RESULT_INVALID");
  }
  const personalReferences = buildPersonalReferences(row, projectRepositoryLinks, activeProjectRepositoryLinks);
  return {
    total,
    ownership: { confirmed, legacyPending, ambiguous, invalid },
    createdByCandidateOnly: candidateOnly,
    references: {
      repositories: countRowValue(row, "repositories"),
      projectRepositoryLinks,
      activeProjectRepositoryLinks,
    },
    referencesWithDifferentActor,
    activeReferencesWithDifferentActor,
    connectionsWithDifferentReferenceActor,
    connectionsWithCreatorOutsideProjectAccess,
    activeConnectionsWithCreatorOutsideProjectAccess,
    ownerCandidateExactNameConflictGroups,
    connectionsInOwnerCandidateExactNameConflicts,
    personalReferences,
  };
}

function buildMcpAggregate(row: McpAggregateRow) {
  const total = countRowValue(row, "total");
  const confirmed = countRowValue(row, "confirmed");
  const legacyPending = countRowValue(row, "legacy_pending");
  const ambiguous = countRowValue(row, "ambiguous");
  const invalid = countRowValue(row, "invalid");
  const candidateOnly = countRowValue(row, "candidate_only");
  assertPartition(total, [confirmed, legacyPending, ambiguous, invalid]);
  if (candidateOnly > total) throw new OwnershipInventoryError("OWNERSHIP_INVENTORY_RESULT_INVALID");
  const referencesWithDifferentActor = countRowValue(row, "references_with_different_actor");
  const activeReferencesWithDifferentActor = countRowValue(row, "active_references_with_different_actor");
  const connectionsWithDifferentReferenceActor = countRowValue(row, "connections_with_different_reference_actor");
  const connectionsWithCreatorOutsideProjectAccess = countRowValue(row, "connections_with_creator_outside_project_access");
  const activeConnectionsWithCreatorOutsideProjectAccess = countRowValue(row, "active_connections_with_creator_outside_project_access");
  const ownerCandidateExactNameConflictGroups = countRowValue(row, "owner_candidate_exact_name_conflict_groups");
  const connectionsInOwnerCandidateExactNameConflicts = countRowValue(row, "connections_in_owner_candidate_exact_name_conflicts");
  const projectToolGrants = countRowValue(row, "project_tool_grants");
  const activeProjectToolGrants = countRowValue(row, "active_project_tool_grants");
  const toolDefinitions = countRowValue(row, "tool_definitions");
  const currentToolDefinitions = countRowValue(row, "current_tool_definitions");
  if (
    activeReferencesWithDifferentActor > referencesWithDifferentActor
    || referencesWithDifferentActor > projectToolGrants
    || activeReferencesWithDifferentActor > activeProjectToolGrants
    || currentToolDefinitions > toolDefinitions
    || activeProjectToolGrants > projectToolGrants
    || connectionsWithDifferentReferenceActor > total
    || connectionsWithCreatorOutsideProjectAccess > total
    || activeConnectionsWithCreatorOutsideProjectAccess > connectionsWithCreatorOutsideProjectAccess
    || connectionsInOwnerCandidateExactNameConflicts > total
  ) {
    throw new OwnershipInventoryError("OWNERSHIP_INVENTORY_RESULT_INVALID");
  }
  const personalReferences = buildPersonalReferences(row, projectToolGrants, activeProjectToolGrants);
  return {
    total,
    ownership: { confirmed, legacyPending, ambiguous, invalid },
    createdByCandidateOnly: candidateOnly,
    references: {
      toolDefinitions,
      currentToolDefinitions,
      projectToolGrants,
      activeProjectToolGrants,
    },
    referencesWithDifferentActor,
    activeReferencesWithDifferentActor,
    connectionsWithDifferentReferenceActor,
    connectionsWithCreatorOutsideProjectAccess,
    activeConnectionsWithCreatorOutsideProjectAccess,
    ownerCandidateExactNameConflictGroups,
    connectionsInOwnerCandidateExactNameConflicts,
    personalReferences,
  };
}

function buildPersonalProviderReferences(row: Readonly<{
  personal_direct_project_routes: CountValue;
  personal_distinct_projects: CountValue;
  personal_open_web_ai_grants: CountValue;
  personal_direct_non_terminal_jobs: CountValue;
  personal_potential_active_automations: CountValue;
}>) {
  const directProjectRoutes = countRowValue(row, "personal_direct_project_routes");
  const distinctProjects = countRowValue(row, "personal_distinct_projects");
  const openWebAiGrants = countRowValue(row, "personal_open_web_ai_grants");
  const directNonTerminalJobs = countRowValue(row, "personal_direct_non_terminal_jobs");
  const potentialActiveAutomationsInReferencedProjects = countRowValue(row, "personal_potential_active_automations");
  if (distinctProjects > directProjectRoutes) {
    throw new OwnershipInventoryError("OWNERSHIP_INVENTORY_RESULT_INVALID");
  }
  return {
    directProjectRoutes,
    distinctProjects,
    openWebAiGrants,
    directNonTerminalJobs,
    potentialActiveAutomationsInReferencedProjects,
    automationDirectBinding: OWNERSHIP_INVENTORY_AUTOMATION_DIRECT_BINDING,
  };
}

function buildProviderAggregate(row: ProviderAggregateRow) {
  const total = countRowValue(row, "total");
  const platform = countRowValue(row, "platform");
  const workspace = countRowValue(row, "workspace");
  const user = countRowValue(row, "user");
  const confirmed = countRowValue(row, "confirmed");
  const legacyPending = countRowValue(row, "legacy_pending");
  const ambiguous = countRowValue(row, "ambiguous");
  const invalid = countRowValue(row, "invalid");
  assertPartition(total, [platform, workspace, user]);
  assertPartition(total, [confirmed, legacyPending, ambiguous, invalid]);
  const membership = {
    owner: countRowValue(row, "workspace_owner"),
    admin: countRowValue(row, "workspace_admin"),
    member: countRowValue(row, "workspace_member"),
    viewer: countRowValue(row, "workspace_viewer"),
    missing: countRowValue(row, "workspace_missing"),
    notEvaluable: countRowValue(row, "workspace_not_evaluable"),
  };
  assertPartition(total, [membership.owner, membership.admin, membership.member, membership.viewer, membership.missing, membership.notEvaluable]);
  const structurallyValid = countRowValue(row, "structurally_valid");
  const structurallyInvalid = countRowValue(row, "structurally_invalid");
  const workspaceWithMembership = countRowValue(row, "workspace_with_membership");
  const workspaceWithoutMembership = countRowValue(row, "workspace_without_membership");
  const workspaceNotEvaluable = countRowValue(row, "workspace_not_evaluable");
  assertPartition(total, [structurallyValid, structurallyInvalid]);
  assertPartition(total, [workspaceWithMembership, workspaceWithoutMembership, workspaceNotEvaluable]);
  const projectAiRoutes = countRowValue(row, "project_ai_routes");
  const routeRevisionsOld = countRowValue(row, "route_revisions_old");
  const routeRevisionsNew = countRowValue(row, "route_revisions_new");
  const webAiGrants = countRowValue(row, "web_ai_grants");
  const openWebAiGrants = countRowValue(row, "open_web_ai_grants");
  const platformTokenReservations = countRowValue(row, "platform_token_reservations");
  const openTokenReservations = countRowValue(row, "open_token_reservations");
  const platformDefaultRoutes = countRowValue(row, "platform_default_routes");
  const personalReferences = buildPersonalProviderReferences(row);
  if (
    personalReferences.directProjectRoutes > projectAiRoutes
    || personalReferences.openWebAiGrants > openWebAiGrants
    || routeRevisionsOld > routeRevisionsNew
    || openWebAiGrants > webAiGrants
    || openTokenReservations > platformTokenReservations
  ) {
    throw new OwnershipInventoryError("OWNERSHIP_INVENTORY_RESULT_INVALID");
  }
  return {
    total,
    scope: { platform, workspace, user },
    ownership: { confirmed, legacyPending, ambiguous, invalid },
    workspaceOwnerMembership: membership,
    references: {
      projectAiRoutes,
      routeRevisionsOld,
      routeRevisionsNew,
      webAiGrants,
      openWebAiGrants,
      platformTokenReservations,
      openTokenReservations,
      providerCallAudits: countRowValue(row, "provider_call_audits"),
      memoryIndexGenerations: countRowValue(row, "memory_index_generations"),
      derivedAiArtifacts: countRowValue(row, "derived_ai_artifacts"),
      platformDefaultRoutes,
    },
    consistency: {
      structurallyValid,
      structurallyInvalid,
      workspaceWithMembership,
      workspaceWithoutMembership,
      workspaceNotEvaluable,
    },
    personalReferences,
  };
}

function buildLegacyGitHubAggregate(row: LegacyGitHubAggregateRow) {
  const total = countRowValue(row, "project_scoped_total");
  const configured = countRowValue(row, "configured");
  const verified = countRowValue(row, "verified");
  const disabled = countRowValue(row, "disabled");
  const accessUnknown = countRowValue(row, "access_unknown");
  const invalidStatus = countRowValue(row, "invalid_status");
  const credentialAttached = countRowValue(row, "credential_attached");
  assertPartition(total, [configured, verified, disabled, accessUnknown, invalidStatus]);
  if (credentialAttached > total) throw new OwnershipInventoryError("OWNERSHIP_INVENTORY_RESULT_INVALID");
  return {
    projectScopedTotal: total,
    configured,
    verified,
    disabled,
    accessUnknown,
    invalidStatus,
    credentialAttached,
    projectRepositoryLinks: countRowValue(row, "project_repository_links"),
    githubSyncEntries: countRowValue(row, "github_sync_entries"),
  };
}

function buildAccountAggregate(row: AccountAggregateRow) {
  const total = countRowValue(row, "total");
  const admin = countRowValue(row, "admin");
  const legacyMember = countRowValue(row, "legacy_member");
  const user = countRowValue(row, "user");
  const invalid = countRowValue(row, "invalid");
  const enabled = countRowValue(row, "enabled");
  const disabled = countRowValue(row, "disabled");
  assertPartition(total, [admin, legacyMember, user, invalid]);
  assertPartition(total, [enabled, disabled]);
  const activeOfferPolicies = countRowValue(row, "active_offer_policies");
  const enabledWithoutAnyGrant = countRowValue(row, "enabled_without_any_grant");
  const enabledWithoutSignupGrant = countRowValue(row, "enabled_without_signup_grant");
  const enabledWithoutAvailableGrant = countRowValue(row, "enabled_without_available_grant");
  if (
    activeOfferPolicies > 1
    || enabledWithoutAnyGrant > enabled
    || enabledWithoutSignupGrant > enabled
    || enabledWithoutAvailableGrant > enabled
    || enabledWithoutAnyGrant > enabledWithoutSignupGrant
  ) {
    throw new OwnershipInventoryError("OWNERSHIP_INVENTORY_RESULT_INVALID");
  }
  return {
    total,
    systemRole: { admin, legacyMember, user, invalid },
    accountState: { enabled, disabled },
    grantCoverage: {
      activeOfferPolicies,
      enabledWithoutAnyGrant,
      enabledWithoutSignupGrant,
      enabledWithoutAvailableGrant,
      eligibleWithoutGrantKnown: 0,
      eligibilityNotEvaluable: enabledWithoutSignupGrant,
    },
  };
}

function buildPlatformDefaultRoutesAggregate(row: PlatformDefaultRouteAggregateRow) {
  const providerTotal = countRowValue(row, "provider_total");
  const total = countRowValue(row, "total");
  const draft = countRowValue(row, "draft");
  const verified = countRowValue(row, "verified");
  const active = countRowValue(row, "active");
  const retired = countRowValue(row, "retired");
  const invalid = countRowValue(row, "invalid");
  assertPartition(total, [draft, verified, active, retired, invalid]);
  const candidateTotal = countRowValue(row, "candidate_total");
  const candidateUsable = countRowValue(row, "candidate_usable");
  const candidateUnusable = countRowValue(row, "candidate_unusable");
  const activeTotal = countRowValue(row, "active_total");
  const activeUsable = countRowValue(row, "active_usable");
  const activeUnusable = countRowValue(row, "active_unusable");
  if (candidateTotal !== draft + verified || activeTotal !== active) {
    throw new OwnershipInventoryError("OWNERSHIP_INVENTORY_RESULT_INVALID");
  }
  assertPartition(candidateTotal, [candidateUsable, candidateUnusable]);
  assertPartition(activeTotal, [activeUsable, activeUnusable]);
  const providerCapabilitiesGeneration = countRowValue(row, "provider_capabilities_generation");
  const providerCapabilitiesVision = countRowValue(row, "provider_capabilities_vision");
  const providerCapabilitiesEmbedding = countRowValue(row, "provider_capabilities_embedding");
  if (
    providerCapabilitiesGeneration > providerTotal
    || providerCapabilitiesVision > providerTotal
    || providerCapabilitiesEmbedding > providerTotal
  ) {
    throw new OwnershipInventoryError("OWNERSHIP_INVENTORY_RESULT_INVALID");
  }
  return {
    total,
    status: { draft, verified, active, retired, invalid },
    candidate: { total: candidateTotal, usable: candidateUsable, unusable: candidateUnusable },
    active: { total: activeTotal, usable: activeUsable, unusable: activeUnusable },
    providerCapabilities: {
      generation: providerCapabilitiesGeneration,
      vision: providerCapabilitiesVision,
      embedding: providerCapabilitiesEmbedding,
    },
  };
}

function buildActiveVectorIndexAggregate(row: ActiveVectorIndexAggregateRow) {
  const total = countRowValue(row, "total");
  const matchesActiveDefaultEmbeddingRoute = countRowValue(row, "matches_active_default_embedding_route");
  const differsFromActiveDefaultEmbeddingRoute = countRowValue(row, "differs_from_active_default_embedding_route");
  const noActiveDefaultEmbeddingRoute = countRowValue(row, "no_active_default_embedding_route");
  const matchesDraftOrVerifiedCandidateTuple = countRowValue(row, "matches_draft_or_verified_candidate_tuple");
  assertPartition(total, [matchesActiveDefaultEmbeddingRoute, differsFromActiveDefaultEmbeddingRoute, noActiveDefaultEmbeddingRoute]);
  if (matchesDraftOrVerifiedCandidateTuple > total) {
    throw new OwnershipInventoryError("OWNERSHIP_INVENTORY_RESULT_INVALID");
  }
  return {
    total,
    matchesActiveDefaultEmbeddingRoute,
    differsFromActiveDefaultEmbeddingRoute,
    noActiveDefaultEmbeddingRoute,
    matchesDraftOrVerifiedCandidateTuple,
  };
}

function buildPlatformTokenGrantsAggregate(row: PlatformTokenGrantAggregateRow) {
  const total = countRowValue(row, "total");
  const available = countRowValue(row, "available");
  const expired = countRowValue(row, "expired");
  const revoked = countRowValue(row, "revoked");
  if (available + expired + revoked > total) {
    throw new OwnershipInventoryError("OWNERSHIP_INVENTORY_RESULT_INVALID");
  }
  return { total, available, expired, revoked };
}

export function buildOwnershipInventoryReport(
  rows: OwnershipInventoryRows,
  generatedAt: Date = new Date(),
): OwnershipInventoryReport {
  if (!(generatedAt instanceof Date) || Number.isNaN(generatedAt.getTime())) {
    throw new OwnershipInventoryError("OWNERSHIP_INVENTORY_RESULT_INVALID");
  }
  const appliedMigrationCount = safeCount(rows.appliedMigrationCount);
  return {
    ok: true,
    kind: OWNERSHIP_INVENTORY_KIND,
    reportVersion: OWNERSHIP_INVENTORY_REPORT_VERSION,
    generatedAt: generatedAt.toISOString(),
    snapshot: {
      readOnly: true,
      isolation: "repeatable_read",
      migrations: { m100: "applied", m200: "applied", m300: "applied" },
      appliedMigrationCount,
    },
    resources: {
      accounts: buildAccountAggregate(rows.accounts),
      git: buildOwnershipAggregate(rows.git),
      mcp: buildMcpAggregate(rows.mcp),
      aiProvider: buildProviderAggregate(rows.aiProvider),
      githubConnectionLegacy: buildLegacyGitHubAggregate(rows.githubConnectionLegacy),
      platformTokenGrants: buildPlatformTokenGrantsAggregate(rows.platformTokenGrants),
      platformDefaultRoutes: buildPlatformDefaultRoutesAggregate(rows.platformDefaultRoutes),
      activeVectorIndex: buildActiveVectorIndexAggregate(rows.activeVectorIndex),
    },
  };
}
