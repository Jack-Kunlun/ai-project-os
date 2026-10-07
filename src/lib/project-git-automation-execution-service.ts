import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import {
  assertPinnedGitEndpoint,
  readGitRepositoryFilesForDelegation,
} from "@/lib/git";
import {
  claimNextProjectGitAutomationRun,
  finalizeProjectGitAutomationRunResult,
  heartbeatProjectGitAutomationRun,
  markProjectGitAutomationRunDispatched,
  type ProjectGitAutomationRunClaim,
} from "@/lib/project-git-automation-run-service";
import {
  loadGitAutomationReadContext,
  openGitAutomationCredential,
} from "@/lib/project-git-automation-read-context";
import {
  gitAutomationDiagnosticErrorCode,
  reportGitAutomationDiagnostic,
  type GitAutomationDiagnosticErrorCode,
  type GitAutomationDiagnosticObserver,
  type GitAutomationDiagnosticStage,
} from "@/lib/project-git-automation-diagnostics";

const HEARTBEAT_INTERVAL_MS = 25_000;
const LEASE_DEADLINE_MARGIN_MS = 2_000;
const MAX_RUN_MS = 4 * 60_000;
const scopeStrings = z.array(z.string().min(1).max(1024)).max(500);

export type GitAutomationExecutionOutcome =
  | "idle"
  | "stopped"
  | "succeeded"
  | "unchanged"
  | "deferred";

function live(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("GIT_AUTOMATION_LEASE_LOST");
}

class RunLease {
  readonly controller = new AbortController();
  private deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private readonly maximumTimer: ReturnType<typeof setTimeout>;
  private renewal: Promise<boolean> | undefined;
  private readonly onStop: () => void;
  private closed = false;

  constructor(
    private readonly claim: ProjectGitAutomationRunClaim,
    private readonly db: PrismaClient,
    stopSignal: AbortSignal,
    private readonly onHeartbeat?: () => Promise<void>,
    private readonly onDiagnostic?: GitAutomationDiagnosticObserver,
  ) {
    this.onStop = () => this.controller.abort();
    stopSignal.addEventListener("abort", this.onStop, { once: true });
    if (stopSignal.aborted) this.controller.abort();
    this.setDeadline(claim.leaseExpiresAt);
    this.maximumTimer = setTimeout(() => this.controller.abort(), MAX_RUN_MS);
  }

