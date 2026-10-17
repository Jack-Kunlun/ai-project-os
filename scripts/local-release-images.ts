import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseReleaseImageManifest, type ReleaseImageManifest } from "./release-image-manifest";

type RunCommand = (command: string, args: readonly string[], environment: NodeJS.ProcessEnv) => Promise<void>;

type PrepareOptions = {
  environment?: NodeJS.ProcessEnv;
  runCommand?: RunCommand;
};

function runCommand(command: string, args: readonly string[], environment: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: process.cwd(),
      env: environment,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`LOCAL_RELEASE_IMAGE_COMMAND_FAILED:${args[0] ?? command}:${code ?? 1}`));
    });
  });
}

async function readManifest(
  path: string,
  version: string,
  revision: string,
  expectedRunId?: number,
): Promise<ReleaseImageManifest> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error("RELEASE_IMAGE_MANIFEST_UNREADABLE", { cause: error });
  }
  return parseReleaseImageManifest(parsed, {
    expectedRevision: revision,
    expectedVersion: version,
    expectedRunId,
    allowLocalRefs: true,
  });
}

function expectedRunId(environment: NodeJS.ProcessEnv): number | undefined {
  const raw = environment.GITHUB_RUN_ID;
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("RELEASE_IMAGES_RUN_ID_INVALID");
  return value;
}

export async function prepareReleaseImagesForCheck(
  version: string,
  revision: string,
  options: PrepareOptions = {},
): Promise<ReleaseImageManifest> {
  const environment = options.environment ?? process.env;
  const configuredManifest = environment.RELEASE_IMAGES_MANIFEST;
  if (configuredManifest) {
    return readManifest(configuredManifest, version, revision, expectedRunId(environment));
  }

  if (environment.CI === "true" || environment.GITHUB_ACTIONS === "true") {
    throw new Error("RELEASE_IMAGES_MANIFEST_REQUIRED");
  }

  const localRunId = expectedRunId(environment) ?? process.pid;
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "ai-project-os-local-images-"));
  const manifestPath = join(temporaryDirectory, "release-images.json");
  const childEnvironment: NodeJS.ProcessEnv = {
    ...environment,
    APP_VERSION: version,
    APP_REVISION: revision,
    GITHUB_SHA: revision,
    GITHUB_RUN_ID: String(localRunId),
  };
  const execute = options.runCommand ?? runCommand;

  try {
    await execute("docker", ["buildx", "bake", "--file", "docker-bake.hcl", "--load", "app", "worker", "migrate"], childEnvironment);
    await execute(process.execPath, ["--import", "tsx", "scripts/prepare-release-images.mjs", manifestPath], childEnvironment);
    return await readManifest(manifestPath, version, revision, localRunId);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
