import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyProductionChange,
  conservativeRiskScope,
  isStableReleaseVersion,
  resolveProductionBase,
  validateProductionHealth,
} from "../scripts/ci-change-scope.mjs";

const source = "a".repeat(40);
const target = "b".repeat(40);
const healthy = {
  status: "ok",
  version: "1.0.1",
  database: "up",
  worker: { status: "up", consecutiveFailures: 0 },
};

function sourceGit({ annotated = true, ancestor = true } = {}) {
  return (args) => {
    if (args[0] === "cat-file") {
      return annotated ? "tag" : "commit";
    }
    if (args[0] === "rev-parse") return source;
    if (args[0] === "merge-base" && ancestor) return "";
    throw new Error("GIT_CHECK_FAILED");
  };
}

test("production version must be healthy stable semver", () => {
  assert.equal(isStableReleaseVersion("1.0.0"), true);
  assert.equal(isStableReleaseVersion("0.9.0"), false);
  assert.equal(isStableReleaseVersion("1.0.0-rc.1"), false);
  assert.equal(validateProductionHealth(healthy), "1.0.1");
  assert.throws(() => validateProductionHealth({ ...healthy, database: "down" }), /PRODUCTION_HEALTH_INVALID/u);
});

test("scope resolves the annotated production tag commit and requires it to be an ancestor", () => {
  const calls = [];
  const base = resolveProductionBase(healthy, target, (args) => {
    calls.push(args);
    return sourceGit()(args);
  });
  assert.deepEqual(base, { version: "1.0.1", tag: "v1.0.1", revision: source });
  assert.deepEqual(calls, [
    ["cat-file", "-t", "refs/tags/v1.0.1"],
    ["rev-parse", "refs/tags/v1.0.1^{}"],
    ["merge-base", "--is-ancestor", source, target],
  ]);
  assert.throws(() => resolveProductionBase(healthy, target, sourceGit({ annotated: false })), /PRODUCTION_SOURCE_TAG_NOT_ANNOTATED/u);
  assert.throws(() => resolveProductionBase(healthy, target, sourceGit({ ancestor: false })), /GIT_CHECK_FAILED/u);
});

test("risk output follows the pinned classifier for the cumulative source-to-target range", () => {
  let classified;
  const result = classifyProductionChange({
    payload: healthy,
    targetRevision: target,
    runGit: sourceGit(),
    classify: (base, revision) => {
      classified = [base, revision];
      return { risk: "medium", databaseRequired: false, browserRequired: true, coverageRequired: true };
    },
  });
  assert.deepEqual(classified, [source, target]);
  assert.deepEqual(result, {
    risk: "medium",
    base: source,
    database: false,
    browser: true,
    coverage: true,
  });
});

test("unknown production base fails conservatively and cannot masquerade as releaseable scope", () => {
  assert.deepEqual(classifyProductionChange({
    payload: healthy,
    targetRevision: target,
    runGit: sourceGit({ ancestor: false }),
    classify: () => assert.fail("classifier must not run without a source ancestor"),
  }), conservativeRiskScope("unknown"));
  assert.deepEqual(classifyProductionChange({
    payload: { ...healthy, worker: { status: "down", consecutiveFailures: 1 } },
    targetRevision: target,
    runGit: sourceGit(),
    classify: () => assert.fail("classifier must not run for unhealthy production"),
  }), conservativeRiskScope("unknown"));
});

test("classifier errors and incomplete high-risk gates fail toward the full high-risk suite", () => {
  const failed = classifyProductionChange({
    payload: healthy,
    targetRevision: target,
    runGit: sourceGit(),
    classify: () => { throw new Error("classifier unavailable"); },
  });
  assert.deepEqual(failed, conservativeRiskScope(source));

  const incomplete = classifyProductionChange({
    payload: healthy,
    targetRevision: target,
    runGit: sourceGit(),
    classify: () => ({ risk: "high", databaseRequired: true, browserRequired: false, coverageRequired: true }),
  });
  assert.deepEqual(incomplete, conservativeRiskScope(source));
});
