import "dotenv/config";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  PrismaClient,
  ProjectRepositoryRole,
} from "@prisma/client";
import { Client } from "pg";
import {
  GITHUB_SOFT_EXCLUDE_CLASSES,
  createGitHubRepositoryLedgerService,
  cancelGitHubProjectSync,
  prepareGitHubProjectSync,
  reconcileGitHubProjectSync,
  runGitHubProjectSyncJob,
  GITHUB_READ_ONLY_CLIENT_VERSION,
  type RepositoryLinkStatus,
  type VerifiedGitHubRepository,
} from "../src/lib/github";
import { GitHubReadError } from "../src/lib/github/read-only-client";
import type { WebGitHubCredentialClient } from "../src/lib/web-github";
import {
  hasBlockingUnknownProjectCodeBatch,
  hasBlockingUnknownProjectMaterialRun,
  hasBlockingUnknownProjectSyncRun,
} from "../src/lib/github/project-sync-lock";

const execFile = promisify(execFileCallback);
const repositoryRoot = process.cwd();
const databaseName = "ai_project_os_project_sync_test";
const databasePort = "56432";
const configuredUrl = process.env.GITHUB_PROJECT_SYNC_TEST_DATABASE_URL;
const gate = process.env.GITHUB_PROJECT_SYNC_POSTGRES_GATE;
const hasUrl = typeof configuredUrl === "string" && configuredUrl.length > 0;
const shouldRun = hasUrl && gate === "1";
const hash = "a".repeat(64);
const commitSha = "b".repeat(40);

function unknownClient(): WebGitHubCredentialClient {
  const uncertain = () => Promise.reject(new GitHubReadError("GITHUB_REQUEST_TIMEOUT", null, null, true));
  return {
    version: GITHUB_READ_ONLY_CLIENT_VERSION,
    getRepository: uncertain,
    getReference: uncertain,
    getCommit: uncertain,
    getTree: uncertain,
    getBlob: uncertain,
    getIssuesPage: uncertain,
    getPullRequestsPage: uncertain,
    getPullRequest: uncertain,
    getPullRequestFilesPage: uncertain,
    getReleasesPage: uncertain,
  } as unknown as WebGitHubCredentialClient;
}

function preDispatchTimeoutClient(): WebGitHubCredentialClient {
  // This client models a deterministic budget check in the read-only client:
  // no fetch is attempted, and the explicit false marker must remain known.
  const beforeFetch = () => Promise.reject(new GitHubReadError("GITHUB_REQUEST_TIMEOUT", null, null, false));
  return {
    version: GITHUB_READ_ONLY_CLIENT_VERSION,
    getRepository: beforeFetch,
    getReference: beforeFetch,
    getCommit: beforeFetch,
    getTree: beforeFetch,
    getBlob: beforeFetch,
    getIssuesPage: beforeFetch,
    getPullRequestsPage: beforeFetch,
    getPullRequest: beforeFetch,
    getPullRequestFilesPage: beforeFetch,
    getReleasesPage: beforeFetch,
  } as unknown as WebGitHubCredentialClient;
}

const repositoryA: VerifiedGitHubRepository = Object.freeze({
  repositoryId: 3_000_001,
  nodeId: "R_SYNC_A",
  owner: "acme",
  name: "alpha",
  fullName: "acme/alpha",
  private: true,
  archived: false,
  disabled: false,
  defaultBranch: "main",
});
const repositoryB: VerifiedGitHubRepository = Object.freeze({
  repositoryId: 3_000_002,
  nodeId: "R_SYNC_B",
  owner: "acme",
  name: "beta",
  fullName: "acme/beta",
  private: true,
  archived: false,
  disabled: false,
  defaultBranch: "main",
});
const repositoryC: VerifiedGitHubRepository = Object.freeze({
  repositoryId: 3_000_003,
  nodeId: "R_SYNC_C",
  owner: "acme",
  name: "cascade",
  fullName: "acme/cascade",
  private: true,
  archived: false,
  disabled: false,
  defaultBranch: "main",
});

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function validateDisposableUrl(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("GITHUB_PROJECT_SYNC_TEST_DATABASE_URL_INVALID");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("GITHUB_PROJECT_SYNC_TEST_DATABASE_URL_INVALID");
  }
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname.toLowerCase()) ||
    parsed.port !== databasePort ||
    parsed.pathname !== `/${databaseName}` ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error("GITHUB_PROJECT_SYNC_TEST_DATABASE_URL_INVALID");
  }
  return value;
}

function repositoryConfig(required: boolean, codeEnabled = true, materialsEnabled = true) {
  return {
    role: required ? ProjectRepositoryRole.application : ProjectRepositoryRole.infrastructure,
    requiredForProjectSnapshot: required,
    trackedRef: "refs/heads/main",
    codeEnabled,
    metadataEnabled: materialsEnabled,
    readmeEnabled: materialsEnabled,
    markdownEnabled: false,
    markdownPaths: [],
    issuesEnabled: false,
    pullRequestsEnabled: false,
    releasesEnabled: false,
    includeRoots: ["src"],
    softExcludePatterns: [...GITHUB_SOFT_EXCLUDE_CLASSES],
  } as const;
}

