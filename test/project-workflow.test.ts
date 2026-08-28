import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { mapApiError } from "../src/lib/api-errors";
import { classifyGitHubJobError, classifyGitHubJobResult } from "../src/lib/background-jobs";
import { GitHubReadError } from "../src/lib/github/read-only-client";
import {
  cancelProjectJob,
  claimProjectJob,
  classifyProviderDispatchFailure,
  finishProjectJob,
  getProjectJob,
  heartbeatProjectJob,
  isLeaseExpired,
  markProviderAcknowledged,
  markProviderDispatched,
  ProjectWorkflowError,
  reconcileProjectJob,
  rejectProjectJobRetry,
  serializeProjectJobResult,
  startProjectJobHeartbeat,
  toPublicProjectJob,
  updateProjectJobProgress,
} from "../src/lib/project-workflow";
import { ProviderTransportError } from "../src/lib/ai-providers";
import { serializeRagAnswer } from "../src/lib/web-rag";

type JobStatus = "queued" | "waitingConsent" | "running" | "succeeded" | "failed" | "unknown" | "cancelled";

type FakeJob = {
  id: string;
  projectId: string;
  kind: "memoryIndex";
  status: JobStatus;
  stage: string;
  result: unknown;
  progressCurrent: number;
  progressTotal: number;
  failureCode: string | null;
  reconciliationRequired: boolean;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
};

type FakeAttempt = {
  id: string;
  jobId: string;
  attemptNumber: number;
  status: "running" | "succeeded" | "failed" | "unknown" | "cancelled";
  leaseTokenHash: string;
  leasedAt: Date;
  leaseExpiresAt: Date;
  heartbeatAt: Date;
  dispatchState: "pending" | "dispatched" | "acknowledged";
  safeFailureCode: string | null;
  completedAt: Date | null;
};

type FakeProviderCallAudit = {
  id: string;
  jobId: string;
  status: string;
  safeErrorCode: string | null;
  completedAt: Date | null;
};

class FakeWorkflowDb {
  readonly jobs = new Map<string, FakeJob>();
  readonly attempts = new Map<string, FakeAttempt>();
  readonly audits = new Map<string, FakeProviderCallAudit>();

  readonly backgroundJob = {
    findUnique: async ({ where }: { where: { id: string } }) => this.jobs.get(where.id) ?? null,
    findFirst: async ({ where }: { where: { id: string; projectId: string } }) => {
      const job = this.jobs.get(where.id);
      return job?.projectId === where.projectId ? this.publicJob(job) : null;
    },
    update: async ({ where, data }: { where: { id: string }; data: Partial<FakeJob> }) => {
      const job = this.requireJob(where.id);
      Object.assign(job, data);
      return job;
    },
    updateMany: async ({ where, data }: { where: { id: string; status?: JobStatus }; data: Partial<FakeJob> }) => {
      const job = this.jobs.get(where.id);
      if (!job || (where.status !== undefined && job.status !== where.status)) return { count: 0 };
      Object.assign(job, data);
      return { count: 1 };
    },
  };

