export const OWNERSHIP_INVENTORY_DATABASE_URL_ENV = "OWNERSHIP_INVENTORY_DATABASE_URL" as const;
export const OWNERSHIP_INVENTORY_COMMAND = "db:ownership-inventory" as const;
export const OWNERSHIP_INVENTORY_KIND = "clean-slate-schema-inventory" as const;
export const OWNERSHIP_INVENTORY_REPORT_VERSION = 2 as const;
export const OWNERSHIP_INVENTORY_CONNECTION_TIMEOUT_MILLIS = 5_000 as const;
export const OWNERSHIP_INVENTORY_APPLICATION_NAME = "ai-project-os-clean-slate-inventory" as const;
export const OWNERSHIP_INVENTORY_CLIENT_OPTIONS = "-c default_transaction_read_only=on" as const;
export const OWNERSHIP_INVENTORY_CLIENT_ENCODING = "UTF8" as const;
export const OWNERSHIP_INVENTORY_REPLICATION = "false" as const;

/** The only migration-specific checkpoint required by the clean-slate model. */
export const REQUIRED_MIGRATIONS = Object.freeze([
  "20260910010000_clean_slate_ai_provider_model",
] as const);

export const REQUIRED_CONSTRAINTS = Object.freeze([
  Object.freeze({ name: "GitConnection_ownership_check", table: "GitConnection" }),
  Object.freeze({ name: "McpConnection_ownership_check", table: "McpConnection" }),
  Object.freeze({ name: "AiProviderConnection_scope_check", table: "AiProviderConnection" }),
] as const);

export const REQUIRED_ENUMS = Object.freeze({
  AppUserRole: Object.freeze(["admin", "user"] as const),
  AiProviderScope: Object.freeze(["platform", "user"] as const),
} as const);

/**
 * This is the complete application-table read set of the inventory. The
 * removed legacy relations are intentionally absent: their absence is
 * checked through pg_catalog rather than by granting access to them.
 */
export const INVENTORY_TABLES = Object.freeze([
  "_prisma_migrations",
  "AppUser",
  "AiProviderConnection",
] as const);

export const CLEAN_SLATE_REMOVED_RELATIONS = Object.freeze([
  ["Project", "Ai", "Route"].join(""),
  ["Project", "Ai", "Route", "Revision"].join(""),
  ["Ai", "Provider", "Ownership", "Audit"].join(""),
] as const);

export const CLEAN_SLATE_REMOVED_PROVIDER_COLUMNS = Object.freeze([
  "workspaceId",
  "ownershipState",
] as const);

export const CLEAN_SLATE_REMOVED_TRIGGERS = Object.freeze([
  "AiProviderConnection_workspace_membership_guard",
  "AiProviderConnection_workspace_owner_guard",
  "WorkspaceMembership_ai_provider_membership_guard",
  "WorkspaceMembership_provider_owner_integrity_guard",
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
  if (args.length !== 0) throw new OwnershipInventoryError("OWNERSHIP_INVENTORY_ARGUMENTS_INVALID");
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
  if (decoded.length === 0 || /[\u0000-\u001f\u007f]/u.test(decoded)) return invalidDatabaseUrl();
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
  ) return invalidDatabaseUrl();

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return invalidDatabaseUrl();
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") return invalidDatabaseUrl();
  if (parsed.hash !== "" || parsed.hostname === "" || parsed.username === "" || parsed.password === "") return invalidDatabaseUrl();
  if (parsed.port === "") return invalidDatabaseUrl();

  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return invalidDatabaseUrl();
  const host = normalizeHost(parsed.hostname.toLowerCase());
  const user = decodeDatabaseUrlComponent(parsed.username);
  const password = decodeDatabaseUrlComponent(parsed.password);
  const database = parseDatabaseName(parsed.pathname);
  const sslMode = parseSslMode(parsed);
  const isLoopback = host === "127.0.0.1" || host === "::1";
  if (sslMode === "disable" && (!isLoopback || !["127.0.0.1", "::1"].includes(readRawAuthorityHost(value)))) return invalidDatabaseUrl();

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
  if (typeof value !== "string" || value.length === 0) throw new OwnershipInventoryError("OWNERSHIP_INVENTORY_DATABASE_URL_REQUIRED");
  return parseOwnershipInventoryDatabaseUrl(value);
}

export function safeOwnershipInventoryErrorCode(error: unknown): InventoryErrorCode {
  return error instanceof OwnershipInventoryError ? error.code : "OWNERSHIP_INVENTORY_FAILED";
}

export function buildOwnershipInventoryFailure(error: unknown): { ok: false; error: { code: InventoryErrorCode } } {
  return { ok: false, error: { code: safeOwnershipInventoryErrorCode(error) } };
}

export type CountValue = string | number | bigint;

export interface CleanSlateAccountAggregateRow {
  total: CountValue;
  admin: CountValue;
  user: CountValue;
  invalid: CountValue;
  enabled: CountValue;
  disabled: CountValue;
}

export interface CleanSlateProviderAggregateRow {
  total: CountValue;
  platform: CountValue;
  user: CountValue;
  invalid: CountValue;
  platform_with_owner: CountValue;
  user_without_owner: CountValue;
  configured: CountValue;
  verified: CountValue;
  error: CountValue;
  disabled: CountValue;
}

