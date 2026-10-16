import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { request } from "node:http";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import {
  validatePostgresGateAdminUrl,
} from "./postgres-gate-contract";
import { prepareReleaseImagesForCheck } from "./local-release-images";
import type { ReleaseImageName } from "./release-image-manifest";

const DATABASE_NAME = "ai_project_os_browser_e2e_test";
const CLUSTER_ADMIN_ROLE = "ai_project_os_cluster_admin";
const MIGRATOR_ROLE = "ai_project_os_migrator";
const RUNTIME_ROLE = "ai_project_os_runtime";
const WRITER_ROLE = "ai_project_os_entitlement_writer";
const INVENTORY_READER_ROLE = "ai_project_os_entitlement_inventory_reader";
const GIT_AUTOMATION_WORKER_ROLE = "ai_project_os_git_automation_worker";
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

async function capture(command: string, args: readonly string[], environment: NodeJS.ProcessEnv = process.env): Promise<string> {
  const child = track(spawn(command, [...args], { cwd: process.cwd(), env: environment, stdio: ["ignore", "pipe", "pipe"] }));
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  const result = await waitForExit(child);
  if (result.code !== 0) throw new Error(`BROWSER_E2E_COMMAND_FAILED:${args[0] ?? command}:${stderr.trim().slice(-400)}`);
  return stdout.trim();
}

function databaseUrlForContainer(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("BROWSER_E2E_DATABASE_URL_INVALID");
  }
  if (!(["postgres:", "postgresql:"].includes(parsed.protocol)
      && ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname.toLowerCase())
      && parsed.port === "56432")) {
    throw new Error("BROWSER_E2E_DATABASE_URL_INVALID");
  }
  parsed.hostname = "host.docker.internal";
  return parsed.toString();
}

async function inspectImage(imageId: string, version: string, revision: string, name: ReleaseImageName): Promise<void> {
  const labels = await capture("docker", [
    "image", "inspect", imageId,
    "--format",
    '{{.Id}}|{{ index .Config.Labels "org.opencontainers.image.version" }}|{{ index .Config.Labels "org.opencontainers.image.revision" }}|{{ index .Config.Labels "org.opencontainers.image.source" }}',
  ]);
  const expected = `${imageId}|${version}|${revision}|https://github.com/Jack-Kunlun/ai-project-os`;
  if (labels !== expected) throw new Error(`BROWSER_E2E_IMAGE_IDENTITY_MISMATCH:${name}`);
}

async function startImageContainer(
  name: string,
  imageId: string,
  environment: Readonly<Record<string, string>>,
  temporaryDirectory: string,
  hostPort?: number,
): Promise<string> {
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  const args = [
    "run", "--detach", "--name", name,
    "--user", `${uid}:${gid}`,
    "--add-host", "host.docker.internal:host-gateway",
    "--mount", `type=bind,src=${temporaryDirectory},dst=/ci-secrets`,
  ];
  if (hostPort !== undefined) args.push("--publish", `127.0.0.1:${hostPort}:3000`);
  for (const [key, value] of Object.entries(environment)) args.push("--env", `${key}=${value}`);
  args.push(imageId);
  return capture("docker", args);
}

