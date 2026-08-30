export interface PostgresGateDefinition {
  id: string;
  file: string;
  database: string;
  gateEnv: string;
  databaseUrlEnv?: string;
  seedAdmin?: boolean;
  schema?: "public";
  setup: "migrate" | "self";
}

export const POSTGRES_GATES: readonly PostgresGateDefinition[] = Object.freeze([
  { id: "ai-runtime", file: "test/ai-runtime-postgres.test.ts", database: "ai_project_os_ai_runtime_test", gateEnv: "AI_RUNTIME_POSTGRES_GATE", databaseUrlEnv: "AI_RUNTIME_TEST_DATABASE_URL", setup: "self" },
  { id: "item-history", file: "test/project-item-history-postgres.test.ts", database: "ai_project_os_ai_runtime_test", gateEnv: "ITEM_HISTORY_POSTGRES_GATE", databaseUrlEnv: "ITEM_HISTORY_TEST_DATABASE_URL", setup: "self" },
  { id: "corpus-index", file: "test/corpus-index-postgres.test.ts", database: "ai_project_os_ai_runtime_test", gateEnv: "CORPUS_INDEX_POSTGRES_GATE", databaseUrlEnv: "CORPUS_INDEX_TEST_DATABASE_URL", setup: "self" },
  { id: "github-ledger", file: "test/github-ledger-postgres.test.ts", database: "ai_project_os_github_ledger_test", gateEnv: "GITHUB_LEDGER_POSTGRES_GATE", databaseUrlEnv: "GITHUB_LEDGER_TEST_DATABASE_URL", setup: "self" },
  { id: "github-code-scan", file: "test/github-code-scan-postgres.test.ts", database: "ai_project_os_github_scan_test", gateEnv: "GITHUB_SCAN_POSTGRES_GATE", databaseUrlEnv: "GITHUB_SCAN_TEST_DATABASE_URL", setup: "self" },
  { id: "github-material-ledger", file: "test/github-material-ledger-postgres.test.ts", database: "ai_project_os_material_ledger_test", gateEnv: "GITHUB_MATERIAL_POSTGRES_GATE", databaseUrlEnv: "GITHUB_MATERIAL_TEST_DATABASE_URL", setup: "self" },
  { id: "github-material-sync", file: "test/github-material-sync-postgres.test.ts", database: "ai_project_os_material_sync_test", gateEnv: "GITHUB_MATERIAL_SYNC_POSTGRES_GATE", databaseUrlEnv: "GITHUB_MATERIAL_SYNC_TEST_DATABASE_URL", setup: "self" },
  { id: "repository-memory", file: "test/repository-memory-postgres.test.ts", database: "ai_project_os_repository_memory_test", gateEnv: "REPOSITORY_MEMORY_POSTGRES_GATE", databaseUrlEnv: "REPOSITORY_MEMORY_TEST_DATABASE_URL", setup: "self" },
  { id: "memory-index-legacy-upgrade", file: "test/memory-index-c-legacy-upgrade-postgres.test.ts", database: "ai_project_os_memory_index_c_legacy_upgrade_test", gateEnv: "MEMORY_INDEX_C_LEGACY_POSTGRES_GATE", databaseUrlEnv: "MEMORY_INDEX_C_LEGACY_TEST_DATABASE_URL", schema: "public", setup: "self" },
  { id: "memory-index", file: "test/memory-index-c-postgres.test.ts", database: "ai_project_os_memory_index_c_test", gateEnv: "MEMORY_INDEX_C_POSTGRES_GATE", databaseUrlEnv: "MEMORY_INDEX_C_TEST_DATABASE_URL", schema: "public", setup: "self" },
  { id: "background-job-reconciliation", file: "test/background-job-reconciliation-postgres.test.ts", database: "ai_project_os_background_job_reconciliation_test", gateEnv: "BACKGROUND_JOB_RECONCILIATION_POSTGRES_GATE", schema: "public", setup: "self" },
  { id: "project-github-sync", file: "test/project-github-sync-postgres.test.ts", database: "ai_project_os_project_sync_test", gateEnv: "GITHUB_PROJECT_SYNC_POSTGRES_GATE", databaseUrlEnv: "GITHUB_PROJECT_SYNC_TEST_DATABASE_URL", setup: "self" },
  { id: "v3", file: "test/v3-postgres.test.ts", database: "ai_project_os_v3_test", gateEnv: "V3_POSTGRES_GATE", seedAdmin: true, setup: "migrate" },
  { id: "project-assets", file: "test/project-assets-postgres.test.ts", database: "ai_project_os_project_assets_test", gateEnv: "PROJECT_ASSET_POSTGRES_GATE", setup: "migrate" },
  { id: "project-workflow", file: "test/project-workflow-postgres.test.ts", database: "ai_project_os_project_workflow_test", gateEnv: "PROJECT_WORKFLOW_POSTGRES_GATE", setup: "migrate" },
  { id: "web-ai-workflow", file: "test/web-ai-workflow-postgres.test.ts", database: "ai_project_os_web_ai_test", gateEnv: "WEB_AI_POSTGRES_GATE", setup: "migrate" },
  { id: "project-intelligence", file: "test/project-intelligence-postgres.test.ts", database: "ai_project_os_project_intelligence_test", gateEnv: "PROJECT_INTELLIGENCE_POSTGRES_GATE", setup: "migrate" },
  { id: "project-lifecycle", file: "test/project-lifecycle-postgres.test.ts", database: "ai_project_os_project_lifecycle_test", gateEnv: "PROJECT_LIFECYCLE_POSTGRES_GATE", setup: "migrate" },
  { id: "action-engine", file: "test/action-engine-postgres.test.ts", database: "ai_project_os_action_engine_test", gateEnv: "ACTION_ENGINE_POSTGRES_GATE", setup: "migrate" },
  { id: "mcp-capabilities", file: "test/mcp-capabilities-postgres.test.ts", database: "ai_project_os_mcp_capabilities_test", gateEnv: "MCP_CAPABILITIES_POSTGRES_GATE", setup: "migrate" },
  { id: "project-plan", file: "test/project-plan-postgres.test.ts", database: "ai_project_os_project_plan_test", gateEnv: "PROJECT_PLAN_POSTGRES_GATE", setup: "migrate" },
  { id: "project-world", file: "test/project-world-postgres.test.ts", database: "ai_project_os_v5_gate_world", gateEnv: "PROJECT_WORLD_POSTGRES_GATE", setup: "migrate" },
  { id: "worker-health", file: "test/worker-health-postgres.test.ts", database: "ai_project_os_worker_health_test", gateEnv: "WORKER_HEALTH_POSTGRES_GATE", setup: "migrate" },
]);

