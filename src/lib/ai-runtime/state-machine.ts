import {
  AI_RUN_ATTEMPT_STATUSES,
  AI_RUN_STATUSES,
  type AiRunAttemptStatus,
  type AiRunStatus,
} from "./types";

export type AiStateTransitionFailure = {
  ok: false;
  code: "AI_INVALID_STATE_TRANSITION";
};

export type AiRunStateTransition =
  | { ok: true; status: AiRunStatus }
  | AiStateTransitionFailure;

export type AiRunAttemptStateTransition =
  | { ok: true; status: AiRunAttemptStatus }
  | AiStateTransitionFailure;

const RUN_TRANSITIONS: Readonly<Record<AiRunStatus, readonly AiRunStatus[]>> = {
  queued: ["running"],
  running: ["succeeded", "failed", "unknown", "cancelled"],
  succeeded: [],
  failed: ["queued"],
  unknown: [],
  cancelled: [],
};

// The pure service contract permits an explicitly authorized failed retry;
// the current database guard is stricter and keeps failed -> queued
// service-only until a retry token can be proven transactionally.

const ATTEMPT_TRANSITIONS: Readonly<Record<AiRunAttemptStatus, readonly AiRunAttemptStatus[]>> = {
  sent: ["succeeded", "failed", "unknown", "cancelled"],
  succeeded: [],
  failed: [],
  unknown: [],
  cancelled: [],
};

function isRunStatus(value: unknown): value is AiRunStatus {
  return typeof value === "string" && (AI_RUN_STATUSES as readonly string[]).includes(value);
}

function isAttemptStatus(value: unknown): value is AiRunAttemptStatus {
  return (
    typeof value === "string" &&
    (AI_RUN_ATTEMPT_STATUSES as readonly string[]).includes(value)
  );
}

function invalidTransition(): AiStateTransitionFailure {
  return { ok: false, code: "AI_INVALID_STATE_TRANSITION" };
}

export function transitionAiRunStatus(
  current: unknown,
  next: unknown,
  options: { explicitRetry?: boolean } = {},
): AiRunStateTransition {
  if (!isRunStatus(current) || !isRunStatus(next)) {
    return invalidTransition();
  }
  if (current === "failed" && next === "queued" && options.explicitRetry === true) {
    return { ok: true, status: next };
  }
  if (current === "failed" && next === "queued") {
    return invalidTransition();
  }
  if (!(RUN_TRANSITIONS[current] as readonly AiRunStatus[]).includes(next)) {
    return invalidTransition();
  }
  return { ok: true, status: next };
}

export function transitionAiRunAttemptStatus(
  current: unknown,
  next: unknown,
): AiRunAttemptStateTransition {
  if (!isAttemptStatus(current) || !isAttemptStatus(next)) {
    return invalidTransition();
  }
  if (!(ATTEMPT_TRANSITIONS[current] as readonly AiRunAttemptStatus[]).includes(next)) {
    return invalidTransition();
  }
  return { ok: true, status: next };
}

export function canRedispatchRun(status: unknown, explicitRetry = false): boolean {
  return status === "failed" && explicitRetry === true;
}
