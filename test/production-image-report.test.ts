import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseImageMaintenanceReport } from "../scripts/production-cache-maintenance.mjs";

const revision = "a".repeat(40);
const digest = "b".repeat(64);
const hash = "d".repeat(64);
const current = `sha256:${"c".repeat(64)}`;
const previous = `sha256:${"e".repeat(64)}`;
const scope = Array.from({ length: 17 }, (_, index) => `sha256:${(index + 1).toString(16).padStart(64, "0")}`);
const context = { tag: "v1.0.9", version: "1.0.9", revision, migrationCount: 146 };

function image(id: string, present: boolean) {
  return { id, present, version: present ? "0.7.18" : null, service: present ? "app" : null,
    sourceKind: present ? "legacy" : "unknown", ownership: present ? "confirmed" : "missing",
    ownershipReasons: present ? [] : ["image-missing"],
    recognizedRepoTags: present ? ["docker.io/library/ai-project-os-app:0.7.18"] : [],
    recognizedRepoDigests: present ? [`docker.io/library/ai-project-os-app@sha256:${hash}`] : [],
    unknownRefCount: 0, unknownRefsSha256: hash,
    containerReferences: [] as { id: string; status: string }[], sizeBytes: present ? 1000 : 0,
    platform: present ? { os: "linux", architecture: "amd64" } : null,
    eligible: present, retainReasons: present ? [] : ["image-missing"], fingerprint: hash };
}

function summary(images: ReturnType<typeof image>[]) {
  return { scopeCount: 17, presentCount: images.filter((item) => item.present).length,
    missingCount: images.filter((item) => !item.present).length,
    ownershipConfirmedCount: images.filter((item) => item.ownership === "confirmed").length,
    eligibleCount: images.filter((item) => item.eligible).length,
    referencedCount: images.filter((item) => item.containerReferences.length > 0).length,
    retainedCount: images.filter((item) => !item.eligible).length,
    sumImageSizeBytes: images.reduce((sum, item) => sum + item.sizeBytes, 0) };
}

function inspect() {
  const images = scope.map((id, index) => image(id, index === 0));
  return { schema: 1, operation: "image-inspect", tag: context.tag, revision,
    scopeIds: [...scope], planDigest: digest, images, summary: summary(images),
    protection: { planDigest: digest, scopeIds: [...scope],
      currentImageIds: [current], previousImageIds: [previous], previousTag: "v1.0.8", previousRevision: "f".repeat(40),
      ownedImageIds: [current, previous].sort(), ownedImageCount: 2,
      unverifiedImages: [{ id: scope[0], reasons: ["legacy-digests"] }], unverifiedImageCount: 1,
      allImageIds: [current, previous, scope[0]].sort(), containerReferencesSha256: hash,
      containerCount: 7, containerSnapshotSha256: hash, volumeCount: 3, volumeSnapshotSha256: hash,
      postgresId: hash, migrationCount: 146, migrationManifestSha256: hash,
      configHashes: { production_env: hash }, checkoutRevision: revision, deploymentReceiptSha256: hash } };
}

function clean() {
  const before = inspect();
  const imagesAfter = scope.map((id) => image(id, false));
  return { schema: 1, operation: "image-clean", tag: context.tag, revision,
    scopeIds: [...scope], planDigest: digest, summaryBefore: before.summary, summaryAfter: summary(imagesAfter),
    imagesAfter, removedIds: [scope[0]], retainedIds: [] as string[], changedIds: [], newlyReferencedIds: [],
    vanishedIds: [], newlyAppearedIds: [], engineRefusedIds: [] as string[], attemptedIds: [scope[0]],
    failureReasons: {} as Record<string, string>, expiredBeforeNextDelete: false, allImageInventoryDrift: false,
    availableBytesBefore: 1000, availableBytesAfter: 1600, netAvailableBytesDelta: 600, protectionVerified: true,
    checks: { localHealth: true, publicHealth: true, database: true, worker: true, migrationLedger: true },
    protection: { ...before.protection, allImageIds: [current, previous].sort(), unverifiedImages: [], unverifiedImageCount: 0 } };
}
const line = (value: unknown) => `IMAGE_MAINTENANCE_REPORT ${JSON.stringify(value)}\n`;

