import { execFile as execFileCallback } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { POSTGRES_GATE_TEST_USER } from "./postgres-gate-contract";

const execFile = promisify(execFileCallback);
const IMAGE = "pgvector/pgvector:0.8.6-pg18-trixie@sha256:78bf48b801e792f99e3ac62b5036fd3876e9be48afda16c1e331af1c75ceb2ff";
const DATABASE = "ai_project_os_mcp_client_acceptance_test";
const CLUSTER_ROLE = "ai_project_os_cluster_admin";
const MIGRATOR_ROLE = "ai_project_os_migrator";
const RUNTIME_ROLE = "ai_project_os_runtime";
const ENTITLEMENT_ROLE = "ai_project_os_entitlement_writer";

function commandEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { NODE_ENV: "test", DOTENV_CONFIG_PATH: "/dev/null", PRISMA_TELEMETRY_DISABLED: "1" };
  for (const key of ["PATH", "HOME", "TMPDIR", "TEMP", "LANG", "LC_ALL", "PNPM_HOME", "COREPACK_HOME"] as const) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

async function run(file: string, args: string[], env: NodeJS.ProcessEnv, timeout = 300_000): Promise<string> {
  const result = await execFile(file, args, { env, timeout, maxBuffer: 8 * 1024 * 1024 });
  return result.stdout;
}