  readonly backgroundJobAttempt = {
    findUnique: async ({ where }: { where: { id: string } }) => this.attempts.get(where.id) ?? null,
    findFirst: async ({ where, orderBy }: { where: { jobId: string }; orderBy?: { attemptNumber: "desc" } }) => {
      void orderBy;
      const entries = [...this.attempts.values()].filter((attempt) => attempt.jobId === where.jobId);
      entries.sort((left, right) => right.attemptNumber - left.attemptNumber);
      return entries[0] ?? null;
    },
    create: async ({ data }: { data: Omit<FakeAttempt, "id" | "status" | "dispatchState" | "safeFailureCode" | "completedAt"> }) => {
      const attempt: FakeAttempt = {
        ...data,
        id: randomUUID(),
        status: "running",
        dispatchState: "pending",
        safeFailureCode: null,
        completedAt: null,
      };
      this.attempts.set(attempt.id, attempt);
      return attempt;
    },
    update: async ({ where, data }: { where: { id: string }; data: Partial<FakeAttempt> }) => {
      const attempt = this.requireAttempt(where.id);
      Object.assign(attempt, data);
      return attempt;
    },
    updateMany: async ({ where, data }: { where: { id: string; jobId?: string; status?: FakeAttempt["status"]; dispatchState?: unknown }; data: Partial<FakeAttempt> }) => {
      const attempt = this.attempts.get(where.id);
      if (!attempt || (where.jobId !== undefined && attempt.jobId !== where.jobId) || (where.status !== undefined && attempt.status !== where.status)) return { count: 0 };
      if (where.dispatchState && typeof where.dispatchState === "object" && "in" in where.dispatchState) {
        const values = (where.dispatchState as { in: FakeAttempt["dispatchState"][] }).in;
        if (!values.includes(attempt.dispatchState)) return { count: 0 };
      } else if (where.dispatchState !== undefined && attempt.dispatchState !== where.dispatchState) {
        return { count: 0 };
      }
      Object.assign(attempt, data);
      return { count: 1 };
    },
  };

  readonly providerCallAudit = {
    updateMany: async ({ where, data }: { where: { jobId: string; status?: string }; data: Partial<FakeProviderCallAudit> }) => {
      let count = 0;
      for (const audit of this.audits.values()) {
        if (audit.jobId !== where.jobId || (where.status !== undefined && audit.status !== where.status)) continue;
        Object.assign(audit, data);
        count += 1;
      }
      return { count };
    },
  };

  async $executeRaw(query: unknown): Promise<number> {
    void query;
    return 0;
  }

  async $transaction<T>(callback: (tx: this) => Promise<T>): Promise<T> {
    return callback(this);
  }

  addJob(status: JobStatus = "queued", projectId = randomUUID()): FakeJob {
    const now = new Date();
    const job: FakeJob = {
      id: randomUUID(),
      projectId,
      kind: "memoryIndex",
      status,
      stage: status,
      result: null,
      progressCurrent: 0,
      progressTotal: 0,
      failureCode: null,
      reconciliationRequired: false,
      createdAt: now,
      startedAt: null,
      completedAt: null,
    };
    this.jobs.set(job.id, job);
    return job;
  }

  addAudit(jobId: string, status = "running"): FakeProviderCallAudit {
    const audit: FakeProviderCallAudit = {
      id: randomUUID(),
      jobId,
      status,
      safeErrorCode: null,
      completedAt: null,
    };
    this.audits.set(audit.id, audit);
    return audit;
  }

  private requireJob(id: string): FakeJob {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`missing job ${id}`);
    return job;
  }

  private requireAttempt(id: string): FakeAttempt {
    const attempt = this.attempts.get(id);
    if (!attempt) throw new Error(`missing attempt ${id}`);
    return attempt;
  }

  private publicJob(job: FakeJob) {
    return {
      ...job,
      attempts: [...this.attempts.values()]
        .filter((attempt) => attempt.jobId === job.id)
        .sort((left, right) => right.attemptNumber - left.attemptNumber)
        .slice(0, 5),
    };
  }
}

const db = () => new FakeWorkflowDb();

