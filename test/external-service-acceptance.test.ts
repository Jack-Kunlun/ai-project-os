import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateExternalServiceCategory,
  EXTERNAL_SERVICE_CATEGORIES,
  ExternalServiceAcceptanceError,
  parseExternalAcceptanceArguments,
} from "../src/lib/external-service-acceptance";

test("external acceptance arguments default to every category and reject ambiguous scope", () => {
  assert.deepEqual(parseExternalAcceptanceArguments([]), {
    expected: EXTERNAL_SERVICE_CATEGORIES,
    maxAgeHours: 24,
  });
  assert.deepEqual(parseExternalAcceptanceArguments(["--expected", "git,model", "--max-age-hours=48"]), {
    expected: ["model", "git"],
    maxAgeHours: 48,
  });

  for (const args of [
    ["--expected", "model,model"],
    ["--expected=unknown"],
    ["--max-age-hours=0"],
    ["--max-age-hours=169"],
    ["--expected"],
    ["--unexpected"],
  ]) {
    assert.throws(
      () => parseExternalAcceptanceArguments(args),
      (error: unknown) => error instanceof ExternalServiceAcceptanceError && error.code === "EXTERNAL_ACCEPTANCE_ARGUMENT_INVALID",
    );
  }
});

test("external evidence classification never treats a probe alone as field acceptance", () => {
  assert.equal(evaluateExternalServiceCategory("model", { configured: 0, verified: 0, freshProbes: 0, freshWorkflows: 0 }, true).status, "missing");
  assert.equal(evaluateExternalServiceCategory("git", { configured: 1, verified: 0, freshProbes: 0, freshWorkflows: 0 }, true).status, "probe_required");
  assert.equal(evaluateExternalServiceCategory("oidc", { configured: 1, verified: 1, freshProbes: 0, freshWorkflows: 0 }, true).status, "stale");
  assert.equal(evaluateExternalServiceCategory("mcp", { configured: 1, verified: 1, freshProbes: 1, freshWorkflows: 0 }, true).status, "workflow_required");
  assert.deepEqual(
    evaluateExternalServiceCategory("model", { configured: 2, verified: 2, freshProbes: 1, freshWorkflows: 1 }, true),
    {
      configured: 2,
      verified: 2,
      freshProbes: 1,
      freshWorkflows: 1,
      required: true,
      status: "ready",
      reasonCode: "MODEL_READY",
    },
  );
});