function safeText(value: string, secrets: readonly string[]): string {
  let sanitized = value;
  for (const secret of secrets) if (secret.length > 0) sanitized = sanitized.replaceAll(secret, "[redacted]");
  return sanitized
    .replace(/postgres(?:ql)?:\/\/[^\s"'`]+/giu, "[database-url]")
    .replace(/apos_mcp_oauth_[A-Za-z0-9_-]+/gu, "[access-token]")
    .replace(/apos_mcp_code_[A-Za-z0-9_-]+/gu, "[authorization-code]");
}

function errorDetails(error: unknown, secrets: readonly string[]): string {
  if (typeof error !== "object" || error === null) return "MCP_CLIENT_ACCEPTANCE_GATE_FAILED";
  const candidate = error as { message?: unknown; stdout?: unknown; stderr?: unknown };
  const parts = [candidate.message, candidate.stdout, candidate.stderr]
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  return safeText(parts.join("\n").trim() || "MCP_CLIENT_ACCEPTANCE_GATE_FAILED", secrets);
}

function databaseUrl(role: string, port: number, password: string, database = DATABASE): string {
  return `postgresql://${role}:${password}@127.0.0.1:${port}/${database}`;
}

async function main(): Promise<void> {
  const baseEnv = commandEnvironment();
  const password = randomBytes(32).toString("hex");
  const container = `ai-project-os-mcp-client-${randomUUID()}`;
  const temporary = await mkdtemp(join(tmpdir(), "ai-project-os-mcp-client-"));
  const envFile = join(temporary, "postgres.env");
  const keyPath = join(temporary, "master.key");
  const secrets = [password];
  let containerCreationAttempted = false;
  let success = false;
  let cleanupFailed = false;

  try {
    await writeFile(envFile, `POSTGRES_USER=${CLUSTER_ROLE}\nPOSTGRES_PASSWORD=${password}\nPOSTGRES_DB=${DATABASE}\n`, { mode: 0o600 });
    await writeFile(keyPath, `${randomBytes(32).toString("base64url")}\n`, { mode: 0o600 });
    await run("docker", ["image", "inspect", IMAGE], baseEnv, 30_000);

    const context = (await run("docker", ["context", "show"], baseEnv, 30_000)).trim();
    const endpoint = (await run("docker", ["context", "inspect", context, "--format", "{{.Endpoints.docker.Host}}"], baseEnv, 30_000)).trim();
    if (!endpoint.startsWith("unix://")) throw new Error("MCP_CLIENT_ACCEPTANCE_LOCAL_DOCKER_CONTEXT_REQUIRED");

    containerCreationAttempted = true;
    await run("docker", [
      "run", "--detach", "--pull=never", "--name", container,
      "--publish", "127.0.0.1::5432", "--env-file", envFile, IMAGE,
    ], baseEnv);
    const portOutput = (await run("docker", ["port", container, "5432/tcp"], baseEnv, 30_000)).trim();
    const portMatch = portOutput.match(/^127\.0\.0\.1:(\d+)$/u);
    const port = Number(portMatch?.[1]);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("MCP_CLIENT_ACCEPTANCE_LOOPBACK_PORT_INVALID");

    let ready = false;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        await run("docker", ["exec", container, "pg_isready", "-h", "127.0.0.1", "-U", CLUSTER_ROLE, "-d", DATABASE], baseEnv, 10_000);
        ready = true;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    if (!ready) throw new Error("MCP_CLIENT_ACCEPTANCE_DATABASE_NOT_READY");

    const clusterUrl = databaseUrl(CLUSTER_ROLE, port, password);
    const admin = new Client({ connectionString: clusterUrl, connectionTimeoutMillis: 5_000 });
    await admin.connect();
    try {
      for (const role of [MIGRATOR_ROLE, RUNTIME_ROLE, ENTITLEMENT_ROLE]) {
        await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT`);
      }
      await admin.query(`CREATE ROLE "${POSTGRES_GATE_TEST_USER}" LOGIN SUPERUSER PASSWORD '${password}'`);
      await admin.query(`ALTER DATABASE "${DATABASE}" OWNER TO "${MIGRATOR_ROLE}"`);
      await admin.query("CREATE EXTENSION vector; CREATE EXTENSION pg_trgm; CREATE EXTENSION pgcrypto; ALTER SCHEMA public OWNER TO ai_project_os_migrator");
      await admin.query(`GRANT CONNECT ON DATABASE "${DATABASE}" TO "${RUNTIME_ROLE}", "${MIGRATOR_ROLE}", "${ENTITLEMENT_ROLE}", "${POSTGRES_GATE_TEST_USER}"`);
    } finally {
      await admin.end();
    }

    const migratorUrl = databaseUrl(MIGRATOR_ROLE, port, password);
    await run("pnpm", ["exec", "prisma", "migrate", "deploy", "--config", "prisma.config.ts"], {
      ...baseEnv,
      DATABASE_URL: migratorUrl,
    });
    const extensions = await readdir("prisma/migrations", { withFileTypes: true });
    console.log(`MCP_CLIENT_ACCEPTANCE_MIGRATIONS_OK count=${extensions.filter((entry) => entry.isDirectory()).length}`);

    const grants = new Client({ connectionString: clusterUrl, connectionTimeoutMillis: 5_000 });
    await grants.connect();
    try {
      await grants.query(`GRANT USAGE ON SCHEMA public TO "${RUNTIME_ROLE}", "${ENTITLEMENT_ROLE}"`);
      await grants.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO "${RUNTIME_ROLE}"`);
      await grants.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${ENTITLEMENT_ROLE}"`);
      await grants.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "${ENTITLEMENT_ROLE}"`);
      await grants.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO "${ENTITLEMENT_ROLE}"`);
    } finally {
      await grants.end();
    }

    const gateUrl = databaseUrl(POSTGRES_GATE_TEST_USER, port, password);
    const entitlementUrl = databaseUrl(ENTITLEMENT_ROLE, port, password);
    const testOutput = await run(process.execPath, [
      "--import", "tsx", "--test", "--test-concurrency=1", "test/mcp-client-acceptance-postgres.test.ts",
    ], {
      ...baseEnv,
      NODE_ENV: "test",
      DATABASE_URL: gateUrl,
      ENTITLEMENT_DATABASE_URL: entitlementUrl,
      AI_PROJECT_OS_MASTER_KEY_FILE: keyPath,
      MCP_CLIENT_ACCEPTANCE_POSTGRES_GATE: "1",
      PRISMA_TELEMETRY_DISABLED: "1",
    });
    console.log(safeText(testOutput.trim(), secrets));
    success = true;
  } catch (error) {
    process.exitCode = 1;
    console.error(errorDetails(error, secrets));
  } finally {
    if (containerCreationAttempted) {
      try {
        await run("docker", ["rm", "--force", "--volumes", container], baseEnv, 30_000);
        console.log("MCP_CLIENT_ACCEPTANCE_CONTAINER_CLEANED");
      } catch (error) {
        const details = errorDetails(error, secrets);
        if (!/No such (?:container|object)/iu.test(details)) {
          cleanupFailed = true;
          process.exitCode = 1;
          console.error("MCP_CLIENT_ACCEPTANCE_CONTAINER_CLEANUP_FAILED");
        }
      }
    }
    try {
      await rm(temporary, { recursive: true, force: true });
      console.log("MCP_CLIENT_ACCEPTANCE_TEMP_CLEANED");
    } catch {
      cleanupFailed = true;
      process.exitCode = 1;
      console.error("MCP_CLIENT_ACCEPTANCE_TEMP_CLEANUP_FAILED");
    }
  }

  if (success && !cleanupFailed) console.log("MCP_CLIENT_ACCEPTANCE_POSTGRES_GATE_OK");
}

void main().catch(() => {
  console.error("MCP_CLIENT_ACCEPTANCE_GATE_SETUP_FAILED");
  process.exitCode = 1;
});
