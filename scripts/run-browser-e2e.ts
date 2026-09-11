import { spawn, type ChildProcess } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { request } from "node:http";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import {
  validatePostgresGateAdminUrl,
} from "./postgres-gate-contract";

const DATABASE_NAME = "ai_project_os_browser_e2e_test";
const CLUSTER_ADMIN_ROLE = "ai_project_os_cluster_admin";
const MIGRATOR_ROLE = "ai_project_os_migrator";
const RUNTIME_ROLE = "ai_project_os_runtime";
const WRITER_ROLE = "ai_project_os_entitlement_writer";
const INVENTORY_READER_ROLE = "ai_project_os_entitlement_inventory_reader";
const liveChildren = new Set<ChildProcess>();

function configuredBrowserPort(): number | undefined {
  const value = process.env.BROWSER_E2E_PORT;
  if (value === undefined) return undefined;
  if (!/^[0-9]{4,5}$/u.test(value)) throw new Error("BROWSER_E2E_PORT_INVALID");
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) throw new Error("BROWSER_E2E_PORT_INVALID");
  return port;
}

function reserveBrowserPort(configuredPort: number | undefined): Promise<number> {
  return new Promise((resolve, reject) => {
    const reservation = createServer();
    reservation.unref();
    reservation.once("error", () => reject(new Error("BROWSER_E2E_PORT_UNAVAILABLE")));
    reservation.listen({ host: "127.0.0.1", port: configuredPort ?? 0, exclusive: true }, () => {
      const address = reservation.address();
      if (address === null || typeof address === "string") {
        reservation.close();
        reject(new Error("BROWSER_E2E_PORT_UNAVAILABLE"));
        return;
      }
      reservation.close((error) => {
        if (error !== undefined) reject(new Error("BROWSER_E2E_PORT_UNAVAILABLE"));
        else resolve(address.port);
      });
    });
  });
}

function hasLoopbackListener(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (reachable: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(reachable);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
}

async function selectBrowserPort(): Promise<number> {
  const configuredPort = configuredBrowserPort();
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const port = await reserveBrowserPort(configuredPort);
    if (!(await hasLoopbackListener(port))) return port;
    if (configuredPort !== undefined) throw new Error("BROWSER_E2E_PORT_UNAVAILABLE");
  }
  throw new Error("BROWSER_E2E_PORT_UNAVAILABLE");
}

function track(child: ChildProcess): ChildProcess {
  liveChildren.add(child);
  child.once("exit", () => liveChildren.delete(child));
  return child;
}

function waitForExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

async function run(command: string, args: readonly string[], environment: NodeJS.ProcessEnv): Promise<void> {
  const child = track(spawn(command, [...args], { cwd: process.cwd(), env: environment, stdio: "inherit" }));
  const result = await waitForExit(child);
  if (result.code !== 0) throw new Error(`BROWSER_E2E_COMMAND_FAILED:${args[0] ?? command}`);
}

