import { createHash, randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, mkdtemp, open, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";
import { type PublicRecoveryDrill, type RecoveryDrillCheckResults, type RecoveryDrillSecurityCounts } from "../src/lib/system-operations-types";
import { readCliArguments } from "./cli-arguments";

const DEFAULT_COMPOSE_FILE = "compose.yaml";
const DEFAULT_STATUS_ROOT = "/var/lib/ai-project-os-operations/backups";
const DATABASE_NAME = "ai_project_os";
const CLUSTER_ADMIN_ROLE = "ai_project_os_cluster_admin";
const MAX_DRILL_STATUS_BYTES = 32 * 1024;
const SAFE_NAME = /^[a-z0-9][a-z0-9_.-]{2,62}$/u;
const SAFE_STATUS_ROOT = /^\/[A-Za-z0-9._/-]+$/u;
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{2,127}$/u;
const DUMP_CONTAINER_PATH = "/tmp/ai-project-os-recovery.dump";
const ONE_SHOT_TIMEOUT_MS = 120_000;
const SUBPROCESS_TIMEOUT_MS = 5 * 60 * 1_000;
const INTERRUPT_GRACE_MS = 5_000;
const ONE_SHOT_LOG_TAIL_LINES = "64";
const ONE_SHOT_DIAGNOSTIC_BYTES = 16 * 1024;
const ONE_SHOT_DIAGNOSTIC_LIMIT = 8;
const DATABASE_PRINCIPAL_DIAGNOSTIC = /DATABASE_PRINCIPAL_[A-Z0-9_]+/gu;
const MAX_VOLUME_MANIFEST_OUTPUT_BYTES = 8 * 1024;
const MAX_VOLUME_MANIFEST_ENTRIES = 100_000;
const MAX_VOLUME_MANIFEST_PATH_BYTES = 4 * 1024;
const MAX_VOLUME_MANIFEST_FILE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_VOLUME_MANIFEST_TOTAL_BYTES = 20 * 1024 * 1024 * 1024;
const MAX_VOLUME_MANIFEST_METADATA_BYTES = 64 * 1024;
const MAX_DATABASE_DUMP_BYTES = 20 * 1024 * 1024 * 1024;
const CREDENTIAL_RECOVERY_SUCCESS = "RECOVERY_DRILL_CREDENTIAL_CHECK_PASSED";
const CREDENTIAL_RECOVERY_ZERO = "RECOVERY_DRILL_CREDENTIAL_CHECK_ZERO";
const SOURCE_LOCK_ROOT = "/tmp/ai-project-os-recovery-drill-locks";
const SOURCE_SECRETS_DESTINATION = "/var/lib/ai-project-os-secrets";
const SOURCE_UPLOADS_DESTINATION = "/var/lib/ai-project-os/uploads";
let activeChild: ChildProcess | null = null;
let activeStreamAbort: AbortController | null = null;
let interruptRequested = false;
let cleanupInProgress = false;
const RECOVERY_DRILL_LABEL_PREFIX = "ai-project-os.recovery-drill";
const RECOVERY_DRILL_ID_LABEL = `${RECOVERY_DRILL_LABEL_PREFIX}.id`;
const RECOVERY_DRILL_PROJECT_LABEL = `${RECOVERY_DRILL_LABEL_PREFIX}.project`;
const RECOVERY_DRILL_PURPOSE_LABEL = `${RECOVERY_DRILL_LABEL_PREFIX}.purpose`;
const DOCKER_CLIENT_ENV_KEYS = Object.freeze([
  "PATH", "HOME", "TMPDIR", "TMP", "TEMP",
  "DOCKER_CONFIG", "DOCKER_CONTEXT", "DOCKER_HOST", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH",
  "COMPOSE_ANSI", "COMPOSE_FILE", "COMPOSE_PROJECT_NAME", "COMPOSE_PROFILES", "COMPOSE_PARALLEL_LIMIT", "COMPOSE_PROGRESS", "BUILDKIT_PROGRESS",
] as const);
const SOURCE_COMPOSE_ENV_KEYS = Object.freeze([
  ...DOCKER_CLIENT_ENV_KEYS,
  "POSTGRES_USER", "POSTGRES_CLUSTER_ADMIN_PASSWORD", "POSTGRES_MIGRATOR_PASSWORD", "POSTGRES_DB",
  "DATABASE_URL", "POSTGRES_RUNTIME_USER", "POSTGRES_RUNTIME_PASSWORD", "POSTGRES_ENTITLEMENT_WRITER_USER",
  "POSTGRES_ENTITLEMENT_WRITER_PASSWORD", "POSTGRES_ENTITLEMENT_INVENTORY_READER_PASSWORD", "ENTITLEMENT_DATABASE_URL",
  "MIGRATOR_DATABASE_URL", "DATABASE_PRINCIPAL_ADMIN_URL", "DATABASE_PRINCIPAL_LEGACY_BOOTSTRAP_URL",
  "ACCOUNT_ENTITLEMENT_INVENTORY_DATABASE_URL", "APP_PORT", "POSTGRES_PORT", "AI_PROJECT_OS_PGDATA_VOLUME",
  "AI_PROJECT_OS_SECRETS_VOLUME", "AI_PROJECT_OS_UPLOADS_VOLUME", "AI_PROJECT_OS_SECURE_COOKIES", "AI_PROJECT_OS_PUBLIC_ORIGIN",
  "AI_PROJECT_OS_WORKER_NAME", "AI_PROJECT_OS_UPLOAD_MAX_FILES", "AI_PROJECT_OS_UPLOAD_MAX_FILE_BYTES",
  "AI_PROJECT_OS_UPLOAD_MAX_IMAGE_BYTES", "AI_PROJECT_OS_UPLOAD_MAX_REQUEST_BYTES", "AI_PROJECT_OS_UPLOAD_MAX_PROJECT_BYTES",
  "AI_PROJECT_OS_UPLOAD_MAX_WORKSPACE_BYTES", "AI_PROJECT_OS_UPLOAD_MAX_DEPLOYMENT_BYTES", "AI_PROJECT_OS_UPLOAD_MAX_PROJECT_ASSETS",
  "AI_PROJECT_OS_UPLOAD_MAX_PROJECT_RETAINED_OBJECTS", "AI_PROJECT_OS_UPLOAD_MAX_WORKSPACE_RETAINED_OBJECTS",
  "AI_PROJECT_OS_UPLOAD_MAX_DEPLOYMENT_RETAINED_OBJECTS", "AI_PROJECT_OS_UPLOAD_MAX_UPLOADS_PER_MINUTE",
  "AI_PROJECT_OS_UPLOAD_MAX_CONCURRENT", "AI_PROJECT_OS_UPLOAD_MAX_GLOBAL_CONCURRENT", "AI_PROJECT_OS_UPLOAD_ADMISSION_LEASE_MS",
  "AI_PROJECT_OS_UPLOAD_PARSE_LEASE_MS", "AI_PROJECT_OS_UPLOAD_BODY_TIMEOUT_MS",
] as const);

type ProcessResult = Readonly<{ code: number; stdout: string; stderr: string }>;
type SourceService = "principal-bootstrap" | "migrate" | "reconcile" | "app" | "worker";
type ComposeService = SourceService | "postgres";
type OneShotService = "principal-bootstrap" | "migrate" | "reconcile";
type SourceServiceContainer = Readonly<{ container: string; image: string }>;
type SourceWriter = Readonly<{ id: string; service: "app" | "worker" }>;
type TrackedContainer = Readonly<{ id: string; service: ComposeService; projectName: string; drillId: string }>;
type TrackedHelper = Readonly<{ id: string | null; name: string; purpose: string; projectName: string; drillId: string }>;
type DockerLabels = Readonly<Record<string, string | null>>;
type DockerResource = Readonly<Record<string, unknown>>;
type OwnedVolume = Readonly<{ name: string; purpose: string; projectName: string; drillId: string; fingerprint: string | null }>;
type TrackedNetwork = Readonly<{ id: string | null; name: string; fingerprint: string | null; projectName: string; drillId: string }>;
type SourceLock = Readonly<{ path: string; dev: number; ino: number }>;
type SourceDataVolumes = Readonly<{ secrets: string; uploads: string }>;
type VolumeManifest = Readonly<{
  digest: string;
  entryCount: number;
  totalBytes: number;
  maxPathBytes: number;
  masterKey: Readonly<{ present: boolean; mode: number | null; secure: boolean }>;
}>;

const composeServices: readonly ComposeService[] = Object.freeze([
  "postgres", "principal-bootstrap", "migrate", "reconcile", "app", "worker",
]);

class RecoveryDrillError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "RecoveryDrillError";
  }
}

const oneShotFailureCodes: Readonly<Record<OneShotService, string>> = Object.freeze({
  "principal-bootstrap": "RECOVERY_DRILL_PRINCIPAL_BOOTSTRAP_ONE_SHOT_FAILED",
  migrate: "RECOVERY_DRILL_MIGRATE_ONE_SHOT_FAILED",
  reconcile: "RECOVERY_DRILL_RECONCILE_ONE_SHOT_FAILED",
});

function fail(code: string): never {
  throw new RecoveryDrillError(code);
}

function parseArguments(args: readonly string[]): Readonly<{ noPublish: boolean; composeFile: string; statusRoot: string; sourceProject: string }> {
  const meaningful = args[0] === "--" ? args.slice(1) : args;
  let composeFile = DEFAULT_COMPOSE_FILE;
  let statusRoot = process.env.AI_PROJECT_OS_OPERATIONS_STATUS_ROOT ?? DEFAULT_STATUS_ROOT;
  let sourceProject = "ai-project-os";
  let noPublish = false;
  for (let index = 0; index < meaningful.length; index += 1) {
    const argument = meaningful[index];
    if (argument === "--no-publish") {
      noPublish = true;
    } else if (argument === "--compose-file") {
      const value = meaningful[index + 1];
      if (value === undefined || value.length === 0) fail("RECOVERY_DRILL_COMPOSE_FILE_INVALID");
      composeFile = value;
      index += 1;
    } else if (argument === "--status-root") {
      const value = meaningful[index + 1];
      if (value === undefined || value.length === 0) fail("RECOVERY_DRILL_STATUS_ROOT_INVALID");
      statusRoot = value;
      index += 1;
    } else if (argument === "--source-project") {
      const value = meaningful[index + 1];
      if (value === undefined || value.length === 0) fail("RECOVERY_DRILL_SOURCE_PROJECT_INVALID");
      sourceProject = value;
      index += 1;
    } else {
      fail("RECOVERY_DRILL_ARGUMENT_UNKNOWN");
    }
  }
  if (!isAbsolute(statusRoot) || normalize(statusRoot) !== statusRoot || !SAFE_STATUS_ROOT.test(statusRoot) || statusRoot === "/") fail("RECOVERY_DRILL_STATUS_ROOT_INVALID");
  return Object.freeze({ noPublish, composeFile, statusRoot, sourceProject: validateResourceName(sourceProject) });
}

function selectEnvironment(source: NodeJS.ProcessEnv, keys: readonly string[]): NodeJS.ProcessEnv {
  return Object.fromEntries(keys.flatMap((key) => source[key] === undefined ? [] : [[key, source[key] as string]])) as NodeJS.ProcessEnv;
}

function dockerClientEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return selectEnvironment(source, DOCKER_CLIENT_ENV_KEYS);
}