export const POSTGRES_GATE_TEST_USER = "ai_project_os_gate";

function invalidAdminUrl(): never {
  throw new Error("POSTGRES_GATE_ADMIN_URL_INVALID");
}

export function validatePostgresGateAdminUrl(value: unknown): URL {
  if (typeof value !== "string" || value.length === 0) return invalidAdminUrl();

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return invalidAdminUrl();
  }

  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol)
    || !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname.toLowerCase())
    || parsed.port !== "56432"
    || parsed.pathname !== "/postgres"
    || parsed.username.length === 0
    || parsed.password.length === 0
    || parsed.search !== ""
    || parsed.hash !== ""
  ) {
    return invalidAdminUrl();
  }

  return parsed;
}

export function buildPostgresGateDatabaseUrl(
  adminUrl: URL,
  database: string,
  password: string,
  schema?: "public",
): string {
  if (!/^ai_project_os_[a-z0-9_]+(?:_test|_world)$/u.test(database)) {
    throw new Error("POSTGRES_GATE_DATABASE_NAME_INVALID");
  }
  if (!/^[A-Za-z0-9_-]{16,128}$/u.test(password)) {
    throw new Error("POSTGRES_GATE_TEST_PASSWORD_INVALID");
  }
  const target = new URL(adminUrl);
  target.pathname = `/${database}`;
  target.username = POSTGRES_GATE_TEST_USER;
  target.password = password;
  if (schema !== undefined) target.searchParams.set("schema", schema);
  return target.toString();
}

export function selectPostgresGates(filter: string | undefined): readonly PostgresGateDefinition[] {
  if (filter === undefined || filter.trim() === "") return POSTGRES_GATES;

  const requested = filter.split(",").map((value) => value.trim()).filter(Boolean);
  if (new Set(requested).size !== requested.length) {
    throw new Error("POSTGRES_GATE_FILTER_DUPLICATE");
  }
  const known = new Set(POSTGRES_GATES.map((gate) => gate.id));
  if (requested.some((id) => !known.has(id))) {
    throw new Error("POSTGRES_GATE_FILTER_INVALID");
  }
  const selected = POSTGRES_GATES.filter((gate) => requested.includes(gate.id));
  if (selected.length === 0) throw new Error("POSTGRES_GATE_FILTER_EMPTY");
  return selected;
}
