import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("CI compiles the Next app once and reuses the same release images for browser and candidate checks", async () => {
  const [workflow, dockerfile, bake, browserRunner, candidateRunner, localImageResolver] = await Promise.all([
    readFile(".github/workflows/ci.yml", "utf8"),
    readFile("Dockerfile", "utf8"),
    readFile("docker-bake.hcl", "utf8"),
    readFile("scripts/run-browser-e2e.ts", "utf8"),
    readFile("scripts/run-local-release.ts", "utf8"),
    readFile("scripts/local-release-images.ts", "utf8"),
  ]);

  assert.match(workflow, /build-images:[\s\S]*?name: Build and verify release images/u);
  assert.doesNotMatch(workflow, /RELEASE_IMAGES_MANIFEST: \$\{\{ runner\.temp \}\}/u);
  assert.match(workflow, /printf 'RELEASE_IMAGES_MANIFEST=%s\/release-images\.local\.json\\n' "\$RUNNER_TEMP" >> "\$GITHUB_ENV"/u);
  assert.match(workflow, /if: \$\{\{ !startsWith\(github\.ref, 'refs\/tags\/'\) \}\}/u);
  assert.match(workflow, /docker\/setup-buildx-action@4d04d5d9486b7bd6fa91e7baf45bbb4f8b9deedd/u);
  assert.match(workflow, /docker\/bake-action@018cb6412ab401ebaa809aa5f85966b74628600f/u);
  assert.match(workflow, /targets: app,worker,migrate\s+load: true/u);
  assert.match(workflow, /\*\.cache-from=type=gha,scope=release-images/u);
  assert.match(workflow, /\*\.cache-to=type=gha,scope=release-images,mode=max,ignore-error=true/u);
  assert.match(workflow, /targets: performance-export/u);
  assert.match(workflow, /performance-export\.output=type=local,dest=\$\{\{ runner\.temp \}\}\/ci-performance/u);
  assert.equal([...dockerfile.matchAll(/RUN NODE_OPTIONS=--max-old-space-size=6144 pnpm build/gu)].length, 1);
  assert.match(bake, /target "app"[\s\S]*?target\s+= "runner"/u);
  assert.match(bake, /target "worker"[\s\S]*?target\s+= "worker"/u);
  assert.match(bake, /target "migrate"[\s\S]*?target\s+= "migrate"/u);
  assert.match(bake, /target "performance-export"[\s\S]*?target\s+= "performance-export"/u);
  assert.match(browserRunner, /manifest\.images\.app\.id/u);
  assert.match(browserRunner, /manifest\.images\.worker\.id/u);
  assert.match(candidateRunner, /manifest\.images\.app\.id/u);
  assert.match(candidateRunner, /manifest\.images\.migrate\.id/u);
  assert.match(candidateRunner, /"--no-build"/u);
  assert.match(browserRunner, /prepareReleaseImagesForCheck\(packageVersion, revision\)/u);
  assert.match(candidateRunner, /prepareReleaseImagesForCheck\(version, revision\)/u);
  assert.match(localImageResolver, /environment\.CI === "true" \|\| environment\.GITHUB_ACTIONS === "true"/u);
  assert.match(localImageResolver, /RELEASE_IMAGES_MANIFEST_REQUIRED/u);
  assert.match(localImageResolver, /docker", \["buildx", "bake"[\s\S]*?app", "worker", "migrate"/u);
  assert.doesNotMatch(browserRunner, /spawn\([^\n]*"pnpm"[^\n]*\["build"/u);
  assert.doesNotMatch(candidateRunner, /runProcess\("docker",\s*\["build"/u);
});

test("CI publishes immutable image metadata only from main and exposes the documented artifact", async () => {
  const workflow = await readFile(".github/workflows/ci.yml", "utf8");
  const manifest = await readFile("scripts/release-image-manifest.ts", "utf8");
  assert.match(workflow, /Publish immutable images for manual release workflow[\s\S]*?if: \$\{\{ github\.event_name == 'push' && github\.ref == 'refs\/heads\/main' \}\}/u);
  assert.match(workflow, /name: release-images\s+path: \$\{\{ runner\.temp \}\}\/release-images\.json/u);
  assert.match(workflow, /packages: write/u);
  assert.match(manifest, /ref: string; id: string/u);
  assert.match(manifest, /ghcr\.io\/jack-kunlun\/ai-project-os-app/u);
  assert.match(manifest, /ghcr\.io\/jack-kunlun\/ai-project-os-worker/u);
  assert.match(manifest, /ghcr\.io\/jack-kunlun\/ai-project-os-migrate/u);
  assert.match(manifest, /RELEASE_IMAGE_MANIFEST_RUN_ID_MISMATCH/u);
});

test("the release gate rejects mismatched test plans or missing execution receipts", async () => {
  const workflow = await readFile(".github/workflows/ci.yml", "utf8");
  const imageJob = workflow.split("  build-images:\n", 2)[1]!.split("  verify:\n", 1)[0]!;
  assert.doesNotMatch(imageJob.split("    steps:\n", 1)[0]!, /\$\{\{ runner\./u);
  assert.match(imageJob, /CI_TEST_PLAN=%s\/ci-test-plan\.json/u);
  assert.match(imageJob, /CI_TEST_RECEIPT=%s\/ci-browser-receipt\.json/u);
  const step = workflow.slice(workflow.indexOf("      - name: Require every applicable gate and the exact-sha image job"));
  const program = step.slice(step.indexOf("        run: |\n") + "        run: |\n".length)
    .split("\n  tag-attestation:")[0].replace(/^ {10}/gmu, "");
  const environment = {
    ...process.env, SCOPE_RESULT: "success", SOURCE_RESULT: "success", IMAGE_RESULT: "success",
    DATABASE_RESULT: "skipped", DATABASE_REQUIRED: "false", RISK: "medium", BASE: "a".repeat(40),
    SOURCE_PLAN_FINGERPRINT: "b".repeat(64), IMAGE_PLAN_FINGERPRINT: "b".repeat(64),
    SOURCE_BROWSER_MODE: "selected", IMAGE_BROWSER_MODE: "selected", UNIT_MODE: "selected",
    UNIT_RECEIPT_FINGERPRINT: "c".repeat(64), BROWSER_RECEIPT_FINGERPRINT: "d".repeat(64),
  };
  const run = (override: Record<string, string | undefined> = {}) => spawnSync("bash", ["-c", program], {
    encoding: "utf8", env: { ...environment, ...override },
  });
  assert.equal(run().status, 0);
  for (const invalid of [
    { IMAGE_PLAN_FINGERPRINT: "e".repeat(64) }, { UNIT_RECEIPT_FINGERPRINT: "" },
    { BROWSER_RECEIPT_FINGERPRINT: "" }, { IMAGE_BROWSER_MODE: "none" },
    { UNIT_MODE: "unknown" }, { SOURCE_RESULT: "failure" },
    { DATABASE_REQUIRED: "true" }, { BASE: "unknown" },
  ]) assert.notEqual(run(invalid).status, 0, JSON.stringify(invalid));
  assert.equal(run({ RISK: "high", DATABASE_REQUIRED: "true", DATABASE_RESULT: "success" }).status, 0);
});