async function requireLocalDockerContext(environment: NodeJS.ProcessEnv): Promise<void> {
  if (process.env.DOCKER_HOST !== undefined) fail("RECOVERY_DRILL_REMOTE_DOCKER_UNSUPPORTED");
  const result = await requireProcess("docker", ["context", "inspect", "--format", "{{json .Endpoints.docker}}"], environment, "RECOVERY_DRILL_DOCKER_CONTEXT_QUERY_FAILED");
  const payload = result.stdout.trim();
  if (payload.length === 0 || payload.includes("\n")) fail("RECOVERY_DRILL_DOCKER_CONTEXT_INVALID");
  const endpoint = parseJson<unknown>(payload, "RECOVERY_DRILL_DOCKER_CONTEXT_INVALID");
  if (typeof endpoint !== "object" || endpoint === null || Array.isArray(endpoint) || typeof (endpoint as { Host?: unknown }).Host !== "string" || !(endpoint as { Host: string }).Host.startsWith("unix://")) fail("RECOVERY_DRILL_REMOTE_DOCKER_UNSUPPORTED");
  const host = (endpoint as { Host: string }).Host;
  const socketPath = host.slice("unix://".length);
  if (!isAbsolute(socketPath) || normalize(socketPath) !== socketPath || socketPath.includes("\0")) fail("RECOVERY_DRILL_REMOTE_DOCKER_UNSUPPORTED");
}

function sourceComposeEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return selectEnvironment(source, SOURCE_COMPOSE_ENV_KEYS);
}

function terminateChild(child: ChildProcess): void {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  const killTimer = setTimeout(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  }, INTERRUPT_GRACE_MS);
  killTimer.unref();
}

function requestInterruption(): void {
  interruptRequested = true;
  if (activeChild !== null) terminateChild(activeChild);
  activeStreamAbort?.abort();
}

function installInterruptHandlers(): void {
  process.on("SIGINT", requestInterruption);
  process.on("SIGTERM", requestInterruption);
}

function removeInterruptHandlers(): void {
  process.off("SIGINT", requestInterruption);
  process.off("SIGTERM", requestInterruption);
}

function interruptedError(): RecoveryDrillError {
  return new RecoveryDrillError("RECOVERY_DRILL_INTERRUPTED");
}

function runProcess(command: string, args: readonly string[], environment: NodeJS.ProcessEnv, allowDuringInterruption = false): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    if (interruptRequested && !cleanupInProgress && !allowDuringInterruption) {
      reject(interruptedError());
      return;
    }
    const child = spawn(command, [...args], { cwd: process.cwd(), env: environment, stdio: ["ignore", "pipe", "pipe"] });
    activeChild = child;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      terminateChild(child);
    }, SUBPROCESS_TIMEOUT_MS);
    timeout.unref();
    const finish = (error: RecoveryDrillError | null, result?: ProcessResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (activeChild === child) activeChild = null;
      if (error !== null) reject(error);
      else resolve(result!);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", () => finish(new RecoveryDrillError("RECOVERY_DRILL_COMMAND_UNAVAILABLE")));
    child.once("close", (code) => {
      if (interruptRequested && !cleanupInProgress && !allowDuringInterruption) finish(interruptedError());
      else if (timedOut) finish(new RecoveryDrillError("RECOVERY_DRILL_SUBPROCESS_TIMEOUT"));
      else finish(null, { code: code ?? 1, stdout, stderr });
    });
  });
}

async function requireProcess(command: string, args: readonly string[], environment: NodeJS.ProcessEnv, failureCode = "RECOVERY_DRILL_COMMAND_FAILED", allowDuringInterruption = false): Promise<ProcessResult> {
  const result = await runProcess(command, args, environment, allowDuringInterruption);
  if (result.code !== 0) fail(SAFE_ERROR_CODE.test(failureCode) ? failureCode : "RECOVERY_DRILL_COMMAND_FAILED");
  return result;
}

function runToFile(command: string, args: readonly string[], outputPath: string, environment: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    if (interruptRequested && !cleanupInProgress) {
      reject(interruptedError());
      return;
    }
    const child = spawn(command, [...args], { cwd: process.cwd(), env: environment, stdio: ["ignore", "pipe", "pipe"] });
    activeChild = child;
    const output = createWriteStream(outputPath, { mode: 0o600 });
    let settled = false;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      terminateChild(child);
    }, SUBPROCESS_TIMEOUT_MS);
    timeout.unref();
    const finish = (error: RecoveryDrillError | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (activeChild === child) activeChild = null;
      if (error !== null) reject(error);
      else resolve();
    };
    child.stderr.resume();
    child.once("error", () => finish(new RecoveryDrillError("RECOVERY_DRILL_COMMAND_UNAVAILABLE")));
    output.once("error", () => {
      terminateChild(child);
      finish(new RecoveryDrillError("RECOVERY_DRILL_DUMP_WRITE_FAILED"));
    });
    output.once("close", () => {
      if (settled || child.exitCode === null) return;
      if (interruptRequested && !cleanupInProgress) finish(interruptedError());
      else if (timedOut) finish(new RecoveryDrillError("RECOVERY_DRILL_SUBPROCESS_TIMEOUT"));
      else if (child.exitCode !== 0) finish(new RecoveryDrillError("RECOVERY_DRILL_PG_DUMP_FAILED"));
      else finish(null);
    });
    child.once("close", (code) => {
      if (interruptRequested && !cleanupInProgress) {
        output.destroy();
        finish(interruptedError());
      } else if (timedOut) {
        output.destroy();
        finish(new RecoveryDrillError("RECOVERY_DRILL_SUBPROCESS_TIMEOUT"));
      } else if (code !== 0) {
        output.destroy();
        finish(new RecoveryDrillError("RECOVERY_DRILL_PG_DUMP_FAILED"));
      } else {
        output.end();
      }
    });
    child.stdout.pipe(output);
  });
}

function runWithInputText(command: string, args: readonly string[], input: string, environment: NodeJS.ProcessEnv, maximumOutputBytes = MAX_VOLUME_MANIFEST_OUTPUT_BYTES): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    if (interruptRequested && !cleanupInProgress) {
      reject(interruptedError());
      return;
    }
    const child = spawn(command, [...args], { cwd: process.cwd(), env: environment, stdio: ["pipe", "pipe", "pipe"] });
    activeChild = child;
    let stdout = "";
    let stderr = "";
    let outputExceeded = false;
    let settled = false;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      terminateChild(child);
    }, SUBPROCESS_TIMEOUT_MS);
    timeout.unref();
    const finish = (error: RecoveryDrillError | null, result?: ProcessResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (activeChild === child) activeChild = null;
      if (error !== null) reject(error);
      else resolve(result!);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const appendBounded = (target: "stdout" | "stderr", chunk: string): void => {
      if (outputExceeded) return;
      const next = target === "stdout" ? stdout + chunk : stderr + chunk;
      if (Buffer.byteLength(next, "utf8") > maximumOutputBytes) {
        outputExceeded = true;
        child.kill("SIGKILL");
        return;
      }
      if (target === "stdout") stdout = next;
      else stderr = next;
    };
    child.stdout.on("data", (chunk: string) => appendBounded("stdout", chunk));
    child.stderr.on("data", (chunk: string) => appendBounded("stderr", chunk));
    child.once("error", () => finish(new RecoveryDrillError("RECOVERY_DRILL_COMMAND_UNAVAILABLE")));
    child.stdin.end(input);
    child.once("close", (code) => {
      if (interruptRequested && !cleanupInProgress) finish(interruptedError());
      else if (timedOut) finish(new RecoveryDrillError("RECOVERY_DRILL_SUBPROCESS_TIMEOUT"));
      else finish(null, { code: outputExceeded ? 1 : code ?? 1, stdout, stderr });
    });
  });
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once("error", () => reject(new RecoveryDrillError("RECOVERY_DRILL_PORT_UNAVAILABLE")));
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new RecoveryDrillError("RECOVERY_DRILL_PORT_UNAVAILABLE"));
        return;
      }
      server.close((error) => error ? reject(new RecoveryDrillError("RECOVERY_DRILL_PORT_UNAVAILABLE")) : resolve(address.port));
    });
  });
}

function timestampName(date: Date): string {
  const iso = date.toISOString();
  return `${iso.slice(0, 10).replaceAll("-", "") }T${iso.slice(11, 19).replaceAll(":", "")}Z`;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function acquireSourceLock(sourceProject: string): Promise<SourceLock> {
  const lockPath = join(SOURCE_LOCK_ROOT, sha256(sourceProject));
  try {
    await mkdir(SOURCE_LOCK_ROOT, { recursive: true, mode: 0o700 });
    const rootMetadata = await lstat(SOURCE_LOCK_ROOT);
    if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) fail("RECOVERY_DRILL_SOURCE_LOCK_ROOT_INVALID");
    await mkdir(lockPath, { mode: 0o700 });
  } catch (error) {
    if (error instanceof RecoveryDrillError) throw error;
    if ((error as NodeJS.ErrnoException).code === "EEXIST") fail("RECOVERY_DRILL_SOURCE_BUSY");
    fail("RECOVERY_DRILL_SOURCE_LOCK_CREATE_FAILED");
  }
  const metadata = await lstat(lockPath).catch(() => fail("RECOVERY_DRILL_SOURCE_LOCK_INVALID"));
  if (metadata.isSymbolicLink() || !metadata.isDirectory() || !Number.isSafeInteger(metadata.dev) || !Number.isSafeInteger(metadata.ino)) {
    fail("RECOVERY_DRILL_SOURCE_LOCK_INVALID");
  }
  return Object.freeze({ path: lockPath, dev: metadata.dev, ino: metadata.ino });
}

async function releaseSourceLock(lock: SourceLock): Promise<void> {
  const metadata = await lstat(lock.path).catch(() => fail("RECOVERY_DRILL_SOURCE_LOCK_RELEASE_FAILED"));
  if (metadata.isSymbolicLink() || !metadata.isDirectory() || metadata.dev !== lock.dev || metadata.ino !== lock.ino) {
    fail("RECOVERY_DRILL_SOURCE_LOCK_RELEASE_FAILED");
  }
  await rmdir(lock.path).catch(() => fail("RECOVERY_DRILL_SOURCE_LOCK_RELEASE_FAILED"));
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  if (interruptRequested && !cleanupInProgress) throw interruptedError();
  const abortController = new AbortController();
  activeStreamAbort = abortController;
  let timedOut = false;
  let bytesRead = 0;
  const timeout = setTimeout(() => {
    timedOut = true;
    abortController.abort();
  }, SUBPROCESS_TIMEOUT_MS);
  timeout.unref();
  try {
    for await (const chunk of createReadStream(filePath, { highWaterMark: 1024 * 1024, signal: abortController.signal })) {
      if (interruptRequested && !cleanupInProgress) throw interruptedError();
      bytesRead += chunk.length;
      if (!Number.isSafeInteger(bytesRead) || bytesRead > MAX_DATABASE_DUMP_BYTES) fail("RECOVERY_DRILL_PG_DUMP_TOO_LARGE");
      hash.update(chunk);
    }
  } catch (error) {
    if (interruptRequested && !cleanupInProgress) throw interruptedError();
    if (timedOut) fail("RECOVERY_DRILL_PG_DUMP_HASH_TIMEOUT");
    if (error instanceof RecoveryDrillError) throw error;
    fail("RECOVERY_DRILL_PG_DUMP_HASH_FAILED");
  } finally {
    clearTimeout(timeout);
    if (activeStreamAbort === abortController) activeStreamAbort = null;
  }
  return hash.digest("hex");
}

function parseJson<T>(value: string, code: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    fail(code);
  }
}

function sourceComposeArgs(sourceProject: string, composeFile: string): string[] {
  return ["compose", "--project-name", sourceProject, "--file", composeFile];
}

function validateResourceName(value: string): string {
  if (!SAFE_NAME.test(value)) fail("RECOVERY_DRILL_RESOURCE_NAME_INVALID");
  return value;
}

function readDockerLabels(value: unknown): DockerLabels {
  if (value === null || value === undefined) return Object.freeze({});
  if (typeof value !== "object" || Array.isArray(value)) fail("RECOVERY_DRILL_RESOURCE_METADATA_INVALID");
  const labels: Record<string, string | null> = {};
  for (const [key, label] of Object.entries(value)) {
    if (typeof label !== "string" && label !== null) fail("RECOVERY_DRILL_RESOURCE_METADATA_INVALID");
    labels[key] = label;
  }
  return Object.freeze(labels);
}

function sortedLabels(labels: DockerLabels): DockerLabels {
  return Object.freeze(Object.fromEntries(Object.entries(labels).sort(([left], [right]) => left.localeCompare(right))));
}

