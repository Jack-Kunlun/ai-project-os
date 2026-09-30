import type { PrismaClient } from "@prisma/client";
import {
  GITHUB_MATERIAL_SCANNER_FINGERPRINT,
  GITHUB_MATERIAL_SCAN_BUDGETS,
  scanGitHubRepositoryMaterials,
} from "@/lib/github/material-scanner";
import { createGitHubCredentialFromToken, createGitHubReadOnlyClient } from "@/lib/github/read-only-client";
import {
  claimNextProjectGitAutomationMaterialRun,
  finalizeProjectGitAutomationMaterialRun,
  heartbeatProjectGitAutomationMaterialRun,
  markProjectGitAutomationMaterialRunDispatched,
  validateMaterialSourcesForClaim,
  type ProjectGitAutomationMaterialRunClaim,
} from "@/lib/project-git-automation-material-run-service";
import {
  loadGitAutomationMaterialReadContext,
  openGitAutomationMaterialCredential,
} from "@/lib/project-git-automation-material-read-context";

const HEARTBEAT_INTERVAL_MS = 25_000;
const LEASE_DEADLINE_MARGIN_MS = 2_000;
const MAX_RUN_MS = GITHUB_MATERIAL_SCAN_BUDGETS.maximumWallTimeMs;

export type GitAutomationMaterialExecutionOutcome = "idle" | "stopped" | "succeeded" | "unchanged" | "deferred";

function live(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("GIT_AUTOMATION_MATERIAL_LEASE_LOST");
}

class MaterialRunLease {
  readonly controller = new AbortController();
  private deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private readonly maximumTimer: ReturnType<typeof setTimeout>;
  private renewal: Promise<boolean> | undefined;
  private readonly onStop: () => void;
  private closed = false;