async function createCredential(db: PrismaClient, id: string): Promise<void> {
  await db.externalCredential.create({
    data: {
      id,
      kind: "github",
      ciphertext: Buffer.from([1]),
      nonce: Buffer.from([2]),
      authTag: Buffer.from([3]),
      maskedSuffix: "sync-test",
      secretFingerprint: hash,
    },
  });
}

async function createLink(
  db: PrismaClient,
  projectId: string,
  credentialId: string,
  repository: VerifiedGitHubRepository,
  required = true,
  codeEnabled = true,
  materialsEnabled = true,
): Promise<RepositoryLinkStatus> {
  const ledger = createGitHubRepositoryLedgerService({ db, credentialId });
  return ledger.connect({ projectId, repository, config: repositoryConfig(required, codeEnabled, materialsEnabled) });
}

async function createJob(
  db: PrismaClient,
  projectId: string,
  requestedById: string,
  label: string,
  status: "queued" | "running" | "unknown" = "queued",
) {
  const startedAt = new Date(Date.now() - 5_000);
  return db.backgroundJob.create({
    data: {
      id: randomUUID(),
      projectId,
      kind: "githubProjectSync",
      status,
      stage: status === "running" ? "code" : status === "unknown" ? "reconciliation_required" : "queued",
      payload: {},
      idempotencyKey: digest(`job:${label}`),
      requestedById,
      ...(status === "running" ? { startedAt } : {}),
      ...(status === "unknown"
        ? {
            failureCode: "RECONCILIATION_REQUIRED",
            reconciliationRequired: false,
            completedAt: new Date(),
          }
        : {}),
    },
  });
}

async function createRoot(
  db: PrismaClient,
  input: Readonly<{
    projectId: string;
    parentJobId: string;
    label: string;
    codeTargetCount?: number;
    materialTargetCount?: number;
    status?: "queued" | "running";
  }>,
) {
  const status = input.status ?? "queued";
  return db.projectGitHubSyncRun.create({
    data: {
      id: randomUUID(),
      projectId: input.projectId,
      parentJobId: input.parentJobId,
      status,
      stage: status === "running" ? "code" : "queued",
      scopeFingerprint: digest(`scope:${input.label}`),
      deadlineAt: new Date(Date.now() + 240_000),
      codeTargetCount: input.codeTargetCount ?? 0,
      materialTargetCount: input.materialTargetCount ?? 0,
      ...(status === "running" ? { startedAt: new Date(Date.now() - 5_000) } : {}),
    },
  });
}

async function createCodeBatch(
  db: PrismaClient,
  projectId: string,
  label: string,
  outcome: "succeeded" | "unknown",
) {
  const startedAt = new Date(Date.now() - 4_000);
  const batch = await db.projectScanBatch.create({
    data: {
      id: randomUUID(),
      projectId,
      status: "queued",
      requiredManifestFingerprint: digest(`batch:${label}`),
      expectedRequiredLinkCount: 1,
      expectedOptionalLinkCount: 0,
      startedAt,
    },
  });
  return db.projectScanBatch.update({
    where: { id: batch.id },
    data:
      outcome === "succeeded"
        ? {
            status: "succeeded",
            completedRequiredLinkCount: 1,
            completedAt: new Date(),
          }
        : { status: "unknown" },
  });
}

async function createMaterialRun(
  db: PrismaClient,
  projectId: string,
  link: RepositoryLinkStatus,
  label: string,
  outcome: "succeeded" | "unknown",
) {
  const startedAt = new Date(Date.now() - 4_000);
  const run = await db.gitHubMaterialSyncRun.create({
    data: {
      id: randomUUID(),
      projectId,
      projectRepositoryLinkId: link.id,
      linkConfigVersion: link.config.version,
      expectedEffectivePolicyVersion: link.effectivePolicyVersion,
      operationKey: digest(`material:${label}`),
    },
  });
  if (outcome === "unknown") {
    await db.gitHubMaterialSyncRun.update({
      where: { id: run.id },
      data: { status: "running", stage: "freezing", startedAt },
    });
    return db.gitHubMaterialSyncRun.update({
      where: { id: run.id },
      data: {
        status: "unknown",
        stage: "terminal",
        failureCode: "RECONCILIATION_REQUIRED",
        completedAt: new Date(),
      },
    });
  }

  const generation = await db.repositoryMaterialGeneration.create({
    data: {
      id: randomUUID(),
      projectId,
      projectRepositoryLinkId: link.id,
      linkConfigVersion: link.config.version,
      githubMaterialSyncRunId: run.id,
      status: "staging",
      generationKey: digest(`generation:${label}`),
      capturedGitHubRepositoryId: BigInt(link.repository.repositoryId),
      capturedFullName: link.repository.currentFullName,
      observedHeadCommitSha: commitSha,
      effectivePolicyVersion: link.effectivePolicyVersion,
      manifestFingerprint: digest(""),
      enabledClassManifest: {},
      coverageManifest: {},
      scannerVersion: "project-sync-pg-test",
      scannerFingerprint: hash,
      sourceCount: 0,
      decodedTextBytes: 0,
    },
  });
  await db.repositoryMaterialGeneration.update({
    where: { id: generation.id },
    data: { status: "complete", completedAt: new Date() },
  });
  await db.gitHubMaterialSyncRun.update({
    where: { id: run.id },
    data: { status: "running", stage: "freezing", startedAt },
  });
  return db.gitHubMaterialSyncRun.update({
    where: { id: run.id },
    data: {
      status: "succeeded",
      stage: "terminal",
      observedHeadCommitSha: commitSha,
      completedAt: new Date(),
    },
  });
}

