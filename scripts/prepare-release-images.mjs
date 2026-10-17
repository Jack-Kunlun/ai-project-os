import { writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const SHA40_PATTERN = /^[a-f0-9]{40}$/u;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const IMAGE_NAMES = ["app", "worker", "migrate"];

function runDocker(args) {
  const result = spawnSync("docker", args, { encoding: "utf8", maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`RELEASE_IMAGE_INSPECT_FAILED:${args[0]}`);
  return result.stdout.trim();
}

function main() {
  const [outputPath] = process.argv.slice(2);
  const revision = process.env.GITHUB_SHA ?? "";
  const version = process.env.APP_VERSION ?? "";
  const runId = Number(process.env.GITHUB_RUN_ID);
  if (!outputPath || !SHA40_PATTERN.test(revision) || !/^[1-9]\d*\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(version)
      || !Number.isSafeInteger(runId) || runId <= 0) {
    throw new Error("RELEASE_IMAGE_IDENTITY_REQUIRED");
  }
  const images = {};
  for (const name of IMAGE_NAMES) {
    const ref = `ai-project-os-ci/${name}:${revision}`;
    const inspected = runDocker(["image", "inspect", ref, "--format", '{{.Id}}|{{ index .Config.Labels "org.opencontainers.image.version" }}|{{ index .Config.Labels "org.opencontainers.image.revision" }}|{{ index .Config.Labels "org.opencontainers.image.source" }}']);
    const [id, imageVersion, imageRevision, source, ...rest] = inspected.split("|");
    if (rest.length !== 0 || !SHA256_PATTERN.test(id ?? "") || imageVersion !== version || imageRevision !== revision
        || source !== "https://github.com/Jack-Kunlun/ai-project-os") {
      throw new Error(`RELEASE_IMAGE_IDENTITY_MISMATCH:${name}`);
    }
    images[name] = { ref, id };
  }
  const manifest = { schema: 1, revision, version, runId, images };
  writeFileSync(resolve(outputPath), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  process.stdout.write(`RELEASE_IMAGES_READY revision=${revision} version=${version} runId=${runId}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "RELEASE_IMAGE_PREPARE_FAILED"}\n`);
  process.exitCode = 1;
}