test("attempt claim, heartbeat and dispatch state are token-bound", async () => {
  const fake = db();
  const job = fake.addJob();
  const claim = await claimProjectJob(job.id, fake as never);
  assert.notEqual(claim, false);
  const secondClaim = await claimProjectJob(job.id, fake as never);
  assert.equal(secondClaim, false);
  if (claim === false) return;

  const attemptBefore = fake.attempts.get(claim.attemptId)!;
  assert.equal(attemptBefore.leaseTokenHash.length, 64);
  assert.notEqual(attemptBefore.leaseTokenHash, claim.claimToken);
  await heartbeatProjectJob({ jobId: job.id, ...claim }, fake as never);
  await markProviderDispatched({ jobId: job.id, ...claim }, fake as never);
  await markProviderAcknowledged({ jobId: job.id, ...claim }, fake as never);
  await markProviderDispatched({ jobId: job.id, ...claim }, fake as never);
  await markProviderAcknowledged({ jobId: job.id, ...claim }, fake as never);

  await assert.rejects(
    () => updateProjectJobProgress({ jobId: job.id, attemptId: claim.attemptId, claimToken: "forged-token", stage: "work", current: 1, total: 2 }, fake as never),
    (error: unknown) => error instanceof ProjectWorkflowError && error.code === "PROJECT_WORKFLOW_STALE_ATTEMPT",
  );
  await updateProjectJobProgress({ jobId: job.id, ...claim, stage: "work", current: 1, total: 2 }, fake as never);
  await finishProjectJob({ jobId: job.id, ...claim, result: { ok: true } }, fake as never);
  assert.equal(job.status, "succeeded");
  assert.equal(fake.attempts.get(claim.attemptId)?.status, "succeeded");
});

test("expired running lease reconciles to unknown without provider retry", async () => {
  const fake = db();
  const projectId = randomUUID();
  const job = fake.addJob("queued", projectId);
  const claim = await claimProjectJob(job.id, fake as never);
  assert.notEqual(claim, false);
  if (claim === false) return;
  const attempt = fake.attempts.get(claim.attemptId)!;
  attempt.leaseExpiresAt = new Date(Date.now() - 1);
  const audit = fake.addAudit(job.id);
  assert.equal(isLeaseExpired(attempt.leaseExpiresAt), true);
  const reconciled = await reconcileProjectJob(projectId, job.id, fake as never);
  assert.equal(reconciled.status, "unknown");
  assert.equal(reconciled.reconciliationRequired, true);
  assert.equal(fake.attempts.get(claim.attemptId)?.status, "unknown");
  assert.equal(fake.audits.get(audit.id)?.status, "unknown");
  assert.equal(fake.audits.get(audit.id)?.safeErrorCode, "RECONCILIATION_REQUIRED");
  assert.notEqual(fake.audits.get(audit.id)?.completedAt, null);
  const again = await reconcileProjectJob(projectId, job.id, fake as never);
  assert.equal(again.status, "unknown");
  await assert.rejects(
    () => finishProjectJob({ jobId: job.id, ...claim, result: { stale: true } }, fake as never),
    (error: unknown) => error instanceof ProjectWorkflowError && error.code === "PROJECT_WORKFLOW_STALE_ATTEMPT",
  );
});

test("cancel is limited to queued or waiting-consent jobs and details omit lease secrets", async () => {
  const fake = db();
  const projectId = randomUUID();
  const queued = fake.addJob("queued", projectId);
  const cancelled = await cancelProjectJob(projectId, queued.id, fake as never);
  assert.equal(cancelled.status, "cancelled");

  const running = fake.addJob("running", projectId);
  await assert.rejects(
    () => cancelProjectJob(projectId, running.id, fake as never),
    (error: unknown) => error instanceof ProjectWorkflowError && error.code === "PROJECT_WORKFLOW_CANCEL_NOT_ALLOWED",
  );
  const queuedAgain = fake.addJob("queued", projectId);
  const claim = await claimProjectJob(queuedAgain.id, fake as never);
  assert.notEqual(claim, false);
  if (claim === false) return;
  const detail = await getProjectJob(projectId, queuedAgain.id, fake as never);
  const serialized = JSON.stringify(detail);
  assert.doesNotMatch(serialized, /leaseTokenHash|claimToken|[a-f0-9]{64}/u);
  await assert.rejects(() => getProjectJob(randomUUID(), queuedAgain.id, fake as never), /PROJECT_WORKFLOW_JOB_NOT_FOUND/);
});