function optionalResourceString(resource: DockerResource, key: string): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(resource, key)) return undefined;
  const value = resource[key];
  if (typeof value !== "string" || value.length === 0) fail("RECOVERY_DRILL_RESOURCE_METADATA_INVALID");
  return value;
}

function resourceFingerprint(resource: DockerResource): string {
  if (typeof resource.Name !== "string" || !SAFE_NAME.test(resource.Name)
    || typeof resource.Driver !== "string" || typeof resource.Scope !== "string") fail("RECOVERY_DRILL_RESOURCE_METADATA_INVALID");
  const createdAt = optionalResourceString(resource, "CreatedAt");
  const created = optionalResourceString(resource, "Created");
  if (createdAt === undefined && created === undefined) fail("RECOVERY_DRILL_RESOURCE_METADATA_INVALID");
  const mountpoint = optionalResourceString(resource, "Mountpoint") ?? null;
  const labels = readDockerLabels(resource.Labels);
  const ownershipLabels = Object.fromEntries(Object.entries(labels).filter(([key]) => key.startsWith(`${RECOVERY_DRILL_LABEL_PREFIX}.`)));
  return sha256(canonicalJson({
    name: resource.Name,
    driver: resource.Driver,
    scope: resource.Scope,
    createdAt,
    created,
    mountpoint,
    labels: sortedLabels(ownershipLabels),
  }));
}

function hasOwnership(labels: DockerLabels, projectName: string, drillId: string, purpose: string): boolean {
  return labels[RECOVERY_DRILL_ID_LABEL] === drillId
    && labels[RECOVERY_DRILL_PROJECT_LABEL] === projectName
    && labels[RECOVERY_DRILL_PURPOSE_LABEL] === purpose;
}

function registerHelper(projectName: string, drillId: string, purpose: string, trackedHelpers: TrackedHelper[]): TrackedHelper {
  if (!/^[a-z][a-z0-9-]{2,32}$/u.test(purpose)) fail("RECOVERY_DRILL_HELPER_PURPOSE_INVALID");
  const helper = Object.freeze({
    id: null,
    name: validateResourceName(`ai-project-os-r17-h-${randomBytes(16).toString("hex")}`),
    purpose,
    projectName,
    drillId,
  });
  trackedHelpers.push(helper);
  return helper;
}

function helperContainerName(resource: DockerResource): string {
  if (typeof resource.Name !== "string" || resource.Name.length < 2 || !resource.Name.startsWith("/")) fail("RECOVERY_DRILL_HELPER_METADATA_INVALID");
  return resource.Name.slice(1);
}

async function trackHelper(helper: TrackedHelper, trackedHelpers: TrackedHelper[], environment: NodeJS.ProcessEnv): Promise<void> {
  const resource = await inspectDockerResource("container", helper.name, environment, "RECOVERY_DRILL_HELPER_INSPECT_FAILED");
  if (resource === null) return;
  const id = immutableContainerId(resource);
  const labels = containerLabels(resource);
  if (helperContainerName(resource) !== helper.name || !hasOwnership(labels, helper.projectName, helper.drillId, helper.purpose)) fail("RECOVERY_DRILL_HELPER_OWNERSHIP_INVALID");
  const tracked = Object.freeze({ ...helper, id });
  const index = trackedHelpers.indexOf(helper);
  if (index >= 0) trackedHelpers[index] = tracked;
}

function missingDockerResource(result: ProcessResult): boolean {
  return /no such (?:object|container|volume|network)|(?:not found|does not exist)/iu.test(`${result.stdout}\n${result.stderr}`);
}

async function inspectDockerResource(
  kind: "container" | "volume" | "network",
  name: string,
  environment: NodeJS.ProcessEnv,
  failureCode = "RECOVERY_DRILL_RESOURCE_INSPECT_FAILED",
): Promise<Record<string, unknown> | null> {
  const result = await runProcess("docker", ["inspect", "--type", kind, "--format", "{{json .}}", name], environment);
  if (result.code !== 0) {
    if (missingDockerResource(result)) return null;
    fail(failureCode);
  }
  const payload = result.stdout.trim();
  if (payload.length === 0 || payload.includes("\n")) fail("RECOVERY_DRILL_RESOURCE_METADATA_INVALID");
  const resource = parseJson<Record<string, unknown>>(payload, "RECOVERY_DRILL_RESOURCE_METADATA_INVALID");
  return resource;
}

async function preflightProjectResources(
  projectName: string,
  targetVolumes: Readonly<Record<string, string>>,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const containers = await runProcess("docker", ["ps", "-aq", "--filter", `label=com.docker.compose.project=${projectName}`], environment);
  if (containers.code !== 0) fail("RECOVERY_DRILL_RESOURCE_PREFLIGHT_FAILED");
  if (containers.stdout.trim().length > 0) fail("RECOVERY_DRILL_RESOURCE_COLLISION");
  const networkName = validateResourceName(`${projectName}_default`);
  if (await inspectDockerResource("network", networkName, environment) !== null) fail("RECOVERY_DRILL_RESOURCE_COLLISION");
  for (const volume of Object.values(targetVolumes)) {
    if (await inspectDockerResource("volume", volume, environment) !== null) fail("RECOVERY_DRILL_RESOURCE_COLLISION");
  }
}

async function reserveVolume(
  name: string,
  purpose: string,
  projectName: string,
  drillId: string,
  environment: NodeJS.ProcessEnv,
  trackedVolumes: OwnedVolume[],
): Promise<OwnedVolume> {
  validateResourceName(name);
  if (!/^[a-z][a-z0-9-]{2,32}$/u.test(purpose)) fail("RECOVERY_DRILL_RESOURCE_PURPOSE_INVALID");
  const labels = [
    "--label", `${RECOVERY_DRILL_ID_LABEL}=${drillId}`,
    "--label", `${RECOVERY_DRILL_PROJECT_LABEL}=${projectName}`,
    "--label", `${RECOVERY_DRILL_PURPOSE_LABEL}=${purpose}`,
    // Pre-reserved volumes must also look like Compose-owned resources so the
    // generated override can reuse them without an external, untracked volume.
    "--label", `com.docker.compose.project=${projectName}`,
    "--label", `com.docker.compose.volume=ai_project_os_${purpose}`,
  ];
  // Register before invoking Docker to close the ambiguous client window: a
  // daemon may create the exact resource even if the client is interrupted
  // before receiving a successful response. Cleanup still re-proves labels
  // and fingerprint before deleting it.
  const provisional = Object.freeze({ name, purpose, projectName, drillId, fingerprint: null });
  trackedVolumes.push(provisional);
  await requireProcess("docker", ["volume", "create", ...labels, name], environment, "RECOVERY_DRILL_VOLUME_RESERVATION_FAILED");

  // If inspection or fingerprinting fails, the finally block can re-inspect
  // this exact name and still remove it only when its drill labels are intact.
  const resource = await inspectDockerResource("volume", name, environment, "RECOVERY_DRILL_VOLUME_RESERVATION_INSPECT_FAILED");
  if (resource === null || resource.Name !== name || !hasOwnership(readDockerLabels(resource.Labels), projectName, drillId, purpose)) fail("RECOVERY_DRILL_VOLUME_OWNERSHIP_INVALID");
  const tracked = Object.freeze({ ...provisional, fingerprint: resourceFingerprint(resource) });
  const trackedIndex = trackedVolumes.indexOf(provisional);
  if (trackedIndex >= 0) trackedVolumes[trackedIndex] = tracked;
  return tracked;
}

async function reserveNetwork(
  projectName: string,
  drillId: string,
  environment: NodeJS.ProcessEnv,
  onCreated: (network: TrackedNetwork) => void,
): Promise<TrackedNetwork> {
  const name = validateResourceName(`${projectName}_default`);
  // Register before invoking Docker for the same interrupted-client window
  // as volumes. The callback is synchronous and therefore finally-visible
  // before the daemon can create anything.
  const provisional = Object.freeze({ id: null, name, fingerprint: null, projectName, drillId });
  onCreated(provisional);
  await requireProcess("docker", [
    "network", "create", "--driver", "bridge",
    "--label", `${RECOVERY_DRILL_ID_LABEL}=${drillId}`,
    "--label", `${RECOVERY_DRILL_PROJECT_LABEL}=${projectName}`,
    "--label", `${RECOVERY_DRILL_PURPOSE_LABEL}=default-network`,
    "--label", `com.docker.compose.project=${projectName}`,
    "--label", "com.docker.compose.network=default",
    name,
  ], environment, "RECOVERY_DRILL_NETWORK_RESERVATION_FAILED");
  // The name and labels are known immediately after create. Keep the
  // provisional record visible while inspecting the generated ID or
  // fingerprint, so an inspection failure cannot orphan the network.
  const resource = await inspectDockerResource("network", name, environment, "RECOVERY_DRILL_NETWORK_RESERVATION_INSPECT_FAILED");
  if (resource === null || typeof resource.Id !== "string" || !/^[a-f0-9]{12,64}$/u.test(resource.Id) || resource.Name !== name || !hasOwnership(readDockerLabels(resource.Labels), projectName, drillId, "default-network")) fail("RECOVERY_DRILL_NETWORK_OWNERSHIP_INVALID");
  const tracked = Object.freeze({ id: resource.Id, name, fingerprint: resourceFingerprint(resource), projectName, drillId });
  onCreated(tracked);
  return tracked;
}

async function trackComposeNetwork(projectName: string, drillId: string, environment: NodeJS.ProcessEnv): Promise<TrackedNetwork> {
  const networkName = validateResourceName(`${projectName}_default`);
  const resource = await inspectDockerResource("network", networkName, environment, "RECOVERY_DRILL_NETWORK_INSPECT_FAILED");
  if (resource === null || typeof resource.Id !== "string" || !/^[a-f0-9]{12,64}$/u.test(resource.Id) || resource.Name !== networkName) fail("RECOVERY_DRILL_NETWORK_OWNERSHIP_INVALID");
  const labels = readDockerLabels(resource.Labels);
  if (!hasOwnership(labels, projectName, drillId, "default-network")) fail("RECOVERY_DRILL_NETWORK_OWNERSHIP_INVALID");
  return Object.freeze({ id: resource.Id, name: networkName, fingerprint: resourceFingerprint(resource), projectName, drillId });
}

function immutableContainerId(resource: DockerResource): string {
  if (typeof resource.Id !== "string" || !/^[a-f0-9]{64}$/u.test(resource.Id)) fail("RECOVERY_DRILL_SERVICE_OWNERSHIP_INVALID");
  return resource.Id;
}

function containerLabels(resource: DockerResource): DockerLabels {
  const config = resource.Config;
  if (typeof config !== "object" || config === null || Array.isArray(config)) fail("RECOVERY_DRILL_SERVICE_METADATA_INVALID");
  return readDockerLabels((config as { Labels?: unknown }).Labels);
}

function composeServiceFromLabels(labels: DockerLabels, projectName: string, drillId: string): ComposeService {
  const purpose = labels[RECOVERY_DRILL_PURPOSE_LABEL];
  if (labels["com.docker.compose.project"] !== projectName
    || !hasOwnership(labels, projectName, drillId, typeof purpose === "string" ? purpose : "")
    || typeof purpose !== "string"
    || !composeServices.includes(purpose as ComposeService)
    || labels["com.docker.compose.service"] !== purpose) {
    fail("RECOVERY_DRILL_SERVICE_OWNERSHIP_INVALID");
  }
  return purpose as ComposeService;
}

async function listProjectContainerIds(projectName: string, environment: NodeJS.ProcessEnv): Promise<string[]> {
  const result = await requireProcess("docker", ["ps", "-aq", "--filter", `label=com.docker.compose.project=${projectName}`], environment, "RECOVERY_DRILL_SERVICE_TRACK_FAILED");
  const containers = result.stdout.trim().split(/\s+/u).filter((value) => value.length > 0);
  if (containers.some((value) => !/^[a-f0-9]{12,64}$/u.test(value))) fail("RECOVERY_DRILL_SERVICE_CONTAINER_INVALID");
  return containers;
}

