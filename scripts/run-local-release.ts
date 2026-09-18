import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  assertSafeCandidateIdentity,
  createCandidateIdentity,
  evaluateCandidateReadiness,
  parseComposePs,
  readCoherentVersion,
  type CandidateIdentity,
} from "./local-release-candidate";
import { DEFAULT_WORKSPACE_ID } from "../src/lib/workspace-constants";

type ProcessResult = { code: number; stdout: string; stderr: string };

type LocalReleaseSummary = {
  version: string;
  revision: string;
  releaseEligible: boolean;
  migrations: number;
  health: "ok";
  restartPersistence: "ok";
  businessDataPersistence: "ok";
  businessDataPersistenceEvidence: {
    entities: readonly string[];
    rows: number;
    snapshotSha256: string;
    prePostEqual: true;
  };
  workerRestart: "ok";
  cleanup: "verified";
};

type JsonRecord = Record<string, unknown>;

type BusinessFixture = {
  adminId: string;
  ownerId: string;
  ownerUsername: string;
  workspaceId: string;
  projectId: string;
  projectSlug: string;
  sourceId: string;
  sourceContentHash: string;
  sourceContentLength: number;
};

type WorkerRuntimeEvidence = {
  name: string;
  status: string;
  instanceIdHash: string;
  startedEpochMs: number;
  heartbeatEpochMs: number;
  consecutiveFailures: number;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const WORKER_HEARTBEAT_STALE_AFTER_MS = 45_000;
const BUSINESS_SNAPSHOT_ENTITIES = Object.freeze([
  "AppUser",
  "Workspace",
  "WorkspaceMembership",
  "Project",
  "ProjectMembership",
  "ProjectSource",
] as const);

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value: unknown, code: string): JsonRecord {
  if (!isRecord(value)) throw new Error(code);
  return value;
}

function requireString(value: unknown, code: string): string {
  if (typeof value !== "string") throw new Error(code);
  return value;
}

function requireUuid(value: unknown, code: string): string {
  const result = requireString(value, code);
  if (!UUID_PATTERN.test(result)) throw new Error(code);
  return result.toLowerCase();
}

function sqlLiteral(value: string): string {
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(value)) throw new Error("LOCAL_RELEASE_SQL_LITERAL_INVALID");
  return `'${value.replaceAll("'", "''")}'`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("LOCAL_RELEASE_SNAPSHOT_CANONICALIZATION_FAILED");
  return serialized;
}

function snapshotSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function snapshotRows(snapshot: JsonRecord, entity: string): JsonRecord[] {
  const value = snapshot[entity];
  if (!Array.isArray(value) || value.length !== 1 || value.some((row) => !isRecord(row))) {
    throw new Error(`LOCAL_RELEASE_BUSINESS_SNAPSHOT_CARDINALITY:${entity}:${Array.isArray(value) ? value.length : "invalid"}`);
  }
  return value as JsonRecord[];
}

function assertSnapshotRecordShape(record: JsonRecord, expectedKeys: readonly string[], entity: string): void {
  const actualKeys = Object.keys(record).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(sortedExpectedKeys)) {
    throw new Error(`LOCAL_RELEASE_BUSINESS_SNAPSHOT_SHAPE:${entity}`);
  }
}

function assertSnapshotField(record: JsonRecord, field: string, expected: unknown, entity: string): void {
  if (record[field] !== expected) throw new Error(`LOCAL_RELEASE_BUSINESS_SNAPSHOT_FIELD:${entity}:${field}`);
}

