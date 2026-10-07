import assert from "node:assert/strict";
import test from "node:test";
import { Prisma, type PrismaClient } from "@prisma/client";
import { GitRunnerError, GitSafetyError, GitServiceError } from "../src/lib/git";
import { GitHubMaterialScanError } from "../src/lib/github/material-scanner";
import { GitHubReadError } from "../src/lib/github/read-only-client";
import {
  gitAutomationDiagnosticErrorCode,
  reportGitAutomationDiagnostic,
  type GitAutomationDiagnostic,
} from "../src/lib/project-git-automation-diagnostics";
import { runOneGitAutomationMaterialCycle } from "../src/lib/project-git-automation-material-execution-service";
import { runOneGitAutomationCycle } from "../src/lib/project-git-automation-execution-service";

const noDatabase = Object.freeze({}) as PrismaClient;

test("diagnostic error codes come only from known classes and fixed allowlists", () => {
  assert.equal(gitAutomationDiagnosticErrorCode(new GitRunnerError("GIT_OPERATION_TIMEOUT")), "GIT_OPERATION_TIMEOUT");
  assert.equal(gitAutomationDiagnosticErrorCode(new GitSafetyError("GIT_NETWORK_CHANGED")), "GIT_NETWORK_CHANGED");
  assert.equal(gitAutomationDiagnosticErrorCode(new GitServiceError("GIT_CONNECTION_NOT_VERIFIED")), "GIT_CONNECTION_NOT_VERIFIED");
  assert.equal(gitAutomationDiagnosticErrorCode(new GitHubReadError("GITHUB_RATE_LIMITED")), "GITHUB_RATE_LIMITED");
  assert.equal(gitAutomationDiagnosticErrorCode(new GitHubMaterialScanError("GITHUB_MATERIAL_SCAN_COVERAGE_INCOMPLETE")), "GITHUB_MATERIAL_SCAN_COVERAGE_INCOMPLETE");

  const secret = "private response body and credential detail";
  const unknown = Object.assign(new Error(secret), { code: "PRIVATE_CODE" });
  assert.equal(gitAutomationDiagnosticErrorCode(unknown), "UNKNOWN_ERROR");
  assert.equal(JSON.stringify(gitAutomationDiagnosticErrorCode(unknown)).includes(secret), false);

  const hostileUnknown = new Proxy(new Error(secret), {
    getPrototypeOf: () => {
      throw new Error(secret);
    },
  });
  assert.equal(gitAutomationDiagnosticErrorCode(hostileUnknown), "UNKNOWN_ERROR");

  const knownClassWithUnknownCode = new GitRunnerError("GIT_OPERATION_FAILED");
  Object.defineProperty(knownClassWithUnknownCode, "code", { value: secret });
  assert.equal(gitAutomationDiagnosticErrorCode(knownClassWithUnknownCode), "UNKNOWN_ERROR");
});

test("Prisma diagnostics map only allowlisted codes and never return database messages", () => {
  const secretMessage = "database row contents and SQL detail";
  const known = new Prisma.PrismaClientKnownRequestError(secretMessage, {
    code: "P2010",
    clientVersion: "test",
    meta: { message: secretMessage, code: "42501" },
  });
  assert.equal(gitAutomationDiagnosticErrorCode(known), "DATABASE_QUERY_FAILED");
  assert.equal(JSON.stringify(gitAutomationDiagnosticErrorCode(known)).includes(secretMessage), false);

  const unknownCode = new Prisma.PrismaClientKnownRequestError(secretMessage, {
    code: "P9999",
    clientVersion: "test",
    meta: { message: secretMessage },
  });
  assert.equal(gitAutomationDiagnosticErrorCode(unknownCode), "UNKNOWN_ERROR");
});

test("diagnostic observer failures do not escape or change the deferred result", async () => {
  const diagnostic: GitAutomationDiagnostic = { stage: "context", errorCode: "READ_CONTEXT_UNAVAILABLE" };
  const outcome = (() => {
    reportGitAutomationDiagnostic(() => {
      throw new Error("private observer error");
    }, diagnostic);
    return "deferred" as const;
  })();
  assert.equal(outcome, "deferred");

  reportGitAutomationDiagnostic(async () => {
    throw new Error("private async observer error");
  }, diagnostic);
  await new Promise<void>((resolve) => setImmediate(resolve));
});

test("claim failures emit a safe stage diagnostic and preserve the original failure", async () => {
  const codeDiagnostics: GitAutomationDiagnostic[] = [];
  await assert.rejects(
    () => runOneGitAutomationCycle({
      workerId: "git-automation-diagnostics",
      db: noDatabase,
      stopSignal: new AbortController().signal,
      onDiagnostic: (diagnostic) => {
        codeDiagnostics.push(diagnostic);
      },
    }),
    /PROJECT_GIT_AUTOMATION_WORKER_DATABASE_REQUIRED/u,
  );
  assert.deepEqual(codeDiagnostics, [{
    stage: "claim",
    errorCode: "PROJECT_GIT_AUTOMATION_WORKER_DATABASE_REQUIRED",
  }]);

  await assert.rejects(
    () => runOneGitAutomationCycle({
      workerId: "git-automation-diagnostics",
      db: noDatabase,
      stopSignal: new AbortController().signal,
      onDiagnostic: () => {
        throw new Error("private observer failure");
      },
    }),
    /PROJECT_GIT_AUTOMATION_WORKER_DATABASE_REQUIRED/u,
  );

  const materialDiagnostics: GitAutomationDiagnostic[] = [];
  await assert.rejects(
    () => runOneGitAutomationMaterialCycle({
      workerId: "git-automation-diagnostics",
      db: noDatabase,
      stopSignal: new AbortController().signal,
      onDiagnostic: (diagnostic) => {
        materialDiagnostics.push(diagnostic);
      },
    }),
    /PROJECT_GIT_AUTOMATION_WORKER_DATABASE_REQUIRED/u,
  );
  assert.deepEqual(materialDiagnostics, [{
    stage: "claim",
    errorCode: "PROJECT_GIT_AUTOMATION_WORKER_DATABASE_REQUIRED",
  }]);
});