async function stopImageContainer(name: string | null): Promise<void> {
  if (name === null) return;
  await capture("docker", ["stop", "--time", "5", name]).catch(() => undefined);
  await capture("docker", ["rm", "--force", name]).catch(() => undefined);
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

async function recreateDatabase(admin: Client, adminUrl: URL): Promise<Readonly<{ adminUrl: string; migratorUrl: string; runtimeUrl: string; writerUrl: string; gitAutomationUrl: string; inventoryPassword: string }>> {
  await admin.query(`DROP DATABASE IF EXISTS "${DATABASE_NAME}" WITH (FORCE)`);
  const suffix = randomBytes(18).toString("hex");
  const clusterAdminPassword = `ClusterAdmin_${suffix}`;
  const migratorPassword = `Migrator_${suffix}`;
  const runtimePassword = `Runtime_${suffix}`;
  const writerPassword = `Writer_${suffix}`;
  const gitAutomationWorkerPassword = `GitAutomationWorker_${randomBytes(24).toString("hex")}`;
  const inventoryPassword = `Inventory_${suffix}`;
  await ensureRole(admin, CLUSTER_ADMIN_ROLE, clusterAdminPassword, "SUPERUSER CREATEDB CREATEROLE INHERIT NOREPLICATION NOBYPASSRLS");
  await ensureRole(admin, MIGRATOR_ROLE, migratorPassword, "NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS");
  await ensureRole(admin, RUNTIME_ROLE, runtimePassword, "NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS", false);
  await ensureRole(admin, WRITER_ROLE, writerPassword, "NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS", false);
  await ensureRole(admin, INVENTORY_READER_ROLE, inventoryPassword, "NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS");
  await ensureRole(admin, GIT_AUTOMATION_WORKER_ROLE, gitAutomationWorkerPassword, "NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS");
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
  // The template database owns plpgsql as the initdb role. Recreate it under
  // the disposable cluster admin so the principal ownership gate can run.
  const clusterAdmin = new Client({ connectionString: withCredentials(CLUSTER_ADMIN_ROLE, clusterAdminPassword) });
  await clusterAdmin.connect();
  try {
    await clusterAdmin.query("DROP EXTENSION plpgsql");
    await clusterAdmin.query("CREATE EXTENSION plpgsql");
  } finally {
    await clusterAdmin.end();
  }
  return {
    adminUrl: withCredentials(CLUSTER_ADMIN_ROLE, clusterAdminPassword),
    migratorUrl: withCredentials(MIGRATOR_ROLE, migratorPassword),
    runtimeUrl: withCredentials(RUNTIME_ROLE, runtimePassword),
    writerUrl: withCredentials(WRITER_ROLE, writerPassword),
    gitAutomationUrl: withCredentials(GIT_AUTOMATION_WORKER_ROLE, gitAutomationWorkerPassword),
    inventoryPassword,
  };
}

async function dropProvisionedRoles(admin: Client): Promise<void> {
  for (const role of [RUNTIME_ROLE, WRITER_ROLE, MIGRATOR_ROLE, INVENTORY_READER_ROLE, GIT_AUTOMATION_WORKER_ROLE, CLUSTER_ADMIN_ROLE]) {
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

async function waitForHealthyApplication(port: number, app: string, worker: string): Promise<void> {
  let lastObservation = "not_checked";
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const running = await Promise.all([app, worker].map(async (container) =>
        await capture("docker", ["inspect", "--format", "{{.State.Running}}", container]).catch(() => "false")));
      if (running[0] !== "true") throw new Error("BROWSER_E2E_APP_EXITED");
      if (running[1] !== "true") throw new Error("BROWSER_E2E_WORKER_EXITED");
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
  const packageManifest = JSON.parse(await readFile("package.json", "utf8")) as { version?: unknown };
  if (typeof packageManifest.version !== "string") throw new Error("BROWSER_E2E_PACKAGE_VERSION_INVALID");
  const packageVersion = packageManifest.version;
  const revision = await capture("git", ["rev-parse", "HEAD"]);
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "ai-project-os-browser-e2e-"));
  const uploadsDirectory = join(temporaryDirectory, "uploads");
  const admin = new Client({ connectionString: adminUrl.toString(), connectionTimeoutMillis: 5_000 });
  const identity = randomBytes(8).toString("hex");
  const appName = `ai-project-os-browser-${identity}-app`;
  const workerName = `ai-project-os-browser-${identity}-worker`;
  let appContainer: string | null = null;
  let workerContainer: string | null = null;
  let provisionedRoles = false;

  try {
    const manifest = await prepareReleaseImagesForCheck(packageVersion, revision);
    await Promise.all([
      inspectImage(manifest.images.app.id, manifest.version, manifest.revision, "app"),
      inspectImage(manifest.images.worker.id, manifest.version, manifest.revision, "worker"),
    ]);
    await mkdir(uploadsDirectory, { recursive: true, mode: 0o700 });
    await admin.connect();
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
    delete environment.GIT_AUTOMATION_DATABASE_URL;
    const principalEnvironment = { ...environment, GIT_AUTOMATION_DATABASE_URL: connection.gitAutomationUrl };
    await run("pnpm", ["exec", "tsx", "scripts/reconcile-database-principals.ts", "--bootstrap-if-needed"], principalEnvironment);
    await run("pnpm", ["exec", "prisma", "migrate", "deploy", "--config", "prisma.config.ts"], { ...environment, DATABASE_URL: connection.migratorUrl });
    await run("pnpm", ["exec", "tsx", "scripts/reconcile-database-principals.ts"], principalEnvironment);
    const masterKey = `${randomBytes(32).toString("base64url")}\n`;
    await writeFile(join(temporaryDirectory, "master.key"), masterKey, { encoding: "utf8", mode: 0o600, flag: "wx" });
    const port = await selectBrowserPort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const appEnvironment = {
      NODE_ENV: "production",
      DATABASE_URL: databaseUrlForContainer(connection.runtimeUrl),
      ENTITLEMENT_DATABASE_URL: databaseUrlForContainer(connection.writerUrl),
      AI_PROJECT_OS_MASTER_KEY_FILE: "/ci-secrets/master.key",
      AI_PROJECT_OS_ASSET_DIR: "/ci-secrets/uploads",
      AI_PROJECT_OS_WORKER_NAME: "browser-e2e-worker",
      AI_PROJECT_OS_SECURE_COOKIES: "false",
      AI_PROJECT_OS_PUBLIC_ORIGIN: baseUrl,
      LOCAL_REGISTRATION_ENABLED: "true",
      HOSTNAME: "0.0.0.0",
      PORT: "3000",
    };
    const workerEnvironment = {
      NODE_ENV: "production",
      DATABASE_URL: databaseUrlForContainer(connection.runtimeUrl),
      AI_PROJECT_OS_MASTER_KEY_FILE: "/ci-secrets/master.key",
      AI_PROJECT_OS_ASSET_DIR: "/ci-secrets/uploads",
      AI_PROJECT_OS_WORKER_NAME: "browser-e2e-worker",
    };

    appContainer = await startImageContainer(appName, manifest.images.app.id, appEnvironment, temporaryDirectory, port);
    workerContainer = await startImageContainer(workerName, manifest.images.worker.id, workerEnvironment, temporaryDirectory);
    const browserEnvironment = { ...environment, BROWSER_E2E_BASE_URL: baseUrl, LOCAL_REGISTRATION_ENABLED: "true" };
    await waitForHealthyApplication(port, appName, workerName);
    await run(process.execPath, ["node_modules/@playwright/test/cli.js", "test"], browserEnvironment);
  } catch (error) {
    if (workerContainer !== null) {
      const logs = await capture("docker", ["logs", "--tail", "200", workerName]).catch(() => "");
      if (logs) process.stderr.write(`[browser-e2e] worker logs\n${logs}\n`);
    }
    if (appContainer !== null) {
      const logs = await capture("docker", ["logs", "--tail", "200", appName]).catch(() => "");
      if (logs) process.stderr.write(`[browser-e2e] app logs\n${logs}\n`);
    }
    throw error;
  } finally {
    await stopImageContainer(workerName);
    await stopImageContainer(appName);
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
