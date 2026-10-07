import { Prisma } from "@prisma/client";
import {
  GitRunnerError,
  GitSafetyError,
  GitServiceError,
  type GitRunnerErrorCode,
  type GitSafetyErrorCode,
  type GitServiceErrorCode,
} from "@/lib/git";
import { GitHubMaterialScanError, type GitHubMaterialScanErrorCode } from "@/lib/github/material-scanner";
import { GitHubReadError, type GitHubReadErrorCode } from "@/lib/github/read-only-client";
import {
  ProjectGitAutomationMaterialRunServiceError,
  type ProjectGitAutomationMaterialRunServiceErrorCode,
} from "@/lib/project-git-automation-material-run-service";
import {
  ProjectGitAutomationRunServiceError,
  type ProjectGitAutomationRunServiceErrorCode,
} from "@/lib/project-git-automation-run-service";

export type GitAutomationDiagnosticStage =
  | "claim"
  | "dispatch"
  | "context"
  | "scope"
  | "lease"
  | "endpoint"
  | "repository_read"
  | "credential"
  | "github_repository"
  | "material_scan"
  | "material_validation"
  | "finalize"
  | "worker_cycle"
  | "worker_startup";

export type GitAutomationDiagnosticErrorCode =
  | "DISPATCH_NOT_ACCEPTED"
  | "READ_CONTEXT_UNAVAILABLE"
  | "LEASE_NOT_ACTIVE"
  | "LEASE_RENEWAL_REJECTED"
  | "ADDRESS_FINGERPRINT_MISMATCH"
  | "FINALIZE_NOT_ACCEPTED"
  | "REPOSITORY_IDENTITY_UNAVAILABLE"
  | "MATERIAL_SCAN_INCOMPLETE"
  | "DATABASE_QUERY_FAILED"
  | "DATABASE_RECORD_MISSING"
  | "DATABASE_CONFLICT"
  | "WORKER_CYCLE_FAILED"
  | "WORKER_TERMINATED"
  | "UNKNOWN_ERROR"
  | GitRunnerErrorCode
  | GitSafetyErrorCode
  | GitServiceErrorCode
  | GitHubReadErrorCode
  | GitHubMaterialScanErrorCode
  | ProjectGitAutomationRunServiceErrorCode
  | ProjectGitAutomationMaterialRunServiceErrorCode;

export type GitAutomationDiagnostic = Readonly<{
  stage: GitAutomationDiagnosticStage;
  errorCode: GitAutomationDiagnosticErrorCode;
}>;

export type GitAutomationDiagnosticObserver =
  (diagnostic: GitAutomationDiagnostic) => void | Promise<void>;

const gitRunnerCodes: ReadonlySet<GitRunnerErrorCode> = new Set([
  "GIT_EXECUTABLE_UNAVAILABLE",
  "GIT_REMOTE_UNAVAILABLE",
  "GIT_AUTHENTICATION_FAILED",
  "GIT_HOST_KEY_REJECTED",
  "GIT_OPERATION_TIMEOUT",
  "GIT_OPERATION_ABORTED",
  "GIT_OUTPUT_TOO_LARGE",
  "GIT_OPERATION_FAILED",
  "GIT_REQUEST_BOUNDARY_REJECTED",
]);

const gitSafetyCodes: ReadonlySet<GitSafetyErrorCode> = new Set([
  "GIT_BASE_URL_INVALID",
  "GIT_REPOSITORY_PATH_INVALID",
  "GIT_REF_INVALID",
  "GIT_SCAN_SCOPE_INVALID",
  "GIT_HOST_UNRESOLVED",
  "GIT_NETWORK_BLOCKED",
  "GIT_NETWORK_CHANGED",
  "GIT_TLS_CA_INVALID",
  "GIT_SSH_KNOWN_HOST_INVALID",
]);

const gitServiceCodes: ReadonlySet<GitServiceErrorCode> = new Set([
  "GIT_CONNECTION_INVALID_INPUT",
  "GIT_CONNECTION_NOT_FOUND",
  "GIT_CONNECTION_NAME_CONFLICT",
  "GIT_CONNECTION_CONFLICT",
  "GIT_CONNECTION_IN_USE",
  "GIT_CONNECTION_DISABLED",
  "GIT_CONNECTION_NOT_VERIFIED",
  "GIT_LEGACY_PROJECT_CONNECT_FROZEN",
  "GIT_LEGACY_CONNECTION_API_FROZEN",
  "GIT_CONNECTION_DELETE_REQUIRES_DISABLED",
  "GIT_CONNECTION_CONFIRMATION_MISMATCH",
  "GIT_CONNECTION_GOVERNANCE_REQUIRED",
  "GIT_CONNECTION_PREVIEW_NOT_FOUND",
  "GIT_CONNECTION_PREVIEW_EXPIRED",
  "GIT_CONNECTION_PREVIEW_CONSUMED",
  "GIT_CONNECTION_PREVIEW_MISMATCH",
  "GIT_CONNECTION_IMPACT_CHANGED",
  "GIT_EXTERNAL_IO_PLANNED_NOT_DISPATCHED",
  "GIT_REPOSITORY_NOT_FOUND",
  "GIT_REPOSITORY_CONFLICT",
  "GIT_REPOSITORY_EMPTY",
  "GIT_REPOSITORY_TOO_LARGE",
  "GIT_REPOSITORY_BINARY_ONLY",
  "GIT_REPOSITORY_LINK_NOT_FOUND",
  "GIT_REPOSITORY_LINK_DISABLED",
  "GIT_REPOSITORY_SYNC_FAILED",
]);