  constructor(
    private readonly claim: ProjectGitAutomationMaterialRunClaim,
    private readonly db: PrismaClient,
    stopSignal: AbortSignal,
    private readonly onHeartbeat?: () => Promise<void>,
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

  async heartbeat(): Promise<boolean> {
    if (this.closed) return false;
    live(this.signal);
    if (this.renewal !== undefined) return this.renewal;
    const renewal = (async () => {
      try {
        const result = await heartbeatProjectGitAutomationMaterialRun(
          this.claim.id, this.claim.workerId, this.claim.leaseToken, this.db,
        );
        if (this.closed || result?.accepted !== true || result.status !== "dispatched" || result.leaseExpiresAt === undefined) {
          this.controller.abort();
          return false;
        }
        this.setDeadline(result.leaseExpiresAt);
        await this.onHeartbeat?.();
        return !this.signal.aborted;
      } catch {
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

function repositoryParts(path: string): Readonly<{ owner: string; repository: string }> {
  const parts = path.split("/");
  if (parts.length !== 2 || parts.some((part) => part.length === 0)) throw new Error("GIT_AUTOMATION_MATERIAL_SCOPE_INVALID");
  return Object.freeze({ owner: parts[0]!, repository: parts[1]! });
}

function trackedRefForGitHub(value: string): string {
  const result = value.startsWith("refs/heads/") ? value : `refs/heads/${value}`;
  if (result.length > 255 || !result.startsWith("refs/heads/") || /[\u0000-\u001f\u007f-\u009f]/u.test(result)) {
    throw new Error("GIT_AUTOMATION_MATERIAL_REF_INVALID");
  }
  return result;
}

function githubOnlyFetch(lease: MaterialRunLease): typeof fetch {
  return async (input, init) => {
    const url = input instanceof Request ? new URL(input.url) : new URL(input.toString());
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const body = init?.body ?? (input instanceof Request ? input.body : null);
    if (url.origin !== "https://api.github.com" || url.username !== "" || url.password !== ""
      || url.hash !== "" || init?.redirect !== "error" || method !== "GET" || body !== null) {
      throw new Error("GITHUB_MATERIAL_ENDPOINT_REJECTED");
    }
    if (!await lease.requireHeartbeat()) throw new Error("GIT_AUTOMATION_MATERIAL_LEASE_LOST");
    live(lease.signal);
    const signals = init?.signal === undefined || init.signal === null
      ? [lease.signal]
      : [lease.signal, init.signal];
    const response = await fetch(input, { ...init, signal: AbortSignal.any(signals) });
    if (!await lease.requireHeartbeat()) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("GIT_AUTOMATION_MATERIAL_LEASE_LOST");
    }
    return response;
  };
}

/** Execute at most one independently leased issue/PR/release import. */
export async function runOneGitAutomationMaterialCycle(input: Readonly<{
  workerId: string;
  db: PrismaClient;
  stopSignal: AbortSignal;
  onHeartbeat?: () => Promise<void>;
}>): Promise<GitAutomationMaterialExecutionOutcome> {
  if (input.stopSignal.aborted) return "stopped";
  const claim = await claimNextProjectGitAutomationMaterialRun(input.workerId, input.db);
  if (claim === null) return "idle";
  const lease = new MaterialRunLease(claim, input.db, input.stopSignal, input.onHeartbeat);
  try {
    live(lease.signal);
    const dispatched = await markProjectGitAutomationMaterialRunDispatched(
      claim.id, claim.workerId, claim.leaseToken, input.db,
    );
    if (dispatched?.accepted !== true || dispatched.status !== "dispatched") return "deferred";
    lease.startRenewal();
    live(lease.signal);
    const context = await loadGitAutomationMaterialReadContext({
      runId: claim.id,
      workerId: claim.workerId,
      leaseToken: claim.leaseToken,
    }, input.db);
    if (context === null) return "deferred";
    live(lease.signal);
    const token = await openGitAutomationMaterialCredential(context);
    const credential = createGitHubCredentialFromToken(token);
    const client = createGitHubReadOnlyClient({
      credential,
      fetchImplementation: githubOnlyFetch(lease),
      absoluteDeadlineAt: Date.now() + MAX_RUN_MS,
    });
    const { owner, repository } = repositoryParts(context.scope.repositoryPath);
    const trackedRef = trackedRefForGitHub(context.scope.trackedRef);
    if (!await lease.requireHeartbeat()) return "deferred";
    const initialRepository = context.baseline === null
      ? await client.getRepository({ owner, repository })
      : null;
    live(lease.signal);
    const expectedRepositoryId = context.baseline?.repositoryId ?? initialRepository?.repositoryId;
    const expectedNodeId = context.baseline?.nodeId ?? initialRepository?.nodeId;
    if (expectedRepositoryId === undefined || expectedNodeId === undefined) return "deferred";

    const scan = await scanGitHubRepositoryMaterials({
      client,
      owner,
      repository,
      expectedRepositoryId,
      expectedNodeId,
      trackedRef,
      policy: {
        metadataEnabled: false,
        readmeEnabled: false,
        markdownEnabled: false,
        markdownPaths: [],
        issuesEnabled: claim.materialKind === "issue",
        pullRequestsEnabled: claim.materialKind === "pull_request",
        releasesEnabled: claim.materialKind === "release",
        policyFingerprint: GITHUB_MATERIAL_SCANNER_FINGERPRINT,
      },
    });
    live(lease.signal);
    if (scan.quarantines.length > 0 || scan.repository.repositoryId !== expectedRepositoryId
      || scan.repository.nodeId !== expectedNodeId || scan.observedHeadCommitSha.length !== 40) {
      // A quarantined/incomplete class must not look like an empty remote list,
      // which would retire previously imported project sources.
      return "deferred";
    }
    validateMaterialSourcesForClaim(claim, scan.sources);
    if (!await lease.requireHeartbeat()) return "deferred";
    live(lease.signal);
    const finalized = await finalizeProjectGitAutomationMaterialRun({
      runId: claim.id,
      workerId: claim.workerId,
      leaseToken: claim.leaseToken,
      repositoryId: scan.repository.repositoryId,
      repositoryNodeId: scan.repository.nodeId,
      observedHeadCommitSha: scan.observedHeadCommitSha,
      sources: scan.sources,
    }, input.db);
    if (!finalized?.accepted) return "deferred";
    return finalized.status === "unchanged" ? "unchanged" : "succeeded";
  } catch {
    return "deferred";
  } finally {
    lease.stop(input.stopSignal);
  }
}