async function linkRecord(db: PrismaClient, projectId: string, linkId: string) {
  return db.projectRepositoryLink.findUniqueOrThrow({
    where: { projectId_id: { projectId, id: linkId } },
    include: { githubConnection: true },
  });
}

async function createEntry(
  db: PrismaClient,
  input: Readonly<{
    projectId: string;
    syncRunId: string;
    link: RepositoryLinkStatus;
    ordinal: number;
    targetKind: "code" | "material";
    status: "pending" | "running" | "succeeded" | "failed" | "unknown" | "skipped";
    childCodeBatchId?: string | null;
    childMaterialSyncRunId?: string | null;
  }>,
) {
  const record = await linkRecord(db, input.projectId, input.link.id);
  const [owner, name] = input.link.repository.currentFullName.split("/", 2);
  const startedAt = input.status === "pending" ? null : new Date(Date.now() - 2_000);
  const completedAt = ["succeeded", "failed", "unknown", "skipped"].includes(input.status)
    ? new Date()
    : null;
  return db.projectGitHubSyncEntry.create({
    data: {
      id: randomUUID(),
      projectId: input.projectId,
      syncRunId: input.syncRunId,
      projectRepositoryLinkId: input.link.id,
      githubConnectionId: record.githubConnectionId,
      credentialId: record.githubConnection.credentialId!,
      credentialSecretFingerprint: hash,
      ordinal: input.ordinal,
      targetKind: input.targetKind,
      targetKey: `${input.targetKind}:${input.link.id}`,
      status: input.status,
      githubRepositoryId: BigInt(input.link.repository.repositoryId),
      repositoryNodeId: input.link.repository.nodeId,
      repositoryOwner: owner ?? "acme",
      repositoryName: name ?? "repository",
      repositoryFullName: input.link.repository.currentFullName,
      configVersion: input.link.config.version,
      effectivePolicyVersion: input.link.effectivePolicyVersion,
      requiredForProjectSnapshot: input.link.config.requiredForProjectSnapshot,
      trackedRef: input.link.config.trackedRef,
      scanScopeFingerprint: input.link.config.scanScopeFingerprint,
      policyFingerprint: input.link.config.policyFingerprint,
      configSnapshot: {
        trackedRef: input.link.config.trackedRef,
        includeRoots: [...input.link.config.includeRoots],
        requiredForProjectSnapshot: input.link.config.requiredForProjectSnapshot,
      },
      beforeCodeGenerationId: null,
      beforeMaterialGenerationId: null,
      childCodeBatchId: input.targetKind === "code" ? input.childCodeBatchId ?? null : null,
      childMaterialSyncRunId: input.targetKind === "material" ? input.childMaterialSyncRunId ?? null : null,
      ...(startedAt === null ? {} : { startedAt }),
      ...(completedAt === null ? {} : { completedAt }),
      ...(input.status === "failed" ? { failureCode: "TEST_FAILED" } : {}),
    },
  });
}

async function createChange(
  db: PrismaClient,
  input: Readonly<{
    projectId: string;
    syncRunId: string;
    entryId: string;
    targetKey: string;
    identity: string;
  }>,
) {
  return db.projectGitHubSyncChange.create({
    data: {
      id: randomUUID(),
      projectId: input.projectId,
      syncRunId: input.syncRunId,
      entryId: input.entryId,
      targetKind: "code",
      targetKey: input.targetKey,
      identity: input.identity,
      changeType: "added",
      normalizedPath: input.identity,
      materialKind: null,
      remoteIdentity: null,
      beforeContentHash: null,
      afterContentHash: hash,
      beforeRevisionFingerprint: null,
      afterRevisionFingerprint: hash,
    },
  });
}

