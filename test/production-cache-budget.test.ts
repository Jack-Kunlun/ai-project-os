import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { buildCacheBudgetReport, budgetSummary, parseCacheFailure, runCacheBudgetMaintenance } from "../scripts/production-cache-budget.mjs";
import { sourceContext } from "../scripts/production-cache-maintenance.mjs";

const context = { tag: "v1.0.10", version: "1.0.10", revision: "a".repeat(40), migrationCount: 147 };
const digest = "b".repeat(64);
const id = (char: string) => `sha256:${char.repeat(64)}`;
function record(name: string, sizeBytes: number, shared = false, reclaimable = true) {
  return { id: name, type: "regular", sizeBytes, shared, reclaimable, estimated: false,
    mutable: false, eligible: reclaimable,
    bucket: `${shared ? "shared" : "private"}${reclaimable ? "Reclaimable" : "Protected"}` };
}
function inspect(records = [record("record1", 0)]) {
  const summary = { builder: "default", recordCount: records.length,
    sumRecordBytes: records.reduce((sum, item) => sum + item.sizeBytes, 0), estimated: records.some((item) => item.estimated),
    privateReclaimableBytes: 0, privateReclaimableCount: 0, privateProtectedBytes: 0, privateProtectedCount: 0,
    sharedReclaimableBytes: 0, sharedReclaimableCount: 0, sharedProtectedBytes: 0, sharedProtectedCount: 0 };
  for (const item of records) {
    const bucket = item.bucket as "privateReclaimable" | "privateProtected" | "sharedReclaimable" | "sharedProtected";
    summary[`${bucket}Bytes`] += item.sizeBytes; summary[`${bucket}Count`] += 1;
  }
  return { schema: 1, operation: "inspect", tag: context.tag, revision: context.revision, planDigest: digest, summary, records,
    protection: { planDigest: digest, currentImageIds: [id("c")], previousImageIds: [id("d")],
      ownedImageIds: [id("c"), id("d")], ownedImageCount: 2, unverifiedImages: [], unverifiedImageCount: 0,
      checkoutRevision: context.revision, migrationCount: 147, migrationManifestSha256: "e".repeat(64),
      deploymentReceiptSha256: "f".repeat(64), containerCount: 5, containerSnapshotSha256: "1".repeat(64),
      volumeCount: 3, volumeSnapshotSha256: "2".repeat(64), postgresId: "3".repeat(64),
      previousTag: "v1.0.9", previousRevision: "4".repeat(40), configHashes: { compose: "5".repeat(64) } } };
}
function clean(before = inspect(), after = inspect([])) {
  return { schema: 1, operation: "clean", tag: context.tag, revision: context.revision,
    planDigest: digest, summaryBefore: before.summary, summaryAfter: after.summary,
    protection: before.protection, protectionVerified: true,
    checks: { localHealth: true, publicHealth: true, database: true, worker: true, migrationLedger: true },
    prunedIds: before.records.filter((item) => !after.records.some((row) => row.id === item.id)).map((item) => item.id),
    remainingIds: [] as string[], newlyProtectedIds: [], newlyAppearedIds: [], changedIds: [] as string[], vanishedIds: [],
    availableBytesBefore: 1000, availableBytesAfter: 900, netAvailableBytesDelta: -100 };
}

test("release budget checks the fresh final inventory, serially cleaning only above 2 GB", async () => {
  const initial = inspect([record("old", 2_100_000_000)]); const final = inspect([]);
  const calls: string[] = [];
  const report = await runCacheBudgetMaintenance({ context,
    inspect: async (name: string) => { calls.push(name); return name === "inspect" ? initial : final; },
    clean: async (plan: string) => { assert.equal(plan, digest); calls.push("clean"); return clean(initial, final); } });
  assert.deepEqual(calls, ["inspect", "clean", "final"]);
  assert.equal(report.targetMet, true); assert.equal(report.summaryAfter.sumRecordBytes, 0);
  assert.deepEqual(report.prunedIds, ["old"]); assert.equal(report.netAvailableBytesDelta, -100);
  for (const bytes of [0, 2_000_000_000]) {
    const value = inspect([record("kept", bytes)]);
    const report = await runCacheBudgetMaintenance({ context, inspect: async () => value,
      clean: async () => { assert.fail("within-budget releases must not delete cache"); } });
    assert.equal(report.targetMet, true); assert.equal(report.cleanupAttempted, false);
  }
});

