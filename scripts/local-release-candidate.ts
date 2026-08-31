export const LOCAL_RELEASE_PROJECT_PREFIX = "ai-project-os-candidate-";

export type CandidateIdentity = {
  token: string;
  version: string;
  projectName: string;
  workerName: string;
  volumes: {
    postgres: string;
    secrets: string;
    uploads: string;
  };
  images: {
    migrate: string;
    app: string;
    worker: string;
  };
};

export type ComposeServiceState = {
  service: string;
  state: string;
  health: string;
  exitCode: number | null;
};

export type CandidateReadiness = {
  ready: boolean;
  fatal: string | null;
  summary: Record<string, ComposeServiceState | null>;
};

const TOKEN_PATTERN = /^[a-z0-9]{12,24}$/u;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const RUNNING_SERVICES = ["postgres", "app", "worker"] as const;

export function createCandidateIdentity(token: string, version: string): CandidateIdentity {
  if (!TOKEN_PATTERN.test(token)) throw new Error("LOCAL_RELEASE_TOKEN_INVALID");
  if (!VERSION_PATTERN.test(version)) throw new Error("LOCAL_RELEASE_VERSION_INVALID");
  const projectName = `${LOCAL_RELEASE_PROJECT_PREFIX}${token}`;
  const identity: CandidateIdentity = {
    token,
    version,
    projectName,
    workerName: `${projectName}-worker`,
    volumes: {
      postgres: `${projectName}-pgdata`,
      secrets: `${projectName}-secrets`,
      uploads: `${projectName}-uploads`,
    },
    images: {
      migrate: `${projectName}-migrate:${version}`,
      app: `${projectName}-app:${version}`,
      worker: `${projectName}-worker:${version}`,
    },
  };
  assertSafeCandidateIdentity(identity);
  return identity;
}

export function assertSafeCandidateIdentity(identity: CandidateIdentity): void {
  if (!TOKEN_PATTERN.test(identity.token) || !VERSION_PATTERN.test(identity.version)) {
    throw new Error("LOCAL_RELEASE_IDENTITY_UNSAFE");
  }
  const expected = `${LOCAL_RELEASE_PROJECT_PREFIX}${identity.token}`;
  if (identity.projectName !== expected || identity.workerName !== `${expected}-worker`) {
    throw new Error("LOCAL_RELEASE_IDENTITY_UNSAFE");
  }
  const expectedValues = [
    `${expected}-pgdata`,
    `${expected}-secrets`,
    `${expected}-uploads`,
    `${expected}-migrate:${identity.version}`,
    `${expected}-app:${identity.version}`,
    `${expected}-worker:${identity.version}`,
  ];
  const actualValues = [
    identity.volumes.postgres,
    identity.volumes.secrets,
    identity.volumes.uploads,
    identity.images.migrate,
    identity.images.app,
    identity.images.worker,
  ];
  if (!actualValues.every((value, index) => value === expectedValues[index])) {
    throw new Error("LOCAL_RELEASE_IDENTITY_UNSAFE");
  }
}

function normalizeComposeEntry(value: unknown): ComposeServiceState {
  if (!value || typeof value !== "object") throw new Error("LOCAL_RELEASE_COMPOSE_STATUS_INVALID");
  const entry = value as Record<string, unknown>;
  const service = entry.Service;
  const state = entry.State;
  const health = entry.Health ?? "";
  const rawExitCode = entry.ExitCode;
  if (typeof service !== "string" || typeof state !== "string" || typeof health !== "string") {
    throw new Error("LOCAL_RELEASE_COMPOSE_STATUS_INVALID");
  }
  const exitCode = rawExitCode === undefined || rawExitCode === null || rawExitCode === ""
    ? null
    : Number(rawExitCode);
  if (exitCode !== null && !Number.isInteger(exitCode)) {
    throw new Error("LOCAL_RELEASE_COMPOSE_STATUS_INVALID");
  }
  return {
    service,
    state: state.toLowerCase(),
    health: health.toLowerCase(),
    exitCode,
  };
}

export function parseComposePs(output: string): ComposeServiceState[] {
  const trimmed = output.trim();
  if (!trimmed) return [];
  let values: unknown[];
  try {
    const parsed = trimmed.startsWith("[")
      ? JSON.parse(trimmed)
      : trimmed.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
    values = Array.isArray(parsed) ? parsed : [parsed];
  } catch (error) {
    throw new Error("LOCAL_RELEASE_COMPOSE_STATUS_INVALID", { cause: error });
  }
  return values.map(normalizeComposeEntry);
}

export function evaluateCandidateReadiness(entries: ComposeServiceState[]): CandidateReadiness {
  const byService = new Map<string, ComposeServiceState>();
  for (const entry of entries) {
    if (byService.has(entry.service)) {
      throw new Error(`LOCAL_RELEASE_COMPOSE_STATUS_DUPLICATE:${entry.service}`);
    }
    byService.set(entry.service, entry);
  }
  const summary: Record<string, ComposeServiceState | null> = {};
  for (const service of [...RUNNING_SERVICES, "migrate"]) summary[service] = byService.get(service) ?? null;

  const migrate = byService.get("migrate");
  if (migrate?.state === "exited" && migrate.exitCode !== 0) {
    return { ready: false, fatal: `migrate exited ${migrate.exitCode ?? "unknown"}`, summary };
  }
  for (const service of RUNNING_SERVICES) {
    const entry = byService.get(service);
    if (entry && ["dead", "exited", "removing"].includes(entry.state)) {
      return { ready: false, fatal: `${service} entered ${entry.state}`, summary };
    }
  }
  const runningReady = RUNNING_SERVICES.every((service) => {
    const entry = byService.get(service);
    return entry?.state === "running" && entry.health === "healthy";
  });
  const migrationReady = migrate?.state === "exited" && migrate.exitCode === 0;
  return { ready: runningReady && migrationReady, fatal: null, summary };
}

export function readCoherentVersion(
  packageJsonSource: string,
  appVersionSource: string,
  dockerfileSource: string,
): string {
  let packageVersion: unknown;
  try {
    packageVersion = (JSON.parse(packageJsonSource) as { version?: unknown }).version;
  } catch (error) {
    throw new Error("LOCAL_RELEASE_PACKAGE_VERSION_INVALID", { cause: error });
  }
  const appVersion = appVersionSource.match(/APP_VERSION\s*=\s*"([^"]+)"/u)?.[1];
  const imageVersion = dockerfileSource.match(/org\.opencontainers\.image\.version="([^"]+)"/u)?.[1];
  if (typeof packageVersion !== "string" || !VERSION_PATTERN.test(packageVersion)) {
    throw new Error("LOCAL_RELEASE_PACKAGE_VERSION_INVALID");
  }
  if (packageVersion !== appVersion || packageVersion !== imageVersion) {
    throw new Error("LOCAL_RELEASE_VERSION_MISMATCH");
  }
  return packageVersion;
}