function assertBusinessSnapshot(value: unknown, fixture: BusinessFixture): JsonRecord {
  const snapshot = requireRecord(value, "LOCAL_RELEASE_BUSINESS_SNAPSHOT_INVALID");
  const expectedEntities = [...BUSINESS_SNAPSHOT_ENTITIES].sort();
  if (JSON.stringify(Object.keys(snapshot).sort()) !== JSON.stringify(expectedEntities)) {
    throw new Error("LOCAL_RELEASE_BUSINESS_SNAPSHOT_ENTITIES_INVALID");
  }

  const appUser = snapshotRows(snapshot, "AppUser")[0]!;
  assertSnapshotRecordShape(appUser, ["accountAccessVersion", "createdAt", "disabledAt", "displayName", "email", "emailVerifiedAt", "id", "role", "updatedAt", "username"], "AppUser");
  assertSnapshotField(appUser, "id", fixture.ownerId, "AppUser");
  assertSnapshotField(appUser, "username", fixture.ownerUsername, "AppUser");
  assertSnapshotField(appUser, "role", "user", "AppUser");
  assertSnapshotField(appUser, "email", null, "AppUser");
  assertSnapshotField(appUser, "displayName", null, "AppUser");
  assertSnapshotField(appUser, "emailVerifiedAt", null, "AppUser");
  assertSnapshotField(appUser, "disabledAt", null, "AppUser");
  assertSnapshotField(appUser, "accountAccessVersion", 1, "AppUser");

  const workspace = snapshotRows(snapshot, "Workspace")[0]!;
  assertSnapshotRecordShape(workspace, ["createdAt", "createdById", "id", "name", "slug", "updatedAt"], "Workspace");
  assertSnapshotField(workspace, "id", fixture.workspaceId, "Workspace");
  assertSnapshotField(workspace, "createdById", fixture.ownerId, "Workspace");
  assertSnapshotField(workspace, "name", "默认工作区", "Workspace");
  assertSnapshotField(workspace, "slug", "default", "Workspace");

  const workspaceMembership = snapshotRows(snapshot, "WorkspaceMembership")[0]!;
  assertSnapshotRecordShape(workspaceMembership, ["accessState", "createdAt", "id", "role", "updatedAt", "userId", "workspaceId"], "WorkspaceMembership");
  assertSnapshotField(workspaceMembership, "workspaceId", fixture.workspaceId, "WorkspaceMembership");
  assertSnapshotField(workspaceMembership, "userId", fixture.ownerId, "WorkspaceMembership");
  assertSnapshotField(workspaceMembership, "role", "owner", "WorkspaceMembership");
  assertSnapshotField(workspaceMembership, "accessState", "confirmed", "WorkspaceMembership");

  const project = snapshotRows(snapshot, "Project")[0]!;
  assertSnapshotRecordShape(project, ["archivedAt", "createdAt", "description", "id", "membershipInheritanceMode", "name", "slug", "updatedAt", "workspaceId"], "Project");
  assertSnapshotField(project, "id", fixture.projectId, "Project");
  assertSnapshotField(project, "workspaceId", fixture.workspaceId, "Project");
  assertSnapshotField(project, "slug", fixture.projectSlug, "Project");
  // SQL reads the PostgreSQL enum label. Prisma maps this value to the
  // workspaceInherited client name, so the persisted label is underscored.
  assertSnapshotField(project, "membershipInheritanceMode", "workspace_inherited", "Project");
  assertSnapshotField(project, "archivedAt", null, "Project");

  const projectMembership = snapshotRows(snapshot, "ProjectMembership")[0]!;
  assertSnapshotRecordShape(projectMembership, ["accessState", "createdAt", "id", "projectId", "role", "updatedAt", "userId"], "ProjectMembership");
  assertSnapshotField(projectMembership, "projectId", fixture.projectId, "ProjectMembership");
  assertSnapshotField(projectMembership, "userId", fixture.ownerId, "ProjectMembership");
  assertSnapshotField(projectMembership, "role", "owner", "ProjectMembership");
  assertSnapshotField(projectMembership, "accessState", "confirmed", "ProjectMembership");

  const source = snapshotRows(snapshot, "ProjectSource")[0]!;
  assertSnapshotRecordShape(source, ["capturedAt", "contentHash", "contentLength", "contentTextDigest", "externalRef", "id", "ingestedAt", "kind", "manualContentDedupeKey", "originScope", "projectId", "projectRepositoryLinkId", "retiredAt", "revisionKey", "sourceIdentity"], "ProjectSource");
  assertSnapshotField(source, "id", fixture.sourceId, "ProjectSource");
  assertSnapshotField(source, "projectId", fixture.projectId, "ProjectSource");
  assertSnapshotField(source, "kind", "manual", "ProjectSource");
  assertSnapshotField(source, "originScope", "project", "ProjectSource");
  assertSnapshotField(source, "projectRepositoryLinkId", null, "ProjectSource");
  assertSnapshotField(source, "externalRef", null, "ProjectSource");
  assertSnapshotField(source, "contentHash", fixture.sourceContentHash, "ProjectSource");
  assertSnapshotField(source, "contentTextDigest", fixture.sourceContentHash, "ProjectSource");
  assertSnapshotField(source, "manualContentDedupeKey", fixture.sourceContentHash, "ProjectSource");
  assertSnapshotField(source, "contentLength", fixture.sourceContentLength, "ProjectSource");
  assertSnapshotField(source, "capturedAt", null, "ProjectSource");
  assertSnapshotField(source, "retiredAt", null, "ProjectSource");

  return snapshot;
}

function parseArguments(args: string[]): { allowDirty: boolean } {
  const meaningful = args.filter((argument) => argument !== "--");
  const unknown = meaningful.filter((argument) => argument !== "--allow-dirty");
  if (unknown.length > 0) throw new Error(`LOCAL_RELEASE_ARGUMENT_UNKNOWN:${unknown.join(",")}`);
  return { allowDirty: meaningful.includes("--allow-dirty") };
}

