import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseRetiredContainerReport, sourceContext } from "../scripts/production-cache-maintenance.mjs";

const ids = ["456e94bcebb6e9c8ba47a412c8feebec1a8d3a869806e60e5ebcc4a8029867e2", "b81a7ac54512254f6872400128ebd77c5f90aa089eba93bb24c94b165e07feff"];
const images = ["sha256:3e3660173cabc686ed1e9ae1ffeadfba6b388707b141c49e7eb2b002c66a9266", "sha256:4ab705882c2fde74880c9e971e3a675a6176f29762307c4c7fb78be6a819d9e9"];
const services = ["reconcile", "migrate"];
const hash = "d".repeat(64);
const digest = "b".repeat(64);
const current = `sha256:${"1".repeat(64)}`;
const previous = `sha256:${"2".repeat(64)}`;
const other = "f".repeat(64);
const context = { tag: "v1.0.9", version: "1.0.9", revision: "a".repeat(40), migrationCount: 146 };
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const line = (value: unknown) => `RETIRED_CONTAINER_REPORT ${JSON.stringify(value)}\n`;

function protection(removed: string[] = []) {
  const inventory = ids.map((id, index) => ({ id, image: images[index], status: "exited", fingerprint: hash }))
    .concat([{ id: other, image: current, status: "running", fingerprint: hash }])
    .filter((item) => !removed.includes(item.id));
  return { planDigest: digest, currentImageIds: [current], previousImageIds: [previous],
    ownedImageIds: [current, previous], ownedImageCount: 2,
    unverifiedImages: images.map((id) => ({ id, reasons: ["legacy-tags"] })), unverifiedImageCount: 2,
    allImageIds: [current, previous, ...images].sort(), previousTag: "v1.0.8", previousRevision: "e".repeat(40),
    checkoutRevision: context.revision, postgresId: other, migrationCount: 146,
    migrationManifestSha256: hash, deploymentReceiptSha256: hash, configHashes: { production_env: hash },
    containerInventory: inventory, containerCount: inventory.length,
    containerSnapshotSha256: sha(inventory.map(({ id, image }) => ({ id, image }))),
    containerReferencesSha256: sha(inventory.map(({ id, image, status }) => ({ id, image, status }))),
    volumeCount: 3, volumeSnapshotSha256: hash };
}

function record(index: number, present = true) {
  const basic = { id: ids[index], image: images[index], service: services[index], version: "0.8.0-dev.4",
    purpose: services[index], present, eligible: present, fingerprint: hash,
    retainReasons: present ? [] : ["container-missing"] };
  return { ...basic, ...(present ? { status: "exited", exitCode: 0,
    startedAt: "2020-01-01T00:00:00Z", finishedAt: "2020-01-01T00:01:00Z", restartPolicy: "no",
    mountCount: 0, mountsSha256: hash, referencedByContainerIds: [] as string[],
    writableChanges: { count: 2, unexpectedCount: 0, sha256: hash, unexpectedSha256: hash } } : {}) };
}
function inspect() {
  return { schema: 1, operation: "retired-container-inspect", tag: context.tag, revision: context.revision,
    scopeIds: [...ids], planDigest: digest, records: [record(0), record(1)], protection: protection() };
}
function clean(removed: string[] = ids) {
  return { schema: 1, operation: "retired-container-clean", tag: context.tag, revision: context.revision,
    scopeIds: [...ids], planDigest: digest, recordsAfter: [record(0, !removed.includes(ids[0])), record(1, !removed.includes(ids[1]))],
    attemptedIds: [...ids], removedIds: [...removed], retainedIds: ids.filter((id) => !removed.includes(id)),
    engineRefused: ids.filter((id) => !removed.includes(id)).map((id) => ({ id, reason: "engine-refused" })),
    expired: false, protectionVerified: true,
    checks: { localHealth: true, publicHealth: true, database: true, worker: true, migrationLedger: true },
    availableBytesBefore: 1000, availableBytesAfter: 1200, netAvailableBytesDelta: 200,
    protection: protection(removed) };
}