async function stop(child: ChildProcess | null): Promise<void> {
  if (child === null || child.exitCode !== null || child.signalCode !== null) return;
  const exited = waitForExit(child);
  child.kill("SIGTERM");
  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 5_000)),
  ]);
  if (!graceful) {
    child.kill("SIGKILL");
    await exited;
  }
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function ensureRole(admin: Client, role: string, password: string, attributes: string, login = true): Promise<void> {
  const loginClause = login ? "LOGIN" : "NOLOGIN";
  await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${quoteLiteral(role)}) THEN CREATE ROLE ${quoteIdentifier(role)} ${loginClause} ${attributes} PASSWORD ${quoteLiteral(password)}; END IF; END $$`);
  await admin.query(`ALTER ROLE ${quoteIdentifier(role)} WITH ${loginClause} ${attributes} PASSWORD ${quoteLiteral(password)}`);
}

async function recreateDatabase(admin: Client, adminUrl: URL): Promise<Readonly<{ adminUrl: string; migratorUrl: string; runtimeUrl: string; writerUrl: string; inventoryPassword: string }>> {
  await admin.query(`DROP DATABASE IF EXISTS "${DATABASE_NAME}" WITH (FORCE)`);
  const suffix = randomBytes(18).toString("hex");
  const clusterAdminPassword = `ClusterAdmin_${suffix}`;
  const migratorPassword = `Migrator_${suffix}`;
  const runtimePassword = `Runtime_${suffix}`;
  const writerPassword = `Writer_${suffix}`;
  const inventoryPassword = `Inventory_${suffix}`;
  await ensureRole(admin, CLUSTER_ADMIN_ROLE, clusterAdminPassword, "SUPERUSER CREATEDB CREATEROLE INHERIT NOREPLICATION NOBYPASSRLS");
  await ensureRole(admin, MIGRATOR_ROLE, migratorPassword, "NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS");
  await ensureRole(admin, RUNTIME_ROLE, runtimePassword, "NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS", false);
  await ensureRole(admin, WRITER_ROLE, writerPassword, "NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS", false);
  await ensureRole(admin, INVENTORY_READER_ROLE, inventoryPassword, "NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS");
  await admin.query(`CREATE DATABASE "${DATABASE_NAME}" OWNER "${CLUSTER_ADMIN_ROLE}"`);
  const base = new URL(adminUrl);
  base.pathname = `/${DATABASE_NAME}`;
  base.username = "placeholder";
  base.password = "placeholder";
  base.search = "";
  base.hash = "";
  const withCredentials = (role: string, password: string): string => {
    const target = new URL(base);
    target.username = role;
    target.password = password;
    return target.toString();
  };
  return {
    adminUrl: withCredentials(CLUSTER_ADMIN_ROLE, clusterAdminPassword),
    migratorUrl: withCredentials(MIGRATOR_ROLE, migratorPassword),
    runtimeUrl: withCredentials(RUNTIME_ROLE, runtimePassword),
    writerUrl: withCredentials(WRITER_ROLE, writerPassword),
    inventoryPassword,
  };
}

async function dropProvisionedRoles(admin: Client): Promise<void> {
  for (const role of [RUNTIME_ROLE, WRITER_ROLE, MIGRATOR_ROLE, INVENTORY_READER_ROLE, CLUSTER_ADMIN_ROLE]) {
    await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = $1 AND pid <> pg_backend_pid()", [role]);
    await admin.query(`DROP OWNED BY ${quoteIdentifier(role)}`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${quoteIdentifier(role)}`).catch(() => undefined);
  }
}

function requestHealth(port: number): Promise<{ body: string; contentType: string; status: number }> {
  return new Promise((resolve, reject) => {
    const healthRequest = request({
      host: "127.0.0.1",
      port,
      path: "/api/health",
      method: "GET",
      headers: { accept: "application/json" },
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
        if (body.length > 16_384) healthRequest.destroy(new Error("BROWSER_E2E_HEALTH_RESPONSE_TOO_LARGE"));
      });
      response.once("end", () => resolve({
        body,
        contentType: response.headers["content-type"] ?? "no_content_type",
        status: response.statusCode ?? 0,
      }));
    });
    healthRequest.setTimeout(1_000, () => healthRequest.destroy(new Error("BROWSER_E2E_HEALTH_REQUEST_TIMEOUT")));
    healthRequest.once("error", reject);
    healthRequest.end();
  });
}