async function runProcess(
  command: string,
  args: string[],
  options: { inherit?: boolean; allowFailure?: boolean } = {},
): Promise<ProcessResult> {
  return new Promise<ProcessResult>((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    if (!options.inherit) {
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
      child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
    }
    child.once("error", reject);
    child.once("close", (code) => {
      const exitCode = code ?? 1;
      if (exitCode === 0 || options.allowFailure) {
        resolvePromise({ code: exitCode, stdout, stderr });
        return;
      }
      const detail = (stderr || stdout).trim().slice(-4_000);
      reject(new Error(`LOCAL_RELEASE_COMMAND_FAILED:${command} ${args[0] ?? ""}:${exitCode}${detail ? `\n${detail}` : ""}`));
    });
  });
}

async function reserveLoopbackPorts(): Promise<[number, number]> {
  const servers: Array<ReturnType<typeof createServer>> = [];
  try {
    for (let index = 0; index < 2; index += 1) {
      const server = await new Promise<ReturnType<typeof createServer>>((resolvePromise, reject) => {
        const candidate = createServer();
        candidate.once("error", reject);
        candidate.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => resolvePromise(candidate));
      });
      servers.push(server);
    }
    const ports = servers.map((server) => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("LOCAL_RELEASE_PORT_RESERVATION_FAILED");
      return address.port;
    });
    if (ports[0] === ports[1]) throw new Error("LOCAL_RELEASE_PORT_RESERVATION_FAILED");
    return [ports[0]!, ports[1]!];
  } finally {
    await Promise.all(servers.map((server) => new Promise<void>((resolvePromise, reject) => {
      server.close((error) => error ? reject(error) : resolvePromise());
    })));
  }
}

async function waitForCandidate(composeArgs: string[], timeoutMs = 300_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastSummary = "{}";
  while (Date.now() < deadline) {
    const result = await runProcess("docker", [...composeArgs, "ps", "--all", "--format", "json"]);
    const readiness = evaluateCandidateReadiness(parseComposePs(result.stdout));
    lastSummary = JSON.stringify(readiness.summary);
    if (readiness.fatal) throw new Error(`LOCAL_RELEASE_CANDIDATE_FAILED:${readiness.fatal}`);
    if (readiness.ready) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
  }
  throw new Error(`LOCAL_RELEASE_CANDIDATE_TIMEOUT:${lastSummary}`);
}

async function verifyHealth(appPort: number, version: string): Promise<void> {
  const url = `http://127.0.0.1:${appPort}/api/health`;
  let lastError = "unavailable";
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      const body = await response.json() as Record<string, unknown>;
      const worker = body.worker as Record<string, unknown> | undefined;
      if (
        response.ok &&
        body.status === "ok" &&
        body.database === "up" &&
        body.version === version &&
        worker?.status === "up" &&
        worker.consecutiveFailures === 0
      ) return;
      lastError = JSON.stringify(body);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  throw new Error(`LOCAL_RELEASE_HEALTH_FAILED:${lastError}`);
}

async function postJson(
  url: string,
  body: JsonRecord,
  expectedStatus: number,
  cookie?: string,
): Promise<{ payload: JsonRecord; response: Response }> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    origin: new URL(url).origin,
  };
  if (cookie !== undefined) headers.cookie = cookie;
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const rawBody = await response.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(rawBody);
  } catch (error) {
    throw new Error(`LOCAL_RELEASE_FIXTURE_API_RESPONSE_INVALID:${response.status}`, { cause: error });
  }
  if (response.status !== expectedStatus) {
    throw new Error(`LOCAL_RELEASE_FIXTURE_API_FAILED:${response.status}:${expectedStatus}`);
  }
  return { payload: requireRecord(parsed, "LOCAL_RELEASE_FIXTURE_API_PAYLOAD_INVALID"), response };
}

function readSessionCookie(response: Response): string {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const setCookieValues = typeof headers.getSetCookie === "function"
    ? headers.getSetCookie()
    : [response.headers.get("set-cookie") ?? ""];
  const session = setCookieValues
    .join(",")
    .match(/(?:^|,)\s*ai_project_os_session=([^;]+)/u)?.[1];
  if (session === undefined || session.length === 0) throw new Error("LOCAL_RELEASE_FIXTURE_SESSION_MISSING");
  return `ai_project_os_session=${session}`;
}

