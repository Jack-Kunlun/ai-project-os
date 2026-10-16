import { readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { parseReleaseImageManifest, expectedReleaseImageRepository } from "./release-image-manifest.ts";

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;

function runDocker(args, { capture = false } = {}) {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error || result.status !== 0) {
    throw new Error(`RELEASE_IMAGE_DOCKER_FAILED:${args[0]}`);
  }
  return capture ? `${result.stdout}${result.stderr}` : "";
}

function inspectImage(imageId, version, revision) {
  const source = runDocker(["image", "inspect", imageId, "--format", "{{json .Config.Labels}}"], { capture: true }).trim();
  let labels;
  try {
    labels = JSON.parse(source);
  } catch (error) {
    throw new Error("RELEASE_IMAGE_LABELS_INVALID", { cause: error });
  }
  if (!labels || labels["org.opencontainers.image.version"] !== version
      || labels["org.opencontainers.image.revision"] !== revision
      || labels["org.opencontainers.image.source"] !== "https://github.com/Jack-Kunlun/ai-project-os") {
    throw new Error("RELEASE_IMAGE_LABELS_MISMATCH");
  }
}

function readDigest(pushOutput) {
  const matches = [...pushOutput.matchAll(/digest:\s*(sha256:[a-f0-9]{64})\b/gu)];
  const unique = [...new Set(matches.map((match) => match[1]))];
  if (unique.length !== 1 || !SHA256_PATTERN.test(unique[0] ?? "")) {
    throw new Error("RELEASE_IMAGE_PUSH_DIGEST_MISSING");
  }
  return unique[0];
}

function main() {
  const [inputPath, outputPath] = process.argv.slice(2);
  if (!inputPath || !outputPath) throw new Error("RELEASE_IMAGE_MANIFEST_PATH_REQUIRED");
  const local = parseReleaseImageManifest(JSON.parse(readFileSync(inputPath, "utf8")), {
    expectedRevision: process.env.GITHUB_SHA ?? "",
    expectedVersion: process.env.APP_VERSION ?? "",
    expectedRunId: Number(process.env.GITHUB_RUN_ID),
    allowLocalRefs: true,
  });
  const refs = {};
  for (const name of ["app", "worker", "migrate"]) {
    const image = local.images[name];
    inspectImage(image.id, local.version, local.revision);
    const repository = expectedReleaseImageRepository(name);
    const tag = `${repository}:${local.revision}`;
    runDocker(["tag", image.id, tag]);
    const output = runDocker(["push", tag], { capture: true });
    const digest = readDigest(output);
    refs[name] = { ref: `${repository}@${digest}`, id: image.id };
  }
  const manifest = { schema: 1, revision: local.revision, version: local.version, runId: local.runId, images: refs };
  const target = resolve(outputPath);
  const temporary = `${target}.tmp-${process.pid}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
  process.stdout.write(`RELEASE_IMAGES_PUBLISHED revision=${manifest.revision} version=${manifest.version} runId=${manifest.runId}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "RELEASE_IMAGE_PUBLISH_FAILED"}\n`);
  process.exitCode = 1;
}
