import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import test from "node:test";
import { prepareReleaseImagesForCheck } from "../scripts/local-release-images";

function localManifest(version: string, revision: string, runId: number) {
  return {
    schema: 1,
    version,
    revision,
    runId,
    images: {
      app: { ref: `ai-project-os-ci/app:${revision}`, id: `sha256:${"a".repeat(64)}` },
      worker: { ref: `ai-project-os-ci/worker:${revision}`, id: `sha256:${"b".repeat(64)}` },
      migrate: { ref: `ai-project-os-ci/migrate:${revision}`, id: `sha256:${"c".repeat(64)}` },
    },
  };
}

test("standalone release checks build one shared image graph and prepare a local identity manifest", async () => {
  const version = "1.0.6";
  const revision = "a".repeat(40);
  const calls: Array<{ command: string; args: readonly string[]; environment: NodeJS.ProcessEnv }> = [];
  const environment: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    CI: "false",
    GITHUB_ACTIONS: "false",
    RELEASE_IMAGES_MANIFEST: "",
  };
  const manifest = await prepareReleaseImagesForCheck(version, revision, {
    environment,
    runCommand: async (command, args, childEnvironment) => {
      calls.push({ command, args, environment: childEnvironment });
      if (args[0] === "--import") {
        const outputPath = args.at(-1);
        assert.ok(outputPath);
        await writeFile(outputPath, JSON.stringify(localManifest(version, revision, Number(childEnvironment.GITHUB_RUN_ID))), { flag: "wx" });
      }
    },
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.command, "docker");
  assert.deepEqual(calls[0]?.args, ["buildx", "bake", "--file", "docker-bake.hcl", "--load", "app", "worker", "migrate"]);
  assert.equal(calls[1]?.args[0], "--import");
  assert.equal(calls[0]?.environment.APP_VERSION, version);
  assert.equal(calls[0]?.environment.APP_REVISION, revision);
  assert.equal(calls[0]?.environment.GITHUB_SHA, revision);
  assert.equal(Number.isSafeInteger(manifest.runId), true);
  assert.equal(manifest.version, version);
  assert.equal(manifest.revision, revision);
  assert.equal(manifest.images.app.ref, `ai-project-os-ci/app:${revision}`);
});

test("CI refuses to rebuild when the exact-run release image manifest is missing", async () => {
  let commands = 0;
  await assert.rejects(
    prepareReleaseImagesForCheck("1.0.6", "a".repeat(40), {
      environment: { NODE_ENV: "test", CI: "true", GITHUB_ACTIONS: "true", RELEASE_IMAGES_MANIFEST: "" },
      runCommand: async () => { commands += 1; },
    }),
    /RELEASE_IMAGES_MANIFEST_REQUIRED/u,
  );
  assert.equal(commands, 0);
});