async function seedBusinessFixture(appPort: number, identity: CandidateIdentity): Promise<BusinessFixture> {
  const baseUrl = `http://127.0.0.1:${appPort}`;
  const adminUsername = `candidate-admin-${identity.token}`;
  const ownerUsername = `candidate-owner-${identity.token}`;
  const adminPassword = `candidate_admin_${randomBytes(24).toString("hex")}`;
  const ownerPassword = `candidate_owner_${randomBytes(24).toString("hex")}`;
  const projectSlug = `candidate-${identity.token}`;
  const sourceContent = "Disposable local release persistence fixture content.";
  const sourceContentHash = createHash("sha256").update(sourceContent, "utf8").digest("hex");
  const setup = await postJson(`${baseUrl}/api/setup`, { username: adminUsername, password: adminPassword }, 201);
  const adminSessionCookie = readSessionCookie(setup.response);
  const user = requireRecord(setup.payload.user, "LOCAL_RELEASE_FIXTURE_USER_INVALID");
  const adminId = requireUuid(user.id, "LOCAL_RELEASE_FIXTURE_ADMIN_ID_INVALID");
  if (user.username !== adminUsername || user.role !== "admin") throw new Error("LOCAL_RELEASE_FIXTURE_ADMIN_INVALID");

  await postJson(`${baseUrl}/api/admin/onboarding/complete`, { username: ownerUsername, password: ownerPassword }, 201, adminSessionCookie);
  const ownerLogin = await postJson(`${baseUrl}/api/auth/login`, { username: ownerUsername, password: ownerPassword, remember: true }, 200);
  const ownerSessionCookie = readSessionCookie(ownerLogin.response);
  const owner = requireRecord(ownerLogin.payload.user, "LOCAL_RELEASE_FIXTURE_OWNER_INVALID");
  const ownerId = requireUuid(owner.id, "LOCAL_RELEASE_FIXTURE_OWNER_ID_INVALID");
  if (owner.username !== ownerUsername || owner.role !== "user" || ownerId === adminId) {
    throw new Error("LOCAL_RELEASE_FIXTURE_OWNER_INVALID");
  }

  const projectResponse = await postJson(`${baseUrl}/api/projects`, {
    name: `Local release candidate ${identity.token}`,
    slug: projectSlug,
    description: "Disposable local release persistence fixture",
  }, 201, ownerSessionCookie);
  const project = requireRecord(projectResponse.payload.project, "LOCAL_RELEASE_FIXTURE_PROJECT_INVALID");
  const projectId = requireUuid(project.id, "LOCAL_RELEASE_FIXTURE_PROJECT_ID_INVALID");
  if (project.slug !== projectSlug) {
    throw new Error("LOCAL_RELEASE_FIXTURE_PROJECT_INVALID");
  }

  const sourceResponse = await postJson(`${baseUrl}/api/projects/${encodeURIComponent(projectId)}/sources`, {
    contentText: sourceContent,
  }, 201, ownerSessionCookie);
  const source = requireRecord(sourceResponse.payload.source, "LOCAL_RELEASE_FIXTURE_SOURCE_INVALID");
  const sourceId = requireUuid(source.id, "LOCAL_RELEASE_FIXTURE_SOURCE_ID_INVALID");
  if (source.kind !== "manual" || source.contentHash !== sourceContentHash) {
    throw new Error("LOCAL_RELEASE_FIXTURE_SOURCE_INVALID");
  }

  return {
    adminId,
    ownerId,
    ownerUsername,
    workspaceId: DEFAULT_WORKSPACE_ID,
    projectId,
    projectSlug,
    sourceId,
    sourceContentHash,
    sourceContentLength: sourceContent.length,
  };
}

async function runRuntimeQuery(
  composeArgs: string[],
  runtimePassword: string,
  query: string,
): Promise<unknown> {
  const result = await runProcess("docker", [
    ...composeArgs,
    "exec",
    "-T",
    "-e",
    `PGPASSWORD=${runtimePassword}`,
    "postgres",
    "psql",
    "-U",
    "ai_project_os_runtime",
    "-d",
    "ai_project_os_candidate",
    "-At",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    query,
  ]);
  const output = result.stdout.trim();
  if (output.length === 0 || output.split(/\r?\n/u).length !== 1) {
    throw new Error("LOCAL_RELEASE_RUNTIME_QUERY_OUTPUT_INVALID");
  }
  try {
    return JSON.parse(output);
  } catch (error) {
    throw new Error("LOCAL_RELEASE_RUNTIME_QUERY_JSON_INVALID", { cause: error });
  }
}