test("over-budget protected records are retained with exact bytes and reasons", async () => {
  const value = inspect([record("active", 1_100_000_000, false, false), record("sharedactive", 1_200_000_000, true, false)]);
  const report = await runCacheBudgetMaintenance({ context, inspect: async () => value,
    clean: async () => { assert.fail("no reclaimable records"); } });
  assert.equal(report.status, "exceeded"); assert.equal(report.targetMet, false);
  assert.equal(report.protectedBytes, 2_300_000_000); assert.equal(report.reclaimableBytes, 0);
  assert.deepEqual(report.retainedRecords[1].reasons, ["builder-in-use", "shared-image-layer"]);
  assert.match(budgetSummary(report), /2300000000 bytes/u);
  assert.match(budgetSummary(report), /BuildKit 标记不可回收/u);
  assert.match(budgetSummary(report), /数据卷 3 个/u);
});

test("shared reclaimable records, new records and engine-retained records have different reasons", () => {
  const before = inspect([record("engine", 100), record("changed", 100)]);
  const after = inspect([record("engine", 100, true), record("changed", 101), record("new", 102)]);
  const result = clean(before, after); result.remainingIds = ["engine"]; result.changedIds = ["changed"];
  const report = buildCacheBudgetReport(before, after, result, context);
  assert.equal(report.protectedBytes, 0); assert.equal(report.reclaimableBytes, 303);
  assert.deepEqual(report.retainedRecords.map((item: { reasons: string[] }) => item.reasons), [
    ["engine-retained-after-prune", "shared-image-layer"], ["changed-since-plan"], ["appeared-after-plan"]]);
});

test("estimated sizes never assert the exact target, even nominally below 2 GB", () => {
  const value = inspect([{ ...record("rounded", 1_999_000_000), estimated: true }]);
  const report = buildCacheBudgetReport(value, value, undefined, context);
  assert.equal(report.targetMet, null); assert.equal(report.status, "estimated");
  assert.equal(report.withinNominalTarget, true);
});

test("failed clean still rechecks final cache and cannot claim budget or protection success", async () => {
  const calls: string[] = [];
  const result = await runCacheBudgetMaintenance({ context,
    inspect: async (name: string) => { calls.push(name); return name === "inspect" ? inspect([record("old", 3e9)]) : inspect([]); },
    clean: async () => { calls.push("clean"); throw new Error("sensitive remote output must not escape"); } });
  assert.deepEqual(calls, ["inspect", "clean", "final"]);
  assert.equal(result.status, "unverified"); assert.equal(result.targetMet, null);
  assert.equal(result.protectionVerified, false); assert.equal(result.summaryAfter.sumRecordBytes, 0);
  assert.doesNotMatch(JSON.stringify(result), /sensitive/u);
});

test("partial cache failure evidence retains exact attempts without claiming deletion or copying arbitrary stdout", () => {
  const failure = { schema: 1, operation: "clean", status: "FAILED", tag: context.tag, revision: context.revision,
    planDigest: digest, toolingRevision: "c".repeat(40), completedAt: 1_792_000_000, protectionVerified: false,
    attemptedIds: ["cache1"], failureCode: "STABLE_CACHE_PROTECTED_RESOURCE_DRIFT", description: "private" };
  const line = (value: typeof failure) => "CACHE_MAINTENANCE_FAILURE " + JSON.stringify(value);
  const report = parseCacheFailure("unrelated private output\n" + line(failure), context, digest);
  assert.deepEqual(report.attemptedIds, ["cache1"]); assert.equal(report.protectionVerified, false);
  assert.doesNotMatch(JSON.stringify(report), /private|description/u);
  assert.throws(() => parseCacheFailure(line({ ...failure, attemptedIds: [".*"] }), context, digest));
  assert.throws(() => parseCacheFailure(line(failure), context, "0".repeat(64)));
});

test("fresh final protection drift, invalid record totals, duplicate IDs and wrong plans fail closed", () => {
  for (const key of ["postgresId", "volumeSnapshotSha256", "containerSnapshotSha256", "deploymentReceiptSha256"]) {
    const before = inspect(); const after = inspect();
    (after.protection as Record<string, unknown>)[key] = "9".repeat(64);
    assert.throws(() => buildCacheBudgetReport(before, after, undefined, context), /PROTECTION_DRIFT/u);
  }
  for (const malformed of [inspect([record("duplicate", 1), record("duplicate", 2)]),
    inspect([{ ...record("wrongbucket", 1), bucket: "sharedProtected" }]),
    inspect([{ ...record("invalid", 1), type: "arbitrary|description" }])]) {
    assert.throws(() => buildCacheBudgetReport(malformed, malformed, undefined, context));
  }
  const before = inspect(); const result = clean(); result.planDigest = "0".repeat(64);
  assert.throws(() => buildCacheBudgetReport(before, before, result, context));
});