test("retired inspection rejects unsafe scope, purpose, mounts, writable changes and protection identities", () => {
  assert.equal(parseRetiredContainerReport(line(inspect()), "retired-container-inspect", context).records.length, 2);
  const mutations = [
    (v: ReturnType<typeof inspect>) => { v.scopeIds[0] = other; },
    (v: ReturnType<typeof inspect>) => { v.records[0].purpose = "unknown"; },
    (v: ReturnType<typeof inspect>) => { v.records[0].status = "running"; },
    (v: ReturnType<typeof inspect>) => { v.records[0].exitCode = 1; },
    (v: ReturnType<typeof inspect>) => { v.records[0].mountCount = 1; },
    (v: ReturnType<typeof inspect>) => { v.records[0].writableChanges!.unexpectedCount = 1; },
    (v: ReturnType<typeof inspect>) => { v.records[0].referencedByContainerIds = [other]; },
    (v: ReturnType<typeof inspect>) => { v.records[0].finishedAt = new Date().toISOString(); },
    (v: ReturnType<typeof inspect>) => { v.protection.containerCount++; },
    (v: ReturnType<typeof inspect>) => { v.protection.containerInventory[0].fingerprint = "bad"; },
    (v: ReturnType<typeof inspect>) => { v.protection.currentImageIds = [images[0]]; v.protection.ownedImageIds.push(images[0]); v.protection.ownedImageCount++; },
  ];
  for (const mutate of mutations) {
    const v = inspect(); mutate(v);
    assert.throws(() => parseRetiredContainerReport(line(v), "retired-container-inspect", context));
  }
  assert.throws(() => parseRetiredContainerReport(line(inspect()) + line(inspect()), "retired-container-inspect", context));
  const diagnostic = inspect();
  Object.assign(diagnostic.protection.containerInventory[0], { fieldFingerprints: Array(29).fill(hash) });
  assert.equal(parseRetiredContainerReport(line(diagnostic), "retired-container-inspect", context).records.length, 2);
  for (const fieldFingerprints of [[hash], Array(29).fill("private-fixture")]) {
    Object.assign(diagnostic.protection.containerInventory[0], { fieldFingerprints });
    assert.throws(() => parseRetiredContainerReport(line(diagnostic), "retired-container-inspect", context));
  }
});

test("retired cleanup allows only exact selected container removal and preserves all image and volume identities", () => {
  assert.equal(parseRetiredContainerReport(line(clean()), "retired-container-clean", context, digest, inspect()).removedIds.length, 2);
  assert.equal(parseRetiredContainerReport(line(clean([])), "retired-container-clean", context, digest, inspect()).retainedIds.length, 2);
  const mutations = [
    (v: ReturnType<typeof clean>) => { v.planDigest = "0".repeat(64); },
    (v: ReturnType<typeof clean>) => { v.expired = true; },
    (v: ReturnType<typeof clean>) => { v.protectionVerified = false; },
    (v: ReturnType<typeof clean>) => { v.removedIds = [other]; },
    (v: ReturnType<typeof clean>) => { v.protection.allImageIds.pop(); },
    (v: ReturnType<typeof clean>) => { v.protection.volumeSnapshotSha256 = "0".repeat(64); },
    (v: ReturnType<typeof clean>) => { v.protection.configHashes.production_env = "0".repeat(64); },
    (v: ReturnType<typeof clean>) => { v.protection.migrationCount--; },
    (v: ReturnType<typeof clean>) => { v.protection.containerInventory[0].fingerprint = "0".repeat(64); },
    (v: ReturnType<typeof clean>) => { v.protection.containerInventory[0].status = "exited"; },
    (v: ReturnType<typeof clean>) => { v.recordsAfter[0].present = true; },
    (v: ReturnType<typeof clean>) => { v.checks.database = false; },
    (v: ReturnType<typeof clean>) => { v.netAvailableBytesDelta = 10000; },
  ];
  for (const mutate of mutations) {
    const v = clean(); mutate(v);
    assert.throws(() => parseRetiredContainerReport(line(v), "retired-container-clean", context, digest, inspect()));
  }
  assert.throws(() => parseRetiredContainerReport(line(clean()), "retired-container-clean", context, digest));
});

