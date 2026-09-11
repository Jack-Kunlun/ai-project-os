export const ACCOUNT_ENTITLEMENT_INVENTORY_DATABASE_URL_ENV = "ACCOUNT_ENTITLEMENT_INVENTORY_DATABASE_URL" as const;
export const ACCOUNT_ENTITLEMENT_INVENTORY_KIND = "account-entitlement-inventory" as const;
export const ACCOUNT_ENTITLEMENT_INVENTORY_REPORT_VERSION = 1 as const;
export const ACCOUNT_ENTITLEMENT_INVENTORY_APPLICATION_NAME = "ai-project-os-account-entitlement-inventory" as const;
export const ACCOUNT_ENTITLEMENT_INVENTORY_TABLES = Object.freeze([
  "AccountEntitlementActivation",
  "AccountEntitlementBackfillRun",
  "AccountEntitlementBackfillItem",
  "PlatformTokenGrant",
] as const);

export type AccountEntitlementInventoryCounts = Readonly<{
  eligible: number;
  issued: number;
  ambiguous: number;
  missing: number;
}>;

export type AccountEntitlementInventoryReport = Readonly<{
  ok: true;
  kind: typeof ACCOUNT_ENTITLEMENT_INVENTORY_KIND;
  reportVersion: typeof ACCOUNT_ENTITLEMENT_INVENTORY_REPORT_VERSION;
  generatedAt: string;
  counts: AccountEntitlementInventoryCounts;
}>;

export type AccountEntitlementInventoryErrorCode =
  | "ACCOUNT_ENTITLEMENT_INVENTORY_ARGUMENTS_INVALID"
  | "ACCOUNT_ENTITLEMENT_INVENTORY_DATABASE_URL_REQUIRED"
  | "ACCOUNT_ENTITLEMENT_INVENTORY_DATABASE_URL_INVALID"
  | "ACCOUNT_ENTITLEMENT_INVENTORY_CONNECT_FAILED"
  | "ACCOUNT_ENTITLEMENT_INVENTORY_PREFLIGHT_FAILED"
  | "ACCOUNT_ENTITLEMENT_INVENTORY_QUERY_FAILED"
  | "ACCOUNT_ENTITLEMENT_INVENTORY_ROLLBACK_FAILED"
  | "ACCOUNT_ENTITLEMENT_INVENTORY_RESULT_INVALID"
  | "ACCOUNT_ENTITLEMENT_INVENTORY_FAILED";

export class AccountEntitlementInventoryError extends Error {
  constructor(readonly code: AccountEntitlementInventoryErrorCode) {
    super(code);
    this.name = "AccountEntitlementInventoryError";
  }
}

export interface InventoryQueryClient {
  query<Row = unknown>(text: string, values?: readonly unknown[]): Promise<{ rows: readonly Row[] }>;
}

export function parseAccountEntitlementInventoryArguments(args: readonly string[]): void {
  if (args.length !== 0) throw new AccountEntitlementInventoryError("ACCOUNT_ENTITLEMENT_INVENTORY_ARGUMENTS_INVALID");
}

export function parseAccountEntitlementInventoryDatabaseUrl(value: string): string {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0 || /[\u0000-\u0020\u007f#]/u.test(value)) {
    throw new AccountEntitlementInventoryError("ACCOUNT_ENTITLEMENT_INVENTORY_DATABASE_URL_INVALID");
  }
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new AccountEntitlementInventoryError("ACCOUNT_ENTITLEMENT_INVENTORY_DATABASE_URL_INVALID"); }
  if (!(["postgres:", "postgresql:"].includes(parsed.protocol)) || parsed.hostname !== "127.0.0.1" || parsed.port === ""
    || parsed.username === "" || parsed.password === "" || parsed.pathname.length < 2 || parsed.search !== "" || parsed.hash !== "") {
    throw new AccountEntitlementInventoryError("ACCOUNT_ENTITLEMENT_INVENTORY_DATABASE_URL_INVALID");
  }
  return value;
}

export function readAccountEntitlementInventoryDatabaseUrl(env: Readonly<Record<string, string | undefined>>): string {
  const value = env[ACCOUNT_ENTITLEMENT_INVENTORY_DATABASE_URL_ENV];
  if (value === undefined || value === "") throw new AccountEntitlementInventoryError("ACCOUNT_ENTITLEMENT_INVENTORY_DATABASE_URL_REQUIRED");
  return parseAccountEntitlementInventoryDatabaseUrl(value);
}

export function safeAccountEntitlementInventoryErrorCode(error: unknown): AccountEntitlementInventoryErrorCode {
  return error instanceof AccountEntitlementInventoryError ? error.code : "ACCOUNT_ENTITLEMENT_INVENTORY_FAILED";
}

export function buildAccountEntitlementInventoryFailure(error: unknown): { ok: false; error: { code: AccountEntitlementInventoryErrorCode } } {
  return { ok: false, error: { code: safeAccountEntitlementInventoryErrorCode(error) } };
}

export function buildAccountEntitlementInventoryReport(
  counts: AccountEntitlementInventoryCounts,
  generatedAt = new Date(),
): AccountEntitlementInventoryReport {
  for (const value of Object.values(counts)) {
    if (!Number.isSafeInteger(value) || value < 0) throw new AccountEntitlementInventoryError("ACCOUNT_ENTITLEMENT_INVENTORY_RESULT_INVALID");
  }
  return Object.freeze({
    ok: true,
    kind: ACCOUNT_ENTITLEMENT_INVENTORY_KIND,
    reportVersion: ACCOUNT_ENTITLEMENT_INVENTORY_REPORT_VERSION,
    generatedAt: generatedAt.toISOString(),
    counts: Object.freeze({ ...counts }),
  });
}
