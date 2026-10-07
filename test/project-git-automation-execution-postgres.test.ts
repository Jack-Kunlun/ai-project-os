import "dotenv/config";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { Client } from "pg";
import { PrismaClient } from "@prisma/client";
import { createCredential, loadOrCreateMasterKey } from "../src/lib/credential-vault";
import { encodeGitCredential } from "../src/lib/git/credentials";
import { assertPinnedGitEndpoint } from "../src/lib/git/safety";
import { getDb, getGitAutomationWorkerDb } from "../src/lib/db";
import { grantProjectMembership } from "../src/lib/membership-governance";
import {
  confirmProjectGitRepositoryDelegationOwner,
  confirmProjectGitRepositoryDelegationProject,
  proposeProjectGitRepositoryDelegation,
} from "../src/lib/project-git-repository-delegation-service";
import {
  activateProjectGitAutomationGrantProjectOwner,
  confirmProjectGitAutomationGrantConnectionOwner,
  proposeProjectGitAutomationGrant,
} from "../src/lib/project-git-automation-grant-service";
import { runOneGitAutomationCycle } from "../src/lib/project-git-automation-execution-service";
import { createGitConnectionFixture } from "./personal-connection-probe-fixture";
import { createPostgresWorkspaceFixture } from "./postgres-workspace-fixture";

const shouldRun = process.env.PROJECT_GIT_AUTOMATION_EXECUTION_POSTGRES_GATE === "1";
const databaseName = "ai_project_os_project_git_automation_execution_test";
const workerRole = "ai_project_os_git_automation_worker";
const repositoryPath = "org/automation-execution";
const trackedRef = "main";
const scannedPath = "src/guide.md";
const credentialPayload = encodeGitCredential("token", "synthetic-git-automation-token");
const rawBody = "# 自动同步\n\n保留原始正文和末尾空格。 \n第二行内容。\n";

type AutomationFixture = Readonly<{
  projectId: string;
  delegationId: string;
  grantId: string;
  ownerId: string;
}>;

function requireDatabaseUrl(environmentName: string, roleName: string): string {
  const raw = process.env[environmentName];
  if (typeof raw !== "string" || raw.length === 0) throw new Error(`${environmentName}_REQUIRED`);
  const parsed = new URL(raw);
  if (!(parsed.protocol === "postgres:" || parsed.protocol === "postgresql:")
    || !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname.toLowerCase())
    || parsed.port !== "56432"
    || parsed.pathname !== `/${databaseName}`
    || decodeURIComponent(parsed.username) !== roleName
    || parsed.password.length === 0
    || parsed.search !== ""
    || parsed.hash !== "") {
    throw new Error(`${environmentName}_INVALID`);
  }
  return parsed.toString();
}

function resolveGitBinary(): string {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (directory.length === 0) continue;
    const candidate = join(directory, process.platform === "win32" ? "git.exe" : "git");
    try {
      // access() below is asynchronous; probing with execFileSync avoids shell
      // evaluation and returns only the executable's own status.
      execFileSync(candidate, ["--version"], { stdio: "ignore" });
      return candidate;
    } catch {
      // Continue until the configured Git executable is found.
    }
  }
  throw new Error("GIT_EXECUTABLE_UNAVAILABLE");
}

function runLocalGit(gitBinary: string, cwd: string, args: readonly string[], home: string): string {
  return execFileSync(gitBinary, [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOME: home,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
  }).trim();
}

