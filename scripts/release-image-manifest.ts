import { readFile } from "node:fs/promises";

export type ReleaseImageName = "app" | "worker" | "migrate";

export type ReleaseImageManifest = {
  schema: 1;
  revision: string;
  version: string;
  runId: number;
  images: Record<ReleaseImageName, { ref: string; id: string }>;
};

const SHA40_PATTERN = /^[a-f0-9]{40}$/u;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const VERSION_PATTERN = /^[1-9]\d*\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const REPOSITORIES: Record<ReleaseImageName, string> = {
  app: "ghcr.io/jack-kunlun/ai-project-os-app",
  worker: "ghcr.io/jack-kunlun/ai-project-os-worker",
  migrate: "ghcr.io/jack-kunlun/ai-project-os-migrate",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseReleaseImageManifest(
  value: unknown,
  options: { expectedRevision: string; expectedVersion: string; expectedRunId?: number; allowLocalRefs?: boolean },
): ReleaseImageManifest {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== "images,revision,runId,schema,version"
      || value.schema !== 1 || value.revision !== options.expectedRevision
      || !SHA40_PATTERN.test(String(value.revision)) || value.version !== options.expectedVersion
      || !VERSION_PATTERN.test(String(value.version)) || !Number.isSafeInteger(value.runId) || Number(value.runId) <= 0) {
    throw new Error("RELEASE_IMAGE_MANIFEST_IDENTITY_INVALID");
  }
  if (options.expectedRunId !== undefined && value.runId !== options.expectedRunId) {
    throw new Error("RELEASE_IMAGE_MANIFEST_RUN_ID_MISMATCH");
  }
  if (!isRecord(value.images) || Object.keys(value.images).sort().join(",") !== "app,migrate,worker") {
    throw new Error("RELEASE_IMAGE_MANIFEST_IMAGES_INVALID");
  }
  const images = {} as ReleaseImageManifest["images"];
  for (const name of ["app", "worker", "migrate"] as const) {
    const image = value.images[name];
    if (!isRecord(image) || typeof image.ref !== "string" || typeof image.id !== "string" || !SHA256_PATTERN.test(image.id)) {
      throw new Error(`RELEASE_IMAGE_MANIFEST_IMAGE_INVALID:${name}`);
    }
    const officialPrefix = `${REPOSITORIES[name]}@`;
    const officialReference = image.ref.startsWith(officialPrefix)
      && SHA256_PATTERN.test(image.ref.slice(officialPrefix.length));
    const localReference = new RegExp(`^ai-project-os-ci/${name}:${options.expectedRevision}$`, "u");
    if (!officialReference && !(options.allowLocalRefs === true && localReference.test(image.ref))) {
      throw new Error(`RELEASE_IMAGE_MANIFEST_REFERENCE_INVALID:${name}`);
    }
    images[name] = { ref: image.ref, id: image.id };
  }
  return {
    schema: 1,
    revision: value.revision,
    version: value.version,
    runId: Number(value.runId),
    images,
  };
}

export async function loadReleaseImageManifest(
  version: string,
  revision: string,
  path = process.env.RELEASE_IMAGES_MANIFEST,
): Promise<ReleaseImageManifest> {
  if (typeof path !== "string" || path.length === 0) throw new Error("RELEASE_IMAGES_MANIFEST_REQUIRED");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error("RELEASE_IMAGES_MANIFEST_UNREADABLE", { cause: error });
  }
  const rawRunId = process.env.GITHUB_RUN_ID;
  const expectedRunId = rawRunId === undefined ? undefined : Number(rawRunId);
  if (rawRunId !== undefined && (!Number.isSafeInteger(expectedRunId) || Number(expectedRunId) <= 0)) {
    throw new Error("RELEASE_IMAGES_RUN_ID_INVALID");
  }
  return parseReleaseImageManifest(parsed, {
    expectedRevision: revision,
    expectedVersion: version,
    expectedRunId,
    allowLocalRefs: true,
  });
}

export function expectedReleaseImageRepository(name: ReleaseImageName): string {
  return REPOSITORIES[name];
}
