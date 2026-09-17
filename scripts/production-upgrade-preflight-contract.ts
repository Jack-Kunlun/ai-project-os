export const PRODUCTION_UPGRADE_PREFLIGHT_DATABASE_URL_ENV = "PRODUCTION_UPGRADE_PREFLIGHT_DATABASE_URL" as const;
export const PRODUCTION_UPGRADE_PREFLIGHT_LEGACY_DATABASE_URL_ENV = "DATABASE_PRINCIPAL_LEGACY_BOOTSTRAP_URL" as const;
export const PRODUCTION_UPGRADE_PREFLIGHT_APPLICATION_NAME = "ai-project-os-production-upgrade-preflight" as const;
export const PRODUCTION_UPGRADE_CLUSTER_ADMIN_ROLE = "ai_project_os_cluster_admin" as const;
export const PRODUCTION_UPGRADE_SEALED_LEGACY_ROLE = "ai_project_os_legacy_bootstrap" as const;
export const PRODUCTION_UPGRADE_REQUIRED_EXTENSIONS = Object.freeze(["vector", "pg_trgm", "pgcrypto", "plpgsql"] as const);
export const PRODUCTION_UPGRADE_TARGET_TAG = "v0.2.0-dev.1" as const;
export const PRODUCTION_UPGRADE_TARGET_VERSION = "0.2.0-dev.1" as const;
export const PRODUCTION_UPGRADE_SOURCE_VERSION = "5.1.2" as const;
export const PRODUCTION_UPGRADE_PREFLIGHT_CONNECTION_TIMEOUT_MILLIS = 5_000 as const;
export const PRODUCTION_UPGRADE_PREFLIGHT_QUERY_TIMEOUT_MILLIS = 30_000 as const;
export const PRODUCTION_UPGRADE_PREFLIGHT_LOCK_TIMEOUT_MILLIS = 5_000 as const;