async function enumerateProjectContainers(
  projectName: string,
  drillId: string,
  environment: NodeJS.ProcessEnv,
  trackedContainers: TrackedContainer[],
): Promise<ReadonlyMap<ComposeService, readonly string[]>> {
  const byService = new Map<ComposeService, string[]>();
  const containers = await listProjectContainerIds(projectName, environment);
  for (const container of containers) {
    const resource = await inspectDockerResource("container", container, environment, "RECOVERY_DRILL_SERVICE_INSPECT_FAILED");
    if (resource === null) fail("RECOVERY_DRILL_SERVICE_OWNERSHIP_INVALID");
    const id = immutableContainerId(resource);
    const service = composeServiceFromLabels(containerLabels(resource), projectName, drillId);
    const current = byService.get(service) ?? [];
    if (current.includes(id)) fail("RECOVERY_DRILL_SERVICE_CONTAINER_INVALID");
    current.push(id);
    byService.set(service, current);
    if (!trackedContainers.some((tracked) => tracked.id === id)) trackedContainers.push(Object.freeze({ id, service, projectName, drillId }));
  }
  return byService;
}

async function composeUpAndTrack(
  compose: readonly string[],
  environment: NodeJS.ProcessEnv,
  projectName: string,
  drillId: string,
  services: readonly ComposeService[],
  trackedContainers: TrackedContainer[],
  failureCode: string,
  forceRecreate = false,
): Promise<ReadonlyMap<ComposeService, string>> {
  const upArgs = [...compose, "up", "-d", ...(forceRecreate ? ["--force-recreate"] : []), "--no-build", ...services];
  const result = await runProcess("docker", upArgs, environment);
  const byService = await enumerateProjectContainers(projectName, drillId, environment, trackedContainers);
  if (result.code !== 0) fail(SAFE_ERROR_CODE.test(failureCode) ? failureCode : "RECOVERY_DRILL_COMMAND_FAILED");
  const ids = new Map<ComposeService, string>();
  for (const service of services) {
    const matches = byService.get(service) ?? [];
    if (matches.length !== 1) fail("RECOVERY_DRILL_SERVICE_CONTAINER_INVALID");
    ids.set(service, matches[0]!);
  }
  return ids;
}

function sourceVolumeMountName(resource: DockerResource, destination: string): string {
  const mounts = resource.Mounts;
  if (!Array.isArray(mounts)) fail("RECOVERY_DRILL_SOURCE_MOUNTS_INVALID");
  const matches = mounts.filter((mount): mount is Record<string, unknown> => {
    if (typeof mount !== "object" || mount === null || Array.isArray(mount)) return false;
    return mount.Destination === destination;
  });
  if (matches.length !== 1) fail("RECOVERY_DRILL_SOURCE_VOLUME_MOUNT_INVALID");
  const mount = matches[0]!;
  if (mount.Type !== "volume" || typeof mount.Name !== "string") fail("RECOVERY_DRILL_SOURCE_VOLUME_MOUNT_INVALID");
  return validateResourceName(mount.Name);
}

async function sourceDataVolumes(
  appContainer: string,
  workerContainer: string,
  environment: NodeJS.ProcessEnv,
): Promise<SourceDataVolumes> {
  const readServiceVolumes = async (container: string): Promise<SourceDataVolumes> => {
    const resource = await inspectDockerResource("container", container, environment, "RECOVERY_DRILL_SOURCE_MOUNTS_INSPECT_FAILED");
    if (resource === null) fail("RECOVERY_DRILL_SOURCE_MOUNTS_INVALID");
    const state = resource.State;
    if (typeof state !== "object" || state === null || Array.isArray(state) || (state as { Status?: unknown }).Status !== "running") {
      fail("RECOVERY_DRILL_SOURCE_SERVICE_NOT_RUNNING");
    }
    return Object.freeze({
      secrets: sourceVolumeMountName(resource, SOURCE_SECRETS_DESTINATION),
      uploads: sourceVolumeMountName(resource, SOURCE_UPLOADS_DESTINATION),
    });
  };
  const appVolumes = await readServiceVolumes(appContainer);
  const workerVolumes = await readServiceVolumes(workerContainer);
  if (appVolumes.secrets !== workerVolumes.secrets || appVolumes.uploads !== workerVolumes.uploads) {
    fail("RECOVERY_DRILL_SOURCE_VOLUME_MISMATCH");
  }
  return appVolumes;
}

async function sourceWriterPreflight(
  sourceProject: string,
  appContainer: string,
  workerContainer: string,
  environment: NodeJS.ProcessEnv,
): Promise<readonly SourceWriter[]> {
  const readWriter = async (id: string, service: SourceWriter["service"]): Promise<SourceWriter> => {
    const resource = await inspectDockerResource("container", id, environment, "RECOVERY_DRILL_SOURCE_WRITER_INSPECT_FAILED");
    if (resource === null || resource.Id !== id) fail("RECOVERY_DRILL_SOURCE_WRITER_OWNERSHIP_INVALID");
    const labels = containerLabels(resource);
    if (labels["com.docker.compose.project"] !== sourceProject || labels["com.docker.compose.service"] !== service) {
      fail("RECOVERY_DRILL_SOURCE_WRITER_OWNERSHIP_INVALID");
    }
    const state = resource.State;
    if (typeof state !== "object" || state === null || Array.isArray(state)
      || (state as { Running?: unknown }).Running !== true
      || (state as { Paused?: unknown }).Paused !== false) {
      fail("RECOVERY_DRILL_SOURCE_WRITER_STATE_INVALID");
    }
    return Object.freeze({ id, service });
  };
  return Object.freeze([
    await readWriter(appContainer, "app"),
    await readWriter(workerContainer, "worker"),
  ]);
}

const sourceServiceQueryCodes: Readonly<Record<SourceService, string>> = Object.freeze({
  "principal-bootstrap": "RECOVERY_DRILL_SOURCE_PRINCIPAL_BOOTSTRAP_QUERY_FAILED",
  migrate: "RECOVERY_DRILL_SOURCE_MIGRATE_QUERY_FAILED",
  reconcile: "RECOVERY_DRILL_SOURCE_RECONCILE_QUERY_FAILED",
  app: "RECOVERY_DRILL_SOURCE_APP_QUERY_FAILED",
  worker: "RECOVERY_DRILL_SOURCE_WORKER_QUERY_FAILED",
});

async function sourceServiceContainer(composeFile: string, sourceProject: string, environment: NodeJS.ProcessEnv, service: SourceService): Promise<SourceServiceContainer> {
  const result = await requireProcess("docker", [...sourceComposeArgs(sourceProject, composeFile), "ps", "--all", "--quiet", service], environment, sourceServiceQueryCodes[service]);
  const containers = result.stdout.trim().split(/\s+/u).filter((value) => value.length > 0);
  if (containers.length !== 1 || !/^[a-f0-9]{12,64}$/u.test(containers[0] ?? "")) fail("RECOVERY_DRILL_SOURCE_SERVICE_CONTAINER_INVALID");
  const requestedContainer = containers[0]!;
  const container = (await requireProcess("docker", ["inspect", "--format", "{{.Id}}", requestedContainer], environment, "RECOVERY_DRILL_SOURCE_SERVICE_ID_QUERY_FAILED")).stdout.trim();
  if (!/^[a-f0-9]{64}$/u.test(container)) fail("RECOVERY_DRILL_SOURCE_SERVICE_CONTAINER_INVALID");
  const image = (await requireProcess("docker", ["inspect", "--format", "{{.Image}}", container], environment, "RECOVERY_DRILL_SOURCE_SERVICE_IMAGE_QUERY_FAILED")).stdout.trim();
  if (!/^sha256:[0-9a-f]{64}$/u.test(image)) fail("RECOVERY_DRILL_SOURCE_SERVICE_IMAGE_INVALID");
  return Object.freeze({ container, image });
}

function principalDiagnostics(output: string): string[] {
  const boundedOutput = output.slice(0, ONE_SHOT_DIAGNOSTIC_BYTES);
  return [...new Set(boundedOutput.match(DATABASE_PRINCIPAL_DIAGNOSTIC) ?? [])].slice(0, ONE_SHOT_DIAGNOSTIC_LIMIT);
}

function emitPrincipalDiagnostics(output: string): void {
  for (const diagnostic of principalDiagnostics(output)) process.stderr.write(`diagnostic=${diagnostic}\n`);
}

async function emitOneShotPrincipalDiagnostics(container: string, environment: NodeJS.ProcessEnv): Promise<void> {
  try {
    const logs = await runProcess("docker", ["logs", "--tail", ONE_SHOT_LOG_TAIL_LINES, container], environment);
    emitPrincipalDiagnostics(`${logs.stdout}\n${logs.stderr}`);
  } catch {
    // Preserve the original one-shot failure when a best-effort diagnostic is unavailable.
  }
}

async function waitForOneShotSuccess(compose: readonly string[], environment: NodeJS.ProcessEnv, service: OneShotService, timeoutMs = ONE_SHOT_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (interruptRequested && !cleanupInProgress) throw interruptedError();
    const result = await requireProcess("docker", [...compose, "ps", "--all", "--quiet", service], environment, "RECOVERY_DRILL_ONE_SHOT_QUERY_FAILED");
    const containers = result.stdout.trim().split(/\s+/u).filter((value) => value.length > 0);
    if (containers.length > 1 || (containers[0] !== undefined && !/^[a-f0-9]{12,64}$/u.test(containers[0]))) fail("RECOVERY_DRILL_ONE_SHOT_CONTAINER_INVALID");
    const container = containers[0];
    if (container !== undefined) {
      const state = await requireProcess("docker", ["inspect", "--format", "{{.State.Status}} {{.State.ExitCode}}", container], environment, "RECOVERY_DRILL_ONE_SHOT_INSPECT_FAILED");
      const [status, exitCode, extra] = state.stdout.trim().split(/\s+/u);
      if (extra !== undefined || (status !== "created" && status !== "running" && status !== "restarting" && status !== "exited" && status !== "dead") || !/^\d+$/u.test(exitCode ?? "")) fail("RECOVERY_DRILL_ONE_SHOT_STATE_INVALID");
      if (status === "exited") {
        if (exitCode === "0") return;
        await emitOneShotPrincipalDiagnostics(container, environment);
        fail(oneShotFailureCodes[service]);
      }
      if (status === "dead") {
        await emitOneShotPrincipalDiagnostics(container, environment);
        fail(oneShotFailureCodes[service]);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(1_000, Math.max(1, deadline - Date.now()))));
  }
  fail("RECOVERY_DRILL_ONE_SHOT_TIMEOUT");
}

async function sourceQuery(composeFile: string, sourceProject: string, environment: NodeJS.ProcessEnv, query: string): Promise<string> {
  const result = await requireProcess("docker", [...sourceComposeArgs(sourceProject, composeFile), "exec", "--no-TTY", "postgres", "psql", "-U", CLUSTER_ADMIN_ROLE, "-d", DATABASE_NAME, "-At", "-v", "ON_ERROR_STOP=1", "-c", query], environment, "RECOVERY_DRILL_SOURCE_QUERY_FAILED");
  const value = result.stdout.trim();
  if (value.length === 0 || value.includes("\n")) fail("RECOVERY_DRILL_SOURCE_QUERY_INVALID");
  return value;
}

async function isolatedQuery(compose: readonly string[], environment: NodeJS.ProcessEnv, query: string): Promise<string> {
  const result = await requireProcess("docker", [...compose, "exec", "--no-TTY", "postgres", "psql", "-U", CLUSTER_ADMIN_ROLE, "-d", DATABASE_NAME, "-At", "-v", "ON_ERROR_STOP=1", "-c", query], environment, "RECOVERY_DRILL_ISOLATED_QUERY_FAILED");
  const value = result.stdout.trim();
  if (value.length === 0 || value.includes("\n")) fail("RECOVERY_DRILL_ISOLATED_QUERY_INVALID");
  return value;
}

