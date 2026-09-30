import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@prisma/client";
import { getEnvironment } from "@/lib/env";

export const RUNTIME_DATABASE_PRINCIPAL = "ai_project_os_runtime" as const;
export const MIGRATOR_DATABASE_PRINCIPAL = "ai_project_os_migrator" as const;
export const ENTITLEMENT_WRITER_DATABASE_PRINCIPAL = "ai_project_os_entitlement_writer" as const;
export const GIT_AUTOMATION_WORKER_DATABASE_PRINCIPAL = "ai_project_os_git_automation_worker" as const;

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
  entitlementPrisma?: PrismaClient;
  gitAutomationWorkerPrisma?: PrismaClient;
  entitlementClients?: WeakSet<object>;
  gitAutomationWorkerClients?: WeakSet<object>;
};

const entitlementClients = globalForPrisma.entitlementClients ?? new WeakSet<object>();
globalForPrisma.entitlementClients = entitlementClients;

export type EntitlementDatabase = PrismaClient | Prisma.TransactionClient;
export type GitAutomationWorkerDatabase = PrismaClient;

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

function parseGitAutomationDatabaseUrl(databaseUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("GIT_AUTOMATION_DATABASE_URL_INVALID");
  }
  if ((parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") || parsed.search !== "" || parsed.hash !== "") {
    throw new Error("GIT_AUTOMATION_DATABASE_URL_INVALID");
  }
  return parsed;
}

function gitAutomationDatabaseUser(databaseUrl: string): string {
  const username = decodeURIComponent(parseGitAutomationDatabaseUrl(databaseUrl).username);
  if (username.length === 0) throw new Error("GIT_AUTOMATION_DATABASE_URL_INVALID");
  return username;
}

function databaseEndpoint(databaseUrl: string, parse = parseDatabaseUrl): string {
  const parsed = parse(databaseUrl);
  const port = parsed.port || "5432";
  return `${parsed.protocol}//${parsed.hostname.toLowerCase()}:${port}${parsed.pathname}`;
}

function databaseUser(databaseUrl: string): string {
  const parsed = parseDatabaseUrl(databaseUrl);
  const username = decodeURIComponent(parsed.username);
  if (username.length === 0) throw new Error("ENTITLEMENT_DATABASE_URL_INVALID");
  return username;
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

function createGitAutomationWorkerPrismaClient(): PrismaClient {
  const { DATABASE_URL, GIT_AUTOMATION_DATABASE_URL } = getEnvironment();
  if (typeof GIT_AUTOMATION_DATABASE_URL !== "string" || GIT_AUTOMATION_DATABASE_URL.length === 0) {
    throw new Error("GIT_AUTOMATION_DATABASE_URL_REQUIRED");
  }
  if (gitAutomationDatabaseUser(GIT_AUTOMATION_DATABASE_URL) !== GIT_AUTOMATION_WORKER_DATABASE_PRINCIPAL) {
    throw new Error("GIT_AUTOMATION_DATABASE_PRINCIPAL_INVALID");
  }
  if (databaseEndpoint(GIT_AUTOMATION_DATABASE_URL, parseGitAutomationDatabaseUrl) !== databaseEndpoint(DATABASE_URL)) {
    throw new Error("GIT_AUTOMATION_DATABASE_ENDPOINT_MISMATCH");
  }
  const adapter = new PrismaPg({ connectionString: GIT_AUTOMATION_DATABASE_URL });
  const client = new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });
  const clients = globalForPrisma.gitAutomationWorkerClients ?? new WeakSet<object>();
  clients.add(client);
  globalForPrisma.gitAutomationWorkerClients = clients;
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

/**
 * Git automation ledger operations require a separate session principal. This
 * accessor has no runtime fallback; its URL is only mounted in the worker
 * deployment, and SQL privileges enforce the capability boundary.
 */
export function getGitAutomationWorkerDb(): GitAutomationWorkerDatabase {
  if (globalForPrisma.gitAutomationWorkerPrisma) return globalForPrisma.gitAutomationWorkerPrisma;
  const client = createGitAutomationWorkerPrismaClient();
  globalForPrisma.gitAutomationWorkerPrisma = client;
  return client;
}

export function isEntitlementDatabase(value: unknown): value is PrismaClient {
  return typeof value === "object" && value !== null && entitlementClients.has(value);
}

export function isGitAutomationWorkerDatabase(value: unknown): value is PrismaClient {
  return typeof value === "object" && value !== null && globalForPrisma.gitAutomationWorkerClients?.has(value) === true;
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

/** Verify PostgreSQL's actual session identity; URL usernames alone are not authority. */
export async function assertGitAutomationWorkerSession(
  db: Pick<PrismaClient, "$queryRaw"> | Pick<Prisma.TransactionClient, "$queryRaw">,
): Promise<void> {
  const rows = await db.$queryRaw<Array<{ session_user: string; current_user: string }>>`
    SELECT session_user, current_user
  `;
  const row = rows[0];
  if (row?.session_user !== GIT_AUTOMATION_WORKER_DATABASE_PRINCIPAL || row.current_user !== GIT_AUTOMATION_WORKER_DATABASE_PRINCIPAL) {
    throw new Error("GIT_AUTOMATION_WORKER_SESSION_INVALID");
  }
}
