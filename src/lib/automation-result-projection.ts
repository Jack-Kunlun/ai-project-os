import type { AutomationRuleKind, AutomationRunStatus, Prisma } from "@prisma/client";

const SAFE_FAILURE_CODE = /^[A-Z][A-Z0-9_]{2,63}$/u;
const KNOWN_FAILURE_CODES = new Set([
  "AUTOMATION_EXECUTION_FAILED",
  "AUTOMATION_LEASE_EXPIRED",
  "AUTOMATION_REPOSITORY_SYNC_FAILED",
  "AUTOMATION_WEB_SOURCE_PARTIAL_FAILURE",
  "WEB_SOURCE_CONTENT_EMPTY",
  "WEB_SOURCE_FETCH_FAILED",
  "WEB_SOURCE_HOST_UNRESOLVED",
  "WEB_SOURCE_HTTP_STATUS",
  "WEB_SOURCE_NETWORK_BLOCKED",
  "WEB_SOURCE_NETWORK_CHANGED",
  "WEB_SOURCE_REDIRECT_REJECTED",
  "WEB_SOURCE_REQUEST_BOUNDARY_REJECTED",
  "WEB_SOURCE_TOO_LARGE",
  "WEB_SOURCE_TYPE_UNSUPPORTED",
]);
const MAX_FAILURES = 20;
const MAX_RESULT_BYTES = 16_384;
const MAX_COUNT = 1_000_000;

const PLAN_HEALTH_COUNT_KEYS = [
  "active",
  "overdue",
  "dueSoon",
  "blocked",
  "dependencyBlocked",
  "unassigned",
  "missingAcceptance",
  "missingEvidence",
  "staleEvidence",
  "pendingRecommendations",
  "openImpacts",
  "pendingApprovals",
] as const;

type PlanHealthCountKey = (typeof PLAN_HEALTH_COUNT_KEYS)[number];

export type AutomationRunResultProjection = Readonly<{
  availability: "available" | "unavailable";
  kind: "waitingConsent" | "webSourceSync" | "memoryQuality" | "projectPlanHealth" | "repositorySync" | "unknown";
  reason?: "not_available" | "invalid" | "too_large" | "unsupported";
  delivery?: "waitingConsent" | "localNotification";
  modelSelection?: "deferred_to_ai_workbench";
  billing?: "none";
  externalTransfer?: false;
  notificationOnly?: true;
  successCount?: number | null;
  failedCount?: number | null;
  failures?: readonly Readonly<{ failureCode: string }>[];
  score?: number | null;
  openIssueCount?: number | null;
  healthStatus?: "empty" | "healthy" | "attention" | "atRisk" | null;
  counts?: Readonly<Record<PlanHealthCountKey, number | null>>;
  notifiedUserCount?: number | null;
}>;

function finiteCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return null;
  return Math.min(value, MAX_COUNT);
}

function finiteScore(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

export function safeAutomationFailureCode(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" && SAFE_FAILURE_CODE.test(value) && KNOWN_FAILURE_CODES.has(value)
    ? value
    : "AUTOMATION_EXECUTION_FAILED";
}

function safeFailureCode(value: unknown): string {
  return safeAutomationFailureCode(value) ?? "AUTOMATION_EXECUTION_FAILED";
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function withinBound(value: AutomationRunResultProjection): AutomationRunResultProjection {
  const serialized = JSON.stringify(value);
  if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > MAX_RESULT_BYTES) {
    return Object.freeze({ availability: "unavailable", kind: "unknown", reason: "too_large" });
  }
  return Object.freeze(value);
}

function unavailable(reason: "not_available" | "invalid" | "too_large" | "unsupported" = "not_available"): AutomationRunResultProjection {
  return Object.freeze({ availability: "unavailable", kind: "unknown", reason });
}

function planHealthProjection(result: Record<string, unknown>): AutomationRunResultProjection {
  const health = plainRecord(result.health);
  if (health === null) return unavailable("invalid");
  const rawCounts = plainRecord(health.counts);
  if (rawCounts === null) return unavailable("invalid");
  const counts = Object.fromEntries(PLAN_HEALTH_COUNT_KEYS.map((key) => [key, finiteCount(rawCounts[key])])) as Record<PlanHealthCountKey, number | null>;
  const status = health.status === "empty" || health.status === "healthy" || health.status === "attention" || health.status === "atRisk" ? health.status : null;
  return withinBound({
    availability: "available",
    kind: "projectPlanHealth",
    healthStatus: status,
    counts: Object.freeze(counts),
    notifiedUserCount: finiteCount(result.notifiedUserCount),
  });
}

function webSourceProjection(result: Record<string, unknown>): AutomationRunResultProjection {
  const successCount = finiteCount(result.successCount);
  const failedCount = finiteCount(result.failedCount);
  if (successCount === null || failedCount === null) return unavailable("invalid");
  const rawFailures = Array.isArray(result.failures) ? result.failures : [];
  const failures = rawFailures.slice(0, MAX_FAILURES).flatMap((failure) => {
    const row = plainRecord(failure);
    return row === null ? [] : [{ failureCode: safeFailureCode(row.failureCode) }];
  });
  return withinBound({ availability: "available", kind: "webSourceSync", successCount, failedCount, failures: Object.freeze(failures) });
}

/**
 * Project persisted automation results into a small, kind-specific DTO. Raw
 * JSON is never returned to a browser; unknown historical shapes fail closed.
 */
export function projectAutomationRunResult(
  kind: AutomationRuleKind,
  status: AutomationRunStatus,
  result: Prisma.JsonValue | null,
): AutomationRunResultProjection | null {
  if (result === null || result === undefined) return null;
  if (status === "waitingConsent" && (kind === "memoryIndex" || kind === "projectBrief")) {
    return Object.freeze({
      availability: "available",
      kind: "waitingConsent",
      delivery: "waitingConsent",
      modelSelection: "deferred_to_ai_workbench",
      billing: "none",
      externalTransfer: false,
      notificationOnly: true,
    });
  }
  const record = plainRecord(result);
  if (record === null) return unavailable("invalid");
  if (kind === "webSourceSync") return webSourceProjection(record);
  if (kind === "memoryQuality") {
    const score = finiteScore(record.score);
    const openIssueCount = finiteCount(record.openIssueCount);
    if (score === null || openIssueCount === null) return unavailable("invalid");
    return withinBound({ availability: "available", kind: "memoryQuality", score, openIssueCount });
  }
  if (kind === "projectPlanHealth") return planHealthProjection(record);
  if (kind === "repositorySync") {
    const repositoryCount = finiteCount(record.repositoryCount);
    return repositoryCount === null
      ? unavailable("unsupported")
      : withinBound({ availability: "available", kind: "repositorySync", successCount: repositoryCount, failedCount: 0 });
  }
  return unavailable("unsupported");
}