export const LEGACY_MIGRATION_MANIFEST = Object.freeze([
  Object.freeze({ name: "20260826021100_init", checksum: "615f559fe14e94d49f5f542e08d98c9a08fc642ae2e344d3ddab5fafd6f4254c" }),
  Object.freeze({ name: "20260826030732_integrity_boundaries", checksum: "a629ee244900080101d66700e542bb1d4f492b3007ee0381446c136e8ec14b22" }),
  Object.freeze({ name: "20260827090000_add_ai_runtime_governance", checksum: "99c0d1f1ec77e2c2ddea3d958144a4c66af94224d49112ad82e15a2af857ed58" }),
  Object.freeze({ name: "20260827120000_add_ai_memory_candidates", checksum: "d4ac14b216a0b9758c33e6a7ddf3bd9a6cda4107e7ab55ab298929eb06d115c7" }),
  Object.freeze({ name: "20260827140000_add_item_evidence_history", checksum: "aafd7217baf8987b06529f79e6e31b2279f5e9833f1112822b23b540fb9eb741" }),
  Object.freeze({ name: "20260828100000_add_source_chunks", checksum: "2a6361f145ee6958498362c96a87064c7dbb1306c28b90554205e1b203157bd9" }),
  Object.freeze({ name: "20260828123000_add_index_generations", checksum: "f97bde68e0f47ee198d68a39aad0a05cb2e6647909ce93469c30672f99fca21c" }),
  Object.freeze({ name: "20260828150000_publish_ai_candidate_items", checksum: "8f3aa8b60070ebe26a84d6538efed815e83fc090d05738819088273d23f4a6b5" }),
  Object.freeze({ name: "20260828170000_add_ai_operation_profiles", checksum: "2492f81c2590faa89d44b79f2e1361b7af03f6e71a80a856f9c1f6967827c7b8" }),
  Object.freeze({ name: "20260828210000_add_project_rag_snapshots", checksum: "e371c84d05620247746b5cdb30eb8d292e47d336c82d344c72cc94f437600003" }),
  Object.freeze({ name: "20260828233000_add_ai_derived_artifacts", checksum: "0f56930fe25c50dbbe90e0066e108cfced3206b2ecb3050d1d50936b21414894" }),
  Object.freeze({ name: "20260829010000_add_github_repository_ledger", checksum: "9f3e56411daa41389728a4d924fa7f2f13daa4fa989377d8eb79de7b4130501b" }),
  Object.freeze({ name: "20260829020000_bind_github_scan_security", checksum: "4f8b7b88491f5ed755757373306f084328e4087d3496d63bc8091ade8984f4b2" }),
  Object.freeze({ name: "20260829033000_add_repository_code_indexes", checksum: "df5ec514624822689459ac359a1ba32d1f0e0113f55b720849fa87b7d8f2272d" }),
  Object.freeze({ name: "20260829050000_add_repository_material_ledger", checksum: "a167a2608b8772a7335d97c74159c5265092521881e79d2f4ec633f116426b61" }),
  Object.freeze({ name: "20260829051000_harden_repository_material_policy", checksum: "1df21da2cffa0eff4d6ad1b1f79d969586d5d75b60fb5b534a2abec59c65d376" }),
  Object.freeze({ name: "20260829052000_seal_repository_material_terminal_rows", checksum: "906e7518e38fa25ee21cd79e5d8cfa87262c9c22432e62156f6efe5068fad43a" }),
  Object.freeze({ name: "20260829053000_add_repository_material_indexes", checksum: "cafeb8fbece555b1972328c42ce0aa3a59d4cde90055a1ee23d0c539e92d7aec" }),
  Object.freeze({ name: "20260829060000_add_repository_rag_snapshots", checksum: "4cd3b77f67c6161fda1c44c9b1f758d71f2b9955264bad46ef915250945c71ee" }),
  Object.freeze({ name: "20260829070000_restore_grant_operation_profile_guard", checksum: "6fe1f66d0d2b024b6e5cc6777de90e37a2561526297c654d09de0b37c52a6227" }),
  Object.freeze({ name: "20260829080000_add_web_control_plane", checksum: "be0e4ece76b1e33e0d60d09756423a5e7dfdc87834037f6f33d6344c012b972a" }),
  Object.freeze({ name: "20260829090000_expand_web_ai_jobs", checksum: "2bade6cf4d519f5aec78aee0a520839cab541d42b90b5ff7c28b1ea9199c2667" }),
  Object.freeze({ name: "20260829100000_add_project_intelligence", checksum: "288db41a0db15ce7ab085197ae8d328f4f2e1655dbd68e947b8af0882c6d32ed" }),
  Object.freeze({ name: "20260829110000_add_project_ai_route_revisions", checksum: "c5dc823b7beea1abd5c78900574984aa7cb912e8948b6f5bc9b0f253f94c332c" }),
  Object.freeze({ name: "20260829120000_add_recoverable_job_attempts", checksum: "cdec15d42bd3424d56d4d4169e675abe843964eafacd75d4fbb8c29534c4df78" }),
  Object.freeze({ name: "20260829130000_add_github_project_sync_job_kind", checksum: "309b0c5ec7c77fe4605b24b7cce1f40827ebd3f0f8d77a49ce1f3c0754933c4a" }),
  Object.freeze({ name: "20260829131000_add_project_github_sync_runs", checksum: "475cada69f5a750d88226e4608bc48aae7c41f07a9b7e53407974e2095764cbe" }),
  Object.freeze({ name: "20260829140000_add_memory_index_build_modes", checksum: "421febefa6d07b0ca88f1e0c0c42aaf8a2f5b3bd9c8bab0a87a979df3d4b5dd8" }),
  Object.freeze({ name: "20260829141000_add_memory_index_candidates", checksum: "ce36e06a2151b14dab80d76ff2750b9d78e0210abb380005f0cbba33aa08ff15" }),
  Object.freeze({ name: "20260829142000_add_background_job_reconciliations", checksum: "471c84b26a1b14bf1053b5abdfc0691f392c170cc69c15e5d587596a4cd76933" }),
  Object.freeze({ name: "20260829150000_add_project_lifecycle_and_export_audits", checksum: "057310970693a9723111f9ebd3dcabb065ad413e2a335bef561bbe3355ac0a16" }),
  Object.freeze({ name: "20260829151000_guard_archived_project_jobs", checksum: "f5093964b84ff9deaf4566ce0a0a11473365fd0e49185397ba18f3f90a8898a4" }),
  Object.freeze({ name: "20260829160000_add_project_assets", checksum: "5feca56a3894e4124767410f029e920cd16e9b901bd5ada6fd085427294b7d9d" }),
  Object.freeze({ name: "20260829170000_add_multi_git_repositories", checksum: "0a99fdf82e8cefc55f5954ccb7c16e10e39b71bd638993f3dfd86696d977e94a" }),
  Object.freeze({ name: "20260829180000_add_automation_worker", checksum: "8a9acd80cca997f7d20a2dd910148df77553dad9abc37c9bb575131680090676" }),
  Object.freeze({ name: "20260829190000_add_memory_quality", checksum: "fdb673e714708f5d57c54e45cba5862603dadbe30a7a17f32ef046b47b883b5e" }),
  Object.freeze({ name: "20260829200000_add_web_sources", checksum: "f1164ba8aa4d5bafc9f35726c3e3f215e971923b2f267ae2f090a4e411731fdc" }),
  Object.freeze({ name: "20260829210000_add_workspaces_rbac_oidc", checksum: "bc2eb6300540cdf67f6d3eccc37d01f1ab27b7066c0152081c25d36085b5d2db" }),
  Object.freeze({ name: "20260829211000_fix_long_path_constraints", checksum: "367a95521485efccdf92c65f8475cda975c493e3ddd94ddad036ce6c1aef8d7d" }),
  Object.freeze({ name: "20260829212000_scope_manual_source_deduplication", checksum: "546e9efd145a289a0247cb0ca7cfeb49aaa4a2bb263c4286a79fac618892fd8e" }),
  Object.freeze({ name: "20260829213000_add_oidc_endpoint_pinning", checksum: "9757178b9af07ac00710d473b49ec2691bc15a13b2a97bbdc47d716f12fec636" }),
  Object.freeze({ name: "20260829214000_align_oidc_discovery_defaults", checksum: "53932c27f069219a6a3b17b1775926772127d57fb81ab1e6a03f43ecf1498988" }),
  Object.freeze({ name: "20260829220000_add_project_action_engine", checksum: "7725f9a3f46fec35960ed2ec7d31be03adb0e1968ad00293c24bd995fcce6a33" }),
  Object.freeze({ name: "20260829230000_add_controlled_mcp_capabilities", checksum: "4598e2e4907a0818d781178852952be3d9f775c6f5d8994d9fbb25ab64f57c45" }),
  Object.freeze({ name: "20260830010000_add_action_result_intake", checksum: "cdb88242f11b834ae09dc50b1679d7bff1f154b60c474c6102580b079e8ff618" }),
  Object.freeze({ name: "20260830020000_add_evidence_driven_project_plan", checksum: "8395fcb093bdefc243e8fcb1c864ef4cefbafb1da31f5ba4323acc711a893b53" }),
  Object.freeze({ name: "20260830030000_add_project_operations_loop", checksum: "5a521071afeee4aeec89475de44c41da675767034283b8e97171523519ea93b7" }),
  Object.freeze({ name: "20260830040000_add_project_world_model", checksum: "eb0122e15e94c7e224265979787052940b54b99a423fbcac5fc4f83753d6d65c" }),
  Object.freeze({ name: "20260830050000_harden_source_provenance_and_mcp_attestation", checksum: "dd028e8b5a760fc10a389c9081c7da04b7eff53f2c5e04cb6abd3f4a1a7cef92" }),
  Object.freeze({ name: "20260831000000_add_worker_runtime_health", checksum: "4f2987d9975fb24aae25a7fec76c2a3f4b0d374ef0742e455bbbc074ddb5b921" }),
] as const);

