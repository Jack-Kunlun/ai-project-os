import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseMaintenanceReport, sourceContext } from "../scripts/production-cache-maintenance.mjs";

const revision = "a".repeat(40);
const digest = "b".repeat(64);
const current = `sha256:${"c".repeat(64)}`;
const previous = `sha256:${"d".repeat(64)}`;
const context = { tag: "v1.0.9", version: "1.0.9", revision, migrationCount: 146 };
const summary = {
  builder: "default", recordCount: 2, sumRecordBytes: 300, estimated: true,
  privateReclaimableBytes: 100, privateReclaimableCount: 1,
  privateProtectedBytes: 0, privateProtectedCount: 0,
  sharedReclaimableBytes: 0, sharedReclaimableCount: 0,
  sharedProtectedBytes: 200, sharedProtectedCount: 1,
};
const protection = {
  planDigest: digest, currentImageIds: [current], previousImageIds: [previous],
  ownedImageIds: [current, previous], ownedImageCount: 2,
  checkoutRevision: revision, migrationCount: 146,
  migrationManifestSha256: "e".repeat(64), deploymentReceiptSha256: "f".repeat(64),
};
function inspect() {
  return { schema: 1, operation: "inspect", tag: context.tag, revision,
    planDigest: digest, summary: structuredClone(summary), protection: structuredClone(protection),
    records: [{ id: "record1" }, { id: "record2" }] };
}
function clean() {
  return { schema: 1, operation: "clean", tag: context.tag, revision, planDigest: digest,
    summaryBefore: structuredClone(summary), summaryAfter: structuredClone(summary),
    protection: structuredClone(protection), protectionVerified: true,
    prunedIds: [], remainingIds: [], newlyProtectedIds: [], newlyAppearedIds: [], changedIds: [], vanishedIds: [],
    availableBytesBefore: 1000, availableBytesAfter: 990, netAvailableBytesDelta: -10,
    checks: { localHealth: true, publicHealth: true, database: true, worker: true, migrationLedger: true } };
}
const line = (value: unknown) => `CACHE_MAINTENANCE_REPORT ${JSON.stringify(value)}\n`;

test("maintenance context requires main, a verified live source, typed host and forward tooling", () => {
  const env = { GITHUB_REPOSITORY: "Jack-Kunlun/ai-project-os", GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: "1".repeat(40), CACHE_MAINTENANCE_OPERATION: "cache-inspect",
    PRODUCTION_SOURCE_VERSION: "1.0.9", PRODUCTION_SOURCE_SHA: revision,
    RELEASE_VERSION: "1.0.10", SOURCE_MIGRATION_COUNT: "146", PRODUCTION_SSH_HOST: "192.0.2.1" };
  assert.deepEqual(sourceContext(env), context);
  for (const change of [{ GITHUB_REF: "refs/heads/other" }, { CACHE_MAINTENANCE_OPERATION: "shell" },
    { PRODUCTION_SOURCE_SHA: "bad\nInjected=true" }, { RELEASE_VERSION: "1.0.8" },
    { RELEASE_VERSION: "1.0.9" }, { PRODUCTION_SSH_HOST: "host;command" }]) {
    assert.throws(() => sourceContext({ ...env, ...change }));
  }
});

test("inspection report binds the source, four buckets, protected images and plan", () => {
  assert.equal(parseMaintenanceReport(line(inspect()), "inspect", context).planDigest, digest);
  const mutations = [
    (value: ReturnType<typeof inspect>) => { value.revision = "0".repeat(40); },
    (value: ReturnType<typeof inspect>) => { value.tag = "v1.0.8"; },
    (value: ReturnType<typeof inspect>) => { value.planDigest = "invalid"; },
    (value: ReturnType<typeof inspect>) => { value.summary.sumRecordBytes += 1; },
    (value: ReturnType<typeof inspect>) => { value.protection.previousImageIds = []; },
    (value: ReturnType<typeof inspect>) => { value.protection.ownedImageIds = [current]; },
    (value: ReturnType<typeof inspect>) => { value.protection.migrationCount = 145; },
  ];
  for (const mutate of mutations) { const value = inspect(); mutate(value); assert.throws(() => parseMaintenanceReport(line(value), "inspect", context)); }
  assert.throws(() => parseMaintenanceReport(line(inspect()) + line(inspect()), "inspect", context));
  assert.throws(() => parseMaintenanceReport("CACHE_MAINTENANCE_REPORT {invalid}\n", "inspect", context));
});

test("cleanup requires the inspected digest, unchanged protection and all health checks", () => {
  assert.equal(parseMaintenanceReport(line(clean()), "clean", context, digest).netAvailableBytesDelta, -10);
  assert.throws(() => parseMaintenanceReport(line(clean()), "clean", context, "0".repeat(64)));
  for (const change of [{ protectionVerified: false }, { netAvailableBytesDelta: 10 },
    { checks: { ...clean().checks, worker: false } }, { prunedIds: [".*"] }]) {
    assert.throws(() => parseMaintenanceReport(line({ ...clean(), ...change }), "clean", context, digest));
  }
});

test("maintenance workflow is isolated from tag creation and application deployment", () => {
  const workflow = readFileSync(".github/workflows/release-stable.yml", "utf8");
  const maintenance = workflow.slice(workflow.indexOf("  cache-maintenance:"));
  assert.match(workflow, /default: release/u);
  for (const job of ["prepare", "release", "publish"]) {
    assert.ok(workflow.includes(`  ${job}:\n    if: \u0024{{ (inputs.operation || 'release') == 'release' }}`));
  }
  assert.match(maintenance, /contents: read\n      actions: read/u);
  assert.doesNotMatch(maintenance, /contents: write|packages: write|ensure-tag|publish-release|deploy-stable|prisma migrate|docker /u);
  assert.match(maintenance, /refresh-stable-tooling \$RELEASE_TAG \$GITHUB_SHA CONFIRM_STABLE_TOOLING_FROM_CI/u);
  assert.match(maintenance, /inspect-cache \$CACHE_CURRENT_TAG \$CACHE_CURRENT_REVISION CONFIRM_CACHE_INSPECT/u);
  assert.match(maintenance, /clean-cache \$CACHE_CURRENT_TAG \$CACHE_CURRENT_REVISION \$CACHE_PLAN_DIGEST/u);
  assert.match(maintenance, /if: \$\{\{ inputs.operation == 'cache-clean' \}\}/u);
  assert.match(workflow, /group: ai-project-os-production\n  cancel-in-progress: false/u);
  assert.match(maintenance, /path: \$\{\{ runner.temp \}\}\/cache-maintenance\//u);
  assert.doesNotMatch(maintenance, /path:.*cache-maintenance-ssh/u);
  assert.match(maintenance, /StrictHostKeyChecking=yes/u);
  assert.match(maintenance, /Remove the temporary maintenance SSH identity/u);
});