test("provider uncertainty and workflow API mappings stay stable", () => {
  const timeout = mapApiError(new ProjectWorkflowError("PROJECT_WORKFLOW_RETRY_NOT_SUPPORTED"));
  assert.equal(timeout.status, 409);
  assert.equal(timeout.body.error.code, "PROJECT_WORKFLOW_RETRY_NOT_SUPPORTED");
  const network = new ProviderTransportError("AI_PROVIDER_UNAVAILABLE");
  assert.equal(mapApiError(network).body.error.code, "AI_PROVIDER_UNAVAILABLE");
});

test("provider dispatch classification keeps uncertain calls unknown and rejects retries", () => {
  for (const code of ["AI_PROVIDER_TIMEOUT", "AI_PROVIDER_UNAVAILABLE"] as const) {
    assert.equal(classifyProviderDispatchFailure(new ProviderTransportError(code)), "unknown");
  }
  assert.equal(classifyProviderDispatchFailure(new GitHubReadError("GITHUB_REQUEST_TIMEOUT", null, null, true)), "unknown");
  assert.equal(classifyProviderDispatchFailure(new GitHubReadError("GITHUB_REQUEST_FAILED", null, null, true)), "unknown");
  assert.equal(classifyProviderDispatchFailure(new GitHubReadError("GITHUB_REQUEST_TIMEOUT", null, null, false)), "failed");
  assert.equal(classifyProviderDispatchFailure(new GitHubReadError("GITHUB_REQUEST_FAILED", null, null, false)), "failed");
  for (const code of ["AI_PROVIDER_AUTH_FAILED", "AI_PROVIDER_REJECTED"] as const) {
    assert.equal(classifyProviderDispatchFailure(new ProviderTransportError(code, 422)), "failed");
  }
  for (const code of ["AI_PROVIDER_TIMEOUT", "AI_PROVIDER_UNAVAILABLE"] as const) {
    assert.equal(
      classifyProviderDispatchFailure(new ProviderTransportError(code, 504, false)),
      "failed",
    );
  }
  assert.throws(
    () => rejectProjectJobRetry(),
    (error: unknown) => error instanceof ProjectWorkflowError && error.code === "PROJECT_WORKFLOW_RETRY_NOT_SUPPORTED",
  );
});

test("GitHub nested outcomes preserve success, warning, known failure and unknown boundaries", () => {
  assert.deepEqual(classifyGitHubJobResult({ status: "succeeded" }, "githubScan"), {
    status: "succeeded",
    failureCode: null,
    warning: null,
  });
  assert.deepEqual(classifyGitHubJobResult({ status: "partialOptional" }, "githubScan"), {
    status: "succeeded",
    failureCode: null,
    warning: "OPTIONAL_REPOSITORY_INCOMPLETE",
  });
  assert.equal(classifyGitHubJobResult({ status: "partial" }, "githubScan").status, "failed");
  assert.equal(classifyGitHubJobResult({ status: "failed", failureCode: "GITHUB_ACCESS_UNKNOWN" }, "githubMaterialSync").failureCode, "GITHUB_ACCESS_UNKNOWN");
  assert.equal(classifyGitHubJobResult({ status: "rateLimited" }, "githubMaterialSync").failureCode, "GITHUB_RATE_LIMITED");
  assert.equal(classifyGitHubJobResult({ status: "unknown", failureCode: "GITHUB_REQUEST_UNKNOWN" }, "githubScan").status, "unknown");
  assert.equal(classifyGitHubJobResult({ status: "running" }, "githubScan").status, "unknown");
  assert.deepEqual(classifyGitHubJobError(new GitHubReadError("GITHUB_REQUEST_TIMEOUT")), {
    status: "unknown",
    failureCode: "GITHUB_REQUEST_TIMEOUT",
    warning: null,
  });
  assert.deepEqual(classifyGitHubJobError(new GitHubReadError("GITHUB_REQUEST_FAILED")), {
    status: "unknown",
    failureCode: "GITHUB_REQUEST_FAILED",
    warning: null,
  });
  assert.equal(classifyGitHubJobError({ code: "GITHUB_CODE_SCAN_RECONCILIATION_REQUIRED" }).status, "unknown");
  assert.equal(classifyGitHubJobError({ code: "GITHUB_ACCESS_UNKNOWN" }).status, "failed");

  const source = readFileSync(join(process.cwd(), "src/lib/background-jobs.ts"), "utf8");
  for (const [functionName, kind] of [
    ["runGitHubCodeScanJob", "githubScan"],
    ["runGitHubMaterialSyncJob", "githubMaterialSync"],
  ] as const) {
    const start = source.indexOf(`export async function ${functionName}`);
    const end = source.indexOf("\nexport async function", start + 1);
    const wrapper = source.slice(start, end === -1 ? undefined : end);
    assert.match(wrapper, new RegExp(`const outcome = classifyGitHubJobResult\\(result, "${kind}"\\)`));
    assert.match(wrapper, /if \(outcome\.status !== "unknown"\)[\s\S]*markProviderAcknowledged/u);
    assert.ok(wrapper.indexOf("const outcome = classifyGitHubJobResult") < wrapper.indexOf("markProviderAcknowledged"));
  }
});