test("retired report CLI revalidates the pretty printed inspection file without network or secrets", () => {
  const folder = mkdtempSync(join(tmpdir(), "retired-container-report-"));
  try {
    const inspected = join(folder, "inspect.json"), log = join(folder, "clean.log"), output = join(folder, "clean.json");
    writeFileSync(inspected, JSON.stringify(inspect(), null, 2));
    writeFileSync(log, line(clean()));
    const result = spawnSync(process.execPath, ["scripts/production-cache-maintenance.mjs", "parse-retired-clean", log, output, inspected], {
      encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=512",
        GITHUB_REPOSITORY: "Jack-Kunlun/ai-project-os", GITHUB_REF: "refs/heads/main", GITHUB_SHA: "c".repeat(40),
        CACHE_MAINTENANCE_OPERATION: "retired-containers-clean", PRODUCTION_SOURCE_VERSION: "1.0.9",
        PRODUCTION_SOURCE_SHA: context.revision, SOURCE_MIGRATION_COUNT: "146", RELEASE_VERSION: "1.0.10",
        PRODUCTION_SSH_HOST: "38.76.205.30", RETIRED_CONTAINER_PLAN_DIGEST: digest,
        GITHUB_ENV: join(folder, "environment"), GITHUB_STEP_SUMMARY: join(folder, "summary") },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(output, "utf8")).removedIds, ids);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test("existing Actions provides only fixed container maintenance modes with serial production locking and credential cleanup", () => {
  const workflow = readFileSync(".github/workflows/release-stable.yml", "utf8");
  const maintenance = workflow.slice(workflow.indexOf("  cache-maintenance:"));
  for (const mode of ["retired-containers-inspect", "retired-containers-clean"]) assert.ok(workflow.includes(`- ${mode}`));
  assert.match(workflow, /group: ai-project-os-production\n  cancel-in-progress: false/u);
  assert.match(maintenance, /NODE_OPTIONS: --max-old-space-size=512/u);
  assert.match(maintenance, /CONFIRM_RETIRED_CONTAINER_INSPECT/u);
  assert.match(maintenance, /RETIRED_CONTAINER_PLAN_DIGEST/u);
  assert.match(maintenance, /production-retired-container-maintenance/u);
  assert.match(maintenance, /name: Remove the temporary maintenance SSH identity\n        if: \$\{\{ always\(\) \}\}/u);
  assert.doesNotMatch(maintenance, /path:.*cache-maintenance-ssh|docker (?:run|compose|container)|--force|--volumes/u);
});

test("retired maintenance context accepts only the existing main repository and forward tooling version", () => {
  const env: NodeJS.ProcessEnv = { NODE_ENV: "test", GITHUB_REPOSITORY: "Jack-Kunlun/ai-project-os", GITHUB_REF: "refs/heads/main", GITHUB_SHA: "c".repeat(40),
    CACHE_MAINTENANCE_OPERATION: "retired-containers-inspect", PRODUCTION_SOURCE_VERSION: "1.0.9",
    PRODUCTION_SOURCE_SHA: context.revision, SOURCE_MIGRATION_COUNT: "146", RELEASE_VERSION: "1.0.10", PRODUCTION_SSH_HOST: "38.76.205.30" };
  assert.equal(sourceContext(env).version, "1.0.9");
  assert.equal(sourceContext({ ...env, CACHE_MAINTENANCE_OPERATION: "retired-containers-clean" }).version, "1.0.9");
  assert.throws(() => sourceContext({ ...env, GITHUB_REF: "refs/heads/other" }));
});