export const REQUIRED_LEGACY_SCHEMA = Object.freeze({
  relations: Object.freeze([
    "AppUser",
    "AiProviderConnection",
    "ProjectAiRoute",
    "ProjectAiRouteRevision",
    "Workspace",
  ] as const),
  columns: Object.freeze([
    Object.freeze({ relation: "AppUser", column: "id" }),
    Object.freeze({ relation: "AppUser", column: "role" }),
    Object.freeze({ relation: "AiProviderConnection", column: "id" }),
    Object.freeze({ relation: "ProjectAiRoute", column: "projectId" }),
    Object.freeze({ relation: "ProjectAiRoute", column: "operation" }),
    Object.freeze({ relation: "ProjectAiRoute", column: "providerConnectionId" }),
    Object.freeze({ relation: "ProjectAiRouteRevision", column: "id" }),
    Object.freeze({ relation: "ProjectAiRouteRevision", column: "projectId" }),
    Object.freeze({ relation: "Workspace", column: "id" }),
  ] as const),
} as const);

export const CLEAN_SLATE_DATA_GATES = Object.freeze([
  "app_user_member",
  "workspace_provider_or_workspace_id",
  "project_ai_route",
  "project_ai_route_revision",
  "ai_provider_ownership_audit",
] as const);

export type ProductionUpgradePreflightPhase = "pre-stop" | "post-stop";