async function readSecurityCounts(query: (statement: string) => Promise<string>): Promise<RecoveryDrillSecurityCounts> {
  const value = await query(`SELECT json_build_object('users',(SELECT COUNT(*) FROM "AppUser"),'workspaces',(SELECT COUNT(*) FROM "Workspace"),'projects',(SELECT COUNT(*) FROM "Project"),'credentials',(SELECT COUNT(*) FROM "ExternalCredential"),'projectAssets',(SELECT COUNT(*) FROM "ProjectAsset"))::text`);
  const counts = parseJson<Record<string, unknown>>(value, "RECOVERY_DRILL_SECURITY_COUNTS_INVALID");
  const result = {
    users: counts.users,
    workspaces: counts.workspaces,
    projects: counts.projects,
    credentials: counts.credentials,
    projectAssets: counts.projectAssets,
  };
  for (const count of Object.values(result)) if (typeof count !== "number" && typeof count !== "string") fail("RECOVERY_DRILL_SECURITY_COUNTS_INVALID");
  const normalized = Object.fromEntries(Object.entries(result).map(([key, count]) => [key, Number(count)])) as RecoveryDrillSecurityCounts;
  if (Object.values(normalized).some((count) => !Number.isSafeInteger(count) || count < 0)) fail("RECOVERY_DRILL_SECURITY_COUNTS_INVALID");
  return Object.freeze(normalized);
}

const volumeManifestScript = String.raw`
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const root = "/volume";
const MAX_ENTRIES = ${MAX_VOLUME_MANIFEST_ENTRIES};
const MAX_PATH_BYTES = ${MAX_VOLUME_MANIFEST_PATH_BYTES};
const MAX_FILE_BYTES = ${MAX_VOLUME_MANIFEST_FILE_BYTES};
const MAX_TOTAL_BYTES = ${MAX_VOLUME_MANIFEST_TOTAL_BYTES};
const MAX_METADATA_BYTES = ${MAX_VOLUME_MANIFEST_METADATA_BYTES};
const manifestHash = crypto.createHash("sha256");
let entryCount = 0;
let totalBytes = 0;
let maxPathBytes = 0;
let masterKey = null;
async function fileDigest(absolute) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fsSync.createReadStream(absolute, { highWaterMark: 1024 * 1024 })) hash.update(chunk);
  return hash.digest("hex");
}
function checkEntryPath(relative) {
  const relativePath = relative.replaceAll(path.sep, "/");
  const pathBytes = Buffer.byteLength(relativePath, "utf8");
  if (pathBytes === 0 || pathBytes > MAX_PATH_BYTES) throw new Error("VOLUME_PATH_TOO_LONG");
  entryCount += 1;
  maxPathBytes = Math.max(maxPathBytes, pathBytes);
  if (entryCount > MAX_ENTRIES) throw new Error("VOLUME_BUDGET_EXCEEDED");
  return { relativePath, pathBytes };
}
function recordEntry(entry, pathBytes) {
  const entryJson = JSON.stringify(entry);
  if (Buffer.byteLength(entryJson, "utf8") > MAX_METADATA_BYTES) throw new Error("VOLUME_METADATA_TOO_LARGE");
  manifestHash.update(entryJson);
  manifestHash.update("\n");
  return entryJson;
}
async function walk(relative) {
  const absolute = path.join(root, relative);
  const metadata = await fs.lstat(absolute);
  const { relativePath, pathBytes } = checkEntryPath(relative);
  if (metadata.isSymbolicLink()) throw new Error("VOLUME_SYMLINK");
  if (metadata.isDirectory()) {
    recordEntry({ path: relativePath, type: "directory", bytes: 0, mode: metadata.mode & 0o777, digest: null }, pathBytes);
    const directory = await fs.opendir(absolute);
    for await (const child of directory) await walk(path.join(relative, child.name));
    return;
  }
  if (!metadata.isFile() || !Number.isSafeInteger(metadata.size) || metadata.size < 0 || metadata.size > MAX_FILE_BYTES) throw new Error("VOLUME_ENTRY_INVALID");
  totalBytes += metadata.size;
  if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_TOTAL_BYTES) throw new Error("VOLUME_BUDGET_EXCEEDED");
  const digest = await fileDigest(absolute);
  const entry = { path: relativePath, type: "file", bytes: metadata.size, mode: metadata.mode & 0o777, digest };
  recordEntry(entry, pathBytes);
  if (relativePath === "master.key") masterKey = { present: true, mode: entry.mode, secure: (entry.mode & 0o077) === 0 };
}
(async () => {
  const rootMetadata = await fs.lstat(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) throw new Error("VOLUME_ROOT_INVALID");
  const rootDirectory = await fs.opendir(root);
  for await (const child of rootDirectory) await walk(child.name);
  const safeMasterKey = masterKey ?? { present: false, mode: null, secure: false };
  const summary = { entryCount, totalBytes, maxPathBytes, masterKey: safeMasterKey };
  const summaryJson = JSON.stringify(summary);
  if (Buffer.byteLength(summaryJson, "utf8") > MAX_METADATA_BYTES) throw new Error("VOLUME_METADATA_TOO_LARGE");
  manifestHash.update(summaryJson);
  process.stdout.write(JSON.stringify({ ...summary, digest: manifestHash.digest("hex") }));
})().catch(() => process.exit(42));
`;

async function volumeManifest(
  image: string,
  volume: string,
  environment: NodeJS.ProcessEnv,
  projectName: string,
  drillId: string,
  purpose: string,
  trackedHelpers: TrackedHelper[],
): Promise<VolumeManifest> {
  const helper = registerHelper(projectName, drillId, purpose, trackedHelpers);
  const result = await runWithInputText("docker", [
    "run", "--interactive", "--name", helper.name,
    "--label", `${RECOVERY_DRILL_ID_LABEL}=${drillId}`,
    "--label", `${RECOVERY_DRILL_PROJECT_LABEL}=${projectName}`,
    "--label", `${RECOVERY_DRILL_PURPOSE_LABEL}=${purpose}`,
    "--user", "0:0", "--mount", `type=volume,source=${volume},target=/volume,readonly`, image, "node", "-",
  ], volumeManifestScript, environment);
  await trackHelper(helper, trackedHelpers, environment);
  if (result.code !== 0) fail("RECOVERY_DRILL_VOLUME_MANIFEST_INVALID");
  if (Buffer.byteLength(result.stdout, "utf8") > MAX_VOLUME_MANIFEST_OUTPUT_BYTES) fail("RECOVERY_DRILL_VOLUME_MANIFEST_TOO_LARGE");
  const manifest = parseJson<VolumeManifest>(result.stdout, "RECOVERY_DRILL_VOLUME_MANIFEST_INVALID");
  if (!/^[0-9a-f]{64}$/u.test(manifest.digest)
    || !Number.isSafeInteger(manifest.entryCount) || manifest.entryCount < 0 || manifest.entryCount > MAX_VOLUME_MANIFEST_ENTRIES
    || !Number.isSafeInteger(manifest.totalBytes) || manifest.totalBytes < 0 || manifest.totalBytes > MAX_VOLUME_MANIFEST_TOTAL_BYTES
    || !Number.isSafeInteger(manifest.maxPathBytes) || manifest.maxPathBytes < 0 || manifest.maxPathBytes > MAX_VOLUME_MANIFEST_PATH_BYTES
    || typeof manifest.masterKey?.present !== "boolean" || (manifest.masterKey.mode !== null && (!Number.isSafeInteger(manifest.masterKey.mode) || manifest.masterKey.mode < 0 || manifest.masterKey.mode > 0o777))
    || typeof manifest.masterKey?.secure !== "boolean") fail("RECOVERY_DRILL_VOLUME_MANIFEST_INVALID");
  return manifest;
}

function verifyMasterKeyVolume(source: VolumeManifest, target: VolumeManifest, credentialCount: number): void {
  if (!Number.isSafeInteger(credentialCount) || credentialCount < 0) fail("RECOVERY_DRILL_SECURITY_COUNTS_INVALID");
  if (source.digest !== target.digest) fail("RECOVERY_DRILL_MASTER_KEY_VOLUME_MISMATCH");
  if (credentialCount > 0) {
    if (!source.masterKey.present || !source.masterKey.secure) fail("RECOVERY_DRILL_SOURCE_MASTER_KEY_INVALID");
    if (!target.masterKey.present || !target.masterKey.secure) fail("RECOVERY_DRILL_MASTER_KEY_VOLUME_MISMATCH");
    return;
  }
  if (source.masterKey.present !== target.masterKey.present) fail("RECOVERY_DRILL_MASTER_KEY_VOLUME_MISMATCH");
  if (source.masterKey.present && (!source.masterKey.secure || !target.masterKey.secure)) fail("RECOVERY_DRILL_MASTER_KEY_VOLUME_MISMATCH");
}

async function verifyCredentialRecovery(
  compose: readonly string[],
  environment: NodeJS.ProcessEnv,
  credentialCount: number,
  masterKeyPresent: boolean,
): Promise<void> {
  if (!Number.isSafeInteger(credentialCount) || credentialCount < 0) fail("RECOVERY_DRILL_SECURITY_COUNTS_INVALID");
  if (typeof masterKeyPresent !== "boolean") fail("RECOVERY_DRILL_MASTER_KEY_VOLUME_MISMATCH");
  if (credentialCount === 0 && !masterKeyPresent) return;
  const expectedOutput = masterKeyPresent ? CREDENTIAL_RECOVERY_SUCCESS : CREDENTIAL_RECOVERY_ZERO;
  const result = await runProcess("docker", [
    ...compose, "exec", "--no-TTY", "--user", "node", "--env", `EXPECT_MASTER_KEY=${masterKeyPresent ? "1" : "0"}`,
    "worker", "node", "node_modules/tsx/dist/cli.mjs", "scripts/recovery-drill-credential-check.ts",
  ], environment);
  if (result.code !== 0 || result.stdout.trim() !== expectedOutput || Buffer.byteLength(result.stdout, "utf8") > 1_024 || Buffer.byteLength(result.stderr, "utf8") > 1_024) fail("RECOVERY_DRILL_CREDENTIAL_RECOVERY_FAILED");
}

const volumeCopyScript = String.raw`
const fs = require("node:fs/promises");
const path = require("node:path");
const source = "/source";
const target = "/target";
const MAX_ENTRIES = ${MAX_VOLUME_MANIFEST_ENTRIES};
const MAX_PATH_BYTES = ${MAX_VOLUME_MANIFEST_PATH_BYTES};
const MAX_FILE_BYTES = ${MAX_VOLUME_MANIFEST_FILE_BYTES};
const MAX_TOTAL_BYTES = ${MAX_VOLUME_MANIFEST_TOTAL_BYTES};
let entryCount = 0;
let totalBytes = 0;
function checkEntry(relative, metadata) {
  const relativePath = relative.replaceAll(path.sep, "/");
  const pathBytes = Buffer.byteLength(relativePath, "utf8");
  if (pathBytes === 0 || pathBytes > MAX_PATH_BYTES) throw new Error("VOLUME_PATH_TOO_LONG");
  entryCount += 1;
  if (entryCount > MAX_ENTRIES) throw new Error("VOLUME_BUDGET_EXCEEDED");
  if (metadata.isFile()) {
    if (!Number.isSafeInteger(metadata.size) || metadata.size < 0 || metadata.size > MAX_FILE_BYTES) throw new Error("VOLUME_ENTRY_INVALID");
    totalBytes += metadata.size;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_TOTAL_BYTES) throw new Error("VOLUME_BUDGET_EXCEEDED");
  }
}
async function copy(relative) {
  const from = path.join(source, relative);
  const to = path.join(target, relative);
  const metadata = await fs.lstat(from);
  checkEntry(relative, metadata);
  if (metadata.isSymbolicLink()) throw new Error("VOLUME_SYMLINK");
  if (metadata.isDirectory()) {
    await fs.mkdir(to, { recursive: true, mode: metadata.mode & 0o777 });
    const directory = await fs.opendir(from);
    for await (const child of directory) await copy(path.join(relative, child.name));
    await fs.chmod(to, metadata.mode & 0o777);
    await fs.chown(to, metadata.uid, metadata.gid).catch(() => undefined);
    return;
  }
  if (!metadata.isFile()) throw new Error("VOLUME_ENTRY_INVALID");
  await fs.mkdir(path.dirname(to), { recursive: true, mode: 0o700 });
  await fs.copyFile(from, to);
  await fs.chmod(to, metadata.mode & 0o777);
  await fs.chown(to, metadata.uid, metadata.gid).catch(() => undefined);
}
(async () => {
  const sourceMetadata = await fs.lstat(source);
  await fs.mkdir(target, { recursive: true, mode: 0o700 });
  const targetMetadata = await fs.lstat(target);
  if (sourceMetadata.isSymbolicLink() || !sourceMetadata.isDirectory() || targetMetadata.isSymbolicLink() || !targetMetadata.isDirectory()) throw new Error("VOLUME_ROOT_INVALID");
  const sourceDirectory = await fs.opendir(source);
  for await (const child of sourceDirectory) await copy(child.name);
})().catch(() => process.exit(43));
`;