test(
  "project GitHub sync PostgreSQL gate requires an explicit disposable target",
  { skip: !hasUrl || gate === "1" },
  () => {
    throw new Error("GITHUB_PROJECT_SYNC_POSTGRES_GATE must equal 1");
  },
);

test(
  "project-wide sync persists safe terminal state, enforces isolation and reconciles without external calls",
  { skip: !shouldRun ? "explicit disposable PostgreSQL gate is required" : false },
  async () => {
    const url = validateDisposableUrl(configuredUrl);
    const raw = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
    const previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = url;
    await raw.connect();
    await raw.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await execFile(
      "pnpm",
      ["exec", "prisma", "migrate", "deploy", "--config", "prisma.config.ts"],
      { cwd: repositoryRoot, env: { ...process.env, DATABASE_URL: url } },
    );
    const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
    const userId = randomUUID();
    const projectAId = randomUUID();
    const projectBId = randomUUID();
    const projectCId = randomUUID();
    const runnerMaterialProjectId = randomUUID();
    const runnerCodeProjectId = randomUUID();
    const rotationProjectId = randomUUID();
    const credentialId = randomUUID();
    const rotatingCredentialId = randomUUID();

    try {
      await db.appUser.create({
        data: {
          id: userId,
          username: `project_sync_${randomUUID().slice(0, 8)}`,
          passwordHash: "a".repeat(43),
          passwordSalt: "b".repeat(22),
          role: "admin",
        },
      });
      await db.project.createMany({
        data: [
          { id: projectAId, name: "Sync A", slug: `sync-a-${randomUUID()}` },
          { id: projectBId, name: "Sync B", slug: `sync-b-${randomUUID()}` },
          { id: projectCId, name: "Sync C", slug: `sync-c-${randomUUID()}` },
          { id: runnerMaterialProjectId, name: "Runner material", slug: `sync-material-${randomUUID()}` },
          { id: runnerCodeProjectId, name: "Runner code", slug: `sync-code-${randomUUID()}` },
          { id: rotationProjectId, name: "Credential rotation", slug: `sync-rotation-${randomUUID()}` },
        ],
      });
      await createCredential(db, credentialId);
      await createCredential(db, rotatingCredentialId);
      const linkA = await createLink(db, projectAId, credentialId, repositoryA, true);
      const linkA2 = await createLink(db, projectAId, credentialId, repositoryB, false);
      const linkB = await createLink(db, projectBId, credentialId, repositoryC, true);
      await createLink(db, runnerMaterialProjectId, credentialId, repositoryA, true, false, true);
      await createLink(db, runnerCodeProjectId, credentialId, repositoryB, true, true, false);
      await createLink(db, rotationProjectId, rotatingCredentialId, repositoryC, true, false, true);

      // Execute the real root runner with a frozen material target. The
      // client reports a deterministic pre-dispatch timeout on its first read;
      // the child must be cancelled (known incomplete), not failed/unknown.
      const materialRunnerClientKey = `runner-material-${randomUUID()}`;
      const preparedMaterialRunner = await prepareGitHubProjectSync({
        projectId: runnerMaterialProjectId,
        requestedById: userId,
        clientKey: materialRunnerClientKey,
      }, db);
      await db.projectGitHubSyncRun.update({
        where: { id: preparedMaterialRunner.syncRun.id },
        data: { deadlineAt: new Date(Date.now() + 60_000) },
      });
      let materialLoaderCalls = 0;
      const materialFetchCalls = 0;
      const materialRunnerResult = await runGitHubProjectSyncJob({
        projectId: runnerMaterialProjectId,
        requestedBy: { id: userId },
        clientKey: materialRunnerClientKey,
      }, db, {
        loadClientForCredential: async () => {
          materialLoaderCalls += 1;
          return preDispatchTimeoutClient();
        },
      });
      assert.equal(materialLoaderCalls, 1);
      assert.equal(materialFetchCalls, 0);
      assert.equal(materialRunnerResult.status, "failed");
      const materialRunnerRoot = await db.projectGitHubSyncRun.findUniqueOrThrow({ where: { id: preparedMaterialRunner.syncRun.id } });
      assert.equal(materialRunnerRoot.status, "failed");
      assert.equal(materialRunnerRoot.reconciliationRequired, false);
      const materialRunnerEntry = await db.projectGitHubSyncEntry.findFirstOrThrow({ where: { syncRunId: materialRunnerRoot.id } });
      assert.equal(materialRunnerEntry.status, "skipped");
      assert.ok(materialRunnerEntry.childMaterialSyncRunId);
      const materialRunnerChild = await db.gitHubMaterialSyncRun.findUniqueOrThrow({ where: { id: materialRunnerEntry.childMaterialSyncRunId! } });
      assert.equal(materialRunnerChild.status, "cancelled");
      assert.equal(materialRunnerChild.stage, "terminal");
      assert.ok(materialRunnerChild.completedAt);
      const materialRunnerAttempt = await db.backgroundJobAttempt.findFirstOrThrow({ where: { jobId: preparedMaterialRunner.job.id } });
      assert.notEqual(materialRunnerAttempt.dispatchState, "dispatched");
      assert.equal(materialRunnerAttempt.dispatchState, "acknowledged");
      assert.equal(await db.projectGitHubSyncReconciliation.count({ where: { syncRunId: materialRunnerRoot.id } }), 0);
      assert.equal(await db.projectGitHubSyncRun.count({ where: { projectId: runnerMaterialProjectId, status: { in: ["queued", "running"] } } }), 0);

      // A credential can rotate in place after scope freeze. The default
      // loader must reject the frozen fingerprint before decrypting or
      // dispatching any GitHub request, leaving a known failure with no child.
      const rotationClientKey = `credential-rotation-${randomUUID()}`;
      const preparedRotation = await prepareGitHubProjectSync({
        projectId: rotationProjectId,
        requestedById: userId,
        clientKey: rotationClientKey,
      }, db);
      const frozenRotationEntry = await db.projectGitHubSyncEntry.findFirstOrThrow({ where: { syncRunId: preparedRotation.syncRun.id } });
      assert.equal(frozenRotationEntry.credentialSecretFingerprint, hash);
      await db.externalCredential.update({
        where: { id: rotatingCredentialId },
        data: { secretFingerprint: "c".repeat(64) },
      });
      const rotationResult = await runGitHubProjectSyncJob({
        projectId: rotationProjectId,
        requestedBy: { id: userId },
        clientKey: rotationClientKey,
      }, db);
      assert.equal(rotationResult.status, "failed");
      assert.equal(rotationResult.reconciliationRequired, false);
      const rotationRoot = await db.projectGitHubSyncRun.findUniqueOrThrow({ where: { id: preparedRotation.syncRun.id } });
      assert.equal(rotationRoot.status, "failed");
      assert.equal(rotationRoot.reconciliationRequired, false);
      assert.equal(await db.gitHubMaterialSyncRun.count({ where: { projectId: rotationProjectId } }), 0);
      assert.equal(await db.projectScanBatch.count({ where: { projectId: rotationProjectId } }), 0);
      assert.equal(await db.projectGitHubSyncReconciliation.count({ where: { syncRunId: rotationRoot.id } }), 0);
      const rotationAttempt = await db.backgroundJobAttempt.findFirstOrThrow({ where: { jobId: preparedRotation.job.id } });
      assert.equal(rotationAttempt.dispatchState, "pending");
      assert.equal(await db.projectGitHubSyncRun.count({ where: { projectId: rotationProjectId, status: { in: ["queued", "running"] } } }), 0);

      // The real runner keeps a dispatched code request unknown and retains
      // the attempt dispatch marker. Explicit reconciliation then releases
      // admission without invoking GitHub or an AI provider.
      const codeRunnerClientKey = `runner-code-${randomUUID()}`;
      const preparedCodeRunner = await prepareGitHubProjectSync({
        projectId: runnerCodeProjectId,
        requestedById: userId,
        clientKey: codeRunnerClientKey,
      }, db);
      const codeRunnerResult = await runGitHubProjectSyncJob({
        projectId: runnerCodeProjectId,
        requestedBy: { id: userId },
        clientKey: codeRunnerClientKey,
      }, db, {
        loadClientForCredential: async () => unknownClient(),
      });
      assert.equal(codeRunnerResult.status, "unknown");
      const codeRunnerRoot = await db.projectGitHubSyncRun.findUniqueOrThrow({ where: { id: preparedCodeRunner.syncRun.id } });
      assert.equal(codeRunnerRoot.status, "unknown");
      assert.equal(codeRunnerRoot.manifestFingerprint, null);
      const codeRunnerEntry = await db.projectGitHubSyncEntry.findFirstOrThrow({ where: { syncRunId: codeRunnerRoot.id } });
      assert.equal(codeRunnerEntry.status, "unknown");
      const codeRunnerBatch = await db.projectScanBatch.findUniqueOrThrow({ where: { id: codeRunnerEntry.childCodeBatchId! } });
      assert.equal(codeRunnerBatch.status, "unknown");
      assert.equal(codeRunnerBatch.completedAt, null);
      const codeRunnerChild = await db.repoCodeScanRun.findFirstOrThrow({ where: { projectScanBatchId: codeRunnerBatch.id } });
      assert.equal(codeRunnerChild.status, "unknown");
      assert.equal(codeRunnerChild.completedAt, null);
      assert.equal(codeRunnerChild.stage, "terminal");
      const codeRunnerAttempt = await db.backgroundJobAttempt.findFirstOrThrow({ where: { jobId: preparedCodeRunner.job.id } });
      assert.equal(codeRunnerAttempt.status, "unknown");
      assert.equal(codeRunnerAttempt.dispatchState, "dispatched");
      const reconciledRunnerJob = await reconcileGitHubProjectSync({ projectId: runnerCodeProjectId, jobId: preparedCodeRunner.job.id, requestedById: userId }, db);
      assert.equal(reconciledRunnerJob.status, "unknown");
      assert.equal(reconciledRunnerJob.reconciliationRequired, false);
      assert.equal(await db.projectGitHubSyncReconciliation.count({ where: { syncRunId: codeRunnerRoot.id } }), 1);
      const admissionAfterReconcile = await prepareGitHubProjectSync({ projectId: runnerCodeProjectId, requestedById: userId, clientKey: `runner-code-after-${randomUUID()}` }, db);
      assert.equal(admissionAfterReconcile.job.status, "queued");
      const cancelledRunnerJob = await cancelGitHubProjectSync({ projectId: runnerCodeProjectId, jobId: admissionAfterReconcile.job.id, requestedById: userId }, db);
      assert.equal(cancelledRunnerJob.status, "cancelled");

      // A successful root includes two repositories with the same path identity,
      // but each change remains traceable to its frozen target key.
      const successJob = await createJob(db, projectAId, userId, "success");
      const successRoot = await createRoot(db, {
        projectId: projectAId,
        parentJobId: successJob.id,
        label: "success",
        codeTargetCount: 2,
        materialTargetCount: 1,
      });
      const codeBatchA = await createCodeBatch(db, projectAId, "success-code-a", "succeeded");
      const codeBatchA2 = await createCodeBatch(db, projectAId, "success-code-b", "succeeded");
      const materialRunA = await createMaterialRun(db, projectAId, linkA, "success-material", "succeeded");
      const codeEntryA = await createEntry(db, {
        projectId: projectAId,
        syncRunId: successRoot.id,
        link: linkA,
        ordinal: 0,
        targetKind: "code",
        status: "succeeded",
        childCodeBatchId: codeBatchA.id,
      });
      const codeEntryA2 = await createEntry(db, {
        projectId: projectAId,
        syncRunId: successRoot.id,
        link: linkA2,
        ordinal: 1,
        targetKind: "code",
        status: "succeeded",
        childCodeBatchId: codeBatchA2.id,
      });
      const materialEntryA = await createEntry(db, {
        projectId: projectAId,
        syncRunId: successRoot.id,
        link: linkA,
        ordinal: 2,
        targetKind: "material",
        status: "succeeded",
        childMaterialSyncRunId: materialRunA.id,
      });
      const changeA = await createChange(db, {
        projectId: projectAId,
        syncRunId: successRoot.id,
        entryId: codeEntryA.id,
        targetKey: `code:${linkA.id}`,
        identity: "src/shared.ts",
      });
      const changeA2 = await createChange(db, {
        projectId: projectAId,
        syncRunId: successRoot.id,
        entryId: codeEntryA2.id,
        targetKey: `code:${linkA2.id}`,
        identity: "src/shared.ts",
      });
      await db.projectGitHubSyncRun.update({
        where: { id: successRoot.id },
        data: {
          status: "succeeded",
          stage: "terminal",
          manifestFingerprint: hash,
          completedCodeTargetCount: 2,
          completedMaterialTargetCount: 1,
          addedCount: 2,
          completedAt: new Date(),
          startedAt: new Date(Date.now() - 3_000),
        },
      });
      const sealedSuccess = await db.projectGitHubSyncRun.findUniqueOrThrow({ where: { id: successRoot.id } });
      assert.equal(sealedSuccess.status, "succeeded");
      assert.equal(sealedSuccess.completedCodeTargetCount, sealedSuccess.codeTargetCount);
      assert.equal(sealedSuccess.completedMaterialTargetCount, sealedSuccess.materialTargetCount);
      assert.equal(await db.projectGitHubSyncEntry.count({ where: { syncRunId: successRoot.id, status: { in: ["succeeded", "partial", "failed", "unknown", "skipped"] } } }), 3);
      assert.equal(changeA.identity, changeA2.identity);
      assert.notEqual(changeA.targetKey, changeA2.targetKey);

      // A terminal root is immutable for all detail rows and for the root itself.
      const terminalInsert = createEntry(db, {
        projectId: projectAId,
        syncRunId: successRoot.id,
        link: linkA2,
        ordinal: 3,
        targetKind: "material",
        status: "pending",
      });
      await assert.rejects(terminalInsert);
      await assert.rejects(
        db.projectGitHubSyncEntry.update({ where: { id: codeEntryA.id }, data: { warning: "forged" } }),
      );
      await assert.rejects(db.projectGitHubSyncEntry.delete({ where: { id: codeEntryA.id } }));
      await assert.rejects(createChange(db, {
        projectId: projectAId,
        syncRunId: successRoot.id,
        entryId: materialEntryA.id,
        targetKey: `material:${linkA.id}`,
        identity: "new-change",
      }));
      await assert.rejects(
        db.projectGitHubSyncChange.update({ where: { id: changeA.id }, data: { changeType: "updated" } }),
      );
      await assert.rejects(db.projectGitHubSyncChange.delete({ where: { id: changeA.id } }));
      await assert.rejects(db.projectGitHubSyncRun.delete({ where: { id: successRoot.id } }));

      // Running entries and incomplete counts cannot be sealed as a terminal root.
      const mismatchJob = await createJob(db, projectBId, userId, "mismatch");
      const mismatchRoot = await createRoot(db, {
        projectId: projectBId,
        parentJobId: mismatchJob.id,
        label: "mismatch",
        codeTargetCount: 1,
      });
      const runningEntry = await createEntry(db, {
        projectId: projectBId,
        syncRunId: mismatchRoot.id,
        link: linkB,
        ordinal: 0,
        targetKind: "code",
        status: "running",
      });
      await assert.rejects(
        db.projectGitHubSyncRun.update({
          where: { id: mismatchRoot.id },
          data: {
            status: "succeeded",
            stage: "terminal",
            manifestFingerprint: hash,
            completedCodeTargetCount: 1,
            completedAt: new Date(),
            startedAt: new Date(Date.now() - 2_000),
          },
        }),
      );
      await db.projectGitHubSyncEntry.update({
        where: { id: runningEntry.id },
        data: { status: "failed", failureCode: "TEST_FAILED", completedAt: new Date() },
      });
      await assert.rejects(
        db.projectGitHubSyncRun.update({
          where: { id: mismatchRoot.id },
          data: {
            status: "failed",
            stage: "terminal",
            completedCodeTargetCount: 0,
            completedAt: new Date(),
            startedAt: new Date(Date.now() - 2_000),
            failureCode: "TEST_FAILED",
          },
        }),
      );
      await db.projectGitHubSyncRun.delete({ where: { id: mismatchRoot.id } });
      await db.backgroundJob.delete({ where: { id: mismatchJob.id } });

      // A queued/running root is unique per project, and a cross-project composite
      // reference cannot be forged by supplying a valid UUID from another project.
      const activeJob = await createJob(db, projectCId, userId, "active");
      const activeRoot = await createRoot(db, {
        projectId: projectCId,
        parentJobId: activeJob.id,
        label: "active",
      });
      await db.projectGitHubSyncRun.update({
        where: { id: activeRoot.id },
        data: { status: "running", stage: "code", startedAt: new Date(Date.now() - 1_000) },
      });
      const secondActiveJob = await createJob(db, projectCId, userId, "active-second");
      await assert.rejects(createRoot(db, {
        projectId: projectCId,
        parentJobId: secondActiveJob.id,
        label: "active-second",
      }));
      const crossRootId = randomUUID();
      await assert.rejects(
        db.projectGitHubSyncRun.create({
          data: {
            id: crossRootId,
            projectId: projectAId,
            parentJobId: activeJob.id,
            scopeFingerprint: digest("cross-root"),
            deadlineAt: new Date(Date.now() + 240_000),
          },
        }),
      );
      await assert.rejects(createEntry(db, {
        projectId: projectAId,
        syncRunId: activeRoot.id,
        link: linkA,
        ordinal: 99,
        targetKind: "code",
        status: "pending",
      }));
      await assert.rejects(createChange(db, {
        projectId: projectAId,
        syncRunId: activeRoot.id,
        entryId: codeEntryA.id,
        targetKey: `code:${linkA.id}`,
        identity: "cross-change",
      }));
      await db.projectGitHubSyncRun.delete({ where: { id: activeRoot.id } });
      await db.backgroundJob.delete({ where: { id: activeJob.id } });
      await db.backgroundJob.delete({ where: { id: secondActiveJob.id } });

      // An unknown root can be reconciled with unknown children already closed;
      // no provider/GitHub call is made and the old child rows stop blocking admission.
      const unknownJob = await createJob(db, projectAId, userId, "unknown", "running");
      const unknownRoot = await createRoot(db, {
        projectId: projectAId,
        parentJobId: unknownJob.id,
        label: "unknown",
        status: "running",
        codeTargetCount: 1,
        materialTargetCount: 1,
      });
      const unknownCodeBatch = await createCodeBatch(db, projectAId, "unknown-code", "unknown");
      const unknownMaterialRun = await createMaterialRun(db, projectAId, linkA, "unknown-material", "unknown");
      await createEntry(db, {
        projectId: projectAId,
        syncRunId: unknownRoot.id,
        link: linkA,
        ordinal: 0,
        targetKind: "code",
        status: "unknown",
        childCodeBatchId: unknownCodeBatch.id,
      });
      await createEntry(db, {
        projectId: projectAId,
        syncRunId: unknownRoot.id,
        link: linkA,
        ordinal: 1,
        targetKind: "material",
        status: "unknown",
        childMaterialSyncRunId: unknownMaterialRun.id,
      });
      await db.backgroundJobAttempt.create({
        data: {
          id: randomUUID(),
          jobId: unknownJob.id,
          attemptNumber: 1,
          leaseTokenHash: digest("unknown-lease"),
          leasedAt: new Date(Date.now() - 10_000),
          leaseExpiresAt: new Date(Date.now() - 1_000),
          heartbeatAt: new Date(Date.now() - 5_000),
        },
      });
      const providerAuditCount = await db.providerCallAudit.count({ where: { jobId: unknownJob.id } });
      const grantCount = await db.webAiGrant.count({ where: { projectId: projectAId } });
      const reconciledJob = await reconcileGitHubProjectSync(
        { projectId: projectAId, jobId: unknownJob.id, requestedById: userId },
        db,
      );
      assert.equal(reconciledJob.status, "unknown");
      assert.equal(reconciledJob.reconciliationRequired, false);
      assert.equal(await db.providerCallAudit.count({ where: { jobId: unknownJob.id } }), providerAuditCount);
      assert.equal(await db.webAiGrant.count({ where: { projectId: projectAId } }), grantCount);
      const reconciledRoot = await db.projectGitHubSyncRun.findUniqueOrThrow({ where: { id: unknownRoot.id } });
      assert.equal(reconciledRoot.status, "unknown");
      assert.equal(reconciledRoot.manifestFingerprint, null);
      assert.equal(reconciledRoot.reconciliationRequired, true);
      assert.equal(await db.projectGitHubSyncReconciliation.count({ where: { syncRunId: unknownRoot.id } }), 1);
      const replay = await reconcileGitHubProjectSync(
        { projectId: projectAId, jobId: unknownJob.id, requestedById: userId },
        db,
      );
      assert.equal(replay.id, reconciledJob.id);
      assert.equal(await db.projectGitHubSyncReconciliation.count({ where: { syncRunId: unknownRoot.id } }), 1);
      assert.equal(await hasBlockingUnknownProjectSyncRun(db, projectAId), false);
      assert.equal(await hasBlockingUnknownProjectCodeBatch(db, projectAId), false);
      assert.equal(await hasBlockingUnknownProjectMaterialRun(db, projectAId), false);
      const preparedAfterReconcile = await prepareGitHubProjectSync(
        { projectId: projectAId, requestedById: userId, clientKey: `after-reconcile-${randomUUID()}` },
        db,
      );
      assert.equal(preparedAfterReconcile.job.status, "queued");

      // Skipped targets have no comparable after-state and therefore produce no
      // fabricated deleted/withheld change rows. This project is deleted below.
      const cascadeJob = await createJob(db, projectBId, userId, "cascade");
      const cascadeRoot = await createRoot(db, {
        projectId: projectBId,
        parentJobId: cascadeJob.id,
        label: "cascade",
        codeTargetCount: 1,
      });
      await createEntry(db, {
        projectId: projectBId,
        syncRunId: cascadeRoot.id,
        link: linkB,
        ordinal: 0,
        targetKind: "code",
        status: "skipped",
      });
      await db.projectGitHubSyncRun.update({
        where: { id: cascadeRoot.id },
        data: {
          status: "unknown",
          stage: "terminal",
          completedCodeTargetCount: 1,
          completedAt: new Date(),
          failureCode: "GITHUB_REQUEST_TIMEOUT",
          reconciliationRequired: true,
        },
      });
      await db.projectGitHubSyncReconciliation.create({
        data: {
          id: randomUUID(),
          projectId: projectBId,
          syncRunId: cascadeRoot.id,
          requestedById: userId,
          resolution: "explicitAbandon",
          childClassifications: [{ targetKind: "code", status: "skipped" }],
          evidenceFingerprint: digest("cascade-reconciliation"),
        },
      });
      assert.equal(await db.projectGitHubSyncChange.count({ where: { syncRunId: cascadeRoot.id } }), 0);

      await assert.doesNotReject(() => db.project.delete({ where: { id: projectBId } }));
      assert.equal(await db.projectGitHubSyncRun.count({ where: { projectId: projectBId } }), 0);
      assert.equal(await db.projectGitHubSyncEntry.count({ where: { projectId: projectBId } }), 0);
      assert.equal(await db.projectGitHubSyncChange.count({ where: { projectId: projectBId } }), 0);
      assert.equal(await db.projectGitHubSyncReconciliation.count({ where: { projectId: projectBId } }), 0);

      // Project A is the terminal immutability fixture and remains for disposable
      // schema teardown. Project C has no child rows after the active-root checks.
      await assert.doesNotReject(() => db.project.delete({ where: { id: projectCId } }));
    } finally {
      await db.$disconnect();
      await raw.end();
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
    }
  },
);