export type ProductionUpgradePreflightErrorCode =
  | "PRODUCTION_UPGRADE_PREFLIGHT_ARGUMENTS_INVALID"
  | "PRODUCTION_UPGRADE_PREFLIGHT_DATABASE_URL_REQUIRED"
  | "PRODUCTION_UPGRADE_PREFLIGHT_DATABASE_URL_INVALID"
  | "PRODUCTION_UPGRADE_PREFLIGHT_DATABASE_MISMATCH"
  | "PRODUCTION_UPGRADE_PREFLIGHT_DATABASE_CONNECT_FAILED"
  | "PRODUCTION_UPGRADE_PREFLIGHT_QUERY_FAILED"
  | "PRODUCTION_UPGRADE_PREFLIGHT_RESULT_INVALID"
  | "PRODUCTION_UPGRADE_PREFLIGHT_TRANSACTION_INVALID"
  | "PRODUCTION_UPGRADE_PREFLIGHT_MIGRATION_LEDGER_INVALID"
  | "PRODUCTION_UPGRADE_PREFLIGHT_SCHEMA_INVALID"
  | "PRODUCTION_UPGRADE_PREFLIGHT_DATABASE_PRINCIPAL_INVALID"
  | "PRODUCTION_UPGRADE_PREFLIGHT_DATA_BLOCKED"
  | "PRODUCTION_UPGRADE_PREFLIGHT_CLIENT_BACKENDS_PRESENT"
  | "PRODUCTION_UPGRADE_PREFLIGHT_ROLLBACK_FAILED"
  | "PRODUCTION_UPGRADE_PREFLIGHT_FAILED";

export class ProductionUpgradePreflightError extends Error {
  readonly code: ProductionUpgradePreflightErrorCode;

  constructor(code: ProductionUpgradePreflightErrorCode) {
    super(code);
    this.name = "ProductionUpgradePreflightError";
    this.code = code;
  }
}

export type ProductionUpgradePreflightDatabaseConfig = Readonly<{
  host: "postgres";
  port: 5432;
  user: string;
  password: string;
  database: string;
  application_name: typeof PRODUCTION_UPGRADE_PREFLIGHT_APPLICATION_NAME;
  connectionTimeoutMillis: typeof PRODUCTION_UPGRADE_PREFLIGHT_CONNECTION_TIMEOUT_MILLIS;
  query_timeout: typeof PRODUCTION_UPGRADE_PREFLIGHT_QUERY_TIMEOUT_MILLIS;
  statement_timeout: typeof PRODUCTION_UPGRADE_PREFLIGHT_QUERY_TIMEOUT_MILLIS;
  ssl: false;
}>;

function invalidDatabaseUrl(): never {
  throw new ProductionUpgradePreflightError("PRODUCTION_UPGRADE_PREFLIGHT_DATABASE_URL_INVALID");
}

function decodeComponent(value: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return invalidDatabaseUrl();
  }
  if (decoded.length === 0 || /[\u0000-\u001f\u007f]/u.test(decoded)) return invalidDatabaseUrl();
  return decoded;
}

export function parseProductionUpgradePreflightArguments(args: readonly string[]): ProductionUpgradePreflightPhase {
  if (args.length !== 1 || (args[0] !== "pre-stop" && args[0] !== "post-stop")) {
    throw new ProductionUpgradePreflightError("PRODUCTION_UPGRADE_PREFLIGHT_ARGUMENTS_INVALID");
  }
  return args[0];
}

export function parseProductionUpgradePreflightDatabaseUrl(value: string): ProductionUpgradePreflightDatabaseConfig {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.trim() !== value
    || /[\u0000-\u0020\u007f]/u.test(value)
  ) return invalidDatabaseUrl();

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return invalidDatabaseUrl();
  }
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol)
    || parsed.hostname !== "postgres"
    || parsed.port !== "5432"
    || parsed.pathname.length <= 1
    || parsed.pathname.slice(1).includes("/")
    || parsed.username.length === 0
    || parsed.password.length === 0
    || parsed.search !== ""
    || parsed.hash !== ""
  ) return invalidDatabaseUrl();

  const user = decodeComponent(parsed.username);
  const password = decodeComponent(parsed.password);
  const database = decodeComponent(parsed.pathname.slice(1));
  if (database.includes("/")) return invalidDatabaseUrl();
  return Object.freeze({
    host: "postgres",
    port: 5432,
    user,
    password,
    database,
    application_name: PRODUCTION_UPGRADE_PREFLIGHT_APPLICATION_NAME,
    connectionTimeoutMillis: PRODUCTION_UPGRADE_PREFLIGHT_CONNECTION_TIMEOUT_MILLIS,
    query_timeout: PRODUCTION_UPGRADE_PREFLIGHT_QUERY_TIMEOUT_MILLIS,
    statement_timeout: PRODUCTION_UPGRADE_PREFLIGHT_QUERY_TIMEOUT_MILLIS,
    ssl: false,
  });
}

