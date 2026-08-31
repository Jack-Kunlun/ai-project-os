import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
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

type ProcessResult = { code: number; stdout: string; stderr: string };

type LocalReleaseSummary = {
  version: string;
  revision: string;
  releaseEligible: boolean;
  migrations: number;
  health: "ok";
  restartPersistence: "ok";
  cleanup: "verified";
};

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
    "ai_project_os_candidate",
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
  for (const service of ["migrate", "app", "worker"]) {
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
  const password = `candidate_${randomBytes(24).toString("hex")}`;
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "ai-project-os-local-release-"));
  const envFile = join(temporaryDirectory, "candidate.env");
  const overrideFile = join(temporaryDirectory, "compose.candidate.yaml");
  const envSource = [
    "POSTGRES_USER=ai_project_os_candidate",
    `POSTGRES_PASSWORD=${password}`,
    "POSTGRES_DB=ai_project_os_candidate",
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
    "  migrate:",
    '    image: "${LOCAL_RELEASE_IMAGE_PREFIX}-migrate:${LOCAL_RELEASE_VERSION}"',
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
    console.log("[local-release] building app, worker, and migration images");
    await runProcess("docker", [...composeArgs, "build"], { inherit: true });
    console.log("[local-release] starting isolated candidate");
    await runProcess("docker", [...composeArgs, "up", "--detach"], { inherit: true });
    await waitForCandidate(composeArgs);
    const migrationCount = await expectedMigrationCount();
    await verifyMigrations(composeArgs, migrationCount);
    await verifyImageLabels(composeArgs, version);
    await verifyHealth(appPort, version);
    console.log("[local-release] restarting database, app, and worker");
    await runProcess("docker", [...composeArgs, "restart", "postgres", "app", "worker"], { inherit: true });
    await waitForCandidate(composeArgs);
    await verifyMigrations(composeArgs, migrationCount);
    await verifyHealth(appPort, version);
    summary = {
      version,
      revision,
      releaseEligible: !dirty,
      migrations: migrationCount,
      health: "ok",
      restartPersistence: "ok",
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