export interface CleanSlateLegacyArtifactRow {
  removed_relations: CountValue;
  removed_provider_columns: CountValue;
  removed_triggers: CountValue;
}

export interface OwnershipInventoryRows {
  appliedMigrationCount: CountValue;
  accounts: CleanSlateAccountAggregateRow;
  aiProvider: CleanSlateProviderAggregateRow;
  legacyArtifacts: CleanSlateLegacyArtifactRow;
}

export interface OwnershipInventoryReport {
  ok: true;
  kind: typeof OWNERSHIP_INVENTORY_KIND;
  reportVersion: typeof OWNERSHIP_INVENTORY_REPORT_VERSION;
  generatedAt: string;
  snapshot: {
    readOnly: true;
    isolation: "repeatable_read";
    migrations: { cleanSlate: "applied" };
    appliedMigrationCount: number;
  };
  resources: {
    accounts: {
      total: number;
      systemRole: { admin: number; user: number; invalid: number };
      accountState: { enabled: number; disabled: number };
    };
    aiProvider: {
      total: number;
      scope: { platform: number; user: number; invalid: number };
      consistency: { platformWithOwner: number; userWithoutOwner: number };
      status: { configured: number; verified: number; error: number; disabled: number };
    };
    legacyArtifacts: {
      removedRelations: number;
      removedProviderColumns: number;
      removedTriggers: number;
    };
  };
}

function count(value: CountValue | undefined): number {
  if (value === undefined) throw new OwnershipInventoryError("OWNERSHIP_INVENTORY_RESULT_INVALID");
  const numeric = typeof value === "bigint" ? Number(value) : typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0) throw new OwnershipInventoryError("OWNERSHIP_INVENTORY_RESULT_INVALID");
  return numeric;
}

function partition(total: number, parts: readonly number[]): void {
  if (parts.some((part) => part < 0) || parts.reduce((sum, part) => sum + part, 0) !== total) {
    throw new OwnershipInventoryError("OWNERSHIP_INVENTORY_RESULT_INVALID");
  }
}

export function buildOwnershipInventoryReport(
  rows: OwnershipInventoryRows,
  generatedAt: Date = new Date(),
): OwnershipInventoryReport {
  const appliedMigrationCount = count(rows.appliedMigrationCount);
  const accounts = {
    total: count(rows.accounts.total),
    admin: count(rows.accounts.admin),
    user: count(rows.accounts.user),
    invalid: count(rows.accounts.invalid),
    enabled: count(rows.accounts.enabled),
    disabled: count(rows.accounts.disabled),
  };
  partition(accounts.total, [accounts.admin, accounts.user, accounts.invalid]);
  partition(accounts.total, [accounts.enabled, accounts.disabled]);

  const provider = {
    total: count(rows.aiProvider.total),
    platform: count(rows.aiProvider.platform),
    user: count(rows.aiProvider.user),
    invalid: count(rows.aiProvider.invalid),
    platformWithOwner: count(rows.aiProvider.platform_with_owner),
    userWithoutOwner: count(rows.aiProvider.user_without_owner),
    configured: count(rows.aiProvider.configured),
    verified: count(rows.aiProvider.verified),
    error: count(rows.aiProvider.error),
    disabled: count(rows.aiProvider.disabled),
  };
  partition(provider.total, [provider.platform, provider.user, provider.invalid]);
  partition(provider.total, [provider.configured, provider.verified, provider.error, provider.disabled]);
  if (provider.platformWithOwner > provider.platform || provider.userWithoutOwner > provider.user) {
    throw new OwnershipInventoryError("OWNERSHIP_INVENTORY_RESULT_INVALID");
  }

  const legacyArtifacts = {
    removedRelations: count(rows.legacyArtifacts.removed_relations),
    removedProviderColumns: count(rows.legacyArtifacts.removed_provider_columns),
    removedTriggers: count(rows.legacyArtifacts.removed_triggers),
  };
  if (legacyArtifacts.removedRelations !== 0 || legacyArtifacts.removedProviderColumns !== 0 || legacyArtifacts.removedTriggers !== 0) {
    throw new OwnershipInventoryError("OWNERSHIP_INVENTORY_PREFLIGHT_FAILED");
  }

  const generatedAtTime = generatedAt.getTime();
  if (!Number.isFinite(generatedAtTime)) throw new OwnershipInventoryError("OWNERSHIP_INVENTORY_RESULT_INVALID");
  return {
    ok: true,
    kind: OWNERSHIP_INVENTORY_KIND,
    reportVersion: OWNERSHIP_INVENTORY_REPORT_VERSION,
    generatedAt: generatedAt.toISOString(),
    snapshot: {
      readOnly: true,
      isolation: "repeatable_read",
      migrations: { cleanSlate: "applied" },
      appliedMigrationCount,
    },
    resources: {
      accounts: {
        total: accounts.total,
        systemRole: { admin: accounts.admin, user: accounts.user, invalid: accounts.invalid },
        accountState: { enabled: accounts.enabled, disabled: accounts.disabled },
      },
      aiProvider: {
        total: provider.total,
        scope: { platform: provider.platform, user: provider.user, invalid: provider.invalid },
        consistency: { platformWithOwner: provider.platformWithOwner, userWithoutOwner: provider.userWithoutOwner },
        status: { configured: provider.configured, verified: provider.verified, error: provider.error, disabled: provider.disabled },
      },
      legacyArtifacts,
    },
  };
}