async function copyVolume(
  image: string,
  source: string,
  target: string,
  environment: NodeJS.ProcessEnv,
  projectName: string,
  drillId: string,
  purpose: string,
  trackedHelpers: TrackedHelper[],
): Promise<void> {
  const helper = registerHelper(projectName, drillId, purpose, trackedHelpers);
  const result = await runWithInputText("docker", [
    "run", "--interactive", "--name", helper.name,
    "--label", `${RECOVERY_DRILL_ID_LABEL}=${drillId}`,
    "--label", `${RECOVERY_DRILL_PROJECT_LABEL}=${projectName}`,
    "--label", `${RECOVERY_DRILL_PURPOSE_LABEL}=${purpose}`,
    "--user", "0:0", "--mount", `type=volume,source=${source},target=/source,readonly`, "--mount", `type=volume,source=${target},target=/target`, image, "node", "-",
  ], volumeCopyScript, environment);
  await trackHelper(helper, trackedHelpers, environment);
  if (result.code !== 0) fail("RECOVERY_DRILL_VOLUME_COPY_FAILED");
}

async function waitForHealthy(compose: readonly string[], environment: NodeJS.ProcessEnv, port: number): Promise<void> {
  let last = "not_checked";
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (interruptRequested && !cleanupInProgress) throw interruptedError();
    const app = await runProcess("docker", [...compose, "ps", "--quiet", "app"], environment);
    const worker = await runProcess("docker", [...compose, "ps", "--quiet", "worker"], environment);
    if (app.code === 0 && worker.code === 0 && app.stdout.trim() && worker.stdout.trim()) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2_000) });
        const body = await response.json() as { status?: unknown; database?: unknown; worker?: { status?: unknown } };
        last = `${response.status}:${String(body.status)}:${String(body.database)}:${String(body.worker?.status)}`;
        if (response.ok && body.status === "ok" && body.database === "up" && body.worker?.status === "up") return;
      } catch {
        last = "health_unavailable";
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  fail(`RECOVERY_DRILL_HEALTH_TIMEOUT_${last.replaceAll(/[^A-Za-z0-9_:-]/gu, "_").slice(0, 32)}`);
}

async function sourceAppPort(compose: readonly string[], environment: NodeJS.ProcessEnv): Promise<number> {
  const result = await requireProcess("docker", [...compose, "port", "app", "3000"], environment, "RECOVERY_DRILL_SOURCE_APP_PORT_QUERY_FAILED");
  const match = result.stdout.trim().match(/:(\d+)$/u);
  const port = Number(match?.[1]);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535) fail("RECOVERY_DRILL_SOURCE_APP_PORT_INVALID");
  return port;
}

async function pauseSource(writers: readonly SourceWriter[], environment: NodeJS.ProcessEnv): Promise<void> {
  // Pause only the preflight-unpaused app and worker immutable IDs.
  await requireProcess("docker", ["pause", ...writers.map((writer) => writer.id)], environment, "RECOVERY_DRILL_SOURCE_PAUSE_FAILED");
}

async function readSourceWriterPausedState(writer: SourceWriter, sourceProject: string, environment: NodeJS.ProcessEnv): Promise<boolean> {
  const resource = await inspectDockerResource("container", writer.id, environment, "RECOVERY_DRILL_SOURCE_RESUME_INSPECT_FAILED");
  if (resource === null || resource.Id !== writer.id) fail("RECOVERY_DRILL_SOURCE_WRITER_OWNERSHIP_INVALID");
  const labels = containerLabels(resource);
  if (labels["com.docker.compose.project"] !== sourceProject || labels["com.docker.compose.service"] !== writer.service) fail("RECOVERY_DRILL_SOURCE_WRITER_OWNERSHIP_INVALID");
  const state = resource.State;
  if (typeof state !== "object" || state === null || Array.isArray(state)
    || (state as { Running?: unknown }).Running !== true
    || typeof (state as { Paused?: unknown }).Paused !== "boolean") {
    fail("RECOVERY_DRILL_SOURCE_WRITER_STATE_INVALID");
  }
  return (state as { Paused: boolean }).Paused;
}

async function resumeSource(writers: readonly SourceWriter[], sourceProject: string, environment: NodeJS.ProcessEnv): Promise<void> {
  const pausedIds: string[] = [];
  for (const writer of writers) {
    if (await readSourceWriterPausedState(writer, sourceProject, environment)) pausedIds.push(writer.id);
  }
  if (pausedIds.length > 0) await requireProcess("docker", ["unpause", ...pausedIds], environment, "RECOVERY_DRILL_SOURCE_RESUME_FAILED");
}

async function writeRecoveryEvidence(statusRoot: string, drill: PublicRecoveryDrill): Promise<void> {
  await mkdir(statusRoot, { recursive: true, mode: 0o755 });
  const rootMetadata = await lstat(statusRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) fail("RECOVERY_DRILL_STATUS_ROOT_INVALID");
  const target = join(statusRoot, "recovery-drill.json");
  try {
    const targetMetadata = await lstat(target);
    if (targetMetadata.isSymbolicLink() || !targetMetadata.isFile()) fail("RECOVERY_DRILL_STATUS_TARGET_INVALID");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") fail("RECOVERY_DRILL_STATUS_TARGET_INVALID");
  }
  const temporary = join(statusRoot, `.recovery-drill-${drill.drillId}.tmp`);
  const payload = JSON.stringify(drill);
  if (Buffer.byteLength(payload, "utf8") > MAX_DRILL_STATUS_BYTES) fail("RECOVERY_DRILL_STATUS_TOO_LARGE");
  const handle = await open(temporary, "wx", 0o644);
  try {
    await handle.writeFile(payload, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, target).catch(() => fail("RECOVERY_DRILL_STATUS_PUBLISH_FAILED"));
}

async function cleanup(
  trackedContainers: readonly TrackedContainer[],
  trackedHelpers: readonly TrackedHelper[],
  ownedVolumes: readonly OwnedVolume[],
  trackedNetwork: TrackedNetwork | null,
  projectName: string,
  drillId: string,
  temporaryDirectory: string,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const errors: string[] = [];
  const trackedById = new Map(trackedContainers.map((tracked) => [tracked.id, tracked]));
  const cleanupContainers = [...trackedContainers];
  try {
    // Compose may create or recreate dependencies that were not explicitly
    // requested. Inspect every project container before deleting anything so
    // an untracked or relabeled container is never removed by this drill.
    const currentContainers = await listProjectContainerIds(projectName, environment);
    for (const container of currentContainers) {
      const resource = await inspectDockerResource("container", container, environment, "RECOVERY_DRILL_CONTAINER_CLEANUP_INSPECT_FAILED");
      if (resource === null) continue;
      let id: string;
      try {
        id = immutableContainerId(resource);
      } catch {
        errors.push("container-metadata");
        continue;
      }
      const tracked = trackedById.get(id);
      if (tracked === undefined) {
        // `docker compose up` can create a container and then lose the client
        // acknowledgement to a timeout or signal. Adopt only containers whose
        // random project, drill, purpose, and Compose service labels all prove
        // that they belong to this exact run.
        try {
          const service = composeServiceFromLabels(containerLabels(resource), projectName, drillId);
          const recovered = Object.freeze({ id, service, projectName, drillId });
          trackedById.set(id, recovered);
          cleanupContainers.push(recovered);
        } catch {
          errors.push("container-untracked");
        }
        continue;
      }
      try {
        const service = composeServiceFromLabels(containerLabels(resource), projectName, drillId);
        if (service !== tracked.service) errors.push("container-ownership");
      } catch {
        errors.push("container-ownership");
      }
    }
  } catch {
    errors.push("container-enumeration");
  }
  for (const helper of trackedHelpers) {
    let resource: Record<string, unknown> | null;
    try {
      resource = await inspectDockerResource("container", helper.id ?? helper.name, environment, "RECOVERY_DRILL_HELPER_CLEANUP_INSPECT_FAILED");
    } catch {
      errors.push("helper-inspect");
      continue;
    }
    if (resource === null) continue;
    let id: string;
    let labels: DockerLabels;
    try {
      id = immutableContainerId(resource);
      labels = containerLabels(resource);
      if (helperContainerName(resource) !== helper.name || (helper.id !== null && id !== helper.id) || !hasOwnership(labels, helper.projectName, helper.drillId, helper.purpose)) {
        errors.push("helper-ownership");
        continue;
      }
    } catch {
      errors.push("helper-metadata");
      continue;
    }
    // `rm -f` is the bounded stop-and-remove operation for a helper; it is
    // deliberately issued only after exact name, ID, and drill-label checks.
    const removed = await runProcess("docker", ["rm", "-f", id], environment);
    if (removed.code !== 0 && !missingDockerResource(removed)) errors.push("helper");
  }
  for (const tracked of cleanupContainers) {
    let resource: Record<string, unknown> | null;
    try {
      resource = await inspectDockerResource("container", tracked.id, environment, "RECOVERY_DRILL_CONTAINER_CLEANUP_INSPECT_FAILED");
    } catch {
      errors.push("container-inspect");
      continue;
    }
    if (resource === null) continue;
    let labels: DockerLabels;
    try {
      const config = resource.Config;
      labels = typeof config === "object" && config !== null && !Array.isArray(config)
        ? readDockerLabels((config as { Labels?: unknown }).Labels)
        : Object.freeze({}) as DockerLabels;
    } catch {
      errors.push("container-metadata");
      continue;
    }
    if (resource.Id !== tracked.id || labels["com.docker.compose.project"] !== tracked.projectName || !hasOwnership(labels, tracked.projectName, tracked.drillId, tracked.service)) {
      errors.push("container-ownership");
      continue;
    }
    const removed = await runProcess("docker", ["rm", "-f", tracked.id], environment);
    if (removed.code !== 0 && !missingDockerResource(removed)) errors.push("container");
  }
  for (const owned of ownedVolumes) {
    let resource: Record<string, unknown> | null;
    try {
      resource = await inspectDockerResource("volume", owned.name, environment, "RECOVERY_DRILL_VOLUME_CLEANUP_INSPECT_FAILED");
    } catch {
      errors.push("volume-inspect");
      continue;
    }
    if (resource === null) continue;
    let labels: DockerLabels;
    let fingerprint: string;
    try {
      labels = readDockerLabels(resource.Labels);
      fingerprint = resourceFingerprint(resource);
    } catch {
      errors.push("volume-metadata");
      continue;
    }
    if (resource.Name !== owned.name || !hasOwnership(labels, owned.projectName, owned.drillId, owned.purpose) || (owned.fingerprint !== null && fingerprint !== owned.fingerprint)) {
      errors.push("volume-ownership");
      continue;
    }
    const removed = await runProcess("docker", ["volume", "rm", owned.name], environment);
    if (removed.code !== 0 && !missingDockerResource(removed)) errors.push("volume");
  }
  if (trackedNetwork !== null) {
    let resource: Record<string, unknown> | null;
    try {
      resource = await inspectDockerResource("network", trackedNetwork.id ?? trackedNetwork.name, environment, "RECOVERY_DRILL_NETWORK_CLEANUP_INSPECT_FAILED");
    } catch {
      errors.push("network-inspect");
      resource = null;
    }
    if (resource !== null) {
      let labels: DockerLabels;
      let fingerprint: string;
      let metadataValid = true;
      try {
        labels = readDockerLabels(resource.Labels);
        fingerprint = resourceFingerprint(resource);
      } catch {
        errors.push("network-metadata");
        metadataValid = false;
        labels = Object.freeze({});
        fingerprint = "";
      }
      const resourceId = typeof resource.Id === "string" ? resource.Id : null;
      const validResourceId = resourceId !== null && /^[a-f0-9]{12,64}$/u.test(resourceId);
      if (!metadataValid || !validResourceId || resourceId === null || (trackedNetwork.id !== null && resourceId !== trackedNetwork.id) || resource.Name !== trackedNetwork.name || !hasOwnership(labels, trackedNetwork.projectName, trackedNetwork.drillId, "default-network") || (trackedNetwork.fingerprint !== null && fingerprint !== trackedNetwork.fingerprint)) {
        errors.push("network-ownership");
      } else {
        const removed = await runProcess("docker", ["network", "rm", resourceId], environment);
        if (removed.code !== 0 && !missingDockerResource(removed)) errors.push("network");
      }
    }
  }
  await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => errors.push("temporary-directory"));
  if (errors.length > 0) fail("RECOVERY_DRILL_CLEANUP_FAILED");
}

