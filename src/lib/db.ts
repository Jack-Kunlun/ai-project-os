import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@prisma/client";
import { getEnvironment } from "@/lib/env";

export const RUNTIME_DATABASE_PRINCIPAL = "ai_project_os_runtime" as const;
export const MIGRATOR_DATABASE_PRINCIPAL = "ai_project_os_migrator" as const;
export const ENTITLEMENT_WRITER_DATABASE_PRINCIPAL = "ai_project_os_entitlement_writer" as const;

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
  entitlementPrisma?: PrismaClient;
  entitlementClients?: WeakSet<object>;
};

const entitlementClients = globalForPrisma.entitlementClients ?? new WeakSet<object>();
globalForPrisma.entitlementClients = entitlementClients;

export type EntitlementDatabase = PrismaClient | Prisma.TransactionClient;

function createPrismaClient(): PrismaClient {
  const { DATABASE_URL } = getEnvironment();
  const adapter = new PrismaPg({ connectionString: DATABASE_URL });

  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });
}

function parseDatabaseUrl(databaseUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("ENTITLEMENT_DATABASE_URL_INVALID");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("ENTITLEMENT_DATABASE_URL_INVALID");
  }
  if (parsed.search !== "" || parsed.hash !== "") throw new Error("ENTITLEMENT_DATABASE_URL_INVALID");
  return parsed;
}

function databaseUser(databaseUrl: string): string {
  const parsed = parseDatabaseUrl(databaseUrl);
  const username = decodeURIComponent(parsed.username);
  if (username.length === 0) throw new Error("ENTITLEMENT_DATABASE_URL_INVALID");
  return username;
}

function databaseEndpoint(databaseUrl: string): string {
  const parsed = parseDatabaseUrl(databaseUrl);
  const port = parsed.port || "5432";
  return `${parsed.protocol}//${parsed.hostname.toLowerCase()}:${port}${parsed.pathname}`;
}

function createEntitlementPrismaClient(): PrismaClient {
  const { DATABASE_URL, ENTITLEMENT_DATABASE_URL } = getEnvironment();
  if (typeof ENTITLEMENT_DATABASE_URL !== "string" || ENTITLEMENT_DATABASE_URL.length === 0) {
    throw new Error("ENTITLEMENT_DATABASE_URL_REQUIRED");
  }
  if (databaseUser(ENTITLEMENT_DATABASE_URL) !== ENTITLEMENT_WRITER_DATABASE_PRINCIPAL) {
    throw new Error("ENTITLEMENT_DATABASE_PRINCIPAL_INVALID");
  }
  if (databaseEndpoint(ENTITLEMENT_DATABASE_URL) !== databaseEndpoint(DATABASE_URL)) {
    throw new Error("ENTITLEMENT_DATABASE_ENDPOINT_MISMATCH");
  }
  const adapter = new PrismaPg({ connectionString: ENTITLEMENT_DATABASE_URL });
  const client = new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });
  entitlementClients.add(client);
  return client;
}

export function getDb(): PrismaClient {
  if (globalForPrisma.prisma) {
    return globalForPrisma.prisma;
  }

  const client = createPrismaClient();
  globalForPrisma.prisma = client;

  return client;
}

/**
 * Entitlement mutations must use a separate PostgreSQL session principal.
 * This intentionally has no fallback to getDb(): a missing or misbound writer
 * URL is a deployment error, not a reason to run protected writes as runtime.
 */
export function getEntitlementDb(): PrismaClient {
  if (globalForPrisma.entitlementPrisma) return globalForPrisma.entitlementPrisma;
  const client = createEntitlementPrismaClient();
  globalForPrisma.entitlementPrisma = client;
  return client;
}

export function isEntitlementDatabase(value: unknown): value is PrismaClient {
  return typeof value === "object" && value !== null && entitlementClients.has(value);
}

/**
 * URL usernames are only an admission check.  Every protected top-level
 * transaction also verifies the session identity observed by PostgreSQL so a
 * misbound connection cannot silently perform entitlement writes.
 */
export async function assertEntitlementWriterSession(
  db: Pick<PrismaClient, "$queryRaw"> | Pick<Prisma.TransactionClient, "$queryRaw">,
): Promise<void> {
  const rows = await db.$queryRaw<Array<{ session_user: string; current_user: string }>>`
    SELECT session_user, current_user
  `;
  const row = rows[0];
  if (row?.session_user !== ENTITLEMENT_WRITER_DATABASE_PRINCIPAL || row.current_user !== ENTITLEMENT_WRITER_DATABASE_PRINCIPAL) {
    throw new Error("ENTITLEMENT_WRITER_SESSION_INVALID");
  }
}