const githubReadCodes: ReadonlySet<GitHubReadErrorCode> = new Set([
  "GITHUB_DISABLED",
  "GITHUB_CREDENTIAL_UNAVAILABLE",
  "GITHUB_INVALID_REQUEST",
  "GITHUB_ACCESS_UNKNOWN",
  "GITHUB_RATE_LIMITED",
  "GITHUB_REDIRECT_REJECTED",
  "GITHUB_RESPONSE_TOO_LARGE",
  "GITHUB_INVALID_RESPONSE",
  "GITHUB_REQUEST_TIMEOUT",
  "GITHUB_REQUEST_FAILED",
]);

const githubMaterialScanCodes: ReadonlySet<GitHubMaterialScanErrorCode> = new Set([
  "GITHUB_MATERIAL_SCAN_INVALID_INPUT",
  "GITHUB_MATERIAL_SCAN_IDENTITY_MISMATCH",
  "GITHUB_MATERIAL_SCAN_REFERENCE_CHANGED",
  "GITHUB_MATERIAL_SCAN_REMOTE_CHANGED",
  "GITHUB_MATERIAL_SCAN_SCOPE_NOT_FOUND",
  "GITHUB_MATERIAL_SCAN_TREE_INTEGRITY_ERROR",
  "GITHUB_MATERIAL_SCAN_BLOB_INTEGRITY_ERROR",
  "GITHUB_MATERIAL_SCAN_COVERAGE_INCOMPLETE",
  "GITHUB_MATERIAL_SCAN_BUDGET_EXCEEDED",
]);

const projectRunCodes: ReadonlySet<ProjectGitAutomationRunServiceErrorCode> = new Set([
  "PROJECT_GIT_AUTOMATION_RUN_INVALID_INPUT",
  "PROJECT_GIT_AUTOMATION_RUN_CONFLICT",
  "PROJECT_GIT_AUTOMATION_RESULT_INVALID_INPUT",
  "PROJECT_GIT_AUTOMATION_WORKER_DATABASE_REQUIRED",
  "PROJECT_GIT_AUTOMATION_WORKER_SESSION_INVALID",
]);

const materialRunCodes: ReadonlySet<ProjectGitAutomationMaterialRunServiceErrorCode> = new Set([
  "PROJECT_GIT_MATERIAL_RUN_INVALID_INPUT",
  "PROJECT_GIT_MATERIAL_RUN_CONFLICT",
  "PROJECT_GIT_MATERIAL_RESULT_INVALID_INPUT",
  "PROJECT_GIT_AUTOMATION_WORKER_DATABASE_REQUIRED",
  "PROJECT_GIT_AUTOMATION_WORKER_SESSION_INVALID",
]);

const prismaDiagnosticCodes: ReadonlyMap<string, GitAutomationDiagnosticErrorCode> = new Map([
  ["P2010", "DATABASE_QUERY_FAILED"],
  ["P2025", "DATABASE_RECORD_MISSING"],
  ["P2002", "DATABASE_CONFLICT"],
  ["P2003", "DATABASE_CONFLICT"],
  ["P2034", "DATABASE_CONFLICT"],
]);

function allowlisted<T extends string>(codes: ReadonlySet<T>, code: string): code is T {
  return codes.has(code as T);
}

/** Return only fixed application codes from explicitly known error classes. */
export function gitAutomationDiagnosticErrorCode(error: unknown): GitAutomationDiagnosticErrorCode {
  try {
    if (error instanceof GitRunnerError && allowlisted(gitRunnerCodes, error.code)) return error.code;
    if (error instanceof GitSafetyError && allowlisted(gitSafetyCodes, error.code)) return error.code;
    if (error instanceof GitServiceError && allowlisted(gitServiceCodes, error.code)) return error.code;
    if (error instanceof GitHubReadError && allowlisted(githubReadCodes, error.code)) return error.code;
    if (error instanceof GitHubMaterialScanError && allowlisted(githubMaterialScanCodes, error.code)) return error.code;
    if (error instanceof ProjectGitAutomationRunServiceError && allowlisted(projectRunCodes, error.code)) return error.code;
    if (error instanceof ProjectGitAutomationMaterialRunServiceError && allowlisted(materialRunCodes, error.code)) return error.code;
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      return prismaDiagnosticCodes.get(error.code) ?? "UNKNOWN_ERROR";
    }
  } catch {
    return "UNKNOWN_ERROR";
  }
  return "UNKNOWN_ERROR";
}

/** Diagnostics are best effort and must not delay, reject, or alter execution. */
export function reportGitAutomationDiagnostic(
  observer: GitAutomationDiagnosticObserver | undefined,
  diagnostic: GitAutomationDiagnostic,
): void {
  if (observer === undefined) return;
  try {
    const result = observer(diagnostic);
    if (result !== undefined) void Promise.resolve(result).catch(() => undefined);
  } catch {
    // Diagnostic observers are intentionally outside the execution result path.
  }
}
