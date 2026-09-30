import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import {
  claimNextProjectGitAutomationMaterialRun,
  finalizeProjectGitAutomationMaterialRun,
  heartbeatProjectGitAutomationMaterialRun,
  markProjectGitAutomationMaterialRunDispatched,
  materialKindForDatabase,
  materialKindForScanner,
  ProjectGitAutomationMaterialRunServiceError,
  validateMaterialSourcesForClaim,
  type ProjectGitAutomationMaterialRunClaim,
} from "../src/lib/project-git-automation-material-run-service";
import {
  claimNextProjectGitAutomationRun,
  finalizeProjectGitAutomationRunResult,
  heartbeatProjectGitAutomationRun,
  markProjectGitAutomationRunDispatched,
  ProjectGitAutomationRunServiceError,
} from "../src/lib/project-git-automation-run-service";
import type { ScannedGitHubMaterialSource } from "../src/lib/github/material-scanner";
import { loadGitAutomationMaterialReadContext } from "../src/lib/project-git-automation-material-read-context";
import { loadGitAutomationReadContext } from "../src/lib/project-git-automation-read-context";

const runId = "11111111-1111-4111-8111-111111111111";
const leaseToken = "22222222-2222-4222-8222-222222222222";
const noDatabase = Object.freeze({}) as PrismaClient;

function hasCode(code: string) {
  return (error: unknown) => error instanceof ProjectGitAutomationMaterialRunServiceError && error.code === code;
}

test("material kind mapping keeps pull requests separate and rejects mixed claim results", () => {
  assert.deepEqual(["issue", "pull_request", "release"].map((kind) => materialKindForScanner(kind as "issue" | "pull_request" | "release")), ["issue", "pullRequest", "release"]);
  assert.deepEqual(["issue", "pullRequest", "release"].map((kind) => materialKindForDatabase(kind as "issue" | "pullRequest" | "release")), ["issue", "pull_request", "release"]);

  const claim = { materialKind: "pull_request" } as ProjectGitAutomationMaterialRunClaim;
  const pullRequest = { materialKind: "pullRequest" } as ScannedGitHubMaterialSource;
  const issue = { materialKind: "issue" } as ScannedGitHubMaterialSource;
  assert.doesNotThrow(() => validateMaterialSourcesForClaim(claim, [pullRequest]));
  assert.throws(() => validateMaterialSourcesForClaim(claim, [pullRequest, issue]), hasCode("PROJECT_GIT_MATERIAL_RESULT_INVALID_INPUT"));
});

test("material run rejects malformed leases before touching a database", async () => {
  await assert.rejects(() => claimNextProjectGitAutomationMaterialRun("bad worker!", noDatabase), hasCode("PROJECT_GIT_MATERIAL_RUN_INVALID_INPUT"));
  await assert.rejects(() => markProjectGitAutomationMaterialRunDispatched("bad-id", "worker-1", leaseToken, noDatabase), hasCode("PROJECT_GIT_MATERIAL_RUN_INVALID_INPUT"));
  await assert.rejects(() => heartbeatProjectGitAutomationMaterialRun(runId, "bad worker!", leaseToken, noDatabase), hasCode("PROJECT_GIT_MATERIAL_RUN_INVALID_INPUT"));
  await assert.rejects(() => claimNextProjectGitAutomationMaterialRun("worker-1", noDatabase), hasCode("PROJECT_GIT_AUTOMATION_WORKER_DATABASE_REQUIRED"));
});

test("material read context requires the dedicated Git worker database", async () => {
  await assert.rejects(
    () => loadGitAutomationMaterialReadContext({ runId, workerId: "worker-1", leaseToken }, noDatabase),
    /GIT_AUTOMATION_WORKER_DATABASE_REQUIRED/u,
  );
  await assert.rejects(
    () => loadGitAutomationReadContext({ runId, workerId: "worker-1", leaseToken }, noDatabase),
    /GIT_AUTOMATION_WORKER_DATABASE_REQUIRED/u,
  );
});

test("material finalizer validates source bytes and digest before a database write", async () => {
  const contentText = "safe GitHub issue body";
  const source = {
    materialKind: "issue",
    remoteIdentity: "issue-1",
    remoteRevisionFingerprint: "a".repeat(64),
    remoteNumber: 1,
    normalizedPath: null,
    externalRef: "https://github.com/example/repo/issues/1",
    capturedAt: "2026-09-30T00:00:00.000Z",
    contentText,
    contentHash: createHash("sha256").update(contentText).digest("hex"),
    contentBytes: Buffer.byteLength(contentText),
  };
  const base = {
    runId, workerId: "worker-1", leaseToken,
    repositoryId: 123, repositoryNodeId: "R_123",
    observedHeadCommitSha: "b".repeat(40),
  };
  await assert.rejects(() => finalizeProjectGitAutomationMaterialRun({ ...base, sources: [{ ...source, contentBytes: source.contentBytes + 1 }] }, noDatabase), hasCode("PROJECT_GIT_MATERIAL_RESULT_INVALID_INPUT"));
  await assert.rejects(() => finalizeProjectGitAutomationMaterialRun({ ...base, sources: [{ ...source, contentHash: "c".repeat(64) }] }, noDatabase), hasCode("PROJECT_GIT_MATERIAL_RESULT_INVALID_INPUT"));
  await assert.rejects(() => finalizeProjectGitAutomationMaterialRun({ ...base, sources: [source] }, noDatabase), hasCode("PROJECT_GIT_AUTOMATION_WORKER_DATABASE_REQUIRED"));
});

test("code automation lease and publication reject invalid inputs before database access", async () => {
  const code = (expected: string) => (error: unknown) => error instanceof ProjectGitAutomationRunServiceError && error.code === expected;
  await assert.rejects(() => claimNextProjectGitAutomationRun("bad worker!", noDatabase), code("PROJECT_GIT_AUTOMATION_RUN_INVALID_INPUT"));
  await assert.rejects(() => markProjectGitAutomationRunDispatched("bad-id", "worker-1", leaseToken, noDatabase), code("PROJECT_GIT_AUTOMATION_RUN_INVALID_INPUT"));
  await assert.rejects(() => heartbeatProjectGitAutomationRun(runId, "bad worker!", leaseToken, noDatabase), code("PROJECT_GIT_AUTOMATION_RUN_INVALID_INPUT"));
  await assert.rejects(() => claimNextProjectGitAutomationRun("worker-1", noDatabase), code("PROJECT_GIT_AUTOMATION_WORKER_DATABASE_REQUIRED"));

  const base = { runId, workerId: "worker-1", leaseToken, commitSha: "a".repeat(40) };
  await assert.rejects(() => finalizeProjectGitAutomationRunResult({ ...base, outcome: "unchanged", files: [{ path: "README.md", blobOid: "b".repeat(40), body: "text" }] }, noDatabase), code("PROJECT_GIT_AUTOMATION_RESULT_INVALID_INPUT"));
  await assert.rejects(() => finalizeProjectGitAutomationRunResult({ ...base, outcome: "changed", files: [] }, noDatabase), code("PROJECT_GIT_AUTOMATION_RESULT_INVALID_INPUT"));
});