async function readBusinessSnapshot(
  composeArgs: string[],
  runtimePassword: string,
  fixture: BusinessFixture,
): Promise<JsonRecord> {
  const query = `
SELECT jsonb_build_object(
  'AppUser', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', u."id"::text,
      'username', u."username",
      'displayName', u."displayName",
      'email', u."email",
      'emailVerifiedAt', u."emailVerifiedAt",
      'role', u."role"::text,
      'disabledAt', u."disabledAt",
      'accountAccessVersion', u."accountAccessVersion",
      'createdAt', u."createdAt",
      'updatedAt', u."updatedAt"
    ) ORDER BY u."id")
    FROM "AppUser" AS u
    WHERE u."id" = ${sqlLiteral(fixture.ownerId)}::uuid
  ), '[]'::jsonb),
  'Workspace', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', w."id"::text,
      'name', w."name",
      'slug', w."slug",
      'createdById', w."createdById"::text,
      'createdAt', w."createdAt",
      'updatedAt', w."updatedAt"
    ) ORDER BY w."id")
    FROM "Workspace" AS w
    WHERE w."id" = ${sqlLiteral(fixture.workspaceId)}::uuid
  ), '[]'::jsonb),
  'WorkspaceMembership', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', membership."id"::text,
      'workspaceId', membership."workspaceId"::text,
      'userId', membership."userId"::text,
      'role', membership."role"::text,
      'accessState', membership."accessState"::text,
      'createdAt', membership."createdAt",
      'updatedAt', membership."updatedAt"
    ) ORDER BY membership."id")
    FROM "WorkspaceMembership" AS membership
    WHERE membership."workspaceId" = ${sqlLiteral(fixture.workspaceId)}::uuid
      AND membership."userId" = ${sqlLiteral(fixture.ownerId)}::uuid
  ), '[]'::jsonb),
  'Project', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', project."id"::text,
      'workspaceId', project."workspaceId"::text,
      'membershipInheritanceMode', project."membershipInheritanceMode"::text,
      'name', project."name",
      'slug', project."slug",
      'description', project."description",
      'archivedAt', project."archivedAt",
      'createdAt', project."createdAt",
      'updatedAt', project."updatedAt"
    ) ORDER BY project."id")
    FROM "Project" AS project
    WHERE project."id" = ${sqlLiteral(fixture.projectId)}::uuid
  ), '[]'::jsonb),
  'ProjectMembership', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', membership."id"::text,
      'projectId', membership."projectId"::text,
      'userId', membership."userId"::text,
      'role', membership."role"::text,
      'accessState', membership."accessState"::text,
      'createdAt', membership."createdAt",
      'updatedAt', membership."updatedAt"
    ) ORDER BY membership."id")
    FROM "ProjectMembership" AS membership
    WHERE membership."projectId" = ${sqlLiteral(fixture.projectId)}::uuid
      AND membership."userId" = ${sqlLiteral(fixture.ownerId)}::uuid
  ), '[]'::jsonb),
  'ProjectSource', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', source."id"::text,
      'projectId', source."projectId"::text,
      'kind', source."kind"::text,
      'originScope', source."originScope"::text,
      'projectRepositoryLinkId', source."projectRepositoryLinkId"::text,
      'externalRef', source."externalRef",
      'contentHash', source."contentHash",
      'contentTextDigest', encode(digest(convert_to(source."contentText", 'UTF8'), 'sha256'), 'hex'),
      'contentLength', char_length(source."contentText"),
      'manualContentDedupeKey', source."manualContentDedupeKey",
      'sourceIdentity', source."sourceIdentity"::text,
      'revisionKey', source."revisionKey"::text,
      'capturedAt', source."capturedAt",
      'ingestedAt', source."ingestedAt",
      'retiredAt', source."retiredAt"
    ) ORDER BY source."id")
    FROM "ProjectSource" AS source
    WHERE source."projectId" = ${sqlLiteral(fixture.projectId)}::uuid
      AND source."id" = ${sqlLiteral(fixture.sourceId)}::uuid
  ), '[]'::jsonb)
)::text;
`;
  const snapshot = await runRuntimeQuery(composeArgs, runtimePassword, query);
  return assertBusinessSnapshot(snapshot, fixture);
}