test("post-release context uses the accepted target SHA and migration count, including upgrades", () => {
  const env = { NODE_ENV: "test" as const, GITHUB_REPOSITORY: "Jack-Kunlun/ai-project-os", GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: context.revision, CACHE_MAINTENANCE_OPERATION: "cache-clean", PRODUCTION_SOURCE_VERSION: "1.0.10",
    PRODUCTION_SOURCE_SHA: context.revision, RELEASE_VERSION: "1.0.10", SOURCE_MIGRATION_COUNT: "147", PRODUCTION_SSH_HOST: "203.0.113.10" };
  assert.deepEqual(sourceContext(env), context);
  assert.throws(() => sourceContext({ ...env, PRODUCTION_SOURCE_SHA: "b".repeat(40) }));
});

test("formal workflow gates automatic cache maintenance on verified deployment and retains diagnostics", () => {
  const workflow = readFileSync(".github/workflows/release-stable.yml", "utf8");
  const release = workflow.slice(workflow.indexOf("  release:"), workflow.indexOf("  publish:"));
  assert.ok(release.indexOf("verify-deployment") < release.indexOf("production-cache-budget.mjs post-release"));
  assert.match(release, /continue-on-error: true/u);
  assert.match(release, /PRODUCTION_SOURCE_VERSION: \$\{\{ env.RELEASE_VERSION \}\}/u);
  assert.match(release, /PRODUCTION_SOURCE_SHA: \$\{\{ github.sha \}\}/u);
  assert.match(release, /SOURCE_MIGRATION_COUNT: \$\{\{ env.MIGRATION_COUNT \}\}/u);
  assert.match(release, /always\(\) && steps.verified-deployment.outcome == 'success'/u);
  assert.match(release, /NODE_OPTIONS: --max-old-space-size=512/u);
  assert.match(release, /name: production-release-cache-maintenance/u);
  assert.doesNotMatch(release, /path:.*stable-ssh/u);
  const script = readFileSync("scripts/production-cache-budget.mjs", "utf8");
  assert.match(script, /StrictHostKeyChecking=yes/u);
  assert.doesNotMatch(script, /docker|Promise\.all|private.key/iu);
});

test("post-release CLI runs the fixed gateway protocol and saves the final budget with target migration identity", () => {
  const directory = mkdtempSync(join(tmpdir(), "release-cache-budget-"));
  try {
    const bin = join(directory, "bin"); mkdirSync(bin);
    const initial = inspect([record("old", 3e9)]); const final = inspect([]);
    const events = join(directory, "events"); const summaryPath = join(directory, "summary.md");
    writeFileSync(join(bin, "ssh"), `#!/usr/bin/env node\nconst fs = require("node:fs");
      const command = process.argv.at(-1); const events = ${JSON.stringify(events)};
      const first = !fs.existsSync(events); fs.appendFileSync(events, command + "\\n");
      process.stdout.write(${JSON.stringify("CACHE_MAINTENANCE_REPORT ")} + JSON.stringify(command.startsWith("clean-cache ")
        ? ${JSON.stringify(clean(initial, final))} : first ? ${JSON.stringify(initial)} : ${JSON.stringify(final)}));\n`, { mode: 0o755 });
    const result = spawnSync(process.execPath, ["scripts/production-cache-budget.mjs", "post-release"], {
      encoding: "utf8", timeout: 10_000, env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=512",
        PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: directory, GITHUB_STEP_SUMMARY: summaryPath,
        GITHUB_REPOSITORY: "Jack-Kunlun/ai-project-os", GITHUB_REF: "refs/heads/main", GITHUB_SHA: context.revision,
        CACHE_MAINTENANCE_OPERATION: "cache-clean", PRODUCTION_SOURCE_VERSION: context.version,
        PRODUCTION_SOURCE_SHA: context.revision, RELEASE_VERSION: context.version, SOURCE_MIGRATION_COUNT: "147",
        PRODUCTION_SSH_HOST: "203.0.113.10" },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readFileSync(events, "utf8").trim().split("\n"), [
      `inspect-cache ${context.tag} ${context.revision} CONFIRM_CACHE_INSPECT`,
      `clean-cache ${context.tag} ${context.revision} ${digest}`,
      `inspect-cache ${context.tag} ${context.revision} CONFIRM_CACHE_INSPECT`]);
    const path = resolve(directory, "release-cache-maintenance/budget.json");
    const report = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(report.targetMet, true); assert.equal(report.protection.migrationCount, 147);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.match(readFileSync(summaryPath, "utf8"), /targetMet=true/u);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