function failedChecks(): RecoveryDrillCheckResults {
  return { pgRestore: "failed", migrationLedger: "failed", securityCounts: "failed", masterKeyVolume: "failed", uploadsManifest: "failed", serviceHealth: "failed" };
}

function checkedCounts(value: RecoveryDrillSecurityCounts | null): RecoveryDrillSecurityCounts {
  return value ?? { users: 0, workspaces: 0, projects: 0, credentials: 0, projectAssets: 0 };
}

function failedEvidence(
  drillId: string,
  startedAt: string,
  completedAt: string,
  errorCode: string,
  sourceArtifact: PublicRecoveryDrill["sourceArtifact"],
  migrationCount: number,
  securityCounts: RecoveryDrillSecurityCounts,
  cleanupErrorCode: string | null = null,
): PublicRecoveryDrill {
  return {
    formatVersion: 1,
    drillId,
    environment: "local",
    scope: "isolated-local",
    status: "failed",
    startedAt,
    completedAt,
    durationSeconds: Math.max(0, Math.floor((Date.parse(completedAt) - Date.parse(startedAt)) / 1_000)),
    sourceArtifact,
    checks: failedChecks(),
    validationSha256: null,
    migrationCount,
    securityCounts,
    errorCode: SAFE_ERROR_CODE.test(errorCode) ? errorCode : "RECOVERY_DRILL_FAILED",
    cleanupErrorCode: cleanupErrorCode === null
      ? null
      : SAFE_ERROR_CODE.test(cleanupErrorCode) ? cleanupErrorCode : "RECOVERY_DRILL_CLEANUP_FAILED",
  };
}