async function readWorkerRuntime(
  composeArgs: string[],
  runtimePassword: string,
  workerName: string,
): Promise<WorkerRuntimeEvidence> {
  const query = `
SELECT COALESCE(jsonb_agg(jsonb_build_object(
  'name', runtime."name",
  'status', runtime."status"::text,
  'instanceIdHash', runtime."instanceIdHash",
  'startedEpochMs', (extract(epoch FROM runtime."startedAt") * 1000)::bigint,
  'heartbeatEpochMs', (extract(epoch FROM runtime."heartbeatAt") * 1000)::bigint,
  'consecutiveFailures', runtime."consecutiveFailures"
) ORDER BY runtime."name"), '[]'::jsonb)::text
FROM "WorkerRuntime" AS runtime
WHERE runtime."name" = ${sqlLiteral(workerName)};
`;
  const value = await runRuntimeQuery(composeArgs, runtimePassword, query);
  if (!Array.isArray(value) || value.length !== 1 || !isRecord(value[0])) {
    throw new Error(`LOCAL_RELEASE_WORKER_RUNTIME_CARDINALITY:${Array.isArray(value) ? value.length : "invalid"}`);
  }
  const row = value[0];
  const name = requireString(row.name, "LOCAL_RELEASE_WORKER_RUNTIME_INVALID");
  const status = requireString(row.status, "LOCAL_RELEASE_WORKER_RUNTIME_INVALID");
  const instanceIdHash = requireString(row.instanceIdHash, "LOCAL_RELEASE_WORKER_RUNTIME_INVALID");
  const startedEpochMs = row.startedEpochMs;
  const heartbeatEpochMs = row.heartbeatEpochMs;
  const consecutiveFailures = row.consecutiveFailures;
  if (
    name !== workerName
    || status !== "running"
    || !SHA256_PATTERN.test(instanceIdHash)
    || typeof startedEpochMs !== "number"
    || !Number.isSafeInteger(startedEpochMs)
    || typeof heartbeatEpochMs !== "number"
    || !Number.isSafeInteger(heartbeatEpochMs)
    || typeof consecutiveFailures !== "number"
    || !Number.isSafeInteger(consecutiveFailures)
    || consecutiveFailures !== 0
    || heartbeatEpochMs < startedEpochMs
  ) {
    throw new Error("LOCAL_RELEASE_WORKER_RUNTIME_INVALID");
  }
  const heartbeatAgeMs = Date.now() - heartbeatEpochMs;
  if (heartbeatAgeMs < -5_000 || heartbeatAgeMs > WORKER_HEARTBEAT_STALE_AFTER_MS) {
    throw new Error(`LOCAL_RELEASE_WORKER_HEARTBEAT_STALE:${heartbeatAgeMs}`);
  }
  return { name, status, instanceIdHash, startedEpochMs, heartbeatEpochMs, consecutiveFailures };
}

async function expectedMigrationCount(): Promise<number> {
  const entries = await readdir(resolve(process.cwd(), "prisma/migrations"), { withFileTypes: true });
  const count = entries.filter((entry) => entry.isDirectory() && /^\d{14}_[a-z0-9_]+$/u.test(entry.name)).length;
  if (count === 0) throw new Error("LOCAL_RELEASE_MIGRATIONS_MISSING");
  return count;
}

async function verifyMigrations(composeArgs: string[], expected: number): Promise<void> {
  const result = await runProcess("docker", [
    ...composeArgs,
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    "ai_project_os_migrator",
    "-d",
    "ai_project_os_candidate",
    "-At",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    'SELECT COUNT(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;',
  ]);
  if (Number(result.stdout.trim()) !== expected) {
    throw new Error(`LOCAL_RELEASE_MIGRATION_COUNT_MISMATCH:${result.stdout.trim()}:${expected}`);
  }
}

async function verifyImageLabels(composeArgs: string[], version: string): Promise<void> {
  for (const service of ["principal-bootstrap", "migrate", "reconcile", "app", "worker"]) {
    const container = await runProcess("docker", [...composeArgs, "ps", "--all", "--quiet", service]);
    const containerId = container.stdout.trim();
    if (!/^[a-f0-9]{12,64}$/u.test(containerId)) {
      throw new Error(`LOCAL_RELEASE_CONTAINER_ID_INVALID:${service}`);
    }
    const label = await runProcess("docker", [
      "inspect",
      "--format",
      '{{ index .Config.Labels "org.opencontainers.image.version" }}',
      containerId,
    ]);
    if (label.stdout.trim() !== version) throw new Error(`LOCAL_RELEASE_IMAGE_VERSION_MISMATCH:${service}`);
  }
}

async function cleanupCandidate(identity: CandidateIdentity, composeArgs: string[]): Promise<void> {
  assertSafeCandidateIdentity(identity);
  const cleanupErrors: string[] = [];
  const down = await runProcess("docker", [
    ...composeArgs,
    "down",
    "--volumes",
    "--remove-orphans",
    "--timeout",
    "20",
  ], { inherit: true, allowFailure: true });
  if (down.code !== 0) cleanupErrors.push(`compose-down:${down.code}`);

  for (const image of Object.values(identity.images)) {
    const inspected = await runProcess("docker", ["image", "inspect", image], { allowFailure: true });
    if (inspected.code === 0) {
      const removed = await runProcess("docker", ["image", "rm", image], { inherit: true, allowFailure: true });
      if (removed.code !== 0) cleanupErrors.push(`image:${image}`);
    }
  }

  const containers = await runProcess("docker", [
    "ps",
    "--all",
    "--filter",
    `label=com.docker.compose.project=${identity.projectName}`,
    "--format",
    "{{.ID}}",
  ]);
  const volumes = await runProcess("docker", ["volume", "ls", "--format", "{{.Name}}"]).then((result) =>
    result.stdout.split(/\r?\n/u).filter((name) => Object.values(identity.volumes).includes(name)),
  );
  const networks = await runProcess("docker", [
    "network",
    "ls",
    "--filter",
    `label=com.docker.compose.project=${identity.projectName}`,
    "--format",
    "{{.ID}}",
  ]);
  const images = await runProcess("docker", ["image", "ls", "--format", "{{.Repository}}:{{.Tag}}"]).then((result) =>
    result.stdout.split(/\r?\n/u).filter((image) => Object.values(identity.images).includes(image)),
  );
  if (containers.stdout.trim()) cleanupErrors.push("containers");
  if (volumes.length > 0) cleanupErrors.push(`volumes:${volumes.join(",")}`);
  if (networks.stdout.trim()) cleanupErrors.push("networks");
  if (images.length > 0) cleanupErrors.push(`images:${images.join(",")}`);
  if (cleanupErrors.length > 0) throw new Error(`LOCAL_RELEASE_CLEANUP_INCOMPLETE:${cleanupErrors.join(";")}`);
}

