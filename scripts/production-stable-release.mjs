import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { classifyProductionChange, invokePinnedRiskClassifier } from "./ci-change-scope.mjs";

export const CANONICAL_REPOSITORY = "Jack-Kunlun/ai-project-os";
export const MAIN_SOURCE_JOB = "Verify source and client";
export const MAIN_DATABASE_JOB = "Verify database and release candidate";
export const MAIN_IMAGE_JOB = "Build and verify release images";
export const TOOLING_PATHS = Object.freeze({
  deployer: "deploy/production/ai-project-os-release-stable.py",
  backup: "deploy/production/ai-project-os-backup",
  artifact_helper: "deploy/production/ai_project_os_backup_artifact.py",
  sudoers: "deploy/production/ai-project-os-deploy.sudoers",
  gateway: "deploy/production/ai-project-os-actions-gateway",
});

const apiBase = "https://api.github.com/repos/";
const sha40Pattern = /^[a-f0-9]{40}$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const versionPattern = /^([1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const migrationPattern = /^\d{14}_[a-z0-9_]+$/u;

function fail(code) {
  throw new Error(`STABLE_${code}`);
}

function requireCondition(condition, code) {
  if (!condition) fail(code);
}

export function parseStableVersion(value) {
  const match = typeof value === "string" ? versionPattern.exec(value) : null;
  requireCondition(match, "VERSION_INVALID");
  return match.slice(1).map(Number);
}

export function compareStableVersions(left, right) {
  const a = parseStableVersion(left);
  const b = parseStableVersion(right);
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

export function releaseTagForVersion(version) {
  parseStableVersion(version);
  return `v${version}`;
}

export function assertReleaseIdentity({ packageVersion, appVersionSource, dockerfile, releaseNotes }) {
  parseStableVersion(packageVersion);
  requireCondition(
    new RegExp(`APP_VERSION\\s*=\\s*["']${escapeRegExp(packageVersion)}["']\\s+as\\s+const`, "u")
      .test(appVersionSource),
    "APP_VERSION_MISMATCH",
  );
  requireCondition(
    new RegExp(`org\\.opencontainers\\.image\\.version\\s*=\\s*["']${escapeRegExp(packageVersion)}["']`, "u")
      .test(dockerfile)
      || (new RegExp(`^ARG APP_VERSION="${escapeRegExp(packageVersion)}"$`, "mu").test(dockerfile)
        && [...dockerfile.matchAll(/org\.opencontainers\.image\.version="([^"]+)"/gu)]
          .map((match) => match[1]).join(",") === "${APP_VERSION}"),
    "DOCKER_VERSION_MISMATCH",
  );
  requireCondition(
    new RegExp(`^#\\s+v${escapeRegExp(packageVersion)}(?:\\s|$)`, "mu").test(releaseNotes),
    "RELEASE_NOTES_VERSION_MISMATCH",
  );
  return { version: packageVersion, tag: releaseTagForVersion(packageVersion) };
}

export function validateMigrationNames(names) {
  requireCondition(Array.isArray(names), "MIGRATION_COUNT_INVALID");
  requireCondition(
    names.every((name) => typeof name === "string" && migrationPattern.test(name)),
    "MIGRATION_NAME_INVALID",
  );
  requireCondition(new Set(names).size === names.length, "MIGRATION_DUPLICATE");
  const sorted = [...names].sort();
  requireCondition(names.every((name, index) => name === sorted[index]), "MIGRATION_ORDER_INVALID");
  return names.length;
}

export function tagAttestationJobName(tag, sha) {
  requireCondition(/^v/u.test(tag), "TAG_INVALID");
  parseStableVersion(tag.slice(1));
  requireCondition(sha40Pattern.test(sha), "REVISION_INVALID");
  return `Attest tag ${tag} at ${sha}`;
}

export function releaseAttestationJobName(risk, base) {
  requireCondition(["low", "medium", "high"].includes(risk), "RELEASE_RISK_INVALID");
  requireCondition(base === "unknown" || sha40Pattern.test(base ?? ""), "RELEASE_BASE_INVALID");
  requireCondition(base !== "unknown" || risk === "high", "RELEASE_BASE_INVALID");
  return `Verify internal delivery gates [risk=${risk} base=${base}]`;
}

export function mainCiRunIsCandidate(run, sha) {
  return run?.head_sha === sha
    && run?.head_branch === "main"
    && run?.event === "push"
    && run?.status === "completed"
    && run?.conclusion === "success";
}

export function hasSuccessfulJob(jobs, expectedName) {
  return Array.isArray(jobs)
    && jobs.some((job) => job?.name === expectedName && job?.conclusion === "success");
}

export function mainCiRunHasRiskProof(run, jobs, sha, scope, {
  attestedRisk = scope?.risk,
  attestedBase = scope?.base,
} = {}) {
  if (!mainCiRunIsCandidate(run, sha)
      || !scope
      || !["low", "medium", "high"].includes(scope.risk)
      || !["low", "medium", "high"].includes(attestedRisk)
      || riskRank(attestedRisk) < riskRank(scope.risk)
      || !sha40Pattern.test(attestedBase ?? "")
      || !hasSuccessfulJob(jobs, MAIN_SOURCE_JOB)
      || !hasSuccessfulJob(jobs, MAIN_IMAGE_JOB)) {
    return false;
  }
  const attestation = (Array.isArray(jobs) ? jobs : [])
    .filter((job) => job?.conclusion === "success")
    .map((job) => parseReleaseAttestationJobName(job.name))
    .find((proof) => proof?.base === attestedBase && proof.risk === attestedRisk);
  if (!attestation) return false;
  const databaseRequired = scope.database || attestedRisk === "high";
  if (databaseRequired) return hasSuccessfulJob(jobs, MAIN_DATABASE_JOB);
  return true;
}

function riskRank(risk) {
  return ({ low: 0, medium: 1, high: 2 })[risk] ?? -1;
}

export function parseReleaseAttestationJobName(name) {
  const match = typeof name === "string"
    ? /^Verify internal delivery gates \[risk=(low|medium|high) base=([a-f0-9]{40}|unknown)\]$/u.exec(name)
    : null;
  if (!match || (match[2] === "unknown" && match[1] !== "high")) return null;
  return { risk: match[1], base: match[2] };
}

function actionsRunUrl(run) {
  requireCondition(
    Number.isSafeInteger(run?.id)
      && run.html_url === `https://github.com/${CANONICAL_REPOSITORY}/actions/runs/${run.id}`,
    "CI_EVIDENCE_URL_INVALID",
  );
  return run.html_url;
}

export function validateToolingStatus(status, expectedHashes, permanentRevisionIsAncestor) {
  requireCondition(status && typeof status === "object" && !Array.isArray(status), "TOOLING_STATUS_INVALID");
  requireCondition(
    sameKeys(status, ["kind", "formatVersion", "toolingRevision", "files"])
      && status.kind === "STABLE_TOOLING_READY"
      && status.formatVersion === 1
      && sha40Pattern.test(status.toolingRevision)
      && permanentRevisionIsAncestor === true,
    "TOOLING_STATUS_INVALID",
  );
  requireCondition(status.files && typeof status.files === "object" && !Array.isArray(status.files), "TOOLING_FILES_INVALID");
  requireCondition(sameKeys(status.files, Object.keys(TOOLING_PATHS)), "TOOLING_FILES_INVALID");
  for (const name of Object.keys(TOOLING_PATHS)) {
    requireCondition(
      sha256Pattern.test(status.files[name]) && status.files[name] === expectedHashes[name],
      "TOOLING_FILE_HASH_MISMATCH",
    );
  }
  return true;
}

export function healthyProductionPayload(payload, expectedVersion) {
  const version = payload?.version;
  parseStableVersion(version);
  requireCondition(
    payload.status === "ok"
      && payload.database === "up"
      && payload.worker?.status === "up"
      && payload.worker?.consecutiveFailures === 0,
    "PUBLIC_HEALTH_INVALID",
  );
  if (expectedVersion != null) requireCondition(version === expectedVersion, "PUBLIC_VERSION_MISMATCH");
  return version;
}

export function validateSourceHealth(payload, targetVersion) {
  const sourceVersion = healthyProductionPayload(payload);
  requireCondition(compareStableVersions(sourceVersion, targetVersion) <= 0, "SOURCE_VERSION_AHEAD_OF_TARGET");
  return sourceVersion;
}

export function parseDeploymentReceipt(stdout, tag, sha, {
  migrationCount: expectedMigrationCount,
  sourceMigrationCount,
  risk,
  databaseRequired,
}) {
  const version = tag.startsWith("v") ? tag.slice(1) : "";
  parseStableVersion(version);
  requireCondition(sha40Pattern.test(sha), "REVISION_INVALID");
  requireCondition(Number.isSafeInteger(expectedMigrationCount) && expectedMigrationCount >= 0, "MIGRATION_COUNT_INVALID");
  requireCondition(Number.isSafeInteger(sourceMigrationCount) && sourceMigrationCount >= 0, "SOURCE_MIGRATION_COUNT_INVALID");
  requireCondition(["low", "medium", "high"].includes(risk) && typeof databaseRequired === "boolean", "RELEASE_RISK_INVALID");
  const escapedTag = escapeRegExp(tag);
  const pattern = new RegExp(
    `^(STABLE_DEPLOY_OK|STABLE_DEPLOY_ALREADY_CURRENT) tag=${escapedTag} revision=${sha} migration_count=(\\d+) backup=(not-required|\\d{8}T\\d{6}Z-pre-deploy-to-${escapedTag}\\.[A-Za-z0-9]{6}) restore=(not-required|(?:skipped-by-policy-)?\\d+-to-\\d+)$`,
    "u",
  );
  const matches = String(stdout).split(/\r?\n/u).filter((line) => line.startsWith("STABLE_DEPLOY_OK ") || line.startsWith("STABLE_DEPLOY_ALREADY_CURRENT "));
  requireCondition(matches.length === 1, "DEPLOY_RECEIPT_MISSING_OR_AMBIGUOUS");
  const match = pattern.exec(matches[0]);
  requireCondition(match, "DEPLOY_RECEIPT_INVALID");
  const migrationCount = Number(match[2]);
  const restore = match[4];
  const targetCount = expectedMigrationCount;
  let sourceCount = sourceMigrationCount;
  if (match[3] === "not-required") {
    requireCondition(restore === "not-required"
      && migrationCount === expectedMigrationCount
      && sourceMigrationCount <= expectedMigrationCount,
    "DEPLOY_RECEIPT_MIGRATION_MISMATCH");
    return {
      status: match[1], tag, revision: sha, migrationCount,
      backup: "not-required", sourceCount, targetCount, restore, line: matches[0],
    };
  }
  if (restore === "not-required") {
    requireCondition(
      migrationCount === expectedMigrationCount
        && sourceMigrationCount === expectedMigrationCount
        && databaseRequired === false
        && (risk === "low" || risk === "medium"),
      "DEPLOY_RECEIPT_MIGRATION_MISMATCH",
    );
  } else {
    const restoreMatch = /^(?:skipped-by-policy-)?(\d+)-to-(\d+)$/u.exec(restore);
    requireCondition(restoreMatch, "DEPLOY_RECEIPT_INVALID");
    sourceCount = Number(restoreMatch[1]);
    requireCondition(
      migrationCount === expectedMigrationCount
        && Number.isSafeInteger(sourceCount)
        && Number(restoreMatch[2]) === expectedMigrationCount
        && sourceCount <= expectedMigrationCount
        && (match[1] === "STABLE_DEPLOY_ALREADY_CURRENT" || sourceCount === sourceMigrationCount),
      "DEPLOY_RECEIPT_MIGRATION_MISMATCH",
    );
  }
  if (match[1] === "STABLE_DEPLOY_OK") {
    requireCondition(databaseRequired
      ? risk === "high" && restore.startsWith("skipped-by-policy-")
      : restore === "not-required", "DEPLOY_RECEIPT_RESTORE_POLICY_MISMATCH");
  }
  return {
    status: match[1],
    tag,
    revision: sha,
    migrationCount,
    backup: match[3],
    sourceCount,
    targetCount,
    restore,
    line: matches[0],
  };
}

export function classifyExistingTag(ref, tagObject, targetSha) {
  requireCondition(sha40Pattern.test(targetSha), "REVISION_INVALID");
  if (ref == null) return "create";
  requireCondition(
    ref.object?.type === "tag"
      && sha40Pattern.test(ref.object.sha ?? "")
      && tagObject?.sha === ref.object.sha,
    ref.object?.type === "tag" ? "TAG_OBJECT_INVALID" : "LIGHTWEIGHT_TAG_EXISTS",
  );
  requireCondition(
    tagObject?.object?.type === "commit" && tagObject.object.sha === targetSha,
    "TAG_POINTS_TO_DIFFERENT_REVISION",
  );
  return "reuse";
}

export function assertCurrentRemoteTargets(mainSha, ref, tagObject, targetSha) {
  requireCondition(mainSha === targetSha, "MAIN_ADVANCED_DURING_RELEASE");
  requireCondition(classifyExistingTag(ref, tagObject, targetSha) === "reuse", "TAG_TARGET_INVALID");
  return true;
}

function sameKeys(value, expected) {
  return Object.keys(value).sort().join("\n") === [...expected].sort().join("\n");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function git(args, { encoding } = {}) {
  const result = spawnSync("git", args, { encoding: encoding ?? null, maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) fail("GIT_CHECK_FAILED");
  return result.stdout;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function writeGitHubEnv(values) {
  const target = process.env.GITHUB_ENV;
  if (!target) return;
  const lines = Object.entries(values).map(([name, value]) => {
    requireCondition(/^[A-Z][A-Z0-9_]*$/u.test(name) && !/[\r\n]/u.test(String(value)), "OUTPUT_INVALID");
    return `${name}=${value}`;
  });
  appendFileSync(target, `${lines.join("\n")}\n`, { mode: 0o600 });
}

function githubOutput(values) {
  const target = process.env.GITHUB_OUTPUT;
  if (!target) return;
  const lines = Object.entries(values).map(([name, value]) => {
    requireCondition(/^[a-z][a-z0-9_]*$/u.test(name) && !/[\r\n]/u.test(String(value)), "OUTPUT_INVALID");
    return `${name}=${value}`;
  });
  appendFileSync(target, `${lines.join("\n")}\n`, { mode: 0o600 });
}

function repository() {
  requireCondition(process.env.GITHUB_REPOSITORY === CANONICAL_REPOSITORY, "REPOSITORY_INVALID");
  return process.env.GITHUB_REPOSITORY;
}

function token() {
  const value = process.env.GH_TOKEN;
  requireCondition(typeof value === "string" && value.length > 0, "GITHUB_TOKEN_MISSING");
  return value;
}

async function githubApi(path, { method = "GET", body, allow404 = false } = {}) {
  const response = await fetch(`${apiBase}${repository()}${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token()}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body == null ? {} : { "Content-Type": "application/json" }),
    },
    ...(body == null ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  if (allow404 && response.status === 404) return null;
  if (!response.ok) fail(`GITHUB_API_HTTP_${response.status}`);
  if (response.status === 204) return null;
  return response.json();
}

async function getCiRuns({ event, sha }) {
  const query = new URLSearchParams({ event, head_sha: sha, per_page: "100" });
  const result = await githubApi(`/actions/workflows/ci.yml/runs?${query}`);
  requireCondition(Array.isArray(result?.workflow_runs), "CI_RUN_LIST_INVALID");
  return result.workflow_runs;
}

async function getCiJobs(run) {
  requireCondition(Number.isSafeInteger(run?.id), "CI_RUN_ID_INVALID");
  const result = await githubApi(`/actions/runs/${run.id}/jobs?per_page=100`);
  requireCondition(Array.isArray(result?.jobs), "CI_JOB_LIST_INVALID");
  return result.jobs;
}

function runStillActive(run) {
  return run?.status !== "completed";
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function sourceVersionAtRevision(revision) {
  requireCondition(sha40Pattern.test(revision ?? ""), "RELEASE_BASE_INVALID");
  const tags = git(["tag", "--list", "v*"], { encoding: "utf8" }).trim().split(/\r?\n/u).filter(Boolean);
  const matches = [];
  for (const tag of tags) {
    if (!/^v[1-9]\d*\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(tag)) continue;
    const type = spawnSync("git", ["cat-file", "-t", `refs/tags/${tag}`], { encoding: "utf8" });
    if (type.status !== 0 || type.stdout.trim() !== "tag") continue;
    const peeled = spawnSync("git", ["rev-parse", `refs/tags/${tag}^{}`], { encoding: "utf8" });
    if (peeled.status === 0 && peeled.stdout.trim() === revision) matches.push(tag.slice(1));
  }
  requireCondition(matches.length > 0, "RELEASE_BASE_TAG_MISSING");
  return matches.sort(compareStableVersions).at(-1);
}

function classifyAttestedBase(base, target) {
  const version = sourceVersionAtRevision(base);
  const payload = {
    status: "ok",
    version,
    database: "up",
    worker: { status: "up", consecutiveFailures: 0 },
  };
  const scope = classifyProductionChange({
    payload,
    targetRevision: target,
    classify: (sourceRevision, targetRevision) => invokePinnedRiskClassifier(process.cwd(), sourceRevision, targetRevision),
  });
  requireCondition(scope.base === base, "RELEASE_BASE_CLASSIFICATION_INVALID");
  return scope;
}

function scopeForAttestation(jobs, target, expectedScope, {
  allowPriorSourceProof = false,
  classifyBase = classifyAttestedBase,
} = {}) {
  const proofs = (Array.isArray(jobs) ? jobs : [])
    .filter((job) => job?.conclusion === "success")
    .map((job) => parseReleaseAttestationJobName(job.name))
    .filter((proof) => proof && proof.base !== "unknown");
  for (const proof of proofs) {
    const matchesExpectedBase = expectedScope?.base === proof.base;
    const computed = matchesExpectedBase
      ? expectedScope
      : classifyBase(proof.base, target);
    if (riskRank(proof.risk) < riskRank(computed.risk)) continue;
    if (expectedScope && !matchesExpectedBase && !allowPriorSourceProof) continue;
    const releaseScope = expectedScope && allowPriorSourceProof ? expectedScope : computed;
    if (riskRank(proof.risk) < riskRank(releaseScope.risk)) continue;
    return { scope: releaseScope, attestedRisk: proof.risk, attestedBase: proof.base };
  }
  return null;
}

export function selectMainCiProof(run, jobs, sha, expectedScope, options = {}) {
  if (!mainCiRunIsCandidate(run, sha)) return null;
  const proof = scopeForAttestation(jobs, sha, expectedScope, options);
  if (!proof || !mainCiRunHasRiskProof(run, jobs, sha, proof.scope, {
    attestedRisk: proof.attestedRisk,
    attestedBase: proof.attestedBase,
  })) return null;
  return proof;
}

async function findMainCiProof(run, sha, expectedScope, options = {}) {
  if (!mainCiRunIsCandidate(run, sha)) return null;
  const jobs = await getCiJobs(run);
  const proof = selectMainCiProof(run, jobs, sha, expectedScope, options);
  if (!proof) return null;
  return { jobs, ...proof };
}

async function waitForMainCi(sha, expectedScope, allowPriorSourceProof = false) {
  requireCondition(expectedScope && expectedScope.base !== "unknown", "PRODUCTION_SOURCE_BASE_UNKNOWN");
  const deadline = Date.now() + 90 * 60 * 1000;
  let missingRunPolls = 0;
  while (Date.now() <= deadline) {
    const runs = await getCiRuns({ event: "push", sha });
    const candidates = runs
      .filter((run) => run?.head_sha === sha && run?.head_branch === "main" && run?.event === "push")
      .sort((left, right) => String(right.created_at ?? "").localeCompare(String(left.created_at ?? "")));
    missingRunPolls = candidates.length === 0 ? missingRunPolls + 1 : 0;
    for (const run of candidates.filter((item) => item?.status === "completed" && item?.conclusion === "success")) {
      const proof = await findMainCiProof(run, sha, expectedScope, { allowPriorSourceProof });
      if (proof) {
        const url = actionsRunUrl(run);
        writeGitHubEnv({
          MAIN_CI_RUN_ID: run.id,
          MAIN_CI_RUN_URL: url,
          MAIN_CI_SOURCE_BASE: proof.attestedBase,
          MAIN_CI_ATTESTED_RISK: proof.attestedRisk,
          RELEASE_RISK: proof.scope.risk,
          RELEASE_DATABASE_REQUIRED: String(proof.scope.database),
          RELEASE_BROWSER_REQUIRED: String(proof.scope.browser),
        });
        console.log(`STABLE_MAIN_CI_VERIFIED run=${run.id} sha=${sha} risk=${proof.scope.risk} attested_risk=${proof.attestedRisk} source=${proof.scope.base} attested_source=${proof.attestedBase}`);
        return { run, scope: proof.scope };
      }
    }
    if (candidates.length === 0 && missingRunPolls >= 10) fail("EXACT_MAIN_PUSH_CI_MISSING");
    if (candidates.length > 0 && !candidates.some(runStillActive)) {
      fail(candidates.some((run) => run.conclusion === "success")
        ? "APPLICABLE_MAIN_CI_RISK_PROOF_REQUIRED"
        : "MAIN_CI_FAILED");
    }
    await sleep(30_000);
  }
  fail("MAIN_CI_WAIT_TIMEOUT");
}

function migrationCountAtRevision(revision) {
  const names = git(["ls-tree", "-d", "--name-only", `${revision}:prisma/migrations`], { encoding: "utf8" })
    .trim().split(/\r?\n/u).filter(Boolean);
  return validateMigrationNames(names);
}

async function ensureMainStillAt(sha) {
  const ref = await githubApi("/git/ref/heads/main", { allow404: true });
  requireCondition(ref?.object?.type === "commit" && ref.object.sha === sha, "MAIN_ADVANCED_DURING_RELEASE");
}

async function getTagInfo(tag) {
  const ref = await githubApi(`/git/ref/tags/${tag}`, { allow404: true });
  if (ref == null) return { ref: null, tagObject: null };
  if (ref.object?.type !== "tag" || !sha40Pattern.test(ref.object.sha ?? "")) {
    return { ref, tagObject: null };
  }
  const tagObject = await githubApi(`/git/tags/${ref.object.sha}`);
  return { ref, tagObject };
}

async function assertTagTarget(tag, sha) {
  const { ref, tagObject } = await getTagInfo(tag);
  classifyExistingTag(ref, tagObject, sha);
  return { ref, tagObject };
}

async function createOrReuseTag(tag, sha) {
  await ensureMainStillAt(sha);
  const current = await getTagInfo(tag);
  let mode = classifyExistingTag(current.ref, current.tagObject, sha);
  if (mode === "create") {
    let created;
    try {
      created = await githubApi("/git/tags", {
        method: "POST",
        body: {
          tag,
          message: `Release ${tag}`,
          object: sha,
          type: "commit",
          tagger: {
            name: "AI Project OS Release Workflow",
            email: "ai-project-os-release@users.noreply.github.com",
            date: new Date().toISOString(),
          },
        },
      });
    } catch (error) {
      if (/^STABLE_GITHUB_API_HTTP_(?:403|422)$/u.test(error?.message ?? "")) {
        fail("ANNOTATED_TAG_OBJECT_CREATE_REJECTED");
      }
      throw error;
    }
    requireCondition(sha40Pattern.test(created?.sha ?? ""), "ANNOTATED_TAG_CREATE_INVALID");
    try {
      await githubApi("/git/refs", {
        method: "POST",
        body: { ref: `refs/tags/${tag}`, sha: created.sha },
      });
    } catch (error) {
      const afterRace = await getTagInfo(tag);
      if (classifyExistingTag(afterRace.ref, afterRace.tagObject, sha) !== "reuse") {
        if (/^STABLE_GITHUB_API_HTTP_(?:403|422)$/u.test(error?.message ?? "")) {
          fail("ANNOTATED_TAG_REF_CREATE_REJECTED");
        }
        throw error;
      }
      mode = "reuse";
    }
    const verified = await assertTagTarget(tag, sha);
    requireCondition(verified.tagObject?.sha, "ANNOTATED_TAG_VERIFY_FAILED");
  }
  writeGitHubEnv({ RELEASE_TAG_MODE: mode });
  console.log(`STABLE_ANNOTATED_TAG_READY tag=${tag} sha=${sha} mode=${mode}`);
}

async function attestTagIdentity() {
  const tag = process.env.RELEASE_TAG ?? process.env.GITHUB_REF_NAME;
  const sha = process.env.GITHUB_SHA;
  requireCondition(process.env.GITHUB_REF === `refs/tags/${tag}`, "TAG_REF_INVALID");
  requireCondition(sha40Pattern.test(sha ?? ""), "REVISION_INVALID");
  const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
  const identity = assertReleaseIdentity({
    packageVersion: packageJson.version,
    appVersionSource: readFileSync("src/lib/version.ts", "utf8"),
    dockerfile: readFileSync("Dockerfile", "utf8"),
    releaseNotes: readFileSync(`docs/releases/v${packageJson.version}.md`, "utf8"),
  });
  requireCondition(identity.tag === tag, "TAG_VERSION_MISMATCH");
  requireCondition(git(["rev-parse", "HEAD"], { encoding: "utf8" }).trim() === sha, "CHECKOUT_REVISION_MISMATCH");
  requireCondition(git(["cat-file", "-t", `refs/tags/${tag}`], { encoding: "utf8" }).trim() === "tag", "ANNOTATED_TAG_REQUIRED");
  requireCondition(git(["rev-parse", `refs/tags/${tag}^{}`], { encoding: "utf8" }).trim() === sha, "TAG_TARGET_MISMATCH");

  const runs = await getCiRuns({ event: "push", sha });
  const candidates = runs
    .filter((run) => run?.head_sha === sha && run?.head_branch === "main" && run?.event === "push")
    .filter((run) => run?.status === "completed" && run?.conclusion === "success")
    .sort((left, right) => String(right.created_at ?? "").localeCompare(String(left.created_at ?? "")));
  for (const run of candidates) {
    const proof = await findMainCiProof(run, sha, null);
    if (!proof) continue;
    const url = actionsRunUrl(run);
    writeGitHubEnv({
      MAIN_CI_RUN_ID: run.id,
      MAIN_CI_RUN_URL: url,
      MAIN_CI_SOURCE_BASE: proof.attestedBase,
      MAIN_CI_ATTESTED_RISK: proof.attestedRisk,
    });
    console.log(`STABLE_TAG_IDENTITY_VERIFIED tag=${tag} sha=${sha} risk=${proof.scope.risk} attested_risk=${proof.attestedRisk} attested_source=${proof.attestedBase}`);
    return;
  }
  fail("EXACT_MAIN_RISK_CI_REQUIRED");
}

function validateSshHost(host) {
  if (typeof host !== "string") fail("SSH_HOST_INVALID");
  const parts = host.split(".");
  requireCondition(
    parts.length === 4
      && parts.every((part) => /^(0|[1-9]\d{0,2})$/u.test(part) && Number(part) <= 255),
    "SSH_HOST_INVALID",
  );
  return host;
}

export { validateSshHost };

async function healthJson() {
  const response = await fetch("https://ai-project-os.com/api/health", {
    headers: { Accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  requireCondition(response.status === 200, "PUBLIC_HEALTH_HTTP_INVALID");
  const payload = await response.json();
  return payload;
}

function candidateContext() {
  requireCondition(process.env.GITHUB_REF === "refs/heads/main", "RELEASE_MUST_RUN_FROM_MAIN");
  requireCondition(repository() === CANONICAL_REPOSITORY, "REPOSITORY_INVALID");
  const sha = process.env.GITHUB_SHA;
  requireCondition(sha40Pattern.test(sha ?? ""), "REVISION_INVALID");
  requireCondition(git(["rev-parse", "HEAD"], { encoding: "utf8" }).trim() === sha, "CHECKOUT_REVISION_MISMATCH");
  const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
  const identity = assertReleaseIdentity({
    packageVersion: packageJson.version,
    appVersionSource: readFileSync("src/lib/version.ts", "utf8"),
    dockerfile: readFileSync("Dockerfile", "utf8"),
    releaseNotes: readFileSync(`docs/releases/v${packageJson.version}.md`, "utf8"),
  });
  const migrationNames = git(["ls-tree", "-d", "--name-only", `${sha}:prisma/migrations`], { encoding: "utf8" })
    .trim().split(/\r?\n/u).filter(Boolean);
  const migrationCount = validateMigrationNames(migrationNames);
  return { ...identity, sha, migrationCount };
}

function expectedToolingHashes(sha) {
  const result = {};
  for (const [name, path] of Object.entries(TOOLING_PATHS)) {
    result[name] = sha256(git(["show", `${sha}:${path}`]));
  }
  return result;
}

function isAncestor(revision, target) {
  requireCondition(sha40Pattern.test(revision ?? ""), "TOOLING_REVISION_INVALID");
  return spawnSync("git", ["merge-base", "--is-ancestor", revision, target], { encoding: "utf8" }).status === 0;
}

async function validateToolingFile(path, sha) {
  const status = JSON.parse(readFileSync(path, "utf8"));
  validateToolingStatus(status, expectedToolingHashes(sha), isAncestor(status.toolingRevision, sha));
  console.log(`STABLE_TOOLING_VERIFIED revision=${status.toolingRevision} files=5`);
}

async function validatePublicSourceHealth(targetVersion, targetSha) {
  const payload = await healthJson();
  const sourceVersion = validateSourceHealth(payload, targetVersion);
  const scope = classifyProductionChange({
    payload,
    targetRevision: targetSha,
    classify: (sourceRevision, targetRevision) => invokePinnedRiskClassifier(process.cwd(), sourceRevision, targetRevision),
  });
  requireCondition(scope.base !== "unknown", "PRODUCTION_SOURCE_BASE_UNKNOWN");
  const sourceRevision = scope.base;
  const sourceMigrationCount = migrationCountAtRevision(sourceRevision);
  writeGitHubEnv({
    PRODUCTION_SOURCE_VERSION: sourceVersion,
    PRODUCTION_SOURCE_SHA: sourceRevision,
    RELEASE_ALREADY_CURRENT: String(sourceVersion === targetVersion && sourceRevision === targetSha),
    EXPECTED_RELEASE_RISK: scope.risk,
    EXPECTED_DATABASE_REQUIRED: String(scope.database),
    EXPECTED_BROWSER_REQUIRED: String(scope.browser),
    SOURCE_MIGRATION_COUNT: sourceMigrationCount,
  });
  console.log(`STABLE_SOURCE_SCOPE_VERIFIED version=${sourceVersion} base=${sourceRevision} risk=${scope.risk} database=${scope.database} browser=${scope.browser}`);
}

async function ensureTagCurrent(tag, sha) {
  const branch = await githubApi("/git/ref/heads/main", { allow404: true });
  const { ref, tagObject } = await getTagInfo(tag);
  assertCurrentRemoteTargets(branch?.object?.sha, ref, tagObject, sha);
  console.log(`STABLE_REMOTE_TARGET_VERIFIED tag=${tag} sha=${sha}`);
}

function deploymentReceiptContext() {
  return {
    migrationCount: Number(process.env.MIGRATION_COUNT),
    sourceMigrationCount: Number(process.env.SOURCE_MIGRATION_COUNT),
    risk: process.env.RELEASE_RISK,
    databaseRequired: process.env.RELEASE_DATABASE_REQUIRED === "true",
  };
}

function validateDeploymentOutput(path, tag, sha) {
  const receipt = parseDeploymentReceipt(readFileSync(path, "utf8"), tag, sha, deploymentReceiptContext());
  writeGitHubEnv({ STABLE_DEPLOY_RECEIPT: receipt.line });
  console.log(`STABLE_DEPLOY_RECEIPT_VERIFIED tag=${tag} migrations=${receipt.migrationCount} backup=${receipt.backup} restore=${receipt.restore}`);
}

function releaseEvidenceBody({ notesPath, tag, sha, receiptPath }) {
  const notes = readFileSync(notesPath, "utf8").trim();
  requireCondition(notes.length > 0, "RELEASE_NOTES_EMPTY");
  const receipt = readFileSync(receiptPath, "utf8").trim();
  parseDeploymentReceipt(receipt, tag, sha, deploymentReceiptContext());
  const workflowUrl = `${process.env.GITHUB_SERVER_URL}/${repository()}/actions/runs/${process.env.GITHUB_RUN_ID}`;
  const mainUrl = process.env.MAIN_CI_RUN_URL;
  const actualRisk = process.env.RELEASE_RISK;
  const attestedRisk = process.env.MAIN_CI_ATTESTED_RISK;
  requireCondition(["low", "medium", "high"].includes(actualRisk), "RELEASE_RISK_INVALID");
  requireCondition(["low", "medium", "high"].includes(attestedRisk), "CI_ATTESTED_RISK_INVALID");
  for (const url of [workflowUrl, mainUrl]) {
    requireCondition(/^https:\/\/github\.com\/Jack-Kunlun\/ai-project-os\/actions\/runs\/\d+$/u.test(url ?? ""), "CI_EVIDENCE_URL_INVALID");
  }
  return `${notes}\n\n## 生产发布回执\n\n- 版本：\`${tag}\`\n- 提交：\`${sha}\`\n- 本次发布风险等级：\`${actualRisk}\`\n- 主分支 CI 验证等级：\`${attestedRisk}\`\n- 主分支分层 CI：[运行记录](${mainUrl})\n- 生产发布工作流：[运行记录](${workflowUrl})\n- 镜像发布与迁移回执：\`${receipt}\`\n`;
}

async function createReleaseAfterDeployment(tag, sha, version, receiptPath) {
  const notesPath = `docs/releases/v${version}.md`;
  const body = releaseEvidenceBody({ notesPath, tag, sha, receiptPath });
  const current = await githubApi(`/releases/tags/${tag}`, { allow404: true });
  if (current) {
    requireCondition(current.tag_name === tag && current.draft === false && current.prerelease === false, "EXISTING_RELEASE_STATE_INVALID");
    requireCondition(/^https:\/\/github\.com\/Jack-Kunlun\/ai-project-os\/releases\/tag\//u.test(current.html_url ?? ""), "GITHUB_RELEASE_URL_INVALID");
    writeGitHubEnv({ STABLE_GITHUB_RELEASE_URL: current.html_url });
    console.log(`STABLE_GITHUB_RELEASE_REUSED tag=${tag} url=${current.html_url}`);
    return;
  }
  const created = await githubApi("/releases", {
    method: "POST",
    body: { tag_name: tag, name: tag, body, draft: false, prerelease: false, generate_release_notes: false },
  });
  requireCondition(created?.tag_name === tag && created?.draft === false && created?.prerelease === false, "GITHUB_RELEASE_CREATE_INVALID");
  requireCondition(/^https:\/\/github\.com\/Jack-Kunlun\/ai-project-os\/releases\/tag\//u.test(created.html_url ?? ""), "GITHUB_RELEASE_URL_INVALID");
  writeGitHubEnv({ STABLE_GITHUB_RELEASE_URL: created.html_url });
  console.log(`STABLE_GITHUB_RELEASE_CREATED tag=${tag} url=${created.html_url}`);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "validate-candidate": {
      const candidate = candidateContext();
      writeGitHubEnv({
        RELEASE_VERSION: candidate.version,
        RELEASE_TAG: candidate.tag,
        MIGRATION_COUNT: candidate.migrationCount,
      });
      githubOutput({ version: candidate.version, tag: candidate.tag, migrations: candidate.migrationCount });
      console.log(`STABLE_CANDIDATE_VERIFIED tag=${candidate.tag} sha=${candidate.sha} migrations=${candidate.migrationCount}`);
      return;
    }
    case "wait-main-ci": {
      await waitForMainCi(process.env.GITHUB_SHA, {
        risk: process.env.EXPECTED_RELEASE_RISK,
        base: process.env.PRODUCTION_SOURCE_SHA,
        database: process.env.EXPECTED_DATABASE_REQUIRED === "true",
        browser: process.env.EXPECTED_BROWSER_REQUIRED === "true",
      }, process.env.RELEASE_ALREADY_CURRENT === "true");
      return;
    }
    case "verify-source-health": {
      await validatePublicSourceHealth(process.env.RELEASE_VERSION, process.env.GITHUB_SHA);
      return;
    }
    case "verify-tooling": {
      requireCondition(args.length === 1, "ARGUMENTS_INVALID");
      validateSshHost(process.env.PRODUCTION_SSH_HOST);
      await validateToolingFile(resolve(args[0]), process.env.GITHUB_SHA);
      return;
    }
    case "export-context": {
      const fields = ["RELEASE_VERSION", "RELEASE_TAG", "MIGRATION_COUNT", "SOURCE_MIGRATION_COUNT",
        "MAIN_CI_RUN_ID", "MAIN_CI_RUN_URL", "MAIN_CI_SOURCE_BASE", "MAIN_CI_ATTESTED_RISK",
        "RELEASE_RISK", "RELEASE_DATABASE_REQUIRED", "RELEASE_BROWSER_REQUIRED"];
      const values = Object.fromEntries(fields.map((field) => [field, process.env[field]]));
      requireCondition(Object.values(values).every((value) => typeof value === "string" && value.length > 0
        && !/[\r\n]/u.test(value)), "RELEASE_CONTEXT_INVALID");
      githubOutput(Object.fromEntries(Object.entries(values).map(([name, value]) => [name.toLowerCase(), value])));
      return;
    }
    case "ensure-tag": {
      await createOrReuseTag(process.env.RELEASE_TAG, process.env.GITHUB_SHA);
      return;
    }
    case "attest-tag": {
      await attestTagIdentity();
      return;
    }
    case "assert-current-target": {
      await ensureTagCurrent(process.env.RELEASE_TAG, process.env.GITHUB_SHA);
      return;
    }
    case "verify-deployment": {
      requireCondition(args.length === 1, "ARGUMENTS_INVALID");
      validateDeploymentOutput(resolve(args[0]), process.env.RELEASE_TAG, process.env.GITHUB_SHA);
      return;
    }
    case "publish-release": {
      const receiptPath = args[0];
      requireCondition(args.length === 1 && basename(receiptPath) === "stable-deploy.log", "ARGUMENTS_INVALID");
      healthyProductionPayload(await healthJson(), process.env.RELEASE_VERSION);
      await createReleaseAfterDeployment(process.env.RELEASE_TAG, process.env.GITHUB_SHA, process.env.RELEASE_VERSION, resolve(receiptPath));
      return;
    }
    default:
      fail("COMMAND_INVALID");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    const message = typeof error?.message === "string" && /^STABLE_[A-Z0-9_]+$/u.test(error.message)
      ? error.message
      : "STABLE_UNEXPECTED_FAILURE";
    console.error(message);
    process.exitCode = 1;
  });
}