test("image inspection validates fixed scope, ownership evidence and all-image inventory", () => {
  assert.equal(parseImageMaintenanceReport(line(inspect()), "image-inspect", context).summary.eligibleCount, 1);
  const mutations = [
    (value: ReturnType<typeof inspect>) => { value.scopeIds.pop(); },
    (value: ReturnType<typeof inspect>) => { value.scopeIds[1] = value.scopeIds[0]; },
    (value: ReturnType<typeof inspect>) => { value.images[0].recognizedRepoTags = ["foreign/private:secret"]; },
    (value: ReturnType<typeof inspect>) => { value.images[0].containerReferences = [{ id: hash, status: "exited" }]; },
    (value: ReturnType<typeof inspect>) => { value.images[0].ownership = "unconfirmed"; },
    (value: ReturnType<typeof inspect>) => { value.images[0].ownershipReasons = ["untrusted raw output"]; },
    (value: ReturnType<typeof inspect>) => { value.summary.sumImageSizeBytes = 1001; },
    (value: ReturnType<typeof inspect>) => { value.protection.allImageIds = [current, previous].sort(); },
    (value: ReturnType<typeof inspect>) => { value.revision = "0".repeat(40); },
    (value: ReturnType<typeof inspect>) => { value.protection.migrationCount = 145; },
  ];
  for (const mutate of mutations) {
    const value = inspect(); mutate(value);
    assert.throws(() => parseImageMaintenanceReport(line(value), "image-inspect", context));
  }
  assert.throws(() => parseImageMaintenanceReport(line(inspect()) + line(inspect()), "image-inspect", context));
});

test("image cleanup binds the inspected plan and preserves versions, parents, containers and data volumes", () => {
  assert.equal(parseImageMaintenanceReport(line(clean()), "image-clean", context, digest, inspect()).removedIds.length, 1);
  const mutations = [
    (value: ReturnType<typeof clean>) => { value.planDigest = "0".repeat(64); },
    (value: ReturnType<typeof clean>) => { value.removedIds = [current]; },
    (value: ReturnType<typeof clean>) => { value.protection.currentImageIds = [previous]; },
    (value: ReturnType<typeof clean>) => { value.protection.containerSnapshotSha256 = "0".repeat(64); },
    (value: ReturnType<typeof clean>) => { value.protection.volumeSnapshotSha256 = "0".repeat(64); },
    (value: ReturnType<typeof clean>) => { value.protection.allImageIds.push(`sha256:${"9".repeat(64)}`); },
    (value: ReturnType<typeof clean>) => { value.expiredBeforeNextDelete = true; },
    (value: ReturnType<typeof clean>) => { value.allImageInventoryDrift = true; },
    (value: ReturnType<typeof clean>) => { value.protectionVerified = false; },
    (value: ReturnType<typeof clean>) => { value.checks.worker = false; },
    (value: ReturnType<typeof clean>) => { value.netAvailableBytesDelta = 1000; },
  ];
  for (const mutate of mutations) {
    const value = clean(); mutate(value);
    assert.throws(() => parseImageMaintenanceReport(line(value), "image-clean", context, digest, inspect()));
  }
});

test("engine refusal is reported as retained and never counted as a deleted image", () => {
  const before = inspect();
  const value = { ...clean(), imagesAfter: before.images, summaryAfter: before.summary,
    removedIds: [], retainedIds: [scope[0]], engineRefusedIds: [scope[0]],
    failureReasons: { [scope[0]]: "engine-refused" }, protection: before.protection,
    availableBytesAfter: 1000, netAvailableBytesDelta: 0 };
  const parsed = parseImageMaintenanceReport(line(value), "image-clean", context, digest, before);
  assert.equal(parsed.removedIds.length, 0);
  assert.equal(parsed.engineRefusedIds.length, 1);
});

