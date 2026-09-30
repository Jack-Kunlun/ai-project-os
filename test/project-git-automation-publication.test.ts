import assert from "node:assert/strict";
import test from "node:test";
import { finalizeProjectGitAutomationRunResult } from "../src/lib/project-git-automation-run-service";

const validFence = Object.freeze({
  runId: "6bd4d26a-7bde-40c4-a547-83c3852c6824",
  workerId: "test-worker",
  leaseToken: "f9a857d5-f22d-47e9-a8bf-7c581a536fe9",
  commitSha: "a".repeat(40),
  outcome: "changed",
});

async function assertInvalidFiles(files: unknown): Promise<void> {
  await assert.rejects(
    () => finalizeProjectGitAutomationRunResult({ ...validFence, files }, {} as never),
    (error: unknown) => error instanceof Error
      && (error as Error & { code?: string }).code === "PROJECT_GIT_AUTOMATION_RESULT_INVALID_INPUT",
  );
}

test("automatic Git publication input rejects duplicate paths, oversized bodies, noncanonical paths and source IDs", async () => {
  await assertInvalidFiles([
    { path: "README.md", blobOid: "b".repeat(40), body: "one" },
    { path: "README.md", blobOid: "c".repeat(40), body: "two" },
  ]);
  await assertInvalidFiles([{ path: "README.md", blobOid: "b".repeat(40), body: "x".repeat(96 * 1024 + 1) }]);
  await assertInvalidFiles([{ path: "../README.md", blobOid: "b".repeat(40), body: "body" }]);
  await assertInvalidFiles([{ path: "README.md", blobOid: "b".repeat(40), body: "body", sourceId: "forged" }]);
  await assertInvalidFiles([{ path: "README.md", blobOid: "B".repeat(40), body: "body" }]);
});

test("automatic unchanged outcomes require an empty manifest", async () => {
  await assert.rejects(
    () => finalizeProjectGitAutomationRunResult({
      ...validFence,
      outcome: "unchanged",
      files: [{ path: "README.md", blobOid: "b".repeat(40), body: "body" }],
    }, {} as never),
    (error: unknown) => error instanceof Error
      && (error as Error & { code?: string }).code === "PROJECT_GIT_AUTOMATION_RESULT_INVALID_INPUT",
  );
});