export function readProductionUpgradePreflightDatabaseConfig(
  env: Readonly<Record<string, string | undefined>>,
): ProductionUpgradePreflightDatabaseConfig {
  return readProductionUpgradePreflightDatabaseCandidates(env)[0];
}

export function readProductionUpgradePreflightDatabaseCandidates(
  env: Readonly<Record<string, string | undefined>>,
): readonly ProductionUpgradePreflightDatabaseConfig[] {
  const targetValue = env[PRODUCTION_UPGRADE_PREFLIGHT_DATABASE_URL_ENV];
  if (typeof targetValue !== "string" || targetValue.length === 0) {
    throw new ProductionUpgradePreflightError("PRODUCTION_UPGRADE_PREFLIGHT_DATABASE_URL_REQUIRED");
  }
  const target = parseProductionUpgradePreflightDatabaseUrl(targetValue);
  const legacyValue = env[PRODUCTION_UPGRADE_PREFLIGHT_LEGACY_DATABASE_URL_ENV];
  if (typeof legacyValue !== "string" || legacyValue.length === 0) return [target];
  const legacy = parseProductionUpgradePreflightDatabaseUrl(legacyValue);
  if (legacy.host !== target.host || legacy.port !== target.port || legacy.database !== target.database) {
    throw new ProductionUpgradePreflightError("PRODUCTION_UPGRADE_PREFLIGHT_DATABASE_MISMATCH");
  }
  const sameConfig = legacy.user === target.user && legacy.password === target.password;
  // The old owner is the authoritative first-run identity.  The cluster
  // admin is only a connection fallback for the post-seal/rename state.
  return sameConfig ? [legacy] : [legacy, target];
}

export function readProductionUpgradePreflightLegacyRole(
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  const legacyValue = env[PRODUCTION_UPGRADE_PREFLIGHT_LEGACY_DATABASE_URL_ENV];
  if (typeof legacyValue !== "string" || legacyValue.length === 0) return null;
  return parseProductionUpgradePreflightDatabaseUrl(legacyValue).user;
}

export function safeProductionUpgradePreflightErrorCode(error: unknown): ProductionUpgradePreflightErrorCode {
  return error instanceof ProductionUpgradePreflightError ? error.code : "PRODUCTION_UPGRADE_PREFLIGHT_FAILED";
}

export function buildProductionUpgradePreflightFailure(error: unknown): { ok: false; error: { code: ProductionUpgradePreflightErrorCode } } {
  return { ok: false, error: { code: safeProductionUpgradePreflightErrorCode(error) } };
}

export type ProductionUpgradePreflightReport = Readonly<{
  ok: true;
  kind: "production-upgrade-preflight";
  phase: ProductionUpgradePreflightPhase;
  targetTag: typeof PRODUCTION_UPGRADE_TARGET_TAG;
  sourceVersion: typeof PRODUCTION_UPGRADE_SOURCE_VERSION;
  checks: Readonly<{
    transaction: "read-only-repeatable-read";
    migrationLedger: "verified";
    legacySchema: "verified";
    databasePrincipal: "cluster-admin-owned" | "legacy-extension-owners-reassignable" | "pinned-oid10-extension-owners-supported";
    cleanSlateData: "clear";
    clientBackends: "clear" | "not-applicable";
    rollback: "verified";
  }>;
}>;

export function buildProductionUpgradePreflightReport(
  phase: ProductionUpgradePreflightPhase,
  databasePrincipal: ProductionUpgradePreflightReport["checks"]["databasePrincipal"],
): ProductionUpgradePreflightReport {
  return Object.freeze({
    ok: true,
    kind: "production-upgrade-preflight",
    phase,
    targetTag: PRODUCTION_UPGRADE_TARGET_TAG,
    sourceVersion: PRODUCTION_UPGRADE_SOURCE_VERSION,
    checks: Object.freeze({
      transaction: "read-only-repeatable-read",
      migrationLedger: "verified",
      legacySchema: "verified",
      databasePrincipal,
      cleanSlateData: "clear",
      clientBackends: phase === "post-stop" ? "clear" : "not-applicable",
      rollback: "verified",
    }),
  });
}
