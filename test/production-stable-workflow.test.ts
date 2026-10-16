import assert from "node:assert/strict";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  assertCurrentRemoteTargets,
  assertReleaseIdentity,
  classifyExistingTag,
  compareStableVersions,
  healthyProductionPayload,
  mainCiRunHasRiskProof,
  parseDeploymentReceipt,
  parseReleaseAttestationJobName,
  parseStableVersion,
  releaseAttestationJobName,
  releaseTagForVersion,
  selectMainCiProof,
  tagAttestationJobName,
  validateMigrationNames,
  validateSourceHealth,
  validateToolingStatus,
  validateSshHost,
  TOOLING_PATHS,
} from "../scripts/production-stable-release.mjs";

const sha = "a".repeat(40);
const base = "b".repeat(40);
const otherSha = "c".repeat(40);
const successfulMainRun = {
  id: 101,
  event: "push",
  head_branch: "main",
  head_sha: sha,
  status: "completed",
  conclusion: "success",
};
const sourceJob = { name: "Verify source and client", conclusion: "success" };
const dbJob = { name: "Verify database and release candidate", conclusion: "success" };
const imageJob = { name: "Build and verify release images", conclusion: "success" };
const browserJob = imageJob;
const attestation = (risk: "low" | "medium" | "high", sourceBase = base) => ({
  name: releaseAttestationJobName(risk, sourceBase),
  conclusion: "success",
});

test("every release requires the exact CI image gate, even low risk", () => {
  const scope = { risk: "low", base, database: false, browser: false };
  assert.equal(mainCiRunHasRiskProof(successfulMainRun, [sourceJob, attestation("low")], sha, scope), false);
  assert.equal(mainCiRunHasRiskProof(successfulMainRun, [sourceJob, imageJob, attestation("low")], sha, scope), true);
});

test("routine image release receipts explicitly disable backup and restore at every tier", () => {
  const receipt = `STABLE_DEPLOY_OK tag=v1.2.3 revision=${sha} migration_count=146 backup=not-required restore=not-required`;
  for (const risk of ["low", "medium", "high"]) {
    assert.equal(parseDeploymentReceipt(receipt, "v1.2.3", sha, {
      migrationCount: 146, sourceMigrationCount: 146, risk, databaseRequired: risk === "high",
    }).backup, "not-required");
  }
  assert.throws(() => parseDeploymentReceipt(receipt, "v1.2.3", sha, {
    migrationCount: 145, sourceMigrationCount: 145, risk: "high", databaseRequired: true,
  }), /STABLE_DEPLOY_RECEIPT_MIGRATION_MISMATCH/u);
});