test("every model-transfer action resets its consent checkbox in finally", () => {
  const clients = [
    "src/app/projects/[projectId]/memory/project-memory-client.tsx",
    "src/app/projects/[projectId]/intelligence/project-intelligence-client.tsx",
  ];
  for (const path of clients) {
    const source = readFileSync(join(process.cwd(), path), "utf8");
    assert.match(source, /finally[\s\S]{0,260}setAcknowledged\(false\)/u, path);
  }
});

test("request-bound heartbeat is serial and stops before terminal work", async () => {
  const fake = db();
  const job = fake.addJob();
  const claim = await claimProjectJob(job.id, fake as never);
  assert.notEqual(claim, false);
  if (claim === false) return;
  let active = 0;
  let maxActive = 0;
  let calls = 0;
  const heartbeat = startProjectJobHeartbeat({ jobId: job.id, ...claim }, fake as never, {
    intervalMs: 5,
    heartbeat: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 9));
      active -= 1;
      return true;
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 24));
  await heartbeat.stop();
  const callsAtStop = calls;
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(maxActive, 1);
  assert.equal(calls, callsAtStop);
  assert.equal(heartbeat.failure, null);
});

test("recoverable-job migration quarantines pre-attempt running jobs", () => {
  const migration = readFileSync(
    join(process.cwd(), "prisma/migrations/20260829120000_add_recoverable_job_attempts/migration.sql"),
    "utf8",
  );
  const updateIndex = migration.indexOf('UPDATE "BackgroundJob"');
  const auditUpdateIndex = migration.indexOf('UPDATE "ProviderCallAudit" AS audit');
  const attemptTableIndex = migration.indexOf('CREATE TABLE "BackgroundJobAttempt"');
  assert.ok(auditUpdateIndex >= 0 && auditUpdateIndex < updateIndex && updateIndex < attemptTableIndex);
  const auditBackfill = migration.slice(auditUpdateIndex, updateIndex);
  assert.match(auditBackfill, /WHERE audit\."status" = 'running'/u);
  assert.match(auditBackfill, /AND EXISTS \([\s\S]*job\."status" = 'running'/u);
  const backfill = migration.slice(updateIndex, attemptTableIndex);
  assert.match(backfill, /"status" = 'unknown'/u);
  assert.match(backfill, /"stage" = 'reconciliation_required'/u);
  assert.match(backfill, /"failureCode" = 'RECONCILIATION_REQUIRED'/u);
  assert.match(backfill, /"reconciliationRequired" = true/u);
  assert.match(backfill, /"completedAt" = COALESCE\("completedAt", CURRENT_TIMESTAMP\)/u);
  assert.match(backfill, /WHERE "status" = 'running'/u);
  assert.match(migration.slice(auditUpdateIndex, attemptTableIndex), /UPDATE "ProviderCallAudit" AS audit[\s\S]*"safeErrorCode" = 'RECONCILIATION_REQUIRED'/u);
});

test("public job mapper uses a strict whitelist and sanitizes nested results", () => {
  const now = new Date("2026-08-28T00:00:00.000Z");
  const publicJob = toPublicProjectJob({
    id: randomUUID(),
    projectId: randomUUID(),
    kind: "semanticSearch",
    status: "succeeded",
    stage: "complete",
    result: {
      question: "what changed?",
      indexGenerationId: randomUUID(),
      results: [{
        id: randomUUID(),
        scope: "projectSource",
        projectSourceId: randomUUID(),
        projectRepositoryLinkId: null,
        frozenCommitSha: null,
        path: null,
        externalRef: "manual:notes",
        rangeStart: 1,
        rangeEnd: 2,
        contentText: "A safe excerpt",
        contentHash: "a".repeat(64),
        semanticScore: 0.8,
        lexicalScore: 0.2,
        score: 0.7,
        secret: "do-not-return",
      }],
      secret: "do-not-return",
    },
    progressCurrent: 1,
    progressTotal: 1,
    failureCode: null,
    reconciliationRequired: false,
    createdAt: now,
    startedAt: now,
    completedAt: now,
    attempts: [{
      id: randomUUID(),
      attemptNumber: 1,
      status: "succeeded",
      leaseTokenHash: "b".repeat(64),
      leasedAt: now,
      leaseExpiresAt: now,
      heartbeatAt: now,
      dispatchState: "acknowledged",
      safeFailureCode: null,
      completedAt: now,
    }],
    payload: { secret: "do-not-return" },
    idempotencyKey: "do-not-return",
    webAiGrantId: randomUUID(),
  } as never);
  assert.deepEqual(Object.keys(publicJob).sort(), [
    "attempts", "completedAt", "createdAt", "failureCode", "id", "kind",
    "progressCurrent", "progressTotal", "projectId", "reconciliationRequired", "result", "stage", "startedAt", "status",
  ]);
  assert.equal("payload" in publicJob, false);
  assert.equal("idempotencyKey" in publicJob, false);
  assert.equal("webAiGrantId" in publicJob, false);
  assert.equal("leaseTokenHash" in publicJob, false);
  assert.equal("secret" in (publicJob.result as Record<string, unknown>), false);
  assert.equal("secret" in (publicJob.result as { results: Array<Record<string, unknown>> }).results[0]!, false);
  assert.equal("leaseTokenHash" in publicJob.attempts[0]!, false);
});

test("job result serializers keep search and answer payloads explicit", () => {
  const search = serializeProjectJobResult("semanticSearch", {
    question: "safe question",
    indexGenerationId: randomUUID(),
    results: [{
      id: randomUUID(),
      scope: "projectSource",
      contentText: "safe excerpt",
      contentHash: "a".repeat(64),
      semanticScore: 0.8,
      lexicalScore: 0.2,
      score: 0.7,
      payload: "secret",
    }],
    payload: "secret",
  }) as { results: Array<Record<string, unknown>> };
  assert.equal(search.results.length, 1);
  assert.equal("payload" in search, false);
  assert.equal("payload" in search.results[0]!, false);
  const answer = serializeProjectJobResult("ragAnswer", {
    answerId: randomUUID(),
    answer: "answer text should be loaded from the explicit answer endpoint",
    citations: [{ secret: "do-not-return" }],
  }) as Record<string, unknown>;
  assert.equal(Object.keys(answer).length, 1);
  assert.equal(typeof answer.answerId, "string");

  const validPersistedAnswerInput = {
    id: randomUUID(),
    question: "safe question",
    answer: "safe answer",
    modelId: "qwen-plus-latest",
    inputTokens: 12,
    outputTokens: 8,
    createdAt: new Date("2026-08-28T00:00:00.000Z"),
    providerConnection: { name: "safe provider", kind: "qwen", secret: "do-not-return" },
    citations: [{
      id: randomUUID(),
      scope: "projectSource",
      path: null,
      externalRef: "manual:notes",
      frozenCommitSha: null,
      rangeStart: 1,
      rangeEnd: 2,
      contentHash: "b".repeat(64),
      excerpt: "safe excerpt",
      secret: "do-not-return",
    }],
    secret: "do-not-return",
  };
  const persistedAnswer = serializeRagAnswer(validPersistedAnswerInput);
  assert.notEqual(persistedAnswer, null);
  assert.equal(persistedAnswer?.citations.length, 1);
  assert.equal("secret" in (persistedAnswer ?? {}), false);
  assert.equal("secret" in (persistedAnswer?.providerConnection ?? {}), false);
  assert.equal("secret" in (persistedAnswer?.citations[0] ?? {}), false);
  assert.equal(serializeRagAnswer({ ...validPersistedAnswerInput, citations: [] }), null);
  assert.equal(serializeRagAnswer({ ...validPersistedAnswerInput, citations: "not-an-array" }), null);
  assert.equal(serializeRagAnswer({
    ...validPersistedAnswerInput,
    citations: [
      ...validPersistedAnswerInput.citations,
      { ...validPersistedAnswerInput.citations[0], contentHash: "not-a-sha256" },
    ],
  }), null);

  const published = serializeProjectJobResult("memoryIndex", {
    indexGenerationId: randomUUID(),
    mode: "incremental",
    recordCount: 2,
    reconciliation: "publishedLocally",
    credentialId: "do-not-return",
  }) as Record<string, unknown>;
  assert.equal(published.reconciliation, "publishedLocally");
  assert.equal("credentialId" in published, false);
  const abandoned = serializeProjectJobResult("memoryIndex", {
    reconciliation: "explicitAbandon",
    payload: "do-not-return",
  }) as Record<string, unknown>;
  assert.deepEqual(abandoned, { reconciliation: "explicitAbandon" });
});

test("job action routes consistently use the public mapper", () => {
  const routes = [
    "src/app/api/projects/[projectId]/repositories/scan/route.ts",
    "src/app/api/projects/[projectId]/repositories/materials/route.ts",
    "src/app/api/projects/[projectId]/memory/index/route.ts",
    "src/app/api/projects/[projectId]/memory/extract/route.ts",
    "src/app/api/projects/[projectId]/memory/search/route.ts",
    "src/app/api/projects/[projectId]/memory/answers/route.ts",
    "src/app/api/projects/[projectId]/intelligence/brief/route.ts",
    "src/app/api/projects/[projectId]/intelligence/agent/route.ts",
    "src/app/api/projects/[projectId]/jobs/[jobId]/route.ts",
  ];
  for (const path of routes) {
    const source = readFileSync(join(process.cwd(), path), "utf8");
    assert.match(source, /toPublicProjectJob/u, path);
  }
});

test("job detail route exposes only explicit reconcile/cancel actions", () => {
  const source = readFileSync(join(process.cwd(), "src/app/api/projects/[projectId]/jobs/[jobId]/route.ts"), "utf8");
  assert.match(source, /export async function GET/u);
  assert.match(source, /export async function POST/u);
  assert.match(source, /z\.enum\(\["reconcile", "cancel", "retry"\]\)/u);
  assert.match(source, /rejectProjectJobRetry/u);
  assert.doesNotMatch(source, /export async function PUT/u);
  assert.doesNotMatch(source, /export async function DELETE/u);
});