async function createLocalBareRepository(root: string): Promise<Readonly<{
  bareRemote: string;
  commitSha: string;
}>> {
  const gitBinary = resolveGitBinary();
  const home = join(root, "git-home");
  const source = join(root, "source");
  const bareRemote = join(root, "remote.git");
  await mkdir(home, { mode: 0o700 });
  await mkdir(source, { mode: 0o700 });
  execFileSync(gitBinary, ["init", "--bare", bareRemote], { cwd: root, stdio: "ignore" });
  execFileSync(gitBinary, ["init", "--initial-branch=main"], {
    cwd: source,
    stdio: "ignore",
    env: { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  runLocalGit(gitBinary, source, ["config", "user.name", "PostgreSQL gate"], home);
  runLocalGit(gitBinary, source, ["config", "user.email", "postgres-gate@example.invalid"], home);
  await mkdir(join(source, "src"), { mode: 0o700 });
  await writeFile(join(source, scannedPath), rawBody, { encoding: "utf8", mode: 0o600 });
  runLocalGit(gitBinary, source, ["add", "--", scannedPath], home);
  runLocalGit(gitBinary, source, ["commit", "-m", "fixture"], home);
  const commitSha = runLocalGit(gitBinary, source, ["rev-parse", "HEAD"], home);
  runLocalGit(gitBinary, source, ["remote", "add", "origin", pathToFileURL(bareRemote).toString()], home);
  runLocalGit(gitBinary, source, ["push", "--set-upstream", "origin", trackedRef], home);
  return Object.freeze({ bareRemote, commitSha });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function installLocalGitShim(root: string, bareRemote: string): Promise<Readonly<{
  shimDirectory: string;
  traceFile: string;
}>> {
  const shimDirectory = join(root, "git-shim");
  const traceFile = join(root, "git-commands.log");
  const remoteConfigured = join(root, "local-remote-configured");
  const gitBinary = resolveGitBinary();
  const expectedRemote = `https://127.0.0.1/${repositoryPath}.git`;
  await mkdir(shimDirectory, { mode: 0o700 });
  const shim = [
    "#!/bin/bash",
    "set -eu",
    "umask 077",
    "unset GIT_ALLOW_PROTOCOL GIT_ASKPASS GIT_ASKPASS_REQUIRE AI_PROJECT_OS_GIT_USERNAME AI_PROJECT_OS_GIT_SECRET",
    "args=(\"$@\")",
    "for ((index = 0; index + 3 < ${#args[@]}; index += 1)); do",
    "  if [[ \"${args[index]}\" == remote && \"${args[index + 1]}\" == add && \"${args[index + 2]}\" == origin ]]; then",
    `    [[ "\${args[index + 3]}" == ${shellQuote(expectedRemote)} ]] || exit 81`,
    `    args[index + 3]=${shellQuote(pathToFileURL(bareRemote).toString())}`,
    `    : > ${shellQuote(remoteConfigured)}`,
    "  fi",
    "done",
    "for argument in \"${args[@]}\"; do",
    "  case \"$argument\" in",
    "    ls-remote|fetch|ls-tree|cat-file|rev-parse|init) printf '%s\\n' \"$argument\" >> " + shellQuote(traceFile) + " ;;",
    "  esac",
    "done",
    "for argument in \"${args[@]}\"; do",
    "  case \"$argument\" in",
    `    ls-remote|fetch) [[ -f ${shellQuote(remoteConfigured)} ]] || exit 82 ;;`,
    "  esac",
    "done",
    `exec ${shellQuote(gitBinary)} "\${args[@]}"`,
    "",
  ].join("\n");
  const shimPath = join(shimDirectory, "git");
  await writeFile(shimPath, shim, { encoding: "utf8", mode: 0o700 });
  await chmod(shimPath, 0o700);
  // The generated shim deliberately has no credential-valued arguments in its
  // trace and refuses network reads until origin has been redirected to file.
  await access(shimPath, fsConstants.X_OK);
  return Object.freeze({ shimDirectory, traceFile });
}

async function createActiveAutomationFixture(db: PrismaClient, addressFingerprint: string): Promise<AutomationFixture> {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const { workspaceId, ownerId } = await createPostgresWorkspaceFixture(db);
  const projectId = randomUUID();
  const connectionId = randomUUID();
  const actor = { id: ownerId, role: "user" as const, accountAccessVersion: 1 };

  await db.project.create({
    data: { id: projectId, workspaceId, name: `Git automation execution ${suffix}`, slug: `git-automation-execution-${suffix}` },
  });
  await db.$transaction((tx) => grantProjectMembership(tx, {
    projectId,
    workspaceId,
    userId: ownerId,
    role: "owner",
    actorId: ownerId,
    reason: "git_automation_execution_owner_fixture",
  }));
  const credential = await createCredential("git", credentialPayload, db);
  await createGitConnectionFixture({
    id: connectionId,
    name: `Git automation execution ${suffix}`,
    providerKind: "generic",
    transport: "https",
    baseUrl: "https://127.0.0.1",
    authKind: "token",
    username: "git",
    allowPrivateNetwork: true,
    tlsCaCertificate: null,
    sshKnownHost: null,
    status: "verified",
    ownershipState: "confirmed",
    resolvedAddressFingerprint: addressFingerprint,
    createdById: ownerId,
    ownerUserId: ownerId,
    ownerAccountAccessVersion: 1,
    credentialId: credential.id,
  }, db);

  const delegation = await proposeProjectGitRepositoryDelegation(projectId, {
    gitConnectionId: connectionId,
    repositoryPath,
    trackedRef,
    includeRoots: ["src"],
    softExcludePatterns: [],
    role: "primary",
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString(),
  }, actor, db);
  const ownerConfirmedDelegation = await confirmProjectGitRepositoryDelegationOwner(projectId, delegation.id, {
    expectedVersion: delegation.version,
    acknowledgeReadOnlyCredentialUse: true,
  }, actor, db);
  const activeDelegation = await confirmProjectGitRepositoryDelegationProject(projectId, delegation.id, {
    expectedVersion: ownerConfirmedDelegation.version,
    acknowledgeRepositoryScope: true,
    acknowledgeDataEgress: true,
  }, actor, db);
  const grant = await proposeProjectGitAutomationGrant(projectId, {
    baseDelegationId: activeDelegation.id,
    runIntervalMinutes: 60,
    expiresAt: activeDelegation.expiresAt,
  }, actor, db);
  const ownerConfirmedGrant = await confirmProjectGitAutomationGrantConnectionOwner(projectId, grant.id, {
    expectedVersion: grant.version,
    acknowledgeReadOnlyScheduledAccess: true,
  }, actor, db);
  await activateProjectGitAutomationGrantProjectOwner(projectId, grant.id, {
    expectedVersion: ownerConfirmedGrant.version,
    acknowledgeExactRepositoryScope: true,
    acknowledgeReadOnlyDataEgress: true,
  }, actor, db);

  return Object.freeze({ projectId, delegationId: activeDelegation.id, grantId: grant.id, ownerId });
}

async function withReplicatedAdmin<T>(admin: Client, operation: () => Promise<T>): Promise<T> {
  await admin.query("BEGIN");
  try {
    await admin.query("SET LOCAL session_replication_role = 'replica'");
    const result = await operation();
    await admin.query("COMMIT");
    return result;
  } catch (error) {
    await admin.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function makeGrantDue(admin: Client, grantId: string): Promise<void> {
  await withReplicatedAdmin(admin, async () => {
    const grant = await admin.query(`
      UPDATE public."ProjectGitRepositoryAutomationGrant"
         SET "activatedAt" = (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) - interval '61 minutes'
       WHERE "id" = $1::uuid
    `, [grantId]);
    const cursor = await admin.query(`
      UPDATE public."ProjectGitRepositoryAutomationScheduleCursor"
         SET "nextRunAt" = (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) - interval '1 minute'
       WHERE "grantId" = $1::uuid AND "status" = 'active'
    `, [grantId]);
    assert.equal(grant.rowCount, 1);
    // The schedule cursor is created by the first due claim. On later replays
    // it exists and this gate moves its nextRunAt back without waiting.
    assert.ok(cursor.rowCount === 0 || cursor.rowCount === 1);
  });
}

async function readGitTrace(traceFile: string): Promise<string[]> {
  const value = await readFile(traceFile, "utf8").catch((error: unknown) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return "";
    throw error;
  });
  return value.split("\n").filter((line) => line.length > 0);
}

async function clearGitTrace(traceFile: string): Promise<void> {
  await writeFile(traceFile, "", { encoding: "utf8", mode: 0o600 });
}

test("automatic Git worker fetches and atomically publishes once, replays unchanged, and fails closed after lease loss", {
  skip: !shouldRun ? "PROJECT_GIT_AUTOMATION_EXECUTION_POSTGRES_GATE=1 is required" : false,
  timeout: 120_000,
}, async () => {
  requireDatabaseUrl("DATABASE_URL", "ai_project_os_runtime");
  const adminUrl = requireDatabaseUrl("DATABASE_PRINCIPAL_ADMIN_URL", "ai_project_os_cluster_admin");
  requireDatabaseUrl("GIT_AUTOMATION_DATABASE_URL", workerRole);

  const previousMasterKeyPath = process.env.AI_PROJECT_OS_MASTER_KEY_FILE;
  const previousPath = process.env.PATH;
  const tempRoot = await mkdtemp(join(tmpdir(), "ai-project-os-git-automation-postgres-"));
  const masterKeyPath = join(tempRoot, "master.key");
  const db = getDb();
  const workerDb = getGitAutomationWorkerDb();
  const admin = new Client({ connectionString: adminUrl, connectionTimeoutMillis: 5_000 });
  process.env.AI_PROJECT_OS_MASTER_KEY_FILE = masterKeyPath;
  try {
    await loadOrCreateMasterKey();
    await admin.connect();
    const localRepository = await createLocalBareRepository(tempRoot);
    const pinned = await assertPinnedGitEndpoint({
      baseUrl: "https://127.0.0.1",
      allowPrivateNetwork: true,
      expectedFingerprint: null,
    });
    const fixture = await createActiveAutomationFixture(db, pinned.fingerprint);
    const { shimDirectory, traceFile } = await installLocalGitShim(tempRoot, localRepository.bareRemote);
    process.env.PATH = `${shimDirectory}${delimiter}${previousPath ?? ""}`;

    await makeGrantDue(admin, fixture.grantId);
    const firstOutcome = await runOneGitAutomationCycle({
      workerId: "git-automation-execution-postgres",
      db: workerDb,
      stopSignal: new AbortController().signal,
    });
    assert.equal(firstOutcome, "succeeded");

    const firstRunRows = await admin.query<{
      id: string;
      status: string;
      observedCommitSha: string | null;
      resultPublicationVersionId: string | null;
      resultPublicationGeneration: number | null;
    }>(`
      SELECT "id", "status", btrim("observedCommitSha") AS "observedCommitSha",
             "resultPublicationVersionId", "resultPublicationGeneration"
        FROM public."ProjectGitRepositoryAutomationRun"
       WHERE "grantId" = $1::uuid
       ORDER BY "scheduledFor"
    `, [fixture.grantId]);
    assert.equal(firstRunRows.rows.length, 1);
    const firstRun = firstRunRows.rows[0]!;
    assert.equal(firstRun.status, "succeeded");
    assert.equal(firstRun.observedCommitSha, localRepository.commitSha);
    assert.ok(firstRun.resultPublicationVersionId);
    assert.equal(firstRun.resultPublicationGeneration, 1);

    const firstPublication = await admin.query<{
      id: string;
      runKind: string;
      frozenCommitSha: string;
      fileCount: number;
      generation: number;
      currentPublicationVersionId: string;
      normalizedPath: string;
      contentText: string;
      retiredAt: Date | null;
    }>(`
      SELECT version."id", version."runKind", btrim(version."frozenCommitSha") AS "frozenCommitSha", version."fileCount",
             head."generation", head."currentPublicationVersionId", entry."normalizedPath",
             source."contentText", source."retiredAt"
        FROM public."ProjectGitRepositoryPublicationVersion" version
        JOIN public."ProjectGitRepositoryPublicationHead" head
          ON head."projectId" = version."projectId" AND head."delegationId" = version."delegationId"
        JOIN public."ProjectGitRepositoryPublicationEntry" entry
          ON entry."projectId" = version."projectId"
         AND entry."delegationId" = version."delegationId"
         AND entry."publicationVersionId" = version."id"
        JOIN public."ProjectSource" source
          ON source."projectId" = entry."projectId" AND source."id" = entry."projectSourceId"
       WHERE version."projectId" = $1::uuid AND version."delegationId" = $2::uuid
         AND version."id" = $3::uuid
    `, [fixture.projectId, fixture.delegationId, firstRun.resultPublicationVersionId]);
    assert.equal(firstPublication.rows.length, 1);
    const published = firstPublication.rows[0]!;
    assert.equal(published.runKind, "automatic");
    assert.equal(published.frozenCommitSha, localRepository.commitSha);
    assert.equal(published.fileCount, 1);
    assert.equal(published.generation, 1);
    assert.equal(published.currentPublicationVersionId, published.id);
    assert.equal(published.normalizedPath, scannedPath);
    assert.equal(published.contentText, `Repository: ${repositoryPath}\nRevision: ${localRepository.commitSha}\nPath: ${scannedPath}\n\n${rawBody}`);
    assert.equal(published.retiredAt, null);

    const firstAudit = await admin.query<{ action: string; publicationGeneration: number | null }>(`
      SELECT "action", "publicationGeneration"
        FROM public."ProjectGitRepositoryAutomationRunAudit"
       WHERE "runId" = $1::uuid AND "action" = 'run_succeeded'
    `, [firstRun.id]);
    assert.deepEqual(firstAudit.rows, [{ action: "run_succeeded", publicationGeneration: 1 }]);
    const firstTrace = await readGitTrace(traceFile);
    assert.ok(firstTrace.includes("fetch"));
    assert.ok(firstTrace.includes("cat-file"));

    await clearGitTrace(traceFile);
    await makeGrantDue(admin, fixture.grantId);
    const secondOutcome = await runOneGitAutomationCycle({
      workerId: "git-automation-execution-postgres",
      db: workerDb,
      stopSignal: new AbortController().signal,
    });
    assert.equal(secondOutcome, "unchanged");

    const secondRunRows = await admin.query<{
      id: string;
      status: string;
      observedCommitSha: string | null;
      resultPublicationVersionId: string | null;
      resultPublicationGeneration: number | null;
    }>(`
      SELECT "id", "status", btrim("observedCommitSha") AS "observedCommitSha",
             "resultPublicationVersionId", "resultPublicationGeneration"
        FROM public."ProjectGitRepositoryAutomationRun"
       WHERE "grantId" = $1::uuid
       ORDER BY "scheduledFor"
    `, [fixture.grantId]);
    assert.equal(secondRunRows.rows.length, 2);
    assert.deepEqual(secondRunRows.rows.map((row) => row.status), ["succeeded", "unchanged"]);
    assert.equal(secondRunRows.rows[1]?.observedCommitSha, localRepository.commitSha);
    assert.equal(secondRunRows.rows[1]?.resultPublicationVersionId, firstRun.resultPublicationVersionId);
    assert.equal(secondRunRows.rows[1]?.resultPublicationGeneration, 1);

    const secondPublicationCount = await admin.query<{ count: string }>(`
      SELECT count(*)::text AS "count"
        FROM public."ProjectGitRepositoryPublicationVersion"
       WHERE "projectId" = $1::uuid AND "delegationId" = $2::uuid
    `, [fixture.projectId, fixture.delegationId]);
    assert.equal(secondPublicationCount.rows[0]?.count, "1");
    const secondHead = await admin.query<{ currentPublicationVersionId: string; generation: number }>(`
      SELECT "currentPublicationVersionId", "generation"
        FROM public."ProjectGitRepositoryPublicationHead"
       WHERE "projectId" = $1::uuid AND "delegationId" = $2::uuid
    `, [fixture.projectId, fixture.delegationId]);
    assert.deepEqual(secondHead.rows, [{ currentPublicationVersionId: firstRun.resultPublicationVersionId, generation: 1 }]);
    const unchangedAudit = await admin.query<{ action: string; publicationGeneration: number | null }>(`
      SELECT "action", "publicationGeneration"
        FROM public."ProjectGitRepositoryAutomationRunAudit"
       WHERE "runId" = $1::uuid AND "action" = 'run_unchanged'
    `, [secondRunRows.rows[1]!.id]);
    assert.deepEqual(unchangedAudit.rows, [{ action: "run_unchanged", publicationGeneration: 1 }]);
    const secondTrace = await readGitTrace(traceFile);
    assert.equal(secondTrace.filter((command) => command === "ls-remote").length, 1);
    assert.equal(secondTrace.includes("fetch"), false);
    assert.equal(secondTrace.includes("cat-file"), false);

    await clearGitTrace(traceFile);
    await makeGrantDue(admin, fixture.grantId);
    let leaseExpired = false;
    let expiredRunId: string | null = null;
    const leaseDiagnostics: Array<{ stage: string; errorCode: string }> = [];
    const thirdOutcome = await runOneGitAutomationCycle({
      workerId: "git-automation-execution-postgres",
      db: workerDb,
      stopSignal: new AbortController().signal,
      onDiagnostic: (diagnostic) => {
        leaseDiagnostics.push(diagnostic);
      },
      onHeartbeat: async () => {
        if (leaseExpired) return;
        await withReplicatedAdmin(admin, async () => {
          const result = await admin.query(`
            UPDATE public."ProjectGitRepositoryAutomationRun"
               SET "scheduledFor" = (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) - interval '10 minutes',
                   "claimedAt" = (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) - interval '10 minutes',
                   "dispatchedAt" = (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) - interval '9 minutes',
                   "lastHeartbeatAt" = (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) - interval '9 minutes',
                   "leaseExpiresAt" = (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) - interval '1 minute'
             WHERE "grantId" = $1::uuid AND "leaseWorkerId" = $2 AND "status" = 'dispatched'
             RETURNING "id"
          `, [fixture.grantId, "git-automation-execution-postgres"]);
          assert.equal(result.rowCount, 1);
          expiredRunId = result.rows[0]?.id ?? null;
        });
        leaseExpired = true;
      },
    });
    assert.equal(leaseExpired, true);
    assert.equal(thirdOutcome, "deferred");
    assert.deepEqual(leaseDiagnostics, [{ stage: "lease", errorCode: "LEASE_RENEWAL_REJECTED" }]);
    assert.deepEqual(await readGitTrace(traceFile), []);

    assert.ok(expiredRunId);
    const finalRuns = await admin.query<{ id: string; status: string; safeErrorCode: string | null; leaseExpired: boolean | null }>(`
      SELECT "id", "status", "safeErrorCode",
             "leaseExpiresAt" <= (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) AS "leaseExpired"
        FROM public."ProjectGitRepositoryAutomationRun"
       WHERE "grantId" = $1::uuid
    `, [fixture.grantId]);
    assert.equal(finalRuns.rows.length, 3);
    assert.deepEqual(finalRuns.rows.filter((row) => row.id !== expiredRunId).map((row) => row.status).sort(), ["succeeded", "unchanged"]);
    assert.deepEqual(finalRuns.rows.find((row) => row.id === expiredRunId), {
      id: expiredRunId,
      status: "unknown",
      safeErrorCode: "LEASE_EXPIRED_AFTER_DISPATCH",
      leaseExpired: null,
    });
    const finalPublicationCount = await admin.query<{ count: string }>(`
      SELECT count(*)::text AS "count"
        FROM public."ProjectGitRepositoryPublicationVersion"
       WHERE "projectId" = $1::uuid AND "delegationId" = $2::uuid
    `, [fixture.projectId, fixture.delegationId]);
    assert.equal(finalPublicationCount.rows[0]?.count, "1");
    const finalHead = await admin.query<{ currentPublicationVersionId: string; generation: number }>(`
      SELECT "currentPublicationVersionId", "generation"
        FROM public."ProjectGitRepositoryPublicationHead"
       WHERE "projectId" = $1::uuid AND "delegationId" = $2::uuid
    `, [fixture.projectId, fixture.delegationId]);
    assert.deepEqual(finalHead.rows, [{ currentPublicationVersionId: firstRun.resultPublicationVersionId, generation: 1 }]);

  } finally {
    process.env.PATH = previousPath;
    if (previousMasterKeyPath === undefined) delete process.env.AI_PROJECT_OS_MASTER_KEY_FILE;
    else process.env.AI_PROJECT_OS_MASTER_KEY_FILE = previousMasterKeyPath;
    await Promise.all([
      workerDb.$disconnect().catch(() => undefined),
      db.$disconnect().catch(() => undefined),
      admin.end().catch(() => undefined),
    ]);
    await rm(tempRoot, { recursive: true, force: true });
  }
});