  startRenewal(): void {
    if (this.closed || this.signal.aborted || this.heartbeatTimer !== undefined) return;
    this.heartbeatTimer = setInterval(() => {
      void this.heartbeat().catch(() => this.controller.abort());
    }, HEARTBEAT_INTERVAL_MS);
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  private setDeadline(leaseExpiresAt: string): void {
    if (this.closed) return;
    if (this.deadlineTimer !== undefined) clearTimeout(this.deadlineTimer);
    const remaining = Date.parse(leaseExpiresAt) - Date.now() - LEASE_DEADLINE_MARGIN_MS;
    if (!Number.isFinite(remaining) || remaining <= 0) {
      this.controller.abort();
      return;
    }
    this.deadlineTimer = setTimeout(() => this.controller.abort(), remaining);
  }

  private failureDiagnosed = false;

  reportFailure(errorCode: GitAutomationDiagnosticErrorCode): void {
    if (this.failureDiagnosed) return;
    this.failureDiagnosed = true;
    reportGitAutomationDiagnostic(this.onDiagnostic, { stage: "lease", errorCode });
  }

  async heartbeat(): Promise<boolean> {
    if (this.closed) return false;
    try {
      live(this.signal);
    } catch {
      this.reportFailure("LEASE_NOT_ACTIVE");
      return false;
    }
    if (this.renewal !== undefined) return this.renewal;
    const renewal = (async () => {
      try {
        const result = await heartbeatProjectGitAutomationRun(
          this.claim.id, this.claim.workerId, this.claim.leaseToken, this.db,
        );
        if (this.closed || result?.accepted !== true || result.status !== "dispatched" || result.leaseExpiresAt === undefined) {
          this.reportFailure("LEASE_RENEWAL_REJECTED");
          this.controller.abort();
          return false;
        }
        this.setDeadline(result.leaseExpiresAt);
        await this.onHeartbeat?.();
        const active = !this.signal.aborted;
        if (!active) this.reportFailure("LEASE_NOT_ACTIVE");
        return active;
      } catch (error) {
        this.reportFailure(gitAutomationDiagnosticErrorCode(error));
        this.controller.abort();
        return false;
      }
    })();
    this.renewal = renewal;
    try {
      return await renewal;
    } finally {
      if (this.renewal === renewal) this.renewal = undefined;
    }
  }

  async requireHeartbeat(): Promise<boolean> {
    return this.heartbeat();
  }

  stop(stopSignal: AbortSignal): void {
    this.closed = true;
    this.controller.abort();
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
    clearTimeout(this.maximumTimer);
    if (this.deadlineTimer !== undefined) clearTimeout(this.deadlineTimer);
    stopSignal.removeEventListener("abort", this.onStop);
  }
}

/**
 * Executes at most one scheduled run. Once dispatch is committed, every
 * ambiguous failure is left for the database's lease-expiry reconciliation:
 * the worker never fabricates a terminal result or retries network I/O.
 */
export async function runOneGitAutomationCycle(input: Readonly<{
  workerId: string;
  db: PrismaClient;
  stopSignal: AbortSignal;
  onHeartbeat?: () => Promise<void>;
  onDiagnostic?: GitAutomationDiagnosticObserver;
}>): Promise<GitAutomationExecutionOutcome> {
  if (input.stopSignal.aborted) return "stopped";
  let claim: ProjectGitAutomationRunClaim | null;
  try {
    claim = await claimNextProjectGitAutomationRun(input.workerId, input.db);
  } catch (error) {
    reportGitAutomationDiagnostic(input.onDiagnostic, {
      stage: "claim",
      errorCode: gitAutomationDiagnosticErrorCode(error),
    });
    throw error;
  }
  if (claim === null) return "idle";
  const lease = new RunLease(claim, input.db, input.stopSignal, input.onHeartbeat, input.onDiagnostic);
  let stage: GitAutomationDiagnosticStage = "dispatch";
  const deferred = (diagnosticStage: GitAutomationDiagnosticStage, errorCode: GitAutomationDiagnosticErrorCode) => {
    reportGitAutomationDiagnostic(input.onDiagnostic, { stage: diagnosticStage, errorCode });
    return "deferred" as const;
  };
  try {
    live(lease.signal);
    const dispatched = await markProjectGitAutomationRunDispatched(
      claim.id, claim.workerId, claim.leaseToken, input.db,
    );
    if (dispatched?.accepted !== true || dispatched.status !== "dispatched") {
      return deferred("dispatch", "DISPATCH_NOT_ACCEPTED");
    }
    lease.startRenewal();
    live(lease.signal);
    stage = "context";
    const context = await loadGitAutomationReadContext({
      runId: claim.id,
      workerId: claim.workerId,
      leaseToken: claim.leaseToken,
    }, input.db);
    if (context === null) return deferred("context", "READ_CONTEXT_UNAVAILABLE");
    live(lease.signal);
    stage = "scope";
    const includeRoots = scopeStrings.parse(claim.scope.includeRoots);
    const softExcludePatterns = scopeStrings.parse(claim.scope.softExcludePatterns);
    if (!await lease.requireHeartbeat()) {
      lease.reportFailure("LEASE_NOT_ACTIVE");
      return "deferred";
    }
    stage = "endpoint";
    const pinnedResolution = await assertPinnedGitEndpoint({
      baseUrl: context.connection.baseUrl,
      allowPrivateNetwork: context.connection.allowPrivateNetwork,
      expectedFingerprint: context.connection.resolvedAddressFingerprint,
      verifiedAddresses: context.connection.verifiedAddresses,
      signal: lease.signal,
    });
    live(lease.signal);
    if (!await lease.requireHeartbeat()) {
      lease.reportFailure("LEASE_NOT_ACTIVE");
      return "deferred";
    }

    stage = "repository_read";
    const result = await readGitRepositoryFilesForDelegation({
      connection: context.connection,
      repositoryPath: claim.scope.repositoryPath,
      trackedRef: claim.scope.trackedRef,
      includeRoots,
      softExcludePatterns,
      db: input.db,
      pinnedResolution,
      signal: lease.signal,
      unchangedIfCommitSha: context.baseline?.frozenCommitSha,
      onDispatchBoundary: () => lease.requireHeartbeat(),
      onBeforeCredentialRead: () => lease.requireHeartbeat(),
      onBeforeExternalRequest: () => lease.requireHeartbeat(),
      loadCredentialSecret: async () => {
        stage = "credential";
        const secret = await openGitAutomationCredential(context);
        stage = "repository_read";
        return secret;
      },
    });
    if (!await lease.requireHeartbeat()) {
      lease.reportFailure("LEASE_NOT_ACTIVE");
      return "deferred";
    }
    live(lease.signal);
    if (result.addressFingerprint !== context.connection.resolvedAddressFingerprint) {
      return deferred("repository_read", "ADDRESS_FINGERPRINT_MISMATCH");
    }
    stage = "repository_read";
    const files = result.outcome === "changed"
      ? result.files.map((file) => {
        const prefix = `Repository: ${claim.scope.repositoryPath}\nRevision: ${result.commitSha}\nPath: ${file.path}\n\n`;
        if (!file.contentText.startsWith(prefix)) throw new Error("GIT_AUTOMATION_CONTENT_PREFIX_INVALID");
        return Object.freeze({ path: file.path, blobOid: file.blobOid, body: file.contentText.slice(prefix.length) });
      })
      : [];
    live(lease.signal);
    stage = "finalize";
    const finalized = await finalizeProjectGitAutomationRunResult({
      runId: claim.id,
      workerId: claim.workerId,
      leaseToken: claim.leaseToken,
      commitSha: result.commitSha,
      outcome: result.outcome,
      files,
    }, input.db);
    return finalized.accepted
      ? finalized.status === "unchanged" ? "unchanged" : "succeeded"
      : deferred("finalize", "FINALIZE_NOT_ACCEPTED");
  } catch (error) {
    if (lease.signal.aborted) {
      lease.reportFailure("LEASE_NOT_ACTIVE");
    } else {
      reportGitAutomationDiagnostic(input.onDiagnostic, {
        stage,
        errorCode: gitAutomationDiagnosticErrorCode(error),
      });
    }
    return "deferred";
  } finally {
    lease.stop(input.stopSignal);
  }
}