test("image clean CLI reads the pretty-printed inspection artifact before accepting the result", () => {
  const directory = mkdtempSync(join(tmpdir(), "ai-project-os-image-report-"));
  try {
    const beforePath = join(directory, "inspect.json");
    const logPath = join(directory, "clean.log");
    const resultPath = join(directory, "clean.json");
    writeFileSync(beforePath, JSON.stringify(inspect(), null, 2) + "\n");
    writeFileSync(logPath, line(clean()));
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "test",
      GITHUB_REPOSITORY: "Jack-Kunlun/ai-project-os", GITHUB_REF: "refs/heads/main", GITHUB_SHA: "1".repeat(40),
      CACHE_MAINTENANCE_OPERATION: "images-clean", PRODUCTION_SOURCE_VERSION: context.version,
      PRODUCTION_SOURCE_SHA: revision, RELEASE_VERSION: "1.0.10", SOURCE_MIGRATION_COUNT: "146",
      PRODUCTION_SSH_HOST: "192.0.2.1", IMAGE_PLAN_DIGEST: digest,
      GITHUB_STEP_SUMMARY: join(directory, "summary.md") };
    const result = spawnSync(process.execPath, ["scripts/production-cache-maintenance.mjs", "parse-image-clean",
      logPath, resultPath, beforePath], { env, encoding: "utf8", timeout: 15_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(readFileSync(resultPath, "utf8")).removedIds.length, 1);
    assert.match(readFileSync(env.GITHUB_STEP_SUMMARY!, "utf8"), /删除 1 个镜像/u);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("image actions reuse the production lock and credentials without invoking application release", () => {
  const workflow = readFileSync(".github/workflows/release-stable.yml", "utf8");
  const maintenance = workflow.slice(workflow.indexOf("  cache-maintenance:"));
  assert.match(workflow, /default: release/u);
  assert.match(workflow, /- images-inspect\n          - images-clean/u);
  assert.match(maintenance, /inspect-images \$CACHE_CURRENT_TAG \$CACHE_CURRENT_REVISION CONFIRM_IMAGE_INSPECT/u);
  assert.match(maintenance, /clean-images \$CACHE_CURRENT_TAG \$CACHE_CURRENT_REVISION \$IMAGE_PLAN_DIGEST/u);
  assert.match(maintenance, /parse-image-clean [\s\S]*?image-maintenance\/inspect\.json/u);
  assert.match(maintenance, /if: \$\{\{ inputs.operation == 'images-clean' \}\}/u);
  assert.match(maintenance, /name: production-image-maintenance\n          path: \$\{\{ runner.temp \}\}\/image-maintenance\//u);
  assert.doesNotMatch(maintenance, /contents: write|packages: write|ensure-tag|deploy-stable|prisma migrate|docker /u);
  assert.match(workflow, /group: ai-project-os-production\n  cancel-in-progress: false/u);
  assert.match(maintenance, /Remove the temporary maintenance SSH identity\n        if: \$\{\{ always\(\) \}\}/u);
});

test("legacy reference reports require the exact inspected ID, version, service and references", () => {
  const fixtures = JSON.parse(readFileSync(new URL("./fixtures/production-historical-image-references.json", import.meta.url), "utf8")) as {
    id: string; version: string; service: string; tag: string; digest: string;
  }[];
  assert.equal(fixtures.length, 10);
  for (const fixture of fixtures) {
    const value = inspect();
    value.scopeIds[0] = fixture.id;
    Object.assign(value.images[0], { id: fixture.id, version: fixture.version, service: fixture.service,
      recognizedRepoTags: [fixture.tag], recognizedRepoDigests: [fixture.digest] });
    value.protection.scopeIds = [...value.scopeIds];
    value.protection.unverifiedImages[0].id = fixture.id;
    value.protection.allImageIds = [current, previous, fixture.id].sort();
    assert.equal(parseImageMaintenanceReport(line(value), "image-inspect", context).images[0].ownership, "confirmed");
    const mutations = [
      (candidate: ReturnType<typeof inspect>) => {
        const id = `sha256:${"8".repeat(64)}`;
        candidate.scopeIds[0] = id; candidate.images[0].id = id;
        candidate.protection.scopeIds = [...candidate.scopeIds];
        candidate.protection.unverifiedImages[0].id = id;
        candidate.protection.allImageIds = [current, previous, id].sort();
      },
      (candidate: ReturnType<typeof inspect>) => { candidate.images[0].version = "0.0.1"; },
      (candidate: ReturnType<typeof inspect>) => { candidate.images[0].service = "principal-bootstrap"; },
      (candidate: ReturnType<typeof inspect>) => { candidate.images[0].recognizedRepoTags[0] += "-unverified"; },
      (candidate: ReturnType<typeof inspect>) => {
        candidate.images[0].recognizedRepoDigests[0] = fixture.digest.slice(0, -1) + (fixture.digest.endsWith("0") ? "1" : "0");
      },
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(value); mutate(changed);
      assert.throws(() => parseImageMaintenanceReport(line(changed), "image-inspect", context), fixture.id);
    }
  }
});