async function waitForHealthyApplication(port: number, app: ChildProcess, worker: ChildProcess): Promise<void> {
  let lastObservation = "not_checked";
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (app.exitCode !== null || app.signalCode !== null) throw new Error("BROWSER_E2E_APP_EXITED");
    if (worker.exitCode !== null || worker.signalCode !== null) throw new Error("BROWSER_E2E_WORKER_EXITED");
    try {
      lastObservation = "requesting";
      const response = await requestHealth(port);
      lastObservation = `http_${response.status}:${response.contentType}`;
      const body = JSON.parse(response.body) as { status?: unknown; database?: unknown; worker?: { status?: unknown } };
      lastObservation = `http_${response.status}:${String(body.status)}:${String(body.database)}:${String(body.worker?.status)}`;
      if (response.status >= 200 && response.status < 300 && body.status === "ok" && body.database === "up" && body.worker?.status === "up") return;
    } catch (error) {
      const errorName = error instanceof Error ? error.name : "unknown";
      lastObservation = `${lastObservation}:error:${errorName}`;
      // The production server and Worker start independently; retry until both are ready.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`BROWSER_E2E_HEALTH_TIMEOUT:${lastObservation}`);
}

async function main() {
  const adminUrl = validatePostgresGateAdminUrl(process.env.POSTGRES_GATE_ADMIN_URL);
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "ai-project-os-browser-e2e-"));
  const admin = new Client({ connectionString: adminUrl.toString(), connectionTimeoutMillis: 5_000 });
  let app: ChildProcess | null = null;
  let worker: ChildProcess | null = null;
  let provisionedRoles = false;

  await admin.connect();
  try {
    const connection = await recreateDatabase(admin, adminUrl);
    provisionedRoles = true;
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: "production",
      DATABASE_PRINCIPAL_ADMIN_URL: connection.adminUrl,
      DATABASE_URL: connection.runtimeUrl,
      ENTITLEMENT_DATABASE_URL: connection.writerUrl,
      MIGRATOR_DATABASE_URL: connection.migratorUrl,
      POSTGRES_ENTITLEMENT_INVENTORY_READER_PASSWORD: connection.inventoryPassword,
      AI_PROJECT_OS_MASTER_KEY_FILE: join(temporaryDirectory, "master.key"),
      AI_PROJECT_OS_WORKER_NAME: "browser-e2e-worker",
    };
    await run("pnpm", ["exec", "tsx", "scripts/reconcile-database-principals.ts", "--bootstrap-if-needed"], environment);
    await run("pnpm", ["exec", "prisma", "migrate", "deploy", "--config", "prisma.config.ts"], { ...environment, DATABASE_URL: connection.migratorUrl });
    await run("pnpm", ["exec", "tsx", "scripts/reconcile-database-principals.ts"], environment);
    const appEnvironment = { ...environment };
    delete appEnvironment.DATABASE_PRINCIPAL_ADMIN_URL;
    delete appEnvironment.MIGRATOR_DATABASE_URL;
    delete appEnvironment.DATABASE_PRINCIPAL_LEGACY_BOOTSTRAP_URL;
    delete appEnvironment.POSTGRES_ENTITLEMENT_INVENTORY_READER_PASSWORD;
    delete appEnvironment.ACCOUNT_ENTITLEMENT_INVENTORY_DATABASE_URL;
    await run("pnpm", ["build"], appEnvironment);
    await cp("public", ".next/standalone/public", { recursive: true, force: true });
    await cp(".next/static", ".next/standalone/.next/static", { recursive: true, force: true });
    const port = await selectBrowserPort();
    const baseUrl = `http://127.0.0.1:${port}`;
    appEnvironment.BROWSER_E2E_BASE_URL = baseUrl;
    appEnvironment.HOSTNAME = "127.0.0.1";
    appEnvironment.PORT = String(port);

    app = track(spawn(process.execPath, [".next/standalone/server.js"], {
      cwd: process.cwd(),
      env: appEnvironment,
      stdio: "inherit",
    }));
    const workerEnvironment = { ...appEnvironment };
    delete workerEnvironment.ENTITLEMENT_DATABASE_URL;
    delete workerEnvironment.DATABASE_PRINCIPAL_ADMIN_URL;
    delete workerEnvironment.MIGRATOR_DATABASE_URL;
    delete workerEnvironment.DATABASE_PRINCIPAL_LEGACY_BOOTSTRAP_URL;
    delete workerEnvironment.POSTGRES_ENTITLEMENT_INVENTORY_READER_PASSWORD;
    delete workerEnvironment.ACCOUNT_ENTITLEMENT_INVENTORY_DATABASE_URL;
    worker = track(spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/automation-worker.ts"], {
      cwd: process.cwd(),
      env: workerEnvironment,
      stdio: "inherit",
    }));
    await waitForHealthyApplication(port, app, worker);
    await run(process.execPath, ["node_modules/@playwright/test/cli.js", "test"], appEnvironment);
  } finally {
    await stop(worker);
    await stop(app);
    await admin.query(`DROP DATABASE IF EXISTS "${DATABASE_NAME}" WITH (FORCE)`).catch(() => undefined);
    if (provisionedRoles) await dropProvisionedRoles(admin);
    await admin.end().catch(() => undefined);
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function interruptChildren() {
  for (const child of liveChildren) child.kill("SIGTERM");
}

process.once("SIGINT", interruptChildren);
process.once("SIGTERM", interruptChildren);

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "BROWSER_E2E_FAILED");
  process.exitCode = 1;
});