test("release context crosses jobs through valid nonsecret GitHub output keys", () => {
  const directory = mkdtempSync(join(tmpdir(), "stable-context-"));
  const output = join(directory, "outputs");
  const context = {
    RELEASE_VERSION: "1.0.6", RELEASE_TAG: "v1.0.6", MIGRATION_COUNT: "146", SOURCE_MIGRATION_COUNT: "146",
    MAIN_CI_RUN_ID: "42", MAIN_CI_RUN_URL: "https://github.com/Jack-Kunlun/ai-project-os/actions/runs/42",
    MAIN_CI_SOURCE_BASE: base, MAIN_CI_ATTESTED_RISK: "high", RELEASE_RISK: "high",
    RELEASE_DATABASE_REQUIRED: "true", RELEASE_BROWSER_REQUIRED: "true",
  };
  try {
    const result = spawnSync(process.execPath, ["scripts/production-stable-release.mjs", "export-context"], {
      encoding: "utf8", env: { ...process.env, ...context, GITHUB_OUTPUT: output },
    });
    assert.equal(result.status, 0, result.stderr);
    const lines = readFileSync(output, "utf8");
    for (const [key, value] of Object.entries(context)) assert.ok(lines.includes(`${key.toLowerCase()}=${value}\n`));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("production receives a read-only token and only publishing jobs can write the repository", () => {
  const workflow = readFileSync(".github/workflows/release-stable.yml", "utf8");
  const prepare = workflow.slice(workflow.indexOf("  prepare:"), workflow.indexOf("  release:"));
  const deploy = workflow.slice(workflow.indexOf("  release:"), workflow.indexOf("  publish:"));
  const publish = workflow.slice(workflow.indexOf("  publish:"));
  assert.match(deploy, /permissions:\n      contents: read\n      actions: read\n      packages: read/u);
  assert.doesNotMatch(deploy, /contents: write/u);
  assert.match(prepare, /contents: write/u);
  assert.match(publish, /contents: write/u);
  assert.doesNotMatch(prepare + publish, /PRODUCTION_SSH_PRIVATE_KEY|RELEASE_REGISTRY_TOKEN/u);
  assert.match(publish, /needs: \[prepare, release\]/u);
  assert.match(publish, /name: production-deployment-receipt/u);
  assert.equal((workflow.match(/name: production\n/gu) ?? []).length, 1);
});

test("stable versions and release identity are canonical across artifacts", () => {
  assert.deepEqual(parseStableVersion("1.0.2"), [1, 0, 2]);
  assert.equal(compareStableVersions("1.9.9", "1.10.0"), -1);
  assert.equal(releaseTagForVersion("1.2.3"), "v1.2.3");
  assert.throws(() => parseStableVersion("0.9.0"), /STABLE_VERSION_INVALID/u);
  assert.throws(() => parseStableVersion("1.0.0-rc.1"), /STABLE_VERSION_INVALID/u);
  assert.throws(() => parseStableVersion("1.01.0"), /STABLE_VERSION_INVALID/u);

  assert.deepEqual(assertReleaseIdentity({
    packageVersion: "1.2.3",
    appVersionSource: 'export const APP_VERSION = "1.2.3" as const;',
    dockerfile: 'LABEL org.opencontainers.image.version="1.2.3"',
    releaseNotes: "# v1.2.3 — Stable release\n",
  }), { version: "1.2.3", tag: "v1.2.3" });
  assert.throws(() => assertReleaseIdentity({
    packageVersion: "1.2.3",
    appVersionSource: 'export const APP_VERSION = "1.2.2" as const;',
    dockerfile: 'LABEL org.opencontainers.image.version="1.2.3"',
    releaseNotes: "# v1.2.3 — Stable release\n",
  }), /STABLE_APP_VERSION_MISMATCH/u);
});

test("migration manifest validation has no release-specific historical count floor", () => {
  const names = ["20261014000000_first", "20261015000000_second"];
  assert.equal(validateMigrationNames(names), 2);
  assert.equal(validateMigrationNames([]), 0);
  assert.throws(() => validateMigrationNames(["20261015000000_bad-name"]), /STABLE_MIGRATION_NAME_INVALID/u);
  assert.throws(() => validateMigrationNames([names[1], names[0]]), /STABLE_MIGRATION_ORDER_INVALID/u);
});

test("main CI release proof binds exact push SHA, production base, tier, and required jobs", () => {
  const lowScope = { risk: "low", base, database: false, browser: false };
  const lowJobs = [sourceJob, imageJob, attestation("low" )];
  assert.equal(mainCiRunHasRiskProof(successfulMainRun, lowJobs, sha, lowScope), true);
  assert.equal(mainCiRunHasRiskProof({ ...successfulMainRun, event: "workflow_dispatch" }, lowJobs, sha, lowScope), false);
  assert.equal(mainCiRunHasRiskProof({ ...successfulMainRun, head_branch: "release" }, lowJobs, sha, lowScope), false);
  assert.equal(mainCiRunHasRiskProof({ ...successfulMainRun, head_sha: otherSha }, lowJobs, sha, lowScope), false);
  assert.equal(mainCiRunHasRiskProof(successfulMainRun, [sourceJob, imageJob, attestation("low", otherSha)], sha, lowScope), false);
  assert.equal(mainCiRunHasRiskProof(successfulMainRun, [sourceJob, imageJob, attestation("medium")], sha, lowScope), false);
  assert.equal(mainCiRunHasRiskProof(successfulMainRun, [sourceJob, imageJob, attestation("low"), { ...sourceJob, conclusion: "skipped" }], sha, lowScope), true);

  const mediumScope = { risk: "medium", base, database: false, browser: true };
  assert.equal(mainCiRunHasRiskProof(successfulMainRun, [sourceJob, imageJob, attestation("medium"), browserJob], sha, mediumScope), true);
  assert.equal(mainCiRunHasRiskProof(successfulMainRun, [sourceJob, attestation("medium")], sha, mediumScope), false);
  assert.equal(mainCiRunHasRiskProof(successfulMainRun, [sourceJob, attestation("medium"), { ...imageJob, conclusion: "failure" }], sha, mediumScope), false);

  const highScope = { risk: "high", base, database: true, browser: true };
  assert.equal(mainCiRunHasRiskProof(successfulMainRun, [sourceJob, imageJob, attestation("high"), dbJob], sha, highScope), true);
  assert.equal(mainCiRunHasRiskProof(successfulMainRun, [sourceJob, imageJob, attestation("high"), browserJob], sha, highScope), false);
  assert.equal(mainCiRunHasRiskProof(successfulMainRun, [sourceJob, imageJob, attestation("high"), dbJob, { ...dbJob, conclusion: "skipped" }], sha, highScope), true);

  assert.equal(mainCiRunHasRiskProof(successfulMainRun, [sourceJob, imageJob, attestation("high"), dbJob], sha, mediumScope, { attestedRisk: "high" }), true);
  assert.equal(mainCiRunHasRiskProof(successfulMainRun, [sourceJob, imageJob, attestation("medium"), browserJob], sha, highScope, { attestedRisk: "medium" }), false);
});

test("higher-risk main CI proof preserves actual release receipt policy", () => {
  const lowScope = { risk: "low", base, database: false, browser: false };
  const highJobs = [sourceJob, imageJob, attestation("high"), dbJob];
  const lowProof = selectMainCiProof(successfulMainRun, highJobs, sha, lowScope);
  assert.deepEqual(lowProof, { scope: lowScope, attestedRisk: "high", attestedBase: base });

  const noDrillReceipt = `STABLE_DEPLOY_OK tag=v1.2.3 revision=${sha} migration_count=145 backup=20261015T120000Z-pre-deploy-to-v1.2.3.Abc123 restore=not-required`;
  assert.equal(parseDeploymentReceipt(noDrillReceipt, "v1.2.3", sha, {
    migrationCount: 145,
    sourceMigrationCount: 145,
    risk: lowProof.scope.risk,
    databaseRequired: lowProof.scope.database,
  }).restore, "not-required");

  const highScope = { risk: "high", base, database: true, browser: true };
  const highProof = selectMainCiProof(successfulMainRun, highJobs, sha, highScope);
  assert.deepEqual(highProof, { scope: highScope, attestedRisk: "high", attestedBase: base });
  assert.throws(() => parseDeploymentReceipt(noDrillReceipt, "v1.2.3", sha, {
    migrationCount: 145,
    sourceMigrationCount: 143,
    risk: highProof.scope.risk,
    databaseRequired: highProof.scope.database,
  }), /STABLE_DEPLOY_RECEIPT_MIGRATION_MISMATCH/u);
  const policyReceipt = noDrillReceipt.replace("restore=not-required", "restore=skipped-by-policy-143-to-145");
  assert.equal(parseDeploymentReceipt(policyReceipt, "v1.2.3", sha, {
    migrationCount: 145,
    sourceMigrationCount: 143,
    risk: highProof.scope.risk,
    databaseRequired: highProof.scope.database,
  }).restore, "skipped-by-policy-143-to-145");
});

test("already-current release keeps the production source policy when CI attests an older base", () => {
  const currentScope = { risk: "low", base: sha, database: false, browser: false };
  const historicalScope = { risk: "high", base, database: true, browser: true };
  const priorJobs = [sourceJob, imageJob, attestation("high", base), dbJob];
  const priorProof = selectMainCiProof(successfulMainRun, priorJobs, sha, currentScope, {
    allowPriorSourceProof: true,
    classifyBase: () => historicalScope,
  });
  assert.deepEqual(priorProof, { scope: currentScope, attestedRisk: "high", attestedBase: base });

  const noDrillReceipt = `STABLE_DEPLOY_ALREADY_CURRENT tag=v1.2.3 revision=${sha} migration_count=145 backup=20261015T120000Z-pre-deploy-to-v1.2.3.Abc123 restore=not-required`;
  assert.equal(parseDeploymentReceipt(noDrillReceipt, "v1.2.3", sha, {
    migrationCount: 145,
    sourceMigrationCount: 145,
    risk: priorProof.scope.risk,
    databaseRequired: priorProof.scope.database,
  }).restore, "not-required");

  assert.equal(selectMainCiProof(successfulMainRun, [sourceJob, imageJob, attestation("medium", base), browserJob], sha, currentScope, {
    allowPriorSourceProof: true,
    classifyBase: () => historicalScope,
  }), null);
});

test("release attestation names accept only known tier and a stable source revision", () => {
  assert.equal(releaseAttestationJobName("medium", base), `Verify internal delivery gates [risk=medium base=${base}]`);
  assert.deepEqual(parseReleaseAttestationJobName(releaseAttestationJobName("high", base)), { risk: "high", base });
  assert.equal(parseReleaseAttestationJobName("Verify internal delivery gates [risk=low base=unknown]"), null);
  assert.throws(() => releaseAttestationJobName("critical", base), /STABLE_RELEASE_RISK_INVALID/u);
});

test("tag attestation name remains bound to its exact version and commit", () => {
  assert.equal(tagAttestationJobName("v1.2.3", sha), `Attest tag v1.2.3 at ${sha}`);
  assert.throws(() => tagAttestationJobName("v1.2", sha), /STABLE_VERSION_INVALID/u);
});

test("permanent server tooling is accepted by ancestor revision and all five exact hashes", () => {
  const files = Object.fromEntries(Object.keys(TOOLING_PATHS).map((name) => [name, name.charCodeAt(0).toString(16).padStart(64, "0")]));
  const status = { kind: "STABLE_TOOLING_READY", formatVersion: 1, toolingRevision: otherSha, files };
  assert.equal(validateToolingStatus(status, files, true), true);
  assert.throws(() => validateToolingStatus(status, files, false), /STABLE_TOOLING_STATUS_INVALID/u);
  assert.throws(() => validateToolingStatus({ ...status, files: { ...files, gateway: "0".repeat(64) } }, files, true), /STABLE_TOOLING_FILE_HASH_MISMATCH/u);
  assert.throws(() => validateToolingStatus({ ...status, tag: "v1.2.3" }, files, true), /STABLE_TOOLING_STATUS_INVALID/u);
});

test("production health and source-to-target version checks fail closed", () => {
  const source = {
    status: "ok",
    version: "1.0.0",
    database: "up",
    worker: { status: "up", consecutiveFailures: 0 },
  };
  assert.equal(validateSourceHealth(source, "1.2.3"), "1.0.0");
  assert.equal(healthyProductionPayload({ ...source, version: "1.2.3" }, "1.2.3"), "1.2.3");
  assert.throws(() => validateSourceHealth({ ...source, version: "1.3.0" }, "1.2.3"), /STABLE_SOURCE_VERSION_AHEAD_OF_TARGET/u);
  assert.throws(() => healthyProductionPayload({ ...source, worker: { status: "down", consecutiveFailures: 1 } }), /STABLE_PUBLIC_HEALTH_INVALID/u);
  assert.throws(() => healthyProductionPayload({ ...source, version: "0.9.0" }), /STABLE_VERSION_INVALID/u);
});

test("production SSH host accepts only a valid pinned IPv4 address", () => {
  assert.equal(validateSshHost("38.76.205.30"), "38.76.205.30");
  assert.throws(() => validateSshHost("999.76.205.30"), /STABLE_SSH_HOST_INVALID/u);
  assert.throws(() => validateSshHost("production.example.com"), /STABLE_SSH_HOST_INVALID/u);
});

test("high-risk release records the skipped drill while preserving migration counts", () => {
  const highReceipt = `STABLE_DEPLOY_OK tag=v1.2.3 revision=${sha} migration_count=145 backup=20261015T120000Z-pre-deploy-to-v1.2.3.Abc123 restore=skipped-by-policy-143-to-145`;
  const highContext = { migrationCount: 145, sourceMigrationCount: 143, risk: "high", databaseRequired: true };
  assert.deepEqual(parseDeploymentReceipt(highReceipt, "v1.2.3", sha, highContext), {
    status: "STABLE_DEPLOY_OK",
    tag: "v1.2.3",
    revision: sha,
    migrationCount: 145,
    backup: "20261015T120000Z-pre-deploy-to-v1.2.3.Abc123",
    sourceCount: 143,
    targetCount: 145,
    restore: "skipped-by-policy-143-to-145",
    line: highReceipt,
  });
  for (const restore of ["not-required", "skipped-by-policy-144-to-145", "skipped-by-policy-143-to-144"]) {
    assert.throws(() => parseDeploymentReceipt(highReceipt.replace("restore=skipped-by-policy-143-to-145", `restore=${restore}`), "v1.2.3", sha, highContext), /STABLE_DEPLOY_RECEIPT_MIGRATION_MISMATCH/u);
  }
  const legacyReceipt = highReceipt.replace("restore=skipped-by-policy-143-to-145", "restore=143-to-145");
  assert.throws(() => parseDeploymentReceipt(legacyReceipt, "v1.2.3", sha, highContext), /STABLE_DEPLOY_RECEIPT_RESTORE_POLICY_MISMATCH/u);

  const lowerReceipt = highReceipt.replace("migration_count=145", "migration_count=143").replace("restore=skipped-by-policy-143-to-145", "restore=not-required");
  const lowerContext = { migrationCount: 143, sourceMigrationCount: 143, risk: "medium", databaseRequired: false };
  assert.equal(parseDeploymentReceipt(lowerReceipt, "v1.2.3", sha, lowerContext).restore, "not-required");
  assert.throws(() => parseDeploymentReceipt(lowerReceipt, "v1.2.3", sha, { ...lowerContext, sourceMigrationCount: 142 }), /STABLE_DEPLOY_RECEIPT_MIGRATION_MISMATCH/u);
  assert.throws(() => parseDeploymentReceipt(lowerReceipt, "v1.2.3", sha, { ...lowerContext, risk: "high", databaseRequired: true }), /STABLE_DEPLOY_RECEIPT_MIGRATION_MISMATCH/u);
  assert.throws(() => parseDeploymentReceipt(highReceipt, "v1.2.3", sha, { ...highContext, risk: "medium", databaseRequired: false }), /STABLE_DEPLOY_RECEIPT_RESTORE_POLICY_MISMATCH/u);
});

test("already-current release retries may reuse the restricted prior deployment receipt", () => {
  const receipt = `STABLE_DEPLOY_ALREADY_CURRENT tag=v1.2.3 revision=${sha} migration_count=145 backup=20261015T120000Z-pre-deploy-to-v1.2.3.Abc123 restore=143-to-145`;
  const context = { migrationCount: 145, sourceMigrationCount: 145, risk: "low", databaseRequired: false };
  assert.equal(parseDeploymentReceipt(receipt, "v1.2.3", sha, context).sourceCount, 143);
  const skippedReceipt = receipt.replace("restore=143-to-145", "restore=skipped-by-policy-143-to-145");
  assert.equal(parseDeploymentReceipt(skippedReceipt, "v1.2.3", sha, context).sourceCount, 143);
  assert.equal(parseDeploymentReceipt(skippedReceipt, "v1.2.3", sha, context).restore, "skipped-by-policy-143-to-145");
  assert.throws(() => parseDeploymentReceipt(`${receipt}\n${receipt}`, "v1.2.3", sha, context), /STABLE_DEPLOY_RECEIPT_MISSING_OR_AMBIGUOUS/u);
});

test("runtime recovery evidence cannot be published as a formal deployment receipt", () => {
  const context = { migrationCount: 146, sourceMigrationCount: 146, risk: "high", databaseRequired: true };
  for (const recoveryOutput of [
    "RECOVERY_OK\nrelease_protocol=stable-v1-recovery\nworkflow_publication_completed=false",
    `STABLE_RECOVERY_SOURCE_RECEIPT_OK tag=v1.0.4 revision=${base} migration_count=146`,
    JSON.stringify({ kind: "V104_RUNTIME_RECOVERY_OK", version: "1.0.4", workflowPublicationCompleted: false }),
  ]) {
    assert.throws(
      () => parseDeploymentReceipt(recoveryOutput, "v1.0.5", sha, context),
      /STABLE_DEPLOY_RECEIPT_MISSING_OR_AMBIGUOUS/u,
    );
  }
  const forwardReceipt = `STABLE_DEPLOY_OK tag=v1.0.5 revision=${sha} migration_count=146 backup=20261016T120000Z-pre-deploy-to-v1.0.5.Abc123 restore=skipped-by-policy-146-to-146`;
  assert.equal(parseDeploymentReceipt(forwardReceipt, "v1.0.5", sha, context).tag, "v1.0.5");
});

test("annotated version tags are immutable and must target the reviewed commit", () => {
  const ref = { object: { type: "tag", sha: otherSha } };
  const tagObject = { sha: otherSha, object: { type: "commit", sha } };
  assert.equal(classifyExistingTag(null, null, sha), "create");
  assert.equal(classifyExistingTag(ref, tagObject, sha), "reuse");
  assert.equal(assertCurrentRemoteTargets(sha, ref, tagObject, sha), true);
  assert.throws(() => classifyExistingTag({ object: { type: "commit", sha } }, null, sha), /STABLE_LIGHTWEIGHT_TAG_EXISTS/u);
  assert.throws(() => classifyExistingTag(ref, { sha: otherSha, object: { type: "commit", sha: otherSha } }, sha), /STABLE_TAG_POINTS_TO_DIFFERENT_REVISION/u);
  assert.throws(() => classifyExistingTag(ref, { sha, object: { type: "commit", sha } }, sha), /STABLE_TAG_OBJECT_INVALID/u);
  assert.throws(() => assertCurrentRemoteTargets(otherSha, ref, tagObject, sha), /STABLE_MAIN_ADVANCED_DURING_RELEASE/u);
});

test("release is human-dispatched only and main CI is reused without tag CI dispatch", () => {
  const releasePath = ".github/workflows/release-stable.yml";
  assert.equal(existsSync(releasePath), true);
  assert.equal(existsSync(".github/workflows/deploy-v102.yml"), false);
  const release = readFileSync(releasePath, "utf8");
  const trigger = release.match(/^on:\n([\s\S]*?)^permissions:/mu)?.[1] ?? "";
  assert.match(trigger, /^  workflow_dispatch:\s*$/mu);
  assert.doesNotMatch(trigger, /^  (?:push|pull_request|workflow_run|schedule):/mu);
  assert.match(release, /^name: 发布正式版本$/mu);
  assert.match(release, /Confirm production source and risk tier/u);
  assert.match(release, /Reuse successful exact-SHA main CI for the applicable risk tier/u);
  assert.match(release, /Require the permanent server tooling before deployment/u);
  assert.match(release, /stable-tooling-status/u);
  assert.match(release, /deploy-stable \$RELEASE_TAG \$GITHUB_SHA CONFIRM_STABLE_CI_IMAGES/u);
  assert.match(release, /StrictHostKeyChecking=yes/u);
  assert.match(release, /persist-credentials: false/u);
  assert.match(release, /contents: write[\s\S]*actions: read/u);
  assert.match(release, /group: ai-project-os-production[\s\S]*cancel-in-progress: false/u);
  assert.match(release, /timeout-minutes: 45/u);
  assert.doesNotMatch(release, /StrictHostKeyChecking=no|set -x|scp |rsync |workflow_run:|PAT|verify-tag-ci|ci.yml\/dispatches/u);
  const orderedSteps = [
    "Require the manual main-branch candidate",
    "Confirm production source and risk tier",
    "Reuse successful exact-SHA main CI for the applicable risk tier",
    "Create or reuse the immutable annotated version tag",
    "Require the permanent server tooling before deployment",
    "Recheck main and immutable tag before production deployment",
    "Deploy through the permanent restricted server gateway",
    "Verify the exact image deployment and migration receipt",
    "Verify public target health and publish the GitHub release",
  ].map((name) => release.indexOf(name));
  assert.ok(orderedSteps.every((index) => index >= 0));
  assert.deepEqual(orderedSteps, [...orderedSteps].sort((left, right) => left - right));

  const ci = readFileSync(".github/workflows/ci.yml", "utf8");
  assert.doesNotMatch(ci, /^  workflow_dispatch:/mu);
  assert.doesNotMatch(ci, /release_request_id|actions\/workflows\/ci\.yml\/dispatches/u);
  assert.match(ci, /risk=\$\{\{ needs\.scope\.outputs\.risk \}\} base=\$\{\{ needs\.scope\.outputs\.base \}\}/u);
  assert.match(ci, /name: Build and verify release images/u);
  assert.match(ci, /name: Attest tag \$\{\{ github\.ref_name \}\} at \$\{\{ github\.sha \}\}/u);
  assert.match(ci, /attest-tag/u);
  assert.doesNotMatch(ci, /if: \$\{\{ needs\.scope\.outputs\.database == 'true' \}\}[\s\S]{0,160}refs\/tags/u);

  for (const workflow of [release, ci]) {
    const blocks = workflow.matchAll(/^        run: \|\n((?:          .*\n|\n)*)/gmu);
    for (const block of blocks) {
      const shell = block[1].split("\n").map((line) => line.replace(/^          /u, "")).join("\n");
      const syntax = spawnSync("bash", ["-n"], { input: shell, encoding: "utf8" });
      assert.equal(syntax.status, 0, syntax.stderr || shell);
    }
  }
});
