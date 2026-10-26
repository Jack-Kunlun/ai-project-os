import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { planRepositoryImpact } from "./ci-impact-plan.mjs";

const shaPattern = /^[a-f0-9]{40}$/u;
const stableVersionPattern = /^([1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const classifierPath = "deploy/production/ai-project-os-release-stable.py";
const classifierProgram = [
  "import importlib.util, json, sys",
  "module_path, repository, source_revision, target_revision = sys.argv[1:5]",
  "spec = importlib.util.spec_from_file_location('ai_project_os_release_stable', module_path)",
  "if spec is None or spec.loader is None: raise RuntimeError('classifier module unavailable')",
  "module = importlib.util.module_from_spec(spec)",
  "sys.modules[spec.name] = module",
  "spec.loader.exec_module(module)",
  "result = module.classify_release_risk(repository, source_revision, target_revision)",
  "print(json.dumps(result, separators=(',', ':'))) ",
].join("\n");

export function isStableReleaseVersion(value) {
  return typeof value === "string" && stableVersionPattern.test(value);
}

export function validateProductionHealth(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("PRODUCTION_HEALTH_INVALID");
  }
  if (!isStableReleaseVersion(payload.version)
      || payload.status !== "ok"
      || payload.database !== "up"
      || payload.worker?.status !== "up"
      || payload.worker?.consecutiveFailures !== 0) {
    throw new Error("PRODUCTION_HEALTH_INVALID");
  }
  return payload.version;
}

function defaultGit(args) {
  const result = spawnSync("git", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error("GIT_CHECK_FAILED");
  return result.stdout.trim();
}

export function resolveProductionBase(payload, targetRevision, runGit = defaultGit) {
  if (!shaPattern.test(targetRevision ?? "")) throw new Error("TARGET_REVISION_INVALID");
  const version = validateProductionHealth(payload);
  const tag = `v${version}`;
  if (runGit(["cat-file", "-t", `refs/tags/${tag}`]) !== "tag") {
    throw new Error("PRODUCTION_SOURCE_TAG_NOT_ANNOTATED");
  }
  const revision = runGit(["rev-parse", `refs/tags/${tag}^{}`]);
  if (!shaPattern.test(revision)) throw new Error("PRODUCTION_SOURCE_REVISION_INVALID");
  runGit(["merge-base", "--is-ancestor", revision, targetRevision]);
  return { version, tag, revision };
}

export function conservativeRiskScope(base = "unknown") {
  return {
    risk: "high",
    base,
    database: true,
    browser: true,
    coverage: true,
  };
}

function normalizedClassification(value, base) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || !["low", "medium", "high"].includes(value.risk)
      || typeof value.databaseRequired !== "boolean"
      || typeof value.browserRequired !== "boolean"
      || typeof value.coverageRequired !== "boolean") {
    throw new Error("RELEASE_RISK_CLASSIFICATION_INVALID");
  }
  if (value.risk === "high" && (!value.databaseRequired || !value.browserRequired || !value.coverageRequired)) {
    throw new Error("RELEASE_RISK_CLASSIFICATION_INCOMPLETE");
  }
  if (value.risk === "medium" && !value.browserRequired) {
    throw new Error("RELEASE_RISK_CLASSIFICATION_INCOMPLETE");
  }
  return {
    risk: value.risk,
    base,
    database: value.databaseRequired,
    browser: value.browserRequired,
    coverage: value.coverageRequired,
  };
}

export function classifyProductionChange({
  payload,
  targetRevision,
  runGit = defaultGit,
  classify,
}) {
  let source;
  try {
    source = resolveProductionBase(payload, targetRevision, runGit);
  } catch {
    return conservativeRiskScope("unknown");
  }
  try {
    if (typeof classify !== "function") throw new Error("RELEASE_RISK_CLASSIFIER_UNAVAILABLE");
    return normalizedClassification(classify(source.revision, targetRevision), source.revision);
  } catch {
    return conservativeRiskScope(source.revision);
  }
}

export function invokePinnedRiskClassifier(repository, sourceRevision, targetRevision) {
  if (!shaPattern.test(sourceRevision ?? "") || !shaPattern.test(targetRevision ?? "")) {
    throw new Error("RELEASE_RISK_REVISION_INVALID");
  }
  const repositoryPath = resolve(repository);
  const modulePath = resolve(repositoryPath, classifierPath);
  const result = spawnSync("/usr/bin/python3", [
    "-I",
    "-B",
    "-c",
    classifierProgram,
    modulePath,
    repositoryPath,
    sourceRevision,
    targetRevision,
  ], { encoding: "utf8", maxBuffer: 1024 * 1024 });
  if (result.status !== 0) throw new Error("RELEASE_RISK_CLASSIFIER_FAILED");
  return JSON.parse(result.stdout);
}

async function fetchProductionHealth() {
  const response = await fetch("https://ai-project-os.com/api/health", {
    headers: { Accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status !== 200) throw new Error("PRODUCTION_HEALTH_HTTP_INVALID");
  return response.json();
}

function writeScope(scope, impact = planRepositoryImpact(process.cwd(), scope.base, process.env.CI_HEAD_SHA ?? "")) {
  if (impact.mode === "full" && scope.risk !== "high") scope = conservativeRiskScope(scope.base);
  const output = [
    `risk=${scope.risk}`,
    `base=${scope.base}`,
    `database=${scope.database}`,
    `browser=${scope.browser}`,
    `coverage=${scope.coverage}`,
    `impact_gate_filter=${impact.gateFilter}`,
    `impact_phone_auth=${impact.phoneAuth}`,
    `impact_oid10=${impact.oid10}`,
    `impact_browser=${impact.browser}`,
    `impact_candidate=${impact.candidate}`,
    `impact_schema_validation=${impact.schemaValidation}`,
  ].join("\n") + "\n";
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output, { mode: 0o600 });
  process.stdout.write(`CI_CHANGE_SCOPE risk=${scope.risk} base=${scope.base} database=${scope.database} browser=${scope.browser} coverage=${scope.coverage} gates=${impact.gateFilter} phone=${impact.phoneAuth} oid10=${impact.oid10} imageBrowser=${impact.browser} candidate=${impact.candidate} reason=${impact.reason}\n`);
}

async function main() {
  const targetRevision = process.env.CI_HEAD_SHA ?? "";
  let scope;
  try {
    const payload = await fetchProductionHealth();
    scope = classifyProductionChange({
      payload,
      targetRevision,
      classify: (sourceRevision, target) => invokePinnedRiskClassifier(process.cwd(), sourceRevision, target),
    });
  } catch {
    scope = conservativeRiskScope();
  }
  writeScope(scope);
}

if (process.argv[1]?.endsWith("ci-change-scope.mjs")) {
  main().catch(() => {
    writeScope(conservativeRiskScope());
  });
}