async function main(): Promise<void> {
  const { allowDirty } = parseArguments(process.argv.slice(2));
  const [packageJson, appVersion, dockerfile] = await Promise.all([
    readFile("package.json", "utf8"),
    readFile("src/lib/version.ts", "utf8"),
    readFile("Dockerfile", "utf8"),
  ]);
  const version = readCoherentVersion(packageJson, appVersion, dockerfile);
  const status = await runProcess("git", ["status", "--porcelain=v1", "--untracked-files=all"]);
  const dirty = status.stdout.trim().length > 0;
  if (dirty && !allowDirty) throw new Error("LOCAL_RELEASE_WORKTREE_DIRTY");
  if (dirty) console.warn("[local-release] dirty candidate: result is not release-eligible");
  const revision = (await runProcess("git", ["rev-parse", "HEAD"])).stdout.trim();
  if (!/^[a-f0-9]{40}$/u.test(revision)) throw new Error("LOCAL_RELEASE_REVISION_INVALID");
  await runProcess("docker", ["version", "--format", "{{.Server.Version}}"]);

  const token = `${Date.now().toString(36)}${randomBytes(4).toString("hex")}`.slice(-20);
  const identity = createCandidateIdentity(token, version);
  const [postgresPort, appPort] = await reserveLoopbackPorts();
  const clusterAdminPassword = `admin_${randomBytes(24).toString("hex")}`;
  const migratorPassword = `migrator_${randomBytes(24).toString("hex")}`;
  const runtimePassword = `runtime_${randomBytes(24).toString("hex")}`;
  const entitlementWriterPassword = `writer_${randomBytes(24).toString("hex")}`;
  const inventoryReaderPassword = `inventory_${randomBytes(24).toString("hex")}`;
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "ai-project-os-local-release-"));
  const envFile = join(temporaryDirectory, "candidate.env");
  const overrideFile = join(temporaryDirectory, "compose.candidate.yaml");
  const envSource = [
    "POSTGRES_USER=ai_project_os_cluster_admin",
    `POSTGRES_CLUSTER_ADMIN_PASSWORD=${clusterAdminPassword}`,
    `POSTGRES_MIGRATOR_PASSWORD=${migratorPassword}`,
    "POSTGRES_DB=ai_project_os_candidate",
    "POSTGRES_RUNTIME_USER=ai_project_os_runtime",
    `POSTGRES_RUNTIME_PASSWORD=${runtimePassword}`,
    "POSTGRES_ENTITLEMENT_WRITER_USER=ai_project_os_entitlement_writer",
    `POSTGRES_ENTITLEMENT_WRITER_PASSWORD=${entitlementWriterPassword}`,
    `POSTGRES_ENTITLEMENT_INVENTORY_READER_PASSWORD=${inventoryReaderPassword}`,
    `POSTGRES_PORT=${postgresPort}`,
    `APP_PORT=${appPort}`,
    `AI_PROJECT_OS_PGDATA_VOLUME=${identity.volumes.postgres}`,
    `AI_PROJECT_OS_SECRETS_VOLUME=${identity.volumes.secrets}`,
    `AI_PROJECT_OS_UPLOADS_VOLUME=${identity.volumes.uploads}`,
    `AI_PROJECT_OS_WORKER_NAME=${identity.workerName}`,
    `LOCAL_RELEASE_IMAGE_PREFIX=${identity.projectName}`,
    `LOCAL_RELEASE_VERSION=${version}`,
    "AI_PROJECT_OS_SECURE_COOKIES=false",
    "",
  ].join("\n");
  const overrideSource = [
    "services:",
    "  principal-bootstrap:",
    '    image: "${LOCAL_RELEASE_IMAGE_PREFIX}-principal-bootstrap:${LOCAL_RELEASE_VERSION}"',
    "  migrate:",
    '    image: "${LOCAL_RELEASE_IMAGE_PREFIX}-migrate:${LOCAL_RELEASE_VERSION}"',
    "  reconcile:",
    '    image: "${LOCAL_RELEASE_IMAGE_PREFIX}-reconcile:${LOCAL_RELEASE_VERSION}"',
    "  app:",
    '    image: "${LOCAL_RELEASE_IMAGE_PREFIX}-app:${LOCAL_RELEASE_VERSION}"',
    "  worker:",
    '    image: "${LOCAL_RELEASE_IMAGE_PREFIX}-worker:${LOCAL_RELEASE_VERSION}"',
    "",
  ].join("\n");

  const composeArgs = [
    "compose",
    "--ansi",
    "never",
    "--project-directory",
    process.cwd(),
    "--project-name",
    identity.projectName,
    "--env-file",
    envFile,
    "--file",
    resolve(process.cwd(), "compose.yaml"),
    "--file",
    overrideFile,
  ];
  let failure: unknown = null;
  let summary: LocalReleaseSummary | null = null;
  let candidateFilesPrepared = false;
  let candidateTouched = false;
  try {
    await Promise.all([
      writeFile(envFile, envSource, { mode: 0o600 }),
      writeFile(overrideFile, overrideSource, { mode: 0o600 }),
    ]);
    candidateFilesPrepared = true;
    console.log(`[local-release] validating isolated candidate ${identity.projectName}`);
    await runProcess("docker", [...composeArgs, "config", "--quiet"]);
    candidateTouched = true;
    console.log("[local-release] building app, worker, principal bootstrap, migration, and reconcile images");
    await runProcess("docker", [...composeArgs, "build"], { inherit: true });
    console.log("[local-release] starting isolated candidate");
    await runProcess("docker", [...composeArgs, "up", "--detach"], { inherit: true });
    await waitForCandidate(composeArgs);
    const migrationCount = await expectedMigrationCount();
    await verifyMigrations(composeArgs, migrationCount);
    await verifyImageLabels(composeArgs, version);
    await verifyHealth(appPort, version);
    console.log("[local-release] seeding disposable business persistence fixture through the application API");
    const fixture = await seedBusinessFixture(appPort, identity);
    const beforeSnapshot = await readBusinessSnapshot(composeArgs, runtimePassword, fixture);
    const beforeWorker = await readWorkerRuntime(composeArgs, runtimePassword, identity.workerName);
    const beforeCanonical = canonicalJson(beforeSnapshot);
    const beforeSnapshotHash = snapshotSha256(beforeSnapshot);
    console.log("[local-release] restarting database, app, and worker");
    await runProcess("docker", [...composeArgs, "restart", "postgres", "app", "worker"], { inherit: true });
    await waitForCandidate(composeArgs);
    await verifyMigrations(composeArgs, migrationCount);
    await verifyHealth(appPort, version);
    const afterSnapshot = await readBusinessSnapshot(composeArgs, runtimePassword, fixture);
    const afterWorker = await readWorkerRuntime(composeArgs, runtimePassword, identity.workerName);
    const afterCanonical = canonicalJson(afterSnapshot);
    if (beforeCanonical !== afterCanonical) throw new Error("LOCAL_RELEASE_BUSINESS_SNAPSHOT_MISMATCH");
    if (beforeWorker.instanceIdHash === afterWorker.instanceIdHash) {
      throw new Error("LOCAL_RELEASE_WORKER_INSTANCE_NOT_REPLACED");
    }
    if (afterWorker.startedEpochMs < beforeWorker.startedEpochMs) {
      throw new Error("LOCAL_RELEASE_WORKER_STARTED_AT_REGRESSED");
    }
    summary = {
      version,
      revision,
      releaseEligible: !dirty,
      migrations: migrationCount,
      health: "ok",
      restartPersistence: "ok",
      businessDataPersistence: "ok",
      businessDataPersistenceEvidence: {
        entities: BUSINESS_SNAPSHOT_ENTITIES,
        rows: BUSINESS_SNAPSHOT_ENTITIES.length,
        snapshotSha256: beforeSnapshotHash,
        prePostEqual: true,
      },
      workerRestart: "ok",
      cleanup: "verified",
    };
  } catch (error) {
    failure = error;
    if (candidateTouched) {
      console.error("[local-release] candidate failed; collecting bounded logs");
      await runProcess("docker", [...composeArgs, "logs", "--no-color", "--tail", "200"], {
        inherit: true,
        allowFailure: true,
      });
    }
  }
  try {
    if (candidateFilesPrepared) {
      console.log("[local-release] cleaning exact candidate resources");
      await cleanupCandidate(identity, composeArgs);
    }
  } catch (cleanupError) {
    failure = failure
      ? new Error(`${failure instanceof Error ? failure.message : String(failure)}\n${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`)
      : cleanupError;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
  if (failure) throw failure;
  console.log(`LOCAL_RELEASE_CANDIDATE_OK ${JSON.stringify(summary)}`);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