async function main(): Promise<void> {
  const options = parseArguments(readCliArguments());
  const started = new Date();
  const startedAt = started.toISOString();
  const drillId = `${timestampName(started)}-${randomBytes(16).toString("hex")}`;
  const projectName = validateResourceName(`ai-project-os-r17-${randomBytes(16).toString("hex")}`);
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "ai-project-os-recovery-drill-"));
  installInterruptHandlers();
  let sourceLock: SourceLock;
  try {
    sourceLock = await acquireSourceLock(options.sourceProject);
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
    removeInterruptHandlers();
    throw error;
  }
  const dumpPath = join(temporaryDirectory, "postgres.dump");
  const overrideFile = join(temporaryDirectory, "compose.override.yaml");
  const envFile = join(temporaryDirectory, "compose.env");
  const sourceEnvironment = sourceComposeEnvironment(process.env);
  const dockerEnvironment = dockerClientEnvironment(process.env);
  let isolatedCompose: string[] = [];
  let sourceCompose: string[] = [];
  let sourceAppPortValue: number | null = null;
  let sourcePaused = false;
  let sourceWriters: readonly SourceWriter[] = [];
  const ownedVolumes: OwnedVolume[] = [];
  const trackedContainers: TrackedContainer[] = [];
  const trackedHelpers: TrackedHelper[] = [];
  let trackedNetwork: TrackedNetwork | null = null;
  let evidence: PublicRecoveryDrill | null = null;
  let sourceArtifact: PublicRecoveryDrill["sourceArtifact"] = null;
  let migrationCount = 0;
  let securityCounts: RecoveryDrillSecurityCounts | null = null;
  let primaryFailureCode: string | null = null;
  let cleanupFailureCode: string | null = null;
  try {
    await requireLocalDockerContext(dockerEnvironment);
    await requireProcess("docker", ["version", "--format", "{{.Server.Version}}"], sourceEnvironment);
    sourceCompose = sourceComposeArgs(options.sourceProject, options.composeFile);
    const sourceServices = Object.freeze({
      principalBootstrap: await sourceServiceContainer(options.composeFile, options.sourceProject, sourceEnvironment, "principal-bootstrap"),
      migrate: await sourceServiceContainer(options.composeFile, options.sourceProject, sourceEnvironment, "migrate"),
      reconcile: await sourceServiceContainer(options.composeFile, options.sourceProject, sourceEnvironment, "reconcile"),
      app: await sourceServiceContainer(options.composeFile, options.sourceProject, sourceEnvironment, "app"),
      worker: await sourceServiceContainer(options.composeFile, options.sourceProject, sourceEnvironment, "worker"),
    });
    const sourceVolumes = await sourceDataVolumes(sourceServices.app.container, sourceServices.worker.container, sourceEnvironment);
    sourceWriters = await sourceWriterPreflight(options.sourceProject, sourceServices.app.container, sourceServices.worker.container, sourceEnvironment);
    const source = sourceServices.app;
    sourceAppPortValue = await sourceAppPort(sourceCompose, sourceEnvironment);
    const appPort = await reserveLoopbackPort();
    const targetVolumeNames = {
      pgdata: validateResourceName(`${projectName}-pgdata`),
      secrets: validateResourceName(`${projectName}-secrets`),
      uploads: validateResourceName(`${projectName}-uploads`),
    };
    if (Object.values(targetVolumeNames).some((volume) => volume === sourceVolumes.secrets || volume === sourceVolumes.uploads)) fail("RECOVERY_DRILL_SOURCE_TARGET_VOLUME_COLLISION");
    await preflightProjectResources(projectName, targetVolumeNames, dockerEnvironment);
    await reserveVolume(targetVolumeNames.pgdata, "pgdata", projectName, drillId, dockerEnvironment, ownedVolumes);
    await reserveVolume(targetVolumeNames.secrets, "secrets", projectName, drillId, dockerEnvironment, ownedVolumes);
    await reserveVolume(targetVolumeNames.uploads, "uploads", projectName, drillId, dockerEnvironment, ownedVolumes);
    trackedNetwork = await reserveNetwork(projectName, drillId, dockerEnvironment, (network) => { trackedNetwork = network; });
    const isolatedEnvironment: NodeJS.ProcessEnv = {
      ...dockerEnvironment,
      POSTGRES_USER: CLUSTER_ADMIN_ROLE,
      POSTGRES_CLUSTER_ADMIN_PASSWORD: `drill_cluster_${randomBytes(24).toString("hex")}`,
      POSTGRES_MIGRATOR_PASSWORD: `drill_migrator_${randomBytes(24).toString("hex")}`,
      POSTGRES_RUNTIME_PASSWORD: `drill_runtime_${randomBytes(24).toString("hex")}`,
      POSTGRES_ENTITLEMENT_WRITER_PASSWORD: `drill_writer_${randomBytes(24).toString("hex")}`,
      POSTGRES_ENTITLEMENT_INVENTORY_READER_PASSWORD: `drill_inventory_${randomBytes(24).toString("hex")}`,
      POSTGRES_DB: DATABASE_NAME,
      POSTGRES_PORT: String(await reserveLoopbackPort()),
      APP_PORT: String(appPort),
      AI_PROJECT_OS_PGDATA_VOLUME: targetVolumeNames.pgdata,
      AI_PROJECT_OS_SECRETS_VOLUME: targetVolumeNames.secrets,
      AI_PROJECT_OS_UPLOADS_VOLUME: targetVolumeNames.uploads,
      DATABASE_PRINCIPAL_LEGACY_BOOTSTRAP_URL: "",
      AI_PROJECT_OS_PUBLIC_ORIGIN: `http://127.0.0.1:${appPort}`,
    };
    await writeFile(envFile, Object.entries(isolatedEnvironment).filter(([key, value]) => ["POSTGRES_USER", "POSTGRES_CLUSTER_ADMIN_PASSWORD", "POSTGRES_MIGRATOR_PASSWORD", "POSTGRES_RUNTIME_PASSWORD", "POSTGRES_ENTITLEMENT_WRITER_PASSWORD", "POSTGRES_ENTITLEMENT_INVENTORY_READER_PASSWORD", "POSTGRES_DB", "POSTGRES_PORT", "APP_PORT", "AI_PROJECT_OS_PGDATA_VOLUME", "AI_PROJECT_OS_SECRETS_VOLUME", "AI_PROJECT_OS_UPLOADS_VOLUME", "DATABASE_PRINCIPAL_LEGACY_BOOTSTRAP_URL", "AI_PROJECT_OS_PUBLIC_ORIGIN"].includes(key) && value !== undefined).map(([key, value]) => `${key}=${value}`).join("\n") + "\n", { mode: 0o600 });
    const ownershipLabels = (indent: string, purpose: string): string[] => [
      `${indent}labels:`,
      `${indent}  "${RECOVERY_DRILL_ID_LABEL}": "${drillId}"`,
      `${indent}  "${RECOVERY_DRILL_PROJECT_LABEL}": "${projectName}"`,
      `${indent}  "${RECOVERY_DRILL_PURPOSE_LABEL}": "${purpose}"`,
    ];
    await writeFile(overrideFile, [
      "services:",
      "  postgres:",
      "    ports:",
      `      - "127.0.0.1:${isolatedEnvironment.POSTGRES_PORT}:5432"`,
      ...ownershipLabels("    ", "postgres"),
      "  principal-bootstrap:",
      `    image: "${sourceServices.principalBootstrap.image}"`,
      ...ownershipLabels("    ", "principal-bootstrap"),
      "  migrate:",
      `    image: "${sourceServices.migrate.image}"`,
      ...ownershipLabels("    ", "migrate"),
      "  reconcile:",
      `    image: "${sourceServices.reconcile.image}"`,
      ...ownershipLabels("    ", "reconcile"),
      "  app:",
      `    image: "${sourceServices.app.image}"`,
      "    ports:",
      `      - "127.0.0.1:${appPort}:3000"`,
      ...ownershipLabels("    ", "app"),
      "  worker:",
      `    image: "${sourceServices.worker.image}"`,
      "    command: [\"node\", \"node_modules/tsx/dist/cli.mjs\", \"scripts/recovery-drill-worker.ts\"]",
      ...ownershipLabels("    ", "worker"),
      "volumes:",
      "  ai_project_os_pgdata:",
      `    name: "${targetVolumeNames.pgdata}"`,
      ...ownershipLabels("    ", "pgdata"),
      "  ai_project_os_secrets:",
      `    name: "${targetVolumeNames.secrets}"`,
      ...ownershipLabels("    ", "secrets"),
      "  ai_project_os_uploads:",
      `    name: "${targetVolumeNames.uploads}"`,
      ...ownershipLabels("    ", "uploads"),
      "networks:",
      "  default:",
      ...ownershipLabels("    ", "default-network"),
      "",
    ].join("\n"), { mode: 0o600 });
    isolatedCompose = ["compose", "--env-file", envFile, "--project-name", projectName, "--file", options.composeFile, "--file", overrideFile];

    // Bring up the isolated database before pausing the formal writers. The
    // pause window is reserved for the consistent source snapshot only.
    const postgresIds = await composeUpAndTrack(isolatedCompose, isolatedEnvironment, projectName, drillId, ["postgres"], trackedContainers, "RECOVERY_DRILL_ISOLATED_POSTGRES_START_FAILED");
    const composedNetwork = await trackComposeNetwork(projectName, drillId, isolatedEnvironment);
    if (trackedNetwork === null || composedNetwork.id !== trackedNetwork.id || composedNetwork.fingerprint !== trackedNetwork.fingerprint) fail("RECOVERY_DRILL_NETWORK_OWNERSHIP_INVALID");
    trackedNetwork = composedNetwork;
    const isolatedPostgresContainerId = postgresIds.get("postgres");
    if (isolatedPostgresContainerId === undefined) fail("RECOVERY_DRILL_ISOLATED_POSTGRES_CONTAINER_INVALID");
    await composeUpAndTrack(isolatedCompose, isolatedEnvironment, projectName, drillId, ["principal-bootstrap"], trackedContainers, "RECOVERY_DRILL_PRINCIPAL_BOOTSTRAP_FAILED");
    await waitForOneShotSuccess(isolatedCompose, isolatedEnvironment, "principal-bootstrap");

    // Treat a pause attempt as a state transition before invoking Docker:
    // Compose can report a partial failure after pausing one writer. The
    // finally block must still attempt to unpause both source writers.
    sourcePaused = true;
    await pauseSource(sourceWriters, sourceEnvironment);
    await runToFile("docker", [...sourceCompose, "exec", "--no-TTY", "postgres", "pg_dump", "-U", CLUSTER_ADMIN_ROLE, "-d", DATABASE_NAME, "--format=custom"], dumpPath, sourceEnvironment);
    const dumpStat = await lstat(dumpPath);
    if (!dumpStat.isFile() || dumpStat.size < 16 || dumpStat.size > MAX_DATABASE_DUMP_BYTES) fail("RECOVERY_DRILL_PG_DUMP_INVALID");
    const dumpDigest = await sha256File(dumpPath);
    const sourceSecrets = await volumeManifest(source.image, sourceVolumes.secrets, sourceEnvironment, projectName, drillId, "volume-manifest-secrets", trackedHelpers);
    const sourceUploads = await volumeManifest(source.image, sourceVolumes.uploads, sourceEnvironment, projectName, drillId, "volume-manifest-uploads", trackedHelpers);
    const sourceSnapshotSha256 = sha256(canonicalJson({ dumpSha256: dumpDigest, secretsDigest: sourceSecrets.digest, uploadsDigest: sourceUploads.digest }));
    sourceArtifact = { name: `${timestampName(started)}-manual.${randomBytes(3).toString("hex")}`, sha256: sourceSnapshotSha256, kind: "local-consistent-snapshot" };
    const sourceCounts = await readSecurityCounts((query) => sourceQuery(options.composeFile, options.sourceProject, sourceEnvironment, query));
    securityCounts = sourceCounts;
    const sourceMigrations = Number(await sourceQuery(options.composeFile, options.sourceProject, sourceEnvironment, `SELECT COUNT(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`));
    if (!Number.isSafeInteger(sourceMigrations) || sourceMigrations < 1) fail("RECOVERY_DRILL_SOURCE_MIGRATION_COUNT_INVALID");
    migrationCount = sourceMigrations;
    const image = source.image;
    await copyVolume(image, sourceVolumes.secrets, targetVolumeNames.secrets, isolatedEnvironment, projectName, drillId, "volume-copy-secrets", trackedHelpers);
    await copyVolume(image, sourceVolumes.uploads, targetVolumeNames.uploads, isolatedEnvironment, projectName, drillId, "volume-copy-uploads", trackedHelpers);
    const targetSecrets = await volumeManifest(image, targetVolumeNames.secrets, isolatedEnvironment, projectName, drillId, "volume-manifest-target-secrets", trackedHelpers);
    const targetUploads = await volumeManifest(image, targetVolumeNames.uploads, isolatedEnvironment, projectName, drillId, "volume-manifest-target-uploads", trackedHelpers);
    verifyMasterKeyVolume(sourceSecrets, targetSecrets, sourceCounts.credentials);
    if (targetUploads.digest !== sourceUploads.digest) fail("RECOVERY_DRILL_UPLOADS_MANIFEST_MISMATCH");
    await resumeSource(sourceWriters, options.sourceProject, sourceEnvironment);
    sourcePaused = false;
    if (sourceAppPortValue === null) fail("RECOVERY_DRILL_SOURCE_APP_PORT_INVALID");
    await waitForHealthy(sourceCompose, sourceEnvironment, sourceAppPortValue);
    await requireProcess("docker", ["cp", dumpPath, `${isolatedPostgresContainerId}:${DUMP_CONTAINER_PATH}`], isolatedEnvironment, "RECOVERY_DRILL_DUMP_COPY_FAILED");
    await requireProcess("docker", ["exec", isolatedPostgresContainerId, "chmod", "600", DUMP_CONTAINER_PATH], isolatedEnvironment, "RECOVERY_DRILL_DUMP_PERMISSIONS_FAILED");
    await requireProcess("docker", ["exec", isolatedPostgresContainerId, "pg_restore", "--list", DUMP_CONTAINER_PATH], isolatedEnvironment, "RECOVERY_DRILL_PG_RESTORE_LIST_FAILED");
    await requireProcess("docker", ["exec", isolatedPostgresContainerId, "pg_restore", "--clean", "--if-exists", "--no-privileges", "-U", CLUSTER_ADMIN_ROLE, "-d", DATABASE_NAME, DUMP_CONTAINER_PATH], isolatedEnvironment, "RECOVERY_DRILL_PG_RESTORE_FAILED");
    await composeUpAndTrack(isolatedCompose, isolatedEnvironment, projectName, drillId, ["principal-bootstrap"], trackedContainers, "RECOVERY_DRILL_PRINCIPAL_BOOTSTRAP_RESTORE_FAILED", true);
    await waitForOneShotSuccess(isolatedCompose, isolatedEnvironment, "principal-bootstrap");
    const restoredMigrations = Number(await isolatedQuery(isolatedCompose, isolatedEnvironment, `SELECT COUNT(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`));
    if (restoredMigrations !== sourceMigrations) fail("RECOVERY_DRILL_MIGRATION_LEDGER_MISMATCH");
    const restoredCounts = await readSecurityCounts((query) => isolatedQuery(isolatedCompose, isolatedEnvironment, query));
    if (canonicalJson(restoredCounts) !== canonicalJson(sourceCounts)) fail("RECOVERY_DRILL_SECURITY_COUNTS_MISMATCH");
    await composeUpAndTrack(isolatedCompose, isolatedEnvironment, projectName, drillId, ["migrate"], trackedContainers, "RECOVERY_DRILL_MIGRATE_FAILED", true);
    await waitForOneShotSuccess(isolatedCompose, isolatedEnvironment, "migrate");
    await composeUpAndTrack(isolatedCompose, isolatedEnvironment, projectName, drillId, ["reconcile"], trackedContainers, "RECOVERY_DRILL_RECONCILE_FAILED", true);
    await waitForOneShotSuccess(isolatedCompose, isolatedEnvironment, "reconcile");
    await composeUpAndTrack(isolatedCompose, isolatedEnvironment, projectName, drillId, ["app", "worker"], trackedContainers, "RECOVERY_DRILL_APP_WORKER_START_FAILED", true);
    await waitForHealthy(isolatedCompose, isolatedEnvironment, appPort);
    await verifyCredentialRecovery(isolatedCompose, isolatedEnvironment, sourceCounts.credentials, targetSecrets.masterKey.present);
    const completedAt = new Date().toISOString();
    const checks: RecoveryDrillCheckResults = { pgRestore: "passed", migrationLedger: "passed", securityCounts: "passed", masterKeyVolume: "passed", uploadsManifest: "passed", serviceHealth: "passed" };
    const validationSha256 = sha256(canonicalJson({ checks, migrationCount: sourceMigrations, securityCounts: sourceCounts, secretsDigest: sourceSecrets.digest, uploadsDigest: sourceUploads.digest }));
    evidence = {
      formatVersion: 1,
      drillId,
      environment: "local",
      scope: "isolated-local",
      status: "verified",
      startedAt,
      completedAt,
      durationSeconds: Math.max(0, Math.floor((Date.parse(completedAt) - Date.parse(startedAt)) / 1_000)),
      sourceArtifact,
      checks,
      validationSha256,
      migrationCount: sourceMigrations,
      securityCounts: sourceCounts,
      errorCode: null,
    };
  } catch (error) {
    const code = error instanceof RecoveryDrillError && SAFE_ERROR_CODE.test(error.code) ? error.code : "RECOVERY_DRILL_FAILED";
    primaryFailureCode = code;
    evidence = failedEvidence(drillId, startedAt, new Date().toISOString(), code, sourceArtifact, migrationCount, checkedCounts(securityCounts));
  } finally {
    cleanupInProgress = true;
    if (sourcePaused) {
      try {
        await resumeSource(sourceWriters, options.sourceProject, sourceEnvironment);
        sourcePaused = false;
        if (sourceAppPortValue !== null) await waitForHealthy(sourceCompose, sourceEnvironment, sourceAppPortValue);
      } catch {
        cleanupFailureCode ??= "RECOVERY_DRILL_SOURCE_RESUME_FAILED";
      }
    }
    if (isolatedCompose.length > 0 || ownedVolumes.length > 0 || trackedContainers.length > 0 || trackedHelpers.length > 0 || trackedNetwork !== null) {
      try {
        await cleanup(trackedContainers, trackedHelpers, ownedVolumes, trackedNetwork, projectName, drillId, temporaryDirectory, dockerEnvironment);
      } catch (error) {
        cleanupFailureCode ??= error instanceof RecoveryDrillError && SAFE_ERROR_CODE.test(error.code) ? error.code : "RECOVERY_DRILL_CLEANUP_FAILED";
      }
    } else {
      await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => { cleanupFailureCode ??= "RECOVERY_DRILL_CLEANUP_FAILED"; });
    }
    try {
      await releaseSourceLock(sourceLock);
    } catch {
      cleanupFailureCode ??= "RECOVERY_DRILL_SOURCE_LOCK_RELEASE_FAILED";
    }
    removeInterruptHandlers();
  }
  if (cleanupFailureCode !== null) {
    const finalPrimaryFailureCode = primaryFailureCode ?? "RECOVERY_DRILL_CLEANUP_ONLY";
    evidence = failedEvidence(drillId, startedAt, new Date().toISOString(), finalPrimaryFailureCode, sourceArtifact, migrationCount, checkedCounts(securityCounts), cleanupFailureCode);
  }
  if (evidence === null) {
    primaryFailureCode ??= "RECOVERY_DRILL_FAILED";
    evidence = failedEvidence(drillId, startedAt, new Date().toISOString(), primaryFailureCode, sourceArtifact, migrationCount, checkedCounts(securityCounts), null);
  }
  if (!options.noPublish) await writeRecoveryEvidence(options.statusRoot, evidence);
  process.stdout.write(`${evidence.status === "verified" ? "RECOVERY_DRILL_VERIFIED" : "RECOVERY_DRILL_FAILED"} drill=${evidence.drillId}\n`);
  if (evidence.status !== "verified") {
    process.stderr.write(`primary=${primaryFailureCode ?? "RECOVERY_DRILL_CLEANUP_ONLY"} cleanup=${cleanupFailureCode ?? "none"}\n`);
    process.exitCode = 1;
  }
}

void main().catch((error: unknown) => {
  const code = error instanceof RecoveryDrillError && SAFE_ERROR_CODE.test(error.code) ? error.code : "RECOVERY_DRILL_FAILED";
  process.stderr.write(`primary=${code} cleanup=none\n`);
  process.exitCode = 1;
});
