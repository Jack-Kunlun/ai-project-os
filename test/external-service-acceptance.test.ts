import assert from "node:assert/strict";
import type { PrismaClient } from "@prisma/client";
import test from "node:test";

import {
  buildExternalServiceAcceptanceReport,
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

test("frozen MCP acceptance never reads legacy actions or reports a ready workflow", async () => {
  const now = new Date("2026-09-06T12:00:00.000Z");
  const db = {
    aiProviderConnection: { findMany: async () => [] },
    gitConnection: { findMany: async () => [] },
    gitHubConnection: { findMany: async () => [] },
    oidcProvider: { findMany: async () => [] },
    mcpConnection: {
      findMany: async () => [{
        status: "verified",
        lastDiscoveredAt: new Date(now.getTime() - 60_000),
        lastErrorCode: null,
        resolvedAddressFingerprint: "a".repeat(64),
      }],
    },
    get projectAction(): never {
      throw new Error("LEGACY_MCP_ACTION_EVIDENCE_MUST_NOT_BE_READ");
    },
  } as unknown as PrismaClient;

  const report = await buildExternalServiceAcceptanceReport(db, {
    expected: ["mcp"],
    maxAgeHours: 24,
    now,
  });
  assert.equal(report.ok, false);
  assert.deepEqual(report.categories.mcp, {
    configured: 1,
    verified: 1,
    freshProbes: 1,
    freshWorkflows: 0,
    required: true,
    status: "workflow_required",
    reasonCode: "MCP_WORKFLOW_REQUIRED",
  });
});
